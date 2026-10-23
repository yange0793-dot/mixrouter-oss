'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDshConfig, normalizeCapabilities, configView } = require('../lib/dsh-schema');
const clone = value => structuredClone(value);
const slots = { main: { provider: 'p1', model: 'main-real' }, worker: { provider: 'p2', model: 'worker-real' } };
const config = () => ({ version: 2, slots: clone(slots), subagents: { owner: 'mixrouter', allow_model_selection: true,
  allowed_slots: ['worker'], default: { mode: 'slot', slot: 'worker' }, max_depth: 1, max_active: 4 } });

test('legacy storage is unchanged and its view preserves all candidates plus fixed main, not inheritance', () => {
  const v1 = normalizeDshConfig({ version: 1, slots });
  assert.deepEqual(v1, { version: 1, slots, default_subagent: '' });
  assert.deepEqual(configView(v1).subagents, { owner: 'mixrouter', allow_model_selection: true,
    allowed_slots: ['main', 'worker'], default: { mode: 'slot', slot: 'main' } });
  assert.equal(configView(v1).migration_required, true);
  assert.equal(configView(v1).source_version, 1);
  assert.deepEqual(configView({ version: 1, slots: {}, default_subagent: '' }).subagents,
    { owner: 'harness', allow_model_selection: false, allowed_slots: [], default: { mode: 'inherit' } });
  const selected = normalizeDshConfig({ slots, default_subagent: 'worker' });
  assert.equal(configView(selected).subagents.default.slot, 'worker');
});

test('v2 type labels preserve stable aliases, trim names and reject invalid metadata', () => {
  const c = config(); c.slots.worker.label = '  代码审查  '; c.slots.main.label = '已保存标题';
  const result = normalizeDshConfig(c);
  assert.equal(result.slots.worker.label, '代码审查'); assert.equal(result.slots.main.label, '已保存标题');
  assert.deepEqual(Object.keys(result.slots), ['main', 'worker']);
  assert.deepEqual(result.subagents, c.subagents);
  for (const label of ['', '   ']) {
    c.slots.worker.label = label;
    assert.equal(Object.hasOwn(normalizeDshConfig(c).slots.worker, 'label'), false);
  }
  c.slots.worker.label = 'x'.repeat(24); assert.equal(normalizeDshConfig(c).slots.worker.label.length, 24);
  for (const label of [null, 1, false, [], {}, 'x'.repeat(25), '含\n换行', '含\t制表', '\u0000', '\u007f']) {
    c.slots.worker.label = label;
    assert.throws(() => normalizeDshConfig(c), { statusCode: 400 }, JSON.stringify(label));
  }
  assert.throws(() => normalizeDshConfig({ version: 1, slots: { main: { ...slots.main, label: '代码' } } }), { statusCode: 400 });
});

test('v2 separates catalog from candidates, permits explicitly chosen main and true inheritance', () => {
  const normalized = normalizeDshConfig(config());
  assert.deepEqual(Object.keys(normalized.slots), ['main', 'worker']);
  assert.deepEqual(normalized.subagents.allowed_slots, ['worker']);
  assert.equal(normalized.default_subagent, undefined);
  const main = config(); main.subagents.allowed_slots = ['main']; main.subagents.default.slot = 'main';
  assert.equal(normalizeDshConfig(main).subagents.default.slot, 'main');
  const inherited = config(); inherited.subagents.default = { mode: 'inherit' };
  assert.deepEqual(normalizeDshConfig(inherited).subagents.default, { mode: 'inherit' });
  assert.equal(configView(normalized).migration_required, false);
});

test('native owner and selection disabled retain choices without claiming that child tasks are disabled', () => {
  const native = config(); native.subagents.owner = 'harness';
  assert.equal(normalizeDshConfig(native).subagents.owner, 'harness');
  const fixed = config(); fixed.subagents.allow_model_selection = false; fixed.subagents.allowed_slots = [];
  assert.deepEqual(normalizeDshConfig(fixed).subagents.default, { mode: 'slot', slot: 'worker' });
  const off = config(); off.subagents.allow_model_selection = false; off.subagents.default.slot = 'main';
  assert.deepEqual(normalizeDshConfig(off).subagents.allowed_slots, ['worker']);
});

