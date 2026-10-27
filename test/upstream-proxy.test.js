'use strict';
// 出站 CONNECT 代理:http 隧道、TLS 隧道(开启证书校验)、代理拒连/不可用时明确报错、环回直连。
// 生产流量经 MIXR_UPSTREAM_PROXY 出站(fake-IP 环境里上游域名直连会被 TLS 重置),
// 本机渠道(本地模型、mock 上游)则必须直连——隧道用例因此打本机非环回地址。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// 空闲回收的阈值在模块加载时读一次环境变量,所以必须在 require 之前设:
// 默认 5s 与 Node 自己的 keepAliveTimeout 同值,拿它做断言要让每个用例干等 5 秒以上。
// 这里压到 2s,行为不变(仍是"空闲到点才回收"),总耗时降下来。
// 放在 require 之前是这个文件唯一能改动它的时机。
process.env.MIXR_UPSTREAM_IDLE_MS = '2000';
const { createProxyAgents, upstreamAgent, directAgent, transportAgent, bypassed } = require('../lib/upstream-proxy');

const lanIP = () => {
  for (const list of Object.values(os.networkInterfaces()))
    for (const entry of list || []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  return '';
};
// closeAllConnections() 不清理升级后的 CONNECT socket,测试夹具单独登记两端并收尾。
const tunnelSockets = new WeakMap();
const trackTunnel = (server, socket) => {
  let set = tunnelSockets.get(server);
  if (!set) tunnelSockets.set(server, set = new Set());
  set.add(socket);
  // 隧道两端都要记:只掐代理侧,socket.pipe 会吊着上游那端不放
  socket.on('close', () => set.delete(socket));
};
function mockProxy({ refuse = false } = {}) {
  const tunnels = [];
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, clientSocket, head) => {
    tunnels.push({ authority: req.url, auth: req.headers['proxy-authorization'] || '' });
    trackTunnel(server, clientSocket);
    if (refuse) { clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const [host, port] = req.url.split(':');
    const target = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      target.pipe(clientSocket); clientSocket.pipe(target);
    });
    trackTunnel(server, target);
    const kill = () => { target.destroy(); clientSocket.destroy(); };
    target.on('error', kill); clientSocket.on('error', kill);
    target.on('close', () => clientSocket.destroy());
    clientSocket.on('close', () => target.destroy());
  });
  return { server, tunnels };
}
// 默认绑全接口:Linux 上 localhost 先解析 ::1,只绑 127.0.0.1 会让用例在 CI 上 ECONNREFUSED
const listen = (server, host) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, host, () => { server.removeListener('error', reject); resolve(); });
});
// 先停止接新连接,再清理 keep-alive 与 CONNECT;重复清理已关闭的夹具是安全的。
const close = server => new Promise((resolve, reject) => {
  server.close(error => {
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
    else resolve();
  });
  const tunnels = tunnelSockets.get(server);
  if (tunnels) for (const socket of tunnels) socket.destroy();
  server.closeAllConnections();
});
function agentsFor(t, url, options) {
  const agents = createProxyAgents(url, options);
  t.after(() => { agents.http.destroy(); agents.https.destroy(); });
  return agents;
}
const fetchThrough = (url, agent) => new Promise((resolve, reject) => {
  const transport = url.startsWith('https:') ? https : http;
  const req = transport.get(url, { agent }, res => {
    let text = ''; res.on('data', c => text += c);
    res.on('aborted', () => reject(new Error('上游响应中断')));
    res.on('error', reject);
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.setTimeout(10000, () => req.destroy(new Error('测试请求超时')));
  req.on('error', reject);
});

test('CONNECT 隧道:上游经代理转发,CONNECT 目标与凭据正确;连接复用;代理拒连时报错不静默直连', { timeout: 60000 }, async t => {
  const host = lanIP();
  if (!host) return t.skip('本机没有非环回 IPv4,隧道用例无法构造');
  const hits = [];
  const upstream = http.createServer((req, res) => {
    hits.push({ url: req.url, host: req.headers.host });
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('tunnel-ok');
  });
  await listen(upstream, '0.0.0.0');
  const { server: proxy, tunnels } = mockProxy();
  await listen(proxy);
  t.after(async () => { await Promise.all([close(upstream), close(proxy)]); });

  const port = upstream.address().port;
  const url = `http://${host}:${port}/v1/messages`;
  const agents = agentsFor(t, `http://user:p%40ss@127.0.0.1:${proxy.address().port}`);
  process.env.MIXR_UPSTREAM_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  t.after(() => { delete process.env.MIXR_UPSTREAM_PROXY; });

  let r = await fetchThrough(url, agents.http);
  assert.equal(r.text, 'tunnel-ok');
  assert.equal(tunnels.length, 1);
  assert.equal(tunnels[0].authority, `${host}:${port}`);
  assert.equal(tunnels[0].auth, 'Basic ' + Buffer.from('user:p@ss').toString('base64'));
  assert.equal(hits[0].host, `${host}:${port}`, '隧道内请求保留真实 Host');
  // 同一 agent 复用隧道 socket:第二次请求不再新建 CONNECT
  await fetchThrough(url, agents.http);
  assert.equal(tunnels.length, 1, '连接复用,不重复 CONNECT');

  const refusal = mockProxy({ refuse: true });
  await listen(refusal.server);
  t.after(() => close(refusal.server));
  const refused = agentsFor(t, `http://127.0.0.1:${refusal.server.address().port}`);
  await assert.rejects(fetchThrough(url, refused.http), /CONNECT 403/);

  await close(proxy);
  const cached = upstreamAgent('http:');
  t.after(() => cached.destroy());
  assert.equal(typeof cached, 'object');
  await assert.rejects(fetchThrough(url, cached), /ECONNREFUSED|CONNECT/,
    '代理挂掉后明确失败,不回落直连');
});

// 上游刻意绑非环回 IPv4:环回本来就被 bypassed() 放行直连,拿它测「不进隧道」等于什么都没测。
test('渠道标 direct 就永不进隧道:隧道活着时也直连(CONNECT 计数器不涨)', { timeout: 60000 }, async t => {
  const host = lanIP();
  if (!host) return t.skip('本机没有非环回 IPv4,隧道用例无法构造');
  const upstream = http.createServer((req, res) => { res.writeHead(200); res.end('provider-direct'); });
  await listen(upstream, '0.0.0.0');
  t.after(() => close(upstream));
  const { server: proxy, tunnels } = mockProxy();
  await listen(proxy);
  t.after(() => close(proxy));
  // 一把**活着**的隧道:这样「拿不到 agent」只能归因于 direct,而不是隧道本身坏了
  process.env.MIXR_UPSTREAM_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  t.after(() => { delete process.env.MIXR_UPSTREAM_PROXY; });
  const url = `http://${host}:${upstream.address().port}/v1/messages`;

  assert.equal(typeof upstreamAgent('http:', { name: '没标的渠道' }), 'object', '没标 direct 的照旧进隧道');
  assert.equal(upstreamAgent('http:', { name: 'x' }), upstreamAgent('http:'),
    '同一个隧道 agent 实例(按代理 URL 缓存),不是每次新建一把');
  assert.equal((await fetchThrough(url, upstreamAgent('http:', {}))).text, 'provider-direct');
  assert.equal(tunnels.length, 1, '没标 direct 的这一次确实走了隧道');

  assert.equal(upstreamAgent('http:', { direct: true }), undefined, 'direct 渠道必须拿到「无 agent」=直连');
  assert.equal(upstreamAgent('http:', undefined), upstreamAgent('http:'), '不传 provider 的老调用点行为不变');
  // 生产入口仍用 keepAlive 的直连池,不能退回 Node 18 的 globalAgent。
  // (本地版这里断的是"拿 upstreamAgent 的 undefined 去发请求";undefined 退到 globalAgent
  //  在 Node 18 上恰好不 keepAlive,正是 main 那条修复要收掉的行为,所以改断 transportAgent。)
  const direct = transportAgent('http:', { direct: true });
  assert.equal(direct, directAgent('http:'));
  assert.equal(direct.keepAlive, true);
  assert.equal((await fetchThrough(url, direct)).text, 'provider-direct');
  const { upstreamProxyCheck } = require('../lib/upstream-proxy-check');
  const { testProviderUpstream } = require('../lib/upstream-probe');
  const provider = { direct: true, wire_api: 'responses', api_key: 'test-only' };
  assert.equal(await upstreamProxyCheck(new URL(url), provider), undefined);
  assert.equal((await testProviderUpstream(provider, new URL(url))).ok, true);
  const { testProvider } = require('../lib/provider-test');
  assert.equal((await testProvider({ ...provider, base_url: url })).ok, true);
  assert.equal(tunnels.length, 1, 'direct 转发、预检、探活及生产编排都不能经过隧道');
});

test('环回上游不走隧道:挂上出站代理后本机渠道照常直连', { timeout: 60000 }, async t => {
  const upstream = http.createServer((req, res) => { res.writeHead(200); res.end('local-direct'); });
  await listen(upstream);
  t.after(() => close(upstream));
  const port = upstream.address().port;
  // 代理指向一个没人听的端口:环回请求若走隧道就会失败
  const agents = agentsFor(t, 'http://127.0.0.1:9');
  assert.equal((await fetchThrough(`http://127.0.0.1:${port}/v1/messages`, agents.http)).text, 'local-direct');
  assert.equal((await fetchThrough(`http://localhost:${port}/v1/messages`, agents.http)).text, 'local-direct');
  // 绕过表:环回恒绕过;MIXR_UPSTREAM_PROXY_BYPASS 里的域名(支持 . 后缀)也直连
  // (只验判定函数:本机 fake-IP 环境里不存在域名会被劫持,DNS 断言会挂)
  assert.equal(bypassed('localhost'), true);
  assert.equal(bypassed('127.0.0.1'), true);
  assert.equal(bypassed('[::1]'), true);
  assert.equal(bypassed('api.deepseek.com'), false);
  process.env.MIXR_UPSTREAM_PROXY_BYPASS = 'bypass.test, .internal.corp';
  t.after(() => { delete process.env.MIXR_UPSTREAM_PROXY_BYPASS; });
  assert.equal(bypassed('bypass.test'), true);
  assert.equal(bypassed('a.internal.corp'), true);
  assert.equal(bypassed('notinternal.corp'), false);
});

test('CONNECT 隧道:TLS 上游(自签 CA 校验开启)与 IP 主机无 SNI', { timeout: 60000 }, async t => {
  const host = lanIP();
  if (!host) return t.skip('本机没有非环回 IPv4,隧道用例无法构造');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (spawnSync('openssl', ['version']).status !== 0) return t.skip('本机没有 openssl,跳过 TLS 隧道用例');
  // 本机 openssl 是 LibreSSL(不认 -extfile),SAN 走配置文件
  const cfg = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(cfg, ['[req]', 'distinguished_name = dn', 'x509_extensions = v3', 'prompt = no',
    '[dn]', 'CN = mixr-proxy-test', '[v3]', `subjectAltName = IP:${host},IP:127.0.0.1,DNS:localhost`,
    'basicConstraints = CA:TRUE', ''].join('\n'));
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    '-days', '2', '-config', cfg], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);
  const ca = fs.readFileSync(path.join(dir, 'cert.pem'));

  const upstream = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: ca },
    (req, res) => { res.writeHead(200); res.end('tls-tunnel-ok'); });
  await listen(upstream, '0.0.0.0');
  const { server: proxy, tunnels } = mockProxy();
  await listen(proxy);
  t.after(async () => { await Promise.all([close(upstream), close(proxy)]); });

  const port = upstream.address().port;
  const url = `https://${host}:${port}/v1/responses`;
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const r = await fetchThrough(url, agentsFor(t, proxyUrl, { https: { ca } }).https);
  assert.equal(r.text, 'tls-tunnel-ok');
  assert.equal(tunnels[0].authority, `${host}:${port}`);
  // 证书未被信任时明确失败(不静默降级)
  await assert.rejects(fetchThrough(url, agentsFor(t, proxyUrl).https), /self.signed|unable to verify|CERT/i);
  // 环回 + TLS:直连路径也要能建起会话(绕过隧道,证书由 ca 信任)
  const local = await fetchThrough(`https://127.0.0.1:${port}/v1/responses`,
    agentsFor(t, 'http://127.0.0.1:9', { https: { ca } }).https);
  assert.equal(local.text, 'tls-tunnel-ok');
});

