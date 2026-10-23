/* Independent classic Harness view; no APPS fallback. */
(function () {
  'use strict';

  const NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
  const RESERVED = ['constructor', 'prototype', '__proto__'];
  const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const MAX_SLOTS = 32;
  const TASK_PRESETS = [['coder', '代码编写'], ['reviewer', '代码审查'], ['researcher', '资料检索'], ['tester', '测试验证'], ['planner', '任务规划'], ['writer', '文档写作'], ['vision', '图片理解']];
  const POLICY_IDS = ['dsh-policy-owner', 'dsh-allow-model-selection', 'dsh-default-mode', 'dsh-default-subagent', 'dsh-max-depth', 'dsh-max-active'];
  const $d = id => document.getElementById(id);
  const escape = value => esc(value);
  const copy = value => JSON.parse(JSON.stringify(value));
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  let snapshot = null;
  let observedRevision = null;
  let draft = null;
  let base = '';
  let dirty = false;
  let editRevision = 0;
  let unsupported = false;
  let configError = '';
  let busy = '';
  let loadTask = null;
  let preview = null;
  let previewRevision = null;
  let previewError = '';
  let lastFixedDefault = 'main';
  let renderedNames = [];
  const reasoningText = new Map();

  function visible() {
    try { if (typeof view === 'string') return view === 'dsh'; } catch (_) {}
    const section = $d('view-dsh');
    return !!section && !section.hidden && section.style.display !== 'none';
  }
  function connected() {
    try { if (typeof online === 'boolean') return online; } catch (_) {}
    return document.body?.dataset?.connection !== 'offline';
  }
  function apiReady() { return snapshot?.api_version === 2; }
  function editable() { return !!draft && apiReady() && !unsupported && !configError && connected() && !busy; }
  function setValue(id, value) {
    const node = $d(id);
    if (node && node.value !== String(value ?? '')) node.value = String(value ?? '');
  }
  function status(message, kind = '') {
    const node = $d('dsh-status');
    if (node) { node.textContent = message; node.className = 'hint dsh-status ' + kind; }
  }
  function notify(message, kind = '') {
    status(message, kind);
    if (typeof toast === 'function') toast(message, kind);
  }
  function clearOutcome() { if ($d('dsh-outcome')) $d('dsh-outcome').hidden = true; }
  function clearPreview() {
    preview = null; previewRevision = null; previewError = '';
    if ($d('dsh-preview-panel')) $d('dsh-preview-panel').hidden = true;
  }
  // api() drops the HTTP status when a JSON error has a message. Preserve it here so a
  // genuine old-backend GET 404 disables this view without mistaking other failures for it.
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
      if (!object(body)) throw new Error('服务端返回了无效数据');
      return body;
    } finally { clearTimeout(timer); }
  }
  function fail(error, prefix, disableView = true) {
    if (error.status === 404 && disableView) {
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
    if (object(value) && Object.hasOwn(value, 'label')) slot.label = value.label;
    if (typeof value?.upstream_stream === 'boolean') slot.upstream_stream = value.upstream_stream;
    if (object(value) && Object.hasOwn(value, 'capabilities')) slot.capabilities = copy(value.capabilities);
    return slot;
  }
  function legacyPolicy(data) {
    const names = Object.keys(data.slots);
    if (!names.length) return { owner: 'harness', allow_model_selection: false, allowed_slots: [], default: { mode: 'inherit' } };
    return { owner: 'mixrouter', allow_model_selection: true, allowed_slots: names, default: { mode: 'slot', slot: String(data.default_subagent || 'main') } };
  }
  function draftOf(data) {
    if (![1, 2].includes(data.version) || data.revision == null || !object(data.slots)) {
      throw new Error('DeepSeek Harness 配置不完整或版本不支持');
    }
    if (data.version === 2 && (!object(data.subagents) || !object(data.subagents.default)
      || !Array.isArray(data.subagents.allowed_slots) || typeof data.subagents.allow_model_selection !== 'boolean'
      || !['mixrouter', 'harness'].includes(data.subagents.owner))) {
      throw new Error('v2 响应未提供完整的普通 spawn 策略，请重新读取核对');
    }
    const slots = Object.fromEntries(Object.entries(data.slots).map(([name, value]) => {
      const slot = slotValue(value);
      if (data.version === 1 && !Object.hasOwn(slot, 'capabilities')) {
        // Preserve the historical adapter declarations on migration, not as a detected
        // upstream fact. New v2 routes start undeclared; token capacities remain blank.
        slot.capabilities = { input: ['text', 'image'], reasoning_efforts: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } };
      }
      return [name, slot];
    }));
    if (!Object.hasOwn(slots, 'main')) slots.main = { provider: '', model: '' };
    return { version: 2, slots, subagents: object(data.subagents) ? copy(data.subagents) : legacyPolicy(data) };
  }
  function migrationRequired() {
    if (!snapshot) return false;
    if (typeof snapshot.migration_required === 'boolean') return snapshot.migration_required;
    return (snapshot.source_version === 1 || snapshot.version === 1) && Object.keys(snapshot.slots || {}).length > 0;
  }
  function providers() {
    return (Array.isArray(snapshot?.providers) ? snapshot.providers : [])
      .filter(p => p && typeof p.id === 'string' && ['chat', 'responses'].includes(p.wire_api));
  }
  function providerById(id) { return providers().find(p => p.id === id); }
  function slotNames() { return draft ? ['main', ...Object.keys(draft.slots).filter(name => name !== 'main')] : []; }
  function configuredNames() {
    return slotNames().filter(name => {
      const slot = draft.slots[name], provider = providerById(slot.provider);
      return NAME.test(name) && !RESERVED.includes(name) && provider && provider.enabled !== false && !!slot.model.trim();
    });
  }
  function arrayText(value) { return Array.isArray(value) ? value.filter(v => typeof v === 'string').slice(0, 32) : []; }
  function affectedSections(value) { return arrayText(value?.affected_sections); }
  function routeText(name, slot) {
    if (!slot?.provider || !slot?.model) return `${name} 尚未配置`;
    const stream = typeof slot.upstream_stream === 'boolean' ? slot.upstream_stream ? '流式' : '非流式' : '继承默认';
    return `${name}（mixr-dsh-${name}）→ ${providerById(slot.provider)?.name || slot.provider} / ${slot.model} / ${stream}`;
  }
  function renderSummary() {
    const node = $d('dsh-summary');
    if (!node) return;
    const saved = snapshot && Object.hasOwn(snapshot.slots || {}, 'main');
    const client = snapshot?.client;
    const synced = client?.sync_needed === false || ['configured', 'ok'].includes(client?.status) && client?.sync_needed !== true;
    const syncState = client?.status === 'conflict' ? '磁盘冲突 · 同步停用'
      : client?.installed === false ? 'Harness 未安装'
      : client?.sync_needed === true || client?.status === 'out_of_sync' ? '待预览 / 待同步'
      : synced ? '磁盘配置已匹配' : '磁盘状态待核对';
    const last = snapshot?.observations?.last_request;
    const remoteChanged = dirty && observedRevision !== snapshot?.revision;
    node.innerHTML = `<div class="dsh-state"><span>已保存 · 服务端</span><b>${saved ? migrationRequired() ? 'v1 · 待迁移' : 'v2 路由配置' : '尚未配置'}</b><small>${escape(saved ? routeText('main', snapshot.slots.main) : '填写主路由后保存')}</small><small class="mono">revision ${escape(observedRevision ?? '—')}</small></div>
      <div class="dsh-state${dirty ? ' pending' : ''}"><span>编辑草稿</span><b>${dirty ? '未保存修改' : migrationRequired() ? 'v2 迁移待保存' : draft ? '与已保存一致' : '尚未读取'}</b><small>${escape(remoteChanged ? '另一窗口已更新服务端；本草稿仍保留原编辑版本。' : '自动刷新保留草稿；仅完整保存响应确认已保存。')}</small><small class="mono">编辑 revision ${escape(snapshot?.revision ?? '—')}</small></div>
      <div class="dsh-state"><span>同步 · 磁盘 profile</span><b>${escape(syncState)}</b><small>${escape(affectedSections(client).join('、') || '目录、默认值、策略按所有权分别同步')}</small><small>配置一致 ≠ 运行中会话已采纳</small></div>
      <div class="dsh-state"><span>运行时 · 只读观测</span><b>${last ? '最近请求已观测' : '尚无请求样本'}</b><small>${escape(last ? `${last.alias ?? '—'} → ${last.provider ?? '—'} / ${last.model ?? '—'} · ${last.outcome ?? last.status ?? '—'}` : '仅当前进程的最近请求，不代表完整历史')}</small><small>会话采纳未验证；不是连通性检测</small></div>`;
    const migration = $d('dsh-migration');
    if (migration) {
      migration.hidden = !migrationRequired();
      migration.textContent = 'v1 迁移说明：旧配置的全部候选路由（含 main）原样保留；旧空默认值迁移为「固定 main」，不是「继承父调用」。为避免无意降低能力，保留旧适配器的 image 与精确 reasoning 档位声明，尚未核对上游；容量仍留空，新路由不自动声明这些能力。保存才写入 v2，迁移前请核对声明、候选、默认方式与所有权。';
    }
  }
  function syncButtons() {
    const enabled = editable();
    if ($d('dsh-backend-upgrade')) $d('dsh-backend-upgrade').hidden = !snapshot || apiReady() || unsupported;
    for (const id of ['dsh-add', 'dsh-new-name', ...POLICY_IDS]) {
      const node = $d(id); if (node) node.disabled = !enabled;
    }
    if ($d('dsh-default-subagent')) $d('dsh-default-subagent').disabled = !enabled || draft?.subagents?.default?.mode !== 'slot';
    for (const container of ['dsh-main-slot', 'dsh-slots', 'dsh-candidates']) {
      if ($d(container)) for (const node of $d(container).querySelectorAll('input,select,button,textarea')) node.disabled = !enabled;
    }
    for (const id of ['dsh-add-custom-label', 'dsh-add-custom-label-button', 'dsh-default-task']) if ($d(id)) $d(id).disabled = !enabled;
    for (const button of document.querySelectorAll('.dsh-preset-buttons button')) button.disabled = !enabled;
    slotNames().forEach((name, index) => {
      const textarea = $d(`dsh-slot-${index}-reasoning-map`);
      if (textarea) textarea.disabled = !enabled || reasoningMode(draft.slots[name]) !== 'map';
    });
    $d('dsh-save').disabled = !enabled || !(dirty || migrationRequired()) || !!loadTask;
    $d('dsh-preview').disabled = !enabled || dirty || migrationRequired() || !!loadTask;
    const repairAvailable = snapshot?.client?.status === 'conflict' && snapshot?.client?.repair_available === true;
    $d('dsh-sync').disabled = !enabled || dirty || migrationRequired() || !!loadTask || snapshot?.client?.installed !== true || snapshot?.client?.status === 'conflict' && !repairAvailable;
    $d('dsh-reload').disabled = !!busy || !!loadTask || !connected();
    $d('dsh-save').textContent = busy === 'save' ? '保存中…' : migrationRequired() ? '保存并热生效 · 迁移 v2' : '保存并热生效';
    $d('dsh-preview').textContent = busy === 'preview' ? '预览中…' : '预览同步';
    $d('dsh-sync').textContent = busy === 'sync' ? '接入中…' : repairAvailable ? '重新接入 Harness' : '接入/同步 Harness';
    const note = $d('dsh-draft-note');
    if (note) note.textContent = configError ? `DSH 路由配置读取失败：${configError}。保存与同步已停用，草稿保留。`
      : snapshot && !apiReady() ? '后端待更新，请重启 MixRouter 加载新版子策略 API。此页只读，编辑草稿保留；不会向旧后端写入 v2。'
      : !connected() ? '控制台离线，草稿保留；恢复连接后再保存。'
      : dirty ? '有未保存修改。自动刷新不会覆盖草稿或推进编辑 revision；保存后，现有槽位的后续请求使用新路由。'
      : '草稿与服务端一致。现有路由的渠道、模型与上游模式无需重启；目录、能力、默认值与策略变更需先预览，再显式同步，重启 Harness 后新建会话。';
    renderSummary();
  }
  function renderClient() {
    const node = $d('dsh-client'), client = snapshot?.client;
    if (!client) { node.innerHTML = '<p class="hint">尚未读取客户端状态。</p>'; return; }
    const installation = client.installed === true ? '已安装' : client.installed === false ? '未安装（此页不自动安装）' : '未确认';
    const registered = client.provider_registered ?? client.routed;
    const registration = registered === true ? 'MixRouter provider 已登记' : registered === false ? 'MixRouter provider 尚未登记' : 'provider 登记未确认';
    const statuses = { conflict: '自有 profile 字段有冲突（同步已停用）', out_of_sync: '磁盘配置与已保存目录 / 策略有差异（provider 可已登记）', configured: '磁盘配置已匹配', ok: '磁盘配置已匹配', not_configured: '磁盘配置尚未接入路由' };
    const warnings = [...new Set([...arrayText(snapshot?.warnings), ...arrayText(client.warnings)])];
    node.innerHTML = `<dl class="config-facts">
      <div><dt>客户端</dt><dd>${escape(installation)}</dd></div>
      <div><dt>磁盘配置状态</dt><dd>${escape(statuses[client.status] || client.status || '未确认')}</dd></div>
      <div><dt>provider 登记</dt><dd>${escape(registration)}</dd></div>
      <div><dt>策略所有权（磁盘）</dt><dd>${escape(client.policy_owner || '未确认')}</dd></div>
      <div><dt>当前模型（磁盘）</dt><dd class="mono">${escape(client.model || '未配置')}</dd></div>
      <div><dt>配置文件</dt><dd class="mono">${escape(client.config_path || '未提供')}</dd></div>
      <div><dt>待同步字段</dt><dd class="mono">${escape(affectedSections(client).join('、') || '由同步预览核对')}</dd></div>
      <div><dt>会话</dt><dd>采纳未验证；同步后需重启 Harness 后新建会话</dd></div>
    </dl>${warnings.length ? `<ul class="dsh-warnings">${warnings.map(text => `<li>${escape(text)}</li>`).join('')}</ul>` : ''}`;
  }
  function observationRow(record) {
    if (!object(record)) return '';
    const effort = Object.hasOwn(record, 'effort') ? ` · effort=${String(record.effort)}` : '';
    return `<tr><td class="mono">${escape(record.ts ?? '—')}</td><td class="mono">${escape(record.alias ?? '—')}<small>slot ${escape(record.slot ?? '—')}</small></td><td>${escape(record.provider ?? '—')}<small class="mono">${escape(record.model ?? '—')}${escape(effort)}</small></td><td>${escape(record.outcome ?? '—')} · ${escape(record.status ?? '—')}<small>${escape(record.err_class || '—')}</small></td></tr>`;
  }
  function renderObservations() {
    const node = $d('dsh-observations'), observations = snapshot?.observations;
    if (!node) return;
    if (!object(observations) || observations.scope !== 'current_process_recent_requests') {
      node.innerHTML = '<p class="hint">当前进程最近请求：尚无可用样本。磁盘配置和保存结果都不是运行时采纳证明。</p>'; return;
    }
    const counts = ['sample_count', 'ok_count', 'error_count', 'cancelled_count'].map(key => Number.isSafeInteger(observations[key]) && observations[key] >= 0 ? observations[key] : '—');
    const recent = (Array.isArray(observations.recent) ? observations.recent : []).filter(object).slice(0, 5);
    const last = object(observations.last_request) ? observations.last_request : null;
    const rows = recent.length ? recent : last ? [last] : [];
    const slots = (Array.isArray(observations.by_slot) ? observations.by_slot : []).filter(object).slice(0, MAX_SLOTS);
    node.innerHTML = `<p class="hint">当前进程最近请求 · 样本 ${escape(counts[0])} · 成功 ${escape(counts[1])} · 错误 ${escape(counts[2])} · 取消 ${escape(counts[3])}。这是有界近期样本，不是全部历史；不含提示词、响应内容或密钥。</p>
      ${last ? `<p class="dsh-last-observation">最后观测：<b class="mono">${escape(last.alias ?? '—')}</b> → slot <span class="mono">${escape(last.slot ?? '—')}</span> → ${escape(last.provider ?? '—')} / <span class="mono">${escape(last.model ?? '—')}</span> · ${escape(last.outcome ?? '—')} / ${escape(last.status ?? '—')}${Object.hasOwn(last, 'effort') ? ` · effort=${escape(last.effort)}` : ''} · ${escape(last.ts ?? '—')}</p>` : '<p class="hint">尚无最后请求样本；运行时采纳未验证。</p>'}
      ${rows.length ? `<div class="dsh-table-wrap"><table class="dsh-table"><caption class="sr-only">当前进程最近请求</caption><thead><tr><th>时间</th><th>模型别名 / 槽</th><th>实际渠道 / 模型</th><th>结果 / 状态 / 错误类</th></tr></thead><tbody>${rows.map(observationRow).join('')}</tbody></table></div>` : ''}
      ${slots.length ? `<div class="dsh-observation-slots">${slots.map(row => `<span><b class="mono">${escape(row.slot ?? '—')}</b> ${escape(row.count ?? '—')} 次 · 成功 ${escape(row.ok_count ?? '—')} / 错误 ${escape(row.error_count ?? '—')} / 取消 ${escape(row.cancelled_count ?? '—')}</span>`).join('')}</div>` : ''}`;
  }
  function modelNames(slot) {
    const provider = providerById(slot.provider);
    return [...new Set([...(Array.isArray(provider?.models) ? provider.models : []), provider?.model].filter(m => typeof m === 'string' && m))];
  }
  function modelChoiceValue(slot) {
    if (!slot.model) return '';
    const index = modelNames(slot).indexOf(slot.model);
    return index < 0 ? 'custom' : String(index);
  }
  function modelOptionsHtml(slot) {
    const models = modelNames(slot), selected = modelChoiceValue(slot);
    return `<option value=""${selected === 'custom' ? ' disabled' : selected === '' ? ' selected' : ''}>${slot.provider ? '选择模型' : '先选择渠道'}</option>`
      + models.map((model, index) => `<option value="${index}"${String(index) === selected ? ' selected' : ''}>${escape(model)}</option>`).join('')
      + `<option value="custom"${selected === 'custom' ? ' selected' : ''}>自定义模型…</option>`;
  }
  function providerOptions(slot) {
    let choices = '<option value="">选择渠道</option>';
    if (slot.provider && !providerById(slot.provider)) choices += `<option value="${escape(slot.provider)}" disabled>${escape(slot.provider)}（渠道不可用）</option>`;
    return choices + providers().map(p => `<option value="${escape(p.id)}"${p.enabled === false ? ' disabled' : ''}>${escape(p.name || p.id)} · ${escape(p.wire_api)}${p.enabled === false ? '（已停用）' : ''}</option>`).join('');
  }
  function capOf(slot) { return object(slot.capabilities) ? slot.capabilities : {}; }
  function reasoningMode(slot) {
    const cap = capOf(slot);
    return !Object.hasOwn(cap, 'reasoning_efforts') ? '' : cap.reasoning_efforts === false ? 'false' : 'map';
  }
  function inputChoice(slot) {
    const input = capOf(slot).input;
    if (input === undefined) return '';
    if (Array.isArray(input) && input.length === 1 && input[0] === 'text') return 'text';
    if (Array.isArray(input) && input.length === 2 && input[0] === 'text' && input[1] === 'image') return 'text,image';
    return 'invalid';
  }
  function capabilityProblem(name, slot) {
    if (!Object.hasOwn(slot, 'capabilities')) return '';
    if (!object(slot.capabilities)) return `${name} 的 capabilities 需为声明对象。`;
    const cap = slot.capabilities;
    if (Object.keys(cap).some(key => !['context_window', 'max_tokens', 'input', 'reasoning_efforts'].includes(key))) return `${name} 的 capabilities 含未知字段。`;
    for (const key of ['context_window', 'max_tokens']) {
      if (Object.hasOwn(cap, key) && (!Number.isSafeInteger(cap[key]) || cap[key] <= 0)) return `${name} 的 ${key} 需为正安全整数；留空使用适配器默认值。`;
    }
    if (cap.context_window !== undefined && cap.max_tokens !== undefined && cap.max_tokens > cap.context_window) return `${name} 的 max_tokens 应小于或等于 context_window。`;
    if (inputChoice(slot) === 'invalid') return `${name} 的输入声明仅支持 text 或 text + image。`;
    if (Object.hasOwn(cap, 'reasoning_efforts') && cap.reasoning_efforts !== false) {
      const map = cap.reasoning_efforts;
      if (!object(map) || !Object.keys(map).length) return `${name} 的 reasoning map 需为非空 JSON 对象，并包含至少一个非 off 档位。`;
      for (const [level, wire] of Object.entries(map)) {
        if (!EFFORTS.includes(level) || !(level === 'off' && wire === null) && (typeof wire !== 'string' || !wire.trim() || wire.length > 128 || /[\x00-\x1f\x7f]/.test(wire))) return `${name} 的 reasoning map 仅接受 off/minimal/low/medium/high/xhigh/max 到有效 wire 字符串（最多 128 字符，无控制字符）；仅 off 可为 null。`;
      }
      if (!Object.keys(map).some(level => level !== 'off')) return `${name} 的 reasoning map 需包含至少一个非 off 档位。`;
    }
    return '';
  }
  function refreshCapabilities() {
    slotNames().forEach((name, index) => {
      const slot = draft.slots[name], cap = capOf(slot), id = 'dsh-slot-' + index;
      for (const field of ['context_window', 'max_tokens']) {
        setValue(`${id}-${field}`, cap[field] ?? '');
        const node = $d(`${id}-${field}`);
        if (node) node.setAttribute('aria-invalid', String(Object.hasOwn(cap, field) && (!Number.isSafeInteger(cap[field]) || cap[field] <= 0) || field === 'max_tokens' && cap.max_tokens > cap.context_window));
      }
      const choice = inputChoice(slot), input = $d(`${id}-input-capability`);
      if (input) {
        const options = '<option value="">未声明（适配器默认 text）</option><option value="text">明确声明 text</option><option value="text,image">明确声明 text + image</option>'
          + (choice === 'invalid' ? `<option value="invalid" disabled>无效草稿：${escape(JSON.stringify(cap.input))}</option>` : '');
        if (input.innerHTML !== options) input.innerHTML = options;
        input.value = choice; input.setAttribute('aria-invalid', String(choice === 'invalid'));
      }
      setValue(`${id}-reasoning-mode`, reasoningMode(slot));
      const map = cap.reasoning_efforts;
      const text = reasoningText.has(name) ? reasoningText.get(name) : typeof map === 'string' ? map : object(map) ? JSON.stringify(map, null, 2) : '';
      setValue(`${id}-reasoning-map`, text);
      const problem = capabilityProblem(name, slot), error = $d(`${id}-cap-error`);
      if (error) { error.textContent = problem; error.hidden = !problem; }
      const textarea = $d(`${id}-reasoning-map`);
      if (textarea) textarea.setAttribute('aria-invalid', String(!!problem && reasoningMode(slot) === 'map'));
      const summary = $d(`${id}-cap-summary`);
      if (summary) summary.textContent = `容量 / 输入 / 推理声明 · ${problem ? '有待修正' : Object.keys(cap).length ? '已声明（非探测）' : '未声明 · 适配器默认'}`;
    });
  }
  function policyProblem() {
    const policy = draft?.subagents;
    if (!object(policy) || !['mixrouter', 'harness'].includes(policy.owner)) return '请选择普通 spawn 策略所有权。';
    if (Object.keys(policy).some(key => !['owner', 'allow_model_selection', 'allowed_slots', 'default', 'max_depth', 'max_active'].includes(key))) return '普通 spawn 策略含未知字段。';
    if (typeof policy.allow_model_selection !== 'boolean') return '按次选模型开关需为布尔值。';
    if (!Array.isArray(policy.allowed_slots) || policy.allowed_slots.some(name => typeof name !== 'string' || !Object.hasOwn(draft.slots, name)) || new Set(policy.allowed_slots).size !== policy.allowed_slots.length) return '候选路由需唯一，且每项都引用当前目录中的槽。';
    const fallback = policy.default;
    if (!object(fallback) || !['slot', 'inherit'].includes(fallback.mode)) return '请选择固定路由或真正继承父调用。';
    if (Object.keys(fallback).some(key => !['mode', 'slot'].includes(key))) return '默认路由含未知字段。';
    if (fallback.mode === 'inherit' && Object.hasOwn(fallback, 'slot')) return '继承父调用时请移除固定槽位，不混用两种默认方式。';
    if (fallback.mode === 'slot' && (typeof fallback.slot !== 'string' || !Object.hasOwn(draft.slots, fallback.slot))) return '固定默认路由已删除或缺失，请选择现有路由，或显式选择继承父调用。';
    if (policy.allow_model_selection && !policy.allowed_slots.length) return '允许按次选模型时，请至少勾选一个候选路由；main 也需显式勾选。';
    if (policy.allow_model_selection && fallback.mode === 'slot' && !policy.allowed_slots.includes(fallback.slot)) return `固定默认 ${fallback.slot} 不在候选中；请显式勾选它，或更换默认方式。`;
    for (const [key, min] of [['max_depth', 0], ['max_active', 1]]) {
      if (Object.hasOwn(policy, key) && (!Number.isSafeInteger(policy[key]) || policy[key] < min || policy[key] > 64)) return `${key} 需为 ${min}–64 的安全整数；留空保留原设置。`;
    }
    return '';
  }
  function renderDefaults() {
    if (!draft) return;
    const select = $d('dsh-default-subagent'), names = configuredNames(), fallback = draft.subagents.default || {};
    const value = fallback.mode === 'slot' ? String(fallback.slot ?? '') : '';
    let options = '<option value="" disabled>请选择固定路由</option>';
    if (value && !names.includes(value)) options += `<option value="${escape(value)}" disabled>${escape(fallback.slot === 'main' ? '主模型' : draft.slots[value]?.label || value)}（已删除或配置不完整）</option>`;
    options += names.map(name => `<option value="${escape(name)}">${name === 'main' ? '主模型' : escape(draft.slots[name].label || name)}</option>`).join('');
    if (select) {
      if (select.innerHTML !== options) select.innerHTML = options;
      select.value = value;
    }
    setValue('dsh-default-mode', fallback.mode);
    const task = $d('dsh-default-task');
    if (task) {
      const options = `<option value="inherit">跟随当前对话</option>${value && !names.includes(value) ? `<option value="${escape(value)}" disabled>${escape(draft.slots[value]?.label || value)}（已删除或配置不完整）</option>` : ''}${names.map(name => `<option value="${escape(name)}">${escape(name === 'main' ? '主模型' : draft.slots[name].label || name)}</option>`).join('')}`;
      if (task.innerHTML !== options) task.innerHTML = options;
      task.value = fallback.mode === 'inherit' ? 'inherit' : value || 'main';
    }
  }
  function renderPolicy() {
    if (!draft) return;
    const policy = draft.subagents;
    setValue('dsh-policy-owner', policy.owner);
    $d('dsh-allow-model-selection').checked = policy.allow_model_selection === true;
    for (const [key, id] of [['max_depth', 'dsh-max-depth'], ['max_active', 'dsh-max-active']]) {
      setValue(id, policy[key] ?? '');
      $d(id).setAttribute('aria-invalid', String(Object.hasOwn(policy, key) && (!Number.isSafeInteger(policy[key]) || policy[key] < (key === 'max_depth' ? 0 : 1) || policy[key] > 64)));
    }
    slotNames().forEach((name, index) => {
      const input = $d(`dsh-slot-${index}-candidate`);
      if (input) input.checked = Array.isArray(policy.allowed_slots) && policy.allowed_slots.includes(name);
    });
    $d('dsh-owner-note').textContent = policy.owner === 'harness'
      ? 'Harness 拥有主模型与普通子任务设置。本页只同步 provider / 模型别名目录；下方策略作为保留选项，不应用到原生设置。释放托管策略时保留最后生效的原生选择，而不是恢复旧默认。'
      : 'MixRouter 管理主模型与普通 spawn 的默认路由、按次模型选择和显式限额。目录中的槽只是模型路由，不是带角色、指令或独立身份的智能体。';
    $d('dsh-selection-note').textContent = policy.allow_model_selection
      ? '允许普通 spawn 每次从勾选的路由中显式选择。候选名单与开关独立；默认固定槽也须属于候选。'
      : '关闭按次选模型，不关闭子任务。普通 spawn 使用固定默认或真正继承父调用；勾选的候选名单保留，重新打开时复用。';
    $d('dsh-default-note').textContent = policy.default?.mode === 'inherit'
      ? '真正继承：普通 spawn 的 agentOptions 省略 provider、model、reasoningEffort，跟随该次父调用；不是固定指向 main 别名。'
      : '固定路由：普通 spawn 使用所选 mixr-dsh-* 别名。固定 main 也不会跟随临时切换的父调用模型。';
    const problem = policyProblem(), error = $d('dsh-policy-error');
    error.textContent = problem; error.hidden = !problem;
    renderDefaults(); renderCoverage();
  }
  function renderCoverage() {
    const node = $d('dsh-coverage');
    if (!node) return;
    const policy = draft?.subagents, managed = policy?.owner === 'mixrouter';
    const rows = [
      ['主模型默认值', managed ? '同步 main 路由别名作为默认模型' : '由 Harness 原生设置管理', '不等于每个已存在会话已切换'],
      ['普通 spawn · 显式选择', managed ? policy.allow_model_selection ? '从独立勾选的候选名单中选择' : '按次选择关闭；子任务仍可运行' : '由 Harness 原生设置管理', '仅此入口受本页候选策略控制'],
      ['普通 spawn · 默认值', managed ? policy.default?.mode === 'inherit' ? '真正继承父调用；省略 provider / model / reasoningEffort' : `固定 ${policy.default?.slot ?? '待选择'}；保存时校验候选关系` : '由 Harness 原生设置管理', '固定默认校验不等于全局运行时白名单'],
      ['fork / Agent Teams', '隐式继承父模型', '不经过普通 spawn 的逐调用候选核验'],
      ['workflow', '独立模型与委派配置路径', '不由本页候选名单统一约束'],
      ['DS Bot / 原生 presets', '固定角色、指令与原生模型配置独立', '路由别名不是 Bot 身份；本页不是全局控制器'],
    ];
    node.innerHTML = `<p class="hint">以下按当前草稿解释同步后的覆盖；未保存选项尚未应用，磁盘事实与运行时观测另列。</p><div class="dsh-table-wrap"><table class="dsh-table"><thead><tr><th>入口</th><th>同步后预计覆盖</th><th>边界</th></tr></thead><tbody>${rows.map(row => `<tr>${row.map(text => `<td>${escape(text)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function refreshChoices() {
    slotNames().forEach((name, index) => {
      const slot = draft.slots[name], select = $d(`dsh-slot-${index}-provider`), modelSelect = $d(`dsh-slot-${index}-model-choice`);
      const options = providerOptions(slot), models = modelOptionsHtml(slot);
      if (select) { if (select.innerHTML !== options) select.innerHTML = options; select.value = slot.provider; }
      if (modelSelect) { if (modelSelect.innerHTML !== models) modelSelect.innerHTML = models; modelSelect.value = modelChoiceValue(slot); }
      setValue(`dsh-slot-${index}-model`, slot.model);
      const modelInput = $d(`dsh-slot-${index}-model`);
      if (modelInput) { modelInput.hidden = modelChoiceValue(slot) !== 'custom'; modelInput.placeholder = slot.provider ? '输入自定义模型名' : '先选择渠道'; }
      setValue(`dsh-slot-${index}-label`, slot.label ?? '');
      const labelInput = $d(`dsh-slot-${index}-label`);
      if (labelInput) labelInput.setAttribute('aria-invalid', String(typeof slot.label !== 'undefined' && (typeof slot.label !== 'string' || slot.label.trim().length > 24 || /[\x00-\x1f\x7f]/.test(slot.label))));
      setValue(`dsh-slot-${index}-stream`, typeof slot.upstream_stream === 'boolean' ? String(slot.upstream_stream) : 'inherit');
    });
    refreshCapabilities();
  }
  function restoreControls() {
    if (draft) { refreshChoices(); renderPolicy(); }
    syncButtons();
  }
  function renderSlot(name, index, open) {
    const slot = draft.slots[name], id = 'dsh-slot-' + index, arg = escape(JSON.stringify(name)), main = name === 'main';
    return `<div class="dsh-slot${main ? ' dsh-main-slot' : ' dsh-task-slot'}">
      <div class="dsh-slot-ident"><h3>${main ? '主模型' : escape(slot.label || name)}</h3>${!main ? `<label class="field dsh-task-label" for="${id}-label">任务类型<input type="text" id="${id}-label" maxlength="24" value="${escape(slot.label || '')}" placeholder="例如代码审查" oninput="dshSetSlot(${arg},'label',this.value)"></label>` : '<span class="mono">main · 主模型别名</span>'}</div>
      <label class="field" for="${id}-provider">渠道<select id="${id}-provider" onchange="dshSetSlot(${arg},'provider',this.value)">${providerOptions(slot)}</select></label>
      <label class="field" for="${id}-model-choice">模型<div class="dsh-model-picker"><select id="${id}-model-choice" aria-label="${escape(name)}模型" onchange="dshChooseModel(${arg},this.value)">${modelOptionsHtml(slot)}</select><input type="text" id="${id}-model" value="${escape(slot.model)}" placeholder="输入自定义模型名" spellcheck="false" oninput="dshSetSlot(${arg},'model',this.value)"${modelChoiceValue(slot) === 'custom' ? '' : ' hidden'}></div></label>
      <label class="dsh-inline-candidate" for="${id}-candidate"><input type="checkbox" id="${id}-candidate" onchange="dshToggleCandidate(${arg},this.checked)"><span>可供主智能体选用</span></label>
      <label class="field dsh-stream-field" for="${id}-stream">上游请求<select id="${id}-stream" onchange="dshSetSlot(${arg},'upstream_stream',this.value)"><option value="inherit">继承默认</option><option value="true">流式</option><option value="false">非流式</option></select></label>
      ${main ? '<span class="dsh-slot-fixed">主模型</span>' : `<button type="button" class="small danger dsh-slot-action" onclick="dshDeleteSlot(${arg})" aria-label="删除 ${escape(slot.label || name)}">删除</button>`}
      <details class="dsh-capabilities" id="${id}-cap-details"${open ? ' open' : ''}><summary id="${id}-cap-summary">能力与高级路由设置</summary><div class="dsh-cap-body">
        <p class="hint">以下是手工声明，不是能力探测。容量留空使用适配器默认 context_window 262144 / max_tokens 32768，不代表上游已验证容量；未声明图片或推理时，不会自动宣称具备这些能力。</p>
        <div class="dsh-cap-fields"><label class="field" for="${id}-context_window">上下文容量声明<input type="text" inputmode="numeric" id="${id}-context_window" placeholder="适配器默认 262144" oninput="dshSetCapability(${arg},'context_window',this.value)"></label>
        <label class="field" for="${id}-max_tokens">输出上限声明<input type="text" inputmode="numeric" id="${id}-max_tokens" placeholder="适配器默认 32768" oninput="dshSetCapability(${arg},'max_tokens',this.value)"></label>
        <label class="field" for="${id}-input-capability">输入能力声明<select id="${id}-input-capability" onchange="dshSetCapability(${arg},'input',this.value)"></select></label>
        <label class="field" for="${id}-reasoning-mode">推理能力声明<select id="${id}-reasoning-mode" onchange="dshSetCapability(${arg},'reasoning_mode',this.value)"><option value="">未声明推理能力</option><option value="false">明确声明不支持推理</option><option value="map">精确 reasoning map</option></select></label></div>
        <label class="field dsh-reasoning-map" for="${id}-reasoning-map">reasoning_efforts 精确映射（JSON）<textarea id="${id}-reasoning-map" rows="3" spellcheck="false" placeholder="{&quot;off&quot;:null,&quot;low&quot;:&quot;low&quot;,&quot;high&quot;:&quot;high&quot;}" oninput="dshSetCapability(${arg},'reasoning_efforts',this.value)"></textarea><small>只同步实际声明的档位与 wire 值，不扩展为全档位。off 可为 null；至少声明一个非 off 档位。</small></label>
        <p class="dsh-field-error" id="${id}-cap-error" role="status" hidden></p>
      </div></details>
    </div>`;
  }
  function renderSlots() {
    const opened = new Set(renderedNames.filter((name, index) => $d(`dsh-slot-${index}-cap-details`)?.open));
    const names = slotNames();
    const render = name => renderSlot(name, names.indexOf(name), opened.has(name));
    $d('dsh-main-slot').innerHTML = render('main');
    $d('dsh-slots').innerHTML = names.filter(name => name !== 'main').map(render).join('');
    renderedNames = names;
    refreshChoices(); renderPolicy();
    $d('dsh-editor').hidden = unsupported;
    syncButtons();
  }
  function touched() {
    editRevision += 1;
    dirty = JSON.stringify(draft) !== base;
    clearOutcome(); clearPreview();
    status(dirty ? '有未保存修改；当前选择尚未更新服务端路由。' : '已撤回未保存修改，草稿与已读取配置一致。');
    refreshCapabilities(); renderPolicy(); syncButtons();
  }
  function dshSetSlot(name, field, value) {
    if (!editable() || !Object.hasOwn(draft.slots, name)) { restoreControls(); return; }
    const slot = draft.slots[name];
    if (field === 'label') {
      const text = String(value);
      if (text.trim() || /[\x00-\x1f\x7f]/.test(text)) slot.label = text;
      else delete slot.label;
      const input = $d(`dsh-slot-${slotNames().indexOf(name)}-label`);
      if (input) input.setAttribute('aria-invalid', String(text.trim().length > 24 || /[\x00-\x1f\x7f]/.test(text)));
    } else if (field === 'upstream_stream') {
      if (value === 'inherit') delete slot.upstream_stream;
      else if (value === 'true' || value === true) slot.upstream_stream = true;
      else if (value === 'false' || value === false) slot.upstream_stream = false;
      else { restoreControls(); return; }
    } else if (field === 'provider') {
      const provider = providerById(value);
      if (value && (!provider || provider.enabled === false)) { restoreControls(); return; }
      slot.provider = value;
      refreshChoices();
    } else if (field === 'model') {
      slot.model = String(value);
      const index = slotNames().indexOf(name), modelSelect = $d(`dsh-slot-${index}-model-choice`);
      if (modelSelect) modelSelect.value = modelChoiceValue(slot);
      const modelInput = $d(`dsh-slot-${index}-model`);
      if (modelInput) modelInput.hidden = modelChoiceValue(slot) !== 'custom';
    } else { restoreControls(); return; }
    touched();
  }
  function dshChooseModel(name, value) {
    if (!editable() || !Object.hasOwn(draft.slots, name)) { restoreControls(); return; }
    const index = slotNames().indexOf(name), modelSelect = $d(`dsh-slot-${index}-model-choice`);
    if (value === 'custom') { if (modelSelect) modelSelect.value = 'custom'; const input = $d(`dsh-slot-${index}-model`); if (input) input.hidden = false; input?.focus(); input?.select(); return; }
    const selected = Number(value), models = modelNames(draft.slots[name]);
    if (value === '' || !Number.isInteger(selected) || selected < 0 || selected >= models.length) { restoreControls(); return; }
    draft.slots[name].model = models[selected];
    setValue(`dsh-slot-${index}-model`, models[selected]);
    if (modelSelect) modelSelect.value = String(selected);
    const input = $d(`dsh-slot-${index}-model`); if (input) input.hidden = true;
    touched();
  }
  function numberDraft(value) {
    const text = String(value).trim();
    return /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : String(value);
  }
  function dshSetDefault(value) {
    // Compatibility setter remains FIXED-slot selection. Legacy empty means fixed main,
    // never true inheritance; the independent mode control selects inheritance explicitly.
    const name = value === 'inherit' ? 'main' : value || 'main';
    if (!editable() || !configuredNames().includes(name)) { restoreControls(); return; }
    draft.subagents.default = { mode: 'slot', slot: name }; lastFixedDefault = name;
    touched();
  }
  function dshSetDefaultTask(value) {
    // The simple picker has an explicit inheritance option, unlike the legacy setter.
    if (value === 'inherit') dshSetPolicy('default_mode', 'inherit');
    else dshSetDefault(value);
  }
  function dshSetPolicy(field, value) {
    if (!editable()) { restoreControls(); return; }
    const policy = draft.subagents;
    if (field === 'owner') {
      if (!['mixrouter', 'harness'].includes(value)) { restoreControls(); return; }
      policy.owner = value;
    } else if (field === 'allow_model_selection') {
      if (![true, false, 'true', 'false'].includes(value)) { restoreControls(); return; }
      policy.allow_model_selection = value === true || value === 'true';
    } else if (field === 'default_mode' || field === 'default.mode') {
      if (value === 'inherit') { if (policy.default?.mode === 'slot') lastFixedDefault = policy.default.slot; policy.default = { mode: 'inherit' }; }
      else if (value === 'slot') policy.default = { mode: 'slot', slot: Object.hasOwn(draft.slots, lastFixedDefault) ? lastFixedDefault : 'main' };
      else { restoreControls(); return; }
    } else if (field === 'default_slot' || field === 'default.slot') { dshSetDefault(value); return; }
    else if (field === 'max_depth' || field === 'max_active') {
      if (String(value).trim() === '') delete policy[field];
      else policy[field] = numberDraft(value);
    } else { restoreControls(); return; }
    touched();
  }
  function dshToggleCandidate(name, checked) {
    if (!editable() || !Object.hasOwn(draft.slots, name) || typeof checked !== 'boolean') { restoreControls(); return; }
    const allowed = Array.isArray(draft.subagents.allowed_slots) ? draft.subagents.allowed_slots : [];
    draft.subagents.allowed_slots = checked ? allowed.includes(name) ? [...allowed] : [...allowed, name] : allowed.filter(slot => slot !== name);
    touched();
  }
  function dshSetCapability(name, field, value) {
    if (!editable() || !Object.hasOwn(draft.slots, name)) { restoreControls(); return; }
    const slot = draft.slots[name];
    if (!['context_window', 'max_tokens', 'input', 'reasoning_mode', 'reasoning_efforts'].includes(field)
      || field === 'reasoning_mode' && !['', 'false', 'map'].includes(value)) { restoreControls(); return; }
    if (!object(slot.capabilities)) slot.capabilities = {};
    const cap = slot.capabilities;
    if (field === 'context_window' || field === 'max_tokens') {
      if (String(value).trim() === '') delete cap[field]; else cap[field] = numberDraft(value);
    } else if (field === 'input') {
      if (value === '') delete cap.input;
      else cap.input = value === 'text' ? ['text'] : value === 'text,image' ? ['text', 'image'] : String(value);
    } else if (field === 'reasoning_mode') {
      if (!['', 'false', 'map'].includes(value)) { restoreControls(); return; }
      reasoningText.delete(name);
      if (value === '') delete cap.reasoning_efforts;
      else if (value === 'false') cap.reasoning_efforts = false;
      else if (!object(cap.reasoning_efforts)) cap.reasoning_efforts = {};
    } else {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      reasoningText.set(name, text);
      try { cap.reasoning_efforts = JSON.parse(text); }
      catch (_) { cap.reasoning_efforts = text; }
    }
    if (!Object.keys(cap).length) delete slot.capabilities;
    touched();
  }
  function uniqueTaskId(baseName) {
    if (!Object.hasOwn(draft.slots, baseName)) return baseName;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const name = `${baseName}-${suffix}`;
      if (!Object.hasOwn(draft.slots, name)) return name;
    }
    return '';
  }
  function addTask(baseName, label) {
    if (!editable()) { restoreControls(); return false; }
    if (Object.keys(draft.slots).length >= MAX_SLOTS) { notify('最多配置 32 个模型（含主模型）；请先删除一个任务。', 'err'); return false; }
    const name = uniqueTaskId(baseName);
    if (!name) return false;
    const main = draft.slots.main;
    const slot = slotValue(main);
    slot.label = String(label).trim();
    draft.slots[name] = slot;
    if (!draft.subagents.allowed_slots.includes(name)) draft.subagents.allowed_slots.push(name);
    touched(); renderSlots();
    $d(`dsh-slot-${slotNames().indexOf(name)}-label`)?.focus();
    return true;
  }
  function dshAddPreset(baseName) {
    const preset = TASK_PRESETS.find(([id]) => id === baseName);
    return preset ? addTask(preset[0], preset[1]) : false;
  }
  function dshAddCustomTask() {
    if (!editable()) { restoreControls(); return false; }
    const input = $d('dsh-add-custom-label'), text = String(input?.value || ''), label = text.trim();
    if (!label || label.length > 24 || /[\x00-\x1f\x7f]/.test(text)) { notify('自定义任务类型需为 1–24 字符且不含控制字符。', 'err'); return false; }
    const existing = Object.keys(draft?.slots || {}).filter(id => /^custom-\d+$/.test(id));
    let number = 1;
    while (existing.includes('custom-' + number)) number += 1;
    const name = 'custom-' + number;
    const result = addTask(name, label);
    if (result && input) input.value = '';
    return result;
  }
  function dshAddSlot() {
    if (!editable()) { restoreControls(); return false; }
    const input = $d('dsh-new-name'), name = input.value.trim();
    if (!NAME.test(name) || name === 'main' || RESERVED.includes(name)) { notify('路由槽名称需为 1–24 位小写字母、数字或连字符，且不可使用 main、constructor、prototype 等保留名称。', 'err'); return false; }
    if (Object.hasOwn(draft.slots, name)) { notify('此路由槽名称已存在。', 'err'); return false; }
    if (Object.keys(draft.slots).length >= MAX_SLOTS) { notify('最多配置 32 个槽位（含 main）；请先删除一个路由槽。', 'err'); return false; }
    draft.slots[name] = { provider: '', model: '' }; input.value = '';
    touched(); renderSlots();
    $d(`dsh-slot-${slotNames().indexOf(name)}-provider`)?.focus();
    return true;
  }
  async function dshDeleteSlot(name) {
    if (!editable() || name === 'main' || !Object.hasOwn(draft.slots, name)) return false;
    busy = 'confirm'; syncButtons();
    try {
      const isDefault = draft.subagents.default?.mode === 'slot' && draft.subagents.default.slot === name;
      const confirmed = await askConfirm('删除模型路由槽', `删除 ${name}（mixr-dsh-${name}）？本次只改草稿，保存后才更新目录；客户端别名与候选名单还需另行同步。${isDefault ? '\n此槽是固定默认路由，删除后须重新选择默认方式；不会静默改成继承父调用。' : ''}`, '删除路由');
      if (!confirmed || !connected()) return false;
      delete draft.slots[name]; reasoningText.delete(name);
      draft.subagents.allowed_slots = draft.subagents.allowed_slots.filter(slot => slot !== name);
      // Keep a removed fixed default visibly invalid until the user chooses another route
      // or true inheritance; deleting a catalog entry must not silently change policy.
      touched(); renderSlots(); $d('dsh-new-name')?.focus();
      return true;
    } finally { busy = ''; syncButtons(); }
  }
  function validate() {
    if (!draft || !Object.hasOwn(draft.slots, 'main')) return '主路由 main 不可缺失。';
    if (Object.keys(draft.slots).length > MAX_SLOTS) return '最多配置 32 个槽位（含 main）；请先删除多出的路由槽。';
    for (const [name, slot] of Object.entries(draft.slots)) {
      if (!NAME.test(name) || RESERVED.includes(name)) return `槽位名称 ${name} 不符合命名规则或为保留名称。`;
      if (Object.hasOwn(slot, 'label') && (typeof slot.label !== 'string' || slot.label.trim().length > 24 || /[\x00-\x1f\x7f]/.test(slot.label))) return `${name} 的任务类型需为最多 24 字符的文本，且不含控制字符。`;
      if (typeof slot.label === 'string' && !slot.label.trim()) delete slot.label;
      else if (typeof slot.label === 'string') slot.label = slot.label.trim();
      const provider = providerById(slot.provider);
      if (!provider || provider.enabled === false) return `${name} 需要选择已启用的 Chat Completions / Responses 渠道。`;
      if (!slot.model.trim()) return `${name} 需要填写模型名。`;
      if (slot.model.length > 256 || /[\x00-\x1f\x7f]/.test(slot.model)) return `${name} 的模型名最多 256 字符，且不含控制字符。`;
      const problem = capabilityProblem(name, slot); if (problem) return problem;
    }
    return policyProblem();
  }
  function adoptDraft(nextDraft) {
    draft = nextDraft; reasoningText.clear();
    lastFixedDefault = draft.subagents.default?.mode === 'slot' ? draft.subagents.default.slot : 'main';
  }
  function clientFingerprint(client) {
    return JSON.stringify([client?.status, client?.policy_owner, client?.sync_needed, client?.provider_registered, client?.config_path, client?.affected_sections, client?.model]);
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
        configError = next.error ? String(next.error) : '';
        if (configError) {
          if (snapshot) snapshot = { ...snapshot, api_version: next.api_version, client: next.client, observations: next.observations, warnings: next.warnings };
          else snapshot = next;
          clearPreview(); renderClient(); renderObservations();
          status(`DSH 路由配置读取失败：${configError}。保存与同步已停用，草稿仍保留。`, 'err');
          return false;
        }
        let nextDraft;
        try { nextDraft = draftOf(next); }
        catch (error) { configError = error.message; clearPreview(); throw error; }
        unsupported = false; $d('dsh-unsupported').hidden = true;
        // Read-only facts may refresh, but neither draft nor its expected revision may
        // advance beneath unsaved edits. Otherwise PUT would silently overwrite a newer version.
        const editing = dirty, revision = editing ? snapshot?.revision : next.revision;
        if (observedRevision !== next.revision || clientFingerprint(snapshot?.client) !== clientFingerprint(next.client)) clearPreview();
        observedRevision = next.revision;
        snapshot = { ...next, revision };
        renderClient(); renderObservations();
        if (!editing) {
          const changed = !draft || JSON.stringify(nextDraft) !== JSON.stringify(draft);
          if (changed) { clearOutcome(); clearPreview(); }
          adoptDraft(nextDraft);
          base = Object.hasOwn(next.slots, 'main') ? JSON.stringify(draft) : JSON.stringify({ ...draft, slots: {} });
          dirty = JSON.stringify(draft) !== base;
          if (changed) renderSlots(); else { refreshChoices(); renderPolicy(); }
        } else { refreshChoices(); renderPolicy(); }
        $d('dsh-editor').hidden = false;
        status(!apiReady() ? '后端待更新，请重启 MixRouter 加载新版子策略 API。当前页面只读，旧配置与草稿保留。' : editing ? '已更新磁盘状态与近期观测；未保存草稿保留，保存仍校验编辑前的配置版本。' : dirty ? '尚未配置主路由。请填写 main 的渠道与模型后保存草稿。' : migrationRequired() ? '已读取 v1：全部旧候选与固定默认已保留。核对后保存为 v2，再预览同步。' : '已读取配置。保存、磁盘同步与运行时观测是独立状态。');
        return true;
      } catch (error) { fail(error, '读取配置失败'); return false; }
      finally { loadTask = null; syncButtons(); }
    })();
    syncButtons(); return loadTask;
  }
  async function dshReload() {
    if (busy || loadTask || !connected()) return false;
    if (dirty) {
      busy = 'confirm'; syncButtons();
      let confirmed;
      try { confirmed = await askConfirm('放弃未保存草稿', '重新载入会丢弃此页全部未保存修改，读取服务端最新配置。', '放弃并重载'); }
      finally { busy = ''; syncButtons(); }
      if (!confirmed || !connected()) return false;
    }
    // Do not discard until the new snapshot has arrived successfully.
    const previous = { draft, base, dirty, snapshot, observedRevision, editRevision };
    dirty = false;
    const ok = await dshRefresh(true);
    if (!ok) {
      if (editRevision === previous.editRevision) ({ draft, base, dirty, snapshot, observedRevision } = previous);
      else {
        // Editing stays available during reads. Roll back the failed read's base,
        // not edits made against it while the request was in flight.
        base = previous.base; snapshot = previous.snapshot; observedRevision = previous.observedRevision;
        dirty = JSON.stringify(draft) !== base;
      }
      syncButtons();
    }
    return ok;
  }
  async function dshSave() {
    if (!draft || !apiReady() || !(dirty || migrationRequired()) || busy || loadTask || unsupported || configError || !connected()) return false;
    const problem = validate();
    if (problem) { notify(problem, 'err'); return false; }
    const migrating = migrationRequired();
    const payload = { version: 2, slots: copy(draft.slots), subagents: copy(draft.subagents), expected_revision: snapshot.revision };
    busy = 'save'; syncButtons();
    try {
      const result = await request('/api/dsh', { method: 'PUT', body: JSON.stringify(payload) });
      if (result.revision == null) throw new Error('保存响应未提供 revision，请重新读取核对');
      if (result.version !== 2 || result.ok === false || result.error || !object(result.slots) || !Object.hasOwn(result.slots, 'main')) throw new Error('保存响应未确认完整 v2 路由与策略，请重新读取核对');
      const savedDraft = draftOf(result);
      // The backend normalizes fields (including model.trim()). Only its saved
      // snapshot can acknowledge this draft; echoing the PUT would hide drift.
      snapshot = result; observedRevision = result.revision;
      adoptDraft(savedDraft); base = JSON.stringify(draft); dirty = false;
      clearPreview(); renderSlots(); renderClient(); renderObservations();
      const target = routeText('main', draft.slots.main);
      $d('dsh-outcome').hidden = false;
      $d('dsh-outcome').textContent = `路由已保存：${target}。现有槽位的渠道、模型与上游模式对后续请求生效，无需同步或重启；已发出的请求不变。仅新增或删除别名、客户端默认模型与白名单变更需另点「同步到 Harness」，能力声明与普通 spawn 策略也须先预览再同步，然后重启 Harness 后新建会话。${migrating ? 'v1 已迁移为 v2，候选与固定默认以服务端保存响应为准。' : ''}本次未安装或重启 Harness，也未同步客户端。运行时采纳仍未验证。`;
      notify(`路由已保存：${target}；现有槽位的后续请求生效。`);
      return true;
    } catch (error) { fail(error, error.status === 409 ? '配置版本冲突，请核对后重新载入再修改' : '保存草稿失败'); return false; }
    finally { busy = ''; syncButtons(); }
  }
  function coverageValue(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value ? '是' : '否';
    if (object(value) && typeof value.behavior === 'string') return value.behavior;
    return '由接口覆盖说明核对';
  }
  function modelFactText(value) {
    if (typeof value === 'string') return value || '未配置';
    if (!object(value)) return '未配置';
    const provider = typeof value.provider === 'string' ? value.provider : '';
    const model = typeof value.model === 'string' ? value.model : '';
    return [provider, model].filter(Boolean).join(' / ') || '未配置';
  }
  function renderPreview() {
    const panel = $d('dsh-preview-panel'), node = $d('dsh-preview-result');
    panel.hidden = !preview && !previewError;
    if (previewError) { node.textContent = previewError; return; }
    if (!preview) return;
    const sections = affectedSections(preview), released = arrayText(preview.released_sections);
    const changes = Array.isArray(preview.section_changes) ? preview.section_changes.filter(object).slice(0, 32) : [];
    const changeLabels = { route_catalog: '模型路由目录 / 能力声明', ownership: '策略所有权', main_default: '主模型默认值', ordinary_subagent_policy: '普通 spawn 策略 / 默认值 / 限额', native_handoff: '移交原生设置（保留最后有效值）' };
    const flags = object(preview.changes) ? Object.keys(changeLabels).filter(key => typeof preview.changes[key] === 'boolean') : [];
    const coverage = object(preview.coverage) ? preview.coverage : {};
    const covered = ['ordinary_spawn', 'ordinary_spawn_explicit_selection', 'defaults', 'implicit_inheritance', 'fork', 'team', 'teams', 'workflow', 'ds_bot', 'global_enforcement', 'global_whitelist', 'runtime_adoption'].filter(key => Object.hasOwn(coverage, key));
    node.innerHTML = `<dl class="config-facts"><div><dt>预览 revision</dt><dd class="mono">${escape(previewRevision)}</dd></div><div><dt>策略所有权</dt><dd>${escape(preview.policy_owner || draft.subagents.owner)}</dd></div><div><dt>客户端 / 磁盘状态</dt><dd>${preview.installed === true ? '已安装' : preview.installed === false ? '未安装' : '安装未确认'} · ${escape(preview.status || '未确认')}</dd></div><div><dt>磁盘变更</dt><dd>${preview.changed === true || preview.sync_needed === true ? '需要同步' : preview.changed === false || preview.sync_needed === false ? '已匹配 · 无需改写' : '由受影响字段核对'}</dd></div><div><dt>影响字段</dt><dd class="mono">${escape(sections.join('、') || '无变更字段')}</dd></div><div><dt>模型目录 / 所有权切换</dt><dd>${escape(preview.model_count ?? Object.keys(draft.slots).length)} 个别名 · ${preview.changes?.ownership === true || preview.ownership_transition === true ? '将切换（保留最后生效的原生选择）' : preview.changes?.ownership === false || preview.ownership_transition === false ? '无切换' : escape(typeof preview.ownership_transition === 'string' ? preview.ownership_transition : '由预览核对')}</dd></div></dl>
      ${preview.repair_mode === true ? `<p class="dsh-native-handoff">修复主模型：${escape(modelFactText(preview.main_before))} → ${escape(modelFactText(preview.main_after))}。确认同步前核对这些模型与备份路径。</p>` : ''}
      ${flags.length ? `<ul class="dsh-preview-changes">${flags.map(key => `<li>${escape(changeLabels[key])} · ${preview.changes[key] ? '将更新' : '保持不变'}</li>`).join('')}</ul>` : ''}
      ${released.length ? `<p class="dsh-native-handoff">移交 Harness 原生管理：<span class="mono">${escape(released.join('、'))}</span>。保留最后生效值；这些字段释放到托管区外，后续原生编辑独立生效。</p>` : ''}
      ${changes.length ? `<ul class="dsh-preview-changes">${changes.map(change => `<li><span class="mono">${escape(change.section ?? '—')}</span> · ${change.changed === true ? '将更新' : change.changed === false ? '保持一致' : '待核对'}</li>`).join('')}</ul>` : ''}
      ${covered.length ? `<dl class="dsh-preview-coverage">${covered.map(key => `<div><dt class="mono">${escape(key)}</dt><dd>${escape(coverageValue(coverage[key]))}</dd></div>`).join('')}</dl>` : ''}
      <p class="hint">只读预览，不写 profile，不包含密钥或完整 preset。候选策略不是全局白名单；fork / teams 隐式继承，workflow / DS Bot 独立。同步不会自动重启或热切换会话；重启 Harness 后新建会话，运行时采纳仍待观测。</p>
      ${arrayText(preview.warnings).length ? `<ul class="dsh-warnings">${arrayText(preview.warnings).map(text => `<li>${escape(text)}</li>`).join('')}</ul>` : ''}`;
  }
  async function fetchPreview(revision, repair = false) {
    clearPreview();
    const result = await request('/api/dsh/preview', { method: 'POST', body: JSON.stringify({ expected_revision: revision, ...(repair ? { repair: true } : {}) }) });
    if (result.ok === false || result.error || !object(result.preview) || result.revision == null) throw new Error('预览响应未提供 preview 与 revision，请重新读取核对');
    if (result.revision !== revision) { const error = new Error('预览 revision 与编辑版本不一致'); error.status = 409; throw error; }
    preview = copy(result.preview); previewRevision = result.revision;
    renderPreview(); return preview;
  }
  async function dshPreview() {
    if (!editable() || loadTask) return false;
    if (dirty || migrationRequired()) { notify('请先保存 v2 草稿，再预览已保存配置的同步影响。', 'warn'); return false; }
    const problem = validate(); if (problem) { notify(problem, 'err'); return false; }
    busy = 'preview'; syncButtons();
    try { await fetchPreview(snapshot.revision); notify('同步预览已读取；磁盘 profile 尚未改写。核对影响字段与覆盖边界后再同步。'); return true; }
    catch (error) {
      previewError = error.status === 404 ? '当前后端尚未提供同步预览接口；同步停在预览步骤，路由草稿仍可编辑与保存。' : `同步预览失败：${error.message}。磁盘 profile 未改写。`;
      renderPreview(); fail(error, error.status === 409 ? '预览版本冲突，请重新载入核对' : '读取同步预览失败', false); return false;
    } finally { busy = ''; syncButtons(); }
  }
  async function dshSync() {
    if (!draft || !apiReady() || busy || loadTask || unsupported || configError || !connected()) return false;
    if (dirty || migrationRequired()) { notify('请先保存 v2 草稿，再同步到 Harness。', 'warn'); return false; }
    if (snapshot.client?.installed !== true) { notify('尚未确认 Harness 已安装，同步已停用；此页不会自动安装。', 'warn'); return false; }
    const repair = snapshot.client?.status === 'conflict' && snapshot.client?.repair_available === true;
    if (snapshot.client?.status === 'conflict' && !repair) { notify('Harness profile 冲突暂无可用修复流程；路由草稿仍可保存。', 'warn'); return false; }
    const problem = validate(); if (problem) { notify(problem, 'err'); return false; }
    const revision = snapshot.revision;
    busy = 'preview'; syncButtons();
    let stage = 'preview';
    try {
      // Always refresh the read-only preview before confirmation. A native disk edit can
      // happen without changing the route revision; a cached preview alone is not approval.
      const checked = await fetchPreview(revision, repair);
      if (!connected()) return false;
      if (checked.status === 'conflict' && !repair || checked.installed === false) { notify('预览发现磁盘冲突或客户端未安装；profile 未改写，请核对预览。', 'warn'); return false; }
      if (repair && checked.repair_mode !== true) { notify('修复预览未确认 repair_mode；profile 未改写。', 'warn'); return false; }
      busy = 'confirm'; stage = 'confirm'; syncButtons();
      const sections = affectedSections(checked);
      const managed = (checked.policy_owner || draft.subagents.owner) === 'mixrouter';
      const released = arrayText(checked.released_sections);
      const repairDetails = repair ? `\n修复模式：${modelFactText(checked.main_before)} → ${modelFactText(checked.main_after)}。确认前将创建备份：${escape(String(checked.backup_path || checked.backup || '同步时生成并返回路径'))}。` : '';
      const message = `${repair ? '重新接入并修复已保存配置到' : '只同步已保存配置到'} Harness 的自有 profile 字段。\n影响字段：${sections.join('、') || '无变更字段'}。${repairDetails}${released.length ? '\n移交原生管理（保留最后有效值）：' + released.join('、') + '。' : ''}\n${managed ? '管理模型路由目录、主模型默认值与普通 spawn 策略。' : '仅同步 provider / 模型别名目录，Harness 保留主 / 子原生设置。'}\n候选名单不是全局白名单；fork / teams 隐式继承，workflow / DS Bot 独立。不会自动重启或热切换正在运行的会话。同步后请重启 Harness 后新建会话。${arrayText(checked.warnings).length ? '\n提示：' + arrayText(checked.warnings).join('\n') : ''}`;
      if (!await askConfirm('核对预览后同步到 DeepSeek Harness', message, '确认同步') || !connected()) return false;
      busy = 'sync'; stage = 'sync'; syncButtons();
      const result = await request('/api/dsh/sync', { method: 'POST', body: JSON.stringify({ confirm: true, expected_revision: revision, ...(repair ? { repair: true, expected_profile_revision: checked.profile_revision } : {}) }) });
      if (result.ok === false || result.error) throw new Error(result.error || '同步结果未确认成功');
      if (result.client) { snapshot.client = result.client; renderClient(); }
      if (result.revision != null) { snapshot.revision = result.revision; observedRevision = result.revision; }
      const warnings = [...new Set([...arrayText(checked.warnings), ...arrayText(result.warnings)])];
      const backup = typeof result.backup_path === 'string' ? result.backup_path : typeof result.client?.backup_path === 'string' ? result.client.backup_path : '';
      const messageOut = (result.changed === false ? 'Harness 磁盘配置已一致，本次未改写。' : `已同步 Harness 自有 profile 的${managed ? '模型路由目录与普通 spawn 策略' : '模型路由目录；主 / 子设置仍由 Harness 管理'}。`)
        + '请重启 Harness 后新建会话；正在运行的会话不会自动切换。运行时采纳未验证。' + (backup ? `\n备份：${backup}` : '') + (warnings.length ? '\n' + warnings.join('\n') : '');
      clearPreview(); $d('dsh-outcome').hidden = false; $d('dsh-outcome').textContent = messageOut;
      notify(messageOut, warnings.length ? 'warn' : ''); return true;
    } catch (error) {
      if (stage === 'preview') { previewError = `同步停在只读预览：${error.message}。profile 未改写。`; renderPreview(); }
      fail(error, error.status === 409 ? '同步版本冲突，请重新载入核对' : stage === 'preview' ? '读取同步预览失败' : '同步 Harness 失败', false); return false;
    } finally { busy = ''; syncButtons(); }
  }

  Object.assign(window, {
    dshRefresh, dshReload, dshSave, dshPreview, dshSync, dshAddSlot, dshAddPreset, dshAddCustomTask, dshDeleteSlot, dshSetSlot, dshChooseModel, dshSetDefault, dshSetDefaultTask,
    dshSetPolicy, dshToggleCandidate, dshSetCapability,
    dshUiState: () => ({ draft: draft ? copy(draft) : null, dirty, revision: snapshot?.revision, observed_revision: observedRevision, unsupported, configError, busy, preview: preview ? copy(preview) : null, preview_revision: previewRevision }),
  });
  // app.refresh() owns periodic updates; only the initially visible view reads on mount.
  function init() { if ($d('view-dsh')) dshRefresh(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
