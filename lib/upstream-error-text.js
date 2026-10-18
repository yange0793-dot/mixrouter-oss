'use strict';
// 从**上游错误响应体**里抠出「人话原因」。
//
// 上游 4xx/5xx 的错误体形状各家不一,同一段取值逻辑在 mixrouter.js 里写了三遍:
//   · chat 翻译线(客户端要 Anthropic,上游是 chat)      —— 落日志 + 回 Anthropic 错误
//   · responses 翻译线                                   —— 同上
//   · anthropic 直通线                                   —— 落日志 + sendErr 原样转发
// 三遍逐字相同:先试 JSON,把 `error` 字段(可能是字符串,也可能是对象)摊成一句话,
// 再依次退到 `message` 与整段原文。任何一步失败都不能吞掉上游给的东西 ——
// 以前 anthropic 直通线只发客户端、不写 entry.err,线上 649 条 5xx 里 613 条 err 是空串,
// 事后翻日志只知道"某渠道 500",不知道上游说了什么(限流?模型下线?区域故障?)。
//
// ⚠ 本模块**只管抠出原因**,不管怎么写日志、更不管回给客户端什么形状:
//   三条线在这两点上**有意不同**(见 lib/observability/err-text.js 的说明):
//     · chat / responses 两处用 errLine(纯截断)           + 手写 Anthropic 错误体
//     · anthropic 直通线用 errLineOrPlaceholder(带空体占位) + sendErr 原样转发状态码
//   把这两件事一并合并会**改变落盘内容**,是明令禁止的。所以这里只收敛"怎么读上游正文"。

// upstreamErrorText(text) -> string
//   原样返回入参当兜底:上游给的正文解析不了时,原因就是那段原文,不能变成空串。
function upstreamErrorText(text) {
  try {
    const j = JSON.parse(text);
    const e = j.error;
    return (e && (e.message || (typeof e === 'string' ? e : JSON.stringify(e)))) || j.message || text;
  } catch {
    return text;
  }
}

module.exports = { upstreamErrorText };
