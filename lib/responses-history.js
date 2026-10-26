'use strict';

// Local Codex projection contract, adapted from the same project's standalone bridge:
// https://github.com/yange0793-dot/resource-history-bridge/blob/main/lib/history.js
// Only resource-owned item IDs are removed; the caller's durable history is never changed.
const RESOURCE_ERROR = /\bThe requested item was created under a different Azure OpenAI resource\b/i;
const RESPONSE_FIELDS = new Set(['id', 'object', 'created_at', 'status', 'background', 'error', 'incomplete_details', 'instructions', 'max_output_tokens', 'max_tool_calls', 'model', 'output', 'output_text', 'parallel_tool_calls', 'previous_response_id', 'reasoning', 'store', 'temperature', 'text', 'tool_choice', 'tools', 'top_p', 'truncation', 'usage', 'user', 'metadata', 'service_tier', 'prompt_cache_key', 'prompt_cache_retention', 'safety_identifier', 'conversation']);
const ERROR_FIELDS = new Set(['message', 'type', 'code', 'param', 'status', 'status_code', 'request_id', 'trace_id', 'sequence_number']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const only = (value, fields) => record(value) && Object.keys(value).every(key => fields.has(key));

function isKnownResourceError(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return false; } }
  if (!record(value)) return false;
  if (value.type === 'response.failed') {
    if (!only(value, new Set(['type', 'sequence_number', 'response'])) || !only(value.response, RESPONSE_FIELDS)) return false;
    const response = value.response;
    if (response.output != null && (!Array.isArray(response.output) || response.output.length) || response.output_text) return false;
    return only(response.error, ERROR_FIELDS) && RESOURCE_ERROR.test(response.error.message || '');
  }
  if (Object.hasOwn(value, 'error')) {
    if (!only(value, new Set(['error', 'type', 'sequence_number', 'request_id', 'trace_id'])) || value.type != null && value.type !== 'error') return false;
    return only(value.error, ERROR_FIELDS) && RESOURCE_ERROR.test(value.error.message || '');
  }
  return only(value, ERROR_FIELDS) && typeof value.type === 'string'
    && (value.type === 'error' || value.type.endsWith('_error')) && RESOURCE_ERROR.test(value.message || '');
}

function completeToolSchema(tool) {
  if (!record(tool) || !nonempty(tool.name)) return false;
  if (tool.type === 'function') return record(tool.parameters);
  if (tool.type === 'namespace') return Array.isArray(tool.tools) && tool.tools.every(completeToolSchema);
  if (tool.type !== 'custom' || !record(tool.format)) return false;
  return tool.format.type === 'text' || tool.format.type === 'grammar'
    && ['lark', 'regex'].includes(tool.format.syntax) && nonempty(tool.format.definition);
}
function inlineContent(content) {
  return Array.isArray(content) && content.length > 0 && content.every(part => {
    if (!record(part)) return false;
    if (['input_text', 'output_text'].includes(part.type)) return typeof part.text === 'string';
    if (part.type !== 'input_image' || Object.hasOwn(part, 'file_id') || !nonempty(part.image_url)) return false;
    if (/^data:image\/[^;,]+(?:;[^,]*)?,.+$/is.test(part.image_url)) return true;
    try { const url = new URL(part.image_url); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname; }
    catch { return false; }
  });
}

