'use strict';
const crypto = require('node:crypto');
const { createRequestLog } = require('../observability/request-log');
const { inventory } = require('../observability/log-files');
const { records } = require('../observability/log-history');
const { isJsonRequest } = require('../http/local-access');

const DAY = 86400000;
const FIELDS = new Set(['event.name', 'event.kind', 'event.timestamp', 'conversation.id', 'model', 'endpoint',
  'duration_ms', 'http.response.status_code', 'attempt', 'input_token_count', 'output_token_count',
  'cached_token_count', 'cache_write_token_count']);
const TOKEN_EVENTS = new Set(['response.output_text.delta', 'response.reasoning_text.delta',
  'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta', 'response.custom_tool_call_input.delta']);
const numeric = value => value === undefined || value === null || value === '' ? null
  : Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const fingerprint = row => JSON.stringify([row.session, row.model_out, row.in, row.out, row.cache_read, row.cache_write || 0]);

function createCodexTelemetry({ file, retentionDays = 30, maxEntries = 100000, now = Date.now, onError } = {}) {
  const store = createRequestLog({ file, retentionDays, maxEntries, now, onError });
  const pending = new Map(), samples = new Map(), byUsage = new Map();
  let receivedEvents = 0, receivedBytes = 0, lastReceived = null, restored;

  function add(row) {
    if (samples.has(row.request_id)) return false;
    samples.set(row.request_id, row);
    const key = fingerprint(row);
    if (!byUsage.has(key)) byUsage.set(key, []);
    byUsage.get(key).push(row);
    return true;
  }
  function prune() {
    const cutoff = retentionDays > 0 ? now() - retentionDays * DAY : -Infinity;
    const ordered = [...samples.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    for (let i = 0; i < ordered.length; i++) {
      const row = ordered[i];
      if (Date.parse(row.ts) >= cutoff && (maxEntries <= 0 || i < maxEntries)) continue;
      samples.delete(row.request_id);
      const key = fingerprint(row);
      const kept = byUsage.get(key).filter(item => item !== row);
      if (kept.length) byUsage.set(key, kept); else byUsage.delete(key);
    }
    for (const [key, request] of pending) if (request.headersAt < cutoff) pending.delete(key);
  }
  function restore() {
    if (!restored) restored = (async () => {
      await store.maintenance();
      if (file) for (const source of inventory(file)) for await (const { value } of records(source, file)) {
        if (value?.source === 'codex-otel' && typeof value.request_id === 'string') add(value);
      }
      prune();
    })();
    return restored;
  }
  function ingest(body, bytes = 0) {
    if (!body || !Array.isArray(body.resourceLogs))
      throw Object.assign(new Error('Expected OTLP JSON resourceLogs'), { statusCode: 400 });
    let completed = 0;
    for (const resource of body.resourceLogs) {
      if (!Array.isArray(resource?.scopeLogs)) continue;
      for (const scope of resource.scopeLogs) {
        if (!Array.isArray(scope?.logRecords)) continue;
        for (const event of scope.logRecords) {
          if (!Array.isArray(event?.attributes)) continue;
          const fields = {};
          for (const field of event.attributes) {
            if (!FIELDS.has(field?.key) || !field.value) continue;
            fields[field.key] = field.value.stringValue ?? field.value.intValue ?? field.value.doubleValue ?? field.value.boolValue;
          }
          receivedEvents++;
          const name = fields['event.name'], session = fields['conversation.id'], model = fields.model;
          const at = Date.parse(fields['event.timestamp']);
          if (typeof session !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(session)
            || typeof model !== 'string' || !model || model.length > 256 || !Number.isFinite(at)) continue;
          const key = `${session}:${model}`;
          if (name === 'codex.api_request' && fields.endpoint === '/responses') {
            const status = numeric(fields['http.response.status_code']), latency = numeric(fields.duration_ms);
            const attempt = numeric(fields.attempt) || 0;
            const previous = pending.get(key);
            // A duplicate exporter batch must not advance the request start time.
            if (previous && previous.headersAt === at) continue;
            pending.set(key, { headersAt: at, status, latency, attempt,
              start: attempt > 0 && previous ? previous.start : latency === null ? null : at - latency });
          } else if (name === 'codex.sse_event' && TOKEN_EVENTS.has(fields['event.kind'])) {
            const request = pending.get(key);
            if (request && at >= request.headersAt) request.firstToken ??= at;
          } else if (name === 'codex.sse_event' && fields['event.kind'] === 'error') {
            pending.delete(key);
          } else if (name === 'codex.sse_event' && fields['event.kind'] === 'response.completed') {
            const input = numeric(fields.input_token_count), output = numeric(fields.output_token_count);
            const cache = numeric(fields.cached_token_count) || 0, written = numeric(fields.cache_write_token_count) || 0;
            const request = pending.get(key);
            if (input === null || output === null || !request || request.start === null
              || request.status < 200 || request.status >= 400 || at < request.headersAt) continue;
            pending.delete(key);
            const row = { app: 'codex', source: 'codex-otel', ts: new Date(at).toISOString(), session,
              model_in: model, model_out: model, wire: 'responses',
              status: request.status, ms: at - request.start, ttfb_ms: request.headersAt - request.start,
              attempts: request.attempt + 1, in: Math.max(0, input - cache), out: output,
              cache_read: cache, cache_write: written, usage_normalized: true };
            if (request.firstToken !== undefined && request.firstToken <= at)
              row.ttft_ms = request.firstToken - request.start;
            row.request_id = 'otel:' + crypto.createHash('sha256').update(fingerprint(row) + ':' + row.ts).digest('hex');
            if (add(row)) { store.append(row); completed++; }
          }
        }
      }
    }
    receivedBytes += numeric(bytes) || 0;
    lastReceived = new Date(now()).toISOString();
    if (maxEntries > 0 && samples.size > maxEntries) prune();
    return completed;
  }
  function enrich(rows) {
    const used = new Set();
    for (const row of rows) {
      if (row.source !== 'codex-local') continue;
      const matches = (byUsage.get(fingerprint(row)) || [])
        .filter(sample => !used.has(sample.request_id) && Math.abs(Date.parse(sample.ts) - Date.parse(row.ts)) <= 1000);
      // Native logs have no response ID. Only a unique match of thread, model,
      // exact usage and completion time can provide per-request measurements.
      if (matches.length !== 1) continue;
      const sample = matches[0];
      used.add(sample.request_id);
      row.status = sample.status; row.ms = sample.ms; row.ttfb_ms = sample.ttfb_ms; row.attempts = sample.attempts;
      row.ttft_ms = sample.ttft_ms ?? null;
    }
  }
  const status = () => ({ ...store.storageStatus(), received_events: receivedEvents, received_bytes: receivedBytes,
    completed_requests: samples.size, last_received_at: lastReceived });
  async function api({ req, url, readObject, send }) {
    if (url.pathname !== '/api/telemetry/codex') return false;
    if (req.method === 'GET') { send(200, status()); return true; }
    if (req.method !== 'POST') { send(405, { error: 'Method not allowed' }); return true; }
    if (!isJsonRequest(req)) { send(415, { error: 'Expected application/json' }); return true; }
    await restore();
    ingest(await readObject(), req.headers['content-length']);
    send(200, {});
    return true;
  }
  return { api, ingest, enrich, status, restore, flush: store.flush,
    async maintenance() { await store.maintenance(); prune(); } };
}

module.exports = { createCodexTelemetry };