// ---------------------------------------------------------------- 直连路径的连接复用
// 见 lib/upstream-proxy.js 里 directAgent 的说明:不显式给 agent 时用的是 globalAgent,
// 而它的 keepAlive **随 Node 大版本变**(实测 18=false / 22、24=true)。Node 18 上
// 每一条转发都是一次全新的 TCP + TLS 握手 —— 这正是 CI 矩阵里跑的那一版。
// 下面三条把"直连也必须复用"钉住,免得日后有人把它退回 globalAgent。

test('直连复用连接:同一个上游连发多次只建一条 TCP 连接(Node 18 上曾每次重连)', { timeout: 60000 }, async t => {
  let conns = 0;
  const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(200); res.end('ok'); });
  upstream.on('connection', () => conns++);
  await listen(upstream);
  t.after(() => close(upstream));
  const url = `http://127.0.0.1:${upstream.address().port}/v1/messages`;
  const agent = directAgent('http:');
  assert.equal(agent.options.autoSelectFamily, true);
  assert.equal(agent.options.autoSelectFamilyAttemptTimeout, 1000);
  assert.equal(directAgent('https:').options.autoSelectFamilyAttemptTimeout, 1000);
  for (let i = 0; i < 4; i++) assert.equal((await fetchThrough(url, agent)).text, 'ok');
  assert.equal(conns, 1, `4 次请求建了 ${conns} 条连接 —— 直连没有复用`);
});

