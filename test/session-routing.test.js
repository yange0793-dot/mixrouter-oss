'use strict';
// Session account selection: temporary state, real loopback HTTP and fixture credentials only.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { FIXED_PREFIX } = require('../lib/routing/compact-signature');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-session-routing-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXR_CONV_RETRIES = '1';
process.env.MIXR_MAX_ATTEMPTS = '3';
// 重试间隔默认 1s:这里要的是重试次数与账号粘性,不是真的等一秒
process.env.MIXR_RETRY_DELAY_MS = '0';
const mod = require('../mixrouter');

const EMPTY = { keys: {}, slots: {} };
const SUMMARY = FIXED_PREFIX + 'Your task is to create a detailed summary of the conversation so far.';
const keyIds = ['active', 'account-a', 'account-b', 'slot-account', 'compact-account'];
const secret = (id, keyId) => `fixture-${id}-${keyId}-credential-value`;
const hits = [];
let ui, proxy, upstream, base, onHit, nextMarker = 0;
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

function success(wire) {
  if (wire === 'chat') return 'data: ' + JSON.stringify({ id: 'mock', choices: [{ index: 0,
    delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';
  if (wire === 'responses') return event('response.completed', { type: 'response.completed', response: {
    id: 'mock', status: 'completed', output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'ok' }] }], usage: {} } });
  return event('message_start', { type: 'message_start', message: {
    id: 'mock', type: 'message', role: 'assistant', content: [], usage: {} } })
    + event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} })
    + event('message_stop', { type: 'message_stop' });
}

function replySuccess(req, res) {
  const wire = req.url.includes('chat/completions') ? 'chat'
    : req.url.includes('responses') ? 'responses' : 'anthropic';
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(success(wire));
}

function request(port, route, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c)); res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data; try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode, headers: res.headers, data, text });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.on('error', reject); req.end(data);
  });
}

function slowPin(id, body) {
  const route = `/api/sessions/${encodeURIComponent(sessionKey(id))}/pin`;
  const data = JSON.stringify(body);
  let finish;
  const arrived = new Promise(resolve => {
    const listener = req => {
      if (req.url !== route || req.method !== 'POST') return;
      ui.removeListener('request', listener); resolve();
    };
    ui.on('request', listener);
  });
  const response = new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: ui.address().port, path: route, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('fixture slow pin timed out')));
    req.on('error', reject);
    req.write(data.slice(0, 1));
    let finished = false;
    finish = () => { if (!finished) { finished = true; req.end(data.slice(1)); } };
  });
  return { arrived, response, finish };
}

const api = (route, method = 'GET', body, port = ui.address().port) => request(port, route, method, body);
const sessionKey = (id, app = 'claude') => (app === 'codex' ? 'cx:' : 'cc:') + id;
const routingPath = (id, app = 'claude') => `/api/sessions/${encodeURIComponent(sessionKey(id, app))}/routing`;
const provider = (id = 'primary', app = 'claude') => mod._state.store[app].find(p => p.id === id);
const routing = (keys = {}, slots = {}) => ({ keys, slots });
const diskSessions = () => fs.readFileSync(path.join(TMP, 'sessions.json'), 'utf8');
const ownHits = marker => hits.filter(hit => JSON.stringify(hit.body).includes(marker));

function send(id, options = {}) {
  const { app = 'claude', endpoint = app === 'claude' ? '/v1/messages' : '/v1/responses',
    model = 'mixr-main', stream = false, content, marker = `fixture-turn-${++nextMarker}-end`,
    port = proxy.address().port, body = {}, headers = {} } = options;
  const text = content === undefined ? marker : content + '\n' + marker;
  const payload = endpoint === '/v1/responses'
    ? { model, stream, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }], ...body }
    : { model, stream, max_tokens: 32, messages: [{ role: 'user', content: text }], ...body };
  return request(port, endpoint, 'POST', payload, {
    ...(app === 'claude' ? { 'x-claude-code-session-id': id } : { 'session-id': id }), ...headers,
  }).then(result => ({ ...result, marker, hits: ownHits(marker) }));
}

async function openSession(id, options = {}) {
  const result = await send(id, options);
  assert.equal(result.status, 200, result.text);
  assert.equal(result.hits.length, 1);
  return result;
}

async function readRouting(id, app = 'claude', port) {
  const result = await api(routingPath(id, app), 'GET', undefined, port);
  assert.equal(result.status, 200, `GET routing: ${result.text}`);
  assert.equal(typeof result.data.revision, 'string');
  assert.ok(result.data.revision.length > 0);
  return result.data;
}

