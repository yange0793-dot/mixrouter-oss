'use strict';
// 第二期「代理编排拆分」的边界回归(规划 2.2 / 5.2.1)。
//
// 这个文件锁三件既有用例覆盖不到的事:
//   1. **依赖方向**:拆分出来的模块不得反过来 require 主入口,也不得再建第二套 resolver
//      或万能 context(规划 7.3「不为文件数和行数拆模块」)。
//   2. **请求上下文的唯一终态**:finish 幂等、真实调用计数、取消中性释放;这些都是
//      "拆分之后仍然只有一处结算"的直接证据,原有入口用例只看得到最终日志。
//   3. **attempt 调度的闸门**:总调用上限与端到端预算都在调度层,且**不再调用 runAttempt**;
//      重试配额(convRetries 整条请求共用一个)与固定 Key 截断候选表也在这里。
//
// 全部用注入的假依赖,不起服务、不发网络、不读配置文件。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SPLIT_FILES = [
  'lib/http/proxy.js',
  'lib/proxy/prepare.js',
  'lib/proxy/context.js',
  'lib/proxy/attempts.js',
  'lib/proxy/attempt.js',
  'lib/proxy/response.js',
];
const FACTORIES = {
  'lib/http/proxy.js': 'createProxyHandler',
  'lib/proxy/prepare.js': 'createPreparer',
  'lib/proxy/context.js': 'createRequestContext',
  'lib/proxy/attempts.js': 'createAttemptRunner',
  'lib/proxy/attempt.js': 'createAttempt',
  'lib/proxy/response.js': 'createResponder',
};

test('拆分模块存在、导出工厂,且不反向依赖主入口', () => {
  for (const rel of SPLIT_FILES) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `${rel} 应当存在`);
    const loaded = require(file);
    assert.equal(typeof loaded[FACTORIES[rel]], 'function', `${rel} 应当导出 ${FACTORIES[rel]} 工厂`);
    // 工厂本身不读配置、不起监听:require 与调用都不该有副作用
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /require\(['"][^'"]*mixrouter['"]\)/,
      `${rel} 不得 require 主入口(依赖方向:入口 → 编排 → 领域模块)`);
    assert.doesNotMatch(src, /enterWorktree|node_modules/,
      `${rel} 不得引入依赖或额外机制(零运行时依赖)`);
  }
});

test('拆分没有建第二套 resolver / 转换器 / 万能 context', () => {
  // 协议转换、路由解析、读体、错误体一律复用既有模块:新增文件里不出现这些名字的实现。
  const forbidden = [
    /function\s+createResolver/, /function\s+poolMembers/, /function\s+normalizeRule/,
    /function\s+parseJsonBody/, /function\s+protoError/, /function\s+anthropicError/,
    /function\s+responsesToChat/, /function\s+anthropicToResponses/, /function\s+safeHeader/,
  ];
  for (const rel of SPLIT_FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const re of forbidden) assert.doesNotMatch(src, re, `${rel} 不应重新实现 ${re}`);
  }
});

// ---------------------------------------------------------------- 请求上下文

function fakeContextDeps(overrides = {}) {
  const writes = [];
  const res = new (require('node:events').EventEmitter)();
  res.headersSent = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.writeHead = () => { res.headersSent = true; };
  res.write = chunk => writes.push(chunk);
  res.end = () => { res.writableEnded = true; };
  const finished = [];
  const entry = { status: 0, err: '', err_class: '', in: 0, out: 0, ms: 0 };
  const deps = {
    res, entry, started: 1000, rawLen: 4000, archiveRequestId: 'req-1',
    totalDeadlineMs: 1000, maxAttempts: 3, convRetries: 3, sseKeepAliveMs: 0,
    protoError: (r, app, status, type, message) => { r.writeHead(status); r.end(JSON.stringify({ app, status, type, message })); },
    app: 'claude',
    onFinish: e => finished.push({ ...e }),
    ...overrides,
  };
  return { deps, entry, res, writes, finished };
}

