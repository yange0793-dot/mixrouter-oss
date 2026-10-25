'use strict';
// Full proxy, loopback-only faults: native recovery shares the ordinary request budget.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { waitFor } = require('./wait-for');
const { projectResponsesHistory } = require('../lib/responses-history');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-native-recovery-'));
Object.assign(process.env, {
  MIXR_DATA_DIR: root, MIXR_CLAUDE_SETTINGS: path.join(root, 'settings.json'),
  MIXR_CODEX_CONFIG: path.join(root, 'config.toml'), MIXR_MAX_ATTEMPTS: '3',
  MIXR_CONV_RETRIES: '2', MIXR_RETRY_DELAY_MS: '20', MIXR_SSE_KEEPALIVE_MS: '0',
  MIXR_TOTAL_DEADLINE_MS: '500', MIXR_STREAM_IDLE_TIMEOUT_MS: '100', MIXR_RESPONSE_ARCHIVE: 'off',
});
const mod = require('../mixrouter');
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const created = frame({ type: 'response.created', response: { id: 'discard-created', status: 'in_progress', output: [] } });
const output = [{ type: 'message', id: 'result-message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'RECOVERY_OK' }] }];
const complete = { id: 'final-response', object: 'response', status: 'completed', output,
  usage: { input_tokens: 17, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } } };
const successBytes = frame({ type: 'response.output_text.delta', delta: 'RECOVERY_OK' })
  + frame({ type: 'response.completed', response: complete });
const azure = { error: { type: 'invalid_request_error', message: 'The requested item was created under a different Azure OpenAI resource.' } };
const failure = (code, message = code) => ({ type: 'response.failed', response: { id: 'discard-failed',
  status: 'failed', output: [], error: { code, message } } });
const transient = frame(failure('upstream_error', 'Upstream request failed'));
const history = () => ({ model: 'fixture-model', stream: true, store: false, prompt_cache_key: 'native-cache',
  reasoning: { effort: 'max' }, metadata: { client: 'codex' }, tools: [{ type: 'function', name: 'sum', parameters: { type: 'object' }, strict: false }],
  input: [
    { role: 'user', content: 'continue native history' },
    { type: 'message', id: 'msg-history', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Earlier answer' }] },
    { type: 'reasoning', id: 'rs-history', encrypted_content: 'ENCRYPTED_REPLAY_BYTES', summary: [] },
    { type: 'function_call', id: 'fc-history', call_id: 'call-1', name: 'sum', arguments: '{"a":19,"b":23}' },
    { type: 'function_call_output', call_id: 'call-1', output: '42' },
    { type: 'additional_tools', id: 'tools-kept', role: 'developer', tools: [{ type: 'namespace', name: 'local', tools: [{ type: 'custom', name: 'shell', format: { type: 'grammar', syntax: 'regex', definition: '.*' } }] }] },
    { type: 'custom_tool_call', id: 'custom-kept', call_id: 'custom-1', name: 'shell', input: 'printf 42', status: 'completed' },
    { type: 'custom_tool_call_output', id: 'custom-output-kept', call_id: 'custom-1', output: '42' },
  ] });
let upstream, proxy, reply, seen, finished, fixtureId = 0;
const sockets = new Set();
function configure({ pinned = false, other = false, override, keyFallback = false } = {}) {
  const provider = id => ({ id, name: id, enabled: true, api_key: 'fixture-secret', wire_api: 'responses',
    base_url: `http://127.0.0.1:${upstream.address().port}/${id}`, models: ['fixture-model'], key_fallback: keyFallback, active_key: `key-a-${fixtureId}`,
    keys: [{ id: `key-a-${fixtureId}`, label: 'a', key: 'fixture-secret', enabled: true }, { id: `key-b-${fixtureId}`, label: 'b', key: 'alternate-secret', enabled: true }] });
  mod._state.store = { claude: [], codex: [provider('primary'), ...(other ? [provider('secondary')] : [])] };
  mod._state.routes = { rules: [], default: mod.normalizeRule({
    ...(pinned ? { provider: 'primary' } : { pool: other ? ['primary', 'secondary'] : ['primary'], strategy: 'priority' }),
    ...(override === undefined ? {} : { upstream_stream: override }),
  }) };
}
function answer(res, text = successBytes, status = 200, mime = 'text/event-stream', headers = {}) {
  res.writeHead(status, { 'Content-Type': mime, ...headers }); res.end(text);
}
function ask(body = history(), session = `native-test-${fixtureId}`) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/v1/responses',
      agent: false, headers: { 'Content-Type': 'application/json', 'session-id': session, 'x-client-request-id': 'preserved-request', Connection: 'close' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('fixture timeout')));
    req.end(JSON.stringify(body));
  });
}
function logs() { return fs.readFileSync(path.join(root, 'logs/requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
function lastLog() { return logs().at(-1); }
function assertSuccess(result, count) {
  assert.equal(result.status, 200, result.text); assert.equal(result.text, successBytes);
  assert.equal(seen.length, count); assert.equal(lastLog().attempts, count);
  assert.equal(lastLog().err || '', ''); assert.equal(lastLog().err_class || '', '');
  assert.equal(lastLog().in, 17); assert.equal(lastLog().out, 4); assert.equal(lastLog().cache_read, 3);
  assert.equal(lastLog().effort, 'max'); assert.ok(!lastLog().failover);
  assert.ok(seen.every(value => value.url.startsWith('/primary/')));
  assert.ok(seen.every(value => value.headers.authorization === seen[0].headers.authorization));
}

before(async () => {
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.once('end', () => { seen.push({ url: req.url, bytes: Buffer.concat(chunks), headers: req.headers }); reply(req, res); });
    res.once('close', () => finished++);
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  proxy = await mod.listen(0, mod.proxyHandler);
});
beforeEach(() => {
  fixtureId++; seen = []; finished = 0; mod._state.sessions.clear(); mod._state.cooldowns = {}; mod._state.resetPools(); configure();
});
after(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([upstream, proxy].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  fs.rmSync(root, { recursive: true, force: true });
});

for (const kind of ['disconnect', 'eof', 'idle', 'empty-eof']) test(`native ${kind} before output recovers with lifecycle bytes discarded`, async () => {
  configure({ other: true });
  reply = (req, res) => {
    if (seen.length > 1) return answer(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (kind !== 'empty-eof') res.write(': comment\r\n\r\n' + created);
    if (kind === 'disconnect') setTimeout(() => req.socket.destroy(), 10);
    else if (kind !== 'idle') res.end();
  };
  assertSuccess(await ask(), 2);
  assert.deepEqual(seen[1].bytes, seen[0].bytes);
  await waitFor(() => finished === seen.length, { label: 'old recovered native stream closed' });
  assert.equal(lastLog().err || '', '');
});

for (const fault of [
  { type: 'error', code: 'rate_limit_exceeded', message: 'Rate limit exceeded' },
  failure('server_error', 'Internal server error'),
  failure('overloaded_error', 'Server overloaded'),
]) test(`HTTP200 native ${fault.type}/${fault.code || fault.response.error.code} recovers`, async () => {
  reply = (_req, res) => answer(res, seen.length === 1 ? created + frame(fault) : successBytes);
  assertSuccess(await ask(), 2); assert.deepEqual(seen[1].bytes, seen[0].bytes);
});

test('type-less SSE error envelope recovers without normalizing original framing', async () => {
  const raw = 'data: {"error":{"code":"rate_limit_exceeded","message":"Rate limit exceeded"}}\n\n';
  reply = (_req, res) => answer(res, seen.length === 1 ? created + raw : successBytes);
  assertSuccess(await ask(), 2); assert.deepEqual(seen[1].bytes, seen[0].bytes);
});

test('type-less SSE error with unknown sibling is a permanent replay barrier', async () => {
  const raw = 'data: {"error":{"code":"rate_limit_exceeded","message":"Rate limit exceeded"},"opaque_output":"unknown"}\n\n';
  reply = (_req, res) => answer(res, created + raw);
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.text, created + raw);
});

for (const [status, mime] of [[408, 'application/json']]) {
  test(`HTTP${status} native transient shares same provider/model/key retry`, async () => {
    configure({ other: true });
    reply = (_req, res) => seen.length === 1 ? answer(res, JSON.stringify({ error: { code: status === 408 ? 'request_timeout' : 'server_error', message: 'fixture server unavailable' } }), status, mime) : answer(res);
    assertSuccess(await ask(), 2); assert.deepEqual(seen[1].bytes, seen[0].bytes);
  });
}

for (const status of [401, 402, 403, 429]) test(`native explicit HTTP${status} key_fallback keeps existing same-provider key switch`, async () => {
  configure({ keyFallback: true });
  reply = (_req, res) => seen.length === 1 ? answer(res, '{"error":{"message":"fixture account rejected"}}', status, 'application/json') : answer(res);
  const result = await ask(); assert.equal(result.text, successBytes); assert.equal(seen.length, 2);
  assert.equal(seen[0].headers.authorization, 'Bearer fixture-secret'); assert.equal(seen[1].headers.authorization, 'Bearer alternate-secret');
  assert.equal(lastLog().key_id, `key-b-${fixtureId}`); assert.equal(lastLog().attempts, 2); assert.ok(!lastLog().failover);
  assert.equal(mod._state.store.codex[0].active_key, `key-a-${fixtureId}`);
  assert.deepEqual(seen[1].bytes, seen[0].bytes);
});

for (const status of [429, 503]) test(`native existing HTTP${status} route failover remains enabled`, async () => {
  configure({ other: true });
  reply = (_req, res) => seen.length === 1 ? answer(res, '{"error":{"code":"server_error","message":"fixture upstream unavailable"}}', status, 'application/json') : answer(res);
  const result = await ask(); assert.equal(result.text, successBytes); assert.equal(seen.length, 2);
  assert.ok(seen[0].url.startsWith('/primary/')); assert.ok(seen[1].url.startsWith('/secondary/')); assert.equal(lastLog().failover, true);
});

test('new native recovery keeps frozen key even if next attempt receives HTTP401', async () => {
  configure({ keyFallback: true });
  const raw = '{"error":{"code":"invalid_api_key","message":"Terminal failure after transparent recovery"}}';
  reply = (_req, res) => seen.length === 1 ? answer(res, transient) : answer(res, raw, 401, 'application/json');
  const result = await ask(); assert.equal(seen.length, 2); assert.equal(result.status, 401); assert.equal(result.text, raw);
  assert.ok(seen.every(value => value.headers.authorization === 'Bearer fixture-secret'));
});

test('Azure projection then HTTP429 reuses frozen provider/key/projected bytes', async () => {
  configure({ keyFallback: true, other: true });
  reply = (_req, res) => {
    if (seen.length === 1) return answer(res, JSON.stringify(azure), 400);
    if (seen.length === 2) return answer(res, '{"error":{"code":"rate_limit_exceeded","message":"Rate limit exceeded"}}', 429, 'application/json');
    answer(res);
  };
  assertSuccess(await ask(), 3); assert.deepEqual(seen[1].bytes, seen[2].bytes);
});

test('native existing pre-header network failure may use configured route failover', async () => {
  configure({ other: true });
  reply = (req, res) => seen.length === 1 ? req.socket.destroy() : answer(res);
  const result = await ask(); assert.equal(result.text, successBytes); assert.equal(seen.length, 2);
  assert.ok(seen[1].url.startsWith('/secondary/')); assert.equal(lastLog().failover, true);
});

for (const fault of [
  failure('invalid_api_key'), failure('permission_denied'), failure('content_policy_violation'), failure('invalid_tool_schema'),
  failure('server_error', 'Invalid schema: property must be an object'),
  { type: 'response.failed', response: { status: 'failed', output: [], error: { code: 'server_error', innererror: { code: 'unauthorized', message: 'Account failure' } } } },
  { type: 'response.failed', response: { status: 'failed', output: [], error: { code: 'server_error', opaque_output: 'not safe to discard' } } },
]) test(`native terminal ${fault.response.error.code}/${fault.response.error.message} never replays`, async () => {
  reply = (_req, res) => answer(res, created + frame(fault));
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.text, created + frame(fault));
});

for (const prefix of [
  frame({ type: 'response.output_text.delta', delta: ' ' }),
  frame({ type: 'response.reasoning_text.delta', delta: 'reasoning' }),
  frame({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'tool-once', name: 'Write', arguments: '' } }),
  frame({ type: 'response.output_item.added', item: { type: 'message', content: [{ type: 'output_text', text: 'answer' }] } }),
  frame({ type: 'response.created', response: { output: [], status: 'in_progress', output_text: ' ' } }),
  frame({ type: 'response.created', response: { output: [], status: 'in_progress', unknown_output: 'opaque' } }),
  'data: {bad JSON}\n\n', 'event: response.output_text.delta\n\n', ': ' + 'x'.repeat(65 * 1024) + '\n\n',
]) test(`unknown/output/cap prefix permanently closes native retry window (${prefix.slice(0, 45)})`, async () => {
  reply = (_req, res) => answer(res, prefix + transient);
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.text, prefix + transient);
});

