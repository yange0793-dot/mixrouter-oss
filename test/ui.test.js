'use strict';
// No browser, dependencies, network requests or user configuration writes.
// Execute the real inline script with a deliberately small DOM/fetch boundary.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const script = new vm.Script(source, { filename: 'public/js/app.js' });
const { createExplainer } = require('../lib/routing/explain');

function fixture() {
  return {
    version: 'test', proxy_port: 8787, ui_port: 8788, uptime_s: 125, pid: 4242, code_revision: 'abcdef0123456789',
    stats: { reqs: 12, inTok: 100, outTok: 40 },
    providers: {
      claude: [
        { id: 'a1', name: 'Alpha', base_url: 'https://anthropic.example', models: ['claude-special'], slots: { opus: 'slot-model' }, enabled: true, key_masked: '***',
          keys: [{ id: 'k1', label: 'Account One', enabled: true }, { id: 'k2', label: 'Account Two', enabled: true }, { id: 'k-off', label: 'Disabled Key', enabled: false }], active_key: 'k1' },
        { id: 'a2', name: 'Disabled', base_url: 'https://old.example', models: ['claude-old'], enabled: false },
      ],
      codex: [
        { id: 'o1', name: 'Beta', base_url: 'https://openai.example/v1', model: 'gpt-test', wire_api: 'responses', enabled: true },
        { id: 'o2', name: 'Chat gateway', base_url: 'https://chat.example/v1', model: 'text-model', wire_api: 'chat', enabled: false },
      ],
    },
    current: { claude: 'a1', codex: null, zcode: null },
    live: {
      claude: { base_url: 'https://anthropic.example', model: 'claude-special', match: true, router: false },
      codex: { base_url: '', match: true, router: false },
      zcode: { base_url: '', model: '', match: true, router: false },
    },
    router: { id: '@router', url: 'http://127.0.0.1:8787', claude_base: 'http://127.0.0.1:8787', codex_base: 'http://127.0.0.1:8787/v1', zcode_base: 'http://127.0.0.1:8787/custom' },
    routes: { rules: [{ id: 'r1', match: 'claude', provider: 'a1', model: '', enabled: true, pool: [], when: {} }], default: { provider: 'a1', model: '', pool: [] } },
    slots: {
      claude: ['main', 'opus', 'sonnet', 'haiku', 'subagent'].map(name => ({
        name, alias: 'mixr-' + name,
        env: { main: 'ANTHROPIC_MODEL', subagent: 'CLAUDE_CODE_SUBAGENT_MODEL' }[name] || 'ANTHROPIC_DEFAULT_' + name.toUpperCase() + '_MODEL',
        provider: name === 'main' ? 'a1' : '', provider_name: name === 'main' ? 'Alpha' : '', enabled: true,
        model: name === 'main' ? 'claude-special' : '',
      })),
      codex: [],
    },
    // 会话页的三层状态(required/bound/actual)由服务端给出,这里按同一形状造数据:
    // 搜索要在**不碰这些数据**的前提下按短 id / 完整 id / 对话名 / 渠道名过滤。
    sessions: [
      { key: 'sess-ui-alpha-0000000000000001', short: 'aaa11111', app: 'claude', kind: 'header', label: '修复登录跳转',
        provider: 'a1', provider_name: 'Alpha', model: 'claude-special', rule: 'r1', reqs: 2, inTok: 3, outTok: 4, lastUsed: 1700000002000, pinned: false, cooldown: false,
        required: { routing: { keys: {}, slots: {} }, revision: 'sr-a', keys: 0, slots: 0 },
        bound: { provider: 'a1', provider_name: 'Alpha', model: 'claude-special', rule: 'r1', pinned: false, source: 'auto' },
        actual: null, actual_source: 'none', actual_text: '暂无',
        routing: { keys: {}, slots: {} }, routing_revision: 'sr-a' },
      { key: 'sess-ui-beta-00000000000000002', short: 'bbb22222', app: 'codex', kind: 'metadata', label: '重构压缩窗口',
        provider: 'o1', provider_name: 'Beta', model: 'gpt-test', rule: '', reqs: 1, inTok: 1, outTok: 1, lastUsed: 1700000001000, pinned: true, cooldown: false,
        required: { routing: { keys: {}, slots: {} }, revision: 'sr-b', keys: 0, slots: 0 },
        bound: { provider: 'o1', provider_name: 'Beta', model: 'gpt-test', rule: '', pinned: true, source: 'manual' },
        actual: { provider: 'o1', provider_name: 'Beta', model: 'gpt-test', rule: '', slot: '', sticky: false, status: 200, in: 1, out: 1, ms: 40, ts: 1700000001500 },
        actual_source: 'request', actual_text: 'Beta',
        routing: { keys: {}, slots: {} }, routing_revision: 'sr-b' },
      { key: 'sess-ui-gamma-0000000000000003', short: 'ccc33333', app: 'claude', kind: 'anon', label: '',
        provider: '', provider_name: '', model: '', rule: '', reqs: 0, inTok: 0, outTok: 0, lastUsed: 0, pinned: false, cooldown: false,
        required: { routing: { keys: {}, slots: {} }, revision: '', keys: 0, slots: 0 },
        bound: { provider: '', provider_name: '', model: '', rule: '', pinned: false, source: 'none' },
        actual: null, actual_source: 'none', actual_text: '暂无',
        routing: { keys: {}, slots: {} }, routing_revision: '' },
    ], cooldowns: [],
  };
}

async function harness(data = fixture(), opts = {}) {
  const elements = new Map();
  const listeners = new Map();
  let document;
  class Element {
    constructor(id = '', tag = 'div') {
      this.id = id; this.tagName = tag.toUpperCase(); this.style = {}; this.dataset = {};
      this.attributes = {}; this.value = ''; this.checked = false; this.disabled = false;
      this.hidden = false; this.inert = false; this.isConnected = true; this.children = [];
      this.parentElement = null; this.events = {}; this.htmlWrites = 0; this.textContent = '';
      const classes = new Set();
      this.classList = {
        add: (...xs) => xs.forEach(x => classes.add(x)),
        remove: (...xs) => xs.forEach(x => classes.delete(x)),
        contains: x => classes.has(x),
        toggle: (x, force) => { const on = force ?? !classes.has(x); if (on) classes.add(x); else classes.delete(x); return on; },
      };
    }
    set innerHTML(value) {
      this._html = value; this.htmlWrites++;
      for (const match of value.matchAll(/<(input|select|button|div|label)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const el = new Element(match[2], match[1]); el.parentElement = this; elements.set(el.id, el);
        el.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
      }
    }
    get innerHTML() { return this._html || ''; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
    focus() { document.activeElement = this; }
    contains(el) { return el === this || !!el?.parentElement && this.contains(el.parentElement); }
    matches(selector) { return selector.split(',').some(s => s.trim() === this.tagName.toLowerCase()); }
    getClientRects() { return this.hidden ? [] : [{}]; }
    querySelectorAll(selector) {
      if (selector.includes(':disabled')) return this.children.filter(el => !el.disabled && ['BUTTON', 'INPUT', 'SELECT'].includes(el.tagName));
      if (selector === 'button') return this.children.filter(el => el.tagName === 'BUTTON');
      return [];
    }
    querySelector(selector) { return selector === '.modal' ? this.modal : this.querySelectorAll(selector)[0] || null; }
    reportValidity() { return true; }
    // 静态骨架里的行内 onclick(例如会话页空表那个「清除搜索与筛选」按钮)不是由脚本赋值的,
    // 假 DOM 原先直接当它不存在,点下去什么都不发生。这里把它记下来,click() 时交给 vm 执行。
    click() { if (this.onclick) this.onclick({ preventDefault() {} }); else if (this.inlineOnclick) inlineRun(this.inlineOnclick); }
  }
  let inlineRun = () => {};
  for (const m of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const el = new Element(m[2], m[1]);
    const inline = m[0].match(/\bonclick="([^"]*)"/)?.[1];
    if (inline) el.inlineOnclick = inline;
    // 内联 style 要解析进 el.style:骨架里 view-providers 等节是 style="display:none" 隐藏的,
    // 不解析的话 el.style.display 恒为 undefined,"默认隐藏"这条就断言不到(真实浏览器里读得到)。
    const styleText = m[0].match(/\bstyle="([^"]*)"/)?.[1];
    if (styleText) for (const decl of styleText.split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) el.style[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
    elements.set(m[2], el);
  }
  const get = id => { assert.ok(elements.has(id), 'Unknown DOM id: ' + id); return elements.get(id); };
  const body = new Element('body', 'body');
  // 从真实导航读视图与客户端:三个客户端共享 providers,不能只按 view 假造一个链接。
  const nav = Array.from(html.matchAll(/<a\b[^>]*\bdata-view="([^"]+)"[^>]*>/g), match => {
    const el = new Element('nav-' + match[1], 'a');
    el.dataset.view = match[1];
    const app = match[0].match(/\bdata-app="([^"]+)"/);
    if (app) el.dataset.app = app[1];
    return el;
  });
  const tabs = new Element('tabs');
  // 导出下载:记录被点过的 <a download>,不真的落盘。
  const downloads = [];
  document = {
    body, activeElement: body,
    getElementById: id => elements.get(id) || null,
    querySelectorAll: selector => selector === 'nav a' ? nav : [],
    querySelector: selector => selector === '.apptabs' ? tabs : nav.find(el => selector.includes(`data-view="${el.dataset.view}"`)) || null,
    addEventListener: (event, fn) => { (listeners.get(event) || listeners.set(event, []).get(event)).push(fn); },
    // 导出才用得到:造一个假 <a> 并把它的 download/href 记下来(不真下载)。
    createElement: tag => { const el = new Element('', tag); el.click = () => downloads.push({ download: el.download, href: el.href }); return el; },
  };
  for (const id of ['rules-box', 'def-box', 'save-routes', 'add-rule']) get(id).parentElement = get('view-routes');
  // 概览页与设置页的控件也要有自己的视图容器:凡断言"某控件在自己的视图里"的用例都靠它。
  for (const id of ['overview-todo', 'overview-clients', 'overview-endpoints', 'ov-version', 'ov-revision']) get(id).parentElement = get('view-overview');
  for (const id of ['backup-status', 'backup-dirs', 'health-status', 'health-body', 'preview-status', 'preview-body', 'preview-app', 'preview-model', 'metrics-msg']) get(id).parentElement = get('view-settings');
  for (const [parent, ids] of [['compact-panel', ['compact-provider', 'compact-model', 'compact-model-custom', 'compact-key']],
    ['compact-window-panel', ['window-scope', 'window-project', 'window-value']]]) {
    for (const id of ids) get(id).parentElement = get(parent);
    get(parent).parentElement = get('view-routes');
  }
  for (const [maskId, controls] of [['mask', ['m-name', 'm-base', 'm-key', 'save-provider']], ['confirm-mask', ['confirm-cancel', 'confirm-ok']]]) {
    const mask = get(maskId); mask.modal = new Element(maskId + '-dialog'); mask.modal.parentElement = mask;
    mask.children = controls.map(id => { const el = get(id); el.parentElement = mask; return el; });
  }
  get('provider-filter').value = 'all'; get('logs-auto').checked = true;
  // 静态骨架里的 <select> 默认值:假 DOM 不解析 <option selected>,这里补上脚本要读的那几个。
  get('preview-app').value = 'claude';
  get('window-scope').value = 'global';
  const requests = [];
  const slots = structuredClone(data.slots || { claude: [], codex: [] });
  let failState = false;
  // windowListeners 供压缩窗口的 beforeunload 断言;intervals 让分槽统计的 5 秒自动刷新能被手动触发。
  const windowListeners = new Map(), intervals = new Map();
  let timerId = 0;
  // 设置页三条只读端点的失败注入开关:验"概览/设置页 fetch 失败不影响其它页草稿"时用它。
  let failHealth = false, failBackups = false, failPreview = false, failMetrics = false;
  // URL 本体照用(相对 URL 解析、searchParams 都靠它),只把 createObjectURL 换成假 DOM 版本:
  // Node 的 URL.createObjectURL 只收它自己的 Blob,喂我们那个最小 Blob 会抛,导出路径就断了。
  const fakeObjectUrl = 'blob:http://localhost/fake-object-url';
  const URLShim = new Proxy(URL, { get: (target, prop) => prop === 'createObjectURL' ? () => fakeObjectUrl : (prop === 'revokeObjectURL' ? () => {} : Reflect.get(target, prop)) });
  const context = vm.createContext({
    document, window: { addEventListener(name, callback) { (windowListeners.get(name) || windowListeners.set(name, []).get(name)).push(callback); }, localStorage: opts.storage }, console, URL: URLShim, URLSearchParams, AbortController, structuredClone,
    // 导出用的最小实现:只要能把 Blob 存成对象 URL、并能造个 <a> 就够断言(不真的下载)。
    Blob: class Blob { constructor(parts, opts = {}) { this.parts = parts; this.type = opts.type || ''; } },
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval(fn) { const id = ++timerId; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); },
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, method: options.method || 'GET', body });
      if (url === '/api/state') {
        if (failState) throw new Error('simulated disconnect');
        return { ok: true, json: async () => structuredClone(data) };
      }
      if (url === '/api/stats') return { ok: true, json: async () => ({ reqs: 12, ok_rate: 100, inTok: 100, outTok: 40, cache: 0 }) };
      if (url === '/api/slots' && options.method === 'PUT') {
        // 模拟真实服务端:合并槽位改动后返回最新槽位表(slotsPublic)
        for (const app of ['claude', 'codex']) {
          const patch = body?.[app];
          if (!patch || typeof patch !== 'object') continue;
          for (const [name, val] of Object.entries(patch)) {
            if (val === null) { const i = slots[app].findIndex(s => s.name === name); if (i >= 0) slots[app].splice(i, 1); continue; }
            const entry = slots[app].find(s => s.name === name);
            if (entry) Object.assign(entry, val);
          }
        }
        return { ok: true, json: async () => ({ ok: true, slots: structuredClone(slots) }) };
      }
      if (url.startsWith('/api/compact/window')) {
        const query = new URL(url, 'http://localhost').searchParams;
        const scope = options.method === 'POST' ? body.scope : query.get('scope') || 'global';
        const project = options.method === 'POST' ? body.project || '' : query.get('project') || '';
        const canonicalProject = project.startsWith('/tmp/') ? '/private' + project : project;
        const target = scope === 'global' ? '/home/test/.claude/settings.json' : canonicalProject + '/.claude/' + (scope === 'local' ? 'settings.local.json' : 'settings.json');
        const layers = structuredClone(data.window?.layers || [{ scope: 'global', file: '/home/test/.claude/settings.json', exists: true, value: data.window?.value ?? 'auto', env_override: false }]);
        if (!layers.some(layer => layer.scope === scope)) layers.push({ scope, file: target, exists: false, value: 'auto', env_override: false });
        const selectedLayer = layers.find(layer => layer.scope === scope);
        const value = options.method === 'POST' ? body.value : selectedLayer.value;
        selectedLayer.value = value;
        if (options.method === 'POST') data.window = { ...data.window, scope, project: canonicalProject, value, layers, revision: 'window-saved' };
        const top = layers.filter(layer => typeof layer.value === 'number').at(-1);
        const window = { scope, project: canonicalProject, target,
          revision: data.window?.revision || 'window-one', value, layers,
          configured: { value: top?.value || 'auto', source: top?.scope || 'auto' },
          coverage: { project_checked: !!canonicalProject, overridden_by: top && layers.indexOf(top) > layers.indexOf(selectedLayer) ? top.scope : null, environment_override: !!data.window?.environment_override || layers.some(layer => layer.env_override) },
          warnings: data.window?.warnings || ['磁盘配置不代表运行中会话'], min: 100000, max: 1000000, restart_required: true };
        return { ok: true, json: async () => options.method === 'POST' ? { ok: true, window, backup: '/tmp/backup' } : { window } };
      }
      if (url === '/api/compact' && options.method === 'POST') {
        data.compact = { ...data.compact, revision: 'saved-revision', mode: 'single', selection: { provider: body.provider, model: body.model, ...(Object.hasOwn(body, 'key_id') ? { key_id: body.key_id } : {}) } };
        data.routes_revision = 'saved-revision';
        data.routes = { ...data.routes, rules: data.routes.rules.map(r => ({ ...r })) };
        return { ok: true, json: async () => ({ ok: true, compact: structuredClone(data.compact), routes: structuredClone(data.routes) }) };
      }
      if (url === '/api/logs' || url.startsWith('/api/logs?')) return { ok: true, json: async () => ({ logs: [] }) };
      // ---- 设置页的三条只读端点。造的是"能读到"的常态;失败注入由用例自己覆写 fetch。
      if (url === '/api/health') {
        if (failHealth) throw new Error('simulated health failure');
        return { ok: true, json: async () => ({ settings: { total_deadline_ms: 300000, first_header_timeout_ms: 180000, stream_idle_timeout_ms: 120000, max_attempts: 3, cooldown_ms: 60000, retry_delay_ms: 500 },
          providers: [{ provider: 'a1', app: 'claude', enabled: true, eligible: true, cooldown_until: 0 }] }) };
      }
      if (url === '/api/backups') {
        if (failBackups) throw new Error('simulated backups failure');
        return { ok: true, json: async () => ({ keep: 5, dirs: [{ id: 'claude', label: 'Claude 设置', dir: '/home/test/.claude', ok: true, total: 6, legacy: 0,
          backups: [{ name: 'settings.json.bak-mixui-20260101-000000-000-abcd', size: 12, iso: '2026-01-01T00:00:00.000Z', mode: '600', sha256_12: 'abcdef012345', legacy: false }],
          unparsable: [], next_delete: ['settings.json.bak-mixui-20260101-000000-000-abcd'] }] }) };
      }
      if (url === '/api/routing/preview') {
        if (failPreview) throw new Error('simulated preview failure');
        const store = Object.fromEntries(['claude', 'codex'].map(app => [app, data.providers[app].map(p => ({
          ...p, api_key: 'sk-ui-fixture', keys: (p.keys || []).map(k => ({ ...k, key: 'sk-ui-fixture-' + k.id })),
        }))]));
        const explain = createExplainer({
          getRoutes: () => data.routes, storeOf: app => store[app], resolveSlot: () => null,
          findProvider: id => [...store.claude, ...store.codex].find(p => p.id === id),
          providerApp: id => store.codex.some(p => p.id === id) ? 'codex' : 'claude',
          listPools: () => ({}), inCooldown: () => false, healthEligible: () => true,
          sessionCounts: () => data.previewCounts || {},
        });
        const result = explain(body);
        return { ok: result.ok, json: async () => result };
      }
      if (url === '/api/metrics') {
        if (failMetrics) throw new Error('simulated metrics failure');
        return { ok: true, text: async () => '# HELP mixrouter_window_requests 窗口内请求数\nmixrouter_window_requests{app="claude"} 12\n' };
      }
      return { ok: true, json: async () => ({ ok: true, id: 'created-id' }) };
    },
  });
  const run = code => vm.runInContext(code, context);
  inlineRun = code => run(`(function(event){${code}})({ preventDefault(){} })`);
  script.runInContext(context);
  await run('refreshTask');
  return {
    data, get, run, requests, document, listeners, windowListeners, tabs, intervals, downloads,
    // 造一个挂在某容器下的元素,用来把 document.activeElement 挪出编辑区(例如"焦点已离开搜索框")
    element(id, parent) { const el = new Element(id); if (parent) el.parentElement = parent; elements.set(id, el); return el; },
    disconnect(value = true) { failState = value; },
    // 设置页三条只读端点的失败注入(默认全开=能读到)
    fail({ health, backups, preview, metrics } = {}) {
      if (health !== undefined) failHealth = health;
      if (backups !== undefined) failBackups = backups;
      if (preview !== undefined) failPreview = preview;
      if (metrics !== undefined) failMetrics = metrics;
    },
    async confirm(code) { const result = run(code); run('finishConfirm(true)'); await result; },
  };
}

