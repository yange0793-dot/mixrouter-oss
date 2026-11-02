'use strict';
// 请求体上下文构成统计:纯函数、只读,不做任何 I/O,也不保留原文。
//
// 分区口径(全部是 UTF-8 字节数):
//   serialized_bytes = Buffer.byteLength(JSON.stringify(body))
//   system_bytes / tools_bytes / tool_results_bytes / conversation_bytes / media_bytes
//   各自是 JSON 文本里互不重叠的子树(或其叶子字段)的字节数;
//   other_bytes 由总量减出,因此键名、JSON 分隔符、cache_control、未知字段
//   (包括 ciphertext)都落在这里,**各项之和严格等于 serialized_bytes**。
//
// 只对选中的子树调用一次 JSON.stringify:它的结果与整包序列化中对应片段逐字节一致,
// 所以不会出现"字符数不等于序列化字节数"的问题(换行、引号、多字节字符都会被正确转义计数)。
// 整包只序列化一次;每个被统计的节点最多再序列化一次,总体是 O(n)。
//
// estimated_text_tokens 只是按"非媒体字节 / 4"的粗估,**不是**官方 tokenizer,
// 媒体(base64 图片/音频/文件)不计入,避免把大附件算成文本 token。
//
// 输出只有整数和 version,永远不含 prompt、工具名、路径或任何原文。

const VERSION = 1;
const TOKEN_BYTES = 4;

// 供日志侧做白名单 pick:只有这些键可能是数值,其余调用方塞进来的字段(尤其是正文/名字)
// 一律丢弃。数组本身冻结,防止调用方顺手改名把别的东西放进来。
const CONTEXT_FIELDS = Object.freeze([
  'version',
  'serialized_bytes',
  'system_bytes',
  'tools_bytes',
  'tool_results_bytes',
  'conversation_bytes',
  'media_bytes',
  'other_bytes',
  'estimated_text_tokens',
]);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 命中即整块计入 media,不再向下拆分:base64 数据与附件不会进入文本估算。
const MEDIA_TYPES = new Set([
  'image', 'input_image', 'output_image', 'image_url',
  'document', 'file', 'input_file',
  'audio', 'input_audio', 'audio_url',
  'video', 'input_video',
  'computer_screenshot',
]);

function isMedia(part) {
  if (!isObject(part)) return false;
  if (part.type === 'image_generation_call') return typeof part.result === 'string' && part.result !== '';
  return MEDIA_TYPES.has(part.type);
}

function jsonBytes(value) {
  const text = JSON.stringify(value);
  return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
}

function add(counts, category, value) {
  counts[category] += jsonBytes(value);
}

function addText(counts, category, value) {
  if (typeof value === 'string') add(counts, category, value);
}

// 工具调用参数(assistant 生成的内容)算 conversation;null/undefined 等非文本值不猜。
function addCallArguments(counts, value) {
  if (typeof value === 'string') add(counts, 'conversation', value);
  else if (isObject(value) || Array.isArray(value)) add(counts, 'conversation', value);
}

// 工具输出只统计文本部分;嵌在输出里的图片/文件仍归 media。
function countToolResultContent(counts, content) {
  if (typeof content === 'string') {
    add(counts, 'toolResults', content);
    return;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') {
        add(counts, 'toolResults', part);
        continue;
      }
      if (!isObject(part)) continue;
      if (isMedia(part)) {
        add(counts, 'media', part);
        continue;
      }
      if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
        addText(counts, 'toolResults', part.text);
      }
      // tool_reference、cache_control 等标识/未知字段留给 other。
    }
    return;
  }
  if (!isObject(content)) return;
  if (isMedia(content)) {
    add(counts, 'media', content);
    return;
  }
  if (content.type === 'text' || content.type === 'input_text' || content.type === 'output_text') {
    addText(counts, 'toolResults', content.text);
  }
}

function countPart(counts, category, part) {
  if (typeof part === 'string') {
    add(counts, category, part);
    return;
  }
  if (!isObject(part)) return;
  if (isMedia(part)) {
    add(counts, 'media', part);
    return;
  }
  switch (part.type) {
    case 'text':
    case 'input_text':
    case 'output_text':
      addText(counts, category, part.text);
      break;
    case 'thinking':
      addText(counts, category, part.thinking);
      break;
    case 'summary_text':
    case 'reasoning_text':
      addText(counts, category, part.text);
      break;
    case 'tool_use':
      // assistant 的工具调用参数属于对话内容;工具声明本身只在顶层 tools 里统计。
      add(counts, 'conversation', part.input);
      break;
    case 'tool_result':
      countToolResultContent(counts, part.content);
      break;
    default:
      // redacted_thinking.data、tool_reference、cache_control、未知块:留给 other。
      break;
  }
}