function projectResponsesHistory(body) {
  const reject = code => ({ ok: false, code });
  if (!record(body) || !Array.isArray(body.input) || !body.input.length) return reject('explicit_history_required');
  if (body.previous_response_id != null || body.conversation != null) return reject('server_history_reference');
  const calls = new Map(), outputs = new Set();
  const removable = new Set(['message', 'reasoning', 'function_call', 'function_call_output']);
  let removed = 0;
  for (const item of body.input) {
    if (!record(item)) return reject('invalid_history_item');
    if (Object.hasOwn(item, 'id') && !nonempty(item.id)) return reject('invalid_item_id');
    if (Object.hasOwn(item, 'status') && item.status !== 'completed') return reject('incomplete_history_item');
    if (Object.hasOwn(item, 'id') && !removable.has(item.type)
        && !['additional_tools', 'custom_tool_call', 'custom_tool_call_output'].includes(item.type)) return reject('unsupported_item_id');
    switch (item.type) {
      case undefined:
        // Codex's easy input messages are inline and have no resource-owned ID.
        if (!['user', 'developer', 'system'].includes(item.role)
            || !(typeof item.content === 'string' || inlineContent(item.content))) return reject('invalid_history_item');
        break;
      case 'message':
        if (!['user', 'developer', 'system', 'assistant'].includes(item.role) || !inlineContent(item.content)
            || Object.hasOwn(item, 'phase') && !['commentary', 'final_answer'].includes(item.phase)) return reject('invalid_history_item');
        break;
      case 'reasoning':
        if (!Array.isArray(item.summary) || !item.summary.every(part => record(part) && part.type === 'summary_text' && typeof part.text === 'string')
            || Object.hasOwn(item, 'encrypted_content') && !nonempty(item.encrypted_content)
            || Object.hasOwn(item, 'content') && item.content !== null && (!Array.isArray(item.content)
              || !item.content.every(part => record(part) && part.type === 'reasoning_text' && typeof part.text === 'string'))) return reject('invalid_history_item');
        break;
      case 'additional_tools':
        if (!nonempty(item.id) || item.role !== 'developer' || !Array.isArray(item.tools) || !item.tools.every(completeToolSchema)) return reject('invalid_history_item');
        break;
      case 'function_call':
      case 'custom_tool_call':
        if (!nonempty(item.call_id) || !nonempty(item.name) || calls.has(item.call_id)
            || typeof item[item.type === 'function_call' ? 'arguments' : 'input'] !== 'string'
            || item.type === 'custom_tool_call' && !nonempty(item.id)) return reject('invalid_tool_pair');
        calls.set(item.call_id, item.type);
        break;
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const custom = item.type === 'custom_tool_call_output';
        if (!nonempty(item.call_id) || calls.get(item.call_id) !== (custom ? 'custom_tool_call' : 'function_call')
            || outputs.has(item.call_id) || !Object.hasOwn(item, 'output') || custom && !nonempty(item.id)) return reject('invalid_tool_pair');
        // Strip a native output's resource ID only when its payload is inline.
        // Outputs without IDs and retained custom IDs keep their existing behavior.
        if (!custom && Object.hasOwn(item, 'id')
            && !(typeof item.output === 'string' || inlineContent(item.output))) return reject('invalid_history_item');
        outputs.add(item.call_id);
        break;
      }
      default: return reject('unsupported_history_item');
    }
    if (removable.has(item.type) && Object.hasOwn(item, 'id')) removed++;
  }
  if ([...calls.keys()].some(id => !outputs.has(id))) return reject('invalid_tool_pair');
  if (!removed) return reject('no_supported_item_ids');
  const projected = structuredClone(body);
  for (const item of projected.input) if (removable.has(item.type)) delete item.id;
  return { ok: true, body: projected, removed };
}

// Built-in items own resource-scoped IDs that projection cannot strip, so a body that
// contains one is rejected as `unsupported_item_id` and never projected. Replaying the
// original bytes is a different, narrower allowance: nothing is rewritten, but that is
// only honest when the whole history is complete, local and reviewable. One known shape
// qualifies — a completed `web_search_call` whose `action` is one of the three documented
// action types with plain string fields. Anything else (unknown key, missing completion,
// unknown action) is not proven safe and must keep the terminal error.
const WEB_SEARCH_FIELDS = new Set(['type', 'id', 'status', 'action']);
const WEB_SEARCH_ACTIONS = Object.freeze({
  search: ['query'],
  open_page: ['url'],
  find: ['url', 'pattern'],
});
function completeWebSearchCall(item) {
  if (!only(item, WEB_SEARCH_FIELDS)) return false;
  if (!nonempty(item.id) || item.status !== 'completed' || !record(item.action)) return false;
  const fields = WEB_SEARCH_ACTIONS[item.action.type];
  if (!fields || !only(item.action, new Set(['type', ...fields]))) return false;
  return fields.every(field => nonempty(item.action[field]));
}

// Replayability check for a history the projection refused. The contract is not
// restated here: the admitted built-ins are set aside in a copy and the very same
// projection rules re-run on what remains, so a broken tool pair, duplicate call ID,
// server reference or unknown item still disqualifies the body no matter where it
// sits relative to the built-in item (projection stops at the first problem it meets).
function replayableUnprojectedHistory(body) {
  const reject = code => ({ ok: false, code });
  if (!record(body) || !Array.isArray(body.input) || !body.input.length) return reject('explicit_history_required');
  if (body.previous_response_id != null || body.conversation != null) return reject('server_history_reference');
  for (const item of body.input) {
    if (!record(item)) return reject('invalid_history_item');
    if (item.type === 'web_search_call' && !completeWebSearchCall(item)) return reject('unsupported_history_item');
  }
  const copy = structuredClone(body);
  copy.input = copy.input.filter(item => item.type !== 'web_search_call');
  const probe = projectResponsesHistory(copy);
  // `no_supported_item_ids` only says nothing projectable is left once built-ins are
  // set aside; every other rejection keeps this history non-replayable.
  if (!probe.ok && probe.code !== 'no_supported_item_ids') return reject(probe.code);
  return { ok: true };
}

module.exports = { RESPONSE_FIELDS, isKnownResourceError, projectResponsesHistory, replayableUnprojectedHistory };
