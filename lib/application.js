'use strict';
const { runtimeConfig, altPorts } = require('./runtime/config');
const { loadConfiguration, createRepository } = require('./config/repository');
const { createClientManager } = require('./clients/manager');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { writeJsonAtomic: saveJson } = require('./atomic-write');
const { backupTargets } = require('./backup/targets');
const { sweepLogs, DEFAULT_RETAIN_DAYS } = require('./log-retention');
const { createAnthropicTranslator } = require('./wire-anthropic-translator');
const wireResponses = require('./wire-responses');
const wireChat = require('./wire-chat');
const { upstreamAgent, transportAgent, destroyAgents } = require('./upstream-proxy');
const toolFilter = require('./tool-filter');
const { codeRevision } = require('./runtime-code');
const endpoints = require('./routing/endpoints');
const headersLib = require('./routing/headers');
const rulesLib = require('./routing/rules');
const strategyLib = require('./routing/strategy');
const poolLib = require('./routing/pool');
const compactLib = require('./routing/compact');
const { ringOf } = require('./routing/keys');
const sessionConfig = require('./routing/session-config');
const { createCompactWindow } = require('./compact-window');
const { createResolver } = require('./routing/resolve');
const { createExplainer } = require('./routing/explain');
const { createSessionStore } = require('./routing/sessions');
const slotsLib = require('./routing/slots');
const { createRequestLog, scrubDeep } = require('./observability/request-log');
const { createUsageSummary } = require('./usage/summary');

const wireOpenai = require('./wire-openai-bridge');
const identity = require('./session/identity');
const { createResponseArchive } = require('./observability/response-archive');
const httpBody = require('./http/body');
const protoErrorLib = require('./http/proto-error');
const collect = require('./upstream-collect');
const { upstreamErrorText } = require('./upstream-error-text');
const { clip, errBodyText, errLine, errLineOrPlaceholder } = require('./observability/err-text');
const { applyModel } = require('./model-suffix');

const { testProvider } = require('./provider-test');
const { createCompatibilityTester } = require('./compatibility-probe');
const { createClientOnboarding } = require('./client-onboarding');
const { previewProviderImport, mergeProviderImport } = require('./provider-import');
const { createReadinessApi } = require('./http/readiness-api');
const { createAttemptTraceStore } = require('./observability/attempt-trace');
const { explainError } = require('./observability/error-guidance');
const { createKeyFallback } = require('./routing/key-fallback');
const codexConfig = require('./codex-config');
const { maskKey, publicProvider } = require('./providers/public');

