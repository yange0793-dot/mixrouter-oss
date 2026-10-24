'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-harness-integration-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);
Object.assign(process.env, {
  HOME, MIXR_DATA_DIR: TMP,
  MIXR_CLAUDE_SETTINGS: path.join(HOME, 'claude.json'),
  MIXR_CODEX_CONFIG: path.join(HOME, 'codex.toml'),
  MIXR_ZCODE_CONFIG: path.join(HOME, 'zcode.json'),
  MIXR_HARNESS_PROFILE: path.join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
  MIXROUTER_PORT: '0', MIXUI_PORT: '0', MIXROUTER_ALT_PORTS: '',
  MIXR_MAX_ATTEMPTS: '1', MIXR_CONV_RETRIES: '0', MIXR_RETRY_DELAY_MS: '0',
  MIXR_RESPONSE_ARCHIVE: 'off', MIXR_SSE_KEEPALIVE_MS: '0', MIXR_LOG_RETAIN_DAYS: '0',
});
const mod = require('../mixrouter');
let proxy, ui, upstream;
const received = [];
function request(server, endpoint, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: endpoint,
      method, agent: false, headers: { 'content-type': 'application/json',
        'content-length': Buffer.byteLength(data), 'x-claude-code-session-id': 'same-client-session', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Harness fixture timed out')));
    req.on('error', reject);
    req.end(data);
  });
}
const prompt = alias => ({ model: alias, max_tokens: 64, stream: false,
  messages: [{ role: 'user', content: 'Fixture only.' }] });
