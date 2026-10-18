'use strict';
// 路由规则归一化与匹配。纯函数,无状态。
// 只依赖同层的 strategy.js:路由层不反向依赖客户端配置读写模块(zcode-config),
// 400 错误体在本层自己构造,形状与 zcode-config 的 invalid() 一致。

const { strategyOf, STRATEGIES } = require('./strategy');
const { compactKind, compactRuleMatches } = require('./compact-signature');
const { validKeyId } = require('./keys');

// { statusCode: 400 } 的错误,与 lib/zcode-config.js 的 invalid() 同形同文案
const invalid = message => Object.assign(new Error(message), { statusCode: 400 });

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
  const when = {};
  for (const f of ['session', 'ua', 'token', 'body']) {
    const v = src.when && src.when[f];
    if (v === undefined || v === null || v === '') continue;
    // when.* 是匹配用的字符串。以前无条件 String():`{body:{}}` 会变成 "[object Object]"
    // 存进路由,此后这条规则再也匹配不上任何东西,而控制台里它看着好好的。
    if (typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v)))
      throw invalid(`路由规则的 when.${f} 必须是字符串`);
    when[f] = String(v).trim();
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

// when 的字段名。三处共用同一份(rules 判定 / resolve 报"哪个条件没对上" / explain 的预览),
// 以前在三份代码里各写一遍字面量,加一个字段就得记得改三处。
const WHEN_FIELDS = ['session', 'ua', 'token', 'body'];

// when 逐字段判定:**唯一实现**。返回没对上的字段名数组,全过则返回 null。
//
// collectAll 决定**短路行为**:
//   · false(实跑路径)—— 命中第一个不匹配字段就返回。关键是 **body 不被求值**:
//     ctx.bodyText 是惰性回调,压缩请求体可到上百 KB,它存在的意义就是"没真需要就别拼"。
//   · true(带 trace 的预览)—— 继续走完,好把"哪几个条件没对上"一次说全。
// 两者只差求值过程,通过/不通过恒等。
//
// 以前这里有两份实现(rules.matchWhen 与 resolve.whenMissFields),靠注释承诺
// "两者对同一输入必须给出一致的通过/不通过"维持同步 —— 正是本仓库反复吃亏的那类。
// 现在只有这一份,matchWhen 是它的薄包装。
//
// 两条压缩规则是 body 匹配的例外:它们的特征串会被普通正文原样引用,子串命中不足以判定
// 为压缩请求,必须走 compact-signature 的开头锚定 + 摘要模板判据,并且只看末条 user 消息的
// 直接文本(ctx.compactTexts,同样是惰性回调)。其他 when.body 规则语义一字不变。
function whenMissFields(rule, ctx, collectAll) {
  const w = (rule && rule.when) || {};
  const miss = [];
  for (const field of WHEN_FIELDS) {
    const want = String(w[field] || '').trim().toLowerCase();
    if (!want) continue;
    // 压缩规则只认末条 user 的直接文本:普通正文引用、工具结果都不能触发。
    if (field === 'body' && compactKind(rule)) {
      const texts = typeof (ctx && ctx.compactTexts) === 'function' ? ctx.compactTexts() : null;
      if (compactRuleMatches(rule, Array.isArray(texts) ? texts : [])) continue;
      miss.push(field);
      if (!collectAll) return miss;
      continue;
    }
    const have = field === 'body'
      ? (typeof (ctx && ctx.bodyText) === 'function' ? ctx.bodyText() : '')
      : ((ctx && ctx[field]) || '');
    if (!String(have).toLowerCase().includes(want)) {
      miss.push(field);
      if (!collectAll) return miss;
    }
  }
  return miss.length ? miss : null;
}

// when 条件匹配:全部字段都要满足;空条件恒真;均为大小写不敏感子串。
// body 只在真有规则要匹配时才由调用方拼出来(压缩这类请求体可以到上百 KB),故走惰性回调。
// 语义全在 whenMissFields 里(短路行为取 collectAll=false,与实跑路径一致)。
function matchWhen(rule, ctx) {
  return whenMissFields(rule, ctx, false) === null;
}

// match 字段 → 子串列表(逗号分隔,小写,去空)。match 留空 = 不限模型(仅内容分流规则这么用)
const matchHits = rule => String((rule && rule.match) || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// 规则是否属于这一组。显式声明了 app 的规则只在自己那组生效;
// 没声明时:Claude 通路保持原语义(命中的规则即使没绑定渠道也照旧报错,
// 好让控制台里"渠道被删了"这种情况有明确提示);Codex 通路则把"整条规则只绑了另一组渠道"
// 视为不命中,好让后面的 Codex 规则/默认路由接手,而不是被一条 Claude 规则挡住
//   providerApp(id) → 'claude' | 'codex' | null
function ruleBelongsToApp(rule, app, providerApp) {
  if (rule && rule.app) return rule.app === app;
  if (app !== 'codex') return true;
  const ids = [rule && rule.provider, ...((rule && rule.pool) || []).map(m => typeof m === 'string' ? m : (m && m.provider))]
    .filter(Boolean);
  if (!ids.length) return true;
  return ids.some(id => providerApp(id) === null || providerApp(id) === app);
}

// 按 priority 降序排(同值保持数组顺序);不排序原数组,返回 {r, i} 视图
function rulesByPriority(rules) {
  return (Array.isArray(rules) ? rules : [])
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ((Number(b.r.priority) || 0) - (Number(a.r.priority) || 0)) || (a.i - b.i));
}

module.exports = { normalizeRule, matchWhen, whenMissFields, WHEN_FIELDS, matchHits, ruleBelongsToApp, rulesByPriority, strategyOf };
