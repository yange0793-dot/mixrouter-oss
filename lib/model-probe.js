'use strict';
// 模型级测活:对**每一个模型名**各发一次最小真实生成请求,回答"这个模型现在能不能用"。
//
// 与渠道连通性测试(lib/provider-test.js)的分工:
//   · 渠道测试只探"这个渠道通不通",Claude 线拿 models[0] 发一次、OpenAI 线只 GET /v1/models;
//     它的结论是渠道级的,一个坏模型会让整张卡片变红,而其余模型其实是好的。
//   · 这里按模型逐个发**该渠道自己的协议**(anthropic / responses / chat),每个模型一次请求、
//     不重试、不切换渠道,结论逐模型给出。模型名带 [1M] 后缀时照样剥掉并补 beta 头。
//
// 纪律:
//   · 只读:不改渠道库、不写客户端配置、不落盘、不写请求日志。
//   · 结果里**不含 API Key**,也不整段回显上游正文 —— 上游常把凭据写进报错。
//     只从正文里抠一句原因,消洗控制字符、截断,并把 Key 本体替换成 ***。
//   · 每个模型一条连接,并发有上限;总时限只约束单个模型,不让一个卡死的模型拖住整批太久。
//   · 判活看状态码 2xx **且**正文不是错误壳:有的网关回 200 + {"error":…}(模型下线、额度不足),
//     只看状态码会把它报成"可用"。

const { probe, DEFAULT_UA } = require('./upstream-probe');
const { joinUpstreamPath } = require('./routing/endpoints');
const { applyModel } = require('./model-suffix');
const { reasonOf } = require('./net-reason');
const { upstreamErrorText } = require('./upstream-error-text');

// OpenAI 协议端点的兜底 UA(与 mixrouter.js 的 DEFAULT_UA_CODEX 同值;非 codex 客户端没带 UA 时用)
const DEFAULT_UA_CODEX = 'codex_cli_rs/0.154.0 (external, cli)';
const WIRES = ['anthropic', 'responses', 'chat'];
// 单模型时限。20 秒对快的网关够,但带推理的模型(思考 token 不吃 max_tokens 之外的时间)
// 首字常常就要十几秒;2026-10-28 实测一个渠道上的 glm-5.3-flash 60 秒仍无首字 —— 那是它真慢,
// 但把 20 秒当默认会把"慢而可用"也判死。30 秒是"够慢模型表态"与"控制台别久等"的折中;
// 要更宽松就显式传 timeout_ms。
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const TIMEOUT_BOUNDS = [1000, 60000];
const DEFAULT_CONCURRENCY = 4;
// 判活只要"能生成出东西",不需要长回答;但**不能给小**:
// 2026-10-28 实测 wududu 的 deepseek-v4.1-flash,max_tokens=16 时推理 token 就吃光了预算,
// 上游回 500 `empty response content` —— 一个完全可用的模型被判成故障。给 64 就正常。
// 128 给足推理模型的余量,代价仍可忽略(十几 token 的输入)。
const PROBE_MAX_TOKENS = 128;
// 正文上限:错误壳是一小段 JSON,但网关常在前面缀上说明文字,300 字会把它截断成解析失败
const PROBE_BODY_MAX = 8192;
const ERROR_TEXT_MAX = 160;
const MODEL_NAME_MAX = 200;

// 带状态的配置错误:控制台按 status 回包,CLI 直接打印 message。
class ModelProbeError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ModelProbeError';
    this.status = status;
  }
}

// 渠道自己的上游协议。缺省 anthropic(与 lib/routing/endpoints.js 的 wireOf 同口径):
// 标了 responses / chat 的渠道由本机现场翻译,测活时也按它去说上游的语言。
const wireOfProvider = provider => {
  const wire = provider && provider.wire_api;
  return wire === 'responses' || wire === 'chat' ? wire : 'anthropic';
};

