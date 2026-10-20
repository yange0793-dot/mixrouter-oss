'use strict';
// Q3:预览的 error.code / httpStatus 必须与**实跑** mixrouter.js 的 protoError 逐字对齐。
//
// 为什么单独一个文件:本文件 require 真实的 mixrouter.js 并起监听,而
// test/routing-preview.test.js 从头到尾是注入式、不 require 服务。两者隔离要求不同,
// 混在一起会让那个文件的"纯注入"前提失效。
// 进程模型已实测:node --test 每个测试文件**独立子进程**(NODE_TEST_CONTEXT=child-v8,
// PID 各不相同),所以本文件改写单例状态不会污染别的文件。
//
// 对齐方式**刻意不抄常量**:对每个错误码各发一次真实请求触发同一条错误路径,
// 断言 HTTP 状态码与响应体的 type 字段与 explain 给出的 httpStatus/code 相同。
// 抄字符串对齐会在 mixrouter.js 改文案/改类型时静默失效,只有两侧输出比对能锁住。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-preview-q3-'));
// require 之前把数据与配置全部指向临时目录:不读真实 providers/sessions/routes/slots
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude', 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex', 'config.toml');
process.env.MIXR_ZCODE_CONFIG = path.join(TMP, 'zcode', 'config.json');
// 预览与实跑的对照里会真打一个死端口,间隔关掉免得整条用例耗在等待上
process.env.MIXR_RETRY_DELAY_MS = '0';

const mod = require('../mixrouter.js');
const { createExplainer } = require('../lib/routing/explain.js');
const { FIXED_PREFIX, COMPACT_RULES } = require('../lib/routing/compact-signature.js');

let proxy, upstream, upBase;
const EXTERNAL_UPSTREAM = 'http://127.0.0.1:1';   // 刻意不可达:这些用例都在打上游**之前**就被拦下

const proxyPort = () => proxy.address().port;

function req(pathname, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ hostname: '127.0.0.1', port: proxyPort(), method, path: pathname,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      const cs = [];
      res.on('data', c => cs.push(c));
      res.on('end', () => {
        const text = Buffer.concat(cs).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    r.on('error', reject);
    r.end(data);
  });
}

// explain 的 deps:全部只读地从现役服务取,与本文件起的监听同一份状态
const explainDeps = () => ({
  getRoutes: () => mod._state.routes,
  storeOf: app => (app === 'codex' ? mod._state.store.codex : mod._state.store.claude),
  resolveSlot: (app, m) => mod.resolveSlot(app, m),
  findProvider: id => [...mod._state.store.claude, ...mod._state.store.codex].find(p => p.id === id) || null,
  providerApp: id => mod._state.store.claude.some(p => p.id === id) ? 'claude'
    : (mod._state.store.codex.some(p => p.id === id) ? 'codex' : null),
  listPools: () => mod._state.pools,               // 主会话新加的 getter
  inCooldown: id => mod.inCooldown(id),
  healthEligible: id => mod.providerEligible(id),
  sessionCounts: () => ({}),
  uiPort: 8788,
});

