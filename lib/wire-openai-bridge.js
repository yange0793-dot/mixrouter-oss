'use strict';
// OpenAI 双协议转换层:Responses ⇄ Chat Completions。
//
// 与另外两个 wire-* 模块的分工(别混):
//   lib/wire-responses.js  Anthropic Messages ⇄ OpenAI Responses
//   lib/wire-chat.js       Anthropic Messages ⇄ OpenAI Chat Completions
//   lib/wire-openai-bridge.js(本文件)Responses ⇄ Chat —— 两端都是 OpenAI 协议,没有 Anthropic 参与
//
// 存在意义:Codex 客户端只会说 /v1/responses,而上游有些站只开 /v1/chat/completions。
// 由 mixrouter 在进程内把客户端发来的 Responses 请求翻成 chat 发上去,再把上游的
// chat 响应(JSON 或 SSE)翻回 Responses 形状,不必再挂一个本地转换代理。
//
// 踩过的坑,照旧(改坏了必须红):
//   - 首个文本 delta 之前必须先发 output_item.added / content_part.added,否则 codex 报
//     "OutputTextDelta without active item"。工具调用整包下发即可,分片增量非必需。
//   - extraHeaders 里带着上游的 Content-Type(通常是 application/json),必须让它先铺、
//     再由本模块盖掉,否则客户端拿到的是 JSON 头配 SSE 体。
//   - 未知 input item(local_shell_call / web_search_call / computer_call 等)一律忽略,
//     原样透传会让上游 400。
//
// 本模块是纯函数集合:**require 不读配置、不起监听、无副作用**(与 lib/routing/strategy.js 同口径)。
// 唯一的运行时依赖是 crypto(生成 id),不依赖 mixrouter.js 的任何模块级状态。

const crypto = require('crypto');
const { StringDecoder } = require('node:string_decoder');
const codexTools = require('./codex-tools');

const randId = prefix => prefix + crypto.randomBytes(8).toString('hex');

// 取文本里该字段"最后一次"出现的值(OpenAI 系的 usage 在流的末尾才齐;中途事件可能带旧值)。
// 与 Anthropic 侧的 extractUsage 共用同一套"末次匹配"口径,所以本函数对外导出,
// mixrouter.js 的 extractUsage 直接复用,不另存一份实现。
function lastNum(text, re) {
  const g = new RegExp(re.source, 'g');
  let m, v = 0;
  while ((m = g.exec(text)) !== null) v = Number(m[1]);
  return v;
}

// OpenAI 两种协议的 usage 抽取(流式累积文本与整包 JSON 都适用)
//   responses: input_tokens / output_tokens / input_tokens_details.cached_tokens
//   chat:      prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
function extractUsageOpenAI(kind, text) {
  const u = kind === 'responses'
    ? { in: lastNum(text, /"input_tokens"\s*:\s*(\d+)/), out: lastNum(text, /"output_tokens"\s*:\s*(\d+)/) }
    : { in: lastNum(text, /"prompt_tokens"\s*:\s*(\d+)/), out: lastNum(text, /"completion_tokens"\s*:\s*(\d+)/) };
  u.cache_read = lastNum(text, /"cached_tokens"\s*:\s*(\d+)/);
  return u;
}

