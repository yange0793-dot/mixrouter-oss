'use strict';
// Synthetic local Chat traffic only; no real upstream or client configuration.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { waitFor } = require('./wait-for');
const { classifyChatFailure, emptyChatChunk } = require('../lib/chat-prefix-recovery');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-codex-chat-recovery-'));
Object.assign(process.env, {
  MIXR_DATA_DIR: root, MIXR_CLAUDE_SETTINGS: path.join(root, 'settings.json'),
  MIXR_CODEX_CONFIG: path.join(root, 'config.toml'), MIXR_MAX_ATTEMPTS: '3',
  MIXR_CONV_RETRIES: '2', MIXR_RETRY_DELAY_MS: '10', MIXR_SSE_KEEPALIVE_MS: '0',
  MIXR_TOTAL_DEADLINE_MS: '3000', MIXR_STREAM_IDLE_TIMEOUT_MS: '500',
  MIXR_RESPONSE_ARCHIVE: 'off', MIXR_UPSTREAM_PROXY: '',
});
const mod = require('../mixrouter');
const { destroyAgents } = require('../lib/upstream-proxy');
const MODEL = 'fixture-upstream-model';
// 精确槽位:通用 match/default 规则删除后,多渠道(含备池)只能靠槽位别名 + 同一落点模型表达。
const SLOT = 'mixr-main';
const frame = payload => `data: ${JSON.stringify(payload)}\n\n`;
const chunk = (delta, finish_reason = null) => ({ id: 'fixture-chat', object: 'chat.completion.chunk',
  created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason }] });
const noop = frame(chunk({ role: 'assistant', content: '' }));
const rateError = () => ({ error: { type: 'rate_limit_error', code: 'rate_limit_exceeded',
  message: 'Token rate limit exceeded, please try again later.' } });
const terminalErrors = [
  ['auth', { error: { type: 'server_error', code: 'invalid_api_key', message: 'Invalid API key' } }],
  ['quota', { error: { type: 'rate_limit_error', code: 'insufficient_quota', message: 'Account quota exhausted' } }],
  ['quota message', { error: { type: 'rate_limit_error', message: 'Insufficient quota, rate limit exceeded' } }],
  ['nested HTTP401', { error: { type: 'rate_limit_error', code: 'rate_limit_exceeded',
    message: 'Token rate limit exceeded', status_code: 401 } }],
  ['context', { error: { type: 'server_error', code: 'context_length_exceeded', message: 'Context length exceeded' } }],
  ['schema', { error: { type: 'server_error', code: 'invalid_schema', message: 'Invalid schema for function Read' } }],
];
const successBytes = frame(chunk({ content: 'CHAT_RECOVERY_OK' })) + frame(chunk({}, 'stop'))
  + frame({ id: 'fixture-chat', object: 'chat.completion.chunk', created: 1, model: MODEL, choices: [],
    usage: { prompt_tokens: 19, completion_tokens: 6, total_tokens: 25,
      prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } } })
  + 'data: [DONE]\n\n';
const successJson = { id: 'fixture-json', object: 'chat.completion', model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'CHAT_RECOVERY_OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 19, completion_tokens: 6, total_tokens: 25,
    prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } } };

function history() {
  return { model: SLOT, stream: true, store: false,
    instructions: 'Use synthetic local fixtures only.', reasoning: { effort: 'max', summary: 'detailed' },
    prompt_cache_key: 'cache-preserved', max_output_tokens: 256, parallel_tool_calls: false, tool_choice: 'auto',
    tools: [{ type: 'function', name: 'Read', description: 'Read a synthetic fixture.', strict: false,
      parameters: { type: 'object', properties: { file: { type: 'string' }, limit: { type: 'integer' } },
        required: ['file'], additionalProperties: false } }], input: [
      { role: 'developer', content: 'Preserve converted fields and tool history.' },
      { type: 'function_call', call_id: 'historic-call', name: 'Read', arguments: '{"file":"fixture.txt"}' },
      { type: 'function_call_output', call_id: 'historic-call', output: 'synthetic historical result' },
      { role: 'user', content: [{ type: 'input_text', text: 'Continue once.' }] },
    ] };
}
let upstream, proxy, reply, seen, closed, fixtureId = 0;
const sockets = new Set();
function configure({ other = true, keyFallback = true } = {}) {
  const provider = id => ({ id, name: id, enabled: true, model: MODEL, models: [MODEL], wire_api: 'chat',
    api_key: 'synthetic-primary-key', base_url: `http://127.0.0.1:${upstream.address().port}/${id}`,
    key_fallback: keyFallback, active_key: `key-a-${fixtureId}`, keys: [
      { id: `key-a-${fixtureId}`, key: 'synthetic-primary-key', enabled: true },
      { id: `key-b-${fixtureId}`, key: 'synthetic-alternate-key', enabled: true },
    ] });
  mod._state.store = { claude: [], codex: [provider('primary'), ...(other ? [provider('secondary')] : [])] };
  mod._state.slotMap = { claude: {}, codex: { main: { provider: 'primary', model: MODEL,
    ...(other ? { pool: ['secondary'] } : {}) } } };
  mod._state.routes = { rules: [] };
}
function reset() {
  fixtureId++; seen = []; closed = 0; mod._state.sessions.clear(); mod._state.cooldowns = {}; mod._state.resetPools(); configure();
}
function answer(res, bytes = successBytes, status = 200, mime = 'text/event-stream') {
  res.writeHead(status, { 'Content-Type': mime }); res.end(bytes);
}
function ask(body = history(), port = proxy.address().port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/v1/responses', agent: false,
      headers: { 'Content-Type': 'application/json', 'session-id': `chat-recovery-${fixtureId}`,
        'x-client-request-id': 'synthetic-request-preserved', originator: 'codex-fixture', Connection: 'close' } }, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('error', reject);
      res.once('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode,
        headers: res.headers, bytes, text: bytes.toString('utf8') }); });
    });
    req.on('error', reject); req.setTimeout(6000, () => req.destroy(new Error('Chat recovery fixture timeout')));
    req.end(JSON.stringify(body));
  });
}
function logs() {
  const file = path.join(root, 'logs/requests.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
const lastLog = () => logs().at(-1);
function events(text) {
  return text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
}
function assertBinding() {
  for (const request of seen) {
    assert.equal(request.url, '/primary/v1/chat/completions');
    assert.equal(request.body.model, MODEL); assert.equal(request.body.reasoning_effort, 'max');
    assert.equal(request.headers.authorization, 'Bearer synthetic-primary-key');
    assert.deepEqual(request.bytes, seen[0].bytes, 'recovery reuses exact converted request bytes');
    assert.deepEqual(request.headers, seen[0].headers, 'provider/key/client headers stay frozen');
  }
  assert.equal(lastLog().provider, 'primary'); assert.equal(lastLog().model_out, MODEL);
  assert.equal(lastLog().key_id, `key-a-${fixtureId}`); assert.ok(!lastLog().failover);
}
function recovered(result, count = 2) {
  assert.equal(result.status, 200, result.text); assert.equal(seen.length, count); assert.equal(lastLog().attempts, count);
  assert.equal(lastLog().err || '', ''); assert.equal(lastLog().err_class || '', ''); assertBinding();
  assert.doesNotMatch(result.text, /rate_limit|Token rate|response\.failed/);
  const parsed = events(result.text), completed = parsed.filter(event => event.type === 'response.completed');
  assert.equal(parsed.filter(event => event.type === 'response.created').length, 1, 'discarded attempts emit no synthetic lifecycle');
  assert.equal(completed.length, 1); assert.equal(completed[0].response.output[0].content[0].text, 'CHAT_RECOVERY_OK');
  assert.equal(completed[0].response.usage.input_tokens_details.cached_tokens, 4);
  assert.equal(completed[0].response.usage.output_tokens_details.reasoning_tokens, 2);
  assert.equal(lastLog().in, 19); assert.equal(lastLog().out, 6); assert.equal(lastLog().cache_read, 4);
}

before(async () => {
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', bytes => chunks.push(bytes));
    req.once('end', () => { const bytes = Buffer.concat(chunks); seen.push({ url: req.url, headers: req.headers,
      bytes, body: JSON.parse(bytes) }); reply(req, res); });
    res.once('close', () => closed++);
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  proxy = await mod.listen(0, mod.proxyHandler);
});
beforeEach(reset);
after(async () => {
  destroyAgents(); for (const socket of sockets) socket.destroy();
  await Promise.all([upstream, proxy].filter(Boolean).map(server => new Promise(resolve => {
    server.closeAllConnections(); server.close(resolve);
  })));
  fs.rmSync(root, { recursive: true, force: true });
});

test('Chat classifier returns only a narrow transient failure with its actual detail', () => {
  const failure = classifyChatFailure(rateError());
  assert.deepEqual(failure, { kind: 'transient', detail: rateError().error.message });
  assert.equal(classifyChatFailure({ error: { message: 'rate limit exceeded: Your requests exceeded token rate limit.' } })?.kind, 'transient',
    'synthetic message-only envelope does not invent the unknown live code/type');
  assert.equal(classifyChatFailure({ error: { type: 'server_error', message: 'Server temporarily unavailable' } })?.kind, 'transient');
  for (const [, payload] of terminalErrors) assert.equal(classifyChatFailure(payload), null);
  for (const payload of [null, [], {}, 'rate_limit', { ...rateError(), choices: [] },
    { ...rateError(), opaque_output: 'cannot discard' }, { error: { ...rateError().error, output: 'cannot discard' } },
    { error: { type: 'invalid_request_error', message: 'Upstream rejected the request as invalid [trace_id=fixture]' } }]) {
    assert.equal(classifyChatFailure(payload), null, JSON.stringify(payload));
  }
  for (const status of [400, 401, 403]) assert.equal(classifyChatFailure(rateError(), status), null);
});

test('empty Chat chunks allow no-op metadata but reject every output and unknown shape', () => {
  for (const payload of [chunk({}), chunk({ role: 'assistant', content: '' }), chunk({ content: null }),
    { id: 'fixture', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1 } }]) {
    assert.equal(emptyChatChunk(payload), true, JSON.stringify(payload));
  }
  for (const payload of [null, [], {}, { choices: [] }, { ...chunk({}), object: 'chat.completion' },
    chunk({ content: ' ' }), chunk({ content: 'visible' }), chunk({ reasoning_content: 'thought' }),
    chunk({ reasoning: 'thought' }), chunk({ tool_calls: [{ index: 0, id: 'call' }] }),
    chunk({ function_call: { name: 'Read', arguments: '' } }), chunk({ opaque_output: '' }),
    chunk({ role: 'tool' }), chunk({ content: [] }), chunk({}, 'stop'),
    { ...chunk({}), opaque_output: 'unknown' }, { ...chunk({}), choices: [{ index: 0, delta: {}, opaque: true }] },
    { ...chunk({}), choices: [{ index: 0, delta: null, finish_reason: null }] }]) {
    assert.equal(emptyChatChunk(payload), false, JSON.stringify(payload));
  }
});

test('HTTP200 SSE token rate_limit before output is invisible and preserves converted fields and frozen binding', async () => {
  const body = history(), original = structuredClone(body), beforeLogs = logs().length;
  reply = (_req, res) => {
    if (seen.length > 1) return answer(res);
    const provider = mod._state.store.codex[0];
    provider.api_key = 'synthetic-changed-key'; provider.active_key = `key-b-${fixtureId}`;
    provider.keys[0].key = 'synthetic-changed-key'; provider.model = 'changed-model'; provider.wire_api = 'responses';
    answer(res, frame(rateError()));
  };
  const result = await ask(body); recovered(result); assert.deepEqual(body, original); assert.equal(logs().length, beforeLogs + 1);
  assert.equal(seen[0].body.max_tokens, original.max_output_tokens); assert.equal(seen[0].body.prompt_cache_key, original.prompt_cache_key);
  assert.deepEqual(seen[0].body.tools, [{ type: 'function', function: { name: 'Read', description: original.tools[0].description,
    parameters: original.tools[0].parameters, strict: false } }]);
  assert.equal(seen[0].body.tool_choice, 'auto'); assert.equal(seen[0].body.parallel_tool_calls, false);
  assert.ok(seen[0].body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'historic-call'
    && message.content === 'synthetic historical result'));
});

