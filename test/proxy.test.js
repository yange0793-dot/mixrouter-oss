'use strict';
// 代理与控制台 API 集成测试:mock 上游 + proxyHandler/apiHandler 挂在临时端口,
// 运行时数据全部指向临时目录,不触碰真实配置
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMockUpstream } = require('./mock-upstream.js');
const mock = createMockUpstream();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-proxy-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_BODY_LIMIT_MB = '1'; // 便于测 413(默认 64MB,不必真发大包)
process.env.MIXR_RETRY_DELAY_MS = '0'; // 重试间隔在测试里没有意义,只会让每个失败用例白等一秒

const P1 = {
  id: 'p1', name: '测试渠道一', base_url: '', api_key: 'sk-test-p1', enabled: true,
  models: ['claude-opus-5'],
};
const BETA = 'context-1m-2025-08-07';

let mod, proxySrv, uiSrv, mockPort, proxyPort, uiPort;
const routesBackup = [];

// 临时把路由换成"指向某个临时渠道"的形状时,删掉那个渠道会让 DELETE 处理器把**当时的
// 路由**写回 routes.json(它要清掉指向已删渠道的僵尸引用,这个行为本身是对的)。
// 但测试换进去的是临时规则,直接 DELETE 就会拿临时规则覆盖磁盘上的真实规则,污染后续用例。
// 所以这类"换路由 → 删渠道 → 还原"的用例,还原时必须把磁盘也写回原样。
// 注意不能在 DELETE **之前**还原内存:那样引用该渠道的规则就查不到了,清理逻辑等于没被测到。
async function swapRoutes(rules, def = { provider: '', model: '' }) {
  const saved = mod._state.routes;
  mod._state.routes = { rules, default: def };
  return async () => {
    mod._state.routes = saved;
    await rawRequest(uiPort, 'PUT', '/api/routes', { body: { rules: saved.rules, default: saved.default } });
  };
}

function rawRequest(port, method, reqPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const creq = http.request({
      hostname: '127.0.0.1', port, method, path: reqPath,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, cres => {
      const cs = [];
      cres.on('data', c => cs.push(c));
      cres.on('end', () => resolve({ status: cres.statusCode, headers: cres.headers, text: Buffer.concat(cs).toString('utf8') }));
    });
    creq.on('error', reject);
    if (data) creq.write(data);
    creq.end();
  });
}

test('setup:起 mock 上游与两个服务', async () => {
  await new Promise(ok => mock.server.listen(0, '127.0.0.1', ok));
  mockPort = mock.server.address().port;
  mock.server.unref();
  P1.base_url = `http://127.0.0.1:${mockPort}`;
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({
    version: 2, current: { claude: 'p1', codex: null }, claude: [P1], codex: [],
  }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({
    rules: [
      { id: 'r1', match: 'opus', provider: 'p1', model: 'routed-opus', enabled: true },
      { id: 'r2', match: 'sonnet', provider: 'p1', model: 'beta-target[1M]', enabled: true },
      { id: 'r3', match: 'dead', provider: 'p1', model: '', enabled: false },
    ],
    default: { provider: 'p1', model: '' },
  }));
  mod = require('../mixrouter.js');
  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  proxySrv.unref(); uiSrv.unref();
});

test('GET /healthz 返回服务信息', async () => {
  const r = await rawRequest(proxyPort, 'GET', '/healthz');
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.text);
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.service, 'mixrouter');
});

test('非 messages 路径返回 404 Anthropic 错误结构', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/other', { body: '{}' });
  assert.strictEqual(r.status, 404);
  const j = JSON.parse(r.text);
  assert.strictEqual(j.type, 'error');
  assert.strictEqual(j.error.type, 'not_found_error');
});

test('请求体非 JSON 返回 400', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', { body: 'not-json' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(JSON.parse(r.text).error.type, 'invalid_request_error');
});

test('命中 opus 规则:转发改写后的模型,带鉴权头,响应附渠道标头', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'claude-cli/9.9 (test)' },
  });
  assert.strictEqual(r.status, 200);
  const seen = mock.requests.at(-1);
  assert.strictEqual(seen.url, '/v1/messages');
  assert.strictEqual(seen.body.model, 'routed-opus');                       // 规则改写
  assert.strictEqual(seen.headers['x-api-key'], 'sk-test-p1');
  assert.strictEqual(seen.headers['authorization'], 'Bearer sk-test-p1');
  assert.strictEqual(seen.headers['user-agent'], 'claude-cli/9.9 (test)');  // 客户端 UA 透传
  // 响应标头经 safeHeader 消洗:纯中文渠道名 → 空串(不崩进程即目的)
  assert.strictEqual(r.headers['x-mixrouter-provider'], '');
  assert.ok(r.text.includes('mock-echo:routed-opus'));
});

test('sonnet 规则目标带 [1M]:剥离后缀,合并 beta 头', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-sonnet-5', max_tokens: 8, stream: false, messages: [{ role: 'user', content: 'hi' }] },
    headers: { 'anthropic-beta': 'feature-x' },
  });
  assert.strictEqual(r.status, 200);
  const seen = mock.requests.at(-1);
  assert.strictEqual(seen.body.model, 'beta-target');
  assert.ok(seen.headers['anthropic-beta'].includes('feature-x'));
  assert.ok(seen.headers['anthropic-beta'].includes(BETA));
});

