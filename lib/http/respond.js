'use strict';
// 控制台写接口的 JSON 错误体。这些分支原来是每处手写
//   res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: ... }))
// 一行行抄在 apiHandler 里(三十来处),两处容易写歪:忘了 Content-Type、或把 error 写成裸串
// (前端读的是 body.error,裸串会让界面显示 undefined)。
//
// **只管控制台**:代理入口的错误体是 Anthropic / OpenAI 形状(见 lib/http/proto-error.js),
// 那是给 Claude Code / Codex 读的,形状完全不同,两条线不共用。
//
// 这里不写 headerContentLength 之外的头、不做跨站判定、不读 body —— 纯发送。

// 状态码 + { error: <字符串> }。返回 res.end() 的返回值,调用方一律 `return sendJson(...)`,
// 这样"没走到后面的分支"这件事从控制流上就看得见。
function sendJson(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  return res.end(b);
}

// 最常见的形状:{ error: '一句话说清哪个字段不对' }
const sendError = (res, code, message) => sendJson(res, code, { error: message });

// 落盘失败统一措辞。写渠道库/写路由/写槽位失败的入口都回这一句,
// 区别只在 500 这个码上——以前每个分支各写一遍 '写入渠道库失败: ' + e.message,
// 措辞一致但靠人肉同步。
const sendWriteFailed = (res, what, e) => sendError(res, 500, `写入${what}失败: ${(e && e.message) || e}`);

module.exports = { sendJson, sendError, sendWriteFailed };