before(async () => {
  upstream = http.createServer((_q, s) => { s.writeHead(200, { 'content-type': 'application/json' }); s.end('{}'); });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  upBase = `http://127.0.0.1:${upstream.address().port}`;
  proxy = await mod.listen(0, mod.proxyHandler);
});
after(() => {
  try { proxy && proxy.close(); } catch {}
  try { upstream && upstream.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const P = (id, extra = {}) => ({ id, name: '渠道-' + id, base_url: EXTERNAL_UPSTREAM, api_key: 'sk-q3-' + id,
  models: ['m1'], enabled: true, ...extra });

function setState({ claude, codex = [], routes }) {
  mod._state.store = { claude, codex };
  mod._state.routes = routes;
}

// ---------------------------------------------------------------- 有实跑对应路径的码
test('Q3:provider_key_unavailable —— 压缩 pin 预览与实跑状态码/类型/文案相同', async () => {
  const summary = FIXED_PREFIX + 'Your task is to create a detailed summary of this conversation.';
  setState({ claude: [P('pa')], routes: { rules: [rule({ app: 'claude', provider: 'pa', key_id: 'removed',
    when: { body: COMPACT_RULES[0].body } })], default: {} } });
  const live = await req('/v1/messages', 'POST', { model: 'q3compact', max_tokens: 8,
    messages: [{ role: 'user', content: summary }] });
  const prev = createExplainer(explainDeps())({ app: 'claude', model: 'q3compact', context: { compactTexts: [summary] } });
  assert.equal(live.status, 503);
  assert.equal(live.json.error.type, 'provider_key_unavailable_error');
  assert.equal(prev.error.httpStatus, live.status);
  assert.equal(prev.error.code, live.json.error.type);
  assert.equal(prev.error.message, live.json.error.message);
});

test('Q3:provider_disabled —— explain 与实跑的状态码/类型逐字相同(Claude 侧)', async () => {
  setState({ claude: [P('pdead', { enabled: false })], routes: { rules: [rule({ id: 'd', match: 'q3dead', provider: 'pdead' })], default: {} } });
  const live = await req('/v1/messages', 'POST', { model: 'q3dead', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
  const prev = createExplainer(explainDeps())({ app: 'claude', model: 'q3dead' });

  assert.equal(live.status, 503);
  assert.equal(live.json.error.type, 'provider_disabled_error');   // anthropicError:error.type 带后缀
  assert.equal(prev.error.httpStatus, live.status, 'httpStatus 必须与实跑相同');
  assert.equal(prev.error.code, live.json.error.type, 'code 必须与实跑的 error.type 逐字相同');
});

test('Q3:no_route —— explain 与实跑的状态码/类型逐字相同(Claude 侧)', async () => {
  setState({ claude: [P('pa')], routes: { rules: [rule({ id: 'g', match: 'q3ghost', provider: 'gone' })], default: {} } });
  const live = await req('/v1/messages', 'POST', { model: 'q3ghost', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
  const prev = createExplainer(explainDeps())({ app: 'claude', model: 'q3ghost' });

  assert.equal(live.status, 503);
  assert.equal(live.json.error.type, 'no_route_error');
  assert.equal(prev.error.httpStatus, live.status);
  assert.equal(prev.error.code, live.json.error.type);
});

test('Q3:wire_api_mismatch —— Codex 侧 error.type 去后缀、error.code 带后缀,两侧都要对', async () => {
  setState({
    claude: [P('pa')],
    codex: [P('px', { model: 'xm', wire_api: 'responses' })],
    routes: { rules: [rule({ id: 'c', match: 'q3gpt', provider: 'px', app: 'codex' })], default: {} },
  });
  const live = await req('/v1/chat/completions', 'POST', { model: 'q3gpt', messages: [{ role: 'user', content: 'hi' }] });
  const prev = createExplainer(explainDeps())({ app: 'codex', model: 'q3gpt', kind: 'chat/completions' });

  assert.equal(live.status, 400);
  // openaiError:{error:{message, type: type.replace(/_error$/,''), code: type}} —— 落点与 anthropic 不同
  assert.equal(live.json.error.type, 'wire_api_mismatch', 'Codex 侧 error.type 不带后缀');
  assert.equal(live.json.error.code, 'wire_api_mismatch_error', 'Codex 侧 error.code 带后缀');
  assert.equal(prev.error.httpStatus, live.status);
  // explain 给的是完整 type(带后缀);与实跑的 error.**code** 对齐,也正是 API 层要用的那个
  assert.equal(prev.error.code, live.json.error.code, 'code 必须与实跑的 error.code 逐字相同');
  assert.equal(prev.error.code, 'wire_api_mismatch_error');
});

test('Q3:invalid_request_error —— 实跑有这条路径,explain 不产出该码(不对齐也不冒充)', async () => {
  setState({ claude: [P('pa')], routes: { rules: [], default: { provider: 'pa' } } });
  const live = await req('/v1/messages', 'POST', 'not-json');
  assert.equal(live.status, 400);
  assert.equal(live.json.error.type, 'invalid_request_error');
  // explain 的入参是结构化对象,没有"请求体不是合法 JSON"这种情形 → 它**不该**产出这个码
  const prev = createExplainer(explainDeps())({ app: 'claude', model: 'anything' });
  assert.notEqual(prev.error && prev.error.code, 'invalid_request_error');
});

// ---------------------------------------------------------------- 预览专有码:无实跑路径
test('Q3:bad_app / bad_model 是预览专有 —— 无实跑对应路径,不加 _error 后缀', async () => {
  setState({ claude: [P('pa')], routes: { rules: [], default: { provider: 'pa' } } });
  const ex = createExplainer(explainDeps());

  for (const [input, code] of [[{ app: 'nope', model: 'x' }, 'bad_app'], [{ app: 'claude', model: 42 }, 'bad_model']]) {
    const r = ex(input);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, code);
    assert.equal(r.error.httpStatus, 400);
    assert.equal(/_error$/.test(r.error.code), false, '预览专有码不得带 _error 后缀(加了等于假装对齐)');
  }

  // 证明这两条在实跑里**不可能**被触发(所以无法做两侧比对,不是我没做):
  // 1) app 来自 URL 路径,只有 /v1/messages 与 /v1/responses 两类端点 → 不存在第三个值
  const routes = mod.ENDPOINTS.map(e => e.path);
  assert.ok(routes.length >= 2);
  for (const p of mod.ENDPOINTS) assert.ok(['claude', 'codex'].includes(p.app), `端点 ${p.path} 的 app 只能是 claude/codex`);
  // 2) body.model 被 `body.model || ''` 强制成字符串,数字/对象到不了"类型不对"的分支
  const live = await req('/v1/messages', 'POST', { model: 42, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
  assert.notEqual(live.status, 400, '实跑不会因 model 非字符串而 400(它被强制转换成字符串)');
});

test('Q3:kind_app_mismatch 也是预览专有 —— 实跑按 URL 路径定 kind,不存在"kind 与 app 不匹配"', async () => {
  setState({ claude: [P('pa')], routes: { rules: [], default: { provider: 'pa' } } });
  const r = createExplainer(explainDeps())({ app: 'codex', model: 'x', kind: 'messages' });
  assert.equal(r.error.code, 'kind_app_mismatch');
  assert.equal(r.error.httpStatus, 400);
  assert.equal(/_error$/.test(r.error.code), false);
});

function rule(o = {}) {
  return { id: 'r', match: '', provider: 'pa', model: '', pool: [], strategy: 'round_robin',
    priority: 0, app: '', when: {}, enabled: true, ...o };
}
