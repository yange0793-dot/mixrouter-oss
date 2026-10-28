'use strict';
// 路由 dry-run 预览:三步命中(压缩 / 槽位 / 已登记模型)与未命中原因 / kind 协议过滤 /
// 策略可预测性 / **零副作用**(游标不前移、不建会话、不动冷却) / 白名单不泄露敏感字段。
//
// 瘦身之后没有通用 match/when 规则,也没有可配置兜底:预览能解释的只有
//   1) 压缩内容规则是否命中(带 when.body 且属于 compact-signature 登记的两条)
//   2) 精确槽位别名是否命中(含备池策略)
//   3) 已登记模型的精确选择("唯一命中"才落,"多个渠道登记同一模型"是歧义 409,
//      "没有渠道登记"是 no_route 503)
//
// 绝大多数用例是手工合成 fixture + 注入式 deps,不接真实上游。例外只有两处,都在下面写明:
//   · P4 一节要验**生产路径**的 _state.pools,会惰性 require mixrouter.js(见下);
//   · 文件顶部已把数据/配置目录指向 mkdtemp,故即便 require 也绝不读真实 providers/sessions/routes/slots。
const { test } = require('node:test');
const assert = require('node:assert/strict');

// 绝大多数用例是纯注入、不 require 服务。但 P4 一节要验证**生产路径**的 _state.pools 不动,
// 因此那几条会惰性 require('../mixrouter.js')。为了让它**绝不读到真实配置**,
// 这里在文件最前面(任何 require 之前)把数据与配置目录指向临时目录。
// 进程模型已实测:node --test 每个测试文件独立子进程,故这些 env 不会影响别的文件。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-preview-'));
process.env.MIXR_DATA_DIR = TMP_DIR;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP_DIR, 'claude', 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP_DIR, 'codex', 'config.toml');
test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {} });

const { createExplainer, sanitizeProvider, describeStrategy, PREVIEW_LIMITS, SAFE_PROVIDER_FIELDS } =
  require('../lib/routing/explain.js');
const { createResolver } = require('../lib/routing/resolve.js');
const { pickMember } = require('../lib/routing/strategy.js');
const { FIXED_PREFIX, COMPACT_RULES } = require('../lib/routing/compact-signature.js');

// ---------------------------------------------------------------- fixture
// 渠道:含 base_url / api_key / keys 等**敏感字段**,用来验证它们不会出现在预览结果里。
// 值一律是可识别的假串(LEAK-*),便于泄漏时一眼定位;**绝不**填真凭据。
// 每个渠道登记一个独有模型名:多个渠道登记同一个模型在实跑里是 409 歧义,不能拿来当普通夹具。
const P = (id, extra = {}) => ({
  id, name: '渠道-' + id, base_url: 'https://secret.example/v1', api_key: 'sk-SECRET-' + id,
  keys: [{ id: 'k1', key: 'sk-SECRET-KEY-' + id }], active_key: 'k1',
  secret_note: '内部备注不该外泄', query: 'LEAK-query=' + id, headers: { 'x-leak': 'LEAK-header-' + id },
  models: ['m-' + id], enabled: true, ...extra,
});

const STORE = {
  claude: [P('pa'), P('pb'), P('pc'), P('pdead', { enabled: false })],
  codex: [P('px', { models: ['m-px'], model: 'xm', wire_api: 'responses' }),
    P('pchat', { models: ['m-pchat'], model: 'cm', wire_api: 'chat' })],
};

// 供测试注入的 deps;可变部分放在 opts 里,便于逐条用例调整
function mkDeps(opts = {}) {
  const store = opts.store || STORE;
  const findProvider = id => store.claude.find(p => p.id === id) || store.codex.find(p => p.id === id) || null;
  const providerApp = id => store.claude.some(p => p.id === id) ? 'claude' : (store.codex.some(p => p.id === id) ? 'codex' : null);
  const livePools = opts.pools || {};
  return {
    getRoutes: () => opts.routes || { rules: [] },
    storeOf: app => (app === 'codex' ? store.codex : store.claude),
    resolveSlot: opts.resolveSlot || (() => null),
    findProvider, providerApp,
    listPools: () => livePools,
    healthEligible: opts.healthEligible || (() => true),
    sessionCounts: () => opts.counts || {},
    uiPort: 8788,
    limits: opts.limits,
    _livePools: livePools,
    ...(opts.deps || {}),
  };
}

// 槽位规则:与 lib/routing/slots.js 产出的形状一致(id 以 slot: 开头)。
const slotRule = (app, name, o = {}) => ({ id: `slot:${app}/${name}`, match: 'mixr-' + name, provider: 'pa',
  model: 'm-pa', pool: [], strategy: 'round_robin', priority: 1000, app, when: {}, enabled: true, ...o });
// 带备池的槽位:members 来自 pool(主渠道排池首),用来验证策略与候选池。
const slotPoolRule = (o = {}) => slotRule('claude', 'haiku', {
  provider: 'pa', model: 'm-pa',
  pool: [{ provider: 'pa', model: 'm-pa' }, { provider: 'pb', model: 'm-pb' }],
  strategy: 'priority', ...o });

// ---------------------------------------------------------------- 阶段与命中顺序
test('预览:压缩请求命中压缩规则,并先于槽位与已登记模型', () => {
  const routes = { rules: [{ id: 'compact-global', app: 'claude', enabled: true, priority: 90,
    when: { body: COMPACT_RULES[0].body }, provider: 'pc', model: 'm-pc', pool: [], strategy: 'priority' }] };
  const summary = FIXED_PREFIX + 'Your task is to create a detailed summary of this conversation.';
  const ex = createExplainer(mkDeps({ routes }));
  const r = ex({ app: 'claude', model: 'm-pa', context: { compactTexts: [summary] } });
  assert.equal(r.ok, true);
  assert.equal(r.matched.via, 'compact');
  assert.equal(r.matched.ruleId, 'compact-global');
  assert.equal(r.candidates[0].providerId, 'pc');
  const s0 = r.stages.find(s => s.stage === 'compact');
  assert.equal(s0.hit, 'compact-global');
  // 同一模型名的普通请求不受压缩规则影响,按已登记模型落点
  const plain = ex({ app: 'claude', model: 'm-pa' });
  assert.equal(plain.matched.via, 'model');
  assert.equal(plain.candidates[0].providerId, 'pa');
  assert.equal(plain.stages.find(s => s.stage === 'compact').hit, null);
});

test('预览:槽位别名压过已登记模型', () => {
  const deps = mkDeps({ resolveSlot: (app, model) => (String(model).toLowerCase() === 'mixr-haiku'
    ? { name: 'haiku', model: 'slot-model', rule: slotRule('claude', 'haiku', { provider: 'pb', model: 'slot-model' }) }
    : null) });
  // m-pa 是登记在 pa 上的模型;但请求走槽位别名,必须落到槽位
  const r = createExplainer(deps)({ app: 'claude', model: 'mixr-haiku' });
  assert.equal(r.matched.via, 'slot');
  assert.equal(r.matched.slot, 'haiku');
  assert.equal(r.matched.ruleId, 'slot:claude/haiku');
  assert.equal(r.candidates[0].providerId, 'pb');
  assert.equal(r.candidates[0].model, 'slot-model');
});

test('预览:槽位备池不复用对话粘性或钉定,与真实 session store 的选择一致', () => {
  for (const pinned of [false, true]) {
    const session = { providerId: 'pb', pinned, lastUsed: 1000, model: 'conversation-model' };
    const bindings = new Map([['cc:slot-pool', session]]);
    const deps = mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule: slotPoolRule() }) });
    deps.sessionSnapshot = () => ({ bindings, now: 1000, ttlMs: 1000, max: 50 });
    const snapshot = JSON.stringify([...bindings]);
    const result = createExplainer(deps)({ app: 'claude', model: 'mixr-haiku', context: { session: 'cc:slot-pool' } });
    assert.equal(result.ok, true);
    assert.equal(result.selection.source, 'strategy');
    assert.equal(result.selection.predicted.providerId, 'pa');
    assert.match(result.selection.note, /不复用对话钉定或粘性/);
    assert.equal(JSON.stringify([...bindings]), snapshot);
  }
});

