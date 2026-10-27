'use strict';
// Synthetic fixtures only: shapes copied from the installed Codex client's real wire body
// (captured locally, text replaced with placeholders) and the three AgentRouter error
// envelopes seen in the 2026-10-26 rollout. Both official hostnames are rewritten onto a
// loopback fixture before any network I/O, so no byte leaves the machine and no real key is used.
//
// What this file pins down: every recoverable decision leaves one fixed classification in
// the request log. A 400 the user can see must always answer "was recovery attempted, and
// if not, at which step did it stop" — including the cases that used to be silent (a repeat
// failure after a successful projection, or a retry the shared budget refused).
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectResponsesHistory, replayableUnprojectedHistory } = require('../lib/responses-history');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-codex-azure-wire-'));
Object.assign(process.env, {
  MIXR_DATA_DIR: root, MIXR_CLAUDE_SETTINGS: path.join(root, 'settings.json'),
  MIXR_CODEX_CONFIG: path.join(root, 'config.toml'), MIXR_MAX_ATTEMPTS: '3',
  MIXR_CONV_RETRIES: '2', MIXR_RETRY_DELAY_MS: '10', MIXR_SSE_KEEPALIVE_MS: '0',
  MIXR_TOTAL_DEADLINE_MS: '6000', MIXR_STREAM_IDLE_TIMEOUT_MS: '500', MIXR_RESPONSE_ARCHIVE: 'off',
  MIXR_UPSTREAM_PROXY: '',
});
const mod = require('../mixrouter');
const { destroyAgents } = require('../lib/upstream-proxy');
const HOSTS = ['ps.air-outer.com', 'agentrouter.org'];
const MAX_UPSTREAM_CALLS = 5; // MIXR_MAX_ATTEMPTS 3 + MIXR_CONV_RETRIES 2

const RESOURCE_MESSAGE = 'The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it.';
// 1. Plain envelope: one structured JSON body behind an SSE MIME type.
const plainError = (trace = 'fixture') => ({ error: {
  message: `${RESOURCE_MESSAGE} [trace_id=${trace}]`, type: 'invalid_request_error', param: '', code: null,
} });
// 2. The gateway's own decode wrapper: the real Azure body is embedded as raw text, code is a number.
const decodeError = (trace = 'fixture') => ({ error: {
  message: 'failed to decode error response: json: cannot unmarshal number into Go struct field ResponseError.error.code of type string, raw: '
    + JSON.stringify({ error: { code: 0, message: `${RESOURCE_MESSAGE} trace_id: ${trace}`, type: 'invalid_request_error' } })
    + ` [trace_id=${trace}]`,
  type: 'invalid_request_error', param: '', code: null,
} });
// 3. The narrow official-AgentRouter history signature (a 400 with no Azure sentence at all).
const narrowError = (trace = 'fixture') => ({ error: {
  message: `Upstream rejected the request as invalid [trace_id=${trace}]`, type: 'invalid_request_error', param: '', code: null,
} });

