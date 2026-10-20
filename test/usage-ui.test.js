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
    this.children = []; this.parentNode = null; this.className = ''; this.classList = { set: new Set() };
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
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  insertAdjacentHTML() {}
  // SVG 内容在真实浏览器里是节点树,这里只有 innerHTML 字符串 —— 对 .chart-crosshair
  // 这类由模板写出的部件返回一个替身元素,让交互测试能断言属性更新。
  querySelector(selector) {
    const byId = selector.startsWith('#');
    const name = selector.slice(1);
    for (const child of this.children || []) {
      if (byId ? child.id === name : String(child.className || '').split(/\s+/).includes(name)) return child;
      const nested = child.querySelector ? child.querySelector(selector) : null;
      if (nested) return nested;
    }
    if (!byId && this._html.includes(`class="${name}"`)) {
      this._stubs ||= {};
      return (this._stubs[selector] ||= Object.assign(new Element(), { tagName: 'svg-part' }));
    }
    return null;
  }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 260 }; }
  get clientWidth() { return this._clientWidth ?? 900; }
  set clientWidth(value) { this._clientWidth = value; }
  get offsetWidth() { return 160; }
  set offsetWidth(value) { this._offsetWidth = value; }
  remove() {}
}

const RANGE_IDS = ['today', '24h', '7d', '30d', 'all'];
const METRIC_IDS = ['tokens', 'reqs'];

function harness(options = {}) {
  const elements = new Map();
  const segs = { range: [], metric: [] };
  const get = id => elements.get(id) || null;
  for (const id of ['usage-strengths-unused']) get(id); // no-op, keeps shape obvious
  for (const id of ['usage-reqs', 'usage-ok-rate', 'usage-tokens', 'usage-token-split', 'usage-cache',
    'usage-cache-hint', 'usage-status', 'usage-rows', 'usage-count', 'usage-range-label',
    'usage-svg', 'usage-chart-holder', 'usage-sync', 'usage-app', 'usage-provider', 'usage-model', 'usage-interval',
    'usage-range-tabs']) elements.set(id, new Element(id));
  // .usage-chart 是 index.html 里 holder 的父节点:图表下方的明细表与播报区都挂在这上面。
  const chart = new Element('usage-chart');
  chart.className = 'usage-chart';
  chart.appendChild(elements.get('usage-chart-holder'));
  elements.set('usage-chart', chart);
  for (const id of RANGE_IDS) { const el = new Element(); el.dataset.range = id; segs.range.push(el); }
  for (const id of METRIC_IDS) { const el = new Element(); el.dataset.metric = id; segs.metric.push(el); }
  const requests = [];
  let response = options.response || usageFixture();
  let failNext = null;
  const documentHandlers = {};
  const document = {
    visibilityState: 'visible',
    activeElement: null,
    getElementById: id => get(id),
    querySelectorAll: selector => selector.startsWith('.usage-range') ? segs.range : selector.startsWith('.usage-tabs') ? segs.metric : [],
    querySelector: () => null,
    addEventListener: (name, callback) => { (documentHandlers[name] ||= []).push(callback); },
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
  vm.runInContext(SOURCE + '\n;globalThis.__t = { usageState, usageTok, usagePct, usageMs, usageNiceMax, usageAxisLabel, usageMetricOf, usageSeriesHasRequests, usageQuery, usageBucketLabel, usageMetricText, getTrend: () => usageTrend, getLive: () => usageLive };', context, { filename: 'public/js/usage.js' });
  // 页面在 DOMContentLoaded 里挂图表交互监听;这里也跑一遍,测试才能拿到 holder.events。
  for (const callback of documentHandlers.DOMContentLoaded || []) callback();
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
      reqs: 42, ok_rate: 97.62, tokens_in: 12000, tokens_out: 3400, cache_read: 56000,
      tokens_total: 71400, cache_hit_rate: 0.8235, speed_tps: 88.4, ttfb_p50_ms: 1250,
    },
    series: [
      { t: '2026-10-20T08:00', reqs: 10, tokens_in: 4000, tokens_out: 900, cache_read: 12000 },
      { t: '2026-10-20T09:00', reqs: 32, tokens_in: 8000, tokens_out: 2500, cache_read: 44000 },
    ],
    by_provider: [{ provider: 'p1', name: '主力渠道', reqs: 42, tokens_in: 12000, tokens_out: 3400, cache_read: 56000 }],
    by_model: [
      { model: 'claude-opus-4-8', reqs: 30, tokens_in: 9000, tokens_out: 3000, cache_read: 40000 },
      { model: 'mystery-model', reqs: 12, tokens_in: 3000, tokens_out: 400, cache_read: 16000 },
    ],
  };
}

