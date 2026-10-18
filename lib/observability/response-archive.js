'use strict';
// Per upstream attempt, not per user session. Nothing here writes requests.jsonl or console.
// raw-response.bin is the exact body bytes except known-secret replacements, not HTTP headers.
// Explicit opt-in. Bounded attempt bytes and archive count; no automatic deletion.
// Slow-disk backlog is bounded: overload stops ONLY archiving,
// reports an error and marks raw incomplete; forwarding must ignore write()'s return value.
// Derived extraction is bounded per JSON body / SSE event (default 4 MiB); oversized records
// remain in raw, but are explicitly unparsed. Summaries are labelled summaries, not private CoT.
// finish() drains asynchronous writes and resolves metadata, never rejects into the proxy.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { uniqueSuffix } = require('../atomic-write');

const REDACTED = Buffer.from('[redacted]');
const DEFAULT_QUEUE_BYTES = 8 * 1024 * 1024;
const DEFAULT_RECORD_BYTES = 4 * 1024 * 1024;
const DEFAULT_RAW_BYTES = 16 * 1024 * 1024;
const DEFAULT_ARCHIVES = 100;
const MAX_ACTIVE = 8;
let active = 0;
let admission = Promise.resolve();
function admit(root, directory, maxArchives) {
  const next = admission.then(() => reserveDirectory(root, directory, maxArchives));
  admission = next.catch(() => {});
  return next;
}

// Serialize directory admission across processes. A crash leaves the lock behind: fail closed,
// never guess that an unowned lock is stale or delete somebody else's archive.
async function reserveDirectory(root, directory, maxArchives) {
  const lock = path.join(root, '.archive-admission.lock');
  let handle;
  try {
    handle = await fsp.open(lock, 'wx', 0o600);
    const entries = await fsp.opendir(root);
    let count = 0;
    for await (const entry of entries) {
      if (entry.name === path.basename(lock)) continue;
      if (++count >= maxArchives) throw new Error('archive_limit');
    }
    await fsp.mkdir(directory, { mode: 0o700 });
  } finally {
    if (handle) { await handle.close(); await fsp.unlink(lock); }
  }
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const positive = (n, fallback) => Number.isSafeInteger(n) && n > 0 ? n : fallback;

function secretBuffers(source) {
  const value = typeof source === 'function' ? source() : source;
  // Missing/broken credentials are not equivalent to an explicitly empty secret list.
  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values) || values.length > 512 || values.some(s => typeof s !== 'string' || !s.length
      || Buffer.byteLength(s) > 4096) || values.reduce((n, s) => n + Buffer.byteLength(s), 0) > 65536) throw new Error('secret_source');
  const variants = new Set();
  for (const s of values) {
    variants.add(s);
    variants.add(JSON.stringify(s).slice(1, -1));
  }
  return [...variants].map(s => Buffer.from(s)).sort((a, b) => b.length - a.length);
}

// Retain a possible prefix until the next chunk. Longest match wins at each byte position;
// replacing the shorter prefix first would expose the remaining suffix of a longer key.
function redactor(secrets) {
  const keep = Math.max(0, ...secrets.map(s => s.length - 1));
  let tail = Buffer.alloc(0);
  return (chunk, final = false) => {
    const bytes = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    if (!secrets.length) { tail = Buffer.alloc(0); return bytes; }
    const end = final ? bytes.length : Math.max(0, bytes.length - keep);
    const pieces = [];
    let i = 0, start = 0;
    while (i < end) {
      const found = secrets.find(s => i + s.length <= bytes.length && bytes.subarray(i, i + s.length).equals(s));
      if (!found) { i++; continue; }
      pieces.push(bytes.subarray(start, i), REDACTED);
      i += found.length;
      start = i;
    }
    pieces.push(bytes.subarray(start, i));
    tail = Buffer.from(bytes.subarray(i));
    return Buffer.concat(pieces);
  };
}