test('客户端无 UA 时兜底 claude-cli UA', async () => {
  await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    headers: { 'user-agent': '' },
  });
  assert.strictEqual(mock.requests.at(-1).headers['user-agent'], 'claude-cli/2.1.219 (external, cli)');
  // 非 ASCII UA 在 http 客户端就发不出来(ERR_INVALID_CHAR);服务端消洗行为由 helpers 单测的 safeHeader 覆盖
});

test('流式请求:SSE 原样透传,usage 入日志', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers['content-type'].includes('text/event-stream'));
  assert.ok(r.text.includes('event: message_start'));
  assert.ok(r.text.includes('mock-echo:routed-opus'));
  const logs = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs')).text);
  const entry = logs.logs[0];
  assert.strictEqual(entry.stream, true);
  assert.strictEqual(entry.in, 17);
  assert.strictEqual(entry.out, 9);
  assert.strictEqual(entry.cache_read, 5);
  assert.strictEqual(entry.status, 200);
});

test('count_tokens:转发到上游专用路径,usage 数值类型正确', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages/count_tokens', {
    body: { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(mock.requests.at(-1).url.includes('/v1/messages/count_tokens'));
  assert.ok(!Object.hasOwn(mock.requests.at(-1).body, 'stream'), 'count_tokens 请求不能注入 messages 专用的 stream 字段');
  assert.strictEqual(JSON.parse(r.text).input_tokens, 42);
  const logs = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs')).text);
  assert.strictEqual(logs.logs[0].kind, 'count_tokens');
  assert.strictEqual(logs.logs[0].in, 42); // 必须是 number 而非字符串
  assert.strictEqual(typeof logs.logs[0].in, 'number');
});

test('无命中且 default 无渠道时返回 503 + no_route_error', async () => {
  // 规则指向一个根本不存在的渠道:报错必须点名是哪条规则的哪个目标没了,
  // 而不是含混的"没有匹配的路由,或路由未绑定渠道"(控制台里那条规则显示着"已绑定")
  routesBackup.push(mod._state.routes);
  try {
    mod._state.routes = { rules: [{ id: 'rx', match: 'opus', provider: 'ghost', model: '', enabled: true }],
      default: { provider: '', model: '' } };
    const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
      body: { model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.strictEqual(r.status, 503);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.error.type, 'no_route_error');
    assert.match(j.error.message, /rx/, '要指名是哪条规则');
    assert.match(j.error.message, /ghost/, '要指名是哪个渠道');
  } finally { mod._state.routes = routesBackup.pop(); }
});

test('渠道停用时返回 503 + provider_disabled_error', async () => {
  mod._state.store.claude[0].enabled = false; // store 里的对象经 JSON 往返,须就地改
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  mod._state.store.claude[0].enabled = true;
  assert.strictEqual(r.status, 503);
  assert.strictEqual(JSON.parse(r.text).error.type, 'provider_disabled_error');
  assert.ok(JSON.parse(r.text).error.message.includes('已停用'));
});

test('请求体超过上限返回 413 而非静默断连', async () => {
  // MIXR_BODY_LIMIT_MB=1,发 1.5MB 体
  const big = JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'x'.repeat(1.5 * 1024 * 1024) }] });
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', { body: big });
  assert.strictEqual(r.status, 413);
  assert.strictEqual(JSON.parse(r.text).error.type, 'invalid_request_error');
});

