'use strict';
// Real loopback HTTP, temporary configuration, and the shared fake upstream.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createMockUpstream } = require('./mock-upstream');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-image-slim-'));
const FILE = path.join(TMP, 'image-slim.json');
const DEFAULTS = { enabled: false, keep_last: 0, keep_last_turns: 1, min_bytes: 8192, attachments: true };
const ZERO = { requests: 0, images_removed: 0, bytes_saved: 0 };
Object.assign(process.env, {
  MIXR_DATA_DIR: TMP, MIXR_CLAUDE_SETTINGS: path.join(TMP, 'settings.json'),
  MIXR_CODEX_CONFIG: path.join(TMP, 'config.toml'), MIXR_RESPONSE_ARCHIVE: 'off',
  MIXR_UPSTREAM_PROXY: '', MIXR_MAX_ATTEMPTS: '3', MIXR_CONV_RETRIES: '1',
  MIXR_RETRY_DELAY_MS: '0', MIXR_SSE_KEEPALIVE_MS: '0', MIXROUTER_PORT: '0', MIXUI_PORT: '0',
});

const ROUTES = [
  { name: 'Claude native', format: 'anthropic', wire: 'anthropic', model: 'slim-claude', endpoint: '/v1/messages' },
  { name: 'Claude to Responses', format: 'anthropic', wire: 'responses', model: 'slim-claude-responses', endpoint: '/v1/messages' },
  { name: 'Claude to Chat', format: 'anthropic', wire: 'chat', model: 'slim-claude-chat', endpoint: '/v1/messages' },
  { name: 'Codex native Responses', format: 'responses', wire: 'responses', model: 'slim-responses', endpoint: '/v1/responses' },
  { name: 'Codex Responses to Chat', format: 'responses', wire: 'chat', model: 'slim-responses-chat', endpoint: '/v1/responses' },
  { name: 'Chat native', format: 'chat', wire: 'chat', model: 'slim-chat', endpoint: '/v1/chat/completions' },
];
const TURNS = [
  { name: 'old', tools: ['old-tool'] },
  { name: 'previous', tools: ['previous-tool-one', 'previous-tool-two'] },
  { name: 'current', tools: ['current-tool'] },
];
const IMAGE_NAMES = TURNS.flatMap(turn => [turn.name + '-user', ...turn.tools]);
const PAYLOADS = Object.fromEntries(IMAGE_NAMES.map((name, index) =>
  [name, Buffer.alloc(7000, 65 + index).toString('base64')]));
const SMALL = Buffer.alloc(24, 90).toString('base64');
const REMOTE = 'http://127.0.0.1:9/image-must-not-be-fetched.png';
const SCHEMA = { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] };
const CALLS = TURNS.flatMap(turn => turn.tools.map(name =>
  ({ id: 'call-' + name, name: 'Read', input: { file: name + '.png' } })));
const TEXTS = ['system-preserved', ...TURNS.flatMap(turn => [
  turn.name + '-user-text', ...turn.tools.flatMap(name => [name + '-thinking', name + '-result']),
  ...(turn.name === 'current' ? [] : [turn.name + '-done']),
])];

