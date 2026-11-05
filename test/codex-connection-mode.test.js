'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const config = require('../lib/codex-config');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-codex-mode-'));
const file = path.join(root, 'config.toml');
const providersFile = path.join(root, 'providers.json');
const slotsFile = path.join(root, 'slots.json');
const catalogFile = path.join(root, 'mixrouter-model-catalog.json');
const sourceFile = path.join(root, 'mixrouter-model-catalog.source.json');
const claudeFile = path.join(root, 'claude.json');
process.env.MIXR_DATA_DIR = root;
process.env.MIXR_CODEX_CONFIG = file;
process.env.MIXR_CLAUDE_SETTINGS = claudeFile;
const router = require('../mixrouter');
let ui;

const native = { id: 'native', name: 'Native', base_url: 'https://native.example/prefix',
  api_key: 'fixture-native-secret', model: 'real-main', models: ['real-main', 'real-alt'],
  enabled: true, wire_api: 'responses' };
const other = { ...native, id: 'other', name: 'Other', api_key: 'fixture-other-secret', model: 'other-main' };
const chat = { ...native, id: 'chat', name: 'Chat', model: 'chat-main', wire_api: 'chat' };
const realModel = { slug: 'real-main', visibility: 'hide', context_window: 1000000,
  default_reasoning_level: 'ultra', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'ultra' }],
  service_tiers: ['priority'], base_instructions: 'Preserve the current model instructions' };
const claudeText = '{"env":{"ANTHROPIC_MODEL":"untouched"}}\n';
const initial = () => `model = "mixr-main"
review_model = "mixr-reviewer"
model_provider = "mixr-router"
model_reasoning_effort = "ultra"
service_tier = "fast"
approval_policy = "never"
[model_providers.mixr-router]
base_url = "${router.ROUTER_URL}/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "${router.ROUTER_TOKEN}"
[memories]
extract_model = "mixr-main"
consolidation_model = "mixr-reviewer"
max_raw_memories_for_global = 256
[mcp_servers.kept]
command = "keep"
`;
const request = (endpoint, body, method = 'POST') => new Promise((resolve, reject) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  const req = http.request({ hostname: '127.0.0.1', port: ui.address().port, path: endpoint, method,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('error', reject);
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
  });
  req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
  req.on('error', reject);
  req.end(text);
});
const diskStore = () => JSON.parse(fs.readFileSync(providersFile, 'utf8'));
const snapshot = () => ({
  store: structuredClone(router._state.store), current: structuredClone(router._state.current),
  slots: structuredClone(router._state.slotMap),
  files: Object.fromEntries([file, providersFile, slotsFile, catalogFile, sourceFile, claudeFile]
    .map(name => [path.basename(name), fs.existsSync(name) ? fs.readFileSync(name, 'utf8') : null])),
});

before(async () => { ui = await router.listen(0, router.apiHandler); });
beforeEach(() => {
  for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  router._state.store = { claude: [{ ...native, id: 'claude', models: ['claude-main'] }],
    codex: structuredClone([native, other, chat]) };
  router._state.current = { claude: null, codex: '@router' };
  router._state.slotMap = { claude: {}, codex: {
    main: { provider: 'other', model: 'old-main' }, reviewer: { provider: 'other', model: 'review-only' },
  } };
  router._state.routes = { rules: [] };
  router._state.sessions.clear();
  fs.writeFileSync(file, initial());
  fs.writeFileSync(claudeFile, claudeText);
  fs.writeFileSync(providersFile, JSON.stringify({ version: 2, current: router._state.current, ...router._state.store }, null, 2) + '\n');
  fs.writeFileSync(slotsFile, JSON.stringify({ version: 1, ...router._state.slotMap }, null, 2) + '\n');
});
after(async () => {
  await new Promise(resolve => { ui.close(resolve); ui.closeAllConnections(); });
  fs.rmSync(root, { recursive: true, force: true });
});

