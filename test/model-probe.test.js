'use strict';
// 模型级测活(lib/model-probe.js)的行为钉桩:每个模型一次真实最小请求,回答"这个模型现在能不能用"。
//
// 这个文件钉的是那些**坏了不报错、只给出错误结论**的点:
//   1. 三条线各说各的协议(anthropic / responses / chat)。协议发错时上游回 400,
//      卡片上看起来却像"这个模型坏了"——渠道其实是好的,模型也是好的。
//   2. [1M] 后缀:剥掉后缀的同时必须补 anthropic-beta;补头只能补到 anthropic 线。
//      headers 传字面量就等于"改完即丢"(渠道探活早先踩过,见 lib/model-suffix.js 文件头)。
//   3. base_url 与 /v1 的拼接:拼成 /v1/v1 是 404,同样会被当成模型不可用。
//   4. 2xx + 错误壳:网关把"模型下线/额度不足"包在 200 里,只看状态码会报成可用。
//   5. 非 2xx:状态码与原因都要取自上游,而不是一句"失败了"。
//   6. Key 脱敏:上游常把请求头原样回显进报错,结果会流进控制台与日志。
//   7. 网络失败只说白名单措辞:errno 原文、代理隧道细节、上游主机名都不该出现在用户面前。
//   8. 超时:卡死的上游必须被单模型时限收住,不能把整批拖到客户端放弃。
//   9. 配置错误抛 ModelProbeError(400),且**一个字节都不发**给上游(否则会白烧额度)。
//  10. 并发上限与结果顺序:控制台按行对应,且不能一次把上游打爆。
//  11. 单模型失败不拖垮整批(逐行给结论,整批照常 resolve)。
//  12. modelsOf 的去重/补齐/坏值过滤。
//
// 全部用 127.0.0.1 上的 http.createServer 假上游:不联网、不读 providers.json、不写盘。
// 每个用例一台新上游,`t.after` 里立刻关掉并 closeAllConnections(不把连接留到整套结束)。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  WIRES, DEFAULT_TIMEOUT_MS, MODEL_NAME_MAX, PROBE_MAX_TOKENS,
  ModelProbeError, wireOfProvider, modelsOf, probeModel, probeModels,
} = require('../lib/model-probe');

const BETA_1M = 'context-1m-2025-08-07';
const KEY = 'sk-model-probe-SECRET-0001';
const MODEL = 'mock-model';
const JSON_HEADERS = { 'content-type': 'application/json' };

// ---------------------------------------------------------------- 假上游
// 只记录请求(url / 方法 / 头 / 解析后的 JSON 体)并交给每个用例自己的 handler。
const servers = new Set();

function createUpstream(handler) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    // 同一台假上游会连续收到很多请求(keep-alive 复用同一条 socket):
    // 每条请求都挂一次 close 监听会攒到 MaxListenersExceededWarning。每条 socket 只挂一次。
    sockets.add(req.socket);
    if (!req.socket.__tracked) {
      req.socket.__tracked = true;
      req.socket.once('close', () => sockets.delete(req.socket));
    }
    req.on('error', () => {});
    res.on('error', () => {});
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 请求体恒为 JSON */ }
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(entry);
      try { handler(entry, res, req); }
      catch { try { res.destroy(); } catch { /* 已关闭 */ } }
    });
  });
  server.__sockets = sockets;
  servers.add(server);
  return { server, requests, sockets };
}

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server); });
});

const closeServer = server => new Promise(resolve => {
  for (const socket of server.__sockets) { try { socket.destroy(); } catch { /* 已关闭 */ } }
  server.__sockets.clear();
  server.closeAllConnections?.();
  server.close(() => resolve());
});

async function withUpstream(t, handler, run) {
  const up = createUpstream(handler);
  await listen(up.server);
  t.after(() => closeServer(up.server));
  return run(up);
}

// 文件级兜底:任何用例在半途失败时也不能把监听端口留到进程退出。
after(async () => {
  for (const server of servers) if (server.listening) await closeServer(server);
});

// 一个曾经监听、现在已经关掉的端口:连上去必然是 ECONNREFUSED,且不需要真的出网。
async function closedPort() {
  const server = createUpstream(() => {});
  await listen(server.server);
  const port = server.server.address().port;
  await closeServer(server.server);
  servers.delete(server.server);
  return port;
}

