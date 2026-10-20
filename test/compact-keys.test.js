'use strict';
// Compact account pinning: temporary state and real loopback HTTP only.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { FIXED_PREFIX, COMPACT_RULES } = require('../lib/routing/compact-signature');
const { normalizeRule } = require('../lib/routing/rules');
const compact = require('../lib/routing/compact');
const { resolveKey } = require('../lib/routing/keys');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-compact-keys-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXR_CONV_RETRIES = '1';
// 重试间隔默认 1s:测试要的是重试次数本身,不是真的等一秒
process.env.MIXR_RETRY_DELAY_MS = '0';
const mod = require('../mixrouter');
const ACTIVE = 'fixture-active-secret-value';
const COMPACT = 'fixture-compact-secret-value';
const SUMMARY = FIXED_PREFIX + 'Your task is to create a detailed summary of the conversation so far.';
const hits = [];
let ui, proxy, upstream, base, onHit;
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
function success(wire) {
  if (wire === 'chat') return 'data: ' + JSON.stringify({ id: 'mock', choices: [{ index: 0,
    delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';
  if (wire === 'responses') return event('response.completed', { type: 'response.completed', response: {
    id: 'mock', status: 'completed', output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'ok' }] }], usage: {} } });
  return event('message_start', { type: 'message_start', message: { id: 'mock', type: 'message', role: 'assistant', content: [], usage: {} } })
    + event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} })
    + event('message_stop', { type: 'message_stop' });
}
function request(port, route, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString();
        let data; try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode, data, text }); });
    });
    req.on('error', reject); req.end(data);
  });
}
const api = (method = 'GET', body, route = '/api/compact') => request(ui.address().port, route, method, body);
const send = (content = SUMMARY, stream = false) => request(proxy.address().port, '/v1/messages', 'POST',
  { model: 'mixr-main', max_tokens: 32, stream, messages: [{ role: 'user', content }] });
