'use strict';
// SSE 末帧没有空行收尾(lib/proxy/response.js 的 relayNativeResponses、
// openai/adapted-format 与 anthropic/buffered-sse 三条分支)。
//
// 真实上游常常把最后一个事件和 res.end() 写在一起:`data: {...}` 后面没有 `\n\n`。
// 事件扫描只认完整帧,残段于是从没被解析过 —— 一条成功的 response.completed 被当成
// "没有合法终态",requests.jsonl 记成 stream_aborted;错误帧同样被吞掉,日志只剩一句
// 笼统的"没给出合法终态"。这里直接驱动生产 dispatchResponse(只连内存桩):
//   · 原生直通:残帧是 completed 成功、usage 照记、原始字节逐字节转发;错误帧原因进日志;
//   · adapted-format / buffered-sse:残帧是终态时整理成完整结果回给客户端;
//   · 真截断(残帧 JSON 不完整)不得被当成成功。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const { createResponder } = require('../lib/proxy/response');
const wireResponses = require('../lib/wire-responses');
const wireOpenai = require('../lib/wire-openai-bridge');
const { upstreamErrorText } = require('../lib/upstream-error-text');

const { dispatchResponse } = createResponder({
  wireResponses, wireOpenai, upstreamErrorText,
  collect: require('../lib/upstream-collect'),
  extractUsageFor: () => ({}),
  sseResult: () => ({ ok: true }),
  errLineOrPlaceholder: (_status, text) => text,
});

function clientSink() {
  return {
    headersSent: false, writableEnded: false, destroyed: false, statusCode: 0, headers: null, chunks: [],
    writeHead(status, headers) { this.headersSent = true; this.statusCode = status; this.headers = headers; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(String(chunk)));
      this.writableEnded = true;
    },
    text() { return Buffer.concat(this.chunks).toString('utf8'); },
  };
}

// 跑一条响应:上游字节一次性(或按 chunks 分批)到达后 EOF。
// overrides 用来切换到 adapted-format / buffered-sse 等其它协议分支。
function relay(raw, { chunks = null, overrides = {} } = {}) {
  return new Promise(resolve => {
    const cres = new PassThrough();
    cres.statusCode = 200;
    cres.complete = true;
    cres.headers = { 'content-type': 'text/event-stream' };
    const res = clientSink();
    const entry = { status: 200, err: '', err_class: '' };
    let retryAsked = 0;
    const a = {
      cres, res, isSse: true, conv: false, wire: 'responses', ep: { kind: 'responses' },
      body: {}, entry, model: 'fixture-model', provider: { id: 'fixture', name: 'fixture' },
      outHeaders: { 'Content-Type': 'text/event-stream' }, resolved: {},
      startKeepAlive() {}, disarmIdle() {}, markResourcePrefixPending() {}, markResponseDone() {},
      upstreamDead() {}, sendErr() {},
      get clientClosed() { return false; },
      get deadlineHit() { return false; },
      setNativeDisconnectHandler() {},
      retryNativeEmpty() { retryAsked++; return false; },
      finishEntry(usage) {
        // 让本拍的 res.end() 先跑完再交结果(与生产顺序一致:先结算终态,再 end)
        setImmediate(() => resolve({ res, entry, usage, retryAsked, text: res.text() }));
      },
      ...overrides,
    };
    dispatchResponse(a);
    if (chunks) for (const chunk of chunks) cres.write(chunk);
    else cres.write(raw);
    cres.end();
  });
}

const completed = {
  type: 'response.completed',
  response: {
    id: 'resp-eof', object: 'response', status: 'completed',
    output: [{ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完整答案' }] }],
    usage: { input_tokens: 8, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } },
  },
};

test('末帧 completed 没有 \\n\\n:仍算成功,不记 stream_aborted,usage 照常', async () => {
  const raw = `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '部分' })}\n\n`
    + `event: response.completed\ndata: ${JSON.stringify(completed)}`; // 故意不带收尾空行
  const r = await relay(raw);

  assert.equal(r.entry.err || '', '', `残帧是正常终态,不该记错误:${r.entry.err}`);
  assert.equal(r.entry.err_class || '', '', '成功的流不许被记成 stream_aborted');
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.text, raw, '原始字节逐字节转发,不给残帧补字节');
  assert.equal(r.retryAsked, 0, '已经看到终态,不该再要一次上游调用');
  assert.deepEqual(r.usage, { in: 8, out: 3, cache_read: 2 });
});

