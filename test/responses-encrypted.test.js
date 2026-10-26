'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isEncryptedReasoningError, projectEncryptedReasoning } = require('../lib/responses-encrypted');

const encryptedError = () => ({ error: { type: 'invalid_request_error', code: 'invalid_encrypted_content',
  message: 'The encrypted content could not be verified.', param: 'input' } });
const failed = () => ({ type: 'response.failed', response: { id: 'failed-response', object: 'response',
  status: 'failed', output: [], ...encryptedError() } });
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
function history() {
  const tools = [{ type: 'function', name: 'Read', strict: false, parameters: { type: 'object',
    properties: { file: { type: 'string' } }, required: ['file'] } }];
  return { model: 'fixture-model', stream: true, store: false, prompt_cache_key: 'cache-kept',
    reasoning: { effort: 'max', summary: 'detailed' }, include: ['reasoning.encrypted_content'],
    metadata: { id: 'metadata-kept' }, tools, input: [
      { role: 'developer', content: 'Continue with complete inline history.' },
      { type: 'message', id: 'msg-old', role: 'assistant', phase: 'commentary', status: 'completed',
        content: [{ type: 'output_text', text: 'Earlier answer.', annotations: [] }] },
      { type: 'reasoning', id: 'rs-empty', summary: [], content: null, encrypted_content: 'EMPTY_SUMMARY_CIPHER' },
      { type: 'reasoning', id: 'rs-readable', summary: [{ type: 'summary_text', text: 'Readable summary.' }],
        content: [{ type: 'reasoning_text', text: 'Readable thought.' }], encrypted_content: 'READABLE_CIPHER' },
      { type: 'function_call', id: 'fc-old', call_id: 'call-kept', name: 'Read', arguments: '{"file":"input.txt"}' },
      { type: 'function_call_output', id: 'fco-old', call_id: 'call-kept', output: [
        { type: 'input_text', text: '{"id":"payload-id-kept"}' },
        { type: 'input_image', image_url: 'data:image/png;base64,RklYVFVSRQ==' },
      ] },
      { type: 'additional_tools', role: 'developer', tools: [
        { type: 'custom', name: 'echo_fixture', format: { type: 'text' } },
      ] },
      { type: 'custom_tool_call', call_id: 'custom-kept', name: 'echo_fixture', input: 'fixture', status: 'completed' },
      { type: 'custom_tool_call_output', call_id: 'custom-kept', output: 'fixture', status: 'completed' },
      { role: 'user', content: 'Continue.' },
    ] };
}

for (const status of [200, 201, 299, 400]) test(`structured encrypted-content code matches only safe HTTP${status} failure`, () => {
  const payload = encryptedError();
  for (const value of [payload, { type: 'error', ...payload }, failed(), failed().response]) {
    assert.equal(isEncryptedReasoningError(value, status), true, JSON.stringify(value));
  }
});

test('encrypted matcher defaults to HTTP200 and requires a structured string message', () => {
  assert.equal(isEncryptedReasoningError({ error: { code: 'invalid_encrypted_content', message: 'fixture' } }), true);
  assert.equal(isEncryptedReasoningError({ error: { code: 'invalid_encrypted_content' } }), false);
  assert.equal(isEncryptedReasoningError({ error: { code: 'invalid_encrypted_content', message: null } }), false);
});

test('encrypted matcher refuses prose guesses, other statuses, output, unknown fields and other errors', () => {
  const payload = encryptedError();
  for (const status of [0, 199, 300, 401, 403, 408, 429, 500, 503]) {
    assert.equal(isEncryptedReasoningError(payload, status), false, `HTTP${status}`);
  }
  const outputFailure = failed(); outputFailure.response.output = [{ type: 'message', content: [] }];
  const unknownFailure = failed(); unknownFailure.response.opaque_output = 'cannot discard';
  for (const value of [null, [], 'invalid_encrypted_content', { error: { message: 'invalid_encrypted_content' } },
    { error: { ...payload.error, code: 'invalid_request_error' } },
    { error: { ...payload.error, code: 'INVALID_ENCRYPTED_CONTENT' } },
    { error: { ...payload.error, opaque_output: 'cannot discard' } },
    { ...payload, opaque_output: 'cannot discard' }, { ...payload, output: [] },
    { type: 'response.completed', response: failed().response }, outputFailure, unknownFailure,
    { ...failed().response, output_text: ' ' }, { ...payload, choices: [{ text: 'visible' }] },
  ]) assert.equal(isEncryptedReasoningError(value), false, JSON.stringify(value));
});

