'use strict';
// Synthetic fixtures only. Official hostnames are intercepted before DNS/network I/O.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyFailure, inspectFailureBytes } = require('../lib/responses-recovery');
const { projectResponsesHistory } = require('../lib/responses-history');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-agentrouter-history-'));
Object.assign(process.env, {
  MIXR_DATA_DIR: root, MIXR_CLAUDE_SETTINGS: path.join(root, 'settings.json'),
  MIXR_CODEX_CONFIG: path.join(root, 'config.toml'), MIXR_MAX_ATTEMPTS: '3',
  MIXR_CONV_RETRIES: '2', MIXR_RETRY_DELAY_MS: '10', MIXR_SSE_KEEPALIVE_MS: '0',
  MIXR_TOTAL_DEADLINE_MS: '3000', MIXR_STREAM_IDLE_TIMEOUT_MS: '500', MIXR_RESPONSE_ARCHIVE: 'off',
  MIXR_UPSTREAM_PROXY: '',
});
const mod = require('../mixrouter');
const { destroyAgents } = require('../lib/upstream-proxy');
const HOSTS = ['ps.air-outer.com', 'agentrouter.org'];
const REMOVABLE = new Set(['message', 'reasoning', 'function_call', 'function_call_output']);
const genericError = (trace = 'fixture') => ({ error: {
  message: `Upstream rejected the request as invalid [trace_id=${trace}]`,
  type: 'invalid_request_error', param: '', code: null,
} });
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const plainErrorFrame = (payload = genericError()) => `data: ${JSON.stringify(payload)}\n\n`;
const created = frame({ type: 'response.created', response: { id: 'discard-created', status: 'in_progress', output: [] } });
const generatedCall = { type: 'function_call', id: 'fc-generated', call_id: 'generated-call', namespace: 'fixture_tools',
  name: 'summarize', arguments: '{"label":"next"}', status: 'completed' };
const completed = { id: 'resp-success', object: 'response', status: 'completed', output: [generatedCall],
  usage: { input_tokens: 23, output_tokens: 7, input_tokens_details: { cached_tokens: 5 } } };
const successBytes = frame({ type: 'response.output_item.added', output_index: 0, item: { ...generatedCall, arguments: '' } })
  + frame({ type: 'response.function_call_arguments.delta', item_id: generatedCall.id, output_index: 0, delta: generatedCall.arguments })
  + frame({ type: 'response.completed', response: completed });

