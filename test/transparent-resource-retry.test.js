'use strict';
// Synthetic fixtures only. Official AgentRouter hostnames are intercepted before DNS/network
// I/O, so every byte of test traffic stays on loopback and no real credential is used.
//
// What this file pins down: a request the classifier already judged recoverable (Azure resource
// binding or the narrow AgentRouter generic-400 history envelope) whose history the projector
// refuses because of a built-in item. The fix replays the **identical** outbound bytes inside the
// existing retry loop instead of giving up after one upstream call — and only when that is honest:
// official AgentRouter HTTPS, complete reviewable inline history, and nothing sent to the client.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectResponsesHistory, replayableUnprojectedHistory } = require('../lib/responses-history');
const { isOfficialAgentRouterHttps } = require('../lib/responses-recovery');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-transparent-retry-'));
Object.assign(process.env, {
  MIXR_DATA_DIR: root, MIXR_CLAUDE_SETTINGS: path.join(root, 'settings.json'),
  MIXR_CODEX_CONFIG: path.join(root, 'config.toml'), MIXR_MAX_ATTEMPTS: '3',
  MIXR_CONV_RETRIES: '2', MIXR_RETRY_DELAY_MS: '10', MIXR_SSE_KEEPALIVE_MS: '0',
  MIXR_TOTAL_DEADLINE_MS: '4000', MIXR_STREAM_IDLE_TIMEOUT_MS: '500', MIXR_RESPONSE_ARCHIVE: 'off',
  MIXR_UPSTREAM_PROXY: '',
});
const mod = require('../mixrouter');
const { destroyAgents } = require('../lib/upstream-proxy');
const HOSTS = ['ps.air-outer.com', 'agentrouter.org'];
const MAX_UPSTREAM_CALLS = 5; // MIXR_MAX_ATTEMPTS 3 + MIXR_CONV_RETRIES 2

const RESOURCE_MESSAGE = 'The requested item was created under a different Azure OpenAI resource. '
  + 'Use the same resource that created the item to access it. (request id: fixture-request-001)';
const resourceError = () => ({ error: { code: null, type: 'invalid_request_error', message: RESOURCE_MESSAGE } });
const genericError = (trace = 'fixture') => ({ error: {
  message: `Upstream rejected the request as invalid [trace_id=${trace}]`,
  type: 'invalid_request_error', param: '', code: null,
} });
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const created = frame({ type: 'response.created', response: { id: 'discard-created', status: 'in_progress', output: [] } });
const generatedCall = { type: 'function_call', id: 'fc-generated', call_id: 'generated-call',
  name: 'lookup', arguments: '{"q":"fixture"}', status: 'completed' };
const completed = { id: 'resp-success', object: 'response', status: 'completed', output: [generatedCall],
  usage: { input_tokens: 31, output_tokens: 9, input_tokens_details: { cached_tokens: 4 } } };
const successBytes = frame({ type: 'response.output_item.added', output_index: 0, item: { ...generatedCall, arguments: '' } })
  + frame({ type: 'response.function_call_arguments.delta', item_id: generatedCall.id, output_index: 0, delta: generatedCall.arguments })
  + frame({ type: 'response.completed', response: completed });