for (const prefix of ['data: {"type":"response.created"', 'data: {"type":"response.output_text.delta","delta":"part', ': partial-comment', 'data: \xff\n\n']) {
  for (const disconnect of [false, true]) test(`partial native prefix never replays (disconnect=${disconnect}, ${prefix.slice(0, 40)})`, async () => {
    const bytes = prefix.includes('\xff') ? Buffer.from([100, 97, 116, 97, 58, 32, 255, 10, 10]) : Buffer.from(prefix);
    reply = (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(bytes); if (disconnect) setTimeout(() => req.socket.destroy(), 10); else res.end(); };
    const result = await ask(); assert.equal(seen.length, 1); assert.deepEqual(result.bytes, bytes);
    assert.doesNotMatch(result.text, /response.completed/);
  });
}

for (const mode of ['json-sse-mime', 'structured-sse', 'failed-sse']) test(`known Azure ${mode} projects only validated IDs and keeps replay fields`, async () => {
  const body = history(), original = structuredClone(body);
  reply = (_req, res) => {
    if (seen.length > 1) return answer(res);
    if (mode === 'json-sse-mime') return answer(res, JSON.stringify(azure), 400);
    if (mode === 'structured-sse') return answer(res, created + frame({ type: 'error', ...azure }), 400);
    answer(res, created + frame(failure('invalid_request_error', azure.error.message)));
  };
  assertSuccess(await ask(body), 2); assert.deepEqual(body, original);
  assert.deepEqual(JSON.parse(seen[0].bytes), original);
  const projected = projectResponsesHistory(original); assert.equal(projected.ok, true);
  assert.deepEqual(JSON.parse(seen[1].bytes), projected.body);
  assert.equal(projected.body.input[2].encrypted_content, 'ENCRYPTED_REPLAY_BYTES');
  assert.equal(projected.body.input[5].id, 'tools-kept'); assert.equal(projected.body.input[6].id, 'custom-kept');
  assert.equal(projected.body.input[7].id, 'custom-output-kept'); assert.equal(projected.body.tools[0].strict, false);
  const { 'content-length': firstLength, ...firstHeaders } = seen[0].headers;
  const { 'content-length': nextLength, ...nextHeaders } = seen[1].headers;
  assert.deepEqual(firstHeaders, nextHeaders);
  assert.equal(Number(firstLength), seen[0].bytes.length); assert.equal(Number(nextLength), seen[1].bytes.length);
});

