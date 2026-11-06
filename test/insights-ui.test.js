'use strict';
// 模型与上下文(#insights)的定向回归:只跑真实 public/js/insights.js,配最小的 DOM/api 边界。
// 不联网、不读真实渠道或日志。
//
// 钉住几件会静默骗人的事:
//   · 上游自报缺失时显示「—」(title 写明未知),绝不拿请求模型/翻译模型补位;
//   · 上下文缺失显示「—」(title 写明未采集),不显示 0;
//   · 估算 token 必须与真实用量分开说明;
//   · 能力声明保存带 expected_revision,409 不覆盖、不丢草稿;
//   · 只在进入本页或手动刷新时读取,没有轮询。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'public/js/insights.js'), 'utf8');
const appSource = require('./console-source').consoleSource();
const workspaceSource = fs.readFileSync(path.join(ROOT, 'public/js/workspace.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
// 数字与时间格式直接用 app.js 的全站格式函数(与用量、诊断同一套)。只把用到的顶层定义抽进上下文,
// 期望值也从它们算:app.js 改格式时本测试跟着走;改了名或多了依赖会报错,而不是静默通过。
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const appDefinition = name => {
  const match = new RegExp(`^const ${name} = [\\s\\S]*?(?=^[^\\s}])`, 'm').exec(APP_SOURCE);
  if (!match) throw new Error(`app.js 里找不到 ${name} 的顶层定义`);
  return match;
};
// 按 app.js 里的先后顺序拼接:别名(const fmtDur = fmtTtfb 这类)必须排在被引用的定义之后。
const APP_FORMATTERS = ['finiteOrNull', 'fmtTok', 'fmtCount', 'fmtBytes', 'fmtFullTime', 'fmtWhen']
  .map(appDefinition).sort((a, b) => a.index - b.index).map(match => match[0]).join('\n');
const plain = value => JSON.parse(JSON.stringify(value));

const MODELS = {
  revision: 'rev-1',
  models: [
    {
      app: 'claude', provider: 'p1', provider_name: 'Alpha', model: 'claude-x',
      capabilities: {
        context_window: { value: 200000, source: 'manual' },
        max_output_tokens: { value: 64000, source: 'manual' },
        vision: { value: true, source: 'manual' },
        reasoning_levels: { value: ['low', 'high'], source: 'manual' },
      },
      observation: { requested_model: 'claude-x', upstream_model: 'claude-real', status: 200, ts: '2026-11-02T10:00:00.000Z' },
    },
    {
      app: 'codex', provider: 'p2', provider_name: 'Beta', model: 'gpt-y',
      capabilities: {
        context_window: { value: null, source: 'unknown' },
        max_output_tokens: { value: null, source: 'unknown' },
        vision: { value: null, source: 'unknown' },
        reasoning_levels: { value: null, source: 'unknown' },
      },
      observation: null,
    },
  ],
};

const REQUESTS = {
  requests: [
    {
      request_id: 'r1', ts: '2026-11-02T10:00:00.000Z', app: 'claude', provider: 'Alpha',
      model_in: 'mixr-main', model_out: 'claude-x', upstream_model: 'claude-real', session: 'cc:sess-1',
      status: 200, in: 100, out: 20, cache_read: 0, bytes_in: 2048,
      context: {
        version: 1, serialized_bytes: 4096, system_bytes: 1024, tools_bytes: 512,
        tool_results_bytes: 256, conversation_bytes: 1536, media_bytes: 0, other_bytes: 768,
        estimated_text_tokens: 1024,
      },
    },
    {
      request_id: 'r2', ts: '2026-11-02T10:01:00.000Z', app: 'codex', provider: 'Beta',
      model_in: 'qwen', model_out: 'gpt-y', upstream_model: null, session: 'cx:sess-2',
      status: 502, in: null, out: null, cache_read: null, bytes_in: null,
    },
  ],
  scope: { source: 'memory', capacity: 500 },
};

class El {
  constructor(id = '') {
    this.id = id; this.hidden = false; this.disabled = false; this.value = '';
    this.checked = false; this.textContent = ''; this.className = ''; this._html = ''; this.focused = false;
  }
  set innerHTML(value) { this._html = String(value ?? ''); }
  get innerHTML() { return this._html; }
  focus() { this.focused = true; }
}

function applySpec(entry, spec) {
  const cap = (value, source) => ({ value, source: source ? 'manual' : 'unknown' });
  entry.capabilities = {
    context_window: cap(spec.context_window, spec.context_window != null),
    max_output_tokens: cap(spec.max_output_tokens, spec.max_output_tokens != null),
    vision: cap(spec.vision, spec.vision != null),
    reasoning_levels: cap(spec.reasoning_levels, spec.reasoning_levels != null),
  };
  return entry;
}

function defaultResponder(url, options = {}) {
  if (url === '/api/insights/models' && (options.method || 'GET') === 'GET') return plain(MODELS);
  if (url === '/api/insights/models' && options.method === 'PUT') {
    const body = JSON.parse(options.body);
    const models = plain(MODELS.models).map(entry => (
      entry.app === body.app && entry.provider === body.provider && entry.model === body.model
        ? applySpec(entry, body.spec) : entry));
    return { revision: 'rev-2', models };
  }
  if (url === '/api/insights/requests?limit=100') return plain(REQUESTS);
  throw new Error('unexpected ' + url);
}

function harness({ online = true, models = MODELS, requests = REQUESTS } = {}) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new El(id));
    return elements.get(id);
  };
  const calls = [];
  const confirmations = [];
  let responder = (url, options) => {
    if (url === '/api/insights/models' && (options.method || 'GET') === 'GET') return plain(models);
    if (url === '/api/insights/requests?limit=100') return plain(requests);
    return defaultResponder(url, options);
  };
  let confirmResult = true;
  const context = vm.createContext({
    document: { getElementById: id => get(id) },
    console,
    online,
    api: (url, options = {}) => { calls.push({ url, options }); return responder(url, options); },
    askConfirm: async (...args) => { confirmations.push(args); return confirmResult; },
  });
  vm.runInContext(APP_FORMATTERS, context, { filename: 'public/js/app.js (formatters)' });
  vm.runInContext(source, context, { filename: 'public/js/insights.js' });
  return {
    context, calls, confirmations, get,
    run: code => vm.runInContext(code, context),
    settle: async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); },
    respond: next => { responder = next; },
    confirm: value => { confirmResult = value; },
  };
}

