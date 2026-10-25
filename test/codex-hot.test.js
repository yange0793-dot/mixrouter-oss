'use strict';
// 热改用同一监听与同一 session-id 验证,所有客户端文件与上游均在临时目录。
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const config = require('../lib/codex-config');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-codex-hot-'));
const file = path.join(root, 'config.toml');
process.env.MIXR_DATA_DIR = root;
process.env.MIXR_CODEX_CONFIG = file;
process.env.MIXR_CLAUDE_SETTINGS = path.join(root, 'claude.json');
const router = require('../mixrouter');
let ui, proxy, upstream;
const hits = [];
const request = (server, endpoint, body, method = 'POST', headers = {}) => new Promise((resolve, reject) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: endpoint, method,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers } }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
  });
  req.on('error', reject); req.end(text);
});
const put = codex => request(ui, '/api/slots', { codex }, 'PUT');
const initial = () => `model = "old-native"
review_model = "old-review"
model_provider = "mixr-router"
model_reasoning_effort = "high"
approval_policy = "never"
sandbox_mode = "workspace-write"
[model_providers.mixr-router]
name = "Local"
base_url = "${router.ROUTER_URL}/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "${router.ROUTER_TOKEN}"
request_max_retries = 6
[mcp_servers.kept]
command = "keep"
`;
const catalogFile = path.join(root, 'mixrouter-model-catalog.json');
const catalog = () => JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
const activeSlots = () => ({ main: { provider: 'native', model: 'target-a' }, reviewer: { provider: 'native', model: 'target-r' } });
before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      hits.push({ url: req.url, body });
      const response = req.url.includes('/chat/completions')
        ? { id: 'mock', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
        : { id: 'mock', object: 'response', model: body.model, output: [], usage: { input_tokens: 1, output_tokens: 1 } };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  ui = await router.listen(0, router.apiHandler);
  proxy = await router.listen(0, router.proxyHandler);
});
beforeEach(() => {
  hits.length = 0;
  for (const name of ['config.toml', 'mixrouter-model-catalog.json', 'mixrouter-model-catalog.source.json', 'slots.json', 'providers.json']) {
    try { fs.unlinkSync(path.join(root, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  fs.writeFileSync(file, initial());
  fs.writeFileSync(process.env.MIXR_CLAUDE_SETTINGS, '{"env":{"ANTHROPIC_MODEL":"keep"}}\n');
  const base = `http://127.0.0.1:${upstream.address().port}`;
  router._state.store = { claude: [{ id: 'claude', name: 'Claude', api_key: 'k', base_url: base, models: ['claude-target'] }],
    codex: [{ id: 'native', name: 'Native', api_key: 'n', base_url: base, model: 'target-a', enabled: true, wire_api: 'responses' },
      { id: 'chat', name: 'Chat', api_key: 'c', base_url: base, model: 'chat-default', enabled: true, wire_api: 'chat' }] };
  router._state.slotMap = { claude: {}, codex: {} };
  router._state.current = { claude: null, codex: '@router', zcode: null };
  router._state.routes = { rules: [], default: { provider: 'native', model: 'ordinary-fallback' } };
  router._state.sessions.clear();
});
after(async () => {
  await Promise.all([ui, proxy, upstream].map(server => new Promise(resolve => server.close(resolve))));
  fs.rmSync(root, { recursive: true, force: true });
});

test('Codex PUT automatically synchronizes aliases/catalog and preserves unrelated configuration', async () => {
  const originalClaude = fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8');
  const result = await put({ ...activeSlots(), worker: { provider: 'chat', model: 'worker-target' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.live.codex.model, 'mixr-main');
  assert.equal(result.body.live.codex.hot_routing.enabled, true);
  assert.deepEqual(result.body.live.codex.hot_routing.legacy_models, { 'old-native': 'mixr-main', 'old-review': 'mixr-reviewer' });
  assert.equal(result.body.live.codex.hot_routing.native_picker_refresh, 'next-client');
  const document = config.read(file).document;
  assert.equal(document.get('review_model'), 'mixr-reviewer');
  assert.equal(document.get('model_reasoning_effort'), 'high');
  assert.equal(document.get('approval_policy'), 'never');
  assert.equal(document.get('sandbox_mode'), 'workspace-write');
  assert.equal(document.get('model_providers', 'mixr-router', 'request_max_retries'), 6);
  assert.equal(document.get('mcp_servers', 'kept', 'command'), 'keep');
  assert.equal(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'), originalClaude);
  assert.deepEqual(catalog().models.map(model => [model.slug, model.display_name]), [
    ['mixr-main', 'target-a · main'], ['mixr-reviewer', 'target-r · reviewer'], ['mixr-worker', 'worker-target · worker']]);
  assert.equal(result.body.live.codex.main.context_window, null);
  assert.deepEqual(result.body.live.codex.main.reasoning_levels, []);
});

test('Codex same native Responses session observes model and provider hot edits without applying', async () => {
  assert.equal((await put(activeSlots())).status, 200);
  const send = model => request(proxy, '/v1/responses', { model, input: 'hello', stream: false }, 'POST', { 'session-id': 'hot-same-session' });
  let result = await send('mixr-main');
  assert.equal(result.status, 200); assert.equal(hits.at(-1).body.model, 'target-a');
  assert.equal((await put({ main: { provider: 'native', model: 'target-b' } })).status, 200);
  result = await send('mixr-main');
  assert.equal(result.headers['x-mixrouter-model'], 'target-b'); assert.equal(hits.at(-1).body.model, 'target-b');
  assert.equal((await put({ main: { provider: 'chat', model: 'target-c' } })).status, 200);
  result = await send('mixr-main');
  assert.equal(result.status, 200); assert.equal(hits.at(-1).url, '/v1/chat/completions'); assert.equal(hits.at(-1).body.model, 'target-c');
  const direct = await request(proxy, '/v1/chat/completions', { model: 'mixr-main', messages: [{ role: 'user', content: 'hi' }] }, 'POST', { 'session-id': 'hot-same-session' });
  assert.equal(direct.status, 200); assert.equal(hits.at(-1).body.model, 'target-c');
  assert.equal(catalog().models.find(model => model.slug === 'mixr-main').display_name, 'target-c · main');
});

test('Native Codex sessions retaining the exact previous default hot-route after migration; unrelated clients and models do not', async () => {
  const headers = { 'session-id': 'old-native-session', 'user-agent': 'codex_cli_rs/0.162.1', authorization: 'Bearer ' + router.ROUTER_TOKEN };
  const send = (model, extra = {}) => request(proxy, '/v1/responses', { model, input: 'hi', stream: false }, 'POST', { ...headers, ...extra });
  assert.equal((await send('old-native')).headers['x-mixrouter-model'], 'ordinary-fallback');
  assert.equal((await put(activeSlots())).status, 200);
  assert.equal((await send('old-native')).headers['x-mixrouter-model'], 'target-a');
  assert.equal((await put({ main: { provider: 'chat', model: 'next-hot-model' } })).status, 200);
  assert.equal((await send('old-native')).headers['x-mixrouter-model'], 'next-hot-model');
  assert.equal(hits.at(-1).url, '/v1/chat/completions');
  assert.equal((await send('old-review')).headers['x-mixrouter-model'], 'target-r');
  for (const [model, extra] of [['unrelated-native', {}], ['old-native', { authorization: 'Bearer external' }],
    ['old-native', { 'user-agent': 'openai-python/1.0' }], ['old-native', { 'session-id': '' }]]) {
    assert.equal((await send(model, extra)).headers['x-mixrouter-model'], 'ordinary-fallback');
  }
  router._state.current.codex = 'native';
  assert.equal((await send('old-native')).headers['x-mixrouter-model'], 'ordinary-fallback');
  router._state.current.codex = '@router';
  fs.writeFileSync(file, 'profile = "other"\n' + fs.readFileSync(file, 'utf8'));
  assert.equal((await send('old-native')).headers['x-mixrouter-model'], 'ordinary-fallback');
});

test('Codex default provider edits synchronize inherited catalog but never change explicit slot or provider defaults', async () => {
  assert.equal((await put({ main: { provider: 'native' }, reviewer: { provider: 'native', model: 'explicit-review' } })).status, 200);
  const result = await request(ui, '/api/providers/native', { model: 'next-default' }, 'PUT');
  assert.equal(result.status, 200);
  assert.equal(router.resolveRoute('mixr-main', {}, 'codex').model, 'next-default');
  assert.equal(router.resolveRoute('mixr-reviewer', {}, 'codex').model, 'explicit-review');
  assert.equal(catalog().models.find(model => model.slug === 'mixr-main').display_name, 'next-default · main');
  assert.equal(router._state.slotMap.codex.main.model, undefined);
  assert.equal(router._state.store.codex[0].model, 'next-default');
});

test('Codex direct, absent, selected profile and credential-drift configurations are never hijacked', async () => {
  for (const text of [initial().replace('model_provider = "mixr-router"', 'model_provider = "openai"'), '', 'profile = "ci"\n' + initial(),
    initial().replace(router.ROUTER_TOKEN, 'external-token')]) {
    fs.writeFileSync(file, text);
    const result = await put(activeSlots());
    assert.equal(result.status, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.equal(fs.existsSync(catalogFile), false);
    assert.equal(result.body.live.codex.hot_routing.enabled, false);
  }
  fs.unlinkSync(file);
  assert.equal((await put(activeSlots())).status, 200); assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, 'model = invalid\n');
  assert.equal((await request(ui, '/api/slots', { claude: { main: { provider: 'claude', model: 'target' } } }, 'PUT')).status, 200);
  assert.equal(fs.readFileSync(file, 'utf8'), 'model = invalid\n');
  const before = structuredClone(router._state.slotMap);
  assert.equal((await put({ main: { provider: 'native', model: 'rejected' } })).status, 400);
  assert.deepEqual(router._state.slotMap, before);
});

test('Codex transactional sync restores catalog/config/slots on every atomic replacement failure', async () => {
  assert.equal((await put(activeSlots())).status, 200);
  for (const target of ['mixrouter-model-catalog.json', 'mixrouter-model-catalog.source.json', 'config.toml', 'slots.json']) {
    // 改回原生默认确保 config.toml 与 source 也真正有替换动作。
    fs.writeFileSync(file, initial());
    fs.writeFileSync(path.join(root, 'mixrouter-model-catalog.source.json'), '{"source":null,"external":true}\n');
    const files = ['config.toml', 'mixrouter-model-catalog.json', 'mixrouter-model-catalog.source.json', 'slots.json'];
    const before = Object.fromEntries(files.map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
    const slots = structuredClone(router._state.slotMap);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === path.join(root, target)) throw Object.assign(new Error('simulated'), { code: 'EIO' });
      return rename(from, to);
    };
    let result;
    try { result = await put({ main: { provider: 'native', model: 'changed' } }); }
    finally { fs.renameSync = rename; }
    assert.equal(result.status, 500, target);
    for (const name of files) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), before[name], name);
    assert.deepEqual(router._state.slotMap, slots);
  }
});

test('Codex router switch bootstraps stable aliases/catalog in one operation; failed creation removes new files', async () => {
  fs.writeFileSync(file, 'model = "own-model"\nmodel_reasoning_effort = "high"\n');
  const before = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === file) throw new Error('simulated');
    return rename(from, to);
  };
  try { assert.throws(() => router.switchCodexRouter(), /simulated/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(catalogFile), false);
  assert.equal(fs.existsSync(path.join(root, 'mixrouter-model-catalog.source.json')), false);
  assert.deepEqual(router._state.slotMap.codex, {});
  router.switchCodexRouter();
  assert.equal(config.read(file).document.get('model'), 'mixr-main');
  assert.equal(config.read(file).document.get('review_model'), 'mixr-reviewer');
  assert.equal(config.read(file).document.get('model_reasoning_effort'), 'high');
  assert.deepEqual(router._state.slotMap.codex, { main: { provider: 'native' }, reviewer: { provider: 'native' } });
});

test('Codex provider-edit write failure restores catalog, config and provider store', async () => {
  assert.equal((await put({ main: { provider: 'native' }, reviewer: { provider: 'native' } })).status, 200);
  fs.writeFileSync(path.join(root, 'providers.json'), JSON.stringify({ version: 2, current: router._state.current, ...router._state.store }, null, 2) + '\n');
  const before = Object.fromEntries(['config.toml', 'mixrouter-model-catalog.json', 'mixrouter-model-catalog.source.json', 'providers.json']
    .map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
  const store = structuredClone(router._state.store);
  fs.chmodSync(file, 0o644);
  fs.chmodSync(path.join(root, 'providers.json'), 0o644);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(root, 'providers.json')) throw new Error('simulated');
    return rename(from, to);
  };
  let result;
  try { result = await request(ui, '/api/providers/native', { model: 'rejected-default' }, 'PUT'); }
  finally { fs.renameSync = rename; }
  assert.equal(result.status, 500);
  assert.deepEqual(router._state.store, store);
  for (const [name, text] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), text, name);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644, '失败回滚必须保留原配置权限');
  assert.equal(fs.statSync(path.join(root, 'providers.json')).mode & 0o777, 0o644);
  assert.equal((await request(ui, '/api/providers/native', { model: 'accepted-default' }, 'PUT')).status, 200);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, '相同正文的凭据配置也必须收紧权限');
  assert.equal(fs.statSync(path.join(root, 'providers.json')).mode & 0o777, 0o600, '渠道库含明文 Key');
});