// 413 的两条边界:响应必须在请求体收完之后才结束,且排空本身有预算上限。
// 这两条都是上面那个用例偶发 write ECONNRESET 的成因侧——一把 write 整个包时,
// 服务端在请求体没收完就把响应写完,Node 随即销毁 socket,客户端只看到连接被掀掉。
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT: ${ms}ms 内${what}`)), ms))]);

test('大请求的 413 等请求体收完再发,不把还在上传的客户端掀掉', async () => {
  // 刻意分两段上传:先越过 1MB 上限,停 30ms 再补尾巴,复现"响应比上传先结束"的时序
  const head = Buffer.alloc(1024 * 1024 + 64 * 1024, 120);
  const tail = Buffer.alloc(64 * 1024, 120);
  const errors = [];
  let tailFlushed = false;
  const req = http.request({
    hostname: '127.0.0.1', port: proxyPort, method: 'POST', path: '/v1/messages',
    headers: { 'Content-Length': head.length + tail.length, 'Content-Type': 'application/json' },
  });
  req.on('error', e => errors.push(e.code || e.message));
  const responded = new Promise((resolve, reject) => {
    req.on('response', res => {
      const cs = [];
      res.on('data', c => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(cs).toString() }));
      res.on('error', reject);
    });
  });
  req.write(head);
  await new Promise(r => setTimeout(r, 30));
  // 尾包能写完,说明服务端在排空剩余字节而不是直接销毁连接
  await withTimeout(new Promise(r => req.write(tail, () => { tailFlushed = true; r(); })), 5000, '写完尾包');
  req.end();
  const r = await withTimeout(responded, 5000, '收到响应');
  assert.deepStrictEqual(errors, [], '客户端不该在上传途中被断开(ECONNRESET/EPIPE 都算)');
  assert.strictEqual(tailFlushed, true);
  assert.strictEqual(r.status, 413);
  assert.strictEqual(JSON.parse(r.text).error.type, 'invalid_request_error');
});

test('灌到超出排空预算的请求被有界终止,不会一直收下去也不会挂死', async () => {
  // 上限 1MB、排空预算 min(1MB, 32MB)=1MB:灌 3MB 必然击穿排空预算。
  //
  // 断言的是**服务端侧的确定事实**,不是客户端能不能读到那条 413。服务端先 flush 响应再销毁
  // 连接,但客户端完全可能在读到响应之前先撞上 ECONNRESET(实测 Node 18 上就是这么偶发的),
  // 拿"一定收到 413"当断言等于把内核缓冲时序写进测试。真正要保证的是有界终止:
  // 代理不再陪着收完整包、不挂死、并且确实把 413 发出去了。
  const before = mod._state.bodyDrainAborts;
  const total = 3 * 1024 * 1024;
  const req = http.request({
    hostname: '127.0.0.1', port: proxyPort, method: 'POST', path: '/v1/messages',
    headers: { 'Content-Length': total, 'Content-Type': 'application/json' },
  });
  // 越过排空预算后服务端会销毁连接,客户端这边 write 报错是预期行为,不能让它掀掉用例
  const settled = new Promise(resolve => {
    req.on('error', () => resolve(null));          // 被断开也是"终止"
    req.on('close', () => resolve(null));
    req.on('response', res => {
      const cs = [];
      res.on('data', c => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(cs).toString() }));
      res.on('error', () => resolve(null));
    });
  });
  // socket 级 no-op。req 上的 error 监听在请求 close 之后就不再兜底了:3MB 里没发完的那部分
  // 接着撞上服务端的 RST/EPIPE 时,一个没人监听的 socket 'error' 会变成 uncaughtException
  // ——CI 上就是这样偶发红的(Node 22 与 24 两条腿,同一 run 35510887003)。这里要的是"有界
  // 终止",不是"客户端必须一个错都不报",所以吞掉。
  req.on('socket', s => s.on('error', () => {}));
  req.write(Buffer.alloc(total, 120));
  req.end();
  const r = await withTimeout(settled, 5000, '终止(收到响应或连接被断开)');
  assert.strictEqual(mod._state.bodyDrainAborts, before + 1, '排空预算应被击穿恰好一次,而不是陪着收完 3MB');
  if (r) {
    assert.strictEqual(r.status, 413, '有响应就只能是 413,绝不能当成正常请求转发出去');
    assert.strictEqual(JSON.parse(r.text).error.type, 'invalid_request_error');
  }
});

test('base_url 非法时保存被拒(POST 与 PUT 都拦)', async () => {
  const bad = await rawRequest(uiPort, 'POST', '/api/providers', {
    body: { app: 'claude', name: '坏渠道', base_url: 'not-a-url', api_key: '' },
  });
  assert.strictEqual(bad.status, 400);
  assert.ok(JSON.parse(bad.text).error.includes('base_url'));
  const badScheme = await rawRequest(uiPort, 'POST', '/api/providers', {
    body: { app: 'claude', name: '坏协议', base_url: 'ftp://x.example.com', api_key: '' },
  });
  assert.strictEqual(badScheme.status, 400);
  // PUT 同样拦截:先建合法渠道,再改坏
  const ok = await rawRequest(uiPort, 'POST', '/api/providers', {
    body: { app: 'claude', name: '好渠道', base_url: 'https://api.example.com', api_key: '' },
  });
  const id = JSON.parse(ok.text).id;
  const badPut = await rawRequest(uiPort, 'PUT', `/api/providers/${id}`, { body: { base_url: 'javascript:alert(1)' } });
  assert.strictEqual(badPut.status, 400);
  await rawRequest(uiPort, 'DELETE', `/api/providers/${id}`);
});

test('base_url 带内嵌凭据时被拒(凭据会被静默丢弃,只剩一个没头没脑的 401)', async () => {
  // 转发只用 hostname,URL 里的 user:pass 一个字节都不会带上游;
  // 存进去的话用户以为凭据写好了,实际请求裸奔,只拿到 401 却看不出原因。
  // 凭据该填 API Key 字段(ZCode 侧 baseURL 早已按同一标准拒绝)
  for (const u of ['https://user:pass@a.example.com', 'https://user@a.example.com', 'https://:pass@a.example.com']) {
    const r = await rawRequest(uiPort, 'POST', '/api/providers', {
      body: { app: 'claude', name: '带凭据', base_url: u, api_key: 'sk-x' },
    });
    assert.strictEqual(r.status, 400, `${u} 必须被拒`);
    assert.ok(JSON.parse(r.text).error.includes('base_url'));
  }
  // PUT 同样拦
  const ok = await rawRequest(uiPort, 'POST', '/api/providers', {
    body: { app: 'claude', name: '再一个好渠道', base_url: 'https://api.example.com', api_key: '' },
  });
  const id = JSON.parse(ok.text).id;
  const put = await rawRequest(uiPort, 'PUT', `/api/providers/${id}`, { body: { base_url: 'https://u:p@b.example.com' } });
  assert.strictEqual(put.status, 400, 'PUT 也必须拦');
  await rawRequest(uiPort, 'DELETE', `/api/providers/${id}`);
});

test('上游拒绝连接时返回 502', async () => {
  mod._state.store.claude.push({ id: 'pdown', name: '死渠道', base_url: 'http://127.0.0.1:1', api_key: 'sk-x', enabled: true });
  routesBackup.push(mod._state.routes);
  mod._state.routes = { rules: [{ id: 'rd', match: 'downmodel', provider: 'pdown', model: '', enabled: true }],
    default: { provider: '', model: '' } };
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'downmodel-1', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  mod._state.routes = routesBackup.pop();
  mod._state.store.claude = mod._state.store.claude.filter(p => p.id !== 'pdown');
  assert.strictEqual(r.status, 502);
  assert.strictEqual(JSON.parse(r.text).error.type, 'api_error');
});

test('上游 4xx 挂 SSE 皮(New API 系网关):如实转发状态码与上游原因,不报“流缺完整终态”', async () => {
  mock.setSseWrappedError(402, 'Budget pool quota has been exhausted.');
  const before = mock.requests.length;
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    headers: { 'anthropic-version': '2023-06-01' },
    body: { model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(r.status, 402, '上游状态码要如实转发,不能糊成 502');
  const j = JSON.parse(r.text);
  assert.strictEqual(j.type, 'error');
  assert.match(j.error.message, /402/);
  assert.match(j.error.message, /Budget pool quota/, '上游原因要带出来,用户才知道是额池没了');
  assert.strictEqual(mock.requests.length, before + 1, '402 不是可重试错误,不该重打上游');
  const logs = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs')).text);
  assert.strictEqual(logs.logs[0].status, 402);
  assert.notStrictEqual(logs.logs[0].err_class, 'stream_aborted', '这不是断流,别记成断流');
});

test('控制台 API:渠道 CRUD 全流程,key 不出网', async () => {
  // 创建 codex 渠道
  const created = await rawRequest(uiPort, 'POST', '/api/providers', {
    body: { app: 'codex', name: 'CRUD 渠道', base_url: 'https://api.example.com/', api_key: 'sk-crud-1234567890abcdef', model: 'gpt-5' },
  });
  assert.strictEqual(JSON.parse(created.text).ok, true);
  const id = JSON.parse(created.text).id;
  // state 里 key 必须是掩码,不能出现明文
  const state = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text);
  const found = [...state.providers.claude, ...state.providers.codex].find(p => p.id === id);
  assert.ok(found);
  assert.strictEqual(found.api_key, undefined);
  assert.ok(found.key_masked.includes('…'));
  // 更新
  const upd = await rawRequest(uiPort, 'PUT', `/api/providers/${id}`, { body: { name: 'CRUD 渠道改' } });
  assert.strictEqual(JSON.parse(upd.text).ok, true);
  // 删除
  const del = await rawRequest(uiPort, 'DELETE', `/api/providers/${id}`);
  assert.strictEqual(JSON.parse(del.text).ok, true);
  const after = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text);
  assert.ok(![...after.providers.claude, ...after.providers.codex].some(p => p.id === id));
});

test('多 Key 渠道:清单只出掩码,切换生效 Key 后上游收到的就是新 Key', async () => {
  const created = await rawRequest(uiPort, 'POST', '/api/providers', {
    body: { app: 'claude', name: '多账号渠道', base_url: `http://127.0.0.1:${mockPort}`, api_key: 'sk-acct-one-0001',
      models: ['claude-opus-5'], keys: [{ label: '账号1', key: 'sk-acct-one-0001' }, { label: '账号2', key: 'sk-acct-two-0002' }] },
  });
  const id = JSON.parse(created.text).id;
  const restoreRoutes = await swapRoutes([{ id: 'rmk', match: 'mkprobe', provider: id, model: '', enabled: true }]);

  const state = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text);
  const p = state.providers.claude.find(x => x.id === id);
  assert.strictEqual(p.keys.length, 2);
  assert.strictEqual(p.keys[0].label, '账号1');
  assert.ok(p.keys.every(k => k.key === undefined && k.key_masked.includes('…')), '清单里不能出明文 Key');
  assert.ok(!JSON.stringify(state).includes('sk-acct-two-0002'), '明文 Key 不能出现在 state 里');
  const key2 = p.keys[1].id;

  // 第一个 Key 生效时:上游收到 api_key 对应的凭据
  await rawRequest(proxyPort, 'POST', '/v1/messages', { body: { model: 'mkprobe-1', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] } });
  assert.strictEqual(mock.requests.at(-1).headers['x-api-key'], 'sk-acct-one-0001');

  // 切换到第二个 Key:同一个渠道、同一批槽位/规则,转发立刻改用新 Key
  const sw = await rawRequest(uiPort, 'PUT', `/api/providers/${id}`, { body: { active_key: key2 } });
  assert.strictEqual(sw.status, 200);
  await rawRequest(proxyPort, 'POST', '/v1/messages', { body: { model: 'mkprobe-2', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] } });
  assert.strictEqual(mock.requests.at(-1).headers['x-api-key'], 'sk-acct-two-0002');
  const after = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text);
  const p2 = after.providers.claude.find(x => x.id === id);
  assert.strictEqual(p2.active_key, key2);
  assert.strictEqual(p2.key_masked, 'sk-acc…0002');
  // 改动前后老 Key 仍在清单里(切换不删 Key)
  assert.strictEqual(p2.keys.length, 2);

  // 空值 Key 被拒;清单清空 = 退回单 Key(退回后状态里剩合成的那条「账号1」,值就是最后生效的那把)
  const bad = await rawRequest(uiPort, 'PUT', `/api/providers/${id}`, { body: { keys: [{ label: 'x', key: '' }] } });
  assert.strictEqual(bad.status, 400);
  await rawRequest(uiPort, 'PUT', `/api/providers/${id}`, { body: { keys: [] } });
  const cleared = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text).providers.claude.find(x => x.id === id);
  assert.deepStrictEqual(cleared.keys.map(k => [k.id, k.key_masked]), [['klegacy', 'sk-acc…0002']]);
  assert.strictEqual(cleared.active_key, 'klegacy');
  await rawRequest(uiPort, 'DELETE', `/api/providers/${id}`);
  await restoreRoutes();
});

