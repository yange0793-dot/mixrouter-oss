'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const APPS = { claude: { label: 'Claude Code', cfg: '~/.claude/settings.json' }, codex: { label: 'Codex', cfg: '~/.codex/config.toml' }, zcode: { label: 'ZCode', cfg: '~/.zcode/v2/config.json' } };
const GROUPS = { claude: 'Claude / Anthropic', codex: 'Codex / OpenAI' };
const ZCODE_HELP = '保存后在 ZCode 模型选择器选择 Mixrouter · ...；如未出现请重启客户端，新会话生效';
let state = null, view = 'overview', curApp = 'claude', zcodeWire = 'anthropic', editing = null, editingGroup = 'claude', keyDraft = [];
let routesDraft = null, routesBase = '', routesBaseRevision = '', routesDirty = false, routesRevision = 0, testResults = {}, logsTimer = null;
let compactDraft = null, compactBase = '', compactDirty = false, compactRevision = 0, compactCustom = false, savingCompact = false;
// 最近一次压缩保存的"四段结果"。这四件事**各自独立**,把它们揉成一句"已生效"是本页以前最
// 容易误导人的地方:请求成功了不等于配置落了盘,落了盘不等于运行中的服务用上了,服务用上了
// 也不等于旧客户端会话跟着变。所以分开存、分开显示。
//   saved    —— 这次请求本身成功返回
//   written  —— 服务端把配置写进了磁盘(routes.json)
//   loaded   —— 运行中的服务已经按新配置分发(压缩是服务端路由,不重载进程)
//   restart  —— 客户端要不要重开(压缩不需要;窗口需要新开会话)
let compactOutcome = null;
let windowSnapshot = null, windowDirty = false, windowRevision = 0, windowSelectionRevision = 0, savingWindow = false, windowLoadTask = null;
// 窗口保存的四段结果。这里的真假与压缩模型**不一样**,照抄那句话就会骗人:
// 窗口写的是磁盘上的客户端配置,服务端进程从不热读它,所以"服务已加载"永远不成立,
// 而"客户端需重开(新开会话)"是**必须**的一步。
let windowOutcome = null;
let online = false, lastSync = null, refreshTask = null, activeDialog = null, returnFocus = null, confirmResolve = null, savingProvider = false;
// /api/health 的最近一次只读快照(渠道页的冷却/可用性徽标与设置页共用)。它是**独立**的一次
// fetch:读失败只让徽标与设置页那一块显示"未读取",绝不阻断 /api/state 的整页刷新。
let liveHealth = null, healthError = '', healthTask = null;
const providerGroup = () => curApp === 'zcode' ? (zcodeWire === 'anthropic' ? 'claude' : 'codex') : curApp;
const providers = (group = providerGroup()) => state?.providers?.[group] || [];
const allProviders = () => [...providers('claude'), ...providers('codex')];
const zcodeSupported = () => !!state?.live && Object.hasOwn(state.live, 'zcode') && Object.hasOwn(state.current || {}, 'zcode');
const handlerArg = value => esc(JSON.stringify(String(value))); // Escape both the JS string and its HTML attribute.

