'use strict';
// 模型与上下文(#insights)。与 app.js 共用同一个 realm(classic script,不是 ESM):
// 只声明本页自己的变量与函数,不重复声明 $ / esc / api / view / online。
//
// 只做三件事,都不改路由或客户端配置:
//   1) 显示本机渠道库的模型能力声明(没有声明就是未知,不按名字推断);
//   2) 显示上游响应自报的模型名(缺失就是未知,绝不用请求模型补位);
//   3) 显示最近内存请求的三列模型名、真实用量,以及只保存数字的上下文分类。
//
// 加载时机:进入本页或手动刷新。没有轮询,也没有后台请求;离开页面不保留定时器。
// 上下文统计的估算 token 是「非媒体字节 / 4」,不是官方 tokenizer,也不是实际用量。

const insightsState = {
  visible: false,
  models: null,
  modelsRevision: '',
  modelsLoaded: false,
  modelsLoading: false,
  modelsMessage: '尚未读取模型清单。',
  modelsKind: '',
  modelsSeq: 0,
  selectedModel: '',
  editingModel: false,
  savingModel: false,
  requests: null,
  requestsLoaded: false,
  requestsLoading: false,
  requestsMessage: '尚未读取请求。',
  requestsKind: '',
  requestsScope: null,
  requestsSeq: 0,
  selectedRequest: '',
};

// 后端 CONTEXT_FIELDS 的展示顺序与中文名。只映射固定字段,不猜 skill / 文件归属。
const INSIGHTS_CONTEXT_FIELDS = [
  ['system_bytes', '系统与指令', 'system / developer 消息与 instructions'],
  ['tools_bytes', '工具声明', '工具、函数与 MCP 的 schema/描述'],
  ['tool_results_bytes', '工具输出', '工具/函数返回的文本'],
  ['conversation_bytes', '对话文本', '其余消息与输入文本'],
  ['media_bytes', '媒体载荷', '图片、音频、文件等，不计入文本估算'],
  ['other_bytes', '信封与未知字段', '参数、JSON 结构与未归类字段'],
];

function insightsEl(id) {
  try { return document.getElementById(id); } catch { return null; }
}

// 与 app.js 的 esc 同一套转义;用前缀名避免在共享 realm 里重复声明全局 esc。
function insightsEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function insightsOnline() {
  try { return typeof online === 'undefined' ? true : !!online; } catch { return true; }
}

function insightsAppLabel(app) {
  if (app === 'claude') return 'Claude';
  if (app === 'codex') return 'Codex';
  return app ? String(app) : '—';
}