test('Codex provider POST/PUT persists optional connection mode without rewriting the client', async () => {
  const client = fs.readFileSync(file, 'utf8');
  for (const codex_mode of [undefined, 'direct', 'router']) {
    const created = await request('/api/providers', { app: 'codex', name: 'Created',
      base_url: native.base_url, api_key: 'fixture-created-secret', model: 'created-model',
      ...(codex_mode === undefined ? {} : { codex_mode }) });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.id;
    assert.equal(diskStore().codex.find(p => p.id === id).codex_mode, codex_mode);
    for (const mode of ['router', 'direct']) {
      assert.equal((await request(`/api/providers/${id}`, { codex_mode: mode }, 'PUT')).status, 200);
      assert.equal((await request(`/api/providers/${id}`, { note: 'kept mode' }, 'PUT')).status, 200);
      assert.equal(diskStore().codex.find(p => p.id === id).codex_mode, mode);
      const state = await request('/api/state', undefined, 'GET');
      assert.equal(state.body.providers.codex.find(p => p.id === id).codex_mode, mode);
    }
  }
  assert.equal(fs.readFileSync(file, 'utf8'), client);
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), claudeText);
});

test('Codex invalid modes and direct Chat are rejected before provider or client mutation', async () => {
  const before = snapshot();
  for (const codex_mode of ['', 'auto', null, false, 1, {}, [], 'direct']) {
    const wire_api = codex_mode === 'direct' ? 'chat' : 'responses';
    const created = await request('/api/providers', { app: 'codex', ...native, wire_api, codex_mode });
    assert.equal(created.status, 400, JSON.stringify({ codex_mode, body: created.body }));
    const updated = await request('/api/providers/native', { name: 'must not persist', wire_api, codex_mode }, 'PUT');
    assert.equal(updated.status, 400, JSON.stringify(updated.body));
    assert.deepEqual(snapshot(), before);
  }
  assert.equal((await request('/api/providers', { ...native, app: 'claude', codex_mode: 'router' })).status, 400);
  assert.equal((await request('/api/providers/claude', { codex_mode: 'direct' }, 'PUT')).status, 400);
  assert.deepEqual(snapshot(), before);
  assert.equal((await request('/api/providers/native', { codex_mode: 'direct' }, 'PUT')).status, 200);
  const direct = snapshot();
  assert.equal((await request('/api/providers/native', { wire_api: 'chat' }, 'PUT')).status, 400);
  assert.deepEqual(snapshot(), direct, 'changing only the wire must validate the saved mode');
  assert.equal((await request('/api/providers/native', { wire_api: 'chat', codex_mode: 'router' }, 'PUT')).status, 200);
  assert.equal(diskStore().codex.find(p => p.id === 'native').codex_mode, 'router');
});

test('Codex switch mode overrides saved mode and binds the selected provider to the router main slot', async () => {
  assert.equal((await request('/api/providers/native', { codex_mode: 'direct' }, 'PUT')).status, 200);
  const reviewer = structuredClone(router._state.slotMap.codex.reviewer);
  const result = await request('/api/switch/native', { mode: 'router' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.live.connection_mode, 'router');
  assert.equal(result.body.live.direct_provider_id, '');
  assert.equal(result.body.live.match, true);
  assert.equal(result.body.live.service_tier, 'fast');
  assert.equal(diskStore().current.codex, '@router');
  assert.deepEqual(router._state.slotMap.codex.main, { provider: 'native', model: 'real-main' });
  assert.deepEqual(router._state.slotMap.codex.reviewer, reviewer);
  assert.deepEqual(JSON.parse(fs.readFileSync(slotsFile, 'utf8')).codex, router._state.slotMap.codex);
  assert.equal(router.resolveRoute('mixr-main', {}, 'codex').provider.id, 'native');
  assert.equal(router.resolveRoute('mixr-main', {}, 'codex').model, 'real-main');
  assert.equal(router.resolveRoute('mixr-reviewer', {}, 'codex').model, 'review-only');
  assert.equal(config.read(file).document.get('model'), 'mixr-main');
  assert.equal(config.read(file).document.get('review_model'), 'mixr-reviewer');
  assert.equal(diskStore().codex.find(p => p.id === 'native').codex_mode, 'direct', 'an override does not edit the saved preference');
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), claudeText);
});