function history(format, model) {
  const text = (value, role = 'user') => ({
    type: format === 'responses' ? (role === 'assistant' ? 'output_text' : 'input_text') : 'text', text: value,
  });
  const image = (payload, remote = false) => format === 'anthropic'
    ? { type: 'image', source: remote ? { type: 'url', url: payload }
      : { type: 'base64', media_type: 'image/png', data: payload } }
    : format === 'responses'
      ? { type: 'input_image', image_url: remote ? payload : `data:image/png;base64,${payload}` }
      : { type: 'image_url', image_url: { url: remote ? payload : `data:image/png;base64,${payload}` } };
  const messages = [];
  for (const turn of TURNS) {
    const content = [text(turn.name + '-user-text'), image(PAYLOADS[turn.name + '-user'])];
    if (turn.name === 'old') {
      content.push(image(SMALL), image(REMOTE, true));
      if (format === 'responses') content.push({ type: 'input_image', file_id: 'file-preserved' });
    }
    messages.push({ role: 'user', content });
    for (const name of turn.tools) {
      const id = 'call-' + name, input = { file: name + '.png' };
      const output = [text(name + '-result'), image(PAYLOADS[name])];
      if (format === 'anthropic') {
        messages.push({ role: 'assistant', content: [text(name + '-thinking', 'assistant'),
          { type: 'tool_use', id, name: 'Read', input }] });
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] });
      } else if (format === 'responses') {
        messages.push({ role: 'assistant', content: [text(name + '-thinking', 'assistant')] },
          { type: 'function_call', call_id: id, name: 'Read', arguments: JSON.stringify(input) },
          { type: 'function_call_output', call_id: id, output });
      } else {
        messages.push({ role: 'assistant', content: name + '-thinking',
          tool_calls: [{ id, type: 'function', function: { name: 'Read', arguments: JSON.stringify(input) } }] });
        messages.push({ role: 'tool', tool_call_id: id, content: output });
      }
    }
    // End on a tool result in the current turn, not on a new user question.
    if (turn.name !== 'current') messages.push({ role: 'assistant', content: turn.name + '-done' });
  }
  if (format === 'responses') return { model, stream: false, instructions: 'system-preserved',
    tools: [{ type: 'function', name: 'Read', parameters: SCHEMA, strict: false }], input: messages };
  if (format === 'chat') return { model, stream: false,
    tools: [{ type: 'function', function: { name: 'Read', parameters: SCHEMA } }],
    messages: [{ role: 'system', content: 'system-preserved' }, ...messages] };
  return { model, max_tokens: 64, stream: false, system: 'system-preserved',
    tools: [{ name: 'Read', input_schema: SCHEMA }], messages };
}

const mock = createMockUpstream();
const rawBodies = [];
let app, proxy, ui;
function request(server, method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: url, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
        connection: 'close', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('image-slim fixture HTTP timeout')));
    req.end(data);
  });
}
async function imageSlim(patch) {
  const result = await request(ui, patch === undefined ? 'GET' : 'PUT', '/api/image-slim', patch);
  assert.equal(result.status, 200, result.text);
  return JSON.parse(result.text);
}
async function lastLog(model) {
  const result = await request(ui, 'GET', '/api/logs?model=' + encodeURIComponent(model));
  assert.equal(result.status, 200, result.text);
  return JSON.parse(result.text).logs[0];
}
function assertHistory(body, wire, removed) {
  const serialized = JSON.stringify(body);
  for (const name of IMAGE_NAMES)
    assert.equal(serialized.includes(PAYLOADS[name]), !removed.includes(name), `${name}: inline payload retention`);
  assert.ok(serialized.includes(SMALL), 'small inline images remain');
  assert.ok(serialized.includes(REMOTE), 'remote image references remain');
  for (const value of TEXTS) assert.ok(serialized.includes(value), `text preserved: ${value}`);

  let calls, results, tool;
  if (wire === 'anthropic') {
    const blocks = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    calls = blocks.filter(block => block.type === 'tool_use').map(({ id, name, input }) => ({ id, name, input }));
    results = blocks.filter(block => block.type === 'tool_result').map(block => block.tool_use_id);
    tool = { name: body.tools[0].name, parameters: body.tools[0].input_schema };
  } else if (wire === 'responses') {
    calls = body.input.filter(item => item.type === 'function_call')
      .map(item => ({ id: item.call_id, name: item.name, input: JSON.parse(item.arguments) }));
    results = body.input.filter(item => item.type === 'function_call_output').map(item => item.call_id);
    tool = { name: body.tools[0].name, parameters: body.tools[0].parameters };
  } else {
    calls = body.messages.flatMap(message => message.tool_calls || [])
      .map(call => ({ id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }));
    results = body.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id);
    tool = { name: body.tools[0].function.name, parameters: body.tools[0].function.parameters };
  }
  assert.deepEqual(calls, CALLS);
  assert.deepEqual(results, CALLS.map(call => call.id));
  assert.deepEqual(tool, { name: 'Read', parameters: SCHEMA });
}

