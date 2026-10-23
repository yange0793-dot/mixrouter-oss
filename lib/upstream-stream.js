'use strict';

// Client response format and upstream transport are independent. Only a real boolean
// on the resolved rule overrides Chat/Responses; Anthropic and compact stay unchanged.
function upstreamStreamFor({ wire, kind, body = {}, rule } = {}) {
  if (kind !== 'responses/compact' && (wire === 'chat' || wire === 'responses')
      && typeof rule?.upstream_stream === 'boolean') return rule.upstream_stream;
  if (kind === 'messages') return true;
  // Match the existing Responses→Chat converter, including its omitted-stream default.
  if (wire === 'chat' && kind === 'responses') return body.stream !== false;
  return !!body.stream;
}

// Undefined preserves an omitted stream field on native passthrough requests.
// Always copy: callers share the original request body with response adaptation/retries.
function applyUpstreamStream(outBody, stream) {
  const out = { ...outBody };
  if (typeof stream === 'boolean') out.stream = stream;
  if (out.stream === false) delete out.stream_options;
  return out;
}

module.exports = { upstreamStreamFor, applyUpstreamStream };