const urlOf = (up, prefix = '') => `http://127.0.0.1:${up.server.address().port}${prefix}`;

// 成功的判定与结果形状:ms 是真实耗时,只断言它是非负整数;其余字段必须与契约逐字一致。
const withoutMs = ({ ms, ...rest }) => rest;
const assertMs = (r, label) => assert.ok(Number.isInteger(r.ms) && r.ms >= 0, `${label}: ms 应是非负整数`);

// 默认的正常回包:Anthropic 形状的最小成功正文(不含 error 字段)。
const replyOk = (entry, res) => {
  res.writeHead(200, JSON_HEADERS);
  res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'pong' }] }));
};

// ---------------------------------------------------------------- 常量与 wire 判定

test('导出的常量与 wire 判定:缺省 anthropic,只认 responses/chat', () => {
  assert.deepEqual(WIRES, ['anthropic', 'responses', 'chat']);
  // 判活预算不是"越小越好":推理型模型(deepseek-v4.1-flash)会把 token 全吃在思考上,
  // 预算给到 16 时上游回 500 empty response,一个可用的模型被判成故障。请求体用的**就是**
  // 这个导出值(下面三种协议逐一对齐),所以这里钉的是"够不够",而不是某个魔数。
  assert.ok(Number.isInteger(PROBE_MAX_TOKENS) && PROBE_MAX_TOKENS >= 16,
    `PROBE_MAX_TOKENS=${PROBE_MAX_TOKENS},推理模型至少要 16`);
  // 单模型默认时限同理:这是"够慢模型表态"与"控制台别久等"的折中,不下钉具体秒数,
  // 但**不能比渠道探活的 15 秒还紧**(20 秒曾把首字十几秒的推理模型判死)。
  assert.ok(Number.isInteger(DEFAULT_TIMEOUT_MS) && DEFAULT_TIMEOUT_MS >= 20000,
    `DEFAULT_TIMEOUT_MS=${DEFAULT_TIMEOUT_MS},慢模型的默认时限不得低于 20 秒`);
  assert.equal(MODEL_NAME_MAX, 200);

  assert.equal(wireOfProvider(undefined), 'anthropic');
  assert.equal(wireOfProvider(null), 'anthropic');
  assert.equal(wireOfProvider({}), 'anthropic');
  assert.equal(wireOfProvider({ wire_api: 'anthropic' }), 'anthropic');
  assert.equal(wireOfProvider({ wire_api: 'responses' }), 'responses');
  assert.equal(wireOfProvider({ wire_api: 'chat' }), 'chat');
  // 大小写不猜:不认的值一律落回缺省,而不是"看起来像就按它发"
  assert.equal(wireOfProvider({ wire_api: 'Chat' }), 'anthropic');
  assert.equal(wireOfProvider({ wire_api: 'completions' }), 'anthropic');
});

// ---------------------------------------------------------------- 1. 三种协议

