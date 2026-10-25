'use strict';
// Real local HTTP sockets only. All configs and logs live in an isolated fixture.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { waitFor } = require('./wait-for');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-resource-recovery-'));
Object.assign(process.env, {
  MIXR_DATA_DIR: root, MIXR_CLAUDE_SETTINGS: path.join(root, 'settings.json'),
  MIXR_CODEX_CONFIG: path.join(root, 'config.toml'), MIXR_MAX_ATTEMPTS: '3',
  MIXR_CONV_RETRIES: '0', MIXR_RETRY_DELAY_MS: '15', MIXR_SSE_KEEPALIVE_MS: '0',
  MIXR_TOTAL_DEADLINE_MS: '300', MIXR_STREAM_IDLE_TIMEOUT_MS: '0', MIXR_NONSTREAM_TOTAL_TIMEOUT_MS: '0', MIXR_RESPONSE_ARCHIVE: 'off',
});
const mod = require('../mixrouter');
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const mismatch = () => ({ error: { code: null, type: 'invalid_request_error',
  message: 'The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it. (request id: fixture-request-001) [trace_id=fixture-trace-001]' } });
const failed = () => ({ type: 'response.failed', response: { id: 'failed-resource-attempt',
  object: 'response', status: 'failed', output: [], ...mismatch() } });
const complete = () => ({ id: 'portable-success', object: 'response', status: 'completed',
  output: [{ id: 'msg-final', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'portable answer' }] }],
  usage: { input_tokens: 13, output_tokens: 5 } });
const history = () => ({ model: 'fixture-model', stream: true, prompt_cache_key: 'cache-keep',
  metadata: { session_id: 'metadata-keep' }, include: ['reasoning.encrypted_content'], input: [
    { role: 'user', content: 'read file' },
    { type: 'reasoning', id: 'rs-resource', encrypted_content: 'opaque-keep', summary: [] },
    { type: 'message', id: 'msg-resource', role: 'assistant', content: [{ type: 'output_text', text: 'text-keep' }] },
    { type: 'function_call', id: 'fc-resource', name: 'Read', call_id: 'call-keep', arguments: '{"file":"input.txt"}' },
    { type: 'function_call_output', call_id: 'call-keep', output: 'tool-result-keep' },
  ] });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let upstream, proxy, reply, seen, closed;
const sockets = new Set();
function success(res, json = false) {
  res.writeHead(200, { 'Content-Type': json ? 'application/json' : 'text/event-stream' });
  res.end(json ? JSON.stringify(complete()) : frame({ type: 'response.completed', response: complete() }));
}
function failure(res, { status = 400, json = true, value } = {}) {
  res.writeHead(status, { 'Content-Type': json ? 'application/json' : 'text/event-stream' });
  res.end(json ? JSON.stringify(value || (status === 400 ? mismatch() : failed().response)) : frame(value || failed()));
}
function configure({ override, pinned = false, wire = 'responses' } = {}) {
  const provider = { id: 'primary', name: 'primary', enabled: true, wire_api: wire,
    api_key: 'sk-original', active_key: 'original', key_fallback: true,
    keys: [{ id: 'original', key: 'sk-original' }, { id: 'other', key: 'sk-other' }],
    base_url: `http://127.0.0.1:${upstream.address().port}/primary`, models: ['fixture-model'] };
  mod._state.store = { claude: [provider], codex: [provider] };
  mod._state.routes = { rules: [], default: mod.normalizeRule({ provider: 'primary',
    ...(pinned ? { key_id: 'original' } : {}), ...(override === undefined ? {} : { upstream_stream: override }) }) };
}
function ask(body = history(), endpoint = '/v1/responses', callback) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: proxy.address().port, path: endpoint,
      method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'session-id': 'header-keep', Connection: 'close' } }, res => {
      if (callback) callback(req, res);
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('fixture timeout')));
    req.end(JSON.stringify(body));
  });
}
function log() { return JSON.parse(fs.readFileSync(path.join(root, 'logs', 'requests.jsonl'), 'utf8').trim().split('\n').at(-1)); }
function recovered(result) {
  assert.equal(result.status, 200, result.text); assert.match(result.text, /portable answer/);
  assert.doesNotMatch(result.text, /failed-resource-attempt|different Azure OpenAI resource/);
  assert.equal(seen.length, 2); assert.equal(log().attempts, 2); assert.equal(log().err || '', '');
  assert.equal(log().err_class || '', ''); assert.equal(log().in, 13); assert.equal(log().out, 5);
  assert.ok(!log().failover);
  assert.equal(seen[0].path, seen[1].path); assert.equal(seen[0].body.model, seen[1].body.model);
  assert.equal(seen[0].headers.authorization, seen[1].headers.authorization);
  assert.equal(seen[0].headers['session-id'], seen[1].headers['session-id']);
  assert.equal(seen[1].body.prompt_cache_key, 'cache-keep');
  assert.deepEqual(seen[1].body.metadata, seen[0].body.metadata);
  assert.equal(seen[1].body.input[1].encrypted_content, 'opaque-keep');
  assert.equal(seen[1].body.input[3].call_id, 'call-keep');
  assert.equal(seen[1].body.input[4].output, 'tool-result-keep');
  assert.ok(seen[1].body.input.every(item => !Object.hasOwn(item, 'id')));
}
before(async () => {
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk)); req.once('end', () => {
      seen.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      reply(req, res);
    });
    res.once('close', () => { closed++; });
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  proxy = await mod.listen(0, mod.proxyHandler);
});
beforeEach(() => {
  seen = []; closed = 0; mod._state.sessions.clear(); mod._state.cooldowns = {}; mod._state.resetPools(); configure();
});
after(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([upstream, proxy].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  fs.rmSync(root, { recursive: true, force: true });
});

