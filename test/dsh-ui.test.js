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
    api_version: 2, supported_config_versions: [1, 2], version: 2, source_version: 2, migration_required: false, revision: 'rev-1',
    slots: { main: { provider: 'chat1', model: 'deepseek-main', upstream_stream: false }, worker: { provider: 'resp1', model: 'deepseek-worker' } },
    subagents: { owner: 'mixrouter', allow_model_selection: true, allowed_slots: ['worker'], default: { mode: 'slot', slot: 'worker' } },
    providers: [
      { id: 'chat1', name: 'Chat channel', models: ['deepseek-main', 'deepseek-other'], wire_api: 'chat', enabled: true },
      { id: 'resp1', name: 'Responses channel', model: 'deepseek-worker', wire_api: 'responses', enabled: true },
      { id: 'anthropic1', name: 'Messages only', models: ['not-for-dsh'], wire_api: 'anthropic', enabled: true },
      { id: 'off1', name: 'Disabled channel', model: 'off-model', wire_api: 'chat', enabled: false },
    ],
    client: { installed: true, status: 'configured', routed: true, provider_registered: true, sync_needed: false, policy_owner: 'mixrouter', config_path: '/mock/harness/config.json', model: 'mixr-dsh-main', restart_required: true, runtime_verified: false },
    observations: { scope: 'current_process_recent_requests', sample_count: 0, ok_count: 0, error_count: 0, cancelled_count: 0, last_request: null, recent: [], by_slot: [] },
    warnings: [],
  };
}
function v1Fixture(defaultSlot = 'worker') {
  const data = fixture(); data.version = 1; data.source_version = 1; data.migration_required = true;
  data.default_subagent = defaultSlot; delete data.subagents;
  return data;
}
function previewFixture(data = fixture()) {
  return { revision: data.revision, preview: {
    installed: data.client.installed, config_path: data.client.config_path, status: data.client.status,
    policy_owner: data.subagents?.owner || 'mixrouter', changed: true, sync_needed: true,
    affected_sections: ['llm-pi-ai', 'agent-default-model', 'subagent-model-selection-settings', 'subagent'],
    changes: { route_catalog: true, ownership: false, ordinary_subagent_policy: true, native_handoff: false }, released_sections: [],
    coverage: { ordinary_spawn: 'explicit_selection_and_configured_default', implicit_inheritance: 'outside_explicit_allowlist_check', fork: 'inherits_parent_model', team: 'inherits_parent_model', workflow: 'independent_creation_path', ds_bot: 'per_bot_model_settings', global_enforcement: false, runtime_adoption: 'unverified' },
    warnings: [], runtime_verified: false,
  } };
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
      this.disabled = false; this.checked = false; this.style = {}; this.className = ''; this.textContent = ''; this.children = [];
      this.focused = false; this.selectedText = false; this.attributes = {};
      this._html = ''; this._owned = [];
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    set innerHTML(text) {
      this._owned.forEach(id => elements.delete(id)); this._owned = []; this.children = [];
      this._html = String(text);
      for (const match of this._html.matchAll(/<([a-z][\w-]*)\b[^>]*>/gi)) {
        const id = match[0].match(/\bid="([^"]+)"/)?.[1] || '';
        const child = new Element(id, match[1]);
        child.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
        child.selected = /\bselected\b/.test(match[0]);
        child.disabled = /\bdisabled\b/.test(match[0]);
        child.hidden = /\bhidden\b/.test(match[0]);
        child.inlineInput = match[0].match(/\boninput="([^"]*)"/)?.[1];
        child.inlineChange = match[0].match(/\bonchange="([^"]*)"/)?.[1];
        child.inlineClick = match[0].match(/\bonclick="([^"]*)"/)?.[1];
        child.open = /\bopen\b/.test(match[0]);
        this.children.push(child);
        if (child.id) { this._owned.push(child.id); elements.set(child.id, child); }
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
    node.inlineInput = match[0].match(/\boninput="([^"]*)"/)?.[1];
    node.inlineChange = match[0].match(/\bonchange="([^"]*)"/)?.[1];
    node.inlineClick = match[0].match(/\bonclick="([^"]*)"/)?.[1];
    elements.set(node.id, node);
  }
  const presetButtons = [...html.match(/<div class="dsh-preset-buttons"[^>]*>([\s\S]*?)<\/div>/)[1].matchAll(/<button\b[^>]*>/g)].map(match => {
    const node = new Element('', 'button');
    node.inlineClick = match[0].match(/\bonclick="([^"]*)"/)?.[1];
    return node;
  });
  context = vm.createContext({
    document: { readyState: 'loading', body: { dataset: { connection: 'online' } }, getElementById: id => elements.get(id) || null, querySelectorAll: selector => selector === '.dsh-preset-buttons button' ? presetButtons : [], addEventListener() {} },
    console, AbortController, setTimeout() { return 1; }, clearTimeout() {},
    fetch: async (url, options = {}) => {
      const req = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
      requests.push(req);
      if (responseStub) return responseStub(req);
      if (req.method === 'PUT') {
        server = { ...server, api_version: 2, version: req.body.version, source_version: 2, migration_required: false, slots: structuredClone(req.body.slots), subagents: structuredClone(req.body.subagents), revision: 'rev-2' };
        delete server.default_subagent;
      }
      if (url === '/api/dsh/preview') return reply(200, previewFixture(server));
      if (url === '/api/dsh/sync') return reply(200, { ok: true, client: server.client, revision: server.revision });
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
    const node = get(id); if (typeof value === 'boolean') node.checked = value; else node.value = value;
    const inline = kind === 'change' ? node.inlineChange : node.inlineInput;
    assert.ok(inline, id + ' has real inline event');
    const decoded = inline.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    context.__eventTarget = node;
    return run(`(function(){${decoded}}).call(__eventTarget)`);
  };
  const click = id => {
    const node = get(id);
    if (node.disabled) return false;
    assert.ok(node.inlineClick, id + ' has real inline click');
    return run(node.inlineClick);
  };
  return {
    run, get, input, click, requests, confirms, toasts, presetButtons,
    remove: id => elements.delete(id),
    rows: () => get('dsh-main-slot').innerHTML + get('dsh-slots').innerHTML,
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
    version: 2, subagents: fixture().subagents,
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

test('main is separate and all four task models stay visible with provider choices plus custom input', async () => {
  const data = fixture();
  data.slots['worker-2'] = { provider: 'chat1', model: 'deepseek-main' };
  data.slots['worker-3'] = { provider: 'resp1', model: 'deepseek-worker' };
  data.slots['worker-4'] = { provider: 'chat1', model: 'deepseek-other' };
  const h = harness('overview', data); await h.load();
  const rows = h.rows();
  assert.doesNotMatch(rows, /dsh-subslots/, 'model rows are never hidden in a subslot disclosure');
  assert.equal((rows.match(/<details class="dsh-capabilities"/g) || []).length, 5, 'only optional metadata is disclosed per model');
  assert.match(h.get('dsh-main-slot').innerHTML, /class="dsh-slot dsh-main-slot"/);
  assert.equal((h.get('dsh-slots').innerHTML.match(/class="dsh-slot dsh-task-slot"/g) || []).length, 4, 'all configured task models render together');
  assert.doesNotMatch(h.get('dsh-slots').innerHTML, /dsh-slot-0-provider/, 'main controls belong only to the main container');
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

test('new route names are validated, cannot reuse main or duplicate worker, and aliases stay distinct', async () => {
  const h = harness(); await h.load();
  for (const name of ['main', 'worker', 'constructor', 'prototype', '__proto__', '-bad', 'Bad', 'with_space', 'a'.repeat(25)]) {
    h.get('dsh-new-name').value = name;
    assert.equal(h.run('dshAddSlot()'), false, name);
  }
  h.get('dsh-new-name').value = 'reviewer-2'; assert.equal(h.run('dshAddSlot()'), true);
  assert.match(h.get('dsh-slot-2-candidate').inlineChange, /reviewer-2/);
  assert.equal(h.get('dsh-sync').disabled, true);
  assert.doesNotMatch(h.get('dsh-default-subagent').innerHTML, /reviewer-2/, 'unconfigured new slot cannot become default');
  h.input('dsh-slot-2-provider', 'resp1', 'change');
  h.input('dsh-slot-2-model', 'review/custom');
  h.run("dshSetDefault('reviewer-2')");
  assert.equal(await h.run('dshSave()'), false, 'new defaults require explicit candidate selection, never auto-add');
  h.run("dshToggleCandidate('reviewer-2',true)");
  await h.run('dshSave()');
  assert.deepEqual(h.writes()[0].body.subagents.default, { mode: 'slot', slot: 'reviewer-2' });
  assert.deepEqual(h.writes()[0].body.slots['reviewer-2'], { provider: 'resp1', model: 'review/custom' });
});

test('main cannot be deleted; route deletion is confirmed and leaves a removed fixed default visibly invalid', async () => {
  const h = harness(); await h.load();
  await h.run("dshDeleteSlot('main')"); assert.equal(h.confirms.length, 0);
  h.confirm(false); await h.run("dshDeleteSlot('worker')");
  assert.equal(Object.hasOwn(h.ui().draft.slots, 'worker'), true);
  h.confirm(true); await h.run("dshDeleteSlot('worker')");
  assert.equal(Object.hasOwn(h.ui().draft.slots, 'main'), true);
  assert.equal(Object.hasOwn(h.ui().draft.slots, 'worker'), false);
  assert.deepEqual(h.ui().draft.subagents.default, { mode: 'slot', slot: 'worker' }, 'no silent change to fixed main or inheritance');
  assert.deepEqual(h.ui().draft.subagents.allowed_slots, []);
  assert.equal(h.get('dsh-policy-error').hidden, false);
  assert.match(h.get('dsh-default-subagent').innerHTML, /worker（已删除或配置不完整）/);
  assert.equal(h.writes().length, 0, 'delete only changes draft, no immediate API write');
  assert.equal(await h.run('dshSave()'), false);
  h.run("dshSetPolicy('allow_model_selection',false); dshSetPolicy('default_mode','inherit')");
  await h.run('dshSave()');
  assert.equal(h.writes().length, 1, 'explicit inheritance can be saved after fixing the removed default');
  assert.deepEqual(Object.keys(h.writes()[0].body.slots), ['main']);
  assert.deepEqual(h.writes()[0].body.subagents.default, { mode: 'inherit' });
});

test('sync reads a preview before confirm and saved revision, never sends draft edits or promises hot-session changes', async () => {
  const h = harness(); await h.load();
  h.confirm(false); await h.run('dshSync()');
  assert.deepEqual(h.writes(), [{ url: '/api/dsh/preview', method: 'POST', body: { expected_revision: 'rev-1' } }], 'cancelled sync only makes a read-only preview request');
  h.input('dsh-slot-0-model', 'saved-model');
  h.confirm(true); await h.run('dshSync()'); assert.equal(h.writes().length, 1, 'dirty draft cannot sync or preview');
  await h.run('dshSave()');
  await h.run('dshSync()');
  assert.deepEqual(h.writes()[2], { url: '/api/dsh/preview', method: 'POST', body: { expected_revision: 'rev-2' } });
  assert.deepEqual(h.writes()[3], { url: '/api/dsh/sync', method: 'POST', body: { confirm: true, expected_revision: 'rev-2' } });
  assert.match(h.confirms.at(-1)[1], /自有 profile 字段/);
  assert.match(h.confirms.at(-1)[1], /影响字段：llm-pi-ai/);
  assert.match(h.get('dsh-outcome').textContent, /重启 Harness 后新建会话/);
  assert.match(h.get('dsh-outcome').textContent, /正在运行的会话不会自动切换/);
});

test('preview and confirmation lock edits until sync response arrives', async () => {
  const h = harness(); await h.load();
  let release, entered;
  const confirming = new Promise(resolve => { entered = resolve; });
  h.confirm(() => new Promise(resolve => { release = resolve; entered(); }));
  const sync = h.run('dshSync()');
  assert.equal(h.get('dsh-save').disabled, true);
  h.run("dshSetSlot('main','model','cannot-change')");
  await h.run('dshRefresh(true)');
  await confirming;
  assert.equal(h.requests.length, 2, 'only initial GET and read-only preview; refresh does not race confirmation');
  assert.equal(h.ui().draft.slots.main.model, 'deepseek-main');
  release(true); await sync;
  assert.equal(h.writes()[0].body.expected_revision, 'rev-1');
  assert.equal(h.writes()[1].body.expected_revision, 'rev-1');
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
  assert.match(h.rows(), /&lt;script&gt;/);
  assert.match(h.get('dsh-client').innerHTML, /&lt;secret&gt;/);
  assert.doesNotMatch(h.get('dsh-slots').innerHTML, /<script>/);
});

test('initial empty config starts Harness-owned with selection off, true inheritance and no candidates', async () => {
  const data = fixture(); data.slots = {}; data.source_version = null;
  data.subagents = { owner: 'harness', allow_model_selection: false, allowed_slots: [], default: { mode: 'inherit' } };
  const h = harness('overview', data); await h.load();
  assert.deepEqual(h.ui().draft, { version: 2, slots: { main: { provider: '', model: '' } }, subagents: data.subagents });
  assert.equal(h.ui().dirty, true);
  assert.equal(h.get('dsh-editor').hidden, false);
  assert.equal(h.get('dsh-default-mode').value, 'inherit');
  assert.equal(h.get('dsh-default-subagent').disabled, true);
  assert.equal(h.get('dsh-slot-0-candidate').checked, false);
  assert.equal(h.get('dsh-allow-model-selection').checked, false);
  assert.equal(h.get('dsh-sync').disabled, true);
  assert.equal(h.get('dsh-slots').innerHTML, '', 'blank task models are added explicitly, not persisted as empty configurations');
  assert.match(h.get('dsh-main-slot').innerHTML, /主模型/);
  h.input('dsh-slot-0-provider', 'chat1', 'change');
  h.input('dsh-slot-0-model', 'new-main');
  await h.run('dshSave()');
  assert.deepEqual(h.writes()[0].body, { version: 2, expected_revision: 'rev-1', slots: { main: { provider: 'chat1', model: 'new-main' } }, subagents: data.subagents });
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

test('save renders the authoritative response rather than the submitted draft', async () => {
  const h = harness(); await h.load();
  h.input('dsh-slot-0-model', '  normalized-main  ');
  const saved = fixture(); saved.revision = 'rev-saved'; saved.slots.main.model = 'normalized-main';
  h.stub(() => reply(200, { ok: true, ...saved }));
  assert.equal(await h.run('dshSave()'), true);
  assert.equal(h.ui().draft.slots.main.model, 'normalized-main', 'backend trims model names before saving');
  assert.equal(h.get('dsh-slot-0-model').value, 'normalized-main');
  assert.equal(h.ui().dirty, false);
  assert.match(h.get('dsh-outcome').textContent, /main（mixr-dsh-main）→ Chat channel \/ normalized-main \/ 非流式/);
  assert.match(h.get('dsh-outcome').textContent, /后续请求生效，无需同步或重启/);
  assert.match(h.get('dsh-outcome').textContent, /仅新增或删除别名、客户端默认模型与白名单变更需另点/);
  assert.doesNotMatch(h.get('dsh-outcome').textContent, /  normalized-main  /);
  await h.run('dshRefresh(true)');
  assert.equal(h.ui().dirty, false);
});

test('save reconciles provider, model and stream from one authoritative snapshot', async () => {
  const h = harness(); await h.load();
  h.input('dsh-slot-0-model', 'submitted-model');
  const saved = fixture(); saved.revision = 'rev-saved';
  saved.slots = {
    worker: { provider: 'chat1', model: 'deepseek-other', upstream_stream: false },
    main: { provider: 'resp1', model: 'deepseek-worker', upstream_stream: true },
  };
  h.stub(() => reply(200, { ok: true, ...saved }));
  await h.run('dshSave()');
  assert.deepEqual(h.ui().draft.slots, saved.slots);
  assert.equal(h.get('dsh-slot-0-provider').value, 'resp1');
  assert.equal(h.get('dsh-slot-0-model').value, 'deepseek-worker');
  assert.equal(h.get('dsh-slot-0-stream').value, 'true');
  assert.equal(h.get('dsh-slot-1-provider').value, 'chat1');
  assert.equal(h.get('dsh-slot-1-model').value, 'deepseek-other');
  assert.equal(h.get('dsh-slot-1-stream').value, 'false');
  assert.equal(h.ui().revision, 'rev-saved');
  assert.equal(h.get('dsh-save').disabled, true);
  assert.match(h.get('dsh-outcome').textContent, /main（mixr-dsh-main）→ Responses channel \/ deepseek-worker \/ 流式/);
});

test('a save response without saved slots cannot acknowledge the submitted draft', async () => {
  const h = harness(); await h.load();
  h.input('dsh-slot-0-provider', 'resp1', 'change');
  h.input('dsh-slot-0-model', 'deepseek-worker');
  h.input('dsh-slot-0-stream', 'true', 'change');
  h.stub(() => reply(200, { ok: true, revision: 'rev-unverified' }));
  assert.equal(await h.run('dshSave()'), false);
  assert.equal(h.ui().dirty, true);
  assert.equal(h.ui().revision, 'rev-1');
  assert.equal(h.get('dsh-outcome').hidden, true);
});

test('external slot reordering, insertion and deletion keep main and inline targets aligned', async () => {
  const h = harness(); await h.load();
  const next = fixture(); next.revision = 'rev-external';
  next.slots = {
    hebox: { provider: 'chat1', model: 'deepseek-other', upstream_stream: true },
    main: { provider: 'resp1', model: 'deepseek-worker', upstream_stream: false },
    worker: { provider: 'chat1', model: 'deepseek-main' },
  };
  h.update(next); await h.run('dshRefresh(true)');
  assert.equal(h.get('dsh-slot-0-provider').value, 'resp1');
  assert.equal(h.get('dsh-slot-0-model').value, 'deepseek-worker');
  assert.equal(h.get('dsh-slot-0-stream').value, 'false');
  h.input('dsh-slot-1-model', 'hebox-edit');
  h.input('dsh-slot-1-stream', 'false', 'change');
  assert.equal(h.ui().draft.slots.main.model, 'deepseek-worker');
  assert.deepEqual(h.ui().draft.slots.hebox, { provider: 'chat1', model: 'hebox-edit', upstream_stream: false });
  await h.run("dshDeleteSlot('hebox')");
  h.input('dsh-slot-1-provider', 'resp1', 'change');
  h.input('dsh-slot-1-model', 'worker-edit');
  h.input('dsh-slot-1-stream', 'true', 'change');
  await h.run('dshSave()');
  assert.deepEqual(h.writes()[0].body.slots, {
    main: { provider: 'resp1', model: 'deepseek-worker', upstream_stream: false },
    worker: { provider: 'resp1', model: 'worker-edit', upstream_stream: true },
  });
  assert.equal(h.writes()[0].body.expected_revision, 'rev-external');
});

test('external changes replace all three saved target fields and clear stale success', async () => {
  const h = harness(); await h.load();
  h.input('dsh-slot-0-model', 'saved-main'); await h.run('dshSave()');
  const next = fixture(); next.revision = 'rev-external';
  next.slots.main = { provider: 'resp1', model: 'deepseek-worker', upstream_stream: true };
  h.update(next); await h.run('dshRefresh(true)');
  assert.deepEqual(h.ui().draft.slots.main, next.slots.main);
  assert.equal(h.get('dsh-slot-0-provider').value, 'resp1');
  assert.equal(h.get('dsh-slot-0-model').value, 'deepseek-worker');
  assert.equal(h.get('dsh-slot-0-stream').value, 'true');
  assert.equal(h.ui().revision, 'rev-external');
  assert.equal(h.ui().dirty, false);
  assert.equal(h.get('dsh-outcome').hidden, true);
});

test('another window cannot move a dirty draft to a new slot revision or target', async () => {
  const h = harness(); await h.load();
  h.input('dsh-slot-0-provider', 'resp1', 'change');
  h.input('dsh-slot-0-model', 'deepseek-worker');
  h.input('dsh-slot-0-stream', 'true', 'change');
  const remote = fixture(); remote.revision = 'rev-other-window';
  remote.slots = {
    hebox: { provider: 'resp1', model: 'new-subslot', upstream_stream: false },
    main: { provider: 'chat1', model: 'remote-main' },
  };
  h.update(remote); await h.run('dshRefresh(true)');
  assert.deepEqual(h.ui().draft.slots.main, { provider: 'resp1', model: 'deepseek-worker', upstream_stream: true });
  assert.equal(h.ui().revision, 'rev-1');
  assert.equal(h.get('dsh-slot-0-provider').value, 'resp1');
  assert.equal(h.get('dsh-slot-0-model').value, 'deepseek-worker');
  assert.equal(h.get('dsh-slot-0-stream').value, 'true');
  h.stub(() => reply(409, { error: 'revision_changed' }));
  assert.equal(await h.run('dshSave()'), false);
  assert.equal(h.writes()[0].body.expected_revision, 'rev-1');
  assert.equal(h.ui().dirty, true);
  assert.equal(h.get('dsh-sync').disabled, true);
  assert.match(h.get('dsh-status').textContent, /版本冲突/);
});

test('successful reload retains newer in-flight edits and their original lock revision', async () => {
  const h = harness(); await h.load();
  let release;
  h.stub(() => new Promise(resolve => { release = resolve; }));
  const pending = h.run('dshReload()');
  h.input('dsh-slot-0-provider', 'resp1', 'change');
  h.input('dsh-slot-0-model', 'deepseek-worker');
  h.input('dsh-slot-0-stream', 'true', 'change');
  const next = fixture(); next.revision = 'remote-2';
  next.slots.main = { provider: 'chat1', model: 'remote-main', upstream_stream: false };
  release(reply(200, next)); await pending;
  assert.deepEqual(h.ui().draft.slots.main, { provider: 'resp1', model: 'deepseek-worker', upstream_stream: true });
  assert.equal(h.ui().dirty, true);
  assert.equal(h.ui().revision, 'rev-1');
  assert.equal(h.get('dsh-slot-0-provider').value, 'resp1');
  assert.equal(h.get('dsh-slot-0-model').value, 'deepseek-worker');
  assert.equal(h.get('dsh-slot-0-stream').value, 'true');
});

test('failed reload preserves edits made while its request is in flight as unsaved', async () => {
  const h = harness(); await h.load();
  let release;
  h.stub(() => new Promise(resolve => { release = resolve; }));
  const pending = h.run('dshReload()');
  h.input('dsh-slot-0-provider', 'resp1', 'change');
  h.input('dsh-slot-0-model', 'deepseek-worker');
  h.input('dsh-slot-0-stream', 'true', 'change');
  release(reply(500, { error: 'cannot read' })); await pending;
  assert.deepEqual(h.ui().draft.slots.main, { provider: 'resp1', model: 'deepseek-worker', upstream_stream: true });
  assert.equal(h.ui().dirty, true, 'in-flight edits must not become a falsely saved draft');
  assert.equal(h.get('dsh-save').disabled, false);
  assert.equal(h.get('dsh-sync').disabled, true);
  assert.match(h.get('dsh-draft-note').textContent, /未保存修改/);
});

test('failed dirty reload keeps a newly added in-flight slot unsaved', async () => {
  const h = harness(); await h.load();
  h.input('dsh-slot-0-model', 'before-reload');
  let release, started;
  const fetching = new Promise(resolve => { started = resolve; });
  h.stub(() => new Promise(resolve => { release = resolve; started(); }));
  const pending = h.run('dshReload()');
  await fetching;
  h.get('dsh-new-name').value = 'hebox'; h.run('dshAddSlot()');
  h.input('dsh-slot-2-provider', 'resp1', 'change');
  h.input('dsh-slot-2-model', 'deepseek-worker');
  h.input('dsh-slot-2-stream', 'false', 'change');
  release(reply(500, { error: 'cannot read' })); await pending;
  assert.deepEqual(h.ui().draft.slots.hebox, { provider: 'resp1', model: 'deepseek-worker', upstream_stream: false });
  assert.equal(h.ui().draft.slots.main.model, 'before-reload');
  assert.equal(h.ui().dirty, true);
  assert.equal(h.get('dsh-save').disabled, false);
});

test('offline DOM changes cannot remain as saved-looking provider, model or stream selections', async () => {
  const h = harness(); await h.load(); await h.run('dshRefresh()');
  h.run('online = false');
  h.input('dsh-slot-0-provider', 'resp1', 'change');
  assert.equal(h.get('dsh-slot-0-provider').value, 'chat1', 'rejected selection is restored immediately');
  h.input('dsh-slot-0-model', 'offline-only');
  assert.equal(h.get('dsh-slot-0-model').value, 'deepseek-main');
  h.input('dsh-slot-0-stream', 'true', 'change');
  assert.equal(h.get('dsh-slot-0-stream').value, 'false');
  assert.equal(h.get('dsh-slot-0-provider').disabled, true);
  h.run('online = true'); await h.run('dshRefresh()');
  assert.deepEqual(h.ui().draft.slots.main, fixture().slots.main);
  assert.equal(h.ui().dirty, false);
  assert.equal(h.get('dsh-slot-0-provider').value, 'chat1');
  assert.equal(h.get('dsh-slot-0-model').value, 'deepseek-main');
  assert.equal(h.get('dsh-slot-0-stream').value, 'false');
});

test('new edits clear the previous save success instead of displaying it above an unsaved draft', async () => {
  const h = harness(); await h.load();
  h.input('dsh-slot-0-model', 'saved-main'); await h.run('dshSave()');
  assert.equal(h.get('dsh-outcome').hidden, false);
  h.input('dsh-slot-0-provider', 'resp1', 'change');
  h.input('dsh-slot-0-model', 'deepseek-worker');
  assert.equal(h.ui().dirty, true);
  assert.equal(h.get('dsh-outcome').hidden, true);
  assert.match(h.get('dsh-status').textContent, /未保存/);
});

test('public state getter works before loading and after save without leaking internal bindings', async () => {
  const h = harness(); assert.equal(h.ui().draft, null);
  await h.load(); h.input('dsh-slot-0-model', 'getter-model'); await h.run('dshSave()');
  assert.equal(h.ui().draft.slots.main.model, 'getter-model');
  assert.equal(h.ui().dirty, false);
  assert.doesNotThrow(() => h.run('dshUiState()'));
});

// v2 policy, declarations and preview regressions. These run against fixture fetch only.
test('v1 migration preserves every candidate, fixed empty-default main and historical declarations until explicit save', async () => {
  const data = v1Fixture('');
  data.slots['review-2'] = { provider: 'chat1', model: 'deepseek-other', upstream_stream: true };
  const h = harness('overview', data); await h.load();
  assert.equal(h.ui().draft.version, 2);
  assert.deepEqual(h.ui().draft.subagents, { owner: 'mixrouter', allow_model_selection: true, allowed_slots: ['main', 'worker', 'review-2'], default: { mode: 'slot', slot: 'main' } });
  for (const slot of Object.values(h.ui().draft.slots)) {
    assert.deepEqual(slot.capabilities, { input: ['text', 'image'], reasoning_efforts: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } });
    assert.equal(Object.hasOwn(slot.capabilities, 'context_window'), false);
    assert.equal(Object.hasOwn(slot.capabilities, 'max_tokens'), false);
  }
  assert.equal(h.get('dsh-slot-0-context_window').value, '');
  assert.equal(h.get('dsh-slot-0-max_tokens').value, '');
  assert.equal(h.get('dsh-default-mode').value, 'slot');
  assert.equal(h.get('dsh-default-subagent').value, 'main');
  assert.equal(h.get('dsh-slot-0-candidate').checked, true);
  assert.equal(h.get('dsh-migration').hidden, false);
  assert.match(h.get('dsh-migration').textContent, /旧空默认值.*固定 main.*不是.*继承父调用/);
  assert.match(h.get('dsh-migration').textContent, /保留旧适配器.*尚未核对上游/);
  assert.equal(h.get('dsh-save').disabled, false, 'an unchanged legacy snapshot can be explicitly migrated');
  assert.equal(h.get('dsh-sync').disabled, true);
  await h.run('dshRefresh()'); await h.run('dshPreview(); dshSync()');
  assert.equal(h.writes().length, 0, 'load/refresh never auto-migrates or synchronizes');
  await h.run('dshSave()');
  assert.equal(h.writes()[0].body.version, 2);
  assert.equal(Object.hasOwn(h.writes()[0].body, 'default_subagent'), false);
  assert.deepEqual(h.writes()[0].body.subagents.allowed_slots, ['main', 'worker', 'review-2']);
  assert.equal(h.ui().dirty, false);
  assert.equal(h.get('dsh-migration').hidden, true);
  assert.match(h.get('dsh-outcome').textContent, /v1 已迁移为 v2/);
});

test('normalized v1 policy keeps its non-main fixed route and new routes remain undeclared and unselected', async () => {
  const data = v1Fixture();
  data.subagents = { owner: 'mixrouter', allow_model_selection: true, allowed_slots: ['main', 'worker'], default: { mode: 'slot', slot: 'worker' } };
  const h = harness('overview', data); await h.load();
  assert.deepEqual(h.ui().draft.subagents, data.subagents);
  h.get('dsh-new-name').value = 'new-route'; h.run('dshAddSlot()');
  h.input('dsh-slot-2-provider', 'chat1', 'change'); h.input('dsh-slot-2-model', 'deepseek-other');
  assert.equal(Object.hasOwn(h.ui().draft.slots['new-route'], 'capabilities'), false);
  assert.equal(h.get('dsh-slot-2-candidate').checked, false);
  assert.deepEqual(h.ui().draft.subagents.allowed_slots, ['main', 'worker']);
});

test('empty legacy snapshots also use Harness ownership, selection off and actual inheritance without materializing capabilities', async () => {
  const data = v1Fixture(''); data.slots = {}; data.migration_required = false;
  const h = harness('overview', data); await h.load();
  assert.deepEqual(h.ui().draft.subagents, { owner: 'harness', allow_model_selection: false, allowed_slots: [], default: { mode: 'inherit' } });
  assert.deepEqual(h.ui().draft.slots.main, { provider: '', model: '' });
  assert.equal(h.get('dsh-slot-0-candidate').checked, false);
  assert.equal(h.get('dsh-migration').hidden, true);
});

test('old API backends stay read-only and never receive v2 route, strategy, preview or sync writes', async () => {
  const data = v1Fixture(); delete data.api_version; delete data.supported_config_versions;
  const h = harness('overview', data); await h.load();
  const before = h.ui().draft;
  for (const id of ['dsh-save', 'dsh-sync', 'dsh-preview', 'dsh-add', 'dsh-add-custom-label', 'dsh-add-custom-label-button', 'dsh-default-task', 'dsh-policy-owner', 'dsh-allow-model-selection', 'dsh-default-mode', 'dsh-default-subagent', 'dsh-max-depth', 'dsh-max-active', 'dsh-slot-0-candidate', 'dsh-slot-0-provider', 'dsh-slot-0-model-choice', 'dsh-slot-0-context_window', 'dsh-slot-0-reasoning-map']) assert.equal(h.get(id).disabled, true, id);
  assert.ok(h.presetButtons.every(button => button.disabled));
  assert.equal(h.get('dsh-backend-upgrade').hidden, false);
  assert.match(h.get('dsh-status').textContent, /后端待更新.*重启 MixRouter.*新版子策略 API/);
  h.input('dsh-slot-0-model', 'old-backend-edit');
  h.input('dsh-policy-owner', 'harness', 'change');
  h.input('dsh-allow-model-selection', false, 'change');
  h.input('dsh-slot-0-context_window', '128000');
  h.run("dshSetPolicy('default_mode','inherit'); dshToggleCandidate('main',false)");
  await h.run("dshSave(); dshPreview(); dshSync(); dshDeleteSlot('worker')");
  h.get('dsh-new-name').value = 'blocked'; assert.equal(h.run('dshAddSlot()'), false);
  assert.deepEqual(h.ui().draft, before);
  assert.equal(h.writes().length, 0);
  assert.equal(h.get('dsh-slot-0-model').value, 'deepseek-main');
  assert.equal(h.get('dsh-policy-owner').value, 'mixrouter');
  assert.equal(h.get('dsh-slot-0-context_window').value, '');
  const next = structuredClone(data); next.api_version = 2; next.supported_config_versions = [1, 2];
  h.update(next); await h.run('dshRefresh(true)');
  assert.equal(h.get('dsh-backend-upgrade').hidden, true);
  assert.equal(h.get('dsh-save').disabled, false);
});

test('candidate checkboxes include explicit main independently of the allow-selection toggle', async () => {
  const h = harness(); await h.load();
  assert.equal(h.get('dsh-slot-0-candidate').checked, false, 'main is not automatically included in v2');
  assert.equal(h.get('dsh-slot-1-candidate').checked, true);
  h.input('dsh-allow-model-selection', false, 'change');
  assert.deepEqual(h.ui().draft.subagents.allowed_slots, ['worker']);
  assert.match(h.get('dsh-selection-note').textContent, /关闭按次选模型，不关闭子任务/);
  h.input('dsh-slot-0-candidate', true, 'change');
  h.input('dsh-slot-1-candidate', false, 'change');
  assert.equal(h.ui().draft.subagents.allow_model_selection, false);
  assert.deepEqual(h.ui().draft.subagents.allowed_slots, ['main']);
  h.input('dsh-allow-model-selection', true, 'change');
  assert.deepEqual(h.ui().draft.subagents.allowed_slots, ['main'], 'toggle preserves the independently edited list');
  assert.equal(await h.run('dshSave()'), false, 'fixed worker now lies outside the list');
  assert.match(h.get('dsh-policy-error').textContent, /固定默认 worker 不在候选/);
  h.input('dsh-default-subagent', 'main', 'change');
  await h.run('dshSave()');
  assert.deepEqual(h.writes()[0].body.subagents, { owner: 'mixrouter', allow_model_selection: true, allowed_slots: ['main'], default: { mode: 'slot', slot: 'main' } });
});

test('allow-selection with an empty list retains visible draft and requires an explicit candidate', async () => {
  const h = harness(); await h.load();
  h.input('dsh-default-mode', 'inherit', 'change'); h.input('dsh-slot-1-candidate', false, 'change');
  assert.deepEqual(h.ui().draft.subagents.allowed_slots, []);
  assert.equal(h.get('dsh-allow-model-selection').checked, true);
  assert.equal(await h.run('dshSave()'), false);
  assert.match(h.get('dsh-policy-error').textContent, /至少勾选一个候选路由/);
  assert.equal(h.writes().length, 0);
  h.input('dsh-allow-model-selection', false, 'change');
  await h.run('dshSave()');
  assert.deepEqual(h.writes()[0].body.subagents.allowed_slots, []);
  assert.deepEqual(h.writes()[0].body.subagents.default, { mode: 'inherit' });
});

test('fixed main and actual inheritance are distinct; compatibility empty setter remains fixed main', async () => {
  const h = harness(); await h.load();
  h.input('dsh-allow-model-selection', false, 'change');
  h.input('dsh-default-subagent', 'main', 'change');
  assert.deepEqual(h.ui().draft.subagents.default, { mode: 'slot', slot: 'main' });
  assert.deepEqual(h.ui().draft.subagents.allowed_slots, ['worker'], 'selecting main never auto-adds a candidate');
  h.input('dsh-default-mode', 'inherit', 'change');
  assert.deepEqual(h.ui().draft.subagents.default, { mode: 'inherit' });
  assert.equal(h.get('dsh-default-subagent').disabled, true);
  assert.match(h.get('dsh-default-note').textContent, /省略 provider、model、reasoningEffort/);
  await h.run('dshSave()');
  assert.deepEqual(h.writes()[0].body.subagents.default, { mode: 'inherit' });
  assert.equal(Object.hasOwn(h.writes()[0].body.subagents.default, 'slot'), false);
  h.run("dshSetDefault('')");
  assert.deepEqual(h.ui().draft.subagents.default, { mode: 'slot', slot: 'main' });
  assert.equal(h.get('dsh-default-mode').value, 'slot');
  assert.match(h.get('dsh-default-note').textContent, /固定 main.*不会跟随/);
});

test('ownership switching preserves page preferences while routes-only sync clearly leaves native policy to Harness', async () => {
  const h = harness(); await h.load();
  h.input('dsh-max-depth', '0'); h.input('dsh-max-active', '4');
  const preferences = h.ui().draft.subagents;
  h.input('dsh-policy-owner', 'harness', 'change');
  assert.deepEqual(h.ui().draft.subagents, { ...preferences, owner: 'harness' });
  assert.match(h.get('dsh-owner-note').textContent, /策略作为保留选项.*不应用到原生设置/);
  h.input('dsh-policy-owner', 'mixrouter', 'change');
  assert.deepEqual(h.ui().draft.subagents, preferences);
  h.input('dsh-policy-owner', 'harness', 'change');
  await h.run('dshSave()');
  const saved = fixture(); saved.revision = 'rev-2'; saved.subagents = h.ui().draft.subagents;
  const checked = previewFixture(saved); checked.preview.affected_sections = ['llm-pi-ai']; checked.preview.policy_owner = 'harness';
  h.stub(req => req.url === '/api/dsh/preview' ? reply(200, checked) : reply(200, { ok: true, revision: 'rev-2', client: { ...saved.client, policy_owner: 'harness' } }));
  await h.run('dshSync()');
  assert.match(h.confirms.at(-1)[1], /仅同步 provider.*模型别名目录.*保留主.*子原生设置/);
  assert.match(h.confirms.at(-1)[1], /影响字段：llm-pi-ai/);
  assert.doesNotMatch(h.confirms.at(-1)[1], /管理模型路由目录、主模型默认值/);
  assert.match(h.get('dsh-outcome').textContent, /主.*子设置仍由 Harness 管理/);
});

test('optional limits stay omitted, explicit zero depth survives and clearing a limit preserves the original native setting', async () => {
  const h = harness(); await h.load();
  assert.equal(h.get('dsh-max-depth').value, ''); assert.equal(h.get('dsh-max-active').value, '');
  h.input('dsh-max-depth', '0'); h.input('dsh-max-active', '64');
  await h.run('dshSave()');
  assert.equal(h.writes()[0].body.subagents.max_depth, 0);
  assert.equal(h.writes()[0].body.subagents.max_active, 64);
  h.input('dsh-max-depth', ''); h.input('dsh-max-active', '');
  await h.run('dshSave()');
  assert.equal(Object.hasOwn(h.writes()[1].body.subagents, 'max_depth'), false);
  assert.equal(Object.hasOwn(h.writes()[1].body.subagents, 'max_active'), false);
});

test('invalid limits remain visibly unsaved and are never coerced to a valid default', async () => {
  for (const [field, value] of [['max_depth', '-1'], ['max_depth', '65'], ['max_depth', '1.5'], ['max_active', '0'], ['max_active', '9007199254740992'], ['max_active', 'abc']]) {
    const h = harness(); await h.load();
    const id = field === 'max_depth' ? 'dsh-max-depth' : 'dsh-max-active'; h.input(id, value);
    assert.equal(h.get(id).value, value);
    assert.equal(h.get(id).getAttribute('aria-invalid'), 'true');
    assert.equal(h.get('dsh-policy-error').hidden, false);
    assert.equal(await h.run('dshSave()'), false, field + '=' + value);
    await h.run('dshRefresh(true)');
    assert.equal(h.ui().dirty, true); assert.equal(h.get(id).value, value);
    assert.equal(h.writes().length, 0);
  }
});

test('per-route capabilities send only declared capacity/input and an exact wire reasoning map', async () => {
  const h = harness(); await h.load();
  assert.equal(Object.hasOwn(h.ui().draft.slots.main, 'capabilities'), false);
  assert.equal(h.get('dsh-slot-0-context_window').value, '');
  assert.equal(h.get('dsh-slot-0-input-capability').value, '');
  assert.equal(h.get('dsh-slot-0-reasoning-mode').value, '');
  assert.match(h.get('dsh-main-slot').innerHTML, /适配器默认 context_window 262144.*max_tokens 32768.*不代表上游已验证/);
  h.input('dsh-slot-0-context_window', '128000'); h.input('dsh-slot-0-max_tokens', '8192');
  h.input('dsh-slot-0-input-capability', 'text,image', 'change');
  h.input('dsh-slot-0-reasoning-mode', 'map', 'change');
  const text = '{"off":null,"minimal":"budget_1","high":"thinking_high"}';
  h.input('dsh-slot-0-reasoning-map', text);
  h.input('dsh-slot-1-input-capability', 'text', 'change'); h.input('dsh-slot-1-reasoning-mode', 'false', 'change');
  await h.run('dshSave()');
  assert.deepEqual(h.writes()[0].body.slots.main.capabilities, { context_window: 128000, max_tokens: 8192, input: ['text', 'image'], reasoning_efforts: { off: null, minimal: 'budget_1', high: 'thinking_high' } });
  assert.deepEqual(h.writes()[0].body.slots.worker.capabilities, { input: ['text'], reasoning_efforts: false });
  assert.deepEqual(Object.keys(h.ui().draft.slots.main.capabilities.reasoning_efforts), ['off', 'minimal', 'high']);
  assert.equal(Object.hasOwn(h.ui().draft.slots.main.capabilities.reasoning_efforts, 'xhigh'), false, 'exact mapping is never expanded to all levels');
});

test('clearing capabilities removes declarations instead of silently asserting image or reasoning support', async () => {
  const data = fixture(); data.slots.main.capabilities = { context_window: 64000, max_tokens: 8000, input: ['text', 'image'], reasoning_efforts: { off: null, high: 'high' } };
  const h = harness('overview', data); await h.load();
  h.input('dsh-slot-0-context_window', ''); h.input('dsh-slot-0-max_tokens', '');
  h.input('dsh-slot-0-input-capability', '', 'change'); h.input('dsh-slot-0-reasoning-mode', '', 'change');
  assert.equal(Object.hasOwn(h.ui().draft.slots.main, 'capabilities'), false);
  await h.run('dshSave()');
  assert.equal(Object.hasOwn(h.writes()[0].body.slots.main, 'capabilities'), false);
  assert.equal(h.get('dsh-slot-0-reasoning-map').disabled, true);
});

test('invalid capacity declarations retain their exact draft text through refresh and block PUT', async () => {
  for (const [field, value] of [['context_window', '0'], ['context_window', '1.5'], ['max_tokens', '-3'], ['max_tokens', '9007199254740992']]) {
    const h = harness(); await h.load(); h.input('dsh-slot-0-' + field, value);
    assert.equal(h.get('dsh-slot-0-' + field).value, value);
    assert.equal(h.get('dsh-slot-0-' + field).getAttribute('aria-invalid'), 'true');
    assert.equal(h.get('dsh-slot-0-cap-error').hidden, false);
    assert.equal(await h.run('dshSave()'), false);
    await h.run('dshRefresh(true)');
    assert.equal(h.get('dsh-slot-0-' + field).value, value); assert.equal(h.ui().dirty, true);
    assert.equal(h.writes().length, 0);
  }
  const h = harness(); await h.load(); h.input('dsh-slot-0-context_window', '16'); h.input('dsh-slot-0-max_tokens', '17');
  assert.equal(await h.run('dshSave()'), false);
  assert.match(h.get('dsh-slot-0-cap-error').textContent, /max_tokens.*小于或等于 context_window/);
  assert.equal(h.get('dsh-slot-0-max_tokens').value, '17');
});

test('malformed or invalid reasoning maps stay visible as draft rather than saved-looking choices', async () => {
  for (const value of ['{', '{}', '{"off":null}', '{"low":null}', '{"unknown":"x","high":"high"}', '{"high":""}', '{"high":"line\\nbreak"}', JSON.stringify({ high: 'x'.repeat(129) }), '[]', 'true']) {
    const h = harness(); await h.load();
    h.input('dsh-slot-0-reasoning-mode', 'map', 'change'); h.input('dsh-slot-0-reasoning-map', value);
    assert.equal(h.get('dsh-slot-0-reasoning-map').value, value);
    assert.equal(h.get('dsh-slot-0-cap-error').hidden, false, value);
    assert.equal(h.get('dsh-slot-0-reasoning-map').getAttribute('aria-invalid'), 'true');
    assert.equal(await h.run('dshSave()'), false, value);
    await h.run('dshRefresh(true)');
    assert.equal(h.get('dsh-slot-0-reasoning-map').value, value); assert.equal(h.ui().dirty, true);
    assert.equal(h.get('dsh-slot-0-reasoning-mode').value, 'map');
    assert.equal(h.writes().length, 0);
  }
});

test('dirty policy and metadata edits survive remote snapshots while disk facts and observations update', async () => {
  const h = harness(); await h.load();
  h.input('dsh-policy-owner', 'harness', 'change'); h.input('dsh-allow-model-selection', false, 'change');
  h.input('dsh-default-mode', 'inherit', 'change'); h.input('dsh-max-depth', '0');
  h.input('dsh-slot-0-context_window', '128000'); h.input('dsh-slot-0-reasoning-mode', 'map', 'change');
  h.input('dsh-slot-0-reasoning-map', '{"off":null,"low":"budget_low"}');
  const textarea = h.get('dsh-slot-0-reasoning-map'); const before = h.ui().draft;
  const next = fixture(); next.revision = 'remote-policy'; next.client.model = 'native-choice';
  next.slots.main.capabilities = { reasoning_efforts: false };
  next.observations.last_request = { ts: 123, alias: 'mixr-dsh-worker', slot: 'worker', provider: 'actual-route', model: 'actual-model', status: 200, outcome: 'ok', err_class: null };
  h.update(next); await h.run('dshRefresh(true)');
  assert.deepEqual(h.ui().draft, before);
  assert.equal(h.ui().revision, 'rev-1'); assert.equal(h.ui().observed_revision, 'remote-policy');
  assert.equal(h.get('dsh-slot-0-reasoning-map'), textarea, 'refresh does not replace focused metadata inputs');
  assert.equal(h.get('dsh-default-mode').value, 'inherit'); assert.equal(h.get('dsh-max-depth').value, '0');
  assert.match(h.get('dsh-client').innerHTML, /native-choice/);
  assert.match(h.get('dsh-observations').innerHTML, /actual-route.*actual-model/);
  assert.match(h.get('dsh-summary').innerHTML, /另一窗口已更新服务端/);
  await h.run('dshSave()');
  assert.equal(h.writes()[0].body.expected_revision, 'rev-1');
  assert.deepEqual(h.writes()[0].body.subagents, before.subagents);
  assert.deepEqual(h.writes()[0].body.slots.main.capabilities, before.slots.main.capabilities);
});

test('failed reload keeps new policy and invalid reasoning edits made during the request unsaved', async () => {
  const h = harness(); await h.load();
  let release; h.stub(() => new Promise(resolve => { release = resolve; }));
  const pending = h.run('dshReload()');
  h.input('dsh-max-depth', '0'); h.input('dsh-default-mode', 'inherit', 'change');
  h.input('dsh-slot-0-reasoning-mode', 'map', 'change'); h.input('dsh-slot-0-reasoning-map', '{partial');
  release(reply(500, { error: 'fixture read failed' })); await pending;
  assert.equal(h.ui().dirty, true); assert.equal(h.ui().revision, 'rev-1');
  assert.equal(h.ui().draft.subagents.max_depth, 0);
  assert.deepEqual(h.ui().draft.subagents.default, { mode: 'inherit' });
  assert.equal(h.ui().draft.slots.main.capabilities.reasoning_efforts, '{partial');
  assert.equal(h.get('dsh-slot-0-reasoning-map').value, '{partial');
  assert.equal(h.get('dsh-policy-owner').disabled, false);
});

test('authoritative save response reconciles all strategy and capacity fields, including wire normalization', async () => {
  const h = harness(); await h.load(); h.input('dsh-max-depth', '1');
  h.input('dsh-slot-0-context_window', '128000'); h.input('dsh-slot-0-reasoning-mode', 'map', 'change');
  h.input('dsh-slot-0-reasoning-map', '{"off":null,"low":" low "}');
  const saved = fixture(); saved.revision = 'normalized-policy';
  saved.subagents = { owner: 'harness', allow_model_selection: false, allowed_slots: ['main'], default: { mode: 'inherit' }, max_depth: 0, max_active: 3 };
  saved.slots.main.capabilities = { context_window: 64000, max_tokens: 4000, input: ['text'], reasoning_efforts: { off: null, low: 'low' } };
  h.stub(() => reply(200, { ok: true, ...saved }));
  assert.equal(await h.run('dshSave()'), true);
  assert.deepEqual(h.ui().draft.subagents, saved.subagents);
  assert.deepEqual(h.ui().draft.slots.main.capabilities, saved.slots.main.capabilities);
  assert.equal(h.get('dsh-policy-owner').value, 'harness'); assert.equal(h.get('dsh-allow-model-selection').checked, false);
  assert.equal(h.get('dsh-default-mode').value, 'inherit'); assert.equal(h.get('dsh-max-depth').value, '0');
  assert.equal(h.get('dsh-slot-0-context_window').value, '64000'); assert.equal(h.get('dsh-slot-0-input-capability').value, 'text');
  assert.deepEqual(JSON.parse(h.get('dsh-slot-0-reasoning-map').value), { off: null, low: 'low' });
  assert.equal(h.ui().dirty, false); assert.equal(h.ui().revision, 'normalized-policy');
});

test('save responses missing authoritative v2 policy or reporting v1 never acknowledge the submitted draft', async () => {
  for (const mutate of [data => { delete data.subagents; }, data => { data.version = 1; delete data.subagents; }]) {
    const h = harness(); await h.load(); h.input('dsh-max-depth', '2');
    const result = fixture(); result.revision = 'unverified'; mutate(result);
    h.stub(() => reply(200, { ok: true, ...result }));
    assert.equal(await h.run('dshSave()'), false);
    assert.equal(h.ui().dirty, true); assert.equal(h.ui().revision, 'rev-1');
    assert.equal(h.ui().draft.subagents.max_depth, 2); assert.equal(h.get('dsh-outcome').hidden, true);
  }
});

test('offline DOM edits restore every new strategy, candidate and capability control immediately', async () => {
  const data = fixture(); data.slots.main.capabilities = { context_window: 128000, input: ['text'], reasoning_efforts: { off: null, high: 'high' } };
  const h = harness('overview', data); await h.load(); const before = h.ui().draft;
  h.run('online = false');
  h.input('dsh-policy-owner', 'harness', 'change'); h.input('dsh-allow-model-selection', false, 'change');
  h.input('dsh-slot-0-candidate', true, 'change'); h.input('dsh-default-mode', 'inherit', 'change');
  h.input('dsh-max-depth', '5'); h.input('dsh-max-active', '9');
  h.input('dsh-slot-0-context_window', '32000'); h.input('dsh-slot-0-input-capability', 'text,image', 'change');
  h.input('dsh-slot-0-reasoning-mode', 'false', 'change'); h.input('dsh-slot-0-reasoning-map', '{"low":"changed"}');
  assert.deepEqual(h.ui().draft, before); assert.equal(h.ui().dirty, false);
  assert.equal(h.get('dsh-policy-owner').value, 'mixrouter'); assert.equal(h.get('dsh-allow-model-selection').checked, true);
  assert.equal(h.get('dsh-slot-0-candidate').checked, false); assert.equal(h.get('dsh-default-mode').value, 'slot');
  assert.equal(h.get('dsh-max-depth').value, ''); assert.equal(h.get('dsh-max-active').value, '');
  assert.equal(h.get('dsh-slot-0-context_window').value, '128000'); assert.equal(h.get('dsh-slot-0-input-capability').value, 'text');
  assert.equal(h.get('dsh-slot-0-reasoning-mode').value, 'map');
  assert.deepEqual(JSON.parse(h.get('dsh-slot-0-reasoning-map').value), { off: null, high: 'high' });
  for (const id of ['dsh-policy-owner', 'dsh-slot-0-candidate', 'dsh-max-depth', 'dsh-slot-0-context_window', 'dsh-slot-0-reasoning-map']) assert.equal(h.get(id).disabled, true);
});

test('preview POST only uses expected revision and displays bounded sections, coverage, warnings and no runtime adoption claim', async () => {
  const h = harness(); await h.load();
  const checked = previewFixture(); checked.preview.warnings = ['<script>disk note</script>']; checked.preview.model_count = 2;
  h.stub(req => req.url === '/api/dsh/preview' ? reply(200, checked) : reply(200, fixture()));
  assert.equal(await h.run('dshPreview()'), true);
  assert.deepEqual(h.writes(), [{ url: '/api/dsh/preview', method: 'POST', body: { expected_revision: 'rev-1' } }]);
  assert.equal(h.confirms.length, 0); assert.equal(h.ui().dirty, false);
  assert.equal(h.get('dsh-preview-panel').hidden, false); assert.equal(h.ui().preview_revision, 'rev-1');
  assert.match(h.get('dsh-preview-result').innerHTML, /llm-pi-ai.*agent-default-model/s);
  assert.match(h.get('dsh-preview-result').innerHTML, /ordinary_spawn/);
  assert.match(h.get('dsh-preview-result').innerHTML, /模型路由目录.*能力声明.*将更新/s);
  assert.match(h.get('dsh-preview-result').innerHTML, /global_enforcement.*否/s);
  assert.match(h.get('dsh-preview-result').innerHTML, /runtime_adoption.*unverified/s);
  assert.match(h.get('dsh-preview-result').innerHTML, /只读预览，不写 profile/);
  assert.match(h.get('dsh-preview-result').innerHTML, /&lt;script&gt;disk note&lt;\/script&gt;/);
  assert.doesNotMatch(h.get('dsh-preview-result').innerHTML, /<script>/);
  h.input('dsh-max-depth', '2'); assert.equal(h.get('dsh-preview-panel').hidden, true, 'new edits invalidate preview');
  assert.equal(h.ui().preview, null);
});

test('sync always refreshes a displayed preview before confirmation to account for native disk edits', async () => {
  const h = harness(); await h.load();
  assert.equal(await h.run('dshPreview()'), true);
  const checked = previewFixture(); checked.preview.affected_sections = ['llm-pi-ai', 'new-native-disk-section'];
  h.stub(req => req.url === '/api/dsh/preview' ? reply(200, checked) : reply(200, { ok: true, revision: 'rev-1', client: fixture().client }));
  assert.equal(await h.run('dshSync()'), true);
  assert.deepEqual(h.writes().map(req => req.url), ['/api/dsh/preview', '/api/dsh/preview', '/api/dsh/sync']);
  assert.match(h.confirms.at(-1)[1], /new-native-disk-section/);
});

test('mismatched preview revision, unavailable endpoint and disk conflict stop before sync confirmation', async () => {
  for (const response of [reply(200, { ...previewFixture(), revision: 'different-revision' }), reply(404, { error: 'preview unavailable' }), reply(200, { revision: 'rev-1', preview: { ...previewFixture().preview, status: 'conflict' } })]) {
    const h = harness(); await h.load(); h.stub(() => response);
    assert.equal(await h.run('dshSync()'), false);
    assert.equal(h.confirms.length, 0); assert.equal(h.writes().length, 1);
    assert.equal(h.writes()[0].url, '/api/dsh/preview');
    assert.equal(h.ui().unsupported, false, 'preview 404 does not disable /api/dsh route editing');
    assert.equal(h.ui().revision, 'rev-1'); assert.equal(h.get('dsh-preview-panel').hidden, false);
    assert.equal(h.get('dsh-slot-0-provider').disabled, false);
  }
});

test('all new controls are locked during preview, confirmation, save and sync requests', async () => {
  const h = harness(); await h.load();
  let releasePreview, enterConfirm, releaseConfirm, enterSync, releaseSync;
  const confirming = new Promise(resolve => { enterConfirm = resolve; });
  const syncing = new Promise(resolve => { enterSync = resolve; });
  h.stub(req => req.url === '/api/dsh/preview' ? new Promise(resolve => { releasePreview = resolve; }) : new Promise(resolve => { releaseSync = resolve; enterSync(); }));
  h.confirm(() => new Promise(resolve => { releaseConfirm = resolve; enterConfirm(); }));
  const before = h.ui().draft, pending = h.run('dshSync()');
  const locked = () => {
    for (const id of ['dsh-policy-owner', 'dsh-allow-model-selection', 'dsh-default-mode', 'dsh-default-task', 'dsh-add-custom-label', 'dsh-add-custom-label-button', 'dsh-max-depth', 'dsh-max-active', 'dsh-slot-0-candidate', 'dsh-slot-0-provider', 'dsh-slot-0-model-choice', 'dsh-slot-0-model', 'dsh-slot-0-stream', 'dsh-slot-0-context_window', 'dsh-slot-0-input-capability', 'dsh-slot-0-reasoning-mode', 'dsh-slot-0-reasoning-map']) assert.equal(h.get(id).disabled, true, id);
    assert.ok(h.presetButtons.every(button => button.disabled));
    h.run("dshSetPolicy('owner','harness'); dshSetPolicy('max_depth',2); dshToggleCandidate('main',true); dshSetCapability('main','input','text,image')");
    assert.deepEqual(h.ui().draft, before);
  };
  locked(); releasePreview(reply(200, previewFixture())); await confirming; locked();
  releaseConfirm(true); await syncing; locked();
  releaseSync(reply(200, { ok: true, client: fixture().client })); await pending;
  assert.equal(h.get('dsh-policy-owner').disabled, false);
  h.stub(null); h.input('dsh-max-depth', '2');
  const saveBefore = h.ui().draft;
  let releaseSave; h.stub(() => new Promise(resolve => { releaseSave = resolve; }));
  const saving = h.run('dshSave()');
  assert.equal(h.get('dsh-max-depth').disabled, true); assert.equal(h.get('dsh-slot-0-candidate').disabled, true);
  for (const id of ['dsh-slot-0-provider', 'dsh-slot-0-model-choice', 'dsh-slot-0-model', 'dsh-default-task', 'dsh-add-custom-label', 'dsh-add-custom-label-button']) assert.equal(h.get(id).disabled, true, id);
  assert.ok(h.presetButtons.every(button => button.disabled));
  h.input('dsh-max-depth', '3'); assert.deepEqual(h.ui().draft, saveBefore);
  const saved = fixture(); saved.revision = 'rev-save'; saved.subagents = saveBefore.subagents;
  releaseSave(reply(200, { ok: true, ...saved })); await saving;
});

test('losing connection during confirmation sends no sync request', async () => {
  const h = harness(); await h.load();
  let release, started; const confirming = new Promise(resolve => { started = resolve; });
  h.confirm(() => new Promise(resolve => { release = resolve; started(); }));
  const pending = h.run('dshSync()'); await confirming;
  h.run('online = false'); release(true);
  assert.equal(await pending, false);
  assert.deepEqual(h.writes().map(req => req.url), ['/api/dsh/preview']);
  assert.equal(h.get('dsh-sync').disabled, true);
});

test('observations render the exact top-level recent-request shape, preserve server order and exclude unrelated content', async () => {
  const data = fixture();
  const records = Array.from({ length: 8 }, (_, index) => ({ ts: 1000 - index, alias: 'mixr-dsh-worker', slot: 'worker', provider: `actual-${index}`, model: `wire-model-${index}`, status: index ? 500 : 200, outcome: index ? 'error' : 'ok', err_class: index ? 'upstream_error' : null, effort: index ? null : 'high', prompt: 'NEVER_RENDER_PROMPT', response: 'NEVER_RENDER_RESPONSE', api_key: 'NEVER_RENDER_KEY' }));
  data.observations = { scope: 'current_process_recent_requests', sample_count: 8, ok_count: 1, error_count: 6, cancelled_count: 1, last_request: records[0], recent: records, by_slot: [{ slot: 'worker', count: 8, ok_count: 1, error_count: 6, cancelled_count: 1, last_request: records[0] }] };
  const h = harness('overview', data); await h.load();
  const rendered = h.get('dsh-observations').innerHTML;
  assert.match(rendered, /样本 8.*成功 1.*错误 6.*取消 1/);
  assert.match(rendered, /有界近期样本，不是全部历史/);
  assert.match(rendered, /actual-0.*wire-model-0/s); assert.match(rendered, /effort=high/);
  assert.ok(rendered.indexOf('actual-1') < rendered.indexOf('actual-2'));
  assert.doesNotMatch(rendered, /actual-5|wire-model-5|NEVER_RENDER/);
  assert.match(h.get('dsh-summary').innerHTML, /已保存.*服务端.*编辑草稿.*同步.*磁盘 profile.*运行时.*只读观测/s);
  assert.match(h.get('dsh-summary').innerHTML, /会话采纳未验证/);
  const empty = fixture(); h.update(empty); await h.run('dshRefresh(true)');
  assert.match(h.get('dsh-observations').innerHTML, /尚无最后请求样本/);
});

test('disk registration, config equality and merged router/client warnings are escaped and separate from runtime claims', async () => {
  const data = fixture(); data.client.status = 'out_of_sync'; data.client.sync_needed = true;
  data.client.provider_registered = true; data.client.routed = false;
  data.warnings = ['router note <one>', 'duplicate']; data.client.warnings = ['adapter note <two>', 'duplicate'];
  const h = harness('overview', data); await h.load();
  const facts = h.get('dsh-client').innerHTML;
  assert.match(facts, /磁盘配置与已保存目录.*策略有差异/);
  assert.match(facts, /MixRouter provider 已登记/);
  assert.match(facts, /router note &lt;one&gt;/); assert.match(facts, /adapter note &lt;two&gt;/);
  assert.equal((facts.match(/<li>duplicate<\/li>/g) || []).length, 1);
  assert.match(facts, /采纳未验证/);
});

test('untrusted slot identifiers, exact wire values, observations and preview fields never inject innerHTML or event parameters', async () => {
  const data = fixture(); const hostile = 'x\");alert(9);//<script>';
  data.slots[hostile] = { provider: 'chat1', model: '<img src=x onerror=alert(9)>', capabilities: { reasoning_efforts: { high: '</textarea><script>alert(9)</script>' } } };
  data.subagents.allowed_slots.push(hostile);
  data.observations.last_request = { ts: '<time>', alias: '<alias>', slot: hostile, provider: '<channel>', model: '<model>', status: '<status>', outcome: '<outcome>', err_class: '<error>' };
  const h = harness('overview', data); await h.load();
  for (const id of ['dsh-slots', 'dsh-observations', 'dsh-summary']) {
    assert.doesNotMatch(h.get(id).innerHTML, /<script>|<img src=x onerror=alert/);
    assert.match(h.get(id).innerHTML, /&lt;/);
  }
  assert.match(h.get('dsh-slots').innerHTML, /dshDeleteSlot\(&quot;x\\&quot;/);
  assert.equal(h.get('dsh-slot-2-reasoning-map').value, JSON.stringify(data.slots[hostile].capabilities.reasoning_efforts, null, 2));
  h.input('dsh-slot-0-model', 'changed'); assert.equal(await h.run('dshSave()'), false, 'hostile slot name stays invalid, not silently renamed');
  assert.equal(h.writes().length, 0);
});

test('task model UI preserves the simple controls and makes catalog and coverage boundaries explicit', () => {
  const section = html.slice(html.indexOf('<section id="view-dsh"'), html.indexOf('<section id="view-routes"'));
  for (const id of ['dsh-main-slot', 'dsh-slots', 'dsh-default-task', 'dsh-add-custom-label', 'dsh-add-custom-label-button', 'dsh-default-subagent']) assert.match(section, new RegExp(`id="${id}"`));
  assert.match(section, /class="dsh-preset-buttons"/);
  assert.match(section, /id="dsh-default-task"[^>]*onchange="dshSetDefaultTask\(this.value\)"/);
  assert.match(section, /主模型/); assert.match(section, /子任务模型/);
  assert.doesNotMatch(section + source, /自动按类型选用|确定性按任务路由/);
  assert.match(section, /任务类型是模型选择标签，不会新增角色或指令/);
  assert.match(source, /不是全局白名单/);
  assert.match(source, /fork \/ Agent Teams.*隐式继承/);
  assert.match(source, /workflow.*独立模型与委派配置路径/);
  assert.match(source, /DS Bot \/ 原生 presets.*固定角色、指令与原生模型配置独立/);
});

test('simple default inheritance is real inheritance while both compatibility values stay fixed main', async () => {
  const h = harness(); await h.load();
  h.input('dsh-default-task', 'inherit', 'change');
  assert.deepEqual(h.ui().draft.subagents.default, { mode: 'inherit' });
  assert.equal(h.get('dsh-default-mode').value, 'inherit');
  assert.equal(h.get('dsh-default-task').value, 'inherit');
  for (const value of ['', 'inherit']) {
    h.run(`dshSetDefault(${JSON.stringify(value)})`);
    assert.deepEqual(h.ui().draft.subagents.default, { mode: 'slot', slot: 'main' });
  }
  h.input('dsh-default-task', 'worker', 'change');
  assert.deepEqual(h.ui().draft.subagents.default, { mode: 'slot', slot: 'worker' });
  assert.equal(h.get('dsh-default-subagent').value, 'worker');
  h.input('dsh-default-task', 'inherit', 'change');
  await h.run('dshSave()');
  assert.deepEqual(h.writes()[0].body.subagents.default, { mode: 'inherit' });
});

test('a missing legacy fixed picker cannot abort rendering the simple model editor', async () => {
  const h = harness(); h.remove('dsh-default-subagent');
  await h.load();
  assert.equal(h.ui().draft.slots.main.model, 'deepseek-main');
  assert.equal(h.get('dsh-editor').hidden, false);
  assert.equal(h.get('dsh-default-task').value, 'worker');
  h.input('dsh-default-task', 'inherit', 'change');
  assert.deepEqual(h.ui().draft.subagents.default, { mode: 'inherit' });
});

test('model choice immediately toggles the custom input and channel changes recalculate its choice', async () => {
  const h = harness(); await h.load();
  assert.equal(h.get('dsh-slot-0-model').hidden, true);
  h.input('dsh-slot-0-model-choice', 'custom', 'change');
  assert.equal(h.get('dsh-slot-0-model').hidden, false);
  assert.equal(h.ui().dirty, false, 'opening the custom input alone does not change the saved model');
  h.input('dsh-slot-0-model-choice', '1', 'change');
  assert.equal(h.get('dsh-slot-0-model').hidden, true);
  assert.equal(h.get('dsh-slot-0-model-choice').value, '1');
  assert.equal(h.ui().draft.slots.main.model, 'deepseek-other');
  h.input('dsh-slot-0-provider', 'resp1', 'change');
  assert.equal(h.get('dsh-slot-0-model-choice').value, 'custom');
  assert.equal(h.get('dsh-slot-0-model').hidden, false);
  assert.match(h.get('dsh-slot-0-model-choice').innerHTML, /deepseek-worker/);
  assert.doesNotMatch(h.get('dsh-slot-0-model-choice').innerHTML, /deepseek-other/);
  h.input('dsh-slot-0-model-choice', '0', 'change');
  assert.equal(h.get('dsh-slot-0-model').hidden, true);
  assert.equal(h.ui().draft.slots.main.model, 'deepseek-worker');
});

test('preset and custom task models copy the main route and preserve unrelated policy without immediate writes', async () => {
  const h = harness(); await h.load();
  const original = h.ui().draft;
  assert.equal(h.run("dshAddPreset('coder')"), true);
  assert.equal(h.run("dshAddPreset('coder')"), true);
  assert.deepEqual(h.ui().draft.slots.coder, { ...original.slots.main, label: '代码编写' });
  assert.deepEqual(h.ui().draft.slots['coder-2'], { ...original.slots.main, label: '代码编写' });
  h.get('dsh-add-custom-label').value = 'x7f 文本分析';
  assert.equal(h.run('dshAddCustomTask()'), true, 'ordinary x/f/d characters are not mistaken for control escapes');
  h.get('dsh-add-custom-label').value = '第二任务';
  assert.equal(h.run('dshAddCustomTask()'), true);
  assert.deepEqual(Object.keys(h.ui().draft.slots).filter(id => id.startsWith('custom-')), ['custom-1', 'custom-2']);
  assert.deepEqual(h.ui().draft.subagents.default, original.subagents.default);
  assert.equal(h.ui().draft.subagents.owner, original.subagents.owner);
  assert.equal(h.ui().draft.subagents.allow_model_selection, original.subagents.allow_model_selection);
  assert.deepEqual(h.ui().draft.subagents.allowed_slots, ['worker', 'coder', 'coder-2', 'custom-1', 'custom-2']);
  assert.equal(h.get('dsh-slot-2-candidate').checked, true);
  h.input('dsh-slot-2-candidate', false, 'change');
  assert.equal(h.ui().draft.subagents.allowed_slots.includes('coder'), false);
  h.input('dsh-slot-2-candidate', true, 'change');
  assert.equal(h.ui().draft.subagents.allowed_slots.includes('coder'), true);
  assert.equal(h.writes().length, 0);
});

test('custom IDs remain numeric and unique across saved gaps without changing existing routes', async () => {
  const data = fixture();
  data.slots['custom-1'] = { provider: 'chat1', model: 'one', label: '第一任务' };
  data.slots['custom-3'] = { provider: 'chat1', model: 'three', label: '第三任务' };
  const h = harness('overview', data); await h.load();
  h.get('dsh-add-custom-label').value = '第二任务'; assert.equal(h.run('dshAddCustomTask()'), true);
  h.get('dsh-add-custom-label').value = '第四任务'; assert.equal(h.run('dshAddCustomTask()'), true);
  assert.deepEqual(Object.keys(h.ui().draft.slots).filter(id => id.startsWith('custom-')), ['custom-1', 'custom-3', 'custom-2', 'custom-4']);
  assert.deepEqual(h.ui().draft.slots['custom-3'], data.slots['custom-3']);
});

test('task labels reject actual control characters and excessive length but accept ordinary text', async () => {
  const h = harness(); await h.load();
  for (const label of ['', ' ', 'x'.repeat(25), 'line\nbreak', '\u0000', '\u007f']) {
    h.get('dsh-add-custom-label').value = label;
    assert.equal(h.run('dshAddCustomTask()'), false, JSON.stringify(label));
  }
  h.get('dsh-add-custom-label').value = '修复 x/f/d'; assert.equal(h.run('dshAddCustomTask()'), true);
  for (const label of ['line\nbreak', '\u0000', '\u007f', 'x'.repeat(25)]) {
    h.input('dsh-slot-2-label', label);
    assert.equal(h.get('dsh-slot-2-label').getAttribute('aria-invalid'), 'true');
    assert.equal(await h.run('dshSave()'), false);
    assert.equal(h.ui().draft.slots['custom-1'].label, label, 'invalid label remains an unsaved draft');
  }
  h.input('dsh-slot-2-label', '修复 x/f/d');
  assert.equal(h.get('dsh-slot-2-label').getAttribute('aria-invalid'), 'false');
  assert.equal(await h.run('dshSave()'), true);
  assert.equal(h.writes()[0].body.slots['custom-1'].label, '修复 x/f/d');
});

test('all simple main, preset, custom-add and default controls lock during writes and restore offline edits', async () => {
  const h = harness(); await h.load();
  let release;
  h.stub(() => new Promise(resolve => { release = resolve; }));
  const before = h.ui().draft, pending = h.run('dshPreview()');
  const ids = ['dsh-slot-0-provider', 'dsh-slot-0-model-choice', 'dsh-slot-0-model', 'dsh-slot-0-stream', 'dsh-default-task', 'dsh-add-custom-label', 'dsh-add-custom-label-button'];
  for (const id of ids) assert.equal(h.get(id).disabled, true, id);
  assert.equal(h.presetButtons.length, 7);
  assert.ok(h.presetButtons.every(button => button.disabled));
  h.run("dshAddPreset('coder'); dshSetDefaultTask('inherit')");
  assert.deepEqual(h.ui().draft, before);
  release(reply(200, previewFixture())); await pending;
  for (const id of ids) assert.equal(h.get(id).disabled, false, id);
  assert.ok(h.presetButtons.every(button => !button.disabled));
  h.run('online = false');
  h.input('dsh-default-task', 'inherit', 'change');
  assert.equal(h.get('dsh-default-task').value, 'worker');
  assert.deepEqual(h.ui().draft, before);
  for (const id of ids) assert.equal(h.get(id).disabled, true, id);
  assert.ok(h.presetButtons.every(button => button.disabled));
});

test('sync button is blocked only during an in-flight read and its real click handler works after completion', async () => {
  const h = harness(); await h.load();
  let release;
  h.stub(req => req.method === 'GET' ? new Promise(resolve => { release = resolve; })
    : req.url === '/api/dsh/preview' ? reply(200, previewFixture())
      : reply(200, { ok: true, revision: 'rev-1', client: fixture().client }));
  const reading = h.run('dshRefresh()');
  assert.equal(h.get('dsh-sync').disabled, true, 'loadTask and disabled stay aligned while read is pending');
  assert.equal(h.click('dsh-sync'), false);
  assert.equal(await h.run('dshSync()'), false, 'direct call also respects the read guard');
  assert.equal(h.writes().length, 0);
  release(reply(200, fixture())); await reading;
  assert.equal(h.get('dsh-sync').disabled, false);
  assert.equal(await h.click('dsh-sync'), true, 'the actual inline button handler enters preview/confirm/sync');
  assert.deepEqual(h.writes().map(req => req.url), ['/api/dsh/preview', '/api/dsh/sync']);
  assert.equal(h.confirms.length, 1);
});

test('legacy unlabeled routes display their saved IDs without silently materializing labels', async () => {
  const h = harness(); await h.load();
  assert.match(h.get('dsh-slots').innerHTML, /<h3>worker<\/h3>/);
  assert.equal(Object.hasOwn(h.ui().draft.slots.worker, 'label'), false);
  h.input('dsh-slot-0-model', 'new-main'); await h.run('dshSave()');
  assert.equal(Object.hasOwn(h.writes()[0].body.slots.worker, 'label'), false);
  assert.match(h.get('dsh-main-slot').innerHTML, /dsh-slot-0-candidate/);
});

test('repair preview formats provider/model facts and sync sends the preview profile lock only after confirmation', async () => {
  const data = fixture(); data.client.status = 'conflict'; data.client.repair_available = true;
  const h = harness('overview', data); await h.load();
  const checked = previewFixture(data); Object.assign(checked.preview, {
    repair_mode: true, profile_revision: 'native-rev-1', backup_path: '/mock/backup.yml',
    main_before: { provider: '<native>', model: 'native-model' },
    main_after: { provider: 'mixrouter', model: 'mixr-dsh-main' },
  });
  h.stub(req => req.url === '/api/dsh/preview' ? reply(200, checked) : reply(200, { ok: true, revision: 'rev-1', client: data.client }));
  assert.equal(await h.run('dshSync()'), true);
  assert.match(h.confirms[0][1], /<native> \/ native-model → mixrouter \/ mixr-dsh-main/);
  assert.match(h.confirms[0][1], /\/mock\/backup.yml/);
  assert.doesNotMatch(h.confirms[0][1], /\[object Object\]/);
  assert.deepEqual(h.writes()[0].body, { expected_revision: 'rev-1', repair: true });
  assert.deepEqual(h.writes()[1].body, { confirm: true, expected_revision: 'rev-1', repair: true, expected_profile_revision: 'native-rev-1' });
  h.confirm(false); await h.run('dshSync()');
  assert.match(h.get('dsh-preview-result').innerHTML, /&lt;native&gt; \/ native-model → mixrouter \/ mixr-dsh-main/);
  assert.doesNotMatch(h.get('dsh-preview-result').innerHTML, /<native>|\[object Object\]/);
});
