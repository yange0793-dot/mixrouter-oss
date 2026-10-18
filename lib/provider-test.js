'use strict';
// 渠道连通性测试的**编排**:先探隧道(配了出站代理时),再探上游,最后一次成功。
//
// 这一层只做两件事:顺序,以及"该报哪一句错"。两个探测各自的形状在
// lib/upstream-proxy-check.js(隧道)与 lib/upstream-probe.js(上游)里。

const { upstreamProxyCheck } = require('./upstream-proxy-check');
const { testProviderUpstream } = require('./upstream-probe');

// 未配置 API Key 的渠道不探活:发出去必然 401,把它报成"渠道故障"会把配置问题伪装成
// 上游问题。直接说清缺什么。
function testProvider(p) {
  if (!p.api_key) return Promise.resolve({ ok: false, error: '未配置 API Key' });
  const u = new URL(p.base_url);
  // 配了出站代理时先探隧道:隧道不通的环境里直连探活报"通"会误导(生产流量并不直连)
  return upstreamProxyCheck(u, p).then(r => r || testProviderUpstream(p, u));
}

module.exports = { testProvider };
