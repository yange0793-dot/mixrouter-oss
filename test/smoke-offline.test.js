'use strict';
// smoke-offline 的验收脚本自身的测试。
//
// 为什么单独测:scripts/ 下没有别的东西被包进 CI,验收脚本又是"唯一会被拿来判断
// 这台机器能不能跑"的东西——它自己坏了(隔离失效/清理漏掉/报告永远打 PASS)
// 比它没写更糟。这里不 require mixrouter.js、不起服务、不出网,只单测它导出的零件:
//   1. 隔离:子进程环境不能残留调用方 shell 的 MIXR_* 残值,端口必须是内核分配且避开现役端口
//   2. mock 上游:三种协议的形状能被真客户端解析(尤其是 usage 与终态事件)
//   3. 清理:临时目录与子进程都要被收干净
//   4. 汇报:报告格式稳定(通过项逐条列出、失败项带 detail、汇总行给 x/y)
//
// 端到端那一趟不在这里跑(它要起进程、跑两秒,是 scripts/smoke-offline.js 自己的活);
// 这里只钉住"它宣称自己做到的那些保证"确实成立。
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const smoke = require('../scripts/smoke-offline.js');

// ---------------------------------------------------------------- 隔离

test('childEnv:调用方 shell 里的 MIXR_/MIXROUTER_/MIXUI_ 残值一律不带给子进程', () => {
  const keys = ['MIXR_DATA_DIR', 'MIXR_CLAUDE_SETTINGS', 'MIXR_CODEX_CONFIG',
    'MIXR_UPSTREAM_PROXY', 'MIXR_UPSTREAM_PROXY_BYPASS', 'MIXROUTER_PORT',
    'MIXUI_PORT', 'MIXROUTER_ALT_PORTS', 'MIXR_TOTAL_DEADLINE_MS',
    // 已移除的 Harness 集成留下的 DSH_HOME 不带 MIXR_ 前缀,只能按名字剔 —— 放进这组
    // 残值里才能真的验证它没被带下去。
    'DSH_HOME'];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; process.env[k] = 'MUST-NOT-LEAK'; }
  try {
    const env = smoke.childEnv({ proxy: 1111, ui: 2222 }, { home: '/tmp/h', data: '/tmp/d' });
    for (const k of keys) assert.notStrictEqual(env[k], 'MUST-NOT-LEAK', `${k} 把调用方残值带下去了`);
    // 该显式给的一个都不能少
    assert.strictEqual(env.MIXR_DATA_DIR, '/tmp/d');
    assert.strictEqual(env.HOME, '/tmp/h');
    assert.strictEqual(env.MIXR_CLAUDE_SETTINGS, '/tmp/h/.claude/settings.json');
    assert.strictEqual(env.MIXR_CODEX_CONFIG, '/tmp/h/.codex/config.toml');
    // 已移除的客户端/集成:既不继承残值,也不再显式重定向(没有落点可指)。
    for (const k of ['MIXR_ZCODE_CONFIG', 'MIXR_HARNESS_PROFILE']) assert.strictEqual(env[k], undefined, k);
    assert.strictEqual(env.DSH_HOME, undefined, 'DSH_HOME 残值不该带下去');
    assert.strictEqual(env.MIXROUTER_PORT, '1111');
    assert.strictEqual(env.MIXUI_PORT, '2222');
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('childEnv:HOME 指向临时目录,所以没被显式覆盖的落点也隔离得住', () => {
  const env = smoke.childEnv({ proxy: 1, ui: 2 }, { home: '/tmp/only-home', data: '/tmp/d' });
  for (const [k, v] of Object.entries(env)) {
    if (!/^(MIXR_|MIXROUTER_|MIXUI_)/.test(k)) continue;
    if (v === '') continue;                       // 显式置空(如 MIXR_UPSTREAM_PROXY)
    assert.ok(!v.includes(os.homedir()) || v.startsWith('/tmp/only-home'),
      `${k}=${v} 指到了真实 HOME 下`);
  }
  assert.strictEqual(env.MIXR_UPSTREAM_PROXY, '', '出站隧道必须显式置空,否则会继承调用方的隧道');
});

test('childEnv:验收用的超时比默认值紧,失败要几秒内暴露', () => {
  const env = smoke.childEnv({ proxy: 1, ui: 2 }, { home: '/tmp/h', data: '/tmp/d' });
  assert.ok(Number(env.MIXR_TOTAL_DEADLINE_MS) <= 60000, `总预算 ${env.MIXR_TOTAL_DEADLINE_MS} 太宽,验收会挂很久`);
  assert.ok(Number(env.MIXR_FIRST_HEADER_TIMEOUT_MS) <= 10000, '首字节超时太宽');
});

test('freePort:拿到的是真实可用端口,且不落在现役 8787/8788 上', async () => {
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    const p = await smoke.freePort();
    assert.ok(Number.isInteger(p) && p > 0 && p < 65536, `端口不是合法整数:${p}`);
    assert.ok(!smoke.RESERVED_PORTS.includes(p), `内核给到了现役端口 ${p}`);
    seen.add(p);
  }
  assert.ok(seen.size >= 2, '八次全拿到同一个端口,内核分配没生效');
});

// ---------------------------------------------------------------- mock 上游

function post(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: p,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      const cs = [];
      res.on('data', c => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(cs).toString('utf8') }));
    });
    r.on('error', reject);
    r.end(data);
  });
}

