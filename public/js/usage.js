'use strict';
// 用量统计页。与 app.js 共用同一个 realm(classic script,不是 ESM):只声明本页自己的
// 变量与函数,不重复声明 `$` / `esc` / `toast` / `view`(重复声明会当场报错,这是安全网)。
//
// 数据来自 GET /api/usage?dashboard=1:磁盘 logs/requests.jsonl + 内存环,按本地时区分桶。
// dashboard 扩展给出 daily / records / facets / coverage;四张卡片、热力图、三张明细表
// 全部来自**同一次**查询的同一批行 —— 筛选只改查询参数,前端不做二次过滤,避免各块对不上。
//
// 几条容易做错的边界,这里都写死:
//   1) 日期字符串是本地日期('YYYY-MM-DD')。**不**走 new Date('YYYY-MM-DD')(那是 UTC
//      午夜),一律拆年月日再拼本地 Date —— 否则负时区会整体差一天;
//   2) 轮询与筛选共用 seq + AbortController:只有最后一次发起的响应能落地;
//   3) 筛选变了但新结果还没回来(或失败)时,#usage-data-frame 标 data-stale="true",
//      状态行明说「下方是上一次查询的结果」,绝不把旧数据当作新筛选的答案;
//   4) 热力图里「未来 / 未覆盖 / 不在区间」与「区间内确实没有请求」是四种不同状态:
//      只有最后一种才是 0,其余三种不许画成 0,也不许悄悄留白让人误读。

const USAGE_PREF_KEY = 'mixr.usage.prefs';
const USAGE_RANGE_LABELS = { today: '今天', '24h': '近 24 小时', '7d': '近 7 天', '30d': '近 30 天', all: '全部' };
const USAGE_METRIC_LABELS = { tokens: 'Tokens', reqs: '请求' };
const USAGE_TABS = ['requests', 'providers', 'models'];
const USAGE_APP_LABELS = { claude: 'Anthropic', codex: 'OpenAI' };
const USAGE_WEEKDAY_CHARS = ['日', '一', '二', '三', '四', '五', '六'];
const USAGE_DETAIL_HEAD = {
  requests: ['时间', '协议组', '供应商', '模型', '新增输入', '输出', '缓存读取', '状态', '速度', '首响应'],
  providers: ['供应商', '请求', '新增输入', '输出', '缓存读取', '缓存命中率'],
  models: ['模型', '请求', '新增输入', '输出', '缓存读取', '缓存命中率'],
};
const USAGE_WEEK_COUNT = 53;
const USAGE_MAX_EXPAND = 8;

// 页面状态只在这里一处。`data` 是上次成功读取的响应;失败时保留旧数据并标 stale。
const usageState = {
  range: 'all', app: '', provider: '', model: '', status: '',
  metric: 'tokens', interval: 60, tab: 'requests', limit: 50, offset: 0, pageAgg: 0,
  data: null, shownQuery: '', pendingQuery: '',
  inited: false, visible: false, timer: null, controller: null, seq: 0, lastSync: 0, busy: false,
  heatExpanded: 0, heatDate: null, heatFocus: false, heatKeyMode: false,
  heatSig: '', heatModel: null, heatLive: null, dailyRefs: null,
  legendResolved: false, legendHost: null, legendExtra: null,
  sourceOpen: false,
};

// ---- 数值格式 -------------------------------------------------------------
// null / undefined / '' 一律当「没有这个数」—— Number(null) 是 0,直接塞进 Number.isFinite
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
// 本地时间 HH:mm:ss。日志里的 ts 是 UTC,展示按浏览器本地时间。
const usageClock = ms => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
const usagePad = value => String(value).padStart(2, '0');

// ---- 本地日期(不走 UTC) ---------------------------------------------------
// 'YYYY-MM-DD' → {y,m,d}。只认字符串前缀,避免把日志里的脏字符串当日期。
function usageParseDayKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key == null ? '' : key));
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}
function usageDayDate(key) {
  const parts = usageParseDayKey(key);
  return parts ? new Date(parts.y, parts.m - 1, parts.d) : null;
}
function usageDayKey(date) {
  return `${date.getFullYear()}-${usagePad(date.getMonth() + 1)}-${usagePad(date.getDate())}`;
}
function usageAddDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}
// ISO 时间戳 → 浏览器本地日期键。scope / coverage 都是 UTC ISO,先落到本地再取日期。
function usageLocalDayKey(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  return usageDayKey(new Date(ms));
}
// Monday = 0 … Sunday = 6。JS 的 getDay() 是 Sunday = 0。
const usageMondayIndex = date => (date.getDay() + 6) % 7;

// 偏好只存区间/指标/间隔/协议组与来源说明的开合。供应商与模型是动态清单,存了下次也可能不存在。
function usageLoadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(USAGE_PREF_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return;
    if (USAGE_RANGE_LABELS[raw.range]) usageState.range = raw.range;
    if (Object.hasOwn(USAGE_METRIC_LABELS, raw.metric)) usageState.metric = raw.metric;
    if ([0, 30, 60, 300].includes(Number(raw.interval))) usageState.interval = Number(raw.interval);
    if (['', 'claude', 'codex'].includes(raw.app)) usageState.app = raw.app;
    if (typeof raw.source === 'boolean') usageState.sourceOpen = raw.source;
  } catch { /* 隐私模式/配额满:偏好读不到就用默认值,页面照常工作 */ }
}
function usageSavePrefs() {
  try {
    localStorage.setItem(USAGE_PREF_KEY, JSON.stringify({
      range: usageState.range, metric: usageState.metric,
      interval: usageState.interval, app: usageState.app, source: usageState.sourceOpen,
    }));
  } catch { /* 同上:存不下不影响本页 */ }
}

// ---- 查询 -----------------------------------------------------------------
// 所有控件(时间区间 / 协议组 / 供应商 / 模型 / 状态)都进同一个查询串,服务端按同一批行
// 计算卡片、daily、records 与聚合表。offset/limit 只决定 records 取哪一页。
function usageQuery() {
  const q = new URLSearchParams();
  q.set('dashboard', '1');
  q.set('range', usageState.range);
  if (usageState.app) q.set('app', usageState.app);
  if (usageState.provider) q.set('provider', usageState.provider);
  if (usageState.model) q.set('model', usageState.model);
  if (usageState.status) q.set('status', usageState.status);
  q.set('offset', String(usageState.offset));
  q.set('limit', String(usageState.limit));
  return q.toString();
}

// ---- 数据读取 -------------------------------------------------------------
function usageWriteStatus(text, tone = '') {
  const el = $('usage-status');
  if (!el) return;
  el.textContent = text;
  if (el.dataset) el.dataset.tone = tone;
  // 样式表用 #usage-status.stale 标失败态;颜色只走 CSS,不在 JS 里写死。
  el.classList.toggle('stale', tone === 'err');
}
function usageSetLastSync(text) {
  const el = $('usage-last-sync');
  if (el) el.textContent = text;
}
function usageSetBusy(busy) {
  usageState.busy = !!busy;
  const frame = $('usage-data-frame');
  if (!frame) return;
  frame.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (frame.dataset) frame.dataset.busy = busy ? 'true' : 'false';
}
// 旧数据是不是「当前筛选的答案」。force 用于读取失败:旧数据哪怕同一筛选也过期了。
function usageMarkStale(force) {
  const frame = $('usage-data-frame');
  const changed = !!(usageState.data && usageState.shownQuery && usageState.pendingQuery !== usageState.shownQuery);
  const stale = !!(usageState.data && (force || changed));
  if (frame) {
    if (frame.dataset) frame.dataset.stale = stale ? 'true' : 'false';
    frame.classList.toggle('is-stale', stale);
  }
  return stale;
}
function usageChartState(state) {
  const holder = $('usage-chart-holder');
  if (holder && holder.dataset) holder.dataset.chart = state;
}
function usageSyncButton(busy) {
  const button = $('usage-sync');
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? '同步中…' : '立即同步';
}

