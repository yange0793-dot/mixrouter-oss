'use strict';
// 用量统计页(public/js/usage.js)的渲染与交互测试。
// 与 test/ui.test.js 一样跑在 vm 里:控制台是 classic script 多文件共用一个 realm,
// usage.js 直接读 app.js 声明的 `$` / `esc` / `toast` / `view`,所以这里把它们先塞进上下文
// —— 反过来也保证了「usage.js 不自己重复声明这些名字」这条硬约束会被加载动作本身验到。
//
// 日期默认相对「今天」构造,特定星期的用例固定本地时钟;日期键用本地年月日拼字符串。
// 测试本身也不能走 UTC 午夜,否则断言会在负时区差一天(那个 bug 正是 usage.js 要防的)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/usage.js'), 'utf8');
// 显示格式直接用 app.js 的全站格式函数(与概览、诊断、会话同一套)。这里只把用到的顶层定义
// 抽进上下文,期望值也从它们算出来:不在测试里写死一种格式,app.js 改格式时本测试跟着走;
// 改了名或多了依赖,这里会报「找不到」或 ReferenceError,而不是静默通过。
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const appDefinition = name => {
  const match = new RegExp(`^const ${name} = [\\s\\S]*?(?=^[^\\s}])`, 'm').exec(APP_SOURCE);
  if (!match) throw new Error(`app.js 里找不到 ${name} 的顶层定义`);
  return match;
};
// 按 app.js 里的先后顺序拼接:别名(const fmtDur = fmtTtfb 这类)必须排在被引用的定义之后。
const APP_FORMATTERS = ['finiteOrNull', 'fmtTok', 'fmtCount', 'fmtPct', 'fmtDur', 'fmtTtfb', 'fmtRate',
  'fmtFullTime', 'fmtWhen']
  .map(appDefinition).sort((a, b) => a.index - b.index).map(match => match[0]).join('\n');

const DAY_MS = 86400000;
const pad = value => String(value).padStart(2, '0');
const dateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const noonIso = date => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).toISOString();
const dayKeyAgo = days => dateKey(addDays(new Date(), -days));
const mondayIndex = date => (date.getDay() + 6) % 7;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// 只造 usage.js 真正会碰的 DOM:元素按 id 注册,取不到的返回 null(与浏览器一致)。
class Element {
  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = tagName;
    this.style = {};
    this.attributes = {};
    this.dataset = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.textContent = '';
    this._html = '';
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.classList = { set: new Set() };
    this.classList.add = (...xs) => xs.forEach(x => this.classList.set.add(x));
    this.classList.remove = (...xs) => xs.forEach(x => this.classList.set.delete(x));
    this.classList.contains = x => this.classList.set.has(x);
    this.classList.toggle = (x, force) => {
      const on = force === undefined ? !this.classList.set.has(x) : force;
      if (on) this.classList.set.add(x); else this.classList.set.delete(x);
      return on;
    };
  }
  set innerHTML(value) { this._html = String(value); }
  get innerHTML() { return this._html; }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    const data = /^data-(.+)$/.exec(name);
    if (data) this.dataset[data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(name) {
    if (Object.hasOwn(this.attributes, name)) return this.attributes[name];
    const data = /^data-(.+)$/.exec(name);
    if (data) {
      const key = data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return this.dataset[key] === undefined ? null : String(this.dataset[key]);
    }
    return null;
  }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { (this.events ||= {})[name] = callback; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  insertAdjacentHTML() {}
  querySelector(selector) {
    if (selector.startsWith('#')) {
      const id = selector.slice(1);
      for (const child of this.children || []) if (child.id === id) return child;
      return null;
    }
    if (selector.startsWith('.')) {
      const name = selector.slice(1);
      for (const child of this.children || []) {
        if (String(child.className || '').split(/\s+/).includes(name)) return child;
      }
      return null;
    }
    return null; // [data-date="…"] 这类属性选择器只有真实 DOM 才查得到
  }
  querySelectorAll(selector) {
    const attr = /^\[([\w-]+)\]$/.exec(selector);
    if (attr) return this.children.filter(child => child.getAttribute(attr[1]) !== null);
    return [];
  }
  closest() { return null; }
  focus() { this.focused = true; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 300 }; }
  get clientWidth() { return this._clientWidth ?? 900; }
  set clientWidth(value) { this._clientWidth = value; }
  get offsetWidth() { return this._offsetWidth ?? 160; }
  set offsetWidth(value) { this._offsetWidth = value; }
  remove() {}
}

const RANGE_IDS = ['today', '24h', '7d', '30d', 'all'];
const METRIC_IDS = ['tokens', 'reqs'];
const TAB_IDS = ['requests', 'providers', 'models'];
const APP_IDS = ['', 'claude', 'codex'];

function harness(options = {}) {
  const elements = new Map();
  const segs = { range: [], metric: [], tab: [], app: [] };
  const get = id => elements.get(id) || null;
  const ids = ['usage-reqs', 'usage-request-hint', 'usage-tokens', 'usage-token-split', 'usage-cache',
    'usage-cache-hint', 'usage-success', 'usage-ok-rate', 'usage-speed', 'usage-ttfb',
    'usage-status', 'usage-last-sync', 'usage-count', 'usage-range-label', 'usage-page-label',
    'usage-calendar-summary', 'usage-data-frame', 'usage-chart-holder', 'usage-heatmap',
    'usage-chart-empty', 'usage-chart-tooltip', 'usage-detail-panel', 'usage-sync',
    'usage-app', 'usage-provider', 'usage-model', 'usage-interval', 'usage-range-select',
    'usage-status-filter', 'usage-source', 'usage-source-toggle', 'usage-source-detail',
    'usage-calendar-expand', 'usage-prev', 'usage-next', 'usage-table-head', 'usage-rows',
    'usage-daily-details', 'usage-daily-rows', 'usage-fail',
    'usage-side-active', 'usage-side-daily-label', 'usage-side-daily', 'usage-side-peak'];
  for (const id of ids) elements.set(id, new Element(id));
  // 结构:.usage-chart > #usage-chart-holder > (#usage-heatmap, #usage-chart-empty, tooltip)
  const chart = new Element('usage-chart');
  chart.className = 'usage-chart';
  const holder = get('usage-chart-holder');
  // 日历列数按容器宽度算:默认 0(还没量到,退回 13 周的最短窗口),铺满宽度的用例显式给宽。
  holder.clientWidth = options.holderWidth ?? 0;
  chart.appendChild(holder);
  holder.appendChild(get('usage-heatmap'));
  holder.appendChild(get('usage-chart-empty'));
  holder.appendChild(get('usage-chart-tooltip'));
  elements.set('usage-chart', chart);
  get('usage-chart-tooltip').className = 'chart-tip';
  get('usage-chart-tooltip').hidden = true;
  get('usage-source').hidden = true;
  const dailyDetails = get('usage-daily-details');
  dailyDetails.className = 'usage-trend-table';
  const dailySummary = new Element('', 'summary');
  dailySummary.textContent = '按日查看数据';
  dailyDetails.appendChild(dailySummary);

  for (const id of RANGE_IDS) { const el = new Element(); el.dataset.range = id; segs.range.push(el); }
  for (const id of METRIC_IDS) { const el = new Element(); el.dataset.metric = id; segs.metric.push(el); }
  for (const id of TAB_IDS) {
    const el = new Element(`usage-tab-${id}`);
    el.dataset.usageTab = id;
    segs.tab.push(el);
    elements.set(el.id, el);
  }
  for (const id of APP_IDS) { const el = new Element(); el.dataset.usageApp = id; segs.app.push(el); }

  const requests = [];
  let response = options.response || usageFixture();
  let failNext = null;
  const gates = [];
  const intervals = new Map();
  const timeouts = new Map();
  let timerId = 0;
  let timeoutId = 0;
  const documentHandlers = {};
  const windowHandlers = {};
  const document = {
    visibilityState: 'visible',
    activeElement: null,
    getElementById: id => get(id),
    querySelectorAll: selector => {
      if (selector.includes('[data-range]')) return segs.range;
      if (selector.includes('[data-metric]')) return segs.metric;
      if (selector.includes('[data-usage-app]')) return segs.app;
      if (selector.includes('[data-usage-tab]')) return segs.tab;
      return [];
    },
    querySelector: selector => (selector === '.heatmap-legend' ? (options.legendEl || null) : null),
    addEventListener: (name, callback) => { (documentHandlers[name] ||= []).push(callback); },
    createElement: tag => new Element('', tag),
  };
  const store = new Map();
  const fixedMs = options.now ? options.now.getTime() : null;
  const Clock = fixedMs === null ? Date : class extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedMs])); }
    static now() { return fixedMs; }
  };
  const context = vm.createContext({
    document, console, window: { addEventListener: (name, callback) => { (windowHandlers[name] ||= []).push(callback); } },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    URLSearchParams, URL, Date: Clock, Math, JSON, Number, Object, Array, String, Set, Map, Promise, Error, isNaN,
    AbortController: class {
      constructor() {
        // fetch 侧用它判断"这一发已被取代/超时",需要能真的 reject。
        this.signal = { aborted: false, onabort: null };
      }
      abort() {
        if (this.signal.aborted) return;
        this.signal.aborted = true;
        if (typeof this.signal.onabort === 'function') this.signal.onabort();
      }
    },
    setTimeout: (fn) => { timeoutId += 1; timeouts.set(timeoutId, fn); return timeoutId; },
    clearTimeout: id => timeouts.delete(id),
    setInterval: (fn) => { timerId += 1; intervals.set(timerId, fn); return timerId; },
    clearInterval: id => intervals.delete(id),
    fetch: async (url, init = {}) => {
      const entry = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined };
      requests.push(entry);
      if (failNext) { const error = failNext; failNext = null; throw error; }
      const signal = init.signal || {};
      const gate = gates.shift();
      if (gate) {
        await new Promise((resolve, reject) => {
          signal.onabort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          gate.promise.then(resolve);
        });
      }
      const payload = structuredClone(gate ? gate.body : response);
      // 像真实后端一样回显本次请求的 offset,分页测试才能推进到下一页。
      const requested = Number(new URL(url, 'http://local').searchParams.get('offset'));
      if (payload && payload.dashboard && payload.dashboard.records && Number.isFinite(requested)) {
        payload.dashboard.records.offset = requested;
      }
      return { ok: true, status: 200, json: async () => payload };
    },
    // app.js 里的全局:`$` / `esc` / `toast` / `view`(fmt* 格式函数在下面单独载入)。usage.js 只能读,不能再声明。
    $: id => get(id),
    esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    view: 'usage',
    toasts: [],
  });
  context.toast = message => context.toasts.push(message);
  // 顶层 function 声明会挂到 vm 的全局对象上,但 const 不会 —— 用脚本尾部导出这些名字。
  vm.runInContext(APP_FORMATTERS, context, { filename: 'public/js/app.js (formatters)' });
  vm.runInContext(SOURCE + '\n;globalThis.__t = { usageState, usageHeatLevel, usageHeatThresholds, usageQuery, usageHeatModel, usageDayLabel, usageHeatCellText, getDaily: () => usageState.dailyRefs };', context, { filename: 'public/js/usage.js' });
  for (const callback of documentHandlers.DOMContentLoaded || []) callback();
  return {
    run: code => vm.runInContext(code, context),
    get,
    requests,
    context,
    intervals,
    document,
    state: context.__t.usageState,
    helpers: context.__t,
    segs,
    setResponse: value => { response = value; },
    resize: () => { for (const callback of windowHandlers.resize || []) callback(); },
    failNext: error => { failNext = error; },
    /** 挂起下一次 fetch,返回放行函数(用于验证「最后一次查询胜出」)。 */
    defer: body => {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      gates.push({ promise, body });
      return release;
    },
    /** 触发还没清掉的 setTimeout(读取超时用它)。 */
    fireTimeouts: () => { for (const fn of [...timeouts.values()]) { timeouts.clear(); fn(); } },
  };
}

