'use strict';
// 多 Key 自动备用面板:用最小 DOM/fetch 边界跑真实 public/js/key-fallback.js。
// 只验证会骗人的几处:
//   - 默认关闭、选渠道后开关状态与文案正确;
//   - 新建渠道后下拉框必须跟上(app.js 每 5 秒重绘网格,面板不能停在首帧快照);
//   - 离线时开关禁用且点击不发 PUT;
//   - Key 状态有 3 秒有界轮询,冷却/恢复能自己刷出来,不用等用户点击;
//   - 健康视图只出现 ID/枚举/时间,绝不出现 Key 正文或掩码。
// 不碰真实网络与真实配置。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/key-fallback.js'), 'utf8');

class El {
  constructor(tag = 'div', id = '') {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.isConnected = true;
    this.parentNode = null;
    this.children = [];
    this.events = {};
    this.className = '';
    this._text = '';
    const classes = new Set();
    this.classList = {
      add: (...xs) => xs.forEach(x => classes.add(x)),
      remove: (...xs) => xs.forEach(x => classes.delete(x)),
      contains: x => classes.has(x),
      toggle: (x, force) => { const on = force === undefined ? !classes.has(x) : !!force; if (on) classes.add(x); else classes.delete(x); return on; },
    };
    this.owned = new Map();
  }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  get textContent() {
    if (!this.children.length) return this._text;
    return this.children.map(c => c.textContent).filter(Boolean).join(' ');
  }
  set innerHTML(html) {
    this.children = [];
    this.owned.clear();
    for (const m of String(html).matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
      const el = new El(m[1], m[2]);
      const cls = m[0].match(/\bclass="([^"]*)"/)?.[1] || '';
      el.setAttribute('class', cls);
      if (/\bdisabled\b/.test(m[0])) el.disabled = true;
      el.parentNode = this;
      this.children.push(el);
      this.owned.set(m[2], el);
      registry.set(m[2], el);
    }
    this._html = String(html);
  }
  get innerHTML() { return this._html || ''; }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
  }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  fire(name) { for (const fn of this.events[name] || []) fn({ preventDefault() {} }); }
  appendChild(node) {
    node.parentNode = this;
    node.isConnected = true;
    this.children.push(node);
    if (node.id) registry.set(node.id, node);
    return node;
  }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  replaceChildren() { this.children = []; }
  insertAdjacentElement(position, node) {
    assert.equal(position, 'afterend');
    assert.ok(this.parentNode, 'insertAdjacentElement 需要父节点');
    const parent = this.parentNode;
    const at = parent.children.indexOf(this);
    parent.children.splice(at + 1, 0, node);
    node.parentNode = parent;
    node.isConnected = true;
    if (node.id) registry.set(node.id, node);
    return node;
  }
  querySelector(selector) {
    if (selector.startsWith('#')) return this.owned.get(selector.slice(1)) || null;
    return null;
  }
  get options() { return this.children.filter(c => c.tagName === 'OPTION'); }
}

