'use strict';
// 子代理槽位:别名解析 / 槽位 CRUD / 客户端 env 同步 / 代理转发落点 / 错误分型。
// 所有客户端配置、数据与上游流量均与真实文件和网络隔离。
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-slots-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude', 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex', 'config.toml');
const mod = require('../mixrouter');
let ui, proxy, upstream, base;
const hits = [];

function request(url, method = 'POST', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(url, { method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, text, data: JSON.parse(text || '{}'), headers: res.headers }); });
    });
    req.on('error', reject); req.end(data);
  });
}
const uiPort = () => ui.address().port;
const proxyPort = () => proxy.address().port;
const api = (route, body, method = 'POST') => request(`http://127.0.0.1:${uiPort()}${route}`, method, body);
const claudeSettings = () => JSON.parse(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'));

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      hits.push({ path: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 2 } }));
    });
  });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${upstream.address().port}`;
  ui = await mod.listen(0, mod.apiHandler);
  proxy = await mod.listen(0, mod.proxyHandler);
});

beforeEach(() => {
  // retryDelay/maxRetries:上一条用例的 slots.json 原子写可能还在途,直接 rm 会 ENOTEMPTY
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  fs.mkdirSync(path.dirname(process.env.MIXR_CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(process.env.MIXR_CLAUDE_SETTINGS, JSON.stringify({ env: { ANTHROPIC_MODEL: 'keep-me-real' } }));
  mod._state.store = {
    claude: [
      { id: 'pa', name: '大渠道', base_url: base, api_key: 'key-a', models: ['glm-5.3', 'deepseek-v4-flash'], enabled: true },
      { id: 'pb', name: '停用渠道', base_url: base, api_key: 'key-b', models: ['m-off'], enabled: false },
    ],
    codex: [
      { id: 'ca', name: 'CodexA', base_url: base + '/v1', api_key: 'key-c', model: 'gpt-6', wire_api: 'responses', enabled: true },
    ],
  };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.current = { claude: null, codex: null, zcode: null };
});

test('槽位 CRUD:校验、部分更新、null 删除、落盘 slots.json', async () => {
  let r = await api('/api/slots', { claude: { foo: { provider: 'pa' } } }, 'PUT');
  assert.equal(r.status, 400); assert.match(r.data.error, /Claude 槽位只能是/);
  r = await api('/api/slots', { codex: { Bad_Name: { provider: 'ca' } } }, 'PUT');
  assert.equal(r.status, 400); assert.match(r.data.error, /小写字母/);
  r = await api('/api/slots', { claude: { haiku: { provider: 'nope' } } }, 'PUT');
  assert.equal(r.status, 400); assert.match(r.data.error, /渠道不存在/);
  r = await api('/api/slots', { codex: { worker: { provider: 'pa' } } }, 'PUT');
  assert.equal(r.status, 400); assert.match(r.data.error, /渠道不存在/);

  r = await api('/api/slots', { claude: { haiku: { provider: 'pa', model: 'deepseek-v4-flash' } }, codex: { worker: { provider: 'ca' } } }, 'PUT');
  assert.equal(r.status, 200);
  const haiku = r.data.slots.claude.find(s => s.name === 'haiku');
  assert.equal(haiku.alias, 'mixr-haiku');
  assert.equal(haiku.provider_name, '大渠道');
  assert.equal(haiku.model, 'deepseek-v4-flash');
  const worker = r.data.slots.codex.find(s => s.name === 'worker');
  assert.equal(worker.alias, 'mixr-worker');
  assert.equal(worker.model, 'gpt-6'); // 未覆盖时继承渠道默认模型
  assert.ok(fs.existsSync(path.join(TMP, 'slots.json')), 'slots.json 已落盘');

  // 部分更新:同组其它槽不受影响;null 删除
  await api('/api/slots', { claude: { opus: { provider: 'pa', model: 'glm-5.3' } } }, 'PUT');
  r = await api('/api/slots', null, 'GET');
  assert.equal(r.data.slots.claude.filter(s => s.provider).length, 2);
  r = await api('/api/slots', { claude: { opus: null } }, 'PUT');
  assert.equal(r.data.slots.claude.filter(s => s.provider).length, 1);
  const st = JSON.parse(fs.readFileSync(path.join(TMP, 'slots.json'), 'utf8'));
  assert.equal(st.version, 1);
  assert.ok(st.claude.haiku && !st.claude.opus);
});

test('Codex 独立模型:保存、冷启动重载、同会话双槽转发保留各自落点', async () => {
  const body = { codex: { main: { provider: 'ca', model: ' custom-main ' },
    reviewer: { provider: 'ca', model: 'custom-review' } } };
  const put = await api('/api/slots', body, 'PUT');
  assert.equal(put.status, 200);
  const file = path.join(TMP, 'slots.json');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(disk.codex, { main: { provider: 'ca', model: 'custom-main' },
    reviewer: { provider: 'ca', model: 'custom-review' } });
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({ version: 2, ...mod._state.store }));
  const { spawnSync } = require('node:child_process');
  const child = spawnSync(process.execPath, ['-e', `
    const router = require(${JSON.stringify(path.resolve(__dirname, '../mixrouter.js'))});
    console.log(JSON.stringify({ map: router._state.slotMap, slots: router.slotsPublic(),
      main: router.resolveRoute('mixr-main', {}, 'codex').model,
      reviewer: router.resolveRoute('mixr-reviewer', {}, 'codex').model }));
  `], { env: process.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const loaded = JSON.parse(child.stdout);
  assert.deepEqual(loaded.map.codex, disk.codex);
  assert.equal(loaded.main, 'custom-main');
  assert.equal(loaded.reviewer, 'custom-review');
  assert.deepEqual(loaded.slots.codex, (await api('/api/slots', null, 'GET')).data.slots.codex);
  hits.length = 0;
  for (const name of ['main', 'reviewer']) {
    const result = await request(`http://127.0.0.1:${proxyPort()}/v1/responses`, 'POST',
      { model: 'mixr-' + name, input: 'hi' }, { 'session-id': 'independent-slots' });
    assert.equal(result.status, 200);
    assert.equal(result.headers['x-mixrouter-model'], 'custom-' + (name === 'main' ? 'main' : 'review'));
    assert.equal(hits.at(-1).body.model, result.headers['x-mixrouter-model']);
    assert.equal(hits.at(-1).headers.authorization, 'Bearer key-c');
  }
  assert.equal(mod._state.store.codex[0].model, 'gpt-6', '选槽模型不能改渠道默认');
});

