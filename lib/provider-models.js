'use strict';
// 渠道模型发现:只读地 GET 上游的模型清单,归一成模型名数组(控制台「拉取模型列表」用)。
//
// 所有边界都在这一个文件里收敛,控制台与测试共用同一份实现:
//   · 地址:只接 http(s);拒 userinfo(转发只用 hostname,凭据会被静默丢掉)与查询串/片段
//     (它们不会被这条路径用到,悄悄忽略等于让用户以为"测的是那个地址")。
//   · 路径:base_url 可以是裸域名、以 /v1 结尾、带自定义前缀的版本根,也可以直接是完整的
//     …/models。换算复用 joinUpstreamPath,避免拼出 /v1/models/v1/models。
//   · 凭据:Anthropic 线要 x-api-key + Bearer + anthropic-version,OpenAI 线只要 Bearer。
//     错误文案与响应体**永远不带 Key、不回显上游正文** —— 上游常把请求头原样写进报错。
//   · 上限:整轮一个 15 秒硬期限(慢速滴流也算,不是按 socket 空闲算)、累计 2 MiB、最多
//     20 页。撞上限就明确报错,不返回半份列表 —— 半份列表会被当成"这个渠道就这些模型"。
//   · 不跟随重定向:3xx 一律按上游错误处理,免得把 Authorization 带到别的地址去。
//   · 只读:不改渠道库、不落盘、不写日志。

const http = require('http');
const https = require('https');
const { transportAgent } = require('./upstream-proxy');
const { DEFAULT_UA } = require('./upstream-probe');
const { joinUpstreamPath } = require('./routing/endpoints');
const { hasCtlChar } = require('./routing/headers');

const DEFAULT_TIMEOUT_MS = 15 * 1000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 20;
const WIRES = ['anthropic', 'responses', 'chat'];

// 带 HTTP 状态码的错误:控制台直接按 status 回包,不再从文案里猜该回 400 还是 502。
class ProviderModelsError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ProviderModelsError';
    this.status = status;
  }
}

const positive = (v, def) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? v : def);