before(async () => {
  mock.server.prependListener('request', req => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => rawBodies.push(Buffer.concat(chunks)));
  });
  await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve));
  const provider = route => ({ id: route.model, name: route.model, enabled: true, wire_api: route.wire,
    api_key: 'synthetic-image-slim-key', models: [route.model], model: route.model,
    base_url: `http://127.0.0.1:${mock.server.address().port}` });
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({
    version: 2, current: { claude: null, codex: null },
    claude: ROUTES.filter(route => route.format === 'anthropic').map(provider),
    codex: ROUTES.filter(route => route.format !== 'anthropic').map(provider),
  }));
  fs.writeFileSync(path.join(TMP, 'settings.json'), '{"fixture":"unchanged"}');
  fs.writeFileSync(path.join(TMP, 'config.toml'), 'model = "unchanged"\n');
  const { createApplication } = require('../lib/application');
  app = createApplication({ root: ROOT, version: 'image-slim-test', home: TMP });
  proxy = await app.listen(0, app.proxyHandler);
  ui = await app.listen(0, app.apiHandler);
});
beforeEach(() => {
  mock.requests.length = 0;
  rawBodies.length = 0;
  mock.setSseWrappedError(503, 'unused', 0);
  app._state.sessions.clear();
  app._state.resetPools();
});
after(async () => {
  require('../lib/upstream-proxy').destroyAgents();
  await Promise.all([proxy, ui, mock.server].filter(Boolean).map(server => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  })));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('GET image-slim returns disabled defaults and zero stats without creating configuration', async () => {
  assert.deepEqual(await imageSlim(), { settings: DEFAULTS, stats: ZERO });
  assert.equal(fs.existsSync(FILE), false);
});

for (const route of [...ROUTES,
  { ...ROUTES[0], name: 'Claude count_tokens', endpoint: '/v1/messages/count_tokens' },
  { ...ROUTES[3], name: 'Codex compact', endpoint: '/v1/responses/compact' },
]) test(`${route.name}: disabled preserves images; enabled slims before forwarding/conversion`, async () => {
  const initial = await imageSlim(DEFAULTS);
  const body = history(route.format, route.model);
  if (route.endpoint.endsWith('count_tokens') || route.endpoint.endsWith('compact')) delete body.stream;
  const disabled = await request(proxy, 'POST', route.endpoint, body);
  assert.equal(disabled.status, 200, disabled.text);
  assert.equal(mock.requests.length, 1);
  assertHistory(mock.requests[0].body, route.wire, []);
  assert.deepEqual((await imageSlim()).stats, initial.stats, 'disabled requests do not change counters');
  if (route.format === route.wire) {
    assert.deepEqual(mock.requests[0].body,
      route.endpoint === '/v1/messages' ? { ...body, stream: true } : body);
  }

  await imageSlim({ enabled: true });
  const enabled = await request(proxy, 'POST', route.endpoint, body);
  assert.equal(enabled.status, 200, enabled.text);
  assert.equal(mock.requests.length, 2);
  const received = mock.requests[1];
  const expectedPath = route.wire === 'chat' ? '/v1/chat/completions'
    : route.wire === 'responses' && route.endpoint === '/v1/messages' ? '/v1/responses' : route.endpoint;
  assert.equal(received.url, expectedPath);
  assert.equal(received.body.model, body.model);
  assertHistory(received.body, route.wire, ['old-user', 'old-tool']);
  if (route.format === 'responses' && route.wire === 'responses')
    assert.ok(JSON.stringify(received.body).includes('"file_id":"file-preserved"'));
  const stats = (await imageSlim()).stats;
  assert.equal(stats.requests - initial.stats.requests, 1);
  assert.equal(stats.images_removed - initial.stats.images_removed, 2);
  assert.ok(stats.bytes_saved > initial.stats.bytes_saved);
  const log = await lastLog(body.model);
  assert.equal(log.images_removed, 2);
  assert.equal(log.image_bytes_saved, stats.bytes_saved - initial.stats.bytes_saved);
  assert.equal(log.bytes_in, Buffer.byteLength(JSON.stringify(body)), 'upload accounting retains the original byte count');
  if (route.format === route.wire)
    assert.equal(log.image_bytes_saved, rawBodies[0].length - rawBodies[1].length, 'logged savings match actual upstream bytes');
});

test('count_tokens 在转换线上按精简后的体积估算', async () => {
  await imageSlim({ ...DEFAULTS, enabled: true });
  const route = { ...ROUTES[1], endpoint: '/v1/messages/count_tokens' };   // Claude → Responses
  const body = history('anthropic', route.model);
  delete body.stream;
  const before = mock.requests.length;
  const response = await request(proxy, 'POST', route.endpoint, body);
  assert.equal(response.status, 200, response.text);
  assert.equal(mock.requests.length, before, '转换线 count_tokens 不打上游');
  const { slimImages } = require('../lib/image-slim');
  const slimmed = JSON.parse(JSON.stringify(body));
  slimImages(slimmed, 'anthropic', { ...DEFAULTS, enabled: true });
  const expected = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(slimmed)) / 4));
  const estimated = JSON.parse(response.text).input_tokens;
  assert.equal(estimated, expected, '按出站(精简后)体积估算');
  assert.ok(estimated < Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4),
    '已经替换掉的图片字节不能算进 input_tokens');
});

