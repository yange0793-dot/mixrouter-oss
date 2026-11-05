'use strict';
// 模型方案(#profiles)的定向回归:只跑真实 public/js/profiles.js,配最小的 DOM/api 边界。
// 不联网、不读写真实 profiles.json。
//
// 钉住几件会静默骗人的事:
//   · 保存只发快照,不切换;revision 随请求带上;
//   · 预览只展示白名单字段,绝不回显 Key;不可应用时禁用确认;
//   · 切换必须二次确认,且文案说明只影响后续请求、会话覆盖仍优先;
//   · 删除只删快照;409 不覆盖、不假装成功;
//   · 只在进入本页或手动刷新时读取,没有轮询。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'public/js/profiles.js'), 'utf8');
const appSource = require('./console-source').consoleSource();
const workspaceSource = fs.readFileSync(path.join(ROOT, 'public/js/workspace.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

const LIST = {
  revision: 'pr-1',
  slots_revision: 'sr-1',
  profiles: [
    { id: 'p1', name: 'Night', apps: ['claude'], created_at: '2026-11-01T10:00:00.000Z', active: true },
    { id: 'p2', name: 'Dual', apps: ['claude', 'codex'], created_at: 1720000000000, active: false },
  ],
};

const PREVIEW = {
  id: 'p1', name: 'Night', expected_revision: 'pr-1', slots_revision: 'sr-1',
  changes: [
    {
      app: 'claude', slot: 'main',
      before: { provider: 'pA', model: 'm1', key_id: 'secret-key-id' },
      after: { provider: 'pB', model: 'm2', pool: [{ provider: 'pC', model: 'm3', key_id: 'another-secret' }], strategy: 'round_robin' },
    },
    { app: 'claude', slot: 'subagent', before: null, after: { provider: 'pB', model: '' } },
  ],
  warnings: ['渠道 pX 已停用'],
  can_apply: true,
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

function harness({ online = true, list = LIST, preview = PREVIEW } = {}) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new El(id));
    return elements.get(id);
  };
  get('profiles-app-claude').checked = true;
  let currentList = plain(list);
  let currentPreview = plain(preview);
  const calls = [];
  let responder = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (url === '/api/profiles' && method === 'GET') return plain(currentList);
    if (url === '/api/profiles' && method === 'POST') {
      const body = JSON.parse(options.body);
      currentList = {
        ...currentList,
        revision: 'pr-2',
        profiles: [...currentList.profiles, { id: 'p-new', name: body.name, apps: body.apps, created_at: '2026-11-02T00:00:00.000Z', active: false }],
      };
      return plain(currentList);
    }
    if (/^\/api\/profiles\/[^/]+\/preview$/.test(url) && method === 'POST') return plain(currentPreview);
    if (/^\/api\/profiles\/[^/]+\/apply$/.test(url) && method === 'POST') return { ok: true };
    if (url.startsWith('/api/profiles/') && method === 'DELETE') {
      const id = decodeURIComponent(url.slice('/api/profiles/'.length));
      currentList = { ...currentList, revision: 'pr-3', profiles: currentList.profiles.filter(profile => profile.id !== id) };
      return { ok: true };
    }
    throw new Error('unexpected ' + url);
  };
  const confirmations = [];
  let confirmResult = true;
  const context = vm.createContext({
    document: { getElementById: id => get(id) },
    console,
    online,
    api: (url, options = {}) => { calls.push({ url, options }); return responder(url, options); },
    askConfirm: async (...args) => { confirmations.push(args); return confirmResult; },
  });
  vm.runInContext(source, context, { filename: 'public/js/profiles.js' });
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
  h.run('profilesSetVisible(true)');
  await h.settle();
  return h;
}

test('index/外壳接线:两个新视图入口、脚本样式与 typeof 钩子', () => {
  assert.match(html, /id="view-profiles"/);
  assert.match(html, /<a href="#profiles" data-view="profiles">/);
  assert.match(html, /<script src="\/js\/profiles.js"><\/script>/);
  assert.match(html, /href="\/styles\/profiles\.css"/);
  assert.match(appSource, /typeof profilesSetVisible === 'function'/);
  assert.match(appSource, /profilesSetVisible\(view === 'profiles'\)/);
  assert.match(appSource, /const VIEWS = \[[^\]]*'profiles'/);
  assert.match(workspaceSource, /profiles: '模型方案'/);
  assert.match(workspaceSource, /view: 'profiles'/);
  assert.doesNotMatch(source, /setInterval|setTimeout/, '方案页不做后台轮询');
  for (const id of ['profiles-name', 'profiles-app-claude', 'profiles-app-codex', 'profiles-save',
    'profiles-save-status', 'profiles-reload', 'profiles-rows', 'profiles-empty',
    'profiles-revision-hint', 'profiles-preview-panel', 'profiles-preview-body', 'profiles-apply']) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html 缺少 #${id}`);
  }
});

