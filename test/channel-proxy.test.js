'use strict';
// 渠道级出站代理(provider.proxy_url)的回归。钉的是这几件事,每条都对应一种「静默坏掉」的形状:
//
//   1) channelProxyUrl 的归一化:空/缺省/非字符串 → 空串(而不是 "undefined" / "[object Object]"),
//      首尾空白被 trim。写错了不会当场报错,只会在出站时拼出一个不存在的代理地址。
//   2) upstreamAgent 的取舍顺序:direct > proxy_url > MIXR_UPSTREAM_PROXY > 直连(undefined),
//      以及「同一个代理 URL 复用同一个 agent 实例」。任何一条反了都不会抛异常:
//        · direct 不优先 → 标了「直连国内网络」的渠道悄悄绕出境,更慢、更容易被中间设备掐,日志上看不出;
//        · 渠道代理不优先于全局 → 用户给单个渠道配的代理被环境变量盖掉,界面上写着代理、实际没走;
//        · 不按 URL 缓存 → 每次转发新建一把 agent 与一条隧道,连接池形同虚设(而且没人报错)。
//   3) 控制台写入校验(新建与编辑):只收 http://、不带凭据、不带查询串/片段、空串 = 删除字段、
//      direct 与 proxy_url 互斥(判的是**改完之后**的组合,不是请求体)。
//      这些值会直接进 createProxyAgents,而 providers.json 是明文落盘的:写错不是「这条渠道慢一点」,
//      而是每一次转发都同步抛,或者把代理口令写进盘里、再被公开视图原样回显。
//   4) 端到端:配了 proxy_url 的渠道,模型发现 / 渠道探活 / 逐模型测活**真的**经假代理的 CONNECT
//      隧道出站(隧道里确有字节流动);没配代理的、以及标了 direct 的渠道一次 CONNECT 都不发。
//      只断言「agent 对象不是 undefined」是不够的 —— 那只能证明拿到了一个对象。
//
// 测试纪律:全部本机地址 + listen(0),不联网;MIXR_UPSTREAM_PROXY / MIXR_UPSTREAM_PROXY_BYPASS
// 在 before 里存好、after 里恢复、每个用例前清空,避免用例之间互相污染。
//
// ⚠ 隧道用例的上游**不能**绑环回:lib/upstream-proxy.js 的 bypassed() 对环回地址恒放行直连
//   (本机渠道、mock 上游不该绕隧道),拿环回地址测「必须走隧道」等于什么都没测。这里与
//   test/upstream-proxy.test.js 同一做法:上游绑 0.0.0.0,用本机的非环回 IPv4 去访问。
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// 临时 HOME / 数据目录:与 test/provider-models-api.test.js 同一套环境变量做法,必须在 require 之前设。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-channel-proxy-'));
process.env.HOME = TMP;
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude-settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex-config.toml');
process.env.MIXR_ZCODE_CONFIG = path.join(TMP, 'zcode-config.json');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXROUTER_PORT = '0';
process.env.MIXUI_PORT = '0';

const { channelProxyUrl, upstreamAgent, transportAgent, directAgent, destroyAgents } =
  require('../lib/upstream-proxy');
const { fetchProviderModels } = require('../lib/provider-models');
const { testProvider } = require('../lib/provider-test');
const { probeModels } = require('../lib/model-probe');
const mod = require('../mixrouter');

const PROVIDERS_FILE = path.join(TMP, 'providers.json');
const readDiskStore = () => JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
const diskText = () => (fs.existsSync(PROVIDERS_FILE) ? fs.readFileSync(PROVIDERS_FILE, 'utf8') : null);

// 环境变量:before 存快照,after 原样恢复,beforeEach 清干净。
const savedEnv = {
  MIXR_UPSTREAM_PROXY: process.env.MIXR_UPSTREAM_PROXY,
  MIXR_UPSTREAM_PROXY_BYPASS: process.env.MIXR_UPSTREAM_PROXY_BYPASS,
};