function createApplication({ root: ROOT, version: VERSION, env = process.env, home = os.homedir() }) {
  const config = runtimeConfig({ root: ROOT, env, home });
  const {
    DATA_DIR, PROXY_PORT, UI_PORT, HOST, LOG_FILE,
    RESPONSE_ARCHIVE_ON, RESPONSE_ARCHIVE_DIR, PUBLIC_DIR, BODY_LIMIT, BODY_DRAIN_EXTRA, BODY_DRAIN_MS,
    TOTAL_DEADLINE_MS, FIRST_HEADER_TIMEOUT_MS, STREAM_FIRST_HEADER_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS,
    NONSTREAM_TOTAL_TIMEOUT_MS, SSE_KEEPALIVE_MS, DEFAULT_UA, DEFAULT_UA_CODEX, LOG_ROTATE_BYTES, RING_SIZE,
    LOG_RETAIN_DAYS, RETENTION_SWEEP_EVERY_MS, RETENTION_CATCHUP_MS, BACKUP_KEEP, ROUTER_ID, ROUTER_URL,
    ROUTER_TOKEN, ROUTER_SECTION, SESSIONS_FILE, SESSION_TTL_MS, SESSION_MAX, COOLDOWN_MS,
    MAX_ATTEMPTS, CONV_RETRIES, MAX_UPSTREAM_CALLS, RETRY_DELAY_MS, firstHeaderTimeoutFor,
    CLAUDE_SETTINGS,
  } = config;
  const CODE_REVISION = codeRevision(ROOT);
  let bodyDrainAborts = 0, bodyDrainTimeouts = 0;

  const convCacheGens = new Map();
  const convCacheBase = (sessionKey, providerId) => (`${providerId}-${sessionKey || 'anon'}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'mixrouter');
  const convCacheKey = (sessionKey, providerId, gen) => (gen ? `${convCacheBase(sessionKey, providerId)}-g${gen}` : convCacheBase(sessionKey, providerId));
  function rotateConvCacheGen(sessionKey, providerId) {
    const k = providerId + '\u0000' + (sessionKey || 'anon');
    if (convCacheGens.size > SESSION_MAX) convCacheGens.clear();
    const gen = ((convCacheGens.get(k) || 0) + 1) % 50;
    convCacheGens.set(k, gen);
    return gen;
  }
  const convCacheGen = (sessionKey, providerId) => convCacheGens.get(providerId + '\u0000' + (sessionKey || 'anon')) || 0;
  const { SESSION_LABEL } = identity;
  const compactWindow = createCompactWindow({ globalFile: CLAUDE_SETTINGS });

  function loadJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }
  let { store, current, routes, slotMap } = loadConfiguration(config);
  const repository = createRepository({
    files: config, getStore: () => store, getCurrent: () => current, setCurrent: value => { current = value; },
    getRoutes: () => routes, getSlotMap: () => slotMap, syncCodex: save => withCodexSync(save),
  });
  const { saveStore, saveRoutes, saveSlots, drainStoreWarnings, withStoreRollback, applyClientSwitch, setStoreWarnings } = repository;

  function clientSwitchMessage(app, e) {
    if (/^写入(渠道库|客户端配置)失败/.test(e.message)) return e.message;
    return '写入配置失败: ' + e.message;
  }

  const storeOf = app => (app === 'codex' ? store.codex : store.claude);
  const findProvider = id => store.claude.find(p => p.id === id) || store.codex.find(p => p.id === id) || null;
  const providerApp = id => store.claude.some(p => p.id === id) ? 'claude' : (store.codex.some(p => p.id === id) ? 'codex' : null);

  function channelSecrets() {
    const out = [];
    for (const list of [store.claude, store.codex]) {
      for (const p of list || []) {
        if (!p) continue;
        if (typeof p.api_key === 'string' && p.api_key) out.push(p.api_key);
        if (Array.isArray(p.keys)) {
          for (const k of p.keys) if (k && typeof k.key === 'string' && k.key) out.push(k.key);
        }
      }
    }
    if (ROUTER_TOKEN) out.push(ROUTER_TOKEN);
    return out;
  }

  function reportGhostRoutes() {
    const bad = [];
    const scan = (r, label) => {
      for (const g of ghostRefs(r)) bad.push(`${label} 的${g.where}指向已不存在的渠道 ${g.id}`);
    };
    for (const r of routes.rules || []) {
      if (!compactLib.compactKind(r)) continue;
      scan(r, `压缩规则 ${r && r.id ? r.id : '?'}`);
    }
    if (bad.length) {
      console.warn(`[mixrouter] 压缩规则里有 ${bad.length} 处僵尸引用(渠道已删除,规则还指着它)——压缩请求会直接 503:\n  - ${bad.join('\n  - ')}\n  请在控制台 http://127.0.0.1:${UI_PORT} 的「压缩设置」页重新选择目标渠道。`);
    }
    return bad;
  }

  const {
    CLAUDE_SLOTS, CLAUDE_SLOT_ENV, CLAUDE_SLOT_KEYS, slotAlias, slotAliases, stripContextSuffix,
    normalizeChannelSlots,
  } = slotsLib;

  const slotTable = slotsLib.createSlotTable({ storeOf, findProvider, providerApp });
  const validateSlotPut = body => slotTable.validateSlotPut(body);
  const resolveSlot = (app, modelIn) => slotTable.resolveSlot(slotMap, app, modelIn);
  const slotsPublic = () => slotTable.slotsPublic(slotMap);
  const claudeSplitPatch = body => slotTable.claudeSplitPatch(slotMap, body);
  const {
    switchClaude, switchCodex, switchClaudeRouter, switchCodexRouter, switchRouter, liveState,
    writeCodexConfig, updateCodexConfig, withCodexSync, commitSlotUpdate, codexLegacyAlias, tomlStr, codexTopLevel,
  } = createClientManager({
    config, getStore: () => store, getCurrent: () => current, getSlotMap: () => slotMap,
    setSlotMap: value => { slotMap = value; }, slotsPublic, slotTable, setStoreWarnings, findProvider,
  });

  let clientWarnings = null;

  function configureClaudeSplit(body) {
    const patch = claudeSplitPatch(body);
    const previous = slotMap;
    slotMap = { ...slotMap, claude: { ...slotMap.claude, ...patch } };
    try { saveSlots(); } catch (e) { slotMap = previous; throw e; }
    if (body.apply) {
      try {
        clientWarnings = applyClientSwitch('claude', () => switchClaudeRouter({ slots: true }), ROUTER_ID);
      } catch (e) {
        slotMap = previous;
        try { saveSlots(); } catch { /* 尽力而为;内存与盘上至多多了一次等价写入 */ }
        throw e;
      }
    }
    const warnings = [...((clientWarnings && clientWarnings.warnings) || [])];
    clientWarnings = null;
    return { ok: true, applied: !!body.apply, slots: slotsPublic().claude, warnings: warnings.length ? warnings : undefined };
  }

  function normalizeRule(r) { return rulesLib.normalizeRule(r); }

  const {
    parseSessionId, bodySystemText, firstUserText,
    codexHeaderSessionId, codexBodySessionId, codexSystemText, codexUserTexts, codexFirstUserText,
    sessionIdentity, sessionLabel, applyLabel, sessionKeyOf, bodyRouteText, compactTexts,
  } = identity;

  const sess = createSessionStore({
    sessionsFile: SESSIONS_FILE, ttlMs: SESSION_TTL_MS, max: SESSION_MAX,
    loadJson, saveJson,
    storeOf: app => storeOf(app), providerEligible: id => providerEligible(id),
    onSaveError: e => console.error(`[sessions] 会话绑定落盘失败(本次改动会在下次落盘时重试): ${(e && e.message) || e}`),
  });

  const inCooldown = id => sess.inCooldown(id);
  const providerEligible = () => true;
  const markCooldown = () => {};
  const pruneSessions = () => sess.prune();

  function flushSessions() { sess.flush(); }
  function flushSessionsNow() { sess.flush(true); }
  function saveSessionsSoon() { sess.saveSoon(); }
  function loadSessions() { sess.load(); }

  function mutateSessions(mutate) {
    const before = new Map(sess.sessions);
    mutate();
    try { flushSessionsNow(); }
    catch (e) {
      sess.sessions.clear();
      for (const [k, v] of before) sess.sessions.set(k, v);
      throw Object.assign(new Error('写入会话绑定失败: ' + ((e && e.message) || e)), { statusCode: 500 });
    }
  }

  const retryableStatus = status => status === 429 || status === 402 || status >= 500;
  function errorClass(status, code = '') {
    if (code) return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(code) ? code.toLowerCase() : 'network_error';
    if (status === 401 || status === 403) return 'authentication';
    if (status === 429) return 'rate_limit';
    if (status === 402) return 'budget_exhausted';
    if (status >= 500) return 'upstream_server';
    return status >= 400 ? 'upstream_request' : '';
  }
  function healthStatus() {
    return { settings: { total_deadline_ms: TOTAL_DEADLINE_MS, first_header_timeout_ms: FIRST_HEADER_TIMEOUT_MS,
      stream_first_header_timeout_ms: STREAM_FIRST_HEADER_TIMEOUT_MS,
      stream_idle_timeout_ms: STREAM_IDLE_TIMEOUT_MS, sse_keepalive_ms: SSE_KEEPALIVE_MS,
      nonstream_total_timeout_ms: NONSTREAM_TOTAL_TIMEOUT_MS, max_attempts: MAX_ATTEMPTS, conversion_retries: CONV_RETRIES,
      max_upstream_calls: MAX_UPSTREAM_CALLS,
      cooldown_ms: COOLDOWN_MS, retry_delay_ms: RETRY_DELAY_MS },
    logs: requestLog.storageStatus(),
    providers: ['claude', 'codex'].flatMap(app => storeOf(app).map(p => ({ provider: p.id, app,
      enabled: p.enabled !== false, cooldown_until: 0,
      eligible: p.enabled !== false && providerEligible(p.id) }))) };
  }

  const poolMembers = (rule, app = 'claude') => poolLib.poolMembers(storeOf(app), rule, app);
  const ghostRefs = rule => poolLib.ghostRefs(findProvider, rule);
  const strategyOf = strategyLib.strategyOf;
  const pickWeighted = strategyLib.pickWeighted;
  const pickMember = (rule, members) => strategyLib.pickMember(rule, members,
    { eligible: providerEligible, activeCount: id => sess.activeCount(id), pools: sess.pools });

  const resolveSessionTarget = (rule, members, key, label, kind, app = 'claude', fallbackStrategy) =>
    sess.resolveTarget(rule, members, key, label, kind, app, fallbackStrategy);

  const sessionEntry = (key, kind, members, label, app = 'claude') => sess.entry(key, kind, label, app);

  loadSessions();

  const sessionList = () => sess.list({ findProvider, short: sessionKeyOf });
  const sessionRecord = key => sess.sessions.get(key);

  const requestLog = createRequestLog({
    file: LOG_FILE, capacity: RING_SIZE, maxBytes: LOG_ROTATE_BYTES, secrets: channelSecrets,
    retentionDays: config.REQUEST_LOG_RETAIN_DAYS,
    maxEntries: config.REQUEST_LOG_MAX_ENTRIES,
    compress: env.MIXR_LOG_COMPRESS === 'on',
    onError: (error, ctx) => console.error(`[log] ${ctx.op} 落盘失败(${ctx.file}): ${error.message}`),
  });

  const usageSummary = createUsageSummary({
    file: LOG_FILE,                             // 磁盘:requests.jsonl 及其轮转归档
    memoryEntries: () => requestLog.list({ limit: Number.MAX_SAFE_INTEGER }).logs,
  });

  function sweepLogsNow(trigger) {
    if (LOG_RETAIN_DAYS <= 0) return null;
    const r = sweepLogs({ directory: path.dirname(LOG_FILE), retainDays: LOG_RETAIN_DAYS });
    if (r.errors && r.errors.length) console.error(`[retention] 日志清理有失败项(${trigger}): ${r.errors.join(', ')}`);
    else if (r.responses && (r.responses.removed || r.responses.truncated)) console.log(`[retention] ${trigger}:清理 responses 归档 ${r.responses.removed} 个(约 ${Math.round((r.responses.bytes || 0) / 1048576)}MB,保留 ${LOG_RETAIN_DAYS} 天)${r.responses.truncated ? ',单轮限额已满,稍后继续' : ''}`);
    return r;
  }
  let retentionTimer = null;
  function retentionTick() {
    requestLog.maintenance();
    const r = sweepLogsNow('周期');
    if (r && r.responses && r.responses.truncated) { scheduleRetention(RETENTION_CATCHUP_MS); return; }
    scheduleRetention(RETENTION_SWEEP_EVERY_MS);
  }
  function scheduleRetention(ms) {
    if (retentionTimer) clearTimeout(retentionTimer);
    retentionTimer = setTimeout(retentionTick, ms);
    if (retentionTimer.unref) retentionTimer.unref();   // 别用清理定时器钉住进程退出
  }
  function startLogRetention() {
    if (retentionTimer) return;
    requestLog.restoreRecent();
    const first = sweepLogsNow('启动');
    scheduleRetention(first && first.responses && first.responses.truncated ? RETENTION_CATCHUP_MS : RETENTION_SWEEP_EVERY_MS);
  }

  const resolveRoute = createResolver({
    getRoutes: () => routes, storeOf: app => storeOf(app),
    resolveSlot: (app, modelIn) => resolveSlot(app, modelIn),
    findProvider, providerApp, codexLegacyAlias,
  });
  const explainRoute = createExplainer({
    getRoutes: () => routes, storeOf: app => storeOf(app),
    resolveSlot: (app, modelIn) => resolveSlot(app, modelIn), findProvider, providerApp, codexLegacyAlias,
    slotExists: (app, modelIn) => {
      const raw = stripContextSuffix(modelIn);
      return Object.keys(slotMap[app] || {})
        .some(name => slotAliases(app, name).includes(raw));
    },
    listPools: () => sess.pools, healthEligible: () => true,
    sessionSnapshot: () => ({ bindings: sess.sessions, now: Date.now(), ttlMs: SESSION_TTL_MS, max: SESSION_MAX }),
    uiPort: UI_PORT,
  });

  const { anthropicError, openaiError, protoError } = protoErrorLib;

  const safeHeader = headersLib.safeHeader;
  const authHeaderValue = headersLib.authHeaderValue;
  const hasCtlChar = headersLib.hasCtlChar;
  const validBaseUrl = headersLib.validBaseUrl;

  function extractUsage(text) {
    return {
      in: lastNum(text, /"input_tokens"\s*:\s*(\d+)/),
      out: lastNum(text, /"output_tokens"\s*:\s*(\d+)/),
      cache_read: lastNum(text, /"cache_read_input_tokens"\s*:\s*(\d+)/),
    };
  }

  const { responsesToChat, chatJsonToResponses, streamChatAsResponses, emitResponsesSse,
          chatToolChoice, extractUsageOpenAI, lastNum } = wireOpenai;

  const extractUsageFor = (wire, text) => wire === 'anthropic' ? extractUsage(text) : extractUsageOpenAI(wire, text);

  function sseResult(wire, text) {
    let terminal = false;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (wire === 'chat' && data === '[DONE]') { terminal = true; continue; }
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      if (!event || typeof event !== 'object') continue;
      if (event.error || event.type === 'error' || event.type === 'response.failed')
        return { ok: false, error: upstreamErrorText(JSON.stringify(event)) || '上游返回流式错误' };
      if (wire === 'anthropic' && event.type === 'message_stop') terminal = true;
      if (wire === 'responses' && ['response.completed', 'response.incomplete'].includes(event.type)) terminal = true;
      if (wire === 'chat' && event.choices?.some(choice => choice.finish_reason)) terminal = true;
    }
    return { ok: terminal, error: terminal ? '' : '上游流没有给出合法终态就结束了' };
  }

  const ENDPOINTS = endpoints.ENDPOINTS;
  const classifyProxyRequest = endpoints.classifyProxyRequest;
  const wireOf = endpoints.wireOf;
  const upstreamPathOf = endpoints.upstreamPathOf;
  const joinUpstreamPath = endpoints.joinUpstreamPath;

  function modelList() {
    const seen = new Set(), data = [];
    const add = (id, owner) => {
      const k = id + '\u0000' + owner;
      if (!id || seen.has(k)) return;
      seen.add(k);
      data.push({ id, object: 'model', owned_by: owner });
    };
    for (const p of store.codex) {
      if (p.enabled === false) continue;
      for (const model of [p.model, ...(Array.isArray(p.models) ? p.models : [])]) {
        if (typeof model === 'string' && model.trim()) add(model.trim(), p.name);
      }
    }
    for (const [name, s] of Object.entries(slotMap.codex || {})) {
      if (!s || !s.provider) continue;
      add(slotAlias('codex', name), 'slot:' + name);
      const resolved = resolveSlot('codex', slotAlias('codex', name));
      if (resolved?.provider && resolved.provider.enabled !== false && resolved.model)
        add(resolved.model, resolved.provider.name);
    }
    return { object: 'list', data };
  }

  const proxyHttp = require('./http/proxy');
  const { createPreparer } = require('./proxy/prepare');
  const { createRequestContext } = require('./proxy/context');
  const { createAttemptRunner } = require('./proxy/attempts');
  const { createAttempt } = require('./proxy/attempt');
  const { createResponder } = require('./proxy/response');

  function buildUpstreamHeaders(provider, req) {
    const key = authHeaderValue(provider.api_key);
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'Authorization': 'Bearer ' + key,
      'User-Agent': safeHeader(provider.ua) || safeHeader(req.headers['user-agent']) || DEFAULT_UA,
      'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
    };
    if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
    return headers;
  }

  function buildOpenAiHeaders(provider, req, stream) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': stream ? 'text/event-stream' : 'application/json',
      'Authorization': 'Bearer ' + authHeaderValue(provider.api_key),
      'User-Agent': safeHeader(provider.ua) || safeHeader(req.headers['user-agent']) || DEFAULT_UA_CODEX,
    };
    if (req.headers.originator) headers['originator'] = safeHeader(req.headers.originator);
    const sid = codexHeaderSessionId(req);
    if (sid) headers['session-id'] = safeHeader(sid);
    return headers;
  }

  const { dispatchResponse } = createResponder({
    collect, createAnthropicTranslator, extractUsageFor, extractUsageOpenAI, sseResult,
    upstreamErrorText, errBodyText, errLine, errLineOrPlaceholder, clip,
    wireChat, wireResponses, wireOpenai,
  });

  const attemptTraces = createAttemptTraceStore();
  const keyFallback = createKeyFallback();
  let activeRequestCount = 0;
  const activeRequests = {
    start() { activeRequestCount++; },
    finish() { activeRequestCount = Math.max(0, activeRequestCount - 1); },
  };
  const attemptDeps = {
    http, https,
    storeOf,
    slotMapOf: () => slotMap, sessionConfig, compactLib,
    refreshProvider: (provider, app) => storeOf(app).find(candidate => candidate.id === provider.id),
    wireOf, upstreamPathOf, joinUpstreamPath,
    buildUpstreamHeaders, buildOpenAiHeaders, applyModel, toolFilter,
    safeHeader, hasCtlChar, transportAgent, createResponseArchive, channelSecrets, clientToken,
    errorClass, retryableStatus,
    settleRequest: (flight, patch) => sess.settleRequest(flight, patch),
    sha256: text => crypto.createHash('sha256').update(text).digest('hex'),
    wireResponses, wireChat, wireOpenai,
    convCacheKey, convCacheGen, rotateConvCacheGen,
    firstHeaderTimeoutFor, streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    nonstreamTotalTimeoutMs: NONSTREAM_TOTAL_TIMEOUT_MS,
    responseArchiveOn: RESPONSE_ARCHIVE_ON, responseArchiveDir: RESPONSE_ARCHIVE_DIR,
    uiPort: UI_PORT, DEFAULT_UA_CODEX, dispatchResponse, keyFallback,
  };
  const { runAttempt } = createAttempt(attemptDeps);
  const compatibility = createCompatibilityTester({ attemptDeps });

  const { runAttempts } = createAttemptRunner({ runAttempt, convRetries: CONV_RETRIES, retryDelayMs: RETRY_DELAY_MS });

  const prepareRequest = createPreparer({
    UI_PORT, MAX_ATTEMPTS,
    storeOf, sessionRecord, sessionConfig, sessionKeyOf, sessionIdentity, sessionLabel,
    bodyRouteText, compactTexts, resolveRoute, compactLib, wireOf,
    resolveSessionTarget, sessionEntry, clientToken,
    captureRequest: key => sess.captureRequest(key),
  }).prepareRequest;

  const proxyHandler = proxyHttp.createProxyHandler({
    VERSION, BODY_LIMIT, BODY_DRAIN_EXTRA, BODY_DRAIN_MS,
    TOTAL_DEADLINE_MS, MAX_ATTEMPTS, CONV_RETRIES, MAX_UPSTREAM_CALLS, SSE_KEEPALIVE_MS,
    RESPONSE_ARCHIVE_ON, attemptTraces, activeRequests,
    onBodyDrainAbort: () => { bodyDrainAborts++; },
    onBodyDrainTimeout: () => { bodyDrainTimeouts++; },
    randomUUID: () => crypto.randomUUID(),
    httpBody, protoError, classifyProxyRequest, ENDPOINTS, modelList, sessionKeyOf,
    prepareRequest, createRequestContext, runAttempts, sessionIdentity,
    routeErrorIdentity: (req, ident) => `[Codex identity: native=${codexConfig.nativeClient(req.headers['user-agent'])}, local_auth=${clientToken(req) === ROUTER_TOKEN}, reliable_session=${String(ident.key).startsWith('cx:')}]`,
    appendRejectedLog: (entry, req) => requestLog.append(scrubDeep(entry, [clientToken(req)].filter(Boolean))),
    settleSession: (flight, finished) => {
      const r = sess.settleRequest(flight, { usage: { in: finished.in || 0, out: finished.out || 0 } });
      if (r.ok && r.applied.usage) saveSessionsSoon();
    },
    appendLog: finished => requestLog.append(finished),
  });

  function clientToken(req) {
    const a = String(req.headers['authorization'] || '');
    if (a) return a.replace(/^Bearer\s+/i, '').trim();
    return String(req.headers['x-api-key'] || '').trim();
  }

  const createConsoleHandler = require('./http/console').createConsoleHandler;
  const onboarding = createClientOnboarding({
    env: env, home: home, root: ROOT, routerURL: ROUTER_URL, routerToken: ROUTER_TOKEN,
    getStore: () => store, getSlots: slotsPublic,
    applyRouter: (app, options) => applyClientSwitch(app, () => switchRouter(app, options), ROUTER_ID),
  });
  const readinessApi = createReadinessApi({
    onboarding, compatibility, attemptTraces, keyFallback, explainError,
    previewProviderImport, mergeProviderImport, getStore: () => store,
    applyImport: merged => withStoreRollback(() => { store.claude = merged.claude; store.codex = merged.codex; }),
    publicProvider,
    version: VERSION, healthStatus, liveState, requestLog,
  });
  const insightsApi = require('./http/insights-api').createInsightsApi({
    file: path.join(DATA_DIR, 'model-specs.json'), getStore: () => store, requestLog,
  });
  const profilesApi = require('./http/profiles-api').createProfilesApi({
    file: path.join(DATA_DIR, 'profiles.json'), getSlots: () => slotMap, storeOf, validateSlotPut,
    applySlots: next => commitSlotUpdate(next, false),
  });
  const apiHandler = createConsoleHandler({
    VERSION, PROXY_PORT, UI_PORT, CODE_REVISION, ROUTER_ID, ROUTER_URL, ROUTER_TOKEN,
    BACKUP_KEEP, SESSION_TTL_MS, BODY_LIMIT, HOST, PUBLIC_DIR, ENDPOINTS, ROOT, DATA_DIR,
    backupFiles: backupTargets({ root: ROOT, home, env }),
    maskKey,                       // 主入口的公开导出,工厂只用不改
    getStore: () => store,
    getCurrent: () => current, setCurrent: v => { current = v; },
    getRoutes: () => routes, setRoutes: v => { routes = v; },
    getSlotMap: () => slotMap, setSlotMap: v => { slotMap = v; },
    getSess: () => sess,
    liveState, explainRoute, updateCodexConfig, configureClaudeSplit, healthStatus,
    applyClientSwitch, clientSwitchMessage, withStoreRollback, drainStoreWarnings, testProvider,
    sessionList, sessionRecord, storeOf, findProvider, providerApp, ghostRefs,
    mutateSessions, saveRoutes, saveSlots, saveStore, syncCodexStore: () => withCodexSync(saveStore), requestLog, compactWindow,
    slotsPublic, validateSlotPut, commitSlotUpdate,
    usageSummary, readinessApi, insightsApi, profilesApi, activeRequests: () => activeRequestCount,
    switchClaude, switchCodex, switchRouter,
  });

  async function listen(port, handler, label) {
    await requestLog.restoreToday();
    await requestLog.restoreRecent();
    return new Promise((ok, bad) => {
      const srv = http.createServer(handler);
      srv.on('error', bad);
      srv.listen(port, HOST, () => ok(srv));
    });
  }
  let lifecycle = null;
  async function startApplication() {
    await requestLog.restoreToday();
    await requestLog.restoreRecent();
    if (lifecycle) return lifecycle.start();
    const { createLifecycle } = require('./server/lifecycle');
    lifecycle = createLifecycle({
      host: HOST, proxyPort: PROXY_PORT, uiPort: UI_PORT,
      altPorts: altPorts(PROXY_PORT, UI_PORT, env),
      proxyHandler, apiHandler,
      drainTimeoutMs: 2000,
      onFlush: () => {
        const goals = [['store', saveStore], ['routes', saveRoutes], ['slots', saveSlots], ['sessions', flushSessions]];
        const result = {};
        for (const [goal, fn] of goals) {
          try { fn(); result[goal] = { ok: true }; }         // 单个目标抛错不带走在它后面的目标
          catch (e) { result[goal] = { ok: false, error: (e && e.message) || String(e) }; }
        }
        return result;
      },
      onWarning: (code, message) => console.error(`[lifecycle] ${code} ${message}`),
    });
    return lifecycle.start().then(rep => {
      console.log(`[mixrouter v${VERSION}] 代理 :${rep.proxy.port}(Claude /v1/messages · Codex /v1/responses)  控制台 http://${HOST}:${rep.ui.port}  渠道 claude ${store.claude.length} / codex ${store.codex.length}`);
      reportGhostRoutes();
      for (const entry of rep.alt) console.log(`  兼容监听 :${entry.port}(旧客户端指向的端口,同一份状态)`);
      startLogRetention();
    }).catch(e => {
      console.error(`启动失败: ${e.message}(端口 ${PROXY_PORT}/${UI_PORT} 是否被占用?)`);
      throw e;
    });
  }

  async function stopApplication() {
    clearTimeout(retentionTimer);
    retentionTimer = null;
    if (!lifecycle) return;
    const result = await lifecycle.stop();
    await requestLog.flush();
    destroyAgents();
    return result;
  }

  return { startApplication, stopApplication,
    VERSION, proxyHandler, apiHandler, listen,
    explainRoute,
    sweepLogsNow, startLogRetention, LOG_RETAIN_DAYS, RETENTION_SWEEP_EVERY_MS,
    resolveRoute, applyModel, safeHeader, extractUsage, maskKey, tomlStr, validBaseUrl,
    switchClaude, switchCodex, switchClaudeRouter, switchCodexRouter, switchRouter,
    joinUpstreamPath,
    liveState, testProvider, codexTopLevel, writeCodexConfig, updateCodexConfig,
    sessionIdentity, sessionLabel, parseSessionId, normalizeRule, poolMembers, bodyRouteText,
    ghostRefs, reportGhostRoutes,
    sessionList, buildUpstreamHeaders, clientToken, strategyOf, applyLabel,
    ENDPOINTS, classifyProxyRequest, wireOf, upstreamPathOf, modelList, buildOpenAiHeaders,
    codexHeaderSessionId, codexBodySessionId, codexFirstUserText, codexUserTexts, extractUsageOpenAI, extractUsageFor,
    responsesToChat, chatJsonToResponses, streamChatAsResponses, chatToolChoice,
    wireChat,
    slotAlias, resolveSlot, slotsPublic, validateSlotPut, CLAUDE_SLOTS, CLAUDE_SLOT_ENV,
    normalizeChannelSlots, CLAUDE_SLOT_KEYS, claudeSplitPatch, configureClaudeSplit, altPorts,
    pickMember, markCooldown, inCooldown,
    healthStatus, errorClass, providerEligible,
    ROUTER_ID, ROUTER_URL, ROUTER_TOKEN, ROUTER_SECTION,
    _state: {
      get store() { return store; }, set store(v) { store = v; },
      get routes() { return routes; }, set routes(v) { routes = v; },
      get current() { return current; }, set current(v) { current = v; },
      get sessions() { return sess.sessions; }, set sessions(v) { sess.sessions = v; },
      get cooldowns() { return sess.cooldowns; }, set cooldowns(v) { sess.cooldowns = v; },
      get slotMap() { return slotMap; }, set slotMap(v) { slotMap = v; },
      get pools() { return sess.pools; },
      get bodyLimit() { return BODY_LIMIT; },
      get bodyDrainExtra() { return BODY_DRAIN_EXTRA; },
      get bodyDrainMs() { return BODY_DRAIN_MS; },
      get bodyDrainAborts() { return bodyDrainAborts; },
      get bodyDrainTimeouts() { return bodyDrainTimeouts; },
      resetPools() { sess.resetPools(); },
      bindSession(key, providerId, extra = {}) {
        sess.sessions.set(key, { providerId, model: '', ruleId: '', label: '', kind: 'header',
          created: Date.now(), lastUsed: Date.now(), reqs: 0, inTok: 0, outTok: 0, pinned: false, ...extra });
        return sess.sessions.get(key);
      },
    },
  };

}

module.exports = { createApplication };
