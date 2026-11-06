'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequestLog } = require('../lib/observability/request-log');
const { createLogFiles, inventory } = require('../lib/observability/log-files');
const { records } = require('../lib/observability/log-history');
const { createUsageSummary } = require('../lib/usage/summary');
const { createApplication } = require('../lib/application');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const entry = n => ({ ts: new Date(NOW - 100000 + n).toISOString(), session: String(n),
  status: 200, in: 2, out: 3 });
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
const archive = (file, day = '2026-11-07') => `${file}.archive-${day}-1794052800000-${'a'.repeat(24)}`;
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-log-window-'));
  const file = path.join(root, 'requests.jsonl'), errors = [];
  const log = createRequestLog({ file, now: () => NOW, maxBytes: 0, rotateDaily: false,
    onError: (error, ctx) => errors.push(ctx.op), ...options });
  t.after(async () => {
    await log.restoreToday(); await log.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, file, log, errors };
}
const sessions = async log => (await log.listHistory({ limit: 1000 })).logs.map(e => e.session);

test('memory keeps 1000 recent requests while counters count every request', () => {
  const log = createRequestLog({ now: () => NOW });
  for (let n = 0; n < 1200; n++) log.append(entry(n));
  const list = log.list({ limit: 10000 });
  assert.equal(list.capacity, 1000);
  assert.equal(list.logs.length, 1000);
  assert.equal(list.logs[0].session, '1199');
  assert.equal(list.logs.at(-1).session, '200');
  assert.equal(log.today().reqs, 1200);
});

test('count retention spans legacy, gzip and active files and trims only the oldest records', async t => {
  const { root, file, log, errors } = fixture(t, { maxEntries: 5 });
  fs.writeFileSync(file + '.old', jsonl([0, 1, 2].map(entry)));
  const gz = archive(file) + '.gz';
  fs.writeFileSync(gz, zlib.gzipSync(jsonl([3, 4, 5, 6].map(entry))));
  fs.writeFileSync(file, jsonl([7, 8].map(entry)));
  fs.writeFileSync(path.join(root, 'unrelated.jsonl'), 'keep');
  await log.maintenance();
  assert.deepEqual(await sessions(log), ['8', '7', '6', '5', '4']);
  assert.equal(fs.existsSync(file + '.old'), false);
  assert.equal(fs.statSync(gz).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(root, 'unrelated.jsonl'), 'utf8'), 'keep');
  assert.ok(!fs.readdirSync(root).some(name => name.endsWith('.tmp')));
  assert.deepEqual(errors, []);
  const restarted = createRequestLog({ file, maxEntries: 5, now: () => NOW });
  assert.deepEqual(await sessions(restarted), ['8', '7', '6', '5', '4']);
});

test('an oversized active file is rotated before trimming and later writes survive', async t => {
  const { file, log } = fixture(t, { maxEntries: 5 });
  fs.writeFileSync(file, jsonl(Array.from({ length: 9 }, (_, n) => entry(n))));
  await log.maintenance();
  assert.deepEqual(await sessions(log), ['8', '7', '6', '5', '4']);
  log.append(entry(9));
  log.append(entry(10));
  await log.flush();
  assert.deepEqual(await sessions(log), ['10', '9', '8', '7', '6']);
});

test('UTC age retention removes idle active and legacy files and keeps the boundary day', async t => {
  const { file, log } = fixture(t, { rotateDaily: true });
  const expired = new Date('2026-10-07T12:00:00Z');
  fs.writeFileSync(file, jsonl([entry(1)]));
  fs.writeFileSync(file + '.old', jsonl([entry(2)]));
  fs.utimesSync(file, expired, expired);
  fs.utimesSync(file + '.old', expired, expired);
  fs.writeFileSync(archive(file, '2026-10-07'), jsonl([entry(3)]));
  fs.writeFileSync(archive(file, '2026-10-08'), jsonl([entry(4)]));
  await log.maintenance();
  assert.deepEqual(await sessions(log), ['4']);
  assert.equal(fs.existsSync(file + '.old'), false);
  assert.equal(log.storageStatus().retention_days, 30);
  assert.equal(log.storageStatus().max_entries, 100000);
});