const lanIP = () => {
  for (const list of Object.values(os.networkInterfaces()))
    for (const entry of list || []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  return '';
};
const listen = (server, host) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, host, () => { server.removeListener('error', reject); resolve(); });
});
// closeAllConnections() 不清理升级成隧道的 socket,夹具自己登记两端并收尾。
const closeServer = (server, sockets) => new Promise((resolve, reject) => {
  server.close(error => {
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
    else resolve();
  });
  if (sockets) for (const socket of sockets) socket.destroy();
  server.closeAllConnections();
});
const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// 假 CONNECT 代理:把隧道**真的打通**(net.connect 到目标后双向 pipe),并统计每条隧道的
// 目标与「客户端方向流过的字节数」—— 只记录 CONNECT 请求本身,验不到「代理确实承载了流量」。
function mockConnectProxy() {
  const tunnels = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('这个夹具只接受 CONNECT');
  });
  server.on('connect', (req, clientSocket, head) => {
    const authority = String(req.url || '');
    const split = authority.lastIndexOf(':');
    const host = authority.slice(0, split).replace(/^\[|\]$/g, '');
    const port = Number(authority.slice(split + 1));
    const entry = { authority, host, port, bytes: 0 };
    tunnels.push(entry);
    sockets.add(clientSocket);
    clientSocket.on('close', () => sockets.delete(clientSocket));
    const target = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      target.pipe(clientSocket);
      clientSocket.pipe(target);
      // pipe 已经挂上 data 监听;这里再加一个只做计数,不消费数据。
      clientSocket.on('data', chunk => { entry.bytes += chunk.length; });
      if (head.length) { entry.bytes += head.length; target.write(head); }
    });
    sockets.add(target);
    target.on('close', () => sockets.delete(target));
    const kill = () => { target.destroy(); clientSocket.destroy(); };
    target.on('error', kill);
    clientSocket.on('error', kill);
    target.on('close', () => clientSocket.destroy());
    clientSocket.on('close', () => target.destroy());
  });
  return { server, tunnels, sockets };
}

// 回环假上游:记下每一次真实到达的请求,证明隧道/直连都真的送到了。
function mockUpstream(handle) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, host: req.headers.host,
        key: req.headers['x-api-key'] || '', body });
      handle(req, res, hits.at(-1));
    });
  });
  return { server, hits };
}

// ---------------------------------------------------------------- 控制台接口夹具

let ui;
let uiPort;

function request(route, method = 'GET', body, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: uiPort, path: route, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let body = null;
        try { body = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json: body });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

let seq = 0;
const channel = (extra = {}) => ({
  name: `proxy-channel-${++seq}`, base_url: 'http://127.0.0.1:1', api_key: `sk-proxy-${seq}`, ...extra,
});
const findMem = id => mod._state.store.claude.find(p => p.id === id);

before(async () => {
  // 渠道库从空开始,避免临时目录里可能残留的旧文件把断言搅乱(正常情况下 mkdtemp 就是空的)。
  fs.rmSync(PROVIDERS_FILE, { force: true });
  mod._state.store = { claude: [], codex: [] };
  // 只保留空规则表:通用 when/match/default 路由已删除,这里不发任何代理请求,
  // 落点一律由渠道对象本身决定(模型发现 / 探活 / 逐模型测活)。
  mod._state.routes = { rules: [] };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.sessions.clear();
  mod._state.cooldowns = {};
  ui = await mod.listen(0, mod.apiHandler);
  uiPort = ui.address().port;
});

after(async () => {
  await new Promise(resolve => { ui.close(resolve); ui.closeAllConnections(); });
  // 隧道与直连两边的连接池一起放掉,别让空闲 socket 拖住进程退出或夹具的 close()。
  destroyAgents();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.MIXR_UPSTREAM_PROXY;
  delete process.env.MIXR_UPSTREAM_PROXY_BYPASS;
});

// ---------------------------------------------------------------- A. 模块层的取舍与缓存

