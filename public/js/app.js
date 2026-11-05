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
  $('connection-label').textContent = connected ? '控制台已连接' : '控制台离线';
  $('connection-banner').classList.toggle('show', !connected);
  $('connection-message').textContent = connected ? '' : `无法获取实时状态${error ? '：' + error : ''}。${lastSync ? '当前为 ' + lastSync.toLocaleTimeString('zh-CN', { hour12: false }) + ' 的最后快照，运行时长和指标已停止更新。' : '尚无可用快照。'}每 5 秒自动重试；压缩草稿仍保留。`;
  $('new-provider').disabled = !state;
  // 缺渠道或模型名时保存必被拦下,按钮直接禁用,不让人点了才看到报错。
  $('save-compact').disabled = !connected || !state?.compact || savingCompact || !compactDraft?.provider || !compactDraft.model?.trim();
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
  $('metric-sessions-hint').textContent = '按协议归组 · 失败后仍可重试';
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
  $('refresh-btn').disabled = true;
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
      state = next; lastSync = new Date();
      if (state.compact && !compactDraft) loadCompactDraft();
      renderCompactCurrent(); renderCompactKeys();
      renderOverview(); setConnection(true); updateCompactStatus(); renderSlots();
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
      renderOverviewPage(); renderSlots();
      if (view === 'providers') renderProviders();
      return false;
    }
    finally { $('refresh-btn').disabled = false; refreshTask = null; }
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
  // 槽位里的僵尸引用:槽位指向已删除的渠道。命中即失败,用户得在界面上看得见、能跳去改。
  const ghosts = ghostSlotRefs();
  // 会话里引用已失效的渠道 / Key:面板里 routingStaleOf() 已能逐条算,这里只给总数。
  let staleSessions = 0;
  for (const s of state.sessions || []) if (routingStaleOf(groupOfSession(s), s.routing).length) staleSessions++;

  if (disabledProviders.length) items.push({ text: `${disabledProviders.length} 个渠道已停用：${disabledProviders.map(p => p.name).join('、')}`, view: 'providers', action: '去渠道与 Key' });
  if (disabledKeys.length) items.push({ text: `${disabledKeys.length} 把 Key 已停用：${disabledKeys.map(({ provider, key }) => `${provider.name} · ${key.label || key.id}（${key.id}）`).join('、')}`, view: 'providers', action: '去渠道与 Key' });
  if (ghosts.length) items.push({ text: `槽位里有失效引用，请求会失败：${ghosts.join('；')}`, view: 'providers', action: '去渠道与 Key' });
  if (staleSessions) items.push({ text: `${staleSessions} 个会话的 Key / 槽位覆盖里存在已失效的引用`, view: 'sessions', action: '去会话' });

  if (!items.length) return '<p class="ov-ok" id="overview-todo-empty">没有需要处理的事项。</p>';
  return `<ul class="ov-todo" id="overview-todo-list">${items.map(it => `<li><span>${esc(it.text)}</span>${overviewJump(it.view, it.action)}</li>`).join('')}</ul>`;
}
// 槽位的僵尸引用:槽位表里指向已删除渠道的条目。只读复算,不改任何状态。
function ghostSlotRefs() {
  const out = [];
  for (const app of Object.keys(APPS)) {
    for (const s of state?.slots?.[app] || []) {
      if (s.provider && !providers(app).some(p => p.id === s.provider)) {
        out.push(`${APPS[app].label} 槽位 ${s.name} 的渠道（${s.provider}）`);
      }
    }
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
  $('ov-cooldowns').textContent = '按协议归组 · 失败后仍可重试';

  $('overview-todo').innerHTML = overviewTodo();
  // 没有事项时把整块收成一条状态行(样式按 data-state),有事项才展开成卡片。
  const todoPanel = $('overview-todo-panel');
  if (todoPanel) todoPanel.dataset.state = $('overview-todo').innerHTML.includes('overview-todo-list') ? 'active' : 'clear';

  // 三行客户端状态:复用 liveFacts 的口径,不另造一套判断。
  // 一行一件事:徽标说模式,有接入地址才写地址,配置文件路径跟在后面;
  // 未接入的行给一个「去接入」——只切视图并发请求,已接入的行不给,免得整页都是按钮。
  $('overview-clients').innerHTML = Object.keys(APPS).map(app => {
    const f = liveFacts(app);
    const wire = f.lv?.wire_api ? `协议 ${esc(f.lv.wire_api)}` : '';
    const configured = !!(f.healthy && f.lv?.base_url);
    // 状态文案与徽标同义时不重复:未接入的三行曾经都写成「尚未配置 尚未配置」。
    const state = f.stateLabel && f.stateLabel !== f.mode ? `<span class="ov-state">${esc(f.stateLabel)}</span>` : '';
    const addr = f.lv?.base_url ? `<span class="mono ov-addr">${esc(f.lv.base_url)}</span>` : '';
    const goto = configured ? '' : `<button class="ov-goto" type="button" data-app="${app}" onclick="overviewGoConnect(${handlerArg(app)})">去接入</button>`;
    return `<div class="ov-row" data-app="${app}"><div class="ov-row-name">${esc(APPS[app].label)}</div>
      <div class="ov-row-main"><span class="badge ${configured ? 'on' : 'off'}">${esc(f.mode)}</span>${state}${wire ? `<span class="ov-state">${wire}</span>` : ''}${addr}${goto}</div>
      <div class="mono ov-cfg">${esc(APPS[app].cfg)}</div></div>`;
  }).join('');

  // 接入地址 = "我在哪里填什么"。缺 base 时退回 url(与 routerBase 同口径)。
  // 完整端点清单默认收起:两行基址已经回答了「填什么」,这里只是备查。
  const r = state.router || {};
  const endpoints = [...new Set(Array.isArray(r.endpoints) ? r.endpoints : [])];
  $('overview-endpoints').innerHTML = [
    ['Claude Code / Anthropic', r.claude_base || r.url || ''],
    ['Codex / OpenAI', r.codex_base || r.url || ''],
  ].map(([label, value]) => `<div class="ov-row"><div class="ov-row-name">${esc(label)}</div><div class="mono">${esc(value || '未提供')}</div></div>`).join('')
    + (endpoints.length ? `<details class="ov-endpoints-more"><summary>全部端点（${endpoints.length}）</summary><div class="ov-endpoint-list">${endpoints.map(esc).join('<br>')}</div></details>` : '');

  // 接入向导入口只在还有客户端没写入配置时露面;两个都接好了就没必要占首屏。
  const ready = $('readiness-overview');
  if (ready) ready.hidden = Object.keys(APPS).every(app => { const f = liveFacts(app); return !!(f.healthy && f.lv?.base_url); });
  // 侧栏状态点与这里同源(都读 liveFacts),必须排在 setConnection 之后,
  // 否则一次成功的刷新会先把点画成「未接入」。
  syncClientDots();
}
// 「去接入」:切到渠道页并选中这个客户端,再聚焦向导入口;不写任何配置。
function overviewGoConnect(app) {
  const target = APPS[app] ? app : 'claude';
  if (typeof window.workspaceNavigate === 'function') {
    try { window.workspaceNavigate('providers', target); } catch (e) { console.error(e); }
  } else {
    if (typeof setApp === 'function') setApp(target);
    if (typeof showView === 'function') showView('providers');
  }
  const entry = document.getElementById('readiness-open');
  if (entry && typeof entry.focus === 'function') entry.focus();
}