test('槽位模型部分更新:同渠道省略保留、换渠道省略继承、显式空串清除', async () => {
  mod._state.store.codex.push({ ...mod._state.store.codex[0], id: 'cb', model: 'new-default' });
  for (const [app, name, provider, alternate, fallback] of [
    ['claude', 'opus', 'pa', 'pb', 'm-off'], ['codex', 'worker', 'ca', 'cb', 'new-default'],
  ]) {
    const put = value => api('/api/slots', { [app]: { [name]: value } }, 'PUT');
    let result = await put({ provider, model: 'explicit-model' });
    assert.equal(result.status, 200);
    result = await put({ provider });
    let slot = result.data.slots[app].find(item => item.name === name);
    assert.equal(slot.model, 'explicit-model');
    assert.equal(slot.configured_model, 'explicit-model');
    result = await put({ provider: alternate });
    slot = result.data.slots[app].find(item => item.name === name);
    assert.equal(slot.model, fallback);
    assert.equal(slot.configured_model, '');
    await put({ provider, model: 'explicit-model' });
    result = await put({ provider, model: '  ' });
    slot = result.data.slots[app].find(item => item.name === name);
    assert.equal(slot.model, app === 'claude' ? 'glm-5.3' : 'gpt-6');
    assert.equal(slot.configured_model, '');
    const channel = mod._state.store[app].find(item => item.id === provider);
    if (app === 'claude') channel.models[0] = 'next-default'; else channel.model = 'next-default';
    result = await put({ provider, dropTools: ['Bash'] });
    assert.equal(result.data.slots[app].find(item => item.name === name).model, 'next-default', '继承不能固化旧默认');
  }
});

