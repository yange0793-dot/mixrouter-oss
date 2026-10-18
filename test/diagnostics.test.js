'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run, options, LIMITS } = require('../lib/diagnostics/run');
const { parse } = require('../scripts/diagnose-upstream');

test('diagnostics: strict offline arguments reject arbitrary remote targets', () => {
  for (const [key, max] of Object.entries(LIMITS)) {
    for (const value of [0, -1, max + 1, 1.5, Infinity, NaN, '2']) assert.throws(() => options({ [key]: value }));
  }
  for (const argv of [['--url', 'https://example.com'], ['--requests', '1e2'], ['--requests', '2', '--requests', '3'], ['--timeout-ms']]) assert.throws(() => parse(argv));
  assert.throws(() => options({ scenario: 'unknown' }));
  assert.throws(() => options({ url: 'http://localhost' }));
});

test('diagnostics: real router failover for 429, 500 and first-byte timeout', async () => {
  for (const scenario of ['success', '429', '500', 'first-byte', '401']) {
    const result = await run({ scenario, requests: 1, concurrency: 1 });
    const log = result.evidence.logs[0];
    const failsOver = ['429', '500', 'first-byte'].includes(scenario);
    assert.equal(result.requests, 1);
    assert.equal(result.upstreamRequests, failsOver ? 2 : 1, JSON.stringify(result));
    assert.equal(log.failover, failsOver);
    assert.equal(log.attempts, failsOver ? 2 : 1);
    assert.equal(result.rows[0].status, scenario === '401' ? 401 : 200);
    assert.equal(result.clientTimeouts, 0);
    if (scenario === 'first-byte') assert.ok(result.rows[0].ms >= result.budgets.first - 30);
  }
});

test('diagnostics: committed stream idle and total budgets do not fail over', async () => {
  for (const scenario of ['idle', 'deadline']) {
    const result = await run({ scenario, requests: 1, concurrency: 1 });
    assert.equal(result.upstreamRequests, 1);
    assert.equal(result.evidence.logs[0].failover, false);
    assert.equal(result.routerTimeouts, 1, JSON.stringify(result));
    assert.equal(result.clientTimeouts, 0);
    assert.equal(result.rows[0].status, 200, 'already committed HTTP status cannot be changed');
    const budget = scenario === 'idle' ? result.budgets.idle : result.budgets.total;
    assert.ok(result.rows[0].ms >= budget - 40);
    assert.ok(result.rows[0].ms < 2500);
    assert.match(result.evidence.logs[0].err, scenario === 'idle' ? /idle|空闲/ : /总预算/);
  }
});

test('diagnostics: finite concurrent run and cancellation cleanly return', async () => {
  const result = await run({ scenario: 'first-byte', concurrency: 3, requests: 6 });
  assert.equal(result.requests, 6);
  assert.ok(result.peakConcurrency <= 3);
  assert.ok(result.upstreamRequests <= result.upstreamRequestCap);
  assert.equal(Object.values(result.statusDistribution).reduce((a, b) => a + b, 0), 6);
  const short = await run({ scenario: 'first-byte', concurrency: 2, requests: 100, durationMs: 50 });
  assert.equal(short.cancelled, true);
  assert.ok(short.requests <= 2);
  assert.ok(short.elapsedMs < 2000);
  const timed = await run({ scenario: 'first-byte', requests: 1, timeoutMs: 30 });
  assert.equal(timed.clientTimeouts, 1);
  assert.equal(timed.rows[0].error, 'client-timeout');
  const controller = new AbortController();
  controller.abort();
  const cancelled = await run({ requests: 10 }, { signal: controller.signal });
  assert.equal(cancelled.requests, 0);
  assert.equal(cancelled.cancelled, true);
});
