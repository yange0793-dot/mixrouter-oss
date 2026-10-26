'use strict';
// 编程兼容性探针:用**真实转发链路**检查一个渠道能否被某类客户端正常使用。
//
// 它回答的不是"端点通不通"(那是 lib/upstream-probe.js 的连通性测试),而是:
//   客户端协议 → 路由/Key 选择 → 上游协议转换 → 客户端拿到的结果,这一整条链在
//   非流生成、流终态、工具调用三件事上是否都成立。
//
// 三条纪律(与产品约束一一对应):
//   1. **必须经实际链路**:每次探测都走 createAttempt + createAttemptRunner +
//      createRequestContext + 注入的 production dispatchResponse。本模块不写协议翻译,
//      也不拿 /v1/models 这种只读端点冒充"模型可用"。
//   2. **与真实会话隔离**:storeOf 只返回本次渠道、slotMap 空表、settleRequest 是 noop、
//      响应归档关闭、Key 自动备用换成替身。探测不写会话绑定、不改真实请求状态、
//      不读真实渠道库/客户端配置,也不会碰 8787/8788 上的现役进程。
//   3. **克制且可解释**:没有显式 confirm_run 一个生成请求都不发;一次 test() 最多
//      3 次真实上游调用(每个检查一次,不重试);有总时限、单检查时限、输出上限和
//      结果大小上限;结果里不含 API Key,也不含上游正文。
//
// 返回的 code 是给控制台/接入向导做判断用的稳定标识,message 是给人看的一句话。
// 上游错误只报状态码与错误分类,**不回显上游正文** —— 正文可能带账号信息,也不能
// 让"上游说了什么"变成兼容性结论本身。

const { EventEmitter } = require('node:events');
const { ENDPOINTS } = require('./routing/endpoints');
const { protoError } = require('./http/proto-error');
const { activeKeyId, resolveKey } = require('./routing/keys');
const wireResponses = require('./wire-responses');
const { createAttempt } = require('./proxy/attempt');
const { createAttemptRunner } = require('./proxy/attempts');
const { createRequestContext } = require('./proxy/context');

const PROBE_TOOL_NAME = 'mixrouter_probe';
const PROBE_TOOL_DESCRIPTION = 'Echo back the provided value. This tool performs no side effects; mixrouter only inspects the call.';
const PROBE_TOOL_SCHEMA = Object.freeze({
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
});
const PROBE_UA = 'mixrouter-compat-probe/1.0';

// 默认限额。总时限要够三次"最慢的合法生成"跑完,但也不能让一个卡死的渠道把控制台
// 拖到用户以为页面挂了。输出上限按 token 换算足够大(32 个 token 的探针响应不可能
// 接近 256KiB),它的作用是挡住"上游无视 max_tokens 一直吐"这类病态情况。
const DEFAULT_LIMITS = Object.freeze({
  total_ms: 90000,
  per_check_ms: 30000,
  output_bytes: 262144,
  result_bytes: 65536,
});
const LIMIT_BOUNDS = Object.freeze({
  total_ms: [1000, 600000],
  per_check_ms: [100, 300000],
  output_bytes: [256, 4 * 1024 * 1024],
  result_bytes: [512, 256 * 1024],
});

const CHECK_IDS = ['authentication', 'generation', 'stream', 'tools'];
const EP_BY_CLIENT = {
  messages: ENDPOINTS.find(e => e.kind === 'messages'),
  responses: ENDPOINTS.find(e => e.kind === 'responses'),
  chat: ENDPOINTS.find(e => e.kind === 'chat/completions'),
};
// app 决定客户端本体,client_wire 只描述这次连接要落到哪种上游:
//   · Claude Code 对路由永远说 Anthropic Messages;
//   · Codex 对路由说 OpenAI Responses(哪怕渠道 wire_api=chat,也是 Responses→chat 翻译);
//   · ZCode 按自己配置的 kind 说 anthropic / responses / chat。
// 所以 "Codex Responses→chat" 与 "ZCode chat→chat" 是两条不同的链路,必须靠 app 区分。
// readiness-api 因此需要把 body.app 一起传下来;缺省时按 claude/codex 处理仍然安全。
function resolveClientApp(app, raw) {
  if (app === 'claude') {
    const value = raw === undefined || raw === '' ? 'messages' : raw;
    if (typeof value !== 'string' || !['messages', 'anthropic', 'responses', 'chat'].includes(value))
      return { error: 'client_wire 必须是 messages / anthropic / responses / chat' };
    return { group: 'claude', clientWire: 'messages', scopeApp: 'claude' };
  }
  if (app === 'codex') {
    // Codex 客户端永远说 Responses。wire 选 chat 表示"上游是 chat 渠道",
    // 由 production 的 Responses→Chat 转换链负责;客户端协议不变。
    const value = raw === undefined || raw === '' ? 'responses' : raw;
    if (value === 'responses' || value === 'chat')
      return { group: 'codex', clientWire: 'responses', scopeApp: 'codex' };
    return { error: 'codex 组的 client_wire 只能是 responses 或 chat' };
  }
  if (app === 'zcode') {
    if (raw === undefined || raw === '') return { error: 'zcode 必须显式指定 client_wire（anthropic / responses / chat）' };
    if (raw === 'anthropic' || raw === 'messages')
      return { group: 'claude', clientWire: 'messages', scopeApp: 'zcode' };
    if (raw === 'responses') return { group: 'codex', clientWire: 'responses', scopeApp: 'zcode' };
    if (raw === 'chat') return { group: 'codex', clientWire: 'chat', scopeApp: 'zcode' };
    return { error: 'zcode 的 client_wire 必须是 anthropic / responses / chat' };
  }
  return { error: 'app 必须是 claude、codex 或 zcode' };
}
const PROMPTS = {
  generation: 'Reply with exactly this word and nothing else: PONG',
  stream: 'Reply with the numbers 1 2 3 4 5 separated by single spaces.',
  tools: `Call the ${PROBE_TOOL_NAME} tool exactly once with {"value":"ok"}. Do not reply with text.`,
};

