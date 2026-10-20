'use strict';
// 路由 dry-run 预览:匹配阶段与未命中原因 / kind 协议过滤 / 策略可预测性 /
// **零副作用**(游标不前移、不建会话、不动冷却) / 白名单不泄露敏感字段。
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
process.env.MIXR_ZCODE_CONFIG = path.join(TMP_DIR, 'zcode', 'config.json');
test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {} });

const { createExplainer, sanitizeProvider, describeStrategy, PREVIEW_LIMITS, SAFE_PROVIDER_FIELDS } =
  require('../lib/routing/explain.js');
const { createResolver, whenMissFields } = require('../lib/routing/resolve.js');
const { pickMember } = require('../lib/routing/strategy.js');
const { FIXED_PREFIX, COMPACT_RULES } = require('../lib/routing/compact-signature.js');

// ---------------------------------------------------------------- fixture
// 渠道:含 base_url / api_key / keys 等**敏感字段**,用来验证它们不会出现在预览结果里。
// 值一律是可识别的假串(LEAK-*),便于泄漏时一眼定位;**绝不**填真凭据。
const P = (id, extra = {}) => ({
  id, name: '渠道-' + id, base_url: 'https://secret.example/v1', api_key: 'sk-SECRET-' + id,
  keys: [{ id: 'k1', key: 'sk-SECRET-KEY-' + id }], active_key: 'k1',
  secret_note: '内部备注不该外泄', query: 'LEAK-query=' + id, headers: { 'x-leak': 'LEAK-header-' + id },
  models: ['m-' + id], enabled: true, ...extra,
});

const STORE = {
  claude: [P('pa'), P('pb'), P('pc'), P('pdead', { enabled: false })],
  codex: [P('px', { model: 'xm', wire_api: 'responses' }), P('pchat', { model: 'cm', wire_api: 'chat' })],
};

// 供测试注入的 deps;可变部分放在 opts 里,便于逐条用例调整
function mkDeps(opts = {}) {
  const store = opts.store || STORE;
  const findProvider = id => store.claude.find(p => p.id === id) || store.codex.find(p => p.id === id) || null;
  const providerApp = id => store.claude.some(p => p.id === id) ? 'claude' : (store.codex.some(p => p.id === id) ? 'codex' : null);
  const livePools = opts.pools || { r1: 0 };
  const liveCooldowns = opts.cooldowns || {};
  return {
    getRoutes: () => opts.routes || { rules: [], default: {} },
    storeOf: app => (app === 'codex' ? store.codex : store.claude),
    resolveSlot: opts.resolveSlot || (() => null),
    findProvider, providerApp,
    listPools: () => livePools,
    inCooldown: id => (liveCooldowns[id] || 0) > (opts.now || 0),
    healthEligible: opts.healthEligible || (() => true),
    sessionCounts: () => opts.counts || {},
    uiPort: 8788,
    limits: opts.limits,
    _livePools: livePools, _liveCooldowns: liveCooldowns,
  };
}

const rule = (o = {}) => ({ id: 'r', match: '', provider: 'pa', model: '', pool: [], strategy: 'round_robin',
  priority: 0, app: '', when: {}, enabled: true, ...o });

// ---------------------------------------------------------------- 阶段与命中顺序
test('预览:内容分流规则命中,且 priority 更低也先于普通规则评估', () => {
  const routes = { rules: [
    rule({ id: 'plain', match: 'opus', provider: 'pa', priority: 0 }),
    rule({ id: 'content', match: '', provider: 'pb', priority: -5, when: { body: 'summarize' } }),
  ], default: { provider: 'pc' } };
  const ex = createExplainer(mkDeps({ routes }));
  const r = ex({ app: 'claude', model: 'opus', context: { bodyText: 'please summarize now' } });
  assert.equal(r.ok, true);
  assert.equal(r.matched.via, 'content');
  assert.equal(r.matched.ruleId, 'content');
  assert.equal(r.candidates[0].providerId, 'pb');
  const s0 = r.stages.find(s => s.stage === 'content');
  assert.equal(s0.hit, 'content');
});

test('预览:槽位别名压过普通规则的子串匹配', () => {
  const routes = { rules: [rule({ id: 'plain', match: 'haiku', provider: 'pa' })], default: { provider: 'pc' } };
  const deps = mkDeps({ routes, resolveSlot: (app, model) => (String(model).toLowerCase() === 'mixr-haiku'
    ? { name: 'haiku', model: 'hm', rule: rule({ id: 'slot:claude/haiku', provider: 'pb', model: 'hm' }) } : null) });
  const r = createExplainer(deps)({ app: 'claude', model: 'mixr-haiku' });
  assert.equal(r.matched.via, 'slot');
  assert.equal(r.matched.slot, 'haiku');
  assert.equal(r.matched.ruleId, 'slot:claude/haiku');
  assert.equal(r.candidates[0].providerId, 'pb');
});

test('预览:槽位备池不复用对话粘性或钉定,与真实 session store 的选择一致', () => {
  for (const pinned of [false, true]) {
    const session = { providerId: 'pb', pinned, lastUsed: 1000, model: 'conversation-model' };
    const bindings = new Map([['cc:slot-pool', session]]);
    const slotRule = rule({ id: 'slot:claude/haiku', provider: 'pa', model: 'slot-model',
      pool: ['pa', 'pb'], strategy: 'priority' });
    const deps = mkDeps({ resolveSlot: () => ({ name: 'haiku', model: 'slot-model', rule: slotRule }) });
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

test('预览:普通规则按 priority 降序、同值按数组顺序,命中首个', () => {
  const routes = { rules: [
    rule({ id: 'first', match: 'opus', provider: 'pa', priority: 0 }),
    rule({ id: 'second', match: 'opus', provider: 'pb', priority: 0 }),
    rule({ id: 'top', match: 'opus', provider: 'pc', priority: 9, enabled: false }),
  ], default: { provider: 'pc' } };
  const r = createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'opus' });
  assert.equal(r.matched.via, 'rule');
  assert.equal(r.matched.ruleId, 'first');
});

test('预览:都不中时走兜底,ruleId 为 null 且 stages 里有 default used', () => {
  const routes = { rules: [rule({ id: 'r1', match: 'zzz', provider: 'pa' })], default: { provider: 'pb' } };
  const r = createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'nomatch' });
  assert.equal(r.matched.via, 'default');
  assert.equal(r.matched.ruleId, null);
  assert.equal(r.stages.at(-1).stage, 'default');
  assert.equal(r.stages.at(-1).outcome, 'used');
  assert.equal(r.candidates[0].providerId, 'pb');
});

