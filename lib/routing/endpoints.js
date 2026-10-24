'use strict';
// 端点识别:路径 → 协议组(claude/codex)与端点种类,以及协议到上游路径的换算。
// 纯查表函数,不持有任何状态,便于单测。

const ENDPOINTS = [
  { re: /^\/v1\/messages\/?$/, app: 'claude', kind: 'messages', path: '/v1/messages' },
  { re: /^\/v1\/messages\/count_tokens\/?$/, app: 'claude', kind: 'count_tokens', path: '/v1/messages/count_tokens' },
  { re: /^\/v1\/responses\/?$/, app: 'codex', kind: 'responses', path: '/v1/responses' },
  { re: /^\/v1\/responses\/compact\/?$/, app: 'codex', kind: 'responses/compact', path: '/v1/responses/compact' },
  { re: /^\/v1\/chat\/completions\/?$/, app: 'codex', kind: 'chat/completions', path: '/v1/chat/completions' },
  { re: /^\/harness\/v1\/messages\/?$/, app: 'claude', kind: 'messages', path: '/v1/messages', client: 'harness' },
  { re: /^\/harness\/v1\/messages\/count_tokens\/?$/, app: 'claude', kind: 'count_tokens', path: '/v1/messages/count_tokens', client: 'harness' },
  { re: /^\/harness\/v1\/responses\/?$/, app: 'codex', kind: 'responses', path: '/v1/responses', client: 'harness' },
  { re: /^\/harness\/v1\/chat\/completions\/?$/, app: 'codex', kind: 'chat/completions', path: '/v1/chat/completions', client: 'harness' },
];

function classifyProxyRequest(req) {
  const p = String((req && req.url) || '').split('?')[0];
  for (const e of ENDPOINTS) if (e.re.test(p)) return e;
  return null;
}

// 本渠道对这次请求该说哪种协议:Claude 组默认 Anthropic,标了 wire_api='responses' 或
// 'chat' 的渠道(只挂 Codex/OpenAI 型通道的模型,如 anyrouter 的 gpt-6-astra、tokenrhythm
// 的 glm-5.3-flash)由代理现场翻译;Codex 组按渠道的 wire_api(都是 responses:原样转发;
// chat:只开 completions 的网关,由代理现场翻译)
const wireOf = (provider, app) => app === 'claude'
  ? ((provider && (provider.wire_api === 'responses' || provider.wire_api === 'chat')) ? provider.wire_api : 'anthropic')
  : ((provider && provider.wire_api === 'chat') ? 'chat' : 'responses');

const upstreamPathOf = (wire, ep) => wire === 'anthropic' ? ep.path : (wire === 'chat' ? '/v1/chat/completions' : ep.kind === 'responses/compact' ? ep.path : '/v1/responses');

// Channel bases may already end in /v1. Keep custom prefixes, append the version once.
const joinUpstreamPath = (pathname, endpoint) => pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + endpoint;

module.exports = { ENDPOINTS, classifyProxyRequest, wireOf, upstreamPathOf, joinUpstreamPath };
