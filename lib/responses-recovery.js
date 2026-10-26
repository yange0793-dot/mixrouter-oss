'use strict';

// Conservative native Responses prefix gate. Byte parsing follows the standalone
// resource-history-bridge lib/output.js contract; whitespace output is output here.
const { TextDecoder } = require('node:util');
const { RESPONSE_FIELDS, isKnownResourceError } = require('./responses-history');
const { isEncryptedReasoningError } = require('./responses-encrypted');
const PREFIX_BYTES = 64 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, fields) => record(value) && Object.keys(value).every(key => fields.includes(key));

function frameEnd(buffer) {
  let boundary = null;
  for (const separator of ['\r\n\r\n', '\n\n', '\r\r']) {
    const at = buffer.indexOf(separator);
    if (at !== -1 && (!boundary || at < boundary.start)) boundary = { start: at, end: at + separator.length };
  }
  return boundary;
}
function parseFrame(buffer) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return { ok: false }; }
  const data = [];
  let name;
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(':')) continue;
    const at = line.indexOf(':');
    if (at < 0) return { ok: false };
    const key = line.slice(0, at), value = line.slice(at + 1).replace(/^ /, '');
    if (key === 'data') data.push(value);
    else if (key === 'event' && name === undefined) name = value;
    else return { ok: false };
  }
  if (!data.length) return { ok: name === undefined, event: null };
  let event;
  try { event = JSON.parse(data.join('\n')); } catch { return { ok: false }; }
  if (!record(event) || name && event.type !== undefined && event.type !== name) return { ok: false };
  if (name && event.type === undefined) event = { ...event, type: name };
  return { ok: true, event };
}
function emptyResponse(response, failed = false) {
  return record(response) && Object.keys(response).every(key => RESPONSE_FIELDS.has(key))
    && (!failed || Array.isArray(response.output))
    && (response.output === undefined || Array.isArray(response.output) && !response.output.length)
    && (response.output_text === undefined || response.output_text === '')
    && response.incomplete_details == null
    && (response.reasoning == null || only(response.reasoning, ['effort', 'summary', 'generate_summary']));
}
function lifecycleOnly(event) {
  return only(event, ['type', 'sequence_number', 'response'])
    && ['response.created', 'response.queued', 'response.in_progress'].includes(event.type)
    && emptyResponse(event.response) && event.response.error == null
    && ['in_progress', 'queued', undefined].includes(event.response.status);
}

// 官方 AgentRouter 主机清单只出现这一次:窄 400 的分类、以及「未投影历史原样重投」的
// 目标判定,必须落在同一组主机上。凭据/非法协议一律不算目标(那不是官方端点)。
const AGENTROUTER_HOSTS = new Set(['agentrouter.org', 'ps.air-outer.com']);
function officialAgentRouterUrl(provider) {
  if (typeof provider?.base_url !== 'string') return null;
  try {
    const url = new URL(provider.base_url);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && AGENTROUTER_HOSTS.has(url.hostname) ? url : null;
  } catch { return null; }
}
// 原样重投比分类更严:只有 HTTPS 的官方端点才算"同一个可复核目标"。
function isOfficialAgentRouterHttps(provider) {
  const url = officialAgentRouterUrl(provider);
  return !!url && url.protocol === 'https:';
}

// Only one observed gateway signature permits a safe history projection.
// Neither the provider name nor generic invalid-request prose is evidence to replay.
function isScopedHistoryFailure(payload, status, provider) {
  const plain = value => record(value) && Object.getPrototypeOf(value) === Object.prototype;
  if (status !== 400 || !plain(payload) || !only(payload, ['error']) || !Object.hasOwn(payload, 'error')) return false;
  const error = payload.error;
  if (!plain(error) || !only(error, ['message', 'type', 'param', 'code'])
      || !Object.hasOwn(error, 'message') || !Object.hasOwn(error, 'type')
      || !Object.hasOwn(error, 'param') || !Object.hasOwn(error, 'code')
      || error.type !== 'invalid_request_error' || typeof error.message !== 'string'
      || error.param !== '' || error.code !== null) return false;
  const signature = error.message.match(/^Upstream rejected the request as invalid \[trace_id=[A-Za-z0-9._:-]{1,256}\]$/);
  return !!signature && signature[0] === error.message && !!officialAgentRouterUrl(provider);
}