async function atomicMetadata(file, data) {
  const temp = `${file}.${uniqueSuffix()}.tmp`;
  let handle;
  try {
    handle = await fsp.open(temp, 'wx', 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(data, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temp, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(temp).catch(() => {});
  }
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (!bytesWritten) throw new Error('write_failed');
    offset += bytesWritten;
  }
}

async function extract(rawFile, output, { format, stream, maxRecordBytes, maxRawBytes, secrets }) {
  const sources = new Set(), errors = new Set(), seenParts = new Set();
  let terminal = false, returnedBytes = 0, diskBytes = 0, maxObservedRecordBytes = 0;
  const emit = async (source, text, aggregate = false, part = '') => {
    const key = hash(`${source}:${part}`);
    if (typeof text !== 'string' || !text.length || (aggregate && seenParts.has(key))) return;
    if (part) {
      // Even the bookkeeping must stay bounded if an upstream emits endlessly new item IDs.
      if (seenParts.size >= 10000 && !seenParts.has(key)) { errors.add('part_limit'); return; }
      seenParts.add(key);
    }
    sources.add(source);
    const scrub = redactor(secrets);
    const bytes = scrub(Buffer.from(text), true);
    const record = Buffer.concat([Buffer.from(`[${source}]\n`), bytes, Buffer.from('\n')]);
    if (diskBytes + record.length > maxRawBytes) { errors.add('derived_limit'); return; }
    returnedBytes += bytes.length;
    diskBytes += record.length;
    await writeAll(output, record);
  };
  const responsesOutput = async (items, aggregate) => {
    for (const [outputIndex, item] of (Array.isArray(items) ? items : []).entries()) {
      if (item.type !== 'reasoning') continue;
      const itemId = item.id || `output-${outputIndex}`;
      for (const [index, part] of (item.summary || []).entries()) {
        await emit('responses.reasoning_summary', part.text, aggregate, `${itemId}:${index}`);
      }
      for (const [index, part] of (item.content || []).entries()) {
        if (part.type === 'reasoning_text' || part.type === 'text') {
          await emit('responses.reasoning_text', part.text, aggregate, `${itemId}:${index}`);
        }
      }
      await emit('responses.reasoning_text', item.text, aggregate, `${itemId}:0`);
    }
  };
  const consume = async text => {
    if (!text.trim()) return;
    if (text.trim() === '[DONE]') { if (format === 'chat') terminal = true; return; }
    let data;
    try { data = JSON.parse(text); } catch { errors.add('invalid_json'); return; }
    if (data.error) terminal = true;
    if (format === 'anthropic') {
      if (data.type === 'message_stop' || (!stream && data.stop_reason)) terminal = true;
      if (data.type === 'content_block_delta' && data.delta?.type === 'thinking_delta') {
        await emit('anthropic.thinking', data.delta.thinking);
      }
      if (data.type === 'content_block_start' && data.content_block?.type === 'thinking') {
        await emit('anthropic.thinking', data.content_block.thinking);
      }
      if (!stream) for (const block of data.content || []) {
        if (block.type === 'thinking') await emit('anthropic.thinking', block.thinking);
      }
    } else if (format === 'chat') {
      for (const choice of data.choices || []) {
        if (choice.finish_reason) terminal = true;
        const message = choice.delta || choice.message || {};
        await emit('chat.reasoning_content', message.reasoning_content);
        await emit('chat.reasoning', message.reasoning);
      }
    } else if (format === 'responses') {
      const itemId = data.item_id || `output-${data.output_index || 0}`;
      if (data.type === 'response.reasoning_summary_text.delta') {
        await emit('responses.reasoning_summary', data.delta, false, `${itemId}:${data.summary_index || 0}`);
      } else if (data.type === 'response.reasoning_text.delta') {
        await emit('responses.reasoning_text', data.delta, false, `${itemId}:${data.content_index || 0}`);
      } else if (data.type === 'response.reasoning_summary_text.done') {
        await emit('responses.reasoning_summary', data.text, true, `${itemId}:${data.summary_index || 0}`);
      } else if (data.type === 'response.reasoning_text.done') {
        await emit('responses.reasoning_text', data.text, true, `${itemId}:${data.content_index || 0}`);
      }
      if (data.type === 'response.completed' || (!stream && data.status === 'completed')) terminal = true;
      if (data.type === 'response.completed') await responsesOutput(data.response?.output, true);
      else if (data.type === 'response.output_item.done' && data.item) await responsesOutput([data.item], true);
      else if (!stream) await responsesOutput(data.output, false);
    }
  };
  // Bound line AND event accumulation; readline alone buffers an unbounded unterminated line.
  let line = '', lineBytes = 0, eventLines = [], eventBytes = 0, oversized = false;
  const decoder = new StringDecoder('utf8');
  const flushEvent = async () => {
    if (oversized) errors.add('record_limit');
    else if (eventLines.length) await consume(eventLines.join('\n'));
    eventLines = []; eventBytes = 0; oversized = false;
  };
  const consumeLine = async () => {
    const current = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!current && lineBytes <= 1) await flushEvent();
    else if (current.startsWith('data:')) {
      const value = current.slice(5).replace(/^ /, '');
      eventBytes += Buffer.byteLength(value) + 1;
      maxObservedRecordBytes = Math.max(maxObservedRecordBytes, eventBytes, lineBytes);
      if (eventBytes > maxRecordBytes) { oversized = true; eventLines = []; }
      if (!oversized) eventLines.push(value);
    }
    line = ''; lineBytes = 0;
  };
  let body = '', bodyBytes = 0;
  const accept = async text => {
    if (!stream) {
      bodyBytes += Buffer.byteLength(text);
      maxObservedRecordBytes = Math.max(maxObservedRecordBytes, bodyBytes);
      if (bodyBytes > maxRecordBytes) { body = ''; errors.add('record_limit'); }
      else if (!errors.has('record_limit')) body += text;
      return;
    }
    const slices = text.split('\n');
    for (let i = 0; i < slices.length; i++) {
      lineBytes += Buffer.byteLength(slices[i]);
      maxObservedRecordBytes = Math.max(maxObservedRecordBytes, lineBytes);
      if (lineBytes > maxRecordBytes) { oversized = true; line = ''; }
      else if (!oversized) line += slices[i];
      if (i < slices.length - 1) await consumeLine();
    }
  };
  for await (const chunk of fs.createReadStream(rawFile)) await accept(decoder.write(chunk));
  await accept(decoder.end());
  if (!stream) { if (!errors.has('record_limit')) await consume(body); }
  else {
    if (lineBytes) await consumeLine();
    if (eventLines.length || oversized) { errors.add('unterminated_event'); await flushEvent(); }
  }
  return { terminal, returnedBytes, maxObservedRecordBytes, sources: [...sources], errors: [...errors] };
}

