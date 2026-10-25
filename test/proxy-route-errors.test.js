'use strict';
// 生产入口的本地拒绝:临时 HOME、真实 HTTP、零上游与会话/trace 副作用。
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createMockUpstream } = require('./mock-upstream');
const { LOG_FIELDS } = require('../lib/observability/request-log');
const { sessionKeyOf } = require('../lib/session/identity');
const { FIXED_PREFIX, COMPACT_RULES } = require('../lib/routing/compact-signature');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-route-errors-'));
process.env.HOME = path.join(TMP, 'home');
process.env.USERPROFILE = process.env.HOME;
process.env.MIXR_DATA_DIR = path.join(TMP, 'data');
process.env.MIXR_CLAUDE_SETTINGS = path.join(process.env.HOME, '.claude', 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(process.env.HOME, '.codex', 'config.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXR_RETRY_DELAY_MS = '0';
process.env.MIXR_MAX_ATTEMPTS = '1';
const LOG_FILE = path.join(process.env.MIXR_DATA_DIR, 'logs', 'requests.jsonl');
const PROVIDER_KEY = 'route-error-provider-key-AAAABBBBCCCC';
const CLIENT_KEY = 'route-error-client-key-DDDDEEEEFFFF';
const PROMPT = 'ROUTE-ERROR-BODY-SENTINEL-do-not-log';
const HEADER = 'ROUTE-ERROR-HEADER-SENTINEL-do-not-log';
const mock = createMockUpstream();
const mod = require('../mixrouter');
let proxy, ui, base;
const diskRows = () => fs.existsSync(LOG_FILE)
  ? fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const request = (server, endpoint, body, headers = {}, method = 'POST') => new Promise((resolve, reject) => {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: endpoint, method,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers } }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      resolve({ status: res.statusCode, headers: res.headers, text, body: JSON.parse(text || '{}'), disk: diskRows() });
    });
  });
  req.on('error', reject); req.end(text);
});
const api = endpoint => request(ui, endpoint, undefined, {}, 'GET');
const logsOf = async () => (await api('/api/logs?limit=500')).body.logs;
const tracesOf = async () => (await api('/api/attempts')).body.requests;
const codexBody = model => ({ model, input: PROMPT, stream: true });
const claudeBody = model => ({ model, max_tokens: 8, messages: [{ role: 'user', content: PROMPT }], stream: false });
const nativeHeaders = extra => ({ 'user-agent': 'codex_desktop/0.162.1', authorization: 'Bearer ' + mod.ROUTER_TOKEN,
  'session-id': 'native-route-error-session', 'x-test-private': HEADER, ...extra });
const diagnostic = (native, auth, reliable) => `[Codex identity: native=${native}, local_auth=${auth}, reliable_session=${reliable}]`;

