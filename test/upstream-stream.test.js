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
  // 每条渠道登记自己的模型名。通用 match 规则与 upstream_stream 覆盖都已删除:
  // 请求模型精确命中唯一登记的渠道,上游流式开关只由协议默认值决定。
  const provider = (id, wire_api) => ({ id, name: id, wire_api, base_url: `http://127.0.0.1:${upstream.address().port}`,
    api_key: 'sk-fixture', enabled: true, models: [id], model: id });
  fs.writeFileSync(path.join(root, 'providers.json'), JSON.stringify({
    claude: [provider('cc-chat', 'chat'), provider('cc-resp', 'responses'), provider('cc-native', 'anthropic')],
    codex: [provider('cx-chat', 'chat'), provider('cx-resp', 'responses'), provider('cx-archive', 'responses')],
  }));
  fs.writeFileSync(path.join(root, 'routes.json'), JSON.stringify({ rules: [] }));
  mod = require('../mixrouter');
  mod._state.routes = { rules: [] };
  mod._state.slotMap = { claude: {}, codex: {} };
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
  for (const stream of [true, false]) test(`${id}: Anthropic 线恒按流式上行,客户端仍得 ${stream ? 'SSE' : 'JSON'} 且工具/思考/usage 齐全`, async () => {
    reply = jsonReply;
    const body = { model: id, stream, max_tokens: 32, tools, messages: [{ role: 'user', content: 'fixture' }] };
    const response = await request(proxy, '/v1/messages', body);
    assert.equal(response.status, 200, response.text);
    const sent = seen.at(-1);
    // 协议默认:kind=messages 的上游请求永远流式,与客户端 body.stream 无关
    assert.equal(sent.body.stream, true);
    assert.equal(sent.headers.accept, 'text/event-stream');
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
  for (const stream of [true, false]) test(`${id} ${endpoint}: 上游流式跟随 body.stream,客户端 ${stream ? 'SSE' : 'JSON'} 与 usage 不变`, async () => {
    reply = jsonReply;
    const response = await request(proxy, endpoint, { model: id, stream,
      input: 'fixture', messages: [{ role: 'user', content: 'fixture' }] });
    assert.equal(response.status, 200, response.text);
    assert.equal(seen.at(-1).body.stream, stream);
    assert.equal(seen.at(-1).headers.accept, stream ? 'text/event-stream' : 'application/json');
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
  const response = await request(proxy, '/v1/responses', { model: 'cx-resp', stream: true, input: 'fixture' });
  assert.equal(response.status, 200, response.text);
  const events = wireResponses.parseSseEvents(response.text).events;
  assert.deepEqual(events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta), ['答案', '第二段']);
  assert.equal(events.find(event => event.type === 'response.refusal.delta').delta, '真实拒绝');
  assert.equal(events.find(event => event.type === 'response.custom_tool_call_input.delta').delta, 'real patch');
  assert.equal(events.at(-1).type, 'response.incomplete');
  assert.deepEqual(events.at(-1).response, payload);
});

test('非流式 responses 上行按非流式首字节预算等上游,不用短流式预算', async () => {
  reply = (req, res) => setTimeout(() => jsonReply(req, res), 250);
  const response = await request(proxy, '/v1/responses', { model: 'cx-resp', stream: false, input: 'delay' });
  // 首字节预算由**上游是否流式**决定:body.stream=false 时走 nonstream 预算(1500ms),
  // 250ms 的延迟仍然成功;若错用了 100ms 流式预算,这里会 502 超时。
  assert.equal(response.status, 200, response.text);
  assert.equal(seen.at(-1).body.stream, false);
  assert.equal(response.headers['x-mixrouter-upstream-stream'], 'false');
});

test('default requests keep converter defaults and native omitted stream shape', async () => {
  reply = streamReply;
  for (const id of ['cc-chat', 'cc-resp', 'cc-native']) {
    const response = await request(proxy, '/v1/messages', { model: id, stream: false, messages: [{ role: 'user', content: 'fixture' }] });
    assert.equal(response.status, 200, response.text);
    assert.equal(seen.at(-1).body.stream, true);
  }
  reply = jsonReply;
  for (const [id, endpoint] of [['cx-resp', '/v1/responses'], ['cx-chat', '/v1/chat/completions']]) {
    const response = await request(proxy, endpoint, { model: id, input: 'fixture', messages: [{ role: 'user', content: 'fixture' }] });
    assert.equal(response.status, 200);
    assert.ok(!Object.hasOwn(seen.at(-1).body, 'stream'));
    assert.equal(seen.at(-1).headers.accept, 'application/json');
  }
  const response = await request(proxy, '/v1/responses', { model: 'cx-chat', stream: false, input: 'fixture' });
  assert.equal(response.status, 200); assert.equal(seen.at(-1).body.stream, false);
  assert.equal(seen.at(-1).headers.accept, 'application/json');
});

test('Anthropic 恒流式、compact 不改写正文', async () => {
  reply = streamReply;
  assert.equal((await request(proxy, '/v1/messages', { model: 'cc-native', stream: false, messages: [{ role: 'user', content: 'fixture' }] })).status, 200);
  assert.equal(seen.at(-1).body.stream, true);
  reply = jsonReply;
  const body = { model: 'cx-resp', input: [], stream: true, stream_options: { include_usage: true } };
  const response = await request(proxy, '/v1/responses/compact', body);
  assert.equal(response.status, 200);
  assert.equal(seen.at(-1).path, '/v1/responses/compact');
  assert.deepEqual(seen.at(-1).body, body);
  assert.match(response.headers['content-type'], /application\/json/);
});

test('客户端要 JSON、上游却回 SSE:原生线原样中继,不伪造整包成功', async () => {
  reply = streamReply;
  for (const [id, endpoint] of [['cx-resp', '/v1/responses'], ['cx-chat', '/v1/chat/completions']]) {
    const response = await request(proxy, endpoint, { model: id, stream: false, input: 'fixture', messages: [{ role: 'user', content: 'fixture' }] });
    assert.equal(response.status, 200, response.text);
    // 上行跟随 body.stream=false,得到的是协议默认的非流式请求
    assert.equal(seen.at(-1).body.stream, false);
    // 上游违约发流:转出去的仍是上游原字节,不能被伪造成一个 response.completed 的整包 JSON
    assert.match(response.headers['content-type'], /text\/event-stream/);
    assert.ok(!response.text.startsWith('{"'), '不能把流伪装成整包 JSON');
    assert.ok(response.text.includes(endpoint.endsWith('responses') ? 'response.completed' : '[DONE]'));
  }
});

test('native JSON-to-SSE rejects malformed results instead of inventing success', async () => {
  for (const [id, endpoint, payload] of [['cx-resp', '/v1/responses', { id: 'bad', status: 'in_progress', output: [] }],
    ['cx-chat', '/v1/chat/completions', { choices: [] }]]) {
    reply = (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    const response = await request(proxy, endpoint, { model: id, stream: true, input: 'fixture' });
    assert.equal(response.status, 502, response.text);
    assert.ok(!response.text.includes('response.completed'));
  }
});

test('上游流残缺时原样中继已发出的字节,不补造终态', async () => {
  for (const id of ['cx-chat', 'cx-resp']) {
    reply = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (id === 'cx-chat') res.end(sse({ id: 'broken', choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: 'call-1', function: { name: 'Lookup', arguments: '{"q":' } },
      ] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
      else res.end(sse({ type: 'response.output_text.delta', output_index: 0, delta: 'unfinished' }));
    };
    // 客户端要 JSON,上游违约发流且流本身残缺:转出去的必须是上游原字节,
    // 不能被补成 response.completed / 完整 chat 结果的"成功"包。
    const response = await request(proxy, id === 'cx-chat' ? '/v1/chat/completions' : '/v1/responses',
      { model: id, stream: false, input: 'fixture' });
    assert.equal(response.status, 200, response.text);
    assert.match(response.headers['content-type'], /text\/event-stream/);
    assert.ok(!response.text.includes('"status":"completed"'), `不能伪造成功终态:${response.text}`);
    assert.ok(!response.text.startsWith('{"'), '不能把流伪装成整包 JSON');
  }
});

test('native Chat JSON→SSE keeps interleaved choices and tool arguments separate', async () => {
  const payload = { id: 'multi', object: 'chat.completion', model: 'upstream-model', choices: [
    { index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'a', type: 'function', function: { name: 'A', arguments: '{"x":1}' } }] } },
    { index: 1, finish_reason: 'stop', message: { role: 'assistant', content: 'second choice', reasoning_content: 'real' } },
  ], usage: chatJson().usage };
  reply = (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
  const response = await request(proxy, '/v1/chat/completions', { model: 'cx-chat', stream: true, messages: [] });
  assert.equal(response.status, 200, response.text);
  const frames = wireResponses.parseSseEvents(response.text).events;
  const byIndex = index => frames.flatMap(frame => frame.choices || []).filter(choice => choice.index === index);
  const call = byIndex(0).find(choice => choice.delta?.tool_calls)?.delta.tool_calls[0];
  assert.equal(call.index, 0);
  assert.equal(call.function.arguments, '{"x":1}');
  const second = byIndex(1);
  assert.equal(second.find(choice => choice.delta?.content === 'second choice').delta.content, 'second choice');
  assert.equal(second[0].delta.reasoning_content, 'real');
  assert.deepEqual(frames.find(frame => frame.usage).usage, chatJson().usage);
  assert.ok(response.text.endsWith('data: [DONE]\n\n'));
});