// ---------------------------------------------------------------- 未命中原因
test('预览:四种未命中原因都能说清(disabled/当body缺失/app不匹配/match不中)', () => {
  const routes = { rules: [
    rule({ id: 'dis', match: 'x', enabled: false }),
    rule({ id: 'nobody', match: 'x' }),                                  // 无 when.body → 内容阶段不评
    rule({ id: 'app', match: 'x', when: { body: 'q' }, app: 'codex' }),  // 只服务 codex
    rule({ id: 'miss', match: 'x', when: { body: 'q' } }),               // 模型名不匹配
  ], default: { provider: 'pa' } };
  const r = createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'nothing', context: { bodyText: 'q' } });
  const ev = r.stages.find(s => s.stage === 'content').evaluated;
  const byId = Object.fromEntries(ev.map(e => [e.ruleId, e.reason]));
  assert.equal(byId.dis, 'disabled');
  assert.equal(byId.nobody, 'when_body_absent');
  assert.equal(byId.app, 'app_mismatch');
  assert.equal(byId.miss, 'match_miss');
  assert.ok(ev.every(e => e.outcome === 'skip'));
});

test('预览:when 没对上时只报条件名,不报请求侧的值', () => {
  const routes = { rules: [rule({ id: 'w', match: 'x', when: { body: 'q', ua: 'yes' } })], default: {} };
  const r = createExplainer(mkDeps({ routes }))({
    app: 'claude', model: 'x',
    context: { bodyText: 'q', ua: 'ACTUAL-UA-SECRET', token: 'ACTUAL-TOKEN-SECRET' },
  });
  const ev = r.stages.find(s => s.stage === 'content').evaluated[0];
  assert.equal(ev.reason, 'when_mismatch');
  assert.deepEqual(ev.detail.fields, ['ua']);
  const json = JSON.stringify(r);
  assert.equal(json.includes('ACTUAL-UA-SECRET'), false, '请求侧 ua 原文不得出现在结果里');
  assert.equal(json.includes('ACTUAL-TOKEN-SECRET'), false, '请求侧 token 原文不得出现在结果里');
});

test('预览:match 为空的规则在普通阶段报 no_match', () => {
  const routes = { rules: [rule({ id: 'empty', match: '', provider: 'pa' })], default: { provider: 'pb' } };
  const r = createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'x' });
  const ev = r.stages.find(s => s.stage === 'rule').evaluated[0];
  assert.equal(ev.reason, 'no_match');
  assert.deepEqual(ev.detail.patterns, []);
});

test('预览:whenMissFields 与 matchWhen 对同一输入给出同一判定(不许两套语义)', () => {
  const { matchWhen } = require('../lib/routing/rules.js');
  const cases = [
    [{ when: {} }, {}],
    [{ when: { ua: 'claude' } }, { ua: 'CLAUDE-cli/2' }],
    [{ when: { ua: 'claude' } }, { ua: 'curl' }],
    [{ when: { body: 'sum' } }, { bodyText: () => 'please SUM it' }],
    [{ when: { body: 'sum' } }, { bodyText: () => 'nothing' }],
    [{ when: { session: 'a', ua: 'b' } }, { session: 'a', ua: 'b' }],
    [{ when: { session: 'a', ua: 'b' } }, { session: 'a', ua: 'z' }],
    [{ when: { body: 'x' } }, {}],
  ];
  for (const [r, ctx] of cases) {
    const viaMatchWhen = matchWhen(r, ctx);
    const viaMiss = whenMissFields(r, ctx) === null;
    assert.equal(viaMiss, viaMatchWhen, `不一致: ${JSON.stringify(r)} / ${JSON.stringify(ctx)}`);
  }
});

// ---------------------------------------------------------------- kind 协议过滤
test('预览:chat/completions 命中全是 responses 渠道 → wire_api_mismatch 400', () => {
  const routes = { rules: [rule({ id: 'c', match: 'gpt', provider: 'px' })], default: {} };
  const r = createExplainer(mkDeps({ routes }))({ app: 'codex', model: 'gpt', kind: 'chat/completions' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'wire_api_mismatch_error');
  assert.equal(r.error.httpStatus, 400);
});

test('预览:chat/completions 混合渠道时只留 chat,并列出被丢弃的', () => {
  const routes = { rules: [rule({ id: 'c', match: 'gpt', pool: ['px', 'pchat'] })], default: {} };
  const r = createExplainer(mkDeps({ routes }))({ app: 'codex', model: 'gpt', kind: 'chat/completions' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.kindFilter.kept, ['pchat']);
  assert.deepEqual(r.kindFilter.dropped, [{ providerId: 'px', wire: 'responses', reason: 'wire_not_chat' }]);
  assert.deepEqual(r.effective.map(c => c.providerId), ['pchat']);
});

test('预览:kind 省略时按 app 推断,且不做协议过滤', () => {
  const routes = { rules: [rule({ id: 'c', match: 'gpt', provider: 'px' })], default: {} };
  const r = createExplainer(mkDeps({ routes }))({ app: 'codex', model: 'gpt' });
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
test('预览:priority 取池序第一个可用,主渠道冷却时降到备', () => {
  const routes = { rules: [rule({ id: 'pp', match: 'x', pool: ['pa', 'pb'], strategy: 'priority' })], default: {} };
  const r1 = createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'x' });
  assert.equal(r1.selection.deterministic, true);
  assert.equal(r1.selection.predicted.providerId, 'pa');
  const r2 = createExplainer(mkDeps({ routes, cooldowns: { pa: 1e9 } }))({ app: 'claude', model: 'x' });
  assert.equal(r2.selection.predicted.providerId, 'pb');
});

test('预览:round_robin 预测当前游标的下一位,note 写明预览不消耗游标', () => {
  const routes = { rules: [rule({ id: 'r1', match: 'x', pool: ['pa', 'pb'] })], default: {} };
  const r = createExplainer(mkDeps({ routes, pools: { r1: 1 } }))({ app: 'claude', model: 'x' });
  assert.equal(r.selection.deterministic, true);
  assert.equal(r.selection.predicted.providerId, 'pb', '游标为 1 → 池序第 1 个');
  assert.match(r.selection.note, /预览不消耗/);
});

test('预览:random 明确不预测(只给候选),不假装能预知', () => {
  const routes = { rules: [rule({ id: 'rr', match: 'x', pool: ['pa', 'pb', 'pc'], strategy: 'random' })], default: {} };
  const r = createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'x' });
  assert.equal(r.selection.deterministic, false);
  assert.equal(r.selection.predicted, null, 'random 不准给出 predicted');
  assert.deepEqual(r.selection.candidates, ['pa', 'pb', 'pc']);
  assert.match(r.selection.note, /无法预测/);
});

