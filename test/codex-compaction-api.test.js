'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-codex-compact-api-'));
const configFile = path.join(root, 'config.toml');
const claudeFile = path.join(root, 'claude.json');
process.env.MIXR_DATA_DIR = root;
process.env.MIXR_CODEX_CONFIG = configFile;
process.env.MIXR_CLAUDE_SETTINGS = claudeFile;
const router = require('../mixrouter');
const codex = require('../lib/codex-config');
const original = `# user configuration
model = "fixture-model"
review_model = "fixture-reviewer"
model_reasoning_effort = "high"
model_context_window = 500000
model_catalog_json = "catalog.json"
approval_policy = "never"
sandbox_mode = "workspace-write"

[model_providers.custom]
base_url = "https://fixture.example/v1"
experimental_bearer_token = "fixture-private-key"

[mcp_servers.test]
command = "node"
args = ["keep", "exact"]

[profiles.other]
model_auto_compact_token_limit = 100000
`;
const req = (port, method, data, headers = {}, endpoint = '/api/codex/config') => new Promise((resolve, reject) => {
  const text = data === undefined ? '' : JSON.stringify(data);
  const request = http.request({ hostname: '127.0.0.1', port, path: endpoint, method,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers } }, response => {
    let body = '';
    response.on('data', chunk => body += chunk);
    response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(body) }));
  });
  request.on('error', reject); request.end(text);
});
beforeEach(() => {
  fs.writeFileSync(configFile, original, { mode: 0o600 });
  fs.writeFileSync(claudeFile, '{"autoCompactWindow":256000,"keep":true}\n');
  fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ models: [{ slug: 'fixture-model',
    context_window: 400000, max_context_window: 600000, auto_compact_token_limit: 300000 }] }));
  router._state.store = { claude: [], codex: [] };
  router._state.current = { claude: '@router', codex: null, zcode: null };
  router._state.slotMap = { claude: {}, codex: {} };
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

async function serverFor(t) {
  const server = await router.listen(0, router.apiHandler);
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test('Codex threshold API saves only the selected key and reset restores original config', async t => {
  const port = await serverFor(t);
  const initial = await req(port, 'GET');
  assert.equal(initial.status, 200);
  assert.equal(initial.data.codex.compaction.default_limit, 300000);
  assert.equal(initial.data.codex.compaction.effective_limit, 300000);
  const body = { action: 'compact_threshold', model_auto_compact_token_limit: '250k', revision: initial.data.codex.revision };
  const filesBefore = new Map(['catalog.json', 'claude.json'].map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  const saved = await req(port, 'POST', body);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.codex.model_auto_compact_token_limit, 250000);
  assert.equal(saved.data.codex.compaction.effective_limit, 250000);
  assert.equal(saved.data.codex.compaction.restart_required, true);
  assert.equal(fs.readFileSync(configFile, 'utf8').replace('model_auto_compact_token_limit = 250000\n', ''), original);
  for (const [file, contents] of filesBefore) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), contents);
  assert.equal(codex.read(configFile).document.get('profiles', 'other', 'model_auto_compact_token_limit'), 100000);
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  const backups = fs.readdirSync(root).filter(file => file.startsWith('config.toml.bak-mixui-'));
  assert.ok(backups.length);
  assert.ok(backups.some(file => fs.readFileSync(path.join(root, file), 'utf8') === original));
  assert.equal((await req(port, 'POST', body)).status, 409);
  const capped = await req(port, 'POST', { ...body, model_auto_compact_token_limit: '0.5m', revision: saved.data.codex.revision });
  assert.equal(capped.status, 200);
  assert.equal(capped.data.codex.model_auto_compact_token_limit, 500000);
  assert.equal(capped.data.codex.compaction.effective_limit, 450000);
  assert.equal(capped.data.codex.compaction.capped, true);
  const reset = await req(port, 'POST', { ...body, model_auto_compact_token_limit: 'auto', revision: capped.data.codex.revision });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.codex.compaction.configured, null);
  assert.equal(reset.data.codex.compaction.effective_limit, 300000);
  assert.equal(fs.readFileSync(configFile, 'utf8'), original);
});

