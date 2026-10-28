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
const { LOG_FIELDS } = require('../lib/observability/request-log');
const LOG_FIELD_SET = new Set(LOG_FIELDS);

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
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({ rules: [], default: {} }));
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

// ---------------------------------------------------------------------------
// dashboard=1:控制台明细扩展(契约见 evidence/ccswitch-layout/contract.md)
//
// 这一组只测**行为**:同一份日志,看哪些行被算进来、明细页翻出来的是不是同一批行、
// 口径(精确/子串、成功/失败、token)在 cards / daily / 分组 / records 之间是否一致。
// 造数仍是生产格式的 JSONL:坏行、未知字段、未来/过期行都按真实历史文件会出现的形态放进去。
// ---------------------------------------------------------------------------
const DASH_DIR = path.join(TMP, 'dash');
fs.mkdirSync(DASH_DIR, { recursive: true });
const logRow = over => ({ app: 'claude', status: 200, in: 0, out: 0, cache_read: 0, ms: 0, ttfb_ms: 0, err: '', ...over });
// lines 里可以混入字符串(坏行),其余一律按日志行序列化
const dashFixture = (name, lines) => {
  const file = path.join(DASH_DIR, name);
  fs.writeFileSync(file, lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
  return file;
};
const exactFile = dashFixture('exact.jsonl', [
  logRow({ ts: iso(NOW - 1 * MIN), provider: '渠道A', model_in: 'req-a', model_out: 'alias-a', in: 10, out: 5, cache_read: 2 }),
  logRow({ ts: iso(NOW - 2 * MIN), provider: '渠道A2', model_in: 'alias-a', model_out: 'alias-a', in: 20 }),
  logRow({ ts: iso(NOW - 3 * MIN), provider: '渠道 A', model_in: 'alias-a', model_out: 'alias-a', in: 30 }),
  logRow({ ts: iso(NOW - 4 * MIN), provider: '渠道A', model_in: 'alias-a-2', model_out: 'alias-a-2' }),
  logRow({ ts: iso(NOW - 5 * MIN), provider: '渠道A', model_in: 'only-in', model_out: '' }),
  logRow({ ts: iso(NOW - 6 * MIN), provider: '渠道A', model_in: '', model_out: '' }),
]);

test('dashboard:provider/model 精确匹配,同名前缀与同名前缀模型不再交叉', async () => {
  const s = createUsageSummary({ file: exactFile });

  const byProvider = await s.summarize({ range: 'all', dashboard: '1', provider: '渠道A' });
  assert.strictEqual(byProvider.totals.reqs, 4, '精确匹配 渠道A 不能把 渠道A2 / 渠道 A 的行算进来');
  assert.deepStrictEqual(byProvider.by_provider.map(p => p.name), ['渠道A']);

  const byModel = await s.summarize({ range: 'all', dashboard: '1', model: 'alias-a' });
  assert.strictEqual(byModel.totals.reqs, 3, '有效模型精确匹配 alias-a 不能带上 alias-a-2');
  assert.deepStrictEqual(byModel.by_model.map(m => m.model), ['alias-a']);

  const both = await s.summarize({ range: 'all', dashboard: '1', provider: '渠道A', model: 'alias-a' });
  assert.strictEqual(both.totals.reqs, 1);
  assert.strictEqual(both.dashboard.records.rows[0].model_in, 'req-a');

  // 有效模型 = model_out || model_in:model_out 为空时用 model_in,两边都没有记成 (?)。
  const all = await s.summarize({ range: 'all', dashboard: '1' });
  assert.deepStrictEqual(all.by_model.map(m => m.model).sort(), ['(?)', 'alias-a', 'alias-a-2', 'only-in']);
  const onlyIn = await s.summarize({ range: 'all', dashboard: '1', model: 'only-in' });
  assert.strictEqual(onlyIn.totals.reqs, 1);

  // 不带 dashboard=1 的老语义原样:子串、小写
  const legacyProvider = await s.summarize({ range: 'all', provider: '渠道a' });
  assert.strictEqual(legacyProvider.totals.reqs, 5, '老口径是子串:渠道A 与 渠道A2 都算,渠道 A 不算');
  const legacyModel = await s.summarize({ range: 'all', model: 'alias-a' });
  assert.strictEqual(legacyModel.totals.reqs, 4, '老口径是子串:alias-a 连带 alias-a-2');
});

test('dashboard:status=ok/err 以 err/err_class 覆盖数字上的 200', async () => {
  const file = dashFixture('status.jsonl', [
    logRow({ ts: iso(NOW - 1 * MIN), provider: 'p', model_in: 'm', model_out: 'm' }),
    logRow({ ts: iso(NOW - 2 * MIN), provider: 'p', model_in: 'm', model_out: 'm', err: 'upstream boom' }),
    logRow({ ts: iso(NOW - 3 * MIN), provider: 'p', model_in: 'm', model_out: 'm', err_class: 'stream_aborted' }),
    logRow({ ts: iso(NOW - 4 * MIN), provider: 'p', model_in: 'm', model_out: 'm', status: 502, err: 'bad gateway' }),
    logRow({ ts: iso(NOW - 5 * MIN), provider: 'p', model_in: 'm', model_out: 'm', status: 0 }),
    logRow({ ts: iso(NOW - 6 * MIN), provider: 'p', model_in: 'm', model_out: 'm', status: 204 }),
  ]);
  const s = createUsageSummary({ file });

  const ok = await s.summarize({ range: 'all', dashboard: '1', status: 'ok' });
  const err = await s.summarize({ range: 'all', dashboard: '1', status: 'err' });
  const all = await s.summarize({ range: 'all', dashboard: '1' });
  assert.strictEqual(ok.totals.reqs, 2, '干净的 200 与 204 才算成功');
  assert.strictEqual(err.totals.reqs, 4, 'err / err_class / 5xx / 从未发出(0)都算失败');
  assert.strictEqual(ok.totals.reqs + err.totals.reqs, all.totals.reqs, 'ok 与 err 必须拼成全集,卡片和筛选不能对不上');
  assert.strictEqual(ok.totals.ok_rate, 100);
  assert.strictEqual(err.totals.ok_rate, 0);
  assert.strictEqual(all.totals.ok_rate, 33.33);
  // 明细与卡片同源:err 页里的每一行都不是成功行
  assert.strictEqual(err.dashboard.records.total, 4);
  assert.deepStrictEqual(err.dashboard.records.rows.map(r => r.status), [200, 200, 502, 0]);
  assert.ok(err.dashboard.records.rows.every(r => r.err || r.err_class || r.status >= 400 || r.status === 0));
  // 不带 dashboard=1 时成功口径与改动前逐字相同(只看 err):老调用方的数字不能被这次扩展动到。
  // 这两种口径只在"2xx + 有 err_class 却没有 err"这种日志上才有差别 —— 生产路径里 err_class
  // 总与 err 或 >=400 同时出现,所以对真实数据两者相等。
  const legacyAll = await s.summarize({ range: 'all' });
  assert.strictEqual(legacyAll.totals.ok_rate, 50, '老响应保持老口径');
  assert.strictEqual(legacyAll.totals.reqs, all.totals.reqs, '请求数与时间边界不能被这次扩展动到');
});

test('dashboard:records 按时间新→旧分页,总数为命中行数,行内容只走白名单', async () => {
  const lines = [];
  for (let i = 0; i < 240; i++) {
    // 每两行同一 ts:并列时的次序也必须是确定的
    lines.push(logRow({ ts: iso(NOW - Math.floor(i / 2) * MIN - 60 * MIN), provider: '分页',
      model_in: 'm', model_out: 'm', in: i, session: `row-${i}` }));
  }
  lines.splice(7, 0, '{broken json');  // 坏行同样占一个物理行号
  lines.push(logRow({ ts: iso(NOW - 30 * 24 * 60 * MIN), provider: '分页', model_in: 'm', model_out: 'm',
    in: 9999, api_key: SECRET, password: SECRET, local_path: '/Users/tufu/secret' }));
  const file = dashFixture('page.jsonl', lines);
  const s = createUsageSummary({ file });

  const first = await s.summarize({ range: 'all', dashboard: '1' });
  assert.strictEqual(first.dashboard.records.total, 241);
  assert.strictEqual(first.dashboard.records.offset, 0);
  assert.strictEqual(first.dashboard.records.limit, 50, '默认每页 50');
  assert.strictEqual(first.dashboard.records.rows.length, 50);
  assert.strictEqual(first.dashboard.records.has_more, true);
  for (let i = 1; i < first.dashboard.records.rows.length; i++) {
    assert.ok(Date.parse(first.dashboard.records.rows[i - 1].ts) >= Date.parse(first.dashboard.records.rows[i].ts),
      '明细必须按时间新→旧');
  }
  const again = await s.summarize({ range: 'all', dashboard: '1' });
  assert.deepStrictEqual(again.dashboard.records.rows, first.dashboard.records.rows, '同样的查询要给出同样的页(并列也不许抖)');

  // 翻完所有页:每行恰好出现一次(坏行错位、跨页重复/漏行都会在这里露出来)
  const seen = [];
  let offset = 0;
  for (;;) {
    const page = await s.summarize({ range: 'all', dashboard: '1', limit: '25', offset: String(offset) });
    seen.push(...page.dashboard.records.rows.map(r => ({ in: r.in, ts: Date.parse(r.ts) })));
    if (!page.dashboard.records.has_more) break;
    offset += 25;
    assert.ok(offset < 1000, '分页游标没有前进');
  }
  assert.strictEqual(seen.length, 241);
  assert.strictEqual(new Set(seen).size, 241, '翻页不能重复也不能漏行');
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i - 1].ts >= seen[i].ts, '整本翻完仍是新→旧');
  assert.deepStrictEqual(seen.slice(0, 6).map(r => r.in), [1, 0, 3, 2, 5, 4],
    '同 ts 时后写入的排前面,且翻页顺序与单页排序一致');
  assert.strictEqual(seen.at(-1).in, 9999, '最旧的一行在最后一页');

  // 上限与非法值
  const clamped = await s.summarize({ range: 'all', dashboard: '1', limit: '500' });
  assert.strictEqual(clamped.dashboard.records.limit, 200, 'limit 上限 200');
  assert.strictEqual(clamped.dashboard.records.rows.length, 200);
  const beyond = await s.summarize({ range: 'all', dashboard: '1', offset: '9999' });
  assert.deepStrictEqual(beyond.dashboard.records.rows, []);
  assert.strictEqual(beyond.dashboard.records.has_more, false);
  for (const bad of [{ offset: '-1' }, { offset: '1.5' }, { limit: '0' }, { limit: 'abc' }, { limit: '-3' }]) {
    await assert.rejects(() => s.summarize({ range: 'all', dashboard: '1', ...bad }),
      e => e.statusCode === 400 && e.code === 'USAGE_PAGINATION_INVALID',
      `${JSON.stringify(bad)} 必须被拒绝`);
  }

  // 白名单:磁盘里混进来的未知字段(甚至密钥)不能随明细分页流出去
  const lastPage = await s.summarize({ range: 'all', dashboard: '1', limit: '200', offset: '200' });
  const legacyRow = lastPage.dashboard.records.rows.find(r => r.in === 9999);
  assert.ok(legacyRow, '最后一行(旧 ts、带多余字段)也要能按行号回读到');
  for (const row of [...first.dashboard.records.rows, ...lastPage.dashboard.records.rows]) {
    for (const key of Object.keys(row)) assert.ok(LOG_FIELD_SET.has(key), `明细行出现白名单外字段:${key}`);
    assert.strictEqual('api_key' in row || 'password' in row || 'local_path' in row, false);
  }
  assert.ok(!JSON.stringify([first, lastPage]).includes(SECRET));
});