test('keep_last unions with protected turns; zero completed turns still protects the whole current turn', async () => {
  const route = ROUTES[3], body = history(route.format, route.model);
  for (const [patch, removed] of [
    [{ keep_last: 1 }, ['old-user', 'old-tool']],
    [{ keep_last: 6 }, ['old-user']],
    [{ keep_last: 8 }, []],
    [{ keep_last_turns: 0 }, ['old-user', 'old-tool', 'previous-user', 'previous-tool-one', 'previous-tool-two']],
  ]) {
    const before = await imageSlim({ ...DEFAULTS, enabled: true, ...patch });
    const result = await request(proxy, 'POST', route.endpoint, body);
    assert.equal(result.status, 200, result.text);
    assertHistory(mock.requests.at(-1).body, route.wire, removed);
    const after = await imageSlim();
    assert.equal(after.stats.images_removed - before.stats.images_removed, removed.length);
    assert.equal(after.stats.requests - before.stats.requests, removed.length ? 1 : 0);
    if (!removed.length) assert.deepEqual(after.stats, before.stats);
  }
});

test('attachments=false preserves message images while historical tool images are still slimmed', async () => {
  for (const route of [ROUTES[0], ROUTES[3], ROUTES[5]]) {
    const before = await imageSlim({ ...DEFAULTS, enabled: true, attachments: false });
    const result = await request(proxy, 'POST', route.endpoint, history(route.format, route.model));
    assert.equal(result.status, 200, result.text);
    assertHistory(mock.requests.at(-1).body, route.wire, ['old-tool']);
    assert.equal((await imageSlim()).stats.images_removed - before.stats.images_removed, 1);
  }
});

test('min_bytes measures the inline payload, excluding the data URL prefix and JSON wrapper', async () => {
  const route = ROUTES[3], body = history(route.format, route.model);
  const atLimit = Buffer.alloc(6144, 120).toString('base64');
  const belowLimit = Buffer.alloc(6141, 121).toString('base64');
  assert.equal(atLimit.length, DEFAULTS.min_bytes);
  assert.ok(belowLimit.length < DEFAULTS.min_bytes);
  assert.ok(`data:image/png;base64,${belowLimit}`.length > DEFAULTS.min_bytes);
  body.input[0].content[1].image_url = `data:image/png;base64,${atLimit}`;
  body.input.find(item => item.type === 'function_call_output').output[1].image_url = `data:image/png;base64,${belowLimit}`;
  const before = await imageSlim({ ...DEFAULTS, enabled: true });
  const result = await request(proxy, 'POST', route.endpoint, body);
  assert.equal(result.status, 200, result.text);
  const sent = JSON.stringify(mock.requests[0].body);
  assert.equal(sent.includes(atLimit), false, 'payload at the threshold is eligible');
  assert.equal(sent.includes(belowLimit), true, 'wrapper overhead does not make a small payload eligible');
  assert.equal((await imageSlim()).stats.images_removed - before.stats.images_removed, 1);
});

for (const route of [ROUTES[2], ROUTES[3]]) test(`${route.name}: retry reuses identical slimmed bytes and counts once`, async () => {
  const before = await imageSlim({ ...DEFAULTS, enabled: true });
  mock.setSseWrappedError(503, 'synthetic transient failure', 1);
  const result = await request(proxy, 'POST', route.endpoint, history(route.format, route.model));
  assert.equal(result.status, 200, result.text);
  assert.equal(mock.requests.length, 2);
  assertHistory(mock.requests[0].body, route.wire, ['old-user', 'old-tool']);
  assert.ok(rawBodies[0].equals(rawBodies[1]), 'retries must reuse the same outbound request bytes');
  const stats = (await imageSlim()).stats;
  const log = await lastLog(route.model);
  assert.equal(stats.requests - before.stats.requests, 1);
  assert.equal(stats.images_removed - before.stats.images_removed, 2);
  assert.equal(log.attempts, 2);
  assert.equal(log.images_removed, 2);
  assert.equal(log.image_bytes_saved, stats.bytes_saved - before.stats.bytes_saved);
});