// seq 保证只有「最后一次发起」的响应能落地;AbortController 让被取代的请求真正取消。
// 超时与「被新请求取代」必须分开:前者要报错,后者静默丢弃。
async function loadUsage() {
  if (!usageState.inited) usageInitControls();
  const seq = ++usageState.seq;
  if (usageState.controller) usageState.controller.abort();
  const controller = new AbortController();
  usageState.controller = controller;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { controller.abort(); } catch { /* 已结束 */ }
  }, 20000);

  const query = usageQuery();
  usageState.pendingQuery = query;
  usageSyncButton(true);
  usageSetBusy(true);
  if (!usageState.data) usageChartState('loading');
  const stale = usageMarkStale();
  if (!usageState.data) usageWriteStatus('正在读取用量…');
  else if (stale) usageWriteStatus('正在按当前筛选读取…下方仍是上一次查询的结果,不是当前筛选的答案。');

  try {
    const response = await fetch('/api/usage?' + query, {
      signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' },
    });
    let body = null;
    try { body = await response.json(); } catch { /* 非 JSON 由下面统一报错 */ }
    if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
    if (!body || typeof body !== 'object') throw new Error('接口返回的不是 JSON 对象');
    if (seq !== usageState.seq) return; // 已被更新的请求取代
    usageState.data = body;
    usageState.shownQuery = query;
    const records = body && body.dashboard && body.dashboard.records;
    const servedOffset = records ? usageNum(records.offset) : null;
    if (servedOffset !== null) usageState.offset = servedOffset;
    usageState.lastSync = Date.now();
    usageRender(body);
    usageChartState('ready');
    usageMarkStale();
    usageWriteStatus(`区间内 ${usageInt(body.totals && body.totals.reqs)} 次请求 · ${usageSourceLabel(body)} · 最近同步 ${usageClock(usageState.lastSync)}`, 'ok');
    usageSetLastSync(`最近同步 ${usageClock(usageState.lastSync)}`);
  } catch (e) {
    if (seq !== usageState.seq) return;
    if (e && e.name === 'AbortError' && !timedOut) return; // 被新请求取代,不是错误
    const reason = timedOut ? '读取超时(20 秒未返回)' : (e && e.message ? e.message : '未知错误');
    usageMarkStale(true);
    usageWriteStatus(`用量读取失败:${reason}${usageState.data ? '。下方保留的是上一次成功读取的数据,与当前筛选/时刻不一致,不要当成当前结果。' : '。尚未取得任何数据。'}`, 'err');
    usageSetLastSync(`同步失败 ${usageClock(Date.now())}`);
    if (!usageState.data) usageChartState('error');
  } finally {
    clearTimeout(timer);
    if (seq === usageState.seq) {
      usageSyncButton(false);
      usageSetBusy(false);
      usageState.controller = null;
    }
  }
}

function usageSourceLabel(data) {
  const source = data && data.scope ? data.scope.source : '';
  if (source === 'memory') return '仅内存窗口(还没落盘日志)';
  if (source === 'disk+memory') return '磁盘日志 + 内存窗口';
  return '本机请求日志';
}

// ---- 控件同步 -------------------------------------------------------------
// 分段按钮 / 标签页 / 下拉的 active 与 aria 只在这里统一改,避免各处漏一个。
function usageSyncChrome() {
  const seg = (selector, attr, value, aria) => {
    document.querySelectorAll(selector).forEach(button => {
      const on = button.getAttribute(attr) === value;
      button.classList.toggle('active', on);
      if (aria) button.setAttribute(aria, String(on));
    });
  };
  seg('.usage-range [data-range]', 'data-range', usageState.range, 'aria-pressed');
  seg('.usage-tabs [data-metric]', 'data-metric', usageState.metric, 'aria-pressed');
  seg('.usage-apps [data-usage-app]', 'data-usage-app', usageState.app, 'aria-pressed');
  document.querySelectorAll('.usage-detail-tabs [data-usage-tab]').forEach(button => {
    const on = button.getAttribute('data-usage-tab') === usageState.tab;
    button.classList.toggle('active', on);
    button.setAttribute('aria-selected', String(on));
    button.setAttribute('tabindex', on ? '0' : '-1');
  });
  const panel = $('usage-detail-panel');
  if (panel) panel.setAttribute('aria-labelledby', 'usage-tab-' + usageState.tab);
  const pairs = [
    ['usage-range-select', usageState.range],
    ['usage-app', usageState.app],
    ['usage-status-filter', usageState.status],
    ['usage-interval', String(usageState.interval)],
  ];
  for (const [id, value] of pairs) {
    const el = $(id);
    // 用户正打开着下拉时不要动它的值,否则列表会跳。
    if (el && document.activeElement !== el) el.value = value;
  }
}

function usageInitControls() {
  usageState.inited = true;
  usageLoadPrefs();
  usageApplySourceOpen();
  usageSyncChrome();
  usageBindFilterSelect();
  usageSchedule();
}

// 轮询把下拉重填成同样的选项会把它收起、滚回顶部。选项串没变就不写 DOM;选项真的变了
// 而用户正开着这个下拉,先记下来,失焦后再应用。
function usageBindFilterSelect() {
  for (const [id, key] of [['usage-provider', 'provider'], ['usage-model', 'model']]) {
    const el = $(id);
    if (!el || el._mixrBound) continue;
    el._mixrBound = true;
    el.addEventListener('blur', () => {
      if (!el._mixrPending) return;
      el.innerHTML = el._mixrPending;
      el._mixrOptions = el._mixrPending;
      el._mixrPending = null;
      el.value = usageState[key] || '';
    });
  }
}

// 定时器按当前间隔重建。关掉(0)就只保留手动同步。
function usageSchedule() {
  if (usageState.timer) { clearInterval(usageState.timer); usageState.timer = null; }
  if (!usageState.visible || !usageState.interval) return;
  usageState.timer = setInterval(() => {
    if (document.visibilityState === 'hidden') return; // 看不见就不该占资源
    loadUsage();
  }, usageState.interval * 1000);
}
// app.js 的 showView 调这个:进入/离开用量页。
function usageSetVisible(on) {
  usageState.visible = !!on;
  if (!on) {
    if (usageState.timer) { clearInterval(usageState.timer); usageState.timer = null; }
    if (usageState.controller) {
      usageState.seq += 1; // 离开页面后返回的响应一律丢弃
      usageState.controller.abort();
      usageState.controller = null;
    }
    // 被丢弃的请求不会再走 finally,这里自己把忙碌态收掉,回来时不会卡在「同步中…」。
    usageSetBusy(false);
    usageSyncButton(false);
    return;
  }
  usageSchedule();
}
function renderUsage() {
  if (!usageState.inited) usageInitControls();
  else usageSyncChrome();
  loadUsage();
}

