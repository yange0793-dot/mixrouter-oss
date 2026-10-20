'use strict';
// 用量统计页。与 app.js 共用同一个 realm(classic script,不是 ESM):只声明本页自己的
// 变量与函数,不重复声明 `$` / `esc` / `toast` / `fmtTok`(重复声明会当场报错,这是安全网)。
//
// 数据来自 GET /api/usage:磁盘 logs/requests.jsonl + 内存环,按本地时区分桶、空桶已补齐。
// 这里只呈现真实消耗(请求数 / tokens / 缓存命中):金额要按渠道单价折算,单价随时间与
// 渠道变动,本机算出来的数只会和渠道账单对不上,不如不显示。
//
// 三条容易做错的边界,这里都写死:
//   1) series[].t 是本地时间字符串('YYYY-MM-DDTHH:00' 或 'YYYY-MM-DD'),**不**用
//      new Date(t) 再按 UTC 展示 —— 那会在非 UTC 时区整体平移几个小时;
//   2) 轮询与筛选共用同一个 AbortController:改筛选就取消在途请求,旧结果不许覆盖新筛选;
//   3) 空序列(区间内没有请求)不画线,画一行"暂无数据",而不是给一个 0 高度的图。

const USAGE_PREF_KEY = 'mixr.usage.prefs';
const USAGE_RANGE_LABELS = { today: '今天', '24h': '近 24 小时', '7d': '近 7 天', '30d': '近 30 天', all: '全部' };
const USAGE_METRIC_LABELS = { tokens: 'Tokens', reqs: '请求' };

// 页面状态只在这里一处。`data` 是上次成功读取的响应,失败时保留旧图并只更新状态行 ——
// 一次轮询失败不该把整页清空。
const usageState = {
  range: '7d', app: '', provider: '', model: '', metric: 'tokens', interval: 60,
  data: null,
  inited: false, visible: false, timer: null, controller: null, seq: 0, lastSync: 0,
  // 图表侧状态:chartIndex 是"当前读到的桶"(悬停/触摸/键盘共用一个),chartFocus 表示
  // 键盘正在图内,chartKeyMode 表示最近一次读数来自方向键(鼠标移出时据此决定要不要收起)。
  chartPoints: [], chartBox: null, chartIndex: null, chartFocus: false, chartKeyMode: false,
  chartSig: '', chartBuckets: '',
};

// ---- 数值格式 -------------------------------------------------------------
// null / undefined / '' 一律当"没有这个数"——Number(null) 是 0,直接塞进 Number.isFinite
// 会让「没有数据」显示成 0,看起来像真的发生过请求。
const usageNum = value => (value === null || value === undefined || value === ''
  ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
const usageTok = value => {
  const n = usageNum(value);
  if (n === null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
};
const usagePct = value => {
  const n = usageNum(value);
  return n === null ? '—' : (n * 100).toFixed(1) + '%';
};
const usageMs = value => {
  const n = usageNum(value);
  if (!n || n <= 0) return '—';
  return n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms';
};
const usageInt = value => {
  const n = usageNum(value);
  return n === null ? '—' : Math.round(n).toLocaleString('en-US');
};
// 本地时间 HH:mm:ss。日志里的 ts 是 UTC,这里只用于状态行,按本地时间显示更直观。
const usageClock = ms => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });

// ---- 偏好(区间/指标/同步间隔/筛选) ---------------------------------------
function usageLoadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(USAGE_PREF_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return;
    if (USAGE_RANGE_LABELS[raw.range]) usageState.range = raw.range;
    if (Object.hasOwn(USAGE_METRIC_LABELS, raw.metric)) usageState.metric = raw.metric;
    if ([0, 30, 60, 300].includes(Number(raw.interval))) usageState.interval = Number(raw.interval);
    // 筛选值只恢复 app(固定枚举),provider/model 是动态清单,恢复前可能已不存在。
    if (['', 'claude', 'codex'].includes(raw.app)) usageState.app = raw.app;
  } catch { /* 隐私模式/配额满:偏好读不到就用默认值,页面照常工作 */ }
}
function usageSavePrefs() {
  try {
    localStorage.setItem(USAGE_PREF_KEY, JSON.stringify({
      range: usageState.range, metric: usageState.metric,
      interval: usageState.interval, app: usageState.app,
    }));
  } catch { /* 同上:存不下不影响本页 */ }
}

