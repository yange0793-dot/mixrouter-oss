'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const bridge = require('../lib/wire-openai-bridge');

const user = content => ({ role: 'user', content });
const thought = text => ({ type: 'reasoning', summary: [{ type: 'summary_text', text }] });
const call = id => ({ type: 'function_call', call_id: id, name: 'read', arguments: '{}' });
const result = id => ({ type: 'function_call_output', call_id: id, output: 'ok' });
const convert = input => bridge.responsesToChat({ model: 'deepseek-test', input });
const assistants = request => request.messages.filter(message => message.role === 'assistant');

test('Codex Chat reasoning uses readable content before summary without concatenating both', () => {
  const input = [user('q'), { type: 'reasoning',
    content: [{ type: 'reasoning_text', text: 'original one' }, { type: 'reasoning_text', text: 'original two' }],
    summary: [{ type: 'summary_text', text: 'short summary' }], encrypted_content: 'opaque-test' }, call('one'), result('one')];
  const before = structuredClone(input);
  const request = convert(input);
  assert.equal(assistants(request)[0].reasoning_content, 'original one\noriginal two');
  assert.deepEqual(input, before);
  assert.equal(JSON.stringify(request).includes('opaque-test'), false);
});

test('Codex Chat reasoning falls back to all readable summary parts when content is absent or empty', () => {
  for (const content of [undefined, null, [], [{ type: 'reasoning_text', text: '' }]]) {
    const request = convert([user('q'), { type: 'reasoning', content,
      summary: [{ type: 'summary_text', text: 'one' }, { type: 'summary_text', text: 'two' }] }, call('one')]);
    assert.equal(assistants(request)[0].reasoning_content, 'one\ntwo');
  }
});

test('Codex Chat consecutive readable reasoning items accumulate and empty items do not erase them', () => {
  const request = convert([user('q'), thought('one'), { type: 'reasoning', summary: [], encrypted_content: 'opaque-test' },
    { type: 'reasoning_summary', content: [{ type: 'reasoning_text', text: 'two' }] }, call('one')]);
  assert.equal(assistants(request)[0].reasoning_content, 'one\ntwo');
});

test('Codex Chat reasoning attaches to assistant text before tool calls in the same response', () => {
  for (const content of ['status', [{ type: 'output_text', text: 'status' }]]) {
    const request = convert([user('q'), thought('plan'), { role: 'assistant', content }, call('one'), call('two'), result('one'), result('two')]);
    assert.equal(assistants(request).length, 1);
    assert.equal(assistants(request)[0].content, 'status');
    assert.equal(assistants(request)[0].reasoning_content, 'plan');
    assert.deepEqual(assistants(request)[0].tool_calls.map(tool => tool.id), ['one', 'two']);
  }
});

test('Codex Chat new reasoning starts a new assistant response instead of overwriting previous reasoning', () => {
  const request = convert([user('q'), thought('first'), { role: 'assistant', content: 'first answer' },
    thought('second'), call('one'), result('one')]);
  const messages = assistants(request);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].reasoning_content, 'first');
  assert.equal(messages[0].tool_calls, undefined);
  assert.equal(messages[1].reasoning_content, 'second');
  assert.equal(messages[1].tool_calls[0].id, 'one');
});

test('Codex Chat an opaque new reasoning item cannot borrow the previous assistant reasoning', () => {
  const request = convert([user('q'), thought('first'), { role: 'assistant', content: 'first answer' },
    { type: 'reasoning', summary: [], encrypted_content: 'opaque-test' }, call('one')]);
  const messages = assistants(request);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].reasoning_content, 'first');
  assert.equal(Object.hasOwn(messages[1], 'reasoning_content'), false);
});

test('Codex Chat user, string, developer and default user message boundaries clear pending reasoning', () => {
  for (const boundary of [user('next'), 'next', { role: 'developer', content: 'next' }, { role: 'system', content: 'next' },
    { type: 'message', content: 'next' }]) {
    const request = convert([user('q'), thought('old'), boundary, call('one')]);
    assert.equal(Object.hasOwn(assistants(request)[0], 'reasoning_content'), false);
  }
});

test('Codex Chat tool result ends previous reasoning scope and next reasoning belongs only to new calls', () => {
  const request = convert([user('q'), thought('first'), call('one'), result('one'), thought('second'), call('two'), result('two'), call('three')]);
  const messages = assistants(request);
  assert.deepEqual(messages.map(message => message.reasoning_content), ['first', 'second', undefined]);
  assert.deepEqual(messages.map(message => message.tool_calls[0].id), ['one', 'two', 'three']);
});

