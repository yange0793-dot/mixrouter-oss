'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createKeyFallback } = require('../lib/routing/key-fallback');

// 计时器全部注入:测试推进假时钟,不 sleep、不依赖真实时间。
function fixture(options = {}) {
  let clock = 1_000_000;
  const fb = createKeyFallback({ now: () => clock, cooldownMs: 60000, maxEntries: 1000, ...options });
  return { fb, advance: ms => { clock += ms; }, at: () => clock };
}

const provider = (over = {}) => ({
  id: 'p1', name: 'provider-1', enabled: true, key_fallback: true,
  active_key: 'k1', api_key: 'secret-1',
  keys: [
    { id: 'k1', label: '账号1', key: 'secret-1' },
    { id: 'k2', label: '账号2', key: 'secret-2' },
    { id: 'k3', label: '账号3', key: 'secret-3' },
  ],
  ...over,
});
const choice = (p = provider()) => ({
  provider: p, key_id: p.active_key, key_source: 'provider_active', pinned: false,
});
const keyIds = p => p.keys.map(k => k.id);

test('默认关闭:所有入口原样返回,不记录状态', () => {
  const { fb } = fixture();
  for (const off of [undefined, false, 0, 'true']) {
    const p = provider({ key_fallback: off });
    const c = choice(p);
    assert.equal(fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' }), c);
    assert.deepEqual(fb.failure({ provider: p, key_id: 'k1', model: 'm', status: 401 }),
      { switchable: false, scope: 'none', wait_ms: 0 });
    assert.deepEqual(fb.success({ provider: p, key_id: 'k1', model: 'm', sessionKey: 's1' }), { restored: false });
    assert.deepEqual(fb.list(), []);
  }
  // 没有 keyChoice 时也不抛
  assert.equal(fb.select({ provider: provider() }), undefined);
  assert.equal(fb.select({}), undefined);
});

test('单 Key 渠道:不换号,冷却期如实报告等待时间', () => {
  const { fb, advance } = fixture();
  const p = provider({ keys: [{ id: 'k1', key: 'secret-1' }] });
  const c = choice(p);
  assert.equal(fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' }), c);
  const out = fb.failure({ provider: p, key_id: 'k1', model: 'm', status: 401 });
  assert.deepEqual(out, { switchable: false, scope: 'account', wait_ms: 60000 });
  const cooling = fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' });
  assert.equal(cooling.key_id, 'k1');
  assert.equal(cooling.fallback.reason, 'all_cooling');
  assert.equal(cooling.fallback.wait_ms, 60000);
  assert.deepEqual(fb.list().map(r => [r.key_id, r.state, r.scope]), [['k1', 'cooling', 'account']]);
  advance(60000);
  assert.equal(fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' }), c);
});

test('401 凭据错误:账号级冷却,下一次尝试换到健康 Key,不改 active_key', () => {
  const { fb } = fixture();
  const p = provider();
  const before = structuredClone(p);
  const c = choice(p);
  const first = fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' });
  assert.equal(first, c, '健康时返回同一个对象,行为不变');

  const out = fb.failure({ provider: p, key_id: 'k1', model: 'm', status: 401 });
  assert.deepEqual(out, { switchable: true, scope: 'account', wait_ms: 0 });

  const next = fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' });
  assert.equal(next.key_id, 'k2');
  assert.equal(next.key_source, 'key_fallback');
  assert.equal(next.pinned, false);
  assert.equal(next.provider.api_key, 'secret-2');
  assert.equal(next.fallback.reason, 'fallback');
  assert.equal(next.provider.active_key, 'k1', '只换这一发的副本,不改渠道生效 Key');
  assert.deepEqual(p, before, '渠道对象不得被修改');

  const row = fb.list().find(r => r.key_id === 'k1');
  assert.equal(row.scope, 'account');
  assert.equal(row.state, 'cooling');
  assert.equal(row.status, 401);
  assert.ok(!JSON.stringify(fb.list()).includes('secret-'));
});

test('402 额度耗尽:同样账号级;全 Key 冷却时给出最早可用时间', () => {
  const { fb } = fixture();
  const p = provider();
  const c = choice(p);
  fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' });
  fb.failure({ provider: p, key_id: 'k1', model: 'm', status: 402 });
  const switched = fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' });
  assert.equal(switched.key_id, 'k2');
  const out = fb.failure({ provider: p, key_id: 'k2', model: 'm', status: 402 });
  assert.equal(out.scope, 'account');
  assert.equal(out.switchable, true, 'k3 仍健康');
  fb.failure({ provider: p, key_id: 'k3', model: 'm', status: 402 });
  const last = fb.failure({ provider: p, key_id: 'k3', model: 'm', status: 402 });
  assert.equal(last.switchable, false);
  assert.equal(last.wait_ms, 60000);
  const all = fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' });
  assert.equal(all.fallback.reason, 'all_cooling');
  assert.ok(all.fallback.wait_ms > 0 && all.fallback.wait_ms <= 60000);
});

test('403/404 只做模型级冷却:同账号换模型仍可用,不能断言账号全坏', () => {
  const { fb } = fixture();
  const p = provider();
  const c = choice(p);
  fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'model-a' });
  for (const status of [403, 404]) {
    const { fb: local, } = fixture();
    local.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'model-a' });
    const out = local.failure({ provider: p, key_id: 'k1', model: 'model-a', status });
    assert.equal(out.scope, 'model');
    assert.equal(out.switchable, true);
    assert.equal(local.list()[0].scope, 'model');
    assert.equal(local.list()[0].model, 'model-a');
    // 另一个模型:粘性账号没有该模型的失败记录,继续用它
    assert.equal(local.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'model-b' }), c);
    // 同模型:换到 k2
    assert.equal(local.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'model-a' }).key_id, 'k2');
  }
});

