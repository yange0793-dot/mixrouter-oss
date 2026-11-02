'use strict';
// /api/profiles 真实回环 API:临时运行目录,不读取或修改真实用户配置。
// 覆盖:列表不写盘、保存快照、预览、应用只经 commitSlotUpdate、revision 冲突、
// 损坏文件不被覆盖、JSON 类型与跨站闸门、不泄密。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-profiles-api-'));
process.env.HOME = TMP;
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude-settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex-config.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXROUTER_PORT = '0';
process.env.MIXUI_PORT = '0';
const mod = require('../mixrouter');
const FILE = path.join(TMP, 'profiles.json');
let server, port;

const provider = (id, app, extra = {}) => ({ id, name: id + ' name', enabled: true,
  ...(app === 'codex' ? { model: 'gpt-x', ...extra } : { models: ['model-a', 'model-b'], ...extra }) });
const store = () => ({
  claude: [provider('p1', 'claude'), provider('p2', 'claude'), provider('off', 'claude', { enabled: false })],
  codex: [provider('c1', 'codex')],
});
const slotMap = () => ({
  claude: {
    main: { provider: 'p1', model: 'model-a', pool: [{ provider: 'p2', model: 'model-b' }], strategy: 'priority', dropTools: ['mcp__*'] },
    opus: { provider: 'p1', model: 'model-a' },
    sonnet: { provider: 'p2', model: 'model-b' },
    haiku: { provider: 'p2', model: 'model-b' },
    subagent: { provider: 'p1', model: 'model-a' },
  },
  codex: { main: { provider: 'c1', model: 'gpt-x' }, worker: { provider: 'c1', model: 'gpt-x' } },
});

function request(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const get = (route, headers) => request('GET', route, undefined, headers);
const post = (route, body, headers) => request('POST', route, body, headers);
const del = (route, body, headers) => request('DELETE', route, body, headers);

// 分两段发送请求体:第一段到达后先让回调改掉活槽位,再发第二段。
// 用来证明 handler 是先读体、再取活槽位,而不是在请求开始时就把槽位表快照下来。
function slowPost(route, bodyText, halfway) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: route,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyText) } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    const split = Math.ceil(bodyText.length / 2);
    req.write(bodyText.slice(0, split));
    setTimeout(() => {
      halfway();
      req.end(bodyText.slice(split));
    }, 40);
  });
}

function reset() {
  fs.rmSync(FILE, { force: true });
  mod._state.store = store();
  mod._state.slotMap = slotMap();
  mod._state.routes = { rules: [], default: { provider: '', model: '' } };
}
function noSecrets(response) {
  for (const value of ['sk-', 'base_url', 'api_key', 'key_masked', 'active_key'])
    assert.ok(!response.text.includes(value), `响应泄露 ${value}`);
}
async function saveProfile(name, apps) {
  const listed = await get('/api/profiles');
  return post('/api/profiles', { name, apps, expected_revision: listed.json.revision });
}

