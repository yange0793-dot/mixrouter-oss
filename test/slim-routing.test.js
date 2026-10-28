'use strict';
// 瘦身后的路由语义:slim-routing。
//
// 这一份钉的是**删掉了什么**与**留下什么真的还按精确规则走**:
//   1. 旧 routes.json 里的普通规则(match 子串)与可配置 default 不再执行(历史数据不报错、也不生效)
//   2. 精确已登记模型 → 唯一渠道才放行(大小写不敏感、剥 [1m] 后缀)
//   3. 同一模型登记在多个渠道 → 明确的模型歧义错误,不随机挑;会话显式钉定可以解开
//   4. 没有渠道登记该模型 → no_route_error
//   5. 压缩规则先于精确模型(真压缩请求才命中;正文引用特征串不算)
//   6. 槽位别名仍优先,槽位备池照旧;槽位请求不写会话绑定
//   7. ZCode / Harness / 通用规则 API 的端点已经不在了
//
// 全部在临时 MIXR_DATA_DIR 与回环上游上跑,不碰真实配置。
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { FIXED_PREFIX, MARKER } = require('../lib/routing/compact-signature');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-slim-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude-settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXROUTER_PORT = '0';
process.env.MIXUI_PORT = '0';

const mod = require('../mixrouter');

const GLOBAL_BODY = 'your task is to create a detailed summary of';

let ui, proxy, upstream, base;
let proxyPort, uiPort;
const hits = [];

const request = (port, method, route, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? '' : JSON.stringify(body);
  const req = http.request({ hostname: '127.0.0.1', port, method, path: route,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } },
  res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(text); } catch {}
      resolve({ status: res.statusCode, text, json });
    });
  });
  req.on('error', reject);
  req.end(data);
});
const api = (method, route, body) => request(uiPort, method, route, body);
const callProxy = (body, headers = {}) => request(proxyPort, 'POST', '/v1/messages', body, headers);

const provider = (id, extra = {}) => ({ id, name: id, base_url: base, api_key: `sk-${id}`,
  enabled: true, models: [], ...extra });

// 一条真压缩指令:固定前导 + 摘要模板(判据见 lib/routing/compact-signature.js)
const COMPACT_INSTRUCTION = FIXED_PREFIX + 'Your task is to create a detailed summary of the conversation so far.';
const compactMessages = () => [{ role: 'user', content: [{ type: 'text', text: COMPACT_INSTRUCTION }] }];

