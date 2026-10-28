'use strict';
// 路由解析:模型名 + 上下文 → 该走哪个渠道、哪个落点模型。
// 纯函数,不持有路由表/槽位表/渠道库——三类状态都由调用方以函数传入,
// 这样规则热更新、槽位热更新都不需要重新 require。
//
// 判定顺序只有三步(通用 match 子串 / when.session|ua|token / 可配置 default 兜底已删除):
//   1. 压缩内容规则:只认 compact-signature 登记过的 when.body,按 priority 降序,
//      且必须是真压缩请求(正文引用特征串不算)
//   2. 精确槽位别名(mixr-*,Claude 组另有 claude-mixr-* 兼容别名),含会话覆盖
//   3. 精确已登记模型:模型名与某组渠道登记的模型名全等(剥 [1m] 后缀、大小写不敏感)。
//      唯一命中该模型的可用渠道才走;多个渠道登记同一模型 = 歧义,明确报错而不是随便挑
//      一个;没有对应 = no_route。两者都不再有任何"回退到别的模型或渠道"的路径。
//
// 显式钉定(ctx.pin)在歧义时优先:用户已经把这个对话钉在某条登记渠道上时,歧义由它解开;
// 唯一命中时钉定覆盖仍由会话侧(sessions.resolveTarget)的既有语义处理,这里不改。
//
// trace(可选):把每一步判定念出来,给 dry-run 预览用。**默认关闭**——不传时零事件。

const { strategyOf } = require('./strategy');
const { resolveSessionSlot } = require('./session-config');
const { slotNameFromAlias, stripContextSuffix } = require('./slots');
const { poolMembers, ghostRefs } = require('./pool');
const { ruleAppliesToApp, rulesByPriority } = require('./rules');
const { compactKind, compactRuleMatches } = require('./compact-signature');
const { ringOf } = require('./keys');

const compactPeek = (r, i) => ({
  index: i,
  ruleId: (r && r.id) || '',
  kind: compactKind(r),
  enabled: !(r && r.enabled === false),
  priority: Number(r && r.priority) || 0,
  app: (r && r.app) || '',
});

// 模型名的归一:去首尾空白、剥 [1m] 上下文后缀、转小写。请求侧与登记侧用同一个函数,
// 否则"登记 claude-opus-5[1M]"与请求"claude-opus-5"会互相认不出。
const normalizeModel = value => stripContextSuffix(value);

// 渠道登记的模型清单。Claude 组历史上以 models[] 为主,Codex 组是 model + models[];
// 手改过的 providers.json 也可能只有 model —— 三处都收,不猜哪种写法才"对"。
function registeredModels(provider) {
  const out = [];
  if (typeof provider.model === 'string' && provider.model.trim()) out.push(provider.model);
  if (Array.isArray(provider.models)) {
    for (const m of provider.models) if (typeof m === 'string' && m.trim()) out.push(m);
  }
  return [...new Set(out.map(m => m.trim()))];
}

// 可用渠道:停用的不算;一把能用的 Key 都没有的也不算 —— 它连不上去,
// 算进候选只会让"唯一命中"变成一次必然失败的转发。
function usableProvider(p) {
  if (!p || p.enabled === false) return false;
  return ringOf(p).some(k => k && k.enabled !== false && typeof k.key === 'string' && !!k.key.trim());
}