test('老式单 Key 渠道:控制台加第二把 Key 不会挤掉老 Key', async () => {
  // 只带 api_key 建渠道(等同控制台里"只填了上面那一行"的老渠道,磁盘上没有 keys 清单)
  const created = await rawRequest(uiPort, 'POST', '/api/providers', {
    body: { app: 'claude', name: '老式单Key渠道', base_url: `http://127.0.0.1:${mockPort}`, api_key: 'sk-legacy-one-0001', models: ['claude-opus-5'] },
  });
  const id = JSON.parse(created.text).id;
  const restoreRoutes = await swapRoutes([{ id: 'rlg', match: 'lgprobe', provider: id, model: '', enabled: true }]);

  // 控制台看到的是合成的一条「账号1」——老渠道也有清单可点,不是空白
  const before = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text).providers.claude.find(x => x.id === id);
  assert.deepStrictEqual(before.keys.map(k => [k.id, k.label]), [['klegacy', '账号1']]);
  assert.strictEqual(before.active_key, 'klegacy');

  // 弹窗里「＋ 添加账号」加一行,老那行(id=klegacy)留空提交 —— 这正是老 Key 被挤掉的场景
  const put = await rawRequest(uiPort, 'PUT', `/api/providers/${id}`, {
    body: { app: 'claude', api_key: '', keys: [{ id: 'klegacy', label: '账号1', key: '' }, { id: '', label: '账号2', key: 'sk-second-two-0002' }] },
  });
  assert.strictEqual(put.status, 200);
  const after = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text).providers.claude.find(x => x.id === id);
  assert.deepStrictEqual(after.keys.map(k => k.label), ['账号1', '账号2']);
  assert.strictEqual(after.active_key, 'klegacy');
  assert.strictEqual(after.key_masked, 'sk-leg…0001', '老 Key 必须还在,且仍是生效那把');

  // 老 Key 真的还在转发里用:先确认上游收到老 Key,再切到账号2确认换成新 Key
  await rawRequest(proxyPort, 'POST', '/v1/messages', { body: { model: 'lgprobe-1', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] } });
  assert.strictEqual(mock.requests.at(-1).headers['x-api-key'], 'sk-legacy-one-0001');
  const key2 = after.keys.find(k => k.label === '账号2').id;
  assert.strictEqual((await rawRequest(uiPort, 'PUT', `/api/providers/${id}`, { body: { active_key: key2 } })).status, 200);
  await rawRequest(proxyPort, 'POST', '/v1/messages', { body: { model: 'lgprobe-2', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] } });
  assert.strictEqual(mock.requests.at(-1).headers['x-api-key'], 'sk-second-two-0002');

  await rawRequest(uiPort, 'DELETE', `/api/providers/${id}`);
  await restoreRoutes();
});

