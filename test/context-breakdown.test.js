'use strict';
// context-breakdown 的固定数值契约:
//   1. 各分区互不重叠,和严格等于 JSON.stringify(body) 的 UTF-8 字节数;
//   2. 媒体(base64)不进入 estimated_text_tokens;
//   3. 只读、无原文泄漏,未知字段/ciphertext 落 other;
//   4. Anthropic / Chat / Responses 三种协议的字符串、块、工具、结果、图片都覆盖。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeContext, CONTEXT_FIELDS } = require('../lib/observability/context-breakdown');

const jb = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const CATEGORY_KEYS = [
  'system_bytes', 'tools_bytes', 'tool_results_bytes',
  'conversation_bytes', 'media_bytes', 'other_bytes',
];

function assertContract(result, body) {
  assert.deepEqual(Object.keys(result), [...CONTEXT_FIELDS],
    '结果键必须与 CONTEXT_FIELDS 完全一致');
  assert.equal(result.version, 1);
  assert.equal(result.serialized_bytes, jb(body));
  let sum = 0;
  for (const key of CATEGORY_KEYS) {
    const n = result[key];
    assert.ok(Number.isInteger(n) && n >= 0, `${key} 必须是非负整数,实际 ${n}`);
    sum += n;
  }
  assert.equal(sum, result.serialized_bytes, '各分区之和必须等于 serialized_bytes');
  assert.equal(
    result.estimated_text_tokens,
    Math.ceil((result.serialized_bytes - result.media_bytes) / 4),
  );
  for (const value of Object.values(result)) assert.equal(typeof value, 'number');
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

test('CONTEXT_FIELDS 是冻结的固定数值字段清单', () => {
  assert.deepEqual(CONTEXT_FIELDS, [
    'version', 'serialized_bytes', 'system_bytes', 'tools_bytes', 'tool_results_bytes',
    'conversation_bytes', 'media_bytes', 'other_bytes', 'estimated_text_tokens',
  ]);
  assert.equal(Object.isFrozen(CONTEXT_FIELDS), true);
  assert.throws(() => { CONTEXT_FIELDS.push('raw'); }, TypeError);
  assert.equal(CONTEXT_FIELDS.includes('raw'), false);

  const result = summarizeContext({
    messages: [{ role: 'user', content: 'hello' }],
    raw: 'SHOULD_NOT_SURVIVE',
  });
  assert.deepEqual(Object.keys(result), [...CONTEXT_FIELDS]);
  for (const key of CONTEXT_FIELDS) {
    assert.ok(Number.isFinite(result[key]) && result[key] >= 0, `${key} 必须有限且非负`);
  }
  // 模拟日志侧的 pick:只认白名单里的数值,正文/多余字段一律不出现。
  const picked = Object.fromEntries(CONTEXT_FIELDS.map(key => [key, result[key]]));
  assert.deepEqual(Object.keys(picked), [...CONTEXT_FIELDS]);
  assert.equal(JSON.stringify(picked).includes('SHOULD_NOT_SURVIVE'), false);
});

test('Anthropic: system/tools/tool_result/thinking/image 分区精确且原文不外泄', () => {
  const userText = 'SECRET_PROMPT_TEXT inspect /Users/secret/private.txt';
  const system = 'SYSTEM_INSTRUCTION 你是严谨的助手';
  const thinking = 'I should SECRET_THOUGHT read the file.';
  const assistantText = 'Reading SECRET_ASSISTANT_TEXT now.';
  const toolInput = { path: '/Users/secret/private.txt' };
  const toolResultText = 'SECRET_TOOL_OUTPUT file contents';
  const followText = 'What SECRET_FOLLOW next?';
  const image = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1200) },
  };
  const tools = [{
    name: 'SecretToolName',
    description: 'Read SECRET_TOOL_DESC a file',
    input_schema: { type: 'object', properties: { path: { type: 'string' } } },
  }];
  const body = {
    model: 'claude-test',
    max_tokens: 1024,
    system,
    tools,
    tool_choice: { type: 'auto' },
    messages: [
      { role: 'user', content: userText },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking, signature: 'SECRET_SIGNATURE_CIPHERTEXT' },
          { type: 'text', text: assistantText },
          { type: 'tool_use', id: 'toolu_1', name: 'SecretToolName', input: toolInput },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'text', text: toolResultText }, image],
          },
          { type: 'text', text: followText },
        ],
      },
    ],
  };

  const snapshot = JSON.stringify(body);
  const frozen = deepFreeze(clone(body));
  const result = summarizeContext(frozen);

  assertContract(result, body);
  assert.equal(result.system_bytes, jb(system));
  assert.equal(result.tools_bytes, jb(tools), 'tools_choice 不算工具声明');
  assert.equal(result.tool_results_bytes, jb(toolResultText));
  assert.equal(result.media_bytes, jb(image));
  assert.equal(
    result.conversation_bytes,
    jb(userText) + jb(thinking) + jb(assistantText) + jb(toolInput) + jb(followText),
  );
  assert.ok(result.other_bytes > jb('SECRET_SIGNATURE_CIPHERTEXT'));

  assert.equal(JSON.stringify(body), snapshot, '输入不得被修改');
  assert.deepEqual(summarizeContext(clone(body)), result, '同一输入必须得到同一结果');

  const output = JSON.stringify(result);
  for (const secret of [
    'SECRET_PROMPT_TEXT', 'SECRET_THOUGHT', 'SECRET_ASSISTANT_TEXT', 'SECRET_TOOL_OUTPUT',
    'SECRET_FOLLOW', 'SECRET_TOOL_DESC', 'SECRET_SIGNATURE', 'SecretToolName',
    'private.txt', '/Users/secret', 'base64',
  ]) {
    assert.equal(output.includes(secret), false, `输出泄漏了 ${secret}`);
  }
});