// 四种状态都要覆盖:今天/昨天/三天前有量、五天前是真实的 0、三十天前有量(用于验证
// 「区间外不画成 0」)、覆盖窗口之外 120 天前(未覆盖)。数值让卡片与按日求和一致。
function usageFixture(options = {}) {
  const now = options.now || new Date();
  const scopeDays = options.scopeDays ?? 90;
  const coverageDays = options.coverageDays ?? 90;
  const scopeFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - scopeDays, 0, 0, 0);
  const coverageFirst = new Date(now.getFullYear(), now.getMonth(), now.getDate() - coverageDays, 0, 0, 0);
  const today = dateKey(now);
  const yesterday = dateKey(addDays(now, -1));
  const threeDaysAgo = dateKey(addDays(now, -3));
  const fiveDaysAgo = dateKey(addDays(now, -5));
  const thirtyDaysAgo = dateKey(addDays(now, -30));
  const daily = options.daily || [
    { t: thirtyDaysAgo, reqs: 21, tokens_in: 2000, tokens_out: 1000, cache_read: 2000 },
    { t: fiveDaysAgo, reqs: 0, tokens_in: 0, tokens_out: 0, cache_read: 0 },
    { t: threeDaysAgo, reqs: 5, tokens_in: 1000, tokens_out: 500, cache_read: 1000 },
    { t: yesterday, reqs: 9, tokens_in: 2000, tokens_out: 1000, cache_read: 2000 },
    { t: today, reqs: 7, tokens_in: 3000, tokens_out: 1500, cache_read: 3000 },
  ];
  const records = options.records || [
    { ts: new Date(now.getTime() - 60 * 60 * 1000).toISOString(), app: 'claude', provider: '主力渠道',
      model_in: 'claude-opus-4-8', model_out: 'claude-opus-4-8', status: 200, err: '',
      in: 3000, out: 1500, cache_read: 3000, ms: 2000, ttfb_ms: 300 },
    { ts: new Date(now.getTime() - 26 * 60 * 60 * 1000).toISOString(), app: 'claude', provider: '备用渠道',
      model_in: 'raw-alias-name', model_out: 'mystery-model', status: 200, err: '',
      in: 2000, out: 1000, cache_read: 2000, ms: 4000, ttfb_ms: 500 },
    { ts: new Date(now.getTime() - 3 * DAY_MS).toISOString(), app: 'codex', provider: '第三方渠道',
      model_in: 'gpt-5', model_out: 'gpt-5', status: 200, err: 'upstream boom',
      in: 1000, out: 500, cache_read: 1000, ms: 0, ttfb_ms: 0 },
  ];
  return {
    scope: {
      from: scopeFrom.toISOString(), to: now.toISOString(),
      timezone: 'Asia/Shanghai', bucket: 'day', source: 'disk+memory',
    },
    totals: {
      reqs: 42, ok_rate: 97.62, tokens_in: 8000, tokens_out: 4000, cache_read: 8000,
      tokens_total: 20000, cache_hit_rate: 0.5, speed_tps: 88.4, ttfb_p50_ms: 1250,
    },
    series: [
      { t: `${today}T08:00`, reqs: 7, tokens_in: 3000, tokens_out: 1500, cache_read: 3000 },
    ],
    by_provider: [
      { provider: '主力渠道', name: '主力渠道', reqs: 25, tokens_in: 5000, tokens_out: 2500, cache_read: 5000 },
      { provider: '备用渠道', name: '备用渠道', reqs: 12, tokens_in: 2000, tokens_out: 1000, cache_read: 2000 },
      { provider: '第三方渠道', name: '第三方渠道', reqs: 5, tokens_in: 1000, tokens_out: 500, cache_read: 1000 },
    ],
    by_model: [
      { model: 'claude-opus-4-8', reqs: 30, tokens_in: 6000, tokens_out: 3000, cache_read: 6000 },
      { model: 'mystery-model', reqs: 12, tokens_in: 2000, tokens_out: 1000, cache_read: 2000 },
    ],
    dashboard: {
      daily,
      by_channel: [
        { channel: 'id:p-main', provider_id: 'p-main', app: 'claude', name: '主力渠道', reqs: 25, tokens_in: 5000, tokens_out: 2500, cache_read: 5000 },
        { channel: 'id:p-backup', provider_id: 'p-backup', app: 'claude', name: '备用渠道', reqs: 12, tokens_in: 2000, tokens_out: 1000, cache_read: 2000 },
        { channel: 'id:c-third', provider_id: 'c-third', app: 'codex', name: '第三方渠道', reqs: 5, tokens_in: 1000, tokens_out: 500, cache_read: 1000 },
      ],
      records: { rows: records, total: options.total ?? 120, offset: 0, limit: 50, has_more: true },
      facets: {
        providers: ['主力渠道', '备用渠道', '第三方渠道'].map(value => ({ value, label: value })),
        models: ['claude-opus-4-8', 'mystery-model'].map(value => ({ value, label: value })),
        channels: [['id:p-main', '主力渠道', 'claude', 'p-main'], ['id:p-backup', '备用渠道', 'claude', 'p-backup'],
          ['id:c-third', '第三方渠道', 'codex', 'c-third']].map(([value, label, app, provider_id]) => ({ value, label, app, provider_id })),
      },
      coverage: {
        first_ts: noonIso(coverageFirst),
        last_ts: now.toISOString(),
      },
    },
  };
}

