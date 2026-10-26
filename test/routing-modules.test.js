'use strict';
// 拆分出来的模块边界测试:端点识别 / 头值归一化 / 规则匹配优先级 / 池策略 /
// 会话状态 / 路由解析。全部是纯单元测试,环境隔离,不碰真实配置与网络。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const endpoints = require(path.join(ROOT, 'lib/routing/endpoints.js'));
const headersLib = require(path.join(ROOT, 'lib/routing/headers.js'));
const rulesLib = require(path.join(ROOT, 'lib/routing/rules.js'));
const strategyLib = require(path.join(ROOT, 'lib/routing/strategy.js'));
const poolLib = require(path.join(ROOT, 'lib/routing/pool.js'));
const { createResolver } = require(path.join(ROOT, 'lib/routing/resolve.js'));
const { createSessionStore } = require(path.join(ROOT, 'lib/routing/sessions.js'));
const identity = require(path.join(ROOT, 'lib/session/identity.js'));
const slotsLib = require(path.join(ROOT, 'lib/routing/slots.js'));

// ---------------------------------------------------------------- 端点识别
test('classifyProxyRequest:带查询串/末尾斜杠都认,未知路径返回 null', () => {
  const hit = url => {
    const e = endpoints.classifyProxyRequest({ url });
    return e && `${e.app}/${e.kind}`;
  };
  assert.equal(hit('/v1/messages'), 'claude/messages');
  assert.equal(hit('/v1/messages/?beta=1'), 'claude/messages');
  assert.equal(hit('/v1/messages/count_tokens'), 'claude/count_tokens');
  assert.equal(hit('/v1/responses'), 'codex/responses');
  assert.equal(hit('/v1/chat/completions?x=1'), 'codex/chat/completions');
  assert.equal(hit('/v1/embeddings'), null);
  assert.equal(hit('/v1/messages/extra'), null);
  // req 畸形(没有 url)不能抛
  assert.equal(endpoints.classifyProxyRequest({}), null);
  assert.equal(endpoints.classifyProxyRequest(null), null);
});

test('wireOf:Claude 组默认 anthropic,标了才翻译;Codex 组默认 responses', () => {
  assert.equal(endpoints.wireOf({}, 'claude'), 'anthropic');
  assert.equal(endpoints.wireOf({ wire_api: 'chat' }, 'claude'), 'chat');
  assert.equal(endpoints.wireOf({ wire_api: 'responses' }, 'claude'), 'responses');
  assert.equal(endpoints.wireOf({ wire_api: 'nonsense' }, 'claude'), 'anthropic');
  assert.equal(endpoints.wireOf({}, 'codex'), 'responses');
  assert.equal(endpoints.wireOf({ wire_api: 'chat' }, 'codex'), 'chat');
  // 渠道对象缺失也要给默认协议,不能抛(调用点在转发路径上)
  assert.equal(endpoints.wireOf(null, 'claude'), 'anthropic');
  assert.equal(endpoints.wireOf(undefined, 'codex'), 'responses');
});

test('joinUpstreamPath:base 自带 /v1 不重复,自定义前缀保留', () => {
  assert.equal(endpoints.joinUpstreamPath('https://a.example', '/v1/messages'), 'https://a.example/v1/messages');
  assert.equal(endpoints.joinUpstreamPath('https://a.example/', '/v1/messages'), 'https://a.example/v1/messages');
  assert.equal(endpoints.joinUpstreamPath('https://a.example/v1', '/v1/messages'), 'https://a.example/v1/messages');
  assert.equal(endpoints.joinUpstreamPath('https://a.example/openai/v1', '/v1/responses'), 'https://a.example/openai/v1/responses');
});

// ---------------------------------------------------------------- 头值与 URL
test('safeHeader:剥非 ASCII、trim、并按 256 截断(响应头有 16KB 上限)', () => {
  assert.equal(headersLib.safeHeader('  渠道①名 ok '), 'ok');
  assert.equal(headersLib.safeHeader(null), '');
  assert.equal(headersLib.safeHeader(undefined), '');
  const long = 'm'.repeat(5000);
  assert.equal(headersLib.safeHeader(long).length, 256);
  // 截断发生在消洗之后:纯非 ASCII 的长串结果为空
  assert.equal(headersLib.safeHeader('中'.repeat(5000)), '');
});

test('authHeaderValue/hasCtlChar:换行控制字符一律剔除(否则转发时同步抛)', () => {
  assert.equal(headersLib.authHeaderValue('sk-abc\n'), 'sk-abc');
  assert.equal(headersLib.authHeaderValue('sk-a\r\nX-Injected: 1'), 'sk-aX-Injected: 1');
  assert.equal(headersLib.authHeaderValue(null), '');
  assert.equal(headersLib.hasCtlChar('sk\n1'), true);
  assert.equal(headersLib.hasCtlChar('sk-1'), false);
  assert.equal(headersLib.hasCtlChar(null), false);
});

test('validBaseUrl:只认无凭据的 http(s)', () => {
  assert.equal(headersLib.validBaseUrl('https://api.example.com'), true);
  assert.equal(headersLib.validBaseUrl('http://127.0.0.1:8080/v1'), true);
  assert.equal(headersLib.validBaseUrl('ftp://api.example.com'), false);
  assert.equal(headersLib.validBaseUrl('https://user:pass@api.example.com'), false);
  assert.equal(headersLib.validBaseUrl('not a url'), false);
  assert.equal(headersLib.validBaseUrl(undefined), false);
});

