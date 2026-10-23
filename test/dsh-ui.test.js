'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../public/js/dsh.js'), 'utf8');
const script = new vm.Script(source, { filename: 'public/js/dsh.js' });
const plain = value => JSON.parse(JSON.stringify(value));
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) });
function fixture() {
  return {
    version: 1, revision: 'rev-1',
    slots: { main: { provider: 'chat1', model: 'deepseek-main', upstream_stream: false }, worker: { provider: 'resp1', model: 'deepseek-worker' } },
    default_subagent: 'worker',
    providers: [
      { id: 'chat1', name: 'Chat channel', models: ['deepseek-main', 'deepseek-other'], wire_api: 'chat', enabled: true },
      { id: 'resp1', name: 'Responses channel', model: 'deepseek-worker', wire_api: 'responses', enabled: true },
      { id: 'anthropic1', name: 'Messages only', models: ['not-for-dsh'], wire_api: 'anthropic', enabled: true },
      { id: 'off1', name: 'Disabled channel', model: 'off-model', wire_api: 'chat', enabled: false },
    ],
    client: { installed: true, status: 'ok', routed: true, config_path: '/mock/harness/config.json', model: 'mixr-dsh-main', restart_required: true },
  };
}
function harness(initialView = 'overview', data = fixture()) {
  let server = structuredClone(data);
  const elements = new Map();
  const requests = [];
  const confirms = [];
  const toasts = [];
  let responseStub = null;
  let confirmation = true;
  let context;
  class Element {
    constructor(id, tag) {
      this.id = id; this.tagName = String(tag).toUpperCase(); this.value = ''; this.hidden = false;
      this.disabled = false; this.style = {}; this.className = ''; this.textContent = ''; this.children = [];
      this.focused = false; this.selectedText = false;
      this._html = ''; this._owned = [];
    }
    set innerHTML(text) {
      this._owned.forEach(id => elements.delete(id)); this._owned = []; this.children = [];
      this._html = String(text);
      for (const match of this._html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
        const child = new Element(match[2], match[1]);
        child.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
        child.selected = /\bselected\b/.test(match[0]);
        child.disabled = /\bdisabled\b/.test(match[0]);
        child.inlineInput = match[0].match(/\boninput="([^"]*)"/)?.[1];
        child.inlineChange = match[0].match(/\bonchange="([^"]*)"/)?.[1];
        child.inlineClick = match[0].match(/\bonclick="([^"]*)"/)?.[1];
        child.open = /\bopen\b/.test(match[0]);
        this.children.push(child); this._owned.push(child.id); elements.set(child.id, child);
      }
    }
    get innerHTML() { return this._html; }
    querySelectorAll(selector) { return this.children.filter(node => selector.split(',').includes(node.tagName.toLowerCase())); }
    focus() { context.document.activeElement = this; this.focused = true; }
    select() { this.selectedText = true; }
  }
  for (const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const node = new Element(match[2], match[1]);
    node.hidden = /\bhidden\b/.test(match[0]);
    node.disabled = /\bdisabled\b/.test(match[0]);
    elements.set(node.id, node);
  }
  context = vm.createContext({
    document: { readyState: 'loading', body: { dataset: { connection: 'online' } }, getElementById: id => elements.get(id) || null, addEventListener() {} },
    console, AbortController, setTimeout() { return 1; }, clearTimeout() {},
    fetch: async (url, options = {}) => {
      const req = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
      requests.push(req);
      if (responseStub) return responseStub(req);
      if (req.method === 'PUT') {
        server = { ...server, slots: structuredClone(req.body.slots), default_subagent: req.body.default_subagent, revision: 'rev-2' };
      }
      if (url === '/api/dsh/sync') return reply(200, { ok: true, client: server.client });
      return reply(200, server);
    },
    __confirm: async (...args) => { confirms.push(args); return typeof confirmation === 'function' ? confirmation() : confirmation; },
    __toast: (...args) => toasts.push(args),
  });
  context.window = context;
  vm.runInContext(`let view = ${JSON.stringify(initialView)}; let online = true;
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    function askConfirm(...args) { return __confirm(...args); }
    function toast(...args) { __toast(...args); }`, context);
  script.runInContext(context);
  const run = code => vm.runInContext(code, context);
  const get = id => { assert.ok(elements.has(id), 'Unknown DOM id: ' + id); return elements.get(id); };
  const input = (id, value, kind = 'input') => {
    const node = get(id); node.value = value;
    const inline = kind === 'change' ? node.inlineChange : node.inlineInput;
    assert.ok(inline, id + ' has real inline event');
    const decoded = inline.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    context.__eventTarget = node;
    return run(`(function(){${decoded}}).call(__eventTarget)`);
  };
  return {
    run, get, input, requests, confirms, toasts,
    ui: () => plain(run('dshUiState()')),
    update: next => { server = structuredClone(next); },
    stub: fn => { responseStub = fn; },
    confirm: value => { confirmation = value; },
    writes: () => requests.filter(r => r.method !== 'GET'),
    async load() { run("view = 'dsh'"); await run('dshRefresh()'); },
  };
}

