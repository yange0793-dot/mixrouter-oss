'use strict';
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');
const { DIRECT_CONNECT_OPTIONS, guardConnection } = require('./upstream-connect');

// 环回地址永不出网:本机渠道(本地模型、mock 上游)走隧道会被隧道拒或绕远路
const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d+){3}|::1|\[::1\])$/i;
function bypassed(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '');
  if (LOOPBACK.test(host)) return true;
  const extra = String(process.env.MIXR_UPSTREAM_PROXY_BYPASS || '').split(',')
    .map(s => s.trim().toLowerCase()).filter(Boolean);
  return extra.some(p => (p.startsWith('.') ? host.toLowerCase().endsWith(p) : host.toLowerCase() === p));
}
// 空闲连接**不该吊住进程退出**,也不该吊住上游测试夹具的 server.close()。
//
// Node 18 与 22+ 的语义不一样,实测(v18.20.8 / v22.23.2 / v24.18.0 三版对照,同一夹具):
//   · 22+ 的 server.close() 会自己放掉空闲 keep-alive 连接,回调 1ms 就回来;
//   · 18 上 close() 要等那些连接走完 keepAliveTimeout(默认 5s)才回调,进程也一直不退出。
// 而 globalAgent 在 18 上恰恰**不** keepAlive(见 directAgent 的说明),所以这个坑是本改动
// 第一次把 keepAlive 带上主流路径时才出现的 —— 表现是测试全绿但进程不退(整套挂在硬截止上)。
//
// 两条都试过、只有第二条对:
//   · Agent 构造器的 `timeout` 选项 —— **不能用**。它同时管在途 socket,而本进程的流式转发
//     会长时间静默(上游在推理,一个字节都不发;README 里 MIXR_STREAM_IDLE_TIMEOUT_MS=90s
//     就是为这段静默留的)。实测:静默超过该值时长即触发请求级 timeout、流被掐成 aborted。
//   · 只给**空闲** socket 设超时(下面的 keepSocketAlive / reuseSocket)—— 对。
//     交还池子时开始计时,被下一个请求取用时立刻清零。在途请求(含静默的 SSE)完全不受影响,
//     实测静默 3 倍阈值仍能收到完整流;而真的空下来后连接自己退场,两端一起释放。
// 默认 5s:与 Node 自己的 keepAliveTimeout 同值。连续对话里一轮接一轮的间隔远小于它,
// 常见形状照样复用;一旦真的空下来就放手。
// ⚠ `0` 的语义是**关掉空闲计时**,不是"立刻回收":`socket.setTimeout(0)` 在 Node 里
//   恰恰是"取消超时"。这时连接仍会被 unref(不挡进程退出),但会一直留在池子里
//   直到被复用或进程结束 —— 同进程内的上游夹具(测试)会因此把 close() 拖到 keepAliveTimeout。
//   留这个值是给"上游明确支持长 keep-alive、想尽量复用它"的场景用的,默认别动。
//   空字符串与非法值一律回落默认(与 mixrouter.js 的 envInt 同口径)。
const IDLE_SOCKET_MS = (() => {
  const raw = process.env.MIXR_UPSTREAM_IDLE_MS;
  if (raw === undefined || String(raw).trim() === '') return 5000;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 5000;
})();
// 给 agent 装上"只在空闲时计时"的行为。两条钩子是 Agent 的既有扩展点:
//   keepSocketAlive —— socket 被交还池子(变成空闲)时调用,在这里开始计时并 unref;
//   reuseSocket     —— 空闲 socket 被取出来用时调用,在这里把计时清零(交回给每请求自己的 timeout)。
// unref 是让"客户端这端不挡进程退出"的那一半:Node 22+ 上 server.close() 自己就会放掉空闲连接,
// unref 在那里不改变可观测行为;Node 18 上它保证进程最终能退。
function relaxWhenIdle(agent) {
  const keep = http.Agent.prototype.keepSocketAlive;
  const reuse = http.Agent.prototype.reuseSocket;
  agent.keepSocketAlive = function (socket) {
    const result = keep.call(this, socket);
    socket.setTimeout(IDLE_SOCKET_MS);
    try { socket.unref(); } catch { /* 已被销毁 */ }
    return result;
  };
  agent.reuseSocket = function (socket, req) {
    socket.setTimeout(0);
    reuse.call(this, socket, req);
  };
  return agent;
}