// Explicit codes are preferred; auth/schema/filter messages override an unreliable
// server_error label. Generic 400 only recovers under the strict gateway scope above.
function classifyFailure(payload, status = 200, provider = null) {
  const encrypted = isOfficialAgentRouterHttps(provider) && isEncryptedReasoningError(payload, status);
  let response;
  if (payload?.type === 'response.failed') {
    if (!encrypted && (!only(payload, ['type', 'sequence_number', 'response']) || !emptyResponse(payload.response, true)
        || payload.response.status !== 'failed')) return null;
    response = payload.response;
  } else if (payload?.status === 'failed') {
    if (!encrypted && !emptyResponse(payload, true)) return null;
    response = payload;
  } else if (!encrypted && (!only(payload, ['type', 'sequence_number', 'error', 'code', 'message', 'param', 'request_id', 'trace_id'])
      || payload.type !== undefined && payload.type !== 'error')) return null;
  const errorFields = ['type', 'code', 'message', 'param', 'status', 'status_code', 'statusCode', 'request_id', 'trace_id', 'sequence_number', 'cause', 'innererror', 'inner_error'];
  const validError = (value, depth = 0) => value == null || depth <= 3 && only(value, errorFields)
    && ['cause', 'innererror', 'inner_error'].every(key => validError(value[key], depth + 1));
  if (!validError(response?.error || payload?.error)
      || payload?.type === 'error' && payload.error === undefined && !only(payload, errorFields)) return null;
  const sources = [];
  const visit = (value, depth = 0) => {
    if (!record(value) || depth > 3) return;
    sources.push(value);
    for (const key of ['error', 'cause', 'innererror', 'inner_error']) visit(value[key], depth + 1);
  };
  visit(response || payload);
  const codes = sources.flatMap(value => [value.code, value.type]).filter(value => typeof value === 'string')
    .map(value => value.toLowerCase().replace(/[.\s-]+/g, '_'));
  const messages = sources.map(value => value.message).filter(value => typeof value === 'string').join('\n');
  const terminal = /(?:authentication|permission|content_filter|content_policy|policy_violation|responsibleaipolicy|invalid_(?:api_key|token|credentials|schema|parameter|argument|type|value|json|tool|function)|missing_required|unknown_parameter|unsupported_parameter|context_length|context_window|contextwindowexceeded|insufficient_quota|usage_limit|usagelimitexceeded|session_budget|sessionbudgetexceeded|max_tokens|model_not_found|request_too_large)/;
  if ([401, 402, 403].includes(status)
      || sources.some(value => [value.status, value.status_code, value.statusCode].some(code => [401, 402, 403].includes(code)))
      || codes.some(code => terminal.test(code)
      || /^(?:unauthorized|unauthorised|forbidden|access_denied|insufficient_permissions|not_authorized|authorizationfailed|authentication_failed|missing_api_key|expired_token|token_expired)$/.test(code))
      || /\b(?:unauthorized|forbidden|permission denied|access denied|invalid (?:api[ _-]?key|token|credentials)|content[ _-]filter|content policy|responsible ai|insufficient quota|quota (?:exceeded|exhausted)|(?:account|session) budget (?:exceeded|exhausted)|context (?:length|window) (?:exceeded|exhausted)|(?:invalid|malformed) (?:request )?(?:json|schema)|(?:missing|invalid|unsupported|unknown) (?:required )?(?:parameter|field|argument)|must be (?:an? )?(?:array|object|string|integer|number|boolean))\b/i.test(messages)) return null;
  if (encrypted) return { kind: 'encrypted', detail: 'invalid_encrypted_content', requiresComplete: true };
  if (isKnownResourceError(payload)
      || response === payload && isKnownResourceError({ type: 'response.failed', response })) return { kind: 'resource', detail: messages || 'Azure resource mismatch' };
  if (isScopedHistoryFailure(payload, status, provider)) return { kind: 'history', detail: payload.error.message };
  if (status === 400 || codes.includes('invalid_request_error') || codes.includes('bad_request')) return null;
  if (status === 408 || status === 429 || status >= 500
      || codes.some(code => /^(?:server_error|internal_server_error|internal_error|upstream_error|upstream_failure|upstream_unavailable|upstream_timeout|rate_limit_error|rate_limit_exceeded|too_many_requests|overloaded_error|overloaded|overload|service_unavailable|temporarily_unavailable|timeout_error|request_timeout)$/.test(code))
      || /\b(?:internal server error|server (?:is )?(?:unavailable|overloaded)|rate[ _-]?limit(?:ed|ing)?|too many requests|temporarily unavailable|overloaded)\b/i.test(messages)) {
    if (status >= 400 && status !== 408 && status !== 429 && status < 500) return null;
    return { kind: 'transient', detail: messages || `HTTP ${status}` };
  }
  return null;
}

function inspectFailureBytes(buffer, isSse, status, provider = null) {
  if (buffer.length > PREFIX_BYTES) return null;
  try { return classifyFailure(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)), status, provider); }
  catch {}
  if (!isSse) return null;
  let pending = buffer, failure = null;
  while (pending.length) {
    const boundary = frameEnd(pending);
    if (!boundary) return null;
    const parsed = parseFrame(pending.subarray(0, boundary.end));
    pending = pending.subarray(boundary.end);
    if (!parsed.ok) return null;
    if (!parsed.event) continue;
    if (failure) return null;
    if (lifecycleOnly(parsed.event)) continue;
    failure = classifyFailure(parsed.event, status, provider);
    if (!failure) return null;
  }
  return failure;
}

function lifecycleBytes(buffer) {
  if (buffer.length > PREFIX_BYTES) return false;
  let pending = buffer;
  while (pending.length) {
    const boundary = frameEnd(pending);
    if (!boundary) return false;
    const parsed = parseFrame(pending.subarray(0, boundary.end));
    pending = pending.subarray(boundary.end);
    if (!parsed.ok || parsed.event && !lifecycleOnly(parsed.event)) return false;
  }
  return true;
}

module.exports = { PREFIX_BYTES, frameEnd, parseFrame, lifecycleOnly, classifyFailure, inspectFailureBytes, lifecycleBytes, isOfficialAgentRouterHttps };
