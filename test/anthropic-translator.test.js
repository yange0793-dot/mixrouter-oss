'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAnthropicTranslator } = require('../lib/wire-anthropic-translator');
const { upstreamErrorText } = require('../lib/upstream-error-text');
const responses = require('../lib/wire-responses');
const chat = require('../lib/wire-chat');

function context(extra = {}) {
  const calls = [];
  const entry = { status: 200, err: '', err_class: '' };
  const res = {
    headersSent: false, writableEnded: false, destroyed: false, text: '',
    writeHead(status, headers) { calls.push('headers'); this.status = status; this.headers = headers; this.headersSent = true; },
    write(text) { this.text += String(text); return true; },
    end(text = '') { calls.push('end'); this.text += String(text); this.writableEnded = true; },
  };
  const ctx = { entry, res, calls, headers: { 'x-mixrouter-provider': 'mock' }, model: 'model',
    clientClosed: false, startKeepAlive: () => calls.push('commit'),
    finishEntry(usage) { calls.push('log'); ctx.logged = { ...entry }; ctx.usage = usage; }, ...extra };
  return ctx;
}

const usage = { input_tokens: 60, output_tokens: 7, cache_read_input_tokens: 40 };
const expected = { id: 'result', type: 'message', role: 'assistant', model: 'model',
  content: [{ type: 'thinking', thinking: '先想', signature: '' }, { type: 'text', text: '结果' }],
  stop_reason: 'end_turn', stop_sequence: null, usage };
const tools = [{ name: 'Read', input_schema: { type: 'object', required: ['file_path'], properties: {
  file_path: { type: 'string' }, pages: { type: 'string' }, limit: { type: 'number' },
} } }];
const fixtures = {
  chat: {
    translator: createAnthropicTranslator({ convertError: chat.chatErrorOf, convertMessage: chat.chatToAnthropic }),
    payload: { id: 'result', model: 'model', choices: [{ message: { content: '结果', reasoning_content: '先想' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } } },
    tool(args) { return { choices: [{ message: { tool_calls: [{ id: 'tool', function: { name: 'Read', arguments: args } }] }, finish_reason: 'tool_calls' }] }; },
  },
  responses: {
    translator: createAnthropicTranslator({ convertError: responses.responsesErrorOf, convertMessage: responses.responsesToAnthropic }),
    payload: { id: 'result', model: 'model', status: 'completed', output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '先想' }] },
      { type: 'message', content: [{ type: 'output_text', text: '结果' }] },
    ], usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 40 } } },
    tool(args) { return { status: 'completed', output: [{ type: 'function_call', call_id: 'tool', name: 'Read', arguments: args }] }; },
  },
};

test('upstream error text preserves fallback values without applying presentation rules', () => {
  for (const [text, want] of [
    ['{"error":{"message":"reason"}}', 'reason'], ['{"error":"plain"}', 'plain'],
    ['{"error":{"code":"budget"}}', '{"code":"budget"}'], ['{"message":"top"}', 'top'],
    ['{"error":{"message":17}}', 17], ['null', 'null'], ['  ', '  '], ['<html>bad</html>', '<html>bad</html>'],
  ]) assert.equal(upstreamErrorText(text), want);
});