// ---------------------------------------------------------------- 规则归一化与匹配
test('normalizeRule:when.* 只收字符串/数字,对象要抛 400 而不是存成 [object Object]', () => {
  // message 与 statusCode 与 lib/zcode-config.js 的 invalid() 保持同形(路由层不再依赖它)
  const assertInvalid = (rule, field) => {
    assert.throws(() => rulesLib.normalizeRule(rule),
      e => e.statusCode === 400 && e.message === `路由规则的 when.${field} 必须是字符串`);
  };
  assertInvalid({ when: { body: {} } }, 'body');
  assertInvalid({ when: { session: [] } }, 'session');
  assertInvalid({ when: { ua: true } }, 'ua');
  assertInvalid({ when: { token: false } }, 'token');
  // null/''/undefined 是"没设这个条件",直接丢字段而不是抛(与拆分前一致)
  assert.deepEqual(rulesLib.normalizeRule({ when: { token: null } }).when, {});
  assert.deepEqual(rulesLib.normalizeRule({ when: { token: '' } }).when, {});
  assert.deepEqual(rulesLib.normalizeRule({ when: { token: undefined } }).when, {});
  // 数字是合法的 when 值(会被收敛成字符串)
  assert.deepEqual(rulesLib.normalizeRule({ when: { token: 0 } }).when, { token: '0' });
  const r = rulesLib.normalizeRule({ when: { body: 'summarize', ua: 123 }, priority: '7' });
  assert.equal(r.when.body, 'summarize');
  assert.equal(r.when.ua, '123');
  assert.equal(r.priority, 7);
  // 空值直接丢字段,不落成空串之外的垃圾
  assert.deepEqual(rulesLib.normalizeRule({ when: { session: '', ua: null } }).when, {});
});

test('normalizeRule:pool 里字符串与对象混用都收,坏元素剔除,策略越界回落', () => {
  const r = rulesLib.normalizeRule({
    pool: ['pa', '  ', null, { provider: 'pb', model: 'm2', weight: '3' }, { provider: '' }, { model: 'no-provider' }],
    strategy: 'bogus', app: 'nope', enabled: 0,
  });
  assert.deepEqual(r.pool, ['pa', { provider: 'pb', model: 'm2', weight: 3 }]);
  assert.equal(r.strategy, 'round_robin');
  assert.equal(r.app, '');
  assert.equal(r.enabled, true, '只有显式 false 才算停用,0/空串都不算');
  assert.equal(rulesLib.normalizeRule({ enabled: false }).enabled, false);
  assert.equal(rulesLib.normalizeRule(null).enabled, true);
  assert.equal(rulesLib.normalizeRule({ priority: 'abc' }).priority, 0);
});

test('matchHits:逗号分隔、大小写不敏感、空 match 返回空数组', () => {
  assert.deepEqual(rulesLib.matchHits({ match: 'Opus, claude-3-opus ,, ' }), ['opus', 'claude-3-opus']);
  assert.deepEqual(rulesLib.matchHits({ match: '' }), []);
  assert.deepEqual(rulesLib.matchHits(null), []);
});

test('matchWhen:全字段与语义、空条件恒真、body 走惰性回调', () => {
  let calls = 0;
  const ctx = { session: 'cc:abc', ua: 'claude-cli/2.1', token: 'tk1', bodyText: () => { calls++; return 'DETAILED SUMMARY'; } };
  assert.equal(rulesLib.matchWhen({}, ctx), true);
  assert.equal(rulesLib.matchWhen({ when: { session: 'abc', ua: 'CLAUDE-CLI', token: 'tk1', body: 'summary' } }, ctx), true);
  assert.equal(rulesLib.matchWhen({ when: { session: 'abc', token: 'nope' } }, ctx), false);
  // 只有真有 body 条件时才取匹配文本(压缩请求体可以上百 KB)
  calls = 0;
  rulesLib.matchWhen({ when: { ua: 'claude' } }, ctx);
  assert.equal(calls, 0);
  // 没有 bodyText 回调时报"不匹配"而不是抛
  assert.equal(rulesLib.matchWhen({ when: { body: 'x' } }, {}), false);
  assert.equal(rulesLib.matchWhen(undefined, undefined), true);
});

test('ruleBelongsToApp:显式 app 只在自组生效;Codex 组跳过纯 Claude 规则', () => {
  const providerApp = id => ({ pc: 'claude', px: 'codex' }[id] || null);
  assert.equal(rulesLib.ruleBelongsToApp({ app: 'codex' }, 'claude', providerApp), false);
  assert.equal(rulesLib.ruleBelongsToApp({ app: 'codex' }, 'codex', providerApp), true);
  // 没声明 app:Claude 通路保持原语义(一律算命中,好让停用/删除有明确报错)
  assert.equal(rulesLib.ruleBelongsToApp({ provider: 'px' }, 'claude', providerApp), true);
  // Codex 通路:只绑 Claude 渠道的规则让位给后面的规则
  assert.equal(rulesLib.ruleBelongsToApp({ provider: 'pc' }, 'codex', providerApp), false);
  assert.equal(rulesLib.ruleBelongsToApp({ pool: ['pc', { provider: 'px' }] }, 'codex', providerApp), true);
  assert.equal(rulesLib.ruleBelongsToApp({}, 'codex', providerApp), true);
  // 幽灵引用(渠道根本查不到)仍算本组规则:报错比静默跳过有用
  assert.equal(rulesLib.ruleBelongsToApp({ provider: 'gone' }, 'codex', providerApp), true);
});

test('rulesByPriority:高 priority 先,同值保持数组顺序,且不改动调用者的数组', () => {
  const rules = [
    { id: 'a', priority: 0 }, { id: 'b', priority: 5 }, { id: 'c', priority: 0 }, { id: 'd', priority: -1 },
  ];
  const order = rulesLib.rulesByPriority(rules).map(x => x.r.id);
  assert.deepEqual(order, ['b', 'a', 'c', 'd']);
  assert.deepEqual(rules.map(r => r.id), ['a', 'b', 'c', 'd'], '原数组顺序不得被 sort 打乱');
  assert.deepEqual(rulesLib.rulesByPriority(undefined), []);
  assert.deepEqual(rulesLib.rulesByPriority({}), []);
});