// 直连(不走隧道)时只挑 TLS/网络相关的键:请求头、path 这些塞进 tls.connect 会被当成 unix socket 路径
function directOptions(options, hostname, port) {
  const keys = ['ca', 'cert', 'key', 'pfx', 'passphrase', 'rejectUnauthorized', 'ALPNProtocols',
    'servername', 'family', 'lookup', 'localAddress', 'localPort', 'timeout'];
  const picked = Object.fromEntries(keys.filter(k => options[k] !== undefined).map(k => [k, options[k]]));
  return { ...picked, host: hostname, port };
}

function createProxyAgents(proxyUrl, agentOptions = {}) {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== 'http:') throw new Error('MIXR_UPSTREAM_PROXY 只支持 http:// CONNECT 代理');
  const timeout = Number(agentOptions.timeout) || 30000;
  const connect = (options, callback, secure) => {
    const hostname = String(options.hostname || options.host).replace(/^\[|\]$/g, '');
    const port = options.port || (secure ? 443 : 80);
    if (bypassed(hostname)) {
      const direct = { ...directOptions(options, hostname, port), ...DIRECT_CONNECT_OPTIONS };
      // 立即把 socket 交给 Agent:客户端取消时可直接销毁,不必等建连回调。
      return guardConnection(secure ? tls.connect(direct) : net.connect(direct), secure);
    }
    const authority = `${net.isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${port}`;
    const headers = { Host: authority };
    if (proxy.username || proxy.password) headers['Proxy-Authorization'] = 'Basic ' +
      Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
    let settled = false;
    let socket;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { req.destroy(); if (socket) socket.destroy(); }
      callback(error, result);
    };
    const req = http.request({ hostname: proxy.hostname, port: proxy.port || 80,
      method: 'CONNECT', path: authority, headers, agent: false });
    const timer = setTimeout(() => finish(new Error('upstream proxy connect timeout')), timeout);
    req.on('error', error => finish(error));
    req.on('response', res => { res.resume(); finish(new Error(`upstream proxy CONNECT ${res.statusCode}`)); });
    req.on('connect', (res, tunnel, head) => {
      socket = tunnel;
      if (res.statusCode !== 200) return finish(new Error(`upstream proxy CONNECT ${res.statusCode}`));
      if (head.length) tunnel.unshift(head);
      if (!secure) return finish(null, tunnel);
      socket = tls.connect({ ...options, socket: tunnel,
        servername: options.servername || (net.isIP(hostname) ? undefined : hostname) });
      socket.once('error', error => finish(error));
      socket.once('secureConnect', () => finish(null, socket));
    });
    req.end();
  };
  // 隧道那条路径的 agent 也走同一套空闲回收:否则它一样会把夹具/进程吊在 keepAliveTimeout 上
  const httpAgent = relaxWhenIdle(new http.Agent({ keepAlive: true, maxSockets: 64, ...(agentOptions.http || {}) }));
  const httpsAgent = relaxWhenIdle(new https.Agent({ keepAlive: true, maxSockets: 64, ...(agentOptions.https || {}) }));
  httpAgent.createConnection = (options, callback) => connect(options, callback, false);
  httpsAgent.createConnection = (options, callback) => connect(options, callback, true);
  return { http: httpAgent, https: httpsAgent };
}

// 空闲连接**不该吊住进程退出**,也不该吊住上游测试夹具的 server.close()。
//
// Node 18 与 22+ 的语义不一样,实测(v18.20.8 / v22.23.2 / v24.18.0 三版对照,同一夹具):
//   · 22+ 的 server.close() 会自己放掉空闲 keep-alive 连接,回调 1ms 就回来;
//   · 18 上 close() 要等那些连接走完 keepAliveTimeout(默认 5s)才回调,进程也一直不退出。
// 而 globalAgent 在 18 上恰恰**不** keepAlive(见 directAgent 的说明),所以这个坑是本改动
// 第一次把 keepAlive 带上主流路径时才出现的 —— 表现是测试全绿但进程不退(整套挂在硬截止上)。
//
// 只 unref **不够**(实测:unref 之后 Node 18 仍不退出)。持有者是连接的两端,
// 光让客户端这端不挡退出,对端那条 socket 还挂在事件循环里。真正管用的是给 socket 一个
// **空闲超时**:空闲到点后连接自己退场,两端一起释放。
//   · 只对**空闲** socket 计时,在途请求不受影响(实测:3 倍空闲时长的慢请求照常拿到完整响应);
//   · 空闲期短的请求仍走复用(实测:连续两次请求第二次 reusedSocket=true);
//   · 空闲超过阈值后下次请求新建连接,不复用陈旧 socket。
// 默认 5s:与 Node 自己的 keepAliveTimeout 同值,连续对话里一轮接一轮的间隔远小于它,
// 所以常见形状照样复用;而一旦真的空下来,5s 后就彻底放手。
// (这些定义见文件上方 IDLE_SOCKET_MS / relaxWhenIdle —— 必须排在 createProxyAgents 之前,
//  写在后面会撞 const 的 TDZ,模块 require 时就抛。)

