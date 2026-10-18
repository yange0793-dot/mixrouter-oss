'use strict';
// Temporary state and loopback HTTP; records the real proxy's transport selector input.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-direct-api-'));
process.env.MIXR_DATA_DIR = root;
process.env.MIXR_CLAUDE_SETTINGS = path.join(root, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(root, 'config.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
const transport = require('../lib/upstream-proxy');
const original = transport.transportAgent;
const selections = [];
transport.transportAgent = (protocol, provider) => {
  selections.push({ protocol, direct: provider && provider.direct });
  return original(protocol, provider);
};
const mod = require('../mixrouter');
transport.transportAgent = original;
function request(server, route, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let text = ''; res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(data);
  });
}
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
test('direct API enforces booleans, survives updates, and reaches the actual proxy transport', async t => {
  const upstream = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"fixture","type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const ui = await mod.listen(0, mod.apiHandler), proxy = await mod.listen(0, mod.proxyHandler);
  t.after(async () => {
    await Promise.all([ui, proxy, upstream].map(close));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const input = { app: 'claude', name: 'fixture', base_url: `http://127.0.0.1:${upstream.address().port}`,
    api_key: 'test-only', models: ['fixture-model'], direct: true };
  assert.equal((await request(ui, '/api/providers', 'POST', { ...input, direct: 'false' })).status, 400);
  assert.equal(mod._state.store.claude.length, 0);
  const created = await request(ui, '/api/providers', 'POST', input);
  assert.equal(created.status, 200);
  const id = created.data.id, route = '/api/providers/' + id;
  const provider = () => mod._state.store.claude.find(p => p.id === id);
  assert.equal(provider().direct, true);
  assert.equal((await request(ui, route, 'PUT', { note: 'kept' })).status, 200);
  assert.equal(provider().direct, true);
  const before = JSON.stringify(provider());
  for (const direct of ['true', 'false', 1, null, {}]) {
    assert.equal((await request(ui, route, 'PUT', { direct })).status, 400);
    assert.equal(JSON.stringify(provider()), before);
  }
  mod._state.routes = { rules: [], default: { provider: id } };
  const body = { model: 'fixture-model', max_tokens: 1, messages: [{ role: 'user', content: 'fixture' }] };
  assert.equal((await request(proxy, '/v1/messages', 'POST', body)).status, 200);
  assert.deepEqual(selections.at(-1), { protocol: 'http:', direct: true });
  assert.equal((await request(ui, route, 'PUT', { direct: false })).status, 200);
  assert.equal(Object.hasOwn(provider(), 'direct'), false);
  assert.equal((await request(proxy, '/v1/messages', 'POST', body)).status, 200);
  assert.deepEqual(selections.at(-1), { protocol: 'http:', direct: undefined });
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'providers.json')));
  assert.equal(Object.hasOwn(stored.claude[0], 'direct'), false);
});