test('Anthropic: 图片数据变长只增加 media,不影响文本估算', () => {
  const body = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(100) } },
      ],
    }],
  };
  const bigger = clone(body);
  bigger.messages[0].content[1].source.data = 'B'.repeat(5100);

  const base = summarizeContext(body);
  const grown = summarizeContext(bigger);
  assertContract(base, body);
  assertContract(grown, bigger);
  assert.equal(grown.media_bytes, base.media_bytes + 5000);
  assert.equal(grown.serialized_bytes, base.serialized_bytes + 5000);
  assert.equal(grown.conversation_bytes, base.conversation_bytes);
  assert.equal(grown.other_bytes, base.other_bytes);
  assert.equal(grown.estimated_text_tokens, base.estimated_text_tokens);
});

test('Anthropic: ciphertext 只进 other', () => {
  const body = {
    messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan', signature: 'sig-1' }] },
      { role: 'user', content: [{ type: 'redacted_thinking', data: 'redacted-blob-1' }] },
    ],
  };
  const longer = clone(body);
  longer.messages[0].content[0].signature = 'sig-'.padEnd(501, 'x');
  longer.messages[1].content[0].data = 'redacted-blob-'.padEnd(701, 'y');

  const base = summarizeContext(body);
  const grown = summarizeContext(longer);
  assertContract(base, body);
  assertContract(grown, longer);
  const delta = (grown.serialized_bytes - base.serialized_bytes);
  assert.ok(delta > 0);
  assert.equal(grown.other_bytes, base.other_bytes + delta);
  for (const key of ['system_bytes', 'tools_bytes', 'tool_results_bytes', 'conversation_bytes', 'media_bytes']) {
    assert.equal(grown[key], base[key], `${key} 不应被 ciphertext 影响`);
  }
});

test('Chat: system/developer、工具声明、tool 结果、image_url 分区正确', () => {
  const imagePart = {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,BBBBBBBB' },
  };
  const tools = [{
    type: 'function',
    function: { name: 'search', description: 'find things', parameters: { type: 'object' } },
  }];
  const body = {
    model: 'gpt-test',
    messages: [
      { role: 'system', content: 'Follow the system rules.' },
      { role: 'developer', content: [{ type: 'text', text: 'Developer note.' }] },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Look here' }, imagePart],
      },
      {
        role: 'assistant',
        content: 'Sure.',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'search', arguments: '{"q":"x"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'tool output text' },
    ],
    tools,
    tool_choice: { type: 'function', function: { name: 'search' } },
    stream: true,
  };

  const result = summarizeContext(body);
  assertContract(result, body);
  assert.equal(result.system_bytes, jb('Follow the system rules.') + jb('Developer note.'));
  assert.equal(result.tools_bytes, jb(tools));
  assert.equal(result.media_bytes, jb(imagePart));
  assert.equal(result.tool_results_bytes, jb('tool output text'));
  assert.equal(
    result.conversation_bytes,
    jb('Look here') + jb('Sure.') + jb('{"q":"x"}'),
  );
});

