'use strict';
// 用量统计(/api/usage)与 ttfb_ms 落盘的回归。
//
// 价目表与成本整块删除之后,这里只剩用量本身:请求数、token、缓存命中率、速率、TTFB 分位。
// 造数方式分两层:
//   · 聚合:直接写 requests.jsonl 的合成行,时间点相对 now 定,不受运行时刻影响;
//   · ttfb_ms:走真代理请求 → mock 上游 → requests.jsonl,证明字段确实从代理写到了磁盘。
// 两条都只用生产路径:合成行是日志文件本身的格式,不是测试专用后门。
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMockUpstream } = require('./mock-upstream.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-usage-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_ZCODE_CONFIG = path.join(TMP, 'zcode-config.json');

const LOG_DIR = path.join(TMP, 'logs');
const LOG = path.join(LOG_DIR, 'requests.jsonl');
const SECRET = 'sk-USAGE-SENTINEL-DO-NOT-LEAK';
fs.mkdirSync(LOG_DIR, { recursive: true });

const NOW = Date.now();
const iso = ms => new Date(ms).toISOString();
const MIN = 60000;

// 4 条合成日志:24h 内 2 条(一成一败)、2 天前 1 条、40 天前 1 条。
// 数值刻意取整,便于手算总量/速率。
const synthetic = [
  { ts: iso(NOW - 10 * MIN), app: 'claude', provider: '渠道A', model_in: 'claude-sonnet-4-5', model_out: 'claude-sonnet-4-5',
    status: 200, in: 1000000, out: 100000, cache_read: 200000, ms: 2000, ttfb_ms: 300, err: '' },
  { ts: iso(NOW - 90 * MIN), app: 'claude', provider: '渠道B', model_in: 'gpt-5', model_out: 'gpt-5',
    status: 500, in: 500000, out: 50000, cache_read: 0, ms: 1000, ttfb_ms: 500, err: 'upstream boom' },
  { ts: iso(NOW - 2 * 24 * 60 * MIN), app: 'claude', provider: '渠道A', model_in: 'unknown-model-x', model_out: 'unknown-model-x',
    status: 200, in: 10, out: 5, cache_read: 0, ms: 0, ttfb_ms: 0, err: '' },
  { ts: iso(NOW - 40 * 24 * 60 * MIN), app: 'claude', provider: '渠道A', model_in: 'claude-haiku-4-5', model_out: 'claude-haiku-4-5',
    status: 200, in: 100, out: 100, cache_read: 0, ms: 0, ttfb_ms: 0, err: '' },
];
fs.writeFileSync(LOG, synthetic.map(e => JSON.stringify(e)).join('\n') + '\n');

const { createUsageSummary } = require('../lib/usage/summary');

const mock = createMockUpstream();
let mod, proxySrv, uiSrv, proxyPort, uiPort, mockPort;

const raw = (port, method, p, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({
    hostname: '127.0.0.1', port, method, path: p,
    headers: { host: `127.0.0.1:${port}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
  }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});
const ui = (m, p, body) => raw(uiPort, m, p, body);
const ask = model => raw(proxyPort, 'POST', '/v1/messages', {
  model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }],
});
const json = async (m, p, body) => {
  const r = await ui(m, p, body);
  return { ...r, body: JSON.parse(r.text) };
};

test('setup:mock 上游 + 两个服务 + 一条可用路由', async () => {
  await new Promise(ok => mock.server.listen(0, '127.0.0.1', ok));
  mockPort = mock.server.address().port;
  mock.server.unref();
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({
    version: 2, current: { claude: 'p-mock', codex: null },
    claude: [{ id: 'p-mock', name: '回显渠道', base_url: `http://127.0.0.1:${mockPort}`, api_key: SECRET, enabled: true, models: ['echo-model'] }],
    codex: [],
  }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({
    rules: [{ id: 'r-echo', match: 'echo-model', provider: 'p-mock', model: 'echo-model', enabled: true }],
    default: { provider: '', model: '' },
  }));
  fs.writeFileSync(path.join(TMP, 'slots.json'), JSON.stringify({ version: 1, claude: {}, codex: {} }));
  mod = require('../mixrouter.js');
  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  proxySrv.unref(); uiSrv.unref();
});

test('summary:24h 过滤、totals 数值与 by_provider/by_model', async () => {
  const summary = createUsageSummary({ file: LOG });
  const out = await summary.summarize({ range: '24h' });

  assert.strictEqual(out.scope.bucket, 'hour');
  assert.strictEqual(out.scope.source, 'disk+memory');
  assert.ok(out.scope.from < out.scope.to);
  assert.strictEqual(out.totals.reqs, 2);
  assert.strictEqual(out.totals.ok_rate, 50);
  assert.strictEqual(out.totals.tokens_in, 1500000);
  assert.strictEqual(out.totals.tokens_out, 150000);
  assert.strictEqual(out.totals.cache_read, 200000);
  assert.strictEqual(out.totals.tokens_total, 1850000);
  assert.strictEqual(out.totals.cache_hit_rate, 0.1176);       // 200k / (1.5M + 200k)
  assert.strictEqual(out.totals.speed_tps, 50000);             // 150k tokens / 3s
  assert.strictEqual(out.totals.ttfb_p50_ms, 300);             // 最近邻,两样本取第 1 个
  // 响应里不该再有任何金额:价目表删除后总计只有用量,前端的"成本"格子也已移除
  assert.equal('cost' in out.totals, false);
  assert.equal('pricing' in out, false);

  assert.strictEqual(out.by_provider.length, 2);
  const pa = out.by_provider.find(p => p.name === '渠道A');
  assert.deepStrictEqual(pa, { provider: '渠道A', name: '渠道A', reqs: 1, tokens_in: 1000000, tokens_out: 100000, cache_read: 200000 });
  assert.strictEqual(out.by_model.find(m => m.model === 'gpt-5').cost, undefined);
});

test('summary:range 过滤(7d/all/自定义)', async () => {
  const summary = createUsageSummary({ file: LOG });

  const week = await summary.summarize({ range: '7d' });
  assert.strictEqual(week.scope.bucket, 'day');
  assert.strictEqual(week.totals.reqs, 3);

  const all = await summary.summarize({ range: 'all' });
  assert.strictEqual(all.totals.reqs, 4);
  assert.strictEqual(all.scope.bucket, 'day');

  const custom = await summary.summarize({ from: iso(NOW - 2 * 60 * MIN), to: iso(NOW) });
  assert.strictEqual(custom.scope.bucket, 'hour');
  assert.strictEqual(custom.totals.reqs, 2, '自定义区间同样包含 10 分钟前与 90 分钟前两条');

  const day = await summary.summarize({ range: '30d' });
  assert.strictEqual(day.totals.reqs, 3);

  // 过滤:app 精确、provider/model 子串
  assert.strictEqual((await summary.summarize({ range: 'all', provider: '渠道b' })).totals.reqs, 1);
  assert.strictEqual((await summary.summarize({ range: 'all', model: 'sonnet' })).totals.reqs, 1);
  assert.strictEqual((await summary.summarize({ range: 'all', app: 'codex' })).totals.reqs, 0);
});

test('summary:series 按小时补齐空桶,桶内合计等于 totals', async () => {
  const out = await createUsageSummary({ file: LOG }).summarize({ range: '24h' });
  assert.ok(out.series.length >= 24 && out.series.length <= 26, `24h 应有 24~26 个小时桶,实得 ${out.series.length}`);
  for (const b of out.series) assert.match(b.t, /^\d{4}-\d{2}-\d{2}T\d{2}:00$/);
  for (let i = 1; i < out.series.length; i++) {
    const prev = new Date(out.series[i - 1].t).getTime();
    const cur = new Date(out.series[i].t).getTime();
    assert.strictEqual(cur - prev, 3600000, '相邻桶必须正好差 1 小时(不能断)');
  }
  assert.strictEqual(out.series.reduce((n, b) => n + b.reqs, 0), out.totals.reqs);
  assert.ok(out.series.some(b => b.reqs === 0), '没有数据的时段必须以 0 值桶出现');

  const daily = await createUsageSummary({ file: LOG }).summarize({ range: '7d' });
  assert.ok(daily.series.length >= 7 && daily.series.length <= 8);
  for (const b of daily.series) assert.match(b.t, /^\d{4}-\d{2}-\d{2}$/);
});

test('summary:磁盘增量缓存 —— 追加一行后第二次查询能看到,且不重复旧行', async () => {
  const file = path.join(LOG_DIR, 'cache.jsonl');
  const line = n => JSON.stringify({ ts: iso(NOW - n * MIN), app: 'claude', provider: '渠道A',
    model_in: 'claude-haiku-4-5', model_out: 'claude-haiku-4-5', status: 200, in: 1, out: 1, cache_read: 0, ms: 1, ttfb_ms: 1, err: '' });
  fs.writeFileSync(file, line(5) + '\n');
  const summary = createUsageSummary({ file });
  assert.strictEqual((await summary.summarize({ range: '24h' })).totals.reqs, 1);
  fs.appendFileSync(file, line(4) + '\n');
  const second = await summary.summarize({ range: '24h' });
  assert.strictEqual(second.totals.reqs, 2, '新增行要被增量读到');
  assert.strictEqual(second.totals.tokens_in, 2, '旧行不能被重复计数');
  // 并发查询不能从同一个 offset 各读一遍(缓存是有状态的,调用被串行化)
  fs.appendFileSync(file, line(3) + '\n');
  const [p1, p2] = await Promise.all([
    summary.summarize({ range: '24h' }), summary.summarize({ range: '24h' }),
  ]);
  assert.strictEqual(p1.totals.reqs, 3);
  assert.strictEqual(p2.totals.reqs, 3);
  // 再查一次(无新行)结果稳定,说明缓存里没有留下重复行
  assert.deepStrictEqual((await summary.summarize({ range: '24h' })).totals, p2.totals);
});

test('/api/pricing 已整体删除:GET 与 PUT 都是 404', async () => {
  // 价目表删除后这个路径就是个不存在的端点,不能只删掉 GET 而把 PUT 留着(那样
  // 控制台旧页面还能把 pricing.json 写回来,读的人会以为成本又算上了)
  for (const method of ['GET', 'PUT']) {
    const r = await ui(method, '/api/pricing', method === 'PUT' ? { models: {} } : undefined);
    assert.strictEqual(r.status, 404, `${method} /api/pricing 应回 404`);
    assert.ok(!fs.existsSync(path.join(TMP, 'pricing.json')), '不能再有任何价目表落盘');
  }
});

test('API GET /api/usage:结构、过滤、400 与无密钥', async () => {
  const r = await json('GET', '/api/usage?range=24h');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.body).sort(),
    ['by_model', 'by_provider', 'scope', 'series', 'totals']);
  assert.deepStrictEqual(Object.keys(r.body.totals).sort(),
    ['cache_hit_rate', 'cache_read', 'ok_rate', 'reqs', 'speed_tps', 'tokens_in', 'tokens_out', 'tokens_total', 'ttfb_p50_ms']);
  // 每个序列桶也只带用量:前端画的是曲线,不是金额
  for (const b of r.body.series)
    assert.deepStrictEqual(Object.keys(b).sort(), ['cache_read', 'reqs', 't', 'tokens_in', 'tokens_out']);
  for (const row of [...r.body.by_provider, ...r.body.by_model])
    assert.equal('cost' in row, false, `by_provider/by_model 不该再有 cost:${JSON.stringify(row)}`);
  assert.strictEqual(r.body.totals.reqs, 2);
  assert.strictEqual(r.body.scope.bucket, 'hour');

  const filtered = await json('GET', '/api/usage?range=all&provider=' + encodeURIComponent('渠道B'));
  assert.strictEqual(filtered.body.totals.reqs, 1);
  assert.strictEqual(filtered.body.by_provider[0].name, '渠道B');

  const bad = await json('GET', '/api/usage?range=fortnight');
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.code, 'USAGE_RANGE_INVALID');
  const halfRange = await json('GET', '/api/usage?from=' + encodeURIComponent(iso(NOW - 60000)));
  assert.strictEqual(halfRange.status, 400, 'from/to 必须成对');
  const reversed = await json('GET', '/api/usage?from=' + encodeURIComponent(iso(NOW)) + '&to=' + encodeURIComponent(iso(NOW - 60000)));
  assert.strictEqual(reversed.status, 400);

  assert.ok(!r.text.includes(SECRET), '用量响应不得出现渠道 Key');
});

