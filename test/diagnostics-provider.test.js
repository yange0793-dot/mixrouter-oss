'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parse } = require('../scripts/diagnose-upstream');
const { LIMITS, options, loadProvider } = require('../lib/diagnostics/provider');
const { requestSpec } = require('../lib/diagnostics/provider-worker');
const ROOT = path.resolve(__dirname, '..');
const BASE = { mode: 'provider', provider: 'chosen', requests: 1, confirm: true };
const SECRET = 'sk-isolated-provider-secret';

test('provider diagnostics require mode, confirmation, selected ID and explicit bounded count', () => {
  for (const key of ['mode', 'provider', 'requests', 'confirm']) {
    const input = { ...BASE }; delete input[key]; assert.throws(() => options(input));
  }
  for (const [key, max] of Object.entries(LIMITS)) {
    for (const value of [0, -1, 1.5, max + 1, Infinity, '1']) assert.throws(() => options({ ...BASE, [key]: value }));
  }
  for (const extra of [{ url: 'http://localhost' }, { api_key: 'secret' }, { scenario: '500' }]) assert.throws(() => options({ ...BASE, ...extra }));
  assert.equal(parse(['--mode', 'provider', '--provider', 'chosen', '--requests', '1', '--confirm-run']).mode, 'provider');
  assert.throws(() => parse(['--provider', 'chosen', '--requests', '1', '--confirm-run']));
  assert.throws(() => parse(['--mode', 'provider', '--provider', 'chosen', '--requests', '1']));
});

async function fixture(t, handler, extra = {}, app = 'claude') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-provider-test-'));
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) });
      handler(req, res, seen.length);
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = { id: 'chosen', enabled: true, base_url: `http://127.0.0.1:${server.address().port}/prefix/v1`, api_key: SECRET, models: ['known-model'], direct: true, ...extra };
  const store = { claude: [], codex: [] }; store[app].push(provider);
  fs.writeFileSync(path.join(root, 'providers.json'), JSON.stringify(store));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, seen, provider };
}
function cli(root, args = [], spawnHook) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/diagnose-upstream.js'), '--mode', 'provider', '--provider', 'chosen', '--confirm-run', ...args], {
      env: { ...process.env, MIXR_DATA_DIR: root, MIXR_UPSTREAM_PROXY: 'not-a-valid-proxy-url' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('diagnostic CLI did not terminate')); }, 8000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (spawnHook) spawnHook(child);
  });
}

test('provider diagnostics count 200/429/500/302 once each and never follow or leak bodies/keys', async t => {
  const f = await fixture(t, (req, res, n) => {
    res.writeHead([200, 429, 500, 302][n - 1] || 599, { Location: '/must-not-follow' });
    res.end('PRIVATE_RESPONSE_BODY ' + SECRET);
  });
  const result = await cli(f.root, ['--requests', '4', '--concurrency', '2']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.requests, 4);
  assert.equal(f.seen.length, 4, 'no retries or redirect follow-up');
  assert.deepEqual(report.statusDistribution, { 200: 1, 429: 1, 500: 1, 302: 1 });
  assert.ok(report.peakConcurrency <= 2);
  assert.ok(report.latencyMs.p95 >= report.latencyMs.p50);
  assert.ok(!result.stdout.includes(SECRET) && !result.stdout.includes('PRIVATE_RESPONSE_BODY'));
  for (const call of f.seen) {
    assert.equal(call.url, '/prefix/v1/messages');
    assert.equal(call.body.max_tokens, 1);
    assert.equal(call.headers['x-api-key'], SECRET);
  }
});

test('provider diagnostics choose configured chat/responses protocol and explicit model', async t => {
  for (const wire_api of ['chat', 'responses']) {
    const f = await fixture(t, (req, res) => res.end('{}'), { wire_api }, 'codex');
    const result = await cli(f.root, ['--requests', '1', '--model', 'explicit-model']);
    assert.equal(result.code, 0, result.stderr);
    const call = f.seen[0];
    assert.equal(call.url, wire_api === 'chat' ? '/prefix/v1/chat/completions' : '/prefix/v1/responses');
    assert.equal(call.body.model, 'explicit-model');
    assert.equal(call.headers.authorization, 'Bearer ' + SECRET);
    assert.equal(wire_api === 'chat' ? call.body.max_tokens : call.body.max_output_tokens, wire_api === 'chat' ? 1 : 16);
  }
});

test('provider diagnostics validate config without selecting other providers', async t => {
  assert.throws(() => loadProvider({}, BASE), /MIXR_DATA_DIR/);
  const f = await fixture(t, (req, res) => res.end('{}'), { enabled: false });
  const result = await cli(f.root, ['--requests', '1']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /停用/);
  assert.equal(f.seen.length, 0);
  const missingCount = await cli(f.root);
  assert.equal(missingCount.code, 1);
  assert.equal(f.seen.length, 0);
  const missingModel = { ...f.provider, enabled: true, models: [] };
  fs.writeFileSync(path.join(f.root, 'providers.json'), JSON.stringify({ claude: [missingModel] }));
  assert.throws(() => loadProvider({ MIXR_DATA_DIR: f.root }, BASE), /模型/);
});

test('provider diagnostics respect direct and existing transport proxy selection', () => {
  const old = process.env.MIXR_UPSTREAM_PROXY;
  process.env.MIXR_UPSTREAM_PROXY = 'invalid-proxy';
  try {
    const target = { app: 'claude', model: 'known[1m]', url: new URL('http://127.0.0.1'), provider: { api_key: SECRET, direct: true } };
    const direct = requestSpec(target);
    assert.equal(JSON.parse(direct.data).model, 'known');
    assert.ok(direct.headers['anthropic-beta']);
    assert.throws(() => requestSpec({ ...target, provider: { ...target.provider, direct: false } }));
  } finally {
    if (old === undefined) delete process.env.MIXR_UPSTREAM_PROXY; else process.env.MIXR_UPSTREAM_PROXY = old;
    require('../lib/upstream-proxy').destroyAgents();
  }
});

test('provider diagnostics enforce absolute request/total budgets and SIGTERM cancellation', async t => {
  let childToStop;
  const f = await fixture(t, () => { if (childToStop) { childToStop.kill('SIGTERM'); childToStop = null; } });
  const timed = await cli(f.root, ['--requests', '1', '--timeout-ms', '50']);
  assert.equal(JSON.parse(timed.stdout).clientTimeouts, 1);
  const duration = await cli(f.root, ['--requests', '20', '--concurrency', '2', '--duration-ms', '50']);
  const report = JSON.parse(duration.stdout);
  assert.equal(report.cancelled, true);
  assert.ok(report.requests <= 2);
  assert.ok(report.elapsedMs < 1500);
  const cancelled = await cli(f.root, ['--requests', '20'], child => { childToStop = child; });
  assert.equal(cancelled.code, 143);
  assert.equal(JSON.parse(cancelled.stdout).cancelled, true);
});