test('预览:weighted 基于当前余量给预测,并写明预览不消耗余量', () => {
  const routes = { rules: [rule({ id: 'rw', match: 'x', pool: [{ provider: 'pa', weight: 3 }, { provider: 'pb', weight: 1 }], strategy: 'weighted' })], default: {} };
  const r = createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'x' });
  assert.equal(r.selection.deterministic, true);
  assert.ok(r.selection.predicted);
  assert.match(r.selection.note, /预览不消耗余量/);
});

test('预览:least_used 按传入的活跃会话数取最小', () => {
  const routes = { rules: [rule({ id: 'lu', match: 'x', pool: ['pa', 'pb', 'pc'], strategy: 'least_used' })], default: {} };
  const r = createExplainer(mkDeps({ routes, counts: { pa: 5, pb: 1, pc: 3 } }))({ app: 'claude', model: 'x' });
  assert.equal(r.selection.predicted.providerId, 'pb');
});

test('预览:sessionCounts 是按需调用的访问器(不是一次性快照/普通对象)', () => {
  const routes = { rules: [rule({ id: 'lu', match: 'x', pool: ['pa', 'pb'], strategy: 'least_used' })], default: {} };
  let calls = 0;
  const deps = mkDeps({ routes });
  deps.sessionCounts = () => { calls++; return { pa: 9, pb: 0 }; };
  const r = createExplainer(deps)({ app: 'claude', model: 'x' });
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
  const routes = { rules: [rule({ id: 'r1', match: 'x', pool: ['pa', 'pb'] })], default: {} };
  const deps = mkDeps({ routes, pools: { r1: 0 } });
  const before = JSON.parse(JSON.stringify(deps._livePools));
  const ex = createExplainer(deps);
  for (let i = 0; i < 5; i++) {
    const r = ex({ app: 'claude', model: 'x' });
    assert.equal(r.selection.predicted.providerId, 'pa', '游标没被消耗,每次都应预测同一项');
  }
  assert.deepEqual(deps._livePools, before, 'live pools 必须一个字节都没变');
});

test('零副作用:预览不前移 weighted 余量', () => {
  const routes = { rules: [rule({ id: 'rw', match: 'x', pool: [{ provider: 'pa', weight: 3 }, { provider: 'pb', weight: 1 }], strategy: 'weighted' })], default: {} };
  const deps = mkDeps({ routes, pools: { __w_rw: [{ provider: { id: 'pa' }, weight: 3, current: 7 }] } });
  const before = JSON.parse(JSON.stringify(deps._livePools));
  const seen = new Set();
  const ex = createExplainer(deps);
  for (let i = 0; i < 4; i++) seen.add(ex({ app: 'claude', model: 'x' }).selection.predicted.providerId);
  assert.equal(seen.size, 1, '预览不消耗余量,预测应恒定');
  assert.deepEqual(deps._livePools, before, 'weighted 余量不得被改写');
});

test('零副作用:不建会话、不改粘性(写会话的入口根本没有被调用)', () => {
  const routes = { rules: [rule({ id: 'r1', match: 'x', pool: ['pa'] })], default: {} };
  let touched = 0;
  const deps = mkDeps({ routes });
  // 哨兵:任何"写会话"的动作被调用就计数并抛
  for (const name of ['entry', 'resolveTarget', 'bindSession', 'flush', 'saveSoon', 'prune']) {
    deps[name] = () => { touched++; throw new Error(`预览不该调用 ${name}`); };
  }
  const ex = createExplainer(deps);
  const r = ex({ app: 'claude', model: 'x', context: { session: 'cc:abc' } });
  assert.equal(r.ok, true);
  assert.equal(touched, 0, '预览路径上不得出现任何写会话/剪枝动作');
});

test('零副作用:不标记冷却,也不改冷却表', () => {
  const routes = { rules: [rule({ id: 'r1', match: 'x', pool: ['pa', 'pb'] })], default: {} };
  const deps = mkDeps({ routes, cooldowns: { pa: 1e9 } });
  const before = JSON.parse(JSON.stringify(deps._liveCooldowns));
  let touched = 0;
  deps.markCooldown = () => { touched++; throw new Error('预览不该标记冷却'); };
  const r = createExplainer(deps)({ app: 'claude', model: 'x' });
  assert.equal(r.ok, true);
  assert.equal(touched, 0);
  // 冷却只读地被用上:pa 在冷却 → eligible=false,priority 会绕开它
  assert.equal(r.candidates.find(c => c.providerId === 'pa').cooldown, true);
  assert.equal(r.candidates.find(c => c.providerId === 'pa').eligible, false);
  assert.deepEqual(deps._liveCooldowns, before, '冷却表不得被改写');
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
  const deps = mkDeps({ routes: { rules: [], default: { provider: 'pa' } } });
  deps.resolveSlot = (app, model) => { slotCalls++; return null; };
  deps.setSlot = () => { slotWrites++; throw new Error('预览不该写槽位'); };
  const r = createExplainer(deps)({ app: 'claude', model: 'mixr-nope' });
  assert.equal(slotCalls, 1);
  assert.equal(slotWrites, 0);
  assert.equal(r.ok, true);
  // 像别名但不存在 → 如实告知并按兜底继续
  assert.ok(r.warnings.some(w => w.code === 'slot_fell_through'));
});

test('槽位存在但没绑渠道时,预览明说它落到了普通规则(slot_unbound_falls_through)', () => {
  // 用户看到预览命中了普通规则,却不知道自己槽位根本没绑 —— 那才是误导。
  const deps = mkDeps({ routes: { rules: [rule({ id: 'plain', match: 'x', provider: 'pa' })], default: {} } });
  deps.slotExists = (app, alias) => alias === 'mixr-haiku';   // 别名在表里,但未绑渠道
  const r = createExplainer(deps)({ app: 'claude', model: 'mixr-haiku' });
  const ev = r.stages.find(s => s.stage === 'slot');
  assert.equal(ev.outcome, 'slot_unbound_falls_through');
  assert.deepEqual(ev.detail, { alias: 'mixr-haiku' });
  assert.ok(r.warnings.some(w => w.code === 'slot_unbound'), '必须给出"槽位没绑渠道"的明确警告');
  assert.equal(r.matched.via, 'rule', '按实际行为:落到普通规则');
});

test('未提供 slotExists 时退回笼统的 no_such_slot,不猜', () => {
  const deps = mkDeps({ routes: { rules: [], default: { provider: 'pa' } } });
  const r = createExplainer(deps)({ app: 'claude', model: 'mixr-nope' });
  assert.equal(r.stages.find(s => s.stage === 'slot').outcome, 'no_such_slot');
});

