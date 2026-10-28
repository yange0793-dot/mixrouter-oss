'use strict';
// Codex → Chat 桥接入口回归:走真实 /v1/responses 端点,验证 mixrouter 入口把
// 「客户端原始 responses 请求」传进 lib/wire-openai-bridge 的
// streamChatAsResponses / chatJsonToResponses。
//
// 复现的缺陷(基线 67fd952ae4fe8bc1f3300913da61dfe3a1ce239a):
//   mixrouter.js 该桥两处调用都漏传 request(第 6 / 第 3 个参数),于是——
//   1) streamChatAsResponses 里 `request.stream !== false` 恒为 true:客户端 stream:false、
//      上游却回 SSE 时,非流客户端拿到的是 text/event-stream 而不是 JSON;
//   2) request.tools 缺失 → 工具注册表为空:自定义工具(namespace/custom)被降级成裸
//      function_call,namespace 与原始 input 都丢,下一轮回传也对不上。
//
// mock 本机上游 + 假 Key + 临时 HOME/数据目录,端口一律 listen(0);
// 不碰真实配置、真实上游、线上服务与浏览器。
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-codex-entry-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_MAX_ATTEMPTS = '1';

const mod = require('../mixrouter.js');
const codexTools = require('../lib/codex-tools');
const { _state } = mod;

const PATCH = '*** Begin Patch\n*** End Patch';
// 与 codex-bridge-modern.test.js 同一份合法协议契约:namespace 里的 custom 工具 + 普通 function 工具
const declared = [{ type: 'namespace', name: 'functions', tools: [
  { type: 'custom', name: 'apply_patch', description: 'Apply a patch',
    format: { type: 'grammar', syntax: 'lark', definition: 'start: "patch"' } },
  { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } }, strict: false },
] }];
const chatNameOf = name => [...codexTools.registry(declared).byName.values()].find(spec => spec.name === name).chatName;

// chat 协议上游能给的 usage(只在上游支持 include_usage 时才会带;mock 一律给)
const CHAT_USAGE = { prompt_tokens: 21, completion_tokens: 13, total_tokens: 34,
  prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 5 } };

// 一个 chat 协议 mock 上游:framing 决定回 JSON 还是 SSE;tool / reasoning 决定内容。
// 记录收到的每个请求(url / headers / body),供断言转发细节。
function createChatUpstream({ framing = 'json', tool = false, reasoning = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const cs = [];
    req.on('data', c => cs.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}'); } catch {}
      requests.push({ url: req.url, headers: req.headers, body });
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); return res.end('not found'); }
      const message = { role: 'assistant', content: (tool || reasoning) ? '' : 'mock-echo' };
      if (reasoning) message.reasoning_content = '先想一下';
      if (tool) message.tool_calls = [{ id: 'call_patch', type: 'function',
        function: { name: chatNameOf('apply_patch'), arguments: JSON.stringify({ input: PATCH }) } }];
      const finish = tool ? 'tool_calls' : 'stop';
      if (framing === 'sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const sse = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
        const delta = { role: 'assistant' };
        if (reasoning) delta.reasoning_content = '先想一下';
        if (tool) delta.tool_calls = message.tool_calls;
        else if (!reasoning) delta.content = 'mock-echo';
        sse({ object: 'chat.completion.chunk', choices: [{ index: 0, delta }] });
        sse({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }] });
        sse({ object: 'chat.completion.chunk', choices: [], usage: CHAT_USAGE });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message, finish_reason: finish }], usage: CHAT_USAGE }));
    });
  });
  return { server, requests };
}

const upstreams = {
  cjson: createChatUpstream({ framing: 'json', tool: true }),
  csse: createChatUpstream({ framing: 'sse' }),
  cthink: createChatUpstream({ framing: 'sse', reasoning: true }),
  ctool: createChatUpstream({ framing: 'sse', tool: true }),
};

let proxySrv, uiSrv, proxyPort, uiPort;

after(async () => {
  const servers = [proxySrv, uiSrv, ...Object.values(upstreams).map(up => up.server)];
  await Promise.all(servers.filter(server => server && server.listening).map(server => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  })));
});