// 渠道登记过的模型名:先去重,再按"列表里没有默认模型就补上"的顺序。
// Claude 组第一项是主模型,顺序必须保留;Codex 组的默认模型在 provider.model 上。
function modelsOf(provider) {
  const out = [];
  const seen = new Set();
  const push = value => {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > MODEL_NAME_MAX || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  for (const m of (provider && Array.isArray(provider.models) ? provider.models : [])) push(m);
  if (provider) push(provider.model);
  return out;
}

const clampTimeout = value => {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(TIMEOUT_BOUNDS[1], Math.max(TIMEOUT_BOUNDS[0], Math.trunc(value)));
};

// 上游正文只取一句原因:控制字符压成空格、截断,并把 Key 本体替换掉(上游可能原样回显请求头)。
function sanitizeReason(text, apiKey) {
  let s = String(text == null ? '' : text);
  // split/join 而不是 RegExp:Key 里可能有正则元字符
  if (apiKey && s.includes(apiKey)) s = s.split(apiKey).join('***');
  s = s.replace(/[\x00-\x1F\x7F]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, ERROR_TEXT_MAX);
}

// 2xx 也要看正文:错误壳({error:…} 或 {type:'error'})说明上游其实拒绝了这次调用。
function bodyErrorOf(body) {
  const text = String(body || '');
  if (!text.trim()) return '';
  let json;
  try { json = JSON.parse(text); } catch { return ''; }   // 非 JSON 的 2xx 正文不当作错误
  if (!json || typeof json !== 'object') return '';
  if (!json.error && json.type !== 'error') return '';
  return upstreamErrorText(text);
}

function endpointOf(baseUrl) {
  let u;
  try { u = new URL(String(baseUrl == null ? '' : baseUrl)); }
  catch { throw new ModelProbeError(400, 'base_url 必须是合法的 http(s) URL,如 https://api.example.com'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new ModelProbeError(400, 'base_url 只支持 http 或 https');
  if (u.username || u.password)
    throw new ModelProbeError(400, 'base_url 不能包含用户名或密码,凭据请填在 API Key 里');
  return {
    protocol: u.protocol,
    // IPv6 的 u.hostname 带方括号,交给 request 会 ENOTFOUND(与 lib/provider-models.js 同一处理)
    hostname: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    pathname: u.pathname,
  };
}

function buildRequest({ wire, provider, target, model, key }) {
  // applyModel 会就地改 headers(剥 [1M] 后缀 + 补 anthropic-beta)。headers 必须先建好再传,
  // 传字面量 {} 等于改完即丢 —— 渠道探活早先就是这么踩的(见 lib/model-suffix.js 文件头)。
  if (wire === 'anthropic') {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-api-key': key, 'Authorization': 'Bearer ' + key,
      'User-Agent': provider.ua || DEFAULT_UA, 'anthropic-version': '2023-06-01',
    };
    const body = JSON.stringify({
      model: applyModel(model, headers), max_tokens: PROBE_MAX_TOKENS,
      messages: [{ role: 'user', content: 'ping' }],
    });
    headers['Content-Length'] = Buffer.byteLength(body);
    return { path: joinUpstreamPath(target.pathname, '/v1/messages'), headers, body };
  }
  // OpenAI 两条线不带 anthropic-*:把 beta 头挂在只用于剥离后缀的临时对象上,发出去的是空对象里的东西
  const betaOnly = {};
  const plainModel = applyModel(model, betaOnly);
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': 'Bearer ' + key,
    'User-Agent': provider.ua || DEFAULT_UA_CODEX,
  };
  const path = wire === 'chat'
    ? joinUpstreamPath(target.pathname, '/v1/chat/completions')
    : joinUpstreamPath(target.pathname, '/v1/responses');
  const payload = wire === 'chat'
    ? { model: plainModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: PROBE_MAX_TOKENS, stream: false }
    : { model: plainModel, input: 'ping', max_output_tokens: PROBE_MAX_TOKENS, stream: false };
  const body = JSON.stringify(payload);
  headers['Content-Length'] = Buffer.byteLength(body);
  return { path, headers, body };
}

// 单模型一次测活。配置错误(坏 base_url / 没 Key)抛 ModelProbeError;网络与上游错误进返回值。
async function probeModel({ provider, model, key, wire, timeoutMs } = {}) {
  const p = provider || {};
  const name = String(model == null ? '' : model).trim();
  if (!name) throw new ModelProbeError(400, '模型名不能为空');
  if (name.length > MODEL_NAME_MAX) throw new ModelProbeError(400, '模型名过长');
  const apiKey = String(key == null ? '' : key).trim();
  if (!apiKey) throw new ModelProbeError(400, '缺少可用的 API Key');
  const target = endpointOf(p.base_url);
  const useWire = WIRES.includes(wire) ? wire : wireOfProvider(p);
  const req = buildRequest({ wire: useWire, provider: p, target, model: name, key: apiKey });
  const started = Date.now();
  const result = await probe({
    provider: p, protocol: target.protocol, hostname: target.hostname, port: target.port,
    path: req.path, method: 'POST', headers: req.headers, body: req.body,
    timeoutMs: clampTimeout(timeoutMs), bodyMax: PROBE_BODY_MAX,
  });
  const ms = Date.now() - started;
  // 网络层失败:probe 回 { ok:false, error, code }
  if (result.error) {
    if (result.error === 'timeout')
      return { model: name, ok: false, status: null, ms, error: `超时(${Math.round(clampTimeout(timeoutMs) / 1000)} 秒)` };
    // 用 probe 带回的 code 翻译;没有 code 的内部错误(建连截止、隧道)由 reasonOf 按 message 认
    return { model: name, ok: false, status: null, ms, error: reasonOf({ code: result.code, message: result.error }) };
  }
  const status = result.status;
  const bodyErr = result.ok ? bodyErrorOf(result.body) : '';
  if (result.ok && !bodyErr) return { model: name, ok: true, status, ms };
  const detail = sanitizeReason(bodyErr || (result.ok ? '' : upstreamErrorText(result.body)), apiKey);
  return { model: name, ok: false, status, ms, error: detail || `上游返回 HTTP ${status}` };
}

// 一批模型并发测活(默认 4 路)。结果按入参顺序回,便于控制台逐行对应;单个模型失败不影响其余。
async function probeModels({ provider, models, key, wire, timeoutMs, concurrency } = {}) {
  const list = [];
  const seen = new Set();
  for (const m of (Array.isArray(models) ? models : [])) {
    const name = typeof m === 'string' ? m.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    list.push(name);
  }
  if (!list.length) throw new ModelProbeError(400, '没有可测的模型名');
  const useWire = WIRES.includes(wire) ? wire : wireOfProvider(provider);
  const limit = Number.isFinite(concurrency) && concurrency >= 1
    ? Math.min(16, Math.trunc(concurrency)) : Math.min(DEFAULT_CONCURRENCY, list.length);
  const results = new Array(list.length);
  let next = 0;
  const started = Date.now();
  const worker = async () => {
    while (next < list.length) {
      const index = next++;
      try {
        results[index] = await probeModel({ provider, model: list[index], key, wire: useWire, timeoutMs });
      } catch (e) {
        // 配置错误对整批都成立(坏 base_url / 没 Key):原地记下,不让一个模型把整批打挂
        results[index] = { model: list[index], ok: false, status: null, ms: 0,
          error: e instanceof ModelProbeError ? e.message : '测活失败' };
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return { wire: useWire, results, total_ms: Date.now() - started };
}

module.exports = {
  WIRES, DEFAULT_TIMEOUT_MS, DEFAULT_CONCURRENCY, MODEL_NAME_MAX, PROBE_MAX_TOKENS,
  ModelProbeError, wireOfProvider, modelsOf, probeModel, probeModels,
};
