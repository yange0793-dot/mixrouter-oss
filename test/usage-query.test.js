'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsageSummary } = require('../lib/usage/summary');

const now = new Date(2026, 10, 6, 18).getTime();
const rows = [
  { request_id: 'req-alpha', session: 'cx:session-one', provider: 'Primary', provider_id: 'provider-one', model_in: 'mixr-main', model_out: 'Model-A', status: 200, in: 10, out: 100, cache_read: 90, ms: 2000, ttfb_ms: 100 },
  { request_id: 'req-beta', session: 'cx:session-one', provider: 'Primary', provider_id: 'provider-one', model_out: 'Model-B', status: 200, err_class: 'stream_aborted', in: 20, out: 20, cache_read: 180, ms: 1000, ttfb_ms: 300 },
  { request_id: 'req-gamma', session: 'cx:session-two', provider: 'Backup', provider_id: 'provider-two', model_out: 'Model-A', status: 429, err: 'slow down', in: 0, out: 0, cache_read: 0, ms: 3000, ttfb_ms: 200 },
  { request_id: 'req-delta', session: 'cx:session-two', provider: 'Backup', provider_id: 'provider-two', model_out: 'Model-C', status: 0, err: 'connect failed', in: 0, out: 0, cache_read: 0, ms: 0 },
].map((row, index) => ({ ts: new Date(now - (index + 1) * 60000).toISOString(), app: 'codex', ...row }));

const summary = records => createUsageSummary({ memoryEntries: () => records || rows, now: () => now });
const query = { range: 'today', dashboard: '1' };

test('搜索在分页前匹配模型、别名、渠道、请求 ID 与会话；全部统计一致', async () => {
  for (const [search, expected] of [['model-a', 2], ['MIXR-MAIN', 1], ['primary', 2], ['provider-two', 2], ['REQ-ALPHA', 1], ['session-one', 2]]) {
    const result = await summary().summarize({ ...query, search, limit: 1 });
    assert.equal(result.totals.reqs, expected, search);
    assert.equal(result.dashboard.records.total, expected, search);
    assert.equal(result.dashboard.daily.reduce((total, day) => total + day.reqs, 0), expected);
    assert.equal(result.by_model.reduce((total, model) => total + model.reqs, 0), expected);
    assert.equal(result.dashboard.by_channel.reduce((total, channel) => total + channel.reqs, 0), expected);
    assert.equal(result.dashboard.records.rows.length, 1);
  }
  const filtered = await summary().summarize({ ...query, search: 'primary', channel: 'id:provider-one', model: 'Model-B' });
  assert.equal(filtered.totals.tokens_in, 20);
  assert.equal(filtered.totals.cache_read, 180);
  assert.equal(filtered.dashboard.records.rows[0].request_id, 'req-beta');
});

test('HTTP 状态码与最终结果独立组合，HTTP 200 断流仍然失败', async () => {
  const result = await summary().summarize({ ...query, status_code: '200', status: 'err' });
  assert.equal(result.totals.reqs, 1);
  assert.deepEqual(result.dashboard.outcomes, { succeeded: 0, failed: 1 });
  assert.equal(result.dashboard.records.rows[0].request_id, 'req-beta');
  const disconnected = await summary().summarize({ ...query, status_code: '0' });
  assert.equal(disconnected.dashboard.records.rows[0].request_id, 'req-delta');
  assert.equal(disconnected.dashboard.facets.status_codes.find(facet => facet.value === '0').label, '未收到响应');
  const missing = await summary().summarize({ ...query, status_code: '503' });
  assert.equal(missing.dashboard.records.total, 0);
  assert.ok(missing.dashboard.facets.status_codes.some(facet => facet.value === '503'));
});

test('全量排序后再分页，数值排序与时间排序互不混淆', async () => {
  const first = await summary().summarize({ ...query, sort: 'in', order: 'desc', limit: 1 });
  assert.equal(first.dashboard.records.rows[0].request_id, 'req-beta');
  assert.equal(first.dashboard.records.sort, 'in');
  assert.equal(first.dashboard.records.order, 'desc');
  const second = await summary().summarize({ ...query, sort: 'in', order: 'desc', limit: 1, offset: 1 });
  assert.equal(second.dashboard.records.rows[0].request_id, 'req-alpha');
  assert.equal(second.totals.tokens_in, first.totals.tokens_in);
  const oldest = await summary().summarize({ ...query, sort: 'ts', order: 'asc', limit: 1 });
  assert.equal(oldest.dashboard.records.rows[0].request_id, 'req-delta');
  const latency = await summary().summarize({ ...query, sort: 'ttfb_ms', order: 'asc' });
  assert.deepEqual(latency.dashboard.records.rows.map(row => row.request_id), ['req-alpha', 'req-gamma', 'req-beta', 'req-delta']);
});