for (const [wire, { translator, payload, tool }] of Object.entries(fixtures)) {
  test(`${wire}: upstream errors preserve status, whitespace and log-before-response order`, () => {
    for (const text of ['', '  ', '{"error":{"message":"  budget  "}}', 'x'.repeat(500)]) {
      const ctx = context({ text, status: 402 });
      ctx.entry.status = 402;
      translator.replyUpstreamError(ctx);
      const message = String(upstreamErrorText(text)).slice(0, 400);
      assert.equal(ctx.res.status, 402);
      assert.deepEqual(JSON.parse(ctx.res.text), { type: 'error', error: { type: 'api_error', message } });
      assert.equal(ctx.logged.err, `HTTP 402: ${message}`);
      assert.deepEqual(ctx.calls, ['log', 'headers', 'end']);
    }
  });

  test(`${wire}: whole JSON keeps thinking and cache usage for both client formats`, () => {
    for (const bodyStream of [false, true]) {
      const ctx = context({ text: JSON.stringify(payload), bodyStream });
      translator.endWholeJson(ctx);
      const message = bodyStream ? responses.collectAnthropicMessage(ctx.res.text) : JSON.parse(ctx.res.text);
      if (bodyStream) assert.match(ctx.res.text, /event: message_stop/);
      assert.deepEqual({ ...message, id: 'result' }, expected);
      assert.deepEqual(ctx.usage, { in: 60, out: 7, cache_read: 40 });
      assert.equal(ctx.calls[0], 'log');
      assert.equal(ctx.calls.includes('commit'), bodyStream);
      assert.equal(ctx.res.headers['x-mixrouter-provider'], 'mock');
    }
  });

  test(`${wire}: tool schema still removes only optional empty arguments`, () => {
    const ctx = context({ text: JSON.stringify(tool('{"file_path":"","pages":"","limit":0}')), tools });
    translator.endWholeJson(ctx);
    assert.deepEqual(JSON.parse(ctx.res.text).content[0].input, { file_path: '', limit: 0 });
  });

  test(`${wire}: errors inside HTTP 200 and malformed tool arguments log 502 before replying`, () => {
    for (const payload of [{ error: { message: 'quota' } }, tool('{"file_path":')]) {
      const ctx = context({ text: JSON.stringify(payload) });
      translator.endWholeJson(ctx);
      assert.equal(ctx.res.status, 502);
      assert.equal(ctx.logged.status, 502);
      assert.ok(ctx.logged.err);
      assert.equal(ctx.logged.err_class, 'upstream_server');
      assert.equal(JSON.parse(ctx.res.text).type, 'error');
      assert.equal(ctx.calls[0], 'log');
    }
  });

  test(`${wire}: non-JSON response and already-sent headers preserve fallback behavior`, () => {
    const ctx = context({ text: '<html>not JSON</html>', bodyStream: true });
    translator.endWholeJson(ctx);
    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.text, ctx.text);
    assert.deepEqual(ctx.usage, { in: 0, out: 0, cache_read: 0 });
    const sent = context({ text: JSON.stringify(payload) });
    sent.res.headersSent = true;
    translator.endWholeJson(sent);
    assert.deepEqual(sent.calls, ['log']);
  });

  test(`${wire}: buffered SSE succeeds only with complete terminal events`, () => {
    const buffered = context();
    responses.emitAnthropicSse(buffered.res, expected);
    const ctx = context({ sink: { text: () => buffered.res.text }, result: { usage } });
    translator.endBufferedStream(ctx);
    assert.deepEqual({ ...JSON.parse(ctx.res.text), id: 'result' }, expected);
    assert.deepEqual(ctx.usage, { in: 60, out: 7, cache_read: 40 });
    assert.deepEqual(ctx.calls, ['log', 'headers', 'end']);

    const bad = context({ sink: { text: () => buffered.res.text.replace(/event: message_stop[\s\S]*$/, '') }, result: { usage } });
    translator.endBufferedStream(bad);
    assert.equal(bad.res.status, 502);
    assert.equal(bad.logged.status, 502);
    assert.match(bad.logged.err, /完整终态/);
    assert.equal(bad.calls[0], 'log');
  });

  test(`${wire}: aborted streams do not synthesize success or write after cancellation`, () => {
    const ctx = context({ sink: { text() { throw new Error('must not parse aborted data'); } },
      result: { aborted: true, detail: 'lost connection', usage } });
    translator.endBufferedStream(ctx);
    assert.equal(ctx.res.status, 502);
    assert.equal(ctx.logged.err, 'lost connection');
    const closed = context({ clientClosed: true, sink: ctx.sink, result: ctx.result });
    translator.endBufferedStream(closed);
    assert.deepEqual(closed.calls, ['log']);
    const live = context({ sink: null, result: { aborted: true, detail: 'lost connection', usage } });
    live.res.headersSent = true;
    translator.endBufferedStream(live);
    assert.equal(live.logged.err_class, 'stream_aborted');
    assert.deepEqual(live.calls, ['log']);
  });
}
