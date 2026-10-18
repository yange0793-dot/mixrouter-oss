'use strict';
// 运行期日志清理:**只管子进程活得比日志长的那些产物**。
//
//   · logs/responses/<13位毫秒>-<32位hex>/ —— 每次上游尝试的响应正文归档。
//     一个目录就是一次尝试,写完即定型,不存在"边写边清"的竞争。**按目录名里的时间戳判龄**,
//     不受目录内文件被补写刷新 mtime 的影响。这是占用的大头(实测本机 4000+ 个目录 / 1.1GB)。
//   · logs/launchd.log —— launchd 把服务的 stdout/stderr 重定向到这里,append 模式,
//     生命周期跨重启,没人管就是无限长。按**行首 ISO 时间戳**逐行过滤。
//
// 为什么 launchd.log 用原地 ftruncate 而不是原子 rename:
//   launchd 在 spawn 时就把它的写 fd(O_APPEND)dup 给了子进程。rename 会把那个 fd 留在一个
//   被丢弃的旧 inode 上,之后服务端的 stdout 会静默写进一个谁也看不见的文件。所以原地截断回写。
//
// 为什么 responses 目录要限量删除:
//   一次 3GB 级积压(两万多个目录)会让单次 rmSync 循环跑十几秒,把**服务进程的事件循环**
//   整个占住 —— 而用户的请求正走在这个进程上。默认每轮最多删 2000 个,单次卡顿压到 1s 级;
//   剩下的靠"起跑追赶"(见 mixrouter.js 的 retentionTick)在后续几轮清完。
//
// 为什么不碰 requests.jsonl:
//   它由 lib/observability/log-files.js 按天轮转 + 按天数删归档 + 可选 gzip 管理,那是另一套
//   有意为之的设计(轮转后整份归档,判龄用文件名里的日期)。两套机制同时动一个文件必然打架,
//   所以这里明确不管它。requests.jsonl.old 是更早的遗留轮转文件,只读、不清。
//
// require 零副作用:不建目录、不起定时器、不读盘。

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_RETAIN_DAYS = 2;
// 归档目录名 = `${Date.now()}-${randomBytes(16).toString('hex')}`
// (见 lib/observability/response-archive.js),即 13 位毫秒时间戳 + 32 位小写 hex。
// 宽一个字符都可能误伤别的目录,这里按实际形态钉死;不匹配的一律跳过。
const ARCHIVE_ID = /^[0-9]{13}-[0-9a-f]{32}$/;
// launchd.log 的行首时间戳:允许一个 `[tag] ` 前缀(如 `[uncaught] 2026-…`)。
// 锚到行首是为了不把某个正文里恰好出现的旧日期当成年份判据,从而误删一整行。
const HEAD_ISO = /^(?:\[[^\]]{0,40}\]\s*)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;
const LOCK_NAME = '.retention.lock';
const LOCK_STALE_MS = 10 * 60 * 1000;

const positiveInt = (value, fallback, min = 0) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min ? n : fallback;
};
const statOrNull = file => { try { return fs.lstatSync(file); } catch { return null; } };

function textLineAge(line) {
  const m = HEAD_ISO.exec(line);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

function filterTextByAge(file, cutoff, ageOfLine) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const kept = [];
  let dropped = 0;
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    const ts = ageOfLine(line);
    if (ts !== null && ts < cutoff) { dropped++; continue; }
    kept.push(line);
  }
  return { text: kept.length ? kept.join('\n') + '\n' : '', kept: kept.length, dropped };
}

// launchd.log 专用:原地 ftruncate + 回写。保留 inode,不把继承去的 O_APPEND fd 飘走(见文件头)。
function truncateFileByAge(file, cutoff, ageOfLine, { dryRun = false } = {}) {
  const stat = statOrNull(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return { present: false };
  const filtered = filterTextByAge(file, cutoff, ageOfLine);
  if (!filtered) return { present: false };
  if (filtered.dropped === 0) return { kept: filtered.kept, dropped: 0, rewritten: false };
  if (dryRun) return { kept: filtered.kept, dropped: filtered.dropped, rewritten: false };
  let fd = null;
  try {
    fd = fs.openSync(file, 'r+');
    fs.ftruncateSync(fd, 0);
    if (filtered.text) {
      const buf = Buffer.from(filtered.text);
      fs.writeSync(fd, buf, 0, buf.length, 0);
    }
    fs.fsyncSync(fd);
  } catch { return { kept: filtered.kept, dropped: filtered.dropped, rewritten: false, error: 'truncate' }; }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch {} }
  return { kept: filtered.kept, dropped: filtered.dropped, rewritten: true };
}

function dirBytes(dir) {
  let total = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    const st = statOrNull(path.join(dir, name));
    if (st && st.isFile()) total += st.size;
  }
  return total;
}

