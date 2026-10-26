'use strict';
// Synthetic traffic only: official HTTPS hosts are mapped to loopback before DNS.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { waitFor } = require('./wait-for');
const { projectEncryptedReasoning } = require('../lib/responses-encrypted');
const { projectResponsesHistory } = require('../lib/responses-history');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-encrypted-recovery-'));
Object.assign(process.env, {
  MIXR_DATA_DIR: root, MIXR_CLAUDE_SETTINGS: path.join(root, 'settings.json'),
  MIXR_CODEX_CONFIG: path.join(root, 'config.toml'), MIXR_MAX_ATTEMPTS: '3',
  MIXR_CONV_RETRIES: '2', MIXR_RETRY_DELAY_MS: '20', MIXR_SSE_KEEPALIVE_MS: '0',
  MIXR_TOTAL_DEADLINE_MS: '3000', MIXR_STREAM_IDLE_TIMEOUT_MS: '500', MIXR_RESPONSE_ARCHIVE: 'off',
  MIXR_UPSTREAM_PROXY: '',
});
const mod = require('../mixrouter');
const { destroyAgents } = require('../lib/upstream-proxy');
const HOSTS = ['ps.air-outer.com', 'agentrouter.org'];
const OTHER_HOSTS = ['ps.air-outer.com.evil.invalid', 'api.agentrouter.org', 'unknown.invalid'];
const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const encrypted = () => ({ error: { type: 'invalid_request_error', code: 'invalid_encrypted_content',
  message: 'The encrypted content could not be verified.', param: 'input' } });
const failure = (code = 'invalid_encrypted_content') => ({ type: 'response.failed', response: { id: 'failed-encrypted',
  object: 'response', status: 'failed', output: [], error: code === 'invalid_encrypted_content' ? encrypted().error
    : { type: 'server_error', code, message: 'Upstream request failed' } } });
const azure = { error: { type: 'invalid_request_error', message: 'The requested item was created under a different Azure OpenAI resource.' } };
const created = frame({ type: 'response.created', response: { id: 'discard-created', status: 'in_progress', output: [] } });
const completed = { id: 'encrypted-success', object: 'response', status: 'completed',
  output: [{ type: 'message', id: 'generated-once', role: 'assistant', content: [{ type: 'output_text', text: 'ENCRYPTED_RECOVERY_OK' }] }],
  usage: { input_tokens: 19, output_tokens: 6, input_tokens_details: { cached_tokens: 4 } } };
const successBytes = frame({ type: 'response.output_text.delta', delta: 'ENCRYPTED_RECOVERY_OK' })
  + frame({ type: 'response.completed', response: completed });