// 渠道布局偏好用的最小 localStorage。默认不给 window 装存储,顺带覆盖"读不到就退回默认"的分支。
function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: key => { store.delete(key); },
  };
}

test('压缩选择独立于通用路由草稿，显示实际池模型，后台刷新不覆盖自定义值', async () => {
  const data = fixture();
  data.routes_revision = 'rev-one';
  data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'mixed', selection: null, providers: [data.providers.claude[0]],
    rules: [{ id: 'renamed', kind: 'global', enabled: true, strategy: 'priority', has_pool: true,
      targets: [{ provider: 'a1', name: 'Alpha', model: 'actual-pool-model', enabled: true, key_id: '', key_label: 'Account One', key_available: true }] }] };
  const h = await harness(data);
  assert.match(h.get('compact-current').innerHTML, /actual-pool-model/);
  assert.equal(h.run('compactDraft.provider'), '', '混合落点不能假显示成单一已选渠道');
  h.run("pickCompactProvider('a1'); pickCompactModel('__custom__'); document.getElementById('compact-model-custom').value = 'draft-model'; setCompactCustom('draft-model')");
  assert.equal(h.run('routesDirty'), false);
  for (const listener of h.get('view-routes').events.input) listener({ target: h.get('compact-model-custom') });
  assert.equal(h.run('routesDirty'), false, '压缩控件冒泡事件不能污染通用路由草稿');
  assert.equal(h.run('compactDirty'), true);
  data.compact.revision = 'rev-two'; await h.run('refresh()');
  assert.equal(h.run('compactDraft.model'), 'draft-model');
  assert.equal(h.get('compact-model-custom').value, 'draft-model');
  assert.match(h.get('compact-msg').textContent, /服务端/);
  await h.run('saveRoutes()');
  assert.equal(h.requests.some(r => r.url === '/api/routes' && r.method === 'PUT'), false, '压缩草稿未保存时不能写回旧通用草稿');
  h.run('compactDirty = false; routesDirty = true');
  await h.run('saveCompact()');
  assert.equal(h.requests.some(r => r.url === '/api/compact' && r.method === 'POST'), false, '通用草稿未保存时不能提交压缩选择');
});

test('压缩保存带版本号、确认替换备池，自动刷新保留保存中的后续编辑', async () => {
  const data = fixture(); data.routes_revision = 'rev-one';
  data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'single', selection: { provider: 'a1', model: 'claude-special', key_id: '' },
    providers: [data.providers.claude[0]], rules: [] };
  const h = await harness(data);
  h.run("pickCompactProvider('a1'); pickCompactModel('__custom__'); setCompactCustom('new-model')");
  const saving = h.run('saveCompact()');
  assert.match(h.get('confirm-text').textContent, /备池/);
  h.run('finishConfirm(true)'); await saving;
  const req = h.requests.findLast(r => r.url === '/api/compact' && r.method === 'POST');
  assert.deepEqual(req.body, { provider: 'a1', model: 'new-model', key_id: '', expected_revision: 'rev-one' });
  assert.equal(h.run('compactDirty'), false);
  assert.equal(h.run('routesBaseRevision'), 'saved-revision');
  assert.equal(h.run('JSON.stringify(routesDraft) === JSON.stringify(state.routes)'), true);
});

test('压缩提交等待响应时的新编辑仍留在草稿，确认期间变更不冒充已保存', async () => {
  const data = fixture(); data.routes_revision = 'rev-one';
  data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'single', selection: { provider: 'a1', model: 'claude-special', key_id: '' }, providers: [data.providers.claude[0]], rules: [] };
  const h = await harness(data);
  h.run("pickCompactModel('__custom__'); setCompactCustom('submitted'); globalThis.pendingCompact = null; const realFetch = fetch; globalThis.fetch = (url, opt) => url === '/api/compact' ? new Promise(resolve => { pendingCompact = async () => resolve(await realFetch(url,opt)); }) : realFetch(url,opt)");
  const saving = h.run('saveCompact()'); h.run('finishConfirm(true)');
  await new Promise(resolve => setImmediate(resolve));
  h.run("setCompactCustom('typed-later')");
  await h.run('pendingCompact()'); await saving;
  assert.equal(h.run('compactDirty'), true);
  assert.equal(h.run('compactDraft.model'), 'typed-later');
  assert.equal(h.requests.findLast(r => r.url === '/api/compact').body.model, 'submitted');
});

test('压缩确认框打开后改了草稿，保存原选择不能清除新草稿', async () => {
  const data = fixture(); data.routes_revision = 'rev-one';
  data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'single', selection: { provider: 'a1', model: 'claude-special', key_id: '' }, providers: [data.providers.claude[0]], rules: [] };
  const h = await harness(data);
  h.run("pickCompactModel('__custom__'); setCompactCustom('before-confirm')");
  const saving = h.run('saveCompact()');
  h.run("setCompactCustom('changed-during-confirm'); finishConfirm(true)"); await saving;
  assert.equal(h.requests.findLast(r => r.url === '/api/compact').body.model, 'before-confirm');
  assert.equal(h.run('compactDirty'), true);
  assert.equal(h.run('compactDraft.model'), 'changed-during-confirm');
});

test('旧服务或不完整 Key 契约禁用选择，但渠道与模型仍按旧接口可保存', async () => {
  for (const missing of ['capability', 'keys', 'selection']) {
    const data = fixture();
    data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'single', selection: { provider: 'a1', model: 'claude-special', key_id: '' }, providers: [data.providers.claude[0]], rules: [] };
    if (missing === 'capability') delete data.compact.key_selection_supported;
    if (missing === 'keys') delete data.compact.providers[0].keys;
    if (missing === 'selection') delete data.compact.selection.key_id;
    const h = await harness(data);
    assert.equal(h.get('compact-key').disabled, true);
    assert.match(h.get('compact-key-hint').textContent, /当前服务端尚不支持指定Key，更新服务后可用/);
    h.run("pickCompactKey('k2'); pickCompactModel('__custom__'); setCompactCustom('legacy-model')");
    assert.equal(h.run('compactDraft.key_id'), '');
    const saving = h.run('saveCompact()');
    assert.match(h.get('confirm-text').textContent, /本次只保存渠道与模型/);
    h.run('finishConfirm(true)'); await saving;
    assert.deepEqual(h.requests.findLast(r => r.url === '/api/compact').body, { provider: 'a1', model: 'legacy-model', expected_revision: 'rev-one' });
  }
});

test('刷新或确认期间退回旧服务不静默提交固定 Key，既有草稿保留', async () => {
  const data = fixture();
  data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'single', selection: { provider: 'a1', model: 'claude-special', key_id: '' }, providers: [data.providers.claude[0]], rules: [] };
  const h = await harness(data);
  h.run("pickCompactKey('k2')");
  const saving = h.run('saveCompact()');
  delete data.compact.key_selection_supported;
  await h.run('refresh()'); h.run('finishConfirm(true)'); await saving;
  assert.equal(h.get('compact-key').disabled, true);
  assert.equal(h.get('compact-key').value, 'k2');
  assert.equal(h.run('compactDraft.key_id'), 'k2');
  assert.equal(h.run('compactDirty'), true);
  assert.match(h.get('compact-key-hint').textContent, /草稿保留.*不能提交给旧服务/);
  assert.equal(h.requests.some(r => r.url === '/api/compact'), false);
  await h.run('saveCompact()');
  assert.equal(h.requests.some(r => r.url === '/api/compact'), false);
});

test('响应未确认 Key 时不冒充保存成功，保留草稿并提示模型可能已写入', async () => {
  const data = fixture();
  data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'single', selection: { provider: 'a1', model: 'claude-special', key_id: '' }, providers: [data.providers.claude[0]], rules: [] };
  const h = await harness(data);
  h.run("pickCompactKey('k2'); const realFetch = fetch; globalThis.fetch = async (url, opt) => { const response = await realFetch(url,opt); if (url !== '/api/compact') return response; const result = await response.json(); delete result.compact.key_selection_supported; delete result.compact.selection.key_id; return { ok:true, json:async () => result }; }");
  await h.confirm('saveCompact()');
  assert.equal(h.run('compactDraft.key_id'), 'k2');
  assert.equal(h.run('compactDirty'), true);
  assert.match(h.get('toast').textContent, /未确认 Key 选择.*模型可能已写入.*草稿保留/);
  assert.equal(h.get('compact-key').disabled, true);
});

test('压缩 Key 仅显示标签与 ID，固定选择不改 active_key 或通用草稿', async () => {
  const data = fixture();
  data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'single', selection: { provider: 'a1', model: 'claude-special', key_id: '' }, providers: [data.providers.claude[0]], rules: [] };
  // Even accidental extra fields must not be rendered by the compaction control.
  data.compact.providers[0].keys[0] = { ...data.compact.providers[0].keys[0], key: 'raw-fixture-secret', key_masked: 'masked-fixture-secret' };
  const h = await harness(data);
  assert.equal(h.get('compact-key').value, '');
  assert.match(h.get('compact-key').innerHTML, /Account Two（k2）/);
  assert.match(h.get('compact-key').innerHTML, /value="k-off" disabled/);
  assert.doesNotMatch(h.get('compact-key').innerHTML + h.get('compact-key-hint').textContent, /raw-fixture-secret|masked-fixture-secret/);
  h.run("pickCompactKey('k2')");
  for (const event of ['input', 'change']) for (const listener of h.get('view-routes').events[event]) listener({ target: h.get('compact-key') });
  assert.equal(h.run('routesDirty'), false);
  assert.equal(h.run('compactDirty'), true);
  const saving = h.run('saveCompact()');
  assert.match(h.get('confirm-text').textContent, /两条压缩规则.*Account Two（k2）.*普通模型.*active_key.*不变/);
  h.run('finishConfirm(true)'); await saving;
  assert.deepEqual(h.requests.findLast(r => r.url === '/api/compact').body, { provider: 'a1', model: 'claude-special', key_id: 'k2', expected_revision: 'rev-one' });
  assert.equal(data.providers.claude[0].active_key, 'k1');
  assert.equal(h.run('compactDraft.key_id'), 'k2');
  assert.equal(h.run('compactDirty'), false);
  h.run("pickCompactProvider('a2')");
  assert.equal(h.run('compactDraft.key_id'), '');
  assert.equal(h.get('compact-key').value, '');
});

test('失效固定 Key 明确保留，不自动改选第一项；刷新后的停用同样显示', async () => {
  const data = fixture();
  data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'single', selection: { provider: 'a1', model: 'claude-special', key_id: 'removed-key' }, providers: [data.providers.claude[0]],
    rules: [{ id: 'compact-global', enabled: true, targets: [{ name: 'Alpha', model: 'claude-special', enabled: true, key_id: 'removed-key', key_label: 'Old Account', key_available: false }] }] };
  const h = await harness(data);
  assert.equal(h.get('compact-key').value, 'removed-key');
  assert.equal(h.run('compactDraft.key_id'), 'removed-key');
  assert.match(h.get('compact-key').innerHTML, /已失效 Key（removed-key）.*保留原选择/);
  assert.match(h.get('compact-current').innerHTML, /Old Account.*Key 不可用/);
  await h.run('saveCompact()');
  assert.equal(h.requests.some(r => r.url === '/api/compact'), false);
  h.run("pickCompactKey('k2')");
  data.compact.providers[0].keys[1].enabled = false;
  await h.run('refresh()');
  assert.equal(h.run('compactDraft.key_id'), 'k2');
  assert.equal(h.get('compact-key').value, 'k2');
  assert.match(h.get('compact-key-hint').textContent, /不可用.*选择仍保留/);
  await h.run('saveCompact()');
  assert.equal(h.requests.some(r => r.url === '/api/compact'), false);
  h.run("pickCompactKey('')");
  await h.confirm('saveCompact()');
  assert.equal(h.requests.findLast(r => r.url === '/api/compact').body.key_id, '');
});

test('Key 草稿在刷新、确认和保存等待期间保持独立，不被保存响应吞掉', async () => {
  const data = fixture();
  data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'single', selection: { provider: 'a1', model: 'claude-special', key_id: '' }, providers: [data.providers.claude[0]], rules: [] };
  const h = await harness(data);
  h.run("pickCompactKey('k2')"); await h.run('refresh()');
  assert.equal(h.get('compact-key').value, 'k2');
  h.run("globalThis.pendingKey = null; const realFetch = fetch; globalThis.fetch = (url, opt) => url === '/api/compact' ? new Promise(resolve => { pendingKey = async () => resolve(await realFetch(url,opt)); }) : realFetch(url,opt)");
  const saving = h.run('saveCompact()');
  h.run("pickCompactKey('k1'); finishConfirm(true)");
  await new Promise(resolve => setImmediate(resolve));
  h.run("pickCompactKey('')"); await h.run('refresh()');
  await h.run('pendingKey()'); await saving;
  assert.equal(h.requests.findLast(r => r.url === '/api/compact').body.key_id, 'k2');
  assert.equal(h.run('compactDraft.key_id'), '');
  assert.equal(h.get('compact-key').value, '');
  assert.equal(h.run('compactDirty'), true);
  assert.equal(h.run('routesDirty'), false);
});

