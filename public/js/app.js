'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const APPS = { claude: { label: 'Claude Code', cfg: '~/.claude/settings.json' }, codex: { label: 'Codex', cfg: '~/.codex/config.toml' } };
const GROUPS = { claude: 'Claude / Anthropic', codex: 'Codex / OpenAI' };
let state = null, view = 'overview', curApp = 'claude', editing = null, editingGroup = 'claude', keyDraft = [];
let testResults = {}, logsTimer = null;
// 模型测活结果按渠道 id 存:renderProviders 每 5 秒整块重绘卡片,DOM 里的结果一重绘就没了,
// 状态必须放在模块级变量里才能活过轮询(和 testResults 是同一个道理)。
let modelProbe = {};
let compactDraft = null, compactBase = '', compactDirty = false, compactRevision = 0, compactCustom = false, savingCompact = false;
// 最近一次压缩保存的"四段结果"。这四件事**各自独立**,把它们揉成一句"已生效"是本页以前最
// 容易误导人的地方:请求成功了不等于配置落了盘,落了盘不等于运行中的服务用上了,服务用上了
// 也不等于旧客户端会话跟着变。所以分开存、分开显示。
//   saved    —— 这次请求本身成功返回
//   written  —— 服务端把配置写进了磁盘(压缩规则的存储)
//   loaded   —— 运行中的服务已经按新配置分发(压缩是服务端路由,不重载进程)
//   restart  —— 客户端要不要重开(压缩不需要;窗口需要新开会话)
let compactOutcome = null;
let windowSnapshot = null, windowDirty = false, windowRevision = 0, windowSelectionRevision = 0, savingWindow = false, windowLoadTask = null;
// 窗口保存的四段结果。这里的真假与压缩模型**不一样**,照抄那句话就会骗人:
// 窗口写的是磁盘上的客户端配置,服务端进程从不热读它,所以"服务已加载"永远不成立,
// 而"客户端需重开(新开会话)"是**必须**的一步。
let windowOutcome = null;
let online = false, lastSync = null, refreshTask = null, activeDialog = null, returnFocus = null, confirmResolve = null, savingProvider = false;
let loadedUiRevision = null;
// 概览的日志聚合独立于 5 秒状态轮询；读失败保留上次的趋势与数字。
let overviewUsage = null, overviewUsageTask = null, overviewUsageAttempt = 0, overviewUsageSync = null, overviewUsageError = '', overviewUsageDay = '';
let codexSlotRevision = 0;
let codexModeDraft = 'direct';
let codexDirectEdit = '', codexDirectValue = '', savingCodexDirect = false, codexDirectMessage = '';
let codexCompactDraft = null, codexCompactEditRevision = 0, savingCodexCompact = false, codexCompactLoadTask = null, codexCompactLoadSequence = 0;
let codexCompactError = '', codexCompactMessage = '', codexCompactStateRevision = 0, codexCompactReadError = '';
// /api/health 的最近一次只读快照(渠道页的可用性徽标与设置页共用)。它是**独立**的一次
// fetch:读失败只让徽标与设置页那一块显示"未读取",绝不阻断 /api/state 的整页刷新。
let liveHealth = null, healthError = '', healthTask = null;
const providerGroup = () => curApp;
const providers = (group = providerGroup()) => state?.providers?.[group] || [];
const allProviders = () => [...providers('claude'), ...providers('codex')];
const handlerArg = value => esc(JSON.stringify(String(value))); // Escape both the JS string and its HTML attribute.
// 会话下拉的 DOM id 必须由**完整 key** 推出来:短 id 只有 8 位,两个不同会话会撞同一个短 id
// (实测 cx:01a178e0-… 与 cx:01a178e0-… 就是),用短 id 拼 id 会让 for/id 指错行。
// 编码要可逆唯一:凡是 [A-Za-z0-9-] 之外的字符都换成 "_<codePoint 的 16 进制>_"。下划线
// 本身也必须被编码(成 _5f_),否则 "_3a_" 既可能来自冒号也可能来自原样的下划线,两个键就
// 会生成同一个 id;这样编码后产物一定是合法 HTML id,且不同 key 必然得到不同 id。
const domIdOf = value => 'session-' + String(value ?? '').replace(/[^A-Za-z0-9-]/g,
  ch => '_' + ch.codePointAt(0).toString(16) + '_');

