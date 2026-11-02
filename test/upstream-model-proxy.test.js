'use strict';
// 上游模型证据(entry.upstream_model)的代理回归:真实 HTTP 入口 + 本机桩上游。
//
// 覆盖五条响应线(原生 Anthropic / 原生 Responses / 原生 Chat / 两条翻译线 /
// Codex 的 Responses→Chat 桥),每条都让桩上游自报一个**与请求模型不同**的名字:
// 断言日志里的 upstream_model 是那个自报值,而 model_in/model_out 仍是请求/落点模型。
// 这条用例组真正防的是"回落":请求名、槽位名或转换器的合成名被写进证据字段,日志
// 看起来完全正常,却把上游信息换成了我们自己的假设。
//
// 另外两条钉住生命周期:
//   · 失败尝试自报过模型、下一次成功也自报 → 只记成功那一发的模型;
//   · 失败尝试自报过、下一次成功**没自报** → 空(不是把上一发的值留下来当成功证据)。
//
// 全部走临时 HOME/数据目录与 listen(0),不碰真实配置、真实上游或线上服务。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-upstream-model-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
// 重试是这些用例的主角:给转换线 1 次同渠道重试,两次候选填满(同渠道),
// 并把等待关掉。
process.env.MIXR_MAX_ATTEMPTS = '2';
process.env.MIXR_CONV_RETRIES = '1';
process.env.MIXR_RETRY_DELAY_MS = '0';
process.env.MIXR_SSE_KEEPALIVE_MS = '0';
process.env.MIXR_RESPONSE_ARCHIVE = 'off';

let mod, proxy, upstream;
const retryCalls = { rt: 0, rs: 0 };
const sockets = new Set();

// ---------------------------------------------------------------- 桩上游
const sseFrame = (value, event) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`;

function anthropicSse(res, model) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const message = { id: 'msg_stub', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: 0 } };
  if (model) message.model = model;
  res.write(sseFrame({ type: 'message_start', message }, 'message_start'));
  res.write(sseFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start'));
  res.write(sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, 'content_block_delta'));
  res.write(sseFrame({ type: 'content_block_stop', index: 0 }, 'content_block_stop'));
  res.write(sseFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 3, output_tokens: 2 } }, 'message_delta'));
  res.write(sseFrame({ type: 'message_stop' }, 'message_stop'));
  res.end();
}

function anthropicJson(res, model) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: 'msg_stub', type: 'message', role: 'assistant',
    ...(model ? { model } : {}), content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 },
  }));
}

function responsesSse(res, model) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(sseFrame({ type: 'response.created', response: { id: 'resp_stub', object: 'response', status: 'in_progress', ...(model ? { model } : {}), output: [] } }));
  res.write(sseFrame({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_stub', role: 'assistant', status: 'in_progress', content: [] } }));
  res.write(sseFrame({ type: 'response.output_text.delta', item_id: 'msg_stub', output_index: 0, content_index: 0, delta: 'ok' }));
  res.write(sseFrame({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_stub', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] } }));
  res.write(sseFrame({ type: 'response.completed', response: { id: 'resp_stub', object: 'response', status: 'completed', ...(model ? { model } : {}), output: [], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }));
  res.end();
}

function responsesJson(res, model) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: 'resp_stub', object: 'response', status: 'completed',
    ...(model ? { model } : {}), output: [{ type: 'message', id: 'msg_stub', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  }));
}

function chatSse(res, model) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (choices) => ({ id: 'chat_stub', object: 'chat.completion.chunk', ...(model ? { model } : {}), choices });
  res.write(sseFrame(chunk([{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }])));
  res.write(sseFrame(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])));
  res.write(sseFrame({ id: 'chat_stub', object: 'chat.completion.chunk', ...(model ? { model } : {}), choices: [],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  res.write('data: [DONE]\n\n');
  res.end();
}

function chatJson(res, model) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: 'chat_stub', object: 'chat.completion', ...(model ? { model } : {}),
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }));
}

// 只在一个 chunk 里自报模型,然后**不给终态**直接结束:转换线会整条重试(还没提交),
// 于是第一发的观测值必须被下一次尝试的清零覆盖掉。
function taintedBrokenStream(res, model) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(sseFrame({ id: 'chat_stub', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: null }] }));
  res.end();
}

function replyFor(prefix, res) {
  switch (prefix) {
    case 'na': return anthropicSse(res, 'served-native-anthropic');
    case 'naj': return anthropicJson(res, 'served-native-anthropic-json');
    case 'nm': return anthropicSse(res, '');
    case 'nr': return responsesSse(res, 'served-native-responses');
    case 'nrj': return responsesJson(res, 'served-native-responses-json');
    case 'nc': return chatSse(res, 'served-native-chat');
    case 'ncj': return chatJson(res, 'served-native-chat-json');
    case 'cc': return chatSse(res, 'served-conv-chat');
    case 'ccj': return chatJson(res, 'served-conv-chat-json');
    case 'cr': return responsesSse(res, 'served-conv-responses');
    case 'crj': return responsesJson(res, 'served-conv-responses-json');
    case 'bc': return chatSse(res, 'served-bridge-chat');
    case 'bcj': return chatJson(res, 'served-bridge-chat-json');
    case 'bnm': return chatSse(res, '');
    case 'rt':
      retryCalls.rt++;
      return retryCalls.rt === 1
        ? taintedBrokenStream(res, 'tainted-retry-model')
        : chatSse(res, 'served-retry-clean');
    case 'rs':
      retryCalls.rs++;
      return retryCalls.rs === 1
        ? taintedBrokenStream(res, 'tainted-silent-model')
        : chatSse(res, '');
    default:
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `unknown prefix ${prefix}` } }));
  }
}

// ---------------------------------------------------------------- 测试环境
const provider = (id, wire_api, models, prefix, app = 'claude') => ({
  id, name: id, base_url: `http://127.0.0.1:${upstream.address().port}/${prefix}`,
  wire_api, api_key: 'sk-fixture', enabled: true,
  ...(app === 'codex' ? { model: models[0] } : {}), models,
});