// ---------------------------------------------------------------- 渠道池
test('poolMembers:不修改调用者传入的规则对象;停用成员池里跳过、单选保留', () => {
  const store = [
    { id: 'pa', name: 'A', model: '' },
    { id: 'pb', name: 'B', model: 'bm', enabled: false },
    { id: 'pc', name: 'C', model: 'cm' },
  ];
  const group = store;
  const rule = { pool: ['pa', 'pb', 'pc'], provider: 'pb', model: 'rm' };
  const snapshot = JSON.parse(JSON.stringify(rule));
  const members = poolLib.poolMembers(group, rule, 'claude');
  assert.deepEqual(members.map(m => [m.provider.id, m.model, m.weight]),
    [['pa', 'rm', 1], ['pc', 'rm', 1]]);
  assert.deepEqual(rule, snapshot, '规则对象不得被就地改写');

  // 池里一个可用都没有 → 回落到单一目标(即使它是停用的),好让调用方报 provider_disabled
  const single = { pool: ['pb'], provider: 'pb', model: 'rm' };
  assert.deepEqual(poolLib.poolMembers(group, single, 'claude').map(m => m.provider.id), ['pb']);

  // Codex 组:渠道自带模型名,规则模型优先
  assert.equal(poolLib.poolMembers(group, { pool: ['pc'] }, 'codex')[0].model, 'cm');
  assert.equal(poolLib.poolMembers(group, { pool: ['pc'], model: 'rm' }, 'codex')[0].model, 'rm');
  // 没有 pool 也没有 provider → 空池(调用方据此报 no_route_error)
  assert.deepEqual(poolLib.poolMembers(group, { provider: '' }, 'claude'), []);
  assert.deepEqual(poolLib.poolMembers(group, null, 'claude'), []);
});

test('ghostRefs:池成员编号与单一目标分开报,null 规则返回空', () => {
  const findProvider = id => (id === 'alive' ? { id } : null);
  assert.deepEqual(poolLib.ghostRefs(findProvider, null), []);
  assert.deepEqual(poolLib.ghostRefs(findProvider, { provider: 'alive', pool: ['alive'] }), []);
  assert.deepEqual(poolLib.ghostRefs(findProvider, { provider: 'dead1', pool: ['alive', 'dead2'] }),
    [{ where: '池成员 2', id: 'dead2' }, { where: '单一目标', id: 'dead1' }]);
});

// ---------------------------------------------------------------- 池策略
const member = (id, weight = 1) => ({ provider: { id }, model: '', weight });

test('pickMember round_robin:按规则游标轮转,单成员直接返回', () => {
  const pools = {};
  const members = [member('a'), member('b')];
  const seq = [0, 1, 2, 3].map(() => strategyLib.pickMember({ id: 'r1' }, members, { eligible: () => true, pools }).provider.id);
  assert.deepEqual(seq, ['a', 'b', 'a', 'b']);
  assert.equal(strategyLib.pickMember({ id: 'r1' }, [member('solo')], { eligible: () => true, pools }).provider.id, 'solo');
  // 不同规则各走各的游标
  assert.equal(strategyLib.pickMember({ id: 'r2' }, members, { eligible: () => true, pools }).provider.id, 'a');
});

test('pickMember priority:永远取池序第一个可用,主渠道不可用才降级', () => {
  const members = [member('main'), member('backup')];
  const pick = eligible => strategyLib.pickMember({ id: 'r', strategy: 'priority' }, members, { eligible, pools: {} }).provider.id;
  assert.equal(pick(() => true), 'main');
  assert.equal(pick(id => id !== 'main'), 'backup');
  // 全池不可用 → 兜底回全量(宁可再试冷却渠道也不死锁)
  assert.equal(pick(() => false), 'main');
});

test('pickMember least_used:按注入的活跃会话数取最小', () => {
  const members = [member('a'), member('b'), member('c')];
  const counts = { a: 5, b: 1, c: 3 };
  const got = strategyLib.pickMember({ id: 'r', strategy: 'least_used' }, members,
    { eligible: () => true, activeCount: id => counts[id], pools: {} });
  assert.equal(got.provider.id, 'b');
});

test('pickMember weighted:长跑比例正确,且不往调用者的成员对象上写 current', () => {
  const members = [member('a', 3), member('b', 1)];
  const pools = {};
  const tally = { a: 0, b: 0 };
  for (let i = 0; i < 40; i++) tally[strategyLib.pickMember({ id: 'rw', strategy: 'weighted' }, members, { eligible: () => true, pools }).provider.id]++;
  assert.deepEqual(tally, { a: 30, b: 10 });
  assert.equal('current' in members[0], false, '调用者传入的成员对象不得被写入 current');
  assert.equal('current' in members[1], false);
  // 跨调用保留余量(同一个 pools 表)
  assert.ok(Array.isArray(pools.__w_rw));
});

