'use strict';
// 编程兼容性探针的**链路级**回归。
//
// 这个文件不测"函数返回值长什么样",而是钉住三件事:
//   1. 六条客户端→上游协议组合(Claude→anthropic/responses/chat、Codex Responses→
//      responses/chat、ZCode chat→chat)都真的经过 createAttempt + createAttemptRunner +
//      createRequestContext + production dispatchResponse,而不是只打 /v1/models;
//   2. 隔离:注入的 storeOf / settleRequest 一旦被调用就抛错 ——
//      探针必须只认识本次渠道,不写会话、不碰真实渠道库;
//   3. 安全与预算:没有 confirm_run 零请求、一次 test 最多 3 次上游调用、401/403 分开、
//      断流/缺终态/错误帧分开、输出与结果有上限、结果不含 Key 或上游正文。
//
// 全部用 127.0.0.1 临时端口上的桩上游;不连真实上游、不读真实配置。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
// 夹具里每个探测都是一条独立短连接:共享 keep-alive socket 会在多次探测之间累积
// close 监听(Node 会打 MaxListenersExceededWarning),与要测的链路语义无关。
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 在 require 主入口之前隔离运行时数据;这里只借用主入口导出的出站构造/错误分类纯函数,
// 不启动任何服务(require.main 守卫)。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-compat-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_ZCODE_CONFIG = path.join(TMP, 'zcode.json');
process.env.MIXR_RETRY_DELAY_MS = '0';
process.env.MIXROUTER_PORT = '0';
process.env.MIXUI_PORT = '0';

const router = require('../mixrouter.js');
const wireOpenai = require('../lib/wire-openai-bridge');
const wireChat = require('../lib/wire-chat');
const wireResponses = require('../lib/wire-responses');
const collect = require('../lib/upstream-collect');
const { createAnthropicTranslator } = require('../lib/wire-anthropic-translator');
const { createResponder } = require('../lib/proxy/response');
const { upstreamErrorText } = require('../lib/upstream-error-text');
const errText = require('../lib/observability/err-text');
const headersLib = require('../lib/routing/headers');
const sessionConfig = require('../lib/routing/session-config');
const compactLib = require('../lib/routing/compact');
const toolFilter = require('../lib/tool-filter');
const { createResponseArchive } = require('../lib/observability/response-archive');
const { createCompatibilityTester, PROBE_TOOL_NAME } = require('../lib/compatibility-probe.js');

const SECRET = 'sk-compat-SECRET-do-not-echo';
const OTHER_SECRET = 'sk-compat-OTHER-do-not-echo';
const MOCK_TEXT = 'PONG LEAK-CANARY-BODY';

// ---------------------------------------------------------------- production 响应链
// 与 mixrouter.js 装配 createResponder 时用的依赖同一份。sseResult 在主入口里是局部函数,
// 这里按它的实现逐字复制(只用于桩测试的"成功判定",不参与任何翻译)。
function sseResult(wire, text) {
  let terminal = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (wire === 'chat' && data === '[DONE]') { terminal = true; continue; }
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    if (event.error || event.type === 'error' || event.type === 'response.failed')
      return { ok: false, error: upstreamErrorText(JSON.stringify(event)) || '上游返回流式错误' };
    if (wire === 'anthropic' && event.type === 'message_stop') terminal = true;
    if (wire === 'responses' && ['response.completed', 'response.incomplete'].includes(event.type)) terminal = true;
    if (wire === 'chat' && event.choices?.some(choice => choice.finish_reason)) terminal = true;
  }
  return { ok: terminal, error: terminal ? '' : '上游流没有给出合法终态就结束了' };
}

const { dispatchResponse } = createResponder({
  collect, createAnthropicTranslator,
  extractUsageFor: router.extractUsageFor,
  extractUsageOpenAI: wireOpenai.extractUsageOpenAI,
  sseResult, upstreamErrorText,
  errBodyText: errText.errBodyText, errLine: errText.errLine,
  errLineOrPlaceholder: errText.errLineOrPlaceholder, clip: errText.clip,
  wireChat, wireResponses, wireOpenai,
});

const convGens = new Map();
const convBase = (sessionKey, providerId) => `${providerId}-${sessionKey || 'anon'}`.replace(/[^A-Za-z0-9_-]/g, '');
const keyFallbackCalls = [];

