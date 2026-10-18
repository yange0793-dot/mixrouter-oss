'use strict';
// Anthropic Messages ⇄ OpenAI Responses 转换层。
//
// 存在意义:有些网关的模型只挂在 Codex(Responses)型通道上——例如 anyrouter 的
// gpt-6-astra,/v1/messages 直接 404「当前 API 不支持所选模型」。给 Claude 组渠道
// 标 wire_api='responses' 后,由 mixrouter 在进程内把 Anthropic 请求翻成 Responses
// 发上去,再把响应/SSE 翻回 Anthropic,不必再挂一个本地转换代理。
//
// 上游对 Codex 型通道还有形状要求(实测):body.include 必须恰好是
// ["reasoning.encrypted_content"],且 prompt_cache_key 非空——新版按真实 Codex
// 客户端的行为补齐。prompt_cache_key 会被 new-api 用来做渠道亲和(TTL 1h),
// 坏渠道一旦钉上整小时都失败,所以调用方可以按"同会话换一代"的方式轮换它。
//
// 另一条硬要求(ps.air-outer.com 的 deepseek-v4-flash 实测):thinking 模式下,历史里
// 每个 function_call 都必须带着它那一轮的 reasoning_text 回传,缺一条整包 400
// 「The `reasoning_text` in the thinking mode must be passed back to the API.」。
// 所以请求方向不能丢客户端的 thinking 块——它得原样翻成 reasoning item 转上去。
//
// 终态纪律(改动前踩过的坑,别再退回去):
//   上游的事件流只有三种终态——completed / incomplete / failed(+ error 事件)。
//   TCP 层的 end/close/error **不是终态**,那是夭折。夭折时绝对不能补一套
//   message_delta+message_stop:客户端会拿着被截断的答案当成功结果用。
//   同理,工具参数没攒齐的 function_call 不能以 tool_use 正常收尾。

const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { relayAnthropicStream: relaySkeleton } = require('./upstream-relay');
const { makePruner } = require('./tool-input-prune');

const stripModelSuffix = m => String(m || '').replace(/\[[^\]]*\]\s*$/, '');

// Anthropic 图片块 → Responses 的 input_image。顶层消息和 tool_result 里的图片共用这一处,
// 免得工具结果里的截图(Claude Code 常见的图片来源)被静默丢掉
function imageUrlOf(source) {
  if (!source || typeof source !== 'object') return '';
  return source.type === 'base64'
    ? `data:${source.media_type || 'image/png'};base64,${source.data || ''}`
    : (source.url || '');
}
function imagePart(source) {
  const url = imageUrlOf(source);
  return url ? { type: 'input_image', image_url: url } : null;
}

// 推理/加密字段对 Anthropic 客户端没有对应物,直接丢掉
function memoryDrop(item) {
  if (item && typeof item === 'object' && 'encrypted_content' in item) delete item.encrypted_content;
}

// 工具参数是 JSON 字符串。空/缺省按零参数工具算;解析不了的一律算"参数不完整"——
// 不能吞掉异常当 {} 放行,那是把截断伪装成一次可执行调用(实测复现过)
// 个别网关直接把**对象**塞进 arguments。以前这里无条件 String(),对象会变成
// "[object Object]",解析必然失败 —— 一次参数完好的调用被判成"残缺"丢掉。
function argsRawOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return ''; } }
  return String(v);
}
function toolArgsOk(raw) {
  try { JSON.parse(argsRawOf(raw).trim() || '{}'); return true; } catch { return false; }
}
function toolArgsValue(raw) {
  try { return JSON.parse(argsRawOf(raw).trim() || '{}'); } catch { return {}; }
}

// reasoning 回放按实际出站模型选形状,同一渠道也可能同时托管两种协议变体。
// Astra/Sol 只收 summary_text,非空 content 会被拒;DeepSeek 必须回传 reasoning_text。
// 未登记模型沿用 content 形状;不能把两种字段一起塞入,也不能丢历史 thinking 规避 400。
// qwen3.8(基元律动)同样只收 summary:实测 2026-09-17,凡带 reasoning 历史的请求
// 一律 400 `Invalid 'summary': summary is required and must be a list for reasoning.`,
// 且该 400 会让子代理连挂两次后彻底停笔(转录不再增长、字节监测测不出来)。
const SUMMARY_SHAPE_MODELS = [/^gpt-6-astra\b/i, /^gpt-5\.6-sol\b/i, /^qwen3\.8\b/i];
function reasoningItemFor(model, text) {
  const m = stripModelSuffix(model || '');
  const wantSummary = SUMMARY_SHAPE_MODELS.some(re => re.test(m));
  return wantSummary
    ? { type: 'reasoning', summary: [{ type: 'summary_text', text }] }
    : { type: 'reasoning', content: [{ type: 'reasoning_text', text }] };
}

// 不收 reasoning.effort 的模型:带上就整包 400。实测 2026-09-23 基元律动 deepseek-flash
// 同一 key 同一模型,不带该字段 200,带 {effort:'low'} 回 400 `未知请求字段：reasoning.effort`
// (code UNKNOWN_FIELD);同渠道 qwen3.8 照常收。这类模型只丢 effort,其余字段不动。
// 实测 2026-10-01 Peach swe-2-max:不带 200,带 {effort} 回 400
// `reasoning is not supported by this provider adapter`;同请求 include 与历史
// reasoning item(content/summary 两种形状)都 200,只有顶层 reasoning 对象被拒。
const NO_EFFORT_MODELS = [/^deepseek-flash\b/i, /^swe-2-max\b/i];