function insightsWhen(value) {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = typeof value === 'number' || /^\d{10,}$/.test(String(value)) ? Number(value) : value;
  const date = new Date(numeric);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function insightsCount(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}

function insightsBytes(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return Math.round(n) + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function insightsStatusClass(status) {
  if (status === null || status === undefined || status === '') return '';
  const n = Number(status);
  if (!Number.isFinite(n)) return '';
  if (n >= 200 && n < 300) return 'st2';
  if (n >= 500 || n === 0) return 'st5';
  if (n >= 400) return 'st4';
  return '';
}

function insightsStatusText(status) {
  return status === null || status === undefined || status === '' ? '—' : String(status);
}

// ---------------------------------------------------------------- 模型能力

function insightsModelKey(entry) {
  return [entry?.app, entry?.provider, entry?.model].map(value => String(value ?? '')).join('\u0000');
}

function insightsCapability(entry, field) {
  const cap = entry && entry.capabilities && typeof entry.capabilities === 'object'
    ? entry.capabilities[field] : null;
  const value = cap && Object.hasOwn(cap, 'value') ? cap.value : null;
  return { value, source: cap && cap.source === 'manual' ? 'manual' : 'unknown' };
}

function insightsSourceBadge(source) {
  return source === 'manual' ? ' <span class="badge info">手动</span>' : '';
}

function insightsCapCell(entry, field) {
  const { value, source } = insightsCapability(entry, field);
  const badge = insightsSourceBadge(source);
  if (field === 'context_window' || field === 'max_output_tokens') {
    if (value === null || value === undefined || value === '') return '<span class="insights-unknown">未知</span>';
    const n = Number(value);
    if (!Number.isFinite(n)) return '<span class="insights-unknown">未知</span>';
    return `<span class="insights-value">${insightsCount(n)}</span>${badge}`;
  }
  if (field === 'vision') {
    if (value === true) return `支持${badge}`;
    if (value === false) return `不支持${badge}`;
    return '<span class="insights-unknown">未知</span>';
  }
  const levels = Array.isArray(value) ? value.filter(level => typeof level === 'string' && level) : [];
  if (!levels.length) return '<span class="insights-unknown">未知</span>';
  return `${insightsEsc(levels.join(', '))}${badge}`;
}

function insightsObservationHtml(observation) {
  if (!observation || typeof observation !== 'object') {
    return '<span class="insights-unknown">暂无成功请求的观察</span>';
  }
  const upstream = observation.upstream_model
    ? insightsEsc(observation.upstream_model)
    : '<span class="insights-unknown">未知</span>';
  return `<span class="insights-obs-main">自报 ${upstream}</span>`
    + `<span class="insights-sub">发出 ${insightsEsc(observation.requested_model || '—')}`
    + ` · 状态 ${insightsEsc(insightsStatusText(observation.status))}`
    + ` · ${insightsEsc(insightsWhen(observation.ts))}</span>`;
}

function insightsModelRow(entry, index) {
  const provider = entry.provider_name || entry.provider || '—';
  const providerTitle = entry.provider && entry.provider_name && entry.provider_name !== entry.provider
    ? ` title="渠道 ID：${insightsEsc(entry.provider)}"` : '';
  return `<tr>
    <td>${insightsEsc(insightsAppLabel(entry.app))}</td>
    <td${providerTitle}>${insightsEsc(provider)}</td>
    <td><span class="insights-model-name">${insightsEsc(entry.model || '—')}</span></td>
    <td>${insightsCapCell(entry, 'context_window')}</td>
    <td>${insightsCapCell(entry, 'max_output_tokens')}</td>
    <td>${insightsCapCell(entry, 'vision')}</td>
    <td>${insightsCapCell(entry, 'reasoning_levels')}</td>
    <td>${insightsObservationHtml(entry.observation)}</td>
    <td><button class="small" type="button" onclick="insightsSelectModel(${index})">详情</button></td>
  </tr>`;
}

function insightsSelectedModel() {
  if (!insightsState.selectedModel || !Array.isArray(insightsState.models)) return null;
  return insightsState.models.find(entry => insightsModelKey(entry) === insightsState.selectedModel) || null;
}

function insightsModelDetail(entry) {
  const observation = entry.observation && typeof entry.observation === 'object' ? entry.observation : null;
  const observationHtml = observation
    ? `<p class="hint">最近一次成功请求的上游自报：发出 <span class="mono">${insightsEsc(observation.requested_model || '—')}</span>
        → 自报 <span class="mono">${insightsEsc(observation.upstream_model || '未知')}</span>
        （状态 ${insightsEsc(insightsStatusText(observation.status))}，${insightsEsc(insightsWhen(observation.ts))}）。
        这是响应里的 model 字段，不是身份认证；名称不同也可能只是别名规范化。</p>`
    : '<p class="hint">还没有可用于观察的成功请求。失败请求不会成为成功模型的证据；旧日志缺少 upstream_model 时也不会用请求模型补造。</p>';
  return `<div class="insights-detail-head"><h3>${insightsEsc(entry.model || '—')}</h3>
      <button class="small" type="button" onclick="insightsCloseModel()">关闭</button></div>
    <dl class="config-facts">
      <div><dt>协议组</dt><dd>${insightsEsc(insightsAppLabel(entry.app))}</dd></div>
      <div><dt>渠道</dt><dd>${insightsEsc(entry.provider_name || entry.provider || '—')}</dd></div>
      <div><dt>上下文窗口</dt><dd>${insightsCapCell(entry, 'context_window')}</dd></div>
      <div><dt>最大输出 tokens</dt><dd>${insightsCapCell(entry, 'max_output_tokens')}</dd></div>
      <div><dt>视觉</dt><dd>${insightsCapCell(entry, 'vision')}</dd></div>
      <div><dt>推理档位</dt><dd>${insightsCapCell(entry, 'reasoning_levels')}</dd></div>
    </dl>
    ${observationHtml}
    <div class="savebar"><button class="small" type="button" onclick="insightsEditModel()">编辑能力</button>
      <span class="hint">只保存本页的诊断元数据；不改变请求参数、路由、窗口或客户端配置。</span></div>`;
}

function insightsCapInputValue(entry, field) {
  const { value } = insightsCapability(entry, field);
  if (field === 'vision') return value === true ? 'true' : value === false ? 'false' : '';
  if (field === 'reasoning_levels') return Array.isArray(value) ? value.join(', ') : '';
  return value === null || value === undefined ? '' : String(value);
}

function insightsCapForm(entry) {
  const vision = insightsCapInputValue(entry, 'vision');
  const visionOption = (value, label) => `<option value="${value}"${vision === value ? ' selected' : ''}>${label}</option>`;
  return `<div class="insights-detail-head"><h3>编辑能力：${insightsEsc(entry.model || '—')}</h3>
      <button class="small" type="button" onclick="insightsCancelEdit()">取消</button></div>
    <form id="insights-cap-form" onsubmit="event.preventDefault();insightsSaveModel()">
      <div class="insights-cap-grid">
        <label class="field" for="insights-cap-context">上下文窗口 tokens
          <input id="insights-cap-context" type="text" inputmode="numeric" value="${insightsEsc(insightsCapInputValue(entry, 'context_window'))}" placeholder="留空表示未知" autocomplete="off" spellcheck="false"></label>
        <label class="field" for="insights-cap-maxout">最大输出 tokens
          <input id="insights-cap-maxout" type="text" inputmode="numeric" value="${insightsEsc(insightsCapInputValue(entry, 'max_output_tokens'))}" placeholder="留空表示未知" autocomplete="off" spellcheck="false"></label>
        <label class="field" for="insights-cap-vision">视觉能力
          <select id="insights-cap-vision">${visionOption('', '未知')}${visionOption('true', '支持')}${visionOption('false', '不支持')}</select></label>
        <label class="field" for="insights-cap-reasoning">推理档位（逗号分隔）
          <input id="insights-cap-reasoning" type="text" value="${insightsEsc(insightsCapInputValue(entry, 'reasoning_levels'))}" placeholder="如 low, medium, high；留空未知" autocomplete="off" spellcheck="false"></label>
      </div>
      <div class="savebar">
        <button class="primary" type="submit" id="insights-cap-save"${insightsState.savingModel ? ' disabled' : ''}>保存能力声明</button>
        <button class="small" type="button" onclick="insightsCancelEdit()">取消</button>
        <span class="hint" id="insights-cap-status" role="status" aria-live="polite">仅用于显示与诊断；留空即清除该字段的声明。</span>
      </div>
    </form>`;
}

function insightsRenderModelDetail() {
  const box = insightsEl('insights-model-detail');
  if (!box) return;
  const entry = insightsSelectedModel();
  if (!entry) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = insightsState.editingModel ? insightsCapForm(entry) : insightsModelDetail(entry);
}

function insightsUpdateControls() {
  const busy = insightsState.modelsLoading || insightsState.savingModel;
  for (const id of ['insights-refresh-models', 'insights-cap-save', 'insights-cap-context',
    'insights-cap-maxout', 'insights-cap-vision', 'insights-cap-reasoning']) {
    const node = insightsEl(id);
    if (node) node.disabled = busy || !insightsOnline();
  }
  const requests = insightsEl('insights-refresh-requests');
  if (requests) requests.disabled = insightsState.requestsLoading || !insightsOnline();
}

function insightsRenderModels() {
  const status = insightsEl('insights-models-status');
  if (status) {
    status.textContent = insightsState.modelsMessage;
    status.className = 'cfg-panel-hint' + (insightsState.modelsKind ? ' insights-' + insightsState.modelsKind : '');
  }
  const models = Array.isArray(insightsState.models) ? insightsState.models : [];
  const rows = insightsEl('insights-models-rows');
  if (rows) rows.innerHTML = models.map((entry, index) => insightsModelRow(entry, index)).join('');
  const table = insightsEl('insights-models-table');
  if (table) table.hidden = !models.length;
  const empty = insightsEl('insights-models-empty');
  if (empty) empty.hidden = !(insightsState.modelsLoaded && !models.length);
  insightsRenderModelDetail();
  insightsUpdateControls();
}

function insightsAcceptModels(next) {
  if (!next || typeof next !== 'object' || !Array.isArray(next.models) || next.revision === undefined || next.revision === null
      || next.models.some(entry => !entry || typeof entry !== 'object')) {
    throw new Error('模型数据不完整');
  }
  insightsState.models = next.models;
  insightsState.modelsRevision = String(next.revision);
  insightsState.modelsLoaded = true;
  if (insightsState.selectedModel && !insightsSelectedModel()) {
    insightsState.selectedModel = '';
    insightsState.editingModel = false;
  }
}

function insightsSetCapStatus(message, kind = '') {
  const node = insightsEl('insights-cap-status');
  if (!node) return;
  node.textContent = message;
  node.className = 'hint' + (kind ? ' insights-' + kind : '');
}

function insightsParseCapForm() {
  const raw = id => String(insightsEl(id)?.value ?? '').trim();
  const numberOrNull = (value, label) => {
    if (value === '') return null;
    if (!/^\d+$/.test(value)) throw new Error(`${label}必须是正整数，留空表示未知`);
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1 || n > 100000000) throw new Error(`${label}超出范围（1–100000000）`);
    return n;
  };
  const visionRaw = raw('insights-cap-vision');
  const vision = visionRaw === 'true' ? true : visionRaw === 'false' ? false : null;
  let reasoning = null;
  const reasoningRaw = raw('insights-cap-reasoning');
  if (reasoningRaw) {
    const levels = [...new Set(reasoningRaw.split(/[,，\s]+/).filter(Boolean))];
    if (levels.length > 12) throw new Error('推理档位最多 12 个');
    if (levels.some(level => level.length > 32)) throw new Error('推理档位名称最长 32 个字符');
    reasoning = levels;
  }
  return {
    context_window: numberOrNull(raw('insights-cap-context'), '上下文窗口'),
    max_output_tokens: numberOrNull(raw('insights-cap-maxout'), '最大输出'),
    vision,
    reasoning_levels: reasoning,
  };
}

function insightsFormDirty(entry) {
  if (!insightsState.editingModel || !entry) return false;
  let spec;
  try { spec = insightsParseCapForm(); } catch { return true; }
  const cap = field => insightsCapability(entry, field).value;
  const levels = value => Array.isArray(value) ? value : null;
  return (cap('context_window') ?? null) !== spec.context_window
    || (cap('max_output_tokens') ?? null) !== spec.max_output_tokens
    || (cap('vision') ?? null) !== spec.vision
    || JSON.stringify(levels(cap('reasoning_levels'))) !== JSON.stringify(spec.reasoning_levels);
}

async function insightsLoadModels(manual = false) {
  if (!insightsState.visible || insightsState.modelsLoading || insightsState.savingModel) return;
  if (!insightsOnline()) {
    insightsState.modelsMessage = '控制台离线：未读取模型清单。恢复连接后可手动刷新。';
    insightsState.modelsKind = 'error';
    insightsRenderModels();
    return;
  }
  if (manual && insightsState.editingModel && insightsFormDirty(insightsSelectedModel())) {
    if (typeof askConfirm !== 'function') return;
    const discard = await askConfirm('重新读取模型能力', '未保存的能力编辑会被丢弃，是否继续？', '放弃编辑并读取');
    if (!discard) return;
    insightsState.editingModel = false;
  }
  const seq = ++insightsState.modelsSeq;
  insightsState.modelsLoading = true;
  insightsState.modelsMessage = '正在读取模型清单…';
  insightsState.modelsKind = '';
  insightsRenderModels();
  try {
    const next = await api('/api/insights/models');
    if (seq !== insightsState.modelsSeq) return;
    insightsAcceptModels(next);
    insightsState.modelsMessage = `已读取 ${insightsState.models.length} 个登记模型；能力声明只用于显示。`;
    insightsState.modelsKind = '';
  } catch (e) {
    if (seq !== insightsState.modelsSeq) return;
    insightsState.modelsMessage = `读取失败：${e.message}` + (insightsState.modelsLoaded ? '（保留上次结果）' : '');
    insightsState.modelsKind = 'error';
  } finally {
    if (seq === insightsState.modelsSeq) {
      insightsState.modelsLoading = false;
      insightsRenderModels();
    }
  }
}

function insightsSelectModel(index) {
  if (insightsState.modelsLoading || insightsState.savingModel) return;
  const entry = Array.isArray(insightsState.models) ? insightsState.models[index] : null;
  if (!entry) return;
  insightsState.selectedModel = insightsModelKey(entry);
  insightsState.editingModel = false;
  insightsRenderModelDetail();
}

function insightsCloseModel() {
  if (insightsState.savingModel) return;
  insightsState.selectedModel = '';
  insightsState.editingModel = false;
  insightsRenderModelDetail();
}

function insightsEditModel() {
  if (!insightsSelectedModel() || insightsState.modelsLoading || insightsState.savingModel || !insightsOnline()) return;
  insightsState.editingModel = true;
  insightsRenderModelDetail();
  insightsUpdateControls();
  const input = insightsEl('insights-cap-context');
  if (input && typeof input.focus === 'function') input.focus();
}

function insightsCancelEdit() {
  if (insightsState.savingModel) return;
  insightsState.editingModel = false;
  insightsRenderModelDetail();
}

async function insightsSaveModel() {
  const entry = insightsSelectedModel();
  if (!entry || insightsState.savingModel || insightsState.modelsLoading) return;
  if (!insightsOnline()) {
    insightsSetCapStatus('控制台离线：能力声明未保存。', 'error');
    return;
  }
  if (!insightsState.modelsRevision) {
    insightsSetCapStatus('尚未读取模型清单，无法保存。', 'error');
    return;
  }
  let spec;
  try { spec = insightsParseCapForm(); } catch (e) {
    insightsSetCapStatus(e.message, 'error');
    return;
  }
  insightsState.savingModel = true;
  insightsSetCapStatus('正在保存…');
  insightsUpdateControls();
  try {
    const next = await api('/api/insights/models', { method: 'PUT', body: JSON.stringify({
      app: entry.app,
      provider: entry.provider,
      model: entry.model,
      expected_revision: insightsState.modelsRevision,
      spec,
    }) });
    insightsAcceptModels(next);
    insightsState.editingModel = false;
    insightsState.modelsMessage = '能力声明已保存；只影响本页显示，不改变真实路由、窗口或客户端配置。';
    insightsState.modelsKind = 'ok';
    insightsRenderModels();
  } catch (e) {
    if (e.status === 409) {
      insightsSetCapStatus('保存冲突：模型声明已被其他改动更新。编辑内容仍在，请重新读取后再改。', 'error');
    } else {
      insightsSetCapStatus(`保存失败：${e.message}`, 'error');
    }
  } finally {
    insightsState.savingModel = false;
    insightsUpdateControls();
  }
}

// ---------------------------------------------------------------- 最近请求

function insightsAcceptRequests(next) {
  if (!next || typeof next !== 'object' || !Array.isArray(next.requests)
      || next.requests.some(row => !row || typeof row !== 'object')) {
    throw new Error('请求数据不完整');
  }
  insightsState.requests = next.requests;
  insightsState.requestsScope = next.scope && typeof next.scope === 'object' ? next.scope : null;
  insightsState.requestsLoaded = true;
  if (insightsState.selectedRequest && !insightsSelectedRequest()) insightsState.selectedRequest = '';
}

function insightsRequestRow(request, index) {
  const context = request.context && typeof request.context === 'object' ? request.context : null;
  const contextCell = context
    ? `<span class="insights-value mono">${insightsBytes(context.serialized_bytes)}</span> <button class="small" type="button" onclick="insightsSelectRequest(${index})">查看</button>`
    : '<span class="insights-unknown" title="旧记录或未进入转发阶段，没有上下文统计">未采集</span>';
  const upstream = request.upstream_model
    ? `<span class="mono">${insightsEsc(request.upstream_model)}</span>`
    : '<span class="insights-unknown" title="未观察到上游模型字段；也可能超出采样范围或无法解析">未知</span>';
  const session = request.session
    ? `<span class="insights-sub insights-session" title="${insightsEsc(request.session)}">${insightsEsc(request.session)}</span>`
    : '<span class="insights-sub">—</span>';
  return `<tr>
    <td><span class="insights-time">${insightsEsc(insightsWhen(request.ts))}</span>${session}</td>
    <td class="insights-app">${insightsEsc(insightsAppLabel(request.app))}</td>
    <td>${insightsEsc(request.provider || '—')}</td>
    <td><span class="mono">${insightsEsc(request.model_in || '—')}</span></td>
    <td><span class="mono">${insightsEsc(request.model_out || '—')}</span></td>
    <td>${upstream}</td>
    <td class="num ${request.ok === false ? 'st5' : insightsStatusClass(request.status)}">${insightsEsc(insightsStatusText(request.status))}${request.ok === false ? '<span class="insights-sub">失败 / 中断</span>' : ''}</td>
    <td class="num"><span class="insights-tok-main">${insightsCount(request.in)} / ${insightsCount(request.out)}</span><span class="insights-sub">缓存读 ${insightsCount(request.cache_read)}</span></td>
    <td class="num">${contextCell}<span class="insights-sub">请求体 ${insightsBytes(request.bytes_in)}</span></td>
  </tr>`;
}

function insightsSelectedRequest() {
  const requests = Array.isArray(insightsState.requests) ? insightsState.requests : [];
  const key = insightsState.selectedRequest;
  if (!key) return null;
  if (key.startsWith('idx:')) {
    const index = Number(key.slice(4));
    return Number.isInteger(index) && index >= 0 && index < requests.length ? requests[index] : null;
  }
  return requests.find(row => String(row.request_id ?? '') === key) || null;
}

function insightsContextRows(context, withNotes) {
  return INSIGHTS_CONTEXT_FIELDS.map(([field, label, note]) => `<tr>
      <td>${label}${withNotes ? `<span class="insights-sub">${note}</span>` : ''}</td>
      <td class="num">${insightsBytes(context[field])}</td>
    </tr>`).join('');
}

function insightsRenderRequestDetail() {
  const box = insightsEl('insights-request-detail');
  if (!box) return;
  const request = insightsSelectedRequest();
  if (!request) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  const context = request.context && typeof request.context === 'object' ? request.context : null;
  const actual = `实际用量来自上游回报：输入 ${insightsCount(request.in)} / 输出 ${insightsCount(request.out)} / 缓存读 ${insightsCount(request.cache_read)}；与下面的字节和估算无关。`;
  let body;
  if (!context) {
    body = '<p class="hint">该记录没有上下文统计（旧记录、未采集，或请求未进入转发阶段）。这不是 0 字节。</p>';
  } else {
    body = `<div class="table-wrap insights-ctx-wrap"><table>
        <caption class="sr-only">请求上下文分类字节</caption>
        <thead><tr><th scope="col">分类</th><th scope="col" class="num">字节</th></tr></thead>
        <tbody>${insightsContextRows(context, true)}
          <tr class="insights-total"><td>合计（序列化请求体）</td><td class="num">${insightsBytes(context.serialized_bytes)}</td></tr>
        </tbody></table></div>
      <p class="hint">估算文本 tokens：<b>${insightsCount(context.estimated_text_tokens)}</b>。
        这是按非媒体字节 ÷ 4 的粗略估算，不是官方 tokenizer，也不是实际用量；媒体载荷不计入。
        分类只按请求结构统计，无法识别具体 skill、文件或工具名；六类字节相加等于序列化请求体，但不等于原始 HTTP 的 bytes_in。</p>`;
  }
  const facts = [
    ['请求 id', request.request_id || '—'],
    ['时间', insightsWhen(request.ts)],
    ['协议组', insightsAppLabel(request.app)],
    ['渠道', request.provider || '—'],
    ['会话', request.session || '—'],
    ['状态', insightsStatusText(request.status)],
  ].map(([label, value]) => `<div><dt>${label}</dt><dd>${insightsEsc(value)}</dd></div>`).join('');
  box.innerHTML = `<div class="insights-detail-head"><h3>请求上下文</h3>
      <button class="small" type="button" onclick="insightsCloseRequest()">关闭</button></div>
    <dl class="config-facts">${facts}</dl>
    <p class="hint">${insightsEsc(actual)}</p>
    ${body}`;
}

function insightsRenderContextSummary() {
  const box = insightsEl('insights-context-summary');
  if (!box) return;
  const requests = Array.isArray(insightsState.requests) ? insightsState.requests : [];
  const covered = requests.filter(row => row.context && typeof row.context === 'object');
  if (!covered.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const sum = field => covered.reduce((total, row) => {
    const n = Number(row.context[field]);
    return total + (Number.isFinite(n) ? n : 0);
  }, 0);
  const tokens = covered.reduce((total, row) => {
    const n = Number(row.context.estimated_text_tokens);
    return total + (Number.isFinite(n) ? n : 0);
  }, 0);
  box.hidden = false;
  box.innerHTML = `<p class="hint">本页已加载 ${requests.length} 条请求，其中 ${covered.length} 条带上下文统计。以下是这些记录的字节合计，只覆盖当前内存窗口，不是完整历史，也不是计费。</p>
    <div class="table-wrap insights-ctx-wrap"><table>
      <caption class="sr-only">本页已加载请求的上下文分类合计</caption>
      <thead><tr><th scope="col">分类</th><th scope="col" class="num">字节合计</th></tr></thead>
      <tbody>${INSIGHTS_CONTEXT_FIELDS.map(([field, label]) => `<tr><td>${label}</td><td class="num">${insightsBytes(sum(field))}</td></tr>`).join('')}
        <tr class="insights-total"><td>序列化请求体合计</td><td class="num">${insightsBytes(sum('serialized_bytes'))}</td></tr>
        <tr class="insights-total"><td>估算文本 tokens（非媒体字节 ÷ 4）</td><td class="num"><b>${insightsCount(tokens)}</b></td></tr>
      </tbody></table></div>`;
}

function insightsRenderRequests() {
  const status = insightsEl('insights-requests-status');
  if (status) {
    status.textContent = insightsState.requestsMessage;
    status.className = 'cfg-panel-hint' + (insightsState.requestsKind ? ' insights-' + insightsState.requestsKind : '');
  }
  const scope = insightsState.requestsScope;
  const scopeNode = insightsEl('insights-requests-scope');
  if (scopeNode) {
    const source = scope && scope.source === 'memory' ? '当前进程内存' : (scope && scope.source ? String(scope.source) : '当前进程内存');
    const capacity = scope && Number.isFinite(Number(scope.capacity)) ? `（容量 ${Number(scope.capacity)} 条）` : '';
    scopeNode.textContent = `来源：${source}${capacity}，默认读取最近 100 条，不是完整历史，也不读取上游账单。`
      + '三列模型名分别表示：客户端请求的模型、本次发给上游的模型、上游响应自报的模型；缺失一律显示未知。';
  }
  const requests = Array.isArray(insightsState.requests) ? insightsState.requests : [];
  const rows = insightsEl('insights-requests-rows');
  if (rows) rows.innerHTML = requests.map((request, index) => insightsRequestRow(request, index)).join('');
  const table = insightsEl('insights-requests-table');
  if (table) table.hidden = !requests.length;
  const empty = insightsEl('insights-requests-empty');
  if (empty) empty.hidden = !(insightsState.requestsLoaded && !requests.length);
  const button = insightsEl('insights-refresh-requests');
  if (button) button.disabled = insightsState.requestsLoading || !insightsOnline();
  insightsRenderContextSummary();
  insightsRenderRequestDetail();
}

async function insightsLoadRequests(manual = false) {
  if (!insightsState.visible || insightsState.requestsLoading) return;
  if (!insightsOnline()) {
    insightsState.requestsMessage = '控制台离线：未读取请求。恢复连接后可手动刷新。';
    insightsState.requestsKind = 'error';
    insightsRenderRequests();
    return;
  }
  const seq = ++insightsState.requestsSeq;
  insightsState.requestsLoading = true;
  insightsState.requestsMessage = '正在读取最近请求…';
  insightsState.requestsKind = '';
  insightsRenderRequests();
  try {
    const next = await api('/api/insights/requests?limit=100');
    if (seq !== insightsState.requestsSeq) return;
    insightsAcceptRequests(next);
    insightsState.requestsMessage = `已读取 ${insightsState.requests.length} 条内存请求。`;
    insightsState.requestsKind = '';
  } catch (e) {
    if (seq !== insightsState.requestsSeq) return;
    insightsState.requestsMessage = `读取失败：${e.message}` + (insightsState.requestsLoaded ? '（保留上次结果）' : '');
    insightsState.requestsKind = 'error';
  } finally {
    if (seq === insightsState.requestsSeq) {
      insightsState.requestsLoading = false;
      insightsRenderRequests();
    }
  }
}

function insightsSelectRequest(index) {
  const request = Array.isArray(insightsState.requests) ? insightsState.requests[index] : null;
  if (!request) return;
  insightsState.selectedRequest = request.request_id !== undefined && request.request_id !== null && request.request_id !== ''
    ? String(request.request_id)
    : 'idx:' + index;
  insightsRenderRequestDetail();
}

function insightsCloseRequest() {
  insightsState.selectedRequest = '';
  insightsRenderRequestDetail();
}

// ---------------------------------------------------------------- 生命周期

function insightsRenderAll() {
  insightsRenderModels();
  insightsRenderRequests();
}

function insightsSetVisible(on) {
  insightsState.visible = !!on;
  if (!insightsState.visible) return;
  // 只在进入本页时补一次初始读取;之后的刷新都走两个手动按钮,不建定时器。
  if (!insightsState.modelsLoaded && !insightsState.modelsLoading) insightsLoadModels(false);
  if (!insightsState.requestsLoaded && !insightsState.requestsLoading) insightsLoadRequests(false);
}

if (typeof document !== 'undefined') insightsRenderAll();
