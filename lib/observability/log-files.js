'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const DAY = 86400000;
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
function archivePattern(file) {
  return new RegExp(`^${escape(path.basename(file))}\\.archive-(\\d{4}-\\d{2}-\\d{2})-(\\d{13})-([a-f0-9]{24})(\\.gz)?$`);
}
function inventory(file) {
  if (!file) return [];
  const dir = path.dirname(file), base = path.basename(file), pattern = archivePattern(file);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const files = [];
  for (const name of names) {
    const match = pattern.exec(name);
    // During atomic compression publication both names briefly exist: count the raw inode once.
    if (name.endsWith('.gz') && names.includes(name.slice(0, -3))) continue;
    if (name !== base && name !== `${base}.old` && !match) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(full); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (!st.isFile() || st.isSymbolicLink()) continue;
    files.push({ name, full, dev: st.dev, ino: st.ino, size: st.size, mtime: st.mtimeMs,
      gz: name.endsWith('.gz'), day: match ? match[1] : null,
      order: name === base ? '2' : name === `${base}.old` ? '0' : `1${match[2]}${match[3]}` });
  }
  return files.sort((a, b) => a.order.localeCompare(b.order));
}

// No timers or I/O on construction. Legacy .old is read-only: it is neither overwritten nor pruned.
function createLogFiles({ file, maxBytes, now, report, retentionDays = 30, compress = false, rotateDaily = true }) {
  const retention = Number(retentionDays);
  if (!Number.isFinite(retention) || retention < 0) throw new TypeError('retentionDays must be >= 0');
  let day = null, pending = Promise.resolve(), scheduled = false;
  let lastRotation = 0;
  const errors = new Map();
  const notify = (e, op) => { errors.set(op, e.message); report(e, op); };
  async function maintain() {
    if (!file) return;
    let rows;
    try { rows = inventory(file); } catch (e) { notify(e, 'retention'); return; }
    const cutoff = Date.parse(`${dayOf(now())}T00:00:00Z`) - retention * DAY;
    for (const row of rows) {
      if (!row.day) continue;
      try {
        const st = await fs.promises.lstat(row.full);
        if (!st.isFile() || st.isSymbolicLink() || st.ino !== row.ino || st.dev !== row.dev) continue;
        // The boundary day is retained in full; UTC calendar dates, not rolling 24-hour windows.
        if (retention > 0 && Date.parse(`${row.day}T00:00:00Z`) < cutoff) {
          await fs.promises.unlink(row.full);
          errors.delete('retention');
          continue;
        }
        if (compress && !row.gz) {
          const temp = `${row.full}.${crypto.randomBytes(12).toString('hex')}.tmp`;
          let source;
          try {
            source = await fs.promises.open(row.full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const current = await source.stat();
            if (current.ino !== row.ino || current.dev !== row.dev) continue;
            await pipeline(source.createReadStream({ autoClose: false }), zlib.createGzip(),
              fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
            // link is exclusive, unlike rename: never overwrite an existing archive.
            await fs.promises.link(temp, `${row.full}.gz`);
            try { await fs.promises.unlink(row.full); }
            catch (e) { await fs.promises.unlink(`${row.full}.gz`); throw e; }
            errors.delete('compress');
          } finally {
            if (source) await source.close();
            await fs.promises.unlink(temp).catch(e => { if (e.code !== 'ENOENT') notify(e, 'compress'); });
          }
        }
      } catch (e) { notify(e, compress ? 'compress' : 'retention'); }
    }
  }
  function maintenance() {
    pending = pending.then(maintain).catch(e => notify(e, 'maintenance'));
    return pending;
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    // gzip and directory pruning never execute synchronously on the append hot path.
    pending = pending.then(async () => { try { await maintain(); } finally { scheduled = false; } });
  }
  function beforeAppend() {
    let st;
    try { st = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (st && (!st.isFile() || st.isSymbolicLink())) throw new Error('Refusing non-regular active log');
    const today = dayOf(now());
    if (day === null) day = st ? dayOf(st.mtimeMs) : today;
    if (st && st.size && ((rotateDaily && day !== today) || (maxBytes > 0 && st.size > maxBytes))) {
      try {
        const stamp = Math.max(Math.floor(now()), lastRotation + 1);
        const archive = `${file}.archive-${day}-${String(stamp).padStart(13, '0')}-${crypto.randomBytes(12).toString('hex')}`;
        // Exclusive hard-link + unlink avoids rename's overwrite behavior. If unlink fails,
        // remove our link and continue writing the original active file.
        fs.linkSync(file, archive);
        try { fs.unlinkSync(file); } catch (e) { fs.unlinkSync(archive); throw e; }
        lastRotation = stamp;
        day = today;
        errors.delete('rotate');
      } catch (e) { notify(e, 'rotate'); }
    } else if (!st || !st.size) day = today;
    schedule();
  }
  return { beforeAppend, maintenance, flush: () => pending,
    status: () => ({ healthy: errors.size === 0, errors: Object.fromEntries(errors),
      rotation: rotateDaily ? 'daily-and-size' : 'size', retention_days: retention, compress: !!compress, timezone: 'UTC' }) };
}
module.exports = { inventory, createLogFiles, archivePattern, dayOf };
