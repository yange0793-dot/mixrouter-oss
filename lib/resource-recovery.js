'use strict';

// Resource binding is transport-independent; only native Responses has a proven
// portable projection. Semantic tool IDs and opaque reasoning are never rewritten.
function resourceBindingError(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return false; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const error = value.type === 'response.failed' ? value.response?.error
    : value.error || (value.type === 'error' ? value : null);
  if (!error || typeof error !== 'object' || typeof error.message !== 'string') return false;
  const message = 'The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it.';
  if (!error.message.startsWith(message)) return false;
  // Gateways append these observed diagnostic wrappers. Accept only their shape,
  // not arbitrary prose after the exact two-sentence resource binding diagnosis.
  const suffix = error.message.slice(message.length);
  return suffix === '' || /^ (?:\(request id: [A-Za-z0-9._:-]{1,256}\) )?\[trace_id=[A-Za-z0-9._:-]{1,256}\]$/.test(suffix);
}

const outputTypes = new Set(['message', 'reasoning', 'function_call', 'custom_tool_call']);

function portableHistory(body, kind) {
  const unsupported = reason => ({ supported: false, changed: false, body, reason });
  if (kind !== 'responses') return unsupported('unsupported_protocol');
  if (!body || typeof body !== 'object' || Array.isArray(body)) return unsupported('invalid_body');
  // Inline messages do not prove that a server-side reference's full history is
  // present. This request has no verifiable completeness marker, so never drop it.
  if (body.conversation || body.previous_response_id) return unsupported('reference_only_history');
  if (!Array.isArray(body.input) || !body.input.length) {
    return unsupported('no_resource_ids');
  }
  // A reference cannot be expanded without a stored transcript. Refuse the entire
  // projection rather than dropping it and silently losing conversation context.
  if (body.input.some(item => item?.type === 'item_reference')) return unsupported('reference_only_history');
  const calls = new Set(), results = new Set();
  let changed = false;
  for (const item of body.input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return unsupported('invalid_history');
    if (item.type === 'message' || (!item.type && item.role)) {
      if (!['system', 'developer', 'user', 'assistant'].includes(item.role)
          || !(typeof item.content === 'string' || Array.isArray(item.content))) return unsupported('invalid_history');
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const field = item.type === 'function_call' ? 'arguments' : 'input';
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string'
          || typeof item[field] !== 'string' || calls.has(item.call_id)) return unsupported('incomplete_tool_history');
      calls.add(item.call_id);
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      if (!calls.has(item.call_id) || !Object.hasOwn(item, 'output') || results.has(item.call_id)) return unsupported('incomplete_tool_history');
      results.add(item.call_id);
    }
    if (Object.hasOwn(item, 'id')) {
      if (!outputTypes.has(item.type) || typeof item.id !== 'string' || !item.id) return unsupported('unknown_resource_id');
      changed = true;
    }
  }
  if ([...calls].some(call => !results.has(call))) return unsupported('incomplete_tool_history');
  if (!changed) return unsupported('no_resource_ids');
  const projected = { ...body, input: body.input.map(item => {
    if (!Object.hasOwn(item, 'id')) return item;
    const { id, ...portable } = item;
    return portable;
  }) };
  return { supported: true, changed: true, body: projected, reason: '' };
}

module.exports = { resourceBindingError, portableHistory };
