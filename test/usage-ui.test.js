'use strict';
// 用量统计页(public/js/usage.js)的渲染与交互测试。
// 与 test/ui.test.js 一样跑在 vm 里:控制台是 classic script 多文件共用一个 realm,
// usage.js 直接读 app.js 声明的 `$` / `esc` / `toast` / `view`,所以这里把它们先塞进上下文
// —— 反过来也保证了「usage.js 不自己重复声明这些名字」这条硬约束会被加载动作本身验到。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/usage.js'), 'utf8');

// 只造 usage.js 真正会碰的 DOM:元素按 id 注册,取不到的返回 null(与浏览器一致)。
class Element {
  constructor(id = '') {
    this.id = id; this.style = {}; this.attributes = {}; this.value = ''; this.checked = false;
    this.disabled = false; this.hidden = false; this.textContent = ''; this._html = ''; this.dataset = {};
    this.children = []; this.classList = { set: new Set() };
    this.classList.add = (...xs) => xs.forEach(x => this.classList.set.add(x));
    this.classList.remove = (...xs) => xs.forEach(x => this.classList.set.delete(x));
    this.classList.contains = x => this.classList.set.has(x);
    this.classList.toggle = (x, force) => { const on = force ?? !this.classList.set.has(x); if (on) this.classList.set.add(x); else this.classList.set.delete(x); return on; };
  }
  set innerHTML(value) { this._html = String(value); }
  get innerHTML() { return this._html; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { (this.events ||= {})[name] = callback; }
  appendChild(child) { this.children.push(child); return child; }
  insertAdjacentHTML() {}
  querySelector(selector) { return (this.children || []).find(child => selector.includes(child.className) || selector === '.' + child.className) || null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 260 }; }
  get clientWidth() { return 900; }
  set clientWidth(value) { this._clientWidth = value; }
  get offsetWidth() { return 160; }
  set offsetWidth(value) { this._offsetWidth = value; }
  remove() {}
}

const RANGE_IDS = ['today', '24h', '7d', '30d', 'all'];
const METRIC_IDS = ['tokens', 'reqs', 'cost'];

function harness(options = {}) {
  const elements = new Map();
  const segs = { range: [], metric: [] };
  const get = id => elements.get(id) || null;
  for (const id of ['usage-strengths-unused']) get(id); // no-op, keeps shape obvious
  for (const id of ['usage-cost', 'usage-reqs', 'usage-ok-rate', 'usage-tokens', 'usage-token-split', 'usage-cache',
    'usage-cache-hint', 'usage-cost-hint', 'usage-status', 'usage-missing', 'usage-rows', 'usage-count', 'usage-range-label',
    'usage-svg', 'usage-chart-holder', 'usage-pricing-mask', 'usage-pricing-body', 'usage-pricing-msg',
    'usage-pricing-save', 'usage-sync', 'usage-app', 'usage-provider', 'usage-model', 'usage-interval',
    'usage-range-tabs']) elements.set(id, new Element(id));
  for (const id of RANGE_IDS) { const el = new Element(); el.dataset.range = id; segs.range.push(el); }
  for (const id of METRIC_IDS) { const el = new Element(); el.dataset.metric = id; segs.metric.push(el); }
  const requests = [];
  let response = options.response || usageFixture();
  let failNext = null;
  let pricingResponse = options.pricing || { pricing: { version: 1, models: { 'm-a': { in: 3, out: 15, cache_read: 0.3 } }, providers: {} }, custom: { version: 1, models: {}, providers: {} }, revision: 'rev-1', source: 'default' };
  const document = {
    visibilityState: 'visible',
    getElementById: id => get(id),
    querySelectorAll: selector => selector.startsWith('.usage-range') ? segs.range : selector.startsWith('.usage-tabs') ? segs.metric : [],
    querySelector: () => null,
    addEventListener: () => {},
    createElement: tag => Object.assign(new Element(), { tagName: tag }),
  };
  const store = new Map();
  const context = vm.createContext({
    document, console, window: { addEventListener: () => {} },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    URLSearchParams, Date, Math, JSON, Number, Object, Array, String, Set, Map, Promise, Error, isNaN,
    AbortController: class { constructor() { this.signal = {}; } abort() { this.aborted = true; } },
    setTimeout: () => 1, clearTimeout: () => {},
    setInterval: () => 1, clearInterval: () => {},
    fetch: async (url, init = {}) => {
      const entry = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined };
      requests.push(entry);
      if (url === '/api/pricing' && entry.method === 'GET') {
        return { ok: true, status: 200, json: async () => structuredClone(pricingResponse) };
      }
      if (url === '/api/pricing' && entry.method === 'PUT') {
        if (options.onPricingPut) return options.onPricingPut(entry, pricingResponse);
        pricingResponse = { ...pricingResponse, custom: { version: 1, models: entry.body.models, providers: entry.body.providers || {} }, revision: 'rev-2', source: 'custom' };
        return { ok: true, status: 200, json: async () => structuredClone(pricingResponse) };
      }
      if (failNext) { const error = failNext; failNext = null; throw error; }
      return { ok: true, status: 200, json: async () => structuredClone(response) };
    },
    // app.js 里的全局:`$` / `esc` / `toast` / `view`。usage.js 只能读,不能再声明。
    $: id => get(id),
    esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    view: 'usage',
    toasts: [],
  });
  context.toast = message => context.toasts.push(message);
  // 顶层 function 声明会挂到 vm 的全局对象上,但 const 不会 —— 用脚本尾部导出这些 const。
  vm.runInContext(SOURCE + '\n;globalThis.__t = { usageState, usageTok, usageMoney, usagePct, usageMs, usageNiceMax, usageMetricOf, usageQuery };', context, { filename: 'public/js/usage.js' });
  return {
    run: code => vm.runInContext(code, context),
    get,
    requests,
    context,
    state: context.__t.usageState,
    helpers: context.__t,
    setResponse: value => { response = value; },
    failNext: error => { failNext = error; },
    segs,
  };
}