// ---- 控件动作 -------------------------------------------------------------
function setUsageRange(range) {
  if (!USAGE_RANGE_LABELS[range] || usageState.range === range) return;
  usageState.range = range;
  usageState.offset = 0;
  usageState.pageAgg = 0;
  usageState.heatExpanded = 0;
  usageSavePrefs();
  usageSyncChrome();
  loadUsage();
}
function setUsageFilter(key, value) {
  if (!['app', 'provider', 'model'].includes(key)) return;
  if (key === 'app' && !['', 'claude', 'codex'].includes(value)) return;
  const next = value == null ? '' : String(value);
  if (usageState[key] === next) return;
  usageState[key] = next;
  usageState.offset = 0;
  usageState.pageAgg = 0;
  if (key === 'app') usageSavePrefs();
  usageSyncChrome();
  loadUsage();
}
function setUsageStatus(value) {
  const next = value === 'ok' || value === 'err' ? value : '';
  if (usageState.status === next) return;
  usageState.status = next;
  usageState.offset = 0;
  usageState.pageAgg = 0;
  usageSyncChrome();
  loadUsage();
}
function clearUsageFilters() {
  if (!usageState.app && !usageState.provider && !usageState.model && !usageState.status) return;
  usageState.app = '';
  usageState.provider = '';
  usageState.model = '';
  usageState.status = '';
  usageState.offset = 0;
  usageState.pageAgg = 0;
  usageSavePrefs();
  usageSyncChrome();
  loadUsage();
}
function setUsageMetric(metric) {
  if (!Object.hasOwn(USAGE_METRIC_LABELS, metric) || usageState.metric === metric) return;
  usageState.metric = metric;
  usageSavePrefs();
  usageSyncChrome();
  if (usageState.data) usageRenderHeat(usageState.data); // 纯前端重画,不发请求
}
function setUsageInterval(value) {
  const seconds = Number(value);
  if (![0, 30, 60, 300].includes(seconds)) return;
  usageState.interval = seconds;
  usageSavePrefs();
  usageSchedule();
}
function setUsageTab(tab) {
  if (!USAGE_TABS.includes(tab) || usageState.tab === tab) return;
  usageState.tab = tab;
  usageSyncChrome();
  if (usageState.data) {
    usageRenderDetail(usageState.data);
    usageRenderPagination(usageState.data);
  }
}
function usagePage(delta) {
  if (!usageState.data) return;
  const direction = Number(delta) < 0 ? -1 : 1;
  if (usageState.tab === 'requests') {
    const records = (usageState.data.dashboard && usageState.data.dashboard.records) || {};
    const total = usageNum(records.total) || 0;
    const pages = Math.max(1, Math.ceil(total / usageState.limit));
    const current = Math.floor(usageState.offset / usageState.limit);
    const next = Math.min(pages - 1, Math.max(0, current + direction));
    if (next === current) return;
    usageState.offset = next * usageState.limit;
    loadUsage();
    return;
  }
  const list = usageState.tab === 'providers' ? usageState.data.by_provider : usageState.data.by_model;
  const pages = Math.max(1, Math.ceil((Array.isArray(list) ? list.length : 0) / usageState.limit));
  const next = Math.min(pages - 1, Math.max(0, usageState.pageAgg + direction));
  if (next === usageState.pageAgg) return;
  usageState.pageAgg = next;
  usageRenderDetail(usageState.data);
  usageRenderPagination(usageState.data);
}
function toggleUsageSource() {
  usageState.sourceOpen = !usageState.sourceOpen;
  usageApplySourceOpen();
  usageSavePrefs();
}
// 面板默认收起(首屏留给指标卡与热力图),展开是用户选择,下次打开沿用。
function usageApplySourceOpen() {
  const panel = $('usage-source');
  const button = $('usage-source-toggle');
  if (panel) panel.hidden = !usageState.sourceOpen;
  if (button) button.setAttribute('aria-expanded', String(usageState.sourceOpen));
}

// ---- 渲染 -----------------------------------------------------------------
function usageRender(data) {
  usageRenderCards(data);
  usageRenderFilters(data);
  usageRenderHeat(data);
  usageRenderDetail(data);
  usageRenderPagination(data);
  usageRenderSource(data);
}

function usageRenderCards(data) {
  const totals = (data && data.totals) || {};
  const scope = (data && data.scope) || {};
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  const reqs = usageNum(totals.reqs);
  set('usage-reqs', reqs === null ? '—' : usageInt(reqs));
  const from = usageLocalDayKey(scope.from);
  const to = usageLocalDayKey(scope.to);
  set('usage-request-hint', from && to ? `${from} – ${to}` : '可用日志');
  set('usage-tokens', usageTok(totals.tokens_total));
  set('usage-token-split', `新增 ${usageTok(totals.tokens_in)} / 输出 ${usageTok(totals.tokens_out)} / 缓存 ${usageTok(totals.cache_read)}`);
  set('usage-cache', usagePct(totals.cache_hit_rate));
  set('usage-cache-hint', '缓存读取 / (新增输入 + 缓存读取)');
  const rate = usageNum(totals.ok_rate);
  set('usage-success', rate === null ? '—' : rate.toFixed(1) + '%');
  set('usage-ok-rate', rate === null ? '暂无成功率样本' : `按日志状态判定 · ${usageInt(totals.reqs)} 次请求`);
  // 速度/首响应是补充指标,放在「更多指标」里;没有样本时也是「—」而不是 0。
  set('usage-speed', totals.speed_tps ? `${Math.round(Number(totals.speed_tps))} tok/s` : '—');
  const ttfb = $('usage-ttfb');
  if (ttfb) {
    ttfb.textContent = usageMs(totals.ttfb_p50_ms);
    // 日志里的 ttfb_ms 量的是「上游响应头到达」,不是模型首个输出 token:标签不能用「首字」冒充。
    if (ttfb.setAttribute) {
      ttfb.setAttribute('title', '上游响应头到达时间(P50),不是模型首个输出 token 的时间');
      ttfb.setAttribute('aria-label', '首响应 P50:上游响应头到达时间,不是模型首个输出 token 的时间');
    }
    usageRelabelTtfb(ttfb);
  }
}
// 静态 HTML 里的标签文字写成「首字延迟」会误导;这里就地改成「首响应」,找不到标签就只靠
// title/aria 兜底。不改 index.html(那是外壳的文件)。
function usageRelabelTtfb(value) {
  const parent = value && value.parentNode;
  const children = parent && parent.children ? parent.children : null;
  if (!children) return;
  for (const child of children) {
    if (child === value || !child || child.id) continue;
    if (child.tagName && String(child.tagName).toLowerCase() !== 'span') continue;
    if (child.textContent && child.textContent.indexOf('首字') !== -1) child.textContent = '首响应 P50';
  }
}

// 下拉选项只用 facets(服务端在 provider/model 过滤**之前**算好的清单),这样选中一个
// 供应商之后其余供应商仍在列表里。当前值即使不在清单里也保留并标成「当前筛选」,
// 绝静默重置 —— 否则页面显示「全部」而请求还带着旧筛选。
function usageFacetOptions(items, allLabel, current) {
  const list = (Array.isArray(items) ? items : [])
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      value: String(item.value ?? item.label ?? ''),
      label: String(item.label ?? item.value ?? ''),
    }))
    .filter(item => item.value !== '' || item.label !== '');
  const values = new Set(list.map(item => item.value));
  const html = [`<option value="">${esc(allLabel)}</option>`]
    .concat(list.map(item => `<option value="${esc(item.value)}">${esc(item.label)}</option>`));
  if (current && !values.has(current)) {
    html.push(`<option value="${esc(current)}">${esc(current)}(当前筛选,无匹配)</option>`);
  }
  return html.join('');
}
function usageFillSelect(id, items, current, allLabel) {
  const el = $(id);
  if (!el) return;
  const html = usageFacetOptions(items, allLabel, current);
  if (el._mixrOptions !== html) {
    if (document.activeElement === el) {
      el._mixrPending = html; // 下拉正开着:失焦后再换
    } else {
      el.innerHTML = html;
      el._mixrOptions = html;
      el._mixrPending = null;
    }
  }
  if (!el._mixrPending && document.activeElement !== el) el.value = current || '';
}
function usageRenderFilters(data) {
  const dashboard = (data && data.dashboard) || {};
  const facets = dashboard.facets || {};
  const providerFacets = Array.isArray(facets.providers) && facets.providers.length
    ? facets.providers
    : (Array.isArray(data.by_provider) ? data.by_provider.map(p => ({
      value: p.name || p.provider || '', label: p.name || p.provider || '',
    })) : []);
  const modelFacets = Array.isArray(facets.models) && facets.models.length
    ? facets.models
    : (Array.isArray(data.by_model) ? data.by_model.map(m => ({ value: m.model || '', label: m.model || '' })) : []);
  usageFillSelect('usage-provider', providerFacets, usageState.provider, '全部供应商');
  usageFillSelect('usage-model', modelFacets, usageState.model, '全部模型');
}

