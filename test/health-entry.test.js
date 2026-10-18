'use strict';
// 真实入口锁住健康许可、终态与计数;仅使用本地桩和测试入口提供的隔离环境。
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHealth } = require('../lib/upstream-health');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-terminal-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_CONV_RETRIES = '0';
process.env.MIXR_SSE_KEEPALIVE_MS = '0';
const mod = require('../mixrouter');
const originalHealth = { ...mod.health };
const frame = (type, data = { type }) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
let upstream, proxy, ui, reply, hits, now, health;

function request(server, endpoint, body, session = 'health-entry') {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: endpoint,
      method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data), 'x-claude-code-session-id': session, 'session-id': session } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('test request timeout')));
    req.end(data);
  });
}
const ask = (session, extra = {}, endpoint = '/v1/messages') => request(proxy, endpoint, {
  model: 'test-model', stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...extra,
}, session);
const logs = async () => JSON.parse((await request(ui, '/api/logs')).text).logs;

function configure(wire = 'anthropic', app = 'claude') {
  const provider = { id: 'p', name: 'p', enabled: true, api_key: 'sk-fixture', wire_api: wire,
    base_url: `http://127.0.0.1:${upstream.address().port}` };
  mod._state.store = { claude: app === 'claude' ? [provider] : [], codex: app === 'codex' ? [provider] : [] };
  mod._state.routes = { rules: [], default: mod.normalizeRule({ pool: ['p'], strategy: 'priority' }) };
  return provider;
}

