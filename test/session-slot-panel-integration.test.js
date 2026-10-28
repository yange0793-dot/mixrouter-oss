'use strict';
// 会话级五槽面板的端到端回归:控制台以后给每个会话配 main/opus/sonnet/haiku/subagent,
// 复用的就是既有的 GET/PUT /api/sessions/:key/routing。这里不看 UI 源码,只走真实
// loopback HTTP + 临时 HOME/data + mock 上游,钉住面板依赖的那几条行为:
//
//   · 两个完整 cc: 会话用同名五槽,各自落到自己的渠道与模型,互不串味;
//   · 没有覆盖的会话仍按全局槽位表走;
//   · 保存只写本会话:全局 slots、渠道 active_key、其他会话的覆盖与版本一字节不动;
//   · 保存先落盘,新进程启动后照样读得到、照样能按会话分流;
//   · 列表接口逐行给出 required(保存的要求)与 actual(最近真实落点),面板直接读这两层。
//
// 压缩分流优先于会话覆盖已有同版充分证据(test/session-routing.test.js 的
// 「compact fixed key and content routing take precedence over all session overrides」),
// 这里不重复跑同一用例。

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-session-slot-panel-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXR_CONV_RETRIES = '1';
process.env.MIXR_MAX_ATTEMPTS = '3';
const mod = require('../mixrouter');

// Claude Code 五个固定槽。别名写进客户端 env,请求模型名就是它们。
const SLOTS = ['main', 'opus', 'sonnet', 'haiku', 'subagent'];
const ALIAS = {
  main: 'mixr-main', opus: 'mixr-opus', sonnet: 'mixr-sonnet',
  haiku: 'mixr-haiku', subagent: 'mixr-subagent',
};
const EMPTY = { keys: {}, slots: {} };

// 完整会话 id(Claude Code 传的 x-claude-code-session-id 就是这种 UUID),不是短标签。
const SESSION_A = '1f2e3d4c-5a6b-7c8d-9e0f-112233445566';
const SESSION_B = 'd4c3b2a1-0f9e-4d8c-b7a6-554433221100';
const SESSION_C = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const sessionKey = id => 'cc:' + id;
const routingPath = id => `/api/sessions/${encodeURIComponent(sessionKey(id))}/routing`;

const secret = (providerId, keyId = 'active') => `fixture-panel-${providerId}-${keyId}`;
const hits = [];
let ui, proxy, upstream, base, nextMarker = 0;

function request(port, route, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c)); res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
        resolve({ status: res.statusCode, headers: res.headers, data: parsed, text });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.on('error', reject); req.end(data);
  });
}
const api = (route, method = 'GET', body, port = ui.address().port) => request(port, route, method, body);

function successSse() {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return event('message_start', { type: 'message_start', message: {
    id: 'mock', type: 'message', role: 'assistant', content: [], usage: {} } })
    + event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} })
    + event('message_stop', { type: 'message_stop' });
}

// 一条 Claude Code 风格的请求:身份只靠官方会话头,模型名就是槽位别名。
function send(id, { model = 'mixr-main', port = proxy.address().port } = {}) {
  const marker = `panel-marker-${++nextMarker}-end`;
  const payload = { model, stream: false, max_tokens: 32,
    messages: [{ role: 'user', content: marker }] };
  return request(port, '/v1/messages', 'POST', payload, { 'x-claude-code-session-id': id })
    .then(result => ({ ...result, marker,
      hits: hits.filter(hit => JSON.stringify(hit.body).includes(marker)) }));
}

function makeProvider(id, models) {
  return { id, name: `Provider ${id}`, enabled: true, base_url: `${base}/${id}`,
    wire_api: 'anthropic', api_key: secret(id), active_key: 'active', models,
    keys: [
      { id: 'active', label: 'Active', key: secret(id, 'active') },
      { id: 'alt', label: 'Alt', key: secret(id, 'alt') },
    ] };
}

// 全局槽位表:五个槽都绑同一个全局渠道,但各自一个模型。会话覆盖必须能整个替换它,
// 保存又不能把它改掉。
const globalSlotMap = () => ({
  claude: Object.fromEntries(SLOTS.map(name => [name, { provider: 'g', model: `g-${name}-model` }])),
  codex: {},
});
const globalModels = () => SLOTS.map(name => `g-${name}-model`);

