'use strict';
// /v1/responses/compact 接线的独立回归。只跑本地 loopback 假上游与临时数据目录,
// 不读真实凭据、不碰常驻服务端口。
//
// 要钉死的已提交语义(合并期间不许被改掉):
//   · compact 归 Codex 组,kind='responses/compact';Responses 协议渠道**原样透传**到上游
//     的 /v1/responses/compact(不翻译、不降级、不悄悄落到 /v1/responses);
//   · 只有 chat 协议的渠道时不打上游,直接回 501,且错误分类是 unsupported_compaction
//     —— "chat 网关不支持原生压缩"是能力边界,不是上游故障,不能算渠道失败;
//   · 501 的错误体必须是 OpenAI 形状(codex 组),不是 Anthropic 形状;
//   · HEAD 探活对所有已登记端点(含 compact)回 200,且不触上游;
//   · 转发用的凭据是渠道自己的 key(Bearer),不带 Anthropic 的 x-api-key;
//   · 成功与 501 都要落进 /api/logs,kind/wire/status/err_class 可供审计。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMockUpstream } = require('./mock-upstream.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-respcompact-'));
// 全部运行时路径都指向本次的临时目录:不读真实渠道凭据,也不写真实数据文件
process.env.HOME = TMP;
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_ZCODE_CONFIG = path.join(TMP, 'zcode.json');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXROUTER_PORT = '0';
process.env.MIXUI_PORT = '0';

const mod = require('../mixrouter.js');
const { classifyProxyRequest, wireOf, upstreamPathOf, _state } = mod;

const mock = createMockUpstream();
let proxySrv, uiSrv, proxyPort, uiPort;
const sockets = new Set();

// 只读的 HTTP 客户端:返回状态、响应头与整段文本,便于断言错误体形状
function request(port, method, reqPath, { headers = {}, body, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const creq = http.request({
      hostname: '127.0.0.1', port, method, path: reqPath,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
        json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    creq.setTimeout(timeoutMs, () => creq.destroy(new Error('test request timeout')));
    creq.on('error', reject);
    if (data) creq.write(data);
    creq.end();
  });
}

// 发一个 compact 请求,并把这次请求在假上游留下的记录一并带回来(没打上游则为 null)
async function compact(body, { headers = {}, model } = {}) {
  const before = mock.requests.length;
  const payload = { model, ...body };
  const r = await request(proxyPort, 'POST', '/v1/responses/compact', {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'codex_exec/0.154.0',
      'session-id': 'compact-sess',
      // 客户端自己带的 Anthropic 头:验证它们不会被撒给 OpenAI 协议上游
      'anthropic-version': '2023-06-01',
      ...headers,
    },
    body: payload,
  });
  const hit = mock.requests.length > before ? mock.requests.at(-1) : null;
  return { ...r, hit, json: () => JSON.parse(r.text) };
}

const logs = async (query = '') => JSON.parse((await request(uiPort, 'GET', `/api/logs${query}`)).text).logs;

