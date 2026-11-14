'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexTelemetry } = require('../lib/usage/codex-telemetry');
const { createUsageSummary } = require('../lib/usage/summary');
const { createLocalSessionUsage } = require('../lib/usage/local-sessions');
const { createApplication } = require('../lib/application');

const now = Date.now();
const iso = ms => new Date(now + ms).toISOString();
const event = (name, offset, fields = {}) => ({
  attributes: Object.entries({ 'event.name': name, 'event.timestamp': iso(offset),
    'conversation.id': 'thread-one', model: 'model-one', ...fields })
    .map(([key, value]) => ({ key, value: { stringValue: String(value) } })),
});
const request = (offset = -1000, fields = {}) => event('codex.api_request', offset, {
  endpoint: '/responses', duration_ms: 200, 'http.response.status_code': 200, attempt: 0, ...fields,
});
const complete = (offset = -500, fields = {}) => event('codex.sse_event', offset, {
  'event.kind': 'response.completed', input_token_count: 100, output_token_count: 10,
  cached_token_count: 40, cache_write_token_count: 0, ...fields,
});
const stream = (kind, offset, fields = {}) => event('codex.sse_event', offset, { 'event.kind': kind, duration_ms: 0, ...fields });
const batch = (...events) => ({ resourceLogs: [{ scopeLogs: [{ logRecords: events }] }] });
const local = (overrides = {}) => ({ ts: iso(-490), source: 'codex-local', app: 'codex',
  session: 'thread-one', model_out: 'model-one', in: 60, out: 10, cache_read: 40, cache_write: 0,
  status: null, ms: null, ttfb_ms: null, usage_normalized: true, ...overrides });
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-telemetry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'codex-telemetry.jsonl');
  return { root, file, tracker: createCodexTelemetry({ file, now: () => now, ...options }) };
}

test('native request and completion timing enrich one matching local row without duplicating tokens', async t => {
  const { tracker } = setup(t);
  await tracker.restore();
  tracker.ingest(batch(request(), complete()));
  const rows = [local(), local({ session: 'other-thread' })];
  tracker.enrich(rows);
  assert.equal(rows[0].status, 200);
  assert.equal(rows[0].ms, 700);
  assert.equal(rows[0].ttfb_ms, 200);
  assert.equal(rows[0].ttft_ms, null);
  assert.equal(rows[1].status, null);
  const result = await createUsageSummary({ memoryEntries: () => rows, now: () => now })
    .summarize({ range: 'today', dashboard: '1' });
  assert.equal(result.totals.reqs, 2);
  assert.equal(result.totals.tokens_total, 220);
  assert.equal(result.totals.speed_tps, 14.29);
  assert.equal(result.totals.ttfb_p50_ms, 200);
  assert.deepEqual(result.dashboard.outcomes, { succeeded: 1, failed: 0, unknown: 1 });
});

test('first output delta supplies request TTFT, not response headers, SSE processing duration or turn-level TTFT', async t => {
  const { tracker } = setup(t);
  tracker.ingest(batch(request(), stream('response.created', -950), stream('response.in_progress', -900),
    stream('response.output_item.added', -850), stream('response.content_part.added', -800),
    stream('response.output_text.delta', -700), stream('response.output_text.delta', -600),
    event('codex.turn_ttft', -700, { duration_ms: 5000 }), complete()));
  const rows = [local()];
  tracker.enrich(rows);
  assert.equal(rows[0].ms, 700);
  assert.equal(rows[0].ttfb_ms, 200);
  assert.equal(rows[0].ttft_ms, 500);
  assert.equal(rows[0].decode_ms, undefined, 'one observed delta does not establish full generation timing');
  const result = await createUsageSummary({ memoryEntries: () => rows, now: () => now })
    .summarize({ range: 'today', dashboard: '1' });
  assert.equal(result.totals.ttft_p50_ms, 500);
  assert.equal(result.totals.decode_tps, null);
  assert.equal(result.dashboard.records.rows[0].ttft_ms, 500);
});

