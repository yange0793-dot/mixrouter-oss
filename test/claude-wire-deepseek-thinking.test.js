'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApplication } = require('../lib/application');

test('Claude Chat forwarding preserves real reasoning through a strict tools-history upstream', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-thinking-'));
  const hits = [], servers = [];
  t.after(async () => {
    for (const server of servers) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    hits.push(body);
    if (body.tools?.length && body.messages.some(message => message.role === 'assistant' && !message.reasoning_content)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'The reasoning_content in the thinking mode must be passed back to the API' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: body.model,
      choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  servers.push(upstream);
  const app = createApplication({ root: path.resolve(__dirname, '..'), version: 'test', home: root,
    env: { MIXR_DATA_DIR: root, MIXROUTER_PORT: '0', MIXUI_PORT: '0', MIXR_MAX_ATTEMPTS: '1' } });
  app._state.store = { claude: [{ id: 'local', name: 'local', wire_api: 'chat', enabled: true,
    api_key: 'fixture', base_url: `http://127.0.0.1:${upstream.address().port}`, models: ['deepseek-v4.1-flash'] }], codex: [] };
  app._state.slotMap = { claude: { main: { provider: 'local', model: 'deepseek-v4.1-flash' } }, codex: {} };
  const proxy = await app.listen(0, app.proxyHandler);
  servers.push(proxy);
  const body = {
    model: 'mixr-main', max_tokens: 32,
    tools: [{ name: 'read', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: 'Read the fixture.' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Need the fixture value.', signature: 'private-signature' },
        { type: 'tool_use', id: 'tool_one', name: 'read', input: {} },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_one', content: '42' }] },
    ],
  };
  for (const stream of [false, true]) {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stream }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(text, /OK/);
    if (stream) assert.match(text, /message_stop/);
    const request = hits.at(-1);
    assert.equal(request.messages[1].reasoning_content, 'Need the fixture value.');
    assert.deepEqual(request.messages.map(message => message.role), ['user', 'assistant', 'tool']);
    assert.equal(JSON.stringify(request).includes('private-signature'), false);
    const oldShape = structuredClone(request);
    delete oldShape.messages[1].reasoning_content;
    const rejected = await fetch(`http://127.0.0.1:${upstream.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(oldShape),
    });
    assert.equal(rejected.status, 400, 'the fixture must reject the pre-fix loss of reasoning');
    await rejected.text();
  }
});