for (const [stream, override, status, json] of [
  [true, undefined, 400, true], [false, undefined, 400, true],
  [true, undefined, 200, false], [false, undefined, 200, true],
  [true, false, 200, true], [false, true, 200, false], [true, undefined, 400, false],
]) test(`resource recovery HTTP/JSON/SSE (client=${stream}, override=${override}, status=${status}, json=${json})`, async () => {
  configure({ override });
  const body = { ...history(), stream }, before = hash(body);
  reply = (_req, res) => seen.length === 1 ? failure(res, { status, json }) : success(res, json);
  recovered(await ask(body)); assert.equal(hash(body), before);
});

test('HTTP400 SSE content-type with raw JSON resource error recovers on the same candidate/model/key', async () => {
  reply = (_req, res) => {
    if (seen.length !== 1) return success(res);
    res.writeHead(400, { 'Content-Type': 'text/event-stream' });
    res.end(JSON.stringify(mismatch()));
  };
  recovered(await ask());
});

test('HTTP400 SSE content-type with raw JSON schema error or semantic content never recovers', async () => {
  for (const value of [
    { error: { code: null, type: 'invalid_request_error', message: 'Invalid schema for function Read' } },
    { ...mismatch(), output: complete().output },
    { ...mismatch(), content: [{ type: 'tool_use', id: 'execute-once', name: 'Write', input: {} }] },
  ]) {
    seen = [];
    reply = (_req, res) => { res.writeHead(400, { 'Content-Type': 'text/event-stream' }); res.end(JSON.stringify(value)); };
    const result = await ask();
    assert.equal(result.status, 400); assert.equal(seen.length, 1); assert.equal(log().attempts, 1);
    assert.equal(result.text, JSON.stringify(value));
  }
});

test('same candidate model/key is frozen even if active key changes during recovery delay', async () => {
  configure({ pinned: true });
  reply = (_req, res) => {
    if (seen.length !== 1) return success(res);
    mod._state.store.codex[0].active_key = 'other'; mod._state.store.codex[0].api_key = 'sk-other';
    failure(res);
  };
  recovered(await ask()); assert.equal(seen[1].headers.authorization, 'Bearer sk-original');
});

test('repeated exact400 uses one projection and the existing shared call budget', async () => {
  reply = (_req, res) => failure(res);
  const result = await ask(); assert.equal(result.status, 400); assert.equal(seen.length, 3);
  assert.equal(result.text, JSON.stringify(mismatch())); assert.equal(log().attempts, 3);
  assert.deepEqual(seen[2].body, seen[1].body, 'later attempts reuse the same projected history');
  assert.equal(seen[2].headers.authorization, seen[1].headers.authorization);
});

