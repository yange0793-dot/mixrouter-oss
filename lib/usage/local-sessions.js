'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { records } = require('../observability/log-history');
const codexConfig = require('../codex-config');
const { createDshSessionUsage } = require('./dsh-sessions');

const DAY = 86400000;
// 单行上限:带 base64 截图/大附件的整行不参与用量统计,超过就整行跳过。
// 以前是 Infinity,一条超长记录就会把整行 Buffer.concat + 解码进内存。
const MAX_LINE_BYTES = 256 * 1024;
// 目录扫描(递归 readdir + 逐文件 stat)是这条链最贵的两步:
//   · 目录列表按目录自身的 mtime 缓存 —— 新增/删除文件会改父目录 mtime,立刻能发现;
//   · 文件 stat 按 TTL 缓存 —— 追加内容最多延迟一个 TTL 才被看到,不必每次请求全量 stat。
// scanTtlMs <= 0 表示文件 stat 不缓存(测试里用来验证"写完立刻再读"的增量语义)。
const SCAN_TTL_MS = 5000;
// 保留期清理只控制内存,合并结果本来就按 cutoff 过滤,不需要每次请求都扫一遍。
const PRUNE_INTERVAL_MS = 60000;
const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
const alias = model => /^mixr-/.test(model || '');
const totalsKey = usage => usage
  ? [usage.input_tokens, usage.output_tokens, usage.cached_input_tokens, usage.total_tokens].map(count).join(':') : '';
const acceptCodex = text => /"type"\s*:\s*"(session_meta|turn_context|token_usage_record|event_msg)"/.test(text);
const acceptClaude = text => /"type"\s*:\s*"(assistant|api-request)"/.test(text);

