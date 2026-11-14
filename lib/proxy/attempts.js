'use strict';
// attempt 调度:请求级预算、候选游标与「要不要再来一次」的决定**只在这里**。
//
// 与 lib/proxy/attempt.js 的分工(规划 2.2 的边界表):
//   · 本模块持有的是**跨尝试**的东西:还允许打几次上游、总预算是否用尽、同渠道重试的
//     配额(convRetries 是整条请求共用一个计数器)、候选游标 i、以及两次尝试之间的间隔。
//   · 单次尝试自己的 HTTP 句柄与定时器全归 attempt.js —— 本模块不碰它们。
// 两者是互相递归的(一次尝试结束时要么收尾、要么回到这里再挑一次),连接点是 loop 句柄:
// attempt.js 只通过 loop.retry(i) / loop.pinTo(i) / loop.useConvRetry() 回到调度层。
//
// 已发出的有效客户端响应字节会关闭透明重试窗口 —— 这个判断不在这里,而在响应分派那一侧
// (commit 之后它不再调 loop.retry)。
//
// 同渠道连续尝试上限也在这里:候选表按 MAX_ATTEMPTS 循环填满,单渠道时同一上游会出现在
// 每一个下标上,失败转移于是变成"把整包 body 重投几十次"(plist 里 MIXR_MAX_UPSTREAM_CALLS=50
// 时,10MB 请求 ≈ 500MB 出口,116 条请求 p50 309 秒)。这里按 `${provider.id}|${model}` 数**真的
// 打出去**的连续调用,到达上限后跳到下一个不同渠道;没有别的渠道就按既有 too_many_attempts
// 终态。这是单条请求内的次数限制,不是跨请求冷却/熔断。

// 同一渠道连续尝试上限。默认 8;MIXR_SAME_PROVIDER_ATTEMPTS=0 表示不限,坏值回落默认。
// 不放进 runtime 配置:它只影响本调度层,而且需要按请求现读(测试/排障改 env 即生效)。
const DEFAULT_SAME_PROVIDER_ATTEMPTS = 8;
function sameProviderAttemptsLimit(env = process.env) {
  const raw = env.MIXR_SAME_PROVIDER_ATTEMPTS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_SAME_PROVIDER_ATTEMPTS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_SAME_PROVIDER_ATTEMPTS;
}