// 出站失败只回**受控措辞**。errno 走这张白名单,出站代理的自定义错误按前缀单独识别,
// 其余一律一句固定文案 —— **绝不拼接任意 e.message**:
//   · lib/upstream-proxy.js 的隧道错误只有 message(`upstream proxy CONNECT <code>` /
//     `upstream proxy connect timeout`),把原文抄进控制台等于把代理侧的细节转述出去;
//   · TLS 与 socket 错误的 message 里常带上游主机、证书主题乃至请求片段,同样不该回显。
// 白名单里的措辞是固定的,既说清了"卡在哪一层",又不含任何来自上游的字符串。
const NET_REASONS = new Map([
  ['ECONNREFUSED', '上游拒绝连接'],
  ['ENOTFOUND', '上游域名解析失败'],
  ['EAI_AGAIN', '上游域名解析暂时失败'],
  ['ETIMEDOUT', '连接上游超时'],
  ['ECONNRESET', '上游重置了连接'],
  ['ECONNABORTED', '上游连接被中止'],
  ['EHOSTUNREACH', '无法路由到上游主机'],
  ['ENETUNREACH', '无法路由到上游网络'],
  ['EPIPE', '上游连接已断开'],
  ['CERT_HAS_EXPIRED', '上游 TLS 证书已过期'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', '上游 TLS 证书是自签名的'],
  ['SELF_SIGNED_CERT_IN_CHAIN', '上游 TLS 证书链里有自签名证书'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', '无法验证上游 TLS 证书'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', '上游 TLS 证书与域名不匹配'],
]);
function reasonOf(e) {
  const code = e && e.code;
  if (typeof code === 'string' && NET_REASONS.has(code)) return NET_REASONS.get(code);
  // 出站代理隧道的错误(见 lib/upstream-proxy.js)没有 code,只有 message;只认前缀,不回显原文
  if (e && typeof e.message === 'string' && /^upstream proxy /i.test(e.message))
    return '出站代理未能建立到上游的隧道';
  return '出站请求失败';
}

function modelsPath(pathname) {
  const p = pathname.replace(/\/+$/, '');
  return /\/models$/.test(p) ? p : joinUpstreamPath(p, '/v1/models');
}

// base_url → { protocol, hostname, port, path }。坏值一律 400,并在文案里说清是哪一条。
function endpointOf(baseUrl) {
  let u;
  try { u = new URL(String(baseUrl == null ? '' : baseUrl)); }
  catch { throw new ProviderModelsError(400, 'base_url 必须是合法的 http(s) URL,如 https://api.example.com'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new ProviderModelsError(400, 'base_url 只支持 http 或 https');
  if (u.username || u.password)
    throw new ProviderModelsError(400, 'base_url 不能包含用户名或密码,凭据请填在 API Key 里');
  if (u.search || u.hash)
    throw new ProviderModelsError(400, 'base_url 不能带查询串或片段,模型路径由 base_url 自动拼接');
  return {
    protocol: u.protocol,
    // IPv6 的 u.hostname 是带方括号的(`[::1]`),直接交给 request 会 ENOTFOUND —— hostname
    // 选项要的是裸地址。与 lib/upstream-proxy.js 的 bypassed/connect 同一处理。
    hostname: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: modelsPath(u.pathname),
  };
}

function headersOf(wire, apiKey, ua) {
  const h = { 'Accept': 'application/json', 'User-Agent': ua || DEFAULT_UA };
  if (wire === 'anthropic') {
    h['x-api-key'] = apiKey;
    h['Authorization'] = 'Bearer ' + apiKey;
    h['anthropic-version'] = '2023-06-01';
  } else h['Authorization'] = 'Bearer ' + apiKey;
  return h;
}

// 一次 GET。resolve 响应正文字符串;非 2xx、超时、超限、连接错误都 reject。
// deadline 是**整轮**的绝对时刻:每页都只拿剩下的时间去等,慢速滴流同样会被掐断。
function requestOnce({ target, path, headers, provider, deadline, budget, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    let timer = null;
    const fail = err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (req) req.destroy();
      reject(err);
    };
    const left = deadline - Date.now();
    if (left <= 0) return fail(new ProviderModelsError(504, '获取模型列表超时(15 秒)'));
    timer = setTimeout(
      () => fail(new ProviderModelsError(504, '获取模型列表超时(15 秒)')),
      left,
    );
    const transport = target.protocol === 'https:' ? https : http;
    try {
      req = transport.request({
        protocol: target.protocol, hostname: target.hostname, port: target.port,
        path, method: 'GET', agent: transportAgent(target.protocol, provider), headers,
      }, res => {
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          res.resume();
          return fail(new ProviderModelsError(502,
            status >= 300 && status < 400
              ? `上游返回重定向 HTTP ${status};为避免把 API Key 转发到别处,不会自动跟随,请直接填写最终地址`
              : `上游返回 HTTP ${status},请检查 base_url 与 API Key`));
        }
        const chunks = [];
        res.on('data', c => {
          if (settled) return;
          budget.used += c.length;
          if (budget.used > maxBytes)
            return fail(new ProviderModelsError(502, `上游模型列表超过 ${Math.round(maxBytes / 1024 / 1024 * 10) / 10} MiB 上限`));
          chunks.push(c);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', e => fail(new ProviderModelsError(502, '读取上游响应失败: ' + reasonOf(e))));
        res.on('aborted', () => fail(new ProviderModelsError(502, '上游提前中断了响应')));
      });
    } catch (e) {
      return fail(new ProviderModelsError(502, '无法连接上游: ' + reasonOf(e)));
    }
    req.on('error', e => fail(new ProviderModelsError(502, '无法连接上游: ' + reasonOf(e))));
    req.end();
  });
}

// 兼容三种形状:{data:[{id}]}(OpenAI/Anthropic 标准)、{models:[string|{id}]}、顶层数组。
// 返回 null 表示"形状不合法" —— 与"合法但为空"区分开,后者是允许的。
function idsOf(json) {
  let items;
  if (Array.isArray(json)) items = json;
  else if (json && typeof json === 'object' && Array.isArray(json.data)) items = json.data;
  else if (json && typeof json === 'object' && Array.isArray(json.models)) items = json.models;
  else return null;
  const ids = [];
  for (const item of items) {
    const id = typeof item === 'string' ? item
      : (item && typeof item === 'object' && (typeof item.id === 'string' || Number.isFinite(item.id)) ? String(item.id) : '');
    if (id.trim()) ids.push(id.trim());
  }
  // 数组非空却一个 id 都读不出来:那是形状不对,不是"没有模型"
  if (items.length && !ids.length) return null;
  return ids;
}

/**
 * @param {{base_url:string, api_key:string, wire_api?:string, direct?:boolean, ua?:string}} provider
 * @param {{timeoutMs?:number, maxBytes?:number, maxPages?:number}} [options] 仅测试用
 * @returns {Promise<{models:string[]}>}
 */
async function fetchProviderModels(provider, options = {}) {
  const p = provider || {};
  const wire = p.wire_api === undefined || p.wire_api === '' ? 'anthropic' : p.wire_api;
  if (!WIRES.includes(wire))
    throw new ProviderModelsError(400, 'wire_api 必须是 anthropic、responses 或 chat');
  const apiKey = String(p.api_key == null ? '' : p.api_key);
  if (!apiKey.trim()) throw new ProviderModelsError(400, '缺少 API Key');
  if (hasCtlChar(apiKey)) throw new ProviderModelsError(400, 'API Key 不能包含换行或控制字符');
  const target = endpointOf(p.base_url);
  const headers = headersOf(wire, apiKey.trim(), p.ua);

  const timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBytes = positive(options.maxBytes, DEFAULT_MAX_BYTES);
  const maxPages = Math.floor(positive(options.maxPages, DEFAULT_MAX_PAGES));
  const deadline = Date.now() + timeoutMs;
  const budget = { used: 0 };
  const seen = new Set();
  const models = [];

  let after = '';
  for (let page = 0; page < maxPages; page++) {
    const path = after ? `${target.path}?after_id=${encodeURIComponent(after)}` : target.path;
    const text = await requestOnce({ target, path, headers, provider: p, deadline, budget, maxBytes });
    let json;
    try { json = JSON.parse(text); }
    catch { throw new ProviderModelsError(502, '上游返回的不是合法 JSON'); }
    const ids = idsOf(json);
    if (!ids) throw new ProviderModelsError(502, '上游模型列表格式无法识别,应形如 {"data":[{"id":"..."}]} 或 {"models":[...]}');
    for (const id of ids) {
      if (seen.has(id)) continue;      // 去重但保持上游顺序
      seen.add(id);
      models.push(id);
    }
    // 只有 Anthropic 线有 has_more/last_id 分页;其余形状一次取完。
    if (wire !== 'anthropic' || !json || json.has_more !== true) return { models };
    const lastId = json.last_id;
    if (typeof lastId !== 'string' || !lastId.trim())
      throw new ProviderModelsError(502, '上游声明还有更多模型,却没给 last_id,无法取完整列表');
    if (lastId === after)
      throw new ProviderModelsError(502, '上游分页游标没有前进,停止获取以免死循环');
    after = lastId;
  }
  throw new ProviderModelsError(502, `上游分页超过 ${maxPages} 页上限,未取得完整模型列表`);
}

module.exports = { fetchProviderModels, ProviderModelsError, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES, DEFAULT_MAX_PAGES };