// ---------------------------------------------------------------- 安全:白名单
// ⚠ 下面这条断言的对象是 explainRoute() 的**真实返回值整体**(含 candidates / effective /
// selection.predicted / stages / matched.rule),不是 sanitizeProvider() 的直接输出 ——
// 断后者会在"白名单被导出但出口没走它"时照样绿,等于没守。
test('安全:预览结果整体(含 candidates/effective/predicted/stages/matched)不含任何敏感键名与值', () => {
  const routes = { rules: [rule({ id: 'r1', match: 'x', pool: ['pa', 'pb'] })], default: {} };
  const r = createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'x' });
  // 覆盖所有会带 provider 数据的出口,缺一个就等于那条出口无人守
  assert.ok(r.candidates.length && r.effective.length && r.selection.predicted, '三个出口都要有数据,否则断言空转');
  assert.ok(r.matched.rule, 'matched.rule 也要有数据(规则命中时才有)');
  assert.ok(r.stages.length, 'stages 也要有内容');
  const json = JSON.stringify(r);
  const LEAKS = [
    // 键名
    'api_key', 'base_url', 'active_key', 'secret_note', 'query', 'headers',
    // 值(假串,便于定位;绝不用真凭据)
    'https://', 'secret.example', 'sk-SECRET', 'LEAK-query', 'LEAK-header',
  ];
  for (const leak of LEAKS) assert.equal(json.includes(leak), false, `结果里不得出现 ${leak}`);
  // 逐出口再确认一次键名(JSON 文本断言可能被同名字段掩盖)。
  // 出口清单按主会话要求覆盖到 matched.rule 与 stages[].evaluated[]。
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
  // F-B:白名单必须与出口是同一份字段表。用带全量敏感字段的 provider,
  // 断言出口拿不到它们;再断言 providerName/wire 仍正确(证明没有把出口改坏)。
  const routes = { rules: [rule({ id: 'r1', match: 'x', pool: ['pa'] })], default: {} };
  const r = createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'x' });
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
  const routes = { rules: [rule({ id: 'r1', match: 'x', model: 'mm', pool: ['pa', 'pb'] })], default: {} };
  const r = createExplainer(mkDeps({ routes, store }))({ app: 'claude', model: 'x' });
  assert.ok(r.candidates.length && r.effective.length && r.selection.predicted, '三个出口都要有数据,否则断言空转');

  // ⚠ 本条的三个断言各自被哪一种注入单独抓红,已实测(不要想当然):
  //   · 出口逐字段 `in` 查(下面 _outletKeyCheck)      ← `toCandidate` 加 `base_url: p.base_url`
  //     白名单此时**完好**:base_url 被剥成 undefined,JSON.stringify 会连键一起丢掉,
  //     所以只断 JSON 文本完全看不见 —— 键已经进了出口,只有 `in` 看得见。
  //   · 源头 `sanitizeProvider` 输出查(最末尾那段) ← `sanitizeProvider → return p`
  //     此时出口反而干净:toCandidate 逐字段读、不展开 provider,透传也带不出多余字段。
  //   · JSON 文本查(第一个循环)                     ← 上面两者**同时**破才会红。
  // 也就是说任何单独一条都盖不住全部三种回归,三条缺一不可;去掉任一条都有注入能溜过去。
  const json = JSON.stringify(r);
  // 之一:非白名单字段的键名与值都不得出现在序列化结果里(值一律 fake,绝不填真凭据形态)
  for (const [k, v] of Object.entries(LEAK)) {
    assert.equal(json.includes(k), false, `结果里不得出现键名 ${k}`);
    assert.equal(json.includes(v), false, `结果里不得出现 ${k} 的值`);
  }
  // 之二:逐出口按 `in` 再查键名。不可省 —— 值为 undefined 时 JSON.stringify 会把键整个丢掉,
  // 只断 JSON 文本就漏掉"键已经加进出口、只是当下取不到值"这类回归(实测见上)。
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
  assert.equal(r.selection.predicted.providerId, 'pa', '游标 r1=0,池首是 pa');

  // 源头再确认一次:白名单字段被留下、其余被丢掉(而不是"整个 provider 被丢光")
  const s = sanitizeProvider(store.claude[0]);
  for (const k of ['id', 'name', 'models', 'enabled']) assert.ok(k in s, `白名单字段 ${k} 必须留下`);
  for (const k of Object.keys(LEAK)) assert.equal(k in s, false);
});

test('安全:规则条件 when.token 的原文不回显,只给 present/len', () => {
  // when.token 是拿去匹配**客户端凭据**的子串,用户可能把 Key 的一段写在那里做分流。
  // 预览结果是要贴进 issue 的,不能成为凭据材料。
  const TOKEN_SECRET = 'LEAK-when-token-abcdef';
  const routes = { rules: [rule({ id: 'rt', match: 'x', provider: 'pa', when: { token: TOKEN_SECRET, ua: 'claude' } })], default: {} };
  const r = createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'x', context: { token: TOKEN_SECRET, ua: 'claude-cli' } });
  const json = JSON.stringify(r);
  assert.equal(json.includes(TOKEN_SECRET), false, 'when.token 原文不得出现在结果任何位置');
  // 两个出口都要脱敏:stages[].evaluated[].when 与 matched.rule.when
  const ev = r.stages.find(s => s.stage === 'rule').evaluated[0];
  assert.deepEqual(ev.when.token, { present: true, len: TOKEN_SECRET.length });
  assert.deepEqual(r.matched.rule.when.token, { present: true, len: TOKEN_SECRET.length });
  // 其余条件字段照旧原样 —— 藏了预览就没法解释"为什么没命中"
  assert.equal(ev.when.ua, 'claude');
  // 没有 when.token 时不出现这个键
  const r2 = createExplainer(mkDeps({ routes: { rules: [rule({ id: 'r2', match: 'x', when: { ua: 'z' } })], default: { provider: 'pa' } } }))({ app: 'claude', model: 'x' });
  const ev2 = r2.stages.find(s => s.stage === 'rule').evaluated[0];
  assert.equal('token' in ev2.when, false);
});

