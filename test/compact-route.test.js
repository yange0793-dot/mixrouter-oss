'use strict';
// Isolated API + proxy integration: temporary config, loopback upstream only.
const { test, before, beforeEach, after } = require('node:test');
const { FIXED_PREFIX } = require('../lib/routing/compact-signature');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-compact-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
const mod = require('../mixrouter');
const GLOBAL = 'your task is to create a detailed summary of';
const LOCAL = 'mixrouter:talentsai-precompact:v1';
let ui, proxy, upstream, base;
const hits = [];
const request = (url, method = 'GET', body) => new Promise((resolve, reject) => {
  const data = body === undefined ? '' : JSON.stringify(body);
  const req = http.request(url, { method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
  });
  req.on('error', reject); req.end(data);
});
const api = (method = 'GET', body, route = '/api/compact') => request(`http://127.0.0.1:${ui.address().port}${route}`, method, body);
const rule = (id, body) => ({ id, match: '', app: 'claude', enabled: true, priority: 90,
  when: { body }, provider: 'old', model: 'misleading-rule-model', strategy: 'priority',
  pool: [{ provider: 'old', model: 'real-pool-model' }, { provider: 'new', model: 'backup-model' }] });
// 瘦身之后 routes.json 里仍可能躺着旧版的通用规则/兜底:它们是**历史数据**,必须原样保留,
// 但不参与路由。下面每个用例都带一条,证明压缩保存不会顺手改写或删除它。
const STALE = { id: 'other', match: 'normal', enabled: true, provider: 'old', model: 'ordinary',
  when: {}, untouched: 'yes' };
const STALE_DEFAULT = { provider: 'old', model: 'default', untouched: 'default' };

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { const body = JSON.parse(Buffer.concat(chunks)); hits.push(body);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'mock', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 1 } })); });
  });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${upstream.address().port}`;
  ui = await mod.listen(0, mod.apiHandler); proxy = await mod.listen(0, mod.proxyHandler);
});
beforeEach(() => {
  fs.rmSync(path.join(TMP, 'routes.json'), { recursive: true, force: true });
  mod._state.store = { claude: [
    { id: 'old', name: 'Old', base_url: base, api_key: 'fake', enabled: true, models: ['real-pool-model'] },
    { id: 'new', name: 'New', base_url: base, api_key: 'fake', enabled: true, models: ['chosen-model'] },
    { id: 'off', name: 'Off', base_url: base, api_key: 'fake', enabled: false, models: [] },
  ], codex: [{ id: 'codex', base_url: base, enabled: true, model: 'codex-model' }] };
  mod._state.routes = { rules: [rule('renamed-a', GLOBAL), rule('renamed-b', LOCAL), { ...STALE }],
    default: { ...STALE_DEFAULT } };
  mod._state.slotMap = { claude: { main: { provider: 'old', model: 'ordinary' } }, codex: {} };
  hits.length = 0;
});

test('GET describes actual pool targets, not misleading rule model; never exposes keys', async () => {
  const r = await api(); assert.equal(r.status, 200);
  assert.equal(r.data.compact.mode, 'mixed'); assert.equal(r.data.compact.selection, null);
  assert.deepEqual(r.data.compact.rules[0].targets.map(m => m.model), ['real-pool-model', 'backup-model']);
  assert.equal(JSON.stringify(r.data).includes('api_key'), false);
  assert.equal(r.data.compact.providers.length, 2);
});

test('renamed compact rules both change, clear pool, preserve unrelated rules and route to chosen model', async () => {
  const before = structuredClone(mod._state.routes);
  const r = await api('POST', { provider: 'new', model: 'chosen-model' }); assert.equal(r.status, 200);
  for (const item of mod._state.routes.rules.slice(0, 2)) {
    assert.equal(item.provider, 'new'); assert.equal(item.model, 'chosen-model'); assert.deepEqual(item.pool, []);
  }
  assert.deepEqual(mod._state.routes.rules[2], before.rules[2]); assert.deepEqual(mod._state.routes.default, before.default);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(TMP, 'routes.json'))), mod._state.routes);
  assert.equal(r.data.compact.mode, 'single');
  // 真压缩请求 = 固定前导开头 + 摘要模板；本项目的压缩规则还要在同一处看到自己的标记。
  const summary = 'Your task is to create a detailed summary of the conversation so far, paying close attention to the user requests and your previous actions.';
  const send = content => request(`http://127.0.0.1:${proxy.address().port}/v1/messages`, 'POST',
    { model: 'mixr-main', max_tokens: 1, messages: [{ role: 'user', content }] });
  for (const content of [FIXED_PREFIX + summary, FIXED_PREFIX + summary + '\n\n' + LOCAL]) {
    const response = await send(content);
    assert.equal(response.status, 200); assert.equal(hits.at(-1).model, 'chosen-model');
  }
  // 把同一句话**引用**出来、没有固定前导的普通请求不得被判给压缩规则 —— 这正是误分流的形态。
  // 回落的是槽位(不再有通用规则可落):模型仍是槽位的落点模型。
  assert.equal((await send('Your task is to create a detailed summary of the conversation so far')).status, 200);
  assert.equal(hits.at(-1).model, 'ordinary');
  assert.equal((await send([{ type: 'tool_result', content: FIXED_PREFIX + summary }])).status, 200);
  assert.equal(hits.at(-1).model, 'ordinary');
});