// ---- 查询与读取 -----------------------------------------------------------
function usageQuery() {
  const q = new URLSearchParams();
  q.set('range', usageState.range);
  if (usageState.app) q.set('app', usageState.app);
  if (usageState.provider) q.set('provider', usageState.provider);
  if (usageState.model) q.set('model', usageState.model);
  return q.toString();
}

function usageSetStatus(text, cls = '') {
  const el = $('usage-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = cls === 'err' ? 'var(--err-text)' : '';
}

// 读一次。seq 保证只有"最后一次发起"的响应能落地;AbortController 让被取代的请求
// 在网络上真正取消(否则轮询间隔短于响应时间时,旧请求会排队并逐个覆盖新结果)。
async function loadUsage() {
  if (!usageState.inited) usageInitControls();
  const seq = ++usageState.seq;
  if (usageState.controller) usageState.controller.abort();
  const controller = new AbortController();
  usageState.controller = controller;
  const timer = setTimeout(() => controller.abort(), 20000);
  usageSyncButton(true);
  try {
    const response = await fetch('/api/usage?' + usageQuery(), {
      signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' },
    });
    let body = null;
    try { body = await response.json(); } catch { /* 非 JSON 由下面统一报错 */ }
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    if (seq !== usageState.seq) return; // 已被更新的请求取代
    usageState.data = body;
    usageState.lastSync = Date.now();
    usageRender(body);
    const source = body.scope?.source === 'memory' ? '仅内存窗口(还没落盘日志)' : '磁盘日志 + 内存窗口';
    usageSetStatus(`区间内 ${usageInt(body.totals?.reqs)} 次请求 · ${source} · 最近同步 ${usageClock(usageState.lastSync)}`);
  } catch (e) {
    if (e.name === 'AbortError' || seq !== usageState.seq) return;
    usageSetStatus('用量读取失败:' + e.message, 'err');
  } finally {
    clearTimeout(timer);
    if (seq === usageState.seq) { usageSyncButton(false); usageState.controller = null; }
  }
}

function usageSyncButton(busy) {
  const button = $('usage-sync');
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? '同步中…' : '立即同步';
}

// ---- 控件初始化(只做一次) ------------------------------------------------
function usageInitControls() {
  usageState.inited = true;
  usageLoadPrefs();
  const setSeg = (root, attr, value) => {
    document.querySelectorAll(`${root} [${attr}]`).forEach(button => {
      const on = button.getAttribute(attr) === value;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    });
  };
  setSeg('.usage-range', 'data-range', usageState.range);
  setSeg('.usage-tabs', 'data-metric', usageState.metric);
  const app = $('usage-app');
  if (app) app.value = usageState.app;
  const interval = $('usage-interval');
  if (interval) interval.value = String(usageState.interval);
  usageSchedule();
}

// 定时器按当前间隔重建。关掉(0)就只保留手动同步。
function usageSchedule() {
  if (usageState.timer) { clearInterval(usageState.timer); usageState.timer = null; }
  if (!usageState.visible || !usageState.interval) return;
  usageState.timer = setInterval(() => {
    // 标签页在后台时不打接口:轮询是为了让人看见最新数字,看不见就不该占资源和日志。
    if (document.visibilityState === 'hidden') return;
    loadUsage();
  }, usageState.interval * 1000);
}

// app.js 的 showView 调这个:进入/离开用量页。
function usageSetVisible(on) {
  usageState.visible = !!on;
  if (!on) { usageSchedule(); return; }
  usageSchedule();
}
// 首次进入用量页:初始化控件并立刻读一次(app.js 在 showView 里调用)。
function renderUsage() {
  if (!usageState.inited) usageInitControls();
  else {
    const setSeg = (root, attr, value) => {
      document.querySelectorAll(`${root} [${attr}]`).forEach(button => {
        const on = button.getAttribute(attr) === value;
        button.classList.toggle('active', on);
        button.setAttribute('aria-pressed', String(on));
      });
    };
    setSeg('.usage-range', 'data-range', usageState.range);
    setSeg('.usage-tabs', 'data-metric', usageState.metric);
  }
  loadUsage();
}

function setUsageRange(range) {
  if (!USAGE_RANGE_LABELS[range] || usageState.range === range) return;
  usageState.range = range;
  usageSavePrefs();
  renderUsage();
}
function setUsageFilter(key, value) {
  if (!['app', 'provider', 'model'].includes(key)) return;
  if (usageState[key] === value) return;
  usageState[key] = value;
  if (key === 'app') usageSavePrefs();
  loadUsage();
}
function setUsageMetric(metric) {
  if (!Object.hasOwn(USAGE_METRIC_LABELS, metric)) return;
  usageState.metric = metric;
  usageSavePrefs();
  if (usageState.data) usageRenderChart(usageState.data);
}
function setUsageInterval(value) {
  const seconds = Number(value);
  if (![0, 30, 60, 300].includes(seconds)) return;
  usageState.interval = seconds;
  usageSavePrefs();
  usageSchedule();
}

// ---- 渲染 -----------------------------------------------------------------
function usageRender(data) {
  const totals = data.totals || {};
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  set('usage-reqs', usageInt(totals.reqs));
  set('usage-ok-rate', totals.ok_rate === null || totals.ok_rate === undefined
    ? '暂无成功率样本' : `成功率 ${Number(totals.ok_rate).toFixed(1)}%`);
  set('usage-tokens', usageTok(totals.tokens_total));
  set('usage-token-split', `新增 ${usageTok(totals.tokens_in)} / 输出 ${usageTok(totals.tokens_out)} / 缓存 ${usageTok(totals.cache_read)}`);
  set('usage-cache', usagePct(totals.cache_hit_rate));
  set('usage-cache-hint', `速度 ${totals.speed_tps ? Math.round(totals.speed_tps) + ' tok/s' : '—'} · 首字 ${usageMs(totals.ttfb_p50_ms)}`);
  usageRenderFilters(data);
  usageRenderChart(data);
  usageRenderTable(data);
}

// 供应商/模型下拉的可选项来自本次响应的分组结果:日志里出现过的才列出来。
// 重填时要保留当前选中值 —— 否则每次轮询都会把用户的筛选重置回「全部」。
function usageRenderFilters(data) {
  const fill = (id, items, current, labelOf, valueOf) => {
    const el = $(id);
    if (!el) return;
    const values = new Set(items.map(valueOf));
    const options = ['<option value="">' + (id === 'usage-provider' ? '全部供应商' : '全部模型') + '</option>']
      .concat(items.map(item => `<option value="${esc(valueOf(item))}">${esc(labelOf(item))}</option>`));
    // 只在选项真的变了才重建。默认 60 秒轮询下每次都 innerHTML 一遍,会让正打开着的下拉
    // 收起来、列表滚到顶 —— 看着像面板自己在动。清单没变就只同步选中值。
    const html = options.join('');
    if (el._mixrOptions !== html) { el.innerHTML = html; el._mixrOptions = html; }
    // 当前值不在清单里(例如换了区间后该模型没有请求了)就退回「全部」,并把状态同步回去,
    // 不然会出现"下拉显示全部、请求还带着旧筛选"的错位。
    if (current && values.has(current)) el.value = current;
    else { el.value = ''; if (id === 'usage-provider') usageState.provider = ''; else usageState.model = ''; }
  };
  fill('usage-provider', data.by_provider || [], usageState.provider, p => p.name || p.provider, p => p.name || p.provider);
  fill('usage-model', data.by_model || [], usageState.model, m => m.model, m => m.model);
}

function usageRenderTable(data) {
  const body = $('usage-rows');
  const count = $('usage-count');
  const rows = data.by_model || [];
  if (count) {
    count.textContent = rows.length
      ? `区间内 ${rows.length} 个模型;按请求数降序。`
      : '当前区间内没有请求。';
  }
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" style="color:var(--dim)">这个区间里没有请求。调整区间或筛选条件再试。</td></tr>';
    return;
  }
  body.innerHTML = rows.map(row => {
    const denom = (Number(row.tokens_in) || 0) + (Number(row.cache_read) || 0);
    const hit = denom ? (Number(row.cache_read) || 0) / denom : null;
    return `<tr><td>${esc(row.model || '—')}</td><td>${usageInt(row.reqs)}</td>
      <td>${usageTok(row.tokens_in)}</td><td>${usageTok(row.tokens_out)}</td><td>${usageTok(row.cache_read)}</td>
      <td>${hit === null ? '—' : (hit * 100).toFixed(1) + '%'}</td></tr>`;
  }).join('');
}

