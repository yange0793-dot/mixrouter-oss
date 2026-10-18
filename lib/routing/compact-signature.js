'use strict';
// 压缩请求的判据与两条内容规则的身份。纯函数,无依赖。
//
// 为什么不能只做子串匹配:when.body 的特征串会被普通文本原样引用——任务说明、工具结果、
// 历史消息里都会出现。实测 2026-09-25:一条把规则原文写进正文的任务,让此后主链请求
// 全部被判给压缩规则,切到别的模型后丢了 reasoning。所以"含这个短语"不足以判定为压缩。
//
// 真压缩请求的形状(只读核过本机 CLI 二进制,见 FIXED_PREFIX 出处):
//   Claude Code 2.1.282 本地发行文件
//   SHA256 5c34b00b5c0f3862b76011015c334e91904c4593afea7a5451e00746ad7934c1
//   byte 189706319 起为 FIXED_PREFIX;189709365 / 189713678 / 189716135 三处为
//   "Your task is to create a detailed summary of …" 的三个变体正文起点。
// 证据等级:只核了源码里的字符串,没有抓过真实请求包;因此判据只做**开头锚定 + 摘要模板**
// 两项必要条件,不对标记出现的位置做更细的断言(见 compactRuleMatches)。
const FIXED_PREFIX = 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n'
  + '- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.\n'
  + '- You already have all the context you need in the conversation above.\n'
  + '- Tool calls will be REJECTED and will waste your only turn — you will fail the task.\n'
  + '- Your entire response must be plain text: an <analysis> block followed by a <summary> block.\n\n';
// 三个变体(完整 / RECENT portion / this conversation)的公共起句
const SUMMARY_TEMPLATE = 'your task is to create a detailed summary';
// PreCompact 钩子(ts_precompact.py)输出的首行标记,被拼进同一条压缩指令
const MARKER = 'mixrouter:talentsai-precompact:v1';
const COMPACT_RULES = [
  { kind: 'global', body: 'your task is to create a detailed summary of', priority: 90 },
  { kind: 'talentsai', body: MARKER, priority: 100 },
];
// text 是不是一条压缩指令:必须**以固定前导开头**,且带摘要模板。
// 两个条件缺一不可——只有前导没有模板不是真压缩,只有模板不是开头也不算。
function isCompactInstruction(text) {
  const s = String(text || '');
  return s.startsWith(FIXED_PREFIX) && s.toLowerCase().includes(SUMMARY_TEMPLATE);
}
// 末条 user 消息的直接文本里,至少有一条是真压缩指令(开头锚定在它自己身上)才算压缩请求。
// 标记可以出现在同一条消息的另一个文本块里:PreCompact 钩子的输出是追加进来的,
// 它与前导是否同块取决于客户端拼接方式,只核源码无法确定,故不要求同块。
function isCompactRequest(texts) {
  return (Array.isArray(texts) ? texts : []).some(isCompactInstruction);
}
// 规则身份来自 when.body 而不是 id(id 用户可改)。只认这两条登记过的特征串。
function compactKind(rule) {
  const body = String((rule && rule.when && rule.when.body) || '').trim().toLowerCase();
  return (COMPACT_RULES.find(spec => spec.body === body) || {}).kind || '';
}
// 压缩规则的 body 条件:先确认这是一条真压缩指令,再要求自己的特征串确实出现在直接文本里。
// 非压缩请求(引用特征串的任务说明、工具结果、历史消息)一律不命中。
function compactRuleMatches(rule, texts) {
  if (!isCompactRequest(texts)) return false;
  const want = String((rule && rule.when && rule.when.body) || '').trim().toLowerCase();
  if (!want) return false;
  return texts.some(t => String(t || '').toLowerCase().includes(want));
}
module.exports = { FIXED_PREFIX, SUMMARY_TEMPLATE, MARKER, COMPACT_RULES, isCompactInstruction, isCompactRequest, compactKind, compactRuleMatches };
