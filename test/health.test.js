'use strict';
// v3.4 上游可靠性测试:错误分型、三段超时(首字节/流式空闲/非流式总)、客户端断开收尾、
// 4xx 直通、重试次数与间隔、槽位后备策略、/api/health 视图。
//
// 熔断器与渠道冷却都已整体删除(失败禁用渠道的行为不存在),所以这里不再测开路/半开;
// 原来靠"熔断开路后不再打上游"表达的意图,改由「重试次数」与「上游调用上界」直接钉住。
// mock 上游 + 临时数据目录,不触碰真实配置与真实上游
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-health-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_COOLDOWN_SEC = '60';
process.env.MIXR_MAX_ATTEMPTS = '3';
process.env.MIXR_CONV_RETRIES = '3';
// 三段超时都压到亚秒级,让"上游发完头就装死"这类场景在测试里可复现
// 流式首字节也要设:上游恒流式(非流死循环治理)后,非流客户端的请求同样按流式首字节预算算
process.env.MIXR_FIRST_HEADER_TIMEOUT_MS = '1200';
process.env.MIXR_STREAM_FIRST_HEADER_TIMEOUT_MS = '1200';
process.env.MIXR_STREAM_IDLE_TIMEOUT_MS = '600';
process.env.MIXR_NONSTREAM_TOTAL_TIMEOUT_MS = '800';
// 重试间隔默认 1s:本文件量的是重试次数与转移落点,不是真的等一秒。
// 延时逻辑本身在下面的调度层用例里单独覆盖(用非零值)。
process.env.MIXR_RETRY_DELAY_MS = '0';

const mod = require('../mixrouter.js');
const { sessionIdentity, errorClass, _state } = mod;
const { createAttemptRunner } = require('../lib/proxy/attempts.js');

// ---------------------------------------------------------------- 纯函数
test('errorClass:状态码与网络错误分型', () => {
  assert.strictEqual(errorClass(401), 'authentication');
  assert.strictEqual(errorClass(403), 'authentication');
  assert.strictEqual(errorClass(429), 'rate_limit');
  assert.strictEqual(errorClass(500), 'upstream_server');
  assert.strictEqual(errorClass(503), 'upstream_server');
  assert.strictEqual(errorClass(400), 'upstream_request');
  assert.strictEqual(errorClass(0, 'ECONNREFUSED'), 'econnrefused');
  assert.strictEqual(errorClass(0, 'ECONNRESET'), 'econnreset');
  assert.strictEqual(errorClass(0, 'ETIMEDOUT'), 'network_error');
  assert.strictEqual(errorClass(0, ''), '');
});

test('sessionIdentity:无头无 metadata 的 codex chat 请求按 system+首条用户消息指纹', () => {
  const req = { headers: {} };
  const mk = sys => ({ messages: [{ role: 'system', content: sys }, { role: 'user', content: 'hello' }] });
  const a = sessionIdentity(req, mk('sys-a'), 'codex');
  assert.strictEqual(a.kind, 'fingerprint');
  assert.ok(a.key.startsWith('cxf:'), `key 应为指纹前缀,得到 ${a.key}`);
  assert.strictEqual(a.key, sessionIdentity(req, mk('sys-a'), 'codex').key, '同内容跨轮稳定');
  assert.notStrictEqual(a.key, sessionIdentity(req, mk('sys-b'), 'codex').key, '不同内容分开');
  assert.strictEqual(sessionIdentity(req, { messages: [] }, 'codex').key, 'cx-anon');
});

// ---------------------------------------------------------------- 调度层:重试间隔
// 这是重试节奏本身唯一的直接覆盖:其它用例都把间隔设成 0,只看"重试了几次"。
// 这里用非零间隔证明"下一发确实被一个定时器推到之后",而不是立刻递归打出去。
function schedulerCtx() {
  return {
    finalized: false, clientClosed: false, deadlineHit: false,
    netAttempts: 0, maxUpstreamCalls: 10, capWhy: 'cap',
    entry: {}, started: Date.now(),
    finish() { this.finalized = true; },
    sendErr() { this.finalized = true; },
  };
}