// Keep only accounting metadata. Prompts, tool results, credentials and transcript paths
// never leave the reader. The original client files are read-only.
function createLocalSessionUsage({ codexHome, claudeHome, dshHome, configFile, getProviders = () => ({}),
  retentionDays = 30, maxEntries = 100000, now = Date.now, telemetry, scanTtlMs = SCAN_TTL_MS } = {}) {
  const cache = new Map();
  const dirs = new Map(), stats = new Map();
  const dshUsage = createDshSessionUsage({ dshHome, retentionDays, maxEntries: 0, now });
  const roots = [
    ...(codexHome ? ['sessions', 'archived_sessions'].map(name => ({ app: 'codex', dir: path.join(codexHome, name) })) : []),
    ...(claudeHome ? [{ app: 'claude', dir: path.join(claudeHome, 'projects') }] : []),
  ];
  let lastPruneAt = 0;
  // 缓存被硬上限淘汰过:之后返回的行数虽然收在 maxEntries 内,但确实丢过记录。
  let cacheTruncated = false;

  // 递归扫描一个根目录,返回文件清单(路径 + stat 快照)。
  // 目录列表只在其 mtime 变化时重新 readdir;文件 stat 在 TTL 内复用。
  async function scanRoot(root) {
    const files = [], warnings = [];
    async function walk(dir) {
      let dirStat;
      try { dirStat = await fs.promises.stat(dir); }
      catch (error) {
        if (error.code !== 'ENOENT') warnings.push(`${root.app}: ${error.code || 'READ_FAILED'}`);
        return;
      }
      if (!dirStat.isDirectory()) return;
      let listing = dirs.get(dir);
      if (!listing || listing.mtimeMs !== dirStat.mtimeMs) {
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
        catch (error) {
          if (error.code !== 'ENOENT') warnings.push(`${root.app}: ${error.code || 'READ_FAILED'}`);
          return;
        }
        listing = { mtimeMs: dirStat.mtimeMs, entries };
        dirs.set(dir, listing);
        // 目录内容变了:已经消失的子项不再需要缓存。
        const names = new Set(entries.map(entry => entry.name));
        for (const key of [...dirs.keys()])
          if (path.dirname(key) === dir && !names.has(path.basename(key))) dirs.delete(key);
        for (const key of [...stats.keys()])
          if (path.dirname(key) === dir && !names.has(path.basename(key))) stats.delete(key);
      }
      for (const entry of listing.entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const cached = stats.get(full);
          if (cached && scanTtlMs > 0 && now() - cached.at < scanTtlMs) { files.push(cached.file); continue; }
          try {
            const st = await fs.promises.stat(full);
            const file = { full, app: root.app, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
            if (scanTtlMs > 0) stats.set(full, { at: now(), file });
            files.push(file);
          } catch (error) {
            stats.delete(full);
            if (error.code !== 'ENOENT') warnings.push(`${root.app}: ${error.code || 'READ_FAILED'}`);
          }
        }
      }
    }
    await walk(root.dir);
    return { files, warnings };
  }

  async function read({ app = '', from = null } = {}) {
    const at = now();
    const cutoff = retentionDays > 0 ? at - retentionDays * DAY : -Infinity;
    const scanFrom = Math.max(cutoff, from ?? -Infinity);
    const files = [], warnings = [], seenFiles = new Set();
    for (const root of roots) {
      if (app && app !== root.app) continue;
      const scan = await scanRoot(root);
      warnings.push(...scan.warnings);
      for (const file of scan.files) {
        seenFiles.add(file.full);
        if (file.mtimeMs >= scanFrom) files.push(file);
      }
    }
    for (const [file, entry] of cache)
      if ((!app || app === entry.app) && !seenFiles.has(file)) cache.delete(file);
    // 保留期清理不需要每次请求都做:合并结果已按 cutoff 过滤,这里只控制内存。
    if (at - lastPruneAt >= PRUNE_INTERVAL_MS) {
      for (const entry of cache.values())
        for (const [key, row] of entry.rows) if (Date.parse(row.ts) < cutoff) entry.rows.delete(key);
      lastPruneAt = at;
    }
    const providers = getProviders();
    let document;
    try { if (configFile) document = codexConfig.read(configFile).document; }
    catch (error) { warnings.push(`codex config: ${error.code || 'READ_FAILED'}`); }

    const oversized = new Map();
    for (const file of files) {
      let entry = cache.get(file.full);
      if (!entry || entry.dev !== file.dev || entry.ino !== file.ino || entry.size > file.size
        || (entry.size === file.size && entry.mtimeMs !== file.mtimeMs)) {
        entry = { app: file.app, dev: file.dev, ino: file.ino, size: 0, offset: 0, mtimeMs: 0,
          session: '', provider: '', model: '', turn: '', started: 0, lastTotal: '',
          modernTotals: new Set(), rows: new Map(), requests: new Map() };
        cache.set(file.full, entry);
      }
      if (file.size === entry.offset) continue;
      try {
        for await (const { value, end } of records(file, null, {
          start: entry.offset, maxLineBytes: MAX_LINE_BYTES, highWaterMark: 1024 * 1024,
          acceptLine: file.app === 'codex' ? acceptCodex : acceptClaude,
        })) {
          const lineBytes = end - entry.offset;
          entry.offset = end;
          if (!value) {
            // records() 对超限行只回 value:null;用行字节数把它和"不认识/解析失败"区分开。
            if (lineBytes > MAX_LINE_BYTES) oversized.set(file.app, (oversized.get(file.app) || 0) + 1);
            continue;
          }
          if (file.app === 'codex') readCodex(value, entry, cutoff);
          else readClaude(value, entry, cutoff);
        }
        entry.size = file.size; entry.mtimeMs = file.mtimeMs;
      } catch (error) { warnings.push(`${file.app}: ${error.code || 'READ_FAILED'}`); }
    }
    for (const [client, rows] of oversized)
      warnings.push(`${client}: ${rows} 行超过 ${MAX_LINE_BYTES / 1024}KB,已跳过`);
    // 缓存硬上限:按 ts 淘汰最旧的行,行数不再随会话档案无限增长。
    if (maxEntries > 0) {
      let total = 0;
      for (const entry of cache.values()) total += entry.rows.size;
      if (total > maxEntries) {
        const ordered = [];
        for (const entry of cache.values())
          for (const [key, row] of entry.rows) ordered.push([Date.parse(row.ts) || 0, entry, key]);
        ordered.sort((a, b) => a[0] - b[0]);
        for (let index = 0; total > maxEntries; index++, total--) ordered[index][1].rows.delete(ordered[index][2]);
        cacheTruncated = true;
      }
    }

    const merged = new Map();
    let routed = 0;
    for (const entry of cache.values()) {
      if (app && app !== entry.app) continue;
      for (const [key, row] of entry.rows) {
        if (Date.parse(row.ts) < cutoff) continue;
        if (row.routed) { routed++; continue; }
        const { providerKey, routed: omitted, ...publicRow } = row;
        if (entry.app === 'codex') {
          const provider = (providers.codex || []).find(p => `mixr-${p.id}` === providerKey || p.id === providerKey);
          publicRow.provider = provider?.name || document?.get('model_providers', providerKey, 'name') || providerKey || '供应商未知';
          publicRow.provider_id = provider?.id || '';
        }
        const previous = merged.get(key);
        if (!previous || publicRow.out >= previous.out) merged.set(key, publicRow);
      }
    }
    const harness = await dshUsage.read({ app, from });
    for (const row of harness.rows) merged.set(row.request_id, row);
    warnings.push(...harness.warnings);
    const rows = [...merged.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    if (telemetry) {
      await telemetry.restore();
      telemetry.enrich(rows);
    }
    return { rows: maxEntries > 0 ? rows.slice(0, maxEntries) : rows,
      warnings: [...new Set(warnings)], routed, retention_days: retentionDays,
      truncated: maxEntries > 0 && (rows.length > maxEntries || cacheTruncated) };
  }
  return { read };
}

function readCodex(record, state, cutoff) {
  const p = record.payload || {};
  if (record.type === 'session_meta') {
    state.session = p.id || p.session_id || '';
    state.provider = p.model_provider || '';
    state.started = Date.parse(p.timestamp || record.timestamp) || 0;
    return;
  }
  if (record.type === 'turn_context') {
    state.model = p.model || state.model;
    state.turn = p.turn_id || '';
    if (p.model_provider) state.provider = p.model_provider;
    return;
  }
  if (record.type === 'event_msg' && p.type === 'thread_settings_applied') {
    state.provider = p.thread_settings?.model_provider_id || state.provider;
    state.model = p.thread_settings?.model || state.model;
    return;
  }
  const at = Date.parse(record.timestamp);
  if (!state.session || !Number.isFinite(at) || at < cutoff || at < state.started) return;
  let usage, key, total;
  if (record.type === 'token_usage_record') {
    if (p.thread_id && p.thread_id !== state.session) return;
    usage = p.usage;
    if (!usage || !p.response_id) return;
    key = `codex:${p.response_id}`;
    total = totalsKey(p.thread_token_usage);
    if (total) {
      state.modernTotals.add(total);
      state.rows.delete(`codex:${state.session}:${total}`);
      state.lastTotal = total;
    }
  } else if (record.type === 'event_msg' && p.type === 'token_count' && p.info) {
    const totals = p.info.total_token_usage;
    total = totalsKey(totals);
    if (!totals || !total || total === state.lastTotal || state.modernTotals.has(total)) return;
    const previous = state.lastTotal.split(':').map(Number);
    state.lastTotal = total;
    // Compaction/reset notifications repeat last_token_usage without a new completion.
    if (previous.length === 4 && count(totals.input_tokens) <= previous[0]
      && count(totals.output_tokens) <= previous[1]) return;
    usage = p.info.last_token_usage;
    key = `codex:${state.session}:${total}`;
  } else return;
  if (!usage || ![usage.input_tokens, usage.output_tokens].some(n => Number.isFinite(n))) return;
  const cache = count(usage.cached_input_tokens);
  state.rows.set(key, {
    ts: record.timestamp, app: 'codex', source: 'codex-local', session: state.session,
    request_id: key, model_in: state.model, model_out: state.model,
    providerKey: state.provider, provider_app: 'codex',
    routed: state.provider === 'mixr-router' || alias(state.model),
    in: Math.max(0, count(usage.input_tokens) - cache), out: count(usage.output_tokens),
    cache_read: cache, cache_write: count(usage.cache_write_input_tokens),
    status: null, ms: null, ttfb_ms: null, usage_normalized: true,
  });
}

function readClaude(record, state, cutoff) {
  if (record.type === 'api-request') {
    if (record.id) state.requests.set(record.id, record.params?.model || '');
    return;
  }
  if (record.type !== 'assistant') return;
  const message = record.message, usage = message?.usage;
  const at = Date.parse(record.timestamp);
  if (!message?.id || !usage || message.model === '<synthetic>' || !Number.isFinite(at) || at < cutoff) return;
  if (![usage.input_tokens, usage.output_tokens].some(n => Number.isFinite(n))) return;
  const key = `claude:${message.id}`;
  const modelIn = record.requestedModel || state.requests.get(record.requestRef) || message.model || '';
  const before = state.rows.get(key);
  const row = {
    ts: before?.ts || record.timestamp, app: 'claude', source: 'claude-local',
    session: record.sessionId || record.session_id || '', request_id: key,
    model_in: modelIn, model_out: message.model || modelIn,
    provider: '供应商未知', provider_id: '', provider_app: 'claude',
    routed: alias(modelIn), in: count(usage.input_tokens) + count(usage.cache_creation_input_tokens),
    out: count(usage.output_tokens), cache_read: count(usage.cache_read_input_tokens),
    cache_write: count(usage.cache_creation_input_tokens),
    status: null, ms: null, ttfb_ms: null, usage_normalized: true,
  };
  // One response can appear once per content block; usage is cumulative, not additive.
  if (!before || row.out >= before.out) state.rows.set(key, row);
}

module.exports = { createLocalSessionUsage };