test('append during pruning is retained and the queued sweep enforces the final limit', async t => {
  const { file, log } = fixture(t, { maxEntries: 3 });
  fs.writeFileSync(archive(file), jsonl([0, 1, 2, 3].map(entry)));
  const original = fs.promises.rename;
  let appended = false;
  fs.promises.rename = async (...args) => {
    if (!appended) { appended = true; log.append(entry(5)); }
    return original(...args);
  };
  try {
    log.append(entry(4));
    await log.flush();
  } finally { fs.promises.rename = original; }
  assert.equal(appended, true);
  assert.deepEqual(await sessions(log), ['5', '4', '3']);
});

test('failed archive replacement preserves records, reports failure and recovers on retry', async t => {
  const { root, file, log, errors } = fixture(t, { maxEntries: 2 });
  fs.writeFileSync(archive(file), jsonl([0, 1, 2].map(entry)));
  const original = fs.promises.rename;
  fs.promises.rename = async () => { throw new Error('injected replacement failure'); };
  try { await log.maintenance(); }
  finally { fs.promises.rename = original; }
  assert.deepEqual(await sessions(log), ['2', '1', '0']);
  assert.equal(log.storageStatus().healthy, false);
  assert.deepEqual(errors, ['retention']);
  assert.ok(!fs.readdirSync(root).some(name => name.endsWith('.tmp')));
  await log.maintenance();
  assert.deepEqual(await sessions(log), ['2', '1']);
  assert.equal(log.storageStatus().healthy, true);
});

test('retention caches unchanged files and reads only appended bytes', async t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, jsonl([0, 1].map(entry)));
  const starts = [];
  const files = createLogFiles({ file, maxBytes: 0, now: () => NOW, rotateDaily: false,
    report: error => { throw error; }, records: async function* (row, logFile, options) {
      starts.push(options.start);
      yield* records(row, logFile, options);
    } });
  await files.maintenance();
  await files.maintenance();
  assert.deepEqual(starts, [0]);
  const size = fs.statSync(file).size;
  fs.appendFileSync(file, jsonl([entry(2)]));
  await files.maintenance();
  assert.deepEqual(starts, [0, size]);
});

test('usage cache invalidates a pruned archive instead of retaining deleted records', async t => {
  const { file, log } = fixture(t, { maxEntries: 3 });
  fs.writeFileSync(archive(file), jsonl([0, 1, 2, 3, 4].map(entry)));
  const usage = createUsageSummary({ file, now: () => NOW });
  assert.equal((await usage.summarize({ range: 'all' })).totals.reqs, 5);
  await log.maintenance();
  const result = await usage.summarize({ range: 'all', dashboard: '1' });
  assert.equal(result.totals.reqs, 3);
  assert.deepEqual(result.dashboard.records.rows.map(r => r.session), ['4', '3', '2']);
});

test('startup restores the recent window without losing historical search or incrementing metrics', async t => {
  const { file, log } = fixture(t);
  fs.writeFileSync(file, jsonl(Array.from({ length: 1100 }, (_, n) => entry(n))));
  await log.restoreToday();
  await Promise.all([log.restoreRecent(), log.restoreRecent()]);
  assert.equal(log.list({ limit: 2000 }).logs.length, 1000);
  assert.equal(log.list({ limit: 2000 }).logs.at(-1).session, '100');
  assert.deepEqual((await log.listHistory({ session: '0', limit: 1000 })).logs.at(-1).session, '0');
  assert.deepEqual(log.metricsSnapshot().counters.requests, []);
  assert.equal(log.today().reqs, 1100);
});

test('age retention trims stale records inside a recently modified active or legacy file', async t => {
  const { file, log } = fixture(t, { maxEntries: 4 });
  const old = n => ({ ...entry(n), ts: '2026-10-07T23:59:59Z' });
  fs.writeFileSync(file + '.old', jsonl([old(0), entry(1)]));
  fs.writeFileSync(file, jsonl([old(2), { ...entry(3), ts: '2026-10-08T00:00:00Z' },
    { ...entry(4), status: 503 }, entry(5)]));
  await log.maintenance();
  assert.deepEqual(await sessions(log), ['5', '4', '3', '1']);
  assert.deepEqual((await log.listHistory({ status: 'err' })).logs.map(r => r.session), ['4']);
});

