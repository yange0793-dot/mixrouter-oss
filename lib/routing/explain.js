'use strict';
// 路由 dry-run 预览:复用真实 resolver,只读地解释当前快照下的首选目标。
// 不写日志、不建/改会话、不改健康状态、不发上游请求、不改槽位或游标。
// 本模块不 require mixrouter.js,也不读取文件或环境;所有状态都由纯读依赖提供。

const { createResolver } = require('./resolve');
const { pickMember, strategyOf } = require('./strategy');
const { wireOf } = require('./endpoints');
const { hasKeyPin, pinnedProvider } = require('./compact');
const { routingOf, explicitConfig, selectSessionKey } = require('./session-config');

// maxTraceEvents 的单位是判定事件,不是规则。三个阶段的规则各自都可能产生多条事件
// (compact 阶段逐条评估压缩规则,slot/model 阶段各出一条)。
const PREVIEW_LIMITS = { maxTraceEvents: 200, maxCandidates: 50 };
const SAFE_PROVIDER_FIELDS = ['id', 'name', 'model', 'models', 'wire_api', 'ua', 'enabled', 'slots'];
const KINDS_BY_APP = { claude: ['messages', 'count_tokens'], codex: ['responses', 'chat/completions'] };
const SCOPE_NOTE = '仅预测当前快照的首选目标,不保证上游成功或重试后的落点;model 为空表示透传请求模型,不是最终 wire 模型';

