'use strict';
// 外壳模块(public/js/workspace.js)的独立回归。
//
// 不启浏览器、不联网、不读真实客户端配置:用一个刻意做小的 DOM/fetch 边界跑真实源码,
// 钉住四件容易静默坏掉的事——
//   · 偏好恢复与初始优先级(URL > 保存的视图 > 概览)
//   · 存储被拒(隐私模式)时整页照常工作
//   · hash 深链与前进/后退,且自身写 hash 不会递归
//   · 主题选择与快速跳转的纯行为(含 activeDialog 保护)
// 这里不重复测 app.js 的渲染:那是 ui.test.js / session-routing-ui.test.js 的范围。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../public/js/workspace.js'), 'utf8');

class ClassList {
  constructor() { this.items = new Set(); }
  add(...names) { for (const name of names) this.items.add(name); }
  remove(...names) { for (const name of names) this.items.delete(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.items.has(name) : !!force;
    if (on) this.items.add(name); else this.items.delete(name);
    return on;
  }
  contains(name) { return this.items.has(name); }
}

class Element {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.id = '';
    this.className = '';
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.classList = new ClassList();
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.hidden = false;
    this.value = '';
    this.textContent = '';
    this.open = false;
    this.isConnected = true;
    this.inert = false;
    this.ownerDocument = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'class') this.className = '';
  }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }
  get firstChild() { return this.children[0] || null; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  removeEventListener(type, callback) {
    const list = this.listeners.get(type) || [];
    const index = list.indexOf(callback);
    if (index >= 0) list.splice(index, 1);
  }
  emit(type, event = {}) {
    const payload = {
      type,
      target: this,
      defaultPrevented: false,
      propagStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagStopped = true; },
      ...event,
    };
    for (const callback of this.listeners.get(type) || []) callback(payload);
    return payload;
  }
  click() { return this.emit('click'); }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }
  querySelectorAll() { return []; }
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function storageFrom(seed = {}) {
  const map = new Map(Object.entries(seed).map(([key, value]) => [key, String(value)]));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    dump: () => Object.fromEntries(map),
  };
}