test('日志过滤与统计聚合', async () => {
  // 造一条失败记录
  mod._state.store.claude.push({ id: 'pdown', name: '死渠道', base_url: 'http://127.0.0.1:1', api_key: 'sk-x', enabled: true });
  routesBackup.push(mod._state.routes);
  mod._state.routes = { rules: [{ id: 'rd', match: 'downmodel', provider: 'pdown', model: '', enabled: true }],
    default: { provider: 'p1', model: '' } };
  await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'downmodel-2', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  mod._state.routes = routesBackup.pop();
  mod._state.store.claude = mod._state.store.claude.filter(p => p.id !== 'pdown');

  const errLogs = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?status=err')).text);
  assert.ok(errLogs.logs.length >= 1, '应有失败记录');
  assert.ok(errLogs.logs.every(l => l.status >= 400 || l.status === 0 || l.err));

  const okLogs = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?status=ok')).text);
  assert.ok(okLogs.logs.length >= 1);
  assert.ok(okLogs.logs.every(l => l.status >= 200 && l.status < 400 && !l.err));

  const provLogs = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?provider=' + encodeURIComponent('测试渠道一'))).text);
  assert.ok(provLogs.logs.length >= 1);
  assert.ok(provLogs.logs.every(l => (l.provider || '').includes('测试渠道一')));

  const modelLogs = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?model=downmodel')).text);
  assert.ok(modelLogs.logs.length >= 1);
  assert.ok(modelLogs.logs.every(l => ((l.model_in || '') + (l.model_out || '')).includes('downmodel')));

  // err_class 维度:这一条走真实 HTTP,覆盖的才是 mixrouter.js 里那套内联过滤
  // (request-log.js 的模块版另由 request-log.test.js 覆盖);只测模块版会漏掉生产路径。
  // 不写死具体分类:渠道不同落在 econnrefused / network_error / upstream_server 都可能,
  // 先读实际产生的那一个再按它筛,断言才不挑环境。
  const allForCls = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?limit=500')).text);
  const someClass = (allForCls.logs.find(l => l.err_class) || {}).err_class;
  assert.ok(someClass, '这一轮应留下带 err_class 的记录');
  const clsLogs = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?err_class=' + encodeURIComponent(someClass))).text);
  assert.ok(clsLogs.logs.length >= 1, '按该分类应能捞到');
  assert.ok(clsLogs.logs.every(l => (l.err_class || '').toLowerCase().includes(someClass.toLowerCase())));
  // 大小写不敏感(与 provider/model 同口径)
  const clsUpper = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?err_class=' + encodeURIComponent(someClass.toUpperCase()))).text);
  assert.strictEqual(clsUpper.logs.length, clsLogs.logs.length, 'err_class 应大小写不敏感');
  // 不存在的分类给空,而不是退回全量
  const clsNone = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?err_class=zzz_nope')).text);
  assert.strictEqual(clsNone.logs.length, 0, '无匹配就该是空,不得退化成不过滤');

  const stats = JSON.parse((await rawRequest(uiPort, 'GET', '/api/stats')).text);
  const all = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?limit=500')).text);
  assert.strictEqual(stats.reqs, all.logs.length, '统计总数须与全量日志一致');
  assert.ok((stats.by_provider['测试渠道一'] || 0) >= 1);
  assert.ok(stats.ok_rate >= 0 && stats.ok_rate <= 100);
  assert.ok(stats.inTok >= 17 && stats.outTok >= 9, 'usage 应已被聚合');
});

