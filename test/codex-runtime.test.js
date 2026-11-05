'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncCodexModel } = require('../lib/clients/codex-runtime');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-runtime-'));
  fs.mkdirSync(path.join(home, 'app-server-control'));
  fs.writeFileSync(path.join(home, 'app-server-control/app-server-control.sock'), '');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { configFile: path.join(home, 'config.toml'),
    before: { provider: 'mixr-native', model: 'old-main' },
    after: { provider: 'mixr-native', model: 'new-main' }, home };
}

test('runtime absence and provider changes never report a hot switch', async t => {
  const f = fixture(t);
  assert.equal((await syncCodexModel({ ...f, after: { provider: 'other', model: 'new' } })).status, 'restart_required');
  fs.unlinkSync(path.join(f.home, 'app-server-control/app-server-control.sock'));
  assert.equal((await syncCodexModel(f)).status, 'not_running');
});

test('direct model sync only changes primary threads using the same provider and previous default', {
  skip: typeof WebSocket === 'undefined',
}, async t => {
  const f = fixture(t), updates = [], calls = [];
  const threads = {
    main: { modelProvider: 'mixr-native', model: 'old-main', source: 'vscode' },
    custom: { modelProvider: 'mixr-native', model: 'explicit-model', source: 'cli' },
    worker: { modelProvider: 'mixr-native', model: 'old-main', source: { subAgent: {} } },
    other: { modelProvider: 'other', model: 'old-main', source: 'vscode' },
    cli: { modelProvider: 'mixr-native', model: 'old-main', source: 'cli' },
  };
  let closed = false;
  const result = await syncCodexModel({ ...f, connect: async () => ({
    home: f.home, close: () => { closed = true; },
    request: async (method, params) => {
      calls.push(method);
      if (method === 'thread/loaded/list')
        return params.cursor ? { data: ['cli'], nextCursor: null }
          : { data: ['main', 'custom', 'worker', 'other'], nextCursor: 'next' };
      if (method === 'thread/read') return { thread: threads[params.threadId] };
      assert.equal(method, 'thread/settings/update');
      assert.deepEqual(Object.keys(params).sort(), ['model', 'threadId'], 'effort, tier and permissions must stay unchanged');
      updates.push(params.threadId);
      threads[params.threadId].model = params.model;
      return {};
    },
  }) });
  assert.deepEqual(result, { status: 'applied', updated: 2, skipped: 3, failed: 0 });
  assert.deepEqual(updates, ['main', 'cli']);
  assert.equal(closed, true);
  assert.equal(calls.includes('thread/resume'), false);
});

test('a rejected or unconfirmed thread update is reported separately from the saved config', {
  skip: typeof WebSocket === 'undefined',
}, async t => {
  const f = fixture(t);
  let updated = false;
  const result = await syncCodexModel({ ...f, connect: async () => ({
    home: f.home, close() {},
    request: async (method, params) => {
      if (method === 'thread/loaded/list') return { data: ['good', 'rejected', 'stale'], nextCursor: null };
      if (method === 'thread/read') return { thread: { modelProvider: 'mixr-native',
        model: params.threadId === 'good' && updated ? 'new-main' : 'old-main', source: 'vscode' } };
      if (params.threadId === 'rejected') throw new Error('unsupported model');
      updated = true;
      return {};
    },
  }) });
  assert.deepEqual(result, { status: 'partial', updated: 1, skipped: 0, failed: 2 });
});

test('different Codex homes and disconnected daemons cannot modify live threads', {
  skip: typeof WebSocket === 'undefined',
}, async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, 'other'));
  let closed = false;
  const result = await syncCodexModel({ ...f, connect: async () => ({
    home: path.join(f.home, 'other'), close() { closed = true; },
    request() { assert.fail('must not inspect another home'); },
  }) });
  assert.equal(result.status, 'home_mismatch');
  assert.equal(closed, true);
  assert.equal((await syncCodexModel({ ...f, connect: async () => { throw new Error('offline'); } })).status, 'unavailable');
});

test('a symlinked config directory and canonical daemon home identify the same Codex instance', {
  skip: typeof WebSocket === 'undefined',
}, async t => {
  const f = fixture(t);
  const alias = f.home + '-link';
  fs.symlinkSync(f.home, alias, 'dir');
  t.after(() => fs.rmSync(alias, { force: true }));
  const result = await syncCodexModel({ ...f, configFile: path.join(alias, 'config.toml'),
    connect: async () => ({
      home: fs.realpathSync(f.home), close() {},
      request: async method => {
        assert.equal(method, 'thread/loaded/list');
        return { data: [], nextCursor: null };
      },
    }),
  });
  assert.equal(result.status, 'no_matching_threads');
});