test('Codex Chat unavailable reasoning remains absent rather than inventing an empty value', () => {
  for (const reasoning of [null, { type: 'reasoning' }, { type: 'reasoning', summary: [] },
    { type: 'reasoning', encrypted_content: 'opaque-test' }]) {
    const request = convert([user('q'), reasoning, call('one')]);
    assert.equal(Object.hasOwn(assistants(request)[0], 'reasoning_content'), false);
  }
});

test('Codex Chat custom parallel tool calls retain namespace, input and shared readable reasoning', () => {
  const tools = [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'patch' }] }];
  const request = bridge.responsesToChat({ input: [user('q'), thought('plan'),
    { type: 'custom_tool_call', namespace: 'functions', name: 'patch', call_id: 'patch_one', input: 'patch one' },
    { type: 'custom_tool_call', namespace: 'functions', name: 'patch', call_id: 'patch_two', input: 'patch two' },
    { type: 'custom_tool_call_output', call_id: 'patch_one', output: 'done' },
    { type: 'custom_tool_call_output', call_id: 'patch_two', output: 'done' }], tools });
  const message = assistants(request)[0];
  assert.equal(message.reasoning_content, 'plan');
  assert.deepEqual(message.tool_calls.map(tool => tool.id), ['patch_one', 'patch_two']);
  assert.deepEqual(message.tool_calls.map(tool => JSON.parse(tool.function.arguments)), [{ input: 'patch one' }, { input: 'patch two' }]);
  assert.ok(message.tool_calls.every(tool => tool.function.name === 'functions__patch'));
});

test('Codex Chat JSON response readable reasoning survives message and tool round-trip', () => {
  const response = bridge.chatJsonToResponses({ choices: [{ message: { reasoning_content: 'exact plan', content: 'status',
    tool_calls: [{ id: 'one', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }, 'deepseek-test');
  const replay = convert([user('q'), ...response.output, result('one')]);
  assert.equal(assistants(replay).length, 1);
  assert.equal(assistants(replay)[0].reasoning_content, 'exact plan');
  assert.equal(assistants(replay)[0].content, 'status');
});

test('Codex Chat streaming reasoning survives split deltas and parallel tool replay', async () => {
  const upstream = new PassThrough();
  const sink = { writeHead() {}, write() {}, end() {} };
  let response;
  bridge.streamChatAsResponses(upstream, sink, 'deepseek-test', (usage, completion) => { response = completion; });
  const frame = value => `data: ${JSON.stringify(value)}\n\n`;
  upstream.write(frame({ choices: [{ delta: { reasoning_content: 'first ' } }] }));
  upstream.write(frame({ choices: [{ delta: { reasoning_content: 'second', content: 'status', tool_calls: [
    { index: 0, id: 'one', function: { name: 'read', arguments: '{}' } },
    { index: 1, id: 'two', function: { name: 'read', arguments: '{}' } },
  ] } }] }));
  upstream.end('data: [DONE]\n\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.status, 'completed');
  const replay = convert([user('q'), ...response.output, result('one'), result('two')]);
  assert.equal(assistants(replay).length, 1);
  assert.equal(assistants(replay)[0].reasoning_content, 'first second');
  assert.equal(assistants(replay)[0].tool_calls.length, 2);
});

test('Codex Chat streaming errors preserve upstream message and code without reporting success', async () => {
  for (const error of [
    { code: 'invalid_request_error', message: 'This response_format type is unavailable now' },
    { code: 'insufficient_quota', message: 'Insufficient quota' },
    { code: 429, message: 'Token rate limit exceeded' },
    { message: 'Upstream rejected the request' },
  ]) {
    const upstream = new PassThrough();
    const sink = { text: '', writeHead() {}, write(chunk) { this.text += chunk; }, end() {} };
    let response;
    bridge.streamChatAsResponses(upstream, sink, 'deepseek-test', (usage, completion) => { response = completion; });
    upstream.end(`data: ${JSON.stringify({ error })}\n\n`);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(response.status, 'failed');
    assert.deepEqual(response.error, { code: error.code ?? 'upstream_stream_error', message: error.message });
    assert.deepEqual(response.output, []);
    assert.equal(sink.text.includes('"type":"response.completed"'), false);
    const failed = sink.text.split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6))).find(event => event.type === 'response.failed');
    assert.deepEqual(failed.response.error, response.error);
  }
});

test('Codex Chat reasoning fix preserves structured output schema and model selection', () => {
  const format = { type: 'json_schema', name: 'result', strict: true,
    schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } };
  const request = bridge.responsesToChat({ model: 'unchanged-model', input: [user('q'), thought('plan'), call('one')],
    reasoning: { effort: 'high' }, text: { format } });
  assert.equal(request.model, 'unchanged-model');
  assert.equal(request.reasoning_effort, 'high');
  assert.deepEqual(request.response_format, { type: 'json_schema', json_schema: { name: format.name, strict: true, schema: format.schema } });
});