test('pickMember random:只在候选集里出;cool 掉的成员不参与', () => {
  // 固定 Math.random 的两个端点,断言确定的边界值,不依赖概率采样
  const members = [member('a'), member('b'), member('c')];
  const pickWith = (rnd, eligible) => {
    const orig = Math.random;
    Math.random = () => rnd;
    try {
      return strategyLib.pickMember({ id: 'rr', strategy: 'random' }, members, { eligible, pools: {} }).provider.id;
    } finally { Math.random = orig; }
  };
  const all = () => true;
  assert.equal(pickWith(0, all), 'a', 'Math.random()=0 → 候选集第一个');
  assert.equal(pickWith(0.999999, all), 'c', 'Math.random()→1⁻ → 候选集最后一个');

  // 冷却成员被剔出候选集后,上界随之收缩
  const coolC = id => id !== 'c';
  assert.equal(pickWith(0.999999, coolC), 'b', 'c 被冷却后,上界变成 b');
  assert.equal(pickWith(0, coolC), 'a');

  // 只剩一个可用成员时直接返回它,不看随机数
  const onlyB = id => id === 'b';
  assert.equal(pickWith(0, onlyB), 'b');
  assert.equal(pickWith(0.999999, onlyB), 'b');
  // Math.random 必须在 try/finally 里恢复(前一个断言失败也不能污染后续测试)
  assert.equal(typeof Math.random(), 'number');
});

test('strategyOf:白名单外一律 round_robin', () => {
  for (const s of ['round_robin', 'weighted', 'least_used', 'random', 'priority'])
    assert.equal(strategyLib.strategyOf({ strategy: s }), s);
  assert.equal(strategyLib.strategyOf({ strategy: 'bogus' }), 'round_robin');
  assert.equal(strategyLib.strategyOf(null), 'round_robin');
});

test('pickWeighted:空数组返回 null;单成员也扣余量不改权重', () => {
  assert.equal(strategyLib.pickWeighted([]), null);
  const one = [member('a', 2)];
  assert.equal(strategyLib.pickWeighted(one).provider.id, 'a');
  assert.equal(one[0].weight, 2);
});

// ---------------------------------------------------------------- 会话状态
// loadJson/saveJson 都是 stub,不会真读写磁盘 —— 路径用一个虚构的绝对路径即可,
// 不必 mkdtemp(也就不产生需要清理的临时目录)
const mkStore = (over = {}) => {
  let clock = 1000;
  const saved = [];
  const store = createSessionStore({
    sessionsFile: '/nonexistent-mixr-test/sessions.json', ttlMs: 1000, max: 3, cooldownMs: 500,
    loadJson: () => null, saveJson: (f, d) => saved.push(d),
    storeOf: app => (app === 'codex' ? (over.codex || []) : (over.claude || [])),
    providerEligible: over.eligible || (() => true),
    now: () => clock,
    ...(over.deps || {}),
  });
  return { store, saved, tick: ms => { clock += ms; } };
};

test('会话 store:TTL 过期与容量上限都按 lastUsed 淘汰', () => {
  const { store, tick } = mkStore();
  store.entry('cc:old', 'header', '', 'claude');
  tick(1500);
  store.entry('cc:new', 'header', '', 'claude');
  store.prune();
  assert.equal(store.sessions.has('cc:old'), false);
  assert.equal(store.sessions.has('cc:new'), true);

  const cap = mkStore();
  for (const k of ['k1', 'k2', 'k3', 'k4']) { cap.store.entry(k, 'header', '', 'claude'); cap.tick(10); }
  cap.store.prune();
  assert.equal(cap.store.sessions.size, 3);
  assert.equal(cap.store.sessions.has('k1'), false, '最久未用的先淘汰');
});

test('resolveTarget:粘性复用已绑渠道;不可用则重绑并重新挑', () => {
  let eligible = true;
  const { store } = mkStore({
    claude: [{ id: 'pa' }, { id: 'pb' }],
    eligible: () => eligible,
  });
  const s = store.entry('cc:1', 'header', '', 'claude');
  s.providerId = 'pb';
  const members = [{ provider: { id: 'pa' }, model: '', weight: 1 }, { provider: { id: 'pb' }, model: '', weight: 1 }];
  const first = store.resolveTarget({ id: 'r1' }, members, 'cc:1', '', 'header', 'claude');
  assert.deepEqual([first.member.provider.id, first.sticky, first.rebind], ['pb', true, false]);

  eligible = false;
  const second = store.resolveTarget({ id: 'r1' }, members, 'cc:1', '', 'header', 'claude');
  assert.equal(second.rebind, true);
  assert.equal(second.sticky, true, '原本有绑定 → 标为"重绑过"');
  // 全新会话:sticky 为 false
  const fresh = store.resolveTarget({ id: 'r1' }, members, 'cc:fresh', '', 'header', 'claude');
  assert.equal(fresh.sticky, false);
  assert.equal(fresh.rebind, true);
});

test('resolveTarget:手动钉定压过策略,但槽位请求不被钉定劫持', () => {
  const { store } = mkStore({ claude: [{ id: 'pin' }, { id: 'other' }] });
  const s = store.entry('cc:p', 'header', '', 'claude');
  s.providerId = 'pin'; s.pinned = true;
  const members = [{ provider: { id: 'other' }, model: 'om', weight: 1 }];
  // 池里根本没有 pin,钉定照样走它
  const pinned = store.resolveTarget({ id: 'r1', model: 'rm' }, members, 'cc:p', '', 'header', 'claude');
  assert.deepEqual([pinned.member.provider.id, pinned.member.model], ['pin', 'rm']);

  // 槽位请求:不劫持,照槽位表的落点模型走
  const slot = store.resolveTarget({ id: 'slot:claude/haiku', model: 'slotm' }, members, 'cc:p', '', 'header', 'claude');
  assert.deepEqual([slot.member.provider.id, slot.member.model], ['other', 'om']);
});