test('channelProxyUrl:只认非空字符串并 trim,其余一律空串', () => {
  assert.equal(channelProxyUrl({ proxy_url: 'http://127.0.0.1:7890' }), 'http://127.0.0.1:7890');
  assert.equal(channelProxyUrl({ proxy_url: '  http://127.0.0.1:7890\t' }), 'http://127.0.0.1:7890',
    '首尾空白没被 trim:落进缓存键与 createProxyAgents 的就是两个不同地址');
  assert.equal(channelProxyUrl({ proxy_url: '' }), '');
  assert.equal(channelProxyUrl({ proxy_url: '   ' }), '');
  assert.equal(channelProxyUrl({}), '');
  assert.equal(channelProxyUrl({ direct: true }), '');
  assert.equal(channelProxyUrl(null), '');
  assert.equal(channelProxyUrl(undefined), '');
  assert.equal(channelProxyUrl(), '');
  assert.equal(channelProxyUrl({ proxy_url: 7890 }), '', '数字不是地址');
  assert.equal(channelProxyUrl({ proxy_url: { url: 'http://127.0.0.1:7890' } }), '',
    '对象必须当没有,不能变成 "[object Object]" 去建 agent');
  assert.equal(channelProxyUrl({ proxy_url: ['http://127.0.0.1:7890'] }), '');
});

test('upstreamAgent:direct > 渠道代理 > 环境变量 > 直连,并按代理 URL 复用同一个 agent', () => {
  const channelUrl = 'http://127.0.0.1:9';
  const envUrl = 'http://127.0.0.1:8';

  // 都没有:返回 undefined,由 transportAgent 接成 keepAlive 的直连池(不是 globalAgent)
  assert.equal(process.env.MIXR_UPSTREAM_PROXY, undefined);
  assert.equal(upstreamAgent('http:', {}), undefined);
  assert.equal(upstreamAgent('http:', undefined), undefined);
  assert.equal(upstreamAgent('http:', { proxy_url: '   ' }), undefined);
  assert.equal(transportAgent('http:', { proxy_url: '' }), directAgent('http:'),
    '没有隧道时必须退回直连池,不能把 undefined 交给 Node 的 globalAgent');

  const channelHttp = upstreamAgent('http:', { proxy_url: channelUrl });
  assert.notEqual(channelHttp, undefined);
  assert.equal(channelHttp, upstreamAgent('http:', { proxy_url: channelUrl }),
    '同一个代理 URL 必须是同一个 agent 实例(否则每次转发都新建隧道)');
  assert.equal(channelHttp, upstreamAgent('http:', { proxy_url: ` ${channelUrl} ` }),
    'trim 之后同一个 URL 也要命中同一个缓存项');
  assert.equal(transportAgent('http:', { proxy_url: channelUrl }), channelHttp);
  const channelHttps = upstreamAgent('https:', { proxy_url: channelUrl });
  assert.notEqual(channelHttps, undefined);
  assert.notEqual(channelHttps, channelHttp, 'http 与 https 各一把 agent');
  assert.equal(channelHttps, upstreamAgent('https:', { proxy_url: channelUrl }));

  // direct 优先于渠道代理,也优先于环境变量
  assert.equal(upstreamAgent('http:', { direct: true, proxy_url: channelUrl }), undefined);
  process.env.MIXR_UPSTREAM_PROXY = channelUrl;
  assert.equal(upstreamAgent('http:', { direct: true, proxy_url: channelUrl }), undefined,
    '标了 direct 的渠道即使同时有代理地址也不能进隧道');
  assert.equal(transportAgent('http:', { direct: true }), directAgent('http:'));

  // 环境变量兜底
  assert.equal(upstreamAgent('http:', {}), channelHttp,
    '没配渠道代理 = 跟全局走;两个 URL 相同时就是同一个实例');
  process.env.MIXR_UPSTREAM_PROXY = envUrl;
  const viaEnv = upstreamAgent('http:', { name: '没配代理的渠道' });
  assert.notEqual(viaEnv, undefined, '环境里有隧道地址时必须拿到隧道 agent');
  assert.notEqual(viaEnv, channelHttp);
  assert.equal(viaEnv, upstreamAgent('http:', { proxy_url: envUrl }));

  // 渠道级压过环境变量
  assert.equal(upstreamAgent('http:', { proxy_url: channelUrl }), channelHttp,
    '渠道代理必须优先于 MIXR_UPSTREAM_PROXY,否则界面上的设置是假的');
  delete process.env.MIXR_UPSTREAM_PROXY;
});

