'use strict';
// <渠道前缀>/<模型> 显式命名空间:前缀只认 id(精确)、slug(大小写不敏感)、
// 归一化显示名(小写、去空格/连字符/下划线),且只在当前 app 组的可用渠道里找。
// **判定顺序**:精确已登记模型在前,前缀层是回退 —— 中转登记的字面模型名可能自带斜杠
// (如 moonshotai/kimi-k3),必须先按精确登记命中;只有精确阶段零命中才解释成前缀。
// 前缀命中唯一渠道后,该渠道还得真的登记了这个模型;任何一步对不上都明确报错,
// 不做子串/模糊匹配。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { createResolver } = require(path.join(ROOT, 'lib/routing/resolve.js'));

const P = (id, models, extra = {}) => ({
  id, name: id, api_key: 'sk-' + id, enabled: true, ...(models ? { models } : {}), ...extra,
});

const stubResolver = (over = {}, options = {}) => {
  const store = {
    claude: over.claude || [],
    codex: over.codex || [],
  };
  const findProvider = id => store.claude.find(p => p.id === id) || store.codex.find(p => p.id === id) || null;
  const resolveRoute = createResolver({
    getRoutes: () => ({ rules: [] }),
    storeOf: app => (app === 'codex' ? store.codex : store.claude),
    resolveSlot: () => null,
    findProvider,
    ...(options.trace ? { trace: options.trace } : {}),
  });
  return { resolveRoute, store };
};

// 真实故障里的两个名字:agentrouter/gpt-6.1-sol、happy-coding/deepseek-v4.1-flash
const CHANNELS = () => [
  P('ar', ['gpt-6.1-sol', 'gpt-6-astra'], { name: 'AgentRouter' }),
  P('zn', ['gpt-6.1-sol'], { name: '智纽' }),
  P('hc', ['deepseek-v4.1-flash'], { name: 'Happy coding' }),
];

test('前缀命中唯一渠道:返回既有 model 命中形状,rule 标明前缀命中', () => {
  const { resolveRoute } = stubResolver({ claude: CHANNELS() });
  const r = resolveRoute('agentrouter/gpt-6.1-sol', {});
  assert.equal(r.error, undefined);
  assert.equal(r.stage, 'model');
  assert.equal(r.rule.id, 'model:ar');
  assert.equal(r.rule.via, 'prefix', '日志里要能看出是前缀命中');
  assert.equal(r.rule.match, 'agentrouter/gpt-6.1-sol', '保留客户端请求的原始名');
  assert.equal(r.provider.id, 'ar');
  assert.equal(r.model, 'gpt-6.1-sol', '落点模型取渠道登记的原名');
  assert.deepEqual(r.members.map(m => m.provider.id), ['ar']);
  // 裸名仍然按原规则报 409 歧义 —— 前缀层不改变既有判定
  const bare = resolveRoute('gpt-6.1-sol', {});
  assert.equal(bare.error.type, 'model_ambiguous_error');
  assert.equal(bare.error.status, 409);
});

test('前缀归一化:大小写、空格、连字符、下划线都等价;slug 大小写不敏感;id 精确', () => {
  const { resolveRoute } = stubResolver({ claude: [
    ...CHANNELS(),
    P('sl', ['m-slug'], { name: '另一个渠道', slug: 'Fast-Relay' }),
    P('ID-X', ['m-id'], { name: '精确 id 渠道' }),
  ] });
  for (const prefix of ['happy-coding', 'HAPPY_CODING', 'Happy coding', 'happycoding', 'HAPPYCODING']) {
    const r = resolveRoute(prefix + '/DeepSeek-V4.1-Flash', {});
    assert.equal(r.provider.id, 'hc', prefix);
    assert.match(r.model, /deepseek-v4\.1-flash/i, prefix);
  }
  // slug:大小写不敏感,但保留原样书写
  assert.equal(resolveRoute('fast-relay/m-slug', {}).provider.id, 'sl');
  assert.equal(resolveRoute('FAST-RELAY/m-slug', {}).provider.id, 'sl');
  // id:精确匹配(这里只验证精确写法能命中)
  assert.equal(resolveRoute('ID-X/m-id', {}).provider.id, 'ID-X');
});