// createAttempt 需要的注入项。生产装配给的是 mixrouter.js 里同一个对象;
// 这里列出来只做启动期校验,缺项时尽早报错,而不是等到某条协议分支才 TypeError。
const REQUIRED_FUNCTIONS = [
  'storeOf', 'slotMapOf', 'wireOf', 'upstreamPathOf', 'joinUpstreamPath',
  'buildUpstreamHeaders', 'buildOpenAiHeaders', 'applyModel', 'safeHeader', 'hasCtlChar',
  'transportAgent', 'createResponseArchive', 'channelSecrets', 'clientToken',
  'errorClass', 'retryableStatus', 'sha256',
  'convCacheKey', 'convCacheGen', 'rotateConvCacheGen', 'firstHeaderTimeoutFor',
  'dispatchResponse',
];

const clipText = (value, max) => String(value === undefined || value === null ? '' : value)
  .replace(/[\r\n\t]+/g, ' ').slice(0, max);
const PARSE_FAIL = Symbol('parse-fail');
const parseJson = text => {
  try { return JSON.parse(text); } catch { return PARSE_FAIL; }
};
const headerValue = headers => {
  const h = headers || {};
  return String(h['content-type'] || h['Content-Type'] || '');
};
const isSseHeaders = headers => /text\/event-stream/i.test(headerValue(headers));

function normalizeLimits(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const pick = (value, fallback, [min, max]) => Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : fallback;
  return {
    total_ms: pick(input.total_ms, DEFAULT_LIMITS.total_ms, LIMIT_BOUNDS.total_ms),
    per_check_ms: pick(input.per_check_ms, DEFAULT_LIMITS.per_check_ms, LIMIT_BOUNDS.per_check_ms),
    output_bytes: pick(input.output_bytes, DEFAULT_LIMITS.output_bytes, LIMIT_BOUNDS.output_bytes),
    result_bytes: pick(input.result_bytes, DEFAULT_LIMITS.result_bytes, LIMIT_BOUNDS.result_bytes),
  };
}

function assertAttemptDeps(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('createCompatibilityTester 需要 attemptDeps');
  const missing = REQUIRED_FUNCTIONS.filter(key => typeof deps[key] !== 'function');
  if (!deps.http || typeof deps.http.request !== 'function') missing.push('http');
  if (!deps.https || typeof deps.https.request !== 'function') missing.push('https');
  if (!deps.wireOpenai || typeof deps.wireOpenai.responsesToChat !== 'function') missing.push('wireOpenai');
  if (!deps.wireChat || typeof deps.wireChat.anthropicToChat !== 'function') missing.push('wireChat');
  if (!deps.wireResponses || typeof deps.wireResponses.anthropicToResponses !== 'function') missing.push('wireResponses');
  if (!deps.sessionConfig || typeof deps.sessionConfig.selectSessionKey !== 'function') missing.push('sessionConfig');
  if (!deps.compactLib || typeof deps.compactLib.hasKeyPin !== 'function') missing.push('compactLib');
  if (!deps.toolFilter || typeof deps.toolFilter.apply !== 'function') missing.push('toolFilter');
  if (missing.length) throw new TypeError(`attemptDeps 缺少必需依赖: ${missing.join(', ')}`);
}

// ---------------------------------------------------------------- 请求构造

function anthropicTool() {
  return { name: PROBE_TOOL_NAME, description: PROBE_TOOL_DESCRIPTION, input_schema: PROBE_TOOL_SCHEMA };
}
function responsesTool() {
  return { type: 'function', name: PROBE_TOOL_NAME, description: PROBE_TOOL_DESCRIPTION,
    parameters: PROBE_TOOL_SCHEMA, strict: false };
}
function chatTool() {
  return { type: 'function', function: { name: PROBE_TOOL_NAME, description: PROBE_TOOL_DESCRIPTION,
    parameters: PROBE_TOOL_SCHEMA } };
}

