/* Independent DeepSeek Harness view. Classic script; no APPS/client-interface fallback. */
(function () {
  'use strict';

  const NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
  const RESERVED = ['constructor', 'prototype', '__proto__'];
  const MAX_SLOTS = 32;
  const $d = id => document.getElementById(id);
  const escape = value => esc(value);
  const copy = value => JSON.parse(JSON.stringify(value));
  let snapshot = null;
  let draft = null;
  let base = '';
  let dirty = false;
  let unsupported = false;
  let configError = '';
  let busy = '';
  let loadTask = null;

  function visible() {
    try { if (typeof view === 'string') return view === 'dsh'; } catch (_) {}
    const section = $d('view-dsh');
    return !!section && !section.hidden && section.style.display !== 'none';
  }
  function connected() {
    try { if (typeof online === 'boolean') return online; } catch (_) {}
    return document.body?.dataset?.connection !== 'offline';
  }
  function status(message, kind = '') {
    const node = $d('dsh-status');
    if (node) { node.textContent = message; node.className = 'hint dsh-status ' + kind; }
  }
  function notify(message, kind = '') {
    status(message, kind);
    if (typeof toast === 'function') toast(message, kind);
  }
  // api() drops the HTTP status when a JSON error has a message. Preserve it here so a
  // genuine old-backend 404 disables this view without mistaking other failures for it.
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(path, {
        ...options, cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...options.headers },
      });
      let body;
      try { body = await response.json(); } catch (_) { body = null; }
      if (!response.ok) {
        const error = new Error(body?.error || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      if (!body || typeof body !== 'object') throw new Error('服务端返回了无效数据');
      return body;
    } finally { clearTimeout(timer); }
  }
  function fail(error, prefix) {
    if (error.status === 404) {
      unsupported = true;
      $d('dsh-unsupported').hidden = false;
      $d('dsh-editor').hidden = true;
      status('当前后端不支持 /api/dsh；此页已禁用，不会改用其他客户端接口。', 'warn');
    } else {
      notify(prefix + '：' + error.message + '。草稿仍保留。', 'err');
    }
  }
  function slotValue(value) {
    const slot = { provider: String(value?.provider || ''), model: String(value?.model || '') };
    if (typeof value?.upstream_stream === 'boolean') slot.upstream_stream = value.upstream_stream;
    return slot;
  }
  function draftOf(data) {
    if (data.version !== 1 || data.revision == null || !data.slots || typeof data.slots !== 'object' || Array.isArray(data.slots)) {
      throw new Error('DeepSeek Harness 配置不完整或版本不支持');
    }
    const slots = Object.fromEntries(Object.entries(data.slots).map(([name, value]) => [name, slotValue(value)]));
    if (!Object.hasOwn(slots, 'main')) slots.main = { provider: '', model: '' };
    return { slots, default_subagent: String(data.default_subagent || '') };
  }
  function providers() {
    return (Array.isArray(snapshot?.providers) ? snapshot.providers : [])
      .filter(p => p && typeof p.id === 'string' && ['chat', 'responses'].includes(p.wire_api));
  }
  function providerById(id) { return providers().find(p => p.id === id); }
  function configuredNames() {
    return draft ? Object.entries(draft.slots).filter(([name, slot]) => {
      const provider = providerById(slot.provider);
      return name !== 'main' && NAME.test(name) && !RESERVED.includes(name) && provider && provider.enabled !== false && !!slot.model.trim();
    }).map(([name]) => name) : [];
  }
  function syncButtons() {
    const editable = !!draft && !unsupported && !configError && connected() && !busy;
    for (const id of ['dsh-add', 'dsh-new-name', 'dsh-default-subagent']) {
      const node = $d(id); if (node) node.disabled = !editable;
    }
    $d('dsh-save').disabled = !editable || !dirty || !!loadTask;
    $d('dsh-sync').disabled = !editable || dirty || !!loadTask || snapshot?.client?.installed !== true || snapshot?.client?.status === 'conflict';
    $d('dsh-reload').disabled = !!busy || !!loadTask || !connected();
    $d('dsh-save').textContent = busy === 'save' ? '保存中…' : '保存草稿';
    $d('dsh-sync').textContent = busy === 'sync' ? '同步中…' : '同步到 Harness';
    if ($d('dsh-slots')) {
      for (const node of $d('dsh-slots').querySelectorAll('input,select,button')) node.disabled = !editable;
    }
    const note = $d('dsh-draft-note');
    if (note) note.textContent = configError ? `DSH 路由配置读取失败：${configError}。保存与同步已停用，草稿保留。`
      : !connected() ? '控制台离线，草稿保留；恢复连接后再保存。'
      : dirty ? '有未保存修改。自动刷新不会覆盖草稿；保存后才能同步到 Harness。'
      : '草稿与服务端一致。同步只改客户端自有 profile，之后需重启 Harness 后新建会话。';
  }
  function renderClient() {
    const client = snapshot?.client;
    if (!client) { $d('dsh-client').innerHTML = '<p class="hint">尚未读取客户端状态。</p>'; return; }
    const installation = client.installed === true ? '已安装' : client.installed === false ? '未安装（此页不自动安装）' : '未确认';
    const routed = client.routed === true ? '磁盘配置已接入路由' : client.routed === false ? '磁盘配置尚未接入路由' : '未确认';
    const statuses = { conflict: '自有 profile 字段有冲突（同步已停用）', out_of_sync: '槽位或默认子智能体有变更（可同步）' };
    $d('dsh-client').innerHTML = `<dl class="config-facts">
      <div><dt>客户端</dt><dd>${escape(installation)}</dd></div>
      <div><dt>配置状态</dt><dd>${escape(statuses[client.status] || client.status || '未确认')}</dd></div>
      <div><dt>接入状态</dt><dd>${escape(routed)}</dd></div>
      <div><dt>当前模型（磁盘）</dt><dd class="mono">${escape(client.model || '未配置')}</dd></div>
      <div><dt>配置文件</dt><dd class="mono">${escape(client.config_path || '未提供')}</dd></div>
      <div><dt>会话</dt><dd>同步后需重启 Harness 后新建会话</dd></div>
    </dl>`;
  }
  function modelOptions(slot) {
    const provider = providerById(slot.provider);
    const models = [...new Set([...(Array.isArray(provider?.models) ? provider.models : []), provider?.model].filter(m => typeof m === 'string' && m))];
    return models.map(model => `<option value="${escape(model)}"></option>`).join('');
  }
  function renderDefaults() {
    const select = $d('dsh-default-subagent');
    const names = configuredNames();
    const value = draft.default_subagent;
    let options = '<option value="">跟随主模型</option>';
    if (value && !names.includes(value)) options += `<option value="${escape(value)}" disabled>${escape(value)}（配置不完整）</option>`;
    options += names.map(name => `<option value="${escape(name)}">${escape(name)} · mixr-dsh-${escape(name)}</option>`).join('');
    if (select.innerHTML !== options) select.innerHTML = options;
    select.value = value;
  }
  function providerOptions(slot) {
    let choices = '<option value="">选择渠道</option>';
    if (slot.provider && !providerById(slot.provider)) choices += `<option value="${escape(slot.provider)}" disabled>${escape(slot.provider)}（渠道不可用）</option>`;
    return choices + providers().map(p => `<option value="${escape(p.id)}"${p.enabled === false ? ' disabled' : ''}>${escape(p.name || p.id)} · ${escape(p.wire_api)}${p.enabled === false ? '（已停用）' : ''}</option>`).join('');
  }
  function refreshChoices() {
    ['main', ...Object.keys(draft.slots).filter(name => name !== 'main')].forEach((name, index) => {
      const slot = draft.slots[name];
      const select = $d(`dsh-slot-${index}-provider`);
      const list = $d(`dsh-slot-${index}-models`);
      const options = providerOptions(slot);
      const models = modelOptions(slot);
      if (select && select.innerHTML !== options) { select.innerHTML = options; select.value = slot.provider; }
      if (list && list.innerHTML !== models) list.innerHTML = models;
    });
  }
  function renderSlots() {
    const names = ['main', ...Object.keys(draft.slots).filter(name => name !== 'main')];
    $d('dsh-slots').innerHTML = names.map((name, index) => {
      const slot = draft.slots[name];
      const id = 'dsh-slot-' + index;
      const arg = escape(JSON.stringify(name));
      const choices = providerOptions(slot);
      return `<div class="dsh-slot">
        <div class="dsh-slot-ident"><h3>${name === 'main' ? '主模型 · main' : escape(name)}</h3><span class="mono">mixr-dsh-${escape(name)}</span></div>
        <label class="field" for="${id}-provider">渠道<select id="${id}-provider" onchange="dshSetSlot(${arg},'provider',this.value)">${choices}</select></label>
        <label class="field" for="${id}-model">模型<input type="text" id="${id}-model" list="${id}-models" value="${escape(slot.model)}" placeholder="可填写自定义模型名" spellcheck="false" oninput="dshSetSlot(${arg},'model',this.value)"><datalist id="${id}-models">${modelOptions(slot)}</datalist></label>
        <label class="field" for="${id}-stream">上游请求<select id="${id}-stream" onchange="dshSetSlot(${arg},'upstream_stream',this.value)"><option value="inherit">继承默认</option><option value="true">流式</option><option value="false">非流式</option></select></label>
        ${name === 'main' ? '<span class="dsh-slot-fixed">主槽不可删除</span>' : `<button type="button" class="small danger dsh-slot-action" onclick="dshDeleteSlot(${arg})">删除子槽</button>`}
      </div>`;
    }).join('');
    names.forEach((name, index) => {
      const slot = draft.slots[name];
      $d(`dsh-slot-${index}-provider`).value = slot.provider;
      $d(`dsh-slot-${index}-stream`).value = typeof slot.upstream_stream === 'boolean' ? String(slot.upstream_stream) : 'inherit';
    });
    renderDefaults();
    $d('dsh-editor').hidden = unsupported;
    syncButtons();
  }
  function touched() {
    dirty = JSON.stringify(draft) !== base;
    renderDefaults();
    syncButtons();
  }
  function dshSetSlot(name, field, value) {
    if (!draft || !Object.hasOwn(draft.slots, name) || busy || unsupported || configError || !connected()) return;
    const slot = draft.slots[name];
    if (field === 'upstream_stream') {
      if (value === 'inherit') delete slot.upstream_stream;
      else if (value === 'true' || value === true) slot.upstream_stream = true;
      else if (value === 'false' || value === false) slot.upstream_stream = false;
      else return;
    } else if (field === 'provider') {
      const provider = providerById(value);
      if (value && (!provider || provider.enabled === false)) return;
      slot.provider = value;
      const index = ['main', ...Object.keys(draft.slots).filter(n => n !== 'main')].indexOf(name);
      $d(`dsh-slot-${index}-models`).innerHTML = modelOptions(slot);
    } else if (field === 'model') slot.model = String(value);
    else return;
    touched();
  }
  function dshSetDefault(value) {
    if (!draft || busy || unsupported || configError || !connected() || (value && !configuredNames().includes(value))) return;
    draft.default_subagent = value;
    touched();
  }
  function dshAddSlot() {
    if (!draft || busy || unsupported || configError || !connected()) return false;
    const input = $d('dsh-new-name');
    const name = input.value.trim();
    if (!NAME.test(name) || name === 'main' || RESERVED.includes(name)) { notify('子智能体名称需为 1–24 位小写字母、数字或连字符，且不能使用 main、constructor、prototype 等保留名称。', 'err'); return false; }
    if (Object.hasOwn(draft.slots, name)) { notify('此子智能体名称已存在。', 'err'); return false; }
    if (Object.keys(draft.slots).length >= MAX_SLOTS) { notify('最多配置 32 个槽位（含 main）；请先删除一个子槽。', 'err'); return false; }
    draft.slots[name] = { provider: '', model: '' };
    input.value = '';
    touched(); renderSlots();
    const index = ['main', ...Object.keys(draft.slots).filter(n => n !== 'main')].indexOf(name);
    $d(`dsh-slot-${index}-provider`)?.focus();
    return true;
  }
  async function dshDeleteSlot(name) {
    if (!draft || name === 'main' || !Object.hasOwn(draft.slots, name) || busy || unsupported || configError || !connected()) return false;
    busy = 'confirm'; syncButtons();
    try {
      const confirmed = await askConfirm('删除子智能体槽位', `删除 ${name}（mixr-dsh-${name}）？本次只改草稿，保存后才更新路由；客户端白名单还需另行同步。${draft.default_subagent === name ? '\n此槽是默认子智能体，删除后需重新选择默认槽。' : ''}`, '删除子槽');
      if (!confirmed) return false;
      delete draft.slots[name];
      if (draft.default_subagent === name) draft.default_subagent = '';
      touched(); renderSlots();
      $d('dsh-new-name')?.focus();
      return true;
    } finally { busy = ''; syncButtons(); }
  }
  function validate() {
    if (!draft || !Object.hasOwn(draft.slots, 'main')) return '主模型 main 不可缺失。';
    if (Object.keys(draft.slots).length > MAX_SLOTS) return '最多配置 32 个槽位（含 main）；请先删除多出的子槽。';
    for (const [name, slot] of Object.entries(draft.slots)) {
      if (!NAME.test(name) || RESERVED.includes(name)) return `槽位名称 ${name} 不符合命名规则或为保留名称。`;
      const provider = providerById(slot.provider);
      if (!provider || provider.enabled === false) return `${name} 需要选择已启用的 Chat Completions / Responses 渠道。`;
      if (!slot.model.trim()) return `${name} 需要填写模型名。`;
    }
    if (draft.default_subagent && !configuredNames().includes(draft.default_subagent)) return '请选择已配置的非 main 槽作为默认子智能体，或留空跟随主模型。';
    return '';
  }
  function dshRefresh(force = false) {
    syncButtons();
    if ((!force && !visible()) || !connected() || busy) return Promise.resolve(false);
    if (unsupported && !force) return Promise.resolve(false);
    if (loadTask) return loadTask;
    if (!snapshot) status('正在读取 DeepSeek Harness 配置…');
    loadTask = (async () => {
      try {
        const next = await request('/api/dsh');
        const nextDraft = draftOf(next);
        configError = next.error ? String(next.error) : '';
        if (configError) {
          if (snapshot) snapshot = { ...snapshot, client: next.client };
          else snapshot = next;
          renderClient();
          status(`DSH 路由配置读取失败：${configError}。保存与同步已停用，草稿仍保留。`, 'err');
          return false;
        }
        unsupported = false;
        $d('dsh-unsupported').hidden = true;
        // Read-only facts may refresh, but neither draft nor its expected revision may
        // advance beneath unsaved edits. Otherwise PUT would silently overwrite a newer version.
        const editing = dirty;
        const revision = editing ? snapshot?.revision : next.revision;
        snapshot = { ...next, revision };
        renderClient();
        if (!editing) {
          const changed = !draft || JSON.stringify(nextDraft) !== JSON.stringify(draft);
          draft = nextDraft;
          base = Object.hasOwn(next.slots, 'main') ? JSON.stringify(draft) : JSON.stringify({ slots: {}, default_subagent: draft.default_subagent });
          dirty = JSON.stringify(draft) !== base;
          if (changed) renderSlots();
          else { renderDefaults(); refreshChoices(); }
        } else { refreshChoices(); renderDefaults(); }
        $d('dsh-editor').hidden = false;
        status(editing ? '已更新客户端状态；未保存草稿保留，保存仍校验编辑前的配置版本。' : dirty ? '尚未配置主模型。请填写 main 的渠道与模型后保存草稿。' : '已读取配置。保存草稿与同步客户端是两个独立操作。');
        return true;
      } catch (error) { fail(error, '读取配置失败'); return false; }
      finally { loadTask = null; syncButtons(); }
    })();
    syncButtons();
    return loadTask;
  }
  async function dshReload() {
    if (busy || loadTask || !connected()) return false;
    if (dirty) {
      busy = 'confirm'; syncButtons();
      let confirmed;
      try { confirmed = await askConfirm('放弃未保存草稿', '重新载入会丢弃此页全部未保存修改，读取服务端最新配置。', '放弃并重载'); }
      finally { busy = ''; syncButtons(); }
      if (!confirmed) return false;
    }
    // Do not discard until the new snapshot has arrived successfully.
    const previous = { draft, base, dirty, snapshot };
    dirty = false;
    const ok = await dshRefresh(true);
    if (!ok) { ({ draft, base, dirty, snapshot } = previous); syncButtons(); }
    return ok;
  }
  async function dshSave() {
    if (!draft || !dirty || busy || loadTask || unsupported || configError || !connected()) return false;
    const problem = validate();
    if (problem) { notify(problem, 'err'); return false; }
    const payload = { expected_revision: snapshot.revision, slots: copy(draft.slots), default_subagent: draft.default_subagent };
    busy = 'save'; syncButtons();
    try {
      const result = await request('/api/dsh', { method: 'PUT', body: JSON.stringify(payload) });
      if (result.revision == null) throw new Error('保存响应未提供 revision，请重新读取核对');
      snapshot.revision = result.revision;
      snapshot.slots = copy(payload.slots);
      snapshot.default_subagent = payload.default_subagent;
      base = JSON.stringify(draft); dirty = false;
      if (result.client) snapshot.client = result.client;
      renderClient();
      $d('dsh-outcome').hidden = false;
      $d('dsh-outcome').textContent = '已保存路由草稿；未安装或重启 Harness，也未同步客户端模型与白名单。需要同步时另点「同步到 Harness」，之后重启 Harness 后新建会话。';
      notify('草稿已保存。客户端尚未同步；没有安装或重启 Harness。');
      return true;
    } catch (error) { fail(error, error.status === 409 ? '配置版本冲突，请核对后重新载入再修改' : '保存草稿失败'); return false; }
    finally { busy = ''; syncButtons(); }
  }
  async function dshSync() {
    if (!draft || busy || loadTask || unsupported || configError || !connected()) return false;
    if (dirty) { notify('请先保存草稿，再同步到 Harness。', 'warn'); return false; }
    if (snapshot.client?.installed !== true) { notify('未确认 Harness 已安装，不能同步；此页不会自动安装。', 'warn'); return false; }
    if (snapshot.client?.status === 'conflict') { notify('Harness 自有 profile 字段有冲突，同步已停用；槽位草稿仍可保存。', 'warn'); return false; }
    const problem = validate();
    if (problem) { notify(problem, 'err'); return false; }
    const revision = snapshot.revision;
    busy = 'confirm'; syncButtons();
    try {
      if (!await askConfirm('同步到 DeepSeek Harness', '将已保存槽位的模型别名与白名单同步到 Harness 的自有 profile 字段；不会改其他 profile，也不会安装、自动重启或热切换正在运行的会话。同步后请重启 Harness 后新建会话。', '确认同步')) return false;
      busy = 'sync'; syncButtons();
      const result = await request('/api/dsh/sync', { method: 'POST', body: JSON.stringify({ confirm: true, expected_revision: revision }) });
      if (result.client) { snapshot.client = result.client; renderClient(); }
      if (result.revision != null) snapshot.revision = result.revision;
      const warnings = Array.isArray(result.warnings) ? result.warnings.map(String) : [];
      const message = '已同步 Harness 自有 profile 的模型与白名单。请重启 Harness 后新建会话；正在运行的会话不会自动切换。' + (warnings.length ? '\n' + warnings.join('\n') : '');
      $d('dsh-outcome').hidden = false;
      $d('dsh-outcome').textContent = message;
      notify(message, warnings.length ? 'warn' : '');
      return true;
    } catch (error) { fail(error, error.status === 409 ? '同步版本冲突，请重新载入核对' : '同步 Harness 失败'); return false; }
    finally { busy = ''; syncButtons(); }
  }

  Object.assign(window, {
    dshRefresh, dshReload, dshSave, dshSync, dshAddSlot, dshDeleteSlot, dshSetSlot, dshSetDefault,
    dshUiState: () => ({ draft: draft ? copy(draft) : null, dirty, revision: snapshot?.revision, unsupported, configError, busy }),
  });
  // app.refresh() owns periodic updates; only the initially visible view reads on mount.
  function init() { if ($d('view-dsh')) dshRefresh(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
