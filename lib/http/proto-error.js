'use strict';
// 代理入口的协议化错误体。两个端点的**客户端**要的形状不一样:
//   Claude Code 读 Anthropic 形状   { type:'error', error:{ type, message } }
//   Codex 读 OpenAI 形状            { error:{ message, type:<去掉 _error 后缀>, code } }
// 回错形状时客户端只会打印一句无法解析的报错——状态码对了、原因却读不出来。
//
// 从 proxyHandler 里搬出来的是 anthropicError / openaiError / protoError 三个纯函数
// (原样搬,语义一字未改,含 Content-Length)。它们在测试里被按形状断言
// (test/routing-preview-q3.test.js 逐字对照预览的 error.code 与实跑结果),
// 所以运行时**不能**改字面量,否则预览与实跑会分叉。

function anthropicError(res, status, type, message) {
  const body = JSON.stringify({ type: 'error', error: { type, message } });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// OpenAI 端点(Codex)要 OpenAI 形状的错误体,回 Anthropic 形状它只会打印一句无法解析的报错
function openaiError(res, status, type, message) {
  const body = JSON.stringify({ error: { message, type: String(type).replace(/_error$/, ''), code: type } });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// 按端点协议选错误体
const protoError = (res, app, status, type, message) =>
  app === 'codex' ? openaiError(res, status, type, message) : anthropicError(res, status, type, message);

module.exports = { anthropicError, openaiError, protoError };
