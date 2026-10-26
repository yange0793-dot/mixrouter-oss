'use strict';
// 单次 attempt:Key 重查 → 出站构造 → HTTP 调用 → 交响应分派。
//
// 等价搬自 mixrouter.js 的 proxyHandler 单次尝试段(第二期重构的 runAttempt 一行;
// 内部规划记录不随仓库发布)。
//
// 所有权(与规划的状态约束一一对应):
//   · 本次尝试的 HTTP 句柄与看门狗计时器**只在本函数里**创建与释放;
//   · 下一次尝试由调度层(lib/proxy/attempts.js)决定 —— 这里只经 loop 的窄接口回到它;
//   · 终态记录、客户端/上游取消器、端到端预算归请求上下文(lib/proxy/context.js),这里只读;
//   · 协议转换与转发在 lib/proxy/response.js,本函数只把这一发的控制面交给它。
//
// 活配置(store / slotMap)一律经注入的**访问器现取**,不在这里快照:
// 控制台刚保存的渠道与槽位必须对在途重试立刻生效(与拆分前同义)。

const { upstreamStreamFor, applyUpstreamStream } = require('../upstream-stream');
const { projectResponsesHistory, replayableUnprojectedHistory } = require('../responses-history');
const { isOfficialAgentRouterHttps } = require('../responses-recovery');