test('API /api/usage:by_provider/by_model 按请求数降序,同数按名字', async () => {
  // 合成行改成"渠道A 三条、渠道B 一条",并让两个名字比请求数更能区分排序键:
  // 降序在前,同数时按名字升序 —— 排序口径写在 summary.js 里,这条钉住它不被改回按金额
  const file = path.join(LOG_DIR, 'rank.jsonl');
  const row = (provider, model, minutesAgo) => JSON.stringify({ ts: iso(NOW - minutesAgo * MIN), app: 'claude',
    provider, model_in: model, model_out: model, status: 200, in: 1, out: 1, cache_read: 0, ms: 1, ttfb_ms: 1, err: '' });
  fs.writeFileSync(file, [
    row('zeta', 'm-zeta', 1), row('zeta', 'm-zeta', 2), row('zeta', 'm-zeta', 3),
    row('alpha', 'm-alpha', 4),
    row('beta', 'm-beta', 5), row('beta', 'm-beta', 6),
  ].join('\n') + '\n');
  const out = await createUsageSummary({ file }).summarize({ range: '24h' });
  assert.deepStrictEqual(out.by_provider.map(p => p.name), ['zeta', 'beta', 'alpha']);
  assert.deepStrictEqual(out.by_model.map(m => m.model), ['m-zeta', 'm-beta', 'm-alpha']);

  // 同请求数时按名字升序(与请求数降序方向相反,这样"谁在干活"排前面,平手按字母)
  const tie = path.join(LOG_DIR, 'tie.jsonl');
  fs.writeFileSync(tie, [row('bbb', 'bbb-m', 1), row('aaa', 'aaa-m', 1)].join('\n') + '\n');
  const tied = await createUsageSummary({ file: tie }).summarize({ range: '24h' });
  assert.deepStrictEqual(tied.by_provider.map(p => p.name), ['aaa', 'bbb']);
});

test('ttfb_ms 真的落盘;/api/usage 不把内存与磁盘重复计数', async () => {
  const r = await ask('echo-model');
  assert.strictEqual(r.status, 200);

  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const real = lines.filter(e => e.model_in === 'echo-model');
  assert.strictEqual(real.length, 1);
  assert.strictEqual(typeof real[0].ttfb_ms, 'number');
  assert.ok(real[0].ttfb_ms >= 1, `ttfb_ms 必须 >= 1,实得 ${real[0].ttfb_ms}`);
  assert.ok(real[0].ttfb_ms <= real[0].ms, `ttfb(${real[0].ttfb_ms}) 不能大于总耗时(${real[0].ms})`);

  const diskCount = lines.filter(e => {
    const at = Date.parse(e.ts);
    return at >= NOW - 24 * 60 * MIN && at <= Date.now() + 1000;
  }).length;
  const out = await json('GET', '/api/usage?range=24h');
  assert.strictEqual(out.body.totals.reqs, diskCount, '内存环里刚写完的那条不能与磁盘重复计数');
  assert.ok(out.body.totals.ttfb_p50_ms >= 1);
});
