'use strict';
// 「上游 SSE → Anthropic SSE」转发的**骨架**。chat 线(wire-chat.relayChatStream)与
// responses 线(wire-responses.relayAnthropicStream)原本各写一遍,逐行相同的部分有五段:
//   ① Promise 包装 + StringDecoder
//   ② commit:第一次真的产出内容时写响应头(之前还能整条重试)
//   ③ settle:先 resolve 再 res.end 的顺序纪律,可重试时不许 end
//   ④ transportDead:end/close/error 三个事件同一套夭折判定
//   ⑤ 提交前的 rawPre 攒样 + terminalError 试认(200 里夹带的错误体)
// 两条线真正不同的只有两处:**怎么把上游回来的文本喂给 AnthropicStream**,以及
// **上游没给终态就结束**时各线自己的说法。其余全靠注入。
//
// 这里**只搬运,不改语义**。抽取前后的等价性在开发期用独立脚本对照取证过
// (比客户端字节、chunk 切分与 requests.jsonl 条目),那些脚本属内部记录,不随仓库发布。
//
// 本模块**不 require 仓内任何模块**(只 require node 内置 string_decoder):
// wire-chat 与 wire-responses 都要 require 它,任何反向依赖都会成环。

const { StringDecoder } = require('string_decoder');

// opts:
//   mayRetry       一个字节都没写给客户端时,这条 res 还能留给下一次尝试
//   headers        写响应头时附加的头
//   onCommit       真提交给客户端的那一刻(外层据此开心跳)
//   terminalError  (rawPre) => string|null,各线的"这不是流、是错误体"判据(两线不同,必须注入)
//   toUsage        (raw) => Anthropic 口径 usage(chat 与 responses 的换算不同)
//   makeStream     (res, model, hooks) => conv,各线自己 new AnthropicStream
//   onText         (conv, text, ctx) => void,各线自己的喂法
//   onEnd          (conv) => void,上游流结束而终态未定时各线的说法
function relayAnthropicStream(upRes, res, model, opts = {}) {
  const { mayRetry = false, headers = {}, onCommit = null,
    terminalError, toUsage, makeStream, onText, onEnd } = opts;
  return new Promise(resolve => {
    let settled = false, rawPre = '';
    const decoder = new StringDecoder('utf8');
    const commit = () => {
      try {
        if (!res.headersSent) res.writeHead(upRes.statusCode || 200, { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      } catch {}
      // 到这一步才真的提交给客户端了(之前攒在 pre 里,还能整条重试),外层从这一刻起可以补心跳
      if (onCommit) { try { onCommit(); } catch {} }
    };
    // 收尾顺序要紧:先 resolve(外层在 .then 里结算 usage、写日志、置 finalized),
    // 之后才 res.end()。Node 的 close 走 nextTick 队列,比 promise 微任务还早,所以
    // 外层还要按 writableFinished 兜一道(mixrouter.js 的 res.on('close')),单靠这里
    // 的顺序压不住"成功被记成 client closed"。
    const settle = () => {
      if (settled) return;
      settled = true;
      const retryable = conv.retryable;
      const result = {
        converted: true, usage: conv.usage ? toUsage(conv.usage) : null, model: conv.model,
        retryable,
        aborted: !retryable && (conv.terminal === 'aborted' || conv.terminal === 'failed'),
        detail: conv.failMessage || '',
      };
      try { upRes.destroy(); } catch {} // 终态已定,别再占着上游连接
      resolve(result);
      // 可重试意味着一个字节都没写给客户端:这条 res 还要留给下一次尝试,不能 end 掉
      if (!retryable && !res.writableEnded) { try { res.end(); } catch {} }
    };
    const conv = makeStream(res, model, {
      onCommit: commit,
      onDone: settle,
      canRetry: () => mayRetry && !conv.committed,
    });
    const transportDead = why => {
      if (settled || conv.finished) return;
      conv.abort(why);
    };
    upRes.on('data', chunk => {
      if (settled || conv.finished) return;
      const text = decoder.write(chunk);
      if (!conv.committed) {
        if (rawPre.length < 8192) rawPre += text;
        // 200 里夹带的错误体(渠道池打满那种):还没给客户端写字节就交给 abort 判可不可重试
        const te = terminalError(rawPre);
        if (te) return conv.abort(te);
      }
      onText(conv, text, { isSettled: () => settled });
    });
    upRes.on('end', () => {
      if (settled || conv.finished) return;
      // 各线对"没等到终态就结束"的判定不同:chat 认 [DONE]/finish_reason 两个信号,
      // responses 只有 conv 自己知道(见各线的 onEnd)
      onEnd(conv);
    });
    upRes.on('close', () => transportDead('上游连接中断'));
    upRes.on('error', e => transportDead((e && (e.code || e.message)) || '上游连接错误'));
  });
}

module.exports = { relayAnthropicStream };
