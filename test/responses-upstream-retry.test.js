'use strict';
// 只连本地桩:原生 Responses 的空失败重试窗口与末次尝试的日志归因。
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { waitFor } = require('./wait-for');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-response-retry-'));
Object.assign(process.env, {
  MIXR_DATA_DIR: root, MIXR_CLAUDE_SETTINGS: path.join(root, 'settings.json'),
  MIXR_CODEX_CONFIG: path.join(root, 'config.toml'), MIXR_MAX_ATTEMPTS: '3',
  MIXR_CONV_RETRIES: '2', MIXR_RETRY_DELAY_MS: '15', MIXR_SSE_KEEPALIVE_MS: '5',
  MIXR_TOTAL_DEADLINE_MS: '700', MIXR_STREAM_IDLE_TIMEOUT_MS: '5000', MIXR_RESPONSE_ARCHIVE: 'off',
});
const mod = require('../mixrouter');
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const failed = (code = 'upstream_error', output = []) => ({ type: 'response.failed', response: {
  id: 'failed-attempt', object: 'response', status: 'failed', output,
  error: { code, message: code === 'upstream_error' ? 'Upstream request failed' : 'fixture invalid input' },
} });
const completed = () => ({ id: 'successful-attempt', object: 'response', status: 'completed',
  output: [{ id: 'm1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '最终答案' }] }],
  usage: { input_tokens: 8, output_tokens: 3 } });
let upstream, proxy, reply, hits, seen, finishedResponses;
const sockets = new Set();
function success(res, json = false) {
  res.writeHead(200, { 'Content-Type': json ? 'application/json' : 'text/event-stream' });
  res.end(json ? JSON.stringify(completed()) : frame({ type: 'response.completed', response: completed() }));
}
function rejectUpstream(res, event = failed(), json = false) {
  res.writeHead(200, { 'Content-Type': json ? 'application/json' : 'text/event-stream' });
  res.end(json ? JSON.stringify(event.response) : frame(event));
}
function configure({ override, pinned = false, other = false } = {}) {
  const provider = id => ({ id, name: id, enabled: true, api_key: 'sk-fixture', wire_api: 'responses',
    base_url: `http://127.0.0.1:${upstream.address().port}/${id}`, models: ['fixture-model'] });
  mod._state.store = { claude: [], codex: [provider('primary'), ...(other ? [provider('secondary')] : [])] };
  mod._state.routes = { rules: [], default: mod.normalizeRule({
    ...(pinned ? { provider: 'primary' } : { pool: other ? ['primary', 'secondary'] : ['primary'], strategy: 'priority' }),
    ...(override === undefined ? {} : { upstream_stream: override }),
  }) };
}
function ask({ stream = true, session = 'retry-fixture' } = {}, onResponse) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/v1/responses',
      agent: false, headers: { 'Content-Type': 'application/json', 'session-id': session, Connection: 'close' } }, res => {
      if (onResponse) onResponse(req, res);
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(2500, () => req.destroy(new Error('fixture timeout')));
    req.end(JSON.stringify({ model: 'fixture-model', stream, input: 'fixture' }));
  });
}
function lastLog() {
  const file = path.join(root, 'logs', 'requests.jsonl');
  return JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1));
}
function assertSuccess(result, calls) {
  assert.equal(result.status, 200, result.text);
  assert.match(result.text, /最终答案/);
  assert.doesNotMatch(result.text, /failed-attempt|Upstream request failed|keep-alive/,
    '提交前失败和心跳都不能漏给客户端');
  assert.equal(hits, calls);
  const log = lastLog();
  assert.equal(log.status, 200);
  assert.equal(log.attempts, calls);
  assert.equal(log.err || '', '');
  assert.equal(log.err_class || '', '');
  assert.equal(log.in, 8); assert.equal(log.out, 3);
  assert.ok(!log.failover, '同供应商重试不能伪记成换渠道');
}

before(async () => {
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  upstream = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => { hits++; seen.push(req.url); reply(req, res); });
    res.once('close', () => { finishedResponses++; });
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  proxy = await mod.listen(0, mod.proxyHandler);
});
beforeEach(() => {
  hits = 0; seen = []; finishedResponses = 0;
  mod._state.sessions.clear(); mod._state.cooldowns = {}; mod._state.resetPools();
  configure();
});
after(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([upstream, proxy].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  fs.rmSync(root, { recursive: true, force: true });
});