// ---------------------------------------------------------------- B. 控制台写入校验

test('POST /api/providers:合法的 http:// 代理地址写进渠道库(内存与落盘都有),并去掉首尾空白', async () => {
  const before = mod._state.store.claude.length;
  const created = [];
  for (const proxy_url of ['http://127.0.0.1:7890', 'http://proxy.local:8080', '  http://127.0.0.1:7891  ']) {
    const r = await request('/api/providers', 'POST', channel({ proxy_url }));
    assert.equal(r.status, 200, `${proxy_url} 应被接受: ${r.text}`);
    assert.equal(typeof r.json.id, 'string', '回包应带新建渠道的 id');
    created.push({ id: r.json.id, expected: proxy_url.trim() });
  }
  assert.equal(mod._state.store.claude.length, before + 3);
  const disk = readDiskStore();
  for (const { id, expected } of created) {
    const mem = findMem(id);
    assert.ok(mem, '新建的渠道不在内存渠道库里');
    assert.equal(mem.proxy_url, expected);
    const stored = disk.claude.find(p => p.id === id);
    assert.ok(stored, '新建的渠道没有落盘');
    assert.equal(stored.proxy_url, expected, '落盘的渠道缺了 proxy_url —— 重启后设置就丢了');
  }
});

test('POST /api/providers:非 http:// / 带凭据 / 带查询串或片段 / 非 URL 一律 400,且不写库不落盘', async () => {
  const before = mod._state.store.claude.length;
  const diskBefore = diskText();
  const bad = [
    'https://127.0.0.1:7890',
    'socks5://127.0.0.1:7890',
    'http://user:pass@127.0.0.1:7890',
    'http://127.0.0.1:7890/?x=1',
    'http://127.0.0.1:7890/#frag',
    'not a url',
  ];
  for (const proxy_url of bad) {
    const r = await request('/api/providers', 'POST', channel({ proxy_url }));
    assert.equal(r.status, 400, `${proxy_url} 必须被拒: ${r.text}`);
    assert.match(String(r.json && r.json.error), /出站代理/, `错误文案应说清是代理字段: ${r.text}`);
    assert.ok(!r.text.includes('pass@'), '错误响应不能把代理口令原样回显');
  }
  assert.equal(mod._state.store.claude.length, before, '被拒的渠道不得留在内存渠道库里');
  assert.equal(diskText(), diskBefore, '被拒的写入不得落盘');
});

test('PUT /api/providers/<id>:proxy_url 传空串 = 删除字段,库里不留 proxy_url: ""', async () => {
  const a = await request('/api/providers', 'POST', channel({ proxy_url: 'http://127.0.0.1:7890' }));
  assert.equal(a.status, 200);
  const idA = a.json.id;
  assert.equal(findMem(idA).proxy_url, 'http://127.0.0.1:7890');

  const clear = await request(`/api/providers/${idA}`, 'PUT', { proxy_url: '' });
  assert.equal(clear.status, 200, clear.text);
  const memA = findMem(idA);
  assert.equal('proxy_url' in memA, false, '空串应当是删除字段,不是留一个空字符串');
  const diskA = readDiskStore().claude.find(p => p.id === idA);
  assert.equal('proxy_url' in diskA, false, '落盘里仍留着 proxy_url —— 重启后会变成一个空值字段');

  // 只有空白也按清除处理(与 PUT 里 api_key 的「留空 = 不改」不是一回事,这里空 = 回到跟全局走)
  const b = await request('/api/providers', 'POST', channel({ proxy_url: 'http://127.0.0.1:7890' }));
  const idB = b.json.id;
  const blank = await request(`/api/providers/${idB}`, 'PUT', { proxy_url: '   ' });
  assert.equal(blank.status, 200, blank.text);
  assert.equal('proxy_url' in findMem(idB), false);
  assert.equal('proxy_url' in readDiskStore().claude.find(p => p.id === idB), false);

  // 反过来:给一个没有代理的渠道配上代理,必须存进去
  const c = await request('/api/providers', 'POST', channel());
  const idC = c.json.id;
  const set = await request(`/api/providers/${idC}`, 'PUT', { proxy_url: 'http://proxy.local:8080' });
  assert.equal(set.status, 200, set.text);
  assert.equal(findMem(idC).proxy_url, 'http://proxy.local:8080');
  assert.equal(readDiskStore().claude.find(p => p.id === idC).proxy_url, 'http://proxy.local:8080');
});

