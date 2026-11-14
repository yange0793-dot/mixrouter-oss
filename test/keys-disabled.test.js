'use strict';
// 停用 Key 的保存语义、生效 Key 的选择,以及渠道 slug 字段的回归。
// 全部走真实控制台 HTTP 接口与临时数据目录,不碰真实渠道库、不联网。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-keys-disabled-'));
process.env.HOME = TMP;
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude-settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex-config.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXROUTER_PORT = '0';
process.env.MIXUI_PORT = '0';

const mod = require('../mixrouter');
const { activeKeyId, resolveKey } = require('../lib/routing/keys');

const PROVIDERS_FILE = path.join(TMP, 'providers.json');
let ui, uiPort;

function request(route, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: uiPort, path: route, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const diskProvider = id => JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8')).claude.find(p => p.id === id);
const stateProvider = async id => (await request('/api/state')).json.providers.claude.find(p => p.id === id);
const createProvider = async body => {
  const response = await request('/api/providers', 'POST', {
    app: 'claude', name: '停用测试', base_url: 'https://keys.example.com', ...body,
  });
  assert.equal(response.status, 200, response.text);
  return response.json.id;
};

before(async () => {
  fs.rmSync(PROVIDERS_FILE, { force: true });
  mod._state.store = { claude: [], codex: [] };
  mod._state.routes = { rules: [] };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.sessions.clear();
  mod._state.cooldowns = {};
  ui = await mod.listen(0, mod.apiHandler);
  uiPort = ui.address().port;
});

after(async () => {
  await new Promise(resolve => { ui.closeAllConnections(); ui.close(resolve); });
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('activeKeyId 跳过停用的 Key,全停用时明确返回空', () => {
  assert.equal(activeKeyId({ keys: [{ id: 'a', key: 'x' }, { id: 'b', key: 'y' }], active_key: 'a' }), 'a');
  assert.equal(activeKeyId({ keys: [
    { id: 'a', key: 'x', enabled: false }, { id: 'b', key: 'y' },
  ], active_key: 'a' }), 'b', '显式生效 Key 停用后回退到第一把可用 Key');
  assert.equal(activeKeyId({ keys: [
    { id: 'a', key: 'x', enabled: false }, { id: 'b', key: 'y', enabled: false },
  ] }), '', '全都停用时没有生效 Key');
  assert.equal(resolveKey({ keys: [{ id: 'a', key: 'x', enabled: false }] }, 'a'), null);
  assert.equal(activeKeyId({ api_key: 'legacy' }), 'klegacy', '旧版单 Key 渠道保持原语义');
});

test('停用的 Key 保存后仍然停用,编辑其他字段不会把它重新启用', async () => {
  const id = await createProvider({ keys: [
    { id: 'k1', label: '一号', key: 'sk-one' },
    { id: 'k2', label: '二号', key: 'sk-two', enabled: false },
  ] });
  assert.equal((await stateProvider(id)).active_key, 'k1');
  assert.equal(diskProvider(id).keys.find(key => key.id === 'k2').enabled, false, '创建时已停用');

  assert.equal((await request(`/api/providers/${id}`, 'PUT', { note: '只改备注' })).status, 200);
  assert.equal(diskProvider(id).keys.find(key => key.id === 'k2').enabled, false);

  // 编辑弹窗按公开视图回传(已有 Key 留空表示不改值):停用状态必须原样保留。
  const saved = await request(`/api/providers/${id}`, 'PUT', { keys: [
    { id: 'k1', label: '一号' },
    { id: 'k2', label: '二号', enabled: false },
  ] });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(diskProvider(id).keys.find(key => key.id === 'k2').enabled, false);
  assert.equal(diskProvider(id).keys.find(key => key.id === 'k1').enabled, undefined, '默认启用的 Key 不额外落字段');
  assert.equal(diskProvider(id).keys.find(key => key.id === 'k2').key, 'sk-two', '留空不改已有 Key 的值');

  const bad = await request(`/api/providers/${id}`, 'PUT', { keys: [{ id: 'k1', enabled: 'false' }] });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /enabled/);
  assert.equal(diskProvider(id).keys.find(key => key.id === 'k2').enabled, false, '被拒的请求不改盘上数据');
});

test('停用的 Key 不会被选为生效 Key,显式指定也会回退', async () => {
  const id = await createProvider({ keys: [
    { id: 'k1', label: '一号', key: 'sk-one' },
    { id: 'k2', label: '二号', key: 'sk-two' },
  ] });
  assert.equal((await stateProvider(id)).active_key, 'k1');

  assert.equal((await request(`/api/providers/${id}`, 'PUT', { keys: [
    { id: 'k1', label: '一号', enabled: false }, { id: 'k2', label: '二号' },
  ] })).status, 200);
  assert.equal((await stateProvider(id)).active_key, 'k2');
  assert.equal(diskProvider(id).active_key, 'k2');
  assert.equal(diskProvider(id).api_key, 'sk-two', 'legacy api_key 同步为可用 Key');

  assert.equal((await request(`/api/providers/${id}`, 'PUT', { active_key: 'k1' })).status, 200);
  assert.equal((await stateProvider(id)).active_key, 'k2', '把停用 Key 设为生效 Key 时回退到可用 Key');
  assert.equal(diskProvider(id).api_key, 'sk-two');
});

test('slug 校验、持久化与清除', async () => {
  const id = await createProvider({ api_key: 'sk-slug', slug: '  MiXr.Main_1 ' });
  assert.equal((await stateProvider(id)).slug, 'mixr.main_1', 'trim 后转小写');
  assert.equal(diskProvider(id).slug, 'mixr.main_1');

  for (const [slug, message] of [['bad slug!', /slug/], ['a'.repeat(33), /32/], [42, /字符串/]]) {
    const rejected = await request('/api/providers', 'POST', {
      name: '坏 slug', base_url: 'https://keys.example.com', api_key: 'sk-bad', slug,
    });
    assert.equal(rejected.status, 400, String(slug));
    assert.match(rejected.json.error, message);
  }
  assert.equal((await stateProvider(id)).slug, 'mixr.main_1', '被拒的创建不影响已有渠道');

  assert.equal((await request(`/api/providers/${id}`, 'PUT', { slug: 'Second.v2' })).status, 200);
  assert.equal(diskProvider(id).slug, 'second.v2');

  const bad = await request(`/api/providers/${id}`, 'PUT', { slug: '不合法!' });
  assert.equal(bad.status, 400);
  assert.equal(diskProvider(id).slug, 'second.v2', '被拒的更新不改原有 slug');

  assert.equal((await request(`/api/providers/${id}`, 'PUT', { slug: '' })).status, 200);
  assert.equal(Object.hasOwn(diskProvider(id), 'slug'), false, '空串表示不设,不留下空字段');
});
