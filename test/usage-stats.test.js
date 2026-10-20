'use strict';
// 用量统计(/api/usage)、价目表(/api/pricing)与 ttfb_ms 落盘的回归。
//
// 造数方式分两层:
//   · 聚合/价目表:直接写 requests.jsonl 的合成行,时间点相对 now 定,不受运行时刻影响;
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

// 4 条合成日志:24h 内 2 条(一成一败)、2 天前 1 条(未定价模型)、40 天前 1 条。
// 数值刻意取整,便于手算成本/速率。
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
const { DEFAULT_PRICING, createPricingStore, priceEntry, costOf } = require('../lib/usage/pricing');

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
  // sonnet 4.5: 1M in × $3 + 100k out × $15 + 200k cache × $0.3 = 4.56
  // gpt-5:      500k in × $1.25 + 50k out × $10          = 1.125
  assert.strictEqual(out.totals.cost, 5.685);
  assert.deepStrictEqual(out.pricing.missing, []);

  assert.strictEqual(out.by_provider.length, 2);
  const pa = out.by_provider.find(p => p.name === '渠道A');
  assert.deepStrictEqual(pa, { provider: '渠道A', name: '渠道A', reqs: 1, tokens_in: 1000000, tokens_out: 100000, cache_read: 200000, cost: 4.56 });
  assert.strictEqual(out.by_model.find(m => m.model === 'gpt-5').cost, 1.125);
});

