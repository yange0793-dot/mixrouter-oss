'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const nativeFamilyDefault = net.getDefaultAutoSelectFamily?.();
const nativeAttemptDefault = net.getDefaultAutoSelectFamilyAttemptTimeout?.();
const { DIRECT_CONNECT_OPTIONS, DEFAULT_CONNECT_TIMEOUT_MS, guardConnection } = require('../lib/upstream-connect');
const modulePath = require.resolve('../lib/upstream-connect');
const source = fs.readFileSync(modulePath, 'utf8');

// A module-local clock avoids real-time races and does not patch global timers or sockets.
function fixture(env = {}) {
  let now = 0;
  const timers = new Set();
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, process: { env },
    setTimeout(callback, ms) {
      const timer = { callback, at: now + ms, referenced: true,
        unref() { this.referenced = false; } };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); },
  }, { filename: modulePath });
  return {
    ...module.exports, timers,
    tick(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        timers.delete(next);
        next.callback();
      }
      now = end;
    },
  };
}

class FakeSocket extends EventEmitter {
  constructor(options = {}) {
    super();
    this.connecting = true;
    this.secureConnecting = true;
    this.destroyed = false;
    this.destroyErrors = [];
    Object.assign(this, options);
  }
  setTimeout() { assert.fail('connection guard must not change the socket/request timeout'); }
  destroy(error) {
    this.destroyErrors.push(error);
    this.destroyed = true;
    if (error) this.emit('error', error);
    this.emit('close');
    return this;
  }
}
const events = ['connect', 'secureConnect', 'error', 'close'];
function keepExternalListeners(socket) {
  const listener = () => {};
  for (const event of events) socket.on(event, listener);
  return () => {
    for (const event of events)
      assert.deepEqual(socket.listeners(event), [listener], `${event}: guard must remove only its own listeners`);
  };
}

test('direct address selection options are frozen and do not alter process-wide net defaults', () => {
  assert.equal(DEFAULT_CONNECT_TIMEOUT_MS, 15000);
  assert.deepEqual(DIRECT_CONNECT_OPTIONS, { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 1000 });
  assert.ok(Object.isFrozen(DIRECT_CONNECT_OPTIONS));
  assert.equal(net.getDefaultAutoSelectFamily?.(), nativeFamilyDefault);
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout?.(), nativeAttemptDefault);
});

test('connect timeout env accepts positive safe integers up to 600000, otherwise falls back without clamping', () => {
  const cases = [
    [undefined, 15000], ['', 15000], ['  \t ', 15000], ['invalid', 15000],
    ['0', 15000], ['-1', 15000], ['1.5', 15000], ['Infinity', 15000], ['NaN', 15000],
    ['600001', 15000], ['9007199254740992', 15000], ['999999999999999999999', 15000],
    ['1', 1], [' 1000 ', 1000], ['15000', 15000], ['600000', 600000],
  ];
  for (const [raw, expected] of cases) {
    const env = raw === undefined ? {} : { MIXR_UPSTREAM_CONNECT_TIMEOUT_MS: raw };
    const loaded = fixture(env);
    assert.equal(loaded.DEFAULT_CONNECT_TIMEOUT_MS, expected, `env=${JSON.stringify(raw)}`);
    const socket = new FakeSocket();
    keepExternalListeners(socket);
    loaded.guardConnection(socket, false);
    loaded.tick(expected - 1);
    assert.equal(socket.destroyErrors.length, 0, `env=${JSON.stringify(raw)}: not before deadline`);
    loaded.tick(1);
    assert.equal(socket.destroyErrors.length, 1, `env=${JSON.stringify(raw)}: default argument uses loaded value`);
    env.MIXR_UPSTREAM_CONNECT_TIMEOUT_MS = '300000';
    assert.equal(loaded.DEFAULT_CONNECT_TIMEOUT_MS, expected, 'env is read once at module load');
  }
});

test('slow but good TLS connection keeps its full budget after TCP connect and releases at secureConnect', () => {
  const clock = fixture();
  const socket = new FakeSocket();
  const assertClean = keepExternalListeners(socket);
  const methods = { destroy: socket.destroy, setTimeout: socket.setTimeout };
  assert.equal(clock.guardConnection(socket, true, 1000), socket);
  assert.equal([...clock.timers][0].referenced, false, 'timer is unrefed');
  clock.tick(390);
  socket.connecting = false;
  socket.emit('connect');
  assert.equal(clock.timers.size, 1, 'TCP success does not finish TLS establishment');
  clock.tick(510);
  assert.equal(socket.destroyErrors.length, 0, 'good TLS is not killed while still within its budget');
  socket.secureConnecting = false;
  socket.emit('secureConnect');
  assert.equal(clock.timers.size, 0);
  assertClean();
  clock.tick(900000);
  assert.equal(socket.destroyErrors.length, 0, 'inference/stream silence after ready is unlimited by this guard');
  assert.equal(socket.destroy, methods.destroy);
  assert.equal(socket.setTimeout, methods.setTimeout);
});