async function putRouting(id, value, { app = 'claude', revision, port } = {}) {
  const expected_revision = revision === undefined ? (await readRouting(id, app, port)).revision : revision;
  return api(routingPath(id, app), 'PUT', { routing: value, expected_revision }, port);
}

async function configure(id, value, options = {}) {
  const app = options.app || 'claude';
  if (!mod._state.sessions.has(sessionKey(id, app))) await openSession(id, options);
  const result = await putRouting(id, value, options);
  assert.equal(result.status, 200, `PUT routing: ${result.text}`);
  assert.equal(result.data.ok, true);
  assert.deepEqual(result.data.routing, value);
  assert.equal(typeof result.data.revision, 'string');
  return result.data;
}

function assertAccount(result, id, keyId, model = 'shared-model', wire = 'anthropic') {
  assert.equal(result.status, 200, result.text);
  assert.equal(result.hits.length, 1);
  const hit = result.hits[0];
  assert.equal(hit.headers.authorization, 'Bearer ' + secret(id, keyId));
  assert.equal(hit.body.model, model);
  assert.ok(hit.url.startsWith('/' + id + '/'), hit.url);
  if (wire === 'anthropic') assert.equal(hit.headers['x-api-key'], secret(id, keyId));
  else assert.equal(hit.headers['x-api-key'], undefined);
}

function makeProvider(id, wire = 'anthropic') {
  return { id, name: id, enabled: true, base_url: `${base}/${id}`, wire_api: wire,
    api_key: secret(id, 'active'), active_key: 'active', models: ['shared-model'], model: 'shared-model',
    keys: keyIds.map(keyId => ({ id: keyId, label: keyId, key: secret(id, keyId) })) };
}

