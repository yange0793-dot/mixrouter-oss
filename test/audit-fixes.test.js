'use strict';
// AUDIT-2026-09-17.md 七条发现的行为回归。每条都钉住"以前真的会出事"的那个方向:
//   P1-1 整包 Responses JSON 丢思考 → 上游忽略 stream 直回 JSON 时,下一轮回传缺 reasoning_text
//   P1-2 渠道 PUT 校验失败仍污染内存配置 → 400 之后下一次保存把被拒的改动一起落盘
//   P1-3 Codex 切换把合法 TOML 写成重复键 → 带缩进的顶层键匹配不上,追加出重复键
//   P2-1 正常正文里的错误文案被当成上游错误 → 排查这类报错的对话被误杀/重复请求
//   P2-2 总超时不覆盖"未收齐响应头"阶段 → 持续补头字节的 upstream 能越过总预算
//   P2-3 同渠道重试不计入 attempts → 日志低报真实上游调用数
//   P2-4 字符串 input 绕过内容路由 → 同一句话写成数组能命中,写成字符串命不中
// 全部走本地桩,不连真实上游、不碰真实配置。
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-audit-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_TOTAL_DEADLINE_MS = '1000';
process.env.MIXR_FIRST_HEADER_TIMEOUT_MS = '8000';       // 会被总 deadline 夹到 1000
process.env.MIXR_STREAM_FIRST_HEADER_TIMEOUT_MS = '8000'; // 同上:本文件要验的是总预算,不是首字节那一档
process.env.MIXR_NONSTREAM_TOTAL_TIMEOUT_MS = '8000';
process.env.MIXR_STREAM_IDLE_TIMEOUT_MS = '8000';
process.env.MIXR_RETRY_DELAY_MS = '0'; // 重试间隔在测试里没有意义,只会让每个失败用例白等一秒
process.env.MIXR_SSE_KEEPALIVE_MS = '0';
process.env.MIXR_COOLDOWN_SEC = '60';
process.env.MIXR_MAX_ATTEMPTS = '2';
process.env.MIXR_CONV_RETRIES = '3';

const wire = require('../lib/wire-responses.js');

// ---------------------------------------------------------------- 桩上游
// mode 决定 /v1/responses 怎么回:ok(json) / dripHeaders(只补头字节,永不结束头)
let mode = 'json';
let jsonBody = null;
let jsonAlways = false;
const requests = [];
const sockets = new Set();
const server = http.createServer((req, res) => {
  const cs = [];
  req.on('data', c => cs.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}'); } catch {}
    requests.push({ url: req.url, body });
    if (mode === 'dripHeaders') {
      // 响应头永远收不齐:直接在 socket 上写半截头,每 20ms 补一个字节,永不发 \r\n\r\n。
      // 这样 socket 的空闲超时每次都被字节重置,只有端到端总预算收得住它(审计 P2-2 的复现形状)。
      // 不能用 res.writeHead:那会立刻把完整的头发出去,量的就成了"响应头已到、body 不收尾"那段
      try {
        req.socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n');
        const t = setInterval(() => { try { req.socket.write('x'); } catch {} }, 20);
        req.socket.on('close', () => clearInterval(t));
      } catch {}
      return;
    }
    if (mode === 'phraseSse') {
      // 转换线的 SSE:正文里引用那句上游报错文案,随后正常收尾。
      // 以前这里按文案做子串匹配,正常回答会被判成上游失败、整条掐成 aborted
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const sse = o => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
      sse({ type: 'response.created', response: { id: 'r1', model: body.model } });
      sse({ type: 'response.output_text.delta', output_index: 0, delta: '日志中出现 Could not find an existing deployment,请检查部署名称。' });
      sse({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 9 } } });
      return res.end();
    }
    if (mode === 'upstream500') {
      // 上游 5xx(New API 系网关常把错误挂在 SSE 皮里):报错原因必须进日志,
      // 否则事后翻 requests.jsonl 只看到 "status:500, err:''"——不知道上游说了什么
      res.writeHead(500, { 'content-type': 'text/event-stream' });
      return res.end(JSON.stringify({ error: { type: 'server_error', message: '配额池已耗尽 (trace_id=zzz)' } }));
    }
    if (mode === 'midStreamAbort') {
      // 上游已经交出响应头(200 + SSE),流到一半直接掐断:没有终态事件。
      // 客户端最终会拿到 502。这条钉的是**日志必须跟着客户端走**:以前 upstreamDead
      // 先 finishEntry() 再 sendErr(),entry.status 还停在上游的 200,于是
      // requests.jsonl 记成功、客户端拿 502 —— 故障在日志里凭空消失。
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const sse = o => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
      sse({ type: 'response.created', response: { id: 'r1', model: body.model } });
      sse({ type: 'response.output_text.delta', output_index: 0, delta: '半截' });
      setTimeout(() => { try { res.destroy(); } catch {} }, 30);
      return;
    }
    if (req.url.includes('/responses')) {
      if (jsonAlways || !body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(jsonBody || {
          id: 'resp_1', object: 'response', status: 'completed', model: body.model,
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 5, output_tokens: 2 },
        }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const sse = o => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
      sse({ type: 'response.created', response: { id: 'r1', model: body.model } });
      sse({ type: 'response.output_text.delta', output_index: 0, delta: '转换流内容' });
      sse({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: 'direct' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } }));
  });
});
server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

let mod, proxySrv, uiSrv, proxyPort, uiPort, upPort;

function rawRequest(port, method, reqPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const creq = http.request({
      hostname: '127.0.0.1', port, method, path: reqPath,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, cres => {
      const cs = [];
      cres.on('data', c => cs.push(c));
      cres.on('end', () => resolve({ status: cres.statusCode, headers: cres.headers, text: Buffer.concat(cs).toString('utf8') }));
      cres.on('error', reject);
    });
    creq.on('error', reject);
    if (data) creq.write(data);
    creq.end();
  });
}

