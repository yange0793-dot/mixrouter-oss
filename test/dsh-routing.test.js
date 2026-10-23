'use strict';
// Harness traffic, client files and routing data stay inside the temporary fixture.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { waitFor } = require('./wait-for');
const wireResponses = require('../lib/wire-responses');
const wireOpenai = require('../lib/wire-openai-bridge');
const { createDshRouting } = require('../lib/dsh-routing');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-dsh-routing-'));
const HOME = path.join(TMP, 'home');
const CONFIG = path.join(HOME, 'dsh', 'cordis.patch.yml');
Object.assign(process.env, {
  HOME, MIXR_DATA_DIR: TMP, MIXR_DSH_CONFIG: CONFIG,
  MIXR_DSH_APP: path.join(TMP, 'absent-harness'),
  MIXR_CLAUDE_SETTINGS: path.join(HOME, 'claude.json'),
  MIXR_CODEX_CONFIG: path.join(HOME, 'codex.toml'),
  MIXR_ZCODE_CONFIG: path.join(HOME, 'zcode.json'),
  MIXR_MAX_ATTEMPTS: '1', MIXR_CONV_RETRIES: '0', MIXR_RETRY_DELAY_MS: '0',
  MIXR_COOLDOWN_SEC: '0', MIXR_SSE_KEEPALIVE_MS: '0', MIXR_RESPONSE_ARCHIVE: 'off',
  MIXR_TOTAL_DEADLINE_MS: '5000', MIXR_FIRST_HEADER_TIMEOUT_MS: '1500',
});
fs.mkdirSync(HOME);
fs.mkdirSync(path.join(TMP, 'logs'));
const mod = require('../mixrouter');
let ui, proxy, upstream, base, upstreamStatus = 200;
const hits = [], sockets = new Set();
const routeFile = path.join(TMP, 'dsh.json');
const channel = id => [...mod._state.store.claude, ...mod._state.store.codex].find(p => p.id === id);
const tools = [{ type: 'function', name: 'Lookup', description: 'fixture lookup',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, strict: false }];
const chatJson = model => ({ id: 'chat-fixture', object: 'chat.completion', created: 123, model,
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'answer',
    reasoning_content: 'fixture reasoning', tool_calls: [{ id: 'call-fixture', type: 'function',
      function: { name: 'Lookup', arguments: '{"q":"value"}' } }] } }],
  usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62,
    prompt_tokens_details: { cached_tokens: 8 }, completion_tokens_details: { reasoning_tokens: 4 } } });
const responsesJson = model => ({ id: 'response-fixture', object: 'response', status: 'completed', model,
  output: [
    { id: 'reasoning-fixture', type: 'reasoning', summary: [], encrypted_content: 'opaque',
      content: [{ type: 'reasoning_text', text: 'fixture reasoning' }] },
    { id: 'message-fixture', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'answer', annotations: [] }] },
    { id: 'function-fixture', type: 'function_call', status: 'completed', call_id: 'call-fixture',
      name: 'Lookup', arguments: '{"q":"value"}' },
  ], usage: { input_tokens: 50, output_tokens: 12, total_tokens: 62,
    input_tokens_details: { cached_tokens: 8 }, output_tokens_details: { reasoning_tokens: 4 } } });
const sse = value => `data: ${JSON.stringify(value)}\n\n`;
function request(server, endpoint, method = 'POST', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: endpoint,
      method, agent: false, headers: { 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data), Connection: 'close', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, data: json });
      });
    });
    req.setTimeout(6000, () => req.destroy(new Error('Harness fixture request timed out')));
    req.on('error', reject); req.end(data);
  });
}
const api = (endpoint, body, method = 'GET') => request(ui, endpoint, method, body);
const readState = () => api('/api/dsh');
async function save(slots, default_subagent = '') {
  const state = await readState();
  return api('/api/dsh', { expected_revision: state.data.revision, slots, default_subagent }, 'PUT');
}
async function configure(slots, default_subagent = '') {
  const result = await save(slots, default_subagent);
  assert.equal(result.status, 200, result.text);
  return result.data;
}
const send = (name = 'main', stream = true, endpoint = '/dsh/v1/responses', extra = {}, headers = {}) =>
  request(proxy, endpoint, 'POST', { model: `mixr-dsh-${name}`, stream, input: 'fixture input',
    messages: [{ role: 'user', content: 'fixture input' }], tools, ...extra },
  { 'session-id': 'dsh-fixture', authorization: 'Bearer client-must-not-reach-upstream', ...headers });