// ---------------------------------------------------------------- 请求方向:Responses → Chat
function chatImagePart(b) {
  const url = b.image_url_data_url || (typeof b.image_url === 'object' ? b.image_url?.url : b.image_url) || b.url;
  if (typeof url !== 'string' || !url) return null;
  const detail = b.detail || b.image_url?.detail;
  return { type: 'image_url', image_url: { url, ...(detail ? { detail } : {}) } };
}
// 一条 responses input item → 若干条 chat messages(就地 push)
function itemToChatMessages(item, messages, opts) {
  if (typeof item === 'string') { messages.push({ role: 'user', content: item }); return; }
  if (!item || typeof item !== 'object') return;
  switch (item.type || (item.role ? 'message' : '')) {
    case 'message': {
      const role = item.role === 'developer' ? 'system' : (item.role || 'user');
      const c = item.content;
      if (typeof c === 'string') { messages.push({ role, content: c }); return; }
      if (!Array.isArray(c)) { messages.push({ role, content: '' }); return; }
      const texts = [], images = [];
      for (const b of c) {
        if (typeof b === 'string') { texts.push(b); continue; }
        if (!b) continue;
        if (b.type === 'input_text' || b.type === 'output_text' || b.type === 'text') texts.push(b.text || '');
        else if (b.type === 'input_image' || b.type === 'image_url') {
          const part = chatImagePart(b);
          if (part && !opts.dropImages) images.push(part);
          else texts.push('[图片:该渠道按配置丢弃图片,模型看不到它]');
        }
      }
      const content = images.length
        ? [...(texts.length ? [{ type: 'text', text: texts.join('\n') }] : []), ...images]
        : texts.join('\n');
      messages.push({ role, content });
      return;
    }
    case 'function_call':
    case 'custom_tool_call': {
      // 助手上一轮的工具调用 → assistant.tool_calls
      let assistant = messages[messages.length - 1];
      if (assistant?.role !== 'assistant') {
        assistant = { role: 'assistant', content: '' };
        messages.push(assistant);
      }
      if (opts.reasoning) assistant.reasoning_content = opts.reasoning;
      assistant.tool_calls = assistant.tool_calls || [];
      assistant.tool_calls.push(codexTools.callToChat(item, opts.book));
      return;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      let out = item.output;
      // 个别客户端把 output 包成 {content:[{text}]} 对象
      if (out && typeof out === 'object' && Array.isArray(out.content)) out = out.content.map(b => (b && b.text) || '').join('\n');
      if (typeof out !== 'string') out = JSON.stringify(out === undefined ? '' : out);
      messages.push({ role: 'tool', tool_call_id: item.call_id || item.id || '', content: out });
      return;
    }
    case 'reasoning':
    case 'reasoning_summary':
      opts.reasoning = codexTools.reasoningText(item);
      return;
    default:
      return;  // 未知 item(local_shell_call / web_search_call / computer_call 等)忽略,避免上游 400
  }
}
// responses 工具选择 → chat 形状(Codex 默认发字符串 "auto")
function chatToolChoice(tc) {
  if (!tc || typeof tc !== 'object') return tc === undefined ? 'auto' : tc;
  if (tc.type === 'function' && tc.name) return { type: 'function', function: { name: tc.name } };
  if (tc.type === 'function' && tc.function) return tc;
  return 'auto';
}
// 请求方向:responses → chat/completions
function responsesToChat(body, provider) {
  const messages = [];
  const book = codexTools.registry(body.tools);
  const opts = { dropImages: !!provider?.drop_images, book, reasoning: '' };
  if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });
  const input = body.input;
  if (Array.isArray(input)) for (const item of input) {
    if (item?.role === 'user' || item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') opts.reasoning = '';
    itemToChatMessages(item, messages, opts);
  }
  else if (typeof input === 'string') messages.push({ role: 'user', content: input });
  if (!messages.some(m => m.role === 'user')) messages.push({ role: 'user', content: '(empty request)' });

  const out = { model: body.model, messages, stream: body.stream !== false };
  if (body.max_output_tokens) out.max_tokens = body.max_output_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (typeof body.reasoning?.effort === 'string') out.reasoning_effort = body.reasoning.effort;
  for (const field of ['top_p', 'service_tier', 'prompt_cache_key']) if (body[field] !== undefined) out[field] = body[field];
  if (body.text?.format?.type === 'json_object') out.response_format = { type: 'json_object' };
  if (body.text?.format?.type === 'json_schema') {
    const { type, ...schema } = body.text.format;
    out.response_format = { type, json_schema: schema };
  }
  if (out.stream) out.stream_options = { include_usage: true };  // 统计需要 usage,得主动要
  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = codexTools.definitions(book);
    if (tools.length) {
      out.tools = tools;
      if (body.tool_choice != null) out.tool_choice = codexTools.choiceToChat(body.tool_choice, book);
      if (body.parallel_tool_calls != null) out.parallel_tool_calls = body.parallel_tool_calls;
    }
  }
  return out;
}
const responsesUsage = u => {
  const cached = (u && u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return {
    input_tokens: (u && u.prompt_tokens) || 0,
    output_tokens: (u && u.completion_tokens) || 0,
    total_tokens: (u && u.total_tokens) || 0,
    ...(cached ? { input_tokens_details: { cached_tokens: cached } } : {}),
    ...(u?.completion_tokens_details ? { output_tokens_details: { ...u.completion_tokens_details } } : {}),
  };
};

// ---------------------------------------------------------------- 响应方向:Chat → Responses
// 响应方向(非流式):chat JSON → responses JSON
function chatJsonToResponses(j, model, request = {}) {
  if (j?.error) throw new Error('Chat 上游返回错误，不能转换为成功响应');
  const msg = ((j && j.choices && j.choices[0]) || {}).message || {};
  const output = [];
  const reasoning = msg.reasoning_content || msg.reasoning;
  if (typeof reasoning === 'string' && reasoning) output.push({ type: 'reasoning', id: randId('rs_'), summary: [{ type: 'summary_text', text: reasoning }] });
  if (msg.content) output.push({ type: 'message', id: randId('msg_'), role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: String(msg.content), annotations: [] }] });
  const book = codexTools.registry(request.tools);
  for (const [index, call] of (msg.tool_calls || []).entries()) {
    output.push(codexTools.callFromChat({ ...call, id: call.id || `call_${index}` }, book, `fc_${index}`));
  }
  const reason = j?.choices?.[0]?.finish_reason;
  const incomplete = reason === 'length' || reason === 'content_filter';
  return { id: (j && j.id) || randId('resp_'), object: 'response', status: incomplete ? 'incomplete' : 'completed', model, output, usage: responsesUsage(j && j.usage),
    ...(incomplete ? { incomplete_details: { reason: reason === 'length' ? 'max_output_tokens' : 'content_filter' } } : {}) };
}
// 把一个完整的 responses 对象摊成 SSE 事件序列(客户端要流式、上游却整包回了 JSON 时用)
function emitResponsesSse(res, resp, extraHeaders) {
  const sse = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
  // 注意顺序:extraHeaders 里带着上游的 Content-Type(可能是 application/json),必须让它先铺、再由我们盖掉
  res.writeHead(200, { ...(extraHeaders || {}), 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  sse({ type: 'response.created', response: { id: resp.id, object: 'response', status: 'in_progress', model: resp.model, output: [] } });
  (resp.output || []).forEach((item, i) => {
    sse({ type: 'response.output_item.added', output_index: i, item: { ...item, status: 'in_progress', content: item.type === 'message' ? [] : undefined } });
    if (item.type === 'message') {
      const text = ((item.content || [])[0] || {}).text || '';
      sse({ type: 'response.content_part.added', item_id: item.id, output_index: i, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      if (text) sse({ type: 'response.output_text.delta', item_id: item.id, output_index: i, content_index: 0, delta: text });
      sse({ type: 'response.output_text.done', item_id: item.id, output_index: i, content_index: 0, text });
      sse({ type: 'response.content_part.done', item_id: item.id, output_index: i, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
    }
    sse({ type: 'response.output_item.done', output_index: i, item });
  });
  sse({ type: `response.${resp.status || 'completed'}`, response: resp });
  try { res.end(); } catch {}
}
// 响应方向(流式):chat SSE → responses SSE。onUsage 收尾时回报 usage(给日志/统计)
function streamChatAsResponses(cres, res, model, onUsage, extraHeaders, request = {}) {
  const streaming = request.stream !== false;
  const sse = event => { if (streaming) { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {} } };
  if (streaming) res.writeHead(200, { ...(extraHeaders || {}), 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const respId = randId('resp_');
  const itemId = randId('msg_');
  const reasoningId = randId('rs_');
  const decoder = new StringDecoder('utf8');
  const book = codexTools.registry(request.tools);
  const toolCalls = new Map();
  let text = '', reasoning = '', buffer = '', usage = null, finished = false, terminal = false, finishReason = '';
  let nextIndex = 0, textIndex = -1, reasoningIndex = -1;
  sse({ type: 'response.created', response: { id: respId, object: 'response', status: 'in_progress', model, output: [] } });

  const ensureItem = () => {
    if (textIndex >= 0) return;
    textIndex = nextIndex++;
    sse({ type: 'response.output_item.added', output_index: textIndex,
      item: { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [] } });
    sse({ type: 'response.content_part.added', item_id: itemId, output_index: textIndex, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] } });
  };
  const ensureReasoning = () => {
    if (reasoningIndex >= 0) return;
    reasoningIndex = nextIndex++;
    sse({ type: 'response.output_item.added', output_index: reasoningIndex,
      item: { type: 'reasoning', id: reasoningId, summary: [] } });
    sse({ type: 'response.reasoning_summary_part.added', item_id: reasoningId, output_index: reasoningIndex,
      summary_index: 0, part: { type: 'summary_text', text: '' } });
  };
  const finish = failure => {
    if (finished) return;
    finished = true;
    let error = failure;
    if (!error && !terminal && !finishReason) error = new Error('Chat 上游在结束标记前断流');
    const incomplete = finishReason === 'length' || finishReason === 'content_filter';
    const output = [];
    let calls = [];
    if (!error && !incomplete) {
      try {
        calls = [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([index, call]) =>
          codexTools.callFromChat({ id: call.id || `call_${respId}_${index}`, function: { name: call.name, arguments: call.args } }, book, `fc_${respId}_${index}`));
      } catch (caught) { error = caught; }
    }
    const status = error ? 'failed' : incomplete ? 'incomplete' : 'completed';
    if (textIndex >= 0) {
      const part = { type: 'output_text', text, annotations: [] };
      sse({ type: 'response.output_text.done', item_id: itemId, output_index: textIndex, content_index: 0, text });
      sse({ type: 'response.content_part.done', item_id: itemId, output_index: textIndex, content_index: 0, part });
      const item = { type: 'message', id: itemId, role: 'assistant', status: status === 'completed' ? 'completed' : 'incomplete', content: [part] };
      sse({ type: 'response.output_item.done', output_index: textIndex, item });
      output[textIndex] = item;
    }
    if (reasoningIndex >= 0) {
      const part = { type: 'summary_text', text: reasoning };
      sse({ type: 'response.reasoning_summary_text.done', item_id: reasoningId, output_index: reasoningIndex, summary_index: 0, text: reasoning });
      sse({ type: 'response.reasoning_summary_part.done', item_id: reasoningId, output_index: reasoningIndex, summary_index: 0, part });
      const item = { type: 'reasoning', id: reasoningId, summary: [part] };
      sse({ type: 'response.output_item.done', output_index: reasoningIndex, item });
      output[reasoningIndex] = item;
    }
    for (const item of calls) {
      const index = output.length;
      const custom = item.type === 'custom_tool_call';
      sse({ type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress', ...(custom ? { input: '' } : { arguments: '' }) } });
      sse({ type: custom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: custom ? item.input : item.arguments });
      sse({ type: custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done', item_id: item.id, output_index: index, ...(custom ? { input: item.input } : { arguments: item.arguments }) });
      sse({ type: 'response.output_item.done', output_index: index, item });
      output.push(item);
    }
    const response = { id: respId, object: 'response', status, model, output, usage: responsesUsage(usage),
      ...(error ? { error: { code: 'upstream_stream_error', message: error.message || 'Chat 上游断流' } } : {}),
      ...(incomplete ? { incomplete_details: { reason: finishReason === 'length' ? 'max_output_tokens' : 'content_filter' } } : {}) };
    sse({ type: `response.${status}`, response });
    if (onUsage) onUsage(response.usage, response);
    try {
      if (!streaming) {
        res.writeHead(error ? 502 : 200, { ...(extraHeaders || {}), 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } else res.end();
    } catch {}
  };
  const lineReceived = line => {
    if (finished || !line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { terminal = true; finish(); return; }
    let data;
    try { data = JSON.parse(payload); } catch { return; }
    if (data.error) { finish(new Error('Chat 上游返回流式错误')); return; }
    if (data.usage) usage = data.usage;
    const choice = data.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (!delta) return;
    const thought = delta.reasoning_content || delta.reasoning;
    if (typeof thought === 'string' && thought) {
      ensureReasoning();
      reasoning += thought;
      sse({ type: 'response.reasoning_summary_text.delta', item_id: reasoningId, output_index: reasoningIndex, summary_index: 0, delta: thought });
    }
    if (typeof delta.content === 'string' && delta.content) {
      ensureItem();
      text += delta.content;
      sse({ type: 'response.output_text.delta', item_id: itemId, output_index: textIndex, content_index: 0, delta: delta.content });
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = call.index ?? 0;
      const accumulated = toolCalls.get(index) || { id: '', name: '', args: '' };
      if (call.id) accumulated.id = call.id;
      if (call.function?.name) accumulated.name += call.function.name;
      if (call.function?.arguments) accumulated.args += call.function.arguments;
      toolCalls.set(index, accumulated);
    }
  };
  cres.on('data', chunk => {
    if (finished) return;
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) lineReceived(line);
  });
  cres.on('end', () => { if (!finished) { lineReceived(buffer + decoder.end()); finish(); } });
  cres.on('error', () => finish(new Error('Chat 上游连接中断')));
  cres.on('aborted', () => finish(new Error('Chat 上游响应被截断')));
}

// 导出面按"真有外部消费者"定,不是照搬 bloc 里的全部函数:
//   responsesToChat / chatJsonToResponses / streamChatAsResponses / emitResponsesSse
//        由 mixrouter.js 的 proxyHandler 调用
//   chatToolChoice / extractUsageOpenAI / lastNum
//        除 mixrouter.js 外还被 test/codex.test.js 直接调用
//   chatImagePart / responsesUsage / itemToChatMessages / randId
//        只被本模块内部使用,不导出(导出面越小越好)
module.exports = {
  responsesToChat, chatJsonToResponses, streamChatAsResponses, emitResponsesSse,
  chatToolChoice, extractUsageOpenAI, lastNum,
};