function history() {
  const tools = [{ type: 'namespace', name: 'fixture_tools', tools: [
    { type: 'function', name: 'summarize', strict: false, parameters: { type: 'object', properties: {
      label: { type: 'string' }, id: { type: 'string' },
    }, required: ['label'], additionalProperties: false } },
    { type: 'custom', name: 'echo_fixture', format: { type: 'grammar', syntax: 'regex', definition: 'fixture_[a-z]+' } },
  ] }];
  const body = { model: SLOT, stream: true, store: false,
    instructions: 'Use synthetic labels only.', prompt_cache_key: 'fixture-cache', prompt_cache_retention: '24h',
    reasoning: { effort: 'max', summary: 'detailed' }, include: ['reasoning.encrypted_content'],
    text: { format: { type: 'text' }, verbosity: 'medium' }, parallel_tool_calls: false,
    tool_choice: 'auto', max_output_tokens: 4096, metadata: { client: 'codex', id: 'metadata-id-kept' }, tools,
    input: [
      { role: 'developer', content: 'Continue the complete inline history.' },
      { type: 'message', id: 'msg-history', role: 'assistant', phase: 'commentary', status: 'completed',
        content: [{ type: 'output_text', text: 'Earlier synthetic answer.', annotations: [] }] },
      { type: 'additional_tools', id: 'additional-tools-kept', role: 'developer', tools: structuredClone(tools) },
    ] };
  for (let i = 0; i < 12; i++) body.input.push(
    { type: 'reasoning', id: `rs-${i}`, status: 'completed', summary: [{ type: 'summary_text', text: `Step ${i}` }],
      encrypted_content: `ENCRYPTED_FIXTURE_${i}`, content: i % 2 ? [{ type: 'reasoning_text', text: 'Synthetic reasoning.' }] : null },
    { type: 'function_call', id: `fc-${i}`, call_id: `call-${i}`, namespace: 'fixture_tools', name: 'summarize',
      arguments: JSON.stringify({ label: `fixture-${i}`, id: `argument-id-kept-${i}` }), status: 'completed' },
    { type: 'function_call_output', id: `fco-${i}`, call_id: `call-${i}`, status: 'completed', output: i === 0 ? '' : i % 2
      ? [{ type: 'input_text', text: JSON.stringify({ id: `output-id-kept-${i}`, padding: 'x'.repeat(1024) }) },
        { type: 'input_image', image_url: 'data:image/png;base64,RklYVFVSRQ==' }]
      : JSON.stringify({ id: `output-id-kept-${i}`, padding: 'x'.repeat(1024) }) },
  );
  body.input.push(
    { type: 'custom_tool_call', id: 'custom-call-kept', call_id: 'custom-pair-kept', namespace: 'fixture_tools',
      name: 'echo_fixture', input: 'fixture_ready', status: 'completed' },
    { type: 'custom_tool_call_output', id: 'custom-output-kept', call_id: 'custom-pair-kept', output: 'fixture_ready', status: 'completed' },
    { role: 'user', content: [{ type: 'input_text', text: 'Generate one next synthetic tool call.' }] },
  );
  return body;
}
function expectedProjection(body) {
  const projected = structuredClone(body);
  for (const item of projected.input) if (REMOVABLE.has(item.type)) delete item.id;
  return projected;
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

let upstream, proxy, api, reply, seen, fixtureId = 0, generationCount;
const sockets = new Set();
// 精确槽位:通用 match/default 规则删除后,多渠道(含备池)只能靠槽位别名 + 同一落点模型表达。
const SLOT = 'mixr-main', SLOT_MODEL = 'fixture-codex-model';
// 出站体:槽位把请求别名换成落点模型,其余字节一律照抄客户端请求。
const outbound = body => ({ ...structuredClone(body), model: SLOT_MODEL });
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;
function interceptRequest(original, options, ...rest) {
  const hostname = typeof options === 'object' && options !== null ? options.hostname : null;
  if (HOSTS.includes(hostname)) {
    return originalHttpRequest.call(http, { ...options, protocol: 'http:', hostname: '127.0.0.1',
      port: upstream.address().port, agent: false }, ...rest);
  }
  // Never allow a fixture regression to cause real upstream traffic.
  assert.ok(hostname === '127.0.0.1', `unexpected non-loopback transport target: ${hostname}`);
  return original.call(http, options, ...rest);
}
function configure({ host = HOSTS[0], other = true, keyFallback = true } = {}) {
  const provider = id => ({ id, name: id, enabled: true, api_key: 'synthetic-primary-key', wire_api: 'responses',
    base_url: host === '127.0.0.1' ? `http://127.0.0.1:${upstream.address().port}/${id}` : `https://${host}/${id}`,
    models: ['fixture-codex-model'], key_fallback: keyFallback, active_key: `fixture-a-${fixtureId}`, keys: [
      { id: `fixture-a-${fixtureId}`, label: 'a', key: 'synthetic-primary-key', enabled: true },
      { id: `fixture-b-${fixtureId}`, label: 'b', key: 'synthetic-alternate-key', enabled: true },
    ] });
  mod._state.store = { claude: [], codex: [provider('fixture-primary'), ...(other ? [provider('fixture-secondary')] : [])] };
  mod._state.slotMap = { claude: {}, codex: { main: { provider: 'fixture-primary', model: SLOT_MODEL,
    ...(other ? { pool: ['fixture-secondary'] } : {}) } } };
  mod._state.routes = { rules: [] };
}
function reset() {
  fixtureId++; seen = []; generationCount = 0; mod._state.sessions.clear(); mod._state.cooldowns = {}; mod._state.resetPools(); configure();
}
function answer(res, bytes = successBytes, status = 200, mime = 'text/event-stream', headers = {}) {
  if (status === 200 && (bytes === successBytes || bytes === JSON.stringify(completed))) generationCount++;
  res.writeHead(status, { 'Content-Type': mime, ...headers }); res.end(bytes);
}
function request(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: url, agent: false,
      headers: { 'Content-Type': 'application/json', 'session-id': `agentrouter-fixture-${fixtureId}`,
        'x-client-request-id': 'fixture-request-preserved', originator: 'codex-fixture', 'User-Agent': 'codex-fixture/1.0', Connection: 'close' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.once('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString('utf8') }); });
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('agentrouter history fixture timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const ask = body => request(proxy.address().port, 'POST', '/v1/responses', body);
function logs() {
  const file = path.join(root, 'logs/requests.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
const lastLog = () => logs().at(-1);
async function recoveryEvents() {
  const result = await request(api.address().port, 'GET', '/api/attempts');
  assert.equal(result.status, 200);
  const trace = JSON.parse(result.text).requests.find(item => item.id === lastLog().request_id);
  assert.ok(trace, 'terminal request log must correlate to an attempt trace');
  return trace.events.filter(event => event.code === 'native_history_recovery');
}
function assertSameBinding() {
  for (const request of seen) {
    assert.equal(request.url, '/fixture-primary/v1/responses');
    assert.equal(JSON.parse(request.bytes).model, 'fixture-codex-model');
    assert.equal(request.headers.authorization, 'Bearer synthetic-primary-key');
    assert.equal(request.headers['session-id'], `agentrouter-fixture-${fixtureId}`);
    const { 'content-length': firstLength, ...firstHeaders } = seen[0].headers;
    const { 'content-length': thisLength, ...thisHeaders } = request.headers;
    assert.deepEqual(thisHeaders, firstHeaders, 'native recovery preserves session/auth/client headers');
    if (firstLength !== undefined) assert.equal(Number(firstLength), seen[0].bytes.length);
    if (thisLength !== undefined) assert.equal(Number(thisLength), request.bytes.length);
  }
  assert.equal(lastLog().provider, 'fixture-primary'); assert.equal(lastLog().model_out, 'fixture-codex-model');
  assert.equal(lastLog().key_id, `fixture-a-${fixtureId}`); assert.ok(!lastLog().failover);
}

before(async () => {
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.once('end', () => { seen.push({ url: req.url, headers: req.headers, bytes: Buffer.concat(chunks) }); reply(req, res); });
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  http.request = (options, ...rest) => interceptRequest(originalHttpRequest, options, ...rest);
  https.request = (options, ...rest) => interceptRequest(originalHttpsRequest, options, ...rest);
  proxy = await mod.listen(0, mod.proxyHandler);
  api = await mod.listen(0, mod.apiHandler);
});
beforeEach(reset);
after(async () => {
  http.request = originalHttpRequest; https.request = originalHttpsRequest;
  destroyAgents();
  for (const socket of sockets) socket.destroy();
  await Promise.all([upstream, proxy, api].filter(Boolean).map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  fs.rmSync(root, { recursive: true, force: true });
});

test('exact AgentRouter HTTP400 envelope classifies as history for both official hosts and JSON/SSE bytes', () => {
  for (const host of HOSTS) {
    const provider = { base_url: `https://${host}/v1` }, payload = genericError();
    assert.equal(classifyFailure(payload, 400, provider)?.kind, 'history');
    for (const [bytes, isSse] of [[JSON.stringify(payload), false], [JSON.stringify(payload), true],
      [created + plainErrorFrame(payload), true], [plainErrorFrame(payload), true]]) {
      assert.equal(inspectFailureBytes(Buffer.from(bytes), isSse, 400, provider)?.kind, 'history');
    }
  }
});

test('generic400 remains terminal without official provider scope and outside HTTP400', () => {
  const payload = genericError(), bytes = Buffer.from(JSON.stringify(payload));
  for (const provider of [null, {}, { name: 'AgentRouter' }, { base_url: 'not a URL' },
    { base_url: 'https://fixture-user:fixture-pass@agentrouter.org' }, { base_url: 'ftp://agentrouter.org' },
    ...['unknown.invalid', 'ps.air-outer.com.evil.invalid', 'evil-agentrouter.org', 'api.agentrouter.org', '127.0.0.1']
      .map(host => ({ base_url: `https://${host}` }))]) {
    assert.equal(classifyFailure(payload, 400, provider), null);
    assert.equal(inspectFailureBytes(bytes, true, 400, provider), null);
  }
  assert.equal(classifyFailure(payload, 400), null);
  assert.equal(inspectFailureBytes(bytes, false, 400), null);
  for (const status of [200, 401, 403]) {
    const provider = { base_url: 'https://agentrouter.org' };
    assert.equal(classifyFailure(payload, status, provider), null);
    assert.equal(inspectFailureBytes(bytes, true, status, provider), null);
  }
});

test('schema/filter/extra output siblings and near-match envelopes cannot broaden history classification', () => {
  const provider = { base_url: 'https://ps.air-outer.com' }, payload = genericError();
  const missingParam = genericError(); delete missingParam.error.param;
  const missingCode = genericError(); delete missingCode.error.code;
  const variants = [missingParam, missingCode, { type: 'error', ...payload }, { ...payload, output: [] }, { ...payload, opaque_output: 'keep' },
    { error: { ...payload.error, output: 'keep' } }, { error: { ...payload.error, param: 'input' } },
    { error: { ...payload.error, code: 'invalid_request_error' } }, { error: { ...payload.error, type: 'server_error' } },
    { error: { ...payload.error, message: 'Invalid schema for function fixture_tools.summarize' } },
    { error: { ...payload.error, message: 'Content policy violation' } },
    { error: { ...payload.error, message: `${payload.error.message} Invalid schema` } },
    { error: { ...payload.error, message: 'Upstream rejected the request as invalid' } },
    genericError('fixture trace'), genericError('x'.repeat(257)),
  ];
  for (const variant of variants) {
    assert.equal(classifyFailure(variant, 400, provider), null, JSON.stringify(variant));
    assert.equal(inspectFailureBytes(Buffer.from(JSON.stringify(variant)), true, 400, provider), null);
  }
});

test('typed SSE and event:error synthesized type remain exact terminal failures', async () => {
  const provider = { base_url: 'https://agentrouter.org' };
  const payload = genericError();
  for (const raw of [frame({ type: 'error', ...payload }), `event: error\ndata: ${JSON.stringify(payload)}\n\n`]) {
    reset();
    assert.equal(inspectFailureBytes(Buffer.from(raw), true, 400, provider), null);
    reply = (_req, res) => answer(res, raw, 400, 'text/event-stream', { 'x-request-id': 'typed-terminal' });
    const result = await ask(history());
    assert.equal(result.status, 400); assert.deepEqual(result.bytes, Buffer.from(raw)); assert.equal(seen.length, 1);
    assert.equal(result.headers['x-request-id'], 'typed-terminal'); assert.equal(lastLog().resource_recovery_skipped, undefined);
    assert.equal((await recoveryEvents()).length, 0);
  }
});

test('complete history error plus unknown/output/partial tail is never replayable', () => {
  const provider = { base_url: 'https://agentrouter.org' }, errorBytes = created + plainErrorFrame();
  for (const tail of [frame({ type: 'unknown', opaque_output: 'keep' }), frame({ type: 'response.output_text.delta', delta: 'visible' }),
    'data: {"type":"response.output_text.delta","delta":"partial']) {
    assert.equal(inspectFailureBytes(Buffer.from(errorBytes + tail), true, 400, provider), null);
  }
});

for (const [host, mode] of [[HOSTS[0], 'raw-json-sse-mime'], [HOSTS[1], 'data-only-sse']]) {
  test(`full proxy ${host}/${mode}: generic400 replays only safe IDs with immutable complete Codex payload`, async () => {
    configure({ host });
    const body = freeze(history()), original = structuredClone(body), logCount = logs().length;
    reply = (_req, res) => {
      if (seen.length > 1) return answer(res);
      // Live credential changes cannot change the native recovery's frozen binding.
      mod._state.store.codex[0].api_key = 'synthetic-changed-key'; mod._state.store.codex[0].keys = [];
      answer(res, mode === 'raw-json-sse-mime' ? JSON.stringify(genericError()) : created + plainErrorFrame(), 400);
    };
    const result = await ask(body);
    assert.equal(result.status, 200, result.text); assert.deepEqual(result.bytes, Buffer.from(successBytes));
    assert.equal(seen.length, 2); assert.deepEqual(JSON.parse(seen[0].bytes), outbound(original));
    assert.deepEqual(JSON.parse(seen[1].bytes), expectedProjection(outbound(original))); assert.deepEqual(body, original);
    assert.equal(projectResponsesHistory(outbound(original)).ok, true); assertSameBinding();
    assert.equal(lastLog().attempts, 2); assert.equal(lastLog().effort, 'max');
    assert.equal(lastLog().in, 23); assert.equal(lastLog().out, 7); assert.equal(lastLog().cache_read, 5);
    assert.equal(lastLog().err || '', ''); assert.equal(lastLog().err_class || '', '');
    assert.equal(logs().length, logCount + 1); assert.equal(lastLog().resource_recovery_skipped, undefined);
    assert.equal((await recoveryEvents()).length, 1);
    assert.equal(generationCount, 1, 'only success generates a tool call; historical tools are never executed');
    assert.equal((result.text.match(/event: response\.output_item\.added\n/g) || []).length, 1);
    assert.equal((result.text.match(/event: response\.function_call_arguments\.delta\n/g) || []).length, 1);
  });
}

test('nonstream native JSON generic400 follows the same safe projection and success-byte contract', async () => {
  const body = history(); body.stream = false; const original = structuredClone(body);
  reply = (_req, res) => seen.length === 1 ? answer(res, JSON.stringify(genericError()), 400, 'application/json')
    : answer(res, JSON.stringify(completed), 200, 'application/json');
  const result = await ask(body);
  assert.equal(result.status, 200); assert.equal(result.text, JSON.stringify(completed)); assert.equal(seen.length, 2);
  assert.deepEqual(JSON.parse(seen[1].bytes), expectedProjection(outbound(original))); assert.deepEqual(body, original); assertSameBinding();
  assert.equal((await recoveryEvents()).length, 1);
});

test('output ID alone is projected while empty output and semantic call ID survive', async () => {
  const body = freeze({ model: SLOT, stream: true, reasoning: { effort: 'max' }, input: [
    { type: 'function_call', call_id: 'semantic-call-kept', namespace: 'fixture_tools', name: 'summarize', arguments: '{"id":"argument-id-kept"}' },
    { type: 'function_call_output', id: 'fco-only', call_id: 'semantic-call-kept', output: '' },
  ] }), original = structuredClone(body);
  reply = (_req, res) => seen.length === 1 ? answer(res, JSON.stringify(genericError()), 400) : answer(res);
  const result = await ask(body); assert.equal(result.status, 200, result.text); assert.equal(seen.length, 2);
  assert.deepEqual(JSON.parse(seen[1].bytes), expectedProjection(outbound(original))); assert.deepEqual(body, original); assertSameBinding();
});

test('same generic400 from an unknown provider returns exact original bytes without retry', async () => {
  configure({ host: '127.0.0.1' });
  const body = history(), original = structuredClone(body), raw = JSON.stringify(genericError());
  reply = (_req, res) => answer(res, raw, 400, 'text/event-stream', { 'x-request-id': 'unknown-provider-error' });
  const result = await ask(body);
  assert.equal(result.status, 400); assert.equal(result.text, raw); assert.equal(result.headers['x-request-id'], 'unknown-provider-error');
  assert.equal(seen.length, 1); assert.equal(lastLog().attempts, 1); assert.equal(lastLog().resource_recovery_skipped, undefined);
  assert.deepEqual(JSON.parse(seen[0].bytes), outbound(original)); assert.deepEqual(body, original); assert.equal((await recoveryEvents()).length, 0);
});

test('ordinary400/filter/auth errors remain exact terminal failures, never history retries', async () => {
  for (const [status, message] of [[400, 'Invalid input: function_call_output id has an invalid format'],
    [400, 'Invalid schema for function fixture_tools.summarize'], [400, 'Content policy violation'],
    [401, 'Invalid API key'], [403, 'Access denied']]) {
    reset(); configure({ keyFallback: false, other: false });
    const body = history(), original = structuredClone(body), raw = JSON.stringify({ error: { ...genericError().error, message } });
    reply = (_req, res) => answer(res, raw, status, 'text/event-stream', { 'x-request-id': 'terminal-error' });
    const result = await ask(body);
    assert.equal(result.status, status); assert.equal(result.text, raw); assert.equal(result.headers['x-request-id'], 'terminal-error');
    assert.equal(seen.length, 1); assert.equal(lastLog().attempts, 1); assert.equal(lastLog().resource_recovery_skipped, undefined);
    assert.deepEqual(JSON.parse(seen[0].bytes), outbound(original)); assert.deepEqual(body, original); assert.equal((await recoveryEvents()).length, 0);
  }
});

test('official host generic envelope under HTTP200 is not a hidden history retry', async () => {
  const raw = plainErrorFrame();
  reply = (_req, res) => answer(res, raw);
  const result = await ask(history());
  assert.equal(result.status, 200); assert.equal(result.text, raw); assert.equal(seen.length, 1);
  assert.equal(lastLog().resource_recovery_skipped, undefined); assert.equal((await recoveryEvents()).length, 0);
});

test('HTTP400 complete error plus unknown or partial tail preserves every byte without replay', async () => {
  for (const tail of [frame({ type: 'unknown', opaque_output: 'keep' }), 'data: {"type":"response.output_text.delta","delta":"partial']) {
    reset();
    const body = history(), original = structuredClone(body), raw = created + plainErrorFrame() + tail;
    reply = (_req, res) => answer(res, raw, 400, 'text/event-stream', { 'x-request-id': 'unsafe-tail' });
    const result = await ask(body);
    assert.equal(result.status, 400); assert.deepEqual(result.bytes, Buffer.from(raw)); assert.equal(seen.length, 1);
    assert.equal(result.headers['x-request-id'], 'unsafe-tail'); assert.deepEqual(JSON.parse(seen[0].bytes), outbound(original));
    assert.deepEqual(body, original); assert.equal((await recoveryEvents()).length, 0);
  }
});

test('visible generated output before generic error closes the native replay window', async () => {
  const raw = frame({ type: 'response.output_item.added', output_index: 0, item: generatedCall })
    + plainErrorFrame();
  reply = (_req, res) => answer(res, raw, 400);
  const result = await ask(history());
  assert.equal(result.status, 400); assert.equal(result.text, raw); assert.equal(seen.length, 1);
  assert.equal((await recoveryEvents()).length, 0);
});

test('unsafe original histories are not modified and log the existing fixed resource-recovery skip enum', async () => {
  for (const [mutate, code] of [
    [body => { body.input = body.input.filter(item => !(item.type === 'function_call_output' && item.call_id === 'call-11')); }, 'invalid_tool_pair'],
    [body => { body.previous_response_id = 'server-history-reference'; }, 'server_history_reference'],
    [body => { body.input.push({ type: 'opaque_item', id: 'unknown-resource-id' }); }, 'unsupported_item_id'],
  ]) {
    reset();
    const body = history(); mutate(body); const original = structuredClone(body), raw = JSON.stringify(genericError());
    assert.deepEqual(projectResponsesHistory(body), { ok: false, code });
    reply = (_req, res) => answer(res, raw, 400, 'text/event-stream', { 'x-request-id': 'unsafe-history' });
    const result = await ask(body);
    assert.equal(result.status, 400); assert.equal(result.text, raw); assert.equal(seen.length, 1); assert.equal(lastLog().attempts, 1);
    assert.equal(result.headers['x-request-id'], 'unsafe-history'); assert.equal(lastLog().resource_recovery_skipped, code);
    assert.deepEqual(JSON.parse(seen[0].bytes), outbound(original)); assert.deepEqual(body, original); assert.equal(generationCount, 0);
    assert.equal((await recoveryEvents()).length, 0);
  }
});

test('repeated generic failures project once and stop at MAX_ATTEMPTS3 + CONV_RETRIES2 with exact last response', async () => {
  configure({ other: false });
  const body = freeze(history()), original = structuredClone(body), logCount = logs().length;
  reply = (_req, res) => answer(res, JSON.stringify(genericError(`fixture-${seen.length}`)), 400, 'text/event-stream',
    { 'x-request-id': `last-${seen.length}` });
  const result = await ask(body);
  assert.equal(seen.length, 5); assert.equal(lastLog().attempts, 5); assert.equal(result.status, 400);
  assert.equal(result.text, JSON.stringify(genericError('fixture-5'))); assert.equal(result.headers['x-request-id'], 'last-5');
  assert.deepEqual(JSON.parse(seen[0].bytes), outbound(original)); assert.deepEqual(JSON.parse(seen[1].bytes), expectedProjection(outbound(original)));
  for (const request of seen.slice(2)) assert.deepEqual(request.bytes, seen[1].bytes, 'later attempts reuse the one safe projection');
  assert.deepEqual(body, original); assertSameBinding(); assert.equal(generationCount, 0); assert.equal(logs().length, logCount + 1);
  assert.equal(lastLog().resource_recovery_skipped, undefined); assert.match(lastLog().err, /Upstream rejected the request as invalid/);
  assert.doesNotMatch(result.text, /response.completed/); assert.equal((await recoveryEvents()).length, 4);
});