test('槽位坏 model 类型:两组都回 400,整份补丁不改内存、磁盘或客户端', async () => {
  await api('/api/slots', { claude: { main: { provider: 'pa', model: 'original' } },
    codex: { worker: { provider: 'ca', model: 'original' } } }, 'PUT');
  const beforeMap = structuredClone(mod._state.slotMap);
  const disk = fs.readFileSync(path.join(TMP, 'slots.json'), 'utf8');
  const client = fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8');
  for (const [app, provider, name] of [['claude', 'pa', 'main'], ['codex', 'ca', 'worker']]) {
    for (const model of [null, 0, false, [], {}]) {
      const body = { claude: { opus: { provider: 'pa', model: 'should-not-write' } },
        [app]: { ...(app === 'claude' ? { opus: { provider: 'pa', model: 'should-not-write' } } : {}), [name]: { provider, model } } };
      const result = await api('/api/slots', body, 'PUT');
      assert.equal(result.status, 400);
      assert.match(result.data.error, /model 必须是字符串/);
      assert.deepEqual(mod._state.slotMap, beforeMap);
      assert.equal(fs.readFileSync(path.join(TMP, 'slots.json'), 'utf8'), disk);
      assert.equal(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'), client);
      assert.equal(fs.existsSync(process.env.MIXR_CODEX_CONFIG), false, '保存槽位不创建客户端配置');
    }
  }
});

test('Codex PUT 保留备池、策略和工具过滤,显式空数组才清除', async () => {
  mod._state.store.codex.push({ ...mod._state.store.codex[0], id: 'cb' });
  const put = value => api('/api/slots', { codex: { worker: value } }, 'PUT');
  let result = await put({ provider: 'ca', model: 'target', pool: [{ provider: 'cb', model: 'backup' }],
    strategy: 'round_robin', dropTools: [' Bash '] });
  assert.equal(result.status, 200);
  result = await put({ provider: 'ca', model: 'next-target' });
  let slot = result.data.slots.codex[0];
  assert.deepEqual(slot.pool, [{ provider: 'cb', model: 'backup' }]);
  assert.equal(slot.strategy, 'round_robin');
  assert.deepEqual(slot.dropTools, ['Bash']);
  assert.equal(mod.resolveSlot('codex', 'mixr-worker').rule.pool[0].model, 'next-target');
  result = await put({ provider: 'ca', pool: [], dropTools: [] });
  slot = result.data.slots.codex[0];
  assert.equal(slot.model, 'next-target');
  assert.deepEqual(slot.pool, []);
  assert.deepEqual(slot.dropTools, []);
  assert.equal(mod._state.slotMap.codex.worker.strategy, undefined);
});

test('别名解析:精确命中、优先于规则、未知别名落回普通路由', () => {
  mod._state.slotMap = { claude: { haiku: { provider: 'pa', model: 'deepseek-v4-flash' } }, codex: {} };
  const r = mod.resolveRoute('mixr-haiku', {}, 'claude');
  assert.equal(r.slot, 'haiku');
  assert.equal(r.model, 'deepseek-v4-flash');
  assert.equal(r.rule.id, 'slot:claude/haiku');
  assert.equal(r.members.length, 1);
  // 子串不含:别名必须精确,槽位层不命中(resolveSlot 返回 null,由普通规则接手)
  assert.equal(mod.resolveSlot('claude', 'claude-mixr-haiku-x'), null);
  assert.equal(mod.resolveSlot('claude', 'mixr-haiku-x'), null);
  // 其它 app 的同名别名不串组(槽位层不命中;resolveRoute 层会按普通规则匹配,这符合预期)
  assert.equal(mod.resolveSlot('codex', 'mixr-haiku'), null);
  // 未配置的槽位别名 → 不命中槽位,落回规则/默认
  const miss = mod.resolveRoute('mixr-opus', {}, 'claude');
  assert.equal(miss.slot, undefined);
});

test('代理转发:haiku 槽别名按槽位落点送达上游', async () => {
  mod._state.slotMap = { claude: { haiku: { provider: 'pa', model: 'deepseek-v4-flash' } }, codex: { worker: { provider: 'ca' } } };
  hits.length = 0;
  let r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-haiku', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.equal(hits[0].body.model, 'deepseek-v4-flash');
  assert.equal(r.headers['x-mixrouter-model'], 'deepseek-v4-flash');
  // Codex responses 端点走 worker 槽
  r = await request(`http://127.0.0.1:${proxyPort()}/v1/responses`, 'POST', { model: 'mixr-worker', input: 'hi' });
  assert.equal(r.status, 200);
  assert.equal(hits[1].body.model, 'gpt-6');
  // /v1/models 列出 Codex 槽位别名
  r = await request(`http://127.0.0.1:${proxyPort()}/v1/models`, 'GET');
  assert.ok(r.data.data.some(x => x.id === 'mixr-worker' && x.owned_by === 'slot:worker'));
});

test('内容分流:when.body 规则把压缩请求从槽位别名上分走,普通请求不受影响', async () => {
  mod._state.slotMap = { claude: { main: { provider: 'pa', model: 'gpt-6-astra' } }, codex: {} };
  mod._state.routes = { rules: [
    { id: 'rcompact', match: '', strategy: 'priority', when: { body: 'detailed summary of the conversation' }, enabled: true,
      pool: [{ provider: 'pa', model: 'gpt-5.6-sol' }] },
  ], default: { provider: '', model: '' } };
  hits.length = 0;
  // 普通请求:槽位别名照旧落到槽位落点
  let r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-main', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.equal(hits[0].body.model, 'gpt-6-astra');
  // 压缩请求(请求体带摘要提示词):绕过槽位别名走内容规则
  r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-main', max_tokens: 1, messages: [{ role: 'user', content: 'Your task is to create a detailed summary of the conversation so far' }] });
  assert.equal(r.status, 200);
  assert.equal(hits[1].body.model, 'gpt-5.6-sol');
  assert.equal(r.headers['x-mixrouter-model'], 'gpt-5.6-sol');
  // 真实 2.1.270 形状:指令拼在最后一条 user 消息、末尾挂 system 通告,同样要从槽位别名上分走
  r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-main', max_tokens: 1, messages: [
      { role: 'user', content: '历史' },
      { role: 'user', content: [{ tool_use_id: 't', type: 'tool_result', content: 'x' }, { type: 'text', text: 'Your task is to create a detailed summary of the conversation so far' }] },
      { role: 'system', content: 'The following deferred tools are now available via ToolSearch' },
    ] });
  assert.equal(r.status, 200);
  assert.equal(hits[2].body.model, 'gpt-5.6-sol');
});

