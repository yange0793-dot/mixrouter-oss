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
  MIXR_ZCODE_CONFIG: path.join(home, 'zcode.json'), MIXR_RESPONSE_ARCHIVE: 'off' });
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
test('在途计数与尝试状态只读入口可用', async () => {
  assert.equal((await api('/api/state')).body.active_requests, 0);
  const traces = await api('/api/attempts');
  assert.equal(traces.status, 200);
  assert.ok(Array.isArray(traces.body.requests));
  const keys = await api('/api/keys/health');
  assert.equal(keys.status, 200);
  assert.ok(Array.isArray(keys.body.keys));
});
