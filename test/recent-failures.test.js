'use strict';
// 概览失败聚合(/api/state 的 recent_failures)的行为回归。
// 只用内存环(file:null)与注入时钟:不建目录、不落盘、不碰现役 logs/。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createRequestLog, RECENT_FAILURES_TTL_MS, RECENT_FAILURES_TOP,
} = require('../lib/observability/request-log');

let clock = 0;
const entry = over => ({
  ts: '2026-11-14T10:00:00.000Z', app: 'claude', provider: 'FAKE-渠道', model_in: 'm-in', model_out: 'm-out',
  status: 200, err: '', err_class: '', ...over,
});
function newLog(options = {}) {
  clock = 1_000_000;
  return createRequestLog({ file: null, now: () => clock, ...options });
}

test('只统计 status >= 400;200 的成功与断流都不进失败聚合', () => {
  const log = newLog();
  log.append(entry({ status: 200, model_in: 'claude-x' }));
  // 断流条目 status 仍是 200,失败由 err/err_class 表达 —— 不改变"HTTP 失败"的口径。
  log.append(entry({ status: 200, err_class: 'stream_aborted', model_in: 'claude-x' }));
  log.append(entry({ status: 503, err_class: 'no_route_error', model_in: 'gpt-6.1-sol' }));
  log.append(entry({ status: 503, err_class: 'no_route_error', model_in: 'gpt-6.1-sol' }));
  log.append(entry({ status: 503, err_class: 'no_route_error', model_in: 'claude-x' }));
  log.append(entry({ status: 500, err_class: 'upstream_server', model_in: 'claude-x' }));
  log.append(entry({ status: 401, err_class: 'authentication', model_in: 'claude-x' }));

  const recent = log.recentFailures();
  assert.deepEqual(recent, {
    total: 7,
    failed: 5,
    by_class: { no_route_error: 3, upstream_server: 1, authentication: 1 },
    // 计数降序;计数相同按 err_class、model_in 升序兜底,保证顺序稳定。
    top: [
      { model_in: 'gpt-6.1-sol', err_class: 'no_route_error', count: 2 },
      { model_in: 'claude-x', err_class: 'authentication', count: 1 },
      { model_in: 'claude-x', err_class: 'no_route_error', count: 1 },
      { model_in: 'claude-x', err_class: 'upstream_server', count: 1 },
    ],
  });
});

test('窗口里没有失败(或环为空)时 failed=0,不凭空造分类', () => {
  const empty = newLog();
  assert.deepEqual(empty.recentFailures(), { total: 0, failed: 0, by_class: {}, top: [] });

  const ok = newLog();
  ok.append(entry({ status: 200 }));
  ok.append(entry({ status: 302 }));
  assert.deepEqual(ok.recentFailures(), { total: 2, failed: 0, by_class: {}, top: [] });
});

test('total 跟着环形缓冲容量走:淘汰后的窗口只算还在环里的请求', () => {
  const log = newLog({ capacity: 2 });
  log.append(entry({ status: 500, err_class: 'upstream_server', model_in: 'old' }));
  log.append(entry({ status: 503, err_class: 'no_route_error', model_in: 'middle' }));
  log.append(entry({ status: 503, err_class: 'no_route_error', model_in: 'new' }));
  const recent = log.recentFailures();
  assert.equal(recent.total, 2);
  assert.equal(recent.failed, 2);
  assert.deepEqual(recent.by_class, { no_route_error: 2 });
  assert.equal(recent.top[0].model_in, 'middle');
  assert.ok(!JSON.stringify(recent).includes('old'), '被淘汰的条目不再计入');
});

test('缺 err_class / model_in 不是 string 时给出可读兜底,不把对象塞进响应', () => {
  const log = newLog();
  log.append(entry({ status: 500, err_class: undefined, model_in: 42 }));
  log.append(entry({ status: 502, err_class: '', model_in: { prompt: 'PRIVATE' } }));
  const recent = log.recentFailures();
  assert.deepEqual(recent.by_class, { unknown: 2 });
  assert.deepEqual(recent.top, [{ model_in: '(未知模型)', err_class: 'unknown', count: 2 }]);
  assert.ok(!JSON.stringify(recent).includes('PRIVATE'));
});

test('top 有上限:分类基数再大也只回固定条数', () => {
  const log = newLog({ capacity: 200 });
  for (let i = 0; i < RECENT_FAILURES_TOP * 3; i++) {
    log.append(entry({ status: 500, err_class: 'upstream_server', model_in: 'model-' + String(i).padStart(2, '0') }));
  }
  assert.equal(log.recentFailures().top.length, RECENT_FAILURES_TOP);
});

test('缓存:10 秒内且环未变不重复扫描;TTL 到期或环变化才重算', () => {
  const log = newLog();
  log.append(entry({ status: 503, err_class: 'no_route_error' }));
  const first = log.recentFailures();
  assert.equal(log._recentFailuresComputations(), 1);

  clock += RECENT_FAILURES_TTL_MS - 1;
  assert.equal(log.recentFailures(), first, '未过期且环未变:直接复用缓存');
  log.recentFailures();
  assert.equal(log._recentFailuresComputations(), 1);

  clock += 1; // 恰好到期
  log.recentFailures();
  assert.equal(log._recentFailuresComputations(), 2);

  clock += 1;
  log.recentFailures();
  assert.equal(log._recentFailuresComputations(), 2, '新缓存继续在 TTL 内复用');

  log.append(entry({ status: 500, err_class: 'upstream_server' }));
  const next = log.recentFailures();
  assert.equal(log._recentFailuresComputations(), 3, '环版本变化立即失效');
  assert.equal(next.failed, 2);
});

test('脱敏:聚合里只出现 model_in / err_class / 计数,不带 err 正文、Key 或 prompt', () => {
  const log = newLog({ secrets: ['FAKE-SECRET-KEY'] });
  log.append(entry({
    status: 500, err_class: 'upstream_server', model_in: 'FAKE-SECRET-KEY-model',
    err: 'upstream rejected FAKE-SECRET-KEY', prompt: 'PRIVATE-PROMPT', api_key: 'FAKE-SECRET-KEY',
  }));
  const recent = log.recentFailures();
  const json = JSON.stringify(recent);
  for (const leak of ['FAKE-SECRET-KEY', 'PRIVATE-PROMPT', 'upstream rejected']) {
    assert.equal(json.includes(leak), false, `聚合不得带出 ${leak}`);
  }
  assert.deepEqual(Object.keys(recent).sort(), ['by_class', 'failed', 'top', 'total']);
  assert.deepEqual(Object.keys(recent.top[0]).sort(), ['count', 'err_class', 'model_in']);
});
