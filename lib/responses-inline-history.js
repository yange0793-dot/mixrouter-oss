'use strict';

// Strict automatic inline-history contract adapted from resource-history-bridge
// lib/history.js at 936f4f5. This is separate from the existing legacy ID projector.
const ITEM_FIELDS = Object.freeze({
  message: new Set(['type', 'id', 'role', 'content', 'status', 'phase']),
  reasoning: new Set(['type', 'id', 'summary', 'content', 'encrypted_content', 'status']),
  function_call: new Set(['type', 'id', 'call_id', 'name', 'namespace', 'arguments', 'status']),
  function_call_output: new Set(['type', 'id', 'call_id', 'output', 'status']),
  custom_tool_call: new Set(['type', 'id', 'call_id', 'name', 'namespace', 'input', 'status']),
  custom_tool_call_output: new Set(['type', 'id', 'call_id', 'output', 'status']),
  additional_tools: new Set(['type', 'id', 'role', 'tools']),
});
const TOOL_FIELDS = Object.freeze({
  function: new Set(['type', 'name', 'description', 'parameters', 'strict']),
  namespace: new Set(['type', 'name', 'description', 'tools']),
  custom: new Set(['type', 'name', 'description', 'format']),
});
const EASY_FIELDS = new Set(['role', 'content']);
const TEXT_FIELDS = new Set(['type', 'text', 'annotations', 'logprobs', 'metadata']);
const IMAGE_FIELDS = new Set(['type', 'image_url', 'detail', 'metadata']);
const REASONING_TEXT_FIELDS = new Set(['type', 'text']);
const FORMAT_FIELDS = new Set(['type', 'syntax', 'definition', 'metadata']);
const REMOVABLE_TYPES = new Set(['message', 'reasoning', 'function_call', 'function_call_output']);
const EASY_ROLES = new Set(['user', 'developer', 'system']);
const MESSAGE_ROLES = new Set([...EASY_ROLES, 'assistant']);

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const only = (value, fields) => record(value) && Object.keys(value).every(key => fields.has(key));
const reject = (code, message) => ({ ok: false, code, message });

function inlineImageUrl(value) {
  if (!nonempty(value)) return false;
  if (/^data:image\/[^;,]+(?:;[^,]*)?,.+$/is.test(value)) return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname;
  } catch { return false; }
}

function inlineContent(content) {
  return Array.isArray(content) && content.length > 0 && content.every(part => {
    if (!record(part)) return false;
    if (['input_text', 'output_text'].includes(part.type)) {
      return only(part, TEXT_FIELDS) && typeof part.text === 'string'
        && (!Object.hasOwn(part, 'annotations') || Array.isArray(part.annotations))
        && (!Object.hasOwn(part, 'logprobs') || part.logprobs === null || Array.isArray(part.logprobs));
    }
    return part.type === 'input_image' && only(part, IMAGE_FIELDS) && inlineImageUrl(part.image_url)
      && (!Object.hasOwn(part, 'detail') || ['auto', 'low', 'high', 'original'].includes(part.detail));
  });
}

function reasoningParts(parts, type) {
  return Array.isArray(parts) && parts.every(part => only(part, REASONING_TEXT_FIELDS)
    && part.type === type && typeof part.text === 'string');
}

function hasReadableReasoning(parts) {
  return Array.isArray(parts) && parts.some(part => typeof part?.text === 'string' && part.text.trim().length > 0);
}

function inlineToolSchema(tool) {
  if (!record(tool) || !nonempty(tool.name) || !Object.hasOwn(TOOL_FIELDS, tool.type)
      || !only(tool, TOOL_FIELDS[tool.type])
      || Object.hasOwn(tool, 'description') && typeof tool.description !== 'string') return false;
  if (tool.type === 'function') {
    return record(tool.parameters)
      && (!Object.hasOwn(tool, 'strict') || tool.strict === null || typeof tool.strict === 'boolean');
  }
  if (tool.type === 'namespace') return Array.isArray(tool.tools) && tool.tools.every(inlineToolSchema);
  if (!only(tool.format, FORMAT_FIELDS)) return false;
  if (tool.format.type === 'text') return !Object.hasOwn(tool.format, 'syntax') && !Object.hasOwn(tool.format, 'definition');
  return tool.format.type === 'grammar' && ['lark', 'regex'].includes(tool.format.syntax) && nonempty(tool.format.definition);
}

function usableMessage(item) {
  return typeof item.content === 'string' ? item.content.trim().length > 0
    : item.content.some(part => part.type === 'input_image' || typeof part.text === 'string' && part.text.trim().length > 0);
}

