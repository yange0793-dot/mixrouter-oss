'use strict';
// Summarize already-sanitized request-log metadata. The DSH page never needs
// request/response content, credentials, session identifiers, or error bodies.
const MAX_SAMPLES = 500;
const MAX_RECENT = 12;
const PREFIX = 'mixr-dsh-';
const text = (value, max = 256) => typeof value === 'string' ? value.slice(0, max) : '';
function routeRecord(row) {
  if (!row || typeof row !== 'object' || typeof row.model_in !== 'string' || !row.model_in.startsWith(PREFIX)) return null;
  const alias = text(row.model_in, 88);
  const status = Number.isSafeInteger(row.status) && row.status >= 0 && row.status <= 599 ? row.status : 0;
  const err_class = text(row.err_class, 64);
  const outcome = err_class === 'cancelled' || status === 499 ? 'cancelled'
    : err_class || (typeof row.err === 'string' && row.err.length) || status < 200 || status >= 400 ? 'error' : 'ok';
  return { ts: text(row.ts, 40), alias, slot: alias.slice(PREFIX.length), provider: text(row.provider, 200),
    model: text(row.model_out), status, err_class, outcome,
    ...(typeof row.effort === 'string' ? { effort: text(row.effort, 64) } : {}) };
}
function dshObservations(logs) {
  const source = Array.isArray(logs) ? logs.slice(0, MAX_SAMPLES) : [];
  const records = source.map(routeRecord).filter(Boolean).sort((a, b) => {
    const ta = Date.parse(a.ts), tb = Date.parse(b.ts);
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
  const count = rows => ({ count: rows.length, ok_count: rows.filter(row => row.outcome === 'ok').length,
    error_count: rows.filter(row => row.outcome === 'error').length,
    cancelled_count: rows.filter(row => row.outcome === 'cancelled').length });
  const totals = count(records);
  const by_slot = [];
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.slot)) groups.set(record.slot, []);
    groups.get(record.slot).push(record);
  }
  for (const [slot, rows] of groups) by_slot.push({ slot, ...count(rows), last_request: rows[0] });
  return { scope: 'current_process_recent_requests', sample_count: totals.count,
    ok_count: totals.ok_count, error_count: totals.error_count, cancelled_count: totals.cancelled_count,
    last_request: records[0] || null, recent: records.slice(0, MAX_RECENT), by_slot };
}
module.exports = { dshObservations, routeRecord, MAX_SAMPLES, MAX_RECENT };