// 不带 base_url/api_key/keys/active_key/请求头。出口仍逐字段取值,不展开整个渠道对象。
function sanitizeProvider(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  for (const k of SAFE_PROVIDER_FIELDS) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

function describeStrategy(strategy) {
  switch (strategy) {
    case 'priority':
      return { name: 'priority', deterministic: true, note: '主备:取池序第一个可用渠道,主渠道不可用才降级' };
    case 'least_used':
      return { name: 'least_used', deterministic: true, note: '取当前活跃会话数最少的渠道' };
    case 'weighted':
      return { name: 'weighted', deterministic: true, note: '平滑加权:按当前余量模拟的下一位(预览不消耗余量,实跑会改写)' };
    case 'random':
      return { name: 'random', deterministic: false, note: '随机:多个可选成员时只给出候选,无法预测具体落到哪个(预览不取随机数)' };
    case 'round_robin':
    default:
      return { name: 'round_robin', deterministic: true, note: '轮询:按当前游标的下一位(预览不消耗游标,实跑会前移)' };
  }
}

const emptyLimits = () => ({ rulesTraced: 0, rulesOmitted: 0, truncated: false, arraysTruncated: false, arrays: {} });
const bad = (code, message, httpStatus) => ({ ok: false, error: { code, message, httpStatus }, warnings: [], limits: emptyLimits() });

// 错误码的取值规则:能对齐实跑的走下面的 ERR_TYPE 映射;**对齐不了的就不加 _error 后缀**——
// 硬造一个后缀等于假装对齐,API 层照抄预览的 code 去构造错误体会得到平台不认的类型。
//
// 实跑侧 protoError 的 type 实参(核对方式:**按符号 grep `protoError` 的调用点读实参,别钉行号**;
// mixrouter.js 仍在逐批拆分,任何钉在它上面的行号下次改动又会漂):
//   not_found_error / invalid_request_error / provider_disabled_error / wire_api_mismatch_error / no_route_error
//   provider_key_unavailable_error 在压缩 pin 检查失败时返回,先于停用/空渠道判断。
//   另有 sendErr 把运行时的 type 透传给 protoError,包括 'api_error' 与重试中途失效的 pin。
//
// 以下三个都是**没有实跑对应路径**的预览专有码,故不加 _error 后缀。它们都不在 ERR_TYPE 里,
// 于是 protoTypeOf 对它们返回 null,调用方据此就知道"这个码无从与实跑对齐":
//   · bad_app / kind_app_mismatch —— 实跑里 app 与 kind 是**同一个来源**:classifyProxyRequest(req)
//     按 URL 正则返回 ENDPOINTS 表里的一条,而每条记录把 app+kind 成对写死(见 lib/routing/endpoints.js),
//     实跑路径只读 ep.kind、从不拿 kind 去跟 app 比对,所以"kind 不属于本组"在实跑里构造不出来,
//     客户端也无从传错。它与 wire_api_mismatch_error 是两回事——那条讲的是 chat 客户端撞上
//     没有 chat 上游的渠道,跟 app/kind 分组无关。
//   · bad_model —— 实跑取 `body.model || ''` 后由 resolve 侧 String() 强制成字符串,
//     数字/对象一律被吞掉,从不做类型校验,故也没有"拒绝非字符串 model"这条路径。
// 另注:同一个 type 在两组错误体里**落点不同**(见 anthropicError / openaiError):
//   Claude 侧 {type:'error', error:{type, message}}          → error.type **带**后缀
//   Codex  侧 {error:{message, type: 去后缀, code: 带后缀}}   → error.type **不带**,error.code 带
const ERR_TYPE = {
  provider_key_unavailable: 'provider_key_unavailable_error',
  provider_disabled: 'provider_disabled_error',
  wire_api_mismatch: 'wire_api_mismatch_error',
  no_route: 'no_route_error',
  model_ambiguous: 'model_ambiguous_error',
};
const protoTypeOf = code => ERR_TYPE[code] || null;

// 压缩规则的 when.body 是一条固定的长提示词首句(见 compact-signature),不是用户可调的条件。
// 预览只回显开头一段,免得把整句模板当成判定条件展示出来。
const BODY_PREVIEW = 80;
function safeWhen(w) {
  const body = w && typeof w.body === 'string' ? w.body : '';
  if (!body) return {};
  return { body: body.length > BODY_PREVIEW ? body.slice(0, BODY_PREVIEW) + '…' : body };
}
function safePoolMember(m) {
  if (typeof m === 'string') return m;
  if (!m || typeof m !== 'object') return null;
  const out = {};
  for (const k of ['provider', 'model']) if (m[k] !== undefined) out[k] = String(m[k] || '');
  if (m.weight !== undefined) out.weight = Number(m.weight) || 1;
  return out;
}

// 与 sessions.prune 同序:先 >TTL,再逐个删除最早 lastUsed;同时间取原 Map 插入顺序。
// 豁免的是**显式配置**(Key/槽位覆盖或手动钉定),与 sessions.js 共用 session-config 里的
// 同一个判据:预览说这条会被回收、实跑却不回收(或反过来)会让用户按错的结论去改配置。
// 只删新 Map 的键,不 touch 原会话对象(也不调用真正会删会话的 prune)。
function prunedBindings(snapshot) {
  const bindings = new Map(snapshot.bindings);
  for (const [k, v] of bindings) if (!explicitConfig(v) && snapshot.now - (v.lastUsed || 0) > snapshot.ttlMs) bindings.delete(k);
  while (bindings.size > snapshot.max) {
    let oldestK = null, oldest = Infinity;
    for (const [k, v] of bindings) if (!explicitConfig(v) && (v.lastUsed || 0) < oldest) { oldest = v.lastUsed || 0; oldestK = k; }
    if (oldestK === null) break;
    bindings.delete(oldestK);
  }
  return bindings;
}

// deps(全部纯读):
//   getRoutes / storeOf / resolveSlot / findProvider / providerApp / slotExists? / codexLegacyAlias?
//   listPools() -> 现役游标表,浅拷贝后交给 pickMember
//   healthEligible(id) -> bool(渠道可用性;本进程装配处恒为 true,冷却已移除)
//   sessionSnapshot?() -> {bindings: Map, now, ttlMs, max};时间单位均为毫秒
//   sessionCounts?() -> {providerId: n};缺 snapshot 时兼容旧注入,但不能核对已有粘性
//   uiPort? / limits?
// 不要传 sessions.resolveTarget/list/prune:它们会修改用户的会话表。
function createExplainer(deps) {
  const { getRoutes, storeOf, resolveSlot, findProvider, providerApp, listPools,
    healthEligible, sessionCounts, sessionSnapshot, uiPort } = deps;
  const limits = { ...PREVIEW_LIMITS };
  for (const k of Object.keys(limits)) {
    if (Number.isSafeInteger(deps.limits && deps.limits[k]) && deps.limits[k] >= 0) limits[k] = deps.limits[k];
  }
  const resolver = createResolver({ getRoutes, storeOf, resolveSlot, findProvider, providerApp,
    slotExists: deps.slotExists, codexLegacyAlias: deps.codexLegacyAlias });

  return function explainRoute(input) {
    const inRaw = (input && typeof input === 'object') ? input : {};
    const app = inRaw.app;
    if (app !== 'claude' && app !== 'codex') return bad('bad_app', 'app 必须是 claude 或 codex', 400);
    if (inRaw.model !== undefined && typeof inRaw.model !== 'string')
      return bad('bad_model', 'model 必须是字符串', 400);
    const model = inRaw.model === undefined ? '' : inRaw.model;
    const kind = inRaw.kind === undefined ? (app === 'claude' ? 'messages' : 'responses') : inRaw.kind;
    if (!KINDS_BY_APP[app].includes(kind))
      return bad('kind_app_mismatch', `kind 不属于 ${app} 组(可选:${KINDS_BY_APP[app].join(' / ')})`, 400);

    const ctxIn = (inRaw.context && typeof inRaw.context === 'object') ? inRaw.context : {};
    const str = v => (typeof v === 'string' ? v : undefined);
    const bodyText = str(ctxIn.bodyText) || '';
    // bodyText 只用来回显"调用方给了多少正文",不参与判定:通用子串匹配已删除,
    // 判定只看压缩规则的固定特征串(compactTexts)。
    const compactTexts = Array.isArray(ctxIn.compactTexts) ? ctxIn.compactTexts.filter(t => typeof t === 'string') : [];
    const ctx = {
      session: str(ctxIn.session), ua: str(ctxIn.ua), token: str(ctxIn.token),
      bodyText: bodyText ? () => bodyText : undefined,
      compactTexts: () => compactTexts,
    };
    const warnings = [];
    const resultLimits = emptyLimits();
    const cap = (list, field) => {
      const shown = list.slice(0, limits.maxCandidates);
      const omitted = list.length - shown.length;
      resultLimits.arrays[field] = { total: list.length, shown: shown.length, omitted };
      if (omitted) {
        resultLimits.arraysTruncated = true;
        warnings.push({ code: field === 'candidates' ? 'candidates_truncated' : 'array_truncated', field,
          message: `${field} 超过 ${limits.maxCandidates} 项,省略 ${omitted} 项(仅截断展示,仍按全部成员预测)` });
      }
      return shown;
    };

    // 达到 trace 上限后继续计数;槽位提醒也保留,不能因展示截断把真实的回落静默掉。
    const events = [];
    let slotEvent;
    const trace = ev => {
      if (ev.stage === 'slot') slotEvent = ev;
      if (events.length >= limits.maxTraceEvents) { resultLimits.rulesOmitted++; return; }
      events.push(ev.when ? { ...ev, when: safeWhen(ev.when) } : ev);
    };
    const bindings = typeof sessionSnapshot === 'function' ? prunedBindings(sessionSnapshot()) : null;
    const bound = bindings && ctx.session ? bindings.get(ctx.session) : undefined;
    ctx.sessionRouting = routingOf(bound);
    // 会话里用户手动钉定的渠道:精确模型阶段遇到"多个渠道登记同一个模型"时用它解歧义,
    // 与 lib/proxy/prepare.js 的 pin 同一判据 —— 否则预览报 409、实跑却能走,两边不一致。
    if (bound && bound.pinned && bound.providerId) ctx.pin = String(bound.providerId);
    const resolved = resolver(model, ctx, app, trace);
    resultLimits.rulesTraced = events.length;
    resultLimits.truncated = resultLimits.rulesOmitted > 0; // 保持原语义:只指 trace 事件截断
    if (resultLimits.truncated) warnings.push({ code: 'rules_truncated',
      message: `判定事件超过预览上限,只跟踪了前 ${limits.maxTraceEvents} 条判定事件(共丢弃 ${resultLimits.rulesOmitted} 条)` });
    if (!ctx.session) warnings.push({ code: 'new_session_preview', message: '未提供完整会话键,按新会话预览;不推断身份或检查某个已有会话的绑定' });
    if (typeof sessionSnapshot !== 'function') warnings.push({ code: 'session_snapshot_unavailable',
      message: '未提供只读会话快照,无法核对已有粘性或钉定;策略预测按新会话,least_used 使用注入的 sessionCounts' });
    if (slotEvent && slotEvent.outcome === 'no_such_slot') warnings.push({ code: 'slot_fell_through',
      message: `模型名 "${slotEvent.detail.alias}" 像槽位别名,但槽位表里没有它,已按精确登记模型继续` });
    if (slotEvent && slotEvent.outcome === 'slot_unbound_falls_through') warnings.push({ code: 'slot_unbound',
      message: `槽位别名 "${slotEvent.detail.alias}" 在槽位表里存在但没有绑定渠道,已按精确登记模型继续` });

    // 判定顺序只有三步:压缩规则 → 精确槽位别名 → 精确已登记模型。
    // 每个阶段列出它自己的判定事件;命中的那个阶段给出 hit。
    const byStage = s => events.filter(e => e.stage === s);
    const stages = [];
    const compactEvents = byStage('compact');
    if (compactEvents.length) stages.push({ stage: 'compact', evaluated: compactEvents,
      hit: resolved.stage === 'compact' ? (resolved.rule && resolved.rule.id) || null : null });
    const slotEvents = byStage('slot');
    const slotLast = slotEvents[slotEvents.length - 1];
    if (slotLast) stages.push({ stage: 'slot', outcome: slotLast.outcome, detail: slotLast.detail,
      hit: resolved.stage === 'slot' ? resolved.slot || null : null });
    const modelEvents = byStage('model');
    const modelLast = modelEvents[modelEvents.length - 1];
    if (modelLast) stages.push({ stage: 'model', outcome: modelLast.outcome, detail: modelLast.detail,
      hit: resolved.stage === 'model' && resolved.rule ? resolved.rule.id : null });

    const strategy = resolved.strategy || 'round_robin';
    const matchedRule = resolved.rule ? {
      id: resolved.rule.id, match: String(resolved.rule.match || ''), provider: String(resolved.rule.provider || ''),
      model: String(resolved.rule.model || ''),
      pool: cap(Array.isArray(resolved.rule.pool) ? resolved.rule.pool : [], 'matched.rule.pool').map(safePoolMember),
      strategy: strategyOf(resolved.rule), priority: Number(resolved.rule.priority) || 0, app: resolved.rule.app || '',
      when: safeWhen(resolved.rule.when), enabled: resolved.rule.enabled !== false,
    } : null;

    const availability = new Map();
    const availabilityOf = id => {
      if (!availability.has(id)) {
        availability.set(id, { eligible: !!healthEligible(id) });
      }
      return availability.get(id);
    };
    const eligibleById = id => availabilityOf(id).eligible;
    const toCandidate = m => {
      const p = sanitizeProvider(m.provider) || {};
      return {
        providerId: String(p.id || ''), providerName: String(p.name || ''), model: String(m.model || ''),
        wire: wireOf(p, app), weight: Number(m.weight) || 1, enabled: p.enabled !== false,
        ...availabilityOf(p.id), ghost: false,
      };
    };
    const members = resolved.members || [];
    const ghosts = cap(resolved.ghosts || [], 'ghosts');
    if (ghosts.length || (resolved.ghosts || []).length) warnings.push({ code: 'ghost_ref', message: '规则指向的渠道已删除' });
    const result = {
      ok: true,
      input: { app, model, kind, context: {
        hasSession: !!ctx.session, hasUa: !!ctx.ua, hasToken: !!ctx.token,
        hasBodyText: !!bodyText, bodyTextLen: bodyText.length,
      } },
      stages,
      matched: { via: resolved.stage || 'model',
        ruleId: (resolved.rule && resolved.rule.id) || null, slot: resolved.slot || null, rule: matchedRule, strategy },
      candidates: cap(members, 'candidates').map(toCandidate), kindFilter: null, effective: [], selection: null,
      ghosts, warnings, error: null, limits: resultLimits,
    };
    const fail = (code, httpStatus, message) => ({ ...result, ok: false, error: { code: protoTypeOf(code), httpStatus, message } });

    // ---- 错误分型:与 lib/proxy/prepare.js 的转发路径逐条对齐,免得预览说能走、实跑报错
    // resolver 直接给出的终态错误(歧义 409 / 没有登记模型 503)优先,它就是实跑会回的那一条。
    if (resolved.error)
      return fail(resolved.error.type === 'model_ambiguous_error' ? 'model_ambiguous' : 'no_route',
        resolved.error.status, resolved.error.message);
    // 与 prepare 同序:专用 Key、停用单选、kind 过滤、空池先于会话选择。
    // 只使用查找结果判可用性,带凭据的局部副本绝不进入预览结果。
    if (hasKeyPin(resolved.rule) && !pinnedProvider(resolved.rule, storeOf(app)))
      return fail('provider_key_unavailable', 503, '压缩专用 Key 不可用，请在控制台重新选择');
    if (members.length === 1 && members[0].provider.enabled === false)
      return fail('provider_disabled', 503, `路由命中的渠道 "${members[0].provider.name}" 已停用`);

    // ---- kind 过滤(chat/completions 客户端只能落到 chat 上游)
    let effectiveMembers = members;
    if (kind === 'chat/completions' && members.length) {
      const chatOnly = members.filter(m => wireOf(m.provider, app) === 'chat');
      result.kindFilter = {
        kind, applied: true,
        kept: cap(chatOnly, 'kindFilter.kept').map(m => m.provider.id),
        dropped: cap(members.filter(m => wireOf(m.provider, app) !== 'chat'), 'kindFilter.dropped')
          .map(m => ({ providerId: m.provider.id, wire: wireOf(m.provider, app), reason: 'wire_not_chat' })),
      };
      if (!chatOnly.length) return fail('wire_api_mismatch', 400,
        '路由命中的 Codex 渠道都是 responses 协议,收不了 /v1/chat/completions;把渠道 wire_api 改成 chat,或让客户端改用 /v1/responses');
      effectiveMembers = chatOnly;
    }
    result.effective = cap(effectiveMembers, 'effective').map(toCandidate);
    if (!effectiveMembers.length) {
      const port = uiPort ? `请在控制台 http://127.0.0.1:${uiPort} 给渠道补上模型名,或重新选择槽位目标` : '请在控制台给渠道补上模型名,或重新选择槽位目标';
      const omitted = resultLimits.arrays.ghosts.omitted;
      const msg = resolved.slot
        ? `槽位 "${resolved.slot}" 的别名 "${model}" 已无可用渠道:绑定的渠道可能已被删除,请在控制台重新选择槽位目标`
        : (resolved.ghosts || []).length
          ? `模型 "${model}" 命中的压缩设置 ${resolved.rule ? resolved.rule.id : ''}绑定的渠道已不存在(${ghosts.map(g => `${g.where}=${g.id}`).join('、')}${omitted ? `;另省略 ${omitted} 项` : ''})。请到控制台的「压缩设置」重新选择目标渠道`
          : `模型 "${model}" 没有匹配的可用渠道(${app} 组)。${port}`;
      return fail('no_route', 503, msg);
    }

    // 已有绑定与 least_used 必须来自同一份剪枝后的副本,不能拿未过 TTL 的数量冒充活跃数。
    let counts;
    if (bindings) {
      counts = Object.create(null);
      for (const v of bindings.values()) counts[v.providerId] = (counts[v.providerId] || 0) + 1;
    } else counts = (typeof sessionCounts === 'function' ? sessionCounts() : sessionCounts) || {};

    let source = 'strategy', picked = null;
    const desc = describeStrategy(strategy);
    let deterministic = desc.deterministic, note = desc.note;
    const slotRequest = String((resolved.rule && resolved.rule.id) || '').startsWith('slot:');
    if (resolved.content) {
      source = 'compact'; picked = effectiveMembers[0];
      note = '压缩设置命中:直接取 kind 过滤后的第一个成员,不运行池策略、不走会话粘性,也不因健康状态重挑首选';
    } else if (bound) {
      if (bound.pinned && !slotRequest) {
        const p = storeOf(app).find(x => x.id === bound.providerId);
        if (p && p.enabled !== false && eligibleById(p.id)) {
          source = 'pinned';
          picked = { provider: p, model: bound.model || (resolved.rule && resolved.rule.model) || '', weight: 1 };
          note = '手动钉定:检查本组渠道存在、启用且通过可用性预检,不要求属于原池;已通过的 kind 过滤不再重跑';
        }
      }
      if (!picked && !slotRequest) {
        const m = effectiveMembers.find(x => x.provider.id === bound.providerId);
        if (m && eligibleById(bound.providerId)) {
          source = 'sticky'; picked = m;
          note = '复用已有粘性:绑定渠道仍在 kind 过滤后的池中,且通过健康检查;沿用当前池成员的模型';
        }
      }
    }
    if (picked) {
      deterministic = true;
    } else {
      // 可选池 = 通过可用性预检的成员;全不可用时退回全量(与 pickMember 的 pool 同义)。
      const available = effectiveMembers.filter(m => eligibleById(m.provider.id));
      const pool = available.length ? available : effectiveMembers;
      if (!available.length) warnings.push({ code: 'all_members_ineligible', message: '当前没有可选成员,首选策略会退回全量候选' });
      // pickMember 的 `pool.length === 1` 早退在策略分支之前,random 单成员也必须走同一条。
      if (strategy === 'random' && pool.length === 1) {
        deterministic = true; picked = pool[0];
        note = '随机策略当前只有一个可选成员,首选确定(预览不取随机数)';
      } else if (deterministic) {
        // 精确模型命中时 rule 由 resolver 现造(id=model:<渠道>),不依赖任何兜底表。
        // weighted 在新成员对象上改 current,浅拷贝 pools 足以保护现役余量表。
        const effectiveRule = resolved.rule || { id: 'model', strategy: resolved.strategy };
        picked = pickMember(effectiveRule, effectiveMembers, {
          eligible: eligibleById, activeCount: id => counts[id] || 0, pools: { ...(listPools() || {}) },
        });
      }
      if (bound && slotRequest) note += ';槽位请求不复用对话钉定或粘性,按槽位池策略选择';
    }
    // candidates 是**候选池**不是最终落点:四个分支(content/sticky/pinned/strategy)都列同一份
    // kind 过滤后的有效成员,只为展示截断;predicted 才是这一条请求的首选。钉定可以选池外渠道,
    // 那时 predicted 故意不在 candidates 里(note 会说明),不能因此把 candidates 缩成单元素。
    result.selection = { strategy, source, deterministic, predicted: picked ? toCandidate(picked) : null,
      candidates: cap(effectiveMembers, 'selection.candidates').map(m => m.provider.id), note: `${note}。${SCOPE_NOTE}` };
    if (picked) {
      try {
        const key = selectSessionKey(picked.provider, resolved, ctx.sessionRouting);
        result.selection.key_id = hasKeyPin(resolved.rule) ? resolved.rule.key_id : key.key_id;
        result.selection.key_source = hasKeyPin(resolved.rule) ? 'compact' : key.key_source;
        result.selection.key_pinned = hasKeyPin(resolved.rule) || key.pinned;
        if (key.pinned) result.selection.note += ';会话固定 Key：失败不转移到其他账号';
      } catch (e) { return fail('provider_key_unavailable', 503, e.message); }
    }
    return result;
  };
}

module.exports = { createExplainer, sanitizeProvider, describeStrategy, PREVIEW_LIMITS, SAFE_PROVIDER_FIELDS };
