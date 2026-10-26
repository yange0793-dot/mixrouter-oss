'use strict';
// 第二期:会话/池状态边界 + 在途请求 guard 的真实入口回归。
//
// 两件事在这里同时钉:
//   1. 池运行状态(轮转游标,以及冷却移除后保留的空壳 cooldowns)从会话模块分出去之后,
//      旧引用语义没变(sess.sessions / sess.pools / sess.cooldowns / resetPools / inCooldown / activeCount)。
//   2. 上游回得慢、控制台先动手(手动重绑 / 解绑 / 清空 / 保存覆盖)时,**先前那条在途
//      请求的响应不能复活旧记录、不能覆盖新绑定或新配置**;仍在同一代上的并发请求
//      必须各自照常结算,不能互相作废。
//
// 上游是本进程内的桩(手动放行,不 sleep 猜时间),HTTP 全部走 127.0.0.1 临时端口,
// 临时 HOME/数据目录,不使用真实渠道与真实 Key。
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-flt-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_COOLDOWN_SEC = '60';
process.env.MIXR_MAX_ATTEMPTS = '2';

const mod = require('../mixrouter.js');
const { _state, normalizeRule } = mod;
const POOL = ['pa', 'pb', 'pc'];
// 三个渠道一个池,轮询策略:哪一条落到哪个渠道不写死(游标是跨请求状态),
// 断言一律以"这一条实际落在哪"为基准,不去猜顺序。
const routeFixture = () => { _state.routes = { rules: [normalizeRule({ id: 'flt', match: 'opus', pool: POOL, strategy: 'round_robin', enabled: true })], default: normalizeRule({}) }; };

// ---- 可控上游:请求到了先挂住,等测试放行才回 200 ----
const pending = [];
const upstream = http.createServer((req, res) => {
  const cs = [];
  req.on('data', c => cs.push(c));
  req.on('end', () => {
    pending.push({ url: req.url, headers: req.headers, res, replied: false });
  });
});
const reply = (i, { in: input = 17, out = 9 } = {}) => {
  const p = pending[i];
  if (!p || p.replied) return;            // 每条只回一次:重复 writeHead 会 ERR_HTTP_HEADERS_SENT
  p.replied = true;
  p.res.writeHead(200, { 'Content-Type': 'application/json' });
  p.res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock',
    content: [{ type: 'text', text: 'mock-echo' }], stop_reason: 'end_turn',
    usage: { input_tokens: input, output_tokens: out } }));
};
const settleAll = () => { for (let i = 0; i < pending.length; i++) reply(i); };
const waitFor = async (fn, what = 'fixture') => {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.fail(`${what} 未在超时前出现`);
};

const KEY_OF = { pa: 'sk-a', pb: 'sk-b', pc: 'sk-c' };
// 出站带的是哪个渠道的 Key → 反推这次落在哪个渠道(渠道名头在给客户端的响应上,不在出站请求里)
const providerOfKey = k => Object.keys(KEY_OF).find(id => KEY_OF[id] === k) || '';
let proxySrv, uiSrv, proxyPort, uiPort;
let sessionNo = 0;
const sessionId = () => `flt-${++sessionNo}-0000-0000-0000-000000000000`;
const keyOf = id => 'cc:' + id;
const shortOf = id => id.slice(0, 8);

