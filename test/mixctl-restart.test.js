'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

test('mixctl restart waits for a slow old process to exit before starting its replacement', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-restart-'));
  fs.copyFileSync(path.join(__dirname, '../mixctl'), path.join(root, 'mixctl'));
  fs.cpSync(path.join(__dirname, '../lib'), path.join(root, 'lib'), { recursive: true });
  const eventsFile = path.join(root, 'events.jsonl');
  fs.writeFileSync(path.join(root, 'mixrouter.js'), `
    const fs = require('node:fs'), http = require('node:http');
    const record = type => fs.appendFileSync(${JSON.stringify(eventsFile)},
      JSON.stringify({type, pid:process.pid, at:Date.now()}) + '\\n');
    const server = http.createServer((req, res) => res.end('{"ok":true}'));
    server.listen(Number(process.env.MIXUI_PORT), '127.0.0.1', () => record('started'));
    process.once('SIGTERM', () => setTimeout(() => server.close(() => {
      record('stopped'); process.exit(0);
    }), 1100));
  `);
  const portServer = net.createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const env = { ...process.env, HOME: root, USERPROFILE: root, MIXUI_PORT: String(port), MIXR_DATA_DIR: root };
  const run = command => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'mixctl'), command], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('mixctl timeout')); }, 12000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  t.after(async () => {
    await run('stop');
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal((await run('start')).code, 0);
  const result = await run('restart');
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /已在运行/);
  const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event => event.type), ['started', 'stopped', 'started']);
  assert.notEqual(events[0].pid, events[2].pid);
  assert.ok(events[2].at >= events[1].at);
});