// 注入 storeOf / settleRequest 的桩**故意抛错**:探针必须在 buildRunner
// 里用隔离版本覆盖它们。任何一条被调用都说明隔离失效,测试会直接红。
function attemptDepsFixture() {
  // 真实 keyFallback 实例持有进程内的失败诊断与粘性状态:探针只要碰一次,用户的真实
  // 请求就可能被换号或误恢复。这里留一个会记账的替身,断言探针一次都没用到它。
  const keyFallback = {
    select: keyChoice => { keyFallbackCalls.push('select'); return keyChoice; },
    failure: () => { keyFallbackCalls.push('failure'); return { switchable: false, scope: 'none', wait_ms: 0 }; },
    success: () => { keyFallbackCalls.push('success'); return { restored: false }; },
    list: () => { keyFallbackCalls.push('list'); return []; },
    reset: () => { keyFallbackCalls.push('reset'); },
  };
  return {
    http, https,
    storeOf: () => { throw new Error('probe must not read the injected provider store'); },
    slotMapOf: () => { throw new Error('probe must not read the injected slot map'); },
    sessionConfig, compactLib,
    wireOf: router.wireOf,
    upstreamPathOf: router.upstreamPathOf,
    joinUpstreamPath: router.joinUpstreamPath,
    buildUpstreamHeaders: router.buildUpstreamHeaders,
    buildOpenAiHeaders: router.buildOpenAiHeaders,
    applyModel: router.applyModel,
    toolFilter,
    safeHeader: router.safeHeader,
    hasCtlChar: headersLib.hasCtlChar,
    transportAgent: () => undefined,
    createResponseArchive,
    channelSecrets: () => [],
    clientToken: req => {
      const auth = String((req.headers && req.headers.authorization) || '');
      return auth ? auth.replace(/^Bearer\s+/i, '').trim() : String((req.headers && req.headers['x-api-key']) || '');
    },
    errorClass: router.errorClass,
    retryableStatus: status => status === 429 || status === 402 || status >= 500,
    settleRequest: () => { throw new Error('probe must not settle a session'); },
    sha256: text => crypto.createHash('sha256').update(text).digest('hex'),
    wireResponses, wireChat, wireOpenai,
    convCacheKey: (sessionKey, providerId, gen) => `${convBase(sessionKey, providerId)}${gen ? `-g${gen}` : ''}`,
    convCacheGen: (sessionKey, providerId) => convGens.get(`${providerId}\u0000${sessionKey}`) || 0,
    rotateConvCacheGen: (sessionKey, providerId) => {
      const key = `${providerId}\u0000${sessionKey}`;
      const next = ((convGens.get(key) || 0) + 1) % 50;
      convGens.set(key, next);
      return next;
    },
    firstHeaderTimeoutFor: () => 5000,
    streamIdleTimeoutMs: 5000,
    nonstreamTotalTimeoutMs: 5000,
    responseArchiveOn: false,
    responseArchiveDir: '',
    uiPort: 0,
    DEFAULT_UA_CODEX: 'codex_cli_rs/compat-test',
    dispatchResponse,
    keyFallback,
  };
}

