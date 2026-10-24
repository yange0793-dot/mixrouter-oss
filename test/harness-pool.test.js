'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHarnessPool, MAIN_ALIAS } = require('../lib/harness-pool');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-harness-pool-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const providers = [
    { id: 'cc', name: 'Messages fixture', app: 'claude', models: ['same', 'second'], api_key: 'fixture-upstream-secret', enabled: true },
    { id: 'cx', name: 'Responses fixture', app: 'codex', model: 'same', api_key: 'fixture-cx-secret', enabled: true },
    { id: 'chat', app: 'codex', model: 'chat-model', wire_api: 'chat', api_key: 'fixture-chat-secret' },
  ];
  const file = path.join(dir, 'harness-pool.json'), profilePath = path.join(dir, 'cordis.patch.yml');
  const manager = createHarnessPool({ file, profilePath, getProviders: () => providers,
    routerURL: 'http://127.0.0.1:19201/', routerToken: 'fixture-router-secret' });
  const save = (main = { provider: 'cc', model: 'same' }, pool = []) => manager.save({ main, pool, expected_revision: manager.read().revision });
  return { dir, file, profilePath, providers, manager, save };
}

test('factory/read are safe and do not touch old dsh files or write on startup', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'dsh.json'), '{legacy malformed');
  const initial = f.manager.read();
  assert.equal(initial.api_version, 1); assert.equal(initial.configured, false);
  assert.deepEqual(initial.pool, []); assert.equal(initial.main, null);
  assert.equal(initial.base_url, 'http://127.0.0.1:19201/harness/v1');
  assert.equal(initial.client.coverage, 'ordinary-subagent-explicit-selection');
  assert.equal(initial.client.pool_updates, 'new-sessions');
  assert.ok(!JSON.stringify(initial).includes('fixture-upstream-secret'));
  assert.deepEqual(fs.readdirSync(f.dir), ['dsh.json']);
  assert.deepEqual(f.manager.models(), { object: 'list', data: [] });
  assert.equal(f.manager.resolve(MAIN_ALIAS, 'messages').error.status, 404);
});

test('main is explicitly mirrored into pool; exact same-model different-provider pairs remain separate', t => {
  const f = fixture(t), state = f.save(undefined, [{ provider: 'cx', model: 'same' }, { provider: 'cx', model: 'same' }]);
  assert.equal(state.pool.length, 2);
  assert.deepEqual(state.main, { provider: 'cc', model: 'same' });
  assert.equal(state.pool[0].provider, 'cx'); assert.equal(state.pool[1].provider, 'cc');
  assert.equal(new Set(state.pool.map(p => p.id)).size, 2);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  const ids = state.pool.map(p => p.id);
  const next = f.save({ provider: 'cx', model: 'same' }, state.pool.map(({ provider, model }) => ({ provider, model })));
  assert.deepEqual(next.pool.map(p => p.id), ids);
  assert.ok(f.manager.models().data.some(p => p.id === MAIN_ALIAS));
  assert.equal(f.manager.models().data.length, 3);
});

test('routes validate exact enabled keyed provider/model; business policy fields rejected', t => {
  const f = fixture(t), initial = f.manager.read();
  for (const input of [
    { main: { provider: 'cc', model: 'unknown' }, pool: [] },
    { main: { provider: 'missing', model: 'same' }, pool: [] },
    { main: { provider: 'cc', model: 'same', type: 'planner' }, pool: [] },
    { main: { provider: 'cc', model: 'same' }, pool: [], owner: 'fixed' },
    { main: { provider: 'cc', model: 'same' }, pool: [{ provider: 'cx', model: 'same', preset: 'fixed' }] },
    { main: { provider: 'cc', model: 'same' }, pool: [{ id: 'UPPER', provider: 'cx', model: 'same' }] },
  ]) assert.throws(() => f.manager.save({ ...input, expected_revision: initial.revision }), { statusCode: 400 });
  f.providers[0].enabled = false;
  assert.throws(() => f.save(), { statusCode: 400 });
  f.providers[0].enabled = true; f.providers[0].api_key = '';
  assert.throws(() => f.save(), { statusCode: 400 });
  assert.equal(fs.existsSync(f.file), false);
});

test('pool revision detects external JSON and provider changes without changing CC/Codex stores', t => {
  const f = fixture(t), state = f.save(), providers = structuredClone(f.providers);
  fs.appendFileSync(f.file, ' ');
  assert.throws(() => f.manager.save({ main: state.main, pool: state.pool, expected_revision: state.revision }), { statusCode: 409 });
  const next = f.manager.read();
  f.providers[0].models.push('external-model');
  assert.throws(() => f.manager.preview({ expected_revision: next.revision }), { statusCode: 409 });
  f.providers[0].models.pop();
  assert.deepEqual(f.providers, providers);
});