test('reference-only and missing tool history fail safely without inventing context', async () => {
  for (const body of [
    { model: 'fixture-model', stream: true, previous_response_id: 'resp-old', input: [{ role: 'user', content: 'continue' }] },
    { ...history(), previous_response_id: 'resp-old' },
    { ...history(), conversation: 'conversation-old' },
    { ...history(), input: [{ type: 'item_reference', id: 'rs-old' }] },
    { ...history(), input: [{ type: 'function_call_output', call_id: 'missing', output: 'result' }, ...history().input] },
  ]) {
    seen = []; reply = (_req, res) => failure(res);
    const result = await ask(body); assert.equal(result.status, 400); assert.equal(seen.length, 1);
    assert.equal(result.text, JSON.stringify(mismatch()), 'retain the actual upstream error without invented context');
    assert.match(log().err, /different Azure OpenAI resource/);
  }
});

test('a failed JSON response with output is never replayed', async () => {
  const value = { ...failed().response, output: complete().output };
  reply = (_req, res) => failure(res, { status: 200, value });
  const result = await ask({ ...history(), stream: false });
  assert.equal(seen.length, 1); assert.equal(result.text, JSON.stringify(value));
});

test('HTTP400 exact error with semantic output/content/choices is never replayed', async () => {
  for (const result of [
    { output: complete().output }, { choices: [{ message: { content: 'visible answer' } }] },
    { content: [{ type: 'tool_use', id: 'execute-once', name: 'Write', input: {} }] },
    { response: { output: complete().output } }, { tool_calls: [{ id: 'execute-once', function: { arguments: '{}' } }] },
  ]) {
    seen = []; const value = { ...mismatch(), ...result };
    reply = (_req, res) => failure(res, { status: 400, value });
    const response = await ask(); assert.equal(seen.length, 1); assert.equal(response.status, 400);
    assert.equal(response.text, JSON.stringify(value));
  }
});

test('an upstream_error label cannot expand the shared resource recovery budget', async () => {
  const value = failed().response; value.error.code = 'upstream_error';
  reply = (_req, res) => failure(res, { status: 200, value });
  const result = await ask({ ...history(), stream: false });
  assert.equal(seen.length, 3); assert.equal(result.text, JSON.stringify(value));
  assert.deepEqual(seen[2].body, seen[1].body);
});

test('a changed body without resource ids does not manufacture a recovery', async () => {
  reply = (_req, res) => failure(res);
  const body = history(); body.input = body.input.map(({ id, ...item }) => item);
  const result = await ask(body); assert.equal(result.status, 400); assert.equal(seen.length, 1);
});

for (const prefix of [
  frame({ type: 'response.output_text.delta', delta: 'visible-once' }),
  frame({ type: 'response.reasoning_text.delta', delta: 'thought-once' }),
  frame({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'execute-once', arguments: '{}' } }),
  frame({ type: 'response.unknown', arbitrary: true }),
  'data: malformed\n\n', ': ' + 'x'.repeat(65 * 1024) + '\n\n',
]) test(`partial/unknown/malformed/over-limit stream is never replayed (${prefix.slice(0, 35)})`, async () => {
  const raw = prefix + frame(failed());
  reply = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(raw); };
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.text, raw);
});

test('cross-chunk CRLF lifecycle+error recovers before EOF and destroys only abandoned response', async () => {
  reply = (_req, res) => {
    if (seen.length !== 1) return success(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': open\r\n\r\n' + frame({ type: 'response.created', response: { status: 'in_progress', output: [] } }));
    const text = frame(failed()).replace(/\n/g, '\r\n'); res.write(text.slice(0, 40));
    setTimeout(() => res.write(text.slice(40)), 10);
  };
  recovered(await ask()); await waitFor(() => closed === 2, { label: 'resource failure stream released' });
});

for (const status of [200, 400]) test(`HTTP${status} SSE error envelope recovers immediately before EOF`, async () => {
  reply = (_req, res) => {
    if (seen.length !== 1) return success(res);
    res.writeHead(status, { 'Content-Type': 'text/event-stream' });
    res.write(frame({ type: 'error', ...mismatch() }));
  };
  recovered(await ask()); await waitFor(() => closed === 2, { label: 'error envelope old response closed' });
});