async function api(path, opt = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), path.includes('/test') ? 65000 : 12000);
  try {
    const r = await fetch(path, { ...opt, headers: { 'Content-Type': 'application/json', ...opt.headers }, signal: controller.signal, cache: 'no-store' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
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
const fmtTok = n => n == null ? '—' : n >= 1000000 ? (n / 1000000).toFixed(1) + 'm' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
const fmtBytes = n => !n ? '-' : n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : n >= 1024 ? Math.round(n / 1024) + 'KB' : n + 'B';
// 单条请求的派生指标。分母为 0 / 没测到一律显示「—」,不拿 0 冒充「极快」或「没命中」。
const fmtRate = l => {
  const out = Number(l.out), ms = Number(l.ms);
  if (!Number.isFinite(out) || !Number.isFinite(ms) || ms <= 0 || !out) return '—';
  const tps = out * 1000 / ms;
  return (tps >= 100 ? Math.round(tps) : tps.toFixed(1)) + ' tok/s';
};
// 首字延迟:上游第一个字节到达的耗时(流式与非流式都记)。
const fmtTtfb = ms => Number(ms) > 0 ? (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms') : '—';
const cacheHitText = l => {
  const read = Number(l.cache_read) || 0, input = Number(l.in) || 0;
  if (!read && !input) return '—';
  const pct = read * 100 / (read + input);
  return `${l.cache_read || '-'}${input || read ? ' · ' + pct.toFixed(1) + '%' : ''}`;
};
const fmtUp = s => s == null ? '—' : s >= 3600 ? (s/3600).toFixed(1) + 'h' : s >= 60 ? Math.floor(s/60) + 'm' + Math.floor(s%60) + 's' : s + 's';

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

function setConnection(connected, error = '') {
  online = connected; document.body.dataset.connection = connected ? 'online' : 'offline';
  $('connection-label').textContent = connected ? '控制台已连接' : '控制台离线';
  $('connection-banner').classList.toggle('show', !connected);
  $('connection-message').textContent = connected ? '' : `无法获取实时状态${error ? '：' + error : ''}。${lastSync ? '当前为 ' + lastSync.toLocaleTimeString('zh-CN', { hour12: false }) + ' 的最后快照，运行时长和指标已停止更新。' : '尚无可用快照。'}每 5 秒自动重试；路由草稿仍保留。`;
  $('new-provider').disabled = !state;
  $('save-routes').disabled = !connected || !routesDraft || savingRoutes || savingCompact || compactDirty;
  $('save-compact').disabled = !connected || !state?.compact || savingCompact || savingRoutes || routesDirty;
  $('save-window').disabled = !connected || !windowSnapshot || !windowDirty || savingWindow || !!windowLoadTask;
  $('add-rule').disabled = !routesDraft;
  // 会话覆盖弹窗:离线、没读到服务端版本、或正在保存时,三扇门都封掉
  if (typeof updateRoutingButtons === 'function') updateRoutingButtons();
}
function renderOverview() {
  const ps = allProviders(), stats = state.stats || {};
  $('ver').textContent = state.version ?? '—';
  $('st-proxy').textContent = state.proxy_port ?? '—'; $('st-ui').textContent = state.ui_port ?? '—';
  $('st-up').textContent = fmtUp(state.uptime_s); $('st-req').textContent = stats.reqs ?? '—';
  $('st-tok').textContent = fmtTok(stats.inTok) + ' / ' + fmtTok(stats.outTok);
  $('metric-providers').textContent = ps.filter(p => p.enabled).length;
  $('metric-providers-hint').textContent = `共 ${ps.length} 个渠道 · 启用不代表连通`;
  $('metric-requests').textContent = fmtTok(stats.reqs);
  $('metric-tokens').textContent = stats.inTok == null || stats.outTok == null ? '—' : fmtTok(stats.inTok + stats.outTok);
  $('metric-tokens-hint').textContent = `输入 ${fmtTok(stats.inTok)} / 输出 ${fmtTok(stats.outTok)}`;
  $('metric-sessions').textContent = state.sessions?.length ?? '—';
  $('metric-sessions-hint').textContent = `${state.cooldowns?.length ?? 0} 个渠道冷却中 · 按协议归组`;
  for (const app of Object.keys(APPS)) {
    const count = app === 'zcode' ? ps.length : providers(app).length;
    $('count-' + app).textContent = count;
    $('tab-' + app).setAttribute('aria-label', `${APPS[app].label}，${count} 个${app === 'zcode' ? '共享' : ''}渠道`);
  }
}
// Polling updates status only: route editor DOM is initialized once, never rebuilt by refresh.
function refresh() {
  if (refreshTask) return refreshTask;
  $('refresh-btn').disabled = true;
  refreshTask = (async () => {
    try {
      const next = await api('/api/state');
      if (!next.providers || !next.routes || !next.current || !next.live) throw new Error('状态数据不完整');
      state = next; lastSync = new Date();
      if (!routesDraft) { routesDraft = structuredClone(state.routes); routesBase = JSON.stringify(state.routes); routesBaseRevision = state.routes_revision || ''; renderRoutes(); }
      if (state.compact && !compactDraft) loadCompactDraft();
      renderCompactCurrent(); renderCompactKeys();
      renderOverview(); setConnection(true); updateRouteStatus(); updateCompactStatus(); renderSlots();
      // 概览在 setConnection 之后渲染:客户端状态那三行要读 online(liveFacts 的口径),
      // 早一步渲染就会把一次成功的刷新说成"待确认"。
      renderOverviewPage();
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
      renderOverviewPage();
      if (view === 'providers') renderProviders();
      return false;
    }
    finally { $('refresh-btn').disabled = false; refreshTask = null; }
  })();
  return refreshTask;
}
// 标签页在后台时不轮询:没人看的状态没必要每 5 秒打一次 /api/state,切回来立刻补一次。
setInterval(() => { if (document.hidden) return; refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('offline', () => { setConnection(false, '网络连接已断开'); renderProviders(); });
window.addEventListener('online', refresh);

const VIEWS = ['overview', 'usage', 'providers', 'routes', 'sessions', 'diagnostics', 'settings'];
const VIEW_LABELS = { overview: '概览', usage: '用量统计', providers: '渠道与 Key', routes: '路由', sessions: '会话', diagnostics: '诊断', settings: '设置与备份' };
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
  if (view === 'providers') { renderProviders(); ensureHealth(); }
  if (view === 'sessions') renderSessions();
  if (view === 'routes' && !windowSnapshot && !windowLoadTask) loadCompactWindow();
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
  $('zcode-protocol').hidden = app !== 'zcode'; renderProviders(); renderSlots();
  if (typeof workspaceAppChanged === 'function') {
    try { workspaceAppChanged(app); } catch (e) { console.error(e); }
  }
}
function setZcodeWire(wire) { if (['anthropic', 'responses', 'chat'].includes(wire)) { zcodeWire = wire; renderProviders(); } }
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
// 所有数据都来自 /api/state 这一份只读快照,不新增任何 fetch。
function overviewJump(view, text) {
  // 跳转按钮只调视图切换,绝不发写请求(它连 api() 都不碰)。
  return `<button class="small" data-jump="${esc(view)}" onclick="showView(${handlerArg(view)})">${esc(text)}</button>`;
}
// 「需处理事项」清单。每一条都必须对应一个用户真能动手的状态,且能跳到管它的那一页;
// 没有事项时明确写出来——留空白会让人以为还没加载出来。
function overviewTodo() {
  const items = [];
  const ps = allProviders();
  const disabledProviders = ps.filter(p => p.enabled === false);
  const disabledKeys = ps.flatMap(p => (p.keys || []).filter(k => k.enabled === false).map(k => ({ provider: p, key: k })));
  const cooldowns = state.cooldowns || [];
  // 路由里的僵尸引用:池成员或单选目标指向已删除的渠道。主入口启动时也会告警,
  // 但真正致命的是"命中即 503",用户得在界面上看得见、能跳去改。
  const ghosts = [];
  for (const [label, r] of [...(state.routes?.rules || []).map((r, i) => [`规则 ${i + 1}（${r.match || '未填匹配'}）`, r]), ['默认路由', state.routes?.default || {}]]) {
    // 归属用 appOfRule:与路由页同一个口径,不给概览另写一份"这规则算哪一组"。
    for (const g of ghostRefsOf(r, appOfRule(r))) ghosts.push(`${label} 的${g.where}指向已删除的渠道（${g.id}）`);
  }
  // 会话里引用已失效的渠道 / Key:面板里 routingStaleOf() 已能逐条算,这里只给总数。
  let staleSessions = 0;
  for (const s of state.sessions || []) if (routingStaleOf(groupOfSession(s), s.routing).length) staleSessions++;

  if (disabledProviders.length) items.push({ text: `${disabledProviders.length} 个渠道已停用：${disabledProviders.map(p => p.name).join('、')}`, view: 'providers', action: '去渠道与 Key' });
  if (disabledKeys.length) items.push({ text: `${disabledKeys.length} 把 Key 已停用：${disabledKeys.map(({ provider, key }) => `${provider.name} · ${key.label || key.id}（${key.id}）`).join('、')}`, view: 'providers', action: '去渠道与 Key' });
  if (cooldowns.length) items.push({ text: `${cooldowns.length} 个渠道冷却中：${cooldowns.map(c => c.name || c.provider).join('、')}`, view: 'providers', action: '去渠道与 Key' });
  if (ghosts.length) items.push({ text: `路由里有失效引用，命中即 503：${ghosts.join('；')}`, view: 'routes', action: '去路由' });
  if (staleSessions) items.push({ text: `${staleSessions} 个会话的 Key / 槽位覆盖里存在已失效的引用`, view: 'sessions', action: '去会话' });

  if (!items.length) return '<p class="ov-ok" id="overview-todo-empty">没有需要处理的事项。</p>';
  return `<ul class="ov-todo" id="overview-todo-list">${items.map(it => `<li><span>${esc(it.text)}</span>${overviewJump(it.view, it.action)}</li>`).join('')}</ul>`;
}
// 与服务端 poolLib.ghostRefs 同口径的只读复算:池成员 + 单选目标,逐个查渠道还在不在。
function ghostRefsOf(r, group) {
  const out = [];
  if (r.provider && !providers(group).some(p => p.id === r.provider)) out.push({ where: '目标渠道', id: r.provider });
  for (const m of r.pool || []) {
    const id = typeof m === 'string' ? m : m.provider;
    if (id && !providers(group).some(p => p.id === id)) out.push({ where: '渠道池', id });
  }
  return out;
}
function renderOverviewPage() {
  if (!state) return;
  const stats = state.stats || {};
  $('ov-version').textContent = state.version ?? '—';
  // 源码修订给全长作 title:截短是为了不撑破卡片,能核对才是它存在的意义。
  // 用 setAttribute(而不是 .title=)是为了与假 DOM 一致——两者在真实浏览器里等价。
  const rev = state.code_revision || '';
  $('ov-revision').textContent = rev ? '源码修订 ' + rev.slice(0, 12) + (rev.length > 12 ? '…' : '') : '源码修订未提供';
  $('ov-revision').setAttribute('title', rev);
  $('ov-uptime').textContent = fmtUp(state.uptime_s);
  $('ov-pid').textContent = (state.pid ? `进程 ${state.pid}` : '进程未提供')
    + ` · 代理 ${state.proxy_port ?? '—'} / 控制台 ${state.ui_port ?? '—'}`;
  $('ov-reqs').textContent = fmtTok(stats.reqs);
  $('ov-tokens').textContent = `输入 ${fmtTok(stats.inTok)} / 输出 ${fmtTok(stats.outTok)}`;
  $('ov-sessions').textContent = state.sessions?.length ?? '—';
  $('ov-cooldowns').textContent = `${state.cooldowns?.length ?? 0} 个渠道冷却中`;

  $('overview-todo').innerHTML = overviewTodo();

  // 三行客户端状态:复用 liveFacts 的口径,不另造一套判断。
  $('overview-clients').innerHTML = Object.keys(APPS).map(app => {
    const f = liveFacts(app);
    const wire = f.lv?.wire_api ? ` · 协议 ${esc(f.lv.wire_api)}` : '';
    return `<div class="ov-row"><div class="ov-row-name">${esc(APPS[app].label)}</div>
      <div class="ov-row-main"><span class="badge ${f.healthy && f.lv?.base_url ? 'on' : 'off'}">${esc(f.mode)}</span><span>${esc(f.stateLabel)}${wire}</span></div>
      <div class="mono">${esc(f.lv?.base_url || '未配置接入地址')}</div>
      <div class="mono">${esc(APPS[app].cfg)}</div></div>`;
  }).join('');

  // 接入地址 = "我在哪里填什么"。zcode 缺 base 时退回 url(与 routerBase 同口径)。
  const r = state.router || {};
  const endpoints = Array.isArray(r.endpoints) ? r.endpoints : [];
  $('overview-endpoints').innerHTML = [
    ['Claude Code / Anthropic', r.claude_base || r.url || ''],
    ['Codex / OpenAI', r.codex_base || r.url || ''],
    ['ZCode', r.zcode_base || r.url || ''],
  ].map(([label, value]) => `<div class="ov-row"><div class="ov-row-name">${esc(label)}</div><div class="mono">${esc(value || '未提供')}</div></div>`).join('')
    + (endpoints.length ? `<div class="ov-row"><div class="ov-row-name">端点</div><div class="mono">${endpoints.map(esc).join('<br>')}</div></div>` : '');
}

function routerBase(app = curApp) {
  const r = state?.router || {};
  return app === 'zcode' ? (r.zcode_base || r.url || '') : app === 'claude' ? (r.claude_base || r.url || '') : (r.codex_base || r.url || '');
}
const connectionExpanded = {};
// 客户端接入状态的判定口径只此一处。概览页与渠道页读同一个函数,不各写一套——
// 两处各判一次迟早会分叉,而这两处说的都是"客户端到底写了没有",分叉就是骗人。
// app 显式传入而不是读 curApp:概览要三行并排看。
function liveFacts(app) {
  const lv = state.live?.[app], cur = state.current?.[app];
  const selected = allProviders().find(p => p.id === cur);
  const healthy = online && lv && !lv.error;
  const inRouter = healthy && !!lv.router, direct = healthy && !!lv.base_url && !lv.router;
  const stateLabel = !online ? '离线 · 最后快照' : !lv ? '状态未提供' : lv.error ? '配置读取失败' : lv.base_url ? '已写入配置' : '尚未配置';
  const slot = (state.slots?.[app] || []).find(s => s.alias === lv?.model);
  const configuredName = !healthy ? '待确认'
    : inRouter ? slot?.provider_name || '按路由规则分发'
    : lv?.match === true ? selected?.name || lv?.provider || '未配置' : lv?.provider || '自定义上游';
  // 概览页要的一句结论:现在这套客户端配置是直连、走路由,还是压根没接。
  const mode = !healthy ? '待确认' : inRouter ? '路由模式' : direct ? '直连' : '尚未配置';
  return { lv, cur, selected, healthy, inRouter, direct, stateLabel, slot, configuredName, mode };
}
function liveLine() {
  const { lv, cur, selected, healthy, inRouter, direct, stateLabel, slot, configuredName } = liveFacts(curApp);
  const modeBadge = enabled => enabled ? '<span class="badge on">已写入配置</span>' : `<span class="badge off">${!healthy ? '待确认' : '未接入'}</span>`;
  // 三个客户端共用同一块「当前配置」摘要。以前只有 Codex 有,Claude Code / ZCode 得在整页里
  // 自己找写了什么;现在口径一致(liveFacts 一处判定),接入细节默认收起、按客户端记住展开状态。
  // 详情里仍是那两张模式卡与配置行,离线时 liveFacts 会把它们降级成「待确认」,不冒充已写入。
  return `<dl class="current-config">
    <div><dt>配置供应商</dt><dd>${esc(configuredName)}</dd><small>${esc(stateLabel)}</small></div>
    <div><dt>默认模型</dt><dd class="mono">${esc(slot?.model || lv?.model || '未配置')}</dd>${slot ? `<small>槽位 ${esc(lv.model)}</small>` : ''}</div>
    <div><dt>接入方式</dt><dd>${!healthy ? '待确认' : inRouter ? '本地路由' : direct ? '直连' : '未接入'}</dd><small>${esc(lv?.wire_api || '')}</small></div>
    </dl><details class="connection-details"${connectionExpanded[curApp] ? ' open' : ''} ontoggle="connectionExpanded['${curApp}']=this.open"><summary>连接配置</summary><div class="mode-grid">
    <article class="mode-card ${direct ? 'selected' : ''}"><div class="top"><h2>直连渠道</h2>${modeBadge(direct)}</div><p>${direct ? esc(lv.match === true ? selected?.name || lv.provider || '自定义上游' : lv.provider || '自定义上游（配置未匹配）') : '客户端直接请求上游，不经过本地路由'}</p><p class="mono">${esc(lv?.base_url && !lv.router ? lv.base_url : '从下方渠道卡片选择接入')}</p></article>
    <article class="mode-card ${inRouter ? 'selected' : ''}"><div class="top"><h2>路由模式</h2>${modeBadge(inRouter)}</div><p>经本地代理按规则分发，按会话保持渠道粘性</p><p class="mono">${esc(inRouter ? lv.base_url || routerBase() : routerBase() || '等待后端提供路由地址')}</p></article>
    </div><p class="config-line">${esc(APPS[curApp].cfg)} · ${stateLabel}${lv?.wire_api ? ' · 协议 ' + esc(lv.wire_api) : ''}${lv?.model ? ' · 配置模型 ' + esc(lv.model) : ''}${cur ? ' · 库内选中 ' + esc(cur === (state.router?.id || '@router') ? '路由模式' : selected?.name || cur) : ''}</p>
    <p class="integration-note">${curApp === 'zcode' ? esc(ZCODE_HELP) + '。以上仅表示集成配置，不代表当前运行会话已切换；写入时合并并保留其他 provider，不默认更改现有默认模型。' : '切换会写入客户端配置，原文件自动备份。' + (curApp === 'claude' ? 'Claude Code 需重启会话生效。' : 'Codex 需重启生效。')}</p></details>`;
}
// 渠道库布局:list(默认,高密度行式账本)或 grid(并列卡片)。偏好记在 localStorage,
// 但读写全程兜底:隐私模式、旧浏览器或坏值都不能把渠道页带崩,读不到就退回默认。
const PROVIDER_LAYOUT_KEY = 'mixr.provider.layout';
function providerLayoutStore() {
  try { return window.localStorage || null; } catch { return null; }
}
let providerLayout = 'list';
{
  const store = providerLayoutStore();
  if (store) {
    try {
      const saved = store.getItem(PROVIDER_LAYOUT_KEY);
      if (saved === 'list' || saved === 'grid') providerLayout = saved;
    } catch { /* 读失败按默认 */ }
  }
}
function applyProviderLayout() {
  const grid = $('prov-grid');
  if (grid) grid.dataset.layout = providerLayout;
  // 外壳可能还没加这两个按钮(老页面/老测试):拿不到就跳过,布局本身照常生效。
  for (const [id, layout] of [['provider-layout-list', 'list'], ['provider-layout-grid', 'grid']]) {
    const btn = $(id);
    if (btn) btn.setAttribute('aria-pressed', String(providerLayout === layout));
  }
}
function setProviderLayout(layout) {
  providerLayout = layout === 'grid' ? 'grid' : 'list';
  const store = providerLayoutStore();
  if (store) { try { store.setItem(PROVIDER_LAYOUT_KEY, providerLayout); } catch { /* 写失败不影响本次切换 */ } }
  applyProviderLayout();
}
applyProviderLayout();   // 首帧就把记住的布局落到 #prov-grid,别等第一次进渠道页
function renderProviders() {
  document.body.dataset.client = curApp;
  // 标题对所有客户端同一口径;大小写眉标与副标题由外壳按设计处理,这里不再按客户端藏。
  const title = $('providers-title'); if (title) title.textContent = '渠道与 Key';
  applyProviderLayout();
  const isZcode = curApp === 'zcode', group = providerGroup();
  $('btn-router').textContent = isZcode ? '接入路由' : '路由模式';
  $('btn-router').disabled = !online || !state || (isZcode && !zcodeSupported());
  $('zcode-group-hint').textContent = `复用 ${GROUPS[group]} 渠道库，不创建第三份渠道仓库。${group === 'codex' ? 'Responses 与 Chat 共用列表；直连接入按渠道卡片自身协议写入，路由接入使用上方所选协议。' : 'Anthropic 协议展示、新建和编辑 Claude 组渠道。'}编辑、启停和删除会同步影响使用该渠道库的客户端。`;
  if (!state) {
    if (!online && document.body.dataset.connection === 'offline') $('liveinfo').innerHTML = '<div class="empty"><b>无法读取客户端配置</b>请检查本地 Mixrouter 服务；连接恢复后会自动刷新。</div>';
    return;
  }
  const ps = providers(group), query = $('provider-search').value.trim().toLowerCase(), filter = $('provider-filter').value;
  const shown = ps.filter(p => (!query || [p.name, p.base_url, p.model, ...(p.models || []), ...Object.values(p.slots || {})].join(' ').toLowerCase().includes(query)) && (filter === 'all' || (filter === 'enabled' ? p.enabled : !p.enabled)));
  $('channel-heading').textContent = isZcode ? `共享渠道 · ${GROUPS[group]}` : `${APPS[curApp].label} 渠道库`;
  $('channel-count').textContent = `显示 ${shown.length} / ${ps.length} 个渠道 · ${ps.filter(p => p.enabled).length} 个已启用${isZcode ? ' · ZCode 复用，不重复计数' : ''}`;
  $('prov-empty').hidden = shown.length > 0;
  $('empty-title').textContent = ps.length ? '没有匹配的渠道' : `${GROUPS[group]} 还没有渠道`;
  $('empty-hint').textContent = ps.length ? '尝试其他名称、URL 或模型，或清除启用状态筛选。' : `新建一个${isZcode ? '共享' : ''}渠道，填写上游地址与模型后即可配置直连或路由。`;
  $('empty-action').textContent = ps.length ? '清除筛选' : '＋ 新建渠道';
  $('empty-action').onclick = ps.length ? () => { $('provider-search').value = ''; $('provider-filter').value = 'all'; renderProviders(); $('provider-search').focus(); } : () => openProvider();
  const liveHtml = liveLine();
  if ($('liveinfo').innerHTML !== liveHtml && !$('liveinfo').contains(document.activeElement))
    $('liveinfo').innerHTML = liveHtml;
  const lv = state.live?.[curApp], curId = state.current?.[curApp];
  // 冷却与可用性按渠道 id 索引一次,卡片里按 id 取。两者都只读:
  // 冷却来自 /api/state(会话页也在用),可用性来自 /api/health(liveHealth,可能还没回来或读失败)。
  const cooldownById = new Map((state.cooldowns || []).map(c => [c.provider, c]));
  const healthById = new Map((liveHealth?.providers || []).map(h => [h.provider, h]));
  let warning = '';
  if (isZcode && !zcodeSupported()) warning = '当前后端尚未提供 ZCode 集成状态，已禁用接入操作以免旧接口误写其他客户端。共享渠道仍可管理；请接入支持 ZCode 的后端后重试。';
  else if (lv?.error) warning = `客户端配置读取失败：${lv.error}。无法确认集成状态，请检查配置后重试。`;
  else if (online && lv && curId && lv.match === false) warning = `${APPS[curApp].label} 配置与库内选择不一致。${isZcode ? '可重新「接入 ZCode」或「接入路由」，然后在模型选择器选择对应模型。' : '可通过渠道「重新写入」或重新启用路由模式恢复，写入前自动备份。'}`;
  $('drift-banner').classList.toggle('show', !!warning); $('drift-text').textContent = warning;
  // 健康端点挂了不能把整页拖垮:读不到就只显示一句"健康状态未读取",其余卡片照常渲染。
  // 冷却徽标来自 /api/state,与健康端点无关,所以它不受这一条影响。
  $('prov-health').hidden = !!liveHealth;
  $('prov-health').textContent = liveHealth ? '' : (healthError ? `健康状态未读取（${healthError}）：渠道可用性暂时不可用，冷却状态仍然准确。` : '健康状态尚未读取；进入「设置与备份」页可读取渠道可用性。');
  const html = shown.map(p => {
    const isCur = curId === p.id, drift = isCur && lv?.match === false;
    const verified = online && !lv?.error && isCur && lv?.match === true && !lv.router;
    const t = testResults[p.id];
    const tline = !t ? '' : t.wait ? '<div class="testline wait" role="status">测试中…</div>' : `<div class="testline ${t.ok ? 'ok' : 'err'}" role="status">上次测试${t.ok ? '通过' : '失败'} · ${esc(t.ok ? `${t.status} · ${t.ms}ms${t.model ? ' · ' + t.model : ''}` : t.error || ('HTTP ' + t.status))}${!t.ok && t.body ? ' · ' + esc(t.body.slice(0, 120)) : ''}</div>`;
    const models = group === 'claude' ? (p.models || []) : [p.model].filter(Boolean);
    const wire = group === 'claude' ? (p.wire_api === 'responses' ? 'responses（转换）' : p.wire_api === 'chat' ? 'chat（转换）' : 'anthropic') : p.wire_api || 'responses';
    // responses/chat 渠道只挂 Codex/OpenAI 型通道,直连写进客户端必然失败(服务端也会拒),按钮直接封掉
    const convOnly = (group === 'claude' && (p.wire_api === 'responses' || p.wire_api === 'chat')) || (curApp === 'codex' && p.wire_api === 'chat');
    const arg = handlerArg(p.id), locked = !online || (isZcode && !zcodeSupported()) || convOnly;
    // 失效(停用)的 Key:卡片上先给数量,展开的多 Key 清单里能逐把看出来是哪几把。
    // 只报 label 与 id —— 明文 Key 从不进入任何渲染路径(见 renderKeyDraft 的密码框与卡片下拉)。
    const keys = p.keys || [];
    const deadKeys = keys.filter(k => k.enabled === false);
    const cool = cooldownById.get(p.id);
    const hp = healthById.get(p.id);
    const healthBits = [];
    if (cool) healthBits.push(`<span class="badge drift" title="冷却中">冷却至 ${esc(new Date(cool.until).toLocaleTimeString('zh-CN', { hour12: false }))}</span>`);
    // enabled !== false 才算可用:渠道停用或按健康快照不可达都会让池跳过它,提前说出来免得用户以为它在用
    if (hp && hp.eligible === false && !cool && p.enabled) healthBits.push('<span class="badge off" title="按健康状态不可用">暂不可用</span>');
    // 卡片分四块:身份(头像 + 名称 + 状态徽标)、内容(地址/协议/模型/告警)、账号与测试结果、
    // 动作。旧类名 .card/.top/.foot/.tags 保留,新增的 provider-* 只负责分区;动作按钮与 data-*
    // 原样不动,样式层按这套区块做 grid/list 两种排布。
    // 头像用渠道名首字母(ASCII 取前两位),纯装饰,不参与朗读。
    const nameText = String(p.name || '?').trim();
    const avatar = (/^[\x20-\x7e]+$/.test(nameText) ? nameText.slice(0, 2) : nameText.slice(0, 1)).toUpperCase() || '?';
    const statusBadges = [
      isCur ? `<span class="badge ${verified ? 'on' : 'off'}">${verified ? '已写入配置' : '库内选中'}</span>` : '',
      drift && online ? '<span class="badge drift">配置不一致</span>' : '',
      `<span class="badge ${p.enabled ? 'info' : 'off'}">${p.enabled ? '启用' : '停用'}</span>`,
      deadKeys.length ? `<span class="badge off" title="有停用的 Key">${deadKeys.length} 把 Key 已停用</span>` : '',
      ...healthBits,
    ].join('');
    // 账号只露 label / 掩码,明文 Key 从不进入卡片(停用的 Key 也一样)。
    const account = keys.length
      ? `<select class="keypick" data-provider="${esc(p.id)}" data-action="key" aria-label="${esc(p.name)} 当前账号" onchange="setActiveKey(${arg},this.value)">${keys.map(k => `<option value="${esc(k.id)}" ${k.id === p.active_key ? 'selected' : ''}>${esc(k.label)} · ${esc(k.key_masked)}${k.enabled === false ? ' · 已停用' : ''}</option>`).join('')}</select><span class="muted">（${keys.length} 个账号${deadKeys.length ? '，' + deadKeys.length + ' 把已停用' : ''}）</span>`
      : esc(p.key_masked || '未配置');
    return `<article class="card ${p.enabled ? '' : 'off'} ${verified ? 'cur' : ''}" data-provider="${esc(p.id)}">
      <header class="top provider-identity">
        <span class="provider-avatar" aria-hidden="true">${esc(avatar)}</span>
        <div class="provider-info"><h3 class="name">${esc(p.name)}</h3><div class="provider-status">${statusBadges}</div></div>
      </header>
      <div class="provider-content">
        <div class="mono endpoint" title="${esc(p.base_url)}">${esc(p.base_url)}</div>
        <div class="provider-models tags"><span class="tag">${esc(wire)}</span>${models.map(m => `<span class="tag">${esc(m)}</span>`).join('')}${p.drop_images ? '<span class="tag">纯文本</span>' : ''}${p.direct ? '<span class="tag">直连</span>' : ''}</div>
        ${deadKeys.length ? `<p class="note">已停用的 Key：${deadKeys.map(k => `${esc(k.label || k.id)}（${esc(k.id)}）`).join('、')}。停用只影响固定选它的会话与压缩规则，不会自动改选其他 Key。</p>` : ''}${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}
        ${isZcode && group === 'codex' && wire !== zcodeWire ? `<p class="note">此渠道按 ${esc(wire)} 协议接入，与上方路由协议选择不同。</p>` : ''}
      </div>
      <div class="provider-meta mono keyrow">API key · ${account}${tline}</div>
      <div class="foot provider-actions"><button class="small ${verified ? 'cur' : 'primary'}" data-action="switch" data-provider="${esc(p.id)}" onclick="switchProvider(${arg})" ${locked ? 'disabled' : ''} title="${convOnly ? '该渠道只挂 Codex 型通道，直连不可用：请用上方「路由模式」' : ''}">${isZcode ? '接入 ZCode' : isCur ? '重新写入' : '切换'}</button><button class="small" data-action="test" data-provider="${esc(p.id)}" onclick="testProvider(${arg})" ${!online || t?.wait ? 'disabled' : ''}>测试</button><button class="small" data-action="edit" data-provider="${esc(p.id)}" onclick="openProvider(${arg})">编辑</button><button class="small" data-action="toggle" data-provider="${esc(p.id)}" onclick="toggleProvider(${arg})" ${!online ? 'disabled' : ''}>${p.enabled ? '停用' : '启用'}</button><button class="small danger" data-action="delete" data-provider="${esc(p.id)}" onclick="delProvider(${arg})" ${!online ? 'disabled' : ''}>删除</button></div></article>`;
  }).join('');
  // 轮询只更新状态,但不能在用户正操作卡片时拆 DOM:下拉展开时重建会把菜单关掉,焦点恢复也救不回来。
  // 焦点在卡片内的输入/下拉上就等失焦后的下一次刷新再重绘;按钮没有展开态,照旧重建并恢复焦点。
  const grid = $('prov-grid');
  if (grid.innerHTML !== html) {
    if (activeDialog) return;
    const activeEl = document.activeElement;
    if (grid.contains(activeEl) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(activeEl.tagName)) return;
    const focus = grid.contains(activeEl) ? { ...activeEl.dataset } : null;
    grid.innerHTML = html;
    if (focus) {
      const restored = [...grid.querySelectorAll('button,select')].find(b => b.dataset.provider === focus.provider && b.dataset.action === focus.action);
      // 删除后原按钮随卡片一起没了:别把焦点丢给 body,交给仍然存在的「新建渠道」。
      if (restored) restored.focus();
      else $('new-provider')?.focus();
    }
  }
}
function openProvider(id) {
  if (!state || activeDialog) return;
  editingGroup = providerGroup(); editing = id ? providers(editingGroup).find(p => p.id === id) : null;
  if (id && !editing) return toast('渠道已不存在，请刷新后重试', 'err');
  const isCodex = editingGroup === 'codex';
  $('m-title').textContent = (editing ? '编辑渠道 · ' : '新建渠道 · ') + GROUPS[editingGroup];
  $('m-description').textContent = curApp === 'zcode' ? '这是共享渠道库，修改对 Claude Code / Codex 同样可见。保存渠道不会写入 ZCode；请在渠道卡片上点击「接入 ZCode」。' : '保存到渠道库后，通过渠道卡片写入客户端配置。Claude 模型列表第一项作为主模型。';
  $('m-base-hint').textContent = isCodex ? '（通常包含 /v1）' : '';
  $('m-name').value = editing?.name || ''; $('m-base').value = editing?.base_url || ''; $('m-key').value = '';
  // 清单是唯一真相:渠道一旦有清单(老式单 Key 渠道也会合成一条「账号1」),顶栏那个单行
  // API Key 就不参与保存了——否则服务端会把它当成"改当前生效那把",悄悄覆盖掉账号1
  keyDraft = (editing?.keys || []).map(k => ({ id: k.id, label: k.label, key: '', masked: k.key_masked }));
  $('m-key-hint').textContent = !editing ? ''
    : keyDraft.length ? '（多 Key 渠道请在下方清单里改，这里不参与保存）'
    : '（留空保持不变，当前 ' + (editing.key_masked || '未配置') + '）';
  $('m-keys-wrap').style.display = editing ? '' : 'none';
  renderKeyDraft();
  $('m-claude-fields').style.display = isCodex ? 'none' : ''; $('m-codex-fields').style.display = isCodex ? '' : 'none';
  $('m-model').required = isCodex;
  $('m-model').value = editing?.model || ''; $('m-wire').value = editing?.wire_api || (curApp === 'zcode' && isCodex ? zcodeWire : 'responses');
  $('m-dropimg').checked = !!editing?.drop_images;
  // 下拉候选 = 本组渠道登记过的模型名(含正在编辑这条自己的),手写的新名字会临时并进来
  modelCandidates = [...new Set(providers(editingGroup).flatMap(p => p.models || []))].sort();
  modelDraft = (editing?.models || []).map(m => ({ value: m, editing: false }));
  renderModelDraft();
  $('m-wire-claude').value = editing?.wire_api === 'responses' ? 'responses' : editing?.wire_api === 'chat' ? 'chat' : 'anthropic';
  $('m-note').value = editing?.note || ''; $('m-enabled').checked = editing ? !!editing.enabled : true;
  $('m-direct').checked = !!editing?.direct;
  showDialog('mask', 'm-name');
}
function closeModal() { if (savingProvider) return toast('正在保存，请稍候'); hideDialog(); $('m-key').value = ''; keyDraft = []; modelDraft = []; }

// 多 Key(同渠道多账号):弹窗里维护清单,卡片下拉里切当前生效那把
function renderKeyDraft() {
  $('m-keys').innerHTML = keyDraft.length ? keyDraft.map((k, i) => `<div class="rc-line">
    <label class="field" style="flex:1">名称<input type="text" value="${esc(k.label)}" oninput="keyDraft[${i}].label=this.value" placeholder="账号${i + 1}" autocomplete="off"></label>
    <label class="field" style="flex:2">API Key<input type="password" value="${esc(k.key)}" oninput="keyDraft[${i}].key=this.value" placeholder="${k.id ? '留空=不改（' + esc(k.masked || '') + '）' : 'sk-…'}" autocomplete="new-password" spellcheck="false"></label>
    <button type="button" class="iconbtn" aria-label="删除这个 Key" onclick="removeKeyDraft(${i})">×</button></div>`).join('')
    : '<p class="muted">还没有多 Key。点「＋ 添加账号」加第二把；只留一把时用上面的 API Key 就行。</p>';
}
function addKeyDraft() { keyDraft.push({ id: '', label: '', key: '', masked: '' }); renderKeyDraft(); }
function removeKeyDraft(i) { keyDraft.splice(i, 1); renderKeyDraft(); }
async function setActiveKey(id, keyId) {
  if (!online) return toast('控制台离线，未保存切换', 'err');
  try {
    const res = await api('/api/providers/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ active_key: keyId }) });
    toastWithBackupWarnings('已切换生效 Key；槽位按渠道走，立刻跟着用新 Key', res);
    await refresh();
  } catch (e) { toast('切换失败：' + e.message, 'err'); await refresh(); }
}
// 模型列表草稿:一行一个模型,和「多 Key」同一套行式编辑。每行是下拉(本组渠道登记过的模型名),
// 要写没登记的就选「自定义模型…」把这一行切成输入框——不用 datalist,它在字段已有值时只弹匹配的那一项
let modelDraft = [], modelCandidates = [];
const MODEL_CUSTOM = '__custom__';
function modelSelectOptions(row) {
  const known = [...new Set([...modelCandidates, row.value].filter(Boolean))];
  const label = m => esc(m) + (modelCandidates.includes(m) ? '' : '（自定义）');
  return [`<option value="" ${row.value ? '' : 'selected'}>（选模型）</option>`]
    .concat(known.map(m => `<option value="${esc(m)}" ${m === row.value ? 'selected' : ''}>${label(m)}</option>`))
    .concat([`<option value="${MODEL_CUSTOM}">自定义模型…</option>`]).join('');
}
function renderModelDraft() {
  $('m-models-list').innerHTML = modelDraft.length ? modelDraft.map((r, i) => `<div class="rc-line">
    <label class="field" style="flex:1">模型${i === 0 ? '（主）' : ''}${r.editing
      ? `<input type="text" aria-label="模型${i + 1}" value="${esc(r.value)}" placeholder="模型名，可带 [1M] 后缀" spellcheck="false" autocomplete="off" oninput="modelDraft[${i}].value=this.value" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}" onblur="endModelEdit(${i},this.value)">`
      : `<select aria-label="模型${i + 1}" onchange="pickModelDraft(${i},this.value)">${modelSelectOptions(r)}</select>`}</label>
    <button type="button" class="iconbtn" aria-label="删除这个模型" onclick="removeModelDraft(${i})">×</button></div>`).join('')
    + `<datalist id="model-candidates">${[...new Set(modelCandidates)].map(m => `<option value="${esc(m)}"></option>`).join('')}</datalist>`
    : '<p class="muted">还没有模型。点「＋ 添加模型」加一个；第一项会当主模型用。</p>';
}
function addModelDraft() { modelDraft.push({ value: '', editing: false }); renderModelDraft(); }
function removeModelDraft(i) { modelDraft.splice(i, 1); renderModelDraft(); }
function pickModelDraft(i, value) {
  const row = modelDraft[i];
  if (!row) return;
  if (value === MODEL_CUSTOM) { row.editing = true; row.value = ''; return renderModelDraft(); }
  row.value = value;                       // 选中项已经在 select 上显示,不重绘(免得吞掉正要点的下一处)
}
// 手写失焦:只同步草稿并把新名字并进候选,不重绘——此刻用户多半正点向别处,重绘会把鼠标下的元素换掉
function endModelEdit(i, value) {
  const v = String(value || '').trim();
  if (!modelDraft[i]) return;
  modelDraft[i].value = v;
  if (v && !modelCandidates.includes(v)) modelCandidates.push(v);
}
async function saveProvider() {
  if (savingProvider) return;
  if (!online) return toast('控制台离线，表单已保留，请连接后保存', 'err');
  if (!$('provider-form').reportValidity()) return;
  const body = { app: editingGroup, name: $('m-name').value.trim(), base_url: $('m-base').value.trim(), api_key: keyDraft.length ? '' : $('m-key').value, note: $('m-note').value, enabled: $('m-enabled').checked, direct: $('m-direct').checked };
  if (editingGroup === 'codex') { body.model = $('m-model').value.trim(); body.wire_api = $('m-wire').value; body.drop_images = $('m-dropimg').checked; }
  else { body.models = [...new Set(modelDraft.map(r => String(r.value || '').trim()).filter(Boolean))]; body.wire_api = $('m-wire-claude').value; }
  if (!body.name || !body.base_url) return toast('名称与 Base URL 必填', 'err');
  // 编辑时把多 Key 清单一起提交(留空=不改;清单清空=退回单 Key);新建渠道用上面的 API Key 一把起步
  if (editing) body.keys = keyDraft.filter(k => k.id || k.key.trim()).map(k => ({ id: k.id, label: k.label.trim(), key: k.key.trim() }));
  if (editingGroup === 'codex' && !body.model) return toast('OpenAI 渠道必须填模型名', 'err');
  try { const url = new URL(body.base_url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { $('m-base').focus(); return toast('请输入合法的 http(s) Base URL', 'err'); }
  savingProvider = true; $('save-provider').disabled = true;
  // 写渠道库的接口会把**备份池轮换**一并带回来(mixrouter.js 的 drainStoreWarnings →
  // 响应体 warnings)。渠道库默认只留 5 份备份,而每次保存渠道都写一次库 ——
  // 池满之后**每一次保存都在顶掉最老的那一份**。不说出来的话,用户会以为"渠道库有备份",
  // 而这句话只对最近 5 次成立。取最后一次写入的响应即可:轮换预警说的是"这一次写入顶掉了谁",
  // 而面板要显示的正是他刚点的那一下(新建渠道时若还补了一次"停用"的 PUT,那句话也在此)。
  let res = null;
  try {
    if (editing) res = await api('/api/providers/' + encodeURIComponent(editing.id), { method: 'PUT', body: JSON.stringify(body) });
    else {
      const created = await api('/api/providers', { method: 'POST', body: JSON.stringify(body) });
      res = created;
      // Older backends create channels enabled regardless of the POST flag.
      if (!body.enabled && created.id) {
        editing = { id: created.id };
        res = await api('/api/providers/' + encodeURIComponent(created.id), { method: 'PUT', body: JSON.stringify({ app: editingGroup, enabled: false }) }) || res;
      }
    }
    savingProvider = false; closeModal(); toastWithBackupWarnings('渠道已保存；客户端配置未改动', res); await refresh();
  } catch (e) { toast('保存失败：' + e.message, 'err'); }
  finally { savingProvider = false; $('save-provider').disabled = false; }
}
function canConnect(app) {
  if (!online) { toast('控制台离线，请重新连接后操作', 'err'); return false; }
  if (app === 'zcode' && !zcodeSupported()) { toast('当前后端尚未支持 ZCode 接入，未发送写入请求', 'err'); return false; }
  return true;
}
async function switchProvider(id) {
  const app = curApp, p = providers().find(x => x.id === id);
  if (!p || !canConnect(app)) return;
  const message = app === 'zcode'
    ? `将「${p.name}」接入 ZCode，按渠道自身 ${providerGroup() === 'claude' ? 'anthropic' : p.wire_api || 'responses'} 协议写入 ${APPS.zcode.cfg}。合并并保留其他 provider，不默认更改现有默认模型。\n\n${ZCODE_HELP}。不会自动切换当前运行会话。`
    : `将 ${APPS[app].label} 配置写入为「${p.name}」直连。\n文件：${APPS[app].cfg}（原文件自动备份）。\n${app === 'claude' ? 'Claude Code 需重启会话生效。' : 'Codex 需重启生效。'}`;
  if (!await askConfirm(app === 'zcode' ? '接入 ZCode' : '写入直连配置', message, app === 'zcode' ? '接入 ZCode' : '写入配置') || !canConnect(app)) return;
  try {
    const res = await api('/api/switch/' + encodeURIComponent(id), { method: 'POST', ...(app === 'zcode' ? { body: JSON.stringify({ app: 'zcode' }) } : {}) });
    toastWithBackupWarnings(app === 'zcode' ? `已保存 ZCode 集成配置。${ZCODE_HELP}` : `已写入 ${APPS[app].label} 配置 → ${p.name}，请重启${app === 'claude' ? '会话' : '客户端'}生效`, res); await refresh();
  } catch (e) { toast('接入失败：' + e.message, 'err'); }
}
async function switchRouterMode() {
  const app = curApp, wire = zcodeWire;
  if (!canConnect(app)) return;
  const base = routerBase(app) || '后端提供的路由地址';
  const message = app === 'zcode'
    ? `将 ZCode 以 ${wire} 协议接入路由：${base}。\n流量归入 ${GROUPS[wire === 'anthropic' ? 'claude' : 'codex']} 组。\n写入 ${APPS.zcode.cfg}，合并并保留其他 provider，不默认更改现有默认模型。\n\n${ZCODE_HELP}。不会自动切换当前运行会话。`
    : `将 ${APPS[app].label} 指向 ${base}，请求按路由规则分发，按会话保持渠道粘性。\n写入 ${APPS[app].cfg}（原文件自动备份）。${app === 'claude' ? 'Claude Code 需重启会话生效。' : 'Codex 需重启生效。'}\n可随时通过渠道卡片切回直连。`;
  if (!await askConfirm(app === 'zcode' ? '接入路由' : '写入路由配置', message, '接入路由') || !canConnect(app)) return;
  try {
    const res = await api('/api/router/' + app, { method: 'POST', ...(app === 'zcode' ? { body: JSON.stringify({ wire_api: wire }) } : {}) });
    toastWithBackupWarnings(app === 'zcode' ? `已保存路由集成配置。${ZCODE_HELP}` : `已写入 ${APPS[app].label} 路由配置，请重启${app === 'claude' ? '会话' : '客户端'}生效`, res); await refresh();
  } catch (e) { toast('接入失败：' + e.message, 'err'); }
}
async function toggleProvider(id) {
  const p = providers().find(x => x.id === id), app = providerGroup();
  if (!p || !online) return;
  if (!await askConfirm(p.enabled ? '停用共享渠道' : '启用共享渠道', `「${p.name}」属于 ${GROUPS[app]} 渠道库；修改会影响该组路由及复用此渠道的客户端。停用不会撤销已写入客户端的直连配置。`, p.enabled ? '停用' : '启用')) return;
  try { const res = await api('/api/providers/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ app, enabled: !p.enabled }) }); toastWithBackupWarnings('渠道状态已更新', res); await refresh(); }
  catch (e) { toast('更新失败：' + e.message, 'err'); }
}
async function delProvider(id) {
  const p = providers().find(x => x.id === id);
  if (!p || !online) return;
  if (!await askConfirm('删除共享渠道', `删除「${p.name}」？这会从 ${GROUPS[providerGroup()]} 共享库移除渠道，影响所有复用方。客户端已写入的配置不会自动撤销，请同时检查关联路由。此操作不可撤销。`, '删除渠道')) return;
  try { const res = await api('/api/providers/' + encodeURIComponent(id), { method: 'DELETE' }); toastWithBackupWarnings('渠道已删除', res); await refresh(); }
  catch (e) { toast('删除失败：' + e.message, 'err'); }
}
async function testProvider(id) {
  if (!online || testResults[id]?.wait) return;
  testResults[id] = { wait: true }; if (view === 'providers') renderProviders();
  try { testResults[id] = await api('/api/providers/' + encodeURIComponent(id) + '/test', { method: 'POST' }); }
  catch (e) { testResults[id] = { ok: false, error: e.message }; }
  if (view === 'providers') renderProviders();
}

// ---------------- 子代理槽位 ----------------
// 槽位 = 别名(mixr-…)→「渠道 @ 模型」。Claude 五个固定槽写进客户端 env;
// Codex 槽名自拟,客户端用 codex -m mixr-<槽名> 选用。别名请求优先于一切路由规则。
const SLOT_LABELS = { main: '主模型 main', opus: 'Opus 槽', sonnet: 'Sonnet 槽', haiku: 'Haiku 槽', subagent: 'Subagent 槽' };
const SLOT_MODEL_CUSTOM = '__custom__';
const slotModelEdit = { claude: null };        // {name, value} 正在手写模型名的槽位（下拉切输入框）
function onSlotModelPick(app, name, value) {
  if (value === SLOT_MODEL_CUSTOM) {
    const s = (slotsOf()[app] || []).find(x => x.name === name);
    slotModelEdit[app] = { name, value: (s && s.model) || '' };   // 记下原值,失焦时才知道有没有真改
    return renderSlots(true);
  }
  slotModelEdit[app] = null;
  return setSlot(app, name, 'model', value);
}
async function commitSlotModel(app, name, value) {
  slotModelEdit[app] = null;
  const ok = await setSlot(app, name, 'model', (value || '').trim());
  renderSlots(true);         // 立刻收回输入框换成下拉,别等下一轮轮询(焦点还停在表内,轮询守卫会跳过重绘)
  return ok;
}
// 回车直接提交,不必先点走焦点
function slotModelKey(ev, app, name) {
  if (ev.key === 'Enter') { ev.preventDefault(); return commitSlotModel(app, name, ev.target.value); }
  if (ev.key === 'Escape') { slotModelEdit[app] = null; return renderSlots(true); }
}
// 失焦提交不依赖 change 事件(有的引擎/输入法不发),只比值有没有真变;没变就只清标记、不重绘——
// 此刻用户多半正点向别的控件,重绘会把鼠标下的元素换掉、吞掉这次点击,交给下一次轮询(5s)自然收回输入框
function endSlotModelEdit(app, name, value) {
  const e = slotModelEdit[app];
  if (!e || e.name !== name) return;
  slotModelEdit[app] = null;
  if (value !== e.value) commitSlotModel(app, name, value);
}
const slotsOf = () => state?.slots || { claude: [], codex: [] };
function slotChannelOptions(sel, group) {
  return '<option value="">(未配置)</option>' + providers(group).map(p => {
    // 渠道当前生效的 Key(账号)一并显示:渠道库里切换后,槽位这一行跟着变
    const act = (p.keys || []).find(k => k.id === p.active_key) || (p.keys || [])[0];
    return `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}${act ? ' · ' + esc(act.label) : ''}${p.enabled ? '' : '（停用）'}</option>`;
  }).join('');
}
function slotBadge(s, liveRouter) {
  if (!s.provider) return '<span class="badge off">未配置</span>';
  if (!s.enabled) return '<span class="badge off">渠道停用</span>';
  if (curApp === 'claude') {
    if (!liveRouter) return '<span class="badge info">已配置 · 未切路由</span>';
    const env = state.live?.claude?.slots?.[s.name] || '';
    return env === s.alias ? '<span class="badge on">已写入</span>' : '<span class="badge drift">未同步</span>';
  }
  return '<span class="badge info">已配置</span>';
}
function claudeSlotRow(s) {
  const ch = providers('claude').find(p => p.id === s.provider);
  const known = [...new Set((ch && ch.models) || [])];
  const cur = s.model || '';
  // 落点模型是下拉:渠道模型列表 + 当前值(可能是手写的未登记模型名)+「自定义模型…」。
  // 不要退回 datalist——Chromium 会按输入框已有内容过滤候选,填了值就只剩那一个,等于没法挑;
  // 想写渠道清单里没有的模型名,走最后一项切输入框(服务端只校验字符串,不比对渠道模型表)
  const options = [
    `<option value="" ${cur ? '' : 'selected'}>（渠道第一个模型）</option>`,
    ...known.map(m => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`),
    ...(cur && !known.includes(cur) ? [`<option value="${esc(cur)}" selected>${esc(cur)}（自定义）</option>`] : []),
    `<option value="${SLOT_MODEL_CUSTOM}">自定义模型…</option>`,
  ].join('');
  const suggestions = [...new Set([...(cur ? [cur] : []), ...known])]
    .map(m => `<option value="${esc(m)}"></option>`).join('');
  const modelCell = !s.provider
    ? `<select aria-label="${esc(s.name)} 槽模型" disabled><option>（先选渠道）</option></select>`
    : slotModelEdit.claude?.name === s.name
      ? `<input type="text" aria-label="${esc(s.name)} 槽模型" list="slot-models-${esc(s.name)}" value="${esc(cur)}" placeholder="模型名，可带 [1M] 后缀" spellcheck="false" autocomplete="off" onkeydown="slotModelKey(event,'claude','${s.name}')" onchange="commitSlotModel('claude','${s.name}',this.value)" onblur="endSlotModelEdit('claude','${s.name}',this.value)"><datalist id="slot-models-${esc(s.name)}">${suggestions}</datalist>`
      : `<select aria-label="${esc(s.name)} 槽模型" onchange="onSlotModelPick('claude','${s.name}',this.value)">${options}</select>`;
  return slotLine(s,
    `<select aria-label="${esc(s.name)} 槽渠道" onchange="setSlot('claude','${s.name}','provider',this.value)">${slotChannelOptions(s.provider, 'claude')}</select>`,
    modelCell, slotBadge(s, !!state.live?.claude?.router),
    s.provider ? `<button class="iconbtn" aria-label="清空 ${esc(s.name)} 槽" onclick="clearSlot('claude','${s.name}')">×</button>` : '');
}
// 全局与会话槽位共用原有行布局;差异只在控件的读写范围。
function slotLine(s, providerCell, modelCell, badge, clear, attributes = '') {
  return `<div class="rc-line"${attributes}>
    <label class="field slot-ident">${SLOT_LABELS[s.name] || esc(s.name)}<span class="mono">${esc(s.alias)} · ${esc(s.env || '')}</span></label>
    <label class="field" style="flex:2">渠道${providerCell}</label>
    <label class="field" style="flex:2">落点模型${modelCell}</label>
    <span style="align-self:center">${badge}</span>
    ${clear}
  </div>`;
}
function codexSlotRow(s) {
  return `<div class="rc-line">
    <label class="field slot-ident">${esc(s.name)}<span class="mono">${esc(s.alias)} · codex -m ${esc(s.alias)}</span></label>
    <label class="field" style="flex:2">渠道<select aria-label="${esc(s.name)} 渠道" onchange="setSlot('codex','${s.name}','provider',this.value)">${slotChannelOptions(s.provider, 'codex')}</select></label>
    <span style="align-self:center">${slotBadge(s, false)}</span>
    ${s.provider ? `<button class="iconbtn" aria-label="删除 ${esc(s.name)} 槽" onclick="clearSlot('codex','${s.name}')">×</button>` : ''}
  </div>`;
}
let codexModelSaving = false;
let codexConfigSaving = false;
let codexReasoningDraft = null;
let codexConfigRevisionDraft = '';
function renderCodexConfig(force) {
  const live = state?.live?.codex || {};
  const main = live.main || {}, reviewer = live.reviewer || {};
  const context = live.model_context_window || main.context_window;
  const facts = [
    ['配置中的主模型', `${live.model || '未设置'}${main.target && main.target !== live.model ? ' → ' + main.target : ''}`],
    ['配置中的审查模型', `${live.review_model || '跟随主模型'}${reviewer.target && reviewer.target !== live.review_model ? ' → ' + reviewer.target : ''}`],
    ['上下文窗口', context ? `${Number(context).toLocaleString()} tokens${live.model_context_window ? '（显式配置）' : '（本地模型目录）'}` : '未声明，由 Codex 决定'],
    ['自动压缩阈值', live.model_auto_compact_token_limit ? `${Number(live.model_auto_compact_token_limit).toLocaleString()} tokens` : 'Codex 自动（未覆写）'],
    ['模型能力目录', live.model_catalog_json || 'Codex 内置目录'],
    ['配置文件', live.config_path || APPS.codex.cfg],
  ];
  $('codex-config-details').innerHTML = `<dl class="config-facts">${facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl><ul class="config-warnings">${(live.warnings || []).map(warning => `<li>${esc(warning)}</li>`).join('')}</ul><p class="hint">这里读取本机全局默认配置，不代表已运行会话；命令行、profile 和项目覆盖需另行确认。修改后重启 Codex 生效，不改 Claude 配置。</p>`;
  const disabled = !online || !live.revision || !!live.error || !!live.profile || codexConfigSaving;
  const effort = codexReasoningDraft === null ? live.model_reasoning_effort || '' : codexReasoningDraft;
  const levels = [...new Set([...(main.reasoning_levels || []), ...(effort ? [effort] : [])])];
  const controls = `<label class="reasoning-control" for="codex-reasoning">推理档位<select id="codex-reasoning" onchange="codexReasoningDraft=this.value;codexConfigRevisionDraft=state.live.codex.revision" ${disabled ? 'disabled' : ''}><option value="" ${!effort ? 'selected' : ''}>自动</option>${levels.map(level => `<option value="${esc(level)}" ${level === effort ? 'selected' : ''}>${esc(level)}</option>`).join('')}</select></label><button class="small" id="codex-reasoning-save" onclick="saveCodexConfig('reasoning')" ${disabled ? 'disabled' : ''}>保存推理设置</button><button class="small" id="codex-catalog-sync" onclick="saveCodexConfig('sync_catalog')" ${disabled || !live.model_catalog_json ? 'disabled' : ''}>同步模型能力目录</button>`;
  const container = $('codex-config-controls');
  if (container.innerHTML !== controls && (force || !container.contains(document.activeElement))) container.innerHTML = controls;
}
async function saveCodexConfig(action) {
  if (curApp !== 'codex' || !online || codexConfigSaving || !state?.live?.codex?.revision) return;
  const live = state.live.codex;
  const effort = $('codex-reasoning').value;
  const body = { action, revision: action === 'reasoning' && codexConfigRevisionDraft ? codexConfigRevisionDraft : live.revision,
    ...(action === 'reasoning' ? { model_reasoning_effort: effort || null } : {}) };
  const message = action === 'sync_catalog'
    ? '从你现有的模型目录复制已知落点的能力到 mixr 别名，保留原目录；未知模型不猜测。Codex 需重启生效。'
    : `仅把 Codex 全局推理档位改为「${effort || '自动'}」，保留模型、MCP、插件和权限设置。原文件自动备份，Codex 需重启生效。`;
  if (!await askConfirm(action === 'sync_catalog' ? '同步 Codex 模型目录' : '保存 Codex 推理设置', message, '保存')) return;
  codexConfigSaving = true; renderCodexConfig(true);
  try {
    const result = await api('/api/codex/config', { method: 'POST', body: JSON.stringify(body) });
    if (result?.codex) state.live.codex = result.codex;
    codexReasoningDraft = null; codexConfigRevisionDraft = '';
    toast('Codex 配置已保存；重启 Codex 后生效', 'ok');
    await refresh();
  } catch (error) { toast('Codex 配置未保存：' + error.message, 'err'); }
  finally { codexConfigSaving = false; if (curApp === 'codex') renderCodexConfig(true); }
}
function renderCodexModels(force) {
  $('codex-models').hidden = !state || curApp !== 'codex';
  if (!state || curApp !== 'codex') return;
  renderCodexConfig(force);
  const rows = ['main', 'reviewer'].map(name => {
    const slot = (slotsOf().codex || []).find(s => s.name === name);
    const selected = slot?.provider || '';
    const options = providers('codex').filter(p => p.enabled || p.id === selected).map(p =>
      `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''} ${!p.enabled ? 'disabled' : ''}>${esc(p.name)} · ${esc(p.model || '未配置模型')}${p.enabled ? '' : '（停用）'}</option>`).join('');
    return `<label for="codex-model-${name}"><strong>${name === 'main' ? 'main · 主模型' : 'reviewer · 审查模型'}</strong><select id="codex-model-${name}" onchange="switchCodexModel('${name}',this.value)" ${!online || codexModelSaving ? 'disabled' : ''}><option value="" disabled ${!selected ? 'selected' : ''}>选择渠道与模型</option>${selected && !providers('codex').some(p => p.id === selected) ? `<option selected disabled value="${esc(selected)}">原渠道已删除</option>` : ''}${options}</select></label>`;
  }).join('');
  const fields = $('codex-model-fields');
  const focused = fields.contains(document.activeElement) ? document.activeElement.id : '';
  if (fields.innerHTML !== rows && (force || !focused)) {
    fields.innerHTML = rows;
    if (focused) $(focused)?.focus();
  }
  $('codex-model-apply').disabled = !online || codexModelSaving || !['main', 'reviewer'].every(name =>
    (slotsOf().codex || []).some(s => s.name === name && s.provider && s.enabled && s.model));
}
async function switchCodexModel(name, provider) {
  if (codexModelSaving || !online || !['main', 'reviewer'].includes(name)) return;
  const p = providers('codex').find(p => p.id === provider && p.enabled && p.model);
  if (!p) { renderCodexModels(true); return; }
  codexModelSaving = true;
  $('codex-model-status').textContent = '保存中…';
  renderCodexModels(true);
  try {
    const saved = await putSlot('codex', name, { provider });
    $('codex-model-status').textContent = saved ? `${name} 已保存：${p.name}` : '保存失败，选择未确认';
  } finally {
    codexModelSaving = false;
    renderCodexModels(true);
  }
}
function renderSlots(force) {
  renderCodexModels(force);
  const panel = $('slots-panel');
  // 外壳可能把同一块 slots-panel 放进 details#slots-details 并挪到渠道库下方:这里不另包
  // details(重复包裹会让折叠标题出现两次),只同步显隐;拿不到包装层就按老结构单独用 panel。
  const details = $('slots-details');
  if (!state || curApp === 'zcode') { panel.hidden = true; if (details) details.hidden = true; return; }
  panel.hidden = false; if (details) details.hidden = false;
  const isClaude = curApp === 'claude';
  $('slots-hint').textContent = isClaude
    ? '把每个槽位绑定到「渠道 @ 模型」：应用后客户端 env 写入别名（mixr-…），该槽的所有请求——含子代理与后台任务——按槽位落点分发，优先于路由规则。落点模型从渠道模型列表里挑，要写渠道没登记的模型名就选「自定义模型…」。'
    : 'Codex 槽位是路由别名：客户端处于路由模式后，codex exec -m mixr-<槽名> 即按槽位落点分发；GET /v1/models 也会列出这些别名。';
  $('slots-apply').hidden = false;
  $('slots-apply').disabled = !online;
  const list = slotsOf()[curApp] || [];
  const rows = isClaude
    ? list.map(claudeSlotRow).join('')
    : list.filter(s => !['main', 'reviewer'].includes(s.name)).map(codexSlotRow).join('') + `<div class="rc-line">
        <label class="field slot-ident">新槽位<span class="mono">别名 mixr-&lt;槽名&gt;</span></label>
        <label class="field" style="flex:1">槽位名<input id="slot-new-name" placeholder="如 worker" autocomplete="off" spellcheck="false"></label>
        <label class="field" style="flex:2">渠道<select id="slot-new-provider">${slotChannelOptions('', 'codex')}</select></label>
        <button class="small" style="align-self:center" onclick="addCodexSlot()" ${online ? '' : 'disabled'}>＋ 添加槽位</button>
      </div>`;
  // 轮询不重绘正在操作的槽位表:内容没变跳过;焦点在表内时不打扰。force=用户刚提交槽位改动,
  // 此时焦点多半还停在刚操作的 select 上,必须重绘否则落点模型下拉一直停留在旧渠道的选项,并把焦点放回原控件
  if ($('slots-rows').innerHTML !== rows && (force || !($('slots-rows').contains(document.activeElement) || activeDialog))) {
    const af = document.activeElement;
    const mark = $('slots-rows').contains(af) ? (af.id ? '#' + af.id : '[aria-label="' + (af.getAttribute('aria-label') || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]') : '';
    $('slots-rows').innerHTML = rows;
    if (mark) { const el = $('slots-rows').querySelector(mark); if (el) el.focus(); }
  }
}
async function putSlot(app, name, value) {
  if (!online) { toast('控制台离线，未保存槽位改动', 'err'); return false; }
  try {
    const r = await api('/api/slots', { method: 'PUT', body: JSON.stringify({ [app]: { [name]: value } }) });
    if (r?.slots) { state.slots = r.slots; renderSlots(true); }
    await refresh(); return true;
  }
  catch (e) { toast('槽位保存失败：' + e.message, 'err'); return false; }
}
async function setSlot(app, name, field, value) {
  if (field === 'provider' && !value) return clearSlot(app, name);
  const s = (slotsOf()[app] || []).find(x => x.name === name);
  if (!s) return;
  const val = field === 'provider'
    ? { provider: value, ...(app === 'claude' ? { model: (providers('claude').find(p => p.id === value)?.models || [s.model])[0] || '' } : {}) }
    : { provider: s.provider, model: value };
  if (await putSlot(app, name, val)) toast(`槽位 ${name} 已更新`, 'ok');
}
async function clearSlot(app, name) {
  if (await putSlot(app, name, null)) toast(`槽位 ${name} 已清空`, 'ok');
}
async function addCodexSlot() {
  const name = ($('slot-new-name').value || '').trim().toLowerCase();
  const provider = $('slot-new-provider').value;
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(name)) return toast('槽位名只能用小写字母、数字、连字符（≤24 位）', 'err');
  if (!provider) return toast('请选择渠道', 'err');
  if (await putSlot('codex', name, { provider })) { toast(`槽位 ${name} 已添加，别名 mixr-${name}`, 'ok'); $('slot-new-name').value = ''; }
}
async function applySlotsClaude() {
  if (curApp === 'codex') {
    if (!canConnect('codex')) return;
    const slots = slotsOf().codex || [];
    const selected = ['main', 'reviewer'].map(name => slots.find(s => s.name === name));
    if (selected.some(s => !s?.provider || !s.enabled || !s.model))
      return toast('请先配置 main 和 reviewer 槽位', 'err');
    const lines = selected.map(s => `${s.alias} → ${s.provider_name} @ ${s.model}`).join('\n');
    if (!await askConfirm('应用 Codex 槽位', `${lines}\n将写入 model / review_model，原配置自动备份。重启 Codex 后生效。`, '应用并切路由')) return;
    try {
      await api('/api/router/codex', { method: 'POST', body: JSON.stringify({ slots: true, revision: state.live?.codex?.revision }) });
      toast('Codex 槽位已写入；请重启 Codex 生效', 'ok'); await refresh();
    } catch (e) { toast('应用失败：' + e.message, 'err'); }
    return;
  }
  if (!canConnect('claude')) return;
  const configured = slotsOf().claude.filter(s => s.provider);
  const lines = configured.length
    ? configured.map(s => `· ${s.env}=${s.alias} → ${s.provider_name} @ ${s.model || '(渠道未配模型)'}`).join('\n')
    : '· 槽位表为空：本次只指向路由并清理以前写入的 mixr- 别名';
  const message = `将 Claude Code 指向 ${routerBase('claude') || '本地路由'}，并按当前槽位表同步槽位 env：\n${lines}\n未配置槽位的既有 mixr- 别名会被清掉；你手设的其他 env 值一律保留。\n写入 ${APPS.claude.cfg}（原文件自动备份），Claude Code 需重启会话生效。`;
  if (!await askConfirm('应用子代理槽位', message, '应用并切路由')) return;
  try {
    const res = await api('/api/router/claude', { method: 'POST', body: JSON.stringify({ slots: true }) });
    toastWithBackupWarnings('槽位 env 已写入；请重启 Claude Code 会话生效', res); await refresh();
  } catch (e) { toast('应用失败：' + e.message, 'err'); }
}

// ---------------- 压缩模型 ----------------
function loadCompactDraft() {
  if (!state?.compact) return;
  compactDraft = { provider: '', model: '', key_id: '', ...state.compact.selection };
  compactBase = state.compact.revision; compactDirty = false; compactCustom = false;
  renderCompactEditor(); updateCompactStatus();
}
// 还没保存过任何东西时,两块状态也要先摆出来(全是"尚未保存过"),否则用户看不出这里在分账。
renderSplitStatus();
function renderCompactCurrent() {
  const c = state?.compact;
  if (!c) { $('compact-current').textContent = '当前服务端不支持压缩选择'; return; }
  $('compact-current').innerHTML = (c.mode === 'mixed' ? '<b>当前为混合落点或未完整配置，不代表单一模型。</b><br>' : '')
    + (c.rules.map(r => `${esc(r.id)}${r.enabled ? '' : '（规则停用）'}：${r.targets.map(t => `${esc(t.name)} / ${esc(t.model || '透传请求模型')} / ${t.key_id ? '固定 Key ' + esc(t.key_label || t.key_id) + '（' + esc(t.key_id) + '）' : '跟随渠道当前 Key'}${t.key_available === false ? '（Key 不可用）' : ''}${t.enabled ? '' : '（渠道停用）'}`).join(' → ') || '无可用目标'}${r.has_pool ? '（渠道池）' : ''}`).join('<br>') || '尚无压缩规则；保存时创建两条规则。');
}
function renderCompactEditor() {
  if (!compactDraft) return;
  const list = state.compact.providers;
  $('compact-provider').innerHTML = '<option value="">（选择渠道）</option>' + list.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('compact-provider').value = compactDraft.provider;
  const models = list.find(p => p.id === compactDraft.provider)?.models || [];
  const custom = compactCustom || !!compactDraft.model && !models.includes(compactDraft.model);
  $('compact-model').innerHTML = '<option value="">（选择模型）</option>' + models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('') + '<option value="__custom__">自定义模型…</option>';
  $('compact-model').value = custom ? '__custom__' : compactDraft.model;
  $('compact-model').disabled = !compactDraft.provider;
  $('compact-model-custom').hidden = !custom;
  $('compact-model-custom').value = compactDraft.model;
  renderCompactKeys();
}
function compactKeySupported(c = state?.compact) {
  return c?.key_selection_supported === true && Array.isArray(c.providers)
    && c.providers.every(p => Array.isArray(p.keys)) && (!c.selection || Object.hasOwn(c.selection, 'key_id'));
}
function renderCompactKeys() {
  if (!compactDraft) return;
  if (!compactKeySupported()) {
    $('compact-key').innerHTML = `<option value="${esc(compactDraft.key_id)}">${compactDraft.key_id ? '未保存的固定 Key（' + esc(compactDraft.key_id) + '）' : '当前服务端不支持指定 Key'}</option>`;
    $('compact-key').value = compactDraft.key_id; $('compact-key').disabled = true;
    $('compact-key-hint').textContent = '当前服务端尚不支持指定Key，更新服务后可用。' + (compactDraft.key_id ? '原固定 Key 草稿保留，不能提交给旧服务；可重新载入放弃草稿。' : '渠道和模型仍可保存，本次不会提交 Key 选择。');
    return;
  }
  const provider = state.compact.providers.find(p => p.id === compactDraft.provider);
  const keys = provider?.keys || [], selected = keys.find(k => k.id === compactDraft.key_id);
  const active = keys.find(k => k.id === provider?.active_key);
  const missing = compactDraft.key_id && !selected;
  const options = '<option value="">跟随渠道当前 Key</option>'
    + keys.map(k => `<option value="${esc(k.id)}"${k.enabled === false ? ' disabled' : ''}>${esc(k.label || k.id)}（${esc(k.id)}）${k.enabled === false ? ' · 不可用' : ''}</option>`).join('')
    + (missing ? `<option value="${esc(compactDraft.key_id)}" disabled>已失效 Key（${esc(compactDraft.key_id)}）· 保留原选择</option>` : '');
  if ($('compact-key').innerHTML !== options) $('compact-key').innerHTML = options;
  $('compact-key').value = compactDraft.key_id;
  $('compact-key').disabled = !compactDraft.provider;
  $('compact-key-hint').textContent = missing || selected?.enabled === false
    ? '原固定 Key 已不可用，选择仍保留；请明确改选可用 Key 或跟随渠道当前 Key，不会自动替换。'
    : compactDraft.key_id ? '固定 Key 只影响两条压缩规则，不切换渠道当前账号。'
      : `跟随渠道当前 Key${active ? '：' + (active.label || active.id) + '（' + active.id + '）' : ''}；渠道切换当前账号后压缩也会跟随。`;
}
function updateCompactStatus() {
  if (!compactDraft) return;
  $('compact-msg').textContent = state?.compact?.revision !== compactBase ? '服务端路由已变化；压缩草稿保留，请重新载入后保存。'
    : routesDirty ? '通用路由有未保存草稿；先保存或重新载入通用路由。'
      : compactDirty ? '有未保存的压缩选择；自动刷新不会覆盖。' : '压缩选择与上次载入一致。';
  renderSplitStatus();
}
// 四段分开读:保存成功 / 已写盘 / 服务已加载 / 客户端需重开。没有状态时(还没保存过)
// 只写一句"尚未保存",不假装任何一段已经成立。
function splitStatusLine(label, ok, text) {
  const cls = ok === true ? 'ok' : ok === false ? 'no' : 'na';
  const mark = ok === true ? '✓' : ok === false ? '✗' : '·';
  return `<span class="ss-item ${cls}"><b aria-hidden="true">${mark}</b> ${esc(label)}：${esc(text)}</span>`;
}
function renderSplitStatus() {
  const box = $('compact-status');
  if (!box) return;
  const o = compactOutcome;
  box.innerHTML = '<div class="ss-title">保存结果(四件事分开看)</div><div class="ss-row">'
    + splitStatusLine('请求', o ? o.saved : null, o ? (o.saved ? '已成功返回' : o.error || '未成功') : '尚未保存过')
    + splitStatusLine('已写盘', o ? o.written : null, o ? (o.written ? '配置已写入服务端磁盘' : '未确认写盘') : '尚未保存过')
    + splitStatusLine('服务已加载', o ? o.loaded : null, o ? (o.loaded ? '运行中的服务按新压缩规则分发' : '未确认服务已加载') : '尚未保存过')
    + splitStatusLine('客户端需重开', o ? o.restart : null, o ? '不需要：压缩落点在服务端，客户端下次请求即用新规则' : '尚未保存过')
    + '</div>';
  renderWindowStatus();
}
// 窗口保存的四段与压缩模型不同:窗口是**磁盘配置**,服务端从不热读它——"已写盘"成立,
// "服务已加载"必然不成立(所以是 null 而不是 false),而"客户端需重开"是**成立**的。
// 这三段的真假正是用户最容易混淆的地方,所以按各自实际情况写,不套用一句话。
function renderWindowStatus() {
  const box = $('window-status');
  if (!box) return;
  const o = windowOutcome;
  box.innerHTML = '<div class="ss-title">保存结果(四件事分开看)</div><div class="ss-row">'
    + splitStatusLine('请求', o ? o.saved : null, o ? (o.saved ? '已成功返回' : o.error || '未成功') : '尚未保存过')
    + splitStatusLine('已写盘', o ? o.written : null, o ? (o.written ? '已写入所选配置层文件' : '未确认写盘') : '尚未保存过')
    + splitStatusLine('服务已加载', null, '不适用：外面改磁盘不会热改运行中的会话')
    + splitStatusLine('客户端需重开', o ? o.restart : null, o ? '需要：新开会话(或在该项目目录 claude --continue)才生效' : '尚未保存过')
    + '</div>';
}
function markCompactDirty() { compactDirty = true; compactRevision++; updateCompactStatus(); setConnection(online); }
function pickCompactProvider(provider) {
  compactDraft.provider = provider; compactDraft.model = ''; compactDraft.key_id = ''; compactCustom = false;
  markCompactDirty(); renderCompactEditor();
}
function pickCompactModel(model) {
  compactCustom = model === '__custom__';
  if (!compactCustom) compactDraft.model = model;
  markCompactDirty(); renderCompactEditor();
}
function pickCompactKey(key_id) {
  if (!compactKeySupported()) return;
  compactDraft.key_id = key_id; markCompactDirty(); renderCompactKeys();
}
function setCompactCustom(value) { compactDraft.model = value; markCompactDirty(); }
async function reloadCompact() {
  if (savingCompact) return;
  if (compactDirty && !await askConfirm('重新载入压缩选择', '丢弃未保存的压缩选择，使用服务端当前落点？', '重新载入')) return;
  if (await refresh()) loadCompactDraft();
}
async function saveCompact() {
  if (!online || !compactDraft || savingCompact || savingRoutes) return;
  if (routesDirty) return toast('通用路由有未保存草稿，请先保存或重新载入；压缩选择未提交', 'err');
  const provider = compactDraft.provider, model = compactDraft.model.trim(), key_id = compactDraft.key_id, keySupported = compactKeySupported();
  if (!provider || !model) return toast('请选择压缩渠道和非空模型名', 'err');
  if (key_id && !keySupported) return toast('当前服务端尚不支持指定Key，更新服务后可用；固定 Key 草稿未提交', 'err');
  const key = state.compact.providers.find(p => p.id === provider)?.keys?.find(k => k.id === key_id);
  if (key_id && (!key || key.enabled === false)) return toast('固定 Key 已不可用；请明确改选可用 Key 或跟随渠道当前 Key', 'err');
  if (compactBase !== state.compact.revision) return toast('服务端路由已变化，请重新载入压缩选择', 'err');
  const revision = compactRevision, routeRevision = routesRevision, expected_revision = compactBase;
  const keyText = !keySupported ? '服务端不支持指定 Key，本次只保存渠道与模型' : key_id ? `固定 Key ${key.label || key.id}（${key.id}）` : '跟随渠道当前 Key';
  if (!await askConfirm('保存压缩模型', `只将两条压缩规则同步改为 ${provider} / ${model} / ${keyText}，并替换现有压缩备池为单一渠道。普通模型、普通路由、子代理槽位和渠道当前 Key（active_key）均不变。`, '保存压缩模型')) return;
  if (routesDirty || savingRoutes || savingCompact) return toast('路由草稿已变化，请先处理通用路由', 'err');
  if (keySupported && !compactKeySupported()) return toast('服务端 Key 支持状态已变化，请重新确认；选择未提交', 'err');
  savingCompact = true; setConnection(online);
  // 服务端是否成功回包与"要不要继续抛"是两件事:Key 未确认那条分支是在**回包之后**抛的,
  // 那时请求其实已经成功、配置多半也已落盘。分开记,免得失败提示把"可能已写入"说成"没写"。
  let responseOk = false;
  try {
    const result = await api('/api/compact', { method: 'POST', body: JSON.stringify({ provider, model, ...(keySupported ? { key_id } : {}), expected_revision }) });
    responseOk = true;   // 请求本身成功了;后面若因响应不完整而抛,也不该说成"没发生过"
    if (!result.compact || !result.routes) throw new Error('服务端未返回完整压缩配置');
    if (keySupported && (!compactKeySupported(result.compact) || result.compact.selection?.key_id !== key_id)) {
      state.compact = result.compact; state.routes = result.routes; state.routes_revision = result.compact.revision;
      compactDirty = true; renderCompactCurrent(); renderCompactKeys(); updateCompactStatus(); updateRouteStatus();
      // 请求成功了,但服务端没确认 Key 选择 —— 写盘与加载都无从确认,只能如实标"未确认"。
      compactOutcome = { saved: true, written: null, loaded: null, restart: false, error: '服务端未确认 Key 选择' };
      renderSplitStatus();
      throw new Error('服务端未确认 Key 选择；渠道和模型可能已写入，固定 Key 草稿保留，请更新服务并重新读取核对');
    }
    state.compact = result.compact; state.routes = result.routes; state.routes_revision = result.compact.revision;
    compactBase = result.compact.revision;
    if (compactRevision === revision) loadCompactDraft();
    if (!routesDirty && routesRevision === routeRevision) {
      routesDraft = structuredClone(result.routes); routesBase = JSON.stringify(result.routes); routesBaseRevision = result.compact.revision; renderRoutes();
    }
    renderCompactCurrent(); updateCompactStatus(); updateRouteStatus();
    // 四段都成立:POST 成功返回(服务端 saveRoutes 之后才回包,所以"已写盘"是服务端的保证)、
    // 运行中的服务读的就是同一份内存路由(压缩不重载进程)、客户端不需重开(下次请求即新规则)。
    // 这三句都是**依据**,不是"看起来像"——所以这里敢把三段都标成 ✓。
    compactOutcome = { saved: true, written: true, loaded: true, restart: false, error: '' };
    renderSplitStatus();
    toast('压缩模型已保存；两条规则的旧备池已替换', 'ok');
  } catch (e) {
    // 已经回过包的那条分支上面自己写过 compactOutcome,不要被这里覆盖成"什么都没发生"。
    if (!responseOk) {
      compactOutcome = { saved: false, written: false, loaded: false, restart: false, error: e.message };
      renderSplitStatus();
    }
    toast('压缩选择保存失败：' + e.message, 'err');
  }
  finally { savingCompact = false; setConnection(online); }
}

// ---------------- 压缩上下文窗口 ----------------
const windowLabel = { global: '用户全局', project: '项目', local: '项目本地', auto: '下层继承' };
function invalidateWindowSelection(message) {
  windowSelectionRevision++; $('window-msg').textContent = message;
  $('window-coverage-text').textContent = '配置层或项目目录已变化，当前选择的覆盖情况尚未检查；请读取所选配置层。';
  $('window-coverage').classList.add('offline'); $('window-edit-override').hidden = true; setConnection(online);
}
function windowProjectChanged() { invalidateWindowSelection('项目目录已变化，请读取所选配置层；未保存窗口值暂保留。'); }
function selectWindowScope() { invalidateWindowSelection('配置层已变化，请读取所选配置层；未保存窗口值暂保留。'); }
function setWindowValue(value) { $('window-value').value = value; windowDirty = true; windowRevision++; $('window-msg').textContent = '窗口草稿未保存；状态刷新不会覆盖。'; setConnection(online); }
function windowSelection() {
  const scope = $('window-scope').value || 'global', project = $('window-project').value.trim();
  if (project && !project.startsWith('/')) throw new Error('项目目录须为绝对路径');
  if (scope !== 'global' && !project) throw new Error('请填写项目绝对路径');
  return { scope, project };
}
function windowSelectionMatches(selected) {
  return ($('window-scope').value || 'global') === selected.scope && $('window-project').value.trim() === selected.project;
}
function windowQuery({ scope, project }) {
  const query = new URLSearchParams({ scope });
  if (project) query.set('project', project);
  return '/api/compact/window?' + query.toString();
}
function windowCoverage(w) {
  if (w.coverage) return w.coverage;
  const order = ['global', 'project', 'local'];
  return { project_checked: !!w.project,
    overridden_by: order.indexOf(w.configured.source) > order.indexOf(w.scope) ? w.configured.source : null,
    environment_override: w.layers.some(layer => layer.env_override) };
}
function windowCoverageText(w, saved = false) {
  const coverage = windowCoverage(w), notes = [];
  if (!coverage.project_checked) notes.push('项目未检查：未指定项目，尚未核对项目与本地层覆盖，不能判断某个项目的有效窗口。');
  if (coverage.overridden_by) notes.push(`${saved ? '仍被' : '所选层被'}${windowLabel[coverage.overridden_by]}层覆盖：${w.configured.value} token；保存本层不会改变该项目的有效磁盘值。`);
  else if (coverage.project_checked) notes.push('已检查指定项目：所选层未被更高磁盘层覆盖；这不是运行中会话的实测值。');
  if (coverage.environment_override) notes.push('存在环境覆盖：本控件不能清除，改值或设 auto 均不会删除它，不能据此确认会话窗口。');
  return notes.join(' ');
}
function renderCompactWindow(w, preserveValue = false) {
  if (!preserveValue) $('window-value').value = String(w.value);
  $('window-current').textContent = `所选 ${windowLabel[w.scope]}：${w.value} token · ${w.target}；磁盘配置优先层 ${windowLabel[w.configured.source] || w.configured.source}：${w.configured.value} token（非运行中会话实测）。`;
  $('window-coverage-text').textContent = windowCoverageText(w);
  const coverage = windowCoverage(w);
  $('window-coverage').classList.toggle('offline', !coverage.project_checked || !!coverage.overridden_by || coverage.environment_override);
  $('window-edit-override').hidden = !coverage.overridden_by;
  $('window-layers').innerHTML = w.layers.map(layer => `${esc(windowLabel[layer.scope] || layer.scope)}：${esc(layer.value)} · ${esc(layer.file)}${layer.exists ? '' : '（文件不存在）'}${layer.env_override ? '（存在环境覆盖）' : ''}`).join('<br>');
  $('window-warnings').textContent = (w.warnings || []).join('\n') || '当前没有额外警告；这里只显示磁盘配置。';
  $('window-restart').textContent = '外部保存不会热改运行中会话。项目层设置需新开会话，或退出后在该项目目录用 claude --continue 继续。当前会话可用 /autocompact <值> 调整，但它写用户层，仍可能被项目或环境覆盖；请核对窗口与 capped 提示。';
}
async function editWindowOverride() {
  if (!windowSnapshot || savingWindow || windowLoadTask) return;
  const scope = windowCoverage(windowSnapshot).overridden_by;
  if (!scope) return;
  let selected;
  try { selected = windowSelection(); } catch (e) { $('window-msg').textContent = e.message; return; }
  if (selected.scope !== windowSnapshot.scope || selected.project !== windowSnapshot.project) return $('window-msg').textContent = '配置层或目录已变化，请先读取，不能使用旧覆盖信息。';
  const revision = windowRevision, selectionRevision = windowSelectionRevision;
  if (windowDirty && !await askConfirm('编辑覆盖层', '丢弃尚未保存的窗口草稿，读取覆盖层？这一步不会写入或删除任何配置。', '读取覆盖层')) return;
  if (revision !== windowRevision || selectionRevision !== windowSelectionRevision || savingWindow || windowLoadTask) return;
  windowDirty = false; $('window-scope').value = scope; selectWindowScope();
  await loadCompactWindow();
}
async function loadCompactWindow() {
  if (windowLoadTask || savingWindow) return;
  let selected;
  try { selected = windowSelection(); } catch (e) { $('window-msg').textContent = e.message; return; }
  const loadRevision = windowRevision, selectionRevision = windowSelectionRevision;
  if (windowDirty && !await askConfirm('重新读取压缩窗口', '丢弃尚未保存的窗口值，读取磁盘上的所选配置层？', '重新读取')) return;
  if (windowRevision !== loadRevision || windowSelectionRevision !== selectionRevision || savingWindow || windowLoadTask) return;
  windowLoadTask = api(windowQuery(selected)); setConnection(online);
  try {
    const { window: w } = await windowLoadTask;
    if (!w || typeof w.revision !== 'string') throw new Error('服务端未返回窗口版本');
    if (windowSelectionRevision !== selectionRevision || !windowSelectionMatches(selected)) return;
    if (w.project !== selected.project) $('window-project').value = w.project;
    windowSnapshot = w;
    if (windowRevision === loadRevision) { windowDirty = false; renderCompactWindow(w); $('window-msg').textContent = '已从磁盘读取；尚未更改配置。'; }
    else { renderCompactWindow(w, true); $('window-msg').textContent = '读取期间改动的窗口草稿仍保留；保存将使用读取时的版本号。'; }
  } catch (e) { $('window-msg').textContent = '读取失败：' + e.message; }
  finally { windowLoadTask = null; setConnection(online); }
}
async function saveCompactWindow() {
  if (!online || !windowSnapshot || !windowDirty || savingWindow || windowLoadTask) return;
  let selected;
  try { selected = windowSelection(); } catch (e) { $('window-msg').textContent = e.message; return; }
  if (selected.scope !== windowSnapshot.scope || selected.project !== windowSnapshot.project) return $('window-msg').textContent = '配置层或目录已变化，请重新读取。';
  const raw = $('window-value').value.trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  const numeric = match ? Number(match[1]) * (match[2] === 'm' ? 1000000 : match[2] === 'k' ? 1000 : 1) : NaN;
  if (raw !== 'auto' && (!Number.isSafeInteger(numeric) || numeric < windowSnapshot.min || numeric > windowSnapshot.max)) {
    $('window-msg').textContent = '请输入 auto 或 100k–1M token 的整数值'; return;
  }
  const value = raw === 'auto' ? 'auto' : numeric;
  const revision = windowRevision, selectionRevision = windowSelectionRevision, expected_revision = windowSnapshot.revision;
  const meaning = raw === 'auto' ? '只删除这一层的 autoCompactWindow 并继承下层，不删除其他层或环境设置' : `只将这一层设为 ${value} token`;
  if (!await askConfirm('保存压缩窗口', `${meaning}，目标文件：${windowSnapshot.target}。全局只改全局，不同步项目。${windowCoverageText(windowSnapshot)} 外部保存不会热改运行中会话；项目设置需新开会话，或退出后在该项目目录用 claude --continue 继续并核对。`, '保存窗口')) return;
  if (savingWindow || windowLoadTask || windowSelectionRevision !== selectionRevision || !windowSelectionMatches(selected)) return;
  if (windowRevision !== revision) { $('window-msg').textContent = '确认期间窗口值已变化；请重新确认当前值。'; return; }
  savingWindow = true; setConnection(online);
  try {
    const result = await api('/api/compact/window', { method: 'POST', body: JSON.stringify({ ...selected, value, expected_revision }) });
    if (!result.window) throw new Error('服务端未返回窗口配置');
    // 请求成功 + 服务端回了写盘结果 ⇒ 已写盘成立;服务不热读磁盘 ⇒ "已加载"不适用;
    // 新开会话才生效 ⇒ "客户端需重开"成立。三段各自记录,不揉成一句"已生效"。
    windowOutcome = { saved: true, written: true, restart: true, error: '' };
    renderSplitStatus();
    const resultText = `窗口已保存到所选磁盘文件。${windowCoverageText(result.window, true)} 外部保存不会热改运行中会话。`;
    if (windowSelectionRevision === selectionRevision && windowSelectionMatches(selected)) {
      windowSnapshot = result.window;
      if (windowRevision === revision) windowDirty = false;
      renderCompactWindow(result.window, windowDirty);
      $('window-msg').textContent = resultText + (windowDirty ? ' 后续编辑仍在草稿中。' : ' 需新开会话核对。');
    } else $('window-msg').textContent = resultText + ' 配置层或目录已变化，当前选择与草稿保留，请重新读取。';
    const coverage = windowCoverage(result.window);
    toast(resultText, !coverage.project_checked || coverage.overridden_by || coverage.environment_override ? 'err' : 'ok');
  } catch (e) {
    windowOutcome = { saved: false, written: false, restart: true, error: e.message };
    renderSplitStatus();
    $('window-msg').textContent = '保存失败：' + e.message;
  }
  finally { savingWindow = false; setConnection(online); }
}

// ---------------- 路由 ----------------
const STRAT_LABEL = { priority: '主备(按池序,主挂了才降级)', round_robin: '轮询(新对话依次分配)', weighted: '加权(按权重比例)', least_used: '最少会话优先', random: '随机' };
function blankRule() {
  return { id: 'r' + Date.now(), match: '', provider: '', model: '', pool: [], strategy: 'round_robin', priority: 0, app: '', when: {}, enabled: true };
}
const poolModes = new WeakSet();
function updateRouteStatus() {
  if (!routesDraft) return;
  const changed = state && JSON.stringify(state.routes) !== routesBase;
  $('save-msg').textContent = changed ? '服务端配置已变化；草稿保留，重新载入可获取最新配置。' : routesDirty ? '有未保存更改 · 自动刷新不会覆盖草稿' : '草稿与上次载入一致 · 自动刷新不重绘表单';
}
function markRoutesDirty() { routesDirty = true; routesRevision++; updateRouteStatus(); updateCompactStatus(); setConnection(online); }
const routeInput = e => { if (!$('compact-panel').contains(e.target) && !$('compact-window-panel').contains(e.target) && e.target.matches('input, select')) markRoutesDirty(); };
$('view-routes').addEventListener('input', routeInput);
$('view-routes').addEventListener('change', routeInput);
window.addEventListener('beforeunload', e => { if (routesDirty || compactDirty || windowDirty || routingDirty || (activeDialog?.id === 'mask')) { e.preventDefault(); e.returnValue = ''; } });
function renderRoutes() {
  if (!routesDraft) return;
  const focused = document.activeElement;
  const focusId = $('view-routes').contains(focused) ? focused.id : null;
  $('rules-box').innerHTML = routesDraft.rules.length ? routesDraft.rules.map(ruleCard).join('') : '<div class="empty"><b>尚无匹配规则</b>请求将使用默认路由。添加规则可按模型、会话或客户端条件分流。</div>';
  $('def-box').innerHTML = ruleTargetBox(routesDraft.default, 'def', '兜底') + ruleFacts(routesDraft.default, true);
  if (focusId && $(focusId)) $(focusId).focus();
}
function appOfRule(r) {
  if (r.app === 'codex' || r.app === 'claude') return r.app;
  const ids = [(r.pool || []).map(m => typeof m === 'string' ? m : m.provider), r.provider ? [r.provider] : []].flat().filter(Boolean);
  return ids.some(id => providers('codex').some(p => p.id === id)) ? 'codex' : 'claude';
}
function ruleCard(r, i) {
  const app = appOfRule(r);
  return `<div class="rulecard"><div class="rc-head"><span class="rc-idx">${i + 1}</span>
    <label class="field" for="rule-${i}-match">匹配模型<input id="rule-${i}-match" type="text" value="${esc(r.match)}" oninput="routesDraft.rules[${i}].match=this.value" placeholder="如 opus, claude-3-opus, gpt-5"></label>
    <label class="rc-mini">适用<select id="rule-${i}-app" onchange="setRuleApp(${i},this.value)"><option value="" ${r.app ? '' : 'selected'}>两组通用</option><option value="claude" ${r.app === 'claude' ? 'selected' : ''}>Claude / Anthropic</option><option value="codex" ${r.app === 'codex' ? 'selected' : ''}>Codex / OpenAI</option></select></label>
    <label class="rc-mini">优先级<input type="number" value="${Number(r.priority) || 0}" oninput="routesDraft.rules[${i}].priority=Number(this.value)||0"></label>
    <label class="rc-mini"><input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="routesDraft.rules[${i}].enabled=this.checked">启用</label>
    <button class="iconbtn" onclick="delRule(${i})" aria-label="删除第 ${i + 1} 条规则">×</button></div>
    <div class="rc-body">${ruleTargetBox(r, i, '目标')}<div class="rc-line"><span class="rc-tag">条件</span>
    ${[['session', '会话 ID', '会话 id 含…'], ['ua', '客户端 UA', '客户端 UA 含…'], ['token', '客户端 token', '客户端 token 含…'], ['body', '请求内容', '请求体含…（内容分流，先于槽位）']].map(([key, label, placeholder]) => `<label class="field">${label}（可选）<input type="text" value="${esc(r.when?.[key] || '')}" oninput="setWhen(${i},'${key}',this.value)" placeholder="${placeholder}"></label>`).join('')}
    </div>${ruleFacts(r, false)}<div class="pool-hint">目标渠道属于 ${GROUPS[app]} 协议组；另一组请求会跳过不兼容的目标继续匹配。ZCode 按所选协议归组。</div></div></div>`;
}
// 规则的"来源/协议/最近实际落点"一角。前两项是静态只读推导;最后一项**只认会话里的 actual**,
// 没有真实请求记录就写「暂无」——绝不用 /api/routing/preview 的预测冒充实际落点(第二期硬要求)。
// isDefault 用来把"默认路由"和"显式规则"分开说:两者在界面上的位置不同,读的人要能一眼分清。
function ruleFacts(r, isDefault) {
  const app = appOfRule(r);
  const isPool = (r.pool || []).length > 0 || poolModes.has(r);
  const sourceText = r.app ? '显式规则 · 限定 ' + GROUPS[r.app] : (isDefault ? '默认路由 · 所有规则未命中时使用' : '通用规则 · 按目标归组');
  const strategyText = isPool ? (STRATEGY_SHORT[ruleStrategy(r)] || ruleStrategy(r)) : '单一渠道';
  const ids = [...new Set([r.provider, ...(r.pool || []).map(m => typeof m === 'string' ? m : m.provider)].filter(Boolean))];
  const wires = ids.map(id => {
    const p = providers(app).find(x => x.id === id);
    return p ? `${p.name} · ${wireLabel(p, app)}` : `已删除渠道（${id}）`;
  });
  const actual = actualRefsOf(r);
  return `<div class="rulefacts">
    <div><span class="rf-label">配置来源</span><span>${esc(sourceText)}</span></div>
    <div><span class="rf-label">分配策略</span><span>${esc(strategyText)}</span></div>
    <div><span class="rf-label">协议</span><span>${wires.length ? wires.map(esc).join('、') : '未绑定渠道'}</span></div>
    <div><span class="rf-label">最近实际落点</span><span>${actual.length ? actual.map(a => esc(a)).join('；') : '暂无'}</span></div>
  </div>`;
}
// 服务端给的状态里没有 strategy 字段时,按 rules 的默认(round_robin)算,与 normalizeRule 同口径。
const ruleStrategy = r => r.strategy || 'round_robin';
const STRATEGY_SHORT = { priority: '主备', round_robin: '轮询', weighted: '加权', least_used: '最少会话', random: '随机' };
const wireLabel = (p, app) => app === 'claude'
  ? (p.wire_api === 'responses' ? 'responses（转换）' : p.wire_api === 'chat' ? 'chat（转换）' : 'anthropic')
  : (p.wire_api === 'chat' ? 'chat' : 'responses');
// 这条规则最近真的把请求落到过哪 —— 只看会话记下来的 actual(服务端只记真实请求)。
// 池按成员逐个收,单选按目标收;两者都按渠道聚合,顺带报最近一次的状态码。
function actualRefsOf(r) {
  const ids = new Set([r.provider, ...(r.pool || []).map(m => typeof m === 'string' ? m : m.provider)].filter(Boolean));
  if (!ids.size) return [];
  const seen = new Map();
  for (const s of state?.sessions || []) {
    const a = actualOf(s);
    if (!a || !a.provider || !ids.has(a.provider)) continue;
    const prev = seen.get(a.provider);
    if (!prev || (a.ts || 0) >= (prev.ts || 0)) seen.set(a.provider, a);
  }
  return [...seen.values()].map(a => `${a.provider_name || a.provider}${a.status ? '（' + a.status + '）' : ''}`);
}
function ruleTargetBox(r, key, label) {
  const isPool = poolModes.has(r) || (r.pool || []).length > 0;
  const app = appOfRule(r), field = key === 'def' ? 'routesDraft.default' : `routesDraft.rules[${key}]`;
  const ids = new Set((r.pool || []).map(m => typeof m === 'string' ? m : m.provider));
  const wOf = id => { const m = (r.pool || []).find(x => typeof x === 'object' && x && x.provider === id); return m?.weight || ''; };
  // 池里指向"已删除渠道"的成员在下拉/勾选框里根本没有对应项,不摆出来用户就看不到,
  // 保存时又会被服务端按僵尸引用拒绝(报的是他界面上找不到的 id)
  const ghosts = [...ids].filter(id => !providers(app).some(p => p.id === id))
    .map(id => `<div class="poolitem on"><label><input type="checkbox" checked disabled><span>⚠ 渠道已删除（${esc(id)}）</span><span class="badge off">失效</span></label><label><button class="iconbtn" onclick="dropPoolMember('${key}',${handlerArg(id)})" aria-label="移除失效成员 ${esc(id)}">移除</button></label></div>`).join('');
  const members = ghosts + providers(app).map((p, i) => `<div class="poolitem ${ids.has(p.id) ? 'on' : ''}"><label><input id="pool-${key}-${i}" type="checkbox" ${ids.has(p.id) ? 'checked' : ''} onchange="togglePool('${key}',${handlerArg(p.id)},this.checked)"><span>${esc(p.name)}</span>${p.enabled ? '' : '<span class="badge off">停用</span>'}</label><label>权重<input class="w" type="number" min="1" value="${esc(wOf(p.id))}" aria-label="${esc(p.name)} 的权重" oninput="setWeight('${key}',${handlerArg(p.id)},this.value)"></label></div>`).join('');
  return `<div class="rc-line"><span class="rc-tag">${label}</span>
    ${key === 'def' ? `<label class="field">协议组<select id="default-app" onchange="setDefaultApp(this.value)"><option value="claude" ${app === 'claude' ? 'selected' : ''}>Claude / Anthropic</option><option value="codex" ${app === 'codex' ? 'selected' : ''}>Codex / OpenAI</option></select></label>` : ''}
    <label class="field">目标类型<select id="target-${key}-mode" onchange="setPoolMode('${key}',this.value)"><option value="single" ${isPool ? '' : 'selected'}>单一渠道</option><option value="pool" ${isPool ? 'selected' : ''}>渠道池（多对话分流）</option></select></label>
    ${isPool ? `<label class="field">分配策略<select onchange="${field}.strategy=this.value">${Object.keys(STRAT_LABEL).map(s => `<option value="${s}" ${r.strategy === s ? 'selected' : ''}>${STRAT_LABEL[s]}</option>`).join('')}</select></label>` : `<label class="field">目标渠道<select onchange="${field}.provider=this.value">${ruleOpts(r.provider, app)}</select></label>`}
    <label class="field">目标模型<input type="text" value="${esc(r.model || '')}" oninput="${field}.model=this.value" placeholder="${app === 'codex' ? '留空用渠道自带模型名' : '留空透传请求模型'}"></label>
    ${isPool ? `<div class="poolbox">${members || `<span class="pool-hint">还没有 ${GROUPS[app]} 渠道，请先在渠道页添加。</span>`}</div>` : ''}</div>`;
}
function ruleOpts(sel, app = 'claude') {
  const list = providers(app);
  // 选中的渠道已经不存在(渠道被删了、或 routes.json 是手改/旧备份恢复的):
  // 以前这个 id 不在下拉列表里,浏览器就默认显示第一项"未绑定",可草稿里仍是那个幽灵 id——
  // 界面说"没绑定"、保存时又原样回传,用户根本看不出哪条规则出了问题。
  // 显式补一个选项把它摆出来,用户改选一个真渠道即可。
  const ghost = sel && !list.some(p => p.id === sel)
    ? `<option value="${esc(sel)}" selected>⚠ 渠道已删除（${esc(sel)}）</option>` : '';
  return '<option value="">未绑定</option>' + ghost
    + list.map(p => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}${p.enabled ? '' : '（停用）'}</option>`).join('');
}
function draftOf(key) { return key === 'def' ? routesDraft.default : routesDraft.rules[Number(key)]; }
function changeRuleGroup(r, app) {
  if (app) r.app = app; else delete r.app;
  const group = providers(app || appOfRule(r));
  r.pool = (r.pool || []).filter(m => group.some(p => p.id === (typeof m === 'string' ? m : m.provider)));
  if (r.provider && !group.some(p => p.id === r.provider)) r.provider = '';
  markRoutesDirty(); renderRoutes();
}
function setRuleApp(i, v) { changeRuleGroup(routesDraft.rules[i], v); }
function setDefaultApp(v) { changeRuleGroup(routesDraft.default, v); }
function setPoolMode(key, mode) {
  const r = draftOf(key), first = providers(appOfRule(r))[0];
  if (mode === 'pool') { poolModes.add(r); r.pool = first ? [{ provider: first.id }] : []; r.provider = ''; }
  else { poolModes.delete(r); r.pool = []; r.provider = r.provider || first?.id || ''; }
  markRoutesDirty(); renderRoutes();
}
function togglePool(key, id, on) {
  const r = draftOf(key), list = (r.pool || []).map(m => typeof m === 'string' ? { provider: m } : m);
  poolModes.add(r); r.pool = on ? list.concat([{ provider: id }]) : list.filter(m => m.provider !== id);
  markRoutesDirty(); renderRoutes();
}
// 摘掉池里指向已删除渠道的成员(界面上那个"⚠ 渠道已删除"项)
function dropPoolMember(key, id) {
  const r = draftOf(key);
  r.pool = (r.pool || []).map(m => typeof m === 'string' ? { provider: m } : m).filter(m => m.provider !== id);
  poolModes.add(r);
  markRoutesDirty(); renderRoutes();
}
function setWeight(key, id, val) {
  const r = draftOf(key), n = Number(val);
  r.pool = (r.pool || []).map(m => { const o = typeof m === 'string' ? { provider: m } : { ...m }; if (o.provider === id) { if (Number.isFinite(n) && n > 0) o.weight = n; else delete o.weight; } return o; });
}
function setWhen(i, field, val) { const r = routesDraft.rules[i]; r.when = r.when || {}; if (val.trim()) r.when[field] = val; else delete r.when[field]; }
function addRule() { if (!routesDraft) return; routesDraft.rules.push(blankRule()); markRoutesDirty(); renderRoutes(); $('rule-' + (routesDraft.rules.length - 1) + '-match').focus(); }
function delRule(i) { routesDraft.rules.splice(i, 1); markRoutesDirty(); renderRoutes(); $('add-rule').focus(); }
async function reloadRoutes() {
  if (routesDirty && !await askConfirm('重新载入路由', '丢弃未保存草稿，使用服务端的最新路由配置？', '重新载入')) return;
  if (!await refresh()) return;
  routesDraft = structuredClone(state.routes); routesBase = JSON.stringify(state.routes); routesBaseRevision = state.routes_revision || ''; routesDirty = false;
  renderRoutes(); updateRouteStatus(); updateCompactStatus(); setConnection(online); toast('已载入最新路由', 'ok');
}
let savingRoutes = false;
async function saveRoutes() {
  if (!routesDraft || !online || savingRoutes || savingCompact) return;
  if (compactDirty) return toast('压缩选择有未保存草稿，请先保存或重新载入压缩选择', 'err');
  if (JSON.stringify(state.routes) !== routesBase && !await askConfirm('覆盖服务端路由', '服务端路由已变化。保存将以当前草稿覆盖服务端配置，是否继续？', '保存草稿')) return;
  if (compactDirty || savingCompact) return toast('压缩草稿已变化，请先处理压缩选择', 'err');
  const payload = JSON.stringify(routesDraft), revision = routesRevision;
  const expected = JSON.stringify(state.routes) === routesBase ? routesBaseRevision : state.routes_revision;
  savingRoutes = true; setConnection(online);
  try {
    const result = await api('/api/routes', { method: 'PUT', body: JSON.stringify({ ...routesDraft, ...(expected ? { expected_revision: expected } : {}) }) });
    routesBase = payload; routesBaseRevision = result.routes_revision || ''; routesDirty = routesRevision !== revision;
    toast(routesDirty ? '已保存提交时的路由；后续编辑仍在草稿中' : '路由已保存', 'ok'); await refresh(); updateRouteStatus();
    if (!compactDirty) loadCompactDraft();
  } catch (e) { toast('保存失败：' + e.message, 'err'); }
  finally { savingRoutes = false; setConnection(online); }
}

// ---------------- 会话 ----------------
const KIND_LABEL = { header: '会话头', metadata: 'metadata', fingerprint: '内容指纹', anon: '无身份' };
let sessApp = '', sessQuery = '';
// 会话页要同时读出三层,不能混成一个"已绑定":
//   required(用户要求) —— 本会话的渠道级 Key / 槽位覆盖,见 routingCell()
//   bound(当前绑定)    —— 现在会落到哪个渠道,以及这个落点是手动钉的还是自动分的
//   actual(最近实际请求)—— 最近一次**真的发出去**的请求落在哪;没有记录就是「暂无」
// 新版 /api/state 直接给结构化的 bound/actual;旧快照只有平铺的 provider/pinned,
// 这里按同一口径补齐,而不是让缺字段渲染成"未绑定"或"暂无"(那会把两种完全不同的情况
// 显示成一样)。补齐只影响显示,不改 state 本身。
function boundOf(s) {
  if (s.bound && typeof s.bound === 'object') return s.bound;
  const provider = s.provider || '';
  return { provider, provider_name: s.provider_name || '', model: s.model || '', rule: s.rule || '',
    pinned: !!s.pinned, source: !provider ? 'none' : (s.pinned ? 'manual' : 'auto') };
}
// 只有服务端记了实际请求才算实际落点。actual_source 缺省(旧快照)时以 actual 是否存在为准。
function actualOf(s) {
  if (s.actual_source === 'none') return null;
  return s.actual && typeof s.actual === 'object' ? s.actual : null;
}
// 绑定来源。显式 source 优先;旧快照没有 source 就用 pinned 推。
// 没有落点就无从谈来源,一律 none —— 免得"渠道被删了但绑定还在"被显示成自动分配。
function boundSourceOf(b) {
  if (!b.provider) return 'none';
  if (b.source === 'manual' || b.source === 'auto') return b.source;
  return b.pinned ? 'manual' : 'auto';
}
const BOUND_SOURCE = { manual: ['手动钉定', 'pin'], auto: ['自动分配', 'auto'], none: ['未绑定', 'off'] };
// 搜索框里没有筛东西、也没选协议组 —— 空表的文案要按它决定该劝"换关键词"还是"换分组"。
const sessionFiltered = () => !!sessQuery.trim() || !!sessApp;
// 搜索命中面:短 id / 完整 id / 对话名 / 绑定渠道(名字与 id 都算)。
// 渠道名要现查一次 state.providers —— 会话记录里的 provider_name 在旧快照里没有。
function sessionMatches(s, q) {
  const b = boundOf(s);
  const p = (state?.providers?.[s.app || 'claude'] || []).find(x => x.id === b.provider);
  return [s.short, s.key, s.label, b.provider, b.provider_name, p?.name]
    .some(x => String(x || '').toLowerCase().includes(q));
}
// 搜索框的输入只准重渲染,不准碰任何数据。曾经有过"压缩控件冒泡事件污染通用路由草稿"的事故,
// 所以这里写死:setSessQuery 只改 sessQuery 这个筛选词,会话、routesDraft、compactDraft 一概不动。
// 过滤后的行数变化只发生在渲染层(state.sessions 始终是服务端那一份)。
function setSessQuery(value) {
  sessQuery = String(value ?? '');
  renderSessions();
}
function clearSessionFilters() {
  sessQuery = ''; sessApp = '';
  const sel = $('f-sess-app');
  if (sel) sel.value = '';
  const search = $('sess-search');
  if (search) search.value = '';
  renderSessions();
}
function renderSessions() {
  if (!state) return;
  const all = state.sessions || [];
  const inApp = sessApp ? all.filter(s => (s.app || 'claude') === sessApp) : all;
  const q = sessQuery.trim().toLowerCase();
  const list = q ? inApp.filter(s => sessionMatches(s, q)) : inApp;

  $('sess-empty').style.display = list.length ? 'none' : '';
  const noSess = $('sess-empty-title'), hint = $('sess-empty-hint'), action = $('sess-empty-action');
  // 空表要说清是"筛没了"还是"真没有"。会话本身就一条都没有时,任何筛选条件都无关,
  // 文案就不能再劝"清空搜索"——那时给的是发起对话的指引,按钮也不摆。
  if (!all.length) {
    noSess.textContent = '还没有匹配的会话';
    hint.textContent = '通过本地路由发起对话后，会话绑定会出现在所属协议组；也可以调整分组筛选。';
    action.hidden = true;
  } else if (!list.length && sessionFiltered()) {
    noSess.textContent = '没有匹配当前搜索与筛选的会话';
    hint.textContent = `共 ${all.length} 个会话${sessApp ? `，其中 ${inApp.length} 个属于所选协议组` : ''}；换个关键词，或清空条件看全部。`;
    action.hidden = false; action.textContent = '清除搜索与筛选';
  } else {
    noSess.textContent = '当前协议组没有匹配的会话';
    hint.textContent = `其他协议组还有 ${all.length} 个会话；清空筛选即可看到。`;
    action.hidden = false; action.textContent = '显示全部协议组';
  }
  // 会话表为空时那句"共 N 个会话"只是去重后的数字,下面再给一条看得见短 id 的原始清单:
  // 用户搜完发现没命中,下一步得能盯着 id 核对到底差在哪。只在真的筛空了、且确实有会话时补。
  const why = $('sess-empty-why');
  if (why) {
    const show = !!all.length && !list.length && sessionFiltered();
    why.hidden = !show;
    if (show) why.textContent = '现有会话：' + all.map(s => s.short).join('、');
  }
  // 搜索框的值就是用户正在敲的那个草稿,只有与 sessQuery 不一致时才回填(程序化设置/深链)。
  // 5 秒轮询重渲染的是 chips 与表格,永远不会把这个 input 抹掉。
  const search = $('sess-search');
  if (search && search.value !== sessQuery) search.value = sessQuery;

  const pinned = list.filter(s => boundSourceOf(boundOf(s)) === 'manual').length;
  const withRouting = list.filter(s => routingDescribeOf(groupOfSession(s), s.routing).length).length;
  const mismatched = list.filter(s => actualDiffers(s)).length;
  const cool = state.cooldowns || [];
  $('sess-chips').innerHTML = [
    ['活跃对话', list.length],
    ['Anthropic / OpenAI', `${all.filter(s => (s.app || 'claude') === 'claude').length} / ${all.filter(s => s.app === 'codex').length}`],
    ['手动钉定', pinned],
    ['实际 ≠ 绑定', mismatched],
    ['会话级 Key / 槽位', withRouting],
    ['冷却中渠道', cool.length],
  ].map(([k, v]) => `<div class="chip">${k}<b>${esc(String(v))}</b></div>`).join('');

  $('sess-body').innerHTML = list.map(s => {
    const app = s.app || 'claude';
    const b = boundOf(s), src = boundSourceOf(b);
    const [srcText, srcCls] = BOUND_SOURCE[src];
    const hasPool = (state.routes.rules || []).concat([state.routes.default])
      .some(r => ((r.pool || []).some(m => (typeof m === 'string' ? m : m.provider) === b.provider)) || r.provider === b.provider);
    const opts = state.providers[app].map(p =>
      `<option value="${esc(p.id)}" ${p.id === b.provider ? 'selected' : ''}>${esc(p.name)}${p.enabled ? '' : '(停用)'}</option>`).join('');
    return `<tr data-session="${esc(s.short)}">
      <td><span class="sess-tag" title="${esc(s.key)}">${esc(s.short)}</span>
        <div style="font-size:11px;color:var(--dim);font-family:inherit">${esc(KIND_LABEL[s.kind] || s.kind || '')}</div></td>
      <td><span class="badge ${app === 'codex' ? 'info' : 'on'}">${app === 'codex' ? 'OpenAI' : 'Anthropic'}</span></td>
      <td style="font-family:inherit"><span class="lbl" title="${esc(s.label || '')}">${esc(s.label || '-')}</span></td>
      <td class="session-binding">
          <button class="small" onclick="openRouting(${handlerArg(s.key)})" ${online ? '' : 'disabled'} aria-label="配置会话 ${esc(s.short)} 的 Key 与槽位">配置 Key / 槽位</button>
          <details class="session-pin"><summary>普通请求渠道 · ${esc(b.provider_name || b.provider || '未绑定')}</summary>
            <label class="field" for="session-${esc(s.short)}">仅用于非槽位、非内容分流请求<select id="session-${esc(s.short)}" class="pin-sel" onchange="pinSession(${handlerArg(s.key)}, this.value)" ${!online ? 'disabled' : ''}>
              <option value="" ${b.provider ? '' : 'selected'}>(未绑定)</option>${opts}</select></label>
            <div class="bind-src"><span class="badge ${srcCls}">${srcText}</span></div>
            ${s.cooldown ? '<div class="cool">⚠ 渠道冷却中</div>' : ''}
            ${hasPool ? '' : '<div class="rt-note">不在任何池内</div>'}
          </details></td>
      <td>${actualCell(s, b)}</td>
      <td>${esc(b.model || '-')}</td>
      <td>${esc(b.rule || '-')}</td>
      <td>${s.reqs || 0}</td>
      <td>${fmtTok(s.inTok || 0)} / ${fmtTok(s.outTok || 0)}</td>
      <td>${s.lastUsed ? new Date(s.lastUsed).toLocaleTimeString('zh-CN', { hour12: false }) : '-'}</td>
      <td>${routingCell(s)}</td>
      <td><div class="sess-acts">
        <button class="small" onclick="gotoLogs(${handlerArg(s.short)})">日志</button>
        <button class="small danger" onclick="unbindSession(${handlerArg(s.key)})" ${online ? '' : 'disabled'}>解绑</button>
      </div></td></tr>`;
  }).join('');
}
// 「最近实际请求」这一格。没有记录就是明明白白的「暂无」——
// 绝不拿绑定值或路由预览顶上来充数:用户看到渠道名就会当成真实落点,而 actual 只认真的发出去过的那次。
function actualCell(s, bound) {
  const a = actualOf(s);
  if (!a) return '<span class="actual-cell"><span class="sub">暂无</span></span>';
  const name = a.provider_name || a.provider || s.actual_text || '未知渠道';
  // 普通请求对照渠道绑定,槽位请求对照该槽配置。没有配置渠道时无从比较,不报差异。
  const expected = actualExpectedProvider(s, bound);
  const diff = !!a.provider && !!expected && a.provider !== expected;
  const statusCls = !a.status ? '' : a.status >= 400 ? 'st4' : 'st2';
  const meta = [
    a.status ? `<span class="${statusCls}">${esc(String(a.status))}</span>` : '',
    a.slot ? `槽位 ${esc(a.slot)}` : '',
    a.sticky ? '粘性' : '',
    a.ts ? new Date(a.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '',
  ].filter(Boolean).join(' · ');
  return `<span class="actual-cell${diff ? ' diff' : ''}">
    <span class="sum">${esc(name)}</span>
    <span class="sub">${esc(a.model || '-')}${meta ? ' · ' + meta : ''}</span>
    ${diff ? '<span class="sub">与当前绑定不同</span>' : ''}</span>`;
}
// 槽位请求对照该槽的独立/全局配置,不能拿普通请求渠道把正常的主链/子代理分流标成异常。
function actualExpectedProvider(s, bound = boundOf(s)) {
  const a = actualOf(s);
  if (a?.slot) {
    const entry = Object.hasOwn(s.routing?.slots || {}, a.slot)
      ? s.routing.slots[a.slot] : globalSessionSlot(groupOfSession(s), a.slot);
    return entry?.provider || '';
  }
  return bound.provider || '';
}
const actualDiffers = s => { const a = actualOf(s), expected = actualExpectedProvider(s); return !!a?.provider && !!expected && a.provider !== expected; };
async function pinSession(key, provider) {
  if (!online) return toast('控制台离线，未改绑会话', 'err');
  try {
    await api('/api/sessions/' + encodeURIComponent(key) + '/pin', { method: 'POST', body: JSON.stringify({ provider }) });
    toast(provider ? '已改绑该对话' : '已解除钉定,下次请求重新分配', 'ok');
    refresh();
  } catch (e) { toast('改绑失败:' + e.message, 'err'); }
}
// 会话页的确认框要过这一层:确认框是独占的,而会话配置弹窗可能正开着。
// 直接调 askConfirm 在那种情况下会静默返回 false —— 用户点了「解绑」却什么都不发生、也没有提示。
async function sessionConfirm(title, message, action) {
  if (!activeDialog) return askConfirm(title, message, action);
  if (activeDialog.id === 'routing-mask') return routingAsk(title, message, action);
  toast('请先关闭当前弹窗再操作', 'err');
  return false;
}
async function unbindSession(key) {
  if (!online) return toast('控制台离线，未解绑会话', 'err');
  const s = sessionByIdentity(key);
  const saved = s ? routingDescribeOf(groupOfSession(s), s.routing) : [];
  const warn = saved.length
    ? `\n\n这个会话的 Key / 槽位配置会一起删除：\n· ${saved.slice(0, 8).join('\n· ')}${saved.length > 8 ? `\n· 其余 ${saved.length - 8} 项` : ''}`
    : '';
  if (!await sessionConfirm('解绑该会话', '该对话将在下次请求时按策略重新分配渠道。' + warn, saved.length ? '解绑并删除配置' : '解绑')) return;
  try { await api('/api/sessions/' + encodeURIComponent(key), { method: 'DELETE' }); toast(saved.length ? '已解绑，会话级 Key / 槽位配置一并删除' : '已解绑', 'ok'); refresh(); }
  catch (e) { toast('解绑失败:' + e.message, 'err'); }
}
async function clearSessions() {
  if (!online) return toast('控制台离线，未清空会话绑定', 'err');
  const saved = (state?.sessions || []).reduce((n, s) => n + (routingDescribeOf(groupOfSession(s), s.routing).length ? 1 : 0), 0);
  const warn = saved ? `\n\n其中 ${saved} 个会话配了 Key / 槽位覆盖，这些配置会一并删除且不可恢复。` : '';
  if (!await sessionConfirm('清空全部会话绑定', '所有协议组的对话将在下次请求时按策略重新分配渠道，包括 ZCode 按协议归组的流量。' + warn, saved ? '清空全部（含配置）' : '清空绑定')) return;
  try { await api('/api/sessions', { method: 'DELETE' }); toast(saved ? `已清空会话绑定，并删除 ${saved} 个会话的 Key / 槽位配置` : '已清空会话绑定', 'ok'); refresh(); }
  catch (e) { toast('清空失败：' + e.message, 'err'); }
}
function gotoLogs(short) {
  // 走 showView 而不是去"点"导航项:后者依赖某个选择器恰好命中,视图一改名就返回 null,
  // .click() 抛 TypeError,而这个按钮在会话表里——整页都还看着正常,只有它当场失灵。
  showView('diagnostics');
  $('f-session').value = short;
  loadLogs();
}

// ---------------- 会话 Key / 槽位覆盖 ----------------
// 每个会话可单独指定渠道 Key、覆盖槽位落点(routing: {keys:{渠道id:Key id}, slots:{槽位:{provider,model?,key_id?}}})。
// 覆盖挂在会话所属的协议组上:会话属于 claude 组就配 claude 组的渠道与槽位(服务端的
// normalizeRouting 也按该组校验渠道与槽位名)。这里只搬运**已有 Key 的 ID**,不显示也不提交
// 任何明文;渠道当前生效 Key 由「渠道」页管,本界面不动它。
const SESSION_SLOT_NAMES = ['main', 'opus', 'sonnet', 'haiku', 'subagent'];
// 与服务端 CODEX_SLOT_NAME_RE 同一套规则(小写字母/数字开头,后接小写字母、数字、连字符,最长 24)
const SLOT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
let routingSession = null, routingDraft = null, routingRevision = null, routingDirty = false, routingSaving = false, routingTask = null, routingLoadSeq = 0, routingError = '', routingConflict = false;
let routingModelEdit = null, routingKeysOpen = false;
// 会话所属协议组＝这份覆盖的作用范围
const routingGroup = () => (routingSession?.app === 'codex' ? 'codex' : 'claude');
const groupOfSession = s => (s?.app === 'codex' ? 'codex' : 'claude');
const sessionByIdentity = key => (state?.sessions || []).find(s => s.key === key) || null;
const sessionById = short => (state?.sessions || []).find(s => s.short === short) || null;
const routingEmpty = () => ({ keys: {}, slots: {} });

// 服务端的 routingOf 会把无效引用**原样留着**(空串的 key_id、空 provider 的槽位都照收),
// 好让请求报错、让控制台看见并修。所以这里也必须原样镜像:一旦丢掉,用户改别的条目时
// 就会把它们一起冲掉——那是静默恢复继承,恰恰是这套覆盖最不该发生的事。
// 丢弃只由用户的明确动作触发(选「继承/恢复继承」),不在这里做。
function routingClone(routing) {
  const out = routingEmpty();
  for (const [pid, kid] of Object.entries((routing && routing.keys) || {})) {
    if (typeof pid === 'string' && pid) out.keys[pid] = typeof kid === 'string' ? kid : '';
  }
  for (const [name, v] of Object.entries((routing && routing.slots) || {})) {
    if (!name || !v || typeof v !== 'object') continue;
    const e = { provider: typeof v.provider === 'string' ? v.provider : '' };
    if (typeof v.model === 'string') e.model = v.model;
    if (Object.hasOwn(v, 'key_id')) e.key_id = typeof v.key_id === 'string' ? v.key_id : '';
    out.slots[name] = e;
  }
  return out;
}
// 提交用的载荷与草稿同形:空值**照样发出去**,不在这里做清理。
// 服务端对 keys 只查"这把 Key 在不在"(空串查不到必拒),对 slots.key_id 只查 own() 不看内容,
// 所以原样提交＝原样保留;反过来说,前端悄悄剔掉就等于替用户改了配置。
function routingNormalize(draft) {
  return routingClone(draft);
}
// 这条引用是不是"用户明确要它生效"的:空串/缺 provider 的条目服务端会拒绝,不该算数,
// 但它们仍要留在草稿里(见上),只是得显式提示,并且清空确认时要点名。
const routingEntryUsable = e => !!e && typeof e.provider === 'string' && !!e.provider;
// 下面这些都要按"哪一组"来查渠道,所以 group 一律显式传入:会话列表里的概要与弹窗里的
// 编辑器都可能同时存在,不能依赖 routingSession 这个全局。
const routingProvidersOf = group => providers(group);
const routingProviderOf = (group, pid) => routingProvidersOf(group).find(p => p.id === pid) || null;
function keyLabelOf(group, pid, kid) {
  const provider = routingProviderOf(group, pid);
  const key = (provider?.keys || []).find(k => k.id === kid);
  if (key) return `${key.label || key.id}（${key.id}）`;
  return provider ? `已失效 Key（${kid}）` : `渠道已删除（${pid}）`;
}
function activeKeyOf(group, pid) {
  const p = routingProviderOf(group, pid);
  const ring = p?.keys || [];
  return ring.find(k => k.id === p?.active_key) || ring[0] || null;
}
function routingSlotTextOf(group, v) {
  if (v && !routingEntryUsable(v)) return '无效条目（未选渠道）· 保存会被拒';
  if (!v || !v.provider) return '继承全局';
  const p = routingProviderOf(group, v.provider);
  return [p ? p.name : `渠道已删除（${v.provider}）`, v.model || '', v.key_id ? 'Key ' + keyLabelOf(group, v.provider, v.key_id) : ''].filter(Boolean).join(' / ');
}
// 失效引用要先摆出来:服务端会 400/503 拒掉,用户得知道是哪一条。
function routingStaleOf(group, routing) {
  const out = [];
  for (const [pid, kid] of Object.entries((routing?.keys) || {})) {
    const provider = routingProviderOf(group, pid), key = (provider?.keys || []).find(k => k.id === kid);
    if (!provider) out.push(`Key 绑定指向不存在或不属于本组的渠道（${pid}）`);
    else if (!kid) out.push(`${provider.name} 的 Key 绑定被指定为空`);
    else if (!key) out.push(`${provider.name} 的 Key 已失效（${kid}）`);
    else if (key.enabled === false) out.push(`${provider.name} 的 Key ${key.label || key.id} 已停用`);
    else if (provider.enabled === false) out.push(`${provider.name} 已停用`);
  }
  for (const [name, v] of Object.entries((routing?.slots) || {})) {
    const p = routingProviderOf(group, v.provider);
    if (!p) {
      out.push(routingEntryUsable(v) ? `槽位 ${name} 指向不存在或不属于本组的渠道（${v.provider}）` : `槽位 ${name} 没有选渠道`);
      continue;
    }
    if (p.enabled === false) out.push(`槽位 ${name} 的渠道 ${p.name} 已停用`);
    // key_id 只要 own 就算"这条槽位点了名":空串也是点名,服务端 own() 收下但查不到 Key,
    // 保存必拒。所以不能用 if (v.key_id) 判——空串会被整个跳过,漏报。
    if (Object.hasOwn(v, 'key_id')) {
      if (!v.key_id) out.push(`槽位 ${name} 指定的 Key 被指定为空`);
      else {
        const k = (p.keys || []).find(x => x.id === v.key_id);
        if (!k) out.push(`槽位 ${name} 指定的 Key 已失效（${v.key_id}）`);
        else if (k.enabled === false) out.push(`槽位 ${name} 指定的 Key ${k.label || k.id} 已停用`);
      }
    }
  }
  if (group === 'claude') {
    for (const name of Object.keys(routing?.slots || {})) if (!SESSION_SLOT_NAMES.includes(name)) out.push(`槽位 ${name} 不是 Claude 的固定槽位，服务端会拒绝`);
  }
  return out;
}
// 已保存的那份覆盖都有哪些条目,清空前逐条告诉用户会删掉什么。
function routingDescribeOf(group, routing) {
  const out = [];
  for (const [pid, kid] of Object.entries((routing?.keys) || {})) out.push(`${routingProviderOf(group, pid)?.name || pid} → ${kid ? keyLabelOf(group, pid, kid) : '空 Key（无效）'}`);
  for (const [name, v] of Object.entries((routing?.slots) || {})) out.push(`槽位 ${name} → ${routingSlotTextOf(group, v)}`);
  return out;
}
function routingDiff(serverRouting) {
  const group = routingGroup();
  const a = routingClone(routingDraft), b = routingClone(serverRouting || {}), out = [];
  for (const pid of new Set([...Object.keys(a.keys), ...Object.keys(b.keys)])) {
    if ((a.keys[pid] || '') === (b.keys[pid] || '')) continue;
    out.push(`${routingProviderOf(group, pid)?.name || pid} 的 Key：${b.keys[pid] ? keyLabelOf(group, pid, b.keys[pid]) : '继承渠道当前 Key'} → ${a.keys[pid] ? keyLabelOf(group, pid, a.keys[pid]) : '恢复继承'}`);
  }
  for (const name of new Set([...Object.keys(a.slots), ...Object.keys(b.slots)])) {
    if (routingSlotTextOf(group, a.slots[name]) === routingSlotTextOf(group, b.slots[name])) continue;
    out.push(`槽位 ${name}：${routingSlotTextOf(group, b.slots[name])} → ${routingSlotTextOf(group, a.slots[name])}`);
  }
  return out;
}
function renderRoutingIdent() {
  const s = routingSession;
  if (!s) return;
  $('routing-short').textContent = s.short || '—';
  $('routing-key').textContent = s.key || '—';
  $('routing-label').textContent = s.label || '（该会话暂无对话名称）';
  $('routing-app').textContent = `${GROUPS[routingGroup()]} · ${KIND_LABEL[s.kind] || s.kind || '身份来源未提供'}`;
  $('routing-scope').textContent = `${GROUPS[routingGroup()]} 的渠道与槽位`;
}
const updateRoutingButtons = () => {
  const locked = !online || !routingDraft || routingRevision == null || routingSaving;
  $('routing-save').disabled = locked;
  $('routing-clear').disabled = locked;
  // 三扇门各自的前置条件不同:没读到草稿时也要能「重新读取」
  $('routing-reload').disabled = !online || routingSaving;
};
function renderRoutingStatus() {
  if (!routingSession) return;
  const refs = routingStaleOf(routingGroup(), routingDraft);
  $('routing-refs').classList.toggle('show', refs.length > 0);
  $('routing-refs-list').innerHTML = refs.map(x => `<div class="rt-note warn">· ${esc(x)}</div>`).join('');
  const conflict = routingConflict || (routingDirty && routingRevision !== (routingSession.routing_revision || ''));
  $('routing-conflict').classList.toggle('show', conflict);
  $('routing-conflict-list').innerHTML = conflict ? routingDiff(routingSession.routing).map(x => `<div class="rt-note">· ${esc(x)}</div>`).join('') : '';
  $('routing-msg').textContent = routingError ? routingError
    : conflict ? '服务端配置已被其他改动更新；草稿保留、没有提交。直接再保存仍会被拒（界面只按读到的版本写入）。核对差异后点「放弃草稿并重载」读到最新版本，再改一遍并保存。'
      : routingDirty ? '有未保存的改动；后台自动刷新不会覆盖草稿。'
        : routingRevision == null ? '尚未读取该会话的服务端配置。'
          : routingHasInvalid(routingDraft) ? '草稿与上次读取一致；里面有无效引用（见上方清单），保存会被服务端拒绝，需要明确改选或移除。'
            : '草稿与上次读取一致。';
  updateRoutingButtons();
}// 草稿的"未保存"参照物是上次读到的服务端那一份:改了又改回来就不该再算未保存。
const routingDirtyNow = () => !routingDraft || routingRevision == null
  || JSON.stringify(routingNormalize(routingDraft)) !== JSON.stringify(routingNormalize(routingSession?.routing || {}));
// 服务端那份里有没有"本来就无效、用户没动过"的引用:有就不能写"草稿与上次读取一致"
const routingHasInvalid = routing => {
  const r = routingClone(routing || {});
  return Object.values(r.keys).some(k => !k)
    || Object.entries(r.slots).some(([, v]) => !routingEntryUsable(v) || (Object.hasOwn(v, 'key_id') && !v.key_id));
};
const routingTouch = () => { routingDirty = routingDirtyNow(); routingConflict = false; routingError = ''; renderRoutingStatus(); };
// 重绘后把焦点还给刚操作的那个控件(优先 id):换渠道要重画模型/Key 下拉,不该把光标丢回页面顶部。
function rerenderRouting(focusId) {
  renderRoutingEditor();
  const el = focusId && document.getElementById(focusId);
  if (el && el.focus) el.focus();
}
// has=false 是"没有这条绑定"(继承);has=true 且值为空串是"绑了但指定为空",
// 服务端存着它并会拒绝保存,两者不能混成同一个下拉值。
const routeKeyOptions = (pid, has, sel) => {
  const p = routingProviderOf(routingGroup(), pid), ring = p?.keys || [];
  const missing = has && !!sel && !ring.some(k => k.id === sel);
  const blank = has && !sel;
  return `<option value=""${has ? '' : ' selected'}>继承渠道当前 Key</option>`
    + ring.map(k => `<option value="${esc(k.id)}"${k.enabled === false ? ' disabled' : ''}${k.id === sel ? ' selected' : ''}>${esc(k.label || k.id)}（${esc(k.id)}）${k.enabled === false ? ' · 已停用' : ''}</option>`).join('')
    + (blank ? '<option value="" disabled selected>已指定为空 Key · 保存会被拒，请改选或恢复继承</option>' : '')
    + (missing ? `<option value="${esc(sel)}" disabled selected>已失效 Key（${esc(sel)}）· 保留原选择</option>` : '');
};
// pid 只在"渠道已不在本组"时用来定位草稿里的那条绑定(p 为 null,拿不到 p.id)。
// 少了它,行内的下拉与「恢复继承」按钮就没有可用的键,那条失效绑定永远删不掉。
function routingKeyRow(p, has, sel, pid) {
  const group = routingGroup();
  const ring = p?.keys || [], active = p ? activeKeyOf(group, p.id) : null;
  const rowId = p ? p.id : (pid || '');
  const missing = has && !!sel && !ring.some(k => k.id === sel);
  const blank = has && !sel;
  const note = !p ? '这个渠道已不在本协议组里，保存会被服务端拒绝；请恢复继承（移除这条绑定）。'
    : !p.enabled ? '该渠道已停用，指定 Key 也不会让这个会话恢复。'
      : blank ? '这条绑定指定了空 Key，服务端会拒绝保存；请改选一把 Key，或恢复继承删掉它。'
        : missing ? '原指定的 Key 已不存在，选择仍保留；请明确改选一把可用 Key，或恢复继承，不会自动替换。'
          : has ? '显式指定的 Key 只服务该会话：Key 缺失或被停用时请求直接失败，不会降级用其他 Key 或池内渠道。'
            : active ? `继承渠道当前生效账号：${active.label}（${active.id}）${active.enabled === false ? ' —— 该账号当前已停用，继承过来同样会失败。' : ''}`
              : '继承渠道当前生效账号；该渠道当前没有可用 Key。';
  const id = rowId;
  return `<div class="rt-row">
    <div class="rt-name">${esc(p ? p.name : '渠道已删除')}<span class="mono">${esc(pid || '')}</span>${!p ? '<span class="badge drift">不在本组</span>' : p.enabled ? '' : '<span class="badge off">停用</span>'}${p && !ring.length ? '<span class="badge off">无 Key</span>' : ''}</div>
    <label class="field">该会话在此渠道使用的 Key<select id="rt-key-${esc(id)}" onchange="routingSetKey(${handlerArg(id)},this.value)" ${online && p ? '' : 'disabled'}>${p ? routeKeyOptions(id, has, sel) : `<option value="${esc(sel ?? '')}" selected>已失效 Key（${esc(sel ?? '')}）· 保留原选择</option>`}</select></label>
    <div class="rt-note${(!p || !p.enabled || missing || blank || (!has && active?.enabled === false)) ? ' warn' : ''}">${esc(note)}</div>
    ${!p ? `<button class="small danger" type="button" onclick="routingSetKey(${handlerArg(id)},'')">恢复继承</button>` : ''}
  </div>`;
}
// 渠道行 = 本组现有的每个渠道 + 草稿里指向已不在本组的渠道的那些绑定(后者也得能删掉)
function routingKeyRows() {
  const group = routingGroup(), ps = routingProvidersOf(group);
  const rows = ps.map(p => routingKeyRow(p, Object.hasOwn(routingDraft.keys, p.id), routingDraft.keys[p.id]));
  for (const pid of Object.keys(routingDraft.keys)) {
    if (!ps.some(p => p.id === pid)) rows.push(routingKeyRow(null, true, routingDraft.keys[pid], pid));
    // 「恢复继承」走 routingSetKey(pid,'')＝删掉这条绑定(routingKindOf 认不出渠道即判 remove),
    // 不是把值改成空串留在草稿里。
  }
  return rows.join('') || '<div class="rt-note">该协议组还没有渠道。</div>';
}
// 同一份全局落点同时用于「实际 ≠ 绑定」的对照和编辑器的继承提示,不把继承值写入会话覆盖。
function globalSessionSlot(group, name) {
  return (slotsOf()[group] || []).find(s => s.name === name) || null;
}
function routingSlotRow(name, keyOnly = false) {
  const group = routingGroup();
  const e = routingDraft.slots[name] || null;
  const ps = routingProvidersOf(group);
  const p = e ? routingProviderOf(group, e.provider) : null;
  const ghost = !!e && !p;
  // 空 provider 的槽位:服务端照样存着,界面也照样摆出来,别让它看起来像"没配"
  const empty = !!e && !routingEntryUsable(e);
  const inherited = globalSessionSlot(group, name);
  const inheritedProvider = inherited?.provider ? routingProviderOf(group, inherited.provider) : null;
  const inheritedTarget = inherited?.provider
    ? `${inheritedProvider?.name || '渠道已删除'} @ ${inherited.model || '未登记模型'}${inherited.enabled ? '' : '（不可用）'}`
    : '未配置，按普通路由分发';
  const providerOptions = [`<option value=""${e ? '' : ' selected'}>继承全局槽位${inherited?.provider ? ' · ' + esc(inheritedProvider?.name || '渠道已删除') : '（未配置）'}</option>`]
    .concat(ps.map(x => {
      const active = activeKeyOf(group, x.id);
      return `<option value="${esc(x.id)}"${x.id === e?.provider ? ' selected' : ''}>${esc(x.name)}${active ? ' · ' + esc(active.label || active.id) : ''}${x.enabled ? '' : '（停用）'}</option>`;
    }))
    .concat(ghost && !empty ? [`<option value="${esc(e.provider)}" selected>⚠ 渠道已删除（${esc(e.provider)}）</option>`] : []).join('');
  // 落点模型留空＝用所选渠道的默认模型(codex 取渠道 model,claude 取模型列表第一项),
  // 不是"继承全局槽位那个模型"——本会话槽位一旦覆盖,就不再看全局槽位表了。
  const known = [...new Set([...(p?.models || []), ...(group === 'codex' && p?.model ? [p.model] : [])])];
  const defaultModel = group === 'codex' ? p?.model : (p?.models || [])[0];
  const modelOptions = [`<option value=""${e?.model ? '' : ' selected'}>渠道默认模型${defaultModel ? '（' + esc(defaultModel) + '）' : '（该渠道未登记模型）'}</option>`]
    .concat(known.map(m => `<option value="${esc(m)}"${m === e?.model ? ' selected' : ''}>${esc(m)}</option>`))
    .concat(e?.model && !known.includes(e.model) ? [`<option value="${esc(e.model)}" selected>${esc(e.model)}（自定义）</option>`] : [])
    .concat(`<option value="${SLOT_MODEL_CUSTOM}">自定义模型…</option>`).join('');
  const modelId = `rt-slot-${name}-model`;
  const modelCell = !e
    ? `<select id="${esc(modelId)}" disabled><option>${esc(inherited?.model || '（跟随全局槽位）')}</option></select>`
    : routingModelEdit?.name === name
      ? `<input id="${esc(modelId)}" type="text" value="${esc(e.model || '')}" placeholder="模型名，可带 [1M] 后缀" spellcheck="false" autocomplete="off" oninput="routingSetSlotModel(${handlerArg(name)},this.value)" onkeydown="routingModelKey(event,${handlerArg(name)})" onblur="routingEndModelEdit(${handlerArg(name)},this.value)" ${ghost || !online ? 'disabled' : ''}>`
      : `<select id="${esc(modelId)}" onchange="routingPickSlotModel(${handlerArg(name)},this.value)" ${ghost || !online ? 'disabled' : ''}>${modelOptions}</select>`;
  const ring = p?.keys || [];
  const keyMissing = !!e?.key_id && !ring.some(k => k.id === e.key_id);
  const keyEmpty = !!e && Object.hasOwn(e, 'key_id') && !e.key_id;
  const keyOptions = ['<option value="">继承本会话该渠道的 Key</option>']
    .concat(ring.map(k => `<option value="${esc(k.id)}"${k.enabled === false ? ' disabled' : ''}${k.id === e?.key_id ? ' selected' : ''}>${esc(k.label || k.id)}（${esc(k.id)}）${k.enabled === false ? ' · 已停用' : ''}</option>`))
    .concat(keyEmpty ? [`<option value="" disabled selected>已指定为空 Key（${esc(e.key_id)}）· 保存会被拒，请改选或清掉</option>`] : [])
    .concat(keyMissing ? [`<option value="${esc(e.key_id)}" disabled selected>已失效 Key（${esc(e.key_id)}）· 保留原选择</option>`] : []).join('');
  const note = !e ? `继承全局：${inheritedTarget}${inherited?.pool?.length ? '；保留全局后备池' : ''}。`
    : empty ? '这条槽位没有选渠道，服务端会拒绝保存；请选一个渠道，或点「恢复继承」删掉它。'
      : ghost ? '渠道已删除或不属于本会话的协议组，保存会被服务端拒绝；请改选渠道或恢复继承。'
        : keyEmpty ? '这条槽位指定了空 Key，服务端会拒绝保存；请改选一把 Key，或清掉这条指定。'
          : `覆盖全局槽位。取 Key 顺序：本槽位指定 → 本会话该渠道 Key → 渠道当前 Key${p?.enabled === false ? '（该渠道已停用，覆盖要等它启用才可用）' : ''}。`;
  if (keyOnly) return `<div class="rt-row">
    <div class="rt-name">${esc(slotLabelOf(name))}</div>
    <label class="field">指定 Key<select id="rt-slot-${esc(name)}-key" onchange="routingSetSlotKey(${handlerArg(name)},this.value)" ${(!e || ghost || !online) ? 'disabled' : ''}>${keyOptions}</select></label>
    <div class="rt-note${(ghost || empty || keyMissing || keyEmpty) ? ' warn' : ''}">${esc(note)}</div>
  </div>`;
  const badge = `<span class="badge ${empty ? 'off' : ghost ? 'drift' : e ? 'info' : 'off'}">${empty ? '无效条目' : ghost ? '渠道已失效' : e ? '已覆盖' : '继承全局'}</span>`;
  const clear = e ? `<button class="iconbtn" aria-label="恢复 ${esc(name)} 槽继承" onclick="routingRemoveSlot(${handlerArg(name)})" ${online ? '' : 'disabled'}>×</button>` : '';
  return slotLine({ name, alias: inherited?.alias || 'mixr-' + name, env: inherited?.env || '' },
    `<select id="rt-slot-${esc(name)}-provider" onchange="routingSetSlotProvider(${handlerArg(name)},this.value)" ${online ? '' : 'disabled'}>${providerOptions}</select>`,
    modelCell, badge, clear, ` data-routing-slot="${esc(name)}"`);
}
function slotLabelOf(name) { return routingGroup() === 'claude' ? (SLOT_LABELS[name] || name) : `槽位 ${name}`; }
// Claude 是固定五槽;Codex 槽名自拟,所以只列槽位表里登记过的,外加草稿里已有的名字
// (槽位被删掉后,那条约覆盖还要留在界面上等用户自己处理)。不硬编一个 Codex 的 main,
// 那种槽名没有任何请求会映射到,摆出来只会让人以为覆盖生效了。
function routingSlotNames() {
  const base = routingGroup() === 'claude' ? SESSION_SLOT_NAMES.slice() : ((state?.slots?.codex) || []).map(s => s.name);
  return [...base, ...Object.keys(routingDraft?.slots || {}).filter(n => !base.includes(n))];
}
function renderRoutingEditor() {
  const box = $('routing-body');
  if (!routingDraft) { box.innerHTML = ''; return; }
  const group = routingGroup();
  const keys = routingKeyRows();
  const names = routingSlotNames();
  const slots = names.map(name => routingSlotRow(name)).join('') || '<div class="rt-note">该协议组还没有槽位。</div>';
  box.innerHTML = `<div class="panel" id="routing-slots-panel"><h2>会话模型槽位</h2>
    <p class="hint">每行分别选择渠道与模型；未覆盖的槽位继承全局。模型留空使用渠道默认模型。保存只影响本会话后续新请求，不改全局槽位或客户端配置；内容分流（含压缩）仍优先。</p>
    <div>${slots}</div>
    ${group === 'codex' ? `<div class="rt-line" style="margin-top:10px">
      <label class="field">新增槽位覆盖<input id="rt-new-slot" placeholder="如 worker（小写字母/数字/连字符）" autocomplete="off" spellcheck="false"></label>
      <button class="small" type="button" onclick="routingAddSlot()" ${online ? '' : 'disabled'}>＋ 添加槽位覆盖</button>
    </div>` : ''}
    <div class="savebar"><button class="primary" type="button" onclick="saveRouting()" ${online && !routingSaving ? '' : 'disabled'}>保存该会话槽位</button>
      <button class="small" type="button" onclick="routingCopyGlobalSlots()" ${online ? '' : 'disabled'}>复制全局槽位为独立配置</button></div>
  </div>
  <details class="rt-group" ${routingKeysOpen ? 'open' : ''} ontoggle="routingKeysOpen=this.open"><summary>渠道 Key 设置${Object.keys(routingDraft.keys).length ? '（' + Object.keys(routingDraft.keys).length + ' 项指定）' : '（默认继承）'}</summary>
    <p>渠道 Key：默认继承渠道当前生效账号；要指定就选一把已有 Key。这里只保存引用，不显示也不存放明文，也不会切换渠道当前账号。</p>
    <div class="rt-list">${keys}</div>
    <p>槽位 Key 与继承来源</p><div class="rt-list">${names.map(name => routingSlotRow(name, true)).join('')}</div>
  </details>`;
}
function routingSetKey(pid, kid) {
  if (!routingDraft) return;
  if (kid) routingDraft.keys[pid] = kid; else delete routingDraft.keys[pid];
  routingTouch();
}
function routingSetSlotProvider(name, pid) {
  if (!routingDraft) return;
  // 换渠道就把模型和 Key 一起清掉:它们属于上一个渠道,留着就是指向别家渠道的脏值
  routingModelEdit = null;
  if (!pid) delete routingDraft.slots[name];
  else routingDraft.slots[name] = { provider: pid };
  routingTouch(); rerenderRouting(`rt-slot-${name}-provider`);
}
function routingPickSlotModel(name, value) {
  if (value === SLOT_MODEL_CUSTOM) {
    const e = routingDraft?.slots?.[name];
    if (!e) return;
    routingModelEdit = { name, value: e.model || '' };
    rerenderRouting(`rt-slot-${name}-model`);
    return;
  }
  routingModelEdit = null;
  routingSetSlotModel(name, value);
}
function routingModelKey(event, name) {
  if (event.key === 'Enter') {
    event.preventDefault(); routingEndModelEdit(name, event.target.value);
  } else if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation();
    const edit = routingModelEdit;
    routingModelEdit = null;
    if (edit?.name === name) routingSetSlotModel(name, edit.value);
    rerenderRouting(`rt-slot-${name}-model`);
  }
}
function routingEndModelEdit(name, value) {
  if (routingModelEdit?.name !== name) return;
  routingModelEdit = null;
  routingSetSlotModel(name, (value || '').trim());
  // 失焦时不重画鼠标下的控件,避免吞掉用户正在点击的保存/渠道选择。
  const model = $(`rt-slot-${name}-model`);
  if (model && document.activeElement === model) rerenderRouting(model.id);
}
function routingCopyGlobalSlots() {
  const gate = routingGate('复制全局槽位'); if (gate) return toast(gate, 'err');
  let copied = 0;
  for (const slot of slotsOf()[routingGroup()] || []) {
    if (!slot.provider || Object.hasOwn(routingDraft.slots, slot.name)) continue;
    routingDraft.slots[slot.name] = { provider: slot.provider, ...(slot.model ? { model: slot.model } : {}) };
    copied++;
  }
  routingModelEdit = null;
  routingTouch(); renderRoutingEditor();
  toast(copied ? `已复制 ${copied} 个全局槽位到草稿，已有覆盖未改动；复制仅含渠道与模型，不含后备池，保存后才生效。` : '没有可复制的全局槽位，已有独立配置未改动。');
}
function routingSetSlotModel(name, model) {
  const e = routingDraft?.slots?.[name];
  if (!e) return;
  if (model) e.model = model; else delete e.model;
  routingTouch();
}
function routingSetSlotKey(name, kid) {
  const e = routingDraft?.slots?.[name];
  if (!e) return;
  if (kid) e.key_id = kid; else delete e.key_id;
  routingTouch();
}
function routingRemoveSlot(name) {
  if (!routingDraft?.slots?.[name]) return;
  if (routingModelEdit?.name === name) routingModelEdit = null;
  delete routingDraft.slots[name];
  routingTouch(); renderRoutingEditor();
}
function routingAddSlot() {
  if (!routingDraft) return;
  const raw = ($('rt-new-slot').value || '').trim().toLowerCase();
  if (!SLOT_NAME_RE.test(raw)) return toast('槽位名需以小写字母或数字开头，只含小写字母、数字、连字符，最长 24 位', 'err');
  if (routingDraft.slots[raw]) return toast(`槽位 ${raw} 已有覆盖，直接在上面改`, 'err');
  routingDraft.slots[raw] = { provider: '' };
  routingTouch(); renderRoutingEditor();
}
function routingGate(action, { needDraft = true } = {}) {
  if (!routingSession) return `未选择会话，不能${action}。`;
  if (!online) return `控制台离线，未${action}会话配置。`;
  if (routingSaving) return '正在保存该会话配置，请稍候。';
  if (needDraft && (!routingDraft || routingRevision == null)) return `尚未读到该会话的服务端配置，不能${action}；请先重新读取。`;
  return '';
}
// 身份一律用**完整会话 key**:短 id 只有 8 位,两个会话撞同一个短 id 时,
// 按 short 比对的"这次响应还属于当前会话吗"会判错,把 A 的配置画到 B 上。
// full 之外再带一个读取轮次:关掉 A 立刻打开 B 时,A 那次 GET 回来得晚,
// 靠 full 已经拦不住(全局的 routingTask 还挂着,连 B 的加载都会被它顶掉)。
function routingIdentityOk(full, seq) {
  return !!routingSession && routingSession.key === full && routingLoadSeq === seq;
}
async function loadRouting() {
  if (!routingSession) return;
  const full = routingSession.key, seq = ++routingLoadSeq;
  updateRoutingButtons();
  const task = (async () => {
    try {
      const res = await api('/api/sessions/' + encodeURIComponent(full) + '/routing');
      if (!routingIdentityOk(full, seq)) return; // 期间换了会话/重读了,这次结果作废
      if (!res || res.routing == null || res.revision == null || typeof res.routing !== 'object' || Array.isArray(res.routing))
        throw new Error('响应缺少完整的 routing/revision 字段');
      routingDraft = routingClone(res.routing); routingRevision = res.revision; routingDirty = false; routingError = '';
      routingModelEdit = null;
      renderRoutingEditor(); renderRoutingStatus();
    } catch (e) {
      if (!routingIdentityOk(full, seq)) return;
      routingDraft = null; routingRevision = null;
      routingError = `读取该会话覆盖配置失败：${e.message}。没有改动任何配置；可按「放弃草稿并重载」重试。`;
      renderRoutingEditor(); renderRoutingStatus();
    } finally {
      if (routingTask === task) routingTask = null; // 只清自己那次,别把后开的那次抹掉
      updateRoutingButtons();
    }
  })();
  routingTask = task;
  return task;
}
// 按钮传的是完整 key;短 id 只在缺完整 key 时兜底(旧调用点/旧测试)
function openRouting(identity) {
  if (activeDialog) return toast('请先关闭当前弹窗');
  if (!state) return toast('状态尚未就绪，请稍后重试', 'err');
  if (!online) return toast('控制台离线，未读取会话配置', 'err');
  const s = sessionByIdentity(identity) || sessionById(identity);
  if (!s) return toast('该会话已不在当前列表，请刷新后重试', 'err');
  routingSession = s; routingDraft = null; routingRevision = null; routingDirty = false; routingError = ''; routingConflict = false;
  routingModelEdit = null; routingKeysOpen = false;
  renderRoutingIdent(); renderRoutingEditor(); renderRoutingStatus();
  $('routing-msg').textContent = '正在读取该会话的覆盖配置…';
  showDialog('routing-mask', 'routing-close');
  loadRouting();
}
async function closeRoutingModal() {
  if (activeDialog?.id !== 'routing-mask') return;
  if (routingSaving) return toast('正在保存该会话配置，请稍候');
  // 关掉弹窗＝放弃草稿,所以有未保存改动时必须问一次,别让它随手一点就没了
  if (routingDirty && !await routingAsk('关闭并丢弃未保存的会话配置', '这个对话的 Key / 槽位改动还没保存，关闭后会丢弃；保存过的服务端配置不受影响。', '放弃并关闭')) return;
  routingSession = null; routingDraft = null; routingRevision = null; routingDirty = false; routingError = ''; routingConflict = false;
  routingLoadSeq++; routingTask = null;
  hideDialog();
}
// 确认框是独占的:要弹它得先把本弹窗收起来,确认完再放回来,草稿留在原处。
// 会话页的解绑/清空也走这里——它们可能在本弹窗开着时被点到,而 askConfirm 在那种情况下
// 会静默返回 false(点了「解绑」什么都不发生、也没有提示)。
async function routingAsk(title, message, action) {
  if (routingSaving) { toast('正在保存该会话配置，请稍候'); return false; }
  hideDialog();
  const ok = await askConfirm(title, message, action);
  if (routingSession && !activeDialog) showDialog('routing-mask', 'routing-close');
  return ok;
}
async function reloadRouting() {
  const gate = routingGate('重新读取', { needDraft: false }); if (gate) return toast(gate, 'err');
  if (routingDirty && !await routingAsk('放弃未保存的会话配置草稿', '重新读取会丢弃当前草稿，回到服务端已保存的那一版。', '放弃草稿')) return;
  routingDraft = null; routingRevision = null; routingError = ''; routingConflict = false;
  renderRoutingEditor(); updateRoutingButtons();
  $('routing-msg').textContent = '正在重新读取该会话的覆盖配置…';
  await loadRouting();
}
async function saveRouting() {
  const gate = routingGate('保存'); if (gate) return toast(gate, 'err');
  await submitRouting('已保存该会话的 Key / 槽位配置；对该会话后续新请求生效');
}
async function clearRouting() {
  const gate = routingGate('清空'); if (gate) return toast(gate, 'err');
  const stored = routingDescribeOf(routingGroup(), routingSession.routing);
  const listed = stored.length ? '\n\n将删除：\n· ' + stored.slice(0, 8).join('\n· ') + (stored.length > 8 ? `\n· 其余 ${stored.length - 8} 项` : '') : '\n\n该会话在服务端本来就没有覆盖项。';
  const draftNote = routingDirty ? '\n\n当前草稿里未保存的改动也会一并丢弃。' : '';
  if (!await routingAsk('清空该会话的 Key / 槽位配置', '保存后这个对话回到「继承全局槽位 + 渠道当前 Key」；其他会话和渠道设置不受影响。' + listed + draftNote, '清空并保存')) return;
  await submitRouting('已清空该会话的 Key / 槽位配置', routingEmpty());
}
async function submitRouting(okMsg, forcedDraft) {
  const identity = routingSession.key, rev = routingRevision;
  const payload = routingNormalize(forcedDraft || routingDraft);
  // 这一趟发出去的和草稿未必是同一份(清空是拿空映射顶掉草稿,并不改写草稿)。
  // 所以"提交期间有没有新编辑"要拿**发起保存那一刻的草稿**当参照物:
  // 拿发出去的载荷比,清空会把清空前的旧草稿当成用户新改的、重新挂成未保存,清空等于没清。
  const draftAtStart = JSON.stringify(routingNormalize(routingDraft));
  routingConflict = false; routingError = ''; routingSaving = true; updateRoutingButtons();
  try {
    const res = await api('/api/sessions/' + encodeURIComponent(identity) + '/routing', { method: 'PUT', body: JSON.stringify({ routing: payload, expected_revision: rev }) });
    if (!routingSession || routingSession.key !== identity) return;
    const committed = res?.routing != null ? routingClone(res.routing) : payload;
    const savedRev = res?.revision != null ? res.revision : rev;
    // 提交期间用户又改了草稿:那份改动没被这次请求带上,不能标记成已保存。
    // 只跟"发起保存那一刻的草稿"比——不能跟发出去的载荷比,也不能跟 committed 比:
    // 清空是拿空映射顶掉草稿,载荷与 committed 都是空的,拿它们当参照物会把清空前的
    // 旧草稿判成"用户的新编辑",于是重新挂回未保存,清空等于没清。
    const editedDuring = JSON.stringify(routingNormalize(routingDraft)) !== draftAtStart;
    routingRevision = savedRev; routingDirty = editedDuring;
    if (!editedDuring) routingDraft = routingClone(committed);
    if (routingSession) { routingSession.routing = committed; routingSession.routing_revision = savedRev; }
    renderRoutingEditor(); renderRoutingStatus();
    refresh(); renderSessions();
    toast(okMsg + (editedDuring ? '；保存响应期间的新改动仍在草稿里，需要再保存一次。' : ''), editedDuring ? 'warn' : 'ok');
  } catch (e) {
    if (!routingSession || routingSession.key !== identity) return;
    const msg = String(e.message || '未知错误');
    // 接口把 404/409 也渲染成纯文本(没有状态码可判),只能按文案认。
    // '不存在' 不能泛用:400 的 Key/渠道引用错误也是「所选 Key 不存在…」,那可不是会话没了。
    routingConflict = /已变化|重新载入/.test(msg);
    routingError = routingConflict ? `服务端版本已变化（${msg}）。草稿保留、没有提交；界面只按读到的那个版本写入,不会拿新版本强写,所以直接再点保存还会被拒。要覆盖服务端那一版,请先「放弃草稿并重载」读到最新版本,再重新改一遍并保存；只想丢掉本地改动,同样点它。`
      : /会话不存在/.test(msg) ? `服务端已找不到该会话（${msg}）。可能是会话被空闲回收、清空或解绑了；草稿仍留在界面上，但已无法提交。`
        : `保存失败：${msg}。草稿保留，未写入服务端。`;
    renderRoutingStatus();
    toast(routingConflict ? `会话配置版本已变化，草稿未提交：${msg}` : '保存失败：' + msg, 'err');
    refresh();
  } finally { routingSaving = false; updateRoutingButtons(); }
}
// 轮询把服务端那份带回来:会话没了就收摊;还在就把版本/身份对齐(revision 变了由冲突条提示,绝不静默覆盖草稿)。
function reconcileRouting() {
  if (!routingSession) return;
  const s = (state?.sessions || []).find(x => x.key === routingSession.key);
  if (!s) {
    const wasOpen = activeDialog?.id === 'routing-mask';
    routingSession = null; routingDraft = null; routingRevision = null; routingDirty = false; routingError = ''; routingConflict = false;
    if (wasOpen) { hideDialog(); toast('该会话已不在列表里（可能被清空或解绑），配置弹窗已关闭、未提交任何改动。', 'err'); }
    return;
  }
  routingSession = s;
  if (!routingSaving) renderRoutingIdent();
  renderRoutingStatus();
}
// 列表里的概要:这一列渲染的是 required(用户存下来的要求),不是当前绑定,也不是最近实际落点。
// 文案必须点明"用户要求",否则和隔壁的绑定列看起来像同一件事:requirements 说"我要求它用这个
// Key/槽位",绑定列说"现在会落到哪",实际列说"最近真打的是哪"。
function routingCell(s) {
  const group = groupOfSession(s);
  const r = s.routing || {}, items = [], stale = routingStaleOf(group, r);
  for (const [pid, kid] of Object.entries(r.keys || {})) items.push(`Key ${keyLabelOf(group, pid, kid)}`);
  for (const [name, v] of Object.entries(r.slots || {})) items.push(`槽位 ${name} → ${routingSlotTextOf(group, v)}`);
  return `<span class="routes-cell" data-session-routing="${esc(s.short)}">
    <span class="sum">${items.length ? items.length + ' 项覆盖' : '继承全局'}</span>
    ${items.slice(0, 2).map(x => `<span class="sub">· ${esc(x)}</span>`).join('')}
    ${items.length > 2 ? `<span class="sub">· 其余 ${items.length - 2} 项</span>` : ''}
    ${stale.length ? `<span class="sub" style="color:var(--warn)">⚠ ${stale.length} 项引用已失效</span>` : ''}</span>`;
}

// ---------------- 设置与备份(只读) ----------------
// 这一页把后端早就存在、前端此前零引用的四个端点接出来。四条都是**只读**:
//   /api/backups        备份清点(只有文件名/大小/时间/摘要,响应里没有任何配置正文或密钥)
//   /api/health         渠道冷却/可用性与超时、重试配置
//   /api/routing/preview 路由解释(预测,不消耗游标、不写绑定)
//   /api/metrics        Prometheus 文本,可导出
// 全部走 api(),不新增任何写请求。这里没有任何"恢复"入口:真正的恢复写入不在本期。
let backupsLoaded = false;
async function loadBackups() {
  const box = $('backup-status');
  box.textContent = '正在清点备份…';
  try {
    const res = await api('/api/backups');
    const dirs = Array.isArray(res.dirs) ? res.dirs : [];
    $('backup-dirs').innerHTML = dirs.length ? dirs.map(d => backupDirCard(d, res.keep)).join('') : '<div class="empty"><b>没有备份目标</b>当前后端没有可清点的备份池。</div>';
    const bad = dirs.filter(d => !d.ok).length;
    box.textContent = `保留上限 ${res.keep ?? '未提供'} 份 · 共 ${dirs.length} 个备份池${bad ? ` · ${bad} 个目录读取失败` : ''}。这里只显示文件名与摘要，不含任何配置正文。`;
    backupsLoaded = true;
  } catch (e) {
    // 端点挂了只影响这一块:其它页的草稿、其它面板都不受牵连(每个 fetch 各自 try/catch)。
    $('backup-dirs').innerHTML = '';
    box.textContent = '备份清点读取失败：' + e.message + '。这不影响其它设置项，也不改动任何备份。';
  }
}
function backupDirCard(d, keep) {
  const list = Array.isArray(d.backups) ? d.backups : [];
  const unparsable = Array.isArray(d.unparsable) ? d.unparsable : [];
  const nextDelete = Array.isArray(d.next_delete) ? d.next_delete : [];
  const rows = list.slice(0, 12).map(b => `<tr><td class="mono">${esc(b.name)}</td><td>${esc(b.size)}</td><td class="mono">${esc(b.iso || '')}</td><td class="mono">${esc(b.sha256_12 || '')}</td>${b.legacy ? '<td>旧格式</td>' : '<td></td>'}</tr>`).join('');
  return `<div class="bk-dir">
    <div class="bk-head"><b>${esc(d.label || d.id)}</b><span class="badge ${d.ok ? 'on' : 'off'}">${d.ok ? '已清点' : '读取失败'}</span>
      <span class="mono">${esc(d.dir || '')}</span></div>
    ${d.ok ? `<p class="hint">共 ${d.total ?? list.length} 份${d.legacy ? `，其中 ${d.legacy} 份旧格式` : ''}；下一次备份会删：${nextDelete.length ? nextDelete.map(esc).join('、') : '无(池未满)'}。保留上限 ${keep ?? '未提供'} 份。</p>`
      : `<p class="hint">这个目录没查成：${esc(d.error?.code || '未知原因')}。不是"零份备份"——是"没查成"。</p>`}
    ${unparsable.length ? `<p class="hint">名字像备份但解析不出时间的有 ${unparsable.length} 个：${unparsable.map(esc).join('、')}。它们照样占保留池名额。</p>` : ''}
    ${rows ? `<div class="table-wrap"><table><caption class="sr-only">${esc(d.label || d.id)} 备份清单</caption><thead><tr><th scope="col">文件名</th><th scope="col">大小</th><th scope="col">时间</th><th scope="col">sha256(12)</th><th scope="col">备注</th></tr></thead><tbody>${rows}</tbody></table></div>${list.length > 12 ? `<p class="hint">只显示最近 12 份，共 ${list.length} 份。</p>` : ''}` : '<p class="hint">这个池里还没有备份。</p>'}
  </div>`;
}
async function loadHealth() {
  const box = $('health-status');
  box.textContent = '正在读取健康状态…';
  try {
    const h = await api('/api/health');
    liveHealth = h;
    const s = h.settings || {};
    const facts = [
      ['总预算(ms)', s.total_deadline_ms], ['首字节(ms)', s.first_header_timeout_ms],
      ['流式首字节(ms)', s.stream_first_header_timeout_ms], ['流式空闲(ms)', s.stream_idle_timeout_ms],
      ['非流式总超时(ms)', s.nonstream_total_timeout_ms], ['最大尝试', s.max_attempts],
      ['单请求上游调用上界', s.max_upstream_calls], ['冷却(ms)', s.cooldown_ms],
      ['重试间隔(ms)', s.retry_delay_ms],
    ].filter(([, v]) => v !== undefined);
    $('health-body').innerHTML = `<dl class="config-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(String(v))}</dd></div>`).join('')}</dl>`
      + (Array.isArray(h.providers) && h.providers.length
        ? `<div class="table-wrap"><table><caption class="sr-only">各渠道可用性</caption><thead><tr><th scope="col">渠道</th><th scope="col">协议组</th><th scope="col">启用</th><th scope="col">可用</th><th scope="col">冷却至</th></tr></thead><tbody>${h.providers.map(p => `<tr><td class="mono">${esc(p.provider)}</td><td>${esc(p.app || '')}</td><td>${p.enabled ? '是' : '否'}</td><td>${p.eligible ? '是' : '否'}</td><td class="mono">${p.cooldown_until ? esc(new Date(p.cooldown_until).toLocaleTimeString('zh-CN', { hour12: false })) : '—'}</td></tr>`).join('')}</tbody></table></div>`
        : '');
    box.textContent = '已读取;这是各渠道当前可用性视图,不改任何状态。';
    // 渠道页的卡片也要跟着更新(冷却/可用性徽标);拿不到健康不影响卡片渲染。
    if (view === 'providers') renderProviders();
  } catch (e) {
    liveHealth = null; healthError = e.message;
    $('health-body').innerHTML = '';
    box.textContent = '健康状态读取失败：' + e.message + '。可用性徽标暂时不可用，渠道列表照常显示。';
    if (view === 'providers') renderProviders();
  }
}
async function loadPreview() {
  const box = $('preview-status'), app = $('preview-app').value, model = $('preview-model').value.trim();
  box.textContent = '正在解释…';
  try {
    // POST 只为携带上下文;这条路径只读:不消耗轮询游标,也不写会话绑定(服务端保证)。
    //
    // 这条端点**自己处理非 2xx**:预演的"没有可用候选"是 503、参数不对是 400,而它们都带
    // 一份**有意义的 JSON**(ok:false + stages/candidates 说明为什么),不是传输故障。
    // 走 api() 会把它们当异常抛出来,于是界面上只剩一句报错 ——
    // 而且 503 体里的 error 是个**对象**({code,message,httpStatus}),api() 的 `new Error(j.error)`
    // 会把它串成 "[object Object]",用户看到"路由解释失败:[object Object]"。
    // 所以这里自己 fetch 一次,拿到 body 就按"解释结果"渲染;只有真的连不上/解析不了才进 catch。
    const r = await fetch('/api/routing/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app, model }), cache: 'no-store',
    });
    const res = await r.json();
    const m = res.matched || {}, sel = res.selection || {};
    const cands = Array.isArray(res.candidates) ? res.candidates : [];
    const chosen = sel.predicted?.providerName || sel.predicted?.providerId || '';
    $('preview-body').innerHTML = `<p class="hint"><strong>这是预测，不是实际落点。</strong>真实落点请看「会话」页每行的最近实际请求列。</p>`
      + `<dl class="config-facts">
        <div><dt>命中方式</dt><dd>${esc(m.via || '未提供')}</dd></div>
        <div><dt>命中规则</dt><dd>${esc(m.ruleId || '未命中(走默认路由)')}</dd></div>
        <div><dt>分配策略</dt><dd>${esc(m.strategy || '未提供')}</dd></div>
        <div><dt>预测首选</dt><dd>${esc(chosen || '无法确定(如随机策略)')}</dd></div></dl>`
      + (cands.length ? `<div class="table-wrap"><table><caption class="sr-only">候选渠道</caption><thead><tr><th scope="col">候选</th><th scope="col">模型</th><th scope="col">协议</th><th scope="col">可用</th></tr></thead><tbody>${cands.map(c => `<tr><td class="mono">${esc(c.providerName || c.providerId)}</td><td class="mono">${esc(c.model || '透传')}</td><td>${esc(c.wire || '')}</td><td>${c.eligible ? '是' : (c.cooldown ? '冷却中' : '否')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">没有候选渠道。</p>')
      + (Array.isArray(res.warnings) && res.warnings.length ? `<ul class="config-warnings">${res.warnings.map(w => `<li>${esc(w.message || w.code)}</li>`).join('')}</ul>` : '');
    box.textContent = res.ok ? '解释完成。'
      : `暂无可用落点：${esc((res.error && res.error.message) || '没有候选渠道')}`;
  } catch (e) {
    $('preview-body').innerHTML = '';
    box.textContent = '路由解释失败：' + e.message;
  }
}
// 脱敏导出:指标是纯文本,用 Blob + createObjectURL 存成文件。
// 标签集由服务端固定(不含会话、渠道、模型名或密钥),所以下载下来的东西可以直接给别人看。
async function exportMetrics() {
  const msg = $('metrics-msg');
  msg.textContent = '正在读取指标…';
  try {
    const r = await fetch('/api/metrics', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    // Blob/URL/createElement 任一缺失都明说,不静默失败、也不退化成"复制到剪贴板"之类的暗路
    // (那会让用户以为导出成功了)。真实浏览器三者都有。
    if (typeof Blob !== 'function' || !URL?.createObjectURL || typeof document.createElement !== 'function') { msg.textContent = '当前环境不支持下载，指标文本未能导出。'; return; }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `mixrouter-metrics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    msg.textContent = `已导出 ${text.length} 字节的指标文本；不含任何密钥。`;
  } catch (e) { msg.textContent = '指标导出失败：' + e.message; }
}

// ---------------- 日志 ----------------
let statsSequence = 0, slotStatsLoaded = false;
function slotStatsUnavailable(reason) {
  if (!slotStatsLoaded) $('slot-stats-table').hidden = true;
  $('slot-stats-status').textContent = reason + (slotStatsLoaded ? '；以下为陈旧数据，保留上次读取的分槽快照。' : '；尚无可用分槽快照。');
  $('slot-stats-status').classList.add('stale');
}
function renderSlotStats(s) {
  const bySlot = s.by_slot;
  if (!bySlot || typeof bySlot !== 'object' || Array.isArray(bySlot)) return slotStatsUnavailable('当前服务端未提供分槽统计');
  const scope = s.scope || {}, range = s.range || {};
  const count = n => typeof n === 'number' && Number.isFinite(n) ? String(n) : '未提供';
  const windowText = scope.source === 'memory'
    ? `当前内存窗口，最近最多 ${count(scope.capacity)} 条`
    : scope.source === 'history' ? '磁盘保留历史窗口（非无限历史）' : '统计来源与窗口容量未提供';
  // 范围与分槽归属都来自统计接口，不用最多 200 条的日志列表或当前槽位配置反推。
  $('slot-stats-scope').textContent = `${windowText}；不是全天用量，也不是费用。与下方日志筛选独立。时间戳范围：${range.from ?? '未提供'} → ${range.to ?? '未提供'}（${scope.timezone || '时区未提供'}）。`;
  const names = Object.keys(bySlot).sort();
  const label = name => name === 'none' ? '未命中槽（none）' : name === 'unknown' ? '旧日志未知（unknown）' : name;
  $('slot-stats-body').innerHTML = names.map(name => {
    const row = bySlot[name];
    return `<tr><th scope="row">${esc(label(name))}</th>${['reqs', 'in', 'out', 'cache'].map(key => `<td>${count(row?.[key])}</td>`).join('')}</tr>`;
  }).join('');
  $('slot-stats-table').hidden = names.length === 0;
  $('slot-stats-status').textContent = names.length ? '按请求实际命中的槽位聚合；旧日志缺少槽位时保留为未知。'
    : s.reqs === 0 ? '当前内存窗口没有请求。' : '本次响应没有分槽明细，不能视为零用量。';
  $('slot-stats-status').classList.remove('stale');
  slotStatsLoaded = true;
}
async function loadStats() {
  const sequence = ++statsSequence;
  try {
    const s = await api('/api/stats');
    if (sequence !== statsSequence) return;
    renderSlotStats(s);
    const chips = [
      ['总请求', s.reqs],
      ['成功率', s.ok_rate + '%'],
      ['输入 tokens', fmtTok(s.inTok)],
      ['输出 tokens', fmtTok(s.outTok)],
      ['缓存读', fmtTok(s.cache)],
    ];
    $('stat-chips').innerHTML = chips.map(([k, v]) => `<div class="chip">${k}<b>${esc(String(v))}</b></div>`).join('');
    setLogError('stats', '');
  } catch (e) {
    if (sequence !== statsSequence) return;
    slotStatsUnavailable('分槽统计读取失败：' + e.message);
    setLogError('stats', '统计读取失败：' + e.message);
  }
}
let logsSequence = 0;
const logErrors = {};
function setLogError(source, message) {
  logErrors[source] = message; const messages = Object.values(logErrors).filter(Boolean);
  $('logs-error').textContent = messages.join('；') + (messages.length ? '。已有数据为上次读取的快照。' : '');
  $('logs-error').classList.toggle('show', messages.length > 0);
}
async function loadLogs() {
  const sequence = ++logsSequence;
  try {
    const q = new URLSearchParams();
    if ($('f-app').value) q.set('app', $('f-app').value);
    if ($('f-provider').value.trim()) q.set('provider', $('f-provider').value.trim());
    if ($('f-model').value.trim()) q.set('model', $('f-model').value.trim());
    if ($('f-session').value.trim()) q.set('session', $('f-session').value.trim());
    if ($('f-status').value) q.set('status', $('f-status').value);
    if ($('f-errclass').value) q.set('err_class', $('f-errclass').value);
    q.set('limit', '200');
    const { logs } = await api('/api/logs?' + q.toString());
    if (sequence !== logsSequence) return;
    $('logs-empty').style.display = logs.length ? 'none' : '';
    $('logs-empty').innerHTML = '<b>没有匹配的请求</b>调整筛选条件，或通过本地路由发起调用。';
    $('logs-body').innerHTML = logs.map(l => {
      const cls = l.status >= 500 || l.status === 0 || l.err ? 'st5' : l.status >= 400 ? 'st4' : 'st2';
      const sess = l.session
        ? `<span class="sess-tag" title="${esc(l.session_kind || '')}">${esc(l.session)}</span>`
        : '<span style="color:var(--dim)">-</span>';
      const fo = l.failover ? ' <span class="cool" title="首选渠道失败,已转移到当前渠道">↷转移</span>' : '';
      const tr = l.wire === 'chat' && (l.kind === 'responses') ? ' <span class="cool" title="responses→chat 协议翻译">⇄翻译</span>' : '';
      const appTag = l.app === 'codex' ? '<span class="badge info">OpenAI</span> ' : '<span class="badge info">Anthropic</span> ';
      return `<tr><td>${esc(l.ts.slice(5, 19))}</td><td>${sess}</td>
        <td style="font-family:inherit">${appTag}${esc(l.provider || '-')}${fo}${tr}</td>
        <td>${esc(l.model_in)}${l.model_out && l.model_out !== l.model_in ? ' → ' + esc(l.model_out) : ''}</td>
        <td>${l.in || '-'}</td><td>${l.out || '-'}</td><td>${l.cache_read || '-'}</td><td>${cacheHitText(l)}</td>
        <td>${fmtRate(l)}</td><td>${fmtTtfb(l.ttfb_ms)}</td><td>${fmtBytes(l.bytes_in)}</td>
        <td>${l.ms ? l.ms + 'ms' : '-'}</td><td class="${cls}">${l.status || '-'}</td>
        <td style="color:var(--err)">${esc(l.err || '')}${l.err_class ? ` <span class="cool" title="失败分类 err_class">${esc(l.err_class)}</span>` : ''}</td></tr>`;
    }).join('');
    setLogError('logs', '');
  } catch (e) { if (sequence === logsSequence) setLogError('logs', '日志读取失败：' + e.message); }
}
function clearFilters() {
  $('f-app').value = ''; $('f-provider').value = ''; $('f-model').value = ''; $('f-session').value = ''; $('f-status').value = ''; $('f-errclass').value = '';
  loadLogs();
}
function restartLogsTimer() { clearInterval(logsTimer); logsTimer = setInterval(() => { if ($('logs-auto').checked) { loadLogs(); loadStats(); } }, 5000); }

refresh();