test('指标卡:请求/token/命中率各自格式化,速度与首字进小字,null 一律显示「—」', async () => {
  const h = harness();
  await h.run('loadUsage()');
  assert.equal(h.get('usage-reqs').textContent, '42');
  assert.match(h.get('usage-ok-rate').textContent, /97\.6%/);
  assert.equal(h.get('usage-tokens').textContent, '71.4k');
  assert.match(h.get('usage-token-split').textContent, /新增 12\.0k \/ 输出 3\.4k \/ 缓存 56\.0k/);
  assert.equal(h.get('usage-cache').textContent, '82.3%', '缓存命中率是 0..1 比例,展示要乘 100(0.8235 → 82.3%)');
  assert.match(h.get('usage-cache-hint').textContent, /88 tok\/s/);
  assert.match(h.get('usage-cache-hint').textContent, /1\.3s/, '1250ms 应显示成 1.3s 而不是 1250ms');

  // 全空响应:不能抛,不能显示 0 冒充有数据
  h.setResponse({ scope: {}, totals: { reqs: 0, ok_rate: null, cache_hit_rate: null, speed_tps: null, ttfb_p50_ms: null, tokens_total: null }, series: [], by_provider: [], by_model: [] });
  await h.run('loadUsage()');
  assert.equal(h.get('usage-tokens').textContent, '—');
  assert.match(h.get('usage-cache-hint').textContent, /速度 — · 首字 —/, '没有样本时速度/首字也要写「—」,不能留 0');
  assert.equal(h.get('usage-cache').textContent, '—');
  assert.match(h.get('usage-ok-rate').textContent, /暂无成功率样本/);
});

