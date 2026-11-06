'use strict';
function routerBase(app = curApp) {
  const r = state?.router || {};
  return app === 'claude' ? (r.claude_base || r.url || '') : (r.codex_base || r.url || '');
}
const connectionExpanded = {};
// 已保存的接入偏好优先;旧渠道沿用实际接入方式,新 Responses 渠道默认直连。
function codexProviderMode(provider) {
  if (provider?.wire_api === 'chat') return 'router';
  return provider?.codex_mode || (provider?.id && provider.id === codexActiveProviderId() ? codexConnectionMode() : 'direct');
}
function codexConnectionMode(lv = state?.live?.codex) {
  if (!lv || lv.error) return 'unconfigured';
  return lv.connection_mode || (lv.router ? 'router' : lv.base_url ? 'direct' : 'unconfigured');
}
function codexDirectProviderId(lv = state?.live?.codex) {
  if (codexConnectionMode(lv) !== 'direct') return '';
  return lv.direct_provider_id ?? (lv.match === true && state.current?.codex !== '@router' ? state.current?.codex || '' : '');
}
function codexDirectProviderName(lv = state?.live?.codex) {
  return lv?.direct_provider_name || providers('codex').find(p => p.id === codexDirectProviderId(lv))?.name || lv?.provider || '自定义上游';
}
function codexActiveProviderId() {
  const mode = codexConnectionMode();
  if (mode === 'direct') return codexDirectProviderId();
  if (mode !== 'router') return '';
  const model = state.live.codex.model;
  const slot = (state.slots?.codex || []).find(s => s.alias === model);
  if (slot) return slot.provider || '';
  const matches = providers('codex').filter(p => p.enabled && [p.model, ...(p.models || [])].includes(model));
  return matches.length === 1 ? matches[0].id : '';
}
function codexNativeClientOnly(text) {
  return /only allows Codex official clients|Codex official clients|仅接受\s*Codex\s*官方客户端/i.test(String(text || ''));
}
// 客户端接入状态的判定口径只此一处。概览页与渠道页读同一个函数,不各写一套——
// 两处各判一次迟早会分叉,而这两处说的都是"客户端到底写了没有",分叉就是骗人。
// app 显式传入而不是读 curApp:概览要两行并排看。
function liveFacts(app) {
  const lv = state.live?.[app], cur = state.current?.[app];
  const isCodex = app === 'codex';
  const codexMode = isCodex ? codexConnectionMode(lv) : '';
  const actualId = isCodex ? codexActiveProviderId() : cur;
  const selected = allProviders().find(p => p.id === actualId);
  const healthy = online && lv && !lv.error;
  const inRouter = healthy && (isCodex ? codexMode === 'router' : !!lv.router);
  const direct = healthy && (isCodex ? codexMode === 'direct' : !!lv.base_url && !lv.router);
  const stateLabel = !online ? '离线 · 最后快照' : !lv ? '状态未提供' : lv.error ? '配置读取失败' : (isCodex ? codexMode !== 'unconfigured' : lv.base_url) ? '已写入配置' : '尚未配置';
  const slot = inRouter ? (state.slots?.[app] || []).find(s => s.alias === lv?.model) : null;
  let configuredName;
  if (!healthy) configuredName = '待确认';
  else if (inRouter) configuredName = slot?.provider_name || '按槽位分发';
  else if (isCodex) configuredName = direct ? codexDirectProviderName(lv) : lv?.provider || '未配置';
  else configuredName = lv?.match === true ? selected?.name || lv?.provider || '未配置' : lv?.provider || '自定义上游';
  // 概览页要的一句结论:现在这套客户端配置是直连、走路由,还是压根没接。
  const mode = !healthy ? '待确认' : inRouter ? '路由模式' : direct ? '直连' : '尚未配置';
  return { lv, cur, selected, healthy, inRouter, direct, stateLabel, slot, configuredName, mode, codexMode };
}
function liveLine() {
  const { lv, cur, selected, healthy, inRouter, direct, stateLabel, slot, configuredName, codexMode } = liveFacts(curApp);
  const isCodex = curApp === 'codex';
  const modeBadge = enabled => enabled ? '<span class="badge on">已写入配置</span>' : `<span class="badge off">${!healthy ? '待确认' : '未接入'}</span>`;
  const modeLabel = !healthy ? '待确认' : isCodex ? (codexMode === 'router' ? 'Mixrouter 路由' : codexMode === 'direct' ? 'Codex 直连' : '未接入') : inRouter ? '本地路由' : direct ? '直连' : '未接入';
  const modeTone = healthy && (inRouter || direct) ? 'on' : 'off';
  const directName = isCodex ? codexDirectProviderName(lv) : (lv?.match === true ? selected?.name || lv?.provider || '自定义上游' : lv?.provider || '自定义上游（配置未匹配）');
  const model = slot?.model || lv?.model || '未配置';
  const reasoning = isCodex ? String(lv?.model_reasoning_effort || '').trim() : '';
  const fast = isCodex && ['fast', 'priority'].includes(lv?.service_tier) ? 'Fast' : '';
  // 两个客户端共用同一块「当前配置」摘要,口径一致(liveFacts 一处判定),
  // 接入细节默认收起、按客户端记住展开状态。
  // 详情里仍是那两张模式卡与配置行,离线时 liveFacts 会把它们降级成「待确认」,不冒充已写入。
  return `<dl class="current-config${isCodex ? ' codex-config' : ''}">
    <div class="config-mode"><dt>接入方式</dt><dd><span class="mode-pill ${modeTone}">${modeLabel}</span></dd><small>${esc(lv?.wire_api || '')}</small></div>
    <div><dt>当前渠道</dt><dd title="${esc(configuredName)}">${esc(configuredName)}</dd><small>${esc(stateLabel)}</small></div>
    <div><dt>默认模型</dt><dd class="mono" title="${esc(model)}">${esc(model)}</dd>${slot ? `<small>槽位 ${esc(lv.model)}</small>` : ''}</div>
    ${isCodex ? `<div><dt>推理强度</dt><dd>${esc(reasoning || '客户端默认')}</dd>${fast ? `<small><span class="badge on">${esc(fast)}</span></small>` : ''}</div>` : ''}
    </dl><details class="connection-details"${connectionExpanded[curApp] ? ' open' : ''} ontoggle="connectionExpanded['${curApp}']=this.open"><summary>连接配置</summary><div class="mode-grid">
    <article class="mode-card ${direct ? 'selected' : ''}"><div class="top"><h2>${isCodex ? 'Codex 直连' : '直连渠道'}</h2>${modeBadge(direct)}</div><p>${direct ? esc(directName) : '客户端直接请求上游，不经过本地路由'}</p><p class="mono">${esc(direct && lv?.base_url ? lv.base_url : '从下方渠道卡片选择接入')}</p></article>
    <article class="mode-card ${inRouter ? 'selected' : ''}"><div class="top"><h2>${isCodex ? 'Mixrouter 路由' : '路由模式'}</h2>${modeBadge(inRouter)}</div><p>经本地代理按精确槽位与已登记模型分发，按会话保持渠道粘性</p><p class="mono">${esc(inRouter ? lv.base_url || routerBase() : routerBase() || '等待后端提供路由地址')}</p></article>
    </div><p class="config-line">${esc(APPS[curApp].cfg)} · ${stateLabel}${lv?.wire_api ? ' · 协议 ' + esc(lv.wire_api) : ''}${lv?.model ? ' · 配置模型 ' + esc(lv.model) : ''}${isCodex ? ' · 实际渠道 ' + esc(configuredName) : cur ? ' · 库内选中 ' + esc(cur === (state.router?.id || '@router') ? '路由模式' : selected?.name || cur) : ''}</p>
    <p class="integration-note">切换会写入客户端配置，原文件自动备份。${curApp === 'claude' ? 'Claude Code 需重启会话生效。' : '首次接入或切换直连需重新打开 Codex；路由槽位调整从下一次请求生效。'}</p></details>`;
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
// 头像色相按渠道 id 定死(改名不变色):FNV-1a 再混一次位,相邻 id 也能落到相隔较远的色相上。
function providerHue(id) {
  let h = 2166136261;
  for (const ch of String(id || '')) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) % 36 * 10;
}
function renderProviders() {
  document.body.dataset.client = curApp;
  if (typeof renderBotsModels === 'function') renderBotsModels();
  // 标题对所有客户端同一口径;大小写眉标与副标题由外壳按设计处理,这里不再按客户端藏。
  const title = $('providers-title'); if (title) title.textContent = '渠道与 Key';
  applyProviderLayout();
  const group = providerGroup();
  const isCodexGroup = group === 'codex';
  const actualCodexMode = isCodexGroup ? codexConnectionMode() : '';
  document.body.dataset.codexMode = actualCodexMode;
  $('btn-router').textContent = '路由模式';
  $('btn-router').disabled = !online || !state;
  if (!state) {
    if (!online && document.body.dataset.connection === 'offline') $('liveinfo').innerHTML = '<div class="empty"><b>无法读取客户端配置</b>请检查本地 Mixrouter 服务；连接恢复后会自动刷新。</div>';
    return;
  }
  const ps = providers(group), query = $('provider-search').value.trim().toLowerCase(), filter = $('provider-filter').value;
  const facts = liveFacts(curApp), slots = state.slots?.[curApp] || [];
  const mainProvider = facts.direct && facts.healthy
    ? (isCodexGroup ? codexDirectProviderId() : facts.lv?.match === true ? facts.cur : '')
    : facts.inRouter ? slots.find(s => s.name === 'main')?.provider : '';
  const referenced = new Set(facts.inRouter ? slots.map(s => s.provider).filter(Boolean) : []);
  const rank = p => p.id === mainProvider ? 0 : referenced.has(p.id) ? 1 : p.enabled ? 2 : 3;
  // 只排显示副本,不改渠道库顺序;被槽位引用优先不等于客户端已经使用该槽。
  const shown = ps.filter(p => (!query || [p.name, p.base_url, p.model, ...(p.models || []), ...Object.values(p.slots || {})].join(' ').toLowerCase().includes(query)) && (filter === 'all' || (filter === 'enabled' ? p.enabled : !p.enabled)))
    .sort((a, b) => rank(a) - rank(b));
  $('channel-heading').textContent = `${APPS[curApp].label} 渠道库`;
  $('channel-count').textContent = `显示 ${shown.length} / ${ps.length} 个渠道 · ${ps.filter(p => p.enabled).length} 个已启用`;
  $('prov-empty').hidden = shown.length > 0;
  $('empty-title').textContent = ps.length ? '没有匹配的渠道' : `${GROUPS[group]} 还没有渠道`;
  $('empty-hint').textContent = ps.length ? '尝试其他名称、URL 或模型，或清除启用状态筛选。' : '新建一个渠道，填写上游地址与模型后即可配置直连或路由。';
  $('empty-action').textContent = ps.length ? '清除筛选' : '＋ 新建渠道';
  $('empty-action').onclick = ps.length ? () => { $('provider-search').value = ''; $('provider-filter').value = 'all'; renderProviders(); $('provider-search').focus(); } : () => openProvider();
  const liveHtml = liveLine();
  if ($('liveinfo').innerHTML !== liveHtml && !$('liveinfo').contains(document.activeElement))
    $('liveinfo').innerHTML = liveHtml;
  const lv = state.live?.[curApp], curId = state.current?.[curApp];
  // 可用性按渠道 id 索引一次,卡片里按 id 取。只读,来自 /api/health
  // (liveHealth 可能还没回来或读失败;冷却已移除,/api/state 的 cooldowns 恒为空表)。
  const healthById = new Map((liveHealth?.providers || []).map(h => [h.provider, h]));
  // Claude 路由模式下"在用"按槽位判:客户端 env 里确实写着该槽别名(main 看 ANTHROPIC_MODEL)的槽,
  // 才算把请求交给了它的渠道。库内 current 此时是 @router,不能拿来标卡片。
  const claudeRouted = new Map();
  if (!isCodexGroup && online && lv?.router && !lv.error) {
    for (const s of state.slots?.claude || []) {
      const written = s.name === 'main' ? lv.model : lv.slots?.[s.name];
      if (s.provider && s.enabled !== false && written === s.alias) claudeRouted.set(s.provider, [...(claudeRouted.get(s.provider) || []), s.name]);
    }
  }
  let warning = '';
  if (lv?.error) warning = `客户端配置读取失败：${lv.error}。无法确认集成状态，请检查配置后重试。`;
  // Codex 的实际直连渠道由 base URL + Key 判定;current 还停在 @router 不是漂移。
  else if (online && lv && (isCodexGroup ? (!codexDirectProviderId(lv) && lv.match === false) : (curId && lv.match === false)))
    warning = `${APPS[curApp].label} 配置与库内选择不一致。可通过渠道「重新应用」或重新启用路由模式恢复，写入前自动备份。`;
  $('drift-banner').classList.toggle('show', !!warning); $('drift-text').textContent = warning;
  // 健康端点挂了不能把整页拖垮:读不到就只显示一句"健康状态未读取",其余卡片照常渲染。
  $('prov-health').hidden = !!liveHealth;
  $('prov-health').textContent = liveHealth ? '' : (healthError ? `健康状态未读取（${healthError}）：渠道可用性暂时不可用。` : '健康状态尚未读取；进入「设置与备份」页可读取渠道可用性。');
  const html = shown.map(p => {
    // Codex 的“当前”只认 live 实际状态:直连看 direct_provider_id,路由看主槽位。
    // 库内 current 可能还停在 @router,不能拿它给渠道卡片贴「已写入/库内选中」。
    const codexMode = isCodexGroup ? codexProviderMode(p) : '';
    const activeId = isCodexGroup ? codexActiveProviderId() : curId;
    const isCur = activeId === p.id;
    const activeRouter = isCodexGroup && online && !lv?.error && actualCodexMode === 'router' && isCur;
    const drift = isCodexGroup ? false : isCur && lv?.match === false;
    const verified = isCodexGroup
      ? online && !lv?.error && actualCodexMode === 'direct' && isCur
      : online && !lv?.error && isCur && lv?.match === true && !lv.router;
    const routedSlots = claudeRouted.get(p.id) || [];
    const routedMain = routedSlots.includes('main'), routedOthers = routedSlots.filter(n => n !== 'main');
    const t = testResults[p.id];
    // Codex 的测试请求由 Mixrouter 自己发出,不是 Codex 客户端,所以标题必须说明来源。
    const testLabel = isCodexGroup ? '路由器检测' : '测试';
    const testSummary = t && !t.wait && (String(t.error || '') + ' ' + String(t.body || ''));
    const testMismatch = isCodexGroup && !t?.ok && codexNativeClientOnly(testSummary);
    const tline = !t ? '' : t.wait
      ? `<div class="testline wait" role="status">${testLabel}中…</div>`
      : `<div class="testline ${t.ok ? 'ok' : 'err'}" role="status">${testLabel}${t.ok ? '通过' : '失败'} · ${esc(t.ok ? `${t.status} · ${t.ms}ms${t.model ? ' · ' + t.model : ''}` : t.error || ('HTTP ' + t.status))}${!t.ok && t.body ? ' · ' + esc(t.body.slice(0, 120)) : ''}${testMismatch ? ' · 上游只接受 Codex 官方客户端；本次是 Mixrouter 发起的检测，来源不匹配，不代表 Codex 直连不可用' : ''}</div>`;
    // 模型测活结果。状态在 modelProbe 里(跨重绘保留),这里只负责翻成 DOM:
    // 每行 = 模型名 + 文字结论徽标 + HTTP/耗时 + 截断后的失败原因(全文进 title)。
    // 模型名与上游错误都来自用户输入/上游返回,一律 esc。
    const mp = modelProbe[p.id];
    let pline = '';
    const probeMismatch = isCodexGroup && (mp?.error ? codexNativeClientOnly(mp.error)
      : (mp?.results || []).some(r => codexNativeClientOnly(r.error)) || false);
    if (mp?.wait) pline = `<div class="probeline wait" role="status">${isCodexGroup ? '路由器检测 · ' : ''}模型测活中…</div>`;
    else if (mp?.error) pline = `<div class="probeline err" role="status">${isCodexGroup ? '路由器检测 · ' : ''}模型测活失败：${esc(mp.error)}</div>`;
    else if (mp?.results) {
      const resultCount = mp.results.length;
      const passed = mp.passed ?? mp.results.filter(r => r.ok).length, failed = mp.failed ?? (resultCount - passed);
      const total = mp.total_ms == null ? '' : ` · ${mp.total_ms}ms`;
      const rows = mp.results.map(r => {
        const reason = String(r.error || ''), cut = reason.length > 60 ? reason.slice(0, 60) + '…' : reason;
        const meta = [r.status == null ? '' : `HTTP ${r.status}`, r.ms == null ? '' : `${r.ms}ms`].filter(Boolean).join(' · ');
        return `<div class="probeline ${r.ok ? 'ok' : 'err'}"><span class="pm-name mono">${esc(r.model)}</span><span class="pm-verdict ${r.ok ? 'ok' : 'err'}">${r.ok ? '通过' : '失败'}</span><span class="pm-meta mono">${esc(meta)}</span>${cut ? `<span class="pm-reason" title="${esc(reason)}">${esc(cut)}</span>` : ''}</div>`;
      }).join('');
      pline = `<div class="probelines" role="status"><div class="probeline sum mono">${isCodexGroup ? '路由器检测 · ' : ''}${resultCount} 个模型 · ${passed} 通过 ${failed} 失败${total}</div>${rows}</div>`;
    }
    if (probeMismatch) pline += '<div class="probeline note">上游只接受 Codex 官方客户端；模型测活由 Mixrouter 发起，来源不匹配不代表 Codex 直连不可用。此项未验证客户端直连。</div>';
    const models = group === 'claude' ? (p.models || []) : [p.model].filter(Boolean);
    const wire = group === 'claude' ? (p.wire_api === 'responses' ? 'responses（转换）' : p.wire_api === 'chat' ? 'chat（转换）' : 'anthropic') : p.wire_api || 'responses';
    // Claude 的 responses/chat 渠道不能直接写入客户端;Codex 的 Chat 渠道不能直连,但仍可应用路由。
    const convOnly = group === 'claude' && (p.wire_api === 'responses' || p.wire_api === 'chat');
    const codexDirectOff = isCodexGroup && p.wire_api === 'chat';
    const arg = handlerArg(p.id), locked = !online || convOnly;
    // 失效(停用)的 Key:卡片上先给数量,展开的多 Key 清单里能逐把看出来是哪几把。
    // 只报 label 与 id —— 明文 Key 从不进入任何渲染路径(见 renderKeyDraft 的密码框与卡片下拉)。
    const keys = p.keys || [];
    const deadKeys = keys.filter(k => k.enabled === false);
    const hp = healthById.get(p.id);
    const healthBits = [];
    // 直连请求不经过本机路由,路由侧健康快照说“不可用”不能拿来否定客户端直连。
    if (hp && hp.eligible === false && p.enabled && !(isCodexGroup && (isCur ? actualCodexMode : codexMode) === 'direct'))
      healthBits.push('<span class="badge off provider-health" title="按路由侧健康状态不可用">暂不可用</span>');
    // 卡片分四块:身份(头像 + 名称 + 状态徽标)、内容(地址/协议/模型/告警)、账号与测试结果、
    // 动作。旧类名 .card/.top/.foot/.tags 保留,新增的 provider-* 只负责分区;动作按钮与 data-*
    // 原样不动,样式层按这套区块做 grid/list 两种排布。
    // 头像用渠道名首字母(ASCII 取前两位),纯装饰,不参与朗读。
    const nameText = String(p.name || '?').trim();
    const avatar = (/^[\x20-\x7e]+$/.test(nameText) ? nameText.slice(0, 2) : nameText.slice(0, 1)).toUpperCase() || '?';
    const statusBadges = [
      isCur ? `<span class="badge ${verified || activeRouter ? 'on' : 'off sel'}">${verified ? '已写入配置' : activeRouter ? '路由在用' : isCodexGroup ? '最后快照 · 待确认' : '库内选中'}</span>` : '',
      // 同一句「路由在用」:主模型槽所在渠道用 on 色,只被其它槽引用的用次一级的 route 色并写明槽名。
      routedSlots.length ? `<span class="badge ${routedMain ? 'on' : 'route'}" title="客户端 env 已写入这些槽位别名，请求经本机路由落到此渠道">路由在用${routedMain ? ' · 主模型' : ''}${routedOthers.length ? ' · 槽位 ' + routedOthers.map(esc).join(' / ') : ''}</span>` : '',
      drift && online ? '<span class="badge drift">配置不一致</span>' : '',
      `<span class="badge provider-state ${p.enabled ? 'info' : 'off'}">${p.enabled ? '启用' : '停用'}</span>`,
      deadKeys.length ? `<span class="badge off" title="有停用的 Key">${deadKeys.length} 把 Key 已停用</span>` : '',
      ...healthBits,
    ].join('');
    // 账号只露 label / 掩码,明文 Key 从不进入卡片(停用的 Key 也一样)。
    // 账号数紧跟在同一个下拉后面,不让它自己换行成第二处信息。
    const account = keys.length
      ? `<select class="keypick" data-provider="${esc(p.id)}" data-action="key" aria-label="${esc(p.name)} 当前账号" onchange="setActiveKey(${arg},this.value)">${keys.map(k => `<option value="${esc(k.id)}" ${k.id === p.active_key ? 'selected' : ''}>${esc(k.label)} · ${esc(k.key_masked)}${k.enabled === false ? ' · 已停用' : ''}</option>`).join('')}</select><span class="muted keycount">${keys.length} 个账号${deadKeys.length ? ' · ' + deadKeys.length + ' 把已停用' : ''}</span>`
      : `<span class="key-masked">${esc(p.key_masked || '未配置')}</span>`;
    // Claude 的这个按钮只做一件事:把该渠道的地址/Key/模型写进 Claude 配置(switchClaude),
    // 路由模式下等于退出路由,mixr- 槽位别名一并清掉。文案按这个真实效果写。
    const claudeInRouter = !isCodexGroup && !!lv?.router;
    const switchLabel = isCodexGroup
      ? (isCur && actualCodexMode === codexMode ? '重新应用' : codexMode === 'router' ? '应用路由' : '应用直连')
      : claudeInRouter ? '改为直连' : isCur ? '重新写入' : '直连此渠道';
    const switchTitle = convOnly ? '该渠道只挂 Codex 型通道，直连不可用：请用上方「路由模式」'
      : codexDirectOff ? 'Chat 渠道不能写入 Codex 直连；请用「应用路由」'
      : isCodexGroup ? ''
      : claudeInRouter ? '把此渠道写入 Claude 配置并退出路由模式（清掉 mixr- 槽位别名），原文件自动备份'
      : isCur ? '把此渠道重新写入 Claude 配置，原文件自动备份'
      : '把此渠道写入 Claude 配置（直连），原文件自动备份';
    // 只能走路由的 Claude 渠道没有可点的写入动作:不摆一个禁用的主按钮,换成一枚说明标签。
    const switchControl = convOnly
      ? `<span class="tag route-only-tag" title="${switchTitle}">仅路由可用</span>`
      : `<button class="small ${verified || activeRouter ? 'cur' : claudeInRouter || actualCodexMode === 'router' ? '' : 'primary'}" data-action="switch" data-provider="${esc(p.id)}" onclick="switchProvider(${arg})" ${locked ? 'disabled' : ''} title="${switchTitle}">${switchLabel}</button>`;
    return `<article class="card ${p.enabled ? '' : 'off'} ${verified || activeRouter || routedMain ? 'cur' : ''} ${isCur && !verified && !activeRouter ? 'sel' : ''}" data-provider="${esc(p.id)}" style="--avatar-h:${providerHue(p.id)}">
      <header class="top provider-identity">
        <span class="provider-avatar" aria-hidden="true">${esc(avatar)}</span>
        <div class="provider-info"><h3 class="name" title="${esc(p.name)}">${esc(p.name)}</h3><div class="provider-status">${statusBadges}</div></div>
      </header>
      <div class="provider-content">
        <div class="provider-models tags">${isCodexGroup ? `<span class="tag codex-mode-tag">${codexMode === 'router' ? 'Mixrouter 路由' : 'Codex 直连'}</span>` : ''}<span class="tag wire-tag">${esc(wire)}</span>${models.map(m => `<span class="tag model-tag" title="${esc(m)}">${esc(m)}</span>`).join('')}${p.drop_images ? '<span class="tag">纯文本</span>' : ''}${p.direct ? '<span class="tag">绕过出站代理</span>' : ''}${p.proxy_url ? '<span class="tag">经代理</span>' : ''}</div>
        <div class="mono endpoint" title="${esc(p.base_url)}">${esc(p.base_url)}</div>
        ${deadKeys.length ? `<p class="note dead-keys">已停用的 Key：${deadKeys.map(k => `${esc(k.label || k.id)}（${esc(k.id)}）`).join('、')}。停用只影响固定选它的会话与压缩规则，不会自动改选其他 Key。</p>` : ''}${p.note ? `<p class="note dev-note" title="${esc(p.note)}">${esc(p.note)}</p>` : ''}

      </div>
      <div class="provider-meta mono keyrow"><span class="key-label">Key</span>${account}${tline}${pline}</div>
      <div class="foot provider-actions">${switchControl}
        <button class="small provider-icon-action" data-action="test" data-provider="${esc(p.id)}" onclick="testProvider(${arg})" ${!online || t?.wait ? 'disabled' : ''} title="${testLabel}：由 Mixrouter 发起一次真实请求" aria-label="${testLabel}"><span class="icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m7 4 9 6-9 6z"/></svg></span><span class="sr-only">${testLabel}</span></button>
        <button class="small provider-icon-action" data-action="probe" data-provider="${esc(p.id)}" onclick="probeModels(${arg})" ${!online || mp?.wait ? 'disabled' : ''} title="${isCodexGroup ? '路由器测活' : '测活'}：对每个模型各发一次真实请求，会消耗额度" aria-label="${isCodexGroup ? '路由器测活' : '测活'}"><span class="icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10h4l2-5 4 10 2-5h4"/></svg></span><span class="sr-only">${isCodexGroup ? '路由器测活' : '测活'}</span></button>
        <button class="small provider-icon-action" data-action="edit" data-provider="${esc(p.id)}" onclick="openProvider(${arg})" title="编辑渠道" aria-label="编辑"><span class="icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 4 4 4M4 12l9-9 4 4-9 9-5 1z"/></svg></span><span class="sr-only">编辑</span></button>
        <button class="small provider-icon-action" data-action="toggle" data-provider="${esc(p.id)}" onclick="toggleProvider(${arg})" ${!online ? 'disabled' : ''} title="${p.enabled ? '停用' : '启用'}渠道；不撤销客户端直连配置" aria-label="${p.enabled ? '停用' : '启用'}"><span class="icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5v7M5.5 5a7 7 0 1 0 9 0"/></svg></span><span class="sr-only">${p.enabled ? '停用' : '启用'}</span></button>
        <button class="small danger provider-icon-action" data-action="delete" data-provider="${esc(p.id)}" onclick="delProvider(${arg})" ${!online ? 'disabled' : ''} title="删除渠道" aria-label="删除"><span class="icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6M12 8v6"/></svg></span><span class="sr-only">删除</span></button>
      </div></article>`;
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
  $('m-description').textContent = isCodex ? '保存到渠道库后，通过渠道卡片应用到 Codex。'
    : '保存到渠道库后，通过渠道卡片写入客户端配置。Claude 模型列表第一项作为主模型。';
  $('m-base-hint').textContent = isCodex ? '（通常包含 /v1）' : '';
  $('m-name').value = editing?.name || ''; $('m-base').value = editing?.base_url || ''; $('m-key').value = '';
  // 清单是唯一真相:渠道一旦有清单(老式单 Key 渠道也会合成一条「账号1」),顶栏那个单行
  // API Key 就不参与保存了——否则服务端会把它当成"改当前生效那把",悄悄覆盖掉账号1
  keyDraft = (editing?.keys || []).map(k => ({ id: k.id, label: k.label, key: '', masked: k.key_masked }));
  $('m-keys-wrap').style.display = editing ? '' : 'none';
  renderKeyDraft();
  $('m-claude-fields').style.display = isCodex ? 'none' : ''; $('m-codex-fields').style.display = isCodex ? '' : 'none';
  $('m-model').required = isCodex;
  $('m-model').value = editing?.model || ''; $('m-wire').value = editing?.wire_api || 'responses';
  $('m-codex-mode').hidden = !isCodex;
  $('m-codex-mode-direct').checked = codexProviderMode(editing) === 'direct';
  $('m-codex-mode-router').checked = !$('m-codex-mode-direct').checked;
  syncCodexModeDraft();
  $('m-dropimg').checked = !!editing?.drop_images;
  // 下拉候选 = 本组渠道登记过的模型名(含正在编辑这条自己的),手写的新名字会临时并进来
  modelCandidates = [...new Set(providers(editingGroup).flatMap(p => [...(isCodex ? [p.model] : []), ...(p.models || [])]).filter(Boolean))].sort();
  modelDraft = (editing?.models || (isCodex && editing?.model ? [editing.model] : [])).map(m => ({ value: m, editing: false }));
  renderModelDraft();
  $('m-wire-claude').value = editing?.wire_api === 'responses' ? 'responses' : editing?.wire_api === 'chat' ? 'chat' : 'anthropic';
  $('m-note').value = editing?.note || ''; $('m-enabled').checked = editing ? !!editing.enabled : true;
  $('m-direct').checked = !!editing?.direct;
  // 出站代理默认留空:这台机器多数上游直连就是 200,只有被掐断的渠道才需要单独出境;
  // 留空 = 跟随全局 MIXR_UPSTREAM_PROXY,不把"某条渠道的选择"变成所有渠道的默认。
  $('m-proxy-url').value = editing?.proxy_url || '';
  resetModelDiscovery(); renderFetchKeySelect();
  showDialog('mask', 'm-name');
}
function syncCodexModeDraft() {
  const chat = $('m-wire').value === 'chat';
  $('m-codex-mode-direct').disabled = chat;
  if (chat) {
    $('m-codex-mode-direct').checked = false;
    $('m-codex-mode-router').checked = true;
  }
  $('m-codex-mode-hint').textContent = chat ? 'Chat Completions 渠道需经 Mixrouter 转换为 Codex 所用协议。'
    : '直连：Codex → 渠道；路由：Codex → Mixrouter → 渠道。';
  for (const id of ['m-codex-mode-direct', 'm-codex-mode-router']) {
    const input = $(id);
    input?.parentElement?.classList.toggle('is-selected', input.checked);
    input?.parentElement?.classList.toggle('is-disabled', input.disabled);
  }
}
$('m-wire')?.addEventListener('change', syncCodexModeDraft);
$('m-codex-mode-direct')?.addEventListener('change', syncCodexModeDraft);
$('m-codex-mode-router')?.addEventListener('change', syncCodexModeDraft);
function closeModal() { if (savingProvider) return toast('正在保存，请稍候'); hideDialog(); $('m-key').value = ''; keyDraft = []; modelDraft = []; resetModelDiscovery(); }

// 多 Key(同渠道多账号):弹窗里维护清单,卡片下拉里切当前生效那把
function renderKeyDraft() {
  // 有多 Key 清单时单行 API Key 不参与保存(见 saveProvider),整行藏起来,免得摆一个无效字段;
  // 清单删空后退回单 Key,这一行再出来。
  const multi = keyDraft.length > 0, keyInput = $('m-key');
  keyInput.hidden = multi;
  const keyLabel = keyInput.labels?.[0] || document.querySelector?.('label[for="m-key"]');
  if (keyLabel) keyLabel.hidden = multi;
  $('m-key-hint').textContent = !editing ? ''
    : multi ? '（多 Key 渠道请在下方清单里改，这里不参与保存）'
    : '（留空保持不变，当前 ' + (editing.key_masked || '未配置') + '）';
  $('m-keys').innerHTML = keyDraft.length ? keyDraft.map((k, i) => `<div class="rc-line">
    <label class="field" style="flex:1">名称<input type="text" value="${esc(k.label)}" oninput="keyDraft[${i}].label=this.value" placeholder="账号${i + 1}" autocomplete="off"></label>
    <label class="field" style="flex:2">API Key<input type="password" value="${esc(k.key)}" oninput="keyDraft[${i}].key=this.value;invalidateDiscovery('Key 已改动，请重新获取模型列表');renderFetchKeySelect()" placeholder="${k.id ? '留空=不改（' + esc(k.masked || '') + '）' : 'sk-…'}" autocomplete="new-password" spellcheck="false"></label>
    <button type="button" class="iconbtn danger" title="删除这个 Key" aria-label="删除这个 Key" onclick="removeKeyDraft(${i})">×</button></div>`).join('')
    : '<p class="muted">还没有多 Key。点「＋ 添加账号」加第二把；只留一把时用上面的 API Key 就行。</p>';
  renderFetchKeySelect();
}
function addKeyDraft() { keyDraft.push({ id: '', label: '', key: '', masked: '' }); renderKeyDraft(); }
function removeKeyDraft(i) { keyDraft.splice(i, 1); invalidateDiscovery('Key 清单已改动，请重新获取模型列表'); renderKeyDraft(); }
async function setActiveKey(id, keyId) {
  if (!online) return toast('控制台离线，未保存切换', 'err');
  try {
    const res = await api('/api/providers/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ active_key: keyId }) });
    toastWithBackupWarnings(curApp === 'codex' && codexConnectionMode() === 'direct'
      ? '渠道账号已保存；点击「应用直连」将新 Key 写入 Codex'
      : '已切换生效 Key；槽位按渠道走，立刻跟着用新 Key', res);
    await refresh();
  } catch (e) { toast('切换失败：' + e.message, 'err'); await refresh(); }
}
// 模型列表草稿:一行一个模型,和「多 Key」同一套行式编辑。每行是下拉(本组渠道登记过的模型名),
// 要写没登记的就选「自定义模型…」把这一行切成输入框——不用 datalist,它在字段已有值时只弹匹配的那一项
let modelDraft = [], modelCandidates = [];
const MODEL_CUSTOM = '__custom__';
// 上游模型发现:只改弹窗草稿,从不自己保存。请求结果带序号与输入指纹,输入一变(或弹窗关了、
// 又开了另一条渠道)旧响应就作废——否则慢请求回来时会把 A 渠道的模型填进 B 渠道的表单。
const DISCOVERY_DEFAULT_STATUS = '填好 Base URL 与 API Key 后可拉取上游模型列表；不需要先填名称或模型。';
// 这条请求**不走** api():它的默认超时 12 秒比后端整轮 15 秒还短,会在自己超时前把
// 一个正当的上游慢响应掐掉。后端 fetchProviderModels 的 deadline 覆盖分页的整轮 15 秒,
// 这里给 20 秒余量(网络 + 读响应体),其他接口的 12 秒行为不受影响。
const DISCOVERY_TIMEOUT_MS = 20000;
let discoveryState = { models: [], selected: [], query: '', seq: 0, controller: null, loading: false, fetchKeyId: '' };

function setDiscoveryStatus(text, kind = '') {
  const el = $('m-model-fetch-status'); if (!el) return;
  el.textContent = text;
  el.classList.remove('ok', 'err', 'busy');
  if (kind) el.classList.add(kind);
}
function updateFetchButton(loading) {
  const b = $('m-fetch-models'); if (!b) return;
  b.disabled = !!loading; b.textContent = loading ? '获取中…' : '获取模型列表';
}
function renderFetchKeySelect() {
  const wrap = $('m-fetch-key-wrap'), sel = $('m-fetch-key');
  if (!wrap || !sel) return;
  // 只有已保存渠道才需要挑「用哪把 Key 去问」;新渠道直接用上面的 API Key。
  // 已保存行可以选(值=key id);本次手填了 Key 的新增行也可以选(值=draft:i),绝不下发 *** 掩码。
  const choices = keyDraft.map((k, i) => ({ value: k.id || 'draft:' + i, label: k.label.trim() || k.masked || ('账号' + (i + 1)), saved: !!k.id, typed: !!String(k.key || '').trim() }))
    .filter(c => c.saved || c.typed);
  const show = !!editing && choices.length > 0;
  wrap.style.display = show ? '' : 'none';
  if (!show) { sel.innerHTML = ''; discoveryState.fetchKeyId = ''; return; }
  if (!choices.some(c => c.value === discoveryState.fetchKeyId)) discoveryState.fetchKeyId = '';
  const current = discoveryState.fetchKeyId;
  sel.innerHTML = '<option value="">当前生效 Key（默认）</option>' + choices.map(c => `<option value="${esc(c.value)}"${c.value === current ? ' selected' : ''}>${esc(c.label)}${c.saved ? '' : '（未保存）'}${c.typed && c.saved ? '（本次改动）' : ''}</option>`).join('');
  sel.value = current; // 与当前选择同步
}
// 返回要拿哪把 Key 去问上游:id 为已保存 Key 的 id,key 为本次手填的非空明文。
// 默认(选择框停在「当前生效 Key」)也要落到草稿里那一行——编辑时用户可能刚给生效账号
// 换了新 Key,此时必须用草稿值;只传 provider_id 会让后端读回旧的已保存 Key。
function selectedFetchKey() {
  const value = discoveryState.fetchKeyId;
  if (value.startsWith('draft:')) { const k = keyDraft[Number(value.slice(6))]; return k ? { id: '', key: String(k.key || '').trim() } : null; }
  if (value) { const k = keyDraft.find(x => x.id === value); return k ? { id: k.id, key: String(k.key || '').trim() } : null; }
  const active = keyDraft.find(k => k.id && k.id === editing?.active_key);
  return active ? { id: active.id, key: String(active.key || '').trim() } : null;
}
function discoverySignature() {
  return JSON.stringify({
    app: editingGroup, id: editing?.id || '', base: $('m-base').value.trim(), key: $('m-key').value,
    wire: editingGroup === 'codex' ? $('m-wire').value : $('m-wire-claude').value,
    direct: $('m-direct').checked, fetchKey: discoveryState.fetchKeyId,
    keys: keyDraft.map(k => [k.id, String(k.key || '').trim()]),
  });
}
function clearDiscoveryCandidates() {
  const had = discoveryState.models.length > 0 || discoveryState.selected.length > 0 || !!discoveryState.query;
  discoveryState.models = []; discoveryState.selected = []; discoveryState.query = '';
  const search = $('m-model-search'); if (search) search.value = '';
  if (had) renderModelDiscovery();
  return had;
}
// 请求入口(地址/Key/协议/直连/用哪把 Key)一变:在途请求作废,已经取到的候选也一起清掉。
// 只 abort 在途请求是不够的——旧地址的模型一旦留在列表里,下一次请求失败时用户还能把它们
// 「加入模型列表」,等于把另一条渠道的模型名混进当前渠道。modelDraft 不动,用户已填的行不受影响。
function invalidateDiscovery(reason = '输入已变化，请重新获取模型列表') {
  const wasLoading = discoveryState.loading;
  if (wasLoading) {
    discoveryState.seq++;
    if (discoveryState.controller) { try { discoveryState.controller.abort(); } catch {} }
    discoveryState.controller = null; discoveryState.loading = false;
    updateFetchButton(false);
  }
  const cleared = clearDiscoveryCandidates();
  if ((wasLoading || cleared) && reason) setDiscoveryStatus(reason, '');
}
function resetModelDiscovery() {
  invalidateDiscovery('');
  discoveryState.seq++;
  discoveryState.models = []; discoveryState.selected = []; discoveryState.query = '';
  discoveryState.controller = null; discoveryState.loading = false; discoveryState.fetchKeyId = '';
  const search = $('m-model-search'); if (search) search.value = '';
  if ($('m-discovery-hint')) $('m-discovery-hint').textContent = editingGroup === 'codex'
    ? '勾选的模型追加到下方候选列表，不更改默认模型；新渠道请另外填写默认模型，保存仍需手动点「保存渠道」。'
    : 'Claude 渠道会把勾选的模型追加到模型列表末尾，第一项（主模型）和已填的行都不动；保存仍需手动点「保存渠道」。';
  updateFetchButton(false);
  setDiscoveryStatus(DISCOVERY_DEFAULT_STATUS);
  renderModelDiscovery();
}
function setDiscoveryQuery(value) { discoveryState.query = String(value || ''); renderModelDiscovery(); }
function selectFetchKey(value) { discoveryState.fetchKeyId = String(value || ''); invalidateDiscovery('拉取用的 Key 已切换，请重新获取'); }
function discoveryVisibleModels() {
  const q = discoveryState.query.trim().toLowerCase();
  return discoveryState.models.map((m, i) => ({ m, i })).filter(row => !q || row.m.toLowerCase().includes(q));
}
function updateDiscoveryApplyButton() {
  const add = $('m-model-add-selected'); if (!add) return;
  const n = discoveryState.selected.length;
  add.disabled = !n || discoveryState.loading;
  add.textContent = '加入模型列表' + (n ? `（${n}）` : '');
}
// 勾选只同步已有复选框与按钮,整块重绘会把键盘焦点从刚按下的那一行甩掉。
function syncDiscoverySelectionDom() {
  const boxes = typeof document.querySelectorAll === 'function' ? [...document.querySelectorAll('#m-model-discovery input[data-model-index]')] : [];
  for (const box of boxes) {
    const index = Number(box.dataset?.modelIndex);
    box.checked = discoveryState.selected.includes(discoveryState.models[index]);
  }
  updateDiscoveryApplyButton();
}
function renderModelDiscovery() {
  const box = $('m-model-discovery'); if (!box) return;
  const total = discoveryState.models.length, rows = discoveryVisibleModels();
  box.classList.toggle('has-models', total > 0 && rows.length > 0);
  const selected = discoveryState.selected;
  updateDiscoveryApplyButton();
  if (!total) { box.innerHTML = '<p class="muted">还没有获取到模型。填好 Base URL 与 Key 后点「获取模型列表」。</p>'; return; }
  if (!rows.length) { box.innerHTML = `<p class="muted">没有匹配「${esc(discoveryState.query)}」的模型，共 ${total} 个候选。</p>`; return; }
  // 模型名来自上游,一律转义后再拼 HTML;勾选按模型名(不是渲染下标),搜索过滤后仍指向同一个候选。
  box.innerHTML = '<div class="md-list">' + rows.map(({ m, i }) => `<label class="md-item" for="m-model-opt-${i}"><input type="checkbox" id="m-model-opt-${i}" data-model-index="${i}"${selected.includes(m) ? ' checked' : ''} onchange="toggleDiscoveryModel(${i},this.checked)"><span class="mono">${esc(m)}</span></label>`).join('') + '</div>';
}
function toggleDiscoveryModel(index, checked) {
  const model = discoveryState.models[index];
  if (typeof model !== 'string') return;
  const chosen = new Set(discoveryState.selected);
  if (checked) chosen.add(model);
  else chosen.delete(model);
  discoveryState.selected = discoveryState.models.filter(m => chosen.has(m));
  syncDiscoverySelectionDom();
}
function applyDiscoverySelection() {
  const picked = discoveryState.models.filter(m => discoveryState.selected.includes(m));
  if (!picked.length) return setDiscoveryStatus('先勾选要使用的模型', 'err');
  // 追加而不是替换:Claude 第一项是主模型;Codex 默认模型是独立字段,两者都不被发现结果改写。
  const existing = new Set(modelDraft.map(r => String(r.value || '').trim()).filter(Boolean));
  let added = 0;
  for (const m of picked) if (!existing.has(m)) { modelDraft.push({ value: m, editing: false }); existing.add(m); added++; }
  if (added) renderModelDraft();
  setDiscoveryStatus(added ? `已追加 ${added} 个模型到模型列表（未保存）` : '所选模型都已在模型列表里，未重复添加', added ? 'ok' : '');
}
async function fetchProviderModels() {
  if (!online) return setDiscoveryStatus('控制台离线，无法请求上游模型列表', 'err');
  if (discoveryState.loading) return;
  const base = $('m-base').value.trim();
  if (!base) { $('m-base').focus(); return setDiscoveryStatus('请先填写 Base URL 再获取模型列表', 'err'); }
  const pick = editing ? selectedFetchKey() : null;
  let apiKey = '', keyId = '';
  if (pick && pick.key) { apiKey = pick.key; keyId = pick.id; }
  else if (pick && pick.id) keyId = pick.id;
  else if (!editing || !keyDraft.length) apiKey = $('m-key').value.trim();
  if (!editing && !apiKey) { $('m-key').focus(); return setDiscoveryStatus('新建渠道请先填 API Key；已保存的渠道可以留空,用当前生效 Key', 'err'); }
  // 保存过的渠道:不传 api_key 时服务端按 key_id 或当前生效 Key 取;只有手填的非空 Key 才覆盖。
  const body = { base_url: base, wire_api: editingGroup === 'codex' ? ($('m-wire').value || 'responses') : ($('m-wire-claude').value || 'anthropic'), direct: $('m-direct').checked };
  if (editing) body.provider_id = editing.id;
  if (apiKey) body.api_key = apiKey;
  if (keyId) body.key_id = keyId;
  const seq = ++discoveryState.seq, signature = discoverySignature();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { try { controller?.abort(); } catch {} }, DISCOVERY_TIMEOUT_MS);
  discoveryState.controller = controller; discoveryState.loading = true;
  updateFetchButton(true); renderModelDiscovery();
  setDiscoveryStatus('正在向上游获取模型列表…', 'busy');
  try {
    const r = await fetch('/api/providers/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller?.signal, cache: 'no-store' });
    let payload = null;
    try { payload = await r.json(); } catch {}
    // 入口变了(输入/关窗/换渠道)就整条丢弃:既不写状态也不动候选。
    if (seq !== discoveryState.seq || signature !== discoverySignature() || activeDialog?.id !== 'mask') return;
    if (!r.ok) return setDiscoveryStatus('获取失败：' + (payload?.error || `HTTP ${r.status ?? '?'}`), 'err');
    if (!Array.isArray(payload?.models)) return setDiscoveryStatus('获取失败：响应缺少 models 列表', 'err');
    const models = [...new Set(payload.models.filter(m => typeof m === 'string').map(m => m.trim()).filter(Boolean))];
    discoveryState.models = models; discoveryState.selected = []; discoveryState.query = '';
    if ($('m-model-search')) $('m-model-search').value = '';
    renderModelDiscovery();
    setDiscoveryStatus(models.length ? `已获取 ${models.length} 个模型，勾选后加入模型列表` : '上游返回了空的模型列表', models.length ? 'ok' : '');
  } catch (e) {
    if (seq !== discoveryState.seq || signature !== discoverySignature() || activeDialog?.id !== 'mask') return;
    setDiscoveryStatus(e?.name === 'AbortError' ? '请求超时，请稍后重试' : '获取失败：' + (e?.message || '网络错误'), 'err');
  } finally {
    clearTimeout(timer);
    if (seq === discoveryState.seq) { discoveryState.loading = false; discoveryState.controller = null; updateFetchButton(false); renderModelDiscovery(); }
  }
}
function modelSelectOptions(row) {
  const known = [...new Set([...modelCandidates, row.value].filter(Boolean))];
  const label = m => esc(m) + (modelCandidates.includes(m) ? '' : '（自定义）');
  return [`<option value="" ${row.value ? '' : 'selected'}>（选模型）</option>`]
    .concat(known.map(m => `<option value="${esc(m)}" ${m === row.value ? 'selected' : ''}>${label(m)}</option>`))
    .concat([`<option value="${MODEL_CUSTOM}">自定义模型…</option>`]).join('');
}
function renderModelDraft() {
  const isCodex = editingGroup === 'codex';
  $(isCodex ? 'm-models-list' : 'm-codex-models-list').innerHTML = '';
  $(isCodex ? 'm-codex-models-list' : 'm-models-list').innerHTML = modelDraft.length ? modelDraft.map((r, i) => `<div class="rc-line">
    <label class="field" style="flex:1">模型${i === 0 && !isCodex ? '（主）' : ''}${r.editing
      ? `<input type="text" aria-label="模型${i + 1}" value="${esc(r.value)}" placeholder="模型名，可带 [1M] 后缀" spellcheck="false" autocomplete="off" oninput="modelDraft[${i}].value=this.value" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}" onblur="endModelEdit(${i},this.value)">`
      : `<select aria-label="模型${i + 1}" onchange="pickModelDraft(${i},this.value)">${modelSelectOptions(r)}</select>`}</label>
    <button type="button" class="iconbtn danger" title="删除这个模型" aria-label="删除这个模型" onclick="removeModelDraft(${i})">×</button></div>`).join('')
    + `<datalist id="model-candidates">${[...new Set(modelCandidates)].map(m => `<option value="${esc(m)}"></option>`).join('')}</datalist>`
    : `<p class="muted">${isCodex ? '候选列表可留空；槽位仍可使用默认模型或手写模型名。' : '还没有模型。点「＋ 添加模型」加一个；第一项会当主模型用。'}</p>`;
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
  // 出站代理留空 = 跟随全局(服务端编辑时按空串清除),所以这里原样传 trim 后的值,不省略字段。
  const proxyUrl = $('m-proxy-url').value.trim();
  const body = { app: editingGroup, name: $('m-name').value.trim(), base_url: $('m-base').value.trim(), api_key: keyDraft.length ? '' : $('m-key').value, note: $('m-note').value, enabled: $('m-enabled').checked, direct: $('m-direct').checked, proxy_url: proxyUrl };
  body.models = [...new Set(modelDraft.map(r => String(r.value || '').trim()).filter(Boolean))];
  if (editingGroup === 'codex') {
    body.model = $('m-model').value.trim(); body.wire_api = $('m-wire').value; body.drop_images = $('m-dropimg').checked;
    body.codex_mode = $('m-codex-mode-router').checked ? 'router' : 'direct';
  }
  else body.wire_api = $('m-wire-claude').value;
  if (!body.name || !body.base_url) return toast('名称与 Base URL 必填', 'err');
  // 前端先拦一次互斥:服务端会 400,但让用户等一个来回再看到报错没有意义。
  if (body.direct && proxyUrl) { $('m-proxy-url').focus(); return toast('填写出站代理时，请取消「绕过出站代理」', 'err'); }
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
  return true;
}
async function switchProvider(id) {
  const app = curApp, p = providers().find(x => x.id === id);
  if (!p || !canConnect(app)) return;
  const mode = app === 'codex' ? codexProviderMode(p) : 'direct';
  const label = mode === 'router' ? '路由' : '直连';
  const leavingRouter = app === 'claude' && !!state.live?.claude?.router;
  const message = `将 ${APPS[app].label} 配置写入为「${p.name}」${label}。${mode === 'router' ? '\n主模型使用该渠道，审查槽位保持原有选择。' : ''}${leavingRouter ? '\n这会退出路由模式：Claude Code 不再经本机路由，mixr- 槽位别名一并清掉。' : ''}\n文件：${APPS[app].cfg}（原文件自动备份）。\n${app === 'claude' ? 'Claude Code 需重启会话生效。' : '重新打开 Codex 读取新连接配置。'}`;
  if (!await askConfirm(`写入${label}配置`, message, '写入配置') || !canConnect(app)) return;
  try {
    const res = await api('/api/switch/' + encodeURIComponent(id), { method: 'POST', ...(app === 'codex' ? { body: JSON.stringify({ mode }) } : {}) });
    toastWithBackupWarnings(`已写入 ${APPS[app].label} 配置 → ${p.name}，请重启${app === 'claude' ? '会话' : '客户端'}生效`, res); await refresh();
  } catch (e) { toast('接入失败：' + e.message, 'err'); }
}
async function switchRouterMode() {
  const app = curApp;
  if (!canConnect(app)) return;
  const base = routerBase(app) || '后端提供的路由地址';
  const message = `将 ${APPS[app].label} 指向 ${base}，请求按槽位与已登记模型分发，按会话保持渠道粘性。\n写入 ${APPS[app].cfg}（原文件自动备份）。${app === 'claude' ? 'Claude Code 需重启会话生效。' : 'Codex 需重启生效。'}\n可随时通过渠道卡片切回直连。`;
  if (!await askConfirm('写入路由配置', message, '接入路由') || !canConnect(app)) return;
  try {
    const res = await api('/api/router/' + app, { method: 'POST' });
    toastWithBackupWarnings(`已写入 ${APPS[app].label} 路由配置，请重启${app === 'claude' ? '会话' : '客户端'}生效`, res); await refresh();
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
// 模型级测活:服务端对渠道登记的每个模型各发一次最小真实请求,所以比「测试」贵得多。
// 同一个渠道并发点两次没有意义:第一次还没回来时直接忽略,免得把额度烧两遍。
async function probeModels(id) {
  if (!online || modelProbe[id]?.wait) return;
  modelProbe[id] = { wait: true }; if (view === 'providers') renderProviders();
  try { modelProbe[id] = await api('/api/providers/' + encodeURIComponent(id) + '/models/test', { method: 'POST' }); }
  catch (e) { modelProbe[id] = { error: e.message }; }
  if (view === 'providers') renderProviders();
}