// ---- 面积图(手写 SVG,零依赖) -------------------------------------------
function usageMetricOf(bucket, metric) {
  if (metric === 'reqs') return Number(bucket.reqs) || 0;
  return (Number(bucket.tokens_in) || 0) + (Number(bucket.tokens_out) || 0) + (Number(bucket.cache_read) || 0);
}
// 刻度文字要短:usageTok 给的是 2 位小数(750.00M),四个字符的宽度会把左边距撑爆、
// 被 SVG 边界裁掉。刻度只需要量级可读,统一压到 0–1 位小数。小于 10 的整数部分保留
// 一位小数,否则 1.5M 会被四舍五入成 2M,和上一格重复。
function usageAxisLabel(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const scaled = unit => {
    const size = Math.abs(unit);
    return size >= 10 ? Math.round(unit) : Math.round(unit * 10) / 10;
  };
  if (abs >= 1e9) return scaled(n / 1e9) + 'B';
  if (abs >= 1e6) return scaled(n / 1e6) + 'M';
  if (abs >= 1e3) return scaled(n / 1e3) + 'k';
  return String(Math.round(n));
}
// Y 轴上界取"好看的数":1/2/5 × 10^n 里第一个 ≥ max 的值,避免刻度出现 3.87M 这种。
function usageNiceMax(max) {
  if (!(max > 0)) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  for (const step of [1, 2, 2.5, 5, 10]) if (step * base >= max) return step * base;
  return 10 * base;
}