// ---- 卡片 → 热力图 ---------------------------------------------------------
// daily:后端给的按日汇总(本地日期)。旧后端没有 dashboard 时,从 series 按天求和 ——
// 同一批行、同一种口径,只是粒度粗一点,不会造出不存在的历史。
function usageDailyRows(data) {
  const dashboard = data && data.dashboard;
  const list = dashboard && Array.isArray(dashboard.daily) ? dashboard.daily : null;
  if (list) {
    return list
      .filter(row => row && usageParseDayKey(row.t))
      .map(row => {
        const tokensIn = usageNum(row.tokens_in) || 0;
        const tokensOut = usageNum(row.tokens_out) || 0;
        const cacheRead = usageNum(row.cache_read) || 0;
        return {
          t: String(row.t).slice(0, 10),
          reqs: usageNum(row.reqs) || 0,
          tokens_in: tokensIn, tokens_out: tokensOut, cache_read: cacheRead,
          tokens: tokensIn + tokensOut + cacheRead,
        };
      });
  }
  const series = Array.isArray(data && data.series) ? data.series : [];
  const map = new Map();
  for (const bucket of series) {
    if (!bucket) continue;
    const key = String(bucket.t || '').slice(0, 10);
    if (!usageParseDayKey(key)) continue;
    const row = map.get(key) || { t: key, reqs: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, tokens: 0 };
    row.reqs += usageNum(bucket.reqs) || 0;
    row.tokens_in += usageNum(bucket.tokens_in) || 0;
    row.tokens_out += usageNum(bucket.tokens_out) || 0;
    row.cache_read += usageNum(bucket.cache_read) || 0;
    row.tokens = row.tokens_in + row.tokens_out + row.cache_read;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => a.t.localeCompare(b.t));
}

// 色阶阈值:取区间内正值的 25/50/75 分位。单个超大日不会把所有其他日子压成同一级。
function usageHeatThresholds(values) {
  const positive = values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!positive.length) return [0, 0, 0];
  const at = q => positive[Math.min(positive.length - 1, Math.max(0, Math.ceil(q * positive.length) - 1))];
  let t1 = at(0.25);
  let t2 = at(0.5);
  let t3 = at(0.75);
  if (!(t1 > 0)) t1 = positive[0];
  if (!(t2 > t1)) t2 = t1;
  if (!(t3 > t2)) t3 = t2;
  return [t1, t2, t3];
}
function usageHeatLevel(value, thresholds) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= thresholds[0]) return 1;
  if (n <= thresholds[1]) return 2;
  if (n <= thresholds[2]) return 3;
  return 4;
}

// 一次算清 371 格(可扩展到多个 53 周块)的日期、数值、状态与色阶。纯计算,不改 DOM。
function usageHeatModel(data) {
  const scope = (data && data.scope) || {};
  const dashboard = (data && data.dashboard) || {};
  const hasDashboard = !!(data && data.dashboard && typeof data.dashboard === 'object');
  const now = new Date();
  const todayKey = usageDayKey(now);
  const todayDate = usageDayDate(todayKey);
  const rangeStartKey = usageLocalDayKey(scope.from) || todayKey;
  const rangeEndKey = usageLocalDayKey(scope.to) || todayKey;
  const anchor = usageDayDate(rangeEndKey) || todayDate;
  const weeks = USAGE_WEEK_COUNT * (1 + Math.max(0, usageState.heatExpanded | 0));
  const weekStart = usageAddDays(anchor, -usageMondayIndex(anchor));
  const gridStart = usageAddDays(weekStart, -(weeks - 1) * 7);
  const gridEnd = usageAddDays(weekStart, 6);
  const gridStartKey = usageDayKey(gridStart);
  const gridEndKey = usageDayKey(gridEnd);

  const daily = usageDailyRows(data);
  const map = new Map(daily.map(row => [row.t, row]));
  const coverage = dashboard.coverage || {};
  // first_ts / last_ts 只是「日志里实际出现过的记录」的观察边界,不是保留期承诺:
  //   · first_ts 之前:可能被轮转/清理掉了,属于未知 → 标成「未覆盖」,绝不当作 0;
  //   · last_ts 之后到今天:每次读取都已扫到当前时刻,这段时间没有记录就是**确实没有请求**
  //     → 仍然算在覆盖范围内,画成真实的 0,不能因为「最后一条记录是三天前」就说未覆盖。
  // 没有 dashboard 的旧响应用统计区间本身当覆盖范围(series 就是这段时间的全部桶)。
  const covFirstKey = usageLocalDayKey(coverage.first_ts) || (hasDashboard ? null : rangeStartKey);
  const covLastKey = covFirstKey
    ? (todayKey > covFirstKey ? todayKey : usageLocalDayKey(coverage.last_ts) || todayKey)
    : (hasDashboard ? null : rangeEndKey);

  const cells = [];
  const byKey = new Map();
  for (let index = 0; index < weeks * 7; index += 1) {
    const date = usageAddDays(gridStart, index);
    const key = usageDayKey(date);
    const row = map.get(key);
    const tokensIn = row ? row.tokens_in : 0;
    const tokensOut = row ? row.tokens_out : 0;
    const cacheRead = row ? row.cache_read : 0;
    const cell = {
      key, date,
      reqs: row ? row.reqs : 0,
      tokens_in: tokensIn, tokens_out: tokensOut, cache_read: cacheRead,
      tokens: tokensIn + tokensOut + cacheRead,
      // 区间 / 覆盖 / 未来各自独立:它们与「区间内的 0」不是一回事。
      active: key >= rangeStartKey && key <= rangeEndKey,
      covered: !!(covFirstKey && covLastKey && key >= covFirstKey && key <= covLastKey),
      future: date.getTime() > todayDate.getTime(),
      level: 0,
    };
    cells.push(cell);
    byKey.set(key, cell);
  }

  const metricValue = cell => (usageState.metric === 'reqs' ? cell.reqs : cell.tokens);
  const thresholds = usageHeatThresholds(cells.filter(cell => cell.active && cell.covered).map(metricValue));
  for (const cell of cells) {
    if (!cell.active || !cell.covered) { cell.level = 0; continue; }
    // 「这一天有没有活动」看请求数或任一 token 计数,而不是只看当前指标:某些行没有
    // 遥测(in/out/cache 全缺),按 Tokens 着色时合计是 0,但那一天确实发生过请求,
    // 不能画成和「没有请求」一样的空白色阶。
    const active = cell.reqs > 0 || cell.tokens > 0;
    cell.level = active ? Math.max(1, usageHeatLevel(metricValue(cell), thresholds)) : 0;
  }

  // 月份标签:从每列第一天取月份,变化处换标签并计算跨列宽度。
  const months = [];
  for (let week = 0; week < weeks; week += 1) {
    const month = usageAddDays(gridStart, week * 7).getMonth() + 1;
    const last = months[months.length - 1];
    if (!last || last.month !== month) months.push({ month, start: week, span: 1 });
    else last.span += 1;
  }

  const activeCells = cells.filter(cell => cell.active);
  const activeDays = activeCells.filter(cell => cell.covered).length;
  const daysWithReqs = activeCells.filter(cell => cell.covered && (cell.reqs > 0 || cell.tokens > 0)).length;
  const anyOutside = cells.some(cell => !cell.covered && !cell.future);
  const anyInactive = cells.some(cell => !cell.active && !cell.future);
  const anyFuture = cells.some(cell => cell.future);
  const latestActive = [...cells].reverse().find(cell => cell.active && cell.covered)
    || [...cells].reverse().find(cell => cell.active)
    || cells[cells.length - 1];
  const total = data && data.totals ? usageNum(data.totals.reqs) : null;
  const hasRequests = daysWithReqs > 0 || (total !== null && total > 0);

  return {
    weeks, gridStart, gridEnd, gridStartKey, gridEndKey, rangeStartKey, rangeEndKey,
    todayKey, cells, byKey, months, thresholds, activeDays, daysWithReqs, hasRequests,
    hasCoverage: !!covFirstKey,
    anyOutside, anyInactive, anyFuture,
    hasEarlier: rangeStartKey < gridStartKey,
    tabKey: latestActive ? latestActive.key : gridStartKey,
  };
}

