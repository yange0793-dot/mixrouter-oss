'use strict';
// Claude 转换渠道的出站速度档 API:只收 Claude 组的 responses/chat 渠道,
// 且按档位分别匹配 OpenAI 官方明确支持的 GPT 模型;落盘可回读,关闭即删字段。
// DeepSeek 等兼容网关、原生 Anthropic 与 Codex 渠道一律拒绝。
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-claude-speed-'));
const providersFile = path.join(root, 'providers.json');
const slotsFile = path.join(root, 'slots.json');
process.env.MIXR_DATA_DIR = root;
process.env.MIXR_CODEX_CONFIG = path.join(root, 'config.toml');
process.env.MIXR_CLAUDE_SETTINGS = path.join(root, 'claude.json');
const router = require('../mixrouter');
let ui;

const provider = over => ({
  id: 'p', name: 'provider', base_url: 'https://upstream.example', api_key: 'sk-pair-secret',
  models: ['claude-model'], enabled: true, ...over,
});
const request = (endpoint, body, method = 'POST') => new Promise((resolve, reject) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  const req = http.request({ hostname: '127.0.0.1', port: ui.address().port, path: endpoint, method,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('error', reject);
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      let json;
      try { json = JSON.parse(text); } catch { json = undefined; }
      resolve({ status: res.statusCode, text, json });
    });
  });
  req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
  req.on('error', reject);
  req.end(text);
});
const diskStore = () => JSON.parse(fs.readFileSync(providersFile, 'utf8'));
const claudeOnDisk = id => diskStore().claude.find(p => p.id === id);

before(async () => { ui = await router.listen(0, router.apiHandler); });
beforeEach(() => {
  for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  router._state.store = {
    claude: [
      provider({ id: 'pspeedr', name: 'responses', wire_api: 'responses', models: ['gpt-6-astra'] }),
      provider({ id: 'pspeedc', name: 'chat', wire_api: 'chat', models: ['gpt-6.2-sol'] }),
      provider({ id: 'pspeedf', name: 'fast-only', wire_api: 'responses', models: ['gpt-5.6-sol'] }),
      provider({ id: 'pspeedmix', name: 'mixed', wire_api: 'responses', models: ['gpt-5.6-sol', 'gpt-6.2-astra'] }),
      provider({ id: 'pspeedd', name: 'deepseek', wire_api: 'responses', models: ['deepseek-v4.1-flash'] }),
      provider({ id: 'pspeedn', name: 'native', models: ['claude-model'] }),
    ],
    codex: [provider({ id: 'csync1', name: 'codex', wire_api: 'responses', model: 'gpt-model', models: ['gpt-model'] })],
  };
  router._state.current = { claude: null, codex: null };
  router._state.slotMap = { claude: {}, codex: {} };
  router._state.routes = { rules: [] };
  fs.writeFileSync(providersFile, JSON.stringify({ version: 2, current: router._state.current, ...router._state.store }, null, 2) + '\n');
  fs.writeFileSync(slotsFile, JSON.stringify({ version: 1, ...router._state.slotMap }, null, 2) + '\n');
});
after(async () => {
  await new Promise(resolve => { ui.close(resolve); ui.closeAllConnections(); });
  fs.rmSync(root, { recursive: true, force: true });
});