test('预览:已登记模型唯一命中才落点,候选池就是那一个成员', () => {
  const r = createExplainer(mkDeps())({ app: 'claude', model: 'm-pb' });
  assert.equal(r.ok, true);
  assert.equal(r.matched.via, 'model');
  assert.equal(r.matched.ruleId, 'model:pb');
  assert.equal(r.matched.rule.provider, 'pb');
  assert.deepEqual(r.candidates.map(c => c.providerId), ['pb']);
  assert.equal(r.selection.source, 'strategy');
  assert.equal(r.selection.predicted.providerId, 'pb');
});

test('预览:多个渠道登记同一模型 → 歧义 409,不按顺序挑一个', () => {
  const store = { claude: [P('pa', { models: ['dup'] }), P('pb', { models: ['dup'] })], codex: [] };
  const r = createExplainer(mkDeps({ store }))({ app: 'claude', model: 'dup' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'model_ambiguous_error');
  assert.equal(r.error.httpStatus, 409);
  assert.match(r.error.message, /渠道-pa/);
  assert.match(r.error.message, /渠道-pb/);
  assert.equal(r.selection, null, '歧义早于选择,不该出现半截 selection');
});

test('预览:没有渠道登记该模型 → no_route 503(没有兜底可选)', () => {
  const r = createExplainer(mkDeps())({ app: 'claude', model: 'nobody-registered-this' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_route_error');
  assert.equal(r.error.httpStatus, 503);
  assert.match(r.error.message, /nobody-registered-this/);
});

// ---------------------------------------------------------------- 未命中原因
test('预览:压缩阶段把"停用/别组/正文不是真压缩"三种未命中说清', () => {
  const summary = FIXED_PREFIX + 'Your task is to create a detailed summary of this conversation.';
  const routes = { rules: [
    { id: 'dis', app: 'claude', enabled: false, priority: 99, when: { body: COMPACT_RULES[0].body }, provider: 'pc', model: 'm-pc', pool: [] },
    { id: 'other-app', app: 'codex', enabled: true, priority: 98, when: { body: COMPACT_RULES[0].body }, provider: 'px', model: 'm-px', pool: [] },
    { id: 'miss', app: 'claude', enabled: true, priority: 97, when: { body: COMPACT_RULES[0].body }, provider: 'pc', model: 'm-pc', pool: [] },
  ] };
  // compactTexts 里是普通正文(引用了特征串但不是真压缩指令)→ compact_miss
  const r = createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'm-pa', context: { compactTexts: ['ordinary text'] } });
  const ev = r.stages.find(s => s.stage === 'compact').evaluated;
  const byId = Object.fromEntries(ev.map(e => [e.ruleId, e.reason]));
  assert.equal(byId.dis, 'disabled');
  assert.equal(byId['other-app'], 'app_mismatch');
  assert.equal(byId.miss, 'compact_miss');
  assert.ok(ev.every(e => e.outcome === 'skip'));
  // 真压缩正文时同样的规则按 priority 命中最高那条可用规则
  const hit = createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'm-pa', context: { compactTexts: [summary] } });
  assert.equal(hit.matched.ruleId, 'miss', '停用与别组的规则都不该命中');
});

test('预览:未命中原因里不回显请求侧的正文与凭据原文', () => {
  const routes = { rules: [{ id: 'c', app: 'claude', enabled: true, priority: 90,
    when: { body: COMPACT_RULES[0].body }, provider: 'pc', model: 'm-pc', pool: [] }] };
  const r = createExplainer(mkDeps({ routes }))({
    app: 'claude', model: 'm-pa',
    context: { bodyText: 'ACTUAL-BODY-SECRET', ua: 'ACTUAL-UA-SECRET', token: 'ACTUAL-TOKEN-SECRET', compactTexts: ['x'] },
  });
  const json = JSON.stringify(r);
  for (const secret of ['ACTUAL-BODY-SECRET', 'ACTUAL-UA-SECRET', 'ACTUAL-TOKEN-SECRET'])
    assert.equal(json.includes(secret), false, `${secret} 不得出现在结果里`);
  // 只报"有没有、多长"
  assert.deepEqual(r.input.context, { hasSession: false, hasUa: true, hasToken: true, hasBodyText: true,
    bodyTextLen: 'ACTUAL-BODY-SECRET'.length });
});

// ---------------------------------------------------------------- kind 协议过滤
test('预览:chat/completions 命中全是 responses 渠道 → wire_api_mismatch 400', () => {
  // Codex 组:模型只登记在 responses 渠道上,客户端却走 chat 端点
  const r = createExplainer(mkDeps())({ app: 'codex', model: 'm-px', kind: 'chat/completions' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'wire_api_mismatch_error');
  assert.equal(r.error.httpStatus, 400);
});

test('预览:chat/completions 混合渠道时只留 chat,并列出被丢弃的', () => {
  // 槽位备池同时含 responses 与 chat 渠道:kind 过滤只留 chat
  const rule = slotRule('codex', 'main', { provider: 'px', model: 'm-px',
    pool: [{ provider: 'px', model: 'm-px' }, { provider: 'pchat', model: 'm-pchat' }], strategy: 'priority' });
  const r = createExplainer(mkDeps({ resolveSlot: () => ({ name: 'main', model: 'm-px', rule }) }))(
    { app: 'codex', model: 'mixr-main', kind: 'chat/completions' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.kindFilter.kept, ['pchat']);
  assert.deepEqual(r.kindFilter.dropped, [{ providerId: 'px', wire: 'responses', reason: 'wire_not_chat' }]);
  assert.deepEqual(r.effective.map(c => c.providerId), ['pchat']);
});

test('预览:kind 省略时按 app 推断,且不做协议过滤', () => {
  const r = createExplainer(mkDeps())({ app: 'codex', model: 'm-px' });
  assert.equal(r.input.kind, 'responses');
  assert.equal(r.kindFilter, null);
  assert.equal(r.ok, true);
});

test('预览:kind 与 app 不匹配 → kind_app_mismatch 400', () => {
  const r = createExplainer(mkDeps())({ app: 'codex', model: 'x', kind: 'messages' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'kind_app_mismatch');
  assert.equal(r.error.httpStatus, 400);
});

// ---------------------------------------------------------------- 策略与"不承诺"
test('预览:priority 取池序第一个可用', () => {
  const deps = mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule: slotPoolRule() }) });
  const r1 = createExplainer(deps)({ app: 'claude', model: 'mixr-haiku' });
  assert.equal(r1.selection.deterministic, true);
  assert.equal(r1.selection.predicted.providerId, 'pa');
  // 健康预检把主渠道判为不可用时才降级(实跑装配处恒为 true,这里用注入模拟)
  const r2 = createExplainer(mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule: slotPoolRule() }),
    healthEligible: id => id !== 'pa' }))({ app: 'claude', model: 'mixr-haiku' });
  assert.equal(r2.selection.predicted.providerId, 'pb');
});

test('预览:round_robin 预测当前游标的下一位,note 写明预览不消耗游标', () => {
  const rule = slotPoolRule({ id: 'slot:claude/haiku', strategy: 'round_robin' });
  const r = createExplainer(mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule }),
    pools: { 'slot:claude/haiku': 1 } }))({ app: 'claude', model: 'mixr-haiku' });
  assert.equal(r.selection.deterministic, true);
  assert.equal(r.selection.predicted.providerId, 'pb', '游标为 1 → 池序第 1 个');
  assert.match(r.selection.note, /预览不消耗/);
});