function cellsOf(html) {
  return [...html.matchAll(/<div class="heatmap-cell"([^>]*)><\/div>/g)].map(match => {
    const attrs = {};
    for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];
    return attrs;
  });
}
const cellFor = (h, key) => cellsOf(h.get('usage-heatmap').innerHTML).find(cell => cell['data-date'] === key);

test('四张指标卡:请求/tokens/缓存/成功率,补充指标进更多指标;null 显示「—」', async () => {
  const h = harness();
  await h.run('loadUsage()');
  assert.equal(h.get('usage-reqs').textContent, '42');
  assert.match(h.get('usage-request-hint').textContent, /\d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}/);
  // 数字格式统一走 app.js 的 fmtTok / fmtPct / fmtRate / fmtTtfb,期望值也从它们算;完整数字放 title。
  assert.equal(h.get('usage-tokens').textContent, h.run('fmtTok(20000)'));
  assert.equal(h.get('usage-tokens').getAttribute('title'), '20,000 tokens = 新增输入 8,000 + 输出 4,000 + 缓存读取 8,000');
  // 三段拆分各是一个不折行的小块(窄卡片整块换行),每块带完整数字。
  const split = h.get('usage-token-split').innerHTML;
  for (const [label, value] of [['新增', 8000], ['输出', 4000], ['缓存', 8000]]) {
    assert.ok(split.includes(`<span class="usage-split" title="${value.toLocaleString('en-US')}"><span>${label}</span> ${h.run(`fmtTok(${value})`)}</span>`), `拆分里要有 ${label}`);
  }
  assert.equal(h.get('usage-cache').textContent, '50.0%');
  assert.equal(h.get('usage-success').textContent, '97.6%');
  // 次数已在「总请求数」卡里;成功率副标题只说判定口径,失败次数由徽标直接给。
  assert.match(h.get('usage-ok-rate').textContent, /断流与取消计为失败/);
  assert.equal(h.get('usage-fail').textContent, '失败 1 次', '42 × 2.38% ≈ 1 次');
  assert.equal(h.get('usage-speed').textContent, h.run('fmtRate({ out: 88.4, ms: 1000 })'), '聚合速度与诊断页同一套格式');
  assert.match(h.get('usage-speed').textContent, /^88/);
  assert.equal(h.get('usage-ttfb').textContent, h.run('fmtTtfb(1250)'));
  assert.match(h.get('usage-ttfb').textContent, /1\.3s/, '1250ms 应显示成 1.3s');

  h.setResponse({
    scope: {}, totals: { reqs: 0, ok_rate: null, cache_hit_rate: null, speed_tps: null, ttfb_p50_ms: null, tokens_total: null },
    series: [], by_provider: [], by_model: [],
    dashboard: { daily: [], records: { rows: [], total: 0, offset: 0, limit: 50, has_more: false },
      facets: { providers: [], models: [] }, coverage: { first_ts: null, last_ts: null } },
  });
  await h.run('loadUsage()');
  assert.equal(h.get('usage-tokens').textContent, '—');
  assert.equal(h.get('usage-cache').textContent, '—');
  assert.equal(h.get('usage-success').textContent, '—');
  assert.equal(h.get('usage-speed').textContent, '—');
  assert.match(h.get('usage-ok-rate').textContent, /暂无成功率样本/);
  assert.match(h.get('usage-token-split').innerHTML, /<span>新增<\/span> —/, '拆分缺失也是「—」,不是 0');
  assert.equal(h.get('usage-fail').hidden, true);
});

test('查询:默认全部区间,带 dashboard=1 与 offset/limit;筛选值进同一个查询串', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const url = h.requests.at(-1).url;
  assert.match(url, /^\/api\/usage\?/);
  assert.match(url, /dashboard=1/);
  assert.match(url, /range=all/);
  assert.match(url, /offset=0/);
  assert.match(url, /limit=50/);
  assert.equal(h.get('usage-range-select').value, 'all');

  h.run("setUsageFilter('app', 'codex')");
  assert.match(h.requests.at(-1).url, /app=codex/);
  // 供应商下拉的值是渠道键,按 channel 参数发出去(显示名不唯一,不再按 provider 名筛)
  h.run("setUsageFilter('provider', 'id:p-main')");
  assert.match(decodeURIComponent(h.requests.at(-1).url), /channel=id:p-main/);
  assert.doesNotMatch(h.requests.at(-1).url, /provider=/);
  h.run("setUsageFilter('model', 'claude-opus-4-8')");
  assert.match(decodeURIComponent(h.requests.at(-1).url), /model=claude-opus-4-8/);

  // 非法值一律忽略:'bogus' 状态等价于「全部」,但当前已经是全部,不该触发请求
  const before = h.requests.length;
  h.run("setUsageFilter('app', 'bogus')");
  h.run("setUsageStatus('bogus')");
  h.run("setUsageRange('bogus')");
  h.run("setUsageMetric('bogus')");
  assert.equal(h.requests.length, before, '非法筛选/区间/指标必须被忽略');

  h.run("setUsageStatus('err')");
  assert.match(h.requests.at(-1).url, /status=err/);
  assert.equal(h.get('usage-status-filter').value, 'err');

  h.run('clearUsageFilters()');
  const cleared = decodeURIComponent(h.requests.at(-1).url);
  assert.doesNotMatch(cleared, /app=|provider=|channel=|model=|status=/);
  assert.equal(h.state.provider, '');
  assert.equal(h.get('usage-provider').value, '');
});

test('热力图:按覆盖周裁剪、周一为首列,区间外/未覆盖/未来/真实 0 各标各的', async () => {
  const now = new Date(2026, 9, 19, 12); // 周一:本周剩余六天均为未来,不随执行日变化。
  const keyAgo = days => dateKey(addDays(now, -days));
  const h = harness({ now, response: usageFixture({ now }) });
  await h.run('loadUsage()');
  const html = h.get('usage-heatmap').innerHTML;
  const cells = cellsOf(html);
  const visibleWeeks = 14; // 2026-07-21(周二)到 10-19(周一)跨 14 个日历周。
  assert.equal(cells.length, visibleWeeks * 7, '90 天覆盖从 7 月 20 日起画,不强制补到 53 周');
  assert.equal(cells[0]['data-date'], '2026-07-20');
  const first = new Date(cells[0]['data-date'] + 'T00:00:00');
  assert.equal((first.getDay() + 6) % 7, 0, '第一列是周一');
  assert.equal(cells[7]['data-date'], dateKey(addDays(first, 7)), '按列推进:每列一周');
  const last = new Date(cells.at(-1)['data-date'] + 'T00:00:00');
  assert.equal(last.getDay(), 0, '最后一格是周日');
  assert.match(html, /heatmap-months/, '要有月份刻度');
  assert.match(html, /heatmap-weekdays/);
  assert.match(html, /heatmap-legend/);
  assert.equal(h.get('usage-heatmap').attributes.role, 'group', '容器不能再是 img(否则格子从无障碍树里消失)');
  assert.match(h.get('usage-heatmap').attributes['aria-label'], new RegExp(`${visibleWeeks} 周`));

  const today = dateKey(now);
  const todayCell = cellFor(h, today);
  assert.ok(todayCell, '今天必须在网格里');
  assert.equal(todayCell['data-active'], 'true');
  assert.equal(todayCell['data-coverage'], 'inside');
  assert.equal(todayCell['data-future'], undefined);
  assert.ok(Number(todayCell['data-level']) > 0, '今天有真实用量,色阶不能是 0');

  // 覆盖范围内但没有任何请求的一天:真实 0,不是「未覆盖」
  const zeroCell = cellFor(h, keyAgo(10));
  assert.equal(zeroCell['data-level'], '0');
  assert.equal(zeroCell['data-active'], 'true');
  assert.equal(zeroCell['data-coverage'], 'inside');

  // 起始周的周一在覆盖边界之前:仍然是未覆盖,不能画成真实 0。
  assert.equal(cellFor(h, keyAgo(120)), undefined, '更早的空白历史已裁掉');
  const outside = cellFor(h, '2026-07-20');
  assert.equal(outside['data-coverage'], 'outside');
  assert.equal(outside['data-level'], '0');
  assert.equal(outside['data-active'], 'false');

  // 本周剩下的日子是未来:数量 = 周日之前还剩几天
  const remaining = 6 - mondayIndex(now);
  assert.equal(remaining, 6, '固定周一覆盖所有未来日期');
  const future = cells.filter(cell => cell['data-future'] === 'true');
  assert.equal(future.length, remaining);
  for (const cell of future) assert.ok(cell['data-date'] > today);

  // 图例要把「未覆盖」「未来」与 0 分开写出来(「不在区间」见切换区间的用例)
  assert.match(html, /未覆盖/);
  assert.match(html, /未来/);
  assert.match(html, /0 请求/);
  assert.match(html, /title="未覆盖:数据源没有这一天的日志,不是 0"/, '未覆盖 ≠ 0 写在色块的 title 里');
  // 7 月 20 日既没有日志也不在区间:格子读作「未覆盖」,图例不另给一个「不在区间」。
  assert.doesNotMatch(html, /不在区间/);

  // 漫游 tabindex:只有一格是 Tab 停靠点
  assert.equal(cells.filter(cell => cell.tabindex === '0').length, 1);
  assert.equal(cells.find(cell => cell.tabindex === '0')['data-date'], today, '默认停在最新的可读日期');

  // 按日表格是热力图的等价物:区间内有覆盖的每一天都在,包括真实的 0
  const dailyRows = h.get('usage-daily-rows').innerHTML;
  assert.match(dailyRows, new RegExp(`<td>${keyAgo(5)}</td><td>0</td>`), '真实的 0 要出现在按日表里');
  assert.match(dailyRows, new RegExp(`<td>${today}</td>`));
  // 标题下一行只说窗口(周数 + 起始日);区间总量只在指标卡里出现一次。
  assert.equal(h.get('usage-range-label').textContent, `最近 ${visibleWeeks} 周 · 2026-07-20 起`);
  // 窗口里有未覆盖的格子时,摘要补一句最早日志的(本地)日期。
  assert.equal(h.get('usage-calendar-summary').textContent, `最早一条日志 ${keyAgo(90)},之前的日期未覆盖。`);
  assert.equal(h.get('usage-calendar-summary').hidden, false);
  assert.doesNotMatch(html, /¥|cost|price/i, '热力图不带金额折算');
});