test('调度层:非零 retryDelayMs 时下一发要等间隔,间隔为 0 时同步重试', async () => {
  const plan = () => ({ ordered: [{ provider: { name: 'a' } }, { provider: { name: 'b' } }], sessionKey: 's' });

  const seen = [];
  const delayed = createAttemptRunner({
    convRetries: 0, retryDelayMs: 40,
    runAttempt: (loop, p, ctx, i) => { seen.push({ i, at: Date.now() }); if (i === 0) loop.retry(1); },
  });
  delayed.runAttempts(plan(), schedulerCtx());
  assert.strictEqual(seen.length, 1, '间隔未到之前不该立刻打第二发');
  await new Promise(ok => setTimeout(ok, 90));
  assert.strictEqual(seen.length, 2, '间隔到点后继续打第二发');
  assert.ok(seen[1].at - seen[0].at >= 30, `两发之间应至少隔 30ms,实际 ${seen[1].at - seen[0].at}ms`);

  // 0 是"关掉间隔"的开关:测试与排障要它立刻重打
  const immediate = [];
  const sync = createAttemptRunner({
    convRetries: 0, retryDelayMs: 0,
    runAttempt: (loop, p, ctx, i) => { immediate.push(i); if (i === 0) loop.retry(1); },
  });
  sync.runAttempts(plan(), schedulerCtx());
  assert.deepStrictEqual(immediate, [0, 1], '间隔为 0 时第二发在同一个调用栈里就发出去了');
});

test('调度层:排队等间隔期间请求已收尾就不再打上游', async () => {
  const ctx = schedulerCtx();
  let calls = 0;
  const runner = createAttemptRunner({
    convRetries: 0, retryDelayMs: 30,
    runAttempt: loop => { calls++; loop.retry(1); },
  });
  runner.runAttempts({ ordered: [{ provider: { name: 'a' } }], sessionKey: 's' }, ctx);
  assert.strictEqual(calls, 1);
  ctx.finalized = true; // 客户端在间隔里断开
  await new Promise(ok => setTimeout(ok, 70));
  assert.strictEqual(calls, 1, '收尾之后的定时器不该再发请求');
});

// ---------------------------------------------------------------- 集成:假上游们
const { createMockUpstream } = require('./mock-upstream.js');
const mock = createMockUpstream();

// 收下请求但永不回响应头(首字节超时用)
function createSilentUpstream() {
  const server = http.createServer(req => req.resume());
  return { server };
}
// 发 200 + SSE 头 + 首个事件后永远沉默(流式空闲超时用)
function createStalledSseUpstream() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    });
  });
  return { server };
}
// 发 200 + 半截 JSON 后沉默(非流式总超时用)
function createSlowBodyUpstream() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"id":"msg_partial","content":[');
    });
  });
  return { server };
}
// 固定状态码上游(4xx 冷却用)
function createStatusUpstream(status) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }));
    });
  });
  return { server };
}
// 慢速 SSE:每 200ms 一小段;客户端断开时上游能察觉(记录 aborted)
function createSlowSseUpstream() {
  const state = { aborted: false };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      let n = 0;
      const timer = setInterval(() => {
        n++;
        if (n > 20) { clearInterval(timer); res.end(); return; }
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n');
      }, 200);
      res.on('close', () => { clearInterval(timer); if (n <= 20) state.aborted = true; });
    });
  });
  return { server, state };
}
// 固定 500 上游(重试与调用上界用);hits 记录被打了多少次
function createFailingUpstream() {
  const state = { hits: 0 };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      state.hits++;
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"boom"}}');
    });
  });
  return { server, state };
}

let proxySrv, uiSrv, proxyPort, uiPort;
const ports = {};