test('mock 上游:Anthropic 非流的 usage 齐全,且两次请求都记进 seen', async t => {
  const mock = smoke.createMockUpstream();
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => mock.server.close(r)));
  const port = mock.server.address().port;

  const a = await post(port, '/v1/messages', { model: 'm1', messages: [] });
  assert.strictEqual(a.status, 200);
  const j = JSON.parse(a.text);
  assert.strictEqual(j.type, 'message');
  assert.strictEqual(j.content[0].text, smoke.MOCK_PREFIX + 'm1');
  assert.strictEqual(j.usage.input_tokens, 17);
  assert.strictEqual(j.usage.cache_read_input_tokens, 5);

  const b = await post(port, '/v1/messages', { model: 'm2', messages: [], stream: true });
  assert.match(String(b.headers['content-type']), /text\/event-stream/);
  assert.ok(b.text.includes('event: message_stop'), 'Anthropic 流必须以 message_stop 收尾');
  assert.ok(b.text.includes(smoke.MOCK_PREFIX + 'm2'));

  assert.strictEqual(mock.seen.length, 2);
  assert.strictEqual(mock.seen[0].url, '/v1/messages');
  assert.strictEqual(mock.seen[0].body.model, 'm1', 'seen 里要能读出上游真正收到的模型名');
});

test('mock 上游:Anthropic 流的 usage 只放 message_delta,不被首匹配抠成 0', async t => {
  const mock = smoke.createMockUpstream();
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => mock.server.close(r)));
  const r = await post(mock.server.address().port, '/v1/messages', { model: 'm', messages: [], stream: true });
  // 这是 glm-5.3 一类网关的真实形状,也是 mixrouter 那个"取最后一次出现"的依据
  assert.ok(/"input_tokens":0/.test(r.text), 'message_start 里应当是 0');
  assert.ok(/"input_tokens":17/.test(r.text), '真值应当在 message_delta 里');
});

test('mock 上游:responses 流有完整终态,usage 带 cached_tokens', async t => {
  const mock = smoke.createMockUpstream();
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => mock.server.close(r)));
  const port = mock.server.address().port;

  const s = await post(port, '/v1/responses', { model: 'g', input: [], stream: true });
  const lines = s.text.trim().split('\n').filter(l => l.startsWith('data: '));
  assert.ok(lines.length >= 5, `SSE 事件太少:${lines.length}`);
  const events = lines.map(l => JSON.parse(l.slice(6)).type);
  assert.strictEqual(events[0], 'response.created');
  assert.strictEqual(events[events.length - 1], 'response.completed', '最后一条必须是 completed');
  assert.ok(events.includes('response.output_text.delta'));
  const done = JSON.parse(lines[lines.length - 1].slice(6));
  assert.strictEqual(done.response.usage.input_tokens_details.cached_tokens, 4);

  const j = await post(port, '/v1/responses', { model: 'g', input: [] });
  const body = JSON.parse(j.text);
  assert.strictEqual(body.object, 'response');
  assert.strictEqual(body.status, 'completed');
  assert.strictEqual(body.output[0].content[0].text, smoke.MOCK_PREFIX + 'g');
});

