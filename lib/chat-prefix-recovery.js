'use strict';
// Codex's Chat bridge delays its synthetic response.created until upstream bytes
// are known not to be an empty transient failure. Unknown fields are output barriers.
const { classifyFailure } = require('./responses-recovery');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, fields) => record(value) && Object.keys(value).every(key => fields.includes(key));

function classifyChatFailure(payload, status = 200) {
  const failure = classifyFailure(payload, status);
  return failure?.kind === 'transient' ? failure : null;
}

function emptyChatChunk(payload) {
  if (!only(payload, ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier'])
      || payload.object !== 'chat.completion.chunk' || !Array.isArray(payload.choices)
      || payload.usage != null && (!only(payload.usage, ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details'])
        || ['prompt_tokens', 'completion_tokens', 'total_tokens'].some(key => payload.usage[key] !== undefined && !Number.isFinite(payload.usage[key]))
        || payload.usage.prompt_tokens_details != null && !only(payload.usage.prompt_tokens_details, ['cached_tokens', 'audio_tokens'])
        || payload.usage.completion_tokens_details != null && !only(payload.usage.completion_tokens_details, ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']))) return false;
  return payload.choices.every(choice => only(choice, ['index', 'delta', 'finish_reason', 'logprobs'])
    && Number.isInteger(choice.index) && choice.finish_reason == null && choice.logprobs == null
    && only(choice.delta, ['role', 'content', 'reasoning_content', 'reasoning', 'tool_calls'])
    && (choice.delta.role === undefined || choice.delta.role === 'assistant')
    && ['content', 'reasoning_content', 'reasoning'].every(key => choice.delta[key] == null || choice.delta[key] === '')
    && (choice.delta.tool_calls === undefined || Array.isArray(choice.delta.tool_calls) && !choice.delta.tool_calls.length));
}

module.exports = { classifyChatFailure, emptyChatChunk };