function createAttemptRunner(deps) {
  const { runAttempt, convRetries, retryDelayMs = 0 } = deps;

  // plan/ctx 由请求上下文与 prepare 给出;这里不改它们,只决定下一个 i。
  function runAttempts(plan, ctx) {
    const ordered = plan.ordered;
    // 调度层只**旁路**记阶段:ctx 可能来自单测/裁剪部署(没有 recordAttemptEvent),
    // 记不进去也不能影响调度 —— 诊断设施不许有能力改变重试语义。
    const note = event => { try { if (typeof ctx.recordAttemptEvent === 'function') ctx.recordAttemptEvent(event); } catch {} };
    // 同渠道连续尝试的计数。只由 loop.noteAttempt() 更新 —— 那一次调用发生在 attempt.js
    // **真正把 body 交给上游**的那一刻(netAttempts++ 旁边),所以本地预检拒绝、候选跳过
    // 都不会被算成对同一个渠道的又一次重投。key 带模型:同一渠道换模型是另一个落点。
    const sameProviderLimit = sameProviderAttemptsLimit();
    let sameProviderKey = '', sameProviderCount = 0;
    const providerKeyOf = member => member && member.provider
      ? `${member.provider.id || ''}|${member.model || plan.modelIn || ''}` : '';
    const loop = {
      ordered,
      noteAttempt(i) {
        const key = providerKeyOf(ordered[i]);
        if (!key) return;
        if (key === sameProviderKey) sameProviderCount++;
        else { sameProviderKey = key; sameProviderCount = 1; }
      },
      // 限流(429)不是"渠道坏了"的证据:把它排除在同渠道硬失败上限之外,
      // 否则既定策略"限流只能重试"会被这条上限提前掐断。调用方在决定重试 429 时清零。
      resetSameProvider() { sameProviderKey = ''; sameProviderCount = 0; },
      // 换 key 重试的配额(整条请求共用)。attempt.js 读 convRetriesLeft 决定还能不能
      // 原地重打;useConvRetry() 由它自己在真要重打时调用一次。
      convRetries: 0,
      get convRetriesLeft() { return Math.max(0, convRetries - this.convRetries); },
      useConvRetry() { this.convRetries++; },
      // 原生 Responses 的明确空失败也用既有配额,不新开重试预算。配额用完只取后续
      // 同渠道同模型候选,不因为一个 200 错误帧擅自把主槽挪到其它供应商。
      retrySame(i, beforeRetry) {
        if (ctx.finalized || ctx.clientClosed || ctx.deadlineHit || ctx.netAttempts >= ctx.maxUpstreamCalls) return false;
        const same = this.convRetriesLeft > 0;
        const next = same ? i : ordered.findIndex((member, at) => at > i
          && member.provider.id === ordered[i].provider.id && member.model === ordered[i].model);
        if (next < 0) return false;
        // 走到这里说明上游**答了**,只是答了一个空/失败帧(200 里的原生限流或断流)。
        // 它属于"再打一次"的语义,不是渠道硬故障;不计入同渠道硬失败上限,
        // 也就不会改变既有的 50 次预算与 native rate-limit 的重试行为。
        this.resetSameProvider();
        if (same) this.useConvRetry();
        beforeRetry();
        this.retry(next);
        return true;
      },
      // 固定 Key 一旦被选中,本请求不再尝试别的渠道/账号(与旧实现同义:直接截断候选表)
      pinTo(i) { ordered.length = i + 1; },
      // 同渠道重试(换 key / 换 cache 代际 / 带图改写重打)与失败转移都回到这里,
      // 换渠道、同渠道、转换线重试一样,都要先等一个 retryDelayMs。
      // 渠道与 Key 没有时间冷却,也没有 Retry-After 驱动的等待,所以这里是唯一的重试间隔来源。
      retryDelayMs,
      retry(i) {
        // 客户端已经走了、或预算已经用完:再等一秒才发现这件事只是白占一个定时器
        if (ctx.finalized || ctx.clientClosed || ctx.deadlineHit) return;
        const remaining = ctx.deadlineAt - Date.now();
        const wait = retryDelayMs > 0 ? retryDelayMs : 0;
        // "正在等下一次尝试"也是真实阶段:页面必须分得清"卡在上游"与"按退避在等"。
        // 间隔为 0(测试/排障开关)也记一条,wait_ms=0,不假装有等待。
        note({ phase: 'retry_wait', attempt: ctx.netAttempts, wait_ms: wait });
        // 间隔设成 0 是测试与排障用的关闭开关,那就不必经过定时器
        if (wait <= 0) return tryCandidate(i);
        // 秒级 ECONNRESET 往往几十毫秒内就自愈,立刻重打只会连撞同一个故障窗口。
        // 定时器 unref:它不该成为"进程还不能退出去"的理由。
        const retryAt = Date.now() + wait;
        const wake = () => {
          if (ctx.finalized || ctx.clientClosed || ctx.deadlineHit) return;
          const wakeAt = ctx.deadlineAt > 0 ? Math.min(retryAt, ctx.deadlineAt) : retryAt;
          const left = wakeAt - Date.now();
          // Node 的毫秒定时器可能提前唤醒;还没到重试时间或总预算边界就继续等。
          if (left > 0) return schedule(left);
          return tryCandidate(i);
        };
        const schedule = delay => {
          const timer = setTimeout(wake, delay);
          if (timer.unref) timer.unref();
        };
        schedule(Number.isFinite(remaining) ? Math.min(wait, Math.max(0, remaining)) : wait);
      },
    };

    function tryCandidate(index) {
      // 排队等间隔期间请求可能已经收尾(客户端断开/总预算耗尽),这时一个字节都不要再发
      if (ctx.finalized || ctx.clientClosed || ctx.deadlineHit) return;
      let i = index;
      const member = ordered[i];
      // 同渠道连续尝试到达上限:换到下一个**不同渠道**的候选。候选表按 MAX_ATTEMPTS 循环
      // 填满,单渠道时"下一个"还是它自己,不在这里截住就会把同一包 body 重投到总上限。
      // 固定 Key(pinTo 已截断候选表)与池里没有别的渠道时没有可换的落点,直接终态 ——
      // 固定等于用户明确钉死,换渠道补偿不了他,只能把真实原因交回去。
      if (member && sameProviderLimit > 0 && sameProviderCount >= sameProviderLimit
          && providerKeyOf(member) === sameProviderKey) {
        const currentId = member.provider && member.provider.id;
        let next = -1;
        for (let at = i + 1; at < ordered.length; at++) {
          const candidate = ordered[at];
          if (candidate && candidate.provider && candidate.provider.id !== currentId) { next = at; break; }
        }
        if (next < 0) return failSameProviderCap(member);
        note({ phase: 'error', attempt: ctx.netAttempts, provider_id: currentId || '',
          model: member.model || '', status: 0, code: 'same_provider_cap' });
        if (ctx.entry) ctx.entry.failover = true;
        i = next;
      }
      // 总调用上限:候选渠道用尽后还有同渠道重试,两条路径都归这一个闸门管
      if (ctx.netAttempts >= ctx.maxUpstreamCalls) {
        const last = ordered[Math.min(i, ordered.length - 1)] || {};
        console.log(`[attempt-cap] ${ctx.capWhy}(provider ${(last.provider && last.provider.name) || '?'}, session ${plan.sessionKey})`);
        ctx.entry.ms = Date.now() - ctx.started;
        ctx.entry.err = ctx.entry.err || ctx.capWhy;
        ctx.entry.err_class = ctx.entry.err_class || 'too_many_attempts';
        ctx.entry.status = ctx.entry.status || 502;
        // 终态原因也进阶段流水:否则页面只看到"最近一发失败",说不出"是调用次数用尽"
        note({ phase: 'error', attempt: ctx.netAttempts,
          provider_id: (last.provider && last.provider.id) || '', model: last.model || '',
          status: ctx.entry.status, code: 'too_many_attempts' });
        ctx.finish();
        return ctx.sendErr(ctx.entry.status, 'api_error', `上游请求失败: ${ctx.capWhy}`, 'too_many_attempts');
      }
      // 尝试之间的等待也消耗同一份预算;旧尝试定时器已经拆掉,在这里接住到期,
      // 不允许先发一条新请求再靠它的 1ms 看门狗收尾。
      if (ctx.netAttempts > 0 && ctx.deadlineAt > 0 && ctx.deadlineAt <= Date.now()) {
        if (typeof ctx.markDeadlineHit === 'function') ctx.markDeadlineHit();
        ctx.entry.status = 504;
        ctx.entry.err = '超出端到端总预算'; ctx.entry.err_class = 'timeout';
        ctx.entry.ms = Date.now() - ctx.started;
        note({ phase: 'error', attempt: ctx.netAttempts, status: 504, code: 'timeout' });
        ctx.finish();
        return ctx.sendErr(504, 'api_error', ctx.entry.err, 'timeout');
      }
      return runAttempt(loop, plan, ctx, i);
    }

    // 同渠道上限用尽而没有别的渠道可换:沿用请求级调用上限的 too_many_attempts 终态,
    // 但把**真实原因**写进 err/err_class —— 否则日志只剩最后一次上游错误,看不出这是
    // 我们主动停止重投(与调用总预算用尽是两回事)。
    function failSameProviderCap(member) {
      const provider = (member && member.provider) || {};
      const why = `同一渠道连续尝试已达上限(${sameProviderLimit} 次,渠道 ${provider.name || provider.id || '?'})`;
      console.log(`[same-provider-cap] ${why}(session ${plan.sessionKey})`);
      ctx.entry.ms = Date.now() - ctx.started;
      ctx.entry.err = why;
      ctx.entry.err_class = 'too_many_attempts';
      // 这是一条我们自己合成的终态,上游的 2xx 不能拿来当它的状态码(那会变成
      // "HTTP 200 包着一条错误体",客户端会当成空响应而不是失败)。
      ctx.entry.status = ctx.entry.status >= 400 ? ctx.entry.status : 502;
      note({ phase: 'error', attempt: ctx.netAttempts, provider_id: provider.id || '',
        model: (member && member.model) || '', status: ctx.entry.status, code: 'too_many_attempts' });
      ctx.finish();
      return ctx.sendErr(ctx.entry.status, 'api_error', `上游请求失败: ${why}`, 'too_many_attempts');
    }

    tryCandidate(0);
  }

  return { runAttempts };
}

module.exports = { createAttemptRunner };