function lastRequestLog() {
  const lines = fs.readFileSync(path.join(TMP, 'logs', 'requests.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

test('setup:一个 responses 型 claude 渠道 + 一个直通渠道', async () => {
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  upPort = server.address().port;
  server.unref();
  fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({
    version: 2, current: { claude: 'pconv', codex: null },
    claude: [
      { id: 'pconv', name: '转换', base_url: `http://127.0.0.1:${upPort}`, api_key: 'sk-c', enabled: true, models: ['claude-conv'], wire_api: 'responses' },
      { id: 'pdir', name: '直通', base_url: `http://127.0.0.1:${upPort}`, api_key: 'sk-d', enabled: true, models: ['claude-direct'] },
      { id: 'pkeep', name: '别动我', base_url: 'https://keep.example.com', api_key: 'sk-keep', enabled: true, models: ['keep-model'] },
    ],
    codex: [],
  }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({
    rules: [
      { id: 'rconv', match: 'claude-conv', provider: 'pconv', model: 'claude-conv', enabled: true },
      { id: 'rdir', match: 'claude-direct', provider: 'pdir', model: 'claude-direct', enabled: true },
    ],
    default: { provider: 'pdir', model: 'claude-direct' },
  }));
  mod = require('../mixrouter.js');
  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  proxySrv.unref(); uiSrv.unref();
});

// ---------------------------------------------------------------- P1-1 整包 JSON 丢思考
test('P1-1 整包 Responses JSON:reasoning 要翻成 thinking 块,不丢明文思考', () => {
  const msg = wire.responsesToAnthropic({
    id: 'resp_x', status: 'completed', model: 'gpt-6-astra',
    output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: '先看文件' }] },
      { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{"p":"a.txt"}' },
    ],
    usage: { input_tokens: 10, output_tokens: 3 },
  }, 'gpt-6-astra');
  assert.strictEqual(msg.content[0].type, 'thinking', 'reasoning item 必须留下 thinking 块');
  assert.strictEqual(msg.content[0].thinking, '先看文件');
  assert.strictEqual(msg.content[1].type, 'tool_use');
  assert.strictEqual(msg.stop_reason, 'tool_use');
});

test('P1-1 reasoning 只有 summary 形状 / 空文本时不产出空 thinking 块', () => {
  const fromSummary = wire.responsesToAnthropic({ status: 'completed', model: 'm', output: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: '摘要思考' }] },
    { type: 'message', content: [{ type: 'output_text', text: '答' }] },
  ] }, 'm');
  assert.strictEqual(fromSummary.content[0].type, 'thinking');
  assert.strictEqual(fromSummary.content[0].thinking, '摘要思考');

  // 只剩加密内容 / 空 content:没有明文可回传,不该产出空思考块(实测空 content 回传一样 400)
  const onlyEncrypted = wire.responsesToAnthropic({ status: 'completed', model: 'm', output: [
    { type: 'reasoning', encrypted_content: 'zzz', content: [] },
    { type: 'message', content: [{ type: 'output_text', text: '答' }] },
  ] }, 'm');
  assert.deepStrictEqual(onlyEncrypted.content.map(c => c.type), ['text']);
});

test('P1-1 上游忽略 stream 直回 JSON:客户端仍能拿到思考,且能原样回传', async () => {
  jsonAlways = true;
  jsonBody = {
    id: 'resp_j', object: 'response', status: 'completed', model: 'conv-model',
    output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'JSON 线的思考' }] },
      { type: 'function_call', call_id: 'cj', name: 'Bash', arguments: '{"cmd":"ls"}' },
    ],
    usage: { input_tokens: 9, output_tokens: 4 },
  };
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-conv', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
  });
  jsonAlways = false; jsonBody = null;
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.text);
  assert.strictEqual(j.content[0].type, 'thinking');
  assert.strictEqual(j.content[0].thinking, 'JSON 线的思考');
  assert.strictEqual(j.content[1].type, 'tool_use');
  assert.strictEqual(j.stop_reason, 'tool_use');
});

// ---------------------------------------------------------------- P2-1 错误文案误判
test('P2-1 正常正文里引用上游报错文案:不得被当成上游失败', async () => {
  const answer = '日志中出现 Could not find an existing deployment,请检查部署名称。';
  jsonAlways = true;
  jsonBody = {
    id: 'resp_q', object: 'response', status: 'completed', model: 'conv-model',
    output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }],
    usage: { input_tokens: 9, output_tokens: 20 },
  };
  const before = requests.length;
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-conv', max_tokens: 32, messages: [{ role: 'user', content: '这个报错怎么解' }] },
  });
  jsonAlways = false; jsonBody = null;
  assert.strictEqual(r.status, 200, `正常回答不该被判成失败:${r.text}`);
  const j = JSON.parse(r.text);
  assert.strictEqual(j.type, 'message');
  assert.ok(j.content[0].text.includes('Could not find an existing deployment'), '正文要原样送达');
  assert.strictEqual(requests.length, before + 1, '正常回答不得触发重试(重复请求)');
});

test('P2-1 转换线 SSE:正文里出现错误文案,不得被掐成 aborted', async () => {
  // 文案出现在**正文增量**里(不是独立 error 事件),随后是正常 completed。
  // 以前按文案做子串匹配,这条正常回答会被判成上游失败、不发 message_stop
  mode = 'phraseSse';
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-conv', max_tokens: 32, stream: true, messages: [{ role: 'user', content: '这个报错怎么解' }] },
  });
  mode = 'json';
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes('event: message_stop'), `正常回答必须正常收尾,实际:${r.text}`);
  assert.ok(!r.text.includes('event: error'), '不得补协议级 error');
  assert.strictEqual(lastRequestLog().err_class, '', '正常回答不该记错误分类');
});

// ---------------------------------------------------------------- P2-2 头阶段越过总预算
test('P2-2 上游只补响应头字节、永不收齐:总预算必须收得住', async () => {
  mode = 'dripHeaders';
  const t0 = Date.now();
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-direct', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'drip' }] },
  });
  mode = 'json';
  const ms = Date.now() - t0;
  const log = lastRequestLog();
  assert.ok(ms < 2500, `必须被总预算(1000ms)收住,实际 ${ms}ms`);
  assert.strictEqual(log.err_class, 'timeout', `必须如实记 timeout,实际 ${log.err_class}: ${log.err}`);
  assert.ok(log.err.includes('总预算'), `实际:${log.err}`);
  assert.ok(r.status >= 500, `客户端要拿到明确的失败状态,实际 ${r.status}`);
  assert.notStrictEqual(r.status, 499, '不能记成 client closed');
});

// ---------------------------------------------------------------- P2-3 attempts 低报
test('P2-3 同渠道重试要计入 attempts:日志反映真实上游调用数', async () => {
  // 上游持续 5xx,MIXR_CONV_RETRIES=3、候选只有 1 个 → 真实调用 = 1+3 = 4 次
  const failSrv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"boom"}}'); });
  });
  await new Promise(ok => failSrv.listen(0, '127.0.0.1', ok));
  const failPort = failSrv.address().port;
  failSrv.unref();
  const state = mod._state;
  const savedStore = state.store;
  const savedRoutes = state.routes;
  state.store = { claude: [{ id: 'pdie', name: '持续5xx', base_url: `http://127.0.0.1:${failPort}`, api_key: 'sk-x', enabled: true, wire_api: 'responses', models: ['die-model'] }], codex: [] };
  state.routes = { rules: [{ id: 'rdie', match: 'die-model', provider: 'pdie', model: 'die-model', enabled: true }], default: { provider: 'pdie', model: 'die-model' } };
  let hits = 0;
  failSrv.on('request', () => { hits++; });
  try {
    const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
      body: { model: 'die-model', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] },
    });
    const log = lastRequestLog();
    assert.ok(r.status >= 400, '持续 5xx 最终要失败');
    assert.strictEqual(log.attempts, hits, `日志 attempts(${log.attempts})必须等于真实上游调用数(${hits})`);
    assert.ok(hits > 1, `这个形状本来就该重试,实际上游调用 ${hits} 次`);
  } finally {
    state.store = savedStore;
    state.routes = savedRoutes;
    failSrv.close();
  }
});