before(async () => {
  reset();
  for (const name of ['providers.json', 'routes.json', 'slots.json', 'claude-settings.json', 'codex-config.toml'])
    fs.writeFileSync(path.join(TMP, name), `unchanged-${name}`);
  server = await mod.listen(0, mod.apiHandler);
  port = server.address().port;
});
after(async () => {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('GET 列表为空且不写盘;响应形状与契约一致', async () => {
  reset();
  const result = await get('/api/profiles');
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.profiles, []);
  assert.match(result.json.revision, /^[a-f0-9]{64}$/);
  assert.match(result.json.slots_revision, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(FILE), false, 'GET 不应创建 profiles.json');
  noSecrets(result);
});

test('保存原始槽位组:pool/strategy/dropTools 原样,不写客户端与其他运行文件', async () => {
  reset();
  const beforeState = JSON.stringify([mod._state.store, mod._state.routes, mod._state.slotMap]);
  const unchanged = Object.fromEntries(fs.readdirSync(TMP).filter(name => fs.statSync(path.join(TMP, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(TMP, name), 'utf8')]));
  const saved = await saveProfile('日常 主力', ['claude', 'codex']);
  assert.equal(saved.status, 200);
  assert.equal(saved.json.profiles.length, 1);
  assert.deepEqual(saved.json.profiles[0].apps, ['claude', 'codex']);
  assert.equal(saved.json.profiles[0].active, true);
  assert.equal(saved.json.slots_revision, (await get('/api/profiles')).json.slots_revision);
  const stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.deepEqual(Object.keys(stored.profiles[0]).sort(), ['apps', 'created_at', 'id', 'name', 'slots']);
  assert.deepEqual(stored.profiles[0].slots, slotMap());
  assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
  assert.equal(JSON.stringify([mod._state.store, mod._state.routes, mod._state.slotMap]), beforeState);
  for (const [name, bytes] of Object.entries(unchanged)) assert.equal(fs.readFileSync(path.join(TMP, name), 'utf8'), bytes);
  assert.deepEqual(fs.readdirSync(TMP).filter(name => !(name in unchanged)), ['profiles.json']);
  noSecrets(saved);
});

test('预览只读 diff;应用经确认后只改服务端槽位,不动客户端文件与在途状态', async () => {
  reset();
  const saved = await saveProfile('方案 A', ['claude']);
  const id = saved.json.profiles[0].id;
  const drifted = slotMap();
  drifted.claude.opus = { provider: 'p2', model: 'model-b' };
  delete drifted.claude.haiku;
  drifted.codex.worker.model = 'gpt-y';
  mod._state.slotMap = drifted;
  const clientFiles = ['claude-settings.json', 'codex-config.toml']
    .map(name => [name, fs.readFileSync(path.join(TMP, name), 'utf8')]);

  const preview = await post(`/api/profiles/${id}/preview`, {});
  assert.equal(preview.status, 200);
  assert.equal(preview.json.id, id);
  assert.deepEqual(preview.json.changes.map(change => `${change.app}/${change.slot}`), ['claude/haiku', 'claude/opus']);
  assert.equal(preview.json.can_apply, true);
  assert.deepEqual(preview.json.warnings, []);
  assert.equal(preview.json.slots_revision, (await get('/api/profiles')).json.slots_revision);
  assert.equal(JSON.stringify(mod._state.slotMap), JSON.stringify(drifted), '预览不改槽位');
  assert.equal(fs.readFileSync(path.join(TMP, 'slots.json'), 'utf8'), 'unchanged-slots.json', '预览不写 slots.json');

  const applied = await post(`/api/profiles/${id}/apply`, {
    confirm: true, expected_revision: preview.json.expected_revision, slots_revision: preview.json.slots_revision,
  });
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.json, { ok: true, id, name: '方案 A', apps: ['claude'],
    slots_revision: applied.json.slots_revision });
  assert.equal(applied.json.slots_revision, (await get('/api/profiles')).json.slots_revision,
    '应用后的 slots_revision 反映新槽位');
  assert.deepEqual(mod._state.slotMap.claude, slotMap().claude, 'Claude 组切回方案');
  assert.equal(mod._state.slotMap.codex.worker.model, 'gpt-y', '范围外的 codex 组不受影响');
  // 客户端文件原样;槽位落盘是服务端 slots.json,不是客户端配置。
  for (const [name, bytes] of clientFiles) assert.equal(fs.readFileSync(path.join(TMP, name), 'utf8'), bytes);
  assert.ok(fs.existsSync(path.join(TMP, 'slots.json')), '应用应落盘服务端槽位');
  assert.equal(JSON.parse(fs.readFileSync(path.join(TMP, 'slots.json'), 'utf8')).claude.opus.provider, 'p1');
  assert.equal((await get('/api/profiles')).json.profiles[0].active, true);
});

