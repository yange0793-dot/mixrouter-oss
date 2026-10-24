'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHarnessConfig, parseLiteral, patchField, patchCredentials } = require('../lib/harness-config');

const BASE_PROFILE = '- id: llm-pi-ai\n- id: agent-default-model\n- id: subagent-model-selection-settings\n';
function fixture(t, text = BASE_PROFILE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-harness-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profilePath = path.join(dir, 'cordis.patch.yml');
  if (text.trim() !== '[]') {
    for (const id of ['llm-pi-ai', 'agent-default-model', 'subagent-model-selection-settings'])
      if (!text.includes('id: ' + id)) text += '- id: ' + id + (text.includes('\r\n') ? '\r\n' : '\n');
  }
  fs.writeFileSync(profilePath, text, { mode: 0o600 });
  const manager = createHarnessConfig({ profilePath, routerURL: 'http://127.0.0.1:19201', routerToken: 'fixture-router-secret' });
  const state = { main: { provider: 'fixture', model: 'fixture-model' }, pool: [] };
  const aliases = { main: 'mixr-harness-main', pool: [{ alias: 'mixr-harness-pool-first' }] };
  return { dir, profilePath, manager, state, aliases, original: text };
}

test('literal scoped patch retains native fields, comments, other providers and opaque expressions', t => {
  const before = `# profile note\n- id: llm-pi-ai\n  config:\n    providers:\n      ordinary:\n        api: openai-responses\n        baseURL: https://ordinary.invalid/v1\n        models:\n          - id: old-model\n    # keep this comment\n- id: agent-default-model\n  config:\n    provider: ordinary\n    model: old-model\n    reasoningEffort: high\n- id: tools\n  config:\n    mode: !!js process.env.DSH_TOOLS_MODE\n- id: workspace\n  config:\n    root: '/tmp/native-workspace'\n`;
  const f = fixture(t, before), preview = f.manager.preview(f.state, f.aliases);
  assert.equal(fs.readFileSync(f.profilePath, 'utf8'), f.original);
  assert.equal(fs.existsSync(path.join(f.dir, '.credentials.yaml')), false);
  assert.ok(!JSON.stringify(preview).includes('fixture-router-secret'));
  assert.ok(preview.changes.every(change => Object.hasOwn(change, 'before') && Object.hasOwn(change, 'after')));
  assert.equal(preview.changes.find(change => change.field === 'agent-default-model.config.provider').before, 'ordinary');
  assert.equal(preview.changes.find(change => change.field === 'agent-default-model.config.model').before, 'old-model');
  assert.equal(preview.changes.find(change => change.field.endsWith('.apiKeyEnv')).before, null);
  const result = f.manager.connect(f.state, f.aliases, preview.profile_revision);
  const text = fs.readFileSync(f.profilePath, 'utf8');
  assert.ok(text.includes('      ordinary:\n        api: openai-responses\n        baseURL: https://ordinary.invalid/v1\n        models:\n          - id: old-model\n'));
  assert.ok(text.includes('    # keep this comment'));
  assert.ok(text.includes('    reasoningEffort: high'));
  assert.ok(text.includes('- id: tools\n  config:\n    mode: !!js process.env.DSH_TOOLS_MODE\n'));
  assert.ok(text.includes("- id: workspace\n  config:\n    root: '/tmp/native-workspace'\n"));
  assert.match(text, /api: "anthropic-messages"/);
  assert.match(text, /baseURL: "http:\/\/127\.0\.0\.1:19201\/harness"/);
  assert.match(text, /apiKeyEnv: "MIXROUTER_HARNESS_API_KEY"/);
  assert.ok(!text.includes('fixture-router-secret'));
  assert.equal(fs.readFileSync(result.backup.profile, 'utf8'), f.original);
  for (const file of [result.backup.profile, f.profilePath, path.join(f.dir, '.credentials.yaml')])
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(f.manager.inspect(f.state, f.aliases).status, 'connected');
});