test('archive records upstream JSON bytes, not the client rendering; logs retain usage', async () => {
  reply = jsonReply;
  const response = await request(proxy, '/v1/responses', { model: 'cx-archive', stream: false, input: 'archive-fixture' });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), responsesJson(), '客户端拿到的就是上游 JSON');
  const logResponse = await request(ui, '/api/logs?model=cx-archive', undefined, 'GET');
  const log = JSON.parse(logResponse.text).logs[0];
  assert.deepEqual({ in: log.in, out: log.out, cache_read: log.cache_read }, { in: 50, out: 12, cache_read: 8 });
  let archive;
  await waitFor(() => {
    for (const dir of fs.readdirSync(path.join(root, 'archive'))) {
      const meta = path.join(root, 'archive', dir, 'metadata.json');
      if (!fs.existsSync(meta)) continue;
      const metadata = JSON.parse(fs.readFileSync(meta, 'utf8'));
      if (metadata.model === 'cx-archive' && metadata.finished_at && metadata.state === 'complete') {
        archive = { dir: path.dirname(meta), metadata }; return true;
      }
    }
    return false;
  }, { timeoutMs: 3000, label: '上游 JSON 归档完成' });
  assert.equal(archive.metadata.stream, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(archive.dir, 'raw-response.bin'), 'utf8')), responsesJson());
});