test('请求上下文:预算是「总预算 + 按体积放宽」,上限是候选数 + 换 key 重试 + 带图重打', () => {
  const { createRequestContext } = require('../lib/proxy/context');
  const a = fakeContextDeps();
  const ctx = createRequestContext(a.deps);
  // 每 4 字节 ≈ 1 token,每 token 放 2ms,封顶 10 分钟
  assert.equal(ctx.deadlineMs, 1000 + Math.min(600000, Math.ceil(4000 / 4) * 2));
  assert.equal(ctx.deadlineAt, 1000 + ctx.deadlineMs);
  // MA=3/CR=3 → 3+3;这是实测上界,不是两个旋钮相乘(乘出来是 12)
  assert.equal(ctx.maxUpstreamCalls, 6);
  assert.match(ctx.capWhy, /候选渠道最多 3 \+ 换 key 重试 3\)/);
  // 体积放大封顶:1MB 体不能让预算无限涨
  const big = fakeContextDeps({ rawLen: 64 * 1024 * 1024 });
  assert.equal(createRequestContext(big.deps).deadlineMs, 1000 + 600000);
});

test('optional upstream call cap only tightens the existing shared budget', () => {
  const { createRequestContext } = require('../lib/proxy/context');
  for (const [upstreamCallLimit, expected] of [
    [50, 50], [1, 1], [100, 53], [undefined, 53], [0, 53], [-1, 53], [1.5, 53], ['50', 53],
  ]) {
    const { deps } = fakeContextDeps({ maxAttempts: 50, convRetries: 3, upstreamCallLimit });
    const ctx = createRequestContext(deps);
    assert.equal(ctx.maxUpstreamCalls, expected);
    assert.match(ctx.capWhy, new RegExp(`\\(${expected} 次`));
  }
});

test('请求上下文:finish 幂等,真实调用计数只加不减', () => {
  const { createRequestContext } = require('../lib/proxy/context');
  const a = fakeContextDeps();
  const ctx = createRequestContext(a.deps);
  assert.equal(ctx.netAttempts, 0);
  ctx.bumpNetAttempts(); ctx.bumpNetAttempts();
  assert.equal(ctx.netAttempts, 2);
  ctx.finish(); ctx.finish(); ctx.finish();
  assert.equal(a.finished.length, 1, '终态只能结算一次');
  assert.equal(ctx.finalized, true);
  // sendErr 改的是客户端看到的状态,不改终态次数
  ctx.sendErr(502, 'api_error', 'boom', 'upstream_server');
  assert.equal(a.finished.length, 1);
  assert.equal(a.entry.status, 502);
});

test('请求上下文:取消按中性收尾,只释放一次许可、不把取消算成渠道失败', () => {
  const { createRequestContext } = require('../lib/proxy/context');
  const a = fakeContextDeps();
  const ctx = createRequestContext(a.deps);
  const releases = [];
  ctx.setRelease((outcome) => releases.push(outcome));
  ctx.setActiveRequest({ destroy: () => { ctx.destroyedReq = true; } });
  ctx.setActiveResponse({ destroy: () => { ctx.destroyedRes = true; } });
  a.res.emit('close');
  a.res.emit('close'); // 第二次 close 不该再走一遍(已 finalized)
  assert.deepEqual(releases, ['cancelled']);
  assert.equal(ctx.destroyedReq, true);
  assert.equal(ctx.destroyedRes, true);
  assert.equal(ctx.clientClosed, true);
  assert.equal(a.entry.err_class, 'cancelled');
  assert.equal(a.entry.status, 499);
  assert.equal(a.finished.length, 1);
});

test('请求上下文:响应已正常写完时 close 不覆盖终态', () => {
  const { createRequestContext } = require('../lib/proxy/context');
  const a = fakeContextDeps();
  const ctx = createRequestContext(a.deps);
  a.entry.status = 200;
  a.res.writableFinished = true;
  a.res.emit('close');
  assert.equal(ctx.clientClosed, false);
  assert.equal(a.entry.status, 200);
  assert.equal(a.finished.length, 0, '这条路径要由调用方自己收尾(见 writableFinished 的说明)');
});

