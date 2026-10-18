'use strict';
// 控制台 API 模块(lib/http/console.js 的 createConsoleHandler)的独立回归。
//
// 为什么单开一份,而不是并进 ui.test.js / session-routing.test.js:
//   · ui.test.js 验的是**面板**(DOM、草稿、轮询),不碰服务端装配。
//   · session-routing / compact-* / slots / audit-fixes 各验自己那条业务,装配方式是"用主入口的 apiHandler"。
//   本文件要钉的是**装配契约本身** —— 模块被抽成显式 deps 的工厂之后,这三件事还能不能成立:
//     1) 活状态必须**就地**经 getter 读、经 setter 整份替换(不得在请求开始时快照);
//     2) 有 await 的分支,读到的现值必须是**读完请求体那一刻**的值;
//     3) 落盘失败时内存要退回旧值,且"回滚也失败"要如实报出去。
//   这三条都是"抽错一点就静默坏掉、且坏得很像正常"的类型,所以用真实 HTTP + 真实主入口
//   _state 来验,不自己造一套平行装配(那只能证明我造的这套自洽)。
//
// 不碰 8787/8788:全程 listen(0) 拿临时端口;不联网上游;不读真实客户端配置
// (临时 HOME + MIXR_DATA_DIR 由 scripts/run-tests.js 隔离)。
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-console-module-'));
process.env.HOME = TMP;
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude-settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex-config.toml');
process.env.MIXR_ZCODE_CONFIG = path.join(TMP, 'zcode-config.json');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXROUTER_PORT = '0';
process.env.MIXUI_PORT = '0';

const ROOT = path.join(__dirname, '..');
const mod = require('../mixrouter');
const { createConsoleHandler } = require('../lib/http/console');

let ui, uiPort;
const sockets = new Set();