test('resolveTarget:槽位备池按自己的策略选择,不复用对话粘性或重绑对话', () => {
  for (const pinned of [false, true]) {
    const { store } = mkStore({ claude: [{ id: 'pa' }, { id: 'pb' }] });
    const session = store.entry('cc:slot-pool', 'header', '原对话', 'claude');
    session.providerId = 'pb'; session.pinned = pinned; session.model = 'conversation-model';
    const before = JSON.stringify(session);
    const members = [
      { provider: { id: 'pa' }, model: 'slot-main', weight: 1 },
      { provider: { id: 'pb' }, model: 'slot-backup', weight: 1 },
    ];
    const result = store.resolveTarget({ id: 'slot:claude/haiku', strategy: 'priority' }, members,
      'cc:slot-pool', '槽位请求', 'header', 'claude');
    assert.deepEqual([result.member.provider.id, result.member.model, result.sticky, result.rebind],
      ['pa', 'slot-main', false, false]);
    assert.equal(JSON.stringify(session), before, '槽位选择不改对话绑定、标签或使用时间');
  }
});

test('会话 store:旧冷却接口无效,pools 可整体作废,sessions setter 拒收非 Map', () => {
  const { store } = mkStore({ claude: [{ id: 'pa' }] });
  store.markCooldown('pa');
  assert.equal(store.inCooldown('pa'), false);
  store.markCooldown('');
  assert.equal(store.inCooldown(''), false);
  store.cooldowns = {};
  assert.equal(store.inCooldown('pa'), false);
  store.cooldowns = null;   // 传垃圾退化成空表,不抛
  assert.deepEqual(store.cooldowns, {});

  store.resetPools();
  assert.deepEqual(store.pools, {});

  // 传对象会静默清空整张绑定表,所以直接拒收
  assert.throws(() => { store.sessions = { 'cc:1': {} }; }, TypeError);
  store.sessions = new Map([['cc:9', { providerId: 'pa' }]]);
  assert.equal(store.sessions.size, 1);
});

test('会话 store:list 的输出不含密钥且按 lastUsed 倒序', () => {
  const { store, tick } = mkStore({ claude: [{ id: 'pa', name: 'A', api_key: 'sk-secret' }] });
  const s = store.entry('cc:1', 'header', 'label', 'claude');
  s.providerId = 'pa'; s.reqs = 2;
  tick(5);
  store.entry('cc:2', 'fp', '', 'claude');
  const rows = store.list({ findProvider: id => ({ id, name: 'A' }), short: k => k.slice(-1) });
  assert.deepEqual(rows.map(r => r.key), ['cc:2', 'cc:1']);
  assert.equal(JSON.stringify(rows).includes('sk-secret'), false);
  assert.equal(rows[1].provider_name, 'A');
  assert.equal(rows[1].short, '1');
});

test('会话落盘:saveSoon 去抖后写出的形状与 flush 一致', async () => {
  const { store, saved } = mkStore();
  store.entry('cc:1', 'header', '', 'claude');
  store.saveSoon();
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].version, 1);
  assert.deepEqual(Object.keys(saved[0].bindings), ['cc:1']);
  // 没有新改动时 flush 不再写盘
  store.flush();
  assert.equal(saved.length, 1);
});

// ---------------------------------------------------------------- 会话身份
test('sessionIdentity:头 > 请求体字段 > 内容指纹;两种客户端前缀不撞车', () => {
  const cc = identity.sessionIdentity({ headers: { 'x-claude-code-session-id': 's1' } }, {}, 'claude');
  assert.deepEqual(cc, { key: 'cc:s1', kind: 'header' });
  const meta = identity.sessionIdentity({ headers: {} }, { metadata: { user_id: '{"session_id":"s2"}' } }, 'claude');
  assert.deepEqual(meta, { key: 'cc:s2', kind: 'metadata' });
  const fp = identity.sessionIdentity({ headers: {} }, { system: 'sys', messages: [{ role: 'user', content: 'hi' }] }, 'claude');
  assert.equal(fp.kind, 'fingerprint');
  assert.match(fp.key, /^fp:[0-9a-f]{16}$/);
  // 同样内容再来一次 → 同一个 key(跨轮稳定)
  assert.equal(identity.sessionIdentity({ headers: {} }, { system: 'sys', messages: [{ role: 'user', content: 'hi' }] }, 'claude').key, fp.key);
  // 什么都没有 → anon,而不是抛
  assert.deepEqual(identity.sessionIdentity({ headers: {} }, {}, 'claude'), { key: 'anon', kind: 'anon' });
  // Codex 侧
  assert.equal(identity.sessionIdentity({ headers: { 'thread-id': 't1' } }, {}, 'codex').key, 'cx:t1');
  assert.equal(identity.sessionIdentity({ headers: {} }, { prompt_cache_key: 'p1' }, 'codex').kind, 'metadata');
  assert.deepEqual(identity.sessionIdentity({ headers: {} }, {}, 'codex'), { key: 'cx-anon', kind: 'anon' });
  // req/headers 缺失不抛
  assert.equal(identity.sessionIdentity(null, null, 'claude').kind, 'anon');
});

test('firstUserText/bodyRouteText:畸形 messages 不抛,字符串与数组形状结果一致', () => {
  assert.equal(identity.firstUserText({ messages: [null, 7, { role: 'user', content: 'ok' }] }), 'ok');
  assert.equal(identity.firstUserText({ messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'text', text: 'real' }] }] }), 'real');
  assert.equal(identity.firstUserText({}), '');
  assert.equal(identity.bodyRouteText({}), '');

  const a = identity.bodyRouteText({ system: 'sys', input: 'please summarize this' });
  const b = identity.bodyRouteText({ instructions: 'sys', input: [{ role: 'user', content: 'please summarize this' }] });
  assert.equal(a, b, 'Responses 的字符串 input 与数组形状必须等价');
  assert.equal(identity.bodyRouteText({ input: '' }), '');
  // 历史消息不进匹配文本(防劫持)
  const t = identity.bodyRouteText({ messages: [{ role: 'user', content: 'OLD' }, { role: 'user', content: 'NEW' }] });
  assert.equal(t.includes('OLD'), false);
  assert.equal(t.includes('NEW'), true);
  // 数组元素是 null/数字时不得抛
  assert.equal(identity.bodyRouteText({ messages: [null, 3, { role: 'user', content: 'x' }] }), 'x');
});