test('热力图:周日已到本周末,没有未来格也不显示未来图例', async () => {
  const now = new Date(2026, 9, 25, 12);
  const h = harness({ now, response: usageFixture({ now }) });
  await h.run('loadUsage()');
  const html = h.get('usage-heatmap').innerHTML;
  const cells = cellsOf(html);
  assert.equal(cells.length, 13 * 7, '2026-07-27 到 10-25 正好 13 周,不强制补到 53 周');
  assert.equal(cells.at(-1)['data-date'], dateKey(now), '最后一格就是今天');
  assert.equal(cells.filter(cell => cell['data-future'] === 'true').length, 0);
  assert.doesNotMatch(html, /未来/, '没有未来日期时不需要未来图例');
  assert.equal(cellFor(h, dateKey(now))['data-active'], 'true');
});

test('切换区间:热力图按覆盖范围裁剪,区间外的日子标成「不在区间」而不是零历史', async () => {
  const h = harness({ response: usageFixture({ scopeDays: 7 }) });
  await h.run('loadUsage()');
  const old = cellFor(h, dayKeyAgo(30));
  assert.equal(old['data-active'], 'false', '30 天前不在近 7 天区间里');
  assert.equal(old['data-level'], '0', '区间外有数据也不许画色阶');
  assert.equal(old['data-coverage'], 'inside', '它在日志覆盖范围内,只是不在当前区间');
  assert.equal(old['data-inactive'], 'true');
  assert.match(String(old.style || ''), /opacity/, '区间外的格子要淡化,不能和真实 0 同色');
  assert.match(h.get('usage-heatmap').innerHTML, /不在区间/);
  const rows = h.get('usage-daily-rows').innerHTML.match(/<tr>/g) || [];
  assert.equal(rows.length, 8, '近 7 天共 8 个自然日,不把 53 周全画进表里');

  h.setResponse(usageFixture({ scopeDays: 30 }));
  h.run("setUsageRange('30d')");
  await tick();
  assert.match(h.requests.at(-1).url, /range=30d/);
  assert.equal(h.get('usage-range-select').value, '30d');
  assert.equal(h.get('usage-calendar-expand').hidden, true, '近 30 天没有更早的选中日期');
});

test('短覆盖只画 13 周,而长历史封顶 53 周且可继续展开', async () => {
  const now = new Date(2026, 9, 25, 12);
  const short = harness({ now, response: usageFixture({ now, coverageDays: 14, scopeDays: 14 }) });
  await short.run('loadUsage()');
  const cells = cellsOf(short.get('usage-heatmap').innerHTML);
  assert.equal(cells.length, 91);
  assert.equal(cells[0]['data-date'], '2026-07-27');
  assert.equal(cellFor(short, '2026-10-10')['data-coverage'], 'outside');
  assert.equal(cellFor(short, '2026-10-11')['data-coverage'], 'inside');
  assert.equal(short.get('usage-calendar-expand').hidden, true);

  const long = harness({ now, response: usageFixture({ now, coverageDays: 800, scopeDays: 800 }) });
  await long.run('loadUsage()');
  assert.equal(cellsOf(long.get('usage-heatmap').innerHTML).length, 371);
  assert.equal(long.get('usage-calendar-expand').hidden, false);
  long.run('expandUsageCalendar()');
  assert.equal(cellsOf(long.get('usage-heatmap').innerHTML).length, 742);
  assert.equal(long.get('usage-calendar-expand').hidden, false, '还存在未展示的更早记录');
});

test('展开更早的 53 周:只在统计区间伸到当前块之前时出现,点击后加一块', async () => {
  const h = harness({ response: usageFixture({ coverageDays: 400, scopeDays: 400 }) });
  await h.run('loadUsage()');
  const expand = h.get('usage-calendar-expand');
  assert.equal(expand.hidden, false, '400 天的记录比 53 周更早,应可展开');
  assert.equal(cellsOf(h.get('usage-heatmap').innerHTML).length, 371);
  h.run('expandUsageCalendar()');
  assert.equal(cellsOf(h.get('usage-heatmap').innerHTML).length, 742, '再往前一块 53 周');
  assert.match(h.get('usage-range-label').textContent, /^已展开 106 周 · \d{4}-\d{2}-\d{2} 起$/);
  assert.equal(expand.hidden, true, '覆盖到最早记录后按钮收起');
});

test('筛选下拉:facets 提供兄弟项、选中项保留、未知值不静默重置、打开时不重填', async () => {
  const h = harness();
  await h.run('loadUsage()');
  assert.match(h.get('usage-provider').innerHTML, /主力渠道/);
  assert.match(h.get('usage-provider').innerHTML, /备用渠道/, '选了 A 之后 B 仍在清单里');
  assert.match(h.get('usage-model').innerHTML, /claude-opus-4-8/);

  h.run("setUsageFilter('provider', 'id:p-main')");
  await tick();
  assert.equal(h.get('usage-provider').value, 'id:p-main');
  assert.match(h.get('usage-provider').innerHTML, /备用渠道/);

  // 选中值不在 facets 里:必须继续显示为选中并给「无匹配」,不能退回全部
  h.run("setUsageFilter('model', 'disappeared-model')");
  await tick();
  assert.equal(h.state.model, 'disappeared-model');
  assert.equal(h.get('usage-model').value, 'disappeared-model');
  assert.match(h.get('usage-model').innerHTML, /disappeared-model.*无匹配/);

  // 下拉正打开(activeElement)时,选项变了也先不重填;失焦后再换
  const provider = h.get('usage-provider');
  h.document.activeElement = provider;
  const before = provider._html;
  const changed = usageFixture();
  changed.dashboard.facets.channels.push({ value: 'id:p-new', label: '新渠道', app: 'claude', provider_id: 'p-new' });
  h.setResponse(changed);
  await h.run('loadUsage()');
  assert.equal(provider._html, before, '打开着的下拉不能被重填');
  h.document.activeElement = null;
  await h.run('loadUsage()');
  assert.match(provider._html, /新渠道/);
});

