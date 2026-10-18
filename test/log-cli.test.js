'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
function run(args, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'mixctl'), 'logs', ...args], {
      env: { ...process.env, MIXUI_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
test('actual mixctl logs dispatch transmits count, history, time, cursor and filters to HTTP', async t => {
  const requests = [];
  const payload = { logs: [{ ts: '2026-09-29T00:00:00Z', slot: 'opus', status: 200 }], next_cursor: 'next-token', scope: { source: 'history' } };
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: new URL(req.url, 'http://localhost') });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const args = ['7', '--history', '--since', '2026-09-29T00:00:00Z', '--until=2026-09-29T23:59:59Z',
    '--cursor', 'opaque-token', '--app', 'claude', '--provider', 'p & q', '--model', 'm', '--session', 's',
    '--status', 'err', '--slot', 'opus', '--err_class', 'stream', '--json'];
  const result = await run(args, port);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), payload);
  const request = requests.pop();
  assert.equal(request.method, 'GET'); assert.equal(request.url.pathname, '/api/logs');
  assert.deepEqual(Object.fromEntries(request.url.searchParams), {
    limit: '7', history: '1', since: '2026-09-29T00:00:00Z', until: '2026-09-29T23:59:59Z', cursor: 'opaque-token',
    app: 'claude', provider: 'p & q', model: 'm', session: 's', status: 'err', slot: 'opus', err_class: 'stream',
  });
  const legacy = await run(['2'], port);
  assert.equal(legacy.code, 0); assert.match(legacy.stdout, /next_cursor: next-token/);
  assert.deepEqual(Object.fromEntries(requests.pop().url.searchParams), { limit: '2' });
  await run(['--cursor', 'cursor-only', '--json'], port);
  assert.equal(requests.pop().url.searchParams.get('history'), '1');
  const invalid = await run(['--until'], port);
  assert.equal(invalid.code, 1); assert.match(invalid.stderr, /Missing value/); assert.equal(requests.length, 0);
});
test('text logs distinguish explicit no-slot records from legacy unknown records', async () => {
  const { runLogs } = require('../lib/cli/logs');
  let output = '';
  const code = await runLogs([], {
    request: async () => ({ logs: [{ status: 200, slot: '' }, { status: 200 }, { status: 200, slot: 'opus' }] }),
    stdout: { write(text) { output += text; } },
    stderr: { write(text) { assert.fail(text); } },
  });
  assert.equal(code, 0);
  assert.deepEqual(output.trim().split('\n').map(line => line.split(' ')[2]), ['none', 'unknown', 'opus']);
});

test('actual mixctl logs exits nonzero for API cursor errors', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(410, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'CURSOR_EXPIRED', error: 'History cursor expired; start a new query' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await run(['--cursor', 'old'], server.address().port);
  assert.equal(result.code, 1); assert.match(result.stderr, /History cursor expired/); assert.equal(result.stdout, '');
});