test('applyLabel:内部文案不覆盖真标签;关标签开关时不写', () => {
  const s = { label: '' };
  identity.applyLabel(s, '帮我看下路由');
  assert.equal(s.label, '帮我看下路由');
  identity.applyLabel(s, '别的对话内容');
  assert.equal(s.label, '帮我看下路由');
  const t = { label: '<session> hi </session>' };
  identity.applyLabel(t, '真正的问题');
  assert.equal(t.label, '真正的问题');
  identity.applyLabel(t, '');
  assert.equal(t.label, '真正的问题');
  assert.doesNotThrow(() => identity.applyLabel(null, 'x'));
});

// ---------------------------------------------------------------- 路由解析
const stubResolver = (over = {}) => {
  const store = {
    claude: over.claude || [{ id: 'pc1', name: 'C1' }, { id: 'pc2', name: 'C2' }],
    codex: over.codex || [{ id: 'px1', name: 'X1', model: 'xm' }],
  };
  const findProvider = id => store.claude.find(p => p.id === id) || store.codex.find(p => p.id === id) || null;
  const providerApp = id => store.claude.some(p => p.id === id) ? 'claude' : (store.codex.some(p => p.id === id) ? 'codex' : null);
  const routesRef = { current: over.routes || { rules: [], default: {} } };
  const resolveRoute = createResolver({
    getRoutes: () => routesRef.current,
    storeOf: app => (app === 'codex' ? store.codex : store.claude),
    resolveSlot: over.resolveSlot || (() => null),
    findProvider, providerApp,
  });
  return { resolveRoute, routesRef, findProvider };
};

test('resolveRoute:内容分流 > 槽位别名 > 普通规则 > 兜底', () => {
  const { resolveRoute } = stubResolver({
    routes: {
      rules: [
        { id: 'plain', match: 'sonnet', provider: 'pc1', priority: 0, enabled: true, pool: [] },
        { id: 'content', match: '', provider: 'pc2', priority: -5, enabled: true, pool: [], when: { body: 'summarize' } },
      ],
      default: { provider: 'pc1', model: '', pool: [] },
    },
    resolveSlot: (app, modelIn) => (modelIn === 'mixr-haiku'
      ? { name: 'haiku', model: 'slotm', rule: { id: 'slot:claude/haiku', provider: 'pc2', model: 'slotm', pool: [], enabled: true } }
      : null),
  });
  const ctx = { bodyText: () => 'please summarize' };
  // 内容分流规则 priority 更低也先评估,并且不限模型
  assert.equal(resolveRoute('sonnet', ctx).rule.id, 'content');
  assert.equal(resolveRoute('sonnet', ctx).content, true);
  // 内容不匹配时,槽位别名压过普通规则的子串匹配
  assert.equal(resolveRoute('mixr-haiku', {}).slot, 'haiku');
  assert.equal(resolveRoute('mixr-haiku', {}).model, 'slotm');
  // 普通规则
  assert.equal(resolveRoute('claude-sonnet-4', {}).rule.id, 'plain');
  // 兜底:rule 为 null,沿用请求模型
  const dft = resolveRoute('unknown-model', {});
  assert.equal(dft.rule, null);
  assert.equal(dft.provider.id, 'pc1');
  assert.equal(dft.model, 'unknown-model');
});

test('resolveRoute:高 priority 先匹配;同 priority 按数组顺序;禁用规则跳过', () => {
  const { resolveRoute } = stubResolver({
    routes: {
      rules: [
        { id: 'first', match: 'opus', provider: 'pc1', priority: 0, enabled: true, pool: [] },
        { id: 'second', match: 'opus', provider: 'pc2', priority: 0, enabled: true, pool: [] },
        { id: 'top', match: 'opus', provider: 'pc2', priority: 9, enabled: false, pool: [] },
      ],
      default: {},
    },
  });
  assert.equal(resolveRoute('opus', {}).rule.id, 'first');
  assert.equal(resolveRoute('OPUS', {}).rule.id, 'first', '模型名大小写不敏感');
  assert.equal(resolveRoute('my-opus-x', {}).rule.id, 'first', '子串匹配');
});

test('resolveRoute:不改动调用者的 routes/ctx 对象,也不改请求上下文', () => {
  const routes = {
    rules: [
      { id: 'lo', match: 'a', provider: 'pc1', priority: 0, enabled: true, pool: [] },
      { id: 'hi', match: 'a', provider: 'pc2', priority: 3, enabled: true, pool: [] },
    ],
    default: { provider: 'pc1', pool: [] },
  };
  const { resolveRoute } = stubResolver({ routes });
  const ctx = { ua: 'curl/8', bodyText: () => 'x' };
  const ctxSnapshot = JSON.stringify(ctx);
  resolveRoute('a', ctx);
  assert.deepEqual(routes.rules.map(r => r.id), ['lo', 'hi'], '排序必须是视图,不能就地打乱规则数组');
  assert.equal(JSON.stringify(ctx), ctxSnapshot);
});

test('resolveRoute:畸形 modelIn / 空路由表 / 幽灵引用都不抛', () => {
  const { resolveRoute } = stubResolver({ routes: { rules: [], default: { provider: 'pc2', pool: [] } } });
  for (const m of [null, undefined, 0, {}, [], 'x'.repeat(5000)]) {
    assert.doesNotThrow(() => resolveRoute(m, {}));
  }
  const empty = stubResolver({ routes: {} });
  assert.equal(empty.resolveRoute('x', {}).rule, null);
  assert.deepEqual(empty.resolveRoute('x', {}).members, []);

  const ghost = stubResolver({ routes: { rules: [{ id: 'g', match: 'x', provider: 'gone', enabled: true, pool: [] }], default: {} } });
  const r = ghost.resolveRoute('x', {});
  assert.deepEqual(r.ghosts, [{ where: '单一目标', id: 'gone' }]);
  assert.equal(r.provider, null);
});