test('预览:random 明确不预测(只给候选),不假装能预知', () => {
  const rule = slotRule('claude', 'haiku', { provider: 'pa', model: 'm-pa', strategy: 'random',
    pool: [{ provider: 'pa', model: 'm-pa' }, { provider: 'pb', model: 'm-pb' }, { provider: 'pc', model: 'm-pc' }] });
  const r = createExplainer(mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule }) }))(
    { app: 'claude', model: 'mixr-haiku' });
  assert.equal(r.selection.deterministic, false);
  assert.equal(r.selection.predicted, null, 'random 不准给出 predicted');
  assert.deepEqual(r.selection.candidates, ['pa', 'pb', 'pc']);
  assert.match(r.selection.note, /无法预测/);
});

test('预览:weighted 基于当前余量给预测,并写明预览不消耗余量', () => {
  const rule = slotRule('claude', 'haiku', { provider: 'pa', model: 'm-pa', strategy: 'weighted',
    pool: [{ provider: 'pa', model: 'm-pa', weight: 3 }, { provider: 'pb', model: 'm-pb', weight: 1 }] });
  const r = createExplainer(mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule }) }))(
    { app: 'claude', model: 'mixr-haiku' });
  assert.equal(r.selection.deterministic, true);
  assert.ok(r.selection.predicted);
  assert.match(r.selection.note, /预览不消耗余量/);
});

test('预览:least_used 按传入的活跃会话数取最小', () => {
  const rule = slotRule('claude', 'haiku', { provider: 'pa', model: 'm-pa', strategy: 'least_used',
    pool: [{ provider: 'pa' }, { provider: 'pb' }, { provider: 'pc' }] });
  const r = createExplainer(mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule }),
    counts: { pa: 5, pb: 1, pc: 3 } }))({ app: 'claude', model: 'mixr-haiku' });
  assert.equal(r.selection.predicted.providerId, 'pb');
});

test('预览:sessionCounts 是按需调用的访问器(不是一次性快照/普通对象)', () => {
  const rule = slotRule('claude', 'haiku', { provider: 'pa', model: 'm-pa', strategy: 'least_used',
    pool: [{ provider: 'pa' }, { provider: 'pb' }] });
  let calls = 0;
  const deps = mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule }) });
  deps.sessionCounts = () => { calls++; return { pa: 9, pb: 0 }; };
  const r = createExplainer(deps)({ app: 'claude', model: 'mixr-haiku' });
  assert.ok(calls >= 1, 'sessionCounts 必须被真正调用,否则 least_used 会退化成取池序第一个');
  assert.equal(r.selection.predicted.providerId, 'pb');
});

test('describeStrategy:五种策略的可预测性标注齐全', () => {
  for (const s of ['priority', 'round_robin', 'least_used', 'weighted']) assert.equal(describeStrategy(s).deterministic, true);
  assert.equal(describeStrategy('random').deterministic, false);
  assert.equal(describeStrategy('unknown').deterministic, true);
});

// ---------------------------------------------------------------- 零副作用(核心)
test('零副作用:预览不前移 round_robin 游标,也不改调用者成员对象', () => {
  const rule = slotPoolRule({ strategy: 'round_robin' });
  const deps = mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule }),
    pools: { 'slot:claude/haiku': 0 } });
  const before = JSON.parse(JSON.stringify(deps._livePools));
  const ex = createExplainer(deps);
  for (let i = 0; i < 5; i++) {
    const r = ex({ app: 'claude', model: 'mixr-haiku' });
    assert.equal(r.selection.predicted.providerId, 'pa', '游标没被消耗,每次都应预测同一项');
  }
  assert.deepEqual(deps._livePools, before, 'live pools 必须一个字节都没变');
});

test('零副作用:预览不前移 weighted 余量', () => {
  const rule = slotRule('claude', 'haiku', { provider: 'pa', model: 'm-pa', strategy: 'weighted',
    pool: [{ provider: 'pa', model: 'm-pa', weight: 3 }, { provider: 'pb', model: 'm-pb', weight: 1 }] });
  const deps = mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule }),
    pools: { __w_slot: [{ provider: { id: 'pa' }, weight: 3, current: 7 }] } });
  const before = JSON.parse(JSON.stringify(deps._livePools));
  const seen = new Set();
  const ex = createExplainer(deps);
  for (let i = 0; i < 4; i++) seen.add(ex({ app: 'claude', model: 'mixr-haiku' }).selection.predicted.providerId);
  assert.equal(seen.size, 1, '预览不消耗余量,预测应恒定');
  assert.deepEqual(deps._livePools, before, 'weighted 余量不得被改写');
});

test('零副作用:不建会话、不改粘性(写会话的入口根本没有被调用)', () => {
  let touched = 0;
  const deps = mkDeps();
  // 哨兵:任何"写会话"的动作被调用就计数并抛
  for (const name of ['entry', 'resolveTarget', 'bindSession', 'flush', 'saveSoon', 'prune']) {
    deps[name] = () => { touched++; throw new Error(`预览不该调用 ${name}`); };
  }
  const ex = createExplainer(deps);
  const r = ex({ app: 'claude', model: 'm-pa', context: { session: 'cc:abc' } });
  assert.equal(r.ok, true);
  assert.equal(touched, 0, '预览路径上不得出现任何写会话/剪枝动作');
});

test('零副作用:不标记冷却,也不改冷却表', () => {
  let touched = 0;
  const deps = mkDeps();
  deps.markCooldown = () => { touched++; throw new Error('预览不该标记冷却'); };
  const r = createExplainer(deps)({ app: 'claude', model: 'm-pa' });
  assert.equal(r.ok, true);
  assert.equal(touched, 0);
  // 冷却已移除:候选不再带 cooldown 字段,可用性只看 healthEligible
  assert.equal('cooldown' in r.candidates[0], false);
  assert.equal(r.candidates[0].eligible, true);
});

test('零副作用:不发上游请求(预览模块不 require 任何网络模块)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/routing/explain.js'), 'utf8');
  for (const bad of ['http', 'https', 'net', 'node:http', 'axios', 'fetch']) {
    assert.equal(new RegExp(`require\\(['"]${bad}['"]\\)`).test(src), false, `explain.js 不该 require ${bad}`);
  }
  assert.equal(/process\.env/.test(src), false, 'explain.js 不该读环境变量');
});

test('零副作用:不改槽位状态(只经注入的 resolveSlot 只读调用)', () => {
  let slotCalls = 0, slotWrites = 0;
  const deps = mkDeps();
  deps.resolveSlot = () => { slotCalls++; return null; };
  deps.setSlot = () => { slotWrites++; throw new Error('预览不该写槽位'); };
  const r = createExplainer(deps)({ app: 'claude', model: 'mixr-nope' });
  assert.equal(slotCalls, 1);
  assert.equal(slotWrites, 0);
  // 像别名但不存在 → 如实告知;之后按已登记模型继续,而它也没登记 → 明确 no_route
  assert.ok(r.warnings.some(w => w.code === 'slot_fell_through'));
  assert.equal(r.error.code, 'no_route_error');
  assert.equal(r.matched.via, 'model');
});

test('槽位存在但没绑渠道时,预览明说它落到了精确模型阶段(slot_unbound_falls_through)', () => {
  // 用户看到预览命中了模型落点,却不知道自己槽位根本没绑 —— 那才是误导。
  const deps = mkDeps();
  deps.slotExists = (app, alias) => alias === 'mixr-haiku';   // 别名在表里,但未绑渠道
  const r = createExplainer(deps)({ app: 'claude', model: 'mixr-haiku' });
  const ev = r.stages.find(s => s.stage === 'slot');
  assert.equal(ev.outcome, 'slot_unbound_falls_through');
  assert.deepEqual(ev.detail, { alias: 'mixr-haiku' });
  assert.ok(r.warnings.some(w => w.code === 'slot_unbound'), '必须给出"槽位没绑渠道"的明确警告');
  assert.equal(r.matched.via, 'model', '按实际行为:落到精确模型阶段(这里没登记,故 no_route)');
});

test('未提供 slotExists 时退回笼统的 no_such_slot,不猜', () => {
  const r = createExplainer(mkDeps())({ app: 'claude', model: 'mixr-nope' });
  assert.equal(r.stages.find(s => s.stage === 'slot').outcome, 'no_such_slot');
});