test('age retention rechecks cached rows when the UTC boundary advances', async t => {
  let clock = NOW;
  const { file, log } = fixture(t, { now: () => clock });
  fs.writeFileSync(file, jsonl([{ ...entry(1), ts: '2026-10-08T12:00:00Z' }, entry(2)]));
  await log.maintenance();
  assert.deepEqual(await sessions(log), ['2', '1']);
  clock += 86400000;
  await log.maintenance();
  assert.deepEqual(await sessions(log), ['2']);
});

test('failed forced rotation stops the sweep without deleting active records', async t => {
  const { file, log, errors } = fixture(t, { maxEntries: 2 });
  fs.writeFileSync(file, jsonl([0, 1, 2].map(entry)));
  const original = fs.linkSync;
  let attempts = 0;
  fs.linkSync = () => { attempts++; throw new Error('injected rotation failure'); };
  try { await log.maintenance(); }
  finally { fs.linkSync = original; }
  assert.equal(attempts, 1);
  assert.deepEqual(errors, ['rotate']);
  assert.deepEqual(await sessions(log), ['2', '1', '0']);
  await log.maintenance();
  assert.deepEqual(await sessions(log), ['2', '1']);
  assert.equal(log.storageStatus().healthy, true);
});

test('startup restores the latest 1000 after count pruning and preserves the daily counter', async t => {
  const { file, log } = fixture(t, { maxEntries: 1050 });
  fs.writeFileSync(file, jsonl(Array.from({ length: 1200 }, (_, n) => entry(n))));
  await log.restoreRecent();
  const recent = log.list({ limit: 1000 }).logs;
  assert.equal(recent.length, 1000);
  assert.equal(recent[0].session, '1199');
  assert.equal(recent.at(-1).session, '200');
  assert.equal((await log.summaryHistory()).reqs, 1050);
  assert.equal(log.today().reqs, 1200);
});

test('recent restoration merges appends before and during its snapshot exactly once', async t => {
  const { file, log } = fixture(t);
  fs.writeFileSync(file, jsonl([entry(0)]));
  log.append(entry(1));
  await log.restoreToday(); await log.flush();
  const original = fs.promises.open;
  let appended = false;
  fs.promises.open = async (...args) => {
    if (!appended && args[0] === file) { appended = true; log.append(entry(2)); }
    return original(...args);
  };
  try { await log.restoreRecent(); }
  finally { fs.promises.open = original; }
  await log.flush();
  assert.equal(appended, true);
  assert.deepEqual(log.list().logs.map(r => r.session), ['2', '1', '0']);
  assert.equal(log.today().reqs, 3);
  assert.equal(log.metricsSnapshot().counters.requests[0].count, 2);
});

test('HTTP startup exposes 1000 recent records, full history filters and the storage policy', async t => {
  const { root } = fixture(t);
  const logs = path.join(root, 'logs'), file = path.join(logs, 'requests.jsonl');
  fs.mkdirSync(logs);
  const timestamp = new Date().toISOString();
  fs.writeFileSync(file, jsonl(Array.from({ length: 1100 }, (_, n) =>
    ({ ...entry(n), ts: timestamp, ...(n === 0 ? { err_class: 'stream_aborted' } : {}) }))));
  const app = createApplication({ root: path.resolve(__dirname, '..'), version: 'test', home: root,
    env: { MIXR_DATA_DIR: root, MIXROUTER_PORT: '0', MIXUI_PORT: '0' } });
  const server = await app.listen(0, app.apiHandler);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const get = async query => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${query}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const recent = await get('/api/logs?limit=1000');
  assert.equal(recent.logs.length, 1000);
  assert.equal(recent.capacity, 1000);
  assert.equal((await get('/api/logs?status=err')).logs.length, 0);
  const historical = await get('/api/logs?history=1&status=err');
  assert.deepEqual(historical.logs.map(r => r.session), ['0']);
  assert.equal((await get('/api/stats?history=1&status=err')).ok, 0);
  const health = await get('/api/health');
  assert.equal(health.logs.retention_days, 30);
  assert.equal(health.logs.max_entries, 100000);
  assert.equal(health.logs.healthy, true);
});