function request(route, method = 'GET', body, { port = uiPort, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json; try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

const api = (route, method, body, opts) => request(route, method, body, opts);
const provider = (id, extra = {}) => ({ id, name: id, base_url: `http://127.0.0.1:1/${id}`, api_key: `sk-${id}`,
  enabled: true, models: ['shared-model'], model: 'shared-model', ...extra });
// slotsPublic 恒把五个 Claude 槽位摊出来(缺的补空),所以断言要看**槽位里的 provider**,
// 不能看名字列表 —— 名字列表在"表是空的"和"表配好了"两种情况下长得一样,判不出差别。
const slotProvider = (body, app, name) => (body.slots[app] || []).find(s => s.name === name)?.provider;

before(async () => {
  mod._state.store = { claude: [provider('pa'), provider('pb')], codex: [] };
  mod._state.routes = { rules: [], default: { provider: '', model: '' } };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.sessions.clear();
  mod._state.cooldowns = {};
  ui = await mod.listen(0, mod.apiHandler);
  ui.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  uiPort = ui.address().port;
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => { try { ui.closeAllConnections(); } catch {} ui.close(resolve); });
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  mod._state.store = { claude: [provider('pa'), provider('pb')], codex: [] };
  mod._state.routes = { rules: [], default: { provider: '', model: '' } };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.sessions.clear();
  mod._state.cooldowns = {};
  mod._state.resetPools();
});

// ---------------------------------------------------------------- 模块本体:require 无副作用
test('requiring the console module in a bare process starts no server and leaks no internal function', () => {
  // "require 不带副作用"这件事只能在没有别的东西跑着的进程里证明:本测试进程里节点测试框架
  // 自己就挂了 newListener/removeListener/warning,主入口在我们 require 之前也已经注册过别的东西,
  // 在本进程里数监听器会把别人的账算到它头上。所以开一个只 require 它一次的子进程来问。
  const probe = 'const m = require(process.argv[1]);'
    + 'process.stdout.write(JSON.stringify({'
    + ' keys: Object.keys(m),'
    + ' servers: process.getActiveResourcesInfo().filter(r => r === "TCPServerWrap").length,'
    + ' timers: process.getActiveResourcesInfo().filter(r => r === "Timeout").length'
    + '}));';
  const out = execFileSync(process.execPath, ['-e', probe, path.join(ROOT, 'lib', 'http', 'console.js')],
    { env: { ...process.env, HOME: TMP, MIXR_DATA_DIR: TMP }, encoding: 'utf8', timeout: 20000 });
  const result = JSON.parse(out);
  assert.deepEqual(result.keys, ['createConsoleHandler'], '工厂是唯一导出:不额外泄出内部函数,免得别处绕过 deps 直接调');
  assert.equal(result.servers, 0, 'require 这一下不许起监听');
  assert.equal(result.timers, 0, 'require 这一下不许装定时器');
});

// ---------------------------------------------------------------- live read
test('every read goes through the live getter, so a whole-object replacement is visible at once', async () => {
  const before = await api('/api/state');
  assert.equal(before.status, 200);
  assert.deepEqual(before.json.providers.claude.map(p => p.id), ['pa', 'pb']);
  assert.equal(slotProvider(before.json, 'claude', 'main'), '', '夹具:起始槽位表是空的');
  assert.deepEqual(before.json.routes.rules, []);

  // 整份替换四条活状态 —— 与 _state 的 setter 一致(不是就地改字段)。
  // 若工厂在创建时把 store/routes/slotMap/current 快照成了局部变量,这里读到的还是旧的那一份。
  mod._state.store = { claude: [provider('pz')], codex: [] };
  mod._state.routes = { rules: [{ id: 'rz', match: 'm', provider: 'pz', enabled: true }], default: { provider: '', model: '' } };
  mod._state.slotMap = { claude: { main: { provider: 'pz', model: 'shared-model' } }, codex: {} };
  mod._state.current = { ...mod._state.current, claude: 'pz' };

  const after = await api('/api/state');
  assert.equal(after.status, 200);
  assert.deepEqual(after.json.providers.claude.map(p => p.id), ['pz'], '渠道库整份替换后必须立刻可见');
  assert.deepEqual(after.json.routes.rules.map(r => r.id), ['rz'], '路由整份替换后必须立刻可见');
  assert.equal(slotProvider(after.json, 'claude', 'main'), 'pz', '槽位表整份替换后必须立刻可见');
  assert.equal(after.json.current.claude, 'pz', 'current 整份替换后必须立刻可见');
});

test('a read never mutates the live state it reports', async () => {
  mod._state.slotMap = { claude: { main: { provider: 'pa', model: 'shared-model' } }, codex: {} };
  mod._state.routes = { rules: [{ id: 'r1', match: 'm', provider: 'pa', enabled: true }], default: { provider: '', model: '' } };
  const storeRef = mod._state.store, routesRef = mod._state.routes, slotRef = mod._state.slotMap;
  const routesCopy = JSON.stringify(routesRef), slotCopy = JSON.stringify(slotRef), storeCopy = JSON.stringify(storeRef);

  assert.equal((await api('/api/state')).status, 200);
  assert.equal((await api('/api/slots')).status, 200);
  assert.equal((await api('/api/sessions')).status, 200);

  // 只读端点碰完这些表之后,对象身份与内容都不该变(把预览/渲染写进活状态是个安静的数据损坏)
  assert.equal(mod._state.store, storeRef);
  assert.equal(mod._state.routes, routesRef);
  assert.equal(mod._state.slotMap, slotRef);
  assert.equal(JSON.stringify(routesRef), routesCopy);
  assert.equal(JSON.stringify(slotRef), slotCopy);
  assert.equal(JSON.stringify(storeRef), storeCopy);
});

// ---------------------------------------------------------------- live write
test('a write commits through the setter and is visible to the next live read', async () => {
  const put = await api('/api/slots', 'PUT', { claude: { subagent: { provider: 'pa', model: 'shared-model' } } });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.ok, true);
  assert.equal(slotProvider(put.json, 'claude', 'subagent'), 'pa', '写响应里的槽位表取自刚提交的活状态');

  // 关键:替换的是**活状态那个对象**,不是工厂里的一份副本 —— 下一次读必须看得见
  assert.equal(mod._state.slotMap.claude.subagent.provider, 'pa');
  assert.equal(slotProvider((await api('/api/slots')).json, 'claude', 'subagent'), 'pa');
});

