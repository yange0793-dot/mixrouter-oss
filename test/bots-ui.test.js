'use strict';
// Bots 编辑器只在自己的容器里编辑，用 VM 运行真实 classic 脚本；不连网络或用户配置。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/bots.js'), 'utf8');
const appSource = require('./console-source').consoleSource();
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const fixture = bots => ({
  revision: 'revision-1', bots: bots || [],
  providers: [
    { id: 'p1', name: 'Alpha', models: ['m1', 'shared'], active_key: 'k1', keys: [{ id: 'k1', label: 'A', enabled: true }, { id: 'off', label: 'Off', enabled: false }] },
    { id: 'p2', name: 'Beta', models: ['m2', 'shared'], active_key: 'k2', keys: [{ id: 'k2', label: 'B', enabled: true }] },
  ],
});
function harness({ data = fixture(), online = true, app = 'claude', view = 'providers' } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { id, hidden: false, disabled: false, textContent: '', className: '', htmlWrites: 0, focus() { this.focused = true; }, set innerHTML(value) { this._html = value; this.htmlWrites++; }, get innerHTML() { return this._html || ''; } });
    return elements.get(id);
  }
  const calls = [], confirmations = [];
  let responder = async (route, options = {}) => options.method === 'PUT'
    ? { ...data, bots: JSON.parse(options.body).bots, revision: 'revision-2' } : structuredClone(data);
  let confirmResult = true;
  const context = vm.createContext({
    curApp: app, view, online, console, Date, Set, JSON,
    $: element,
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    api: (route, options = {}) => { calls.push({ route, options }); return responder(route, options); },
    askConfirm: async (...args) => { confirmations.push(args); return confirmResult; },
  });
  vm.runInContext(source, context, { filename: 'public/js/bots.js' });
  return {
    context, calls, confirmations, get: element,
    run: code => vm.runInContext(code, context),
    settle: async () => { await new Promise(resolve => setImmediate(resolve)); },
    respond: next => { responder = next; },
    confirm: value => { confirmResult = value; },
  };
}
async function loaded(options) { const h = harness(options); await h.settle(); return h; }
function bind(h, index, provider, model, key) {
  h.run(`setBotModel(${index}, 'provider', ${JSON.stringify(provider)}); setBotModel(${index}, 'model', ${JSON.stringify(model)});`);
  if (key) h.run(`setBotModel(${index}, 'key_id', ${JSON.stringify(key)})`);
}