test('槽位渠道停用/删除:provider_disabled_error 与 no_route_error 分型', async () => {
  mod._state.slotMap = { claude: { haiku: { provider: 'pb', model: 'm-off' } }, codex: {} };
  let r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-haiku', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 503);
  assert.equal(r.data.error.type, 'provider_disabled_error');
  mod._state.slotMap = { claude: { haiku: { provider: 'gone', model: 'x' } }, codex: {} };
  r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-haiku', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 503);
  assert.equal(r.data.error.type, 'no_route_error');
  assert.match(r.data.error.message, /槽位/);
});

test('路由模式 + 槽位同步:写别名、清残留、不碰手设值、留备份', async () => {
  mod._state.slotMap = { claude: { haiku: { provider: 'pa', model: 'deepseek-v4-flash' }, main: { provider: 'pa', model: 'glm-5.3' } }, codex: {} };
  let r = await api('/api/router/claude', { slots: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.slots.filter(s => s.provider).length, 2);
  let env = claudeSettings().env;
  assert.equal(env.ANTHROPIC_BASE_URL, mod.ROUTER_URL);
  assert.equal(env.ANTHROPIC_MODEL, 'mixr-main');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'mixr-haiku');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
  // 残留清理:曾写入过的别名槽位被移除后,再次应用应清掉;手设的真实模型名保留
  await api('/api/slots', { claude: { haiku: null, sonnet: { provider: 'pa', model: 'glm-5.3' } } }, 'PUT');
  fs.writeFileSync(process.env.MIXR_CLAUDE_SETTINGS, JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: mod.ROUTER_URL, ANTHROPIC_AUTH_TOKEN: mod.ROUTER_TOKEN,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mixr-haiku', ANTHROPIC_DEFAULT_OPUS_MODEL: 'my-own-model' } }));
  r = await api('/api/router/claude', { slots: true });
  assert.equal(r.status, 200);
  env = claudeSettings().env;
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined, '残留别名已清');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'my-own-model', '手设值不动');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'mixr-sonnet');
  assert.ok(fs.readdirSync(path.dirname(process.env.MIXR_CLAUDE_SETTINGS)).some(f => f.includes('.bak-mixui-')), '自动备份');
  // liveState 反映槽位 env 现值
  const live = mod.liveState().claude;
  assert.equal(live.slots.main, 'mixr-main');
  assert.equal(live.slots.haiku, '');
  assert.equal(live.slots.opus, 'my-own-model');
});

