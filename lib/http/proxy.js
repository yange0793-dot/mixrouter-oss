'use strict';
// 代理 HTTP 入口编排:端点识别 → 读体 → 解析 → 交给 prepare / context / attempts。
//
// 等价搬自 mixrouter.js 的 proxyHandler 外壳(第二期重构的第一行;内部规划记录不随
// 仓库发布)。
// 这里**只**负责 HTTP 入口该管的事:
//   · /healthz、HEAD 探活、GET /v1/models 三个只读出口(不进转发);
//   · 端点识别与未识别端点的 404 协议错误;
//   · 读体(上传缓冲、深度守卫、JSON 解析、超限后有界排空)与 413/400 的协议错误体;
//   · 把入口错误(prepare 的返回值)按端点协议回出去;
//   · 建一条日志条目、建请求上下文、启动 attempts。
// 路由语义、候选与 Key 约束在 lib/proxy/prepare.js;尝试调度在 lib/proxy/attempts.js;
// 单次尝试在 lib/proxy/attempt.js;响应分派在 lib/proxy/response.js。
//
// 依赖全部由工厂注入(活配置用 getter,不是快照)。本模块不 require 主入口。

const { isLoopbackHost, isCrossSiteRequest, isJsonRequest } = require('./local-access');

function createProxyHandler(deps) {
  const {
    VERSION, BODY_LIMIT, BODY_DRAIN_EXTRA, BODY_DRAIN_MS,
    TOTAL_DEADLINE_MS, MAX_ATTEMPTS, CONV_RETRIES, SSE_KEEPALIVE_MS,
    RESPONSE_ARCHIVE_ON, onBodyDrainAbort, onBodyDrainTimeout,
    httpBody, protoError, classifyProxyRequest, ENDPOINTS, modelList, sessionKeyOf,
    prepareRequest, createRequestContext, runAttempts,
  } = deps;

  return function proxyHandler(req, res) {
    const pathOnly = String(req.url || '').split('?')[0];
    if (!isLoopbackHost((req.headers || {}).host)) {
      const app = (classifyProxyRequest(req) || {}).app || 'claude';
      return protoError(res, app, 403, 'permission_error', '拒绝非回环 Host:请使用 http://127.0.0.1 访问代理');
    }
    if (req.method === 'GET' && (pathOnly === '/healthz' || pathOnly === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'mixrouter', version: VERSION }));
    }
    // 客户端探活:HEAD 四个端点都回 200;GET /v1/models 给个只读模型清单
    if (req.method === 'HEAD' && ENDPOINTS.some(e => e.re.test(pathOnly))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end();
    }
    if (req.method === 'GET' && (pathOnly === '/v1/models' || pathOnly === '/harness/v1/models')) {
      try {
        const models = pathOnly === '/harness/v1/models' ? deps.harnessModelList?.() : modelList();
        if (!models) return protoError(res, 'claude', 404, 'not_found_error', 'Harness 模型池未启用');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(models));
      } catch (error) {
        return protoError(res, 'claude', error.statusCode || 400, 'invalid_request_error', error.message);
      }
    }
    const ep = classifyProxyRequest(req);
    if (!ep || req.method !== 'POST') return protoError(res, 'claude', 404, 'not_found_error',
      `mixrouter 支持 POST /v1/messages、/v1/messages/count_tokens(Claude)与 /v1/responses、/v1/chat/completions(Codex),以及独立模型池 /harness/v1/*,收到 ${req.method} ${req.url}`);

    // 浏览器跨站请求不能消耗用户的上游 Key;JSON 类型闸门同时拒绝 no-cors 简单投递。
    if (isCrossSiteRequest(req)) return protoError(res, ep.app, 403, 'permission_error', '拒绝跨站代理请求');
    if (!isJsonRequest(req)) return protoError(res, ep.app, 415, 'invalid_request_error', 'Content-Type 必须是 application/json');

    // 读体(上传缓冲、深度守卫、JSON 解析、超限后的有界排空)整体在 lib/http/body.js。
    // 这里只提供本入口特有的四样东西:字节上限、排空预算/时限、两种计数回调、以及协议错误体的形状。
    // 413 的**发法**也在模块里统一(收完/超预算/超时才发,发一次),调用方只给"怎么报"。
    httpBody.readProxyBody(req, res, {
      limit: BODY_LIMIT, drainExtra: BODY_DRAIN_EXTRA, drainMs: BODY_DRAIN_MS,
      onTooLarge: () => protoError(res, ep.app, 413, 'invalid_request_error', `请求体超过 ${Math.floor(BODY_LIMIT / 1024 / 1024)}MB 上限`),
      onDrainAbort: onBodyDrainAbort,
      onDrainTimeout: onBodyDrainTimeout,
    }, (raw, size) => {
      // 深度先查、再 parse、再判是不是对象(判据与实现都在 lib/http/body.js 的 parseJsonBody;
      // 错误体形状由 protoError 决定)。
      let body;
      try {
        body = httpBody.parseJsonBody(raw, { proxy: true, invalid: msg => Object.assign(new Error(msg), { statusCode: 400 }) });
      } catch (e) {
        return protoError(res, ep.app, 400, 'invalid_request_error', e.message);
      }

      // 身份、覆盖、内容规则、槽位、候选与 Key 约束:prepare 只回计划或结构化入口错误
      const started = Date.now();
      const prepared = prepareRequest(ep, body, req);
      if (prepared.error) {
        const { status, type, message } = prepared.error;
        // 本机拒绝也要可查,但不建会话/在途上下文、不伪造上游尝试或落点。
        // 日志失败不能影响原协议错误;请求体和原始头一律不入记录。
        try {
          const ident = deps.sessionIdentity?.(req, body, ep.app) || { key: '', kind: 'anon' };
          const diagnostic = ep.app === 'codex' && type === 'no_route_error'
            ? deps.routeErrorIdentity?.(req, ident) || '' : '';
          const entry = { ts: new Date(started).toISOString(), app: ep.app, provider: '',
            model_in: body.model || '', model_out: '', session: sessionKeyOf(ident.key), session_kind: ident.kind,
            rule: '', slot: '', key_id: '', key_source: '', pool: 0, strategy: '', sticky: false,
            attempts: 0, failover: false, request_id: '', in: 0, out: 0, cache_read: 0,
            bytes_in: size, ms: Date.now() - started, ttfb_ms: 0, status, stream: !!body.stream,
            kind: ep.kind, wire: '', err: diagnostic ? `${diagnostic} ${message}` : message, err_class: type };
          if (deps.appendRejectedLog) deps.appendRejectedLog(entry, req);
          else deps.appendLog?.(entry);
        } catch {}
        return protoError(res, ep.app, status, type, message);
      }
      const plan = prepared.plan;
      const { resolved, ident } = plan;
      const modelIn = plan.modelIn;

      const entry = { ts: new Date(started).toISOString(), app: ep.app, provider: '', model_in: modelIn, model_out: '',
        session: sessionKeyOf(ident.key), session_kind: ident.kind, rule: (resolved.rule && resolved.rule.id) || 'default',
        slot: resolved.slot || '', key_id: '', key_source: '',
        pool: plan.members.length, strategy: resolved.strategy, sticky: plan.wasSticky, attempts: 0, failover: false,
        // 尝试过程 trace 的关联键:没接 store 时保持空串(键始终在,日志形状不随部署变化)
        request_id: '',
        in: 0, out: 0, cache_read: 0, bytes_in: size, ms: 0, ttfb_ms: 0, status: 0, stream: !!body.stream,
        kind: ep.kind, wire: '', err: '', err_class: '' };

      // 尝试过程 trace(阶段流水,只在本进程内存里)。它是**旁路**:
      //   · 只交给 ctx 记事件,不参与候选选择、预算或终态判定;
      //   · 没注入 store(裁剪部署/单测)时整块跳过,代理行为与之前一字不差;
      //   · 只喂元数据白名单,不喂 prompt、会话标签、Key 或上游 URL。
      // entry.request_id 是它与终态日志的唯一关联键(白名单字段,见 request-log.js)。
      let trace = null;
      if (deps.attemptTraces && typeof deps.attemptTraces.start === 'function') {
        try {
          const id = deps.attemptTraces.start({
            app: ep.app, kind: ep.kind, model_in: modelIn, slot: resolved.slot || '',
            rule: (resolved.rule && resolved.rule.id) || 'default', stream: !!body.stream,
          });
          if (id) {
            entry.request_id = id;
            trace = {
              id,
              event: event => deps.attemptTraces.event(id, event),
              finish: done => deps.attemptTraces.finish(id, done),
            };
          }
        } catch { trace = null; }
      }

      const ctx = createRequestContext({
        res, entry, started, rawLen: size,
        archiveRequestId: RESPONSE_ARCHIVE_ON ? deps.randomUUID() : '',
        totalDeadlineMs: TOTAL_DEADLINE_MS, maxAttempts: MAX_ATTEMPTS, convRetries: CONV_RETRIES,
        sseKeepAliveMs: SSE_KEEPALIVE_MS, protoError, app: ep.app,
        onTrace: trace,
        // 终态的唯一副作用:会话计数/用量累加 + 请求日志落盘。
        // 会话写入走**在途 guard**(lib/routing/sessions.js 的 settleRequest):这条响应回来时
        // 那个会话可能已经被手动重绑、解绑、清空或重存了覆盖,所以结算带的是入口捕获的令牌
        // (plan.flight),由会话存储按"记录世代"判定该不该落账,而不是在这里原地累加。
        onFinish: finished => {
          // 在途请求计数(控制台「运行健康」用):与终态同一处收口,finish 幂等,
          // 所以这里不会多减。计数只是旁路,出错不影响日志与会话结算。
          try { if (deps.activeRequests) deps.activeRequests.finish(); } catch {}
          deps.settleSession(plan.flight, finished);
          deps.appendLog(finished);
        },
      });
      // 进到这里才算"这条代理请求在途":前面所有 4xx/协议错误都在建上下文之前就返回了。
      try { if (deps.activeRequests) deps.activeRequests.start(); } catch {}
      try {
        runAttempts(plan, ctx);
      } catch (error) {
        // 调度层同步抛(理论路径,例如装配错误)时,终态不会走 onFinish —— 在途计数会永久 +1,
        // 控制台就会一直显示"有请求在跑"。这里只回退计数,**不**补写日志、不吞异常:
        // 日志形状保持原样,崩溃语义也保持原样(照旧冒泡给上层)。
        try { if (deps.activeRequests) deps.activeRequests.finish(); } catch {}
        throw error;
      }
    });
  };
}

module.exports = { createProxyHandler };