test('安全:bodyText 原文与 token 不回显,只回显长度与"有没有"', () => {
  const routes = { rules: [], default: { provider: 'pa' } };
  const secretBody = 'SUPER-SECRET-BODY-TEXT';
  const r = createExplainer(mkDeps({ routes }))({
    app: 'claude', model: 'x', context: { bodyText: secretBody, token: 'SUPER-SECRET-TOKEN', session: 'cc:1', ua: 'ua1' },
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
    const routes = { rules: [rule({ app: 'claude', when: { body: COMPACT_RULES[0].body }, ...patch })], default: {} };
    const store = structuredClone(STORE);
    const deps = mkDeps({ routes, store });
    const before = JSON.stringify({ routes, store, pools: deps._livePools, cooldowns: deps._liveCooldowns });
    const r = createExplainer(deps)({ app: 'claude', model: 'x', context: { compactTexts: [summary] } });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'provider_key_unavailable_error');
    assert.equal(r.error.httpStatus, 503);
    assert.equal(/sk-SECRET|LEAK-|api_key|base_url|active_key/.test(JSON.stringify(r)), false);
    assert.equal(JSON.stringify({ routes, store, pools: deps._livePools, cooldowns: deps._liveCooldowns }), before);
  }
});

test('预览:有效压缩 pin 仍给安全候选,普通请求不受坏 pin 影响', () => {
  const summary = FIXED_PREFIX + 'Your task is to create a detailed summary of this conversation.';
  const compact = rule({ app: 'claude', key_id: 'k1', when: { body: COMPACT_RULES[0].body } });
  const routes = { rules: [compact], default: { provider: 'pb' } };
  const ex = createExplainer(mkDeps({ routes }));
  const valid = ex({ app: 'claude', model: 'x', context: { compactTexts: [summary] } });
  assert.equal(valid.ok, true);
  assert.equal(valid.selection.predicted.providerId, 'pa');
  assert.equal(/sk-SECRET|LEAK-|api_key|base_url|active_key/.test(JSON.stringify(valid)), false);
  compact.key_id = 'missing';
  const ordinary = ex({ app: 'claude', model: 'x', context: { compactTexts: ['ordinary'] } });
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.selection.predicted.providerId, 'pb');
});

test('预览:单一目标渠道已停用 → provider_disabled 503(与实跑同型)', () => {
  const routes = { rules: [rule({ id: 'd', match: 'x', provider: 'pdead' })], default: {} };
  const r = createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'provider_disabled_error');
  assert.equal(r.error.httpStatus, 503);
});

test('预览:规则指向已删渠道 → no_route 503 且带 ghost 明细', () => {
  const routes = { rules: [rule({ id: 'g', match: 'x', provider: 'gone' })], default: {} };
  const r = createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_route_error');
  assert.deepEqual(r.ghosts, [{ where: '单一目标', id: 'gone' }]);
  assert.match(r.error.message, /不存在/);
});

test('预览:全员冷却时给出提示,但仍能预览(不锁死)', () => {
  const routes = { rules: [rule({ id: 'r1', match: 'x', pool: ['pa', 'pb'] })], default: {} };
  const r = createExplainer(mkDeps({ routes, cooldowns: { pa: 1e9, pb: 1e9 } }))({ app: 'claude', model: 'x' });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some(w => w.code === 'all_members_ineligible'));
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
  // context 非对象应退化为空而非抛;给一份带兜底渠道的 deps,否则 ok:false 是 no_route 而非入参问题
  const exWithDefault = createExplainer(mkDeps({ routes: { rules: [], default: { provider: 'pa' } } }));
  assert.equal(exWithDefault({ app: 'claude', model: 'x', context: 'nope' }).ok, true);
  assert.equal(exWithDefault({ app: 'claude', model: 'x', context: null }).ok, true);
});

test('预览:空路由表 → 走兜底,ruleId 为 null', () => {
  const r = createExplainer(mkDeps({ routes: { rules: [], default: { provider: 'pa' } } }))({ app: 'claude', model: 'anything' });
  assert.equal(r.ok, true);
  assert.equal(r.matched.via, 'default');
  assert.equal(r.matched.ruleId, null);
});

test('预览:超长模型名与特殊字符不抛(纯查表)', () => {
  const ex = createExplainer(mkDeps({ routes: { rules: [], default: { provider: 'pa' } } }));
  for (const m of ['x'.repeat(4000), '__proto__', 'constructor', '\u0000\u0007', '中文模型']) {
    const r = ex({ app: 'claude', model: m });
    assert.equal(r.ok, true, `model=${m.slice(0, 20)} 应正常预览`);
  }
});

test('预览:事件数超过上限时截断,且 rulesOmitted 等于实际丢弃数、已留痕正好等于上限', () => {
  // 上限单位是**事件**:content 与 rule 两阶段各自遍历全部规则,故规则数 ≠ 事件数。
  // 这里造足以产生远超上限的事件数,并按真实丢弃数断言,不接受"大约"。
  const LIMIT = 20;
  const rules = Array.from({ length: 60 }, (_, i) => rule({ id: 'r' + i, match: 'nomatch' + i }));
  const r = createExplainer(mkDeps({ routes: { rules, default: { provider: 'pa' } }, limits: { maxTraceEvents: LIMIT } }))({ app: 'claude', model: 'zzz' });
  assert.equal(r.limits.truncated, true);
  assert.equal(r.limits.rulesTraced, LIMIT, '已留痕事件数必须正好等于上限(不是 <=)');
  assert.ok(r.limits.rulesOmitted > 0, 'rulesOmitted 必须是确切整数');
  // 独立算一遍期望值(逐项来源都写明,不靠"跑一遍看多少"):
  //   content 阶段 60 条(when_body_absent) + rule 阶段 60 条(no_match) + slot 阶段 1 条 + default 1 条
  const expected = 60 + 60 + 1 + 1;
  assert.equal(r.limits.rulesTraced + r.limits.rulesOmitted, expected,
    `留痕+丢弃必须等于实际事件总数(${expected})`);
  const warn = r.warnings.find(w => w.code === 'rules_truncated');
  assert.ok(warn, '必须有截断警告');
  assert.ok(warn.message.includes(String(r.limits.rulesOmitted)), '警告文案要写明丢弃了多少条,不能只说"截断了"');
});

test('预览:未触顶时 rulesOmitted 为 0 且 truncated 为 false', () => {
  const r = createExplainer(mkDeps({ routes: { rules: [rule({ id: 'r1', match: 'x' })], default: {} } }))({ app: 'claude', model: 'x' });
  assert.equal(r.limits.truncated, false);
  assert.equal(r.limits.rulesOmitted, 0);
  assert.equal(r.warnings.some(w => w.code === 'rules_truncated'), false);
});