// 客户端协议决定请求形状;上游协议由渠道决定,转换发生在 production 响应链里。
function buildRequestBody(clientWire, model, check) {
  const prompt = PROMPTS[check];
  if (clientWire === 'messages') {
    const body = {
      model,
      // 工具探测给足预算:思考型模型会先花一截 token 再发 tool_use,32/64 的预算
      // 会把"模型愿意调工具"误判成"没调工具"。上限仍由 output_bytes 保护。
      max_tokens: check === 'tools' ? 256 : 32,
      stream: check === 'stream',
      messages: [{ role: 'user', content: prompt }],
    };
    if (check === 'tools') {
      body.tools = [anthropicTool()];
      body.tool_choice = { type: 'tool', name: PROBE_TOOL_NAME };
    }
    return body;
  }
  if (clientWire === 'responses') {
    const body = {
      model,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      max_output_tokens: check === 'tools' ? 512 : 48,
      stream: check === 'stream',
    };
    if (check === 'tools') {
      body.tools = [responsesTool()];
      body.tool_choice = { type: 'function', name: PROBE_TOOL_NAME };
    }
    return body;
  }
  const body = {
    model,
    max_tokens: check === 'tools' ? 512 : 32,
    stream: check === 'stream',
    messages: [{ role: 'user', content: prompt }],
  };
  if (check === 'tools') {
    body.tools = [chatTool()];
    body.tool_choice = { type: 'function', function: { name: PROBE_TOOL_NAME } };
  }
  return body;
}

function buildPlan({ provider, group, clientWire, model, check }) {
  const ep = EP_BY_CLIENT[clientWire];
  const body = buildRequestBody(clientWire, model, check);
  const req = {
    method: 'POST', url: ep.path,
    headers: { 'content-type': 'application/json', 'user-agent': PROBE_UA, 'anthropic-version': '2023-06-01' },
  };
  const member = { provider, model, weight: 1 };
  const rule = {
    id: 'compat-probe', match: '', provider: provider.id, model, pool: [],
    strategy: 'priority', priority: 0, app: group, when: {}, enabled: true,
  };
  const resolved = {
    rule, provider, model, members: [member], strategy: 'priority',
    slot: '', content: false, ghosts: [],
  };
  return {
    plan: {
      app: group, kind: ep.kind, ep, body, req, modelIn: model,
      ident: { key: `compat:${provider.id}:${model}`, kind: 'probe' },
      label: 'compat-probe', sessionKey: 'compat-probe',
      sessionRouting: { keys: {}, slots: {} },
      resolved, compactPin: false, members: [member],
      target: { member, sticky: false, rebind: false },
      sess: {}, flight: null, selectedKey: null, wasSticky: false,
      // 只给一个候选:本次检查只允许打一次上游。重试策略属于真实请求,不属于探针,
      // 否则一次 500 会被调度层放大成多次真实调用。
      ordered: [member],
    },
    rawLen: Buffer.byteLength(JSON.stringify(body)),
  };
}

function buildEntry(plan, group, rawLen) {
  return {
    ts: new Date().toISOString(), app: group, provider: '', model_in: plan.modelIn, model_out: '',
    session: 'compat-probe', session_kind: 'probe', rule: 'compat-probe', slot: '',
    key_id: '', key_source: '', pool: 1, strategy: 'priority', sticky: false,
    attempts: 0, failover: false, in: 0, out: 0, cache_read: 0,
    bytes_in: rawLen, ms: 0, ttfb_ms: 0, status: 0, stream: !!plan.body.stream,
    kind: plan.ep.kind, wire: '', err: '', err_class: '',
  };
}

// ---------------------------------------------------------------- 内部响应端
// 探针不是 HTTP 客户端,但转发链路要的是一个 res。这里给一个只实现转发链路实际用到的
// 那几个方法的响应端:写头、写块、结束、close 事件,以及有界收集。
// close 仅在超时/超限时由探针自己触发 —— 那会让请求上下文按"客户端已断开"收尾,
// 从而销毁在途上游连接,这是唯一能可靠掐断一条不听话上游的出口。
function createCaptureResponse(limitBytes, onOverflow) {
  const res = new EventEmitter();
  const parts = [];
  let bytes = 0;
  let overflow = false;
  res.headersSent = false;
  res.writableEnded = false;
  res.writableFinished = false;
  res.destroyed = false;
  res.statusCode = 0;
  res.statusHeaders = {};
  res.writeHead = (status, headers) => {
    if (!res.headersSent) {
      res.statusCode = Number(status) || 0;
      res.statusHeaders = headers || {};
      res.headersSent = true;
    }
    return res;
  };
  res.write = chunk => {
    if (res.writableEnded || res.destroyed) return false;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (!overflow) {
      const room = limitBytes - bytes;
      if (buf.length > room) {
        if (room > 0) { parts.push(buf.subarray(0, room)); bytes += room; }
        overflow = true;
        onOverflow();
      } else {
        parts.push(buf);
        bytes += buf.length;
      }
    }
    return true;
  };
  res.end = chunk => {
    if (chunk !== undefined) res.write(chunk);
    res.writableEnded = true;
    res.writableFinished = true;
    return res;
  };
  res.text = () => Buffer.concat(parts).toString('utf8');
  res.truncated = () => overflow;
  return res;
}

// ---------------------------------------------------------------- 单次探测

