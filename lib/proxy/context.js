'use strict';
// 请求级上下文:一次请求的时间戳与预算、真实上游调用计数、当前取消器,以及**唯一终态**。
//
// 等价搬自 mixrouter.js 的 proxyHandler(四期重构的第二期:代理边界拆分;内部规划记录不随
// 仓库发布)。它只回答两件事 ——
// 「这条请求还剩多少预算」「这次尝试的收尾落在哪儿」—— 并保证终态只结算一次。
//
// 状态所有权(规划 2.2 的约束,这里是逐条兑现):
//   1. 只有本上下文持有客户端取消器、上游句柄与请求级 deadline;
//   2. 只有本上下文写最终日志、累加会话用量(经注入的 onFinish 窄接口);
//   3. 下一次尝试由 lib/proxy/attempts.js 决定 —— 它**读**这里的状态,不在这里改游标;
//   4. 本次尝试自己的健康许可与看门狗计时器归 lib/proxy/attempt.js,本上下文只提供
//      "请求级收尾要把它们拆掉"的那个出口(clearAttemptTimers),不替 attempt 决定何时释放许可。
//
// 这**不是**可以任意修改全部路由配置的"万能 context":没有候选、没有 Key、没有会话记录、
// 没有槽表。它拿到的是 entry(一条日志条目)、res(客户端响应)与几个注入的窄接口。