test('三种协议各走对的路径与请求体(发错协议时卡片显示"模型坏了")', async t => {
  await withUpstream(t, replyOk, async up => {
    const base = urlOf(up);

    // anthropic:渠道没标 wire_api 时的缺省线
    let r = await probeModel({ provider: { base_url: base }, model: MODEL, key: KEY });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(withoutMs(r), { model: MODEL, ok: true, status: 200 });
    assertMs(r, 'anthropic');
    let req = up.requests[0];
    assert.equal(up.requests.length, 1);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/messages');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers['x-api-key'], KEY);
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(req.body.model, MODEL);
    assert.equal(req.body.max_tokens, PROBE_MAX_TOKENS);
    assert.deepEqual(req.body.messages, [{ role: 'user', content: 'ping' }]);

    // responses:渠道标了 wire_api='responses'
    up.requests.length = 0;
    r = await probeModel({ provider: { base_url: base, wire_api: 'responses' }, model: MODEL, key: KEY });
    assert.equal(r.ok, true, JSON.stringify(r));
    assertMs(r, 'responses');
    req = up.requests[0];
    assert.equal(up.requests.length, 1);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers['x-api-key'], undefined, 'OpenAI 线不带 x-api-key');
    assert.equal(req.headers['anthropic-version'], undefined);
    assert.equal(req.headers['anthropic-beta'], undefined);
    assert.equal(req.body.model, MODEL);
    assert.equal(req.body.input, 'ping');
    assert.equal(req.body.max_output_tokens, PROBE_MAX_TOKENS);
    assert.equal(req.body.messages, undefined);
    assert.equal(req.body.max_tokens, undefined);

    // chat:渠道标了 wire_api='chat'
    up.requests.length = 0;
    r = await probeModel({ provider: { base_url: base, wire_api: 'chat' }, model: MODEL, key: KEY });
    assert.equal(r.ok, true, JSON.stringify(r));
    assertMs(r, 'chat');
    req = up.requests[0];
    assert.equal(up.requests.length, 1);
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers['x-api-key'], undefined);
    assert.equal(req.headers['anthropic-version'], undefined);
    assert.equal(req.headers['anthropic-beta'], undefined);
    assert.equal(req.body.model, MODEL);
    assert.deepEqual(req.body.messages, [{ role: 'user', content: 'ping' }]);
    assert.equal(req.body.max_tokens, PROBE_MAX_TOKENS);
    assert.equal(req.body.input, undefined);
    assert.equal(req.body.max_output_tokens, undefined);

    // 显式传的 wire 压过渠道自己的 wire_api(控制台选线时用得上)
    up.requests.length = 0;
    await probeModel({ provider: { base_url: base, wire_api: 'responses' }, model: MODEL, key: KEY, wire: 'chat' });
    assert.equal(up.requests[0].url, '/v1/chat/completions');
    // 不认识的 wire 值不能"照发",要落回渠道自己的判定
    up.requests.length = 0;
    await probeModel({ provider: { base_url: base, wire_api: 'responses' }, model: MODEL, key: KEY, wire: 'gpt' });
    assert.equal(up.requests[0].url, '/v1/responses');
  });
});

// ---------------------------------------------------------------- 2. [1M] 后缀

test('[1M] 后缀:anthropic 剥名并补 beta 头,responses/chat 只剥名不带 beta', async t => {
  await withUpstream(t, replyOk, async up => {
    const base = urlOf(up);

    for (const model of ['claude-opus-5[1M]', 'claude-opus-5[1m]']) {
      up.requests.length = 0;
      const r = await probeModel({ provider: { base_url: base }, model, key: KEY });
      assert.equal(r.ok, true, JSON.stringify(r));
      const req = up.requests[0];
      assert.equal(req.body.model, 'claude-opus-5', `${model}: 上游只认裸名`);
      assert.equal(req.headers['anthropic-beta'], BETA_1M, `${model}: 必须补 1m beta 头`);
      assert.equal(r.model, model, '结果回的是入参名(控制台按行对应),不是剥过的名字');
    }

    // 没后缀就不许动头:多发的 beta 头会被不认识它的网关拒掉
    up.requests.length = 0;
    await probeModel({ provider: { base_url: base }, model: 'claude-opus-5', key: KEY });
    assert.equal(up.requests[0].body.model, 'claude-opus-5');
    assert.equal(up.requests[0].headers['anthropic-beta'], undefined);

    // OpenAI 两条线:名字照剥,但绝不能挂 anthropic-* 头
    up.requests.length = 0;
    await probeModel({ provider: { base_url: base, wire_api: 'responses' }, model: 'gpt-5[1M]', key: KEY });
    assert.equal(up.requests[0].url, '/v1/responses');
    assert.equal(up.requests[0].body.model, 'gpt-5');
    assert.equal(up.requests[0].headers['anthropic-beta'], undefined);

    up.requests.length = 0;
    await probeModel({ provider: { base_url: base, wire_api: 'chat' }, model: 'glm-5.3[1m]', key: KEY });
    assert.equal(up.requests[0].url, '/v1/chat/completions');
    assert.equal(up.requests[0].body.model, 'glm-5.3');
    assert.equal(up.requests[0].headers['anthropic-beta'], undefined);
  });
});

// ---------------------------------------------------------------- 3. base_url 拼接

