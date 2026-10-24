'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../public/js/harness.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const STYLE = fs.readFileSync(path.join(__dirname, '../public/styles/harness.css'), 'utf8');

function state(overrides = {}) {
  return {
    api_version: 1, revision: 'r1', configured: true,
    main: { provider: 'p1', model: 'one' },
    pool: [{ id: 'stable-one', provider: 'p1', model: 'one' }],
    providers: [
      { id: 'p1', name: 'Provider One', app: 'claude', models: ['one', 'two'], enabled: true, has_key: true },
      { id: 'p2', name: 'Provider Two', app: 'codex', models: ['three'], enabled: true, has_key: true },
      { id: 'off', name: 'Disabled', app: 'claude', models: ['off-model'], enabled: false, has_key: true },
      { id: 'no-key', name: 'Missing key', app: 'claude', models: ['missing-key'], enabled: true, has_key: false },
    ],
    client: { status: 'not-connected', profile_path: '/isolated/profile.yaml', pool_updates: 'new-sessions' },
    ...overrides,
  };
}

function setup() {
  const nodes = new Map();
  class Element {
    constructor(id) {
      this.id = id; this.disabled = false; this.hidden = false; this.checked = false;
      this.textContent = ''; this.className = ''; this.style = {}; this.attrs = {}; this._html = '';
    }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    focus() {}
    set innerHTML(value) {
      this._html = value;
      for (const match of value.matchAll(/<(?:input|select|button|div|h3)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const node = new Element(match[1]);
        node.disabled = /\sdisabled(?:\s|>|=)/.test(match[0]);
        nodes.set(node.id, node);
      }
    }
    get innerHTML() { return this._html; }
  }
  for (const id of ['view-harness', 'harness-main', 'harness-pool', 'harness-save', 'harness-reload',
    'harness-preview-button', 'harness-preview', 'harness-status', 'harness-client-status', 'toast']) nodes.set(id, new Element(id));
  const requests = [];
  const pending = [];
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id) || null }, window: {},
    AbortController, console, setTimeout: () => 1, clearTimeout() {},
    fetch(url, options) {
      requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    askConfirm: async () => true,
  });
  // 跑实际共享 helper，保证 api(path,{method,body}) 的 body 是 JSON 字符串，不另造签名。
  vm.runInContext(APP.slice(0, APP.indexOf('// Dialogs share')), context);
  vm.runInContext('online = true;', context);
  vm.runInContext(SOURCE, context, { filename: 'public/js/harness.js' });
  const answer = (body, status = 200) => pending.shift().resolve({ ok: status < 400, status, json: async () => body });
  const run = code => vm.runInContext(code, context);
  const load = async (value = state()) => { const work = context.harnessRefresh(); answer(value); await work; };
  return { context, nodes, requests, pending, answer, run, load, get: id => nodes.get(id) };
}

function preview(revision = 'r1') {
  return {
    revision, profile_revision: 'fingerprint-1', client: { profile_path: '/isolated/profile.yaml' },
    changes: [{ field: 'agent-default-model', before: null, after: { provider: 'mixrouter-harness', model: 'mixr-harness-main' } }],
  };
}

test('Harness is an independent classic script with only two editable business areas', () => {
  for (const id of ['view-harness', 'harness-main', 'harness-pool', 'harness-status']) assert.match(INDEX, new RegExp(`id="${id}"`));
  assert.match(INDEX, /href="#harness" data-view="harness"/);
  assert.match(INDEX, /src="\/js\/harness\.js"/);
  assert.match(INDEX, /href="\/styles\/harness\.css"/);
  assert.doesNotMatch(SOURCE, /\bimport\b|\bexport\b|\/api\/slots|\/api\/providers|localStorage|owner|maxDepth|maxActive|preset/);
  assert.match(INDEX, /fork \/ team 继承模型/);
  assert.match(INDEX, /新会话生效/);
  assert.match(INDEX, /Workflow/);
  assert.match(INDEX, /只检查配置文件，原生插件装载\/实际请求仍待验证；池变动需重新接入并新开会话/);
  assert.match(STYLE, /@media \(max-width: 600px\)/);
  assert.match(STYLE, /padding: 16px/);
});

