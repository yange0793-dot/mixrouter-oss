'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../lib/codex-config');

const calculate = (text = '', metadata = null) => config.compactionState(config.parse(text), metadata);
const model = { slug: 'known-model', context_window: 272000, max_context_window: 1000000,
  auto_compact_token_limit: 250000 };

function fixture(text, models, filename = 'catalog.json', slots = []) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-codex-compaction-'));
  const file = path.join(temporary, 'config.toml');
  fs.writeFileSync(file, `model_catalog_json = "${filename}"\n` + text);
  fs.writeFileSync(path.join(temporary, filename), JSON.stringify({ models }));
  try {
    return config.state(file, { current: '@router', providers: [], routerURL: 'http://127.0.0.1:1', routerToken: 'test', slots });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

test('Codex compact threshold accepts exact token integers and decimal k/m shorthand', () => {
  for (const [input, expected] of [[244800, 244800], ['244800', 244800], ['250k', 250000],
    ['0.5m', 500000], ['1.25M', 1250000], ['0.001K', 1], ['0.000001m', 1],
    ['1.0000000k', 1000], [1, 1], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER], ['00001', 1]]) {
    assert.equal(config.parseCompactThreshold(input), expected, `input ${JSON.stringify(input)}`);
  }
  assert.equal(config.parseCompactThreshold('auto'), null);
  assert.equal(config.parseCompactThreshold(null), null);
});

test('Codex compact threshold rejects coercion, unsafe numbers and noninteger token counts', () => {
  for (const input of [undefined, '', ' ', ' 250k', '250k ', '\n250k', '250k\n', '250k\r', '250k\r\n', true, false, {}, [], [250000],
    0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
    '0', '-1', '+1', '1.0', '1.5', '1e3', '1E6', '1e3k', '250_000', '0x100',
    '.5m', '1.m', '1kk', '0.0001k', '0.0000001m', '9007199254740992', '9007199254740993',
    '9007199254740.992k', '99999999999999999999999999999m', 'AUTO']) {
    assert.throws(() => config.parseCompactThreshold(input), error => error.statusCode === 400,
      `must reject ${String(input)}`);
  }
});

test('Codex compaction derives the catalog default from the 90% window cap, not 95%', () => {
  const state = calculate('', model);
  assert.deepEqual(state, { configured: null, default_limit: 244800, effective_limit: 244800,
    context_window: 272000, context_source: 'catalog', capped: false, warnings: [], restart_required: true });
  assert.notEqual(state.effective_limit, 258400);
});

test('Codex compaction honors a catalog default smaller than the window cap', () => {
  const state = calculate('', { ...model, auto_compact_token_limit: 180000 });
  assert.equal(state.default_limit, 180000);
  assert.equal(state.effective_limit, 180000);
  assert.equal(state.capped, false);
});

test('Codex compaction uses a configured threshold instead of the smaller catalog default', () => {
  const state = calculate('model_auto_compact_token_limit = 230000\n', { ...model, auto_compact_token_limit: 180000 });
  assert.equal(state.configured, 230000);
  assert.equal(state.default_limit, 180000);
  assert.equal(state.effective_limit, 230000);
  assert.equal(state.capped, false);
});

test('Codex compaction caps a configured threshold while preserving its original setting', () => {
  const state = calculate('model_auto_compact_token_limit = 258400\n', model);
  assert.equal(state.configured, 258400);
  assert.equal(state.effective_limit, 244800);
  assert.equal(state.capped, true);
  assert.ok(state.warnings.some(warning => warning.includes('90%')));
});

test('Codex compaction prefers the explicit window and clamps it to the declared maximum', () => {
  const state = calculate('model_context_window = 2000000\nmodel_auto_compact_token_limit = 1500000\n', model);
  assert.equal(state.context_window, 1000000);
  assert.equal(state.context_source, 'explicit');
  assert.equal(state.default_limit, 250000);
  assert.equal(state.configured, 1500000);
  assert.equal(state.effective_limit, 900000);
  assert.equal(state.capped, true);
  assert.ok(state.warnings.some(warning => warning.includes('model_context_window') && warning.includes('max_context_window')));
  assert.ok(state.warnings.some(warning => warning.includes('model_auto_compact_token_limit') && warning.includes('90%')));
});