// 消息 content:字符串或块数组。块数组里按块类型分流,未知块不猜。
function countContent(counts, category, content) {
  if (typeof content === 'string') {
    add(counts, category, content);
    return;
  }
  if (Array.isArray(content)) {
    for (const part of content) countPart(counts, category, part);
  }
}

function countChatCall(counts, call) {
  if (!isObject(call)) return;
  // 现代 tool_calls 是 {function:{arguments}},旧版 function_call 直接是 {name,arguments}。
  const fn = isObject(call.function) ? call.function : call;
  addCallArguments(counts, fn.arguments);
}

// Anthropic messages 与 Chat messages 共用同一套角色/内容判别。
function countMessages(counts, messages) {
  if (!Array.isArray(messages)) return;
  for (const msg of messages) {
    if (!isObject(msg)) continue;
    const role = msg.role;
    const category = role === 'system' || role === 'developer'
      ? 'system'
      : (role === 'tool' || role === 'function' ? 'toolResults' : 'conversation');
    countContent(counts, category, msg.content);
    if (category !== 'conversation') continue;
    addText(counts, 'conversation', msg.reasoning_content);
    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) countChatCall(counts, call);
    }
    if (isObject(msg.function_call)) countChatCall(counts, msg.function_call);
  }
}

function countResponsesMessage(counts, item) {
  const category = item.role === 'system' || item.role === 'developer'
    ? 'system'
    : 'conversation';
  countContent(counts, category, item.content);
}

// Responses 的 input 既可以是字符串,也可以是 item 数组。
function countResponsesItem(counts, item) {
  if (!isObject(item)) return;
  if (isMedia(item)) {
    add(counts, 'media', item);
    return;
  }
  const type = item.type;
  if (type === 'message' || (type === undefined && item.role !== undefined)) {
    countResponsesMessage(counts, item);
    return;
  }
  switch (type) {
    case 'function_call':
    case 'custom_tool_call':
      addCallArguments(counts, item.arguments !== undefined ? item.arguments : item.input);
      break;
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'local_shell_call_output':
    case 'computer_call_output':
    case 'mcp_call':
      countToolResultContent(counts, item.output);
      break;
    case 'reasoning':
      // summary/content 是明文推理;encrypted_content 是密文,留给 other。
      countContent(counts, 'conversation', item.summary);
      countContent(counts, 'conversation', item.content);
      break;
    default:
      // item_reference、web_search_call、file_search_call 等:不猜,留给 other。
      break;
  }
}

function countInput(counts, input) {
  if (typeof input === 'string') {
    add(counts, 'conversation', input);
    return;
  }
  if (Array.isArray(input)) {
    for (const item of input) countResponsesItem(counts, item);
    return;
  }
  if (isObject(input)) countResponsesItem(counts, input);
}

function zeroCounts() {
  return { system: 0, tools: 0, toolResults: 0, conversation: 0, media: 0 };
}

function summarizeContext(body) {
  const serialized = JSON.stringify(body);
  const serializedBytes = typeof serialized === 'string'
    ? Buffer.byteLength(serialized, 'utf8')
    : 0;

  const counts = zeroCounts();
  if (serializedBytes === 0 || !isObject(body)) {
    return {
      version: VERSION,
      serialized_bytes: serializedBytes,
      system_bytes: 0,
      tools_bytes: 0,
      tool_results_bytes: 0,
      conversation_bytes: 0,
      media_bytes: 0,
      other_bytes: serializedBytes,
      estimated_text_tokens: Math.ceil(serializedBytes / TOKEN_BYTES),
    };
  }

  // 工具声明:整个 tools/functions 数组算 tools_bytes(只统计声明本身)。
  if (Array.isArray(body.tools)) add(counts, 'tools', body.tools);
  if (Array.isArray(body.functions)) add(counts, 'tools', body.functions);

  // Anthropic 顶层 system 与 Responses 顶层 instructions 都是系统指令。
  if (body.system !== undefined) countContent(counts, 'system', body.system);
  if (body.instructions !== undefined) countContent(counts, 'system', body.instructions);

  countMessages(counts, body.messages);
  countInput(counts, body.input);

  const systemBytes = counts.system;
  const toolsBytes = counts.tools;
  const toolResultsBytes = counts.toolResults;
  const conversationBytes = counts.conversation;
  const mediaBytes = counts.media;
  const otherBytes = serializedBytes - systemBytes - toolsBytes - toolResultsBytes
    - conversationBytes - mediaBytes;

  return {
    version: VERSION,
    serialized_bytes: serializedBytes,
    system_bytes: systemBytes,
    tools_bytes: toolsBytes,
    tool_results_bytes: toolResultsBytes,
    conversation_bytes: conversationBytes,
    media_bytes: mediaBytes,
    other_bytes: otherBytes,
    estimated_text_tokens: Math.ceil((serializedBytes - mediaBytes) / TOKEN_BYTES),
  };
}

module.exports = { summarizeContext, CONTEXT_FIELDS };