test('明细表:按模型列出六列(模型/请求/新增输入/输出/缓存命中/命中率),空列表不崩', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const html = h.get('usage-rows').innerHTML;
  assert.match(html, /claude-opus-4-8/);
  assert.match(html, /mystery-model/);
  assert.match(html, /81\.6%/, '40000 / (9000 + 40000)');
  const firstRow = html.slice(html.indexOf('<tr>'), html.indexOf('</tr>'));
  assert.equal((firstRow.match(/<td>/g) || []).length, 6, '每行六列,没有金额列');
  assert.equal((html.match(/<tr>/g) || []).length, 2);

  h.setResponse({ ...usageFixture(), by_model: [], series: [] });
  await h.run('loadUsage()');
  assert.match(h.get('usage-rows').innerHTML, /没有请求/);
  assert.match(h.get('usage-count').textContent, /没有请求/);
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
  assert.equal((svg.match(/class="chart-dot"/g) || []).length, 2, '两个桶画两个点');
  assert.match(svg, /chart-crosshair/, '十字光标要预先建好,交互时只改坐标');
  assert.match(svg, /chart-active-dot/, '当前桶的高亮点');
  assert.match(svg, /chart-hit/, '透明命中层要覆盖整个绘图区,窄点也能悬停');
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
  h.run("setUsageMetric('tokens')");
  h.run("setUsageMetric('reqs')");
  assert.equal(h.requests.length, before, '指标切换是纯前端重画');
  assert.match(h.get('usage-range-label').textContent, /请求/);
  assert.deepEqual([...h.run('Object.keys(USAGE_METRIC_LABELS)')], ['tokens', 'reqs'], '指标只剩 tokens / 请求');
  assert.equal(h.run("typeof usageMoney"), 'undefined', '金额格式化函数必须彻底删掉,别留着以后又被接回来');

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
  const ok = h.get('usage-reqs').textContent;
  h.run('setUsageInterval(0)');
  const n = h.requests.length;
  h.run('usageState.visible = true; usageSchedule()');
  assert.equal(h.requests.length, n, '间隔为 0 时不该起定时器');

  // 读失败:状态行报错,但卡片保留上一次的数字
  h.failNext(new Error('boom'));
  await h.run('loadUsage()');
  assert.match(h.get('usage-status').textContent, /读取失败/);
  assert.equal(h.get('usage-reqs').textContent, ok, '一次失败不该把页面清空');
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

test('刻度文字要短、X 轴刻度不跳号', async () => {
  const h = harness();
  // 8 个桶画 7 个刻度:以前 round 会把相邻两格算成同一个索引,导致少标一个日期
  const series = Array.from({ length: 8 }, (_, i) => ({ t: `2026-10-${String(13 + i).padStart(2, '0')}`, reqs: 1, tokens_in: 1000, tokens_out: 0, cache_read: 0 }));
  h.setResponse({ ...usageFixture(), series });
  await h.run('loadUsage()');
  const svg = h.get('usage-svg').innerHTML;
  const labels = [...svg.matchAll(/text-anchor="(?:start|middle|end)">([^<]+)</g)].map(m => m[1]);
  const dates = labels.filter(t => t.startsWith('10-'));
  assert.equal(dates.length, 7, '7 个刻度都要画出来');
  assert.equal(new Set(dates).size, 7, '刻度不能重复/跳号');
  assert.equal(dates[0], '10-13');
  assert.equal(dates.at(-1), '10-20');
  // 窄屏:7 个 5 字符标签会重叠,刻度数按绘图宽度收缩,但首尾仍要保留
  h.get('usage-chart-holder').clientWidth = 360;
  h.run('usageRenderChart(usageState.data)');
  const narrow = [...h.get('usage-svg').innerHTML.matchAll(/text-anchor="(?:start|middle|end)">([^<]+)</g)]
    .map(m => m[1]).filter(t => t.startsWith('10-'));
  assert.ok(narrow.length >= 2 && narrow.length <= 5, `窄屏刻度要收缩到 5 个以内,实际 ${narrow.length} 个`);
  assert.equal(narrow[0], '10-13');
  assert.equal(narrow.at(-1), '10-20');
  // Y 轴不出现两位小数的 M(750.00M 这种会把左边距撑爆)
  assert.doesNotMatch(svg, /\d\.\d\dM</, '刻度文字只保留 0–1 位小数');
  // 1.5M 不能四舍五入成 2M —— 那会和上一格重复,读者分不清两格差在哪
  assert.equal(h.helpers.usageAxisLabel(1_500_000), '1.5M');
  assert.equal(h.helpers.usageAxisLabel(2_000_000), '2M');
  assert.equal(h.helpers.usageAxisLabel(12_400_000), '12M');
  assert.equal(h.helpers.usageAxisLabel(500_000), '500k');
  assert.equal(h.helpers.usageAxisLabel(1_500), '1.5k');
  assert.equal(h.helpers.usageAxisLabel(0), '0');
  assert.equal(h.helpers.usageAxisLabel(1_200_000_000), '1.2B');
});

test('轮询不重建没变化的筛选下拉,避免下拉自己收起/滚回顶部', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const provider = h.get('usage-provider');
  const before = provider._html;
  await h.run('loadUsage()');
  assert.equal(provider._html, before, '选项没变时不该重新写 innerHTML');
  // 选项真的变了(换了区间,模型列表变化)才重建
  h.setResponse({ ...usageFixture(), by_model: [{ model: 'only-model', reqs: 1, tokens_in: 1, tokens_out: 1, cache_read: 0 }] });
  await h.run('loadUsage()');
  assert.equal(provider._html, before, '供应商清单没变,仍然不重建');
  assert.match(h.get('usage-model')._html, /only-model/, '模型清单变了才重建');
});

