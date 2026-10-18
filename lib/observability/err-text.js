'use strict';
// 落进请求日志的**上游原因**。同一句模板在 mixrouter.js 里写了 6 遍:
//     entry.err = `HTTP ${cres.statusCode}: ${String(text).slice(0, 400)}`
// 它必须存在:上游 5xx/4xx 时 requests.jsonl 只看得到状态码,不知道上游说了什么
// (限流?模型下线?区域故障?),排查等于从零开始 —— 线上实测 649 条 5xx 里 613 条 err 是空串。
//
// ⚠ 这两种写法**不是等价的,本模块两种都保留**,别合并成一种:
//   · `errLine`             —— 纯截断。空体写出来是 `HTTP 500: `(冒号后什么都没有)。
//   · `errLineOrPlaceholder` —— 截断后 trim,空则写占位 `(空响应体)`。
// 它们各自被原实现用在不同的分支上:有上游原因的(翻译线、直通线)用带占位的写法,
// 因为"冒号后空白"会被读成"没记原因";而 chat/responses 错误体那两处只做纯截断。
// 合并成一种就会**改变落盘内容**——契约表里"行为不许变"这条比"少一个函数"重要。
// (统一成带占位的那种曾经写在这里,对照 HEAD 的旧实现逐字跑过:对 '  padded  ' 这类
//  带空白的上游正文,合并版会多切掉首尾空白,日志正文因此与修复前不同。)

const ERR_TEXT_MAX = 400;

// 原写法:`String(text).slice(0, 400)`。不加 trim —— 与调用点原来的字面量逐字一致。
//
// 唯一一处**有意不与原字面量逐字一致**的地方,就是下面这个空值分支,说清楚:
//   `String(undefined)` 是字符串 'undefined',而它是**真值**,所以
//   `String(undefined).slice(0,400).trim() || '(空响应体)'` 会给出 'undefined' 而不是占位符
//   —— 空值分支被 `||` 后面的兜底"跳过"了,兜底形同虚设。
//   原实现里这些调用点的实参都取自 `.toString('utf8')` 或该字符串上的 `|| text`,
//   所以 null/undefined 在生产路径上**到不了**这里,这个分歧不是线上行为差异。
//   本模块的立场是"上游没给正文"必须写成空体而不是 'undefined',所以统一归一成 ''。
//   对**字符串**输入,归一与否逐字同值(注入探针逐条对照过)。
const clip = text => (text === undefined || text === null ? '' : String(text)).slice(0, ERR_TEXT_MAX);

// 原写法:`String(text).slice(0, 400).trim() || '(空响应体)'`
const errBodyText = text => clip(text).trim() || '(空响应体)';

// 纯截断的完整一句(`HTTP <状态码>: <正文>`)
const errLine = (status, text) => `HTTP ${status}: ${clip(text)}`;

// 带空体占位的完整一句
const errLineOrPlaceholder = (status, text) => `HTTP ${status}: ${errBodyText(text)}`;

module.exports = { ERR_TEXT_MAX, clip, errBodyText, errLine, errLineOrPlaceholder };
