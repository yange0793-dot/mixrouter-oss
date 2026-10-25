'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const bridge = require('../lib/wire-openai-bridge');

// Codex 的 Responses 解码器要求两份 details 及 cached/reasoning 计数,即使上游没报 usage。
const zeroUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0,
  input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const cases = [
  { name: 'no usage', usage: undefined, expected: zeroUsage },
  { name: 'null usage', usage: null, expected: zeroUsage },
  { name: 'empty usage', usage: {}, expected: zeroUsage },
  { name: 'no details', usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 99 },
    expected: { ...zeroUsage, input_tokens: 11, output_tokens: 7, total_tokens: 99 } },
  { name: 'empty details', usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18,
    prompt_tokens_details: {}, completion_tokens_details: {} },
    expected: { ...zeroUsage, input_tokens: 11, output_tokens: 7, total_tokens: 18 } },
  { name: 'null details and counters', usage: { prompt_tokens_details: null, completion_tokens_details: { reasoning_tokens: null } },
    expected: zeroUsage },
  { name: 'extras without required counters', usage: { prompt_tokens_details: { audio_tokens: 3 },
    completion_tokens_details: { accepted_prediction_tokens: 2 } },
    expected: { ...zeroUsage, input_tokens_details: { audio_tokens: 3, cached_tokens: 0 },
      output_tokens_details: { accepted_prediction_tokens: 2, reasoning_tokens: 0 } } },
  { name: 'provided accounting and extras', usage: { prompt_tokens: 21, completion_tokens: 13, total_tokens: 34,
    prompt_tokens_details: { cached_tokens: 4, audio_tokens: 3, provider_detail: { cache: 'read' } },
    completion_tokens_details: { reasoning_tokens: 5, accepted_prediction_tokens: 2, rejected_prediction_tokens: 1 } },
    expected: { input_tokens: 21, output_tokens: 13, total_tokens: 34,
      input_tokens_details: { cached_tokens: 4, audio_tokens: 3, provider_detail: { cache: 'read' } },
      output_tokens_details: { reasoning_tokens: 5, accepted_prediction_tokens: 2, rejected_prediction_tokens: 1 } } },
  { name: 'provided zero counters', usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18,
    prompt_tokens_details: { cached_tokens: 0, audio_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 2 } },
    expected: { input_tokens: 11, output_tokens: 7, total_tokens: 18,
      input_tokens_details: { cached_tokens: 0, audio_tokens: 3 }, output_tokens_details: { reasoning_tokens: 0, audio_tokens: 2 } } },
];

function sink() {
  return { text: '', ended: false,
    writeHead(code, headers) { this.code = code; this.headers = headers; },
    write(text) { assert.equal(this.ended, false, 'no write after terminal response'); this.text += text; },
    end(text = '') { this.text += text; this.ended = true; } };
}
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const events = text => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
const chatJson = (usage, reason = 'stop') => ({ id: 'chat-usage', choices: [
  { message: { reasoning_content: 'plan', content: 'answer' }, finish_reason: reason },
], ...(usage === undefined ? {} : { usage }) });

async function stream(usage, request = {}, { reason = 'stop', error = false } = {}) {
  const upstream = new PassThrough();
  const response = sink();
  const completions = [];
  bridge.streamChatAsResponses(upstream, response, 'model', (reportedUsage, completion) => {
    completions.push({ usage: reportedUsage, response: completion });
  }, {}, request);
  upstream.write(frame({ choices: [{ delta: { reasoning_content: 'plan', content: 'answer' } }] }));
  if (usage !== undefined) upstream.write(frame({ choices: [], usage }));
  if (error) upstream.emit('error', new Error('broken'));
  else {
    upstream.write(frame({ choices: [{ delta: {}, finish_reason: reason }] }));
    upstream.write('data: [DONE]\n\n');
    upstream.end();
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.ended, true);
  assert.equal(completions.length, 1, 'usage callback fires once');
  const emitted = request.stream === false ? JSON.parse(response.text)
    : events(response.text).filter(event => ['response.completed', 'response.failed', 'response.incomplete'].includes(event.type));
  if (request.stream !== false) assert.equal(emitted.length, 1, 'exactly one terminal SSE frame');
  return { response, final: request.stream === false ? emitted : emitted[0].response, callback: completions[0] };
}

