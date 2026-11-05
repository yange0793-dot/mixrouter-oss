'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockUpstream } = require('./mock-upstream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-tool-media-'));
process.env.MIXR_DATA_DIR = tmp;
process.env.MIXR_CODEX_CONFIG = path.join(tmp, 'codex.toml');
process.env.MIXR_CLAUDE_SETTINGS = path.join(tmp, 'claude.json');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
const router = require('../mixrouter');
const mock = createMockUpstream();
const images = ['data:image/png;base64,AA', 'https://example.invalid/screenshot.jpg'];
let proxy;

before(async () => {
  await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve));
  const base_url = `http://127.0.0.1:${mock.server.address().port}`;
  router._state.store = {
    claude: [{ id: 'anthropic-chat', name: 'fixture', base_url, enabled: true,
      api_key: 'fixture', wire_api: 'chat', models: ['fixture-claude'] }],
    codex: [
      { id: 'codex-chat', name: 'fixture', base_url, enabled: true,
        api_key: 'fixture', wire_api: 'chat', model: 'fixture-codex' },
      { id: 'native', name: 'fixture native', base_url, enabled: true,
        api_key: 'fixture', wire_api: 'responses', model: 'fixture-native' },
    ],
  };
  router._state.routes = { rules: [] };
  router._state.slotMap = { claude: { main: { provider: 'anthropic-chat', model: 'fixture-claude' } },
    codex: { main: { provider: 'codex-chat', model: 'fixture-codex' } } };
  router._state.resetPools();
  proxy = await router.listen(0, router.proxyHandler);
});

after(async () => {
  await Promise.all([proxy, mock.server].map(server => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  })));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function send(endpoint, body) {
  const res = await fetch(`http://127.0.0.1:${proxy.address().port}${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'session-id': 'fixture-tool-media' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  if (body.stream) assert.match(text, /response.completed|message_stop/);
  return mock.requests.at(-1);
}

function checkChat(body) {
  const calls = body.messages.find(message => message.tool_calls);
  assert.deepEqual(calls.tool_calls.map(call => call.id), ['c1', 'c2']);
  const start = body.messages.indexOf(calls);
  assert.deepEqual(body.messages.slice(start + 1, start + 3).map(message => message.role), ['tool', 'tool']);
  assert.deepEqual(body.messages.slice(start + 1, start + 3).map(message => message.tool_call_id), ['c1', 'c2']);
  assert.match(body.messages[start + 1].content, /first result/);
  const parts = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
  assert.deepEqual(parts.filter(part => part.type === 'image_url').map(part => part.image_url.url), images);
  for (const message of body.messages) {
    if (typeof message.content === 'string') assert.doesNotMatch(message.content, /data:image|screenshot\.jpg/);
    else for (const part of message.content) if (part.type === 'text') assert.doesNotMatch(part.text, /data:image/);
  }
}

for (const stream of [false, true]) test(`Responses tool images stay multimodal through Chat conversion (stream=${stream})`, async () => {
  const input = [
    { role: 'user', content: 'inspect screenshots' },
    { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
    { type: 'function_call', call_id: 'c2', name: 'inspect', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: [
      { type: 'input_text', text: 'first result' }, { type: 'input_image', image_url: images[0] },
    ] },
    { type: 'function_call_output', call_id: 'c2', output: [
      { type: 'input_image', image_url: images[1] },
    ] },
    { role: 'user', content: 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.' },
  ];
  const original = structuredClone(input);
  const hit = await send('/v1/responses', { model: 'mixr-main', stream, input });
  assert.equal(hit.url, '/v1/chat/completions');
  checkChat(hit.body);
  assert.deepEqual(input, original);
});

test('Anthropic parallel tool images retain pair ordering through Chat conversion', async () => {
  const hit = await send('/v1/messages', { model: 'mixr-main', stream: true, max_tokens: 1024, messages: [
    { role: 'user', content: 'inspect screenshots' },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'c1', name: 'inspect', input: {} },
      { type: 'tool_use', id: 'c2', name: 'inspect', input: {} },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'c1', content: [
        { type: 'text', text: 'first result' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
      ] },
      { type: 'tool_result', tool_use_id: 'c2', content: [
        { type: 'image', source: { type: 'url', url: images[1] } },
      ] },
    ] },
  ] });
  assert.equal(hit.url, '/v1/chat/completions');
  checkChat(hit.body);
});

test('native Responses retains structured tool image results without Chat conversion', async () => {
  const input = [
    { role: 'user', content: 'inspect screenshots' },
    { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: [
      { type: 'input_text', text: 'first result' }, { type: 'input_image', image_url: images[0] },
    ] },
  ];
  const hit = await send('/v1/responses', { model: 'fixture-native', stream: true, input });
  assert.equal(hit.url, '/v1/responses');
  assert.deepEqual(hit.body.input, input);
});