test('dashboard:daily/series/分组与 totals 同源同口径(token 逐项相等)', async () => {
  const file = dashFixture('parity.jsonl', [
    logRow({ ts: iso(NOW - 30 * MIN), provider: 'p1', model_in: 'm1', model_out: 'm1', in: 1000, out: 100, cache_read: 200 }),
    logRow({ ts: iso(NOW - 90 * MIN), provider: 'p2', model_in: 'm2', model_out: 'm2', in: 2000, out: 300, status: 500, err: 'x' }),
    logRow({ ts: iso(NOW - 3 * 24 * 60 * MIN), provider: 'p1', model_in: 'm1', model_out: 'm1', in: 10, out: 20, cache_read: 5 }),
  ]);
  const s = createUsageSummary({ file });
  const sum = (list, key) => list.reduce((n, item) => n + item[key], 0);

  for (const query of [{ range: '7d' }, { range: '7d', provider: 'p1' }, { range: '7d', status: 'err' }]) {
    const out = await s.summarize({ dashboard: '1', ...query });
    const label = JSON.stringify(query);
    assert.strictEqual(sum(out.series, 'reqs'), out.totals.reqs, `${label} series.reqs 必须与 totals 相等`);
    assert.strictEqual(sum(out.dashboard.daily, 'reqs'), out.totals.reqs, `${label} daily.reqs 必须与 totals 相等`);
    assert.strictEqual(sum(out.series, 'tokens_in'), out.totals.tokens_in, `${label} series.tokens_in`);
    assert.strictEqual(sum(out.dashboard.daily, 'tokens_out'), out.totals.tokens_out, `${label} daily.tokens_out`);
    assert.strictEqual(sum(out.dashboard.daily, 'cache_read'), out.totals.cache_read, `${label} daily.cache_read`);
    assert.strictEqual(sum(out.by_provider, 'tokens_in'), out.totals.tokens_in, `${label} 分组 tokens_in`);
    assert.strictEqual(sum(out.by_model, 'cache_read'), out.totals.cache_read, `${label} 分组 cache_read`);
    assert.strictEqual(out.totals.tokens_total,
      out.totals.tokens_in + out.totals.tokens_out + out.totals.cache_read, `${label} tokens_total 口径`);
    for (const day of out.dashboard.daily) assert.match(day.t, /^\d{4}-\d{2}-\d{2}$/, 'daily 一律是本地日期');
    for (let i = 1; i < out.dashboard.daily.length; i++) {
      const prev = new Date(out.dashboard.daily[i - 1].t).getTime();
      const cur = new Date(out.dashboard.daily[i].t).getTime();
      assert.strictEqual(cur - prev, 24 * 60 * MIN, 'daily 相邻两天必须正好差一天(不能断档)');
    }
  }
  // 24h 是小时分桶,但 daily 仍要汇成天
  const hourly = await s.summarize({ range: '24h', dashboard: '1' });
  assert.match(hourly.series[0].t, /T\d{2}:00$/);
  assert.match(hourly.dashboard.daily[0].t, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(sum(hourly.dashboard.daily, 'reqs'), hourly.totals.reqs);
});

test('dashboard:facets 在 provider/model 过滤前统计,选中值没有数据也保留', async () => {
  const file = dashFixture('facets.jsonl', [
    logRow({ ts: iso(NOW - 1 * MIN), provider: 'alpha', model_in: 'm1', model_out: 'm1' }),
    logRow({ ts: iso(NOW - 2 * MIN), provider: 'alpha', model_in: 'm2', model_out: 'm2' }),
    logRow({ ts: iso(NOW - 3 * MIN), provider: 'beta', model_in: 'm2', model_out: 'm2' }),
    logRow({ ts: iso(NOW - 4 * MIN), provider: 'gamma', model_in: 'm3', model_out: 'm3', status: 500, err: 'x' }),
    logRow({ ts: iso(NOW - 5 * MIN), provider: 'beta', model_in: 'm1', model_out: 'm1', app: 'codex' }),
  ]);
  const s = createUsageSummary({ file });

  const scoped = await s.summarize({ range: 'all', dashboard: '1', provider: 'alpha' });
  assert.deepStrictEqual(scoped.dashboard.facets.providers.map(f => f.value), ['alpha', 'beta', 'gamma'],
    '选了 alpha 之后兄弟渠道仍要留在下拉里');
  assert.deepStrictEqual(scoped.dashboard.facets.models.map(f => f.value), ['m1', 'm2', 'm3'],
    'facets 的模型在 model 过滤之前统计');
  assert.strictEqual(scoped.totals.reqs, 2);

  const modelsOfBeta = await s.summarize({ range: 'all', dashboard: '1', model: 'm2' });
  assert.deepStrictEqual(modelsOfBeta.dashboard.facets.models.map(f => f.value), ['m1', 'm2', 'm3']);
  assert.strictEqual(modelsOfBeta.totals.reqs, 2);

  // app / status 属于 facets 的作用域之内:它们一变,facets 就该跟着收窄
  const codex = await s.summarize({ range: 'all', dashboard: '1', app: 'codex' });
  assert.deepStrictEqual(codex.dashboard.facets.providers.map(f => f.value), ['beta']);
  const err = await s.summarize({ range: 'all', dashboard: '1', status: 'err' });
  assert.deepStrictEqual(err.dashboard.facets.providers.map(f => f.value), ['gamma']);
  assert.deepStrictEqual(err.dashboard.facets.models.map(f => f.value), ['m3']);

  // 时间范围也收窄 facets,但不影响 coverage
  const scopedByRange = await s.summarize({ range: '24h', dashboard: '1' });
  assert.strictEqual(scopedByRange.dashboard.facets.providers.length, 3);

  // 未知选中值:结果为空,但选中值必须还在列表里(前端不能把过滤条件悄悄重置)
  const ghost = await s.summarize({ range: 'all', dashboard: '1', provider: '不存在的渠道', model: '不存在的模型' });
  assert.strictEqual(ghost.totals.reqs, 0);
  assert.strictEqual(ghost.dashboard.records.total, 0);
  assert.deepStrictEqual(ghost.dashboard.records.rows, []);
  assert.deepStrictEqual(ghost.dashboard.facets.providers.at(-1), { value: '不存在的渠道', label: '不存在的渠道' });
  assert.deepStrictEqual(ghost.dashboard.facets.models.at(-1), { value: '不存在的模型', label: '不存在的模型' });
  assert.deepStrictEqual(ghost.dashboard.facets.providers.map(f => f.value), ['alpha', 'beta', 'gamma', '不存在的渠道']);
});

test('dashboard:coverage 取过滤前的全部可用数据,不随区间收窄', async () => {
  const earliest = NOW - 40 * 24 * 60 * MIN;
  const latest = NOW - 2 * MIN;
  const file = dashFixture('coverage.jsonl', [
    logRow({ ts: iso(latest), provider: 'p', model_in: 'm', model_out: 'm' }),
    logRow({ ts: iso(NOW - 5 * 24 * 60 * MIN), provider: 'p', model_in: 'm', model_out: 'm' }),
    logRow({ ts: iso(earliest), provider: 'p', model_in: 'm', model_out: 'm' }),
  ]);
  const s = createUsageSummary({ file });

  const all = await s.summarize({ range: 'all', dashboard: '1' });
  assert.deepStrictEqual(all.dashboard.coverage, { first_ts: iso(earliest), last_ts: iso(latest) });
  for (const query of [{ range: '24h' }, { range: 'all', provider: 'p' }, { range: 'all', provider: '没有' }]) {
    const out = await s.summarize({ dashboard: '1', ...query });
    assert.deepStrictEqual(out.dashboard.coverage, { first_ts: iso(earliest), last_ts: iso(latest) },
      `${JSON.stringify(query)} 的 coverage 必须是"日志里有多少",不是"区间里选了多少"`);
  }
  const empty = await createUsageSummary({ file: dashFixture('coverage-empty.jsonl', []) })
    .summarize({ range: 'all', dashboard: '1' });
  assert.deepStrictEqual(empty.dashboard.coverage, { first_ts: null, last_ts: null });
  assert.strictEqual(empty.totals.reqs, 0);
  assert.strictEqual(empty.dashboard.records.total, 0);
});

test('dashboard:内存环里更新的行只算一次,并且能出现在明细里', async () => {
  const file = dashFixture('memory.jsonl', [
    logRow({ ts: iso(NOW - 5 * MIN), provider: 'disk', model_in: 'm', model_out: 'm', in: 1 }),
    logRow({ ts: iso(NOW - 4 * MIN), provider: 'disk', model_in: 'm', model_out: 'm', in: 2 }),
  ]);
  const fresh = logRow({ ts: iso(NOW - 20000), provider: 'mem', model_in: 'mem-model', model_out: 'mem-model', in: 7, secret: 'sk-NO' });
  const duplicate = logRow({ ts: iso(NOW - 4 * MIN), provider: 'disk', model_in: 'm', model_out: 'm', in: 2 });
  // 环是**新→旧**返回的(mixrouter 接的就是 requestLog.list)
  const s = createUsageSummary({ file, memoryEntries: () => [fresh, duplicate] });
  const out = await s.summarize({ range: 'all', dashboard: '1' });

  assert.strictEqual(out.totals.reqs, 3, '内存里那条与磁盘同 ts 的行不能再算一遍');
  assert.strictEqual(out.dashboard.records.total, 3);
  assert.deepStrictEqual(out.dashboard.records.rows.map(r => r.in), [7, 2, 1], '内存里的新行排最前且只出现一次');
  assert.strictEqual('secret' in out.dashboard.records.rows[0], false, '内存行的未知字段同样不能出去');
  assert.deepStrictEqual(out.by_provider.map(p => p.name), ['disk', 'mem']);
});

test('legacy:不带 dashboard=1 的响应形状与统计口径完全不变', async () => {
  // 固定时钟:to 就是 now(),不钉住的话两次调用的毫秒差会把"口径没变"测成失败
  const clock = { now: () => NOW };
  const legacy = await createUsageSummary({ file: exactFile, ...clock }).summarize({ range: 'all' });
  assert.deepStrictEqual(Object.keys(legacy).sort(), ['by_model', 'by_provider', 'scope', 'series', 'totals']);

  const dash = await createUsageSummary({ file: exactFile, ...clock }).summarize({ range: 'all', dashboard: '1' });
  for (const key of ['scope', 'totals', 'series', 'by_provider', 'by_model']) {
    assert.deepStrictEqual(dash[key], legacy[key], `dashboard=1 不能改变 ${key} 的口径`);
  }
  // 老调用多传分页/状态参数不该报错(它们对老响应没有意义,只是被忽略)
  const noisy = await createUsageSummary({ file: exactFile, ...clock })
    .summarize({ range: 'all', limit: 'abc', offset: '-1', status: 'nope' });
  assert.deepStrictEqual(noisy.totals, legacy.totals);
  assert.strictEqual('dashboard' in noisy, false);
});

test('API /api/usage?dashboard=1:扩展键、分页、白名单,老响应键不变', async () => {
  const rows = [1, 2, 3].map(i => JSON.stringify(logRow({
    ts: iso(NOW - i * MIN), provider: '主机渠道', model_in: 'host-m', model_out: 'host-m', in: i, out: 1, ms: 10, ttfb_ms: 5,
  })));
  fs.appendFileSync(LOG, rows.join('\n') + '\n');
  const provider = encodeURIComponent('主机渠道');

  const r = await json('GET', `/api/usage?range=all&dashboard=1&provider=${provider}`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['by_model', 'by_provider', 'dashboard', 'scope', 'series', 'totals']);
  assert.deepStrictEqual(Object.keys(r.body.dashboard).sort(), ['coverage', 'daily', 'facets', 'records']);
  assert.strictEqual(r.body.totals.reqs, 3);
  assert.strictEqual(r.body.dashboard.records.total, 3);
  assert.deepStrictEqual(r.body.dashboard.records.rows.map(x => x.in), [1, 2, 3]);
  for (const row of r.body.dashboard.records.rows) {
    for (const key of Object.keys(row)) assert.ok(LOG_FIELD_SET.has(key), `API 明细出现白名单外字段:${key}`);
  }
  assert.ok(!r.text.includes(SECRET), '用量响应不得出现渠道 Key');

  const page = await json('GET', `/api/usage?range=all&dashboard=1&provider=${provider}&limit=2&offset=2`);
  assert.strictEqual(page.body.dashboard.records.rows.length, 1);
  assert.strictEqual(page.body.dashboard.records.has_more, false);
  assert.strictEqual(page.body.dashboard.records.limit, 2);

  const legacy = await json('GET', `/api/usage?range=all&provider=${provider}`);
  assert.deepStrictEqual(Object.keys(legacy.body).sort(), ['by_model', 'by_provider', 'scope', 'series', 'totals']);
  assert.strictEqual(legacy.body.totals.reqs, 3);

  for (const query of ['offset=-1', 'limit=0', 'limit=abc']) {
    const bad = await json('GET', `/api/usage?range=all&dashboard=1&${query}`);
    assert.strictEqual(bad.status, 400, `${query} 应回 400`);
    assert.strictEqual(bad.body.code, 'USAGE_PAGINATION_INVALID');
  }
  const badStatus = await json('GET', '/api/usage?range=all&dashboard=1&status=maybe');
  assert.strictEqual(badStatus.status, 400);
  assert.strictEqual(badStatus.body.code, 'USAGE_STATUS_INVALID');
});