function history() {
  return { model: 'fixture-codex-model', stream: true, store: false, prompt_cache_key: 'cache-preserved',
    reasoning: { effort: 'max', summary: 'detailed' }, include: ['reasoning.encrypted_content'],
    metadata: { id: 'metadata-kept', client: 'codex' }, tools: [{ type: 'function', name: 'Read', strict: false,
      parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } }], input: [
      { role: 'developer', content: 'Complete local synthetic history only.' },
      { type: 'message', id: 'msg-old', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Earlier answer.' }] },
      { type: 'reasoning', id: 'rs-old', summary: [], content: null, encrypted_content: 'CIPHER_FIXTURE' },
      { type: 'reasoning', id: 'rs-readable', summary: [{ type: 'summary_text', text: 'Readable summary.' }], encrypted_content: 'CIPHER_READABLE' },
      { type: 'function_call', id: 'fc-old', call_id: 'call-preserved', name: 'Read', arguments: '{"file":"fixture.txt"}' },
      { type: 'function_call_output', id: 'fco-old', call_id: 'call-preserved', output: [
        { type: 'input_text', text: '{"id":"tool-result-kept"}' },
        { type: 'input_image', image_url: 'data:image/png;base64,RklYVFVSRQ==' },
      ] },
      { role: 'user', content: 'Continue.' },
    ] };
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
let upstream, proxy, reply, seen, closed, fixtureId = 0;
const sockets = new Set();
const originalHttpRequest = http.request, originalHttpsRequest = https.request;
function intercept(original, options, ...rest) {
  const hostname = typeof options === 'object' && options !== null ? options.hostname : null;
  if ([...HOSTS, ...OTHER_HOSTS].includes(hostname)) {
    return originalHttpRequest.call(http, { ...options, protocol: 'http:', hostname: '127.0.0.1',
      port: upstream.address().port, agent: false }, ...rest);
  }
  assert.equal(hostname, '127.0.0.1', `non-loopback transport target: ${hostname}`);
  return original.call(http, options, ...rest);
}
function configure({ host = HOSTS[0], protocol = 'https:', keyFallback = true, other = true, override } = {}) {
  const provider = id => ({ id, name: id, enabled: true, wire_api: 'responses', api_key: 'synthetic-primary-key',
    base_url: host === '127.0.0.1' ? `http://127.0.0.1:${upstream.address().port}/${id}` : `${protocol}//${host}/${id}`,
    models: ['fixture-codex-model'], key_fallback: keyFallback, active_key: `key-a-${fixtureId}`, keys: [
      { id: `key-a-${fixtureId}`, key: 'synthetic-primary-key', enabled: true },
      { id: `key-b-${fixtureId}`, key: 'synthetic-alternate-key', enabled: true },
    ] });
  mod._state.store = { claude: [], codex: [provider('primary'), ...(other ? [provider('secondary')] : [])] };
  mod._state.routes = { rules: [], default: mod.normalizeRule({ pool: other ? ['primary', 'secondary'] : ['primary'], strategy: 'priority',
    ...(override === undefined ? {} : { upstream_stream: override }) }) };
}
function answer(res, text = successBytes, status = 200, mime = 'text/event-stream', headers = {}) {
  res.writeHead(status, { 'Content-Type': mime, ...headers }); res.end(text);
}
function ask(body = history(), endpoint = '/v1/responses', port = proxy.address().port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: endpoint, agent: false,
      headers: { 'Content-Type': 'application/json', 'session-id': `encrypted-test-${fixtureId}`,
        'x-client-request-id': 'request-preserved', originator: 'codex-fixture', Connection: 'close' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.once('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString('utf8') }); });
    });
    req.on('error', reject); req.setTimeout(6000, () => req.destroy(new Error('encrypted fixture timeout')));
    req.end(JSON.stringify(body));
  });
}
function logs() {
  const file = path.join(root, 'logs/requests.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
const lastLog = () => logs().at(-1);
function assertBinding() {
  for (const request of seen) {
    assert.equal(request.url, '/primary/v1/responses'); assert.equal(request.body.model, 'fixture-codex-model');
    assert.equal(request.headers.authorization, 'Bearer synthetic-primary-key'); assert.equal(request.body.reasoning.effort, 'max');
    const { 'content-length': firstLength, ...firstHeaders } = seen[0].headers;
    const { 'content-length': nextLength, ...nextHeaders } = request.headers;
    assert.deepEqual(nextHeaders, firstHeaders);
    if (firstLength !== undefined) assert.equal(Number(firstLength), seen[0].bytes.length);
    if (nextLength !== undefined) assert.equal(Number(nextLength), request.bytes.length);
  }
  assert.equal(lastLog().provider, 'primary'); assert.equal(lastLog().model_out, 'fixture-codex-model');
  assert.equal(lastLog().key_id, `key-a-${fixtureId}`); assert.equal(lastLog().effort, 'max'); assert.ok(!lastLog().failover);
}
function recovered(result, count = 2) {
  assert.equal(result.status, 200, result.text); assert.equal(result.headers['x-mixrouter-recovery'], 'encrypted-reasoning-dropped');
  assert.equal(seen.length, count); assert.equal(lastLog().attempts, count);
  assert.equal(lastLog().retry_reason, 'encrypted_reasoning_downgrade');
  assert.equal(lastLog().err || '', ''); assert.equal(lastLog().err_class || '', '');
  assert.equal(lastLog().in, 19); assert.equal(lastLog().out, 6); assert.equal(lastLog().cache_read, 4);
  assert.doesNotMatch(result.text, /CIPHER_|invalid_encrypted_content|failed-encrypted/); assertBinding();
}
before(async () => {
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.once('end', () => { const bytes = Buffer.concat(chunks); seen.push({ url: req.url, headers: req.headers, bytes, body: JSON.parse(bytes) }); reply(req, res); });
    res.once('close', () => closed++);
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  http.request = (options, ...rest) => intercept(originalHttpRequest, options, ...rest);
  https.request = (options, ...rest) => intercept(originalHttpsRequest, options, ...rest);
  proxy = await mod.listen(0, mod.proxyHandler);
});
beforeEach(() => {
  fixtureId++; seen = []; closed = 0; mod._state.sessions.clear(); mod._state.cooldowns = {}; mod._state.resetPools(); configure();
});
after(async () => {
  http.request = originalHttpRequest; https.request = originalHttpsRequest; destroyAgents();
  for (const socket of sockets) socket.destroy();
  await Promise.all([upstream, proxy].filter(Boolean).map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  fs.rmSync(root, { recursive: true, force: true });
});

for (const [host, stream, status, sse, rawJson] of [
  [HOSTS[0], true, 400, false, false], [HOSTS[1], true, 200, true, false],
  [HOSTS[0], false, 400, false, false], [HOSTS[1], false, 200, false, false],
  [HOSTS[0], true, 400, true, false], [HOSTS[1], true, 400, true, true],
]) test(`one encrypted downgrade preserves full request and final response (${host}, client=${stream}, HTTP${status}, SSE=${sse}, raw=${rawJson})`, async () => {
  configure({ host }); const body = history(); body.stream = stream; freeze(body);
  const original = structuredClone(body), beforeLogs = logs().length;
  reply = (_req, res) => {
    if (seen.length > 1) return answer(res, stream ? successBytes : JSON.stringify(completed), 200, stream ? 'text/event-stream' : 'application/json');
    mod._state.store.codex[0].api_key = 'synthetic-changed-key'; mod._state.store.codex[0].keys = [];
    const payload = status === 200 ? failure().response : encrypted();
    answer(res, sse && !rawJson ? created + frame(status === 200 ? failure() : { type: 'error', ...payload }) : JSON.stringify(payload), status,
      sse ? 'text/event-stream' : 'application/json');
  };
  const result = await ask(body); recovered(result); assert.equal(result.text, stream ? successBytes : JSON.stringify(completed));
  assert.deepEqual(seen[0].body, original); assert.deepEqual(seen[1].body, projectEncryptedReasoning(original).body);
  assert.deepEqual(body, original); assert.equal(logs().length, beforeLogs + 1);
  assert.equal(seen[1].body.input.find(item => item.type === 'function_call').call_id, 'call-preserved');
  assert.deepEqual(seen[1].body.input.find(item => item.type === 'function_call_output').output, original.input[5].output);
  await waitFor(() => closed === seen.length, { label: 'encrypted abandoned responses closed' });
});

for (const override of [false, true]) test(`explicit upstream format override keeps encrypted downgrade semantics (${override})`, async () => {
  configure({ override }); const body = history(); body.stream = !override;
  reply = (_req, res) => {
    const text = seen.length === 1 ? (override ? frame(failure()) : JSON.stringify(failure().response))
      : override ? frame({ type: 'response.completed', response: completed }) : JSON.stringify(completed);
    answer(res, text, 200, override ? 'text/event-stream' : 'application/json');
  };
  const result = await ask(body); recovered(result); assert.match(result.text, /ENCRYPTED_RECOVERY_OK/);
  assert.deepEqual(seen[1].body, projectEncryptedReasoning(seen[0].body).body);
});

test('resource-ID recovery followed by encrypted error shares projected plan and keeps final downgrade evidence', async () => {
  const body = history(), original = structuredClone(body);
  reply = (_req, res) => seen.length === 1 ? answer(res, JSON.stringify(azure), 400, 'application/json')
    : seen.length === 2 ? answer(res, frame(failure())) : answer(res);
  const result = await ask(body); recovered(result, 3); assert.equal(result.text, successBytes);
  assert.deepEqual(seen[1].body, projectResponsesHistory(original).body);
  assert.deepEqual(seen[2].body, projectEncryptedReasoning(seen[1].body).body); assert.deepEqual(body, original);
});

test('downgrade followed by native transient reuses exact downgraded bytes and frozen binding', async () => {
  reply = (_req, res) => seen.length === 1 ? answer(res, JSON.stringify(encrypted()), 400, 'application/json')
    : seen.length === 2 ? answer(res, frame(failure('upstream_error'))) : answer(res);
  const result = await ask(); recovered(result, 3); assert.equal(result.text, successBytes); assert.deepEqual(seen[2].bytes, seen[1].bytes);
});

test('transient first then downgrade stays inside ordinary recovery loop', async () => {
  reply = (_req, res) => seen.length === 1 ? answer(res, frame(failure('upstream_error')))
    : seen.length === 2 ? answer(res, JSON.stringify(encrypted()), 400, 'application/json') : answer(res);
  const result = await ask(); recovered(result, 3); assert.deepEqual(seen[1].bytes, seen[0].bytes);
  assert.deepEqual(seen[2].body, projectEncryptedReasoning(seen[0].body).body);
});

test('one downgrade and repeated native transients never exceed the existing shared five-call cap', async () => {
  reply = (_req, res) => seen.length === 1 ? answer(res, JSON.stringify(encrypted()), 400, 'application/json')
    : answer(res, frame(failure('upstream_error')));
  const result = await ask(); assert.ok(seen.length >= 2 && seen.length <= 5); assert.equal(lastLog().attempts, seen.length);
  assert.equal(result.text, frame(failure('upstream_error'))); assert.doesNotMatch(result.text, /response.completed/);
  for (const request of seen.slice(2)) assert.deepEqual(request.bytes, seen[1].bytes);
  assertBinding();
});

for (const sse of [false, true]) test(`second encrypted failure returns exact terminal response without second downgrade (SSE=${sse})`, async () => {
  reply = (_req, res) => answer(res, sse ? frame(failure()) : JSON.stringify(encrypted()), sse ? 200 : 400,
    sse ? 'text/event-stream' : 'application/json', { 'x-request-id': `attempt-${seen.length}` });
  const result = await ask(); assert.equal(seen.length, 2); assert.equal(lastLog().attempts, 2);
  assert.equal(result.status, sse ? 200 : 400); assert.equal(result.text, sse ? frame(failure()) : JSON.stringify(encrypted()));
  if (!sse) assert.equal(result.headers['x-request-id'], 'attempt-2');
  assert.doesNotMatch(result.text, /response.completed/);
});

test('second encrypted failure after a transient still cannot reopen downgrade', async () => {
  reply = (_req, res) => seen.length === 2 ? answer(res, frame(failure('upstream_error')))
    : answer(res, JSON.stringify(encrypted()), 400, 'application/json');
  const result = await ask(); assert.equal(seen.length, 3); assert.equal(result.status, 400); assert.equal(result.text, JSON.stringify(encrypted()));
  assert.deepEqual(seen[2].bytes, seen[1].bytes);
});

test('a complete encrypted error frame must await upstream EOF before a successful replay', async () => {
  let ended = false, prematureReplay = false;
  reply = (_req, res) => {
    if (seen.length > 1) { prematureReplay = !ended; return answer(res); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(frame(failure()));
    setTimeout(() => { ended = true; res.end(); }, 100);
  };
  const result = await ask(); recovered(result); assert.equal(result.text, successBytes);
  assert.equal(ended, true); assert.equal(prematureReplay, false);
});

for (const [name, tail] of [
  ['unknown', frame({ type: 'response.unknown', opaque_output: 'cannot discard' })],
  ['output', frame({ type: 'response.output_text.delta', delta: 'visible once' })],
  ['partial', 'data: {"type":"response.output_text.delta","delta":"partial'],
]) for (const status of [200, 400]) test(`HTTP${status} encrypted error waits for delayed ${name} tail and never replays it`, async () => {
  const raw = created + frame(failure()) + tail; let sentTail = false, replayedBeforeTail = false;
  reply = (_req, res) => {
    if (seen.length > 1) { replayedBeforeTail = !sentTail; return answer(res); }
    res.writeHead(status, { 'Content-Type': 'text/event-stream' }); res.write(created + frame(failure()));
    setTimeout(() => { sentTail = true; res.end(tail); }, 100);
  };
  const result = await ask(); assert.equal(replayedBeforeTail, false, 'failure frame alone is not a completed upstream response');
  assert.equal(sentTail, true); assert.equal(seen.length, 1); assert.equal(result.status, status); assert.equal(result.text, raw);
  assert.equal(result.headers['x-mixrouter-recovery'], undefined);
});

for (const prefix of [frame({ type: 'response.output_text.delta', delta: ' ' }), frame({ type: 'response.reasoning_text.delta', delta: 'thought' }),
  frame({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'execute-once', name: 'Write', arguments: '{}' } })]) {
  test(`visible output before encrypted failure never replays (${prefix.slice(0, 45)})`, async () => {
    const raw = prefix + frame(failure()); reply = (_req, res) => answer(res, raw);
    const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.text, raw); assert.equal(result.headers['x-mixrouter-recovery'], undefined);
  });
}

test('legal empty completion does not trigger downgrade or retry', async () => {
  const raw = frame({ type: 'response.completed', response: { id: 'empty-completion', status: 'completed', output: [],
    usage: { input_tokens: 9, output_tokens: 0 } } });
  reply = (_req, res) => answer(res, raw);
  const result = await ask(); assert.equal(result.text, raw); assert.equal(seen.length, 1); assert.equal(lastLog().out, 0);
  assert.equal(result.headers['x-mixrouter-recovery'], undefined);
});

for (const [host, protocol] of [['127.0.0.1', 'http:'], [HOSTS[0], 'http:'], ...OTHER_HOSTS.map(host => [host, 'https:'])]) {
  test(`encrypted error outside exact official HTTPS scope never downgrades (${protocol}//${host})`, async () => {
    configure({ host, protocol }); reply = (_req, res) => answer(res, JSON.stringify(encrypted()), 400, 'application/json');
    const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.status, 400); assert.equal(result.text, JSON.stringify(encrypted()));
    assert.equal(result.headers['x-mixrouter-recovery'], undefined);
  });
}

for (const mutate of [body => { body.previous_response_id = 'server-reference'; },
  body => { body.input.push({ type: 'compaction', encrypted_content: 'opaque' }); },
  body => { body.input[2].unknown_history = 'cannot discard'; },
  body => { body.input.splice(5, 1); },
  body => { delete body.input[5].id; body.input[5].output = [{ type: 'input_image', file_id: 'server-reference' }]; },
]) test(`unsafe encrypted history preserves original upstream error (${mutate.toString().slice(0, 55)})`, async () => {
  const body = history(); mutate(body); const original = structuredClone(body);
  reply = (_req, res) => answer(res, JSON.stringify(encrypted()), 400, 'application/json');
  const result = await ask(body); assert.equal(seen.length, 1); assert.equal(result.status, 400); assert.equal(result.text, JSON.stringify(encrypted()));
  assert.deepEqual(body, original); assert.deepEqual(seen[0].body, original); assert.equal(result.headers['x-mixrouter-recovery'], undefined);
});

test('Responses compaction endpoint is excluded from encrypted downgrade', async () => {
  reply = (_req, res) => answer(res, JSON.stringify(encrypted()), 400, 'application/json');
  const result = await ask(history(), '/v1/responses/compact'); assert.equal(seen.length, 1); assert.equal(result.status, 400);
  assert.equal(result.text, JSON.stringify(encrypted())); assert.equal(result.headers['x-mixrouter-recovery'], undefined);
});

test('encrypted downgrade cannot add an upstream call when the shared attempt budget is exhausted', async () => {
  const { createAttempt } = require('../lib/proxy/attempt');
  const { createRequestContext } = require('../lib/proxy/context');
  const { createAttemptRunner } = require('../lib/proxy/attempts');
  const { createResponder } = require('../lib/proxy/response');
  const wireResponses = require('../lib/wire-responses'), wireOpenai = require('../lib/wire-openai-bridge');
  const responder = createResponder({ collect: require('../lib/upstream-collect'), wireResponses, wireOpenai,
    wireChat: require('../lib/wire-chat'), extractUsageFor: () => ({}), sseResult: () => ({ ok: true }),
    errLineOrPlaceholder: (_status, text) => text });
  const attempt = createAttempt({ http, https, storeOf: () => [], slotMapOf: () => ({}),
    sessionConfig: { selectSessionKey: provider => ({ provider, key_id: 'fixture-key' }) }, compactLib: {},
    wireOf: () => 'responses', upstreamPathOf: () => '/v1/responses', joinUpstreamPath: (base, endpoint) => base + endpoint,
    buildOpenAiHeaders: () => ({ 'Content-Type': 'application/json' }), hasCtlChar: () => false,
    transportAgent: () => false, safeHeader: value => value, wireResponses, wireOpenai, toolFilter: { apply: () => 0 },
    retryableStatus: () => false, errorClass: () => 'upstream_request', markCooldown() {},
    firstHeaderTimeoutFor: () => 1000, streamIdleTimeoutMs: 1000, settleRequest() {},
    convCacheGen: () => 0, dispatchResponse: responder.dispatchResponse });
  const capProxy = http.createServer((req, res) => {
    req.resume(); req.once('end', () => {
      const body = history();
      const ctx = createRequestContext({ res, entry: {}, started: Date.now(), rawLen: 0, totalDeadlineMs: 2000,
        maxAttempts: 1, convRetries: 0, sseKeepAliveMs: 0, app: 'codex', onFinish() {},
        protoError: (target, app, status, type, message) => { target.writeHead(status); target.end(JSON.stringify({ error: { type, message } })); } });
      const provider = { id: 'cap-primary', name: 'cap-primary', api_key: 'fixture-key', base_url: 'https://agentrouter.org' };
      const plan = { ep: { kind: 'responses' }, body, req, modelIn: body.model, ident: { key: 'cap-test' }, resolved: {},
        app: 'codex', ordered: [{ provider, model: body.model }], sess: {}, sessionKey: 'cap-test' };
      createAttemptRunner({ runAttempt: attempt.runAttempt, convRetries: 0 }).runAttempts(plan, ctx);
    });
  });
  await new Promise(resolve => capProxy.listen(0, '127.0.0.1', resolve));
  reply = (_req, res) => answer(res, JSON.stringify(encrypted()), 400, 'application/json');
  try {
    const result = await ask(history(), '/v1/responses', capProxy.address().port);
    assert.equal(result.status, 400); assert.equal(result.text, JSON.stringify(encrypted())); assert.equal(seen.length, 1);
  } finally { capProxy.closeAllConnections(); await new Promise(resolve => capProxy.close(resolve)); }
});

test('compressed response headers close the encrypted downgrade window', async () => {
  const { gzipSync } = require('node:zlib');
  const raw = gzipSync(Buffer.from(JSON.stringify(encrypted())));
  reply = (_req, res) => answer(res, raw, 400, 'application/json', { 'Content-Encoding': 'gzip', 'x-request-id': 'compressed-error' });
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.status, 400);
  assert.deepEqual(result.bytes, raw); assert.equal(result.headers['content-encoding'], 'gzip');
  assert.equal(result.headers['x-request-id'], 'compressed-error'); assert.equal(result.headers['x-mixrouter-recovery'], undefined);
});

test('authentication prose takes precedence over the encrypted content code', async () => {
  const payload = encrypted(); payload.error.message = 'Invalid API key: access denied.';
  const raw = JSON.stringify(payload);
  reply = (_req, res) => answer(res, raw, 400, 'application/json', { 'x-request-id': 'auth-terminal' });
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.status, 400); assert.equal(result.text, raw);
  assert.equal(result.headers['x-request-id'], 'auth-terminal'); assert.equal(result.headers['x-mixrouter-recovery'], undefined);
});

test('ordinary non-AgentRouter failover is unchanged for HTTP503', async () => {
  configure({ host: '127.0.0.1' });
  reply = (_req, res) => seen.length === 1 ? answer(res, '{"error":{"code":"server_error","message":"unavailable"}}', 503, 'application/json') : answer(res);
  const result = await ask(); assert.equal(result.text, successBytes); assert.equal(seen.length, 2);
  assert.equal(seen[1].url, '/secondary/v1/responses'); assert.equal(lastLog().failover, true); assert.equal(result.headers['x-mixrouter-recovery'], undefined);
});