test('控制台 API:PUT /api/routes 持久化并生效', async () => {
  const fileRoutes = JSON.parse(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8')); // require 时装载的原始路由
  const put = await rawRequest(uiPort, 'PUT', '/api/routes', {
    body: { rules: [{ id: 'n1', match: 'tiny', provider: 'p1', model: 'tiny-target', enabled: true }], default: { provider: 'p1', model: '' } },
  });
  assert.strictEqual(JSON.parse(put.text).ok, true);
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'a-tiny-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(mock.requests.at(-1).body.model, 'tiny-target');
  // 还原为文件初始路由,保证测试幂等
  const restore = await rawRequest(uiPort, 'PUT', '/api/routes', { body: fileRoutes });
  assert.strictEqual(JSON.parse(restore.text).ok, true);
});

// ---- 槽位请求与会话绑定/手动改绑的相互作用(两条都在修 rebind 劫持)----
const mkClaudeProvider = async (name, key) => JSON.parse((await rawRequest(uiPort, 'POST', '/api/providers', {
  body: { app: 'claude', name, base_url: `http://127.0.0.1:${mockPort}`, api_key: key, models: ['claude-opus-5'] },
})).text).id;

test('402 额度耗尽在多候选池里会换渠道重打(单候选时仍如实转发)', async () => {
  // 语义:402 = 这家池子的额度跑干了(AgentRouter 等聚合站按放量窗口计费,窗口外恒 402)。
  // 它与本次载荷无关、只跟渠道有关,和 429 同类 —— 错峰的另一家此刻可能有量。
  // 修复前 402 不在重试条件里,池里明明有第二条渠道也不换,直接把 402 抛给客户端。
  const poolA = await mkClaudeProvider('额池渠道A', 'sk-402-a-0001');
  const poolB = await mkClaudeProvider('额池渠道B', 'sk-402-b-0002');
  const rulesSave = mod._state.routes;
  const slotsSave = structuredClone(mod._state.slotMap);
  const mockSave = mock.requests.length;
  // 优先级策略把 A 放前面,B 作后备。清掉槽位与会话,免得上一条用例的状态渗进来
  mod._state.routes = { rules: [{ id: 'r402', match: 'q402probe',
    pool: [{ provider: poolA, model: 'claude-opus-5' }, { provider: poolB, model: 'claude-opus-5' }],
    strategy: 'priority', enabled: true }], default: { provider: '', model: '' } };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.resetPools();
  mod._state.sessions.delete('cc:q402probe1');

  // A 只失败一次,B 正常 —— 若 failover 生效,客户端拿到的是 200 而不是 402
  mock.setSseWrappedError(402, 'Budget pool quota has been exhausted.', 1);
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': 'cc:q402probe1' },
    body: { model: 'q402probe', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(r.status, 200, '402 应触发换渠道,客户端不该看到 402');
  const used = mock.requests.slice(mockSave).map(x => x.headers['x-api-key']);
  assert.ok(used.includes('sk-402-a-0001'), '第一条应打在被耗尽的渠道 A 上');
  assert.ok(used.includes('sk-402-b-0002'), '402 之后应换到渠道 B 重打');
  const logs = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs')).text);
  const entry = logs.logs.find(l => l.model_in === 'q402probe');
  assert.ok(entry, '这一轮要留下请求日志');
  assert.strictEqual(entry.failover, true, '日志要记下这次是失败转移来的');

  mod._state.routes = rulesSave;
  mod._state.slotMap = slotsSave;
  mod._state.sessions.delete('cc:q402probe1');
  mod._state.resetPools();
  await rawRequest(uiPort, 'DELETE', `/api/providers/${poolA}`);
  await rawRequest(uiPort, 'DELETE', `/api/providers/${poolB}`);
});
const claudeSend = (model, sessionId) => rawRequest(proxyPort, 'POST', '/v1/messages', {
  headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': sessionId },
  body: { model, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] },
});

test('槽位请求不改写会话绑定:主模型仍留在原渠道', async () => {
  const slotId = await mkClaudeProvider('槽位渠道', 'sk-slot-h-0003');
  const poolB = await mkClaudeProvider('池成员B', 'sk-pool-b-0002');
  const rulesSave = mod._state.routes;
  const slotsSave = structuredClone(mod._state.slotMap);
  mod._state.routes = { rules: [{ id: 'rpool', match: 'poolprobe', pool: [{ provider: 'p1' }, { provider: poolB }], strategy: 'round_robin', enabled: true }], default: { provider: '', model: '' } };
  mod._state.slotMap = { claude: { haiku: { provider: slotId, model: 'haiku-target' } }, codex: {} };
  mod._state.resetPools();
  mod._state.sessions.delete('cc:slotstick1');

  await claudeSend('poolprobe-1', 'slotstick1');
  const mainKey = mock.requests.at(-1).headers['x-api-key'];
  assert.ok(['sk-test-p1', 'sk-pool-b-0002'].includes(mainKey), '主请求应落在池成员上');
  // 同一对话发一条槽位请求(Claude Code 每个对话开头都会发 haiku 档的起标题请求)
  await claudeSend('mixr-haiku', 'slotstick1');
  assert.strictEqual(mock.requests.at(-1).headers['x-api-key'], 'sk-slot-h-0003', '槽位请求要走槽位渠道');
  assert.strictEqual(mock.requests.at(-1).body.model, 'haiku-target', '槽位渠道收到的是槽位的落点模型');
  // 关键:槽位请求不能把对话挪走,否则下一条主模型请求跟着跑偏、prompt 缓存被打破
  await claudeSend('poolprobe-2', 'slotstick1');
  assert.strictEqual(mock.requests.at(-1).headers['x-api-key'], mainKey, '槽位请求之后主模型仍走原渠道');

  mod._state.routes = rulesSave;
  mod._state.slotMap = slotsSave;
  mod._state.sessions.delete('cc:slotstick1');
  mod._state.resetPools();
  await rawRequest(uiPort, 'DELETE', `/api/providers/${slotId}`);
  await rawRequest(uiPort, 'DELETE', `/api/providers/${poolB}`);
});

test('被「手动改绑」的会话不劫持槽位请求', async () => {
  const slotId = await mkClaudeProvider('槽位渠道2', 'sk-slot-pin-0004');
  const rulesSave = mod._state.routes;
  const slotsSave = structuredClone(mod._state.slotMap);
  mod._state.routes = { rules: [{ id: 'rpin', match: 'pinprobe', provider: 'p1', model: '', enabled: true }], default: { provider: '', model: '' } };
  mod._state.slotMap = { claude: { haiku: { provider: slotId, model: 'haiku-target' } }, codex: {} };
  // 把该对话钉在 p1 上(控制台「改绑」),再发槽位别名
  mod._state.bindSession('cc:slotpin1', 'p1', { pinned: true });

  await claudeSend('mixr-haiku', 'slotpin1');
  assert.strictEqual(mock.requests.at(-1).headers['x-api-key'], 'sk-slot-pin-0004', '钉定不该把槽位请求拽到被钉定的渠道');
  assert.strictEqual(mock.requests.at(-1).body.model, 'haiku-target');

  mod._state.routes = rulesSave;
  mod._state.slotMap = slotsSave;
  mod._state.sessions.delete('cc:slotpin1');
  await rawRequest(uiPort, 'DELETE', `/api/providers/${slotId}`);
});

test('非流客户端直通:上游收到 stream:true,客户端收到攒出来的整包 JSON + 终态 usage', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 8, stream: false, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers['content-type'].includes('application/json'), '非流客户端收整包 JSON,不是 SSE');
  const j = JSON.parse(r.text);
  assert.strictEqual(j.type, 'message');
  assert.strictEqual(j.content[0].text, 'mock-echo:routed-opus');
  assert.strictEqual(j.stop_reason, 'end_turn');
  // usage 与流式同口径:message_start 的 0 被 message_delta 的终态值盖掉
  assert.deepStrictEqual(j.usage, { input_tokens: 17, output_tokens: 9, cache_read_input_tokens: 5 });
  // 上游侧必须收到流式请求:非流形状透传给上游 = 大上下文压缩请求撞首字节超时的死循环
  assert.strictEqual(mock.requests.at(-1).body.stream, true);
  const logs = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs')).text);
  const entry = logs.logs[0];
  assert.strictEqual(entry.in, 17, '攒包路径的 usage 要落进请求日志');
  assert.strictEqual(entry.out, 9);
  assert.strictEqual(entry.cache_read, 5);
  assert.strictEqual(entry.status, 200);
  assert.strictEqual(entry.err, '');
});

