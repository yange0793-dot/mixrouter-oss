'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-user-ready-'));
Object.assign(process.env, { HOME: home, MIXR_DATA_DIR: home, MIXROUTER_PORT: '0', MIXUI_PORT: '0',
  MIXR_CLAUDE_SETTINGS: path.join(home, 'settings.json'), MIXR_CODEX_CONFIG: path.join(home, 'config.toml'),
  MIXR_RESPONSE_ARCHIVE: 'off' });
const mod = require('../mixrouter');
let server;
async function api(route, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
before(async () => { server = await mod.listen(0, mod.apiHandler); });
after(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
});
test('新接口仍过同源写入闸门', async () => {
  for (const route of ['/api/onboarding/claude/preview', '/api/providers/import/preview', '/api/providers/missing/compatibility']) {
    assert.equal((await api(route, {}, { origin: 'https://outside.example' })).status, 403);
  }
});
test('配置损坏不报成未接入，预览和失败保留原文件', async () => {
  const file = process.env.MIXR_CLAUDE_SETTINGS;
  fs.writeFileSync(file, '{ malformed');
  const before = fs.readFileSync(file, 'utf8');
  const state = await api('/api/state');
  assert.ok(state.body.live.claude.error);
  const preview = await api('/api/onboarding/claude/preview', { slots: true });
  assert.ok(preview.status >= 400 || preview.body.error || preview.body.ok === false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.unlinkSync(file);
});
test('诊断仅聚合与固定字段，不漏任意用户名、密钥、会话正文或路径', async () => {
  const secret = 'secret-private-marker';
  mod._state.store = { claude: [{ id: secret, name: secret, api_key: secret, base_url: `https://${secret}.example`, models: [secret], note: secret }], codex: [] };
  mod._state.sessions.set('cc:test', { label: secret, providerId: secret, kind: 'header', app: 'claude', lastUsed: Date.now() });
  const report = await api('/api/diagnostics/report');
  assert.equal(report.status, 200);
  assert.equal(report.body.schema_version, 1);
  assert.ok(!JSON.stringify(report.body).includes(secret));
  assert.ok(!JSON.stringify(report.body).includes(home));
  assert.equal(report.body.providers.claude.total, 1);
});
test('导入要求有效预览和明确确认', async () => {
  const noToken = await api('/api/providers/import/apply', { confirm: true, token: 'unknown' });
  assert.equal(noToken.status, 409);
  assert.equal((await api('/api/providers/import/apply', {})).status, 400);
  assert.equal((await api('/api/providers/import/preview', {})).status, 400);
});
test('兼容测试未知渠道明确拒绝，不冒充测试成功', async () => {
  assert.equal((await api('/api/providers/not-found/compatibility', { model: 'test', confirm_run: true })).status, 404);
});
test('Codex 普通接入自动使用已有槽位,预览与实际写入一致且撤销保留推理强度', async () => {
  const file = process.env.MIXR_CODEX_CONFIG;
  const original = 'model = "before-main"\nreview_model = "before-review"\nmodel_provider = "openai"\nmodel_reasoning_effort = "max"\n';
  fs.writeFileSync(file, original);
  const saved = { store: mod._state.store, slots: mod._state.slotMap, current: mod._state.current };
  const provider = { id: 'onboarding-codex', name: 'Fixture', enabled: true, api_key: 'fixture-key',
    base_url: 'http://127.0.0.1:9', model: 'target-main', wire_api: 'responses' };
  try {
    mod._state.store = { claude: [], codex: [provider] };
    mod._state.slotMap = { claude: {}, codex: { main: { provider: provider.id },
      reviewer: { provider: provider.id, model: 'target-review' } } };
    mod._state.current = { claude: '@router', codex: null };
    const preview = await api('/api/onboarding/codex/preview', {});
    assert.equal(preview.status, 200);
    const expected = change => `${change.field}=${JSON.stringify(change.after ?? null)}`;
    assert.ok(preview.body.changes.some(change => change.field === 'model' && change.after === 'mixr-main'));
    assert.ok(preview.body.changes.some(change => change.field === 'review_model' && change.after === 'mixr-reviewer'));
    assert.ok(preview.body.changes.some(change => change.field === 'model_catalog_json' && change.after === 'mixrouter-model-catalog.json'));
    const applied = await api('/api/onboarding/codex/apply', { token: preview.body.token, confirm: true });
    assert.equal(applied.status, 200);
    assert.deepEqual(applied.body.changed.map(expected).sort(), preview.body.changes.map(expected).sort());
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /model_reasoning_effort = "max"/);
    fs.writeFileSync(file, text.replace('model_reasoning_effort = "max"', 'model_reasoning_effort = "xhigh"'));
    const undoPreview = await api('/api/onboarding/codex/undo-preview', {});
    assert.equal(undoPreview.status, 200);
    assert.equal(undoPreview.body.can_undo, true);
    assert.equal((await api('/api/onboarding/codex/undo', { token: undoPreview.body.token, confirm: true })).status, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), original.replace('model_reasoning_effort = "max"', 'model_reasoning_effort = "xhigh"'));
    assert.equal(fs.existsSync(path.join(home, 'mixrouter-model-catalog.json')), true, '撤销不删除目录文件');
  } finally {
    mod._state.store = saved.store;
    mod._state.slotMap = saved.slots;
    mod._state.current = saved.current;
  }
});
test('Codex 普通接入预览不补槽,确认后补齐且客户端撤销保留槽位', async () => {
  const file = process.env.MIXR_CODEX_CONFIG;
  fs.writeFileSync(file, 'model = "legacy-bootstrap"\n');
  const saved = { store: mod._state.store, slots: mod._state.slotMap, current: mod._state.current };
  const provider = { id: 'bootstrap-codex', name: 'Bootstrap', enabled: true, api_key: 'fixture-key',
    base_url: 'http://127.0.0.1:9', model: 'bootstrap-target', wire_api: 'responses' };
  try {
    mod._state.store = { claude: [], codex: [provider] };
    mod._state.slotMap = { claude: {}, codex: {} };
    mod._state.current = { claude: '@router', codex: null };
    const inspection = await api('/api/onboarding/codex');
    assert.equal(inspection.status, 200);
    assert.equal(inspection.body.codex_plan.ok, true);
    assert.deepEqual(inspection.body.codex_plan.bootstrap, ['main', 'reviewer']);
    assert.equal(inspection.body.codex_plan.slots.find(slot => slot.name === 'main').model, provider.model);
    assert.equal(JSON.stringify(inspection.body).includes(provider.api_key), false);
    const strict = await api('/api/onboarding/codex/preview', { slots: true });
    assert.equal(strict.status, 400);
    const preview = await api('/api/onboarding/codex/preview', {});
    assert.equal(preview.status, 200);
    assert.ok(preview.body.warnings.some(warning => /自动补齐.*main.*reviewer/.test(warning)));
    assert.deepEqual(mod._state.slotMap.codex, {}, '预览不改变路由槽位');
    const applied = await api('/api/onboarding/codex/apply', { token: preview.body.token, confirm: true });
    assert.equal(applied.status, 200);
    const key = change => `${change.field}=${JSON.stringify(change.after ?? null)}`;
    assert.deepEqual(applied.body.changed.map(key).sort(), preview.body.changes.map(key).sort());
    assert.deepEqual(mod._state.slotMap.codex, { main: { provider: provider.id }, reviewer: { provider: provider.id } });
    const undoPreview = await api('/api/onboarding/codex/undo-preview', {});
    assert.equal(undoPreview.body.can_undo, true);
    assert.equal((await api('/api/onboarding/codex/undo', { token: undoPreview.body.token, confirm: true })).status, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), 'model = "legacy-bootstrap"\n');
    assert.deepEqual(mod._state.slotMap.codex, { main: { provider: provider.id }, reviewer: { provider: provider.id } });
  } finally {
    mod._state.store = saved.store;
    mod._state.slotMap = saved.slots;
    mod._state.current = saved.current;
  }
});
test('在途计数与尝试状态只读入口可用', async () => {
  assert.equal((await api('/api/state')).body.active_requests, 0);
  const traces = await api('/api/attempts');
  assert.equal(traces.status, 200);
  assert.ok(Array.isArray(traces.body.requests));
  const keys = await api('/api/keys/health');
  assert.equal(keys.status, 200);
  assert.ok(Array.isArray(keys.body.keys));
});