test('HTTP connect clears the guard and leaves long response silence alone', () => {
  const clock = fixture();
  const socket = new FakeSocket();
  const assertClean = keepExternalListeners(socket);
  clock.guardConnection(socket, false, 1000);
  clock.tick(390);
  socket.connecting = false;
  socket.emit('connect');
  assert.equal(clock.timers.size, 0);
  assertClean();
  clock.tick(900000);
  assert.equal(socket.destroyErrors.length, 0);
});

for (const event of ['error', 'close']) {
  test(`${event} cancels establishment timer and removes only guard listeners`, () => {
    const clock = fixture();
    const socket = new FakeSocket();
    const assertClean = keepExternalListeners(socket);
    clock.guardConnection(socket, true, 1000);
    socket.emit(event, event === 'error' ? new Error('original failure') : undefined);
    assert.equal(clock.timers.size, 0);
    assertClean();
    clock.tick(2000);
    assert.equal(socket.destroyErrors.length, 0, 'do not replace an existing failure with a connect timeout');
  });
}

test('TLS connection times out even when TCP is ready; destroys only once with stable ETIMEDOUT', () => {
  const clock = fixture();
  // _secureEstablished precedes certificate verification; it is not secureConnect readiness.
  const socket = new FakeSocket({ connecting: false, _secureEstablished: true });
  const assertClean = keepExternalListeners(socket);
  clock.guardConnection(socket, true, 1000);
  clock.guardConnection(socket, true, 5000);
  assert.equal(clock.timers.size, 1, 'guard cannot be rearmed or extended on the same socket');
  clock.tick(999);
  assert.equal(socket.destroyErrors.length, 0);
  clock.tick(1);
  assert.equal(socket.destroyErrors.length, 1);
  assert.equal(socket.destroyErrors[0].code, 'ETIMEDOUT');
  assert.equal(socket.destroyErrors[0].message, 'upstream connection timeout');
  assertClean();
  clock.guardConnection(socket, true, 1000);
  clock.tick(10000);
  assert.equal(socket.destroyErrors.length, 1);
});

test('plain HTTP connection times out before TCP readiness', () => {
  const clock = fixture();
  const socket = new FakeSocket();
  const assertClean = keepExternalListeners(socket);
  clock.guardConnection(socket, false, 1000);
  clock.tick(1000);
  assert.equal(socket.destroyErrors.length, 1);
  assert.equal(socket.destroyErrors[0].code, 'ETIMEDOUT');
  assertClean();
});

test('already-ready HTTP/TLS and already-destroyed sockets do not acquire timers/listeners', () => {
  for (const [secure, options] of [
    [false, { connecting: false }],
    [true, { connecting: false, secureConnecting: false }],
    [true, { destroyed: true }],
    [false, { destroyed: true }],
  ]) {
    const clock = fixture();
    const socket = new FakeSocket(options);
    const assertClean = keepExternalListeners(socket);
    assert.equal(clock.guardConnection(socket, secure, 1000), socket);
    assert.equal(clock.timers.size, 0);
    assertClean();
    clock.tick(900000);
    assert.equal(socket.destroyErrors.length, 0);
  }
});

test('calling guard again after readiness never arms a new initial-connect budget', () => {
  const clock = fixture();
  const socket = new FakeSocket();
  const assertClean = keepExternalListeners(socket);
  clock.guardConnection(socket, true, 1000);
  socket.emit('secureConnect');
  clock.guardConnection(socket, true, 1000);
  assert.equal(clock.timers.size, 0);
  clock.tick(900000);
  assert.equal(socket.destroyErrors.length, 0);
  assertClean();
});

test('real establishment timer does not keep an otherwise idle process alive', () => {
  const code = `const { EventEmitter } = require('node:events');
    const { guardConnection } = require(${JSON.stringify(modulePath)});
    const socket = new EventEmitter(); socket.connecting = true;
    guardConnection(socket, false, 600000);`;
  const child = spawnSync(process.execPath, ['-e', code], {
    env: process.env, encoding: 'utf8', timeout: 3000,
  });
  assert.equal(child.error, undefined, 'unrefed timer must allow immediate process exit');
  assert.equal(child.status, 0, child.stderr);
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
});
function trackServer(t, server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    });
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections?.();
  }));
  return server;
}
function guardedAgent(t, secure, budget, options = {}) {
  const agent = new (secure ? https.Agent : http.Agent)({ ...DIRECT_CONNECT_OPTIONS, ...options });
  const nativeCreateConnection = agent.createConnection;
  agent.createConnection = function (...args) {
    return guardConnection(nativeCreateConnection.apply(this, args), secure, budget);
  };
  t.after(() => agent.destroy());
  return agent;
}
function fetch(t, url, agent, onSocket) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https:') ? https : http;
    const req = transport.get(url, { agent }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.once('aborted', () => reject(new Error('response aborted')));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, text }));
    });
    if (onSocket) req.once('socket', onSocket);
    req.once('error', reject);
    t.after(() => req.destroy());
  });
}