test('空闲连接要能自己退场:不能把夹具/进程吊在 keepAliveTimeout 上', { timeout: 60000 }, async t => {
  // Node 18 上 server.close() 要等空闲 keep-alive 连接走完 keepAliveTimeout(默认 5s)才回调,
  // 若 agent 不给空闲超时,整套测试会"全绿却不退出"。这条把回收行为钉住:
  // 空闲阈值到点后 close 必须远远快于 5s。
  const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(200); res.end('ok'); });
  await listen(upstream);
  const url = `http://127.0.0.1:${upstream.address().port}/v1/messages`;
  const direct = directAgent('http:');
  assert.equal((await fetchThrough(url, direct)).text, 'ok');
  // 让空闲超时(本文件设为 2s)到点。等得比它长一点,确保回收已经发生。
  await new Promise(r => setTimeout(r, 2600));
  const t0 = Date.now();
  await close(upstream);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1500, `close 用了 ${elapsed}ms —— 空闲连接没被回收,还挂在 keepAliveTimeout 上`);
});

test('空闲超时只作用于空闲 socket:在途的流式静默不得被误杀', { timeout: 60000 }, async t => {
  // 这是**关键**回归:Agent 构造器的 timeout 选项会连在途 socket 一起管,
  // 而流式转发允许上游长时间静默(README 的 MIXR_STREAM_IDLE_TIMEOUT_MS=90s 就是为它留的)。
  // 实测拿 timeout 选项做过一版:静默超过阈值即触发请求级 timeout、流被掐成 aborted。
  // 这里让上游发完头后静默 **大于空闲阈值** 再补内容,收到的必须是完整流。
  // 让上游发完头后静默 **大于空闲阈值**(本文件设为 2s)再补内容,收到的必须是完整流。
  const gap = 3500;
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: first\n\n');
    setTimeout(() => { res.write('data: late-chunk\n\n'); res.end(); }, gap);
  });
  await listen(upstream);
  t.after(() => close(upstream));
  const url = `http://127.0.0.1:${upstream.address().port}/v1/messages`;
  const agent = directAgent('http:');
  const r = await fetchThrough(url, agent);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('first'), '开头那块必须收到');
  assert.ok(r.text.includes('late-chunk'),
    `静默 ${gap}ms 后的内容丢了 —— 在途 socket 被空闲超时误杀(空闲超时只能在 socket 空闲时计时)`);
});
