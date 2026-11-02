'use strict';
// 独立 Bots 配置：真实回环 API + 临时运行目录，不读取或修改真实用户配置。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-bots-api-'));
process.env.HOME = TMP;
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude-settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex-config.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXROUTER_PORT = '0';
process.env.MIXUI_PORT = '0';
const mod = require('../mixrouter');
const { readBots, botsPublic, writeBots, resolveBot } = require('../lib/bots');
const FILE = path.join(TMP, 'bots.json');
const baseBot = { id: 'bot-one', name: 'plugin:exact-bot', provider: 'p1', model: 'model-a' };
let server, port;

const provider = (id, extra = {}) => ({ id, name: id, enabled: true, model: 'model-default',
  models: ['model-a', 'model-b', 'model-a'], base_url: 'https://private-upstream.example/v1',
  api_key: 'sk-private-legacy-secret', ...extra });
const providers = () => [
  provider('p1'),
  provider('p2', { keys: [
    { id: 'one', label: 'First account', key: 'sk-private-one-secret' },
    { id: 'two', label: 'Second account', key: 'sk-private-two-secret' },
    { id: 'off', label: 'Disabled account', key: 'sk-private-off-secret', enabled: false },
    { id: 'empty', label: 'Empty account', key: '' },
    { id: 'duplicate', key: 'sk-private-duplicate-a' },
    { id: 'duplicate', key: 'sk-private-duplicate-b' },
  ], active_key: 'two' }),
  provider('disabled', { enabled: false }),
  provider('missing-enabled', { enabled: undefined }),
  provider('no-key', { api_key: '' }),
  provider('no-models', { model: '', models: [] }),
  provider('duplicate-provider'), provider('duplicate-provider'),
];

function request(method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, method, path: '/api/bots',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}
async function put(bots, extra = {}) {
  const current = await request();
  return request('PUT', { bots, expected_revision: current.json.revision, ...extra });
}
function noSecrets(response) {
  for (const value of ['sk-private', 'private-upstream', 'base_url', 'api_key', 'key_masked'])
    assert.ok(!response.text.includes(value), `响应泄露 ${value}`);
}
function reset() {
  fs.rmSync(FILE, { force: true });
  mod._state.store = { claude: providers(), codex: [provider('codex-only')] };
}

