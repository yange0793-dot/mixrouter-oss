'use strict';
// 请求准备:从「已解析好的请求体」到一份**不可变的执行计划**(RequestPlan)。
//
// 等价搬自 mixrouter.js 的 proxyHandler(四期重构的第二期:代理边界拆分;内部规划记录不随
// 仓库发布)。本模块拥有:
//   身份推断与会话标识 → 会话覆盖快照 → 内容规则(压缩先于主槽)→ 槽位 → 候选池 →
//   Key 约束(含压缩专用 Key)。
//
// 它**不做**的事(边界即契约):
//   · 不消耗池游标以外的任何状态、不写日志、不发上游;
//   · 不决定下一次尝试 —— 那是 attempts 的事,prepare 只给出候选顺序;
//   · 不写最终日志、不累加用量 —— 那是请求上下文的事。
//
// 计划里带**活引用**是有意的:`sess`(会话记录)与 `resolved` 是可变的运行态对象,
// 后续尝试会往里写(绑定重绑)。这里给的是引用,不是快照 —— 快照会让在途请求把配置
// 覆盖回去(见 sessions.js 的说明)。配置本身(store/routes/slotMap)则一律经
// 注入的访问器**现取**,不在这里快照。
//
// 入口错误一律作为**返回值**给出({ error: { status, type, message } }),本模块不写 HTTP 响应:
// 回什么形状是入口编排的事,这里只说"这条请求不该转发,原因是这个"。

