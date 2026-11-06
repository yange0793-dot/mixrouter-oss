'use strict';
// 独立于模型槽位的编辑器。轮询只更新按钮状态，不重读配置或重建草稿。
let botsSnapshot = null, botsDraft = [], botsDirty = false, botsLoading = false, botsSaving = false;
let botsAttempted = false, botsSequence = 0, botsEditRevision = 0, botsNextId = 0;
let botsMessage = '尚未读取 Bots 配置。', botsMessageKind = '';

function botsModelVisible() { return curApp === 'claude' && view === 'providers'; }
function botsModelProvider(id) { return botsSnapshot?.providers.find(p => p.id === id); }
function botsModelModels(p) { return [...new Set((p?.models || []).filter(m => typeof m === 'string' && m))]; }
function botsModelOptions(values, current, placeholder, missing) {
  const rows = [{ value: '', label: placeholder }, ...values];
  if (current && !values.some(v => v.value === current)) rows.push({ value: current, label: `${current}（${missing}）` });
  return rows.map(v => `<option value="${esc(v.value)}"${v.value === current ? ' selected' : ''}${v.disabled ? ' disabled' : ''}>${esc(v.label)}</option>`).join('');
}
function botsModelStatus(message, kind = '') {
  botsMessage = message; botsMessageKind = kind;
  renderBotsModels();
}
function renderBotsModels(rebuild = false) {
  const panel = $('bots-panel');
  if (!panel) return;
  panel.hidden = curApp !== 'claude';
  const locked = !online || botsSaving || !botsSnapshot;
  $('bots-reload').disabled = !online || botsSaving || botsLoading;
  $('bots-add').disabled = locked;
  for (let i = 0; i < botsDraft.length; i++) {
    for (const field of ['name', 'provider', 'remove']) {
      const control = $('bots-' + field + '-' + i);
      if (control) control.disabled = locked;
    }
    for (const field of ['model', 'key']) {
      const control = $('bots-' + field + '-' + i);
      if (control) control.disabled = locked || !botsDraft[i].provider;
    }
  }
  $('bots-save').disabled = locked || !online || botsLoading || !botsDirty;
  $('bots-status').textContent = !online ? '控制台离线：草稿保留，恢复连接后才能保存。' : botsMessage;
  // 状态色:进行中 busy、成功 ok、失败 error、离线 warn;其余保持中性。
  const kind = !online ? 'warn' : botsMessageKind;
  $('bots-status').className = 'hint' + (kind ? ' bots-' + kind : '');
  if (!rebuild) return;
  $('bots-rows').innerHTML = botsDraft.map((b, i) => {
    const p = botsModelProvider(b.provider);
    const providerOptions = botsModelOptions((botsSnapshot?.providers || []).map(p => ({ value: p.id, label: p.name || p.id })), b.provider, '选择渠道', '渠道已失效');
    const modelOptions = botsModelOptions(botsModelModels(p).map(m => ({ value: m, label: m })), b.model, '选择模型', '模型已失效');
    const keyOptions = botsModelOptions((p?.keys || []).map(k => ({ value: k.id, label: (k.label || k.id) + (k.enabled === false ? '（已停用）' : ''), disabled: k.enabled === false })), b.key_id || '', '跟随渠道当前 Key', 'Key 已失效');
    const disabled = locked ? ' disabled' : '';
    // 标签文字包一层 span:桌面宽度下第 2 行起只给读屏(列已对齐,不必每行重复),窄屏照常显示。
    return `<div class="bots-row">
      <label class="field" for="bots-name-${i}"><span class="bots-label">Bot 名字</span><input id="bots-name-${i}" type="text" value="${esc(b.name)}" autocomplete="off" spellcheck="false" oninput="setBotModel(${i},'name',this.value)"${disabled}></label>
      <label class="field" for="bots-provider-${i}"><span class="bots-label">渠道</span><select id="bots-provider-${i}" onchange="setBotModel(${i},'provider',this.value)"${disabled}>${providerOptions}</select></label>
      <label class="field" for="bots-model-${i}"><span class="bots-label">模型</span><select id="bots-model-${i}" onchange="setBotModel(${i},'model',this.value)"${!b.provider || locked ? ' disabled' : ''}>${modelOptions}</select></label>
      <label class="field" for="bots-key-${i}"><span class="bots-label">Key（可选）</span><select id="bots-key-${i}" onchange="setBotModel(${i},'key_id',this.value)"${!b.provider || locked ? ' disabled' : ''}>${keyOptions}</select></label>
      <button class="small danger bots-remove" id="bots-remove-${i}" type="button" aria-label="${esc('删除 Bot ' + b.name)}" onclick="removeBotModel(${i})"${disabled}>删除</button>
    </div>`;
  }).join('') || '<p class="hint bots-empty">还没有 Bot。新增名字后选择渠道与模型。</p>';
}
function botsModelPayload(value) {
  if (!value || !Array.isArray(value.bots) || !Array.isArray(value.providers) || value.revision == null) throw new Error('Bots 配置数据不完整');
  return { bots: value.bots.map(b => ({ id: b.id, name: b.name, provider: b.provider || '', model: b.model || '', ...(b.key_id ? { key_id: b.key_id } : {}) })), revision: value.revision, providers: value.providers };
}
function botsModelAccept(next, seed = false) {
  botsSnapshot = next;
  botsDraft = next.bots.map(b => ({ ...b }));
  if (seed && !botsDraft.length) botsDraft = ['Sol', 'Astra', 'Kimi', 'Opus'].map(name => ({ id: name.toLowerCase(), name, provider: '', model: '' }));
  botsDirty = false;
  botsEditRevision++;
}
async function loadBotsModels(manual = true) {
  renderBotsModels();
  if ((!manual && (!botsModelVisible() || botsAttempted)) || !online || botsLoading || botsSaving) return;
  const beforeConfirm = botsEditRevision;
  if (manual && botsDirty) {
    if (!await askConfirm('重新读取 Bots 配置', '未保存的 Bots 草稿将被丢弃，是否重新读取？', '放弃草稿并读取')) return;
    if (beforeConfirm !== botsEditRevision || botsSaving || botsLoading || !online) return;
  }
  botsAttempted = true; botsLoading = true;
  const sequence = ++botsSequence, edit = botsEditRevision;
  botsModelStatus('正在读取 Bots 配置…', 'busy');
  try {
    const next = botsModelPayload(await api('/api/bots'));
    if (sequence !== botsSequence || edit !== botsEditRevision) {
      botsModelStatus('读取期间草稿有改动，已保留草稿；如需重读请再次点击「重新读取」。');
      return;
    }
    botsModelAccept(next, true);
    botsModelStatus(next.bots.length ? '已读取 Bots 配置。' : '以下为未绑定草稿，请手动选择；未绑定行不会保存。');
    renderBotsModels(true);
  } catch (e) {
    if (sequence === botsSequence && edit === botsEditRevision) botsModelStatus(`读取失败：${e.message}。草稿保留，可重新读取。`, 'error');
  } finally {
    if (sequence === botsSequence) { botsLoading = false; renderBotsModels(); }
  }
}
function setBotModel(index, field, value) {
  const b = botsDraft[index];
  if (!b || !online || botsSaving || !['name', 'provider', 'model', 'key_id'].includes(field)) return;
  const previousProvider = b.provider;
  b[field] = value;
  if (field === 'provider') {
    const p = botsModelProvider(value);
    if (!botsModelModels(p).includes(b.model)) b.model = '';
    // Key id 只在所属渠道内唯一；同 id 不能证明跨渠道还是同一个账号。
    if (previousProvider !== value) delete b.key_id;
  }
  botsDirty = true; botsEditRevision++;
  botsModelStatus('草稿未保存。');
  // 名字输入不重建 DOM，保留光标与输入法组合；下拉变更才更新依赖选项。
  if (field !== 'name') renderBotsModels(true);
}
function addBotModel() {
  if (!botsSnapshot || !online || botsSaving) return;
  botsDraft.push({ id: `bot-${Date.now().toString(36)}-${++botsNextId}`, name: '', provider: '', model: '' });
  botsDirty = true; botsEditRevision++;
  botsModelStatus('草稿未保存。'); renderBotsModels(true);
  $('bots-name-' + (botsDraft.length - 1))?.focus();
}
function removeBotModel(index) {
  if (!botsDraft[index] || !online || botsSaving) return;
  botsDraft.splice(index, 1); botsDirty = true; botsEditRevision++;
  botsModelStatus('草稿未保存。'); renderBotsModels(true);
}
function botsModelValidate() {
  const savedIds = new Set((botsSnapshot?.bots || []).map(b => b.id));
  for (const b of botsDraft) {
    if (savedIds.has(b.id) && !b.provider && !b.model && !b.key_id) throw new Error(`${b.name}：已保存的绑定不能留空，请选择渠道与模型，或点击「删除」移除该 Bot`);
  }
  const selected = botsDraft.filter(b => b.provider || b.model || b.key_id);
  const names = new Set();
  for (const b of selected) {
    if (!b.name.trim()) throw new Error('请为已绑定的 Bot 填写名字');
    if (names.has(b.name)) throw new Error(`Bot 名字重复：${b.name}`);
    names.add(b.name);
    const p = botsModelProvider(b.provider);
    if (!p) throw new Error(`${b.name}：请选择有效渠道`);
    if (!botsModelModels(p).includes(b.model)) throw new Error(`${b.name}：请选择有效模型`);
    if (b.key_id && !(p.keys || []).some(k => k.id === b.key_id && k.enabled !== false)) throw new Error(`${b.name}：请选择有效 Key，或跟随渠道当前 Key`);
  }
  return selected.map(b => ({ id: b.id, name: b.name, provider: b.provider, model: b.model, ...(b.key_id ? { key_id: b.key_id } : {}) }));
}
async function saveBotsModels() {
  if (!online) { botsModelStatus('控制台离线：草稿保留，未保存。', 'error'); return; }
  if (!botsSnapshot || !botsDirty || botsLoading || botsSaving) return;
  let bots;
  try { bots = botsModelValidate(); } catch (e) { botsModelStatus(e.message, 'error'); return; }
  botsSaving = true;
  const sequence = ++botsSequence, edit = botsEditRevision;
  botsModelStatus('正在保存 Bots 模型…', 'busy'); renderBotsModels(true);
  try {
    const next = botsModelPayload(await api('/api/bots', { method: 'PUT', body: JSON.stringify({ bots, expected_revision: botsSnapshot.revision }) }));
    if (sequence !== botsSequence || edit !== botsEditRevision) return;
    if (JSON.stringify(next.bots) !== JSON.stringify(bots)) throw new Error('服务端返回的配置与提交内容不一致，请重新读取核对');
    botsModelAccept(next);
    botsModelStatus('Bots 模型已保存；从下一次 Bot 发言生效。', 'ok');
  } catch (e) {
    if (sequence === botsSequence) botsModelStatus(e.status === 409
      ? '保存冲突：服务端 Bots 配置已更新，草稿未提交。请重新读取最新版本后再修改。'
      : `保存失败：${e.message}。草稿保留。`, 'error');
  } finally {
    if (sequence === botsSequence) { botsSaving = false; renderBotsModels(true); }
  }
}
renderBotsModels();
loadBotsModels(false);