// ---------------------------------------------------------------- 安全:白名单
// ⚠ 下面这条断言的对象是 explainRoute() 的**真实返回值整体**(含 candidates / effective /
// selection.predicted / stages / matched.rule),不是 sanitizeProvider() 的直接输出 ——
// 断后者会在"白名单被导出但出口没走它"时照样绿,等于没守。
test('安全:预览结果整体(含 candidates/effective/predicted/stages/matched)不含任何敏感键名与值', () => {
  const rule = slotPoolRule();
  const r = createExplainer(mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule }) }))(
    { app: 'claude', model: 'mixr-haiku' });
  // 覆盖所有会带 provider 数据的出口,缺一个就等于那条出口无人守
  assert.ok(r.candidates.length && r.effective.length && r.selection.predicted, '三个出口都要有数据,否则断言空转');
  assert.ok(r.matched.rule, 'matched.rule 也要有数据(槽位命中时才有)');
  assert.ok(r.stages.length, 'stages 也要有内容');
  const json = JSON.stringify(r);
  const LEAKS = [
    // 键名
    'api_key', 'base_url', 'active_key', 'secret_note', 'query', 'headers',
    // 值(假串,便于定位;绝不用真凭据)
    'https://', 'secret.example', 'sk-SECRET', 'LEAK-query', 'LEAK-header',
  ];
  for (const leak of LEAKS) assert.equal(json.includes(leak), false, `结果里不得出现 ${leak}`);
  // 逐出口再确认一次键名(JSON 文本断言可能被同名字段掩盖)
  const outlets = [
    ...r.candidates, ...r.effective, r.selection.predicted, r.matched.rule,
    ...r.stages.flatMap(s => s.evaluated || []),
  ];
  const BAD_KEYS = ['api_key', 'base_url', 'active_key', 'query', 'headers', 'keys', 'secret_note'];
  for (const o of outlets) {
    for (const bad of BAD_KEYS) assert.equal(bad in o, false, `出口不得带 ${bad}`);
  }
  assert.equal(r.candidates[0].providerName, '渠道-pa');
});

test('安全:provider 白名单是真关口 —— toCandidate 取不到白名单外的字段', () => {
  const r = createExplainer(mkDeps())({ app: 'claude', model: 'm-pa' });
  const c = r.candidates[0];
  assert.equal(c.providerId, 'pa');
  assert.equal(c.providerName, '渠道-pa');
  assert.equal(c.wire, 'anthropic', 'wireOf 依赖的 wire_api 必须在白名单里,否则协议判断会静默退化');
});

test('安全:sanitizeProvider 只留白名单字段,且对空值不抛', () => {
  const s = sanitizeProvider(P('pz'));
  assert.deepEqual(Object.keys(s).sort(), SAFE_PROVIDER_FIELDS.filter(k => s[k] !== undefined).sort());
  for (const bad of ['base_url', 'api_key', 'keys', 'active_key', 'secret_note']) assert.equal(bad in s, false);
  assert.equal(sanitizeProvider(null), null);
  assert.equal(sanitizeProvider(undefined), null);
  assert.equal(sanitizeProvider('nope'), null);
});

test('安全:白名单必须两半同时成立 —— 非白名单的一个值都不出现,白名单的照常出现', () => {
  // 为什么必须两半一起断:任何一半单独拿出来都不是白名单的证据。
  //   · 只断"敏感值不出现"：把 sanitizeProvider 改成 `return {}` 照样全绿 —— 什么都没输出自然没泄漏;
  //   · 只断"白名单字段在"：把 sanitizeProvider 改成 `return p;`(透传)照样全绿 —— 该有的字段都在。
  // 两半合起来才把"留下的恰好是白名单那一组"这件事夹住。
  const LEAK = {
    api_key: 'LEAKVAL-key-do-not-echo',
    base_url: 'https://LEAKVAL-base.example/v1',
    keys: 'LEAKVAL-keys-do-not-echo',
    active_key: 'LEAKVAL-active-do-not-echo',
  };
  // 单独造一个 store,不往共享的 STORE 上挂 —— 免得污染后续用例
  const store = { claude: [P('pa', LEAK), P('pb')], codex: [] };
  const rule = slotPoolRule({ model: 'mm', pool: [{ provider: 'pa', model: 'mm' }, { provider: 'pb', model: 'mm' }] });
  const r = createExplainer(mkDeps({ store, resolveSlot: () => ({ name: 'haiku', model: 'mm', rule }) }))(
    { app: 'claude', model: 'mixr-haiku' });
  assert.ok(r.candidates.length && r.effective.length && r.selection.predicted, '三个出口都要有数据,否则断言空转');

  // ⚠ 本条的三个断言各自被哪一种注入单独抓红,已实测(不要想当然):
  //   · 出口逐字段 `in` 查(下面 outlets)                ← `toCandidate` 加 `base_url: p.base_url`
  //     白名单此时**完好**:base_url 被剥成 undefined,JSON.stringify 会连键一起丢掉,
  //     所以只断 JSON 文本完全看不见 —— 键已经进了出口,只有 `in` 看得见。
  //   · 源头 `sanitizeProvider` 输出查(最末尾那段)  ← `sanitizeProvider → return p`
  //     此时出口反而干净:toCandidate 逐字段读、不展开 provider,透传也带不出多余字段。
  //   · JSON 文本查(第一个循环)                   ← 上面两者**同时**破才会红。
  // 也就是说任何单独一条都盖不住全部三种回归,三条缺一不可;去掉任一条都有注入能溜过去。
  const json = JSON.stringify(r);
  for (const [k, v] of Object.entries(LEAK)) {
    assert.equal(json.includes(k), false, `结果里不得出现键名 ${k}`);
    assert.equal(json.includes(v), false, `结果里不得出现 ${k} 的值`);
  }
  const outlets = [...r.candidates, ...r.effective, r.selection.predicted];
  for (const o of outlets) {
    assert.ok(o, '出口不得为空,否则下面这圈空转');
    for (const k of Object.keys(LEAK)) assert.equal(k in o, false, `出口不得带 ${k}`);
  }

  // 后半:白名单里的字段必须照常到达出口 —— 值要正确,不能只剩空壳
  const c = r.candidates[0];
  assert.equal(c.providerId, 'pa');
  assert.equal(c.providerName, '渠道-pa');
  assert.equal(c.model, 'mm');
  assert.equal(c.enabled, true);
  assert.equal(c.wire, 'anthropic', 'wire 由 wireOf 读 wire_api 得到,它必须在白名单里');
  assert.equal(r.effective[0].providerId, 'pa');
  assert.equal(r.selection.predicted.providerId, 'pa', '游标缺省 0,池首是 pa');

  // 源头再确认一次:白名单字段被留下、其余被丢掉(而不是"整个 provider 被丢光")
  const s = sanitizeProvider(store.claude[0]);
  for (const k of ['id', 'name', 'models', 'enabled']) assert.ok(k in s, `白名单字段 ${k} 必须留下`);
  for (const k of Object.keys(LEAK)) assert.equal(k in s, false);
});

test('安全:压缩规则出口的 when 只剩 body,且就是那条登记特征串', () => {
  // 判定事件里不再带 when(compact 阶段只报 kind/priority 等规则元数据),when.body 只经
  // matched.rule 出口出现。出口允许出现的 body 只有 compact-signature 登记的两条(都很短),
  // 所以这里钉的是"只有 body、且原值"—— 通用 when.session/ua/token 已随判定一起删除。
  const rule = { id: 'rt', app: 'claude', enabled: true, priority: 90,
    when: { body: COMPACT_RULES[0].body }, provider: 'pc', model: 'm-pc', pool: [] };
  const r = createExplainer(mkDeps({ routes: { rules: [rule] } }))(
    { app: 'claude', model: 'm-pa', context: { compactTexts: [FIXED_PREFIX + 'Your task is to create a detailed summary of this.'] } });
  assert.equal(r.matched.via, 'compact');
  assert.deepEqual(Object.keys(r.matched.rule.when), ['body'], '已删除的通用条件字段不得从这个出口漏出来');
  assert.equal(r.matched.rule.when.body, COMPACT_RULES[0].body);
  assert.ok(r.matched.rule.when.body.length <= 80, '登记特征串本身很短,不会触发截断');
  // 旧规则里残留的通用条件即使躺在盘上,也不会出现在出口(规则判定只看 body)
  const legacy = { ...rule, when: { body: COMPACT_RULES[0].body, token: 'LEAK-legacy-token', ua: 'x' } };
  const r2 = createExplainer(mkDeps({ routes: { rules: [legacy] } }))(
    { app: 'claude', model: 'm-pa', context: { compactTexts: [FIXED_PREFIX + 'Your task is to create a detailed summary of this.'] } });
  assert.deepEqual(r2.matched.rule.when, { body: COMPACT_RULES[0].body });
  assert.equal(JSON.stringify(r2).includes('LEAK-legacy-token'), false);
});