for (const shape of ['error', 'failed', 'type-less']) test(`held-open native HTTP400 complete ${shape} SSE recovers before EOF and releases old stream`, async () => {
  const event = shape === 'failed' ? failure('invalid_request_error', azure.error.message) : { type: 'error', ...azure };
  const raw = shape === 'type-less' ? `data: ${JSON.stringify(azure)}\n\n` : frame(event);
  reply = (_req, res) => {
    if (seen.length > 1) return answer(res);
    res.writeHead(400, { 'Content-Type': 'text/event-stream' });
    res.write(created); res.write(raw);
  };
  assertSuccess(await ask(), 2);
  await waitFor(() => finished === 2, { label: 'held-open HTTP400 error stream released' });
  assert.deepEqual(JSON.parse(seen[1].bytes), projectResponsesHistory(history()).body);
});

for (const tail of ['data: {"type":"response.output_text.delta","delta":"partial', 'data: {"type":"unknown","opaque":"output"}\n\n']) {
  test(`HTTP400 complete error with unknown tail never replays (${tail.slice(0, 42)})`, async () => {
    const raw = created + frame({ type: 'error', ...azure }) + tail;
    reply = (_req, res) => answer(res, raw, 400);
    const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.status, 400); assert.equal(result.text, raw);
  });
}

