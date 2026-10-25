'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-harness-pool-api-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);
Object.assign(process.env, {
  HOME, MIXR_DATA_DIR: TMP, DSH_HOME: path.join(HOME, '.dsh'),
  MIXR_CLAUDE_SETTINGS: path.join(HOME, 'claude.json'),
  MIXR_CODEX_CONFIG: path.join(HOME, 'codex.toml'),
  MIXR_ZCODE_CONFIG: path.join(HOME, 'zcode.json'),
  MIXR_HARNESS_PROFILE: path.join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
  MIXROUTER_PORT: '0', MIXUI_PORT: '0', MIXROUTER_ALT_PORTS: '',
  MIXR_RESPONSE_ARCHIVE: 'off', MIXR_SSE_KEEPALIVE_MS: '0', MIXR_LOG_RETAIN_DAYS: '0',
});
const mod = require('../mixrouter');
let ui;
const profilePath = process.env.MIXR_HARNESS_PROFILE;
const credentialPath = path.join(process.env.DSH_HOME, '.credentials.yaml');
const beforeProfile = '- id: llm-pi-ai\n  config:\n    providers:\n      fixture-native:\n        api: anthropic-messages\n        apiKeyEnv: OTHER_API_KEY\n        baseURL: https://native.invalid\n        models:\n          - id: original-model\n- id: tools\n  config:\n    mode: native\n- id: agent-default-model\n  config:\n    provider: fixture-native\n    model: original-model\n';
const managedProfile = beforeProfile + '- id: subagent-model-selection-settings\n  config:\n    enabled: false\n    allowedModels: []\n';
const beforeCredentials = 'version: 1\nrefs:\n  OTHER_API_KEY: "fixture-private-existing"\nrecords:\n  fixture/account:\n    kind: grant\n    payload:\n      token: fixture-account-token\n';
function request(endpoint, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: ui.address().port, path: endpoint,
      method, agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, data: text ? JSON.parse(text) : null }); });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Harness API fixture timeout')));
    req.on('error', reject); req.end(data);
  });
}
before(async () => {
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, managedProfile, { mode: 0o600 });
  fs.writeFileSync(credentialPath, beforeCredentials, { mode: 0o600 });
  mod._state.store = { claude: [{ id: 'fixture', name: 'Fixture channel', models: ['fixture-model'],
    enabled: true, base_url: 'https://upstream.invalid', api_key: 'fixture-upstream-hidden' }], codex: [] };
  ui = await mod.listen(0, mod.apiHandler);
});
after(async () => {
  if (ui) await new Promise(resolve => { ui.closeAllConnections(); ui.close(resolve); });
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('console read/save/preview expose only two business fields and perform no profile writes', async () => {
  const read = await request('/api/harness');
  assert.equal(read.status, 200);
  assert.ok(!read.text.includes('fixture-upstream-hidden'));
  const saved = await request('/api/harness', 'PUT', { main: { provider: 'fixture', model: 'fixture-model' }, pool: [], expected_revision: read.data.revision });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.data.pool.length, 1);
  const preview = await request('/api/harness/preview', 'POST', { expected_revision: saved.data.revision });
  assert.equal(preview.status, 200, preview.text);
  assert.ok(!preview.text.includes('fixture-private-existing'));
  assert.ok(!preview.text.includes('fixture-account-token'));
  assert.equal(fs.readFileSync(profilePath, 'utf8'), managedProfile);
  assert.equal(fs.readFileSync(credentialPath, 'utf8'), beforeCredentials);
});

test('HTTP connect explicitly confirms current pool and profile fingerprints then preserves native settings', async () => {
  const state = (await request('/api/harness')).data;
  const preview = (await request('/api/harness/preview', 'POST', { expected_revision: state.revision })).data;
  const base = { expected_revision: state.revision, expected_profile_revision: preview.profile_revision };
  assert.equal((await request('/api/harness/connect', 'POST', base)).status, 400);
  assert.equal((await request('/api/harness/connect', 'POST', { ...base, confirm: true, expected_profile_revision: 'stale' })).status, 409);
  const connected = await request('/api/harness/connect', 'POST', { ...base, confirm: true });
  assert.equal(connected.status, 200, connected.text);
  assert.equal(connected.data.state.client.status, 'connected');
  const profile = fs.readFileSync(profilePath, 'utf8');
  assert.ok(profile.includes('      fixture-native:\n        api: anthropic-messages\n        apiKeyEnv: OTHER_API_KEY\n        baseURL: https://native.invalid\n        models:\n          - id: original-model\n'));
  assert.ok(profile.includes('- id: tools\n  config:\n    mode: native\n'));
  const credential = fs.readFileSync(credentialPath, 'utf8');
  assert.ok(credential.includes('  OTHER_API_KEY: "fixture-private-existing"'));
  assert.ok(credential.includes('records:\n  fixture/account:\n    kind: grant\n    payload:\n      token: fixture-account-token\n'));
  for (const file of [profilePath, credentialPath, connected.data.backup.profile, connected.data.backup.credentials])
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(connected.data.backup.profile, 'utf8'), managedProfile);
  assert.equal(fs.readFileSync(connected.data.backup.credentials, 'utf8'), beforeCredentials);
  for (const secret of ['fixture-upstream-hidden', 'fixture-private-existing', 'fixture-account-token']) assert.ok(!connected.text.includes(secret));
  assert.ok(!profile.includes('fixture-upstream-hidden'));
});

test('HTTP preview followed by external credential or profile changes returns 409 without overwrite', async () => {
  const state = (await request('/api/harness')).data;
  const preview = (await request('/api/harness/preview', 'POST', { expected_revision: state.revision })).data;
  fs.appendFileSync(credentialPath, '# external credential edit\n');
  const before = fs.readFileSync(profilePath, 'utf8');
  assert.equal((await request('/api/harness/connect', 'POST', { confirm: true, expected_revision: state.revision,
    expected_profile_revision: preview.profile_revision })).status, 409);
  assert.equal(fs.readFileSync(profilePath, 'utf8'), before);
  const next = (await request('/api/harness/preview', 'POST', { expected_revision: state.revision })).data;
  fs.appendFileSync(profilePath, '# external profile edit\n');
  assert.equal((await request('/api/harness/connect', 'POST', { confirm: true, expected_revision: state.revision,
    expected_profile_revision: next.profile_revision })).status, 409);
  assert.ok(fs.readFileSync(profilePath, 'utf8').endsWith('# external profile edit\n'));
});

test('HTTP rejects legacy dispatch policy and whole config expressions without evaluating them', async () => {
  const state = (await request('/api/harness')).data;
  for (const extra of [{ owner: 'old-manager' }, { taskType: 'planner' }, { fixedPreset: 'worker' }, { maxDepth: 4 }])
    assert.equal((await request('/api/harness', 'PUT', { main: state.main, pool: state.pool, expected_revision: state.revision, ...extra })).status, 400);
  const text = '- id: llm-pi-ai\n  config: !!js "process.exit(99)"\n';
  fs.writeFileSync(profilePath, text);
  const preview = await request('/api/harness/preview', 'POST', { expected_revision: state.revision });
  assert.equal(preview.status, 409, preview.text);
  assert.equal(fs.readFileSync(profilePath, 'utf8'), text);
});