before(async () => {
  await new Promise(ok => mock.server.listen(0, '127.0.0.1', ok));
  mock.server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const base = `http://127.0.0.1:${mock.server.address().port}`;
  const providers = {
    claude: [],
    codex: [
      { id: 'k-resp', name: 'responses-b', base_url: base, api_key: 'sk-resp', enabled: true, model: 'gpt-5.6-sol', wire_api: 'responses' },
      { id: 'k-chat', name: 'chat-only', base_url: base, api_key: 'sk-chat', enabled: true, model: 'glm-5.3-flash', wire_api: 'chat' },
    ],
  };
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({ version: 2, current: { claude: null, codex: null }, ...providers }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({ rules: [], default: { provider: '', model: '' } }));
  _state.store = providers;
  _state.routes = {
    rules: [
      { id: 'rc-resp', app: 'codex', match: 'gpt', pool: ['k-resp'], enabled: true },
      { id: 'rc-chat', app: 'codex', match: 'glm', pool: ['k-chat'], enabled: true },
    ].map(mod.normalizeRule),
    default: mod.normalizeRule({ provider: '', model: '' }),
  };
  _state.resetPools();
  _state.sessions.clear();
  _state.cooldowns = {};

  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([proxySrv, uiSrv, mock.server].filter(Boolean).map(server => new Promise(resolve => {
    try { server.closeAllConnections(); } catch {}
    server.close(() => resolve());
  })));
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 端点归属(纯函数)
test('compact 端点归 Codex 组,上游路径换算对它保持自身路径', () => {
  for (const url of ['/v1/responses/compact', '/v1/responses/compact/', '/v1/responses/compact?x=1']) {
    const ep = classifyProxyRequest({ url });
    assert.equal(ep.app, 'codex', url);
    assert.equal(ep.kind, 'responses/compact', url);
    assert.equal(ep.path, '/v1/responses/compact', url);
  }
  // 与 /v1/responses 不是同一个端点,不能被前者的正则吞掉
  assert.equal(classifyProxyRequest({ url: '/v1/responses' }).kind, 'responses');
  assert.equal(classifyProxyRequest({ url: '/v1/responses/compactx' }), null);

  const ep = classifyProxyRequest({ url: '/v1/responses/compact' });
  assert.equal(upstreamPathOf('responses', ep), '/v1/responses/compact', 'responses 线上游就是 compact 自身');
  assert.equal(upstreamPathOf('chat', ep), '/v1/chat/completions', 'chat 线只认 completions');
  assert.equal(wireOf({ wire_api: 'chat' }, 'codex'), 'chat');
  assert.equal(wireOf({ wire_api: 'responses' }, 'codex'), 'responses');
});

// ---------------------------------------------------------------- HEAD 探活
test('HEAD /v1/responses/compact 回 200 且不触上游', async () => {
  const before = mock.requests.length;
  const r = await request(proxyPort, 'HEAD', '/v1/responses/compact');
  assert.equal(r.status, 200);
  assert.equal(r.text, '', 'HEAD 不该带响应体');
  assert.equal(mock.requests.length, before, '探活不能打上游');
});

// ---------------------------------------------------------------- Responses 渠道:原样透传
test('compact 落到 responses 渠道:原样透传到 /v1/responses/compact,字段与凭据都不改', async () => {
  const payload = {
    instructions: 'You are a coding agent.',
    store: false,
    stream: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '压缩这段历史' }] }],
    // 压缩类请求常见的附加字段:透传语义下必须原样出现在出站体里
    prompt_cache_key: 'cache-keep-me',
  };
  const r = await compact(payload, { model: 'gpt-5.6-sol' });

  assert.equal(r.status, 200);
  assert.ok(r.hit, '应当打到上游');
  assert.equal(r.hit.url, '/v1/responses/compact', '上游路径必须是 compact 自身,不能退化成 /v1/responses');
  assert.equal(r.hit.headers.authorization, 'Bearer sk-resp', '用渠道自己的 key');
  assert.equal(r.hit.headers['x-api-key'], undefined, 'OpenAI 协议上游不该收到 Anthropic 鉴权头');
  assert.equal(r.hit.headers['anthropic-version'], undefined, 'Anthropic 版本头也不该被撒出去');
  assert.equal(r.hit.headers['session-id'], 'compact-sess', '会话 id 透传(上游侧缓存粘性用)');

  assert.equal(r.hit.body.model, 'gpt-5.6-sol');
  assert.equal(r.hit.body.instructions, payload.instructions, 'responses 协议原样透传,不做字段删改');
  assert.equal(r.hit.body.store, false);
  assert.equal(r.hit.body.prompt_cache_key, 'cache-keep-me');
  assert.deepEqual(r.hit.body.input, payload.input);

  assert.equal(r.headers['x-mixrouter-app'], 'codex');
  assert.ok(r.text.includes('mock-echo:gpt-5.6-sol'), '响应原样回给客户端');

  const log = (await logs('?model=gpt-5.6-sol'))[0];
  assert.equal(log.app, 'codex');
  assert.equal(log.kind, 'responses/compact', '日志里要能分辨这是 compact,不是普通 responses');
  assert.equal(log.wire, 'responses');
  assert.equal(log.status, 200);
  assert.equal(log.provider, 'responses-b');
  assert.deepEqual({ in: log.in, out: log.out, cache_read: log.cache_read }, { in: 21, out: 13, cache_read: 4 });
});