before(async () => {
  await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${mock.server.address().port}`;
  ui = await mod.listen(0, mod.apiHandler);
  proxy = await mod.listen(0, mod.proxyHandler);
});
beforeEach(() => {
  mod._state.store = { claude: [{ id: 'claude', name: 'Claude mock', enabled: true, base_url: base,
    api_key: PROVIDER_KEY, models: ['claude-target'] }], codex: [{ id: 'codex', name: 'Codex mock', enabled: true,
    base_url: base, api_key: PROVIDER_KEY, model: 'codex-target', wire_api: 'responses' }] };
  mod._state.current = { claude: null, codex: null, zcode: null };
  mod._state.routes = { rules: [], default: { provider: '', model: '' } };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.sessions.clear(); mod._state.cooldowns = {}; mod._state.resetPools();
  mock.requests.length = 0;
});
after(async () => {
  await Promise.all([proxy, ui, mock.server].map(server => new Promise(resolve => server.close(resolve))));
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function rejected(endpoint, body, headers, status, type, expected = {}) {
  const before = { disk: diskRows().length, logs: (await logsOf()).length,
    sessions: structuredClone(mod._state.sessions), traces: await tracesOf(),
    cooldowns: structuredClone(mod._state.cooldowns), active: (await api('/api/state')).body.active_requests };
  const response = await request(proxy, endpoint, body, headers);
  assert.equal(response.status, status, response.text);
  const app = endpoint.includes('/messages') ? 'claude' : 'codex';
  if (app === 'codex') {
    assert.deepEqual(Object.keys(response.body), ['error']);
    assert.deepEqual(Object.keys(response.body.error).sort(), ['code', 'message', 'type']);
    assert.equal(response.body.error.code, type);
    assert.equal(response.body.error.type, type.replace(/_error$/, ''));
  } else {
    assert.deepEqual(Object.keys(response.body).sort(), ['error', 'type']);
    assert.equal(response.body.type, 'error');
    assert.deepEqual(Object.keys(response.body.error).sort(), ['message', 'type']);
    assert.equal(response.body.error.type, type);
  }
  assert.equal(typeof response.body.error.message, 'string');
  assert.equal(response.headers['content-type'], 'application/json');
  assert.equal(Number(response.headers['content-length']), Buffer.byteLength(response.text));
  assert.ok(!response.text.includes('[Codex identity:'), 'diagnostic must not change the client error message');
  assert.equal(response.disk.length, before.disk + 1, 'rejected entry must be on disk when the client receives its error');
  const logs = await logsOf();
  assert.equal(logs.length, before.logs + 1, 'one rejected request must append exactly one entry');
  const entry = logs[0];
  assert.deepEqual(entry, response.disk.at(-1), 'memory and disk must share the scrubbed entry');
  for (const key of Object.keys(entry)) assert.ok(LOG_FIELDS.includes(key), key);
  assert.equal(entry.app, app); assert.equal(entry.status, status); assert.equal(entry.err_class, type);
  assert.equal(entry.kind, endpoint.replace('/v1/', ''));
  assert.equal(entry.stream, !!body.stream);
  assert.equal(entry.bytes_in, Buffer.byteLength(JSON.stringify(body)));
  assert.equal(entry.model_in, body.model === PROVIDER_KEY ? '[redacted]' : body.model);
  for (const key of ['provider', 'model_out', 'request_id', 'key_id', 'key_source', 'slot', 'wire']) assert.equal(entry[key], '', key);
  for (const key of ['attempts', 'in', 'out', 'cache_read', 'pool', 'ttfb_ms']) assert.equal(entry[key], 0, key);
  assert.equal(entry.failover, false); assert.equal(entry.sticky, false);
  assert.ok(entry.ms >= 0); assert.ok(Number.isFinite(Date.parse(entry.ts)));
  const identity = mod.sessionIdentity({ headers }, body, app);
  assert.equal(entry.session, sessionKeyOf(identity.key)); assert.equal(entry.session_kind, identity.kind);
  assert.equal(entry.rule, '', 'failed preparation must not invent a resolved rule');
  for (const [key, value] of Object.entries(expected)) assert.equal(entry[key], value, key);
  const logged = JSON.stringify({ logs, disk: response.disk });
  for (const secret of [PROMPT, HEADER, PROVIDER_KEY, CLIENT_KEY, mod.ROUTER_TOKEN, 'codex_desktop/0.162.1']) {
    assert.ok(!logged.includes(secret), `request logs must not contain ${secret}`);
  }
  assert.deepEqual(mod._state.sessions, before.sessions, 'pre-attempt rejection must not create or change sessions');
  assert.deepEqual(await tracesOf(), before.traces, 'pre-attempt rejection must not create a trace');
  assert.deepEqual(mod._state.cooldowns, before.cooldowns);
  assert.equal((await api('/api/state')).body.active_requests, before.active);
  assert.equal(mock.requests.length, 0, 'local rejection must not reach upstream');
  return { response, entry };
}

test('no-route Codex Desktop error is synchronously logged with safe native/local/reliable diagnostics', async () => {
  const { entry, response } = await rejected('/v1/responses', codexBody('desktop-unrouted'), nativeHeaders(), 503, 'no_route_error');
  assert.ok(entry.err.startsWith(diagnostic(true, true, true)), entry.err);
  assert.match(response.body.error.message, /没有匹配的 Codex 渠道/);
  assert.equal(entry.session_kind, 'header');
});

test('no-route retry preserves an existing reliable session and its recorded usage/binding', async () => {
  mod._state.bindSession('cx:native-route-error-session', 'codex', { app: 'codex', reqs: 7, inTok: 31, outTok: 19,
    model: 'previous-real-model', pinned: true, actual: { providerId: 'codex', model: 'previous-real-model', status: 200 } });
  const { entry } = await rejected('/v1/responses', codexBody('retry-unrouted'), nativeHeaders(), 503, 'no_route_error');
  assert.ok(entry.err.startsWith(diagnostic(true, true, true)), entry.err);
});

test('Codex diagnostic booleans reflect exact UA/local token and reliable metadata versus fingerprints', async () => {
  const cases = [
    { headers: nativeHeaders({ authorization: 'Bearer ' + CLIENT_KEY }), native: true, auth: false, reliable: true },
    { headers: nativeHeaders({ authorization: '', 'x-api-key': mod.ROUTER_TOKEN }), native: true, auth: true, reliable: true },
    { headers: nativeHeaders({ 'user-agent': 'codex_desktop_evil/0.162.1' }), native: false, auth: true, reliable: true },
    { headers: nativeHeaders({ 'user-agent': 'codex_other/0.162.1' }), native: false, auth: true, reliable: true },
    { headers: nativeHeaders({ 'session-id': '' }), native: true, auth: true, reliable: false },
    { headers: nativeHeaders({ 'session-id': '' }), body: { prompt_cache_key: 'metadata-route-error-session' }, native: true, auth: true, reliable: true },
    { headers: nativeHeaders({ 'session-id': '' }), body: { client_metadata: { session_id: 'body-route-error-session' } }, native: true, auth: true, reliable: true },
  ];
  for (const item of cases) {
    const { entry } = await rejected('/v1/responses', { ...codexBody('unrouted'), ...item.body }, item.headers, 503, 'no_route_error');
    assert.ok(entry.err.startsWith(diagnostic(item.native, item.auth, item.reliable)), entry.err);
  }
});

for (const [name, body, headers] of [
  ['header', claudeBody('claude-unrouted'), { 'x-claude-code-session-id': 'claude-route-error-session' }],
  ['metadata', { ...claudeBody('claude-unrouted'), metadata: { user_id: JSON.stringify({ session_id: 'claude-meta-error-session' }) } }, {}],
  ['fingerprint', claudeBody('claude-unrouted'), {}],
]) test(`no-route Claude ${name} identity is logged without Codex diagnostics`, async () => {
  const { entry, response } = await rejected('/v1/messages', body, { authorization: 'Bearer ' + CLIENT_KEY, 'x-test-private': HEADER, ...headers }, 503, 'no_route_error');
  assert.equal(entry.session_kind, name);
  assert.equal(entry.err, response.body.error.message);
});

test('unknown slot does not guess a provider/model or start an attempt', async () => {
  const { entry } = await rejected('/v1/responses', codexBody('mixr-main'), nativeHeaders(), 503, 'no_route_error');
  assert.ok(entry.err.startsWith(diagnostic(true, true, true)), entry.err);
});

for (const app of ['claude', 'codex']) test(`disabled ${app} target records the local error, not an invented upstream attempt`, async () => {
  mod._state.store[app][0].enabled = false;
  mod._state.routes.default = { provider: app, model: 'never-forwarded' };
  const { entry } = await rejected(app === 'claude' ? '/v1/messages' : '/v1/responses',
    app === 'claude' ? claudeBody('disabled-model') : codexBody('disabled-model'),
    app === 'claude' ? { 'x-claude-code-session-id': 'disabled-claude-session' } : nativeHeaders(), 503, 'provider_disabled_error');
  assert.ok(!entry.err.includes('[Codex identity:'));
});

test('Codex chat/responses wire mismatch logs 400 and leaves routing/session/upstream untouched', async () => {
  mod._state.routes.default = { provider: 'codex', model: 'never-forwarded' };
  await rejected('/v1/chat/completions', { model: 'wire-mismatch', messages: [{ role: 'user', content: PROMPT }], stream: false },
    nativeHeaders(), 400, 'wire_api_mismatch_error');
});

test('unavailable compact key pin is logged before session creation or upstream access', async () => {
  mod._state.routes.rules = [{ id: 'compact-local-error', match: '', app: 'claude', enabled: true,
    when: { body: COMPACT_RULES[0].body }, priority: 90, provider: 'claude', model: 'never-forwarded', key_id: 'missing', pool: [] }];
  const body = claudeBody('compact-local-error');
  body.messages[0].content = FIXED_PREFIX + 'Your task is to create a detailed summary of the conversation so far.\n' + PROMPT;
  await rejected('/v1/messages', body, { 'x-claude-code-session-id': 'compact-error-session', 'x-test-private': HEADER },
    503, 'provider_key_unavailable_error');
});

test('provider and client keys accidentally sent as an unrouted model are scrubbed on the rejection path', async () => {
  const { entry, response } = await rejected('/v1/responses', codexBody(PROVIDER_KEY), nativeHeaders(), 503, 'no_route_error');
  assert.ok(response.text.includes(PROVIDER_KEY), 'client error keeps its original model text');
  assert.ok(entry.err.includes('[redacted]'));
  const body = codexBody(CLIENT_KEY);
  const count = diskRows().length;
  const result = await request(proxy, '/v1/responses', body, nativeHeaders({ authorization: 'Bearer ' + CLIENT_KEY }));
  assert.equal(result.status, 503); assert.equal(result.disk.length, count + 1);
  assert.equal(result.disk.at(-1).model_in, '[redacted]');
  assert.ok(!JSON.stringify(result.disk).includes(CLIENT_KEY), 'client credential is also scrubbed when copied into model/error');
});

for (const [name, endpoint, body, headers, status] of [
  ['invalid JSON', '/v1/responses', '{invalid', nativeHeaders(), 400],
  ['non-object JSON', '/v1/responses', '[]', nativeHeaders(), 400],
  ['cross-site', '/v1/responses', codexBody('unrouted'), nativeHeaders({ origin: 'https://example.invalid' }), 403],
  ['non-JSON', '/v1/responses', codexBody('unrouted'), nativeHeaders({ 'content-type': 'text/plain' }), 415],
  ['non-loopback Host', '/v1/responses', codexBody('unrouted'), nativeHeaders({ host: 'example.invalid' }), 403],
  ['unsupported endpoint', '/unsupported', codexBody('unrouted'), nativeHeaders(), 404],
]) test(`${name} remains outside the preparer-rejection logging path`, async () => {
  const count = diskRows().length;
  const traces = await tracesOf();
  const result = await request(proxy, endpoint, body, headers);
  assert.equal(result.status, status, result.text);
  assert.equal(result.disk.length, count);
  assert.equal((await logsOf()).length, count);
  assert.equal(mod._state.sessions.size, 0); assert.equal(mock.requests.length, 0);
  assert.deepEqual(await tracesOf(), traces);
  assert.equal((await api('/api/state')).body.active_requests, 0);
});

test('successful request after local rejection writes one normal log and one real trace without double logging', async () => {
  await rejected('/v1/responses', codexBody('retry-configured'), nativeHeaders(), 503, 'no_route_error');
  const count = diskRows().length; const traceCount = (await tracesOf()).length;
  mod._state.routes.default = { provider: 'codex', model: 'codex-target' };
  const result = await request(proxy, '/v1/responses', { ...codexBody('retry-configured'), stream: false }, nativeHeaders());
  assert.equal(result.status, 200, result.text); assert.equal(result.disk.length, count + 1);
  assert.equal((await logsOf()).length, count + 1);
  const entry = result.disk.at(-1);
  assert.equal(entry.attempts, 1); assert.equal(entry.provider, 'Codex mock'); assert.equal(entry.model_out, 'codex-target');
  assert.equal(entry.err, ''); assert.equal(entry.err_class, ''); assert.ok(entry.request_id);
  assert.equal(mock.requests.length, 1); assert.equal(mod._state.sessions.size, 1);
  assert.equal(mod._state.sessions.get('cx:native-route-error-session').reqs, 1);
  assert.equal((await tracesOf()).length, traceCount + 1);
  assert.equal((await api('/api/state')).body.active_requests, 0);
});
