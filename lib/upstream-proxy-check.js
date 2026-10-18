'use strict';
// 出站代理(隧道)本身的探测。配了 MIXR_UPSTREAM_PROXY 的机器上,生产流量走隧道:
// 这时只探上游会说谎 —— 直连能通、隧道不通,真实请求一样全挂。
//
// 没配出站代理时同步返回 undefined:调用方直接落到"探上游"那一步(见 mixrouter.js 的 testProvider)。

const http = require('http');
const https = require('https');
const { upstreamAgent } = require('./upstream-proxy');

const TEST_TIMEOUT_MS = 15 * 1000;

// 有出站代理就探一次隧道连通性:连得上回 undefined(调用方继续探上游),
// 连不上回 { ok:false, error }。没配代理回 undefined。
function upstreamProxyCheck(u, provider) {
  const agent = upstreamAgent(u.protocol, provider);
  if (!agent) return Promise.resolve();
  return new Promise(resolve => {
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: '/', method: 'GET', agent, timeout: TEST_TIMEOUT_MS,
    }, res => { res.resume(); resolve(); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ ok: false, error: '出站代理不可用: ' + e.message }));
    req.end();
  });
}

module.exports = { TEST_TIMEOUT_MS, upstreamProxyCheck };