test('Codex switch uses saved mode and protocol defaults, while explicit direct overrides router', async () => {
  let result = await request('/api/switch/native', {});
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.live.connection_mode, 'direct');
  assert.equal(diskStore().current.codex, 'native');
  assert.equal((await request('/api/providers/native', { codex_mode: 'router' }, 'PUT')).status, 200);
  result = await request('/api/switch/native', {});
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.live.connection_mode, 'router');
  result = await request('/api/switch/native', { mode: 'direct' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.live.connection_mode, 'direct');
  assert.equal(result.body.live.direct_provider_id, 'native');
  assert.equal(result.body.live.direct_provider_name, 'Native');
  assert.equal(result.body.live.match, true);
  result = await request('/api/switch/chat', {});
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.live.connection_mode, 'router');
  assert.equal(router._state.slotMap.codex.main.provider, 'chat');
  assert.equal(router.resolveRoute('mixr-main', {}, 'codex').model, 'chat-main');
});

test('Codex switch rejects invalid modes, direct Chat and Claude mode without writes', async () => {
  const before = snapshot();
  for (const mode of ['', 'auto', null, false, 1, {}, []]) {
    assert.equal((await request('/api/switch/native', { mode })).status, 400);
    assert.deepEqual(snapshot(), before);
  }
  assert.equal((await request('/api/switch/chat', { mode: 'direct' })).status, 400);
  assert.equal((await request('/api/switch/claude', { mode: 'router' })).status, 400);
  assert.deepEqual(snapshot(), before);
});

test('Codex live mode follows the handwritten endpoint despite stale current and identifies the matching key', async () => {
  const handwritten = `model = "real-main"
model_provider = "custom"
service_tier = "fast"
[model_providers.custom]
base_url = "${config.baseURL(native.base_url)}/"
wire_api = "responses"
experimental_bearer_token = "${native.api_key}"
`;
  for (const [text, mode, id] of [
    [handwritten, 'direct', 'native'],
    [handwritten.replace(native.api_key, other.api_key), 'direct', 'other'],
    [handwritten.replace(native.api_key, 'unregistered-secret'), 'direct', ''],
    [handwritten + 'env_key = "CUSTOM_KEY"\n', 'direct', ''],
    [handwritten + 'requires_openai_auth = true\n', 'direct', ''],
    [handwritten.replace('wire_api = "responses"', 'wire_api = "chat"'), 'direct', ''],
    [handwritten.replace(`${config.baseURL(native.base_url)}/`, `${router.ROUTER_URL}/v1`), 'router', ''],
    ['', 'unconfigured', ''],
    ['model = invalid\n', 'unconfigured', ''],
  ]) {
    fs.writeFileSync(file, text);
    const before = snapshot();
    const result = await request('/api/state', undefined, 'GET');
    assert.equal(result.status, 200);
    const live = result.body.live.codex;
    assert.equal(result.body.current.codex, '@router');
    assert.equal(live.connection_mode, mode);
    assert.equal(live.direct_provider_id, id);
    assert.equal(live.direct_provider_name, id ? (id === 'native' ? 'Native' : 'Other') : '');
    assert.equal(live.service_tier, text.startsWith('model = "real-main"') ? 'fast' : '');
    assert.equal(live.match, false);
    assert.equal(JSON.stringify(live).includes(native.api_key), false);
    assert.deepEqual(snapshot(), before, 'reading live state must not repair or rewrite files');
  }
});