test('Codex threshold rejects invalid, stale, cross-site and non-object writes without touching config', async t => {
  const port = await serverFor(t);
  const version = codex.read(configFile).revision;
  const base = { action: 'compact_threshold', revision: version };
  for (const value of [undefined, '', '0', 0, -1, false, {}, [], 1.5, '1e6', '2.3tokens', Number.MAX_SAFE_INTEGER + 1]) {
    const result = await req(port, 'POST', { ...base, ...(value === undefined ? {} : { model_auto_compact_token_limit: value }) });
    assert.equal(result.status, 400, JSON.stringify(value));
    assert.equal(fs.readFileSync(configFile, 'utf8'), original);
  }
  const body = { ...base, model_auto_compact_token_limit: '250k' };
  assert.equal((await req(port, 'POST', body, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await req(port, 'POST', body, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await req(port, 'POST', [])).status, 400);
  assert.equal((await req(port, 'POST', { ...body, revision: 'stale' })).status, 409);
  assert.equal(fs.readFileSync(configFile, 'utf8'), original);
  const publicState = await req(port, 'GET', undefined, {}, '/api/state');
  assert.equal(publicState.data.live.codex.compaction.default_limit, 300000);
  assert.ok(!JSON.stringify(publicState.data.live.codex).includes('fixture-private-key'));
});

test('Codex threshold refuses selected profile and invalid TOML without overwriting either', async t => {
  const port = await serverFor(t);
  for (const text of ['profile = "other"\n' + original, 'model = "broken\n']) {
    fs.writeFileSync(configFile, text);
    const state = await req(port, 'GET');
    const result = await req(port, 'POST', { action: 'compact_threshold', model_auto_compact_token_limit: '250k',
      revision: state.data.codex.revision || codex.revision(text) });
    assert.equal(result.status, 400);
    assert.equal(fs.readFileSync(configFile, 'utf8'), text);
  }
});

test('Codex threshold atomic-write failure preserves original config and reports failure', async t => {
  const port = await serverFor(t);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === configFile) throw Object.assign(new Error('fixture write failure'), { code: 'EACCES' });
    return rename(from, to);
  };
  try {
    const response = await req(port, 'POST', { action: 'compact_threshold', model_auto_compact_token_limit: '250k',
      revision: codex.read(configFile).revision });
    assert.equal(response.status, 400);
    assert.match(response.data.error, /fixture write failure/);
    assert.equal(fs.readFileSync(configFile, 'utf8'), original);
    assert.equal(router.liveState().codex.compaction.configured, null);
    assert.equal(fs.readFileSync(claudeFile, 'utf8'), '{"autoCompactWindow":256000,"keep":true}\n');
  } finally { fs.renameSync = rename; }
});

test('Codex unknown window preserves explicit threshold through slot sync, without inventing capabilities', () => {
  const provider = { id: 'test-native', name: 'Fixture', model: 'unknown', enabled: true,
    base_url: 'https://fixture.example/v1', api_key: 'fixture-private-key', wire_api: 'responses' };
  router._state.store.codex = [provider];
  router._state.slotMap.codex = { main: { provider: provider.id }, reviewer: { provider: provider.id } };
  router.updateCodexConfig({ action: 'compact_threshold', model_auto_compact_token_limit: 220000,
    revision: codex.read(configFile).revision });
  router.switchCodexRouter();
  let live = router.liveState().codex;
  assert.equal(live.model_auto_compact_token_limit, 220000);
  assert.equal(live.model_context_window, 500000);
  assert.equal(live.model_reasoning_effort, 'high');
  router.updateCodexConfig({ action: 'sync_catalog', revision: live.revision });
  live = router.liveState().codex;
  assert.equal(live.model_auto_compact_token_limit, 220000);
  assert.equal(live.compaction.effective_limit, 220000);
  const file = codex.read(configFile);
  fs.writeFileSync(configFile, codex.patch(file.text, { top: { model_context_window: null } }));
  live = router.liveState().codex;
  assert.equal(live.compaction.context_window, null);
  assert.equal(live.compaction.default_limit, null);
  assert.equal(live.compaction.effective_limit, 220000);
  assert.ok(live.compaction.warnings.length);
});