function anthropicToResponses(a, { model, promptCacheKey, stats } = {}) {
  const r = {
    model: stripModelSuffix(model || a.model),
    // 上游恒流式:非流上游要等整篇生成完才发响应头,大上下文压缩类请求(Claude Code 的
    // auto-compact 正是非流+全量历史)会稳定撞首字节超时,客户端再重试、上游照常跑完照常
    // 扣费,一夜烧掉上百刀的死循环就是这么来的。客户端要非流时由调用方收完攒整包再回。
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  if (promptCacheKey) r.prompt_cache_key = promptCacheKey;
  // /effort 的显式选择交给上游;未指定时不钉默认值,也不把 token 预算猜成强度。
  const effort = a.output_config && a.output_config.effort;
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
      && !NO_EFFORT_MODELS.some(re => re.test(r.model))) {
    r.reasoning = { effort };
    // 与 chat 线同一个口径:stats.effort 只记真的发上去的那个值(被 NO_EFFORT_MODELS
    // 拦掉时留空),日志里才能分清「客户端没选」和「选了但这渠道收不了」。
    if (stats) stats.effort = effort;
  }
  let instructions = '';
  if (typeof a.system === 'string') instructions = a.system;
  else if (Array.isArray(a.system)) {
    instructions = a.system.map(b => (typeof b === 'string' ? b : b && b.type === 'text' ? b.text : '')).filter(Boolean).join('\n\n');
  }
  if (instructions) r.instructions = instructions;

  const input = [];
  for (const msg of Array.isArray(a.messages) ? a.messages : []) {
    // 元素不保证是对象:客户端塞个 null/数字进来就会在 msg.role 上抛 TypeError。
    // 这一抛发生在请求处理中途,客户端拿不到任何响应(干等到自己的超时),
    // 而生产里的 uncaughtException 兜底只记日志,不会补一个错误响应。
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    if (typeof msg.content === 'string') {
      if (msg.content) input.push({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: msg.content }] });
      continue;
    }
    let parts = [];
    const flush = () => { if (parts.length) { input.push({ type: 'message', role, content: parts }); parts = []; } };
    for (const p of Array.isArray(msg.content) ? msg.content : []) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'text') parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: p.text || '' });
      else if (p.type === 'image' && p.source) {
        const part = imagePart(p.source);
        if (part) parts.push(part);
      } else if (p.type === 'tool_use') {
        flush();
        input.push({
          type: 'function_call',
          call_id: p.id || `call_${crypto.randomBytes(8).toString('hex')}`,
          name: p.name || '',
          arguments: JSON.stringify(p.input ?? {}),
        });
      } else if (p.type === 'tool_result') {
        flush();
        // 工具结果里的图片同样要转:Claude Code 截图类工具的结果就是这种形状。
        // 带图时 output 用内容数组(Responses 允许 string 或 input_text/input_image 数组),
        // 不带图时维持原来的纯字符串形状,免得平白改变已有上游的行为。
        const outs = [];
        const refs = [];
        if (typeof p.content === 'string') outs.push({ type: 'input_text', text: p.content });
        else if (Array.isArray(p.content)) {
          for (const c of p.content) {
            if (!c || typeof c !== 'object') continue;
            if (c.type === 'text') outs.push({ type: 'input_text', text: c.text || '' });
            else if (c.type === 'image' && c.source) { const part = imagePart(c.source); if (part) outs.push(part); }
            else if (c.type === 'tool_reference' && c.tool_name) refs.push(c.tool_name);
          }
        }
        // ToolSearch(工具检索)的结果:tool_reference 在 Anthropic 侧表示"把这些工具的定义加载进来"。
        // Responses 上游没有对应概念——工具本来就全量声明在 tools 里,所以退化成如实写出工具名。
        // 丢掉的话,只含 tool_reference 的 tool_result 会变成一个**空结果**,模型以为搜索什么也没命中,
        // 于是反复重搜(Claude Code 的 ToolSearch 结果正是这种形状)。
        if (refs.length) outs.push({ type: 'input_text', text: refs.join('\n') });
        const withImage = outs.some(o => o.type === 'input_image');
        input.push({ type: 'function_call_output', call_id: p.tool_use_id || '',
          output: withImage ? outs : outs.map(o => o.text || '').filter(Boolean).join('\n') });
      } else if (p.type === 'thinking') {
        // 客户端回传的思考要原样送回上游:thinking 模式下,每个 function_call 都要求它那一轮的
        // 思考一起回传,缺一条整包 400。**具体形状由模型定**(见 reasoningItemFor):
        // deepseek 系要 reasoning_text,astra 系要 summary_text,给错就是 400。
        // 位置也要对:item 必须落在那一轮的 function_call 之前(M 实测放到最前面照样 400)。
        // 空文本不算"回传"(实测空文本一样 400),跳过免得白占一个 item。
        if (stats) stats.think = (stats.think || 0) + 1;
        const thinkText = typeof p.thinking === 'string' ? p.thinking : '';
        if (thinkText.trim()) {
          if (stats) stats.reasoning = (stats.reasoning || 0) + 1;
          input.push(reasoningItemFor(model || a.model, thinkText));
        }
      }
      // redacted_thinking / cache_control 等对 Responses 没有对应物,忽略
    }
    flush();
  }
  r.input = input;
  if (Array.isArray(a.tools) && a.tools.length) {
    r.tools = a.tools.filter(t => t && t.name).map(t => ({
      type: 'function', name: t.name, description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
      // Anthropic 的工具 schema 没有 strict 概念,**必须显式写 false**:
      // Responses 在缺这个字段时会把 schema 规范化成严格模式,而严格模式要求 properties 里
      // 每个键都出现在 required 里(官方 function calling 文档的 strict mode 一节)。
      // 于是客户端 schema 里的可选参数在上游变成必填,模型被迫给**每个**可选参数都编一个值,
      // 客户端按"出现即使用"校验就只能拒绝或误用。实测(2026-10-16):Agent 调用里
      // description/prompt/subagent_type 之外的可选参数被填满,包括本该省略的 isolation,
      // 与"这些可选字段从未被省略"的现象一致;本文件转换出来的 tools 里此前没有 strict 字段。
      // 原生 Codex 通路本来就带 strict:false(见 test/codex-bridge-*.test.js 的夹具)。
      strict: false,
    }));
  }
  if (a.tool_choice && typeof a.tool_choice === 'object') {
    // none 必须原样传 none:落到 else 会变成 auto,客户端明确禁止工具的请求反而被允许调工具
    if (a.tool_choice.type === 'any') r.tool_choice = 'required';
    else if (a.tool_choice.type === 'none') r.tool_choice = 'none';
    else if (a.tool_choice.type === 'tool' && a.tool_choice.name) r.tool_choice = { type: 'function', name: a.tool_choice.name };
    else r.tool_choice = 'auto';
  }
  r.max_output_tokens = Math.max(16, Math.min(Number(a.max_tokens) || 32000, 128000));
  return r;
}

