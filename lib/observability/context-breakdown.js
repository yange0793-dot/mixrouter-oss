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
// 字节数由**一次结构遍历**算出,不再为统计生成整份 JSON 字符串:每个子树的结果
// 与整包序列化中对应片段逐字节一致(引号、逗号、转义、多字节字符都按
// JSON.stringify 的规则计),所以分区守恒不变。大请求(带 base64 媒体的 2MB body)
// 以前每个请求都要在事件循环上多出整份字符串,现在只在叶子字符串上走 Buffer.byteLength。
// 无法逐字节等价的结构(Date/toJSON/包装对象/类实例/环/BigInt 等)整棵回退到一次
// JSON.stringify —— 宁可多序列化一次,也不静默改数字。
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

// ---------------------------------------------------------------------------
// 与 JSON.stringify 逐字节等价的字节计数
//
// 规则按 JSON.stringify 的实际输出实现:
//   · 字符串:普通字符按 UTF-8 长度;`"`、`\`、五个短转义(\b\t\n\f\r)各 2 字节;
//     其余控制字符与孤立代理项按 `\uXXXX` 计 6 字节(合法代理对原样输出);
//   · 数字:有限数按 ToString 的字面长度,NaN/±Infinity 与 JSON 一致写成 null(4);
//   · true/false/null 固定长度;
//   · 对象只算自己的可枚举字符串键(键同样按字符串转义计),undefined/函数/symbol
//     属性被省略;数组里的这些值写成 null(空洞也是 null)。
// 只走 JSON.parse 会产出的普通对象/数组;其余结构(含 toJSON、包装对象、类实例,
// 以及循环引用)抛 UNSUPPORTED,交给调用方回退到一次 JSON.stringify。
// ---------------------------------------------------------------------------

const UNSUPPORTED = Symbol('json-bytes-unsupported');

// 没有这些字符时整串直接走一次 Buffer.byteLength(最常见的 base64 路径)。
const NEEDS_ESCAPE = /[\\"\u0000-\u001f\ud800-\udfff]/;

function jsonStringBytes(text) {
  // 整串 UTF-8 长度先算一次;有转义字符时再按 JSON 的转义规则逐字符补差额。
  // 不切片、不重新序列化:多行大文本(代码/Markdown)也只是一次线性扫描。
  let bytes = Buffer.byteLength(text, 'utf8') + 2;
  if (!NEEDS_ESCAPE.test(text)) return bytes;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x20) {
      if (code === 0x22 || code === 0x5c) bytes += 1; // 1 → 2(\" 或 \\)
      else if (code >= 0xd800 && code <= 0xdfff) {
        if (code <= 0xdbff) {
          const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
          // 合法代理对按 UTF-8 原样输出(4 字节),不用转义
          if (next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
        }
        bytes += 3; // 孤立代理项:UTF-8 按 3 字节算(替换符),转义写成 6 字节
      }
      continue;
    }
    // 五个短转义各 2 字节(1 → 2);其余控制字符写成 \u00XX(1 → 6)
    bytes += (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) ? 1 : 5;
  }
  return bytes;
}

// path 是当前遍历路径上的对象(同一对象重复出现不算环,只有回到自身才是)。
// 循环引用在 JSON.stringify 里是 TypeError,这里先标记成不可等价,回退给 stringify
// 抛同一类错误,不自己造判定。
function countJson(value, path) {
  switch (typeof value) {
    case 'string': return jsonStringBytes(value);
    case 'number': return Number.isFinite(value) ? String(value).length : 4;
    case 'boolean': return value ? 4 : 5;
    case 'object': break;
    case 'bigint': throw UNSUPPORTED;
    // undefined/函数/symbol:JSON.stringify 顶层返回 undefined,对象里省略,数组里写 null
    default: return -1;
  }
  if (value === null) return 4;
  if (path.has(value)) throw UNSUPPORTED;
  const isArray = Array.isArray(value);
  if (!isArray) {
    const proto = Object.getPrototypeOf(value);
    // 只认 JSON.parse 的产物(Object.prototype 或 null 原型);其余整棵回退
    if (proto !== Object.prototype && proto !== null) throw UNSUPPORTED;
  }
  if (typeof value.toJSON === 'function') throw UNSUPPORTED;
  path.add(value);
  let bytes = 2; // 开括号 + 闭括号
  if (isArray) {
    for (let i = 0; i < value.length; i++) {
      if (i) bytes += 1; // 逗号
      // 稀疏数组的空洞在 JSON 里是 null(与 JSON.stringify 的 HasProperty 判定一致)
      if (!(i in value)) { bytes += 4; continue; }
      const item = countJson(value[i], path);
      bytes += item === -1 ? 4 : item;
    }
  } else {
    let first = true;
    for (const key of Object.keys(value)) {
      const item = countJson(value[key], path);
      if (item === -1) continue; // 对象里 undefined/函数/symbol 属性不出现
      if (!first) bytes += 1; // 逗号
      first = false;
      bytes += jsonStringBytes(key) + 1 + item; // "key":value
    }
  }
  path.delete(value);
  return bytes;
}

// JSON.stringify(value) 的字节数;取不到字符串(顶层 undefined/函数/symbol)按 0 算,
// 与旧实现一致。无法逐字节等价时回退到真正的 stringify。
function jsonBytes(value) {
  try {
    const bytes = countJson(value, new Set());
    return bytes < 0 ? 0 : bytes;
  } catch (error) {
    if (error !== UNSUPPORTED) throw error;
    const text = JSON.stringify(value);
    return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
  }
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
  // 整包字节数与分区字节数走同一套遍历,不再为统计生成整份序列化字符串。
  const serializedBytes = jsonBytes(body);

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