test('PUT:direct 与 proxy_url 互斥,判的是改完之后的组合(只改一半也会撞上库里的另一半)', async () => {
  // 库里已有 proxy_url,只改 direct 为 true → 400
  const a = await request('/api/providers', 'POST', channel({ proxy_url: 'http://127.0.0.1:7890' }));
  assert.equal(a.status, 200);
  const idA = a.json.id;
  const beforeA = JSON.stringify(findMem(idA));
  const rA = await request(`/api/providers/${idA}`, 'PUT', { direct: true });
  assert.equal(rA.status, 400, rA.text);
  assert.match(String(rA.json && rA.json.error), /互斥/);
  assert.equal(JSON.stringify(findMem(idA)), beforeA, '400 之后库里不能留下半截修改');

  // 库里已有 direct: true,只改 proxy_url → 400
  const b = await request('/api/providers', 'POST', channel({ direct: true }));
  assert.equal(b.status, 200, '只有 direct 的渠道是合法的');
  const idB = b.json.id;
  assert.equal(findMem(idB).direct, true);
  assert.equal('proxy_url' in findMem(idB), false);
  const rB = await request(`/api/providers/${idB}`, 'PUT', { proxy_url: 'http://127.0.0.1:7890' });
  assert.equal(rB.status, 400, rB.text);
  assert.match(String(rB.json && rB.json.error), /互斥/);
  assert.equal(findMem(idB).direct, true);
  assert.equal('proxy_url' in findMem(idB), false);

  // 同一个请求里两边都给 → 400
  const c = await request('/api/providers', 'POST', channel());
  const idC = c.json.id;
  const rC = await request(`/api/providers/${idC}`, 'PUT',
    { direct: true, proxy_url: 'http://127.0.0.1:7890' });
  assert.equal(rC.status, 400, rC.text);
  assert.equal(findMem(idC).direct, undefined);
  assert.equal('proxy_url' in findMem(idC), false);

  // 单向修改仍然能过(免得互斥被做成「谁都改不了」);清掉代理之后才能改成 direct
  assert.equal((await request(`/api/providers/${idC}`, 'PUT',
    { proxy_url: 'http://127.0.0.1:7890' })).status, 200);
  assert.equal(findMem(idC).proxy_url, 'http://127.0.0.1:7890');
  assert.equal((await request(`/api/providers/${idC}`, 'PUT', { proxy_url: '' })).status, 200);
  assert.equal((await request(`/api/providers/${idC}`, 'PUT', { direct: true })).status, 200);
  assert.equal(findMem(idC).direct, true);
  assert.equal('proxy_url' in findMem(idC), false);
});

test('POST /api/providers:同时给 direct 与 proxy_url → 400,渠道不入库', async () => {
  const before = mod._state.store.claude.length;
  const diskBefore = diskText();
  const r = await request('/api/providers', 'POST',
    channel({ direct: true, proxy_url: 'http://127.0.0.1:7890' }));
  assert.equal(r.status, 400, r.text);
  assert.match(String(r.json && r.json.error), /互斥/);
  assert.equal(mod._state.store.claude.length, before);
  assert.equal(diskText(), diskBefore);
});

// ---------------------------------------------------------------- C. 端到端:代理真的被用上