function saveFixtureFiles() {
  for (const [name, value] of [
    ['providers.json', { version: 2, current: { claude: null, codex: null }, ...mod._state.store }],
    ['routes.json', mod._state.routes], ['slots.json', mod._state.slotMap],
    ['sessions.json', { version: 1, bindings: Object.fromEntries(mod._state.sessions) }],
  ]) fs.writeFileSync(path.join(TMP, name), JSON.stringify(value));
}

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks));
      hits.push({ url: req.url, headers: req.headers, body });
      if (onHit && onHit(req, res, body)) return;
      replySuccess(req, res);
    });
  });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${upstream.address().port}`;
  ui = await mod.listen(0, mod.apiHandler); proxy = await mod.listen(0, mod.proxyHandler);
});

beforeEach(() => {
  mod._state.store = { claude: [makeProvider('primary'), makeProvider('secondary')],
    codex: [makeProvider('cx-primary', 'responses'), makeProvider('cx-chat', 'chat')] };
  mod._state.routes = { rules: [], default: { provider: 'primary', model: 'ordinary-model' } };
  mod._state.slotMap = { claude: { main: { provider: 'primary', model: 'shared-model' },
    haiku: { provider: 'primary', model: 'shared-model' } },
  codex: { main: { provider: 'cx-primary' }, chat: { provider: 'cx-chat' } } };
  mod._state.sessions.clear(); mod._state.cooldowns = {};
  mod._state.resetPools();
  onHit = null; hits.length = 0;
  saveFixtureFiles();
});

test('routing API returns inheritance for legacy sessions and supports fully encoded session keys', async () => {
  const id = 'encoded/session:% fixture';
  await openSession(id);
  const current = await readRouting(id);
  assert.deepEqual(current.routing, EMPTY);
  const list = await api('/api/sessions');
  const item = list.data.sessions.find(s => s.key === sessionKey(id));
  assert.deepEqual(item.routing, EMPTY);
  assert.equal(item.routing_revision, current.revision);
  const saved = await configure(id, routing({ primary: 'account-a' }));
  assert.notEqual(saved.revision, current.revision);
  assert.deepEqual((await readRouting(id)).routing, saved.routing);
  assert.equal((await api(routingPath('missing-session'))).status, 404);
  assert.equal((await api(routingPath('missing-session'), 'PUT', {
    routing: EMPTY, expected_revision: current.revision,
  })).status, 404);
});

test('same slot/provider/model: A uses account-a, B account-b and unconfigured C the active account', async () => {
  await configure('A', routing({ primary: 'account-a' }));
  await configure('B', routing({ primary: 'account-b' }));
  const before = structuredClone(mod._state.store);
  for (const [id, keyId] of [['A', 'account-a'], ['B', 'account-b'], ['C', 'active'], ['A', 'account-a']])
    assertAccount(await send(id), 'primary', keyId);
  assert.deepEqual(mod._state.store, before, 'per-request credentials must not mutate the shared provider');
});

test('interleaved concurrent sessions keep independent credentials while all requests remain in flight', async () => {
  await configure('A', routing({ primary: 'account-a' }));
  await configure('B', routing({ primary: 'account-b' }));
  const before = structuredClone(mod._state.store);
  const pending = [];
  onHit = (req, res) => {
    pending.push({ req, res });
    if (pending.length === 12) for (const p of [...pending].reverse()) replySuccess(p.req, p.res);
    return true;
  };
  const ids = ['A', 'B', 'C', 'B', 'A', 'C', 'A', 'C', 'B', 'C', 'B', 'A'];
  const results = await Promise.all(ids.map(id => send(id)));
  assert.equal(pending.length, 12);
  for (let i = 0; i < ids.length; i++)
    assertAccount(results[i], 'primary', { A: 'account-a', B: 'account-b', C: 'active' }[ids[i]]);
  assert.deepEqual(mod._state.store, before);
});

test('changing global active_key through the API moves C but not either configured session', async () => {
  await configure('A', routing({ primary: 'account-a' }));
  await configure('B', routing({ primary: 'account-b' }));
  const changed = await api('/api/providers/primary', 'PUT', { active_key: 'slot-account' });
  assert.equal(changed.status, 200, changed.text);
  assertAccount(await send('A'), 'primary', 'account-a');
  assertAccount(await send('B'), 'primary', 'account-b');
  assertAccount(await send('C'), 'primary', 'slot-account');
  assert.equal(provider().active_key, 'slot-account');
  assert.equal(provider().api_key, secret('primary', 'slot-account'));
});

test('one session can override a slot provider/model without changing the global slot or other sessions', async () => {
  const globalSlots = structuredClone(mod._state.slotMap);
  await configure('A', routing({ secondary: 'account-b' }, {
    main: { provider: 'secondary', model: 'session-only-model' },
  }));
  assertAccount(await send('A'), 'secondary', 'account-b', 'session-only-model');
  assertAccount(await send('B'), 'primary', 'active');
  assert.deepEqual(mod._state.slotMap, globalSlots);
  const preview = await api('/api/routing/preview', 'POST', {
    app: 'claude', model: 'mixr-main', context: { session: sessionKey('A') },
  });
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.data.selection.predicted.providerId, 'secondary');
  assert.equal(preview.data.selection.predicted.model, 'session-only-model');
});

test('slot key_id wins over the session provider key, and other slots use the provider key', async () => {
  await configure('A', routing({ primary: 'account-a' }, {
    main: { provider: 'primary', model: 'shared-model', key_id: 'slot-account' },
  }));
  assertAccount(await send('A'), 'primary', 'slot-account');
  assertAccount(await send('A', { model: 'mixr-haiku' }), 'primary', 'account-a');
});

test('slot overrides preserve global dropTools instead of silently restoring stripped tools', async () => {
  mod._state.slotMap.claude.main.dropTools = ['Bash'];
  await configure('A', routing({}, { main: { provider: 'secondary', model: 'session-model' } }));
  const result = await send('A', { body: { tools: [
    { name: 'Bash', description: 'fixture', input_schema: { type: 'object' } },
    { name: 'Read', description: 'fixture', input_schema: { type: 'object' } },
  ] } });
  assertAccount(result, 'secondary', 'active', 'session-model');
  assert.deepEqual(result.hits[0].body.tools.map(t => t.name), ['Read']);
});

test('ordinary manual provider pin keeps its meaning while alias requests use their own slot override', async () => {
  await configure('A', routing({ primary: 'account-a', secondary: 'account-b' }, {
    main: { provider: 'primary', model: 'shared-model' },
  }));
  const pinPath = `/api/sessions/${encodeURIComponent(sessionKey('A'))}/pin`;
  assert.equal((await api(pinPath, 'POST', { provider: 'secondary', model: 'manual-model' })).status, 200);
  assertAccount(await send('A', { model: 'ordinary-input' }), 'secondary', 'account-b', 'manual-model');
  assertAccount(await send('A'), 'primary', 'account-a');
  assert.equal((await api(pinPath, 'POST', { provider: '' })).status, 200);
  assert.deepEqual((await readRouting('A')).routing.keys, { primary: 'account-a', secondary: 'account-b' });
});

test('compact fixed key and content routing take precedence over all session overrides', async () => {
  await configure('A', routing({ primary: 'account-a', secondary: 'account-b' }, {
    main: { provider: 'secondary', model: 'session-model', key_id: 'slot-account' },
  }));
  const chosen = await api('/api/compact', 'POST', {
    provider: 'primary', model: 'compact-model', key_id: 'compact-account',
  });
  assert.equal(chosen.status, 200, chosen.text);
  assertAccount(await send('A', { content: SUMMARY }), 'primary', 'compact-account', 'compact-model');
  assertAccount(await send('A'), 'secondary', 'slot-account', 'session-model');
  const unpin = await api('/api/compact', 'POST', { provider: 'primary', model: 'compact-model', key_id: '' });
  assert.equal(unpin.status, 200, unpin.text);
  assertAccount(await send('A', { content: SUMMARY }), 'primary', 'active', 'compact-model');
});

for (const wire of ['anthropic', 'responses', 'chat']) test(`${wire} upstream receives the session credential in its real HTTP auth headers`, async () => {
  provider().wire_api = wire;
  await configure('A', routing({ primary: 'account-a' }));
  await configure('B', routing({ primary: 'account-b' }));
  for (const stream of [false, true]) {
    assertAccount(await send('A', { stream }), 'primary', 'account-a', 'shared-model', wire);
    assertAccount(await send('B', { stream }), 'primary', 'account-b', 'shared-model', wire);
  }
});

for (const wire of ['responses', 'chat']) test(`Codex ${wire} direct client also selects its own session account`, async () => {
  const id = wire === 'chat' ? 'cx-chat' : 'cx-primary';
  const options = { app: 'codex', endpoint: wire === 'chat' ? '/v1/chat/completions' : '/v1/responses',
    model: wire === 'chat' ? 'mixr-chat' : 'mixr-main' };
  await configure('cx-A', routing({ [id]: 'account-a' }), options);
  await configure('cx-B', routing({ [id]: 'account-b' }), options);
  for (const stream of [false, true]) {
    assertAccount(await send('cx-A', { ...options, stream }), id, 'account-a', 'shared-model', wire);
    assertAccount(await send('cx-B', { ...options, stream }), id, 'account-b', 'shared-model', wire);
    assertAccount(await send('cx-C', { ...options, stream }), id, 'active', 'shared-model', wire);
  }
});

test('Codex accepts a legal session-only custom slot and uses the selected provider model', async () => {
  await configure('cx-A', routing({ 'cx-chat': 'account-b' }, {
    'my-worker': { provider: 'cx-chat', model: 'custom-session-model' },
  }), { app: 'codex' });
  assertAccount(await send('cx-A', { app: 'codex', model: 'mixr-my-worker' }),
    'cx-chat', 'account-b', 'custom-session-model', 'chat');
  assert.equal(mod._state.slotMap.codex['my-worker'], undefined);
});

const invalidKeys = [
  ['deleted', p => { p.keys = p.keys.filter(k => k.id !== 'account-a'); }],
  ['disabled', p => { p.keys.find(k => k.id === 'account-a').enabled = false; }],
  ['duplicate', p => { p.keys.push({ ...p.keys.find(k => k.id === 'account-a'), key: 'fixture-duplicate-value' }); }],
  ['empty', p => { p.keys.find(k => k.id === 'account-a').key = ''; }],
  ['whitespace', p => { p.keys.find(k => k.id === 'account-a').key = '   '; }],
  ['control character', p => { p.keys.find(k => k.id === 'account-a').key = 'fixture\ncredential'; }],
  ['non-string', p => { p.keys.find(k => k.id === 'account-a').key = {}; }],
];
for (const [name, mutate] of invalidKeys) test(`${name} explicit key returns 503 without using another account or pool provider`, async () => {
  mod._state.slotMap.claude.main.pool = ['secondary'];
  mod._state.slotMap.claude.main.strategy = 'priority';
  await configure('A', routing({ primary: 'account-a' }));
  mutate(provider());
  const before = hits.length;
  const cooldowns = structuredClone(mod._state.cooldowns);
  const result = await send('A');
  assert.equal(result.status, 503, result.text);
  assert.equal(result.data.error.type, 'provider_key_unavailable_error');
  assert.equal(hits.length, before, 'must reject locally, not contact active account or pool fallback');
  assert.deepEqual(mod._state.cooldowns, cooldowns, '本地校验拒绝不该把渠道打进冷却');
  assert.equal(result.text.includes(secret('primary', 'account-a')), false);
  const preview = await api('/api/routing/preview', 'POST', {
    app: 'claude', model: 'mixr-main', context: { session: sessionKey('A') },
  });
  assert.equal(preview.status, 503, preview.text);
  assert.equal(preview.data.error.code, 'provider_key_unavailable_error');
  assert.equal(hits.length, before);
});

test('deleting a slot key cannot fall back to the valid provider-level session key', async () => {
  await configure('A', routing({ primary: 'account-b' }, {
    main: { provider: 'primary', model: 'shared-model', key_id: 'account-a' },
  }));
  provider().keys = provider().keys.filter(k => k.id !== 'account-a');
  const result = await send('A');
  assert.equal(result.status, 503, result.text);
  assert.equal(result.data.error.type, 'provider_key_unavailable_error');
  assert.equal(result.hits.length, 0);
});

for (const wire of ['responses', 'chat']) test(`${wire} retry keeps the same account even if active_key changes during the first attempt`, async () => {
  provider().wire_api = wire;
  await configure('A', routing({ primary: 'account-a' }));
  let attempts = 0;
  onHit = (req, res) => {
    if (++attempts !== 1) return false;
    provider().active_key = 'account-b'; provider().api_key = secret('primary', 'account-b');
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"fixture retry"}}'); return true;
  };
  const result = await send('A');
  assert.equal(result.status, 200, result.text);
  assert.equal(result.hits.length, 2);
  assert.ok(result.hits.every(h => h.headers.authorization === 'Bearer ' + secret('primary', 'account-a')));
  assert.equal(provider().active_key, 'account-b');
});

test('retry re-reads the current store and a deleted session key stops before a second upstream call', async () => {
  provider().wire_api = 'responses';
  mod._state.slotMap.claude.main.pool = ['secondary'];
  await configure('A', routing({ primary: 'account-a' }));
  onHit = (req, res) => {
    mod._state.store = structuredClone(mod._state.store);
    provider().keys = provider().keys.filter(k => k.id !== 'account-a');
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"fixture removed during request"}}'); return true;
  };
  const result = await send('A');
  assert.equal(result.status, 503, result.text);
  assert.equal(result.data.error.type, 'provider_key_unavailable_error');
  // 第二发之前重新查 store:固定账号已被删,本地拒绝,上游只被打了这一次
  assert.equal(result.hits.length, 1, '删除会话固定账号后不得再打上游');
  assert.equal(result.hits[0].headers.authorization, 'Bearer ' + secret('primary', 'account-a'));
});

test('fixed-account upstream failure never spills into the slot fallback pool', async () => {
  provider().wire_api = 'chat';
  mod._state.slotMap.claude.main.pool = ['secondary'];
  await configure('A', routing({ primary: 'account-a' }));
  onHit = (req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"fixture exhausted retries"}}'); return true;
  };
  const result = await send('A');
  assert.equal(result.status, 500, result.text);
  assert.equal(result.hits.length, 2, 'one initial attempt plus one same-account retry');
  assert.ok(result.hits.every(h => h.url.startsWith('/primary/')
    && h.headers.authorization === 'Bearer ' + secret('primary', 'account-a')));
});

test('saving during an in-flight request affects new requests only, including the old request retry', async () => {
  provider().wire_api = 'responses';
  await configure('A', routing({ primary: 'account-a' }));
  let held, resolveHeld;
  const arrived = new Promise(resolve => { resolveHeld = resolve; });
  let first = true;
  onHit = (req, res) => {
    if (!first) return false;
    first = false; held = res; resolveHeld(); return true;
  };
  const oldRequest = send('A');
  try {
    await arrived;
    await configure('A', routing({ primary: 'account-b' }));
    const reqsBefore = mod._state.sessions.get(sessionKey('A')).reqs;
    held.writeHead(500, { 'content-type': 'application/json' });
    held.end('{"error":{"message":"fixture in-flight retry"}}');
    const old = await oldRequest;
    assert.equal(old.status, 200, old.text);
    assert.equal(old.hits.length, 2);
    assert.ok(old.hits.every(h => h.headers.authorization === 'Bearer ' + secret('primary', 'account-a')));
    assert.equal(mod._state.sessions.get(sessionKey('A')).reqs, reqsBefore + 1,
      'completion must count against the current session record after PUT replaces it');
    assertAccount(await send('A'), 'primary', 'account-b', 'shared-model', 'responses');
    assert.deepEqual((await readRouting('A')).routing, routing({ primary: 'account-b' }));
  } finally {
    if (held && !held.writableEnded) held.end();
    await oldRequest.catch(() => {});
  }
});

test('deleting a session during an in-flight response does not resurrect its routing or record', async () => {
  await configure('A', routing({ primary: 'account-a' }));
  let held, resolveHeld;
  const arrived = new Promise(resolve => { resolveHeld = resolve; });
  onHit = (req, res) => { held = { req, res }; resolveHeld(); return true; };
  const pending = send('A');
  try {
    await arrived;
    assert.equal((await api(`/api/sessions/${encodeURIComponent(sessionKey('A'))}`, 'DELETE')).status, 200);
    replySuccess(held.req, held.res);
    assertAccount(await pending, 'primary', 'account-a');
    assert.equal(mod._state.sessions.has(sessionKey('A')), false);
    assert.equal((await api(routingPath('A'))).status, 404);
    const list = await api('/api/sessions');
    assert.equal(list.data.sessions.some(s => s.key === sessionKey('A')), false);
    assert.equal(JSON.parse(diskSessions()).bindings[sessionKey('A')], undefined);
  } finally {
    if (held && !held.res.writableEnded) held.res.end();
    await pending.catch(() => {});
  }
});

test('slow pin body cannot overwrite routing saved after its request headers arrived', async () => {
  await configure('A', routing({ primary: 'account-a' }));
  const pending = slowPin('A', { provider: 'secondary', model: 'manual-model' });
  try {
    await pending.arrived;
    const saved = await configure('A', routing({ primary: 'account-b', secondary: 'slot-account' }));
    pending.finish();
    const result = await pending.response;
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(await readRouting('A'), { routing: saved.routing, revision: saved.revision });
    const current = mod._state.sessions.get(sessionKey('A'));
    assert.equal(current.providerId, 'secondary'); assert.equal(current.pinned, true);
    assert.deepEqual(JSON.parse(diskSessions()).bindings[sessionKey('A')].routing, saved.routing);
    assertAccount(await send('A', { model: 'ordinary-input' }), 'secondary', 'slot-account', 'manual-model');
  } finally { pending.finish(); await pending.response.catch(() => {}); }
});

test('slow pin body cannot resurrect a session deleted after its request headers arrived', async () => {
  await configure('A', routing({ primary: 'account-a' }));
  const pending = slowPin('A', { provider: 'secondary', model: 'manual-model' });
  try {
    await pending.arrived;
    assert.equal((await api(`/api/sessions/${encodeURIComponent(sessionKey('A'))}`, 'DELETE')).status, 200);
    pending.finish();
    const result = await pending.response;
    assert.equal(result.status, 404, result.text);
    assert.equal(mod._state.sessions.has(sessionKey('A')), false);
    assert.equal((await api(routingPath('A'))).status, 404);
    assert.equal(JSON.parse(diskSessions()).bindings[sessionKey('A')], undefined);
  } finally { pending.finish(); await pending.response.catch(() => {}); }
});

for (const pinned of [false, true]) test(`provider removed during a conversion retry: ${pinned ? 'explicit key rejects' : 'inherited key keeps its request snapshot'}`, async () => {
  provider().wire_api = 'responses';
  if (pinned) await configure('A', routing({ primary: 'account-a' }));
  else await openSession('A');
  let attempts = 0;
  onHit = (req, res) => {
    if (++attempts !== 1) return false;
    mod._state.store = { ...mod._state.store,
      claude: mod._state.store.claude.filter(p => p.id !== 'primary') };
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"fixture provider removed during retry"}}'); return true;
  };
  const result = await send('A');
  if (pinned) {
    assert.equal(result.status, 503, result.text);
    assert.equal(result.data.error.type, 'provider_key_unavailable_error');
    assert.equal(result.hits.length, 1);
  } else {
    assert.equal(result.status, 200, result.text);
    assert.equal(result.hits.length, 2);
    assert.ok(result.hits.every(h => h.headers.authorization === 'Bearer ' + secret('primary', 'active')));
  }
  assert.ok(result.hits.every(h => h.url.startsWith('/primary/')));
  assert.equal((await api('/healthz')).status, 200);
});

test('ordinary in-flight completion counts the current record without overwriting newly saved routing or manual pin', async () => {
  await configure('A', routing({ primary: 'account-a' }), { model: 'ordinary-input' });
  let held, resolveHeld;
  const arrived = new Promise(resolve => { resolveHeld = resolve; });
  onHit = (req, res) => { held = { req, res }; resolveHeld(); return true; };
  const pending = send('A', { model: 'ordinary-input' });
  try {
    await arrived;
    const saved = await configure('A', routing({ primary: 'account-b', secondary: 'slot-account' }));
    const pinPath = `/api/sessions/${encodeURIComponent(sessionKey('A'))}/pin`;
    assert.equal((await api(pinPath, 'POST', { provider: 'secondary', model: 'manual-model' })).status, 200);
    const reqsBefore = mod._state.sessions.get(sessionKey('A')).reqs;
    replySuccess(held.req, held.res);
    assertAccount(await pending, 'primary', 'account-a', 'ordinary-model');
    const current = mod._state.sessions.get(sessionKey('A'));
    assert.equal(current.reqs, reqsBefore + 1);
    assert.equal(current.providerId, 'secondary'); assert.equal(current.pinned, true);
    assert.equal(current.model, 'manual-model');
    assert.deepEqual(await readRouting('A'), { routing: saved.routing, revision: saved.revision });
    onHit = null;
    assertAccount(await send('A', { model: 'ordinary-input' }), 'secondary', 'slot-account', 'manual-model');
  } finally {
    if (held && !held.res.writableEnded) held.res.end();
    await pending.catch(() => {});
  }
});

test('PUT rejects malformed types, missing/cross-group references and control characters atomically', async () => {
  await configure('A', routing({ primary: 'account-a' }));
  const before = await readRouting('A'); const disk = diskSessions();
  const invalid = [null, [], 'bad', 1, true,
    { keys: [] }, { keys: null }, { keys: false }, { slots: [] }, { slots: null },
    routing({ primary: null }), routing({ primary: 1 }), routing({ primary: [] }), routing({ primary: {} }),
    routing({ primary: 'missing' }), routing({ primary: '' }), routing({ primary: 'account-a\n' }),
    routing({ primary: ' account-a' }), routing({ 'missing-provider': 'account-a' }),
    routing({ 'cx-primary': 'account-a' }), routing({ 'primary\n': 'account-a' }),
    routing({}, { main: null }), routing({}, { main: [] }),
    routing({}, { main: { provider: 1 } }), routing({}, { main: { provider: 'missing-provider' } }),
    routing({}, { main: { provider: 'cx-primary' } }),
    routing({}, { main: { provider: 'primary', model: {} } }),
    routing({}, { main: { provider: 'primary', model: 'bad\nmodel' } }),
    routing({}, { main: { provider: 'primary', key_id: 1 } }),
    routing({}, { main: { provider: 'primary', key_id: 'missing' } }),
    routing({}, { main: { provider: 'primary', key_id: 'account-a\u0000' } }),
    routing({}, { main: { provider: 'primary', pool: ['secondary'] } }),
    routing({}, { invalid: { provider: 'primary' } }),
  ];
  for (const value of invalid) {
    const result = await putRouting('A', value, { revision: before.revision });
    assert.equal(result.status, 400, JSON.stringify(value) + ': ' + result.text);
    assert.deepEqual(await readRouting('A'), before);
    assert.equal(diskSessions(), disk);
  }
  for (const [, mutate] of invalidKeys) {
    const saved = structuredClone(provider().keys); mutate(provider());
    try {
      const result = await putRouting('A', routing({ primary: 'account-a' }), { revision: before.revision });
      assert.equal(result.status, 400, result.text);
      assert.deepEqual(await readRouting('A'), before);
      assert.equal(diskSessions(), disk);
    } finally { provider().keys = saved; }
  }
});

test('PUT requires a revision and stale/concurrent updates cannot overwrite a newer account choice', async () => {
  await openSession('A');
  const before = await readRouting('A');
  for (const expected_revision of [undefined, null, 0, {}, []]) {
    const result = await api(routingPath('A'), 'PUT', { routing: EMPTY, expected_revision });
    assert.equal(result.status, 400, result.text);
    assert.deepEqual(await readRouting('A'), before);
  }
  const updates = await Promise.all(['account-a', 'account-b'].map(keyId =>
    putRouting('A', routing({ primary: keyId }), { revision: before.revision })));
  assert.deepEqual(updates.map(r => r.status).sort(), [200, 409]);
  const winner = updates.find(r => r.status === 200).data;
  assert.deepEqual(await readRouting('A'), { routing: winner.routing, revision: winner.revision });
  const disk = diskSessions();
  const stale = await putRouting('A', EMPTY, { revision: before.revision });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(diskSessions(), disk);
});

test('atomic session write failure returns 500 and restores both routing and revision in memory', async () => {
  await configure('A', routing({ primary: 'account-a' }));
  const before = await readRouting('A'); const disk = diskSessions();
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === path.join(TMP, 'sessions.json'))
      throw Object.assign(new Error('fixture sessions write denied'), { code: 'EACCES' });
    return rename(from, to);
  };
  let result;
  try { result = await putRouting('A', routing({ primary: 'account-b' }), { revision: before.revision }); }
  finally { fs.renameSync = rename; }
  assert.equal(result.status, 500, result.text);
  assert.deepEqual(await readRouting('A'), before);
  assert.equal(diskSessions(), disk);
  assertAccount(await send('A'), 'primary', 'account-a');
});

async function restartFixture() {
  const program = `const mod = require(${JSON.stringify(path.resolve(__dirname, '../mixrouter'))});
    Promise.all([mod.listen(0, mod.apiHandler), mod.listen(0, mod.proxyHandler)]).then(servers => {
      process.send({ ui: servers[0].address().port, proxy: servers[1].address().port });
      process.on('message', message => {
        if (message !== 'close') return;
        for (const server of servers) { server.close(); if (server.closeAllConnections) server.closeAllConnections(); }
        process.exit(0);
      });
    }).catch(error => { console.error(error.message); process.exit(1); });`;
  const child = spawn(process.execPath, ['-e', program], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, MIXROUTER_PORT: '0', MIXUI_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.resume();
  try {
    const ports = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture restart timed out')), 5000);
      child.once('message', ports => { clearTimeout(timer); resolve(ports); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture exited ${code}: ${stderr}`)); });
    });
    return { ...ports, close: () => new Promise(resolve => {
      child.once('exit', resolve);
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000); timer.unref();
      child.once('exit', () => clearTimeout(timer));
      child.send('close');
    }) };
  } catch (error) { child.kill('SIGKILL'); throw error; }
}