test('P2-3 一次请求的上游调用上限按实测上界给出', async () => {
  const h = JSON.parse((await rawRequest(uiPort, 'GET', '/api/health')).text);
  assert.strictEqual(h.settings.max_attempts, 2);
  assert.strictEqual(h.settings.conversion_retries, 3);
  // 上界 = 候选渠道数 + 换 key 重试数(整条请求共用)。不能用乘法:MA=3/CR=0 时乘法给 3。
  assert.strictEqual(h.settings.max_upstream_calls, 2 + 3, '上界要显式暴露,且按实测口径算');
});

// ---------------------------------------------------------------- P1-2 PUT 校验失败不得污染配置
test('P1-2 渠道 PUT 被拒后内存配置一字不动,也不影响后续保存', async () => {
  const before = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text)
    .providers.claude.find(p => p.id === 'pkeep');
  // 先改一个合法字段、再带一个非法 base_url:整个请求必须原子失败
  const bad = await rawRequest(uiPort, 'PUT', '/api/providers/pkeep', {
    body: { enabled: false, name: '被拒的名字', base_url: 'javascript:alert(1)' },
  });
  assert.strictEqual(bad.status, 400);
  const after = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text)
    .providers.claude.find(p => p.id === 'pkeep');
  assert.strictEqual(after.enabled, before.enabled, '被拒的请求不得停用渠道');
  assert.strictEqual(after.name, before.name, '被拒的请求不得改名');
  assert.strictEqual(after.base_url, before.base_url, 'base_url 不得被改');

  // 再保存另一个渠道:被拒的改动绝不能借这次保存落盘
  const other = JSON.parse((await rawRequest(uiPort, 'POST', '/api/providers', {
    body: { app: 'claude', name: '另一个', base_url: 'https://other.example.com', api_key: 'sk-o' },
  })).text);
  await rawRequest(uiPort, 'PUT', `/api/providers/${other.id}`, { body: { note: '触发一次保存' } });
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'providers.json'), 'utf8'))
    .claude.find(p => p.id === 'pkeep');
  assert.strictEqual(onDisk.enabled, before.enabled, '被拒的改动不得借下一次保存写进磁盘');
  assert.strictEqual(onDisk.name, before.name);
  assert.strictEqual(onDisk.base_url, before.base_url);
  await rawRequest(uiPort, 'DELETE', `/api/providers/${other.id}`);
});

test('P1-2 合法的 PUT 仍然照常生效(原子化不能把正常保存也挡掉)', async () => {
  const ok = await rawRequest(uiPort, 'PUT', '/api/providers/pkeep', { body: { note: '正常备注', enabled: true } });
  assert.strictEqual(ok.status, 200);
  const now = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text)
    .providers.claude.find(p => p.id === 'pkeep');
  assert.strictEqual(now.note, '正常备注');
  assert.strictEqual(now.enabled, true);
});

// ---------------------------------------------------------------- P1-3 Codex 切换重复键
test('P1-3 顶层键带合法缩进时,切换不得写出重复键', () => {
  const file = process.env.MIXR_CODEX_CONFIG;
  fs.writeFileSync(file, [
    '  model = "gpt-5"',
    '  model_provider = "old"',
    '',
    '[model_providers.custom]',
    'name = "user"',
    '',
  ].join('\n'));
  mod.writeCodexConfig({ section: 'mixr-t', name: 'T', base_url: 'http://127.0.0.1:1', api_key: 'sk', wire_api: 'responses', model: 'gpt-5.1' });
  const text = fs.readFileSync(file, 'utf8');
  assert.strictEqual(text.match(/^\s*model\s*=/gm).length, 1, `顶层 model 只能有一条:\n${text}`);
  assert.strictEqual(text.match(/^\s*model_provider\s*=/gm).length, 1, `顶层 model_provider 只能有一条:\n${text}`);

  // 真解析一遍:XML/TOML 解析器说得算,不能只看行数
  const { execFileSync } = require('node:child_process');
  const py = `
import tomllib, sys
with open(sys.argv[1], 'rb') as f:
    d = tomllib.load(f)
assert d['model_provider'] == 'mixr-t', d.get('model_provider')
print('ok')
`;
  const out = execFileSync('python3', ['-c', py, file], { encoding: 'utf8' }).trim();
  assert.strictEqual(out, 'ok', 'Python tomllib 必须能解析切换后的文件');
});

// ---------------------------------------------------------------- P2-4 字符串 input 绕过内容路由
test('P2-4 字符串 input 与等价数组一样能命中 when.body 内容分流', () => {
  const { bodyRouteText } = mod;
  const asString = bodyRouteText({ instructions: 'sys', input: 'please summarize this' });
  const asArray = bodyRouteText({ instructions: 'sys', input: [{ role: 'user', content: 'please summarize this' }] });
  assert.ok(asString.includes('please summarize this'), '字符串 input 必须参与匹配');
  assert.strictEqual(asString, asArray, '两种等价形状的匹配文本必须一致');

  const rule = { when: { body: 'summarize' } };
  const ctxOf = b => ({ bodyText: () => bodyRouteText(b) });
  assert.strictEqual(mod.matchWhen(rule, ctxOf({ input: 'please summarize this' })), true);
  assert.strictEqual(mod.matchWhen(rule, ctxOf({ input: [{ role: 'user', content: 'please summarize this' }] })), true);
  // 空串 input 不该凭空产出匹配文本
  assert.strictEqual(bodyRouteText({ input: '' }), '');
});

