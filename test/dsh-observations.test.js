'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dshObservations, MAX_RECENT, MAX_SAMPLES } = require('../lib/dsh-observations');
const row = (i, extra = {}) => ({ ts: new Date(1792746000000 + i * 1000).toISOString(), model_in: 'mixr-dsh-worker',
  model_out: 'worker-real', provider: 'Test Channel', status: 200, ...extra });

test('empty observations do not claim runtime adoption or all-history totals', () => {
  assert.deepEqual(dshObservations([]), { scope: 'current_process_recent_requests', sample_count: 0,
    ok_count: 0, error_count: 0, cancelled_count: 0, last_request: null, recent: [], by_slot: [] });
  assert.equal(dshObservations(null).sample_count, 0);
});

test('only DSH aliases are included and streamed HTTP 200 errors are not counted as successes', () => {
  const result = dshObservations([row(1), row(4, { model_in: 'mixr-dsh-main', err_class: 'stream_aborted' }),
    row(3, { status: 499, err_class: 'cancelled' }), row(2, { err_class: 'econnreset' }),
    row(5, { model_in: 'mixr-main' }), row(0, { err: 'sanitized upstream failure' })]);
  assert.equal(result.sample_count, 5);
  assert.equal(result.ok_count, 1);
  assert.equal(result.error_count, 3);
  assert.equal(result.cancelled_count, 1);
  assert.equal(result.last_request.alias, 'mixr-dsh-main');
  assert.equal(result.last_request.outcome, 'error');
  assert.equal(result.by_slot.find(group => group.slot === 'worker').count, 4);
  assert.equal(result.by_slot.find(group => group.slot === 'worker').last_request.outcome, 'cancelled');
});

test('observations whitelist excludes content credentials session IDs and error bodies', () => {
  const sensitive = row(1, { prompt: 'secret-prompt', headers: { authorization: 'secret-key' }, api_key: 'secret-key',
    err: 'sensitive error body', response: 'secret-response', session: 'secret-session', request_id: 'secret-request',
    effort: 'low', slot: 'misleading-slot' });
  const result = dshObservations([sensitive]);
  assert.equal(JSON.stringify(result).includes('secret-'), false);
  assert.equal(JSON.stringify(result).includes('sensitive error body'), false);
  assert.equal(result.last_request.slot, 'worker', 'the DSH alias identifies its slot');
  assert.equal(result.last_request.effort, 'low');
  assert.deepEqual(Object.keys(result.last_request), ['ts', 'alias', 'slot', 'provider', 'model', 'status', 'err_class', 'outcome', 'effort']);
});

test('bounded records and samples keep the periodically refreshed page compact', () => {
  const result = dshObservations(Array.from({ length: MAX_SAMPLES + 100 }, (_, i) => row(i)));
  assert.equal(result.sample_count, MAX_SAMPLES);
  assert.equal(result.recent.length, MAX_RECENT);
  assert.ok(result.last_request.ts);
  const malformed = dshObservations([row(1, { provider: {}, model_out: 'x'.repeat(1000), status: '200', err_class: 'y'.repeat(1000) })]);
  assert.equal(malformed.last_request.provider, '');
  assert.equal(malformed.last_request.model.length, 256);
  assert.equal(malformed.last_request.err_class.length, 64);
  assert.equal(malformed.last_request.status, 0);
});