test('标签页:请求/供应商/模型同批筛选,表头与 aria 跟着切', async () => {
  const h = harness();
  await h.run('loadUsage()');
  assert.match(h.get('usage-table-head').innerHTML, /时间/);
  assert.match(h.get('usage-rows').innerHTML, /主力渠道/);
  assert.match(h.get('usage-rows').innerHTML, /Anthropic/);
  // 速度由 out / ms 算出,格式与诊断页一致(1500 / 2s = 750)。
  assert.match(h.run('fmtRate({ out: 1500, ms: 2000 })'), /^750\D/);
  assert.ok(h.get('usage-rows').innerHTML.includes(`<td>${h.run('fmtRate({ out: 1500, ms: 2000 })')}</td>`));
  // err 覆盖数值 200:主文案是「失败」,HTTP 状态码是次级小字,原始错误进 title。
  assert.ok(h.get('usage-rows').innerHTML.includes('<span class="usage-st" title="HTTP 200 · upstream boom"><span class="badge err badge-dot">失败</span><span class="usage-st-code">200</span></span>'));

  h.run("setUsageTab('providers')");
  assert.match(h.get('usage-table-head').innerHTML, /供应商/);
  assert.match(h.get('usage-rows').innerHTML, /第三方渠道/);
  assert.equal(h.get('usage-tab-providers').attributes['aria-selected'], 'true');
  assert.equal(h.get('usage-tab-requests').attributes['aria-selected'], 'false');
  assert.equal(h.get('usage-detail-panel').attributes['aria-labelledby'], 'usage-tab-providers');
  assert.match(h.get('usage-count').textContent, /3 个供应商/);

  h.run("setUsageTab('models')");
  assert.match(h.get('usage-rows').innerHTML, /mystery-model/);
  assert.equal(h.get('usage-tab-models').attributes['aria-selected'], 'true');
});

test('请求明细:model_out 为主、别名次要标注,缺失遥测显示「—」而不是 0', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const html = h.get('usage-rows').innerHTML;
  assert.match(html, /mystery-model/);
  assert.match(html, /别名 raw-alias-name/);
  assert.match(html, /title="日志里的原始模型名 raw-alias-name"/);

  const missing = usageFixture();
  missing.dashboard.records.rows = [{
    ts: new Date().toISOString(), app: 'claude', provider: 'p', model_in: '', model_out: 'm', status: 200, err: '',
  }];
  missing.dashboard.records.total = 1;
  h.setResponse(missing);
  await h.run('loadUsage()');
  const row = h.get('usage-rows').innerHTML;
  assert.match(row, /<td>—<\/td>/, '缺少 token/速度/首字一律「—」');
  assert.doesNotMatch(row, /<td>0<\/td>/, '缺失遥测不能显示成 0');
  h.run("setUsageTab('models')");
  h.run("setUsageTab('requests')");

  // 0 与缺失独立判断,不能从一项已知用量补造其它项。
  const zeros = usageFixture();
  zeros.dashboard.records.rows = [
    { ts: new Date().toISOString(), app: 'claude', provider: 'p', model_out: 'm', status: 200, err: '', in: 10, out: 0, cache_read: 0, ms: 100 },
    { ts: new Date().toISOString(), app: 'claude', provider: 'p', model_out: 'm', status: 502, err: 'bad', in: 0, out: 0, cache_read: 0, ms: 100 },
    { ts: new Date().toISOString(), app: 'claude', provider: 'p', model_out: 'm', status: 200, in: 10, out: null, ms: 100 },
  ];
  zeros.dashboard.records.total = 3;
  h.setResponse(zeros);
  await h.run('loadUsage()');
  const [reported, zero, partial] = h.get('usage-rows').innerHTML.split('</tr>');
  assert.match(reported, /<td>10<\/td><td>0<\/td><td>0<\/td>/, '记了用量的行里 0 照实显示');
  assert.match(zero, /<td>0<\/td><td>0<\/td><td>0<\/td>/, '失败记录里的 0 也按服务端值显示');
  assert.match(partial, /<td>10<\/td><td>—<\/td><td>—<\/td>/, '已知输入量不能让未知输出和缓存变成 0');
});

test('请求明细:状态给人话标签,状态码作次级小字,原始错误进 title;时间点按今天/今年/更早缩写', async () => {
  const now = new Date(2026, 10, 6, 15, 30);
  const fixture = usageFixture({ now });
  fixture.dashboard.records.rows = [
    { ts: new Date(2026, 10, 6, 9, 5, 7).toISOString(), app: 'claude', provider: 'p', model_out: 'm',
      status: 200, err: '', err_class: 'stream_aborted', in: 10, out: 0, cache_read: 0, ms: 100, ttfb_ms: 40 },
    { ts: new Date(2026, 2, 3, 8, 9, 10).toISOString(), app: 'codex', provider: 'p', model_out: 'm',
      status: 429, err: 'slow down', err_class: 'rate_limit', in: 0, out: 0, cache_read: 0 },
    { ts: new Date(2025, 11, 31, 23, 0, 0).toISOString(), app: 'claude', provider: 'p', model_out: 'm',
      status: 0, err: 'socket hang up', in: 0, out: 0, cache_read: 0 },
  ];
  fixture.dashboard.records.total = 3;
  const h = harness({ now, response: fixture });
  await h.run('loadUsage()');
  const [today, thisYear, older] = h.get('usage-rows').innerHTML.split('</tr>');
  // 时间点:今天 HH:mm:ss,今年 MM-DD HH:mm,更早 YYYY-MM-DD;完整时间一律在 title。
  assert.match(today, /^<tr><td title="2026-11-06 09:05:07">09:05:07<\/td>/);
  assert.match(thisYear, /^<tr><td title="2026-03-03 08:09:10">03-03 08:09<\/td>/);
  assert.match(older, /^<tr><td title="2025-12-31 23:00:00">2025-12-31<\/td>/);
  // err_class 换成诊断页筛选里的同一套叫法;原始分类码只在 title 里,不当主文案。
  assert.ok(today.includes('<span class="usage-st" title="HTTP 200 · stream_aborted"><span class="badge err badge-dot">断流</span><span class="usage-st-code">200</span></span>'));
  assert.ok(thisYear.includes('<span class="usage-st" title="HTTP 429 · rate_limit · slow down"><span class="badge err badge-dot">限流</span><span class="usage-st-code">429</span></span>'));
  assert.ok(older.includes('<span class="usage-st" title="没有拿到上游响应 · socket hang up"><span class="badge err badge-dot">失败</span></span>'), '没有状态码时不显示 0');
  assert.doesNotMatch(h.get('usage-rows').innerHTML, />stream_aborted</, '内部枚举不进可见文字');
});

test('分页:请求页走服务端 offset,供应商页本地切片且不重新请求', async () => {
  const h = harness();
  await h.run('loadUsage()');
  // 总数只在表格上方的计数行出现一次,分页行只说第几页。
  assert.equal(h.get('usage-page-label').textContent, '第 1 / 3 页');
  assert.equal(h.get('usage-count').textContent, '共 120 条请求 · 按时间倒序');
  assert.equal(h.get('usage-prev').disabled, true);
  assert.equal(h.get('usage-next').disabled, false);

  const before = h.requests.length;
  h.run('usagePage(1)');
  assert.equal(h.requests.length, before + 1, '请求页翻页要重新取该页的 records');
  assert.match(h.requests.at(-1).url, /offset=50/);
  await tick();
  assert.match(h.get('usage-page-label').textContent, /第 2 \/ 3 页/);
  assert.equal(h.get('usage-prev').disabled, false);
  assert.equal(h.state.offset, 50);

  // 供应商/模型是在同一批匹配行上的聚合:本地切片,不再请求
  const next = usageFixture();
  next.dashboard.by_channel = next.dashboard.by_channel.concat([
    { channel: 'id:p-4', provider_id: 'p-4', app: 'claude', name: '第四渠道', reqs: 1, tokens_in: 1, tokens_out: 1, cache_read: 0 },
  ]);
  h.setResponse(next);
  h.run('usageState.limit = 2; usagePage(1)'); // 先把请求页归位
  await tick();
  h.run("usageState.offset = 0; setUsageTab('providers')");
  const fetches = h.requests.length;
  assert.equal(h.get('usage-page-label').textContent, '第 1 / 2 页');
  assert.equal(h.get('usage-count').textContent, '共 4 个供应商 · 按请求数降序');
  assert.equal((h.get('usage-rows').innerHTML.match(/<tr>/g) || []).length, 2, '每页两条');
  h.run('usagePage(1)');
  assert.equal(h.requests.length, fetches, '聚合表翻页不发请求');
  assert.match(h.get('usage-rows').innerHTML, /第三方渠道/);
  assert.match(h.get('usage-rows').innerHTML, /第四渠道/);
  assert.doesNotMatch(h.get('usage-rows').innerHTML, /主力渠道/);
});

test('切换指标只重画热力图、不重新请求,aria-pressed 跟着变', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const before = h.requests.length;
  h.run("setUsageMetric('reqs')");
  assert.equal(h.requests.length, before, '指标切换是纯前端重画');
  // 指标只改色阶和跟指标走的读数:窗口概览的「日均」标签跟着切,标题下的窗口说明不变。
  assert.equal(h.get('usage-side-daily-label').textContent, '日均请求');
  assert.match(h.get('usage-range-label').textContent, /^最近 \d+ 周 · \d{4}-\d{2}-\d{2} 起$/);
  assert.equal(h.segs.metric.find(el => el.dataset.metric === 'reqs').getAttribute('aria-pressed'), 'true');
  assert.equal(h.segs.metric.find(el => el.dataset.metric === 'tokens').getAttribute('aria-pressed'), 'false');
  const today = cellFor(h, dateKey(new Date()));
  assert.equal(today['data-level'], '2', '7 次请求的色阶与 Tokens 模式不同');
  // 分区按钮的 aria-pressed 也在区间变化时同步
  h.setResponse(usageFixture({ scopeDays: 7 }));
  h.run("setUsageRange('7d')");
  await tick();
  assert.equal(h.segs.range.find(el => el.dataset.range === '7d').getAttribute('aria-pressed'), 'true');
});