test('missing profile and missing native override rows reject connection without appending ineffective patches', t => {
  const f = fixture(t, '[]\n');
  assert.throws(() => f.manager.preview(f.state, f.aliases), { statusCode: 409 });
  assert.equal(fs.readFileSync(f.profilePath, 'utf8'), '[]\n');
  fs.unlinkSync(f.profilePath);
  assert.throws(() => f.manager.preview(f.state, f.aliases), { statusCode: 409 });
  assert.equal(fs.existsSync(f.profilePath), false);
  assert.equal(fs.existsSync(path.join(f.dir, '.credentials.yaml')), false);
});

test('private refs merge preserves records and unrelated refs verbatim', () => {
  const before = 'version: 1\nrefs:\n  OTHER_KEY: "other-fixture-secret"\nrecords:\n  native/account:\n    kind: grant\n    payload:\n      access: fixture-access\n';
  const after = patchCredentials(before, 'new-fixture-secret');
  assert.ok(after.includes('  OTHER_KEY: "other-fixture-secret"\n'));
  assert.ok(after.includes('records:\n  native/account:\n    kind: grant\n    payload:\n      access: fixture-access\n'));
  assert.match(after, /MIXROUTER_HARNESS_API_KEY: "new-fixture-secret"/);
});

test('whole config expression is rejected without eval or any file writes', t => {
  for (const body of ['!!js "({providers: {}})"', '!!js |\n    ({providers: {}})']) {
    const before = '- id: llm-pi-ai\n  config: ' + body + '\n';
    const f = fixture(t, before);
    assert.throws(() => f.manager.preview(f.state, f.aliases), { statusCode: 409 });
    assert.equal(fs.readFileSync(f.profilePath, 'utf8'), f.original);
    assert.deepEqual(fs.readdirSync(f.dir), ['cordis.patch.yml']);
  }
});

test('preview model before values redact nested secrets without echoing original connection URLs', t => {
  const text = '- id: llm-pi-ai\n  config:\n    providers:\n      mixrouter-harness:\n        apiKeyEnv: MIXROUTER_HARNESS_API_KEY\n        baseURL: "http://name:fixture-url-secret@localhost:19201/harness?token=fixture-query-secret"\n        models:\n          - id: original\n            headers:\n              authorization: fixture-header-secret\n            apiKey: fixture-model-secret\n';
  const f = fixture(t, text), preview = f.manager.preview(f.state, f.aliases);
  for (const secret of ['fixture-url-secret', 'fixture-query-secret', 'fixture-header-secret', 'fixture-model-secret'])
    assert.ok(!JSON.stringify(preview).includes(secret));
  assert.equal(preview.changes.find(change => change.field.endsWith('.baseURL')).before, 'http://localhost:19201/harness');
});

test('literal __jsExpr marker rejects config merging just like the native Loader', t => {
  const text = '- id: llm-pi-ai\n  config:\n    __jsExpr: "({providers:{}})"\n';
  const f = fixture(t, text);
  assert.throws(() => f.manager.preview(f.state, f.aliases), { statusCode: 409 });
  assert.equal(fs.readFileSync(f.profilePath, 'utf8'), f.original);
});

test('block scalar credential payloads remain intact and write failure restores only our credential edit', t => {
  const f = fixture(t);
  const credentialPath = path.join(f.dir, '.credentials.yaml');
  const before = 'version: 1\nrefs:\n  OTHER: |\n    a multi-line fixture secret\n    - id: llm-pi-ai\nrecords:\n  native/account:\n    kind: grant\n    payload:\n      token: native-fixture\n';
  fs.writeFileSync(credentialPath, before, { mode: 0o600 });
  const preview = f.manager.preview(f.state, f.aliases);
  const original = fs.renameSync;
  fs.renameSync = function (source, destination) {
    if (destination === f.profilePath) throw Object.assign(new Error('fixture write refusal'), { code: 'EIO' });
    return original.apply(this, arguments);
  };
  try { assert.throws(() => f.manager.connect(f.state, f.aliases, preview.profile_revision), { statusCode: 500 }); }
  finally { fs.renameSync = original; }
  assert.equal(fs.readFileSync(credentialPath, 'utf8'), before);
  assert.equal(fs.readFileSync(f.profilePath, 'utf8'), f.original);
  assert.ok(!fs.readdirSync(f.dir).some(name => name.endsWith('.lock')));
});

