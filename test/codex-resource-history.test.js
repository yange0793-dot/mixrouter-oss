'use strict';
// Synthetic native Codex histories only; every HTTP request stays on loopback.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectResponsesHistory, isKnownResourceError } = require('../lib/responses-history');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-codex-resource-history-'));
Object.assign(process.env, {
  MIXR_DATA_DIR: root, MIXR_CLAUDE_SETTINGS: path.join(root, 'settings.json'),
  MIXR_CODEX_CONFIG: path.join(root, 'config.toml'), MIXR_MAX_ATTEMPTS: '3',
  MIXR_CONV_RETRIES: '2', MIXR_RETRY_DELAY_MS: '10', MIXR_SSE_KEEPALIVE_MS: '0',
  MIXR_TOTAL_DEADLINE_MS: '3000', MIXR_STREAM_IDLE_TIMEOUT_MS: '500', MIXR_RESPONSE_ARCHIVE: 'off',
});
const mod = require('../mixrouter');
const REMOVABLE = new Set(['message', 'reasoning', 'function_call', 'function_call_output']);
const RESOURCE_MESSAGE = 'The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it.';
function wrappedError(trace = 'fixture') {
  const raw = { error: { code: 0, type: 'invalid_request_error', message: `${RESOURCE_MESSAGE} trace_id: ${trace}` } };
  return { error: { type: 'invalid_request_error', param: '', code: null,
    message: 'failed to decode error response: json: cannot unmarshal number into Go struct field ResponseError.error.code of type string, raw: '
      + JSON.stringify(raw) + ` [trace_id=${trace}]` } };
}
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const generatedCall = { type: 'function_call', id: 'fc-generated-fixture', call_id: 'generated-fixture',
  namespace: 'fixture_tools', name: 'summarize', arguments: '{"label":"next"}', status: 'completed' };
const complete = { id: 'resp-fixture-success', object: 'response', status: 'completed',
  output: [generatedCall], usage: { input_tokens: 23, output_tokens: 7, input_tokens_details: { cached_tokens: 5 } } };
// The upstream generates a tool request but neither fixture nor proxy executes it.
const successBytes = frame({ type: 'response.output_item.added', output_index: 0, item: { ...generatedCall, arguments: '' } })
  + frame({ type: 'response.function_call_arguments.delta', item_id: generatedCall.id, output_index: 0, delta: generatedCall.arguments })
  + frame({ type: 'response.completed', response: complete });