test('最后一次查询胜出:先返回的旧响应不能覆盖后发起的新结果', async () => {
  const h = harness();
  const first = usageFixture();
  first.totals.reqs = 11;
  const second = usageFixture();
  second.totals.reqs = 99;
  const releaseFirst = h.defer(first);
  const releaseSecond = h.defer(second);
  const p1 = h.run('loadUsage()');
  const p2 = h.run('loadUsage()');
  releaseSecond();
  await p2;
  assert.equal(h.get('usage-reqs').textContent, '99');
  releaseFirst();
  await p1;
  assert.equal(h.get('usage-reqs').textContent, '99', '晚到的旧响应必须被丢弃');
});

test('读取超时:20 秒后报超时而不是静默挂起,旧数据同样标 stale', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const pending = h.defer(usageFixture());
  const request = h.run('loadUsage()');
  h.fireTimeouts();
  await request;
  assert.match(h.get('usage-status').textContent, /读取超时/);
  assert.equal(h.get('usage-data-frame').dataset.stale, 'true');
  assert.equal(h.get('usage-reqs').textContent, '42', '超时也不清空上一份数据');
  pending(); // 迟到的响应不能再落地
  await tick();
  assert.match(h.get('usage-status').textContent, /读取超时/);
});

test('读取失败:报错清楚、旧数据标 stale 且明说不是当前筛选的结果', async () => {
  const h = harness();
  await h.run('loadUsage()');
  assert.equal(h.get('usage-data-frame').dataset.stale, 'false');

  h.failNext(new Error('boom'));
  h.run("setUsageFilter('provider', '主力渠道')");
  await tick();
  assert.match(h.get('usage-status').textContent, /读取失败/);
  assert.match(h.get('usage-status').textContent, /上一次成功读取的数据/);
  assert.match(h.get('usage-status').textContent, /点「立即同步」重试/, '失败要给下一步');
  assert.equal(h.get('usage-data-frame').dataset.stale, 'true', '旧数据要明确标成过期');
  assert.ok(h.get('usage-data-frame').classList.contains('is-stale'));
  assert.equal(h.get('usage-reqs').textContent, '42', '失败不清空上一份数据');

  await h.run('loadUsage()');
  assert.equal(h.get('usage-data-frame').dataset.stale, 'false', '成功后摘掉 stale');
  assert.match(h.get('usage-last-sync').textContent, /最近同步/);
  assert.match(h.get('usage-last-sync').getAttribute('title'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '完整同步时间在 title');
  assert.equal(h.get('usage-status').hidden, true, '恢复正常后状态行收起,不重复卡片和顶栏里已有的数');
});

test('状态行:只剩内存窗口时说清楚不是完整历史;连不上服务给可读原因', async () => {
  const memory = usageFixture();
  memory.scope.source = 'memory';
  const h = harness({ response: memory });
  await h.run('loadUsage()');
  assert.equal(h.get('usage-status').hidden, false);
  assert.equal(h.get('usage-status').textContent, '只读到内存窗口(还没有落盘日志),数字不是完整历史。');

  // fetch 自己抛错(浏览器原文是 Failed to fetch 之类)= 连不上本机服务,不把原文当主文案。
  h.failNext(new TypeError('Failed to fetch'));
  await h.run('loadUsage()');
  assert.match(h.get('usage-status').textContent, /^用量读取失败:连不上本机服务。/);
  assert.doesNotMatch(h.get('usage-status').textContent, /Failed to fetch/);
  assert.equal(h.get('usage-status').dataset.tone, 'err');
});

test('空区间:给出明确空态,热力图仍然如实画出覆盖与零,不伪造历史', async () => {
  const now = new Date(2026, 9, 19, 12);
  const h = harness({ now });
  const empty = usageFixture({ now });
  empty.totals = { reqs: 0, ok_rate: null, cache_hit_rate: null, tokens_total: null, speed_tps: null, ttfb_p50_ms: null };
  empty.by_provider = [];
  empty.by_model = [];
  empty.dashboard.daily = [];
  empty.dashboard.records = { rows: [], total: 0, offset: 0, limit: 50, has_more: false };
  h.setResponse(empty);
  await h.run('loadUsage()');
  assert.equal(h.get('usage-chart-empty').hidden, false);
  assert.match(h.get('usage-chart-empty').textContent, /这个区间里没有请求/);
  const cells = cellsOf(h.get('usage-heatmap').innerHTML);
  assert.equal(cells.length, 14 * 7, '空区间也保留覆盖周的日历骨架');
  assert.ok(cells.every(cell => cell['data-level'] === '0'));
  assert.equal(h.get('usage-rows').innerHTML.includes('没有记录'), true);
  assert.match(h.get('usage-count').textContent, /0 条请求/);

  // 完全没有日志:所有格子都是「未覆盖」,不能宣称历史为零
  const blank = usageFixture({ now });
  blank.totals = { reqs: 0, ok_rate: null, cache_hit_rate: null, tokens_total: null };
  blank.dashboard.daily = [];
  blank.dashboard.records = { rows: [], total: 0, offset: 0, limit: 50, has_more: false };
  blank.dashboard.coverage = { first_ts: null, last_ts: null };
  h.setResponse(blank);
  await h.run('loadUsage()');
  assert.match(h.get('usage-chart-empty').textContent, /数据源暂无可用的请求日志/);
  assert.ok(cellsOf(h.get('usage-heatmap').innerHTML).every(cell => cell['data-coverage'] === 'outside'));
});

test('指针与键盘:同一格给出同样的读数,Esc 收起,读数进 aria-live', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const root = h.get('usage-heatmap');
  const today = dateKey(new Date());
  const tip = h.get('usage-chart-tooltip');
  root.events.pointerover({ target: { dataset: { date: today }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 14, height: 14 }) } });
  assert.equal(tip.hidden, false);
  assert.match(tip.textContent, /7 次请求/);
  assert.ok(tip.textContent.includes(`${h.run('fmtTok(7500)')} tokens`));
  assert.equal(tip.style.left, '8px', '窄屏/未知位置时夹在面板内');
  assert.doesNotMatch(tip._html, /</, '浮层只用 textContent');

  root.events.pointerleave();
  assert.equal(tip.hidden, true);
  assert.equal(h.state.heatDate, null);

  h.run("usageHeatPointer({ target: { dataset: { date: '" + today + "' } } })");
  root.events.keydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(h.state.heatDate, dayKeyAgo(7), '左方向键退一周');
  assert.match(h.state.heatLive.textContent, new RegExp(dayKeyAgo(7).slice(5).replace('-', '月') + '日'));
  root.events.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(h.state.heatDate, dayKeyAgo(6));
  root.events.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(tip.hidden, true);
  root.events.focusout();
  assert.equal(h.state.heatFocus, false);

  // 未来格:读出「未来日期」,不是 0
  h.run("usageHeatKey({ key: 'End', preventDefault() {} })");
  const endKey = h.state.heatDate;
  const endCell = cellFor(h, endKey);
  if (endCell['data-future'] === 'true') assert.match(tip.textContent, /未来日期/);
});

test('有请求但没有 token 遥测的日子:按 Tokens 着色时仍然是活跃格,不会被画成 0', async () => {
  const fixture = usageFixture();
  const key = dayKeyAgo(4);
  fixture.dashboard.daily.push({ t: key, reqs: 2, tokens_in: 0, tokens_out: 0, cache_read: 0 });
  const h = harness({ response: fixture });
  await h.run('loadUsage()');
  const cell = cellFor(h, key);
  assert.equal(cell['data-level'], '1', '有请求就有色阶,哪怕 token 遥测缺失');
  assert.match(h.get('usage-side-active').textContent, /^5 \/ \d+ 天$/, '没有 token 遥测的那天仍算「有请求的天」');
});

