'use strict';
// mixctl explain 的离线回归:只连本测试自己起的回环端口,不启动常驻服务、不碰真实 HOME 配置。
// 每个用例都核对"到底发没发请求、发了什么",参数错误一律必须在发 HTTP 之前就失败。
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MIXCTL = path.join(ROOT, 'mixctl');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixctl-explain-'));

// 服务端行为开关:每个用例只改这个,请求仍走真实 HTTP。
let mode = 'ok';
let requests = [];
let server;

// 真实预览的命中来源只剩三种:compact / slot / model(规则与兜底阶段已删除)。
const PREVIEW = {
  ok: true,
  input: { app: 'claude', model: 'demo', kind: 'messages' },
  matched: { via: 'model', ruleId: 'model:a', slot: null, strategy: 'round_robin' },
  selection: {
    source: 'strategy', strategy: 'round_robin', deterministic: true,
    predicted: { providerId: 'a', providerName: '渠道A', model: 'a-out' },
    candidates: ['a', 'b'], note: '轮询:按当前游标的下一位(预览不消耗游标,实跑会前移)',
  },
  warnings: [{ code: 'new_session_preview', message: '未提供完整会话键,按新会话预览' }],
  limits: { rulesTraced: 3, rulesOmitted: 0, truncated: false },
};

function respond(req, res, body) {
  res.setHeader('Content-Type', 'application/json');
  if (mode === 'http400') { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: { code: 'bad_app', message: 'app 必须是 claude 或 codex' } })); }
  if (mode === 'http403-plain') { res.statusCode = 403; return res.end(JSON.stringify({ error: '跨站请求被拒绝' })); }
  if (mode === 'not-json') return res.end('<!doctype html><h1>502</h1>');
  if (mode === 'oversize') return res.end(`{"ok":true,"pad":"${'x'.repeat(3 * 1024 * 1024)}"}`);
  if (mode === 'reset-before-headers') return res.socket.destroy();
  if (mode === 'trickle') {
    // 已发响应头,然后一直滴数据:总时限必须不因"还在收"而无限续期。
    return res.write('{"ok":true');
  }
  res.end(JSON.stringify(body === undefined ? PREVIEW : body));
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, type: req.headers['content-type'], raw });
      if (mode === 'truncate-after-headers') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '900' });
        res.write('{"ok":true');
        return void setTimeout(() => res.socket.destroy(), 120);
      }
      respond(req, res);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});
beforeEach(() => { mode = 'ok'; requests = []; });
after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
});

function run(args, { stdin, keepStdinOpen = false, env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [MIXCTL, ...args], {
      cwd: ROOT, env: { ...process.env, MIXUI_PORT: String(server.address().port), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdin.on('error', () => {}); // 子进程提前退出时父侧写 stdin 会得到 EPIPE,与本用例无关
    if (keepStdinOpen) child.stdin.write('{"app":"claude"'); // 一直不 end:模拟读不完的输入
    else if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin);
    // 用例挂住时必须留下痕迹,不能靠外层 30s 超时把"其实没退出"报成别的失败。
    const kill = setTimeout(() => { child.kill('SIGKILL'); }, 20000);
    child.on('close', code => {
      clearTimeout(kill);
      resolve({ code, output });
    });
  });
}

const json = output => { try { return JSON.parse(output); } catch { return null; } };

test('explain 走 POST /api/routing/preview,只发 app/model,并按 JSON 原样回显', async () => {
  const r = await run(['explain', 'claude', 'demo', '--json']);
  assert.equal(r.code, 0);
  assert.equal(requests.length, 1);
  assert.deepEqual({ method: requests[0].method, url: requests[0].url, type: requests[0].type },
    { method: 'POST', url: '/api/routing/preview', type: 'application/json' });
  assert.deepEqual(JSON.parse(requests[0].raw), { app: 'claude', model: 'demo' });
  assert.deepEqual(json(r.output), PREVIEW, '--json 输出必须与服务返回等价,不额外包装');
});

test('--kind 与完整会话键进 body,短 id 在本地就被拦下', async () => {
  const ok = await run(['explain', 'codex', 'demo', '--kind', 'chat/completions', '--session', 'cx:full-key-here']);
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(requests[0].raw),
    { app: 'codex', model: 'demo', kind: 'chat/completions', context: { session: 'cx:full-key-here' } });
  requests = [];
  const short = await run(['explain', 'claude', 'demo', '--session', 'short-id']);
  assert.equal(short.code, 1);
  assert.match(short.output, /完整会话键/);
  assert.equal(requests.length, 0, '会话键不合法时不得发请求');
});

test('自然语言摘要给出命中来源、首选与范围说明', async () => {
  const r = await run(['explain', 'claude', 'demo']);
  assert.equal(r.code, 0);
  assert.match(r.output, /命中: model model:a/);
  assert.match(r.output, /首选来源: strategy/);
  assert.match(r.output, /渠道A \(a\) @ a-out/);
  assert.match(r.output, /提醒 \[new_session_preview\]/);
  assert.equal(r.output.includes('{"ok"'), false, '非 --json 不应吐原始 JSON');
});