const caches = new Map();
// 渠道标了 direct(控制台「直连国内网络」)就永远不走隧道:国内站点绕道出境只会更慢、
// 更容易被中间设备掐断。判据放在这里而不是 bypass 域名表,是因为 MIXR_UPSTREAM_PROXY
// 由环境决定、随时可能被下一次重启带上——渠道的「我怎么出网」不该跟着环境漂移。
//
// 这里拿不到隧道 agent 时返回 undefined,但**不代表退回 Node 的 globalAgent**:
// 实际出站走 transportAgent,它把 undefined 接成下面那条 keepAlive 的直连池。
function upstreamAgent(protocol, provider) {
  if (provider && provider.direct) return undefined;
  const url = process.env.MIXR_UPSTREAM_PROXY;
  if (!url) return undefined;
  if (!caches.has(url)) caches.set(url, createProxyAgents(url));
  return caches.get(url)[protocol === 'https:' ? 'https' : 'http'];
}

// ---------------------------------------------------------------- 直连也要复用连接
// 不传 agent 时 Node 用的是 globalAgent,而它的 keepAlive **随大版本变**:
// 实测 v18.20.8 = false,v22.23.2 / v24.18.0 = true。也就是说在 Node 18(CI 矩阵里跑的那个)
// 上,每一条转发都是一次全新的 TCP + TLS 握手。本机实测(同一台机器、零 RTT):
//   新建 TLS 连接 4.93ms/次 → 复用 0.66ms/次;新建 TCP 1.03ms → 复用 0.47ms。
// 这只是握手本身;真实上游在 WAN 上,TLS 握手是 1~2 个 RTT,按 100~400ms 量级算,
// 而每一次对话请求(含每一轮子代理、每一次标题生成)都要付一遍。
// 隧道那条路径一直是 keepAlive(见 createProxyAgents),反倒只有"直连"这条主流路径在重连。
//
// maxSockets 取 128:SSE 流会长期占住 socket,而本机是单进程路由器,并发对话数是十几到几十,
// 128 给足余量;不设上限则是一个打爆上游的敞口。maxFreeSockets 收紧到 32,
// 空闲连接按 host 保留,够覆盖"同一个上游连续几个请求"的常见形状,又不至于攒着一堆死连接。
// 只改本池的地址尝试窗口,不改 Node 全局默认;建连与模型首字/流式预算分开。
const DIRECT_AGENT_OPTIONS = { keepAlive: true, maxSockets: 128, maxFreeSockets: 32, ...DIRECT_CONNECT_OPTIONS };
const directAgents = new Map();
function directAgent(protocol) {
  const key = protocol === 'https:' ? 'https' : 'http';
  let agent = directAgents.get(key);
  if (!agent) {
    const Ctor = key === 'https' ? https.Agent : http.Agent;
    agent = relaxWhenIdle(new Ctor(DIRECT_AGENT_OPTIONS));
    const create = agent.createConnection;
    agent.createConnection = function (options) {
      // 保留原生 Agent 的 TLS session/证书/SNI 处理,计时器只活到 connect/secureConnect。
      return guardConnection(create.call(this, options), key === 'https');
    };
    directAgents.set(key, agent);
  }
  return agent;
}

// 出站**实际**该用的 agent:配了隧道走隧道,没配也仍然复用连接(而不是回落到 globalAgent)。
// 与 upstreamAgent 的分工要分清:那个只回答"配没配隧道"(upstream-proxy-check 靠它短路),
// 这个回答"这次出站用谁"。两条转发路径(真实转发、渠道探活)都走这个。
function transportAgent(protocol, provider) {
  return upstreamAgent(protocol, provider) || directAgent(protocol);
}

// 收尾用:停服务时把两边的连接池一起放掉,别让空闲 socket 拖住退出。
function destroyAgents() {
  for (const agent of directAgents.values()) agent.destroy();
  directAgents.clear();
  for (const pair of caches.values()) { pair.http.destroy(); pair.https.destroy(); }
  caches.clear();
}

module.exports = { createProxyAgents, upstreamAgent, directAgent, transportAgent, destroyAgents, bypassed };