test('Chat: tool 内容数组里的图片归 media,文本归 tool_results', () => {
  const imagePart = { type: 'input_image', image_url: 'data:image/png;base64,CCCC' };
  const body = {
    messages: [{
      role: 'tool',
      tool_call_id: 'call_2',
      content: [{ type: 'text', text: 'command output' }, imagePart],
    }],
  };
  const result = summarizeContext(body);
  assertContract(result, body);
  assert.equal(result.tool_results_bytes, jb('command output'));
  assert.equal(result.media_bytes, jb(imagePart));
  assert.equal(result.conversation_bytes, 0);
  assert.equal(result.system_bytes, 0);
  assert.equal(result.tools_bytes, 0);
});

test('Responses: instructions/input 消息/function_call/输出/reasoning/密文', () => {
  const instructions = 'You are Codex.';
  const developerNote = 'Developer rule.';
  const userText = 'Fix the bug';
  const imageItem = { type: 'input_image', image_url: 'data:image/png;base64,DDDD' };
  const callArgs = '{"cmd":"ls"}';
  const outputText = 'file list';
  const reasoningText = 'Need to list files.';
  const encrypted = 'ENCRYPTED_BLOB_123456';
  const tools = [{ type: 'function', name: 'shell', description: 'run', parameters: { type: 'object' } }];
  const body = {
    model: 'gpt-5',
    instructions,
    tools,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: userText }, imageItem],
      },
      { type: 'function_call', call_id: 'c1', name: 'shell', arguments: callArgs },
      { type: 'function_call_output', call_id: 'c1', output: outputText },
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: reasoningText }],
        encrypted_content: encrypted,
      },
      { type: 'item_reference', id: 'ref_1' },
      { type: 'message', role: 'developer', content: developerNote },
    ],
  };

  const result = summarizeContext(body);
  assertContract(result, body);
  assert.equal(result.system_bytes, jb(instructions) + jb(developerNote));
  assert.equal(result.tools_bytes, jb(tools));
  assert.equal(result.media_bytes, jb(imageItem));
  assert.equal(result.tool_results_bytes, jb(outputText));
  assert.equal(result.conversation_bytes, jb(userText) + jb(callArgs) + jb(reasoningText));
  assert.ok(result.other_bytes > jb(encrypted));

  const longer = clone(body);
  longer.input[3].encrypted_content = encrypted.padEnd(encrypted.length + 800, 'z');
  const grown = summarizeContext(longer);
  assertContract(grown, longer);
  assert.equal(grown.other_bytes, result.other_bytes + 800);
  for (const key of ['system_bytes', 'tools_bytes', 'tool_results_bytes', 'conversation_bytes', 'media_bytes']) {
    assert.equal(grown[key], result[key], `${key} 不应被密文影响`);
  }
});

test('Responses: input 为字符串时归 conversation', () => {
  const input = 'Hello 世界 🙂';
  const body = { model: 'gpt-5', instructions: 'Be brief.', input };
  const result = summarizeContext(body);
  assertContract(result, body);
  assert.equal(result.system_bytes, jb('Be brief.'));
  assert.equal(result.conversation_bytes, jb(input));
  assert.equal(result.tools_bytes, 0);
  assert.equal(result.tool_results_bytes, 0);
  assert.equal(result.media_bytes, 0);
});

test('Anthropic: system 数组只取文本块,cache_control 与未知块进 other', () => {
  const body = {
    system: [
      { type: 'text', text: 'First rule.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Second rule.' },
      { type: 'mystery', payload: 'SPECIAL_UNKNOWN_BLOCK' },
    ],
    messages: [],
  };
  const result = summarizeContext(body);
  assertContract(result, body);
  assert.equal(result.system_bytes, jb('First rule.') + jb('Second rule.'));
  assert.ok(result.other_bytes >= jb('SPECIAL_UNKNOWN_BLOCK'));
  assert.equal(result.conversation_bytes, 0);
});

test('特殊未知字段不猜测,全部落入 other', () => {
  const body = {
    model: 'm',
    messages: [],
    mystery: { huge: 'X'.repeat(10000) },
    metadata: { user_id: 'u-1' },
    some_future_field: [1, 2, 3, { nested: true }],
  };
  const result = summarizeContext(body);
  assertContract(result, body);
  for (const key of ['system_bytes', 'tools_bytes', 'tool_results_bytes', 'conversation_bytes', 'media_bytes']) {
    assert.equal(result[key], 0, `${key} 不应包含未知字段`);
  }
  assert.equal(result.other_bytes, result.serialized_bytes);
});