const registry = new Map();
const tick = () => new Promise(resolve => setImmediate(resolve));
// 面板的同步挂在 setTimeout(0) / 250ms 上:setImmediate 会先于 timers 跑完,必须等定时器真正轮转。
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function harness(initial) {
  registry.clear();
  const listeners = { window: {}, document: {} };
  const observers = [];
  const intervals = [];

  const view = new El('section', 'view-providers');
  const host = new El('div', 'agent-panel');
  const grid = new El('div', 'prov-grid');
  const empty = new El('div', 'prov-empty');
  host.appendChild(grid);
  host.appendChild(empty);
  view.appendChild(host);
  registry.set('view-providers', view);
  registry.set('prov-grid', grid);
  registry.set('prov-empty', empty);

  const document = {
    readyState: 'complete', hidden: false, visibilityState: 'visible',
    body: new El('body'),
    getElementById: id => registry.get(id) || null,
    createElement: tag => new El(tag),
    addEventListener: (name, fn) => { (listeners.document[name] ||= []).push(fn); },
  };
  const window = { addEventListener: (name, fn) => { (listeners.window[name] ||= []).push(fn); } };

  const calls = [];
  const toasts = [];
  let healthPayload = { keys: [] };
  const api = (path, opt = {}) => {
    calls.push({ path, opt });
    if (path === '/api/keys/health') return Promise.resolve(structuredClone(healthPayload));
    if (path.startsWith('/api/providers/')) return Promise.resolve({ ok: true });
    return Promise.reject(new Error('unexpected ' + path));
  };

  const context = vm.createContext({
    window, document, state: initial, api,
    online: true,
    providerGroup: () => 'claude',
    toast: (msg, cls) => toasts.push({ msg, cls }),
    MutationObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {}
    },
    setInterval: (fn, ms) => { const id = { fn, ms, cleared: false }; intervals.push(id); return id; },
    clearInterval: id => { if (id) id.cleared = true; },
    setTimeout, clearTimeout, console, Promise, Date, JSON, Object, Array, String, Number, Map, Set,
  });
  vm.runInContext(source, context, { filename: 'public/js/key-fallback.js' });

  return {
    context, document, grid, calls, toasts, intervals, observers,
    setHealth: rows => { healthPayload = { keys: rows }; },
    fireGridMutation: () => { for (const o of observers) o.cb([]); },
    interval: () => intervals[0],
    get: id => registry.get(id),
  };
}

const baseState = () => ({
  providers: {
    claude: [
      { id: 'p1', name: 'Alpha', key_fallback: true, keys: [{ id: 'k1', label: 'A', key_masked: 'sk-***-1' }, { id: 'k2', label: 'B', key_masked: 'sk-***-2' }] },
      { id: 'p2', name: 'Beta', keys: [{ id: 'k9', label: 'Only', key_masked: 'sk-***-9' }] },
    ],
    codex: [],
  },
});

test('面板:选渠道开关、PUT 形状与脱敏健康视图', async () => {
  const h = harness(baseState());
  h.setHealth([{ provider: 'p1', key_id: 'k1', state: 'cooling', scope: 'account', model: '',
    status: 401, until: Date.now() + 60000, updated_at: Date.now(), failures: 2 }]);
  await wait(300);

  assert.ok(h.get('kf-health'), '面板应插入到渠道网格之后');
  const select = h.get('kf-provider');
  const toggle = h.get('kf-toggle');
  const detail = h.get('kf-detail');
  assert.equal(select.options.length, 2, '只列当前协议组的渠道');
  assert.match(select.options[0].textContent, /Alpha/);
  assert.match(select.options[0].textContent, /已开启/);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.match(detail.textContent, /2 把 Key/);

  select.value = 'p2';
  select.fire('change');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.match(detail.textContent, /1 把 Key/);
  assert.match(detail.textContent, /固定 Key/);

  toggle.fire('click');
  await tick(); await tick();
  const put = h.calls.find(c => c.path === '/api/providers/p2' && c.opt.method === 'PUT');
  assert.ok(put, '开关必须走渠道 PUT');
  assert.deepEqual(JSON.parse(put.opt.body), { key_fallback: true });
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.ok(h.toasts.some(t => /已开启/.test(t.msg)));

  await h.context.window.KeyFallbackUI.refreshHealth();
  await tick();
  const rows = h.get('kf-rows');
  assert.equal(rows.children.length, 1);
  const text = rows.textContent;
  assert.match(text, /Alpha/);
  assert.match(text, /k1/);
  assert.match(text, /冷却中/);
  assert.match(text, /账号级/);
  assert.match(text, /HTTP 401/);
  assert.ok(!text.includes('sk-***'), '健康视图不得出现 Key 掩码/正文');
  h.context.window.KeyFallbackUI.stop();
});