test('independent sidebar/view and classic assets use the existing shell', () => {
  assert.match(html, /href="#dsh" data-view="dsh" id="dsh"/);
  assert.match(html, /id="view-dsh" style="display:none"/);
  assert.match(html, /<link rel="stylesheet" href="\/styles\/dsh\.css">/);
  assert.match(html, /<script src="\/js\/dsh\.js"><\/script>/);
  const workspace = fs.readFileSync(path.join(__dirname, '../public/js/workspace.js'), 'utf8');
  assert.match(workspace, /const VIEWS = \[[^\n]*'dsh'/);
  assert.match(workspace, /dsh: 'DeepSeek Harness'/);
  assert.doesNotMatch(workspace.match(/const APPS = [^\n]+/)[0], /dsh/);
  assert.doesNotMatch(source, /\/api\/(?:slots|state|onboarding|providers)/, 'no other-client endpoint fallback');
});

test('refresh only reads the DSH view; force can explicitly request it', async () => {
  const h = harness();
  await h.run('dshRefresh()'); assert.equal(h.requests.length, 0);
  await h.run('dshRefresh(true)'); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/api/dsh');
  assert.equal(h.get('dsh-save').disabled, true, 'unchanged snapshot is not an editable dirty draft');
  assert.equal(h.get('dsh-sync').disabled, false);
});

test('save sends the complete draft, custom model and explicit non-stream false without confirm', async () => {
  const h = harness(); await h.load();
  assert.equal(h.get('dsh-slot-0-stream').value, 'false');
  h.input('dsh-slot-0-model', 'free/custom-model');
  h.input('dsh-slot-1-stream', 'false', 'change');
  await h.run('dshSave()');
  assert.deepEqual(h.writes(), [{ url: '/api/dsh', method: 'PUT', body: {
    expected_revision: 'rev-1',
    slots: { main: { provider: 'chat1', model: 'free/custom-model', upstream_stream: false }, worker: { provider: 'resp1', model: 'deepseek-worker', upstream_stream: false } },
    default_subagent: 'worker',
  } }]);
  assert.equal(h.confirms.length, 0);
  assert.equal(h.ui().dirty, false);
  assert.equal(h.ui().revision, 'rev-2');
  assert.match(h.get('dsh-outcome').textContent, /未安装或重启/);
});

test('inherit removes upstream_stream while true is retained as a boolean', async () => {
  const h = harness(); await h.load();
  h.input('dsh-slot-0-stream', 'inherit', 'change');
  h.input('dsh-slot-1-stream', 'true', 'change');
  await h.run('dshSave()');
  const slots = h.writes()[0].body.slots;
  assert.equal(Object.hasOwn(slots.main, 'upstream_stream'), false);
  assert.equal(slots.worker.upstream_stream, true);
});

test('dirty refresh preserves all edits and their original expected revision, even with force', async () => {
  const h = harness(); await h.load();
  h.input('dsh-slot-0-model', 'edited-main');
  const next = fixture(); next.revision = 'rev-external'; next.slots.main.model = 'remote-main'; next.client.model = 'remote-client';
  h.update(next);
  await h.run('dshRefresh(true)');
  assert.equal(h.ui().draft.slots.main.model, 'edited-main');
  assert.equal(h.get('dsh-slot-0-model').value, 'edited-main');
  assert.equal(h.ui().revision, 'rev-1');
  assert.match(h.get('dsh-client').innerHTML, /remote-client/);
  await h.run('dshSave()');
  assert.equal(h.writes()[0].body.expected_revision, 'rev-1', 'must not silently advance optimistic-lock version');
});

test('an edit made while refresh is in flight is not overwritten', async () => {
  const h = harness(); await h.load();
  let release;
  h.stub(() => new Promise(resolve => { release = resolve; }));
  const pending = h.run('dshRefresh()');
  h.input('dsh-slot-1-model', 'mid-flight-edit');
  const next = fixture(); next.revision = 'remote-2';
  release(reply(200, next)); await pending;
  assert.equal(h.ui().draft.slots.worker.model, 'mid-flight-edit');
  assert.equal(h.ui().revision, 'rev-1');
});

test('404 with a descriptive JSON message disables the view without falling back', async () => {
  const h = harness();
  h.stub(() => reply(404, { error: 'Not found' }));
  await h.load();
  assert.equal(h.ui().unsupported, true);
  assert.equal(h.get('dsh-editor').hidden, true);
  assert.equal(h.get('dsh-unsupported').hidden, false);
  assert.equal(h.get('dsh-save').disabled, true);
  assert.equal(h.get('dsh-sync').disabled, true);
  await h.run('dshRefresh(); dshSave(); dshSync()');
  assert.equal(h.requests.length, 1, 'does not keep polling an unsupported feature');
  assert.equal(h.requests[0].url, '/api/dsh');
});

test('other errors do not claim unsupported; version conflict keeps draft and revision', async () => {
  const h = harness(); await h.load();
  h.input('dsh-slot-0-model', 'unsaved');
  h.stub(() => reply(409, { error: 'revision_changed' }));
  await h.run('dshSave()');
  assert.equal(h.ui().unsupported, false);
  assert.equal(h.ui().dirty, true);
  assert.equal(h.ui().draft.slots.main.model, 'unsaved');
  assert.equal(h.ui().revision, 'rev-1');
  assert.match(h.get('dsh-status').textContent, /版本冲突/);
});

test('all four subslots stay visible and models offer provider choices plus custom input', async () => {
  const data = fixture();
  data.slots['worker-2'] = { provider: 'chat1', model: 'deepseek-main' };
  data.slots['worker-3'] = { provider: 'resp1', model: 'deepseek-worker' };
  data.slots['worker-4'] = { provider: 'chat1', model: 'deepseek-other' };
  const h = harness('overview', data); await h.load();
  const rows = h.get('dsh-slots').innerHTML;
  assert.doesNotMatch(rows, /dsh-subslots|<details/);
  assert.equal((rows.match(/class="dsh-slot"/g) || []).length, 5, 'main plus four configured subslots render at once');
  assert.match(rows, /dsh-slot-0-model-choice/);
  assert.match(rows, /<option value="0" selected>deepseek-main<\/option>/);
  assert.match(rows, /<option value="custom">自定义模型…<\/option>/);
  assert.match(rows, /dsh-slot-1-model-choice/);
  assert.match(rows, /<option value="0" selected>deepseek-worker<\/option>/);
  assert.match(rows, /value="off1" disabled/);
  assert.doesNotMatch(rows, /Messages only|not-for-dsh/);
  h.run("dshChooseModel('main','1')");
  assert.equal(h.ui().draft.slots.main.model, 'deepseek-other');
  assert.equal(h.get('dsh-slot-0-model').value, 'deepseek-other');
  h.run("dshChooseModel('main','custom')");
  assert.equal(h.get('dsh-slot-0-model').focused, true);
});

test('new subagent names are validated, cannot reuse main or duplicate worker, and aliases stay distinct', async () => {
  const h = harness(); await h.load();
  for (const name of ['main', 'worker', 'constructor', 'prototype', '__proto__', '-bad', 'Bad', 'with_space', 'a'.repeat(25)]) {
    h.get('dsh-new-name').value = name;
    assert.equal(h.run('dshAddSlot()'), false, name);
  }
  h.get('dsh-new-name').value = 'reviewer-2'; assert.equal(h.run('dshAddSlot()'), true);
  assert.match(h.get('dsh-slots').innerHTML, /mixr-dsh-reviewer-2/);
  assert.equal(h.get('dsh-sync').disabled, true);
  assert.doesNotMatch(h.get('dsh-default-subagent').innerHTML, /reviewer-2/, 'unconfigured new slot cannot become default');
  h.input('dsh-slot-2-provider', 'resp1', 'change');
  h.input('dsh-slot-2-model', 'review/custom');
  h.run("dshSetDefault('reviewer-2')");
  await h.run('dshSave()');
  assert.equal(h.writes()[0].body.default_subagent, 'reviewer-2');
  assert.deepEqual(h.writes()[0].body.slots['reviewer-2'], { provider: 'resp1', model: 'review/custom' });
});

test('main cannot be deleted, subslot deletion is confirmed and clears a removed default', async () => {
  const h = harness(); await h.load();
  await h.run("dshDeleteSlot('main')"); assert.equal(h.confirms.length, 0);
  h.confirm(false); await h.run("dshDeleteSlot('worker')");
  assert.equal(Object.hasOwn(h.ui().draft.slots, 'worker'), true);
  h.confirm(true); await h.run("dshDeleteSlot('worker')");
  assert.equal(Object.hasOwn(h.ui().draft.slots, 'main'), true);
  assert.equal(Object.hasOwn(h.ui().draft.slots, 'worker'), false);
  assert.equal(h.ui().draft.default_subagent, '');
  assert.equal(h.writes().length, 0, 'delete only changes draft, no immediate API write');
  await h.run('dshSave()');
  assert.equal(h.writes().length, 1, 'empty default follows main after deleting default subslot');
  assert.deepEqual(Object.keys(h.writes()[0].body.slots), ['main']);
  assert.equal(h.writes()[0].body.default_subagent, '');
});

test('sync requires confirm and saved revision, never sends draft edits or promises hot-session changes', async () => {
  const h = harness(); await h.load();
  h.confirm(false); await h.run('dshSync()'); assert.equal(h.writes().length, 0);
  h.input('dsh-slot-0-model', 'saved-model');
  h.confirm(true); await h.run('dshSync()'); assert.equal(h.writes().length, 0, 'dirty draft cannot sync');
  await h.run('dshSave()');
  await h.run('dshSync()');
  assert.deepEqual(h.writes()[1], { url: '/api/dsh/sync', method: 'POST', body: { confirm: true, expected_revision: 'rev-2' } });
  assert.match(h.confirms.at(-1)[1], /自有 profile 字段/);
  assert.match(h.get('dsh-outcome').textContent, /重启 Harness 后新建会话/);
  assert.match(h.get('dsh-outcome').textContent, /正在运行的会话不会自动切换/);
});

test('confirmation locks edits until sync response arrives', async () => {
  const h = harness(); await h.load();
  let release;
  h.confirm(() => new Promise(resolve => { release = resolve; }));
  const sync = h.run('dshSync()');
  assert.equal(h.get('dsh-save').disabled, true);
  h.run("dshSetSlot('main','model','cannot-change')");
  await h.run('dshRefresh(true)');
  assert.equal(h.requests.length, 1, 'refresh does not race a confirmation');
  assert.equal(h.ui().draft.slots.main.model, 'deepseek-main');
  release(true); await sync;
  assert.equal(h.writes()[0].body.expected_revision, 'rev-1');
});

test('not installed and offline states never automatically install or synchronize', async () => {
  const data = fixture(); data.client.installed = false;
  const h = harness('overview', data); await h.load();
  assert.equal(h.get('dsh-sync').disabled, true);
  await h.run('dshSync()'); assert.equal(h.confirms.length, 0); assert.equal(h.writes().length, 0);
  h.input('dsh-slot-0-model', 'offline-draft');
  h.run('online = false');
  await h.run('dshRefresh(true); dshSave(); dshSync()');
  assert.equal(h.requests.length, 1);
  assert.equal(h.ui().draft.slots.main.model, 'offline-draft');
  assert.equal(h.get('dsh-save').disabled, true);
});

test('reload confirms dirty discard and failed reload retains original draft', async () => {
  const h = harness(); await h.load();
  h.input('dsh-slot-0-model', 'keep-on-error');
  h.confirm(false); await h.run('dshReload()'); assert.equal(h.requests.length, 1);
  h.confirm(true); h.stub(() => reply(500, { error: 'cannot read' }));
  await h.run('dshReload()');
  assert.equal(h.ui().dirty, true);
  assert.equal(h.ui().draft.slots.main.model, 'keep-on-error');
  h.stub(null); await h.run('dshReload()');
  assert.equal(h.ui().dirty, false);
  assert.equal(h.get('dsh-slot-0-model').value, 'deepseek-main');
});

test('unchanged refresh does not rebuild model inputs and untrusted text is HTML-escaped', async () => {
  const data = fixture(); data.providers[0].name = '<script>alert(1)</script>'; data.client.config_path = '<secret>';
  const h = harness('overview', data); await h.load();
  const input = h.get('dsh-slot-0-model');
  await h.run('dshRefresh()');
  assert.equal(h.get('dsh-slot-0-model'), input);
  assert.match(h.get('dsh-slots').innerHTML, /&lt;script&gt;/);
  assert.match(h.get('dsh-client').innerHTML, /&lt;secret&gt;/);
  assert.doesNotMatch(h.get('dsh-slots').innerHTML, /<script>/);
});

test('initial empty slots show main plus four available subslot rows', async () => {
  const data = fixture(); data.slots = {}; data.default_subagent = '';
  const h = harness('overview', data); await h.load();
  assert.deepEqual(h.ui().draft, { slots: { main: { provider: '', model: '' } }, default_subagent: '' });
  assert.equal(h.ui().dirty, true);
  assert.equal(h.get('dsh-editor').hidden, false);
  assert.match(h.get('dsh-default-subagent').innerHTML, /跟随主模型/);
  assert.equal(h.get('dsh-sync').disabled, true);
  assert.equal((h.get('dsh-slots').innerHTML.match(/class="dsh-slot"/g) || []).length, 1, 'blank subslots are added explicitly, not persisted as empty configurations');
  assert.match(h.get('dsh-slots').innerHTML, /主模型 · main/);
  h.input('dsh-slot-0-provider', 'chat1', 'change');
  h.input('dsh-slot-0-model', 'new-main');
  await h.run('dshSave()');
  assert.deepEqual(h.writes()[0].body, { expected_revision: 'rev-1', slots: { main: { provider: 'chat1', model: 'new-main' } }, default_subagent: '' });
});

test('top-level DSH parse errors fail closed and retain previously edited draft', async () => {
  const h = harness(); await h.load();
  h.input('dsh-slot-0-model', 'keep-draft');
  const data = fixture(); data.error = 'dsh.json invalid structure'; data.slots = {}; h.update(data);
  await h.run('dshRefresh(true)');
  assert.equal(h.ui().configError, 'dsh.json invalid structure');
  assert.equal(h.ui().draft.slots.main.model, 'keep-draft');
  assert.equal(h.get('dsh-save').disabled, true);
  assert.equal(h.get('dsh-sync').disabled, true);
  await h.run("dshSetSlot('main','model','blocked'); dshSave(); dshSync()");
  assert.equal(h.ui().draft.slots.main.model, 'keep-draft');
  assert.equal(h.writes().length, 0);
  h.update(fixture()); await h.run('dshRefresh(true)');
  assert.equal(h.ui().configError, ''); assert.equal(h.get('dsh-save').disabled, false);
});

test('client profile conflict blocks sync but not slot save; out_of_sync allows sync', async () => {
  const data = fixture(); data.client.status = 'conflict';
  const h = harness('overview', data); await h.load();
  assert.equal(h.get('dsh-sync').disabled, true);
  assert.match(h.get('dsh-client').innerHTML, /同步已停用/);
  await h.run('dshSync()'); assert.equal(h.confirms.length, 0);
  h.input('dsh-slot-0-model', 'can-save'); await h.run('dshSave()');
  assert.equal(h.writes().length, 1);
  const next = fixture(); next.client.status = 'out_of_sync'; h.update(next);
  await h.run('dshRefresh(true)');
  assert.equal(h.get('dsh-sync').disabled, false);
});

test('provider changes refresh model choices without replacing a dirty custom input', async () => {
  const h = harness(); await h.load();
  h.input('dsh-slot-0-model', 'dirty-model');
  const input = h.get('dsh-slot-0-model');
  const data = fixture(); data.providers[0].models = ['new-remote-model']; h.update(data);
  await h.run('dshRefresh()');
  assert.equal(h.get('dsh-slot-0-model'), input);
  assert.match(h.get('dsh-slot-0-model-choice').innerHTML, /new-remote-model/);
  assert.equal(h.get('dsh-slot-0-model-choice').value, 'custom');
  assert.equal(h.ui().draft.slots.main.model, 'dirty-model');
});

test('slot count is capped at 32 in add and save validation', async () => {
  const data = fixture();
  for (let i = 0; i < 30; i += 1) data.slots['slot-' + i] = { provider: 'chat1', model: 'm' };
  const h = harness('overview', data); await h.load();
  h.get('dsh-new-name').value = 'overflow';
  assert.equal(h.run('dshAddSlot()'), false);
  assert.match(h.get('dsh-status').textContent, /最多配置 32 个槽位/);
  data.slots.overflow = { provider: 'chat1', model: 'm' }; h.update(data);
  await h.run('dshRefresh(true)');
  h.input('dsh-slot-0-model', 'edited'); await h.run('dshSave()');
  assert.equal(h.writes().length, 0);
  assert.match(h.get('dsh-status').textContent, /最多配置 32 个槽位/);
});

test('reserved slot names in a server snapshot cannot be saved', async () => {
  const data = fixture(); data.slots.constructor = { provider: 'chat1', model: 'm' };
  const h = harness('overview', data); await h.load();
  h.input('dsh-slot-0-model', 'edited'); await h.run('dshSave()');
  assert.equal(h.writes().length, 0);
  assert.match(h.get('dsh-status').textContent, /constructor.*保留名称/);
});

test('public state getter works before loading and after save without leaking internal bindings', async () => {
  const h = harness(); assert.equal(h.ui().draft, null);
  await h.load(); h.input('dsh-slot-0-model', 'getter-model'); await h.run('dshSave()');
  assert.equal(h.ui().draft.slots.main.model, 'getter-model');
  assert.equal(h.ui().dirty, false);
  assert.doesNotThrow(() => h.run('dshUiState()'));
});
