'use strict';
// 尝试过程 trace:白名单、有界生命周期、无定时器、以及与请求上下文的接线。
//
// 这里测的是**契约**,不是实现细节:任何一条用例红了,都意味着 /api/attempts 要么会泄露
// 调用方不该看到的东西,要么会无界增长,要么会让诊断设施反过来影响代理行为。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  createAttemptTraceStore, DEFAULT_LIMIT, DEFAULT_EVENT_LIMIT, DEFAULT_TTL_MS,
  START_FIELDS, EVENT_FIELDS, PHASES,
} = require('../lib/observability/attempt-trace');

const clock = start => {
  const box = { at: start };
  box.now = () => box.at;
  box.advance = ms => { box.at += ms; };
  return box;
};

test('生命周期:start 建 trace、event 记阶段、finish 定终态,list 新→旧', () => {
  const store = createAttemptTraceStore();
  const a = store.start({ app: 'claude', kind: 'messages', model_in: 'mixr-opus' });
  const b = store.start({ app: 'codex', kind: 'responses', model_in: 'gpt-5' });
  assert.ok(a && b && a !== b, 'start 必须返回各不相同的 id');

  assert.equal(store.event(a, { phase: 'attempt', attempt: 1, provider_id: 'p1', model: 'm1', key_id: 'k1' }), true);
  assert.equal(store.event(a, { phase: 'retry_wait', attempt: 1, wait_ms: 1000 }), true);
  assert.equal(store.finish(a, { status: 200, code: '' }), true);

  const list = store.list();
  assert.deepEqual(list.map(t => t.id), [b, a], 'list 必须新→旧');
  const done = list[1];
  assert.equal(done.terminal, true);
  assert.equal(done.status, 200);
  assert.deepEqual(done.metadata, { app: 'claude', kind: 'messages', model_in: 'mixr-opus' });
  assert.deepEqual(done.events.map(e => e.phase), ['start', 'attempt', 'retry_wait', 'finished']);
  assert.equal(done.events[1].provider_id, 'p1');
  assert.equal(done.events[2].wait_ms, 1000);
  // start() 的第一条事件就是 start,页面不必靠"events 为空"猜状态
  assert.equal(list[0].terminal, false);

  // 终态只写一次:后到的状态不许覆盖第一次的结论
  assert.equal(store.finish(a, { status: 500, code: 'timeout' }), false);
  assert.equal(store.list()[1].status, 200);
  // 已结束的 trace 不再接受事件(不复活)
  assert.equal(store.event(a, { phase: 'attempt', attempt: 2 }), false);
  // 未知 id 一律 false,而不是建一条新记录
  assert.equal(store.event('nope', { phase: 'attempt' }), false);
  assert.equal(store.finish('nope', { status: 200 }), false);
});

test('字段白名单:prompt / 会话 / Key / URL / 错误正文一个字都不进 trace', () => {
  const store = createAttemptTraceStore();
  const id = store.start({
    app: 'claude', model_in: 'm',
    // 下面这些是调用方最顺手的"多传一点",必须被丢掉
    prompt: 'SECRET-PROMPT-BODY', session: 'cc:session-label', session_key: 'cc:abc',
    api_key: 'sk-SECRET-KEY', key: 'sk-SECRET-KEY', base_url: 'https://upstream.internal/v1',
    body: { messages: [{ role: 'user', content: 'SECRET-PROMPT-BODY' }] },
  });
  store.event(id, {
    phase: 'error', attempt: 1, provider_id: 'p', status: 500,
    err: 'upstream said 500 and echoed sk-SECRET-KEY',
    message: 'SECRET-UPSTREAM-TEXT', url: 'https://upstream.internal/v1',
  });
  store.finish(id, { status: 500, code: 'upstream_server' });

  const raw = JSON.stringify(store.list());
  for (const forbidden of ['SECRET-PROMPT-BODY', 'SECRET-KEY', 'SECRET-UPSTREAM-TEXT',
    'session-label', 'upstream.internal', 'sk-SECRET']) {
    assert.ok(!raw.includes(forbidden), `trace 不得包含 ${forbidden}`);
  }
  const rec = store.list()[0];
  assert.deepEqual(Object.keys(rec.metadata), ['app', 'model_in']);
  const ev = rec.events[1];
  assert.deepEqual(Object.keys(ev).sort(), ['attempt', 'code', 'model', 'phase', 'provider_id', 'status', 'ts', 'wait_ms', 'key_id'].sort());
  // 白名单常量本身就是契约:新增字段必须同时改这里与文档
  assert.deepEqual([...START_FIELDS], ['app', 'kind', 'model_in', 'slot', 'rule', 'stream']);
  assert.deepEqual([...EVENT_FIELDS], ['phase', 'attempt', 'provider_id', 'model', 'key_id', 'status', 'code', 'wait_ms']);
});