test('mock 上游:chat 只在客户端要 usage 时才给 usage', async t => {
  const mock = smoke.createMockUpstream();
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => mock.server.close(r)));
  const port = mock.server.address().port;

  const noUsage = await post(port, '/v1/chat/completions', { model: 'c', messages: [], stream: true });
  assert.ok(noUsage.text.includes('data: [DONE]'), 'chat 流必须以 [DONE] 收尾');
  assert.ok(!noUsage.text.includes('"prompt_tokens"'), '没要 usage 就不该给');

  const withUsage = await post(port, '/v1/chat/completions',
    { model: 'c', messages: [], stream: true, stream_options: { include_usage: true } });
  assert.ok(withUsage.text.includes('"prompt_tokens":21'), '要了 usage 就必须给');

  const j = await post(port, '/v1/chat/completions', { model: 'c', messages: [] });
  assert.strictEqual(JSON.parse(j.text).choices[0].message.content, smoke.MOCK_PREFIX + 'c');
});

test('mock 上游:chat 流带 finish_reason 终态块,且排在 usage 之前、[DONE] 之前', async t => {
  const mock = smoke.createMockUpstream();
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => mock.server.close(r)));
  const port = mock.server.address().port;

  const r = await post(port, '/v1/chat/completions',
    { model: 'c', messages: [], stream: true, stream_options: { include_usage: true } });
  const chunks = r.text.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6).trim());
  assert.strictEqual(chunks[chunks.length - 1], '[DONE]', '最后必须是 [DONE]');
  const objs = chunks.slice(0, -1).map(c => JSON.parse(c));
  const finIdx = objs.findIndex(o => o.choices && o.choices.some(ch => ch.finish_reason === 'stop'));
  assert.ok(finIdx >= 0, 'missing finish_reason 终态块:转换层只能靠断流收尾了');
  const usageIdx = objs.findIndex(o => o.usage);
  assert.ok(usageIdx > finIdx, `usage 块应排在 finish_reason 之后(finish=${finIdx}, usage=${usageIdx})`);
  // finish_reason 块的 delta 必须是空的:带正文会让转换层多发一段重复文本
  const fin = objs[finIdx].choices[0];
  assert.deepStrictEqual(fin.delta, {}, 'finish_reason 块的 delta 必须为空');

  // 没要 usage 时,finish_reason 仍要给
  const noUsage = await post(port, '/v1/chat/completions', { model: 'c', messages: [], stream: true });
  assert.ok(noUsage.text.includes('"finish_reason":"stop"'), '没要 usage 也必须给终态');
});

test('mock 上游:非 POST 一律 404,不会静默 200', async t => {
  const mock = smoke.createMockUpstream();
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => mock.server.close(r)));
  const port = mock.server.address().port;
  const code = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/v1/messages' }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.strictEqual(code, 404);
  assert.strictEqual(mock.seen.length, 0, '非 POST 不该记进 seen');
});

// ---------------------------------------------------------------- 临时配置