test('resolve normalizes source app wire and never uses ordinary fallback or model-string wildcard', t => {
  const f = fixture(t), state = f.save(undefined, [{ provider: 'cx', model: 'same' }, { provider: 'chat', model: 'chat-model' }]);
  const main = f.manager.resolve(MAIN_ALIAS, 'messages');
  assert.equal(main.provider.wire_api, 'anthropic');
  assert.equal(f.providers[0].wire_api, undefined);
  assert.equal(main.members[0].provider.api_key, 'fixture-upstream-secret');
  assert.equal(main.rule.id, 'harness:main'); assert.equal(main.strategy, 'priority');
  assert.equal(main.slot, 'harness-main');
  const chat = state.aliases.pool.find(p => p.provider === 'chat');
  assert.equal(f.manager.resolve(chat.alias, 'responses').provider.wire_api, 'chat');
  assert.equal(f.manager.resolve(chat.alias, 'chat/completions').slot, 'harness-' + chat.id);
  assert.equal(f.manager.resolve(MAIN_ALIAS, 'chat/completions').error.type, 'harness_protocol_unsupported');
  const cx = state.aliases.pool.find(p => p.provider === 'cx').alias;
  assert.equal(f.manager.resolve(cx, 'messages').provider.wire_api, 'responses');
  assert.equal(f.manager.resolve(cx, 'responses').provider.wire_api, 'responses');
  assert.equal(f.manager.resolve(MAIN_ALIAS, 'responses').error.type, 'harness_protocol_unsupported');
  assert.equal(f.manager.resolve('same', 'messages').error.status, 404);
  assert.equal(f.manager.resolve('mixr-harness-pool-not-in-whitelist', 'messages').error.status, 404);
  assert.equal(f.manager.resolve('mixr-main', 'messages').error.status, 404);
  assert.equal(f.manager.resolve(MAIN_ALIAS, 'responses/compact').error.status, 400);
  f.providers[0].enabled = false;
  assert.equal(f.manager.resolve(MAIN_ALIAS, 'messages').error.status, 503);
});

test('stable row ids reject alias reassignment and configured deleted pairs fail explicitly', t => {
  const f = fixture(t), state = f.save(undefined, [{ id: 'first', provider: 'cx', model: 'same' }]);
  assert.throws(() => f.save(state.main, state.pool.map(p => ({ ...p, id: p.id === 'first' ? 'changed' : p.id }))), { statusCode: 400 });
  f.providers.splice(1, 1);
  assert.equal(f.manager.resolve('mixr-harness-pool-first', 'messages').error.status, 503);
});

test('pool writer contention refuses stale edits and cannot reassign a live alias', t => {
  const f = fixture(t), state = f.save(undefined, [{ id: 'original', provider: 'cx', model: 'same' }]);
  assert.throws(() => f.save(state.main, [{ id: 'original', provider: 'chat', model: 'chat-model' }]), { statusCode: 400 });
  fs.writeFileSync(f.file + '.lock', process.pid + '\n');
  assert.throws(() => f.save(state.main, state.pool), { statusCode: 409 });
  assert.equal(f.manager.read().revision, state.revision);
  assert.ok(fs.existsSync(f.file + '.lock'));
});

test('malformed current pool or symlink path is rejected without overwrite', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, '{broken');
  assert.throws(() => f.manager.read(), { statusCode: 400 });
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken');
  fs.renameSync(f.file, f.file + '.real'); fs.symlinkSync(f.file + '.real', f.file);
  assert.throws(() => f.manager.read(), { statusCode: 403 });
});

test('connection requires reviewed fingerprint and explicit confirmation; no secret in result', t => {
  const f = fixture(t), state = f.save();
  fs.writeFileSync(f.profilePath, '- id: llm-pi-ai\n- id: agent-default-model\n- id: subagent-model-selection-settings\n', { mode: 0o600 });
  const before = fs.readFileSync(f.profilePath, 'utf8');
  const preview = f.manager.preview({ expected_revision: state.revision });
  assert.equal(fs.readFileSync(f.profilePath, 'utf8'), before);
  assert.throws(() => f.manager.connect({ expected_revision: state.revision, expected_profile_revision: preview.profile_revision }), { statusCode: 400 });
  const result = f.manager.connect({ confirm: true, expected_revision: state.revision, expected_profile_revision: preview.profile_revision });
  assert.equal(result.state.client.status, 'connected');
  assert.ok(!JSON.stringify(result).includes('fixture-router-secret'));
  assert.ok(!fs.readFileSync(f.profilePath, 'utf8').includes('fixture-router-secret'));
});
