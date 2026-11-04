'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockUpstream } = require('./mock-upstream');
const { CODEX_COMPACT_PREFIX, COMPACT_RULES, isCodexCompactInstruction } = require('../lib/routing/compact-signature');
const { compactTexts } = require('../lib/session/identity');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-shared-compact-'));
process.env.MIXR_DATA_DIR = tmp;
process.env.MIXR_CODEX_CONFIG = path.join(tmp, 'codex.toml');
process.env.MIXR_CLAUDE_SETTINGS = path.join(tmp, 'claude.json');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXR_RETRY_DELAY_MS = '0';
const router = require('../mixrouter');
const mock = createMockUpstream();
const summary = CODEX_COMPACT_PREFIX + '\n\nInclude:\n- Current progress and key decisions made';
const message = text => ({ role: 'user', content: [{ type: 'input_text', text }] });
let ui, proxy, base;
const request = async (server, endpoint, body, method = 'POST') => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
    method, headers: { 'content-type': 'application/json', 'session-id': 'shared-compact-session' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
};
const send = (input = [message(summary)], extra = {}, endpoint = '/v1/responses') =>
  request(proxy, endpoint, { model: 'mixr-main', input, stream: false, ...extra });
const select = (provider = 'shared', model = 'summary-model', key_id = '') =>
  request(ui, '/api/compact', { provider, model, key_id });
const preview = (kind = 'responses') => router.explainRoute({
  app: 'codex', model: 'mixr-main', kind, context: { compactTexts: [summary] },
});

