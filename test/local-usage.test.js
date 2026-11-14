'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalSessionUsage } = require('../lib/usage/local-sessions');
const { createUsageSummary } = require('../lib/usage/summary');

const at = Date.now();
const iso = offset => new Date(at + offset).toISOString();
const usage = (input = 100, output = 10, cache = 40) => ({
  input_tokens: input, output_tokens: output, cached_input_tokens: cache, total_tokens: input + output,
});
const meta = (id = 'session-one', provider = 'mixr-provider-one') => ({
  type: 'session_meta', timestamp: iso(-10000),
  payload: { id, model_provider: provider, timestamp: iso(-10000), base_instructions: 'PRIVATE_PROMPT_SENTINEL' },
});
const context = (model = 'model-a') => ({ type: 'turn_context', timestamp: iso(-9000), payload: { model, turn_id: 'turn-one' } });
const counted = (u = usage(), total = u, offset = -2000) => ({
  type: 'event_msg', timestamp: iso(offset), payload: { type: 'token_count', info: { last_token_usage: u, total_token_usage: total } },
});
const modern = (id = 'response-one', u = usage(), total = u, offset = -2000) => ({
  type: 'token_usage_record', timestamp: iso(offset),
  payload: { thread_id: 'session-one', response_id: id, usage: u, thread_token_usage: total },
});
const claude = (id = 'message-one', override = {}) => ({
  type: 'assistant', sessionId: 'claude-session', timestamp: iso(-1000), requestedModel: 'claude-model',
  message: { id, model: 'claude-model', usage: { input_tokens: 20, output_tokens: 10,
    cache_read_input_tokens: 40, cache_creation_input_tokens: 30 }, content: [{ text: 'PRIVATE_PROMPT_SENTINEL' }] },
  ...override,
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-local-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, rows) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    return file;
  };
  const options = { codexHome: path.join(root, 'codex'), claudeHome: path.join(root, 'claude'),
    now: () => at, getProviders: () => ({ codex: [{ id: 'provider-one', name: 'Primary' }] }) };
  return { root, write, options, reader: createLocalSessionUsage(options) };
}

test('Codex modern and legacy records count each response once, preserve uncached input, and exclude content', async t => {
  const f = fixture(t);
  f.write('codex/sessions/one.jsonl', [meta(), context(), counted(), counted(), modern(),
    counted(usage(200, 20, 80), usage(300, 30, 120), -1000),
    modern('response-two', usage(200, 20, 80), usage(300, 30, 120), -1000)]);
  const result = await f.reader.read();
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.reduce((sum, row) => sum + row.in, 0), 180);
  assert.equal(result.rows.reduce((sum, row) => sum + row.cache_read, 0), 120);
  assert.equal(result.rows[0].provider, 'Primary');
  assert.equal(result.rows[0].provider_id, 'provider-one');
  assert.equal(result.rows[0].status, null);
  assert.equal(result.rows[0].ms, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT|base_instructions|api_key|one.jsonl/);
  assert.deepEqual(await f.reader.read(), result);
});

test('Codex old token_count remains supported and compaction snapshots do not replay the last usage', async t => {
  const f = fixture(t);
  f.write('codex/sessions/old.jsonl', [meta(), context(), counted(), counted(),
    counted(usage(), usage(50, 0, 0), -1500),
    counted(usage(80, 5, 20), usage(130, 5, 20), -1000)]);
  const { rows } = await f.reader.read();
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((sum, row) => sum + row.out, 0), 15);
});

test('Codex routing changes are read from the session, including direct providers whose names begin mixr-', async t => {
  const f = fixture(t);
  f.write('codex/sessions/switch.jsonl', [meta('session-one', 'mixr-router'), context('mixr-main'), counted(), modern(),
    { type: 'event_msg', timestamp: iso(-1500), payload: { type: 'thread_settings_applied',
      thread_settings: { model: 'model-b', model_provider_id: 'mixr-provider-one' } } },
    modern('response-two', usage(), usage(200, 20, 80), -1000)]);
  const result = await f.reader.read();
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].model_out, 'model-b');
  assert.equal(result.rows[0].provider, 'Primary');
  assert.equal(result.routed, 1);
});

test('incremental reads wait for complete lines and invalidate rewritten files', async t => {
  const f = fixture(t);
  const file = f.write('codex/sessions/partial.jsonl', [meta(), context(), modern()]);
  await f.reader.read();
  const row = JSON.stringify(modern('response-two', usage(150, 30, 60), usage(250, 40, 100), -1000));
  fs.appendFileSync(file, row.slice(0, -5));
  assert.equal((await f.reader.read()).rows.length, 1);
  fs.appendFileSync(file, row.slice(-5) + '\n');
  assert.equal((await f.reader.read()).rows.length, 2);
  f.write('codex/sessions/partial.jsonl', [meta(), context('model-new'), modern('response-new')]);
  const result = await f.reader.read();
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].model_out, 'model-new');
  fs.unlinkSync(file);
  assert.equal((await f.reader.read()).rows.length, 0);
});

test('archive copies, forked history, and Claude repeated blocks do not multiply usage; subagents are included', async t => {
  const f = fixture(t);
  const rows = [meta(), context(), modern()];
  f.write('codex/sessions/original.jsonl', rows);
  f.write('codex/archived_sessions/copy.jsonl', rows);
  f.write('codex/sessions/fork.jsonl', [meta('session-child'), context(), modern(),
    { ...modern('response-child'), payload: { ...modern('response-child').payload, thread_id: 'session-child' } }]);
  f.write('claude/projects/project/parent.jsonl', [claude(), claude()]);
  f.write('claude/projects/project/parent/subagents/child.jsonl', [claude('child-message')]);
  const result = await f.reader.read();
  assert.equal(result.rows.length, 4);
  const local = result.rows.filter(row => row.app === 'claude');
  assert.equal(local.length, 2);
  assert.equal(local[0].in, 50);
  assert.equal(local[0].cache_write, 30);
});

