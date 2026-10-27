'use strict';
// Synthetic fixtures only, loopback upstream only. Same real wire shapes as
// codex-azure-wire-recovery.test.js, but with no retry budget at all
// (MIXR_MAX_ATTEMPTS=1, MIXR_CONV_RETRIES=0).
//
// The point: a request that is recognized as an Azure resource-binding failure but has no
// budget left to retry used to look exactly like "recovery never recognized this" — one
// attempt, the upstream sentence, and no reason in the request log. It must still carry the
// fixed classification, so an operator can tell the two apart.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-codex-azure-budget-'));
Object.assign(process.env, {
  MIXR_DATA_DIR: root, MIXR_CLAUDE_SETTINGS: path.join(root, 'settings.json'),
  MIXR_CODEX_CONFIG: path.join(root, 'config.toml'), MIXR_MAX_ATTEMPTS: '1',
  MIXR_CONV_RETRIES: '0', MIXR_RETRY_DELAY_MS: '10', MIXR_SSE_KEEPALIVE_MS: '0',
  MIXR_TOTAL_DEADLINE_MS: '6000', MIXR_STREAM_IDLE_TIMEOUT_MS: '500', MIXR_RESPONSE_ARCHIVE: 'off',
  MIXR_UPSTREAM_PROXY: '',
});
const mod = require('../mixrouter');
const { destroyAgents } = require('../lib/upstream-proxy');
const HOSTS = ['ps.air-outer.com', 'agentrouter.org'];
const RESOURCE_MESSAGE = 'The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it.';
const plainError = (trace = 'fixture') => ({ error: {
  message: `${RESOURCE_MESSAGE} [trace_id=${trace}]`, type: 'invalid_request_error', param: '', code: null,
} });
function frame(event) { return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`; }
const answerItem = { id: 'msg-fixture-answer', type: 'message', role: 'assistant', status: 'completed',
  phase: 'final_answer', content: [{ type: 'output_text', text: 'Fixture answer.', annotations: [] }] };
const completed = { id: 'resp-fixture-success', object: 'response', status: 'completed', output: [answerItem],
  usage: { input_tokens: 11, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } } };
const successBytes = frame({ type: 'response.created', response: { ...completed, status: 'in_progress', output: [], usage: null } })
  + frame({ type: 'response.output_item.done', output_index: 0, item: answerItem })
  + frame({ type: 'response.completed', response: completed });

function wireHistory() {
  return { model: 'fixture-codex-model', stream: true, store: false, prompt_cache_key: 'fixture-cache',
    reasoning: { effort: 'high' }, include: ['reasoning.encrypted_content'],
    tools: [{ type: 'function', name: 'shell', strict: false,
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }],
    input: [
      { type: 'message', id: 'msg-fixture-developer', role: 'developer',
        content: [{ type: 'input_text', text: 'Fixture developer instructions.' }] },
      { type: 'reasoning', id: 'rs-fixture-empty', summary: [], content: null, encrypted_content: 'FIXTURE_CIPHER_1' },
      { type: 'web_search_call', id: 'ws-fixture-1', status: 'completed',
        action: { type: 'open_page', url: 'https://fixture.invalid/page' } },
      { type: 'function_call', id: 'fc-fixture-1', call_id: 'call-fixture-1', name: 'shell',
        arguments: '{"command":"printf fixture"}' },
      { type: 'function_call_output', id: 'fco-fixture-1', call_id: 'call-fixture-1', output: 'fixture output one' },
      { role: 'user', content: [{ type: 'input_text', text: 'Summarize the fixture.' }] },
    ] };
}

let upstream, proxy, reply, seen, fixtureId = 0;
const sockets = new Set();
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;
function intercept(original, options, ...rest) {
  const hostname = typeof options === 'object' && options !== null ? options.hostname : null;
  if (HOSTS.includes(hostname)) {
    return originalHttpRequest.call(http, { ...options, protocol: 'http:', hostname: '127.0.0.1',
      port: upstream.address().port, agent: false }, ...rest);
  }
  assert.ok(hostname === '127.0.0.1', `unexpected non-loopback transport target: ${hostname}`);
  return original.call(http, options, ...rest);
}
function configure() {
  mod._state.store = { claude: [], codex: [{ id: 'azure-fixture', name: 'AgentRouter', enabled: true,
    api_key: 'synthetic-fixture-key', wire_api: 'responses', base_url: 'https://ps.air-outer.com/v1',
    models: ['fixture-codex-model'] }] };
  mod._state.routes = { rules: [], default: mod.normalizeRule({ provider: 'azure-fixture' }) };
  mod._state.slotMap = { claude: {}, codex: { main: { provider: 'azure-fixture', model: 'fixture-codex-model' } } };
}
function ask(body, session) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/v1/responses',
      agent: false, headers: { 'Content-Type': 'application/json', 'session-id': session,
        originator: 'codex_cli_rs', Connection: 'close' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.once('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString('utf8') });
      });
    });
    req.on('error', reject); req.setTimeout(8000, () => req.destroy(new Error('azure budget fixture timeout')));
    req.end(JSON.stringify(body));
  });
}
function logs() {
  const file = path.join(root, 'logs/requests.jsonl');
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
const lastLog = () => logs().at(-1);

before(async () => {
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.once('end', () => { seen.push({ url: req.url, headers: req.headers, bytes: Buffer.concat(chunks) }); reply(req, res); });
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  http.request = (options, ...rest) => intercept(originalHttpRequest, options, ...rest);
  https.request = (options, ...rest) => intercept(originalHttpsRequest, options, ...rest);
  proxy = await mod.listen(0, mod.proxyHandler);
});
beforeEach(() => { fixtureId++; seen = []; mod._state.sessions.clear(); mod._state.cooldowns = {}; mod._state.resetPools(); configure(); });
after(async () => {
  http.request = originalHttpRequest; https.request = originalHttpsRequest;
  destroyAgents();
  for (const socket of sockets) socket.destroy();
  await Promise.all([upstream, proxy].filter(Boolean).map(server => new Promise(resolve => {
    server.closeAllConnections(); server.close(resolve);
  })));
  fs.rmSync(root, { recursive: true, force: true });
});

test('zero retry budget: the decline is classified, the client still gets the exact upstream body', async () => {
  const body = wireHistory(), original = structuredClone(body), raw = JSON.stringify(plainError('budget'));
  reply = (_req, res) => { res.writeHead(400, { 'Content-Type': 'text/event-stream', 'x-request-id': 'fixture-terminal' }); res.end(raw); };
  const result = await ask(body, `codex-azure-budget-${fixtureId}`);
  assert.equal(seen.length, 1, 'no second upstream call exists in this budget');
  assert.equal(result.status, 400);
  assert.deepEqual(result.bytes, Buffer.from(raw), 'the client sees the real upstream bytes untouched');
  assert.equal(result.headers['x-request-id'], 'fixture-terminal');
  assert.deepEqual(JSON.parse(seen[0].bytes), original);
  assert.deepEqual(body, original);
  assert.equal(lastLog().attempts, 1);
  assert.equal(lastLog().retry_reason, undefined);
  assert.equal(lastLog().resource_recovery_skipped, 'unsupported_item_id+retry_budget_exhausted');
});

test('zero retry budget with a projectable history is classified the same way', async () => {
  const body = wireHistory();
  body.input = body.input.filter(item => item.type !== 'web_search_call');
  const raw = JSON.stringify(plainError('budget-projected'));
  reply = (_req, res) => { res.writeHead(400, { 'Content-Type': 'text/event-stream' }); res.end(raw); };
  const result = await ask(body, `codex-azure-budget-projected-${fixtureId}`);
  assert.equal(seen.length, 1);
  assert.equal(result.status, 400);
  assert.equal(lastLog().attempts, 1);
  assert.equal(lastLog().retry_reason, undefined);
  assert.equal(lastLog().resource_recovery_skipped, 'retry_budget_exhausted');
});