test('原生 HTTP200 首帧 failed+upstream_error+output:[] 在同供应商重试后只输出成功', async () => {
  reply = (_req, res) => hits === 1 ? rejectUpstream(res) : success(res);
  assertSuccess(await ask(), 2);
  assert.deepEqual(seen, ['/primary/v1/responses', '/primary/v1/responses']);
});

test('仅生命周期和心跳未提交:跨块 CRLF 失败帧仍可重试', async () => {
  reply = (_req, res) => {
    if (hits !== 1) return success(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': upstream-open\r\n\r\n' + frame({ type: 'response.created', response: { output: [], status: 'in_progress' } }));
    const text = frame(failed()).replace(/\n/g, '\r\n');
    res.write(text.slice(0, 70));
    setTimeout(() => res.end(text.slice(70)), 20);
  };
  assertSuccess(await ask(), 2);
});

for (const [stream, override, json] of [[false, undefined, true], [true, false, true], [false, true, false]]) {
  test(`空 upstream_error 对 JSON/显式格式转换同样重试 (client=${stream}, override=${override})`, async () => {
    configure({ override });
    reply = (_req, res) => hits === 1 ? rejectUpstream(res, failed(), json) : success(res, json);
    assertSuccess(await ask({ stream }), 2);
  });
}

test('有其它供应商也优先原渠道,不改变明确主渠道', async () => {
  configure({ other: true });
  reply = (_req, res) => hits === 1 ? rejectUpstream(res) : success(res);
  assertSuccess(await ask(), 2);
  assert.ok(seen.every(url => url.startsWith('/primary/')));
});

test('固定账号仍可有界同渠道重试,但不换供应商', async () => {
  configure({ pinned: true, other: true });
  reply = (_req, res) => hits === 1 ? rejectUpstream(res) : success(res);
  assertSuccess(await ask(), 2);
  assert.ok(seen.every(url => url.startsWith('/primary/')));
});

for (const event of [
  { type: 'response.output_text.delta', delta: '已经给出的答案' },
  { type: 'response.reasoning_text.delta', delta: '已经给出的思考' },
  { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'execute-once', name: 'Write', arguments: '{}' } },
  { type: 'response.web_search_call.in_progress', item_id: 'server-tool-once' },
]) test(`${event.type} 后失败不可重试/重复工具调用`, async () => {
  const text = frame(event) + frame(failed());
  reply = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(text); };
  const result = await ask();
  assert.equal(hits, 1);
  assert.equal(result.status, 200);
  assert.equal(result.text, text, '已提交字节逐字透传');
  assert.equal(lastLog().err_class, 'stream_aborted');
});

for (const stream of [true, false]) test(`请求/策略错误和已有 output 的失败不重试 (stream=${stream})`, async () => {
  for (const event of [failed('invalid_request_error'), failed('content_policy_violation'), failed('upstream_error', completed().output)]) {
    hits = 0;
    reply = (_req, res) => rejectUpstream(res, event, !stream);
    const result = await ask({ stream, session: event.response.error.code + stream });
    assert.equal(hits, 1);
    assert.match(result.text, /failed/);
    assert.ok(lastLog().err_class);
  }
});

test('空 failed 用尽既有配额才原样返回,实际调用数与总上限一致', async () => {
  reply = (_req, res) => rejectUpstream(res);
  const result = await ask();
  assert.equal(result.status, 200, '最终原生 failed 帧仍以 SSE 给客户端');
  assert.match(result.text, /Upstream request failed/);
  assert.equal(hits, 5, 'MAX_ATTEMPTS(3)+CONV_RETRIES(2),不扩既有真实调用上限');
  assert.equal(lastLog().attempts, hits);
  assert.ok(lastLog().err_class);
});

test('重试等待期间客户端取消不能继续发上游', async () => {
  let client;
  reply = (_req, res) => {
    rejectUpstream(res);
    setTimeout(() => client.destroy(), 2);
  };
  await new Promise((resolve, reject) => {
    client = http.request({ hostname: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/v1/responses',
      headers: { 'Content-Type': 'application/json' } });
    client.once('error', error => error.code === 'ECONNRESET' ? resolve() : reject(error));
    client.once('close', resolve);
    client.end(JSON.stringify({ model: 'fixture-model', stream: true, input: 'fixture' }));
  });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(hits, 1);
  assert.equal(lastLog().err_class, 'cancelled');
});