test('downgrade removes only encrypted reasoning IDs without mutating complete inline history', () => {
  const body = freeze(history()), original = structuredClone(body), result = projectEncryptedReasoning(body);
  assert.equal(result.ok, true, result.code); assert.equal(result.lossy, true);
  assert.equal(result.removedEncrypted, 2); assert.equal(result.removedIds, 2); assert.equal(result.droppedReasoning, 1);
  const expected = structuredClone(original);
  expected.input = expected.input.filter(item => item.id !== 'rs-empty');
  for (const item of expected.input) if (item.type === 'reasoning' && Object.hasOwn(item, 'encrypted_content')) {
    delete item.id; delete item.encrypted_content;
  }
  assert.deepEqual(result.body, expected); assert.deepEqual(body, original);
  assert.equal(result.body.reasoning.effort, 'max'); assert.equal(result.body.tools[0].strict, false);
  assert.equal(result.body.input.find(item => item.type === 'function_call').call_id, 'call-kept');
  assert.deepEqual(result.body.input.find(item => item.type === 'function_call_output').output, original.input[5].output);
});

test('nullable reasoning content is accepted and empty encrypted reasoning is removed', () => {
  const body = history(); body.input[3].content = null;
  const result = projectEncryptedReasoning(body);
  assert.equal(result.ok, true, result.code);
  assert.equal(result.body.input.filter(item => item.type === 'reasoning').length, 1);
  assert.deepEqual(result.body.input.find(item => item.type === 'reasoning').summary, body.input[3].summary);
});

test('function and custom call namespaces are accepted and retained unchanged', () => {
  const body = history(); body.input[4].namespace = 'fixture_functions'; body.input[7].namespace = 'fixture_custom';
  const original = structuredClone(body), result = projectEncryptedReasoning(body);
  assert.equal(result.ok, true, result.code); assert.deepEqual(body, original);
  assert.equal(result.body.input.find(item => item.type === 'function_call').namespace, 'fixture_functions');
  assert.equal(result.body.input.find(item => item.type === 'custom_tool_call').namespace, 'fixture_custom');
});

test('custom and additional tool IDs are preserved when present and need not be synthesized when absent', () => {
  const body = history();
  for (const item of body.input) if (['additional_tools', 'custom_tool_call', 'custom_tool_call_output'].includes(item.type)) item.id = `${item.type}-kept`;
  const result = projectEncryptedReasoning(body); assert.equal(result.ok, true, result.code);
  for (const item of result.body.input.filter(item => ['additional_tools', 'custom_tool_call', 'custom_tool_call_output'].includes(item.type))) {
    assert.equal(item.id, `${item.type}-kept`);
  }
});

for (const [name, mutate] of [
  ['previous response reference', body => { body.previous_response_id = 'server-only'; }],
  ['conversation reference', body => { body.conversation = { id: 'server-only' }; }],
  ['item reference', body => { body.input.push({ type: 'item_reference', id: 'server-only' }); }],
  ['compaction item', body => { body.input.push({ type: 'compaction', encrypted_content: 'server-only' }); }],
  ['context compaction', body => { body.context_compaction = { enabled: true }; }],
  ['unknown item', body => { body.input.push({ type: 'opaque_item', value: 'cannot discard' }); }],
  ['unknown message field', body => { body.input[1].opaque_history = 'cannot discard'; }],
  ['unknown reasoning field', body => { body.input[2].opaque_history = 'cannot discard'; }],
  ['nullable encrypted field', body => { body.input[2].encrypted_content = null; }],
  ['empty encrypted field', body => { body.input[2].encrypted_content = ''; }],
  ['nullable reasoning summary', body => { body.input[2].summary = null; }],
  ['unknown content field', body => { body.input[1].content[0].opaque_history = 'cannot discard'; }],
  ['unknown tool output field', body => { body.input[5].opaque_history = 'cannot discard'; }],
  ['unknown tool schema field', body => { body.input[6].tools[0].opaque_history = 'cannot discard'; }],
  ['reference output without an item ID', body => { delete body.input[5].id; body.input[5].output = [{ type: 'input_image', file_id: 'server-only' }]; }],
  ['object tool output', body => { delete body.input[5].id; body.input[5].output = { id: 'server-only' }; }],
  ['malformed output array', body => { body.input[5].output.push({ type: 'unknown', value: 'cannot discard' }); }],
  ['missing function output', body => { body.input.splice(5, 1); }],
  ['missing custom output', body => { body.input.splice(8, 1); }],
  ['duplicate call', body => { body.input.push(structuredClone(body.input[4])); }],
  ['duplicate output', body => { body.input.push(structuredClone(body.input[5])); }],
  ['unpaired output', body => { body.input[5].call_id = 'missing-call'; }],
  ['unfinished call', body => { body.input[4].status = 'in_progress'; }],
  ['empty function namespace', body => { body.input[4].namespace = ''; }],
  ['nullable custom namespace', body => { body.input[7].namespace = null; }],
]) test(`strict downgrade refuses ${name} without changing original body`, () => {
  const body = history(); mutate(body); const original = structuredClone(body), result = projectEncryptedReasoning(body);
  assert.equal(result.ok, false, name); assert.equal(typeof result.code, 'string');
  assert.deepEqual(body, original); assert.equal(result.body, undefined);
});

test('no encrypted field cannot manufacture a lossy retry', () => {
  const body = history(); body.input = body.input.filter(item => item.type !== 'reasoning');
  const result = projectEncryptedReasoning(body); assert.equal(result.ok, false); assert.equal(typeof result.code, 'string');
});