// ---------------------------------------------------------------- Chat 渠道:501 且不打上游
test('compact 落到 chat 渠道:回 501 unsupported_compaction,不打上游', async () => {
  const before = mock.requests.length;
  const r = await compact({ instructions: 'x', input: [], store: false }, { model: 'glm-5.3-flash' });

  assert.equal(r.status, 501);
  assert.equal(mock.requests.length, before, 'chat 渠道收不了原生压缩,不该白打一次上游');

  // codex 组要的是 OpenAI 形状错误体:Anthropic 形状客户端只会打印一句无法解析的报错
  const body = r.json();
  assert.ok(body.error, '错误体必须是 OpenAI 形状(顶层 error 对象)');
  assert.equal(body.type, undefined, '不该是 Anthropic 的顶层 type=error');
  assert.match(body.error.message, /Chat 渠道不支持原生 Responses 压缩/);
  assert.equal(body.error.code, 'invalid_request_error', 'code 是传下来的协议分类名');
  assert.equal(body.error.type, 'invalid_request', 'openaiError 会把 _error 后缀去掉当 type');
  assert.deepEqual(Object.keys(body).sort(), ['error'], '不夹带 Anthropic 形状的字段');

  const log = (await logs('?model=glm-5.3-flash'))[0];
  assert.equal(log.status, 501);
  assert.equal(log.err_class, 'unsupported_compaction', '这是能力边界,不是渠道故障:不能算渠道失败');
  assert.equal(log.kind, 'responses/compact');
  assert.equal(log.model_in, 'glm-5.3-flash');
  assert.equal(log.attempts, 0, '没打上游就不该记尝试次数');
});

test('compact 的失败不会把 chat 渠道标成不可用(后续请求照常)', async () => {
  // 501 是能力边界而不是上游故障:熔断/冷却若被它触发,会把一条健康的 chat 渠道
  // 从池子里摘掉,同池的普通 responses 请求跟着一起遭殃。
  const r = await compact({ instructions: 'y', input: [], store: false }, { model: 'glm-5.3-flash' });
  assert.equal(r.status, 501);
  const view = mod.healthStatus().providers.find(p => p.provider === 'k-chat');
  assert.ok(view, 'chat 渠道应当出现在健康视图里');
  assert.equal(view.state, 'closed', 'chat 渠道不该因为 501 被熔断');
  assert.equal(view.failures, 0, '501 不该计入渠道失败次数');
  assert.equal(view.eligible, true);
  const follow = await request(proxyPort, 'POST', '/v1/responses', {
    headers: { 'Content-Type': 'application/json', 'session-id': 'after-501' },
    body: { model: 'glm-5.3-flash', stream: false, input: [] },
  });
  assert.equal(follow.status, 200, 'chat 渠道在 501 之后仍然可用');
});

// ---------------------------------------------------------------- 未知端点仍是 Anthropic 形状
test('未登记的端点回 404,且错误体仍是 Anthropic 形状(与 compact 的 501 分得开)', async () => {
  const r = await request(proxyPort, 'POST', '/v1/embeddings', {
    headers: { 'Content-Type': 'application/json' }, body: { model: 'x' },
  });
  assert.equal(r.status, 404);
  const body = r.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'not_found_error');
});