function createAttempt(deps) {
  const {
    http, https, storeOf, refreshProvider, slotMapOf, sessionConfig, compactLib,
    wireOf, upstreamPathOf, joinUpstreamPath,
    buildUpstreamHeaders, buildOpenAiHeaders, applyModel, toolFilter,
    safeHeader, hasCtlChar, transportAgent, createResponseArchive, channelSecrets, clientToken,
    errorClass, retryableStatus, sha256,
    wireResponses, wireChat, wireOpenai,
    convCacheKey, convCacheGen, rotateConvCacheGen,
    firstHeaderTimeoutFor, streamIdleTimeoutMs, nonstreamTotalTimeoutMs,
    responseArchiveOn, responseArchiveDir, uiPort, DEFAULT_UA_CODEX,
    dispatchResponse,
    // 可选多 Key 自动备用(lib/routing/key-fallback.js)。**默认关闭**:渠道没开
    // key_fallback 时它的每个入口都原样返回,这里的行为与接之前逐字相同。
    // 失败排除集合与粘性都归它自己,本模块只在三个点上问它:选号、失败归因、成功恢复。
    keyFallback,
    // 会话在途 guard 的结算入口由装配处注入(本模块不 require 主入口,也不认识会话存储)。
    settleRequest,
  } = deps;
  const { responsesToChat } = wireOpenai;

  // loop:调度层窄接口(lib/proxy/attempts.js)
  //   loop.ordered / loop.retry(i) / loop.pinTo(i) / loop.useConvRetry() / loop.convRetriesLeft
  // ctx:请求上下文(lib/proxy/context.js)
  // i:候选游标
  function runAttempt(loop, plan, ctx, i) {
    // 阶段流水是旁路:ctx 由 lib/proxy/context.js 提供时一定有 recordAttemptEvent,
    // 但 attempt 也可能被单测/嵌入方直接调用 —— 缺了它也只能少记,不能抛。
    const note = event => { try { if (typeof ctx.recordAttemptEvent === 'function') ctx.recordAttemptEvent(event); } catch {} };
    const { entry, started, deadlineMs, deadlineAt } = ctx;
    const { ep, body, req, modelIn, ident, resolved, compactPin, sessionRouting, sessionKey } = plan;
    const ordered = plan.ordered;
    const app = plan.app;
    const member = ordered[i];
    // entry 是整条请求共用的,错误归因却必须属于当前这一发。旧失败仍在 attempt trace 中;
    // 开始新尝试才清掉,不在 200 头/最终收尾时盲清,否则会吞掉这次体阶段的真实错误。
    entry.status = 0; entry.err = ''; entry.err_class = '';

    // 每次尝试重查 Key 清单；会话配置则使用请求入口的快照。
    // keyModel 只用于"这次是哪个模型"的 Key 失败归因(模型级记录按它做键)。
    // 它必须与 select/failure/success 三处一致,否则同一把 Key 会同时挂在两个模型名下。
    const keyModel = member.model || modelIn;
    let keyChoice, keyPinned = false;
    const nativeSnapshot = plan.nativeRecovery;
    const frozenNative = nativeSnapshot && nativeSnapshot.providerId === member.provider.id
      && nativeSnapshot.memberModel === member.model;
    try {
      if (frozenNative) keyChoice = nativeSnapshot.keyChoice;
      else {
        const latest = typeof refreshProvider === 'function'
          ? refreshProvider(member.provider, app, plan)
          : storeOf(app).find(p => p.id === member.provider.id);
        keyChoice = sessionConfig.selectSessionKey(latest || { id: member.provider.id, enabled: false }, resolved, sessionRouting);
        // 未固定 Key 的在途请求保留原候选快照；删除渠道不能让重试拿着空 URL 崩溃。
        if (!latest && !keyChoice.pinned)
          keyChoice = sessionConfig.selectSessionKey(member.provider, resolved, sessionRouting);
        // 可选多 Key 自动备用:默认关闭时返回的就是传进去的同一个对象。
        // 会话粘性 Key 被删/停用时它抛明确错误(不静默换号),与上一句同一个 catch。
        if (keyFallback && typeof keyFallback.select === 'function') {
          keyChoice = keyFallback.select({
            // sessionKey 用**完整身份键**(ident.key),不是 plan.sessionKey:
            // 后者是给日志看的 8 位短键(sessionKeyOf),拿它当粘性表的键会让不同会话撞在一起,
            // 于是 A 会话挑中的备用账号会漏给 B 会话。
            provider: latest || member.provider, keyChoice, sessionKey: ident.key, model: keyModel,
            pinned: compactPin === true, failedKeys: ctx.failedKeys || (ctx.failedKeys = new Set()),
          }) || keyChoice;
        }
      }
      // 固定 = 用户明确钉死的账号:会话/槽位的 pinned,以及压缩专用 Key。
      // 钉死的账号换掉等于在用户不知情时改了落点,所以永远不参与自动备用。
      keyPinned = compactPin === true || keyChoice.pinned === true || keyChoice.key_source === 'compact';
    } catch (e) {
      entry.ms = Date.now() - started;
      entry.status = 503; entry.err = e.message; entry.err_class = 'provider_key_unavailable';
      // 阶段流水只记分类与渠道,不记 e.message(它可能带 Key 或上游原文)。
      note({ phase: 'error', attempt: ctx.netAttempts, provider_id: member.provider.id,
        model: member.model || modelIn, status: 503, code: 'provider_key_unavailable' });
      ctx.finish();
      return ctx.sendErr(503, 'provider_key_unavailable_error', entry.err, entry.err_class);
    }
    // 固定账号一旦被选中，本请求不再尝试别的渠道/账号。
    if (keyChoice.pinned) loop.pinTo(i);
    entry.key_id = compactPin ? resolved.rule.key_id : keyChoice.key_id;
    entry.key_source = compactPin ? 'compact' : keyChoice.key_source;
    const provider = compactPin ? compactLib.pinnedProvider(resolved.rule, storeOf(app)) : keyChoice.provider;
    if (compactPin && (!provider || provider.id !== member.provider.id)) {
      entry.ms = Date.now() - started;
      entry.status = 503; entry.err = '压缩专用 Key 不可用，请在控制台重新选择';
      entry.err_class = 'provider_key_unavailable';
      note({ phase: 'error', attempt: ctx.netAttempts, provider_id: member.provider.id,
        model: member.model || modelIn, status: 503, code: 'provider_key_unavailable' });
      ctx.finish();
      return ctx.sendErr(503, 'provider_key_unavailable_error', entry.err, entry.err_class);
    }
    const wire = wireOf(provider, app);
    const recoveryKeyChoice = { ...keyChoice, provider: { ...provider, wire_api: wire } };
    // 候选表按 MAX_ATTEMPTS 循环填满,单渠道时后一项还是它自己。本地预检拒绝(能力不匹配、
    // 坏凭据)对同一渠道每次结论都一样,再重打十遍只是把错误推迟九秒;
    // 只有下一个候选真是**别的渠道**时才值得换过去。
    const nextIsOtherProvider = () => i + 1 < ordered.length
      && ordered[i + 1].provider.id !== provider.id;
    // 原生 Responses 压缩只能落到 responses 协议渠道:chat 网关没有 /v1/responses/compact 这个
    // 端点,硬发过去只会被上游当成未知路径。同一池里还有别的候选就先换一个;全都不是
    // responses 就明确 501 —— 报 502「上游失败」会把"这条路由配错了"说成"上游坏了"。
    // 注意这一跳在 netAttempts++ **之前**:没打出去的候选不算一次上游调用。
    if (ep.kind === 'responses/compact' && wire !== 'responses') {
      if (nextIsOtherProvider()) return loop.retry(i + 1);
      entry.ms = Date.now() - started;
      entry.status = 501; entry.err = 'Chat 渠道不支持原生 Responses 压缩，请选择 Responses 渠道';
      entry.err_class = 'unsupported_compaction';
      note({ phase: 'error', attempt: ctx.netAttempts, provider_id: provider.id,
        model: member.model || modelIn, status: 501, code: 'unsupported_compaction' });
      ctx.finish();
      return ctx.sendErr(501, 'invalid_request_error', entry.err, entry.err_class);
    }
    // claude 客户端落到 responses/chat 型渠道:本进程内翻译
    // (lib/wire-responses.js 翻 Responses,lib/wire-chat.js 翻 Chat Completions)
    const conv = (wire === 'responses' || wire === 'chat') && ep.kind === 'messages';
    const nativeResponses = wire === 'responses' && ep.kind === 'responses';
    const sessKey = sessionKey;
    // count_tokens 在 responses 线上没有对应端点,本地按体积估一个(与旧转换代理同口径)。
    // **这一支排在 netAttempts 之前**:它是纯本地计算,一个字节都不发上游 ——
    // 既不该消耗"真实上游调用"的预算,也不该被算成一次渠道尝试。attempts 恒为 0。
    if (ep.kind === 'count_tokens' && wire !== 'anthropic') {
      entry.attempts = ctx.netAttempts; entry.provider = provider.name;
      entry.model_out = member.model || modelIn; entry.wire = wire; entry.status = 200;
      entry.in = Math.max(1, Math.ceil(ctx.rawLen / 4));
      // 耗时不能漏:同函数其它每个终态都赋了 entry.ms,只有这条本地估算的成功路径没赋,
      // 于是这一类请求在日志与控制台统计里的耗时是空的,分位数也少了一批样本
      entry.ms = Date.now() - started;
      // 本地估算没有发上游:记 response/200 但 attempts 保持 0,页面不会把它当真实网络调用。
      note({ phase: 'response', attempt: 0, provider_id: provider.id,
        model: member.model || modelIn, status: 200 });
      ctx.finish();
      if (ctx.res.headersSent) return;
      ctx.res.writeHead(200, {
        'Content-Type': 'application/json', 'x-mixrouter-app': app,
        'x-mixrouter-provider': safeHeader(provider.name), 'x-mixrouter-model': safeHeader(member.model || modelIn),
        'x-mixrouter-session': safeHeader(sessKey),
      });
      return ctx.res.end(JSON.stringify({ input_tokens: entry.in }));
    }
    // 默认保留各转换线的出站形状;只有 resolved rule 的显式布尔值才覆盖 OpenAI 上游。
    // 客户端 body.stream 不改,响应侧仍据它选择 SSE 或整包 JSON。
    const upstreamStream = upstreamStreamFor({ wire, kind: ep.kind, body, rule: resolved.rule });
    const streamOverride = ep.kind !== 'responses/compact' && (wire === 'chat' || wire === 'responses')
      && typeof resolved.rule?.upstream_stream === 'boolean';
    // 存量脏凭据:控制台的写入闸门是后加的,已经躺在 providers.json 里的换行 Key 还可能被
    // 转发到。**不要**悄悄把它洗干净再发出去——那样上游只会回一个没头没脑的 401,用户看到
    // 的是"Key 失效了",而真正的原因是数据里有控制字符。明确报出来,并说清去哪修。
    // (不能就这么发出去:transport.request 会同步抛,吞掉整条请求。见下面那个 try)
    if (hasCtlChar(provider.api_key)) {
      // 只记分类:凭据本身(哪怕坏掉)一个字都不进 trace。
      note({ phase: 'error', attempt: ctx.netAttempts, provider_id: provider.id,
        model: member.model || modelIn, status: 502, code: 'bad_credential' });
      if (nextIsOtherProvider()) { entry.failover = true; return loop.retry(i + 1); }
      entry.ms = Date.now() - started;
      entry.status = 502;
      entry.err = `渠道 ${provider.name} 的 API Key 含换行或控制字符,无法发送`;
      entry.err_class = 'bad_credential';
      ctx.finish();
      return ctx.sendErr(502, 'api_error',
        `上游 ${provider.name} 的 API Key 含换行或控制字符,请求无法发出。请到控制台 http://127.0.0.1:${uiPort} 重新粘贴该渠道的 API Key`, 'bad_credential');
    }
    const headers = frozenNative ? { ...nativeSnapshot.headers }
      : wire === 'anthropic' ? buildUpstreamHeaders(provider, req) : buildOpenAiHeaders(provider, req, upstreamStream);
    // [1M] 后缀与 beta 头只对 Anthropic 上游有意义;Responses 上游收的是裸名
    const model = frozenNative ? nativeSnapshot.model
      : wire === 'anthropic' ? applyModel(member.model || modelIn, headers) : wireResponses.stripModelSuffix(member.model || modelIn);
    // 槽位级工具剥离(见 lib/tool-filter.js):命中槽位配了 dropTools 就从**出站 body**里
    // 删掉这些工具。位置必须在 outBody 之前——五种 wire 分支共用同一个 body,这里删一次
    // 就全覆盖;放到各分支里写就要写五遍,漏一处就是"某条线上主链还有 Bash"。
    // body 是整条请求共用的对象,failover 复用同一对象:apply 是幂等的,第二轮返回 0,
    // entry.tools_dropped 不会被重复计数(只记第一次真删掉的数量)。
    const slotCfg = resolved.slot ? ((slotMapOf().claude || {})[resolved.slot] || null) : null;
    if (slotCfg && Array.isArray(slotCfg.dropTools) && slotCfg.dropTools.length) {
      const dropped = toolFilter.apply(body, slotCfg.dropTools);
      if (dropped) entry.tools_dropped = (entry.tools_dropped || 0) + dropped;
    }
    // prompt_cache_key 的渠道亲和(new-api 系)只对 responses 线有意义,chat 线没有这个概念
    const convKey = conv && wire === 'responses' ? convCacheKey(sessKey, provider.id, convCacheGen(sessKey, provider.id)) : '';
    // 转换线的诊断计数:客户端到底把 thinking 回传了没有。deepseek 系 responses 上游要求
    // 历史里每个 function_call 都带着 reasoning_text,缺了就是整包 400——两个数进
    // requests.jsonl,下次再出这种 400 时一眼能看出是不是客户端没回传(think=0),还是
    // 回传了但转换/位置不对(think>0 还 400)。
    const convStats = {};
    // 上游是 Codex 型通道时按 Codex 客户端的样子说话(claude-cli 的 UA 会被这类网关另眼看待);
    // chat 型网关走 buildOpenAiHeaders 的默认 UA,不需要这层伪装
    if (conv && wire === 'responses') headers['User-Agent'] = safeHeader(provider.ua) || DEFAULT_UA_CODEX;
    const convertedBody = (wire === 'chat' && ep.kind === 'responses')
      ? responsesToChat({ ...body, model }, provider)
      : (wire === 'chat' && ep.kind === 'messages')
      ? wireChat.anthropicToChat({ ...body, model }, { stats: convStats })
      : conv
      ? wireResponses.anthropicToResponses({ ...body, model }, { promptCacheKey: convKey, stats: convStats })
      : wire === 'anthropic' && ep.kind === 'messages'
      ? { ...body, model, stream: true }
      : { ...body, model };
    // 转换器先返回对象,再统一覆写。无覆盖的原生透传不新增 stream 键,compact 完全不碰。
    const setStream = ep.kind !== 'responses/compact' && (streamOverride || conv
      || (wire === 'anthropic' && ep.kind === 'messages') || (wire === 'chat' && ep.kind === 'responses'));
    const streamBody = frozenNative ? nativeSnapshot.streamBody
      : setStream ? applyUpstreamStream(convertedBody, upstreamStream) : convertedBody;
    const outBody = frozenNative ? nativeSnapshot.outBody : JSON.stringify(streamBody);
    // A snapshot becomes active only when the new native recovery path starts.
    // Ordinary configured HTTP/key failover remains live; successful requests do
    // not copy their potentially large history into a second parsed object.
    const nativeState = frozenNative ? nativeSnapshot : nativeResponses ? {
      providerId: provider.id, memberModel: member.model, model,
      keyChoice: recoveryKeyChoice, headers: { ...headers }, outBody, projected: false,
    } : null;
    if (conv) { entry.think = convStats.think || 0; entry.reasoning = convStats.reasoning || 0; }
    // 记录实际发往上游的档位，转换线以转换结果为准。
    entry.effort = nativeResponses ? (streamBody.reasoning?.effort || '')
      : convStats.effort || (wire === 'anthropic' && body.output_config && body.output_config.effort) || '';
    entry.attempts = ctx.netAttempts;
    entry.provider = provider.name;
    entry.model_out = model;
    entry.wire = wire;

    let archive = null, archiveEnded = false, archiveStream = upstreamStream;
    let archiveStatus = 0, receivedResponse = false;
    // 每次 HTTP 尝试分开记录；仅保存上游返回内容，不保存请求头与 prompt。
    if (responseArchiveOn) {
      try {
        archive = createResponseArchive({
          enabled: true, directory: responseArchiveDir, provider: provider.id, format: wire, stream: upstreamStream,
          metadata: { requestId: ctx.archiveRequestId, attempt: ctx.netAttempts + 1, model, modelIn,
            sessionHash: sha256(String(ident.key)),
            rule: entry.rule, app, kind: ep.kind, providerName: provider.name },
          secrets: () => [clientToken(req), ...channelSecrets()].filter(x => typeof x === 'string' && x.length),
          onError: () => console.error('[response-archive] 归档失败；本次返回不受影响'),
        });
      } catch { console.error('[response-archive] 无法建立归档；本次返回不受影响'); }
    }
    const finishArchive = (complete, errorClass = '') => {
      if (!archive || archiveEnded) return;
      archiveEnded = true;
      Promise.resolve(archive.finish({ status: archiveStatus, complete, errorClass, stream: archiveStream }))
        .catch(() => console.error('[response-archive] 归档收尾失败'));
    };

    const upstream = new URL(provider.base_url);
    const transport = upstream.protocol === 'https:' ? https : http;
    let done = false;
    // 本次尝试等响应头的预算:按发往上游的形状算(见 upstreamStream)——恒流式后上游一
    // 接受就发头,给短预算即可;「等整篇生成完才发头」的形状只剩 responses/chat 直通才有可能
    const firstHeaderMs = firstHeaderTimeoutFor(upstreamStream);
    // 本次尝试失败:记账后按重试预算打下一个候选(失败不禁用渠道,没有冷却)
    const nextOrFail = (reason, errMsg, errClass) => {
      // 本次尝试作废:先把它的看门狗(含头阶段那个)拆掉,再去打下一个渠道。
      // 漏拆的头阶段定时器会在 deadlineAt 到点后对一个早已收尾的请求开火
      ctx.clearAttemptTimers();
      // 客户端已断开:重试没有意义,也别把取消算成渠道失败
      if (ctx.clientClosed) {
        if (!ctx.finalized) {
          entry.status = 499; entry.err = errMsg || 'client closed'; entry.err_class = 'cancelled';
          entry.ms = Date.now() - started; ctx.finish();
        }
        return;
      }
      entry.err_class = errClass || errorClass(reason || 0, '') || 'network_error';
      // 阶段流水:这一次作废的真实原因(分类,不是正文)。reason 是上游状态码时有值;
      // 连接失败/超时时为 0,页面按 code 区分,不会被当成 200。
      const reasonStatus = Number(reason) >= 100 && Number(reason) <= 599 ? Number(reason) : (entry.status || 0);
      note({ phase: 'error', attempt: ctx.netAttempts, provider_id: provider.id, model,
        status: reasonStatus, code: entry.err_class || '' });
      if (frozenNative && loop.retrySame(i, () => { done = true; })) return;
      if (!frozenNative && i + 1 < ordered.length) {
        // 只有下一个候选真是**别的渠道**才算故障转移:候选表按 MAX_ATTEMPTS 循环填满,
        // 单渠道时后一项还是它自己,把重试记成转移会把会话绑定和 ↷ 标记都说错。
        if (ordered[i + 1].provider.id !== provider.id) entry.failover = true;
        return loop.retry(i + 1);
      }
      entry.ms = Date.now() - started; entry.err = errMsg;
      entry.status = entry.status || 502;
      ctx.finish();
      ctx.sendErr(entry.status, 'api_error', `上游 ${provider.name} 请求失败: ${errMsg}`, entry.err_class || 'upstream_server');
    };
    // 等响应头这一段也要被端到端总预算夹住。以前总 deadline 的定时器只在**拿到响应头之后**
    // 才创建,于是这一段只剩 socket timeout:而它是空闲超时,上游每来一个字节就重置一次
    // (实测每 20ms 补一个未结束的响应头字节,就能把预算拖过一倍以上),客户端最后只能自己
    // 取消,日志记成 499 client closed 而不是真实的 timeout——设备和服务两端都白等。
    // 现在头阶段用同一个绝对时刻 deadlineAt 兜底,响应头一到就交给体阶段的定时器接力。
    const headerDeadline = setTimeout(() => {
      if (done) return; // 响应头已经回来了,体阶段的 deadlineTimer 接手
      done = true;
      ctx.markDeadlineHit();
      entry.status = 504;
      entry.err = entry.err || `超出端到端总预算(${Math.round(deadlineMs / 1000)}s)`;
      entry.err_class = entry.err_class || 'timeout';
      note({ phase: 'error', attempt: ctx.netAttempts, provider_id: provider.id,
        model, status: 504, code: entry.err_class || 'timeout' });
      try { creq.destroy(new Error('timeout: 端到端总预算用尽')); } catch {}
      entry.ms = Date.now() - started;
      ctx.finish();
      if (!ctx.res.headersSent) ctx.sendErr(504, 'api_error', `上游 ${provider.name} 超出端到端总预算`, 'timeout');
      else if (!ctx.res.writableEnded) { try { ctx.res.end(); } catch {} }
    }, Math.max(1, deadlineAt - Date.now()));
    if (headerDeadline.unref) headerDeadline.unref();
    ctx.setActiveTimers({ bodyTimer: null, deadlineTimer: headerDeadline });
    // transport.request 会**同步**抛:请求头里混进控制字符(渠道 Key 是从控制台抄进来的,
    // 粘贴时带个换行太容易了)、hostname 非法等等。它抛在这里就等于这一次请求凭空消失——
    // 不走 nextOrFail、不写日志,客户端干等到自己的超时,而日志里一个字都没有。
    // 落进 catch 后走正常的失败链路:换下一个候选,或按网络错误如实收尾。
    let creq;
    try {
      creq = transport.request({
      protocol: upstream.protocol, hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      path: joinUpstreamPath(upstream.pathname, upstreamPathOf(wire, ep)),
      method: 'POST', headers,
      agent: transportAgent(upstream.protocol, provider),
      // 首字节(响应头)超时;流式与非流式预算不同(见 firstHeaderTimeoutFor),
      // 之后再由空闲看门狗、非流式 body 计时和端到端总 deadline 兜住
      timeout: firstHeaderMs,
    }, cres => {
      receivedResponse = true;
      archiveStatus = cres.statusCode;
      archiveStream = String(cres.headers['content-type'] || '').includes('text/event-stream');
      if (archive) cres.on('data', chunk => archive.write(chunk));
      cres.once('end', () => finishArchive(cres.complete, cres.statusCode >= 400 ? errorClass(cres.statusCode) : ''));
      cres.once('error', () => finishArchive(false, ctx.clientClosed ? 'cancelled' : 'stream_error'));
      cres.once('close', () => finishArchive(false, ctx.clientClosed ? 'cancelled' : 'stream_aborted'));
      if (done) { cres.resume(); return; }
      // 首字延迟:请求开始 → 上游响应头到达(Node 的 response 回调就是响应头到齐那一刻,
      // 字节更早不可能先到)。多次尝试时每次命中都覆盖,最终留下的是真正给出响应的那一发的
      // 时刻;失败转移期间耗掉的时间照算 —— 这就是用户实际等到的首字。
      // 下限 1:本机 mock 上游常在同一个毫秒里回包,0 会被统计当成"没测到"。
      entry.ttfb_ms = Math.max(1, Date.now() - started);
      // 阶段流水:这一发真的拿到了响应头。status 是上游给的原样状态码;>=400 时同时记分类,
      // 但**不代表终态** —— 下面可能还要换渠道重试。
      note({ phase: 'response', attempt: ctx.netAttempts, provider_id: provider.id, model,
        status: cres.statusCode, code: cres.statusCode >= 400 ? errorClass(cres.statusCode, '') : '' });
      clearTimeout(headerDeadline); // 头阶段结束,接下来由体阶段的 deadlineTimer 接力
      ctx.setActiveTimers(null);
      ctx.setActiveResponse(cres);
      // 上游整体性故障(5xx / 限流 / 额度耗尽)时,趁还没给客户端写任何字节重来:
      // 转换场景先在同一个渠道里换一代 prompt_cache_key(坏上游渠道会被亲和钉住),
      // 次数用完再换池里的下一个渠道
      // 额池耗尽的 402 不算瞬时故障:候选表是按 MAX_ATTEMPTS 循环填的,单渠道时"下一个"
      // 还是它自己,再打十次只会把同一句"余额不足"重复十遍。这种状态只在池里真有别的
      // 渠道时才值得继续(换一家去花),否则如实把 402 交给客户端。
      // 转换线例外:那一侧的 402 往往来自网关的按次限流,重试会换 cache 代际/换 Key,
      // 而且有自己那条整条请求共用的 CONV_RETRIES 配额管着,不会变成十连撞。
      const nextMember = ordered[i + 1];
      const nextIsOther = !!nextMember && nextMember.provider.id !== provider.id;
      // ---- 可选多 Key 自动备用(默认关闭时下面整块都不做事)----
      // 只有在**还没给客户端写任何字节**时才允许换号:这一刻是响应头刚到、体还没转发的
      // 唯一安全点。归因交给 key-fallback:401/402 记账号级,403/404/429 只记模型级,
      // 网络/5xx/其它 4xx 返回 scope:'none'(不轮换 Key —— 账号没坏,也不禁用渠道)。
      // 换号重试打的是**同一个候选 i**(同一个渠道、另一把号),不推进游标、不改模型、
      // 不写 active_key,也**不扩大预算**:每次重试都是一次真实上游调用,由调度层的
      // netAttempts 上限管着。
      if (!frozenNative && keyFallback && typeof keyFallback.failure === 'function' && cres.statusCode >= 400) {
        let verdict = null;
        try {
          verdict = keyFallback.failure({
            provider, key_id: entry.key_id, model: keyModel, status: cres.statusCode,
            pinned: keyPinned, failedKeys: ctx.failedKeys || (ctx.failedKeys = new Set()),
          });
        } catch { verdict = null; }
        const budgetLeft = ctx.netAttempts < ctx.maxUpstreamCalls && !ctx.clientClosed && !ctx.deadlineHit;
        if (verdict && verdict.switchable && budgetLeft) {
          done = true;
          cres.resume();
          ctx.clearAttemptTimers();
          // 换号是一次真实的失败尝试:页面要看见"这个账号不行,换下一条"。
          note({ phase: 'error', attempt: ctx.netAttempts, provider_id: provider.id, model,
            status: cres.statusCode, code: errorClass(cres.statusCode, '') || 'key_fallback' });
          return loop.retry(i);
        }
      }
      const worthRetrying = cres.statusCode !== 402 || nextIsOther || conv;
      if (!frozenNative && worthRetrying && retryableStatus(cres.statusCode) && ((conv && loop.convRetriesLeft > 0) || i + 1 < ordered.length)) {
        // 同渠道重试优先(换 key / 换 cache 代际);次数用完再交给候选表的下一个 i
        if (conv && loop.convRetriesLeft > 0) {
          done = true;
          cres.resume();
          ctx.clearAttemptTimers();
          // 同渠道重打也是一次失败尝试:页面要看见"这一发被上游拒了,所以换了 cache 代际"。
          note({ phase: 'error', attempt: ctx.netAttempts, provider_id: provider.id, model,
            status: cres.statusCode, code: errorClass(cres.statusCode, '') });
          loop.useConvRetry();
          if (wire === 'responses') rotateConvCacheGen(sessKey, provider.id);
          return loop.retry(i);
        }
        if (i + 1 < ordered.length) {
          done = true;
          cres.resume();
          return nextOrFail(cres.statusCode, `HTTP ${cres.statusCode}`);
        }
      }
      done = true;
      entry.status = cres.statusCode;
      if (cres.statusCode >= 400) {
        entry.err_class = errorClass(cres.statusCode, '');
      } else if (keyFallback && typeof keyFallback.success === 'function') {
        // 成功即清诊断记录:删掉这把 Key 的账号级与本次模型级失败记录,并把会话粘性前移到成功这把。
        // 只在响应头 <400 时记(与 key-fallback 的约定一致);体阶段夭折仍会走
        // upstreamDead 并把终态改成 502,但那不是"账号有问题"的证据,不该记为 Key 失败。
        try { keyFallback.success({ provider, key_id: entry.key_id, model: keyModel, sessionKey: ident.key }); } catch {}
      }
      // 成功响应头不是终态:usage 与完整性由响应解析那一侧判定。
      entry.sticky = plan.wasSticky && !entry.failover;
      // 落到这个渠道就把它记进会话(含失败转移后重新绑定),后续请求继续粘它。
      // 槽位请求例外:一条 haiku 起标题请求就把整个对话挪到槽位渠道的话,下一条主模型请求
      // 会跟着跑偏,同一对话内的 prompt 缓存被打断(与 README 的承诺相反)。
      //
      // 写入走会话的**在途 guard**(lib/routing/sessions.js 的 settleRequest),不再原地改记录
      // 字段:控制台可能在这条响应回来之前手动钉定/重绑/解绑/重存覆盖,旧响应不能把用户的
      // 决定覆盖回去。以前是无条件原地写,响应一回来就把刚钉好的渠道改回旧落点。
      // 「绑定」与「最近真实落点」分开结算:绑定受保护,actual 照记 —— 它描述的是这条会话
      // 真实发生过的事,碰不到任何用户配置(无真实请求时控制台显示「暂无」,不拿预览冒充)。
      const sess = plan.sess;
      const rebind = cres.statusCode < 400 && !resolved.content && !resolved.slot
        && (sess.providerId !== provider.id || entry.failover);
      const landed = {
        providerId: provider.id, model, ruleId: (resolved.rule && resolved.rule.id) || 'default',
      };
      const settle = {
        actual: { ...landed, slot: resolved.slot || '', sticky: !!entry.sticky, status: cres.statusCode },
      };
      // 绑定只在"这条请求本来就该落在这里"时才提交;是否真的落账由 guard 按记录世代判定。
      if (rebind) settle.binding = landed;
      settleRequest(plan.flight, settle);
      const ct = String(cres.headers['content-type'] || 'application/json');
      const isSse = ct.includes('text/event-stream');
      // 非流式总超时:从拿到响应头起算,整个 body 拖过上限就掐断
      const bodyTimer = !isSse && nonstreamTotalTimeoutMs ? setTimeout(() => {
        if (responsePrefixPending && !ctx.res.headersSent) {
          upstreamDead('body timeout', 'timeout', { status: 504, message: '响应体超时' });
        }
        try { cres.destroy(new Error('body timeout')); } catch {}
      }, nonstreamTotalTimeoutMs) : null;
      // 端到端总 deadline 的**体阶段**:同一段预算在等响应头时已由 headerDeadline 兜过,
      // 这里接着管"响应头已到、body 还没结束"的那一段。deadlineMs/deadlineAt 在请求入口就算好
      const deadlineTimer = deadlineMs ? setTimeout(() => {
        if (responseDone || convRetrying) return;
        ctx.markDeadlineHit();
        // 先把自己钉进日志:后面 relay / upstreamDead 的收尾都用 || 兜底,不会覆盖真实原因
        entry.err = entry.err || `超出端到端总预算(${Math.round(deadlineMs / 1000)}s)`;
        entry.err_class = entry.err_class || 'timeout';
        try { cres.destroy(new Error('timeout: 端到端总预算用尽')); } catch {}
        // 还没提交给客户端就直接给一条明确的 504,别让它耗到自己的本地超时
        if (!ctx.res.headersSent) {
          upstreamDead(entry.err, 'timeout', { status: 504, message: '超出端到端总预算' });
        }
      }, Math.max(1, deadlineAt - Date.now())) : null;
      // 看门狗只是兜底,不该成为"进程还不能退出去"的理由(测试里漏清就会挂满整个总预算)
      if (bodyTimer && bodyTimer.unref) bodyTimer.unref();
      if (deadlineTimer && deadlineTimer.unref) deadlineTimer.unref();
      ctx.setActiveTimers({ bodyTimer, deadlineTimer });
      const finishEntry = u => {
        if (ctx.finalized || convRetrying) return;
        responseDone = true;
        disarmIdle();
        ctx.clearAttemptTimers();
        entry.ms = Date.now() - started;
        if (u) { entry.in = u.in || 0; entry.out = u.out || 0; entry.cache_read = u.cache_read || 0; }
        if (!entry.err_class && entry.status >= 400) entry.err_class = errorClass(entry.status, '');
        ctx.finish();
      };
      const outHeaders = {
        'Content-Type': ct,
        'x-mixrouter-app': app,
        'x-mixrouter-provider': safeHeader(provider.name),
        'x-mixrouter-model': safeHeader(model),
        'x-mixrouter-session': safeHeader(sessKey),
        'x-mixrouter-upstream-stream': String(upstreamStream),
      };
      if (nativeResponses && cres.statusCode >= 400) {
        for (const [name, value] of Object.entries(cres.headers)) {
          if (!['connection', 'transfer-encoding', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade'].includes(name)) outHeaders[name] = value;
        }
      }
      // 流式空闲看门狗:上游发完响应头后长时间不出数据就掐断,不让客户端干等
      let idleTimer = null;
      let nativeDisconnectHandler = null;
      // 响应体是否已完整结束;上面的 done 只表示"本次尝试已归属",响应转发可以还没走完
      let responseDone = false;
      // 转换重试会主动销毁当前上游流,那不是夭折(见下方 conv 分支)
      let convRetrying = false, responsePrefixPending = false;
      const armIdle = () => {
        if (!isSse || !streamIdleTimeoutMs || responseDone || convRetrying || ctx.finalized) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (responseDone) return;
          try { cres.destroy(new Error('stream idle timeout')); } catch {}
        }, streamIdleTimeoutMs);
      };
      const disarmIdle = () => { clearTimeout(idleTimer); idleTimer = null; };
      // 上游响应中途夭折(空闲/总超时、连接重置):补记日志并掐断客户端响应,别让它干等
      const upstreamDead = (why, errClass, opts) => {
        if (responseDone || convRetrying || ctx.finalized) return;
        if (nativeDisconnectHandler && nativeDisconnectHandler(why, errClass)) return;
        responseDone = true;
        entry.err = entry.err || String(why);
        // A buffered HTTP400 header is not a complete error response. If its body
        // disconnects/times out, classify that failure rather than the unseen400.
        entry.err_class = responsePrefixPending ? errClass : entry.err_class || errClass;
        const status = (opts && opts.status) || 502;
        const what = (opts && opts.message) || '响应中断';
        // 客户端真正拿到的状态码必须在写日志**之前**落进 entry。
        // 以前这里 finishEntry() 先跑,sendErr() 后跑:entry.status 还停在上面那句
        // entry.status = cres.statusCode(常常是 200),于是 requests.jsonl 里记着
        // "status":200 而客户端手里是 502。requests.jsonl 是渠道健康/用量审计的唯一
        // 依据,这等于让上游看起来比实际健康,把一整类客户端可见的故障埋掉。
        entry.status = status;
        // 只记 why 的**分类**;why 本身可能是上游正文或连接错误细节,留在 err/日志里就够了。
        note({ phase: 'error', attempt: ctx.netAttempts, provider_id: provider.id, model,
          status, code: entry.err_class || errClass || '' });
        finishEntry();
        if (!ctx.res.headersSent) ctx.sendErr(status, 'api_error', `上游 ${provider.name} ${what}: ${why}`, errClass);
        else if (!ctx.res.writableEnded) { try { ctx.res.end(); } catch {} }
      };
      cres.on('data', armIdle);
      cres.on('end', () => { responseDone = true; disarmIdle(); });
      cres.on('close', () => {
        disarmIdle();
        // 转换重试的销毁:close 先于 promise 微任务里的重试标记到达,推到下一拍再判
        setImmediate(() => upstreamDead('连接中断', 'network_error'));
      });
      cres.on('error', e => {
        disarmIdle();
        const why = e.code || e.message;
        setImmediate(() => upstreamDead(why, e.code ? errorClass(0, e.code) : (/timeout/i.test(String(why)) ? 'timeout' : 'network_error')));
      });
      armIdle();

      return dispatchResponse({
        cres, res: ctx.res, isSse, conv, wire, ep, app, body, entry, model, provider, sess, resolved, outHeaders,
        upstreamStream, streamOverride,
        finishEntry, upstreamDead, disarmIdle,
        markResourcePrefixPending: value => { responsePrefixPending = value; },
        startKeepAlive: ctx.startKeepAlive, sendErr: ctx.sendErr,
        rotateConvCacheGen: () => rotateConvCacheGen(sessKey, provider.id),
        get clientClosed() { return ctx.clientClosed; },
        get deadlineHit() { return ctx.deadlineHit; },
        convRetriesLeft: loop.convRetriesLeft,
        setNativeDisconnectHandler: handler => { nativeDisconnectHandler = handler; },
        retryNativeEmpty: (detail, kind = 'transient') => {
          if (!nativeState || ctx.res.headersSent || ctx.res.destroyed || ctx.res.writableEnded || ctx.finalized
              || ctx.clientClosed || ctx.deadlineHit || Date.now() >= deadlineAt) return false;
          const historyRecovery = kind === 'resource' || kind === 'history';
          let projection;
          // 投影拒绝时不改写历史,但**原样**重投在一种情形下仍然成立:错误已明确判为可恢复
          // (Azure 资源绑定 / 官方 AgentRouter 的窄 400),目标是官方 AgentRouter HTTPS,
          // 且历史完整可复核 —— 只是含一个投影动不了的内置项(典型:已完成、带 id 的
          // web_search_call)。这时一个字节都不改:不删 id、不伪造投影。
          // 其余拒绝(未知类型、缺配对、服务端引用、未完成项)照旧是终态错误。
          let unprojected = false;
          if (historyRecovery && !nativeState.projected) {
            const historyBody = nativeState.streamBody || JSON.parse(nativeState.outBody);
            projection = projectResponsesHistory(historyBody);
            if (!projection.ok) {
              entry.resource_recovery_skipped = projection.code;
              note({ phase: 'error', attempt: ctx.netAttempts, provider_id: provider.id, model,
                status: cres.statusCode >= 400 ? cres.statusCode : 400, code: `resource_recovery_skipped:${projection.code}` });
              unprojected = projection.code === 'unsupported_item_id'
                && isOfficialAgentRouterHttps(provider)
                && replayableUnprojectedHistory(historyBody).ok;
              if (!unprojected) return false;
            }
          }
          return loop.retrySame(i, () => {
            convRetrying = true;
            plan.nativeRecovery = nativeState;
            if (!nativeState.streamBody) nativeState.streamBody = JSON.parse(nativeState.outBody);
            // 只有**成功**的投影才换 body;投影被拒绝时 projection 仍是真值({ok:false}),
            // 原样重投必须保持 nativeState 一字不动。
            if (projection && projection.ok) {
              plan.nativeRecovery.projected = true;
              plan.nativeRecovery.streamBody = projection.body;
              plan.nativeRecovery.outBody = JSON.stringify(projection.body);
            }
            const code = kind === 'history' ? 'native_history_recovery'
              : kind === 'resource' ? 'resource_binding_recovery' : 'upstream_server';
            entry.err = detail; entry.err_class = code;
            // 原样重投的原因单独留痕:attempts 会多一次,但日志要能说清"这一发为什么重打、
            // 为什么没有投影",而不是只看到一个和成功同字节的重复请求。
            if (unprojected) entry.retry_reason = 'unprojected_resource_retry';
            note({ phase: 'error', attempt: ctx.netAttempts, provider_id: provider.id, model,
              status: historyRecovery ? (cres.statusCode >= 400 ? cres.statusCode : 400) : 502, code });
            disarmIdle(); ctx.clearAttemptTimers();
            // 先标记放弃再销毁,close/error 不能把本次主动重试结算成断流。
            try { cres.destroy(); } catch {}
          });
        },
        // 同渠道重试(转换线在流收尾时才判定):换 cache 代际、回到调度层。
        retrySame: (detail, afterRetry) => {
          convRetrying = true;
          loop.useConvRetry();
          if (afterRetry) afterRetry();
          entry.attempts = ctx.netAttempts;
          // detail 是转换线给的失败原因(可能含上游原句),不进 trace;只记分类。
          note({ phase: 'error', attempt: ctx.netAttempts, provider_id: provider.id, model,
            status: entry.status || 0, code: entry.err_class || 'stream_aborted' });
          ctx.clearAttemptTimers(); // 这一发上游已经交给别人的 res,别让它 240s 后再来改这条日志
          return loop.retry(i);
        },
        markResponseDone: () => { responseDone = true; },
      });
    });
    // 见上面 try:transport.request 同步抛时不能把这一次请求吞掉。定时器已经建好,要先拆。
    } catch (e) {
      finishArchive(false, 'request_error');
      ctx.clearAttemptTimers();
      if (ctx.clientClosed) return;
      return nextOrFail(0, (e && (e.code || e.message)) || '上游请求构造失败', 'network_error');
    }
    ctx.bumpNetAttempts();
    entry.attempts = ctx.netAttempts;
    ctx.setActiveRequest(creq);
    // "已发上游、正在等响应头"是这条请求最常见的等待阶段;attempt 用真实网络调用计数,
    // 与 entry.attempts / 响应归档用的是同一个数。
    note({ phase: 'attempt', attempt: ctx.netAttempts, provider_id: provider.id, model,
      key_id: entry.key_id });
    creq.once('close', () => {
      if (!receivedResponse) finishArchive(false, ctx.clientClosed ? 'cancelled' : 'network_error');
    });
    creq.on('timeout', () => {
      if (done) return;
      done = true;
      creq.destroy(new Error('timeout'));
      nextOrFail(0, `首字节超时(${firstHeaderMs >= 1000 ? Math.round(firstHeaderMs / 1000) + 's' : firstHeaderMs + 'ms'})`, 'timeout');
    });
    creq.on('error', e => {
      if (done) return;
      done = true;
      nextOrFail(0, e.code || e.message, e.code ? errorClass(0, e.code) : 'network_error');
    });
    creq.end(outBody);
  }

  return { runAttempt };
}

module.exports = { createAttempt };