async function api(path, opt = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), path.includes('/test') ? 65000 : 12000);
  try {
    const r = await fetch(path, { ...opt, headers: { 'Content-Type': 'application/json', ...opt.headers }, signal: controller.signal, cache: 'no-store' });
    const j = await r.json();
    if (!r.ok) { const error = new Error(j.error || `HTTP ${r.status}`); error.status = r.status; throw error; }
    return j;
  } finally { clearTimeout(timer); }
}
function toast(msg, cls = '') {
  const t = $('toast'); t.textContent = msg; t.className = cls; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', msg.length > 65 ? 10000 : 4500);
}
// 备份保留池轮换这类"操作成功、但有东西被清出池了"的结果。既不能塞进 ok 里让人以为万事大吉,
// 也不该用 err 吓人(配置确实写成功了)。停留时间放宽:池满时这条会带上好几个文件名。
function warnToast(msg) {
  const t = $('toast'); t.textContent = msg; t.className = 'warn'; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 12000);
}
// 写入配置的接口会把备份池轮换一并带回来(mixrouter.js 的 backupWithWatch → 响应体 warnings)。
// 有轮换就把那句话并进同一条提示再显示,而不是单独再弹一条——同一个 #toast 只能显示一条,
// 后弹的会把"已写入配置"顶掉,用户看到的就是"操作失败了"。
function toastWithBackupWarnings(okMsg, res) {
  const w = res && Array.isArray(res.warnings) ? res.warnings : [];
  if (w.length) warnToast(`${okMsg}\n${w.join('\n')}`);
  else toast(okMsg, 'ok');
}
// ---- 全站数字格式(概览、侧栏、诊断、会话共用;同一个数在不同页面必须长得一样) ----
// 没有这个数(null / '' / NaN)一律「—」;真正的 0 才写 0。数字与单位之间不加空格。
const finiteOrNull = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
// Tokens:<1000 写整数;之后 K/M/B 保留 3 位有效数字(1.23K / 12.3K / 123K / 886M / 9.59B)。
// 进位到 1000 时升一档,不写成「1000K」。
const fmtTok = v => {
  const n = finiteOrNull(v);
  if (n === null) return '—';
  if (Math.abs(n) < 1000) return String(Math.round(n));
  let i = 0, x = n;
  while (Math.abs(x) >= 1000 && i < 3) { x /= 1000; i++; }
  if (Math.abs(Number(x.toPrecision(3))) >= 1000 && i < 3) { x /= 1000; i++; }
  // B 是最高一档:再大就写整数,不让 toPrecision 吐出「1.00e+3B」。
  const t = x.toPrecision(3);
  return (t.includes('e') ? String(Math.round(x)) : t) + ['', 'K', 'M', 'B'][i];
};
const fmtCount = v => { const n = finiteOrNull(v); return n === null ? '—' : Math.round(n).toLocaleString('en-US'); };
// 百分比(入参 0–100)保留一位;非 0 但不到 0.1 写「<0.1%」,差一点到 100 写「>99.9%」(缓存命中常见),
// 整 0 / 整百不带小数。
const fmtPct = v => {
  const n = finiteOrNull(v);
  if (n === null) return '—';
  if (n === 0 || n === 100) return n + '%';
  if (n > 0 && n < 0.1) return '<0.1%';
  if (n >= 99.95 && n < 100) return '>99.9%';
  return n.toFixed(1) + '%';
};
// 字节按 1024 进制:512B / 12.3KB / 1.2MB / 3.4GB;KB 起一律一位小数。
// 和 fmtTok 一样,四舍五入到 1024 就进到下一档:1048064 写 1.0MB,不写 1024KB。
const fmtBytes = v => {
  const n = finiteOrNull(v);
  if (n === null) return '—';
  if (n < 1023.5) return Math.round(n) + 'B';
  let i = 0, x = n;
  while (x >= 1023.5 && i < 3) { x /= 1024; i++; }
  return x.toFixed(1) + ['B', 'KB', 'MB', 'GB'][i];
};
// 时延:840ms / 1.2s / 1m05s / 1h 00m(满 1 小时与 fmtUp 同写法)。0 与负数是「没测到」,不拿 0 冒充极快。
// 首响应耗时(ttfb_ms)= 上游响应头到达的时间,不是首个 token。
// 函数体必须自给自足:用量页测试只从本文件抽 fmtRate / fmtTtfb 两段定义来跑,引用别的顶层名会 ReferenceError。
const fmtTtfb = v => {
  const ms = v === null || v === undefined || v === '' ? NaN : Number(v);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 999.5) return Math.round(ms) + 'ms';
  if (ms < 59950) return (ms / 1000).toFixed(1) + 's';
  const s = Math.round(ms / 1000);
  if (s < 3600) return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m`;
};
const fmtDur = fmtTtfb;
// 单条请求的派生指标。分母为 0 / 没测到一律显示「—」,不拿 0 冒充「极快」或「没命中」。
const fmtRate = l => {
  const out = Number(l.out), ms = Number(l.ms);
  if (!Number.isFinite(out) || !Number.isFinite(ms) || ms <= 0 || !out) return '—';
  const tps = out * 1000 / ms;
  return (tps >= 100 ? Math.round(tps) : tps.toFixed(1)) + 'tok/s';
};
// 缓存读没记录是「—」,记录为 0 才写 0;命中率 = 缓存读 / (缓存读 + 新输入)。
const cacheHitText = l => {
  const read = finiteOrNull(l.cache_read), input = finiteOrNull(l.in) || 0;
  if (read === null || !(read + input)) return '—';
  return `${fmtTok(read)} · ${fmtPct(read * 100 / (read + input))}`;
};
// 运行时长只给两级:45s / 21m 54s / 3h 12m / 2d 4h。小时档分钟补零(1h 00m),与 fmtDur 满 1 小时的写法一致。
const fmtUp = v => {
  const n = finiteOrNull(v);
  if (n === null) return '—';
  const s = Math.max(0, Math.floor(n));
  if (s < 60) return s + 's';
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h`;
};
// 时间点:今天 HH:mm:ss,今年 MM-DD HH:mm,更早 YYYY-MM-DD;完整时间用 fmtFullTime 放 title。
const fmtFullTime = t => {
  const d = t instanceof Date ? t : new Date(t);
  if (t == null || t === '' || Number.isNaN(d.getTime())) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const fmtWhen = t => {
  const full = fmtFullTime(t);
  if (full === '—') return full;
  const d = t instanceof Date ? t : new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return full.slice(11);
  return d.getFullYear() === now.getFullYear() ? full.slice(5, 16) : full.slice(0, 10);
};
// 「今日请求」来自 /api/state 的 stats(本地日历日)。exact === true 才是全天精确数;否则计数从 since
// (ISO,服务启动或日志可读的起点)开始,没有 since 就只覆盖本次运行。不是全天时数字照常显示,
// 旁边注明起点,title 写清不是全天、全天总数去哪看。
function todayView(stats) {
  const since = stats.since ? new Date(stats.since) : null;
  const sinceOk = !!since && !Number.isNaN(since.getTime());
  // 起点在今天写 HH:mm,跨天(服务从昨天跑到今天、日志起点更早)写 MM-DD HH:mm。
  const hm = !sinceOk ? '' : since.toDateString() === new Date().toDateString() ? fmtFullTime(since).slice(11, 16) : fmtFullTime(since).slice(5, 16);
  const scope = stats.exact === true ? '' : hm ? `自 ${hm} 起` : '本次运行';
  return {
    reqs: fmtCount(stats.reqs), scope,
    reqsTitle: stats.exact === true ? '今天（本地日历日）全天的请求数'
      : `不是全天计数：只统计${hm ? ' ' + fmtFullTime(since) + ' 之后' : '本次运行以来'}的请求，今天更早的请求不在内；全天总数看「用量统计」`,
    inTok: fmtTok(stats.inTok), outTok: fmtTok(stats.outTok),
    tokNote: scope ? `；${scope}，不是全天` : '',
  };
}

// Dialogs share Escape, focus containment and restoration, including destructive confirmations.
function showDialog(id, focusId) {
  if (activeDialog) return;
  returnFocus = document.activeElement;
  activeDialog = $(id);
  activeDialog.classList.add('show');
  $('sidebar').inert = true; $('workspace').inert = true;
  document.body.style.overflow = 'hidden';
  $(focusId).focus();
}
function hideDialog() {
  if (!activeDialog) return;
  activeDialog.classList.remove('show'); activeDialog = null;
  $('sidebar').inert = false; $('workspace').inert = false;
  document.body.style.overflow = '';
  const target = returnFocus?.isConnected ? returnFocus : $('tab-' + curApp);
  target.focus(); returnFocus = null;
}
function askConfirm(title, message, action = '确认') {
  if (activeDialog) return Promise.resolve(false);
  $('confirm-title').textContent = title; $('confirm-text').textContent = message; $('confirm-ok').textContent = action;
  return new Promise(resolve => { confirmResolve = resolve; showDialog('confirm-mask', 'confirm-cancel'); });
}
function finishConfirm(result) { const resolve = confirmResolve; confirmResolve = null; hideDialog(); if (resolve) resolve(result); }
document.addEventListener('keydown', e => {
  if (!activeDialog) return;
  if (e.key === 'Escape') { e.preventDefault(); if (confirmResolve) finishConfirm(false); else if (activeDialog.id === 'routing-mask') closeRoutingModal(); else closeModal(); return; }
  if (e.key !== 'Tab') return;
  const items = [...activeDialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length);
  const first = items[0], last = items[items.length - 1];
  if (!first) { e.preventDefault(); activeDialog.querySelector('.modal').focus(); }
  else if (e.shiftKey && (document.activeElement === first || !items.includes(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !items.includes(document.activeElement))) { e.preventDefault(); first.focus(); }
});
document.addEventListener('focusin', e => {
  if (activeDialog && !activeDialog.contains(e.target)) activeDialog.querySelector('.modal').focus();
});
// 模型发现的请求入口(地址/Key/协议/直连)一变:在途响应作废,已取到的候选也清掉,需重新获取。
for (const id of ['m-base', 'm-key', 'm-wire', 'm-wire-claude', 'm-direct']) {
  for (const event of ['input', 'change']) $(id)?.addEventListener(event, () => invalidateDiscovery());
}
// 「直连上游」与「出站代理」互斥:前者是退出隧道,后者是强制走隧道,同时给服务端只能回 400。
// 这里只在两样都填上时提醒一句,不替用户清空任何一边——清哪边都等于替他决定这条渠道走直连还是走代理。
$('m-direct')?.addEventListener('change', () => {
  if ($('m-direct').checked && $('m-proxy-url').value.trim()) toast('填写出站代理时，请取消「绕过出站代理」', 'err');
});

function setConnection(connected, error = '') {
  const changed = online !== connected;
  online = connected; document.body.dataset.connection = connected ? 'online' : 'offline';
  // 焦点在表格里时轮询不会重绘;只更新禁用状态,保留当前输入和展开行。
  $('sess-body').querySelectorAll('.pin-sel, .sess-config, .sess-acts .danger').forEach(control => {
    control.disabled = !connected;
  });
  $('connection-label').textContent = connected ? '控制台已连接' : '控制台离线';
  $('connection-banner').classList.toggle('show', !connected);
  // 浏览器给的网络错误是英文内部文案(Failed to fetch / Load failed / AbortError):主文案换成人话,原文进 title。
  // 服务端自己的中文说明(如「状态数据不完整」)原样当主文案;HTTP 码、JSON 解析错误这类只进 title。
  const reason = !error ? '' : /failed to fetch|networkerror|load failed/i.test(error) ? '连不上本机服务' : /abort/i.test(error) ? '请求超时'
    : /[一-鿿]/.test(error) ? error : '状态读取失败';
  $('connection-message').textContent = connected ? '' : `控制台离线${reason ? '：' + reason : ''}。${lastSync ? '数据停在 ' + fmtWhen(lastSync) + ' 的最后快照，运行时长和指标不再更新' : '尚无可用快照'}；每 5 秒自动重试，压缩草稿仍保留。`;
  $('connection-message').setAttribute('title', !connected && error ? (lastSync ? fmtFullTime(lastSync) + ' · ' : '') + error : '');
  $('new-provider').disabled = !state;
  // 缺渠道或模型名时保存必被拦下,按钮直接禁用,不让人点了才看到报错;草稿与上次载入一致时也没有可保存的(和 #save-window 同一口径)。
  $('save-compact').disabled = !connected || !state?.compact || savingCompact || !compactDraft?.provider || !compactDraft.model?.trim()
    || compactUnchanged();
  $('save-window').disabled = !connected || !windowSnapshot || !windowDirty || savingWindow || !!windowLoadTask;
  // 会话覆盖弹窗:离线、没读到服务端版本、或正在保存时,三扇门都封掉
  if (typeof updateRoutingButtons === 'function') updateRoutingButtons();
  renderCodexCompact();
  if (typeof renderBotsModels === 'function') renderBotsModels();
  if (connected && view === 'providers' && typeof loadBotsModels === 'function') loadBotsModels(false);
  // 诊断与方案页在首次进入时可能还没连上 /api/state:连接恢复后补一次初始读取。
  // 两个模块各自用 loaded/loading 去重,不会因此变成轮询。
  if (changed && typeof insightsUpdateControls === 'function') insightsUpdateControls();
  if (changed && typeof profilesRender === 'function') profilesRender();
  if (connected && view === 'insights' && typeof insightsSetVisible === 'function') insightsSetVisible(true);
  if (connected && view === 'profiles' && typeof profilesSetVisible === 'function') profilesSetVisible(true);
  if (changed && state) renderSlots(true);
}
function renderOverview() {
  const stats = state.stats || {}, today = todayView(stats);
  $('ver').textContent = state.version ?? '—';
  // 端口与进程号是标识符,不加千分位。计数用千分位,tokens 用缩写并把完整数字放 title。
  $('st-proxy').textContent = state.proxy_port ?? '—'; $('st-ui').textContent = state.ui_port ?? '—';
  $('st-up').textContent = fmtUp(state.uptime_s);
  $('st-req').textContent = today.reqs; $('st-req').setAttribute('title', today.reqsTitle);
  $('st-req-scope').textContent = today.scope;
  $('st-tok').textContent = today.inTok + ' / ' + today.outTok;
  $('st-tok').setAttribute('title', `输入 ${fmtCount(stats.inTok)} / 输出 ${fmtCount(stats.outTok)}${today.tokNote}`);
  for (const app of Object.keys(APPS)) {
    const count = providers(app).length;
    $('count-' + app).textContent = count;
    $('tab-' + app).setAttribute('aria-label', `${APPS[app].label}，${count} 个渠道`);
  }
}
// 侧栏两个客户端入口的状态点:实心 = 已写入配置,空心环 = 还没接。只读 liveFacts,不另判一套。
// 提示放在链接上而不是那个 aria-hidden 的点上——点对读屏是不可见的,提示挂那里等于没有。
function syncClientDots() {
  for (const link of document.querySelectorAll('nav a[data-app]')) {
    const f = liveFacts(link.dataset.app);
    const configured = !!(f.healthy && f.lv?.base_url);
    link.dataset.conn = configured ? 'on' : 'off';
    link.setAttribute('title', configured ? '已写入客户端配置' : '尚未接入客户端');
  }
}
// Polling updates status only: editors keep their draft DOM, never rebuilt by refresh.
function refresh() {
  if (refreshTask) return refreshTask;
  // 本机一次读取通常几十毫秒:立刻禁用会让顶栏按钮每 5 秒闪一下。超过 300ms 才进入「刷新中…」。
  const btn = $('refresh-btn'); let idleLabel = null;
  const busy = setTimeout(() => { idleLabel = btn.textContent; btn.disabled = true; btn.textContent = '刷新中…'; }, 300);
  const codexRevision = codexSlotRevision;
  refreshTask = (async () => {
    try {
      const next = await api('/api/state');
      if (!next.providers || !next.current || !next.live) throw new Error('状态数据不完整');
      // 轮询若早于刚完成的热更新,保留 PUT 返回的 Codex 状态,下轮再读最新快照。
      if (state && codexRevision !== codexSlotRevision) {
        if (state.slots) next.slots = { ...next.slots, codex: state.slots.codex };
        next.live.codex = state.live.codex;
      }
      // 首次非空修订是本页已加载的基线;后续变化只提示,不自动刷新或打断草稿。
      const uiRevision = typeof next.ui_revision === 'string' ? next.ui_revision.trim() : '';
      if (uiRevision && loadedUiRevision === null) loadedUiRevision = uiRevision;
      $('ui-update-banner').classList.toggle('show', !!uiRevision && uiRevision !== loadedUiRevision);
      state = next; lastSync = new Date();
      if (state.compact && !compactDraft) loadCompactDraft();
      renderCompactCurrent(); renderCompactKeys();
      renderOverview(); setConnection(true); updateCompactStatus(); renderSlots();
      // 概览在 setConnection 之后渲染:客户端状态那三行要读 online(liveFacts 的口径),
      // 早一步渲染就会把一次成功的刷新说成"待确认"。
      renderOverviewPage();
      loadOverviewUsage();
      if (view === 'providers') renderProviders();
      reconcileRouting();
      // 5 秒轮询不得打断正在编辑的用户。会话页的可编辑控件有两处:表格里的绑定下拉,以及表格外的搜索框。
      // 只挡 sess-body 是不够的 —— 搜索框在表格外拿焦点时,这里照样会重渲染,把用户敲了一半的词抹掉
      // (sessQuery 是顶层草稿,重渲染会按它回填)。所以搜索框有焦点时同样不重渲染。
      const editingSession = $('sess-body').contains(document.activeElement) || document.activeElement === $('sess-search');
      if (view === 'sessions' && !activeDialog && !editingSession) renderSessions();
      return true;
    } catch (e) {
      setConnection(false, e.message);
      // 离线时概览与渠道页都要重画:它们显示的"客户端接入状态"按 online 判断,
      // 不重画就会留着上一份快照说"已写入配置",而连接横幅同时在说离线。
      renderOverviewPage(); renderSlots();
      if (view === 'providers') renderProviders();
      // 会话表的「配置 Key / 槽位」「解绑」和绑定下拉按 online 禁用,离线时同样要重画一次;编辑守卫与上面相同。
      const editingSession = $('sess-body').contains(document.activeElement) || document.activeElement === $('sess-search');
      if (view === 'sessions' && !activeDialog && !editingSession) renderSessions();
      return false;
    }
    finally {
      clearTimeout(busy); refreshTask = null;
      btn.disabled = false; if (idleLabel !== null) btn.textContent = idleLabel;
    }
  })();
  return refreshTask;
}
const VIEWS = ['overview', 'usage', 'providers', 'compact', 'sessions', 'diagnostics', 'settings', 'insights', 'profiles'];
const VIEW_LABELS = { overview: '概览', usage: '用量统计', providers: '渠道与 Key', compact: '压缩设置', sessions: '会话', diagnostics: '诊断', settings: '设置与备份', insights: '模型与上下文', profiles: '模型方案' };
// 切视图只有这一条路径。原先 nav 的 onclick 里写着全部逻辑,gotoLogs() 只能去"点"那个 <a>
// ——视图一改名,选择器返回 null,.click() 就当场抛 TypeError(会话页的「日志」按钮变成死按钮,
// 而且没有任何提示)。抽成函数后,程序化切换不再依赖导航项是否存在。
function syncViewNav() {
  document.querySelectorAll('nav a').forEach(x => {
    const on = x.dataset.view === view && (!x.dataset.app || x.dataset.app === curApp);
    x.classList.toggle('active', on);
    if (on) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
  });
}
function showView(name) {
  if (!VIEWS.includes(name)) return;
  view = name;
  syncViewNav();
  // 少一个视图节不该把整个切换炸掉(拿不到就跳过),但它必须是"看得见的少",不是静默错位。
  for (const v of VIEWS) { const el = $('view-' + v); if (el) el.style.display = v === view ? '' : 'none'; }
  $('breadcrumb-view').textContent = VIEW_LABELS[view];
  if (view === 'diagnostics') { loadLogs(); loadStats(); restartLogsTimer(); } else { clearInterval(logsTimer); logsTimer = null; }
  // 用量页自己管轮询与在途请求:离开时停表,回来时立刻拉一次(切页不重复初始化筛选)。
  if (typeof usageSetVisible === 'function') usageSetVisible(view === 'usage');
  if (view === 'usage' && typeof renderUsage === 'function') renderUsage();
  // 模型诊断与模型方案只在进入本页时补一次初始读取,之后靠各自页内的手动刷新;
  // 没有轮询,也不会在别的页面后台拉取。模块不存在时(例如只加载 app.js 的测试)直接跳过。
  if (typeof insightsSetVisible === 'function') insightsSetVisible(view === 'insights');
  if (typeof profilesSetVisible === 'function') profilesSetVisible(view === 'profiles');
  if (view === 'providers') {
    renderProviders(); ensureHealth();
    if (typeof loadBotsModels === 'function') loadBotsModels(false);
  }
  if (view === 'sessions') renderSessions();
  // 压缩页进入时才去读磁盘窗口(默认「用户全局」层);已读过且有草稿时不重读,免得覆盖草稿。
  if (view === 'compact' && !windowSnapshot && !windowLoadTask) loadCompactWindow();
  // 设置页的四条只读读取按页面进入时机触发,且各自独立失败:
  // 健康端点挂了不会连累备份清点,反之也一样(每个 load* 自带 try/catch)。
  if (view === 'settings') {
    if (!backupsLoaded) loadBackups();
    ensureHealth();
    // **不自动跑预览**:模型名留空时服务端按契约回 503 "暂无可用落点",浏览器会把这条 503
    // 记成一条控制台错误 —— 每次进设置页都刷一条,看着像页面坏了,其实只是"还没填模型"。
    // 预览本来就是"按你填的模型预测落点",没有模型就没有可解释的东西;交给下面的「解释一次」
    // 按钮与输入框回车(两者都调 loadPreview),用户想看图就点一下。
  }
  // 外壳(URL / 抽屉)是可选的:没有 workspace 模块时这里什么都不做,默认视图仍是概览。
  if (typeof workspaceViewChanged === 'function') {
    try { workspaceViewChanged(view); } catch (e) { console.error(e); }
  }
  refresh();
}
// 健康快照按需读取一次。渠道卡片与设置页都要它,两处共用同一个入口 —— 每次切视图都再打一遍
// 没有意义;而在 renderProviders 里读会更糟,那是 5 秒轮询调用的。
// 读失败不会重试到天荒地老:liveHealth 仍是 null、healthTask 已清空,下次用户切页时才再试一次。
function ensureHealth() {
  if (liveHealth || healthTask) return healthTask;
  healthTask = Promise.resolve(loadHealth()).finally(() => { healthTask = null; });
  return healthTask;
}
document.querySelectorAll('nav a').forEach(a => a.onclick = e => {
  e.preventDefault();
  // 外壳一次性更新视图与客户端,避免一次点击写入两条中间 URL 历史。
  if (typeof window.workspaceNavigate === 'function') {
    try { window.workspaceNavigate(a.dataset.view, a.dataset.app); return; } catch (err) { console.error(err); }
  }
  if (a.dataset.app) setApp(a.dataset.app);
  showView(a.dataset.view);
});
function setApp(app) {
  if (!APPS[app]) return;
  curApp = app;
  syncViewNav();
  for (const key of Object.keys(APPS)) { const tab = $('tab-' + key); tab.classList.toggle('active', key === app); tab.setAttribute('aria-selected', String(key === app)); tab.tabIndex = key === app ? 0 : -1; }
  $('agent-panel').setAttribute('aria-labelledby', 'tab-' + app);
  renderProviders(); renderSlots();
  if (typeof loadBotsModels === 'function') loadBotsModels(false);
  if (typeof workspaceAppChanged === 'function') {
    try { workspaceAppChanged(app); } catch (e) { console.error(e); }
  }
}
document.querySelector('.apptabs').addEventListener('keydown', e => {
  const keys = Object.keys(APPS); let i = keys.indexOf(curApp);
  if (e.key === 'ArrowRight') i = (i + 1) % keys.length;
  else if (e.key === 'ArrowLeft') i = (i + keys.length - 1) % keys.length;
  else if (e.key === 'Home') i = 0; else if (e.key === 'End') i = keys.length - 1; else return;
  e.preventDefault(); setApp(keys[i]); $('tab-' + keys[i]).focus();
});

// ---------------- 概览(只读) ----------------
// 这一页刻意**不放任何可写控件**:规划要求"每项配置只有一个主要编辑入口",概览只负责
// 把"现在什么样"和"你要动手做什么"摆出来,每条事项给一个跳到对应页的按钮。
// 客户端与会话来自 /api/state；今日用量与两条小时趋势来自 /api/usage，概览可见时最多每分钟读取。
function overviewJump(view, text) {
  // 跳转按钮只调视图切换,绝不发写请求(它连 api() 都不碰)。
  return `<button class="small" data-jump="${esc(view)}" onclick="showView(${handlerArg(view)})">${esc(text)}</button>`;
}
// 「需处理事项」清单。每一条都必须对应一个用户真能动手的状态,且能跳到管它的那一页;
// 没有事项时明确写出来——留空白会让人以为还没加载出来。
// 一条 = 一句人话标题 + 一行次级明细(渠道名 / 槽位;内部 id 用 mono 小字跟在后面)。
// 会让请求失败的排前面并标成 err,主动停用的只是提醒(warn)。
function overviewTodo() {
  const items = [];
  const ps = allProviders();
  const disabledProviders = ps.filter(p => p.enabled === false);
  const disabledKeys = ps.flatMap(p => (p.keys || []).filter(k => k.enabled === false).map(k => ({ provider: p, key: k })));
  // 槽位里的僵尸引用:槽位指向已删除的渠道。命中即失败,用户得在界面上看得见、能跳去改。
  const ghosts = ghostSlotRefs();
  // 会话里引用已失效的渠道 / Key:面板里 routingStaleOf() 已能逐条算,这里只给总数。服务端会拒掉这类覆盖。
  let staleSessions = 0;
  for (const s of state.sessions || []) if (routingStaleOf(groupOfSession(s), s.routing).length) staleSessions++;
  // 明细的每一段:label 是人话,id 是原始值(可选)。纯文本进 title,HTML 版把 id 画成 mono 小字。
  const detail = parts => ({
    text: parts.map(p => p.id && p.id !== p.label ? `${p.label}（${p.id}）` : p.label).join('、'),
    html: parts.map(p => esc(p.label) + (p.id && p.id !== p.label ? ` <span class="mono">${esc(p.id)}</span>` : '')).join('、'),
  });

  if (ghosts.length) items.push({ level: 'err', title: '槽位里有失效引用，请求会失败', detail: detail(ghosts.map(g => ({ label: `${g.app} · ${g.slot}`, id: g.provider }))), view: 'providers', action: '去渠道与 Key' });
  if (staleSessions) items.push({ level: 'err', title: `${staleSessions} 个会话的 Key / 槽位覆盖里存在已失效的引用`, view: 'sessions', action: '去会话' });
  if (disabledProviders.length) items.push({ level: 'warn', title: `${disabledProviders.length} 个渠道已停用`, detail: detail(disabledProviders.map(p => ({ label: p.name }))), view: 'providers', action: '去渠道与 Key' });
  if (disabledKeys.length) items.push({ level: 'warn', title: `${disabledKeys.length} 把 Key 已停用`, detail: detail(disabledKeys.map(({ provider, key }) => ({ label: `${provider.name} · ${key.label || key.id}`, id: key.id }))), view: 'providers', action: '去渠道与 Key' });

  if (!items.length) return '<p class="ov-ok" id="overview-todo-empty">没有需要处理的事项。</p>';
  return `<ul class="ov-todo" id="overview-todo-list">${items.map(it => `<li data-level="${it.level}"><div class="ov-todo-text"><b>${esc(it.title)}</b>${it.detail ? `<span class="ov-todo-detail" title="${esc(it.detail.text)}">${it.detail.html}</span>` : ''}</div>${overviewJump(it.view, it.action)}</li>`).join('')}</ul>`;
}
// 槽位的僵尸引用:槽位表里指向已删除渠道的条目。只读复算,不改任何状态。
function ghostSlotRefs() {
  const out = [];
  for (const app of Object.keys(APPS)) {
    for (const s of state?.slots?.[app] || []) {
      if (s.provider && !providers(app).some(p => p.id === s.provider)) out.push({ app: APPS[app].label, slot: s.name, provider: s.provider });
    }
  }
  return out;
}
function renderOverviewPage() {
  // 只写变了的块:轮询每 5 秒重画一次,内容没变还整块替换会收起展开的端点清单、丢掉按钮焦点。
  const paint = (id, html) => { const el = $(id); if (el._html !== html) { el.innerHTML = html; el._html = html; } };
  if (!state) {
    // 从没读到过状态(首次连接就失败):说清楚在等什么,不让「读取中」一直挂着。
    for (const id of ['overview-todo', 'overview-clients', 'overview-endpoints']) paint(id, '<p class="hint">还没有读到服务状态，连接恢复后自动显示。</p>');
    for (const id of ['ov-revision', 'ov-pid', 'ov-tokens', 'ov-cooldowns']) $(id).textContent = '—';
    renderOverviewUsage();
    return;
  }
  const stats = state.stats || {};
  $('ov-version').textContent = state.version ?? '—';
  // 源码修订只显示前 12 位,全长给 title:截短是为了不撑破卡片,能核对才是它存在的意义。
  // 用 setAttribute(而不是 .title=)是为了与假 DOM 一致——两者在真实浏览器里等价。
  const rev = state.code_revision || '';
  $('ov-revision').textContent = '修订 ' + (rev ? rev.slice(0, 12) : '—');
  $('ov-revision').setAttribute('title', rev);
  $('ov-uptime').textContent = fmtUp(state.uptime_s);
  $('ov-uptime').setAttribute('title', lastSync && state.uptime_s != null ? '启动于 ' + fmtFullTime(lastSync.getTime() - state.uptime_s * 1000) : '');
  // 端口、进程号是标识符,不加千分位;全称放 title。
  const port = p => (p == null ? '—' : ':' + p);
  $('ov-pid').textContent = `PID ${state.pid || '—'} · ${port(state.proxy_port)} / ${port(state.ui_port)}`;
  $('ov-pid').setAttribute('title', `进程 ${state.pid || '未提供'} · 代理端口 ${state.proxy_port ?? '—'} · 控制台端口 ${state.ui_port ?? '—'}`);
  const today = todayView(stats);
  $('ov-reqs').textContent = today.reqs; $('ov-reqs').setAttribute('title', today.reqsTitle);
  $('ov-reqs-scope').textContent = today.scope;
  $('ov-tokens').textContent = `新增输入 ${today.inTok} / 输出 ${today.outTok}`;
  $('ov-tokens').setAttribute('title', `新增输入 ${fmtCount(stats.inTok)} / 输出 ${fmtCount(stats.outTok)} tokens${today.tokNote}`);
  const stateTokens = finiteOrNull(stats.inTok) === null || finiteOrNull(stats.outTok) === null ? null : Number(stats.inTok) + Number(stats.outTok);
  $('ov-token-total').textContent = fmtTok(stateTokens);
  $('ov-token-total').setAttribute('title', `新增输入与输出 ${fmtCount(stateTokens)}；缓存读取等待日志聚合${today.tokNote}`);
  // 会话按协议组归组(不是按客户端):直接给两组各几个,原来这里是冷却功能删掉后留下的固定句子。
  const sessions = state.sessions;
  $('ov-sessions').textContent = fmtCount(sessions?.length);
  $('ov-sessions').setAttribute('title', `当前进程内存里保留的会话，含已保存绑定；不是进行中的请求数。${state.session_ttl_min ? '自动绑定的空闲保留时间 ' + fmtCount(state.session_ttl_min) + ' 分钟。' : ''}`);
  const codexSessions = (sessions || []).filter(s => groupOfSession(s) === 'codex').length;
  $('ov-cooldowns').textContent = sessions ? `Anthropic ${sessions.length - codexSessions} · OpenAI ${codexSessions}` : '—';
  $('ov-cooldowns').setAttribute('title', `按协议组归组，不按客户端：${GROUPS.claude} / ${GROUPS.codex}`);

  const todo = overviewTodo();
  paint('overview-todo', todo);
  // 没有事项时把整块收成一条状态行(样式按 data-state),有事项才展开成卡片。
  const todoPanel = $('overview-todo-panel');
  if (todoPanel) todoPanel.dataset.state = todo.includes('overview-todo-list') ? 'active' : 'clear';

  // 两张客户端卡仍共用 liveFacts。展示的是磁盘配置与槽位目标，绝不把它说成请求实际落点。
  const WIRE_NAMES = { responses: 'Responses API', chat: 'Chat Completions', anthropic: 'Anthropic Messages' };
  paint('overview-clients', Object.keys(APPS).map(app => {
    const f = liveFacts(app), configured = !!(f.healthy && f.lv?.base_url);
    const raw = f.lv?.wire_api || '';
    const wire = raw ? `<span class="ov-state" title="wire_api = ${esc(raw)}">${esc(WIRE_NAMES[raw] || raw)}</span>` : '';
    const model = f.slot?.model || f.lv?.model || '未配置';
    const modelTitle = f.slot ? `客户端配置 ${f.lv.model}；槽位目标 ${model}，不是请求实际落点` : '客户端磁盘配置的模型：' + model;
    const addr = f.direct && f.lv?.base_url ? `<span class="mono ov-addr" title="${esc(f.lv.base_url)}">${esc(f.lv.base_url)}</span>` : '';
    const stateText = f.stateLabel !== f.mode ? `<span class="ov-state" title="${esc(f.lv?.error || APPS[app].cfg)}">${esc(f.stateLabel)}</span>` : '';
    const connect = online && !configured;
    const glyph = app === 'claude' ? '<rect x="2.5" y="3" width="13" height="5" rx="1.5"/><rect x="2.5" y="10" width="13" height="5" rx="1.5"/><path d="M5.5 5.5h.01M5.5 12.5h.01"/>' : '<path d="M3 5.5 9 3l6 2.5v7L9 15l-6-2.5z"/><path d="M3 5.5 9 8l6-2.5M9 8v7"/>';
    return `<div class="ov-row ov-client-card" data-app="${app}"><div class="ov-client-head ov-row-main">
      <span class="ov-client-emblem" aria-hidden="true"><svg viewBox="0 0 18 18" focusable="false">${glyph}</svg></span><div class="ov-row-name">${esc(APPS[app].label)}</div>
      <span class="badge badge-dot ${configured ? 'on' : 'off'}">${esc(f.mode)}</span><button class="ov-goto" type="button" data-app="${app}" onclick="${connect ? 'overviewGoConnect' : 'overviewOpenClient'}(${handlerArg(app)})" aria-label="${esc(APPS[app].label)} ${connect ? '去接入' : '查看渠道'}">${connect ? '去接入' : '查看渠道'}</button></div>
      <dl class="ov-client-facts"><div><dt>当前渠道</dt><dd title="${esc(f.configuredName)}">${esc(f.configuredName)}</dd></div><div><dt>${f.slot ? '槽位目标模型' : '配置模型'}</dt><dd class="ov-client-model" title="${esc(modelTitle)}">${esc(model)}</dd></div></dl>
      <div class="ov-client-foot">${stateText}${wire}${addr}<span class="mono ov-cfg sr-only" title="${esc(APPS[app].cfg)}">${esc(APPS[app].cfg)}</span></div></div>`;
  }).join(''));

  // 接入地址 = "我在哪里填什么"。缺 base 时退回 url(与 routerBase 同口径)。
  // 完整端点清单默认收起:两行基址已经回答了「填什么」,这里只是备查。
  const r = state.router || {};
  const endpoints = [...new Set(Array.isArray(r.endpoints) ? r.endpoints : [])];
  paint('overview-endpoints', [
    ['Claude Code / Anthropic', r.claude_base || r.url || ''],
    ['Codex / OpenAI', r.codex_base || r.url || ''],
  ].map(([label, value]) => `<div class="ov-row"><div class="ov-row-name">${esc(label)}</div>${value ? `<div class="mono">${esc(value)}</div>` : '<div class="ov-state" title="服务端没有返回这个地址">—</div>'}</div>`).join('')
    + (endpoints.length ? `<details class="ov-endpoints-more"><summary>全部端点（${endpoints.length}）</summary><div class="ov-endpoint-list">${endpoints.map(esc).join('<br>')}</div></details>` : ''));

  // 接入向导入口只在还有客户端没写入配置时露面;两个都接好了就没必要占首屏。
  const ready = $('readiness-overview');
  if (ready) ready.hidden = Object.keys(APPS).every(app => { const f = liveFacts(app); return !!(f.healthy && f.lv?.base_url); });
  // 侧栏状态点与这里同源(都读 liveFacts),必须排在 setConnection 之后,
  // 否则一次成功的刷新会先把点画成「未接入」。
  syncClientDots();
  renderOverviewUsage();
}
// 客户端卡的入口只切页面；配置控件仍只在渠道页出现。
function overviewOpenClient(app) {
  const target = APPS[app] ? app : 'claude';
  if (typeof window.workspaceNavigate === 'function') {
    try { window.workspaceNavigate('providers', target); } catch (e) { console.error(e); }
  } else {
    if (typeof setApp === 'function') setApp(target);
    if (typeof showView === 'function') showView('providers');
  }
}
// 「去接入」再把焦点交给向导入口；已配置客户端的「查看渠道」不展开或聚焦向导。
function overviewGoConnect(app) {
  overviewOpenClient(app);
  const entry = document.getElementById('readiness-open');
  if (entry && typeof entry.focus === 'function') entry.focus();
}

function loadOverviewUsage() {
  if (view !== 'overview' || document.hidden || !online) return overviewUsageTask;
  if (overviewUsageTask || (overviewUsageAttempt && Date.now() - overviewUsageAttempt < 60000)) return overviewUsageTask;
  overviewUsageAttempt = Date.now();
  overviewUsageTask = (async () => {
    try {
      // dashboard=1 选择最终状态口径；limit 只缩小明细，不改变 totals 或小时 series。
      const data = await api('/api/usage?range=today&bucket=hour&dashboard=1&limit=1');
      const fields = ['reqs', 'tokens_in', 'tokens_out', 'cache_read'];
      if (!data.totals || !Array.isArray(data.series) || fields.some(k => finiteOrNull(data.totals[k]) === null)
        || data.series.some(row => !/^\d{4}-\d{2}-\d{2}T\d{2}:00/.test(row.t) || fields.some(k => finiteOrNull(row[k]) === null))) {
        throw new Error('小时用量数据不完整');
      }
      overviewUsage = { ...data, series: data.series.slice().sort((a, b) => a.t.localeCompare(b.t)) };
      overviewUsageSync = new Date(); overviewUsageDay = fmtFullTime(overviewUsageSync).slice(0, 10); overviewUsageError = '';
      renderOverviewUsage();
      return true;
    } catch (e) {
      overviewUsageError = e.message;
      renderOverviewUsage();
      return false;
    } finally { overviewUsageTask = null; renderOverviewUsage(); }
  })();
  renderOverviewUsage();
  return overviewUsageTask;
}

function renderOverviewUsage() {
  const status = $('ov-usage-status');
  const stale = !!overviewUsage && (!online || !!overviewUsageError || Date.now() - overviewUsageSync.getTime() > 75000
    || overviewUsageDay !== fmtFullTime(new Date()).slice(0, 10));
  for (const id of ['ov-metric-reqs', 'ov-metric-tokens', 'ov-metric-success']) $(id).dataset.stale = String(stale);
  status.classList.toggle('stale', stale || !!overviewUsageError);
  status.setAttribute('title', [overviewUsageSync && '用量同步于 ' + fmtFullTime(overviewUsageSync), overviewUsageError].filter(Boolean).join('；'));
  if (!overviewUsage) {
    $('ov-success').textContent = '—';
    $('ov-success-note').textContent = overviewUsageError ? '日志用量未读取' : '等待读取请求结果';
    const scope = state ? todayView(state.stats || {}).scope : '';
    status.textContent = (overviewUsageError ? '今日用量读取失败；每分钟自动重试' : '正在读取今日用量…') + (scope ? `；请求${scope}，不是全天` : '');
    return;
  }
  const t = overviewUsage.totals, source = overviewUsage.scope?.source === 'memory' ? '内存窗口' : '本机日志';
  const tokenTotal = Number(t.tokens_in) + Number(t.tokens_out) + Number(t.cache_read);
  $('ov-reqs').textContent = fmtCount(t.reqs);
  $('ov-reqs').setAttribute('title', `今天（本地日历日）当前可用${source}的请求数；用量快照 ${fmtFullTime(overviewUsageSync)}`);
  $('ov-reqs-scope').textContent = source === '内存窗口' ? source : '';
  $('ov-token-total').textContent = fmtTok(tokenTotal);
  $('ov-token-total').setAttribute('title', `新增输入 ${fmtCount(t.tokens_in)} / 输出 ${fmtCount(t.tokens_out)} / 缓存读取 ${fmtCount(t.cache_read)}；合计 ${fmtCount(tokenTotal)} Tokens`);
  $('ov-tokens').textContent = `新增输入 ${fmtTok(t.tokens_in)} / 输出 ${fmtTok(t.tokens_out)} / 缓存读取 ${fmtTok(t.cache_read)}`;
  $('ov-tokens').setAttribute('title', $('ov-token-total').getAttribute('title'));
  $('ov-success').textContent = fmtPct(t.ok_rate);
  $('ov-success').setAttribute('title', '按今日请求最终状态计算；HTTP 200 的断流与客户端取消仍计为失败，不代表上游连通性。');
  $('ov-success-note').textContent = Number(t.reqs) ? `今日 ${fmtCount(t.reqs)} 次请求` : '今日暂无请求';
  status.textContent = stale ? `用量数据过期，保留 ${fmtWhen(overviewUsageSync)} 快照；每分钟自动重试`
    : overviewUsageTask ? '今日用量更新中…' : `${source} · 用量同步 ${fmtWhen(overviewUsageSync)}`;
  renderOverviewTrend('ov-req-trend', overviewUsage.series, 'reqs');
  renderOverviewTrend('ov-token-trend', overviewUsage.series, 'tokens');
  const rows = overviewUsage.series.map(row => `<tr><th scope="row">${esc(row.t.slice(11, 16))}</th><td class="num">${fmtCount(row.reqs)}</td><td class="num">${fmtCount(row.tokens_in)}</td><td class="num">${fmtCount(row.tokens_out)}</td><td class="num">${fmtCount(row.cache_read)}</td><td class="num">${fmtCount(Number(row.tokens_in) + Number(row.tokens_out) + Number(row.cache_read))}</td></tr>`).join('')
    || '<tr><td colspan="6">今日暂无小时数据</td></tr>';
  const table = $('ov-hourly-rows');
  if (table._html !== rows) { table.innerHTML = rows; table._html = rows; }
}

// 两个小图各画自己的量级，零基线不变；成功率和会话没有小时历史，不生成曲线。
function renderOverviewTrend(id, series, metric) {
  const el = $(id);
  const points = series.map(row => ({ t: row.t, value: metric === 'reqs' ? Number(row.reqs)
    : Number(row.tokens_in) + Number(row.tokens_out) + Number(row.cache_read) }));
  const key = JSON.stringify(points);
  if (el._plotKey === key) return;
  el._plotKey = key; el._points = points; el._metric = metric; el.dataset.hover = 'false';
  if (!points.length) { el.innerHTML = '<span class="ov-data-status">今日暂无小时数据</span>'; return; }
  const max = Math.max(1, ...points.map(p => p.value));
  points.forEach((p, i) => { p.x = points.length === 1 ? 110 : 5 + i * 210 / (points.length - 1); p.y = 29 - p.value * 23 / max; });
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' '), last = points[points.length - 1];
  const unit = metric === 'reqs' ? '请求' : 'Tokens';
  el.innerHTML = `<svg viewBox="0 0 220 34" preserveAspectRatio="none" role="img" aria-label="今日每小时${unit}，从零开始"><line class="ov-trend-baseline" x1="0" y1="29" x2="220" y2="29"/><path class="ov-trend-area" d="${path} L${last.x.toFixed(2)},29 L${points[0].x.toFixed(2)},29 Z"/><path class="ov-trend-line" d="${path}"/><line class="ov-trend-crosshair" x1="${last.x}" y1="2" x2="${last.x}" y2="31"/><circle class="ov-trend-dot" cx="${last.x}" cy="${last.y}" r="4"/></svg>
    <div class="ov-trend-axis"><span>${esc(points[0].t.slice(11, 16))}</span><span>${esc(last.t.slice(11, 16))}</span></div><span class="ov-trend-tip" role="tooltip"></span>`;
  el._pointIndex = points.length - 1;
  el.setAttribute('aria-label', `今日每小时${unit}，零基线；最近 ${last.t.slice(11, 16)}：${fmtCount(last.value)} ${unit}。左右方向键查看；下方有小时数据表。`);
}
function overviewInspectTrend(id, index) {
  const el = $(id), points = el._points || [];
  if (!points.length) return;
  const i = Math.max(0, Math.min(points.length - 1, index)), p = points[i];
  el._pointIndex = i; el.dataset.hover = 'true';
  const cross = el.querySelector('.ov-trend-crosshair'), dot = el.querySelector('.ov-trend-dot'), tip = el.querySelector('.ov-trend-tip');
  cross.setAttribute('x1', p.x); cross.setAttribute('x2', p.x);
  dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y);
  const text = `${p.t.slice(11, 16)} · ${fmtCount(p.value)}${el._metric === 'reqs' ? ' 次请求' : ' Tokens'}`;
  tip.textContent = text;
  el.setAttribute('aria-label', text + '；左右方向键查看，下方有小时数据表。');
}
for (const id of ['ov-req-trend', 'ov-token-trend']) {
  const el = $(id);
  el.addEventListener('pointermove', e => {
    if (!el._points?.length) return;
    const box = el.getBoundingClientRect(), x = (e.clientX - box.left) / box.width;
    overviewInspectTrend(id, Math.round(x * (el._points.length - 1)));
  });
  el.addEventListener('focus', () => overviewInspectTrend(id, el._pointIndex));
  el.addEventListener('keydown', e => {
    if (!el._points?.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    overviewInspectTrend(id, e.key === 'Home' ? 0 : e.key === 'End' ? el._points.length - 1 : el._pointIndex + (e.key === 'ArrowRight' ? 1 : -1));
  });
  const clear = () => { if (el._points?.length) overviewInspectTrend(id, el._points.length - 1); el.dataset.hover = 'false'; };
  el.addEventListener('pointerleave', clear); el.addEventListener('blur', clear);
}