test('慢请求体期间槽位被整份替换:保存与应使用读体之后的活槽位,不吃旧快照', async () => {
  reset();
  const listed = await get('/api/profiles');
  const saved = await slowPost('/api/profiles',
    JSON.stringify({ name: '慢保存', apps: ['claude'], expected_revision: listed.json.revision }),
    () => {
      const replaced = slotMap();
      replaced.claude.main.model = 'model-b';
      mod._state.slotMap = replaced;
    });
  assert.equal(saved.status, 200);
  const stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(stored.profiles[0].slots.claude.main.model, 'model-b', '快照必须取读体之后的槽位表');
  assert.equal(saved.json.profiles[0].active, true, '刚保存的快照对当前槽位生效');

  // 应用:请求体只发一半时把槽位换成第三份。revision 还是对着请求开始时的表算的,
  // 必须在读体之后重新比,否则会用旧表通过校验并覆盖掉新槽位。
  const id = stored.profiles[0].id;
  mod._state.slotMap = slotMap();
  const listedAgain = await get('/api/profiles');
  const applied = await slowPost(`/api/profiles/${id}/apply`,
    JSON.stringify({ confirm: true, expected_revision: listedAgain.json.revision,
      slots_revision: listedAgain.json.slots_revision }),
    () => {
      const replaced = slotMap();
      replaced.claude.opus = { provider: 'p2', model: 'model-b' };
      mod._state.slotMap = replaced;
    });
  assert.equal(applied.status, 409, '读体之后的槽位已变,必须拒绝');
  assert.deepEqual(mod._state.slotMap.claude.opus, { provider: 'p2', model: 'model-b' }, '新槽位不能被旧表覆盖');
});

test('revision 冲突 409:方案变化与槽位变化各一条,且都不应用', async () => {
  reset();
  const saved = await saveProfile('方案', ['claude']);
  const id = saved.json.profiles[0].id;
  const preview = await post(`/api/profiles/${id}/preview`, {});
  // 槽位在预览后变化
  const moved = slotMap();
  moved.claude.main.model = 'model-b';
  mod._state.slotMap = moved;
  const staleSlots = await post(`/api/profiles/${id}/apply`, {
    confirm: true, expected_revision: preview.json.expected_revision, slots_revision: preview.json.slots_revision,
  });
  assert.equal(staleSlots.status, 409);
  assert.deepEqual(mod._state.slotMap.claude.main.provider, 'p1');
  // 方案配置在预览后变化(新增一个方案)
  mod._state.slotMap = slotMap();
  const second = await saveProfile('另一个', ['codex']);
  assert.equal(second.status, 200);
  const staleProfiles = await post(`/api/profiles/${id}/apply`, {
    confirm: true, expected_revision: preview.json.expected_revision, slots_revision: preview.json.slots_revision,
  });
  assert.equal(staleProfiles.status, 409);
  noSecrets(staleProfiles);
});

test('目标含停用渠道:预览给出明确警告,应用 400 且不改槽位', async () => {
  reset();
  const saved = await saveProfile('停用渠道', ['claude']);
  const id = saved.json.profiles[0].id;
  const text = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  text.profiles[0].slots.claude.main = { provider: 'off', model: 'model-a' };
  fs.writeFileSync(FILE, JSON.stringify(text));
  const preview = await post(`/api/profiles/${id}/preview`, {});
  assert.equal(preview.status, 200);
  assert.equal(preview.json.can_apply, false);
  assert.ok(preview.json.warnings.some(warning => /"off" 已停用/.test(warning)), preview.text);
  const applied = await post(`/api/profiles/${id}/apply`, {
    confirm: true, expected_revision: preview.json.expected_revision, slots_revision: preview.json.slots_revision,
  });
  assert.equal(applied.status, 400);
  assert.match(applied.json.error, /已停用/);
  assert.deepEqual(mod._state.slotMap, slotMap());
});