function usageFixture() {
  return {
    scope: { from: '2026-10-19T16:00:00.000Z', to: '2026-10-20T10:00:00.000Z', timezone: 'Asia/Shanghai', bucket: 'hour', source: 'disk+memory' },
    totals: {
      cost: 1.2345, reqs: 42, ok_rate: 97.62, tokens_in: 12000, tokens_out: 3400, cache_read: 56000,
      tokens_total: 71400, cache_hit_rate: 0.8235, speed_tps: 88.4, ttfb_p50_ms: 1250,
    },
    series: [
      { t: '2026-10-20T08:00', cost: 0.5, reqs: 10, tokens_in: 4000, tokens_out: 900, cache_read: 12000 },
      { t: '2026-10-20T09:00', cost: 0.7345, reqs: 32, tokens_in: 8000, tokens_out: 2500, cache_read: 44000 },
    ],
    by_provider: [{ provider: 'p1', name: '主力渠道', reqs: 42, tokens_in: 12000, tokens_out: 3400, cache_read: 56000, cost: 1.2345 }],
    by_model: [
      { model: 'claude-opus-4-8', reqs: 30, tokens_in: 9000, tokens_out: 3000, cache_read: 40000, cost: 1.2 },
      { model: 'mystery-model', reqs: 12, tokens_in: 3000, tokens_out: 400, cache_read: 16000, cost: 0 },
    ],
    pricing: { source: 'default', missing: ['mystery-model'] },
  };
}

test('指标卡:成本/请求/token/命中率各自格式化,null 一律显示「—」', async () => {
  const h = harness();
  await h.run('loadUsage()');
  assert.equal(h.get('usage-cost').textContent, '$1.23');
  assert.equal(h.get('usage-reqs').textContent, '42');
  assert.match(h.get('usage-ok-rate').textContent, /97\.6%/);
  assert.equal(h.get('usage-tokens').textContent, '71.4k');
  assert.match(h.get('usage-token-split').textContent, /新增 12\.0k \/ 输出 3\.4k \/ 缓存 56\.0k/);
  assert.equal(h.get('usage-cache').textContent, '82.3%', '缓存命中率是 0..1 比例,展示要乘 100(0.8235 → 82.3%)');
  assert.match(h.get('usage-cache-hint').textContent, /88 tok\/s/);
  assert.match(h.get('usage-cache-hint').textContent, /1\.3s/, '1250ms 应显示成 1.3s 而不是 1250ms');

  // 全空响应:不能抛,不能显示 0 冒充有数据
  h.setResponse({ scope: {}, totals: { cost: null, reqs: 0, ok_rate: null, cache_hit_rate: null, speed_tps: null, ttfb_p50_ms: null, tokens_total: null }, series: [], by_provider: [], by_model: [], pricing: { source: 'default', missing: [] } });
  await h.run('loadUsage()');
  assert.equal(h.get('usage-cost').textContent, '—');
  assert.equal(h.get('usage-cache').textContent, '—');
  assert.match(h.get('usage-ok-rate').textContent, /暂无成功率样本/);
});