// Responses 的 usage.input_tokens **含**缓存命中(Anthropic 的 input_tokens 不含)。
// 不减掉缓存那部分就会按全价计,长会话成本明显偏高。
function usageOf(u) {
  u = u || {};
  const cached = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
  return {
    input_tokens: Math.max(0, (u.input_tokens || 0) - cached),
    output_tokens: u.output_tokens || 0,
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  };
}

// HTTP 200 但其实失败的三种形状:显式 error、status=failed、以及"说是 completed
// 却带着解析不了的工具参数"。调用方据此回 Anthropic error,而不是一条空的正常消息。
function responsesErrorOf(j) {
  if (!j || typeof j !== 'object') return null;
  const msgOf = e => (typeof e === 'string' ? e : (e && (e.message || e.type)) || '');
  if (j.error) return { type: 'api_error', message: String(msgOf(j.error) || '上游返回错误').slice(0, 400) };
  if (j.status === 'failed' || j.status === 'cancelled') {
    return { type: 'api_error', message: String(msgOf(j.error) || `上游以 status=${j.status} 结束了这条响应`).slice(0, 400) };
  }
  if (j.status === 'completed') {
    const bad = (Array.isArray(j.output) ? j.output : []).filter(it => it && it.type === 'function_call' && !toolArgsOk(it.arguments));
    if (bad.length) {
      return { type: 'api_error', message: `上游返回的工具调用参数不完整: ${bad.map(b => b.name || b.call_id || '?').join(', ')}`.slice(0, 400) };
    }
  }
  return null;
}

// reasoning item 里的明文思考:新版放在 content[].reasoning_text,也有网关只给
// summary[].summary_text(对应 SSE 的两条 reasoning 事件名),两种都认。
// 只剩 encrypted_content 的 item 没有可回传的明文,返回空串。
function reasoningTextOf(item) {
  const parts = [];
  for (const c of Array.isArray(item.content) ? item.content : []) {
    if (c && typeof c.text === 'string' && c.text) parts.push(c.text);
  }
  if (!parts.length) {
    for (const s of Array.isArray(item.summary) ? item.summary : []) {
      if (s && typeof s.text === 'string' && s.text) parts.push(s.text);
    }
  }
  return parts.join('');
}

// tools = 原始 Anthropic 请求的 tools:用来剪掉可选参数里的空占位(见 lib/tool-input-prune.js)
function responsesToAnthropic(j, model, { tools } = {}) {
  const prune = makePruner(tools);
  const content = [];
  let hasTool = false;
  for (const item of (j && j.output) || []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
      for (const c of item.content || []) if (c.type === 'output_text' && c.text) content.push({ type: 'text', text: c.text });
    } else if (item.type === 'reasoning') {
      // 明文思考要留成 thinking 块,与 SSE 分支的 thinkingBlock 对齐。整包 JSON 分支以前
      // 只认 function_call:上游忽略 stream 参数直接回 JSON 时,这一轮的 reasoning 就丢了,
      // 客户端下一轮回传缺 reasoning_text,thinking 模式下整包 400。
      // signature 与 SSE 分支一样是空串占位(我们转发的是明文思考,没有真签名)。
      const text = reasoningTextOf(item);
      if (text) content.push({ type: 'thinking', thinking: text, signature: '' });
    } else if (item.type === 'function_call') {
      // 参数解析不了时 input 只能是 {};这种响应应当由 responsesErrorOf 先拦下,
      // 走到这里说明调用方没查——保留形状,但 stop_reason 不会被工具块带偏。
      content.push({ type: 'tool_use', id: item.call_id || item.id, name: item.name || '', input: prune.value(item.name || '', toolArgsValue(item.arguments)) });
      hasTool = true;
    }
  }
  // 截断要如实表达:incomplete → max_tokens,不能被工具块顺手改写成 tool_use
  const stop = (j && j.status) === 'incomplete' ? 'max_tokens' : (hasTool ? 'tool_use' : 'end_turn');
  return {
    id: (j && j.id) || `msg_${crypto.randomBytes(12).toString('hex')}`,
    type: 'message', role: 'assistant', model: (j && j.model) || model,
    content, stop_reason: stop, stop_sequence: null,
    usage: usageOf(j && j.usage),
  };
}