test('Codex direct keeps current real-model metadata and cleans memory aliases without a source sidecar', async () => {
  const entries = [realModel, { ...realModel, slug: 'real-alt' }, { ...realModel, slug: 'other-main' },
    { ...realModel, slug: 'mixr-main', visibility: 'list', x_mixrouter: { target: 'real-main' } }];
  fs.writeFileSync(catalogFile, JSON.stringify({ revision: 'current-metadata', models: entries }));
  fs.writeFileSync(file, 'model_catalog_json = "mixrouter-model-catalog.json"\n' + initial());
  const result = await request('/api/switch/native', { mode: 'direct' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const document = config.read(file).document;
  assert.equal(document.get('model_catalog_json'), 'mixrouter-model-catalog.json');
  assert.equal(document.get('model'), 'real-main');
  assert.equal(document.get('review_model'), 'real-main');
  assert.equal(document.get('memories', 'extract_model'), 'real-main');
  assert.equal(document.get('memories', 'consolidation_model'), 'real-main');
  assert.equal(document.get('memories', 'max_raw_memories_for_global'), 256);
  assert.equal(document.get('mcp_servers', 'kept', 'command'), 'keep');
  assert.equal(document.get('model_reasoning_effort'), 'ultra');
  assert.equal(document.get('service_tier'), 'fast');
  const kept = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  assert.equal(kept.revision, 'current-metadata');
  assert.deepEqual(kept.models, entries.filter(model => !model.slug.startsWith('mixr-')).map(model => ({ ...model,
    visibility: native.models.includes(model.slug) ? 'list' : 'hide',
    ...(native.models.includes(model.slug) ? { supported_in_api: true } : {}) })));
  assert.equal(result.body.live.main.context_window, 1000000);
  assert.deepEqual(result.body.live.main.reasoning_levels, ['high', 'ultra']);
  assert.equal(JSON.parse(fs.readFileSync(sourceFile, 'utf8')).source, null);
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), claudeText);
});

test('Codex direct model edits save real main/reviewer independently without changing provider or slots', async () => {
  await request('/api/switch/native', { mode: 'direct' });
  const previous = snapshot();
  const save = fields => request('/api/codex/config', {
    action: 'direct_models', revision: config.read(file).revision, ...fields,
  });
  let result = await save({ review_model: 'unregistered-reviewer' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.codex.model, 'real-main');
  assert.equal(result.body.codex.review_model, 'unregistered-reviewer');
  assert.ok(result.body.codex.model_options.includes('unregistered-reviewer'));
  assert.equal(result.body.runtime, undefined, 'reviewer is a saved default, not a live main-model switch');
  result = await save({ model: 'unregistered-main' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.codex.model, 'unregistered-main');
  assert.equal(result.body.codex.review_model, 'unregistered-reviewer');
  assert.equal(result.body.codex.connection_mode, 'direct');
  assert.equal(result.body.runtime.status, 'not_running', 'saving config alone must not claim a hot switch');
  assert.equal(result.body.codex.direct_provider_id, 'native');
  const entries = JSON.parse(fs.readFileSync(catalogFile, 'utf8')).models;
  assert.deepEqual(entries.filter(m => m.visibility === 'list').map(m => m.slug),
    ['real-main', 'real-alt', 'unregistered-reviewer', 'unregistered-main']);
  assert.ok(entries.every(m => !m.slug.startsWith('mixr-')));
  assert.equal(entries.find(m => m.slug === 'unregistered-main').context_window, undefined);
  result = await save({ review_model: null });
  assert.equal(result.status, 200);
  assert.equal(config.read(file).document.get('review_model'), undefined);
  assert.equal(config.read(file).document.get('model'), 'unregistered-main');
  assert.equal(config.read(file).document.get('service_tier'), 'fast');
  assert.equal(config.read(file).document.get('model_reasoning_effort'), 'ultra');
  assert.deepEqual(snapshot().store, previous.store);
  assert.deepEqual(snapshot().slots, previous.slots);
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), claudeText);
});