test('图例:外壳已有 .heatmap-legend 时复用它,只补说明,不渲染第二份', async () => {
  const legend = new Element('legend');
  legend.className = 'heatmap-legend';
  const swatch = new Element();
  swatch.dataset.level = '0';
  legend.appendChild(swatch);
  const now = new Date(2026, 9, 21, 12);
  // 区间(30 天)比日志覆盖(90 天)短:更早的日子有日志但不在区间,才需要「不在区间」色块。
  const h = harness({ now, response: usageFixture({ now, scopeDays: 30 }), legendEl: legend });
  await h.run('loadUsage()');
  assert.doesNotMatch(h.get('usage-heatmap').innerHTML, /class="heatmap-legend"/, '不能重复渲染图例');
  const extra = legend.children.find(child => child.id === 'usage-heatmap-legend-extra');
  assert.ok(extra, '在既有图例后补上当前窗口出现的状态色块');
  assert.equal(extra.hidden, false);
  // 含义写在色块/标签的 title 里,图例行不再铺说明句;0 的含义由外壳自己的 0 级色块承担。
  assert.match(extra.innerHTML, /data-active="false" title="不在当前统计区间:不参与统计,也不是 0"/);
  assert.match(extra.innerHTML, />不在区间</);
  assert.match(extra.innerHTML, /data-future="true" title="未来日期,尚无数据"/);
  assert.doesNotMatch(extra.innerHTML, /0 = 区间内无请求/, '0 已有自己的色块,不再重复写一遍');
  assert.equal(swatch.getAttribute('title'), '0:区间内确实没有请求');
});

test('图例:周日窗口没有区间外格子时不补不存在的说明', async () => {
  const now = new Date(2026, 10, 1, 12);
  const legend = new Element('legend');
  legend.className = 'heatmap-legend';
  const h = harness({ now, response: usageFixture({ now }), legendEl: legend });
  await h.run('loadUsage()');
  const extra = legend.children.find(child => child.id === 'usage-heatmap-legend-extra');
  assert.ok(extra);
  assert.equal(extra.innerHTML, '', '没有区间外/未来格子就不补色块');
  assert.equal(extra.hidden, true, '空的补充区收起,不留一段空白间距');
});

test('日志内容进入表格前转义:供应商/错误文本不能当 HTML 插进来', async () => {
  const h = harness();
  const evil = usageFixture();
  evil.dashboard.records.rows = [{
    ts: new Date().toISOString(), app: 'claude', provider: '<img src=x onerror="alert(1)">',
    model_in: '<b>raw</b>', model_out: '<b>raw</b>', status: 500, err: '<script>alert(1)</script>',
    in: 1, out: 1, cache_read: 0, ms: 10, ttfb_ms: 10,
  }];
  evil.dashboard.records.total = 1;
  h.setResponse(evil);
  await h.run('loadUsage()');
  const html = h.get('usage-rows').innerHTML;
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img|<script/);
});

test('旧后端没有 dashboard:从 series 按天兜底画热力图,明细表如实说明不可用', async () => {
  const now = new Date(2026, 9, 19, 12);
  const h = harness({ now });
  const legacy = usageFixture({ now });
  delete legacy.dashboard;
  h.setResponse(legacy);
  await h.run('loadUsage()');
  assert.equal(cellsOf(h.get('usage-heatmap').innerHTML).length, 14 * 7, '旧后端按统计区间裁剪');
  const today = cellFor(h, dateKey(now));
  assert.ok(Number(today['data-level']) > 0, 'series 里的今天仍有色阶');
  assert.match(h.get('usage-rows').innerHTML, /未返回请求明细/);
  h.run("setUsageTab('providers')");
  assert.match(h.get('usage-rows').innerHTML, /主力渠道/, '聚合表照常可用');
});

test('同步间隔与后台生命周期:关闭/离开页面不起定时器,隐藏时不打接口', async () => {
  const h = harness();
  await h.run('loadUsage()');
  h.run('usageSetVisible(true)');
  assert.equal(h.intervals.size, 1, '进入页面且间隔 60 秒时有一个定时器');
  h.run('setUsageInterval(0)');
  assert.equal(h.intervals.size, 0, '关闭同步后不再轮询');

  h.run('setUsageInterval(60); usageSetVisible(true)');
  const timer = [...h.intervals.values()][0];
  const before = h.requests.length;
  h.document.visibilityState = 'hidden';
  timer();
  assert.equal(h.requests.length, before, '后台标签页跳过轮询');
  h.document.visibilityState = 'visible';
  timer();
  assert.equal(h.requests.length, before + 1, '前台时轮询照常');

  h.run('usageSetVisible(false)');
  assert.equal(h.intervals.size, 0, '离开页面清掉定时器');
});

test('覆盖边界:最早记录之前是未覆盖,最后一条记录之后到今天按真实 0 算(不是未覆盖)', async () => {
  const fixture = usageFixture();
  // 最新一条记录停在 5 天前:这几天没有记录,但读取已经扫到当前时刻,应画成 0 而不是未覆盖。
  const lastRecord = new Date();
  lastRecord.setDate(lastRecord.getDate() - 5);
  fixture.dashboard.coverage.last_ts = lastRecord.toISOString();
  const h = harness({ response: fixture });
  await h.run('loadUsage()');
  const gap = cellFor(h, dayKeyAgo(2));
  assert.equal(gap['data-coverage'], 'inside', '最后一条记录之后的空白天不是未知');
  assert.equal(gap['data-level'], '0');
  assert.equal(gap['data-active'], 'true');
  const before = cellFor(h, dayKeyAgo(200));
  if (before) assert.equal(before['data-coverage'], 'outside', '最早记录之前才是未覆盖');
});

test('首响应:卡片与表头都用「首响应」而不是「首字」,并写明量的是上游响应头', async () => {
  const h = harness();
  await h.run('loadUsage()');
  assert.match(h.get('usage-ttfb').getAttribute('title'), /上游响应头到达时间/);
  assert.match(h.get('usage-ttfb').getAttribute('title'), /不是模型首个输出 token/);
  assert.match(h.get('usage-table-head').innerHTML, /首响应/);
  assert.doesNotMatch(h.get('usage-table-head').innerHTML, /首字/);
  assert.match(h.get('usage-rows').innerHTML, /title="上游响应头到达时间;不是模型首个输出 token 的时间"/);
});

test('来源说明:只说「当前可用日志」,不冒充完整保留期;首响应口径写明不是模型首字', async () => {
  const h = harness();
  await h.run('loadUsage()');
  const detail = h.get('usage-source-detail').innerHTML;
  assert.match(detail, /磁盘日志 \+ 内存窗口/);
  assert.match(detail, /当前可用日志/);
  assert.doesNotMatch(detail, /完整历史|全部历史/, '不能宣称是完整历史');
  assert.match(detail, /不是完整保留期/);
  assert.match(detail, /不保证中间没有断档/, '观察边界不能当成连续覆盖承诺');
  assert.match(detail, /按「没有请求」计算/, '最后一条记录之后到今天按 0 算,不是未覆盖');
  assert.match(detail, /精确匹配/);
  assert.match(detail, /缓存命中率/);
  assert.match(detail, /首响应 = 上游响应头到达的时间/);
  assert.match(detail, /不是模型首个输出 token/);
  // 面板默认收起(首屏留给指标卡与热力图),展开状态记进浏览器偏好。
  assert.equal(h.get('usage-source').hidden, true, '首次进入默认收起统计口径');
  h.run('toggleUsageSource()');
  assert.equal(h.get('usage-source').hidden, false);
  assert.equal(h.get('usage-source-toggle').attributes['aria-expanded'], 'true');
  h.run('toggleUsageSource()');
  assert.equal(h.get('usage-source').hidden, true);
});

test('默认区间全部、热力图按覆盖周显示;日期键原样回显,不做 UTC 平移', async () => {
  const h = harness();
  await h.run('loadUsage()');
  assert.equal(h.state.range, 'all');
  const today = dateKey(new Date());
  const cell = cellFor(h, today);
  assert.equal(cell['data-date'], today, '日期键按本地日期原样出现');
  h.run("setUsageMetric('reqs')");
  h.run(`usageHeatPointer({ target: { dataset: { date: '${today}' } } })`);
  const label = h.get('usage-chart-tooltip').textContent;
  const parts = today.split('-').map(Number);
  assert.match(label, new RegExp(`${parts[1]}月${parts[2]}日`), '浮层日期与数据日期一致');
});