// 一次配满五槽:每个槽一个独立渠道、一个独立模型,两个会话用 a-/b- 前缀互不相同。
const fiveSlotRouting = prefix => ({
  keys: {},
  slots: Object.fromEntries(SLOTS.map(name => [name,
    { provider: `${prefix}-${name}`, model: `${prefix}-${name}-model` }])),
});

function assertLanded(result, providerId, model) {
  assert.equal(result.status, 200, result.text);
  assert.equal(result.hits.length, 1, `expected exactly one upstream hit for ${providerId}@${model}`);
  const hit = result.hits[0];
  assert.equal(hit.url, `/${providerId}/v1/messages`, `landed on ${hit.url}, expected ${providerId}`);
  assert.equal(hit.body.model, model);
  assert.equal(hit.headers.authorization, 'Bearer ' + secret(providerId));
  assert.equal(hit.headers['x-api-key'], secret(providerId));
}

async function readRouting(id, port) {
  const result = await api(routingPath(id), 'GET', undefined, port);
  assert.equal(result.status, 200, `GET routing: ${result.text}`);
  assert.equal(typeof result.data.revision, 'string');
  return result.data;
}

async function putRouting(id, routing, { revision, port } = {}) {
  const expected_revision = revision === undefined ? (await readRouting(id, port)).revision : revision;
  return api(routingPath(id), 'PUT', { routing, expected_revision }, port);
}

// 面板的保存路径:会话记录先由一条真实请求建出来(GET/PUT 对不存在的会话都回 404),
// 再按列表/表单里读到的 revision 提交五槽配置。
async function configure(id, routing) {
  const opened = await send(id);
  assert.equal(opened.status, 200, opened.text);
  const current = await readRouting(id);
  const saved = await putRouting(id, routing, { revision: current.revision });
  assert.equal(saved.status, 200, `PUT routing: ${saved.text}`);
  assert.equal(saved.data.ok, true);
  assert.deepEqual(saved.data.routing, routing);
  return saved.data;
}

function saveFixtureFiles() {
  for (const [name, value] of [
    ['providers.json', { version: 2, current: { claude: null, codex: null }, ...mod._state.store }],
    ['routes.json', mod._state.routes], ['slots.json', mod._state.slotMap],
    ['sessions.json', { version: 1, bindings: Object.fromEntries(mod._state.sessions) }],
  ]) fs.writeFileSync(path.join(TMP, name), JSON.stringify(value));
}