// ---------------------------------------------------------------- 桩上游
// 三种上游协议各一条回复路径。mode 只影响需要它的那一种探测:
//   incomplete / error / aborted 只作用于 stream 探测;noTool / badToolArgs /
//   wrongToolName / customTool 只作用于 tools 探测。generation 始终按正常结果回。
function createMockUpstream() {
  const requests = [];
  const sockets = new Set();
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    sockets.add(req.socket);
    req.socket.on('close', () => sockets.delete(req.socket));
    req.on('error', () => {});
    res.on('error', () => {});
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      requests.push({ url: req.url, headers: req.headers, body });
      const sendJson = (status, value) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (mode === 'unauthorized')
        return sendJson(401, { error: { message: 'mock invalid key', type: 'authentication_error' } });
      if (mode === 'forbidden')
        return sendJson(403, { error: { message: 'mock forbidden', type: 'permission_error' } });
      if (mode === 'hang') return; // 收下请求就不回;由探针的时限掐断
      const kind = probeKindOf(body);
      if (req.url.includes('/v1/messages')) return anthropicReply(res, body, mode, kind);
      if (req.url.includes('/v1/responses')) return responsesReply(res, body, mode, kind);
      if (req.url.includes('/v1/chat/completions')) return chatReply(res, body, mode, kind);
      return sendJson(404, { error: { message: 'mock unknown path' } });
    });
  });
  return {
    server, requests,
    get mode() { return mode; },
    set mode(value) { mode = value; },
    get maxFlood() { return maxFlood; },
    reset(next = 'ok') { requests.length = 0; mode = next; maxFlood = 0; },
    close() {
      for (const socket of sockets) { try { socket.destroy(); } catch {} }
      sockets.clear();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

// 请求体里能唯一区分三种探测的标记:PONG=非流生成、连续数字=stream、工具名=tools。
function probeKindOf(body) {
  const raw = JSON.stringify(body || {});
  if (raw.includes('1 2 3 4 5')) return 'stream';
  if (raw.includes(PROBE_TOOL_NAME)) return 'tools';
  return 'generation';
}

function toolOutcome(mode) {
  if (mode === 'noTool') return { call: false };
  if (mode === 'wrongToolName') return { call: true, name: 'other_tool', args: '{"value":"ok"}' };
  if (mode === 'badToolArgs') return { call: true, name: PROBE_TOOL_NAME, args: '{"value":123}' };
  // 网关把 function 工具改写成 custom 工具:名字和参数都在,但形状不对。
  if (mode === 'customTool') return { call: true, custom: true, name: PROBE_TOOL_NAME, args: '{"value":"ok"}' };
  return { call: true, name: PROBE_TOOL_NAME, args: '{"value":"ok"}' };
}

function sseWrite(res, frame) {
  if (res.writableEnded || res.destroyed) return false;
  try { return res.write(frame); } catch { return false; }
}

function floodFrames(res, makeFrame) {
  for (let i = 0; i < 120; i++) {
    if (res.destroyed || res.writableEnded) return;
    sseWrite(res, makeFrame('x'.repeat(128)));
  }
}

// 慢速大响应:每拍只写 1KiB,并记录单个请求真实写出去的最大字节数。
// 用来证明"上游字节闸门"确实在客户端响应之前掐断了管道,而不是等整包攒完再截断。
let maxFlood = 0;
function floodSlow(res, makeFrame) {
  let sent = 0;
  const tick = () => {
    if (res.destroyed || res.writableEnded) return;
    try { res.write(makeFrame('x'.repeat(1024))); }
    catch { return; }
    sent += 1024;
    if (sent > maxFlood) maxFlood = sent;
    if (sent >= 512 * 1024) { try { res.end(); } catch {} return; }
    if (res.writableLength > 128 * 1024) res.once('drain', tick);
    else setImmediate(tick);
  };
  setImmediate(tick);
}

function anthropicReply(res, body, mode, kind) {
  const model = body.model || 'mock-model';
  if (body.stream === false) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'msg_mock', type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: MOCK_TEXT }], stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.flushHeaders();
  const send = event => sseWrite(res, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model,
    usage: { input_tokens: 0, output_tokens: 0 } } });
  if (mode === 'floodSlow') {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    return floodSlow(res, text => `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
    })}\n\n`);
  }
  if (mode === 'flood') {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    floodFrames(res, text => `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
    })}\n\n`);
  } else if (kind === 'tools') {
    const outcome = toolOutcome(mode);
    if (!outcome.call) {
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: MOCK_TEXT } });
    } else {
      send({ type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'toolu_mock', name: outcome.name, input: {} } });
      send({ type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: outcome.args } });
    }
  } else {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: kind === 'stream' ? '1 2 3 4 5' : MOCK_TEXT } });
  }
  if (kind === 'stream' && mode === 'aborted') {
    // 稍等一拍再断:先把已写出的 SSE 帧真的送到客户端,才是"流开始后中断";
    // 立刻 destroy 会退化成"响应头都没拿到"(network_error),测不到这条分支。
    setTimeout(() => { try { res.destroy(); } catch {} }, 25);
    return;
  }
  if (kind === 'stream' && mode === 'incomplete') return res.end();
  if (kind === 'stream' && mode === 'error') {
    send({ type: 'error', error: { message: 'mock stream error' } });
    return res.end();
  }
  send({ type: 'content_block_stop', index: 0 });
  send({ type: 'message_delta', delta: { stop_reason: kind === 'tools' ? 'tool_use' : 'end_turn' },
    usage: { input_tokens: 5, output_tokens: 3 } });
  send({ type: 'message_stop' });
  res.end();
}

