'use strict';
// 真HTTP loopback验证代理接线；独立数据目录，不读取本机渠道或启动常驻端口。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-response-integration-'));
process.env.MIXR_DATA_DIR = root;
process.env.MIXR_RESPONSE_ARCHIVE = 'on';
process.env.MIXR_RESPONSE_ARCHIVE_DIR = path.join(root, 'archive');
process.env.MIXR_CONV_RETRIES = '0';
process.env.MIXR_COOLDOWN_SEC = '0';
process.env.MIXR_CLAUDE_SETTINGS = path.join(root, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(root, 'config.toml');
const secret = 'fixture-private-credential';
const event = (name, value) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
const chatData = value => `data: ${JSON.stringify(value)}\n\n`;
function payload(wire, label) {
  if (wire === 'chat') return chatData({ id: label, choices: [{ index: 0,
    delta: { reasoning_content: label + ' thinking', content: 'answer' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
  if (wire === 'responses') return event('response.completed', { type: 'response.completed', response: {
    id: label, status: 'completed', output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: label + ' summary' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }], usage: {} } });
  return event('message_start', { type: 'message_start', message: { id: label, type: 'message', role: 'assistant', content: [], usage: {} } }) +
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: label + ' thinking' } }) +
    event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }) +
    event('message_stop', { type: 'message_stop' });
}
function request(port, endpoint, model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, stream: true, max_tokens: 32,
      messages: [{ role: 'user', content: 'fixture' }], input: 'fixture' });
    const req = http.request({ hostname: '127.0.0.1', port, path: endpoint, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}
async function archives() {
  const base = process.env.MIXR_RESPONSE_ARCHIVE_DIR;
  const files = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'metadata.json') files.push(p);
    }
  }
  walk(base);
  return files.map(p => ({ dir: path.dirname(p), metadata: JSON.parse(fs.readFileSync(p, 'utf8')) }));
}
async function waitForCount(count) {
  let rows;
  for (let i = 0; i < 200; i++) {
    rows = await archives();
    if (rows.length >= count && rows.every(r => r.metadata.finished_at)) return rows;
    await delay(20);
  }
  assert.fail(`archive finish timeout: expected ${count}, got ${rows.length}`);
}

test('所有协议及失败重试在公共响应入口归档，正文不混入请求日志', async t => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts));
      const model = body.model;
      if (model === 'retry-fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'upstream fixture ' + secret } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const wire = req.url.includes('chat/completions') ? 'chat' : req.url.includes('responses') ? 'responses' : 'anthropic';
      res.end(payload(wire, model));
    });
  });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const provider = (id, wire) => ({ id, name: id, base_url: base, api_key: secret, enabled: true, models: [], model: id, wire_api: wire });
  fs.mkdirSync(path.join(root, 'logs'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'providers.json'), JSON.stringify({ version: 2, current: {},
    claude: [provider('raw', 'anthropic'), provider('chat', 'chat'), provider('resp', 'responses')],
    codex: [provider('codex-chat', 'chat'), provider('codex-resp', 'responses')] }));
  const cases = [
    ['claude', 'case-raw', 'raw', '/v1/messages'],
    ['claude', 'case-chat', 'chat', '/v1/messages'],
    ['claude', 'case-resp', 'resp', '/v1/messages'],
    ['codex', 'case-codex-chat', 'codex-chat', '/v1/chat/completions'],
    ['codex', 'case-codex-resp', 'codex-resp', '/v1/responses'],
  ];
  fs.writeFileSync(path.join(root, 'routes.json'), JSON.stringify({ rules: [
    ...cases.map(([app, model, provider]) => ({ id: model, match: model, app, provider, model, enabled: true })),
    { id: 'retry', match: 'retry', app: 'claude', provider: 'raw', enabled: true, strategy: 'priority',
      pool: [{ provider: 'raw', model: 'retry-fail' }, { provider: 'chat', model: 'retry-success' }] },
  ], default: {} }));
  const mod = require('../mixrouter');
  const proxy = await mod.listen(0, mod.proxyHandler);
  t.after(() => { proxy.close(); upstream.close(); });
  for (const [, model, , endpoint] of cases) {
    const response = await request(proxy.address().port, endpoint, model);
    assert.equal(response.status, 200, response.text);
  }
  assert.equal((await request(proxy.address().port, '/v1/messages', 'retry')).status, 200);
  const rows = await waitForCount(7);
  assert.equal(rows.length, 7);
  const corpus = rows.map(r => fs.readdirSync(r.dir).filter(n => !n.endsWith('.tmp'))
    .map(n => fs.readFileSync(path.join(r.dir, n), 'utf8')).join('\n')).join('\n');
  assert.ok(!corpus.includes(secret));
  for (const [, label] of cases) assert.ok(corpus.includes(label), label);
  assert.ok(corpus.includes('retry-fail') && corpus.includes('retry-success'));
  const failed = rows.find(r => r.metadata.model === 'retry-fail');
  const recovered = rows.find(r => r.metadata.model === 'retry-success');
  assert.ok(failed && recovered, 'each attempt retains its model binding');
  assert.equal(failed.metadata.requestId, recovered.metadata.requestId);
  assert.equal(failed.metadata.attempt, 1);
  assert.equal(recovered.metadata.attempt, 2);
  assert.equal(failed.metadata.status, 500);
  assert.equal(failed.metadata.stream, false, 'HTTP JSON failure overrides the requested stream mode');
  assert.equal(recovered.metadata.state, 'complete');
  for (const [, label] of cases) {
    const row = rows.find(r => r.metadata.model === label);
    assert.ok(row, label + ' metadata');
    assert.equal(row.metadata.state, 'complete');
    assert.ok(fs.readFileSync(path.join(row.dir, 'returned-thinking.txt'), 'utf8').includes(label));
  }
  for (const row of rows) {
    assert.equal(fs.statSync(row.dir).mode & 0o777, 0o700);
    for (const f of fs.readdirSync(row.dir)) assert.equal(fs.statSync(path.join(row.dir, f)).mode & 0o777, 0o600);
  }
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(path.join(root, 'logs/requests.jsonl'))) break;
    await delay(10);
  }
  const logs = fs.readFileSync(path.join(root, 'logs/requests.jsonl'), 'utf8');
  assert.ok(!logs.includes('case-raw thinking') && !logs.includes('case-resp summary'));
});
