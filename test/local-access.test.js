'use strict';
// 真实 HTTP 入口 + 假转发依赖:只用临时回环端口,不读写客户端配置、不联网上游。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { isLoopbackHost, isCrossSiteRequest, isJsonRequest } = require('../lib/http/local-access');
const { createConsoleHandler } = require('../lib/http/console');
const { createProxyHandler } = require('../lib/http/proxy');
const { ENDPOINTS, classifyProxyRequest } = require('../lib/routing/endpoints');
const { protoError } = require('../lib/http/proto-error');

function request(port, route, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, agent: false,
      headers: { 'Content-Length': Buffer.byteLength(body), ...headers } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, text, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timeout')));
    req.end(body);
  });
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}

test('Host 白名单只接受字面量回环,拒绝域名、数字别写与畸形 authority', () => {
  for (const host of ['127.0.0.1', '127.0.0.1:8787', '127.0.0.1:65535', '[::1]', '[::1]:8788'])
    assert.equal(isLoopbackHost(host), true, host);
  for (const host of [undefined, null, [], '', 'localhost:8788', 'evil.example:8788', '127.0.0.1.evil.example',
    '127.1', '2130706433', '0x7f000001', '127.0.0.2', '127.0.0.1:0', '127.0.0.1:65536',
    '127.0.0.1:', '127.0.0.1/path', '127.0.0.1@evil.example', ' 127.0.0.1', '[::ffff:127.0.0.1]'])
    assert.equal(isLoopbackHost(host), false, String(host));
});

test('来源判据保持本机 CLI/同源可用,类型判据允许 JSON charset', () => {
  const req = headers => ({ headers: { host: '127.0.0.1:8787', ...headers } });
  assert.equal(isCrossSiteRequest(req({})), false);
  assert.equal(isCrossSiteRequest(req({ origin: 'http://127.0.0.1:8787', 'sec-fetch-site': 'same-origin' })), false);
  for (const headers of [{ origin: 'null' }, { origin: 'https://127.0.0.1:8787' }, { origin: 'http://127.0.0.1:8788' },
    { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }])
    assert.equal(isCrossSiteRequest(req(headers)), true);
  for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON'])
    assert.equal(isJsonRequest(req({ 'content-type': type })), true);
  for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonp'])
    assert.equal(isJsonRequest(req({ 'content-type': type })), false);
});

test('控制台所有方法先检查 Host,同源攻击域名不能绕过,正常探活可用', async t => {
  const handler = createConsoleHandler({ HOST: '127.0.0.1', UI_PORT: 0 });
  const port = await listen(t, handler);
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const result = await request(port, method === 'GET' || method === 'HEAD' ? '/api/state' : '/api/providers', {
      method, headers: { Host: `untrusted.example:${port}`, Origin: `http://untrusted.example:${port}`, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(result.status, 403, method);
  }
  assert.equal((await request(port, '/healthz')).status, 200);
  assert.equal((await request(port, '/api/providers', { method: 'POST',
    headers: { Origin: 'https://untrusted.example', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('代理入口在读体/选渠道之前拒绝非法 Host、跨站和非 JSON,CLI JSON 正常转发', async t => {
  let reads = 0, forwards = 0;
  const handler = createProxyHandler({
    VERSION: 'test', ENDPOINTS, classifyProxyRequest, protoError, modelList: () => ({ data: [] }),
    sessionKeyOf: () => 'fixture',
    httpBody: {
      readProxyBody(req, _res, _options, done) {
        reads++;
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => done(raw, Buffer.byteLength(raw)));
      },
      parseJsonBody: raw => JSON.parse(raw),
    },
    prepareRequest: () => ({ plan: { resolved: {}, ident: { key: 'fixture' }, modelIn: 'fixture-model', members: [] } }),
    createRequestContext: ctx => ctx,
    runAttempts(_plan, ctx) { forwards++; ctx.res.writeHead(200, { 'Content-Type': 'application/json' }); ctx.res.end('{"ok":true}'); },
  });
  const port = await listen(t, handler);
  const body = '{"model":"fixture-model"}';
  for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) {
    assert.equal((await request(port, '/v1/messages', { method, body,
      headers: { Host: `untrusted.example:${port}`, Origin: `http://untrusted.example:${port}`, 'Sec-Fetch-Site': 'same-origin' } })).status, 403);
  }
  for (const route of ['/v1/messages', '/v1/responses', '/v1/chat/completions', '/v1/messages/count_tokens', '/v1/responses/compact']) {
    const cross = await request(port, route, { method: 'POST', body,
      headers: { 'Content-Type': 'text/plain', Origin: 'https://untrusted.example', 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(cross.status, 403, route);
    const plain = await request(port, route, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } });
    assert.equal(plain.status, 415, route);
    const missing = await request(port, route, { method: 'POST', body });
    assert.equal(missing.status, 415, route);
  }
  assert.equal((await request(port, '/v1/messages', { method: 'GET', body,
    headers: { 'Content-Type': 'application/json' } })).status, 404);
  assert.deepEqual([reads, forwards], [0, 0], '被拒绝的请求不读体、不选渠道、不转发');
  for (const route of ['/v1/messages', '/v1/responses']) {
    assert.equal((await request(port, route, { method: 'POST', body,
      headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status, 200);
  }
  assert.deepEqual([reads, forwards], [2, 2]);
  assert.equal((await request(port, '/healthz')).status, 200);
  assert.equal((await request(port, '/v1/models')).status, 200);
  assert.equal((await request(port, '/v1/messages', { method: 'HEAD' })).status, 200);
});
