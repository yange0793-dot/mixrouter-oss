'use strict';
// mixctl logs 的只读尾部查询:默认按 64KiB 反向读取,够 N 条即停。
// 正整数查询最多读 8MiB;坏行只跳过,不重读窗口。跨块行收齐后才解码 UTF-8。
// 非正/非有限计数沿用旧 slice 语义,仍会全文读取,不属于有界查询。
const fs = require('node:fs');

const DEFAULT_CHUNK = 64 * 1024;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_COUNT = 20;
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const positiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
};

// 同一个 fd 从尾到头扫描,每个字节只读一次;visit 返回 false 表示已取够。
// truncated 表示还有更早的行未交付(行数/字节上限,或读期间文件被截短)。
// 未读到行首的残行不交付,也不为边界探测越过 maxBytes 多读一个字节。
function scanTail(file, options, visit) {
  const maxBytes = positiveInt(options.maxBytes, DEFAULT_MAX_BYTES);
  const chunkSize = positiveInt(options.chunkSize, DEFAULT_CHUNK);
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch (e) {
    if (e.code === 'ENOENT') return { missing: true, size: 0, bytesRead: 0, truncated: false };
    throw e;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let pos = size, bytesRead = 0;
    let parts = [], length = 0, sawLine = false;
    const result = truncated => ({ missing: false, size, bytesRead, truncated });
    const append = part => { if (part.length) { parts.push(part); length += part.length; } };
    const emit = (part, start) => {
      append(part);
      if (start === size && length === 0) return true; // 文件末尾的换行不是额外一行
      const text = (parts.length === 1 ? parts[0] : Buffer.concat(parts.reverse(), length)).toString('utf8');
      parts = []; length = 0; sawLine = true;
      return visit(text);
    };
    while (pos > 0 && bytesRead < maxBytes) {
      const readSize = Math.min(chunkSize, pos, maxBytes - bytesRead);
      const start = pos - readSize;
      const chunk = Buffer.allocUnsafe(readSize);
      let filled = 0;
      while (filled < readSize) {
        const n = fs.readSync(fd, chunk, filled, readSize - filled, start + filled);
        bytesRead += n;
        if (!n) return result(true); // 被截短:不能把 allocUnsafe 未填充的区域当日志
        filled += n;
      }
      pos = start;
      let end = chunk.length;
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] !== 0x0a) continue;
        if (!emit(chunk.subarray(i + 1, end), pos + i + 1)) return result(pos + i + 1 > 0);
        end = i;
      }
      // 只保留跨块的那一行,不反复 concat 整个已读窗口。
      append(chunk.subarray(0, end));
    }
    if (pos === 0 && (length || sawLine)) emit(Buffer.alloc(0), 0);
    return result(pos > 0);
  } finally { fs.closeSync(fd); }
}

// 完整物理行,按文件顺序返回;maxLines<=0 表示只受 maxBytes 限制。
function readTailLines(file, options = {}) {
  const maxLines = positiveInt(options.maxLines, 0);
  const lines = [];
  const tail = scanTail(file, options, line => {
    lines.push(line);
    return !maxLines || lines.length < maxLines;
  });
  return { ...tail, lines: lines.reverse() };
}

function parseLine(line) {
  try {
    const parsed = JSON.parse(line);
    return isPlainObject(parsed) ? parsed : null;
  } catch { return null; }
}

// N 条可解析对象。坏行继续往前读,累计 I/O 始终受同一个 maxBytes 约束。
function readTailEntries(file, options = {}) {
  const limit = positiveInt(options.limit, DEFAULT_COUNT);
  const entries = [];
  let lines = 0, corrupt = 0;
  const tail = scanTail(file, options, line => {
    lines++;
    const entry = parseLine(line);
    if (entry) entries.push(entry);
    else corrupt++;
    return entries.length < limit;
  });
  return { ...tail, entries: entries.reverse(), lines, corrupt };
}

// 兼容 `slice(-Number(n))`:NaN/0/绝对值<1 取全部,负数从开头跳过相应条数。
function readAllEntries(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { entries: [], missing: true };
    throw e;
  }
  const entries = [];
  for (const line of text.trim().split('\n')) {
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }
  return { entries, missing: false };
}

function selectLogs(file, count, options = {}) {
  const n = Number(count);
  if (Number.isFinite(n) && Math.trunc(n) > 0) {
    const limit = Math.trunc(n);
    const r = readTailEntries(file, { ...options, limit });
    return { entries: r.entries, missing: r.missing, incomplete: r.truncated && r.entries.length < limit };
  }
  const r = readAllEntries(file);
  return { entries: r.entries.slice(-n), missing: r.missing, incomplete: false };
}

function resolveCount(arg, fallback = DEFAULT_COUNT) {
  return Number(arg === undefined ? fallback : arg);
}

// 正常日志保持旧内联模板,ts 缺失时不让整批日志抛错。
function formatLogLine(e) {
  const tr = (e.wire === 'chat' && e.kind === 'responses') ? ' ⇄翻译' : '';
  const ts = typeof e.ts === 'string' ? e.ts.slice(5, 19) : String(e.ts);
  return `${ts}  ${(e.app === 'codex' ? 'Cx' : 'CC').padEnd(3)}${String(e.session || '-').padEnd(10)}${String(e.provider).padEnd(16)} ${e.model_in} → ${e.model_out}  in ${e.in} out ${e.out}  ${e.ms}ms  ${e.status}${e.failover ? ' ↷转移' : ''}${tr}${e.err ? '  ' + e.err : ''}`;
}

module.exports = {
  readTailLines, readTailEntries, readAllEntries, selectLogs, resolveCount, formatLogLine,
  DEFAULT_COUNT, DEFAULT_MAX_BYTES, DEFAULT_CHUNK,
};