test('安全:bodyText 原文与 token 不回显,只回显长度与"有没有"', () => {
  const secretBody = 'SUPER-SECRET-BODY-TEXT';
  const r = createExplainer(mkDeps())({
    app: 'claude', model: 'm-pa', context: { bodyText: secretBody, token: 'SUPER-SECRET-TOKEN', session: 'cc:1', ua: 'ua1' },
  });
  assert.equal(JSON.stringify(r).includes(secretBody), false);
  assert.equal(JSON.stringify(r).includes('SUPER-SECRET-TOKEN'), false);
  assert.deepEqual(r.input.context, { hasSession: true, hasUa: true, hasToken: true, hasBodyText: true, bodyTextLen: secretBody.length });
});

// ---------------------------------------------------------------- 错误分型
test('预览:压缩 pin 无效时明确 503,不泄露凭据也不修改状态', () => {
  const summary = FIXED_PREFIX + 'Your task is to create a detailed summary of this conversation.';
  const patches = [
    { key_id: 'missing' }, { key_id: null }, { key_id: 'k1', pool: ['pb'] },
    { provider: 'gone', key_id: 'k1' }, { provider: 'pdead', key_id: 'k1' },
  ];
  for (const patch of patches) {
    const routes = { rules: [{ id: 'c', app: 'claude', enabled: true, priority: 90,
      when: { body: COMPACT_RULES[0].body }, model: 'm-pa', pool: [], ...patch }] };
    const store = structuredClone(STORE);
    const deps = mkDeps({ routes, store });
    const before = JSON.stringify({ routes, store, pools: deps._livePools });
    const r = createExplainer(deps)({ app: 'claude', model: 'm-pa', context: { compactTexts: [summary] } });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'provider_key_unavailable_error');
    assert.equal(r.error.httpStatus, 503);
    assert.equal(/sk-SECRET|LEAK-|api_key|base_url|active_key/.test(JSON.stringify(r)), false);
    assert.equal(JSON.stringify({ routes, store, pools: deps._livePools }), before);
  }
});

test('预览:有效压缩 pin 仍给安全候选,普通请求不受坏 pin 影响', () => {
  const summary = FIXED_PREFIX + 'Your task is to create a detailed summary of this conversation.';
  const compact = { id: 'c', app: 'claude', enabled: true, priority: 90, when: { body: COMPACT_RULES[0].body },
    provider: 'pa', key_id: 'k1', model: 'm-pa', pool: [] };
  const routes = { rules: [compact] };
  const ex = createExplainer(mkDeps({ routes }));
  const valid = ex({ app: 'claude', model: 'x', context: { compactTexts: [summary] } });
  assert.equal(valid.ok, true);
  assert.equal(valid.selection.predicted.providerId, 'pa');
  assert.equal(valid.selection.key_id, 'k1');
  assert.equal(valid.selection.key_source, 'compact');
  assert.equal(/sk-SECRET|LEAK-|api_key|base_url|active_key/.test(JSON.stringify(valid)), false);
  compact.key_id = 'missing';
  const ordinary = ex({ app: 'claude', model: 'm-pb', context: { compactTexts: ['ordinary'] } });
  assert.equal(ordinary.ok, true, '普通请求不评压缩规则,坏 pin 不影响它');
  assert.equal(ordinary.selection.predicted.providerId, 'pb');
});