function rawRequest(port, method, reqPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const creq = http.request({
      hostname: '127.0.0.1', port, method, path: reqPath,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, cres => {
      const cs = [];
      cres.on('data', c => cs.push(c));
      cres.on('end', () => resolve({ status: cres.statusCode, headers: cres.headers, text: Buffer.concat(cs).toString('utf8') }));
    });
    creq.on('error', reject);
    if (data) creq.write(data);
    creq.end();
  });
}
// 带看门狗的请求:响应迟迟不结束直接判负(防测试本身挂死)
async function rawRequestGuarded(port, method, reqPath, opts, ms = 5000) {
  let timer;
  try {
    return await Promise.race([
      rawRequest(port, method, reqPath, opts),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`响应 ${ms}ms 未结束`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
const callWithSession = (sessionId, extra = {}) => rawRequestGuarded(proxyPort, 'POST', '/v1/messages', {
  headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': sessionId },
  body: { model: 'mixr-main', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...extra.body },
});
const lastLog = async () => JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?limit=1')).text).logs[0];

function setSlot(primary, pool = [], strategy = 'priority') {
  _state.routes = { rules: [], default: {} };
  _state.slotMap = { claude: { main: { provider: primary, model: 'claude-opus-5', pool, strategy } }, codex: {} };
  resetRouting();
}
function resetRouting() {
  _state.cooldowns = {};
  _state.resetPools();
  _state.sessions.clear();
}

test('setup:三段超时 + 各类假上游', async () => {
  const listen = srv => new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  await listen(mock.server);
  ports.mock = mock.server.address().port;
  const special = {
    silent: createSilentUpstream(), stalled: createStalledSseUpstream(),
    slowBody: createSlowBodyUpstream(), s401: createStatusUpstream(401),
    slowSse: createSlowSseUpstream(), fail: createFailingUpstream(),
  };
  for (const [k, v] of Object.entries(special)) {
    await listen(v.server);
    v.server.unref();
    ports[k] = v.server.address().port;
  }
  ports.slowSseState = special.slowSse.state;
  ports.failState = special.fail.state;
  mock.server.unref();

  const p = (id, name, port) => ({ id, name, base_url: `http://127.0.0.1:${port}`, api_key: `sk-${id}`, enabled: true, models: ['claude-opus-5'], slots: {} });
  const provs = [
    p('pa', 'provA', ports.mock), p('pb', 'provB', ports.mock),
    p('psilent', 'silent', ports.silent), p('pstall', 'stalled', ports.stalled),
    p('pslow', 'slowbody', ports.slowBody), p('p401', 'auth401', ports.s401),
    p('pslowSse', 'slowSse', ports.slowSse), p('pbad', 'bad5xx', ports.fail),
    { id: 'pdead', name: 'dead', base_url: 'http://127.0.0.1:1', api_key: 'sk-dead', enabled: true, models: [] },
  ];
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({ version: 2, current: { claude: null, codex: null }, claude: provs, codex: [] }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({ rules: [], default: { provider: '', model: '' } }));
  _state.store = { claude: provs, codex: [] };
  resetRouting();

  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  proxySrv.unref(); uiSrv.unref();
});

test('首字节超时:上游装死时换下一个渠道,不把请求打回客户端', async () => {
  setSlot('psilent', ['pa']);
  const r = await callWithSession('fb-1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['x-mixrouter-provider'], 'provA', '装死渠道超时后应转移到 pa');
  const log = await lastLog();
  assert.strictEqual(log.failover, true, '真的换了渠道才算故障转移');
  assert.strictEqual(log.err_class, '', '本次已成功恢复,旧超时归因只留在 attempt trace');
  assert.strictEqual(log.err, '', '转移成功不算失败记录');
});

test('流式空闲超时:上游发完头就装死,客户端不会被晾到天荒地老', async () => {
  setSlot('pstall');
  const r = await callWithSession('idle-1', { body: { stream: true } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes('message_start'), '已转发的部分应已送达');
  assert.ok(!r.text.includes('message_stop'), '上游装死,流不该完整');
  const log = await lastLog();
  assert.strictEqual(log.err_class, 'timeout');
  assert.strictEqual(log.err, 'stream idle timeout');
});

test('非流式总超时:上游拖着半个 JSON 不结束,代理掐断并收尾', async () => {
  setSlot('pslow');
  const r = await callWithSession('body-1', { body: { stream: false } });
  assert.strictEqual(r.status, 200, '响应头已回给客户端,只能掐断而不是改状态码');
  assert.ok(r.text.startsWith('{"id":"msg_partial"'));
  const log = await lastLog();
  assert.strictEqual(log.err_class, 'timeout');
  assert.strictEqual(log.err, 'body timeout');
});

test('客户端中途断开:掐掉上游、记一条 cancelled,不烧后台渠道额度', async () => {
  setSlot('pslowSse');
  const before = (await rawRequest(uiPort, 'GET', '/api/logs?limit=1')).text;
  const creq = http.request({
    hostname: '127.0.0.1', port: proxyPort, method: 'POST', path: '/v1/messages',
    headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': 'cancel-1' },
  }, cres => { cres.once('data', () => creq.destroy()); });
  creq.end(JSON.stringify({ model: 'mixr-main', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] }));
  await new Promise(ok => setTimeout(ok, 800));
  assert.strictEqual(ports.slowSseState.aborted, true, '客户端断开后上游连接应被掐断');
  const log = await lastLog();
  assert.strictEqual(log.err_class, 'cancelled');
  assert.ok(log.ms >= 0);
  assert.notStrictEqual(JSON.stringify(log), before, '取消也应有日志');
});

test('4xx 非重试错误:原样透传、不进冷却、分型 authentication', async () => {
  setSlot('p401', ['pa']);
  const r = await callWithSession('auth-1');
  assert.strictEqual(r.status, 401, '401 应原样透传给客户端');
  const log = await lastLog();
  assert.strictEqual(log.err_class, 'authentication');
  assert.strictEqual(log.provider, 'auth401');
  const r2 = await callWithSession('auth-2');
  assert.strictEqual(r2.status, 401);
  assert.strictEqual((await lastLog()).provider, 'auth401', '失败不改变后续请求的 priority 首选');
});

test('槽位 priority 策略保持明确主渠道,不轮换到备用', async () => {
  setSlot('pa', ['pb']);
  const a = await callWithSession('def-1');
  const b = await callWithSession('def-2');
  assert.strictEqual(a.headers['x-mixrouter-provider'], 'provA');
  assert.strictEqual(b.headers['x-mixrouter-provider'], 'provA', 'priority 应总是取第一个可用渠道');
  _state.cooldowns = { pa: Date.now() + 60000 };
  const c = await callWithSession('def-3');
  assert.strictEqual(c.headers['x-mixrouter-provider'], 'provA', '旧冷却表不改变 priority 首选');
});

test('槽位轮换:旧冷却表不移除任何候选', async () => {
  setSlot('pa', ['pb'], 'round_robin');
  const during = [];
  for (let i = 0; i < 4; i++) {
    _state.cooldowns = { pa: Date.now() + 60000 };
    during.push((await callWithSession(`rr-${i}`)).headers['x-mixrouter-provider']);
  }
  assert.equal(during.filter(x => x === 'provA').length, 2);
  assert.equal(during.filter(x => x === 'provB').length, 2);
  _state.cooldowns = { pa: Date.now() - 1 };
  assert.strictEqual(mod.inCooldown('pa'), false, '旧冷却判定恒为 false');
});

test('上游恒失败:同一渠道被重试到调用上界,整个过程不算故障转移', async () => {
  setSlot('pbad');
  ports.failState.hits = 0;
  const r = await callWithSession('retry-same-1');
  // 最后一发就是上游的真实状态码(500 原样透传),不再被本地改写成 502
  assert.strictEqual(r.status, 500);
  // 单渠道池:候选表按 MAX_ATTEMPTS 循环填满,失败后隔一个间隔重打同一个渠道
  assert.strictEqual(ports.failState.hits, 3, `应打满 MIXR_MAX_ATTEMPTS=3 次,实际 ${ports.failState.hits}`);
  const log = await lastLog();
  assert.strictEqual(log.attempts, 3, '日志里的 attempts 是真实上游调用数');
  assert.strictEqual(log.failover, false, '候选表里只有同一渠道,重试不是故障转移');
  assert.strictEqual(log.err_class, 'upstream_server');
});

test('上游恒失败:换渠道后 failover 只为真正的转移置位', async () => {
  setSlot('pbad', ['pa']);
  ports.failState.hits = 0;
  const r = await callWithSession('retry-mixed-1');
  assert.strictEqual(r.status, 200);
  // 第一发 pbad 500 → 换到 pa 成功;转换线没有(直通 anthropic),不消耗 convRetries
  assert.strictEqual(ports.failState.hits, 1);
  const log = await lastLog();
  assert.strictEqual(log.failover, true, '换了渠道才是 failover');
  assert.strictEqual(log.attempts, 2, '一次 pbad + 一次 pa');
});

test('旧冷却表写满也照常转发,不会 502 甩锅', async () => {
  setSlot('pa', ['pb']);
  _state.cooldowns = { pa: Date.now() + 60000, pb: Date.now() + 60000 };
  const r = await callWithSession('all-cold-1');
  assert.strictEqual(r.status, 200, '旧冷却表不影响转发,请求照常发出');
  assert.ok(['provA', 'provB'].includes(r.headers['x-mixrouter-provider']));
});

test('/api/health:只读视图带超时/重试配置与各渠道可用性', async () => {
  setSlot('pa', ['pb'], 'round_robin');
  await callWithSession('health-1'); // 有一条成功记录
  const r = await rawRequest(uiPort, 'GET', '/api/health');
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.text);
  assert.strictEqual(j.settings.first_header_timeout_ms, 1200);
  assert.strictEqual(j.settings.stream_idle_timeout_ms, 600);
  assert.strictEqual(j.settings.nonstream_total_timeout_ms, 800);
  assert.strictEqual(j.settings.cooldown_ms, 0);
  assert.strictEqual(j.settings.max_attempts, 3);
  assert.strictEqual(j.settings.retry_delay_ms, 0, '本进程把重试间隔关了(见文件头),视图要如实反映');
  assert.strictEqual(j.settings.max_upstream_calls, 3 + 3);
  // 熔断器删掉后这三项没有意义,不能再出现在视图里(控制台会照着渲染)
  for (const gone of ['failure_threshold', 'recovery_threshold', 'half_open_max_probes'])
    assert.strictEqual(gone in j.settings, false, `settings 不该再有 ${gone}`);
  // ---- 端到端预算必须落在客户端(Claude Code)的预算里面 ----
  // CC 侧默认 API_TIMEOUT_MS=300s(整条请求)与 CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=120s(多久没收到字节)。
  // 本进程任何一段比它长,客户端都会先放弃并重发,我们还在替一条没人接收的响应占着上游连接和渠道额度,
  // 日志还会记成 499 client closed 而不是真实的 timeout(以前三段默认都是 600s,就是这个问题)。
  const CC_TOTAL_BUDGET_MS = 300000, CC_BYTE_IDLE_MS = 120000;
  assert.ok(j.settings.total_deadline_ms > 0 && j.settings.total_deadline_ms <= CC_TOTAL_BUDGET_MS,
    `总 deadline 必须存在且小于客户端的 ${CC_TOTAL_BUDGET_MS}ms,实际 ${j.settings.total_deadline_ms}`);
  assert.ok(j.settings.stream_first_header_timeout_ms > 0 && j.settings.stream_first_header_timeout_ms < CC_TOTAL_BUDGET_MS,
    '流式请求的上游一接受就发响应头,它的首字节预算必须比客户端总预算紧得多');
  assert.ok(j.settings.stream_idle_timeout_ms < CC_BYTE_IDLE_MS,
    '上游空闲看门狗必须早于客户端的字节流空闲超时,否则我们的诊断根本来不及送到');
  for (const k of ['first_header_timeout_ms', 'stream_first_header_timeout_ms', 'stream_idle_timeout_ms', 'nonstream_total_timeout_ms']) {
    assert.ok(j.settings[k] > 0 && j.settings[k] <= j.settings.total_deadline_ms,
      `${k} 必须被总 deadline 夹住,实际 ${j.settings[k]} > ${j.settings.total_deadline_ms}`);
  }
  const pa = j.providers.find(p => p.provider === 'pa');
  assert.ok(pa, 'providers 里应包含 pa');
  // 视图每项的键集就是契约:控制台按它渲染,多一个少一个都会让面板读错
  assert.deepStrictEqual(Object.keys(pa).sort(), ['app', 'cooldown_until', 'eligible', 'enabled', 'provider']);
  assert.strictEqual(pa.app, 'claude');
  assert.strictEqual(pa.enabled, true);
  assert.strictEqual(pa.eligible, true);
  assert.strictEqual(pa.cooldown_until, 0);
  // 冷却中的渠道 eligible 必须是 false(cooldown_until 是它唯一的依据)
  _state.cooldowns = { pa: Date.now() + 60000 };
  const cold = JSON.parse((await rawRequest(uiPort, 'GET', '/api/health')).text).providers.find(p => p.provider === 'pa');
  assert.strictEqual(cold.eligible, true);
  assert.strictEqual(cold.cooldown_until, 0);
  assert.strictEqual(mod.providerEligible('pa'), true, '旧冷却状态不会禁用渠道');
  _state.cooldowns = {};
  assert.strictEqual(mod.providerEligible('pa'), true);
});

test('全池连不上:502 返回客户端,日志状态如实落盘', async () => {
  setSlot('pdead');
  const r = await callWithSession('dead-1');
  assert.strictEqual(r.status, 502);
  const log = await lastLog();
  assert.strictEqual(log.status, 502, '终态错误状态要写进日志(不能是 0)');
  assert.strictEqual(log.err_class, 'econnrefused');
  assert.ok(log.err);
});
