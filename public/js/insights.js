'use strict';
// 模型与上下文(#insights)。与 app.js 共用同一个 realm(classic script,不是 ESM):
// 只声明本页自己的变量与函数,不重复声明 $ / esc / api / view / online 和 app.js 的 fmt* 格式函数。
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

// 与用量页、诊断页同一套叫法:按协议标注(Anthropic / OpenAI),不按客户端名。
function insightsAppLabel(app) {
  if (app === 'claude') return 'Anthropic';
  if (app === 'codex') return 'OpenAI';
  return app ? String(app) : '—';
}

// 数字与时间的显示格式全部用 app.js 的全站格式函数(fmtTok / fmtCount / fmtBytes / fmtWhen /
// fmtFullTime):同一个数在用量、诊断和本页长得一样。本页只包一层 title。
// 表格里的时间点缩写显示,完整时间进 title;详情面板直接写 fmtFullTime。
function insightsWhenHtml(value) {
  const full = fmtFullTime(value);
  return `<span class="insights-time"${full === '—' ? '' : ` title="${full}"`}>${fmtWhen(value)}</span>`;
}

// 表格里的 token 数:缩写显示,完整千分位进 title(小于 1000 本来就是完整数字,不加)。
function insightsTokHtml(value) {
  const n = finiteOrNull(value);
  const title = n !== null && Math.abs(n) >= 1000 ? ` title="${fmtCount(n)}"` : '';
  return `<span class="insights-value"${title}>${fmtTok(value)}</span>`;
}

// 缺失值统一显示「—」,原因写进 title(未登记 / 没观察到 / 未采集),不和 0 混在一起。
function insightsUnknown(title) {
  return `<span class="insights-unknown" title="${insightsEsc(title)}">—</span>`;
}

// api() 直接抛浏览器原文(Failed to fetch / AbortError);换成能看懂的原因。
function insightsErrorText(e) {
  if (e && e.name === 'AbortError') return '请求超时';
  if (e && e.name === 'TypeError') return '连不上本机服务';
  return e && e.message ? e.message : '未知错误';
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

// 状态给人话(成功 / 中断 / 失败),HTTP 状态码作次级信息。ok === false 而状态码是 2xx 时是
// 「中断」:响应已经开始,后面失败或被掐断(日志带 err),不能按 200 显示成成功。
function insightsStatus(request) {
  const raw = request ? request.status : null;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  const code = Number.isFinite(n) && n > 0 ? String(n) : '';
  if (request.ok === false && n >= 200 && n < 400) {
    return { label: '中断', code, cls: 'st5', title: `HTTP ${n}，但请求失败或中断（日志记有错误）` };
  }
  if (n >= 200 && n < 400) return { label: '成功', code, cls: insightsStatusClass(n), title: `HTTP ${n}` };
  return { label: '失败', code, cls: n === 0 ? 'st5' : insightsStatusClass(n) || 'st5', title: code ? `HTTP ${code}` : '没有拿到上游响应' };
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
  return source === 'manual' ? ' <span class="badge info insights-src" title="手工登记的能力声明">手动</span>' : '';
}

// full = 详情面板:数字写完整千分位;表格里缩写成 K/M,完整数字进 title。
function insightsCapCell(entry, field, full = false) {
  const { value, source } = insightsCapability(entry, field);
  const badge = insightsSourceBadge(source);
  const unknown = insightsUnknown('未知：没有登记，不按模型名推断');
  if (field === 'context_window' || field === 'max_output_tokens') {
    if (value === null || value === undefined || value === '') return unknown;
    const n = Number(value);
    if (!Number.isFinite(n)) return unknown;
    return `${full ? `<span class="insights-value">${fmtCount(n)}</span>` : insightsTokHtml(n)}${badge}`;
  }
  if (field === 'vision') {
    if (value === true) return `<span class="badge info insights-cap">支持</span>${badge}`;
    if (value === false) return `<span class="badge off insights-cap">不支持</span>${badge}`;
    return unknown;
  }
  const levels = Array.isArray(value) ? value.filter(level => typeof level === 'string' && level) : [];
  if (!levels.length) return unknown;
  return `<span class="insights-levels">${insightsEsc(levels.join(', '))}</span>${badge}`;
}

// 观察只来自成功请求,状态码一律 2xx,不再单列;只给「发出 → 自报」与时间。
function insightsObservationHtml(observation) {
  if (!observation || typeof observation !== 'object') {
    return insightsUnknown('暂无成功请求的观察');
  }
  const upstream = observation.upstream_model
    ? insightsEsc(observation.upstream_model)
    : insightsUnknown('未知：响应里没有 model 字段');
  return `<span class="insights-obs-main">自报 ${upstream}</span>`
    + `<span class="insights-sub">发出 ${insightsEsc(observation.requested_model || '—')} · ${insightsWhenHtml(observation.ts)}</span>`;
}

const INSIGHTS_CAP_FIELDS = ['context_window', 'max_output_tokens', 'vision', 'reasoning_levels'];
// 表头随布局变:full = 四个能力列 + 上游自报;compact = 一个也没登记时,四列全是「—」没有信息量,
// 折成一列「能力」。协议组与渠道不再每行重复,改成分组行(见 insightsRenderModels)。
const INSIGHTS_MODEL_HEAD = {
  full: ['<th scope="col" class="ins-model">模型</th>', '<th scope="col" class="num">上下文窗口</th>',
    '<th scope="col" class="num">最大输出</th>', '<th scope="col">视觉</th>', '<th scope="col">推理档位</th>',
    '<th scope="col">最近上游自报</th>', '<th scope="col" class="ins-act"><span class="sr-only">操作</span></th>'],
  compact: ['<th scope="col" class="ins-model">模型</th>',
    '<th scope="col" title="上下文窗口、最大输出、视觉、推理档位;没有登记就是未知,不按模型名推断">能力</th>',
    '<th scope="col" class="ins-act"><span class="sr-only">操作</span></th>'],
};

function insightsHasCapability(entry) {
  return INSIGHTS_CAP_FIELDS.some(field => {
    const { value } = insightsCapability(entry, field);
    return value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && !value.length);
  });
}