before(async () => {
  reset();
  mod._state.routes = { rules: [], default: { provider: '', model: '' } };
  mod._state.slotMap = { claude: { main: { provider: 'p1', model: 'model-a' } }, codex: {} };
  for (const name of ['providers.json', 'routes.json', 'slots.json', 'claude-settings.json', 'codex-config.toml'])
    fs.writeFileSync(path.join(TMP, name), `unchanged-${name}`);
  server = await mod.listen(0, mod.apiHandler);
  port = server.address().port;
});
after(async () => {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('缺失文件为空表；模型目录合并默认模型并去重；仅公开可选 Claude 渠道且不泄密', async () => {
  reset();
  const result = await request();
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.bots, []);
  assert.match(result.json.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.json.providers.map(p => p.id), ['p1', 'p2']);
  assert.deepEqual(result.json.providers[0].models, ['model-default', 'model-a', 'model-b']);
  assert.deepEqual(result.json.providers[0].keys, [{ id: 'klegacy', label: '账号1', enabled: true }]);
  assert.deepEqual(Object.keys(result.json.providers[1]).sort(), ['active_key', 'id', 'keys', 'models', 'name']);
  assert.equal(fs.existsSync(FILE), false, 'GET 不应创建配置');
  noSecrets(result);
});

test('PUT CAS 保存并重读持久化；0600；不修改路由、槽位、渠道库或客户端', async () => {
  reset();
  const beforeState = JSON.stringify([mod._state.store, mod._state.routes, mod._state.slotMap]);
  const unchanged = Object.fromEntries(fs.readdirSync(TMP).filter(name => fs.statSync(path.join(TMP, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(TMP, name), 'utf8')]));
  const initial = await request();
  const saved = await put([baseBot, { ...baseBot, id: 'bot-two', name: 'plugin:second', provider: 'p2', key_id: 'one' }]);
  assert.equal(saved.status, 200);
  assert.notEqual(saved.json.revision, initial.json.revision);
  assert.deepEqual((await request()).json.bots, saved.json.bots);
  assert.deepEqual(readBots(FILE), { version: 1, bots: saved.json.bots });
  assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
  assert.equal(JSON.stringify([mod._state.store, mod._state.routes, mod._state.slotMap]), beforeState);
  for (const [name, bytes] of Object.entries(unchanged)) assert.equal(fs.readFileSync(path.join(TMP, name), 'utf8'), bytes);
  assert.deepEqual(fs.readdirSync(TMP).filter(name => !(name in unchanged)), ['bots.json']);
  noSecrets(saved);
  const conflict = await request('PUT', { bots: [], expected_revision: initial.json.revision });
  assert.equal(conflict.status, 409);
  assert.deepEqual((await request()).json.bots, saved.json.bots);
});

test('非法输入全部拒绝，不写坏现有表，不泄密', async () => {
  reset();
  assert.equal((await put([baseBot])).status, 200);
  const bytes = fs.readFileSync(FILE, 'utf8');
  const badBots = [null, {}, [null], [{ ...baseBot, unknown: true }], [baseBot, { ...baseBot, name: 'other' }],
    [baseBot, { ...baseBot, id: 'other' }], Array.from({ length: 101 }, (_, i) => ({ ...baseBot, id: `b${i}`, name: `b${i}` }))];
  for (const key of ['id', 'name', 'provider', 'model']) {
    for (const value of ['', '   ', null, 123, {}, 'x\n', 'x\u0000', 'x\u0085', 'x'.repeat(513)])
      badBots.push([{ ...baseBot, [key]: value }]);
  }
  for (const key of ['id', 'name']) {
    for (const value of [' leading', 'trailing ', ' boundary', 'boundary　'])
      badBots.push([{ ...baseBot, [key]: value }]);
  }
  for (const key_id of [null, {}, 123, 'x\n', 'x'.repeat(129)]) badBots.push([{ ...baseBot, key_id }]);
  for (const bots of badBots) {
    const result = await put(bots);
    assert.equal(result.status, 400, JSON.stringify(bots));
    assert.equal(fs.readFileSync(FILE, 'utf8'), bytes);
    noSecrets(result);
  }
  for (const body of [[], {}, { bots: [] }, { bots: [], expected_revision: 1 },
    { bots: [], expected_revision: (await request()).json.revision, unknown: true }]) {
    assert.equal((await request('PUT', body)).status, 400);
    assert.equal(fs.readFileSync(FILE, 'utf8'), bytes);
  }
});

test('中文名字和内部空格保留原文，不做静默归一化', async () => {
  reset();
  const bot = { ...baseBot, id: 'bot internal', name: '插件:中文 Bot' };
  const saved = await put([bot]);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.bots, [bot]);
  assert.deepEqual(resolveBot(readBots(FILE), { name: bot.name }, providers()), bot);
});

test('未知/停用/重复/跨组渠道，未登记模型与失效 Key 明确拒绝，无静默回退', async () => {
  reset();
  for (const patch of [
    { provider: 'missing' }, { provider: 'disabled' }, { provider: 'missing-enabled' },
    { provider: 'duplicate-provider' }, { provider: 'codex-only' },
    { model: 'model-*' }, { model: 'MODEL-A' }, { model: ' model-a' }, { provider: 'no-key' },
    { provider: 'p2', key_id: 'missing' }, { provider: 'p2', key_id: 'off' }, { provider: 'p2', key_id: 'empty' },
    { provider: 'p2', key_id: 'duplicate' },
  ]) {
    const result = await put([{ ...baseBot, ...patch }]);
    assert.equal(result.status, 400, JSON.stringify(patch));
    assert.equal(fs.existsSync(FILE), false);
    noSecrets(result);
  }
  const p = mod._state.store.claude.find(p => p.id === 'p2');
  for (const active_key of ['missing', 'off', 'empty', 'duplicate']) {
    p.active_key = active_key;
    assert.equal((await put([{ ...baseBot, provider: 'p2' }])).status, 400);
    assert.equal((await put([{ ...baseBot, provider: 'p2', key_id: '' }])).status, 400);
  }
});