test('压缩窗口显示各层来源与覆盖警告，不自动写配置', async () => {
  const data = fixture();
  data.window = { scope: 'global', value: 1000000, revision: 'window-one',
    layers: [{ scope: 'global', file: '/home/test/.claude/settings.json', exists: true, value: 1000000, env_override: false },
      { scope: 'project', file: '/project/.claude/settings.json', exists: true, value: 256000, env_override: false },
      { scope: 'local', file: '/project/.claude/settings.local.json', exists: false, value: 'auto', env_override: false }],
    configured: { value: 256000, source: 'project' }, warnings: ['所选层被 project 层覆盖'] };
  const h = await harness(data);
  h.run("document.getElementById('window-project').value='/project'");
  await h.run('loadCompactWindow()');
  assert.match(h.get('window-current').textContent, /1000000/);
  assert.match(h.get('window-layers').innerHTML, /256000/);
  assert.match(h.get('window-warnings').textContent, /project 层覆盖/);
  assert.match(h.get('window-restart').textContent, /不会热改.*新开会话.*\/autocompact/);
  assert.equal(h.requests.some(r => r.url.startsWith('/api/compact/window') && r.method === 'POST'), false);
});

test('被项目覆盖的全局保存显著告知无效，可只读取覆盖层而不写配置', async () => {
  const data = fixture(); data.window = { value: 255000,
    layers: [{ scope: 'global', file: '/home/test/.claude/settings.json', exists: true, value: 255000 },
      { scope: 'project', file: '/project/.claude/settings.json', exists: true, value: 256000 }] };
  const h = await harness(data);
  h.run("document.getElementById('window-project').value='/project'");
  await h.run('loadCompactWindow()');
  assert.match(h.get('window-coverage-text').textContent, /被项目层覆盖.*256000.*不会改变/);
  assert.equal(h.get('window-edit-override').hidden, false);
  assert.equal(h.get('window-coverage').classList.contains('offline'), true);
  h.run("setWindowValue('500k')");
  const saving = h.run('saveCompactWindow()');
  assert.match(h.get('confirm-text').textContent, /全局只改全局.*被项目层覆盖.*不会改变/);
  h.run('finishConfirm(true)'); await saving;
  assert.match(h.get('window-msg').textContent, /仍被项目层覆盖.*256000/);
  assert.match(h.get('toast').textContent, /仍被项目层覆盖.*不会改变/);
  assert.equal(data.window.layers[1].value, 256000);
  const postCount = h.requests.filter(r => r.method === 'POST').length;
  await h.run('editWindowOverride()');
  assert.equal(h.get('window-scope').value, 'project');
  assert.equal(h.get('window-value').value, '256000');
  assert.equal(h.requests.findLast(r => r.url.startsWith('/api/compact/window')).url, '/api/compact/window?scope=project&project=%2Fproject');
  assert.equal(h.requests.filter(r => r.method === 'POST').length, postCount, '跳到覆盖层只读取，不能自动删除或同步');
  assert.equal(h.get('window-edit-override').hidden, true);
});

test('未知项目与环境覆盖在确认及保存结果中都保持显著，auto 不声称清除覆盖', async () => {
  const data = fixture(); data.window = { value: 255000, environment_override: true };
  const h = await harness(data); await h.run('loadCompactWindow()');
  assert.match(h.get('window-coverage-text').textContent, /项目未检查.*环境覆盖.*不能清除/);
  assert.equal(h.get('window-edit-override').hidden, true);
  h.run("setWindowValue('auto')");
  const saving = h.run('saveCompactWindow()');
  assert.match(h.get('confirm-text').textContent, /只删除这一层.*不删除其他层或环境.*项目未检查.*不能清除/);
  h.run('finishConfirm(true)'); await saving;
  for (const id of ['window-msg', 'toast']) assert.match(h.get(id).textContent, /项目未检查.*环境覆盖.*不能清除/);
  assert.match(h.get('window-restart').textContent, /claude --continue.*\/autocompact <值>.*写用户层.*项目或环境覆盖/);
  assert.equal(h.requests.filter(r => r.url.startsWith('/api/compact/window?')).length, 1, '不扫描未知项目');
});

test('编辑覆盖层先处理草稿，目录变化不能误用旧覆盖信息', async () => {
  const data = fixture(); data.window = { layers: [
    { scope: 'global', file: '/home/test/.claude/settings.json', exists: true, value: 255000 },
    { scope: 'project', file: '/project/.claude/settings.json', exists: true, value: 256000 },
    { scope: 'local', file: '/project/.claude/settings.local.json', exists: true, value: 350000 }] };
  const h = await harness(data);
  h.run("document.getElementById('window-project').value='/project'; document.getElementById('window-scope').value='project'");
  await h.run('loadCompactWindow()'); h.run("setWindowValue('400k')");
  const canceled = h.run('editWindowOverride()'); h.run('finishConfirm(false)'); await canceled;
  assert.equal(h.get('window-value').value, '400k'); assert.equal(h.get('window-scope').value, 'project');
  const load = h.run('editWindowOverride()'); h.run('finishConfirm(true)'); await load;
  assert.equal(h.get('window-scope').value, 'local'); assert.equal(h.get('window-value').value, '350000');
  assert.match(h.get('window-current').textContent, /settings.local.json/);
  assert.equal(h.requests.some(r => r.method === 'POST'), false);
  h.run("document.getElementById('window-project').value='/another'; windowProjectChanged()");
  assert.equal(h.get('window-edit-override').hidden, true);
  assert.match(h.get('window-coverage-text').textContent, /尚未检查/);
});

test('窗口读取期间的新值保留且覆盖提示仍更新，保存期间换目录不会重绘旧值', async () => {
  const h = await harness();
  h.run("globalThis.pendingRead = null; const realFetch = fetch; globalThis.fetch = (url, opt) => url.startsWith('/api/compact/window?') ? new Promise(resolve => { pendingRead = async () => resolve(await realFetch(url,opt)); }) : realFetch(url,opt)");
  const loading = h.run('loadCompactWindow()'); h.run("setWindowValue('400k')");
  await h.run('pendingRead()'); await loading;
  assert.equal(h.get('window-value').value, '400k'); assert.equal(h.run('windowDirty'), true);
  assert.match(h.get('window-coverage-text').textContent, /项目未检查/);
  h.run("globalThis.fetch = (url, opt) => url === '/api/compact/window' ? new Promise(resolve => { pendingRead = async () => resolve(await realFetch(url,opt)); }) : realFetch(url,opt)");
  const saving = h.run('saveCompactWindow()'); h.run('finishConfirm(true)');
  await new Promise(resolve => setImmediate(resolve));
  h.run("document.getElementById('window-project').value='/next-project'; windowProjectChanged(); setWindowValue('500k')");
  await h.run('pendingRead()'); await saving;
  assert.equal(h.get('window-project').value, '/next-project'); assert.equal(h.get('window-value').value, '500k');
  assert.equal(h.run('windowDirty'), true);
  assert.match(h.get('window-msg').textContent, /项目未检查.*目录已变化.*草稿保留/);
});

test('窗口重新读取确认期间的新值不能丢失，保存期间未完成目录输入不误报保存失败', async () => {
  const h = await harness(); await h.run('loadCompactWindow()');
  h.run("setWindowValue('300k')");
  const count = h.requests.length;
  const loading = h.run('loadCompactWindow()');
  h.run("setWindowValue('400k'); finishConfirm(true)"); await loading;
  assert.equal(h.requests.length, count);
  assert.equal(h.get('window-value').value, '400k'); assert.equal(h.run('windowDirty'), true);
  h.run("globalThis.pendingSave = null; const realFetch = fetch; globalThis.fetch = (url, opt) => url === '/api/compact/window' ? new Promise(resolve => { pendingSave = async () => resolve(await realFetch(url,opt)); }) : realFetch(url,opt)");
  const saving = h.run('saveCompactWindow()'); h.run('finishConfirm(true)');
  await new Promise(resolve => setImmediate(resolve));
  h.run("document.getElementById('window-project').value='unfinished'; windowProjectChanged()");
  await h.run('pendingSave()'); await saving;
  assert.match(h.get('window-msg').textContent, /已保存到所选磁盘文件.*目录已变化/);
  assert.doesNotMatch(h.get('window-msg').textContent, /保存失败/);
  assert.equal(h.get('window-project').value, 'unfinished');
});

test('压缩窗口按绝对项目路径选择层，auto 明确继承并带 revision 保存', async () => {
  const data = fixture(); data.window = { value: 256000, revision: 'window-one',
    layers: [{ scope: 'global', file: '/home/test/.claude/settings.json', exists: true, value: 1000000, env_override: false },
      { scope: 'project', file: '/project/.claude/settings.json', exists: true, value: 256000, env_override: false }],
    configured: { value: 256000, source: 'project' } };
  const h = await harness(data);
  h.run("document.getElementById('window-project').value='/project'; document.getElementById('window-scope').value='project'");
  await h.run('loadCompactWindow()');
  assert.equal(h.get('window-value').value, '256000');
  h.run("setWindowValue('auto')");
  const saving = h.run('saveCompactWindow()');
  assert.match(h.get('confirm-text').textContent, /继承/);
  h.run('finishConfirm(true)'); await saving;
  const req = h.requests.findLast(r => r.url === '/api/compact/window' && r.method === 'POST');
  assert.deepEqual(req.body, { scope: 'project', project: '/project', value: 'auto', expected_revision: 'window-one' });
  assert.match(h.get('window-restart').textContent, /新开会话/);
});

test('压缩窗口拒绝相对路径和越界值，刷新不覆盖未保存草稿', async () => {
  const h = await harness(); await h.run('loadCompactWindow()');
  h.run("document.getElementById('window-project').value='relative'; document.getElementById('window-scope').value='local'");
  await h.run('loadCompactWindow()');
  assert.match(h.get('window-msg').textContent, /绝对路径/);
  h.run("document.getElementById('window-project').value='/project'; document.getElementById('window-scope').value='global'");
  await h.run('loadCompactWindow()');
  h.run("setWindowValue('99999')"); await h.run('saveCompactWindow()');
  assert.equal(h.requests.some(r => r.url === '/api/compact/window' && r.method === 'POST'), false);
  h.run("setWindowValue('300k')"); await h.run('refresh()');
  assert.equal(h.get('window-value').value, '300k');
  assert.equal(h.run('windowDirty'), true);
});

test('窗口读取和保存期间的新输入不丢失，确认期间改值不提交旧值', async () => {
  const h = await harness(); await h.run('loadCompactWindow()');
  h.run("setWindowValue('300k'); globalThis.pendingWindow = null; const originalFetch = fetch; globalThis.fetch = (url, opt) => url === '/api/compact/window' && opt?.method === 'POST' ? new Promise(resolve => { pendingWindow = async () => resolve(await originalFetch(url,opt)); }) : originalFetch(url,opt)");
  const saving = h.run('saveCompactWindow()'); h.run('finishConfirm(true)');
  await new Promise(resolve => setImmediate(resolve));
  h.run("setWindowValue('400k')"); await h.run('pendingWindow()'); await saving;
  assert.equal(h.get('window-value').value, '400k');
  assert.equal(h.run('windowDirty'), true);
  assert.equal(h.requests.findLast(r => r.url === '/api/compact/window' && r.method === 'POST').body.value, 300000);
  const again = h.run('saveCompactWindow()'); h.run("setWindowValue('500k'); finishConfirm(true)"); await again;
  assert.equal(h.requests.filter(r => r.url === '/api/compact/window' && r.method === 'POST').length, 1);
  assert.equal(h.get('window-value').value, '500k');
  assert.match(h.get('window-msg').textContent, /重新确认/);
});

test('项目符号链接经服务端规范化后可保存，异步读取不覆盖后输目录', async () => {
  const h = await harness();
  h.run("document.getElementById('window-project').value='/tmp/window-project'; document.getElementById('window-scope').value='project'");
  await h.run('loadCompactWindow()');
  assert.equal(h.get('window-project').value, '/private/tmp/window-project');
  h.run("setWindowValue('300k')");
  const saving = h.run('saveCompactWindow()'); h.run('finishConfirm(true)'); await saving;
  const posted = h.requests.findLast(r => r.url === '/api/compact/window' && r.method === 'POST');
  assert.equal(posted.body.project, '/private/tmp/window-project');
  assert.equal(posted.body.value, 300000);

  h.run("document.getElementById('window-project').value='/tmp/window-project'; windowProjectChanged(); globalThis.pendingCanonical = null; const realFetch = fetch; globalThis.fetch = (url, opt) => url.startsWith('/api/compact/window?') ? new Promise(resolve => { pendingCanonical = async () => resolve(await realFetch(url,opt)); }) : realFetch(url,opt)");
  const loading = h.run('loadCompactWindow()');
  await new Promise(resolve => setImmediate(resolve));
  h.run("document.getElementById('window-project').value='/tmp/another-project'; windowProjectChanged()");
  await h.run('pendingCanonical()'); await loading;
  assert.equal(h.get('window-project').value, '/tmp/another-project');
});

test('窗口面板事件不污染通用路由草稿，未保存窗口值阻止离页', async () => {
  const data = fixture(); data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'single', selection: { provider: 'a1', model: 'claude-special', key_id: '' }, providers: [data.providers.claude[0]], rules: [] };
  const h = await harness(data); await h.run('loadCompactWindow()');
  h.run("setWindowValue('300k')");
  for (const event of ['input', 'change']) for (const listener of h.get('view-routes').events[event]) {
    listener({ target: h.get('window-value') });
    listener({ target: h.get('window-scope') });
  }
  assert.equal(h.run('routesDirty'), false);
  assert.equal(h.get('save-compact').disabled, false, '窗口草稿不得锁定独立压缩模型控件');
  const beforeUnload = h.windowListeners.get('beforeunload');
  assert.ok(beforeUnload?.length);
  let prevented = false;
  const event = { preventDefault() { prevented = true; }, returnValue: undefined };
  for (const listener of beforeUnload) listener(event);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, '');
});