test('槽位与压缩命中的摘要各自打出来源与槽名', async () => {
  const previous = PREVIEW.matched;
  try {
    PREVIEW.matched = { via: 'slot', ruleId: 'slot:claude/main', slot: 'main', strategy: 'priority' };
    const slot = await run(['explain', 'claude', 'mixr-main']);
    assert.equal(slot.code, 0);
    assert.match(slot.output, /命中: slot slot:claude\/main  槽位 main/);
    PREVIEW.matched = { via: 'compact', ruleId: 'compact-global', slot: null, strategy: 'priority' };
    const compact = await run(['explain', 'claude', 'mixr-main']);
    assert.equal(compact.code, 0);
    assert.match(compact.output, /命中: compact compact-global/);
  } finally { PREVIEW.matched = previous; }
});

test('不确定首选时摘要列出候选渠道,不假装知道落点', async () => {
  const previous = PREVIEW.selection;
  PREVIEW.selection = { ...previous, deterministic: false, predicted: null };
  try {
    const r = await run(['explain', 'claude', 'demo']);
    assert.equal(r.code, 0);
    assert.match(r.output, /可选渠道: a \/ b/);
    assert.match(r.output, /不确定/);
  } finally { PREVIEW.selection = previous; }
});

test('--input 支持文件与 stdin,内容原样当请求体', async () => {
  const file = path.join(TMP, 'input.json');
  fs.writeFileSync(file, JSON.stringify({ app: 'codex', model: 'from-file', kind: 'responses' }));
  const fromFile = await run(['explain', '--input', file, '--json']);
  assert.equal(fromFile.code, 0);
  assert.deepEqual(JSON.parse(requests[0].raw), { app: 'codex', model: 'from-file', kind: 'responses' });
  requests = [];
  const body = JSON.stringify({ app: 'claude', model: 'from-stdin', context: { ua: 'ua-value' } });
  const fromStdin = await run(['explain', '--input', '-'], { stdin: body });
  assert.equal(fromStdin.code, 0);
  assert.deepEqual(JSON.parse(requests[0].raw), JSON.parse(body));
});

test('非法参数在发 HTTP 之前失败,--json 也给出可解析的结构', async () => {
  const cases = [
    { args: ['explain', 'wrong', 'demo', '--json'], code: 'invalid_input', why: 'app 非法' },
    { args: ['explain', 'claude', 'demo', '--kind', 'responses', '--json'], code: 'invalid_input', why: 'kind 不属于 claude 组' },
    { args: ['explain', 'codex', 'demo', '--kind', 'messages', '--json'], code: 'invalid_input', why: 'kind 不属于 codex 组' },
    { args: ['explain', 'claude', '--json'], code: 'invalid_arguments', why: '缺 model' },
    { args: ['explain', 'claude', 'demo', 'extra', '--json'], code: 'invalid_arguments', why: '多余位置参数' },
    { args: ['explain', 'claude', 'demo', '--nope', '--json'], code: 'invalid_arguments', why: '未知选项' },
    { args: ['explain', 'claude', 'demo', '--kind', 'messages', '--kind', 'messages', '--json'], code: 'invalid_arguments', why: '重复选项' },
    { args: ['explain', 'claude', 'demo', '--json', '--json'], code: 'invalid_arguments', why: '重复 --json' },
    { args: ['explain', 'claude', 'demo', '--kind', '--json'], code: 'invalid_arguments', why: '选项缺值' },
    { args: ['explain', '--input', '-', 'claude', 'demo', '--json'], code: 'invalid_arguments', why: '--input 与位置参数互斥' },
    { args: ['explain', '--token', 'plaintext-key', 'claude', 'demo', '--json'], code: 'invalid_arguments', why: '明文凭据必须被拒' },
  ];
  for (const { args, code, why } of cases) {
    const r = await run(args, { stdin: '{}' });
    assert.equal(r.code, 1, why);
    assert.equal(json(r.output) && json(r.output).ok, false, why);
    assert.equal(json(r.output).error.code, code, why);
  }
  assert.equal(requests.length, 0, '参数错误一律不得发请求');
});