test('多字节与转义字符按序列化后的 UTF-8 字节计数', () => {
  const text = 'line1\n"quoted"\\slash 中文🙂';
  const body = { messages: [{ role: 'user', content: text }] };
  const result = summarizeContext(body);
  assertContract(result, body);
  assert.equal(result.conversation_bytes, jb(text));
  assert.notEqual(jb(text), Buffer.byteLength(text, 'utf8'), '测试必须能区分原始字节与序列化字节');
  assert.equal(result.media_bytes, 0);
});

test('空对象与非对象输入不抛错,全部字节归 other', () => {
  const empty = summarizeContext({});
  assertContract(empty, {});
  assert.equal(empty.serialized_bytes, 2);
  assert.equal(empty.other_bytes, 2);

  const primitive = summarizeContext('just a string');
  assert.deepEqual(primitive, {
    version: 1,
    serialized_bytes: jb('just a string'),
    system_bytes: 0,
    tools_bytes: 0,
    tool_results_bytes: 0,
    conversation_bytes: 0,
    media_bytes: 0,
    other_bytes: jb('just a string'),
    estimated_text_tokens: Math.ceil(jb('just a string') / 4),
  });
});

test('大请求仍是线性处理且分区守恒', () => {
  const messages = [];
  for (let i = 0; i < 2000; i += 1) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} `.padEnd(120, 'x') });
  }
  const image = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'Q'.repeat(300000) },
  };
  messages.push({ role: 'user', content: [image] });
  const body = { model: 'm', messages, tools: [{ name: 't', input_schema: { type: 'object' } }] };

  const result = summarizeContext(body);
  assertContract(result, body);
  assert.equal(result.media_bytes, jb(image));
  assert.equal(result.tools_bytes, jb(body.tools));
  assert.ok(result.conversation_bytes > 2000 * 100);
});

// ---------------------------------------------------------------- 字节计数等价性
// 参考实现:改动前的 summarizeContext,逐字保留(整包 JSON.stringify + 每个子树再
// stringify 一次)。新实现必须与它在同一组样本上给出完全相同的输出,字段含义
// (尤其 serialized_bytes = 整包序列化后的 UTF-8 字节数)不许有任何偏移。

const REF_VERSION = 1;
const REF_TOKEN_BYTES = 4;
const refIsObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const REF_MEDIA_TYPES = new Set([
  'image', 'input_image', 'output_image', 'image_url',
  'document', 'file', 'input_file',
  'audio', 'input_audio', 'audio_url',
  'video', 'input_video',
  'computer_screenshot',
]);
function refIsMedia(part) {
  if (!refIsObject(part)) return false;
  if (part.type === 'image_generation_call') return typeof part.result === 'string' && part.result !== '';
  return REF_MEDIA_TYPES.has(part.type);
}
function refJsonBytes(value) {
  const text = JSON.stringify(value);
  return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
}
function refAdd(counts, category, value) { counts[category] += refJsonBytes(value); }
function refAddText(counts, category, value) { if (typeof value === 'string') refAdd(counts, category, value); }
function refAddCallArguments(counts, value) {
  if (typeof value === 'string') refAdd(counts, 'conversation', value);
  else if (refIsObject(value) || Array.isArray(value)) refAdd(counts, 'conversation', value);
}
function refCountToolResultContent(counts, content) {
  if (typeof content === 'string') { refAdd(counts, 'toolResults', content); return; }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') { refAdd(counts, 'toolResults', part); continue; }
      if (!refIsObject(part)) continue;
      if (refIsMedia(part)) { refAdd(counts, 'media', part); continue; }
      if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') refAddText(counts, 'toolResults', part.text);
    }
    return;
  }
  if (!refIsObject(content)) return;
  if (refIsMedia(content)) { refAdd(counts, 'media', content); return; }
  if (content.type === 'text' || content.type === 'input_text' || content.type === 'output_text') refAddText(counts, 'toolResults', content.text);
}
function refCountPart(counts, category, part) {
  if (typeof part === 'string') { refAdd(counts, category, part); return; }
  if (!refIsObject(part)) return;
  if (refIsMedia(part)) { refAdd(counts, 'media', part); return; }
  switch (part.type) {
    case 'text': case 'input_text': case 'output_text': refAddText(counts, category, part.text); break;
    case 'thinking': refAddText(counts, category, part.thinking); break;
    case 'summary_text': case 'reasoning_text': refAddText(counts, category, part.text); break;
    case 'tool_use': refAdd(counts, 'conversation', part.input); break;
    case 'tool_result': refCountToolResultContent(counts, part.content); break;
    default: break;
  }
}
function refCountContent(counts, category, content) {
  if (typeof content === 'string') { refAdd(counts, category, content); return; }
  if (Array.isArray(content)) for (const part of content) refCountPart(counts, category, part);
}
function refCountChatCall(counts, call) {
  if (!refIsObject(call)) return;
  const fn = refIsObject(call.function) ? call.function : call;
  refAddCallArguments(counts, fn.arguments);
}
function refCountMessages(counts, messages) {
  if (!Array.isArray(messages)) return;
  for (const msg of messages) {
    if (!refIsObject(msg)) continue;
    const role = msg.role;
    const category = role === 'system' || role === 'developer'
      ? 'system' : (role === 'tool' || role === 'function' ? 'toolResults' : 'conversation');
    refCountContent(counts, category, msg.content);
    if (category !== 'conversation') continue;
    refAddText(counts, 'conversation', msg.reasoning_content);
    if (Array.isArray(msg.tool_calls)) for (const call of msg.tool_calls) refCountChatCall(counts, call);
    if (refIsObject(msg.function_call)) refCountChatCall(counts, msg.function_call);
  }
}
function refCountResponsesMessage(counts, item) {
  const category = item.role === 'system' || item.role === 'developer' ? 'system' : 'conversation';
  refCountContent(counts, category, item.content);
}
function refCountResponsesItem(counts, item) {
  if (!refIsObject(item)) return;
  if (refIsMedia(item)) { refAdd(counts, 'media', item); return; }
  const type = item.type;
  if (type === 'message' || (type === undefined && item.role !== undefined)) { refCountResponsesMessage(counts, item); return; }
  switch (type) {
    case 'function_call': case 'custom_tool_call':
      refAddCallArguments(counts, item.arguments !== undefined ? item.arguments : item.input); break;
    case 'function_call_output': case 'custom_tool_call_output': case 'local_shell_call_output':
    case 'computer_call_output': case 'mcp_call':
      refCountToolResultContent(counts, item.output); break;
    case 'reasoning':
      refCountContent(counts, 'conversation', item.summary);
      refCountContent(counts, 'conversation', item.content); break;
    default: break;
  }
}
function refCountInput(counts, input) {
  if (typeof input === 'string') { refAdd(counts, 'conversation', input); return; }
  if (Array.isArray(input)) { for (const item of input) refCountResponsesItem(counts, item); return; }
  if (refIsObject(input)) refCountResponsesItem(counts, input);
}
function legacySummarizeContext(body) {
  const serialized = JSON.stringify(body);
  const serializedBytes = typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : 0;
  const counts = { system: 0, tools: 0, toolResults: 0, conversation: 0, media: 0 };
  if (serializedBytes === 0 || !refIsObject(body)) {
    return {
      version: REF_VERSION, serialized_bytes: serializedBytes, system_bytes: 0, tools_bytes: 0,
      tool_results_bytes: 0, conversation_bytes: 0, media_bytes: 0, other_bytes: serializedBytes,
      estimated_text_tokens: Math.ceil(serializedBytes / REF_TOKEN_BYTES),
    };
  }
  if (Array.isArray(body.tools)) refAdd(counts, 'tools', body.tools);
  if (Array.isArray(body.functions)) refAdd(counts, 'tools', body.functions);
  if (body.system !== undefined) refCountContent(counts, 'system', body.system);
  if (body.instructions !== undefined) refCountContent(counts, 'system', body.instructions);
  refCountMessages(counts, body.messages);
  refCountInput(counts, body.input);
  const otherBytes = serializedBytes - counts.system - counts.tools - counts.toolResults
    - counts.conversation - counts.media;
  return {
    version: REF_VERSION, serialized_bytes: serializedBytes, system_bytes: counts.system,
    tools_bytes: counts.tools, tool_results_bytes: counts.toolResults,
    conversation_bytes: counts.conversation, media_bytes: counts.media, other_bytes: otherBytes,
    estimated_text_tokens: Math.ceil((serializedBytes - counts.media) / REF_TOKEN_BYTES),
  };
}

const EQUIVALENCE_SAMPLES = [
  {},
  [],
  'top string',
  42,
  true,
  null,
  undefined,
  { model: 'm', messages: [{ role: 'user', content: 'hello' }] },
  { system: 'sys\n"quoted"\\slash\u0000\u001f', messages: [{ role: 'user', content: 'x' }] },
  { messages: [{ role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD'.repeat(4096) } },
    { type: 'text', text: '看图' },
  ] }] },
  { messages: [{ role: 'assistant', content: [
    { type: 'thinking', thinking: '想' }, { type: 'text', text: '\u2028\u2029🙂\ud83d\ude00' },
    { type: 'tool_use', id: 't1', name: 'T', input: { a: [1, 2, { b: null }] } },
  ] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
    { type: 'text', text: '结果' }, { type: 'image', source: { type: 'base64', data: 'AAAA' } },
  ] }] }] },
  { tools: [{ name: 'T', description: '多字节 😀', input_schema: { type: 'object', properties: { x: { type: 'string' } } } }],
    functions: [{ name: 'F', parameters: {} }], tool_choice: { type: 'tool', name: 'T' } },
  { input: 'plain', instructions: ['a', 'b', { type: 'text', text: 'c' }] },
  { input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '规则' }] },
    { type: 'function_call', call_id: 'c1', name: 'T', arguments: '{"a":1}' },
    { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'ok' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: '想了想' }], encrypted_content: 'cipher' },
    { type: 'unknown_item', payload: { big: 'x'.repeat(100) } },
  ] },
  { messages: [{ role: 'tool', content: [{ type: 'text', text: 'tool out' }] },
               { role: 'assistant', content: 'a', reasoning_content: 'r', tool_calls: [{ function: { name: 'T', arguments: '{}' } }] }] },
  { model: 'm', n: NaN, inf: Infinity, neg: -0, exp: 1e21, tiny: 1e-7, float: 0.1 + 0.2,
    t: true, f: false, nil: null, arr: [1, 'two', null, false, { deep: ['x'] }] },
  { 'key\nwith"escapes': 'v', '中文键': '值', '😀': '🙂' },
  JSON.parse('{"a":[1,2,{"b":null}],"c":"\\u00e9\\u4f60"}'),
];

test('新实现与旧实现在全部样本上逐字段一致(含引号/逗号/转义/多字节)', () => {
  for (const [index, body] of EQUIVALENCE_SAMPLES.entries()) {
    assert.deepEqual(summarizeContext(body), legacySummarizeContext(body), `样本 ${index} 输出必须逐字段一致`);
  }
});

test('无法逐字节等价的结构回退到 stringify,数字不被静默改动', () => {
  // Date/toJSON/包装对象/类实例:新实现走回退路径,必须与旧实现给出相同结果
  class Custom { constructor() { this.a = 1; } }
  for (const body of [
    { at: new Date(0), messages: [{ role: 'user', content: 'x' }] },
    { boxed: new Number(5), text: new String('a'), flag: new Boolean(false) },
    { custom: new Custom() },
    { list: [{ toJSON() { return { replaced: true }; } }] },
  ]) {
    assert.deepEqual(summarizeContext(body), legacySummarizeContext(body));
  }
  // 循环引用:两边都按 JSON.stringify 的 TypeError 失败,不静默给数字
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.throws(() => summarizeContext(cyclic), TypeError);
  assert.throws(() => legacySummarizeContext(cyclic), TypeError);
  // BigInt 同理
  assert.throws(() => summarizeContext({ big: 123n }), TypeError);
  assert.throws(() => legacySummarizeContext({ big: 123n }), TypeError);
});

test('大 body(含 base64 媒体)不再调用 JSON.stringify,且输出与旧实现一致', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png',
    data: 'Q'.repeat(2 * 1024 * 1024) } };
  const body = { model: 'm', messages: [
    { role: 'user', content: [{ type: 'text', text: '看这张图 ' + 'x'.repeat(50000) }, image] },
  ], tools: [{ name: 't', input_schema: { type: 'object' } }] };

  const expected = legacySummarizeContext(body); // 参考值在打桩前算好
  assertContract(expected, body);
  assert.ok(expected.serialized_bytes > 2 * 1024 * 1024);

  const realStringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = function counted(...args) { calls += 1; return realStringify.apply(this, args); };
  let actual;
  try { actual = summarizeContext(body); } finally { JSON.stringify = realStringify; }

  assert.equal(calls, 0, `统计大 body 不得再整包序列化,实际调用 JSON.stringify ${calls} 次`);
  assert.deepEqual(actual, expected);
});
