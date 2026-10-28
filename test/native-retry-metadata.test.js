'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lifecycleOnly, classifyFailure } = require('../lib/responses-recovery');

// Sanitized metadata shape observed on the live native Responses endpoint.
const response = () => ({
  id: 'fixture-response', object: 'response', status: 'in_progress', output: [], error: null,
  access_programs: null, background: false, completed_at: null, content_filters: null,
  frequency_penalty: 0, presence_penalty: 0, moderation: null, top_logprobs: 0,
  incomplete_details: null, reasoning: { context: 'all_turns', effort: 'high', mode: 'standard', summary: null },
  tool_usage: {
    image_gen: { input_tokens: 0, input_tokens_details: { image_tokens: 0, text_tokens: 0 },
      output_tokens: 0, output_tokens_details: { image_tokens: 0, text_tokens: 0 }, total_tokens: 0 },
    web_search: { num_requests: 0 },
  },
});
const event = (type, body = response()) => ({ type, sequence_number: 0, response: body });
const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const failure = () => event('response.failed', { ...response(), status: 'failed',
  error: { type: 'too_many_requests', code: 'rate_limit_exceeded',
    message: 'Your requests have exceeded token rate limit.',
    headers: { 'x-ms-fe-error': 'true' } } });
const prefix = () => frame(event('response.created')) + frame(event('response.in_progress'));
const success = frame(event('response.completed', {
  id: 'fixture-completed', status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
  usage: { input_tokens: 1, output_tokens: 1 },
}));

test('observed native metadata is an empty lifecycle and rate-limit failure', () => {
  assert.equal(lifecycleOnly(event('response.created')), true);
  assert.equal(lifecycleOnly(event('response.in_progress')), true);
  assert.equal(classifyFailure(failure()).kind, 'transient');
});

test('rate-limit error metadata does not close the pre-output retry window', () => {
  const failed = { type: 'error', sequence_number: 2, error: failure().response.error };
  assert.equal(classifyFailure(failed).kind, 'transient');
});

const barriers = [
  body => { body.unknown_output = 'opaque'; },
  body => { body.content_filters = [{ blocked: true }]; },
  body => { body.moderation = { blocked: true }; },
  body => { body.access_programs = { unknown: true }; },
  body => { body.tool_usage.web_search.num_requests = 1; },
  body => { body.tool_usage.image_gen.output_tokens = 1; },
  body => { body.tool_usage.image_gen.output_tokens_details.image_tokens = 1; },
  body => { body.tool_usage.image_gen.unknown = 0; },
  body => { body.tool_usage.unknown_tool = {}; },
  body => { body.top_logprobs = { output: 'opaque' }; },
  body => { body.reasoning.context = { text: 'output' }; },
  body => { body.reasoning.unknown = 'opaque'; },
  body => { body.output_text = ' '; },
  body => { body.output = [{ type: 'function_call', call_id: 'once', name: 'Write', arguments: '{}' }]; },
];
for (const [index, mutate] of barriers.entries()) test(`native metadata replay barrier ${index}`, () => {
  const created = event('response.created'), failed = failure();
  mutate(created.response); mutate(failed.response);
  assert.equal(lifecycleOnly(created), false);
  assert.equal(classifyFailure(failed), null);
});
test('authentication and quota remain terminal with native metadata', () => {
  for (const code of ['invalid_api_key', 'insufficient_quota', 'content_policy_violation']) {
    const failed = failure(); failed.response.error.code = code;
    assert.equal(classifyFailure(failed), null);
  }
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-native-metadata-'));
Object.assign(process.env, {
  MIXR_DATA_DIR: root, MIXR_CLAUDE_SETTINGS: path.join(root, 'settings.json'),
  MIXR_CODEX_CONFIG: path.join(root, 'config.toml'), MIXR_MAX_ATTEMPTS: '50',
  MIXR_MAX_UPSTREAM_CALLS: '50', MIXR_CONV_RETRIES: '3', MIXR_RETRY_DELAY_MS: '0',
  MIXR_TOTAL_DEADLINE_MS: '10000', MIXR_SSE_KEEPALIVE_MS: '0', MIXR_RESPONSE_ARCHIVE: 'off',
});
const mod = require('../mixrouter');
let upstream, proxy, reply, attempts, bodies;
before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      attempts++; bodies.push(Buffer.concat(chunks));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(reply());
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  mod._state.store = { claude: [], codex: [{ id: 'native', name: 'native', enabled: true,
    api_key: 'fixture-secret', wire_api: 'responses', models: ['fixture-model'],
    base_url: `http://127.0.0.1:${upstream.address().port}` }] };
  mod._state.routes = { rules: [] };
  // 唯一登记:codex 组只有这一条渠道登记了 fixture-model,请求模型精确命中它,无需槽位。
  proxy = await mod.listen(0, mod.proxyHandler);
});
after(async () => {
  await Promise.all([upstream, proxy].filter(Boolean).map(server => new Promise(resolve => {
    server.closeAllConnections(); server.close(resolve);
  })));
  fs.rmSync(root, { recursive: true, force: true });
});
async function ask() {
  attempts = 0; bodies = [];
  const result = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'session-id': 'native-metadata-test' },
    body: JSON.stringify({ model: 'fixture-model', input: 'Reply OK.', stream: true }),
    signal: AbortSignal.timeout(15000),
  });
  // Even response headers must remain uncommitted during the 49 internal failures.
  assert.equal(attempts, 50);
  return result.text();
}
function lastLog() {
  return JSON.parse(fs.readFileSync(path.join(root, 'logs/requests.jsonl'), 'utf8').trim().split('\n').at(-1));
}
test('49 native rate limits are silent; attempt 50 succeeds with identical request bytes', async () => {
  reply = () => attempts < 50 ? prefix() + frame(failure()) + 'data: [DONE]\n\n' : success;
  assert.equal(await ask(), success);
  assert.equal(lastLog().attempts, 50);
  assert.equal(lastLog().retry_reason, 'native_preoutput_retry');
  assert.equal(lastLog().err, '');
  assert.equal(lastLog().err_class, '');
  assert.ok(bodies.every(body => body.equals(bodies[0])));
});
test('persistent rate limit returns the final failure once and never calls attempt 51', async () => {
  const bytes = prefix() + frame(failure()) + 'data: [DONE]\n\n';
  reply = () => bytes;
  assert.equal(await ask(), bytes);
  assert.equal(lastLog().attempts, 50);
  assert.match(lastLog().err, /token rate limit/);
  assert.equal(attempts, 50);
});
