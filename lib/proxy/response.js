'use strict';
// 响应分派:选**已有**的转换器,把上游响应变成客户端响应,并把这一发的终态交给调用方。
//
// 等价搬自 mixrouter.js 的 proxyHandler 响应段(第二期重构的 dispatchResponse 一行;
// 内部规划记录不随仓库发布)。
//
// 这里**只**做三件事:
//   1. 按 (客户端协议, 上游协议) 选转换器 —— 不新建协议层,复用 wire-chat / wire-responses /
//      wire-openai-bridge 与 lib/wire-anthropic-translator.js 的收尾;
//   2. 判完整性:合法协议终态(SSE 终态帧、完整 JSON)才算成功,200 头不算;
//   3. 把 usage / 完整性 / 错误 / 是否已提交 通过窄接口交回去。
// 它**不**决定换渠道、不读写全局配置、不申请或持有健康许可 —— 同渠道重试只以
// `a.retrySame(detail, afterRetry)` 的形式向上提,是否真的重试由调度层决定。
//
// 已提交给客户端的字节会关闭透明重试窗口:每条分支都在**写头之前**把可重试窗口用掉,
// 之后只做收尾(见 test/timeout-budget.test.js 的 commitThenSlow 用例)。

const { resourceBindingError } = require('../resource-recovery');

// Native Chat JSON→SSE: keep every choice, tool call and upstream-provided
// reasoning field. Usage is its own trailing chunk, before the real [DONE] marker.
function emitChatSse(res, json, headers) {
  res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const { choices, usage, ...metadata } = json;
  const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
  for (const [position, choice] of choices.entries()) {
    const { message, finish_reason, ...rest } = choice;
    const delta = { ...message };
    if (Array.isArray(delta.tool_calls)) delta.tool_calls = delta.tool_calls.map((call, index) => ({ ...call, index }));
    send({ ...metadata, object: 'chat.completion.chunk', choices: [{ ...rest, index: choice.index ?? position, delta, finish_reason: null }] });
    send({ ...metadata, object: 'chat.completion.chunk', choices: [{ ...rest, index: choice.index ?? position, delta: {}, finish_reason }] });
  }
  if (usage) send({ ...metadata, object: 'chat.completion.chunk', choices: [], usage });
  res.end('data: [DONE]\n\n');
}

