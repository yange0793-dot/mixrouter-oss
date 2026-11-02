'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-insights-api-'));
process.env.MIXR_DATA_DIR = dir;
process.env.MIXR_CLAUDE_SETTINGS = path.join(dir, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(dir, 'config.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXR_RETRY_DELAY_MS = '0';
const mod = require('../mixrouter');
let server, upstream, proxy;
function request(server, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text, json: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(data);
  });
}
const api = (method, route, body, headers) => request(server, method, route, body, headers);
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

before(async () => {
  upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'vendor-reported',
        content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn',
        usage: { input_tokens: 22, output_tokens: 1 } }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  mod._state.store = { claude: [{ id: 'pa', name: 'Channel A', enabled: true, models: ['requested-model'],
    base_url: `http://127.0.0.1:${upstream.address().port}`, api_key: 'FAKE-insights-key' }], codex: [] };
  mod._state.routes = { rules: [] };
  mod._state.slotMap = { claude: { main: { provider: 'pa', model: 'requested-model' } }, codex: {} };
  server = await mod.listen(0, mod.apiHandler);
  proxy = await mod.listen(0, mod.proxyHandler);
});
after(async () => { await Promise.all([server, proxy, upstream].map(close)); fs.rmSync(dir, { recursive: true, force: true }); });

test('模型目录只读和声明保存不修改核心配置', async () => {
  const initial = await api('GET', '/api/insights/models');
  assert.equal(initial.status, 200);
  assert.equal(initial.json.models[0].capabilities.vision.source, 'unknown');
  assert.equal(fs.existsSync(path.join(dir, 'model-specs.json')), false);
  const before = JSON.stringify([mod._state.store, mod._state.routes, mod._state.slotMap]);
  const saved = await api('PUT', '/api/insights/models', { app: 'claude', provider: 'pa', model: 'requested-model',
    expected_revision: initial.json.revision, spec: { context_window: 200000, vision: false } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.models[0].capabilities.context_window.value, 200000);
  assert.equal(saved.json.models[0].capabilities.vision.value, false);
  assert.equal(JSON.stringify([mod._state.store, mod._state.routes, mod._state.slotMap]), before);
  for (const file of ['providers.json', 'routes.json', 'slots.json', 'settings.json', 'config.toml'])
    assert.equal(fs.existsSync(path.join(dir, file)), false, `${file} 不应被声明保存写入`);
  assert.ok(!saved.text.includes('FAKE-insights-key'));
});

test('真实代理接线上下文统计：无正文、无合成用量，三种模型名分开', async () => {
  const body = { model: 'mixr-main', max_tokens: 32, system: 'PRIVATE-SYSTEM-SENTINEL',
    tools: [{ name: 'private_tool', description: 'PRIVATE-TOOL-SENTINEL', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'PRIVATE-MESSAGE-SENTINEL 中文' }] };
  assert.equal((await request(proxy, 'POST', '/v1/messages', body)).status, 200);
  const result = await api('GET', '/api/insights/requests?limit=1');
  assert.equal(result.status, 200);
  assert.equal(result.json.scope.source, 'memory');
  const row = result.json.requests[0];
  assert.equal(row.model_in, 'mixr-main');
  assert.equal(row.model_out, 'requested-model');
  assert.equal(row.upstream_model, 'vendor-reported');
  assert.equal(row.ok, true);
  assert.equal(row.in, 22);
  assert.equal(row.out, 1);
  assert.equal(row.context.serialized_bytes, Buffer.byteLength(JSON.stringify(body)));
  for (const value of Object.values(row.context)) assert.equal(typeof value, 'number');
  assert.equal(row.context.system_bytes + row.context.tools_bytes + row.context.tool_results_bytes
    + row.context.conversation_bytes + row.context.media_bytes + row.context.other_bytes, row.context.serialized_bytes);
  const disk = fs.readFileSync(path.join(dir, 'logs/requests.jsonl'), 'utf8');
  for (const secret of ['PRIVATE-SYSTEM-SENTINEL', 'PRIVATE-TOOL-SENTINEL', 'PRIVATE-MESSAGE-SENTINEL', 'private_tool', 'FAKE-insights-key']) {
    assert.ok(!result.text.includes(secret)); assert.ok(!disk.includes(secret));
  }
  const models = await api('GET', '/api/insights/models');
  assert.equal(models.json.models[0].observation.upstream_model, 'vendor-reported');
});

test('模型声明遵守 Host/Origin/JSON 闸门与 revision；请求列表有界', async () => {
  const initial = await api('GET', '/api/insights/models');
  const body = { app: 'claude', provider: 'pa', model: 'requested-model', spec: {}, expected_revision: initial.json.revision };
  assert.equal((await api('GET', '/api/insights/models', undefined, { host: 'evil.example' })).status, 403);
  assert.equal((await api('PUT', '/api/insights/models', body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await api('PUT', '/api/insights/models', body, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await api('PUT', '/api/insights/models', { ...body, expected_revision: 'stale' })).status, 409);
  for (const limit of ['0', '-1', '501', 'NaN', '1.2'])
    assert.equal((await api('GET', '/api/insights/requests?limit=' + limit)).status, 400);
});

test('HTTP 200 但中断的记录不能显示成功，诊断接口不回显错误正文', async () => {
  const { createInsightsApi } = require('../lib/http/insights-api');
  const handler = createInsightsApi({ file: path.join(dir, 'model-specs.json'), getStore: () => mod._state.store,
    requestLog: { list: () => ({ capacity: 500, logs: [
      { request_id: 'cancelled', status: 200, err: 'PRIVATE-ERROR-BODY', upstream_model: 'reported' },
      { request_id: 'success', status: 200 },
      { request_id: 'unavailable', status: 503 },
    ] }) } });
  let payload;
  await handler({ req: { method: 'GET' }, url: new URL('http://localhost/api/insights/requests'),
    send: (status, data) => { assert.equal(status, 200); payload = data; } });
  assert.deepEqual(payload.requests.map(row => row.ok), [false, true, false]);
  assert.ok(!JSON.stringify(payload).includes('PRIVATE-ERROR-BODY'));
});