// ---------------------------------------------------------------- 二轮自查新发现
// 这三条是修完审计报告后自己继续排查时发现的,不在原报告里
test('删除渠道必须解开引用它的路由,不留僵尸引用', async () => {
  const created = JSON.parse((await rawRequest(uiPort, 'POST', '/api/providers', {
    body: { app: 'claude', name: '待删', base_url: 'https://del.example.com', api_key: 'sk-del', models: ['del-model'] },
  })).text);
  const id = created.id;
  const savedRules = JSON.parse(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8'));
  // 一批规则:单选引用、池引用、default 引用、以及一个无关规则
  await rawRequest(uiPort, 'PUT', '/api/routes', { body: { rules: [
    { id: 'rd1', match: 'del-a', provider: id, model: '', enabled: true },
    { id: 'rd2', match: 'del-b', pool: [{ provider: id }, { provider: 'pdir' }], strategy: 'round_robin', enabled: true },
    { id: 'rd3', match: 'keep', provider: 'pdir', model: '', enabled: true },
  ], default: { provider: id, model: '' } } });
  await rawRequest(uiPort, 'DELETE', `/api/providers/${id}`);

  const st = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text);
  assert.strictEqual(st.routes.rules.find(r => r.id === 'rd1').provider, '', '单选引用要清空');
  assert.deepStrictEqual(st.routes.rules.find(r => r.id === 'rd2').pool.map(m => m.provider), ['pdir'], '池里的引用要摘掉,别的成员留着');
  assert.strictEqual(st.routes.default.provider, '', 'default 的引用也要清');
  assert.strictEqual(st.routes.rules.find(r => r.id === 'rd3').provider, 'pdir', '无关规则不许动');
  // 落盘也要一致:控制台刷新后不能又看到僵尸引用
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8'));
  assert.ok(!JSON.stringify(onDisk).includes(id), '磁盘上不该再留已删渠道的 id');

  await rawRequest(uiPort, 'PUT', '/api/routes', { body: savedRules });
});

