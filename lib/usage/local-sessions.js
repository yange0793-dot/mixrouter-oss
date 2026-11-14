'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { records } = require('../observability/log-history');
const codexConfig = require('../codex-config');
const { createDshSessionUsage } = require('./dsh-sessions');

const DAY = 86400000;
const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
const alias = model => /^mixr-/.test(model || '');
const totalsKey = usage => usage
  ? [usage.input_tokens, usage.output_tokens, usage.cached_input_tokens, usage.total_tokens].map(count).join(':') : '';
const acceptCodex = text => /"type"\s*:\s*"(session_meta|turn_context|token_usage_record|event_msg)"/.test(text);
const acceptClaude = text => /"type"\s*:\s*"(assistant|api-request)"/.test(text);

// Keep only accounting metadata. Prompts, tool results, credentials and transcript paths
// never leave the reader. The original client files are read-only.
function createLocalSessionUsage({ codexHome, claudeHome, dshHome, configFile, getProviders = () => ({}),
  retentionDays = 30, maxEntries = 100000, now = Date.now, telemetry } = {}) {
  const cache = new Map();
  const dshUsage = createDshSessionUsage({ dshHome, retentionDays, maxEntries: 0, now });
  const roots = [
    ...(codexHome ? ['sessions', 'archived_sessions'].map(name => ({ app: 'codex', dir: path.join(codexHome, name) })) : []),
    ...(claudeHome ? [{ app: 'claude', dir: path.join(claudeHome, 'projects') }] : []),
  ];

  async function read({ app = '', from = null } = {}) {
    const cutoff = retentionDays > 0 ? now() - retentionDays * DAY : -Infinity;
    const scanFrom = Math.max(cutoff, from ?? -Infinity);
    const files = [], warnings = [], seenFiles = new Set();
    async function walk(dir, client) {
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch (error) {
        if (error.code !== 'ENOENT') warnings.push(`${client}: ${error.code || 'READ_FAILED'}`);
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, client);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try {
            const st = await fs.promises.stat(full);
            seenFiles.add(full);
            if (st.mtimeMs >= scanFrom) files.push({ full, app: client, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
          } catch (error) {
            if (error.code !== 'ENOENT') warnings.push(`${client}: ${error.code || 'READ_FAILED'}`);
          }
        }
      }
    }
    for (const root of roots) if (!app || app === root.app) await walk(root.dir, root.app);
    for (const [file, entry] of cache) {
      if ((!app || app === entry.app) && !seenFiles.has(file)) cache.delete(file);
      else for (const [key, row] of entry.rows) if (Date.parse(row.ts) < cutoff) entry.rows.delete(key);
    }
    const providers = getProviders();
    let document;
    try { if (configFile) document = codexConfig.read(configFile).document; }
    catch (error) { warnings.push(`codex config: ${error.code || 'READ_FAILED'}`); }

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
          start: entry.offset, maxLineBytes: Infinity, highWaterMark: 1024 * 1024,
          acceptLine: file.app === 'codex' ? acceptCodex : acceptClaude,
        })) {
          entry.offset = end;
          if (!value) continue;
          if (file.app === 'codex') readCodex(value, entry, cutoff);
          else readClaude(value, entry, cutoff);
        }
        entry.size = file.size; entry.mtimeMs = file.mtimeMs;
      } catch (error) { warnings.push(`${file.app}: ${error.code || 'READ_FAILED'}`); }
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
      truncated: maxEntries > 0 && rows.length > maxEntries };
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
