'use strict';
// 运行期日志清理的行为回归(responses 归档目录 + launchd.log)。
// 全部只用 mkdtemp 临时目录 + 本机内存:不碰现役 logs/、不碰真实配置、不连上游、不删任何生产日志。
//
// requests.jsonl 的清理**不在这里**:它由 request-log/log-files 那套按天轮转管理,
// 本模块明确不碰它。上面那条边界由 test/log-rotation.test.js 与这里的
// 「不碰 requests.jsonl」用例各自从一侧钉住。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  sweepLogs, truncateFileByAge, acquireLock, textLineAge,
  DAY_MS, ARCHIVE_ID, LOCK_NAME,
} = require('../lib/log-retention');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-retention-'));
const iso = ms => new Date(ms).toISOString();
const NOW = Date.parse('2026-10-06T12:00:00.000Z');
// 明确早于 2 天窗:用 3 天前
const OLD = iso(NOW - 3 * DAY_MS);
const FRESH = iso(NOW - 1 * DAY_MS);
const line = ts => JSON.stringify({ ts, app: 'claude', session: 'FAKE-s', status: 200 });
const archiveName = (ms, hex = 'a'.repeat(32)) => `${ms}-${hex}`;

test('textLineAge:行首 ISO 才算;支持 [tag] 前缀;正文里的日期不算', () => {
  assert.equal(textLineAge(`2026-10-06T12:00:00.000Z hello`), Date.parse('2026-10-06T12:00:00.000Z'));
  assert.equal(textLineAge(`[uncaught] 2026-10-06T12:00:00.000Z boom`), Date.parse('2026-10-06T12:00:00.000Z'));
  assert.equal(textLineAge('stack trace at 2026-10-06T12:00:00.000Z'), null, '正文里的日期不得当成年份判据');
  assert.equal(textLineAge('no timestamp here'), null);
});

test('launchd.log:原地截断保留 inode(不 rename,继承的 fd 不飘走)', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'launchd.log');
  fs.writeFileSync(file, [`${OLD} old boot`, `${FRESH} fresh boot`].join('\n') + '\n');
  const inoBefore = fs.statSync(file).ino;
  const r = truncateFileByAge(file, NOW - 2 * DAY_MS, textLineAge);
  assert.equal(r.dropped, 1);
  assert.equal(r.kept, 1);
  assert.equal(fs.statSync(file).ino, inoBefore, '必须是原地写, inode 不变');
  assert.match(fs.readFileSync(file, 'utf8'), /fresh boot/);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /old boot/);
});

test('符号链接不跟随:链接目标不被当作日志处理', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, 'real.log');
  fs.writeFileSync(real, `${OLD} old boot\n`);
  const link = path.join(root, 'launchd.log');
  try { fs.symlinkSync(real, link); } catch { return t.skip('本机不支持 symlink'); }
  const r = truncateFileByAge(link, NOW - 2 * DAY_MS, textLineAge);
  assert.equal(r.present, false, '符号链接应被跳过');
  assert.match(fs.readFileSync(real, 'utf8'), /old boot/, '链接目标不得被改动');
});

test('sweepLogs:端到端清旧留新,且只碰本模块产物', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'launchd.log'), [`${OLD} boot`, `${FRESH} boot2`].join('\n') + '\n');
  // 归档目录:两个超期(删除)、一个窗内(保留)、一个非本模块产物(跳过)
  const resp = path.join(logs, 'responses');
  fs.mkdirSync(path.join(resp, archiveName(NOW - 3 * DAY_MS)), { recursive: true });
  fs.writeFileSync(path.join(resp, archiveName(NOW - 3 * DAY_MS), 'raw-response.bin'), 'x'.repeat(1024));
  fs.mkdirSync(path.join(resp, archiveName(NOW - 5 * DAY_MS)), { recursive: true });
  fs.mkdirSync(path.join(resp, archiveName(NOW - 1 * DAY_MS)), { recursive: true });
  fs.mkdirSync(path.join(resp, 'not-an-archive'), { recursive: true });

  const r = sweepLogs({ directory: logs, retainDays: 2, now: () => NOW });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.responses.removed, 2, '两个超期归档应删除');
  assert.ok(r.responses.bytes >= 1024);
  assert.equal(r.responses.skipped, 1, '非本模块产物应跳过');
  assert.equal(fs.existsSync(path.join(resp, archiveName(NOW - 1 * DAY_MS))), true, '窗内归档保留');
  assert.equal(fs.existsSync(path.join(resp, 'not-an-archive')), true, '无关目录不得被删');
  assert.doesNotMatch(fs.readFileSync(path.join(logs, 'launchd.log'), 'utf8'), /old/, 'launchd.log 旧行清掉');
});

test('不碰 requests.jsonl:那是 log-files 轮转的地盘', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  // 两份超期内容:若误管,它们会被改写/删除
  const reqBody = [line(OLD), line(FRESH)].join('\n') + '\n';
  fs.writeFileSync(path.join(logs, 'requests.jsonl'), reqBody);
  fs.writeFileSync(path.join(logs, 'requests.jsonl.old'), line(OLD) + '\n');

  const r = sweepLogs({ directory: logs, retainDays: 2, now: () => NOW });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  // 逐字节校验,防止「静默重写但内容碰巧相同」
  assert.equal(fs.readFileSync(path.join(logs, 'requests.jsonl'), 'utf8'), reqBody, 'requests.jsonl 必须逐字节不动');
  assert.equal(fs.readFileSync(path.join(logs, 'requests.jsonl.old'), 'utf8'), line(OLD) + '\n', '.old 必须逐字节不动');
});