function runProbe({ runAttempts, guard, provider, group, clientWire, model, check, budget, limits }) {
  return new Promise(resolve => {
    const started = Date.now();
    const { plan, rawLen } = buildPlan({ provider, group, clientWire, model, check });
    const entry = buildEntry(plan, group, rawLen);
    let limitReason = '';
    let resolved = false;
    let scheduled = false;
    let finalEntry = entry;
    let hardTimer = null;

    const deliver = () => {
      if (resolved) return;
      resolved = true;
      if (guard) guard.onLimit = null;
      if (hardTimer) clearTimeout(hardTimer);
      resolve({
        started, entry: finalEntry, status: adapter.statusCode,
        headers: adapter.statusHeaders, text: adapter.text(), limitReason,
      });
    };
    // 有的响应分支先写终态、再 res.end(整包 JSON 就是 finishEntry 后才 end)。
    // 推迟到当前调用栈之后再取正文,否则会把最后一段 JSON 漏掉。
    const finish = finished => {
      finalEntry = finished;
      if (scheduled) return;
      scheduled = true;
      if (hardTimer) clearTimeout(hardTimer);
      setImmediate(deliver);
    };
    const adapter = createCaptureResponse(limits.output_bytes, () => {
      if (!limitReason) limitReason = 'output_limit';
      setImmediate(abort);
    });
    function abort() {
      if (resolved || scheduled) return;
      try {
        adapter.destroyed = true;
        adapter.emit('close');
      } catch { /* 已经断开的响应端不需要再收尾 */ }
    }
    // 上游字节超限与客户端输出超限是同一个结论:这一次检查被 output_bytes 截断。
    if (guard) guard.onLimit = () => {
      if (!limitReason) limitReason = 'output_limit';
      setImmediate(abort);
    };

    // 总时限的兜底:正常的 ctx deadline 会先给出 504,这里只防"某条分支再也不回调"。
    // 留 300ms 余量给 ctx 自己的 deadline 定时器先走完,别让兜底抢在它前面改写结论。
    hardTimer = setTimeout(() => {
      if (resolved || scheduled) return;
      if (!limitReason) limitReason = 'time_limit';
      abort();
      const fallback = setTimeout(deliver, 120);
      if (fallback.unref) fallback.unref();
    }, budget + 300);
    if (hardTimer.unref) hardTimer.unref();

    try {
      const ctx = createRequestContext({
        res: adapter, entry, started, rawLen, archiveRequestId: '',
        totalDeadlineMs: budget, maxAttempts: 1, convRetries: 0, sseKeepAliveMs: 0,
        protoError, app: group,
        onFinish: finish,
      });
      runAttempts(plan, ctx);
    } catch {
      // 已经结算过的请求不要被"调度层抛了"改写成内部错误:那会把真实结果抹掉。
      if (!limitReason && !scheduled) limitReason = 'internal_error';
      finish(entry);
    }
  });
}

// ---------------------------------------------------------------- 结果判定

function pass(code, message, ms) { return { status: 'pass', code, message, ms }; }
function fail(code, message, ms) { return { status: 'fail', code, message, ms }; }

function statusMessage(status, cls) {
  return `上游返回 HTTP ${status}${cls ? `（${cls}）` : ''}`;
}

function sseEvents(text) {
  try { return wireResponses.parseSseEvents(String(text || '')).events; }
  catch { return []; }
}
function hasDoneFrame(text) {
  return /(^|\n)data:\s*\[DONE\]\s*(?:\r?\n|$)/.test(String(text || ''));
}
function streamHasError(wire, events) {
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'error' || event.error) return true;
    if (wire === 'responses' && (event.type === 'response.failed'
      || (event.response && (event.response.status === 'failed' || event.response.status === 'cancelled')))) return true;
  }
  return false;
}
function streamHasTerminal(wire, events, text) {
  if (wire === 'chat') {
    if (hasDoneFrame(text)) return true;
    return events.some(e => Array.isArray(e.choices)
      && e.choices.some(choice => choice && choice.finish_reason));
  }
  if (wire === 'responses')
    return events.some(e => e.type === 'response.completed' || e.type === 'response.incomplete');
  return events.some(e => e.type === 'message_stop');
}

// 客户端实际收到的形状由客户端协议决定,与上游协议无关(messages/responses/chat)。
function validateGeneration(clientWire, text, ms) {
  const json = parseJson(text);
  if (json === PARSE_FAIL || !json || typeof json !== 'object' || Array.isArray(json))
    return fail('invalid_response', '响应不是可解析的 JSON 结果', ms);
  if (json.error) return fail('upstream_error', '上游以 HTTP 200 返回了错误结果', ms);
  if (clientWire === 'messages') {
    if (!Array.isArray(json.content)) return fail('invalid_response', '响应缺少 Anthropic content 数组', ms);
    const said = json.content.some(block => block && typeof block === 'object'
      && ((block.type === 'text' && typeof block.text === 'string' && block.text.trim())
        || (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim())));
    return said ? pass('generation_ok', '收到完整非流生成结果', ms)
      : fail('empty_generation', '生成结果没有文本内容', ms);
  }
  if (clientWire === 'responses') {
    if (json.status === 'failed' || json.status === 'cancelled')
      return fail('upstream_error', '上游以失败状态结束了响应', ms);
    if (!Array.isArray(json.output)) return fail('invalid_response', '响应缺少 Responses output 数组', ms);
    const said = json.output.some(item => item && item.type === 'message' && Array.isArray(item.content)
      && item.content.some(part => part && part.type === 'output_text'
        && typeof part.text === 'string' && part.text.trim()));
    return said ? pass('generation_ok', '收到完整非流生成结果', ms)
      : fail('empty_generation', '生成结果没有文本内容', ms);
  }
  const message = json.choices && json.choices[0] && json.choices[0].message;
  if (!message || typeof message !== 'object')
    return fail('invalid_response', '响应缺少 Chat choices[0].message', ms);
  const said = (typeof message.content === 'string' && message.content.trim())
    || (typeof message.reasoning_content === 'string' && message.reasoning_content.trim());
  return said ? pass('generation_ok', '收到完整非流生成结果', ms)
    : fail('empty_generation', '生成结果没有文本内容', ms);
}