function responseResult(response) {
  return /text\/event-stream/.test(response.headers['content-type'])
    ? wireResponses.parseSseEvents(response.text).events.at(-1).response : response.data;
}
function assertResult(result) {
  assert.equal(result.status, 'completed');
  assert.equal(result.output.find(item => item.type === 'function_call').name, 'Lookup');
  assert.equal(result.output.find(item => item.type === 'function_call').call_id, 'call-fixture');
  assert.deepEqual(JSON.parse(result.output.find(item => item.type === 'function_call').arguments), { q: 'value' });
  assert.equal(result.usage.input_tokens, 50);
  assert.equal(result.usage.output_tokens, 12);
  assert.equal(result.usage.input_tokens_details.cached_tokens, 8);
}

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      hits.push({ path: req.url, headers: req.headers, body });
      if (upstreamStatus !== 200) {
        res.writeHead(upstreamStatus, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'fixture upstream rejection', type: 'invalid_request_error', code: 'fixture_error' } }));
      }
      const chat = req.url.endsWith('/chat/completions');
      const json = chat ? chatJson(body.model) : responsesJson(body.model);
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(json));
      }
      if (!chat) return wireOpenai.emitResponsesSse(res, json);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const choices = json.choices.map(({ message, ...rest }) => ({ ...rest, delta: {
        ...message, tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })),
      } }));
      res.end(sse({ ...json, object: 'chat.completion.chunk', choices }) + 'data: [DONE]\n\n');
    });
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${upstream.address().port}`;
  ui = await mod.listen(0, mod.apiHandler);
  proxy = await mod.listen(0, mod.proxyHandler);
});
beforeEach(() => {
  const provider = (id, wire_api, enabled = true) => ({ id, name: id, wire_api, enabled,
    base_url: `${base}/${id}/v1`, api_key: `secret-${id}-active`, active_key: 'active',
    model: `${id}-listed`, models: [`${id}-listed`],
    keys: [{ id: 'active', label: 'active', key: `secret-${id}-active` },
      { id: 'other', label: 'other', key: `secret-${id}-other` }] });
  mod._state.store = {
    claude: [provider('cc-chat', 'chat'), provider('cc-responses', 'responses'), provider('native', 'anthropic')],
    codex: [provider('cx-chat', 'chat'), provider('cx-responses', 'responses'), provider('disabled', 'chat', false)],
  };
  mod._state.current = { claude: 'native', codex: 'cx-responses', zcode: null };
  mod._state.routes = { rules: [], default: mod.normalizeRule({}) };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.sessions.clear(); mod._state.cooldowns = {}; mod._state.resetPools();
  upstreamStatus = 200; hits.length = 0;
});
after(async () => {
  // This force-flush clears the production session debounce even if beforeEach cleared the map.
  const cleared = await api('/api/sessions', undefined, 'DELETE');
  assert.equal(cleared.status, 200, cleared.text);
  for (const socket of sockets) socket.destroy();
  await Promise.all([upstream, ui, proxy].filter(Boolean).map(server => new Promise(resolve => {
    server.closeAllConnections(); server.close(resolve);
  })));
  await waitFor(() => sockets.size === 0, { label: 'Harness mock sockets closed' });
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('unconfigured API is read-only, redirects client inspection and exposes no provider Key', async () => {
  const state = await readState();
  assert.equal(state.status, 200, state.text);
  assert.deepEqual(state.data.slots, {});
  assert.equal(state.data.default_subagent, '');
  assert.equal(state.data.client.config_path, CONFIG);
  assert.equal(state.data.client.installed, false);
  assert.equal(state.data.client.routed, false);
  assert.match(state.data.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(state.data.providers.map(p => p.id).sort(), ['cc-chat', 'cc-responses', 'cx-chat', 'cx-responses', 'disabled']);
  assert.equal(state.text.includes('secret-'), false);
  assert.equal(state.text.includes('api_key'), false);
  assert.equal(fs.existsSync(routeFile), false);
  assert.equal(fs.existsSync(CONFIG), false);
  const models = await request(proxy, '/dsh/v1/models', 'GET');
  assert.deepEqual(models.data, { object: 'list', data: [] });
  const failed = await send();
  assert.equal(failed.status, 503);
  assert.equal(failed.data.error.type, 'no_route');
  assert.equal(failed.data.error.code, 'no_route_error');
  assert.equal(failed.data.type, undefined, 'Harness must not emit Anthropic top-level type:error');
  assert.equal(hits.length, 0);
});

test('PUT stores separate main/custom subagent slots, lists aliases and leaves all other clients untouched', async () => {
  fs.writeFileSync(process.env.MIXR_CLAUDE_SETTINGS, '{"env":{"ANTHROPIC_MODEL":"keep-claude"}}');
  fs.writeFileSync(process.env.MIXR_CODEX_CONFIG, 'model = "keep-codex"\n');
  fs.writeFileSync(process.env.MIXR_ZCODE_CONFIG, '{"model":"keep-zcode"}');
  const originals = [process.env.MIXR_CLAUDE_SETTINGS, process.env.MIXR_CODEX_CONFIG, process.env.MIXR_ZCODE_CONFIG]
    .map(file => [file, fs.readFileSync(file, 'utf8')]);
  const before = structuredClone({ store: mod._state.store, routes: mod._state.routes, slots: mod._state.slotMap, current: mod._state.current });
  const slots = { main: { provider: 'cc-chat', model: 'free/custom-main', upstream_stream: false },
    'research-2': { provider: 'cx-responses', model: 'custom-subagent', upstream_stream: false } };
  const result = await configure(slots, 'research-2');
  assert.deepEqual(result.slots, slots);
  assert.equal(result.default_subagent, 'research-2');
  assert.deepEqual(JSON.parse(fs.readFileSync(routeFile, 'utf8')), { version: 1, slots, default_subagent: 'research-2' });
  assert.equal(fs.statSync(routeFile).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(result).includes('secret-'), false);
  assert.deepEqual({ store: mod._state.store, routes: mod._state.routes, slots: mod._state.slotMap, current: mod._state.current }, before);
  for (const [file, text] of originals) assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(fs.existsSync(CONFIG), false, 'saving routes is not client sync');
  const models = await request(proxy, '/dsh/v1/models', 'GET');
  assert.deepEqual(models.data.data.map(m => m.id), ['mixr-dsh-main', 'mixr-dsh-research-2']);
  assert.equal(models.text.includes('secret-'), false);
  const ordinary = await request(proxy, '/v1/models', 'GET');
  assert.equal(ordinary.data.data.some(m => m.id.startsWith('mixr-dsh-')), false);
});

test('save validation rejects empty main, invalid names, bad values and unsupported providers without changing data', async () => {
  await configure({ main: { provider: 'cc-chat', model: 'valid' }, worker: { provider: 'cx-responses', model: 'valid-worker' } });
  const state = await readState();
  const before = fs.readFileSync(routeFile, 'utf8');
  const valid = { main: { provider: 'cc-chat', model: 'valid' } };
  const bad = [
    { slots: {} }, { slots: { main: {} } }, { slots: { main: { provider: 'cc-chat', model: '' } } },
    { slots: { main: { provider: '', model: 'valid' } } },
    ...['Upper', 'bad_name', 'a'.repeat(25), 'constructor', 'prototype'].map(name => ({ slots: { ...valid, [name]: valid.main } })),
    ...['disabled', 'native', 'missing'].map(provider => ({ slots: { main: { provider, model: 'valid' } } })),
    ...['false', null, 0].map(upstream_stream => ({ slots: { main: { ...valid.main, upstream_stream } } })),
    { slots: { main: { ...valid.main, api_key: 'must-not-be-persisted' } } },
    { slots: { main: { ...valid.main, model: 'bad\nmodel' } } },
    { slots: { main: { ...valid.main, model: ' '.repeat(4) } } },
    { slots: valid, default_subagent: 'main' }, { slots: valid, default_subagent: 'missing' },
    ...[null, false, 0, {}, []].map(default_subagent => ({ slots: valid, default_subagent })),
  ];
  for (const input of bad) {
    const result = await api('/api/dsh', { expected_revision: state.data.revision, ...input }, 'PUT');
    assert.equal(result.status, 400, JSON.stringify(input) + ': ' + result.text);
    assert.equal(fs.readFileSync(routeFile, 'utf8'), before);
    assert.equal(result.text.includes('secret-'), false);
  }
  for (const text of ['{', '[]', 'null', '42']) {
    assert.equal((await api('/api/dsh', text, 'PUT')).status, 400, text);
    assert.equal(fs.readFileSync(routeFile, 'utf8'), before);
  }
  assert.equal(hits.length, 0);
});

test('stale revision, external edit, invalid JSON and deleted route file refuse overwrite with 409', async () => {
  const first = await configure({ main: { provider: 'cc-chat', model: 'first' } });
  await configure({ main: { provider: 'cc-chat', model: 'second' } });
  const input = { expected_revision: first.revision, slots: { main: { provider: 'cc-chat', model: 'third' } } };
  assert.equal((await api('/api/dsh', input, 'PUT')).status, 409);
  const state = await readState();
  const original = fs.readFileSync(routeFile, 'utf8');
  input.expected_revision = state.data.revision;
  try {
    for (const text of [JSON.stringify({ version: 1, slots: { main: { provider: 'cc-chat', model: 'external' } }, default_subagent: '' }), '{']) {
      fs.writeFileSync(routeFile, text);
      assert.equal((await api('/api/dsh', input, 'PUT')).status, 409);
      assert.equal(fs.readFileSync(routeFile, 'utf8'), text);
    }
    fs.unlinkSync(routeFile);
    assert.equal((await api('/api/dsh', input, 'PUT')).status, 409);
    assert.equal(fs.existsSync(routeFile), false);
  } finally { fs.writeFileSync(routeFile, original); }
});

test('client synchronization requires literal confirmation and never touches the real profile', async () => {
  const state = await configure({ main: { provider: 'cc-chat', model: 'sync-model' } });
  for (const confirm of [undefined, false, 'true', 1]) {
    const result = await api('/api/dsh/sync', { expected_revision: state.revision, ...(confirm === undefined ? {} : { confirm }) }, 'POST');
    assert.equal(result.status, 400, result.text);
    assert.equal(fs.existsSync(CONFIG), false);
  }
  const stale = await api('/api/dsh/sync', { expected_revision: 'stale', confirm: true }, 'POST');
  assert.equal(stale.status, 409);
  const absent = await api('/api/dsh/sync', { expected_revision: state.revision, confirm: true }, 'POST');
  assert.equal(absent.status, 409, absent.text);
  assert.equal(fs.existsSync(CONFIG), false);
  assert.equal(absent.text.includes('secret-'), false);
});

for (const id of ['cc-chat', 'cc-responses', 'cx-chat', 'cx-responses']) {
  for (const name of ['main', 'research-2']) {
    test(`${id} ${name}: nonstream upstream becomes client SSE with real model, Key, tools and usage`, async () => {
      const slots = { main: { provider: 'cc-chat', model: 'main-other', upstream_stream: true },
        'research-2': { provider: 'cx-responses', model: 'worker-other', upstream_stream: true } };
      slots[name] = { provider: id, model: `${id}-${name}-real`, upstream_stream: false };
      await configure(slots, 'research-2');
      mod._state.slotMap = { claude: { main: { provider: 'native', model: 'must-not-route', dropTools: ['Lookup'] },
        'research-2': { provider: 'native', model: 'must-not-route', dropTools: ['Lookup'] } }, codex: {} };
      const result = await send(name, true, '/dsh/v1/responses', { stream_options: { include_usage: true } });
      assert.equal(result.status, 200, result.text);
      assert.match(result.headers['content-type'], /text\/event-stream/);
      assert.equal(result.headers['x-mixrouter-app'], 'claude');
      assert.equal(result.headers['x-mixrouter-model'], `${id}-${name}-real`);
      assert.equal(hits.length, 1);
      const sent = hits[0];
      assert.equal(sent.path, `/${id}/v1/${id.endsWith('chat') ? 'chat/completions' : 'responses'}`);
      assert.equal(sent.body.model, `${id}-${name}-real`);
      assert.equal(sent.body.stream, false);
      assert.equal(sent.body.stream_options, undefined);
      assert.equal(sent.headers.accept, 'application/json');
      assert.equal(sent.headers.authorization, `Bearer secret-${id}-active`);
      assert.equal(sent.headers['x-api-key'], undefined);
      assert.equal(sent.body.tools.length, 1, 'Claude dropTools must not apply to Harness');
      assert.equal(sent.body.tools[0].type, 'function');
      const tool = id.endsWith('chat') ? sent.body.tools[0].function : sent.body.tools[0];
      assert.equal(tool.name, 'Lookup');
      assert.equal(tool.strict, false);
      const output = responseResult(result);
      assertResult(output);
      if (!id.endsWith('chat')) assert.deepEqual(output, responsesJson(`${id}-${name}-real`));
      const logs = await api(`/api/logs?model=mixr-dsh-${name}`);
      const entry = logs.data.logs[0];
      assert.equal(entry.app, 'claude');
      assert.equal(entry.rule, `slot:dsh/${name}`);
      assert.equal(entry.slot, name);
      assert.equal(entry.model_out, `${id}-${name}-real`);
      assert.deepEqual({ in: entry.in, out: entry.out, cache_read: entry.cache_read }, { in: 50, out: 12, cache_read: 8 });
      assert.equal(entry.tools_dropped, undefined);
    });
  }
}

for (const id of ['cc-chat', 'cx-responses']) {
  test(`${id}: main and subagent stream modes are independent, explicit true and omitted defaults remain streaming`, async () => {
    await configure({ main: { provider: id, model: 'buffered-main', upstream_stream: false },
      worker: { provider: id, model: 'stream-worker', upstream_stream: true },
      inherited: { provider: id, model: 'default-worker' } }, 'worker');
    for (const [name, expected] of [['main', false], ['worker', true], ['inherited', true]]) {
      const result = await send(name);
      assert.equal(result.status, 200, result.text);
      assert.equal(hits.at(-1).body.stream, expected);
      assert.equal(hits.at(-1).headers.accept, expected ? 'text/event-stream' : 'application/json');
      assertResult(responseResult(result));
    }
    const state = await readState();
    assert.equal(Object.hasOwn(state.data.slots.inherited, 'upstream_stream'), false);
    assert.equal(state.data.slots.worker.upstream_stream, true);
  });
}

test('saved Harness slots read the current provider Key on every request and fail closed after provider deletion', async () => {
  await configure({ main: { provider: 'cc-chat', model: 'current-main', upstream_stream: false },
    worker: { provider: 'cx-responses', model: 'current-worker', upstream_stream: false } }, 'worker');
  for (const [name, id] of [['main', 'cc-chat'], ['worker', 'cx-responses']]) {
    const old = channel(id);
    const replacement = { ...old, api_key: `secret-${id}-replacement`,
      keys: [{ id: 'replacement', label: 'replacement', key: `secret-${id}-replacement` }], active_key: 'replacement' };
    const group = id.startsWith('cc-') ? 'claude' : 'codex';
    mod._state.store[group] = mod._state.store[group].map(p => p.id === id ? replacement : p);
    const result = await send(name);
    assert.equal(result.status, 200, result.text);
    assert.equal(hits.at(-1).headers.authorization, `Bearer secret-${id}-replacement`);
    mod._state.store[group] = mod._state.store[group].filter(p => p.id !== id);
    const before = hits.length;
    const missing = await send(name);
    assert.equal(missing.status, 503, missing.text);
    assert.equal(missing.data.error.code, 'no_route_error');
    assert.equal(hits.length, before, 'deleted providers must not use stale credentials');
  }
});

test('nonstream Responses client stays JSON and native Chat client receives SSE with tool calls and usage', async () => {
  await configure({ main: { provider: 'cx-responses', model: 'responses-real', upstream_stream: false },
    worker: { provider: 'cx-chat', model: 'chat-real', upstream_stream: false } }, 'worker');
  const buffered = await send('main', false);
  assert.equal(buffered.status, 200, buffered.text);
  assert.match(buffered.headers['content-type'], /application\/json/);
  assert.deepEqual(buffered.data, responsesJson('responses-real'));
  const streamed = await send('worker', true, '/dsh/v1/chat/completions');
  assert.equal(streamed.status, 200, streamed.text);
  assert.match(streamed.headers['content-type'], /text\/event-stream/);
  assert.equal(hits.at(-1).body.stream, false);
  const frames = wireResponses.parseSseEvents(streamed.text).events;
  const call = frames.find(frame => frame.choices?.[0]?.delta?.tool_calls).choices[0].delta.tool_calls[0];
  assert.equal(call.function.name, 'Lookup');
  assert.equal(call.function.arguments, '{"q":"value"}');
  assert.deepEqual(frames.at(-1).usage, chatJson('chat-real').usage);
  assert.ok(streamed.text.endsWith('data: [DONE]\n\n'));
});

test('Harness identity has its own dsh:codex namespace and bypasses Claude content rules, slots, pins and Key overrides', async () => {
  await configure({ main: { provider: 'cc-chat', model: 'harness-real', upstream_stream: false } });
  mod._state.routes = { rules: [mod.normalizeRule({ id: 'claude-content', app: 'claude', match: '',
    provider: 'native', model: 'content-hijack', when: { body: 'fixture compact marker' }, priority: 10000 })],
    default: mod.normalizeRule({ provider: 'native', model: 'default-hijack' }) };
  mod._state.slotMap = { claude: { main: { provider: 'native', model: 'slot-hijack' } }, codex: {} };
  const routing = { keys: { 'cc-chat': 'other' }, slots: { main: { provider: 'native', model: 'override-hijack', key_id: 'other' } } };
  mod._state.bindSession('cc:shared', 'native', { app: 'claude', model: 'pin-hijack', pinned: true, routing });
  mod._state.bindSession('cx:shared', 'cx-responses', { app: 'codex', model: 'codex-hijack', pinned: true, routing });
  mod._state.bindSession('dsh:cx:shared', 'native', { app: 'claude', model: 'dsh-pin-hijack', pinned: true, routing });
  const ccBefore = structuredClone(mod._state.sessions.get('cc:shared'));
  const cxBefore = structuredClone(mod._state.sessions.get('cx:shared'));
  const result = await send('main', true, '/dsh/v1/responses', { instructions: 'fixture compact marker' },
    { 'session-id': 'shared', 'x-claude-code-session-id': 'shared' });
  assert.equal(result.status, 200, result.text);
  assert.equal(hits[0].body.model, 'harness-real');
  assert.equal(hits[0].headers.authorization, 'Bearer secret-cc-chat-active');
  assert.deepEqual(mod._state.sessions.get('cc:shared'), ccBefore);
  assert.deepEqual(mod._state.sessions.get('cx:shared'), cxBefore);
  const harness = mod._state.sessions.get('dsh:cx:shared');
  assert.equal(harness.app, 'claude');
  assert.equal(harness.reqs, 1);
  assert.equal(harness.actual.providerId, 'cc-chat');
  assert.equal(harness.actual.model, 'harness-real');
  assert.equal(harness.pinned, true, 'ignoring a pin for this slot must not erase it');
  assert.deepEqual(harness.routing, routing);
});

test('Harness creates dsh-prefixed Codex header, metadata and fingerprint identities', async () => {
  await configure({ main: { provider: 'cc-chat', model: 'identity-real', upstream_stream: false } });
  for (const [headers, extra] of [[{ 'thread-id': 'identity-header' }, {}],
    [{}, { prompt_cache_key: 'identity-metadata' }], [{}, {}]]) {
    const body = { model: 'mixr-dsh-main', stream: false, input: 'identity input', ...extra };
    const identity = mod.sessionIdentity({ headers }, body, 'codex');
    const result = await request(proxy, '/dsh/v1/responses', 'POST', body, headers);
    assert.equal(result.status, 200, result.text);
    const record = mod._state.sessions.get('dsh:' + identity.key);
    assert.ok(record, 'expected dsh:' + identity.key);
    assert.equal(record.app, 'claude');
    assert.equal(mod._state.sessions.has(identity.key), false);
  }
});

test('mixr-dsh aliases do not hijack ordinary Claude or Codex route resolution', async () => {
  await configure({ main: { provider: 'cc-chat', model: 'harness-only', upstream_stream: false } });
  mod._state.routes = { rules: [
    mod.normalizeRule({ id: 'ordinary-claude', app: 'claude', match: 'mixr-dsh-main', provider: 'cc-chat', model: 'ordinary-claude-model' }),
    mod.normalizeRule({ id: 'ordinary-codex', app: 'codex', match: 'mixr-dsh-main', provider: 'cx-chat', model: 'ordinary-codex-model' }),
  ], default: mod.normalizeRule({}) };
  const cc = await request(proxy, '/v1/messages', 'POST', { model: 'mixr-dsh-main', stream: false,
    messages: [{ role: 'user', content: 'ordinary Claude' }] }, { 'x-claude-code-session-id': 'ordinary' });
  assert.equal(cc.status, 200, cc.text);
  assert.equal(hits.at(-1).body.model, 'ordinary-claude-model');
  assert.equal(hits.at(-1).headers.authorization, 'Bearer secret-cc-chat-active');
  const cx = await request(proxy, '/v1/responses', 'POST', { model: 'mixr-dsh-main', stream: false, input: 'ordinary Codex' }, { 'session-id': 'ordinary' });
  assert.equal(cx.status, 200, cx.text);
  assert.equal(hits.at(-1).body.model, 'ordinary-codex-model');
  assert.equal(hits.at(-1).headers.authorization, 'Bearer secret-cx-chat-active');
  assert.equal(mod._state.sessions.has('dsh:cx:ordinary'), false);
});

test('Harness endpoint classification stays Claude while its local and upstream errors have OpenAI shapes', async () => {
  for (const endpoint of ['/dsh/v1/responses', '/dsh/v1/chat/completions/?q=1']) {
    const ep = mod.classifyProxyRequest({ url: endpoint });
    assert.equal(ep.app, 'claude'); assert.equal(ep.client, 'dsh');
    assert.ok(ep.path.startsWith('/v1/'));
  }
  await configure({ main: { provider: 'cx-responses', model: 'error-real', upstream_stream: false } });
  const requests = [
    ['/dsh/v1/responses', 'POST', '{', {}, 400, 'invalid_request_error'],
    ['/dsh/v1/responses', 'POST', {}, { 'Content-Type': 'text/plain' }, 415, 'invalid_request_error'],
    ['/dsh/v1/responses', 'POST', {}, { Origin: 'https://external.invalid' }, 403, 'permission_error'],
    ['/dsh/v1/unknown', 'GET', undefined, {}, 404, 'not_found_error'],
    ['/dsh/v1/responses', 'POST', { model: 'mixr-dsh-missing' }, {}, 503, 'no_route_error'],
    ['/dsh/v1/chat/completions', 'POST', { model: 'mixr-dsh-main' }, {}, 400, 'wire_api_mismatch_error'],
  ];
  for (const [endpoint, method, body, headers, status, type] of requests) {
    const result = await request(proxy, endpoint, method, body, headers);
    assert.equal(result.status, status, result.text);
    assert.equal(result.data.error.type, type.replace(/_error$/, ''), result.text);
    assert.equal(result.data.error.code, type, result.text);
    assert.equal(result.data.type, undefined);
  }
  assert.equal(hits.length, 0);
  channel('cx-responses').enabled = false;
  const disabled = await send();
  assert.equal(disabled.status, 503);
  assert.equal(disabled.data.error.type, 'provider_disabled');
  assert.equal(disabled.data.error.code, 'provider_disabled_error');
  channel('cx-responses').enabled = true;
  upstreamStatus = 400;
  const rejected = await send();
  assert.equal(rejected.status, 400, rejected.text);
  assert.equal(rejected.data.error.code, 'fixture_error');
  assert.equal(rejected.data.type, undefined);
});

test('startup malformed or invalid dsh.json fails closed and preserves its original bytes in an isolated child', () => {
  const childRoot = path.join(TMP, 'child');
  fs.mkdirSync(childRoot);
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { createDshRouting } = require(${JSON.stringify(path.resolve(__dirname, '../lib/dsh-routing'))});
    const root = process.env.MIXR_DATA_DIR;
    const file = path.join(root, 'dsh.json');
    const original = fs.readFileSync(file, 'utf8');
    const routing = createDshRouting({ root, home: process.env.HOME, env: process.env,
      routerURL: 'http://127.0.0.1:8787', getProviders: () => [{ id: 'chat', wire_api: 'chat', enabled: true, api_key: 'secret-child' }] });
    const state = routing.read();
    let saveStatus;
    try { routing.save({ expected_revision: state.revision, slots: { main: { provider: 'chat', model: 'valid' } } }); }
    catch (error) { saveStatus = error.statusCode; }
    process.stdout.write(JSON.stringify({ error: !!state.error, slots: state.slots,
      resolved: routing.resolve('mixr-dsh-main'), saveStatus, unchanged: fs.readFileSync(file, 'utf8') === original }));
  `;
  for (const text of ['{"secret":"sensitive",', '[]', 'null',
    JSON.stringify({ version: 2, slots: { main: { provider: 'chat', model: 'valid' } } }),
    JSON.stringify({ version: 1, slots: {}, default_subagent: '' }),
    JSON.stringify({ version: 1, slots: { main: { provider: 'chat', model: 'valid', upstream_stream: 'false' } }, default_subagent: '' })]) {
    fs.writeFileSync(path.join(childRoot, 'dsh.json'), text);
    const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: childRoot, MIXR_DATA_DIR: childRoot, MIXR_DSH_CONFIG: path.join(childRoot, 'profile.yml') } });
    const result = JSON.parse(output);
    assert.deepEqual(result, { error: true, slots: {}, resolved: null, saveStatus: 409, unchanged: true }, text);
    assert.equal(output.includes('secret-child'), false);
    assert.equal(output.includes('sensitive'), false);
  }
});

test('routing factory enforces the 32-slot limit and trims freeform models without requiring provider discovery', () => {
  const root = path.join(TMP, 'factory'); fs.mkdirSync(root);
  const routing = createDshRouting({ root, home: HOME, env: { ...process.env, MIXR_DATA_DIR: root },
    routerURL: 'http://127.0.0.1:8787', getProviders: () => mod._state.store.claude });
  const slots = { main: { provider: 'cc-chat', model: '  arbitrary/model  ' } };
  for (let i = 0; i < 31; i++) slots['worker-' + i] = { provider: 'cc-chat', model: 'undiscovered' };
  const saved = routing.save({ expected_revision: routing.read().revision, slots });
  assert.equal(Object.keys(saved.slots).length, 32);
  assert.equal(saved.slots.main.model, 'arbitrary/model');
  assert.equal(saved.default_subagent, '');
  assert.throws(() => routing.save({ expected_revision: saved.revision, slots: { ...slots, overflow: slots.main } }),
    error => error.statusCode === 400 && /32/.test(error.message));
});
