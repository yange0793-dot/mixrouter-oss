'use strict';
// 真实入口锁住终态判定与计数;仅使用本地桩和测试入口提供的隔离环境。
//
// 熔断器与渠道冷却都已删除:渠道可用性恒为 true,失败不会建立任何禁用时间。
// 所以这里不再有"开路时零网络调用/半开探测名额"这类断言,改为钉住终态本身 ——
// 一条响应到底算成功、失败还是取消,决定日志里的 err_class 是什么,以及旧冷却表是否被写入。
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-terminal-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_CONV_RETRIES = '0';
// 这些用例量的是"单发请求的终态怎么判",不是重试策略;默认 10 次会把每条都放大成十发
process.env.MIXR_MAX_ATTEMPTS = '1';
process.env.MIXR_RETRY_DELAY_MS = '0';
process.env.MIXR_SSE_KEEPALIVE_MS = '0';
const mod = require('../mixrouter');
const frame = (type, data = { type }) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
let upstream, proxy, ui, reply, hits;

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
const logFor = async () => (await logs())[0];

function configure(wire = 'anthropic', app = 'claude') {
  const provider = { id: 'p', name: 'p', enabled: true, api_key: 'sk-fixture', wire_api: wire,
    models: ['test-model'], model: 'test-model', base_url: `http://127.0.0.1:${upstream.address().port}` };
  mod._state.store = { claude: app === 'claude' ? [provider] : [], codex: app === 'codex' ? [provider] : [] };
  mod._state.routes = { rules: [], default: {} };
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
  hits = 0;
  mod._state.sessions.clear();
  mod._state.cooldowns = {};
  mod._state.resetPools();
  configure();
});
after(async () => {
  await Promise.all([upstream, proxy, ui].map(server => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

test('本地 count_tokens 零上游调用,也不动冷却表', async () => {
  configure('responses');
  const result = await ask('local-count', { stream: false }, '/v1/messages/count_tokens');
  assert.equal(result.status, 200);
  assert.ok(JSON.parse(result.text).input_tokens > 0);
  assert.equal(hits, 0, '纯本地估算一个字节都不发上游');
  const log = await logFor();
  assert.equal(log.attempts, 0, '本地估算不消耗"真实上游调用"预算');
  assert.deepEqual(mod._state.cooldowns, {}, '本地路径不该把渠道打进冷却');
});

test('坏 Key 发送前拒绝:不计 attempts、不进冷却', async () => {
  configure().api_key = 'bad\nkey';
  const result = await ask('bad-key');
  assert.equal(result.status, 502);
  assert.equal(hits, 0);
  const log = await logFor();
  assert.equal(log.attempts, 0);
  assert.equal(log.err_class, 'bad_credential');
  // 这是数据里的脏凭据,不是渠道坏了:进冷却会让用户改好 Key 之后还要干等一分钟
  assert.deepEqual(mod._state.cooldowns, {});
});

test('200 后缺终态:记 stream_aborted,attempts 与真实调用一致', async () => {
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(frame('content_block_delta', { type: 'content_block_delta', delta: {
      type: 'text_delta', text: '示例含 message_stop 和 response.completed，仍不是终态',
    } }));
  };
  const beforeLogs = (await logs()).length;
  const result = await ask('no-terminal');
  assert.equal(result.status, 200, '已提交的响应不改写 HTTP 状态');
  const log = await logFor();
  // 正文里出现的终态名不能被当成真终态:检测看的是事件类型,不是文本内容
  assert.equal(log.err_class, 'stream_aborted');
  assert.equal(log.attempts, hits, 'attempts 记真实上游调用数');
  assert.equal((await logs()).length, beforeLogs + 1);
});

test('上游 5xx:原样透传状态码,不建立冷却记录', async () => {
  reply = (_req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"fixture down"}}');
  };
  const result = await ask('upstream-5xx');
  assert.equal(result.status, 503, '最后一次尝试的上游状态码原样给客户端');
  const log = await logFor();
  assert.equal(log.err_class, 'upstream_server');
  assert.equal(log.status, 503);
  assert.deepEqual(mod._state.cooldowns, {}, '失败后不建立冷却记录');
  assert.equal(mod.providerEligible('p'), true);
});

test('Responses 直通的 failed 终态是失败,不是成功', async () => {
  configure('responses', 'codex');
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(frame('response.failed', { type: 'response.failed', response: {
      status: 'failed', error: { message: 'fixture upstream failure' },
    } }));
  };
  await ask('failed-terminal', { input: 'hi' }, '/v1/responses');
  const log = await logFor();
  assert.match(log.err, /fixture upstream failure/, '上游给的原因要落进日志,不能只剩一个状态码');
});

test('客户端取消保持为取消:不把在途 200 当成成功,也不当成渠道失败', async () => {
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
  let log;
  for (let i = 0; i < 50; i++) {
    log = await logFor();
    if (log.err_class === 'cancelled') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(log.err_class, 'cancelled');
  // 取消是客户端的决定,不是渠道坏了:把它记成冷却等于替用户惩罚一个健康渠道
  assert.deepEqual(mod._state.cooldowns, {});
});

test('合法 token 上限终态算成功,不进冷却', async () => {
  configure('responses', 'codex');
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(frame('response.incomplete', { type: 'response.incomplete', response: {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    } }));
  };
  await ask('token-limit', { input: 'hi' }, '/v1/responses');
  const log = await logFor();
  assert.equal(log.err_class || '', '', '达到输出上限是合法终态,不该记错误');
  assert.deepEqual(mod._state.cooldowns, {});
});

test('Codex→Chat 的 200 错误 JSON 不能算成功', async () => {
  configure('chat', 'codex');
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'fixture error' } }));
  };
  const result = await ask('chat-error-json', { stream: false, input: 'hi' }, '/v1/responses');
  assert.equal(result.status, 502);
  const log = await logFor();
  assert.equal(log.err_class, 'protocol_error');
  assert.equal(log.status, 502);
});

test('Codex→Chat 断流由桥接终态结算失败', async () => {
  configure('chat', 'codex');
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
  };
  const result = await ask('chat-incomplete', { stream: false, input: 'hi' }, '/v1/responses');
  assert.equal(result.status, 502);
  assert.equal(JSON.parse(result.text).status, 'failed');
  assert.equal((await logFor()).status, 502);
});