test('进入本页才读取一次;方案清单显示 active、协议组与时间', async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  h.run('profilesSetVisible(true)');
  await h.settle();
  assert.deepEqual(h.calls.map(call => call.url), ['/api/profiles']);
  const rows = h.get('profiles-rows').innerHTML;
  assert.match(rows, /Night/);
  assert.match(rows, /Dual/);
  assert.match(rows, /Claude \/ Codex/);
  assert.match(rows, /上次读取时一致/);
  assert.match(rows, /上次读取时不一致/);
  assert.doesNotMatch(rows, /—<td>/, 'created_at 有效时不能显示 —');
  assert.match(h.get('profiles-revision-hint').textContent, /方案修订 pr-1/);
  assert.match(h.get('profiles-revision-hint').textContent, /槽位修订 sr-1/);
  assert.equal(h.get('profiles-table').hidden, false);
  assert.equal(h.get('profiles-empty').hidden, true);
  h.run('profilesSetVisible(true)');
  await h.settle();
  assert.equal(h.calls.length, 1, '切回本页不重复读取');
  await h.run('profilesLoad(true)');
  assert.equal(h.calls.length, 2, '手动刷新才再读');
});

test('首次离线后补读，双组方案预览不从差异猜范围', async () => {
  const h = harness({ online: false, preview: { ...PREVIEW, id: 'p2', name: 'Dual' } });
  h.run('profilesSetVisible(true); online = true; profilesRender(); profilesSetVisible(true)');
  await h.settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.get('profiles-save').disabled, false);
  await h.run('profilesPreview(1)');
  assert.match(h.get('profiles-preview-body').innerHTML, /覆盖 Claude \/ Codex/);
  await h.run('profilesApply()');
  assert.match(h.confirmations[0][1], /Claude \/ Codex/);
  assert.match(appSource, /connected && view === 'profiles'.*profilesSetVisible\(true\)/);
});

test('保存:只发名称、协议组与 expected_revision;成功后重读并保留“当前槽位未改变”说明', async () => {
  const h = await loaded();
  h.get('profiles-name').value = '  Night 2  ';
  h.get('profiles-app-codex').checked = true;
  await h.run('profilesSave()');
  const post = h.calls.find(call => call.options.method === 'POST' && call.url === '/api/profiles');
  assert.deepEqual(JSON.parse(post.options.body), {
    name: 'Night 2', apps: ['claude', 'codex'], expected_revision: 'pr-1',
  });
  assert.equal(h.get('profiles-name').value, '');
  assert.match(h.get('profiles-save-status').textContent, /已保存方案「Night 2」/);
  assert.match(h.get('profiles-save-status').textContent, /当前槽位未改变/);
  assert.match(h.get('profiles-rows').innerHTML, /Night 2/);
  assert.equal(h.calls.filter(call => call.url === '/api/profiles' && (call.options.method || 'GET') === 'GET').length, 2);
});

test('保存前校验:空名称、未选协议组、离线都不发 POST', async () => {
  const h = await loaded();
  await h.run('profilesSave()');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
  assert.match(h.get('profiles-save-status').textContent, /请输入方案名称/);
  h.get('profiles-name').value = 'X';
  h.get('profiles-app-claude').checked = false;
  await h.run('profilesSave()');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
  assert.match(h.get('profiles-save-status').textContent, /至少选择一个协议组/);

  const offline = harness({ online: false });
  offline.run('profilesSetVisible(true)');
  await offline.settle();
  assert.equal(offline.calls.length, 0);
  assert.match(offline.get('profiles-list-status').textContent, /离线/);
  assert.equal(offline.get('profiles-save').disabled, true);
  offline.get('profiles-name').value = 'X';
  await offline.run('profilesSave()');
  assert.equal(offline.calls.length, 0);
  assert.match(offline.get('profiles-save-status').textContent, /离线/);
});

test('保存冲突 409:保留输入与旧 revision,不假装成功', async () => {
  const h = await loaded();
  h.respond(async () => { throw Object.assign(new Error('conflict'), { status: 409 }); });
  h.get('profiles-name').value = 'Keep me';
  await h.run('profilesSave()');
  assert.equal(h.get('profiles-name').value, 'Keep me');
  assert.match(h.get('profiles-save-status').textContent, /保存冲突/);
  assert.equal(h.run('profilesState.revision'), 'pr-1');
});

test('预览:只展示白名单槽位字段与警告,绝不回显 Key;不可应用时禁用确认', async () => {
  const h = await loaded();
  await h.run('profilesPreview(0)');
  const call = h.calls.find(item => item.url === '/api/profiles/p1/preview');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.body, '{}');
  assert.equal(h.get('profiles-preview-panel').hidden, false);
  const body = h.get('profiles-preview-body').innerHTML;
  assert.match(body, /方案「Night」/);
  assert.match(body, /渠道 pA · 模型 m1/);
  assert.match(body, /渠道 pB · 模型 m2/);
  assert.match(body, /备池 pC\/m3/);
  assert.match(body, /策略 round_robin/);
  assert.match(body, /subagent/);
  assert.match(body, /（无此槽位）/);
  assert.match(body, /渠道 pX 已停用/);
  for (const secret of ['secret-key-id', 'another-secret', 'key_id']) {
    assert.equal(body.includes(secret), false, `预览不能出现 ${secret}`);
  }
  assert.equal(h.get('profiles-apply').disabled, false);

  const blocked = await loaded({ preview: { ...previewWithoutKey(), can_apply: false } });
  await blocked.run('profilesPreview(0)');
  assert.equal(blocked.get('profiles-apply').disabled, true);
  assert.match(blocked.get('profiles-preview-status').textContent, /不可应用/);
});