test('cancellation after held-open HTTP400 error during retry delay prevents second request', async () => {
  let client;
  reply = (_req, res) => {
    res.writeHead(400, { 'Content-Type': 'text/event-stream' }); res.write(frame({ type: 'error', ...azure }));
    setTimeout(() => client.destroy(), 2);
  };
  await new Promise((resolve, reject) => {
    client = http.request({ hostname: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/v1/responses', headers: { 'Content-Type': 'application/json' } });
    client.once('error', error => error.code === 'ECONNRESET' ? resolve() : reject(error)); client.once('close', resolve); client.end(JSON.stringify(history()));
  });
  await new Promise(resolve => setTimeout(resolve, 70)); assert.equal(seen.length, 1); assert.equal(lastLog().err_class, 'cancelled');
  await waitFor(() => finished === 1, { label: 'cancelled held-open HTTP400 error released' });
});

test('repeated Azure error projects once, resends same bytes, returns last exact failure at shared cap', async () => {
  reply = (_req, res) => answer(res, JSON.stringify({ error: { ...azure.error, message: `${azure.error.message} attempt ${seen.length}` } }), 400, 'text/event-stream', { 'x-request-id': `last-${seen.length}` });
  const result = await ask(); assert.equal(seen.length, 5); assert.equal(result.status, 400);
  assert.equal(result.text, JSON.stringify({ error: { ...azure.error, message: `${azure.error.message} attempt 5` } }));
  assert.equal(result.headers['x-request-id'], 'last-5'); assert.equal(lastLog().attempts, 5);
  for (const request of seen.slice(2)) assert.deepEqual(request.bytes, seen[1].bytes);
  assert.match(lastLog().err, /different Azure OpenAI resource/); assert.doesNotMatch(lastLog().err, /缺|terminal/);
});

for (const mutate of [
  body => { body.previous_response_id = 'server-reference'; },
  body => { body.input.push({ type: 'item_reference', id: 'server-only' }); },
  body => { body.input.pop(); },
  body => { body.input[1].phase = null; },
  body => { body.input[2].summary = null; },
  body => { body.input[3].status = 'in_progress'; },
  body => { body.input[5].tools[0].tools[0].format.definition = ''; },
]) test(`Azure projection refuses incomplete or unsupported history (${mutate.toString().slice(0, 55)})`, async () => {
  const body = history(); mutate(body); const before = structuredClone(body);
  reply = (_req, res) => answer(res, JSON.stringify(azure), 400);
  const result = await ask(body); assert.equal(seen.length, 1); assert.equal(result.text, JSON.stringify(azure)); assert.deepEqual(body, before);
});

test('actual HTTP error logging sanitizes channel secrets but preserves original response bytes', async () => {
  const raw = JSON.stringify({ error: { code: 'invalid_request_error', message: 'Failed fixture-secret request' } });
  reply = (_req, res) => answer(res, raw, 400, 'text/event-stream', { 'Content-Length': Buffer.byteLength(raw) });
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(result.text, raw);
  assert.equal(Number(result.headers['content-length']), Buffer.byteLength(raw));
  assert.doesNotMatch(lastLog().err, /fixture-secret/); assert.match(lastLog().err, /Failed/);
});

test('HTTP SSE logs actual terminal error after large lifecycle metadata', async () => {
  const raw = frame({ type: 'response.created', response: { status: 'in_progress', output: [], metadata: { padding: 'x'.repeat(2000) } } })
    + frame({ type: 'error', error: { code: 'invalid_api_key', message: 'Actual terminal authentication failure' } });
  reply = (_req, res) => answer(res, raw, 401);
  const result = await ask(); assert.equal(result.text, raw); assert.equal(seen.length, 1);
  assert.match(lastLog().err, /Actual terminal authentication failure/); assert.doesNotMatch(lastLog().err, /padding|缺|terminal state/);
});

test('native failed JSON Azure error also preserves encrypted history and projects once', async () => {
  const body = history(); body.stream = false;
  reply = (_req, res) => answer(res, JSON.stringify(seen.length === 1 ? failure('invalid_request_error', azure.error.message).response : complete), 200, 'application/json');
  const result = await ask(body); assert.equal(seen.length, 2); assert.match(result.text, /RECOVERY_OK/);
  assert.deepEqual(JSON.parse(seen[1].bytes), projectResponsesHistory(body).body);
});

for (const [status, error] of [[400, { code: 'invalid_request_error', message: 'Invalid input' }], [401, { code: 'invalid_api_key', message: 'Invalid API key' }], [403, { code: 'permission_denied', message: 'Access denied' }], [503, { code: 'content_policy_violation', message: 'Content policy blocked' }]]) {
  test(`HTTP${status} error uses original body and sanitized actual log, not missing-terminal`, async () => {
    configure({ pinned: true });
    const raw = JSON.stringify({ error });
    reply = (_req, res) => answer(res, raw, status, 'text/event-stream', { 'x-request-id': 'original-error-header' });
    const result = await ask(); assert.equal(seen.length, status >= 500 ? 3 : 1); assert.equal(result.status, status); assert.equal(result.text, raw);
    assert.equal(result.headers['x-request-id'], 'original-error-header'); assert.match(lastLog().err, new RegExp(error.message));
    assert.doesNotMatch(lastLog().err, /缺|terminal/);
  });
}

test('native transient exhaustion retains exact last failure bytes and no fabricated success', async () => {
  reply = (_req, res) => answer(res, frame(failure('rate_limit_exceeded', `Rate limit attempt ${seen.length}`)));
  const result = await ask(); assert.equal(seen.length, 5); assert.equal(result.text, frame(failure('rate_limit_exceeded', 'Rate limit attempt 5')));
  assert.equal(lastLog().attempts, 5); assert.ok(lastLog().err_class); assert.doesNotMatch(result.text, /response.completed/);
});

test('empty completed remains untouched and never replays for Codex', async () => {
  const raw = frame({ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 9, output_tokens: 0 } } });
  reply = (_req, res) => answer(res, raw);
  const result = await ask(); assert.equal(result.text, raw); assert.equal(seen.length, 1); assert.equal(lastLog().out, 0);
});