test('writeTmpConfig:Key 是编的占位串,base_url 指向 mock,且建好 logs/', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-smoke-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  smoke.writeTmpConfig(dir, 'http://127.0.0.1:19999');

  assert.ok(fs.existsSync(path.join(dir, 'logs')), 'logs/ 必须由本脚本建:mixrouter.js 自己不会创建它');
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8'));
  const all = [...p.claude, ...p.codex];
  assert.strictEqual(all.length, 4);
  for (const prov of all) {
    assert.strictEqual(prov.base_url, 'http://127.0.0.1:19999');
    assert.match(prov.api_key, /^sk-smoke-/, '占位 Key 应当一眼看得出是编的');
  }
  // 三条 Claude 渠道分别覆盖直通 / responses / chat 三条出站线,少一条验收就漏一条线
  assert.deepStrictEqual(p.claude.map(x => x.wire_api || 'anthropic'), ['anthropic', 'responses', 'chat']);
  assert.strictEqual(p.codex[0].wire_api, 'responses');
  assert.strictEqual(p.current.claude, null, '临时库不该有 current,否则控制台显示漂移');

  const r = JSON.parse(fs.readFileSync(path.join(dir, 'routes.json'), 'utf8'));
  assert.strictEqual(r.rules.length, 4);
  for (const rule of r.rules) {
    assert.ok(rule.provider && rule.provider !== '', `规则 ${rule.id} 没绑渠道`);
    assert.ok(rule.match, `规则 ${rule.id} 的 match 为空会截胡所有请求`);
  }
  // 每条规则绑的渠道必须真在同组的库里:绑错了会静默 503,验收变成假绿灯
  const claudeIds = p.claude.map(x => x.id), codexIds = p.codex.map(x => x.id);
  for (const rule of r.rules) {
    const pool = rule.app === 'codex' ? codexIds : claudeIds;
    assert.ok(pool.includes(rule.provider), `规则 ${rule.id} 绑的 ${rule.provider} 不在 ${rule.app} 组里`);
  }
});

test('writeTmpConfig 可以被调用两次(不抛),且第二次不会把第一次的内容叠加', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-smoke-test2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  smoke.writeTmpConfig(dir, 'http://127.0.0.1:19999');
  smoke.writeTmpConfig(dir, 'http://127.0.0.1:18888');
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8'));
  assert.strictEqual(p.claude.length + p.codex.length, 4, '第二次应当是整体覆盖而不是累加');
  assert.strictEqual(p.claude[0].base_url, 'http://127.0.0.1:18888');
});

// ---------------------------------------------------------------- 工具函数

test('statSafe 已移除:脚本不再对运行中用户的文件做存在性/内容推断', () => {
  // 这条是负向锁:真实 HOME 下的客户端配置与仓库根的运行时文件都是"运行中本来就会变"
  // 的东西,拿它们的 mtime 判断本脚本有没有污染只会误报(其它会话正常改写就中招)。
  // 要防污染,只能靠严格的环境隔离 + 临时 HOME 里的哨兵,不能靠监视别人的文件。
  assert.strictEqual(smoke.statSafe, undefined, 'statSafe 又回来了:它会去 stat 真实 HOME');
  assert.strictEqual(typeof smoke.withDeadline, 'function', '清理必须带截止时间');
});

test('req:响应被截断必须 reject,不能悬着(两条收场路径都要覆盖)', async t => {
  // 截断有两种收场,走的是**不同的**错误来源(实测 Node 24):
  //   · 干净 FIN 但响应没收完 → 响应对象上发 'aborted'
  //   · 对端 RST(直接 destroy) → 只有请求对象上的 'error'
  // 两种都必须让 req 以错误收场,'end' 永远不来时 promise 不能悬着。
  const srv = http.createServer((creq, cres) => {
    if (creq.url === '/fin') {                     // Content-Length 说 100,只给 5 字节然后正常 FIN
      cres.writeHead(200, { 'Content-Length': '100' });
      cres.write('short');
      return cres.socket.end();
    }
    cres.writeHead(200);                           // 默认分支:写一半直接 RST
    cres.write('partial');
    cres.destroy();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => srv.close(r)));
  const port = srv.address().port;

  for (const [p, what] of [['/fin', '干净 FIN 截断'], ['/rst', 'RST 截断']]) {
    await assert.rejects(
      () => smoke.req(port, 'GET', p, { timeoutMs: 5000 }),
      e => /aborted|响应错误|ECONNRESET|socket hang up/i.test(e.message),
      `${what}必须让 req 以错误收场`);
  }
});