test('槽位请求不受会话粘性劫持:同会话先后走不同槽,各自落点正确', async () => {
  mod._state.slotMap = {
    claude: { haiku: { provider: 'pa', model: 'deepseek-v4-flash' }, main: { provider: 'pb', model: 'm-off' } },
    codex: {},
  };
  // main 槽指向停用渠道会明确报错,不静默换渠道
  const headers = { 'x-claude-code-session-id': 'sess-slot-1' };
  let r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-main', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }, headers);
  assert.equal(r.status, 503);
  assert.equal(r.data.error.type, 'provider_disabled_error');
  // 同一会话的 haiku 槽照常按自己的落点走
  r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-haiku', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }, headers);
  assert.equal(r.status, 200);
  assert.equal(hits[hits.length - 1].body.model, 'deepseek-v4-flash');
});

test('删除渠道自动摘除引用它的槽位', async () => {
  await api('/api/slots', { claude: { haiku: { provider: 'pa', model: 'glm-5.3' } }, codex: { worker: { provider: 'ca' } } }, 'PUT');
  const r = await api('/api/providers/pa', null, 'DELETE');
  assert.equal(r.status, 200);
  const slots = (await api('/api/slots', null, 'GET')).data.slots;
  assert.ok(!slots.claude.some(s => s.provider === 'pa'));
  assert.ok(slots.codex.some(s => s.provider === 'ca'), '只摘被删渠道的槽');
});

test('冷启动清理废弃Claude槽但不改磁盘、客户端配置或Codex自定义槽', () => {
  const { spawnSync } = require('node:child_process');
  const file = path.join(TMP, 'slots.json');
  const main = { provider: 'pa', model: 'm', pool: [{ provider: 'pb' }], strategy: 'priority', dropTools: ['Bash'] };
  const raw = { version: 1, claude: { main, fable: { provider: 'pa' }, bogus: { provider: 'pa' } }, codex: { fable: { provider: 'ca' } } };
  fs.writeFileSync(file, JSON.stringify(raw));
  const settings = fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8');
  const child = spawnSync(process.execPath, ['-e', `
    const mod = require(${JSON.stringify(path.resolve(__dirname, '../mixrouter.js'))});
    console.log(JSON.stringify(mod._state.slotMap));
  `], { env: process.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { claude: { main }, codex: raw.codex });
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(raw), '加载清理不擅自落盘');
  assert.equal(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'), settings);
});

after(async () => {
  await Promise.all([ui, proxy, upstream].map(s => new Promise(ok => s.close(ok))));
});

// ---------------------------------------------------------------- 落盘失败时内存不许先动
// PUT /api/slots 以前是边改 slotMap 边校验、最后 saveSlots()。落盘失败时接口回 500,
// 而**内存里已经改了** —— 槽位解析读的正是内存,所以那次"失败"的保存其实当场生效了;
// 重启之后盘上还是旧的,又"改回来"。实测(探针,让原子替换抛 EIO):HTTP 500,
// 内存 subagent.model 已是新值,盘上还是旧值。
test('PUT /api/slots 落盘失败:接口回 500,且内存与盘都不许变(此前内存会先动)', async () => {
  const ch = await api('/api/providers', { app: 'claude', name: 'SLOT-RB', base_url: 'http://127.0.0.1:8999', api_key: 'sk-x', models: ['m'] });
  const id = ch.data.id;
  const put = await api('/api/slots', { claude: { subagent: { provider: id, model: 'ORIGINAL' } } }, 'PUT');
  assert.equal(put.status, 200, `夹具:槽位写入失败 ${put.text}`);
  const live = () => mod.slotsPublic().claude.find(s => s.name === 'subagent').model;
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(TMP, 'slots.json'), 'utf8')).claude.subagent.model;
  assert.equal(live(), 'ORIGINAL');

  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('slots.json')) throw Object.assign(new Error('simulated'), { code: 'EIO' });
    return realRename(from, to);
  };
  let r;
  try { r = await api('/api/slots', { claude: { subagent: { provider: id, model: 'CHANGED' } } }, 'PUT'); }
  finally { fs.renameSync = realRename; }

  assert.equal(r.status, 500, `夹具:这次写入必须失败(实得 ${r.status} ${r.text})`);
  assert.equal(live(), 'ORIGINAL', '内存必须回滚 —— 槽位解析读的是内存,不然"保存失败"当场就生效了');
  assert.equal(onDisk(), 'ORIGINAL', '盘上当然也不能变');
});

