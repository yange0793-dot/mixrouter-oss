'use strict';
// 会话 Key / 槽位覆盖界面。没有浏览器、不装依赖、不发真实请求、不写用户配置。
// 把 public/index.html 里的真实内联脚本放进一个刻意做小的 DOM/fetch 边界里跑。
//
// 界面只搬运已有 Key 的 ID:这里也据此断言——任何一次请求体里都不能出现渠道的 key 值,
// 界面上也不能出现 Key 明文(只有标签与 ID)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const script = new vm.Script(source, { filename: 'public/js/app.js' });

// 两把真 Key 值只用于"绝不出现在界面/请求里"的反向断言。
const SECRET_ONE = 'sk-secret-account-one-should-never-leak';
const SECRET_TWO = 'sk-secret-account-two-should-never-leak';

// 会话覆盖:claude 组指定 a1 用 k2;subagent 槽位覆盖到 a1 并显式指定 k1。
const SAMPLE_ROUTING = {
  keys: { a1: 'k2' },
  slots: { subagent: { provider: 'a1', model: 'claude-special', key_id: 'k1' } },
};

function fixture() {
  return {
    version: 'test', proxy_port: 8787, ui_port: 8788, uptime_s: 125,
    stats: { reqs: 12, inTok: 100, outTok: 40 },
    providers: {
      claude: [
        { id: 'a1', name: 'Alpha', base_url: 'https://anthropic.example', models: ['claude-special', 'claude-alt'], slots: {}, enabled: true, key_masked: '***',
          keys: [{ id: 'k1', label: 'Account One', enabled: true, key: SECRET_ONE }, { id: 'k2', label: 'Account Two', enabled: true, key: SECRET_TWO }], active_key: 'k1' },
        { id: 'a2', name: 'Disabled Co', base_url: 'https://old.example', models: ['claude-old'], enabled: false,
          keys: [{ id: 'k3', label: 'Third', enabled: true, key: 'sk-secret-three' }], active_key: 'k3' },
        { id: 'a3', name: 'Ghost Host', base_url: 'https://ghost.example', models: ['claude-ghost'], enabled: true,
          keys: [{ id: 'k4', label: 'Fourth', enabled: false, key: 'sk-secret-four' }], active_key: 'k4' },
      ],
      codex: [
        { id: 'o1', name: 'Beta', base_url: 'https://openai.example/v1', model: 'gpt-test', wire_api: 'responses', enabled: true, keys: [] },
      ],
    },
    current: { claude: 'a1', codex: 'o1' },
    live: {
      claude: { base_url: 'https://anthropic.example', model: 'claude-special', match: true, router: true },
      codex: { base_url: '', match: true, router: false },
    },
    router: { id: '@router', url: 'http://127.0.0.1:8787', claude_base: 'http://127.0.0.1:8787', codex_base: 'http://127.0.0.1:8787/v1' },
    slots: {
      claude: ['main', 'opus', 'sonnet', 'haiku', 'subagent'].map(name => ({
        name, alias: 'mixr-' + name,
        env: { main: 'ANTHROPIC_MODEL', subagent: 'CLAUDE_CODE_SUBAGENT_MODEL' }[name] || 'ANTHROPIC_DEFAULT_' + name.toUpperCase() + '_MODEL',
        provider: '', provider_name: '', enabled: true, model: '',
      })),
      codex: [{ name: 'worker', alias: 'mixr-worker', provider: '', provider_name: '', enabled: true, model: '' }],
    },
    sessions: [
      // 第二期 5.2.7 起 list() 给每条会话三层结构化状态(required/bound/actual)。
      // 这里按新契约摆数据,而不是只给旧的平铺字段——三层显示正是在读它们。
      { key: 'sess-full-key-alpha0000000000000001', short: 'alpha001', app: 'claude', kind: 'header', label: '修复登录跳转',
        provider: 'a1', provider_name: 'Alpha', model: 'claude-special', rule: 'r1', reqs: 3, inTok: 10, outTok: 5, lastUsed: 1700000000000, pinned: false, cooldown: false,
        required: { routing: structuredClone(SAMPLE_ROUTING), revision: 'sr-one', keys: 1, slots: 1 },
        bound: { provider: 'a1', provider_name: 'Alpha', model: 'claude-special', rule: 'r1', pinned: false, source: 'auto' },
        // 自动分配 + 最近实际也落在 Alpha:三层一致,不该出现"与当前绑定不同"
        actual: { provider: 'a1', provider_name: 'Alpha', model: 'claude-special', rule: 'r1', slot: 'main', sticky: true, status: 200, in: 12, out: 30, ms: 810, ts: 1700000009000 },
        actual_source: 'request', actual_text: 'Alpha',
        routing: structuredClone(SAMPLE_ROUTING), routing_revision: 'sr-one' },
      { key: 'sess-full-key-beta00000000000000002', short: 'beta002', app: 'codex', kind: 'metadata', label: '',
        provider: 'o1', provider_name: 'Beta', model: 'gpt-test', rule: '', reqs: 1, inTok: 1, outTok: 1, lastUsed: 1700000000001, pinned: true, cooldown: false,
        required: { routing: { keys: {}, slots: {} }, revision: 'sr-empty', keys: 0, slots: 0 },
        // 手动钉定:实际列此刻是「暂无」——服务端原样给的,界面必须照实显示,不能拿 o1 顶上
        bound: { provider: 'o1', provider_name: 'Beta', model: 'gpt-test', rule: '', pinned: true, source: 'manual' },
        actual: null, actual_source: 'none', actual_text: '暂无',
        routing: { keys: {}, slots: {} }, routing_revision: 'sr-empty' },
    ],
    cooldowns: [],
  };
}

async function harness(data = fixture()) {
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
        el.disabled = /\bdisabled\b/.test(match[0]);
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
    click() { this.onclick?.({ preventDefault() {} }); }
  }
  for (const m of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) elements.set(m[2], new Element(m[2], m[1]));
  const get = id => { assert.ok(elements.has(id), 'Unknown DOM id: ' + id); return elements.get(id); };
  const body = new Element('body', 'body');
  const nav = ['providers', 'routes', 'sessions', 'logs'].map(view => { const el = new Element('nav-' + view, 'a'); el.dataset.view = view; return el; });
  const tabs = new Element('tabs');
  document = {
    body, activeElement: body,
    getElementById: id => elements.get(id) || null,
    querySelectorAll: selector => selector === 'nav a' ? nav : [],
    querySelector: selector => selector === '.apptabs' ? tabs : nav.find(el => selector.includes(`data-view="${el.dataset.view}"`)) || null,
    addEventListener: (event, fn) => { (listeners.get(event) || listeners.set(event, []).get(event)).push(fn); },
  };
  for (const [parent, ids] of [['compact-panel', ['compact-provider', 'compact-model', 'compact-model-custom', 'compact-key']],
    ['compact-window-panel', ['window-scope', 'window-project', 'window-value']]]) {
    for (const id of ids) get(id).parentElement = get(parent);
    get(parent).parentElement = get('view-compact');
  }
  for (const [maskId, controls] of [['mask', ['m-name', 'm-base', 'm-key', 'save-provider']], ['confirm-mask', ['confirm-cancel', 'confirm-ok']],
    ['routing-mask', ['routing-close', 'routing-save', 'routing-clear', 'routing-reload']]]) {
    const mask = get(maskId); mask.modal = new Element(maskId + '-dialog'); mask.modal.parentElement = mask;
    mask.children = controls.map(id => { const el = get(id); el.parentElement = mask; return el; });
  }
  get('provider-filter').value = 'all'; get('logs-auto').checked = true;
  const requests = [];
  let failState = false;
  // 路由接口的假服务端:带 expected_revision 闸门,把失败注入留给用例自己改 routingFault。
  let routingFault = null;
  const windowListeners = new Map(), intervals = new Map();
  let timerId = 0;
  const context = vm.createContext({
    document, window: { addEventListener(name, callback) { (windowListeners.get(name) || windowListeners.set(name, []).get(name)).push(callback); } }, console, URL, URLSearchParams, AbortController, structuredClone,
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval(fn) { const id = ++timerId; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); },
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, method: options.method || 'GET', body });
      const fail = (status, error) => ({ ok: false, status, json: async () => ({ ok: false, error }) });
      if (url === '/api/state') {
        if (failState) throw new Error('simulated disconnect');
        return { ok: true, json: async () => structuredClone(data) };
      }
      if (url === '/api/stats') return { ok: true, json: async () => ({ reqs: 12, ok_rate: 100, inTok: 100, outTok: 40, cache: 0 }) };
      if (url.startsWith('/api/logs')) return { ok: true, json: async () => ({ logs: [] }) };
      const routingUrl = /^\/api\/sessions\/([^/]+)\/routing$/.exec(url);
      if (routingUrl) {
        const key = decodeURIComponent(routingUrl[1]);
        const s = data.sessions.find(x => x.key === key);
        if (routingFault) return fail(routingFault.status, routingFault.error);
        if (!s) return fail(404, 'session not found');
        if (options.method === 'PUT') {
          const expected = body?.expected_revision;
          if (expected !== (s.routing_revision ?? '')) return fail(409, '会话配置已变化，请重新载入后再保存');
          s.routing = structuredClone(body.routing);
          s.routing_revision = 'sr-' + (requests.length);
          return { ok: true, json: async () => ({ ok: true, routing: structuredClone(s.routing), revision: s.routing_revision }) };
        }
        return { ok: true, json: async () => ({ routing: structuredClone(s.routing || {}), revision: s.routing_revision ?? '' }) };
      }
      if (/^\/api\/sessions\/[^/]+\/pin$/.test(url)) return { ok: true, json: async () => ({ ok: true }) };
      if (url === '/api/sessions' && options.method === 'DELETE') { data.sessions = []; return { ok: true, json: async () => ({ ok: true, cleared: true }) }; }
      if (url.startsWith('/api/sessions/') && options.method === 'DELETE') {
        const key = decodeURIComponent(url.slice('/api/sessions/'.length));
        data.sessions = data.sessions.filter(x => x.key !== key);
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ ok: true, id: 'created-id' }) };
    },
  });
  const run = code => vm.runInContext(code, context);
  script.runInContext(context);
  await run('refreshTask');
  return {
    data, get, run, requests, document, listeners, windowListeners, tabs, intervals,
    disconnect(value = true) { failState = value; },
    fault(value) { routingFault = value; },
    // 打开弹窗并把首次 GET 等完(routingTask 就是那次在途请求)
    async open(short) {
      run(`openRouting(${JSON.stringify(short)})`);
      await run('routingTask');
    },
    async confirm(code) { const result = run(code); run('finishConfirm(true)'); await result; },
  };
}

