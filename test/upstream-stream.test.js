'use strict';
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { upstreamStreamFor, applyUpstreamStream } = require('../lib/upstream-stream');
const wireResponses = require('../lib/wire-responses');
const wireChat = require('../lib/wire-chat');
const wireOpenai = require('../lib/wire-openai-bridge');
const { waitFor } = require('./wait-for');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-stream-'));
Object.assign(process.env, {
  MIXR_DATA_DIR: root,
  MIXR_CLAUDE_SETTINGS: path.join(root, 'settings.json'),
  MIXR_CODEX_CONFIG: path.join(root, 'config.toml'),
  MIXR_RESPONSE_ARCHIVE: 'on', MIXR_RESPONSE_ARCHIVE_DIR: path.join(root, 'archive'),
  MIXR_MAX_ATTEMPTS: '1', MIXR_CONV_RETRIES: '0', MIXR_RETRY_DELAY_MS: '0',
  MIXR_COOLDOWN_SEC: '0', MIXR_SSE_KEEPALIVE_MS: '0',
  MIXR_FIRST_HEADER_TIMEOUT_MS: '1500', MIXR_STREAM_FIRST_HEADER_TIMEOUT_MS: '100',
  MIXR_TOTAL_DEADLINE_MS: '5000',
});
let upstream, proxy, ui, reply, mod;
const seen = [], sockets = new Set();
const sse = value => `data: ${JSON.stringify(value)}\n\n`;
const chatJson = () => ({ id: 'chat-1', object: 'chat.completion', model: 'upstream-model', created: 123,
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '答案', reasoning_content: '真实思考',
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'Lookup', arguments: '{"q":"value","optional":""}' } }] } }],
  usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62, prompt_tokens_details: { cached_tokens: 8 },
    completion_tokens_details: { reasoning_tokens: 4 } } });
const responsesJson = () => ({ id: 'resp-1', object: 'response', status: 'completed', model: 'upstream-model',
  output: [
    { id: 'rs-1', type: 'reasoning', content: [{ type: 'reasoning_text', text: '真实思考' }], summary: [], encrypted_content: 'opaque' },
    { id: 'msg-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '答案', annotations: [] }] },
    { id: 'fc-1', type: 'function_call', status: 'completed', call_id: 'call-1', name: 'Lookup', arguments: '{"q":"value","optional":""}' },
  ], usage: { input_tokens: 50, output_tokens: 12, total_tokens: 62, input_tokens_details: { cached_tokens: 8 }, output_tokens_details: { reasoning_tokens: 4 } } });
const tools = [{ name: 'Lookup', input_schema: { type: 'object', properties: { q: { type: 'string' }, optional: { type: 'string' } }, required: ['q'] } }];
function request(server, endpoint, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: endpoint, method, agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Connection: 'close' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timeout')));
    req.on('error', reject); req.end(data);
  });
}
function archiveRows() {
  const directory = path.join(root, 'archive');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => !name.startsWith('.')).map(name => {
    const file = path.join(directory, name, 'metadata.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  });
}
async function drainArchives() {
  await waitFor(() => {
    const rows = archiveRows();
    return rows.length === seen.length && rows.every(row => row?.finished_at);
  }, { label: '本次所有上游归档已收尾' });
}
function jsonReply(_req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(_req.url.includes('chat/completions') ? chatJson() : responsesJson()));
}
function streamReply(req, res) {
  if (req.url.includes('chat/completions')) {
    const json = chatJson();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sse({ ...json, object: 'chat.completion.chunk', choices: json.choices.map(({ message, ...rest }) => ({ ...rest, delta: {
      ...message, tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })),
    } })) }) + 'data: [DONE]\n\n');
  } else if (req.url.includes('responses')) {
    wireOpenai.emitResponsesSse(res, responsesJson());
  } else {
    wireResponses.emitAnthropicSse(res, { id: 'msg-native', type: 'message', role: 'assistant', model: 'native',
      content: [{ type: 'text', text: 'native' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } });
  }
}