test('successful PUT is on disk before responding and a fresh process restores the session routing', async () => {
  const value = routing({ primary: 'account-a', secondary: 'account-b' }, {
    main: { provider: 'secondary', model: 'restored-model', key_id: 'slot-account' },
  });
  const saved = await configure('restart-A', value);
  const stored = JSON.parse(diskSessions()).bindings[sessionKey('restart-A')];
  assert.deepEqual(stored.routing, value);
  const fresh = await restartFixture();
  try {
    assert.deepEqual(await readRouting('restart-A', 'claude', fresh.ui), { routing: value, revision: saved.revision });
    assertAccount(await send('restart-A', { port: fresh.proxy }), 'secondary', 'slot-account', 'restored-model');
    const list = await api('/api/sessions', 'GET', undefined, fresh.ui);
    const item = list.data.sessions.find(s => s.key === sessionKey('restart-A'));
    assert.deepEqual(item.routing, value); assert.equal(item.routing_revision, saved.revision);
  } finally { await fresh.close(); }
});

test('clearing all overrides restores global inheritance and deleting a session removes its saved configuration', async () => {
  await configure('A', routing({ primary: 'account-a' }, {
    main: { provider: 'secondary', model: 'session-model', key_id: 'account-b' },
  }));
  await configure('A', EMPTY);
  assertAccount(await send('A'), 'primary', 'active');
  assert.deepEqual((await readRouting('A')).routing, EMPTY);
  await configure('A', routing({ primary: 'account-b' }));
  assert.equal((await api(`/api/sessions/${encodeURIComponent(sessionKey('A'))}`, 'DELETE')).status, 200);
  assert.equal((await api(routingPath('A'))).status, 404);
  assert.equal(JSON.parse(diskSessions()).bindings[sessionKey('A')], undefined);
  assertAccount(await send('A'), 'primary', 'active');
  assert.deepEqual((await readRouting('A')).routing, EMPTY);
});