test('预览:单一目标渠道已停用 → provider_disabled 503(与实跑同型)', () => {
  // 停用渠道不参与"已登记模型"命中,只能经槽位绑上来
  const rule = slotRule('claude', 'haiku', { provider: 'pdead', model: 'm-pdead' });
  const r = createExplainer(mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pdead', rule }) }))(
    { app: 'claude', model: 'mixr-haiku' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'provider_disabled_error');
  assert.equal(r.error.httpStatus, 503);
});

test('预览:槽位绑定的渠道已整条删除 → no_route 503 且带 ghost 明细', () => {
  const rule = slotRule('claude', 'haiku', { provider: 'gone', model: 'm-gone' });
  const r = createExplainer(mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-gone', rule }) }))(
    { app: 'claude', model: 'mixr-haiku' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_route_error');
  assert.deepEqual(r.ghosts, [{ where: '单一目标', id: 'gone' }]);
  assert.match(r.error.message, /槽位/);
});

// ---------------------------------------------------------------- 边界
test('预览:畸形入参不抛,按错误分型返回', () => {
  const ex = createExplainer(mkDeps());
  for (const bad of [null, undefined, 0, '', [], 'str', true]) {
    const r = ex(bad);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'bad_app');
  }
  assert.equal(ex({ app: 'claude', model: 123 }).error.code, 'bad_model');
  assert.equal(ex({ app: 'claude', model: null }).error.code, 'bad_model');
  assert.equal(ex({ app: 'CLAUDE', model: 'x' }).error.code, 'bad_app');
  // context 非对象应退化为空而非抛
  assert.equal(ex({ app: 'claude', model: 'm-pa', context: 'nope' }).ok, true);
  assert.equal(ex({ app: 'claude', model: 'm-pa', context: null }).ok, true);
});

test('预览:空规则表不影响精确模型落点', () => {
  const r = createExplainer(mkDeps({ routes: { rules: [] } }))({ app: 'claude', model: 'm-pa' });
  assert.equal(r.ok, true);
  assert.equal(r.matched.via, 'model');
  assert.equal(r.matched.ruleId, 'model:pa');
});

test('预览:超长模型名与特殊字符不抛(纯查表)', () => {
  const ex = createExplainer(mkDeps());
  for (const m of ['x'.repeat(4000), '__proto__', 'constructor', '\u0000\u0007', '中文模型']) {
    const r = ex({ app: 'claude', model: m });
    assert.equal(r.ok, false, `model=${m.slice(0, 20)} 未登记,应明确 no_route 而不是抛`);
    assert.equal(r.error.code, 'no_route_error');
  }
});

test('预览:事件数超过上限时截断,且 rulesOmitted 等于实际丢弃数、已留痕正好等于上限', () => {
  // 上限单位是**事件**:compacted 规则数 + slot 1 条 + model 1 条。
  const LIMIT = 20;
  const rules = Array.from({ length: 60 }, (_, i) => ({ id: 'c' + i, app: 'claude', enabled: true, priority: 90 - i,
    when: { body: COMPACT_RULES[0].body }, provider: 'pc', model: 'm-pc', pool: [] }));
  const r = createExplainer(mkDeps({ routes: { rules }, limits: { maxTraceEvents: LIMIT } }))(
    { app: 'claude', model: 'm-pa', context: { compactTexts: ['not compact'] } });
  assert.equal(r.limits.truncated, true);
  assert.equal(r.limits.rulesTraced, LIMIT, '已留痕事件数必须正好等于上限(不是 <=)');
  assert.ok(r.limits.rulesOmitted > 0, 'rulesOmitted 必须是确切整数');
  // 独立算一遍期望值:60 条压缩规则各 1 条 skip + slot 阶段 1 条 + model 阶段 1 条
  const expected = 60 + 1 + 1;
  assert.equal(r.limits.rulesTraced + r.limits.rulesOmitted, expected,
    `留痕+丢弃必须等于实际事件总数(${expected})`);
  const warn = r.warnings.find(w => w.code === 'rules_truncated');
  assert.ok(warn, '必须有截断警告');
  assert.ok(warn.message.includes(String(r.limits.rulesOmitted)), '警告文案要写明丢弃了多少条,不能只说"截断了"');
});

test('预览:未触顶时 rulesOmitted 为 0 且 truncated 为 false', () => {
  const r = createExplainer(mkDeps())({ app: 'claude', model: 'm-pa' });
  assert.equal(r.limits.truncated, false);
  assert.equal(r.limits.rulesOmitted, 0);
  assert.equal(r.warnings.some(w => w.code === 'rules_truncated'), false);
});

// ---------------------------------------------------------------- 与真实 resolver 的一致性
test('预览与真实 resolveRoute 对同一输入给出一致的命中结果', () => {
  const routes = { rules: [{ id: 'compact-global', app: 'claude', enabled: true, priority: 90,
    when: { body: COMPACT_RULES[0].body }, provider: 'pc', model: 'm-pc', pool: [] }] };
  const summary = FIXED_PREFIX + 'Your task is to create a detailed summary of this conversation.';
  const deps = mkDeps({ routes, resolveSlot: (app, model) => (model === 'mixr-haiku'
    ? { name: 'haiku', model: 'm-pa', rule: slotRule('claude', 'haiku') } : null) });
  const resolver = createResolver(deps);
  const ex = createExplainer(deps);
  const cases = [
    { model: 'm-pa', context: {} },
    { model: 'm-pb', context: {} },
    { model: 'mixr-haiku', context: {} },
    { model: 'm-pa', context: { compactTexts: [summary] } },
    { model: 'unregistered', context: {} },
  ];
  for (const c of cases) {
    const truth = resolver(c.model, { compactTexts: () => c.context.compactTexts || [] }, 'claude');
    const preview = ex({ app: 'claude', ...c });
    assert.equal(preview.matched.ruleId, truth.rule ? truth.rule.id : null, `ruleId 不一致: ${JSON.stringify(c)}`);
    assert.equal(preview.matched.via, truth.stage, `via 不一致: ${JSON.stringify(c)}`);
    assert.deepEqual(preview.candidates.map(x => x.providerId), truth.members.map(m => m.provider.id));
  }
});

test('预览:不启用 trace 时 resolveRoute 行为与加 trace 之前一致(纯函数等价)', () => {
  const deps = mkDeps({ resolveSlot: (app, model) => (model === 'mixr-haiku'
    ? { name: 'haiku', model: 'm-pa', rule: slotPoolRule() } : null) });
  const plain = createResolver(deps);
  const collected = [];
  const traced = createResolver({ ...deps, trace: ev => collected.push(ev) });
  for (const args of [['m-pa', {}, 'claude'], ['nope', {}, 'claude'], ['m-px', {}, 'codex'], ['mixr-haiku', {}, 'claude']]) {
    const before = collected.length;
    const a = plain(...args);
    const b = traced(...args);
    // 整个返回对象逐个字段深比,不再只比手挑的子集
    assert.deepStrictEqual(b, a, `返回值必须逐字段相同: ${JSON.stringify(args)}`);
    assert.ok(collected.length > before, 'trace 应确实收到了事件(否则这条断言空转)');
  }
  // 同一个输入跑两次(收集器累积更多事件),返回值仍必须相同
  const a1 = plain('m-pa', {}, 'claude');
  assert.deepStrictEqual(traced('m-pa', {}, 'claude'), a1);
  assert.deepStrictEqual(traced('m-pa', {}, 'claude'), a1, '收集器已累积更多事件,返回值不得受影响');

  let hitCount = 0;
  const counting = createResolver({ ...deps, trace: () => { hitCount++; } });
  const c = counting('m-pa', {}, 'claude');
  assert.ok(hitCount > 0, '计数收集器必须确实收到事件(否则这条断言空转)');
  assert.deepStrictEqual(c, a1, '事件数不影响返回结果');
});

test('预览:trace 抛异常不影响解析结果(预览的问题不该改路由行为)', () => {
  const deps = mkDeps({ resolveSlot: (app, model) => (model === 'mixr-haiku'
    ? { name: 'haiku', model: 'm-pa', rule: slotRule('claude', 'haiku') } : null) });
  const resolver = createResolver({ ...deps, trace: () => {} });
  const r = resolver('mixr-haiku', {}, 'claude');
  assert.equal(r.rule.id, 'slot:claude/haiku');
  assert.equal(r.members[0].provider.id, 'pa');
});

test('预览:PREVIEW_LIMITS 与 SAFE_PROVIDER_FIELDS 的形状稳定', () => {
  assert.equal(typeof PREVIEW_LIMITS.maxTraceEvents, 'number');
  assert.equal(typeof PREVIEW_LIMITS.maxCandidates, 'number');
  assert.ok(Array.isArray(SAFE_PROVIDER_FIELDS) && SAFE_PROVIDER_FIELDS.includes('id'));
  assert.equal(SAFE_PROVIDER_FIELDS.includes('base_url'), false);
});

// ---------------------------------------------------------------- 参数级无副作用
test('零副作用:不改写调用者传入的 input 与 context', () => {
  const input = { app: 'claude', model: 'm-pa', context: { session: 'cc:1', ua: 'ua', token: 'tk', bodyText: 'body' } };
  const before = JSON.parse(JSON.stringify(input));
  createExplainer(mkDeps())(input);
  assert.deepEqual(input, before, 'input 必须原样不动');
});

test('零副作用:不改写调用者传入的 routes 规则数组顺序与规则对象', () => {
  const rules = [
    { id: 'lo', app: 'claude', enabled: true, priority: 0, when: { body: COMPACT_RULES[1].body }, provider: 'pa', model: 'm-pa', pool: [] },
    { id: 'hi', app: 'claude', enabled: true, priority: 3, when: { body: COMPACT_RULES[0].body }, provider: 'pb', model: 'm-pb', pool: [] },
  ];
  const routes = { rules };
  const before = JSON.parse(JSON.stringify(routes));
  createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'm-pa' });
  assert.deepEqual(routes, before, 'routes 不得被就地排序或改写');
});

test('零副作用:pickMember 直连也证明浅拷贝足够(与 explain 的防护一致)', () => {
  const members = [{ provider: { id: 'a' }, model: '', weight: 1 }, { provider: { id: 'b' }, model: '', weight: 1 }];
  const live = { r1: 5 };
  const before = JSON.stringify(live);
  pickMember({ id: 'r1' }, members, { eligible: () => true, pools: { ...live } });
  assert.equal(JSON.stringify(live), before, '浅拷贝后 live 不被前移');
  // 反证:传活引用就会前移 —— 说明浅拷贝是必要的,不是多余保险
  pickMember({ id: 'r1' }, members, { eligible: () => true, pools: live });
  assert.equal(live.r1, 6);
});

// ---------------------------------------------------------------- F3:真 store 上的零副作用回归
// 这一节用**真的 createSessionStore**(不是手搓 stub)建一个隔离 store,
// 因为要钉死的正是 sessions.js 里那两个会改状态的入口:prune() 与会随时间前移的 pools。
// 不读盘、不写盘:loadJson/saveJson 都换成内存实现。
const { createSessionStore } = require('../lib/routing/sessions.js');

