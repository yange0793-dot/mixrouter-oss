'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createPoolState } = require('../lib/routing/pool-state');
const { createKeyFallback } = require('../lib/routing/key-fallback');

const provider = {
  id: 'no-cooldown', enabled: true, key_fallback: true, active_key: 'primary', api_key: 'fixture-primary',
  keys: [{ id: 'primary', key: 'fixture-primary' }, { id: 'backup', key: 'fixture-backup' }],
};
const choice = { provider, key_id: 'primary', key_source: 'provider_active', pinned: false };

test('渠道冷却接口兼容但无效果,不保存任何截止时间', () => {
  const pool = createPoolState({ cooldownMs: 60000, now: () => 1000 });
  pool.markCooldown(provider.id);
  pool.cooldowns = { [provider.id]: 61000 };
  pool.cooldowns[provider.id] = 61000;
  assert.equal(pool.inCooldown(provider.id), false);
  assert.deepEqual(pool.cooldowns, {});
  pool.pools.round = 3;
  pool.resetPools();
  assert.deepEqual(pool.pools, {});
});

test('Key 失败仅影响本请求,新请求及并发请求立即可用,不等待 Retry-After', () => {
  const fallback = createKeyFallback({ cooldownMs: 60000, now: () => 1000 });
  const failedKeys = new Set();
  const select = overrides => fallback.select({ provider, keyChoice: choice, model: 'demo', failedKeys, ...overrides });
  assert.equal(select(), choice);
  assert.deepEqual(fallback.failure({ provider, key_id: 'primary', model: 'demo', status: 429,
    retryAfterMs: 60000, failedKeys }), { switchable: true, scope: 'model', wait_ms: 0 });
  assert.equal(select().key_id, 'backup');
  assert.equal(select({ model: 'other' }), choice);
  assert.equal(select({ failedKeys: new Set() }), choice);
  assert.equal(select({ failedKeys: undefined }), choice);
  assert.deepEqual(fallback.failure({ provider, key_id: 'backup', model: 'demo', status: 429,
    retryAfterMs: 60000, failedKeys }), { switchable: false, scope: 'model', wait_ms: 0 });
  assert.equal(select().fallback.reason, 'all_failed');
  assert.equal(select().fallback.wait_ms, 0);
  assert.ok(fallback.list().every(row => row.until === 0 && row.state === 'failed'));
  assert.equal(select({ failedKeys: new Set() }), choice);
});

test('旧 MIXR_COOLDOWN_SEC 参数不能重新启用冷却', () => {
  const result = spawnSync(process.execPath, ['-e',
    "const router = require('./mixrouter'); router.markCooldown('fixture', 503); console.log(JSON.stringify({ms:router.healthStatus().settings.cooldown_ms, active:router.inCooldown('fixture'), table:router._state.cooldowns}));"],
  { cwd: require('node:path').resolve(__dirname, '..'), env: { ...process.env, MIXR_COOLDOWN_SEC: '60000' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const payload = result.stdout.trim().split('\n').at(-1);
  assert.deepEqual(JSON.parse(payload), { ms: 0, active: false, table: {} });
});