function checkUsage(response, expected) {
  assert.deepEqual(response.usage, expected);
  assert.equal(typeof response.usage.input_tokens_details.cached_tokens, 'number');
  assert.equal(typeof response.usage.output_tokens_details.reasoning_tokens, 'number');
}

for (const { name, usage, expected } of cases) {
  test(`Responses usage JSON: ${name}`, () => {
    const before = JSON.stringify(usage);
    const response = bridge.chatJsonToResponses(chatJson(usage), 'model', { stream: false });
    assert.equal(response.status, 'completed');
    checkUsage(response, expected);
    assert.equal(JSON.stringify(usage), before, 'upstream accounting is not mutated');
    if (usage?.prompt_tokens_details) assert.notEqual(response.usage.input_tokens_details, usage.prompt_tokens_details);
    if (usage?.completion_tokens_details) assert.notEqual(response.usage.output_tokens_details, usage.completion_tokens_details);
  });

  test(`Responses usage JSON to completed SSE frame: ${name}`, () => {
    const response = sink();
    bridge.emitResponsesSse(response, bridge.chatJsonToResponses(chatJson(usage), 'model'), {});
    assert.equal(response.headers['Content-Type'], 'text/event-stream');
    assert.equal(response.ended, true);
    const completed = events(response.text).filter(event => event.type === 'response.completed');
    assert.equal(completed.length, 1);
    checkUsage(completed[0].response, expected);
  });

  test(`Responses usage Chat SSE to completed SSE frame: ${name}`, async () => {
    const result = await stream(usage);
    assert.equal(result.response.headers['Content-Type'], 'text/event-stream');
    assert.equal(result.final.status, 'completed');
    checkUsage(result.final, expected);
    assert.deepEqual(result.callback.usage, result.final.usage, 'emitted accounting matches log callback');
  });

  test(`Responses usage Chat SSE to nonstream JSON: ${name}`, async () => {
    const result = await stream(usage, { stream: false });
    assert.equal(result.response.code, 200);
    assert.equal(result.response.headers['Content-Type'], 'application/json');
    assert.equal(result.final.status, 'completed');
    checkUsage(result.final, expected);
    assert.deepEqual(result.callback.usage, result.final.usage);
  });
}

for (const { name, usage, expected } of [cases[0], cases[7]]) {
  for (const terminal of [{ status: 'failed', error: true }, { status: 'incomplete', reason: 'length' },
    { status: 'incomplete', reason: 'content_filter' }]) {
    for (const streaming of [true, false]) {
      test(`Responses usage ${terminal.status}/${terminal.reason || 'disconnect'} ${streaming ? 'SSE' : 'JSON'}: ${name}`, async () => {
        const result = await stream(usage, { stream: streaming }, terminal);
        assert.equal(result.final.status, terminal.status);
        assert.equal(result.response.code, streaming || !terminal.error ? 200 : 502);
        checkUsage(result.final, expected);
        assert.deepEqual(result.callback.usage, result.final.usage);
        if (terminal.error) assert.equal(result.final.error.code, 'upstream_stream_error');
        else assert.equal(result.final.incomplete_details.reason, terminal.reason === 'length' ? 'max_output_tokens' : 'content_filter');
      });
    }
  }

  for (const reason of ['length', 'content_filter']) {
    test(`Responses usage incomplete JSON and emitted SSE/${reason}: ${name}`, () => {
      const converted = bridge.chatJsonToResponses(chatJson(usage, reason), 'model');
      assert.equal(converted.status, 'incomplete');
      checkUsage(converted, expected);
      const response = sink();
      bridge.emitResponsesSse(response, converted, {});
      const terminal = events(response.text).filter(event => event.type === 'response.incomplete');
      assert.equal(terminal.length, 1);
      checkUsage(terminal[0].response, expected);
    });
  }
}