// ---------------------------------------------------------------- 与主模块的接线
// 统一的隔离 fixture:所有会被 require 时读取的路径都指到临时目录,测试结束 t.after 清理并还原 env。
// 少设一个(比如只设 MIXR_DATA_DIR)就可能让 require 去读真实客户端配置。
const ISOLATED_ENV = {
  MIXR_DATA_DIR: 'data',
  MIXR_CLAUDE_SETTINGS: 'claude/settings.json',
  MIXR_CODEX_CONFIG: 'codex/config.toml',
  MIXR_ZCODE_CONFIG: 'zcode/v2/config.json',
};
function fixture(t) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-mod-'));
  const saved = {};
  for (const [k, rel] of Object.entries(ISOLATED_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = path.join(TMP, rel);
  }
  saved.MIXROUTER_PORT = process.env.MIXROUTER_PORT;
  saved.MIXUI_PORT = process.env.MIXUI_PORT;
  process.env.MIXROUTER_PORT = '0';
  process.env.MIXUI_PORT = '0';
  t.after(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });
  return { TMP, env: { ...ISOLATED_ENV } };
}

test('模块间不再重复定义:主文件里的公开接口与拆分模块是同一批函数', t => {
  fixture(t);
  const mod = require(path.join(ROOT, 'mixrouter.js'));
  // 这些名字是既有测试与运行时共用的;断言它们仍由同一实现提供(不是各自抄了一份)
  assert.equal(mod.matchWhen, rulesLib.matchWhen);
  assert.equal(mod.normalizeRule({ match: 'x' }).match, 'x');
  assert.equal(mod.strategyOf, strategyLib.strategyOf);
  assert.equal(mod.safeHeader('a'), 'a');
  assert.equal(mod.validBaseUrl('https://a.example'), true);
  assert.equal(mod.wireOf({}, 'claude'), 'anthropic');
  assert.equal(mod.joinUpstreamPath('https://a.example/v1', '/v1/messages'), 'https://a.example/v1/messages');
  assert.equal(mod.sessionIdentity({ headers: {} }, {}, 'claude').kind, 'anon');
  assert.equal(typeof mod.resolveRoute, 'function');
  assert.equal(typeof mod._state.sessions, 'object');
  assert.equal(mod._state.sessions instanceof Map, true);
  // 路由层不再反向依赖客户端配置模块
  assert.equal(require(path.join(ROOT, 'lib/routing/rules.js')).normalizeRule({ match: 'y' }).match, 'y');
});

// 槽位这一批的"同一实现"断言。写法与上面那条不同,这里说明为什么:
//   - CLAUDE_SLOTS / CLAUDE_SLOT_ENV / CLAUDE_SLOT_KEYS / slotAlias / normalizeChannelSlots
//     在主文件里是**解构赋值**(= slotsLib.X),所以对象同一性成立,可以直接 assert.equal。
//   - resolveSlot / slotsPublic / claudeSplitPatch / validateSlotPut 在主文件里是**注入 slotMap 的
//     薄包装**(模块签名多了首参 slotMap),包装本身必然是另一个函数对象 —— 对它们做 assert.equal(mod.X,
//     slotsLib.X) 是恒假的,写上去只会红。这类要靠"哨兵注入"证明没有第二份实现:
//     把模块产出的 createSlotTable 换成返回哨兵的版本,重新 require 主文件;主文件若真从模块取实现,
//     它的槽位接口就必须吐哨兵;若本地又长回一份实现,则原样返回真结果,断言立刻红。
test('槽位接口与 lib/routing/slots.js 是同一实现:常量同一 + 哨兵注入穿透', t => {
  fixture(t);
  const mod = require(path.join(ROOT, 'mixrouter.js'));

  // (1) 解构型:直接对象同一性
  for (const k of ['CLAUDE_SLOTS', 'CLAUDE_SLOT_ENV', 'CLAUDE_SLOT_KEYS', 'slotAlias', 'normalizeChannelSlots']) {
    assert.equal(mod[k], slotsLib[k], `${k} 必须就是 slots 模块导出的那个对象/函数`);
  }
  // 内容也钉住:防"另写一份同值常量"绕过同一性(同值不同引用会同时被上面和这里挡住)
  assert.deepEqual(mod.CLAUDE_SLOTS, ['main', 'opus', 'sonnet', 'haiku', 'subagent']);
  assert.deepEqual(mod.CLAUDE_SLOT_KEYS, ['opus', 'sonnet', 'haiku', 'subagent']);
  assert.deepEqual(Object.keys(mod.CLAUDE_SLOT_ENV).sort(), [...mod.CLAUDE_SLOTS].sort());

  // (2) 包装型:哨兵注入。主文件 require 时才会调用 createSlotTable,
  //     所以必须在 require 之前把导出换掉,并清掉主文件自己的 require 缓存。
  const SENTINEL = 'slots-sentinel-4f2a';
  const origCreate = slotsLib.createSlotTable;
  let ctorCalls = 0;
  try {
    slotsLib.createSlotTable = () => {
      ctorCalls++;
      return {
        resolveSlot: () => SENTINEL,
        slotsPublic: () => SENTINEL,
        claudeSplitPatch: () => SENTINEL,
        validateSlotPut: () => SENTINEL,
      };
    };
    delete require.cache[require.resolve(path.join(ROOT, 'mixrouter.js'))];
    const wired = require(path.join(ROOT, 'mixrouter.js'));

    assert.equal(ctorCalls, 1, '主文件应当且只应当用模块的 createSlotTable 建一次槽位表');
    assert.equal(wired.resolveSlot('claude', 'mixr-main'), SENTINEL, 'resolveSlot 没走模块实现');
    assert.equal(wired.slotsPublic(), SENTINEL, 'slotsPublic 没走模块实现');
    assert.equal(wired.claudeSplitPatch({}), SENTINEL, 'claudeSplitPatch 没走模块实现');
    assert.equal(wired.validateSlotPut({}), SENTINEL, 'validateSlotPut 没走模块实现');

    // 反证上面四条不是"压根没人调用":同样这批名字在真实现下必须吐真值(非哨兵)
    assert.notEqual(SENTINEL, wired.CLAUDE_SLOTS);
    assert.equal(Array.isArray(wired.CLAUDE_SLOTS), true, '反证失败:常量本该是真数组');
  } finally {
    slotsLib.createSlotTable = origCreate;
    delete require.cache[require.resolve(path.join(ROOT, 'mixrouter.js'))];
    require(path.join(ROOT, 'mixrouter.js')); // 还原成真实现的缓存,不给后面的用例留脏状态
  }
});