test('损坏或非本版配置明确失败，PUT 不能覆盖；错误不回显文件正文', async () => {
  reset();
  const revision = (await request()).json.revision;
  for (const text of ['{sk-private-broken', JSON.stringify({ version: 2, bots: [] }),
    JSON.stringify({ version: 1, bots: [], api_key: 'sk-private-stowaway' }),
    JSON.stringify({ version: 1, bots: [{ ...baseBot, api_key: 'sk-private-stowaway' }] }),
    JSON.stringify({ version: 1, bots: [baseBot, baseBot] })]) {
    fs.writeFileSync(FILE, text);
    const get = await request();
    assert.equal(get.status, 500);
    noSecrets(get);
    const result = await request('PUT', { bots: [], expected_revision: revision });
    assert.equal(result.status, 500);
    assert.equal(fs.readFileSync(FILE, 'utf8'), text);
    noSecrets(result);
  }
});

test('旧失效绑定保留用于修复；运行时失效报错，不因模型或 Key 问题回退', async () => {
  reset();
  await put([baseBot]);
  mod._state.store.claude = [];
  const result = await request();
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.bots, [baseBot]);
  assert.deepEqual(result.json.providers, []);
  assert.throws(() => resolveBot(readBots(FILE), { name: baseBot.name }, []), { code: 'BOTS_BINDING_INVALID' });
  mod._state.store.claude = providers();
  assert.equal((await put([{ ...baseBot, provider: 'p2', key_id: 'one' }])).status, 200);
});

test('resolver 精确 name 优先、id 后备、未匹配 null；选择 Key 不改渠道 active_key', () => {
  const ps = providers();
  const config = { version: 1, bots: [baseBot,
    { ...baseBot, id: 'other', name: 'second', provider: 'p2', key_id: 'one' }] };
  assert.deepEqual(resolveBot(config, { name: baseBot.name, id: 'other' }, ps), baseBot);
  const hit = resolveBot(config, { name: 'unknown', id: 'other' }, ps);
  assert.deepEqual(hit, config.bots[1]);
  assert.equal(hit.provider, 'p2');
  assert.equal(hit.model, 'model-a');
  assert.equal(hit.key_id, 'one');
  assert.equal(ps[1].active_key, 'two');
  assert.equal(resolveBot(config, { name: 'PLUGIN:EXACT-BOT' }, ps), null);
  assert.equal(resolveBot(config, {}, ps), null);
  assert.deepEqual(resolveBot({ version: 1, bots: [{ ...baseBot, provider: 'p2' }] }, { id: baseBot.id }, ps),
    { ...baseBot, provider: 'p2' });
});

test('原子替换失败保留旧内容且清理临时文件', () => {
  reset();
  const saved = writeBots(FILE, providers(), { bots: [baseBot], expected_revision: botsPublic(readBots(FILE), providers()).revision });
  const bytes = fs.readFileSync(FILE, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === FILE) throw new Error('sk-private-simulated'); return rename(from, to); };
  try {
    assert.throws(() => writeBots(FILE, providers(), { bots: [], expected_revision: saved.revision }), { code: 'BOTS_WRITE_FAILED' });
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(FILE, 'utf8'), bytes);
  assert.deepEqual(fs.readdirSync(TMP).filter(name => name.startsWith('bots.json.')), []);
});

test('沿用 Host/Origin 闸门并要求 PUT JSON 类型', async () => {
  reset();
  const payload = { bots: [baseBot], expected_revision: (await request()).json.revision };
  assert.equal((await request('GET', undefined, { host: 'evil.example' })).status, 403);
  assert.equal((await request('PUT', payload, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('PUT', payload, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(fs.existsSync(FILE), false);
});