function createRequestContext(deps) {
  const {
    res, entry, started, rawLen, archiveRequestId,
    totalDeadlineMs, maxAttempts, convRetries, sseKeepAliveMs,
    protoError, app,
    // 终态的唯一副作用出口:会话计数/用量累加 + 请求日志落盘。两件事都在调用方那一侧,
    // 本模块只保证"调用一次"(会话语义不在这里,也不由这里决定)。
    onFinish,
  } = deps;

  // 端到端总预算:从客户端请求到达起算,**流式也一样管**。以前流式只有"字节间空闲"
  // 一条约束,慢慢滴的流能一直拖着;而客户端 300s 早就放弃了,我们还在替一条没人接收的
  // 响应占着上游连接和渠道额度。这里是整个预算的最外层。
  // 预算随请求体放大:大上下文压缩请求上游实测 224~286s 才跑完,固定 240s 掐断时上游
  // 照样计费(渠道面板实测每发 $0.94~0.99),等于白烧。按体积≈每 token 放 2ms、封顶
  // 再加 10 分钟;客户端真断开由 res.on('close') 立刻掐,放宽不会替没人接收的请求烧额度。
  // 在这里算好绝对时刻:等响应头的那一段也要被它夹住(见 attempt 的首字节硬定时器)
  const deadlineMs = totalDeadlineMs + Math.min(600000, Math.ceil(rawLen / 4) * 2);
  const deadlineAt = started + deadlineMs;

  // 一次请求最多允许几次上游调用。上界是实测出来的,不是两个旋钮相乘:
  //   候选渠道最多试 MAX_ATTEMPTS 个;换 key 重试的 convRetries 是**整条请求共用一个**
  //   计数器(不是每渠道一个),所以总共再加 CONV_RETRIES 次;带图被拒的改写重打是一次性的
  //   (relayInstead 改写后立刻清零,不会套娃),再加 1。
  //   实测(3 个候选、全 500):MA=3/CR=3 → 6 次 = MA+CR;MA=1/CR=3 → 4 次;带图再 +1。
  // 用乘法当上界是错的:MA=3/CR=3 会算出 12,既是虚高(真实最多 6),又会在 CR=0 时
  // 把带图那次合法的改写重打拦掉(实测 MA=3/CR=0/带图被这个闸门误杀)。
  const maxUpstreamCalls = Math.max(1, maxAttempts) + Math.max(0, convRetries);
  const capWhy = `已达本次请求的上游调用上限(${maxUpstreamCalls} 次:候选渠道最多 ${Math.max(1, maxAttempts)} + 换 key 重试 ${Math.max(0, convRetries)})`;

  let finalized = false;
  // 已提交的 SSE 响应定期补一行注释:客户端按"多久没收到字节"判本地超时,上游慢慢推理时
  // 这条通道会一直沉默,补一行它就知道连接还活着(注释行是标准 SSE,客户端会跳过)。
  // **只在响应真的提交给客户端之后才启动**——提交前写哪怕一个字节,都会毁掉"一个字节都没写给
  // 客户端就整条重试"的前提。所以这里不做轮询判断(getHeader 在响应头发出后就取不到了),
  // 而是在每个提交点上显式 startKeepAlive()。
  let keepAliveTimer = null;
  const stopKeepAlive = () => { if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; } };
  const startKeepAlive = () => {
    if (!sseKeepAliveMs || keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
      if (finalized || res.writableEnded || res.destroyed) return stopKeepAlive();
      try { res.write(': keep-alive\n\n'); } catch { stopKeepAlive(); }
    }, sseKeepAliveMs);
    if (keepAliveTimer.unref) keepAliveTimer.unref(); // 兜底计时器不该成为进程退不出去的理由
  };

  // 客户端断开(ESC 取消/进程退出):掐掉在途的上游请求并按取消收尾——
  // 不烧已无人接收的渠道额度,也不把客户端取消算成渠道失败;正常完成后 finalized 已置位,这里自然短路
  let clientClosed = false, activeReq = null, activeRes = null, releaseCurrent = null;
  // 端到端总预算已经用尽:后面的重试/换渠道都不许再打上游,收尾按 timeout 记
  let deadlineHit = false;
  // 当前这一次尝试的看门狗计时器。放弃本次尝试去重试时必须先清掉,否则它会在 240s 之后
  // 对一条早已收尾的请求开火,把好端端的成功条目改写成 timeout(还会钉住事件循环)。
  let activeTimers = null;
  // 真正打出去的 HTTP 请求数。以前日志记的是"第几个候选渠道"(i+1),同渠道内的换 key
  // 重试(以及带图改写重打)不计数,于是 MIXR_MAX_ATTEMPTS=1 + MIXR_CONV_RETRIES=3
  // 实际发了 4 次请求、日志却写 attempts=1——审计时按日志算不出真实调用量
  let netAttempts = 0;

  const clearAttemptTimers = () => {
    if (!activeTimers) return;
    clearTimeout(activeTimers.bodyTimer); clearTimeout(activeTimers.deadlineTimer);
    activeTimers = null;
  };

  // 单次请求的收尾:计数入会话、写日志、收响应(所有终止路径都走这里,避免漏记)
  const finish = () => {
    if (finalized) return;
    finalized = true;
    stopKeepAlive();
    onFinish(entry);
  };
  const sendErr = (status, type, message, errClass) => {
    entry.status = status;
    if (errClass) entry.err_class = errClass;
    if (!res.headersSent) protoError(res, app, status, type, message);
    else { try { res.end(); } catch {} }
  };

  const ctx = {
    res, entry, app,
    started, deadlineMs, deadlineAt, rawLen, archiveRequestId,
    maxUpstreamCalls, capWhy,
    get finalized() { return finalized; },
    get clientClosed() { return clientClosed; },
    get deadlineHit() { return deadlineHit; },
    get netAttempts() { return netAttempts; },
    markDeadlineHit() { deadlineHit = true; },
    bumpNetAttempts() { netAttempts++; return netAttempts; },
    clearAttemptTimers,
    setActiveTimers(timers) { activeTimers = timers; },
    setActiveRequest(creq) { activeReq = creq; },
    setActiveResponse(cres) { activeRes = cres; },
    setRelease(fn) { releaseCurrent = fn; },
    startKeepAlive, stopKeepAlive,
    finish, sendErr,
  };

  res.on('close', () => {
    // writableFinished=响应已正常写完,只是 close 事件走 nextTick 先到了(它比 promise
    // 微任务还早)。这里若不放行,每条转换流的成功都会被记成 499 client closed + usage 0
    if (finalized || res.writableFinished) return;
    clientClosed = true;
    clearAttemptTimers();
    if (releaseCurrent) releaseCurrent('cancelled');
    try { if (activeReq) activeReq.destroy(); } catch {}
    try { if (activeRes) activeRes.destroy(); } catch {}
    entry.status = entry.status || 499;
    entry.err = entry.err || 'client closed';
    entry.err_class = 'cancelled';
    entry.ms = Date.now() - started;
    finish();
  });

  return ctx;
}

module.exports = { createRequestContext };