test('渠道直连开关读取并提交布尔值，不触碰客户端配置', async () => {
  const data = fixture(); data.providers.claude[0].direct = true;
  const h = await harness(data);
  // 默认视图已改为「概览」,渠道卡片的渲染只在渠道页进行 —— 本用例要先站在渠道页上
  h.run("view = 'providers'; renderProviders()");
  assert.match(h.get('prov-grid').innerHTML, /<span class="tag">直连<\/span>/);
  h.run("openProvider('a1')");
  assert.equal(h.get('m-direct').checked, true);
  h.get('m-direct').checked = false;
  await h.run('saveProvider()');
  assert.equal(h.requests.findLast(r => r.url === '/api/providers/a1' && r.method === 'PUT').body.direct, false);
  h.run('openProvider()');
  assert.equal(h.get('m-direct').checked, false);
  h.get('m-name').value = 'Direct'; h.get('m-base').value = 'https://direct.example';
  h.get('m-direct').checked = true;
  await h.run('saveProvider()');
  assert.equal(h.requests.findLast(r => r.url === '/api/providers' && r.method === 'POST').body.direct, true);
  assert.equal(h.requests.some(r => /^\/api\/(switch|router)\//.test(r.url)), false);
});

test('失败分类筛选独立于状态，清空时同时移除 err_class', async () => {
  const h = await harness();
  h.get('f-errclass').value = 'stream_aborted';
  await h.run('loadLogs()');
  let query = new URL(h.requests.findLast(r => r.url.startsWith('/api/logs?')).url, 'http://localhost').searchParams;
  assert.equal(query.get('err_class'), 'stream_aborted');
  assert.equal(query.has('status'), false);
  h.get('f-status').value = 'err';
  await h.run('loadLogs()');
  query = new URL(h.requests.findLast(r => r.url.startsWith('/api/logs?')).url, 'http://localhost').searchParams;
  assert.equal(query.get('status'), 'err');
  assert.equal(query.get('err_class'), 'stream_aborted');
  h.run('clearFilters()');
  assert.equal(h.get('f-errclass').value, '');
  assert.equal(h.get('f-status').value, '');
});

function slotStatsFixture() {
  return { reqs: 28, ok_rate: 100, inTok: 900, outTok: 90, cache: 7,
    by_slot: {
      subagent: { reqs: 23, in: 12345, out: 678, cache: 91 },
      none: { reqs: 3, in: 10, out: 0, cache: 0 },
      unknown: { reqs: 2, in: 20, out: 3, cache: 1 },
    },
    scope: { source: 'memory', timezone: 'UTC', capacity: 500, since: null, until: null, inclusive: true },
    range: { from: '2026-09-28T23:30:00.000Z', to: '2026-09-29T01:15:00.000Z' },
  };
}
function mockSlotStats(h, stats) {
  h.run(`globalThis.slotStatsResponse = ${JSON.stringify(stats)};
    globalThis.statsFetch = fetch;
    fetch = async (url, options) => url === '/api/stats'
      ? { ok: true, json: async () => structuredClone(slotStatsResponse) } : statsFetch(url, options);`);
}

test('请求日志页分槽表使用真实 stats.by_slot，不从日志、模型别名或当前配置重推', async () => {
  const data = fixture();
  data.stats.by_slot = { wrongStateSlot: { reqs: 999, in: 999, out: 999, cache: 999 } };
  const h = await harness(data), stats = slotStatsFixture();
  stats.by_slot['<img src=x onerror="bad()">'] = { reqs: 1, in: 2, out: 3, cache: 4 };
  stats.by_slot.constructor = { reqs: 5, in: 6, out: 7, cache: 8 };
  mockSlotStats(h, stats);
  h.get('f-app').value = 'codex'; h.get('f-model').value = 'mixr-main';
  await h.run('loadLogs(); loadStats()');
  const rows = h.get('slot-stats-body').innerHTML;
  assert.match(rows, /subagent<\/th><td>23<\/td><td>12345<\/td><td>678<\/td><td>91<\/td>/);
  assert.match(rows, /未命中槽（none）/);
  assert.match(rows, /旧日志未知（unknown）/);
  assert.match(rows, /<th scope="row">constructor<\/th><td>5<\/td>/);
  assert.match(rows, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/);
  assert.doesNotMatch(rows, /<img|wrongStateSlot|mixr-main/);
  assert.equal(h.get('logs-body').innerHTML, '', '空日志列表不能让服务器分槽统计归零');
  assert.equal(h.get('slot-stats-table').hidden, false);
  assert.match(h.get('slot-stats-scope').textContent, /内存.*500.*不是全天.*不是费用.*日志筛选.*独立/);
  assert.match(h.get('slot-stats-scope').textContent, /2026-09-28T23:30:00.000Z.*2026-09-29T01:15:00.000Z.*UTC/);
  assert.match(html, /id="slot-stats-title">分槽用量/);
});

test('分槽统计区分空窗口、字段未提供、陈旧快照和网络失败，不补假零', async () => {
  const h = await harness();
  await h.run('loadStats()');
  assert.match(h.get('slot-stats-status').textContent, /未提供/);
  assert.equal(h.get('slot-stats-table').hidden, true);
  assert.equal(h.get('slot-stats-body').innerHTML, '');
  const stats = slotStatsFixture();
  stats.by_slot.subagent = { reqs: 23, in: 0, out: null };
  mockSlotStats(h, stats); await h.run('loadStats()');
  assert.match(h.get('slot-stats-body').innerHTML, /subagent<\/th><td>23<\/td><td>0<\/td><td>未提供<\/td><td>未提供<\/td>/);
  const rows = h.get('slot-stats-body').innerHTML;
  h.run('delete slotStatsResponse.by_slot'); await h.run('loadStats()');
  assert.equal(h.get('slot-stats-body').innerHTML, rows);
  assert.match(h.get('slot-stats-status').textContent, /未提供.*陈旧.*上次/);
  h.run("fetch = async () => { throw new Error('simulated stats disconnect'); }");
  await h.run('loadStats()');
  assert.equal(h.get('slot-stats-body').innerHTML, rows);
  assert.match(h.get('slot-stats-status').textContent, /读取失败.*陈旧/);
  assert.match(h.get('logs-error').textContent, /统计读取失败/);
  h.run(`fetch = async () => ({ ok: true, json: async () => (${JSON.stringify({ ...slotStatsFixture(), reqs: 0, by_slot: {}, range: { from: null, to: null } })}) });`);
  await h.run('loadStats()');
  assert.equal(h.get('slot-stats-body').innerHTML, '');
  assert.equal(h.get('slot-stats-table').hidden, true);
  assert.match(h.get('slot-stats-status').textContent, /当前内存窗口没有请求/);
  assert.doesNotMatch(h.get('slot-stats-status').textContent, /陈旧/);
  assert.equal(h.get('logs-error').classList.contains('show'), false);
  const firstFail = await harness();
  firstFail.run("fetch = async () => { throw new Error('offline'); }");
  await firstFail.run('loadStats()');
  assert.match(firstFail.get('slot-stats-status').textContent, /读取失败.*尚无/);
  assert.equal(firstFail.get('slot-stats-body').innerHTML, '');
});

test('分槽统计忽略过期异步响应，刷新不更换编辑节点或丢草稿焦点', async () => {
  const data = fixture();
  data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'single', selection: { provider: 'a1', model: 'claude-special', key_id: '' }, providers: [data.providers.claude[0]], rules: [] };
  const h = await harness(data); mockSlotStats(h, slotStatsFixture());
  h.run("pickCompactModel('__custom__'); setCompactCustom('unfinished-model'); setWindowValue('300k'); routesDraft.rules[0].match = 'unfinished-rule'; markRoutesDirty()");
  const field = h.get('compact-model-custom'); field.value = 'unfinished-model'; field.focus();
  const rules = h.get('rules-box'), writes = rules.htmlWrites;
  h.run('globalThis.pendingStats = []; fetch = () => new Promise(resolve => pendingStats.push(resolve))');
  const first = h.run('loadStats()'), second = h.run('loadStats()');
  h.run('pendingStats[1]({ ok: true, json: async () => slotStatsResponse })'); await second;
  const currentRows = h.get('slot-stats-body').innerHTML;
  h.run('pendingStats[0]({ ok: true, json: async () => ({ reqs: 0 }) })'); await first;
  assert.equal(h.get('slot-stats-body').innerHTML, currentRows);
  assert.doesNotMatch(h.get('slot-stats-status').textContent, /未提供|陈旧/);
  h.run('fetch = statsFetch'); await h.run('refresh()');
  assert.equal(h.get('compact-model-custom'), field);
  assert.equal(h.document.activeElement, field);
  assert.equal(field.value, 'unfinished-model');
  assert.equal(h.get('window-value').value, '300k');
  assert.equal(h.run('routesDraft.rules[0].match'), 'unfinished-rule');
  assert.equal(rules.htmlWrites, writes);
});

test('日志页进入与五秒自动刷新都读取分槽统计，关闭刷新后不请求', async () => {
  const h = await harness(); mockSlotStats(h, slotStatsFixture());
  h.run('document.querySelector(\'nav a[data-view="diagnostics"]\').click()');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.get('slot-stats-body').innerHTML, /subagent<\/th><td>23<\/td>/);
  const filter = h.get('f-model'); filter.value = 'unfinished-filter'; filter.focus();
  h.run('slotStatsResponse.by_slot.subagent.reqs = 29');
  h.intervals.get(h.run('logsTimer'))();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.get('slot-stats-body').innerHTML, /subagent<\/th><td>29<\/td>/);
  assert.equal(h.document.activeElement, filter);
  assert.equal(filter.value, 'unfinished-filter');
  h.get('logs-auto').checked = false;
  h.run('slotStatsResponse.by_slot.subagent.reqs = 31');
  h.intervals.get(h.run('logsTimer'))();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.get('slot-stats-body').innerHTML, /subagent<\/th><td>29<\/td>/);
});

test('会话搜索按短 id / 完整 id / 对话名 / 渠道名子串过滤,并与协议组筛选叠加', async () => {
  const h = await harness();
  h.run("view = 'sessions'; renderSessions()");
  const rows = () => (h.get('sess-body').innerHTML.match(/<tr data-session=/g) || []).length;
  // 搜索词是顶层 let,测试直接读写它(和界面上的 setSessQuery 同一条路径)
  const search = value => { h.get('sess-search').value = value; h.run('setSessQuery(document.getElementById("sess-search").value)'); return rows(); };

  assert.equal(rows(), 3, '没有筛选时三条会话都在');
  assert.equal(search('bbb'), 1, '短 id 子串');
  assert.equal(search('sess-ui-alpha'), 1, '完整 id 子串');
  assert.equal(search('重构压缩'), 1, '对话名(label)子串');
  assert.equal(search('Beta'), 1, '绑定渠道名子串');
  assert.equal(search('beta'), 1, '渠道名不分大小写');
  assert.equal(search('o1'), 1, '渠道 id 也是搜索面');
  assert.equal(search('无此会话'), 0);
  assert.equal(h.run('sessQuery'), '无此会话');

  // 与协议组筛选叠加:同一个词在两组里各自过滤,不是二选一
  search('');
  h.get('f-sess-app').value = 'claude'; h.run("sessApp='claude'; renderSessions()");
  assert.equal(rows(), 2, '只看 Claude 组');
  h.run('setSessQuery("修复")');
  assert.equal(rows(), 1, '两组条件同时生效');
  h.get('f-sess-app').value = 'codex'; h.run("sessApp='codex'; renderSessions()");
  assert.equal(rows(), 0, '换成 Codex 组后那个词没有命中');
  // 空表要分清"搜索筛没了"和"这个组本来就没有",并给一条清除搜索的路
  assert.match(h.get('sess-empty-title').textContent, /没有匹配当前搜索与筛选的会话/);
  assert.match(h.get('sess-empty-hint').textContent, /共 3 个会话/);
  assert.equal(h.get('sess-empty-action').hidden, false);
  assert.match(h.get('sess-empty-action').textContent, /清除搜索/);
  // 筛空时把现有短 id 摆出来,用户能对照着自己到底差在哪
  assert.equal(h.get('sess-empty-why').hidden, false);
  assert.match(h.get('sess-empty-why').textContent, /aaa11111、bbb22222、ccc33333/);
  h.get('sess-empty-action').click();
  assert.equal(h.run('sessQuery'), '');
  assert.equal(h.run('sessApp'), '');
  assert.equal(rows(), 3, '清除后回到全部会话');
  assert.equal(h.get('sess-empty').style.display, 'none', '有会话时空表要收起来');
});

test('搜索只重渲染,不动服务端快照与任何草稿', async () => {
  const data = fixture();
  data.routes_revision = 'rev-one';
  data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'single', selection: { provider: 'a1', model: 'claude-special', key_id: '' },
    providers: [data.providers.claude[0]], rules: [] };
  const h = await harness(data);
  h.run("view = 'routes'");
  h.run("routesDraft.rules[0].match = 'edited-by-user'; markRoutesDirty()");
  h.run("pickCompactProvider('a1'); pickCompactModel('__custom__'); setCompactCustom('draft-model')");
  const sessionsBefore = h.run('JSON.stringify(state.sessions)');
  const writesBefore = h.requests.length;

  h.run("view = 'sessions'; renderSessions()");
  h.run("setSessQuery('bbb')");
  assert.equal(h.run('JSON.stringify(state.sessions)'), sessionsBefore, '搜索不得改动服务端快照里的会话');
  assert.equal(h.run('state.sessions.length'), 3, '被筛掉的行仍然留在 state 里');
  assert.equal(h.run('routesDraft.rules[0].match'), 'edited-by-user', '通用路由草稿不受影响');
  assert.equal(h.run('compactDraft.model'), 'draft-model', '压缩草稿不受影响');
  assert.equal(h.run('routesDirty'), true);
  assert.equal(h.run('compactDirty'), true);
  assert.equal(h.requests.length, writesBefore, '搜索不发任何请求(尤其不能把被筛掉的会话删掉)');

  // 轮询把服务端那份带回来:搜索词是界面草稿,不能被重渲染抹掉
  await h.run('refresh()');
  assert.equal(h.run('sessQuery'), 'bbb');
  assert.equal(h.get('sess-search').value, 'bbb');
  assert.equal((h.get('sess-body').innerHTML.match(/<tr data-session=/g) || []).length, 1);
});

test('搜索框有焦点时五秒轮询不重渲染,用户敲了一半的词不被抹掉', async () => {
  const h = await harness();
  h.run("view = 'sessions'; renderSessions()");
  const writes = h.get('sess-body').htmlWrites;
  // 焦点在搜索框上,但 sessQuery 还是旧的(用户刚敲进去、oninput 尚未触发的那种时刻)
  h.get('sess-search').focus();
  h.get('sess-search').value = 'bbb';
  await h.run('refresh()');
  assert.equal(h.get('sess-body').htmlWrites, writes, '搜索框有焦点时不重渲染会话表');
  assert.equal(h.get('sess-search').value, 'bbb', '正在敲的词不能被轮询回填成旧的搜索词');
  assert.equal(h.run('sessQuery'), '', 'sessQuery 是数据,不受输入框草稿影响');

  // 焦点离开后轮询恢复重渲染,搜索词这才跟着走
  h.element('outside-sessions').focus();
  h.run("setSessQuery('bbb')");
  const after = h.get('sess-body').htmlWrites;
  await h.run('refresh()');
  assert.ok(h.get('sess-body').htmlWrites > after, '没有焦点时轮询照常刷新');
});

test('五个固定槽无 fable，模型编辑保持备池的部分更新语义', async () => {
  const data = fixture();
  data.slots.claude[0].pool = [{ provider: 'a2', model: 'backup-model' }];
  data.slots.claude[0].strategy = 'priority';
  const h = await harness(data);
  assert.equal(h.run('Object.keys(SLOT_LABELS).length'), 5);
  assert.equal(h.run('SLOT_LABELS.fable'), undefined);
  assert.doesNotMatch(h.get('slots-rows').innerHTML, /mixr-fable/);
  await h.run("setSlot('claude', 'main', 'model', 'new-model')");
  const body = h.requests.findLast(r => r.url === '/api/slots' && r.method === 'PUT').body;
  assert.deepEqual(body, { claude: { main: { provider: 'a1', model: 'new-model' } } });
  assert.deepEqual(data.slots.claude[0].pool, [{ provider: 'a2', model: 'backup-model' }]);
});

test('ZCode is a client over two protocol stores; counts never duplicate the repository', async () => {
  const h = await harness();
  h.run("setApp('zcode'); setZcodeWire('anthropic')");
  assert.equal(h.run('providerGroup()'), 'claude');
  assert.equal(h.run('providers().length'), 2);
  assert.equal(h.get('count-zcode').textContent, 4);
  assert.equal(h.get('metric-providers').textContent, 2);
  assert.equal(h.get('metric-requests').textContent, '12');
  assert.equal(h.get('metric-tokens').textContent, '140');
  for (const wire of ['responses', 'chat']) {
    h.run(`setZcodeWire('${wire}')`);
    assert.equal(h.run('providerGroup()'), 'codex');
    assert.equal(h.run('providers().length'), 2); // No hard filtering by wire.
    assert.equal((h.get('prov-grid').innerHTML.match(/<article /g) || []).length, 2);
  }
  assert.equal(h.run('state.providers.zcode'), undefined);
  h.run("setApp('claude')");
  assert.equal(h.run('providerGroup()'), 'claude');
});

test('provider search combines name, URL, models, slots and enabled-state filters', async () => {
  const h = await harness();
  const search = (query, filter = 'all') => {
    h.get('provider-search').value = query; h.get('provider-filter').value = filter; h.run('renderProviders()');
    return (h.get('prov-grid').innerHTML.match(/<article /g) || []).length;
  };
  for (const query of ['ALPHA', 'anthropic.example', 'CLAUDE-SPECIAL', 'slot-model']) assert.equal(search(query), 1);
  assert.equal(search('claude', 'enabled'), 1);
  assert.equal(search('claude', 'disabled'), 1);
  assert.equal(search('ALPHA', 'disabled'), 0);
  assert.equal(h.get('prov-empty').hidden, false);
  h.get('empty-action').onclick();
  assert.equal(h.get('provider-search').value, '');
  assert.equal(h.get('provider-filter').value, 'all');
  h.run("setApp('zcode'); setZcodeWire('chat')");
  assert.equal(search('gpt-test'), 1);
  assert.equal(search('missing-model'), 0);
});

test('多 Key 弹窗:老式单 Key 渠道预置「账号1」,顶栏那行不再覆盖生效 Key', async () => {
  const data = fixture();
  // 服务端 publicProvider 会把"只有 api_key"的老渠道合成一条固定 id 的「账号1」,夹具照这个形状给
  data.providers.claude[0] = { ...data.providers.claude[0], has_key: true, key_masked: 'sk-leg…0001',
    keys: [{ id: 'klegacy', label: '账号1', key_masked: 'sk-leg…0001' }], active_key: 'klegacy' };
  const h = await harness(data);
  h.run("view = 'providers'; renderProviders()");   // 渠道卡片只在渠道页渲染
  assert.match(h.get('prov-grid').innerHTML, /<select class="keypick"/);   // 卡片上有可点的账号下拉
  assert.match(h.get('prov-grid').innerHTML, /账号1/);

  h.run("openProvider('a1')");
  assert.equal(h.run('keyDraft.length'), 1);            // 不是空白清单:老 Key 看得见、留得住
  assert.equal(h.run('keyDraft[0].id'), 'klegacy');
  assert.match(h.get('m-key-hint').textContent, /清单/);

  h.run('addKeyDraft()');
  h.run("keyDraft[1].label = '账号2'; keyDraft[1].key = 'sk-second-0002'");
  h.get('m-key').value = '';                            // 顶栏那个单行 API Key 留空
  await h.run('saveProvider()');
  const put = h.requests.findLast(r => r.method === 'PUT' && r.url === '/api/providers/a1');
  assert.equal(put.body.api_key, '', '有清单时顶栏那把不参与保存,免得覆盖生效 Key');
  assert.deepEqual(put.body.keys, [
    { id: 'klegacy', label: '账号1', key: '' },         // 留空=不改,由服务端解析回原 Key
    { id: '', label: '账号2', key: 'sk-second-0002' },
  ]);
});