test('entry reads public state, not Claude/Codex slots; no write on entry or preview', async () => {
  const h = setup();
  const work = h.context.harnessSetVisible(true);
  assert.equal(h.requests[0].url, '/api/harness');
  h.answer(state()); await work;
  assert.match(h.get('harness-main').innerHTML, /Provider One/);
  assert.match(h.get('harness-pool').innerHTML, /也是主模型/);
  assert.equal(h.get('harness-save').disabled, true);
  assert.equal(h.get('harness-preview-button').disabled, false);
  const plan = h.context.harnessPreview();
  assert.equal(h.requests.at(-1).url, '/api/harness/preview');
  assert.deepEqual(h.requests.at(-1).body, { expected_revision: 'r1' });
  h.answer(preview()); await plan;
  assert.match(h.get('harness-preview').innerHTML, /agent-default-model/);
  assert.match(h.get('harness-preview').innerHTML, /将改为/);
  assert.equal(h.get('harness-connect').disabled, true);
  await h.context.harnessConnect();
  assert.equal(h.requests.length, 2, 'preview alone must never connect');
});

test('explicit reviewed checkbox is required; connect submits both fingerprints and cannot double submit', async () => {
  const h = setup(); await h.load();
  const plan = h.context.harnessPreview(); h.answer(preview()); await plan;
  h.get('harness-confirm').checked = true; h.context.harnessSyncButtons();
  assert.equal(h.get('harness-connect').disabled, false);
  const connect = h.context.harnessConnect();
  await h.context.harnessConnect();
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.requests.at(-1).body, { confirm: true, expected_revision: 'r1', expected_profile_revision: 'fingerprint-1' });
  assert.equal(h.get('harness-main-provider').disabled, true);
  h.answer({ state: state({ client: { status: 'connected', profile_path: '/isolated/profile.yaml' } }), backup: { profile: '/isolated/backup.yaml' } });
  await connect;
  assert.equal(h.get('harness-preview').hidden, true);
  assert.match(h.get('harness-status').textContent, /新开 Harness 会话/);
  assert.match(h.get('harness-client-status').textContent, /配置已写入（运行待验证）/);
});

test('pool add/remove use exact pairs, preserve unchanged IDs, and save adopts authoritative main inclusion', async () => {
  const h = setup(); await h.load();
  h.context.harnessAdd();
  h.context.harnessPickPool(1, 'provider', 'p2');
  h.context.harnessPickMain('model', 'two');
  const save = h.context.harnessSave();
  await h.context.harnessSave();
  const request = h.requests.at(-1);
  assert.equal(request.url, '/api/harness'); assert.equal(request.options.method, 'PUT');
  assert.equal(typeof request.options.body, 'string');
  assert.deepEqual(request.body, {
    main: { provider: 'p1', model: 'two' },
    pool: [{ id: 'stable-one', provider: 'p1', model: 'one' }, { provider: 'p2', model: 'three' }],
    expected_revision: 'r1',
  });
  assert.equal(h.requests.length, 2, 'one save despite repeated invocation');
  h.answer(state({ revision: 'r2', main: { provider: 'p1', model: 'two' }, pool: [
    { id: 'stable-one', provider: 'p1', model: 'one' }, { id: 'stable-three', provider: 'p2', model: 'three' }, { id: 'stable-two', provider: 'p1', model: 'two' },
  ] }));
  await save;
  assert.equal((h.get('harness-pool').innerHTML.match(/class="harness-member"/g) || []).length, 3);
  assert.equal(h.get('harness-save').disabled, true);
  assert.match(h.get('harness-status').textContent, /尚未写入客户端/);
  h.context.harnessRemove(0);
  const again = h.context.harnessSave();
  assert.equal(h.requests.at(-1).body.expected_revision, 'r2');
  h.answer(state({ revision: 'r3' })); await again;
});

test('dirty drafts survive refresh, hiding, offline, and conflicts without upgrading expected revision', async () => {
  const h = setup(); await h.load();
  h.context.harnessPickMain('model', 'two');
  h.context.harnessSetVisible(false);
  const refresh = h.context.harnessRefresh(); h.answer(state({ revision: 'r2' })); await refresh;
  assert.match(h.get('harness-main').innerHTML, /value="two" selected/);
  assert.match(h.get('harness-status').textContent, /草稿保留/);
  h.run('online = false;'); h.context.harnessSyncButtons();
  assert.equal(h.get('harness-main-provider').disabled, true);
  assert.equal(h.get('harness-add').disabled, true);
  assert.match(h.get('harness-status').textContent, /离线，页面只读/);
  await h.context.harnessSave();
  assert.equal(h.requests.length, 2, 'offline saves do not send requests');
  h.run('online = true;');
  const save = h.context.harnessSave();
  assert.equal(h.requests.at(-1).body.expected_revision, 'r1');
  h.answer({ error: 'revision conflict' }, 409); await save;
  assert.match(h.get('harness-main').innerHTML, /value="two" selected/);
  assert.equal(h.get('harness-save').disabled, false);
});

