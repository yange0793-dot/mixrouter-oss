'use strict';
// attempt 调度:请求级预算、候选游标与「要不要再来一次」的决定**只在这里**。
//
// 与 lib/proxy/attempt.js 的分工(规划 2.2 的边界表):
//   · 本模块持有的是**跨尝试**的东西:还允许打几次上游、总预算是否用尽、同渠道重试的
//     配额(convRetries 是整条请求共用一个计数器)、候选游标 i。
//   · 单次尝试自己的 HTTP 句柄、健康许可与定时器全归 attempt.js —— 本模块不碰它们,
//     也不替它决定何时释放许可。
// 两者是互相递归的(一次尝试结束时要么收尾、要么回到这里再挑一次),连接点是 loop 句柄:
// attempt.js 只通过 loop.retry(i) / loop.pinTo(i) / loop.useConvRetry() 回到调度层。
//
// 已发出的有效客户端响应字节会关闭透明重试窗口 —— 这个判断不在这里,而在响应分派那一侧
// (commit 之后它不再调 loop.retry)。

function createAttemptRunner(deps) {
  const { runAttempt, convRetries } = deps;

  // plan/ctx 由请求上下文与 prepare 给出;这里不改它们,只决定下一个 i。
  function runAttempts(plan, ctx) {
    const ordered = plan.ordered;
    const loop = {
      ordered,
      // 换 key 重试的配额(整条请求共用)。attempt.js 读 convRetriesLeft 决定还能不能
      // 原地重打;useConvRetry() 由它自己在真要重打时调用一次。
      convRetries: 0,
      get convRetriesLeft() { return Math.max(0, convRetries - this.convRetries); },
      useConvRetry() { this.convRetries++; },
      // 固定 Key 一旦被选中,本请求不再尝试别的渠道/账号(与旧实现同义:直接截断候选表)
      pinTo(i) { ordered.length = i + 1; },
      // 同渠道重试(换 key / 换 cache 代际 / 带图改写重打)与失败转移都回到这里,
      // 重新走一遍闸门 —— 包括重新申请健康许可(那是 attempt.js 的事)
      retry(i) { tryCandidate(i); },
    };

    function tryCandidate(i) {
      // 端到端总预算已经用尽(客户端那条响应早已收尾):再打上游只是替没人要的请求烧额度
      if (ctx.deadlineHit) return;
      // 总调用上限:候选渠道用尽后还有同渠道重试,两条路径都归这一个闸门管
      if (ctx.netAttempts >= ctx.maxUpstreamCalls) {
        const last = ordered[Math.min(i, ordered.length - 1)] || {};
        console.log(`[attempt-cap] ${ctx.capWhy}(provider ${(last.provider && last.provider.name) || '?'}, session ${plan.sessionKey})`);
        ctx.entry.ms = Date.now() - ctx.started;
        ctx.entry.err = ctx.entry.err || ctx.capWhy;
        ctx.entry.err_class = ctx.entry.err_class || 'too_many_attempts';
        ctx.entry.status = ctx.entry.status || 502;
        ctx.finish();
        return ctx.sendErr(ctx.entry.status, 'api_error', `上游请求失败: ${ctx.capWhy}`, 'too_many_attempts');
      }
      return runAttempt(loop, plan, ctx, i);
    }

    tryCandidate(0);
  }

  return { runAttempts };
}

module.exports = { createAttemptRunner };