test('图表颜色只走主题变量:单序列线/面积,不用 --accent 或状态绿', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const svg = h.get('usage-svg').innerHTML;
  assert.match(svg, /stroke="var\(--chart-series[,)]/, '折线用 --chart-series');
  assert.match(svg, /stop-color="var\(--chart-area[,)]/, '面积用 --chart-area');
  assert.doesNotMatch(svg, /var\(--accent\)|var\(--ok\)|#3fb950|#4c9ffe/i, '通用趋势图不能借用强调色/状态绿');
  // 单序列不需要图例,标题负责说明指标。
  assert.equal(h.get('usage-range-label').textContent, 'Tokens 使用趋势 · 近 7 天');
  h.run("setUsageMetric('reqs')");
  assert.equal(h.get('usage-range-label').textContent, '请求 使用趋势 · 近 7 天');
  assert.match(h.get('usage-svg').innerHTML, /stroke="var\(--chart-series[,)]/, '换指标后同一套变量');
  // 表格/图里都没有金额或折算痕迹。
  assert.doesNotMatch(h.get('usage-svg').innerHTML, /¥|cost|price/i);
  assert.doesNotMatch(h.run('usageTrend.body.innerHTML'), /¥|cost|price/i);
});

test('悬停:十字线吸附最近的 X,浮层给出时间与数值;移出后收起', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const holder = h.get('usage-chart-holder');
  holder.events.mousemove({ clientX: 880, type: 'mousemove' });
  assert.equal(h.state.chartIndex, 1, '指到右端应吸到第二个桶');
  const tip = holder.querySelector('.chart-tip');
  assert.equal(tip.hidden, false);
  assert.match(tip.textContent, /2026-10-20 09:00 · 54\.5k tokens/);
  const crosshair = h.get('usage-svg').querySelector('.chart-crosshair');
  assert.equal(crosshair.attributes.hidden, undefined, '光标要显示出来');
  assert.equal(crosshair.attributes.x1, '886.0', '十字线落在吸附的桶上');
  const dot = h.get('usage-svg').querySelector('.chart-active-dot');
  assert.equal(dot.attributes.hidden, undefined);
  assert.match(dot.attributes.cy, /^\d/, '高亮点有真实 y 坐标');
  // 反过来移到左端
  holder.events.mousemove({ clientX: 60, type: 'mousemove' });
  assert.equal(h.state.chartIndex, 0);
  assert.match(tip.textContent, /2026-10-20 08:00 · 16\.9k tokens/);
  holder.events.mouseleave();
  assert.equal(tip.hidden, true);
  assert.equal(crosshair.attributes.hidden, '');
  assert.equal(h.state.chartIndex, null, '移出后回到未选中,下次渲染不会莫名浮出旧读数');
});

test('键盘与触摸:方向键/Home/End 读同一份信息,aria-live 播报,点击也能吸附', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const holder = h.get('usage-chart-holder');
  assert.equal(typeof holder.events.keydown, 'function');
  assert.equal(typeof holder.events.click, 'function', '触摸/点击要能打开读数');

  h.run('usageState.chartFocus = true');
  h.run("usageChartKey({ key: 'End' })");
  assert.equal(h.state.chartIndex, 1);
  const live = h.helpers.getLive();
  assert.ok(live, '键盘读数要有 aria-live 播报区');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.match(live.textContent, /2026-10-20 09:00:54\.5k tokens/);
  h.run("usageChartKey({ key: 'Home' })");
  assert.equal(h.state.chartIndex, 0);
  h.run("usageChartKey({ key: 'ArrowRight' })");
  assert.equal(h.state.chartIndex, 1);
  h.run("usageChartKey({ key: 'ArrowRight' })");
  assert.equal(h.state.chartIndex, 1, '到末尾就停住,不越界');
  const tip = holder.querySelector('.chart-tip');
  assert.match(tip.textContent, /09:00 · 54\.5k tokens/, '键盘与悬停说同一句话');
  // Esc 收起,但输入焦点仍在图里
  h.run("usageChartKey({ key: 'Escape' })");
  assert.equal(tip.hidden, true);

  // 触摸:click 事件带 clientX,同样按最近的桶吸附
  holder.events.click({ clientX: 60, type: 'click' });
  assert.equal(h.state.chartIndex, 0);
  assert.match(tip.textContent, /08:00/);
  // 鼠标/触摸自己打开的浮层,指针移出就收起
  holder.events.mouseleave();
  assert.equal(tip.hidden, true);

  // 方向键读数则不受鼠标移出影响
  h.run("usageChartKey({ key: 'End' })");
  holder.events.mouseleave();
  assert.equal(tip.hidden, false);
  holder.events.focusout();
  assert.equal(tip.hidden, true);
  assert.equal(h.state.chartFocus, false);
});

test('同一批时间桶重画时保留读数位置;数据没变则连重画都省掉', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const holder = h.get('usage-chart-holder');
  holder.events.mousemove({ clientX: 60, type: 'mousemove' });
  assert.equal(h.state.chartIndex, 0);

  // 轮询返回完全相同的数据:不重画,浮层保持打开
  await h.run('loadUsage()');
  assert.equal(h.state.chartIndex, 0);
  assert.equal(holder.querySelector('.chart-tip').hidden, false, '同数据的轮询不该把正在看的浮层关掉');

  // 同一批桶、数值变了:重画,但读数仍停在同一个桶
  const next = usageFixture();
  next.series = next.series.map(bucket => ({ ...bucket, tokens_in: bucket.tokens_in + 100 }));
  h.setResponse(next);
  await h.run('loadUsage()');
  assert.equal(h.state.chartIndex, 0, '时间轴没换,键盘/悬停位置不能无端重置');
  assert.equal(holder.querySelector('.chart-tip').hidden, false);
  assert.match(holder.querySelector('.chart-tip').textContent, /16\.9k|17\.0k/, '浮层跟着新数据更新');
});