test('profile and credential external writes, lock contention and unsafe modes refuse connection', t => {
  const f = fixture(t), preview = f.manager.preview(f.state, f.aliases);
  fs.appendFileSync(f.profilePath, '# external\n');
  assert.throws(() => f.manager.connect(f.state, f.aliases, preview.profile_revision), { statusCode: 409 });
  const next = f.manager.preview(f.state, f.aliases);
  fs.writeFileSync(path.join(f.dir, '.credentials.yaml'), 'version: 1\nrefs: {}\nrecords: {}\n', { mode: 0o600 });
  assert.throws(() => f.manager.connect(f.state, f.aliases, next.profile_revision), { statusCode: 409 });
  const current = f.manager.preview(f.state, f.aliases);
  fs.writeFileSync(f.profilePath + '.lock', process.pid + '\n');
  assert.throws(() => f.manager.connect(f.state, f.aliases, current.profile_revision), { statusCode: 409 });
  assert.ok(fs.existsSync(f.profilePath + '.lock'));
  fs.chmodSync(path.join(f.dir, '.credentials.yaml'), 0o644);
  assert.throws(() => f.manager.preview(f.state, f.aliases), { statusCode: 403 });
});

test('symlink profile is refused and never replaced', t => {
  const f = fixture(t), real = path.join(f.dir, 'real.yml');
  fs.renameSync(f.profilePath, real); fs.symlinkSync(real, f.profilePath);
  assert.throws(() => f.manager.preview(f.state, f.aliases), { statusCode: 403 });
  assert.equal(fs.lstatSync(f.profilePath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(real, 'utf8'), f.original);
});

test('duplicates, flow configs, anchors and malformed indentation do not lose original content', () => {
  for (const text of [
    '- id: llm-pi-ai\n  config: {providers: {}}\n',
    '- id: llm-pi-ai\n  config: &config\n    providers: {}\n',
    '- id: llm-pi-ai\n  config:\n    providers: {}\n    providers: {}\n',
    '- id: llm-pi-ai\n  config:\n   providers: {}\n    bad: broken\n',
  ]) assert.throws(() => patchField(text, 'llm-pi-ai', ['config', 'providers', 'fixture', 'api'], 'anthropic-messages'), { statusCode: 409 });
  assert.throws(() => patchCredentials('version: 2\nrefs: {}\n', 'fixture'), { statusCode: 409 });
});

test('block scalar expression contents cannot create fake managed rows', () => {
  const text = '- id: unrelated\n  config:\n    script: !!js |\n      - id: llm-pi-ai\n        config: do-not-parse\n';
  const output = patchField(text, 'llm-pi-ai', ['config', 'providers', 'fixture', 'api'], 'anthropic-messages');
  assert.ok(output.startsWith(text));
  assert.equal(parseLiteral(output).items.length, 2);
});

test('existing inserted rows are updated in place, not duplicated', t => {
  const f = fixture(t, '- insert:\n    - id: agent-default-model\n      name: "@deepseek-ai/dsh-agent-default-model"\n      config:\n        provider: original\n        model: original\n');
  const preview = f.manager.preview(f.state, f.aliases);
  f.manager.connect(f.state, f.aliases, preview.profile_revision);
  const text = fs.readFileSync(f.profilePath, 'utf8');
  assert.equal((text.match(/id: agent-default-model/g) || []).length, 1);
  assert.ok(text.includes('        provider: "mixrouter-harness"'));
});

test('installed YAML/native schemas and Anthropic SDK validate synthetic connection when available', async t => {
  const install = '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules';
  if (!fs.existsSync(path.join(install, 'yaml/package.json'))) { t.skip('optional installed Harness is unavailable'); return; }
  const { pathToFileURL } = require('node:url');
  const yaml = require(path.join(install, 'yaml'));
  const native = await import(pathToFileURL(path.join(install, '@deepseek-ai/dsh-llm-pi-ai/lib/index.js')).href);
  const selection = await import(pathToFileURL(path.join(install, '@deepseek-ai/dsh-tool-subagent/lib/model-selection-settings.js')).href);
  const boot = await import(pathToFileURL(path.join(install, '@deepseek-ai/dsh-app-boot/lib/index.js')).href);
  const f = fixture(t), preview = f.manager.preview(f.state, f.aliases);
  f.manager.connect(f.state, f.aliases, preview.profile_revision);
  const rows = yaml.parse(fs.readFileSync(f.profilePath, 'utf8'));
  const config = rows.find(row => row.id === 'llm-pi-ai').config;
  assert.doesNotThrow(() => native.Config(config));
  assert.doesNotThrow(() => selection.SubagentModelSelectionConfig.Config(rows.find(row => row.id === 'subagent-model-selection-settings').config));
  const names = { 'llm-pi-ai': '@deepseek-ai/dsh-llm-pi-ai', 'agent-default-model': '@deepseek-ai/dsh-agent-default-model',
    'subagent-model-selection-settings': '@deepseek-ai/dsh-tool-subagent/model-selection-settings' };
  const warnings = [];
  assert.deepEqual(boot.composeEntries([rows], message => warnings.push(message)), []);
  assert.equal(warnings.length, 3, 'modify-only rows do not mount missing plugins');
  const composed = boot.composeEntries([[{ insert: Object.entries(names).map(([id, name]) => ({ id, name })) }], rows]);
  assert.equal(composed.length, 3);
  assert.equal(composed.find(row => row.id === 'llm-pi-ai').config.providers['mixrouter-harness'].api, 'anthropic-messages');
  assert.equal(composed.find(row => row.id === 'subagent-model-selection-settings').config.enabled, true);
  const credential = yaml.parse(fs.readFileSync(path.join(f.dir, '.credentials.yaml'), 'utf8'));
  assert.equal(credential.version, 1);
  assert.equal(credential.refs.MIXROUTER_HARNESS_API_KEY, 'fixture-router-secret');
  const Anthropic = require(path.join(install, '@anthropic-ai/sdk')).default;
  let actualURL;
  const client = new Anthropic({ apiKey: 'fixture-only', baseURL: config.providers['mixrouter-harness'].baseURL, maxRetries: 0,
    fetch: async url => { actualURL = String(url); return new Response(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant',
      model: 'mixr-harness-main', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } }); },
  });
  await client.messages.create({ model: 'mixr-harness-main', max_tokens: 1, messages: [{ role: 'user', content: 'fixture' }] });
  assert.equal(actualURL, 'http://127.0.0.1:19201/harness/v1/messages');
});

test('CRLF preserved and explicit credential path used without replacing credential settings', t => {
  const f = fixture(t), credentialPath = path.join(f.dir, 'private.yaml');
  const before = `- id: credentials\r\n  config:\r\n    path: ${JSON.stringify(credentialPath)}\r\n    watch: false\r\n- id: tools\r\n  disabled: true\r\n`;
  fs.writeFileSync(f.profilePath, before + BASE_PROFILE.replace(/\n/g, '\r\n'));
  const preview = f.manager.preview(f.state, f.aliases);
  f.manager.connect(f.state, f.aliases, preview.profile_revision);
  assert.ok(fs.readFileSync(f.profilePath, 'utf8').startsWith(before));
  assert.ok(!fs.readFileSync(f.profilePath, 'utf8').replace(/\r\n/g, '').includes('\n'));
  assert.ok(fs.existsSync(credentialPath));
  assert.equal(fs.existsSync(path.join(f.dir, '.credentials.yaml')), false);
});