function history() {
  const tools = [{ type: 'namespace', name: 'fixture_tools', description: 'Synthetic regression namespace', tools: [
    { type: 'function', name: 'summarize', description: 'Return a fixture label', strict: false,
      parameters: { type: 'object', properties: { label: { type: 'string' }, id: { type: 'string' } }, required: ['label'], additionalProperties: false } },
    { type: 'custom', name: 'echo_fixture', format: { type: 'grammar', syntax: 'regex', definition: 'fixture_[a-z]+' } },
  ] }];
  const body = { model: 'fixture-codex-model', stream: true, store: false,
    prompt_cache_key: 'fixture-cache', prompt_cache_retention: '24h',
    reasoning: { effort: 'max', summary: 'detailed' }, include: ['reasoning.encrypted_content'],
    text: { format: { type: 'text' }, verbosity: 'medium' }, parallel_tool_calls: false,
    tool_choice: 'auto', max_output_tokens: 4096, metadata: { client: 'codex', id: 'metadata-id-kept' }, tools,
    input: [
      { role: 'developer', content: 'Use only synthetic fixture labels.' },
      { role: 'user', content: [{ type: 'input_text', text: 'Continue this inline synthetic history.' }] },
      { type: 'message', id: 'msg-fixture-first', role: 'assistant', phase: 'commentary', status: 'completed',
        content: [{ type: 'output_text', text: 'Reviewing fixture labels.', annotations: [] }] },
      { type: 'additional_tools', id: 'additional-tools-kept', role: 'developer', tools: structuredClone(tools) },
    ] };
  for (let i = 0; i < 40; i++) {
    body.input.push(
      { type: 'reasoning', id: `rs-fixture-${i}`, status: 'completed', summary: [{ type: 'summary_text', text: `Fixture step ${i}` }],
        encrypted_content: `FIXTURE_ENCRYPTED_${i}`, content: i % 2 ? [{ type: 'reasoning_text', text: `Synthetic reasoning ${i}` }] : null },
      { type: 'function_call', id: `fc-fixture-${i}`, call_id: `call-fixture-${i}`, namespace: 'fixture_tools',
        name: 'summarize', arguments: JSON.stringify({ label: `fixture-${i}`, id: `argument-id-kept-${i}` }), status: 'completed' },
      { type: 'function_call_output', id: `fco-fixture-${i}`, call_id: `call-fixture-${i}`, status: 'completed',
        output: i % 2 ? [{ type: 'input_text', text: JSON.stringify({ id: `result-id-kept-${i}`, label: `fixture-${i}`, padding: 'x'.repeat(1024) }) }]
          : JSON.stringify({ id: `result-id-kept-${i}`, label: `fixture-${i}`, padding: 'x'.repeat(1024) }) },
    );
    if (i % 10 === 9) body.input.push({ type: 'message', id: `msg-fixture-${i}`, role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: `Synthetic batch ${i} completed.`, annotations: [] }] });
  }
  body.input.push(
    { type: 'custom_tool_call', id: 'custom-call-kept', call_id: 'custom-fixture', namespace: 'fixture_tools',
      name: 'echo_fixture', input: 'fixture_ready', status: 'completed' },
    { type: 'custom_tool_call_output', id: 'custom-output-kept', call_id: 'custom-fixture', output: 'fixture_ready', status: 'completed' },
    { role: 'user', content: 'Produce one next synthetic tool request.' },
  );
  return body;
}
function expectedProjection(body) {
  const expected = structuredClone(body);
  for (const item of expected.input) if (REMOVABLE.has(item.type)) delete item.id;
  return expected;
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function pairWithOutputId(id = 'fco-only-fixture') {
  return { model: 'fixture-codex-model', stream: true, input: [
    { type: 'function_call', call_id: 'pair-fixture', namespace: 'fixture_tools', name: 'summarize', arguments: '{"label":"fixture"}' },
    { type: 'function_call_output', id, call_id: 'pair-fixture', output: 'fixture result' },
  ] };
}

let upstream, proxy, reply, seen, fixtureId = 0, generationCount;
const sockets = new Set();
function configure({ other = true } = {}) {
  const provider = id => ({ id, name: id, enabled: true, api_key: 'synthetic-primary-key', wire_api: 'responses',
    base_url: `http://127.0.0.1:${upstream.address().port}/${id}`, models: ['fixture-codex-model'], key_fallback: true,
    active_key: `fixture-a-${fixtureId}`, keys: [
      { id: `fixture-a-${fixtureId}`, label: 'fixture a', key: 'synthetic-primary-key', enabled: true },
      { id: `fixture-b-${fixtureId}`, label: 'fixture b', key: 'synthetic-alternate-key', enabled: true },
    ] });
  mod._state.store = { claude: [], codex: [provider('fixture-primary'), ...(other ? [provider('fixture-secondary')] : [])] };
  mod._state.routes = { rules: [], default: mod.normalizeRule({ pool: other ? ['fixture-primary', 'fixture-secondary'] : ['fixture-primary'], strategy: 'priority' }) };
}
function answer(res, bytes = successBytes, status = 200, mime = 'text/event-stream', headers = {}) {
  if (status === 200 && bytes === successBytes) generationCount++;
  res.writeHead(status, { 'Content-Type': mime, ...headers }); res.end(bytes);
}
function ask(body = history()) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/v1/responses', agent: false,
      headers: { 'Content-Type': 'application/json', 'session-id': `codex-resource-fixture-${fixtureId}`,
        'x-client-request-id': 'fixture-request-preserved', originator: 'codex-fixture', 'User-Agent': 'codex-fixture/1.0', Connection: 'close' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('codex resource fixture timeout')));
    req.end(JSON.stringify(body));
  });
}
function logs() { return fs.readFileSync(path.join(root, 'logs/requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
function lastLog() { return logs().at(-1); }
function assertSameBinding() {
  for (const request of seen) {
    assert.equal(request.url, '/fixture-primary/v1/responses');
    assert.equal(JSON.parse(request.bytes).model, 'fixture-codex-model');
    assert.equal(request.headers.authorization, 'Bearer synthetic-primary-key');
    assert.equal(request.headers['session-id'], `codex-resource-fixture-${fixtureId}`);
    assert.equal(request.headers.originator, 'codex-fixture');
    assert.equal(request.headers['user-agent'], 'codex-fixture/1.0');
    const { 'content-length': firstLength, ...firstHeaders } = seen[0].headers;
    const { 'content-length': thisLength, ...thisHeaders } = request.headers;
    assert.deepEqual(thisHeaders, firstHeaders, 'projection must not change session/auth/request headers');
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
  proxy = await mod.listen(0, mod.proxyHandler);
});
beforeEach(() => {
  fixtureId++; seen = []; generationCount = 0; mod._state.sessions.clear(); mod._state.cooldowns = {}; mod._state.resetPools(); configure();
});
after(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([upstream, proxy].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  fs.rmSync(root, { recursive: true, force: true });
});

test('recognizes wrapped Azure numeric-code decode failure, including raw HTTP400 JSON bytes', () => {
  assert.equal(isKnownResourceError(wrappedError()), true);
  assert.equal(isKnownResourceError(JSON.stringify(wrappedError())), true);
});

test('40-call mixed Codex projection removes only supported top-level item ids without mutating history', () => {
  const body = freeze(history()), original = structuredClone(body), result = projectResponsesHistory(body);
  assert.equal(body.input.filter(item => item.type === 'function_call').length, 40);
  assert.ok(JSON.stringify(body).length > 60000, 'fixture exercises a long inline history');
  assert.equal(result.ok, true, result.code); assert.deepEqual(body, original);
  assert.notEqual(result.body, body); assert.deepEqual(result.body, expectedProjection(original));
  assert.equal(result.removed, original.input.filter(item => REMOVABLE.has(item.type) && Object.hasOwn(item, 'id')).length);
  for (const [index, item] of original.input.entries()) {
    const expected = REMOVABLE.has(item.type) ? (({ id, ...rest }) => rest)(item) : item;
    assert.deepEqual(result.body.input[index], expected, `item ${index}: only recognized resource id may disappear`);
  }
  assert.deepEqual(result.body.reasoning, original.reasoning); assert.deepEqual(result.body.tools, original.tools);
  assert.equal(result.body.metadata.id, 'metadata-id-kept');
});

test('function_call_output id alone is sufficient to project and call_id/output/namespace remain intact', () => {
  const body = freeze(pairWithOutputId()), result = projectResponsesHistory(body);
  assert.equal(result.ok, true, result.code); assert.equal(result.removed, 1);
  assert.deepEqual(result.body, expectedProjection(body));
  assert.equal(body.input[1].id, 'fco-only-fixture');
  assert.deepEqual(projectResponsesHistory(result.body), { ok: false, code: 'no_supported_item_ids' });
});

test('nullable Codex reasoning content is preserved alongside encrypted content and summary', () => {
  const body = freeze({ input: [{ type: 'reasoning', id: 'rs-null-fixture', summary: [], content: null,
    encrypted_content: 'FIXTURE_NULL_REASONING_ENCRYPTED' }] });
  const result = projectResponsesHistory(body); assert.equal(result.ok, true, result.code);
  assert.deepEqual(result.body, { input: [{ type: 'reasoning', summary: [], content: null, encrypted_content: 'FIXTURE_NULL_REASONING_ENCRYPTED' }] });
  assert.equal(body.input[0].id, 'rs-null-fixture'); assert.equal(body.input[0].content, null);
});

test('id-bearing function outputs preserve empty strings and complete inline text/image content', () => {
  for (const output of ['', 'fixture result', [{ type: 'input_text', text: '' }], [{ type: 'output_text', text: 'fixture' }],
    [{ type: 'input_image', image_url: 'https://fixture.invalid/image.png' }],
    [{ type: 'input_image', image_url: 'data:image/png;base64,RklYVFVSRQ==' }]]) {
    const body = pairWithOutputId(); body.input[1].output = output; freeze(body);
    const result = projectResponsesHistory(body); assert.equal(result.ok, true, result.code);
    assert.deepEqual(result.body, expectedProjection(body)); assert.deepEqual(body.input[1].output, output);
  }
});

test('legacy no-id function outputs and retained custom output ids keep existing payload behavior', () => {
  for (const output of [null, 19, false, {}, [], [{ type: 'input_file', file_id: 'fixture-file' }]]) {
    const body = pairWithOutputId(); delete body.input[1].id; body.input[0].id = 'fc-legacy-fixture'; body.input[1].output = output;
    body.input.push(
      { type: 'custom_tool_call', id: 'custom-legacy-kept', call_id: 'custom-legacy-fixture', name: 'echo_fixture', input: 'fixture_ready' },
      { type: 'custom_tool_call_output', id: 'custom-legacy-output-kept', call_id: 'custom-legacy-fixture', output },
    );
    const original = structuredClone(body); freeze(body); const result = projectResponsesHistory(body);
    assert.equal(result.ok, true, result.code); assert.deepEqual(result.body, expectedProjection(original)); assert.deepEqual(body, original);
    assert.equal(result.body.input[3].id, 'custom-legacy-output-kept');
  }
});

for (const id of ['', null, 0, 17, false, [], {}]) test(`malformed function_call_output id ${JSON.stringify(id)} is refused without mutation`, () => {
  const body = freeze(pairWithOutputId(id)), original = structuredClone(body), result = projectResponsesHistory(body);
  assert.deepEqual(result, { ok: false, code: 'invalid_item_id' }); assert.deepEqual(body, original);
});

for (const mode of ['wrapped-json-sse-mime', 'wrapped-sse-event']) test(`full proxy ${mode}: 40-call history retries once with only item ids removed`, async () => {
  const body = freeze(history()), original = structuredClone(body), logCount = fs.existsSync(path.join(root, 'logs/requests.jsonl')) ? logs().length : 0;
  reply = (_req, res) => {
    if (seen.length > 1) return answer(res);
    // Changes after the first request must not move a native recovery to another credential.
    mod._state.store.codex[0].api_key = 'synthetic-live-changed-key';
    mod._state.store.codex[0].keys = [];
    answer(res, mode === 'wrapped-json-sse-mime' ? JSON.stringify(wrappedError()) : frame({ type: 'error', ...wrappedError() }), 400);
  };
  const result = await ask(body);
  assert.equal(result.status, 200, result.text); assert.deepEqual(result.bytes, Buffer.from(successBytes));
  assert.equal(seen.length, 2, 'one safe replay follows the recognized Azure failure');
  assert.deepEqual(JSON.parse(seen[0].bytes), original);
  assert.deepEqual(JSON.parse(seen[1].bytes), expectedProjection(original));
  assert.deepEqual(body, original); assertSameBinding();
  assert.equal(lastLog().attempts, 2); assert.equal(lastLog().effort, 'max');
  assert.equal(lastLog().in, 23); assert.equal(lastLog().out, 7); assert.equal(lastLog().cache_read, 5);
  assert.equal(lastLog().err || '', ''); assert.equal(lastLog().err_class || '', '');
  assert.equal(logs().length, logCount + 1, 'recovery records one terminal request log');
  assert.equal(generationCount, 1, 'only the success mock generates a new call; no historical tool is executed');
  assert.equal((result.text.match(/event: response\.output_item\.added\n/g) || []).length, 1);
  assert.equal((result.text.match(/event: response\.function_call_arguments\.delta\n/g) || []).length, 1);
});

test('full proxy permits output-id-only history recovery', async () => {
  const body = pairWithOutputId(), original = structuredClone(body);
  reply = (_req, res) => seen.length === 1 ? answer(res, JSON.stringify(wrappedError()), 400) : answer(res);
  const result = await ask(body); assert.equal(result.status, 200, result.text); assert.equal(seen.length, 2);
  assert.deepEqual(JSON.parse(seen[1].bytes), expectedProjection(original)); assert.deepEqual(body, original); assertSameBinding();
});

test('repeated wrapped Azure errors project once, retain identical retry bytes and terminate at shared cap', async () => {
  configure({ other: false });
  const body = history(), original = structuredClone(body);
  reply = (_req, res) => answer(res, JSON.stringify(wrappedError(`fixture-${seen.length}`)), 400, 'text/event-stream', { 'x-request-id': `fixture-last-${seen.length}` });
  const result = await ask(body);
  assert.equal(seen.length, 5); assert.equal(lastLog().attempts, 5); assert.equal(result.status, 400);
  assert.equal(result.text, JSON.stringify(wrappedError('fixture-5'))); assert.equal(result.headers['x-request-id'], 'fixture-last-5');
  assert.deepEqual(JSON.parse(seen[0].bytes), original); assert.deepEqual(JSON.parse(seen[1].bytes), expectedProjection(original));
  for (const request of seen.slice(2)) assert.deepEqual(request.bytes, seen[1].bytes, 'later attempts reuse the single projection');
  assert.deepEqual(body, original); assertSameBinding(); assert.equal(generationCount, 0);
});

const invalidHistories = [
  ['incomplete tool pair', body => { body.input = body.input.filter(item => !(item.type === 'function_call_output' && item.call_id === 'call-fixture-39')); }, 'invalid_tool_pair'],
  ['duplicate function output', body => { body.input.push(structuredClone(body.input.find(item => item.type === 'function_call_output'))); }, 'invalid_tool_pair'],
  ['unknown output call reference', body => { body.input.find(item => item.type === 'function_call_output').call_id = 'unknown-call-fixture'; }, 'invalid_tool_pair'],
  ['duplicate function call', body => { body.input.push(structuredClone(body.input.find(item => item.type === 'function_call'))); }, 'invalid_tool_pair'],
  ['item_reference', body => { body.input.push({ type: 'item_reference', id: 'opaque-reference-fixture' }); }, 'unsupported_item_id'],
  ['previous_response_id', body => { body.previous_response_id = 'resp-reference-fixture'; }, 'server_history_reference'],
  ['conversation reference', body => { body.conversation = { id: 'conversation-reference-fixture' }; }, 'server_history_reference'],
  ['unknown id-bearing item', body => { body.input.push({ type: 'opaque_item', id: 'opaque-id-fixture' }); }, 'unsupported_item_id'],
  ['in-progress output', body => { body.input.find(item => item.type === 'function_call_output').status = 'in_progress'; }, 'incomplete_history_item'],
  ['numeric output id', body => { body.input.find(item => item.type === 'function_call_output').id = 123; }, 'invalid_item_id'],
  ['null output id', body => { body.input.find(item => item.type === 'function_call_output').id = null; }, 'invalid_item_id'],
  ['empty output id', body => { body.input.find(item => item.type === 'function_call_output').id = ''; }, 'invalid_item_id'],
  ['non-null malformed reasoning content', body => { body.input.find(item => item.type === 'reasoning').content = {}; }, 'invalid_history_item'],
  ...[null, 19, false, {}, [], [{ type: 'input_text', text: 19 }], [{ type: 'input_file', file_id: 'fixture-file-reference' }],
    [{ type: 'input_image', image_url: 'https://fixture.invalid/image.png', file_id: 'fixture-file-reference' }],
    [{ type: 'input_image', image_url: 'relative-fixture-image.png' }]].map(output => [
    `non-inline id-bearing output ${JSON.stringify(output)}`,
    body => { body.input.find(item => item.type === 'function_call_output').output = output; }, 'invalid_history_item',
  ]),
];
for (const [label, mutate, code] of invalidHistories) test(`recognized Azure ${label} does not retry or alter input`, async () => {
  const body = history(); mutate(body); const original = structuredClone(body), raw = JSON.stringify(wrappedError());
  assert.deepEqual(projectResponsesHistory(body), { ok: false, code });
  reply = (_req, res) => answer(res, raw, 400, 'text/event-stream', { 'x-request-id': 'fixture-rejected' });
  const result = await ask(body); assert.equal(result.status, 400); assert.equal(result.text, raw);
  assert.equal(result.headers['x-request-id'], 'fixture-rejected'); assert.equal(seen.length, 1); assert.equal(lastLog().attempts, 1);
  assert.deepEqual(body, original); assert.deepEqual(JSON.parse(seen[0].bytes), original); assert.equal(generationCount, 0);
  if (code === 'invalid_tool_pair') assert.equal(lastLog().resource_recovery_skipped, 'invalid_tool_pair');
});

for (const message of ['Invalid input: function_call_output id has an invalid format', 'Invalid schema for function fixture_tools.summarize']) {
  test(`ordinary HTTP400 ${message} is returned exactly without resource projection`, async () => {
    const body = history(), original = structuredClone(body), raw = JSON.stringify({ error: { type: 'invalid_request_error', code: null, param: '', message } });
    reply = (_req, res) => answer(res, raw, 400, 'text/event-stream');
    const result = await ask(body); assert.equal(result.status, 400); assert.equal(result.text, raw); assert.equal(seen.length, 1);
    assert.equal(lastLog().attempts, 1); assert.equal(lastLog().resource_recovery_skipped, undefined);
    assert.deepEqual(body, original); assert.deepEqual(JSON.parse(seen[0].bytes), original); assert.equal(generationCount, 0);
  });
}