test('require 主模块不会自启服务:进程立即退出且不写 stdout', t => {
  const { TMP } = fixture(t);
  // 子进程拿到的是完整隔离 env,不是继承本进程的半套配置
  const env = { ...process.env, ...ISOLATED_ENV };
  for (const [k, rel] of Object.entries(ISOLATED_ENV)) env[k] = path.join(TMP, rel);
  env.MIXROUTER_PORT = '0';
  env.MIXUI_PORT = '0';
  const r = spawnSync(process.execPath, ['-e', 'require("./mixrouter.js"); console.log("ok")'],
    { cwd: ROOT, encoding: 'utf8', timeout: 20000, env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'ok');
  assert.equal(r.signal, null, '不得挂住(挂住说明 require 时起了服务)');
});

// ---------------------------------------------------------------- 会话落盘的三个失败面
// 这三条都是**库层**的行为,所以在这里用 stub 的 saveJson 直接验,不走 HTTP。
// 起因:并发跑全集时 audit-fixes 因为 `sessions.json...tmp` 的 EACCES 炸过一次
// (那个 EACCES 是**测试夹具自己**造的,不是产品缺陷),但顺着查下去发现落盘这条路上
// 有三个真的缺陷 —— 下面每条钉一个。

test('落盘失败后这份改动必须还能重试(dirty 不许在写成功之前被清)', () => {
  // 以前是 `dirty = false; saveJson(...)`:写失败时这份改动已经被记成"落过盘"了。
  // 后果不是"这次没写进去",而是"**以后也不会再写**"——内存里那份改动还在,
  // 于是控制台看着改了、重启就变回去,而且没有任何提示。
  let fail = true;
  const writes = [];
  const { store } = mkStore({
    deps: {
      saveJson: (f, d) => {
        writes.push(fail ? 'FAIL' : 'OK');
        if (fail) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    },
  });
  store.sessions.set('a', { app: 'claude', lastUsed: 1 });
  store.saveSoon();
  // 直接调 flush 模拟"下一次落盘"(去抖那次是异步的,这里要的是同一个判据)
  assert.throws(() => store.flush(), /EACCES/, '第一次落盘该抛出去');
  assert.deepEqual(writes, ['FAIL'], '夹具:第一次必须真的试过写');
  fail = false;
  store.flush();
  assert.deepEqual(writes, ['FAIL', 'OK'], '写失败过的那份改动必须还会被重试');
});

test('去抖落盘失败不许抛成 uncaughtException:走 onSaveError,且进程继续', async () => {
  // saveSoon 的定时器回调没人接得住它抛的错。实测(探针让原子替换抛 EACCES):
  // 异常从 Timeout._onTimeout 冒到顶层 —— 常驻进程里这是个 uncaughtException,
  // 而这次改动还永远不会落盘(见上一条),两件事叠在一起最难查。
  const seen = [];
  const { store } = mkStore({
    deps: {
      saveJson: () => { throw Object.assign(new Error('磁盘满了'), { code: 'ENOSPC' }); },
      onSaveError: e => seen.push(e.message),
    },
  });
  store.sessions.set('a', { app: 'claude', lastUsed: 1 });
  store.saveSoon();
  await new Promise(ok => setTimeout(ok, 1300));   // 过掉 1s 去抖窗口
  assert.deepEqual(seen, ['磁盘满了'], '失败要如实报给 onSaveError,而不是抛出去');
});

test('flush(force):内存刚被改过时,不靠 dirty 标记也必须真写一次', () => {
  // 控制台的会话三扇门(清空/钉定/解绑)是**直接改内存**再落盘的,没有经过 saveSoon,
  // 所以 dirty 还是 false。以前 flush 只看 dirty,于是它直接早退:
  // 接口回 200「已清空」、内存空了、盘上一条不少。
  // 实测(探针让原子替换抛 EACCES 之前的那次正常路径):`DELETE /api/sessions`
  // → 200 `{"ok":true,"cleared":true}`,内存 2→0,盘上仍是 2 条。
  const saved = [];
  const { store } = mkStore({ deps: { saveJson: (f, d) => saved.push(d) } });
  store.sessions.set('a', { app: 'claude', lastUsed: 1 });
  store.flush();
  assert.equal(saved.length, 0, '夹具:没改过也没 saveSoon 过,普通 flush 就该是空操作');
  store.flush(true);
  assert.equal(saved.length, 1, 'force 必须绕过 dirty,真写一次');
  assert.ok(saved[0].bindings.a, '写进去的必须是内存里现在这份');
});