// 桶的时间字符串原样展示:series[].t 已经是本地时间,再经 new Date 会按浏览器时区平移。
function usageBucketLabel(t) {
  const text = String(t == null ? '' : t);
  return text.includes('T') ? text.replace('T', ' ') : text;
}
// 悬停/键盘/触摸三处读数共用这一句,保证同一个桶在任何输入方式下说同样的话。
function usageMetricText(value) {
  return usageState.metric === 'reqs' ? `${usageInt(value)} 次请求` : `${usageTok(value)} tokens`;
}
// 图表宿主:index.html 里 .usage-chart 包着 #usage-chart-holder;没有父节点时退回 holder 本身。
function usageChartHost() {
  const holder = $('usage-chart-holder');
  return holder ? (holder.parentNode || holder) : null;
}

// ---- 按时间桶的明细表(图表的无障碍等价物) -------------------------------
// 浮层只负责"顺手看",每个值都必须能在不悬停的情况下读到 —— 所以这张表默认存在、
// 随每次渲染更新。details 只建一次,轮询时只换行,展开状态不会被重置。
let usageTrend = null;
function usageRenderTrendTable(series) {
  if (!series.length) {
    if (usageTrend) {
      usageTrend.body.innerHTML = '';
      usageTrend.summary.textContent = '';
      usageTrend.details.hidden = true;
    }
    return;
  }
  if (!usageTrend) {
    const host = usageChartHost();
    if (!host) return;
    const details = document.createElement('details');
    details.className = 'usage-trend-table';
    const summary = document.createElement('summary');
    // 只借 .table-wrap 的横向滚动,不带 .usage-table —— 那套 min-width:720px 会让
    // 只有六个短列的按桶表在窄屏上横滚得很远。
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    const table = document.createElement('table');
    const caption = document.createElement('caption');
    caption.className = 'sr-only';
    caption.textContent = '按时间桶的用量明细';
    const head = document.createElement('thead');
    head.innerHTML = '<tr><th scope="col">时间</th><th scope="col">请求</th><th scope="col">新增输入</th>'
      + '<th scope="col">输出</th><th scope="col">缓存命中</th><th scope="col">合计 tokens</th></tr>';
    const body = document.createElement('tbody');
    table.appendChild(caption);
    table.appendChild(head);
    table.appendChild(body);
    wrap.appendChild(table);
    details.appendChild(summary);
    details.appendChild(wrap);
    host.appendChild(details);
    usageTrend = { details, summary, body };
  }
  usageTrend.details.hidden = false;
  usageTrend.summary.textContent = `按时间桶查看数据(共 ${series.length} 个桶)`;
  // 时间来自接口响应,是外部字符串;一律走 esc,别把日志里的内容当 HTML 插进来。
  usageTrend.body.innerHTML = series.map(bucket => {
    const tin = Number(bucket.tokens_in) || 0;
    const tout = Number(bucket.tokens_out) || 0;
    const cache = Number(bucket.cache_read) || 0;
    return `<tr><td>${esc(usageBucketLabel(bucket.t))}</td><td>${usageInt(bucket.reqs)}</td>`
      + `<td>${usageTok(bucket.tokens_in)}</td><td>${usageTok(bucket.tokens_out)}</td>`
      + `<td>${usageTok(bucket.cache_read)}</td><td>${usageTok(tin + tout + cache)}</td></tr>`;
  }).join('');
}