test('探活:models[0] 带 [1m] 后缀时,要真的把 anthropic-beta 头发出去', async () => {
  // 回归:applyModel 是把 beta 头写进**传入的 headers 对象**,早先探活传的是字面量 {}——
  // 后缀剥了、头丢了,上游收到"裸模型名 + 无 beta",声明 1m 的站(anyrouter 的
  // claude-fable-5-1)一律回 400「请启用 1m 上下文后重试」,渠道能用却永远显示测试失败。
  const created = JSON.parse((await rawRequest(uiPort, 'POST', '/api/providers', {
    body: { app: 'claude', name: '探活 1m 渠道', base_url: `http://127.0.0.1:${mockPort}`, api_key: 'sk-test-1m', models: ['beta-model[1m]'] },
  })).text);
  const before = mock.requests.length;
  const r = JSON.parse((await rawRequest(uiPort, 'POST', `/api/providers/${created.id}/test`, { body: {} })).text);
  assert.strictEqual(r.ok, true, `探活应通过: ${JSON.stringify(r)}`);
  assert.strictEqual(r.model, 'beta-model', '后缀必须剥掉再发');
  const sent = mock.requests[before];
  assert.ok(sent, '探活必须真的打上游');
  assert.ok(String(sent.headers['anthropic-beta'] || '').includes(BETA), `必须带上 ${BETA},实际: ${sent.headers['anthropic-beta']}`);
  assert.strictEqual(sent.body.model, 'beta-model');
  await rawRequest(uiPort, 'DELETE', `/api/providers/${created.id}`);
});

