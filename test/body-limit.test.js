'use strict';
// 请求体上限与超限排空的回归:MIXR_BODY_LIMIT_MB / MIXR_BODY_DRAIN_MS 的解析,以及
// 「客户端超限后停住不发」时服务端必须在时限内主动给出 413。
//
// 为什么单独一个文件、还要开子进程:这两个值都是**模块加载时**读一次环境变量算出来的常量,
// 同一进程里改了 env 再 require 只会拿到缓存。所以每个取值都在子进程里 require 一次,
// 把 _state 上的只读值报回来。
// 子进程能正常退出这件事本身也是一条证据:require 本模块不会起监听、不会注册信号。
//
// 要钉死的事故:上限原先写成 Number(process.env.MIXR_BODY_LIMIT_MB || 64),
// 传个非数字就得到 NaN,而 `size > NaN` 恒为 false —— 上限静默失效,多大的请求体都照收,
// 且日志与报错里一个字节都看不出上限没了。
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MB = 1024 * 1024;
// 子进程侧的探针:只读三个常量,不发请求、不写文件
const PROBE = 'const m = require(process.argv[1]);'
  + 'process.stdout.write(JSON.stringify({ body: m._state.bodyLimit, drain: m._state.bodyDrainExtra,'
  + ' drainMs: m._state.bodyDrainMs }));';