function request(port, method, reqPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, method, path: reqPath,
      headers: { ...(data ? { 'Content-Length': Buffer.byteLength(data), 'Content-Type': 'application/json' } : {}), ...headers } },
    res => {
      const cs = [];
      res.on('data', c => cs.push(c));
      res.on('end', () => {
        const text = Buffer.concat(cs).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 发起一条代理请求,不 await 完成:等上游真的收到为止(拿到在途句柄)
async function startProxy(sid, { model = 'claude-opus-5', body = {} } = {}) {
  const before = pending.length;
  const done = request(proxyPort, 'POST', '/v1/messages', {
    headers: { 'x-claude-code-session-id': sid },
    body: { model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...body },
  });
  await waitFor(() => pending.length > before, '上游收到在途请求');
  const hit = pending[pending.length - 1];
  const key = hit.headers['x-api-key'] || String(hit.headers.authorization || '').replace(/^Bearer /, '');
  return { done, hit, key, provider: providerOfKey(key) };
}
const rowOf = async sid => {
  const r = await request(uiPort, 'GET', '/api/sessions');
  return (r.json && r.json.sessions || []).find(s => s.key === keyOf(sid)) || null;
};
// 直接问会话记录(不走接口,免得接口自身的剪枝/口径混进断言)
const recordOf = sid => _state.sessions.get(keyOf(sid));

test('setup:本地可控上游 + 代理/控制台端口', async () => {
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  upstream.unref();
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const prov = id => ({ id, name: '渠道' + id, base_url: base,
    api_key: KEY_OF[id], enabled: true, models: ['claude-opus-5'], slots: {} });
  const provs = ['pa', 'pb', 'pc'].map(prov);
  _state.store = { claude: provs, codex: [] };
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({ version: 2, current: { claude: null, codex: null }, claude: provs, codex: [] }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({ rules: [], default: { provider: '', model: '' } }));
  routeFixture();
  _state.sessions.clear();
  _state.cooldowns = {};
  _state.resetPools();
  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
});

// ---------------------------------------------------------------- 池运行状态边界
test('池运行状态与会话记录分开:sess.sessions / pools / cooldowns 三个引用各归各的视图', () => {
  const sess = _state;
  assert.ok(sess.sessions instanceof Map, '绑定表仍是 Map');
  assert.equal(typeof sess.pools, 'object', '游标表仍可从 sess.pools 读');
  assert.equal(typeof sess.cooldowns, 'object', '兼容冷却字段仍可从 sess.cooldowns 读');
  // 兼容冷却字段与游标都不算会话记录:写它不会长出一条会话
  const before = sess.sessions.size;
  sess.cooldowns = { pz: Date.now() + 60000 };
  assert.equal(sess.sessions.size, before, '写兼容冷却字段不得动绑定表');
  const inCooldown = require('../mixrouter.js').inCooldown;
  assert.equal(inCooldown('pz'), false);
  assert.deepEqual(sess.cooldowns, {});
  // 整份作废游标:getter 必须现取,不能是快照引用
  const poolsRef = sess.pools;
  sess.resetPools();
  assert.notEqual(sess.pools, poolsRef, 'resetPools 后 getter 必须指向新对象');
  assert.deepEqual(sess.pools, {});
  sess.cooldowns = { pz: 0 };
  assert.equal(inCooldown('pz'), false, '旧冷却判定恒为 false');
});

// ---------------------------------------------------------------- 在途请求 guard(模块级)
test('captureRequest/settleRequest:同一代并发请求互不作废,各自累加', () => {
  const store = new (require('../lib/routing/sessions').createSessionStore)({
    sessionsFile: '/nonexistent-flt/sessions.json', ttlMs: 60000, max: 10, cooldownMs: 1000,
    loadJson: () => null, saveJson: () => {}, storeOf: () => [], providerEligible: () => true,
  });
  store.entry('cc:x', 'header', '', 'claude');
  const t1 = store.captureRequest('cc:x');
  const t2 = store.captureRequest('cc:x');
  assert.equal(t1.mark, t2.mark, '同一条记录的并发请求拿同一个代');
  assert.equal(store.settleRequest(t1, { usage: { in: 5, out: 1 } }).ok, true);
  // 第一条结算之后紧接着改一次绑定,第二条**不能**再写绑定——但统计照记
  store.sessions.get('cc:x').providerId = 'pa';
  const r2 = store.settleRequest(t2, { usage: { in: 7, out: 2 }, binding: { providerId: 'pb' } });
  assert.deepEqual([r2.ok, r2.applied.usage, r2.applied.binding, r2.binding_blocked], [true, true, false, 'binding-changed']);
  assert.deepEqual([store.sessions.get('cc:x').reqs, store.sessions.get('cc:x').inTok, store.sessions.get('cc:x').outTok],
    [2, 12, 3], '两条同代请求的统计都要留下');
  assert.equal(store.sessions.get('cc:x').providerId, 'pa', '手动改过的绑定不被在途响应覆盖');

  // 记录被删 → 不复活;删掉后重建(新代)→ 旧令牌不认新记录
  const t3 = store.captureRequest('cc:x');
  store.sessions.delete('cc:x');
  assert.equal(store.settleRequest(t3, { usage: { in: 1, out: 1 }, binding: { providerId: 'pc' } }).reason, 'removed');
  assert.equal(store.sessions.has('cc:x'), false, '结算不得把被删的会话复活');
  store.entry('cc:x', 'header', '', 'claude');
  const fresh = store.sessions.get('cc:x');
  assert.equal(store.settleRequest(t3, { usage: { in: 1, out: 1 }, actual: { providerId: 'pc' } }).reason, 'replaced');
  assert.deepEqual([fresh.reqs, fresh.providerId, fresh.actual], [0, '', undefined], '旧响应不得改到新记录上');

  // 清空整张表:所有在途令牌作废
  const t4 = store.captureRequest('cc:x');
  store.sessions.clear();
  assert.equal(store.settleRequest(t4, { usage: { in: 1, out: 1 } }).reason, 'removed');
  assert.equal(store.sessions.size, 0, '清空之后结算不得凭空建回记录');
});

test('同代并发:先回来的那条落点不把后回来的那条误判成"用户手改"', () => {
  const store = new (require('../lib/routing/sessions').createSessionStore)({
    sessionsFile: '/nonexistent-flt/sessions.json', ttlMs: 60000, max: 10, cooldownMs: 1000,
    loadJson: () => null, saveJson: () => {}, storeOf: () => [], providerEligible: () => true,
  });
  store.entry('cc:sib', 'header', '', 'claude');
  // 同一会话两条并发请求:失败转移时两条可能落到不同渠道,各自都该有资格写回自己的落点
  const t1 = store.captureRequest('cc:sib');
  const t2 = store.captureRequest('cc:sib');
  const r1 = store.settleRequest(t1, { usage: { in: 1, out: 1 }, binding: { providerId: 'pa', model: 'm', ruleId: 'r' } });
  const r2 = store.settleRequest(t2, { usage: { in: 2, out: 2 }, binding: { providerId: 'pb', model: 'm', ruleId: 'r' } });
  assert.deepEqual([r1.applied.binding, r1.binding_blocked], [true, ''], '第一条落点照记');
  assert.deepEqual([r2.applied.binding, r2.binding_blocked], [true, ''],
    '第二条不能因为"记录里已经是另一条请求刚写的落点"就被判成用户手改');
  assert.equal(store.sessions.get('cc:sib').providerId, 'pb', '以最后落账的那条为准');
  assert.equal(store.sessions.get('cc:sib').reqs, 2, '两条统计都留下');

  // 用户真的手改了 → 仍然拦住(保护没有因为上面放宽而削弱)
  const t3 = store.captureRequest('cc:sib');
  store.sessions.get('cc:sib').providerId = 'pinned-one';
  store.sessions.get('cc:sib').pinned = true;
  const r3 = store.settleRequest(t3, { usage: { in: 3, out: 3 }, binding: { providerId: 'pz', model: 'm', ruleId: 'r' } });
  assert.deepEqual([r3.applied.binding, r3.binding_blocked], [false, 'binding-changed'], '手改后照样拦');
  assert.equal(store.sessions.get('cc:sib').providerId, 'pinned-one', '手改的值保得住');
  assert.equal(store.sessions.get('cc:sib').reqs, 3, '统计照记');
});

test('保存覆盖(整条换对象)后,同代在途请求的落点照记;真手改仍拦得住', () => {
  const store = new (require('../lib/routing/sessions').createSessionStore)({
    sessionsFile: '/nonexistent-flt/sessions.json', ttlMs: 60000, max: 10, cooldownMs: 1000,
    loadJson: () => null, saveJson: () => {}, storeOf: () => [], providerEligible: () => true,
  });
  const key = 'cc:carry';
  store.entry(key, 'header', '', 'claude');
  const t1 = store.captureRequest(key);
  const t2 = store.captureRequest(key);
  assert.equal(store.settleRequest(t1, { binding: { providerId: 'pa', model: 'm', ruleId: 'r' } }).applied.binding, true);

  // 控制台"存覆盖":整条换对象 + carryMark 交世代(绑定没被任何人动过)
  const old = store.sessions.get(key);
  store.sessions.set(key, { ...old, routing: { keys: { pa: 'k' }, slots: {} } });
  store.carryMark(old, key);

  const r2 = store.settleRequest(t2, { binding: { providerId: 'pb', model: 'm', ruleId: 'r' } });
  assert.deepEqual([r2.applied.binding, r2.binding_blocked], [true, ''],
    '保存覆盖不改绑定,在它之前已落账的同代请求不该因此丢掉自己的落点');
  assert.equal(store.sessions.get(key).providerId, 'pb');
  assert.deepEqual(store.sessions.get(key).routing.keys, { pa: 'k' }, '覆盖原样保留');

  // 换对象之后,真正的手改仍然拦得住(bindingsWritten 跟着 carryMark 交过去了)
  const t3 = store.captureRequest(key);
  const cur = store.sessions.get(key);
  store.sessions.set(key, { ...cur, providerId: 'pinned-one', pinned: true });
  store.carryMark(cur, key);
  const r3 = store.settleRequest(t3, { binding: { providerId: 'pz', model: 'm', ruleId: 'r' } });
  assert.deepEqual([r3.applied.binding, r3.binding_blocked], [false, 'binding-changed'], '手改照样拦');
  assert.equal(store.sessions.get(key).providerId, 'pinned-one');
});

// ---------------------------------------------------------------- 真实入口:在途保护
test('在途请求跨过清空会话表:旧响应不作废同代的其他在途请求', async () => {
  _state.sessions.clear(); _state.resetPools();
  const sidA = sessionId(), sidB = sessionId();
  const a = await startProxy(sidA);
  const b = await startProxy(sidB);
  assert.ok(recordOf(sidA) && recordOf(sidB));
  // 清空 A(不动 B),A 的在途响应作废,B 的不受影响
  const del = await request(uiPort, 'DELETE', '/api/sessions/' + encodeURIComponent(keyOf(sidA)));
  assert.equal(del.status, 200, del.text);
  settleAll();
  await Promise.all([a.done, b.done]);
  assert.equal(recordOf(sidA), undefined, 'A 不被复活');
  const rb = recordOf(sidB);
  assert.equal(rb.reqs, 1, 'B 是在途请求,不能因为别人的会话被删就丢掉统计');
  assert.equal(rb.providerId, b.provider, 'B 的自动落点照记');
});

// ---------------------------------------------------------------- 三层状态与低可信身份
test('会话 API 三层可读:没有真实请求记录时返回「暂无」,不用预览冒充', async () => {
  const store = new (require('../lib/routing/sessions').createSessionStore)({
    sessionsFile: '/nonexistent-flt/sessions.json', ttlMs: 60000, max: 10, cooldownMs: 1000,
    loadJson: () => null, saveJson: () => {}, storeOf: () => [], providerEligible: () => true,
  });
  store.entry('cc:tiers', 'header', '', 'claude');
  store.sessions.get('cc:tiers').routing = { keys: { pa: 'ka' }, slots: {} };
  const [row] = store.list({ findProvider: id => ({ id, name: '渠道' + id }), short: shortOf });
  assert.deepEqual(row.required, { routing: { keys: { pa: 'ka' }, slots: {} },
    revision: require('../lib/routing/session-config').routingRevision({ keys: { pa: 'ka' }, slots: {} }),
    keys: 1, slots: 0 }, 'required = 用户存下来的要求');
  assert.deepEqual([row.bound.source, row.bound.provider], ['none', ''], '还没绑定');
  assert.deepEqual([row.actual, row.actual_source, row.actual_text], [null, 'none', '暂无'],
    '没有真实请求记录 → 暂无,不得拿预览充当实际落点');
  assert.ok(Object.keys(row.routing).length, '旧字段保留供旧控制台过渡');

  // 结算一条真实请求之后,三层齐了
  const token = store.captureRequest('cc:tiers');
  store.sessions.get('cc:tiers').providerId = 'pa';
  store.settleRequest(token, { usage: { in: 3, out: 1 }, actual: { providerId: 'pa', model: 'm', status: 200, in: 3, out: 1, ms: 12 } });
  const [after] = store.list({ findProvider: id => ({ id, name: '渠道' + id }), short: shortOf });
  assert.equal(after.actual_source, 'request');
  assert.equal(after.actual_text, '渠道pa');
  assert.deepEqual([after.actual.provider, after.actual.status, after.actual.in], ['pa', 200, 3]);
  assert.deepEqual([after.bound.provider, after.bound.source, after.actual.provider], ['pa', 'auto', 'pa'],
    '绑定与实际是两层,不能混成一句"已绑定"');
  assert.equal(JSON.stringify(after).includes('ka'), true, '覆盖里只有 Key ID');
});

test('低可信身份(内容指纹/匿名)不能新建持久覆盖,存量覆盖照读、照清理', async () => {
  const store = new (require('../lib/routing/sessions').createSessionStore)({
    sessionsFile: '/nonexistent-flt/sessions.json', ttlMs: 60000, max: 10, cooldownMs: 1000,
    loadJson: () => null, saveJson: () => {}, storeOf: () => [], providerEligible: () => true,
  });
  const routing = { keys: { pa: 'ka' }, slots: {} };
  store.entry('fp:deadbeef', 'fingerprint', '', 'claude');
  assert.throws(() => store.assertRoutingConfigurable('fp:deadbeef', routing), e => e.statusCode === 400);
  store.entry('anon', 'anon', '', 'claude');
  assert.throws(() => store.assertRoutingConfigurable('anon', routing), e => e.statusCode === 400);
  store.entry('cc:stable', 'header', '', 'claude');
  assert.doesNotThrow(() => store.assertRoutingConfigurable('cc:stable', routing));
  // 存量覆盖:读得到、能继续编辑、能清空,不被静默删除
  store.sessions.get('fp:deadbeef').routing = routing;
  assert.doesNotThrow(() => store.assertRoutingConfigurable('fp:deadbeef', routing), '存量覆盖可编辑');
  const rows = store.list({ findProvider: () => null, short: shortOf });
  assert.deepEqual(rows.find(r => r.key === 'fp:deadbeef').required.routing, routing, '存量覆盖可读');
  assert.doesNotThrow(() => store.assertRoutingConfigurable('fp:deadbeef', { keys: {}, slots: {} }), '存量覆盖可清空');
});

test('TTL 只回收自动绑定:显式覆盖与手动钉定不被 TTL 或容量静默丢掉', () => {
  let clock = 1000;
  const store = new (require('../lib/routing/sessions').createSessionStore)({
    sessionsFile: '/nonexistent-flt/sessions.json', ttlMs: 100, max: 2, cooldownMs: 1000,
    loadJson: () => null, saveJson: () => {}, storeOf: () => [], providerEligible: () => true, now: () => clock,
  });
  store.entry('cc:auto', 'header', '', 'claude');
  store.entry('cc:pin', 'header', '', 'claude').pinned = true;
  store.entry('cc:routing', 'header', '', 'claude').routing = { keys: { pa: 'ka' }, slots: {} };
  clock += 10000;
  store.prune();
  assert.deepEqual([...store.sessions.keys()].sort(), ['cc:pin', 'cc:routing'], '自动绑定按 TTL 回收,显式配置留下');
  // 容量:表里塞到超过 max,也只会淘汰自动记录
  store.entry('cc:auto2', 'header', '', 'claude');
  store.entry('cc:auto3', 'header', '', 'claude');
  store.prune();
  assert.ok(store.sessions.has('cc:pin') && store.sessions.has('cc:routing'), '容量淘汰不得挤掉显式配置');
});

test('保存覆盖/钉定换掉记录对象后,在途响应的统计仍然落在这条会话上', async () => {
  const sid = sessionId(), key = keyOf(sid);
  _state.sessions.clear(); _state.resetPools();
  const flight = await startProxy(sid);
  const landed = flight.provider;
  const target = POOL.find(id => id !== landed);
  const before = recordOf(sid);

  // 钉定走的是"整条换对象"(控制台为了落盘失败能精确回滚才这么写):
  // 在途响应拿的还是旧对象,若只比对象身份就会被当成"记录已删除后重建",统计整条丢掉。
  const pinned = await request(uiPort, 'POST', `/api/sessions/${encodeURIComponent(key)}/pin`, { body: { provider: target } });
  assert.equal(pinned.status, 200, pinned.text);
  settleAll();
  const done = await flight.done;
  assert.equal(done.status, 200, done.text);
  assert.notEqual(recordOf(sid), before, '钉定确实换了记录对象(前提成立)');
  assert.equal(recordOf(sid).providerId, target);
  const after = recordOf(sid);
  assert.equal(after.reqs, 1, '统计要落在换过对象的新记录上,不能因为"换了对象"就整条丢掉');
  assert.equal(after.inTok, 17);
  assert.equal(after.outTok, 9);
  assert.equal(after.providerId, target, '手动钉定仍然不被在途响应改回去');
  // 最近实际落点(actual)由代理装配在接线时通过 settleRequest 写入,属于待接线的部分,
  // 这里不断言;这三层与在途保护合起来的端到端验收在 session-flight-guard-integration.test.js。
});


test('teardown:关掉本测试起的端口', async () => {
  for (let i = 0; i < pending.length; i++) { try { reply(i); } catch {} }
  await new Promise(r => proxySrv.close(r));
  await new Promise(r => uiSrv.close(r));
  await new Promise(r => upstream.close(r));
});