test('comments and strict empty role/content chunks remain hidden before rate-limit recovery', async () => {
  const prefix = ': synthetic keepalive\n\n' + noop + frame(chunk({ content: null }));
  reply = (_req, res) => answer(res, seen.length === 1 ? prefix + frame(rateError()) : successBytes);
  const result = await ask(); recovered(result); assert.doesNotMatch(result.text, /synthetic keepalive/);
});

for (const [name, payload] of terminalErrors) test(`HTTP200 ${name} error does not replay despite misleading transient type`, async () => {
  reply = (_req, res) => answer(res, noop + frame(payload));
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(lastLog().attempts, 1);
  assert.doesNotMatch(result.text, /response\.completed|CHAT_RECOVERY_OK/); assert.ok(lastLog().err);
});

for (const [name, prefix, visible] of [
  ['text', frame(chunk({ content: 'VISIBLE_ONCE' })), 'VISIBLE_ONCE'],
  ['whitespace text', frame(chunk({ content: ' ' })), ' '],
  ['reasoning_content', frame(chunk({ reasoning_content: 'THOUGHT_ONCE' })), 'THOUGHT_ONCE'],
  ['reasoning', frame(chunk({ reasoning: 'THOUGHT_ONCE' })), 'THOUGHT_ONCE'],
  ['tool', frame(chunk({ tool_calls: [{ index: 0, id: 'tool-once', type: 'function', function: { name: 'Read', arguments: '{"file":"fixture.txt"}' } }] })), null],
  ['unknown delta', frame(chunk({ opaque_output: 'unknown bytes' })), null],
  ['unknown top-level', frame({ ...chunk({}), opaque_output: 'unknown bytes' }), null],
  ['unknown event', frame({ type: 'unknown', opaque_output: 'unknown bytes' }), null],
  ['malformed frame', 'data: {not-json}\n\n', null],
  ['partial malformed frame', 'data: {not-json\n', null],
  ['whitespace frame', ' \n\n', null],
]) test(`${name} before SSE error closes the replay window`, async () => {
  reply = (_req, res) => answer(res, noop + prefix + frame(rateError()));
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(lastLog().attempts, 1);
  assert.doesNotMatch(result.text, /response\.completed|CHAT_RECOVERY_OK/);
  if (visible !== null) {
    const output = events(result.text).filter(event => event.type === 'response.output_text.delta'
      || event.type === 'response.reasoning_summary_text.delta');
    assert.deepEqual(output.map(event => event.delta), [visible], 'committed text/thought is emitted once');
  }
});