test('请求上下文:keepalive 只在提交后启动,收尾即停', async () => {
  const { createRequestContext } = require('../lib/proxy/context');
  const a = fakeContextDeps({ sseKeepAliveMs: 5 });
  const ctx = createRequestContext(a.deps);
  assert.deepEqual(a.writes, [], '提交前一个字节都不能写');
  ctx.startKeepAlive();
  await new Promise(resolve => setTimeout(resolve, 20));
  ctx.finish();
  const after = a.writes.length;
  assert.ok(after >= 1, '提交后要按周期补 SSE 注释');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(a.writes.length, after, '收尾后必须停掉心跳');
});

// ---------------------------------------------------------------- attempt 调度

function fakeLoop(plan, ctx) {
  return { plan, ctx, calls: [] };
}

test('attempt 调度:总调用上限是硬闸门 —— 打满后不再发起尝试,只结算一条 too_many_attempts', () => {
  const { createAttemptRunner } = require('../lib/proxy/attempts');
  const entry = { status: 0, err: '', err_class: '', ms: 0 };
  const sent = [];
  const finished = [];
  const ctx = {
    entry, started: 1000, deadlineMs: 1000, deadlineAt: 2000, archived: '',
    maxUpstreamCalls: 2, capWhy: '已达本次请求的上游调用上限(2 次:…)',
    netAttempts: 2, deadlineHit: false, finalized: false, clientClosed: false,
    finish: () => finished.push(1),
    sendErr: (...args) => sent.push(args),
  };
  const runAttempt = () => { throw new Error('打满上限后不得再发起尝试'); };
  const { runAttempts } = createAttemptRunner({ runAttempt, convRetries: 3 });
  runAttempts({ ordered: [{ provider: { name: 'p' } }], sessionKey: 'cc:x' }, ctx);
  assert.deepEqual(finished, [1]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 502);
  assert.equal(entry.err_class, 'too_many_attempts');
  assert.equal(entry.status, 502);
  assert.match(entry.err, /上游调用上限/);
});

test('attempt 调度:总预算用尽后不再打上游', () => {
  const { createAttemptRunner } = require('../lib/proxy/attempts');
  const ctx = {
    entry: {}, started: 0, deadlineMs: 0, deadlineAt: 0, maxUpstreamCalls: 9, capWhy: '',
    netAttempts: 0, deadlineHit: true, finalized: false, clientClosed: false,
    finish() { throw new Error('不该收尾'); }, sendErr() { throw new Error('不该回错'); },
  };
  const runAttempt = () => { throw new Error('预算用尽后不得再打上游'); };
  const { runAttempts } = createAttemptRunner({ runAttempt, convRetries: 0 });
  runAttempts({ ordered: [{ provider: { name: 'p' } }], sessionKey: 'cc:x' }, ctx);
});

test('attempt 调度:候选游标、固定 Key 截断与换 key 配额都在调度层', () => {
  const { createAttemptRunner } = require('../lib/proxy/attempts');
  const seen = [];
  const ctx = {
    entry: {}, started: 0, deadlineMs: 0, deadlineAt: 0, maxUpstreamCalls: 99, capWhy: '',
    netAttempts: 0, deadlineHit: false, finalized: false, clientClosed: false,
    finish() {}, sendErr() {},
  };
  const ordered = [{ provider: { id: 'a' } }, { provider: { id: 'b' } }, { provider: { id: 'c' } }];
  const runAttempt = (loop, plan, c, i) => {
    seen.push(i);
    if (seen.length === 1) {
      assert.equal(loop.convRetriesLeft, 2, '配额从 convRetries 常量起算');
      loop.useConvRetry();
      assert.equal(loop.convRetriesLeft, 1);
      return loop.retry(i); // 同渠道重试
    }
    if (seen.length === 2) {
      assert.equal(plan.ordered.length, 3);
      loop.pinTo(i); // 固定 Key:本请求不再试别的渠道/账号
      assert.equal(plan.ordered.length, 1, '固定 Key 必须截断候选表');
      return loop.retry(1); // 越界游标由调度层自己的上限/边界逻辑兜住
    }
  };
  const { runAttempts } = createAttemptRunner({ runAttempt, convRetries: 2 });
  const plan = { ordered, sessionKey: 'cc:x' };
  runAttempts(plan, ctx);
  assert.deepEqual(seen, [0, 0, 1]);
});