function frame(event) { return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`; }
const answerItem = { id: 'msg-fixture-answer', type: 'message', role: 'assistant', status: 'completed',
  phase: 'final_answer', content: [{ type: 'output_text', text: 'Fixture answer.', annotations: [] }] };
const completed = { id: 'resp-fixture-success', object: 'response', status: 'completed', output: [answerItem],
  usage: { input_tokens: 11, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } } };
const successBytes = frame({ type: 'response.created', response: { ...completed, status: 'in_progress', output: [], usage: null } })
  + frame({ type: 'response.output_item.done', output_index: 0, item: answerItem })
  + frame({ type: 'response.completed', response: completed });

// Item shapes exactly as the installed client sends them (verified against a local capture of
// the 2026-10-26 session): reasoning carries `content: null`; tool results alternate between a
// plain string and an inline content array; Codex mints an id on every item it emitted.
function wireHistory({ builtin = true } = {}) {
  const tools = [{ type: 'function', name: 'shell', strict: false,
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }];
  const input = [
    { type: 'message', id: 'msg-fixture-developer', role: 'developer',
      content: [{ type: 'input_text', text: 'Fixture developer instructions.' }] },
    { type: 'message', id: 'msg-fixture-user', role: 'user',
      content: [{ type: 'input_text', text: 'Continue the fixture conversation.' }] },
    { type: 'reasoning', id: 'rs-fixture-empty', summary: [], content: null, encrypted_content: 'FIXTURE_CIPHER_1' },
    { type: 'function_call', id: 'fc-fixture-1', call_id: 'call-fixture-1', name: 'shell',
      arguments: '{"command":"printf fixture"}' },
    { type: 'function_call_output', id: 'fco-fixture-1', call_id: 'call-fixture-1', output: 'fixture output one' },
    { type: 'reasoning', id: 'rs-fixture-summary', summary: [{ type: 'summary_text', text: 'Fixture reasoning summary.' }],
      content: null, encrypted_content: 'FIXTURE_CIPHER_2' },
    { type: 'function_call', id: 'fc-fixture-2', call_id: 'call-fixture-2', namespace: 'shell',
      name: 'run', arguments: '{"command":"printf fixture two"}' },
    { type: 'function_call_output', id: 'fco-fixture-2', call_id: 'call-fixture-2',
      output: [{ type: 'input_text', text: 'fixture output two' }] },
  ];
  if (builtin) input.splice(4, 0, { type: 'web_search_call', id: 'ws-fixture-1', status: 'completed',
    action: { type: 'open_page', url: 'https://fixture.invalid/page' } });
  input.push({ type: 'message', id: 'msg-fixture-assistant', role: 'assistant', status: 'completed', phase: 'commentary',
    content: [{ type: 'output_text', text: 'Fixture progress note.', annotations: [] }] });
  input.push({ role: 'user', content: [{ type: 'input_text', text: 'Summarize the fixture.' }] });
  return { model: 'fixture-codex-model', stream: true, store: false, prompt_cache_key: 'fixture-cache',
    reasoning: { effort: 'high' }, include: ['reasoning.encrypted_content'], tools, tool_choice: 'auto',
    parallel_tool_calls: false, input };
}
const REMOVABLE = new Set(['message', 'reasoning', 'function_call', 'function_call_output']);
function projected(body) {
  const copy = structuredClone(body);
  for (const item of copy.input) if (REMOVABLE.has(item.type)) delete item.id;
  return copy;
}

let upstream, proxy, reply, seen, fixtureId = 0;
const sockets = new Set();
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;
function intercept(original, options, ...rest) {
  const hostname = typeof options === 'object' && options !== null ? options.hostname : null;
  if (HOSTS.includes(hostname)) {
    return originalHttpRequest.call(http, { ...options, protocol: 'http:', hostname: '127.0.0.1',
      port: upstream.address().port, agent: false }, ...rest);
  }
  assert.ok(hostname === '127.0.0.1', `unexpected non-loopback transport target: ${hostname}`);
  return original.call(http, options, ...rest);
}
function configure(host = HOSTS[0]) {
  const base = host === '127.0.0.1' ? `http://127.0.0.1:${upstream.address().port}/azure`
    : `${host.startsWith('http://') ? 'http' : 'https'}://${host.replace(/^http:\/\//, '')}/v1`;
  mod._state.store = { claude: [], codex: [{ id: 'azure-fixture', name: 'AgentRouter', enabled: true,
    api_key: 'synthetic-fixture-key', wire_api: 'responses', base_url: base, models: ['fixture-codex-model'] }] };
  mod._state.routes = { rules: [], default: mod.normalizeRule({ provider: 'azure-fixture' }) };
  mod._state.slotMap = { claude: {}, codex: { main: { provider: 'azure-fixture', model: 'fixture-codex-model' } } };
}
function reset() { fixtureId++; seen = []; mod._state.sessions.clear(); mod._state.cooldowns = {}; mod._state.resetPools(); configure(); }
function answer(res, bytes = successBytes, status = 200, mime = 'text/event-stream', headers = {}) {
  res.writeHead(status, { 'Content-Type': mime, ...headers }); res.end(bytes);
}
function ask(body, session = `codex-azure-${fixtureId}`) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/v1/responses',
      agent: false, headers: { 'Content-Type': 'application/json', 'session-id': session,
        originator: 'codex_cli_rs', 'User-Agent': 'codex_cli_rs/fixture', Connection: 'close' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.once('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString('utf8') });
      });
    });
    req.on('error', reject); req.setTimeout(8000, () => req.destroy(new Error('azure wire fixture timeout')));
    req.end(JSON.stringify(body));
  });
}
function logs() {
  const file = path.join(root, 'logs/requests.jsonl');
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
const lastLog = () => logs().at(-1);

before(async () => {
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.once('end', () => { seen.push({ url: req.url, headers: req.headers, bytes: Buffer.concat(chunks) }); reply(req, res); });
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  http.request = (options, ...rest) => intercept(originalHttpRequest, options, ...rest);
  https.request = (options, ...rest) => intercept(originalHttpsRequest, options, ...rest);
  proxy = await mod.listen(0, mod.proxyHandler);
});
beforeEach(reset);
after(async () => {
  http.request = originalHttpRequest; https.request = originalHttpsRequest;
  destroyAgents();
  for (const socket of sockets) socket.destroy();
  await Promise.all([upstream, proxy].filter(Boolean).map(server => new Promise(resolve => {
    server.closeAllConnections(); server.close(resolve);
  })));
  fs.rmSync(root, { recursive: true, force: true });
});

test('fixture reproduces the real split: the built-in item alone blocks projection but not replay', () => {
  const withBuiltin = wireHistory();
  assert.deepEqual(projectResponsesHistory(withBuiltin), { ok: false, code: 'unsupported_item_id' });
  assert.deepEqual(replayableUnprojectedHistory(withBuiltin), { ok: true });
  const withoutBuiltin = wireHistory({ builtin: false });
  const result = projectResponsesHistory(withoutBuiltin);
  assert.equal(result.ok, true, result.code);
  assert.deepEqual(result.body, projected(withoutBuiltin));
});

for (const [label, make, mime] of [
  ['plain Azure envelope', plainError, 'text/event-stream'],
  ['gateway decode wrapper', decodeError, 'text/event-stream'],
  ['decode wrapper over JSON', decodeError, 'application/json'],
  ['narrow AgentRouter history 400', narrowError, 'text/event-stream'],
]) test(`real wire shape + ${label} replays the identical bytes once`, async () => {
  const body = wireHistory(), original = structuredClone(body), raw = JSON.stringify(make('fixture-1'));
  reply = (_req, res) => seen.length === 1 ? answer(res, raw, 400, mime) : answer(res);
  const result = await ask(body);
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.bytes, Buffer.from(successBytes));
  assert.equal(seen.length, 2, 'exactly one recovery call');
  assert.deepEqual(seen[1].bytes, seen[0].bytes, 'nothing is stripped or rebuilt');
  assert.equal(JSON.parse(seen[1].bytes).input.find(item => item.type === 'web_search_call').id, 'ws-fixture-1');
  assert.deepEqual(body, original, 'the caller payload is never mutated');
  assert.equal(lastLog().attempts, 2);
  assert.equal(lastLog().retry_reason, 'unprojected_resource_retry');
  assert.equal(lastLog().resource_recovery_skipped, 'unsupported_item_id');
  assert.equal(lastLog().err || '', ''); assert.equal(lastLog().err_class || '', '');
});