function createPreparer(deps) {
  const {
    UI_PORT, MAX_ATTEMPTS,
    storeOf, sessionRecord, sessionConfig, sessionKeyOf, sessionIdentity, sessionLabel,
    bodyRouteText, compactTexts, resolveRoute, compactLib, wireOf,
  } = deps;

  const err = (status, type, message) => ({ error: { status, type, message } });
  // 通用入口错误:调用方拿到 status/type/message 直接交给 protoError
  const badRoute = (app, resolved, modelIn) => {
    // 命中了规则、但规则里的目标渠道查不到:直说哪条规则指向了哪个已删渠道。
    // 报成"没有匹配的路由"会让用户以为规则没生效,跑去翻一遍找不到问题。
    if (resolved.slot) return `槽位 "${resolved.slot}" 的别名 "${modelIn}" 已无可用渠道:绑定的渠道可能已被删除,请在控制台重新选择槽位目标`;
    if (resolved.ghosts && resolved.ghosts.length)
      // 兜底路由没有 rule(它本身就是 rule=null),别去读它的 id
      return `模型 "${modelIn}" 命中的${resolved.rule ? `路由规则 ${resolved.rule.id}` : '兜底路由'}绑定的渠道已不存在（${resolved.ghosts.map(g => `${g.where}=${g.id}`).join('、')}）。请在控制台 http://127.0.0.1:${UI_PORT} 的「路由」页重新选择目标渠道`;
    if (app === 'codex') return `模型 "${modelIn}" 没有匹配的 Codex 渠道。请在控制台 http://127.0.0.1:${UI_PORT} 的「路由」页为它配目标(要选 Codex 组渠道)`;
    return `模型 "${modelIn}" 没有匹配的路由,或路由未绑定 Claude 渠道。请在控制台 http://127.0.0.1:${UI_PORT} 配置路由`;
  };

  // ep: classifyProxyRequest 的结果(app/kind/path),body: 已解析的请求体
  function prepareRequest(ep, body, req) {
    const app = ep.app;
    const modelIn = body.model || '';
    const harness = ep.client === 'dsh';
    const identity = sessionIdentity(req, body, harness ? 'codex' : app);
    const ident = harness ? { ...identity, key: 'dsh:' + identity.key } : identity;
    const label = sessionLabel(body, harness ? 'codex' : app);
    // Harness 槽位独立于 Claude 的内容分流、会话槽位和 Key 覆盖。
    const sessionRouting = harness ? { keys: {}, slots: {} }
      : sessionConfig.routingOf(sessionRecord(ident.key));
    // 内容分流(when.body)只看「system/instructions + 最后一条消息」,不看整段历史:
    // 整包 body 里带着全部对话,历史里偶然出现一次触发短语(比如把规则原文引用了一遍)
    // 就会让此后每条请求都改道,而且是永久性的——历史每轮都重发。实测踩过。
    // 压缩类请求的指令就在最后一条消息里,照旧命中。只在真有 when.body 规则时才拼。
    let routeLower;
    const bodyText = () => routeLower ?? (routeLower = bodyRouteText(body).toLowerCase());
    const slot = harness ? deps.dshRouting?.resolve(modelIn) : null;
    if (harness && !slot) return err(503, 'no_route_error',
      `Harness 模型 "${modelIn}" 没有可用槽位,请在控制台的 DeepSeek Harness 页面配置`);
    const resolved = harness ? {
      rule: slot.rule, members: [{ provider: slot.provider, model: slot.model, weight: 1 }],
      provider: slot.provider, model: slot.model, strategy: 'round_robin',
      slot: slot.name, slot_namespace: 'dsh', ghosts: [],
    } : resolveRoute(modelIn, {
      session: ident.key, sessionRouting, ua: req.headers['user-agent'], token: clientTokenOf(req), bodyText,
      compactTexts: () => compactTexts(body),
    }, app);
    const compactPin = compactLib.hasKeyPin(resolved.rule);
    // 专用 Key 失效就明确拒绝，不能默默退回渠道的生效账号。
    if (compactPin && !compactLib.pinnedProvider(resolved.rule, storeOf(app)))
      return err(503, 'provider_key_unavailable_error', '压缩专用 Key 不可用，请在控制台重新选择');
    // 单一目标停用 → 明确分型(池会自动跳过停用成员,不会落到这)
    if (resolved.members.length === 1 && resolved.members[0].provider.enabled === false)
      return err(503, 'provider_disabled_error', `路由命中的渠道 "${resolved.members[0].provider.name}" 已停用`);
    // chat 协议客户端只能落到 chat 上游;responses 客户端两种上游都能落(chat 上游由代理翻译)
    let members = resolved.members;
    if (ep.kind === 'chat/completions' && members.length) {
      const chatOnly = members.filter(m => wireOf(m.provider, app) === 'chat');
      if (!chatOnly.length) return err(400, 'wire_api_mismatch_error',
        '路由命中的 Codex 渠道都是 responses 协议,收不了 /v1/chat/completions;把渠道 wire_api 改成 chat,或让客户端改用 /v1/responses');
      members = chatOnly;
    }
    if (!members.length) return err(503, 'no_route_error', badRoute(app, resolved, modelIn));

    // 本会话锁定的渠道优先,其余池成员依次作后备(只在还没给客户端写字节时才会换)
    // 内容分流命中的请求不参与会话粘性:它只代表"这一条请求"走那条路,不代表对话换了渠道
    const target = resolved.content
      ? { member: members[0], sticky: false, rebind: false }
      : resolveSessionTargetOf(resolved.rule, members, ident.key, label, ident.kind, app, resolved.strategy);
    const sess = sessionEntryOf(ident.key, ident.kind, members, label, app);
    // 在途请求 guard 的令牌(见 lib/routing/sessions.js 的 captureRequest/settleRequest)。
    // **必须在 entry 之后**捕获:记录不存在时令牌 seal 为 no-record,之后任何结算都不会写 ——
    // 这条请求不该替一条并不存在的记录建档。令牌只是快照,后续尝试拿它去结算。
    const flight = captureRequestOf(ident.key);
    let selectedKey;
    try { selectedKey = sessionConfig.selectSessionKey(target.member.provider, resolved, sessionRouting); }
    catch (e) { return err(503, 'provider_key_unavailable_error', e.message); }
    const wasSticky = target.sticky && !target.rebind;
    // 候选顺序:本会话锁定的渠道优先,其余池成员依次作后备(只在还没给客户端写字节时才换)。
    // 名单再**循环复用**填满到 MAX_ATTEMPTS:单渠道时同一个成员会出现十次,于是失败后隔一秒
    // 重打同一个渠道,而不是一次就把 502 甩给客户端。member 是同一对象引用没问题 ——
    // attempt 每一发都从 store 现取最新渠道。
    // 固定 Key 选中时仍然只有 1 个:那是用户明确钉死的账号,换无可换。
    const candidates = [target.member]
      .concat(members.filter(m => m.provider.id !== target.member.provider.id));
    const width = Math.max(1, MAX_ATTEMPTS);
    const ordered = selectedKey.pinned
      ? [target.member]
      : Array.from({ length: width }, (_, k) => candidates[k % candidates.length]);

    return {
      plan: {
        app, kind: ep.kind, ep, body, req,
        modelIn, ident, label, sessionKey: sessionKeyOf(ident.key), sessionRouting,
        resolved, compactPin, members, target, sess, flight, selectedKey, wasSticky, ordered,
      },
    };
  }

  // 这两个是注入进来的领域函数:会话目标解析与会话记录访问都由调用方决定,
  // 本模块不碰会话写入语义(在途 guard 由另一条独立交付接线)。
  function resolveSessionTargetOf(...args) { return deps.resolveSessionTarget(...args); }
  function sessionEntryOf(...args) { return deps.sessionEntry(...args); }
  function clientTokenOf(req) { return deps.clientToken(req); }
  function captureRequestOf(key) { return deps.captureRequest(key); }

  return { prepareRequest };
}

module.exports = { createPreparer };
