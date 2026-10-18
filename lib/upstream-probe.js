'use strict';
// 渠道连通性测试的**上游探测**:两种协议各发一个最小的探活请求,回 { ok, status, body }。
//
// 为什么探活不能只探 base_url:配了出站代理(MIXR_UPSTREAM_PROXY)的机器上,生产流量走隧道、
// 探活走直连,直连探出来"通"是误导。隧道的探测在上游(upstream-probe.js)里先做,这里只管
// 探到上游之后的那个最小请求。
//
// 两个协议各有一条踩过的坑,都在下面:
//   · responses 线:探活路径必须与真实转发**同一条规则**(joinUpstreamPath)。base_url 是裸域名
//     时要落到 /v1/models,拼成 <裸域名>/models 会 404/503 —— 渠道是好的,卡片却红着。
//   · anthropic 线:headers 必须**先建好再交给 applyModel**。它把 [1m] 后缀换成 anthropic-beta
//     头是写进传入对象的,早先这里传的是字面量 {},改完即丢 —— 发出去的是"裸模型名 + 无 beta 头",
//     声明了 1m 的上游一律回 400。转发链路不存在这个问题。

const http = require('http');
const https = require('https');
const { transportAgent } = require('./upstream-proxy');
const { joinUpstreamPath } = require('./routing/endpoints');
const { applyModel } = require('./model-suffix');

// 探活的单次时限。与 mixrouter.js 的 TEST_TIMEOUT_MS 同值(那边是配置常量,这里是它的下线)。
const TEST_TIMEOUT_MS = 15 * 1000;
// 探活默认 UA:agentrouter 等网关校验 UA 形态,裸 curl 一律 401
const DEFAULT_UA = 'claude-cli/2.1.219 (external, cli)';
// 探活只回前 300 字,够看清是哪一类错(限流/模型名/额度)
const PROBE_BODY_MAX = 300;

const transportOf = protocol => (protocol === 'https:' ? https : http);
const portOf = u => u.port || (u.protocol === 'https:' ? 443 : 80);

// 一个最小的 GET/POST,把 {ok,status,body} 交回来。error 时回 { ok:false, error }。
// agent 与 timeout 由调用方给:出站代理是否启用由上游决定,这里不猜。
function probe(o) {
  return new Promise(resolve => {
    const transport = transportOf(o.protocol);
    const req = transport.request({
      protocol: o.protocol, hostname: o.hostname, port: portOf(o),
      path: o.path, method: o.method, timeout: TEST_TIMEOUT_MS,
      agent: transportAgent(o.protocol, o.provider), headers: o.headers,
    }, res => {
      const cs = [];
      res.on('data', c => { if (cs.length < 64) cs.push(c); });
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        body: Buffer.concat(cs).toString('utf8').slice(0, PROBE_BODY_MAX),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.end(o.body);
  });
}

// OpenAI 系(Codex)渠道:免费探活 GET <base>/v1/models
function testOpenAiUpstream(p, u) {
  return probe({
    provider: p,
    protocol: u.protocol, hostname: u.hostname, port: u.port, path: joinUpstreamPath(u.pathname, '/v1/models'),
    method: 'GET', headers: { 'Authorization': 'Bearer ' + p.api_key, 'User-Agent': DEFAULT_UA },
  });
}

// Anthropic 系(Claude)渠道:最小 messages 请求
function testAnthropicUpstream(p, u) {
  // headers 必须先建好(见文件头第 2 条坑)。applyModel 会就地改写它。
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': p.api_key, 'Authorization': 'Bearer ' + p.api_key,
    'User-Agent': DEFAULT_UA, 'anthropic-version': '2023-06-01',
  };
  const model = applyModel(p.models[0] || 'claude-opus-5', headers);
  const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
  headers['Content-Length'] = Buffer.byteLength(body);
  return probe({
    provider: p,
    protocol: u.protocol, hostname: u.hostname, port: u.port, path: joinUpstreamPath(u.pathname, '/v1/messages'),
    method: 'POST', headers, body,
  }).then(r => ({ ...r, model }));
}

// 按渠道有没有 wire_api 分两条线(与原实现同一判据:有 wire_api 就是 codex 侧渠道)
function testProviderUpstream(p, u) {
  return p.wire_api ? testOpenAiUpstream(p, u) : testAnthropicUpstream(p, u);
}

module.exports = { TEST_TIMEOUT_MS, DEFAULT_UA, PROBE_BODY_MAX, probe, testOpenAiUpstream, testAnthropicUpstream, testProviderUpstream };