async function loaded(options) {
  const h = harness(options);
  h.run('insightsSetVisible(true)');
  await h.settle();
  return h;
}

test('index/外壳接线:两个新视图入口、脚本样式与 typeof 钩子', () => {
  assert.match(html, /id="view-insights"/);
  assert.match(html, /<a href="#insights" data-view="insights">/);
  assert.match(html, /<script src="\/js\/insights.js"><\/script>/);
  assert.match(html, /href="\/styles\/insights.css"/);
  assert.match(appSource, /typeof insightsSetVisible === 'function'/);
  assert.match(appSource, /insightsSetVisible\(view === 'insights'\)/);
  assert.match(appSource, /const VIEWS = \[[^\]]*'insights'/);
  assert.match(workspaceSource, /insights: '模型与上下文'/);
  assert.match(workspaceSource, /view: 'insights'/);
  assert.doesNotMatch(source, /setInterval|setTimeout/, '诊断页不做后台轮询');
  // 页面骨架里请求/模型两个状态容器必须存在,模块在解析时就渲染初始态。
  for (const id of ['insights-models-status', 'insights-models-rows', 'insights-models-empty',
    'insights-requests-status', 'insights-requests-rows', 'insights-requests-empty',
    'insights-context-summary', 'insights-model-detail', 'insights-request-detail']) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html 缺少 #${id}`);
  }
});

test('进入本页才读取:一次 GET 模型 + 一次 GET 请求,重复进入/离开不轮询', async () => {
  const h = harness();
  assert.equal(h.calls.length, 0, '未进入本页不请求');
  h.run('insightsSetVisible(false)');
  await h.settle();
  assert.equal(h.calls.length, 0);
  h.run('insightsSetVisible(true)');
  await h.settle();
  assert.deepEqual(h.calls.map(call => call.url), ['/api/insights/models', '/api/insights/requests?limit=100']);
  assert.equal(h.get('insights-models-table').hidden, false);
  assert.equal(h.get('insights-requests-table').hidden, false);
  assert.match(h.get('insights-models-status').textContent, /已读取 2 个登记模型/);
  assert.match(h.get('insights-requests-status').textContent, /已读取 2 条内存请求/);
  h.run('insightsSetVisible(false); insightsSetVisible(true)');
  await h.settle();
  assert.equal(h.calls.length, 2, '已读过就不在切页时重复请求');
  await h.run('insightsLoadModels(true)');
  assert.equal(h.calls.length, 3, '手动刷新才再读一次');
});