function usageDayLabel(key) {
  const parts = usageParseDayKey(key);
  if (!parts) return String(key || '—');
  const date = usageDayDate(key);
  return `${parts.m}月${parts.d}日 周${USAGE_WEEKDAY_CHARS[date.getDay()]}`;
}

// 四种状态必须说清楚:未来 / 未覆盖 / 不在区间 / 区间内的真实 0。
function usageHeatCellText(cell) {
  const base = usageDayLabel(cell.key);
  if (cell.future) return `${base} · 未来日期,尚无数据`;
  if (!cell.covered) return `${base} · 未覆盖:数据源没有这一天的日志`;
  if (!cell.active) return `${base} · 不在当前统计区间`;
  return `${base} · ${usageInt(cell.reqs)} 次请求 · ${usageTok(cell.tokens)} tokens`;
}
function usageHeatCellLabel(cell) {
  const base = usageDayLabel(cell.key);
  if (cell.future) return `${base},未来日期`;
  if (!cell.covered) return `${base},未覆盖`;
  if (!cell.active) return `${base},不在当前统计区间`;
  return `${base},${usageInt(cell.reqs)} 次请求,${usageTok(cell.tokens)} tokens`;
}

function usageHeatSignature(model) {
  return [usageState.metric, model.weeks, model.gridStartKey, model.rangeStartKey, model.rangeEndKey,
    model.anyOutside ? 1 : 0, model.anyInactive ? 1 : 0,
    model.cells.map(cell => `${cell.key}:${cell.reqs}:${cell.tokens_in}:${cell.tokens_out}:${cell.cache_read}:${cell.active ? 1 : 0}${cell.covered ? 1 : 0}${cell.future ? 1 : 0}`).join(';')]
    .join('|');
}

// 图例有两种宿主:外壳(index.html)已经在 .usage-chart-foot 里放了色阶图例,此时只在
// 它后面补一句「0 / 区间外 / 未来」的说明,绝不重复渲染第二份;旧版页面没有图例时才自建。
function usageLegendHost() {
  if (usageState.legendResolved) return usageState.legendHost;
  usageState.legendResolved = true;
  usageState.legendHost = document.querySelector ? document.querySelector('.heatmap-legend') : null;
  if (usageState.legendHost && usageState.legendHost.querySelectorAll) {
    Array.from(usageState.legendHost.querySelectorAll('[data-level]')).forEach(swatch => {
      const level = swatch.getAttribute('data-level');
      if (level === '0') {
        swatch.setAttribute('title', '0:区间内确实没有请求');
        swatch.setAttribute('aria-label', '0 次请求');
      } else {
        swatch.setAttribute('title', `用量第 ${level} 级(越深越高)`);
        swatch.setAttribute('aria-label', `用量第 ${level} 级`);
      }
    });
  }
  return usageState.legendHost;
}
function usageLegendExtra(host) {
  if (usageState.legendExtra) return usageState.legendExtra;
  if (!host || !host.appendChild || !document.createElement) return null;
  const extra = document.createElement('span');
  extra.className = 'heatmap-legend-extra';
  extra.id = 'usage-heatmap-legend-extra';
  extra.style.cssText = 'display:inline-flex;flex-wrap:wrap;gap:4px 10px;align-items:center';
  host.appendChild(extra);
  usageState.legendExtra = extra;
  return extra;
}
function usageLegendNotes(model) {
  const notes = ['0 = 区间内无请求'];
  if (model.anyInactive) notes.push('区间外的日期不参与统计');
  if (model.anyFuture) notes.push('未来日期尚无数据');
  return notes;
}
// 自建图例(旧版页面无 .heatmap-legend 时):色阶 + 三种非零状态都写明。
function usageHeatLegend(model, metricLabel) {
  const parts = [
    '<span class="heatmap-legend-swatch" data-level="0" aria-hidden="true"></span><span class="heatmap-legend-label">0 请求</span>',
    '<span class="heatmap-legend-label">少</span>'
    + [1, 2, 3, 4].map(level => `<span class="heatmap-legend-swatch" data-level="${level}" aria-hidden="true"></span>`).join('')
    + '<span class="heatmap-legend-label">多</span>',
  ];
  if (model.anyOutside) parts.push('<span class="heatmap-legend-swatch" data-coverage="outside" aria-hidden="true"></span><span class="heatmap-legend-label">未覆盖</span>');
  if (model.anyInactive) parts.push('<span class="heatmap-legend-swatch" data-active="false" aria-hidden="true"></span><span class="heatmap-legend-label">不在区间</span>');
  if (model.anyFuture) parts.push('<span class="heatmap-legend-swatch" data-future="true" aria-hidden="true"></span><span class="heatmap-legend-label">未来</span>');
  parts.push(`<span class="heatmap-legend-label">按 ${esc(metricLabel)} 着色</span>`);
  return `<div class="heatmap-legend">${parts.join('')}</div>`;
}