// 全部运行时路径都指向本次新建的临时目录,不碰真实配置
function limitsFor(value, drainMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-bodylimit-'));
  try {
    const env = {
      ...process.env,
      HOME: dir,
      MIXR_DATA_DIR: dir,
      MIXR_CLAUDE_SETTINGS: path.join(dir, 'settings.json'),
      MIXR_CODEX_CONFIG: path.join(dir, 'config.toml'),
      MIXR_ZCODE_CONFIG: path.join(dir, 'zcode.json'),
      MIXROUTER_PORT: '0',
      MIXUI_PORT: '0',
    };
    if (value === undefined) delete env.MIXR_BODY_LIMIT_MB;
    else env.MIXR_BODY_LIMIT_MB = value;
    if (drainMs === undefined) delete env.MIXR_BODY_DRAIN_MS;
    else env.MIXR_BODY_DRAIN_MS = drainMs;
    const out = execFileSync(process.execPath, ['-e', PROBE, path.join(ROOT, 'mixrouter.js')],
      { env, encoding: 'utf8', timeout: 20000 });
    const parsed = JSON.parse(out);
    // NaN 经 JSON.stringify 会变成 null,这里显式还原成"不是有限数"以便断言说得清
    return { body: parsed.body, drain: parsed.drain, drainMs: parsed.drainMs };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('MIXR_BODY_LIMIT_MB 非法值一律回落默认 64MB,不会变成 NaN 把上限静默取消', () => {
  // 逐个取值都断言,不用循环外的单次抽样:回落逻辑对"空串/空白/小数/负数/超上限/非数字"
  // 走的是同一条校验,但每一条都是真实会被写进 launchd plist 或 shell 的形态
  for (const bad of ['abc', '', '   ', '1.5', 'Infinity', 'NaN', 'null', 'undefined', '-3', '0', '99999']) {
    const { body, drain } = limitsFor(bad);
    assert.strictEqual(body, 64 * MB, `MIXR_BODY_LIMIT_MB=${JSON.stringify(bad)} 应回落默认 64MB`);
    assert.ok(Number.isFinite(body), `MIXR_BODY_LIMIT_MB=${JSON.stringify(bad)} 的上限必须是有限数,NaN 等于没有上限`);
    assert.strictEqual(drain, Math.min(body, 32 * MB), '排空预算取 min(上限, 32MB)');
  }
});

test('MIXR_BODY_LIMIT_MB 合法值按 MB 生效,排空预算不超过 32MB', () => {
  const cases = [
    [undefined, 64 * MB, 32 * MB],   // 不设 = 默认 64MB,排空预算被 32MB 夹住
    ['1', 1 * MB, 1 * MB],           // 小上限时排空预算等于上限本身
    ['2', 2 * MB, 2 * MB],
    ['32', 32 * MB, 32 * MB],
    ['64', 64 * MB, 32 * MB],
    ['2048', 2048 * MB, 32 * MB],    // 上界仍然接受
  ];
  for (const [value, wantBody, wantDrain] of cases) {
    const { body, drain } = limitsFor(value);
    const label = value === undefined ? '(未设置)' : JSON.stringify(value);
    assert.strictEqual(body, wantBody, `MIXR_BODY_LIMIT_MB=${label} 的上限`);
    assert.strictEqual(drain, wantDrain, `MIXR_BODY_LIMIT_MB=${label} 的排空预算`);
  }
});

test('排空预算恒为正且不超过上限,否则超限后要么不排空要么无限排空', () => {
  // 排空是为了让 413 真能送达(请求体没收完就结束响应,Node 会销毁 socket),
  // 预算为 0 等于回到"立刻发响应+掀连接",预算无上限等于让一直灌的客户端占死连接
  for (const value of [undefined, '1', '64', '2048']) {
    const { body, drain } = limitsFor(value);
    assert.ok(drain > 0, '排空预算必须为正');
    assert.ok(drain <= body, '排空预算不该超过上限本身');
    assert.ok(drain <= 32 * MB, '排空预算有 32MB 硬顶');
  }
});

test('MIXR_BODY_DRAIN_MS 非法值回落默认 10s,且允许 0(0 = 不设时限,是有意义的取值)', () => {
  for (const bad of ['abc', '', '   ', '1.5', 'Infinity', 'NaN', '-1', '999999']) {
    const { drainMs } = limitsFor('1', bad);
    assert.strictEqual(drainMs, 10000, 'MIXR_BODY_DRAIN_MS=' + JSON.stringify(bad) + ' 应回落默认 10000ms');
  }
  // 与上限那两个旋钮不同:这里 min 是 0,因为"不设时限"是一个正当选择
  // (设了 0 就等于回到"一直等到 Node 自己的 requestTimeout"),不能被当成非法值回落掉
  assert.strictEqual(limitsFor('1', '0').drainMs, 0, 'MIXR_BODY_DRAIN_MS=0 必须真的生效为 0,不能回落默认');
  assert.strictEqual(limitsFor('1', '300').drainMs, 300);
  assert.strictEqual(limitsFor('1', '600000').drainMs, 600000, '上界仍然接受');
  assert.strictEqual(limitsFor('1').drainMs, 10000, '不设时取默认 10000ms');
});

// 「客户端超限之后停住不发」的场景脚本。
// 为什么要开子进程跑:BODY_DRAIN_MS 是模块加载时的常量,得用小的值(300ms)才测得快;
// 而本文件所在的测试进程已经用别的 env require 过 mixrouter.js 了。
// 客户端声明完整 content-length 却只发一部分、永不 end —— 这正是排空字节预算撞不到、
// `end` 也永远不来的那种客户端。修复前它会一直挂到 Node 的 requestTimeout(默认 300s)。
const STALL_SCENARIO = `
const http = require('node:http');
const path = require('node:path');
const mod = require(path.join(process.argv[2], 'mixrouter.js'));
const prefix = Buffer.alloc(1024 * 1024 + 65536, 120);
const server = http.createServer((req, res) => mod.proxyHandler(req, res));
let client = null;
let t0 = Date.now();
let before = 0;
let settled = false;
function report(status, error) {
  if (settled) return;
  settled = true;
  process.stdout.write(JSON.stringify({
    status: status === undefined ? null : status,
    error: error || null,
    elapsedMs: Date.now() - t0,
    timeoutsDelta: mod._state.bodyDrainTimeouts - before,
  }));
  if (client) { try { client.destroy(); } catch (e) {} }
  try { server.closeAllConnections(); } catch (e) {}
  try { server.close(() => {}); } catch (e) {}
  setTimeout(() => process.exit(0), 100);
}
server.listen(0, '127.0.0.1', () => {
  t0 = Date.now();
  before = mod._state.bodyDrainTimeouts;
  client = http.request({
    hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: '/v1/messages',
    headers: { 'content-length': prefix.length + 65536, connection: 'close', 'content-type': 'application/json' },
  }, res => {
    res.resume();
    res.on('end', () => report(res.statusCode));
    res.on('error', e => report(undefined, e.code));
  });
  client.setTimeout(20000, () => { if (client) { try { client.destroy(); } catch (e) {} } report(undefined, 'TIMEOUT'); });
  client.on('error', e => report(undefined, e.code));
  client.write(prefix);
});
`;

test('客户端超限后停住不发:服务端在排空时限内主动给 413,不挂到 Node 的 requestTimeout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-stall-'));
  const script = path.join(dir, 'stall-scenario.js');
  fs.writeFileSync(script, STALL_SCENARIO);
  try {
    const env = {
      ...process.env,
      HOME: dir,
      MIXR_DATA_DIR: dir,
      MIXR_CLAUDE_SETTINGS: path.join(dir, 'settings.json'),
      MIXR_CODEX_CONFIG: path.join(dir, 'config.toml'),
      MIXR_ZCODE_CONFIG: path.join(dir, 'zcode.json'),
      MIXROUTER_PORT: '0',
      MIXUI_PORT: '0',
      MIXR_BODY_LIMIT_MB: '1',
      MIXR_BODY_DRAIN_MS: '300',
    };
    const out = execFileSync(process.execPath, [script, ROOT], { env, encoding: 'utf8', timeout: 30000 });
    const r = JSON.parse(out);
    // 上界给 3000ms:时限是 300ms,留十倍余量给慢机器。这条要拦的是"挂到 300s",
    // 量级差三个数量级,不需要贴着时限断言(贴着断言才是偶发红的来源)。
    assert.strictEqual(r.error, null, '应当拿到响应而不是连接错误:' + JSON.stringify(r));
    assert.strictEqual(r.status, 413, '停住的客户端也应当收到 413:' + JSON.stringify(r));
    assert.ok(r.elapsedMs < 3000, '应在排空时限量级内响应,实测 ' + r.elapsedMs + 'ms:' + JSON.stringify(r));
    // 断言走的是**超时兜底**这条路,而不是碰巧有别的事件先到:计数器是服务端侧的确定事实
    assert.strictEqual(r.timeoutsDelta, 1, 'bodyDrainTimeouts 应恰好 +1:' + JSON.stringify(r));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