function toolArgsProblem(input) {
  return !input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.value !== 'string';
}

function validateTools(clientWire, text, ms) {
  const json = parseJson(text);
  if (json === PARSE_FAIL || !json || typeof json !== 'object' || Array.isArray(json))
    return fail('invalid_response', '响应不是可解析的 JSON 结果', ms);
  if (json.error) return fail('upstream_error', '上游以 HTTP 200 返回了错误结果', ms);
  let name = '';
  let input = null;
  if (clientWire === 'messages') {
    const blocks = Array.isArray(json.content) ? json.content : [];
    const block = blocks.find(b => b && b.type === 'tool_use');
    if (!block) return fail('tool_not_called', `模型没有调用 ${PROBE_TOOL_NAME} 工具`, ms);
    name = block.name;
    input = block.input;
  } else if (clientWire === 'responses') {
    if (!Array.isArray(json.output)) return fail('invalid_response', '响应缺少 Responses output 数组', ms);
    // 我们声明的是 function 工具,合规返回必须是 function_call。custom_tool_call 是
    // 另一种工具形状(自由文本输入),把它当成通过会掩盖"工具类型被改写"。
    const item = json.output.find(it => it && it.type === 'function_call');
    if (!item) {
      if (json.output.some(it => it && it.type === 'custom_tool_call'))
        return fail('tool_format_mismatch', '工具调用不是 function_call 形状', ms);
      return fail('tool_not_called', `模型没有调用 ${PROBE_TOOL_NAME} 工具`, ms);
    }
    name = item.name;
    const raw = item.arguments;
    input = typeof raw === 'string' ? parseJson(raw) : raw;
    if (input === PARSE_FAIL) return fail('tool_args_invalid', '工具参数不是完整 JSON', ms);
  } else {
    const message = json.choices && json.choices[0] && json.choices[0].message;
    const calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const call = calls.find(c => c && c.function && typeof c.function.name === 'string');
    if (!call) return fail('tool_not_called', `模型没有调用 ${PROBE_TOOL_NAME} 工具`, ms);
    name = call.function.name;
    input = typeof call.function.arguments === 'string'
      ? parseJson(call.function.arguments) : call.function.arguments;
    if (input === PARSE_FAIL) return fail('tool_args_invalid', '工具参数不是完整 JSON', ms);
  }
  if (name !== PROBE_TOOL_NAME)
    return fail('tool_name_mismatch', `工具名不是 ${PROBE_TOOL_NAME}`, ms);
  if (toolArgsProblem(input))
    return fail('tool_args_invalid', `工具参数不是 ${PROBE_TOOL_NAME}({value:string}) 形状`, ms);
  return pass('tool_ok', '工具名与参数形状正确', ms);
}

// err_class 在生产链路里是受控枚举(stream_aborted / protocol_error / network_error …),
// 但结果会直接吐给控制台和测试输出。这里只放行"像分类码"的值:万一将来某条分支把上游
// 文本塞进这个字段,也不会经探针回显出去。
const controlledClass = value => {
  const s = clipText(value, 40);
  return /^[a-z][a-z0-9_]{0,39}$/.test(s) ? s : '';
};