test('Codex 槽模型保存失败回滚:有效模型、显式覆盖与备池均保持原样', async () => {
  mod._state.store.codex.push({ ...mod._state.store.codex[0], id: 'cb' });
  const value = { provider: 'ca', model: 'original-target', pool: [{ provider: 'cb', model: 'backup-target' }],
    strategy: 'priority', dropTools: ['Bash'] };
  assert.equal((await api('/api/slots', { codex: { worker: value } }, 'PUT')).status, 200);
  const before = structuredClone(mod._state.slotMap);
  const file = path.join(TMP, 'slots.json');
  const disk = fs.readFileSync(file, 'utf8');
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === file) throw Object.assign(new Error('simulated'), { code: 'EIO' });
    return realRename(from, to);
  };
  let result;
  try { result = await api('/api/slots', { codex: { worker: { provider: 'ca', model: 'changed-target' } } }, 'PUT'); }
  finally { fs.renameSync = realRename; }
  assert.equal(result.status, 500);
  assert.deepEqual(mod._state.slotMap, before);
  assert.equal(fs.readFileSync(file, 'utf8'), disk);
  assert.equal(mod.resolveRoute('mixr-worker', {}, 'codex').model, 'original-target');
  assert.equal(mod.slotsPublic().codex[0].configured_model, 'original-target');
});

test('PUT /api/routes 落盘失败:接口回 500,且内存与盘都不许变(此前内存会先动)', async () => {
  const ch = await api('/api/providers', { app: 'claude', name: 'ROUTE-RB', base_url: 'http://127.0.0.1:8999', api_key: 'sk-x', models: ['m'] });
  const id = ch.data.id;
  const put = await api('/api/routes', { rules: [{ id: 'rb1', provider: id, match: 'ORIGINAL' }] }, 'PUT');
  assert.equal(put.status, 200, `夹具:路由写入失败 ${put.text}`);
  const live = () => (mod._state.routes.rules || []).find(x => x.id === 'rb1').match;
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8')).rules.find(x => x.id === 'rb1').match;
  assert.equal(live(), 'ORIGINAL');

  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('routes.json')) throw Object.assign(new Error('simulated'), { code: 'EIO' });
    return realRename(from, to);
  };
  let r;
  try { r = await api('/api/routes', { rules: [{ id: 'rb1', provider: id, match: 'CHANGED' }] }, 'PUT'); }
  finally { fs.renameSync = realRename; }

  assert.equal(r.status, 500, `夹具:这次写入必须失败(实得 ${r.status} ${r.text})`);
  assert.equal(live(), 'ORIGINAL', '内存必须回滚 —— 转发读的是内存,不然"保存失败"的新规则已经在路由了');
  assert.equal(onDisk(), 'ORIGINAL', '盘上当然也不能变');
});

