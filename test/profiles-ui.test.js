'use strict';
// 模型方案(#profiles)与 O3/O4 配置文案的定向回归，配最小的 DOM/api 边界。
// 不联网、不读写真实 profiles.json 或配置；compact/settings 只验证本子块改动。
//
// 钉住几件会静默骗人的事:
//   · 保存只发快照,不切换;revision 随请求带上;
//   · 预览只展示白名单字段,绝不回显 Key;不可应用时禁用确认;
//   · 切换必须二次确认,且文案说明只影响后续请求、会话覆盖仍优先;
//   · 删除只删快照;409 不覆盖、不假装成功;
//   · 只在进入本页或手动刷新时读取,没有轮询;
//   · 时间按今天/今年/更早三档显示;修订号、渠道 id、策略枚举不当主文案,原值留在 title。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'public/js/profiles.js'), 'utf8');
const profilesCss = fs.readFileSync(path.join(ROOT, 'public/styles/profiles.css'), 'utf8');
const compactSource = fs.readFileSync(path.join(ROOT, 'public/js/compact.js'), 'utf8');
const settingsSource = fs.readFileSync(path.join(ROOT, 'public/js/settings.js'), 'utf8');
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
    this.focusVisible = true; this.parentElement = null; this.listeners = new Map(); this.attributes = new Map();
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
      toggle: (name, on = !classes.has(name)) => { if (on) classes.add(name); else classes.delete(name); return on; },
    };
  }
  set innerHTML(value) { this._html = String(value ?? ''); }
  get innerHTML() { return this._html; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  closest(selector) { return selector === 'label' ? this.parentElement : null; }
  matches(selector) { return selector === ':focus-visible' && this.focused && this.focusVisible; }
  addEventListener(event, listener) { this.listeners.set(event, [...this.listeners.get(event) || [], listener]); }
  dispatch(event) { for (const listener of this.listeners.get(event) || []) listener(); }
  focus() { this.focused = true; this.dispatch('focus'); }
  blur() { this.focused = false; this.dispatch('blur'); }
}

function harness({ online = true, list = LIST, preview = PREVIEW } = {}) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) {
      const node = new El(id);
      elements.set(id, node);
      if (id === 'profiles-app-claude' || id === 'profiles-app-codex') node.parentElement = get(id + '-label');
    }
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

function configHarness() {
  const elements = new Map(), calls = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new El(id)); return elements.get(id); };
  let responder = async () => { throw new Error('unexpected request'); };
  const context = vm.createContext({
    document: { getElementById: get, querySelector: () => null }, window: { addEventListener() {} },
    $: get, esc: value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])),
    fmtTok: String, fmtCount: value => Number(value).toLocaleString('en-US'), fmtTtfb: value => `${value}ms`, fmtBytes: value => `${value}B`,
    fmtWhen: () => '12:34:56', fmtFullTime: () => '2026-11-06 12:34:56',
    state: { compact: { key_selection_supported: true, selection: { key_id: '' }, providers: [{ id: 'p1', active_key: 'k1',
      keys: [{ id: 'k1', label: '当前账号', enabled: true }, { id: 'k2', label: '固定账号', enabled: true }] }] } },
    compactDraft: { provider: 'p1', model: 'model', key_id: '' }, compactOutcome: null, windowOutcome: null,
    liveHealth: null, healthError: '', view: 'settings', GROUPS: { claude: 'Claude', codex: 'Codex' }, providers: () => [],
    api: (url, options = {}) => { calls.push({ url, options }); return responder(url, options); },
  });
  vm.runInContext(compactSource, context, { filename: 'public/js/compact.js' });
  vm.runInContext(settingsSource, context, { filename: 'public/js/settings.js' });
  return { get, calls, run: code => vm.runInContext(code, context), respond: next => { responder = next; } };
}