test('reasoning and tool deltas identify first output; buffered completions and protocol events do not', t => {
  const { tracker } = setup(t);
  const kinds = ['response.reasoning_text.delta', 'response.reasoning_summary_text.delta',
    'response.function_call_arguments.delta', 'response.custom_tool_call_input.delta'];
  for (const [index, kind] of kinds.entries()) {
    const fields = { 'conversation.id': `thread-${index}` };
    tracker.ingest(batch(request(-1000, fields), stream(kind, -800, fields), complete(-500, fields)));
    const rows = [local({ session: fields['conversation.id'] })];
    tracker.enrich(rows);
    assert.equal(rows[0].ttft_ms, 400);
  }
  tracker.ingest(batch(request(), stream('response.created', -950), stream('response.output_item.done', -700), complete()));
  const rows = [local()];
  tracker.enrich(rows);
  assert.equal(rows[0].ttft_ms, null, 'no output delta means the first token remains unmeasured');
});

test('first-token timing survives exporter batches, duplicate requests, restart and zero-latency samples', async t => {
  const { tracker, file } = setup(t);
  tracker.ingest(batch(request(), stream('response.output_text.delta', -700)));
  tracker.ingest(batch(request(), stream('response.output_text.delta', -600), complete()));
  await tracker.flush();
  const restored = createCodexTelemetry({ file, now: () => now });
  await restored.restore();
  const rows = [local()];
  restored.enrich(rows);
  assert.equal(rows[0].ttft_ms, 500);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
  const fields = { 'conversation.id': 'zero', duration_ms: 0 };
  restored.ingest(batch(request(-1000, fields), stream('response.output_text.delta', -1000, fields), complete(-500, fields)));
  const zero = [local({ session: 'zero' })];
  restored.enrich(zero);
  assert.equal(zero[0].ttft_ms, 0);
});

test('retry starts reset the successful attempt token timestamp while retaining elapsed retry time', t => {
  const { tracker } = setup(t);
  tracker.ingest(batch(request(-2000, { 'http.response.status_code': 429 }),
    stream('response.output_text.delta', -1900), request(-1000, { attempt: 1 }),
    stream('response.output_text.delta', -600), complete()));
  const rows = [local()];
  tracker.enrich(rows);
  assert.equal(rows[0].ms, 1700);
  assert.equal(rows[0].ttfb_ms, 1200);
  assert.equal(rows[0].ttft_ms, 1600);
});

test('interleaved sessions and retries retain request-specific latency; HTTP headers alone are not success', async t => {
  const { tracker } = setup(t);
  tracker.ingest(batch(request(-2000, { 'http.response.status_code': 429 }), request(-1900, { 'conversation.id': 'other' })));
  const before = [local()];
  tracker.enrich(before);
  assert.equal(before[0].status, null);
  tracker.ingest(batch(request(-1000, { attempt: 1 }), complete()));
  const rows = [local()];
  tracker.enrich(rows);
  assert.equal(rows[0].ms, 1700);
  assert.equal(rows[0].ttfb_ms, 1200);
  assert.equal(rows[0].attempts, 2);
});

test('completion matching refuses wrong token counts, distant timestamps and ambiguous identical calls', t => {
  const { tracker } = setup(t);
  tracker.ingest(batch(request(), complete()));
  const rows = [local({ out: 11 }), local({ ts: iso(-5000) })];
  tracker.enrich(rows);
  assert.ok(rows.every(row => row.status === null));
  tracker.ingest(batch(request(-450), complete(-200)));
  const ambiguous = [local()];
  tracker.enrich(ambiguous);
  assert.equal(ambiguous[0].status, null);
});