test('控制台写接口拒绝跨站来源(CSRF/DNS-rebinding)', async () => {
  const post = (headers) => rawRequest(uiPort, 'POST', '/api/providers', {
    headers, body: { app: 'claude', name: '跨站', base_url: 'https://csrf.example.com', api_key: 'sk-csrf' },
  });
  // 浏览器发的跨站请求带 Sec-Fetch-Site: cross-site
  const cross = await post({ 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example.com' });
  assert.strictEqual(cross.status, 403, '跨站写必须被拒');
  // 只有 Origin、且与 Host 不一致:同样拒
  const originOnly = await post({ Origin: 'https://evil.example.com' });
  assert.strictEqual(originOnly.status, 403, 'Origin 与 Host 不一致必须拒');
  // 同源控制台必须放行
  const same = await post({ Origin: `http://127.0.0.1:${uiPort}`, 'Sec-Fetch-Site': 'same-origin' });
  assert.strictEqual(same.status, 200, '同源控制台不能被误拦');
  if (same.status === 200) await rawRequest(uiPort, 'DELETE', `/api/providers/${JSON.parse(same.text).id}`);
  // 本机 CLI / mixctl 不发 Origin,照常放行(这不是鉴权,只是拦浏览器跨站)
  const cli = await post({});
  assert.strictEqual(cli.status, 200, '无 Origin 的本机客户端必须放行');
  if (cli.status === 200) await rawRequest(uiPort, 'DELETE', `/api/providers/${JSON.parse(cli.text).id}`);
  // 读接口不受影响
  assert.strictEqual((await rawRequest(uiPort, 'GET', '/api/state')).status, 200);
});

// ---------------------------------------------------------------- 三轮自查
// 起因:线上 routes.json 里真有一条 match="kimi-k3" 的规则指向早已删除的渠道,
// 请求打上去 503 却说"没有匹配的路由,或路由未绑定渠道"——控制台里那条规则显示着"已绑定"。
// 而且这条悬空规则会把**后面所有规则和兜底一起挡住**,不光是它自己失效。
test('PUT /api/routes 拒绝指向不存在渠道的规则(写上就拦,而不是等请求时 503)', async () => {
  const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8'));
  const put = b => rawRequest(uiPort, 'PUT', '/api/routes', { body: b });
  // 单选目标
  const single = await put({ rules: [{ id: 'rg1', match: 'm', provider: '早就删了的渠道', model: '' }], default: {} });
  assert.strictEqual(single.status, 400, '单选目标指向幽灵渠道必须被拒');
  assert.match(JSON.parse(single.text).error, /rg1/);
  assert.match(JSON.parse(single.text).error, /早就删了的渠道/);
  // 池成员
  const pooled = await put({ rules: [{ id: 'rg2', match: 'm', pool: [{ provider: 'pdir' }, { provider: '幽灵' }] }], default: {} });
  assert.strictEqual(pooled.status, 400, '池里的幽灵成员同样要拦');
  assert.match(JSON.parse(pooled.text).error, /池成员 2/);
  // 兜底路由
  const def = await put({ rules: [], default: { provider: '幽灵' } });
  assert.strictEqual(def.status, 400, '兜底路由指向幽灵渠道也要拦');
  assert.match(JSON.parse(def.text).error, /兜底路由/);
  // 被拒的写入不得落盘、不得生效
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8'));
  assert.ok(!JSON.stringify(onDisk).includes('幽灵'), '被拒的路由不得落盘');
  // 合法写入照常放行(空 provider = 未绑定,必须仍然允许)
  const ok = await put({ rules: [{ id: 'rok', match: 'm', provider: 'pdir' }, { id: 'rnone', match: 'x', provider: '' }], default: { provider: '' } });
  assert.strictEqual(ok.status, 200, '合法路由与"未绑定"必须放行');
  await put(saved);
});

test('路由命中但目标渠道已删除时报错要点名规则与渠道,不糊成"没有匹配的路由"', async () => {
  const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8'));
  // 直接塞进内存:模拟"routes.json 是手改的 / 从旧备份恢复的"这种绕过接口校验的情形
  mod._state.routes = {
    rules: [{ id: 'rkimighost', match: 'kimi-k3', provider: '已删除的渠道', model: 'kimi-k3', priority: 10, enabled: true }],
    default: { provider: 'pdir', model: '' },
  };
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'kimi-k3', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(r.status, 503);
  const j = JSON.parse(r.text);
  assert.strictEqual(j.error.type, 'no_route_error');
  assert.match(j.error.message, /rkimighost/, '要点名是哪条规则');
  assert.match(j.error.message, /已删除的渠道/, '要点名是哪个渠道没了');
  assert.ok(!/没有匹配的路由/.test(j.error.message), '不能再报成"没有匹配的路由"');

  // 兜底路由本身 rule=null,这条分支不能去读 rule.id(曾经直接 TypeError 崩在请求里)
  mod._state.routes = { rules: [], default: { provider: '已删除的渠道', model: '' } };
  const d = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'whatever', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(d.status, 503, '兜底指向幽灵渠道要 503,不能崩');
  assert.match(JSON.parse(d.text).error.message, /兜底路由/);
  assert.match(JSON.parse(d.text).error.message, /已删除的渠道/);

  // 池里混了幽灵成员、但有可用成员时:照常放行(池的意义就是绕开不可用的)
  mod._state.routes = {
    rules: [{ id: 'rmix', match: 'kimi-k3', pool: [{ provider: '已删除的渠道' }, { provider: 'pdir' }], model: 'claude-direct', enabled: true }],
    default: { provider: 'pdir', model: '' },
  };
  const ok = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'kimi-k3', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(ok.status, 200, '池里有可用成员时必须照常转发');

  mod._state.routes = { rules: saved.rules, default: saved.default };
});

test('启动时把僵尸引用喊出来(reportGhostRoutes)', async () => {
  const savedRules = mod._state.routes.rules, savedDef = mod._state.routes.default;
  mod._state.routes = { rules: [{ id: 'rzombie', match: 'kimi-k3', provider: '已删除的渠道', model: '' }], default: { provider: '' } };
  const warns = [];
  const orig = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  let bad;
  try { bad = mod.reportGhostRoutes(); } finally { console.warn = orig; }
  mod._state.routes = { rules: savedRules, default: savedDef };
  assert.strictEqual(bad.length, 1, '要报出这一处');
  assert.match(bad[0], /rzombie/);
  assert.match(bad[0], /已删除的渠道/);
  assert.strictEqual(warns.length, 1, '要打一条警告');
  assert.match(warns[0], /僵尸引用/);
  // 没有僵尸引用时不能瞎喊
  assert.deepStrictEqual(mod.reportGhostRoutes(), []);
});

test('声明了协议组却绑另一组渠道的规则被拒(否则规则会静默失效)', async () => {
  const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8'));
  // pconv 是 claude 组渠道;声明 codex 组却绑它 → poolMembers 在 codex 组里找不到,规则静默变"未绑定"
  const bad = await rawRequest(uiPort, 'PUT', '/api/routes', {
    body: { rules: [{ id: 'rbad', match: 'm', app: 'codex', provider: 'pconv', model: '' }], default: {} },
  });
  assert.strictEqual(bad.status, 400, '跨组绑定必须被拒');
  assert.match(JSON.parse(bad.text).error, /rbad/);
  // 没声明 app 的规则允许只服务另一组(另一组会跳过它),必须放行
  const ok = await rawRequest(uiPort, 'PUT', '/api/routes', {
    body: { rules: [{ id: 'rother', match: 'm', provider: 'pconv', model: '' }], default: {} },
  });
  assert.strictEqual(ok.status, 200, '未声明组的规则不能误拦');
  await rawRequest(uiPort, 'PUT', '/api/routes', { body: saved });
});

test('上游 5xx 的原因必须落进请求日志,不能只留一个光秃秃的状态码', async () => {
  // 线上 9935 条记录里 649 条 5xx,其中 613 条 err 是空串:客户端拿到了原因、
  // 日志里却没有,事后排查"某渠道为什么 500"只能从零开始。这条钉住它。
  const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8'));
  mode = 'upstream500';
  try {
    // 冷却期内的渠道不被优先挑选:把上几条测试留下的冷却清掉,这条量的才是 5xx 原因落日志
    mod._state.cooldowns = {};
    await rawRequest(uiPort, 'PUT', '/api/routes', { body: { rules: [{ id: 'r500', match: 'claude-conv', provider: 'pconv', model: 'claude-conv' }], default: {} } });
    const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
      body: { model: 'claude-conv', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.strictEqual(r.status, 500, '上游状态码要如实转发');
    const log = lastRequestLog();
    assert.strictEqual(log.status, 500);
    assert.ok(log.err, 'err 不能是空的——否则事后完全不知道上游为什么失败');
    assert.match(log.err, /配额池已耗尽/, '要把上游给的原因记下来');
    assert.match(log.err, /trace_id=zzz/, '上游的追踪号也要留着');
  } finally {
    mode = 'json';
    mod._state.cooldowns = {};
    await rawRequest(uiPort, 'PUT', '/api/routes', { body: saved });
  }
});

test('畸形消息数组不能掀翻进程(messages 元素是 null/数字)', async () => {
  // 客户端拼错一个 null 就能让 firstUserText 抛 TypeError。生产里有 uncaughtException
  // 兜底,进程不会死,但这条请求会**没有任何响应**地挂在那儿,客户端一直等到自己的超时。
  const bad = [
    { model: 'claude-conv', max_tokens: 8, messages: [null] },
    { model: 'claude-conv', max_tokens: 8, messages: [7] },
    { model: 'claude-conv', max_tokens: 8, messages: ['str'] },
    { model: 'claude-conv', max_tokens: 8, messages: [null, { role: 'user', content: 'hi' }] },
    { model: 'claude-conv', max_tokens: 8, messages: [{ role: 'user', content: [null, 7] }] },
  ];
  for (const body of bad) {
    const r = await rawRequest(proxyPort, 'POST', '/v1/messages', { body });
    assert.ok(r.status >= 200 && r.status < 600, `${JSON.stringify(body.messages)} 必须拿到一个真响应,实际 ${r.status}`);
    assert.notStrictEqual(r.status, undefined);
  }
  // 服务端还活着
  assert.strictEqual((await rawRequest(uiPort, 'GET', '/api/state')).status, 200);
});

test('超长模型名不得把响应头撑爆(客户端会拿到 HPE_HEADER_OVERFLOW 而不是状态码)', async () => {
  // x-mixrouter-model 直接把请求里的模型名回写进响应头,而模型名是客户端说了算的。
  // 几十 KB 的模型名会让响应头越过 Node 的 16KB 上限,客户端拿到的是协议级报错,
  // 连一个 HTTP 状态码都看不到——比"模型名太长"难查得多。
  for (const n of [8000, 30000, 100000]) {
    const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
      body: { model: `${'m'.repeat(n)}`, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.ok(r.status >= 200 && r.status < 600, `模型名长 ${n} 时必须正常回一个 HTTP 响应,实际 ${r.status}`);
    const modelHeader = r.headers['x-mixrouter-model'];
    if (modelHeader !== undefined) assert.ok(modelHeader.length <= 256, `响应头里的模型名必须被截断,实际 ${modelHeader.length}`);
  }
  // 请求头必须先通过 Node 的解析上限,否则 431/ECONNRESET 根本没有进入被测 handler。
  // 8KB 从头传入;50KB 从 metadata 传入,两种身份来源都实际经过响应头处理。
  for (const fromHeader of [true, false]) {
    const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
      headers: fromHeader ? { 'x-claude-code-session-id': 's'.repeat(8000) } : {},
      body: { model: 'claude-conv', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }],
        ...(fromHeader ? {} : { metadata: { user_id: 's'.repeat(50000) } }) },
    });
    assert.strictEqual(r.status, 200, '会话 id 必须进入 handler 并正常转发,解析层拒绝不算通过');
    assert.ok(r.headers['x-mixrouter-session'].startsWith('s'));
    assert.ok(r.headers['x-mixrouter-session'].length <= 256, '会话响应头必须有界');
  }
});