test('ZCode create/edit saves use the selected protocol group, including chat default', async () => {
  const h = await harness();
  for (const [wire, group] of [['anthropic', 'claude'], ['responses', 'codex'], ['chat', 'codex']]) {
    h.run(`setApp('zcode'); setZcodeWire('${wire}'); openProvider()`);
    h.get('m-name').value = 'New channel'; h.get('m-base').value = 'https://new.example/v1'; h.get('m-model').value = 'model-a';
    await h.run('saveProvider()');
    const req = h.requests.filter(r => r.method === 'POST' && r.url === '/api/providers').at(-1);
    assert.equal(req.body.app, group);
    if (group === 'codex') assert.equal(req.body.wire_api, wire);
    assert.equal(h.get('workspace').inert, false);
  }
  h.run("setZcodeWire('chat'); openProvider('o1')");
  assert.equal(h.get('m-wire').value, 'responses'); // Preserve actual channel protocol when editing.
  await h.run('saveProvider()');
  const edited = h.requests.findLast(r => r.method === 'PUT' && r.url === '/api/providers/o1');
  assert.equal(edited.body.app, 'codex');
  assert.equal(edited.body.wire_api, 'responses');
  assert.equal(h.requests.some(r => r.body?.app === 'zcode'), false);
});

test('ZCode switch sends app=zcode; router sends the chosen wire; other clients preserve empty bodies', async () => {
  const h = await harness();
  h.run("setApp('zcode'); setZcodeWire('responses')");
  await h.confirm("switchProvider('o1')");
  assert.deepEqual(h.requests.findLast(r => r.url === '/api/switch/o1').body, { app: 'zcode' });
  h.run("setZcodeWire('chat')");
  await h.confirm('switchRouterMode()');
  assert.deepEqual(h.requests.findLast(r => r.url === '/api/router/zcode').body, { wire_api: 'chat' });
  assert.equal(h.run("routerBase('zcode')"), h.data.router.zcode_base);
  delete h.data.router.zcode_base; await h.run('refresh()');
  assert.equal(h.run("routerBase('zcode')"), h.data.router.url);
  h.run("setApp('claude')");
  await h.confirm("switchProvider('a1')");
  assert.equal(h.requests.findLast(r => r.url === '/api/switch/a1').body, undefined);
  h.run("setApp('codex')"); await h.confirm('switchRouterMode()');
  assert.equal(h.requests.findLast(r => r.url === '/api/router/codex').body, undefined);
});

test('Codex slot apply requires main/reviewer and posts only to Codex', async () => {
  const h = await harness();
  h.run("setApp('codex')");
  assert.equal(h.get('slots-apply').hidden, false);
  await h.run('applySlotsClaude()');
  assert.equal(h.requests.some(r => r.method === 'POST'), false);
  h.data.slots.codex = ['main', 'reviewer'].map(name => ({
    name, alias: 'mixr-' + name, provider: 'o1', provider_name: 'Beta', enabled: true, model: 'gpt-test',
  }));
  await h.run('refresh()');
  await h.confirm('applySlotsClaude()');
  assert.deepEqual(h.requests.findLast(r => r.url === '/api/router/codex').body, { slots: true });
  assert.equal(h.requests.some(r => r.method === 'POST' && r.url === '/api/router/claude'), false);
});

test('old backend cannot receive ZCode write requests that might target another client', async () => {
  const data = fixture(); delete data.current.zcode; delete data.live.zcode;
  const h = await harness(data);
  h.run("setApp('zcode')");
  assert.equal(h.get('btn-router').disabled, true);
  await h.run("switchProvider('a1')"); await h.run('switchRouterMode()');
  assert.equal(h.requests.some(r => r.method === 'POST'), false);
});

test('polling preserves route DOM identity, focus, drafts, and unsaved values across views', async () => {
  const h = await harness();
  h.run("view = 'routes'");
  const input = h.get('rule-0-match'), rules = h.get('rules-box'), defaults = h.get('def-box');
  input.focus(); input.value = 'unfinished, draft';
  h.run("routesDraft.rules[0].match = 'unfinished, draft'; markRoutesDirty()");
  const before = [rules.htmlWrites, defaults.htmlWrites];
  h.data.routes.rules[0].match = 'external-update';
  for (let n = 0; n < 3; n++) await h.run('refresh()');
  assert.deepEqual([rules.htmlWrites, defaults.htmlWrites], before);
  assert.equal(h.get('rule-0-match'), input);
  assert.equal(h.document.activeElement, input);
  assert.equal(input.value, 'unfinished, draft');
  assert.equal(h.run('routesDraft.rules[0].match'), 'unfinished, draft');
  assert.equal(h.run('routesDirty'), true);
  h.run("view = 'providers'"); await h.run('refresh()'); h.run("view = 'routes'"); await h.run('refresh()');
  assert.deepEqual([rules.htmlWrites, defaults.htmlWrites], before);
  await h.confirm('reloadRoutes()');
  assert.equal(h.run('routesDraft.rules[0].match'), 'external-update');
  assert.equal(h.run('routesDirty'), false);
});

test('disconnect leaves a labelled stale snapshot, not a green online state, then recovers', async () => {
  const h = await harness();
  // 默认视图是「概览」;渠道页的控件(liveinfo / btn-router)只在渠道页渲染,本用例先切过去
  h.run("view = 'providers'; renderProviders()");
  assert.equal(h.document.body.dataset.connection, 'online');
  assert.equal(h.run('online'), true);
  const before = h.get('metric-requests').textContent;
  h.disconnect(); await h.run('refresh()');
  assert.equal(h.document.body.dataset.connection, 'offline');
  assert.equal(h.run('online'), false);
  assert.equal(h.get('connection-banner').classList.contains('show'), true);
  assert.equal(h.get('btn-router').disabled, true);
  assert.equal(h.get('metric-requests').textContent, before);
  assert.equal(h.get('liveinfo').innerHTML.includes('mode-card selected'), false);
  const writes = h.requests.filter(r => r.method !== 'GET').length;
  await h.run("switchProvider('a1')");
  assert.equal(h.requests.filter(r => r.method !== 'GET').length, writes);
  h.disconnect(false); h.data.stats.reqs = 20; await h.run('refresh()');
  assert.equal(h.get('metric-requests').textContent, '20');
  assert.equal(h.document.body.dataset.connection, 'online');
  assert.equal(h.get('connection-banner').classList.contains('show'), false);
});

test('dialog traps Tab in both directions, Escape cancels and returns focus, tabs support arrows', async () => {
  const h = await harness();
  const opener = h.get('new-provider'); opener.focus(); h.run('openProvider()');
  assert.equal(h.get('workspace').inert, true);
  assert.equal(h.document.activeElement, h.get('m-name'));
  const keydown = key => {
    let prevented = false;
    for (const listener of h.listeners.get('keydown')) listener({ ...key, preventDefault() { prevented = true; } });
    return prevented;
  };
  assert.equal(keydown({ key: 'Tab', shiftKey: true }), true);
  assert.equal(h.document.activeElement, h.get('save-provider'));
  assert.equal(keydown({ key: 'Tab', shiftKey: false }), true);
  assert.equal(h.document.activeElement, h.get('m-name'));
  keydown({ key: 'Escape' });
  assert.equal(h.document.activeElement, opener);
  assert.equal(h.get('workspace').inert, false);
  const confirmation = h.run("askConfirm('Delete', 'Are you sure?')");
  keydown({ key: 'Escape' }); assert.equal(await confirmation, false);
  h.tabs.events.keydown[0]({ key: 'End', preventDefault() {} });
  assert.equal(h.run('curApp'), 'zcode');
  assert.equal(h.get('tab-zcode').getAttribute('aria-selected'), 'true');
  assert.equal(h.document.activeElement, h.get('tab-zcode'));
});