// Complete inline Codex history that includes one built-in item with a resource-owned id.
// The projector cannot strip that id, so it rejects with `unsupported_item_id`; nothing else
// about this history is unusual.
function history() {
  return { model: 'fixture-codex-model', stream: true, store: false, prompt_cache_key: 'fixture-cache',
    instructions: 'Use only synthetic fixtures.', reasoning: { effort: 'max' }, metadata: { client: 'codex' },
    tools: [{ type: 'function', name: 'lookup', strict: false,
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }],
    input: [
      { role: 'developer', content: 'Continue the inline synthetic history.' },
      { role: 'user', content: 'Search the fixture label, then summarize.' },
      { type: 'web_search_call', id: 'ws-fixture-1', status: 'completed', action: { type: 'search', query: 'fixture label' } },
      { type: 'message', id: 'msg-fixture-1', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Found one fixture label.', annotations: [] }] },
      { type: 'function_call', id: 'fc-fixture-1', call_id: 'call-fixture-1', name: 'lookup', arguments: '{"q":"fixture"}' },
      { type: 'function_call_output', call_id: 'call-fixture-1', status: 'completed', output: '{"hits":1}' },
      { role: 'user', content: [{ type: 'input_text', text: 'Summarize the fixture result.' }] },
    ] };
}

let upstream, proxy, reply, seen, fixtureId = 0;
const sockets = new Set();
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;
// Official hostnames never leave the machine: rewrite them onto the loopback fixture.
function intercept(original, request, options, ...rest) {
  const hostname = typeof options === 'object' && options !== null ? options.hostname : null;
  if (HOSTS.includes(hostname)) {
    return originalHttpRequest.call(http, { ...options, protocol: 'http:', hostname: '127.0.0.1',
      port: upstream.address().port, agent: false }, ...rest);
  }
  assert.ok(hostname === '127.0.0.1', `unexpected non-loopback transport target: ${hostname}`);
  return original.call(http, options, ...rest);
}
function configure({ host = HOSTS[0], wire = 'responses', other = false } = {}) {
  const provider = id => ({ id, name: id, enabled: true, api_key: 'synthetic-primary-key', wire_api: wire,
    base_url: host === '127.0.0.1' ? `http://127.0.0.1:${upstream.address().port}/${id}` : `${host.startsWith('http://') ? 'http' : 'https'}://${host.replace(/^http:\/\//, '')}/${id}`,
    models: ['fixture-codex-model'] });
  mod._state.store = { claude: [], codex: [provider('fixture-primary'), ...(other ? [provider('fixture-secondary')] : [])] };
  mod._state.routes = { rules: [], default: mod.normalizeRule({ pool: other
    ? ['fixture-primary', 'fixture-secondary'] : ['fixture-primary'], strategy: 'priority' }) };
}
function reset() {
  fixtureId++; seen = []; mod._state.sessions.clear(); mod._state.cooldowns = {}; mod._state.resetPools(); configure();
}
function answer(res, bytes = successBytes, status = 200, mime = 'text/event-stream', headers = {}) {
  res.writeHead(status, { 'Content-Type': mime, ...headers }); res.end(bytes);
}
function ask(body, session = `transparent-retry-${fixtureId}`) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/v1/responses',
      agent: false, headers: { 'Content-Type': 'application/json', 'session-id': session,
        'x-client-request-id': 'fixture-request-preserved', originator: 'codex-fixture',
        'User-Agent': 'codex-fixture/1.0', Connection: 'close' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.once('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString('utf8') });
      });
    });
    req.on('error', reject); req.setTimeout(6000, () => req.destroy(new Error('transparent retry fixture timeout')));
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
  http.request = (options, ...rest) => intercept(originalHttpRequest, null, options, ...rest);
  https.request = (options, ...rest) => intercept(originalHttpsRequest, null, options, ...rest);
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

// The fixture itself must be the case under discussion: projection refuses it for the built-in
// item only, and the replayable check proves nothing else about it is broken.
test('fixture: projection refuses only the built-in item and the rest is replayable', () => {
  const body = history();
  assert.deepEqual(projectResponsesHistory(body), { ok: false, code: 'unsupported_item_id' });
  assert.deepEqual(replayableUnprojectedHistory(body), { ok: true });
});

for (const host of HOSTS) test(`resource error + completed web_search_call replays identical bytes on ${host}`, async () => {
  configure({ host });
  const body = history(), original = structuredClone(body), raw = JSON.stringify(resourceError());
  reply = (_req, res) => seen.length === 1 ? answer(res, raw, 400, 'application/json') : answer(res);
  const result = await ask(body);
  assert.equal(result.status, 200, result.text); assert.deepEqual(result.bytes, Buffer.from(successBytes));
  assert.equal(seen.length, 2, 'one recovery call, not a second retry loop');
  // The whole point: not a projection — the exact same bytes go out again, built-in id included.
  assert.deepEqual(seen[1].bytes, seen[0].bytes, 'replayed bytes must be identical to the first attempt');
  assert.deepEqual(JSON.parse(seen[1].bytes), original);
  assert.equal(JSON.parse(seen[1].bytes).input[2].type, 'web_search_call');
  assert.equal(JSON.parse(seen[1].bytes).input[2].id, 'ws-fixture-1');
  assert.equal(seen[1].headers.authorization, seen[0].headers.authorization);
  assert.equal(seen[1].headers['session-id'], seen[0].headers['session-id']);
  assert.deepEqual(body, original, 'the caller payload is never mutated');
  assert.equal(lastLog().attempts, 2); assert.equal(lastLog().retry_reason, 'unprojected_resource_retry');
  assert.equal(lastLog().resource_recovery_skipped, 'unsupported_item_id');
  assert.equal(lastLog().err || '', ''); assert.equal(lastLog().err_class || '', ''); assert.ok(!lastLog().failover);
  assert.equal(lastLog().in, 31); assert.equal(lastLog().out, 9); assert.equal(lastLog().cache_read, 4);
});

