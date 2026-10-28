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
const nativeContext = () => ({ session: 'cx:preview-same-session', ua: 'codex_desktop/0.162.1', token: router.ROUTER_TOKEN });
const nativeSend = (model, headers = {}, input = 'preview task') => request(proxy, '/v1/responses', { model, input, stream: false },
  'POST', { 'session-id': 'preview-same-session', 'user-agent': 'codex_desktop/0.162.1',
    authorization: 'Bearer ' + router.ROUTER_TOKEN, ...headers });
// 没有兜底路由之后,"认不出的 Codex 旧 ID / 缺上下文的请求"的正确答案是明确失败:
// 503 no_route_error,且一个字节都不发上游。
const expectNoRoute = (result, label) => {
  assert.equal(result.status, 503, `${label}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error.code, 'no_route_error', String(label));
};
// 预览侧的同一条事实:{ok:false, no_route_error, 503},没有"某个默认目标"可预测。
const expectPreviewNoRoute = (result, label) => {
  assert.equal(result.ok, false, `${label}: ${JSON.stringify(result.selection)}`);
  assert.equal(result.error.code, 'no_route_error', String(label));
  assert.equal(result.error.httpStatus, 503, String(label));
  assert.equal(result.matched.via, 'model', String(label));
};
async function previewMatchesResolver(model, context) {
  const input = { app: 'codex', model, kind: 'responses', ...(context === undefined ? {} : { context }) };
  const direct = router.explainRoute(input);
  const result = await request(ui, '/api/routing/preview', input);
  assert.equal(result.status, direct.ok ? 200 : direct.error.httpStatus);
  assert.deepEqual(result.body, direct, 'HTTP preview must return the production explainer result');
  const truth = router.resolveRoute(model, { ...context,
    compactTexts: Array.isArray(context?.compactTexts) ? () => context.compactTexts : undefined,
    bodyText: context?.bodyText ? () => context.bodyText : undefined }, 'codex');
  // via 就是 resolver 的 stage:compact / slot / model(旧的 content/rule/default 已删除)
  assert.equal(direct.matched.via, truth.stage || 'model');
  assert.equal(direct.matched.ruleId, truth.rule?.id || null);
  assert.equal(direct.matched.slot, truth.slot || null);
  assert.deepEqual(direct.candidates.map(member => [member.providerId, member.model]),
    truth.members.map(member => [member.provider.id, member.model]));
  return direct;
}
function fileSnapshot(dir = root, prefix = '') {
  return fs.readdirSync(dir).sort().flatMap(name => {
    const full = path.join(dir, name), relative = path.join(prefix, name), stat = fs.statSync(full);
    return stat.isDirectory() ? fileSnapshot(full, relative)
      : [{ file: relative, text: fs.readFileSync(full, 'utf8'), mode: stat.mode, mtime: stat.mtimeMs }];
  });
}
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
  router._state.current = { claude: null, codex: '@router' };
  // 瘦身后没有可配置的兜底路由:既没命中槽位、也没有唯一登记模型的请求一律 503,
  // 不会再被悄悄送到某个"默认渠道 + 默认模型"。
  router._state.routes = { rules: [] };
  router._state.sessions.clear();
  router._state.cooldowns = {};
  router._state.resetPools();
});
after(async () => {
  await Promise.all([ui, proxy, upstream].map(server => new Promise(resolve => server.close(resolve))));
  fs.rmSync(root, { recursive: true, force: true });
});

test('Codex legacy preview is credential-safe and leaves production state, diagnostics, files and upstream untouched', async () => {
  assert.equal((await put(activeSlots())).status, 200);
  router._state.sessions.set('cx:stale-preview', Object.freeze({ providerId: 'native', lastUsed: 0 }));
  router._state.cooldowns = { native: 0 };
  router._state.resetPools();
  router._state.pools['slot:codex/main'] = 7;
  router._state.pools.__w_preview = [{ provider: { id: 'chat' }, weight: 2, current: 5 }];
  const state = () => JSON.stringify({ sessions: [...router._state.sessions], cooldowns: router._state.cooldowns,
    pools: router._state.pools, slots: router._state.slotMap, store: router._state.store, routes: router._state.routes });
  const before = state(), files = fileSnapshot();
  const logs = (await request(ui, '/api/logs?limit=50', undefined, 'GET')).body.logs;
  const attempts = (await request(ui, '/api/attempts', undefined, 'GET')).body.requests;
  assert.deepEqual(logs, [], 'this preview-only case must run before any real proxy request');
  assert.deepEqual(attempts, []);
  for (const model of ['old-native', 'old-review', 'old-native']) {
    const result = await previewMatchesResolver(model, nativeContext());
    assert.equal(result.ok, true);
    assert.equal(result.matched.slot, model === 'old-review' ? 'reviewer' : 'main');
    const text = JSON.stringify(result);
    for (const hidden of [router.ROUTER_TOKEN, nativeContext().ua, nativeContext().session, 'api_key', 'base_url']) {
      assert.equal(text.includes(hidden), false, 'preview must not echo request credentials, raw UA or private configuration');
    }
  }
  assert.equal(state(), before, 'preview must not prune, bind, touch, rotate or rewrite live state');
  assert.deepEqual(fileSnapshot(), files, 'preview must not create or rewrite logs, sessions or client configuration');
  assert.deepEqual((await request(ui, '/api/logs?limit=50', undefined, 'GET')).body.logs, logs);
  assert.deepEqual((await request(ui, '/api/attempts', undefined, 'GET')).body.requests, attempts);
  assert.equal(hits.length, 0, 'preview must not contact upstream');
});

test('Codex legacy main/reviewer preview follows production resolver and native HTTP across hot slot edits', async () => {
  // 槽位还没建、旧 ID 也还没进 legacy_models:没有兜底目标,只有明确失败。
  expectPreviewNoRoute(await previewMatchesResolver('old-native', nativeContext()), 'before any slot exists');
  assert.equal((await put(activeSlots())).status, 200);
  const compare = async (model, expected, slot, ua = nativeContext().ua) => {
    const result = await previewMatchesResolver(model, { ...nativeContext(), ua });
    assert.equal(result.matched.via, 'slot');
    assert.equal(result.matched.slot, slot);
    assert.equal(result.selection.predicted.model, expected);
    const actual = await nativeSend(model, { 'user-agent': ua });
    assert.equal(actual.status, 200);
    assert.equal(actual.headers['x-mixrouter-model'], expected);
    assert.equal(actual.headers['x-mixrouter-provider'], result.selection.predicted.providerName);
    assert.equal(router._state.sessions.has(nativeContext().session), true, 'native session-id must normalize to the preview cx: identity');
    assert.equal(hits.at(-1).body.model, expected);
  };
  await compare('old-native', 'target-a', 'main');
  await compare('old-review', 'target-r', 'reviewer');
  assert.equal((await put({ main: { provider: 'native', model: 'preview-main-b' },
    reviewer: { provider: 'chat', model: 'preview-review-b' } })).status, 200);
  await compare('old-review', 'preview-review-b', 'reviewer');
  assert.equal(hits.at(-1).url, '/v1/chat/completions');
  for (const ua of ['codex_desktop/0.162.1', 'codex_cli_rs/0.162.1', 'codex_exec/0.162.1', 'codex/0.162.1', 'codex 0.162.1']) {
    await compare('old-native', 'preview-main-b', 'main', ua);
  }
  assert.equal(hits.at(-1).url, '/v1/responses');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'mixrouter-model-catalog.source.json'), 'utf8')).legacy_models,
    { 'old-native': 'mixr-main', 'old-review': 'mixr-reviewer' }, 'hot edits must not register new or fuzzy legacy IDs');
});

test('Codex legacy preview only maps the exact legacy ID with full native context; nothing else falls back', async () => {
  assert.equal((await put(activeSlots())).status, 200);
  // 正向对照:同一份快照下,旧 ID 在完整原生上下文里就是 main 槽位。
  const mapped = await previewMatchesResolver('old-native', nativeContext());
  assert.equal(mapped.matched.via, 'slot');
  assert.equal(mapped.matched.slot, 'main');
  assert.equal(mapped.selection.predicted.model, 'target-a');
  // 其余一律明确失败:没有通用 match 规则、没有默认渠道、没有模糊匹配。
  const cases = [
    ['old-native-extra', {}, {}], ['OLD-NATIVE', {}, {}], ['unknown-native-id', {}, {}],
    ['old-native', { token: '' }, { authorization: '' }],
    ['old-native', { token: 'wrong-local-token' }, { authorization: 'Bearer wrong-local-token' }],
    ['old-native', { session: 'cxf:fingerprint-preview' }, { 'session-id': '' }],
    ...['codex_desktop_evil/0.162.1', 'codex_other/0.162.1', 'codex_desktop', 'openai-python/1.0']
      .map(ua => ['old-native', { ua }, { 'user-agent': ua }]),
  ];
  for (const [model, patch, headers] of cases) {
    const label = JSON.stringify([model, patch]);
    const result = await previewMatchesResolver(model, { ...nativeContext(), ...patch });
    assert.equal(result.matched.slot, null, model + ': incomplete or unrelated context must not become native');
    expectPreviewNoRoute(result, label);
    expectNoRoute(await nativeSend(model, headers), label);
  }
  const fingerprint = router.sessionIdentity({ headers: {} }, { input: 'preview task' }, 'codex');
  assert.match(fingerprint.key, /^cxf:/);
  // 内容指纹身份不是原生 session-id:旧 ID 同样不认。
  expectPreviewNoRoute(await previewMatchesResolver('old-native', { ...nativeContext(), session: fingerprint.key }), 'fingerprint identity');
  for (const context of [undefined, {}, { session: nativeContext().session },
    { ...nativeContext(), session: '' }, { ...nativeContext(), ua: '' }, { ...nativeContext(), token: undefined },
    { ...nativeContext(), session: 'preview-same-session' }, { ...nativeContext(), session: 'cc:preview-same-session' }]) {
    expectPreviewNoRoute(await previewMatchesResolver('old-native', context), JSON.stringify(context));
  }
  const noContext = await request(ui, '/api/routing/preview', { app: 'codex', model: 'old-native' }, 'POST', {
    'session-id': 'preview-same-session', 'user-agent': nativeContext().ua, authorization: 'Bearer ' + router.ROUTER_TOKEN });
  assert.equal(noContext.body.ok, false, 'HTTP preview must not infer native context from its own transport headers');
  assert.equal(noContext.body.error.code, 'no_route_error');
});

test('Codex legacy preview refuses to guess when router management or catalog provenance is absent', async () => {
  assert.equal((await put(activeSlots())).status, 200);
  const managed = fs.readFileSync(file, 'utf8');
  for (const text of ['', 'profile = "other"\n' + managed,
    managed.replace(router.ROUTER_TOKEN, 'external-token'),
    managed.replace('model_catalog_json = "mixrouter-model-catalog.json"', 'model_catalog_json = "other.json"')]) {
    fs.writeFileSync(file, text);
    expectPreviewNoRoute(await previewMatchesResolver('old-native', nativeContext()), text.slice(0, 40));
    expectNoRoute(await nativeSend('old-native'), text.slice(0, 40));
  }
  fs.writeFileSync(file, managed);
  router._state.current.codex = 'native';
  expectPreviewNoRoute(await previewMatchesResolver('old-native', nativeContext()), 'not routing through mixrouter');
  router._state.current.codex = '@router';
  const sourceFile = path.join(root, 'mixrouter-model-catalog.source.json');
  const source = fs.readFileSync(sourceFile, 'utf8');
  fs.unlinkSync(sourceFile);
  expectPreviewNoRoute(await previewMatchesResolver('old-native', nativeContext()), 'source file missing');
  fs.writeFileSync(sourceFile, 'not-json');
  expectPreviewNoRoute(await previewMatchesResolver('old-review', nativeContext()), 'source file corrupt');
  fs.writeFileSync(sourceFile, source);
  fs.unlinkSync(file);
  expectPreviewNoRoute(await previewMatchesResolver('old-native', nativeContext()), 'client config missing');
});

test('Codex legacy preview preserves removed/disabled slot errors and compact-rule precedence', async () => {
  assert.equal((await put(activeSlots())).status, 200);
  const signature = require('../lib/routing/compact-signature');
  const compactText = signature.FIXED_PREFIX + 'Your task is to create a detailed summary of the conversation above.';
  router._state.routes.rules = [{ id: 'compact-before-legacy', app: 'codex', enabled: true,
    when: { body: signature.COMPACT_RULES[0].body }, provider: 'chat', model: 'content-target', pool: [], priority: -5 }];
  const content = await previewMatchesResolver('old-native', { ...nativeContext(), compactTexts: [compactText] });
  assert.equal(content.matched.via, 'compact');
  assert.equal(content.matched.ruleId, 'compact-before-legacy');
  assert.equal(content.selection.predicted.model, 'content-target');
  assert.equal((await nativeSend('old-native', {}, compactText)).headers['x-mixrouter-model'], 'content-target');
  router._state.routes.rules = [];
  assert.equal((await put({ main: null })).status, 200);
  const missing = await previewMatchesResolver('old-native', nativeContext());
  assert.equal(missing.ok, false);
  assert.equal(missing.matched.slot, 'main');
  assert.equal(missing.error.code, 'no_route_error');
  assert.equal(missing.error.httpStatus, 503);
  let count = hits.length;
  const removed = await nativeSend('old-native');
  assert.equal(removed.status, 503);
  assert.equal(removed.body.error.code, missing.error.code);
  assert.equal(hits.length, count);
  assert.equal((await request(ui, '/api/providers/native', { enabled: false }, 'PUT')).status, 200);
  const disabled = await previewMatchesResolver('old-review', nativeContext());
  assert.equal(disabled.ok, false);
  assert.equal(disabled.matched.slot, 'reviewer');
  assert.equal(disabled.error.code, 'provider_disabled_error');
  assert.equal(disabled.error.httpStatus, 503);
  count = hits.length;
  const actual = await nativeSend('old-review');
  assert.equal(actual.status, 503);
  assert.equal(actual.body.error.code, disabled.error.code);
  assert.equal(hits.length, count);
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

test('Native Codex sessions retain exactly the previous default hot-route after migration; unrelated clients and models never guess', async () => {
  const headers = { 'session-id': 'old-native-session', 'user-agent': 'codex_cli_rs/0.162.1', authorization: 'Bearer ' + router.ROUTER_TOKEN };
  const send = (model, extra = {}) => request(proxy, '/v1/responses', { model, input: 'hi', stream: false }, 'POST', { ...headers, ...extra });
  expectNoRoute(await send('old-native'), 'before migration: no slot, no registered model');
  assert.equal((await put(activeSlots())).status, 200);
  assert.equal((await send('old-native')).headers['x-mixrouter-model'], 'target-a');
  assert.equal((await put({ main: { provider: 'chat', model: 'next-hot-model' } })).status, 200);
  assert.equal((await send('old-native')).headers['x-mixrouter-model'], 'next-hot-model');
  assert.equal(hits.at(-1).url, '/v1/chat/completions');
  assert.equal((await send('old-review')).headers['x-mixrouter-model'], 'target-r');
  for (const [model, extra] of [['unrelated-native', {}], ['old-native', { authorization: 'Bearer external' }],
    ['old-native', { 'user-agent': 'openai-python/1.0' }], ['old-native', { 'session-id': '' }]]) {
    expectNoRoute(await send(model, extra), JSON.stringify([model, extra]));
  }
  router._state.current.codex = 'native';
  expectNoRoute(await send('old-native'), 'client switched to a native provider');
  router._state.current.codex = '@router';
  fs.writeFileSync(file, 'profile = "other"\n' + fs.readFileSync(file, 'utf8'));
  expectNoRoute(await send('old-native'), 'client config became an unmanaged profile');
});

test('Codex Desktop retains exact previous main/reviewer IDs and observes hot edits in the same native session', async () => {
  const headers = { 'session-id': 'desktop-same-session', 'user-agent': 'codex_desktop/0.162.1',
    authorization: 'Bearer ' + router.ROUTER_TOKEN };
  const send = (model, extra = {}) => request(proxy, '/v1/responses', { model, input: 'desktop task', stream: false },
    'POST', { ...headers, ...extra });
  expectNoRoute(await send('old-native'), 'before migration: no slot, no registered model');
  assert.equal((await put(activeSlots())).status, 200);
  assert.equal((await send('old-native')).headers['x-mixrouter-model'], 'target-a');
  assert.equal((await send('old-review')).headers['x-mixrouter-model'], 'target-r');
  assert.equal((await put({ main: { provider: 'native', model: 'desktop-main-b' },
    reviewer: { provider: 'chat', model: 'desktop-review-b' } })).status, 200);
  assert.equal((await send('old-native')).headers['x-mixrouter-model'], 'desktop-main-b');
  assert.equal((await send('old-review')).headers['x-mixrouter-model'], 'desktop-review-b');
  assert.equal(hits.at(-1).url, '/v1/chat/completions');
  assert.equal((await send('old-native')).headers['x-mixrouter-model'], 'desktop-main-b', 'reviewer must not capture the next main request');
  assert.equal(hits.at(-1).url, '/v1/responses');
  for (const ua of ['codex_cli_rs/0.162.1', 'codex_exec/0.162.1', 'codex/0.162.1', 'codex 0.162.1']) {
    assert.equal((await send('old-native', { 'user-agent': ua })).headers['x-mixrouter-model'], 'desktop-main-b', ua);
  }
  for (const [model, extra] of [['old-native-extra', {}], ['OLD-NATIVE', {}], ['unknown-desktop-model', {}],
    ['old-native', { authorization: 'Bearer wrong-local-token' }], ['old-native', { 'session-id': '' }],
    ...['codex_desktop_evil/0.162.1', 'codex_other/0.162.1', 'codex_desktop', 'openai-python/1.0']
      .map(ua => ['old-native', { 'user-agent': ua }])]) {
    expectNoRoute(await send(model, extra), JSON.stringify([model, extra]));
  }
  router._state.current.codex = 'native';
  expectNoRoute(await send('old-native'), 'client switched to a native provider');
  router._state.current.codex = '@router';
  fs.writeFileSync(file, 'profile = "desktop-other"\n' + fs.readFileSync(file, 'utf8'));
  expectNoRoute(await send('old-native'), 'client config became an unmanaged profile');
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
