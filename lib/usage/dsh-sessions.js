'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { records } = require('../observability/log-history');

const DAY = 86400000;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
const acceptLine = text => /"type"\s*:\s*"(session|step\/start|step\/end|turn\/end|request\/header|request\/context|assistant\/message|assistant\/attempt|llm\/retry-started)"/.test(text);
const decompress = typeof zlib.zstdDecompress === 'function' ? promisify(zlib.zstdDecompress) : null;
const failure = code => Object.assign(new Error(code), { code });

// Zstandard's public decoder can return partial output for a torn frame. Walk
// its framing (magic, optional header fields, blocks, checksum) before decoding.
// Zero means the last frame is incomplete, so its byte cursor stays unchanged.
function frameLength(bytes) {
  if (bytes.length < 5) return 0;
  if (bytes.readUInt32LE(0) !== 0xfd2fb528) throw failure('ZSTD_DECODE_FAILED');
  const flags = bytes[4];
  if (flags & 0x18) throw failure('ZSTD_DECODE_FAILED');
  const single = Boolean(flags & 0x20), sizeFlag = flags >>> 6, dictionary = flags & 3;
  let cursor = 5 + (single ? 0 : 1) + [0, 1, 2, 4][dictionary]
    + (sizeFlag ? 2 ** sizeFlag : single ? 1 : 0);
  if (cursor > bytes.length) return 0;
  let final = false;
  while (!final) {
    if (cursor + 3 > bytes.length) return 0;
    const block = bytes.readUIntLE(cursor, 3), kind = (block >>> 1) & 3;
    if (kind === 3) throw failure('ZSTD_DECODE_FAILED');
    cursor += 3 + (kind === 1 ? 1 : block >>> 3);
    if (cursor > bytes.length) return 0;
    final = Boolean(block & 1);
  }
  if (flags & 4) cursor += 4;
  return cursor <= bytes.length ? cursor : 0;
}

// DSH appends independent Zstandard frames; decode each complete frame once.
// 损坏帧必须能越过:帧结构可信但解压失败时跳过这一帧、推进 offset、记一条 warning,
// 否则这个文件的 offset 永远停在坏帧上,后面追加的正常记录一条都读不到。
// warn 由调用方传入,统计口径与其他读取失败一致(每条文件一次 warning)。
async function* compressedRecords(file, start, warn = () => {}) {
  if (!decompress) throw failure('ZSTD_REQUIRES_NODE_22_15_OR_NEWER');
  const handle = await fs.promises.open(file.full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (stat.dev !== file.dev || stat.ino !== file.ino || stat.size < file.size) throw failure('SNAPSHOT_CHANGED');
    let offset = start, readAt = start, pending = Buffer.alloc(0), needMore = true;
    while (offset < file.size) {
      if (needMore) {
        const chunk = Buffer.alloc(Math.min(1024 * 1024, file.size - readAt));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, readAt);
        readAt += bytesRead;
        pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        if (!bytesRead && !pending.length) break;
      }
      let consumed;
      try { consumed = frameLength(pending); }
      catch {
        // 帧头本身不可信:无法确定下一帧的边界,整段丢弃并推进到文件末尾。
        warn('ZSTD_DECODE_FAILED');
        offset = file.size;
        yield { value: null, end: offset };
        break;
      }
      if (!consumed) {
        if (pending.length >= MAX_FRAME_BYTES) {
          // 声明长度超过允许上限:同样无法再信任这段帧结构。
          warn('ZSTD_FRAME_TOO_LARGE');
          offset = file.size;
          yield { value: null, end: offset };
          break;
        }
        if (readAt >= file.size) break; // Torn final frame: leave its cursor for the next read.
        needMore = true;
        continue;
      }
      let decoded;
      try { decoded = await decompress(pending.subarray(0, consumed), { maxOutputLength: MAX_FRAME_BYTES }); }
      catch {
        warn('ZSTD_DECODE_FAILED');
        offset += consumed;
        pending = pending.subarray(consumed);
        needMore = !pending.length;
        yield { value: null, end: offset };
        continue;
      }
      const text = decoded.toString('utf8');
      if (!text.endsWith('\n')) {
        // 完整帧里的记录没有换行结尾:内容已损坏,整帧跳过,不能拖住后面的帧。
        warn('ZSTD_INCOMPLETE_RECORD');
        offset += consumed;
        pending = pending.subarray(consumed);
        needMore = !pending.length;
        yield { value: null, end: offset };
        continue;
      }
      offset += consumed;
      for (const line of text.split('\n')) {
        if (!acceptLine(line)) continue;
        let value;
        try { value = JSON.parse(line); } catch {
          // 单行坏记录不该丢掉同帧的其他记录;警告后继续。
          warn('DSH_RECORD_INVALID');
          continue;
        }
        yield { value, end: null };
      }
      yield { value: null, end: offset };
      pending = pending.subarray(consumed);
      needMore = !pending.length;
    }
  } finally { await handle.close(); }
}