function classifyProbe({ check, clientWire, outcome, limits, ms }) {
  const entry = outcome.entry || {};
  const status = Number(entry.status) || Number(outcome.status) || 0;
  const cls = controlledClass(entry.err_class);
  const text = String(outcome.text || '');
  // 少数网关不回 content-type;正文已出现 SSE 帧行时按流处理,避免把真流误判成 JSON。
  const sse = isSseHeaders(outcome.headers) || /^(?:event|data):/m.test(text);
  const events = sse ? sseEvents(text) : [];

  // 认证/限流/额度是状态码层面的结论,优先于"响应体太大"这类传输层结论:
  // 一个巨大的 403 HTML 页仍然是 403,不能被报成 output_limit。
  if (status === 401) return fail('authentication_rejected', '上游返回 HTTP 401（认证被拒绝）', ms);
  if (status === 403)
    return fail('forbidden', '上游返回 HTTP 403（权限、区域或模型限制），不能判定 Key 失效', ms);
  if (status === 429) return fail('rate_limit', '上游返回 HTTP 429（限流）', ms);
  if (status === 402) return fail('budget_exhausted', '上游返回 HTTP 402（额度不足）', ms);

  if (outcome.limitReason === 'output_limit')
    return fail('output_limit', `响应超过 ${limits.output_bytes} 字节上限，已中止`, ms);
  if (outcome.limitReason === 'time_limit')
    return fail('timeout', `超过单次检查时限（${limits.per_check_ms} ms）`, ms);
  if (outcome.limitReason === 'internal_error')
    return fail('internal_error', '检查过程中出现内部错误', ms);

  if (status === 408 || status === 504) return fail('timeout', '上游在检查时限内没有给出完整响应', ms);

  // 流检查优先按"流有没有给出终态"判定:这是它能与普通 HTTP 失败区分开的地方。
  if (check === 'stream' && sse) {
    if (streamHasError(clientWire, events))
      return fail('stream_error', '上游以错误帧结束了流', ms);
    if (streamHasTerminal(clientWire, events, text)) {
      if (status >= 300) return fail('upstream_error', statusMessage(status, cls), ms);
      return pass('stream_complete', '收到流终态', ms);
    }
    if (status >= 500) return fail('stream_aborted', '上游流在终态前中断', ms);
    if (status >= 400) return fail('upstream_rejected', statusMessage(status, cls), ms);
    return fail('stream_incomplete', '流已结束但缺少终态标记', ms);
  }

  if (status === 499) return fail('cancelled', '响应在完成前被中断', ms);
  if (status >= 500) {
    if (cls === 'network_error' || /^(econn|enotfound|eai_)/i.test(cls))
      return fail('network_error', '无法连接上游（网络错误）', ms);
    if (cls === 'timeout') return fail('timeout', '上游请求超时', ms);
    return fail('upstream_error', statusMessage(status, cls), ms);
  }
  if (status >= 400) return fail('upstream_rejected', statusMessage(status, cls), ms);
  if (!status) return fail('no_response', '没有拿到有效响应', ms);

  if (check === 'generation') return validateGeneration(clientWire, text, ms);
  if (check === 'stream') {
    // 客户端要的是流,上游却整包回了 JSON(或完全没回)。这不是"流结束标记"问题,
    // 而是这条渠道压根没按 stream 工作,单独给一个 code 才好排查。
    if (!sse) return fail('stream_not_sse', '上游返回整包 JSON，不是 SSE 流', ms);
    return fail('stream_incomplete', '流已结束但缺少终态标记', ms);
  }
  return validateTools(clientWire, text, ms);
}

// ---------------------------------------------------------------- 结果组装

function skippedChecks(code, message) {
  return CHECK_IDS.map(id => ({ id, status: 'skipped', code, message, ms: 0 }));
}
function keyChecks(problem) {
  return [
    { id: 'authentication', status: 'fail', code: problem.error, message: problem.message, ms: 0 },
    ...['generation', 'stream', 'tools'].map(id => ({
      id, status: 'skipped', code: 'authentication_unavailable',
      message: '没有可用的 API Key，未发起请求', ms: 0,
    })),
  ];
}

function authVerdict(observations) {
  if (!observations.length || observations.every(o => o.check.status === 'skipped'))
    return { status: 'skipped', code: 'no_calls', message: '未执行任何生成检查' };
  if (observations.some(o => o.status === 401 || o.check.code === 'authentication_rejected'))
    return { status: 'fail', code: 'authentication_rejected', message: '上游以 HTTP 401 拒绝了凭据' };
  if (observations.some(o => o.check.status === 'pass'))
    return { status: 'pass', code: 'verified', message: '有效生成结果证明凭据可用' };
  if (observations.some(o => o.status === 403 || o.check.code === 'forbidden'))
    return { status: 'unknown', code: 'forbidden',
      message: '上游返回 HTTP 403（权限、区域或模型限制），不能据此判定 Key 失效' };
  return { status: 'unknown', code: 'unverified', message: '没有拿到有效生成结果，无法判定凭据是否可用' };
}

function finalizeResult(result, limits) {
  const out = {
    ok: false,
    checked_at: result.checked_at || new Date().toISOString(),
    scope: {
      app: clipText(result.scope && result.scope.app, 16),
      client_wire: clipText(result.scope && result.scope.client_wire, 16),
      wire_api: clipText(result.scope && result.scope.wire_api, 16),
      model: clipText(result.scope && result.scope.model, 200),
      key_id: clipText(result.scope && result.scope.key_id, 120),
    },
    checks: (result.checks || []).map(c => ({
      id: c.id,
      status: c.status,
      code: clipText(c.code, 64),
      message: clipText(c.message, 400),
      ms: Math.max(0, Math.round(Number(c.ms) || 0)),
    })),
    ms: Math.max(0, Math.round(Number(result.ms) || 0)),
  };
  // ok 只由四项检查的实际结论决定:派生出来的 authentication 也必须在里面。
  out.ok = out.checks.length === CHECK_IDS.length && out.checks.every(c => c.status === 'pass');
  if (Buffer.byteLength(JSON.stringify(out)) <= limits.result_bytes) return out;

  // 结果大小上限是硬约束(它会进控制台响应)。正常结果远小于默认 64KiB;
  // 这里兜的是调用方把上限调小、或 model/key_id 异常长的情况。
  for (const check of out.checks) check.message = clipText(check.message, 120);
  out.scope.model = clipText(out.scope.model, 64);
  out.scope.key_id = clipText(out.scope.key_id, 32);
  if (Buffer.byteLength(JSON.stringify(out)) <= limits.result_bytes) return out;
  for (const check of out.checks) check.message = '';
  if (Buffer.byteLength(JSON.stringify(out)) <= limits.result_bytes) return out;
  return {
    ok: false, checked_at: out.checked_at, scope: out.scope,
    checks: out.checks.map(c => ({ id: c.id, status: c.status, code: 'result_too_large', message: '', ms: c.ms })),
    ms: out.ms,
  };
}

