'use strict';
/* Harness 的主模型与普通子代理候选池独立于 Claude / Codex 槽位。
 * classic script 共用 app.js 的 api / esc / toast；草稿只在本页内存里保存。
 * 客户端写入必须先预览，再由用户显式确认，不随路由保存自动执行。
 */
(function () {
  const root = typeof globalThis !== 'undefined' ? globalThis : window;
  if (root.__mixrHarnessUi) return;
  root.__mixrHarnessUi = true;

  const ui = {
    visible: false, snapshot: null, draft: null, baseRevision: null,
    dirty: false, busy: '', unavailable: false, error: '', message: '', preview: null,
  };
  const el = id => document.getElementById(id);
  const escape = value => esc(value);
  const text = value => value == null ? '（不存在）' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  const copyPair = value => value ? { provider: value.provider, model: value.model } : { provider: '', model: '' };
  const samePair = (a, b) => a.provider === b.provider && a.model === b.model;
  const isOnline = () => typeof online === 'boolean' && online;
  const canEdit = () => isOnline() && !!ui.snapshot && !ui.unavailable && !ui.busy;
  const providers = () => ui.snapshot?.providers || [];
  const providerOf = id => providers().find(item => item.id === id);
  const modelsOf = id => providerOf(id)?.models || [];
  const validPair = pair => !!pair && modelsOf(pair.provider).includes(pair.model)
    && providerOf(pair.provider)?.enabled !== false && providerOf(pair.provider)?.has_key === true;
  const validDraft = () => !!ui.draft && validPair(ui.draft.main) && ui.draft.pool.every(validPair);
  const clientBlocked = () => !['not-connected', 'missing', 'connected', 'needs-connect'].includes(ui.snapshot?.client?.status);
  const canPreview = () => canEdit() && validDraft() && !ui.dirty && ui.snapshot.configured === true && !clientBlocked();
  const hasPreview = () => !!ui.preview && ui.preview.revision === ui.baseRevision
    && typeof ui.preview.profile_revision === 'string' && !!ui.preview.profile_revision;

  function validateState(state) {
    const pair = item => !!item && typeof item.provider === 'string' && typeof item.model === 'string';
    if (!state || state.api_version !== 1 || !Array.isArray(state.providers) || !Array.isArray(state.pool)
      || typeof state.revision !== 'string' || !state.client || typeof state.client.status !== 'string'
      || !state.providers.every(item => item && typeof item.id === 'string' && Array.isArray(item.models) && item.models.every(model => typeof model === 'string'))
      || !state.pool.every(pair) || state.main !== null && !pair(state.main)) {
      ui.unavailable = true;
      throw new Error('服务端未提供受支持的 Harness 配置，当前只读。');
    }
  }

  function adopt(state) {
    validateState(state);
    ui.snapshot = state;
    if (ui.preview && ui.preview.revision !== state.revision) ui.preview = null;
    ui.baseRevision = state.revision;
    ui.draft = {
      main: copyPair(state.main),
      pool: state.pool.map(item => ({ ...copyPair(item), ...(item.id ? { id: item.id } : {}) })),
    };
    ui.dirty = false;
    ui.unavailable = false;
  }

  function providerOptions(selected) {
    let html = '<option value="">请选择渠道</option>';
    if (selected && !providerOf(selected)) html += `<option value="${escape(selected)}" selected>${escape(selected)}（已不在渠道库）</option>`;
    return html + providers().map(item => `<option value="${escape(item.id)}" ${item.id === selected ? 'selected' : ''} ${item.enabled === false || !item.has_key ? 'disabled' : ''}>${escape(item.name || item.id)}${item.enabled === false ? '（停用）' : !item.has_key ? '（缺少 Key）' : ''}</option>`).join('');
  }

  function modelOptions(provider, selected) {
    const models = modelsOf(provider);
    let html = '<option value="">请选择模型</option>';
    if (selected && !models.includes(selected)) html += `<option value="${escape(selected)}" selected>${escape(selected)}（已不在渠道模型列表）</option>`;
    return html + models.map(model => `<option value="${escape(model)}" ${model === selected ? 'selected' : ''}>${escape(model)}</option>`).join('');
  }

  function pairFields(pair, prefix, index) {
    const main = index == null;
    const action = main ? 'harnessPickMain' : `harnessPickPool.bind(null,${index})`;
    const disabled = !canEdit() ? 'disabled' : '';
    return `<label class="field" for="${prefix}-provider">渠道<select id="${prefix}-provider" onchange="(${action})('provider',this.value)" ${disabled}>${providerOptions(pair.provider)}</select></label>
      <label class="field" for="${prefix}-model">模型<select id="${prefix}-model" onchange="(${action})('model',this.value)" ${disabled || !modelsOf(pair.provider).length ? 'disabled' : ''}>${modelOptions(pair.provider, pair.model)}</select></label>`;
  }

  function render() {
    const main = el('harness-main');
    const pool = el('harness-pool');
    if (!main || !pool) return;
    const draft = ui.draft || { main: copyPair(null), pool: [] };
    main.innerHTML = pairFields(draft.main, 'harness-main', null);
    pool.innerHTML = `<ul class="harness-members">${draft.pool.map((member, index) => `<li class="harness-member">
      ${pairFields(member, `harness-pool-${index}`, index)}
      <button class="small danger harness-remove" type="button" id="harness-remove-${index}" onclick="harnessRemove(${index})" ${!canEdit() ? 'disabled' : ''} aria-label="移除候选 ${escape(member.model)}">移除</button>
      ${samePair(member, draft.main) ? '<span class="harness-main-note">也是主模型</span>' : ''}
      </li>`).join('')}</ul>
      ${draft.pool.length ? '' : '<p class="hint">还没有候选模型。保存时主模型会自动加入池中。</p>'}
      <button class="small" type="button" id="harness-add" onclick="harnessAdd()" ${!canEdit() || !providers().some(p => p.enabled !== false && p.has_key && p.models.length) ? 'disabled' : ''}>添加候选模型</button>`;
    const preview = el('harness-preview');
    const confirmed = !!ui.preview && el('harness-confirm')?.checked === true;
    if (preview) {
      preview.hidden = !ui.preview;
      preview.innerHTML = ui.preview ? previewHtml() : '';
      const checkbox = el('harness-confirm');
      if (checkbox) checkbox.checked = confirmed && hasPreview();
    }
    syncButtons();
    renderStatus();
  }

  function previewHtml() {
    const plan = ui.preview;
    const changes = Array.isArray(plan.changes) ? plan.changes : [];
    return `<h3 id="harness-preview-title">客户端写入预览</h3>
      <p class="hint">尚未写入任何文件。确认后只修改下面列出的受管字段；其他配置保留，原文件先备份。</p>
      <p class="harness-profile">文件：${escape(plan.client?.profile_path || ui.snapshot.client.profile_path || '未提供')}</p>
      <ul class="harness-changes">${changes.map(item => `<li><b>${escape(item.field)}</b>
        <div><span>当前</span><pre>${escape(text(item.before))}</pre></div>
        <div><span>将改为</span><pre>${escape(text(item.after))}</pre></div></li>`).join('')}</ul>
      ${changes.length ? '' : '<p class="hint">预览没有列出字段差异。</p>'}
      <label class="harness-confirm" for="harness-confirm"><input type="checkbox" id="harness-confirm" onchange="harnessSyncButtons()" ${!canEdit() || !hasPreview() ? 'disabled' : ''}>我确认按上面的预览写入 Harness 客户端配置</label>
      <button class="primary" type="button" id="harness-connect" onclick="harnessConnect()" disabled>确认写入客户端</button>`;
  }

  function renderStatus() {
    const node = el('harness-status');
    if (node) {
      node.textContent = ui.error || (!isOnline() && ui.snapshot ? '控制台离线，页面只读；本地草稿保留，未发送保存或客户端写入。' : ui.message) || (ui.busy ? '正在读取 Harness 配置…' : !ui.snapshot ? '尚未读取 Harness 配置。' : ui.dirty ? '有未保存草稿；刷新和切页不会覆盖。' : '配置已读取。保存路由不会自动写入客户端。');
      node.className = 'harness-status' + (ui.error ? ' err' : '');
    }
    const client = el('harness-client-status');
    if (!client) return;
    const status = ui.snapshot?.client?.status;
    const labels = { connected: '配置已写入（运行待验证）', missing: '尚无客户端配置', 'not-connected': '尚未接入', 'needs-connect': '接入配置需要更新', conflict: '客户端配置无法安全合并，禁止写入' };
    client.textContent = !ui.snapshot ? '客户端状态尚未读取。' : `客户端：${labels[status] || '状态不受支持，禁止写入'}${ui.snapshot.client.profile_path ? '。配置文件：' + ui.snapshot.client.profile_path : ''}${ui.snapshot.client.message ? '。原因：' + ui.snapshot.client.message : ''}`;
  }

  function syncButtons() {
    const gate = (id, enabled, label) => {
      const node = el(id);
      if (!node) return;
      node.disabled = !enabled;
      if (label) node.textContent = label;
    };
    const editable = canEdit();
    for (const prefix of ['harness-main', ...(ui.draft?.pool || []).map((_, index) => `harness-pool-${index}`)]) {
      gate(prefix + '-provider', editable);
      const pair = prefix === 'harness-main' ? ui.draft?.main : ui.draft?.pool[Number(prefix.split('-').at(-1))];
      gate(prefix + '-model', editable && !!pair && modelsOf(pair.provider).length > 0);
    }
    (ui.draft?.pool || []).forEach((_, index) => gate('harness-remove-' + index, editable));
    gate('harness-add', editable && providers().some(provider => provider.enabled !== false && provider.has_key && provider.models.length));
    gate('harness-confirm', canPreview() && hasPreview());
    gate('harness-save', editable && validDraft() && ui.dirty, ui.busy === 'save' ? '保存中…' : '保存主模型与候选池');
    gate('harness-reload', !ui.busy && typeof api === 'function', ui.dirty ? '放弃草稿并重载' : '重新读取');
    gate('harness-preview-button', canPreview(), ui.busy === 'preview' ? '读取预览…' : '预览客户端接入');
    gate('harness-connect', canPreview() && hasPreview() && el('harness-confirm')?.checked === true, ui.busy === 'connect' ? '写入中…' : '确认写入客户端');
    const view = el('view-harness');
    if (view) view.setAttribute('aria-busy', String(!!ui.busy));
  }

  function changed() {
    ui.dirty = true;
    ui.preview = null;
    ui.error = '';
    ui.message = '';
    render();
  }

  function pick(pair, key, value) {
    if (key === 'provider') {
      const provider = providerOf(value);
      if (value && (!provider || provider.enabled === false || !provider.has_key)) return false;
      pair.provider = value;
      pair.model = modelsOf(value)[0] || '';
    } else if (key === 'model') {
      if (value && !modelsOf(pair.provider).includes(value)) return false;
      pair.model = value;
    } else return false;
    return true;
  }

  function harnessPickMain(key, value) {
    if (!canEdit() || !pick(ui.draft.main, key, value)) return;
    changed();
    el('harness-main-' + key)?.focus();
  }

  function harnessPickPool(index, key, value) {
    const member = ui.draft?.pool[index];
    if (!canEdit() || !member || !pick(member, key, value)) return;
    delete member.id; // 新 pair 的稳定 ID 由服务端生成，不沿用旧模型的 ID。
    changed();
    el(`harness-pool-${index}-${key}`)?.focus();
  }

  function harnessAdd() {
    if (!canEdit()) return;
    let candidate = null;
    for (const provider of providers()) {
      if (provider.enabled === false || !provider.has_key) continue;
      for (const model of provider.models) {
        const pair = { provider: provider.id, model };
        if (!ui.draft.pool.some(item => samePair(item, pair))) { candidate = pair; break; }
      }
      if (candidate) break;
    }
    if (!candidate) { ui.message = '渠道库的所有可用模型都已在池中。'; renderStatus(); return; }
    ui.draft.pool.push(candidate);
    changed();
    el(`harness-pool-${ui.draft.pool.length - 1}-provider`)?.focus();
  }

  function harnessRemove(index) {
    if (!canEdit() || !ui.draft.pool[index]) return;
    ui.draft.pool.splice(index, 1);
    changed();
    el('harness-add')?.focus();
  }

  function fail(error, operation) {
    const status = error?.status;
    if (status === 404 || /HTTP 404/.test(error?.message || '')) {
      ui.unavailable = true;
      ui.error = '当前服务不支持 Harness 接口，页面只读；未保存或写入客户端。';
    } else if (status === 409) {
      ui.error = '配置已在其他位置更新，草稿保留且未覆盖。请重新读取最新配置后再修改。';
    } else {
      ui.error = `${operation}失败：${error?.name === 'AbortError' ? '请求超时' : error?.message || '未返回错误原因'}。草稿保留。`;
    }
    ui.preview = null;
  }

  async function harnessRefresh() {
    if (ui.busy || typeof api !== 'function') return;
    ui.busy = 'read';
    ui.error = '';
    render();
    try {
      const state = await api('/api/harness');
      validateState(state);
      if (!ui.dirty) adopt(state);
      else {
        ui.snapshot = state;
        ui.unavailable = false;
        if (state.revision !== ui.baseRevision) ui.message = '服务端配置已更新；本地草稿保留，旧修订保存会被拒绝。';
        else ui.message = '已刷新状态，本地未保存草稿保留。';
        ui.preview = null;
      }
    } catch (error) { fail(error, '读取'); }
    finally { ui.busy = ''; render(); }
  }

  async function harnessReload() {
    if (ui.busy) return;
    if (ui.dirty && (typeof askConfirm !== 'function' || !await askConfirm('放弃 Harness 草稿', '放弃本页未保存的主模型与候选池改动，并读取服务端最新配置？', '放弃并重载'))) return;
    ui.busy = 'read';
    ui.preview = null;
    ui.error = '';
    ui.message = '';
    render();
    try { adopt(await api('/api/harness')); }
    catch (error) { fail(error, '重载'); }
    finally { ui.busy = ''; render(); }
  }

  async function harnessSave() {
    if (!canEdit() || !validDraft() || !ui.dirty) return;
    ui.busy = 'save';
    ui.error = '';
    ui.preview = null;
    const body = { main: copyPair(ui.draft.main), pool: ui.draft.pool.map(item => ({ ...item })), expected_revision: ui.baseRevision };
    render();
    try {
      adopt(await api('/api/harness', { method: 'PUT', body: JSON.stringify(body) }));
      ui.message = '主模型与候选池已保存；主模型自动纳入池中。池更新供新会话使用，尚未写入客户端。';
      if (typeof toast === 'function') toast('Harness 主模型与候选池已保存', 'ok');
    } catch (error) { fail(error, '保存'); }
    finally { ui.busy = ''; render(); }
  }

  async function harnessPreview() {
    if (!canPreview()) return;
    ui.busy = 'preview';
    ui.error = '';
    ui.preview = null;
    render();
    try {
      const plan = await api('/api/harness/preview', { method: 'POST', body: JSON.stringify({ expected_revision: ui.baseRevision }) });
      if (!plan || plan.revision !== ui.baseRevision || typeof plan.profile_revision !== 'string' || !plan.profile_revision
        || !Array.isArray(plan.changes) || !plan.changes.every(item => item && typeof item.field === 'string' && Object.hasOwn(item, 'before') && Object.hasOwn(item, 'after'))) {
        throw new Error('服务端预览缺少完整字段差异或版本指纹，不能写入');
      }
      ui.preview = plan;
      ui.message = '预览已读取，尚未写入。核对字段后勾选确认，再点「确认写入客户端」。';
    } catch (error) { fail(error, '预览'); }
    finally { ui.busy = ''; render(); }
  }

  async function harnessConnect() {
    if (!canPreview() || !hasPreview() || el('harness-confirm')?.checked !== true) return;
    const body = { confirm: true, expected_revision: ui.preview.revision, expected_profile_revision: ui.preview.profile_revision };
    ui.busy = 'connect';
    ui.error = '';
    render();
    try {
      const result = await api('/api/harness/connect', { method: 'POST', body: JSON.stringify(body) });
      adopt(result?.state);
      ui.preview = null;
      const backups = result.backup && typeof result.backup === 'object' ? [
        result.backup.profile ? '配置备份：' + result.backup.profile : '',
        result.backup.credentials ? '凭据备份：' + result.backup.credentials : '',
      ].filter(Boolean) : [];
      ui.message = '客户端配置已写入，请新开 Harness 会话。' + (backups.length ? ' ' + backups.join('；') : '');
      if (typeof toast === 'function') toast('Harness 客户端配置已写入，新会话生效', 'ok');
    } catch (error) { fail(error, '客户端写入'); }
    finally { ui.busy = ''; render(); }
  }

  function harnessSetVisible(visible) {
    ui.visible = !!visible;
    if (ui.visible) return harnessRefresh();
  }

  function harnessSyncButtons() {
    syncButtons();
    renderStatus();
  }

  const exports = { harnessRefresh, harnessSetVisible, harnessReload, harnessSave, harnessPreview, harnessConnect,
    harnessPickMain, harnessPickPool, harnessAdd, harnessRemove, harnessSyncButtons };
  Object.assign(root, exports);
  if (typeof window !== 'undefined' && window !== root) Object.assign(window, exports);
})();
