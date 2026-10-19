'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRouting, routingOf, routingRevision, hasRouting, resolveSessionSlot, selectSessionKey } = require('../lib/routing/session-config');
const { createSessionStore } = require('../lib/routing/sessions');

const providers = () => [
  { id: 'pa', api_key: 'secret-a', active_key: 'ka', models: ['model-a'], keys: [
    { id: 'ka', key: 'secret-a' }, { id: 'kb', key: 'secret-b' },
  ] },
  { id: 'pb', api_key: 'secret-c', models: ['model-b'] },
];
const routing = () => ({ keys: { pa: 'kb' }, slots: { opus: { provider: 'pa', model: 'other-model', key_id: 'ka' } } });
const bad = fn => assert.throws(fn, e => e.statusCode === 400);

test('规范化只保留引用、独立副本、稳定版本，旧会话为空', () => {
  const input = routing(), ps = providers(), before = structuredClone(ps);
  const result = normalizeRouting(input, 'claude', ps);
  assert.deepEqual(result, input);
  result.slots.opus.model = 'changed';
  assert.equal(input.slots.opus.model, 'other-model');
  assert.deepEqual(ps, before);
  assert.deepEqual(routingOf({}), { keys: {}, slots: {} });
  assert.equal(routingRevision(), routingRevision({ slots: {}, keys: {} }));
  assert.equal(routingRevision(input), routingRevision({ slots: input.slots, keys: input.keys }));
  assert.notEqual(routingRevision(input), routingRevision(result));
  assert.ok(!JSON.stringify(result).includes('secret-'));
});

test('写入强校验形状、组别、引用、未知字段和危险对象键', () => {
  const ps = providers();
  for (const value of [null, [], 'x', { keys: [] }, { slots: null }, { api_key: 'secret' },
    { keys: { gone: 'ka' } }, { keys: { pa: '' } }, { keys: { pa: 1 } },
    { slots: { fable: { provider: 'pa' } } }, { slots: { opus: null } },
    { slots: { opus: { provider: 'pa', pool: [] } } },
    { slots: { opus: { provider: 'pa', model: 'x\ny' } } },
    { slots: { opus: { provider: 'pa', model: [] } } },
    { slots: { opus: { provider: 'pa', key_id: '' } } },
    JSON.parse('{"keys":{"__proto__":"ka"}}'),
  ]) bad(() => normalizeRouting(value, 'claude', ps));
  bad(() => normalizeRouting({}, 'unknown', ps));
  bad(() => normalizeRouting({ keys: { pa: 'ka' } }, 'claude', [...ps, ps[0]]));
  ps[0].enabled = false;
  bad(() => normalizeRouting(routing(), 'claude', ps));
});

test('Key 空值/禁用/重复/控制字符不可保存，请求运行时也失败关闭', () => {
  for (const keys of [[], [{ id: 'kb', key: '' }], [{ id: 'kb', key: 'x', enabled: false }],
    [{ id: 'kb', key: 'x' }, { id: 'kb', key: 'y' }], [{ id: 'kb', key: 'x\ny' }]]) {
    const p = { id: 'pa', keys };
    bad(() => normalizeRouting({ keys: { pa: 'kb' } }, 'claude', [p]));
    assert.throws(() => selectSessionKey(p, {}, { keys: { pa: 'kb' }, slots: {} }),
      e => e.statusCode === 503 && e.type === 'provider_key_unavailable_error');
  }
});

test('Codex 自定义槽合法，模型可选，legacy Key 可以引用', () => {
  const ps = [{ id: 'cx', model: 'codex-default', api_key: 'legacy-secret' }];
  const config = normalizeRouting({ slots: { 'worker-1': { provider: 'cx', key_id: 'klegacy' } } }, 'codex', ps);
  const resolved = resolveSessionSlot(null, 'mixr-worker-1', 'codex', config, ps);
  assert.equal(resolved.model, 'codex-default');
  for (const name of ['A', '-bad', 'a'.repeat(25), 'constructor'])
    bad(() => normalizeRouting({ slots: { [name]: { provider: 'cx' } } }, 'codex', ps));
});

test('会话槽优先全局，覆盖不带备池，不改全局dropTools；未配置原样继承', () => {
  const ps = providers(), config = routing();
  const global = { name: 'opus', model: 'global', dropTools: ['Tool'], rule: { pool: ['pa', 'pb'] } };
  const snapshot = structuredClone(global);
  const result = resolveSessionSlot(global, ' MIXR-OPUS ', 'claude', config, ps);
  assert.equal(result.model, 'other-model');
  assert.equal(result.provider, ps[0]);
  assert.equal(result.rule.key_id, 'ka');
  assert.deepEqual(result.rule.pool, []);
  assert.deepEqual(global, snapshot);
  assert.equal(resolveSessionSlot(global, 'mixr-haiku', 'claude', config, ps), global);
  assert.equal(resolveSessionSlot(null, 'regular-model', 'claude', config, ps), null);
  assert.equal(resolveSessionSlot(global, 'mixr-opus', 'claude', config, []).provider, null);
});