test('输入容错:未知阶段被拒、控制字符单行化、超长文本截断', () => {
  const store = createAttemptTraceStore();
  const id = store.start({ app: 'claude\ncodex', model_in: 'x'.repeat(200) });
  assert.equal(store.event(id, { phase: 'nonsense' }), false, '未知阶段不记,也不抛');
  assert.equal(store.event(id, null), false);
  assert.equal(store.event(id, { phase: 'ATTEMPT', attempt: -3, status: 'abc', wait_ms: Infinity }), true);
  const rec = store.list()[0];
  assert.equal(rec.metadata.app, 'claude codex', '换行必须被压成空格');
  assert.equal(rec.metadata.model_in.length, 64, '文本字段有长度上限');
  const ev = rec.events[1];
  assert.equal(ev.phase, 'attempt', '阶段大小写归一');
  assert.equal(ev.attempt, 0);
  assert.equal(ev.status, 0);
  assert.equal(ev.wait_ms, 0);
  // 非对象 metadata 不抛
  assert.ok(store.start(null));
});

test('有界:limit 淘汰最旧、eventLimit 保留最新、list 返回副本', () => {
  const store = createAttemptTraceStore({ limit: 3, eventLimit: 2 });
  const ids = [0, 1, 2, 3].map(i => store.start({ model_in: `m${i}` }));
  const list = store.list();
  assert.equal(list.length, 3, '超出 limit 从最旧删');
  assert.deepEqual(list.map(t => t.id), [ids[3], ids[2], ids[1]]);

  const id = ids[3];
  for (let i = 1; i <= 5; i++) store.event(id, { phase: 'attempt', attempt: i });
  const rec = store.list()[0];
  assert.equal(rec.events.length, 2, '事件数有上限');
  assert.deepEqual(rec.events.map(e => e.attempt), [4, 5], '保留最新,删最旧');

  // 副本:调用方改返回值不能改 Store
  rec.events[0].attempt = 999;
  rec.metadata.model_in = 'tampered';
  assert.equal(store.list()[0].events[0].attempt, 4);
  assert.equal(store.list()[0].metadata.model_in, 'm3');
});

test('TTL:按最近一次更新过期,过期后 list 不再返回、start 仍可用', () => {
  const c = clock(Date.parse('2026-01-01T00:00:00.000Z'));
  const store = createAttemptTraceStore({ ttlMs: 1000, now: c.now });
  const live = store.start({ model_in: 'a' });
  c.advance(600);
  store.event(live, { phase: 'attempt', attempt: 1 });   // 更新一次,续期
  c.advance(600);
  const fresh = store.start({ model_in: 'b' });
  // a 最后一次更新在 600ms 前(未过期);b 刚建
  assert.equal(store.list().length, 2);
  c.advance(500);   // a 距最后更新 1100ms > 1000ms;b 距建立 500ms
  const ids = store.list().map(t => t.id);
  assert.deepEqual(ids, [fresh], '过期的 trace 在 list 时被清掉');
  assert.ok(DEFAULT_TTL_MS > 0);
});