before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push({ path: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/v1/responses') res.end(JSON.stringify({ id: 'resp_fixture', object: 'response',
        model: body.model, status: 'completed', output: [{ id: 'msg_fixture', type: 'message', role: 'assistant',
          status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } }));
      else res.end(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + upstream.address().port;
  mod._state.store = {
    claude: [{ id: 'native', name: 'Native', models: ['native-model', 'native-next'], model: 'native-model',
      base_url: base, api_key: 'fixture-native', enabled: true }],
    codex: [{ id: 'openai', name: 'OpenAI fixture', models: ['gpt-fixture'], model: 'gpt-fixture',
      base_url: base, api_key: 'fixture-openai', enabled: true }],
  };
  mod._state.current = { claude: 'native', codex: 'openai', zcode: 'native' };
  mod._state.routes = { rules: [], default: mod.normalizeRule({ provider: 'native', model: 'native-model' }) };
  mod._state.slotMap = { claude: { main: { provider: 'native', model: 'native-model' } }, codex: {} };
  mod._state.sessions.clear();
  proxy = await mod.listen(0, mod.proxyHandler);
  ui = await mod.listen(0, mod.apiHandler);
});
after(async () => {
  await Promise.all([proxy, ui, upstream].filter(Boolean).map(server => new Promise(resolve => {
    server.closeAllConnections(); server.close(resolve);
  })));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('Harness has a separate two-field configuration and model catalog', async () => {
  const before = structuredClone(mod._state.slotMap);
  const state = await request(ui, '/api/harness');
  assert.equal(state.status, 200);
  assert.equal(state.data.configured, false);
  const saved = await request(ui, '/api/harness', 'PUT', {
    expected_revision: state.data.revision,
    main: { provider: 'openai', model: 'gpt-fixture' },
    pool: [{ id: 'native-worker', provider: 'native', model: 'native-model' }],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.configured, true);
  assert.ok(saved.data.pool.some(item => item.provider === 'openai' && item.model === 'gpt-fixture'));
  assert.deepEqual(mod._state.slotMap, before);
  const listing = await request(proxy, '/harness/v1/models');
  assert.equal(listing.status, 200);
  assert.ok(listing.data.data.some(item => item.id === 'mixr-harness-main'));
  assert.ok(listing.data.data.every(item => item.id.startsWith('mixr-harness-')));
  assert.equal(fs.existsSync(process.env.MIXR_HARNESS_PROFILE), false, 'saving routes must not write a Harness profile');
  assert.equal(fs.existsSync(path.join(TMP, 'dsh.json')), false, 'retired config remains untouched');
});

test('Harness Messages routes to either provider group and main changes are hot', async () => {
  const response = await request(proxy, '/harness/v1/messages', 'POST', prompt('mixr-harness-main'));
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.content[0].text, 'OK');
  assert.equal(received.at(-1).path, '/v1/responses');
  assert.equal(received.at(-1).body.model, 'gpt-fixture');
  const state = (await request(ui, '/api/harness')).data;
  const worker = state.aliases.pool.find(item => item.id === 'native-worker').alias;
  assert.equal((await request(proxy, '/harness/v1/messages', 'POST', prompt(worker))).status, 200);
  assert.equal(received.at(-1).path, '/v1/messages');
  assert.equal(received.at(-1).body.model, 'native-model');
  const saved = await request(ui, '/api/harness', 'PUT', { expected_revision: state.revision,
    main: { provider: 'native', model: 'native-next' }, pool: state.pool });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal((await request(proxy, '/harness/v1/messages', 'POST', prompt('mixr-harness-main'))).status, 200);
  assert.equal(received.at(-1).path, '/v1/messages');
  assert.equal(received.at(-1).body.model, 'native-next');
  assert.equal((await request(proxy, '/v1/messages', 'POST', prompt('mixr-main'))).status, 200);
  assert.equal(received.at(-1).body.model, 'native-model', 'ordinary client slot stays unchanged');
});

test('unknown aliases and mismatched protocols never fall back to ordinary routes', async () => {
  const hits = received.length;
  for (const model of ['mixr-harness-not-in-pool', 'ordinary-model']) {
    const response = await request(proxy, '/harness/v1/messages', 'POST', prompt(model));
    assert.ok(response.status >= 400);
  }
  const unsupported = await request(proxy, '/harness/v1/responses', 'POST', { model: 'mixr-harness-main', input: 'fixture' });
  assert.ok(unsupported.status >= 400, 'native Anthropic route cannot receive Responses input');
  assert.equal(received.length, hits);
});

test('Harness writes reject cross-site requests, non-loopback Host and non-JSON bodies', async () => {
  const state = (await request(ui, '/api/harness')).data;
  const body = { expected_revision: state.revision, main: state.main, pool: state.pool };
  const before = fs.readFileSync(path.join(TMP, 'harness.json'), 'utf8');
  for (const [headers, status] of [
    [{ origin: 'https://unrelated.invalid', 'sec-fetch-site': 'cross-site' }, 403],
    [{ host: 'unrelated.invalid' }, 403],
    [{ 'content-type': 'text/plain' }, 415],
  ]) assert.equal((await request(ui, '/api/harness', 'PUT', body, headers)).status, status);
  assert.equal(fs.readFileSync(path.join(TMP, 'harness.json'), 'utf8'), before);
  assert.equal(fs.existsSync(process.env.MIXR_HARNESS_PROFILE), false);
});

test('optimistic conflict and preview are side-effect-free', async () => {
  const state = (await request(ui, '/api/harness')).data;
  const before = fs.readFileSync(path.join(TMP, 'harness.json'), 'utf8');
  const conflict = await request(ui, '/api/harness', 'PUT', { expected_revision: 'stale', main: state.main, pool: state.pool });
  assert.equal(conflict.status, 409);
  const absent = await request(ui, '/api/harness/preview', 'POST', { expected_revision: state.revision });
  assert.equal(absent.status, 409, 'missing native composition must not be initialized speculatively');
  fs.mkdirSync(path.dirname(process.env.MIXR_HARNESS_PROFILE), { recursive: true });
  const native = '- id: llm-pi-ai\n  config:\n    providers: {}\n- id: agent-default-model\n  config:\n    provider: fixture-native\n    model: fixture-native\n- id: subagent-model-selection-settings\n  config:\n    enabled: false\n    allowedModels: []\n';
  fs.writeFileSync(process.env.MIXR_HARNESS_PROFILE, native, { mode: 0o600 });
  const preview = await request(ui, '/api/harness/preview', 'POST', { expected_revision: state.revision });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.ok(preview.data.changes.length > 0);
  assert.ok(preview.data.changes.every(change => Object.hasOwn(change, 'before') && Object.hasOwn(change, 'after')),
    'the real UI requires complete before/after preview fields');
  assert.equal(fs.readFileSync(process.env.MIXR_HARNESS_PROFILE, 'utf8'), native, 'preview preserves native profile bytes');
  assert.equal(fs.readFileSync(path.join(TMP, 'harness.json'), 'utf8'), before);
  const forbidden = await request(ui, '/api/harness', 'PUT', { expected_revision: state.revision, main: state.main,
    pool: state.pool, owner: 'mixrouter' });
  assert.equal(forbidden.status, 400);
});
