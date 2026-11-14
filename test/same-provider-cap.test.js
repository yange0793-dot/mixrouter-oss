'use strict';
// 同渠道连续尝试上限(lib/proxy/attempts.js)。
//
// 背景:候选表按 MAX_ATTEMPTS 循环填满,单渠道时同一个上游占据每一个下标。交接线
// plist 里 MIXR_MAX_ATTEMPTS=50、MIXR_MAX_UPSTREAM_CALLS=50,一次 5xx 就会把同一包
// body 重投 50 次(10MB 请求 ≈ 500MB 出口,116 条请求 p50 309 秒)。这里钉的是调度层
// 的**次数**行为,不发网络:
//   · 默认 8 次后停止重投,按既有 too_many_attempts 终态,原因写进 err/err_class;
//   · 池里还有别的渠道时跳到下一个不同渠道,而不是继续重投同一家;
//   · MIXR_SAME_PROVIDER_ATTEMPTS 可覆盖(0 = 不限,坏值回落默认);
//   · 固定 Key(pinTo 截断候选表)立即终态,不"跳过";
//   · 只有**真的打出去**的调用计数 —— 本地预检拒绝、候选跳过不占这个额度。

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createAttemptRunner } = require('../lib/proxy/attempts');

const MEMBER = (id, model = 'fixture-model') => ({ provider: { id, name: `${id}-name` }, model });
const SOLO = count => Array.from({ length: count }, () => MEMBER('solo'));

function fakeCtx({ maxUpstreamCalls = 50 } = {}) {
  return {
    entry: { status: 0, err: '', err_class: '', ms: 0 },
    started: Date.now(), deadlineMs: 0, deadlineAt: Date.now() + 60000,
    maxUpstreamCalls, capWhy: `已达本次请求的上游调用上限(${maxUpstreamCalls} 次)`,
    netAttempts: 0, deadlineHit: false, finalized: false, clientClosed: false,
    finished: 0, sent: [],
    finish() { this.finalized = true; this.finished++; },
    sendErr(...args) { this.sent.push(args); },
  };
}

function runnerFor(runAttempt) {
  return createAttemptRunner({ runAttempt, convRetries: 3, retryDelayMs: 0 });
}

afterEach(() => { delete process.env.MIXR_SAME_PROVIDER_ATTEMPTS; });

// 每一发都算一次真实上游调用(与 attempt.js 的 bumpNetAttempts + noteAttempt 同序),
// 然后原地下标重试 —— 这就是单渠道 5xx 的真实调度形状。
function alwaysRetry(hits) {
  return (loop, plan, ctx, i) => {
    hits.push(plan.ordered[i].provider.id);
    ctx.netAttempts++;
    loop.noteAttempt(i);
    return loop.retry(i);
  };
}

test('单渠道 5xx:默认 8 次就停,按 too_many_attempts 终态并写明同渠道上限', () => {
  const ctx = fakeCtx();
  const hits = [];
  runnerFor(alwaysRetry(hits)).runAttempts({ ordered: SOLO(50), sessionKey: 'cc:cap' }, ctx);

  assert.equal(hits.length, 8, '默认上限 8:不能把同一包 body 重投到 50 次');
  assert.equal(ctx.netAttempts, 8);
  assert.equal(ctx.finished, 1, '终态只结算一次');
  assert.equal(ctx.entry.status, 502);
  assert.equal(ctx.entry.err_class, 'too_many_attempts');
  assert.match(ctx.entry.err, /同一渠道连续尝试已达上限\(8 次/);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0][0], 502);
  assert.equal(ctx.sent[0][3], 'too_many_attempts');
});

test('池里还有别的渠道:到上限后跳到下一个不同渠道,不继续重投同一家', () => {
  const ctx = fakeCtx();
  const hits = [];
  const ordered = SOLO(50);
  ordered[20] = MEMBER('other');
  const runAttempt = (loop, plan, c, i) => {
    hits.push(plan.ordered[i].provider.id);
    c.netAttempts++;
    loop.noteAttempt(i);
    // 备渠道正常给出结果:调度层不该再继续换
    if (plan.ordered[i].provider.id === 'other') return c.finish();
    return loop.retry(i);
  };
  runnerFor(runAttempt).runAttempts({ ordered, sessionKey: 'cc:cap' }, ctx);

  assert.deepEqual(hits, [...Array(8).fill('solo'), 'other']);
  assert.equal(ctx.finished, 1);
  assert.equal(ctx.entry.err, '', '换到别家成功就不是终态错误');
  assert.equal(ctx.entry.failover, true, '跳渠道要记成故障转移');
});

