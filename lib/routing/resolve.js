'use strict';
// 路由解析:模型名 + 上下文 → 该走哪条规则、哪几个候选渠道、落点模型。
// 纯函数,不持有路由表/槽位表/渠道库——三类状态都由调用方以函数传入,
// 这样规则热更新、槽位热更新都不需要重新 require。
//
// 匹配顺序(与原实现一致):
//   1. 内容分流规则(带 when.body 的)按 priority 降序评估,先于槽位别名与普通规则
//   2. 槽位别名精确匹配(mixr-*),优先于一切普通规则
//   3. 普通规则按 priority 降序,命中首个启用且满足 when 的
//   4. 都不中 → 兜底路由
//
// trace(可选):把每一步判定念出来,给 dry-run 预览用。**默认关闭**——不传时零事件、
// 行为与加 trace 之前逐字节相同。预览之所以复用这里而不是另写一份匹配,是因为
// 两条代码路径必然漂移:改了一处忘了另一处,预览就会开始骗人。

const { strategyOf } = require('./strategy');
const { resolveSessionSlot } = require('./session-config');
const { slotNameFromAlias } = require('./slots');
const { poolMembers, ghostRefs } = require('./pool');
// when 的逐字段判定只有一个实现(rules.js),这里只做转发:
// 预览要能说清是**哪个**字段没过,所以用 collectAll=true;实跑路径用 matchWhen(短路,不求值 body)。
const { matchHits, ruleBelongsToApp, rulesByPriority, whenMissFields } = require('./rules');

// 规则对象的 trace 快照:只带路由侧字段,不含任何请求侧内容。
// ⚠ when.token 不回显原文:它是拿去匹配**客户端凭据**的子串,用户完全可能把 Key 的一段
// 写在那里做分流。预览结果是要贴进 issue/控制台的,不能成为凭据材料。
// session/ua/body 三个条件照旧原样 —— 它们是"为什么没命中"的解释本身,藏了预览就没意义。
const whenPeek = w => {
  const out = { ...(w || {}) };
  if ('token' in out) out.token = { present: true, len: String(out.token || '').length };
  return out;
};
const rulePeek = (r, i) => ({
  index: i,
  ruleId: (r && r.id) || '',
  enabled: !(r && r.enabled === false),
  priority: Number(r && r.priority) || 0,
  match: String((r && r.match) || ''),
  app: (r && r.app) || '',
  when: whenPeek(r && r.when),
});