before(async () => {
  fs.mkdirSync(path.join(root, 'logs'));
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      reply(req, res);
    });
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const provider = (id, wire_api) => ({ id, name: id, wire_api, base_url: `http://127.0.0.1:${upstream.address().port}`,
    api_key: 'sk-fixture', enabled: true, models: ['model'], model: 'model' });
  fs.writeFileSync(path.join(root, 'providers.json'), JSON.stringify({
    claude: [provider('cc-chat', 'chat'), provider('cc-resp', 'responses'), provider('cc-native', 'anthropic')],
    codex: [provider('cx-chat', 'chat'), provider('cx-resp', 'responses')],
  }));
  const rules = [];
  for (const [app, id] of [['claude', 'cc-chat'], ['claude', 'cc-resp'], ['claude', 'cc-native'], ['codex', 'cx-chat'], ['codex', 'cx-resp']]) {
    for (const [mode, value] of [['false', false], ['true', true], ['default', undefined], ['invalid', 'false']]) {
      const name = `${id}-${mode}`;
      rules.push({ id: name, app, match: name, provider: id, model: name, enabled: true,
        ...(value === undefined ? {} : { upstream_stream: value }) });
    }
  }
  fs.writeFileSync(path.join(root, 'routes.json'), JSON.stringify({ rules, default: {} }));
  mod = require('../mixrouter');
  // This module's contract starts at resolved.rule; routing field persistence is
  // tested independently. Inject fixture rules without depending on normalization.
  mod._state.routes = { rules, default: {} };
  proxy = await mod.listen(0, mod.proxyHandler);
  ui = await mod.listen(0, mod.apiHandler);
  reply = jsonReply;
});
afterEach(drainArchives);
after(async () => {
  await drainArchives();
  for (const socket of sockets) socket.destroy();
  await Promise.all([upstream, proxy, ui].filter(Boolean).map(server => new Promise(resolve => {
    server.closeAllConnections(); server.close(resolve);
  })));
  fs.rmSync(root, { recursive: true, force: true });
});

test('pure stream policy accepts only booleans and preserves protocol defaults', () => {
  for (const wire of ['chat', 'responses']) {
    assert.equal(upstreamStreamFor({ wire, kind: 'messages', body: { stream: false } }), true);
    assert.equal(upstreamStreamFor({ wire, kind: 'messages', rule: { upstream_stream: false } }), false);
    for (const value of ['false', null, 0, {}]) assert.equal(upstreamStreamFor({ wire, kind: 'messages', rule: { upstream_stream: value } }), true);
    assert.equal(upstreamStreamFor({ wire, kind: 'responses', body: { stream: false }, rule: { upstream_stream: true } }), true);
  }
  assert.equal(upstreamStreamFor({ wire: 'anthropic', kind: 'messages', body: { stream: false }, rule: { upstream_stream: false } }), true);
  assert.equal(upstreamStreamFor({ wire: 'anthropic', kind: 'count_tokens', body: {}, rule: { upstream_stream: true } }), false);
  assert.equal(upstreamStreamFor({ wire: 'responses', kind: 'responses/compact', body: { stream: true }, rule: { upstream_stream: false } }), true);
  assert.equal(upstreamStreamFor({ wire: 'responses', kind: 'responses/compact', body: {}, rule: { upstream_stream: true } }), false);
  assert.equal(upstreamStreamFor({ wire: 'chat', kind: 'responses', body: { stream: false } }), false);
  assert.equal(upstreamStreamFor({ wire: 'chat', kind: 'responses', body: {} }), true);
  assert.equal(upstreamStreamFor({ wire: 'responses', kind: 'responses', body: {} }), false);
});
test('applying stream copies the converted object and removes streaming-only options', () => {
  const source = Object.freeze({ stream: true, stream_options: { include_usage: true }, tools: ['tool'] });
  assert.deepEqual(applyUpstreamStream(source, false), { stream: false, tools: ['tool'] });
  assert.equal(source.stream, true);
  assert.deepEqual(applyUpstreamStream(source, true), source);
  assert.deepEqual(applyUpstreamStream({ model: 'm' }), { model: 'm' });
});

