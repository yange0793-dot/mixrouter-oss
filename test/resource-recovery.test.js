'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { resourceBindingError, portableHistory } = require('../lib/resource-recovery');

const hash = body => createHash('sha256').update(JSON.stringify(body)).digest('hex');
const history = () => ({ model: 'client-alias', stream: true, prompt_cache_key: 'keep-cache',
  metadata: { session_id: 'keep-session' }, include: ['reasoning.encrypted_content'],
  input: [
    { role: 'user', content: [{ type: 'input_text', text: 'read this file' }] },
    { type: 'reasoning', id: 'rs-resource', encrypted_content: 'opaque-reasoning',
      content: [{ type: 'reasoning_text', text: 'original thought' }], summary: [] },
    { type: 'message', id: 'msg-resource', role: 'assistant', content: [{ type: 'output_text', text: 'original text', annotations: [] }] },
    { type: 'function_call', id: 'fc-resource', call_id: 'call-semantic', name: 'Read', arguments: '{"file":"input.txt"}' },
    { type: 'function_call_output', call_id: 'call-semantic', output: [{ type: 'input_text', text: 'original tool result' }] },
  ], tools: [{ type: 'function', name: 'Read', parameters: { type: 'object' } }] });

function freeze(value) {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

test('native Responses projection strips every proven output item id, not reasoning or tool content', () => {
  const body = freeze(history()), before = hash(body);
  const result = portableHistory(body, 'responses');
  assert.equal(result.supported, true); assert.equal(result.changed, true);
  assert.notEqual(result.body, body); assert.equal(hash(body), before);
  assert.equal(result.body.model, 'client-alias');
  assert.equal(result.body.prompt_cache_key, 'keep-cache');
  assert.deepEqual(result.body.metadata, body.metadata);
  assert.deepEqual(result.body.include, body.include);
  assert.deepEqual(result.body.tools, body.tools);
  for (let i = 0; i < body.input.length; i++) {
    const { id, ...expected } = body.input[i];
    assert.deepEqual(result.body.input[i], expected);
  }
  assert.equal(result.body.input[1].encrypted_content, 'opaque-reasoning');
  assert.equal(result.body.input[3].call_id, 'call-semantic');
  assert.equal(result.body.input[4].call_id, 'call-semantic');
  assert.equal(portableHistory(result.body, 'responses').changed, false, 'projection cannot invent a second recovery');
});

test('previous_response_id always refuses recovery: inline messages cannot prove complete referenced history', () => {
  const body = { ...history(), previous_response_id: 'resp-resource' }, before = hash(body);
  const result = portableHistory(body, 'responses');
  assert.equal(result.supported, false); assert.equal(result.reason, 'reference_only_history');
  assert.equal(result.body, body); assert.equal(hash(body), before);
  assert.equal(body.previous_response_id, 'resp-resource');
  for (const input of [undefined, [], 'new prompt', [{ role: 'user', content: 'new prompt' }], history().input,
    [{ type: 'reasoning', id: 'rs-old', encrypted_content: 'opaque' }]]) {
    const value = { previous_response_id: 'resp-old', input };
    const refused = portableHistory(value, 'responses');
    assert.equal(refused.supported, false); assert.equal(refused.changed, false);
    assert.equal(refused.body, value);
  }
});

test('item_reference and conversation are never deleted to fabricate missing history', () => {
  for (const body of [
    { ...history(), input: [...history().input, { type: 'item_reference', id: 'rs-resource' }] },
    { ...history(), conversation: 'conv-old' },
  ]) {
    const before = hash(body), result = portableHistory(body, 'responses');
    assert.equal(result.reason, 'reference_only_history');
    assert.equal(result.supported, false); assert.equal(result.body, body); assert.equal(hash(body), before);
  }
});

test('incomplete tool pairs, unknown ids and malformed history do not get lossy projections', () => {
  const bodies = [
    { input: [{ type: 'function_call_output', call_id: 'missing', output: 'result' }, ...history().input] },
    { input: [...history().input, { type: 'function_call', id: 'fc-new', call_id: 'bad', name: 'Read' }] },
    { input: history().input.filter(item => item.type !== 'function_call_output') },
    { input: [...history().input, history().input.at(-1)] },
    { input: [...history().input, { type: 'unknown_item', id: 'unknown' }] },
    { input: [null, ...history().input] },
    { input: [{ type: 'message', id: 'msg', role: 'assistant' }] },
  ];
  for (const body of bodies) {
    const before = hash(body), result = portableHistory(body, 'responses');
    assert.equal(result.supported, false); assert.equal(result.body, body); assert.equal(hash(body), before);
  }
});

test('Chat/Anthropic/compact have no proven resource projection and preserve signatures/tool IDs', () => {
  for (const kind of ['messages', 'chat/completions', 'responses/compact', undefined]) {
    const body = { ...history(), messages: [{ role: 'assistant', content: [
      { type: 'thinking', signature: 'keep-signature', thinking: 'original thought' },
      { type: 'tool_use', id: 'tool-semantic', name: 'Read', input: {} },
    ] }] };
    const result = portableHistory(body, kind);
    assert.equal(result.supported, false); assert.equal(result.reason, 'unsupported_protocol');
    assert.equal(result.body, body);
  }
});

test('no resources and invalid bodies are not modified', () => {
  for (const body of [null, undefined, false, [], {}, { input: 'hello' }, { input: [{ role: 'user', content: 'hello' }] }]) {
    const result = portableHistory(body, 'responses');
    assert.equal(result.changed, false); assert.equal(result.supported, false); assert.equal(result.body, body);
  }
});

test('exact observed Azure resource error matches HTTP JSON and SSE envelopes without requiring a code', () => {
  const message = 'The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it.';
  const error = { message, type: 'invalid_request_error', code: null };
  for (const value of [{ error }, JSON.stringify({ error }), { type: 'error', error },
    { type: 'error', message, code: null }, { type: 'response.failed', response: { error } },
    { status: 'failed', error }, { error: { message, code: 'upstream_error' } }]) {
    assert.equal(resourceBindingError(value), true);
  }
  for (const suffix of [' [trace_id=fixture-trace-001]',
    ' (request id: fixture-request-001) [trace_id=fixture-trace-002]']) {
    assert.equal(resourceBindingError({ error: { ...error, message: message + suffix } }), true);
  }
  for (const suffix of [' [trace_id=]', ' [trace_id=fixture] extra',
    ' (request id: missing-trace)', ' (request id: fixture) [trace_id=fixture]\nignored']) {
    assert.equal(resourceBindingError({ error: { ...error, message: message + suffix } }), false);
  }
  for (const value of [{ message }, { type: 'response.output_text.delta', delta: message },
    { error: { message: message + ' extra' } }, { error: { message: message.toLowerCase() } },
    { error: { message: 'The requested item was created under a different Azure OpenAI resource.' } }]) {
    assert.equal(resourceBindingError(value), false);
  }
});

test('ordinary schema/auth/quota errors, malformed JSON and prompt text never trigger recovery', () => {
  for (const error of [null, {}, [], 'bad json', { message: 'resource mismatch' },
    { error: { message: 'Invalid schema for function Read', type: 'invalid_request_error' } },
    { error: { message: 'Incorrect API key', code: 'invalid_api_key' } },
    { error: { message: 'Quota exceeded', code: 'insufficient_quota' } },
    { error: { message: 'resource mismatch', code: 'invalid_request_error' } },
    { type: 'response.output_text.delta', delta: 'Azure resource mismatch' },
  ]) assert.equal(resourceBindingError(error), false);
});