test('Claude 速度 API:按档位只收官方支持的 GPT 模型,落盘可回读,关闭即删字段', async () => {
  const route = id => `/api/providers/${id}/claude-speed`;

  // 默认没有档位:不凭接口存在就凭空写一个 service_tier。
  let state = JSON.parse((await request('/api/state', undefined, 'GET')).text);
  assert.equal(state.providers.claude.find(p => p.id === 'pspeedr').claude_speed_mode, undefined);

  // Ultrafast:GPT-6.2 Sol / GPT-6 Astra;Fast:GPT-5.6 Sol 与 GPT-6 四个模型;
  // 同一渠道两种模型都登记时两档都可设。
  const ultra = await request(route('pspeedr'), { mode: 'ultrafast' });
  assert.equal(ultra.status, 200);
  assert.equal(ultra.json.ok, true);
  assert.equal(ultra.json.mode, 'ultrafast');
  assert.equal(ultra.json.speed_mode, 'ultrafast');
  assert.ok(!ultra.text.includes('sk-pair-secret'), '响应不能回显渠道 Key');
  assert.equal(claudeOnDisk('pspeedr').claude_speed_mode, 'ultrafast');
  assert.equal((await request(route('pspeedr'), { mode: 'fast' })).status, 200);
  assert.equal(claudeOnDisk('pspeedr').claude_speed_mode, 'fast');
  assert.equal((await request(route('pspeedc'), { mode: 'ultrafast' })).status, 200);
  assert.equal(claudeOnDisk('pspeedc').claude_speed_mode, 'ultrafast');
  const fast = await request(route('pspeedf'), { mode: 'fast' });
  assert.equal(fast.status, 200);
  assert.equal(fast.json.speed_mode, 'fast');
  assert.equal(claudeOnDisk('pspeedf').claude_speed_mode, 'fast');
  assert.equal((await request(route('pspeedmix'), { mode: 'fast' })).status, 200);
  assert.equal((await request(route('pspeedmix'), { mode: 'ultrafast' })).status, 200);
  assert.equal(claudeOnDisk('pspeedmix').claude_speed_mode, 'ultrafast');

  // 持久化读回:接口状态与实际 store 一致。
  state = JSON.parse((await request('/api/state', undefined, 'GET')).text);
  assert.equal(state.providers.claude.find(p => p.id === 'pspeedr').claude_speed_mode, 'fast');
  assert.equal(router._state.store.claude.find(p => p.id === 'pspeedr').claude_speed_mode, 'fast');

  const off = await request(route('pspeedr'), { mode: '' });
  assert.equal(off.status, 200);
  assert.equal(off.json.mode, '');
  assert.equal(off.json.speed_mode, '');
  assert.equal(router._state.store.claude.find(p => p.id === 'pspeedr').claude_speed_mode, undefined);
  assert.equal(claudeOnDisk('pspeedr').claude_speed_mode, undefined);

  // 非法档位 / 档位与模型不匹配 / DeepSeek / 原生 anthropic / Codex 渠道一律 400,
  // 且不改已落盘的库。
  const before = JSON.stringify(diskStore().claude);
  for (const body of [{ mode: 'priority' }, { mode: 'FAST' }, {}, { mode: null }]) {
    assert.equal((await request(route('pspeedr'), body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await request(route('pspeedf'), { mode: 'ultrafast' })).status, 400,
    'GPT-5.6 Sol 只有 Fast,不能设为 Ultra Fast');
  for (const mode of ['fast', 'ultrafast']) {
    const deepseek = await request(route('pspeedd'), { mode });
    assert.equal(deepseek.status, 400, 'DeepSeek 渠道不认识 GPT 的 service_tier');
    assert.match(deepseek.json.error, /GPT/);
    assert.equal((await request(route('pspeedn'), { mode })).status, 400);
    assert.equal((await request(route('csync1'), { mode })).status, 400);
  }
  assert.equal((await request(route('missing'), { mode: 'fast' })).status, 404);
  assert.equal(JSON.stringify(diskStore().claude), before);
  assert.equal(router._state.store.claude.find(p => p.id === 'pspeedd').claude_speed_mode, undefined);
  assert.equal(router._state.store.claude.find(p => p.id === 'pspeedn').claude_speed_mode, undefined);
  assert.equal(router._state.store.codex.find(p => p.id === 'csync1').claude_speed_mode, undefined);
});

test('Claude 速度 PUT 白名单:按档位校验,可写可清,改模型或改回原生 anthropic 一起清掉', async () => {
  const put = (id, body) => request(`/api/providers/${id}`, body, 'PUT');

  assert.equal((await put('pspeedr', { claude_speed_mode: 'ultrafast' })).status, 200);
  assert.equal(claudeOnDisk('pspeedr').claude_speed_mode, 'ultrafast');
  assert.equal((await put('pspeedr', { claude_speed_mode: 'fast' })).status, 200);
  assert.equal(claudeOnDisk('pspeedr').claude_speed_mode, 'fast');
  assert.equal((await put('pspeedr', { claude_speed_mode: 'ultrafast' })).status, 200);
  assert.equal(claudeOnDisk('pspeedr').claude_speed_mode, 'ultrafast');

  assert.equal((await put('pspeedf', { claude_speed_mode: 'fast' })).status, 200);
  assert.equal((await put('pspeedf', { claude_speed_mode: 'ultrafast' })).status, 400);

  assert.equal((await put('pspeedr', { claude_speed_mode: 'bogus' })).status, 400);
  assert.equal((await put('pspeedr', { claude_speed_mode: 'fast', wire_api: 'anthropic' })).status, 400,
    '同一次请求改回原生 Anthropic 时不能同时设速度档');
  assert.equal(claudeOnDisk('pspeedr').claude_speed_mode, 'ultrafast');
  assert.equal((await put('pspeedd', { claude_speed_mode: 'ultrafast' })).status, 400,
    'DeepSeek 渠道不能通过 PUT 绕过模型门禁');

  assert.equal((await put('csync1', { claude_speed_mode: 'fast' })).status, 400);
  assert.equal((await put('pspeedc', { claude_speed_mode: '' })).status, 200);
  assert.equal(claudeOnDisk('pspeedc').claude_speed_mode, undefined);

  // 把对应档位的 GPT 模型移出清单 = 档位没有落点,必须一起清掉;换回来才能重新开启。
  assert.equal((await put('pspeedr', { models: ['deepseek-v4.1-flash'] })).status, 200);
  assert.equal(claudeOnDisk('pspeedr').claude_speed_mode, undefined);
  assert.equal((await put('pspeedr', { models: ['gpt-6.2-astra'], claude_speed_mode: 'ultrafast' })).status, 200);
  assert.equal(claudeOnDisk('pspeedr').claude_speed_mode, 'ultrafast');

  // 换成只支持 Fast 的模型:Ultra Fast 没有落点,同样清掉;Fast 可以重新开启。
  assert.equal((await put('pspeedr', { models: ['gpt-5.6-sol'] })).status, 200);
  assert.equal(claudeOnDisk('pspeedr').claude_speed_mode, undefined);
  assert.equal((await put('pspeedr', { claude_speed_mode: 'fast' })).status, 200);
  assert.equal(claudeOnDisk('pspeedr').claude_speed_mode, 'fast');

  assert.equal((await put('pspeedr', { wire_api: 'anthropic' })).status, 200);
  assert.equal(claudeOnDisk('pspeedr').claude_speed_mode, undefined,
    '改回原生 Anthropic 后档位没有意义,必须一起清掉');
  assert.equal((await put('pspeedr', { claude_speed_mode: 'ultrafast' })).status, 400,
    '原生 Anthropic 渠道不能设速度档');
});