test('dryRun:只报数不动盘', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'launchd.log'), `${OLD} boot\n`);
  const resp = path.join(logs, 'responses');
  fs.mkdirSync(path.join(resp, archiveName(NOW - 3 * DAY_MS)), { recursive: true });
  const r = sweepLogs({ directory: logs, retainDays: 2, now: () => NOW, dryRun: true });
  assert.equal(r.dry_run, true);
  assert.equal(r.launchd.dropped, 1);
  assert.equal(fs.existsSync(path.join(resp, archiveName(NOW - 3 * DAY_MS))), true, 'dryRun 不得删目录');
  assert.match(fs.readFileSync(path.join(logs, 'launchd.log'), 'utf8'), /old|boot/, 'dryRun 不得改文件');
});

test('retainDays<=0 视为关闭:不碰任何文件', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'launchd.log'), `${OLD} boot\n`);
  const r = sweepLogs({ directory: logs, retainDays: 0, now: () => NOW });
  assert.equal(r.skipped, 'disabled');
  assert.match(fs.readFileSync(path.join(logs, 'launchd.log'), 'utf8'), /old|boot/);
});

test('目录不存在:跳过,不抛', () => {
  const r = sweepLogs({ directory: path.join(os.tmpdir(), 'mixr-nope-' + Date.now()), retainDays: 2, now: () => NOW });
  assert.equal(r.skipped, 'no_dir');
});

test('单轮限额:超期归档多于上限时只删到上限并标记 truncated(其余下一轮继续)', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = path.join(root, 'logs');
  const resp = path.join(logs, 'responses');
  for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(resp, archiveName(NOW - (3 + i) * DAY_MS, String(i).padStart(32, 'a'))), { recursive: true });
  const r = sweepLogs({ directory: logs, retainDays: 2, now: () => NOW, maxRemovalsPerSweep: 2 });
  assert.equal(r.responses.removed, 2, '本轮到上限即停');
  assert.equal(r.responses.truncated, true, '未清完必须标记,调度器据此短周期追赶');
  assert.equal(fs.readdirSync(resp).length, 3, '剩下的留到下一轮,不丢也不漏');
});

test('锁:并发时第二个实例跳过本轮;残留锁可被回收', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = acquireLock(root, () => NOW);
  assert.equal(typeof first, 'function');
  assert.equal(acquireLock(root, () => NOW), null, '锁被持有则应拿不到');
  first();
  // 残留锁:持有者进程已死 + 超时 → 回收
  fs.writeFileSync(path.join(root, LOCK_NAME), JSON.stringify({ pid: 999999, at: NOW - 20 * 60 * 1000 }));
  const reclaimed = acquireLock(root, () => NOW);
  assert.equal(typeof reclaimed, 'function', '过期/死进程的残留锁应被回收');
  reclaimed();
});

test('ARCHIVE_ID 只认 13 位毫秒+32 位 hex;名字越界一律不匹配', () => {
  assert.equal(ARCHIVE_ID.test(archiveName(NOW)), true);
  assert.equal(ARCHIVE_ID.test(`${NOW}-${'A'.repeat(32)}`), false, '大写 hex 不匹配');
  assert.equal(ARCHIVE_ID.test(`${NOW}-short`), false);
  assert.equal(ARCHIVE_ID.test('responses'), false);
  assert.equal(ARCHIVE_ID.test(`${NOW}-${'a'.repeat(31)}`), false);
});

test('archiveOnly:只清 responses 归档,requests/.old/launchd 一律不动', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const reqBody = [line(OLD), line(FRESH)].join('\n') + '\n';
  const oldBody = line(OLD) + '\n';
  const launchdBody = `${OLD} boot\n`;
  fs.writeFileSync(path.join(logs, 'requests.jsonl'), reqBody);
  fs.writeFileSync(path.join(logs, 'requests.jsonl.old'), oldBody);
  fs.writeFileSync(path.join(logs, 'launchd.log'), launchdBody);
  const resp = path.join(logs, 'responses');
  fs.mkdirSync(path.join(resp, archiveName(NOW - 3 * DAY_MS)), { recursive: true });
  fs.mkdirSync(path.join(resp, archiveName(NOW - 1 * DAY_MS)), { recursive: true });
  const r = sweepLogs({ directory: logs, retainDays: 2, now: () => NOW, archiveOnly: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.archive_only, true);
  assert.equal(r.requests, null);
  assert.equal(r.rotation, null);
  assert.equal(r.launchd, null);
  assert.equal(r.responses.removed, 1);
  assert.equal(fs.existsSync(path.join(resp, archiveName(NOW - 3 * DAY_MS))), false);
  assert.equal(fs.existsSync(path.join(resp, archiveName(NOW - 1 * DAY_MS))), true);
  assert.equal(fs.readFileSync(path.join(logs, 'requests.jsonl'), 'utf8'), reqBody);
  assert.equal(fs.readFileSync(path.join(logs, 'requests.jsonl.old'), 'utf8'), oldBody);
  assert.equal(fs.readFileSync(path.join(logs, 'launchd.log'), 'utf8'), launchdBody);
});

test('acquireLock fail-closed:非 EEXIST 的建锁失败返回 null(不放行)', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // 目录不存在 → openSync 抛 ENOENT(非 EEXIST)——必须返回 null,而不是一个空 release
  const missing = path.join(root, 'nope');
  assert.equal(acquireLock(missing, () => NOW), null, '拿不到锁就必须跳过,不得放行并发清理');
});