test('首次离线后补读一次，连接变化不重绘能力草稿', async () => {
  const h = harness({ online: false });
  h.run('insightsSetVisible(true)');
  h.run('online = true; insightsUpdateControls(); insightsSetVisible(true)');
  await h.settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.get('insights-refresh-models').disabled, false);
  h.run('insightsSelectModel(0); insightsEditModel()');
  h.get('insights-cap-context').value = '123456';
  h.run('online = false; insightsUpdateControls()');
  assert.equal(h.get('insights-cap-save').disabled, true);
  assert.equal(h.get('insights-cap-context').value, '123456');
  h.run('online = true; insightsUpdateControls(); insightsSetVisible(true)');
  await h.settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.get('insights-cap-save').disabled, false);
  assert.match(appSource, /connected && view === 'insights'.*insightsSetVisible\(true\)/);
});

test('能力刷新与保存互斥，旧 GET 不锁死后续读取', async () => {
  const h = await loaded();
  h.run('insightsSelectModel(0)');
  let resolveRead;
  h.respond(() => new Promise(resolve => { resolveRead = resolve; }));
  const read = h.run('insightsLoadModels(true)');
  h.run('insightsEditModel()');
  assert.equal(h.run('insightsState.editingModel'), false);
  await h.run('insightsSaveModel()');
  assert.equal(h.calls.length, 3);
  resolveRead(plain(MODELS)); await read;
  assert.equal(h.run('insightsState.modelsLoading'), false);
  h.run('insightsEditModel()');
  let resolveSave;
  h.respond(() => new Promise(resolve => { resolveSave = resolve; }));
  const save = h.run('insightsSaveModel()');
  assert.equal(h.get('insights-refresh-models').disabled, true);
  await h.run('insightsLoadModels(true)');
  assert.equal(h.calls.length, 4);
  resolveSave(plain(MODELS)); await save;
  assert.equal(h.get('insights-refresh-models').disabled, false);
});

test('HTTP 200 但中断的请求不能显示为成功', async () => {
  const h = await loaded({ requests: { ...REQUESTS, requests: [{ ...REQUESTS.requests[0], ok: false }] } });
  const row = h.get('insights-requests-rows').innerHTML;
  // 主文案是「中断」,200 只作次级小字,原因写在 title;不能出现「成功」。
  assert.match(row, /class="num st5"/);
  assert.ok(row.includes('<span class="insights-code" title="HTTP 200，但请求失败或中断（日志记有错误）">中断</span><span class="insights-sub mono">200</span>'));
  assert.doesNotMatch(row, />成功</);
});

test('模型表:手工值、来源、视觉与推理档位;未登记字段显式未知', async () => {
  const h = await loaded();
  const rows = h.get('insights-models-rows').innerHTML;
  // token 数缩写显示(与用量、诊断同一套 fmtTok),完整千分位进 title。
  assert.ok(rows.includes(`<span class="insights-value" title="200,000">${h.run('fmtTok(200000)')}</span>`));
  assert.ok(rows.includes(`<span class="insights-value" title="64,000">${h.run('fmtTok(64000)')}</span>`));
  assert.match(rows, /支持/);
  assert.match(rows, /low, high/);
  assert.match(rows, /手动/);
  assert.match(rows, /自报 claude-real/);
  assert.match(rows, /发出 claude-x/);
  // 观察只来自成功请求,状态码恒为 2xx,不再单列;时间点缩写,完整时间在 title。
  assert.doesNotMatch(rows, /状态 200/);
  const ts = '2026-11-02T10:00:00.000Z';
  assert.ok(rows.includes(`<span class="insights-time" title="${h.run(`fmtFullTime('${ts}')`)}">${h.run(`fmtWhen('${ts}')`)}</span>`));
  // 缺失统一显示「—」,原因(未登记 / 没观察到)写进 title,不与 0 混在一起。
  assert.match(rows, /title="暂无成功请求的观察">—</);
  assert.ok(rows.includes('<span class="insights-unknown" title="未知：没有登记，不按模型名推断">—</span>'));
  assert.match(rows, /未知/);
  // 协议组与用量、诊断同一套叫法。
  assert.match(rows, /<td>Anthropic<\/td>/);
  assert.match(rows, /<td>OpenAI<\/td>/);
  assert.doesNotMatch(rows, /0 tokens/, '未知不能渲染成 0');
  assert.match(rows, /onclick="insightsSelectModel\(0\)"/);
  assert.match(rows, /onclick="insightsSelectModel\(1\)"/);
});