test('不起定时器、不读盘:模块本身零副作用,操作也不留下 handle', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'observability', 'attempt-trace.js'), 'utf8');
  assert.doesNotMatch(src, /setInterval|setTimeout|setImmediate/, '诊断缓冲不得起定时器');
  assert.doesNotMatch(src, /require\(['"]node:fs['"]\)|require\(['"]fs['"]\)/, 'trace 只在本进程内存里');
  const before = typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo().filter(x => x === 'Timeout').length : null;
  const store = createAttemptTraceStore();
  for (let i = 0; i < 40; i++) {
    const id = store.start({ model_in: `m${i}` });
    store.event(id, { phase: 'attempt', attempt: 1 });
    store.finish(id, { status: 200 });
  }
  store.list();
  if (before !== null) {
    const after = process.getActiveResourcesInfo().filter(x => x === 'Timeout').length;
    assert.ok(after <= before, `trace 不得留下计时器(${before} → ${after})`);
  }
  assert.ok(DEFAULT_LIMIT > 0 && DEFAULT_EVENT_LIMIT > 0);
  assert.deepEqual([...PHASES], ['start', 'attempt', 'response', 'error', 'retry_wait', 'finished']);
});

// ---------------------------------------------------------------- 与请求上下文接线

function fakeContextDeps(overrides = {}) {
  const res = new (require('node:events').EventEmitter)();
  res.headersSent = false; res.writableEnded = false; res.destroyed = false;
  res.writeHead = () => { res.headersSent = true; };
  res.write = () => {}; res.end = () => { res.writableEnded = true; };
  const finished = [];
  const entry = { status: 0, err: '', err_class: '', in: 0, out: 0, ms: 0 };
  const deps = {
    res, entry, started: Date.now(), rawLen: 400, archiveRequestId: '',
    totalDeadlineMs: 5000, maxAttempts: 2, convRetries: 0, sseKeepAliveMs: 0,
    protoError: (r, app, status, type, message) => { r.writeHead(status); r.end(JSON.stringify({ type, message })); },
    app: 'claude',
    onFinish: e => finished.push({ ...e }),
    ...overrides,
  };
  return { deps, entry, res, finished };
}

test('接线:ctx 把阶段事件写进 store,终态与 onFinish 各只发生一次', () => {
  const { createRequestContext } = require('../lib/proxy/context');
  const store = createAttemptTraceStore();
  const id = store.start({ app: 'claude', model_in: 'm' });
  const a = fakeContextDeps({ onTrace: { id, event: e => store.event(id, e), finish: f => store.finish(id, f) } });
  const ctx = createRequestContext(a.deps);
  assert.equal(ctx.traceId, id);

  assert.equal(ctx.recordAttemptEvent({ phase: 'attempt', attempt: 1, provider_id: 'p1' }), true);
  assert.equal(ctx.recordAttemptEvent({ phase: 'bogus' }), false, '非法阶段返回 false');
  a.entry.status = 502;
  a.entry.err_class = 'upstream_server';
  ctx.finish(); ctx.finish();

  assert.equal(a.finished.length, 1, '终态只结算一次');
  const rec = store.list()[0];
  assert.equal(rec.terminal, true);
  assert.equal(rec.status, 502);
  assert.equal(rec.code, 'upstream_server');
  assert.deepEqual(rec.events.map(e => e.phase), ['start', 'attempt', 'finished']);
});

test('接线:没有 onTrace 时上下文照常工作(裁剪部署 / 既有单测路径)', () => {
  const { createRequestContext } = require('../lib/proxy/context');
  const a = fakeContextDeps();
  const ctx = createRequestContext(a.deps);
  assert.equal(ctx.traceId, '');
  assert.equal(ctx.recordAttemptEvent({ phase: 'attempt', attempt: 1 }), false);
  ctx.finish();
  assert.equal(a.finished.length, 1);
});

test('接线:onTrace 抛错不会打断代理(诊断设施不得改写行为)', () => {
  const { createRequestContext } = require('../lib/proxy/context');
  const a = fakeContextDeps({
    onTrace: {
      id: 'boom',
      event: () => { throw new Error('trace down'); },
      finish: () => { throw new Error('trace down'); },
    },
  });
  const ctx = createRequestContext(a.deps);
  assert.equal(ctx.recordAttemptEvent({ phase: 'attempt', attempt: 1 }), false);
  assert.doesNotThrow(() => ctx.finish());
  assert.equal(a.finished.length, 1, '日志/会话结算必须照常发生');
});

test('接线:attempt 自己把「已发上游」与「拿到响应头」写进 trace(不许静默丢事件)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'proxy', 'attempt.js'), 'utf8');
  // note() 是被全文件复用的旁路入口;它一旦自指(内部又调 note),所有阶段都会静默消失,
  // 而 trace 只剩 retry_wait / finished —— 这种"看着有记录、其实没有过程"的假绿只能靠源码断言拦住。
  const helper = /const note = event => \{([^}]*)\}/.exec(src);
  assert.ok(helper, '找不到 note() 旁路入口');
  assert.match(helper[1], /ctx\.recordAttemptEvent\(event\)/, 'note() 必须调用 ctx.recordAttemptEvent');
  assert.equal((helper[1].match(/\bnote\(/g) || []).length, 0, 'note() 不得自指');
  for (const phase of ["phase: 'attempt'", "phase: 'response'", "phase: 'error'"]) {
    assert.ok(src.includes(phase), `attempt.js 必须记录 ${phase}`);
  }
});

test('接线:调度层在重试前记 retry_wait,且 ctx 缺记录口时不抛', () => {
  const { createAttemptRunner } = require('../lib/proxy/attempts');
  const seen = [];
  const ctx = {
    entry: { status: 0 }, started: 0, deadlineMs: 0, deadlineAt: 0, maxUpstreamCalls: 9, capWhy: '',
    netAttempts: 1, deadlineHit: false, finalized: false, clientClosed: false,
    recordAttemptEvent: e => seen.push(e),
    finish() {}, sendErr() {},
  };
  const runner = createAttemptRunner({ runAttempt: (loop, plan, c, i) => { if (i === 0) loop.retry(1); }, convRetries: 0, retryDelayMs: 0 });
  runner.runAttempts({ ordered: [{ provider: { id: 'p', name: 'p' } }], sessionKey: 's' }, ctx);
  assert.deepEqual(seen, [{ phase: 'retry_wait', attempt: 1, wait_ms: 0 }]);

  // 没有 recordAttemptEvent 的 ctx(既有单测形状)不能因此抛错
  const bare = { entry: {}, started: 0, deadlineMs: 0, deadlineAt: 0, maxUpstreamCalls: 9, capWhy: '',
    netAttempts: 0, deadlineHit: false, finalized: false, clientClosed: false, finish() {}, sendErr() {} };
  assert.doesNotThrow(() => runner.runAttempts({ ordered: [{ provider: { id: 'p', name: 'p' } }], sessionKey: 's' }, bare));
});