for (const id of ['cc-chat', 'cc-resp']) {
  for (const stream of [true, false]) test(`${id}: upstream false still returns client ${stream ? 'SSE' : 'JSON'} with tools/reasoning/usage`, async () => {
    reply = jsonReply;
    const body = { model: `${id}-false`, stream, max_tokens: 32, tools, messages: [{ role: 'user', content: 'fixture' }] };
    const response = await request(proxy, '/v1/messages', body);
    assert.equal(response.status, 200, response.text);
    const sent = seen.at(-1);
    assert.equal(sent.body.stream, false);
    assert.equal(sent.body.stream_options, undefined);
    assert.equal(sent.headers.accept, 'application/json');
    assert.equal(body.stream, stream);
    const message = stream ? wireResponses.collectAnthropicMessage(response.text) : JSON.parse(response.text);
    assert.match(response.headers['content-type'], stream ? /text\/event-stream/ : /application\/json/);
    assert.deepEqual(message.content.map(block => block.type), ['thinking', 'text', 'tool_use']);
    assert.equal(message.content[0].thinking, '真实思考');
    assert.equal(message.content[1].text, '答案');
    assert.deepEqual(message.content[2].input, { q: 'value' });
    assert.equal(message.content[2].id, 'call-1');
    assert.equal(message.stop_reason, 'tool_use');
    assert.deepEqual(message.usage, { input_tokens: 42, output_tokens: 12, cache_read_input_tokens: 8 });
  });
}
for (const [id, endpoint] of [['cx-chat', '/v1/responses'], ['cx-resp', '/v1/responses'], ['cx-chat', '/v1/chat/completions']]) {
  for (const stream of [true, false]) test(`${id} ${endpoint}: false override preserves client ${stream ? 'SSE' : 'JSON'} and usage`, async () => {
    reply = jsonReply;
    const response = await request(proxy, endpoint, { model: `${id}-false`, stream,
      input: 'fixture', messages: [{ role: 'user', content: 'fixture' }], stream_options: { include_usage: true } });
    assert.equal(response.status, 200, response.text);
    assert.equal(seen.at(-1).body.stream, false);
    assert.equal(seen.at(-1).body.stream_options, undefined);
    assert.equal(seen.at(-1).headers.accept, 'application/json');
    assert.match(response.headers['content-type'], stream ? /text\/event-stream/ : /application\/json/);
    if (endpoint.endsWith('chat/completions')) {
      if (stream) {
        const frames = wireResponses.parseSseEvents(response.text).events;
        const call = frames.find(frame => frame.choices?.[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0];
        assert.equal(call.id, 'call-1'); assert.equal(call.index, 0);
        assert.equal(call.function.arguments, chatJson().choices[0].message.tool_calls[0].function.arguments);
        assert.deepEqual(frames.at(-1).usage, chatJson().usage);
        assert.ok(response.text.endsWith('data: [DONE]\n\n'));
      } else assert.deepEqual(JSON.parse(response.text), chatJson());
    } else {
      const result = stream ? wireResponses.parseSseEvents(response.text).events.at(-1).response : JSON.parse(response.text);
      assert.equal(result.status, 'completed');
      const call = result.output.find(item => item.type === 'function_call');
      assert.equal(call.call_id, 'call-1'); assert.equal(call.name, 'Lookup');
      assert.deepEqual(JSON.parse(call.arguments), { q: 'value', optional: '' });
      assert.equal(result.usage.input_tokens, 50); assert.equal(result.usage.output_tokens, 12);
      assert.equal(result.usage.input_tokens_details.cached_tokens, 8);
      if (id === 'cx-resp') {
        assert.deepEqual(result, responsesJson(), 'native response fields remain unchanged');
        if (stream) {
          const events = wireResponses.parseSseEvents(response.text).events;
          assert.equal(events.find(event => event.type === 'response.reasoning_text.delta').delta, '真实思考');
          assert.equal(events.find(event => event.type === 'response.function_call_arguments.delta').delta, call.arguments);
          assert.deepEqual(events.map(event => event.sequence_number), events.map((_, index) => index));
        }
      }
    }
  });
}

test('native Responses JSON→SSE retains multiple content parts, refusal, custom tools and incomplete usage', async () => {
  const payload = responsesJson();
  payload.status = 'incomplete'; payload.incomplete_details = { reason: 'max_output_tokens' };
  payload.output[1].content.push({ type: 'output_text', text: '第二段', annotations: [{ type: 'fixture' }] }, { type: 'refusal', refusal: '真实拒绝' });
  payload.output.push({ id: 'custom-1', type: 'custom_tool_call', call_id: 'custom-call-1', name: 'Patch', input: 'real patch' });
  reply = (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
  const response = await request(proxy, '/v1/responses', { model: 'cx-resp-false', stream: true, input: 'fixture' });
  assert.equal(response.status, 200, response.text);
  const events = wireResponses.parseSseEvents(response.text).events;
  assert.deepEqual(events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta), ['答案', '第二段']);
  assert.equal(events.find(event => event.type === 'response.refusal.delta').delta, '真实拒绝');
  assert.equal(events.find(event => event.type === 'response.custom_tool_call_input.delta').delta, 'real patch');
  assert.equal(events.at(-1).type, 'response.incomplete');
  assert.deepEqual(events.at(-1).response, payload);
});

test('explicit false uses nonstream first-header budget rather than short stream budget', async () => {
  reply = (req, res) => setTimeout(() => jsonReply(req, res), 250);
  const response = await request(proxy, '/v1/messages', { model: 'cc-chat-false', stream: true, messages: [{ role: 'user', content: 'delay' }] });
  assert.equal(response.status, 200, response.text);
  assert.equal(seen.at(-1).body.stream, false);
});

test('default requests keep converter defaults and native omitted stream shape', async () => {
  reply = streamReply;
  for (const id of ['cc-chat', 'cc-resp', 'cc-native']) {
    const response = await request(proxy, '/v1/messages', { model: `${id}-default`, stream: false, messages: [{ role: 'user', content: 'fixture' }] });
    assert.equal(response.status, 200, response.text);
    assert.equal(seen.at(-1).body.stream, true);
  }
  reply = jsonReply;
  for (const [id, endpoint] of [['cx-resp', '/v1/responses'], ['cx-chat', '/v1/chat/completions']]) {
    const response = await request(proxy, endpoint, { model: `${id}-default`, input: 'fixture', messages: [{ role: 'user', content: 'fixture' }] });
    assert.equal(response.status, 200);
    assert.ok(!Object.hasOwn(seen.at(-1).body, 'stream'));
    assert.equal(seen.at(-1).headers.accept, 'application/json');
  }
  const response = await request(proxy, '/v1/responses', { model: 'cx-chat-default', stream: false, input: 'fixture' });
  assert.equal(response.status, 200); assert.equal(seen.at(-1).body.stream, false);
  assert.equal(seen.at(-1).headers.accept, 'application/json');
});

test('Anthropic and compact ignore false override; compact body is untouched', async () => {
  reply = streamReply;
  assert.equal((await request(proxy, '/v1/messages', { model: 'cc-native-false', stream: false, messages: [{ role: 'user', content: 'fixture' }] })).status, 200);
  assert.equal(seen.at(-1).body.stream, true);
  reply = jsonReply;
  const body = { model: 'cx-resp-false', input: [], stream: true, stream_options: { include_usage: true } };
  const response = await request(proxy, '/v1/responses/compact', body);
  assert.equal(response.status, 200);
  assert.equal(seen.at(-1).path, '/v1/responses/compact');
  assert.deepEqual(seen.at(-1).body, body);
  assert.match(response.headers['content-type'], /application\/json/);
});

for (const [id, endpoint] of [['cx-resp', '/v1/responses'], ['cx-chat', '/v1/chat/completions']]) {
  test(`${id}: true override buffers upstream SSE into native nonstream JSON`, async () => {
    reply = streamReply;
    const response = await request(proxy, endpoint, { model: `${id}-true`, stream: false, input: 'fixture', messages: [{ role: 'user', content: 'fixture' }] });
    assert.equal(response.status, 200, response.text);
    assert.equal(seen.at(-1).body.stream, true);
    assert.equal(seen.at(-1).headers.accept, 'text/event-stream');
    assert.match(response.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(response.text), endpoint.endsWith('responses') ? responsesJson() : chatJson());
  });
}

test('native JSON-to-SSE rejects malformed results instead of inventing success', async () => {
  for (const [id, endpoint, payload] of [['cx-resp', '/v1/responses', { id: 'bad', status: 'in_progress', output: [] }],
    ['cx-chat', '/v1/chat/completions', { choices: [] }]]) {
    reply = (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    const response = await request(proxy, endpoint, { model: `${id}-false`, stream: true, input: 'fixture' });
    assert.equal(response.status, 502, response.text);
    assert.ok(!response.text.includes('response.completed'));
  }
});

test('explicit native streaming override rejects truncated tools and missing terminal SSE', async () => {
  for (const id of ['cx-chat', 'cx-resp']) {
    reply = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (id === 'cx-chat') res.end(sse({ id: 'broken', choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: 'call-1', function: { name: 'Lookup', arguments: '{"q":' } },
      ] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
      else res.end(sse({ type: 'response.output_text.delta', output_index: 0, delta: 'unfinished' }));
    };
    const response = await request(proxy, id === 'cx-chat' ? '/v1/chat/completions' : '/v1/responses',
      { model: `${id}-true`, stream: false, input: 'fixture' });
    assert.equal(response.status, 502, response.text);
    assert.match(response.headers['content-type'], /application\/json/);
  }
});

test('native Chat streaming override keeps interleaved choices and tool arguments separate', async () => {
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sse({ id: 'multi', choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'A', arguments: '{"x":' } }] } },
      { index: 1, delta: { content: 'second', reasoning_content: 'real' } },
    ] }) + sse({ choices: [
      { index: 1, delta: { content: ' choice' }, finish_reason: 'stop' },
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' },
    ], usage: chatJson().usage }) + 'data: [DONE]\n\n');
  };
  const response = await request(proxy, '/v1/chat/completions', { model: 'cx-chat-true', stream: false, messages: [] });
  assert.equal(response.status, 200, response.text);
  const json = JSON.parse(response.text);
  assert.equal(json.choices[0].message.tool_calls[0].function.arguments, '{"x":1}');
  assert.equal(json.choices[1].message.content, 'second choice');
  assert.equal(json.choices[1].message.reasoning_content, 'real');
  assert.deepEqual(json.usage, chatJson().usage);
});