test('Codex direct edits reject aliases, invalid fields, stale revision and routed/profile configs without writes', async () => {
  const body = { action: 'direct_models', model: 'valid', revision: config.read(file).revision };
  assert.equal((await request('/api/codex/config', body)).status, 400);
  await request('/api/switch/native', { mode: 'direct' });
  for (const fields of [{}, { model: '' }, { model: null }, { model: 'has spaces' },
    { model: 'mixr-main' }, { review_model: 'mixr-reviewer' }, { review_model: [] },
    { model: 'new', revision: 'stale' }]) {
    const before = snapshot();
    const result = await request('/api/codex/config', {
      action: 'direct_models', revision: config.read(file).revision, ...fields,
    });
    assert.equal(result.status, fields.revision ? 409 : 400, JSON.stringify(result.body));
    assert.deepEqual(snapshot(), before);
  }
  fs.writeFileSync(file, 'profile = "ci"\n' + fs.readFileSync(file, 'utf8'));
  const before = snapshot();
  const result = await request('/api/codex/config', {
    action: 'direct_models', model: 'new', revision: config.read(file).revision,
  });
  assert.equal(result.status, 400);
  assert.deepEqual(snapshot(), before);
});

test('Codex direct catalog sync keeps active real models and never recreates router aliases', async () => {
  fs.writeFileSync(catalogFile, JSON.stringify({ models: [realModel] }));
  fs.writeFileSync(file, 'model_catalog_json = "mixrouter-model-catalog.json"\n' + initial());
  await request('/api/switch/native', { mode: 'direct' });
  const result = await request('/api/codex/config', {
    action: 'sync_catalog', revision: config.read(file).revision,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.codex.model, 'real-main');
  assert.ok(JSON.parse(fs.readFileSync(catalogFile, 'utf8')).models.every(m => !m.slug.startsWith('mixr-')));
  assert.equal((await request('/api/switch/native', { mode: 'router' })).status, 200);
  const routed = JSON.parse(fs.readFileSync(catalogFile, 'utf8')).models.find(m => m.slug === 'mixr-main');
  assert.equal(routed.context_window, realModel.context_window);
  assert.deepEqual(routed.supported_reasoning_levels, realModel.supported_reasoning_levels);
  assert.equal((await request('/api/switch/native', { mode: 'direct' })).status, 200);
  assert.ok(JSON.parse(fs.readFileSync(catalogFile, 'utf8')).models.every(m => !m.slug.startsWith('mixr-')));
  assert.equal(JSON.parse(fs.readFileSync(catalogFile, 'utf8')).models.find(m => m.slug === 'real-main').context_window,
    realModel.context_window);
});

test('Codex direct preserves custom memory models and the namespace of dotted memory keys', async () => {
  for (const dotted of [false, true]) {
    const memories = dotted
      ? 'memories.extract_model = "mixr-main"\nmemories.consolidation_model = "custom-memory"\n'
      : '';
    const text = initial().replace('[memories]\nextract_model = "mixr-main"\nconsolidation_model = "mixr-reviewer"\nmax_raw_memories_for_global = 256\n',
      dotted ? '' : '[memories]\nextract_model = "mixr-main"\nconsolidation_model = "custom-memory"\n');
    fs.writeFileSync(file, memories + text.replace('review_model = "mixr-reviewer"', 'review_model = "custom-review"'));
    const result = await request('/api/switch/native', { mode: 'direct' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const document = config.read(file).document;
    assert.equal(document.get('memories', 'extract_model'), 'real-main');
    assert.equal(document.get('memories', 'consolidation_model'), 'custom-memory');
    assert.equal(document.get('extract_model'), undefined);
    assert.equal(document.get('review_model'), 'custom-review');
  }
});

test('Codex switch rolls back persisted current, slots and client files when a replacement fails', async () => {
  for (const mode of ['router', 'direct']) {
    if (mode === 'direct') {
      fs.writeFileSync(catalogFile, JSON.stringify({ models: [realModel] }));
      fs.writeFileSync(file, 'model_catalog_json = "mixrouter-model-catalog.json"\n' + initial());
    }
    const before = snapshot();
    const target = mode === 'router' ? slotsFile : catalogFile;
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === target) throw new Error('fixture replacement failure');
      return rename(from, to);
    };
    let result;
    try { result = await request('/api/switch/native', { mode }); }
    finally { fs.renameSync = rename; }
    assert.equal(result.status, 500, JSON.stringify(result.body));
    assert.deepEqual(snapshot(), before);
  }
});