test('thousands of stream events produce one compact persisted summary without prompts or tool content', async t => {
  const { tracker, file } = setup(t);
  tracker.ingest(batch(request(), ...Array.from({ length: 5000 }, () => event('codex.sse_event', -700, {
    'event.kind': 'message', prompt: 'PRIVATE-PROMPT', output: 'PRIVATE-TOOL-OUTPUT',
  })), complete()));
  await tracker.flush();
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.trim().split('\n').length, 1);
  assert.ok(Buffer.byteLength(text) < 1024);
  assert.doesNotMatch(text, /PRIVATE|api_key|prompt|output_token_count/);
  assert.equal(tracker.status().completed_requests, 1);
});

test('duplicate delivery and service restart keep one summary and preserve matching', async t => {
  const { tracker, file } = setup(t);
  const input = batch(request(), complete());
  tracker.ingest(input);
  tracker.ingest(input);
  await tracker.flush();
  assert.equal(tracker.status().completed_requests, 1);
  const restored = createCodexTelemetry({ file, now: () => now });
  await restored.restore();
  restored.ingest(input);
  assert.equal(restored.status().completed_requests, 1);
  const rows = [local()];
  restored.enrich(rows);
  assert.equal(rows[0].ms, 700);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
});

test('failed, incomplete and missing-status events cannot turn local usage into success', t => {
  const { tracker } = setup(t);
  tracker.ingest(batch(request(-2000, { 'http.response.status_code': 500 }), complete(-1500),
    request(), event('codex.sse_event', -500, { 'event.kind': 'error', error: 'broken' }), complete(-400)));
  const rows = [local()];
  tracker.enrich(rows);
  assert.equal(rows[0].status, null);
  assert.equal(tracker.status().completed_requests, 0);
  assert.throws(() => tracker.ingest({ resourceLogs: null }), error => error.statusCode === 400);
});

test('local session reader enriches from telemetry without adding another request', async t => {
  const { tracker, root } = setup(t);
  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, 'one.jsonl'), [
    { type: 'session_meta', timestamp: iso(-3000), payload: { id: 'thread-one', model_provider: 'direct' } },
    { type: 'turn_context', timestamp: iso(-2500), payload: { model: 'model-one' } },
    { type: 'token_usage_record', timestamp: iso(-490), payload: { thread_id: 'thread-one', response_id: 'response-one',
      usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  tracker.ingest(batch(request(), stream('response.output_text.delta', -700), complete()));
  const reader = createLocalSessionUsage({ codexHome: root, telemetry: tracker, now: () => now });
  const { rows } = await reader.read();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].request_id, 'codex:response-one');
  assert.equal(rows[0].status, 200);
  assert.equal(rows[0].ms, 700);
  assert.equal(rows[0].ttft_ms, 500);
  assert.equal(rows[0].source, 'codex-local');
});

test('retained summaries beyond the recent 1000-row window still enrich historical local usage after restart', async t => {
  const { tracker, file } = setup(t);
  for (let i = 0; i < 1005; i++) {
    tracker.ingest(batch(request(-2000 - i * 10, { 'conversation.id': `thread-${i}` }),
      complete(-1500 - i * 10, { 'conversation.id': `thread-${i}` })));
  }
  await tracker.flush();
  const restored = createCodexTelemetry({ file, now: () => now });
  await restored.restore();
  assert.equal(restored.status().completed_requests, 1005);
  const rows = [local({ session: 'thread-1004', ts: iso(-1500 - 1004 * 10) })];
  restored.enrich(rows);
  assert.equal(rows[0].status, 200);
});

test('collector endpoint accepts native JSON, rejects cross-site writes and exposes summary-only health', async t => {
  const { root } = setup(t);
  const app = createApplication({ root: path.resolve(__dirname, '..'), version: 'test', home: root,
    env: { MIXR_DATA_DIR: root, MIXROUTER_PORT: '0', MIXUI_PORT: '0' } });
  const server = await app.listen(0, app.apiHandler);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/telemetry/codex`;
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch(request(), complete())) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
  const health = await (await fetch(endpoint)).json();
  assert.equal(health.completed_requests, 1);
  assert.equal(health.received_events, 2);
  const denied = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: '{}' });
  assert.equal(denied.status, 403);
  const bad = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(bad.status, 415);
});