test('渠道配 proxy_url:模型发现与渠道探活都经假代理 CONNECT 出站,且隧道里确有字节', { timeout: 60000 }, async t => {
  const host = lanIP();
  if (!host) return t.skip('本机没有非环回 IPv4:环回恒被 bypassed(),无法构造「必须走隧道」的用例');
  const upstream = mockUpstream((req, res, hit) => {
    if (hit.url.startsWith('/v1/models')) return json(res, { data: [{ id: 'model-a' }, { id: 'model-b' }] });
    if (hit.url === '/v1/messages') return json(res, { id: 'msg_1', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'pong' }] });
    return json(res, { ok: true });
  });
  await listen(upstream.server, '0.0.0.0');
  const proxy = mockConnectProxy();
  await listen(proxy.server);
  t.after(() => Promise.all([closeServer(upstream.server), closeServer(proxy.server, proxy.sockets)]));

  const port = upstream.server.address().port;
  const provider = { id: 'p-proxied', name: 'p-proxied', base_url: `http://${host}:${port}`,
    api_key: 'sk-proxy-channel', models: ['model-a'],
    proxy_url: `http://127.0.0.1:${proxy.server.address().port}` };

  const listed = await fetchProviderModels(provider);
  assert.deepEqual(listed.models, ['model-a', 'model-b']);
  assert.equal(proxy.tunnels.length, 1, '模型发现没有发 CONNECT —— 它是直连出去的');
  assert.equal(proxy.tunnels[0].authority, `${host}:${port}`, 'CONNECT 的目标必须是上游主机与端口');
  assert.ok(proxy.tunnels[0].bytes > 0, '隧道里一个字节都没有:CONNECT 建了但流量没从代理过');
  assert.deepEqual(upstream.hits.map(h => `${h.method} ${h.url}`), ['GET /v1/models']);
  assert.equal(upstream.hits[0].key, 'sk-proxy-channel', '隧道里的请求应原样带着渠道 Key');

  const probe = await testProvider(provider);
  assert.equal(probe.ok, true, `渠道探活失败: ${JSON.stringify(probe)}`);
  assert.equal(proxy.tunnels.length, 1, '探活应复用同一条隧道(同一个 agent),不该再发 CONNECT');
  assert.deepEqual(upstream.hits.map(h => `${h.method} ${h.url}`),
    ['GET /v1/models', 'GET /', 'POST /v1/messages'], '探活的隧道预检与实际请求都应到达上游');
  assert.equal(upstream.hits[2].host, `${host}:${port}`, '隧道内请求保留真实 Host');
});

test('没配 proxy_url 且环境没有隧道:直连上游,假代理一次 CONNECT 都没收到', { timeout: 60000 }, async t => {
  const host = lanIP();
  if (!host) return t.skip('本机没有非环回 IPv4:环回恒被 bypassed(),无法构造「直连」的对照');
  const upstream = mockUpstream((req, res, hit) => {
    if (hit.url.startsWith('/v1/models')) return json(res, { data: [{ id: 'model-a' }, { id: 'model-b' }] });
    return json(res, { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'pong' }] });
  });
  await listen(upstream.server, '0.0.0.0');
  const proxy = mockConnectProxy();
  await listen(proxy.server);
  t.after(() => Promise.all([closeServer(upstream.server), closeServer(proxy.server, proxy.sockets)]));

  assert.equal(process.env.MIXR_UPSTREAM_PROXY, undefined, '这条用例的前提是环境里没有隧道');
  const provider = { id: 'p-plain', name: 'p-plain', base_url: `http://${host}:${upstream.server.address().port}`,
    api_key: 'sk-plain-channel', models: ['model-a'] };

  assert.deepEqual((await fetchProviderModels(provider)).models, ['model-a', 'model-b']);
  assert.equal(proxy.tunnels.length, 0, '没配代理的渠道不该有任何出站 CONNECT');
  const probe = await testProvider(provider);
  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.equal(proxy.tunnels.length, 0, '渠道探活也不该走代理');
  assert.deepEqual(upstream.hits.map(h => `${h.method} ${h.url}`),
    ['GET /v1/models', 'POST /v1/messages'],
    '直连也要真的到达上游(没有隧道时不做隧道预检,所以没有 GET /)');
});

