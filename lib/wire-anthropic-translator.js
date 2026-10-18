'use strict';
// 「claude 客户端 + {Chat, Responses} 上游 = 本地翻译」两条转发路径的**共用收尾**。
//
// 背景:这两条分支在 mixrouter.js 里原本各写一遍,逐字节相同的部分约 55 行,只有两个
// 转换函数不同(chatErrorOf/chatToAnthropic vs responsesErrorOf/responsesToAnthropic)。
// 原地的注释自己都点明了两次「(chat 转换分支与本分支同构,改动要同步)」——
// 靠人眼维持同步的重复,正是本仓库反复吃亏的那类。本模块把那一段收敛成一处,
// 两条线各自只传自己的两个函数;上游各自少一处「改一条线漏另一条线」的口子。
//
// 这里**只搬运,不改语义**。抽取前后的等价性在开发期用独立脚本对照取证过
// (提取前后各跑一次,比客户端字节与 requests.jsonl 条目),那些脚本属内部记录,不随仓库发布。

const wireResponses = require('./wire-responses');
const { upstreamErrorText } = require('./upstream-error-text');
// errLine / clip 的回落实现。转发线(mixrouter.js)把这两个函数**注入**进来,传的正是
// lib/observability/err-text.js 的同名函数;本模块默认走同一份,两种调用方式落出的字节相同。
const { errLine: defaultErrLine, clip: defaultClip } = require('./observability/err-text');