function createResolver(deps) {
  const { getRoutes, storeOf, resolveSlot, findProvider, providerApp } = deps;
  const defaultTrace = deps.trace;

  const membersFor = (rule, app) => poolMembers(storeOf(app), rule, app);

  // 命中规则/槽位的统一返回形状
  const hit = (rule, members, modelIn, strategy, extra) => ({
    rule,
    members,
    ghosts: ghostRefs(findProvider, rule),
    provider: members.length ? members[0].provider : null,
    // extra.model:槽位自带落点模型(rule.model 与它同值,显式传入以免日后两边漂移)
    model: (members.length ? members[0].model : (extra && extra.model !== undefined ? extra.model : rule.model)) || modelIn,
    strategy,
    ...(extra && extra.content ? { content: true } : {}),
    ...(extra && extra.slot ? { slot: extra.slot } : {}),
  });

  return function resolveRoute(modelIn, ctx = {}, app = 'claude', traceOverride) {
    const trace = traceOverride || defaultTrace;
    const emit = trace ? trace : null;
    const m = String(modelIn || '').toLowerCase();
    const routes = getRoutes() || {};
    const order = rulesByPriority(routes.rules);

    // 内容分流:带 when.body 的规则按请求内容命中,先于槽位别名与普通规则评估。
    // 同一个模型名底下可能干着不同的事(Claude Code 的压缩请求走的还是主模型别名),
    // 只有请求体认得出来;match 留空 = 不限模型。
    for (const { r, i } of order) {
      if (!r.enabled) { if (emit) emit({ stage: 'content', ...rulePeek(r, i), outcome: 'skip', reason: 'disabled', detail: {} }); continue; }
      // 没有 when.body 的规则不归本阶段评(它走普通规则阶段),但不该被静默跳过——
      // 预览要能回答"我那条内容规则为什么没生效"
      if (!String((r.when && r.when.body) || '').trim()) {
        if (emit) emit({ stage: 'content', ...rulePeek(r, i), outcome: 'skip', reason: 'when_body_absent', detail: {} });
        continue;
      }
      if (!ruleBelongsToApp(r, app, providerApp)) {
        if (emit) emit({ stage: 'content', ...rulePeek(r, i), outcome: 'skip', reason: 'app_mismatch', detail: { ruleApp: r.app || '', app } });
        continue;
      }
      const miss = whenMissFields(r, ctx, !!emit);
      if (miss) {
        if (emit) emit({ stage: 'content', ...rulePeek(r, i), outcome: 'skip', reason: 'when_mismatch', detail: { fields: miss } });
        continue;
      }
      const hits = matchHits(r);
      if (hits.length && !hits.some(h => m.includes(h))) {
        if (emit) emit({ stage: 'content', ...rulePeek(r, i), outcome: 'skip', reason: 'match_miss', detail: { patterns: hits } });
        continue;
      }
      if (emit) emit({ stage: 'content', ...rulePeek(r, i), outcome: 'hit', reason: 'hit', detail: {} });
      return hit(r, membersFor(r, app), modelIn, strategyOf(r), { content: true });
    }

    // 槽位别名精确匹配,优先于一切规则(客户端槽位 env 写的就是别名,不能被子串规则截胡)
    const slot = resolveSessionSlot(resolveSlot(app, modelIn), modelIn, app, ctx.sessionRouting, storeOf(app));
    if (slot) {
      if (emit) emit({ stage: 'slot', outcome: 'hit', reason: 'hit', detail: { alias: String(modelIn || '').trim(), slot: slot.name } });
      // 策略取自槽位规则(而不是写死 round_robin):配了备池就要能用主备(priority),
      // 否则池里同时有主选和后备时会被轮询打散,主渠道明明可用也可能落到备渠道上
      return hit(slot.rule, membersFor(slot.rule, app), modelIn, strategyOf(slot.rule), { slot: slot.name, model: slot.model });
    }
    // 槽位没命中:把"像别名但不是"这种情况说清楚,免得用户以为槽位生效了。
    // 细分两种:别名在槽位表里但**没绑渠道**(会静默落到普通规则),和压根没这个别名。
    // 前者最该说出来 —— 用户看到预览命中了普通规则,却不知道自己的槽位根本没绑。
    if (emit) {
      const raw = String(modelIn || '').trim();
      // 像别名的判据与解析共用一份实现:Claude 组的 claude-mixr-* 兼容别名也算别名,
      // 否则预览会把"槽位没绑"误报成普通模型名或 no_such_slot。
      const looksAlias = slotNameFromAlias(app, raw) !== null;
      // slotExists 是可选注入:不提供时退回笼统的 no_such_slot,不猜
      const unbound = looksAlias && typeof deps.slotExists === 'function' && deps.slotExists(app, raw);
      const outcome = !looksAlias ? 'not_alias' : (unbound ? 'slot_unbound_falls_through' : 'no_such_slot');
      emit({ stage: 'slot', outcome, reason: outcome,
        detail: looksAlias ? { alias: raw } : { model: raw } });
    }

    for (const { r, i } of order) {
      if (!r.enabled) { if (emit) emit({ stage: 'rule', ...rulePeek(r, i), outcome: 'skip', reason: 'disabled', detail: {} }); continue; }
      const hits = matchHits(r);
      if (!hits.length) {
        if (emit) emit({ stage: 'rule', ...rulePeek(r, i), outcome: 'skip', reason: 'no_match', detail: { patterns: [] } });
        continue;
      }
      if (!hits.some(h => m.includes(h))) {
        if (emit) emit({ stage: 'rule', ...rulePeek(r, i), outcome: 'skip', reason: 'match_miss', detail: { patterns: hits } });
        continue;
      }
      if (!ruleBelongsToApp(r, app, providerApp)) {
        if (emit) emit({ stage: 'rule', ...rulePeek(r, i), outcome: 'skip', reason: 'app_mismatch', detail: { ruleApp: r.app || '', app } });
        continue;
      }
      const miss = whenMissFields(r, ctx, !!emit);
      if (miss) {
        if (emit) emit({ stage: 'rule', ...rulePeek(r, i), outcome: 'skip', reason: 'when_mismatch', detail: { fields: miss } });
        continue;
      }
      if (emit) emit({ stage: 'rule', ...rulePeek(r, i), outcome: 'hit', reason: 'hit', detail: {} });
      return hit(r, membersFor(r, app), modelIn, strategyOf(r));
    }

    // 兜底路由:rule 保持 null(调用方靠它区分"没命中任何规则")
    const d = routes.default || {};
    const members = membersFor(d, app);
    if (emit) emit({ stage: 'default', outcome: 'used', reason: 'hit', detail: {} });
    return {
      rule: null,
      members,
      ghosts: ghostRefs(findProvider, d),
      provider: members.length ? members[0].provider : null,
      model: (members.length ? members[0].model : d.model) || modelIn,
      strategy: strategyOf(d),
    };
  };
}

module.exports = { createResolver, whenMissFields, whenPeek };
