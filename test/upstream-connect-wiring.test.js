'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

process.env.MIXR_UPSTREAM_CONNECT_TIMEOUT_MS = '1000';
const { directAgent, createProxyAgents, destroyAgents } = require('../lib/upstream-proxy');

async function fixture(t, server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, sockets };
}

function request(url, agent, options = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https:') ? https : http;
    const req = transport.get(url, { agent, ...options }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body, reused: req.reusedSocket }));
    });
    req.on('error', reject);
  });
}

test('生产直连池:TLS 黑洞在建连预算结束,不等首响应预算', async t => {
  t.after(destroyAgents);
  const { port } = await fixture(t, net.createServer(socket => socket.resume()));
  const start = Date.now();
  await assert.rejects(request(`https://127.0.0.1:${port}/`, directAgent('https:'), { timeout: 10000 }),
    error => error.code === 'ETIMEDOUT' && error.message === 'upstream connection timeout');
  assert.ok(Date.now() - start < 5000, '建连截止不能沿用 10 秒首响应预算');
});

test('生产绕过隧道路径:TLS 黑洞也有建连截止', async t => {
  const { port } = await fixture(t, net.createServer(socket => socket.resume()));
  const agents = createProxyAgents('http://127.0.0.1:9');
  t.after(() => { agents.http.destroy(); agents.https.destroy(); });
  await assert.rejects(request(`https://127.0.0.1:${port}/`, agents.https),
    error => error.code === 'ETIMEDOUT' && error.message === 'upstream connection timeout');
});

test('生产直连池:建连后迟到的首响应和连接复用不被建连截止误杀', async t => {
  t.after(destroyAgents);
  let connections = 0;
  const upstream = http.createServer((req, res) => {
    req.resume();
    setTimeout(() => { res.end('late-but-valid'); }, 1300);
  });
  upstream.on('connection', () => connections++);
  const { port } = await fixture(t, upstream);
  const url = `http://127.0.0.1:${port}/`;
  const agent = directAgent('http:');
  assert.equal((await request(url, agent)).body, 'late-but-valid');
  const second = await request(url, agent);
  assert.equal(second.body, 'late-but-valid');
  assert.equal(second.reused, true);
  assert.equal(connections, 1);
});

test('生产直连池:DNS 挂起也会截止,迟到的 lookup 不重开连接', async t => {
  t.after(destroyAgents);
  let reply;
  let calls = 0;
  const { port } = await fixture(t, http.createServer((req, res) => { calls++; res.end('unexpected'); }));
  await assert.rejects(request(`http://lookup.test:${port}/`, directAgent('http:'), {
    lookup(_host, options, callback) { reply = () => callback(null, [{ address: '127.0.0.1', family: 4 }]); },
  }), error => error.code === 'ETIMEDOUT');
  reply();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

for (const bypass of [false, true]) {
  test(`建连中取消立即销毁 socket:${bypass ? '绕过隧道' : '直连池'}`, async t => {
    t.after(destroyAgents);
    let disconnected;
    let connected;
    const disconnectedPromise = new Promise(resolve => { disconnected = resolve; });
    const connectedPromise = new Promise(resolve => { connected = resolve; });
    const upstream = net.createServer(socket => {
      socket.resume();
      socket.once('close', disconnected);
      connected();
    });
    const { port } = await fixture(t, upstream);
    const agents = bypass ? createProxyAgents('http://127.0.0.1:9') : null;
    if (agents) t.after(() => { agents.http.destroy(); agents.https.destroy(); });
    const req = https.get(`https://127.0.0.1:${port}/`, { agent: agents ? agents.https : directAgent('https:') });
    req.on('error', () => {});
    await connectedPromise;
    req.destroy();
    let timer;
    try {
      await Promise.race([
        disconnectedPromise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('取消后仍留着建连 socket')), 500); }),
      ]);
    } finally { clearTimeout(timer); }
  });
}