const summaryRule = (id, providerId, model) => ({
  id, match: '', app: 'claude', enabled: true, priority: 90, when: { body: GLOBAL_BODY },
  provider: providerId, model, pool: [], strategy: 'priority',
});

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      hits.push(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'mock', type: 'message', model: body.model, role: 'assistant',
        content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${upstream.address().port}`;
  ui = await mod.listen(0, mod.apiHandler);
  proxy = await mod.listen(0, mod.proxyHandler);
  uiPort = ui.address().port;
  proxyPort = proxy.address().port;
});

after(async () => {
  await new Promise(ok => ui.close(ok));
  await new Promise(ok => proxy.close(ok));
  await new Promise(ok => upstream.close(ok));
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  mod._state.store = {
    claude: [
      provider('pa', { models: ['claude-opus-5', 'shared-model'] }),
      provider('pb', { models: ['claude-sonnet-5', 'shared-model'] }),
      provider('pc', { models: ['claude-haiku-5'] }),
      provider('off', { enabled: false, models: ['disabled-model'] }),
      provider('nokey', { api_key: '', models: ['keyless-model'] }),
    ],
    codex: [],
  };
  // 旧磁盘数据:普通规则 + 兜底路由。它们必须**原样留在内存里**(历史数据不破坏),
  // 但不参与任何判定 —— 这正是下面第一条用例要证明的。
  mod._state.routes = {
    rules: [
      { id: 'legacy-opus', match: 'claude-opus-5', provider: 'pb', model: 'pb-model', enabled: true, priority: 0, when: {} },
      { id: 'legacy-any', match: '', provider: 'pc', model: 'pc-model', enabled: true, priority: 0, when: { session: 'anything' } },
    ],
    default: { provider: 'pc', model: 'pc-model', pool: [], strategy: 'round_robin' },
  };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.sessions.clear();
  mod._state.current = { claude: null, codex: null };
  mod._state.resetPools();
  hits.length = 0;
});

// ---------------------------------------------------------------- 1. 普通规则与 default 失效
test('旧普通规则与可配置 default 不再执行:只有精确登记的模型能落到它自己的渠道', async () => {
  // legacy-opus 声称 claude-opus-5 应走 pb,legacy-any 声称任何会话都走 pc,default 也指 pc。
  // 精确模型判定必须无视它们:claude-opus-5 只登记在 pa。
  const r = await callProxy({ model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    { 'x-claude-code-session-id': 'slim-legacy-1' });
  assert.equal(r.status, 200, r.text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].model, 'claude-opus-5', '落点模型取自渠道登记,不是旧规则的 model');
  assert.equal(r.json.model, 'claude-opus-5');

  // 旧规则里的 match 子串也不再能"顺手"兜住一个没登记的模型
  const miss = await callProxy({ model: 'totally-unregistered', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    { 'x-claude-code-session-id': 'slim-legacy-2' });
  assert.equal(miss.status, 503, '没有登记就是 503,旧 default 不再兜底');
  assert.equal(miss.json.error.type, 'no_route_error');
  assert.equal(hits.length, 1, '未登记的模型不该产生任何上游调用');
});

test('旧规则仍原样留在活配置里,不被读请求改动', async () => {
  const before = JSON.stringify(mod._state.routes);
  assert.equal((await api('GET', '/api/state')).status, 200);
  assert.equal((await api('GET', '/api/compact')).status, 200);
  assert.equal(JSON.stringify(mod._state.routes), before, '历史规则不得被读路径改写或清理');
});

// ---------------------------------------------------------------- 2. 精确模型路由
test('精确登记模型:大小写与 [1m] 后缀不影响命中,落点用渠道登记的模型名', async () => {
  const upper = await callProxy({ model: 'Claude-Opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    { 'x-claude-code-session-id': 'slim-case-1' });
  assert.equal(upper.status, 200, upper.text);

  const oneM = await callProxy({ model: 'claude-sonnet-5[1m]', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    { 'x-claude-code-session-id': 'slim-case-2' });
  assert.equal(oneM.status, 200, oneM.text);
  // [1m] 只改窗口,前端要真把 beta 头带上、模型名要裸发
  assert.equal(hits[hits.length - 1].model, 'claude-sonnet-5', '[1m] 后缀必须剥掉再发给上游');
});

test('停用渠道与没有可用 Key 的渠道都不算"已登记",不能命中', async () => {
  for (const model of ['disabled-model', 'keyless-model']) {
    const r = await callProxy({ model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
      { 'x-claude-code-session-id': `slim-unusable-${model}` });
    assert.equal(r.status, 503, `${model}: ${r.text}`);
    assert.equal(r.json.error.type, 'no_route_error');
  }
  assert.equal(hits.length, 0);
});

// ---------------------------------------------------------------- 3. 歧义
test('同一模型登记在多个渠道:明确报模型歧义,不随机挑一个', async () => {
  const r = await callProxy({ model: 'shared-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    { 'x-claude-code-session-id': 'slim-amb-1' });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.type, 'error');
  assert.equal(r.json.error.type, 'model_ambiguous_error');
  assert.match(r.json.error.message, /shared-model/);
  assert.match(r.json.error.message, /pa/);
  assert.match(r.json.error.message, /pb/);
  assert.equal(hits.length, 0, '歧义时不得发出任何上游请求');
});

test('歧义由会话的显式钉定解开:钉在 pa 就走 pa', async () => {
  mod._state.sessions.set('cc:slim-amb-2', { app: 'claude', providerId: 'pa', model: '', ruleId: '',
    label: '', kind: 'header', created: Date.now(), lastUsed: Date.now(), reqs: 0, inTok: 0, outTok: 0, pinned: true });
  const r = await callProxy({ model: 'shared-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    { 'x-claude-code-session-id': 'slim-amb-2' });
  assert.equal(r.status, 200, r.text);
  assert.equal(hits.length, 1);
  assert.equal(r.json.model, 'shared-model');
});

// ---------------------------------------------------------------- 4. 压缩优先
test('真压缩请求命中压缩规则,先于精确模型(即使模型名也登记在别的渠道)', async () => {
  mod._state.routes = {
    rules: [summaryRule('compact-global', 'pc', 'compact-model')],
    default: { provider: '', model: '' },
  };
  // 请求模型是 claude-opus-5(登记在 pa),但这是压缩请求 → 必须走压缩规则指定的 pc/compact-model
  const r = await callProxy({ model: 'claude-opus-5', max_tokens: 8, messages: compactMessages() },
    { 'x-claude-code-session-id': 'slim-compact-1' });
  assert.equal(r.status, 200, r.text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].model, 'compact-model', '压缩请求的落点模型来自压缩规则');
});

test('正文里引用压缩特征串的普通请求不算压缩,照旧走精确模型', async () => {
  mod._state.routes = {
    rules: [summaryRule('compact-global', 'pc', 'compact-model')],
    default: { provider: '', model: '' },
  };
  // 不是压缩指令:没有固定前导,只是正文里提到了摘要模板与标记
  const r = await callProxy({ model: 'claude-opus-5', max_tokens: 8,
    messages: [{ role: 'user', content: `请复述这段规则: ${GLOBAL_BODY} 以及 ${MARKER}` }] },
  { 'x-claude-code-session-id': 'slim-compact-2' });
  assert.equal(r.status, 200, r.text);
  assert.equal(hits[0].model, 'claude-opus-5', '引用特征串的普通任务不能被判成压缩');
});

// ---------------------------------------------------------------- 5. 槽位
test('槽位别名精确命中并优先于精确模型;槽位备池可用,落点模型取槽位配置', async () => {
  mod._state.slotMap = { claude: { main: { provider: 'pc', model: 'slot-model',
    pool: [{ provider: 'pa', model: 'slot-backup-model' }], strategy: 'priority' } }, codex: {} };
  const r = await callProxy({ model: 'mixr-main', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    { 'x-claude-code-session-id': 'slim-slot-1' });
  assert.equal(r.status, 200, r.text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].model, 'slot-model');
  // 槽位请求不写会话绑定:别名只代表"这一条请求照槽位走"
  const binding = mod._state.sessions.get('cc:slim-slot-1');
  assert.ok(!binding || !binding.providerId, '槽位请求不得把对话绑到槽位渠道');
});

test('槽位别名在表里但没绑渠道:明确失败,不静默落到精确模型', async () => {
  mod._state.slotMap = { claude: { haiku: { provider: '', model: '' } }, codex: {} };
  const r = await callProxy({ model: 'mixr-haiku', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    { 'x-claude-code-session-id': 'slim-slot-2' });
  assert.equal(r.status, 503, r.text);
  assert.equal(r.json.error.type, 'no_route_error');
  assert.equal(hits.length, 0);
});

// ---------------------------------------------------------------- 6. 端点移除
test('通用规则写入已删除:PUT /api/routes 固定 410,且不改内存、不落盘', async () => {
  const before = JSON.stringify(mod._state.routes);
  const r = await api('PUT', '/api/routes', { rules: [], default: {} });
  assert.equal(r.status, 410, r.text);
  assert.equal(JSON.stringify(mod._state.routes), before);
  assert.equal(fs.existsSync(path.join(TMP, 'routes.json')), false, '410 不该留下路由落盘');
});

test('Harness 集成已删除:/api/harness* 与 /harness/v1/* 都不再存在', async () => {
  for (const [method, route] of [['GET', '/api/harness'], ['PUT', '/api/harness'],
    ['POST', '/api/harness/preview'], ['POST', '/api/harness/connect']]) {
    const r = await api(method, route, method === 'GET' ? undefined : {});
    assert.equal(r.status, 404, `${method} ${route} 应已移除,实得 ${r.status} ${r.text}`);
  }
  for (const route of ['/harness/v1/models', '/harness/v1/messages']) {
    const r = await request(proxyPort, route.endsWith('models') ? 'GET' : 'POST', route,
      route.endsWith('models') ? undefined : { model: 'claude-opus-5', messages: [] });
    assert.equal(r.status, 404, `${route} 应已移除,实得 ${r.status} ${r.text}`);
  }
});

test('ZCode 已删除:控制台的 state 不再有 routes / zcode,切 ZCode 被明确拒绝', async () => {
  const state = await api('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.routes, undefined, '路由表只经 /api/compact 暴露');
  assert.equal(state.json.routes_revision, undefined);
  assert.equal(state.json.live.zcode, undefined);
  assert.equal(state.json.router.zcode_base, undefined);

  const sw = await api('POST', '/api/switch/pa', { app: 'zcode' });
  assert.equal(sw.status, 400, sw.text);
  assert.match(sw.json.error || sw.text, /claude|codex|未知客户端/);
  const router = await api('POST', '/api/router/zcode', {});
  assert.equal(router.status, 400, router.text);
});