before(async () => {
  upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { hits++; reply(req, res); });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  proxy = await mod.listen(0, mod.proxyHandler);
  ui = await mod.listen(0, mod.apiHandler);
});
beforeEach(() => {
  hits = 0; now = 0;
  health = createHealth({ cooldownMs: 1000, failureThreshold: 2, recoveryThreshold: 1, now: () => now });
  Object.assign(mod.health, health);
  mod._state.sessions.clear();
  mod._state.cooldowns = {};
  mod._state.resetPools();
  configure();
});
after(async () => {
  Object.assign(mod.health, originalHealth);
  await Promise.all([upstream, proxy, ui].map(server => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

function openCircuit() {
  health.acquire('p')('failure', 'fixture', 500);
  health.acquire('p')('failure', 'fixture', 500);
  assert.equal(health.view('p').state, 'open');
}

test('全池开路和 pinned 请求均零网络调用、零 attempts', async () => {
  openCircuit();
  reply = () => assert.fail('开路渠道不得收到请求');
  for (const session of ['closed-pool', 'pinned-pool']) {
    if (session === 'pinned-pool') mod._state.bindSession(`cc:${session}`, 'p', { pinned: true });
    const result = await ask(session);
    assert.equal(result.status, 502);
    assert.equal(hits, 0);
    const log = (await logs())[0];
    assert.equal(log.attempts, 0);
    assert.equal(log.err_class, 'circuit_open');
  }
});

test('200 头不关闭半开;并发探测被硬拦,合法终态才恢复', async () => {
  openCircuit(); now = 1001;
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(frame('message_start'));
    finish = () => res.end(frame('message_stop'));
    started();
  };
  const first = ask('half-open-first');
  await ready;
  assert.equal(health.view('p').state, 'half-open');
  assert.equal(health.view('p').probes, 1);
  const second = await ask('half-open-second');
  assert.equal(second.status, 502);
  assert.equal(hits, 1);
  assert.equal((await logs())[0].attempts, 0);
  finish();
  assert.equal((await first).status, 200);
  assert.equal(health.view('p').state, 'closed');
  assert.equal(health.view('p').lastOutcome, 'success');
  assert.equal(health.view('p').probes, 0);
});

test('200 后缺终态及正文引用终态名均不能清失败', async () => {
  health.acquire('p')('failure', 'fixture', 500);
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(frame('content_block_delta', { type: 'content_block_delta', delta: {
      type: 'text_delta', text: '示例含 message_stop 和 response.completed，仍不是终态',
    } }));
  };
  const beforeLogs = (await logs()).length;
  const result = await ask('no-terminal');
  assert.equal(result.status, 200, '已提交的响应不改写 HTTP 状态');
  assert.equal(health.view('p').state, 'open');
  assert.equal(health.view('p').lastOutcome, 'failure');
  const log = (await logs())[0];
  assert.equal(log.err_class, 'stream_aborted');
  assert.equal(log.attempts, hits);
  assert.equal((await logs()).length, beforeLogs + 1);
});

test('本地 count_tokens 在开路时仍可估算,零调用且健康不变', async () => {
  configure('responses'); openCircuit();
  const before = health.view('p');
  const result = await ask('local-count', { stream: false }, '/v1/messages/count_tokens');
  assert.equal(result.status, 200);
  assert.ok(JSON.parse(result.text).input_tokens > 0);
  assert.equal(hits, 0);
  assert.equal((await logs())[0].attempts, 0);
  assert.deepEqual(health.view('p'), before);
});

test('坏 Key 发送前拒绝不计 attempts', async () => {
  configure().api_key = 'bad\nkey';
  const result = await ask('bad-key');
  assert.equal(result.status, 502);
  assert.equal(hits, 0);
  const log = (await logs())[0];
  assert.equal(log.attempts, 0);
  assert.equal(log.err_class, 'bad_credential');
});

test('Responses 直通的 failed 终态是失败,不是健康成功', async () => {
  configure('responses', 'codex');
  health.acquire('p')('failure', 'fixture', 500);
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(frame('response.failed', { type: 'response.failed', response: {
      status: 'failed', error: { message: 'fixture upstream failure' },
    } }));
  };
  await ask('failed-terminal', { input: 'hi' }, '/v1/responses');
  assert.equal(health.view('p').lastOutcome, 'failure');
  assert.equal(health.view('p').state, 'open');
});

test('客户端取消保持失败计数,不把在途 200 当成成功', async () => {
  health.acquire('p')('failure', 'fixture', 500);
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(frame('message_start'));
  };
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/v1/messages',
      headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': 'cancel-terminal' } }, res => {
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    req.end(JSON.stringify({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
  });
  for (let i = 0; i < 50 && health.view('p').lastOutcome !== 'cancelled'; i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(health.view('p').lastOutcome, 'cancelled');
  assert.equal(health.view('p').failures, 1);
  assert.equal((await logs())[0].err_class, 'cancelled');
});

test('合法 token 上限终态可恢复健康', async () => {
  configure('responses', 'codex');
  health.acquire('p')('failure', 'fixture', 500);
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(frame('response.incomplete', { type: 'response.incomplete', response: {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    } }));
  };
  await ask('token-limit', { input: 'hi' }, '/v1/responses');
  assert.equal(health.view('p').lastOutcome, 'success');
  assert.equal(health.view('p').failures, 0);
});

test('Codex→Chat 的 200 错误 JSON 不能清失败', async () => {
  configure('chat', 'codex');
  health.acquire('p')('failure', 'fixture', 500);
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'fixture error' } }));
  };
  const result = await ask('chat-error-json', { stream: false, input: 'hi' }, '/v1/responses');
  assert.equal(result.status, 502);
  assert.equal(health.view('p').lastOutcome, 'failure');
  assert.equal(health.view('p').state, 'open');
});

test('Codex→Chat 断流由桥接终态结算失败', async () => {
  configure('chat', 'codex');
  health.acquire('p')('failure', 'fixture', 500);
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
  };
  const result = await ask('chat-incomplete', { stream: false, input: 'hi' }, '/v1/responses');
  assert.equal(result.status, 502);
  assert.equal(JSON.parse(result.text).status, 'failed');
  assert.equal(health.view('p').state, 'open');
  assert.equal(health.view('p').lastOutcome, 'failure');
  assert.equal((await logs())[0].status, 502);
});