test('旧版通用规则与兜底留在盘上但不执行:未登记模型明确 503', async () => {
  // routes.json 里的历史规则不能被启动流程删掉(那是用户数据),但它们不再参与路由。
  assert.deepEqual(mod._state.routes.rules.at(-1), STALE);
  assert.deepEqual(mod._state.routes.default, STALE_DEFAULT);
  const send = model => request(`http://127.0.0.1:${proxy.address().port}/v1/messages`, 'POST',
    { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  const unrouted = await send('normal');
  assert.equal(unrouted.status, 503);
  assert.equal(unrouted.data.error.type, 'no_route_error');
  assert.equal(hits.length, 0, '兜底不再执行,不得打到任何上游');
  // 已登记模型仍然精确命中
  assert.equal((await send('chosen-model')).status, 200);
  assert.equal(hits.at(-1).model, 'chosen-model');
});

test('missing compact rules are created, not inferred from IDs', async () => {
  mod._state.routes.rules = [{ id: 'rcompact-global-ds', match: 'keep', when: {}, provider: 'old', enabled: true }];
  const keep = structuredClone(mod._state.routes.rules[0]);
  assert.equal((await api('POST', { provider: 'new', model: 'custom-model' })).status, 200);
  assert.equal(mod._state.routes.rules.length, 3); assert.deepEqual(mod._state.routes.rules[0], keep);
  assert.equal(new Set(mod._state.routes.rules.map(r => r.id)).size, 3);
  assert.equal(mod._state.routes.rules.filter(r => [GLOBAL, LOCAL].includes(r.when.body)).length, 2);
});

test('invalid selections are rejected before disk or memory change', async () => {
  const before = JSON.stringify(mod._state.routes);
  for (const body of [{}, { provider: 'missing', model: 'x' }, { provider: 'off', model: 'x' }, { provider: 'codex', model: 'x' },
    { provider: 'new', model: ' ' }, { provider: 'new', model: {} }, { provider: {}, model: 'x' }, { provider: 'new', model: 'a\nb' }]) {
    assert.equal((await api('POST', body)).status, 400); assert.equal(JSON.stringify(mod._state.routes), before);
    assert.equal(fs.existsSync(path.join(TMP, 'routes.json')), false);
  }
});

test('stale compact drafts cannot overwrite newer state;通用规则保存入口已关闭', async () => {
  const old = await api(); const routes = structuredClone(mod._state.routes);
  assert.equal((await api('POST', { provider: 'new', model: 'chosen', expected_revision: old.data.compact.revision })).status, 200);
  assert.equal((await api('POST', { provider: 'old', model: 'stale', expected_revision: old.data.compact.revision })).status, 409);
  // 通用规则写入整体删除:PUT /api/routes 固定 410,既不 normalize 也不落盘
  const fileBefore = fs.existsSync(path.join(TMP, 'routes.json')) ? fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8') : null;
  const put = await api('PUT', { ...routes, expected_revision: old.data.compact.revision }, '/api/routes');
  assert.equal(put.status, 410);
  assert.equal(fs.existsSync(path.join(TMP, 'routes.json')) ? fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8') : null, fileBefore);
  assert.equal(mod._state.routes.rules[0].model, 'chosen');
});

test('failed atomic save leaves memory unchanged', async () => {
  const before = structuredClone(mod._state.routes);
  fs.mkdirSync(path.join(TMP, 'routes.json'));
  assert.equal((await api('POST', { provider: 'new', model: 'x' })).status, 500);
  assert.deepEqual(mod._state.routes, before);
});

after(async () => { await Promise.all([ui, proxy, upstream].map(s => new Promise(ok => s.close(ok)))); fs.rmSync(TMP, { recursive: true, force: true }); });