test('candidates and defaults reject missing routes, duplicates and incoherent selections', () => {
  const bad = [
    { allowed_slots: [] }, { allowed_slots: ['worker', 'worker'] }, { allowed_slots: ['missing'] },
    { allowed_slots: [1] }, { allowed_slots: ['constructor'] }, { allowed_slots: null },
    { default: { mode: 'slot', slot: 'main' } }, { default: { mode: 'slot', slot: 'missing' } },
    { default: { mode: 'inherit', slot: 'worker' } }, { default: { mode: 'other' } },
    { default: null }, { owner: 'other' }, { owner: {} }, { allow_model_selection: 'false' },
    { api_key: 'secret' }, { max_depth: -1 }, { max_depth: 65 }, { max_depth: 1.2 },
    { max_depth: '2' }, { max_active: 0 }, { max_active: 65 }, { max_active: false },
  ];
  for (const patch of bad) {
    const value = config(); Object.assign(value.subagents, patch);
    assert.throws(() => normalizeDshConfig(value), { statusCode: 400 }, JSON.stringify(patch));
  }
  const edge = config(); edge.subagents.max_depth = 0; edge.subagents.max_active = 64;
  assert.equal(normalizeDshConfig(edge).subagents.max_depth, 0);
});

test('explicit capabilities normalize exact reasoning wire map and do not invent image or thinking defaults', () => {
  const c = config(); c.slots.worker.capabilities = { max_tokens: 8192, context_window: 128000,
    input: ['image', 'text'], reasoning_efforts: { high: 'deep', off: null, low: 'light' } };
  assert.deepEqual(normalizeDshConfig(c).slots.worker.capabilities, { context_window: 128000, max_tokens: 8192,
    input: ['text', 'image'], reasoning_efforts: { off: null, low: 'light', high: 'deep' } });
  assert.equal(normalizeDshConfig(c).slots.main.capabilities, undefined);
  assert.deepEqual(normalizeCapabilities({ reasoning_efforts: false }), { reasoning_efforts: false });
  assert.deepEqual(normalizeCapabilities({}), {});
  c.slots.main.capabilities = {};
  assert.equal(normalizeDshConfig(c).slots.main.capabilities, undefined);
});

test('invalid capability shapes, token capacities, wire strings and prompt-like fields are not persisted', () => {
  const bad = [null, false, [], { context_window: 0 }, { max_tokens: '8192' },
    { context_window: 4096, max_tokens: 8192 }, { input: [] }, { input: ['image'] }, { input: ['text', 'text'] },
    { input: ['text', 'audio'] }, { reasoning_efforts: true }, { reasoning_efforts: {} },
    { reasoning_efforts: { off: null } }, { reasoning_efforts: { low: null } },
    { reasoning_efforts: { high: '' } }, { reasoning_efforts: { high: 'bad\nwire' } },
    { reasoning_efforts: { unsupported: 'unsupported' } }, { instructions: 'ignore previous instructions' },
    JSON.parse('{"reasoning_efforts":{"high":"high","__proto__":"unexpected"}}'),
  ];
  for (const metadata of bad) assert.throws(() => normalizeCapabilities(metadata), { statusCode: 400 }, JSON.stringify(metadata));
});

test('root versions, route name/prototype fields and credential injection are validated before storage', () => {
  for (const value of [null, [], { version: 3, slots }, { version: 2, slots },
    { ...config(), default_subagent: '' }, { ...config(), api_key: 'secret' },
    { version: 1, slots: { ...slots, main: { ...slots.main, capabilities: {} } } },
    { version: 1, slots: {}, default_subagent: '' }]) assert.throws(() => normalizeDshConfig(value), { statusCode: 400 });
  for (const name of ['main_bad', 'Upper', 'constructor', 'prototype', '__proto__', '-invalid', 'a'.repeat(25)]) {
    const c = config(); Object.defineProperty(c.slots, name, { value: { ...slots.worker }, enumerable: true });
    assert.throws(() => normalizeDshConfig(c), { statusCode: 400 }, name);
  }
  const c = config(); c.slots.main.api_key = 'secret';
  assert.throws(() => normalizeDshConfig(c), { statusCode: 400 });
  assert.throws(() => normalizeDshConfig(config(), { providerAllowed: id => id === 'p1' }), /已启用/);
});