test('archive records upstream JSON, not synthesized SSE; logs retain usage', async () => {
  reply = jsonReply;
  const response = await request(proxy, '/v1/responses', { model: 'cx-resp-false', stream: true, input: 'archive-fixture' });
  assert.equal(response.status, 200);
  const logResponse = await request(ui, '/api/logs?model=cx-resp-false', undefined, 'GET');
  const log = JSON.parse(logResponse.text).logs[0];
  assert.deepEqual({ in: log.in, out: log.out, cache_read: log.cache_read }, { in: 50, out: 12, cache_read: 8 });
  let archive;
  await waitFor(() => {
    for (const dir of fs.readdirSync(path.join(root, 'archive'))) {
      const meta = path.join(root, 'archive', dir, 'metadata.json');
      if (!fs.existsSync(meta)) continue;
      const metadata = JSON.parse(fs.readFileSync(meta, 'utf8'));
      if (metadata.model === 'cx-resp-false' && metadata.finished_at && metadata.state === 'complete') {
        archive = { dir: path.dirname(meta), metadata }; return true;
      }
    }
    return false;
  }, { timeoutMs: 3000, label: '上游 JSON 归档完成' });
  assert.equal(archive.metadata.stream, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(archive.dir, 'raw-response.bin'), 'utf8')), responsesJson());
});
