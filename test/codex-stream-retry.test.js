'use strict';
// Codex 链路「流中断 / 限流 / 长时间无输出」的用户可见故障回归。
// 全部走本地桩上游;不连真实上游、不用真实 Key、不读用户数据。
//
// 事实(10-26 requests.jsonl 只读副本,已剔除实验行):
//   - 限流 84 行里 70 行 attempts=1;无终态 56 行里 55 行 attempts=1。
//     attempts 是 ctx.netAttempts,即真实上游调用次数 —— 这些请求只发了 1 次。
//   - 那些请求最终由客户端自己重试(logs_2.sqlite:89 条 responses_retry,阶梯 0.2/0.4/0.8/1.5/3.3s)。
//   - **未验证**:究竟是哪种帧形状把窗口关死的。没有抓到真实 AgentRouter wire 帧,
//     所以"未知 metadata 导致"只是假设,不是结论;相关形状在这里作为覆盖缺口钉住。
// 这里钉的是可证的行为:
//   - `data: [DONE]`(纯标记)不该关死窗口:响应线里常跟在错误帧后面
//   - 每个"可能有输出"的帧形状(未知字段、event 冲突、非法 UTF-8、半帧、真实输出)仍是屏障
//   - 输出前连接重置应当重试,客户端一个字节都不该看到第一次的字节
//   - 429/5xx 用既有次数与固定间隔重试,不引入新的等待策略
//   - 任何正文/推理/工具事件已经转发之后的中断:绝不重放
//   - 预算耗尽:如实以真实错误收尾,不伪造成功
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-codex-stream-'));
Object.assign(process.env, {
  MIXR_DATA_DIR: root, MIXR_CLAUDE_SETTINGS: path.join(root, 'settings.json'),
  MIXR_CODEX_CONFIG: path.join(root, 'config.toml'),
  MIXR_MAX_ATTEMPTS: '3', MIXR_CONV_RETRIES: '2', MIXR_RETRY_DELAY_MS: '10',
  MIXR_SSE_KEEPALIVE_MS: '0', MIXR_TOTAL_DEADLINE_MS: '6000',
  MIXR_STREAM_IDLE_TIMEOUT_MS: '2000', MIXR_RESPONSE_ARCHIVE: 'off', MIXR_UPSTREAM_PROXY: '',
});
const mod = require('../mixrouter');
const { destroyAgents } = require('../lib/upstream-proxy');

const MODEL = 'codex-stream-fixture';
const RATE = 'Your requests to gpt-6.1-sol for gpt-6.1-sol in eastus2 have exceeded token rate limit.';
const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const created = (response = { id: 'resp-1', status: 'in_progress', output: [] }) => frame({ type: 'response.created', response });
const inprogress = frame({ type: 'response.in_progress', response: { id: 'resp-1', status: 'in_progress', output: [] } });
const delta = text => frame({ type: 'response.output_text.delta', item_id: 'msg-1', output_index: 0, content_index: 0, delta: text });
const rateEvent = frame({ type: 'error', code: 'rate_limit_exceeded', message: RATE });
const rateFailed = frame({ type: 'response.failed', response: { id: 'resp-1', status: 'failed', output: [], error: { code: 'rate_limit_exceeded', message: RATE } } });
const done = response => frame({ type: 'response.completed', response: {
  id: 'resp-1', object: 'response', status: 'completed',
  output: [{ type: 'message', id: 'msg-1', role: 'assistant', content: [{ type: 'output_text', text: 'STREAM_OK' }] }],
  usage: { input_tokens: 11, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } }, ...response } });
const success = created() + delta('STREAM_OK') + done();

let upstream, proxy, reply, seen, closed, fixtureId = 0;
const sockets = new Set();
const calls = () => seen.length;