test('a successful write publishes the created record through the live store, not a stale snapshot', async () => {
  // 渠道写入走 withStoreRollback(主入口注入):成功时新渠道必须已经进了活 store,
  // 而响应体里的 id 要与 store 里那一条对得上 —— 两边不一致就是"回了 id 却没真写进去"。
  const created = await api('/api/providers', 'POST', { app: 'claude', name: 'fresh', base_url: 'https://api.example.com/v1', api_key: 'sk-fresh-000000' });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.json.ok, true);
  assert.equal(typeof created.json.id, 'string');
  const inStore = mod._state.store.claude.find(p => p.id === created.json.id);
  assert.ok(inStore, '响应里的 id 必须真的在活 store 里');
  assert.equal(inStore.name, 'fresh');
  assert.equal((await api('/api/state')).json.providers.claude.some(p => p.id === created.json.id), true);
});

// ---------------------------------------------------------------- async boundary
test('a slow session-routing PUT is judged against the revision read after the body arrived', async () => {
  // 装配契约的硬要求(见模块头注释):PUT/POST 先 await readObject(),**读完**再取现值。
  // 若在请求开场就把 revision 快照成局部变量,下面这次慢 PUT 会拿旧 revision 通过校验,
  // 把别人刚存好的配置覆盖掉 —— 而且是静默覆盖,HTTP 200。
  const key = 'cc:slow-routing';
  mod._state.sessions.set(key, { providerId: '', model: '', ruleId: '', label: '慢请求', kind: 'header', app: 'claude',
    created: Date.now(), lastUsed: Date.now(), reqs: 0, inTok: 0, outTok: 0, pinned: false, routing: { keys: {}, slots: {} } });
  const route = `/api/sessions/${encodeURIComponent(key)}/routing`;
  const original = (await api(route)).json;
  assert.equal(typeof original.revision, 'string');

  // 慢 PUT:先只发一个字节,等服务端进到这条路由、停在 await 读体上;此时另存一份新配置
  // (revision 因此变化),再把这个 PUT 的体补完。
  const body = JSON.stringify({ routing: { keys: {}, slots: {} }, expected_revision: original.revision });
  let finish;
  const arrived = new Promise(resolve => {
    const listener = req => {
      if (!req.url.endsWith('/routing') || req.method !== 'PUT') return;
      ui.removeListener('request', listener);
      resolve();
    };
    ui.on('request', listener);
  });
  const pending = new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: uiPort, path: route, method: 'PUT',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('fixture slow PUT timed out')));
    req.on('error', reject);
    req.write(body.slice(0, 1));
    let done = false;
    finish = () => { if (!done) { done = true; req.end(body.slice(1)); } };
  });

  await arrived;
  // 别人在这期间存了一份新配置:revision 变了
  const saved = await api(route, 'PUT', { routing: { keys: {}, slots: { subagent: { provider: 'pa' } } },
    expected_revision: original.revision });
  assert.equal(saved.status, 200, saved.text);
  assert.notEqual(saved.json.revision, original.revision, '夹具:第二次保存必须真的改了 revision');

  finish();
  const result = await pending;
  assert.equal(result.status, 409, `慢 PUT 必须按读体后的最新 revision 判为冲突,实得 ${result.status} ${result.text}`);
  assert.match(JSON.parse(result.text).error, /会话配置已变化/);

  // 而且要能证明"最新那份配置没被旧请求盖掉"
  const final = (await api(route)).json;
  assert.deepEqual(final.routing, saved.json.routing, '已保存的配置不许被慢 PUT 覆盖');
  assert.equal(final.revision, saved.json.revision);
});

// ---------------------------------------------------------------- rollback
test('a failed slots write keeps memory on the old value instead of the rejected new one', async () => {
  mod._state.slotMap = { claude: { main: { provider: 'pa', model: 'ORIGINAL' } }, codex: {} };
  const ok = await api('/api/slots', 'PUT', { claude: { main: { provider: 'pa', model: 'ORIGINAL' } } });
  assert.equal(ok.status, 200, ok.text);

  // 让这一次落盘失败:数据目录置为不可写(真实 EACCES,不打桩)。落盘失败时接口必须回 500,
  // 且**内存里仍是旧值** —— 否则就是"保存失败"的弹窗下面新值已经生效,重启后又变回去。
  fs.chmodSync(TMP, 0o500);
  let failed;
  try {
    failed = await api('/api/slots', 'PUT', { claude: { main: { provider: 'pa', model: 'CHANGED' } } });
  } finally {
    fs.chmodSync(TMP, 0o700);
  }
  assert.equal(failed.status, 500, `落盘失败必须明确回 500,实得 ${failed.status} ${failed.text}`);
  assert.match(JSON.parse(failed.text).error, /写入槽位失败/);
  assert.equal(mod._state.slotMap.claude.main.model, 'ORIGINAL',
    '落盘失败后内存必须退回旧值:盘上没写进去而内存改了,重启后两边会分叉');
  assert.equal(slotProvider((await api('/api/slots')).json, 'claude', 'main'), 'pa', '之后的读也要看到旧值(provider 未变)');
  assert.equal((await api('/api/slots')).json.slots.claude.find(s => s.name === 'main').model, 'ORIGINAL');
});

