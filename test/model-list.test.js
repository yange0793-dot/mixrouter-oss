'use strict';
// GET /v1/models 的清单:同一模型被多个渠道登记时,裸名在精确模型阶段必然 409,
// 所以改为输出能唯一解析回该渠道的前缀名(slug → 归一化显示名 → 渠道 id);
// 只被一个渠道登记的模型保持裸名,槽位别名照旧输出。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-model-list-prefix-'));
process.env.MIXR_DATA_DIR = tmp;
process.env.MIXR_CLAUDE_SETTINGS = path.join(tmp, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(tmp, 'config.toml');
const router = require('../mixrouter');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ids = () => router.modelList().data;
const idsWith = owner => ids().filter(item => item.owned_by === owner).map(item => item.id);

test('同名模型跨渠道:输出带前缀的名字,优先 slug,其次归一化名,归一化名不唯一时用渠道 id', () => {
  router._state.store = {
    claude: [],
    codex: [
      // slug 优先:即便显示名与 p4 撞,也用 slug
      { id: 'p1', name: 'AgentRouter', slug: 'ar-main', enabled: true, api_key: 'k1', model: 'solo', models: ['shared'] },
      { id: 'p2', name: 'Happy coding', enabled: true, api_key: 'k2', model: 'shared', models: [] },
      { id: 'p3', name: 'anyrouter', enabled: true, api_key: 'k3', model: 'shared' },
      // 与 p1 显示名归一化后相同 → 退回渠道 id
      { id: 'p4', name: 'AgentRouter', enabled: true, api_key: 'k4', model: 'shared' },
      { id: 'p5', name: 'Disabled', enabled: false, api_key: 'k5', model: 'ghost-model' },
    ],
  };
  router._state.slotMap = { claude: {}, codex: { main: { provider: 'p1', model: 'shared' } } };
  router._state.routes = { rules: [] };

  const data = ids();
  // shared 登记在 4 条渠道上:一个裸名都不能出现
  assert.equal(data.some(item => item.id === 'shared'), false, '重名模型不再输出必然 409 的裸名');
  assert.deepEqual(idsWith('AgentRouter').sort(), ['ar-main/shared', 'p4/shared', 'solo'],
    'slug 优先(p1);p4 与 p1 显示名归一化后相同则改用渠道 id;唯一模型保持裸名');
  assert.deepEqual(idsWith('Happy coding'), ['happycoding/shared']);
  assert.deepEqual(idsWith('anyrouter'), ['anyrouter/shared']);
  assert.equal(data.some(item => item.id === 'p4/shared'), true, '归一化名不唯一时用渠道 id');
  // 停用渠道不出现
  assert.equal(data.some(item => item.id === 'ghost-model'), false);
  // 槽位别名照旧
  assert.ok(data.some(item => item.id === 'mixr-main' && item.owned_by === 'slot:main'));
});

test('大小写不同的同名模型按同一个模型处理,两种拼写都不输出裸名', () => {
  router._state.store = {
    claude: [],
    codex: [
      { id: 'c1', name: 'case one', enabled: true, api_key: 'k1', model: 'GPT-X', models: [] },
      { id: 'c2', name: 'case two', enabled: true, api_key: 'k2', model: 'gpt-x', models: [] },
      { id: 'c3', name: 'solo one', enabled: true, api_key: 'k3', model: 'unique-model', models: [] },
    ],
  };
  router._state.slotMap = { claude: {}, codex: {} };
  const data = ids();
  assert.deepEqual(idsWith('case one'), ['caseone/GPT-X']);
  assert.deepEqual(idsWith('case two'), ['casetwo/gpt-x']);
  assert.equal(data.some(item => item.id === 'GPT-X' || item.id === 'gpt-x'), false);
  assert.deepEqual(idsWith('solo one'), ['unique-model'], '只被一个渠道登记时保持裸名');
});

test('输出形状保持 {object:"list", data:[{id, object, owned_by}]}', () => {
  router._state.store = { claude: [], codex: [
    { id: 'p1', name: 'Only', enabled: true, api_key: 'k1', model: 'm1', models: ['m1'] },
  ] };
  router._state.slotMap = { claude: {}, codex: {} };
  const out = router.modelList();
  assert.equal(out.object, 'list');
  assert.ok(Array.isArray(out.data));
  for (const item of out.data) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'object', 'owned_by']);
    assert.equal(item.object, 'model');
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.owned_by, 'string');
  }
  assert.deepEqual(out.data, [{ id: 'm1', object: 'model', owned_by: 'Only' }]);
});