function sweepArchive(dir, cutoff, dryRun, limit = 0) {
  const dirStat = statOrNull(dir);
  if (!dirStat || !dirStat.isDirectory() || dirStat.isSymbolicLink()) return { present: false };
  let names;
  try { names = fs.readdirSync(dir); } catch { return { present: false }; }
  let removed = 0, bytes = 0, skipped = 0, truncated = false;
  for (const name of names) {
    if (!ARCHIVE_ID.test(name)) { skipped++; continue; }        // 非本模块产物:一律不碰
    const st = statOrNull(path.join(dir, name));
    if (!st || !st.isDirectory() || st.isSymbolicLink()) { skipped++; continue; }
    if (Number(name.slice(0, 13)) >= cutoff) continue;          // 名字里的毫秒时间戳在窗内,留
    const full = path.join(dir, name);
    const size = dirBytes(full);
    if (!dryRun) {
      try { fs.rmSync(full, { recursive: true, force: true }); }
      catch { return { removed, bytes, skipped, error: 'rm' }; }
    }
    removed++; bytes += size;
    if (limit && removed >= limit) { truncated = true; break; } // 单轮限额,剩下的下一轮继续
  }
  return { removed, bytes, skipped, truncated };
}

// 抢锁:wx 建锁文件并写 pid+时间;已存在且未过期 → 返回 null(本轮跳过)。
// 过期(>10min)或持有者进程已死 → 视为残留锁,删除后重试一次。
// 非 EEXIST 的建锁失败(权限/IO/EACCES 等)一律 fail-closed 返回 null,绝不返回「空 release」
// 放行 —— 那等于在没拿到锁的情况下并发清理,正是要防的事。宁可本轮跳过,不赌。
function acquireLock(directory, now) {
  const file = path.join(directory, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now() })); } finally { fs.closeSync(fd); }
      return () => { try { fs.unlinkSync(file); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') return null;   // fail-closed:拿不到锁就不清,不放行
      const st = statOrNull(file);
      const held = readLock(file);
      const stale = !st || (now() - (held.at || 0) > LOCK_STALE_MS) || (held.pid && !alive(held.pid));
      if (!stale || attempt === 1) return null;
      try { fs.unlinkSync(file); } catch {}
    }
  }
  return null;
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// 一次性清理入口。可被服务内定时器与 `mixctl gc` 同时调用,靠锁串行。
// 返回结构化摘要(供 CLI 打印与测试断言);任何单个目标的失败都只记进 errors,不抛。
function sweepLogs(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const retainDays = positiveInt(options.retainDays, DEFAULT_RETAIN_DAYS, 0);
  const dryRun = options.dryRun === true;
  const useLock = options.lock !== false;
  // 只清归档时跳过活跃的 launchd.log;requests 日志始终由 log-files 管理。
  const archiveOnly = options.archiveOnly === true;
  const directory = path.resolve(String(options.directory || path.join(process.env.MIXR_DATA_DIR || process.cwd(), 'logs')));
  const launchdFile = options.launchdFile || path.join(directory, 'launchd.log');
  const archiveDir = options.archiveDir || path.join(directory, 'responses');

  const startedAt = now();
  const archiveLimit = Number.isSafeInteger(options.maxRemovalsPerSweep) && options.maxRemovalsPerSweep >= 0
    ? options.maxRemovalsPerSweep : 2000;
  const result = { directory, retain_days: retainDays, cutoff: new Date(startedAt - retainDays * DAY_MS).toISOString(),
    dry_run: dryRun, archive_only: archiveOnly, requests: null, rotation: null, launchd: null, responses: null, errors: [] };
  if (retainDays <= 0) { result.skipped = 'disabled'; return result; }
  const dirStat = statOrNull(directory);
  if (!dirStat || !dirStat.isDirectory() || dirStat.isSymbolicLink()) { result.skipped = 'no_dir'; return result; }
  const cutoff = startedAt - retainDays * DAY_MS;

  let releaseLock = () => {};
  if (useLock && !dryRun) {
    releaseLock = acquireLock(directory, now);
    if (!releaseLock) { result.skipped = 'locked'; return result; }
  }
  try {
    const guard = (name, fn) => { try { result[name] = fn(); } catch (e) { result.errors.push(`${name}:${e.code || e.message}`); } };
    guard('launchd', () => archiveOnly ? null : truncateFileByAge(launchdFile, cutoff, textLineAge, { dryRun }));
    guard('responses', () => sweepArchive(archiveDir, cutoff, dryRun, archiveLimit));
  } finally { releaseLock(); }
  return result;
}

module.exports = {
  sweepLogs, filterTextByAge, truncateFileByAge, acquireLock, textLineAge,
  DEFAULT_RETAIN_DAYS, DAY_MS, ARCHIVE_ID, LOCK_NAME, LOCK_STALE_MS,
};