test('narrow AgentRouter generic 400 with a completed web_search_call replays identical bytes', async () => {
  configure({ host: 'agentrouter.org' });
  const body = history(), original = structuredClone(body), raw = JSON.stringify(genericError());
  reply = (_req, res) => seen.length === 1 ? answer(res, raw, 400, 'text/event-stream') : answer(res);
  const result = await ask(body);
  assert.equal(result.status, 200, result.text); assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].bytes, seen[0].bytes);
  assert.deepEqual(JSON.parse(seen[1].bytes), original);
  assert.equal(lastLog().attempts, 2); assert.equal(lastLog().retry_reason, 'unprojected_resource_retry');
  assert.equal(lastLog().resource_recovery_skipped, 'unsupported_item_id');
  assert.equal(lastLog().err_class || '', '');
});

test('repeated failure stops at the shared cap and returns the real upstream error', async () => {
  configure({ host: 'agentrouter.org' });
  const body = history(), original = structuredClone(body);
  reply = (_req, res) => answer(res, JSON.stringify(resourceError()), 400, 'application/json', { 'x-request-id': `last-${seen.length}` });
  const result = await ask(body);
  assert.equal(seen.length, MAX_UPSTREAM_CALLS, 'the existing budget still bounds the retries');
  assert.equal(result.status, 400);
  assert.deepEqual(result.bytes, Buffer.from(JSON.stringify(resourceError())));
  assert.equal(result.headers['x-request-id'], `last-${MAX_UPSTREAM_CALLS}`);
  for (const request of seen) assert.deepEqual(request.bytes, seen[0].bytes);
  assert.equal(lastLog().attempts, MAX_UPSTREAM_CALLS);
  assert.equal(lastLog().retry_reason, 'unprojected_resource_retry');
  assert.equal(lastLog().resource_recovery_skipped, 'unsupported_item_id');
  assert.match(lastLog().err, /different Azure OpenAI resource/);
  assert.deepEqual(body, original);
});

// Each entry breaks a different safety requirement. None of them may consume a second upstream call.
const notReplayable = [
  ['unknown built-in field', body => { body.input[2].opaque = 'keep'; }],
  ['incomplete built-in item', body => { body.input[2].status = 'in_progress'; }],
  ['missing built-in action', body => { delete body.input[2].action; }],
  ['unknown action type', body => { body.input[2].action = { type: 'click' }; }],
  ['non-string action field', body => { body.input[2].action = { type: 'search' }; }],
  ['extra action field', body => { body.input[2].action = { type: 'search', query: 'fixture', extra: 'keep' }; }],
  ['previous_response_id', body => { body.previous_response_id = 'resp-reference-fixture'; }],
  ['conversation reference', body => { body.conversation = { id: 'conversation-reference-fixture' }; }],
  ['item_reference', body => { body.input.push({ type: 'item_reference', id: 'opaque-reference-fixture' }); }],
  ['unknown id-bearing item', body => { body.input.push({ type: 'opaque_item', id: 'opaque-id-fixture' }); }],
  ['missing tool result', body => { body.input = body.input.filter(item => item.type !== 'function_call_output'); }],
  ['orphan tool result', body => { body.input.push({ type: 'function_call_output', call_id: 'orphan-call', output: 'x' }); }],
  ['duplicate tool call', body => { body.input.push(structuredClone(body.input.find(item => item.type === 'function_call'))); }],
  ['internal item reference', body => { body.input.push({ type: 'item_reference', id: 'ws-fixture-1' }); }],
  ['no explicit input', body => { delete body.input; }],
  ['empty explicit input', body => { body.input = []; }],
];
for (const [label, mutate] of notReplayable) test(`${label} keeps the terminal error after a single upstream call`, async () => {
  configure({ host: 'agentrouter.org' });
  const body = history(); mutate(body);
  const original = structuredClone(body), raw = JSON.stringify(resourceError());
  assert.equal(replayableUnprojectedHistory(body).ok, false, 'fixture must actually be non-replayable');
  reply = (_req, res) => answer(res, raw, 400, 'application/json', { 'x-request-id': 'fixture-terminal' });
  const result = await ask(body);
  assert.equal(seen.length, 1); assert.equal(result.status, 400); assert.deepEqual(result.bytes, Buffer.from(raw));
  assert.equal(result.headers['x-request-id'], 'fixture-terminal');
  assert.equal(lastLog().attempts, 1); assert.equal(lastLog().retry_reason, undefined);
  assert.deepEqual(JSON.parse(seen[0].bytes), original); assert.deepEqual(body, original);
});