test('429 使用 Retry-After 并按模型级记账,总预算由调度层决定', () => {
  const { fb, advance } = fixture();
  const p = provider({ keys: [{ id: 'k1', key: 'secret-1' }, { id: 'k2', key: 'secret-2' }] });
  const c = choice(p);
  fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' });
  assert.deepEqual(fb.failure({ provider: p, key_id: 'k1', model: 'm', status: 429, retryAfterMs: 5000 }),
    { switchable: true, scope: 'model', wait_ms: 0 });
  assert.equal(fb.list()[0].until, 1_000_000 + 5000);
  const switched = fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' });
  assert.equal(switched.key_id, 'k2');
  assert.equal(fb.failure({ provider: p, key_id: 'k2', model: 'm', status: 429, retryAfterMs: 3000 }).wait_ms, 3000);
  advance(3000);
  assert.equal(fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' }).key_id, 'k2');

  // Retry-After 缺失/非法时退回统一冷却窗口
  const { fb: noHeader } = fixture();
  noHeader.failure({ provider: p, key_id: 'k1', model: 'm', status: 429, retryAfterMs: 'nope' });
  assert.equal(noHeader.list()[0].until, 1_000_000 + 60000);
});

test('网络错误与 5xx 不轮换 Key、不误伤账号', () => {
  const { fb } = fixture();
  const p = provider();
  const c = choice(p);
  fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' });
  for (const status of [0, undefined, 500, 502, 503, 504, 400, 408, 422]) {
    assert.deepEqual(fb.failure({ provider: p, key_id: 'k1', model: 'm', status }),
      { switchable: false, scope: 'none', wait_ms: 0 });
  }
  assert.deepEqual(fb.list(), []);
  assert.equal(fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' }), c);
});

test('成功后恢复健康(含模型级记录),粘性随成功的那把前移', () => {
  const { fb } = fixture();
  const p = provider();
  const c = choice(p);
  fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' });
  fb.failure({ provider: p, key_id: 'k1', model: 'm', status: 403 });
  assert.equal(fb.list().length, 1);
  assert.deepEqual(fb.success({ provider: p, key_id: 'k1', model: 'm', sessionKey: 's1' }), { restored: true });
  assert.deepEqual(fb.list(), []);
  assert.equal(fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' }), c);

  // 换号成功:后续请求继续用新账号,而不是每次再从 active_key 重新挑
  fb.failure({ provider: p, key_id: 'k1', model: 'm', status: 401 });
  const second = fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' });
  assert.equal(second.key_id, 'k2');
  fb.success({ provider: p, key_id: 'k2', model: 'm', sessionKey: 's1' });
  const sticky = fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' });
  assert.equal(sticky.key_id, 'k2');
  assert.equal(sticky.fallback.reason, 'sticky');
});

test('固定 Key(pinned)与压缩专用 Key 永远不换', () => {
  const { fb } = fixture();
  const p = provider();
  fb.failure({ provider: p, key_id: 'k1', model: 'm', status: 401 });
  const c = choice(p);
  const pinnedChoice = { ...c, pinned: true, key_source: 'session_slot' };
  assert.equal(fb.select({ provider: p, keyChoice: pinnedChoice, sessionKey: 's1', model: 'm' }), pinnedChoice);
  assert.equal(fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm', pinned: true }), c);
  const compact = { ...c, key_source: 'compact' };
  assert.equal(fb.select({ provider: p, keyChoice: compact, sessionKey: 's1', model: 'm' }), compact);
  assert.deepEqual(fb.failure({ provider: p, key_id: 'k1', model: 'm', status: 401, pinned: true }),
    { switchable: false, scope: 'none', wait_ms: 0 });
  // 粘性也没被建立
  assert.equal(fb.select({ provider: p, keyChoice: c, sessionKey: 'fresh', model: 'm' }).key_id, 'k2');
});

test('会话粘性按 provider+session 隔离,不同会话互不影响', () => {
  const { fb } = fixture();
  const p = provider();
  const c = choice(p);
  assert.equal(fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' }), c);
  assert.equal(fb.select({ provider: p, keyChoice: c, sessionKey: 's2', model: 'm' }), c);
  fb.failure({ provider: p, key_id: 'k1', model: 'm', status: 401 });
  assert.equal(fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' }).key_id, 'k2');
  assert.equal(fb.select({ provider: p, keyChoice: c, sessionKey: 's2', model: 'm' }).key_id, 'k2');
  fb.success({ provider: p, key_id: 'k2', model: 'm', sessionKey: 's1' });
  assert.equal(fb.select({ provider: p, keyChoice: c, sessionKey: 's1', model: 'm' }).key_id, 'k2');
  // s2 没成功过,k1 冷却结束后回到自己的 active Key
  const { fb: other } = fixture();
  other.select({ provider: p, keyChoice: c, sessionKey: 's2', model: 'm' });
  assert.equal(other.select({ provider: p, keyChoice: c, sessionKey: 's2', model: 'm' }), c);
});

test('粘性 Key 被删除/停用:明确报错,不静默改号', () => {
  const { fb } = fixture();
  const c = choice(provider());
  const p1 = provider();
  fb.select({ provider: p1, keyChoice: c, sessionKey: 's1', model: 'm' });
  const removed = provider({ keys: [{ id: 'k2', key: 'secret-2' }] });
  assert.throws(() => fb.select({ provider: removed, keyChoice: { ...c, provider: removed }, sessionKey: 's1', model: 'm' }),
    e => e.statusCode === 503 && e.code === 'provider_key_unavailable_error' && e.key_id === 'k1'
      && !JSON.stringify(e.message).includes('secret-'));
  const disabled = provider({ keys: p1.keys.map(k => k.id === 'k1' ? { ...k, enabled: false } : k) });
  assert.throws(() => fb.select({ provider: disabled, keyChoice: { ...c, provider: disabled }, sessionKey: 's1', model: 'm' }),
    e => e.statusCode === 503 && e.code === 'provider_key_unavailable_error');
});

test('禁用 Key 与重复 id 不进入候选', () => {
  const { fb } = fixture();
  const p = provider({ keys: [
    { id: 'k1', key: 'secret-1' },
    { id: 'k2', key: 'secret-2', enabled: false },
    { id: 'k3', key: 'secret-3' },
  ] });
  const c = choice(p);
  fb.failure({ provider: p, key_id: 'k1', model: 'm', status: 401 });
  assert.equal(fb.select({ provider: p, keyChoice: c, model: 'm' }).key_id, 'k3');

  const dup = provider({ keys: [
    { id: 'k1', key: 'secret-1' }, { id: 'k1', key: 'secret-1b' }, { id: 'k2', key: 'secret-2' },
  ] });
  const dupChoice = { provider: dup, key_id: 'k1', key_source: 'provider_active', pinned: false };
  // k1 重复 → 不可点名,直接落到唯一明确的 k2
  assert.equal(fb.select({ provider: dup, keyChoice: dupChoice, model: 'm' }).key_id, 'k2');
  assert.deepEqual(fb.failure({ provider: dup, key_id: 'k1', model: 'm', status: 401 }).scope, 'account');
});

test('状态有界:maxEntries 同时约束失败记录与粘性记录', () => {
  const { fb } = fixture({ maxEntries: 3 });
  for (let i = 0; i < 10; i++) {
    const p = provider({ id: 'p' + i });
    fb.select({ provider: p, keyChoice: choice(p), sessionKey: 's' + i, model: 'm' });
    fb.failure({ provider: p, key_id: 'k1', model: 'm', status: 401 });
  }
  assert.ok(fb.list().length <= 3);

  // 容量被粘性占满后,最老的会话粘性被淘汰:账号消失也不再视为"粘性键被删",
  // 而是按新清单重新选 —— 证明淘汰真的发生,而不是无限增长。
  const fresh = createKeyFallback({ now: () => 1_000_000, cooldownMs: 60000, maxEntries: 3 });
  const ps = [0, 1, 2, 3].map(i => provider({ id: 'sp' + i }));
  for (const [i, p] of ps.entries())
    fresh.select({ provider: p, keyChoice: choice(p), sessionKey: 's' + i, model: 'm' });
  const p0 = provider({ id: 'sp0', keys: [{ id: 'k2', key: 'secret-2' }] });
  const rebound = fresh.select({ provider: p0, keyChoice: choice(p0), sessionKey: 's0', model: 'm' });
  assert.equal(rebound.key_id, 'k2');
});

test('粘性按完整会话键区分:前 N 字符相同的两个会话绝不互相继承', () => {
  const { fb } = fixture();
  const p = provider();
  const c = choice(p);
  // 长前缀完全相同、只有结尾不同 —— 截断实现会让它们撞成同一条粘性记录。
  const prefix = 'cc:' + 'a'.repeat(300);
  const a = prefix + '-session-a';
  const b = prefix + '-session-b';

  fb.select({ provider: p, keyChoice: c, sessionKey: a, model: 'm' });
  fb.failure({ provider: p, key_id: 'k1', model: 'm', status: 401 });
  const switched = fb.select({ provider: p, keyChoice: c, sessionKey: a, model: 'm' });
  assert.equal(switched.key_id, 'k2');
  fb.success({ provider: p, key_id: 'k2', model: 'm', sessionKey: a });

  // B 会话从未换过号:它不得继承 A 的粘性账号。截断实现下 B 会读到 A 的粘性并
  // 报 reason:'sticky';正确实现下它是自己挑的(reason:'fallback')。
  const bChoice = fb.select({ provider: p, keyChoice: c, sessionKey: b, model: 'm' });
  assert.notEqual(bChoice.fallback && bChoice.fallback.reason, 'sticky');
  assert.equal(bChoice.fallback && bChoice.fallback.reason, 'fallback');
});

test('渠道之间状态隔离,渠道停用时不换 Key', () => {
  const { fb } = fixture();
  const p1 = provider({ id: 'p1' });
  const p2 = provider({ id: 'p2' });
  fb.failure({ provider: p1, key_id: 'k1', model: 'm', status: 401 });
  assert.deepEqual(fb.list({ provider: 'p2' }), []);
  const c2 = choice(p2);
  assert.equal(fb.select({ provider: p2, keyChoice: c2, model: 'm' }), c2);
  const off = provider({ enabled: false });
  const cOff = choice(off);
  assert.equal(fb.select({ provider: off, keyChoice: cOff, model: 'm' }), cOff);
  assert.equal(fb.failure({ provider: off, key_id: 'k1', model: 'm', status: 401 }).switchable, false);
});

test('reset 清空内存状态,不返回任何 Key 正文', () => {
  const { fb } = fixture();
  const p = provider();
  fb.failure({ provider: p, key_id: 'k1', model: 'm', status: 401 });
  assert.equal(fb.list().length, 1);
  fb.reset();
  assert.deepEqual(fb.list(), []);
  fb.failure({ provider: p, key_id: 'k1', model: 'm', status: 401 });
  const text = JSON.stringify(fb.list());
  assert.ok(!text.includes('secret-'));
  assert.deepEqual(Object.keys(fb.list()[0]).sort(),
    ['failures', 'key_id', 'model', 'provider', 'scope', 'state', 'status', 'until', 'updated_at'].sort());
});