const routingRequests = h => h.requests.filter(r => /\/api\/sessions\/.*\/routing$/.test(r.url));
const decode = s => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// 界面上的每一处可读文字(含属性值,如 option 的 value 与 select 的 aria-label)
function surfaceText(h) {
  const parts = [html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')];
  for (const id of ['routing-body', 'routing-refs-list', 'routing-conflict-list', 'routing-msg', 'routing-short', 'routing-key', 'routing-label', 'routing-app', 'sess-body', 'sess-chips', 'toast']) {
    const el = h.get(id); parts.push(decode(el.innerHTML || ''), decode(el.textContent || ''));
  }
  return parts.join('\n');
}
// 按短 id 切出某条会话那一行的 HTML。会话页现在同时显示「当前绑定」和「最近实际请求」两列,
// 不切行就没法说清某个渠道名到底出现在哪一列里(那正是这些断言要盯住的事)。
function rowOf(h, short) {
  const rows = h.get('sess-body').innerHTML.split('<tr data-session="').slice(1)
    .map(chunk => '<tr data-session="' + chunk);
  const row = rows.find(r => r.startsWith(`<tr data-session="${short}"`));
  assert.ok(row, `会话列表里应当有 ${short} 这一行`);
  return row;
}

test('三层分开读得到:当前绑定带来源标记,最近实际请求独立成一列,没有记录就是「暂无」', async () => {
  const h = await harness();
  h.run("view = 'sessions'; renderSessions()");
  // 自动分配的会话:绑定列说 Alpha,来源标记是自动分配;实际列那条是真请求记下来的
  const auto = rowOf(h, 'alpha001');
  assert.match(auto, /class="badge auto">自动分配/, '自动粘性绑定要标出「自动分配」');
  assert.match(auto, /class="actual-cell(?! diff)/, '实际与绑定一致时不该染 warn 色');
  assert.match(auto, /Alpha/, '实际渠道名要出现在行里');
  assert.match(auto, /200/, '实际状态码要显示');
  assert.match(auto, /粘性/, 'actual.sticky 要显示');
  assert.equal(/与当前绑定不同/.test(auto), false, '两边同渠道不能说成不同');

  // 手动钉定但没有实际记录的会话:实际列只能是「暂无」
  const manual = rowOf(h, 'beta002');
  assert.match(manual, /class="badge pin">手动钉定/, '钉定要标出「手动钉定」,不能和自动分配长得一样');
  assert.match(manual, /<span class="sub">暂无<\/span>/, '没有实际请求记录时必须显示「暂无」');
  assert.match(manual, /<option value="o1" selected>Beta/, '「暂无」说归说,绑定那份仍要照常可读可改');
  // 硬要求:不许拿绑定值冒充实际落点——「暂无」那一格里不能出现绑定渠道名
  const actualCell = manual.match(/<td>(<span class="actual-cell[\s\S]*?)<\/td>/)[1];
  assert.equal(actualCell.includes('Beta'), false, '不能拿绑定渠道冒充最近实际落点');

  // 统计条把「实际 ≠ 绑定」单独数出来,而不是揉进"活跃对话"里
  assert.match(h.get('sess-chips').innerHTML, /实际 ≠ 绑定<b>0<\/b>/, '两边一致的会话不计入不一致');
});

test('最近实际与当前绑定不同要显式标出:钉的渠道挂了、请求回退到别处是这一页的核心信息', async () => {
  const data = fixture();
  // 钉定 Alpha,最近一次真打的却是 Beta(failover 落到了池里的另一家)
  data.sessions[1].actual = { provider: 'a1', provider_name: 'Alpha', model: 'gpt-test', rule: '', slot: '', sticky: false, status: 502, in: 0, out: 0, ms: 120, ts: 1700000009500 };
  data.sessions[1].actual_source = 'request';
  data.sessions[1].actual_text = 'Alpha';
  const h = await harness(data);
  h.run("view = 'sessions'; renderSessions()");
  const row = rowOf(h, 'beta002');
  // 两个渠道名都要读得出来:绑定列是 Beta,实际列是 Alpha
  assert.match(row, /<option value="o1" selected>Beta/, '当前绑定仍是 Beta');
  const actualCell = row.match(/<td>(<span class="actual-cell[\s\S]*?)<\/td>/)[1];
  assert.match(actualCell, /Alpha/, '实际落点要显示 Alpha');
  assert.match(actualCell, /class="actual-cell diff"/, '不一致要染上 warn 色的类');
  assert.match(actualCell, /与当前绑定不同/, '要有一句人话点明不一致');
  assert.match(actualCell, /502/, '失败状态码也要照实显示');
  assert.match(h.get('sess-chips').innerHTML, /实际 ≠ 绑定<b>1<\/b>/, '统计条要数得出来');
});

test('绑定来源三种取值分别显示手动钉定 / 自动分配 / 未绑定', async () => {
  const data = fixture();
  // 三条会话各占一种来源:手动(已钉 a1)、自动(pinned=false 但有落点)、未绑定(没有落点)
  data.sessions = [
    { ...data.sessions[0], short: 's-manual', key: 'sess-manual', pinned: true, bound: { provider: 'a1', provider_name: 'Alpha', model: 'claude-special', rule: 'r1', pinned: true, source: 'manual' }, actual: null, actual_source: 'none', actual_text: '暂无' },
    { ...data.sessions[0], short: 's-auto', key: 'sess-auto', pinned: false, bound: { provider: 'a1', provider_name: 'Alpha', model: 'claude-special', rule: 'r1', pinned: false, source: 'auto' } },
    { ...data.sessions[0], short: 's-none', key: 'sess-none', pinned: false, provider: '', bound: { provider: '', provider_name: '', model: '', rule: '', pinned: false, source: 'none' }, actual: null, actual_source: 'none', actual_text: '暂无' },
  ];
  const h = await harness(data);
  h.run("view = 'sessions'; renderSessions()");
  assert.match(rowOf(h, 's-manual'), /class="badge pin">手动钉定/);
  assert.match(rowOf(h, 's-auto'), /class="badge auto">自动分配/);
  assert.match(rowOf(h, 's-none'), /class="badge off">未绑定/);
  assert.match(rowOf(h, 's-none'), /<option value="" selected>\(未绑定\)/, '未绑定时下拉要停在未绑定那一项');
  // 没有落点就谈不上来源,不能因为历史 pinned 就报成手动钉定
  assert.equal(/手动钉定/.test(rowOf(h, 's-none')), false);

  // 旧快照(没有 bound/source,只有平铺的 provider/pinned)按同一口径推,不显示成未绑定
  const legacy = fixture();
  legacy.sessions = legacy.sessions.map(s => { const { bound, required, actual, actual_source, actual_text, provider_name, ...rest } = s; return rest; });
  const l = await harness(legacy);
  l.run("view = 'sessions'; renderSessions()");
  assert.match(rowOf(l, 'beta002'), /class="badge pin">手动钉定/, '旧快照里 pinned=true 仍要读成手动钉定');
  assert.match(rowOf(l, 'alpha001'), /class="badge auto">自动分配/);
  assert.equal(/class="badge pin"/.test(rowOf(l, 'alpha001')), false);
});

test('会话页每行可打开配置弹窗:显示完整会话 id 与对话名称,Key 只给标签和 id', async () => {
  const h = await harness();
  h.run("view = 'sessions'; renderSessions()");
  const body = h.get('sess-body').innerHTML;
  assert.match(body, /配置 Key \/ 槽位/, '每行要有明确的操作入口');
  // 生成的 onclick 里引号被转义成 &quot;,按解码后的文本比对
  assert.match(decode(body), /openRouting\("sess-full-key-alpha0000000000000001"\)/,
    '入口要带完整会话 key:短 id 只有 8 位,两个会话撞同一个短 id 时会打开错的那个');
  assert.match(body, /继承全局/, '没有覆盖的会话要显示成继承全局');
  assert.match(body, /1 项覆盖|2 项覆盖/, '有覆盖的会话要在列表里给出概要');

  await h.open('alpha001');
  assert.equal(h.run('activeDialog.id'), 'routing-mask');
  assert.equal(h.get('routing-short').textContent, 'alpha001');
  assert.equal(h.get('routing-key').textContent, 'sess-full-key-alpha0000000000000001', '完整会话 id 要能读到,不是只给短 id');
  assert.equal(h.get('routing-label').textContent, '修复登录跳转');
  assert.match(h.get('routing-app').textContent, /Anthropic/);
  assert.equal(routingRequests(h).length, 1, '打开弹窗要读一次服务端配置');
  assert.equal(routingRequests(h)[0].method, 'GET');
  assert.match(routingRequests(h)[0].url, /sess-full-key-alpha0000000000000001\/routing$/, '接口要用完整会话 id');
  const text = surfaceText(h);
  assert.equal(text.includes(SECRET_ONE), false, '界面不得出现 Key 明文');
  assert.equal(text.includes(SECRET_TWO), false, '界面不得出现 Key 明文');
  assert.equal(h.get('routing-body').innerHTML.includes('sk-'), false);
});

test('弹窗只提交已有 Key 的 ID:渠道级 Key 默认继承,槽位可覆盖渠道并显式指定 Key', async () => {
  const h = await harness();
  await h.open('alpha001');
  // 渠道级 Key:Alpha 显示为已指定 Account Two,Disabled Co 保持继承
  const body = h.get('routing-body').innerHTML;
  assert.match(body, /该会话在此渠道使用的 Key/);
  assert.match(body, /继承渠道当前 Key/, '默认必须是继承渠道当前 Key');
  assert.match(body, /Account Two（k2）/);
  assert.match(body, /Account One（k1）/);
  assert.match(body, /已停用/, '停用的 Key 要标出来');

  // 把 Alpha 改回继承,再给 subagent 槽位换渠道并指定 Key
  h.run("routingSetKey('a1','')");
  h.run("routingSetSlotProvider('subagent','a1')");
  h.run("routingSetSlotKey('subagent','k2')");
  h.run("routingSetSlotModel('subagent','claude-alt')");
  assert.equal(h.run('routingDirty'), true);
  await h.run('saveRouting()');
  const put = routingRequests(h).find(r => r.method === 'PUT');
  assert.ok(put, '保存要发 PUT');
  assert.deepEqual(put.body, {
    routing: { keys: {}, slots: { subagent: { provider: 'a1', model: 'claude-alt', key_id: 'k2' } } },
    expected_revision: 'sr-one',
  }, '空映射不留在载荷里(移除条目＝恢复继承),Key 只传 id');
  assert.equal(JSON.stringify(put.body).includes('sk-'), false, '任何请求体都不得带 Key 明文');
  assert.equal(h.run('routingDirty'), false, '保存成功后草稿应回到已保存状态');
  assert.equal(h.data.sessions[0].routing.slots.subagent.key_id, 'k2');
});

test('弹窗保存后立即回写列表概要,并发的后台刷新不会拿旧数据盖掉草稿', async () => {
  const h = await harness();
  h.run("view = 'sessions'; renderSessions()");
  await h.open('alpha001');
  h.run("routingSetKey('a2','k3')");
  // 保存进行中把服务端状态刷新成"旧"的,模拟请求还在路上时的轮询
  const saving = h.run('saveRouting()');
  await h.run('refresh()');
  await saving;
  assert.equal(h.run('routingDirty'), false);
  assert.equal(h.run("routingDraft.keys.a2"), 'k3', '后台刷新不得覆盖正在进行/刚完成的草稿');
  assert.match(h.get('toast').textContent, /已保存该会话/);
  assert.equal(h.data.sessions[0].routing.keys.a2, 'k3');
});

test('版本冲突(409)保留草稿并列出差异,不静默覆盖也不假装保存成功', async () => {
  const h = await harness();
  await h.open('alpha001');
  h.run("routingSetKey('a2','k3')");
  // 别人先改了服务端那一版
  h.data.sessions[0].routing = { keys: { a1: 'k1' }, slots: {} };
  h.data.sessions[0].routing_revision = 'sr-other';
  await h.run('refresh()');
  assert.match(h.get('routing-msg').textContent, /已被其他改动更新|版本/, '轮询发现版本变化就要提示');
  assert.equal(h.get('routing-conflict').classList.contains('show'), true, '冲突条要显出来');
  assert.match(h.get('routing-conflict-list').innerHTML, /Account One（k1）|恢复继承/, '要摆出具体差异');
  assert.equal(h.run('routingDirty'), true);

  await h.run('saveRouting()');
  assert.match(h.get('toast').textContent, /409|版本/, '失败要如实报出来');
  assert.match(h.get('routing-msg').textContent, /409|版本/);
  assert.equal(h.run("routingDraft.keys.a2"), 'k3', '冲突后草稿必须还在');
  assert.equal(h.data.sessions[0].routing.keys.a1, 'k1', '冲突时不得写入服务端');
  assert.equal(h.run('routingDirty'), true);
  // 放弃草稿重载 → 服务端那版
  await h.confirm('reloadRouting()');
  assert.equal(h.run('routingDirty'), false);
  assert.equal(h.run("routingDraft.keys.a1"), 'k1');
  assert.equal(h.run("routingDraft.keys.a2"), undefined);
});

test('失效或停用的引用显式列出,固定 Key 失败声明不回退,保存仍按用户选择提交', async () => {
  const h = await harness();
  const ghost = fixture();
  ghost.sessions[0].routing = {
    keys: { a9: 'k9', a1: 'k2' },
    slots: { subagent: { provider: 'a1', key_id: 'k9' }, opus: { provider: 'a9' } },
  };
  const g = await harness(ghost);
  await g.open('alpha001');
  assert.equal(g.get('routing-refs').classList.contains('show'), true, '失效引用要显式列出,不能等保存被拒才知道');
  const refs = g.get('routing-refs-list').innerHTML;
  assert.match(refs, /不存在或不属于本组的渠道（a9）/, '指向已删除渠道要指名道姓');
  assert.match(refs, /Key 已失效（k9）/);
  assert.match(g.get('routing-body').innerHTML, /保留原选择/, '失效的 Key 选择要保留,不自动改选别的');
  assert.match(g.get('routing-body').innerHTML, /已失效 Key（k9）/, '失效项仍要留在下拉里');
  assert.match(g.get('routing-msg').textContent, /草稿与上次读取一致/, '刚读到手的草稿不算未保存');
  const put = g.requests;
  await g.run('saveRouting()');
  const body = routingRequests(g).find(r => r.method === 'PUT').body;
  assert.equal(body.routing.keys.a9, 'k9', '失效引用要原样提交,由服务端明确拒绝,而不是前端偷偷改掉');
  assert.equal(body.routing.slots.opus.provider, 'a9');
  assert.equal(put.length > 0, true);
  assert.equal(g.run('routingDirty'), false, '成功保存后草稿回到已保存态');

  // 服务端拒掉(400)时如实报,草稿保留
  g.data.sessions[0].routing_revision = 'sr-now';
  g.run("routingSetKey('a2','k3')");
  g.fault({ status: 400, error: 'routing.keys 引用了不存在的渠道' });
  await g.run('saveRouting()');
  assert.match(g.get('toast').textContent, /400|不存在/);
  assert.equal(g.run('routingDirty'), true, '被拒后草稿仍保留');
  g.fault(null);
});

test('停用渠道与停用渠道的 Key 都标出但不阻止保存,期间新增失效引用会即时出现', async () => {
  const h = await harness();
  await h.open('alpha001');
  h.run("routingSetKey('a2','k3')");
  h.run("routingSetSlotProvider('opus','a2')");
  assert.match(h.get('routing-refs-list').innerHTML, /Disabled Co 已停用/, '停用渠道要提示');
  assert.match(h.get('routing-body').innerHTML, /该渠道已停用/, '停用渠道的行内也要标注');
  assert.match(h.get('routing-msg').textContent, /未保存的改动/, '提示归提示,状态里不该出现报错字样');
  // 请求发出前渠道被删:打开期间刷新要立刻反映出来
  h.data.providers.claude = h.data.providers.claude.filter(p => p.id !== 'a2');
  await h.run('refresh()');
  assert.match(h.get('routing-refs-list').innerHTML, /不存在或不属于本组的渠道（a2）/, '期间被删的渠道要即时提示');
  assert.equal(h.run("routingDraft.keys.a2"), 'k3', '刷新不得改动草稿');
});

test('保存请求在途时的新编辑不被响应吞掉,也不冒充已保存', async () => {
  const h = await harness();
  await h.open('alpha001');
  h.run("routingSetKey('a2','k3')");
  let release = null;
  h.run("globalThis.__realFetch = fetch; globalThis.fetch = (url, opt) => /\\/routing$/.test(url) && opt && opt.method === 'PUT' ? new Promise(res => { release = async () => res(await __realFetch(url, opt)); }) : __realFetch(url, opt)");
  const saving = h.run('saveRouting()');
  await new Promise(resolve => setImmediate(resolve));
  h.run("routingSetKey('a3','k4')");
  await h.run('release()');
  await saving;
  assert.equal(h.run('routingDirty'), true, '提交后才做的编辑仍是未保存状态');
  assert.equal(h.run("routingDraft.keys.a3"), 'k4', '在途编辑不能被响应覆盖');
  const put = routingRequests(h).find(r => r.method === 'PUT');
  assert.equal(put.body.routing.keys.a2, 'k3', '发出去的是提交那一刻的选择');
  assert.match(h.get('toast').textContent, /草稿|再保存/, '要提示还有新改动没提交');
});

test('清空配置要逐条说明会删掉什么,删除/清空会话也明确提示配置一并删除', async () => {
  const h = await harness();
  h.run("view = 'sessions'; renderSessions()");
  await h.open('alpha001');
  const clearing = h.run('clearRouting()');
  const text = h.get('confirm-text').textContent;
  assert.match(h.get('confirm-title').textContent, /清空该会话/);
  assert.match(text, /Alpha → Account Two（k2）/, '要列出会被删掉的 Key 绑定');
  assert.match(text, /槽位 subagent/, '要列出会被删掉的槽位覆盖');
  assert.match(text, /继承全局槽位/);
  h.run('finishConfirm(false)');
  assert.equal(await clearing, undefined);
  assert.equal(h.get('routing-mask').classList.contains('show'), true, '取消后弹窗要回来,草稿还在');
  assert.equal(h.data.sessions[0].routing.keys.a1, 'k2', '取消不得写入');

  await h.confirm('clearRouting()');
  const put = routingRequests(h).find(r => r.method === 'PUT');
  assert.deepEqual(put.body.routing, { keys: {}, slots: {} }, '清空就是提交一份空映射');
  assert.deepEqual(h.data.sessions[0].routing, { keys: {}, slots: {} });
  assert.equal(h.run('routingDirty'), false);

  // 解绑单个会话:先放回一条带配置的会话。
  // 保存内部还会自己触发一次 refresh,要先等它收尾——refresh() 对在途请求是去重的,
  // 不等就会把下面这次调用并进那一次,拿回改动之前的快照。
  await h.run('refreshTask');
  h.data.sessions = [fixture().sessions[0]];
  await h.run('refresh()');
  // 会话配置弹窗还开着,确认框必须叠在它上面,不能静默什么都不做
  const unbinding = h.run("unbindSession('sess-full-key-alpha0000000000000001')");
  assert.equal(h.get('confirm-mask').classList.contains('show'), true, '弹窗开着时解绑也要真的问一句');
  assert.match(h.get('confirm-title').textContent, /解绑该会话/);
  assert.match(h.get('confirm-text').textContent, /Key \/ 槽位配置会一起删除/, '解绑要提示配置一起删');
  h.run('finishConfirm(false)'); await unbinding;
  assert.equal(h.get('routing-mask').classList.contains('show'), true, '取消解绑后配置弹窗要回来');
  // 清空全部
  const clearingAll = h.run('clearSessions()');
  assert.equal(h.get('confirm-mask').classList.contains('show'), true);
  assert.match(h.get('confirm-text').textContent, /配了 Key \/ 槽位覆盖|一并删除/, '清空全部要提示配置一起删');
  h.run('finishConfirm(false)'); await clearingAll;
});

test('恢复继承:移除槽位覆盖与 Key 指定后按空映射提交', async () => {
  const h = await harness();
  await h.open('alpha001');
  h.run("routingRemoveSlot('subagent')");
  h.run("routingSetKey('a1','')");
  assert.equal(h.run('JSON.stringify(routingDraft)'), JSON.stringify({ keys: {}, slots: {} }), '移除条目即恢复继承,不留空对象');
  assert.match(h.get('routing-msg').textContent, /未保存的改动/);
  await h.run('saveRouting()');
  const put = routingRequests(h).find(r => r.method === 'PUT');
  assert.deepEqual(put.body.routing, { keys: {}, slots: {} });
  assert.equal(h.run('routingDirty'), false);
});

test('Codex 组可自定义槽位名,非法名与重复名不写入草稿', async () => {
  const h = await harness();
  await h.open('beta002');
  assert.equal(h.get('routing-body').innerHTML.includes('id="rt-new-slot"'), true, 'Codex 组要能加自定义槽');
  assert.equal(h.get('routing-body').innerHTML.includes('rt-slot-worker'), true, '已有 Codex 槽位要列出来');
  h.get('rt-new-slot').value = 'Bad Name';
  h.run('routingAddSlot()');
  assert.match(h.get('toast').textContent, /小写字母/, '非法槽位名要当场拒掉');
  assert.equal(h.run("Object.keys(routingDraft.slots).length"), 0);
  h.get('rt-new-slot').value = 'worker';
  h.run('routingAddSlot()');
  assert.equal(h.run("routingDraft.slots.worker.provider"), '', '新槽位先摆出来,等用户选渠道');
  h.get('rt-new-slot').value = 'worker';
  h.run('routingAddSlot()');
  assert.match(h.get('toast').textContent, /已有覆盖/);
  // 还没选渠道的空条目:界面要标成无效并说明保存会被拒,而不是悄悄丢掉(丢＝替用户改了配置)
  assert.match(h.get('routing-body').innerHTML, /无效条目/);
  assert.match(h.get('routing-body').innerHTML, /这条槽位没有选渠道，服务端会拒绝保存/);
  assert.match(h.get('routing-refs-list').innerHTML, /槽位 worker 没有选渠道/, '没选渠道的空条目要说"没有选渠道",不报一个空渠道 id');
  // 选了渠道就是合法覆盖
  h.run("routingSetSlotProvider('worker','o1')");
  assert.match(h.get('routing-body').innerHTML, /已覆盖/);
  // 不想留就明确移除
  h.run("routingRemoveSlot('worker')");
  await h.run('saveRouting()');
  assert.deepEqual(routingRequests(h).find(r => r.method === 'PUT').body.routing, { keys: {}, slots: {} });
});

test('清空时按「发起保存那一刻发出去的那一版」判在途编辑:丢弃草稿的清空不留下清空前的旧草稿', async () => {
  const h = await harness();
  await h.open('alpha001');
  await h.run("routingSetKey('a2','k3')");
  assert.equal(h.run("routingDraft.keys.a2"), 'k3');
  await h.confirm('clearRouting()');
  // 这次 PUT 发的是 {keys:{},slots:{}},它才是"有没有新编辑"的参照物。
  // 若拿草稿(此时已被强制替换成空集)去跟空载荷比,会把清空前的 a2→k3 当成用户新改的重新留着。
  assert.deepEqual(routingRequests(h).find(r => r.method === 'PUT').body.routing, { keys: {}, slots: {} });
  // 草稿对象来自 vm 上下文,跨 realm 的原型不同,deepStrictEqual 会假失败,按 JSON 比
  assert.equal(h.run('JSON.stringify(routingNormalize(routingDraft))'), '{"keys":{},"slots":{}}', '清空并丢弃草稿后,草稿就是空的那一版');
  assert.equal(h.run('routingDirty'), false, '丢弃草稿又要保存,成功后不该还挂着"未保存"');
  assert.equal(h.run('routingSession.routing_revision'), h.run('routingRevision'));
  assert.doesNotMatch(h.get('toast').textContent, /再保存|新改动|草稿/, '不该提示"草稿里还有新改动"');
  assert.match(h.get('routing-msg').textContent, /草稿与上次读取一致/);
  assert.equal(h.get('routing-msg').textContent.includes('有未保存的改动'), false);
  assert.equal(h.get('routing-save').textContent.includes('未保存'), false, '保存按钮不该还标着未保存');
});

test('清空后仍能只按一次改动再保存:草稿重新贴回服务端那一版,再点保存直接成功', async () => {
  const h = await harness();
  await h.open('alpha001');
  await h.run("routingSetKey('a2','k3')");
  await h.confirm('clearRouting()');
  assert.equal(h.run('routingDirty'), false);
  // 清空之后又改一次:草稿与 revision 必须都回到可再次提交的状态
  h.run("routingSetKey('a1','k2')");
  assert.equal(h.run('routingDirty'), true, '清空后的新改动要正常算未保存');
  await h.run('saveRouting()');
  const puts = routingRequests(h).filter(r => r.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.deepEqual(puts[1].body.routing, { keys: { a1: 'k2' }, slots: {} }, '第二次保存要带上清空后的新改动');
  assert.notEqual(puts[1].body.expected_revision, '', '不得拿空版本号写入');
  assert.notEqual(puts[1].body.expected_revision, puts[0].body.expected_revision, '第二次带的是清空后服务端返回的新版本');
  assert.equal(h.run('routingDirty'), false);
  assert.deepEqual(h.data.sessions[0].routing, { keys: { a1: 'k2' }, slots: {} }, '服务端存的是清空后那一版');
});

test('已删渠道的绑定能单项清掉:「恢复继承」带上那条绑定的渠道 id,并真的从草稿里删掉', async () => {
  // 行渲染时 p 为 null,渠道 id 只能由 routingKeyRows 作为第 4 参传进来。
  // 少了它,下拉和按钮的 id/参数都是空串,那条失效绑定在界面上永远删不掉。
  const data = fixture();
  data.sessions[0].routing = { keys: { gone1: 'k2', a1: 'k2' }, slots: {} };
  const h = await harness(data);
  await h.open('alpha001');
  const body = decode(h.get('routing-body').innerHTML);
  assert.match(body, /渠道已删除/, '已不在本组的渠道要单独列出来');
  assert.match(body, /rt-key-gone1/, '那一行的下拉要有可用的 id,不能是空串');
  // handlerArg 生成的是带双引号的 JSON,解码后属性里就是 routingSetKey("gone1",'')
  assert.match(body, /onclick="routingSetKey\("gone1",''\)"/, '「恢复继承」要带上这条绑定的渠道 id');
  assert.match(h.get('routing-refs-list').innerHTML, /Key 绑定指向不存在或不属于本组的渠道（gone1）/);

  // 真按下去:只删这一条,别的渠道的绑定不受影响
  h.run("routingSetKey('gone1','')");
  assert.equal(h.run("Object.hasOwn(routingDraft.keys,'gone1')"), false, '点「恢复继承」是删除条目,不是把值改成空串留着');
  assert.equal(h.run("routingDraft.keys.a1"), 'k2', '不许连带动别的渠道');
  assert.match(h.get('routing-body').innerHTML, /已删除/, '列表里那条绑定要消失');
  await h.run('saveRouting()');
  assert.deepEqual(routingRequests(h).find(r => r.method === 'PUT').body.routing, { keys: { a1: 'k2' }, slots: {} });
});

test('槽位 key_id 被指定为空串也要算无效:own() 就算点了名,服务端照样拒', async () => {
  // 服务端对 slots[].key_id 只查 own(),不看内容:空串也是"点了名",查不到 Key 必拒。
  // 界面若用 if (key_id) 判,空串被整个跳过——失效清单和状态提示都会漏报。
  const data = fixture();
  data.sessions[0].routing = { keys: {}, slots: { subagent: { provider: 'a1', key_id: '' } } };
  const h = await harness(data);
  await h.open('alpha001');
  assert.match(h.get('routing-refs-list').innerHTML, /槽位 subagent 指定的 Key 被指定为空/, '空 key_id 要进失效清单');
  assert.match(h.get('routing-msg').textContent, /无效引用/, '状态里不能只说"与上次读取一致"');
  assert.equal(h.run("Object.hasOwn(routingDraft.slots.subagent,'key_id')"), true, '空 key_id 必须原样留在草稿里');
  await h.run('saveRouting()');
  assert.equal(routingRequests(h).find(r => r.method === 'PUT').body.routing.slots.subagent.key_id, '', '原样提交,不给用户悄悄清掉');

  // 同一份配置在会话列表的概要里也要显示为无效,不能显示成正常覆盖
  h.run("view = 'sessions'; renderSessions()");
  assert.match(decode(h.get('sess-body').innerHTML), /1 项引用已失效/, '列表概要要标出失效引用');
});

test('冲突提示不再说"保存会覆盖服务端那版":与「再点保存仍是 409」的实情对齐', async () => {
  const h = await harness();
  await h.open('alpha001');
  h.run("routingSetKey('a1','')");
  // 服务端在后台被改了:列表里的 revision 与打开时读到的不一致
  h.data.sessions[0].routing = { keys: {}, slots: {} };
  h.data.sessions[0].routing_revision = 'sr-other';
  await h.run('refresh()');
  const msg = h.get('routing-msg').textContent;
  assert.match(msg, /版本/);
  assert.equal(/保存会覆盖服务端那版|保存会覆盖/.test(msg), false,
    '界面只按读到的版本写入,再点保存必定再被拒,不能承诺会覆盖');
  assert.match(msg, /放弃草稿并重载|重新/, '要指出真正能走通的路');
  assert.equal(h.get('routing-conflict').classList.contains('show'), true, '冲突条要摆出来');
  assert.ok(h.get('routing-conflict-list').innerHTML.length > 0, '冲突条要列出与当前服务端版本的具体差异');
});

test('断网、缺字段与 404 都不冒充操作成功,三扇门被锁住且草稿不丢', async () => {
  const h = await harness();
  h.run("view = 'sessions'; renderSessions()");
  h.disconnect();
  await h.run('refresh()');
  await h.run("openRouting('alpha001')");
  assert.match(h.get('toast').textContent, /离线/, '离线不得打开配置弹窗');
  assert.equal(h.get('routing-mask').classList.contains('show'), false);
  h.disconnect(false);
  await h.run('refresh()');
  assert.equal(h.run('online'), true);

  // 服务端响应报错:明确报出是读取失败,而不是把空当继承
  h.fault({ status: 500, error: 'boom' });
  h.run("openRouting('alpha001')");
  await h.run('routingTask');
  assert.match(h.get('routing-msg').textContent, /读取该会话覆盖配置失败/, '读失败要说清楚是读取失败');
  assert.equal(h.run('routingRevision'), null);
  assert.match(h.get('routing-body').innerHTML, /^$/, '读不到就不要摆一份看起来像继承的草稿');
  h.run("document.getElementById('routing-save').disabled = false");
  await h.run('saveRouting()');
  assert.match(h.get('toast').textContent, /尚未读到/, '没读到服务端版本的草稿不许保存');
  assert.equal(routingRequests(h).some(r => r.method === 'PUT'), false, '不得发出没有版本号的写入');
  h.fault(null);
  await h.run('reloadRouting()');
  assert.equal(h.run('routingRevision'), 'sr-one', '重载后按钮恢复可用');
  assert.equal(h.get('routing-save').disabled, false);

  // 会话在别的标签页被清空
  h.data.sessions = [];
  await h.run('refresh()');
  assert.equal(h.run('routingSession'), null, '会话没了要收摊');
  assert.equal(h.get('routing-mask').classList.contains('show'), false);
  assert.match(h.get('toast').textContent, /已不在列表里/, '要告诉用户弹窗为什么关了');
  assert.equal(routingRequests(h).filter(r => r.method === 'PUT').length, 0, '期间不得提交任何写入');
});

test('关闭与取消的语义:保存中不许关,取消确认后草稿和弹窗都在', async () => {
  const h = await harness();
  h.run("view = 'sessions'; renderSessions()");
  await h.open('alpha001');
  assert.deepEqual(routingRequests(h).map(r => r.method), ['GET'], '打开弹窗只读不写');
  h.run("routingSaving = true");
  h.run('closeRoutingModal()');
  assert.equal(h.run('activeDialog.id'), 'routing-mask', '保存中不许关掉弹窗');
  assert.match(h.get('toast').textContent, /正在保存/);
  h.run('routingSaving = false');
  h.run("routingSetKey('a2','k3')");
  assert.equal(h.run('routingDirty'), true);
  const closing = h.run('closeRoutingModal()');
  assert.equal(h.get('confirm-mask').classList.contains('show'), true, '有未保存改动时关闭要确认');
  h.run('finishConfirm(false)');
  await closing;
  assert.equal(h.run('activeDialog.id'), 'routing-mask', '取消关闭后弹窗还在');
  assert.equal(h.run("routingDraft.keys.a2"), 'k3', '取消关闭不丢草稿');
  await h.confirm('closeRoutingModal()');
  assert.equal(h.run('activeDialog'), null);
  assert.equal(h.run("routingDirty"), false);
  assert.equal(routingRequests(h).some(r => r.method === 'PUT'), false, '关闭不是保存,不得写服务端');
});

test('生成的处理函数仍可安全编译:含引号/尖括号的渠道与 Key 名不会破坏属性', async () => {
  const data = fixture();
  data.providers.claude[0].id = `a'"<&`;
  data.providers.claude[0].name = '<script>bad()</script>';
  data.providers.claude[0].keys[0].label = '"><img src=x onerror=bad()>';
  data.providers.claude[0].keys[0].id = `k'"<&`;
  data.sessions[0].routing = { keys: { [`a'"<&`]: `k'"<&` }, slots: { subagent: { provider: `a'"<&`, key_id: `k'"<&` } } };
  const h = await harness(data);
  await h.open('alpha001');
  assert.ok(routingRequests(h).some(r => r.method === 'GET'), '弹窗要先读到服务端那一版');
  for (const fragment of [h.get('routing-body').innerHTML, h.get('sess-body').innerHTML, h.get('routing-refs-list').innerHTML]) {
    assert.equal(fragment.includes('<script>bad()'), false, '必须转义,不能把渠道名当 HTML');
    assert.equal(fragment.includes('<img src=x onerror='), false, 'Key 标签里的标签同样要转义');
    for (const match of fragment.matchAll(/\bon(?:click|input|change|submit)="([^"]*)"/g)) new vm.Script(`(function(event){${decode(match[1])}})`);
  }
  await h.run('saveRouting()');
  const put = routingRequests(h).find(r => r.method === 'PUT');
  assert.equal(put.body.routing.keys[`a'"<&`], `k'"<&`, '转义只影响显示,提交的值要原样');
});

test('弹窗沿用既有对话框语义:Tab 圈定、Escape 关闭、焦点归还,离页前拦住未保存草稿', async () => {
  const h = await harness();
  h.run("view = 'sessions'; renderSessions()");
  const opener = h.get('sess-empty');
  opener.focus();
  await h.open('alpha001');
  assert.equal(h.get('workspace').inert, true);
  assert.equal(h.document.activeElement, h.get('routing-close'));
  const keydown = key => {
    let prevented = false;
    for (const listener of h.listeners.get('keydown')) listener({ ...key, preventDefault() { prevented = true; } });
    return prevented;
  };
  h.run("routingSetKey('a2','k3')");
  assert.equal(h.run('routingDirty'), true);
  let prevented = false;
  for (const listener of h.windowListeners.get('beforeunload')) listener({ preventDefault() { prevented = true; }, returnValue: undefined });
  assert.equal(prevented, true, '有未保存的会话草稿时要拦住离页');
  h.run('routingDirty = false');
  keydown({ key: 'Escape' });
  assert.equal(h.run('activeDialog'), null, 'Escape 关闭配置弹窗(不是渠道弹窗的那套)');
  assert.equal(h.get('workspace').inert, false);
  // 确认框弹在本弹窗之上时,确认完要把本弹窗放回来
  await h.open('alpha001');
  const asking = h.run("routingAsk('t', 'm', 'ok')");
  assert.equal(h.get('confirm-mask').classList.contains('show'), true);
  h.run('finishConfirm(true)');
  assert.equal(await asking, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.get('routing-mask').classList.contains('show'), true, '确认后配置弹窗要回来');
});

test('界面提交的载荷形状与服务端 normalizeRouting 完全一致', async () => {
  // 这条是跨模块的契约检查:界面拼出来的 routing 必须能原样被真实现有模块吃下,
  // 否则用户点「保存」只会换来一个 400,而界面自己看不出哪里错了。
  const cfg = require('../lib/routing/session-config.js');
  const providers = [
    { id: 'a1', name: 'Alpha', enabled: true, keys: [{ id: 'k1', label: 'One', key: 'sk-1' }, { id: 'k2', label: 'Two', key: 'sk-2' }] },
    { id: 'o1', name: 'Beta', enabled: true, keys: [] },
  ];
  const h = await harness();
  await h.open('alpha001');
  h.run("routingSetKey('a1','k2')");
  h.run("routingSetSlotProvider('subagent','a1')");
  h.run("routingSetSlotModel('subagent','claude-special')");
  h.run("routingSetSlotKey('subagent','k1')");
  await h.run('saveRouting()');
  const sent = routingRequests(h).find(r => r.method === 'PUT').body.routing;
  assert.deepEqual(cfg.normalizeRouting(structuredClone(sent), 'claude', providers), sent,
    '界面发出的 routing 必须原样通过服务端归一化');
  // 清空提交的空映射同样合法
  assert.deepEqual(cfg.normalizeRouting({ keys: {}, slots: {} }, 'claude', providers), { keys: {}, slots: {} });
  // 槽位名两侧用同一套规则
  assert.doesNotThrow(() => cfg.normalizeRouting({ keys: {}, slots: { worker: { provider: 'o1' } } }, 'codex', providers));
  assert.throws(() => cfg.normalizeRouting({ keys: {}, slots: { 'Bad Name': { provider: 'o1' } } }, 'codex', providers), /槽位名称不合法/);
  // 界面按 revision 做乐观并发:同一份 routing 必须算出同一个 revision
  assert.equal(cfg.routingRevision(sent), cfg.routingRevision(structuredClone(sent)));
});

test('停用的 Key 在选项里标出且不可选,继承到停用账号时明确预警', async () => {
  // publicProvider 现在给每把 Key 带 enabled 布尔(停用即 false)。界面据此把停用的那把
  // 标出来、置灰,并在"继承渠道当前账号"恰好是停用账号时说出来——否则用户会以为继承就等于能用。
  const data = fixture();
  // 这个会话没有任何 Key 绑定:两条渠道都走"继承渠道当前账号"那条路
  data.sessions[0].routing = { keys: {}, slots: {} };
  data.providers.claude[0].active_key = 'k2';
  data.providers.claude[0].keys[1].enabled = false; // k2 是当前生效账号,但已停用
  const h = await harness(data);
  await h.open('alpha001');
  const body = h.get('routing-body').innerHTML;
  assert.match(body, /Account Two（k2） · 已停用/, '停用的 Key 要标出来');
  assert.match(body, /<option value="k2" disabled/, '停用的 Key 不能被选');
  assert.match(body, /继承渠道当前生效账号：Account Two（k2） —— 该账号当前已停用/, '继承到停用账号要说清继承过来同样失败');
  // 服务端同样认定它不可用:两侧判定一致
  const cfg = require('../lib/routing/session-config.js');
  assert.throws(() => cfg.normalizeRouting({ keys: { a1: 'k2' }, slots: {} }, 'claude',
    [{ ...data.providers.claude[0], key_masked: undefined }]), /Key 不存在|已停用/,
    '界面置灰的那把 Key,服务端也必须拒绝');
});

test('槽位模型留空＝用所选渠道的默认模型,Codex 候选含渠道 model', async () => {
  // resolveSessionSlot 在省略 model 时取的是**所选渠道**的默认模型
  // (codex 用 provider.model,claude 用 provider.models[0]),不是全局槽位那个模型。
  // 界面原来写"继承全局模型",与实际行为不符。
  const cfg = require('../lib/routing/session-config.js');
  const data = fixture();
  data.providers.codex[0].model = 'gpt-single';
  const h = await harness(data);
  await h.open('beta002');
  let body = h.get('routing-body').innerHTML;
  assert.equal(body.includes('继承全局模型'), false, '没有"继承全局模型"这回事');
  assert.match(body, /渠道默认模型/, '留空要说清是走所选渠道的默认模型');
  // 选了渠道后,占用位提示要报出该渠道的默认模型
  h.run("routingSetSlotProvider('worker','o1')");
  body = h.get('routing-body').innerHTML;
  assert.match(body, /渠道默认模型（gpt-single）/, 'Codex 默认模型来自 provider.model(单数)');
  h.run("routingSetSlotModel('worker','gpt-single')");
  // 界面写下的值与服务端解析出来的落点模型一致
  await h.run('saveRouting()');
  const sent = routingRequests(h).find(r => r.method === 'PUT').body.routing;
  const resolved = cfg.resolveSessionSlot({ provider: 'global', model: 'global-model' }, 'mixr-worker', 'codex', sent,
    [{ id: 'o1', name: 'Beta', enabled: true, model: 'gpt-single' }]);
  assert.equal(resolved.model, 'gpt-single');

  // Claude:候选是 models 列表,默认取第一项
  await h.run('closeRoutingModal()');
  await h.open('alpha001');
  h.run("routingSetSlotProvider('opus','a1')");
  const claudeBody = h.get('routing-body').innerHTML;
  assert.match(claudeBody, /渠道默认模型（claude-special）/, 'Claude 默认模型来自 models[0]');
  assert.match(claudeBody, /value="claude-alt"/, '候选里有模型列表其他项');
});

test('打开与异步比对都用完整会话 key:短 id 撞车不会串会话', async () => {
  // short 只有 8 位,两个会话撞同一个短 id 是可能的。按 short 比对会让 A 的响应画到 B 上。
  const data = fixture();
  data.sessions[0].short = 'dup00001';
  data.sessions[1].short = 'dup00001'; // 故意撞车
  data.sessions[0].routing = { keys: { a1: 'k2' }, slots: {} };
  data.sessions[1].routing = { keys: {}, slots: {} };
  const h = await harness(data);
  h.run("view = 'sessions'; renderSessions()");
  const body = h.get('sess-body').innerHTML;
  assert.match(decode(body), /openRouting\("sess-full-key-alpha0000000000000001"\)/, '第一行入口带自己的完整 key');
  assert.match(decode(body), /openRouting\("sess-full-key-beta00000000000000002"\)/, '第二行入口带自己的完整 key');
  // 短 id 撞车时按 short 找会翻到错的那个;这里按完整 key 打开
  await h.open('sess-full-key-beta00000000000000002');
  assert.equal(h.run('routingSession.key'), 'sess-full-key-beta00000000000000002');
  assert.match(routingRequests(h).at(-1).url, /sess-full-key-beta00000000000000002\/routing$/);
  assert.equal(h.run("routingDraft.keys.a1"), undefined, '不能把撞短 id 的另一个会话的配置读进来');
  // 短 id 兜底仍在(旧调用点/深链),但它只会拿到第一个匹配——
  // 这正是按钮必须传完整 key 的原因
  await h.run('closeRoutingModal()');
  await h.open('dup00001');
  assert.equal(h.run('routingSession.key'), 'sess-full-key-alpha0000000000000001', '短 id 只能取到第一个匹配,分不出是哪一个');
});

test('关掉 A 立刻打开 B:旧的读取结果既不覆盖 B,也不阻止 B 加载', async () => {
  const h = await harness();
  h.run("view = 'sessions'; renderSessions()");
  // 卡住 A 的 GET
  h.run("globalThis.__realFetch = fetch; globalThis.__pendingA = null; globalThis.fetch = (url, opt) => /alpha0000000000000001\\/routing$/.test(url) ? new Promise(res => { __pendingA = async () => res(await __realFetch(url, opt)); }) : __realFetch(url, opt)");
  const openingA = h.run("openRouting('sess-full-key-alpha0000000000000001')");
  await new Promise(r => setImmediate(r));
  assert.equal(await h.run('!!__pendingA'), true, 'A 的 GET 挂在路上');
  // 关掉 A(无草稿,不必确认),再打开 B
  await h.run('closeRoutingModal()');
  await h.open('beta002');
  assert.equal(h.run('routingSession.key'), 'sess-full-key-beta00000000000000002');
  assert.ok(h.run('routingRevision') !== null, 'B 必须真的加载成功:全局 routingTask 不能把 B 顶掉');
  assert.match(routingRequests(h).at(-1).url, /beta00000000000000002\/routing$/);
  // A 的响应现在才回来,不能覆盖 B
  h.run("globalThis.fetch = __realFetch");
  await h.run('__pendingA()');
  await openingA;
  assert.equal(h.run('routingSession.key'), 'sess-full-key-beta00000000000000002', 'A 的迟到响应不得换掉当前会话');
  assert.equal(h.run("routingDraft.keys.a1"), undefined, 'A 的迟到响应不得写进 B 的草稿');
});

test('冲突后再点保存仍是 409:文案不承诺"再保存就会覆盖"', async () => {
  const h = await harness();
  await h.open('alpha001');
  h.run("routingSetKey('a1','')");
  h.data.sessions[0].routing = { keys: {}, slots: {} };
  h.data.sessions[0].routing_revision = 'sr-other';
  await h.run('refresh()');
  await h.run('saveRouting()');
  const msg = h.get('routing-msg').textContent;
  assert.match(msg, /版本已变化/);
  assert.equal(/再保存会覆盖|保存会覆盖服务端那一版/.test(msg), false,
    '界面始终发读到的旧 revision,直接再点保存必定还是 409,不能承诺会覆盖');
  assert.match(msg, /放弃草稿并重载/, '要给出真正能走通的那条路');
  // 真的再点一次:仍然是失败,草稿还在
  const before = routingRequests(h).filter(r => r.method === 'PUT').length;
  await h.run('saveRouting()');
  assert.equal(routingRequests(h).filter(r => r.method === 'PUT').length, before + 1, '确实又发了一次');
  assert.equal(h.run('routingDirty'), true, '草稿仍在');
  assert.equal(h.data.sessions[0].routing_revision, 'sr-other', '服务端那份没有被强写');
});

test('服务端留着的无效引用在改别的条目时不被静默剔除', async () => {
  // 服务端的 routingOf 会原样保留空 key_id / 空 provider 的槽位(好让请求报错、让人看见)。
  // 界面若在提交时把它们清理掉,用户只是改个别的渠道就会顺手把无效条目抹掉——
  // 那是静默恢复继承,只有用户明确移除才能删。
  const data = fixture();
  data.sessions[0].routing = {
    keys: { a1: '' },                                   // 绑了但指定为空
    slots: { subagent: { provider: 'a1', key_id: '' }, opus: { provider: '' } }, // 空 key_id / 空渠道
  };
  const h = await harness(data);
  await h.open('alpha001');
  const body = h.get('routing-body').innerHTML;
  assert.match(body, /已指定为空 Key/, '空的 Key 绑定要看得见');
  assert.match(body, /已指定为空 Key · 保存会被拒/, '下拉里要保留这一项');
  assert.match(body, /无效条目/, '空渠道的槽位要标成无效');
  assert.match(body, /这条槽位没有选渠道，服务端会拒绝保存/, '并说明保存会被拒');
  assert.match(h.get('routing-refs-list').innerHTML, /槽位 opus 没有选渠道/, '空渠道要说"没有选渠道",不报一个空的渠道 id');
  assert.match(h.get('routing-refs-list').innerHTML, /Alpha 的 Key 绑定被指定为空/);
  assert.match(h.get('routing-msg').textContent, /无效引用/, '状态里也要点出来');

  // 只改一个无关的渠道 Key:两处无效条目必须原样还在
  h.run("routingSetKey('a2','k3')");
  await h.run('saveRouting()');
  const sent = routingRequests(h).find(r => r.method === 'PUT').body.routing;
  assert.equal(sent.keys.a1, '', '空 Key 绑定必须原样提交');
  assert.equal(sent.slots.subagent.key_id, '', '空 key_id 必须原样提交');
  assert.equal(sent.slots.opus.provider, '', '空渠道的槽位必须原样提交');
  assert.equal(sent.keys.a2, 'k3', '用户确实改的那一项生效');
  // 与服务端读取口径一致:同样不丢
  const cfg = require('../lib/routing/session-config.js');
  const roundTrip = cfg.routingOf({ routing: sent });
  assert.equal(roundTrip.keys.a1, '');
  assert.equal(roundTrip.slots.opus.provider, '');
  assert.deepEqual(roundTrip, JSON.parse(JSON.stringify(sent)), '界面与服务端对这份配置的理解一致');
});

test('草稿里改了又改回来、或只有无效条目时,不谎报"与上次读取一致"', async () => {
  const data = fixture();
  data.sessions[0].routing = { keys: { a1: '' }, slots: {} };
  const h = await harness(data);
  await h.open('alpha001');
  // 一打开就是"一致但有无效引用":状态要说清,不能只说"一致"
  assert.match(h.get('routing-msg').textContent, /无效引用/);
  assert.equal(h.run('routingDirty'), false, '没动过就不是未保存');
  // 改一下再改回来:仍然不是未保存
  h.run("routingSetKey('a2','k3')");
  assert.equal(h.run('routingDirty'), true);
  h.run("routingSetKey('a2','')");
  assert.equal(h.run('routingDirty'), false, '改回原样不该算未保存');
  assert.match(h.get('routing-msg').textContent, /无效引用/, '但无效引用还在,要接着说');
});

test('当前绑定只留一个入口,点开就是整组槽位配置', async () => {
  const data = fixture();
  data.slots.claude.forEach(slot => Object.assign(slot, { provider: 'a1', provider_name: 'Alpha', model: 'claude-alt' }));
  const h = await harness(data);
  h.run("view = 'sessions'; renderSessions()");
  const row = rowOf(h, 'alpha001');
  assert.match(row, /class="session-binding"/);
  // 列表里不再逐槽铺开:五槽摘要会把每行撑到十来行,编辑入口只要一个。
  assert.doesNotMatch(row, /session-slot-item|session-slot-summary/, '列表不铺逐槽摘要');
  assert.doesNotMatch(row, /<b>Alpha @ claude-alt/, '列表不回显槽位落点');
  assert.match(row, /普通请求渠道/);
  assert.equal((row.match(/openRouting\(/g) || []).length, 1, '当前绑定只留一个编辑入口');
  await h.open('alpha001');
  const body = h.get('routing-body').innerHTML;
  assert.ok(body.indexOf('会话模型槽位') < body.indexOf('渠道 Key 设置'));
  for (const name of ['main', 'opus', 'sonnet', 'haiku', 'subagent']) {
    assert.match(body, new RegExp(`data-routing-slot="${name}"`));
    assert.match(body, new RegExp(`mixr-${name}`));
  }
  assert.match(body, /继承全局：Alpha @ claude-alt/);
  assert.match(body, /自定义模型…/);
});

test('槽位实际请求对照该槽配置,不因主链与子代理渠道不同而标成绑定异常', async () => {
  const data = fixture();
  data.sessions[0].routing.slots.subagent = { provider: 'a3', model: 'claude-ghost' };
  data.sessions[0].actual = { ...data.sessions[0].actual, slot: 'subagent', provider: 'a3', provider_name: 'Ghost Host', model: 'claude-ghost' };
  const h = await harness(data);
  h.run("view = 'sessions'; renderSessions()");
  assert.equal(/与当前绑定不同/.test(rowOf(h, 'alpha001')), false);
  assert.match(h.get('sess-chips').innerHTML, /实际 ≠ 绑定<b>0<\/b>/);
  h.data.sessions[0].actual.provider = 'a1';
  await h.run('refresh()');
  h.run('renderSessions()');
  assert.match(rowOf(h, 'alpha001'), /与当前绑定不同/);
  assert.match(h.get('sess-chips').innerHTML, /实际 ≠ 绑定<b>1<\/b>/);
});

test('复制全局槽位只填未覆盖的渠道与模型,不改全局或已有配置,保存前不发写请求', async () => {
  const data = fixture();
  data.slots.claude.forEach(slot => Object.assign(slot, { provider: 'a1', model: 'claude-alt', pool: [{ provider: 'a3' }] }));
  const h = await harness(data);
  const globalBefore = JSON.stringify(data.slots), otherBefore = JSON.stringify(data.sessions[1]);
  await h.open('alpha001');
  h.run('routingCopyGlobalSlots()');
  assert.equal(h.run('routingDirty'), true);
  assert.equal(routingRequests(h).some(r => r.method === 'PUT'), false);
  assert.equal(h.run('routingDraft.slots.main.model'), 'claude-alt');
  assert.equal(h.run('routingDraft.slots.subagent.model'), 'claude-special', '已有覆盖不可被复制覆盖');
  assert.equal(h.run('routingDraft.slots.subagent.key_id'), 'k1');
  assert.equal(h.run('routingDraft.slots.main.pool'), undefined);
  assert.match(h.get('toast').textContent, /不含后备池/);
  await h.run('saveRouting()');
  const sent = routingRequests(h).find(r => r.method === 'PUT').body.routing;
  assert.equal(Object.keys(sent.slots).length, 5);
  assert.equal(JSON.stringify(data.slots), globalBefore);
  assert.equal(JSON.stringify(data.sessions[1]), otherBefore);
  assert.equal(data.providers.claude[0].active_key, 'k1');
});

test('会话自定义模型可输入并保存,Escape 只取消该模型编辑,不关闭会话面板', async () => {
  const h = await harness();
  await h.open('alpha001');
  h.run("routingPickSlotModel('subagent', SLOT_MODEL_CUSTOM)");
  assert.equal(h.run('routingDirty'), false, '切入输入框不算修改');
  assert.match(h.get('routing-body').innerHTML, /<input id="rt-slot-subagent-model"/);
  h.run("routingSetSlotModel('subagent','unlisted-model[1M]')");
  await h.run('saveRouting()');
  assert.equal(routingRequests(h).find(r => r.method === 'PUT').body.routing.slots.subagent.model, 'unlisted-model[1M]');
  h.run("routingPickSlotModel('subagent', SLOT_MODEL_CUSTOM)");
  h.run("routingSetSlotModel('subagent','discard-me')");
  h.run("routingModelKey({key:'Escape',preventDefault(){},stopPropagation(){}}, 'subagent')");
  assert.equal(h.run('routingDraft.slots.subagent.model'), 'unlisted-model[1M]');
  assert.equal(h.run('activeDialog.id'), 'routing-mask');
  assert.equal(h.run('routingModelEdit'), null);
});

test('会话自定义模型回车收尾并去空白,换渠道清模型和 Key,恢复继承不动其他槽', async () => {
  const h = await harness();
  await h.open('alpha001');
  h.run("routingPickSlotModel('subagent', SLOT_MODEL_CUSTOM)");
  h.run("routingSetSlotModel('subagent','  private-model  ')");
  h.run("routingModelKey({key:'Enter',target:{value:'  private-model  '},preventDefault(){}}, 'subagent')");
  assert.equal(h.run('routingDraft.slots.subagent.model'), 'private-model');
  assert.equal(h.run('routingModelEdit'), null);
  h.run("routingSetSlotProvider('main','a1')");
  h.run("routingSetSlotProvider('subagent','a3')");
  assert.equal(h.run('routingDraft.slots.subagent.model'), undefined);
  assert.equal(h.run('routingDraft.slots.subagent.key_id'), undefined);
  h.run("routingRemoveSlot('subagent')");
  assert.equal(h.run('routingDraft.slots.subagent'), undefined);
  assert.equal(h.run('routingDraft.slots.main.provider'), 'a1');
});