test('速度排序把未测得的数据放最后，不当作最快或最慢样本', async () => {
  for (const order of ['asc', 'desc']) {
    const result = await summary().summarize({ ...query, sort: 'speed_tps', order });
    assert.deepEqual(result.dashboard.records.rows.slice(0, 2).map(row => row.request_id), order === 'asc' ? ['req-beta', 'req-alpha'] : ['req-alpha', 'req-beta']);
    assert.deepEqual(result.dashboard.records.rows.slice(2).map(row => row.request_id), ['req-gamma', 'req-delta']);
  }
});

test('成功率四舍五入到 100% 也不丢失真实失败次数', async () => {
  const records = Array.from({ length: 20001 }, (_, index) => ({ ...rows[0], request_id: `count-${index}`, err: index === 0 ? 'one failure' : '' }));
  const result = await summary(records).summarize({ ...query, limit: 1 });
  assert.equal(result.totals.ok_rate, 100);
  assert.deepEqual(result.dashboard.outcomes, { succeeded: 20000, failed: 1 });
});

test('查询参数在 API 边界校验；老接口不改变过滤与响应契约', async () => {
  for (const params of [{ search: 'x'.repeat(201) }, { status_code: '-1' }, { status_code: '600' }, { sort: 'constructor' }, { sort: 'missing' }, { order: 'sideways' }]) {
    await assert.rejects(summary().summarize({ ...query, ...params }), error => error.statusCode === 400);
  }
  const result = await summary().summarize({ range: 'all', search: 'not-found', status_code: '200', sort: 'missing', order: 'sideways' });
  assert.equal(result.totals.reqs, rows.length);
  assert.equal('dashboard' in result, false);
  assert.equal('pricing' in result, false);
});

test('近期明细只分页最近 1000 条，完整聚合和历史查询不被截断', async () => {
  const records = Array.from({ length: 1205 }, (_, index) => ({
    ...rows[0], ts: new Date(now - index * 1000).toISOString(), request_id: `recent-${index}`, in: index,
  }));
  const recent = await summary(records).summarize({ ...query, records_scope: 'recent', limit: 50, offset: 950 });
  assert.equal(recent.totals.reqs, 1205);
  assert.equal(recent.dashboard.by_channel[0].reqs, 1205);
  assert.equal(recent.dashboard.daily[0].reqs, 1205);
  assert.equal(recent.dashboard.records.total, 1000);
  assert.equal(recent.dashboard.records.matched_total, 1205);
  assert.equal(recent.dashboard.records.scope, 'recent');
  assert.equal(recent.dashboard.records.has_more, false);
  assert.equal(recent.dashboard.records.rows[49].request_id, 'recent-999');
  const sorted = await summary(records).summarize({ ...query, records_scope: 'recent', sort: 'in', order: 'desc', limit: 1 });
  assert.equal(sorted.dashboard.records.rows[0].request_id, 'recent-999', 'sort only the recent window, not the largest value in all history');
  const history = await summary(records).summarize({ ...query, records_scope: 'history', offset: 1200 });
  assert.equal(history.dashboard.records.total, 1205);
  assert.equal(history.dashboard.records.rows.length, 5);
  assert.deepEqual(history.totals, recent.totals);
  const legacy = await summary(records).summarize(query);
  assert.equal(legacy.dashboard.records.total, 1205);
  await assert.rejects(summary(records).summarize({ ...query, records_scope: 'bogus' }), error => error.statusCode === 400);
});

test('自定义日期包括末日最后一毫秒，不包含下一天', async () => {
  const start = new Date(2026, 10, 5).getTime();
  const end = new Date(2026, 10, 6).getTime();
  const records = [start - 1, start, end - 1, end].map((time, index) => ({ ...rows[0], ts: new Date(time).toISOString(), request_id: `date-${index}` }));
  const result = await summary(records).summarize({ dashboard: '1', from: new Date(start).toISOString(), to: new Date(end - 1).toISOString() });
  assert.equal(result.totals.reqs, 2);
  assert.deepEqual(result.dashboard.records.rows.map(row => row.request_id), ['date-2', 'date-1']);
});
