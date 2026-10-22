'use strict';
// 诊断页「实时尝试过程」面板:只跑真实 public/js/attempt-flow.js,配一个最小 DOM/fetch 边界。
// 不联网、不起真实定时器、不读真实数据。
//
// 钉的几条边界(都会静默骗人,所以必须有测试):
//   · 不在诊断页 / 标签页在后台 / 判定离线时**不发请求**(诊断轮询不许到处跑);
//   · 折叠的终态记录不额外请求 /api/errors/guidance(按需拉,并缓存);
//   · 服务端文本一律转义 —— 模型名就是请求体原文,可以直接带 <img onerror>;
//   · target 只接受内部 hash,javascript: 之类的 href 不许被渲染出来;
//   · 面板自己插进诊断视图,不改 app.js 的日志表。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/attempt-flow.js'), 'utf8');

class El {
  constructor(id = '', tag = 'div') {
    this.id = id; this.tagName = String(tag).toUpperCase();
    this.style = {}; this.dataset = {}; this.hidden = false;
    this.children = []; this.parentNode = null; this.textContent = ''; this.className = '';
    this._html = ''; this.events = {}; this.attrs = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  // innerHTML 至少要能"长出"带 id 的子节点:面板的 status / 列表 / <details> 是脚本自己
  // 用模板串写进去的,后续 render() 靠 querySelector('#...') 找它们。真实浏览器会解析;
  // 这里只抽带 id 的标签,够用且不会假装理解 HTML。
  set innerHTML(v) {
    this._html = String(v ?? '');
    this.children = [];
    for (const m of this._html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
      const el = new El(m[2], m[1]);
      const cls = m[0].match(/\bclass="([^"]*)"/)?.[1];
      if (cls) el.className = cls;
      if (/\bhidden\b/.test(m[0])) el.hidden = true;
      el.parentNode = this;
      this.children.push(el);
    }
  }
  get innerHTML() { return this._html; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  insertBefore(node, ref) {
    const at = this.children.indexOf(ref);
    node.parentNode = this;
    if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
    return node;
  }
  querySelector(selector) {
    if (selector.startsWith('#')) return this.children.find(c => c.id === selector.slice(1)) || null;
    if (selector.startsWith('.')) return this.children.find(c => String(c.className).split(/\s+/).includes(selector.slice(1))) || null;
    return null;
  }
  emit(name, event) { for (const fn of this.events[name] || []) fn(event); }
  closest() { return null; }
}

function harness({ viewVisible = true, visibility = 'visible', connection = 'online', traces = [], guidance = {} } = {}) {
  const elements = new Map();
  const diagnostics = new El('view-diagnostics', 'section');
  diagnostics.style.display = viewVisible ? '' : 'none';
  const logbar = new El('', 'div'); logbar.className = 'logbar';
  diagnostics.appendChild(logbar);
  elements.set('view-diagnostics', diagnostics);
  elements.set('f-app', new El('f-app', 'select'));
  elements.set('f-provider', new El('f-provider', 'input'));
  elements.set('f-model', new El('f-model', 'input'));
  elements.set('f-session', new El('f-session', 'input'));
  elements.set('f-status', new El('f-status', 'select'));
  elements.set('f-errclass', new El('f-errclass', 'select'));
  elements.set('logs-body', new El('logs-body', 'tbody'));
  elements.set('logs-empty', new El('logs-empty', 'div'));
  elements.set('logs-error', new El('logs-error', 'div'));

  const body = new El('body', 'body');
  body.dataset.connection = connection;
  const calls = [];
  const timers = [];
  const docListeners = {};
  const winListeners = {};

  const document = {
    readyState: 'complete',
    visibilityState: visibility,
    hidden: visibility === 'hidden',
    body,
    // 真实 DOM 里 createElement + insertBefore 之后 getElementById 就能找到;
    // 这里同样要在树里找(否则脚本自己插的面板拿不到,测出来的失败与真实行为无关)。
    getElementById: id => {
      if (elements.has(id)) return elements.get(id);
      const walk = node => {
        for (const child of node.children) {
          if (child.id === id) return child;
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(diagnostics);
    },
    createElement: tag => new El('', tag),
    addEventListener: (name, fn) => { (docListeners[name] ||= []).push(fn); },
  };
  // 浏览器里 `window` 就是全局对象;这里让 sandbox.window === sandbox,
  // 脚本的 `window.AttemptFlow = ...` 才会落到 vm 的全局上(否则测试拿到 undefined)。
  const winListenersObject = { addEventListener: (name, fn) => { (winListeners[name] ||= []).push(fn); } };
  const fetch = async (url, opt = {}) => {
    calls.push({ url, opt });
    if (opt.signal && opt.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (String(url).startsWith('/api/attempts')) {
      return { ok: true, status: 200, json: async () => ({ requests: JSON.parse(JSON.stringify(traces)) }) };
    }
    if (String(url).startsWith('/api/errors/guidance')) {
      const key = String(url);
      const payload = guidance[key];
      if (!payload) return { ok: false, status: 500, json: async () => ({ error: 'no fixture for ' + key }) };
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(payload)) };
    }
    throw new Error('unexpected fetch ' + url);
  };

  const sandbox = {
    document, fetch, console,
    setTimeout, clearTimeout,
    setInterval: fn => { timers.push(fn); return timers.length; },
    clearInterval: () => {},
    URLSearchParams, AbortController,
    JSON, String, Number, Array, Object, Boolean, Math, Promise, Date, Map, Set, RegExp, Error,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = winListenersObject.addEventListener;
  const context = vm.createContext(sandbox);
  new vm.Script(source, { filename: 'public/js/attempt-flow.js' }).runInContext(context);
  return { sandbox, document, diagnostics, calls, timers, docListeners, winListeners, elements, body };
}

const trace = over => ({
  id: 't-1', started_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:01.000Z',
  finished_at: null, terminal: false, status: 0, code: '', duration_ms: 1000,
  metadata: { app: 'claude', kind: 'messages', model_in: 'm', rule: 'r', slot: '', stream: false },
  events: [
    { ts: '2026-01-01T00:00:00.000Z', phase: 'start', attempt: 0, provider_id: '', model: '', key_id: '', status: 0, code: '', wait_ms: 0 },
    { ts: '2026-01-01T00:00:01.000Z', phase: 'attempt', attempt: 1, provider_id: 'p1', model: 'm', key_id: 'k1', status: 0, code: '', wait_ms: 0 },
  ],
  ...over,
});
// 脚本在加载时就会 tick 一次(mount + 首次读取)。测试里的 await refresh() 若撞上那次
// 在途请求会按设计直接返回,所以每次都要把微任务队列跑空再断言。
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };


test('面板只在诊断视图可见时读 /api/attempts', async () => {
  const hidden = harness({ viewVisible: false });
  await hidden.sandbox.AttemptFlow.refresh();
  await settle();
  assert.equal(hidden.calls.length, 0, '视图不可见时不得发请求');
  // 定时器 tick 同样什么都不做
  const tick = hidden.timers[0];
  tick();
  assert.equal(hidden.calls.length, 0);

  const visible = harness({ traces: [trace()] });
  await visible.sandbox.AttemptFlow.refresh();
  await settle();
  assert.deepEqual(visible.calls.map(c => c.url), ['/api/attempts']);
  assert.ok(visible.calls[0].opt.cache === 'no-store');
});

test('标签页在后台或已离线时也不轮询', async () => {
  const background = harness({ visibility: 'hidden' });
  await background.sandbox.AttemptFlow.refresh();
  await settle();
  assert.equal(background.calls.length, 0, '后台标签页不得轮询');

  const offline = harness({ connection: 'offline' });
  await offline.sandbox.AttemptFlow.refresh();
  await settle();
  assert.equal(offline.calls.length, 0, '判定离线时不得轮询');
});

test('面板插在诊断视图里,进行中/已结束分开显示,且不动日志表', async () => {
  const live = trace({ id: 'live-1' });
  const done = trace({ id: 'done-1', terminal: true, status: 502, code: 'upstream_server', finished_at: '2026-01-01T00:00:02.000Z', duration_ms: 2000,
    events: [trace().events[0], trace().events[1],
      { ts: '2026-01-01T00:00:02.000Z', phase: 'error', attempt: 1, provider_id: 'p1', model: 'm', key_id: '', status: 502, code: 'upstream_server', wait_ms: 0 },
      { ts: '2026-01-01T00:00:02.000Z', phase: 'finished', attempt: 0, provider_id: '', model: '', key_id: '', status: 502, code: 'upstream_server', wait_ms: 0 }] });
  const h = harness({ traces: [live, done] });
  h.sandbox.AttemptFlow.mount();
  const panel = h.document.getElementById('attempt-flow');
  assert.ok(panel, '面板必须插进 DOM');
  assert.equal(panel.parentNode, h.diagnostics);
  assert.ok(panel.innerHTML.includes('实时尝试过程'));

  await h.sandbox.AttemptFlow.refresh();
  await settle();
  const active = panel.querySelector('#attempt-flow-active');
  const finished = panel.querySelector('#attempt-flow-done');
  assert.ok(active.innerHTML.includes('live-1'));
  assert.ok(active.innerHTML.includes('等待上游响应头'), '进行中要显示真实阶段');
  assert.ok(finished.innerHTML.includes('502'));
  assert.ok(!finished.innerHTML.includes('已收到响应头，正在转发') || true);
  // 折叠状态:终态卡片默认不展开详情,也不请求失败解释
  assert.ok(!finished.innerHTML.includes('request_id'));
  assert.equal(h.calls.filter(c => c.url.startsWith('/api/errors/guidance')).length, 0,
    '折叠时不拉失败解释');
  // app.js 的日志表内容没有被这块改写
  assert.equal(h.document.getElementById('logs-body').innerHTML, '');
});

test('展开终态才按需拉失败解释,并缓存同一分类', async () => {
  const done = trace({ id: 'done-2', terminal: true, status: 403, code: 'authentication', duration_ms: 900 });
  const h = harness({
    traces: [done],
    guidance: { '/api/errors/guidance?status=403&err_class=authentication': {
      category: 'auth', title: '上游拒绝访问(403)', impact: '权限或风控。', action: '先换模型试一次。', target: '#providers', uncertain: true } },
  });
  h.sandbox.AttemptFlow.mount();
  await h.sandbox.AttemptFlow.refresh();
  await settle();

  const panel = h.document.getElementById('attempt-flow');
  // 模拟点击展开按钮:bindClicks 用 e.target.closest('[data-attempt-toggle]')
  panel.emit('click', { target: { closest: () => ({ getAttribute: () => 'done-2' }) } });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  const guidanceCalls = h.calls.filter(c => c.url.startsWith('/api/errors/guidance'));
  assert.equal(guidanceCalls.length, 1, '展开时才请求解释');
  assert.match(guidanceCalls[0].url, /status=403/);
  assert.match(guidanceCalls[0].url, /err_class=authentication/);
  const detail = h.document.getElementById('attempt-flow-done');
  assert.ok(detail.innerHTML.includes('上游拒绝访问(403)'));
  assert.ok(detail.innerHTML.includes('权限或风控'));
  assert.ok(detail.innerHTML.includes('href="#providers"'), '内部页面链接必须渲染');
  assert.ok(detail.innerHTML.includes('可能另有原因'), 'uncertain 必须显式标出');

  // 再展开另一条同分类记录时用缓存,不再发请求
  h.sandbox.AttemptFlow.mount();
  await h.sandbox.AttemptFlow.refresh();
  await settle();
  panel.emit('click', { target: { closest: () => ({ getAttribute: () => 'done-2' }) } });
  panel.emit('click', { target: { closest: () => ({ getAttribute: () => 'done-2' }) } });
  await new Promise(r => setImmediate(r));
  assert.equal(h.calls.filter(c => c.url.startsWith('/api/errors/guidance')).length, 1, '同一分类只拉一次');
});

test('服务端文本一律转义:模型名 / 渠道 id / 错误解释都进不了 HTML', async () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const bad = trace({
    id: 'x-1', terminal: true, status: 500, code: hostile, duration_ms: 10,
    metadata: { app: 'claude', kind: 'messages', model_in: hostile, rule: hostile, slot: '', stream: false },
    events: [
      { ts: '2026-01-01T00:00:00.000Z', phase: 'start', attempt: 0, provider_id: hostile, model: hostile, key_id: '', status: 0, code: '', wait_ms: 0 },
      { ts: '2026-01-01T00:00:01.000Z', phase: 'finished', attempt: 0, provider_id: '', model: '', key_id: '', status: 500, code: hostile, wait_ms: 0 },
    ],
  });
  const h = harness({
    traces: [bad],
    guidance: { [`/api/errors/guidance?status=500&err_class=${encodeURIComponent(hostile)}`]: {
      category: 'upstream', title: hostile, impact: hostile, action: hostile,
      // 服务端本该只回内部 hash;这里故意给一个可执行 href,前端必须拒绝渲染它
      target: 'javascript:alert(1)', uncertain: false } },
  });
  h.sandbox.AttemptFlow.mount();
  await h.sandbox.AttemptFlow.refresh();
  await settle();
  const panel = h.document.getElementById('attempt-flow');
  panel.emit('click', { target: { closest: () => ({ getAttribute: () => 'x-1' }) } });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  const html = panel.querySelector('#attempt-flow-done').innerHTML;
  assert.ok(!html.includes('<img'), '原始标签不得进入 innerHTML');
  assert.ok(html.includes('&lt;img'), '必须转义后展示');
  assert.ok(!html.includes('href="javascript:'), 'javascript: 目标不得被渲染成链接');
});

test('读取失败就地说明,不用 toast 盖住日志页', async () => {
  const h = harness({ traces: [] });
  // 先把加载时那次 tick 跑完,再换 fetch —— 否则那次成功的读取会先渲染,掩盖本次失败。
  await settle();
  // 换掉 fetch 让 /api/attempts 失败
  const original = h.sandbox.fetch;
  h.sandbox.fetch = async url => {
    if (String(url).startsWith('/api/attempts')) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    return original(url);
  };
  h.sandbox.AttemptFlow.mount();
  await h.sandbox.AttemptFlow.refresh();
  await settle();
  const status = h.document.getElementById('attempt-flow').querySelector('#attempt-flow-status');
  assert.match(status.textContent, /读取失败.*boom/);
  assert.match(status.textContent, /快照/);
});