test('空错误重试仍受端到端总预算限制', async () => {
  reply = (_req, res) => setTimeout(() => rejectUpstream(res), 220);
  const started = Date.now();
  const result = await ask();
  assert.equal(result.status, 504);
  assert.equal(lastLog().err_class, 'timeout');
  assert.ok(hits < 5, '不能因为可重试而重置端到端预算');
  assert.ok(Date.now() - started < 1600);
  await waitFor(() => finishedResponses === hits, { label: '预算结束后本地桩响应全部关闭' });
});

test('failed 终态不等上游 EOF 就重试,旧流 close 不得覆盖成功', async () => {
  reply = (_req, res) => {
    if (hits !== 1) return success(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(frame(failed()));
  };
  assertSuccess(await ask(), 2);
  await waitFor(() => finishedResponses === hits, { label: '被放弃的 failed 上游已关闭' });
  assert.equal(lastLog().err_class || '', '');
});

test('正常原生 SSE 保留全部原始字节和跨块中文', async () => {
  const raw = ': upstream-open\r\n\r\n' + frame({ type: 'response.created', response: { output: [], status: 'in_progress' } })
    + frame({ type: 'response.output_text.delta', delta: '中文答案' }) + frame({ type: 'response.completed', response: completed() });
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const buffer = Buffer.from(raw);
    const at = buffer.indexOf(Buffer.from('中')) + 1;
    res.write(buffer.subarray(0, at)); res.end(buffer.subarray(at));
  };
  const result = await ask();
  assert.equal(result.text, raw);
  assert.equal(hits, 1);
});

for (const prefix of [
  'data: malformed-output\n\n',
  'event: response.output_text.delta\n\n',
  ': ' + 'x'.repeat(65 * 1024) + '\n\n',
  frame({ type: 'response.incomplete', response: { status: 'incomplete', output: [] } }),
]) test(`坏帧/有界前缀/已有合法终态不扩大重试窗口 (${prefix.slice(0, 45)})`, async () => {
  reply = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(prefix + frame(failed())); };
  const result = await ask();
  assert.equal(hits, 1);
  assert.equal(result.text, prefix + frame(failed()));
  assert.ok(lastLog().err_class);
});

test('缺少明确 output:[] 的 upstream_error 不猜成空响应', async () => {
  const event = failed(); delete event.response.output;
  reply = (_req, res) => rejectUpstream(res, event);
  const result = await ask();
  assert.equal(hits, 1); assert.match(result.text, /Upstream request failed/);
});

test('连接重置后真实成功不残留 econnreset', async () => {
  reply = (req, res) => hits < 3 ? req.socket.destroy() : success(res, true);
  assertSuccess(await ask({ stream: false }), 3);
});

test('重试等待跨过 deadline 不会再发一次真实请求', async () => {
  const { createAttemptRunner } = require('../lib/proxy/attempts');
  const ctx = { finalized: false, clientClosed: false, deadlineHit: false, netAttempts: 0,
    maxUpstreamCalls: 5, started: Date.now(), deadlineAt: Date.now() + 20, entry: {},
    finish() { this.finalized = true; }, sendErr() {}, markDeadlineHit() { this.deadlineHit = true; } };
  const runner = createAttemptRunner({ convRetries: 2, retryDelayMs: 100,
    runAttempt(loop) { ctx.netAttempts++; ctx.entry.err = 'old failure'; loop.retry(0); } });
  runner.runAttempts({ ordered: [{ provider: { id: 'primary' } }] }, ctx);
  await waitFor(() => ctx.finalized, { label: '重试间隔内预算到期' });
  assert.equal(ctx.netAttempts, 1);
  assert.equal(ctx.entry.status, 504); assert.equal(ctx.entry.err_class, 'timeout');
});

test('旧连接错误不能覆盖末次 HTTP/协议错误', async () => {
  reply = (req, res) => {
    if (hits === 1) return req.socket.destroy();
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"last real error"}}');
  };
  const result = await ask({ stream: false });
  assert.equal(result.status, 400);
  assert.equal(lastLog().err_class, 'upstream_request');
  assert.match(result.text, /last real error/);
  hits = 0;
  configure({ override: false });
  reply = (req, res) => {
    if (hits === 1) return req.socket.destroy();
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"in_progress","output":[]}');
  };
  const malformed = await ask();
  assert.equal(malformed.status, 502);
  assert.equal(lastLog().err_class, 'protocol_error');
  assert.doesNotMatch(lastLog().err, /ECONNRESET/);
});