function rawRequest(port, method, reqPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const creq = http.request({ hostname: '127.0.0.1', port, method, path: reqPath,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, cres => {
      const cs = [];
      cres.on('data', c => cs.push(c));
      cres.on('end', () => resolve({ status: cres.statusCode, headers: cres.headers, text: Buffer.concat(cs).toString('utf8') }));
    });
    creq.on('error', reject);
    if (data) creq.write(data);
    creq.end();
  });
}

// 客户端发一条 codex responses 请求(真实入口 /v1/responses)
const callResponses = (sessionId, { model, stream, body }) => rawRequest(proxyPort, 'POST', '/v1/responses', {
  headers: { 'Content-Type': 'application/json', 'session-id': sessionId, 'User-Agent': 'codex_exec/0.154.0' },
  body: { model, store: false, stream, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我看看这个仓库' }] }], ...body },
});
// 通用 match 规则已删除:每个 chat 渠道登记自己唯一的模型名,请求模型精确命中该渠道。
const resetRouting = () => { _state.routes = { rules: [] }; _state.slotMap = { claude: {}, codex: {} }; _state.resetPools(); };
const sseEvents = text => text.split('\n').filter(line => line.startsWith('data: '))
  .map(line => JSON.parse(line.slice(6)));

test('setup:mock chat 上游(JSON / SSE / 工具)+ 代理与控制台', async () => {
  for (const up of Object.values(upstreams)) {
    await new Promise(ok => up.server.listen(0, '127.0.0.1', ok));
    up.server.unref();
  }
  const at = up => `http://127.0.0.1:${up.server.address().port}`;
  const provs = {
    claude: [],
    codex: [
      { id: 'cjson', name: 'chat-json', base_url: at(upstreams.cjson), api_key: 'sk-json', enabled: true, model: 'glm-json', wire_api: 'chat' },
      { id: 'csse', name: 'chat-sse', base_url: at(upstreams.csse), api_key: 'sk-sse', enabled: true, model: 'glm-sse', wire_api: 'chat' },
      { id: 'cthink', name: 'chat-think', base_url: at(upstreams.cthink), api_key: 'sk-think', enabled: true, model: 'glm-think', wire_api: 'chat' },
      { id: 'ctool', name: 'chat-tool', base_url: at(upstreams.ctool), api_key: 'sk-tool', enabled: true, model: 'glm-tool', wire_api: 'chat' },
    ],
  };
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({ version: 2, current: { claude: null, codex: null }, ...provs }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({ rules: [] }));
  _state.store = provs;
  _state.sessions.clear();
  _state.cooldowns = {};
  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  proxySrv.unref(); uiSrv.unref();
});

test('入口回归:stream:false + chat 上游回 JSON,自定义工具经 chatJsonToResponses 保留 namespace/input', async () => {
  resetRouting();
  _state.sessions.clear();
  const before = upstreams.cjson.requests.length;
  const r = await callResponses('entry-json', { model: 'glm-json', stream: false, body: { tools: declared } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers['content-type'].includes('application/json'), '非流客户端必须拿到 JSON');
  assert.strictEqual(upstreams.cjson.requests.length, before + 1);
  assert.strictEqual(upstreams.cjson.requests.at(-1).url, '/v1/chat/completions', 'chat 协议渠道打 chat 端点');
  const j = JSON.parse(r.text);
  assert.strictEqual(j.status, 'completed');
  const call = j.output.find(o => o.type === 'custom_tool_call');
  assert.ok(call, '自定义工具应翻译成 custom_tool_call(缺 request.tools 会退化成 function_call)');
  assert.strictEqual(call.namespace, 'functions', 'namespace 不能丢');
  assert.strictEqual(call.input, PATCH, 'custom input 必须原样还原');
});

test('入口回归:stream:false + 上游回 SSE,入口按原请求判定,非流客户端拿到 JSON 而非 SSE', async () => {
  resetRouting();
  _state.sessions.clear();
  const r = await callResponses('entry-ns-sse', { model: 'glm-sse', stream: false });
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers['content-type'].includes('application/json'),
    '客户端 stream:false 时,上游即便回了 SSE 也不能把 SSE 发给非流客户端(缺 request.stream 就会)');
  const j = JSON.parse(r.text);
  assert.strictEqual(j.object, 'response');
  assert.strictEqual(j.output.find(o => o.type === 'message').content[0].text, 'mock-echo');
});

test('入口回归:上游忽略 stream(回 JSON)而客户端要流,代理摊成 responses SSE 且自定义工具不丢', async () => {
  resetRouting();
  _state.sessions.clear();
  const r = await callResponses('entry-stream-json', { model: 'glm-json', stream: true, body: { tools: declared } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers['content-type'].includes('text/event-stream'), '客户端要流就给流');
  assert.ok(r.text.includes('"type":"response.completed"'));
  assert.ok(r.text.includes('"type":"custom_tool_call"'), 'JSON 整包摊成 SSE 时自定义工具仍须保留');
  const done = sseEvents(r.text).find(ev => ev.type === 'response.completed');
  assert.strictEqual(done.response.output.find(o => o.type === 'custom_tool_call').namespace, 'functions');
});

test('入口回归:custom tools 出入及下一轮工具结果(SSE 上游)', async () => {
  resetRouting();
  _state.sessions.clear();
  const first = await callResponses('entry-tool', { model: 'glm-tool', stream: true, body: { tools: declared } });
  assert.strictEqual(first.status, 200);
  const events = sseEvents(first.text);
  const inputDone = events.find(ev => ev.type === 'response.custom_tool_call_input.done');
  assert.ok(inputDone, '自定义工具调用要发 custom_tool_call_input.done');
  assert.strictEqual(inputDone.input, PATCH);
  const callItem = events.find(ev => ev.type === 'response.output_item.done' && ev.item.type === 'custom_tool_call').item;
  assert.strictEqual(callItem.namespace, 'functions');
  assert.strictEqual(callItem.name, 'apply_patch');

  // 第二轮:把上一轮的 custom_tool_call 与其结果回传,上游应收到 assistant.tool_calls + tool 结果
  const before = upstreams.ctool.requests.length;
  const second = await callResponses('entry-tool', { model: 'glm-tool', stream: true, body: {
    tools: declared,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
      callItem, { type: 'custom_tool_call_output', call_id: callItem.call_id, output: 'applied' }],
  } });
  assert.strictEqual(second.status, 200);
  const sent = upstreams.ctool.requests.at(-1).body;
  assert.strictEqual(upstreams.ctool.requests.length, before + 1);
  const assistant = sent.messages.find(m => m.role === 'assistant');
  assert.strictEqual(assistant.tool_calls[0].function.name, chatNameOf('apply_patch'), '回传时用回 chat 侧工具名');
  assert.deepStrictEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { input: PATCH });
  const toolMsg = sent.messages.find(m => m.role === 'tool');
  assert.strictEqual(toolMsg.tool_call_id, callItem.call_id);
  assert.strictEqual(toolMsg.content, 'applied');
});

test('入口回归:reasoning 与 usage 穿过桥接层保留', async () => {
  resetRouting();
  _state.sessions.clear();
  const r = await callResponses('entry-rs', { model: 'glm-think', stream: true });
  assert.strictEqual(r.status, 200);
  const done = sseEvents(r.text).find(ev => ev.type === 'response.completed');
  assert.strictEqual(done.response.output.find(o => o.type === 'reasoning').summary[0].text, '先想一下');
  assert.strictEqual(done.response.usage.input_tokens, 21);
  assert.strictEqual(done.response.usage.output_tokens, 13);
  assert.strictEqual(done.response.usage.input_tokens_details.cached_tokens, 4);
  assert.strictEqual(done.response.usage.output_tokens_details.reasoning_tokens, 5);
  const log = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?limit=1')).text).logs[0];
  assert.strictEqual(log.in, 21);
  assert.strictEqual(log.out, 13);
  assert.strictEqual(log.cache_read, 4);
});