test('DELETE 只删方案,不动槽位;缺 confirm 或过期 revision 拒绝', async () => {
  reset();
  const saved = await saveProfile('待删', ['claude']);
  const id = saved.json.profiles[0].id;
  const listed = await get('/api/profiles');
  const body = { confirm: true, expected_revision: listed.json.revision };
  assert.equal((await del(`/api/profiles/${id}`, { ...body, confirm: false })).status, 400);
  assert.equal((await del(`/api/profiles/${id}`, { ...body, expected_revision: 'stale' })).status, 409);
  assert.equal(fs.existsSync(FILE), true);
  const removed = await del(`/api/profiles/${id}`, body);
  assert.equal(removed.status, 200);
  assert.deepEqual((await get('/api/profiles')).json.profiles, []);
  assert.deepEqual(mod._state.slotMap, slotMap(), '删除方案不改槽位');
  assert.deepEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')), { version: 1, profiles: [] });
  assert.equal((await del(`/api/profiles/${id}`, { confirm: true, expected_revision: removed.json.revision })).status, 404);
});

test('输入校验:未知字段、非数组 apps、超长名、预览带参数、方法不匹配全部拒绝', async () => {
  reset();
  const listed = await get('/api/profiles');
  const base = { name: 'x', apps: ['claude'], expected_revision: listed.json.revision };
  for (const body of [[], {}, { ...base, name: '' }, { ...base, name: ' padded' }, { ...base, name: 'x'.repeat(81) },
    { ...base, apps: [] }, { ...base, apps: ['other'] }, { ...base, apps: ['claude', 'claude'] },
    { ...base, extra: true }, { ...base, expected_revision: 5 }]) {
    assert.equal((await post('/api/profiles', body)).status, 400, JSON.stringify(body));
  }
  assert.equal(fs.existsSync(FILE), false);
  const saved = await saveProfile('方案', ['claude']);
  const id = saved.json.profiles[0].id;
  assert.equal((await post(`/api/profiles/${id}/preview`, { slots: { claude: {} } })).status, 400);
  assert.equal((await post(`/api/profiles/${id}/preview`, {})).json.id, id);
  assert.equal((await get(`/api/profiles/${id}/preview`)).status, 404);
  assert.equal((await post(`/api/profiles/${id}`, {})).status, 404);
  assert.equal((await get(`/api/profiles/${id}/apply`)).status, 404);
  assert.equal((await post('/api/profiles/not-a-real-id/preview', {})).status, 404);
  noSecrets(saved);
});

test('损坏的 profiles.json:GET/预览/应用/保存都 500,原文件不被覆盖', async () => {
  reset();
  for (const text of ['{broken', JSON.stringify({ version: 2, profiles: [] }),
    JSON.stringify({ version: 1, profiles: [], secret: 'sk-private' }),
    JSON.stringify({ version: 1, profiles: [{ id: 'nope', name: 'x', apps: ['claude'], created_at: 'x', slots: { claude: {} } }] })]) {
    fs.writeFileSync(FILE, text);
    const listed = await get('/api/profiles');
    assert.equal(listed.status, 500);
    noSecrets(listed);
    // expected_revision 给一个字符串:校验形状通过之后才会读到损坏文件,证明是读盘失败而不是参数错误。
    assert.equal((await post('/api/profiles', { name: 'x', apps: ['claude'], expected_revision: 'any' })).status, 500);
    assert.equal((await post('/api/profiles/11111111-1111-4111-8111-111111111111/preview', {})).status, 500);
    assert.equal(fs.readFileSync(FILE, 'utf8'), text);
  }
});

test('沿用 Host/Origin 闸门与 application/json 类型要求', async () => {
  reset();
  assert.equal((await get('/api/profiles', { host: 'evil.example' })).status, 403);
  const listed = await get('/api/profiles');
  const body = { name: 'x', apps: ['claude'], expected_revision: listed.json.revision };
  assert.equal((await post('/api/profiles', body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/profiles', body, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(fs.existsSync(FILE), false);
});
