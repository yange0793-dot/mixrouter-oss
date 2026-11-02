'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSpecs, writeSpecs, modelsPublic, revisionOf } = require('../lib/model-specs');

const store = { claude: [{ id: 'pa', name: 'A', model: 'm', models: ['m', 'n'], api_key: 'FAKE-secret', base_url: 'https://private.example' }], codex: [] };
const target = { app: 'claude', provider: 'pa', model: 'm' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-specs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'model-specs.json');
}
const put = (file, spec, extra = {}) => writeSpecs(file, store, {
  ...target, spec, expected_revision: revisionOf(readSpecs(file)), ...extra,
});

test('缺失声明只读，不猜能力，不回显渠道凭据', t => {
  const file = fixture(t);
  const view = modelsPublic(readSpecs(file), store, []);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(view.models.map(row => row.model), ['m', 'n']);
  for (const cap of Object.values(view.models[0].capabilities)) assert.deepEqual(cap, { value: null, source: 'unknown' });
  assert.equal(view.models[0].observation, null);
  assert.ok(!JSON.stringify(view).includes('FAKE-secret'));
  assert.ok(!JSON.stringify(view).includes('private.example'));
});

test('声明 CAS 原子保存、清除、不改渠道与任何运行参数', t => {
  const file = fixture(t);
  const initial = revisionOf(readSpecs(file));
  const before = JSON.stringify(store);
  const data = put(file, { context_window: 200000, max_output_tokens: 8192, vision: false, reasoning_levels: ['low', 'high'] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readSpecs(file), data);
  assert.equal(JSON.stringify(store), before);
  assert.deepEqual(modelsPublic(data, store, []).models[0].capabilities.vision, { value: false, source: 'manual' });
  assert.throws(() => put(file, {}, { expected_revision: initial }), { statusCode: 409 });
  assert.deepEqual(put(file, { context_window: null, max_output_tokens: null, vision: null, reasoning_levels: null }).models, []);
});

test('非法边界只在写入处拒绝，不覆盖旧声明', t => {
  const file = fixture(t);
  put(file, { vision: true });
  const before = fs.readFileSync(file, 'utf8');
  for (const spec of [null, [], { extra: 1 }, { vision: 'yes' }, { context_window: 0 }, { context_window: -1 },
    { max_output_tokens: 1.2 }, { context_window: 100000001 }, { reasoning_levels: [] },
    { reasoning_levels: ['high', 'high'] }, { reasoning_levels: ['bad\nname'] }, { reasoning_levels: 'high' }]) {
    assert.throws(() => put(file, spec), { statusCode: 400 });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  for (const extra of [{ app: 'other' }, { provider: 'missing' }, { model: 'unlisted' }, { model: 'm\n' }, { api_key: 'FAKE-secret' }])
    assert.throws(() => put(file, {}, extra), { statusCode: 400 });
});

test('损坏或未来版磁盘明确报错，绝不当空表覆盖', t => {
  const file = fixture(t);
  for (const text of ['{invalid-private', '{"version":2,"models":[]}',
    JSON.stringify({ version: 1, models: [{ ...target, spec: { vision: true } }, { ...target, spec: {} }] }),
    JSON.stringify({ version: 1, models: [], secret: 'FAKE-secret' })]) {
    fs.writeFileSync(file, text);
    assert.throws(() => readSpecs(file), { statusCode: 500 });
    assert.throws(() => writeSpecs(file, store, { ...target, spec: {}, expected_revision: 'old' }), { statusCode: 500 });
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

test('原子写失败保留旧声明', t => {
  const file = fixture(t);
  put(file, { vision: true });
  const before = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === file) throw new Error('FAKE-secret'); return rename(from, to); };
  try { assert.throws(() => put(file, { vision: false }), error => error.statusCode === 500 && !error.message.includes('FAKE-secret')); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('仅展示成功请求的上游自报值，失败、缺值、同名渠道不冒充证据', () => {
  const data = { version: 1, models: [] };
  const base = { app: 'claude', provider: 'A', model_out: 'm', upstream_model: 'reported', status: 200, ts: '2026-11-02T00:00:00Z' };
  const logs = [{ ...base, status: 502, upstream_model: 'failed' }, { ...base, err: 'cancelled', upstream_model: 'cancelled' }, base];
  assert.equal(modelsPublic(data, store, logs).models[0].observation.upstream_model, 'reported');
  assert.equal(modelsPublic(data, store, [{ ...base, upstream_model: '' }]).models[0].observation, null);
  const duplicate = { claude: [store.claude[0], { ...store.claude[0], id: 'pb' }], codex: [] };
  assert.equal(modelsPublic(data, duplicate, logs).models[0].observation, null);
});