function usageRenderHeat(data) {
  const model = usageHeatModel(data);
  usageState.heatModel = model;
  usageRenderHeatSummary(model, data);

  const metricLabel = USAGE_METRIC_LABELS[usageState.metric] || usageState.metric;
  const label = $('usage-range-label');
  if (label) label.textContent = `按 ${metricLabel} 着色 · ${USAGE_RANGE_LABELS[usageState.range] || usageState.range}`;

  const empty = $('usage-chart-empty');
  if (empty) {
    const none = !model.hasRequests;
    empty.hidden = !none;
    empty.textContent = none
      ? (!model.hasCoverage
        ? '数据源暂无可用的请求日志。'
        : (model.activeDays === 0 ? '这个统计区间里没有可用的日志记录。' : '这个区间里没有请求。'))
      : '';
  }

  const root = $('usage-heatmap');
  const sig = usageHeatSignature(model);
  if (root && root.setAttribute) {
    // 外壳给的 role="img" 会把所有格子从无障碍树里抹掉;这里换成容器语义。
    root.setAttribute('role', 'group');
    root.setAttribute('data-weeks', String(model.weeks));
  }
  if (!root || sig === usageState.heatSig) return;
  usageState.heatSig = sig;
  if (usageState.heatDate && !model.byKey.has(usageState.heatDate)) usageState.heatDate = null;
  usageRenderDailyTable(model);

  const tabKey = usageState.heatDate || model.tabKey;
  const months = model.months.map(month => `<span class="heatmap-month" style="grid-column:${month.start + 1} / span ${month.span}">${month.month}月</span>`).join('');
  // 七行固定周一到周日;只给奇数行写文字(一/三/五/日),其余留空占位。
  const weekdays = [0, 1, 2, 3, 4, 5, 6].map(row => `<span>${row % 2 === 0 ? USAGE_WEEKDAY_CHARS[(row + 1) % 7] : ''}</span>`).join('');
  const cells = model.cells.map(cell => {
    // 区间外的日期淡化显示:它既不是 0,也不该和真实 0 抢同一块底色。
    const ghosts = !cell.active && !cell.future;
    const attrs = [
      'class="heatmap-cell"',
      'role="img"',
      `data-date="${cell.key}"`,
      `data-level="${cell.level}"`,
      `data-active="${cell.active}"`,
      `data-coverage="${cell.covered ? 'inside' : 'outside'}"`,
      ghosts ? 'data-inactive="true"' : '',
      ghosts ? 'style="opacity:0.35"' : '',
      cell.future ? 'data-future="true"' : '',
      `tabindex="${cell.key === tabKey ? '0' : '-1'}"`,
      `aria-label="${esc(usageHeatCellLabel(cell))}"`,
    ].filter(Boolean).join(' ');
    return `<div ${attrs}></div>`;
  }).join('');
  const gridLabel = `按日用量热力图,${model.weeks} 周,周一为第一行;方向键逐日查看,点击或聚焦查看数值`;
  if (root.setAttribute) root.setAttribute('aria-label', gridLabel);
  // 外层两列网格让星期标签与日历共用同一套行高;月份与格子同列,天然对齐。
  const layout = '<div class="heatmap-layout" style="display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:8px;row-gap:4px">'
    + '<span aria-hidden="true"></span>'
    + `<div class="heatmap-months" aria-hidden="true" style="grid-auto-columns:minmax(9px,1fr)">${months}</div>`
    + `<div class="heatmap-weekdays" aria-hidden="true">${weekdays}</div>`
    + `<div class="heatmap-grid" style="grid-auto-columns:minmax(9px,1fr)">${cells}</div>`
    + '</div>';

  // 图例:外壳已有就用它的色阶,只补文字说明;否则在热力图里自建一份。
  const host = usageLegendHost();
  let legend = '';
  if (host) {
    const extra = usageLegendExtra(host);
    if (extra) extra.innerHTML = usageLegendNotes(model).map(note => `<span class="heatmap-legend-label">${esc(note)}</span>`).join('');
  } else {
    legend = usageHeatLegend(model, metricLabel);
  }
  root.innerHTML = layout + legend;

  // 键盘读数时重画会把焦点冲掉:把焦点还给同一个日期。
  if (usageState.heatFocus && usageState.heatDate && root.querySelector) {
    const element = root.querySelector(`[data-date="${usageState.heatDate}"]`);
    if (element && element.focus) element.focus();
  }
  if (usageState.heatDate) usageShowHeatDate(usageState.heatDate);
}

function usageRenderHeatSummary(model, data) {
  const summary = $('usage-calendar-summary');
  const metric = USAGE_METRIC_LABELS[usageState.metric] || usageState.metric;
  if (summary) {
    const windowLabel = model.weeks === USAGE_WEEK_COUNT ? '最近 53 周' : `已展开 ${model.weeks} 周`;
    const totals = (data && data.totals) || {};
    const totalText = usageNum(totals.reqs) === null
      ? ''
      : ` · 共 ${usageInt(totals.reqs)} 次请求 · ${usageTok(totals.tokens_total)} tokens`;
    summary.textContent = `${windowLabel} · ${model.gridStartKey} – ${model.gridEndKey} · 窗口内 ${model.activeDays} 天,其中 ${model.daysWithReqs} 天有请求${totalText} · 按 ${metric} 着色`;
  }
  const expand = $('usage-calendar-expand');
  if (expand) {
    const capped = usageState.heatExpanded >= USAGE_MAX_EXPAND;
    expand.hidden = !model.hasEarlier;
    expand.disabled = !model.hasEarlier || capped;
    if (model.hasEarlier && capped) expand.textContent = '已展开到上限';
    else if (model.hasEarlier) expand.textContent = '查看更早的 53 周';
  }
}

// 更早的 53 周块:只在统计区间确实伸到当前块之前时才出现。
function expandUsageCalendar() {
  if (!usageState.data) return;
  const model = usageState.heatModel || usageHeatModel(usageState.data);
  if (!model.hasEarlier || usageState.heatExpanded >= USAGE_MAX_EXPAND) return;
  usageState.heatExpanded += 1;
  usageRenderHeat(usageState.data);
}

// ---- 热力图的表格等价物(按日) -------------------------------------------
function usageFindChild(node, tag) {
  const children = node && node.children ? node.children : [];
  for (const child of children) if (child && String(child.tagName || '').toLowerCase() === tag) return child;
  return null;
}
function usageEnsureDailyTable() {
  if (usageState.dailyRefs) return usageState.dailyRefs;
  let body = $('usage-daily-rows');
  let details = $('usage-daily-details');
  let summary = null;
  if (!body) {
    const holder = $('usage-chart-holder');
    const host = (holder && holder.parentNode) || holder;
    if (!host || !document.createElement) return null;
    details = document.createElement('details');
    details.className = 'usage-trend-table';
    details.id = 'usage-daily-details';
    summary = document.createElement('summary');
    summary.textContent = '按日查看数据';
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    const table = document.createElement('table');
    const head = document.createElement('thead');
    head.innerHTML = `<tr>${['日期', '请求', '新增输入', '输出', '缓存读取', '合计 tokens'].map(text => `<th scope="col">${text}</th>`).join('')}</tr>`;
    body = document.createElement('tbody');
    body.id = 'usage-daily-rows';
    table.appendChild(head);
    table.appendChild(body);
    wrap.appendChild(table);
    details.appendChild(summary);
    details.appendChild(wrap);
    host.appendChild(details);
  }
  if (!summary && details) summary = usageFindChild(details, 'summary');
  usageState.dailyRefs = { details, summary, body };
  return usageState.dailyRefs;
}
function usageRenderDailyTable(model) {
  const refs = usageEnsureDailyTable();
  if (!refs || !refs.body) return;
  const days = model.cells.filter(cell => cell.active && cell.covered);
  if (refs.details) refs.details.hidden = days.length === 0;
  if (refs.summary) refs.summary.textContent = `按日查看数据(共 ${days.length} 天)`;
  refs.body.innerHTML = days.map(cell => `<tr><td>${cell.key}</td><td>${usageInt(cell.reqs)}</td>`
    + `<td>${usageTok(cell.tokens_in)}</td><td>${usageTok(cell.tokens_out)}</td>`
    + `<td>${usageTok(cell.cache_read)}</td><td>${usageTok(cell.tokens)}</td></tr>`).join('');
}

