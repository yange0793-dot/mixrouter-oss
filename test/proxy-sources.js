'use strict';
// 请求日志(entry)字段写入面的**唯一**源码清单 + 读取器。两个源码级用例
// (test/log-wiring.test.js 的 LOG_FIELDS 白名单、test/request-log.test.js 的 entry 字段赋值面)
// 共用这一份,不再各写一个数组。
//
// **为什么单列一个模块**:这份清单原本在两个测试里各有一份(内容相同,连注释都在提醒
// "将来再搬动构造点时要一起改")。两份同一份知识的下场,本项目已经吃过一次亏 ——
// 见 lib/backup/targets.js 的注释:同一个备份池表在两个出口各写一遍,当场就分了叉,
// 两个出口报出不同的备份池,比只报一个更坏。清单只留一份,漏文件就只是**一处**的 bug。
//
// **为什么判据是"必须包含"而不是"尽量多含"**:源码级抽取靠锚点(`const entry = {`、
// `entry.<字段> =`)。一个参与 entry 生命周期的文件只要不在清单里,它写出的字段就
// **既测不到越界字段、也测不到死字段**,而测试照样"通过" —— 这是最坏的一种假绿
// (白名单外的新字段会被 pick() 静默丢弃,响应和磁盘都看不见)。
//
// 当前覆盖面:
//   · mixrouter.js / lib/http/proxy.js —— `const entry = {` 字面量构造点(字面量键那半边靠它)
//   · lib/proxy/{prepare,context,attempts,attempt,response}.js —— 代理编排里的字段写入点
//   · lib/wire-anthropic-translator.js —— **转换线的错误收尾也直接写 entry.err/err_class/status**。
//     它从 ctx 解构 entry 再 finishEntry(),是**真的日志对象**;这个文件原先不在任何清单里,
//     是本次核对时补上的(见下方判据)。
//
// 判据(将来搬动构造点或新增写入点时按这个挑文件,**不要**按"我这次改了哪些文件"):
//   文件里出现下面任意一种,就必须列进来 ——
//     · `const entry = {` 对象字面量
//     · 从 ctx 解构 entry(`{ entry, ... } = ctx`)或 `ctx.entry`
//     · 调用 `finishEntry()`
//     · 对 `entry.<字段>` 赋值(`=` / `||=` / `+=`)
//   反例(**不要**列进来,它们只是同名):
//     · lib/codex-tools.js —— 有 `const entry = { ...spec, chatName }`,那是工具名映射表
//     · lib/observability/err-text.js、lib/observability/metrics.js —— `entry.*` 只出现在注释里
//     · lib/wire-{chat,responses,openai-bridge}.js —— 不直接写日志 entry
const fs = require('node:fs');
const path = require('node:path');

const PROXY_SOURCES = [
  'mixrouter.js',
  'lib/http/proxy.js',
  'lib/proxy/prepare.js',
  'lib/proxy/context.js',
  'lib/proxy/attempts.js',
  'lib/proxy/attempt.js',
  'lib/proxy/response.js',
  'lib/wire-anthropic-translator.js',
];

// 清单内所有文件的源码拼成一份:两个抽取器要的都是"整体文本",不是逐文件。
function proxySource() {
  return PROXY_SOURCES.map(rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')).join('\n');
}

module.exports = { PROXY_SOURCES, proxySource };