// 把"在走路由"这件事退回直连态(内存与盘上 providers.json 一起改)。
// 本文件里别的用例可能已经切过路由,而"失败后 current 要回到原值"在**原值就是 @router**
// 时恒真 —— 这个坑在 claude-split 那边实测踩到过,这里显式把起点摆正。
function resetCurrentToDirect() {
  const pf = path.join(TMP, 'providers.json');
  if (fs.existsSync(pf)) {
    const raw = JSON.parse(fs.readFileSync(pf, 'utf8'));
    raw.current = { ...raw.current, claude: null };
    fs.writeFileSync(pf, JSON.stringify(raw, null, 2) + '\n');
  }
  mod._state.current = { ...mod._state.current, claude: null };
  assert.notEqual(mod._state.current.claude, mod.ROUTER_ID, '夹具:起点必须是"没在走路由"');
}

// ---------------------------------------------------------------- 切换客户端失败时必须整体回退
// 这条与 claude-split / 删渠道 / PUT /api/slots 是**同一个形状**,只是位置不同:
// 写路径的先后顺序与它自己那句注释正好相反(注释写"切换失败不该写渠道库",代码是
// 先写客户端、后 saveStore)。于是一旦渠道库落盘失败,接口回 500,而**用户的
// ~/.claude/settings.json 已经被改成路由模式了** —— 他以为没切成。
//
// 这两扇门(直连与路由)是控制台的两个主按钮,所以两扇都要有一条,不能只验一扇。
// 断言的是"客户端配置一个字节都没变",不是"接口回了 500":后者在缺陷存在时也是 500。
function blockProvidersWrite() {
  const real = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('providers.json')) throw Object.assign(new Error('simulated'), { code: 'EIO' });
    return real(from, to);
  };
  return () => { fs.renameSync = real; };
}
// 反过来:让**客户端配置**那一步失败(渠道库那一步已经成功落盘)。
function blockClientWrite() {
  const real = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('settings.json')) throw Object.assign(new Error('simulated'), { code: 'EIO' });
    return real(from, to);
  };
  return () => { fs.renameSync = real; };
}

test('切路由模式:渠道库落盘失败时,客户端配置一个字节都不许变', async () => {
  const before = fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8');
  resetCurrentToDirect();                       // 起点必须是"没在走路由",否则断言恒真
  const currentBefore = mod._state.current.claude;
  const restore = blockProvidersWrite();
  let r;
  try { r = await api('/api/router/claude', {}); } finally { restore(); }
  assert.equal(r.status, 500, `夹具:这次切换必须失败(实得 ${r.status} ${r.text})`);
  assert.match(r.data.error, /写入渠道库失败/, `要能看出是哪一步没成;实得 ${r.text}`);
  assert.equal(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'), before,
    '渠道库都没写进去,客户端就不该被指到本机代理上');
  assert.equal(mod._state.current.claude, currentBefore, '内存 current 要回到原样(它根本没被改成 @router)');
});

test('直连切换:渠道库落盘失败时,客户端配置同样一个字节都不许变', async () => {
  const before = fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8');
  resetCurrentToDirect();
  const restore = blockProvidersWrite();
  let r;
  try { r = await api('/api/switch/pa', { app: 'claude' }); } finally { restore(); }
  assert.equal(r.status, 500, `夹具:这次切换必须失败(实得 ${r.status} ${r.text})`);
  assert.match(r.data.error, /写入渠道库失败/, `要能看出是哪一步没成;实得 ${r.text}`);
  assert.equal(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'), before,
    '直连切换失败时,客户端的 BASE_URL/AUTH_TOKEN 不该被换成这个渠道的');
  assert.equal(mod._state.current.claude, null);
});

test('切路由模式:客户端配置写不进去时,渠道库的 current 必须退回原样', async () => {
  resetCurrentToDirect();
  const currentBefore = mod._state.current.claude;
  const liveBefore = fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8');
  const restore = blockClientWrite();
  let r;
  try { r = await api('/api/router/claude', {}); } finally { restore(); }
  assert.equal(r.status, 500, `夹具:这次切换必须失败(实得 ${r.status} ${r.text})`);
  assert.match(r.data.error, /写入客户端配置失败/, `要能看出是哪一步没成;实得 ${r.text}`);
  assert.equal(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'), liveBefore, '客户端没写成就该保持原样');
  // 这一步最容易漏:客户端没切过去,而渠道库已经把 current 记成 @router 了 ——
  // 那时控制台显示"走路由"、实际客户端直连,重启后两边也不会自己收敛。
  assert.equal(mod._state.current.claude, currentBefore, '内存 current 要退回去');
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'providers.json'), 'utf8'));
  assert.equal(onDisk.current.claude, currentBefore, 'current 是落过盘的,回退也必须写回盘上');
});