before(async () => {
  await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${mock.server.address().port}`;
  ui = await router.listen(0, router.apiHandler);
  proxy = await router.listen(0, router.proxyHandler);
});
beforeEach(() => {
  router._state.store = {
    claude: [
      { id: 'shared', name: 'Shared', base_url: base, enabled: true, wire_api: 'responses',
        models: ['summary-model'], api_key: 'fixture-active', active_key: 'active',
        keys: [{ id: 'active', key: 'fixture-active' }, { id: 'summary', key: 'fixture-summary' }] },
      { id: 'other', name: 'Other', base_url: base, enabled: true, wire_api: 'responses',
        models: ['next-summary'], api_key: 'fixture-other' },
    ],
    codex: [{ id: 'main', name: 'Main', base_url: base, enabled: true, wire_api: 'responses',
      model: 'main-model', api_key: 'fixture-main' }],
  };
  router._state.slotMap = { claude: {}, codex: { main: { provider: 'main', model: 'main-model' } } };
  router._state.routes = { rules: COMPACT_RULES.map(spec => ({
    id: 'renamed-' + spec.kind, app: 'claude', enabled: true, priority: spec.priority,
    when: { body: spec.body }, provider: 'shared', model: 'summary-model', pool: [],
  })) };
  router._state.sessions.clear();
  router._state.resetPools();
  mock.requests.length = 0;
});
after(async () => {
  await Promise.all([ui, proxy, mock.server].map(server => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  })));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Codex signature is anchored; only the final input message can trigger local compaction', () => {
  assert.equal(isCodexCompactInstruction(summary), true);
  assert.equal(isCodexCompactInstruction('Quoted prompt:\n' + summary), false);
  assert.equal(isCodexCompactInstruction('You are performing a CONTEXT CHECKPOINT COMPACTION.'), false);
  assert.deepEqual(compactTexts({ input: [message(summary)] }, true), [summary]);
  assert.deepEqual(compactTexts({ input: summary }, true), [summary]);
  assert.deepEqual(compactTexts({ input: [message(summary), { type: 'function_call_output', output: 'done' }] }, true), []);
});

for (const wire of ['responses', 'chat']) test(`${wire}: Codex summary uses shared model; normal conversation and binding stay unchanged`, async () => {
  router._state.store.claude[0].wire_api = wire;
  assert.equal((await send('normal request')).status, 200);
  const session = router._state.sessions.get('cx:shared-compact-session');
  session.providerId = 'main'; session.model = 'main-model'; session.pinned = true;
  session.routing = { slots: { main: { provider: 'main', model: 'main-model' } },
    keys: { shared: 'missing-session-key' } };
  const slots = structuredClone(router._state.slotMap);
  const store = structuredClone(router._state.store);
  for (const stream of [false, true]) {
    const result = await send(undefined, { stream });
    assert.equal(result.status, 200, result.text);
    assert.match(result.text, /mock-echo:summary-model/);
    if (stream) assert.match(result.text, /response.completed/);
    assert.equal(result.headers.get('x-mixrouter-app'), 'codex');
    assert.equal(mock.requests.at(-1).body.model, 'summary-model');
    assert.equal(mock.requests.at(-1).url, wire === 'chat' ? '/v1/chat/completions' : '/v1/responses');
    assert.equal(session.providerId, 'main');
    assert.equal(session.pinned, true);
  }
  assert.equal((await send('continue normal request')).status, 200);
  assert.equal(mock.requests.at(-1).body.model, 'main-model');
  assert.deepEqual(router._state.slotMap, slots);
  assert.deepEqual(router._state.store, store);
  const p = preview();
  assert.equal(p.ok, true);
  assert.equal(p.matched.ruleId, 'renamed-global');
  assert.equal(p.selection.predicted.providerId, 'shared');
  assert.equal(p.selection.predicted.wire, wire);
});

test('one compact setting hot-updates Codex model and fixed key without changing slots or client config', async () => {
  const config = 'model = "mixr-main"\nmodel_auto_compact_token_limit = 400000\n';
  fs.writeFileSync(process.env.MIXR_CODEX_CONFIG, config);
  const slots = structuredClone(router._state.slotMap);
  assert.equal((await select('shared', 'summary-model', 'summary')).status, 200);
  assert.equal((await send()).status, 200);
  assert.equal(mock.requests.at(-1).headers.authorization, 'Bearer fixture-summary');
  assert.equal(router._state.store.claude[0].active_key, 'active');
  assert.equal(preview().selection.key_source, 'compact');
  assert.equal(preview().selection.key_id, 'summary');

  router._state.store.claude[0].keys[1].key = 'fixture-summary-updated';
  assert.equal((await send()).status, 200);
  assert.equal(mock.requests.at(-1).headers.authorization, 'Bearer fixture-summary-updated');
  assert.equal((await select('other', 'next-summary')).status, 200);
  assert.equal((await send()).status, 200);
  assert.equal(mock.requests.at(-1).body.model, 'next-summary');
  assert.equal(mock.requests.at(-1).headers.authorization, 'Bearer fixture-other');
  assert.deepEqual(router._state.slotMap, slots);
  assert.equal(fs.readFileSync(process.env.MIXR_CODEX_CONFIG, 'utf8'), config);
});

test('unfixed shared channel key is reloaded, rather than using a copied Codex provider', async () => {
  assert.equal((await send()).status, 200);
  router._state.store.claude[0] = { ...router._state.store.claude[0], api_key: 'fixture-current',
    active_key: 'current', keys: [{ id: 'current', key: 'fixture-current' }] };
  assert.equal((await send()).status, 200);
  assert.equal(mock.requests.at(-1).headers.authorization, 'Bearer fixture-current');
  assert.equal(router._state.store.codex.length, 1);
});

test('missing fixed summary key fails without falling back to main or the active account', async () => {
  await select('shared', 'summary-model', 'summary');
  router._state.store.claude[0].keys[1].enabled = false;
  const result = await send();
  assert.equal(result.status, 503);
  assert.equal(JSON.parse(result.text).error.code, 'provider_key_unavailable_error');
  assert.equal(mock.requests.length, 0);
  assert.equal(preview().error.code, 'provider_key_unavailable_error');
});

test('quoted prompts, history, system text and tool results do not divert normal requests', async () => {
  for (const input of [
    'Please explain:\n' + summary,
    [message(summary), { role: 'assistant', content: [] }, message('continue')],
    [{ type: 'function_call_output', call_id: 'call_fixture', output: summary }],
    [message(summary), { type: 'function_call_output', call_id: 'call_fixture', output: 'done' }],
    [{ role: 'user', content: [{ type: 'tool_result', content: summary }] }],
  ]) {
    const result = await send(input, { instructions: summary });
    assert.equal(result.status, 200, result.text);
    assert.equal(mock.requests.at(-1).body.model, 'main-model');
  }
});

test('native compact shares the selection but preserves the original endpoint and input', async () => {
  const input = [message('history without a compaction prompt')];
  const result = await send(input, { instructions: 'fixture' }, '/v1/responses/compact');
  assert.equal(result.status, 200, result.text);
  assert.equal(mock.requests.at(-1).url, '/v1/responses/compact');
  assert.equal(mock.requests.at(-1).body.model, 'summary-model');
  assert.deepEqual(mock.requests.at(-1).body.input, input);
  assert.equal(preview('responses/compact').selection.predicted.providerId, 'shared');
});

test('native compact on Chat and local compact on Anthropic fail explicitly', async () => {
  router._state.store.claude[0].wire_api = 'chat';
  const native = await send([], {}, '/v1/responses/compact');
  assert.equal(native.status, 501);
  assert.equal(preview('responses/compact').error.httpStatus, 501);
  router._state.store.claude[0].wire_api = 'anthropic';
  const local = await send();
  assert.equal(local.status, 400);
  assert.equal(JSON.parse(local.text).error.code, 'wire_api_mismatch_error');
  assert.equal(preview().error.code, 'wire_api_mismatch_error');
  assert.equal(mock.requests.length, 0);
});

test('without an enabled global compact rule, Codex retains its existing routing', async () => {
  router._state.routes.rules[0].enabled = false;
  assert.equal((await send()).status, 200);
  assert.equal(mock.requests.at(-1).body.model, 'main-model');
  router._state.routes.rules = [];
  assert.equal((await send([], {}, '/v1/responses/compact')).status, 200);
  assert.equal(mock.requests.at(-1).body.model, 'main-model');
});