test('按桶明细表:懒建一次,逐桶列出全部数值,标签转义', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const trend = h.helpers.getTrend();
  assert.ok(trend, '图表旁边要有按时间桶的表');
  assert.equal(trend.details.className, 'usage-trend-table');
  assert.equal(trend.details.hidden, false);
  assert.equal(trend.summary.textContent, '按时间桶查看数据(共 2 个桶)');
  assert.equal((trend.body.innerHTML.match(/<tr>/g) || []).length, 2);
  assert.match(trend.body.innerHTML, /2026-10-20 08:00/);
  assert.match(trend.body.innerHTML, /16\.9k/, '08:00 桶的合计 tokens 与浮层一致');
  assert.match(trend.body.innerHTML, /54\.5k/);
  const head = trend.body.parentNode.children.find(child => child.tagName === 'thead');
  assert.doesNotMatch(head._html, /金额|成本|价格/, '明细表没有金额列');

  // 时间字符串来自日志,必须转义后再进表格
  const evil = '<img src=x onerror="alert(1)">';
  h.setResponse({ ...usageFixture(), series: [{ t: `2026-10-20T08:00${evil}`, reqs: 1, tokens_in: 1000, tokens_out: 0, cache_read: 0 }] });
  await h.run('loadUsage()');
  assert.match(trend.body.innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/, '标签要被转义');
  assert.doesNotMatch(trend.body.innerHTML, /<img/, '不能把日志内容当 HTML 插进来');
  // 浮层用 textContent,同样的字符串只当文字
  const holder = h.get('usage-chart-holder');
  holder.events.mousemove({ clientX: 50, type: 'mousemove' });
  const tip = holder.querySelector('.chart-tip');
  assert.equal(tip._html, '', '浮层不走 innerHTML');
  assert.match(tip.textContent, /<img src=x/, '原样文字显示,不执行');
});