function responsesReply(res, body, mode, kind) {
  const model = body.model || 'mock-model';
  const outcome = kind === 'tools' ? toolOutcome(mode) : null;
  if (body.stream === false) {
    const output = kind === 'tools'
      ? (outcome.call
        ? [outcome.custom
          ? { type: 'custom_tool_call', id: 'ctc_mock', call_id: 'call_mock',
            name: outcome.name, input: outcome.args, status: 'completed' }
          : { type: 'function_call', id: 'fc_mock', call_id: 'call_mock', name: outcome.name,
            arguments: outcome.args, status: 'completed' }]
        : [{ type: 'message', id: 'msg_mock', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: MOCK_TEXT, annotations: [] }] }])
      : [{ type: 'message', id: 'msg_mock', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: MOCK_TEXT, annotations: [] }] }];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'resp_mock', object: 'response', status: 'completed', model, output,
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.flushHeaders();
  const sse = event => sseWrite(res, `data: ${JSON.stringify(event)}\n\n`);
  sse({ type: 'response.created', response: { id: 'resp_mock', object: 'response', status: 'in_progress', model, output: [] } });
  if (mode === 'floodSlow') {
    sse({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'message', id: 'msg_mock', role: 'assistant', status: 'in_progress', content: [] } });
    return floodSlow(res, text => `data: ${JSON.stringify({
      type: 'response.output_text.delta', item_id: 'msg_mock', output_index: 0, content_index: 0, delta: text,
    })}\n\n`);
  }
  if (mode === 'flood') {
    sse({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'message', id: 'msg_mock', role: 'assistant', status: 'in_progress', content: [] } });
    floodFrames(res, text => `data: ${JSON.stringify({
      type: 'response.output_text.delta', item_id: 'msg_mock', output_index: 0, content_index: 0, delta: text,
    })}\n\n`);
  } else if (kind === 'tools' && outcome.call) {
    sse({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', id: 'fc_mock', call_id: 'call_mock', name: outcome.name, arguments: '' } });
    sse({ type: 'response.function_call_arguments.delta', item_id: 'fc_mock', output_index: 0, delta: outcome.args });
    sse({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', id: 'fc_mock', call_id: 'call_mock', name: outcome.name,
        arguments: outcome.args, status: 'completed' } });
  } else {
    sse({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'message', id: 'msg_mock', role: 'assistant', status: 'in_progress', content: [] } });
    sse({ type: 'response.output_text.delta', item_id: 'msg_mock', output_index: 0, content_index: 0,
      delta: kind === 'stream' ? '1 2 3 4 5' : MOCK_TEXT });
    sse({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'message', id: 'msg_mock', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: kind === 'stream' ? '1 2 3 4 5' : MOCK_TEXT, annotations: [] }] } });
  }
  if (kind === 'stream' && mode === 'aborted') {
    // 稍等一拍再断:先把已写出的 SSE 帧真的送到客户端,才是"流开始后中断";
    // 立刻 destroy 会退化成"响应头都没拿到"(network_error),测不到这条分支。
    setTimeout(() => { try { res.destroy(); } catch {} }, 25);
    return;
  }
  if (kind === 'stream' && mode === 'incomplete') return res.end();
  if (kind === 'stream' && mode === 'error') {
    sse({ type: 'error', error: { message: 'mock stream error' } });
    return res.end();
  }
  sse({ type: 'response.completed', response: { id: 'resp_mock', object: 'response', status: 'completed', model,
    output: [], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } });
  res.end();
}