function diskSessions() {
  return JSON.parse(fs.readFileSync(path.join(TMP, 'sessions.json'), 'utf8')).bindings;
}

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      hits.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(successSse());
    });
  });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${upstream.address().port}`;
  ui = await mod.listen(0, mod.apiHandler);
  proxy = await mod.listen(0, mod.proxyHandler);
});

beforeEach(() => {
  const providers = [makeProvider('g', globalModels()),
    ...SLOTS.map(name => makeProvider(`a-${name}`, [`a-${name}-model`])),
    ...SLOTS.map(name => makeProvider(`b-${name}`, [`b-${name}-model`]))];
  mod._state.store = { claude: providers, codex: [] };
  mod._state.routes = { rules: [], default: {} };
  mod._state.slotMap = globalSlotMap();
  mod._state.sessions.clear();
  mod._state.cooldowns = {};
  mod._state.resetPools();
  hits.length = 0;
  saveFixtureFiles();
});

test('两个完整 cc: 会话各自配满五槽:同名 mixr-* 分别落到本会话的渠道与模型', async () => {
  const a = fiveSlotRouting('a');
  const b = fiveSlotRouting('b');
  await configure(SESSION_A, a);
  await configure(SESSION_B, b);
  const globals = structuredClone(mod._state.slotMap);
  hits.length = 0;

  // 逐槽交替发:A、B 用同一个别名,但必须各回各的渠道。交错顺序能暴露任何"后配的覆盖
  // 顶掉先配的"或按槽名共享一份覆盖的实现(那正是面板最怕的串味)。
  for (const slot of SLOTS) {
    assertLanded(await send(SESSION_A, { model: ALIAS[slot] }), `a-${slot}`, `a-${slot}-model`);
    assertLanded(await send(SESSION_B, { model: ALIAS[slot] }), `b-${slot}`, `b-${slot}-model`);
  }
  assert.equal(hits.length, 10, 'each alias request must produce exactly one upstream hit');
  // 读覆盖不写槽位表:全局五个槽还是启动时那张表。
  assert.deepEqual(mod._state.slotMap, globals);
});

test('没有覆盖的会话仍按全局五槽落点,不会被已配置会话的覆盖带走', async () => {
  await configure(SESSION_A, fiveSlotRouting('a'));
  await configure(SESSION_B, fiveSlotRouting('b'));
  // C 有真实会话记录(所以不是"会话不存在"),只是没有任何覆盖。
  assert.equal((await send(SESSION_C)).status, 200);
  hits.length = 0;

  for (const slot of SLOTS)
    assertLanded(await send(SESSION_C, { model: ALIAS[slot] }), 'g', `g-${slot}-model`);

  const row = (await api('/api/sessions')).data.sessions.find(s => s.key === sessionKey(SESSION_C));
  assert.ok(row, 'uncovered session must still be listed');
  assert.deepEqual(row.required.routing, EMPTY);
  assert.equal(row.required.slots, 0);
});

test('五槽保存只写本会话:全局槽位表、渠道 active_key 与其他会话的覆盖/版本不动', async () => {
  const opened = await Promise.all([SESSION_A, SESSION_B, SESSION_C].map(id => send(id)));
  for (const result of opened) assert.equal(result.status, 200, result.text);

  const bBefore = await readRouting(SESSION_B);
  const cBefore = await readRouting(SESSION_C);
  const slotsBefore = structuredClone((await api('/api/slots')).data.slots);
  const providersBefore = structuredClone((await api('/api/state')).data.providers);
  const storeBefore = structuredClone(mod._state.store);

  const a = fiveSlotRouting('a');
  const b = fiveSlotRouting('b');
  const savedA = await putRouting(SESSION_A, a);
  assert.equal(savedA.status, 200, savedA.text);
  const savedB = await putRouting(SESSION_B, b);
  assert.equal(savedB.status, 200, savedB.text);
  // putRouting 回的是 HTTP 包({status, data, text}),版本号在 data.revision 上。
  assert.equal(typeof savedB.data.revision, 'string');
  assert.notEqual(bBefore.revision, savedB.data.revision);

  // 全局与非目标会话:一字节不动。
  assert.deepEqual((await api('/api/slots')).data.slots, slotsBefore);
  assert.deepEqual((await api('/api/state')).data.providers, providersBefore);
  assert.deepEqual(mod._state.store, storeBefore);
  assert.deepEqual(await readRouting(SESSION_C), cBefore);

  // 再保存 A(改一个模型):B 的覆盖与版本仍不动。
  const changedA = structuredClone(a);
  changedA.slots.haiku.model = 'a-haiku-v2';
  const resavedA = await putRouting(SESSION_A, changedA, { revision: savedA.data.revision });
  assert.equal(resavedA.status, 200, resavedA.text);
  assert.notEqual(resavedA.data.revision, savedA.data.revision);
  assert.deepEqual(await readRouting(SESSION_B), { routing: b, revision: savedB.data.revision });

  // 落盘内容按会话键各存各的,和内存一致。PUT 走 mutateSessions,保存前已同步落盘,
  // 所以 C 这条没有配置的记录也必须在盘上(而不是等 1s 去抖)。
  const disk = diskSessions();
  assert.deepEqual(disk[sessionKey(SESSION_A)].routing, changedA);
  assert.deepEqual(disk[sessionKey(SESSION_B)].routing, b);
  assert.ok(disk[sessionKey(SESSION_C)], 'unconfigured session record must be persisted too');
  assert.equal(disk[sessionKey(SESSION_C)].routing, undefined);

  // 保存后新请求各自生效:haiku 走 A 改过的模型,B 保持原样。
  hits.length = 0;
  assertLanded(await send(SESSION_A, { model: 'mixr-haiku' }), 'a-haiku', 'a-haiku-v2');
  assertLanded(await send(SESSION_B, { model: 'mixr-haiku' }), 'b-haiku', 'b-haiku-model');
  assert.deepEqual(mod._state.store, storeBefore, 'per-session saves must not touch provider credentials');
});

test('会话列表逐行给出 required 与 actual:面板可直接读同名五槽与最近真实落点', async () => {
  const a = fiveSlotRouting('a');
  const b = fiveSlotRouting('b');
  const savedA = await configure(SESSION_A, a);
  const savedB = await configure(SESSION_B, b);
  hits.length = 0;
  assertLanded(await send(SESSION_A, { model: 'mixr-opus' }), 'a-opus', 'a-opus-model');
  assertLanded(await send(SESSION_B, { model: 'mixr-haiku' }), 'b-haiku', 'b-haiku-model');

  const list = (await api('/api/sessions')).data.sessions;
  const rowA = list.find(s => s.key === sessionKey(SESSION_A));
  const rowB = list.find(s => s.key === sessionKey(SESSION_B));
  assert.ok(rowA && rowB, 'both full session keys must appear in the list');

  for (const [row, routing, saved, provider, model, slot] of [
    [rowA, a, savedA, 'a-opus', 'a-opus-model', 'opus'],
    [rowB, b, savedB, 'b-haiku', 'b-haiku-model', 'haiku'],
  ]) {
    assert.deepEqual(row.required.routing, routing);
    assert.equal(row.required.slots, SLOTS.length);
    assert.equal(row.required.keys, 0);
    assert.equal(row.required.revision, saved.revision);
    assert.deepEqual(row.routing, routing);
    assert.equal(row.routing_revision, saved.revision);
    assert.equal(row.configured, true);
    // actual 是最近一次真实请求的落点,不是预览;槽位请求也要如实记下槽名。
    assert.equal(row.actual_source, 'request');
    assert.equal(row.actual.provider, provider);
    assert.equal(row.actual.model, model);
    assert.equal(row.actual.slot, slot);
  }
  // 同名五槽在两条会话里必须是两份不同配置。
  assert.notDeepEqual(rowA.required.routing, rowB.required.routing);

  // 面板/接口回包里不能出现任何上游凭据。
  const text = (await api('/api/sessions')).text;
  for (const provider of mod._state.store.claude)
    for (const key of provider.keys) assert.equal(text.includes(key.key), false);
});

async function restartFixture() {
  const program = `const mod = require(${JSON.stringify(path.resolve(__dirname, '../mixrouter'))});
    Promise.all([mod.listen(0, mod.apiHandler), mod.listen(0, mod.proxyHandler)]).then(servers => {
      process.send({ ui: servers[0].address().port, proxy: servers[1].address().port });
      process.on('message', message => {
        if (message !== 'close') return;
        for (const server of servers) { server.close(); if (server.closeAllConnections) server.closeAllConnections(); }
        process.exit(0);
      });
    }).catch(error => { console.error(error.message); process.exit(1); });`;
  const child = spawn(process.execPath, ['-e', program], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, MIXROUTER_PORT: '0', MIXUI_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.resume();
  try {
    const ports = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture restart timed out')), 5000);
      child.once('message', ports => { clearTimeout(timer); resolve(ports); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture exited ${code}: ${stderr}`)); });
    });
    return { ...ports, close: () => new Promise(resolve => {
      child.once('exit', resolve);
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000); timer.unref();
      child.once('exit', () => clearTimeout(timer));
      child.send('close');
    }) };
  } catch (error) { child.kill('SIGKILL'); throw error; }
}