// ---- 浮层与键盘读数 -------------------------------------------------------
function usageTipElement() {
  let tip = $('usage-chart-tooltip');
  if (tip) return tip;
  const holder = $('usage-chart-holder');
  if (!holder) return null;
  tip = holder.querySelector ? holder.querySelector('.chart-tip') : null;
  if (!tip && holder.appendChild && document.createElement) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.id = 'usage-chart-tooltip';
    tip.hidden = true;
    holder.appendChild(tip);
  }
  return tip;
}
function usageHideTip() {
  const tip = usageTipElement();
  if (tip) tip.hidden = true;
}
// 播报区放在 holder 里,而不是会被 innerHTML 重建的 #usage-heatmap 里。
function usageEnsureHeatLive() {
  if (usageState.heatLive) return usageState.heatLive;
  let live = $('usage-heatmap-live');
  if (!live) {
    const holder = $('usage-chart-holder');
    if (!holder || !document.createElement || !holder.appendChild) return null;
    live = document.createElement('p');
    live.className = 'sr-only';
    live.id = 'usage-heatmap-live';
    live.setAttribute('aria-live', 'polite');
    holder.appendChild(live);
  }
  usageState.heatLive = live;
  return live;
}
function usagePositionTip(tip, element) {
  const holder = $('usage-chart-holder');
  if (!tip || !holder || !element || typeof element.getBoundingClientRect !== 'function') return;
  if (typeof holder.getBoundingClientRect !== 'function') return;
  const holderBox = holder.getBoundingClientRect();
  const cellBox = element.getBoundingClientRect();
  const width = Math.min(tip.offsetWidth || 200, Math.max(0, holderBox.width - 16));
  const center = cellBox.left - holderBox.left + cellBox.width / 2;
  const left = Math.min(Math.max(8, center - width / 2), Math.max(8, holderBox.width - width - 8));
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(Math.max(8, cellBox.top - holderBox.top - 34)) + 'px';
}
function usageShowHeatDate(key, options = {}) {
  const model = usageState.heatModel;
  if (!model || !key || !model.byKey.has(key)) return null;
  const cell = model.byKey.get(key);
  usageState.heatDate = key;
  const tip = usageTipElement();
  if (tip) {
    tip.hidden = false;
    tip.textContent = usageHeatCellText(cell); // 日志内容只当文字,不进 innerHTML
    const root = $('usage-heatmap');
    const element = options.element || (root && root.querySelector ? root.querySelector(`[data-date="${key}"]`) : null);
    if (element) usagePositionTip(tip, element);
  }
  if (options.announce) {
    const live = usageEnsureHeatLive();
    if (live) live.textContent = usageHeatCellText(cell);
  }
  return cell;
}
// 漫游 tabindex:同一时刻只有一格是 Tab 停靠点,方向键在格间移动。
function usageHeatRoving(key) {
  const root = $('usage-heatmap');
  if (!root || !root.querySelectorAll) return;
  const cells = root.querySelectorAll('.heatmap-cell');
  if (!cells) return;
  Array.from(cells).forEach(element => {
    if (element && element.getAttribute && element.setAttribute) {
      element.setAttribute('tabindex', element.getAttribute('data-date') === key ? '0' : '-1');
    }
  });
}
function usageHeatCellOf(event) {
  let node = event && event.target;
  for (let guard = 0; node && guard < 8; guard += 1) {
    if (node.dataset && node.dataset.date) return node;
    node = node.parentNode;
  }
  return null;
}
function usageHeatPointer(event) {
  const cell = usageHeatCellOf(event);
  if (!cell) return;
  usageState.heatKeyMode = false;
  usageShowHeatDate(cell.dataset.date, { element: cell });
}
function usageHeatLeave() {
  // 方向键正在读时,鼠标移出去不该把读数关掉;指针自己打开的浮层则跟着指针收起。
  if (usageState.heatFocus && usageState.heatKeyMode) return;
  usageState.heatDate = null;
  usageHideTip();
}
function usageHeatFocusIn(event) {
  usageState.heatFocus = true;
  const cell = usageHeatCellOf(event);
  if (cell) usageShowHeatDate(cell.dataset.date, { element: cell });
}
function usageHeatFocusOut(event) {
  // 焦点在日历内部从一格移到另一格时也会冒泡出 focusout;那不是"离开热力图"。
  const root = $('usage-heatmap');
  const next = event && event.relatedTarget;
  if (next && root && typeof root.contains === 'function' && root.contains(next)) {
    usageState.heatFocus = true;
    return;
  }
  usageState.heatFocus = false;
  usageState.heatKeyMode = false;
  usageState.heatDate = null;
  usageHideTip();
}
// 左右 = 前后一周,上下 = 前后一天,Home/End = 块首尾,Esc 收起。
function usageHeatKey(event) {
  const model = usageState.heatModel;
  if (!model || !event) return;
  const key = event.key;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape'].includes(key)) return;
  if (event.preventDefault) event.preventDefault();
  usageState.heatFocus = true;
  usageState.heatKeyMode = true;
  if (key === 'Escape') {
    usageState.heatDate = null;
    usageHideTip();
    return;
  }
  const fromKey = usageState.heatDate || model.tabKey || model.gridStartKey;
  const fromDate = usageDayDate(fromKey) || model.gridEnd;
  let next;
  if (key === 'Home') next = model.cells[0].key;
  else if (key === 'End') next = model.cells[model.cells.length - 1].key;
  else {
    const delta = key === 'ArrowLeft' ? -7 : key === 'ArrowRight' ? 7 : key === 'ArrowUp' ? -1 : 1;
    next = usageDayKey(usageAddDays(fromDate, delta));
  }
  if (!model.byKey.has(next)) next = fromKey; // 到边界就停住,不越界
  const root = $('usage-heatmap');
  const element = root && root.querySelector ? root.querySelector(`[data-date="${next}"]`) : null;
  usageShowHeatDate(next, { announce: true, element });
  usageHeatRoving(next);
  if (element && element.focus) element.focus();
}

