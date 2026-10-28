'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-ready-integration-'));
Object.assign(process.env, { HOME: home, MIXR_DATA_DIR: home, MIXROUTER_PORT: '0', MIXUI_PORT: '0',
  MIXR_CLAUDE_SETTINGS: path.join(home, 'settings.json'), MIXR_CODEX_CONFIG: path.join(home, 'config.toml'),
  MIXR_RESPONSE_ARCHIVE: 'off', MIXR_RETRY_DELAY_MS: '0',
  MIXR_MAX_ATTEMPTS: '3', MIXR_CONV_RETRIES: '0' });
const mod = require('../mixrouter');
let ui, proxy, upstream, base;
let mode = 'success';
const hits = [];
const secretA = 'sk-test-private-A', secretB = 'sk-test-private-B';
function respond(req, res, body) {
  const key = req.headers['x-api-key'];
  hits.push({ key, model: body.model });
  if ((mode === 'fail-primary' && key === secretA) || (mode === 'bad-key' && key === secretA)) {
    res.writeHead(mode === 'bad-key' ? 401 : 500, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'fixture refusal' } }));
  }
  const tool = body.tools?.[0];
  const content = tool ? [{ type: 'tool_use', id: 'call-1', name: tool.name, input: { value: 'ok' } }] : [{ type: 'text', text: 'PONG' }];
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'message', id: 'm1', role: 'assistant', model: body.model, content,
      stop_reason: tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = item => res.write(`event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`);
  event({ type: 'message_start', message: { type: 'message', id: 'm1', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } });
  for (const [index, block] of content.entries()) {
    event({ type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
    event({ type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    event({ type: 'content_block_stop', index });
  }
  event({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } });
  event({ type: 'message_stop' }); res.end();
}
async function request(port, route, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), text };
}
const api = (route, method, body) => request(ui.address().port, route, method, body);
before(async () => {
  upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => respond(req, res, JSON.parse(raw)));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${upstream.address().port}`;
  ui = await mod.listen(0, mod.apiHandler); proxy = await mod.listen(0, mod.proxyHandler);
});
after(async () => {
  for (const server of [ui, proxy, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.rmSync(home, { recursive: true, force: true });
});
function populate() {
  mod._state.store = { claude: [
    { id: 'primary', name: 'primary', base_url: base, api_key: secretA, models: ['model-a'], enabled: true },
    { id: 'backup', name: 'backup', base_url: base, api_key: secretB, models: ['model-b'], enabled: true },
  ], codex: [] };
  mod._state.slotMap = { claude: { main: { provider: 'primary', model: 'model-a', pool: [{ provider: 'backup', model: 'model-b' }], strategy: 'priority' } }, codex: {} };
  mod._state.current = { claude: null, codex: null };
  mod._state.sessions.clear(); mod._state.cooldowns = {}; mode = 'success'; hits.length = 0;
}
test('导入预览不改库、明确合并保留原配置、重复请求令牌不可复用', async () => {
  populate();
  const original = JSON.stringify(mod._state.store);
  const preview = await api('/api/providers/import/preview', 'POST', { input: { claude: [
    { name: 'new', base_url: base, api_key: 'sk-new-fixture', models: ['new-model'], enabled: true },
  ], codex: [] } });
  assert.equal(preview.status, 200, preview.text);
  assert.ok(preview.body.token);
  assert.ok(!preview.text.includes('sk-new-fixture'));
  assert.equal(JSON.stringify(mod._state.store), original);
  const applied = await api('/api/providers/import/apply', 'POST', { token: preview.body.token, confirm: true });
  assert.equal(applied.status, 200, applied.text);
  assert.equal(mod._state.store.claude.length, 3);
  assert.equal(mod._state.store.claude[0].api_key, secretA);
  assert.equal((await api('/api/providers/import/apply', 'POST', { token: preview.body.token, confirm: true })).status, 409);
});
test('新向导预览和实际写入一致，撤销保留后来新增设置', async () => {
  populate();
  const file = process.env.MIXR_CLAUDE_SETTINGS;
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Read'] }, env: { ANTHROPIC_BASE_URL: 'https://old.example', ANTHROPIC_AUTH_TOKEN: 'sk-old-private' } }));
  const preview = await api('/api/onboarding/claude/preview', 'POST', { slots: true });
  assert.equal(preview.status, 200, preview.text);
  assert.ok(!preview.text.includes('sk-old-private'));
  const applied = await api('/api/onboarding/claude/apply', 'POST', { token: preview.body.token, confirm: true });
  assert.equal(applied.status, 200, applied.text);
  const changed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(changed.env.ANTHROPIC_MODEL, 'mixr-main');
  changed.custom_later = true;
  fs.writeFileSync(file, JSON.stringify(changed));
  const undoPreview = await api('/api/onboarding/claude/undo-preview', 'POST', {});
  assert.equal(undoPreview.status, 200, undoPreview.text);
  const undone = await api('/api/onboarding/claude/undo', 'POST', { token: undoPreview.body.token, confirm: true });
  assert.equal(undone.status, 200, undone.text);
  const restored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(restored.custom_later, true);
  assert.equal(restored.env.ANTHROPIC_AUTH_TOKEN, 'sk-old-private');
  assert.equal(restored.env.ANTHROPIC_MODEL, undefined);
});
test('兼容接口真的发三种请求，成功不修改路由或会话', async () => {
  populate(); const before = JSON.stringify(mod._state.store);
  const checked = await api('/api/providers/primary/compatibility', 'POST', { model: 'model-a', key_id: 'klegacy', client_wire: 'messages', confirm_run: true });
  assert.equal(checked.status, 200, checked.text);
  assert.equal(checked.body.ok, true, checked.text);
  assert.equal(hits.length, 3);
  assert.equal(JSON.stringify(mod._state.store), before);
  assert.equal(mod._state.sessions.size, 0);
});
test('兼容接口拒绝已移除的 ZCode 和未知客户端,不发请求', async () => {
  populate();
  for (const app of ['zcode', 'invalid']) {
    const checked = await api('/api/providers/primary/compatibility', 'POST', {
      app, model: 'model-a', client_wire: 'anthropic', confirm_run: true,
    });
    assert.equal(checked.status, 400, checked.text);
    assert.equal(hits.length, 0);
  }
});
test('槽位故障回退使用明确备用模型，不永久改主用配置', async () => {
  populate(); mode = 'fail-primary';
  const configured = JSON.stringify(mod._state.slotMap);
  const response = await request(proxy.address().port, '/v1/messages', 'POST', { model: 'mixr-main', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(hits.map(hit => hit.model), ['model-a', 'model-b']);
  assert.equal(response.body.model, 'model-b');
  assert.equal(JSON.stringify(mod._state.slotMap), configured);
  const trace = await api('/api/attempts');
  assert.ok(trace.body.requests.some(item => item.events?.some(event => event.phase === 'retry_wait')));
});