test('direct 渠道在全局隧道开着时仍直连:假代理一次 CONNECT 都没收到', { timeout: 60000 }, async t => {
  const host = lanIP();
  if (!host) return t.skip('本机没有非环回 IPv4:环回恒被 bypassed(),无法构造「隧道活着」的前提');
  const upstream = mockUpstream((req, res, hit) => {
    if (hit.url.startsWith('/v1/models')) return json(res, { data: [{ id: 'model-a' }, { id: 'model-b' }] });
    return json(res, { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'pong' }] });
  });
  await listen(upstream.server, '0.0.0.0');
  const proxy = mockConnectProxy();
  await listen(proxy.server);
  t.after(() => Promise.all([closeServer(upstream.server), closeServer(proxy.server, proxy.sockets)]));

  // 一条**活着**的隧道:这样「没有 CONNECT」只能归因于 direct,而不是隧道本身坏了
  process.env.MIXR_UPSTREAM_PROXY = `http://127.0.0.1:${proxy.server.address().port}`;
  const base = { base_url: `http://${host}:${upstream.server.address().port}`,
    api_key: 'sk-direct-channel', models: ['model-a'] };
  const provider = { ...base, id: 'p-direct', name: 'p-direct', direct: true };
  assert.equal(upstreamAgent('http:', provider), undefined, 'direct 渠道必须拿到「无隧道 agent」');

  assert.deepEqual((await fetchProviderModels(provider)).models, ['model-a', 'model-b']);
  assert.equal(proxy.tunnels.length, 0, 'direct 渠道绕过了全局隧道');
  assert.equal((await testProvider(provider)).ok, true);
  assert.equal(proxy.tunnels.length, 0, 'direct 渠道的探活（含隧道预检）也不该发 CONNECT');

  // 对照组:同一环境下不标 direct 的渠道确实会进隧道 —— 否则上面两条可能在「隧道根本没生效」时也绿
  const throughEnv = await fetchProviderModels({ ...base, id: 'p-via-env', name: 'p-via-env' });
  assert.deepEqual(throughEnv.models, ['model-a', 'model-b']);
  assert.equal(proxy.tunnels.length, 1, '对照组没有进隧道:这条用例证明不了 direct 优先');
});

// ---------------------------------------------------------------- D. 逐模型测活也走渠道代理

test('逐模型测活走渠道代理:CONNECT 隧道承载请求,结论仍按正文判定', { timeout: 60000 }, async t => {
  const host = lanIP();
  if (!host) return t.skip('本机没有非环回 IPv4:环回恒被 bypassed(),无法构造「必须走隧道」的用例');
  const upstream = mockUpstream((req, res, hit) => {
    let model = '';
    try { model = JSON.parse(hit.body).model || ''; } catch {}
    if (model === 'bad-model') return json(res, { error: { type: 'invalid_request_error', message: 'no such model' } });
    return json(res, { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'pong' }] });
  });
  await listen(upstream.server, '0.0.0.0');
  const proxy = mockConnectProxy();
  await listen(proxy.server);
  t.after(() => Promise.all([closeServer(upstream.server), closeServer(proxy.server, proxy.sockets)]));

  const port = upstream.server.address().port;
  const provider = { id: 'p-probe', name: 'p-probe', base_url: `http://${host}:${port}`,
    proxy_url: `http://127.0.0.1:${proxy.server.address().port}` };
  const r = await probeModels({ provider, models: ['good-model', 'bad-model'], key: 'sk-probe-secret', concurrency: 1 });

  assert.equal(r.wire, 'anthropic');
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].model, 'good-model');
  assert.equal(r.results[0].ok, true, '正常 2xx 正文应判可用');
  assert.equal(r.results[0].status, 200);
  assert.equal(r.results[1].model, 'bad-model');
  assert.equal(r.results[1].ok, false, '200 + {"error":…} 的错误壳必须判成不可用');
  assert.equal(r.results[1].status, 200);
  assert.equal(r.results[1].error, 'no such model', '原因要从正文里抠出来,而不是笼统的「HTTP 200」');
  assert.equal(proxy.tunnels.length, 1, '逐模型测活没有走渠道代理');
  assert.equal(proxy.tunnels[0].authority, `${host}:${port}`);
  assert.ok(proxy.tunnels[0].bytes > 0, '隧道里一个字节都没有:测活流量没从代理过');
  assert.deepEqual(upstream.hits.map(h => h.url), ['/v1/messages', '/v1/messages']);
  assert.ok(!JSON.stringify(r).includes('sk-probe-secret'), '测活结果里不能出现 Key');
});