test('a failed channel delete rolls memory back and reports rollback failure honestly', async () => {
  // DELETE 会动三处(渠道库 / 槽位表 / 路由规则),要求三处**一起**回到原样:只回滚渠道数组
  // 比不回滚更坏 —— 它让人以为已经回滚过了(见 backup-api 的同路径用例,那条验的是别处先失败)。
  // 这里用"数据目录不可写"一次性让三处落盘全失败,于是连回滚自身的写盘也失败 ——
  // 那是"回滚也失败"那条分支。要钉的是:即便如此,内存仍然回到旧值,且回复如实说明盘上不一致。
  mod._state.store = { claude: [provider('pa'), provider('pb')], codex: [] };
  mod._state.slotMap = { claude: { main: { provider: 'pb' }, haiku: { provider: 'pb' } }, codex: {} };
  mod._state.routes = { rules: [{ id: 'rp', match: 'm', provider: 'pb', enabled: true }], default: { provider: '', model: '' } };
  const storeBefore = JSON.stringify(mod._state.store);
  const slotBefore = JSON.stringify(mod._state.slotMap);
  const routesBefore = JSON.stringify(mod._state.routes);

  fs.chmodSync(TMP, 0o500);
  let failed;
  try {
    failed = await api('/api/providers/pb', 'DELETE');
  } finally {
    fs.chmodSync(TMP, 0o700);
  }

  assert.equal(failed.status, 500, `删除失败必须明确回 500,实得 ${failed.status} ${failed.text}`);
  assert.match(failed.json.error, /删除渠道失败/);
  // 三处内存都要回到原样 —— 这是"回滚失败也不能让内存停在半改状态"的核心断言
  assert.equal(JSON.stringify(mod._state.store), storeBefore, '渠道库要回滚(含顺序)');
  assert.equal(JSON.stringify(mod._state.slotMap), slotBefore, '槽位表要回滚');
  assert.equal(JSON.stringify(mod._state.routes), routesBefore, '路由规则要回滚');
  // 目录不可写时回滚自己的写盘也失败:必须如实说,不能回一句"删除失败"让人以为盘上没动过
  assert.match(failed.json.error, /回滚也失败/, '回滚写盘失败要明确说出来');
  assert.match(failed.json.error, /盘上已不一致/);
  // 活状态读出来也必须是旧的
  const state = await api('/api/state');
  assert.deepEqual(state.json.providers.claude.map(p => p.id), ['pa', 'pb']);
  assert.equal(slotProvider(state.json, 'claude', 'main'), 'pb');
});

test('a channel-write failure rolls the live store back to its exact previous shape', async () => {
  const before = JSON.stringify(mod._state.store);
  const beforeIds = mod._state.store.claude.map(p => p.id);

  fs.chmodSync(TMP, 0o500);
  let failed;
  try {
    failed = await api('/api/providers', 'POST', { app: 'claude', name: 'doomed', base_url: 'https://api.example.com/v1', api_key: 'sk-doomed-000000' });
  } finally {
    fs.chmodSync(TMP, 0o700);
  }

  assert.equal(failed.status, 500, `写渠道库失败必须回 500,实得 ${failed.status} ${failed.text}`);
  assert.match(failed.json.error, /写入渠道库失败|写入渠道/);
  // 失败即回滚:内存里不许留下那个没落盘的渠道(否则 /api/state 看得见它、重启后又消失)
  assert.equal(JSON.stringify(mod._state.store), before, '渠道库要回到改动前的完全相同形状');
  assert.deepEqual((await api('/api/state')).json.providers.claude.map(p => p.id), beforeIds);
});