test('--input 的非法 JSON 与不可读文件都在本地失败', async () => {
  const bad = path.join(TMP, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  const cases = [
    [['explain', '--input', bad], /不是合法 JSON/],
    [['explain', '--input', path.join(TMP, 'missing.json')], /无法读取/],
    [['explain', '--input', TMP], /普通文件/],
  ];
  for (const [args, pattern] of cases) {
    const r = await run(args);
    assert.equal(r.code, 1);
    assert.match(r.output, pattern);
  }
  const empty = await run(['explain', '--input', '-', '--json'], { stdin: '' });
  assert.equal(empty.code, 1);
  assert.equal(json(empty.output).error.code, 'invalid_input_json');
  assert.equal(requests.length, 0);
});

test('超过 1 MiB 的输入文件与 stdin 都被拒,不发请求', async () => {
  const big = path.join(TMP, 'big.json');
  fs.writeFileSync(big, JSON.stringify({ app: 'claude', model: 'x'.repeat(1200000) }));
  for (const args of [['explain', '--input', big], ['explain', '--input', '-']]) {
    const r = await run(args, { stdin: JSON.stringify({ app: 'claude', model: 'y'.repeat(1200000) }) });
    assert.equal(r.code, 1);
    assert.match(r.output, /1 MiB 上限/);
  }
  assert.equal(requests.length, 0);
});

test('服务 4xx 结构被保留:对象错误取 code,字符串错误取 httpStatus', async () => {
  mode = 'http400';
  const structured = await run(['explain', 'claude', 'demo', '--json']);
  assert.equal(structured.code, 1);
  assert.deepEqual(json(structured.output), { ok: false, error: { code: 'bad_app', message: 'app 必须是 claude 或 codex' } });
  assert.equal(structured.output.includes('[object Object]'), false, '结构化错误不得被 Error() 吃掉成字符串占位符');
  const human = await run(['explain', 'claude', 'demo']);
  assert.match(human.output, /bad_app.*app 必须是 claude 或 codex/);
  assert.equal(human.output.includes('[object Object]'), false);
  mode = 'http403-plain';
  const plain = await run(['explain', 'claude', 'demo', '--json']);
  assert.equal(plain.code, 1);
  assert.deepEqual(json(plain.output),
    { ok: false, error: { code: 'preview_http_error', httpStatus: 403, message: '跨站请求被拒绝' } });
  const plainHuman = await run(['explain', 'claude', 'demo']);
  assert.match(plainHuman.output, /preview_http_error.*跨站请求被拒绝/);
});

test('非 JSON 响应与超限响应都有专门错误码', async () => {
  mode = 'not-json';
  const html = await run(['explain', 'claude', 'demo', '--json']);
  assert.equal(html.code, 1);
  assert.equal(json(html.output).error.code, 'invalid_response_json');
  mode = 'oversize';
  const huge = await run(['explain', 'claude', 'demo', '--json']);
  assert.equal(huge.code, 1);
  assert.equal(json(huge.output).error.code, 'response_too_large');
});

test('响应被截断与连接被 reset 分开报,不都说成连不上', async () => {
  mode = 'truncate-after-headers';
  const truncated = await run(['explain', 'claude', 'demo', '--json']);
  assert.equal(truncated.code, 1);
  assert.equal(json(truncated.output).error.code, 'response_aborted');
  mode = 'reset-before-headers';
  requests = [];
  const reset = await run(['explain', 'claude', 'demo', '--json']);
  assert.equal(reset.code, 1);
  assert.equal(json(reset.output).error.code, 'connection_reset');
  assert.equal(requests.length, 1, '这两种都建立过连接,与"连不上"不是一回事');
});

test('连不上服务时报 request_failed,并且不假装拿到结果', async () => {
  const net = require('node:net');
  const free = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const r = await run(['explain', 'claude', 'demo', '--json'], { env: { MIXUI_PORT: String(free) } });
  assert.equal(r.code, 1);
  assert.equal(json(r.output).error.code, 'request_failed');
});

test('总时限不因持续滴数据而续期,也不读不完 stdin 就挂住', async () => {
  mode = 'trickle';
  const started = Date.now();
  const trickled = await run(['explain', 'claude', 'demo', '--json']);
  assert.equal(trickled.code, 1);
  assert.equal(json(trickled.output).error.code, 'request_timeout');
  assert.ok(Date.now() - started < 15000, '必须在总时限内放弃,而不是被滴数据吊住');

  const held = await run(['explain', '--input', '-', '--json'], { keepStdinOpen: true });
  assert.equal(held.code, 1);
  assert.equal(json(held.output).error.code, 'input_timeout');
});

test('本地同步抛错也只给出结构化失败,不泄露 TDZ 之类的内部栈', async () => {
  // 反证:让 http.request 在同步路径上抛,确认失败是"照常报错"而不是
  // "Cannot access timer before initialization"这种内部错误。
  const preload = path.join(TMP, 'throw-http.js');
  fs.writeFileSync(preload,
    "const http = require('http');\nhttp.request = () => { throw new Error('SYNC-THROW-FROM-TEST'); };\n");
  const r = await run(['explain', 'claude', 'demo', '--json'], { env: { NODE_OPTIONS: `--require ${preload}` } });
  assert.equal(r.code, 1);
  const parsed = json(r.output);
  assert.ok(parsed && parsed.ok === false, '同步抛错也要留下可解析的失败对象');
  assert.equal(parsed.error.message, 'SYNC-THROW-FROM-TEST');
  for (const leak of ['before initialization', 'ReferenceError', 'at Object.', 'node:internal'])
    assert.equal(r.output.includes(leak), false, leak);
});

test('explain --help 打印用法且不发请求', async () => {
  const r = await run(['explain', '--help']);
  assert.equal(r.code, 0);
  assert.match(r.output, /mixctl explain <claude\|codex> <model>/);
  assert.match(r.output, /--input <file\|->/);
  assert.equal(requests.length, 0);
});