// ---- 明细表:请求 / 供应商 / 模型 ------------------------------------------
function usageRecordStatus(row) {
  const status = usageNum(row.status);
  const errorText = row.err || row.err_class || '';
  if (!errorText && status !== null && status >= 200 && status < 400) return '<span class="badge on">成功</span>';
  if (errorText || (status !== null && (status === 0 || status >= 400))) {
    const code = status !== null && status > 0 ? ` ${status}` : '';
    const why = errorText ? ` · ${esc(String(errorText).slice(0, 60))}` : '';
    return `<span class="badge off" style="color:var(--err-text)">失败${code}${why}</span>`;
  }
  return '—';
}
// 时间按浏览器本地时间显示(日志 ts 是 UTC)。
function usageStamp(value) {
  const ms = Date.parse(String(value == null ? '' : value));
  if (!Number.isFinite(ms)) return value ? esc(String(value)) : '—';
  const date = new Date(ms);
  return `${usagePad(date.getMonth() + 1)}-${usagePad(date.getDate())} ${usagePad(date.getHours())}:${usagePad(date.getMinutes())}:${usagePad(date.getSeconds())}`;
}
function usageRecordSpeed(row) {
  const ms = usageNum(row.ms);
  const out = usageNum(row.out);
  if (ms === null || ms <= 0 || out === null) return '—';
  return Math.round(out / (ms / 1000)).toLocaleString('en-US') + ' tok/s';
}
function usageRecordRow(row) {
  const modelOut = typeof row.model_out === 'string' ? row.model_out : '';
  const modelIn = typeof row.model_in === 'string' ? row.model_in : '';
  const primary = modelOut || modelIn;
  // model_out 是实际生效的模型;别名只在两者不同时以次要样式附在后面。
  const modelCell = primary
    ? esc(primary) + (modelOut && modelIn && modelOut !== modelIn
      ? ` <span class="muted model-alias" title="日志里的原始模型名 ${esc(modelIn)}">别名 ${esc(modelIn)}</span>` : '')
    : '—';
  return `<tr><td>${usageStamp(row.ts)}</td><td>${esc(USAGE_APP_LABELS[row.app] || row.app || '—')}</td>`
    + `<td>${esc(row.provider || '—')}</td><td>${modelCell}</td>`
    + `<td>${usageTok(row.in)}</td><td>${usageTok(row.out)}</td><td>${usageTok(row.cache_read)}</td>`
    + `<td>${usageRecordStatus(row)}</td><td>${usageRecordSpeed(row)}</td>`
    + `<td title="上游响应头到达时间;不是模型首个输出 token 的时间">${usageMs(row.ttfb_ms)}</td></tr>`;
}
function usageAggregateRow(kind, row) {
  const cacheRead = usageNum(row.cache_read) || 0;
  const denom = (usageNum(row.tokens_in) || 0) + cacheRead;
  const hit = denom ? (cacheRead / denom * 100).toFixed(1) + '%' : '—';
  const name = kind === 'providers' ? (row.name || row.provider || '—') : (row.model || '—');
  return `<tr><td>${esc(name)}</td><td>${usageInt(row.reqs)}</td>`
    + `<td>${usageTok(row.tokens_in)}</td><td>${usageTok(row.tokens_out)}</td>`
    + `<td>${usageTok(row.cache_read)}</td><td>${hit}</td></tr>`;
}
function usageDetailSlice(data) {
  const tab = usageState.tab;
  const columns = USAGE_DETAIL_HEAD[tab] || USAGE_DETAIL_HEAD.requests;
  if (tab === 'requests') {
    const records = (data && data.dashboard && data.dashboard.records) || null;
    const rows = records && Array.isArray(records.rows) ? records.rows : [];
    return { tab, columns, rows, total: records ? (usageNum(records.total) || 0) : null, available: !!records };
  }
  const list = tab === 'providers' ? data.by_provider : data.by_model;
  const all = Array.isArray(list) ? list : [];
  const pages = Math.max(1, Math.ceil(all.length / usageState.limit));
  usageState.pageAgg = Math.min(usageState.pageAgg, pages - 1);
  const start = usageState.pageAgg * usageState.limit;
  return { tab, columns, rows: all.slice(start, start + usageState.limit), total: all.length, available: true };
}
function usageRenderDetail(data) {
  const head = $('usage-table-head');
  const body = $('usage-rows');
  const count = $('usage-count');
  const slice = usageDetailSlice(data);
  if (head) head.innerHTML = `<tr>${slice.columns.map(text => `<th scope="col">${text}</th>`).join('')}</tr>`;
  const unit = slice.tab === 'requests' ? '条请求' : slice.tab === 'providers' ? '个供应商' : '个模型';
  if (count) {
    count.textContent = slice.available
      ? `共 ${usageInt(slice.total)} ${unit},${slice.tab === 'requests' ? '按时间倒序。' : '按请求数降序。'}`
      : '服务端没有返回明细数据。';
  }
  if (!body) return;
  if (!slice.available) {
    body.innerHTML = `<tr><td colspan="${slice.columns.length}">当前服务端未返回请求明细(需要 dashboard 数据)。</td></tr>`;
    return;
  }
  if (!slice.rows.length) {
    body.innerHTML = `<tr><td colspan="${slice.columns.length}">当前筛选下没有记录。调整区间或筛选条件再试。</td></tr>`;
    return;
  }
  body.innerHTML = slice.rows.map(row => (slice.tab === 'requests' ? usageRecordRow(row) : usageAggregateRow(slice.tab, row))).join('');
}
function usageRenderPagination(data) {
  const prev = $('usage-prev');
  const next = $('usage-next');
  const label = $('usage-page-label');
  const slice = usageDetailSlice(data);
  const total = slice.total === null ? 0 : slice.total;
  const pages = Math.max(1, Math.ceil(total / usageState.limit));
  let page;
  if (slice.tab === 'requests') {
    const offset = usageNum(data && data.dashboard && data.dashboard.records && data.dashboard.records.offset);
    page = Math.floor((offset === null ? usageState.offset : offset) / usageState.limit) + 1;
  } else {
    page = usageState.pageAgg + 1;
  }
  page = Math.min(Math.max(1, page), pages);
  const unit = slice.tab === 'requests' ? '条请求' : slice.tab === 'providers' ? '个供应商' : '个模型';
  if (label) label.textContent = `第 ${page} / ${pages} 页 · 共 ${usageInt(total)} ${unit}`;
  if (prev) prev.disabled = page <= 1;
  if (next) next.disabled = page >= pages;
}

// 数据来源说明:来源、当前可用日志范围、口径。first_ts/last_ts 是**观察到的**边界,
// 不是保留期承诺;范围外是未知,不能算成 0。这里要把这层区别写清楚。
function usageRenderSource(data) {
  const el = $('usage-source-detail');
  if (!el) return;
  const scope = (data && data.scope) || {};
  const coverage = (data && data.dashboard && data.dashboard.coverage) || {};
  const first = usageLocalDayKey(coverage.first_ts);
  const last = usageLocalDayKey(coverage.last_ts);
  const today = usageDayKey(new Date());
  const lines = [
    `数据来源:${usageSourceLabel(data)}。区间内的数字来自本机请求日志(logs/requests.jsonl 及轮转归档),并补入尚未落盘的内存窗口。`,
    `统计区间:${usageLocalDayKey(scope.from) || '—'} – ${usageLocalDayKey(scope.to) || '—'}(${scope.timezone || '本地时区'})。`,
    first && last
      ? `当前可用日志:最早一条记录 ${first},最新一条 ${last}。这是日志里实际观察到的最早/最晚记录,既不是完整保留期,也不保证中间没有断档;每天读取都会扫到当前时刻,所以 ${last} 之后到今天(${today})没有记录的日子按「没有请求」计算,而 ${first} 之前的日期显示为「未覆盖」,不会算成 0。`
      : '当前可用日志:数据源里暂时没有任何请求日志;热力图所有日期显示为「未覆盖」,而不是零用量。',
    '协议组按日志的 app 字段(Anthropic / OpenAI);供应商与模型为精确匹配。状态按日志的成功判定:err / err_class 优先于状态码。',
    'Tokens 合计 = 新增输入 + 输出 + 缓存读取;缓存命中率 = 缓存读取 / (新增输入 + 缓存读取)。页面不折算金额。',
    '首响应 = 上游响应头到达的时间(ttfb_ms),不是模型首个输出 token 的时间;两者不能互相替代。',
  ];
  el.innerHTML = lines.map(line => `<p>${esc(line)}</p>`).join('');
}

// ---- 生命周期 -------------------------------------------------------------
document.addEventListener('visibilitychange', () => {
  // 从后台切回来立即刷新一次:轮询在隐藏期间是跳过的,回来时数字可能已经过时。
  if (document.visibilityState === 'visible' && usageState.visible && usageState.inited) loadUsage();
});
document.addEventListener('DOMContentLoaded', () => {
  const root = $('usage-heatmap') || $('usage-chart-holder');
  if (!root || !root.addEventListener) return;
  // 指针 / 触摸 / 键盘三种输入共用同一套读数。
  root.addEventListener('pointerover', usageHeatPointer);
  root.addEventListener('pointerleave', usageHeatLeave);
  root.addEventListener('click', usageHeatPointer);
  root.addEventListener('keydown', usageHeatKey);
  root.addEventListener('focusin', usageHeatFocusIn);
  root.addEventListener('focusout', usageHeatFocusOut);
});
