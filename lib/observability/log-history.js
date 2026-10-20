'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { inventory } = require('./log-files');
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_PAGE = 1000;
const MAX_FILES = 4096;
const CURSOR_TTL = 15 * 60 * 1000;
const failure = (code, message) => Object.assign(new Error(message), { code });
// 游标类错误码 → HTTP 状态。**归这里**:码是本模块抛的,调用方(控制台 /api/logs、
// /api/stats)以前各自手抄一份同样的映射表,码一增就漏一处。
// 返回 0 表示"不是本模块的码",调用方应原样抛出而不是吞掉。
const HTTP_STATUS_OF = { CURSOR_INVALID: 400, CURSOR_EXPIRED: 410, HISTORY_LIMIT: 422 };
const cursorHttpStatus = code => HTTP_STATUS_OF[code] || 0;

// Bound both compressed input and individual decompressed JSONL lines. Unterminated tails
// are excluded from the snapshot, even if a concurrent append later completes that line.
//
// options.start(字节偏移)只给**增量读取**用(用量统计的进程内缓存):调用方保证 start
// 落在行边界上(上一次读到最后一个换行之后)。每行额外带 `end` —— 文件内绝对字节偏移,
// 指向该行换行符之后;压缩文件没有可用的字节偏移,给 null。既有调用方只解构 value/line,
// 多一个键不影响。
async function* records(row, file, options) {
  const firstByte = options && Number.isInteger(options.start) && options.start > 0 ? options.start : 0;
  let handle;
  // A rename can happen between inventory and open. Retry by inode, never by timestamp.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      handle = await fs.promises.open(row.full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const st = await handle.stat();
      if (st.isFile() && st.dev === row.dev && st.ino === row.ino && st.size >= row.size) break;
      await handle.close(); handle = null;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const found = file && inventory(file).find(r => r.dev === row.dev && r.ino === row.ino && r.gz === row.gz);
    if (!found) throw failure('CURSOR_EXPIRED', 'Log snapshot file was replaced or truncated');
    row = { ...row, full: found.full };
  }
  if (!handle) throw failure('CURSOR_EXPIRED', 'Log snapshot changed during open');
  let input, stream;
  try {
    if (!row.size || firstByte >= row.size) return;
    input = handle.createReadStream({ start: firstByte, end: row.size - 1, highWaterMark: 65536, autoClose: false });
    stream = row.gz ? input.pipe(zlib.createGunzip()) : input;
    if (row.gz) input.on('error', e => stream.destroy(e));
    let pieces = [], size = 0, oversized = false, line = 0;
    // 仅普通文件的绝对字节游标;gz 走解压流,位置对不上文件字节,给 null。
    let absolute = firstByte;
    for await (const chunk of stream) {
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 10) continue;
        const part = chunk.subarray(start, i);
        size += part.length;
        const end = row.gz ? null : absolute + i + 1;
        if (!oversized && size <= MAX_LINE_BYTES) {
          pieces.push(part);
          let value;
          try { value = JSON.parse(Buffer.concat(pieces, size).toString('utf8')); } catch {}
          yield { value: value && typeof value === 'object' && !Array.isArray(value) ? value : null, line, end };
        } else yield { value: null, line, end };
        line++;
        pieces = []; size = 0; oversized = false; start = i + 1;
      }
      if (start < chunk.length) {
        const part = chunk.subarray(start);
        size += part.length;
        if (size > MAX_LINE_BYTES) { pieces = []; oversized = true; }
        else if (!oversized) pieces.push(part);
      }
      if (!row.gz) absolute += chunk.length;
    }
  } finally {
    if (stream) stream.destroy();
    if (input) input.destroy();
    await handle.close();
  }
}