const choose = key_id => api('POST', { provider: 'primary', model: 'chosen', key_id });
const provider = () => mod._state.store.claude[0];
const makeRules = () => ({ rules: COMPACT_RULES.map(spec => ({ id: spec.kind, match: '', app: 'claude',
  enabled: true, provider: 'primary', model: 'chosen', priority: spec.priority, pool: [],
  when: { body: spec.body }, strategy: 'priority' })), default: { provider: 'primary', model: 'ordinary' } });

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks));
      hits.push({ body, headers: req.headers, url: req.url });
      if (onHit && onHit(req, res, body)) return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const wire = req.url.includes('chat/completions') ? 'chat' : req.url.includes('responses') ? 'responses' : 'anthropic';
      res.end(success(wire));
    });
  });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${upstream.address().port}`;
  ui = await mod.listen(0, mod.apiHandler); proxy = await mod.listen(0, mod.proxyHandler);
});
beforeEach(() => {
  fs.rmSync(path.join(TMP, 'routes.json'), { recursive: true, force: true });
  mod._state.store = { claude: [{ id: 'primary', name: 'Primary', enabled: true, base_url: base,
    api_key: ACTIVE, active_key: 'active', models: ['chosen'],
    keys: [{ id: 'active', label: 'Work', key: ACTIVE }, { id: 'compact', label: 'Summaries', key: COMPACT }] },
  { id: 'other', name: 'Other', enabled: true, base_url: base, api_key: 'fixture-other-secret', models: ['chosen'],
    keys: [{ id: 'compact', label: 'Other account', key: 'fixture-other-secret' }] }], codex: [] };
  mod._state.routes = makeRules();
  mod._state.slotMap = { claude: { main: { provider: 'primary', model: 'ordinary' } }, codex: {} };
  mod._state.cooldowns = {}; mod._state.sessions.clear(); mod._state.resetPools();
  hits.length = 0; onHit = null;
});

test('GET publishes IDs/labels/enabled only and exposes no secret or masked key', async () => {
  provider().keys[1].enabled = false;
  const r = await api();
  assert.equal(r.status, 200);
  assert.equal(r.data.compact.key_selection_supported, true);
  assert.deepEqual(r.data.compact.providers[0].keys, [
    { id: 'active', label: 'Work', enabled: true }, { id: 'compact', label: 'Summaries', enabled: false },
  ]);
  assert.equal(r.data.compact.providers[0].active_key, 'active');
  assert.equal(r.data.compact.selection.key_id, '');
  assert.equal(/secret|key_masked|api_key/.test(r.text), false);
});

for (const wire of ['anthropic', 'chat', 'responses']) test(`${wire}: compact pin changes real auth headers, not active/store or ordinary traffic`, async () => {
  provider().wire_api = wire;
  const before = structuredClone(mod._state.store);
  assert.equal((await choose('compact')).status, 200);
  for (const stream of [false, true]) {
    assert.equal((await send(SUMMARY, stream)).status, 200);
    const h = hits.at(-1).headers;
    assert.equal(h.authorization, 'Bearer ' + COMPACT);
    if (wire === 'anthropic') assert.equal(h['x-api-key'], COMPACT);
    assert.equal(hits.at(-1).body.model, 'chosen');
  }
  assert.equal((await send('ordinary task')).status, 200);
  assert.equal(hits.at(-1).headers.authorization, 'Bearer ' + ACTIVE);
  assert.equal(hits.at(-1).body.model, 'ordinary');
  assert.deepEqual(mod._state.store, before);
  assert.deepEqual((await api()).data.compact.selection, { provider: 'primary', model: 'chosen', key_id: 'compact' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(TMP, 'routes.json'))), mod._state.routes);
});

test('TalentsAI compact variant uses the same pin', async () => {
  await choose('compact');
  assert.equal((await send(SUMMARY + '\n' + COMPACT_RULES[1].body)).status, 200);
  assert.equal(hits[0].headers['x-api-key'], COMPACT);
});

test('changing active account does not move an explicit pin', async () => {
  await choose('active');
  provider().active_key = 'compact'; provider().api_key = COMPACT;
  assert.equal((await send()).status, 200);
  assert.equal(hits.at(-1).headers.authorization, 'Bearer ' + ACTIVE);
  assert.equal((await send('ordinary task')).status, 200);
  assert.equal(hits.at(-1).headers.authorization, 'Bearer ' + COMPACT);
});

test('empty and omitted key_id clear both old pins', async () => {
  for (const key_id of ['', undefined]) {
    await choose('compact');
    provider().active_key = 'active'; provider().api_key = ACTIVE;
    const r = await choose(key_id); assert.equal(r.status, 200); assert.equal(r.data.compact.selection.key_id, '');
    assert.ok(mod._state.routes.rules.every(rule => !Object.hasOwn(rule, 'key_id')));
    assert.equal((await send()).status, 200); assert.equal(hits.at(-1).headers.authorization, 'Bearer ' + ACTIVE);
  }
});

test('legacy provider exposes and accepts klegacy without migrating or mutating provider data', async () => {
  delete provider().keys; delete provider().active_key;
  const before = structuredClone(provider());
  assert.deepEqual((await api()).data.compact.providers[0].keys, [{ id: 'klegacy', label: '账号1', enabled: true }]);
  assert.equal((await choose('klegacy')).status, 200);
  assert.equal((await send()).status, 200); assert.equal(hits[0].headers.authorization, 'Bearer ' + ACTIVE);
  assert.deepEqual(provider(), before);
});

const invalidMutations = [
  ['missing', p => p.keys.splice(1, 1)],
  ['duplicate', p => p.keys.push({ ...p.keys[1] })],
  ['disabled', p => { p.keys[1].enabled = false; }],
  ['empty', p => { p.keys[1].key = ''; }],
  ['whitespace', p => { p.keys[1].key = '  '; }],
  ['control', p => { p.keys[1].key = 'fixture\nsecret'; }],
  ['non-string', p => { p.keys[1].key = {}; }],
];
for (const [name, mutate] of invalidMutations) test(`${name} pinned key returns 503 with zero upstream calls and no cooldown changes`, async () => {
  await choose('compact'); mutate(provider());
  const cooldowns = structuredClone(mod._state.cooldowns);
  const r = await send();
  assert.equal(r.status, 503, r.text); assert.equal(r.data.error.type, 'provider_key_unavailable_error');
  assert.equal(hits.length, 0);
  assert.deepEqual(mod._state.cooldowns, cooldowns, '本地校验拒绝不该把渠道打进冷却');
  const view = (await api()).data.compact;
  assert.equal(view.mode, 'mixed'); assert.equal(view.selection, null);
  assert.equal(view.rules[0].targets[0].key_id, 'compact');
  assert.equal(view.rules[0].targets[0].key_available, false);
  assert.equal(r.text.includes(COMPACT), false);
});

test('removed provider remains visible with the original pin and fails closed', async () => {
  await choose('compact'); mod._state.store.claude.shift();
  const view = (await api()).data.compact;
  assert.equal(view.rules[0].targets[0].provider, 'primary');
  assert.equal(view.rules[0].targets[0].key_id, 'compact');
  assert.equal(view.rules[0].targets[0].key_available, false);
  assert.equal((await send()).data.error.type, 'provider_key_unavailable_error');
  assert.equal(hits.length, 0);
});

test('provider DELETE preserves compact pin targets but still unbinds ordinary routes', async () => {
  await choose('compact');
  assert.equal((await api('DELETE', undefined, '/api/providers/primary')).status, 200);
  assert.equal(mod._state.routes.default.provider, '');
  const view = (await api()).data.compact;
  assert.equal(view.rules[0].targets[0].provider, 'primary');
  assert.equal(view.rules[0].targets[0].key_id, 'compact');
  assert.equal(view.rules[0].targets[0].key_available, false);
  assert.equal((await send()).data.error.type, 'provider_key_unavailable_error');
  assert.equal(hits.length, 0);
});

test('invalid key selections return 400 without changing existing memory or disk', async () => {
  await choose('compact');
  const state = JSON.stringify(mod._state.routes); const disk = fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8');
  for (const key_id of [null, 0, false, {}, [], 'missing', ' compact', 'compact ', ' ', 'compact\n']) {
    assert.equal((await choose(key_id)).status, 400, JSON.stringify(key_id));
    assert.equal(JSON.stringify(mod._state.routes), state);
    assert.equal(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8'), disk);
  }
  for (const pool of [['other'], [null], 'other']) {
    assert.equal((await api('POST', { provider: 'primary', model: 'chosen', key_id: 'compact', pool })).status, 400);
    assert.equal(JSON.stringify(mod._state.routes), state);
    assert.equal(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8'), disk);
  }
  for (const [, mutate] of invalidMutations) {
    const keys = structuredClone(provider().keys); mutate(provider());
    assert.equal((await choose('compact')).status, 400);
    assert.equal(JSON.stringify(mod._state.routes), state);
    assert.equal(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8'), disk);
    provider().keys = keys;
  }
});

test('stale revision and atomic write failure cannot partially change pins', async () => {
  const revision = (await api()).data.compact.revision;
  await choose('compact');
  const before = structuredClone(mod._state.routes); const disk = fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8');
  assert.equal((await api('POST', { provider: 'primary', model: 'chosen', key_id: 'active', expected_revision: revision })).status, 409);
  assert.deepEqual(mod._state.routes, before); assert.equal(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8'), disk);
  fs.rmSync(path.join(TMP, 'routes.json')); fs.mkdirSync(path.join(TMP, 'routes.json'));
  assert.equal((await choose('active')).status, 500); assert.deepEqual(mod._state.routes, before);
});

test('mixed pins are not represented as one selection', async () => {
  await choose('compact'); mod._state.routes.rules[1].key_id = 'active';
  assert.equal((await api()).data.compact.mode, 'mixed');
});

test('normalization retains pins only for compact rules and rejects pin plus any nonempty pool', () => {
  const rule = makeRules().rules[0];
  assert.equal(normalizeRule({ ...rule, key_id: 'compact' }).key_id, 'compact');
  assert.equal(Object.hasOwn(normalizeRule({ ...rule, key_id: '' }), 'key_id'), false);
  assert.equal(Object.hasOwn(normalizeRule({ ...rule, when: {}, key_id: 'compact' }), 'key_id'), false);
  for (const key_id of [null, false, 4, {}, 'x\ny', ' '])
    assert.throws(() => normalizeRule({ ...rule, key_id }), e => e.statusCode === 400);
  for (const pool of [['other'], [null], 'other'])
    assert.throws(() => normalizeRule({ ...rule, key_id: 'compact', pool }), e => e.statusCode === 400);
});

test('generic routes PUT preserves a valid compact pin and rejects a pin+pool atomically', async () => {
  await choose('compact');
  const routes = structuredClone(mod._state.routes);
  assert.equal((await api('PUT', routes, '/api/routes')).status, 200);
  assert.equal(mod._state.routes.rules[0].key_id, 'compact');
  const disk = fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8');
  routes.rules[0].pool = ['other'];
  assert.equal((await api('PUT', routes, '/api/routes')).status, 400);
  assert.deepEqual(mod._state.routes.rules[0].pool, []);
  assert.equal(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8'), disk);
});

test('manual malformed pins and pools fail closed rather than routing with a default key', async () => {
  for (const patch of [{ key_id: null }, { key_id: {} }, { key_id: 'compact', pool: ['other'] },
    { key_id: 'compact', pool: [null] }, { key_id: 'compact', pool: 'other' }]) {
    mod._state.routes = makeRules(); Object.assign(mod._state.routes.rules[0], patch);
    assert.equal((await send()).data.error.type, 'provider_key_unavailable_error');
    assert.equal(hits.length, 0);
  }
});

test('disk loading preserves malformed pin intent and the runtime guard rejects it', () => {
  for (const patch of [{ key_id: null }, { key_id: 'compact', pool: [null] }, { key_id: 'compact', pool: 'other' }]) {
    const routes = makeRules(); Object.assign(routes.rules[0], patch);
    fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify(routes));
    const program = `const m = require(${JSON.stringify(path.resolve(__dirname, '../mixrouter'))});
      const c = require(${JSON.stringify(path.resolve(__dirname, '../lib/routing/compact'))});
      const r = m._state.routes.rules[0];
      if (!c.hasKeyPin(r) || c.pinnedProvider(r, ${JSON.stringify(mod._state.store.claude)})) process.exit(2);`;
    const r = spawnSync(process.execPath, ['-e', program], { env: process.env, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 0, r.stderr);
  }
});

for (const wire of ['chat', 'responses']) test(`${wire}: retry keeps the same explicit key despite active changes`, async () => {
  provider().wire_api = wire; await choose('compact');
  onHit = (req, res) => {
    if (hits.length !== 1) return false;
    provider().active_key = 'active'; provider().api_key = 'fixture-new-active-secret';
    res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"retry fixture"}}'); return true;
  };
  assert.equal((await send()).status, 200);
  assert.equal(hits.length, 2);
  assert.ok(hits.every(h => h.headers.authorization === 'Bearer ' + COMPACT));
});

test('retry re-reads the current store and a removed pin stops before a second upstream call', async () => {
  provider().wire_api = 'responses'; await choose('compact');
  onHit = (req, res) => {
    mod._state.store = structuredClone(mod._state.store); provider().keys.splice(1, 1);
    res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"retry fixture"}}'); return true;
  };
  const r = await send();
  assert.equal(r.status, 503); assert.equal(r.data.error.type, 'provider_key_unavailable_error');
  // 第二发在发出去之前就重查了 store:固定 Key 已被删,本地拒绝,上游只被打了这一次
  assert.equal(hits.length, 1, '删除固定 Key 后不得再打上游');
});

for (const status of [401, 403]) test(`upstream ${status} remains an upstream error, not a local-key retry`, async () => {
  provider().wire_api = 'chat'; await choose('compact');
  onHit = (req, res) => { res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"denied fixture"}}'); return true; };
  assert.equal((await send()).status, status);
  assert.equal(hits.length, 1); assert.equal(hits[0].headers.authorization, 'Bearer ' + COMPACT);
});

test('duplicate key IDs never choose whichever duplicate happens to come first', () => {
  const p = provider(); p.keys.push({ ...p.keys[1], key: 'another-fixture-secret' });
  assert.equal(resolveKey(p, 'compact'), null);
  assert.equal(compact.pinnedProvider({ ...makeRules().rules[0], key_id: 'compact' }, [p]), null);
});

test('preview uses direct compact texts and reports the same unavailable-pin error as forwarding', async () => {
  await choose('compact');
  const preview = context => api('POST', { app: 'claude', model: 'mixr-main', context }, '/api/routing/preview');
  const state = JSON.stringify(mod._state.routes);
  const r = await preview({ compactTexts: [SUMMARY], bodyText: 'irrelevant' });
  assert.equal(r.status, 200);
  assert.equal(r.data.matched.via, 'content');
  assert.equal(r.data.selection.predicted.providerId, 'primary');
  assert.equal(r.data.selection.predicted.model, 'chosen');
  assert.equal(hits.length, 0, 'preview must never contact upstream');
  assert.equal(JSON.stringify(mod._state.routes), state);
  assert.equal(r.text.includes(COMPACT), false);
  assert.equal(r.text.includes(SUMMARY), false, 'request text is not echoed');
  const quoted = await preview({ bodyText: SUMMARY, compactTexts: [{ text: SUMMARY }, 'ordinary task'] });
  assert.equal(quoted.data.matched.via, 'slot');
  provider().keys.splice(1, 1);
  const rejected = await preview({ compactTexts: [SUMMARY] });
  const forwarded = await send();
  assert.equal(rejected.status, 503);
  assert.equal(rejected.status, forwarded.status);
  assert.equal(rejected.data.error.code, forwarded.data.error.type);
  assert.equal(rejected.data.error.message, forwarded.data.error.message);
  assert.equal(hits.length, 0);
});

after(async () => {
  await Promise.all([ui, proxy, upstream].map(s => new Promise(ok => s.close(ok))));
  fs.rmSync(TMP, { recursive: true, force: true });
});
