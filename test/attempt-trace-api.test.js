'use strict';
// 接线:GET /api/attempts 与 requests.jsonl 的关联、GET /api/errors/guidance 的形状。
//
// 单测(test/attempt-trace.test.js)只证明 store 自己守规矩。这里证明**真代理请求**也
// 走了那条路:阶段事件是代理自己写进去的,request_id 能把一条日志与它的过程对上,
// 每次尝试的渠道/状态都是真的,且两个端点都不回显 prompt / Key / 会话标签。
//
// 与 test/log-wiring.test.js 同一套路:mock 上游 → proxyHandler → 终态 → 日志实例。
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMockUpstream } = require('./mock-upstream.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-attempttrace-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
// 重试间隔设 0:本文件验的是"重试被记下来了",不是退避时长
process.env.MIXR_RETRY_DELAY_MS = '0';
process.env.MIXR_MAX_ATTEMPTS = '2';

const SENT_KEY = 'sk-ant-TRACE-SENTINEL-AAAABBBBCCCC';
const PROMPT = 'PROMPT-SENTINEL-do-not-leak';
const LOG_FILE = path.join(TMP, 'logs', 'requests.jsonl');

const mock = createMockUpstream();
let mod, proxySrv, uiSrv, proxyPort, uiPort, mockPort;

const raw = (port, method, p, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request({ hostname: '127.0.0.1', port, method, path: p,
    headers: { host: `127.0.0.1:${port}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } },
    res => { const cs = []; res.on('data', c => cs.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(cs).toString('utf8') })); });
  r.on('error', reject);
  if (data) r.write(data);
  r.end();
});
const ui = (m, p) => raw(uiPort, m, p);
const ask = (model, extra = {}) => raw(proxyPort, 'POST', '/v1/messages',
  { model, max_tokens: 8, messages: [{ role: 'user', content: PROMPT }], ...extra });
const attemptsOf = async () => JSON.parse((await ui('GET', '/api/attempts')).text).requests;
const logsOf = async qs => JSON.parse((await ui('GET', '/api/logs' + (qs || '?limit=50'))).text).logs;

test('setup:mock 上游 + 两个服务 + 一条可用路由', async () => {
  await new Promise(ok => mock.server.listen(0, '127.0.0.1', ok));
  mockPort = mock.server.address().port;
  mock.server.unref();
  fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({
    version: 2, current: { claude: null, codex: null },
    claude: [{ id: 'p-trace', name: '跟踪渠道', base_url: `http://127.0.0.1:${mockPort}`,
      api_key: SENT_KEY, enabled: true, models: ['trace-model'] }],
    codex: [],
  }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({
    rules: [{ id: 'r-trace', match: 'trace-model', provider: 'p-trace', model: 'trace-model', enabled: true }],
    default: { provider: '', model: '' },
  }));
  fs.writeFileSync(path.join(TMP, 'slots.json'), JSON.stringify({ version: 1, claude: {}, codex: {} }));
  mod = require('../mixrouter.js');
  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  proxySrv.unref(); uiSrv.unref();
});

test('成功请求:过程有 start/attempt/response/finished,且与日志的 request_id 对得上', async () => {
  const r = await ask('trace-model');
  assert.strictEqual(r.status, 200);
  const traces = await attemptsOf();
  assert.strictEqual(traces.length, 1);
  const t = traces[0];
  assert.strictEqual(t.terminal, true);
  assert.strictEqual(t.status, 200);
  assert.deepStrictEqual(t.events.map(e => e.phase), ['start', 'attempt', 'response', 'finished']);
  // 阶段事件里的渠道/模型是真的(不是占位)
  const attempt = t.events.find(e => e.phase === 'attempt');
  assert.strictEqual(attempt.provider_id, 'p-trace');
  assert.strictEqual(attempt.model, 'trace-model');
  assert.strictEqual(t.metadata.model_in, 'trace-model');
  assert.strictEqual(t.metadata.rule, 'r-trace');

  const logs = await logsOf('?limit=1');
  assert.strictEqual(logs[0].request_id, t.id, '日志的 request_id 必须指向这条过程');
  assert.strictEqual(logs[0].status, 200);
});

