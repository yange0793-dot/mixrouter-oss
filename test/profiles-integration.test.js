'use strict';
// 方案的生产接线：只换全局槽位，不改客户端/压缩/Bots/会话，也不中途换在途请求。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-profiles-integration-'));
process.env.MIXR_DATA_DIR = dir;
process.env.MIXR_CLAUDE_SETTINGS = path.join(dir, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(dir, 'config.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXR_RETRY_DELAY_MS = '0';
const mod = require('../mixrouter');
let ui, proxy, upstream, releaseReply, arrived;
const waiting = new Promise(resolve => { arrived = resolve; });
const scoped = { claude: { main: { provider: 'pa', model: 'model-a', pool: [{ provider: 'pb', model: 'model-b' }],
  strategy: 'priority', dropTools: ['unused_tool'] } }, codex: { main: { provider: 'pc', model: 'codex-a' } } };
const sentinels = ['providers.json', 'routes.json', 'bots.json', 'settings.json', 'config.toml'];
function req(server, method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
        'x-claude-code-session-id': 'profile-inflight-fixture' } }, response => {
      let text = ''; response.on('data', c => { text += c; });
      response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(text) }));
    });
    request.on('error', reject); request.end(data);
  });
}
const api = (method, route, body) => req(ui, method, route, body);
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

before(async () => {
  upstream = http.createServer((request, response) => {
    let text = ''; request.on('data', c => { text += c; });
    request.on('end', () => {
      const body = JSON.parse(text);
      const answer = () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'msg_profile', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: body.model }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
      };
      if (body.messages[0].content === 'wait') { releaseReply = answer; arrived(body.model); } else answer();
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const provider = (id, model) => ({ id, name: id, model, models: [model], enabled: true, api_key: 'FAKE-profile-key', base_url: base });
  mod._state.store = { claude: [provider('pa', 'model-a'), provider('pb', 'model-b')], codex: [provider('pc', 'codex-a')] };
  mod._state.slotMap = structuredClone(scoped);
  mod._state.routes = { rules: [] };
  for (const file of sentinels) fs.writeFileSync(path.join(dir, file), `preserve-${file}`);
  ui = await mod.listen(0, mod.apiHandler); proxy = await mod.listen(0, mod.proxyHandler);
});
after(async () => { if (releaseReply) releaseReply(); await Promise.all([ui, proxy, upstream].map(close)); fs.rmSync(dir, { recursive: true, force: true }); });

test('真实 API 保存/预览/应用，选中组完整恢复，现有配置及在途请求保持', async () => {
  const before = await api('GET', '/api/profiles');
  assert.equal(before.status, 200);
  const save = await api('POST', '/api/profiles', { name: 'Fixture stable', apps: ['claude'], expected_revision: before.json.revision });
  assert.equal(save.status, 200, JSON.stringify(save.json));
  const saved = (await api('GET', '/api/profiles')).json;
  const id = saved.profiles[0].id;
  assert.equal(saved.profiles[0].active, true);
  assert.deepEqual(mod._state.slotMap, scoped);
  const current = structuredClone(scoped);
  current.claude.main = { provider: 'pb', model: 'model-b' };
  current.codex.main.model = 'codex-untouched';
  mod._state.slotMap = current;
  const request = req(proxy, 'POST', '/v1/messages', { model: 'mixr-main', max_tokens: 16, messages: [{ role: 'user', content: 'wait' }] });
  assert.equal(await waiting, 'model-b');
  const sessionBefore = JSON.stringify([...mod._state.sessions]);
  const coreBefore = JSON.stringify([mod._state.store, mod._state.routes]);
  const preview = await api('POST', `/api/profiles/${id}/preview`, {});
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.can_apply, true);
  assert.ok(preview.json.changes.some(change => change.app === 'claude' && change.slot === 'main'));
  const apply = await api('POST', `/api/profiles/${id}/apply`, {
    confirm: true, expected_revision: preview.json.expected_revision, slots_revision: preview.json.slots_revision,
  });
  assert.equal(apply.status, 200, JSON.stringify(apply.json));
  assert.deepEqual(mod._state.slotMap.claude, scoped.claude);
  assert.deepEqual(mod._state.slotMap.codex, current.codex);
  assert.equal(JSON.stringify([...mod._state.sessions]), sessionBefore);
  assert.equal(JSON.stringify([mod._state.store, mod._state.routes]), coreBefore);
  for (const file of sentinels) assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), `preserve-${file}`);
  releaseReply(); releaseReply = null;
  assert.equal((await request).json.model, 'model-b', '在途请求不能被新槽位截换');
  const next = await req(proxy, 'POST', '/v1/messages', { model: 'mixr-main', max_tokens: 16, messages: [{ role: 'user', content: 'next' }] });
  assert.equal(next.json.model, 'model-a', '下一条别名请求才跟随方案');
  const stale = await api('POST', `/api/profiles/${id}/apply`, {
    confirm: true, expected_revision: preview.json.expected_revision, slots_revision: preview.json.slots_revision,
  });
  assert.equal(stale.status, 409);
});

test('方案切换保留会话槽位覆盖；Codex 方案不回写客户端配置', async () => {
  const routingPath = '/api/sessions/' + encodeURIComponent('cc:profile-inflight-fixture') + '/routing';
  const routing = await api('GET', routingPath);
  assert.equal(routing.status, 200);
  const override = { keys: {}, slots: { main: { provider: 'pb', model: 'model-b' } } };
  const configured = await api('PUT', routingPath, { expected_revision: routing.json.revision, routing: override });
  assert.equal(configured.status, 200, JSON.stringify(configured.json));
  mod._state.slotMap = { ...mod._state.slotMap, claude: { main: { provider: 'pb', model: 'model-b' } } };
  const saved = (await api('GET', '/api/profiles')).json;
  const preview = (await api('POST', `/api/profiles/${saved.profiles[0].id}/preview`, {})).json;
  const applied = await api('POST', `/api/profiles/${preview.id}/apply`, {
    confirm: true, expected_revision: preview.expected_revision, slots_revision: preview.slots_revision,
  });
  assert.equal(applied.status, 200);
  assert.deepEqual(mod._state.slotMap.claude, scoped.claude);
  assert.deepEqual((await api('GET', routingPath)).json.routing, override);
  const next = await req(proxy, 'POST', '/v1/messages', { model: 'mixr-main', max_tokens: 16,
    messages: [{ role: 'user', content: 'session override stays' }] });
  assert.equal(next.json.model, 'model-b', '会话覆盖优先于方案切换后的全局槽位');

  const codexBefore = structuredClone(mod._state.slotMap.codex);
  const create = await api('POST', '/api/profiles', { name: 'Codex fixture', apps: ['codex'], expected_revision: saved.revision });
  assert.equal(create.status, 200);
  const id = create.json.profiles.find(row => row.name === 'Codex fixture').id;
  mod._state.slotMap = { ...mod._state.slotMap, codex: { main: { provider: 'pc', model: 'codex-changed' } } };
  const codexPreview = (await api('POST', `/api/profiles/${id}/preview`, {})).json;
  const codexApply = await api('POST', `/api/profiles/${id}/apply`, {
    confirm: true, expected_revision: codexPreview.expected_revision, slots_revision: codexPreview.slots_revision,
  });
  assert.equal(codexApply.status, 200, JSON.stringify(codexApply.json));
  assert.deepEqual(mod._state.slotMap.codex, codexBefore);
  assert.deepEqual(mod._state.slotMap.claude, scoped.claude);
  for (const file of sentinels) assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), `preserve-${file}`);
});