// 上游终态事件名 → 我们自己的终态词
const TERMINAL_KINDS = { 'response.completed': 'completed', 'response.incomplete': 'incomplete', 'response.failed': 'failed' };

// Responses 的 SSE 事件流 → Anthropic 的 SSE 事件流,明文 reasoning 保留为 thinking 块。
class AnthropicStream {
  constructor(res, model, { onCommit, onDone, canRetry, usageOf: toUsage, tools } = {}) {
    this.res = res; this.model = model;
    this.prune = makePruner(tools); // 工具块物化前剪掉可选参数的空占位
    this.onCommit = onCommit || null; this.onDone = onDone || null; this.canRetry = canRetry || null;
    // usage 的原始形状随上游协议而异(responses 的 input_tokens vs chat 的 prompt_tokens),
    // 换算成 Anthropic 口径的函数由各转换层注入;缺省按 responses 形状(wire-chat 显式传自己的)
    this.toUsage = toUsage || usageOf;
    this.committed = false; this.pre = []; // 提交前的帧先攒着:发现是错误体还能整条重试
    this.started = false; this.finished = false;
    this.terminal = ''; this.failMessage = ''; this.retryable = false;
    this.index = -1; this.open = null;
    this.tools = new Map(); this.toolCount = 0; this.lastKey = ''; this.alias = new Map();
    // 每个块已经发出去的文本/思考,用来给"载荷只出现在 *.done 事件里"的上游去重补齐
    this.texts = new Map();
    this.usage = null; this.stop = 'end_turn';
    this.decoder = new StringDecoder('utf8'); this.buf = '';
  }
  write(text) {
    try { if (!this.res.writableEnded && !this.res.destroyed) this.res.write(text); } catch { /* 客户端已断,丢了 */ }
  }
  send(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if (this.committed) this.write(frame); else this.pre.push(frame);
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.send('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${crypto.randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant',
        model: this.model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }
  // 只有真的往客户端方向产出内容了才提交(提交后 HTTP 状态就改不了、也不能整条重试)。
  // response.created / output_item.added 这类元事件故意不提交:工具参数可能还要流很久。
  // 冲刷也在这里做:交给 onCommit 的只有"写响应头"这一件事,漏冲刷就会一条帧都发不出去。
  commitNow() {
    if (this.committed) return;
    this.committed = true;
    if (this.onCommit) this.onCommit();
    const pending = this.pre.join('');
    this.pre = [];
    if (pending) this.write(pending);
  }
  maybeCommit() { if (!this.committed) this.commitNow(); }
  openBlock(key, kind, extra = {}) {
    // 开任何新块前,思考块先以 signature 收尾——工具块(emitTool 直接 openBlock)开始前
    // 也要,不能只在 textBlock 里管。closeThinking 只对开着的 thinking 块生效,幂等。
    this.closeThinking();
    this.closeBlock();
    this.start();
    this.index++;
    this.open = { key, kind, index: this.index };
    this.send('content_block_start', {
      type: 'content_block_start', index: this.index,
      content_block: kind === 'text'
        ? { type: 'text', text: '' }
        : kind === 'thinking'
        ? { type: 'thinking', thinking: '' }
        : { type: 'tool_use', id: extra.id, name: extra.name, input: {} },
    });
  }
  closeBlock() {
    if (!this.open) return;
    this.send('content_block_stop', { type: 'content_block_stop', index: this.open.index });
    this.open = null;
  }
  textBlock(key) {
    if (this.open && this.open.kind === 'text' && this.open.key === key) return;
    this.closeThinking(); // 正文开始前先给思考块收尾(signature + stop),块顺序才是 thinking → text
    this.openBlock(key, 'text');
  }
  // 思考块:与正文块同样严格串行。Anthropic 的 thinking 块流必须以 signature_delta 收尾,
  // 这里转发上游明文思考、没有真签名,用空串占位。请求方向按出站模型回放明文,
  // 不会把这个占位签名当成真实签名送回上游。
  thinkingBlock(key) {
    if (this.open && this.open.kind === 'thinking' && this.open.key === key) return;
    this.closeThinking();
    this.openBlock(key, 'thinking');
  }
  closeThinking() {
    if (!this.open || this.open.kind !== 'thinking') return;
    this.send('content_block_delta', { type: 'content_block_delta', index: this.open.index, delta: { type: 'signature_delta', signature: '' } });
    this.closeBlock();
  }
  toolState(key) {
    let st = this.tools.get(key);
    if (!st) { st = { id: '', name: '', args: '', emitted: false, bad: false }; this.tools.set(key, st); }
    return st;
  }
  // 工具块在 output_item.done 时一次性发:Anthropic 的块必须严格串行,而上游的
  // arguments 增量可以交错(实测:两个 function_call 的增量拼进了同一个块,
  // 参数变成 {"p":"a"}{"p":"b"} 的错拼)。攒齐再发就天然不会串,代价是工具参数
  // 不再逐字下行——客户端在 content_block_start 就已拿到工具名与 id。
  emitTool(key, explicitRaw = null) {
    const st = this.tools.get(key);
    if (!st || st.emitted) return;
    st.emitted = true;
    // raw 默认是攒下来的**字符串**(要原样透传给客户端);explicitRaw 则可能是对象形状的
    // arguments —— 那时得序列化后再发,否则 partial_json 会变成 "[object Object]"
    let raw = explicitRaw != null ? argsRawOf(explicitRaw) : (st.args.trim() || '{}');
    if (!toolArgsOk(raw)) st.bad = true;
    // 参数本来就攒齐才发,剪空占位不用另起缓冲;剪空了就是 '{}',下面照常不发 delta
    else raw = this.prune.raw(st.name || '', raw);
    this.openBlock(key, 'tool_use', { id: st.id || `call_${crypto.randomBytes(6).toString('hex')}`, name: st.name || '' });
    this.toolCount++;
    if (raw !== '{}') {
      this.send('content_block_delta', { type: 'content_block_delta', index: this.open.index, delta: { type: 'input_json_delta', partial_json: raw } });
    }
    this.closeBlock();
    this.maybeCommit();
  }
  // 块的归属键:优先 output_index(同一响应内唯一),退到 item_id/call_id,
  // 都没有时归给最近一次 added 的 item——Responses 的 item 严格串行,这样既不会串到
  // 别的工具上,也不会每个 delta 都开一个新块(上游确实有不发 output_index 的)。
  // added 同时带 output_index 和 item id 时把两个称呼记成同一个键:同一个 item 的
  // 后续事件有的只带 id、有的只带 index,别名不统一就会把一次工具调用拆成两个块。
  keyOf(ev, item) {
    const idx = ev && ev.output_index;
    const id = (ev && ev.item_id) || (item && (item.id || item.call_id));
    if (idx !== undefined && idx !== null && idx !== '') {
      const key = `i${idx}`;
      if (id) this.alias.set(String(id), key);
      return key;
    }
    if (id) return this.alias.get(String(id)) || `id:${id}`;
    return this.lastKey || 'i0';
  }
  // 唯一允许发 message_delta/message_stop 的入口,而且只给 completed/incomplete 用
  finishTerminal(kind, { message = '', usage = null, reason = '' } = {}) {
    if (this.finished) return;
    this.finished = true;
    this.terminal = kind;
    if (usage) this.usage = usage;
    // 一切终态前思考块先以 signature 收尾:物化工具块(openBlock)会顺手关掉当前块,
    // 那时补 signature 就晚了
    this.closeThinking();
    if (kind === 'completed' || kind === 'incomplete') {
      // 先验参数再物化:免得坏工具块已经发给客户端了、随后又改口说失败
      for (const st of this.tools.values()) if (!st.emitted && !toolArgsOk(st.args.trim() || '{}')) st.bad = true;
      const bad = [...this.tools.values()].find(t => t.bad);
      // 说是 completed 却给出解析不了的工具参数:这是坏终态,不能当成功
      if (bad && kind === 'completed') {
        kind = 'failed'; this.terminal = 'failed';
        message = `上游返回的工具调用参数不完整(${bad.name || 'tool'}),已按失败处理`;
      } else {
        for (const key of this.tools.keys()) this.emitTool(key); // 没等到 done 的按现有参数物化
      }
    }
    this.maybeCommit();
    this.start();
    if (kind === 'failed' || kind === 'aborted') {
      this.failMessage = String(message || 'upstream failure').slice(0, 400);
      // 只发协议级 error:不补 message_delta/message_stop,不把夭折伪装成正常结束
      this.send('error', { type: 'error', error: { type: 'api_error', message: this.failMessage } });
    } else {
      // 截断优先于工具:max_tokens 是"被砍了",不能被工具块改写成 tool_use。
      // 'length' 是 OpenAI chat 的截断词,'max_output_tokens' 是 responses 的,两种都认
      this.stop = kind === 'incomplete'
        ? (reason === 'max_output_tokens' || reason === 'length' || !reason ? 'max_tokens' : 'end_turn')
        : (this.toolCount ? 'tool_use' : 'end_turn');
      this.closeBlock();
      const u = this.toUsage(this.usage);
      this.send('message_delta', {
        type: 'message_delta', delta: { stop_reason: this.stop, stop_sequence: null },
        usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, ...(u.cache_read_input_tokens ? { cache_read_input_tokens: u.cache_read_input_tokens } : {}) },
      });
      this.send('message_stop', { type: 'message_stop' });
    }
    if (this.onDone) this.onDone();
  }
  // 传输层夭折:还没给客户端写过任何字节就允许整条重试,否则如实报错
  abort(message) {
    if (this.finished) return;
    if (!this.committed && this.canRetry && this.canRetry()) {
      this.finished = true; this.terminal = 'aborted'; this.retryable = true;
      this.failMessage = String(message || '');
      if (this.onDone) this.onDone();
      return;
    }
    this.finishTerminal('aborted', { message });
  }
  handle(ev) {
    const t = ev && ev.type;
    if (t === 'response.created' || t === 'response.in_progress') {
      if (ev.response && ev.response.model) this.model = ev.response.model;
      return;
    }
    if (this.finished) return;
    if (TERMINAL_KINDS[t]) {
      const resp = ev.response || {};
      const status = resp.status || '';
      let kind = TERMINAL_KINDS[t];
      // 上游常拿同一个事件名承载 status:completed 事件里写 status=incomplete 是常态
      if (kind === 'completed' && status === 'incomplete') kind = 'incomplete';
      else if (kind === 'completed' && (status === 'failed' || status === 'cancelled')) kind = 'failed';
      const reason = (resp.incomplete_details && resp.incomplete_details.reason)
        || (ev.incomplete_details && ev.incomplete_details.reason) || '';
      const err = (resp.error && (resp.error.message || resp.error.type)) || '';
      this.finishTerminal(kind, { message: err, usage: resp.usage || null, reason });
      return;
    }
    if (t === 'error' || (ev && ev.error && !t)) {
      const msg = (ev.error && (ev.error.message || ev.error.type)) || ev.message || 'upstream failure';
      if (!this.committed && this.canRetry && this.canRetry()) {
        this.finished = true; this.terminal = 'failed'; this.retryable = true; this.failMessage = String(msg);
        if (this.onDone) this.onDone();
        return;
      }
      this.finishTerminal('failed', { message: msg, usage: (ev.response && ev.response.usage) || null });
      return;
    }
    this.start();
    if (t === 'response.output_item.added') {
      const item = ev.item || {};
      const key = this.keyOf(ev, item);
      this.lastKey = key;
      if (item.type === 'function_call') {
        const st = this.toolState(key);
        st.id = st.id || item.call_id || item.id || '';
        st.name = st.name || item.name || '';
      } else if (item.type === 'message') this.textBlock(key);
      else if (item.type === 'reasoning') this.thinkingBlock(key);
    } else if (t === 'response.output_text.delta') {
      const key = this.keyOf(ev, null);
      this.textBlock(key);
      const d = ev.delta || '';
      this.texts.set(key, (this.texts.get(key) || '') + d);
      this.send('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text: d } });
      this.maybeCommit();
    } else if (t === 'response.output_text.done') {
      // 官方 Responses 事件,载荷在 ev.text。只在增量没覆盖到时补发:有的上游
      // 增量与 done 都发(补发就重复了),有的只发 done(不补就是空块)。
      const key = this.keyOf(ev, null);
      this.textBlock(key);
      const full = typeof ev.text === 'string' ? ev.text : '';
      const had = this.texts.get(key) || '';
      if (full && full !== had && full.startsWith(had)) {
        this.texts.set(key, full);
        this.send('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text: full.slice(had.length) } });
        this.maybeCommit();
      }
    } else if (t === 'response.reasoning_text.delta' || t === 'response.reasoning_summary_text.delta') {
      // 思考内容也转发给客户端(glm/qwen 系思考关不掉,这正是它们的价值;丢弃会让客户端
      // 花了 reasoning token 的钱却看不见过程)。两种事件名:tokenrhythm 实测用前者,
      // OpenAI 标准是后者
      if (typeof ev.delta === 'string' && ev.delta) {
        const key = this.keyOf(ev, null);
        this.thinkingBlock(key);
        this.texts.set(key, (this.texts.get(key) || '') + ev.delta);
        this.send('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'thinking_delta', thinking: ev.delta } });
        this.maybeCommit();
      }
    } else if (t === 'response.reasoning_text.done' || t === 'response.reasoning_summary_text.done') {
      // 同 output_text.done:载荷在 ev.text,但只有增量给过就绝不重复补发
      const key = this.keyOf(ev, null);
      this.thinkingBlock(key);
      const full = typeof ev.text === 'string' ? ev.text : '';
      const had = this.texts.get(key) || '';
      if (full && full !== had && full.startsWith(had)) {
        this.texts.set(key, full);
        this.send('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'thinking_delta', thinking: full.slice(had.length) } });
        this.maybeCommit();
      }
    } else if (t === 'response.function_call_arguments.delta') {
      this.toolState(this.keyOf(ev, null)).args += ev.delta || '';
    } else if (t === 'response.function_call_arguments.done') {
      // 官方事件,载荷在 ev.arguments(完整串)。只在增量没法用、而它确实给了完整参数时采纳。
      // 这里比文本那条松一档:增量可能是错的(交错拼串),完整串永远更好,所以"不同就覆盖"。
      const st = this.toolState(this.keyOf(ev, null));
      const full = typeof ev.arguments === 'string' ? ev.arguments : '';
      if (full && full !== st.args) st.args = full;
    } else if (t === 'response.output_item.done') {
      const item = ev.item || {};
      const key = this.keyOf(ev, item);
      // 载荷只出现在 item 里的上游(一个 delta 都不发):把 item 当权威补齐。
      // 不补的话客户端拿到的是空正文 / 空思考 / input:{} 的空工具调用——
      // 一个"语法完全正确但什么也没说"的 200,比报错难查得多。
      if (item.type === 'message') {
        const full = (Array.isArray(item.content) ? item.content : [])
          .map(c => (c && c.type === 'output_text' && typeof c.text === 'string') ? c.text : '').join('');
        const had = this.texts.get(key) || '';
        if (full && full !== had && full.startsWith(had)) {
          this.texts.set(key, full);
          this.textBlock(key);
          this.send('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text: full.slice(had.length) } });
          this.maybeCommit();
        }
      } else if (item.type === 'reasoning') {
        const full = reasoningTextOf(item);
        const had = this.texts.get(key) || '';
        if (full && full !== had && full.startsWith(had)) {
          this.texts.set(key, full);
          this.thinkingBlock(key);
          this.send('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'thinking_delta', thinking: full.slice(had.length) } });
          this.maybeCommit();
        }
      } else if (item.type === 'function_call') {
        const st = this.toolState(key);
        st.id = st.id || item.call_id || item.id || '';
        st.name = st.name || item.name || '';
        // item.arguments 可能是对象(个别网关),统一成字符串再攒
        const full = argsRawOf(item.arguments);
        if (full && full !== st.args) st.args = full;
        if (!st.emitted) this.emitTool(key);
      }
    }
  }
  feed(chunk) {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.buf += text;
    const { events, rest } = parseSseEvents(this.buf);
    this.buf = rest;
    for (const ev of events) {
      this.handle(ev);
      if (this.finished) { this.buf = ''; return; }
    }
  }
}

// 整段 SSE 文本 → 事件数组 + 消费剩的半帧。feed 逐块喂、collectAnthropicMessage 收完整段,
// 两处共用同一套分帧规则(空行分隔,CRLF/CR/LF 都算换行,只认 \n\n 会整条丢掉 CRLF 流)
function parseSseEvents(text) {
  const events = [];
  let buf = text;
  for (;;) {
    const m = /\r\n\r\n|\n\n|\r\r/.exec(buf);
    if (!m) break;
    const raw = buf.slice(0, m.index);
    buf = buf.slice(m.index + m[0].length);
    const data = [];
    for (const line of raw.split(/\r\n|\n|\r/)) {
      if (!line || line[0] === ':') continue; // 注释行(含上游心跳)
      const c = line.indexOf(':');
      if (c === -1) continue;
      if (line.slice(0, c) !== 'data') continue;
      let v = line.slice(c + 1);
      if (v[0] === ' ') v = v.slice(1);
      data.push(v);
    }
    if (!data.length) continue;
    const payload = data.join('\n').trim();
    if (!payload || payload === '[DONE]') continue;
    try { events.push(JSON.parse(payload)); } catch { /* 半截 JSON 忽略 */ }
  }
  return { events, rest: buf };
}

// 一段完整的 Anthropic SSE 响应 → 整包 message 对象。
// 「上游恒流式、客户端要非流」的收尾用:收完的流攒成一条 JSON 消息回给客户端,
// 形状与上游直回非流 JSON 时一致。usage 以 message_delta 的终态值为准(与 message_start 合并)。
function collectAnthropicMessage(text) {
  const msg = { id: '', type: 'message', role: 'assistant', model: '', content: [],
    stop_reason: null, stop_sequence: null, usage: {} };
  let sawStart = false, sawStop = false;
  for (const ev of parseSseEvents(text).events) {
    const t = ev && ev.type;
    if (t === 'error') {
      const detail = ev.error && (ev.error.message || ev.error.type);
      throw new Error(detail || '上游返回错误事件');
    }
    if (t === 'message_start' && ev.message) {
      sawStart = true;
      const { content, usage, ...rest } = ev.message;
      Object.assign(msg, rest);
      if (usage) msg.usage = { ...msg.usage, ...usage };
    } else if (t === 'content_block_start' && ev.content_block) {
      const block = { ...ev.content_block };
      if (block.type === 'tool_use') block.input = '';
      msg.content[ev.index] = block; // 按序号对位,中间空档收尾时压掉
    } else if (t === 'content_block_delta' && ev.delta) {
      const block = msg.content[ev.index];
      if (!block) continue;
      if (ev.delta.type === 'text_delta') block.text = (block.text || '') + (ev.delta.text || '');
      else if (ev.delta.type === 'input_json_delta') block.input = (block.input || '') + (ev.delta.partial_json || '');
      // thinking 线(chat 上游的思考转发)也要按块对位累积,否则"上游流式、客户端要非流"的
      // 攒包路径会把思考块攒成空壳
      else if (ev.delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + (ev.delta.thinking || '');
      else if (ev.delta.type === 'signature_delta') block.signature = ev.delta.signature || '';
    } else if (t === 'message_delta') {
      if (ev.delta) {
        if (ev.delta.stop_reason != null) msg.stop_reason = ev.delta.stop_reason;
        if (ev.delta.stop_sequence !== undefined) msg.stop_sequence = ev.delta.stop_sequence;
      }
      if (ev.usage) msg.usage = { ...msg.usage, ...ev.usage }; // 流末尾这次才是终态真值
    } else if (t === 'message_stop') sawStop = true;
  }
  if (!sawStart || !sawStop) throw new Error('上游 Anthropic 流缺少完整终态');
  msg.content = msg.content.filter(Boolean);
  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      try { block.input = JSON.parse(block.input || '{}'); }
      catch { throw new Error('上游工具参数不是完整 JSON'); }
    }
  }
  return msg;
}

// 「上游恒流式、客户端要非流」的内存响应端:relayAnthropicStream 只管往 res 写,
// 给它一个能 write/end 的假对象,收完用 text() 把整段 SSE 拿去重建 message
function memorySink() {
  const parts = [];
  return {
    res: {
      headersSent: true, writableEnded: false, destroyed: false,
      write(c) { parts.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); return true; },
      end() { this.writableEnded = true; },
    },
    text: () => Buffer.concat(parts).toString('utf8'),
  };
}

// 上游还没给出任何内容事件前,先攒着不写客户端:这样发现是错误体(5xx 文本/error 事件)
// 还能整条重试;一旦是正常内容就 commit,后面只做转换不再回头。
// 200 状态一样可能夹带错误(渠道池打满等),这些在 commit 之前要认出来。
//
// **只按协议形状认,不按错误文案认**。以前这里还拿 'Could not find an existing deployment'
// 这个文案做子串匹配,结果正常回答里引用这句报错(排查这类问题的对话正是如此)会被判成
// 上游失败:没写出字节就整条重试、客户端拿到重复请求,已经提交的流还会被掐成 aborted。
// 文案是上游可变的实现细节,不是协议信号——把它删掉。
// 这里比 wire-chat 的同名函数保守:responses 的 SSE 帧就是 `data: {…}`(没有 event: 行),
// 不能拿"出现过 data: 行"当"确实是流"的判据,否则错误体稍晚到达时先到的帧会把检查关掉。
// 改为只在攒下的文本**整体**就是个错误对象时才认——JSON 解析失败或开头不是 error/failed
// 一律放行,正常内容不会误伤。
function terminalError(buffer) {
  const text = String(buffer || '').trim();
  if (!text) return null;
  let j = null;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const msgOf = e => (typeof e === 'string' ? e : (e && (e.message || e.type)) || '');
  if (j.error) return String(msgOf(j.error) || '上游返回错误').slice(0, 200);
  if (j.type === 'error') return String(msgOf(j.error) || j.message || '上游返回错误').slice(0, 200);
  if (j.status === 'failed' || j.status === 'cancelled') {
    return String(msgOf(j.error) || `上游以 status=${j.status} 结束了这条响应`).slice(0, 200);
  }
  return null;
}

// emitAnthropicSse 收到的 message.usage **已经是 Anthropic 口径**了(它是
// responsesToAnthropic / chatToAnthropic 的产物)。以前这里让 AnthropicStream 用默认的
// usageOf(Responses 口径)再过一遍,结果是:input_tokens_details 不存在 → cached 记 0 →
// message_delta 里的 cache_read_input_tokens 被整个丢掉(实测 1000/400 的响应到了客户端
// 只剩 input_tokens:600,缓存命中凭空消失);而万一真带着 cached_tokens 字段,还会把
// input_tokens 二次扣减。这里按形状判:带 input_tokens_details / total_tokens 的是 Responses
// 口径,才走 usageOf。
function asAnthropicUsage(u) {
  if (!u || typeof u !== 'object') return { input_tokens: 0, output_tokens: 0 };
  if ('input_tokens_details' in u || 'total_tokens' in u) return usageOf(u);
  const cached = Number(u.cache_read_input_tokens) || 0;
  return {
    input_tokens: Number(u.input_tokens) || 0,
    output_tokens: Number(u.output_tokens) || 0,
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  };
}

// 客户端要流、上游却整包回 JSON 时,把完整消息摊成 Anthropic SSE 序列,别让客户端干等
function emitAnthropicSse(res, message, headers = {}, onCommit = null) {
  const stream = new AnthropicStream(res, message.model, {
    usageOf: asAnthropicUsage,
    onCommit: () => {
      try {
        if (!res.headersSent) res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      } catch {}
      if (onCommit) { try { onCommit(); } catch {} }
    },
  });
  stream.usage = message.usage || null;
  for (const block of message.content || []) {
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // 思考块摊成 SSE(chat 转换线会产出;signature 是占位,回传时由转换层丢弃)
      stream.openBlock(`k${stream.index + 1}`, 'thinking');
      if (block.thinking) stream.send('content_block_delta', { type: 'content_block_delta', index: stream.index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      stream.send('content_block_delta', { type: 'content_block_delta', index: stream.index, delta: { type: 'signature_delta', signature: block.signature || '' } });
      stream.closeBlock();
    } else if (block.type === 'text') {
      stream.openBlock(`t${stream.index + 1}`, 'text');
      stream.send('content_block_delta', { type: 'content_block_delta', index: stream.index, delta: { type: 'text_delta', text: block.text || '' } });
      stream.closeBlock();
    } else if (block.type === 'tool_use') {
      stream.openBlock(`u${stream.index + 1}`, 'tool_use', { id: block.id, name: block.name });
      stream.toolCount++;
      const raw = argsRawOf(block.input ?? {}) || '{}';
      if (raw !== '{}') stream.send('content_block_delta', { type: 'content_block_delta', index: stream.index, delta: { type: 'input_json_delta', partial_json: raw } });
      stream.closeBlock();
    }
  }
  stream.finishTerminal(message.stop_reason === 'max_tokens' ? 'incomplete' : 'completed');
  try { if (!res.writableEnded) res.end(); } catch {}
  return stream;
}

// AnthropicStream / parseSseEvents / imageUrlOf / toolArgs* 同时供 wire-chat.js 复用:
// 终态状态机与块串行纪律只有一份实现,chat 线只做事件映射,不再另起一套。

// 转发骨架(Promise 包装/提交时机/收尾顺序/三个传输事件)与 chat 线共用,见 lib/upstream-relay.js;
// 本函数只保留 responses 特有的两件事:怎么喂(conv.feed)、没等到终态就结束算什么。
function relayAnthropicStream(upRes, res, model, { mayRetry = false, headers = {}, onCommit = null, tools = null } = {}) {
  return relaySkeleton(upRes, res, model, {
    mayRetry, headers, onCommit,
    terminalError,
    // usage 按 Anthropic 口径交回:input 已扣掉缓存命中,cache_read 单独给(见 usageOf)
    toUsage: usageOf,
    makeStream: (r, m, hooks) => new AnthropicStream(r, m, { ...hooks, tools }),
    onText: (conv, text) => { try { conv.feed(text); } catch { /* 半截 JSON 忽略,feed 自己兜 */ } },
    // 骨架在调 onEnd 前已判过 settled/finished,这里等同原来的 transportDead
    onEnd: conv => conv.abort('上游流没有给出终态就结束了'),
  });
}

module.exports = { anthropicToResponses, responsesToAnthropic, responsesErrorOf, relayAnthropicStream, emitAnthropicSse, collectAnthropicMessage, memorySink, stripModelSuffix, memoryDrop, AnthropicStream, parseSseEvents, imageUrlOf, toolArgsOk, toolArgsValue };