test('超深嵌套的请求体不能把请求挂死(JSON.parse 的 RangeError 不是 catch 得住的语法错)', async () => {
  // 171KB 体积配 5000 层嵌套就能稳定复现:JSON.parse 递归爆栈 → RangeError 抛出 →
  // 客户端零响应(干等到自己的超时),日志里一行都没有。深度扫描放在 parse 之前拦掉。
  for (const depth of [300, 5000, 20000]) {
    let inner = '{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGk="}}';
    for (let i = 0; i < depth; i++) inner = `{"type":"tool_result","content":[${inner}]}`;
    const raw = `{"model":"claude-conv","max_tokens":8,"messages":[{"role":"user","content":[${inner}]}]}`;
    const r = await rawRequest(proxyPort, 'POST', '/v1/messages', { body: raw });
    assert.strictEqual(r.status, 400, `嵌套 ${depth} 层必须干净拒绝,实际 ${r.status}`);
    assert.match(JSON.parse(r.text).error.message, /嵌套/);
  }
  // 正常深度的请求照常放行(嵌套十几层是真实请求的常态)
  const ok = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-conv', max_tokens: 8, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'hi' }] }] }] },
  });
  assert.notStrictEqual(ok.status, 400, '正常嵌套不能被误拦');
});

test('渠道列表与状态接口都不出明文 Key', async () => {
  for (const p of ['/api/state', '/api/health', '/api/routes', '/api/slots']) {
    const r = await rawRequest(uiPort, 'GET', p);
    assert.ok(!r.text.includes('sk-c'), `${p} 不得含明文 Key`);
    assert.ok(!/"api_key"\s*:\s*"[^"]+"/.test(r.text), `${p} 不得带 api_key 字段明文`);
  }
});

// ---------------------------------------------------------------- 第二轮审计(另一会话报来的)
// 上游把载荷只放在 *.done / item 生命周期事件里(一个 *.delta 都不发)时,以前整段丢弃:
// 客户端拿到 200 + 空正文 / input:{} 的空工具调用,而日志里记着成功。
// 这几条都是**静默**丢,所以每条都双向钉:既要"补回来",也要"不许重复发"。
function streamOf(events) {
  const frames = [];
  const res = { headersSent: false, writableEnded: false, destroyed: false,
    writeHead() { this.headersSent = true; }, write(c) { frames.push(String(c)); return true; }, end() { this.writableEnded = true; } };
  const st = new wire.AnthropicStream(res, 'm', {});
  for (const ev of events) st.feed(`data: ${JSON.stringify(ev)}\n\n`);
  return frames.join('');
}

test('R2-1 文本只出现在 output_text.done:要补发给客户端', () => {
  const out = streamOf([
    { type: 'response.created', response: { id: 'r', status: 'in_progress', model: 'm' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1', content: [] } },
    { type: 'response.output_text.done', output_index: 0, item_id: 'm1', text: '完整答案' },
    { type: 'response.completed', response: { id: 'r', status: 'completed', model: 'm', output: [], usage: {} } },
  ]);
  assert.ok(out.includes('完整答案'), 'output_text.done 的文本必须到客户端');
  assert.strictEqual((out.match(/"type":"text_delta"/g) || []).length, 1, '只能补一次');
});

test('R2-2 增量与 done 都发时不重复(这是补发最危险的副作用)', () => {
  const out = streamOf([
    { type: 'response.created', response: { id: 'r', status: 'in_progress', model: 'm' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'm1', delta: '完整' },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'm1', delta: '答案' },
    { type: 'response.output_text.done', output_index: 0, item_id: 'm1', text: '完整答案' },
    { type: 'response.completed', response: { id: 'r', status: 'completed', model: 'm', output: [], usage: {} } },
  ]);
  const text = (out.match(/"text":"([^"]*)"/g) || []).join('');
  assert.ok(!/完整答案.*完整答案/.test(text), '同一段文本不得发两遍');
  assert.strictEqual((out.match(/"type":"text_delta"/g) || []).length, 2, '增量两帧,补发 0 帧');
});

test('R2-3 工具参数只在 function_call_arguments.done / item 里:要补齐', () => {
  for (const events of [
    [ // 官方 done 事件带完整 arguments
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'f1', call_id: 'c1', name: 'Read' } },
      { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'f1', arguments: '{"file_path":"/tmp/a"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'f1', call_id: 'c1', name: 'Read' } },
      { type: 'response.completed', response: { status: 'completed', usage: {} } },
    ],
    [ // 只在 item 里
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'f1', call_id: 'c1', name: 'Read' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'f1', call_id: 'c1', name: 'Read', arguments: '{"file_path":"/tmp/a"}' } },
      { type: 'response.completed', response: { status: 'completed', usage: {} } },
    ],
  ]) {
    const out = streamOf(events);
    assert.ok(out.includes('file_path'), '工具参数必须到客户端,不能是 input:{}');
  }
});

test('R2-4 思考只在 reasoning_summary_text.done / reasoning item 里:要补齐', () => {
  for (const events of [
    [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'r1', summary: [] } },
      { type: 'response.reasoning_summary_text.done', output_index: 0, item_id: 'r1', text: '先想一下' },
      { type: 'response.completed', response: { status: 'completed', usage: {} } },
    ],
    [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'r1' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: '先想一下' }] } },
      { type: 'response.completed', response: { status: 'completed', usage: {} } },
    ],
  ]) {
    const out = streamOf(events);
    assert.ok(out.includes('先想一下'), '思考内容必须到客户端');
  }
});

test('R2-5 对象形状的 tool arguments 不能被 String() 成 [object Object]', () => {
  // 上游直接把对象塞进 arguments。以前 String({}) → "[object Object]" → JSON.parse 必失败
  // → 一次参数完好的调用被判成"参数残缺"丢掉。
  const j = { id: 'r', status: 'completed', model: 'm', usage: {},
    output: [{ type: 'function_call', call_id: 'c', name: 'Bash', arguments: { cmd: 'ls' } }] };
  assert.strictEqual(wire.responsesErrorOf(j), null, '形状完好的调用不该被判成残缺');
  assert.deepStrictEqual(wire.responsesToAnthropic(j, 'm').content[0].input, { cmd: 'ls' });
});

