'use strict';
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
  box.querySelectorAll('.rc-line').forEach(row => row.classList.toggle('has-reset', !!row.querySelector('.iconbtn')));
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
  return `<span class="routes-cell${items.length ? '' : ' inherit'}" data-session-routing="${esc(s.short)}">
    <span class="sum">${items.length ? items.length + ' 项覆盖' : '继承全局'}</span>
    ${items.slice(0, 2).map(x => `<span class="sub" title="${esc(x)}">· ${esc(x)}</span>`).join('')}
    ${items.length > 2 ? `<span class="sub">· 其余 ${items.length - 2} 项</span>` : ''}
    ${stale.length ? `<span class="sub warn">⚠ ${stale.length} 项引用已失效</span>` : ''}</span>`;
}

