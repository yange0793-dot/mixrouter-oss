'use strict';
// 接入向导 / 槽位后备池 / 诊断报告预览:只跑真实 public/js/app.js + public/js/readiness.js 的
// 经典脚本,配一个最小 DOM/fetch 边界。不碰真实网络、真实客户端配置或任何密钥。
//
// 重点不是"按钮能点",而是几条会骗人的边界:
//   - 客户端配置读不到 / 解析失败时必须阻断写入,不能显示成"未配置";
//   - 导入、兼容测试、写入、撤销都必须先预览再显式确认,确认前不发 apply;
//   - 兼容测试写清"一次 / 有时间点 / 不是持续健康";
//   - 后备池保存保留 dropTools 与非 priority 策略,清空时显式传 [];
//   - 诊断报告不在挂载时自动读取,下载只在点击后发生。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const appScript = new vm.Script(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), { filename: 'public/js/app.js' });
const readinessScript = new vm.Script(fs.readFileSync(path.join(__dirname, '../public/js/readiness.js'), 'utf8'), { filename: 'public/js/readiness.js' });

function fixture() {
  return {
    version: 'test', proxy_port: 8787, ui_port: 8788, uptime_s: 125, pid: 4242, code_revision: 'abcdef0123456789',
    stats: { reqs: 12, inTok: 100, outTok: 40 },
    providers: {
      claude: [
        {
          id: 'a1', name: 'Alpha', base_url: 'https://anthropic.example', models: ['claude-special', 'claude-other'],
          enabled: true, key_masked: '***',
          keys: [{ id: 'k1', label: 'Account One', key_masked: 'sk-***-one', enabled: true }, { id: 'k2', label: 'Account Two', key_masked: 'sk-***-two', enabled: false }],
          active_key: 'k1',
        },
        { id: 'a2', name: 'Backup', base_url: 'https://backup.example', models: ['claude-back'], enabled: true, key_masked: '***' },
        { id: 'a3', name: 'Third', base_url: 'https://third.example', models: ['claude-third'], enabled: true, key_masked: '***' },
      ],
      codex: [
        { id: 'o1', name: 'Beta', base_url: 'https://openai.example/v1', model: 'gpt-test', wire_api: 'responses', enabled: true },
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
        dropTools: name === 'main' ? ['mcp__x'] : [],
        pool: name === 'main' ? [{ provider: 'a2' }] : [],
        strategy: name === 'main' ? 'round_robin' : 'round_robin',
      })),
      codex: [],
    },
    sessions: [], cooldowns: [],
  };
}

function reply(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(payload) };
}
const plain = value => JSON.parse(JSON.stringify(value));