test('Codex main/reviewer selectors are always visible and save independently', async () => {
  const data = fixture();
  data.slots.codex = ['main', 'reviewer'].map(name => ({
    name, alias: 'mixr-' + name, provider: 'o1', provider_name: 'Beta', enabled: true, model: 'gpt-test',
  }));
  const h = await harness(data);
  h.run("setApp('codex')");
  assert.equal(h.get('codex-models').hidden, false);
  assert.match(h.get('codex-model-fields').innerHTML, /main · 主模型/);
  assert.match(h.get('codex-model-fields').innerHTML, /reviewer · 审查模型/);
  assert.doesNotMatch(h.get('slots-rows').innerHTML, /setSlot\('codex','main'/);
  await h.run("switchCodexModel('reviewer','o1')");
  assert.deepEqual(h.requests.findLast(r => r.url === '/api/slots' && r.method === 'PUT').body,
    { codex: { reviewer: { provider: 'o1' } } });
  const count = h.requests.length;
  await h.run("switchCodexModel('main','o2')");
  assert.equal(h.requests.length, count, 'disabled providers cannot be selected');
  h.run("setApp('claude')");
  assert.equal(h.get('codex-models').hidden, true);
});

test('provider overview resolves configured slots without claiming a live request result', async () => {
  const data = fixture();
  data.live.codex = { router: true, model: 'mixr-main', base_url: 'http://127.0.0.1:8787/v1', match: true };
  data.slots.codex = [{ name: 'main', alias: 'mixr-main', provider_name: 'Chosen upstream', model: 'chosen-model' }];
  const h = await harness(data);
  h.run("setApp('codex')");
  assert.match(h.get('liveinfo').innerHTML, /Chosen upstream/);
  assert.match(h.get('liveinfo').innerHTML, /chosen-model/);
  assert.match(h.get('liveinfo').innerHTML, /配置供应商/);
  assert.equal(h.get('providers-title').textContent, '渠道与 Key', '标题对所有客户端同一口径');
  h.run("connectionExpanded.codex = true; renderProviders()");
  assert.match(h.get('liveinfo').innerHTML, /connection-details" open/);
  assert.match(html, /<div class="panel" id="slots-panel" hidden>/);
  h.run("setApp('claude')");
  assert.equal(h.run('document.body.dataset.client'), 'claude');
  assert.equal(h.get('providers-title').textContent, '渠道与 Key');
  assert.equal(h.get('providers-subtitle').hidden, false);
  // 摘要不再是 Codex 专属:Claude Code 也要有同一套字段与可展开的连接详情。
  assert.match(h.get('liveinfo').innerHTML, /class="current-config"/);
  assert.match(h.get('liveinfo').innerHTML, /connection-details/);
  assert.equal(h.get('slots-panel').hidden, false);
  assert.match(h.get('slots-rows').innerHTML, /setSlot\('claude','main'/);
});

test('当前配置摘要对三个客户端同构:字段一致、连接详情可展开、展开状态与离线口径都不走样', async () => {
  const h = await harness();
  h.run("view = 'providers'");
  for (const app of ['claude', 'codex', 'zcode']) {
    h.run(`connectionExpanded.${app} = false; setApp('${app}')`);
    const info = h.get('liveinfo').innerHTML;
    for (const field of ['配置供应商', '默认模型', '接入方式', 'connection-details', '连接配置']) assert.match(info, new RegExp(field));
    assert.doesNotMatch(info, /connection-details" open/, `${app} 默认收起`);
  }
  // Codex 路由模式:供应商与模型取槽位,展开状态跨轮询保留且按客户端各记各的
  h.data.live.codex = { router: true, model: 'mixr-main', base_url: 'http://127.0.0.1:8787/v1', match: true };
  h.data.slots.codex = [{ name: 'main', alias: 'mixr-main', provider_name: 'Chosen upstream', model: 'chosen-model' }];
  h.run("connectionExpanded.codex = true; setApp('codex')");
  await h.run('refresh()');
  assert.match(h.get('liveinfo').innerHTML, /Chosen upstream/);
  assert.match(h.get('liveinfo').innerHTML, /chosen-model/);
  assert.match(h.get('liveinfo').innerHTML, /connection-details" open/);
  await h.run('refresh()');
  assert.match(h.get('liveinfo').innerHTML, /connection-details" open/, '5 秒刷新不能把展开状态收回去');
  assert.equal(h.run('connectionExpanded.claude'), false, '展开状态按客户端分开记');
  // 离线:三个客户端一律降级成「待确认」,不许残留「已写入配置」
  h.disconnect(); await h.run('refresh()');
  for (const app of ['claude', 'codex', 'zcode']) {
    h.run(`setApp('${app}')`);
    const info = h.get('liveinfo').innerHTML;
    assert.match(info, /待确认/);
    assert.doesNotMatch(info, /已写入配置/);
  }
});

test('渠道库布局:默认 list,可切 grid,记住偏好,aria-pressed 同步且缺少按钮也不报错', async () => {
  const storage = memoryStorage();
  const h = await harness(fixture(), { storage });
  h.run("view = 'providers'; renderProviders()");
  // 默认是高密度列表;外壳静态里写死的 grid aria-pressed 由 app.js 在首帧改回来
  assert.equal(h.get('prov-grid').dataset.layout, 'list');
  assert.equal(storage.getItem('mixr.provider.layout'), null, '没切换过就不写偏好');
  const listBtn = h.get('provider-layout-list'), gridBtn = h.get('provider-layout-grid');
  assert.equal(listBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(gridBtn.getAttribute('aria-pressed'), 'false');
  h.run("setProviderLayout('grid')");
  assert.equal(h.get('prov-grid').dataset.layout, 'grid');
  assert.equal(storage.getItem('mixr.provider.layout'), 'grid');
  assert.equal(listBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(gridBtn.getAttribute('aria-pressed'), 'true');
  h.run("setProviderLayout('bogus')");
  assert.equal(h.get('prov-grid').dataset.layout, 'list', '非法值回落到 list');
  assert.equal(storage.getItem('mixr.provider.layout'), 'list');
  // 老页面/老测试没有这两个按钮 id 时,切换布局不能抛错(拿不到按钮就只改 dataset)
  h.run("globalThis.__getEl = document.getElementById; document.getElementById = id => (id === 'provider-layout-list' || id === 'provider-layout-grid') ? null : __getEl(id); setProviderLayout('grid'); document.getElementById = __getEl");
  assert.equal(h.get('prov-grid').dataset.layout, 'grid');
  // 新会话按记住的偏好恢复;存储读写抛错时退回可用默认,不让渠道页整页崩
  const restored = await harness(fixture(), { storage: memoryStorage({ 'mixr.provider.layout': 'grid' }) });
  restored.run("view = 'providers'; renderProviders()");
  assert.equal(restored.get('prov-grid').dataset.layout, 'grid');
  const denied = await harness(fixture(), { storage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } });
  denied.run("view = 'providers'; renderProviders(); setProviderLayout('grid')");
  assert.equal(denied.get('prov-grid').dataset.layout, 'grid', '写偏好失败不影响本次切换');
});

test('渠道卡片轮询:正在操作的下拉不被重建,失焦后下一轮刷新补上状态', async () => {
  const h = await harness();
  h.run("view = 'providers'; renderProviders()");
  const grid = h.get('prov-grid');
  // 模拟用户展开卡片上的账号下拉(焦点在 select 上):此刻重建 DOM 会把菜单关掉
  h.run("globalThis.__cardSelect = new document.body.constructor('f','select'); __cardSelect.dataset.provider = 'a1'; __cardSelect.dataset.action = 'key'; __cardSelect.parentElement = document.getElementById('prov-grid'); __cardSelect.focus()");
  const select = h.run('__cardSelect');
  assert.equal(h.document.activeElement, select);
  const writes = grid.htmlWrites;
  h.data.cooldowns = [{ provider: 'a1', until: Date.UTC(2026, 0, 2, 3, 4, 5), name: 'Alpha' }];
  await h.run('refresh()');
  assert.equal(grid.htmlWrites, writes, '焦点在卡片下拉上时不重建 DOM');
  assert.equal(h.document.activeElement, select);
  assert.doesNotMatch(grid.innerHTML, /冷却至/, '这一轮宁可晚一点画,也不打断操作');
  h.element('outside-cards').focus();
  await h.run('refresh()');
  assert.ok(grid.htmlWrites > writes, '失焦后的下一轮恢复刷新');
  assert.match(grid.innerHTML, /冷却至/);
  // 删除渠道后原按钮随卡片消失:焦点要落到还存在的「新建渠道」,不能掉回 body
  h.run("globalThis.__del = new document.body.constructor('del','button'); __del.dataset.provider = 'a2'; __del.dataset.action = 'delete'; __del.parentElement = document.getElementById('prov-grid'); __del.focus()");
  h.data.providers.claude.splice(1, 1);
  await h.run('refresh()');
  assert.equal(h.document.activeElement, h.get('new-provider'));
});

test('视图/客户端切换通知可选 workspace 模块,模块缺席或抛错都不影响主页面', async () => {
  const h = await harness();
  h.run("globalThis.__views = []; globalThis.__apps = []; globalThis.workspaceViewChanged = name => __views.push(name); globalThis.workspaceAppChanged = app => __apps.push(app)");
  h.run("showView('diagnostics')");
  h.run("showView('routes')");
  assert.equal(h.run('JSON.stringify(__views)'), '["diagnostics","routes"]');
  h.run("setApp('codex')");
  h.run("setApp('claude')");
  assert.equal(h.run('JSON.stringify(__apps)'), '["codex","claude"]');
  h.run("delete globalThis.workspaceViewChanged; delete globalThis.workspaceAppChanged; showView('providers'); setApp('zcode')");
  assert.equal(h.run('view'), 'providers', '没有 workspace 模块时视图照常切换');
  assert.equal(h.run('curApp'), 'zcode');
  // 外壳模块抛错:主页面照常切换,错误只记一条 console.error(这里临时接住,免得绿色
  // 测试输出里冒出看着像失败的堆栈)。
  const reported = [];
  const realError = console.error;
  console.error = (...args) => reported.push(args);
  try {
    h.run("globalThis.workspaceViewChanged = () => { throw new Error('shell bug') }; showView('settings')");
  } finally { console.error = realError; }
  assert.equal(h.run('view'), 'settings', '外壳模块抛错不能卡住主页面');
  assert.equal(reported.length, 1, '错误要留痕,但不能影响页面');
  assert.match(String(reported[0][0]?.message || reported[0][0]), /shell bug/);
});

test('客户端侧栏:直达正确渠道库且只高亮一个客户端,不依赖外壳模块', async () => {
  const h = await harness();
  for (const app of ['codex', 'zcode', 'claude']) {
    h.run(`document.querySelectorAll('nav a').find(a => a.dataset.app === '${app}').click()`);
    assert.equal(h.run('view'), 'providers');
    assert.equal(h.run('curApp'), app);
    assert.equal(h.run("document.querySelectorAll('nav a').filter(a => a.classList.contains('active')).length"), 1);
    assert.equal(h.run("document.querySelectorAll('nav a').find(a => a.classList.contains('active')).dataset.app"), app);
  }
  h.run("showView('usage'); setApp('codex')");
  assert.equal(h.run("document.querySelectorAll('nav a').find(a => a.classList.contains('active')).dataset.view"), 'usage');
});

test('客户端侧栏:外壳存在时一次点击只传一对视图与客户端', async () => {
  const h = await harness();
  h.run("globalThis.__navigation = []; window.workspaceNavigate = (name, app) => __navigation.push([name, app])");
  h.run("document.querySelectorAll('nav a').find(a => a.dataset.app === 'codex').click()");
  assert.equal(h.run('JSON.stringify(__navigation)'), '[["providers","codex"]]');
  assert.equal(h.run('curApp'), 'claude', '接管后不能再走单独 setApp,避免中间历史记录');
});

test('渠道卡片分区:身份/状态/内容/动作语义清晰,账号与动作契约原样保留', async () => {
  const data = fixture();
  data.providers.claude[0].note = '仅限团队 A 使用';
  const h = await harness(data);
  h.run("view = 'providers'; renderProviders()");
  const grid = h.get('prov-grid').innerHTML;
  for (const cls of ['provider-identity', 'provider-avatar', 'provider-info', 'provider-status', 'provider-content', 'provider-models', 'provider-meta', 'provider-actions']) {
    assert.match(grid, new RegExp(cls));
  }
  assert.match(grid, /<header class="top provider-identity">/);
  // ASCII 名称取前两位做头像;状态徽标在身份块里,内容块放地址与协议/模型
  assert.match(grid, /<span class="provider-avatar" aria-hidden="true">AL<\/span>/);
  assert.match(grid, /<div class="provider-info"><h3 class="name">Alpha<\/h3><div class="provider-status">/);
  assert.match(grid, /<div class="foot provider-actions">/);
  assert.match(grid, /<div class="provider-models tags">/);
  assert.match(grid, /<div class="provider-meta mono keyrow">API key · /);
  // 账号下拉、动作按钮与 data-* 契约不变;说明与告警不因重排被吞掉
  assert.match(grid, /data-provider="a1" data-action="key"/);
  assert.match(grid, /<option value="k1" selected>Account One · /);
  assert.match(grid, /data-action="switch" data-provider="a1" onclick="switchProvider\(&quot;a1&quot;\)"/);
  assert.match(grid, /data-action="delete" data-provider="a1"/);
  assert.match(grid, /仅限团队 A 使用/);
});

test('live configuration mismatch never labels the stored provider as the actual direct upstream', async () => {
  const data = fixture();
  data.live.claude = { base_url: 'https://external.example', provider: 'External provider', match: false, router: false };
  const h = await harness(data);
  h.run("view = 'providers'; renderProviders()");   // liveinfo 只在渠道页渲染
  const direct = h.get('liveinfo').innerHTML.split('</article>')[0];
  assert.equal(direct.includes('External provider'), true);
  assert.equal(direct.includes('Alpha'), false);
  assert.equal(h.get('drift-banner').classList.contains('show'), true);
  data.live.claude.error = 'invalid config'; await h.run('refresh()');
  assert.equal(h.get('liveinfo').innerHTML.includes('mode-card selected'), false);
  assert.equal(h.get('drift-text').textContent.includes('invalid config'), true);
});

test('generated handlers compile safely for quotes, apostrophes, and HTML in provider identifiers', async () => {
  const data = fixture(); data.providers.claude[0].id = `a'"<&`; data.providers.claude[0].name = '<script>bad()</script>';
  const h = await harness(data);
  h.run("view = 'providers'; renderProviders()");   // 渠道卡片与规则卡都要先渲染出来才扫得到
  const decode = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const fragment of [html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''), h.get('prov-grid').innerHTML, h.get('rules-box').innerHTML, h.get('def-box').innerHTML]) {
    for (const match of fragment.matchAll(/\bon(?:click|input|change|submit)="([^"]*)"/g)) new vm.Script(`(function(event){${decode(match[1])}})`);
  }
  assert.equal(h.get('prov-grid').innerHTML.includes('<script>bad()'), false);
  assert.equal(h.get('prov-grid').innerHTML.includes('&lt;script&gt;bad()'), true);
});

test('槽位落点模型是下拉:渠道模型列全可选,换渠道当场换清单,未登记的模型名走「自定义模型…」', async () => {
  const h = await harness();
  h.run("setApp('claude')");
  const before = h.get('slots-rows').innerHTML;
  // 必须是 select:datalist 会被 Chromium 按输入框已有内容过滤,填了值就只剩一个候选,等于没法挑
  assert.match(before, /<select aria-label="main 槽模型" onchange="onSlotModelPick\('claude','main',this\.value\)">/);
  assert.match(before, /<option value="claude-special" selected>claude-special<\/option>/);
  assert.match(before, /<option value="__custom__">自定义模型…<\/option>/);
  assert.doesNotMatch(before, /claude-old/);
  // 用户刚在渠道 select 里选完新渠道,焦点还停在槽位表内:轮询守卫本会跳过重绘,用户提交的改动必须绕过它
  h.run("globalThis.__sel = new document.body.constructor('f', 'select'); __sel.setAttribute('aria-label', 'main 槽渠道'); __sel.parentElement = document.getElementById('slots-rows'); __sel.focus();");
  assert.equal(h.document.activeElement.getAttribute('aria-label'), 'main 槽渠道');
  await h.run("setSlot('claude', 'main', 'provider', 'a2')");
  const after = h.get('slots-rows').innerHTML;
  assert.match(after, /value="a2"/);
  assert.match(after, /<option value="claude-old" selected>claude-old<\/option>/);  // 落点模型跟着新渠道的清单走
  assert.doesNotMatch(after, /claude-special/);
  assert.match(after, /<select aria-label="subagent 槽模型" disabled><option>（先选渠道）<\/option><\/select>/);
  // 渠道清单里没有的模型名:选「自定义模型…」切输入框后照样能提交
  // (夹具的 /api/state 是静态的,refresh 会把槽位表还原成初始值,所以这里只断言提交内容)
  h.run("onSlotModelPick('claude','main','__custom__')");
  assert.match(h.get('slots-rows').innerHTML, /<input type="text" aria-label="main 槽模型" list="slot-models-main" value="claude-special"/);
  h.run("slotModelKey({ key: 'Escape', target: {} }, 'claude', 'main')");
  assert.equal(h.run('slotModelEdit.claude'), null);
  assert.match(h.get('slots-rows').innerHTML, /<select aria-label="main 槽模型"/, 'Esc 退出输入框,回到下拉');
  h.run("onSlotModelPick('claude','main','__custom__')");
  await h.run("slotModelKey({ key: 'Enter', preventDefault() {}, target: { value: 'brand-new-model' } }, 'claude', 'main')");
  const put = h.requests.findLast(r => r.method === 'PUT' && r.url === '/api/slots');
  assert.equal(put.body.claude.main.model, 'brand-new-model');
  assert.equal(typeof put.body.claude.main.provider, 'string');
  assert.equal(h.run('slotModelEdit.claude'), null, '提交后回到下拉,不再停在输入框');
  // 失焦提交不依赖 change 事件:值变了才提交,没变就只清标记,不写盘
  const putCount = () => h.requests.filter(r => r.method === 'PUT' && r.url === '/api/slots').length;
  const putBefore = putCount();
  h.run("onSlotModelPick('claude','main','__custom__')");
  h.run("endSlotModelEdit('claude','main', slotModelEdit.claude.value)");        // 原样失焦
  assert.equal(putCount(), putBefore, '没改就不写盘');
  h.run("onSlotModelPick('claude','main','__custom__')");
  await h.run("endSlotModelEdit('claude','main','second-new-model')");
  assert.equal(h.requests.findLast(r => r.method === 'PUT' && r.url === '/api/slots').body.claude.main.model, 'second-new-model');
});

test('渠道弹窗:模型列表按行编辑,下拉是本组登记过的模型名,没登记的可手写;不写渠道级槽位', async () => {
  const h = await harness();
  assert.doesNotMatch(html, /id="m-slot-/);              // 弹窗里那条「模型映射」整体去掉
  assert.doesNotMatch(html, /id="m-models"/);            // 单行逗号文本框也换成行式清单了
  h.run("setApp('claude'); openProvider('a1')");
  const rows = () => h.get('m-models-list').innerHTML;
  assert.match(rows(), /<select aria-label="模型1" onchange="pickModelDraft\(0,this\.value\)">/);
  assert.match(rows(), /<option value="claude-special" selected>claude-special<\/option>/);  // 这条渠道自己的模型
  assert.match(rows(), /<option value="claude-old" >claude-old<\/option>/);                  // 本组别的渠道登记过的模型
  assert.match(rows(), /<option value="__custom__">自定义模型…<\/option>/);
  assert.match(rows(), /<datalist id="model-candidates">/);
  // 新行默认「（选模型）」,不自作主张填第一个
  h.run('addModelDraft()');
  assert.match(rows(), /<select aria-label="模型2" onchange="pickModelDraft\(1,this\.value\)"><option value="" selected>（选模型）<\/option>/);
  // 没登记过的模型名:选「自定义模型…」把这一行切成输入框再写
  h.run("pickModelDraft(1,'__custom__')");
  assert.match(rows(), /<input type="text" aria-label="模型2" value=""/);
  h.run("endModelEdit(1, ' brand-new-model ')");
  assert.equal(h.run('modelDraft[1].value'), 'brand-new-model', '手写的名字去掉两端空格存进草稿');
  assert.equal(h.run("modelCandidates.includes('brand-new-model')"), true, '手写过的名字并进下拉候选');
  h.run("addModelDraft(); pickModelDraft(2,'claude-special')");                              // 重复项
  await h.run('saveProvider()');
  const put = h.requests.findLast(r => r.method === 'PUT' && r.url === '/api/providers/a1');
  assert.deepEqual(put.body.models, ['claude-special', 'brand-new-model'], '按行序提交、去重、丢掉空行');
  assert.equal(put.body.slots, undefined, '渠道级槽位不再由弹窗改写');
  h.run("removeModelDraft(1)");
  assert.doesNotMatch(rows(), /brand-new-model/);
});

test('路由绑了已删除的渠道时,控制台要把那个幽灵摆出来,而不是显示成"未绑定"', async () => {
  // 渠道被删了,规则里还留着它的 id(routes.json 手改或从旧备份恢复就会这样)。
  // 以前这个 id 不在下拉列表里,浏览器默认显示第一项"未绑定",可草稿里仍是那个幽灵 id:
  // 界面说没绑定、保存时又原样传回去,用户看不出是哪条规则出了问题——服务端现在会拒,
  // 报的正是他界面上根本找不到的那个 id。
  const ghost = 'pmu48wblh75h6';
  const d = fixture();
  d.routes.rules = [
    { id: 'rghost', match: 'kimi-k3', provider: ghost, model: '', pool: [], strategy: 'round_robin', priority: 0, app: '', when: {}, enabled: true },
    { id: 'rpool', match: 'pooled', provider: '', pool: [{ provider: ghost }, { provider: 'a1' }], strategy: 'round_robin', priority: 0, app: '', when: {}, enabled: true },
  ];
  const h = await harness(d);
  const box = () => h.get('rules-box').innerHTML;

  assert.match(box(), /渠道已删除/, '单选目标里的幽灵要显式摆出来');
  assert.match(box(), new RegExp(ghost), '要把那个 id 露出来,用户才知道是哪个');
  assert.match(box(), /⚠/, '要有醒目标记');
  // 池里的幽灵成员同理,而且必须能摘掉(否则保存永远被拒、用户无路可走)
  assert.match(box(), /移除/, '池里的幽灵成员要能一键移除');
  h.run(`dropPoolMember(1, ${JSON.stringify(ghost)})`);
  assert.equal(h.run('routesDraft.rules[1].pool.length'), 1, '移除后池里只剩真渠道');
  assert.equal(h.run('routesDraft.rules[1].pool[0].provider'), 'a1');
  // 只有第 2 条规则(池)被摘干净;第 1 条规则的单选目标仍指着幽灵,它的标记该留着
  assert.equal((box().match(/渠道已删除（/g) || []).length, 1, '移除后池里不该再有幽灵项');
  assert.match(box(), /目标渠道<select[^>]*><option value="">未绑定<\/option><option value="pmu48wblh75h6" selected>⚠ 渠道已删除/,
    '第 1 条规则的单选幽灵仍在(它本来就该在,等用户自己改选)');
});

test('写入配置带回的备份池轮换:并进同一条提示显示,且用 warn 样式(不是 ok,也不是 err)', async () => {
  // 服务端在备份池满时会把"这一份顶掉了谁"塞进响应体(mixrouter.js 的 backupWithWatch)。
  // 前端要做对两件事:把那句话**显示出来**,以及别把基调定错——配置确实写成功了,用 err 会
  // 让人以为失败,用 ok 又会盖掉"有东西被清出池了"。同一个 #toast 只能显示一条,所以并进去。
  const h = await harness();
  const warn = '保留池已满(5/5):本次备份将顶掉 1 份 —— settings.json.bak-mixui-20260101-000000-000-abcd。';
  h.run(`api = async () => ({ ok: true, app: 'claude', live: {}, warnings: [${JSON.stringify(warn)}] })`);
  await h.confirm("switchProvider('a1')");
  const t = h.get('toast');
  assert.equal(t.className, 'warn', '基调必须是 warn:成功但有轮换');
  assert.ok(t.textContent.includes(warn), `轮换那句必须露面;实得 ${JSON.stringify(t.textContent)}`);
  assert.ok(t.textContent.includes('已写入'), '成功那句不能被顶掉(同一条提示里两句并存)');
});

test('没有备份池轮换时保持原样:ok 基调,提示里不出现"顶掉"字样', async () => {
  const h = await harness();
  await h.confirm("switchProvider('a1')");
  const t = h.get('toast');
  assert.equal(t.className, 'ok', '没有轮换就是普通成功');
  assert.ok(!t.textContent.includes('顶掉'), '不许无中生有一条轮换提示');
});

// ---------------------------------------------------------------- 渠道库备份轮换的出口
// 渠道库(providers.json)只留 5 份备份,而**每次保存渠道都写一次库** —— 池满之后每一次
// 保存都在顶掉最老的那一份。服务端把这件事放进响应体的 warnings(mixrouter.js 的
// drainStoreWarnings),前端要做的是**把它显示出来**并保持成功基调。
// 这四条钉的是四扇不同的门:保存、切换生效 Key、启停、删除。少接一扇,用户在那扇门上
// 就还是"看着一切正常,备份却在悄悄少"。

const ROTATION_WARN = '本次备份将顶掉 1 份 —— providers.json.bak-mixui-20260101-000000-000-abcd。';

test('保存渠道带回备份轮换:并进同一条提示、warn 基调,且不报"失败"', async () => {
  const h = await harness();
  // 覆写 fetch:只要打到写渠道库的接口,就把轮换预警放进响应体(与真实服务端同形)。
  h.run(`__realFetch = fetch; fetch = async (url, options = {}) => {
    const res = await __realFetch(url, options);
    if (String(url).startsWith('/api/providers')) {
      const body = await res.json();
      return { ok: true, json: async () => ({ ...body, warnings: [${JSON.stringify(ROTATION_WARN)}] }) };
    }
    return res;
  }`);
  h.run("openProvider('a1')");
  await h.run('saveProvider()');
  const t = h.get('toast');
  assert.equal(t.className, 'warn', '保存成功但有轮换 —— 既不是 err(会以为失败)也不是 ok(会盖掉那句话)');
  assert.ok(t.textContent.includes(ROTATION_WARN), `轮换那句必须露面;实得 ${JSON.stringify(t.textContent)}`);
  assert.ok(t.textContent.includes('渠道已保存'), '成功那句不能被顶掉');
});

test('切换生效 Key / 启停 / 删除:三扇门都要带出备份轮换', async () => {
  for (const [code, okWord] of [
    ["setActiveKey('a1','k1')", '已切换生效 Key'],
    ["toggleProvider('a1')", '渠道状态已更新'],
    ["delProvider('a1')", '渠道已删除'],
  ]) {
    const h = await harness();
    h.run(`__realFetch = fetch; fetch = async (url, options = {}) => {
      const res = await __realFetch(url, options);
      if (String(url).startsWith('/api/providers')) {
        const body = await res.json();
        return { ok: true, json: async () => ({ ...body, warnings: [${JSON.stringify(ROTATION_WARN)}] }) };
      }
      return res;
    }`);
    await h.confirm(code);
    const t = h.get('toast');
    assert.equal(t.className, 'warn', `${code}: 基调必须是 warn`);
    assert.ok(t.textContent.includes(ROTATION_WARN), `${code}: 轮换那句必须露面;实得 ${JSON.stringify(t.textContent)}`);
    assert.ok(t.textContent.includes(okWord), `${code}: 成功那句不能被顶掉`);
  }
});

test('渠道接口不带 warnings 时保持 ok 基调(不能变成每次保存都喊一句)', async () => {
  const h = await harness();
  h.run("openProvider('a1')");
  await h.run('saveProvider()');
  const t = h.get('toast');
  assert.equal(t.className, 'ok');
  assert.ok(!t.textContent.includes('顶掉'), '不许无中生有一条轮换提示');
});

test('「应用槽位到客户端」带回备份轮换:并进同一条提示,且不报"失败"', async () => {
  // 这一扇门走的是 POST /api/router/claude,而那条路径的 warnings 里除了客户端配置那份,
  // 还并着**渠道库**那份(configureClaudeSplit 的 drainStoreWarnings)。此前这里用的是裸
  // toast(),服务端辛苦带回来的轮换提示到这一扇门就断了 —— 而它恰好是最常点的那一个按钮。
  const h = await harness();
  h.run(`__realFetch = fetch; fetch = async (url, options = {}) => {
    const res = await __realFetch(url, options);
    if (String(url).startsWith('/api/router/')) {
      const body = await res.json();
      return { ok: true, json: async () => ({ ...body, warnings: [${JSON.stringify(ROTATION_WARN)}] }) };
    }
    return res;
  }`);
  await h.confirm('applySlotsClaude()');
  const t = h.get('toast');
  assert.equal(t.className, 'warn', '应用成功但有轮换 —— 既不是 err(会以为失败)也不是 ok(会盖掉那句话)');
  assert.ok(t.textContent.includes(ROTATION_WARN), `轮换那句必须露面;实得 ${JSON.stringify(t.textContent)}`);
  assert.ok(t.textContent.includes('槽位 env 已写入'), '成功那句不能被顶掉');
});

// ---------------------------------------------------------------- 第三期任务 4/6/8:概览、渠道、路由、压缩分账、设置与备份
// 这一组用例盯的是七个视图重组之后**每一页新加的内容**,以及三条硬要求:
//   · 概览只读(不放第二套编辑器)
//   · 最近实际落点只认会话的 actual,没有就写「暂无」,绝不拿路由预览冒充
//   · 设置页只读那四个端点,且不请求任何配置正文

test('概览:八个视图里最靠前的一页,只读,且不放任何可写控件', async () => {
  const h = await harness();
  assert.equal(h.run('view'), 'overview', '默认视图是概览');
  assert.equal(h.run('VIEWS.length'), 8);
  assert.deepEqual(Array.from(h.run('VIEWS')), ['overview', 'usage', 'providers', 'dsh', 'routes', 'sessions', 'diagnostics', 'settings']);
  assert.equal(h.run('VIEW_LABELS.dsh'), 'DeepSeek Harness');
  assert.equal(h.run("VIEW_LABELS.diagnostics"), '诊断');
  assert.equal(h.run("VIEW_LABELS.settings"), '设置与备份');
  // 八个视图节默认都藏起来,由 showView 统一开关
  for (const v of ['overview', 'usage', 'providers', 'dsh', 'routes', 'sessions', 'diagnostics', 'settings']) {
    const el = h.get('view-' + v);
    assert.ok(el, `视图节 view-${v} 必须存在`);
    if (v !== 'overview') assert.equal(el.style.display, 'none', `view-${v} 默认必须是 display:none`);
  }
  // 概览节里不许有可写控件:input/select/textarea 一个都不行,button 只能是跳转。
  const overviewHtml = html.slice(html.indexOf('<section id="view-overview"'), html.indexOf('<section id="view-usage"'));
  assert.doesNotMatch(overviewHtml, /<input\b/, '概览节不许有 input');
  assert.doesNotMatch(overviewHtml, /<select\b/, '概览节不许有 select');
  assert.doesNotMatch(overviewHtml, /<textarea\b/, '概览节不许有 textarea');
  for (const match of overviewHtml.matchAll(/<button\b[^>]*onclick="([^"]*)"/g)) {
    assert.match(match[1], /^(refresh\(\)|showView\(&quot;|showView\(')/, `概览里的按钮只许刷新或切视图,实得 onclick="${match[1]}"`);
  }
  // 概览读的是 /api/state,不额外发任何请求
  const writes = h.requests.filter(r => r.method !== 'GET');
  assert.equal(writes.length, 0, '渲染概览不发写请求');
});

test('概览的需处理事项:有问题时逐条列出并给跳转,没问题时明确写「没有需要处理的事项」', async () => {
  // 一个"干净"的夹具:所有渠道启用、没有停用的 Key、没有冷却、没有僵尸引用、没有失效会话覆盖。
  // 标准 fixture 里自带停用渠道与停用 Key,所以这里必须另造一份才验得到"没问题"那一面。
  const cleanData = fixture();
  cleanData.providers.claude = [cleanData.providers.claude[0]];
  cleanData.providers.claude[0].keys = [{ id: 'k1', label: 'Account One', enabled: true }];
  cleanData.providers.claude[0].active_key = 'k1';
  cleanData.providers.codex = [cleanData.providers.codex[0]];
  cleanData.sessions = [];
  const clean = await harness(cleanData);
  assert.match(clean.get('overview-todo').innerHTML, /没有需要处理的事项/, '没有事项时必须明确写出来,不能留空白');
  assert.doesNotMatch(clean.get('overview-todo').innerHTML, /overview-todo-list/, '没有事项时不该有清单元素');

  const data = fixture();
  data.providers.claude.push({ id: 'a3', name: 'Never Used', base_url: 'https://x.example', models: ['m'], enabled: false });
  data.cooldowns = [{ provider: 'a1', until: Date.now() + 60000, name: 'Alpha' }];
  data.routes.rules.push({ id: 'rghost', match: 'kimi-k3', provider: 'pmu48wblh75h6', model: '', pool: [], strategy: 'round_robin', priority: 0, app: '', when: {}, enabled: true });
  data.sessions[0].routing = { keys: { a1: 'k-gone' }, slots: {} };   // Key 已失效 ⇒ 会话有失效引用
  const h = await harness(data);
  const todo = h.get('overview-todo').innerHTML;
  assert.match(todo, /3 个渠道已停用/, '停用渠道要报总数');        // Disabled + Never Used + Chat gateway
  assert.match(todo, /Never Used/, '要能看出是哪些渠道');
  assert.match(todo, /1 把 Key 已停用/, '失效 Key 要报总数');       // a1 的 k-off
  assert.match(todo, /1 个渠道冷却中/, '冷却渠道要报总数');
  assert.match(todo, /路由里有失效引用/, '僵尸引用要报');
  assert.match(todo, /pmu48wblh75h6/, '要把那个 id 露出来');
  assert.match(todo, /1 个会话的 Key \/ 槽位覆盖里存在已失效的引用/, '会话失效覆盖要报总数');
  // 每条都带一个跳到管它那一页的按钮,且只调 showView
  const jumps = [...todo.matchAll(/data-jump="([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(jumps, ['providers', 'providers', 'providers', 'routes', 'sessions']);
  const before = h.requests.filter(r => r.method !== 'GET').length;
  h.run("showView('routes')");
  assert.equal(h.run('view'), 'routes', '跳转按钮只切视图');
  assert.equal(h.requests.filter(r => r.method !== 'GET').length, before, '跳转不发任何写请求');
});

test('概览:版本/修订/进程/运行时长/客户端接入三行/接入地址都从 state 读出来', async () => {
  const h = await harness();
  assert.equal(h.get('ov-version').textContent, 'test');
  assert.match(h.get('ov-revision').textContent, /abcdef012345/, '修订号截短显示');
  assert.equal(h.get('ov-revision').getAttribute('title'), 'abcdef0123456789', 'title 给全长');
  assert.equal(h.get('ov-uptime').textContent, '2m5s');
  assert.match(h.get('ov-pid').textContent, /4242/);
  assert.equal(h.get('ov-reqs').textContent, '12');
  assert.match(h.get('ov-tokens').textContent, /输入 100 \/ 输出 40/);
  assert.equal(h.get('ov-cooldowns').textContent, '0 个渠道冷却中');
  // 三行客户端状态:复用 liveFacts 的口径(claude 夹具是已写入直连)
  const clients = h.get('overview-clients').innerHTML;
  for (const label of ['Claude Code', 'Codex', 'ZCode']) assert.match(clients, new RegExp(label));
  assert.match(clients, /直连/, 'claude 夹具 live.base_url 有值且非 router ⇒ 直连');
  assert.match(clients, /已写入配置/);
  assert.match(clients, /~\/\.claude\/settings\.json/);
  // 接入地址:"我在哪里填什么"
  const endpoints = h.get('overview-endpoints').innerHTML;
  assert.match(endpoints, /http:\/\/127\.0\.0\.1:8787\/v1/, 'codex_base 要摆出来');
  assert.match(endpoints, /http:\/\/127\.0\.0\.1:8787\/custom/, 'zcode_base 要摆出来');
});

test('概览与渠道页共用 liveFacts 的口径:离线时都降级成「待确认」,不各自判一套', async () => {
  const h = await harness();
  const before = h.get('overview-clients').innerHTML;
  assert.match(before, /已写入配置/);
  h.disconnect(); await h.run('refresh()');
  const after = h.get('overview-clients').innerHTML;
  assert.match(after, /待确认/, '离线后概览要说待确认');
  assert.match(after, /离线 · 最后快照/);
  assert.doesNotMatch(after, /已写入配置/, '离线时不能还说已写入配置');
});

test('渠道页:卡片标出失效 Key 的数量与标签,但不出现任何 Key 明文', async () => {
  const SECRET = 'sk-channel-page-secret-should-never-leak';
  const data = fixture();
  data.providers.claude[0].keys = [
    { id: 'k1', label: 'Account One', enabled: true, key: SECRET },
    { id: 'k-off', label: 'Retired', enabled: false, key: 'sk-retired-secret' },
  ];
  const h = await harness(data);
  h.run("view = 'providers'; renderProviders()");
  const grid = h.get('prov-grid').innerHTML;
  assert.match(grid, /1 把 Key 已停用/, '卡片要标出停用的 Key 数量');
  assert.match(grid, /已停用的 Key：Retired（k-off）/, '要能看出是哪一把(只有标签与 id)');
  assert.equal(grid.includes(SECRET), false, '卡片不得出现 Key 明文');
  assert.equal(grid.includes('sk-retired-secret'), false, '停用的 Key 同样不得出现明文');
});

test('渠道页:冷却状态从 /api/health 与 /api/state 读出,健康端点失败也不拖垮整页', async () => {
  const data = fixture();
  data.cooldowns = [{ provider: 'a1', until: Date.UTC(2026, 0, 2, 3, 4, 5), name: 'Alpha' }];
  const h = await harness(data);
  h.run("view = 'providers'; renderProviders()");
  assert.match(h.get('prov-grid').innerHTML, /冷却至/, '冷却中的渠道要在卡片上标出');
  await h.run('loadHealth()');
  // 卡片只保留冷却与可用性:健康快照里的 eligible 仍要进徽标,但不再有状态徽标
  assert.match(h.get('prov-grid').innerHTML, /冷却至/);
  assert.doesNotMatch(h.get('prov-grid').innerHTML, /熔断/, '渠道卡片不再展示熔断状态');
  assert.match(h.get('health-status').textContent, /已读取/);
  const healthBody = h.get('health-body').innerHTML;
  assert.match(healthBody, /冷却至/, '健康表仍有冷却列');
  assert.doesNotMatch(healthBody, /熔断/, '健康表不再有熔断列');
  assert.doesNotMatch(healthBody, /阈值/, '健康事实里不再有熔断阈值/恢复阈值');
  assert.match(healthBody, /重试间隔\(ms\)/, '重试间隔要跟着 /api/health 的 retry_delay_ms 显示');
  assert.match(healthBody, /<dd>500<\/dd>/, 'retry_delay_ms 的值要渲染出来');
  // 健康端点挂掉:卡片照常渲染,只有那一句提示,且设置页/渠道页的草稿都不受影响
  const h2 = await harness(data);
  h2.fail({ health: true });
  h2.run("view = 'providers'; renderProviders()");
  h2.run("routesDraft.rules[0].match = 'unfinished-rule'; markRoutesDirty()");
  await h2.run('loadHealth()');
  const grid = h2.get('prov-grid').innerHTML;
  assert.match(grid, /Alpha/, '健康挂了渠道卡片照样要有内容');
  assert.match(grid, /冷却至/, '冷却来自 state,不受健康端点影响');
  assert.match(h2.get('prov-health').textContent, /健康状态未读取/);
  assert.equal(h2.get('prov-health').hidden, false);
  assert.match(h2.get('health-status').textContent, /读取失败/);
  assert.equal(h2.run('routesDirty'), true, '健康读失败不影响别的页草稿');
  assert.equal(h2.run("routesDraft.rules[0].match"), 'unfinished-rule');
});

test('路由页:规则显示主目标/后备/协议/配置来源,最近实际落点只认会话 actual,没有就是「暂无」', async () => {
  const data = fixture();
  data.providers.claude[0].wire_api = 'chat';
  data.routes.rules = [
    { id: 'r1', match: 'claude', provider: 'a1', model: '', pool: [], strategy: 'round_robin', priority: 0, app: '', when: {}, enabled: true },
    { id: 'r2', match: 'pooled', provider: '', pool: [{ provider: 'a1' }, { provider: 'a2' }], strategy: 'least_used', priority: 0, app: 'claude', when: {}, enabled: true },
  ];
  // 会话 aaa 的 actual 落在 a1(标准夹具里 aaa 是 actual:null,这里显式给一条真实请求记录),
  // ccc 没有 actual。落点只认 actual,不认绑定。
  data.sessions[0].actual = { provider: 'a1', provider_name: 'Alpha', model: 'claude-special', rule: 'r1', slot: '', sticky: false, status: 200, in: 1, out: 1, ms: 40, ts: 1700000003000 };
  data.sessions[0].actual_source = 'request';
  const h = await harness(data);
  h.run("view = 'routes'; renderRoutes()");
  const box = h.get('rules-box').innerHTML;
  assert.match(box, /配置来源/, '规则卡要标出配置来源');
  assert.match(box, /通用规则 · 按目标归组/, '未声明 app 的规则 = 通用规则');
  assert.match(box, /显式规则 · 限定 Claude \/ Anthropic/, '声明了 app 的规则 = 显式规则');
  assert.match(box, /分配策略/, '要标出分配策略');
  assert.match(box, /单一渠道/);
  assert.match(box, /最少会话/, '池策略按 STRAT_LABEL 的短名显示');
  assert.match(box, /协议/, '要标出协议');
  assert.match(box, /Alpha · chat（转换）/, '协议取该渠道的 wire_api');
  // 第 1 条规则的目标是 a1,而会话 aaa 的 actual.provider 是 a1 ⇒ 有实际落点
  assert.match(box, /最近实际落点[\s\S]{0,200}?Alpha（200）/, '有 actual 就要显示真实落点与状态码');
  // 夹具里第二条规则只指向 a1,没有任何会话落到过它之外的地方;但 a1 的 actual 属于第 1 条
  // —— 落点是按渠道聚合的,不按规则 id,这一点要在文案上诚实(写"最近实际落点",不写"本规则")
  const defBox = h.get('def-box').innerHTML;
  assert.match(defBox, /最近实际落点/, '默认路由也要有这一角');
  assert.match(defBox, /Alpha（200）/, '默认路由的目标也是 a1,同样能看到实际落点');
});

test('路由页:没有任何实际请求记录时,最近实际落点显示「暂无」,不许拿绑定渠道名冒充', async () => {
  const data = fixture();
  data.sessions = data.sessions.map(s => ({ ...s, actual: null, actual_source: 'none', actual_text: '暂无' }));
  const h = await harness(data);
  h.run("view = 'routes'; renderRoutes()");
  const box = h.get('rules-box').innerHTML;
  // 规则绑的是 Alpha,但一条真实请求都没有 ⇒ 只能写「暂无」
  assert.match(box, /最近实际落点<\/span><span>暂无<\/span>/, '没有 actual 就是「暂无」');
  assert.doesNotMatch(box, /最近实际落点<\/span><span>Alpha/, '绝不许拿绑定渠道名当实际落点');
  // 反向:预览端点根本没被这条路径调用过(预览是预测,不是实际落点)
  assert.equal(h.requests.some(r => r.url === '/api/routing/preview'), false, '渲染路由页不得调用预览冒充实际落点');
});

test('压缩分账:保存成功 / 已写盘 / 服务已加载 / 客户端需重开 四段可分别读到,不揉成一句「已生效」', async () => {
  const data = fixture();
  data.routes_revision = 'rev-one';
  data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'single', selection: { provider: 'a1', model: 'claude-special', key_id: '' }, providers: [data.providers.claude[0]], rules: [] };
  const h = await harness(data);
  h.run("view = 'routes'");
  // 还没保存过:四段全是"尚未保存过",不假装任何一段成立
  const before = h.get('compact-status').innerHTML;
  assert.match(before, /保存结果/);
  assert.equal((before.match(/尚未保存过/g) || []).length, 4, '四段各自都要先说"尚未保存过"');
  // 保存成功
  h.run("pickCompactProvider('a1'); pickCompactModel('__custom__'); setCompactCustom('brand-new-model')");
  await h.confirm('saveCompact()');
  const after = h.get('compact-status').innerHTML;
  assert.match(after, /请求：已成功返回/, '第一段:请求成功');
  assert.match(after, /已写盘：配置已写入服务端磁盘/, '第二段:已写盘');
  assert.match(after, /服务已加载：运行中的服务按新压缩规则分发/, '第三段:服务已加载(与写盘分开)');
  assert.match(after, /客户端需重开：不需要/, '第四段:客户端不需重开(与前三段分开)');
  assert.doesNotMatch(after, /已生效/, '不许把四件事统一说成"已生效"');
});

test('压缩分账:保存失败时前三段不冒充成立,客户端需重开仍独立可读', async () => {
  const data = fixture();
  data.routes_revision = 'rev-one';
  data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'single', selection: { provider: 'a1', model: 'claude-special', key_id: '' }, providers: [data.providers.claude[0]], rules: [] };
  const h = await harness(data);
  h.run("view = 'routes'");
  h.run("pickCompactProvider('a1'); pickCompactModel('__custom__'); setCompactCustom('x')");
  h.run("globalThis.__realFetch = fetch; fetch = async (url, opt) => { if (url === '/api/compact') throw new Error('simulated compact failure'); return __realFetch(url, opt); }");
  await h.confirm('saveCompact()');
  const after = h.get('compact-status').innerHTML;
  assert.match(after, /请求：simulated compact failure/, '失败原因要读得到');
  assert.match(after, /已写盘：未确认写盘/, '失败时不许说已写盘');
  assert.match(after, /服务已加载：未确认服务已加载/);
  assert.match(after, /客户端需重开：不需要/);
  assert.equal(h.requests.some(r => r.url === '/api/compact' && r.method === 'POST'), false, '失败请求没有成功记录');
});

test('压缩分账:窗口保存的"服务已加载"不适用、"客户端需重开"成立,与压缩模型分开表达', async () => {
  const h = await harness();
  h.run("view = 'routes'");
  await h.run('loadCompactWindow()');
  h.run("setWindowValue('300k')");
  assert.match(h.get('window-status').innerHTML, /客户端需重开：尚未保存过/);
  await h.confirm('saveCompactWindow()');
  const after = h.get('window-status').innerHTML;
  assert.match(after, /请求：已成功返回/);
  assert.match(after, /已写盘：已写入所选配置层文件/);
  assert.match(after, /服务已加载：不适用/, '窗口写的是磁盘配置,服务端从不热读 ⇒ 不适用');
  assert.match(after, /客户端需重开：需要/, '窗口必须新开会话才生效');
  // 与压缩模型那一块各说各的:窗口保存不该把压缩那块的文案改成"不需要重开"
  assert.match(h.get('compact-status').innerHTML, /客户端需重开：尚未保存过/, '两块状态互不覆盖');
});

test('设置页:确实请求 /api/backups、/api/health、/api/routing/preview,且不请求任何配置正文', async () => {
  const h = await harness();
  h.run("showView('settings')");
  await new Promise(resolve => setImmediate(resolve));
  const urls = h.requests.map(r => r.url);
  assert.ok(urls.includes('/api/backups'), '要请求备份清点');
  assert.ok(urls.includes('/api/health'), '要请求健康');
  // 预览**不随进页面自动跑**:模型名留空时服务端回 503「暂无可用落点」,浏览器会把这条
  // 503 记成控制台错误,每次进设置页刷一条。它由「解释一次」按钮与输入框回车触发。
  assert.equal(urls.includes('/api/routing/preview'), false, '进设置页不得自动跑空白预览(会平白刷一条 503)');
  h.run("document.getElementById('preview-model').value = 'claude-opus-4-8'; loadPreview()");
  await new Promise(resolve => setImmediate(resolve));
  const preview = h.requests.find(r => r.url === '/api/routing/preview');
  assert.ok(preview, '点了「解释一次」必须真的请求');
  assert.equal(preview.method, 'POST', '预览按服务端契约用 POST 携带上下文');
  assert.deepEqual(preview.body, { app: 'claude', model: 'claude-opus-4-8' }, '预览只发 app/model,不带任何配置正文');
  // 绝对不许请求配置正文
  const allUrls = h.requests.map(r => r.url);
  for (const forbidden of ['/api/codex/config', '/api/slots', '/api/routes', '/api/compact', '/api/providers', '/api/state?']) {
    assert.equal(allUrls.some(u => u.startsWith(forbidden)), false, `设置页不许请求 ${forbidden}`);
  }
  // 设置页的全部请求:三条只读端点都是 GET;预览按服务端契约是 POST,但它同样只读
  // (不消耗游标、不写绑定)。
  for (const r of h.requests) {
    const readonly = r.method === 'GET' || (r.method === 'POST' && r.url === '/api/routing/preview');
    assert.ok(readonly, `设置页只许只读请求,实得 ${r.method} ${r.url}`);
  }
});

test('设置页:备份清点显示每池份数/下次删哪几个/保留上限,响应里不含配置正文', async () => {
  const h = await harness();
  h.run("showView('settings')");
  await new Promise(resolve => setImmediate(resolve));
  const dirs = h.get('backup-dirs').innerHTML;
  assert.match(dirs, /Claude 设置/, '要显示每个池的标签');
  assert.match(dirs, /共 6 份/, '每池份数');
  assert.match(dirs, /下一次备份会删：settings\.json\.bak-mixui-20260101-000000-000-abcd/, '下次删哪几个');
  assert.match(dirs, /保留上限 5 份/, '保留上限');
  assert.match(dirs, /abcdef012345/, '摘要要显示');
  assert.match(h.get('backup-status').textContent, /不含任何配置正文/);
  // 没有任何"一键恢复"入口。注意:面板文案里必须能说清"没有恢复按钮"这件事本身,
  // 所以只禁 <button>/onclick,不禁止"恢复"这个词出现在说明文字里。
  const settingsHtml = html.slice(html.indexOf('<section id="view-settings"'));
  assert.doesNotMatch(settingsHtml, /<button[^>]*>[^<]*恢复/, '设置页不许有恢复按钮(危险且本期无接口)');
  assert.doesNotMatch(settingsHtml, /restore/i, '不许出现恢复端点');
  assert.equal(h.requests.some(r => /restore/i.test(r.url)), false, '不许请求任何恢复端点');
});

test('设置页:路由解释明确写成预测,不当成实际落点', async () => {
  const h = await harness();
  h.run("showView('settings')");
  await new Promise(resolve => setImmediate(resolve));
  const panel = html.slice(html.indexOf('id="settings-preview-title"'), html.indexOf('id="settings-export-title"'));
  assert.match(panel, /预测,不是实际落点|这是预测/, '面板文案要把预测和实际分开');
  assert.match(panel, /不消耗轮询游标/, '要说明只读');
  await h.run('loadPreview()');
  assert.match(h.get('preview-body').innerHTML, /这是预测，不是实际落点/, '结果里也要重申');
  assert.match(h.get('preview-body').innerHTML, /Alpha/, '候选要列出来');
  assert.match(h.get('preview-body').innerHTML, /<dt>预测首选<\/dt><dd>Alpha<\/dd>/, '读取真实 API 的 selection.predicted,不能把候选当预测');
  assert.match(h.get('preview-status').textContent, /解释完成/);
});

test('设置页:预测读取策略选择的成员而不是候选列表第一项', async () => {
  const data = fixture();
  data.providers.claude[1].enabled = true;
  data.routes = { rules: [], default: { pool: ['a1', 'a2'], strategy: 'least_used' } };
  data.previewCounts = { a1: 2, a2: 0 };
  const h = await harness(data);
  await h.run('loadPreview()');
  assert.match(h.get('preview-body').innerHTML, /<dt>预测首选<\/dt><dd>Disabled<\/dd>/);
  assert.match(h.get('preview-body').innerHTML, /Alpha/, '候选首项仍然是 Alpha');
});

test('设置页:多候选随机策略的 predicted 为空时不冒充首个候选', async () => {
  const data = fixture();
  data.providers.claude[1].enabled = true;
  data.routes = { rules: [], default: { pool: ['a1', 'a2'], strategy: 'random' } };
  const h = await harness(data);
  await h.run('loadPreview()');
  assert.match(h.get('preview-body').innerHTML, /<dt>预测首选<\/dt><dd>无法确定\(如随机策略\)<\/dd>/);
  assert.match(h.get('preview-body').innerHTML, /Alpha/);
  assert.match(h.get('preview-status').textContent, /解释完成/);
});

test('设置页:指标导出走 Blob 下载,不引入依赖,失败不冒充成功', async () => {
  const h = await harness();
  h.run("showView('settings')");
  await new Promise(resolve => setImmediate(resolve));
  await h.run('exportMetrics()');
  assert.equal(h.downloads.length, 1, '要真的触发一次下载');
  assert.match(h.downloads[0].download, /^mixrouter-metrics-.*\.txt$/, '文件名要能看出来是什么');
  assert.match(h.get('metrics-msg').textContent, /已导出 .* 字节.*不含任何密钥/);
  // 失败:要说失败,不清空也不假装成功
  const h2 = await harness(); h2.fail({ metrics: true });
  await h2.run('exportMetrics()');
  assert.equal(h2.downloads.length, 0, '失败不许触发下载');
  assert.match(h2.get('metrics-msg').textContent, /指标导出失败/);
});

test('概览/设置页的 fetch 失败不影响其它页草稿(任务 7 口径)', async () => {
  const data = fixture();
  data.routes_revision = 'rev-one';
  data.compact = { key_selection_supported: true, revision: 'rev-one', mode: 'single', selection: { provider: 'a1', model: 'claude-special', key_id: '' }, providers: [data.providers.claude[0]], rules: [] };
  const h = await harness(data);
  h.fail({ health: true, backups: true, preview: true, metrics: true });
  h.run("routesDraft.rules[0].match = 'unfinished-rule'; markRoutesDirty()");
  h.run("pickCompactProvider('a1'); pickCompactModel('__custom__'); setCompactCustom('draft-model')");
  h.run("setWindowValue('300k')");
  const sessionBefore = h.run('JSON.stringify(state.sessions)');

  h.run("showView('settings')");
  await new Promise(resolve => setImmediate(resolve));
  // 预览不再随进页面自动跑(空白预览会平白刷 503),这里显式触发一次,好让"它失败"也被验到。
  h.run("document.getElementById('preview-model').value = 'claude-opus-4-8'; loadPreview()");
  await new Promise(resolve => setImmediate(resolve));
  // 三条都失败:页面照常,草稿一个都没动
  assert.match(h.get('backup-status').textContent, /读取失败/);
  assert.match(h.get('health-status').textContent, /读取失败/);
  assert.match(h.get('preview-status').textContent, /失败/);
  assert.equal(h.run("routesDraft.rules[0].match"), 'unfinished-rule', '通用路由草稿不受影响');
  assert.equal(h.run('compactDraft.model'), 'draft-model', '压缩草稿不受影响');
  assert.equal(h.run('windowDirty'), true, '窗口草稿不受影响');
  assert.equal(h.get('window-value').value, '300k', '窗口草稿的输入值也不受影响');
  assert.equal(h.run('routesDirty'), true);
  assert.equal(h.run('compactDirty'), true);
  assert.equal(h.run('JSON.stringify(state.sessions)'), sessionBefore, '服务端快照没被改动');
  // 回到概览也一样:失败的是设置页自己的那几块
  h.run("showView('overview')");
  await h.run('refresh()');
  assert.match(h.get('overview-todo').innerHTML, /没有需要处理的事项|已停用/, '概览照常渲染');
  assert.equal(h.run("routesDraft.rules[0].match"), 'unfinished-rule');
});

test('视图切换:gotoLogs 走 showView,视图改名后会话页的「日志」按钮仍然可用', async () => {
  const h = await harness();
  // 会话页那一行现在往 diagnostics 跳
  h.run("view = 'sessions'; renderSessions()");
  assert.match(h.get('sess-body').innerHTML, /gotoLogs\(/);
  assert.equal(h.requests.filter(r => r.url.startsWith('/api/logs?')).length === 0, true);
  h.run("gotoLogs('aaa11111')");
  assert.equal(h.run('view'), 'diagnostics', '要切到诊断页');
  assert.equal(h.get('breadcrumb-view').textContent, '诊断');
  assert.equal(h.get('f-session').value, 'aaa11111', '会话短 id 要带进日志筛选');
  assert.equal(h.run('logsTimer') !== null, true, '进入诊断页要起自动刷新计时器');
  // 切走要停掉计时器,不然在别的页也会每 5 秒打一次日志接口
  h.run("showView('overview')");
  assert.equal(h.run('logsTimer'), null, '离开诊断页要停掉自动刷新');
});

test('视图切换:七个视图各切一次,视图节显隐与面包屑都对得上', async () => {
  const h = await harness();
  // 这里只跑 app.js,外壳(workspace.js)不在虚拟 DOM 里,所以标题是 showView 写的通用名。
  // 真实页面上外壳在此之后把渠道页改写成「<客户端> 渠道」,那条由 workspace-ui.test.js 覆盖。
  for (const [v, label] of [['overview', '概览'], ['usage', '用量统计'], ['providers', '渠道与 Key'], ['routes', '路由'], ['sessions', '会话'], ['diagnostics', '诊断'], ['settings', '设置与备份']]) {
    h.run(`showView(${JSON.stringify(v)})`);
    assert.equal(h.run('view'), v);
    assert.equal(h.get('breadcrumb-view').textContent, label, `${v} 的面包屑`);
    for (const other of ['overview', 'usage', 'providers', 'routes', 'sessions', 'diagnostics', 'settings']) {
      const display = h.get('view-' + other).style.display;
      if (other === v) assert.notEqual(display, 'none', `${v} 自己要显示`);
      else assert.equal(display, 'none', `${other} 在 ${v} 时应当隐藏`);
    }
  }
  // 未知视图名不该把页面切成空白:showView 直接忽略
  const current = h.run('view');
  h.run("showView('nope')");
  assert.equal(h.run('view'), current, '未知视图名被忽略');
});