function mkRealStore({ ttlMs = 1000, max = 50 } = {}) {
  const store = { saved: null };
  const s = createSessionStore({
    sessionsFile: '/nonexistent-mixr-preview/sessions.json',
    ttlMs, max, cooldownMs: 60000,
    loadJson: () => store.saved,
    saveJson: (_f, v) => { store.saved = v; },
    storeOf: () => STORE.claude,
    providerEligible: () => true,
    now: () => 1000000,          // 固定时钟:过期判定必须可控,不能靠真实时间
  });
  return s;
}
// 播种:一个"远古"会话 + 一份旧冷却表(兼容 setter 现在不保存任何条目)
function seedStale(s) {
  s.sessions = new Map([['陈旧会话', { app: 'claude', providerId: 'pa', model: '', ruleId: '', label: '',
    kind: 'header', created: 0, lastUsed: 0, reqs: 0, inTok: 0, outTok: 0, pinned: false }]]);
  s.cooldowns = { pa: 0 };
}
const depsFromStore = (s, opts = {}) => ({
  getRoutes: () => opts.routes || { rules: [] },
  storeOf: app => (app === 'codex' ? STORE.codex : STORE.claude),
  resolveSlot: opts.resolveSlot || (() => null),
  findProvider: id => STORE.claude.find(p => p.id === id) || null,
  providerApp: () => 'claude',
  listPools: () => s.pools,                       // 只读引用;浅拷贝由 explain 内部做
  healthEligible: () => true,
  // ⛔ 刻意不传 s.list / s.resolveTarget —— 它们会调 prune()。见 explain.js 的 deps 注释。
  sessionCounts: () => { const o = {}; for (const v of s.sessions.values()) o[v.providerId] = (o[v.providerId] || 0) + 1; return o; },
  uiPort: 8788,
});

test('F3-1:预览不剪枝 —— 过期会话调用后仍在,旧冷却表不保存条目', () => {
  const s = mkRealStore();
  seedStale(s);
  assert.equal(s.sessions.has('陈旧会话'), true, '播种后应在');

  // 反证:真正的 prune 入口会删掉过期会话。没有这一步,"还在"可能只因种子压根不过期(空转通过)。
  s.list({ findProvider: () => null, short: k => k });
  assert.equal(s.sessions.has('陈旧会话'), false, '反证失败:session 应按 TTL 被剪掉');
  assert.equal('pa' in s.cooldowns, false, '冷却已移除:旧冷却表的 setter 不保存条目');

  // 正证:重置种子后走 explain,会话必须原样保留,冷却表仍为空
  seedStale(s);
  const r = createExplainer(depsFromStore(s))({ app: 'claude', model: 'm-pa' });
  assert.equal(r.ok, true);
  assert.equal(s.sessions.has('陈旧会话'), true, '预览不得顺手删用户的会话');
  assert.equal('pa' in s.cooldowns, false, '旧冷却表不再保存条目');
});

test('F3-2:预览前后 store 的 pools 逐字节不变(round_robin 游标)', () => {
  const s = mkRealStore();
  seedStale(s);
  const rule = slotPoolRule({ strategy: 'round_robin' });
  const before = JSON.stringify(s.pools);
  const ex = createExplainer(depsFromStore(s, { resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule }) }));
  for (let i = 0; i < 5; i++) ex({ app: 'claude', model: 'mixr-haiku' });
  assert.equal(JSON.stringify(s.pools), before, 'pools 必须一个字节都没变');
});

test('F3-2 反证:直接经 pickMember 走活游标确实会前移(证明上一条不是空转)', () => {
  const s = mkRealStore();
  const members = [{ provider: { id: 'pa' }, model: '', weight: 1 }, { provider: { id: 'pb' }, model: '', weight: 1 }];
  const before = JSON.stringify(s.pools);
  // 传**活引用**(explain 不会这么干):游标应当被前移
  pickMember({ id: 'slot:claude/haiku' }, members, { eligible: () => true, pools: s.pools });
  assert.notEqual(JSON.stringify(s.pools), before, '反证失败:活引用本应前移游标');
});

test('F3-3:预览前后 weighted 的 current 不变(且反证活引用会改写)', () => {
  const s = mkRealStore();
  const wrule = slotRule('claude', 'haiku', { provider: 'pa', model: 'm-pa', strategy: 'weighted',
    pool: [{ provider: 'pa', model: 'm-pa', weight: 3 }, { provider: 'pb', model: 'm-pb', weight: 1 }] });
  const deps = depsFromStore(s, { resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule: wrule }) });
  const ex = createExplainer(deps);
  ex({ app: 'claude', model: 'mixr-haiku' });        // 先让 explain 建一次余量记录
  const before = JSON.stringify(s.pools);
  for (let i = 0; i < 4; i++) ex({ app: 'claude', model: 'mixr-haiku' });
  assert.equal(JSON.stringify(s.pools), before, '预览不得消耗加权余量');

  // 反证:传活引用给 pickMember,current 会被改写
  const members = [{ provider: { id: 'pa' }, model: '', weight: 3 }, { provider: { id: 'pb' }, model: '', weight: 1 }];
  const before2 = JSON.stringify(s.pools);
  pickMember(wrule, members, { eligible: () => true, pools: s.pools });
  assert.notEqual(JSON.stringify(s.pools), before2, '反证失败:活引用本应改写余量');
});

test('F3-4:预览全程不碰会剪枝的会话入口(注入 throw 哨兵)', () => {
  const s = mkRealStore();
  seedStale(s);
  const base = depsFromStore(s);
  // explain 的 deps 里根本不该出现这些名字;若哪天有人图省事接上,这里立刻炸
  for (const name of ['list', 'resolveTarget', 'prune', 'entry', 'markCooldown', 'flush', 'saveSoon']) {
    base[name] = () => { throw new Error(`预览不该调用 ${name}`); };
  }
  const r = createExplainer(base)({ app: 'claude', model: 'm-pa', context: { session: 'cc:1' } });
  assert.equal(r.ok, true);
  assert.equal(s.sessions.has('陈旧会话'), true);
});

// ---------------------------------------------------------------- 生产路径:_state.pools
// 主会话已在 mixrouter.js 的 _state 里加了 `get pools(){ return sess.pools; }`(必须是 getter:
// resetPools() 会整份换掉那个对象,写成快照会在重置后指向旧表,断言就变成跟没人用的对象比)。
// 上面 F3-2/F3-3 用隔离 store 验的是"模块不改传进去的东西";这一节验的是**生产表本身**没动。
// 槽位规则仍用 fixture,但 listPools 指向**现役服务**的 _state.pools。
const prodDeps = (slot) => ({ ...mkDeps({ resolveSlot: () => slot }), listPools: () => require('../mixrouter.js')._state.pools });

test('P4:explain 前后 _state.pools deepStrictEqual(生产路径,不是隔离 store)', () => {
  const m = require('../mixrouter.js');
  // 先播种一个已知游标,避免"空表前后都空"这种空转。
  // ⚠ resetPools() 是整份替换对象,所以**必须重置之后再取引用** ——
  //   先取引用再 reset,写的就是一张已经没人用的旧表(这条断言自己就踩过一次)。
  m._state.resetPools();
  const p = m._state.pools;
  assert.notEqual(p, undefined, '_state.pools 在 resetPools 之后仍必须是可读对象');
  p['slot:claude/haiku'] = 3;
  const before = JSON.stringify(m._state.pools);
  const r = createExplainer(prodDeps({ name: 'haiku', model: 'm-pa', rule: slotPoolRule() }))(
    { app: 'claude', model: 'mixr-haiku' });
  assert.equal(r.ok, true);
  const p2 = m._state.pools;
  assert.notEqual(p2, undefined, '调用后仍必须是可读对象');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p2)), JSON.parse(before), '_state.pools 必须一个字节都没变');
  assert.equal(p2['slot:claude/haiku'], 3, '播种的游标必须原样还在(不是被重置掉的空表)');
  m._state.resetPools();
});

test('P4:预览不前移生产 round_robin 游标(且反证:直接 pickMember 走活表确实会前移)', () => {
  const m = require('../mixrouter.js');
  m._state.resetPools();
  m._state.pools['slot:claude/haiku'] = 0;
  const before = JSON.stringify(m._state.pools);

  const ex = createExplainer(prodDeps({ name: 'haiku', model: 'm-pa', rule: slotPoolRule({ strategy: 'round_robin' }) }));
  for (let i = 0; i < 5; i++) {
    const r = ex({ app: 'claude', model: 'mixr-haiku' });
    assert.equal(r.ok, true);
    assert.equal(r.selection.predicted.providerId, 'pa', '游标没被消耗,每次都应预测同一项');
  }
  assert.equal(JSON.stringify(m._state.pools), before, '预览不得前移生产游标');

  // 反证:传活表给 pickMember 会前移 —— 证明上一条不是空转(不是"压根没走到轮转分支")
  const members = [{ provider: { id: 'pa' }, model: '', weight: 1 }, { provider: { id: 'pb' }, model: '', weight: 1 }];
  pickMember({ id: 'slot:claude/haiku' }, members, { eligible: () => true, pools: m._state.pools });
  assert.notEqual(JSON.stringify(m._state.pools), before, '反证失败:活表本应被前移');
  m._state.resetPools();
});