test('末帧 completed 跨块到达(残段被后续字节补齐)同样成功', async () => {
  const raw = `data: ${JSON.stringify(completed)}`;
  const r = await relay(raw, { chunks: [raw.slice(0, 60), raw.slice(60)] });
  assert.equal(r.entry.err_class || '', '');
  assert.equal(r.text, raw);
});

test('末帧是 error 事件没有 \\n\\n:原因写进 err,分类仍是 stream_aborted', async () => {
  const raw = 'event: response.output_text.delta\n'
    + `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '部分' })}\n\n`
    + `event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: '上游渠道池打满' } })}`;
  const r = await relay(raw);

  assert.equal(r.text, raw);
  assert.equal(r.entry.err_class, 'stream_aborted', '没有成功终态,如实记断流');
  assert.match(r.entry.err, /上游渠道池打满/, '残帧里的真实原因不能被吞成"缺少合法终态"');
});

// ---------------------------------------------------------------- adapted-format 线
// 客户端要非流、上游按 SSE 回:整段 parseSseEvents 后取终态事件。末帧没有空行时
// 以前会丢掉 response.completed,整条成功的响应被当成"缺少完整终态"。
test('adapted-format:末帧 completed 没有 \\n\\n,仍判成功并整理成 JSON', async () => {
  const raw = `data: ${JSON.stringify({ type: 'response.created', response: { id: 'r1', status: 'in_progress' } })}\n\n`
    + `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } })}\n\n`
    + `data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: '完整答案' })}\n\n`
    + `data: ${JSON.stringify(completed)}`; // 故意不带收尾空行
  const r = await relay(raw, { overrides: {
    isSse: true, streamOverride: true, body: { stream: false },
    wire: 'responses', ep: { kind: 'responses' }, conv: false,
  } });

  assert.equal(r.entry.err || '', '', `残帧是正常终态,不该记错误:${r.entry.err}`);
  assert.equal(r.entry.err_class || '', '');
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res.headers['Content-Type'], 'application/json');
  const msg = JSON.parse(r.text);
  assert.equal(msg.status, 'completed');
  assert.equal(msg.output[0].content[0].text, '完整答案');
});

test('adapted-format:残帧 JSON 真截断不得当成成功', async () => {
  const raw = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '半句' })}\n\n`
    + 'data: {"type":"response.completed","response":{"status":"completed","output":[';
  const r = await relay(raw, { overrides: {
    isSse: true, streamOverride: true, body: { stream: false },
    wire: 'responses', ep: { kind: 'responses' }, conv: false,
  } });

  assert.equal(r.entry.status, 502, '没有完整终态就不是成功');
  assert.equal(r.entry.err_class, 'protocol_error');
  assert.equal(r.res.headersSent, false, '不能给客户端写 200');
});

// ---------------------------------------------------------------- anthropic/buffered-sse
// 客户端要非流、上游是原生 Anthropic SSE:整段 collectAnthropicMessage。
// 末帧 message_stop 没有空行时以前会抛"缺少完整终态",回客户端 502。
const anthropicEvents = [
  { type: 'message_start', message: { id: 'msg-eof', type: 'message', role: 'assistant', model: 'claude',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '答案' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
];
const anthropicFrame = ev => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}`;

test('anthropic/buffered-sse:末帧 message_stop 没有 \\n\\n,仍判成功并回整包', async () => {
  const raw = anthropicEvents.map(anthropicFrame).join('\n\n'); // 末尾没有空行
  const r = await relay(raw, { overrides: {
    isSse: true, body: { stream: false }, wire: 'anthropic', ep: { kind: 'messages' }, conv: false,
  } });

  assert.equal(r.entry.err || '', '', `残帧是正常终态,不该记错误:${r.entry.err}`);
  assert.equal(r.entry.err_class || '', '');
  assert.equal(r.res.statusCode, 200);
  const msg = JSON.parse(r.text);
  assert.equal(msg.content[0].text, '答案');
  assert.equal(msg.stop_reason, 'end_turn');
  assert.equal(r.usage.in, 5);
  assert.equal(r.usage.out, 2);
});

test('anthropic/buffered-sse:末帧 JSON 真截断仍记 stream_aborted', async () => {
  const raw = anthropicEvents.slice(0, -1).map(anthropicFrame).join('\n\n')
    + '\n\ndata: {"type":"message_stop"'; // 终态帧被截断
  const r = await relay(raw, { overrides: {
    isSse: true, body: { stream: false }, wire: 'anthropic', ep: { kind: 'messages' }, conv: false,
  } });

  assert.equal(r.entry.status, 502);
  assert.equal(r.entry.err_class, 'stream_aborted');
  assert.equal(r.res.headersSent, false, '不能把残缺流伪装成成功 JSON');
});