test('summary:range 过滤(7d/all/自定义)与未定价模型', async () => {
  const summary = createUsageSummary({ file: LOG });

  const week = await summary.summarize({ range: '7d' });
  assert.strictEqual(week.scope.bucket, 'day');
  assert.strictEqual(week.totals.reqs, 3);
  assert.deepStrictEqual(week.pricing.missing, ['unknown-model-x']);

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

test('pricing:默认价、日期后缀、provider 覆盖与未定价', () => {
  const sonnet = priceEntry(DEFAULT_PRICING, 'claude-sonnet-4-5', 'x');
  assert.deepStrictEqual(sonnet, { in: 3, out: 15, cache_read: 0.3 });
  // 日志里的模型名常带日期后缀:按最长前缀落价
  assert.deepStrictEqual(priceEntry(DEFAULT_PRICING, 'claude-sonnet-4-5-20250929', 'x'), sonnet);
  assert.deepStrictEqual(priceEntry(DEFAULT_PRICING, 'gpt-5-mini-2025-08-07', 'x'), { in: 0.25, out: 2, cache_read: 0.025 });
  assert.strictEqual(priceEntry(DEFAULT_PRICING, 'totally-unknown', 'x'), null);

  const table = { version: 1, models: { 'm1': { in: 1, out: 2, cache_read: 0.5 } },
    providers: { p1: { m1: { in: 9 }, 'm2': { in: 4, out: 4, cache_read: 0 } } } };
  assert.deepStrictEqual(priceEntry(table, 'm1', 'p1'), { in: 9, out: 2, cache_read: 0.5 }, 'provider 覆盖优先,未给的项继承 model 级');
  assert.deepStrictEqual(priceEntry(table, 'm2', 'p1'), { in: 4, out: 4, cache_read: 0 });
  assert.deepStrictEqual(priceEntry(table, 'm1', 'p2'), { in: 1, out: 2, cache_read: 0.5 });
  assert.strictEqual(costOf(table, { model: 'm2', provider: 'p1', in: 1000000, out: 0, cache_read: 0 }).cost, 4);
  assert.strictEqual(costOf(table, { model: 'nope', provider: 'p1' }).priced, false);
});

test('pricing store:默认兜底、自定义落盘 0600、未知模型保留、PUT 校验与冲突', () => {
  const file = path.join(TMP, 'pricing-unit.json');
  const store = createPricingStore({ file });

  const initial = store.read();
  assert.strictEqual(initial.source, 'default');
  assert.strictEqual(initial.pricing.models['claude-opus-4-5'].out, 75);
  assert.ok(!fs.existsSync(file), '内置默认价目表不写盘');

  const saved = store.write({
    version: 1,
    models: { 'my-internal-model': { in: 1, out: 2, cache_read: 0.5 } },
    providers: { p1: { 'claude-sonnet-4-5': { in: 9, out: 9, cache_read: 9 } } },
  }, { expected_revision: initial.revision });
  assert.strictEqual(saved.source, 'custom');
  assert.strictEqual(saved.pricing.models['my-internal-model'].in, 1, '未知模型键必须保留');
  assert.strictEqual(saved.pricing.models['claude-opus-4-5'].in, 15, '默认价仍作为兜底合并进来');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(saved.revision, store.read().revision);
  assert.notStrictEqual(saved.revision, initial.revision);

  // 负数 / 非对象 / 未知字段
  assert.throws(() => store.write({ models: { x: { in: -1 } } }), e => e.statusCode === 400);
  assert.throws(() => store.write('nope'), e => e.statusCode === 400);
  assert.throws(() => store.write({ models: { x: { in: 1, bogus: 2 } } }), e => /未知字段/.test(e.message));
  assert.throws(() => store.write({ unknown_top: 1 }), e => /未知字段/.test(e.message));
  // 未知模型键保存后仍在(上一步的失败写入没有破坏它)
  assert.strictEqual(store.read().pricing.models['my-internal-model'].out, 2);
  // 乐观并发:旧 revision 回 409
  const current = store.read();
  assert.throws(() => store.write({ models: {} }, { expected_revision: initial.revision }),
    e => e.statusCode === 409 && e.code === 'PRICING_CONFLICT' && e.revision === current.revision);
});

test('API GET /api/usage:结构、过滤、400 与无密钥', async () => {
  const r = await json('GET', '/api/usage?range=24h');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.body).sort(),
    ['by_model', 'by_provider', 'pricing', 'scope', 'series', 'totals']);
  assert.deepStrictEqual(Object.keys(r.body.totals).sort(),
    ['cache_hit_rate', 'cache_read', 'cost', 'ok_rate', 'reqs', 'speed_tps', 'tokens_in', 'tokens_out', 'tokens_total', 'ttfb_p50_ms']);
  assert.strictEqual(r.body.totals.reqs, 2);
  assert.strictEqual(r.body.scope.bucket, 'hour');
  assert.strictEqual(r.body.pricing.source, 'default');

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

test('API /api/pricing:GET / PUT / 400 / 409', async () => {
  const before = await json('GET', '/api/pricing');
  assert.strictEqual(before.status, 200);
  // custom 只含自定义键:控制台保存时原样写回,避免把默认表冻结进 pricing.json。
  assert.deepStrictEqual(Object.keys(before.body).sort(), ['custom', 'pricing', 'revision', 'source']);
  assert.strictEqual(before.body.source, 'default');
  assert.ok(before.body.revision);
  assert.ok(!before.text.includes(SECRET));

  const negative = await json('PUT', '/api/pricing', { models: { x: { in: -5 } } });
  assert.strictEqual(negative.status, 400);
  assert.strictEqual(negative.body.code, 'PRICING_INVALID');

  const unknown = await json('PUT', '/api/pricing', { models: { x: { in: 1, nope: 2 } } });
  assert.strictEqual(unknown.status, 400);

  const conflict = await json('PUT', '/api/pricing', { models: {}, expected_revision: 'stale-revision' });
  assert.strictEqual(conflict.status, 409);
  assert.strictEqual(conflict.body.code, 'PRICING_CONFLICT');

  const ok = await json('PUT', '/api/pricing', {
    version: 1,
    models: { 'gpt-5': { in: 2, out: 20, cache_read: 0.2 } },
    providers: { 'p-mock': { 'echo-model': { in: 1, out: 1, cache_read: 0 } } },
    expected_revision: before.body.revision,
  });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.source, 'custom');
  assert.strictEqual(ok.body.pricing.models['gpt-5'].in, 2);
  assert.notStrictEqual(ok.body.revision, before.body.revision);
  assert.strictEqual(fs.statSync(path.join(TMP, 'pricing.json')).mode & 0o777, 0o600);

  // 价目表立即影响统计:24h 内的 gpt-5 从 $1.25 变成 $2 / 1M
  const usage = await json('GET', '/api/usage?range=24h');
  assert.strictEqual(usage.body.pricing.source, 'custom');
  assert.strictEqual(usage.body.totals.cost, 4.56 + (0.5 * 2 + 0.05 * 20)); // 4.56 + 2 = 6.56
  assert.ok(!usage.text.includes(SECRET));
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