test('routing responses, session lists, state, logs and sessions.json never expose credential values', async () => {
  const value = routing({ primary: 'account-a' }, {
    main: { provider: 'primary', model: 'shared-model', key_id: 'slot-account' },
  });
  const saved = await configure('A', value);
  assertAccount(await send('A'), 'primary', 'slot-account');
  const response = await api('/api/logs?limit=100');
  assert.ok(response.data.logs.some(log => log.session === 'A'));
  const outputs = [JSON.stringify(saved), diskSessions(), response.text];
  for (const route of [routingPath('A'), '/api/sessions', '/api/state']) outputs.push((await api(route)).text);
  outputs.push(fs.readFileSync(path.join(TMP, 'logs', 'requests.jsonl'), 'utf8'));
  const allSecrets = Object.values(mod._state.store).flatMap(group => group.flatMap(p => p.keys.map(k => k.key)));
  for (const text of outputs) for (const credential of allSecrets)
    assert.equal(text.includes(credential), false, 'public/session storage output exposed a fixture credential');
  assert.deepEqual(JSON.parse(diskSessions()).bindings[sessionKey('A')].routing, value);
});

after(async () => {
  onHit = null;
  if (ui) await api('/api/sessions', 'DELETE');
  await Promise.all([ui, proxy, upstream].filter(Boolean).map(server => new Promise(resolve => {
    server.close(resolve); if (server.closeAllConnections) server.closeAllConnections();
  })));
  fs.rmSync(TMP, { recursive: true, force: true });
});
