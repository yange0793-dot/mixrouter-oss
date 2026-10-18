'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequestLog } = require('../lib/observability/request-log');
test('recorded slot wins; legacy session kind/model never guessed; history survives restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-slots-'));
  const file = path.join(root, 'requests.jsonl');
  const log = createRequestLog({ file, capacity: 2 });
  t.after(async () => { await log.flush(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = { ts: '2026-09-29T00:00:00Z', in: 3, out: 4, cache_read: 5, status: 200 };
  log.append({ ...base, slot: 'opus', session_kind: 'haiku' });
  log.append({ ...base, slot: '__proto__' });
  log.append({ ...base, session_kind: 'sonnet', model_in: 'claude-sonnet' });
  assert.equal(log.summary().scope.source, 'memory');
  assert.equal(log.summary().reqs, 2);
  const fresh = createRequestLog({ file });
  const summary = await fresh.summaryHistory({ since: base.ts, until: base.ts });
  assert.equal(summary.scope.source, 'history'); assert.equal(summary.scope.timezone, 'UTC');
  assert.equal(summary.reqs, 3);
  for (const name of ['opus', '__proto__', 'unknown']) assert.deepEqual(summary.by_slot[name], { reqs: 1, in: 3, out: 4, cache: 5 });
  assert.equal(summary.by_slot.sonnet, undefined);
  assert.equal(summary.inTok, 9); assert.equal(summary.outTok, 12); assert.equal(summary.cache, 15);
  assert.equal((await fresh.summaryHistory({ slot: 'opus' })).reqs, 1);
  assert.equal(fresh.metricsSnapshot().counters.requests.length, 0);
});

test('explicit empty slot means no slot, missing slot remains legacy unknown', () => {
  const log = createRequestLog();
  log.append({ slot: '', model_in: 'mixr-opus', session_kind: 'opus' });
  log.append({ model_in: 'mixr-opus' });
  assert.equal(log.summary().by_slot.none.reqs, 1);
  assert.equal(log.summary().by_slot.unknown.reqs, 1);
  assert.equal(log.summary().by_slot.opus, undefined);
});