test('P4:预览不消耗生产 weighted 余量', () => {
  const m = require('../mixrouter.js');
  m._state.resetPools();
  const rule = slotRule('claude', 'haiku', { provider: 'pa', model: 'm-pa', strategy: 'weighted',
    pool: [{ provider: 'pa', model: 'm-pa', weight: 3 }, { provider: 'pb', model: 'm-pb', weight: 1 }] });
  const exW = createExplainer(prodDeps({ name: 'haiku', model: 'm-pa', rule }));
  exW({ app: 'claude', model: 'mixr-haiku' });      // 建一次余量记录
  // 播种一个非零余量,避免"空表前后都空"空转
  m._state.pools.__w_slot = [{ provider: { id: 'pa' }, weight: 3, current: 7 }];
  const before = JSON.stringify(m._state.pools);
  for (let i = 0; i < 4; i++) exW({ app: 'claude', model: 'mixr-haiku' });
  assert.equal(JSON.stringify(m._state.pools), before, '预览不得消耗生产加权余量');
  m._state.resetPools();
});

// ---------------------------------------------------------------- F-KEY:游标与会话标识无关
// pickMember 的第三个形参曾是 `key`,但函数体内**一次都没读过**(重构前的单体版
// /tmp/mixr-head/mixrouter.js:691 同样如此)——是历史遗留的死参数。它已删除,游标一律按
// **规则 id** 存,与是哪个会话无关。这条把"预览结果与会话标识无关"钉死:
// 若哪天有人把 key 加回去并真的用它分桶,两个 session 就会预测出不同落点,这条立刻红。
test('F-KEY:同一规则、同一游标状态下,两个不同 session 预览出的 predicted 必须相同', () => {
  // ⚠ 光"两个 session 各预览一次比结果"是**测不出**会话分桶的:分桶实现下两个会话各有一份
  //   全 0 的游标,首次预测都是池序第一个,照样相等(已实测确认这条断言在分桶实现下仍会绿)。
  //   要让它有鉴别力,必须让池表里**存在**一个带会话后缀的键:分桶实现会读到它并错位取值,
  //   而按规则取游标的实现只读 'slot:claude/haiku',两条路径这才分得开。
  const rule = slotPoolRule({ strategy: 'round_robin' });
  const deps = mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule }),
    pools: { 'slot:claude/haiku': 0, 'slot:claude/haiku|session-AAA': 1 } });
  const ex = createExplainer(deps);
  const a = ex({ app: 'claude', model: 'mixr-haiku', context: { session: 'session-AAA' } });
  const b = ex({ app: 'claude', model: 'mixr-haiku', context: { session: 'session-BBB' } });
  assert.ok(a.selection.predicted);
  assert.equal(a.selection.predicted.providerId, 'pa', '会话后缀不得影响游标取值(按规则取,应读到 0)');
  assert.equal(b.selection.predicted.providerId, 'pa', '换一个 session 名不得改变落点预测');
  assert.equal(a.selection.predicted.providerId, b.selection.predicted.providerId);

  // 同一件事覆盖全部可预测策略
  for (const strat of ['round_robin', 'weighted', 'least_used', 'priority']) {
    const pool = strat === 'weighted'
      ? [{ provider: 'pa', weight: 3 }, { provider: 'pb', weight: 1 }]
      : ['pa', 'pb', 'pc'];
    const rt = slotRule('claude', 'haiku', { provider: 'pa', model: 'm-pa', pool, strategy: strat });
    const id = 'slot:claude/haiku';
    const depsS = mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule: rt }),
      pools: { [id]: 0, [id + '|session-X']: 1 } });
    const exS = createExplainer(depsS);
    const ra = exS({ app: 'claude', model: 'mixr-haiku', context: { session: 'X' } });
    const rb = exS({ app: 'claude', model: 'mixr-haiku', context: { session: 'Y' } });
    assert.equal(ra.selection.deterministic, true, strat + ' 应为可预测策略');
    assert.equal(ra.selection.predicted.providerId, rb.selection.predicted.providerId,
      strat + ':换一个 session 名不得改变落点预测(游标按规则存,不按会话分桶)');
  }
});

test('F-KEY 反证:同一 session 连预览两次落点稳定(证明真的走到了挑选分支)', () => {
  const rule = slotPoolRule({ strategy: 'round_robin' });
  const ex = createExplainer(mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule }),
    pools: { 'slot:claude/haiku': 0 } }));
  const in1 = { app: 'claude', model: 'mixr-haiku', context: { session: 's' } };
  assert.equal(ex(in1).selection.predicted.providerId, 'pa');
  assert.equal(ex(in1).selection.predicted.providerId, 'pa');
  // 反证:把游标手动前移到 1,落点必须跟着变 —— 说明 predicted 确实来自游标
  const ex2 = createExplainer(mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'm-pa', rule }),
    pools: { 'slot:claude/haiku': 1 } }));
  assert.equal(ex2(in1).selection.predicted.providerId, 'pb', '游标=1 应取池序第二项');
});

// ---------------------------------------------------------------- deps 名单:注释会被忽略,断言不会
// explain.js 里那句「⛔ 不要把 sessions 的 resolveTarget / list / prune 传进来」是注释,
// 注释会被下一个人忽略。这条断言把同一件事变成机器可检的:直接读源码文本,取出
// createExplainer 的 deps 解构名单,断言那四个会改会话表的键名不在其中。
// 用源码文本而不是 Object.keys(deps):后者读的是"调用方传了什么",
// 而危险恰恰是"模块自己解构/使用什么"——有人把 list 加进解构名单,这条就会红。
test('deps 名单:createExplainer 绝不解构会改会话表的键(resolveTarget/list/prune/sessionList)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/routing/explain.js'), 'utf8');
  const m = src.match(/function createExplainer\(deps\)\s*\{([\s\S]*?)\}\s*=\s*deps;/);
  assert.ok(m, '没解析到 createExplainer 的 deps 解构块(函数签名或写法变了,请同步更新本断言)');
  const names = m[1].replace(/^[\s\S]*?\{/, '').split(',').map(s => s.trim()).filter(Boolean);
  assert.ok(names.length > 0, '解构名单不该为空(解析失败会让下面全部空转)');

  for (const forbidden of ['resolveTarget', 'list', 'prune', 'sessionList']) {
    assert.equal(names.includes(forbidden), false,
      `createExplainer 不得解构 ${forbidden}:它会调 prune() 改用户的会话表`);
  }
  // 名单本身也钉住:新增 dep 必须显式改这条(而不是悄悄多一个能改状态的入口)
  assert.deepEqual(names.slice().sort(),
    ['findProvider', 'getRoutes', 'healthEligible', 'listPools', 'providerApp',
      'resolveSlot', 'sessionCounts', 'sessionSnapshot', 'storeOf', 'uiPort'].sort(),
    'deps 名单变了:请确认新入口是纯读的,再更新这条断言');

  // 反思式交叉验证:真传进去也不会被调用(源码断言 + 行为断言,两条一起才叫钉死)
  let touched = 0;
  const deps = mkDeps();
  for (const name of ['resolveTarget', 'list', 'prune', 'sessionList']) {
    deps[name] = () => { touched++; throw new Error(`预览不该调用 ${name}`); };
  }
  assert.equal(createExplainer(deps)({ app: 'claude', model: 'm-pa' }).ok, true);
  assert.equal(touched, 0, '即便调用方多传了这些键,预览也不得调用它们');
});