test('空区间:不画图、不留空表;窄屏浮层夹在可视宽度内而不是隐藏', async () => {
  const h = harness();
  h.setResponse({ ...usageFixture(), series: [] });
  await h.run('loadUsage()');
  assert.match(h.get('usage-svg').innerHTML, /这个区间里没有请求/);
  assert.doesNotMatch(h.get('usage-svg').innerHTML, /chart-line/);
  assert.equal(h.run('usageTrend'), null, '空区间不建按桶表');

  // 先有数据再变空:表要收起
  h.setResponse(usageFixture());
  await h.run('loadUsage()');
  const trend = h.helpers.getTrend();
  assert.equal(trend.details.hidden, false);
  h.setResponse({ ...usageFixture(), series: [] });
  await h.run('loadUsage()');
  assert.equal(trend.details.hidden, true);
  assert.equal(trend.body.innerHTML, '');

  // 窄屏:浮层不隐藏,只把 left 夹到面板内
  h.setResponse(usageFixture());
  await h.run('loadUsage()');
  const holder = h.get('usage-chart-holder');
  const svg = h.get('usage-svg');
  holder.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 210 });
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 210 });
  holder.events.mousemove({ clientX: 300, type: 'mousemove' });
  const tip = holder.querySelector('.chart-tip');
  assert.equal(tip.hidden, false, '手机上要显示浮层,不能整块藏掉');
  assert.equal(tip.style.left, '152px', '320 - 160 - 8:贴在面板右侧内边距里');
  assert.equal(tip.style.top, '8px');
  const live = h.helpers.getLive();
  assert.doesNotMatch(String(live && live.className), /chart-tip/, '播报区不是浮层');
});

test('使用说明与无障碍:svg 可聚焦、标注指标与键盘操作', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const svg = h.get('usage-svg');
  assert.equal(svg.attributes.tabindex, '0');
  assert.equal(svg.attributes.role, 'img');
  assert.match(svg.attributes['aria-label'], /Tokens 趋势/);
  assert.match(svg.attributes['aria-label'], /左右方向键/);
  // 空区间时说明为什么没有图
  h.setResponse({ ...usageFixture(), series: [] });
  await h.run('loadUsage()');
  assert.match(svg.attributes['aria-label'], /没有请求/);
});

test('明细表跟图表指纹解耦:合计不变、分项变化时表也要更新', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const trend = h.helpers.getTrend();
  const lineBefore = (h.get('usage-svg').innerHTML.match(/class="chart-line"[^>]*d="([^"]+)"/) || [])[1];
  assert.ok(lineBefore, '折线要画出来');

  // 新增输入 -1000 / 输出 +1000:当前指标(合计 tokens)完全不变 → 图线不该动
  const shifted = usageFixture();
  shifted.series = shifted.series.map(bucket => ({
    ...bucket, tokens_in: bucket.tokens_in - 1000, tokens_out: bucket.tokens_out + 1000,
  }));
  h.setResponse(shifted);
  await h.run('loadUsage()');
  const lineAfter = (h.get('usage-svg').innerHTML.match(/class="chart-line"[^>]*d="([^"]+)"/) || [])[1];
  assert.equal(lineAfter, lineBefore, '合计不变时同一批桶的折线应完全相同');
  // 但明细表必须反映新的分项
  assert.match(trend.body.innerHTML, /3\.0k/, '08:00 新增输入从 4.0k 变 3.0k,表要更新');
  assert.match(trend.body.innerHTML, /1\.9k/, '08:00 输出从 0.9k 变 1.9k,表要更新');

  // 请求数变化而 tokens 合计不变(当前指标是 tokens):表里的请求列也要更新
  const reqShift = usageFixture();
  reqShift.series = reqShift.series.map((bucket, i) => ({ ...bucket, reqs: bucket.reqs + 100 + i }));
  h.setResponse(reqShift);
  await h.run('loadUsage()');
  assert.match(trend.body.innerHTML, /<td>110<\/td>/, '08:00 请求数 10 → 110');
});