// ---------------------------------------------------------------- F-A:短路不倒退
test('F-A:不传 trace 时 whenMissFields 短路,绝不白拼 bodyText(与 matchWhen 同求值路径)', () => {
  // ctx.bodyText 是惰性回调,压缩请求体可到上百 KB;它存在的意义就是"没真需要就别拼"。
  // 规则 when.session 不匹配且带 when.body 时,matchWhen 在 session 上就返回了,body 不该被求值。
  const routes = { rules: [rule({ id: 'rs', match: 'x', when: { session: 'want-me', body: 'sum' } })], default: { provider: 'pa' } };
  let calls = 0;
  const ctx = { session: 'other', bodyText: () => { calls++; return 'please sum'; } };

  // 不传 trace:实跑路径,必须 0 次
  const plain = createResolver(mkDeps({ routes }));
  const rPlain = plain('x', ctx, 'claude');
  assert.equal(calls, 0, '不追踪时不得求值 bodyText(否则实跑路径白付代价)');

  // 传 trace:预览要一次说全所有未命中字段,允许求值
  calls = 0;
  const traced = createResolver({ ...mkDeps({ routes }), trace: () => {} });
  const rTraced = traced('x', ctx, 'claude');
  assert.ok(calls >= 1, '追踪时要求值 bodyText 才能报出全部未命中字段');

  // 前提:这条规则 when.session 不匹配,两侧都应落到兜底(rule 为 null)
  assert.equal(rPlain.rule, null, 'session 不匹配 → 不该命中该规则');
  // 只差求值过程,返回值必须一致(用 null 安全的方式比,别假设 rule 一定存在)
  const shape = r => ({ rule: r.rule ? r.rule.id : null, members: r.members.map(m => m.provider.id), strategy: r.strategy });
  assert.deepEqual(shape(rPlain), shape(rTraced), '短路只应改变求值过程,不得改变返回值');
});

test('F-A:短路与 matchWhen 在"先不匹配字段 + 后带 body"时判定一致', () => {
  const { matchWhen } = require('../lib/routing/rules.js');
  const cases = [
    [{ when: { session: 'a', body: 'b' } }, { session: 'zzz', bodyText: () => 'b' }],
    [{ when: { ua: 'a', body: 'b' } }, { ua: 'zzz', bodyText: () => 'b' }],
    [{ when: { token: 'a', body: 'b' } }, { token: 'zzz', bodyText: () => 'b' }],
    [{ when: { session: 'a', body: 'b' } }, { session: 'a', bodyText: () => 'b' }],
    [{ when: { session: 'a', body: 'b' } }, { session: 'a', bodyText: () => 'nope' }],
  ];
  for (const [r, ctx] of cases) {
    for (const collectAll of [false, true]) {
      const viaMiss = whenMissFields(r, ctx, collectAll) === null;
      assert.equal(viaMiss, matchWhen(r, ctx),
        `不一致 collectAll=${collectAll}: ${JSON.stringify(r)} / ${JSON.stringify(ctx)}`);
    }
  }
});

// ---------------------------------------------------------------- 与真实 resolver 的一致性
test('预览与真实 resolveRoute 对同一输入给出一致的命中结果', () => {
  const routes = { rules: [
    rule({ id: 'content', match: '', provider: 'pb', priority: -1, when: { body: 'sum' } }),
    rule({ id: 'plain', match: 'opus', provider: 'pa', pool: ['pa', 'pc'] }),
  ], default: { provider: 'pc' } };
  const deps = mkDeps({ routes });
  const resolver = createResolver(deps);
  const ex = createExplainer(deps);
  const cases = [
    { model: 'opus', context: {} },
    { model: 'opus', context: { bodyText: 'please sum it' } },
    { model: 'nothing', context: {} },
    { model: '', context: {} },
    { model: 'opus', context: { session: 's' } },
  ];
  for (const c of cases) {
    const truth = resolver(c.model, { session: c.context.session, ua: c.context.ua,
      token: c.context.token, bodyText: c.context.bodyText ? () => c.context.bodyText : undefined }, 'claude');
    const preview = ex({ app: 'claude', ...c });
    assert.equal(preview.matched.ruleId, truth.rule ? truth.rule.id : null, `ruleId 不一致: ${JSON.stringify(c)}`);
    assert.equal(preview.matched.via, truth.content ? 'content' : (truth.slot ? 'slot' : (truth.rule ? 'rule' : 'default')));
    assert.deepEqual(preview.candidates.map(x => x.providerId), truth.members.map(m => m.provider.id));
  }
});

test('预览:不启用 trace 时 resolveRoute 行为与加 trace 之前一致(纯函数等价)', () => {
  // 用同一份 deps 建两个 resolver:一个带 trace、一个不带,断言返回结果逐字段相同
  const routes = { rules: [rule({ id: 'r1', match: 'x', pool: ['pa', 'pb'] })], default: { provider: 'pc' } };
  const plain = createResolver(mkDeps({ routes }));
  // 传一个真收集器(不是空函数),并把收到的事件数也记下来 —— 要证明的是
  // "收集器收到多少事件,都不影响返回值"
  const collected = [];
  const traced = createResolver({ ...mkDeps({ routes }), trace: ev => collected.push(ev) });
  for (const args of [['x', {}, 'claude'], ['nope', {}, 'claude'], ['x', { ua: 'u' }, 'codex']]) {
    const before = collected.length;
    const a = plain(...args);
    const b = traced(...args);
    // 整个返回对象逐个字段深比,不再只比手挑的子集
    assert.deepStrictEqual(b, a, `返回值必须逐字段相同: ${JSON.stringify(args)}`);
    assert.ok(collected.length > before, 'trace 应确实收到了事件(否则这条断言空转)');
  }
  // 同一个输入跑两次(收集器累积更多事件),返回值仍必须相同
  const a1 = plain('x', {}, 'claude');
  const b1 = traced('x', {}, 'claude');
  const b2 = traced('x', {}, 'claude');
  assert.deepStrictEqual(b1, a1);
  assert.deepStrictEqual(b2, a1, '收集器已累积更多事件,返回值不得受影响');

  // 显式版:传一个"只计数、什么都不存"的收集器,断言收到的事件数 > 0 而返回结果与不传时相同
  let hitCount = 0;
  const counting = createResolver({ ...mkDeps({ routes }), trace: () => { hitCount++; } });
  const c = counting('x', {}, 'claude');
  assert.ok(hitCount > 0, '计数收集器必须确实收到事件(否则这条断言空转)');
  assert.deepStrictEqual(c, plain('x', {}, 'claude'), '事件数不影响返回结果');
  assert.deepStrictEqual(c, b1, '与"存事件的收集器"也给同一个结果');
});