test('HTTP400 malformed/unknown frames before error prohibit recovery', async () => {
  for (const prefix of ['data: malformed\n\n', frame({ type: 'unknown', body: 'do not replay' })]) {
    seen = []; const raw = prefix + frame(failed());
    reply = (_req, res) => { res.writeHead(400, { 'Content-Type': 'text/event-stream' }); res.end(raw); };
    const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.text, raw);
  }
});

test('buffered SSE malformed/unknown prefix cannot reopen resource retry window', async () => {
  configure({ override: true });
  reply = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: malformed\n\n' + frame(failed())); };
  const result = await ask({ ...history(), stream: false }); assert.equal(seen.length, 1);
  assert.match(result.text, /different Azure OpenAI resource/);
  assert.doesNotMatch(result.text, /portable answer/);
});

test('schema/auth400 remain original failures, not resource recovery', async () => {
  for (const message of ['Invalid schema for function Read', 'Incorrect API key', 'resource mismatch']) {
    seen = []; reply = (_req, res) => failure(res, { value: { error: { message, code: 'invalid_request_error' } } });
    const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.status, 400); assert.match(result.text, new RegExp(message));
  }
});

test('HTTP400 truncated JSON/SSE closes normally without trying resource recovery', async () => {
  for (const [type, text] of [
    ['application/json', '{"error":{"message":"truncated'],
    ['text/event-stream', 'event: error\ndata: {"type":"error","error":{"message":"truncated'],
    ['text/event-stream', 'event: error\ndata: invalid-json\n\n'],
  ]) {
    seen = [];
    reply = (_req, res) => { res.writeHead(400, { 'Content-Type': type }); res.end(text); };
    const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.status, 400); assert.equal(result.text, text);
  }
});

test('HTTP400 prefix connection error completes with502 instead of hanging', async () => {
  reply = (req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' }); res.write('{"error":');
    setTimeout(() => req.socket.destroy(), 5);
  };
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.status, 502); assert.equal(log().err_class, 'econnreset');
});

test('HTTP400 prefix before EOF stays under the original deadline', async () => {
  reply = (_req, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.write('{"error":'); };
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.status, 504); assert.equal(log().err_class, 'timeout');
});

test('oversized HTTP400 passes through without expanding the resource window', async () => {
  const value = { ...mismatch(), padding: 'x'.repeat(65 * 1024) };
  reply = (_req, res) => failure(res, { value });
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.text, JSON.stringify(value));
});

test('compaction is excluded even with ids and exact resource mismatch', async () => {
  reply = (_req, res) => failure(res);
  const result = await ask(history(), '/v1/responses/compact'); assert.equal(seen.length, 1); assert.equal(result.status, 400);
  assert.match(result.text, /different Azure OpenAI resource/);
});

test('native Chat/Anthropic have no safe resource projection and return original error', async () => {
  for (const [wire, endpoint, body] of [
    ['chat', '/v1/chat/completions', { model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] }],
    ['anthropic', '/v1/messages', { model: 'fixture-model', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }],
  ]) {
    seen = []; configure({ wire }); reply = (_req, res) => failure(res);
    const result = await ask(body, endpoint); assert.equal(seen.length, 1); assert.equal(result.status, 400);
    assert.match(result.text, /different Azure OpenAI resource/);
  }
});

test('client cancellation during resource retry delay sends no second request', async () => {
  let client;
  reply = (_req, res) => { failure(res); setTimeout(() => client.destroy(), 2); };
  await new Promise((resolve, reject) => {
    client = http.request({ hostname: '127.0.0.1', port: proxy.address().port, path: '/v1/responses', method: 'POST',
      headers: { 'Content-Type': 'application/json' } });
    client.once('error', error => error.code === 'ECONNRESET' ? resolve() : reject(error));
    client.once('close', resolve); client.end(JSON.stringify(history()));
  });
  await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(seen.length, 1); assert.equal(log().err_class, 'cancelled');
});

test('resource recovery does not reset end-to-end deadline', async () => {
  reply = (_req, res) => {
    if (seen.length === 1) return failure(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders();
    const heartbeat = setInterval(() => res.write(': upstream-wait\n\n'), 40);
    res.once('close', () => clearInterval(heartbeat));
  };
  const body = history(), started = Date.now();
  const result = await ask(body); assert.equal(result.status, 504); assert.equal(log().err_class, 'timeout'); assert.equal(seen.length, 2);
  assert.ok(Date.now() - started < 300 + Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4) * 2 + 180);
});