test('空桶补齐但确实没有请求:不画贴底 0 线,表也收起', async () => {
  const h = harness();
  // 接口给 24 个补齐的零桶,reqs 全 0、tokens 全 0
  const zeroBuckets = Array.from({ length: 24 }, (_, i) => ({
    t: `2026-10-20T${String(i).padStart(2, '0')}:00`, reqs: 0, tokens_in: 0, tokens_out: 0, cache_read: 0,
  }));
  h.setResponse({ ...usageFixture(), totals: { ...usageFixture().totals, reqs: 0, tokens_total: 0 }, series: zeroBuckets });
  await h.run('loadUsage()');
  assert.match(h.get('usage-svg').innerHTML, /这个区间里没有请求/, '零桶不能画成一条贴底的线');
  assert.doesNotMatch(h.get('usage-svg').innerHTML, /chart-line/);
  assert.match(h.get('usage-svg').attributes['aria-label'], /没有请求/);
  assert.equal(h.run('usageTrend'), null, '全零区间不留一张全零表');
  assert.equal(h.helpers.usageSeriesHasRequests({ totals: { reqs: 0 } }, zeroBuckets), false);

  // 有请求但当前指标为 0(tokens 全 0):仍然要画线,不能被当成"没有请求"
  const reqOnly = zeroBuckets.map((bucket, i) => ({ ...bucket, reqs: i + 1 }));
  h.setResponse({ ...usageFixture(), totals: { ...usageFixture().totals, reqs: 300, tokens_total: 0 }, series: reqOnly });
  await h.run('loadUsage()');
  assert.match(h.get('usage-svg').innerHTML, /chart-line/, '有请求就是有数据,哪怕是 0 token');
  assert.doesNotMatch(h.get('usage-svg').innerHTML, /这个区间里没有请求/);
  assert.equal(h.helpers.usageSeriesHasRequests({ totals: { reqs: 300 } }, reqOnly), true);
  // 切到请求指标后是一条正常的阶梯线,不是空态
  h.run("setUsageMetric('reqs')");
  assert.match(h.get('usage-svg').innerHTML, /chart-line/);
  assert.match(h.helpers.getTrend().body.innerHTML, /<td>1<\/td>/, '按桶表照常列出真实请求数');
});

test('总量未知(totals 缺失)时按桶判断:有请求就画,全 0 才判空', async () => {
  const h = harness();
  const buckets = Array.from({ length: 3 }, (_, i) => ({ t: `2026-10-20T0${i}:00`, reqs: i === 1 ? 4 : 0, tokens_in: 100, tokens_out: 0, cache_read: 0 }));
  assert.equal(h.helpers.usageSeriesHasRequests({}, buckets), true);
  assert.equal(h.helpers.usageSeriesHasRequests({ totals: {} }, buckets), true, 'totals.reqs 缺失不等于 0');
  const dead = buckets.map(bucket => ({ ...bucket, reqs: 0, tokens_in: 0 }));
  assert.equal(h.helpers.usageSeriesHasRequests({ totals: {} }, dead), false);
  // totals 明确为 0 但桶里确有请求:以桶为准,照画(不把真实请求吞掉)
  assert.equal(h.helpers.usageSeriesHasRequests({ totals: { reqs: 0 } }, buckets), true);
  assert.equal(h.helpers.usageSeriesHasRequests(null, []), false, '没有数据也不抛');
  // 老日志行没有 reqs 字段但有 tokens:那是真实消耗,不能当空区间藏掉
  assert.equal(h.helpers.usageSeriesHasRequests({ totals: {} }, [{ t: '2026-10-20T01:00', cache_read: 500 }]), true);
  assert.equal(h.helpers.usageSeriesHasRequests({ totals: { reqs: 0 } }, [{ t: '2026-10-20T01:00', tokens_in: 20 }]), true);
});