test('新建渠道后下拉框必须跟上(app.js 重绘网格 → 面板重新读 state)', async () => {
  const state = baseState();
  const h = harness(state);
  await wait(5);
  const select = h.get('kf-provider');
  assert.equal(select.options.length, 2);

  // app.js 的 5 秒刷新把新渠道写进 state 并重绘 #prov-grid;
  // 面板通过 MutationObserver 得到通知,必须重新 ingest 才能看到它。
  state.providers.claude.push({ id: 'p3', name: 'Gamma', key_fallback: false, keys: [{ id: 'g1', label: 'G', key_masked: 'sk-***-g' }] });
  h.fireGridMutation();
  await wait(5);
  assert.equal(select.options.length, 3, '新建渠道必须出现在下拉框里');
  assert.match(select.options[2].textContent, /Gamma/);

  // 删除渠道:选项随之消失,且不会把选中项指向一个已删除的 id
  state.providers.claude.splice(0, 1);
  h.fireGridMutation();
  await wait(5);
  assert.equal(select.options.length, 2);
  assert.ok(select.options.every(o => o.value !== 'p1'));
  assert.notEqual(select.value, 'p1');
  h.context.window.KeyFallbackUI.stop();
});

test('离线时开关禁用且点击不发 PUT', async () => {
  const h = harness(baseState());
  await wait(5);
  const toggle = h.get('kf-toggle');
  const select = h.get('kf-provider');
  select.value = 'p2';
  select.fire('change');
  assert.equal(toggle.disabled, false);

  h.context.online = false;
  h.fireGridMutation();
  await wait(5);
  assert.equal(toggle.disabled, true, '离线时开关必须禁用');
  assert.match(h.get('kf-detail').textContent, /离线/);

  // 即使状态滞后(disabled 还没刷新)也不能真的把请求发出去
  toggle.disabled = false;
  toggle.fire('click');
  await tick();
  assert.equal(h.calls.filter(c => c.opt.method === 'PUT').length, 0, '离线不得发出 PUT');
  assert.ok(h.toasts.some(t => /离线/.test(t.msg)));

  h.context.online = true;
  h.fireGridMutation();
  await wait(5);
  assert.equal(toggle.disabled, false, '恢复在线后开关重新可用');
  h.context.window.KeyFallbackUI.stop();
});

test('Key 状态有 3 秒有界轮询:故障与恢复都能自己刷出来', async () => {
  const h = harness(baseState());
  await wait(300);   // 首次读取挂在 250ms 的延时上
  const timer = h.interval();
  assert.ok(timer, '必须有一个轮询定时器');
  assert.equal(timer.ms, 3000, '轮询间隔固定 3 秒');

  // 首次读取:面板挂载时读一次,没有记录
  assert.ok(h.calls.some(c => c.path === '/api/keys/health'));

  // 后台出现一条冷却记录,用户不做任何操作
  h.setHealth([{ provider: 'p1', key_id: 'k1', state: 'cooling', scope: 'account', model: '',
    status: 402, until: Date.now() + 60000, updated_at: Date.now(), failures: 1 }]);
  const before = h.calls.length;
  timer.fn();
  await wait(5);
  assert.ok(h.calls.length > before, '轮询必须真的发请求');
  assert.equal(h.get('kf-rows').children.length, 1);
  assert.match(h.get('kf-rows').textContent, /冷却中/);

  // 冷却到点恢复:下一次轮询把那一行改成正常
  h.setHealth([{ provider: 'p1', key_id: 'k1', state: 'healthy', scope: 'account', model: '',
    status: 402, until: Date.now() - 1, updated_at: Date.now(), failures: 1 }]);
  timer.fn();
  await wait(5);
  assert.match(h.get('kf-rows').textContent, /正常/);

  // 页面隐藏时轮询不发请求(有界:不在后台持续打接口)
  h.document.hidden = true;
  const hiddenBefore = h.calls.length;
  timer.fn();
  await wait(5);
  assert.equal(h.calls.length, hiddenBefore, '隐藏页不得轮询');
  h.document.hidden = false;

  h.context.window.KeyFallbackUI.stop();
  assert.equal(timer.cleared, true, 'stop() 必须清掉轮询定时器');
});
