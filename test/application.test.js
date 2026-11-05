'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApplication } = require('../lib/application');

test('application instances use their injected home and data directory for every config endpoint', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-app-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const instances = [];
  for (const name of ['one', 'two']) {
    const home = path.join(root, name), data = path.join(home, 'data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'providers.json'), JSON.stringify({ version: 2, claude: [{
      id: name, name, base_url: 'http://127.0.0.1:1', models: ['local-model'], api_key: 'fixture', enabled: true,
    }], codex: [] }));
    const app = createApplication({ root: path.resolve(__dirname, '..'), version: 'test', home,
      env: { MIXR_DATA_DIR: data, MIXROUTER_PORT: '0', MIXUI_PORT: '0' } });
    const server = await app.listen(0, app.apiHandler);
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const request = async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, body ? {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      } : {});
      assert.equal(response.status, 200);
      return response.json();
    };
    const backups = await request('/api/backups');
    assert.deepEqual(backups.dirs.map(entry => entry.dir),
      [data, path.join(home, '.claude'), path.join(home, '.codex')]);
    const bots = await request('/api/bots');
    await request('/api/bots', { expected_revision: bots.revision,
      bots: [{ id: 'bot-' + name, name: 'fixture-' + name, provider: name, model: 'local-model' }] });
    assert.ok(fs.existsSync(path.join(data, 'bots.json')));
    instances.push({ request, name });
  }
  for (const { request, name } of instances) {
    assert.equal((await request('/api/bots')).bots[0].provider, name);
    assert.equal((await request('/api/state')).providers.claude[0].id, name);
  }
});

test('malformed persisted configuration fails startup without replacing user data', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'providers.json');
  const original = '{"claude": invalid';
  fs.writeFileSync(file, original);
  assert.throws(() => createApplication({ root, version: 'test', home: root, env: { MIXR_DATA_DIR: root } }),
    /providers.json.*JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
