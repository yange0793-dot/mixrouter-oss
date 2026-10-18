'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const bridge = require('../lib/wire-openai-bridge');
const tools = require('../lib/codex-tools');

const declared = [{ type: 'namespace', name: 'functions', tools: [
  { type: 'custom', name: 'apply_patch', description: 'Apply a patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: "patch"' } },
  { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } }, strict: false },
] }];
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const delta = value => frame({ choices: [{ delta: value }] });

async function stream(chunks, request = {}, error = false) {
  const upstream = new PassThrough();
  const response = { text: '', ended: false,
    writeHead(code, headers) { this.code = code; this.headers = headers; },
    write(text) { this.text += text; }, end(text = '') { this.text += text; this.ended = true; } };
  let final;
  bridge.streamChatAsResponses(upstream, response, 'model', (usage, completion) => { final = completion; }, {}, request);
  for (const chunk of chunks) upstream.write(chunk);
  if (error) upstream.emit('error', new Error('broken')); else upstream.end();
  await new Promise(resolve => setImmediate(resolve));
  const events = response.headers?.['Content-Type'] === 'text/event-stream'
    ? response.text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))) : [];
  return { response, final, events };
}

test('Codex preserves max reasoning, namespace tools, custom tools and structured output', () => {
  const request = bridge.responsesToChat({ model: 'model', input: 'q', tools: declared, reasoning: { effort: 'max' },
    tool_choice: { type: 'custom', namespace: 'functions', name: 'apply_patch' },
    text: { format: { type: 'json_schema', name: 'result', schema: { type: 'object' }, strict: true } } });
  assert.equal(request.reasoning_effort, 'max');
  assert.equal(request.tools.length, 2);
  assert.equal(request.tools[0].function.parameters.properties.input.type, 'string');
  assert.equal(request.tool_choice.function.name, request.tools[0].function.name);
  assert.equal(request.tools[1].function.strict, false);
  assert.equal(request.response_format.json_schema.name, 'result');
});

test('Codex custom tool calls round-trip raw input and namespace', () => {
  const book = tools.registry(declared);
  const spec = [...book.byName.values()].find(item => item.type === 'custom');
  const input = '*** Begin Patch\n*** End Patch';
  const converted = bridge.chatJsonToResponses({ choices: [{ message: { tool_calls: [{ id: 'call_patch', function: { name: spec.chatName, arguments: JSON.stringify({ input }) } }] } }] }, 'model', { tools: declared });
  assert.equal(converted.output[0].type, 'custom_tool_call');
  assert.equal(converted.output[0].input, input);
  assert.equal(converted.output[0].namespace, 'functions');
  const replay = bridge.responsesToChat({ model: 'model', tools: declared, input: [{ role: 'user', content: 'q' }, ...converted.output,
    { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'applied' }] });
  assert.equal(replay.messages[1].tool_calls[0].function.arguments, JSON.stringify({ input }));
  assert.equal(replay.messages[2].tool_call_id, 'call_patch');
});

test('Codex reasoning replay and parallel calls share one assistant turn', () => {
  const request = bridge.responsesToChat({ input: [{ role: 'user', content: 'q' },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'plan' }] },
    { type: 'function_call', call_id: 'one', name: 'first', arguments: '{}' },
    { type: 'function_call', call_id: 'two', name: 'second', arguments: '{}' },
    { type: 'function_call_output', call_id: 'one', output: 'ok' },
    { type: 'function_call_output', call_id: 'two', output: 'ok' }] });
  assert.deepEqual(request.messages.map(item => item.role), ['user', 'assistant', 'tool', 'tool']);
  assert.equal(request.messages[1].tool_calls.length, 2);
  assert.equal(request.messages[1].reasoning_content, 'plan');
});

test('Codex tool namespace collisions are deterministic and fit Chat name limits', () => {
  const declaredTools = [...declared, { type: 'function', name: 'functions__apply_patch' },
    { type: 'namespace', name: 'very-long-namespace'.repeat(7), tools: [{ type: 'function', name: 'read' }] }];
  const names = tools.definitions(tools.registry(declaredTools)).map(item => item.function.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every(name => /^[a-zA-Z0-9_-]{1,64}$/.test(name)));
  assert.deepEqual(names, tools.definitions(tools.registry(declaredTools)).map(item => item.function.name));
});

test('Codex images keep object URLs and detail', () => {
  const request = bridge.responsesToChat({ input: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aA==', detail: 'high' } }] }] });
  assert.equal(request.messages[0].content[0].image_url.detail, 'high');
});

test('Codex streaming decodes split UTF-8, includes reasoning and reasoning tokens', async () => {
  const bytes = Buffer.from(delta({ reasoning_content: '中文🚀' }));
  const offset = bytes.indexOf(Buffer.from('中文')) + 1;
  const result = await stream([bytes.subarray(0, offset), bytes.subarray(offset), delta({ content: 'done' }),
    frame({ choices: [{ finish_reason: 'stop', delta: {} }], usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16, completion_tokens_details: { reasoning_tokens: 5 } } })]);
  assert.equal(result.final.status, 'completed');
  assert.equal(result.final.output[0].summary[0].text, '中文🚀');
  assert.equal(result.final.usage.output_tokens_details.reasoning_tokens, 5);
  assert.ok(result.events.some(event => event.type === 'response.reasoning_summary_text.delta'));
});

test('Codex streaming emits custom call input events and never executes partial JSON', async () => {
  const name = [...tools.registry(declared).byName.values()][0].chatName;
  const good = await stream([delta({ tool_calls: [{ index: 0, id: 'patch', function: { name, arguments: '{"input":"patch"}' } }] }), 'data: [DONE]'], { tools: declared });
  assert.equal(good.final.output[0].type, 'custom_tool_call');
  assert.ok(good.events.some(event => event.type === 'response.custom_tool_call_input.done' && event.input === 'patch'));
  const bad = await stream([delta({ tool_calls: [{ index: 0, function: { name, arguments: '{"input":' } }] }), 'data: [DONE]\n\n'], { tools: declared });
  assert.equal(bad.final.status, 'failed');
  assert.deepEqual(bad.final.output, []);
});

test('Codex truncation and disconnects are not reported as completed', async () => {
  const incomplete = await stream([delta({ content: 'partial' }), frame({ choices: [{ delta: {}, finish_reason: 'length' }] }), 'data: [DONE]\n\n']);
  assert.equal(incomplete.final.status, 'incomplete');
  assert.equal(incomplete.final.incomplete_details.reason, 'max_output_tokens');
  const ended = await stream([delta({ content: 'partial' })]);
  assert.equal(ended.final.status, 'failed');
  const aborted = await stream([delta({ content: 'partial' })], {}, true);
  assert.equal(aborted.final.status, 'failed');
  assert.equal(aborted.events.some(event => event.type === 'response.completed'), false);
});

test('Codex nonstream callers receive JSON even when the Chat upstream streams', async () => {
  const result = await stream([delta({ content: 'ok' }), 'data: [DONE]\n\n'], { stream: false });
  assert.equal(result.response.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(result.response.text).output[0].content[0].text, 'ok');
});

test('Codex JSON translation rejects bad tool arguments and exposes token limits', () => {
  assert.throws(() => bridge.chatJsonToResponses({ choices: [{ message: { tool_calls: [{ function: { name: 'tool', arguments: '{bad' } }] } }] }, 'model'));
  assert.equal(bridge.chatJsonToResponses({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }, 'model').status, 'incomplete');
});
