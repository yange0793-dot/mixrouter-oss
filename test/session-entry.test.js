'use strict';
// 代理入口回归:会话身份与会话粘性在**请求边界**上的行为(第二期拆分后仍不变的部分)。
//
//   1. 带会话头的两条并发对话各自粘住自己的渠道,互不串;
//   2. 槽位请求(模型名精确等于别名)落到槽位渠道,但**不**把主对话的绑定挪过去 ——
//      一条 haiku 起标题请求不该让下一条主模型请求跟着跑偏(缓存被打断,与 README 的承诺相反);
//   3. 会话快照只在入口取一次:同一条请求内的重试不会因为控制台改了路由而换渠道。
// 会话覆盖(Key/槽位)的写入接口与会话语义不在这里 —— 那是会话边界的独立交付,本文件不碰。
// 只用本地桩、临时数据目录与临时端口。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-session-entry-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_SSE_KEEPALIVE_MS = '0';
// 转换线(chat 上游)的同渠道重试配额:下面那条「在途快照」用例要它 >= 1
process.env.MIXR_CONV_RETRIES = '2';

let mod, upstream, proxy, ui;
const seen = [];
const frame = (type, data = { type }) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

function request(port, endpoint, body, session) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: endpoint, method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
        'x-claude-code-session-id': session || '' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(data);
  });
}
const ask = (session, model = 'big') => request(proxy.address().port, '/v1/messages',
  { model, stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }, session);

before(async () => {
  upstream = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      seen.push({ key: req.headers['x-api-key'], body: JSON.parse(Buffer.concat(parts).toString('utf8')) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(frame('message_start', { type: 'message_start', message: { usage: {} } }) + frame('message_stop'));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const base_url = `http://127.0.0.1:${upstream.address().port}`;
  const provider = (id, key, wire_api) => ({ id, name: id, base_url, wire_api, api_key: key + '-active', enabled: true,
    models: ['big'], keys: [{ id: 'k1', key: key + '-1' }, { id: 'k2', key: key + '-2' }] });
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({
    claude: [provider('a', 'sk-a', 'anthropic'), provider('b', 'sk-b', 'anthropic'), provider('conv', 'sk-conv', 'chat')], codex: [] }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({ rules: [
    { id: 'r-main', app: 'claude', match: 'big', provider: 'a', model: 'up-a', enabled: true },
    { id: 'r-conv', app: 'claude', match: 'converted-model', provider: 'conv', model: 'up-conv', enabled: true }], default: {} }));
  fs.writeFileSync(path.join(TMP, 'slots.json'), JSON.stringify({ version: 1,
    claude: { haiku: { provider: 'b', model: 'up-b' } }, codex: {} }));
  mod = require('../mixrouter');
  proxy = await mod.listen(0, mod.proxyHandler);
  ui = await mod.listen(0, mod.apiHandler);
});
after(async () => {
  await Promise.all([proxy, ui, upstream].filter(Boolean).map(s => new Promise(res => {
    s.closeAllConnections(); s.close(res);
  })));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('两条会话各自粘性;槽位请求不污染主对话绑定', async () => {
  assert.equal((await ask('s-one')).status, 200);
  assert.equal((await ask('s-two')).status, 200);
  assert.equal(seen[0].body.model, 'up-a');
  assert.equal(seen[1].body.model, 'up-a');
  // 槽位请求:模型名精确等于别名 → 落到槽位渠道的模型
  const slot = await ask('s-one', 'mixr-haiku');
  assert.equal(slot.status, 200, slot.text);
  assert.equal(seen[2].body.model, 'up-b');
  assert.equal(seen[2].key, 'sk-b-active', '槽位请求走槽位绑定的渠道');
  // 之后同一对话的主模型请求必须还走原渠道(槽位请求不改本会话绑定)
  assert.equal((await ask('s-one')).status, 200);
  assert.equal(seen[3].body.model, 'up-a', '槽位请求不得把主对话挪到槽位渠道');
  assert.equal(seen[3].key, 'sk-a-active');
  // 控制台看得到两条会话,各自的绑定都是规则渠道(槽位请求没有改绑)
  const rows = JSON.parse((await request(ui.address().port, '/api/sessions')).text).sessions;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const bound = row.bound || { provider: row.provider };
    assert.equal(bound.provider, 'a', `会话 ${row.key} 应当仍绑在规则渠道上`);
    assert.equal(bound.model, 'up-a', '槽位请求不得把主对话的落点模型改掉');
    assert.equal(bound.pinned, false, '自动粘性不是手动钉定');
  }
});

test('在途请求用入口快照:同渠道重试不因控制台中途改路由而换渠道', async () => {
  let attempt = 0;
  const before = seen.length;
  const original = upstream.listeners('request');
  upstream.removeAllListeners('request');
  upstream.on('request', (req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      attempt++;
      seen.push({ key: req.headers['x-api-key'] || req.headers.authorization,
        body: JSON.parse(Buffer.concat(parts).toString('utf8')) });
      if (attempt === 1) {
        // 第一发 5xx:代理会在同一渠道内重试(claude 转换线走 CONV_RETRIES 配额)。
        // 趁这一刻把路由改成另一条渠道 —— 在途请求不该跟过去。
        mod._state.routes = { rules: [
          { id: 'r-main', app: 'claude', match: 'big', provider: 'b', model: 'up-b', enabled: true }], default: {} };
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'fixture 500' } }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(frame('message_start', { type: 'message_start', message: { usage: {} } }) + frame('message_stop'));
    });
  });
  try {
    const r = await ask('s-retry', 'converted-model');
    assert.equal(r.status, 200, r.text);
    assert.equal(attempt, 3, '同渠道重试两次(第一次 500 后换 cache 代际重打,第二次才成功)');
    assert.equal(seen[before].body.model, 'up-conv');
    assert.equal(seen[before + 1].body.model, 'up-conv', '在途请求用入口快照,不跟控制台中途的改动跑');
    // chat 上游走 OpenAI 头:凭据在 Authorization 里(Bearer 前缀)
    assert.match(seen[before].key, /sk-conv-active$/);
    assert.match(seen[before + 1].key, /sk-conv-active$/, '重试仍在原渠道(换 cache 代际,不换账号)');
    assert.equal(seen[before + 1].body.model, 'up-conv', '重试仍在原渠道的模型上');
  } finally {
    upstream.removeAllListeners('request');
    for (const listener of original) upstream.on('request', listener);
    mod._state.routes = { rules: [
      { id: 'r-main', app: 'claude', match: 'big', provider: 'a', model: 'up-a', enabled: true },
      { id: 'r-conv', app: 'claude', match: 'converted-model', provider: 'conv', model: 'up-conv', enabled: true }], default: {} };
  }
});