test('R2-6 emitAnthropicSse 不得二次变换 usage(缓存命中会凭空消失)', () => {
  // 上游忽略 stream 直回 JSON,body.stream=true 时走这条路。喂进去的 usage 已经是
  // Anthropic 口径(responsesToAnthropic 的产物),再过一遍 Responses 口径的 usageOf
  // 就会把 cache_read_input_tokens 整个丢掉。
  const frames = [];
  const res = { headersSent: false, writableEnded: false, destroyed: false,
    writeHead() { this.headersSent = true; }, write(c) { frames.push(String(c)); return true; }, end() {} };
  wire.emitAnthropicSse(res, { id: 'x', type: 'message', role: 'assistant', model: 'm',
    content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn',
    usage: { input_tokens: 600, output_tokens: 30, cache_read_input_tokens: 400 } }, {}, null);
  const out = frames.join('');
  assert.ok(out.includes('"cache_read_input_tokens":400'), '缓存命中数必须保留在 message_delta 里');
  assert.ok(out.includes('"input_tokens":600'), 'input_tokens 不得被二次扣减');
});

test('R2-7 上游流中途夭折:日志状态必须是客户端真正拿到的 502,不是上游的 200', async () => {
  // requests.jsonl 是渠道健康与用量审计的唯一依据。这条走**anthropic 直通非流**那条分支
  // (客户端非流、上游是 SSE,收进内存攒包):夭折时客户端拿 502,而那里以前
  // finishEntry() 在前、sendErr() 在后 —— entry.status 还停在上游的 200,
  // 于是日志记成功、客户端拿 502,一整类客户端可见的故障在日志里凭空消失。
  // (实测过:转换线非流分支本来就是对的,只有这条直通线倒置。)
  mode = 'midStreamAbort';
  try {
    const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
      body: { model: 'claude-direct', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.strictEqual(r.status, 502, `客户端要拿到 502(实际 ${r.status})`);
    const e = lastRequestLog();
    assert.strictEqual(e.status, 502, `客户端拿到 ${r.status},日志就必须是 ${r.status}(实际 ${e.status})`);
    assert.ok(e.err, 'err 不能是空串,得留下夭折原因');
  } finally { mode = 'json'; }
});

test('R2-8 chat 线:finish_reason 缺失时半截工具参数不得放行', () => {
  // responses 线一直是无条件查的,chat 线以前只在 finish_reason 存在且非 length 时才查,
  // 于是上游漏发 finish_reason(常态)时,半截参数被当成一次可执行调用发出去。
  // 半截参数:故意缺一个右引号 + 右花括号
  const TRUNC = '{"file_path":"a.tx';
  const mk = fr => {
    const choice = { message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Write', arguments: TRUNC } }] } };
    if (fr !== undefined) choice.finish_reason = fr;
    return { id: 'c', model: 'm', choices: [choice] };
  };
  for (const fr of [undefined, null, 'stop', 'tool_calls']) {
    assert.ok(mod.wireChat.chatErrorOf(mk(fr)), `finish_reason=${String(fr)} 时半截参数必须被拦下`);
  }
  // 真正的截断(length)由 stop_reason=max_tokens 如实表达,不算错误
  assert.strictEqual(mod.wireChat.chatErrorOf(mk('length')), null);
});

test('R2-9 渠道 API Key 里的换行:写入就拒,存量脏数据要说清楚而不是挂死', async () => {
  // Node 的 transport.request 对含控制字符的头值**同步**抛;那一抛在 tryCandidate 里、
  // 任何 try 之外 —— 请求凭空消失:不写日志、客户端干等、上游一次都没调到。
  const bad = await rawRequest(uiPort, 'POST', '/api/providers',
    { headers: { 'Content-Type': 'application/json' },
      body: { name: '脏', base_url: 'https://x.example.com', api_key: 'sk-a\nX-Injected: yes', models: ['m'] } });
  assert.strictEqual(bad.status, 400, '含换行的 Key 必须在写入时就拒绝');
  assert.ok(/控制字符|换行/.test(bad.text));

  // 全空格的 Key 是 PUT 里"不改动"的哨兵,不能把一把能用的 Key 冲成空格
  const blank = await rawRequest(uiPort, 'PUT', '/api/providers/pconv',
    { headers: { 'Content-Type': 'application/json' }, body: { api_key: '   ' } });
  assert.strictEqual(blank.status, 200);
  assert.strictEqual(mod._state.store.claude.find(p => p.id === 'pconv').api_key, 'sk-c', '空格不得覆盖已有 Key');
});

test('R2-10 存量脏 Key(写入闸门之前存进去的):换后备渠道,并如实记日志', async () => {
  const p = mod._state.store.claude.find(x => x.id === 'pconv');
  const keep = p.api_key;
  // 让转换渠道的后备是直通渠道,才谈得上故障转移
  const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8'));
  try {
    await rawRequest(uiPort, 'PUT', '/api/routes', { body: { rules: [
      { id: 'rconv', match: 'claude-conv', pool: [{ provider: 'pconv', model: 'claude-conv' }, { provider: 'pdir', model: 'claude-direct' }], strategy: 'priority', model: 'claude-conv' },
    ], default: { provider: 'pdir', model: 'claude-direct' } } });
    p.api_key = 'sk-c\nX-Injected: yes';
    // 清冷却与会话粘性:前面几条测试把 pdir 打进过冷却(它就成了首选,失败转移也就无从发生),
    // 会话粘性也会把 pconv 钉住。两个都得清,这条量的才是"脏 Key 渠道失败后换后备"。
    for (const k of Object.keys(mod._state.cooldowns)) delete mod._state.cooldowns[k];
    mod._state.sessions.clear();
    const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
      headers: { 'x-claude-code-session-id': 'r2-10-fresh' },
      body: { model: 'claude-conv', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
    });
    // 这条渠道自己发不出去,但有后备时应当换过去而不是把请求吞掉
    assert.strictEqual(r.status, 200, `应当换到后备渠道,实际 ${r.status}`);
    assert.strictEqual(lastRequestLog().failover, true, '要如实记为故障转移');
  } finally {
    p.api_key = keep;
    fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify(saved));
  }
});