test('前缀不存在:503 no_route_error,文案不把用户引向"登记模型";也不做子串匹配', () => {
  const { resolveRoute } = stubResolver({ claude: CHANNELS() });
  for (const name of ['agentxyz/gpt-6.1-sol', 'agent/gpt-6.1-sol', 'agentrouter-extra/gpt-6.1-sol']) {
    const r = resolveRoute(name, {});
    assert.equal(r.stage, 'model', name);
    assert.equal(r.error.status, 503, name);
    assert.equal(r.error.type, 'no_route_error', name);
    assert.match(r.error.message, /不存在或不唯一/, name);
    assert.doesNotMatch(r.error.message, /没有渠道登记模型/, '别把前缀问题说成模型没登记');
    assert.doesNotMatch(r.error.message, /补上模型/, '别把前缀问题引向补登记模型');
    assert.deepEqual(r.candidates, [], name);
    assert.equal(r.provider, null, name);
  }
});

test('前缀命中渠道但该渠道没登记这个模型:503 点名渠道与缺失的模型', () => {
  const { resolveRoute } = stubResolver({ claude: CHANNELS() });
  const r = resolveRoute('agentrouter/deepseek-v4.1-flash', {});
  assert.equal(r.error.status, 503);
  assert.equal(r.error.type, 'no_route_error');
  assert.match(r.error.message, /渠道 "AgentRouter"/);
  assert.match(r.error.message, /没有登记模型 "deepseek-v4\.1-flash"/);
  assert.match(r.error.message, /gpt-6\.1-sol/, '列出该渠道已登记的模型,方便对照');
  assert.deepEqual(r.candidates, ['ar']);
});

test('多个渠道同名:明确失败不随便挑;candidates 列出全部候选', () => {
  const { resolveRoute } = stubResolver({ claude: [
    P('a1', ['x'], { name: 'AgentRouter' }),
    P('a2', ['x'], { name: 'AgentRouter' }),
    P('other', ['y'], { name: '别的' }),
  ] });
  const r = resolveRoute('agentrouter/x', {});
  assert.equal(r.provider, null);
  assert.equal(r.error.status, 503);
  assert.equal(r.error.type, 'no_route_error');
  assert.match(r.error.message, /不存在或不唯一/);
  assert.deepEqual(r.candidates, ['a1', 'a2']);
});

test('id 命中优先于显示名:别的渠道恰好叫这个 id 时按 id 解开', () => {
  const { resolveRoute } = stubResolver({ claude: [
    P('foo', ['m'], { name: '真正的 id 渠道' }),
    P('b', ['m'], { name: 'foo' }),
  ] });
  const r = resolveRoute('foo/m', {});
  assert.equal(r.error, undefined);
  assert.equal(r.provider.id, 'foo');
});

test('前缀层的 [1m] 后缀:请求与登记两侧都剥掉再比,大小写不敏感', () => {
  const { resolveRoute } = stubResolver({ claude: [
    P('camel', ['Claude-Opus-5[1M]'], { name: 'camel' }),
  ] });
  for (const name of ['camel/claude-opus-5', 'camel/CLAUDE-OPUS-5[1m]', 'CAMEL/Claude-Opus-5']) {
    const r = resolveRoute(name, {});
    assert.equal(r.error, undefined, name);
    assert.equal(r.provider.id, 'camel', name);
    assert.equal(r.model, 'Claude-Opus-5[1M]', '落点仍是渠道登记的原名');
  }
});

test('同名歧义可由会话钉定解开;钉到不匹配的渠道仍报不唯一', () => {
  const { resolveRoute } = stubResolver({ claude: [
    P('a1', ['x'], { name: 'AgentRouter' }),
    P('a2', ['x'], { name: 'AgentRouter' }),
  ] });
  const pinned = resolveRoute('agentrouter/x', { pin: 'a2' });
  assert.equal(pinned.error, undefined);
  assert.equal(pinned.provider.id, 'a2');
  assert.equal(pinned.rule.via, 'prefix');
  const elsewhere = resolveRoute('agentrouter/x', { pin: 'ghost' });
  assert.equal(elsewhere.error.type, 'no_route_error');
  assert.match(elsewhere.error.message, /不存在或不唯一/);
});

