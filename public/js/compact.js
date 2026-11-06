'use strict';
// ---------------- 压缩模型 ----------------
// 5 秒轮询会反复重绘这几块只读状态:内容没变就不写 DOM,免得冲掉用户正在选中的文字,
// 也免得 role=status 的区域被读屏软件每 5 秒重读一遍。
const compactPainted = new WeakMap();
function compactPaint(el, html) {
  if (!el || compactPainted.get(el) === html) return;
  compactPainted.set(el, html); el.innerHTML = html;
}
function loadCompactDraft() {
  if (!state?.compact) return;
  compactDraft = { provider: '', model: '', key_id: '', ...state.compact.selection };
  compactBase = state.compact.revision; compactDirty = false; compactCustom = false;
  renderCompactEditor(); updateCompactStatus();
}
// 还没保存过任何东西时,两块状态也要先摆出来(全是"尚未保存过"),否则用户看不出这里在分账。
renderSplitStatus();
// 每条压缩规则一行:规则名(用户可改)+ 状态胶囊,下一行是按顺序的目标链。
// 规则 kind 才是身份,名字只是标签;失效与停用画成警告胶囊,不混在句子里。
function renderCompactCurrent() {
  const c = state?.compact;
  if (!c) return compactPaint($('compact-current'), '当前服务端不支持压缩选择');
  const kind = { global: '通用压缩', talentsai: 'TalentsAI 压缩' };
  const flag = (text, tone = 'warn') => `<span class="badge ${tone}">${text}</span>`;
  const target = t => `${esc(t.name)} / ${esc(t.model || '透传请求模型')} / ${t.key_id ? '固定 Key ' + esc(t.key_label || t.key_id) + '（' + esc(t.key_id) + '）' : '跟随渠道当前 Key'}`
    + (t.key_available === false ? flag('Key 不可用') : '') + (t.enabled ? '' : flag('渠道停用'));
  const rows = (c.rules || []).map(r => `<div class="cc-rule"><div class="cc-rule-head"><b>${esc(kind[r.kind] || r.id)}</b>`
    + (kind[r.kind] ? `<span class="mono">${esc(r.id)}</span>` : '') + (r.enabled ? '' : flag('规则停用'))
    + (r.has_pool ? flag('渠道池', 'off') : '') + '</div>'
    + `<div class="cc-rule-chain">${r.targets.map(target).join('<span class="cc-arrow"> → </span>') || '无可用目标'}</div></div>`).join('');
  compactPaint($('compact-current'), (c.mode === 'mixed' ? '<b>当前为混合落点或未完整配置，不代表单一模型。</b>' : '')
    + (rows || '尚无压缩规则；保存时创建两条规则。'));
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
  const hint = $('compact-key-hint');
  if (!compactKeySupported()) {
    $('compact-key').innerHTML = `<option value="${esc(compactDraft.key_id)}">${compactDraft.key_id ? '未保存的固定 Key（' + esc(compactDraft.key_id) + '）' : '当前服务端不支持指定 Key'}</option>`;
    $('compact-key').value = compactDraft.key_id; $('compact-key').disabled = true;
    hint.textContent = '当前服务端尚不支持指定Key，更新服务后可用。' + (compactDraft.key_id ? '原固定 Key 草稿保留，不能提交给旧服务；可重新载入放弃草稿。' : '渠道和模型仍可保存，本次不会提交 Key 选择。');
    hint.title = hint.textContent;
    hint.classList.add('is-warning');
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
  const unavailable = !!missing || selected?.enabled === false;
  hint.textContent = unavailable
    ? '原固定 Key 已不可用，选择仍保留；请明确改选可用 Key 或跟随渠道当前 Key，不会自动替换。'
    : compactDraft.key_id ? `固定 Key：${selected.label || selected.id}`
      : `跟随渠道当前 Key${active ? '：' + (active.label || active.id) : ''}`;
  hint.title = unavailable ? hint.textContent
    : compactDraft.key_id ? '固定 Key 只影响两条压缩规则，不切换渠道当前账号。'
      : `跟随渠道当前 Key${active ? '：' + (active.label || active.id) + '（' + active.id + '）' : ''}；渠道切换当前账号后压缩也会跟随。`;
  hint.classList.toggle('is-warning', unavailable);
}
// 「压缩选择与上次载入一致」:有草稿、服务端版本没变、草稿没动过。app.js 用它禁用 #save-compact,
// 和 #save-window 一样没有改动就不能点;状态行也按它写那句「一致」。
function compactUnchanged() {
  return !!compactDraft && state?.compact?.revision === compactBase && !compactDirty;
}
function updateCompactStatus() {
  if (!compactDraft) return;
  const text = savingCompact ? '正在保存压缩模型…'
    : state?.compact?.revision !== compactBase ? '服务端压缩规则已变化；草稿保留，请重新载入后保存。'
      : compactUnchanged() ? '压缩选择与上次载入一致。' : '有未保存的压缩选择；自动刷新不会覆盖。';
  if ($('compact-msg').textContent !== text) $('compact-msg').textContent = text;
  renderSplitStatus();
}
// 四段分开读:保存成功 / 已写盘 / 服务已加载 / 客户端需重开。没有状态时(还没保存过)
// 只写一句"尚未保存",不假装任何一段已经成立。
// 「客户端需重开」的 false 是好事(不用重开),不能按 ✗ 红字读;这类反向项统一用中性色,
// 由句子本身说"需要/不需要"。
function splitStatusLine(label, ok, text, neg = false) {
  const cls = neg ? 'na' : ok === true ? 'ok' : ok === false ? 'no' : 'na';
  const mark = neg ? '·' : ok === true ? '✓' : ok === false ? '✗' : '·';
  return `<span class="ss-item ${cls}"><b aria-hidden="true">${mark}</b> ${esc(label)}：${esc(text)}</span>`;
}
// 还没保存过时只占一行，四项放进 details；保存后显式展示各段结果。
function splitStatusBox(box, o) {
  box.classList.toggle('has-outcome', !!o);
  box.classList.toggle('is-pending', !o);
}
function renderSplitStatus() {
  const box = $('compact-status');
  if (!box) return;
  const o = compactOutcome;
  splitStatusBox(box, o);
  compactPaint(box, '<span class="ss-title">保存结果</span>'
    + (o ? '<div class="ss-row">' : '<details class="cfg-more ss-details"><summary>尚无保存结果</summary><div class="ss-row">')
    + splitStatusLine('请求', o ? o.saved : null, o ? (o.saved ? '已成功返回' : o.error || '未成功') : '尚未保存过')
    + splitStatusLine('已写盘', o ? o.written : null, o ? (o.written ? '配置已写入服务端磁盘' : '未确认写盘') : '尚未保存过')
    + splitStatusLine('服务已加载', o ? o.loaded : null, o ? (o.loaded ? '运行中的服务按新压缩规则分发' : '未确认服务已加载') : '尚未保存过')
    + splitStatusLine('客户端需重开', o ? o.restart : null, o ? '不需要（压缩落点在服务端，下次请求即用新规则）' : '尚未保存过', true)
    + (o ? '</div>' : '</div></details>'));
  renderWindowStatus();
}
// 窗口保存的四段与压缩模型不同:窗口是**磁盘配置**,服务端从不热读它——"已写盘"成立,
// "服务已加载"必然不成立(所以是 null 而不是 false),而"客户端需重开"是**成立**的。
// 这三段的真假正是用户最容易混淆的地方,所以按各自实际情况写,不套用一句话。
function renderWindowStatus() {
  const box = $('window-status');
  if (!box) return;
  const o = windowOutcome;
  splitStatusBox(box, o);
  compactPaint(box, '<span class="ss-title">保存结果</span>'
    + (o ? '<div class="ss-row">' : '<details class="cfg-more ss-details"><summary>尚无保存结果</summary><div class="ss-row">')
    + splitStatusLine('请求', o ? o.saved : null, o ? (o.saved ? '已成功返回' : o.error || '未成功') : '尚未保存过')
    + splitStatusLine('已写盘', o ? o.written : null, o ? (o.written ? '已写入所选配置层文件' : '未确认写盘') : '尚未保存过')
    + splitStatusLine('服务已加载', null, '不适用（服务端不读这份磁盘配置，运行中的会话不会热改）')
    + splitStatusLine('客户端需重开', o ? o.restart : null, o ? '需要（新开会话，或在该项目目录 claude --continue 后生效）' : '尚未保存过', true)
    + (o ? '</div>' : '</div></details>'));
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
  if (!online || !compactDraft || savingCompact) return;
  const provider = compactDraft.provider, model = compactDraft.model.trim(), key_id = compactDraft.key_id, keySupported = compactKeySupported();
  if (!provider || !model) return toast('请选择压缩渠道和非空模型名', 'err');
  if (key_id && !keySupported) return toast('当前服务端尚不支持指定Key，更新服务后可用；固定 Key 草稿未提交', 'err');
  const key = state.compact.providers.find(p => p.id === provider)?.keys?.find(k => k.id === key_id);
  if (key_id && (!key || key.enabled === false)) return toast('固定 Key 已不可用；请明确改选可用 Key 或跟随渠道当前 Key', 'err');
  if (compactBase !== state.compact.revision) return toast('服务端压缩规则已变化，请重新载入压缩选择', 'err');
  const revision = compactRevision, expected_revision = compactBase;
  const keyText = !keySupported ? '服务端不支持指定 Key，本次只保存渠道与模型' : key_id ? `固定 Key ${key.label || key.id}（${key.id}）` : '跟随渠道当前 Key';
  if (!await askConfirm('保存压缩模型', `只将两条压缩规则同步改为 ${provider} / ${model} / ${keyText}，并替换现有压缩备池为单一渠道。普通模型、子代理槽位和渠道当前 Key（active_key）均不变。`, '保存压缩模型')) return;
  if (savingCompact) return toast('压缩选择正在保存，请稍候', 'err');
  if (keySupported && !compactKeySupported()) return toast('服务端 Key 支持状态已变化，请重新确认；选择未提交', 'err');
  savingCompact = true; setConnection(online); updateCompactStatus();
  // 服务端是否成功回包与"要不要继续抛"是两件事:Key 未确认那条分支是在**回包之后**抛的,
  // 那时请求其实已经成功、配置多半也已落盘。分开记,免得失败提示把"可能已写入"说成"没写"。
  let responseOk = false;
  try {
    const result = await api('/api/compact', { method: 'POST', body: JSON.stringify({ provider, model, ...(keySupported ? { key_id } : {}), expected_revision }) });
    responseOk = true;   // 请求本身成功了;后面若因响应不完整而抛,也不该说成"没发生过"
    if (!result.compact) throw new Error('服务端未返回压缩配置');
    if (keySupported && (!compactKeySupported(result.compact) || result.compact.selection?.key_id !== key_id)) {
      state.compact = result.compact;
      compactDirty = true; renderCompactCurrent(); renderCompactKeys(); updateCompactStatus();
      // 请求成功了,但服务端没确认 Key 选择 —— 写盘与加载都无从确认,只能如实标"未确认"。
      compactOutcome = { saved: true, written: null, loaded: null, restart: false, error: '服务端未确认 Key 选择' };
      renderSplitStatus();
      throw new Error('服务端未确认 Key 选择；渠道和模型可能已写入，固定 Key 草稿保留，请更新服务并重新读取核对');
    }
    state.compact = result.compact;
    compactBase = result.compact.revision;
    if (compactRevision === revision) loadCompactDraft();
    renderCompactCurrent(); updateCompactStatus();
    // 四段都成立:POST 成功返回(服务端先写盘再回包,所以"已写盘"是服务端的保证)、
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
  finally { savingCompact = false; setConnection(online); updateCompactStatus(); }
}

// ---------------- 压缩上下文窗口 ----------------
const windowLabel = { global: '用户全局', project: '项目', local: '项目本地', auto: '下层继承' };
// 窗口值按 K/M 显示(1.00M、256K),title 里是写进配置文件的原值;auto 说成"未设置"。
const windowTok = value => value === 'auto' ? '未设置（auto）' : typeof value === 'number' ? fmtTok(value) : String(value ?? '—');
const windowRaw = value => `autoCompactWindow = ${value}`;
// 覆盖提示分两档:真正的覆盖(项目/环境)才是警告色;"项目未检查"只是说明,
// 常驻的红条会把整页语气拉成故障,实际什么都没坏。
function coverageTone(box, { note, warn }) {
  box.classList.toggle('offline', !!warn);
  box.classList.toggle('cfg-note', !warn && !!note);
}
function invalidateWindowSelection(message) {
  windowSelectionRevision++; $('window-msg').textContent = message;
  $('window-coverage-text').textContent = '配置层或项目目录已变化，当前选择的覆盖情况尚未检查；请读取所选配置层。';
  coverageTone($('window-coverage'), { note: true, warn: false });
  $('window-edit-override').hidden = true; setConnection(online);
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
  if (coverage.overridden_by) notes.push(`${saved ? '仍被' : '所选层被'}${windowLabel[coverage.overridden_by]}层覆盖：${windowTok(w.configured.value)}；保存本层不会改变该项目的有效磁盘值。`);
  else if (coverage.project_checked) notes.push('已检查指定项目：所选层未被更高磁盘层覆盖；这不是运行中会话的实测值。');
  if (coverage.environment_override) notes.push('存在环境覆盖：本控件不能清除，改值或设 auto 均不会删除它，不能据此确认会话窗口。');
  return notes.join(' ');
}
// 读取/保存进行中,「读取所选配置层」与「编辑覆盖层」也禁用(保存按钮由 setConnection 管)。
function windowBusy() {
  const busy = !!windowLoadTask || savingWindow;
  $('reload-window').disabled = busy; $('window-edit-override').disabled = busy;
}
// 首屏一行:所选层的值和文件,再给磁盘上真正起作用的那一层。原值在 title。
function renderCompactWindow(w, preserveValue = false) {
  if (!preserveValue) $('window-value').value = String(w.value);
  const top = w.configured.source === 'auto' ? '磁盘上各层都未设置，用 Claude Code 默认值'
    : `磁盘上生效的是${windowLabel[w.configured.source] || w.configured.source}层的 ${windowTok(w.configured.value)}`;
  $('window-current').textContent = `所选${windowLabel[w.scope]}层：${windowTok(w.value)} · 磁盘生效：${w.configured.source === 'auto' ? 'Claude Code 默认值' : `${windowLabel[w.configured.source] || w.configured.source}层 ${windowTok(w.configured.value)}`}`;
  $('window-current').title = `所选文件 ${w.target}；${top}（不是运行中会话的实测值）。所选层 ${windowRaw(w.value)}；生效层 ${windowRaw(w.configured.value)}`;
  const coverage = windowCoverage(w);
  const coverageText = windowCoverageText(w);
  $('window-coverage-text').textContent = coverage.overridden_by || coverage.environment_override ? coverageText
    : coverage.project_checked ? '已检查项目：没有更高磁盘层覆盖。' : '未指定项目：项目与本地层覆盖尚未检查。';
  $('window-coverage-text').title = coverageText;
  coverageTone($('window-coverage'), { note: !coverage.project_checked, warn: !!coverage.overridden_by || coverage.environment_override });
  $('window-edit-override').hidden = !coverage.overridden_by;
  $('window-layers').innerHTML = w.layers.map(layer => `<div class="wl-row"><span class="wl-scope">${esc(windowLabel[layer.scope] || layer.scope)}</span>`
    + `<span class="wl-value" title="${esc(windowRaw(layer.value))}">${esc(windowTok(layer.value))}</span><span class="mono">${esc(layer.file)}</span>`
    + `${layer.exists ? '' : '<span class="badge off">文件不存在</span>'}${layer.env_override ? '<span class="badge warn">存在环境覆盖</span>' : ''}</div>`).join('');
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
  windowLoadTask = api(windowQuery(selected)); setConnection(online); windowBusy();
  $('window-msg').textContent = '正在读取所选配置层…';
  try {
    const { window: w } = await windowLoadTask;
    if (!w || typeof w.revision !== 'string') throw new Error('服务端未返回窗口版本');
    // 读取期间换了层或目录:invalidateWindowSelection 已经改写了提示,这条旧回包直接丢掉。
    if (windowSelectionRevision !== selectionRevision || !windowSelectionMatches(selected)) return;
    if (w.project !== selected.project) $('window-project').value = w.project;
    windowSnapshot = w;
    if (windowRevision === loadRevision) { windowDirty = false; renderCompactWindow(w); $('window-msg').textContent = '已从磁盘读取；尚未更改配置。'; }
    else { renderCompactWindow(w, true); $('window-msg').textContent = '读取期间改动的窗口草稿仍保留；保存将使用读取时的版本号。'; }
  } catch (e) { $('window-msg').textContent = `读取失败：${e.message}。${windowSnapshot ? '下面仍是上一次读取的结果；' : ''}可再点「读取所选配置层」。`; }
  finally { windowLoadTask = null; setConnection(online); windowBusy(); }
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
    $('window-msg').textContent = '请输入 auto，或 100K–1M 之间的整数 token 值'; return;
  }
  const value = raw === 'auto' ? 'auto' : numeric;
  const revision = windowRevision, selectionRevision = windowSelectionRevision, expected_revision = windowSnapshot.revision;
  const meaning = raw === 'auto' ? '只删除这一层的 autoCompactWindow 并继承下层，不删除其他层或环境设置' : `只将这一层设为 ${windowTok(value)}（${value.toLocaleString('en-US')} token）`;
  if (!await askConfirm('保存压缩窗口', `${meaning}，目标文件：${windowSnapshot.target}。全局只改全局，不同步项目。${windowCoverageText(windowSnapshot)} 外部保存不会热改运行中会话；项目设置需新开会话，或退出后在该项目目录用 claude --continue 继续并核对。`, '保存窗口')) return;
  if (savingWindow || windowLoadTask || windowSelectionRevision !== selectionRevision || !windowSelectionMatches(selected)) return;
  if (windowRevision !== revision) { $('window-msg').textContent = '确认期间窗口值已变化；请重新确认当前值。'; return; }
  savingWindow = true; setConnection(online); windowBusy();
  $('window-msg').textContent = '正在保存压缩窗口…';
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
  finally { savingWindow = false; setConnection(online); windowBusy(); }
}

// ---------------- 保存草稿的离开提醒 ----------------
// 压缩选择 / 压缩窗口 / Codex 阈值 / 会话覆盖 任一处有未保存草稿时,关页面前提醒一句。
window.addEventListener('beforeunload', e => { if (compactDirty || windowDirty || codexCompactDraft?.dirty || routingDirty || (activeDialog?.id === 'mask')) { e.preventDefault(); e.returnValue = ''; } });