async function harness(initial = fixture()) {
  let server = initial;
  const elements = new Map();
  const listeners = new Map();
  const anchors = [];
  let document;
  let inlineRun = () => {};

  class Element {
    constructor(id = '', tag = 'div') {
      this.id = id; this.tagName = String(tag).toUpperCase(); this.style = {}; this.dataset = {};
      this.attributes = {}; this.value = ''; this.checked = false; this.disabled = false;
      this.hidden = false; this.inert = false; this.open = false; this.isConnected = true;
      this.children = []; this.parentNode = null; this.nextSibling = null;
      this.events = {}; this.textContent = ''; this.className = ''; this.tabIndex = 0;
      this._html = ''; this._owned = new Set();
      const classes = new Set();
      this.classList = {
        add: (...xs) => xs.forEach(x => classes.add(x)),
        remove: (...xs) => xs.forEach(x => classes.delete(x)),
        contains: x => classes.has(x),
        toggle: (x, force) => { const on = force ?? !classes.has(x); if (on) classes.add(x); else classes.delete(x); return on; },
      };
    }
    set innerHTML(value) {
      for (const oldId of this._owned) if (elements.get(oldId)?.parentNode === this) elements.delete(oldId);
      this._owned = new Set();
      this._html = String(value ?? '');
      this.children = [];
      for (const match of this._html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
        const el = new Element(match[2], match[1]);
        el.parentNode = this;
        el.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
        el.checked = /\bchecked\b/.test(match[0]);
        if (/\bdisabled\b/.test(match[0])) el.disabled = true;
        if (/\bhidden\b/.test(match[0])) el.hidden = true;
        el.setAttribute('class', match[0].match(/\bclass="([^"]*)"/)?.[1] || '');
        const onclick = match[0].match(/\bonclick="([^"]*)"/)?.[1];
        if (onclick) el.inlineOnclick = onclick;
        elements.set(el.id, el);
        this._owned.add(el.id);
        this.children.push(el);
      }
    }
    get innerHTML() { return this._html; }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'class') { this.className = String(value); for (const cls of String(value).split(/\s+/).filter(Boolean)) this.classList.add(cls); }
      if (name === 'open') this.open = true;
      if (name === 'hidden') this.hidden = true;
    }
    removeAttribute(name) { delete this.attributes[name]; if (name === 'open') this.open = false; }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
    removeEventListener() {}
    appendChild(node) {
      node.parentNode = this; node.isConnected = true;
      const last = this.children[this.children.length - 1];
      if (last) last.nextSibling = node;
      this.children.push(node);
      if (node.id) elements.set(node.id, node);
      return node;
    }
    insertBefore(node, ref) {
      node.parentNode = this; node.isConnected = true;
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at < 0) return this.appendChild(node);
      this.children.splice(at, 0, node);
      node.nextSibling = ref;
      const prev = this.children[at - 1];
      if (prev) prev.nextSibling = node;
      if (node.id) elements.set(node.id, node);
      return node;
    }
    removeChild(node) { const i = this.children.indexOf(node); if (i >= 0) this.children.splice(i, 1); node.parentNode = null; node.isConnected = false; return node; }
    focus() { document.activeElement = this; }
    contains(el) { return el === this || (!!el?.parentNode && this.contains(el.parentNode)); }
    closest(selector) { let node = this; while (node) { if (node.matches?.(selector)) return node; node = node.parentNode; } return null; }
    matches(selector) {
      return String(selector).split(',').some(raw => {
        const sel = raw.trim();
        if (!sel) return false;
        if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
        if (sel.startsWith('#')) return this.id === sel.slice(1);
        if (sel.includes('[')) { const attr = sel.match(/\[([\w-]+)(?:="([^"]*)")?\]/); return !!attr && (attr[2] === undefined ? this.attributes[attr[1]] !== undefined : this.attributes[attr[1]] === attr[2]); }
        return this.tagName === sel.toUpperCase();
      });
    }
    querySelector(selector) {
      if (selector === '.modal') return this.modal || null;
      const all = this.querySelectorAll(selector);
      return all[0] || null;
    }
    querySelectorAll(selector) {
      const sel = String(selector);
      if (sel.includes(':disabled')) return this.children.filter(el => !el.disabled && ['BUTTON', 'INPUT', 'SELECT'].includes(el.tagName));
      if (sel === 'button') return this.children.filter(el => el.tagName === 'BUTTON');
      if (sel === 'button,select') return this.children.filter(el => ['BUTTON', 'SELECT'].includes(el.tagName));
      const out = [];
      const walk = node => { for (const child of node.children) { if (child.matches(sel)) out.push(child); walk(child); } };
      walk(this);
      return out;
    }
    getClientRects() { return this.hidden ? [] : [{}]; }
    reportValidity() { return true; }
    click() { if (this.onclick) this.onclick({ preventDefault() {} }); else if (this.inlineOnclick) inlineRun(this.inlineOnclick); }
  }

  for (const m of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const el = new Element(m[2], m[1]);
    const inline = m[0].match(/\bonclick="([^"]*)"/)?.[1];
    if (inline) el.inlineOnclick = inline;
    const styleText = m[0].match(/\bstyle="([^"]*)"/)?.[1];
    if (styleText) for (const decl of styleText.split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) el.style[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
    el.setAttribute('class', m[0].match(/\bclass="([^"]*)"/)?.[1] || '');
    elements.set(m[2], el);
  }
  const get = id => { assert.ok(elements.has(id), 'Unknown DOM id: ' + id); return elements.get(id); };
  const body = new Element('body', 'body');
  const documentElement = new Element('', 'html');

  // 页面里真正有父子关系的几处:向导入口要插在 .apptabs 前,后备池容器要跟在 #slots-rows 后。
  const providersView = get('view-providers');
  const tabs = new Element('', 'div');
  tabs.setAttribute('class', 'apptabs');
  providersView.appendChild(tabs);
  const slotsPanel = get('slots-panel');
  const slotsRows = get('slots-rows');
  slotsPanel.appendChild(slotsRows);

  const nav = Array.from(html.matchAll(/<a\b[^>]*\bdata-view="([^"]+)"[^>]*>/g), match => {
    const el = new Element('nav-' + match[1], 'a');
    el.dataset.view = match[1];
    return el;
  });
  const apptabs = tabs;

  document = {
    body, documentElement, activeElement: body, readyState: 'complete', visibilityState: 'visible', hidden: false,
    getElementById: id => elements.get(id) || null,
    querySelectorAll: selector => {
      if (selector === 'nav a') return nav;
      if (selector === '#m-model-discovery input[data-model-index]') return [];
      return [];
    },
    querySelector: selector => {
      if (selector === '.apptabs') return apptabs;
      if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
      return null;
    },
    addEventListener: (event, fn) => { (listeners.get(event) || listeners.set(event, []).get(event)).push(fn); },
    removeEventListener: () => {},
    createElement: tag => {
      const el = new Element('', tag);
      if (String(tag).toLowerCase() === 'a') anchors.push(el);
      return el;
    },
  };
  get('provider-filter').value = 'all';
  get('logs-auto').checked = true;
  for (const [maskId, controls] of [['mask', ['m-name', 'm-base', 'm-key', 'save-provider']], ['confirm-mask', ['confirm-cancel', 'confirm-ok']]]) {
    const mask = get(maskId); mask.modal = new Element(maskId + '-dialog'); mask.modal.parentNode = mask;
    mask.children = controls.map(id => { const el = get(id); el.parentNode = mask; return el; });
  }

  const requests = [];
  const timers = [];
  let fetchImpl = null;
  const context = vm.createContext({
    document,
    window: { addEventListener() {}, localStorage: undefined, location: { hash: '' } },
    console, AbortController, structuredClone, URLSearchParams,
    URL: { createObjectURL: () => { context.__blobUrls = (context.__blobUrls || 0) + 1; return 'blob:test'; }, revokeObjectURL() {} },
    Blob: class Blob { constructor(parts, opts = {}) { this.parts = parts; this.type = opts.type || ''; } },
    // 记录排程的延时:用来断言兼容测试的超时窗口,而不是靠"跑一次真等 90 秒"。
    setTimeout(fn, ms) { timers.push(ms); return 1; }, clearTimeout() {},
    setInterval() { return 1; }, clearInterval() {},
    fetch: async (url, options = {}) => {
      const bodyText = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, method: options.method || 'GET', body: bodyText });
      if (fetchImpl) return fetchImpl(url, options);
      if (url === '/api/state') return reply(200, structuredClone(server));
      return reply(200, { ok: true });
    },
  });
  const run = code => vm.runInContext(code, context);
  inlineRun = code => run(`(function(event){${code}})({ preventDefault(){} })`);
  appScript.runInContext(context);
  readinessScript.runInContext(context);
  await run('refresh()');

  return {
    get, run, requests, timers, document, listeners, anchors, context, Element,
    fetchStub(fn) { fetchImpl = fn; },
    updateServer(next) { server = next; },
    getServer() { return server; },
    find(url) { return requests.filter(r => r.url === url); },
  };
}