function checkProviderProblem(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider))
    return 'provider 必须是渠道对象';
  if (typeof provider.id !== 'string' || !provider.id.trim()) return 'provider.id 必须是非空字符串';
  if (typeof provider.base_url !== 'string' || !provider.base_url.trim()) return 'provider.base_url 必须是非空字符串';
  let url;
  try { url = new URL(provider.base_url); }
  catch { return 'provider.base_url 不是合法的 URL'; }
  if (!['http:', 'https:'].includes(url.protocol)) return 'provider.base_url 必须是 http(s) URL';
  if (url.username || url.password) return 'provider.base_url 不能包含凭据';
  return null;
}

// 选 Key 只读传入的渠道对象,不碰渠道库。指定了 key_id 就必须能解析出唯一一把;
// 否则宁可明确报 Key 不可用,也不能悄悄退回 active_key —— 那样测的就不是用户指定的账号。
function chooseKey(provider, requested, hasCtlChar) {
  const ring = Array.isArray(provider.keys) ? provider.keys : null;
  if (ring && ring.length) {
    const id = requested || activeKeyId(provider);
    const selected = resolveKey(provider, id);
    if (!selected) return { error: 'key_unavailable', message: '指定的 Key 不存在、重复、已停用或不可用' };
    return { id, key: selected.key };
  }
  const legacy = typeof provider.api_key === 'string' ? provider.api_key : '';
  if (requested && requested !== 'klegacy')
    return { error: 'key_unavailable', message: '指定的 Key 不存在、重复、已停用或不可用' };
  if (!legacy.trim()) return { error: 'missing_credential', message: '渠道未配置可用的 API Key' };
  if (typeof hasCtlChar === 'function' && hasCtlChar(legacy))
    return { error: 'key_unavailable', message: 'API Key 含换行或控制字符' };
  return { id: requested || 'klegacy', key: legacy };
}

// 上游侧的字节闸门。客户端响应端只能挡住"已经交给客户端"的字节;翻译线的非流分支
// 会先把上游流攒进 memorySink 再回整包,只看客户端响应会晚一步。这里在 dispatch 之前
// 给上游 IncomingMessage 挂一个计数监听:超过上限就掐断上游,内存与时间都被封顶。
// 它不改变任何分支的消费方式(所有分支本来就会读流),只多一个提前退出的出口。
function guardDispatch(dispatchResponse, guard) {
  return function dispatchWithOutputLimit(a) {
    const cres = a && a.cres;
    if (!cres || typeof cres.on !== 'function') return dispatchResponse(a);
    let bytes = 0;
    let tripped = false;
    const cleanup = () => cres.removeListener('data', onData);
    function onData(chunk) {
      if (tripped) return;
      bytes += chunk.length;
      if (bytes <= guard.outputBytes) return;
      tripped = true;
      if (typeof guard.onLimit === 'function') {
        try { guard.onLimit(); } catch { /* 限额回调不该影响收尾 */ }
      }
      try { cres.destroy(new Error('compat probe output limit')); } catch {}
      cleanup();
    }
    cres.on('data', onData);
    cres.once('end', cleanup);
    cres.once('close', cleanup);
    cres.once('error', cleanup);
    return dispatchResponse(a);
  };
}

// 自动备用 Key 的替身。真实实例持有本进程内的失败诊断记录与粘性,探针哪怕只
// 调一次 failure()/success() 也会改动它的记录 —— 一次兼容测试不该让用户下次真实请求
// 换号或恢复账号。这里给的是"渠道未开启 key_fallback"时逐字相同的返回形状:
// select 原样返回选择结果、failure 不记不换、success 不恢复、list 空表、reset noop。
const NOOP_KEY_FALLBACK = Object.freeze({
  select: keyChoice => keyChoice,
  failure: () => ({ switchable: false, scope: 'none', wait_ms: 0 }),
  success: () => ({ restored: false }),
  list: () => [],
  reset: () => {},
});

// 每次 test() 建一套隔离依赖:只认识本次渠道、空槽表、会话结算是 noop、
// Key 自动备用是替身、归档关闭。attempt 会重新查一次 store(活配置语义),所以这里必须
// 返回同一个对象,而不是把 provider 快照进计划就完事。
function buildRunner(attemptDeps, provider, guard) {
  const deps = {
    ...attemptDeps,
    storeOf: () => [provider],
    slotMapOf: () => ({ claude: {}, codex: {} }),
    settleRequest: () => {},
    keyFallback: NOOP_KEY_FALLBACK,
    responseArchiveOn: false,
    responseArchiveDir: '',
    dispatchResponse: guardDispatch(attemptDeps.dispatchResponse, guard),
  };
  const { runAttempt } = createAttempt(deps);
  return { runAttempts: createAttemptRunner({ runAttempt, convRetries: 0, retryDelayMs: 0 }).runAttempts };
}