test('visible output before the resource error closes the replay window', async () => {
  configure({ host: 'agentrouter.org' });
  const raw = frame({ type: 'response.output_item.added', output_index: 0, item: { ...generatedCall, arguments: '' } })
    + `data: ${JSON.stringify(resourceError())}\n\n`;
  reply = (_req, res) => answer(res, raw, 400, 'text/event-stream');
  const result = await ask(history());
  assert.equal(result.status, 400); assert.equal(result.text, raw); assert.equal(seen.length, 1);
  assert.equal(lastLog().attempts, 1); assert.equal(lastLog().retry_reason, undefined);
});

test('non-official target keeps current behavior even for a resource error', async () => {
  // 127.0.0.1 = a plain self-hosted channel; http://agentrouter.org = the official host over
  // cleartext. Neither is the official HTTPS endpoint, so no byte is ever replayed there.
  // (A hostname that is neither official nor loopback is refused by the transport guard above.)
  for (const host of ['127.0.0.1', 'http://agentrouter.org']) {
    reset();
    configure({ host });
    const raw = JSON.stringify(resourceError());
    reply = (_req, res) => answer(res, raw, 400, 'application/json', { 'x-request-id': 'fixture-terminal' });
    const result = await ask(history());
    assert.equal(seen.length, 1, host); assert.equal(result.status, 400, host);
    assert.deepEqual(result.bytes, Buffer.from(raw), host);
    assert.equal(lastLog().attempts, 1, host); assert.equal(lastLog().retry_reason, undefined, host);
  }
});

test('the HTTPS-only target rule is what gates the fallback', () => {
  assert.equal(isOfficialAgentRouterHttps({ base_url: 'https://agentrouter.org/v1' }), true);
  assert.equal(isOfficialAgentRouterHttps({ base_url: 'https://ps.air-outer.com/v1' }), true);
  for (const base_url of ['http://agentrouter.org/v1', 'https://api.agentrouter.org/v1',
    'https://agentrouter.org.evil.invalid/v1', 'https://user:pass@agentrouter.org/v1', 'not a URL', undefined]) {
    assert.equal(isOfficialAgentRouterHttps({ base_url }), false, String(base_url));
  }
});

test('concurrent requests keep separate retry budgets', async () => {
  configure({ host: 'agentrouter.org' });
  const raw = JSON.stringify(resourceError());
  reply = (_req, res) => answer(res, raw, 400, 'application/json');
  const before = logs().length;
  const [first, second] = await Promise.all([
    ask(history(), `transparent-retry-concurrent-a-${fixtureId}`),
    ask(history(), `transparent-retry-concurrent-b-${fixtureId}`),
  ]);
  assert.equal(first.status, 400); assert.equal(second.status, 400);
  assert.equal(seen.length, MAX_UPSTREAM_CALLS * 2, 'budgets are per request, not shared');
  const entries = logs().slice(before);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.attempts, MAX_UPSTREAM_CALLS);
    assert.equal(entry.retry_reason, 'unprojected_resource_retry');
  }
});