function createResolver(deps) {
  const { getRoutes, storeOf, resolveSlot, findProvider } = deps;
  const defaultTrace = deps.trace;

  const membersFor = (rule, app) => poolMembers(storeOf(app), rule, app);

  // 命中规则/槽位/模型后的统一返回形状。stage 说明这一条是怎么命中的:
  //   'compact'(压缩内容规则)/ 'slot'(槽位别名)/ 'model'(精确已登记模型)
  const hit = (rule, members, modelIn, strategy, extra) => ({
    rule,
    members,
    ghosts: ghostRefs(findProvider, rule),
    provider: members.length ? members[0].provider : null,
    model: (members.length ? members[0].model : (extra && extra.model !== undefined ? extra.model : rule.model)) || modelIn,
    strategy,
    stage: (extra && extra.stage) || 'model',
    // 兼容既有消费者:压缩请求仍标 content,槽位仍带槽名。
    ...(extra && extra.compact ? { content: true } : {}),
    ...(extra && extra.slot ? { slot: extra.slot } : {}),
  });

  // 精确模型阶段:同组里所有登记了该模型且可用的渠道。
  function candidatesFor(model, app) {
    const want = normalizeModel(model);
    if (!want) return [];
    const out = [];
    for (const p of storeOf(app) || []) {
      if (!usableProvider(p)) continue;
      if (registeredModels(p).some(m => normalizeModel(m) === want)) out.push(p);
    }
    return out;
  }

  return function resolveRoute(modelIn, ctx = {}, app = 'claude', traceOverride) {
    const trace = traceOverride || defaultTrace;
    const emit = trace ? trace : null;
    const routes = getRoutes() || {};
    const order = rulesByPriority(routes.rules);

    // ---- 1) 压缩内容规则。只看 compact-signature 登记过的 when.body:
    // 普通正文引用特征串不能触发(见该模块头注释),历史遗留的通用 when.* 规则一律不评。
    const texts = typeof (ctx && ctx.compactTexts) === 'function' ? ctx.compactTexts() : null;
    for (const { r, i } of order) {
      if (!compactKind(r)) continue;
      if (r.enabled === false) { if (emit) emit({ stage: 'compact', ...compactPeek(r, i), outcome: 'skip', reason: 'disabled', detail: {} }); continue; }
      if (!ruleAppliesToApp(r, app)) { if (emit) emit({ stage: 'compact', ...compactPeek(r, i), outcome: 'skip', reason: 'app_mismatch', detail: { ruleApp: r.app || '', app } }); continue; }
      if (!compactRuleMatches(r, Array.isArray(texts) ? texts : [])) {
        if (emit) emit({ stage: 'compact', ...compactPeek(r, i), outcome: 'skip', reason: 'compact_miss', detail: {} });
        continue;
      }
      if (emit) emit({ stage: 'compact', ...compactPeek(r, i), outcome: 'hit', reason: 'hit', detail: {} });
      return hit(r, membersFor(r, app), modelIn, strategyOf(r), { compact: true, stage: 'compact' });
    }

    // ---- 2) 精确槽位别名(含会话覆盖),优先于精确模型
    const slotModel = app === 'codex' && typeof deps.codexLegacyAlias === 'function'
      ? deps.codexLegacyAlias(modelIn, ctx) || modelIn : modelIn;
    const slot = resolveSessionSlot(resolveSlot(app, slotModel), slotModel, app, ctx.sessionRouting, storeOf(app));
    if (slot) {
      if (emit) emit({ stage: 'slot', outcome: 'hit', reason: 'hit', detail: { alias: String(modelIn || '').trim(), slot: slot.name } });
      return hit(slot.rule, membersFor(slot.rule, app), modelIn, strategyOf(slot.rule),
        { slot: slot.name, model: slot.model, stage: 'slot' });
    }
    // Codex 受管线 ID 删除/清空后明确失效,不能落到别的渠道并悄悄换模型。
    // Claude 保留既有未知别名兼容行为(继续按精确模型判定)。
    const codexName = app === 'codex' ? slotNameFromAlias(app, slotModel) : null;
    if (codexName !== null) {
      const rule = { id: `slot:codex/${codexName}`, match: String(modelIn), provider: '', model: '', pool: [],
        strategy: 'round_robin', app: 'codex', enabled: true, when: {} };
      if (emit) emit({ stage: 'slot', outcome: 'missing_slot_error', reason: 'missing_slot_error', detail: { alias: String(modelIn), slot: codexName } });
      return hit(rule, [], modelIn, 'round_robin', { slot: codexName, stage: 'slot' });
    }
    if (emit) {
      const raw = String(modelIn || '').trim();
      const looksAlias = slotNameFromAlias(app, raw) !== null;
      const unbound = looksAlias && typeof deps.slotExists === 'function' && deps.slotExists(app, raw);
      const outcome = !looksAlias ? 'not_alias' : (unbound ? 'slot_unbound_falls_through' : 'no_such_slot');
      emit({ stage: 'slot', outcome, reason: outcome, detail: looksAlias ? { alias: raw } : { model: raw } });
    }

    // ---- 3) 精确已登记模型
    const app_ = app;
    const candidates = candidatesFor(modelIn, app_);
    const ids = candidates.map(p => p.id);
    // 显式钉定:会话里用户已经钉住某条登记渠道时,它优先解开歧义。
    const pin = typeof ctx.pin === 'string' ? ctx.pin : '';
    if (candidates.length === 1) {
      const p = candidates[0];
      const model = registeredModels(p).find(m => normalizeModel(m) === normalizeModel(modelIn)) || modelIn;
      const rule = { id: `model:${p.id}`, match: String(modelIn), provider: p.id, model,
        pool: [], strategy: 'round_robin', priority: 0, app, when: {}, enabled: true };
      if (emit) emit({ stage: 'model', outcome: 'hit', reason: 'hit', detail: { provider: p.id, model } });
      return hit(rule, [{ provider: p, model, weight: 1 }], modelIn, 'round_robin', { stage: 'model', model });
    }
    const label = String(modelIn || '').trim();
    const named = candidates.map(p => `"${p.name || p.id}"`).join('、');
    if (candidates.length > 1) {
      if (pin && ids.includes(pin)) {
        const p = candidates.find(x => x.id === pin);
        const model = registeredModels(p).find(m => normalizeModel(m) === normalizeModel(modelIn)) || modelIn;
        const rule = { id: `model:${p.id}`, match: String(modelIn), provider: p.id, model,
          pool: [], strategy: 'round_robin', priority: 0, app, when: {}, enabled: true };
        if (emit) emit({ stage: 'model', outcome: 'hit', reason: 'session_pin', detail: { provider: p.id, model, candidates: ids } });
        return hit(rule, [{ provider: p, model, weight: 1 }], modelIn, 'round_robin', { stage: 'model', model });
      }
      if (emit) emit({ stage: 'model', outcome: 'ambiguous', reason: 'model_ambiguous', detail: { model: label, candidates: ids } });
      return {
        rule: null, members: [], ghosts: [], provider: null, model: label, strategy: 'round_robin',
        stage: 'model', candidates: ids,
        error: { status: 409, type: 'model_ambiguous_error',
          message: `模型 "${label}" 登记在多个 ${app === 'codex' ? 'Codex' : 'Claude'} 组渠道(${named});请把本对话钉定到其中一个渠道,或删除多余的模型登记` },
      };
    }
    if (emit) emit({ stage: 'model', outcome: 'miss', reason: 'no_registered_model', detail: { model: label } });
    // 走到这里还没命中,请求名却像个槽位别名:说明那个槽位要么不存在、要么在表里但没绑渠道。
    // 直接报"没有登记模型"会把人引向"我明明登记了这个模型名"的错方向 —— 别名不是模型名。
    const aliasName = slotNameFromAlias(app, label);
    const message = aliasName !== null
      ? `槽位别名 "${label}" 没有可用的目标:槽位 "${aliasName}" 不存在或没有绑定渠道。请在控制台 http://127.0.0.1:8788 的「槽位」里给它选一个渠道`
      : `${app === 'codex' ? 'Codex' : 'Claude'} 组没有渠道登记模型 "${label}"。请在控制台给对应渠道补上模型名,或把模型名改成已登记的完全一致的名字`;
    return {
      rule: null, members: [], ghosts: [], provider: null, model: label, strategy: 'round_robin',
      stage: 'model', candidates: [],
      error: { status: 503, type: 'no_route_error', message },
    };
  };
}

module.exports = { createResolver, normalizeModel, registeredModels, usableProvider };