before(async () => {
  fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const prefix = String(req.url || '').split('?')[0].split('/')[1] || '';
      replyFor(prefix, res);
    });
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

  const provs = {
    claude: [
      provider('na', 'anthropic', ['asked-native-anthropic'], 'na'),
      provider('naj', 'anthropic', ['asked-native-anthropic-json'], 'naj'),
      provider('nm', 'anthropic', ['asked-no-model'], 'nm'),
      provider('cc', 'chat', ['asked-conv-chat'], 'cc'),
      provider('ccj', 'chat', ['asked-conv-chat-json'], 'ccj'),
      provider('cr', 'responses', ['asked-conv-responses'], 'cr'),
      provider('crj', 'responses', ['asked-conv-responses-json'], 'crj'),
      provider('rt', 'chat', ['asked-retry-chat'], 'rt'),
      provider('rs', 'chat', ['asked-retry-silent'], 'rs'),
    ],
    codex: [
      provider('nr', 'responses', ['asked-native-responses'], 'nr', 'codex'),
      provider('nrj', 'responses', ['asked-native-responses-json'], 'nrj', 'codex'),
      provider('nc', 'chat', ['asked-native-chat'], 'nc', 'codex'),
      provider('ncj', 'chat', ['asked-native-chat-json'], 'ncj', 'codex'),
      provider('bc', 'chat', ['asked-bridge-chat'], 'bc', 'codex'),
      provider('bcj', 'chat', ['asked-bridge-chat-json'], 'bcj', 'codex'),
      provider('bnm', 'chat', ['asked-bridge-no-model'], 'bnm', 'codex'),
    ],
  };
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({ version: 2, current: { claude: null, codex: null }, ...provs }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({ rules: [] }));
  mod = require('../mixrouter');
  mod._state.store = provs;
  mod._state.routes = { rules: [] };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.sessions.clear();
  mod._state.resetPools();
  proxy = await mod.listen(0, mod.proxyHandler);
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  const servers = [upstream, proxy].filter(server => server && server.listening);
  await Promise.all(servers.map(server => new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(resolve);
  })));
  fs.rmSync(TMP, { recursive: true, force: true });
});

