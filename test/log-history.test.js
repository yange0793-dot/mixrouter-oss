'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequestLog } = require('../lib/observability/request-log');
const { parseLogsArgs, runLogs } = require('../lib/cli/logs');
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-history-'));
  const file = path.join(root, 'requests.jsonl');
  const log = createRequestLog({ file, retentionDays: 0, ...options });
  t.after(async () => { await log.flush(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, log };
}
const entry = n => ({ ts: '2026-09-29T01:00:00Z', session: String(n), status: 200 });
test('same timestamp pages keep snapshot across append and rotation; restart reads disk', async t => {
  const { file, log } = fixture(t, { maxBytes: 180 });
  for (let n = 0; n < 12; n++) log.append(entry(n));
  let page = await log.listHistory({ limit: 3 });
  const all = page.logs.map(e => e.session);
  for (let n = 12; n < 30; n++) log.append(entry(n));
  while (page.next_cursor) {
    page = await log.listHistory({ limit: 3, cursor: page.next_cursor });
    all.push(...page.logs.map(e => e.session));
  }
  assert.deepEqual(all, Array.from({ length: 12 }, (_, i) => String(11 - i)));
  const fresh = createRequestLog({ file });
  assert.equal((await fresh.listHistory({ limit: 100 })).logs.length, 30);
  assert.equal(fresh.list().logs.length, 0);
  const token = (await log.listHistory({ limit: 1 })).next_cursor;
  await assert.rejects(fresh.listHistory({ cursor: token }), { code: 'CURSOR_EXPIRED' });
});
test('legacy, gzip, bad and oversize lines: streaming read re-applies whitelist and secrets', async t => {
  const { file, root, log } = fixture(t, { secrets: ['FAKE-KEY'] });
  fs.writeFileSync(`${file}.old`, JSON.stringify({ ...entry(0), prompt: 'private', err: 'FAKE-KEY' }) + '\nBAD\n' + 'x'.repeat(1024 * 1024 + 10) + '\n');
  const archive = `${file}.archive-2026-09-29-1790640000000-aaaaaaaaaaaaaaaaaaaaaaaa.gz`;
  fs.writeFileSync(archive, zlib.gzipSync(JSON.stringify(entry(1)) + '\n'));
  fs.writeFileSync(file, JSON.stringify(entry(2)) + '\n' + JSON.stringify(entry(3)));
  const page = await log.listHistory();
  assert.deepEqual(page.logs.map(e => e.session), ['2', '1', '0']);
  assert.equal(page.skipped, 2);
  assert.equal(page.logs[2].err, '[redacted]');
  assert.ok(!JSON.stringify(page).includes('private'));
  assert.equal(fs.readdirSync(root).length, 3);
});
test('cursors reject tampering, changed filters, TTL expiry and deleted snapshots', async t => {
  let now = Date.now();
  const { log, file } = fixture(t, { now: () => now });
  log.append(entry(1)); log.append(entry(2));
  let page = await log.listHistory({ limit: 1 });
  await assert.rejects(log.listHistory({ cursor: 'nonsense' }), { code: 'CURSOR_INVALID' });
  await assert.rejects(log.listHistory({ cursor: page.next_cursor + 'x' }), { code: 'CURSOR_INVALID' });
  await assert.rejects(log.listHistory({ cursor: page.next_cursor, app: 'codex' }), { code: 'CURSOR_INVALID' });
  now += 16 * 60 * 1000;
  await assert.rejects(log.listHistory({ cursor: page.next_cursor }), { code: 'CURSOR_EXPIRED' });
  page = await log.listHistory({ limit: 1 }); fs.unlinkSync(file);
  await assert.rejects(log.listHistory({ cursor: page.next_cursor }), { code: 'CURSOR_EXPIRED' });
});
test('until and since boundaries identical across memory and history', async t => {
  const { log } = fixture(t);
  log.append(entry(1)); log.append({ ...entry(2), ts: '2026-09-30T00:00:00Z' }); log.append({ session: 'bad' });
  const query = { since: entry(1).ts, until: entry(1).ts };
  assert.equal(log.list(query).matched, 1);
  assert.equal((await log.listHistory(query)).logs.length, 1);
  assert.equal(log.summary(query).reqs, 1);
  assert.equal((await log.summaryHistory(query)).reqs, 1);
  assert.equal((await log.listHistory({ until: 'invalid' })).logs.length, 3);
});
test('CLI positional count and full query options, json and errors', async () => {
  const parsed = parseLogsArgs(['7', '--history', '--since=2026-09-29', '--until', '2026-09-30', '--json']);
  assert.equal(parsed.query.get('limit'), '7'); assert.equal(parsed.history, true);
  let output = '', error = '', url;
  assert.equal(await runLogs(['--cursor', 'abc', '--json'], { request: async u => { url = u; return { logs: [] }; },
    stdout: { write: s => output += s }, stderr: { write: s => error += s } }), 0);
  assert.match(url, /history=1/); assert.deepEqual(JSON.parse(output), { logs: [] }); assert.equal(error, '');
  assert.throws(() => parseLogsArgs(['--since']), /Missing/);
  assert.equal(await runLogs(['--bogus'], { stderr: { write() {} } }), 1);
});

test('rotation between inventory and file open follows snapshot inode', async t => {
  const { file, log } = fixture(t, { maxBytes: 1 });
  log.append(entry(1));
  const original = fs.promises.open;
  let injected = false;
  fs.promises.open = async function(name, ...args) {
    if (!injected && name === file) { injected = true; log.append(entry(2)); }
    return original.call(this, name, ...args);
  };
  try {
    const page = await log.listHistory();
    assert.deepEqual(page.logs.map(e => e.session), ['1']);
  } finally { fs.promises.open = original; }
});

test('secret source failure never leaks through disk, ring, historical reads or warnings', async t => {
  const warnings = [];
  const { file, log } = fixture(t, { secrets: () => { throw new Error('FAKE-SENSITIVE'); },
    onError: (e, ctx) => warnings.push({ message: e.message, op: ctx.op }) });
  log.append({ ...entry(1), err: 'FAKE-SENSITIVE', model_in: { nested: 'FAKE-SENSITIVE' }, in: 7 });
  const page = await log.listHistory();
  assert.equal(page.logs[0].in, 7);
  assert.equal(page.logs[0].err_class, 'secret_source');
  for (const text of [JSON.stringify(log.list()), fs.readFileSync(file, 'utf8'), JSON.stringify(page), JSON.stringify(warnings)])
    assert.equal(text.includes('FAKE-SENSITIVE'), false);
  assert.ok(warnings.some(w => w.op === 'secret_source'));
});
test('no-secret cyclic containers remain bounded and do not interrupt logging', async t => {
  const { file, log } = fixture(t);
  const cycle = {}; cycle.self = cycle;
  log.append({ ...entry(1), model_in: cycle });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).model_in.self, '[circular]');
  assert.equal((await log.listHistory()).logs.length, 1);
});

test('local effort and err_class increments compose with historical query', async t => {
  const { log } = fixture(t);
  log.append({ ...entry(1), effort: 'high', err_class: 'stream_aborted', err: 'interrupted' });
  log.append(entry(2));
  const q = { err_class: 'STREAM', since: entry(1).ts, until: entry(1).ts };
  assert.equal((await log.listHistory(q)).logs[0].effort, 'high');
  assert.equal((await log.summaryHistory(q)).reqs, 1);
  assert.equal(log.summary(q).reqs, 1);
  assert.equal(parseLogsArgs(['--err_class', 'stream']).query.get('err_class'), 'stream');
});
