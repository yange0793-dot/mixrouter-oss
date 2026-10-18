'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { run } = require('../lib/diagnostics/provider');
const CONFIG = { mode: 'provider', provider: 'mock', confirm: true, requests: 1 };
function fakeChild(pid) {
  const child = new EventEmitter();
  Object.assign(child, { pid, exitCode: null, signalCode: null, connected: false, kills: [],
    send() {}, unref() {}, disconnect() {},
    kill(signal) { this.kills.push(signal); return true; },
  });
  return child;
}
async function bounded(action) {
  let timer;
  try {
    return await Promise.race([action(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('test cleanup guard expired')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

test('provider cleanup: fork spawn error without pid or exit cannot hang', async () => {
  const child = fakeChild(undefined);
  const forkProcess = () => { process.nextTick(() => child.emit('error', new Error('spawn ENOENT'))); return child; };
  await assert.rejects(() => bounded(() => run(CONFIG, { forkProcess })), /无法启动渠道诊断进程/);
  assert.deepEqual(child.kills, []);
});

test('provider cleanup: kill returning false or throwing settles without exit', async () => {
  for (const throws of [false, true]) {
    const child = fakeChild(12345);
    child.kill = () => { if (throws) throw new Error('EPERM'); return false; };
    const forkProcess = () => { process.nextTick(() => child.emit('message', { type: 'report', report: {} })); return child; };
    await assert.rejects(() => bounded(() => run(CONFIG, { forkProcess })), /无法停止渠道诊断进程/);
  }
});

test('provider cleanup: missing exit after accepted kill has a 500ms hard deadline', async () => {
  const child = fakeChild(12345);
  const forkProcess = () => { process.nextTick(() => child.emit('message', { type: 'report', report: {} })); return child; };
  const start = performance.now();
  await assert.rejects(() => bounded(() => run(CONFIG, { forkProcess })), /500ms 内未确认/);
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  assert.ok(performance.now() - start < 1500);
});

test('provider cleanup: exited child and normal termination retain the report', async () => {
  for (const alreadyExited of [false, true]) {
    const child = fakeChild(12345);
    if (alreadyExited) child.exitCode = 0;
    child.kill = signal => { child.kills.push(signal); process.nextTick(() => child.emit('exit', 0)); return true; };
    const forkProcess = () => { process.nextTick(() => child.emit('message', { type: 'report', report: { requests: 1 } })); return child; };
    assert.deepEqual(await bounded(() => run(CONFIG, { forkProcess })), { requests: 1 });
    assert.deepEqual(child.kills, alreadyExited ? [] : ['SIGTERM']);
  }
});