test('Codex compaction distinguishes a capped window from an unchanged configured threshold', () => {
  const state = calculate('model_context_window = 2000000\nmodel_auto_compact_token_limit = 200000\n', model);
  assert.equal(state.configured, 200000);
  assert.equal(state.effective_limit, 200000);
  assert.equal(state.capped, true);
  assert.ok(state.warnings.some(warning => warning.includes('model_context_window') && warning.includes('max_context_window')));
  assert.ok(!state.warnings.some(warning => warning.includes('model_auto_compact_token_limit')));
});

test('Codex compaction does not confuse the catalog default window with a declared maximum', () => {
  const state = calculate('model_context_window = 500000\n', { context_window: 272000 });
  assert.equal(state.context_window, 500000);
  assert.equal(state.default_limit, 450000);
  assert.equal(state.context_source, 'explicit');
  assert.equal(state.capped, false);
});

test('Codex compaction applies a maximum-only catalog window and floors the 90% cap', () => {
  const state = calculate('', { max_context_window: 100001 });
  assert.equal(state.context_window, 100001);
  assert.equal(state.context_source, 'catalog');
  assert.equal(state.default_limit, 90000);
  assert.equal(state.effective_limit, 90000);
});

test('Codex compaction keeps the 90% floor exact at the safe-integer boundary', () => {
  const state = calculate(`model_context_window = ${Number.MAX_SAFE_INTEGER}\n`);
  assert.equal(state.context_window, Number.MAX_SAFE_INTEGER);
  assert.equal(state.default_limit, 8106479329266891);
  assert.equal(state.effective_limit, 8106479329266891);
});

test('Codex compaction uses the native catalog context window without applying the explicit override maximum', () => {
  const state = calculate('', { context_window: 500000, max_context_window: 200000 });
  assert.equal(state.context_window, 500000);
  assert.equal(state.default_limit, 450000);
  assert.equal(state.context_source, 'catalog');
  assert.equal(state.capped, false);
});

test('Codex compaction can show a configured limit with an unconfirmed window', () => {
  const state = calculate('model_auto_compact_token_limit = 244800\n');
  assert.equal(state.configured, 244800);
  assert.equal(state.default_limit, null);
  assert.equal(state.effective_limit, 244800);
  assert.equal(state.context_window, null);
  assert.equal(state.context_source, 'unknown');
  assert.ok(state.warnings.some(warning => warning.includes('上限未确认')));
});

test('Codex compaction can show a catalog limit with an unconfirmed window', () => {
  const state = calculate('', { auto_compact_token_limit: 180000 });
  assert.equal(state.default_limit, 180000);
  assert.equal(state.effective_limit, 180000);
  assert.equal(state.context_window, null);
  assert.ok(state.warnings.some(warning => warning.includes('上限未确认')));
});

test('Codex compaction does not invent a window or limit when model metadata is unknown', () => {
  const state = calculate();
  for (const key of ['configured', 'default_limit', 'effective_limit', 'context_window']) assert.equal(state[key], null);
  assert.equal(state.context_source, 'unknown');
  assert.equal(state.capped, false);
  assert.equal(state.restart_required, true);
  assert.ok(state.warnings.length);
});

test('Codex compaction warns about invalid old thresholds instead of presenting normal auto', () => {
  for (const value of ['0', '-1', '1.5', 'inf', 'true', '"250k"', '[]', '""', '9007199254740992', '"""250000"""']) {
    const state = calculate(`model_auto_compact_token_limit = ${value}\n`, model);
    assert.equal(state.configured, null, value);
    assert.equal(state.default_limit, 244800, value);
    assert.equal(state.effective_limit, null, value);
    assert.ok(state.warnings.some(warning => warning.includes('model_auto_compact_token_limit') && warning.includes('不视为正常 auto')), value);
  }
});

test('Codex compaction warns about invalid old windows without hiding them behind catalog defaults', () => {
  for (const value of ['0', '-1', '1.5', 'nan', 'false', '"1000000"', '{}', '9007199254740992']) {
    const state = calculate(`model_context_window = ${value}\nmodel_auto_compact_token_limit = 200000\n`, model);
    assert.equal(state.context_window, null, value);
    assert.equal(state.context_source, 'unknown', value);
    assert.equal(state.default_limit, 250000, value);
    assert.equal(state.effective_limit, 200000, value);
    assert.ok(state.warnings.some(warning => warning.includes('model_context_window')), value);
  }
});