function insightsModelRow(entry, index, layout) {
  const name = `<td class="ins-model"><span class="insights-model-name">${insightsEsc(entry.model || '—')}</span></td>`;
  if (layout === 'compact') {
    // 没登记时操作直接是「登记」,打开编辑表单;有上游自报就跟在「未登记」下面,没有就只在 title 里说。
    const obs = entry.observation && typeof entry.observation === 'object' ? insightsObservationHtml(entry.observation) : '';
    const title = obs ? '没有登记上下文窗口、最大输出、视觉与推理档位' : '没有登记上下文窗口、最大输出、视觉与推理档位;也还没有成功请求的上游自报';
    return `<tr>${name}
    <td><span class="insights-unknown insights-unreg" title="${title}">未登记</span>${obs}</td>
    <td class="ins-act"><button class="small quiet" type="button" onclick="insightsSelectModel(${index});insightsEditModel()">登记</button></td>
  </tr>`;
  }
  return `<tr>${name}
    <td class="num">${insightsCapCell(entry, 'context_window')}</td>
    <td class="num">${insightsCapCell(entry, 'max_output_tokens')}</td>
    <td>${insightsCapCell(entry, 'vision')}</td>
    <td>${insightsCapCell(entry, 'reasoning_levels')}</td>
    <td>${insightsObservationHtml(entry.observation)}</td>
    <td class="ins-act"><button class="small quiet" type="button" onclick="insightsSelectModel(${index})">详情</button></td>
  </tr>`;
}

// 按渠道分组(协议组 + 渠道 id),组内保持后端给的顺序;组头写渠道名、协议组与模型数。
function insightsModelGroups(models) {
  const groups = new Map();
  models.forEach((entry, index) => {
    const key = `${entry.app ?? ''}\u0000${entry.provider ?? ''}`;
    if (!groups.has(key)) groups.set(key, { entry, rows: [] });
    groups.get(key).rows.push(index);
  });
  return [...groups.values()];
}