test('client cancellation during native retry wait stops future calls and closes old stream', async () => {
  let client;
  reply = (_req, res) => { answer(res, created); setTimeout(() => client.destroy(), 2); };
  await new Promise((resolve, reject) => {
    client = http.request({ hostname: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/v1/responses', headers: { 'Content-Type': 'application/json' } });
    client.once('error', error => error.code === 'ECONNRESET' ? resolve() : reject(error)); client.once('close', resolve); client.end(JSON.stringify(history()));
  });
  await new Promise(resolve => setTimeout(resolve, 70)); assert.equal(seen.length, 1); assert.equal(lastLog().err_class, 'cancelled');
  await waitFor(() => finished === seen.length, { label: 'cancelled native upstream closed' });
});

test('shared native deadline does not restart after lifecycle-only failures', async () => {
  const body = { model: 'fixture-model', stream: true, input: 'small' };
  reply = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(created); };
  const started = Date.now(), result = await ask(body);
  assert.equal(result.status, 504); assert.equal(lastLog().err_class, 'timeout'); assert.ok(seen.length <= 5); assert.ok(Date.now() - started < 1500);
  await waitFor(() => finished === seen.length, { label: 'deadline closes all attempted native streams' });
});

test('native selected credentials survive live provider changes on retry', async () => {
  configure({ keyFallback: true });
  reply = (_req, res) => {
    if (seen.length > 1) return answer(res);
    mod._state.store.codex[0].api_key = 'changed-secret'; mod._state.store.codex[0].keys = [];
    answer(res, transient);
  };
  const before = logs().length; assertSuccess(await ask(), 2);
  assert.equal(logs().length, before + 1, 'one terminal log per recovered request');
  await waitFor(() => finished === seen.length, { label: 'old native failure stream closed' });
  assert.equal(lastLog().err || '', '');
});

for (const override of [true, false]) test(`native adapted transient exhaustion retains actual last body (${override})`, async () => {
  configure({ override });
  const body = history(); body.stream = !override;
  const raw = override ? transient : JSON.stringify(failure('upstream_error').response);
  reply = (_req, res) => answer(res, raw, 200, override ? 'text/event-stream' : 'application/json');
  const result = await ask(body); assert.equal(seen.length, 5); assert.equal(result.status, 200); assert.equal(result.text, raw);
  assert.doesNotMatch(result.text, /response.completed/);
});

for (const override of [true, false]) test(`native explicit upstream format override preserves successful effort (${override})`, async () => {
  configure({ override });
  const body = history(); body.stream = !override;
  reply = (_req, res) => {
    if (override) answer(res, seen.length === 1 ? created : frame({ type: 'response.completed', response: complete }));
    else answer(res, JSON.stringify(seen.length === 1 ? failure('upstream_error').response : complete), 200, 'application/json');
  };
  const result = await ask(body); assert.equal(seen.length, 2); assert.match(result.text, /RECOVERY_OK/); assert.equal(lastLog().effort, 'max');
});
