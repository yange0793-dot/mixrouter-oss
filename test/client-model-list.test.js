'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-model-list-'));
process.env.MIXR_DATA_DIR = tmp;
process.env.MIXR_CLAUDE_SETTINGS = path.join(tmp, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(tmp, 'config.toml');
const router = require('../mixrouter');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('Codex model list includes registered candidates and effective slot targets without changing defaults', () => {
  router._state.store = {
    claude: [],
    codex: [
      { id: 'p1', name: 'Primary', enabled: true, model: 'default-model', models: ['default-model', 'second-model', 'second-model', '  third-model  '] },
      { id: 'p2', name: 'Disabled', enabled: false, model: 'disabled-default', models: ['disabled-extra'] },
      { id: 'p3', name: 'Legacy', enabled: true, model: 'legacy-default' },
    ],
  };
  router._state.slotMap = { claude: {}, codex: {
    main: { provider: 'p1', model: 'custom-main' },
    reviewer: { provider: 'p1', model: 'second-model' },
    worker: { provider: 'p3' },
    disabled: { provider: 'p2', model: 'disabled-target' },
    missing: { provider: 'gone', model: 'missing-target' },
  } };
  router._state.routes = { rules: [], default: {} };
  const before = JSON.stringify(router._state.store);
  const data = router.modelList().data;
  const primary = data.filter(item => item.owned_by === 'Primary').map(item => item.id);
  assert.deepEqual(primary, ['default-model', 'second-model', 'third-model', 'custom-main']);
  assert.ok(data.some(item => item.id === 'legacy-default' && item.owned_by === 'Legacy'));
  for (const name of ['main', 'reviewer', 'worker', 'disabled', 'missing']) {
    assert.ok(data.some(item => item.id === 'mixr-' + name && item.owned_by === 'slot:' + name));
  }
  for (const model of ['disabled-default', 'disabled-extra', 'disabled-target', 'missing-target']) {
    assert.equal(data.some(item => item.id === model), false, model);
  }
  assert.equal(JSON.stringify(router._state.store), before);
});