// #18:日历撑满卡片宽度。列数 = 容器放得下几列 16px 的格子;日志只有几天时,覆盖起点一周之前的
// 未覆盖格不再画满斜纹(data-gap,只留平涂底),空白处写「某日前无日志」,摘要行不再重复。
test('热力图铺满宽度:列数按容器宽度算,长段未覆盖压成空白并写明「某日前无日志」', async () => {
  const now = new Date(2026, 10, 6, 12); // 周五
  const fixture = usageFixture({ now, coverageDays: 1, scopeDays: 1 });
  // 1100px 卡片:可用 1100 - 6 - 26 = 1068px,每列 16 + 3 → ceil(1071 / 19) = 57 列。
  const h = harness({ now, response: fixture, holderWidth: 1100 });
  await h.run('loadUsage()');
  const cells = cellsOf(h.get('usage-heatmap').innerHTML);
  assert.equal(cells.length, 57 * 7, '宽卡片画满 57 周,而不是 13 周挤在左边');
  assert.equal(h.get('usage-heatmap').attributes['data-density'], 'compact', '格子接近 16px 时写全七个星期');
  const firstLog = dateKey(addDays(now, -1));
  // 覆盖起点所在周(第 56 列)与它前一列画斜纹;再往前的未覆盖格只占位。
  const gap = cells.filter(cell => cell['data-gap'] === 'true');
  assert.equal(gap.length, 55 * 7, '覆盖起点前一周之前整列留空');
  assert.ok(gap.every(cell => cell['data-coverage'] === 'outside' && cell['data-level'] === '0'), '留空的格子仍是「未覆盖」,不是 0');
  assert.match(gap[0]['aria-label'], /未覆盖/, '读屏仍读作未覆盖');
  assert.ok(gap.every(cell => !cell['data-inactive']), '留空格不再叠「区间外」淡化');
  const hatched = cells.filter(cell => cell['data-coverage'] === 'outside' && !cell['data-gap']);
  assert.ok(hatched.length >= 1 && hatched.length <= 13, '斜纹只剩覆盖边界那一两列');
  const html = h.get('usage-heatmap').innerHTML;
  assert.match(html, new RegExp(`<span class="heatmap-gap-note" style="width:${(55 / 57 * 100).toFixed(3)}%" title="数据源没有这些日期的日志,不是 0"><span>${firstLog} 前无日志</span></span>`));
  assert.equal(h.get('usage-calendar-summary').hidden, true, '空白处已写明,摘要行不重复同一句');
  assert.equal(h.get('usage-range-label').textContent, `最近 57 周 · ${cells[0]['data-date']} 起`);

  // 手机宽度:334px 卡片 → ceil((334 - 32 + 3) / 19) = 17 列;窗口缩放时重画。
  h.get('usage-chart-holder').clientWidth = 334;
  h.resize();
  assert.equal(cellsOf(h.get('usage-heatmap').innerHTML).length, 17 * 7, '窄卡片按宽度重算列数');
  const again = h.get('usage-heatmap').innerHTML;
  h.resize();
  assert.equal(h.get('usage-heatmap').innerHTML, again, '宽度没变不重画');
  // 视图隐藏(宽度量到 0):沿用上一次的列数,不缩回 13 周。
  h.get('usage-chart-holder').clientWidth = 0;
  h.resize();
  await h.run('loadUsage()');
  assert.equal(cellsOf(h.get('usage-heatmap').innerHTML).length, 17 * 7);
});

test('热力图铺满宽度:覆盖本来就比卡片长时按覆盖画;空白不够宽时说明留在摘要行', async () => {
  const now = new Date(2026, 9, 19, 12);
  // 90 天覆盖 = 14 周;334px 卡片只放得下 17 周 → 17 周,前 2 列留空(太窄,不写字)。
  const h = harness({ now, response: usageFixture({ now }), holderWidth: 334 });
  await h.run('loadUsage()');
  const cells = cellsOf(h.get('usage-heatmap').innerHTML);
  assert.equal(cells.length, 17 * 7);
  assert.equal(cells.filter(cell => cell['data-gap'] === 'true').length, 2 * 7);
  assert.doesNotMatch(h.get('usage-heatmap').innerHTML, /heatmap-gap-note/, '两列放不下说明文字');
  assert.equal(h.get('usage-calendar-summary').hidden, false, '说明仍在摘要行');
  // 400 天历史比卡片宽:仍按 53 周画,在自己的滚动区里横向滚。
  const long = harness({ now, response: usageFixture({ now, coverageDays: 400, scopeDays: 400 }), holderWidth: 334 });
  await long.run('loadUsage()');
  assert.equal(cellsOf(long.get('usage-heatmap').innerHTML).length, 53 * 7);
  assert.equal(long.get('usage-heatmap').attributes['data-density'], 'dense', '格子被压到最小时星期只标一半');
});

// #21:显示名不唯一。后端按渠道分组(dashboard.by_channel),每行带渠道 id 与渠道所在的协议组;
// 前端只按这些字段补小标,不再拿名字去渠道库反查。
test('供应商页签:按后端渠道分组,「(未知)」写成人话,撞名按协议组、再按渠道 id 区分', async () => {
  const fixture = usageFixture();
  const row = (provider_id, app, name, reqs) => ({
    channel: provider_id ? `id:${provider_id}` : `name:${app}:${name}`, provider_id, app, name, reqs,
    tokens_in: 1, tokens_out: 1, cache_read: 0,
  });
  fixture.dashboard.by_channel = [
    row('p-ar', 'claude', 'AgentRouter', 785),
    row('c-ar', 'codex', 'AgentRouter', 700),
    row('p-hc', 'claude', 'Happy coding', 770),
    row('c-hc', 'codex', 'happy coding', 75),
    row('p-s1', 'claude', '同名', 9),
    row('p-s2', 'claude', '同名', 8),
    row('', 'claude', '同名', 7),
    { channel: 'none', provider_id: '', app: '', name: '(未知)', reqs: 16, tokens_in: 0, tokens_out: 0, cache_read: 0 },
    row('p-main', 'claude', '主力渠道', 5),
  ];
  fixture.dashboard.facets.channels = fixture.dashboard.by_channel.map(c => ({
    value: c.channel, label: c.name, app: c.app, provider_id: c.provider_id,
  }));
  const h = harness({ response: fixture });
  await h.run('loadUsage()');
  h.run("setUsageTab('providers')");
  const rows = h.get('usage-rows').innerHTML;
  assert.match(rows, /<td><span class="usage-prov-unknown" title="请求失败于选渠道之前,或日志缺 provider 字段">未记录渠道<\/span><\/td>/);
  assert.doesNotMatch(rows, /\(未知\)/, '不显示后端的占位名');
  // 两个协议组里都叫 AgentRouter:两行,各自写协议组;不分大小写撞名的 Happy coding 同理。
  assert.match(rows, /AgentRouter<span class="usage-prov-app" title="Anthropic 协议组的渠道 · id p-ar">Anthropic<\/span>/);
  assert.match(rows, /AgentRouter<span class="usage-prov-app" title="OpenAI 协议组的渠道 · id c-ar">OpenAI<\/span>/);
  assert.match(rows, /Happy coding<span class="usage-prov-app" title="Anthropic 协议组的渠道 · id p-hc">Anthropic<\/span>/);
  assert.match(rows, /happy coding<span class="usage-prov-app" title="OpenAI 协议组的渠道 · id c-hc">OpenAI<\/span>/);
  assert.doesNotMatch(rows, /两者合计|Anthropic \+ OpenAI/, '同名渠道不再合成一行');
  // 同一协议组里还撞名:再补渠道 id;旧日志没有 id,写「旧日志」。
  assert.match(rows, /同名<span class="usage-prov-app" title="Anthropic 协议组的渠道 · id p-s1">Anthropic · p-s1<\/span>/);
  assert.match(rows, /同名<span class="usage-prov-app" title="Anthropic 协议组的渠道 · id p-s2">Anthropic · p-s2<\/span>/);
  assert.match(rows, /同名<span class="usage-prov-app" title="Anthropic 协议组 · 旧日志没有渠道 id,只记了显示名">Anthropic · 旧日志<\/span>/);
  assert.match(rows, /<td>主力渠道<\/td>/, '不撞名的行不加小标');
  assert.match(h.get('usage-count').textContent, /共 9 个供应商/);
  // 筛选下拉:值是渠道键,文字与表格同一套区分规则。
  const options = h.get('usage-provider').innerHTML;
  assert.match(options, /<option value="none">未记录渠道<\/option>/);
  assert.match(options, /<option value="id:p-ar">AgentRouter · Anthropic<\/option>/);
  assert.match(options, /<option value="id:c-ar">AgentRouter · OpenAI<\/option>/);
  assert.match(options, /<option value="name:claude:同名">同名 · Anthropic · 旧日志<\/option>/);
  assert.match(options, /<option value="id:p-main">主力渠道<\/option>/);
});

test('分页标签:页数用千分位', async () => {
  const h = harness({ response: usageFixture({ total: 73800 }) });
  await h.run('loadUsage()');
  assert.equal(h.get('usage-page-label').textContent, '第 1 / 1,476 页');
});