test('预览:trace 抛异常不影响解析结果(预览的问题不该改路由行为)', () => {
  const routes = { rules: [rule({ id: 'r1', match: 'x', pool: ['pa'] })], default: { provider: 'pc' } };
  const resolver = createResolver({ ...mkDeps({ routes }), trace: () => {} });
  const r = resolver('x', {}, 'claude');
  assert.equal(r.rule.id, 'r1');
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
  const routes = { rules: [rule({ id: 'r1', match: 'x', pool: [{ provider: 'pa', weight: 2 }] })], default: {} };
  const input = { app: 'claude', model: 'x', context: { session: 'cc:1', ua: 'ua', token: 'tk', bodyText: 'body' } };
  const before = JSON.parse(JSON.stringify(input));
  createExplainer(mkDeps({ routes }))(input);
  assert.deepEqual(input, before, 'input 必须原样不动');
});

test('零副作用:不改写调用者传入的 routes 规则数组顺序与规则对象', () => {
  const rules = [
    rule({ id: 'lo', match: 'x', provider: 'pa', priority: 0 }),
    rule({ id: 'hi', match: 'x', provider: 'pb', priority: 3 }),
  ];
  const routes = { rules, default: { provider: 'pc' } };
  const before = JSON.parse(JSON.stringify(routes));
  createExplainer(mkDeps({ routes }))({ app: 'claude', model: 'x' });
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
// 播种:一个"远古"会话 + 一个已过期冷却(0 <= now 恒真)
function seedStale(s) {
  s.sessions = new Map([['陈旧会话', { app: 'claude', providerId: 'pa', model: '', ruleId: '', label: '',
    kind: 'header', created: 0, lastUsed: 0, reqs: 0, inTok: 0, outTok: 0, pinned: false }]]);
  s.cooldowns = { pa: 0 };
}
const depsFromStore = (s, opts = {}) => ({
  getRoutes: () => opts.routes || { rules: [rule({ id: 'r1', match: 'x', pool: ['pa', 'pb'] })], default: {} },
  storeOf: app => (app === 'codex' ? STORE.codex : STORE.claude),
  resolveSlot: () => null,
  findProvider: id => STORE.claude.find(p => p.id === id) || null,
  providerApp: () => 'claude',
  listPools: () => s.pools,                       // 只读引用;浅拷贝由 explain 内部做
  inCooldown: id => s.inCooldown(id),
  healthEligible: () => true,
  // ⛔ 刻意不传 s.list / s.resolveTarget —— 它们会调 prune()。见 explain.js 的 deps 注释。
  sessionCounts: () => { const o = {}; for (const v of s.sessions.values()) o[v.providerId] = (o[v.providerId] || 0) + 1; return o; },
  uiPort: 8788,
});

test('F3-1:预览不剪枝 —— 过期会话与过期冷却调用后仍在(先反证它们本会被剪掉)', () => {
  const s = mkRealStore();
  seedStale(s);
  assert.equal(s.sessions.has('陈旧会话'), true, '播种后应在');

  // 反证:真正的 prune 入口会删掉它们。没有这一步,"还在"可能只因种子压根不过期(空转通过)。
  s.list({ findProvider: () => null, short: k => k });
  assert.equal(s.sessions.has('陈旧会话'), false, '反证失败:session 应按 TTL 被剪掉');
  assert.equal('pa' in s.cooldowns, false, '反证失败:过期冷却应被剪掉');

  // 正证:重置种子后走 explain,两者都必须原样保留
  seedStale(s);
  const r = createExplainer(depsFromStore(s))({ app: 'claude', model: 'x' });
  assert.equal(r.ok, true);
  assert.equal(s.sessions.has('陈旧会话'), true, '预览不得顺手删用户的会话');
  assert.equal('pa' in s.cooldowns, true, '预览不得顺手删冷却条目');
});

test('F3-2:预览前后 store 的 pools 逐字节不变(round_robin 游标)', () => {
  const s = mkRealStore();
  seedStale(s);
  const before = JSON.stringify(s.pools);
  const ex = createExplainer(depsFromStore(s));
  for (let i = 0; i < 5; i++) ex({ app: 'claude', model: 'x' });
  assert.equal(JSON.stringify(s.pools), before, 'pools 必须一个字节都没变');
});

test('F3-2 反证:直接经 pickMember 走活游标确实会前移(证明上一条不是空转)', () => {
  const s = mkRealStore();
  const members = [{ provider: { id: 'pa' }, model: '', weight: 1 }, { provider: { id: 'pb' }, model: '', weight: 1 }];
  const before = JSON.stringify(s.pools);
  // 传**活引用**(explain 不会这么干):游标应当被前移
  pickMember({ id: 'r1' }, members, { eligible: () => true, pools: s.pools });
  assert.notEqual(JSON.stringify(s.pools), before, '反证失败:活引用本应前移游标');
});

test('F3-3:预览前后 weighted 的 current 不变(且反证活引用会改写)', () => {
  const s = mkRealStore();
  const wrule = rule({ id: 'rw', match: 'x', pool: [{ provider: 'pa', weight: 3 }, { provider: 'pb', weight: 1 }], strategy: 'weighted' });
  const deps = depsFromStore(s, { routes: { rules: [wrule], default: {} } });
  const ex = createExplainer(deps);
  ex({ app: 'claude', model: 'x' });                 // 先让 explain 建一次余量记录
  const before = JSON.stringify(s.pools);
  for (let i = 0; i < 4; i++) ex({ app: 'claude', model: 'x' });
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
  const r = createExplainer(base)({ app: 'claude', model: 'x', context: { session: 'cc:1' } });
  assert.equal(r.ok, true);
  assert.equal(s.sessions.has('陈旧会话'), true);
});

// ---------------------------------------------------------------- 生产路径:_state.pools
// 主会话已在 mixrouter.js 的 _state 里加了 `get pools(){ return sess.pools; }`(必须是 getter:
// resetPools() 会整份换掉那个对象,写成快照会在重置后指向旧表,断言就变成跟没人用的对象比)。
// 上面 F3-2/F3-3 用隔离 store 验的是"模块不改传进去的东西";这一节验的是**生产表本身**没动。
// 规则仍用 fixture,但 listPools 指向**现役服务**的 _state.pools。
const prodDeps = (routes) => ({ ...mkDeps({ routes }), listPools: () => require('../mixrouter.js')._state.pools });

test('P4:explain 前后 _state.pools deepStrictEqual(生产路径,不是隔离 store)', () => {
  const m = require('../mixrouter.js');
  // 先播种一个已知游标,避免"空表前后都空"这种空转。
  // ⚠ resetPools() 是整份替换对象,所以**必须重置之后再取引用** ——
  //   先取引用再 reset,写的就是一张已经没人用的旧表(这条断言自己就踩过一次,见测试说明)。
  m._state.resetPools();
  const p = m._state.pools;
  assert.notEqual(p, undefined, '_state.pools 在 resetPools 之后仍必须是可读对象');
  p.r1 = 3;
  const before = JSON.stringify(m._state.pools);
  const r = createExplainer(prodDeps({ rules: [rule({ id: 'r1', match: 'x', pool: ['pa', 'pb'] })], default: {} }))({ app: 'claude', model: 'x' });
  assert.equal(r.ok, true);
  const p2 = m._state.pools;
  assert.notEqual(p2, undefined, '调用后仍必须是可读对象');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p2)), JSON.parse(before), '_state.pools 必须一个字节都没变');
  assert.equal(p2.r1, 3, '播种的游标必须原样还在(不是被重置掉的空表)');
  m._state.resetPools();
});