async function runTest(attemptDeps, limits, input) {
  const startedAt = Date.now();
  const scope = {
    app: '', client_wire: '', wire_api: '',
    model: clipText(input.model, 200), key_id: clipText(input.key_id, 120),
  };
  const now = () => new Date(startedAt).toISOString();
  const invalid = (code, message) => finalizeResult({
    ok: false, checked_at: now(), scope, checks: skippedChecks(code, message), ms: Date.now() - startedAt,
  }, limits);

  const resolvedApp = resolveClientApp(input.app, input.client_wire);
  if (resolvedApp.error) return invalid('invalid_request', resolvedApp.error);
  const group = resolvedApp.group;
  const clientWire = resolvedApp.clientWire;
  scope.app = resolvedApp.scopeApp;
  scope.client_wire = clientWire;

  const problem = checkProviderProblem(input.provider);
  if (problem) return invalid('invalid_request', problem);
  if (typeof input.model !== 'string' || !input.model.trim() || /[\x00-\x1f\x7f]/.test(input.model))
    return invalid('invalid_request', 'model 必须是非空字符串');
  if (input.key_id !== undefined && (typeof input.key_id !== 'string' || /[\x00-\x1f\x7f]/.test(input.key_id)))
    return invalid('invalid_request', 'key_id 必须是字符串');
  scope.model = clipText(input.model, 200);

  let wire = '';
  try { wire = attemptDeps.wireOf(input.provider, group); } catch { wire = ''; }
  if (!['anthropic', 'responses', 'chat'].includes(wire))
    return invalid('invalid_request', '无法确定渠道的上游协议');
  scope.wire_api = wire;
  if (group === 'codex' && clientWire === 'chat' && wire !== 'chat')
    return invalid('wire_api_mismatch', 'chat 客户端只能落到 wire_api=chat 的渠道');

  // 确认闸门在选 Key 之前:没有显式确认时连 Key 都不需要解析,更不会发任何生成请求。
  if (input.confirm_run !== true)
    return invalid('confirmation_required', '兼容探针会发起真实生成请求，需显式传 confirm_run:true');

  const key = chooseKey(input.provider, input.key_id, attemptDeps.hasCtlChar);
  if (key.error) return finalizeResult({
    ok: false, checked_at: now(), scope, checks: keyChecks(key), ms: Date.now() - startedAt,
  }, limits);
  scope.key_id = clipText(key.id, 120);
  // key_fallback 强制关闭:探针要回答"我指定的这把 Key / 这个账号能不能用",
  // 自动换号会让 scope.key_id 说谎,也会把一次检查变成多次真实上游调用。
  const probeProvider = { ...input.provider, active_key: key.id, api_key: key.key, key_fallback: false };
  const guard = { outputBytes: limits.output_bytes, onLimit: null };
  const { runAttempts } = buildRunner(attemptDeps, probeProvider, guard);

  const observations = [];
  const deadline = startedAt + limits.total_ms;
  // 顺序固定:非流生成先证明"模型真的能答",再看流终态,最后看工具调用。
  // authentication 不单独发请求,它由这三项的结果反推。
  for (const check of ['generation', 'stream', 'tools']) {
    const remaining = deadline - Date.now();
    if (remaining <= 50) {
      observations.push({ kind: check, status: 0, check: {
        id: check, status: 'skipped', code: 'time_limit', message: '总时限已用尽', ms: 0,
      } });
      continue;
    }
    const budget = Math.min(limits.per_check_ms, remaining);
    const outcome = await runProbe({
      runAttempts, guard, provider: probeProvider, group, clientWire,
      model: input.model, check, budget, limits,
    });
    const ms = Math.max(0, Date.now() - outcome.started);
    const verdict = classifyProbe({ check, clientWire, outcome, limits, ms });
    observations.push({
      kind: check,
      status: Number(outcome.entry && outcome.entry.status) || 0,
      check: { id: check, ...verdict, ms },
    });
  }

  const checks = [
    { id: 'authentication', ...authVerdict(observations), ms: 0 },
    ...observations.map(o => o.check),
  ];
  return finalizeResult({
    ok: false, checked_at: now(), scope, checks, ms: Date.now() - startedAt,
  }, limits);
}

// ---------------------------------------------------------------- 对外

function createCompatibilityTester(options = {}) {
  const { attemptDeps, limits: rawLimits } = options || {};
  assertAttemptDeps(attemptDeps);
  const limits = normalizeLimits(rawLimits);
  return {
    // 并发安全:每次调用都建自己的隔离依赖与响应端,不共享游标/计时器/结果缓冲。
    test: input => runTest(attemptDeps, limits, input && typeof input === 'object' ? input : {}),
  };
}

module.exports = { createCompatibilityTester, DEFAULT_LIMITS, PROBE_TOOL_NAME };