function createHistory({ file, now, pick, buildQuery, matchesQuery, normalizeLimit, report }) {
  // Tokens reference bounded in-process manifests, not paths supplied by the client. They expire
  // explicitly after restart/TTL/eviction. Starting a NEW history query works after restart.
  const snapshots = new Map();
  const key = crypto.randomBytes(32);
  const signature = text => crypto.createHmac('sha256', key).update(text).digest('base64url');
  const encode = body => {
    const text = Buffer.from(JSON.stringify(body)).toString('base64url');
    return `${text}.${signature(text)}`;
  };
  const decode = token => {
    if (typeof token !== 'string' || token.length > 2048 || !/^[\w-]+\.[\w-]+$/.test(token))
      throw failure('CURSOR_INVALID', 'Malformed history cursor');
    const [text, sig] = token.split('.');
    let body;
    try { body = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')); } catch { throw failure('CURSOR_INVALID', 'Malformed history cursor'); }
    if (!body || typeof body.id !== 'string' || !Number.isSafeInteger(body.f) || !Number.isSafeInteger(body.l) || body.f < 0 || body.l < 0)
      throw failure('CURSOR_INVALID', 'Malformed history cursor');
    if (!snapshots.has(body.id)) throw failure('CURSOR_EXPIRED', 'History cursor expired; start a new query');
    if (sig !== signature(text)) throw failure('CURSOR_INVALID', 'Invalid history cursor signature');
    return body;
  };
  function start(query = {}) {
    const q = buildQuery(query), fingerprint = JSON.stringify(q);
    for (const [id, s] of snapshots) if (s.expires <= now()) snapshots.delete(id);
    let state, before = null;
    if (query.cursor) {
      before = decode(query.cursor);
      state = snapshots.get(before.id);
      if (state.fingerprint !== fingerprint) throw failure('CURSOR_INVALID', 'Cursor filters must remain unchanged');
      if (before.f >= state.files.length) throw failure('CURSOR_INVALID', 'Invalid cursor position');
    } else {
      const files = inventory(file);
      if (files.length > MAX_FILES) throw failure('HISTORY_LIMIT', `History exceeds ${MAX_FILES} files; reduce archive count`);
      const id = crypto.randomBytes(18).toString('base64url');
      state = { id, files, fingerprint, captured: new Date(now()).toISOString(), expires: now() + CURSOR_TTL };
      if (snapshots.size >= 32) snapshots.delete(snapshots.keys().next().value);
      snapshots.set(id, state);
    }
    // Rotation preserves inode identity; locate the renamed file without changing snapshot order.
    // Compression/pruning/replacement invalidates the cursor rather than silently skipping records.
    const current = inventory(file);
    const files = state.files.map(row => {
      const found = current.find(r => r.dev === row.dev && r.ino === row.ino && r.gz === row.gz);
      if (!found || found.size < row.size) throw failure('CURSOR_EXPIRED', 'A snapshot archive was removed, compressed or truncated');
      return { ...row, full: found.full };
    });
    return { q, state, files, before, scope: { source: 'history', timezone: 'UTC', order: 'append-desc',
      snapshot_at: state.captured, snapshot_files: files.length, snapshot_bytes: files.reduce((n, r) => n + r.size, 0),
      since: q.sinceMs, until: q.untilMs, inclusive: true,
      complete_lines_only: true, cursor_expires_at: new Date(state.expires).toISOString() } };
  }
  async function listHistory(query = {}) {
    try {
      const { q, state, files, before, scope } = start(query);
      const limit = Math.min(MAX_PAGE, normalizeLimit(query.limit));
      if (!limit) return { logs: [], next_cursor: null, scope, skipped: 0 };
      const selected = [];
      let skipped = 0;
      for (let f = before ? before.f : files.length - 1; f >= 0; f--) {
        const batch = [];
        for await (const { value, line } of records(files[f], file)) {
          if (before && f === before.f && line >= before.l) continue;
          if (!value) { skipped++; continue; }
          const record = pick(value);
          if (!matchesQuery(record, q)) continue;
          batch.push({ record, f, l: line });
          if (batch.length > limit + 1 - selected.length) batch.shift();
        }
        selected.push(...batch.reverse());
        if (selected.length > limit) break;
      }
      const more = selected.length > limit;
      const page = selected.slice(0, limit), last = page[page.length - 1];
      return { logs: page.map(r => r.record), next_cursor: more ? encode({ id: state.id, f: last.f, l: last.l }) : null,
        scope, skipped };
    } catch (e) { report(e, 'history'); throw e; }
  }
  async function summaryHistory(query = {}) {
    try {
      if (query.cursor) throw failure('CURSOR_INVALID', 'Summary does not accept a page cursor');
      const { q, files, scope } = start(query);
      const bySlot = Object.create(null);
      let reqs = 0, ok = 0, inTok = 0, outTok = 0, cache = 0, skipped = 0;
      let first = null, last = null;
      const count = x => Number.isFinite(Number(x)) ? Number(x) : 0;
      for (const row of files) for await (const { value } of records(row, file)) {
        if (!value) { skipped++; continue; }
        const e = pick(value);
        if (!matchesQuery(e, q)) continue;
        reqs++; if (e.status >= 200 && e.status < 400 && !e.err) ok++;
        inTok += count(e.in); outTok += count(e.out); cache += count(e.cache_read);
        const slot = typeof e.slot === 'string' ? (e.slot || 'none') : 'unknown';
        const totals = bySlot[slot] || (bySlot[slot] = { reqs: 0, in: 0, out: 0, cache: 0 });
        totals.reqs++; totals.in += count(e.in); totals.out += count(e.out); totals.cache += count(e.cache_read);
        const at = Date.parse(e.ts);
        if (Number.isFinite(at)) { first = first === null ? at : Math.min(first, at); last = last === null ? at : Math.max(last, at); }
      }
      return { reqs, ok, ok_rate: reqs ? Math.round(ok * 100 / reqs) : 100, inTok, outTok, cache,
        by_slot: { ...bySlot }, scope, skipped,
        range: { from: first === null ? null : new Date(first).toISOString(), to: last === null ? null : new Date(last).toISOString() } };
    } catch (e) { report(e, 'history'); throw e; }
  }
  return { listHistory, summaryHistory };
}
module.exports = { createHistory, records, MAX_LINE_BYTES, MAX_PAGE, CURSOR_TTL, cursorHttpStatus };