test('the same wire shape without the built-in item is projected and the retry says so', async () => {
  const body = wireHistory({ builtin: false }), original = structuredClone(body), raw = JSON.stringify(plainError('fixture-2'));
  reply = (_req, res) => seen.length === 1 ? answer(res, raw, 400) : answer(res);
  const result = await ask(body);
  assert.equal(result.status, 200, result.text);
  assert.equal(seen.length, 2);
  assert.deepEqual(JSON.parse(seen[1].bytes), projected(original));
  assert.deepEqual(JSON.parse(seen[0].bytes), original);
  assert.equal(lastLog().attempts, 2);
  assert.equal(lastLog().retry_reason, 'resource_binding_recovery', 'a projection retry is not silent');
  assert.equal(lastLog().resource_recovery_skipped, undefined);
});

test('a resource error after a successful projection records projected_resource_retry instead of nothing', async () => {
  const body = wireHistory({ builtin: false }), original = structuredClone(body);
  reply = (_req, res) => answer(res, JSON.stringify(plainError(`fixture-repeat-${seen.length}`)), 400);
  const result = await ask(body);
  assert.equal(result.status, 400);
  assert.equal(seen.length, MAX_UPSTREAM_CALLS, 'the shared budget still bounds the repeats');
  assert.deepEqual(JSON.parse(seen[0].bytes), original);
  for (const request of seen.slice(1)) assert.deepEqual(request.bytes, seen[1].bytes, 'later attempts reuse one projection');
  assert.equal(lastLog().attempts, MAX_UPSTREAM_CALLS);
  assert.equal(lastLog().retry_reason, 'projected_resource_retry', 'the repeat is named, not silent');
  // A repeat after a projection is a retry, not an abandoned recovery: the skip enum stays
  // empty and retry_reason above is what tells the two apart in the request log.
  assert.equal(lastLog().resource_recovery_skipped, undefined);
  assert.match(lastLog().err, /different Azure OpenAI resource/);
});

test('a non-official target declines recovery but still leaves the fixed classification', async () => {
  for (const host of ['http://agentrouter.org', '127.0.0.1']) {
    reset();
    configure(host);
    const body = wireHistory(), original = structuredClone(body), raw = JSON.stringify(plainError('fixture-3'));
    reply = (_req, res) => answer(res, raw, 400);
    const result = await ask(body);
    assert.equal(seen.length, 1, host);
    assert.equal(result.status, 400, host);
    assert.equal(lastLog().attempts, 1, host);
    assert.equal(lastLog().retry_reason, undefined, host);
    assert.equal(lastLog().resource_recovery_skipped, 'unsupported_item_id', host);
    assert.deepEqual(body, original, host);
  }
});