test('withDeadline:清理卡住要报错,不能把脚本永远吊住', async () => {
  let settled = null;
  await smoke.withDeadline('永不 resolve 的清理', () => new Promise(() => {}), 60)
    .then(() => { settled = 'resolved'; }, e => { settled = e.message; });
  assert.match(settled, /超过 60ms 未完成/, `期望超时报错,实际 ${settled}`);

  // 正常路径:动作完成就返回,不吃满截止时间
  const t0 = Date.now();
  await smoke.withDeadline('立刻完成', () => Promise.resolve(), 5000);
  assert.ok(Date.now() - t0 < 1000, '正常清理不该等满截止时间');

  // 动作**抛错**时要原样抛出,不能被当成"超时"吞掉(否则清理失败会被报成通过)
  await assert.rejects(
    () => smoke.withDeadline('抛错的清理', () => { throw new Error('清理动作自己炸了'); }, 5000),
    /清理动作自己炸了/);
});

test('req 超时:对端不收不发时必须自己死,不能挂住整个验收', async t => {
  // 起一个"接住连接但永不回应"的 server,模拟挂死的上游
  const dead = http.createServer(() => { /* 故意不响应 */ });
  await new Promise(r => dead.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => dead.close(r)));
  const t0 = Date.now();
  await assert.rejects(
    () => smoke.req(dead.address().port, 'GET', '/healthz', { timeoutMs: 300 }),
    e => /无响应|ECONNRESET|socket hang up/.test(e.message),
    '挂死的对端必须让 req 以错误收场');
  assert.ok(Date.now() - t0 < 5000, '超时参数没被用上,等了太久');
});

// ---------------------------------------------------------------- 端口归属硬闸门

// payload 可后置:有些用例要报告"真实监听的端口",而那要到 listen 之后才知道
function fakeStateServer(payload) {
  const box = { payload };
  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify(box.payload));
  });
  return { srv, box };
}

test('assertPortsOwned:别人的实例占着端口时必须中止(否则业务请求会打到真渠道上)', async t => {
  const { srv } = fakeStateServer({ pid: 999999, proxy_port: 1, ui_port: 2 });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => srv.close(r)));
  const ui = srv.address().port;
  const child = { pid: 4242, exitCode: null, signalCode: null };
  await assert.rejects(
    () => smoke.assertPortsOwned(child, { spawnError: null }, { proxy: 1, ui }, () => '(logs)'),
    e => /端口被抢占/.test(e.message) && e.message.includes('999999'),
    'pid 对不上必须抛错中止,不能记一条 FAIL 就继续');
});

test('assertPortsOwned:自报端口与本次拉起的不一致也要中止', async t => {
  const { srv } = fakeStateServer({ pid: 4242, proxy_port: 55555, ui_port: 66666 });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => srv.close(r)));
  const ui = srv.address().port;
  const child = { pid: 4242, exitCode: null, signalCode: null };
  await assert.rejects(
    () => smoke.assertPortsOwned(child, { spawnError: null }, { proxy: 1, ui }, () => '(logs)'),
    /端口归属不一致/);
});

test('assertPortsOwned:pid 与端口全对时放行,并返回 state', async t => {
  // fake server 用内核分配的端口。**绝不能**在这里用 8787/8788——那会连到真实的常驻实例上
  // (写这条测试时自己踩过一次,正是硬闸门把它拦下来的)。
  const { srv, box } = fakeStateServer(null);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => srv.close(r)));
  const ui = srv.address().port;
  assert.ok(!smoke.RESERVED_PORTS.includes(ui), 'fake server 落到了现役端口上');
  box.payload = { pid: 4242, proxy_port: 1, ui_port: ui };   // 报告的就是它真正监听的端口
  const child = { pid: 4242, exitCode: null, signalCode: null };
  const st = await smoke.assertPortsOwned(child, { spawnError: null }, { proxy: 1, ui }, () => '');
  assert.strictEqual(st.pid, 4242);
  assert.strictEqual(st.ui_port, ui);
});

test('assertPortsOwned:子进程起不来时立刻抛,不去请求不存在的端口', async () => {
  const child = { pid: undefined, exitCode: null, signalCode: null };
  await assert.rejects(
    () => smoke.assertPortsOwned(child, { spawnError: new Error('spawn ENOENT') }, { proxy: 1, ui: 2 }, () => '(logs)'),
    /子进程起不来:spawn ENOENT/);
});