test('base_url 的 root、/v1、尾部斜杠与自定义前缀都落到同一个 /v1/messages', async t => {
  await withUpstream(t, replyOk, async up => {
    const origin = `http://127.0.0.1:${up.server.address().port}`;
    const cases = [
      ['', '/v1/messages'],
      ['/', '/v1/messages'],
      ['/v1', '/v1/messages'],
      ['/v1/', '/v1/messages'],
      ['/api/v2', '/api/v2/v1/messages'],
      ['/api/v2/', '/api/v2/v1/messages'],
      ['/api/v2/v1', '/api/v2/v1/messages'],
      ['/api/v2/v1/', '/api/v2/v1/messages'],
    ];
    for (const [suffix, expected] of cases) {
      up.requests.length = 0;
      const r = await probeModel({ provider: { base_url: origin + suffix }, model: MODEL, key: KEY });
      assert.equal(r.ok, true, `base_url=${origin}${suffix}: ${JSON.stringify(r)}`);
      assert.equal(up.requests[0].url, expected, `base_url=${origin}${suffix}`);
    }
    for (const request of up.requests) assert.equal(request.url.includes('/v1/v1/'), false);

    // OpenAI 两条线共用同一套拼接规则(base 已带 /v1 时不能再叠一层)
    up.requests.length = 0;
    await probeModel({ provider: { base_url: origin + '/v1', wire_api: 'responses' }, model: MODEL, key: KEY });
    assert.equal(up.requests[0].url, '/v1/responses');
    up.requests.length = 0;
    await probeModel({ provider: { base_url: origin + '/v1', wire_api: 'chat' }, model: MODEL, key: KEY });
    assert.equal(up.requests[0].url, '/v1/chat/completions');
    up.requests.length = 0;
    await probeModel({ provider: { base_url: origin + '/api/v2', wire_api: 'chat' }, model: MODEL, key: KEY });
    assert.equal(up.requests[0].url, '/api/v2/v1/chat/completions');

    // https 只换传输层,路径换算走同一条 joinUpstreamPath;这里断言它不会被当成坏配置,
    // 而是真的走进网络层(关闭的端口 => 受控的网络措辞)。
    const port = await closedPort();
    const httpsResult = await probeModel({
      provider: { base_url: `https://127.0.0.1:${port}/v1` }, model: MODEL, key: KEY,
    });
    assert.equal(httpsResult.ok, false);
    assert.equal(httpsResult.status, null);
    assert.equal(httpsResult.error, '上游拒绝连接');
  });
});

// ---------------------------------------------------------------- 4. 2xx + 错误壳

test('2xx 但正文是错误壳判失败;正常正文才算可用', async t => {
  let reply = { status: 200, body: '{}' };
  await withUpstream(t, (entry, res) => {
    res.writeHead(reply.status, JSON_HEADERS);
    res.end(reply.body);
  }, async up => {
    const base = urlOf(up);
    const cases = [
      // 网关把"额度不足 / 模型下线"包在 200 里:只看状态码会把它们报成可用
      ['{"error":{"message":"quota exhausted for this key"}}', false, /quota exhausted/],
      ['{"type":"error","error":{"message":"model disabled"}}', false, /model disabled/],
      ['{"type":"error","error":"upstream refused"}', false, /upstream refused/],
      ['{"type":"message","content":[{"type":"text","text":"pong"}]}', true],
      ['{}', true],
      ['pong', true], // 非 JSON 的 2xx 正文不当作错误
    ];
    for (const [body, ok, reason] of cases) {
      reply = { status: 200, body };
      const r = await probeModel({ provider: { base_url: base }, model: MODEL, key: KEY });
      assert.equal(r.ok, ok, `${body}: ${JSON.stringify(r)}`);
      assert.equal(r.status, 200, body);
      assertMs(r, body);
      if (ok) {
        assert.deepEqual(withoutMs(r), { model: MODEL, ok: true, status: 200 }, body);
      } else {
        assert.equal(typeof r.error, 'string', body);
        assert.match(r.error, reason, body);
        // 失败结果恰好是这五个字段,不多不少
        assert.deepEqual(Object.keys(r).sort(), ['error', 'model', 'ms', 'ok', 'status'], body);
      }
    }
    assert.equal(up.requests.length, cases.length);
  });
});

// ---------------------------------------------------------------- 5. 非 2xx

