'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequestLog } = require('../lib/observability/request-log');

const morning = new Date(2026, 10, 6, 9).getTime();
const stamp = (day, hour = 9) => new Date(2026, 10, day, hour).toISOString();
const record = (ts, input = 2, output = 3) => ({ ts, status: 200, in: input, out: output });
const lines = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
function logPath(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-daily-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'requests.jsonl');
}

test('daily totals keep every request after the 1000-entry ring evicts records', async t => {
  const file = logPath(t);
  fs.writeFileSync(file, lines([record(stamp(5))]));
  const log = createRequestLog({ file, now: () => morning, rotateDaily: false });
  await log.restoreToday();
  for (let i = 0; i < 1200; i++) log.append(record(stamp(6)));
  assert.equal(log.list({ limit: 5000 }).logs.length, 1000);
  assert.equal(log.summary().reqs, 1000);
  assert.deepEqual(log.today(), { reqs: 1200, inTok: 2400, outTok: 3600, exact: true });
  await log.flush();
});

test('startup restores active, legacy, rotated and gzip logs without refilling ring or process counters', async t => {
  const file = logPath(t);
  fs.writeFileSync(file + '.old', lines([record(stamp(5), 100, 100)]));
  const prefix = `${file}.archive-2026-11-06-1793930400000-`;
  fs.writeFileSync(prefix + 'a'.repeat(24), lines([record(stamp(6, 1), 10, 20)]));
  fs.writeFileSync(prefix + 'b'.repeat(24) + '.gz', zlib.gzipSync(lines([record(stamp(6, 2), 30, 40)])));
  fs.writeFileSync(file, lines([record(stamp(6, 3), 50, 60)]));
  const before = fs.readFileSync(file);
  const log = createRequestLog({ file, now: () => morning });
  await log.restoreToday();
  await log.restoreToday();
  assert.deepEqual(log.today(), { reqs: 3, inTok: 90, outTok: 120, exact: true });
  assert.equal(log.list().logs.length, 0);
  assert.deepEqual(log.metricsSnapshot().counters.requests, []);
  assert.deepEqual(fs.readFileSync(file), before, 'replay is read-only');
});

test('append during initial replay is counted once and restart recovers the same total', async t => {
  const file = logPath(t);
  fs.writeFileSync(file, lines([record(stamp(5)), record(stamp(6, 1), 4, 5)]));
  const log = createRequestLog({ file, now: () => morning, rotateDaily: false });
  const restore = log.restoreToday();
  log.append(record(stamp(6, 9), 6, 7));
  await restore;
  await log.flush();
  assert.deepEqual(log.today(), { reqs: 2, inTok: 10, outTok: 12, exact: true });
  const restarted = createRequestLog({ file, now: () => morning });
  await restarted.restoreToday();
  assert.deepEqual(restarted.today(), log.today());
});

test('crossing local midnight resets totals and ignores a previous-day request finishing late', async () => {
  let clock = new Date(2026, 10, 6, 23, 59, 59).getTime();
  const log = createRequestLog({ now: () => clock, capacity: 1 });
  await log.restoreToday();
  log.append(record(new Date(clock).toISOString(), 10, 20));
  assert.equal(log.today().exact, false);
  clock = new Date(2026, 10, 7, 0, 0, 1).getTime();
  assert.deepEqual(log.today(), { reqs: 0, inTok: 0, outTok: 0, exact: true });
  log.append(record(new Date(clock).toISOString(), 3, 4));
  log.append(record(stamp(6, 23), 100, 200));
  assert.deepEqual(log.today(), { reqs: 1, inTok: 3, outTok: 4, exact: true });
});

test('history that starts today returns its earliest count point instead of claiming a complete day', async t => {
  const file = logPath(t);
  fs.writeFileSync(file, lines([record(stamp(6, 6), 7, 8)]));
  const log = createRequestLog({ file, now: () => morning });
  await log.restoreToday();
  assert.deepEqual(log.today(), { reqs: 1, inTok: 7, outTok: 8, exact: false, since: stamp(6, 6) });
});

test('unreadable or malformed history falls back to new requests with an explicit start time', async t => {
  const file = logPath(t);
  fs.writeFileSync(file, lines([record(stamp(5)), record(stamp(6, 1), 40, 50)]) + '{bad json}\n');
  const errors = [];
  const log = createRequestLog({ file, now: () => morning, rotateDaily: false, onError: (error, ctx) => errors.push(ctx.op) });
  await log.restoreToday();
  log.append(record(stamp(6), 6, 7));
  assert.deepEqual(log.today(), { reqs: 1, inTok: 6, outTok: 7, exact: false, since: stamp(6) });
  assert.deepEqual(errors, ['today']);
  await log.flush();
  const blocked = createRequestLog({ file: path.join(file, 'requests.jsonl'), now: () => morning });
  await blocked.restoreToday();
  assert.deepEqual(blocked.today(), { reqs: 0, inTok: 0, outTok: 0, exact: false, since: stamp(6) });
});