// Read only durable accounting events. No DSH package import, credentials,
// current model settings, prompts or tool results are needed or exposed.
function createDshSessionUsage({ dshHome, retentionDays = 30, maxEntries = 100000, now = Date.now } = {}) {
  const cache = new Map();
  let chain = Promise.resolve();
  function read(query = {}) {
    const run = chain.then(() => collect(query));
    chain = run.catch(() => undefined);
    return run;
  }
  async function collect({ app = '', from = null } = {}) {
    const cutoff = retentionDays > 0 ? now() - retentionDays * DAY : -Infinity;
    const scanFrom = Math.max(cutoff, from ?? -Infinity);
    const files = [], warnings = [], seen = new Set();
    async function walk(dir) {
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch (error) { if (error.code !== 'ENOENT') warnings.push(`Harness: ${error.code || 'READ_FAILED'}`); return; }
      const generations = entries.filter(e => e.isFile()).map(entry => ({ entry,
        match: /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(entry.name) })).filter(e => e.match);
      if (generations.length) {
        // A migrated session can retain old generations. Count the latest only.
        generations.sort((a, b) => Number(b.match[1] || 0) - Number(a.match[1] || 0)
          || Number(Boolean(b.match[2])) - Number(Boolean(a.match[2])));
        const generation = generations[0], full = path.join(dir, generation.entry.name);
        seen.add(full);
        try {
          const st = await fs.promises.stat(full);
          if (st.mtimeMs >= scanFrom) files.push({ full, dev: st.dev, ino: st.ino, size: st.size,
            mtimeMs: st.mtimeMs, compressed: Boolean(generation.match[2]) });
        } catch (error) { if (error.code !== 'ENOENT') warnings.push(`Harness: ${error.code || 'READ_FAILED'}`); }
      }
      for (const entry of entries) if (entry.isDirectory()) await walk(path.join(dir, entry.name));
    }
    if (dshHome) await walk(path.join(dshHome, 'sessions'));
    for (const [file, state] of cache) {
      if (!seen.has(file)) cache.delete(file);
      else for (const [key, row] of state.rows) if (Date.parse(row.ts) < cutoff) state.rows.delete(key);
    }
    for (const file of files) {
      let state = cache.get(file.full);
      if (!state || state.dev !== file.dev || state.ino !== file.ino || file.size < state.size
        || (file.size === state.size && file.mtimeMs !== state.mtimeMs)) {
        state = { dev: file.dev, ino: file.ino, offset: 0, size: 0, mtimeMs: 0,
          session: '', version: 0, provider: '', model: '', slot: null, openStep: null, lastAttempt: null, rows: new Map() };
        cache.set(file.full, state);
      }
      if (file.size === state.offset) continue;
      try {
        const reader = file.compressed
          ? compressedRecords(file, state.offset, code => warnings.push(`Harness: ${code}`)) : records(file, null,
          { start: state.offset, maxLineBytes: MAX_FRAME_BYTES, acceptLine });
        for await (const { value, end } of reader) {
          if (value) fold(value, state, cutoff);
          if (end !== null) state.offset = end;
        }
        state.size = file.size; state.mtimeMs = file.mtimeMs;
      } catch (error) { warnings.push(`Harness: ${error.code || 'READ_FAILED'}`); }
    }
    const merged = new Map();
    for (const state of cache.values()) for (const [key, row] of state.rows) {
      if (Date.parse(row.ts) < scanFrom || (app && app !== row.app)) continue;
      // Forked/archived history keeps model message IDs. A response is counted once.
      const previous = merged.get(key);
      if (!previous || Date.parse(row.ts) >= Date.parse(previous.ts)) merged.set(key, row);
    }
    const rows = [...merged.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return { rows: maxEntries > 0 ? rows.slice(0, maxEntries) : rows, warnings: [...new Set(warnings)],
      routed: 0, retention_days: retentionDays, truncated: maxEntries > 0 && rows.length > maxEntries };
  }
  return { read };
}

function fold(event, state, cutoff) {
  if (event.type === 'session') {
    if (![2, 3, 4].includes(event.version)) throw failure('DSH_FORMAT_UNSUPPORTED');
    state.session = typeof event.id === 'string' ? event.id : '';
    state.version = event.version;
    return;
  }
  if (!state.session || !state.version) return;
  const data = event.data || {};
  const at = typeof event.time === 'number' ? event.time : Date.parse(event.timestamp || event.ts);
  if (event.type === 'step/start') {
    state.openStep = { turn: data.turn, step: data.step, start: at, firstToken: null, firstEvent: null, buffered: false };
    state.lastAttempt = null;
    return;
  }
  if (event.type === 'step/end') { state.openStep = null; return; }
  if (event.type === 'turn/end') {
    const row = state.lastAttempt && state.rows.get(state.lastAttempt);
    if (row && !row.outcome && ['error', 'aborted'].includes(data.reason?.kind)) {
      row.outcome = data.reason.kind === 'aborted' ? 'cancelled' : 'failed';
      row.finish_reason = data.reason.kind;
    }
    state.openStep = null;
    return;
  }
  if (event.type === 'request/header' || event.type === 'request/context') {
    const config = event.type === 'request/header' ? data.header?.config : data;
    if (typeof config?.provider === 'string') state.provider = config.provider;
    if (typeof config?.model === 'string') state.model = config.model;
    return;
  }
  if (event.type === 'llm/retry-started') { state.slot = null; return; }
  if (!['assistant/message', 'assistant/attempt'].includes(event.type)) return;
  if (!Number.isFinite(at) || at < cutoff) return;
  let usage = data.usage;
  if (!usage) for (const record of data.stream || []) {
    const chunk = record.chunk || record;
    if (chunk.type === 'usage') usage = chunk.usage;
  }
  if (usage && ![usage.inputTokens, usage.outputTokens].some(Number.isFinite)) usage = null;
  const stream = streamFacts(data.stream || []);
  const finish = stream.finish;
  const outcome = data.interrupted || finish?.kind === 'aborted' ? 'cancelled'
    : finish?.kind === 'error' ? 'failed'
      : event.type === 'assistant/message' ? 'completed' : '';
  // Failed calls still have a result even when the provider reports no token usage.
  if (!usage && !outcome && event.type !== 'assistant/attempt') return;
  const source = data.message?.source;
  if (source && source.kind !== 'model') return;
  const provider = typeof source?.provider === 'string' ? source.provider : state.provider;
  const model = typeof source?.model === 'string' ? source.model : state.model;
  const response = source?.replayState?.response;
  const api = response?.api || '';
  const app = /anthropic|bedrock/.test(api) ? 'claude' : 'codex';
  const identity = response?.responseId || data.message?.id
    || createHash('sha256').update(JSON.stringify([at, data.turn, data.step, provider, model])).digest('hex');
  const key = `dsh:${identity}`;
  const sameSlot = state.slot && state.slot.turn === data.turn && state.slot.step === data.step;
  const previous = sameSlot ? state.rows.get(state.slot.key) : null;
  if (sameSlot) state.rows.delete(state.slot.key);
  state.slot = { turn: data.turn, step: data.step, key };
  const open = state.openStep?.turn === data.turn && state.openStep.step === data.step ? state.openStep : null;
  if (open) {
    open.firstToken ??= stream.firstToken;
    open.firstEvent ??= stream.firstEvent;
    open.buffered ||= stream.buffered;
  }
  const ms = open && Number.isFinite(open.start) && at >= open.start ? at - open.start : null;
  const first = open?.firstToken;
  const validToken = open && first !== null && Number.isFinite(first) && first >= open.start && first <= at && !open.buffered;
  const firstEvent = open?.firstEvent;
  const status = finish?.failure?.status;
  state.lastAttempt = event.type === 'assistant/attempt' ? key : null;
  state.rows.set(key, {
    ts: new Date(at).toISOString(), app, source: 'dsh-local', session: state.session, request_id: key,
    model_in: model, model_out: model, provider: provider ? `DeepSeek Harness · ${provider}` : 'DeepSeek Harness · 供应商未知',
    provider_id: provider ? `dsh:${provider}` : '', provider_app: app,
    // DSH inputTokens is already uncached; cache writes are a separate bucket.
    in: usage ? count(usage.inputTokens) + count(usage.cacheWriteTokens) : previous?.in ?? null,
    out: usage && Number.isFinite(usage.outputTokens) ? count(usage.outputTokens) : previous?.out ?? null,
    cache_read: usage ? count(usage.cacheReadTokens) : previous?.cache_read ?? null,
    cache_write: usage ? count(usage.cacheWriteTokens) : previous?.cache_write ?? null,
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    outcome, finish_reason: data.interrupted ? 'aborted' : finish?.kind || null,
    ms, ttfb_ms: null,
    first_event_ms: open && firstEvent !== null && Number.isFinite(firstEvent) && firstEvent >= open.start && firstEvent <= at
      ? firstEvent - open.start : null,
    ttft_ms: validToken ? first - open.start : null,
    decode_ms: validToken ? at - first : null,
    timing_quality: open?.buffered ? 'buffered' : validToken ? 'streamed' : 'untimed',
    usage_normalized: true,
  });
}

// Mirror DSH's non-empty delta predicate, including compact runs and their
// relative timestamps. Complete blocks without deltas imply buffered delivery:
// a late tool-name delta must not time all preceding output as a tiny decode.
function streamFacts(stream) {
  let firstToken = null, firstEvent = null, finish = null, buffered = false;
  const streamed = new Map();
  const addText = (index, text) => streamed.set(index, (streamed.get(index) || 0) + text.length);
  const admit = time => {
    if (firstToken === null && Number.isFinite(time)) firstToken = time;
  };
  for (const record of stream) {
    if (!record || typeof record !== 'object') continue;
    const time = record.type === 'chunk' ? record.time : record.time0;
    if (firstEvent === null && Number.isFinite(time)) firstEvent = time;
    if (record.type === 'chunk') {
      const chunk = record.chunk || {};
      if (['text-delta', 'reasoning-delta'].includes(chunk.type) && typeof chunk.text === 'string' && chunk.text !== '') {
        addText(chunk.index, chunk.text); admit(time);
      } else if (chunk.type === 'tool-call-delta'
        && ((typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '') || chunk.name !== undefined)) admit(time);
      else if (chunk.type === 'finish') finish = chunk.reason;
      else if (chunk.type === 'block-end' && ['text', 'reasoning'].includes(chunk.block?.type)
        && typeof chunk.block.text === 'string'
        && ((chunk.block.type === 'reasoning' && !streamed.has(chunk.index))
          || (streamed.get(chunk.index) || 0) !== chunk.block.text.length)) buffered = true;
      continue;
    }
    if (!['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(record.type)) continue;
    const members = record.type === 'tool-call-chunks' ? record.args : record.texts;
    if (!Array.isArray(members) || !Number.isFinite(time)) continue;
    if (record.type === 'tool-call-chunks' && record.name !== undefined) admit(time);
    let memberTime = time;
    for (let index = 0; index < members.length; index++) {
      if (index > 0) {
        const delta = record.dt?.[index - 1];
        if (!Number.isFinite(delta) || delta < 0) break;
        memberTime += delta;
      }
      if (typeof members[index] === 'string' && members[index] !== '') {
        if (record.type !== 'tool-call-chunks') addText(record.index, members[index]);
        admit(memberTime);
      }
    }
  }
  return { firstToken, firstEvent, finish, buffered };
}

module.exports = { createDshSessionUsage, streamFacts };