test('请求表:三列模型名分开;缺失的自报与上下文显式未知/未采集;0 缓存读照实显示', async () => {
  const h = await loaded();
  const rows = h.get('insights-requests-rows').innerHTML;
  assert.match(rows, /mixr-main/);
  assert.match(rows, /claude-x/);
  assert.match(rows, /claude-real/);
  assert.match(rows, /缓存读 <span class="insights-value">0<\/span>/, '0 是真实读数,不能显示成 —');
  assert.match(rows, /缓存读 <span class="insights-value">—<\/span>/, '缺失才是 —');
  // 字节与诊断同一套 fmtBytes(1024 进制,数字与单位不加空格)。
  assert.ok(rows.includes(`请求体 ${h.run('fmtBytes(2048)')}`));
  assert.match(h.run('fmtBytes(2048)'), /^2\.0KB$/);
  assert.match(rows, /title="未采集：旧记录或未进入转发阶段，没有上下文统计（不是 0 字节）">—</);
  assert.match(rows, /title="未知：未观察到上游模型字段；也可能超出采样范围或无法解析">—<\/span>/);
  // 状态给人话:成功只显示「成功」(状态码在 title),失败把状态码作次级小字。
  assert.ok(rows.includes('<span class="insights-code" title="HTTP 200">成功</span></td>'));
  assert.ok(rows.includes('<td class="num st5"><span class="insights-code" title="HTTP 502">失败</span><span class="insights-sub mono">502</span></td>'));
  const summary = h.get('insights-context-summary').innerHTML;
  assert.match(summary, /1 条带上下文统计/);
  assert.ok(summary.includes(h.run('fmtBytes(4096)')));
  assert.match(summary, /不是完整历史/);
});

test('上下文详情:六类字节、合计、估算 token 与真实用量分开说明', async () => {
  const h = await loaded();
  h.run('insightsSelectRequest(0)');
  const detail = h.get('insights-request-detail').innerHTML;
  assert.equal(h.get('insights-request-detail').hidden, false);
  for (const label of ['系统与指令', '工具声明', '工具输出', '对话文本', '媒体载荷', '信封与未知字段']) {
    assert.match(detail, new RegExp(label), `缺少分类 ${label}`);
  }
  assert.ok(detail.includes(h.run('fmtBytes(4096)')));
  // 详情面板写完整时间与人话状态,HTTP 状态码作次级等宽小字。
  assert.ok(detail.includes(`<dt>时间</dt><dd>${h.run("fmtFullTime('2026-11-02T10:00:00.000Z')")}</dd>`));
  assert.ok(detail.includes('<dt>状态</dt><dd>成功<span class="mono insights-code-raw">HTTP 200</span></dd>'));
  assert.match(detail, /估算文本 tokens/);
  assert.match(detail, /不是官方 tokenizer/);
  assert.match(detail, /不是实际用量/);
  assert.match(detail, /实际用量来自上游回报：输入 100 \/ 输出 20 \/ 缓存读 0/);
  assert.match(detail, /无法识别具体 skill、文件或工具名/);
  h.run('insightsSelectRequest(1)');
  const missing = h.get('insights-request-detail').innerHTML;
  assert.match(missing, /没有上下文统计/);
  assert.match(missing, /这不是 0 字节/);
});

test('能力保存:带 expected_revision 与 null 清空;成功后 revision 更新', async () => {
  const h = await loaded();
  h.run('insightsSelectModel(0); insightsEditModel()');
  h.get('insights-cap-context').value = '300000';
  h.get('insights-cap-maxout').value = '';
  h.get('insights-cap-vision').value = 'false';
  h.get('insights-cap-reasoning').value = 'low, medium, low';
  await h.run('insightsSaveModel()');
  const put = h.calls.find(call => call.options.method === 'PUT');
  assert.equal(put.url, '/api/insights/models');
  assert.deepEqual(JSON.parse(put.options.body), {
    app: 'claude', provider: 'p1', model: 'claude-x', expected_revision: 'rev-1',
    spec: { context_window: 300000, max_output_tokens: null, vision: false, reasoning_levels: ['low', 'medium'] },
  });
  assert.equal(h.run('insightsState.modelsRevision'), 'rev-2');
  assert.equal(h.run('insightsState.editingModel'), false);
  assert.match(h.get('insights-models-status').textContent, /已保存/);
  const rows = h.get('insights-models-rows').innerHTML;
  assert.match(rows, /不支持/);
  assert.match(rows, /300,000/);
  assert.doesNotMatch(rows, /64,000/, '清空后的最大输出不再显示旧值');
});

