'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequestLog } = require('../lib/observability/request-log');
const { inventory } = require('../lib/observability/log-files');
const row = n => ({ session: String(n), ts: '2026-09-29T00:00:00Z' });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-rotation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'requests.jsonl') };
}
test('UTC day and size independently rotate, gzip asynchronous, modes private', async t => {
  const { root, file } = fixture(t);
  let now = Date.parse('2026-09-28T23:59:59Z');
  const log = createRequestLog({ file, now: () => now, maxBytes: 100000, compress: true, retentionDays: 0 });
  log.append(row(1)); now += 2000; log.append(row(2));
  assert.equal(inventory(file).length, 2);
  await log.flush();
  assert.equal(inventory(file).filter(r => r.gz).length, 1);
  for (const name of fs.readdirSync(root)) assert.equal(fs.statSync(path.join(root, name)).mode & 0o777, 0o600);
  assert.deepEqual((await log.listHistory()).logs.map(e => e.session), ['2', '1']);
  const size = createRequestLog({ file, maxBytes: 1, rotateDaily: false, retentionDays: 0 });
  size.append(row(3)); size.append(row(4)); await size.flush();
  assert.equal((await size.listHistory()).logs.length, 4);
});
test('retention keeps boundary day and .old; ignores unrelated files and symlinks', async t => {
  const { root, file } = fixture(t);
  const archive = day => `${file}.archive-${day}-1790640000000-aaaaaaaaaaaaaaaaaaaaaaaa`;
  for (const day of ['2026-09-26', '2026-09-27', '2026-09-28']) fs.writeFileSync(archive(day), '{}\n');
  fs.writeFileSync(`${file}.old`, '{}\n');
  const target = path.join(root, 'unrelated'); fs.writeFileSync(target, 'keep');
  fs.symlinkSync(target, archive('2026-09-25'));
  const log = createRequestLog({ file, now: () => Date.parse('2026-09-29T12:00:00Z'), retentionDays: 2 });
  await log.maintenance();
  assert.equal(fs.existsSync(archive('2026-09-26')), false);
  assert.equal(fs.existsSync(archive('2026-09-27')), true);
  assert.equal(fs.existsSync(`${file}.old`), true);
  assert.equal(fs.lstatSync(archive('2026-09-25')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});
test('rotation failure remains observable and active records survive', async t => {
  const { file } = fixture(t), errors = [];
  const log = createRequestLog({ file, maxBytes: 1, onError: (e, ctx) => errors.push(ctx.op), retentionDays: 0 });
  log.append(row(1));
  const original = fs.linkSync;
  fs.linkSync = () => { throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' }); };
  try { log.append(row(2)); } finally { fs.linkSync = original; }
  assert.deepEqual(errors, ['rotate']);
  assert.equal(log.storageStatus().healthy, false);
  assert.equal((await log.listHistory()).logs.length, 2);
  log.append(row(3)); await log.flush();
  assert.equal(log.storageStatus().healthy, true);
  assert.equal((await log.listHistory()).logs.length, 3);
});
test('active symlink is never followed, append failure visible', async t => {
  const { root, file } = fixture(t), errors = [];
  const target = path.join(root, 'target'); fs.writeFileSync(target, 'keep'); fs.symlinkSync(target, file);
  const log = createRequestLog({ file, onError: (e, ctx) => errors.push(ctx.op) });
  log.append(row(1)); await log.flush();
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep'); assert.deepEqual(errors, ['append']);
});
test('gzip corruption reports read error rather than returning partial success', async t => {
  const { file } = fixture(t), errors = [];
  fs.writeFileSync(`${file}.archive-2026-09-29-1790640000000-aaaaaaaaaaaaaaaaaaaaaaaa.gz`, 'invalid gzip');
  const log = createRequestLog({ file, onError: (e, ctx) => errors.push(ctx.op) });
  await assert.rejects(log.listHistory()); assert.deepEqual(errors, ['history']);
});

test('compression publish failure retains original archive and reports health', async t => {
  const { file } = fixture(t), errors = [];
  const archive = `${file}.archive-2026-09-29-1790640000000-aaaaaaaaaaaaaaaaaaaaaaaa`;
  fs.writeFileSync(archive, JSON.stringify(row(1)) + '\n');
  const log = createRequestLog({ file, compress: true, retentionDays: 0, onError: (e, ctx) => errors.push(ctx.op) });
  const original = fs.promises.link;
  fs.promises.link = async () => { throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' }); };
  try { await log.maintenance(); } finally { fs.promises.link = original; }
  assert.equal(fs.existsSync(archive), true);
  assert.equal(fs.existsSync(archive + '.gz'), false);
  assert.equal(log.storageStatus().healthy, false);
  assert.deepEqual(errors, ['compress']);
  assert.equal((await log.listHistory()).logs.length, 1);
  await log.maintenance();
  assert.equal(fs.existsSync(archive + '.gz'), true);
  assert.equal(log.storageStatus().healthy, true);
});