// 键盘读数的播报区:与悬停浮层同样的时间 + 数值,走 aria-live,不靠颜色或浮层。
let usageLive = null;
function usageEnsureLive() {
  if (usageLive) return usageLive;
  const host = usageChartHost();
  if (!host) return null;
  const live = document.createElement('p');
  live.className = 'sr-only';
  live.id = 'usage-chart-live';
  live.setAttribute('aria-live', 'polite');
  host.appendChild(live);
  usageLive = live;
  return live;
}

// ---- 光标与浮层 -----------------------------------------------------------
function usageSvgPart(svg, className) {
  return svg && svg.querySelector ? svg.querySelector('.' + className) : null;
}
function usageCursorShow(point) {
  const svg = $('usage-svg');
  const box = usageState.chartBox;
  if (!svg || !box) return;
  const line = usageSvgPart(svg, 'chart-crosshair');
  if (line) {
    line.setAttribute('x1', point.x.toFixed(1));
    line.setAttribute('x2', point.x.toFixed(1));
    line.setAttribute('y1', String(box.padTop));
    line.setAttribute('y2', String(box.padTop + box.plotH));
    line.removeAttribute('hidden');
    line.setAttribute('data-active', 'true');
    if (line.style) line.style.display = '';
  }
  const dot = usageSvgPart(svg, 'chart-active-dot');
  if (dot) {
    dot.setAttribute('cx', point.x.toFixed(1));
    dot.setAttribute('cy', point.y.toFixed(1));
    dot.removeAttribute('hidden');
    dot.setAttribute('data-active', 'true');
    if (dot.style) dot.style.display = '';
  }
}
function usageCursorHide() {
  const svg = $('usage-svg');
  if (!svg) return;
  for (const name of ['chart-crosshair', 'chart-active-dot']) {
    const part = usageSvgPart(svg, name);
    if (!part) continue;
    // hidden 属性负责语义与测试,内联 display 兜底:即便主题样式没写 [hidden] 也不会留一条线。
    part.setAttribute('hidden', '');
    part.setAttribute('data-active', 'false');
    if (part.style) part.style.display = 'none';
  }
}
function usageTipElement() {
  const holder = $('usage-chart-holder');
  if (!holder) return null;
  let tip = holder.querySelector ? holder.querySelector('.chart-tip') : null;
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    if (holder.appendChild) holder.appendChild(tip);
  }
  return tip;
}
function usageHideTip() {
  usageCursorHide();
  const holder = $('usage-chart-holder');
  const tip = holder && holder.querySelector ? holder.querySelector('.chart-tip') : null;
  if (tip) tip.hidden = true;
}

// 显示第 index 个桶:光标、浮层、播报三处同步。悬停、点击、方向键最后都走这里。
function usageShowPoint(index, options = {}) {
  const points = usageState.chartPoints;
  const holder = $('usage-chart-holder');
  const svg = $('usage-svg');
  if (!holder || !svg || !Array.isArray(points) || !points.length) return null;
  const i = Math.max(0, Math.min(points.length - 1, Math.round(Number(index) || 0)));
  const point = points[i];
  usageState.chartIndex = i;
  usageCursorShow(point);
  const tip = usageTipElement();
  if (tip) {
    tip.hidden = false;
    tip.textContent = `${usageBucketLabel(point.t)} · ${usageMetricText(point.value)}`;
    // 浮层相对 holder 定位;窄屏夹在可视宽度内(不靠 CSS 在手机上藏掉它)。
    const svgBox = svg.getBoundingClientRect();
    const holderBox = holder.getBoundingClientRect();
    const viewWidth = (usageState.chartBox && usageState.chartBox.width) || svgBox.width || 1;
    const left = svgBox.width ? (point.x / viewWidth) * svgBox.width + (svgBox.left - holderBox.left) : 0;
    const tipWidth = Math.min(tip.offsetWidth || 160, Math.max(0, holderBox.width - 16));
    const maxLeft = Math.max(8, holderBox.width - tipWidth - 8);
    tip.style.left = Math.min(Math.max(8, left + 12), maxLeft) + 'px';
    tip.style.top = '8px';
  }
  if (options.announce) {
    const live = usageEnsureLive();
    if (live) live.textContent = `${usageBucketLabel(point.t)}:${usageMetricText(point.value)}`;
  }
  return point;
}