function setup(options = {}) {
  const elements = new Map();
  const navLinks = ['overview', 'providers', 'routes', 'sessions', 'usage', 'diagnostics', 'settings']
    .map(view => { const link = new Element('a'); link.dataset.view = view; return link; });

  const doc = {
    readyState: 'loading',
    documentElement: new Element('html'),
    body: new Element('body'),
    activeElement: null,
    title: 'Mixrouter 控制台',
    listeners: new Map(),
    getElementById: id => elements.get(id) || null,
    querySelector: selector => (selector === '.skip-link' ? elements.get('skip-link') || null : null),
    createElement: tag => {
      const element = new Element(tag);
      element.ownerDocument = doc;
      return element;
    },
    querySelectorAll: selector => (selector === 'nav a' ? navLinks : []),
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(callback);
    },
    emit(type, event = {}) {
      const payload = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
      for (const callback of this.listeners.get(type) || []) callback(payload);
      return payload;
    },
  };
  doc.documentElement.ownerDocument = doc;
  doc.body.ownerDocument = doc;
  for (const link of navLinks) link.ownerDocument = doc;
  doc.activeElement = doc.body;

  const add = (id, tag = 'div', props = {}) => {
    const element = new Element(tag);
    element.id = id;
    element.ownerDocument = doc;
    Object.assign(element, props);
    elements.set(id, element);
    return element;
  };

  add('main', 'main');
  add('skip-link', 'a');
  add('sidebar', 'aside');
  add('sidebar-toggle', 'button');
  add('sidebar-backdrop', 'div', { hidden: true });
  add('quick-nav-open', 'button');
  add('quick-nav-kbd', 'kbd');
  add('quick-nav-mask', 'dialog', { hidden: true });
  add('quick-nav-input', 'input');
  add('quick-nav-list', 'div');
  add('quick-nav-empty', 'p', { hidden: true });
  add('theme-select', 'select', { value: 'system' });

  const storage = options.denyStorage ? null : storageFrom(options.storage);

  // 历史模型照浏览器来:
  //   · `location.hash = x` 压一条新记录并触发 hashchange;
  //   · history.replaceState 改写当前记录,**不**触发事件,也不增加条数;
  //   · goBack 只移动游标,再发 popstate/hashchange。
  // 这三条是"非法 hash 不该污染历史""后退回到裸 #providers"这些断言的唯一可信来源。
  const entries = [options.hash || ''];
  let cursor = 0;
  const replaceCalls = [];
  const pushCalls = [];
  let rawHash = entries[0];
  let hashListener = () => {};
  const location = {
    get hash() { return rawHash; },
    set hash(value) {
      const next = String(value).startsWith('#') ? String(value) : '#' + value;
      if (next === rawHash) return;
      rawHash = next;
      entries.splice(cursor + 1);
      entries.push(next);
      cursor = entries.length - 1;
      pushCalls.push(next);
      hashListener();
    },
    pathname: '/',
    search: '',
  };
  const windowListeners = new Map();
  const history = {
    replaceState(state, title, url) {
      const next = String(url).startsWith('#') ? String(url) : '#' + url;
      replaceCalls.push(next);
      rawHash = next;
      entries[cursor] = next;
    },
  };
  const goBack = () => {
    if (cursor === 0) return false;
    cursor -= 1;
    rawHash = entries[cursor];
    window.emit('popstate', {});
    hashListener();
    return true;
  };

  const showCalls = [];
  const appCalls = [];
  const window = {
    location,
    history,
    // 窄屏判定:外壳用它决定抽屉收着时是否把侧栏 inert 掉。
    matchMedia: query => ({ matches: options.mobile === true && /max-width/.test(query), media: query, addEventListener() {} }),
    addEventListener(type, callback) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(callback);
    },
    emit(type, event = {}) {
      for (const callback of windowListeners.get(type) || []) callback(event);
    },
    showView(name) {
      showCalls.push(name);
      if (typeof window.workspaceViewChanged === 'function') window.workspaceViewChanged(name);
    },
    setApp(app) {
      appCalls.push(app);
      if (typeof window.workspaceAppChanged === 'function') window.workspaceAppChanged(app);
    },
  };
  if (options.denyStorage) {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage denied'); } });
  } else {
    window.localStorage = storage;
  }

  // 让 location.hash 赋值真的触发 hashchange(浏览器行为),用来验证自身写 hash 不会递归。
  hashListener = () => window.emit('hashchange');

  const context = vm.createContext({
    document: doc,
    window,
    activeDialog: null,
    navigator: { platform: options.platform || 'MacIntel', userAgent: 'node-test' },
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(SOURCE, context, { filename: 'public/js/workspace.js' });

  const boot = () => {
    doc.readyState = 'interactive';
    doc.emit('DOMContentLoaded');
    return harness;
  };
  const harness = {
    doc, window, context, elements, navLinks, showCalls, appCalls, storage,
    get: id => elements.get(id),
    boot,
    hash: () => location.hash,
    setHash(value) { location.hash = value; },
    goBack,
    pushes: () => pushCalls.slice(),
    replaces: () => replaceCalls.slice(),
    resetHistory() { pushCalls.length = 0; replaceCalls.length = 0; showCalls.length = 0; appCalls.length = 0; },
    entries: () => entries.slice(),
    keydown(target, event) { return target.emit('keydown', event); },
    documentKeydown(event) { return doc.emit('keydown', event); },
    focusin(target) { return doc.emit('focusin', { target }); },
    // 需要读 app.js 侧状态(curApp / view)时用,外壳自己的状态在闭包里,只通过回调观察。
    run(code) { return vm.runInContext(code, context); },
  };
  return harness;
}

test('初始优先级:URL hash 胜过保存的视图,保存值胜过概览;主题先于样式落盘', () => {
  const fromHash = setup({ hash: '#providers?app=zcode', storage: { 'mixr.ui.view': 'routes', 'mixr.ui.app': 'codex' } });
  // 主题在脚本解析时就该落到 <html>,不等 DOMContentLoaded(否则首帧会闪深色)。
  fromHash.get('theme-select').value = 'system';
  fromHash.boot();
  assert.deepEqual(fromHash.appCalls, ['zcode'], 'URL 里的 app 覆盖保存值');
  assert.deepEqual(fromHash.showCalls, ['providers'], 'URL 里的视图覆盖保存值');
  assert.equal(fromHash.hash(), '#providers?app=zcode', '规范化后不应改写有效深链');
  assert.equal(fromHash.doc.title, '渠道与 Key · Mixrouter');

  const fromStore = setup({ storage: { 'mixr.ui.view': 'routes', 'mixr.ui.app': 'codex', 'mixr.ui.theme': 'light' } });
  assert.equal(fromStore.doc.documentElement.getAttribute('data-theme'), 'light', '样式表加载前就要带上主题');
  fromStore.boot();
  assert.deepEqual(fromStore.showCalls, ['routes']);
  assert.deepEqual(fromStore.appCalls, ['codex']);
  assert.equal(fromStore.hash(), '#routes');
  assert.equal(fromStore.doc.title, '路由 · Mixrouter');
  assert.equal(fromStore.get('theme-select').value, 'light');

  const fallback = setup();
  fallback.boot();
  assert.deepEqual(fallback.showCalls, ['overview']);
  assert.deepEqual(fallback.appCalls, ['claude']);
  assert.equal(fallback.hash(), '#overview', '初始化用 replaceState 归一,不额外压一条历史');
  assert.equal(fallback.doc.documentElement.hasAttribute('data-theme'), false, 'system 不写 data-theme');
  assert.equal(fallback.doc.documentElement.style.colorScheme, 'light dark');
});

test('存储被拒(隐私模式)时默认值照常生效,不抛错也不假持久化', () => {
  const h = setup({ denyStorage: true });
  assert.doesNotThrow(() => h.boot());
  assert.deepEqual(h.showCalls, ['overview']);
  assert.deepEqual(h.appCalls, ['claude']);
  assert.equal(h.hash(), '#overview');
  const select = h.get('theme-select');
  select.value = 'dark';
  select.emit('change');
  assert.equal(h.doc.documentElement.getAttribute('data-theme'), 'dark', '本次切换仍要生效');
  assert.doesNotThrow(() => h.window.workspaceViewChanged('settings'));
  assert.equal(h.hash(), '#settings');
});

test('hashchange 前进/后退:切换视图与客户端,非法视图回概览,自身写 hash 不递归', () => {
  const h = setup();
  h.boot();
  h.showCalls.length = 0;
  h.appCalls.length = 0;

  h.setHash('#providers?app=codex');
  assert.equal(h.showCalls.join(','), 'providers', 'setApp 之后才切视图,且各只触发一次');
  assert.equal(h.appCalls.join(','), 'codex');

  h.setHash('#sessions');
  assert.equal(h.showCalls.join(','), 'providers,sessions');
  assert.equal(h.hash(), '#sessions');

  // 同一个 hash 再触发一次:状态已一致,不应重复 showView(这就是递归的入口)。
  h.window.emit('hashchange');
  assert.equal(h.showCalls.join(','), 'providers,sessions');

  h.setHash('#not-a-view');
  assert.equal(h.showCalls.at(-1), 'overview', '非法视图回概览');
  assert.equal(h.hash(), '#overview', 'URL 被改写,而不是停在旧 hash 上');

  // 后退到渠道页:客户端随后备 hash 里的 app 恢复
  h.setHash('#providers?app=zcode');
  assert.equal(h.showCalls.at(-1), 'providers');
  assert.equal(h.appCalls.at(-1), 'zcode');
});

test('主题:浅色/深色写 data-theme 并持久化,跟随系统移除属性', () => {
  const h = setup();
  h.boot();
  const select = h.get('theme-select');

  select.value = 'dark';
  select.emit('change');
  assert.equal(h.doc.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(h.storage.dump()['mixr.ui.theme'], 'dark');

  select.value = 'light';
  select.emit('change');
  assert.equal(h.doc.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(h.storage.dump()['mixr.ui.theme'], 'light');

  select.value = 'system';
  select.emit('change');
  assert.equal(h.doc.documentElement.hasAttribute('data-theme'), false);
  assert.equal(h.storage.dump()['mixr.ui.theme'], 'system');
  assert.equal(h.doc.documentElement.style.colorScheme, 'light dark');
});

test('快速跳转:按钮打开、过滤、方向键+回车跳转,关闭后焦点回正文', () => {
  const h = setup();
  h.boot();
  h.showCalls.length = 0;
  h.appCalls.length = 0;

  h.get('quick-nav-open').click();
  const dialog = h.get('quick-nav-mask');
  const input = h.get('quick-nav-input');
  assert.equal(dialog.open, true, '用原生 showModal');
  assert.equal(dialog.hidden, false, '关闭态的 hidden 兜底要放开');
  assert.equal(h.doc.activeElement, input, '打开后焦点在搜索框');
  assert.equal(h.get('quick-nav-list').children.length, 10, '七个页面 + 三个客户端入口');

  input.value = 'codex';
  input.emit('input');
  assert.equal(h.get('quick-nav-list').children.length, 1, '只留 Codex 渠道');
  assert.equal(h.get('quick-nav-empty').hidden, true);

  input.value = '不存在的页面';
  input.emit('input');
  assert.equal(h.get('quick-nav-list').children.length, 0);
  assert.equal(h.get('quick-nav-empty').hidden, false);

  input.value = '渠道';
  input.emit('input');
  const count = h.get('quick-nav-list').children.length;
  assert.ok(count >= 1);
  input.emit('keydown', { key: 'ArrowDown' });
  input.emit('keydown', { key: 'Enter' });
  assert.equal(dialog.open, false, '选择后关闭');
  assert.equal(dialog.hidden, true, '关闭后补 hidden,样式表不能把它顶回来');
  assert.ok(h.showCalls.length >= 1);
  assert.equal(h.doc.activeElement, h.get('main'), '跳转后焦点落到主内容区');
});

test('快速跳转的 Esc 关闭并把焦点还给打开前的元素', () => {
  const h = setup();
  h.boot();
  const opener = h.get('quick-nav-open');
  opener.focus();
  opener.click();
  const input = h.get('quick-nav-input');
  assert.equal(h.doc.activeElement, input);
  input.emit('keydown', { key: 'Escape' });
  assert.equal(h.get('quick-nav-mask').open, false);
  assert.equal(h.get('quick-nav-mask').hidden, true);
  assert.equal(h.doc.activeElement, opener);
});

test('⌘/Ctrl+K:正常打开并拦截浏览器默认;其他弹窗开着时完全不介入', () => {
  const h = setup();
  h.boot();
  const dialog = h.get('quick-nav-mask');

  h.context.activeDialog = { id: 'mask' };
  const blocked = h.documentKeydown({ key: 'k', metaKey: true });
  assert.equal(dialog.open, false, 'activeDialog 期间不许叠一层');
  assert.equal(blocked.defaultPrevented, false, '没打开就不该拦浏览器默认行为');

  h.context.activeDialog = null;
  const opened = h.documentKeydown({ key: 'k', ctrlKey: true });
  assert.equal(dialog.open, true);
  assert.equal(opened.defaultPrevented, true, '只有真的打开时才 preventDefault');
});

test('输入框里的 Ctrl+K 留给系统编辑键,⌘K 仍然打开跳转', () => {
  const h = setup();
  h.boot();
  const dialog = h.get('quick-nav-mask');
  const input = h.get('theme-select');

  const kept = h.documentKeydown({ key: 'k', ctrlKey: true, target: input });
  assert.equal(dialog.open, false, '输入控件里的 Ctrl+K 是删到行尾,不能抢');
  assert.equal(kept.defaultPrevented, false);

  const opened = h.documentKeydown({ key: 'k', metaKey: true, target: input });
  assert.equal(dialog.open, true, '⌘K 在任何位置都可用');
  assert.equal(opened.defaultPrevented, true);
});

test('移动端抽屉:开关、Escape 与弹窗保护', () => {
  const h = setup();
  h.boot();
  const toggle = h.get('sidebar-toggle');
  const backdrop = h.get('sidebar-backdrop');

  toggle.click();
  assert.equal(h.doc.body.classList.contains('nav-open'), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(backdrop.hidden, false);
  assert.equal(h.get('sidebar').inert, false, '打开的抽屉必须能被键盘访问');
  assert.equal(h.doc.activeElement, h.navLinks[0], '打开后焦点进第一个导航项');

  h.documentKeydown({ key: 'Escape' });
  assert.equal(h.doc.body.classList.contains('nav-open'), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(backdrop.hidden, true);
  assert.equal(h.doc.activeElement, toggle, 'Escape 关闭后焦点回开关');

  // 有弹窗时,按钮点了也不能开(见 app.js showDialog 的 inert 之外再加一道保险)
  h.context.activeDialog = { id: 'mask' };
  toggle.click();
  assert.equal(h.doc.body.classList.contains('nav-open'), false);
  h.get('quick-nav-open').click();
  assert.equal(h.get('quick-nav-mask').open, false);
});

test('窄屏下收起的侧栏从 Tab 序列里摘出去,桌面端不受影响', () => {
  const mobile = setup({ mobile: true });
  mobile.boot();
  assert.equal(mobile.get('sidebar').inert, true, '收起的抽屉只是移出视口,必须 inert');

  mobile.get('sidebar-toggle').click();
  assert.equal(mobile.get('sidebar').inert, false, '打开后恢复可访问');

  mobile.documentKeydown({ key: 'Escape' });
  assert.equal(mobile.get('sidebar').inert, true, '再次收起');

  // app.js hideDialog 会无条件把 inert 置回 false;下一条状态同步要把它补回来
  mobile.context.activeDialog = { id: 'mask' };
  mobile.get('sidebar').inert = true;
  mobile.context.activeDialog = null;
  mobile.get('sidebar').inert = false;
  mobile.window.workspaceViewChanged('routes');
  assert.equal(mobile.get('sidebar').inert, true);

  const desktop = setup();
  desktop.boot();
  assert.equal(desktop.get('sidebar').inert, false, '桌面端侧栏常驻,不能 inert');
});

test('后退回裸 #providers 停在 Claude,不拿上次保存的客户端解释 URL', () => {
  // 真实浏览器复现的 bug:渠道页从 Claude 点 Codex → URL 变 #providers?app=codex,
  // 后退回 #providers 时页面却留在 Codex(URL 说 Claude,界面说 Codex)。
  const h = setup({ hash: '#providers', storage: { 'mixr.ui.app': 'codex' } });
  h.boot();
  assert.deepEqual(h.appCalls, ['claude'], '裸 #providers 是显式 URL,固定 Claude,不读保存值');

  h.window.setApp('codex');
  assert.equal(h.hash(), '#providers?app=codex');
  h.appCalls.length = 0;

  assert.equal(h.goBack(), true);
  assert.equal(h.hash(), '#providers');
  assert.deepEqual(h.appCalls, ['claude'], '后退后客户端必须跟着 URL 回到 Claude');
  assert.equal(h.showCalls.at(-1), 'providers');
});

test('首次打开没有 hash 时才恢复保存的客户端;显式 #providers 一律 Claude', () => {
  const fresh = setup({ storage: { 'mixr.ui.app': 'codex', 'mixr.ui.view': 'providers' } });
  fresh.boot();
  assert.deepEqual(fresh.appCalls, ['codex'], '没有 URL 信息时偏好优先');

  const explicit = setup({ hash: '#providers', storage: { 'mixr.ui.app': 'codex' } });
  explicit.boot();
  assert.deepEqual(explicit.appCalls, ['claude'], '显式 URL 覆盖偏好');

  const anchor = setup({ hash: '#main', storage: { 'mixr.ui.app': 'codex', 'mixr.ui.view': 'sessions' } });
  anchor.boot();
  assert.deepEqual(anchor.showCalls, ['sessions'], '#main 不是视图,按无 hash 处理');
  assert.deepEqual(anchor.appCalls, ['codex']);
  assert.equal(anchor.hash(), '#sessions', '锚点要被归一成当前视图');
});

test('非法 hash 用 replaceState 归位,不往历史里压第二条', () => {
  const h = setup();
  h.boot();
  h.resetHistory();

  h.setHash('#not-a-view');
  assert.deepEqual(h.showCalls, [], '已经在概览时只改写 URL,不重渲染');
  assert.equal(h.hash(), '#overview');
  assert.deepEqual(h.pushes(), ['#not-a-view'], '只有用户自己那一步进历史');
  assert.deepEqual(h.replaces(), ['#overview'], '归位走 replaceState');
  assert.deepEqual(h.entries(), ['#overview', '#overview'], '坏 hash 不能在历史里留痕');

  h.goBack();
  assert.equal(h.hash(), '#overview', '后退不会又回到坏 hash');
  assert.equal(h.showCalls.at(-1), undefined, '后退回同一条目也不需要重渲染');
});

test('skip-link #main:保留正文跳转,不切视图,也不新增历史', () => {
  const h = setup({ hash: '#providers?app=codex' });
  h.boot();
  h.resetHistory();

  h.setHash('#main');
  assert.deepEqual(h.showCalls, [], '跳正文不是切视图');
  assert.deepEqual(h.appCalls, [], '客户端不变');
  assert.equal(h.doc.activeElement, h.get('main'), '焦点要落到正文');
  assert.equal(h.hash(), '#providers?app=codex', 'URL 归位到当前视图');
  assert.deepEqual(h.pushes(), ['#main']);
  assert.deepEqual(h.replaces(), ['#providers?app=codex']);
});

test('点击 skip-link:焦点进正文,不新增历史,视图与客户端都不动', () => {
  const h = setup({ hash: '#providers?app=codex' });
  h.boot();
  h.resetHistory();
  const before = h.entries().length;

  const event = h.get('skip-link').emit('click');
  assert.equal(event.defaultPrevented, true, '自己接管锚点,避免浏览器先压一条 #main');
  assert.equal(h.doc.activeElement, h.get('main'));
  assert.deepEqual(h.showCalls, []);
  assert.deepEqual(h.appCalls, []);
  assert.equal(h.entries().length, before, '历史条数不变');
  assert.equal(h.hash(), '#providers?app=codex');
});

test('抽屉打开时 Tab 在抽屉链接与开关之间循环,不落到遮罩后的 workspace', () => {
  const h = setup({ mobile: true });
  h.boot();
  h.get('sidebar-toggle').click();
  assert.equal(h.doc.activeElement, h.navLinks[0]);

  const outside = h.get('quick-nav-open');
  outside.focus();
  const rescued = h.documentKeydown({ key: 'Tab' });
  assert.equal(rescued.defaultPrevented, true, '焦点逃出去时要拉回抽屉');
  assert.equal(h.doc.activeElement, h.navLinks[0]);

  const toLast = h.documentKeydown({ key: 'Tab', shiftKey: true });
  assert.equal(toLast.defaultPrevented, true);
  assert.equal(h.doc.activeElement, h.get('sidebar-toggle'), 'Shift+Tab 从首项绕到开关');

  const wrap = h.documentKeydown({ key: 'Tab' });
  assert.equal(wrap.defaultPrevented, true);
  assert.equal(h.doc.activeElement, h.navLinks[0], 'Tab 从开关绕回首项');

    // 桌面端不做陷阱:侧栏常驻,焦点按正常顺序走
  const desktop = setup();
  desktop.boot();
  const abroad = desktop.get('quick-nav-open');
  abroad.focus();
  const free = desktop.documentKeydown({ key: 'Tab' });
  assert.equal(free.defaultPrevented, false, '桌面端不许拦 Tab');
  assert.equal(desktop.doc.activeElement, abroad);
});

test('关掉渠道弹窗后,窄屏隐藏的侧栏立即回到 inert(焦点一移动就补回)', () => {
  const h = setup({ mobile: true });
  h.boot();
  // 模拟 app.js showDialog / hideDialog:打开时 inert=true,关闭时无条件置 false
  h.context.activeDialog = { id: 'mask' };
  h.get('sidebar').inert = true;
  h.context.activeDialog = null;
  h.get('sidebar').inert = false;
  h.focusin(h.get('tab-claude'));
  assert.equal(h.get('sidebar').inert, true, 'hideDialog 的 false 要被外壳补回来');

  // 抽屉打开时不再 inert,菜单可用
  h.get('sidebar-toggle').click();
  assert.equal(h.get('sidebar').inert, false);
});

test('app.js 钩子:视图与客户端偏好落盘,URL 只在渠道页带 app', () => {
  const h = setup();
  h.boot();

  h.window.workspaceViewChanged('diagnostics');
  assert.equal(h.hash(), '#diagnostics');
  assert.equal(h.storage.dump()['mixr.ui.view'], 'diagnostics');
  assert.equal(h.doc.title, '诊断 · Mixrouter');

  h.window.workspaceAppChanged('zcode');
  assert.equal(h.hash(), '#diagnostics', '非渠道页不把 app 写进 URL');
  assert.equal(h.storage.dump()['mixr.ui.app'], 'zcode');

  h.window.workspaceViewChanged('providers');
  assert.equal(h.hash(), '#providers?app=zcode');

  h.window.workspaceAppChanged('claude');
  assert.equal(h.hash(), '#providers', 'claude 是默认值,保持干净');
});

test('快捷键提示按平台写,不提示本机不存在的组合', () => {
  const mac = setup();
  mac.boot();
  assert.equal(mac.get('quick-nav-kbd').textContent, '⌘K');
  const win = setup({ platform: 'Win32' });
  win.boot();
  assert.equal(win.get('quick-nav-kbd').textContent, 'Ctrl K');
});

test('外壳不做任何业务请求:没有 fetch,也不碰业务数据', () => {
  const h = setup();
  h.boot();
  h.window.workspaceViewChanged('usage');
  h.get('quick-nav-open').click();
  assert.equal(typeof h.context.fetch, 'undefined', '源码不应引用 fetch');
});