test('O3:原生 legend 不浮动进 grid，checked/focus 由事件 class 同步，不依赖 :has', () => {
  assert.match(profilesCss, /\.profiles-apps \{ display: block;/);
  assert.match(profilesCss, /\.profiles-apps legend \{ float: none; width: auto; white-space: nowrap;/);
  assert.doesNotMatch(profilesCss, /:has\(/, '所有动态状态都由 JS 维护，WebKit 不靠重新计算 :has');
  const h = harness(), claude = h.get('profiles-app-claude'), codex = h.get('profiles-app-codex');
  assert.equal(claude.parentElement.classList.contains('is-checked'), true, '初始化读取真实 checked 属性');
  assert.equal(codex.parentElement.classList.contains('is-checked'), false);
  codex.checked = true; codex.dispatch('change');
  assert.equal(codex.parentElement.classList.contains('is-checked'), true);
  codex.checked = false; codex.dispatch('change');
  assert.equal(codex.parentElement.classList.contains('is-checked'), false);
  claude.checked = false; h.run('profilesRender()');
  assert.equal(claude.parentElement.classList.contains('is-checked'), false, '程序改选后重绘也能同步');
  codex.focusVisible = false; codex.focus();
  assert.equal(codex.parentElement.classList.contains('is-focused'), false, '鼠标聚焦不冒充键盘焦点');
  codex.dispatch('keydown');
  assert.equal(codex.parentElement.classList.contains('is-focused'), true, '已有鼠标焦点转为键盘操作仍显示焦点环');
  codex.parentElement.dispatch('pointerdown');
  assert.equal(codex.parentElement.classList.contains('is-focused'), false);
  codex.focusVisible = true; codex.focus();
  assert.equal(codex.parentElement.classList.contains('is-focused'), true);
  codex.blur();
  assert.equal(codex.parentElement.classList.contains('is-focused'), false);
});

test('O4:正常 Key 显示当前账号，作用域进 title；失效与旧服务警示仍可见', () => {
  const h = configHarness();
  h.run('renderCompactKeys()');
  assert.equal(h.get('compact-key-hint').textContent, '跟随渠道当前 Key：当前账号');
  assert.match(h.get('compact-key-hint').title, /渠道切换当前账号后压缩也会跟随/);
  h.run("compactDraft.key_id = 'k2'; renderCompactKeys()");
  assert.equal(h.get('compact-key-hint').textContent, '固定 Key：固定账号');
  assert.match(h.get('compact-key-hint').title, /只影响两条压缩规则，不切换渠道当前账号/);
  h.run("compactDraft.key_id = 'removed'; renderCompactKeys()");
  assert.match(h.get('compact-key-hint').textContent, /不可用.*选择仍保留.*不会自动替换/);
  assert.equal(h.get('compact-key').value, 'removed');
  assert.equal(h.get('compact-key-hint').classList.contains('is-warning'), true);
  h.run('state.compact.key_selection_supported = false; renderCompactKeys()');
  assert.match(h.get('compact-key-hint').textContent, /更新服务后可用.*草稿保留.*不能提交给旧服务/);
  assert.equal(h.get('compact-key').disabled, true);
  h.run("state.compact.key_selection_supported = true; compactDraft.key_id = ''; renderCompactKeys()");
  assert.equal(h.get('compact-key-hint').classList.contains('is-warning'), false);
  assert.equal(h.calls.length, 0, '文案渲染不新增请求');
});

test('O4:窗口首行突出层与数值，路径进 title，真实覆盖和重开语义不隐藏', () => {
  const h = configHarness();
  const w = { scope: 'global', value: 400, target: '/project/.claude/settings.json', configured: { source: 'project', value: 300 },
    coverage: { project_checked: true, overridden_by: 'project', environment_override: true }, warnings: ['额外警示'],
    layers: [{ scope: 'global', value: 400, file: '/project/.claude/settings.json', exists: true }] };
  h.run(`renderCompactWindow(${JSON.stringify(w)})`);
  assert.equal(h.get('window-current').textContent, '所选用户全局层：400 · 磁盘生效：项目层 300');
  assert.doesNotMatch(h.get('window-current').textContent, /settings\.json/);
  assert.match(h.get('window-current').title, /\/project\/\.claude\/settings\.json.*不是运行中会话的实测值.*autoCompactWindow = 400/);
  assert.match(h.get('window-coverage-text').textContent, /被项目层覆盖.*保存本层不会改变.*存在环境覆盖/);
  assert.equal(h.get('window-coverage').classList.contains('offline'), true);
  assert.match(h.get('window-warnings').textContent, /额外警示/);
  assert.match(h.get('window-restart').textContent, /不会热改.*新开会话.*claude --continue.*\/autocompact/);
  h.get('window-value').value = '777';
  w.coverage = { project_checked: false };
  h.run(`renderCompactWindow(${JSON.stringify(w)}, true)`);
  assert.equal(h.get('window-value').value, '777', '短文案不得覆盖未保存草稿');
  assert.equal(h.get('window-coverage-text').textContent, '未指定项目：项目与本地层覆盖尚未检查。');
  assert.match(h.get('window-coverage-text').title, /不能判断某个项目的有效窗口/);
  assert.equal(h.get('window-coverage').classList.contains('offline'), false);
});

test('O4:尚无保存结果折叠四项，真实结果展开并继续区分写盘、加载与重开', () => {
  const h = configHarness();
  assert.match(h.get('compact-status').innerHTML, /<details class="cfg-more ss-details"><summary>尚无保存结果<\/summary>/);
  assert.equal((h.get('compact-status').innerHTML.match(/尚未保存过/g) || []).length, 4);
  h.run('compactOutcome = { saved: true, written: true, loaded: true, restart: false }; renderSplitStatus()');
  assert.doesNotMatch(h.get('compact-status').innerHTML, /ss-details/);
  assert.match(h.get('compact-status').innerHTML, /已写盘：配置已写入服务端磁盘/);
  assert.match(h.get('compact-status').innerHTML, /服务已加载：运行中的服务按新压缩规则分发/);
  assert.match(h.get('compact-status').innerHTML, /客户端需重开：不需要/);
  assert.match(h.get('window-status').innerHTML, /ss-details/, '两块状态独立');
  h.run('windowOutcome = { saved: true, written: true, restart: true }; renderWindowStatus()');
  assert.doesNotMatch(h.get('window-status').innerHTML, /ss-details/);
  assert.match(h.get('window-status').innerHTML, /服务已加载：不适用.*运行中的会话不会热改/);
  assert.match(h.get('window-status').innerHTML, /客户端需重开：需要/);
});

test('O4:设置读取成功只显示事实，边界说明进 title；失败仍保留结果与下一步', async () => {
  const h = configHarness();
  h.respond(async url => url === '/api/backups' ? { dirs: [], keep: 5 } : { settings: { total_deadline_ms: 400 }, providers: [] });
  await h.run('loadBackups()'); await h.run('loadHealth()');
  assert.equal(h.get('backup-status').textContent, '已清点 0 个备份池 · 12:34:56');
  assert.match(h.get('backup-status').title, /不含任何配置正文/);
  assert.equal(h.get('health-status').textContent, '已读取 · 12:34:56');
  assert.match(h.get('health-status').title, /不代表上游此刻连得通/);
  const previous = h.get('health-body').innerHTML;
  h.respond(async () => { throw new Error('test read failure'); });
  await h.run('loadBackups()'); await h.run('loadHealth()');
  assert.match(h.get('backup-status').textContent, /读取失败.*下面是 12:34:56.*重新清点备份/);
  assert.equal(h.get('backup-dirs').classList.contains('is-stale'), true);
  assert.match(h.get('health-status').textContent, /读取失败.*可能已过期/);
  assert.equal(h.get('health-body').innerHTML, previous);
  assert.ok(h.calls.every(call => !call.options.method), '只读加载不得新增写请求');
});

test('O4:备份仅显示实际删除警示，异常文件和预测结果的警告仍保留', () => {
  const h = configHarness();
  const d = { id: 'claude', label: 'Claude 设置', ok: true, backups: [], total: 0, next_delete: [] };
  assert.doesNotMatch(h.run(`backupDirCard(${JSON.stringify(d)}, 5)`), /bk-next|下一次备份会删/);
  d.next_delete = ['old-backup']; d.unparsable = [{ name: 'odd-backup', reason: 'invalid time' }];
  const card = h.run(`backupDirCard(${JSON.stringify(d)}, 5)`);
  assert.match(card, /bk-next has-next.*下一次备份会删：old-backup/);
  assert.match(card, /解析不出时间.*odd-backup.*照样占保留池名额/);
  d.ok = false; d.error = { code: 'ENOENT' };
  assert.match(h.run(`backupDirCard(${JSON.stringify(d)}, 5)`), /目录不存在.*没查成不等于零份备份/);
  const result = h.run(`previewBody(${JSON.stringify({ matched: { via: 'slot' }, selection: { predicted: { providerName: 'Alpha' } },
    candidates: [{ providerId: 'p1', providerName: 'Alpha', model: 'm1', wire: 'responses', eligible: true }], warnings: [{ message: '候选配置警告' }] })})`);
  assert.match(result, /^<dl class="config-facts">/);
  assert.match(result, /<dt>预测首选<\/dt><dd>Alpha<\/dd>/);
  assert.match(result, /不代表上游此刻连得通/);
  assert.match(result, /config-warnings.*候选配置警告/);
});

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
  // 原来这里是 doesNotMatch(/—<td>/),那个模式永远匹配不上(— 后面跟的是 </td>),等于没防。
  // 现在直接看时间格:有效的 created_at 必须带完整时间的 title,显示文本不能是 —。
  assert.match(rows, /<td class="profiles-when" title="2026-1[01]-\d\d \d\d:\d\d:\d\d">[^<—]+<\/td>/, 'created_at 有效时不能显示 —');
  // 修订号是内部值:首屏只给容量,修订号放 title(409 时仍对得上服务端)。
  assert.match(h.get('profiles-revision-hint').textContent, /已保存 2 \/ 30 个方案/);
  assert.match(h.get('profiles-revision-hint').title, /方案修订 pr-1/);
  assert.match(h.get('profiles-revision-hint').title, /槽位修订 sr-1/);
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
  // 策略给人话,原始枚举值留在 title。
  assert.match(body, /策略 轮询/);
  assert.match(body, /title="[^"]*策略 round_robin"/);
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

test('时间点按今天 / 今年 / 更早三档显示,完整时间放 title;缺失或解析不了显示 —', () => {
  const h = harness();
  const now = 'new Date(2026, 10, 6, 15, 0, 0)';
  assert.deepEqual(plain(h.run(`profilesWhen(new Date(2026, 10, 6, 9, 5, 7).toISOString(), ${now})`)), { text: '09:05:07', title: '2026-11-06 09:05:07' });
  assert.deepEqual(plain(h.run(`profilesWhen(new Date(2026, 1, 3, 8, 9, 10).getTime(), ${now})`)), { text: '02-03 08:09', title: '2026-02-03 08:09:10' });
  assert.deepEqual(plain(h.run(`profilesWhen(String(new Date(2024, 6, 3, 1, 2, 3).getTime()), ${now})`)), { text: '2024-07-03', title: '2024-07-03 01:02:03' });
  assert.deepEqual(plain(h.run(`profilesWhen(null, ${now})`)), { text: '—', title: '' });
  assert.deepEqual(plain(h.run(`profilesWhen('not-a-date', ${now})`)), { text: '—', title: '无法解析的时间：not-a-date' });
});

test('预览:控制台有渠道快照时显示渠道名,原始 id 留在 title', async () => {
  const h = await loaded();
  h.context.state = { providers: { claude: [{ id: 'pA', name: 'Alpha' }, { id: 'pB', name: 'Beta' }, { id: 'pC', name: 'Gamma' }] } };
  await h.run('profilesPreview(0)');
  const body = h.get('profiles-preview-body').innerHTML;
  assert.match(body, /渠道 Alpha · 模型 m1/);
  assert.match(body, /渠道 Beta · 模型 m2 · 备池 Gamma\/m3 · 策略 轮询/);
  assert.match(body, /title="渠道 pA · 模型 m1"/);
  assert.match(body, /title="渠道 pB · 模型 m2 · 备池 pC\/m3 · 策略 round_robin"/);
  for (const secret of ['secret-key-id', 'another-secret', 'key_id']) {
    assert.equal(body.includes(secret), false, `预览不能出现 ${secret}`);
  }
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