test('MIXR_SAME_PROVIDER_ATTEMPTS 覆盖默认上限;0 表示不限(回到总预算闸门)', () => {
  const hits = [];
  process.env.MIXR_SAME_PROVIDER_ATTEMPTS = '3';
  let ctx = fakeCtx();
  runnerFor(alwaysRetry(hits)).runAttempts({ ordered: SOLO(50), sessionKey: 'cc:cap' }, ctx);
  assert.equal(hits.length, 3);
  assert.equal(ctx.entry.err_class, 'too_many_attempts');

  hits.length = 0;
  process.env.MIXR_SAME_PROVIDER_ATTEMPTS = '0';
  ctx = fakeCtx({ maxUpstreamCalls: 12 });
  runnerFor(alwaysRetry(hits)).runAttempts({ ordered: SOLO(50), sessionKey: 'cc:cap' }, ctx);
  assert.equal(hits.length, 12, '0 = 不限,只剩请求级总预算');
  assert.equal(ctx.entry.err_class, 'too_many_attempts');
  assert.match(ctx.entry.err, /上游调用上限/, '终态原因回到总预算那句话');

  hits.length = 0;
  process.env.MIXR_SAME_PROVIDER_ATTEMPTS = 'not-a-number';
  ctx = fakeCtx();
  runnerFor(alwaysRetry(hits)).runAttempts({ ordered: SOLO(50), sessionKey: 'cc:cap' }, ctx);
  assert.equal(hits.length, 8, '坏值回落默认 8');
});

test('固定 Key 截断候选表后:到上限立即终态,不试图跳过渠道', () => {
  const ctx = fakeCtx();
  const hits = [];
  process.env.MIXR_SAME_PROVIDER_ATTEMPTS = '2';
  const runAttempt = (loop, plan, c, i) => {
    hits.push(i);
    c.netAttempts++;
    loop.noteAttempt(i);
    loop.pinTo(i); // 用户明确钉死的账号:本请求不再换渠道
    return loop.retry(i);
  };
  runnerFor(runAttempt).runAttempts({ ordered: SOLO(20), sessionKey: 'cc:cap' }, ctx);

  assert.equal(hits.length, 2, '固定账号仍有界重试,但到上限就收');
  assert.equal(ctx.entry.err_class, 'too_many_attempts');
  assert.match(ctx.entry.err, /同一渠道连续尝试已达上限/);
});

test('上游 2xx 里包失败帧时,合成的上限终态不能沿用 200', () => {
  const ctx = fakeCtx();
  process.env.MIXR_SAME_PROVIDER_ATTEMPTS = '2';
  const runAttempt = (loop, plan, c, i) => {
    c.netAttempts++;
    loop.noteAttempt(i);
    c.entry.status = 200; // 原生 Responses 的 failed 帧以 HTTP 200 到达
    return loop.retry(i);
  };
  runnerFor(runAttempt).runAttempts({ ordered: SOLO(20), sessionKey: 'cc:cap' }, ctx);
  assert.equal(ctx.netAttempts, 2);
  assert.equal(ctx.entry.status, 502, '错误体不能挂在 200 下面');
  assert.equal(ctx.sent[0][0], 502);
  assert.equal(ctx.entry.err_class, 'too_many_attempts');
});

test('只有真正打出去的调用计数:本地预检拒绝的候选不占同渠道额度', () => {
  const ctx = fakeCtx();
  const hits = [];
  let prechecked = false;
  const runAttempt = (loop, plan, c, i) => {
    // 第一次是本地预检拒绝(一个字节都没发),调度层不能把它算成一次重投
    if (!prechecked) { prechecked = true; return loop.retry(1); }
    hits.push(plan.ordered[i].provider.id);
    c.netAttempts++;
    loop.noteAttempt(i);
    return loop.retry(i);
  };
  runnerFor(runAttempt).runAttempts({ ordered: SOLO(50), sessionKey: 'cc:cap' }, ctx);

  assert.equal(hits.length, 8, '真实调用仍然是 8 次,不会被一次没发出去的预检吃掉额度');
  assert.equal(ctx.netAttempts, 8);
});
