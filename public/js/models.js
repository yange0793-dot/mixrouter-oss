'use strict';
// ---------------- 子代理槽位 ----------------
// 槽位 = 别名(mixr-…)→「渠道 @ 模型」。Claude 五个固定槽写进客户端 env;
// Codex 槽名自拟,客户端用 codex -m mixr-<槽名> 选用。别名请求优先于普通请求的落点选择。
const SLOT_LABELS = { main: '主模型 main', opus: 'Opus 槽', sonnet: 'Sonnet 槽', haiku: 'Haiku 槽', subagent: 'Subagent 槽' };
const SLOT_MODEL_CUSTOM = '__custom__';
const slotModelEdit = { claude: null, codex: null }; // {name, value, original, provider} 手写模型草稿
const slotSaving = new Set();
const codexSlotDraft = { name: '', provider: '' };
const codexSlotStatus = { name: '', error: '' };
// 直连模型保存:结果提示只属于产生它的配置版本,revision 一变就不再显示,不留旧的成功提示;
// pending 是保存中的选择,请求返回前下拉框显示它,不闪回旧值。
const codexDirectSave = { revision: '', pending: null };
const slotConfiguredModel = s => Object.hasOwn(s, 'configured_model') ? s.configured_model || '' : s.model || '';
const slotBusy = (app, name) => slotSaving.has(app + ':' + name);
function onSlotModelPick(app, name, value) {
  const s = (slotsOf()[app] || []).find(x => x.name === name);
  if (!online || !s?.provider || slotBusy(app, name)) return;
  if (value === SLOT_MODEL_CUSTOM) {
    const original = slotConfiguredModel(s);
    slotModelEdit[app] = { name, value: original, original, provider: s.provider };
    renderSlots(true);
    $('slot-model-' + app + '-' + name)?.focus();
    return;
  }
  slotModelEdit[app] = null;
  return setSlot(app, name, 'model', value);
}
function updateSlotModelDraft(app, name, value) {
  if (slotModelEdit[app]?.name === name) slotModelEdit[app].value = value;
}
async function commitSlotModel(app, name, value) {
  const edit = slotModelEdit[app];
  const s = (slotsOf()[app] || []).find(x => x.name === name);
  if (!edit || edit.name !== name || slotBusy(app, name)) return false;
  if (s?.provider !== edit.provider) {
    toast('槽位渠道已变化，手写模型未保存；请重新选择渠道', 'err');
    return false;
  }
  slotModelEdit[app] = null;
  const ok = await setSlot(app, name, 'model', (value || '').trim());
  renderSlots(true);
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
  if (value !== e.original) return commitSlotModel(app, name, value);
  slotModelEdit[app] = null;
}
const slotsOf = () => state?.slots || { claude: [], codex: [] };
function slotChannelOptions(sel, group) {
  const missing = sel && !providers(group).some(p => p.id === sel);
  return `<option value="" ${sel ? '' : 'selected'}>(未配置)</option>`
    + (missing ? `<option value="${esc(sel)}" selected disabled>原渠道已删除（${esc(sel)}）</option>` : '')
    + providers(group).map(p => {
      // 渠道当前生效的 Key(账号)一并显示:渠道库里切换后,槽位这一行跟着变
      const act = (p.keys || []).find(k => k.id === p.active_key) || (p.keys || [])[0];
      return `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''} ${group === 'codex' && !p.enabled ? 'disabled' : ''}>${esc(p.name)}${act ? ' · ' + esc(act.label) : ''}${p.enabled ? '' : '（停用）'}</option>`;
    }).join('');
}
function slotBadge(s, liveRouter) {
  if (!s.provider) return '<span class="badge off">未配置</span>';
  if (!providers(curApp).some(p => p.id === s.provider)) return '<span class="badge off">渠道已删除</span>';
  if (!s.enabled) return '<span class="badge off">渠道停用</span>';
  if (curApp === 'claude') {
    if (!liveRouter) return '<span class="badge info">已配置 · 未切路由</span>';
    const env = state.live?.claude?.slots?.[s.name] || '';
    return env === s.alias ? '<span class="badge on">已写入</span>' : '<span class="badge drift">未同步</span>';
  }
  const live = state.live?.codex || {};
  if (!online) return '<span class="badge off">离线 · 待确认</span>';
  if (live.error) return '<span class="badge off">配置读取失败</span>';
  if (!providers('codex').some(p => p.id === s.provider && p.enabled)) return '<span class="badge off">渠道停用</span>';
  if (!s.model) return '<span class="badge off">模型未配置</span>';
  if (!live.router) return `<span class="badge info">${live.base_url ? '直连 · 不使用槽位' : '尚未接入路由'}</span>`;
  if (live.hot_routing?.enabled === false) return '<span class="badge off">路由配置未受管</span>';
  const configuredAlias = s.name === 'main' ? live.model : s.name === 'reviewer' ? live.review_model : '';
  if (['main', 'reviewer'].includes(s.name) && configuredAlias !== s.alias)
    return '<span class="badge info">默认未使用此槽</span>';
  return '<span class="badge on">即时生效</span>';
}
function slotModelCell(s, app) {
  const ch = providers(app).find(p => p.id === s.provider);
  const known = [...new Set([...(app === 'codex' ? [ch?.model] : []), ...(ch?.models || [])].filter(Boolean))];
  const cur = slotConfiguredModel(s), edit = slotModelEdit[app];
  const locked = !online || slotBusy(app, s.name);
  const id = `slot-model-${app}-${s.name}`;
  // 下拉始终列全候选;未登记模型走手写输入,不让 datalist 按旧值过滤掉其他候选。
  const options = [
    `<option value="" ${cur ? '' : 'selected'}>${app === 'codex' ? '（渠道默认模型：' + esc((cur ? ch?.model : s.model) || ch?.model || '未配置') + '）' : '（渠道第一个模型）'}</option>`,
    ...known.map(m => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`),
    ...(cur && !known.includes(cur) ? [`<option value="${esc(cur)}" selected>${esc(cur)}（自定义）</option>`] : []),
    `<option value="${SLOT_MODEL_CUSTOM}">自定义模型…</option>`,
  ].join('');
  if (!s.provider) return `<select aria-label="${esc(s.name)} 槽模型" disabled><option>（先选渠道）</option></select>`;
  if (edit?.name === s.name) {
    const list = app === 'claude' ? 'slot-models-' + s.name : 'slot-models-codex-' + s.name;
    const suggestions = [...new Set([...(cur ? [cur] : []), ...known])].map(m => `<option value="${esc(m)}"></option>`).join('');
    return `<input type="text" aria-label="${esc(s.name)} 槽模型" list="${esc(list)}" value="${esc(edit.value)}" id="${esc(id)}" placeholder="模型名${app === 'claude' ? '，可带 [1M] 后缀' : ''}" spellcheck="false" autocomplete="off" oninput="updateSlotModelDraft('${app}','${s.name}',this.value)" onkeydown="slotModelKey(event,'${app}','${s.name}')" onblur="endSlotModelEdit('${app}','${s.name}',this.value)" ${locked ? 'disabled' : ''}><datalist id="${esc(list)}">${suggestions}</datalist>`;
  }
  return `<select aria-label="${esc(s.name)} 槽模型" onchange="onSlotModelPick('${app}','${s.name}',this.value)" id="${esc(id)}" ${locked ? 'disabled' : ''}>${options}</select>`;
}
function claudeSlotRow(s) {
  const locked = !online || slotBusy('claude', s.name);
  return slotLine(s,
    `<select aria-label="${esc(s.name)} 槽渠道" onchange="setSlot('claude','${s.name}','provider',this.value)" ${locked ? 'disabled' : ''}>${slotChannelOptions(s.provider, 'claude')}</select>`,
    slotModelCell(s, 'claude'), slotBadge(s, !!state.live?.claude?.router),
    s.provider ? `<button class="iconbtn danger" title="清空 ${esc(s.name)} 槽" aria-label="清空 ${esc(s.name)} 槽" onclick="clearSlot('claude','${s.name}')" ${locked ? 'disabled' : ''}>×</button>` : '');
}
// 全局与会话槽位共用原有行布局;差异只在控件的读写范围。
function slotLine(s, providerCell, modelCell, badge, clear, attributes = '') {
  return `<div class="rc-line"${attributes}>
    <label class="field slot-ident">${SLOT_LABELS[s.name] || esc(s.name)}<span class="mono">${esc(s.alias)} · ${esc(s.env || '')}</span></label>
    <label class="field" style="flex:2">渠道${providerCell}</label>
    <label class="field" style="flex:2">落点模型${modelCell}</label>
    <span class="slot-state">${badge}</span>
    ${clear}
  </div>`;
}
function codexSlotRow(s) {
  const locked = !online || slotBusy('codex', s.name);
  const label = s.name === 'main' ? 'main · 主模型' : s.name === 'reviewer' ? 'reviewer · 审查模型' : s.name;
  return `<div class="rc-line codex-slot-line" id="codex-slot-${esc(s.name)}">
    <div class="field slot-ident">${esc(label)}<span class="mono">${esc(s.alias)}</span></div>
    <label class="field">渠道<select id="codex-model-${esc(s.name)}" aria-label="${esc(s.name)} 渠道" onchange="setSlot('codex','${s.name}','provider',this.value)" ${locked ? 'disabled' : ''}>${slotChannelOptions(s.provider, 'codex')}</select></label>
    <label class="field">落点模型${slotModelCell(s, 'codex')}</label>
    <span class="slot-state">${slotBadge(s, false)}</span>
    ${s.provider ? `<button class="iconbtn danger" title="删除 ${esc(s.name)} 槽" aria-label="删除 ${esc(s.name)} 槽" onclick="clearSlot('codex','${s.name}')" ${locked ? 'disabled' : ''}>×</button>` : ''}
  </div>`;
}
function renderCodexConfig() {
  const live = state?.live?.codex || {};
  const context = live.compaction ? live.compaction.context_window : live.model_context_window || live.main?.context_window;
  const explicit = live.compaction ? live.compaction.context_source === 'explicit' : !!live.model_context_window;
  const facts = [
    ['上下文窗口', context ? `${Number(context).toLocaleString()} tokens${explicit ? '（显式配置）' : '（本地模型目录）'}` : '未声明，由 Codex 决定'],
  ];
  const warnings = (live.warnings || []).map(warning => `<li>${esc(warning)}</li>`).join('');
  $('codex-config-details').innerHTML = `<details class="prov-help"><summary>上下文窗口与生效范围</summary><dl class="config-facts">${facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>${warnings ? `<ul class="config-warnings">${warnings}</ul>` : ''}<p class="hint">路由请求即时使用当前落点；已打开的 Codex 客户端会缓存模型标签，新客户端读取同步列表。命令行、profile 或项目配置可能覆盖全局默认。</p></details>`;
}
// 阈值草稿绑定到用户开始编辑时读到的磁盘版本。轮询只更新事实,不能替草稿领取新 revision。
function codexCompactGate() {
  const live = state?.live?.codex;
  if (!online) return '控制台离线，阈值草稿保留；连接后重试。';
  if (!live || live.error) return 'Codex 配置读取失败，阈值不可保存。';
  if (live.profile) return `当前启用了 profile（${live.profile}），请先处理 profile 覆盖；全局阈值编辑已禁用。`;
  if (codexCompactReadError) return codexCompactReadError;
  if (!live.compaction || !Object.hasOwn(live.compaction, 'configured') || typeof live.revision !== 'string') return '当前服务端未提供阈值与磁盘版本信息，编辑不可用。';
  return '';
}
function codexCompactInitial(live) {
  const value = live.compaction ? live.compaction.configured : live.model_auto_compact_token_limit;
  return value == null ? (live.model_auto_compact_token_limit == null ? 'auto' : String(live.model_auto_compact_token_limit)) : String(value);
}
function renderCodexCompact() {
  const panel = $('codex-compact-panel'), input = $('codex-compact-input');
  if (!panel || !input) return;
  panel.hidden = !state || curApp !== 'codex';
  if (!state || curApp !== 'codex') return;
  const live = state.live?.codex || {}, compact = live.compaction;
  const focused = document.activeElement === input;
  if (!codexCompactDraft || (!codexCompactDraft.dirty && !focused && !savingCodexCompact && !codexCompactLoadTask)) {
    codexCompactDraft = { value: codexCompactInitial(live), revision: live.revision, dirty: false };
    input.value = codexCompactDraft.value;
  }
  if (!focused) input.value = codexCompactDraft.value.replace(/^(\d+)$/, digits => /[1-9]/.test(digits) ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : digits);
  const token = value => typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString()} tokens` : '未知 / Codex 自行决定';
  const configured = compact ? compact.configured : live.model_auto_compact_token_limit;
  const invalid = (compact?.warnings || []).some(warning => String(warning).includes('model_auto_compact_token_limit') && String(warning).includes('不是正安全整数'));
  const facts = [
    ['磁盘已配', configured == null ? (invalid || live.model_auto_compact_token_limit != null ? `无效配置（${live.model_auto_compact_token_limit ?? '当前值未知'}），请核对警告` : '默认（顶层未覆写）') : token(configured)],
    ['默认阈值', token(compact?.default_limit)],
    ['推算有效阈值', token(compact?.effective_limit) + (compact?.capped ? '（capped：已受窗口 / 阈值上限约束）' : '')],
  ];
  $('codex-compact-facts').innerHTML = '<dl>' + facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('') + '</dl>';
  const source = compact?.context_source === 'explicit' ? '显式配置' : compact?.context_source === 'catalog' ? '本地模型目录' : '未知';
  const warnings = Array.isArray(compact?.warnings) ? compact.warnings : [];
  $('codex-compact-warnings').textContent = `推算依据：上下文窗口 ${token(compact?.context_window)}（来源：${source}）；不是当前会话实测值。` + (warnings.length ? ' ' + warnings.join(' ') : '');
  const gate = codexCompactGate(), busy = savingCodexCompact || !!codexCompactLoadTask;
  input.disabled = !!gate || busy;
  $('codex-compact-save').disabled = !!gate || busy || !codexCompactDraft.dirty;
  $('codex-compact-auto').disabled = !!gate || busy;
  $('codex-compact-reload').disabled = !online || busy;
  panel.setAttribute('aria-busy', String(busy));
  input.setAttribute('aria-invalid', String(!!codexCompactError));
  const conflict = codexCompactDraft.revision !== live.revision;
  const status = $('codex-compact-status');
  status.textContent = gate || (savingCodexCompact ? '正在保存磁盘阈值…' : codexCompactLoadTask ? '正在重新读取磁盘阈值…'
    : codexCompactError || (conflict ? '磁盘配置已变化；草稿和原版本保留，保存将按原版本校验。请重新读取、核对后手动保存。'
      : codexCompactMessage || (codexCompactDraft.dirty ? '阈值草稿未保存；自动刷新不会覆盖。' : '磁盘阈值已读取；尚未改动配置。')));
  status.classList.toggle('err', !!gate || !!codexCompactError);
  status.classList.toggle('warn', !gate && !codexCompactError && conflict);
  status.classList.toggle('busy', !gate && busy);
}
$('codex-compact-input')?.addEventListener('focus', event => {
  if (codexCompactDraft) event.target.value = codexCompactDraft.value.replace(/^\d{1,3}(?:,\d{3})+$/, digits => digits.replace(/,/g, ''));
});
$('codex-compact-input')?.addEventListener('blur', () => renderCodexCompact());
function setCodexCompactValue(value) {
  if (!codexCompactDraft) return;
  codexCompactDraft.value = String(value); codexCompactDraft.dirty = true;
  $('codex-compact-input').value = codexCompactDraft.value;
  codexCompactEditRevision++; codexCompactError = ''; codexCompactMessage = '';
  renderCodexCompact();
}
async function loadCodexCompact() {
  if (!online || savingCodexCompact || codexCompactLoadTask) return;
  const editRevision = codexCompactEditRevision;
  if (codexCompactDraft?.dirty && !await askConfirm('重新读取 Codex 阈值', '保留当前阈值草稿，重新读取磁盘配置与版本。请核对新事实，再手动保存；这一步不会写入配置。', '读取并核对')) return;
  if (editRevision !== codexCompactEditRevision || savingCodexCompact || codexCompactLoadTask) return;
  const sequence = ++codexCompactLoadSequence, slotRevision = codexSlotRevision;
  codexCompactLoadTask = api('/api/codex/config'); renderCodexCompact();
  try {
    const result = await codexCompactLoadTask;
    if (sequence !== codexCompactLoadSequence || slotRevision !== codexSlotRevision) return;
    const live = result.codex;
    if (!live?.compaction || !Object.hasOwn(live.compaction, 'configured') || typeof live.revision !== 'string') throw new Error('服务端未返回阈值与磁盘版本');
    state.live.codex = live; codexSlotRevision++; codexCompactStateRevision++; codexCompactReadError = '';
    if (editRevision === codexCompactEditRevision) {
      codexCompactDraft = codexCompactDraft?.dirty ? { ...codexCompactDraft, revision: live.revision }
        : { value: codexCompactInitial(live), revision: live.revision, dirty: false };
      $('codex-compact-input').value = codexCompactDraft.value;
      codexCompactError = ''; codexCompactMessage = codexCompactDraft.dirty ? '已重新读取磁盘；草稿保留，请核对后手动保存。' : '已重新读取磁盘；尚未改动配置。';
    } else codexCompactMessage = '读取期间的新草稿和原版本保留；请再次重新读取、核对后保存。';
    renderProviders();
  } catch (e) {
    if (sequence === codexCompactLoadSequence && slotRevision === codexSlotRevision) codexCompactReadError = '读取失败：' + e.message + '。草稿保留，请重新读取后保存。';
  } finally { codexCompactLoadTask = null; renderCodexCompact(); }
}
async function saveCodexCompact(forcedValue) {
  if (curApp !== 'codex' || savingCodexCompact || codexCompactLoadTask || !codexCompactDraft) return;
  const gate = codexCompactGate();
  if (gate) { codexCompactError = gate; renderCodexCompact(); return; }
  if (forcedValue !== 'auto' && !codexCompactDraft.dirty) return;
  const raw = forcedValue === 'auto' ? 'auto' : codexCompactDraft.value.trim().toLowerCase()
    .replace(/^\d{1,3}(?:,\d{3})+(?:\.\d+)?[km]?$/, grouped => grouped.replace(/,/g, ''));
  const match = raw.match(/^(\d+)(?:\.(\d+))?([km])?$/);
  const scale = match?.[3] === 'm' ? 6 : match?.[3] === 'k' ? 3 : 0;
  const fraction = (match?.[2] || '').replace(/0+$/, '');
  const digits = match && (!match[2] || match[3]) && fraction.length <= scale ? (match[1] + fraction.padEnd(scale, '0')).replace(/^0+/, '') || '0' : '';
  const value = digits && digits.length <= 16 ? Number(digits) : NaN;
  if (raw !== 'auto' && (!Number.isSafeInteger(value) || value <= 0)) {
    codexCompactError = '请输入 auto 或正整数 tokens（支持 k / m 简写）。'; renderCodexCompact(); return;
  }
  const revision = codexCompactDraft.revision, editRevision = codexCompactEditRevision;
  const live = state.live.codex, target = live.config_file || live.config_path || APPS.codex.cfg;
  const meaning = raw === 'auto' ? '只删除顶层 model_auto_compact_token_limit，恢复 Codex 默认；不禁用自动压缩' : `将顶层 model_auto_compact_token_limit 设为 ${value} tokens`;
  if (!await askConfirm('保存 Codex 自动压缩阈值', `${meaning}。\n目标文件：${target}（原文件自动备份）。不改上下文窗口、模型槽位或其他配置。\nCodex 上限为上下文窗口的 90%；profile、项目或 CLI 可能覆盖。磁盘保存不会热改活会话；客户端需重新读取配置（必要时重新打开）并新开会话。`, raw === 'auto' ? '恢复默认' : '保存阈值')) return;
  if (codexCompactGate() || savingCodexCompact || codexCompactLoadTask) { renderCodexCompact(); return; }
  if (editRevision !== codexCompactEditRevision || revision !== codexCompactDraft.revision) {
    codexCompactError = '确认期间阈值草稿已变化，请重新确认当前值。'; renderCodexCompact(); return;
  }
  const slotRevision = codexSlotRevision;
  savingCodexCompact = true; codexCompactError = ''; codexCompactMessage = ''; renderCodexCompact();
  try {
    const result = await api('/api/codex/config', { method: 'POST', body: JSON.stringify({ action: 'compact_threshold', model_auto_compact_token_limit: raw === 'auto' ? 'auto' : raw, revision }) });
    if (!result.ok || !result.codex?.compaction || typeof result.codex.revision !== 'string'
      || result.codex.compaction.configured !== (raw === 'auto' ? null : value)) throw new Error('响应未确认磁盘阈值，可能已写盘；请重新读取核对');
    const editedDuring = codexCompactEditRevision !== editRevision;
    const slotsChanged = codexSlotRevision !== slotRevision;
    state.live.codex = slotsChanged ? { ...state.live.codex, revision: result.codex.revision,
      model_auto_compact_token_limit: result.codex.model_auto_compact_token_limit, compaction: result.codex.compaction } : result.codex;
    codexSlotRevision++; codexCompactStateRevision++;
    codexCompactDraft = editedDuring ? { ...codexCompactDraft, revision: result.codex.revision }
      : { value: codexCompactInitial(result.codex), revision: result.codex.revision, dirty: false };
    if (!editedDuring) $('codex-compact-input').value = codexCompactDraft.value;
    codexCompactMessage = (raw === 'auto' ? '已恢复磁盘默认；只删除顶层阈值，不禁用压缩。' : '阈值已保存到磁盘。')
      + ' 客户端需重新读取配置并新开会话；不会热改活会话。'
      + (editedDuring ? ' 后续编辑仍在草稿中。' : '')
      + (slotsChanged ? ' 槽位同时变化，请重新读取核对磁盘事实。' : '');
    const warnings = [...(Array.isArray(result.warnings) ? result.warnings : []), ...(result.codex.compaction.warnings || [])];
    toastWithBackupWarnings(codexCompactMessage, { warnings });
    renderSlots(); renderProviders(); renderOverviewPage();
  } catch (e) {
    codexCompactError = e.status === 409 ? '磁盘版本冲突（409）；阈值草稿和原版本保留，未保存。请重新读取、核对后手动重试。'
      : '阈值保存失败：' + e.message + '。草稿保留。';
    toast(codexCompactError, 'err');
  } finally { savingCodexCompact = false; renderCodexCompact(); }
}
// #codex-model-status 唯一写入口:直连写模型保存/热切换结果,路由写槽位生效状态。
function renderCodexModelStatus() {
  const status = $('codex-model-status'), live = state.live?.codex || {}, name = codexSlotStatus.name;
  const [text, tone] = codexConnectionMode() === 'direct'
    ? (!online ? ['控制台离线，模型不可保存', 'warn']
      : live.error ? ['配置读取失败，模型不可保存', 'err'] : live.profile ? ['当前启用了 profile，全局模型编辑已禁用', 'warn']
      : savingCodexDirect ? ['正在保存…', 'busy']
      : codexDirectMessage && codexDirectSave.revision === live.revision ? [codexDirectMessage, codexDirectMessage.startsWith('保存失败') ? 'err' : 'ok']
      : ['当前直连 · 模型配置已读取', 'ok'])
    : !online ? ['控制台离线，生效状态待确认', 'warn']
    : codexSlotStatus.error ? [`${name} 保存失败，已恢复原选择`, 'err']
    : [...slotSaving].some(key => key.startsWith('codex:')) ? ['保存中…', 'busy']
    : live.error ? ['Codex 配置读取失败，生效状态待确认', 'err']
    : live.router && live.hot_routing?.enabled === false ? ['Codex 路由配置未受管，未同步客户端默认模型与列表', 'warn']
    : live.router ? [`${name ? name + ' 已更新；' : ''}下一次槽位请求即时使用当前落点`, 'ok']
    : live.base_url ? ['Codex 当前直连，不使用槽位', ''] : ['Codex 尚未接入路由', ''];
  status.textContent = text;
  for (const t of ['ok', 'warn', 'err', 'busy']) status.classList.toggle(t, t === tone);
}
function renderCodexDirectModels(force) {
  const fields = $('codex-direct-fields'), live = state.live.codex;
  const locked = !online || !!live.error || !!live.profile || savingCodexDirect;
  const pending = codexDirectSave.pending;
  const known = [...new Set([...(live.model_options || []),
    ...providers('codex').filter(p => p.id === codexDirectProviderId()).flatMap(p => [p.model, ...(p.models || [])]),
    live.model, live.review_model, pending?.value].filter(id => id && !id.startsWith('mixr-')))];
  const rows = [['model', '主模型'], ['review_model', 'reviewer · 审查模型']].map(([key, label]) => {
    const selected = (pending?.key === key ? pending.value : live[key]) || '', id = 'codex-direct-' + key;
    const control = codexDirectEdit === key
      ? `<input id="${id}" type="text" aria-label="${label}" value="${esc(codexDirectValue)}" spellcheck="false" autocomplete="off" oninput="codexDirectValue=this.value" onkeydown="if(event.key==='Enter'){event.preventDefault();saveCodexDirectModel('${key}',this.value)}if(event.key==='Escape'){codexDirectEdit='';renderCodexDirectModels(true)}" ${locked ? 'disabled' : ''}><button class="small" onclick="saveCodexDirectModel('${key}',$('${id}').value)" ${locked ? 'disabled' : ''}>保存</button>`
      : `<select id="${id}" aria-label="${label}" onchange="saveCodexDirectModel('${key}',this.value)" ${locked ? 'disabled' : ''}>
          ${key === 'review_model' ? `<option value="" ${selected ? '' : 'selected'}>跟随主模型</option>` : ''}
          ${known.map(model => `<option value="${esc(model)}" ${selected === model ? 'selected' : ''}>${esc(model)}</option>`).join('')}
          <option value="__custom__">自定义模型…</option>
        </select>`;
    // 渠道名是这一行控件的标签,和下拉同一行,不再浮在下拉上方。
    const provider = codexDirectProviderName(live);
    return `<div class="rc-line codex-direct-line"><div class="field slot-ident">${label}<span class="mono">${key}</span></div><label class="field direct-control"><span class="direct-provider" title="直连渠道 ${esc(provider)}">${esc(provider)}</span>${control}</label></div>`;
  }).join('');
  if (fields.innerHTML !== rows && (force || !fields.contains(document.activeElement))) fields.innerHTML = rows;
  for (const key of ['model', 'review_model']) $('codex-direct-' + key).disabled = locked;
  for (const button of fields.querySelectorAll('button')) button.disabled = locked;
  renderCodexModelStatus();
}
async function saveCodexDirectModel(key, value) {
  const live = state?.live?.codex;
  if (!online || savingCodexDirect || !live || live.error || live.profile || codexConnectionMode() !== 'direct') return;
  if (value === '__custom__') {
    codexDirectEdit = key; codexDirectValue = live[key] || '';
    renderCodexDirectModels(true); $('codex-direct-' + key).focus(); return;
  }
  value = value.trim();
  if ((!value && key !== 'review_model') || value.startsWith('mixr-')) return toast('请输入真实模型名', 'err');
  savingCodexDirect = true; codexDirectMessage = ''; codexDirectSave.pending = { key, value };
  renderCodexDirectModels(true);
  try {
    const result = await api('/api/codex/config', { method: 'POST',
      body: JSON.stringify({ action: 'direct_models', [key]: value || null, revision: live.revision }) });
    state.live.codex = result.codex; codexSlotRevision++; codexCompactStateRevision++;
    codexDirectEdit = ''; codexDirectSave.revision = result.codex.revision;
    const runtime = result.runtime;
    codexDirectMessage = runtime?.status === 'applied'
      ? `模型已热切换，${runtime.updated} 个会话的下一轮使用 ${result.codex.model}`
      : runtime?.status === 'partial'
        ? `模型已保存，${runtime.updated} 个会话已切换，${runtime.failed} 个会话待同步`
        : runtime?.status === 'no_matching_threads' ? '模型已保存；没有沿用原默认模型的活动会话'
        : runtime?.status === 'unsupported' ? '模型已保存；会话热切换需要 Node.js 22 或更新版本'
        : runtime?.status === 'not_running' ? '模型已保存；未检测到运行中的 Codex 后台'
        : runtime?.status === 'home_mismatch' ? '模型已保存；运行中的 Codex 后台读的是另一份配置目录，未热切换'
        : runtime?.status === 'unavailable' ? '模型已保存；连不上 Codex 后台，未热切换，重新打开会话后生效'
        : runtime?.status === 'restart_required' ? '模型已保存；渠道已变，重启 Codex 后生效'
        : runtime ? '模型已保存；运行时同步未完成，重新打开会话后生效'
        : `${key === 'review_model' ? '审查模型' : '模型'}已保存；Codex 重新读取配置后生效`;
    toastWithBackupWarnings(codexDirectMessage, result);
  } catch (error) {
    codexDirectSave.revision = state.live.codex?.revision;
    codexDirectMessage = '保存失败：' + error.message;
    toast(codexDirectMessage, 'err');
  } finally {
    savingCodexDirect = false; codexDirectSave.pending = null;
    renderCodexDirectModels(true); renderProviders();
  }
}
function renderCodexModels(force) {
  $('codex-models').hidden = !state || curApp !== 'codex';
  renderCodexCompact();
  if (!state || curApp !== 'codex') return;
  renderCodexConfig(); renderCodexModelStatus();
  const fields = $('codex-model-fields'), direct = codexConnectionMode() === 'direct';
  fields.hidden = direct;
  $('codex-direct-fields').hidden = !direct;
  $('codex-model-status').hidden = false;
  $('codex-models-hint').textContent = direct ? 'Codex 直连'
    : '选择渠道与落点模型；路由请求即时切换，模型列表自动同步，不改渠道默认模型。';
  if (direct) { renderCodexDirectModels(force); return; }
  const rows = ['main', 'reviewer'].map(name => codexSlotRow(
    (slotsOf().codex || []).find(s => s.name === name) || { name, alias: 'mixr-' + name, provider: '', model: '', configured_model: '' }
  )).join('');
  const focused = fields.contains(document.activeElement) ? document.activeElement.id : '';
  // 阈值面板留在 #codex-model-fields 之外(静态标记里就排在两行槽位之后):重绘槽位不碰它的草稿,
  // 键盘顺序 main → reviewer → 阈值与视觉顺序一致。
  if (fields._codexRows !== rows && (force || !focused)) {
    fields.innerHTML = rows; fields._codexRows = rows;
    if (focused) $(focused)?.focus();
  }
  for (const name of ['main', 'reviewer']) {
    const s = (slotsOf().codex || []).find(s => s.name === name);
    $('codex-model-' + name).disabled = !online || slotBusy('codex', name);
    const model = $('slot-model-codex-' + name);
    if (model) model.disabled = !online || slotBusy('codex', name) || !s?.provider;
  }
}
// 老页面入口仍沿用同一保存路径,不再有第二套 Codex 槽位状态。
function switchCodexModel(name, provider) { return setSlot('codex', name, 'provider', provider); }
function renderSlots(force) {
  renderCodexModels(force);
  const panel = $('slots-panel');
  // 外壳可能把同一块 slots-panel 放进 details#slots-details 并挪到渠道库下方:这里不另包
  // details(重复包裹会让折叠标题出现两次),只同步显隐;拿不到包装层就按老结构单独用 panel。
  const details = $('slots-details');
  if (!state) { panel.hidden = true; if (details) details.hidden = true; return; }
  const direct = curApp === 'codex' && codexConnectionMode() === 'direct';
  panel.hidden = direct; if (details) details.hidden = direct;
  const isClaude = curApp === 'claude';
  $('slots-hint').textContent = isClaude
    ? '把每个槽位绑定到「渠道 @ 模型」：应用后客户端 env 写入别名（mixr-…），该槽的所有请求——含子代理与后台任务——按槽位落点分发，优先于路由规则。落点模型从渠道模型列表里挑，要写渠道没登记的模型名就选「自定义模型…」。'
    : '自定义槽位同步到 Mixrouter 管理的 Codex 模型列表；选择 mixr-<槽名> 后，下一次路由请求即使用当前落点。';
  $('slots-apply').hidden = !isClaude;
  $('slots-apply').disabled = !isClaude || !online || slotSaving.size > 0 || !!slotModelEdit.claude;
  const list = slotsOf()[curApp] || [];
  renderSlotsSummary(isClaude ? list : list.filter(s => !['main', 'reviewer'].includes(s.name)), isClaude);
  const rows = isClaude
    ? list.map(claudeSlotRow).join('')
    : list.filter(s => !['main', 'reviewer'].includes(s.name)).map(codexSlotRow).join('') + `<div class="rc-line">
        <label class="field slot-ident">新槽位<span class="mono">别名 mixr-&lt;槽名&gt;</span></label>
        <label class="field" style="flex:1">槽位名<input id="slot-new-name" value="${esc(codexSlotDraft.name)}" oninput="codexSlotDraft.name=this.value" placeholder="如 worker" autocomplete="off" spellcheck="false" ${online ? '' : 'disabled'}></label>
        <label class="field" style="flex:2">渠道<select id="slot-new-provider" onchange="codexSlotDraft.provider=this.value" ${online ? '' : 'disabled'}>${slotChannelOptions(codexSlotDraft.provider, 'codex')}</select></label>
        <button class="small slot-add" onclick="addCodexSlot()" ${online ? '' : 'disabled'}>＋ 添加槽位</button>
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
// 相同渠道 id 与有效模型合成一枚 tag;每槽的别名/env/落点仍完整保留在 title。
function renderSlotsSummary(list, isClaude) {
  const box = $('slots-summary'); if (!box) return;
  const targets = new Map();
  for (const s of list) {
    const ch = providers(curApp).find(p => p.id === s.provider);
    const model = s.model || (isClaude ? ch?.models?.[0] : ch?.model) || '渠道默认';
    const key = JSON.stringify([s.provider || '', model]);
    const target = !s.provider ? '未配置' : !ch ? '渠道已删除' : `${ch.name} · ${model}`;
    const title = [SLOT_LABELS[s.name] || s.name, s.alias, s.env, s.provider ? `${ch?.name || s.provider}${ch ? ' @ ' + model : '（渠道已删除）'}` : '未配置'].filter(Boolean).join(' · ');
    if (!targets.has(key)) targets.set(key, { names: [], titles: [], target, unset: !s.provider || !ch });
    const group = targets.get(key);
    group.names.push(s.name); group.titles.push(title);
  }
  const html = list.length ? [...targets.values()].map(group =>
    `<span class="tag${group.unset ? ' unset' : ''}" title="${esc(group.titles.join('\n'))}">${esc(group.names.join(' / '))} → ${esc(group.target)}</span>`
  ).join('') : `<span class="tag unset">${isClaude ? '槽位未配置' : '没有自定义槽位'}</span>`;
  if (box.innerHTML !== html) box.innerHTML = html;
}
async function putSlot(app, name, value) {
  if (!online) { toast('控制台离线，未保存槽位改动', 'err'); renderSlots(true); return false; }
  if (slotBusy(app, name)) return false;
  const key = app + ':' + name, compactStateRevision = codexCompactStateRevision;
  slotSaving.add(key);
  if (app === 'codex') { codexSlotStatus.name = name; codexSlotStatus.error = ''; }
  renderSlots(true);
  try {
    const r = await api('/api/slots', { method: 'PUT', body: JSON.stringify({ [app]: { [name]: value } }) });
    if (r?.slots) state.slots = r.slots;
    if (app === 'codex') {
      if (r?.live?.codex) state.live.codex = compactStateRevision === codexCompactStateRevision ? r.live.codex
        : { ...r.live.codex, revision: state.live.codex.revision, model_auto_compact_token_limit: state.live.codex.model_auto_compact_token_limit, compaction: state.live.codex.compaction };
      codexSlotRevision++;
      renderProviders(); renderOverviewPage();
    } else await refresh();
    return true;
  } catch (e) {
    if (app === 'codex') { codexSlotStatus.name = name; codexSlotStatus.error = e.message; }
    toast('槽位保存失败：' + e.message, 'err'); return false;
  } finally { slotSaving.delete(key); renderSlots(true); }
}
async function setSlot(app, name, field, value) {
  if (slotBusy(app, name)) return false;
  if (field === 'provider' && !value) return clearSlot(app, name);
  const s = (slotsOf()[app] || []).find(x => x.name === name);
  if (!s && !(app === 'codex' && ['main', 'reviewer'].includes(name))) return false;
  if (field === 'provider') {
    const p = providers(app).find(p => p.id === value);
    if (!p || (app === 'codex' && (!p.enabled || !p.model))) { renderSlots(true); return false; }
    if (slotModelEdit[app]?.name === name) slotModelEdit[app] = null;
  } else if (!s?.provider) return false;
  const val = field === 'provider'
    ? { provider: value, ...(app === 'claude' ? { model: (providers('claude').find(p => p.id === value)?.models || [s?.model])[0] || '' } : {}) }
    : { provider: s.provider, model: value };
  const ok = await putSlot(app, name, val);
  if (ok) toast(`槽位 ${name} 已更新`, 'ok');
  return ok;
}
async function clearSlot(app, name) {
  if (slotModelEdit[app]?.name === name) slotModelEdit[app] = null;
  const ok = await putSlot(app, name, null);
  if (ok) toast(`槽位 ${name} 已清空`, 'ok');
  return ok;
}
async function addCodexSlot() {
  const name = ($('slot-new-name').value || '').trim().toLowerCase();
  const provider = $('slot-new-provider').value;
  codexSlotDraft.name = $('slot-new-name').value; codexSlotDraft.provider = provider;
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(name)) return toast('槽位名只能用小写字母、数字、连字符（≤24 位）', 'err');
  if (['main', 'reviewer'].includes(name) || (slotsOf().codex || []).some(s => s.name === name)) return toast('槽位名已存在，请使用不同名称', 'err');
  if (!providers('codex').some(p => p.id === provider && p.enabled && p.model)) return toast('请选择已启用且有默认模型的渠道', 'err');
  if (await putSlot('codex', name, { provider })) {
    toast(`槽位 ${name} 已添加，别名 mixr-${name}`, 'ok');
    codexSlotDraft.name = ''; codexSlotDraft.provider = ''; renderSlots(true);
  }
}
async function applySlotsClaude() {
  if (curApp !== 'claude' || !canConnect('claude')) return;
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