test('P4:预览不前移生产 round_robin 游标(且反证:直接 pickMember 走活表确实会前移)', () => {
  const m = require('../mixrouter.js');
  m._state.resetPools();
  m._state.pools.r1 = 0;
  const before = JSON.stringify(m._state.pools);

  const ex = createExplainer(prodDeps({ rules: [rule({ id: 'r1', match: 'x', pool: ['pa', 'pb'] })], default: {} }));
  for (let i = 0; i < 5; i++) {
    const r = ex({ app: 'claude', model: 'x' });
    assert.equal(r.ok, true);
    assert.equal(r.selection.predicted.providerId, 'pa', '游标没被消耗,每次都应预测同一项');
  }
  assert.equal(JSON.stringify(m._state.pools), before, '预览不得前移生产游标');

  // 反证:传活表给 pickMember 会前移 —— 证明上一条不是空转(不是"压根没走到轮转分支")
  const members = [{ provider: { id: 'pa' }, model: '', weight: 1 }, { provider: { id: 'pb' }, model: '', weight: 1 }];
  pickMember({ id: 'r1' }, members, { eligible: () => true, pools: m._state.pools });
  assert.notEqual(JSON.stringify(m._state.pools), before, '反证失败:活表本应被前移');
  m._state.resetPools();
});

test('P4:预览不消耗生产 weighted 余量', () => {
  const m = require('../mixrouter.js');
  m._state.resetPools();
  const routes = { rules: [rule({ id: 'rw', match: 'x', pool: [{ provider: 'pa', weight: 3 }, { provider: 'pb', weight: 1 }], strategy: 'weighted' })], default: {} };
  const exW = createExplainer(prodDeps(routes));
  exW({ app: 'claude', model: 'x' });                    // 建一次余量记录
  // 播种一个非零余量,避免"空表前后都空"空转
  m._state.pools.__w_rw = [{ provider: { id: 'pa' }, weight: 3, current: 7 }];
  const before = JSON.stringify(m._state.pools);
  for (let i = 0; i < 4; i++) exW({ app: 'claude', model: 'x' });
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
  //   而按规则取游标的实现只读 'r1',两条路径这才分得开。
  const routes = { rules: [rule({ id: 'r1', match: 'x', pool: ['pa', 'pb', 'pc'] })], default: {} };
  const deps = mkDeps({ routes, pools: { r1: 0, 'r1|session-AAA': 1 } });
  const ex = createExplainer(deps);
  const a = ex({ app: 'claude', model: 'x', context: { session: 'session-AAA' } });
  const b = ex({ app: 'claude', model: 'x', context: { session: 'session-BBB' } });
  assert.ok(a.selection.predicted);
  assert.equal(a.selection.predicted.providerId, 'pa', '会话后缀不得影响游标取值(按规则取,应读到 r1=0)');
  assert.equal(b.selection.predicted.providerId, 'pa', '换一个 session 名不得改变落点预测');
  assert.equal(a.selection.predicted.providerId, b.selection.predicted.providerId);

  // 同一件事覆盖全部可预测策略
  for (const strat of ['round_robin', 'weighted', 'least_used', 'priority']) {
    const pool = strat === 'weighted'
      ? [{ provider: 'pa', weight: 3 }, { provider: 'pb', weight: 1 }]
      : ['pa', 'pb', 'pc'];
    const rt = { rules: [rule({ id: 'rfe-' + strat, match: 'x', pool, strategy: strat })], default: {} };
    const depsS = mkDeps({ routes: rt, pools: { ['rfe-' + strat]: 0, ['rfe-' + strat + '|session-X']: 1 } });
    const exS = createExplainer(depsS);
    const ra = exS({ app: 'claude', model: 'x', context: { session: 'X' } });
    const rb = exS({ app: 'claude', model: 'x', context: { session: 'Y' } });
    assert.equal(ra.selection.deterministic, true, strat + ' 应为可预测策略');
    assert.equal(ra.selection.predicted.providerId, rb.selection.predicted.providerId,
      strat + ':换一个 session 名不得改变落点预测(游标按规则存,不按会话分桶)');
  }
});

test('F-KEY 反证:同一 session 连预览两次落点稳定(证明真的走到了挑选分支)', () => {
  const routes = { rules: [rule({ id: 'r1', match: 'x', pool: ['pa', 'pb'] })], default: {} };
  const ex = createExplainer(mkDeps({ routes, pools: { r1: 0 } }));
  const in1 = { app: 'claude', model: 'x', context: { session: 's' } };
  assert.equal(ex(in1).selection.predicted.providerId, 'pa');
  assert.equal(ex(in1).selection.predicted.providerId, 'pa');
  // 反证:把游标手动前移到 1,落点必须跟着变 —— 说明 predicted 确实来自游标
  const ex2 = createExplainer(mkDeps({ routes, pools: { r1: 1 } }));
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
    ['findProvider', 'getRoutes', 'healthEligible', 'inCooldown', 'listPools', 'providerApp',
      'resolveSlot', 'sessionCounts', 'sessionSnapshot', 'storeOf', 'uiPort'].sort(),
    'deps 名单变了:请确认新入口是纯读的,再更新这条断言');

  // 反思式交叉验证:真传进去也不会被调用(源码断言 + 行为断言,两条一起才叫钉死)
  let touched = 0;
  const deps = mkDeps({ routes: { rules: [], default: { provider: 'pa' } } });
  for (const name of ['resolveTarget', 'list', 'prune', 'sessionList']) {
    deps[name] = () => { touched++; throw new Error(`预览不该调用 ${name}`); };
  }
  assert.equal(createExplainer(deps)({ app: 'claude', model: 'x' }).ok, true);
  assert.equal(touched, 0, '即便调用方多传了这些键,预览也不得调用它们');
});