test('非 2xx:状态码如实带回,原因取自上游正文', async t => {
  let reply = { status: 400, body: '{}' };
  await withUpstream(t, (entry, res) => {
    res.writeHead(reply.status, JSON_HEADERS);
    res.end(reply.body);
  }, async up => {
    const base = urlOf(up);
    const cases = [
      [400, '{"error":{"message":"model not found: ghost-1"}}', 'model not found: ghost-1'],
      [429, '{"error":"rate limited, retry later"}', 'rate limited, retry later'],
      [500, '{"error":{"message":"upstream boom"}}', 'upstream boom'],
    ];
    for (const [status, body, expected] of cases) {
      reply = { status, body };
      const r = await probeModel({ provider: { base_url: base }, model: MODEL, key: KEY });
      assert.equal(r.ok, false, body);
      assert.equal(r.status, status, body);
      assert.equal(r.error, expected, body);
      assert.deepEqual(withoutMs(r), { model: MODEL, ok: false, status, error: expected }, body);
    }
    assert.equal(up.requests.length, cases.length);
  });
});

// ---------------------------------------------------------------- 6. Key 脱敏

test('上游把 Key 原样回显进报错:结果里只出现 ***,不出明文', async t => {
  let reply = { status: 401, body: '{}' };
  await withUpstream(t, (entry, res) => {
    res.writeHead(reply.status, JSON_HEADERS);
    res.end(reply.body);
  }, async up => {
    const base = urlOf(up);

    // 上游把请求头原样抄进报错是最常见的泄漏形状
    reply = {
      status: 401,
      body: JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}. Check your key.` } }),
    };
    let r = await probeModel({ provider: { base_url: base }, model: MODEL, key: KEY });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
    assert.equal(r.error.includes(KEY), false, '错误原因里不得出现明文 Key');
    assert.equal(r.error.includes('***'), true, 'Key 本体应被替换成 ***');
    assert.equal(JSON.stringify(r).includes(KEY), false);
    for (const value of Object.values(r)) assert.notEqual(value, KEY);

    // 200 + 错误壳这条路同样要脱敏(否则换个网关就漏)
    reply = { status: 200, body: JSON.stringify({ error: { message: `bad credential ${KEY}` } }) };
    r = await probeModel({ provider: { base_url: base }, model: MODEL, key: KEY });
    assert.equal(r.ok, false);
    assert.equal(r.status, 200);
    assert.equal(r.error.includes(KEY), false);
    assert.equal(r.error.includes('***'), true);
    assert.equal(JSON.stringify(r).includes(KEY), false);
    for (const value of Object.values(r)) assert.notEqual(value, KEY);

    // 上游确实收到了明文 Key:脱敏发生在结果这一侧,不是发出去的 Key 不对
    assert.equal(up.requests[0].headers['x-api-key'], KEY);
  });
});

// ---------------------------------------------------------------- 7. 网络错误措辞

test('连不上上游:只说白名单措辞,不回显 errno 原文与主机名', async t => {
  const port = await closedPort();
  const r = await probeModel({ provider: { base_url: `http://127.0.0.1:${port}` }, model: MODEL, key: KEY });
  assert.equal(r.ok, false);
  assert.equal(r.status, null, '网络层失败没有 HTTP 状态码');
  assert.equal(r.error, '上游拒绝连接');
  assert.equal(r.error.includes('ECONNREFUSED'), false, 'errno 原文不得回显');
  assert.equal(JSON.stringify(r).includes('127.0.0.1'), false, '连主机名都不回显');
  assert.deepEqual(withoutMs(r), { model: MODEL, ok: false, status: null, error: '上游拒绝连接' });
  assert.equal(typeof r.ms, 'number');
});

// ---------------------------------------------------------------- 8. 超时

test('上游收下请求就不回:按 timeoutMs 掐断并说超时', { timeout: 3000 }, async t => {
  // 收下请求、永不响应(不 writeHead、不 end),由客户端的单模型时限收住。
  await withUpstream(t, () => {}, async up => {
    const started = Date.now();
    const r = await probeModel({
      provider: { base_url: urlOf(up) }, model: MODEL, key: KEY, timeoutMs: 1000,
    });
    const elapsed = Date.now() - started;
    assert.equal(r.ok, false);
    assert.equal(r.status, null);
    assert.equal(r.error, '超时(1 秒)');
    assert.match(r.error, /超时/);
    assert.ok(elapsed >= 900, `应该真的等过时限,实际 ${elapsed}ms`);
    assert.ok(elapsed < 3000, `整条用例必须 ~3 秒内结束,实际 ${elapsed}ms`);
    assert.equal(up.requests.length, 1, '超时前确实发出了一次请求');
  });
});

// ---------------------------------------------------------------- 9. 配置错误

test('配置错误抛 ModelProbeError(400),且一个字节都不发给上游', async t => {
  await withUpstream(t, replyOk, async up => {
    const base = urlOf(up);
    const longModel = 'm'.repeat(MODEL_NAME_MAX + 1);
    const cases = [
      ['空模型名', { provider: { base_url: base }, model: '   ', key: KEY }, /模型名不能为空/],
      ['超长模型名', { provider: { base_url: base }, model: longModel, key: KEY }, /模型名过长/],
      ['空 Key', { provider: { base_url: base }, model: MODEL, key: '  ' }, /缺少可用的 API Key/],
      ['缺 Key', { provider: { base_url: base }, model: MODEL }, /缺少可用的 API Key/],
      ['ftp base_url', { provider: { base_url: 'ftp://127.0.0.1:1' }, model: MODEL, key: KEY }, /只支持 http 或 https/],
      ['不是 URL', { provider: { base_url: 'not a url' }, model: MODEL, key: KEY }, /base_url 必须是合法的/],
      ['缺 base_url', { provider: {}, model: MODEL, key: KEY }, /base_url 必须是合法的/],
      ['userinfo', { provider: { base_url: 'http://user:pass@127.0.0.1:1' }, model: MODEL, key: KEY },
        /不能包含用户名或密码/],
    ];
    for (const [label, args, message] of cases) {
      await assert.rejects(probeModel(args), err => {
        assert.equal(err instanceof ModelProbeError, true, `${label}: 应抛 ModelProbeError`);
        assert.equal(err.name, 'ModelProbeError', label);
        assert.equal(err.status, 400, label);
        assert.match(err.message, message, label);
        return true;
      }, label);
      assert.equal(up.requests.length, 0, `${label}: 不得访问上游`);
    }

    // 边界:正好 200 字是合法的,不能把合法的长模型名也拒掉
    up.requests.length = 0;
    const boundary = 'm'.repeat(MODEL_NAME_MAX);
    const r = await probeModel({ provider: { base_url: base }, model: boundary, key: KEY });
    assert.equal(r.ok, true);
    assert.equal(up.requests[0].body.model, boundary);

    // 整批入口遇到空名单也是配置错误(不能"零个模型算全过")
    await assert.rejects(probeModels({ provider: { base_url: base }, models: [], key: KEY }), err => {
      assert.equal(err instanceof ModelProbeError, true);
      assert.equal(err.status, 400);
      assert.match(err.message, /没有可测的模型名/);
      return true;
    });
    assert.equal(up.requests.length, 1, '空名单同样不发请求(只留下上面的边界那一次)');
  });
});

// ---------------------------------------------------------------- 10. 并发与顺序

test('批量:去重保序、并发不超过上限、结果与入参逐行对应', { timeout: 10000 }, async t => {
  let inflight = 0;
  let maxInflight = 0;
  const handler = (entry, res) => {
    inflight += 1;
    if (inflight > maxInflight) maxInflight = inflight;
    setTimeout(() => {
      inflight -= 1;
      res.writeHead(200, JSON_HEADERS);
      res.end('{}');
    }, 40);
  };
  await withUpstream(t, handler, async up => {
    // 6 个入参,其中 m1 重复、m3 带空白:去重与 trim 之后应为 5 个
    const models = ['m1', 'm2', 'm1', ' m3 ', 'm4', 'm5'];
    const out = await probeModels({
      provider: { base_url: urlOf(up) }, models, key: KEY, concurrency: 2,
    });
    assert.equal(out.wire, 'anthropic');
    assert.ok(Number.isInteger(out.total_ms) && out.total_ms >= 0, 'total_ms 应是非负整数');
    assert.deepEqual(Object.keys(out).sort(), ['results', 'total_ms', 'wire']);
    assert.deepEqual(out.results.map(r => r.model), ['m1', 'm2', 'm3', 'm4', 'm5'],
      '结果顺序 = 去重后的入参顺序');
    assert.deepEqual(out.results.map(r => r.ok), [true, true, true, true, true]);
    for (const r of out.results) assert.deepEqual(withoutMs(r), { model: r.model, ok: true, status: 200 });

    assert.equal(up.requests.length, 5, '重复模型名只发一次');
    assert.deepEqual(up.requests.map(r => r.body.model).sort(), ['m1', 'm2', 'm3', 'm4', 'm5']);
    // 既证明并发确实发生(不是串行),也证明上限被遵守(不会 5 个一起打出去)
    assert.equal(maxInflight, 2, '并发上限 concurrency=2');
  });
});

// ---------------------------------------------------------------- 11. 单个失败不影响整批

test('单个模型失败不拖垮整批:整批照常 resolve,逐行给结论', async t => {
  await withUpstream(t, (entry, res) => {
    if (entry.body.model === 'bad-model') {
      res.writeHead(500, JSON_HEADERS);
      return res.end(JSON.stringify({ error: { message: 'upstream boom' } }));
    }
    res.writeHead(200, JSON_HEADERS);
    res.end('{}');
  }, async up => {
    const out = await probeModels({
      provider: { base_url: urlOf(up) }, models: ['ok-1', 'bad-model', 'ok-2'], key: KEY,
    });
    assert.deepEqual(out.results.map(r => r.model), ['ok-1', 'bad-model', 'ok-2']);
    assert.deepEqual(out.results.map(r => r.ok), [true, false, true]);
    assert.deepEqual(out.results.map(r => r.status), [200, 500, 200]);
    assert.equal(out.results[1].error, 'upstream boom');
    // 计数由逐行结论算出来,模块本身不额外报一个可能说谎的汇总
    assert.equal(out.results.filter(r => r.ok).length, 2, 'passed');
    assert.equal(out.results.filter(r => !r.ok).length, 1, 'failed');
    assert.deepEqual(Object.keys(out).sort(), ['results', 'total_ms', 'wire']);
    assert.equal(up.requests.length, 3);
  });

  // 坏 base_url 对整批都成立:同样不 reject,每行各记一条失败(否则控制台整块空白)
  const batch = await probeModels({ provider: { base_url: 'ftp://127.0.0.1:1' }, models: ['a', 'b'], key: KEY });
  assert.equal(batch.results.length, 2);
  assert.deepEqual(batch.results.map(r => r.ok), [false, false]);
  assert.deepEqual(batch.results.map(r => r.status), [null, null]);
  assert.match(batch.results[0].error, /只支持 http 或 https/);
  assert.deepEqual(batch.results.map(r => r.model), ['a', 'b']);
});

// ---------------------------------------------------------------- 12. modelsOf

test('modelsOf:Claude 组保序去重,Codex 组补默认模型,坏值跳过', () => {
  // Claude 组:第一项是主模型,顺序必须保留
  assert.deepEqual(modelsOf({ models: ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-5'] }),
    ['claude-opus-5', 'claude-sonnet-5']);
  // Codex 组的默认模型在 provider.model 上:列表里没有就补到后面
  assert.deepEqual(modelsOf({ models: ['gpt-6-astra'], model: 'gpt-6' }), ['gpt-6-astra', 'gpt-6']);
  assert.deepEqual(modelsOf({ models: ['gpt-6'], model: 'gpt-6' }), ['gpt-6'], '已在列表里就不重复');
  assert.deepEqual(modelsOf({ model: 'gpt-6' }), ['gpt-6']);
  // 先 trim 再去重
  assert.deepEqual(modelsOf({ models: [' a ', 'a'] }), ['a']);
  // 空值 / 非字符串 / 超长名一律跳过
  assert.deepEqual(modelsOf({ models: [null, undefined, 42, '', '   ', {}, [], 'ok'] }), ['ok']);
  assert.deepEqual(modelsOf({ models: ['m'.repeat(MODEL_NAME_MAX + 1), 'm'.repeat(MODEL_NAME_MAX)] }),
    ['m'.repeat(MODEL_NAME_MAX)]);
  assert.deepEqual(modelsOf({ models: ['a'], model: 'm'.repeat(MODEL_NAME_MAX + 1) }), ['a']);
  // 什么都没有就是空表,不编造
  assert.deepEqual(modelsOf({ models: [] }), []);
  assert.deepEqual(modelsOf({}), []);
  assert.deepEqual(modelsOf(null), []);
  assert.deepEqual(modelsOf(undefined), []);
  // 不修改入参
  const provider = { models: ['a', 'a'], model: 'b' };
  modelsOf(provider);
  assert.deepEqual(provider, { models: ['a', 'a'], model: 'b' });
});