test('明细表:按模型列出七列,命中率按 (新增输入 + 缓存读) 计算,空列表不崩', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const html = h.get('usage-rows').innerHTML;
  assert.match(html, /claude-opus-4-8/);
  assert.match(html, /mystery-model/);
  assert.match(html, /\$1\.20/);
  assert.match(html, /81\.6%/, '40000 / (9000 + 40000)');
  assert.equal((html.match(/<tr>/g) || []).length, 2);

  h.setResponse({ ...usageFixture(), by_model: [], series: [] });
  await h.run('loadUsage()');
  assert.match(h.get('usage-rows').innerHTML, /没有请求/);
  assert.match(h.get('usage-count').textContent, /没有请求/);
});

test('未定价模型要在页面上点名,而不是静默把成本算成 0', async () => {
  const h = harness();
  await h.run('loadUsage()');
  assert.equal(h.get('usage-missing').hidden, false);
  assert.match(h.get('usage-missing').textContent, /1 个模型未定价/);
  assert.match(h.get('usage-missing').textContent, /mystery-model/);
  h.setResponse({ ...usageFixture(), pricing: { source: 'default', missing: [] } });
  await h.run('loadUsage()');
  assert.equal(h.get('usage-missing').hidden, true, '没有未定价模型时要收起来');
});

test('面积图:空序列不画线,有数据时画出面积与折线且点数与桶数一致', async () => {
  const h = harness();
  h.setResponse({ ...usageFixture(), series: [] });
  await h.run('loadUsage()');
  assert.match(h.get('usage-svg').innerHTML, /这个区间里没有请求/);
  assert.doesNotMatch(h.get('usage-svg').innerHTML, /chart-line/);

  h.setResponse(usageFixture());
  await h.run('loadUsage()');
  const svg = h.get('usage-svg').innerHTML;
  assert.match(svg, /chart-area/);
  assert.match(svg, /chart-line/);
  assert.equal((svg.match(/<circle/g) || []).length, 2, '两个桶画两个点');
  assert.match(svg, /linearGradient/, '面积需要渐变填充');
  // Y 轴刻度要是"好看的数":上界取 1/2/2.5/5×10^n
  assert.equal(h.helpers.usageNiceMax(71400), 100000);
  assert.equal(h.helpers.usageNiceMax(1), 1);
  assert.equal(h.helpers.usageNiceMax(0), 1);
});

test('切换指标只重画、不重新请求;切换区间与筛选才发请求且查询串正确', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const before = h.requests.length;
  h.run("setUsageMetric('cost')");
  h.run("setUsageMetric('reqs')");
  assert.equal(h.requests.length, before, '指标切换是纯前端重画');
  assert.match(h.get('usage-range-label').textContent, /请求/);

  h.run("setUsageRange('today')");
  assert.match(h.requests.at(-1).url, /range=today/);
  h.run("setUsageFilter('app', 'codex')");
  assert.match(h.requests.at(-1).url, /app=codex/);
  h.run("setUsageFilter('provider', '主力渠道')");
  assert.match(h.requests.at(-1).url, /provider=/);
  // 非法值不触发请求
  const n = h.requests.length;
  h.run("setUsageRange('bogus')");
  h.run("setUsageMetric('bogus')");
  assert.equal(h.requests.length, n, '非法区间/指标必须被忽略');
});

test('轮询:关掉不发请求;页面隐藏时不打接口;失败不清空旧图', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const ok = h.get('usage-cost').textContent;
  h.run('setUsageInterval(0)');
  const n = h.requests.length;
  h.run('usageState.visible = true; usageSchedule()');
  assert.equal(h.requests.length, n, '间隔为 0 时不该起定时器');

  // 读失败:状态行报错,但卡片保留上一次的数字
  h.failNext(new Error('boom'));
  await h.run('loadUsage()');
  assert.match(h.get('usage-status').textContent, /读取失败/);
  assert.equal(h.get('usage-cost').textContent, ok, '一次失败不该把页面清空');
});

test('筛选下拉:重填保留当前选择;选中项消失时退回「全部」并同步状态', async () => {
  const h = harness();
  await h.run('loadUsage()');
  assert.match(h.get('usage-provider').innerHTML, /主力渠道/);
  assert.match(h.get('usage-model').innerHTML, /claude-opus-4-8/);
  h.run("usageState.model = 'claude-opus-4-8'");
  await h.run('loadUsage()');
  assert.equal(h.get('usage-model').value, 'claude-opus-4-8', '轮询不能把用户选的模型重置掉');
  h.run("usageState.model = 'disappeared-model'");
  await h.run('loadUsage()');
  assert.equal(h.get('usage-model').value, '');
  assert.equal(h.state.model, '', '下拉回到「全部」时状态也必须一起回退,不能出现显示与请求不一致');
});