test('R2-11 settings.json 有 BOM:必须解析成功且保留 permissions/hooks/statusLine', async () => {
  // 这一条是"hooks 凭空消失"的根因:JSON.parse 不认 BOM,以前 catch {} 退回 {} 再写回,
  // 整个文件就只剩我们塞进去的那几个 env 键,接口还回 200。
  const keep = fs.existsSync(process.env.MIXR_CLAUDE_SETTINGS) ? fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8') : null;
  const rich = '﻿' + JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { PreToolUse: [{ matcher: 'x' }] },
    statusLine: { type: 'command', command: 'y' }, env: { KEEP: 'yes', ANTHROPIC_BASE_URL: 'https://old' } }, null, 2);
  try {
    fs.writeFileSync(process.env.MIXR_CLAUDE_SETTINGS, rich);
    const r = await rawRequest(uiPort, 'POST', '/api/switch/pdir');
    assert.strictEqual(r.status, 200, '带 BOM 的合法 JSON 不该写失败');
    const after = JSON.parse(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'));
    assert.ok(after.permissions, 'permissions 必须保留');
    assert.ok(after.hooks, 'hooks 必须保留');
    assert.ok(after.statusLine, 'statusLine 必须保留');
    assert.strictEqual(after.env.KEEP, 'yes', '用户自己的 env 变量必须保留');
    assert.strictEqual(after.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${upPort}`, '只改该改的那一项(pdir 的 base_url)');
  } finally {
    if (keep === null) { try { fs.unlinkSync(process.env.MIXR_CLAUDE_SETTINGS); } catch {} }
    else fs.writeFileSync(process.env.MIXR_CLAUDE_SETTINGS, keep);
  }
});

test('R2-12 settings.json 解析不了:宁可拒绝写入,也不许把它覆盖掉', async () => {
  for (const [name, text] of [['行内注释', '{\n// c\n"env":{"KEEP":"1"}}'], ['尾逗号', '{"env":{"KEEP":"1"},}']]) {
    const keep = fs.existsSync(process.env.MIXR_CLAUDE_SETTINGS) ? fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8') : null;
    try {
      fs.writeFileSync(process.env.MIXR_CLAUDE_SETTINGS, text);
      const r = await rawRequest(uiPort, 'POST', '/api/switch/pdir');
      assert.strictEqual(r.status, 400, `${name}:解析不了就必须拒绝,不能当空文件覆盖`);
      assert.strictEqual(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'), text, `${name}:原文件必须原封不动`);
    } finally {
      if (keep !== null) fs.writeFileSync(process.env.MIXR_CLAUDE_SETTINGS, keep);
    }
  }
});

test('R2-13 控制台写接口的类型闸门:畸形输入 400,不许存成 [object Object]', async () => {
  const cases = [
    ['PUT', '/api/providers/pconv', { models: {} }, 'models 是对象'],
    ['PUT', '/api/providers/pconv', { models: [null, {}, 5] }, 'models 里有非字符串'],
    ['PUT', '/api/providers/pconv', { slots: 'nope' }, 'slots 是字符串(以前会把全部槽位清空)'],
    ['PUT', '/api/providers/pconv', { note: {} }, 'note 是对象'],
    ['PUT', '/api/providers/pconv', { active_key: {} }, 'active_key 是对象(以前会静默切回第一把)'],
    ['POST', '/api/providers', { name: {}, base_url: 'https://x.example.com' }, 'name 是对象'],
    ['PUT', '/api/routes', { rules: [{ id: 'rw', match: 'm', when: { body: {} }, provider: 'pconv', model: 'claude-conv' }] }, 'when.body 是对象'],
  ];
  for (const [method, p, body, label] of cases) {
    const r = await rawRequest(uiPort, method, p, { headers: { 'Content-Type': 'application/json' }, body });
    assert.strictEqual(r.status, 400, `${label} 必须 400(实际 ${r.status}:${r.text.slice(0, 80)})`);
  }
  // 正常的字符串形态仍然照收
  const ok = await rawRequest(uiPort, 'PUT', '/api/providers/pconv',
    { headers: { 'Content-Type': 'application/json' }, body: { models: ['claude-conv', 'm2'], note: '正常' } });
  assert.strictEqual(ok.status, 200);
  const p = mod._state.store.claude.find(x => x.id === 'pconv');
  assert.deepStrictEqual(p.models, ['claude-conv', 'm2']);
  assert.strictEqual(p.note, '正常');
});

test('R2-14 PUT {keys: 非数组} 不得把多账号静默擦光', async () => {
  // 以前非数组 → normalizeKeys 的 `Array.isArray(input)?input:[]` 返回空表 → `delete next.keys`,
  // 一次 PUT 就把该渠道所有账号抹掉,接口还回 200。用户看到"保存成功",账号没了。
  const created = await rawRequest(uiPort, 'POST', '/api/providers',
    { headers: { 'Content-Type': 'application/json' },
      body: { name: '多账号', base_url: 'https://mk.example.com', api_key: 'k-one',
        models: ['m'], keys: [{ label: '一号', key: 'k-one' }, { label: '二号', key: 'k-two' }] } });
  const id = JSON.parse(created.text).id;
  try {
    const before = mod._state.store.claude.find(p => p.id === id).keys;
    assert.strictEqual(before.length, 2);
    for (const bad of ['nope', 123, { a: 1 }]) {
      const r = await rawRequest(uiPort, 'PUT', `/api/providers/${id}`,
        { headers: { 'Content-Type': 'application/json' }, body: { keys: bad } });
      assert.strictEqual(r.status, 400, `keys=${JSON.stringify(bad)} 必须 400`);
      assert.strictEqual(mod._state.store.claude.find(p => p.id === id).keys.length, 2, '账号一个都不许少');
    }
  } finally {
    mod._state.store.claude = mod._state.store.claude.filter(p => p.id !== id);
  }
});

test('R2-15 磁盘写不进去时,内存必须回滚(不许"接口报错、渠道却已经生效")', async () => {
  const before = mod._state.store.claude.length;
  fs.chmodSync(TMP, 0o500); // 数据目录只读:saveJson 的写临时文件会 EACCES
  try {
    const r = await rawRequest(uiPort, 'POST', '/api/providers',
      { headers: { 'Content-Type': 'application/json' },
        body: { name: '写不进去的', base_url: 'https://nope.example.com', api_key: 'kn', models: ['m'] } });
    assert.strictEqual(r.status, 500, '写不动就得如实报错');
    assert.strictEqual(mod._state.store.claude.length, before, '内存里不能留下这条(否则重启后凭空消失)');
    assert.ok(!mod._state.store.claude.some(p => p.name === '写不进去的'));
  } finally { fs.chmodSync(TMP, 0o700); }
});

test('R2-16 Codex 渠道模型名为空:不许写出空 model 的 config.toml', async () => {
  const saved = { claude: mod._state.store.claude, codex: mod._state.store.codex };
  try {
    mod._state.store.claude = [];
    mod._state.store.codex = [{ id: 'cx', name: 'C', base_url: 'https://c.example.com', api_key: 'kc', enabled: true, model: '' }];
    const r = await rawRequest(uiPort, 'POST', '/api/router/codex', { headers: { 'Content-Type': 'application/json' }, body: {} });
    assert.strictEqual(r.status, 400, '空模型名必须拦下(以前写出的 config.toml 里是 model = "")');
    assert.ok(!fs.existsSync(process.env.MIXR_CODEX_CONFIG) || !/^\s*model\s*=\s*""\s*$/m.test(fs.readFileSync(process.env.MIXR_CODEX_CONFIG, 'utf8')),
      '不许留下空 model');
  } finally {
    mod._state.store.claude = saved.claude; mod._state.store.codex = saved.codex;
  }
});

after(() => {
  for (const s of sockets) { try { s.destroy(); } catch {} }
  try { server.close(); } catch {}
});
