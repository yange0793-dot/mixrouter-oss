'use strict';
// SSE 末帧没有空行收尾(原生 Responses 直通,lib/proxy/response.js 的 relayNativeResponses)。
//
// 真实上游常常把最后一个事件和 res.end() 写在一起:`data: {...}` 后面没有 `\n\n`。
// 事件扫描只认完整帧,残段于是从没被解析过 —— 一条成功的 response.completed 被当成
// "没有合法终态",requests.jsonl 记成 stream_aborted;错误帧同样被吞掉,日志只剩一句
// 笼统的"没给出合法终态"。这里直接驱动生产 dispatchResponse(只连内存桩):
//   · 残帧是 completed:成功、usage 照记、原始字节逐字节转发、不记 stream_aborted;
//   · 残帧是 error:错误原因要进 entry.err,err_class 仍是 stream_aborted。

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
    end() { this.writableEnded = true; },
    text() { return Buffer.concat(this.chunks).toString('utf8'); },
  };
}

// 跑一条原生 Responses 直通响应:上游字节一次性(或按 chunks 分批)到达后 EOF。
function relay(raw, { chunks = null } = {}) {
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
        const result = { res, entry, usage, retryAsked };
        // 让本拍的 res.end() 先跑完再交结果(与生产顺序一致:先结算终态,再 end)
        setImmediate(() => resolve({ ...result, text: res.text() }));
      },
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