test('五槽配置保存即落盘:新进程按各自会话恢复,未覆盖会话仍走全局', async () => {
  const a = fiveSlotRouting('a');
  const b = fiveSlotRouting('b');
  const savedA = await configure(SESSION_A, a);
  const savedB = await configure(SESSION_B, b);
  const globals = structuredClone((await api('/api/slots')).data.slots);

  const fresh = await restartFixture();
  try {
    assert.deepEqual(await readRouting(SESSION_A, fresh.ui), { routing: a, revision: savedA.revision });
    assert.deepEqual(await readRouting(SESSION_B, fresh.ui), { routing: b, revision: savedB.revision });
    assert.deepEqual((await api('/api/slots', 'GET', undefined, fresh.ui)).data.slots, globals);

    for (const slot of SLOTS) {
      assertLanded(await send(SESSION_A, { model: ALIAS[slot], port: fresh.proxy }),
        `a-${slot}`, `a-${slot}-model`);
      assertLanded(await send(SESSION_B, { model: ALIAS[slot], port: fresh.proxy }),
        `b-${slot}`, `b-${slot}-model`);
    }
    // 新进程里没有覆盖的新会话仍旧按全局槽位表走。
    const freshUncovered = '00000000-1111-4222-8333-444455556666';
    assertLanded(await send(freshUncovered, { model: 'mixr-main', port: fresh.proxy }),
      'g', 'g-main-model');
  } finally { await fresh.close(); }
});

after(async () => {
  if (ui) await api('/api/sessions', 'DELETE');
  await Promise.all([ui, proxy, upstream].filter(Boolean).map(server => new Promise(resolve => {
    server.close(resolve); if (server.closeAllConnections) server.closeAllConnections();
  })));
  fs.rmSync(TMP, { recursive: true, force: true });
});