// base_url 默认是 loopback。传 OFFICIAL_URL 时才装成官方 HTTPS 目标 ——
// 那只影响「这条渠道算不算可恢复目标」的判定,真实传输仍被下面的 intercept 拦到 loopback,
// 不会有任何字节出网。
const OFFICIAL_URL = 'https://agentrouter.org/v1';
function configure(wireApi = 'responses', baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`) {
  const provider = { id: 'stream', name: 'stream', enabled: true, wire_api: wireApi, model: MODEL, models: [MODEL],
    api_key: 'synthetic-key', base_url: baseUrl,
    active_key: 'k1', keys: [{ id: 'k1', key: 'synthetic-key', enabled: true }] };
  mod._state.store = { claude: [], codex: [provider] };
  mod._state.routes = { rules: [], default: mod.normalizeRule({ model: MODEL, pool: ['stream'], strategy: 'priority' }) };
}
function reset() {
  fixtureId++; seen = []; closed = 0; mod._state.sessions.clear(); mod._state.cooldowns = {}; mod._state.resetPools();
  configure(); reply = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(success); };
}
function ask() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request({ hostname: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/v1/responses', agent: false,
      headers: { 'Content-Type': 'application/json', 'session-id': `stream-${fixtureId}`, originator: 'codex-fixture', Connection: 'close' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', () => {});
      res.once('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode, text: bytes.toString('utf8'), bytes, ms: Date.now() - started }); });
    });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('stream fixture timeout')));
    req.end(JSON.stringify({ model: MODEL, stream: true, store: false, prompt_cache_key: 'stream-cache',
      reasoning: { effort: 'max', summary: 'detailed' }, input: [{ role: 'user', content: 'stream fixture' }] }));
  });
}
function logs() {
  const file = path.join(root, 'logs/requests.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
const lastLog = () => logs().at(-1);
const types = text => text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => { try { return JSON.parse(line.slice(5)); } catch { return null; } }).filter(Boolean).map(event => event.type);

const originalHttpsRequest = https.request;
const officialHost = new URL(OFFICIAL_URL).hostname;
before(async () => {
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.once('end', () => { seen.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); reply(req, res, seen.length); });
    res.once('close', () => closed++);
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  // 官方 HTTPS 目标在这里被重定向到桩上游:只让"目标判定"成立,不产生任何真实连接。
  https.request = (options, ...rest) => {
    const hostname = options && typeof options === 'object' ? options.hostname : null;
    if (hostname === officialHost) {
      return http.request.call(http, { ...options, protocol: 'http:', hostname: '127.0.0.1',
        port: upstream.address().port, agent: false }, ...rest);
    }
    assert.equal(hostname, '127.0.0.1', `non-loopback transport target: ${hostname}`);
    return originalHttpsRequest.call(https, options, ...rest);
  };
  proxy = await mod.listen(0, mod.proxyHandler);
});
beforeEach(reset);
after(async () => {
  https.request = originalHttpsRequest;
  destroyAgents();
  for (const socket of sockets) socket.destroy();
  await Promise.all([upstream, proxy].filter(Boolean).map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- (a) 200 SSE 限流
// 事实:10-26 有 70/84 条限流行只发了 1 次上游(attempts=1)。这些形状在"一个字节都没写给
// 客户端"时就该还能重试。为什么线上那些请求没重试,**未验证**(见文件头),这里只钉行为。
for (const [label, bytes] of [
  ['bare error event', rateEvent],
  ['error then [DONE]', rateEvent + 'data: [DONE]\n\n'],
  ['created then error', created() + rateEvent],
  ['created + in_progress then error', created() + inprogress + rateEvent],
  ['response.failed rate limit', created() + rateFailed],
]) test(`pre-output rate limit is retried invisibly (${label})`, async () => {
  reply = (_req, res, call) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(call === 1 ? bytes : success);
  };
  const result = await ask();
  assert.equal(calls(), 2, 'the rate-limited attempt is retried once');
  assert.equal(result.status, 200);
  assert.equal(result.text, success, 'client sees only the recovered attempt, byte for byte');
  assert.doesNotMatch(result.text, /rate limit|response\.failed/);
  assert.equal(lastLog().attempts, 2);
  assert.equal(lastLog().err || '', '');
  assert.equal(lastLog().err_class || '', '');
});

// 未知字段仍然是屏障:生命周期帧只有落在共享允许清单(lifecycleOnly)里才算"没有输出"。
// 一个允许清单外的字段会携带什么内容没人知道,所以按"可能有输出"处理——单次原样转发,不重放。
// 放宽这一条需要真实抓到的 wire 帧证明那个字段只是元数据;目前没有,属于覆盖缺口。
for (const [label, extra] of [
  ['unknown_output', { unknown_output: 'opaque' }],
  ['gateway event id', { event_id: 'evt-1' }],
  ['gateway marker', { x_gateway: 'v2' }],
]) test(`a lifecycle frame with an unrecognized field (${label}) is still forwarded once`, async () => {
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(created({ id: 'resp-1', status: 'in_progress', output: [], ...extra }) + rateEvent);
  };
  const result = await ask();
  assert.equal(calls(), 1, 'the unknown field may carry output: no replay');
  assert.equal(result.text, created({ id: 'resp-1', status: 'in_progress', output: [], ...extra }) + rateEvent,
    'the one attempt is forwarded byte for byte');
  assert.equal(lastLog().attempts, 1);
});

test('a protocol-shaped lifecycle frame stays holdable (no unknown fields)', async () => {
  // 对照:同一形状但只带协议字段(id/status/output/对象元数据),窗口保持开启、可以重试。
  const protocol = created({ id: 'resp-1', object: 'response', status: 'in_progress', output: [],
    metadata: {}, service_tier: 'auto', store: false, temperature: 1, top_p: 1, truncation: 'disabled' });
  reply = (_req, res, call) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(call === 1 ? protocol + rateEvent : success);
  };
  const result = await ask();
  assert.equal(calls(), 2);
  assert.equal(result.text, success);
});

// `[DONE]` 的豁免必须**严格**:只有裸标记(可以带注释行)才算"没有输出"。
// 任何别的字段、第二个 data 行、非法 UTF-8 都回到原来的屏障——
// 以前 parseFrame 就拒绝这些形状,它们携带什么没人证明过,所以按"可能有输出"处理。
for (const [label, marker] of [
  ['bare marker', 'data: [DONE]\n\n'],
  ['comment before and after', ': keep-alive\ndata: [DONE]\n: tail\n\n'],
  ['no space after colon', 'data:[DONE]\n\n'],
  ['trailing spaces', 'data: [DONE]   \n\n'],
]) test(`a bare [DONE] after an error keeps the window open (${label})`, async () => {
  reply = (_req, res, call) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(call === 1 ? rateEvent + marker : success);
  };
  const result = await ask();
  assert.equal(calls(), 2, 'a bare marker carries no output: retry stays possible');
  assert.equal(result.text, success);
});

for (const [label, marker] of [
  ['unknown field after it', 'data: [DONE]\nunknown: opaque\n\n'],
  ['unknown field before it', 'opaque: 1\ndata: [DONE]\n\n'],
  ['event name alongside it', 'event: message\ndata: [DONE]\n\n'],
  ['id field alongside it', 'id: 7\ndata: [DONE]\n\n'],
  ['second data line', 'data: [DONE]\ndata: [DONE]\n\n'],
  ['data payload with a suffix', 'data: [DONE] more\n\n'],
  ['retry field alongside it', 'retry: 3000\ndata: [DONE]\n\n'],
]) test(`[DONE] mixed with anything else stays a barrier (${label})`, async () => {
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(rateEvent + marker);
  };
  const result = await ask();
  assert.equal(calls(), 1, 'an unrecognized frame may carry output: no replay');
  assert.equal(result.text, rateEvent + marker, 'the one attempt is forwarded byte for byte');
  assert.equal(lastLog().attempts, 1);
});

test('a [DONE] frame with invalid UTF-8 in a comment stays a barrier', async () => {
  // 字节级构造:非法 UTF-8 藏在**注释行**里。只挑 data 行的宽松实现会看到干净的
  // `data: [DONE]` 从而放行;严格解码必须先拒绝整帧,让它继续算"可能有输出"。
  // 这是这一组里唯一钉住"严格解码"的用例(别的形状宽松实现也会拒绝)。
  const invalid = Buffer.concat([
    Buffer.from(': '), Buffer.from([0xff, 0xfe]), Buffer.from('\ndata: [DONE]\n\n'),
  ]);
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(Buffer.concat([Buffer.from(rateEvent), invalid]));
    res.end();
  };
  const result = await ask();
  assert.equal(calls(), 1, 'invalid UTF-8 is not provably non-output: no replay');
  assert.deepEqual(result.bytes, Buffer.concat([Buffer.from(rateEvent), invalid]));
});

test('a bare [DONE] followed by real output in the same chunk is never replayed', async () => {
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(rateEvent + 'data: [DONE]\n\n' + delta('AFTER_DONE'));
  };
  const result = await ask();
  assert.equal(calls(), 1, 'output after the marker closes the window');
  assert.match(result.text, /AFTER_DONE/);
  assert.equal(lastLog().attempts, 1);
});

test('a half-written frame after the error closes the window', async () => {
  // 半帧既不是 JSON 也不是裸 [DONE]:它可能正是一个被截断的输出帧,不能拿去重放。
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(rateEvent + 'data: {"type":"response.output_text.delta","delta":"PAR');
  };
  const result = await ask();
  assert.equal(calls(), 1, 'a partial frame may be output: no replay');
  assert.match(result.text, /"delta":"PAR/);
  assert.equal(lastLog().attempts, 1);
});

test('a bare [DONE] followed by a half-written frame closes the window', async () => {
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(rateEvent + 'data: [DONE]\n\ndata: {"type":"response.output_text.delta","delta":"PAR');
  };
  const result = await ask();
  assert.equal(calls(), 1, 'the trailing partial frame is unknown: no replay');
  assert.match(result.text, /"delta":"PAR/);
  assert.equal(lastLog().attempts, 1);
});

test('rate limit after partial output is never replayed', async () => {
  reply = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(created() + delta('PARTIAL') + rateEvent); };
  const result = await ask();
  assert.equal(calls(), 1, 'output was already forwarded: no replay');
  assert.match(result.text, /PARTIAL/);
  assert.equal(lastLog().attempts, 1);
  assert.equal(lastLog().err_class, 'stream_aborted');
});

test('a non-recoverable 400 stays terminal and is never retried', async () => {
  reply = (_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'content-blocked', message: 'HTTP 400: content-blocked (request id: fixture)' } }));
  };
  const result = await ask();
  assert.equal(calls(), 1);
  assert.equal(result.status, 400);
  assert.equal(lastLog().attempts, 1);
});

test('auth and quota failures in a 200 SSE are terminal', async () => {
  for (const terminal of [
    { type: 'error', code: 'invalid_api_key', message: 'Invalid API key' },
    { type: 'error', code: 'insufficient_quota', message: 'Account quota exhausted' },
    { type: 'error', code: 'context_length_exceeded', message: 'Context length exceeded' },
  ]) {
    reset();
    reply = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(created() + frame(terminal)); };
    const result = await ask();
    assert.equal(calls(), 1, `${terminal.code} must not be retried`);
    assert.match(result.text, new RegExp(terminal.code));
  }
});

// ---------------------------------------------------------------- (b) 没给合法终态
for (const [label, bytes] of [
  ['created only', created()],
  ['created + in_progress', created() + inprogress],
  ['empty body', ''],
  ['comment only', ': keep-alive\n\n'],
]) test(`stream that ends without a terminal state is retried (${label})`, async () => {
  reply = (_req, res, call) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(call === 1 ? bytes : success);
  };
  const result = await ask();
  assert.equal(calls(), 2);
  assert.equal(result.text, success, 'lifecycle bytes from the discarded attempt are not forwarded');
  assert.equal(types(result.text).filter(type => type === 'response.created').length, 1);
  assert.equal(lastLog().attempts, 2);
});

test('a truncated output frame at EOF is not replayed', async () => {
  const partial = created() + 'data: {"type":"response.output_text.delta","delta":"PART';
  reply = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(partial); };
  const result = await ask();
  assert.equal(calls(), 1, 'a partial frame may be output; never replay it');
  assert.equal(result.text, partial);
});

// ---------------------------------------------------------------- (c) 输出前连接重置
for (const [label, bytes] of [
  ['reset with no body', ''],
  ['reset after lifecycle', created() + inprogress],
  ['reset after lifecycle and [DONE]', created() + 'data: [DONE]\n\n'],
]) test(`connection reset before output is retried (${label})`, async () => {
  reply = (req, res, call) => {
    if (call > 1) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end(success); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (bytes) res.write(bytes);
    setTimeout(() => req.socket.destroy(), 10);
  };
  const result = await ask();
  assert.equal(calls(), 2);
  assert.equal(result.text, success);
  assert.equal(lastLog().attempts, 2);
});

test('connection reset after output is forwarded exactly and never replayed', async () => {
  reply = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(created() + delta('PARTIAL'));
    setTimeout(() => req.socket.destroy(), 10);
  };
  const result = await ask();
  assert.equal(calls(), 1);
  assert.match(result.text, /PARTIAL/);
  assert.equal(lastLog().attempts, 1);
});

// ---------------------------------------------------------------- (d) 429/5xx + Retry-After
for (const status of [429, 500, 502, 503, 504]) test(`HTTP ${status} before output is retried`, async () => {
  reply = (_req, res, call) => {
    if (call > 1) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end(success); }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: status === 429 ? 'rate_limit_exceeded' : 'server_error', message: `HTTP ${status}` } }));
  };
  const result = await ask();
  assert.equal(calls(), 2);
  assert.equal(result.text, success);
  assert.equal(lastLog().attempts, 2);
});

// ---------------------------------------------------------------- (e) 预算耗尽
test('exhausted budget ends with the real error and never fabricates success', async () => {
  reply = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(created() + rateEvent); };
  const result = await ask();
  assert.equal(calls(), 5, 'MAX_ATTEMPTS 3 + CONV_RETRIES 2');
  assert.doesNotMatch(result.text, /response\.completed/);
  assert.match(result.text, /exceeded token rate limit/);
  assert.equal(lastLog().attempts, 5);
  assert.equal(lastLog().err_class, 'stream_aborted');
});

test('a later terminal error replaces the transient one', async () => {
  reply = (_req, res, call) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (call === 1) return res.end(created() + rateEvent);
    res.end(created() + frame({ type: 'response.failed', response: { id: 'r', status: 'failed', output: [], error: { code: 'invalid_api_key', message: 'Invalid API key' } } }));
  };
  const result = await ask();
  assert.equal(calls(), 2);
  assert.match(result.text, /invalid_api_key/);
  assert.equal(lastLog().attempts, 2);
});

test('client cancellation during a held prefix stops the upstream stream', async () => {
  reply = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(created());
  };
  const client = http.request({ hostname: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/v1/responses', agent: false,
    headers: { 'Content-Type': 'application/json', 'session-id': `stream-cancel-${fixtureId}`, Connection: 'close' } });
  client.on('error', () => {});
  client.end(JSON.stringify({ model: MODEL, stream: true, input: [{ role: 'user', content: 'cancel me' }] }));
  await new Promise(resolve => setTimeout(resolve, 150));
  client.destroy();
  const deadline = Date.now() + 3000;
  while (closed === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(closed > 0, 'abandoned upstream response is closed');
  assert.equal(calls(), 1);
});

// ---------------------------------------------------------------- Chat 线(codex 客户端 → chat 网关)
// 同一个 bug 在 relayCodexChat 里也有一份:它把 chat 分片翻译成 Responses 事件,
// 所以错误分片 + `data: [DONE]` 必须在同一个前缀门里判,不能因为翻译器自己的
// response.created 就提前提交。两条 relay 都改了,就必须都有回归。
const chatChunk = payload => `data: ${JSON.stringify(payload)}\n\n`;
const chatOk = chatChunk({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'CHAT_OK' }, finish_reason: null }] })
  + chatChunk({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  + chatChunk({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })
  + 'data: [DONE]\n\n';
const chatRate = chatChunk({ error: { message: RATE, type: 'rate_limit_exceeded' } });

async function askChat() {
  configure('chat');
  return ask();
}

test('chat relay: an error chunk followed by a bare [DONE] is retried invisibly', async () => {
  reply = (_req, res, call) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(call === 1 ? chatRate + 'data: [DONE]\n\n' : chatOk);
  };
  const result = await askChat();
  assert.equal(calls(), 2, 'the chat relay keeps its pre-output window open');
  assert.equal(result.status, 200);
  assert.match(result.text, /CHAT_OK/);
  assert.doesNotMatch(result.text, /rate limit/i);
  assert.equal(lastLog().attempts, 2);
  assert.equal(lastLog().err || '', '');
});

test('chat relay: [DONE] mixed with an unknown field stays a barrier', async () => {
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(chatRate + 'data: [DONE]\nunknown: opaque\n\n');
  };
  const result = await askChat();
  assert.equal(calls(), 1, 'an unrecognized chat frame may carry output: no replay');
  assert.match(result.text, /rate limit/i, 'the upstream error reaches the client once, unwrapped');
});

test('chat relay: an error chunk followed by real output is never replayed', async () => {
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(chatRate + chatOk);
  };
  const result = await askChat();
  assert.equal(calls(), 1, 'forwarded output closes the window');
  assert.equal(lastLog().attempts, 1);
});

// ---------------------------------------------------------------- 加密故障的完整响应屏障
// 密文推理的降级是**有损**的,所以 classifyFailure 对 invalid_encrypted_content 给出
// requiresComplete,要求等整份响应收完再判断。前缀里先出现一个 transient 错误再出现这个帧时,
// 不能拿前缀里那个 transient 提前重放 —— 那等于绕过完整响应检查。
const encryptedError = frame({ type: 'error', code: 'invalid_encrypted_content',
  message: 'The encrypted content for item rs_1 could not be verified.' });

async function askOfficial() {
  configure('responses', OFFICIAL_URL);
  return ask();
}

test('transient error then invalid_encrypted_content in one chunk is never replayed', async () => {
  const prefix = rateEvent + encryptedError;
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(prefix);
  };
  const result = await askOfficial();
  assert.equal(calls(), 1, 'the ciphertext failure needs the complete response: no prefix replay');
  assert.equal(result.text, prefix, 'the single attempt is forwarded byte for byte');
  assert.equal(lastLog().attempts, 1);
  assert.equal(lastLog().err_class, 'stream_aborted');
});

test('lifecycle frame, then the mixed error prefix in a later chunk, is never replayed', async () => {
  // 分块边界不该改变判定:先到一个生命周期帧(不能判),随后两个错误帧到齐,
  // 这时 completeOnlyFailure 已置位,heldFailure 不许再拿前缀里的 transient 提前重放。
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(created());
    setTimeout(() => res.end(rateEvent + encryptedError), 10);
  };
  const result = await askOfficial();
  assert.equal(calls(), 1, 'chunk boundaries must not reopen the prefix replay');
  assert.equal(result.text, created() + rateEvent + encryptedError);
  assert.equal(lastLog().attempts, 1);
});

// 已知边界(如实记录,不当成修复):如果**先到的那个 chunk 里只有** transient 错误,
// 那一刻还没有任何 requiresComplete 帧,透明窗口照原样提前重试(见上面 "lone transient"
// 用例)。后面即使再来 invalid_encrypted_content 帧,那一发也已经重打过了 ——
// 这是"看不到未来"的必然结果,不是绕过屏障;预算耗尽后仍以真实错误收尾。

test('the same prefix on a non-official target stays non-recoverable', async () => {
  // 对照:目标不是官方 HTTPS 时 invalid_encrypted_content 根本不进恢复分支,
  // 这里只确认"屏障"没有把非官方目标变成可恢复。
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(rateEvent + encryptedError);
  };
  const result = await ask();
  assert.equal(calls(), 1);
  assert.equal(result.text, rateEvent + encryptedError);
});

test('a lone transient error is still replayed (the barrier is only about complete-only frames)', async () => {
  // 对照:没有 requiresComplete 帧时,前缀里的 transient 仍然走原来的提前重试路径。
  reply = (_req, res, call) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(call === 1 ? rateEvent + 'data: [DONE]\n\n' : success);
  };
  const result = await askOfficial();
  assert.equal(calls(), 2);
  assert.equal(result.text, success);
});