const onboarding = (h, app = 'claude') => h.find('/api/onboarding/' + app);
// 页面里的异步动作不返回同一个 promise(例如切客户端后自动触发检查);用微任务把桩响应走完。
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

test('客户端配置读取失败时阻断写入，不伪装成未配置', async () => {
  const h = await harness();
  assert.equal(onboarding(h).length, 0, '挂载时不主动探测客户端');
  h.fetchStub(async (url) => {
    if (url === '/api/onboarding/claude') return reply(500, { error: 'EACCES: settings.json 不可读' });
    if (url === '/api/state') return reply(200, fixture());
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  await h.run('readinessInspect()');
  const body = h.get('readiness-body').innerHTML;
  assert.match(body, /检查失败，不能当作未配置/);
  assert.match(body, /EACCES: settings\.json 不可读/);
  assert.equal(h.document.activeElement.id, 'readiness-inspect-error', '检查失败后焦点落到错误说明上');
  assert.equal(h.get('readiness-preview-btn').disabled, true, '读不到配置时预览按钮必须禁用');
  h.run('readinessPreviewWrite()');
  assert.equal(onboarding(h).filter(r => r.url.endsWith('/preview')).length, 0, '阻断状态不得偷偷发写入预览');
  assert.match(h.get('readiness-body').innerHTML, /EACCES/, '恢复检查状态里保留失败原因');
});

test('导入先预览脱敏结果，勾选确认后才发 apply', async () => {
  const h = await harness();
  h.fetchStub(async (url) => {
    if (url === '/api/onboarding/claude') return reply(200, { app: 'claude', binary: { found: true, path: '/usr/local/bin/claude', version: '2.0' }, config: { state: 'ok', path: '~/.claude/settings.json' } });
    if (url === '/api/providers/import/preview') return reply(200, {
      token: 't-import', summary: { channels: 1, skipped: 0 }, errors: [],
      providers: [{ id: 'new1', name: 'Pasted', base_url: 'https://pasted.example', models: ['glm-x'], key_masked: 'sk-***-hidden' }],
    });
    if (url === '/api/providers/import/apply') return reply(200, { ok: true, merged: 1 });
    if (url === '/api/state') return reply(200, fixture());
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  h.run('readinessToggleImport()');
  h.get('readiness-import-text').value = JSON.stringify({ providers: [{ name: 'Pasted', base_url: 'https://pasted.example', api_key: 'sk-secret-never-render' }] });
  await h.run('readinessImportPreview()');
  const previewReq = h.find('/api/providers/import/preview');
  assert.equal(previewReq.length, 1);
  assert.deepEqual(plain(previewReq[0].body), { input: { providers: [{ name: 'Pasted', base_url: 'https://pasted.example', api_key: 'sk-secret-never-render' }] } });
  // 文本框里保留的是用户自己粘贴的原文;这里只看预览结果块。
  const result = h.get('readiness-body').innerHTML.split('id="readiness-import-result"')[1] || '';
  assert.match(result, /Pasted/);
  assert.match(result, /sk-\*\*\*-hidden/);
  assert.ok(!result.includes('sk-secret-never-render'), '导入预览不得渲染原始 Key');
  assert.equal(h.get('readiness-import-apply').disabled, true, '未勾选确认时不能导入');
  h.get('readiness-import-confirm').checked = true;
  h.run('readinessSyncButtons()');
  assert.equal(h.get('readiness-import-apply').disabled, false);
  await h.run('readinessImportApply()');
  const applyReq = h.find('/api/providers/import/apply');
  assert.equal(applyReq.length, 1);
  assert.deepEqual(plain(applyReq[0].body), { token: 't-import', confirm: true });
});

test('兼容测试需显式同意消耗额度，结果显示时间点与一次性范围', async () => {
  const h = await harness();
  h.fetchStub(async (url) => {
    if (url === '/api/onboarding/claude') return reply(200, { app: 'claude', binary: { found: true, path: '/usr/local/bin/claude' }, config: { state: 'ok', path: '~/.claude/settings.json' } });
    if (url.endsWith('/compatibility')) return reply(200, {
      ok: true, checked_at: '2026-10-22T03:04:05Z', scope: { app: 'claude', client_wire: 'messages', wire_api: 'anthropic', model: 'claude-special', key_id: 'k1' },
      checks: [{ id: 'models', status: 'ok', code: '200', message: '模型可达', ms: 120 }], ms: 340,
    });
    if (url === '/api/state') return reply(200, fixture());
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  h.run("readinessPickProvider('a1')");
  assert.equal(h.get('readiness-test-btn').disabled, true, '未勾选同意前按钮禁用');
  h.get('readiness-test-ack').checked = true;
  h.run('readinessSyncButtons()');
  assert.equal(h.get('readiness-test-btn').disabled, false);
  await h.run('readinessRunTest()');
  const req = h.find('/api/providers/a1/compatibility');
  assert.equal(req.length, 1);
  assert.deepEqual(plain(req[0].body), { app: 'claude', model: 'claude-special', key_id: 'k1', client_wire: 'messages', confirm_run: true },
    'Claude 客户端固定发 Messages,请求体带上 app 让服务端正确解释 client_wire');
  const result = h.get('readiness-body').innerHTML;
  assert.match(result, /本次通过/);
  assert.match(result, /检查时间/);
  assert.match(result, /最多 3 次上游请求/);
  assert.equal(h.run('readinessUiState().compatTimeoutMs'), 100000,
    '后端 3×30s（总 90s）:前端窗口必须比 90 秒长，否则会把仍在跑的真实测试报成超时');
  assert.ok(h.timers.includes(100000), '兼容测试那次请求排的是 100 秒超时');
  assert.ok(!h.timers.includes(65000), '不能再用 65 秒窗口');
  assert.match(h.get('readiness-body').innerHTML, /三项检查按顺序都跑/);
  assert.ok(!h.get('readiness-body').innerHTML.includes('提前结束'), '后端三项检查按序都跑，不能说成任一失败就提前结束');
  assert.match(result, /不是持续健康/);
  assert.match(result, /模型可达/);
  assert.match(result, /协议 messages/);
});

test('写入先预览再确认，撤销入口展示受管字段与冲突', async () => {
  const h = await harness();
  h.fetchStub(async (url) => {
    if (url === '/api/onboarding/claude') return reply(200, { app: 'claude', binary: { found: true, path: '/usr/local/bin/claude' }, config: { state: 'ok', path: '~/.claude/settings.json' } });
    if (url === '/api/onboarding/claude/preview') return reply(200, {
      token: 't-write',
      changes: [{ field: 'ANTHROPIC_BASE_URL', before: 'https://old.example', after: 'http://127.0.0.1:8787' }],
      warnings: ['写入后需重启 Claude Code 会话'],
    });
    if (url === '/api/onboarding/claude/apply') return reply(200, { ok: true, changed: [{ field: 'ANTHROPIC_BASE_URL', before: null, after: 'http://127.0.0.1:8787' }], ledger_saved: true, warnings: [] });
    if (url === '/api/onboarding/claude/undo-preview') return reply(200, {
      ok: true, can_undo: true, token: 't-undo',
      changes: [{ field: 'ANTHROPIC_BASE_URL', current: 'http://127.0.0.1:8787', restore: 'https://old.example' }],
      conflicts: [{ field: 'ANTHROPIC_MODEL', current: '别的模型', expected: 'claude-special' }],
    });
    if (url === '/api/onboarding/claude/undo') return reply(200, { ok: true, warnings: [] });
    if (url === '/api/state') return reply(200, fixture());
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  h.run("readinessPickProvider('a1')");
  await h.run('readinessPreviewWrite()');
  const previewReq = h.find('/api/onboarding/claude/preview');
  assert.equal(previewReq.length, 1);
  assert.deepEqual(plain(previewReq[0].body), { provider_id: 'a1', model: 'claude-special', key_id: 'k1', client_wire: 'messages', slots: true },
    'main 槽已配置时声明 slots:true,让预览列出槽位 env');
  const preview = h.get('readiness-body').innerHTML;
  assert.match(preview, /ANTHROPIC_BASE_URL/);
  assert.match(preview, /尚未改动任何文件/);
  assert.equal(h.get('readiness-apply-btn').disabled, true, '预览后仍需显式勾选');
  h.get('readiness-write-confirm').checked = true;
  h.run('readinessSyncButtons()');
  await h.run('readinessApplyWrite()');
  const applyReq = h.find('/api/onboarding/claude/apply');
  assert.equal(applyReq.length, 1);
  assert.deepEqual(plain(applyReq[0].body), { token: 't-write', confirm: true });
  assert.match(h.get('readiness-body').innerHTML, /已确认写入/);

  await h.run('readinessUndoPreview()');
  const undoPreview = h.find('/api/onboarding/claude/undo-preview');
  assert.equal(undoPreview.length, 1);
  const undoHtml = h.get('readiness-body').innerHTML;
  assert.match(undoHtml, /可以撤销/);
  assert.match(undoHtml, /受管字段（1）/);
  assert.match(undoHtml, /ANTHROPIC_MODEL/);
  assert.match(undoHtml, /账本期望/);
  assert.equal(h.get('readiness-undo-btn').disabled, true);
  h.get('readiness-undo-confirm').checked = true;
  h.run('readinessSyncButtons()');
  await h.run('readinessUndoApply()');
  const undoReq = h.find('/api/onboarding/claude/undo');
  assert.equal(undoReq.length, 1);
  assert.deepEqual(plain(undoReq[0].body), { token: 't-undo', confirm: true });
  // apply 的真实响应字段是 changed(不是 changes)；撤销入口要能读到受管字段。
  assert.match(h.get('readiness-body').innerHTML, /已确认写入/);
});

test('后备池保存保留 dropTools 与非 priority 策略，清空时显式传空数组', async () => {
  const h = await harness();
  h.fetchStub(async (url, options) => {
    if (url === '/api/slots') {
      const patch = JSON.parse(options.body);
      const next = structuredClone(h.getServer());
      for (const slot of next.slots.claude) {
        if (patch?.claude?.[slot.name]) Object.assign(slot, patch.claude[slot.name]);
      }
      h.updateServer(next);
      return reply(200, { ok: true, slots: next.slots });
    }
    if (url === '/api/state') return reply(200, structuredClone(h.getServer()));
    return reply(200, { ok: true });
  });
  assert.match(h.get('readiness-slot-pools').innerHTML, /后备池 1 个 · round_robin/, '显示已有后备池与保留的策略');
  h.run("readinessPoolToggle('main')");
  let editor = h.get('readiness-slot-pools').innerHTML;
  assert.match(editor, /主渠道 · 固定第一/);
  assert.match(editor, /现有策略是 <b>round_robin<\/b>/, '非 priority 策略要说出来并被保留');
  assert.match(editor, /Backup/, '已有后备成员出现在草稿里');
  h.get('readiness-pool-add-main').value = 'a3';
  h.run("readinessPoolAdd('main')");
  h.run("readinessPoolMove('main',1,-1)");
  await h.run("readinessPoolSave('main')");
  const first = h.find('/api/slots').at(-1);
  assert.deepEqual(plain(first.body.claude.main), {
    provider: 'a1', model: 'claude-special', dropTools: ['mcp__x'],
    pool: [{ provider: 'a3' }, { provider: 'a2' }], strategy: 'round_robin',
  });
  assert.match(h.get('readiness-slot-pools').innerHTML, /已保存 2 个后备渠道/);

  h.run("readinessPoolToggle('main')");
  h.run("readinessPoolRemove('main',0)");
  h.run("readinessPoolRemove('main',0)");
  await h.run("readinessPoolSave('main')");
  const second = h.find('/api/slots').at(-1);
  assert.deepEqual(plain(second.body.claude.main.pool), [], '清空后备池必须显式传 []');
  assert.equal('strategy' in second.body.claude.main, false, '没有后备成员时不夹带策略');
  assert.deepEqual(plain(second.body.claude.main.dropTools), ['mcp__x'], '清空后备池也要保留 dropTools');
});

test('Claude 客户端协议固定 Messages，不把上游 wire 当成客户端协议可选', async () => {
  const h = await harness();
  h.fetchStub(async (url) => {
    if (url === '/api/onboarding/claude') return reply(200, { app: 'claude', binary: { found: true, executable: true, path: '/usr/local/bin/claude' }, config: { path: '~/.claude/settings.json', status: 'ok' } });
    if (url === '/api/state') return reply(200, fixture());
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  assert.equal(h.document.getElementById('readiness-wire-select'), null, 'Claude 没有三选一的客户端协议下拉');
  assert.match(h.get('readiness-body').innerHTML, /id="readiness-wire-fixed">Anthropic Messages（固定）/);
  assert.match(h.get('readiness-body').innerHTML, /上游协议由渠道的 wire_api 决定/);
});

test('ZCode 客户端协议仍可选三种，选 OpenAI 后渠道来自 Codex 组', async () => {
  const h = await harness();
  h.fetchStub(async (url) => {
    if (url === '/api/onboarding/zcode') return reply(200, { app: 'zcode', binary: { found: true, executable: true, path: '/usr/local/bin/zcode' }, config: { path: '~/.zcode/v2/config.json', status: 'missing' } });
    if (url === '/api/state') return reply(200, fixture());
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  h.run("readinessPickClient('zcode')");
  await flush();
  assert.ok(h.document.getElementById('readiness-wire-select'), 'ZCode 保留协议下拉');
  h.run("readinessPickWire('responses')");
  const picked = plain(h.run('readinessUiState()'));
  assert.deepEqual({ ...picked, compatTimeoutMs: undefined }, {
    app: 'zcode', zcodeWire: 'responses', clientWire: 'responses', group: 'codex',
    providerId: 'o1', model: 'gpt-test', keyId: '', busy: '', compatTimeoutMs: undefined,
  });
  h.run("readinessPickWire('anthropic')");
  const back = plain(h.run('readinessUiState()'));
  assert.equal(back.providerId, 'a1');
  assert.equal(back.clientWire, 'messages', 'ZCode 选 Anthropic 时客户端协议叫 messages');
});

test('Codex 槽位设置独立于初次接入，缺项明示自动补齐而非只写路由地址', async () => {
  const h = await harness();
  const slots = [];
  let store = fixture();
  store.slots.codex = [];
  h.updateServer(store);
  await h.run('refresh()');
  h.fetchStub(async (url, options) => {
    if (url === '/api/onboarding/codex') return reply(200, { app: 'codex', binary: { found: true, executable: true, path: '/usr/local/bin/codex' }, config: { path: '~/.codex/config.toml', status: 'missing' } });
    if (url === '/api/slots') {
      const patch = JSON.parse(options.body);
      slots.push(patch);
      const next = structuredClone(h.getServer());
      next.slots.codex = next.slots.codex.slice();
      for (const [name, value] of Object.entries(patch.codex || {})) {
        const at = next.slots.codex.findIndex(slot => slot.name === name);
        const entry = { name, alias: 'mixr-' + name, provider: value.provider, enabled: true, model: '' };
        if (at >= 0) next.slots.codex[at] = entry; else next.slots.codex.push(entry);
      }
      h.updateServer(next);
      return reply(200, { ok: true, slots: next.slots });
    }
    if (url === '/api/state') return reply(200, structuredClone(h.getServer()));
    return reply(200, { ok: true });
  });
  h.run("setApp('codex')");
  await h.run('readinessOpen()');
  assert.match(h.get('readiness-body').innerHTML, /缺少的槽位.*第一个已启用、有默认模型和 API Key/);
  assert.match(h.get('readiness-body').innerHTML, /撤销客户端字段后，补齐的槽位仍保留/);
  assert.doesNotMatch(h.get('readiness-body').innerHTML, /只写路由地址与令牌|不会自动补槽/);
  await h.run("readinessSetSlots('codex')");
  assert.deepEqual(plain(slots.map(body => Object.keys(body.codex))), [['main'], ['reviewer']], '两个槽各自一次 PUT /api/slots');
  assert.match(h.get('readiness-body').innerHTML, /已把 main \/ reviewer 设为/);
  assert.match(h.get('readiness-body').innerHTML, /保留 main 与 reviewer 各自当前的渠道和落点模型/);
});

test('Codex 缺槽预览不发送严格 slots:true，首次接入仍需确认且不声称标签热刷新', async () => {
  for (const names of [[], ['main'], ['main', 'reviewer']]) {
    const data = fixture();
    data.slots.codex = names.map(name => ({ name, alias: 'mixr-' + name, provider: 'o1', enabled: true, model: 'gpt-test' }));
    const h = await harness(data);
    h.fetchStub(async url => {
      if (url === '/api/onboarding/codex') return reply(200, { app: 'codex', config: { status: 'ok', path: '~/.codex/config.toml' } });
      if (url === '/api/onboarding/codex/preview') return reply(200, { token: 'tcx', changes: [{ field: 'model', after: 'mixr-main' }], warnings: [] });
      if (url === '/api/onboarding/codex/apply') return reply(200, { ok: true, changed: [{ field: 'model', after: 'mixr-main' }], ledger_saved: true });
      if (url === '/api/state') return reply(200, data);
      return reply(200, { ok: true });
    });
    h.run("setApp('codex')"); await h.run('readinessOpen()');
    await h.run('readinessPreviewWrite()');
    const body = h.find('/api/onboarding/codex/preview').at(-1).body;
    assert.equal(body.slots, names.length === 2 ? true : undefined, 'only existing configured pair uses strict slots');
    assert.equal(h.find('/api/onboarding/codex/apply').length, 0);
    assert.equal(h.get('readiness-apply-btn').disabled, true);
    h.get('readiness-write-confirm').checked = true; h.run('readinessSyncButtons()');
    await h.run('readinessApplyWrite()');
    assert.deepEqual(plain(h.find('/api/onboarding/codex/apply').at(-1).body), { token: 'tcx', confirm: true });
    assert.match(h.get('readiness-body').innerHTML, /首次接入需打开使用新配置的 Codex 客户端/);
    assert.match(h.get('readiness-body').innerHTML, /槽位调整从下一次请求生效/);
    assert.match(h.get('readiness-body').innerHTML, /已打开的 Codex 客户端会缓存模型标签，新客户端读取同步列表/);
    assert.doesNotMatch(h.get('readiness-body').innerHTML, /Codex 需重启生效|重新打开模型下拉/);
  }
});

test('Claude 一键配齐五槽，未配副槽时明说不写别名', async () => {
  const h = await harness();
  const slots = [];
  const data = fixture();
  data.slots.claude = data.slots.claude.map(slot => ({ ...slot, provider: '', provider_name: '', model: '', pool: [], dropTools: [] }));
  h.updateServer(data);
  await h.run('refresh()');
  h.fetchStub(async (url, options) => {
    if (url === '/api/onboarding/claude') return reply(200, { app: 'claude', binary: { found: true, executable: true, path: '/usr/local/bin/claude' }, config: { path: '~/.claude/settings.json', status: 'ok' } });
    if (url === '/api/slots') {
      const patch = JSON.parse(options.body);
      slots.push(patch);
      const next = structuredClone(h.getServer());
      for (const [name, value] of Object.entries(patch.claude || {})) {
        const at = next.slots.claude.findIndex(slot => slot.name === name);
        next.slots.claude[at] = { ...next.slots.claude[at], provider: value.provider, provider_name: 'Alpha', model: value.model };
      }
      h.updateServer(next);
      return reply(200, { ok: true, slots: next.slots });
    }
    if (url === '/api/state') return reply(200, structuredClone(h.getServer()));
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  assert.match(h.get('readiness-body').innerHTML, /只写路由地址与令牌/);
  assert.match(h.get('readiness-body').innerHTML, /其余槽位不写别名/);
  await h.run("readinessSetSlots('claude')");
  assert.deepEqual(plain(slots.map(body => Object.keys(body.claude))), [['main'], ['opus'], ['sonnet'], ['haiku'], ['subagent']]);
  assert.match(h.get('readiness-body').innerHTML, /已把 main \/ opus \/ sonnet \/ haiku \/ subagent 设为 Alpha/);
});

test('Codex 不显示后备池编辑入口', async () => {
  const h = await harness();
  h.run("setApp('codex'); renderSlots(true)");
  const poolHtml = h.get('readiness-slot-pools').innerHTML;
  assert.match(poolHtml, /不提供编辑入口/);
  assert.equal(poolHtml.includes('readiness-pool-save'), false);
});

test('未检测到客户端时给出可复制的接入参数，明文令牌不出现在页面上', async () => {
  const h = await harness();
  h.fetchStub(async (url) => {
    if (url === '/api/onboarding/claude') return reply(200, { app: 'claude', binary: false, config: { state: 'missing', path: '~/.claude/settings.json' } });
    if (url === '/api/state') return reply(200, fixture());
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  const body = h.get('readiness-body').innerHTML;
  assert.match(body, /未检测到客户端/);
  assert.match(body, /尚未配置（可新建）/);
  assert.match(body, /手动接入参数/);
  assert.match(body, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:8787/);
  assert.match(body, /&lt;本机路由令牌，界面不显示明文&gt;/);
  assert.equal(h.get('readiness-preview-btn').disabled, false, 'missing 是合法的新接入状态，可以写入');
  h.run('readinessCopyParams()');
  assert.match(h.get('readiness-copy-status').textContent, /复制不可用|已复制/);
});

test('配置无法解析：不显示成未配置，写入禁用但兼容测试仍可运行', async () => {
  const h = await harness();
  h.fetchStub(async (url) => {
    if (url === '/api/onboarding/zcode') return reply(200, { app: 'zcode', binary: { found: true, path: '/usr/local/bin/zcode' }, config: { state: 'invalid', path: '~/.zcode/v2/config.json', error: 'Unexpected token }' } });
    if (url === '/api/state') return reply(200, fixture());
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  h.run("readinessPickClient('zcode')");
  await flush();
  assert.equal(h.get('readiness-client-zcode').attributes['aria-selected'], 'true');
  assert.equal(h.get('readiness-client-claude').attributes['aria-selected'], 'false');
  const body = h.get('readiness-body').innerHTML;
  assert.match(body, /配置无法解析/);
  assert.match(body, /写入已停用/);
  assert.ok(!body.includes('尚未配置（可新建）'), 'invalid 不能被渲染成未配置');
  assert.equal(h.get('readiness-preview-btn').disabled, true);
  assert.equal(h.get('readiness-undo-preview').disabled, true, '撤销同样不能写读不出来的配置');
  h.get('readiness-test-ack').checked = true;
  h.run('readinessSyncButtons()');
  assert.equal(h.get('readiness-test-btn').disabled, false, '兼容测试只发上游请求，不因客户端配置坏掉被禁');
  h.run('readinessPreviewWrite()');
  assert.equal(h.find('/api/onboarding/zcode/preview').length, 0);
});

test('槽位未配置时只写路由地址，并在预览前说明这次会写什么', async () => {
  const data = fixture();
  data.slots.claude = data.slots.claude.map(slot => ({ ...slot, provider: '', provider_name: '', pool: [] }));
  const h = await harness(data);
  h.fetchStub(async (url) => {
    if (url === '/api/onboarding/claude') return reply(200, { app: 'claude', binary: { found: true, executable: true, path: '/usr/local/bin/claude' }, config: { path: '~/.claude/settings.json', status: 'ok' } });
    if (url === '/api/onboarding/claude/preview') return reply(200, { token: 't', changes: [{ field: 'ANTHROPIC_BASE_URL', after: 'http://127.0.0.1:8787' }], warnings: [] });
    if (url === '/api/state') return reply(200, structuredClone(h.getServer()));
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  const written = h.get('readiness-body').innerHTML.split('id="readiness-write-mode"')[1] || '';
  assert.match(written, /只写路由地址与令牌/);
  assert.match(written, /main/);
  await h.run('readinessPreviewWrite()');
  const body = plain(h.find('/api/onboarding/claude/preview')[0].body);
  assert.equal('slots' in body, false, '槽位缺失时不声明 slots,否则会写出用不到的别名');
  assert.equal(body.provider_id, 'a1');
});

test('ZCode 预览按所选协议与模型写入，用 wire_api 而不是 client_wire', async () => {
  const h = await harness();
  h.fetchStub(async (url) => {
    if (url === '/api/onboarding/zcode') return reply(200, { app: 'zcode', binary: { found: true, executable: true, path: '/usr/local/bin/zcode' }, config: { path: '~/.zcode/v2/config.json', status: 'missing' } });
    if (url === '/api/onboarding/zcode/preview') return reply(200, { token: 'tz', changes: [], warnings: [] });
    if (url === '/api/state') return reply(200, fixture());
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  h.run("readinessPickClient('zcode')");
  await flush();
  h.run("readinessPickWire('responses')");
  h.run("readinessSetModel('gpt-test')");
  await h.run('readinessPreviewWrite()');
  const body = plain(h.find('/api/onboarding/zcode/preview')[0].body);
  assert.equal(body.wire_api, 'responses');
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.provider_id, 'o1', '换到 responses 后渠道来自 Codex 组');
});

test('重复写入没有字段差异时不谎报「已落盘」，也不说服务端没回传清单', async () => {
  const h = await harness();
  h.fetchStub(async (url) => {
    if (url === '/api/onboarding/claude') return reply(200, { app: 'claude', binary: { found: true, executable: true, path: '/usr/local/bin/claude' }, config: { path: '~/.claude/settings.json', status: 'ok' } });
    if (url === '/api/onboarding/claude/preview') return reply(200, { token: 't', changes: [], warnings: [] });
    if (url === '/api/onboarding/claude/apply') return reply(200, { ok: true, changed: [], ledger_saved: false, warnings: [] });
    if (url === '/api/state') return reply(200, fixture());
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  h.run("readinessPickProvider('a1')");
  await h.run('readinessPreviewWrite()');
  h.get('readiness-write-confirm').checked = true;
  h.run('readinessSyncButtons()');
  await h.run('readinessApplyWrite()');
  const body = h.get('readiness-body').innerHTML;
  assert.match(body, /没有字段需要改动/);
  assert.ok(!body.includes('服务端没有回传写入后的字段清单'), '空数组是"服务端返回了空清单"，不是"没返回"');
  assert.match(body, /没有记录撤销账本/);
});

test('慢请求期间显示忙碌态并锁住按钮，完成或失败后恢复', async () => {
  const h = await harness();
  let release;
  h.fetchStub(async (url) => {
    if (url === '/api/onboarding/claude') return reply(200, { app: 'claude', binary: { found: true, path: '/usr/local/bin/claude' }, config: { state: 'ok', path: '~/.claude/settings.json' } });
    if (url === '/api/onboarding/claude/preview') return new Promise(resolve => { release = resolve; });
    if (url === '/api/state') return reply(200, fixture());
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  h.run("readinessPickProvider('a1')");
  const pending = h.run('readinessPreviewWrite()');
  assert.equal(h.get('readiness-preview-btn').disabled, true);
  assert.match(h.get('readiness-body').innerHTML, /读取预览…/);
  release(reply(400, { error: '预览已过期，请重新读取' }));
  await pending;
  assert.equal(h.get('readiness-preview-btn').disabled, false);
  assert.match(h.get('readiness-body').innerHTML, /写入预览失败：预览已过期/);
  assert.equal(h.document.activeElement.id, 'readiness-write-error', '失败原因可获得键盘焦点');
  assert.equal(h.get('readiness-apply-btn').disabled, true, '预览失败时不能写入');
});

test('撤销被账本冲突阻断：不签发令牌时说明原因，不显示成接口故障', async () => {
  const h = await harness();
  h.fetchStub(async (url) => {
    if (url === '/api/onboarding/claude') return reply(200, { app: 'claude', binary: { name: 'claude', found: true, executable: true, path: '/usr/local/bin/claude' }, config: { path: '~/.claude/settings.json', status: 'ok' } });
    if (url === '/api/onboarding/claude/undo-preview') return reply(200, {
      ok: true, can_undo: false, token: null,
      changes: [{ field: 'ANTHROPIC_BASE_URL', current: 'https://hand-edited.example', restore: 'https://old.example' }],
      conflicts: [{ field: 'ANTHROPIC_BASE_URL', current: 'https://hand-edited.example', expected: 'http://127.0.0.1:8787' }],
    });
    if (url === '/api/state') return reply(200, fixture());
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  await h.run('readinessUndoPreview()');
  const body = h.get('readiness-body').innerHTML;
  assert.match(body, /撤销已阻断/);
  assert.match(body, /冲突（受管字段已不是写入后的值）/);
  assert.match(body, /hand-edited\.example/);
  assert.ok(!body.includes('撤销预览失败'), '账本冲突不是接口失败，不能显示成读取错误');
  assert.equal(h.get('readiness-undo-confirm').disabled, true);
  assert.equal(h.get('readiness-undo-btn').disabled, true);
});

test('没有可撤销记录时显示服务端原因，而不是伪造一份空预览', async () => {
  const h = await harness();
  h.fetchStub(async (url) => {
    if (url === '/api/onboarding/claude') return reply(200, { app: 'claude', binary: { found: true, executable: true, path: '/usr/local/bin/claude' }, config: { path: '~/.claude/settings.json', status: 'ok' } });
    if (url === '/api/onboarding/claude/undo-preview') return reply(404, { error: '没有可撤销的接入记录' });
    if (url === '/api/state') return reply(200, fixture());
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  await h.run('readinessUndoPreview()');
  assert.match(h.get('readiness-body').innerHTML, /撤销预览失败：没有可撤销的接入记录/);
  assert.equal(h.get('readiness-undo-btn').disabled, true);
});

test('离线时向导与报告入口不发请求，也不把离线说成未配置', async () => {
  const h = await harness();
  // 模拟 /api/state 失败后的离线状态:app.js 的 setConnection(false) 会写 online。
  h.fetchStub(async () => { throw new Error('offline'); });
  await h.run('refresh()');
  await flush();
  assert.equal(h.run('online'), false);
  await h.run('readinessOpen()');
  const body = h.get('readiness-body').innerHTML;
  assert.match(body, /控制台离线：向导不会读取或写入客户端配置/);
  assert.equal(h.get('readiness-preview-btn').disabled, true);
  assert.equal(h.get('readiness-test-btn').disabled, true);
  assert.equal(h.get('readiness-report-preview').disabled, true);
  assert.match(h.get('readiness-report-preview').textContent, /离线，无法读取/);
  assert.equal(h.requests.some(r => r.url.startsWith('/api/onboarding')), false, '离线时连检查都不发');
  assert.equal(h.requests.some(r => r.url === '/api/diagnostics/report'), false);
  // 恢复连接后入口与报告按钮要自己回来:只在挂载时算一次会让首帧的离线状态永久粘住。
  h.fetchStub(async (url) => (url === '/api/state' ? reply(200, fixture()) : reply(200, { ok: true })));
  await h.run('refresh()');
  await flush();
  assert.equal(h.run('online'), true);
  assert.equal(h.get('readiness-report-preview').disabled, false);
  assert.equal(h.get('readiness-preview-btn').disabled, false);
});

test('ZCode 写入后的提示要求用户去模型选择器选 Mixrouter，不声称自动切换会话', async () => {
  const h = await harness();
  h.fetchStub(async (url) => {
    if (url === '/api/onboarding/zcode') return reply(200, { app: 'zcode', binary: { found: true, executable: true, path: '/usr/local/bin/zcode' }, config: { path: '~/.zcode/v2/config.json', status: 'missing' } });
    if (url === '/api/onboarding/zcode/preview') return reply(200, { token: 'tz', changes: [{ field: 'provider.mixrouter-managed.model', after: 'gpt-test' }], warnings: [] });
    if (url === '/api/onboarding/zcode/apply') return reply(200, { ok: true, changed: [{ field: 'provider.mixrouter-managed.model', after: 'gpt-test' }], ledger_saved: true, warnings: [] });
    if (url === '/api/state') return reply(200, fixture());
    return reply(200, { ok: true });
  });
  await h.run('readinessOpen()');
  h.run("readinessPickClient('zcode')");
  await flush();
  h.run("readinessPickWire('responses')");
  h.run("readinessSetModel('gpt-test')");
  await h.run('readinessPreviewWrite()');
  h.get('readiness-write-confirm').checked = true;
  h.run('readinessSyncButtons()');
  await h.run('readinessApplyWrite()');
  const body = h.get('readiness-body').innerHTML;
  assert.match(body, /模型选择器里选择 Mixrouter/);
  assert.match(body, /不会切换你正在用的会话/);
  assert.match(body, /Mixrouter · gpt-test/);
});

test('首帧没拿到状态快照时说「正在读取」，不谎称离线', async () => {
  const h = await harness();
  h.run("lastSync = null; setConnection(false, '尚未读取')");
  await h.run('readinessOpen()');
  assert.match(h.get('readiness-body').innerHTML, /正在读取控制台状态：拿到第一份状态快照前不做任何判断/);
  assert.doesNotMatch(h.get('readiness-body').innerHTML, /控制台离线：向导不会读取/);
  assert.match(h.run("document.getElementById('readiness-entry-status').textContent"), /正在读取控制台状态/);
  // 连过一次再断线，才明确说离线。
  h.run("lastSync = new Date(); setConnection(false, '连接中断')");
  await h.run('readinessRender()');
  assert.match(h.get('readiness-body').innerHTML, /控制台离线：向导不会读取/);
});

test('诊断报告挂载时不读取，预览与下载都只在点击后发生', async () => {
  const h = await harness();
  h.fetchStub(async (url) => {
    if (url === '/api/diagnostics/report') return reply(200, { version: 'test', uptime_s: 10, requests: { ok: 3, err: 1 }, errors: { rate_limit: 1 } });
    if (url === '/api/state') return reply(200, fixture());
    return reply(200, { ok: true });
  });
  assert.equal(h.find('/api/diagnostics/report').length, 0, '进入诊断页前不自动读取报告');
  assert.equal(h.get('readiness-report-download').disabled, true);
  await h.run('readinessReportPreview()');
  assert.equal(h.find('/api/diagnostics/report').length, 1);
  const out = h.get('readiness-report-output');
  assert.equal(out.hidden, false);
  assert.match(out.textContent, /"version": "test"/);
  assert.equal(h.get('readiness-report-download').disabled, false);
  h.run('readinessReportDownload()');
  assert.equal(h.context.__blobUrls, 1);
  assert.equal(h.anchors.length, 1);
  assert.match(h.anchors[0].download, /^mixrouter-diagnostics-.*\.json$/);
  assert.equal(h.requests.some(r => r.method === 'POST'), false, '报告预览与下载不发送任何写请求');
});