test('会话槽:Claude 兼容别名按同一槽名覆盖,Codex 组不认这个前缀', () => {
  const ps = providers(), config = routing();
  const global = { name: 'opus', model: 'global', dropTools: ['Tool'], rule: { pool: ['pa', 'pb'] } };
  const snapshot = structuredClone(global);
  const compat = resolveSessionSlot(global, ' claude-mixr-opus ', 'claude', config, ps);
  assert.equal(compat.session, true);
  assert.equal(compat.name, 'opus');
  assert.equal(compat.model, 'other-model');
  assert.equal(compat.provider, ps[0]);
  assert.equal(compat.rule.key_id, 'ka');
  assert.deepEqual(compat.rule.pool, [], '会话槽覆盖不带备池,与 mixr-* 一致');
  assert.deepEqual(global, snapshot, '全局槽位快照不被改动');
  // 带 [1m] 上下文后缀时按同一槽名覆盖
  assert.equal(resolveSessionSlot(global, 'claude-mixr-opus[1m]', 'claude', config, ps).name, 'opus');
  // Codex 组只认 mixr-<槽名>:同一个字符串在 Codex 组是普通模型名,原样继承全局槽位
  assert.equal(resolveSessionSlot(global, 'claude-mixr-opus', 'codex', config, ps), global);
});

test('Key 优先级为槽位、会话渠道、全局；内容规则不受覆盖，无共享对象写入', () => {
  const ps = providers(), config = routing(), before = structuredClone(ps);
  const slotKey = selectSessionKey(ps[0], { slot: 'opus' }, config);
  assert.deepEqual(slotKey, { provider: { ...ps[0], api_key: 'secret-a' }, key_id: 'ka', key_source: 'session_slot', pinned: true });
  assert.notEqual(slotKey.provider, ps[0]);
  assert.deepEqual(selectSessionKey(ps[0], {}, config), { provider: { ...ps[0], api_key: 'secret-b' }, key_id: 'kb', key_source: 'session_provider', pinned: true });
  assert.deepEqual(selectSessionKey(ps[0], { content: true, slot: 'opus' }, config), { provider: ps[0], key_id: 'ka', key_source: 'provider_active', pinned: false });
  assert.deepEqual(selectSessionKey(ps[1], {}, config), { provider: ps[1], key_id: 'klegacy', key_source: 'provider_active', pinned: false });
  ps[0].api_key = 'legacy-active-value';
  assert.equal(selectSessionKey(ps[0], {}, {}).provider, ps[0]);
  ps[0].api_key = before[0].api_key;
  assert.deepEqual(ps, before);
  assert.throws(() => selectSessionKey(ps[1], { slot: 'opus' }, config), e => e.statusCode === 503);
  ps[0].keys = ps[0].keys.filter(k => k.id !== 'kb');
  assert.throws(() => selectSessionKey(ps[0], {}, config), e => e.statusCode === 503);
});

test('公开快照剔除额外字段但保留失效引用，不与原对象共享', () => {
  const session = { routing: routing() };
  session.routing.api_key = 'secret';
  session.routing.slots.opus.key = 'secret';
  const snapshot = routingOf(session);
  assert.ok(!JSON.stringify(snapshot).includes('secret'));
  snapshot.slots.opus.key_id = 'missing';
  assert.equal(session.routing.slots.opus.key_id, 'ka');
  session.routing.keys.pa = 'deleted';
  assert.equal(routingOf(session).keys.pa, 'deleted');
  assert.equal(hasRouting(session), true);
});

function fixture(options = {}) {
  let clock = 1000, disk = null, fail = false;
  const store = createSessionStore({ sessionsFile: '/fake/sessions.json', ttlMs: 100, max: 2,
    now: () => clock, loadJson: () => disk, saveJson: (_, value) => {
      if (fail) throw new Error('ENOSPC');
      disk = structuredClone(value);
    }, storeOf: providers, providerEligible: () => true, ...options });
  return { store, tick: value => { clock += value; }, disk: () => disk, fail: value => { fail = value; } };
}

test('已配置会话不因TTL或容量消失，旧会话仍淘汰，超过配置上限明确拒绝', () => {
  const { store, tick } = fixture();
  store.entry('configured').routing = routing();
  store.entry('old');
  tick(200);
  store.prune();
  assert.ok(store.sessions.has('configured'));
  assert.ok(!store.sessions.has('old'));
  store.entry('second').routing = routing();
  store.entry('third');
  assert.equal(store.configuredCount(), 2);
  bad(() => store.assertRoutingCapacity('third', routing()));
  assert.doesNotThrow(() => store.assertRoutingCapacity('configured', routing()));
  assert.doesNotThrow(() => store.assertRoutingCapacity('third', { keys: {}, slots: {} }));
  store.prune();
  assert.deepEqual([...store.sessions.keys()], ['configured', 'second']);
  store.sessions.get('configured').routing = { keys: {}, slots: {} };
  store.prune();
  assert.ok(!store.sessions.has('configured'));
});

test('配置落盘重载、公开视图与版本一致；写失败保留dirty可重试', () => {
  const f = fixture(), { store } = f;
  store.entry('configured').routing = normalizeRouting(routing(), 'claude', providers());
  store.saveSoon();
  f.fail(true);
  assert.throws(() => store.flush(), /ENOSPC/);
  f.fail(false);
  store.flush();
  assert.ok(!JSON.stringify(f.disk()).includes('secret-'));
  store.sessions.clear();
  store.load();
  f.tick(10000);
  const [row] = store.list({ findProvider: () => null, short: k => k });
  assert.deepEqual(row.routing, routing());
  assert.equal(row.routing_revision, routingRevision(row.routing));
  row.routing.keys.pa = 'changed';
  assert.equal(store.sessions.get('configured').routing.keys.pa, 'kb');
});