test('Codex direct switch restores original catalog selection, or removes source-less managed selection', async () => {
  assert.equal((await put(activeSlots())).status, 200);
  router.switchCodex(router._state.store.codex[0]);
  assert.equal(config.read(file).document.get('model_catalog_json'), undefined);
  fs.unlinkSync(catalogFile);
  fs.unlinkSync(path.join(root, 'mixrouter-model-catalog.source.json'));
  fs.writeFileSync(file, 'model_catalog_json = "source.json"\n' + initial());
  fs.writeFileSync(path.join(root, 'source.json'), JSON.stringify({ models: [] }));
  assert.equal((await put(activeSlots())).status, 200);
  router.switchCodex(router._state.store.codex[0]);
  assert.equal(config.read(file).document.get('model_catalog_json'), path.join(root, 'source.json'));
});

test('Codex deletion and disabled targets never fall through to ordinary fallback; removed aliases leave picker', async () => {
  assert.equal((await put(activeSlots())).status, 200);
  assert.equal((await put({ main: null })).status, 200);
  let result = await request(proxy, '/v1/responses', { model: 'mixr-main', input: 'hi' });
  assert.equal(result.status, 503); assert.equal(result.body.error.code, 'no_route_error'); assert.equal(hits.length, 0);
  assert.equal(catalog().models.some(model => model.slug === 'mixr-main'), false);
  result = await request(proxy, '/v1/responses', { model: 'old-native', input: 'hi' }, 'POST', {
    'session-id': 'old-removed', 'user-agent': 'codex_cli_rs/0.162.1', authorization: 'Bearer ' + router.ROUTER_TOKEN });
  assert.equal(result.status, 503); assert.equal(result.body.error.code, 'no_route_error');
  assert.equal((await request(ui, '/api/providers/native', { enabled: false }, 'PUT')).status, 200);
  result = await request(proxy, '/v1/responses', { model: 'mixr-reviewer', input: 'hi' });
  assert.equal(result.status, 503); assert.equal(result.body.error.code, 'provider_disabled_error');
  assert.equal(catalog().models.some(model => model.slug === 'mixr-reviewer'), false);
});