test('an empty prefix disconnect retries the same converted request and returns one success', async () => {
  reply = (_req, res) => {
    if (seen.length > 1) return answer(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(noop, () => setImmediate(() => res.destroy()));
  };
  const result = await ask(); recovered(result);
  await waitFor(() => closed === seen.length, { label: 'abandoned Chat responses closed' });
});

test('no-op-only clean EOF resumes without manufacturing an empty success', async () => {
  reply = (_req, res) => answer(res, seen.length === 1 ? noop : successBytes);
  recovered(await ask());
});

test('partial no-op frame at disconnect remains a commit barrier', async () => {
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"id":"fixture","object":"chat.completion.chunk","choices":[', () => setImmediate(() => res.destroy()));
  };
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(lastLog().attempts, 1);
  assert.doesNotMatch(result.text, /response\.completed|CHAT_RECOVERY_OK/);
});

test('disconnect before any body bytes also remains recoverable', async () => {
  reply = (_req, res) => {
    if (seen.length > 1) return answer(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); setImmediate(() => res.destroy());
  };
  recovered(await ask());
});

test('a disconnect after visible output is never replayed', async () => {
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(frame(chunk({ content: 'VISIBLE_ONCE' })), () => setImmediate(() => res.destroy()));
  };
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(lastLog().attempts, 1);
  assert.doesNotMatch(result.text, /response\.completed|CHAT_RECOVERY_OK/);
  assert.equal(events(result.text).filter(event => event.type === 'response.output_text.delta' && event.delta === 'VISIBLE_ONCE').length, 1);
});

test('64KiB prefix overflow is a commit barrier rather than an expanded recovery window', async () => {
  reply = (_req, res) => answer(res, ': ' + 'x'.repeat(64 * 1024) + '\n\n' + frame(rateError()));
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(lastLog().attempts, 1);
  assert.doesNotMatch(result.text, /response\.completed|CHAT_RECOVERY_OK/);
});