// ---------------------------------------------------------------- 切换门上的备份池轮换预警
// /api/switch 与 /api/router 都会写渠道库(saveStore),池满时都会轮换掉最老那份备份。
// 但两扇门都**没取走**暂存里的那句预警:用户点完"切换"只看到成功,而被清掉的那份备份
// 不再有人提。控制台那两扇门本来就在用 toastWithBackupWarnings —— 是服务端没把话说出来。
// 三扇门都要各验一次,不能只验一扇:它们是三条独立的返回语句(同一批里已经栽过一次)。
function fillBackupPool() {
  // 把 providers.json 的备份池垫满。两件事都要做,少一件这次切换就不会轮换、断言就是空的:
  //   · 活文件本身要存在 —— `backupFile` 在源文件不存在时返回 null 直接不做(它的既有约定),
  //     而本文件的 beforeEach 每次都把 TMP 整个删掉,所以每个用例的 providers.json 都是新的;
  //   · 备份要够 keep 份以上,写这一次才会顶掉东西。
  const dir = TMP;
  const base = 'providers.json';
  fs.writeFileSync(path.join(dir, base), JSON.stringify({ version: 2, current: { claude: null, codex: null, zcode: null }, claude: [], codex: [] }, null, 2) + '\n');
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(dir, `${base}.bak-mixui-2026010100000${i}-000-abcd`), 'x');
  }
  return () => fs.readdirSync(dir).filter(f => f.startsWith(base + '.bak-mixui-'));
}
// 一次写入会真删掉哪几份:写前写后各列一次目录,取差集 —— 不靠猜名字,靠盘上的事实。
function rotationOf(write) {
  const before = fs.readdirSync(TMP).filter(f => f.startsWith('providers.json.bak-mixui-')).sort();
  return write().then(res => {
    const after = fs.readdirSync(TMP).filter(f => f.startsWith('providers.json.bak-mixui-')).sort();
    return { res, deleted: before.filter(n => !after.includes(n)) };
  });
}

test('两扇切换门带回的备份轮换预警:要出现在响应体里,且说的就是真被删掉的那一份', async () => {
  for (const [route, label] of [['/api/router/claude', '切路由模式'], ['/api/switch/pa', '直连切换']]) {
    resetCurrentToDirect();
    const cleanup = fillBackupPool();
    const { res, deleted } = await rotationOf(() => api(route, route.startsWith('/api/switch') ? { app: 'claude' } : {}));
    assert.equal(res.status, 200, `${label}: 切换本身要成功(实得 ${res.status} ${res.text})`);
    assert.ok(deleted.length, `${label}: 夹具 —— 这次切换必须真的轮换掉一份备份(否则断言是空的)`);
    const w = res.data.warnings;
    assert.ok(Array.isArray(w) && w.length, `${label}: 响应体里必须带上轮换预警;实得 ${JSON.stringify(w)}`);
    assert.ok(deleted.every(d => w.some(line => line.includes(d))),
      `${label}: 预警里点名的必须就是真被删的那份(实删 ${deleted.join('、')},报 ${JSON.stringify(w)})`);
    cleanup();
  }
});

test('切换门不轮换时不出声(不能变成每次切换都喊一句)', async () => {
  resetCurrentToDirect();
  const before = fs.readdirSync(TMP).filter(f => f.startsWith('providers.json.bak-mixui-'));
  const r = await api('/api/router/claude', {});
  assert.equal(r.status, 200);
  const after = fs.readdirSync(TMP).filter(f => f.startsWith('providers.json.bak-mixui-'));
  assert.equal(after.length, before.length, '夹具:这次没有轮换');
  assert.equal(r.data.warnings, undefined, '没有轮换就不该报 —— 否则每次切换都在喊,真出事那次会被淹掉');
});