function request(method, urlPath, body, sessionId = '') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const creq = http.request({
      hostname: '127.0.0.1', port: proxy.address().port, method, path: urlPath,
      agent: false, // 每个请求独立连接:Connection: close + 全局 agent 复用会让上一个请求的 close 与新请求撞在同一 socket
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
        ...(sessionId ? { 'session-id': sessionId } : {}), Connection: 'close',
      },
    }, cres => {
      const chunks = [];
      cres.on('data', chunk => chunks.push(chunk));
      cres.on('end', () => resolve({ status: cres.statusCode, headers: cres.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    creq.setTimeout(8000, () => creq.destroy(new Error('test request timeout')));
    creq.on('error', reject);
    creq.end(data);
  });
}

const callMessages = (body, sessionId) => request('POST', '/v1/messages', {
  max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...body,
}, sessionId);
const callResponses = (body, sessionId) => request('POST', '/v1/responses', {
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], ...body,
}, sessionId);
const callChat = (body, sessionId) => request('POST', '/v1/chat/completions', {
  messages: [{ role: 'user', content: 'hi' }], ...body,
}, sessionId);

function logs() {
  const file = path.join(TMP, 'logs/requests.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function lastLog(modelIn) {
  return [...logs()].reverse().find(row => row.model_in === modelIn);
}

// ---------------------------------------------------------------- 原生直通
test('原生 Anthropic SSE:upstream_model 是上游自报值,不是请求名', async () => {
  const result = await callMessages({ model: 'asked-native-anthropic', stream: true }, 'sess-na');
  assert.equal(result.status, 200);
  const row = lastLog('asked-native-anthropic');
  assert.equal(row.status, 200);
  assert.equal(row.model_in, 'asked-native-anthropic');
  assert.equal(row.model_out, 'asked-native-anthropic');
  assert.equal(row.upstream_model, 'served-native-anthropic');
});

test('原生 Anthropic:客户端要非流、上游回 SSE,攒包后仍记上游自报值', async () => {
  const result = await callMessages({ model: 'asked-native-anthropic', stream: false }, 'sess-na-nonstream');
  assert.equal(result.status, 200);
  const row = lastLog('asked-native-anthropic');
  assert.equal(row.upstream_model, 'served-native-anthropic');
});

test('原生 Anthropic JSON:只认响应体里的 model', async () => {
  const result = await callMessages({ model: 'asked-native-anthropic-json', stream: false }, 'sess-naj');
  assert.equal(result.status, 200);
  const row = lastLog('asked-native-anthropic-json');
  assert.equal(row.model_out, 'asked-native-anthropic-json');
  assert.equal(row.upstream_model, 'served-native-anthropic-json');
});

test('原生 Anthropic 没报 model → 空,不回落请求名', async () => {
  const result = await callMessages({ model: 'asked-no-model', stream: true }, 'sess-nm');
  assert.equal(result.status, 200);
  const row = lastLog('asked-no-model');
  assert.equal(row.model_in, 'asked-no-model');
  assert.equal(row.upstream_model, '');
});

test('原生 Responses SSE/JSON:上游自报值分别落进同一字段', async () => {
  const streamed = await callResponses({ model: 'asked-native-responses', stream: true }, 'sess-nr');
  assert.equal(streamed.status, 200);
  let row = lastLog('asked-native-responses');
  assert.equal(row.upstream_model, 'served-native-responses');
  assert.equal(row.model_out, 'asked-native-responses');

  const whole = await callResponses({ model: 'asked-native-responses-json', stream: false }, 'sess-nrj');
  assert.equal(whole.status, 200);
  row = lastLog('asked-native-responses-json');
  assert.equal(row.upstream_model, 'served-native-responses-json');
});

test('原生 Chat SSE/JSON:chat chunk 与整包里的 model', async () => {
  const streamed = await callChat({ model: 'asked-native-chat', stream: true }, 'sess-nc');
  assert.equal(streamed.status, 200);
  let row = lastLog('asked-native-chat');
  assert.equal(row.upstream_model, 'served-native-chat');
  assert.equal(row.model_out, 'asked-native-chat');

  const whole = await callChat({ model: 'asked-native-chat-json', stream: false }, 'sess-ncj');
  assert.equal(whole.status, 200);
  row = lastLog('asked-native-chat-json');
  assert.equal(row.upstream_model, 'served-native-chat-json');
});

// ---------------------------------------------------------------- 翻译线
test('Claude→Chat 翻译:SSE 与整包 JSON 都只记上游 chunk/JSON 的 model', async () => {
  const streamed = await callMessages({ model: 'asked-conv-chat', stream: true }, 'sess-cc');
  assert.equal(streamed.status, 200);
  let row = lastLog('asked-conv-chat');
  assert.equal(row.wire, 'chat');
  assert.equal(row.model_out, 'asked-conv-chat');
  assert.equal(row.upstream_model, 'served-conv-chat');

  const buffered = await callMessages({ model: 'asked-conv-chat', stream: false }, 'sess-cc-nonstream');
  assert.equal(buffered.status, 200);
  row = lastLog('asked-conv-chat');
  assert.equal(row.upstream_model, 'served-conv-chat', '客户端非流走攒包路径,证据仍来自上游 chunk');

  const whole = await callMessages({ model: 'asked-conv-chat-json', stream: true }, 'sess-ccj');
  assert.equal(whole.status, 200);
  row = lastLog('asked-conv-chat-json');
  assert.equal(row.upstream_model, 'served-conv-chat-json', '上游忽略 stream:true 回了整包 JSON');
});

test('Claude→Responses 翻译:SSE 与整包 JSON 都只记上游自报值', async () => {
  const streamed = await callMessages({ model: 'asked-conv-responses', stream: true }, 'sess-cr');
  assert.equal(streamed.status, 200);
  let row = lastLog('asked-conv-responses');
  assert.equal(row.wire, 'responses');
  assert.equal(row.upstream_model, 'served-conv-responses');

  const buffered = await callMessages({ model: 'asked-conv-responses', stream: false }, 'sess-cr-nonstream');
  assert.equal(buffered.status, 200);
  row = lastLog('asked-conv-responses');
  assert.equal(row.upstream_model, 'served-conv-responses');

  const whole = await callMessages({ model: 'asked-conv-responses-json', stream: true }, 'sess-crj');
  assert.equal(whole.status, 200);
  row = lastLog('asked-conv-responses-json');
  assert.equal(row.upstream_model, 'served-conv-responses-json');
});

test('Codex Responses→Chat 桥:SSE 与整包 JSON 都只记上游自报值', async () => {
  const streamed = await callResponses({ model: 'asked-bridge-chat', stream: true }, 'sess-bc');
  assert.equal(streamed.status, 200);
  let row = lastLog('asked-bridge-chat');
  assert.equal(row.wire, 'chat');
  assert.equal(row.upstream_model, 'served-bridge-chat');

  const whole = await callResponses({ model: 'asked-bridge-chat-json', stream: false }, 'sess-bcj');
  assert.equal(whole.status, 200);
  row = lastLog('asked-bridge-chat-json');
  assert.equal(row.upstream_model, 'served-bridge-chat-json');

  const absent = await callResponses({ model: 'asked-bridge-no-model', stream: true }, 'sess-bnm');
  assert.equal(absent.status, 200);
  row = lastLog('asked-bridge-no-model');
  assert.equal(row.upstream_model, '', '桥接器用请求名合成 response.created 的 model,但那不是上游证据');
});

// ---------------------------------------------------------------- 跨尝试
test('失败尝试自报过模型:下一次成功覆盖它,只留成功那一发的证据', async () => {
  const result = await callMessages({ model: 'asked-retry-chat', stream: true }, 'sess-rt');
  assert.equal(result.status, 200);
  const row = lastLog('asked-retry-chat');
  assert.ok(row.attempts >= 2, `应发生同渠道重试(attempts=${row.attempts})`);
  assert.equal(row.upstream_model, 'served-retry-clean');
  assert.notEqual(row.upstream_model, 'tainted-retry-model');
});

test('失败尝试自报过模型、下一次成功没自报:字段清空,不把旧值当成功证据', async () => {
  const result = await callMessages({ model: 'asked-retry-silent', stream: true }, 'sess-rs');
  assert.equal(result.status, 200);
  const row = lastLog('asked-retry-silent');
  assert.ok(row.attempts >= 2, `应发生同渠道重试(attempts=${row.attempts})`);
  assert.equal(row.upstream_model, '', '上一发失败尝试的模型不能留给这一发成功条目');
});