function previewWithoutKey() {
  return {
    id: 'p1', name: 'Night', expected_revision: 'pr-1', slots_revision: 'sr-1',
    changes: [{ app: 'claude', slot: 'main', before: { provider: 'pA' }, after: { provider: 'pX' } }],
    warnings: ['渠道 pX 已停用'],
    can_apply: true,
  };
}

test('预览数据不完整:明确失败并禁用确认', async () => {
  const h = await loaded();
  h.respond(async () => ({ changes: [] }));
  await h.run('profilesPreview(0)');
  assert.match(h.get('profiles-preview-status').textContent, /预览失败：预览数据不完整/);
  assert.equal(h.get('profiles-apply').disabled, true);
});

test('切换:必须二次确认;取消不发 POST;确认后带两个 revision,并说明只影响后续请求', async () => {
  const h = await loaded();
  await h.run('profilesPreview(0)');
  h.confirm(false);
  await h.run('profilesApply()');
  assert.equal(h.calls.filter(call => call.url.endsWith('/apply')).length, 0);
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0][1], /只影响后续新请求/);
  assert.match(h.confirmations[0][1], /在途请求不会迁移/);
  assert.match(h.confirmations[0][1], /会话级槽位覆盖仍然优先/);

  h.confirm(true);
  await h.run('profilesApply()');
  const apply = h.calls.find(call => call.url.endsWith('/apply'));
  assert.deepEqual(JSON.parse(apply.options.body), {
    confirm: true, expected_revision: 'pr-1', slots_revision: 'sr-1',
  });
  assert.equal(h.get('profiles-preview-panel').hidden, true);
  assert.match(h.get('profiles-list-status').textContent, /已切换到「Night」/);
  assert.match(h.get('profiles-list-status').textContent, /后续新请求使用新槽位/);
  assert.match(h.get('profiles-list-status').textContent, /在途请求不迁移/);
  assert.match(h.get('profiles-list-status').textContent, /客户端配置与推理强度未改动/);
});

test('切换冲突 409:要求重新预览,不再允许直接确认', async () => {
  const h = await loaded();
  await h.run('profilesPreview(0)');
  h.respond(async () => { throw Object.assign(new Error('conflict'), { status: 409 }); });
  await h.run('profilesApply()');
  assert.match(h.get('profiles-preview-status').textContent, /已变化.*重新预览/);
  assert.equal(h.get('profiles-apply').disabled, true);
  assert.equal(h.run('profilesState.preview'), null);
});

test('删除:必须确认;只发 DELETE 快照请求;取消不发', async () => {
  const h = await loaded();
  h.confirm(false);
  await h.run('profilesDelete(0)');
  assert.equal(h.calls.filter(call => call.options.method === 'DELETE').length, 0);
  assert.equal(h.confirmations.length, 1);
  h.confirm(true);
  await h.run('profilesDelete(0)');
  const del = h.calls.find(call => call.options.method === 'DELETE');
  assert.equal(del.url, '/api/profiles/p1');
  assert.deepEqual(JSON.parse(del.options.body), { expected_revision: 'pr-1', confirm: true });
  assert.doesNotMatch(h.get('profiles-rows').innerHTML, /Night/);
  assert.match(h.get('profiles-list-status').textContent, /已删除方案「Night」/);
  assert.match(h.get('profiles-list-status').textContent, /当前槽位未改变/);
});

test('删除冲突 409:保留列表并提示重新读取', async () => {
  const h = await loaded();
  h.respond(async () => { throw Object.assign(new Error('conflict'), { status: 409 }); });
  await h.run('profilesDelete(0)');
  assert.match(h.get('profiles-list-status').textContent, /删除冲突/);
  assert.match(h.get('profiles-rows').innerHTML, /Night/);
});

test('恶意方案名、警告与槽位字段一律转义', async () => {
  const evil = '\"><img src=x onerror=alert(1)>';
  const list = {
    revision: 'pr-x', slots_revision: 'sr-x',
    profiles: [{ id: 'p9', name: evil, apps: ['claude'], created_at: '2026-11-01T00:00:00.000Z', active: false }],
  };
  const preview = {
    id: 'p9', name: evil, expected_revision: 'pr-x', slots_revision: 'sr-x',
    changes: [{ app: 'claude', slot: evil, before: { provider: evil, model: evil }, after: { provider: evil } }],
    warnings: [evil],
    can_apply: true,
  };
  const h = await loaded({ list, preview });
  assert.doesNotMatch(h.get('profiles-rows').innerHTML, /<img/);
  assert.match(h.get('profiles-rows').innerHTML, /&lt;img/);
  await h.run('profilesPreview(0)');
  assert.doesNotMatch(h.get('profiles-preview-body').innerHTML, /<img/);
  assert.match(h.get('profiles-preview-body').innerHTML, /&lt;img/);
});