test('Claude 页面显式面板、Codex 隐藏；classic 入口与应用切换接线', async () => {
  assert.match(html, /id="bots-title">Bots 模型/);
  assert.ok(html.indexOf('id="bots-panel"') < html.indexOf('id="slots-details"'));
  assert.match(html, /<script src="\/js\/bots.js"><\/script>/);
  assert.match(html, /href="\/styles\/bots.css"/);
  assert.match(appSource, /function renderProviders\(\) \{[\s\S]*?typeof renderBotsModels === 'function'/);
  const h = await loaded();
  assert.equal(h.get('bots-panel').hidden, false);
  h.run(`curApp = 'codex'; renderBotsModels()`);
  assert.equal(h.get('bots-panel').hidden, true);
  h.run(`curApp = 'claude'; renderBotsModels()`);
  assert.equal(h.get('bots-panel').hidden, false);
  const codex = await loaded({ app: 'codex' });
  assert.equal(codex.calls.length, 0, 'Codex 不读 Bots 配置');
  // setApp 的真实函数在独立 realm 运行，防止只测 render 而漏掉切换入口。
  const switchSource = appSource.slice(appSource.indexOf('function setApp(app)'), appSource.indexOf("document.querySelector('.apptabs')"));
  let renders = 0, loads = 0;
  const stub = { classList: { toggle() {} }, setAttribute() {} };
  const ctx = vm.createContext({ APPS: { claude: {}, codex: {} }, curApp: 'codex', $: () => stub, syncViewNav() {}, renderSlots() {}, renderProviders() { renders++; }, loadBotsModels(manual) { assert.equal(manual, false); loads++; } });
  vm.runInContext(switchSource + ";setApp('claude')", ctx);
  assert.equal(renders, 1); assert.equal(loads, 1);
});

test('首次空配置只显示四个未绑定草稿，不自动保存或获取上游模型', async () => {
  const h = await loaded();
  assert.deepEqual(plain(h.run('botsDraft.map(b => b.name)')), ['Sol', 'Astra', 'Kimi', 'Opus']);
  assert.ok(h.run('botsDraft.every(b => !b.provider && !b.model)'));
  assert.equal(h.get('bots-save').disabled, true);
  assert.deepEqual(h.calls.map(c => c.route), ['/api/bots']);
  assert.match(h.get('bots-rows').innerHTML, /选择模型/);
  assert.match(h.get('bots-rows').innerHTML, /id="bots-name-0" type="text"/, 'Bot 名字沿用控制台文本框样式');
  assert.doesNotMatch(h.get('bots-rows').innerHTML, /value="m1" selected/);
  const writes = h.get('bots-rows').htmlWrites;
  for (let i = 0; i < 4; i++) h.run('renderBotsModels(); loadBotsModels(false)');
  await h.settle();
  assert.equal(h.calls.length, 1, '状态轮询不能重读配置');
  assert.equal(h.get('bots-rows').htmlWrites, writes, '轮询不能重建编辑器');
});

test('每 Bot 独立选择；换渠道清理失效 model/key，不默认选第一个模型', async () => {
  const h = await loaded();
  bind(h, 0, 'p1', 'm1', 'k1'); bind(h, 1, 'p2', 'm2');
  assert.deepEqual(plain(h.run('botsDraft.slice(0,2).map(b => [b.provider,b.model,b.key_id || ""])')), [['p1', 'm1', 'k1'], ['p2', 'm2', '']]);
  h.run("setBotModel(0,'provider','p2')");
  assert.deepEqual(plain(h.run('[botsDraft[0].model,botsDraft[0].key_id || ""]')), ['', '']);
  assert.equal(h.run('botsDraft[1].model'), 'm2');
  assert.equal(h.calls.length, 1, '选择不能调用网络');
  assert.match(h.get('bots-rows').innerHTML, /跟随渠道当前 Key/);
  h.run('addBotModel()');
  h.run("setBotModel(4,'name','My custom bot')");
  assert.equal(h.run('botsDraft[4].name'), 'My custom bot');
  assert.equal(h.calls.length, 1);
});

test('保存只发 bots 与 expected_revision，服务器确认后才成功，不改槽位或客户端', async () => {
  const h = await loaded(); bind(h, 0, 'p1', 'm1', 'k1'); bind(h, 2, 'p2', 'm2');
  await h.run('saveBotsModels()');
  const put = h.calls.find(c => c.options.method === 'PUT');
  assert.equal(put.route, '/api/bots');
  assert.deepEqual(JSON.parse(put.options.body), { expected_revision: 'revision-1', bots: [
    { id: 'sol', name: 'Sol', provider: 'p1', model: 'm1', key_id: 'k1' },
    { id: 'kimi', name: 'Kimi', provider: 'p2', model: 'm2' },
  ] });
  assert.equal(h.run('botsSnapshot.revision'), 'revision-2');
  assert.equal(h.run('botsDirty'), false);
  assert.match(h.get('bots-status').textContent, /已保存.*下一次 Bot 发言/);
  assert.ok(h.calls.every(c => c.route === '/api/bots'));
});

test('PUT 失败、409 冲突和假成功保留草稿/旧 revision', async () => {
  for (const mode of ['failure', 'conflict', 'malformed', 'mismatch']) {
    const h = await loaded(); bind(h, 0, 'p1', 'm1');
    h.respond(async () => {
      if (mode === 'malformed') return { ok: true };
      if (mode === 'mismatch') return fixture();
      const error = new Error('write failed'); error.status = mode === 'conflict' ? 409 : 500; throw error;
    });
    await h.run('saveBotsModels()');
    assert.equal(h.run('botsDraft[0].model'), 'm1', mode);
    assert.equal(h.run('botsDirty'), true, mode);
    assert.equal(h.run('botsSnapshot.revision'), 'revision-1', mode);
    assert.match(h.get('bots-status').textContent, mode === 'conflict' ? /保存冲突.*草稿未提交/ : /保存失败.*草稿保留/);
  }
});

test('读取失败保留草稿；dirty 手动重读走既有确认弹窗；取消不发 GET', async () => {
  const h = await loaded(); bind(h, 0, 'p1', 'm1'); h.confirm(false);
  await h.run('loadBotsModels()');
  assert.equal(h.calls.length, 1); assert.equal(h.confirmations.length, 1);
  assert.equal(h.run('botsDraft[0].model'), 'm1');
  h.confirm(true); h.respond(async () => { throw new Error('read failed'); });
  await h.run('loadBotsModels()');
  assert.match(h.get('bots-status').textContent, /读取失败.*草稿保留/);
  assert.equal(h.run('botsDraft[0].model'), 'm1');
  assert.equal(h.run('botsDirty'), true);
  h.respond(async () => fixture([{ id: 'new', name: 'Fresh', provider: 'p2', model: 'm2' }]));
  await h.run('loadBotsModels()');
  assert.equal(h.run('botsDraft[0].name'), 'Fresh');
  assert.equal(h.run('botsDirty'), false);
});

test('慢 GET 不覆盖加载期间的编辑；保存中禁改并等真实回包', async () => {
  const h = await loaded();
  let resolveRead;
  h.respond(() => new Promise(resolve => { resolveRead = resolve; }));
  const loading = h.run('loadBotsModels()');
  h.run("setBotModel(0,'name','Edited while loading')");
  resolveRead(fixture([{ id: 'remote', name: 'Remote', provider: 'p2', model: 'm2' }]));
  await loading;
  assert.equal(h.run('botsDraft[0].name'), 'Edited while loading');
  assert.equal(h.run('botsDirty'), true);
  assert.match(h.get('bots-status').textContent, /保留草稿/);
  bind(h, 0, 'p1', 'm1');
  let resolveSave;
  h.respond((_route, options) => new Promise(resolve => { resolveSave = () => resolve({ ...fixture(), revision: 'revision-2', bots: JSON.parse(options.body).bots }); }));
  const saving = h.run('saveBotsModels()');
  assert.equal(h.run('botsDirty'), true);
  assert.match(h.get('bots-status').textContent, /正在保存/);
  assert.equal(h.get('bots-save').disabled, true);
  h.run("setBotModel(0,'name','Must not change')");
  assert.equal(h.run('botsDraft[0].name'), 'Edited while loading');
  resolveSave(); await saving;
  assert.equal(h.run('botsDirty'), false);
});

test('离线禁写，初始离线恢复时只读一次；部分绑定和重复名字不会发 PUT', async () => {
  const offline = await loaded({ online: false });
  assert.equal(offline.calls.length, 0);
  offline.run('online = true; loadBotsModels(false)'); await offline.settle();
  assert.equal(offline.calls.length, 1);
  bind(offline, 0, 'p1', 'm1'); offline.run('online = false; renderBotsModels()');
  await offline.run('saveBotsModels()');
  assert.equal(offline.calls.length, 1); assert.equal(offline.get('bots-save').disabled, true);
  assert.match(offline.get('bots-status').textContent, /离线.*草稿保留/);
  const partial = await loaded(); partial.run("setBotModel(0,'provider','p1')"); await partial.run('saveBotsModels()');
  assert.equal(partial.calls.length, 1); assert.match(partial.get('bots-status').textContent, /请选择有效模型/);
  bind(partial, 0, 'p1', 'm1'); bind(partial, 1, 'p1', 'm1'); partial.run("setBotModel(1,'name','Sol')");
  await partial.run('saveBotsModels()');
  assert.equal(partial.calls.length, 1); assert.match(partial.get('bots-status').textContent, /名字重复/);
});

test('清空已保存绑定不会静默删除；必须显式删除或重新选择完整落点', async () => {
  const h = await loaded({ data: fixture([{ id: 'saved', name: 'Saved', provider: 'p1', model: 'm1', key_id: 'k1' }]) });
  h.run("setBotModel(0,'provider','')");
  await h.run('saveBotsModels()');
  assert.equal(h.calls.length, 1);
  assert.equal(h.run('botsDirty'), true);
  assert.match(h.get('bots-status').textContent, /已保存的绑定不能留空.*删除/);
  h.run('removeBotModel(0)');
  await h.run('saveBotsModels()');
  assert.deepEqual(JSON.parse(h.calls[1].options.body).bots, []);
  assert.equal(h.run('botsDirty'), false);
});

test('跨渠道同名Key id也清除；共享的已登记模型才保留', async () => {
  const data = fixture();
  data.providers[1].keys.push({ id: 'k1', label: 'Another account', enabled: true });
  const h = await loaded({ data }); bind(h, 0, 'p1', 'shared', 'k1');
  h.run("setBotModel(0,'provider','p2')");
  assert.equal(h.run('botsDraft[0].model'), 'shared');
  assert.equal(h.run('botsDraft[0].key_id'), undefined);
});

test('离线立即锁定所有草稿控件与动作，恢复后保留草稿解锁', async () => {
  const h = await loaded(); bind(h, 0, 'p1', 'm1');
  const before = h.run('JSON.stringify(botsDraft)');
  h.run("online = false; renderBotsModels(); setBotModel(0,'name','offline edit'); addBotModel(); removeBotModel(1)");
  assert.equal(h.run('JSON.stringify(botsDraft)'), before);
  for (const id of ['bots-add', 'bots-save', 'bots-reload', 'bots-name-0', 'bots-provider-0', 'bots-model-0', 'bots-key-0', 'bots-remove-0']) assert.equal(h.get(id).disabled, true, id);
  h.run('online = true; renderBotsModels()');
  assert.equal(h.get('bots-name-0').disabled, false);
  assert.equal(h.get('bots-add').disabled, false);
  assert.equal(h.get('bots-save').disabled, false);
  assert.equal(h.run('JSON.stringify(botsDraft)'), before);
});

test('失效渠道/模型/Key 保留 ghost 选项；恶意名字与选项正确转义', async () => {
  const evil = '\"><img src=x onerror=alert(1)>'; const data = fixture([
    { id: 'x', name: evil, provider: 'missing', model: 'old-model', key_id: 'old-key' },
    { id: 'y', name: 'Known', provider: 'p1', model: 'removed', key_id: 'off' },
  ]);
  data.providers[0].name = evil; data.providers[0].models.push(evil);
  const h = await loaded({ data });
  const rendered = h.get('bots-rows').innerHTML;
  assert.match(rendered, /value="missing" selected>missing（渠道已失效）/);
  assert.match(rendered, /value="old-model" selected>old-model（模型已失效）/);
  assert.match(rendered, /value="old-key" selected>old-key（Key 已失效）/);
  assert.match(rendered, /value="off" selected disabled>Off（已停用）/);
  assert.doesNotMatch(rendered, /<img/); assert.match(rendered, /&quot;&gt;&lt;img/);
  assert.equal(h.run('botsDraft[0].provider'), 'missing');
  assert.match(rendered, /setBotModel\(0,'name',this.value\)/, 'inline handler 只带行索引，不拼接名字');
  await h.run('saveBotsModels()');
  assert.equal(h.calls.length, 1, '未编辑的 ghost 配置不能被悄悄重写');
});
