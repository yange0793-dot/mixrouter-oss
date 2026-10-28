'use strict';
// 新共用路径的接线回归:真实 HTTP,只连临时端口与本地桩,不用现役配置或上游。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-refactor-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXR_SSE_KEEPALIVE_MS = '0';
// 重试次数与间隔在这里都是被数的对象:固定成小值、间隔关掉,断言才有确定含义
process.env.MIXR_MAX_ATTEMPTS = '3';
process.env.MIXR_RETRY_DELAY_MS = '0';

let mod, upstream, proxy, ui;
let reply, hits = 0;
const sockets = new Set();
const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

function request(server, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: url,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Connection: 'close' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('test request timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

before(async () => {
  fs.mkdirSync(path.join(TMP, 'logs'));
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      hits++;
      reply(req, res, JSON.parse(Buffer.concat(chunks).toString('utf8')));
    });
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base_url = `http://127.0.0.1:${upstream.address().port}`;
  // 目标由渠道登记的模型名精确决定(每个模型只在一个渠道登记),不再写通用 match 规则。
  const provider = (id, wire_api, models) => ({ id, name: id, base_url, wire_api, api_key: 'sk-fixture',
    enabled: true, ...(models ? { models } : {}), ...(wire_api === 'responses' || wire_api === 'chat' ? { model: models[0] } : {}) });
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({
    claude: [provider('native', 'anthropic', ['native-model']), provider('converted', 'chat', ['converted-model'])],
    codex: [provider('response', 'responses', ['response-model']), provider('chat', 'chat', ['chat-model'])],
  }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({ rules: [], default: {} }));
  mod = require('../mixrouter');
  proxy = await mod.listen(0, mod.proxyHandler);
  ui = await mod.listen(0, mod.apiHandler);
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([proxy, ui, upstream].filter(Boolean).map(server => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  })));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('all proxy endpoints reject primitive JSON with protocol-shaped 400 and no upstream call', async () => {
  const before = hits;
  for (const endpoint of ['/v1/messages', '/v1/messages/count_tokens', '/v1/responses', '/v1/chat/completions']) {
    for (const body of ['null', '[]', '1', 'true', '"text"']) {
      const response = await request(proxy, 'POST', endpoint, body);
      const error = JSON.parse(response.body);
      assert.equal(response.status, 400, `${endpoint}: ${body}`);
      assert.equal(error.error.message, '请求体必须是 JSON 对象');
      assert.equal(error.error.type, endpoint.includes('messages') ? 'invalid_request_error' : 'invalid_request');
    }
  }
  assert.equal(hits, before);
  assert.equal((await request(proxy, 'GET', '/healthz')).status, 200);
});

test('local count_tokens still uses uploaded UTF-8 bytes after releasing request buffers', async () => {
  const body = { model: 'converted-model', messages: [{ role: 'user', content: '中文上下文'.repeat(200) }] };
  const before = hits;
  const response = await request(proxy, 'POST', '/v1/messages/count_tokens', body);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).input_tokens, Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4));
  assert.equal(hits, before, 'converted count_tokens is a local estimate, not an upstream request');
});

test('converted Chat HTTP failures retry within the shared budget and log actual calls', async () => {
  const body = { model: 'converted-model', messages: [{ role: 'user', content: 'retry' }] };
  for (const status of [402, 429, 500]) {
    let attempts = 0;
    reply = (_req, res) => {
      attempts++;
      if (attempts === 1) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `fixture ${status}` } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'retry-success', choices: [{ finish_reason: 'stop',
        message: { role: 'assistant', content: 'recovered' } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    };
    const response = await request(proxy, 'POST', '/v1/messages', body);
    assert.equal(response.status, 200, `HTTP ${status}: ${response.body}`);
    assert.equal(JSON.parse(response.body).content[0].text, 'recovered');
    assert.equal(attempts, 2);
    const logs = JSON.parse((await request(ui, 'GET', '/api/logs?model=converted-model')).body).logs;
    assert.equal(logs[0].status, 200);
    assert.equal(logs[0].attempts, attempts);
    assert.equal(logs[0].failover, false, 'same-provider retries are not pool failover');
  }

  let attempts = 0;
  reply = (_req, res) => {
    attempts++;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'persistent fixture failure' } }));
  };
  const response = await request(proxy, 'POST', '/v1/messages', body);
  assert.equal(response.status, 500);
  const logs = JSON.parse((await request(ui, 'GET', '/api/logs?model=converted-model')).body).logs;
  const health = JSON.parse((await request(ui, 'GET', '/api/health')).body);
  // 恒失败时真实调用数正好是视图声明的上界:候选表(按 MAX_ATTEMPTS 循环填满)走完,
  // 再叠加整条请求共用的 CONV_RETRIES 次换 key/换 cache 代际重试 —— 两者是分开的配额,
  // 所以是 MAX_ATTEMPTS + CONV_RETRIES,不是相乘,也不是取其中较小的一个。
  assert.equal(attempts, health.settings.max_upstream_calls,
    `恒失败应打满声明的上界 ${health.settings.max_upstream_calls} 次,实际 ${attempts}`);
  assert.equal(health.settings.max_upstream_calls,
    health.settings.max_attempts + health.settings.conversion_retries);
  assert.equal(logs[0].attempts, attempts);
  assert.match(logs[0].err, /persistent fixture failure/);
});

for (const wire of ['anthropic', 'responses', 'chat']) {
  test(`${wire}: long SSE is byte-identical and final usage reaches the live log API`, async () => {
    const usage = wire === 'anthropic'
      ? { input_tokens: 12345, output_tokens: 6789, cache_read_input_tokens: 456 }
      : wire === 'responses'
      ? { input_tokens: 12345, output_tokens: 6789, input_tokens_details: { cached_tokens: 456 } }
      : { prompt_tokens: 12345, completion_tokens: 6789, prompt_tokens_details: { cached_tokens: 456 } };
    const prefix = wire === 'anthropic'
      ? frame('message_start', { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } })
      : wire === 'responses'
      ? frame('response.created', { type: 'response.created', response: { usage: { input_tokens: 0, output_tokens: 0 } } })
      : `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } })}\n\n`;
    const suffix = wire === 'anthropic'
      ? frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage }) + frame('message_stop', { type: 'message_stop' })
      : wire === 'responses'
      ? frame('response.completed', { type: 'response.completed', response: { status: 'completed', usage } })
      : `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`;
    const text = prefix + (': ' + 'x'.repeat(1020) + ' 中文\n\n').repeat(1300) + suffix;
    const expected = Buffer.from(text);
    assert.ok(expected.length > 1024 * 1024);
    reply = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(expected); };
    const model = wire === 'anthropic' ? 'native-model' : wire === 'responses' ? 'response-model' : 'chat-model';
    const endpoint = wire === 'anthropic' ? '/v1/messages' : wire === 'responses' ? '/v1/responses' : '/v1/chat/completions';
    const before = hits;
    const response = await request(proxy, 'POST', endpoint, { model, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, expected, 'sampling must not trim or rewrite client-visible bytes');
    assert.equal(hits, before + 1);
    const logs = JSON.parse((await request(ui, 'GET', `/api/logs?model=${model}`)).body).logs;
    assert.equal(logs[0].wire, wire);
    assert.equal(logs[0].status, 200);
    assert.deepEqual({ in: logs[0].in, out: logs[0].out, cache_read: logs[0].cache_read },
      { in: 12345, out: 6789, cache_read: 456 });
  });
}