test('Codex compaction ignores invalid metadata capability values', () => {
  for (const value of [0, -1, 1.5, '1000000', true, null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const state = calculate('', { context_window: value, max_context_window: value, auto_compact_token_limit: value });
    assert.equal(state.context_window, null);
    assert.equal(state.default_limit, null);
    assert.equal(state.effective_limit, null);
  }
});

test('Codex compaction does not read similarly named profile or nested keys as global defaults', () => {
  const document = config.parse('profile = "ci"\n[profiles.ci]\nmodel_context_window = 1000000\nmodel_auto_compact_token_limit = 800000\n');
  const state = config.compactionState(document, model);
  assert.equal(state.configured, null);
  assert.equal(state.context_window, 272000);
  assert.equal(state.effective_limit, 244800);
  assert.ok(state.warnings.some(warning => warning.includes('profile') && warning.includes('全局默认')));
  assert.equal(document.get('profiles', 'ci', 'model_auto_compact_token_limit'), 800000);
});

test('Codex state attaches compaction calculated from the actual configured model catalog entry', () => {
  const state = fixture('model = "known-model"\n', [model, { slug: 'other-model', context_window: 1000000 }]);
  assert.equal(state.compaction.context_window, 272000);
  assert.equal(state.compaction.effective_limit, 244800);
});

test('Codex compaction state uses synchronized managed alias metadata only', () => {
  const alias = { ...model, slug: 'mixr-main', x_mixrouter: { target: model.slug, capabilities_known: true } };
  const slots = [{ alias: 'mixr-main', model: model.slug, enabled: true }];
  const state = fixture('model = "mixr-main"\n', [alias, model], 'mixrouter-model-catalog.json', slots);
  assert.equal(state.compaction.context_window, 272000);
  assert.equal(state.compaction.default_limit, 244800);
});

test('Codex compaction does not mix an unsynchronized alias with temporary target capabilities', () => {
  const alias = { ...model, slug: 'mixr-main', x_mixrouter: { target: model.slug, capabilities_known: true } };
  const alternate = { slug: 'alternate-target', context_window: 1000000, auto_compact_token_limit: 800000 };
  const slots = [{ alias: 'mixr-main', model: alternate.slug, enabled: true }];
  const state = fixture('model = "mixr-main"\n', [alias, model, alternate], 'mixrouter-model-catalog.json', slots);
  assert.equal(state.main.context_window, 1000000, 'existing slot capability display still follows the current target');
  assert.equal(state.compaction.context_window, null, 'disk compaction must not use unsynchronized target capability');
  assert.equal(state.compaction.default_limit, null);
  assert.equal(state.compaction.effective_limit, null);
});

test('Codex compaction does not borrow target capabilities when its configured alias is missing', () => {
  const slots = [{ alias: 'mixr-main', model: model.slug, enabled: true }];
  const state = fixture('model = "mixr-main"\n', [model], 'catalog.json', slots);
  assert.equal(state.compaction.context_window, null);
  assert.equal(state.compaction.effective_limit, null);
});

test('Codex compaction ignores capabilities on an explicitly unknown managed alias', () => {
  const alias = { ...model, slug: 'mixr-main', x_mixrouter: { target: model.slug, capabilities_known: false } };
  const slots = [{ alias: 'mixr-main', model: model.slug, enabled: true }];
  const state = fixture('model = "mixr-main"\n', [alias, model], 'mixrouter-model-catalog.json', slots);
  assert.equal(state.compaction.context_window, null);
  assert.equal(state.compaction.default_limit, null);
});

test('Codex compaction does not leak the selected profile model capabilities into global defaults', () => {
  const state = fixture('model = "unknown-model"\nprofile = "ci"\n',
    [model, { slug: 'ci-model', context_window: 1000000 }]);
  assert.equal(state.compaction.context_window, null);
  assert.equal(state.compaction.effective_limit, null);
  assert.ok(state.compaction.warnings.some(warning => warning.includes('profile')));
});

test('Codex state keeps its compaction shape when the TOML document cannot be read', () => {
  const state = fixture('model = "unterminated', []);
  assert.equal(state.match, false);
  assert.equal(typeof state.error, 'string');
  assert.equal(state.compaction.context_source, 'unknown');
  assert.equal(state.compaction.configured, null);
  assert.equal(state.compaction.default_limit, null);
  assert.equal(state.compaction.effective_limit, null);
  assert.ok(state.compaction.warnings.some(warning => warning.includes('配置读取失败')));
});