// 悬停:找 x 最近的桶并吸附,不要求真的指到 2px 的线上。
function usageChartMove(event) {
  const points = usageState.chartPoints;
  const svg = $('usage-svg');
  if (!svg || !Array.isArray(points) || !points.length) return;
  const clientX = Number(event && event.clientX);
  if (!Number.isFinite(clientX)) return;
  usageState.chartKeyMode = false;
  const svgBox = svg.getBoundingClientRect();
  const viewWidth = (usageState.chartBox && usageState.chartBox.width) || svgBox.width || 1;
  const scale = svgBox.width ? viewWidth / svgBox.width : 1;
  const x = (clientX - svgBox.left) * scale;
  let best = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (Math.abs(points[i].x - x) < Math.abs(points[best].x - x)) best = i;
  }
  usageShowPoint(best);
}
function usageChartLeave() {
  // 方向键正在读时,鼠标移出去不该把读数关掉;鼠标/触摸自己打开的浮层则跟着指针收起。
  if (usageState.chartFocus && usageState.chartKeyMode) return;
  usageState.chartIndex = null;
  usageHideTip();
}
// 方向键逐桶移动,Home/End 到首尾,Esc 收起。起始落在最新的桶上。
function usageChartKey(event) {
  const points = usageState.chartPoints;
  if (!Array.isArray(points) || !points.length || !event) return;
  const key = event.key;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(key)) return;
  if (event.preventDefault) event.preventDefault();
  usageState.chartKeyMode = true;
  if (key === 'Escape') {
    usageState.chartIndex = null;
    usageHideTip();
    return;
  }
  let index = usageState.chartIndex;
  if (key === 'Home') index = 0;
  else if (key === 'End') index = points.length - 1;
  else if (index === null || index === undefined) index = points.length - 1;
  else index += key === 'ArrowRight' ? 1 : -1;
  usageShowPoint(index, { announce: true });
}
function usageChartFocusIn() {
  usageState.chartFocus = true;
  if (usageState.chartIndex !== null && usageState.chartIndex !== undefined) {
    usageShowPoint(usageState.chartIndex, { announce: usageState.chartKeyMode });
  }
}
function usageChartFocusOut() {
  usageState.chartFocus = false;
  usageState.chartKeyMode = false;
  usageState.chartIndex = null;
  usageHideTip();
}

// 区间里到底有没有发生过请求。接口会给空区间补齐零桶,那些桶 reqs=0 且 tokens 全 0 ——
// 把这一串 0 画成一条贴底的线,看起来像"有请求但消耗为零",和事实相反。
// totals.reqs 是接口给的权威计数;只有它明确为 0 且每个桶也确实没有请求时才判空。
// totals 缺失或为 null(未知)时退回看桶:有任何桶 reqs > 0 就算有请求。
function usageSeriesHasRequests(data, series) {
  const rows = Array.isArray(series) ? series : [];
  const total = usageNum(data && data.totals ? data.totals.reqs : null);
  // 桶里有请求数,或者有任何一个 token 计数大于 0,都算真的发生过请求:
  // 某些老日志行没有 reqs 字段,但 tokens 摆在那里,不能反过来被当成空区间藏掉。
  const bucketHasRequest = rows.some(bucket => {
    if (!bucket) return false;
    const reqs = usageNum(bucket.reqs);
    if (reqs !== null && reqs > 0) return true;
    return ['tokens_in', 'tokens_out', 'cache_read'].some(key => {
      const value = usageNum(bucket[key]);
      return value !== null && value > 0;
    });
  });
  if (total !== null) return total > 0 || bucketHasRequest;
  return bucketHasRequest;
}