function chatReply(res, body, mode, kind) {
  const model = body.model || 'mock-model';
  const outcome = kind === 'tools' ? toolOutcome(mode) : null;
  if (body.stream === false) {
    const message = kind === 'tools' && outcome.call
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_mock', type: 'function',
        function: { name: outcome.name, arguments: outcome.args } }] }
      : { role: 'assistant', content: MOCK_TEXT };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'chatcmpl_mock', object: 'chat.completion', model,
      choices: [{ index: 0, message, finish_reason: kind === 'tools' && outcome.call ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.flushHeaders();
  const sse = event => sseWrite(res, `data: ${JSON.stringify(event)}\n\n`);
  if (mode === 'floodSlow') {
    return floodSlow(res, text => `data: ${JSON.stringify({
      id: 'chatcmpl_mock', object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta: { content: text } }],
    })}\n\n`);
  }
  if (mode === 'flood') {
    floodFrames(res, text => `data: ${JSON.stringify({
      id: 'chatcmpl_mock', object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta: { content: text } }],
    })}\n\n`);
  } else if (kind === 'tools' && outcome.call) {
    sse({ id: 'chatcmpl_mock', object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_mock', type: 'function',
        function: { name: outcome.name, arguments: outcome.args } }] } }] });
  } else {
    sse({ id: 'chatcmpl_mock', object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta: { role: 'assistant', content: kind === 'stream' ? '1 2 3 4 5' : MOCK_TEXT } }] });
  }
  if (kind === 'stream' && mode === 'aborted') {
    // 稍等一拍再断:先把已写出的 SSE 帧真的送到客户端,才是"流开始后中断";
    // 立刻 destroy 会退化成"响应头都没拿到"(network_error),测不到这条分支。
    setTimeout(() => { try { res.destroy(); } catch {} }, 25);
    return;
  }
  if (kind === 'stream' && mode === 'incomplete') return res.end();
  if (kind === 'stream' && mode === 'error') {
    sse({ error: { message: 'mock stream error' } });
    return res.end();
  }
  sse({ id: 'chatcmpl_mock', object: 'chat.completion.chunk', model,
    choices: [{ index: 0, delta: {}, finish_reason: kind === 'tools' && outcome.call ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
  sseWrite(res, 'data: [DONE]\n\n');
  res.end();
}

// ---------------------------------------------------------------- 夹具
const mock = createMockUpstream();
let port = 0;
let tester = null;
let attemptDeps = null;

function makeProvider(overrides = {}) {
  return {
    id: 'compat-p1', name: '兼容探针渠道', base_url: `http://127.0.0.1:${port}`,
    api_key: SECRET,
    keys: [
      { id: 'k1', label: '主账号', key: SECRET },
      { id: 'k2', label: '备账号', key: OTHER_SECRET },
    ],
    active_key: 'k1', enabled: true, models: ['mock-model'], ua: 'compat-test/1.0',
    ...overrides,
  };
}

function normalRun(overrides = {}) {
  return tester.test({
    provider: makeProvider(), app: 'claude', model: 'mock-model',
    key_id: 'k1', client_wire: 'messages', confirm_run: true, ...overrides,
  });
}

const COMBOS = [
  { app: 'claude', client_wire: 'messages', wire_api: 'anthropic' },
  { app: 'claude', client_wire: 'messages', wire_api: 'responses' },
  { app: 'claude', client_wire: 'messages', wire_api: 'chat' },
  { app: 'codex', client_wire: 'responses', wire_api: 'responses' },
  { app: 'codex', client_wire: 'responses', wire_api: 'chat' },
  { app: 'zcode', client_wire: 'chat', wire_api: 'chat' }, // ZCode 的 chat 接入
];
const UPSTREAM_PATH = {
  anthropic: '/v1/messages', responses: '/v1/responses', chat: '/v1/chat/completions',
};

before(async () => {
  await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve));
  port = mock.server.address().port;
  attemptDeps = attemptDepsFixture();
  tester = createCompatibilityTester({ attemptDeps });
});

after(async () => {
  await mock.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 链路矩阵

test('六条客户端→上游协议组合全部经真实转发链通过', async t => {
  for (const combo of COMBOS) {
    await t.test(`${combo.app}/${combo.client_wire} → ${combo.wire_api}`, async () => {
      mock.reset();
      const provider = makeProvider({ wire_api: combo.wire_api });
      const result = await tester.test({
        provider, app: combo.app, model: 'mock-model', key_id: 'k1',
        client_wire: combo.client_wire, confirm_run: true,
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.checks.map(check => check.id),
        ['authentication', 'generation', 'stream', 'tools']);
      for (const check of result.checks) {
        assert.equal(check.status, 'pass', `${check.id}: ${check.code} ${check.message}`);
        assert.equal(typeof check.code, 'string');
        assert.equal(typeof check.message, 'string');
        assert.ok(Number.isInteger(check.ms) && check.ms >= 0);
      }
      assert.deepEqual(result.scope, {
        app: combo.app, client_wire: combo.client_wire, wire_api: combo.wire_api,
        model: 'mock-model', key_id: 'k1',
      });
      assert.equal(new Date(result.checked_at).toISOString(), result.checked_at);
      assert.ok(Number.isInteger(result.ms) && result.ms >= 0);

      // 一次 test 恰好三次上游调用:生成、流、工具各一次,没有重试放大。
      assert.equal(mock.requests.length, 3);
      for (const request of mock.requests)
        assert.equal(request.url, UPSTREAM_PATH[combo.wire_api]);

      // 工具请求真的带着固定、无副作用的探针工具与强制选择。
      const toolBody = mock.requests[2].body;
      if (combo.wire_api === 'anthropic') {
        assert.equal(toolBody.tools[0].name, PROBE_TOOL_NAME);
        assert.deepEqual(toolBody.tool_choice, { type: 'tool', name: PROBE_TOOL_NAME });
      } else if (combo.wire_api === 'responses') {
        assert.equal(toolBody.tools[0].type, 'function');
        assert.equal(toolBody.tools[0].name, PROBE_TOOL_NAME);
        assert.equal(toolBody.tools[0].parameters.properties.value.type, 'string');
        assert.deepEqual(toolBody.tool_choice, { type: 'function', name: PROBE_TOOL_NAME });
      } else {
        assert.equal(toolBody.tools[0].type, 'function');
        assert.equal(toolBody.tools[0].function.name, PROBE_TOOL_NAME);
        assert.equal(toolBody.tools[0].function.parameters.properties.value.type, 'string');
        assert.deepEqual(toolBody.tool_choice, { type: 'function', function: { name: PROBE_TOOL_NAME } });
      }

      // 结果不含 Key、也不含上游正文。
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes(SECRET), false);
      assert.equal(serialized.includes(OTHER_SECRET), false);
      assert.equal(serialized.includes('LEAK-CANARY-BODY'), false);
    });
  }
});

test('指定 key_id 只使用那把 Key,且不改写传入的渠道对象', async () => {
  mock.reset();
  // key_fallback=true 的渠道也必须被探针按"指定账号"测:自动换号会让 key_id 说谎,
  // 也可能把一次检查放大成多次上游调用。
  const provider = makeProvider({ key_fallback: true });
  const before = JSON.stringify(provider);
  const result = await tester.test({
    provider, app: 'claude', model: 'mock-model', key_id: 'k2',
    client_wire: 'messages', confirm_run: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.scope.key_id, 'k2');
  assert.equal(mock.requests.length, 3);
  for (const request of mock.requests) {
    assert.equal(request.headers.authorization, `Bearer ${OTHER_SECRET}`);
    assert.notEqual(request.headers.authorization, `Bearer ${SECRET}`);
  }
  assert.equal(JSON.stringify(result).includes(OTHER_SECRET), false);
  assert.equal(JSON.stringify(provider), before, '探针不得写回渠道对象');
});

test('key_id 缺省时使用 active_key;legacy 单 Key 渠道也能探', async () => {
  mock.reset();
  const keyed = makeProvider({ active_key: 'k2' });
  const keyedResult = await tester.test({
    provider: keyed, app: 'claude', model: 'mock-model',
    client_wire: 'messages', confirm_run: true,
  });
  assert.equal(keyedResult.ok, true, JSON.stringify(keyedResult));
  assert.equal(keyedResult.scope.key_id, 'k2');
  for (const request of mock.requests)
    assert.equal(request.headers.authorization, `Bearer ${OTHER_SECRET}`);

  mock.reset();
  const legacy = makeProvider();
  delete legacy.keys;
  delete legacy.active_key;
  const legacyResult = await tester.test({
    provider: legacy, app: 'claude', model: 'mock-model',
    client_wire: 'messages', confirm_run: true,
  });
  assert.equal(legacyResult.ok, true, JSON.stringify(legacyResult));
  assert.equal(legacyResult.scope.key_id, 'klegacy');
  for (const request of mock.requests)
    assert.equal(request.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(JSON.stringify(legacyResult).includes(SECRET), false);
});

test('缺少 confirm_run 时四条检查全部 skipped,零上游请求', async () => {
  mock.reset();
  const result = await tester.test({
    provider: makeProvider(), app: 'claude', model: 'mock-model', client_wire: 'messages',
    confirm_run: 'true', // 只认严格 true,字符串不算确认
  });
  assert.equal(result.ok, false);
  assert.equal(mock.requests.length, 0);
  assert.equal(result.checks.length, 4);
  for (const check of result.checks) {
    assert.equal(check.status, 'skipped');
    assert.equal(check.code, 'confirmation_required');
  }
  assert.equal(result.scope.wire_api, 'anthropic');
});

test('Key 不可用时明确报认证问题,且不发任何请求', async () => {
  mock.reset();
  const result = await tester.test({
    provider: makeProvider(), app: 'claude', model: 'mock-model', key_id: 'missing-key',
    client_wire: 'messages', confirm_run: true,
  });
  assert.equal(result.ok, false);
  assert.equal(mock.requests.length, 0);
  const auth = result.checks.find(check => check.id === 'authentication');
  assert.equal(auth.status, 'fail');
  assert.equal(auth.code, 'key_unavailable');
  for (const check of result.checks.filter(c => c.id !== 'authentication')) {
    assert.equal(check.status, 'skipped');
    assert.equal(check.code, 'authentication_unavailable');
  }
});

test('chat 客户端配 responses 渠道是配置不匹配:零请求', async () => {
  mock.reset();
  const result = await tester.test({
    provider: makeProvider({ wire_api: 'responses' }), app: 'zcode', model: 'mock-model',
    client_wire: 'chat', confirm_run: true,
  });
  assert.equal(result.ok, false);
  assert.equal(mock.requests.length, 0);
  for (const check of result.checks) {
    assert.equal(check.status, 'skipped');
    assert.equal(check.code, 'wire_api_mismatch');
  }
});

test('不认识的 app / client_wire 直接拒绝,零请求', async () => {
  mock.reset();
  const badApp = await tester.test({ provider: makeProvider(), app: 'unknown', model: 'm',
    client_wire: 'chat', confirm_run: true });
  assert.equal(badApp.ok, false);
  assert.equal(badApp.checks[0].code, 'invalid_request');
  const badWire = await tester.test({ provider: makeProvider(), app: 'codex', model: 'm',
    client_wire: 'messages', confirm_run: true });
  assert.equal(badWire.ok, false);
  assert.equal(badWire.checks[0].code, 'invalid_request');
  const zcodeNoWire = await tester.test({ provider: makeProvider({ wire_api: 'chat' }), app: 'zcode',
    model: 'm', confirm_run: true });
  assert.equal(zcodeNoWire.ok, false);
  assert.equal(zcodeNoWire.checks[0].code, 'invalid_request');
  assert.equal(mock.requests.length, 0);
});

test('Codex 选 chat 连接仍按 Responses 客户端探(测的是翻译链,不是 chat 直连)', async () => {
  mock.reset();
  const result = await tester.test({
    provider: makeProvider({ wire_api: 'chat' }), app: 'codex', model: 'mock-model',
    key_id: 'k1', client_wire: 'chat', confirm_run: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.scope.client_wire, 'responses');
  assert.equal(result.scope.wire_api, 'chat');
  assert.equal(mock.requests.length, 3);
  // Responses→Chat 转换才会带 stream_options.include_usage(chat 直连不会平白加)。
  assert.equal(mock.requests[1].body.stream_options.include_usage, true);
  // 工具定义来自 codexTools.definitions:Responses 的 strict 字段被保留下来。
  assert.equal(mock.requests[2].body.tools[0].function.strict, false);
});

test('显式 app=zcode 按 kind 选择客户端协议(anthropic/responses/chat)', async t => {
  const cases = [
    { wire_api: 'anthropic', client_wire: 'anthropic', client: 'messages', path: '/v1/messages' },
    { wire_api: 'responses', client_wire: 'responses', client: 'responses', path: '/v1/responses' },
    { wire_api: 'chat', client_wire: 'chat', client: 'chat', path: '/v1/chat/completions' },
  ];
  for (const item of cases) {
    await t.test(`zcode/${item.client_wire}`, async () => {
      mock.reset();
      const result = await tester.test({
        provider: makeProvider({ wire_api: item.wire_api }), app: 'zcode', model: 'mock-model',
        key_id: 'k1', client_wire: item.client_wire, confirm_run: true,
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.scope.app, 'zcode');
      assert.equal(result.scope.client_wire, item.client);
      assert.equal(result.scope.wire_api, item.wire_api);
      assert.equal(mock.requests.length, 3);
      assert.equal(mock.requests[0].url, item.path);
    });
  }
});

test('控制台接入向导传 wire 名(anthropic/responses/chat)也能探', async t => {
  // public/js/readiness.js 把 readinessState.wire 直接当 client_wire 发上来;
  // claude 组的客户端协议恒为 messages,传上来的值描述的是上游连接。
  const cases = [
    { wire_api: 'anthropic', client_wire: 'anthropic', expect: 'messages' },
    { wire_api: 'responses', client_wire: 'responses', expect: 'messages' },
    { wire_api: 'chat', client_wire: 'chat', expect: 'messages' },
  ];
  for (const item of cases) {
    await t.test(`claude/${item.client_wire}`, async () => {
      mock.reset();
      const result = await tester.test({
        provider: makeProvider({ wire_api: item.wire_api }), app: 'claude', model: 'mock-model',
        key_id: 'k1', client_wire: item.client_wire, confirm_run: true,
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.scope.client_wire, item.expect);
      assert.equal(result.scope.wire_api, item.wire_api);
      // 客户端始终说 /v1/messages;上游由渠道 wire_api 决定(响应体形状随之转换)。
      assert.equal(mock.requests.length, 3);
      assert.ok(JSON.stringify(mock.requests[0].body).includes('PONG'));
    });
  }
});

// ---------------------------------------------------------------- 认证语义

test('401:认证检查 fail,不谎报成功', async () => {
  mock.reset('unauthorized');
  const result = await normalRun();
  assert.equal(result.ok, false);
  assert.equal(mock.requests.length, 3);
  for (const id of ['generation', 'stream', 'tools'])
    assert.equal(result.checks.find(c => c.id === id).code, 'authentication_rejected');
  const auth = result.checks.find(check => check.id === 'authentication');
  assert.equal(auth.status, 'fail');
  assert.equal(auth.code, 'authentication_rejected');
});

test('403:认证检查保持 unknown,不把权限/区域限制说成坏账号', async () => {
  mock.reset('forbidden');
  const result = await normalRun();
  assert.equal(result.ok, false);
  for (const id of ['generation', 'stream', 'tools'])
    assert.equal(result.checks.find(c => c.id === id).code, 'forbidden');
  const auth = result.checks.find(check => check.id === 'authentication');
  assert.equal(auth.status, 'unknown');
  assert.equal(auth.code, 'forbidden');
  assert.notEqual(auth.code, 'authentication_rejected');
});

// ---------------------------------------------------------------- 流终态与错误

test('干净结束但缺少终态:stream_incomplete,与错误帧区分', async () => {
  mock.reset('incomplete');
  const result = await normalRun();
  assert.equal(result.ok, false);
  const stream = result.checks.find(check => check.id === 'stream');
  assert.equal(stream.status, 'fail');
  assert.equal(stream.code, 'stream_incomplete');
  assert.equal(result.checks.find(c => c.id === 'generation').status, 'pass');
  assert.equal(result.checks.find(c => c.id === 'tools').status, 'pass');
  assert.equal(result.checks.find(c => c.id === 'authentication').status, 'pass');
});

test('上游发错误帧:stream_error', async () => {
  mock.reset('error');
  const result = await normalRun();
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(check => check.id === 'stream').code, 'stream_error');
});

test('上游在终态前断连:stream_aborted', async () => {
  mock.reset('aborted');
  const result = await normalRun();
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(check => check.id === 'stream').code, 'stream_aborted');
  assert.equal(result.checks.find(c => c.id === 'generation').status, 'pass');
});

// ---------------------------------------------------------------- 工具语义

test('模型没调工具:tool_not_called', async () => {
  mock.reset('noTool');
  const result = await normalRun();
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(check => check.id === 'tools').code, 'tool_not_called');
  assert.equal(result.checks.find(c => c.id === 'generation').status, 'pass');
});

test('工具名不对:tool_name_mismatch', async () => {
  mock.reset('wrongToolName');
  const result = await normalRun();
  assert.equal(result.checks.find(check => check.id === 'tools').code, 'tool_name_mismatch');
});

test('工具参数不满足 {value:string}:tool_args_invalid', async () => {
  mock.reset('badToolArgs');
  const result = await normalRun();
  assert.equal(result.checks.find(check => check.id === 'tools').code, 'tool_args_invalid');
});

test('Responses 工具被改写成 custom_tool_call:tool_format_mismatch', async () => {
  mock.reset('customTool');
  const result = await normalRun({
    app: 'codex', client_wire: 'responses', provider: makeProvider({ wire_api: 'responses' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(check => check.id === 'tools').code, 'tool_format_mismatch');
  assert.equal(result.checks.find(c => c.id === 'generation').status, 'pass');
});

// ---------------------------------------------------------------- 预算与上限

test('单次与总时限:卡死的上游被掐断,不会无限等', async () => {
  mock.reset('hang');
  const limited = createCompatibilityTester({
    attemptDeps, limits: { total_ms: 1500, per_check_ms: 300, output_bytes: 4096 },
  });
  const started = Date.now();
  const result = await limited.test({
    provider: makeProvider(), app: 'claude', model: 'mock-model', key_id: 'k1',
    client_wire: 'messages', confirm_run: true,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.ok(elapsed < 5000, `应被时限收住,实际 ${elapsed}ms`);
  assert.equal(mock.requests.length, 3, '每次检查最多一次上游调用');
  for (const check of result.checks.filter(c => c.id !== 'authentication')) {
    assert.ok(['timeout', 'skipped'].includes(check.code), `${check.id}: ${check.code}`);
  }
  const auth = result.checks.find(check => check.id === 'authentication');
  assert.notEqual(auth.status, 'pass');
});

test('输出超过 output_bytes 立即中止并如实报告', async () => {
  mock.reset('flood');
  const limited = createCompatibilityTester({
    attemptDeps, limits: { total_ms: 8000, per_check_ms: 3000, output_bytes: 512, result_bytes: 2048 },
  });
  const result = await limited.test({
    provider: makeProvider(), app: 'claude', model: 'mock-model', key_id: 'k1',
    client_wire: 'messages', confirm_run: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(check => check.id === 'generation').code, 'output_limit');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2048);
});

test('非流翻译线也受上游输出上限约束:攒包之前就掐断,不是等整包回来再截', async () => {
  // Claude Code 要非流、上游是 responses:响应链会先把上游 SSE 攒进 memorySink。
  // 只在客户端响应端设上限会晚一步(整包已经在内存里了),所以探针在上游 IncomingMessage
  // 上另有一道字节闸门。这里让桩上游慢速写 512KiB,断言它远没写完就被掐断。
  mock.reset('floodSlow');
  const limited = createCompatibilityTester({
    attemptDeps, limits: { total_ms: 8000, per_check_ms: 3000, output_bytes: 2048, result_bytes: 2048 },
  });
  const result = await limited.test({
    provider: makeProvider({ wire_api: 'responses' }), app: 'claude', model: 'mock-model',
    key_id: 'k1', client_wire: 'messages', confirm_run: true,
  });
  // 给服务端一拍时间观察到 socket 断开。
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(check => check.id === 'generation').code, 'output_limit');
  assert.ok(mock.maxFlood < 64 * 1024,
    `上游应在上限附近被掐断，实际单请求写入了 ${mock.maxFlood} 字节`);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2048);
});

test('结果大小有硬上限:超长 model 名也会被裁剪', async () => {
  mock.reset();
  const limited = createCompatibilityTester({ attemptDeps, limits: { result_bytes: 2048 } });
  const longModel = 'm'.repeat(4000);
  const result = await limited.test({
    provider: makeProvider(), app: 'claude', model: longModel, key_id: 'k1',
    client_wire: 'messages', confirm_run: true,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2048);
  assert.ok(result.scope.model.length <= 200);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

// ---------------------------------------------------------------- 隔离

test('隔离依赖确实覆盖了注入的 store/会话结算入口', async () => {
  // fixture 里的 storeOf / slotMapOf / settleRequest 全部一调用就抛错;
  // 上面所有链路用例能通过,就证明探针走的是自己的隔离版本。
  mock.reset();
  const result = await normalRun();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(mock.requests.length, 3);
});

test('不碰真实 Key 自动备用状态:即使渠道开了 key_fallback 也是一次都不调用', async () => {
  // 真实 keyFallback 是进程内共享的健康/冷却/粘性表。探针必须换成 noop 替身,
  // 否则一次兼容测试就可能让用户下一次真实请求换号或误恢复账号。
  mock.reset();
  keyFallbackCalls.length = 0;
  const result = await normalRun({ provider: makeProvider({ key_fallback: true }) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(keyFallbackCalls, [], `探针调用了真实 keyFallback: ${keyFallbackCalls.join(',')}`);
});