// deps: { convertError(payload), convertMessage(payload, model) }
//   convertError   —— 从上游整包 JSON 里认出"HTTP 200 但其实是失败",返回错误对象或 null
//   convertMessage —— 把上游整包 JSON 翻成 Anthropic message
function createAnthropicTranslator(deps) {
  const { convertError, convertMessage } = deps;

  // 上游整包回了 4xx/5xx(还没进流):把它的错误体翻成 Anthropic 错误回给客户端。
  //
  // 这一段在 chat 与 responses 两条翻译线里**逐字节相同 16 行**,调用点只差外层的守卫
  // 与收尾的 return。两条线对上游错误的处理没有任何理由不同 —— 客户端看到的都是
  // Anthropic Messages 接口,上游是哪家协议不该改变错误形状。
  //
  // 顺序不能动:`entry.err` 必须在 finishEntry() **之前**赋值,它负责把这一条写进
  // requests.jsonl;反了就会重现「日志记 200、客户端拿 502」那类故障。
  // 落日志用 errLine(纯截断),**不是** errLineOrPlaceholder —— 两种写法各有其分支,
  // 见 lib/observability/err-text.js 的说明,不能合并。
  //
  // ctx: { entry, res, headers, text, finishEntry, errLine, clip, status }
  //   errLine / clip 是**可选注入**:转发线传 err-text.js 的同名实现,单测与旧调用方不传时
  //   回落到同一份默认实现。两者落出的字节相同,所以注入与否不影响契约。
  function replyUpstreamError(ctx) {
    const { entry, res, headers, text, finishEntry, status } = ctx;
    const errLine = ctx.errLine || defaultErrLine;
    const clip = ctx.clip || defaultClip;
    const msg = upstreamErrorText(text);
    // 上游给的原因要落进日志,否则事后只剩一个光秃秃的状态码
    entry.err = errLine(status, msg);
    finishEntry();
    if (res.headersSent) { try { res.end(); } catch {} return; }
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: clip(msg) } }));
  }

  // 上游以流式回、客户端要非流:把攒下的 SSE 收成整包再回。
  // 只有在**完整终态**可重建时才回 200;断流、解析失败、工具参数残缺一律 502 ——
  // 不能把残缺 SSE 伪装成成功 JSON。
  //
  // ctx(全部由调用方在闭包外算好,本模块不碰转发状态):
  //   { entry, res, headers, model, clientClosed, sink, r: {aborted, detail, usage},
  //     finishEntry, disarmIdle, setResponseDone, collect }
  //   兼容两种调用方:转发线传 r 且注入 disarmIdle / setResponseDone;
  //   不传这些的调用方(单测、旧调用方)按 r 的别名 result 读结果,跳过关看门狗那两步 ——
  //   两步都只在"调用方持有看门狗"时才有意义,没有就不该凭空造一个。
  function endBufferedStream(ctx) {
    const { entry, res, headers, model, clientClosed, sink, finishEntry } = ctx;
    const r = ctx.r || ctx.result || null;
    // 终态已定:响应体与空闲看门狗都不该再判这一笔(否则夭折会被二次记成连接中断)
    if (typeof ctx.setResponseDone === 'function') ctx.setResponseDone();
    if (typeof ctx.disarmIdle === 'function') ctx.disarmIdle();
    // 客户端自己断的不算渠道的账(那是取消);上游真夭折才记这一笔
    if (r && r.aborted && !clientClosed) {
      entry.err = entry.err || r.detail || '上游流中断';
      entry.err_class = entry.err_class || 'stream_aborted';
    }
    const u = (r && r.usage) || {};
    let msg = null, parseError = null;
    if (sink && r && !r.aborted) {
      try { msg = wireResponses.collectAnthropicMessage(sink.text()); }
      catch (e) { parseError = e; }
    }
    const willFail = !!(sink && !res.headersSent && !clientClosed && !msg);
    if (willFail || (sink && (parseError || (r && r.aborted)))) {
      entry.status = 502;
      entry.err = entry.err || (parseError && parseError.message) || (r && r.detail) || '上游流中断';
      entry.err_class = entry.err_class || 'stream_aborted';
    }
    // 客户端最终拿到的状态码必须**先**算进 entry 再写日志:以前 finishEntry() 在前、
    // res.writeHead(502) 在后,requests.jsonl 里记着 200 而客户端手里是 502。
    // requests.jsonl 是渠道健康与用量审计的唯一依据,这种倒置会让一整类客户端可见的
    // 故障在日志里直接消失。
    finishEntry({
      in: u.input_tokens || 0, out: u.output_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0,
    });
    if (sink && !res.headersSent && !clientClosed) {
      if (!willFail) {
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
        try { return res.end(JSON.stringify(msg)); } catch { return; }
      }
      try {
        res.writeHead(502, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: entry.err || '上游流中断' } }));
      } catch {}
    }
    // model / collect 由调用方备着,本函数当前不用它们(攒包输出不含模型名)
    void model; void ctx.collect;
  }

  // 上游整包回了 JSON(非流式上游,或流式请求但上游给整包)。
  // HTTP 200 里包着 error / 工具参数残缺时回 Anthropic error,
  // 不能翻成一条 content 为空的"正常消息"。
  function endWholeJson(ctx) {
    const { entry, res, headers, model, bodyStream, text, finishEntry, startKeepAlive } = ctx;
    let msg = null, rerr = null;
    try {
      const j = JSON.parse(text);
      rerr = convertError(j);
      if (!rerr) msg = convertMessage(j, model, { tools: ctx.tools });
    } catch { /* 非 JSON 原样透传 */ }
    if (rerr) {
      entry.status = 502; // 记客户端真正拿到的状态:200 里包着的失败不是成功
      entry.err = rerr.message; entry.err_class = entry.err_class || 'upstream_server';
      finishEntry();
      if (res.headersSent) { try { res.end(); } catch {} return; }
      res.writeHead(502, { ...headers, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: rerr }));
    }
    const u = (msg && msg.usage) || {};
    finishEntry({ in: u.input_tokens || 0, out: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0 });
    if (res.headersSent) return;
    try {
      // 客户端要流、上游却整包回 JSON:摊成 Anthropic SSE,别让 Claude Code 干等
      if (msg && bodyStream) wireResponses.emitAnthropicSse(res, msg, headers, startKeepAlive);
      else { res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); res.end(msg ? JSON.stringify(msg) : text); }
    } catch {}
  }

  return { endBufferedStream, endWholeJson, replyUpstreamError };
}

module.exports = { createAnthropicTranslator };