test('resource recovery observes existing zero remaining call budget', async () => {
  const { createAttempt } = require('../lib/proxy/attempt');
  const { createRequestContext } = require('../lib/proxy/context');
  const { createAttemptRunner } = require('../lib/proxy/attempts');
  const { createResponder } = require('../lib/proxy/response');
  // Use the public proxy modules with real HTTP; MAX_ATTEMPTS=1, CONV_RETRIES=0
  // is one original call, no hidden recovery call added to their existing cap.
  const response = createResponder({ collect: require('../lib/upstream-collect'), wireResponses: require('../lib/wire-responses'),
    wireOpenai: require('../lib/wire-openai-bridge'), wireChat: require('../lib/wire-chat'), extractUsageFor: () => ({}),
    sseResult: () => ({ ok: true }), errLineOrPlaceholder: (_status, text) => text });
  let refreshed = 0;
  const factory = createAttempt({ http, https: require('node:https'), storeOf: () => { throw new Error('refresh hook owns lookup'); },
    refreshProvider(provider, app, plan) {
      refreshed++; assert.equal(app, 'codex'); assert.equal(plan.app, 'codex');
      return { ...provider, wire_api: 'responses', api_key: 'refreshed-key' };
    }, slotMapOf: () => ({}),
    sessionConfig: { selectSessionKey: provider => ({ provider, key_id: 'original' }) }, compactLib: {},
    wireOf: provider => { assert.equal(provider.api_key, 'refreshed-key'); return provider.wire_api; }, upstreamPathOf: () => '/v1/responses', joinUpstreamPath: (base, endpoint) => base + endpoint,
    buildOpenAiHeaders: () => ({ 'Content-Type': 'application/json' }), hasCtlChar: () => false,
    transportAgent: () => false, safeHeader: x => x, wireResponses: require('../lib/wire-responses'),
    wireOpenai: require('../lib/wire-openai-bridge'), toolFilter: { apply: () => 0 },
    retryableStatus: () => false, errorClass: () => 'upstream_request', markCooldown() {},
    firstHeaderTimeoutFor: () => 1000, streamIdleTimeoutMs: 5000, settleRequest() {},
    convCacheGen: () => 0, dispatchResponse: response.dispatchResponse,
  });
  const capProxy = http.createServer((req, res) => {
    req.resume(); req.once('end', () => {
      const body = history();
      const ctx = createRequestContext({ res, entry: {}, started: Date.now(), rawLen: 0, totalDeadlineMs: 1000,
        maxAttempts: 1, convRetries: 0, sseKeepAliveMs: 0, app: 'codex', onFinish() {},
        protoError: (r, app, status, type, message) => { r.writeHead(status); r.end(JSON.stringify({ error: { type, message } })); } });
      const provider = { id: 'cap-primary', name: 'cap-primary', api_key: 'fixture', base_url: `http://127.0.0.1:${upstream.address().port}` };
      const plan = { ep: { kind: 'responses' }, body, req, modelIn: body.model, ident: { key: 'cap-test' }, resolved: {},
        app: 'codex', ordered: [{ provider, model: body.model }], sess: {}, sessionKey: 'cap-test' };
      createAttemptRunner({ runAttempt: factory.runAttempt, convRetries: 0 }).runAttempts(plan, ctx);
    });
  });
  await new Promise(resolve => capProxy.listen(0, '127.0.0.1', resolve));
  reply = (_req, res) => failure(res);
  try {
    const result = await new Promise((resolve, reject) => {
      http.request({ hostname: '127.0.0.1', port: capProxy.address().port, method: 'POST' }, res => {
        const parts = []; res.on('data', chunk => parts.push(chunk));
        res.once('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8') }));
      }).on('error', reject).end('{}');
    });
    assert.equal(result.status, 400); assert.equal(seen.length, 1); assert.match(result.text, /different Azure OpenAI resource/);
    assert.equal(refreshed, 1, 'optional latest-provider accessor called at real request boundary');
  } finally { capProxy.closeAllConnections(); await new Promise(resolve => capProxy.close(resolve)); }
});