function validate(body) {
  if (!record(body)) return reject('invalid_body', 'Recovery requires a JSON object.');
  if (body.context_compaction != null) {
    return reject('unsupported_encrypted_history', 'Compacted history cannot be reconstructed locally.');
  }
  if (body.previous_response_id != null || body.conversation != null) {
    return reject('server_history_reference', 'Recovery requires full explicit history without server references.');
  }
  if (!Array.isArray(body.input) || body.input.length === 0) {
    return reject('explicit_history_required', 'Recovery requires complete explicit Responses input history.');
  }
  const calls = new Map(), outputs = new Set();
  let removed = 0, removedEncrypted = 0, droppedReasoning = 0, removedIds = 0, usable = false;
  for (const item of body.input) {
    if (!record(item)) return reject('invalid_history_item', 'Every explicit history item must be a complete object.');
    if (item.type === 'item_reference') return reject('item_reference', 'An item_reference cannot be expanded locally.');
    if (['compaction', 'context_compaction'].includes(item.type)) {
      return reject('unsupported_encrypted_history', 'Compacted history cannot be reconstructed locally.');
    }
    if (!Object.hasOwn(item, 'type')) {
      if (!only(item, EASY_FIELDS) || !EASY_ROLES.has(item.role)
          || !(typeof item.content === 'string' || inlineContent(item.content))) {
        return reject('invalid_history_item', 'Easy messages require a verified role and complete inline content.');
      }
      usable ||= usableMessage(item);
      continue;
    }
    if (typeof item.type !== 'string' || !Object.hasOwn(ITEM_FIELDS, item.type)
        || !only(item, ITEM_FIELDS[item.type])
        || Object.hasOwn(item, 'id') && !nonempty(item.id)
        || Object.hasOwn(item, 'status') && item.status !== 'completed') {
      return reject('invalid_history_item', 'Unknown, incomplete or unsupported history shapes cannot be safely downgraded.');
    }
    if (REMOVABLE_TYPES.has(item.type) && Object.hasOwn(item, 'id')) removed++;
    if (item.type === 'message') {
      if (!MESSAGE_ROLES.has(item.role) || !inlineContent(item.content)
          || Object.hasOwn(item, 'phase') && !['commentary', 'final_answer'].includes(item.phase)) {
        return reject('invalid_history_item', 'Message history requires complete inline content and a known role and phase.');
      }
      usable ||= usableMessage(item);
    } else if (item.type === 'reasoning') {
      if (!reasoningParts(item.summary, 'summary_text')
          || Object.hasOwn(item, 'encrypted_content') && !nonempty(item.encrypted_content)
          || Object.hasOwn(item, 'content') && item.content !== null && !reasoningParts(item.content, 'reasoning_text')) {
        return reject('invalid_history_item', 'Reasoning requires a valid summary and complete optional content.');
      }
      const readable = hasReadableReasoning(item.summary) || hasReadableReasoning(item.content);
      if (Object.hasOwn(item, 'encrypted_content')) {
        removedEncrypted++;
        if (Object.hasOwn(item, 'id')) removedIds++;
        if (!readable) droppedReasoning++;
      }
      usable ||= readable;
    } else if (item.type === 'additional_tools') {
      if (item.role !== 'developer' || !Array.isArray(item.tools) || !item.tools.every(inlineToolSchema)) {
        return reject('invalid_history_item', 'Additional tools require verified inline schemas.');
      }
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const custom = item.type === 'custom_tool_call';
      if (!nonempty(item.call_id) || !nonempty(item.name) || typeof item[custom ? 'input' : 'arguments'] !== 'string'
          || Object.hasOwn(item, 'namespace') && !nonempty(item.namespace) || calls.has(item.call_id)) {
        return reject('invalid_tool_pair', 'Tool calls require a unique call_id, name and complete original input.');
      }
      calls.set(item.call_id, item.type);
      usable = true;
    } else {
      const custom = item.type === 'custom_tool_call_output';
      if (!nonempty(item.call_id) || calls.get(item.call_id) !== (custom ? 'custom_tool_call' : 'function_call')
          || outputs.has(item.call_id) || !Object.hasOwn(item, 'output')
          || !custom && !(typeof item.output === 'string' || inlineContent(item.output))) {
        return reject('invalid_tool_pair', 'Every tool result must follow exactly one matching complete call.');
      }
      outputs.add(item.call_id);
    }
  }
  if ([...calls.keys()].some(id => !outputs.has(id))) return reject('invalid_tool_pair', 'A tool call is missing its matching output.');
  return { ok: true, removed, removedEncrypted, droppedReasoning, removedIds, usable };
}

function validateInlineResponsesHistory(body) {
  try { return validate(body); }
  catch { return reject('invalid_history_item', 'The explicit history could not be safely validated.'); }
}

module.exports = { validateInlineResponsesHistory, hasReadableReasoning };