test('404 and unsupported versions are read-only; malformed or incomplete preview never enables connect', async () => {
  for (const reply of [{ status: 404, body: { error: 'HTTP 404' } }, { status: 200, body: { api_version: 2 } }, { status: 200, body: state({ providers: [{ id: 'p1' }] }) }]) {
    const h = setup();
    const load = h.context.harnessRefresh(); h.answer(reply.body, reply.status); await load;
    assert.equal(h.get('harness-save').disabled, true);
    assert.equal(h.get('harness-preview-button').disabled, true);
    assert.match(h.get('harness-status').textContent, /只读/);
    await h.context.harnessSave();
    assert.equal(h.requests.length, 1);
  }
  const h = setup(); await h.load();
  const work = h.context.harnessPreview(); h.answer({ ...preview(), changes: [{ field: 'incomplete' }] }); await work;
  assert.equal(h.get('harness-preview').hidden, true);
  await h.context.harnessConnect();
  assert.equal(h.requests.length, 2);
});

test('HTML/attribute escaping includes every provider/model and preview value', async () => {
  const bad = '\"><img src=x onerror=alert(1)>&\'';
  const h = setup();
  await h.load(state({ main: { provider: bad, model: bad }, pool: [{ id: 'stable', provider: bad, model: bad }],
    providers: [{ id: bad, name: bad, app: 'claude', models: [bad], enabled: true, has_key: true }] }));
  for (const id of ['harness-main', 'harness-pool']) {
    assert.doesNotMatch(h.get(id).innerHTML, /<img/);
    assert.match(h.get(id).innerHTML, /&quot;&gt;&lt;img/);
  }
  const work = h.context.harnessPreview();
  h.answer({ ...preview(), client: { profile_path: bad }, changes: [{ field: bad, before: bad, after: { nested: bad } }] });
  await work;
  assert.doesNotMatch(h.get('harness-preview').innerHTML, /<img/);
  assert.match(h.get('harness-preview').innerHTML, /&lt;img/);
});

test('changing a route invalidates preview, and disabled providers/unregistered models cannot be selected', async () => {
  const h = setup(); await h.load();
  const work = h.context.harnessPreview(); h.answer(preview()); await work;
  h.context.harnessPickMain('provider', 'off');
  h.context.harnessPickMain('model', 'unknown');
  assert.equal(h.get('harness-preview').hidden, false, 'invalid selections do not mutate a pair');
  h.context.harnessPickMain('model', 'two');
  assert.equal(h.get('harness-preview').hidden, true);
  assert.equal(h.get('harness-preview-button').disabled, true, 'must save draft before previewing client');
  assert.doesNotThrow(() => vm.runInContext(SOURCE, h.context), 'duplicate script load is safe');
});

test('an external revision change clears a reviewed preview before connect', async () => {
  const h = setup(); await h.load();
  const plan = h.context.harnessPreview(); h.answer(preview()); await plan;
  h.get('harness-confirm').checked = true;
  const refresh = h.context.harnessRefresh(); h.answer(state({ revision: 'r2' })); await refresh;
  assert.equal(h.get('harness-preview').hidden, true);
  await h.context.harnessConnect();
  assert.equal(h.requests.length, 3);
});

test('a failed explicit reload keeps dirty draft protection on the next automatic refresh', async () => {
  const h = setup(); await h.load();
  h.context.harnessPickMain('model', 'two');
  const reload = h.context.harnessReload();
  await new Promise(setImmediate);
  h.answer({ error: 'temporary read error' }, 500); await reload;
  assert.match(h.get('harness-main').innerHTML, /value="two" selected/);
  const refresh = h.context.harnessRefresh(); h.answer(state()); await refresh;
  assert.match(h.get('harness-main').innerHTML, /value="two" selected/);
  assert.equal(h.get('harness-save').disabled, false);
});

test('read/parse errors on client state block writes instead of treating the profile as missing', async () => {
  for (const status of ['conflict', 'invalid', 'error', 'unsupported']) {
    const h = setup(); await h.load(state({ client: { status, profile_path: '/isolated/profile.yaml' } }));
    assert.equal(h.get('harness-preview-button').disabled, true);
    await h.context.harnessPreview();
    assert.equal(h.requests.length, 1);
  }
});
