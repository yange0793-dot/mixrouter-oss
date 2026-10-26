'use strict';

// Encrypted reasoning downgrade adapted from resource-history-bridge
// lib/encrypted-reasoning.js at 936f4f5. The caller owns target scope, complete
// response inspection, output/commit guards and the single shared retry budget.
const { RESPONSE_FIELDS } = require('./responses-history');
const { validateInlineResponsesHistory, hasReadableReasoning } = require('./responses-inline-history');

const ERROR_FIELDS = new Set(['message', 'type', 'code', 'param', 'status', 'status_code', 'request_id', 'trace_id', 'sequence_number']);
const ENVELOPE_FIELDS = new Set(['error', 'type', 'sequence_number', 'request_id', 'trace_id']);
const EVENT_FIELDS = new Set(['type', 'sequence_number', 'response']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, fields) => record(value) && Object.keys(value).every(key => fields.has(key));

function exactError(value, enclosed) {
  return only(value, ERROR_FIELDS) && value.code === 'invalid_encrypted_content'
    && typeof value.message === 'string'
    && (enclosed || value.type === 'error' || typeof value.type === 'string' && value.type.endsWith('_error'));
}

function emptyFailedResponse(value) {
  return only(value, RESPONSE_FIELDS)
    && (value.status === undefined || value.status === 'failed')
    && (value.object === undefined || value.object === 'response')
    && (value.output == null || Array.isArray(value.output) && value.output.length === 0)
    && (value.output_text === undefined || value.output_text === '')
    && value.incomplete_details == null && exactError(value.error, true);
}

function isEncryptedReasoningError(payload, status = 200) {
  if (status !== 400 && !(Number.isInteger(status) && status >= 200 && status < 300)) return false;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return false; }
  }
  if (!record(payload)) return false;
  if (payload.type === 'response.failed') return only(payload, EVENT_FIELDS) && emptyFailedResponse(payload.response);
  if (payload.status === 'failed' && (payload.object === undefined || payload.object === 'response')) return emptyFailedResponse(payload);
  if (Object.hasOwn(payload, 'error')) {
    return only(payload, ENVELOPE_FIELDS) && (payload.type === undefined || payload.type === 'error')
      && exactError(payload.error, true);
  }
  return exactError(payload, false);
}

function projectEncryptedReasoning(body) {
  try {
    const validated = validateInlineResponsesHistory(body);
    if (!validated.ok) return validated;
    const { removedEncrypted, droppedReasoning, removedIds, usable } = validated;
    if (!removedEncrypted) return { ok: false, code: 'no_encrypted_reasoning', message: 'No verified encrypted reasoning is available to downgrade.' };
    if (!usable) return { ok: false, code: 'empty_projected_input', message: 'Removing encrypted-only reasoning would leave no usable explicit input.' };
    const projected = structuredClone(body);
    projected.input = projected.input.filter(item => {
      if (item.type !== 'reasoning' || !Object.hasOwn(item, 'encrypted_content')) return true;
      delete item.encrypted_content;
      delete item.id;
      return hasReadableReasoning(item.summary) || hasReadableReasoning(item.content);
    });
    return { ok: true, body: projected, removedEncrypted, droppedReasoning, removedIds, lossy: true };
  } catch {
    return { ok: false, code: 'invalid_history_item', message: 'The explicit history could not be safely validated or copied.' };
  }
}

module.exports = { isEncryptedReasoningError, projectEncryptedReasoning };