test('停用或没有可用 Key 的渠道不参与前缀匹配', () => {
  const { resolveRoute } = stubResolver({ claude: [
    P('off', ['x'], { name: 'AgentRouter', enabled: false }),
    P('nokey', ['x'], { name: 'AgentRouter', api_key: '' }),
    P('on', ['x'], { name: 'AgentRouter' }),
  ] });
  const r = resolveRoute('agentrouter/x', {});
  assert.equal(r.error, undefined);
  assert.equal(r.provider.id, 'on', '不可用渠道不能制造歧义');
  // 只剩不可用渠道时,前缀视同不存在
  const none = stubResolver({ claude: [P('off', ['x'], { name: 'AgentRouter', enabled: false })] });
  const miss = none.resolveRoute('agentrouter/x', {});
  assert.equal(miss.error.type, 'no_route_error');
  assert.match(miss.error.message, /不存在或不唯一/);
});

test('前缀只在本 app 组内找;trace 念出 prefix_hit', () => {
  const events = [];
  const { resolveRoute } = stubResolver({
    claude: [P('ca', ['m'], { name: 'AgentRouter' })],
    codex: [P('xa', ['m'], { name: 'AgentRouter' })],
  }, { trace: ev => events.push(ev) });
  assert.equal(resolveRoute('agentrouter/m', {}, 'claude').provider.id, 'ca');
  assert.equal(resolveRoute('agentrouter/m', {}, 'codex').provider.id, 'xa');
  const hitEvent = events.find(ev => ev.stage === 'model' && ev.outcome === 'hit');
  assert.equal(hitEvent.reason, 'prefix_hit');
  assert.equal(hitEvent.detail.prefix, 'agentrouter');
  assert.equal(hitEvent.detail.match, 'agentrouter/m');
});

test('带斜杠的字面模型名先按精确登记命中,不被前缀层抢先解释', () => {
  const { resolveRoute } = stubResolver({ claude: [
    P('lit', ['moonshotai/kimi-k3'], { name: '字面名渠道' }),
    // 这条渠道恰好能当 "moonshotai" 前缀且登记了 kimi-k3:若前缀层抢先就会错落到它
    P('moonshot', ['kimi-k3'], { name: 'moonshotai' }),
  ] });
  const r = resolveRoute('moonshotai/kimi-k3', {});
  assert.equal(r.error, undefined);
  assert.equal(r.rule.id, 'model:lit');
  assert.equal(r.rule.via, undefined, '精确命中不带前缀标记');
  assert.equal(r.provider.id, 'lit');
  assert.equal(r.model, 'moonshotai/kimi-k3', '落点模型就是登记的字面名');
});

test('字面模型名被多个渠道登记时仍是 409,不被前缀回退救成唯一命中或 503', () => {
  const { resolveRoute } = stubResolver({ claude: [
    P('l1', ['moonshotai/kimi-k3'], { name: '字面一' }),
    P('l2', ['moonshotai/kimi-k3'], { name: '字面二' }),
    P('moonshot', ['kimi-k3'], { name: 'moonshotai' }),
  ] });
  const r = resolveRoute('moonshotai/kimi-k3', {});
  assert.equal(r.error.type, 'model_ambiguous_error');
  assert.equal(r.error.status, 409);
  assert.deepEqual(r.candidates, ['l1', 'l2']);
  // 歧义仍按既有 pin 语义解开,不会退到前缀层
  const pinned = resolveRoute('moonshotai/kimi-k3', { pin: 'l2' });
  assert.equal(pinned.error, undefined);
  assert.equal(pinned.provider.id, 'l2');
  assert.equal(pinned.rule.via, undefined);
});

test('不带斜杠的模型名不受前缀层影响(既有语义保持)', () => {
  const { resolveRoute } = stubResolver({ claude: [P('p1', ['plain-model'])] });
  const ok = resolveRoute('plain-model', {});
  assert.equal(ok.provider.id, 'p1');
  assert.equal(ok.rule.via, undefined, '裸名命中不带前缀标记');
  const miss = resolveRoute('nope-model', {});
  assert.equal(miss.error.type, 'no_route_error');
  assert.match(miss.error.message, /没有渠道登记模型/);
});
