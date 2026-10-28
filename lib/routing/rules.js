'use strict';
// 规则归一化 + 压缩规则判定 + 按 priority 排序。**纯函数,无状态**。
//
// 通用分流(match 子串 / when.session|ua|token / 可配置 default 兜底)已整体删除:
// 路由只剩三种来源 —— 压缩内容规则、精确槽位别名、已登记模型的精确选择。
// 本文件保留的只有这三者都要用的东西:
//   · normalizeRule —— 存进来的规则过一遍类型收敛(压缩规则的落点/池/Key 钉定)
//   · compactRuleMatches —— 压缩请求判据(正文引用不足以命中,见 compact-signature)
//   · rulesByPriority —— 按 priority 降序排(压缩规则之间 global < talentsai)
//   · ruleAppliesToApp —— 规则声明的客户端组是否就是这一组
//
// 历史磁盘数据不因此报错:旧规则的 when.session / when.ua / when.token / match 子串
// 会被**静默丢弃**(它们不再参与任何判定)。丢弃发生在内存归一化里,盘上那份要到下一次
// 正常保存才会被改写。

const { strategyOf, STRATEGIES } = require('./strategy');
const { compactKind, compactRuleMatches } = require('./compact-signature');
const { validKeyId } = require('./keys');
const { invalid } = require('../validation');

// 从控制台存进来的规则一律过一遍这里:字段类型收敛,免得坏数据埋到转发时才炸
function normalizeRule(r, { preserveInvalidPin = false } = {}) {
  const src = (r && typeof r === 'object') ? r : {};
  const pool = (Array.isArray(src.pool) ? src.pool : [])
    .map(m => {
      if (typeof m === 'string') return m.trim() ? m.trim() : null;
      if (!m || typeof m !== 'object' || !m.provider) return null;
      const o = { provider: String(m.provider).trim() };
      if (m.model) o.model = String(m.model);
      const w = Number(m.weight);
      if (Number.isFinite(w) && w > 0) o.weight = w;
      return o;
    })
    .filter(Boolean);
  // when 只剩 body(压缩规则的判据)。其余字段是已删除的通用分流条件,一律不保留。
  // 类型仍要判:坏值留着会让压缩判据静默失配,而控制台里这条规则看着好好的。
  const when = {};
  const body = src.when && src.when.body;
  if (body !== undefined && body !== null && body !== '') {
    if (typeof body !== 'string' && !(typeof body === 'number' && Number.isFinite(body)))
      throw invalid('路由规则的 when.body 必须是字符串');
    when.body = String(body).trim();
  }
  const pinned = !!compactKind(src) && src.key_id !== undefined && src.key_id !== '';
  if (pinned && !preserveInvalidPin) {
    if (!validKeyId(src.key_id)) throw invalid('压缩规则的 key_id 必须是非空字符串，不能包含控制字符');
    if (src.pool && (!Array.isArray(src.pool) || src.pool.length)) throw invalid('压缩专用 Key 只支持单一渠道，不能同时配置 pool');
  }
  const p = Number(src.priority);
  return {
    ...(pinned ? { key_id: src.key_id } : {}),
    id: String(src.id || 'r' + Math.random().toString(36).slice(2, 8)),
    // match 只为兼容旧落盘形状保留,已不参与任何判定。
    match: String(src.match || ''),
    provider: String(src.provider || ''),
    model: String(src.model || ''),
    // 读盘保留坏 pin 的池形状,让运行时明确拒绝,不能洗成单选后默默发包。
    pool: pinned && preserveInvalidPin && src.pool ? (Array.isArray(src.pool) ? src.pool : [src.pool]) : pool,
    strategy: STRATEGIES.includes(src.strategy) ? src.strategy : 'round_robin',
    priority: Number.isFinite(p) ? p : 0,
    app: src.app === 'codex' ? 'codex' : (src.app === 'claude' ? 'claude' : ''),
    when,
    enabled: src.enabled !== false,
  };
}

// 规则是否属于这一组。显式声明了 app 的规则只在自己那组生效;没声明 = 两组通用。
function ruleAppliesToApp(rule, app) {
  return !(rule && rule.app) || rule.app === app;
}

// 按 priority 降序排(同值保持数组顺序);不排序原数组,返回 {r, i} 视图
function rulesByPriority(rules) {
  return (Array.isArray(rules) ? rules : [])
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ((Number(b.r.priority) || 0) - (Number(a.r.priority) || 0)) || (a.i - b.i));
}

module.exports = { normalizeRule, ruleAppliesToApp, rulesByPriority, compactRuleMatches, strategyOf };
