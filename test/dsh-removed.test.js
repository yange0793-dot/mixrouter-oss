'use strict';
// Retired Harness endpoints must not fall through to ordinary client routing.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-dsh-removed-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);
Object.assign(process.env, {
  HOME, MIXR_DATA_DIR: TMP,
  MIXR_CLAUDE_SETTINGS: path.join(HOME, 'claude.json'),
  MIXR_CODEX_CONFIG: path.join(HOME, 'codex.toml'),
  MIXR_ZCODE_CONFIG: path.join(HOME, 'zcode.json'),
  MIXR_DSH_CONFIG: path.join(HOME, '.dsh', 'profile.yml'),
  MIXR_DSH_APP: path.join(TMP, 'absent-harness'),
  MIXROUTER_PORT: '0', MIXUI_PORT: '0', MIXROUTER_ALT_PORTS: '',
  MIXR_MAX_ATTEMPTS: '1', MIXR_CONV_RETRIES: '0', MIXR_RETRY_DELAY_MS: '0',
  MIXR_RESPONSE_ARCHIVE: 'off', MIXR_SSE_KEEPALIVE_MS: '0', MIXR_LOG_RETAIN_DAYS: '0',
});
const mod = require('../mixrouter');
let ui, proxy, upstream;
let hits = 0;

function request(server, endpoint, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: endpoint, method, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('retired endpoint fixture timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

before(async () => {
  upstream = http.createServer((req, res) => {
    hits++;
    req.resume();
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"retired endpoints must never reach this upstream"}}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const provider = (id, wire_api) => ({ id, name: id, model: 'ordinary-model',
    models: ['ordinary-model'], wire_api, enabled: true, api_key: 'fixture-key',
    base_url: 'http://127.0.0.1:' + upstream.address().port });
  mod._state.store = { claude: [provider('cc', 'anthropic')], codex: [provider('cx', 'responses')] };
  mod._state.current = { claude: 'cc', codex: 'cx', zcode: 'cc' };
  mod._state.routes = { rules: [], default: mod.normalizeRule({ provider: 'cc', model: 'ordinary-model' }) };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.sessions.clear();
  ui = await mod.listen(0, mod.apiHandler);
  proxy = await mod.listen(0, mod.proxyHandler);
});

after(async () => {
  await Promise.all([upstream, ui, proxy].filter(Boolean).map(server => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  })));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('retired Harness paths are not classified as Claude or Codex endpoints', () => {
  for (const endpoint of ['/dsh/v1/responses', '/dsh/v1/responses/?q=1',
    '/dsh/v1/chat/completions', '/dsh/v1/messages', '/dsh/v1/models']) {
    assert.equal(mod.classifyProxyRequest({ url: endpoint }), null, endpoint);
  }
  for (const [endpoint, app, kind] of [
    ['/v1/messages', 'claude', 'messages'], ['/v1/messages/count_tokens', 'claude', 'count_tokens'],
    ['/v1/responses', 'codex', 'responses'], ['/v1/responses/compact', 'codex', 'responses/compact'],
    ['/v1/chat/completions', 'codex', 'chat/completions'],
  ]) {
    const ep = mod.classifyProxyRequest({ url: endpoint });
    assert.equal(ep.app, app); assert.equal(ep.kind, kind); assert.equal(ep.client, undefined);
  }
});

test('retired proxy paths return 404 before reading a body or using ordinary routes', async () => {
  const sessions = structuredClone([...mod._state.sessions]);
  const beforeLogs = (await request(ui, '/api/logs')).data.logs;
  for (const endpoint of ['/dsh/v1', '/dsh/v1/models', '/dsh/v1/responses',
    '/dsh/v1/chat/completions', '/dsh/v1/responses/compact', '/dsh/v1/messages']) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const result = await request(proxy, endpoint, method,
        method === 'POST' ? { model: 'ordinary-model', input: 'fixture' } : undefined);
      assert.equal(result.status, 404, method + ' ' + endpoint);
    }
  }
  assert.equal(hits, 0, 'a configured ordinary fallback must not receive retired endpoint traffic');
  assert.deepEqual([...mod._state.sessions], sessions);
  assert.deepEqual((await request(ui, '/api/logs')).data.logs, beforeLogs);
  assert.equal(fs.existsSync(path.join(HOME, '.dsh')), false);
  assert.equal(fs.existsSync(path.join(TMP, 'dsh.json')), false);
});