// Preserve all native Responses parts, not only the first message text supported
// by the Chat bridge's emitter. Every delta is backed by a real upstream JSON field.
function emitNativeResponsesSse(res, response, headers) {
  res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let sequence = 0;
  const send = event => res.write(`data: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
  const initial = { ...response, status: 'in_progress', output: [], usage: null };
  send({ type: 'response.created', response: initial });
  send({ type: 'response.in_progress', response: initial });
  for (const [output_index, item] of response.output.entries()) {
    const position = { item_id: item.id, output_index };
    send({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress',
      ...(item.type === 'message' ? { content: [] } : {}),
      ...(item.type === 'reasoning' ? { summary: [], ...(item.content ? { content: [] } : {}) } : {}),
      ...(item.type === 'function_call' ? { arguments: '' } : {}),
      ...(item.type === 'custom_tool_call' ? { input: '' } : {}) } });
    if (item.type === 'message') for (const [content_index, part] of (item.content || []).entries()) {
      const at = { ...position, content_index };
      const refusal = part.type === 'refusal';
      const field = refusal ? 'refusal' : 'text';
      const value = part[field];
      send({ type: 'response.content_part.added', ...at, part: { ...part, ...(typeof value === 'string' ? { [field]: '' } : {}) } });
      if ((part.type === 'output_text' || refusal) && typeof value === 'string') {
        const name = refusal ? 'refusal' : 'output_text';
        if (value) send({ type: `response.${name}.delta`, ...at, delta: value });
        send({ type: `response.${name}.done`, ...at, [field]: value });
      }
      send({ type: 'response.content_part.done', ...at, part });
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const custom = item.type === 'custom_tool_call';
      const name = custom ? 'custom_tool_call_input' : 'function_call_arguments';
      const field = custom ? 'input' : 'arguments';
      const value = item[field];
      if (typeof value === 'string' && value) send({ type: `response.${name}.delta`, ...position, delta: value });
      send({ type: `response.${name}.done`, ...position, [field]: value });
    }
    if (item.type === 'reasoning') {
      for (const [summary_index, part] of (item.summary || []).entries()) {
        const at = { ...position, summary_index };
        send({ type: 'response.reasoning_summary_part.added', ...at, part: { ...part, text: '' } });
        if (part.text) send({ type: 'response.reasoning_summary_text.delta', ...at, delta: part.text });
        send({ type: 'response.reasoning_summary_text.done', ...at, text: part.text || '' });
        send({ type: 'response.reasoning_summary_part.done', ...at, part });
      }
      for (const [content_index, part] of (item.content || []).entries()) {
        if (typeof part.text !== 'string') continue;
        const at = { ...position, content_index };
        if (part.text) send({ type: 'response.reasoning_text.delta', ...at, delta: part.text });
        send({ type: 'response.reasoning_text.done', ...at, text: part.text });
      }
    }
    send({ type: 'response.output_item.done', output_index, item });
  }
  send({ type: `response.${response.status}`, response });
  res.end();
}

// Native Chat SSE→JSON for an explicit upstream-stream override. Unlike the
// Anthropic bridge this collector keeps Chat's choices and usage in their own shape.
function collectChatJson(text) {
  const result = { object: 'chat.completion', choices: [] };
  const choices = new Map();
  let terminal = false;
  for (const frame of text.split(/\r\n\r\n|\n\n|\r\r/)) {
    const raw = frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
    if (!raw) continue;
    if (raw === '[DONE]') { terminal = true; break; }
    const chunk = JSON.parse(raw);
    if (chunk.error) throw new Error(chunk.error.message || 'Chat 上游返回流式错误');
    const { choices: deltas, object, ...metadata } = chunk;
    Object.assign(result, metadata);
    for (const incoming of deltas || []) {
      const index = incoming.index ?? 0;
      let choice = choices.get(index);
      if (!choice) {
        choice = { index, message: { role: 'assistant', content: '' }, finish_reason: null };
        choices.set(index, choice);
      }
      const { delta = {}, index: ignored, ...rest } = incoming;
      Object.assign(choice, rest);
      for (const [field, value] of Object.entries(delta)) {
        if (field === 'tool_calls') {
          choice.message.tool_calls ||= [];
          for (const call of value || []) {
            const at = call.index ?? 0;
            const target = choice.message.tool_calls[at] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (call.id) target.id = call.id;
            if (call.type) target.type = call.type;
            for (const [key, part] of Object.entries(call.function || {})) target.function[key] = (target.function[key] || '') + part;
          }
        } else if (field === 'function_call') {
          choice.message.function_call ||= { name: '', arguments: '' };
          for (const [key, part] of Object.entries(value || {})) choice.message.function_call[key] += part;
        } else if (typeof value === 'string' && field !== 'role') choice.message[field] = (choice.message[field] || '') + value;
        else if (value !== null) choice.message[field] = value;
      }
    }
  }
  result.choices = [...choices.values()].sort((a, b) => a.index - b.index);
  if (!result.choices.length || (!terminal && result.choices.some(choice => !choice.finish_reason)))
    throw new Error('Chat 上游流缺少完整终态');
  for (const choice of result.choices) if (choice.message.tool_calls) choice.message.tool_calls = choice.message.tool_calls.filter(Boolean);
  return result;
}

function createResponder(deps) {
  const {
    collect, createAnthropicTranslator, extractUsageFor, extractUsageOpenAI, sseResult,
    upstreamErrorText, errBodyText, errLine, errLineOrPlaceholder, clip,
    wireChat, wireResponses, wireOpenai,
  } = deps;
  const { chatJsonToResponses, emitResponsesSse, streamChatAsResponses } = wireOpenai;

  // 只认已观察到的瞬时空失败,不凭 message 文本猜限流/鉴权/策略错误。缺 output
  // 也不等于空输出,尤其不能重放已经出现过正文、推理或任何工具事件的流。
  const emptyUpstreamFailure = response => response?.status === 'failed'
    && response.error?.code === 'upstream_error' && Array.isArray(response.output) && !response.output.length;
  const lifecycleOnly = event => ['response.created', 'response.in_progress', 'response.queued'].includes(event?.type)
    && !event.error && !event.response?.error && !['failed', 'completed', 'incomplete'].includes(event.response?.status)
    && (!event.response?.output || (Array.isArray(event.response.output) && !event.response.output.length));
  const retryEmpty = (a, response) => emptyUpstreamFailure(response) && !resourceBindingError(response)
    && typeof a.retryNativeEmpty === 'function' && a.retryNativeEmpty(response.error.message || 'Upstream request failed');

  function uncommittedErrorFrame(text) {
    if (Buffer.byteLength(text) > 64 * 1024) return null;
    let terminal = null;
    for (const raw of text.split(/\r\n\r\n|\n\n|\r\r/)) {
      if (!raw.trim()) continue;
      if (terminal) return null;
      const { events } = wireResponses.parseSseEvents(raw + '\n\n');
      if (!events.length) {
        if (raw.split(/\r\n|\n|\r/).some(line => line && line[0] !== ':')) return null;
        continue;
      }
      if (events.length !== 1) return null;
      const event = events[0];
      if (lifecycleOnly(event)) continue;
      if (!['error', 'response.failed'].includes(event?.type)
          || (event.response?.output && (!Array.isArray(event.response.output) || event.response.output.length))) return null;
      terminal = event;
    }
    return terminal;
  }

  // 直通仅暂存一个有界前缀。生命周期/注释不提交;任何正文、工具、未知/坏帧或超限
  // 都立刻逐字转发并永久关掉重试窗口。usage 与终态仍由既有采样/检测器收尾。
  function relayNativeResponses(a) {
    const { StringDecoder } = require('node:string_decoder');
    const decoder = new StringDecoder('utf8');
    let pending = '', chunks = [], bytes = 0, committed = false, retried = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      if (a.clientClosed || a.res.destroyed || a.res.writableEnded) return;
      a.res.writeHead(a.cres.statusCode, a.outHeaders);
      a.startKeepAlive();
      for (const chunk of chunks) a.res.write(chunk);
      chunks = []; pending = '';
    };
    collect.headTailUsage(a.cres, { write(chunk) {
      if (retried) return;
      if (committed) return a.res.write(chunk);
      chunks.push(chunk); bytes += chunk.length;
      if (bytes > 64 * 1024) return commit();
      pending += decoder.write(chunk);
      for (;;) {
        const boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending);
        if (!boundary) break;
        const raw = pending.slice(0, boundary.index + boundary[0].length);
        pending = pending.slice(raw.length);
        const { events } = wireResponses.parseSseEvents(raw);
        if (!events.length) {
          if (raw.split(/\r\n|\n|\r/).some(line => line && line[0] !== ':')) return commit();
          continue;
        }
        const event = events[0];
        if (lifecycleOnly(event)) continue;
        if (['error', 'response.failed'].includes(event?.type) && !pending.trim()
            && (!event.response?.output || (Array.isArray(event.response.output) && !event.response.output.length))
            && typeof a.retryResourceBinding === 'function' && a.retryResourceBinding(event)) {
          retried = true; chunks = []; pending = '';
          return;
        }
        if (event?.type === 'response.failed' && !pending.trim() && retryEmpty(a, event.response)) {
          retried = true; chunks = []; pending = '';
          return;
        }
        return commit();
      }
    } }, text => {
      if (retried || a.clientClosed || a.res.destroyed) return;
      commit();
      const result = sseResult('responses', text);
      if (!result.ok) { a.entry.err = a.entry.err || result.error; a.entry.err_class = a.entry.err_class || 'stream_aborted'; }
      a.finishEntry(extractUsageFor('responses', text));
      try { a.res.end(); } catch {}
    });
  }

  // a:单次 attempt 的响应句柄(由 lib/proxy/attempt.js 建好并传入)。它给出:
  //   cres/isSse/conv/wire/ep/app/body/entry/model/provider/sess/resolved/outHeaders
  //   finishEntry(usage)   —— 写这一发的唯一终态(幂等)
  //   sendErr / startKeepAlive / disarmIdle / markResponseDone
  //   clientClosed / deadlineHit(只读)  convRetriesLeft / retrySame(detail, afterRetry)
  // 顺序**不能**动:entry.err 与 entry.status 必须在 finishEntry() 之前赋值 ——
  // 它负责把这一条写进 requests.jsonl,反了就会重现「日志记 200、客户端拿 502」那类故障。
  function dispatchResponse(a) {
    const { cres, res, entry, body, wire, conv, ep, provider, model } = a;
    const epKind = ep.kind;

    // Inspect only a small HTTP400 prefix before the existing error formatter gets
    // it. Oversized errors immediately resume normal dispatch; no full extra copy.
    if (cres.statusCode === 400 && epKind !== 'responses/compact' && !a.resourceChecked
        && typeof a.retryResourceBinding === 'function') {
      if (typeof a.markResourcePrefixPending === 'function') a.markResourcePrefixPending(true);
      const { StringDecoder } = require('node:string_decoder');
      const decoder = new StringDecoder('utf8');
      let parts = [], bytes = 0, replay = null, prefix = '', stopped = false;
      const resume = () => {
        if (typeof a.markResourcePrefixPending === 'function') a.markResourcePrefixPending(false);
        const { PassThrough } = require('node:stream');
        replay = new PassThrough();
        replay.statusCode = cres.statusCode; replay.headers = cres.headers;
        dispatchResponse({ ...a, cres: replay, resourceChecked: true });
        for (const part of parts) replay.write(part);
        parts = [];
      };
      cres.on('data', chunk => {
        if (stopped) return;
        if (replay) { replay.write(chunk); return; }
        parts.push(chunk); bytes += chunk.length;
        if (bytes > 64 * 1024) { resume(); return; }
        if (a.isSse) {
          prefix += decoder.write(chunk);
          const boundary = /\r\n\r\n|\n\n|\r\r/.exec(prefix);
          if (boundary && /(?:\r\n\r\n|\n\n|\r\r)\s*$/.test(prefix)) {
            const terminal = uncommittedErrorFrame(prefix);
            // An actual error frame is enough: never wait for an unbounded EOF.
            if (terminal && a.retryResourceBinding(terminal)) { stopped = true; parts = []; prefix = ''; }
          }
        }
      });
      cres.once('end', () => {
        if (stopped) return;
        if (replay) { replay.end(); return; }
        if (a.clientClosed || res.destroyed || res.writableEnded) { parts = []; return; }
        const text = Buffer.concat(parts).toString('utf8');
        const terminal = a.isSse ? uncommittedErrorFrame(text) : null;
        if (a.retryResourceBinding(terminal || text)) { parts = []; return; }
        resume(); replay.end();
      });
      return { mode: 'resource/error-prefix' };
    }

    // responses 客户端 + chat 上游 = 现场翻译(错误体已是 OpenAI 形状,原样透传)
    if (wire === 'chat' && epKind === 'responses') {
      if (cres.statusCode >= 400) {
        collect.bufferText(cres, text => {
          // 同 anthropic 线:上游给的原因要落进日志,否则只剩一个光秃秃的状态码
          entry.err = errLineOrPlaceholder(cres.statusCode, text);
          a.finishEntry(extractUsageOpenAI('chat', text));
          if (!res.headersSent) { try { res.writeHead(cres.statusCode, a.outHeaders); res.end(text); } catch {} }
          else { try { res.end(); } catch {} }
        });
        return { mode: 'chat-to-responses/error-body' };
      }
      if (a.isSse) {
        streamChatAsResponses(cres, res, model, (u, response) => {
          const failed = response.status === 'failed';
          if (failed) {
            entry.err = response.error?.message || 'Chat 上游响应未完整结束';
            entry.err_class = 'stream_aborted';
            if (!res.headersSent) entry.status = 502;
          }
          a.finishEntry({ in: u.input_tokens || 0, out: u.output_tokens || 0,
            cache_read: u.input_tokens_details?.cached_tokens || 0 });
        }, a.outHeaders, body);
      } else {
        collect.bufferText(cres, text => {
          let resp;
          try {
            const json = JSON.parse(text);
            if (!Array.isArray(json?.choices) || !json.choices[0]?.message)
              throw new Error('Chat 上游响应缺少完整结果');
            resp = chatJsonToResponses(json, model, body);
          }
          catch (error) {
            entry.status = 502; entry.err = error.message; entry.err_class = 'protocol_error';
            a.finishEntry(extractUsageOpenAI('chat', text));
            return a.sendErr(502, 'api_error', entry.err, entry.err_class);
          }
          a.finishEntry(extractUsageOpenAI('chat', text));
          if (!res.headersSent) {
            try {
              // 客户端要的是流、上游却整包回 JSON:摊成 SSE 序列发出去,别让 Codex 干等
              if (body.stream !== false) emitResponsesSse(res, resp, a.outHeaders);
              else { res.writeHead(200, a.outHeaders); res.end(JSON.stringify(resp)); }
            } catch {}
          }
        });
      }
      return { mode: 'chat-to-responses' };
    }

    // claude 客户端 + 需翻译的上游 = 现场翻译(响应/SSE 翻回 Anthropic,错误也翻成 Anthropic 形状)。
    // chat 与 responses 两条线**除下表三处外逐字节相同**,原来各写一遍靠注释提醒同步;
    // 现在只有这张表不同:
    //   relay       —— 把上游 SSE 喂给 AnthropicStream 的那个函数
    //   convertXxx  —— 两条线各自的转换函数
    //   afterRetry  —— 同渠道重试前的额外动作:chat 线没有,responses 线要换一代 cache key
    // 判定顺序与拆分前一致:先 chat+messages,再 conv(此时只剩 responses+messages)。
    const translateLine =
      wire === 'chat' && epKind === 'messages'
        ? { relay: wireChat.relayChatStream, convertError: wireChat.chatErrorOf, convertMessage: wireChat.chatToAnthropic, afterRetry: null }
        : conv
          ? { relay: wireResponses.relayAnthropicStream, convertError: wireResponses.responsesErrorOf, convertMessage: wireResponses.responsesToAnthropic,
              afterRetry: a.rotateConvCacheGen }
          : null;
    if (translateLine) {
      const translator = createAnthropicTranslator({
        convertError: translateLine.convertError,
        convertMessage: translateLine.convertMessage,
      });
      if (cres.statusCode >= 400) {
        collect.bufferText(cres, text => translator.replyUpstreamError({
          entry, res, headers: a.outHeaders, text, status: cres.statusCode, finishEntry: a.finishEntry, errLine, clip,
        }));
        return { mode: 'translate/upstream-error' };
      }
      if (a.isSse) {
        // 客户端要非流:上游照发流式,收进内存攒成整包 JSON 再回(见 attempt 里 upstreamStream 的注释)。
        // 心跳注释绝不能开:攒包期间真 res 还没写头,塞进一个字节就把非流响应毁了
        const sink = body.stream ? null : wireResponses.memorySink();
        translateLine.relay(cres, sink ? sink.res : res, model, {
          mayRetry: !res.headersSent && a.convRetriesLeft > 0, headers: a.outHeaders, tools: body.tools,
          onCommit: body.stream ? a.startKeepAlive : null, // 真提交给客户端了,从这一刻起补心跳
        }).then(r => {
          // 客户端已经走了就别再重打一遍:那是在为没人接收的请求烧渠道额度
          if (r && r.retryable && !a.clientClosed && !res.destroyed && !a.deadlineHit) {
            // 可重试 = 上游没给出终态就断了,或给了工具参数残缺之类的坏终态:这是渠道的账,
            // 渠道冷却由调度层按本次失败记账
            return a.retrySame(r.detail || '上游流未给出终态', translateLine.afterRetry);
          }
          // 收尾模块先确认缓冲结果与客户端状态,再写唯一终态。
          return translator.endBufferedStream({
            entry, res, headers: a.outHeaders, model, clientClosed: a.clientClosed, sink, r,
            finishEntry: usage => a.finishEntry(usage),
            disarmIdle: a.disarmIdle, setResponseDone: a.markResponseDone, collect,
          });
        });
        return { mode: 'translate/sse' };
      }
      collect.bufferText(cres, text => {
        let parsed = false;
        try {
          const json = JSON.parse(text);
          parsed = !!json && typeof json === 'object' && !Array.isArray(json);
        } catch {}
        translator.endWholeJson({
          entry, res, headers: a.outHeaders, model, text, tools: body.tools,
          bodyStream: body.stream, startKeepAlive: a.startKeepAlive,
          finishEntry: usage => {
            const valid = parsed && entry.status < 400;
            if (!valid && !entry.err) { entry.err = '上游响应不是有效协议结果'; entry.err_class = 'protocol_error'; }
            a.finishEntry(usage);
          },
        });
      });
      return { mode: 'translate/json' };
    }

    // Native OpenAI transports can differ from the client format under an explicit
    // override. Compact is deliberately excluded: its response is not a Response stream.
    const nativeOpenai = (wire === 'responses' && epKind === 'responses')
      || (wire === 'chat' && epKind === 'chat/completions');
    if (nativeOpenai && cres.statusCode < 400 && ((!a.isSse && body.stream === true)
        || (a.isSse && a.streamOverride && body.stream !== true))) {
      collect.bufferText(cres, text => {
        let json;
        try {
          if (!a.isSse) json = JSON.parse(text);
          else if (wire === 'chat') json = collectChatJson(text);
          else {
            const events = wireResponses.parseSseEvents(text).events;
            const terminal = [...events].reverse().find(event =>
              ['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(event.type));
            const terminalIndex = events.indexOf(terminal);
            const resourceError = uncommittedErrorFrame(text);
            if (resourceError && typeof a.retryResourceBinding === 'function'
                && a.retryResourceBinding(resourceError)) return;
            if (terminal?.type === 'response.failed' && terminalIndex === events.length - 1
                && events.slice(0, terminalIndex).every(lifecycleOnly) && retryEmpty(a, terminal.response)) return;
            if (terminal?.type === 'error' || terminal?.type === 'response.failed')
              throw new Error(terminal.error?.message || terminal.response?.error?.message || 'Responses 上游返回流式错误');
            json = terminal?.response;
          }
          if (wire === 'responses' && !a.isSse && Buffer.byteLength(text) <= 64 * 1024
              && typeof a.retryResourceBinding === 'function'
              && (!json?.output || (Array.isArray(json.output) && !json.output.length))
              && a.retryResourceBinding(json)) return;
          if (wire === 'responses' && !a.isSse && retryEmpty(a, json)) return;
          if (!json || typeof json !== 'object' || Array.isArray(json) || json.error)
            throw new Error(json?.error?.message || '上游响应不是完整协议结果');
          if (wire === 'responses') {
            if (!Array.isArray(json.output) || !['completed', 'incomplete'].includes(json.status))
              throw new Error('Responses 上游响应缺少完整终态');
            const error = wireResponses.responsesErrorOf(json);
            if (error) throw new Error(error.message);
          } else {
            if (!Array.isArray(json.choices) || !json.choices.length || json.choices.some(choice => !choice?.message))
              throw new Error('Chat 上游响应缺少完整结果');
            for (const choice of json.choices) {
              const error = wireChat.chatErrorOf({ choices: [choice] });
              if (error) throw new Error(error.message);
            }
          }
        } catch (error) {
          entry.status = 502; entry.err = error.message; entry.err_class = 'protocol_error';
          a.finishEntry(extractUsageFor(wire, text));
          return a.sendErr(502, 'api_error', entry.err, entry.err_class);
        }
        a.finishEntry(extractUsageFor(wire, a.isSse ? JSON.stringify(json) : text));
        if (res.headersSent || res.destroyed) return;
        if (body.stream === true) {
          if (wire === 'responses') emitNativeResponsesSse(res, json, a.outHeaders);
          else emitChatSse(res, json, a.outHeaders);
        } else {
          res.writeHead(200, { ...a.outHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify(json));
        }
      });
      return { mode: 'openai/adapted-format' };
    }

    // 同协议直通:Anthropic→Anthropic / responses→responses / chat→chat
    // anthropic 线上游恒流式(见 attempt 里 upstreamStream 的注释):客户端要非流时收进内存攒成
    // 整包 JSON 再回,而不是把非流形状透传给上游吃那 120s 首字节死循环
    // Anthropic 线上游拿 SSE 皮回 4xx/5xx:New API 系网关对 stream=true 的请求就是这么回的
    // (实测 agentrouter.org 额池耗尽:HTTP 402 + content-type text/event-stream,body 却是一坨 JSON)。
    // 照消息流去解析只会得出「缺完整终态」,把真实状态码和上游原因一起吞掉,用户看到的是"接口断了"
    // 而不是"额池没了"。这里照 responses 转换分支的做法,直翻成 Anthropic 错误原样说明。
    if (wire === 'anthropic' && cres.statusCode >= 400) {
      collect.bufferText(cres, text => {
        // 取值这段与两条翻译线共用(见 lib/upstream-error-text.js);但**落日志用哪种写法、
        // 回客户端走 sendErr 还是手写错误体,本线有意与那两条不同**(见 err-text.js 的说明)
        const detail = upstreamErrorText(text);
        const why = errBodyText(detail);
        // 日志里也得留下上游给的原因。以前这里只发客户端、不写 entry.err,
        // 于是线上 649 条 5xx 里 613 条 err 是空串——事后翻日志只知道"某渠道 500"，
        // 不知道上游说了什么(限流?模型下线?区域故障?),排查等于从零开始。
        // 必须在 finishEntry() **之前**赋值:它负责把这一条写进 requests.jsonl
        entry.err = errLineOrPlaceholder(cres.statusCode, detail);
        a.finishEntry();
        if (res.headersSent) { try { res.end(); } catch {} return; }
        a.sendErr(cres.statusCode, 'api_error',
          `上游 ${provider.name} 返回 ${cres.statusCode}: ${why}`,
          entry.err_class);
      });
      return { mode: 'anthropic/error-body' };
    }
    if (wire === 'anthropic' && !body.stream && a.isSse) {
      const sink = wireResponses.memorySink();
      cres.on('data', c => sink.res.write(c));
      cres.on('end', () => {
        let msg = null, parseError = null;
        try { msg = wireResponses.collectAnthropicMessage(sink.text()); }
        catch (e) { parseError = e; }
        const u = (msg && msg.usage) || {};
        // 客户端拿不到 200 时状态码要先落进 entry:sendErr 会改 entry.status,但它跑在
        // finishEntry() 之后,那一条日志已经写完了 —— requests.jsonl 里留着 200,客户端
        // 手里是 502。同 conv 分支,顺序反过来。
        // 攒出完整 Anthropic 终态(message_start/message_stop 齐、工具参数完整)才算成功;
        // 解析失败或缺终态是坏流
        const willFail = !res.headersSent && !msg;
        if (parseError || willFail) {
          entry.status = 502;
          entry.err = entry.err || (parseError && parseError.message) || '响应中断';
          entry.err_class = entry.err_class || 'stream_aborted';
        }
        a.finishEntry({ in: u.input_tokens || 0, out: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0 });
        if (res.headersSent) return;
        if (msg) {
          res.writeHead(200, { ...a.outHeaders, 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(msg));
        }
        a.sendErr(502, 'api_error', `上游 ${provider.name} 响应中断: ${entry.err || '缺少完整终态'}`, 'stream_aborted');
      });
      return { mode: 'anthropic/buffered-sse' };
    }
    if (wire === 'responses' && epKind === 'responses' && cres.statusCode < 400) {
      if (a.isSse) relayNativeResponses(a);
      else collect.bufferText(cres, text => {
        let json;
        try { json = JSON.parse(text); } catch {}
        if (Buffer.byteLength(text) <= 64 * 1024 && typeof a.retryResourceBinding === 'function'
            && (!json?.output || (Array.isArray(json.output) && !json.output.length))
            && a.retryResourceBinding(json)) return;
        if (retryEmpty(a, json)) return;
        if (!json || typeof json !== 'object' || json.error || json.status === 'failed') {
          entry.err = json?.error?.message || '上游 200 响应不是有效结果';
          entry.err_class = 'protocol_error';
        }
        a.finishEntry(extractUsageFor(wire, text));
        if (a.clientClosed || res.headersSent || res.destroyed) return;
        res.writeHead(cres.statusCode, a.outHeaders); res.end(text);
      });
      return { mode: 'responses/native' };
    }
    res.writeHead(cres.statusCode, a.outHeaders);
    // 到这一步客户端那条响应已经提交,可以开始补心跳了
    if (a.isSse) a.startKeepAlive();
    if (a.isSse) {
      // 攒样给 usage 用:必须**头尾都留**。原始实现只留前 1MB,而 usage 在流末尾
      // (Anthropic 的真值在 message_delta),长回答一越过 1MB 就整条记成 in=0/out=0
      // —— requests.jsonl 是用量审计的唯一依据,而长回答恰是最贵的那批。
      // 见 lib/upstream-collect.js 的 headTailUsage。
      collect.headTailUsage(cres, res, text => {
        const result = sseResult(wire, text);
        if (!result.ok) { entry.err = entry.err || result.error; entry.err_class = entry.err_class || 'stream_aborted'; }
        a.finishEntry(extractUsageFor(wire, text));
        try { res.end(); } catch {}
      });
    } else {
      collect.bufferAndForward(cres, res, text => {
        const u = extractUsageFor(wire, text);
        // count_tokens 只有输入,别被响应体里别处的数字带偏
        if (epKind === 'count_tokens') u.in = Number((text.match(/"input_tokens"\s*:\s*(\d+)/) || [0, 0])[1]);
          if (!cres.statusCode || cres.statusCode < 400) {
            let valid = false;
            try {
              const json = JSON.parse(text);
              valid = !!json && typeof json === 'object' && !json.error && json.status !== 'failed';
            } catch {}
            if (!valid) { entry.err = entry.err || '上游 200 响应不是有效结果'; entry.err_class = entry.err_class || 'protocol_error'; }
          }
        a.finishEntry(u); try { res.end(); } catch {}
      });
    }
    return { mode: 'passthrough' };
  }

  return { dispatchResponse };
}

module.exports = { createResponder };