test('repeated pre-output errors stay inside the existing shared attempts/conv quota', async () => {
  const beforeLogs = logs().length;
  reply = (_req, res) => answer(res, noop + frame(rateError()));
  const result = await ask(); assert.ok(seen.length >= 2 && seen.length <= 5, `shared cap is MAX_ATTEMPTS3 + CONV_RETRIES2, got ${seen.length}`);
  assert.equal(lastLog().attempts, seen.length); assert.equal(logs().length, beforeLogs + 1); assertBinding();
  assert.doesNotMatch(result.text, /response\.completed|CHAT_RECOVERY_OK/); assert.ok(lastLog().err);
});

test('client cancellation while the no-op prefix is held closes upstream without another call', async () => {
  let held, responseStarted = false;
  reply = (_req, res) => { held = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(noop); };
  const beforeLogs = logs().length;
  const req = http.request({ hostname: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/v1/responses', agent: false,
    headers: { 'Content-Type': 'application/json', 'session-id': `chat-cancel-${fixtureId}`, Connection: 'close' } }, res => {
    responseStarted = true; res.resume(); res.on('error', () => {});
  });
  req.on('error', () => {}); req.end(JSON.stringify(history()));
  await waitFor(() => held, { label: 'Chat no-op prefix held upstream' });
  assert.equal(responseStarted, false, 'synthetic response.created must not commit an empty prefix'); req.destroy();
  await waitFor(() => logs().length === beforeLogs + 1 && closed === 1, { label: 'cancelled Chat request settled and upstream closed' });
  assert.equal(lastLog().err_class, 'cancelled'); assert.equal(lastLog().attempts, 1);
  held.end(frame(rateError())); await new Promise(resolve => setImmediate(resolve)); assert.equal(seen.length, 1);
});

test('unsupported response_format HTTP400 remains the real error and preserves the requested schema', async () => {
  configure({ other: false, keyFallback: false });
  const body = history(); body.text = { format: { type: 'json_schema', name: 'fixture_schema', strict: true,
    schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } };
  const raw = JSON.stringify({ error: { type: 'invalid_request_error', code: 'unsupported_parameter',
    param: 'response_format', message: 'response_format is not supported by this provider adapter' } });
  reply = (_req, res) => answer(res, raw, 400, 'application/json');
  const result = await ask(body); assert.equal(result.status, 400); assert.equal(result.text, raw); assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].body.response_format, { type: 'json_schema', json_schema: {
    name: 'fixture_schema', strict: true, schema: body.text.format.schema } });
  assert.match(lastLog().err, /response_format/); assert.equal(lastLog().attempts, 1);
});

for (const clientStream of [true, false]) test(`plain JSON200 transient error recovers to JSON success (client stream=${clientStream})`, async () => {
  const body = history(); body.stream = clientStream;
  reply = (_req, res) => answer(res, JSON.stringify(seen.length === 1 ? rateError() : successJson), 200, 'application/json');
  const result = await ask(body);
  if (clientStream) recovered(result);
  else {
    assert.equal(result.status, 200); assert.equal(seen.length, 2); assert.equal(lastLog().attempts, 2); assertBinding();
    const response = JSON.parse(result.text); assert.equal(response.status, 'completed');
    assert.equal(response.output[0].content[0].text, 'CHAT_RECOVERY_OK'); assert.doesNotMatch(result.text, /rate_limit/);
    assert.equal(lastLog().err || '', '');
  }
});

for (const compressed of [false, true]) test(`encoded JSON200 transient error cannot reopen recovery (gzip bytes=${compressed})`, async () => {
  const raw = JSON.stringify(rateError());
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    res.end(compressed ? gzipSync(raw) : raw);
  };
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(lastLog().attempts, 1);
  assert.doesNotMatch(result.text, /response\.completed|CHAT_RECOVERY_OK/);
});

test('plain JSON200 error beyond 64KiB is terminal and never replayed', async () => {
  const payload = rateError(); payload.error.message += 'x'.repeat(64 * 1024);
  reply = (_req, res) => answer(res, JSON.stringify(payload), 200, 'application/json');
  const result = await ask(); assert.equal(seen.length, 1); assert.equal(lastLog().attempts, 1);
  assert.doesNotMatch(result.text, /response\.completed|CHAT_RECOVERY_OK/);
});