test('removed Harness console APIs return 404 and do not expose a client base URL', async () => {
  const before = structuredClone({ store: mod._state.store, current: mod._state.current,
    routes: mod._state.routes, slots: mod._state.slotMap });
  for (const [endpoint, method] of [
    ['/api/dsh', 'GET'], ['/api/dsh', 'PUT'], ['/api/dsh', 'POST'], ['/api/dsh', 'DELETE'],
    ['/api/dsh/preview', 'POST'], ['/api/dsh/sync', 'POST'], ['/api/dsh/models', 'GET'],
  ]) {
    const result = await request(ui, endpoint, method, method === 'GET' ? undefined : { confirm: true });
    assert.equal(result.status, 404, method + ' ' + endpoint);
  }
  const state = (await request(ui, '/api/state')).data;
  assert.equal(Object.hasOwn(state.router, 'dsh_base'), false);
  assert.deepEqual(Object.keys(state.live).sort(), ['claude', 'codex', 'zcode']);
  assert.equal(state.router.claude_base, mod.ROUTER_URL);
  assert.equal(state.router.codex_base, mod.ROUTER_URL + '/v1');
  assert.equal(state.router.zcode_base, mod.ROUTER_URL);
  assert.deepEqual({ store: mod._state.store, current: mod._state.current,
    routes: mod._state.routes, slots: mod._state.slotMap }, before);
  assert.equal(fs.existsSync(process.env.MIXR_DSH_CONFIG), false);
  assert.equal(fs.existsSync(path.join(TMP, 'dsh.json')), false);
  const harness = await request(ui, '/api/harness');
  assert.equal(harness.status, 200, 'new lightweight API is independent of retired /api/dsh');
  assert.equal(harness.data.configured, false);
  assert.equal(fs.existsSync(path.join(TMP, 'harness.json')), false);
});

test('ordinary model listing and both health endpoints still work without a configured Harness pool', async () => {
  assert.equal((await request(proxy, '/healthz')).status, 200);
  assert.equal((await request(ui, '/healthz')).status, 200);
  const models = await request(proxy, '/v1/models');
  assert.equal(models.status, 200);
  assert.ok(models.data.data.some(model => model.id === 'ordinary-model'));
  assert.ok(models.data.data.every(model => !model.id.startsWith('mixr-dsh-')));
  for (const endpoint of ['/v1/messages', '/v1/responses', '/v1/chat/completions'])
    assert.equal((await request(proxy, endpoint, 'HEAD')).status, 200, endpoint);
  assert.equal(hits, 0);
});

test('missing, legacy and malformed dsh.json are never read or rewritten during startup', () => {
  const probe = `
    const fs = require('node:fs');
    const touched = [];
    const retired = value => typeof value === 'string' && /(?:^|[/\\\\])(?:\\.dsh(?:[/\\\\]|$)|dsh\\.json$|profile\\.yml$)/.test(value);
    for (const name of ['readFileSync', 'writeFileSync', 'mkdirSync', 'openSync',
      'lstatSync', 'existsSync', 'statSync', 'renameSync']) {
      const original = fs[name];
      fs[name] = function (...args) {
        if (args.some(retired)) { touched.push(name); throw new Error('retired Harness path was accessed'); }
        return original.apply(this, args);
      };
    }
    const mod = require(process.argv[1]);
    process.stdout.write(JSON.stringify({ loaded: !!mod.proxyHandler, touched,
      endpoint: mod.classifyProxyRequest({ url: '/dsh/v1/responses' }),
      models: mod.modelList() }));
  `;
  const cases = [undefined, '{"version":1,"slots":{"main":{"provider":"old","model":"old"}},"default_subagent":""}',
    '{"version":2,"slots":{},"subagents":{"owner":"mixrouter"}}', '{malformed'];
  for (const [index, original] of cases.entries()) {
    const root = path.join(TMP, 'startup-' + index);
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(root, 'dsh.json');
    if (original !== undefined) fs.writeFileSync(file, original);
    const out = execFileSync(process.execPath, ['-e', probe, path.join(ROOT, 'mixrouter.js')], {
      cwd: ROOT, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, HOME: home, MIXR_DATA_DIR: root,
        MIXR_CLAUDE_SETTINGS: path.join(home, 'claude.json'), MIXR_CODEX_CONFIG: path.join(home, 'codex.toml'),
        MIXR_ZCODE_CONFIG: path.join(home, 'zcode.json'), MIXR_DSH_CONFIG: path.join(home, '.dsh', 'profile.yml'),
        DSH_HOME: path.join(home, '.dsh'), MIXR_DSH_APP: 'obsolete-relative-app-path' },
    });
    assert.deepEqual(JSON.parse(out), { loaded: true, touched: [], endpoint: null, models: { object: 'list', data: [] } });
    assert.equal(fs.existsSync(file), original !== undefined);
    if (original !== undefined) assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.existsSync(path.join(home, '.dsh')), false);
  }
});