function usageRenderChart(data) {
  const svg = $('usage-svg');
  const holder = $('usage-chart-holder');
  if (!svg || !holder) return;
  const rangeLabel = USAGE_RANGE_LABELS[usageState.range] || usageState.range;
  const metricLabel = USAGE_METRIC_LABELS[usageState.metric] || usageState.metric;
  // 单序列没有图例:标题自己说明画的是哪个指标。
  const label = $('usage-range-label');
  if (label) label.textContent = `${metricLabel} 使用趋势 · ${rangeLabel}`;

  const series = Array.isArray(data.series) ? data.series : [];
  const drawable = series.length > 0 && usageSeriesHasRequests(data, series);
  const values = series.map(bucket => usageMetricOf(bucket, usageState.metric));
  const maxValue = usageNiceMax(Math.max(...values, 0));
  const width = Math.max(320, Math.round(holder.clientWidth || svg.clientWidth || 900));
  const height = Math.round(svg.getBoundingClientRect().height) || 260;

  // 同一份数据(轮询拿回完全相同的桶与数值、尺寸和指标都没变)不重画:
  // 既省掉每分钟一次的内联 SVG 重建,也不会把正在看的悬停/键盘读数清掉。
  // 指纹必须覆盖**图上和按桶表里所有会显示的数字**,不能只取当前指标的合计:
  // 新增输入 -100 / 输出 +100 时合计不变,但明细表必须跟着变。
  const sig = [usageState.metric, usageState.range, width, height, drawable ? 1 : 0,
    series.map(bucket => [bucket.t, bucket.reqs, bucket.tokens_in, bucket.tokens_out, bucket.cache_read].join(':')).join(';')].join('|');
  if (sig === usageState.chartSig) return;
  usageState.chartSig = sig;
  // 时间轴没换(轮询值更新、切换指标)时保留读数位置;换了区间才回到"未选中"。
  const buckets = `${usageState.range}|` + series.map(bucket => String(bucket.t)).join(',');
  if (buckets !== usageState.chartBuckets) {
    usageState.chartBuckets = buckets;
    usageState.chartIndex = null;
  }

  // 左边距由最长刻度文字决定:写死 52px 时「750M」这类标签会越过 viewBox 左边界被裁掉。
  const widest = series.length
    ? Math.max(...[0, 0.25, 0.5, 0.75, 1].map(ratio => usageAxisLabel(maxValue * (1 - ratio)).length))
    : 4;
  const padLeft = Math.min(96, Math.max(44, Math.round(widest * 6.8) + 10)), padRight = 14, padTop = 12, padBottom = 26;
  const plotW = Math.max(10, width - padLeft - padRight);
  const plotH = Math.max(10, height - padTop - padBottom);

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', drawable
    ? `${rangeLabel} ${metricLabel} 趋势,共 ${series.length} 个时间桶;按左右方向键逐桶查看`
    : `${rangeLabel} ${metricLabel} 趋势:这个区间里没有请求`);
  usageState.chartBox = { width, height, padLeft, padTop, plotW, plotH };

  if (!drawable) {
    // 没有请求(含接口补齐的零桶)不画贴底 0 线,也不留一张全零的表。
    svg.innerHTML = `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="chart-axis">这个区间里没有请求</text>`;
    usageState.chartPoints = [];
    usageState.chartIndex = null;
    usageRenderTrendTable([]);
    usageHideTip();
    return;
  }

  const xOf = index => (series.length === 1
    ? padLeft + plotW / 2
    : padLeft + (index * plotW) / (series.length - 1));
  const yOf = value => padTop + plotH * (1 - (maxValue ? value / maxValue : 0));

  const points = values.map((value, index) => ({ x: xOf(index), y: yOf(value), value, t: series[index].t }));
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${points[points.length - 1].x.toFixed(1)} ${(padTop + plotH).toFixed(1)} L${points[0].x.toFixed(1)} ${(padTop + plotH).toFixed(1)} Z`;

  // 网格与 Y 轴刻度:4 段。
  const grid = [0, 0.25, 0.5, 0.75, 1].map(ratio => {
    const y = padTop + plotH * ratio;
    const value = maxValue * (1 - ratio);
    return `<line x1="${padLeft}" x2="${width - padRight}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line>
      <text x="${padLeft - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${esc(usageAxisLabel(value))}</text>`;
  }).join('');

  // X 轴刻度:最多 7 个,首尾必显。小时桶显示 HH:00,天桶显示 MM-DD。
  // 刻度数还要看可用宽度:窄屏塞 7 个 5 字符标签会糊成一团(00:03:00),按每格
  // 至少 ~56px(5 字符 mono + 间距)反推上限,两端始终保留。
  const maxTicks = Math.max(2, Math.min(7, Math.floor(plotW / 56)));
  const ticks = Math.min(maxTicks, series.length);
  const xLabels = Array.from({ length: ticks }, (_, i) => {
    // floor 而不是 round:round 在桶数只比刻度多 1 时会把相邻两个刻度算成同一个、再跳掉一格;
    // 首尾单独钉住,保证两端时间一定标出来。
    const index = ticks === 1 ? 0
      : i === ticks - 1 ? series.length - 1
      : Math.floor((i * (series.length - 1)) / (ticks - 1));
    const t = String(series[index].t || '');
    const text = t.includes('T') ? t.slice(11, 16) : t.slice(5);
    const anchor = i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle';
    return `<text x="${xOf(index).toFixed(1)}" y="${height - 6}" text-anchor="${anchor}">${esc(text)}</text>`;
  }).join('');

  // 颜色全走 CSS:线/面积用 --chart-series / --chart-area,光标与高亮点归 base.css 的
  // .chart-crosshair / .chart-active-dot 管,这里只给几何与显隐。
  svg.innerHTML = `
    <defs><linearGradient id="usage-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--chart-area, rgba(49,93,204,.16))"></stop>
      <stop offset="100%" stop-color="var(--chart-area, rgba(49,93,204,.16))" stop-opacity="0"></stop>
    </linearGradient></defs>
    <g class="chart-grid">${grid}</g>
    <path class="chart-area" fill="url(#usage-fill)" d="${area}"></path>
    <path class="chart-line" stroke="var(--chart-series, #315dcc)" d="${line}"></path>
    ${points.length <= 40 ? points.map(p => `<circle class="chart-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4"></circle>`).join('') : ''}
    <g class="chart-axis">${xLabels}</g>
    <line class="chart-crosshair" x1="0" x2="0" y1="${padTop}" y2="${padTop + plotH}" style="pointer-events:none;display:none" hidden></line>
    <circle class="chart-active-dot" cx="0" cy="0" r="5" style="pointer-events:none;display:none" hidden></circle>
    <rect class="chart-hit" x="0" y="0" width="${width}" height="${height}" style="fill:transparent;pointer-events:all"></rect>`;
  usageState.chartPoints = points;

  usageRenderTrendTable(series);
  // 播报区要在第一次更新之前就存在:和内容同时插入的话,部分读屏器不会念出来。
  usageEnsureLive();
  if (usageState.chartIndex !== null && usageState.chartIndex !== undefined) {
    usageShowPoint(usageState.chartIndex, { announce: usageState.chartFocus });
  } else {
    usageHideTip();
  }
}

// 图表尺寸随窗口变化:重建 SVG 才不会出现被拉伸变形的刻度文字。
let usageResizeTimer = null;
window.addEventListener('resize', () => {
  if (view !== 'usage' || !usageState.data) return;
  clearTimeout(usageResizeTimer);
  usageResizeTimer = setTimeout(() => { if (view === 'usage' && usageState.data) usageRenderChart(usageState.data); }, 150);
});
document.addEventListener('visibilitychange', () => {
  // 从后台切回来立即刷新一次:轮询在隐藏期间是跳过的,回来时数字可能已经过时。
  if (document.visibilityState === 'visible' && usageState.visible && usageState.inited) loadUsage();
});
document.addEventListener('DOMContentLoaded', () => {
  const holder = $('usage-chart-holder');
  if (!holder) return;
  // 鼠标悬停、触摸/点击、键盘方向键三种输入共用同一套读数。
  holder.addEventListener('mousemove', usageChartMove);
  holder.addEventListener('mouseleave', usageChartLeave);
  holder.addEventListener('click', usageChartMove);
  holder.addEventListener('keydown', usageChartKey);
  holder.addEventListener('focusin', usageChartFocusIn);
  holder.addEventListener('focusout', usageChartFocusOut);
});