function createResponseArchive(options = {}) {
  if (options.enabled !== true || active >= MAX_ACTIVE) {
    const state = options.enabled === true ? 'archive_error' : 'disabled';
    if (state === 'archive_error' && typeof options.onError === 'function') {
      try { options.onError(new Error('response archive failed: active_limit'), { op: 'active_limit', id: null }); } catch {}
    }
    const result = Promise.resolve({ state, errors: state === 'disabled' ? [] : ['active_limit'] });
    return { id: null, directory: null, write: () => false, finish: () => result };
  }
  active++;
  const id = `${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
  const root = path.resolve(typeof options.directory === 'string' ? options.directory : '.');
  const directory = path.join(root, id);
  const format = ['anthropic', 'chat', 'responses'].includes(options.format) ? options.format : 'unknown';
  const maxQueuedBytes = Math.min(positive(options.maxQueuedBytes, DEFAULT_QUEUE_BYTES), DEFAULT_QUEUE_BYTES);
  const maxRecordBytes = Math.min(positive(options.maxRecordBytes, DEFAULT_RECORD_BYTES), DEFAULT_RECORD_BYTES);
  const maxRawBytes = Math.min(positive(options.maxRawBytes, DEFAULT_RAW_BYTES), DEFAULT_RAW_BYTES);
  const maxArchives = Math.min(positive(options.maxArchives, DEFAULT_ARCHIVES), DEFAULT_ARCHIVES);
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const meta = { version: 1, id, format, stream: options.stream === true, started_at: new Date().toISOString(),
    state: 'recording', returned_thinking: 'unknown', sources: [], errors: [],
    raw: { file: 'raw-response.bin', bytes: 0, received_bytes: 0, complete: false, redacted: true },
    derived: { file: 'returned-thinking.txt', complete: false, max_record_bytes: maxRecordBytes, errors: [] },
    limits: { max_queued_bytes: maxQueuedBytes, max_queued_chunks: 8192, max_response_parts: 10000,
      raw_total_bytes: maxRawBytes, derived_total_bytes: maxRawBytes, max_archives: maxArchives,
      max_active: MAX_ACTIVE, automatic_deletion: false } };
  // Keep only the proxy's non-secret attempt identity. Never copy request bodies or headers.
  // Values are scrubbed with the same redactor as the body: a model name or rule id must not
  // become a way to smuggle a credential onto disk through metadata.
  const METADATA_KEYS = ['requestId', 'attempt', 'model', 'modelIn', 'sessionHash', 'rule', 'app', 'kind', 'providerName'];
  const applyMetadata = () => {
    const metadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};
    for (const key of METADATA_KEYS) {
      const value = metadata[key];
      if (Number.isSafeInteger(value) && value >= 0) { meta[key] = value; continue; }
      if (typeof value !== 'string' || !value.length || value.length > 512) continue;
      meta[key] = scrub(Buffer.from(value), true).toString('utf8');
    }
  };
  if (typeof options.provider === 'string') meta.provider_sha256 = hash(options.provider);
  let failed = false, closed = false, finishPromise, handle, made = false, queuedBytes = 0;
  let secrets = [], scrub, pumping = null;
  const queue = [], rawHash = crypto.createHash('sha256');
  const fail = op => {
    if (!meta.errors.includes(op)) meta.errors.push(op);
    failed = true; meta.state = 'archive_error';
    queue.length = 0; queuedBytes = 0;
    // Fixed diagnostics only: exception.message can itself contain a credential or response body.
    try { onError(new Error(`response archive failed: ${op}`), { op, id }); } catch {}
  };
  try {
    if (!options.directory || format === 'unknown') throw new Error('invalid_options');
    secrets = secretBuffers(options.secrets);
    scrub = redactor(secrets);
    applyMetadata();
  } catch { fail('secret_source'); }
  const ready = (async () => {
    if (failed) return;
    try {
      await fsp.mkdir(root, { recursive: true, mode: 0o700 });
      const stat = await fsp.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('unsafe_directory');
      await admit(root, directory, maxArchives);
      await fsp.chmod(directory, 0o700);
      made = true;
      await atomicMetadata(path.join(directory, 'metadata.json'), meta);
      if (!failed) {
        handle = await fsp.open(path.join(directory, 'raw-response.bin'), 'wx', 0o600);
        await handle.chmod(0o600);
      }
    } catch { fail('initialize'); }
  })();
  const persist = async bytes => {
    if (!bytes.length) return;
    if (meta.raw.bytes + bytes.length > maxRawBytes) { fail('raw_limit'); return; }
    await writeAll(handle, bytes);
    rawHash.update(bytes); meta.raw.bytes += bytes.length;
  };
  const pump = () => {
    if (pumping) return;
    pumping = (async () => {
      await ready;
      while (!failed && queue.length) {
        const bytes = queue.shift();
        await persist(scrub(bytes));
        queuedBytes -= bytes.length;
      }
    })().catch(() => fail('raw_write')).finally(() => { pumping = null; if (!failed && queue.length) pump(); });
  };
  function write(chunk) {
    if (closed || failed) return false;
    try {
      if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) { fail('invalid_chunk'); return false; }
      const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (size === 0) return true;
      meta.raw.received_bytes += size;
      if (queuedBytes + size > maxQueuedBytes || queue.length >= 8192) {
        meta.queue_overflow = { actual_bytes: queuedBytes + size, limit_bytes: maxQueuedBytes,
          actual_chunks: queue.length + 1, limit_chunks: 8192 };
        fail('queue_limit'); return false;
      }
      queue.push(Buffer.from(chunk)); queuedBytes += size;
      pump();
      return true;
    } catch { fail('raw_write'); return false; }
  }
  function finish(result = {}) {
    if (finishPromise) return finishPromise;
    closed = true;
    finishPromise = (async () => {
      await ready;
      while (pumping) await pumping;
      try {
        if (handle) {
          if (!failed) await persist(scrub(Buffer.alloc(0), true));
          await handle.sync();
          await handle.close(); handle = null;
        }
        meta.raw.sha256 = rawHash.digest('hex');
        meta.raw.complete = !failed && result.complete === true;
        if (typeof result.stream === 'boolean') meta.stream = result.stream;
        meta.status = Number.isInteger(result.status) ? result.status : null;
        if (typeof result.errorClass === 'string' && result.errorClass) meta.error_class_sha256 = hash(result.errorClass);
        if (!failed) {
          const output = await fsp.open(path.join(directory, 'returned-thinking.txt'), 'wx', 0o600);
          let derived;
          try {
            await output.chmod(0o600);
            derived = await extract(path.join(directory, 'raw-response.bin'), output,
              { format, stream: meta.stream, maxRecordBytes, maxRawBytes, secrets });
            await output.sync();
          } finally { await output.close(); }
          meta.sources = derived.sources;
          meta.derived.errors = derived.errors;
          meta.derived.complete = derived.errors.length === 0;
          meta.derived.bytes = derived.returnedBytes;
          meta.derived.max_observed_record_bytes = derived.maxObservedRecordBytes;
          meta.protocol_complete = derived.terminal;
          meta.returned_thinking = derived.returnedBytes ? 'returned' : (derived.errors.length ? 'unknown' : 'not_returned');
          meta.state = meta.raw.complete && derived.terminal && meta.derived.complete && !result.errorClass ? 'complete' : 'partial';
        }
      } catch { fail('finalize'); }
      finally {
        if (handle) { await handle.close().catch(() => {}); handle = null; }
      }
      meta.finished_at = new Date().toISOString();
      if (made) try { await atomicMetadata(path.join(directory, 'metadata.json'), meta); } catch { fail('metadata_write'); }
      return meta;
    })().catch(() => { fail('finalize'); return meta; }).finally(() => { active--; });
    return finishPromise;
  }
  return { id, directory, write, finish };
}

module.exports = { createResponseArchive, DEFAULT_QUEUE_BYTES, DEFAULT_RECORD_BYTES };