test('价目表:打开时读接口、负数单价被拦下、409 提示重新载入', async () => {
  const h = harness();
  await h.run('openUsagePricing()');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.get('usage-pricing-mask').classList.contains('show'));
  assert.match(h.get('usage-pricing-body').innerHTML, /m-a/);

  // 负数单价:不发 PUT,直接报错
  const rows = [{ dataset: { custom: '1' }, querySelector: sel => ({ value: sel === '.price-name' ? 'm-b' : sel === '.price-in' ? '-1' : '' }) }];
  h.context.document.querySelectorAll = selector => selector === '#usage-pricing-rows tr' ? rows : [];
  const n = h.requests.length;
  await h.run('saveUsagePricing()');
  assert.equal(h.requests.length, n, '校验失败不该发 PUT');
  assert.match(h.get('usage-pricing-msg').textContent, /非负数字/);

  // 409:提示并重新载入
  const h2 = harness({
    onPricingPut: () => ({ ok: false, status: 409, json: async () => ({ error: '价目表已被其他请求修改', code: 'PRICING_CONFLICT', revision: 'rev-9' }) }),
  });
  await h2.run('openUsagePricing()');
  await new Promise(resolve => setImmediate(resolve));
  const putRows = [{ dataset: { custom: '1' }, querySelector: sel => ({ value: sel === '.price-name' ? 'm-b' : sel === '.price-in' ? '2' : '' }) }];
  h2.context.document.querySelectorAll = selector => selector === '#usage-pricing-rows tr' ? putRows : [];
  await h2.run('saveUsagePricing()');
  assert.match(h2.get('usage-pricing-msg').textContent, /已被其他请求修改|正在重新载入/);
});

test('成本卡片在存在未定价模型时说明覆盖率,不让人误读「总成本」', async () => {
  const h = harness();
  await h.run('loadUsage()');
  // 2 个模型里 1 个未定价(12 / 42 次请求)
  assert.match(h.get('usage-cost-hint').textContent, /1 个模型未定价/);
  assert.match(h.get('usage-cost-hint').textContent, /29% 请求/, '12/42 → 28.6% 取整 29%');
  assert.match(h.get('usage-cost-hint').textContent, /只含已定价部分/);

  h.setResponse({ ...usageFixture(), pricing: { source: 'default', missing: [] } });
  await h.run('loadUsage()');
  assert.equal(h.get('usage-cost-hint').textContent, '按价目表折算，非账单');
});

test('刻度文字要短、X 轴刻度不跳号', async () => {
  const h = harness();
  // 8 个桶画 7 个刻度:以前 round 会把相邻两格算成同一个索引,导致少标一个日期
  const series = Array.from({ length: 8 }, (_, i) => ({ t: `2026-10-${String(13 + i).padStart(2, '0')}`, cost: 0, reqs: 1, tokens_in: 1000, tokens_out: 0, cache_read: 0 }));
  h.setResponse({ ...usageFixture(), series });
  await h.run('loadUsage()');
  const svg = h.get('usage-svg').innerHTML;
  const labels = [...svg.matchAll(/text-anchor="(?:start|middle|end)">([^<]+)</g)].map(m => m[1]);
  const dates = labels.filter(t => t.startsWith('10-'));
  assert.equal(dates.length, 7, '7 个刻度都要画出来');
  assert.equal(new Set(dates).size, 7, '刻度不能重复/跳号');
  assert.equal(dates[0], '10-13');
  assert.equal(dates.at(-1), '10-20');
  // Y 轴不出现两位小数的 M(750.00M 这种会把左边距撑爆)
  assert.doesNotMatch(svg, /\d\.\d\dM</, '刻度文字只保留 0–1 位小数');
});

test('轮询不重建没变化的筛选下拉,避免下拉自己收起/滚回顶部', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const provider = h.get('usage-provider');
  const before = provider._html;
  await h.run('loadUsage()');
  assert.equal(provider._html, before, '选项没变时不该重新写 innerHTML');
  // 选项真的变了(换了区间,模型列表变化)才重建
  h.setResponse({ ...usageFixture(), by_model: [{ model: 'only-model', reqs: 1, tokens_in: 1, tokens_out: 1, cache_read: 0, cost: 0 }] });
  await h.run('loadUsage()');
  assert.equal(provider._html, before, '供应商清单没变,仍然不重建');
  assert.match(h.get('usage-model')._html, /only-model/, '模型清单变了才重建');
});