test('非法能力值不发 PUT;409 保留草稿与旧 revision', async () => {
  const invalid = await loaded();
  invalid.run('insightsSelectModel(0); insightsEditModel()');
  invalid.get('insights-cap-context').value = 'abc';
  await invalid.run('insightsSaveModel()');
  assert.equal(invalid.calls.filter(call => call.options.method === 'PUT').length, 0);
  assert.match(invalid.get('insights-cap-status').textContent, /必须是正整数/);
  invalid.get('insights-cap-context').value = '300000';
  invalid.get('insights-cap-reasoning').value = 'a,b,c,d,e,f,g,h,i,j,k,l,m';
  await invalid.run('insightsSaveModel()');
  assert.equal(invalid.calls.filter(call => call.options.method === 'PUT').length, 0);
  assert.match(invalid.get('insights-cap-status').textContent, /最多 12 个/);

  const conflict = await loaded();
  conflict.respond(async () => { throw Object.assign(new Error('conflict'), { status: 409 }); });
  conflict.run('insightsSelectModel(0); insightsEditModel()');
  conflict.get('insights-cap-context').value = '123';
  await conflict.run('insightsSaveModel()');
  assert.equal(conflict.run('insightsState.modelsRevision'), 'rev-1');
  assert.equal(conflict.run('insightsState.editingModel'), true);
  assert.match(conflict.get('insights-cap-status').textContent, /保存冲突/);
  assert.equal(conflict.get('insights-cap-context').value, '123');
});

test('读取失败保留旧结果;离线不请求且保存被拒', async () => {
  const h = await loaded();
  h.respond(async () => { throw new Error('read failed'); });
  await h.run('insightsLoadModels(true)');
  assert.match(h.get('insights-models-status').textContent, /读取失败：read failed（保留上次结果）/);
  assert.match(h.get('insights-models-status').textContent, /可点「刷新模型」重试/, '失败要给下一步');
  assert.equal(h.get('insights-models-table').hidden, false, '失败不能清空旧表');
  // 浏览器原文(Failed to fetch)换成能看懂的原因。
  h.respond(async () => { throw new TypeError('Failed to fetch'); });
  await h.run('insightsLoadModels(true)');
  assert.match(h.get('insights-models-status').textContent, /^读取失败：连不上本机服务/);

  const offline = harness({ online: false });
  offline.run('insightsSetVisible(true)');
  await offline.settle();
  assert.equal(offline.calls.length, 0);
  assert.match(offline.get('insights-models-status').textContent, /离线/);
  assert.equal(offline.get('insights-refresh-models').disabled, true);
  offline.run('insightsSelectModel(0)');
  await offline.run('insightsSaveModel()');
  assert.equal(offline.calls.length, 0);
});

test('手动刷新遇到未保存编辑走确认;取消不发 GET', async () => {
  const h = await loaded();
  h.run('insightsSelectModel(0); insightsEditModel()');
  h.get('insights-cap-context').value = '999';
  h.confirm(false);
  await h.run('insightsLoadModels(true)');
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.calls.length, 2, '取消后不重新读取');
  assert.equal(h.get('insights-cap-context').value, '999');
  h.confirm(true);
  await h.run('insightsLoadModels(true)');
  assert.equal(h.calls.length, 3);
  assert.equal(h.run('insightsState.editingModel'), false);
});

test('恶意模型/渠道/自报/会话名一律转义', async () => {
  const evil = '\"><img src=x onerror=alert(1)>';
  const models = {
    revision: 'rev-x',
    models: [{
      app: 'claude', provider: 'p<evil>', provider_name: evil, model: evil,
      capabilities: { context_window: { value: null, source: 'unknown' }, max_output_tokens: { value: null, source: 'unknown' },
        vision: { value: true, source: 'manual' }, reasoning_levels: { value: [evil], source: 'manual' } },
      observation: { requested_model: evil, upstream_model: evil, status: 200, ts: '2026-11-02T10:00:00.000Z' },
    }],
  };
  const requests = {
    requests: [{
      request_id: 'r<evil>', ts: '2026-11-02T10:00:00.000Z', app: 'claude', provider: evil,
      model_in: evil, model_out: evil, upstream_model: evil, session: evil, status: 200,
      in: 1, out: 1, cache_read: 0, bytes_in: 10, context: { serialized_bytes: 10, system_bytes: 10, estimated_text_tokens: 3 },
    }],
    scope: { source: 'memory', capacity: 500 },
  };
  const h = await loaded({ models, requests });
  const modelRows = h.get('insights-models-rows').innerHTML;
  const requestRows = h.get('insights-requests-rows').innerHTML;
  for (const rendered of [modelRows, requestRows]) {
    assert.doesNotMatch(rendered, /<img/);
    assert.match(rendered, /&lt;img/);
  }
  h.run('insightsSelectRequest(0)');
  assert.doesNotMatch(h.get('insights-request-detail').innerHTML, /<img/);
  assert.match(h.get('insights-request-detail').innerHTML, /&lt;img/);
  assert.doesNotMatch(h.get('insights-context-summary').innerHTML, /<img/);
});