test('探活:models[0] 无 1m 后缀时不发 beta 头', async () => {
  const created = JSON.parse((await rawRequest(uiPort, 'POST', '/api/providers', {
    body: { app: 'claude', name: '探活裸渠道', base_url: `http://127.0.0.1:${mockPort}`, api_key: 'sk-test-plain', models: ['plain-model'] },
  })).text);
  const before = mock.requests.length;
  const r = JSON.parse((await rawRequest(uiPort, 'POST', `/api/providers/${created.id}/test`, { body: {} })).text);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(mock.requests[before].headers['anthropic-beta'], undefined);
  await rawRequest(uiPort, 'DELETE', `/api/providers/${created.id}`);
});

test('槽位备池:主渠道 402 时换池里下一个渠道(修复前槽位是单点,没得换)', async () => {
  // 槽位命中在 resolve.js 里"优先于一切规则"且直接 return,所以备池只能在 resolveSlot
  // 里进 rule.pool。修复前 slot.rule.pool 恒为 [],即使池里配了渠道也不会被使用。
  const slotA = await mkClaudeProvider('槽位主渠道A', 'sk-slotpool-a-0001');
  const slotB = await mkClaudeProvider('槽位备渠道B', 'sk-slotpool-b-0002');
  const rulesSave = mod._state.routes;
  const slotsSave = structuredClone(mod._state.slotMap);
  const mockSave = mock.requests.length;
  // 槽位带备池:优先级策略,主渠道 A 在前
  mod._state.routes = { rules: [], default: { provider: '', model: '' } };
  mod._state.slotMap = { claude: { haiku: { provider: slotA, model: 'claude-opus-5',
    pool: [{ provider: slotB, model: 'claude-opus-5' }], strategy: 'priority' } }, codex: {} };
  mod._state.resetPools();
  mod._state.sessions.delete('cc:slotpool1');

  // A 只 402 一次,B 正常 —— 备池生效则客户端拿到 200 而非 402
  mock.setSseWrappedError(402, 'Budget pool quota has been exhausted.', 1);
  const r = await claudeSend('mixr-haiku', 'slotpool1');
  assert.strictEqual(r.status, 200, '槽位主渠道 402 应换备池渠道,不该把 402 抛给客户端');
  const used = mock.requests.slice(mockSave).map(x => x.headers['x-api-key']);
  assert.ok(used.includes('sk-slotpool-a-0001'), '第一条应打在主渠道 A');
  assert.ok(used.includes('sk-slotpool-b-0002'), '402 之后应换到备池渠道 B');
  const logs = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs')).text);
  const entry = logs.logs.find(l => l.model_in === 'mixr-haiku');
  assert.ok(entry, '这一轮要留下请求日志');
  assert.strictEqual(entry.failover, true, '日志要记下这次是失败转移来的');

  mod._state.routes = rulesSave;
  mod._state.slotMap = slotsSave;
  mod._state.sessions.delete('cc:slotpool1');
  mod._state.resetPools();
  await rawRequest(uiPort, 'DELETE', `/api/providers/${slotA}`);
  await rawRequest(uiPort, 'DELETE', `/api/providers/${slotB}`);
});

test('槽位备池用 priority 策略:主渠道健康时不会被轮询打到备渠道', async () => {
  // 槽位的策略以前被 resolve.js 写死 round_robin,配了主备也会被打散——
  // 主渠道明明可用,请求却轮着落到备渠道上(每个渠道各打一次,而不是都打主选)。
  const slotA = await mkClaudeProvider('策略主渠道A', 'sk-strat-a-0001');
  const slotB = await mkClaudeProvider('策略备渠道B', 'sk-strat-b-0002');
  const rulesSave = mod._state.routes;
  const slotsSave = structuredClone(mod._state.slotMap);
  const mockSave = mock.requests.length;
  mod._state.routes = { rules: [], default: { provider: '', model: '' } };
  mod._state.slotMap = { claude: { haiku: { provider: slotA, model: 'claude-opus-5',
    pool: [{ provider: slotB, model: 'claude-opus-5' }], strategy: 'priority' } }, codex: {} };
  mod._state.resetPools();
  for (const sid of ['cc:strat1', 'cc:strat2', 'cc:strat3']) mod._state.sessions.delete(sid);

  // 连发三次;priority 下三次都该落在主渠道 A(轮询会打散到 A/B/A 或类似)
  for (const sid of ['cc:strat1', 'cc:strat2', 'cc:strat3']) {
    const r = await claudeSend('mixr-haiku', sid);
    assert.strictEqual(r.status, 200);
  }
  const used = mock.requests.slice(mockSave).map(x => x.headers['x-api-key']);
  assert.strictEqual(used.length, 3, '三次请求各打一次上游');
  assert.deepStrictEqual(used, ['sk-strat-a-0001', 'sk-strat-a-0001', 'sk-strat-a-0001'],
    'priority 策略下主渠道可用时,三次都该走主渠道,不该轮询到备渠道');

  mod._state.routes = rulesSave;
  mod._state.slotMap = slotsSave;
  for (const sid of ['cc:strat1', 'cc:strat2', 'cc:strat3']) mod._state.sessions.delete(sid);
  mod._state.resetPools();
  await rawRequest(uiPort, 'DELETE', `/api/providers/${slotA}`);
  await rawRequest(uiPort, 'DELETE', `/api/providers/${slotB}`);
});