test('Claude alias routes and synthetic errors are excluded without assigning unknown providers to current settings', async t => {
  const f = fixture(t);
  f.write('claude/projects/project/one.jsonl', [claude('routed', { requestedModel: 'mixr-main' }),
    claude('synthetic', { message: { id: 'synthetic', model: '<synthetic>', usage: usage() } }),
    claude('direct')]);
  const result = await f.reader.read();
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].provider_id, '');
  assert.equal(result.routed, 1);
});

test('aggregate, filters, paging, details and outcomes share local usage; HTTP status stays unknown', async t => {
  const f = fixture(t);
  f.write('codex/sessions/one.jsonl', [meta(), context(), counted(), modern()]);
  const gateway = { ts: iso(-5000), app: 'codex', provider: 'Gateway', model_out: 'model-a',
    request_id: 'gateway-one', session: 'gateway-session', status: 500, in: 20, out: 2, cache_read: 0, ms: 1000 };
  const summary = createUsageSummary({ localUsage: f.reader, memoryEntries: () => [gateway], now: () => at });
  const result = await summary.summarize({ range: 'today', dashboard: '1', limit: 1 });
  assert.equal(result.totals.reqs, 2);
  assert.equal(result.totals.tokens_total, 132);
  assert.equal(result.totals.ok_rate, 0);
  assert.deepEqual(result.dashboard.outcomes, { succeeded: 0, failed: 1, unknown: 1 });
  assert.equal(result.dashboard.records.total, 2);
  assert.equal(result.dashboard.records.rows[0].source, 'codex-local');
  assert.equal(result.dashboard.records.rows[0].status, null);
  assert.equal(result.scope.local_usage.codex, 1);
  const unknown = await summary.summarize({ range: 'today', dashboard: '1', status: 'unknown', status_code: 'unknown' });
  assert.equal(unknown.totals.reqs, 1);
  assert.equal(unknown.totals.ok_rate, null);
  assert.equal(unknown.totals.speed_tps, null);
  assert.equal(unknown.dashboard.daily.reduce((sum, row) => sum + row.reqs, 0), 1);
  const failed = await summary.summarize({ range: 'today', dashboard: '1', status: 'err' });
  assert.equal(failed.totals.reqs, 1);
  const searched = await summary.summarize({ range: 'today', dashboard: '1', search: 'response-one', channel: 'id:provider-one' });
  assert.equal(searched.totals.reqs, 1);
});

test('legacy local Claude usage already present in the gateway is matched once', async t => {
  const f = fixture(t);
  f.write('claude/projects/project/one.jsonl', [claude('one', { requestedModel: undefined })]);
  const gateway = { ts: iso(-2000), app: 'claude', provider: 'Gateway', model_out: 'claude-model',
    session: 'claude-s', status: 200, in: 20, out: 10, cache_read: 40, ms: 1000 };
  const summary = createUsageSummary({ localUsage: f.reader, memoryEntries: () => [gateway], now: () => at });
  const result = await summary.summarize({ range: 'today', dashboard: '1' });
  assert.equal(result.totals.reqs, 1);
  assert.equal(result.scope.local_usage.duplicates_excluded, 1);
});

test('native OpenAI historical cache reads normalize once in aggregates and exported detail', async () => {
  const rows = [
    { wire: 'responses', in: 100, cache_read: 40 },
    { wire: 'chat', in: 100, cache_read: 40 },
    { wire: 'responses', in: 60, cache_read: 40, usage_normalized: true },
    { app: 'claude', wire: 'responses', in: 60, cache_read: 40 },
  ].map((row, index) => ({ ts: iso(-1000 - index), app: 'codex', status: 200, out: 10, ...row }));
  const summary = createUsageSummary({ memoryEntries: () => rows, now: () => at });
  const result = await summary.summarize({ range: 'today', dashboard: '1' });
  assert.equal(result.totals.tokens_total, 440);
  assert.deepEqual(result.dashboard.records.rows.map(row => row.in), [60, 60, 60, 60]);
  assert.equal(rows[0].in, 100, 'source records remain unchanged');
});

test('gateway cache writes are included once and normalized details can be read back', async () => {
  const row = { ts: iso(-1000), app: 'claude', wire: 'anthropic', status: 200, in: 20, out: 10, cache_read: 40, cache_write: 30 };
  const result = await createUsageSummary({ memoryEntries: () => [row], now: () => at }).summarize({ range: 'today', dashboard: '1' });
  assert.equal(result.totals.tokens_total, 100);
  assert.equal(result.dashboard.records.rows[0].in, 50);
  const replay = await createUsageSummary({ memoryEntries: () => result.dashboard.records.rows, now: () => at }).summarize({ range: 'today' });
  assert.equal(replay.totals.tokens_total, 100);
});

test('memory requests with earlier start times are not lost when absent from the disk log', async t => {
  const f = fixture(t);
  const late = { ts: iso(-1000), request_id: 'on-disk', status: 200, in: 10 };
  const early = { ts: iso(-2000), request_id: 'memory-only', status: 200, in: 20 };
  const file = f.write('requests.jsonl', [late]);
  const result = await createUsageSummary({ file, memoryEntries: () => [late, early], now: () => at }).summarize({ range: 'today' });
  assert.equal(result.totals.reqs, 2);
  assert.equal(result.totals.tokens_in, 30);
});