test('real https.Agent to TCP-only black hole returns TLS establishment ETIMEDOUT', { timeout: 5000 }, async t => {
  const server = trackServer(t, net.createServer(socket => socket.resume()));
  await listen(server);
  let tcpConnected = false;
  let secureConnected = false;
  const started = Date.now();
  const result = fetch(t, `https://127.0.0.1:${server.address().port}/`, guardedAgent(t, true, 150), socket => {
    socket.once('connect', () => { tcpConnected = true; });
    socket.once('secureConnect', () => { secureConnected = true; });
  });
  await assert.rejects(result, error => {
    assert.equal(error.code, 'ETIMEDOUT');
    assert.equal(error.message, 'upstream connection timeout');
    return true;
  });
  assert.equal(tcpConnected, true, 'TCP was accepted; only TLS remained stuck');
  assert.equal(secureConnected, false);
  assert.ok(Date.now() - started < 2500, 'failure comes from connect budget, not request/model first-byte budget');
});

test('real HTTP delayed headers and delayed stream exceed connect budget but arrive intact', { timeout: 5000 }, async t => {
  const timers = new Set();
  const later = fn => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, 250);
    timers.add(timer);
  };
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const server = trackServer(t, http.createServer((req, res) => {
    req.resume();
    later(() => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
      later(() => res.end('data: late\n\n'));
    });
  }));
  await listen(server);
  const started = Date.now();
  const result = await fetch(t, `http://127.0.0.1:${server.address().port}/`, guardedAgent(t, false, 100));
  assert.equal(result.status, 200);
  assert.equal(result.text, 'data: first\n\ndata: late\n\n');
  assert.ok(Date.now() - started >= 400, 'response genuinely outlasts the initial-connect budget');
});

test('real net.Socket already connected when guard is attached is not killed', { timeout: 5000 }, async t => {
  const server = trackServer(t, net.createServer(socket => socket.resume()));
  await listen(server);
  const socket = net.connect({ host: '127.0.0.1', port: server.address().port });
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  assert.equal(socket.connecting, false);
  assert.equal(guardConnection(socket, false, 40), socket);
  await wait(120);
  assert.equal(socket.destroyed, false);
});

test('real TLS already secure when guard is attached survives silence with certificate verification intact', { timeout: 10000 }, async t => {
  if (spawnSync('openssl', ['version']).status !== 0) return t.skip('openssl unavailable');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-connect-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(cfg, ['[req]', 'distinguished_name = dn', 'x509_extensions = v3', 'prompt = no',
    '[dn]', 'CN = mixr-connect-test', '[v3]', 'subjectAltName = IP:127.0.0.1,DNS:localhost',
    'basicConstraints = CA:TRUE', ''].join('\n'));
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    '-days', '2', '-config', cfg], { encoding: 'utf8', timeout: 5000 });
  assert.equal(gen.status, 0, gen.stderr);
  const ca = fs.readFileSync(path.join(dir, 'cert.pem'));
  let responseTimer;
  t.after(() => clearTimeout(responseTimer));
  const server = trackServer(t, https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: ca },
    (req, res) => {
      req.resume();
      res.writeHead(200);
      res.write('verified-');
      responseTimer = setTimeout(() => res.end('late'), 120);
    }));
  await listen(server);
  const agent = new https.Agent({ ...DIRECT_CONNECT_OPTIONS, ca });
  t.after(() => agent.destroy());
  let verified = false;
  const url = `https://127.0.0.1:${server.address().port}/`;
  const result = await fetch(t, url, agent, socket => {
    socket.once('secureConnect', () => {
      assert.equal(socket.secureConnecting, false);
      assert.equal(socket.authorized, true);
      verified = true;
      assert.equal(guardConnection(socket, true, 40), socket);
    });
  });
  assert.equal(verified, true);
  assert.equal(result.text, 'verified-late');
  await assert.rejects(fetch(t, url, guardedAgent(t, true, 1000)), /self.signed|unable to verify|CERT/i,
    'guard must not bypass native certificate verification');
});