function insightsGroupRow(entry, count, span) {
  const name = entry.provider_name || entry.provider || '—';
  const title = entry.provider && entry.provider_name && entry.provider_name !== entry.provider
    ? ` title="渠道 ID：${insightsEsc(entry.provider)}"` : '';
  return `<tr class="insights-group"><th scope="colgroup" colspan="${span}"><span class="insights-group-label">`
    + `<span class="insights-group-name"${title}>${insightsEsc(name)}</span>`
    + `<span class="insights-group-meta">${insightsEsc(insightsAppLabel(entry.app))} · ${count} 个模型</span></span></th></tr>`;
}

function insightsSelectedModel() {
  if (!insightsState.selectedModel || !Array.isArray(insightsState.models)) return null;
  return insightsState.models.find(entry => insightsModelKey(entry) === insightsState.selectedModel) || null;
}

function insightsModelDetail(entry) {
  const observation = entry.observation && typeof entry.observation === 'object' ? entry.observation : null;
  const mono = value => (value ? `<span class="mono">${insightsEsc(value)}</span>` : '—');
  const observed = observation ? [
    ['最近发出', mono(observation.requested_model)],
    ['上游自报', observation.upstream_model ? mono(observation.upstream_model) : insightsUnknown('未知：响应里没有 model 字段')],
    ['观察时间', insightsEsc(fmtFullTime(observation.ts))],
  ].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('') : '';
  const observationHint = observation
    ? '<p class="hint">上游自报取自响应里的 model 字段，不是身份认证；与发出的名称不同也可能只是别名规范化。</p>'
    : '<p class="hint">还没有可用于观察的成功请求。失败请求不会成为成功模型的证据；旧日志缺少 upstream_model 时也不会用请求模型补造。</p>';
  return `<div class="insights-detail-head"><h3>${insightsEsc(entry.model || '—')}</h3>
      <button class="small" type="button" onclick="insightsCloseModel()">关闭</button></div>
    <dl class="config-facts">
      <div><dt>协议组</dt><dd>${insightsEsc(insightsAppLabel(entry.app))}</dd></div>
      <div><dt>渠道</dt><dd>${insightsEsc(entry.provider_name || entry.provider || '—')}</dd></div>
      <div><dt>上下文窗口</dt><dd>${insightsCapCell(entry, 'context_window', true)}</dd></div>
      <div><dt>最大输出 tokens</dt><dd>${insightsCapCell(entry, 'max_output_tokens', true)}</dd></div>
      <div><dt>视觉</dt><dd>${insightsCapCell(entry, 'vision', true)}</dd></div>
      <div><dt>推理档位</dt><dd>${insightsCapCell(entry, 'reasoning_levels', true)}</dd></div>
      ${observed}
    </dl>
    ${observationHint}
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

function insightsEnsureModelGrid() {
  let grid = insightsEl('insights-models-grid');
  if (grid || !document.createElement) return grid;
  const table = insightsEl('insights-models-table');
  if (!table || !table.parentNode) return null;
  grid = document.createElement('div');
  grid.id = 'insights-models-grid';
  grid.className = 'insights-model-grid';
  table.parentNode.insertBefore(grid, table);
  return grid;
}
function insightsModelCard(group, models) {
  const entry = group.entry;
  const name = entry.provider_name || entry.provider || '—';
  const rows = group.rows.map(index => {
    const model = models[index];
    const observation = model.observation && typeof model.observation === 'object' ? model.observation : null;
    const observed = observation && observation.upstream_model
      ? `<span class="insights-sub" title="上游响应自报,不是身份认证">自报 ${insightsEsc(observation.upstream_model)}</span>` : '';
    return `<li><span class="ins-model"><span class="insights-model-name" title="${insightsEsc(model.model || '—')}">${insightsEsc(model.model || '—')}</span>${observed}</span>`
      + `<button class="small quiet" type="button" title="未登记;登记能力只影响本页显示,不改路由或客户端配置" onclick="insightsSelectModel(${index});insightsEditModel()">登记</button></li>`;
  }).join('');
  return `<section class="insights-model-card"><div class="insights-model-card-head"><span class="insights-group-name" title="渠道 ID：${insightsEsc(entry.provider || '—')}">${insightsEsc(name)}</span>`
    + `<span class="insights-group-meta">${insightsEsc(insightsAppLabel(entry.app))} · ${fmtCount(group.rows.length)} 个模型</span></div>`
    + `<p class="insights-unregistered" title="上下文窗口、最大输出、视觉与推理档位均未登记;没有登记就是未知,不按模型名推断">能力未登记</p><ul>${rows}</ul></section>`;
}
function insightsRenderModels() {
  const status = insightsEl('insights-models-status');
  if (status) {
    status.textContent = insightsState.modelsMessage;
    status.className = 'cfg-panel-hint' + (insightsState.modelsKind ? ' insights-' + insightsState.modelsKind : '');
  }
  const models = Array.isArray(insightsState.models) ? insightsState.models : [];
  const layout = models.some(insightsHasCapability) ? 'full' : 'compact';
  const head = INSIGHTS_MODEL_HEAD[layout];
  const groups = insightsModelGroups(models);
  const grid = insightsEnsureModelGrid();
  const useGrid = !!(grid && layout === 'compact' && models.length);
  if (grid) {
    grid.hidden = !useGrid;
    if (useGrid) grid.innerHTML = groups.map(group => insightsModelCard(group, models)).join('');
  }
  const rows = insightsEl('insights-models-rows');
  if (rows) {
    rows.innerHTML = useGrid ? '' : groups.map(group => insightsGroupRow(group.entry, group.rows.length, head.length)
      + group.rows.map(index => insightsModelRow(models[index], index, layout)).join('')).join('');
  }
  const table = insightsEl('insights-models-table');
  if (table) {
    table.hidden = !models.length || useGrid;
    if (table.setAttribute) table.setAttribute('data-layout', layout);
    const thead = table.querySelector ? table.querySelector('thead') : null;
    if (thead) thead.innerHTML = `<tr>${head.join('')}</tr>`;
  }
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
    insightsState.modelsMessage = `已读取 ${insightsState.models.length} 个登记模型。`;
    insightsState.modelsKind = '';
  } catch (e) {
    if (seq !== insightsState.modelsSeq) return;
    insightsState.modelsMessage = `读取失败：${insightsErrorText(e)}` + (insightsState.modelsLoaded ? '（保留上次结果）' : '') + '。可点「刷新模型」重试。';
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
    insightsState.modelsMessage = '能力声明已保存（只影响本页显示，不改路由与客户端配置）。';
    insightsState.modelsKind = 'ok';
    insightsRenderModels();
  } catch (e) {
    if (e.status === 409) {
      insightsSetCapStatus('保存冲突：模型声明已被其他改动更新。编辑内容仍在，请重新读取后再改。', 'error');
    } else {
      insightsSetCapStatus(`保存失败：${insightsErrorText(e)}`, 'error');
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
    ? `<span class="insights-value mono">${fmtBytes(context.serialized_bytes)}</span> <button class="small quiet" type="button" onclick="insightsSelectRequest(${index})">查看</button>`
    : insightsUnknown('未采集：旧记录或未进入转发阶段，没有上下文统计（不是 0 字节）');
  const upstream = request.upstream_model
    ? `<span class="mono">${insightsEsc(request.upstream_model)}</span>`
    : insightsUnknown('未知：未观察到上游模型字段；也可能超出采样范围或无法解析');
  const session = request.session
    ? `<span class="insights-sub insights-session" title="${insightsEsc(request.session)}">${insightsEsc(request.session)}</span>`
    : '<span class="insights-sub">—</span>';
  const status = insightsStatus(request);
  // 成功行的状态码不再单列(在 title 里);失败/中断才把状态码作为次级小字露出来。
  const statusCell = status
    ? `<span class="insights-code" title="${insightsEsc(status.title)}">${status.label}</span>${status.code && status.label !== '成功' ? `<span class="insights-sub mono">${status.code}</span>` : ''}`
    : '—';
  return `<tr>
    <td>${insightsWhenHtml(request.ts)}${session}</td>
    <td class="insights-app">${insightsEsc(insightsAppLabel(request.app))}</td>
    <td>${insightsEsc(request.provider || '—')}<span class="insights-sub insights-app-sub">${insightsEsc(insightsAppLabel(request.app))}</span></td>
    <td><span class="mono">${insightsEsc(request.model_in || '—')}</span></td>
    <td><span class="mono">${insightsEsc(request.model_out || '—')}</span></td>
    <td>${upstream}</td>
    <td class="num ${status ? status.cls : ''}">${statusCell}</td>
    <td class="num"><span class="insights-tok-main">${insightsTokHtml(request.in)} / ${insightsTokHtml(request.out)}</span><span class="insights-sub">缓存读 ${insightsTokHtml(request.cache_read)}</span></td>
    <td class="num">${contextCell}<span class="insights-sub">请求体 ${fmtBytes(request.bytes_in)}</span></td>
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
      <td class="num">${fmtBytes(context[field])}</td>
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
  const actual = `实际用量来自上游回报：输入 ${fmtCount(request.in)} / 输出 ${fmtCount(request.out)} / 缓存读 ${fmtCount(request.cache_read)}；与下面的字节和估算无关。`;
  let body;
  if (!context) {
    body = '<p class="hint">该记录没有上下文统计（旧记录、未采集，或请求未进入转发阶段）。这不是 0 字节。</p>';
  } else {
    body = `<div class="table-wrap insights-ctx-wrap"><table>
        <caption class="sr-only">请求上下文分类字节</caption>
        <thead><tr><th scope="col">分类</th><th scope="col" class="num">字节</th></tr></thead>
        <tbody>${insightsContextRows(context, true)}
          <tr class="insights-total"><td>合计（序列化请求体）</td><td class="num">${fmtBytes(context.serialized_bytes)}</td></tr>
        </tbody></table></div>
      <p class="hint">估算文本 tokens：<b>${fmtCount(context.estimated_text_tokens)}</b>。
        这是按非媒体字节 ÷ 4 的粗略估算，不是官方 tokenizer，也不是实际用量；媒体载荷不计入。
        分类只按请求结构统计，无法识别具体 skill、文件或工具名；六类字节相加等于序列化请求体，但不等于原始 HTTP 的 bytes_in。</p>`;
  }
  const status = insightsStatus(request);
  const facts = [
    ['请求 id', insightsEsc(request.request_id || '—')],
    ['时间', insightsEsc(fmtFullTime(request.ts))],
    ['协议组', insightsEsc(insightsAppLabel(request.app))],
    ['渠道', insightsEsc(request.provider || '—')],
    ['会话', insightsEsc(request.session || '—')],
    ['状态', status ? `${status.label}${status.code ? `<span class="mono insights-code-raw">HTTP ${status.code}</span>` : ''}` : '—'],
  ].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
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
  // 分类合计排成一排紧凑小指标:六个分类在前,两个合计在后。说明放进 title,不占版面。
  const tile = (label, value, extra = '', note = '') => `<div${extra}><dt>${label}</dt><dd>${value}</dd>${note ? `<dd class="insights-sub">${note}</dd>` : ''}</div>`;
  box.innerHTML = `<p class="hint">已加载 ${requests.length} 条请求，其中 ${covered.length} 条带上下文统计；下面是这 ${covered.length} 条的字节合计，不是完整历史，也不是计费。</p>
    <dl class="insights-ctx-tiles">
      ${INSIGHTS_CONTEXT_FIELDS.map(([field, label, note]) => tile(label, fmtBytes(sum(field)), ` title="${insightsEsc(note)}"`)).join('')}
      ${tile('序列化请求体合计', fmtBytes(sum('serialized_bytes')), ' class="is-total"')}
      ${tile('估算文本 tokens', insightsTokHtml(tokens), ' class="is-total"', '非媒体字节 ÷ 4，不是实际用量')}
    </dl>`;
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
    // 三列模型名各自的含义写在表头 title 里;这里只说范围。
    scopeNode.textContent = `来源：${source}${capacity}，读取最近 100 条；不是完整历史，也不读取上游账单。`;
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
    insightsState.requestsMessage = `读取失败：${insightsErrorText(e)}` + (insightsState.requestsLoaded ? '（保留上次结果）' : '') + '。可点「刷新请求」重试。';
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