test('routing rejection happens before slimming and does not change counters', async () => {
  const before = await imageSlim({ ...DEFAULTS, enabled: true });
  const result = await request(proxy, 'POST', '/v1/messages', history('anthropic', 'unregistered-image-model'));
  assert.equal(result.status, 503, result.text);
  assert.equal(mock.requests.length, 0);
  assert.deepEqual((await imageSlim()).stats, before.stats);
});

test('PUT is a strict atomic partial patch and invalid requests leave memory and disk unchanged', async () => {
  const before = await imageSlim({ ...DEFAULTS, enabled: true, keep_last: 2 });
  const patched = await imageSlim({ min_bytes: 1024, attachments: false });
  assert.deepEqual(patched.settings, { ...before.settings, min_bytes: 1024, attachments: false });
  assert.deepEqual(patched.stats, before.stats);
  assert.deepEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')), patched.settings);
  assert.deepEqual(await imageSlim({}), patched);
  const saved = fs.readFileSync(FILE, 'utf8');
  for (const invalid of [null, [], true, '{broken', { enabled: 'true' }, { attachments: 0 },
    { keep_last: -1 }, { keep_last: 1001 }, { keep_last_turns: 1.5 }, { min_bytes: '8192' },
    { min_bytes: -1 }, { unknown: true }, { enabled: false, keep_last: -1 }]) {
    const result = await request(ui, 'PUT', '/api/image-slim', invalid);
    assert.equal(result.status, 400, `invalid patch ${JSON.stringify(invalid)}: ${result.text}`);
    assert.equal(fs.readFileSync(FILE, 'utf8'), saved);
    assert.deepEqual(await imageSlim(), patched);
  }
});

test('image-slim API and proxy retain Host, cross-site and content-type gates', async () => {
  const before = await imageSlim({ ...DEFAULTS, enabled: true });
  const saved = fs.readFileSync(FILE, 'utf8');
  const body = history('anthropic', ROUTES[0].model);
  for (const [headers, status] of [
    [{ host: 'outside.invalid' }, 403],
    [{ origin: 'https://outside.invalid' }, 403],
    [{ 'sec-fetch-site': 'cross-site' }, 403],
    [{ 'content-type': 'text/plain' }, 415],
  ]) {
    assert.equal((await request(ui, 'PUT', '/api/image-slim', { enabled: false }, headers)).status, status);
    assert.equal((await request(proxy, 'POST', '/v1/messages', body, headers)).status, status);
  }
  assert.equal((await request(ui, 'GET', '/api/image-slim', undefined, { host: 'outside.invalid' })).status, 403);
  assert.equal(fs.readFileSync(FILE, 'utf8'), saved);
  assert.deepEqual(await imageSlim(), before);
  assert.equal(mock.requests.length, 0);
});

test('saved settings load in a fresh process; runtime stats reset and client files remain unchanged', async () => {
  const before = await imageSlim({ ...DEFAULTS, enabled: true });
  const result = await request(proxy, 'POST', '/v1/responses', history('responses', ROUTES[3].model));
  assert.equal(result.status, 200, result.text);
  const saved = await imageSlim({ enabled: true, keep_last: 3, keep_last_turns: 2, min_bytes: 2048, attachments: false });
  assert.equal(saved.stats.requests - before.stats.requests, 1);
  const persisted = fs.readFileSync(FILE, 'utf8');
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', `
    const http = require('node:http');
    const { createApplication } = require('./lib/application');
    const app = createApplication({ root: process.cwd(), version: 'image-slim-restart',
      home: process.env.MIXR_DATA_DIR });
    app.listen(0, app.apiHandler).then(server => {
      const req = http.get({ hostname: '127.0.0.1', port: server.address().port,
        path: '/api/image-slim', agent: false }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
          process.stdout.write(JSON.stringify({ status: res.statusCode, body: JSON.parse(text) }));
          server.close();
        });
      });
      req.on('error', error => { console.error(error); process.exitCode = 1; server.close(); });
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: ROOT, env: process.env, timeout: 5000 });
  assert.deepEqual(JSON.parse(stdout), { status: 200, body: { settings: saved.settings, stats: ZERO } });
  assert.equal(fs.readFileSync(FILE, 'utf8'), persisted);
  assert.deepEqual(await imageSlim(), saved, 'a separate process cannot reset the running instance counters');
  assert.equal(fs.readFileSync(path.join(TMP, 'settings.json'), 'utf8'), '{"fixture":"unchanged"}');
  assert.equal(fs.readFileSync(path.join(TMP, 'config.toml'), 'utf8'), 'model = "unchanged"\n');
});