test('失败转移:过程里能看见「这一发失败 → 等待重试 → 再试一次」', async () => {
  mock.setSseWrappedError(500, 'upstream boom', 1);
  const r = await ask('trace-model');
  assert.strictEqual(r.status, 200, '第一次 500 后应当重试成功');
  const traces = await attemptsOf();
  const t = traces[0];
  const phases = t.events.map(e => e.phase);
  assert.ok(phases.includes('error'), `过程里必须有失败:${phases.join(',')}`);
  assert.ok(phases.includes('retry_wait'), `过程里必须有等待重试:${phases.join(',')}`);
  assert.ok(phases.filter(p => p === 'attempt').length >= 2, '两次尝试都要记下来');
  const err = t.events.find(e => e.phase === 'error');
  assert.strictEqual(err.status, 500);
  assert.strictEqual(err.code, 'upstream_server', '失败事件要带错误分类,而不是上游正文');
  const retry = t.events.find(e => e.phase === 'retry_wait');
  assert.strictEqual(retry.wait_ms, 0, 'MIXR_RETRY_DELAY_MS=0 时必须如实记 0,不伪装成等待');

  const logs = await logsOf('?limit=1');
  assert.strictEqual(logs[0].err_class, 'upstream_server');
  assert.strictEqual(logs[0].request_id, t.id);
});

test('/api/attempts 不回显 prompt / Key / 会话标签 / 上游地址', async () => {
  const body = (await ui('GET', '/api/attempts')).text;
  for (const forbidden of [PROMPT, SENT_KEY, 'sk-ant-TRACE', `127.0.0.1:${mockPort}`, 'mock-echo']) {
    assert.ok(!body.includes(forbidden), `/api/attempts 不得包含 ${forbidden}`);
  }
  // 也不该出现会话键(cc:xxx 这种)与 err 正文
  assert.doesNotMatch(body, /cc:[0-9a-f]/);
  assert.ok(!body.includes('upstream boom'));
});

test('GET /api/attempts 是只读的:不落日志、不改已有过程', async () => {
  const before = (await logsOf()).length;
  const first = await attemptsOf();
  const second = await attemptsOf();
  assert.strictEqual((await logsOf()).length, before, '读过程不得产生日志条目');
  assert.deepStrictEqual(second, first, '重复读取必须返回同一份快照');
});

test('GET /api/errors/guidance:403 归权限/风控、404 归模型、认不出就标不确定', async () => {
  const forbidden = JSON.parse((await ui('GET', '/api/errors/guidance?status=403')).text);
  assert.strictEqual(forbidden.category, 'auth');
  assert.strictEqual(forbidden.uncertain, true);
  assert.match(forbidden.target, /^#/);

  const missing = JSON.parse((await ui('GET', '/api/errors/guidance?status=404')).text);
  assert.strictEqual(missing.category, 'model');

  const unknown = JSON.parse((await ui('GET', '/api/errors/guidance?status=999')).text);
  assert.strictEqual(unknown.category, 'unknown');
  assert.strictEqual(unknown.uncertain, true);

  // 无参也不能 500:形状固定,分类落 unknown
  const empty = await ui('GET', '/api/errors/guidance');
  assert.strictEqual(empty.status, 200);
  assert.strictEqual(JSON.parse(empty.text).category, 'unknown');
});

test('过程不落盘:requests.jsonl 只有日志行,没有阶段流水', async () => {
  const onDisk = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(onDisk.length > 0);
  for (const line of onDisk) {
    const row = JSON.parse(line);
    assert.ok(!('events' in row) && !('metadata' in row), '磁盘只存终态日志');
    assert.strictEqual(typeof row.request_id, 'string');
  }
});

test.after(() => {
  try { proxySrv && proxySrv.close(); } catch {}
  try { uiSrv && uiSrv.close(); } catch {}
  try { mock.server.close(); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
});
