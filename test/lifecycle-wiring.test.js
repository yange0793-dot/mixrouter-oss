'use strict';
// mixrouter.js 把 lib/server/lifecycle.js 接进生产启动路径之后的**接线**回归。
//
// 接线本身看着像搬代码,实际是改关停语义:现役是「同步落盘四个目标 + process.exit(0)」,
// 不排空;接线后要先排空在途响应再落盘。真正会出事的地方不在排空本身,而在**时间预算**:
//   mixctl stop():SIGTERM → 每 200ms 轮询 alive(pid) → 超过 4000ms 就 SIGKILL;
//   README 的 launchd plist:KeepAlive.SuccessfulExit=false ⇒ 被信号打死(非 0 退出)
//    会被**立刻重新拉起**。
// 合起来:排空 + 落盘一旦越过 4000ms,一次「停止」就退化成「丢状态 + 重启」。
// lifecycle 的默认排空上限是 15000,照默认接上去正好落进这条路径 —— 所以下面这条
// 预算断言是本文件的重点,它必须能在「有人把 drainTimeoutMs 改大」时变红。
//
// 判据的真值尽量**从源码取**(wiredDrainMs / budgetCeilingMs),不在这里另抄一份,
// 免得测试与实现各自漂移还互相点头。
//
// 全部 listen(0) 的用例都不碰 8787/8788(现役服务在跑),RESERVED_PORTS 硬闸门在公共
// 前置里逐个用例核对。涉及「停止」的用例只对**自己 spawn 的子进程**发信号,
// 绝不对任何现役 pid 发信号。
//
// ⚠ 反证时在本文件上单跑某几条断言是可行的,但**必须给足超时**:本文件曾在 Node 22 上
// 单跑任何一条都被判 `--test-timeout` 超时(文件级 cancelled,用例全 ok)。真因不是筛选
// ——本文件一个 t.after 都没有——而是 spawnShim 的超时看门狗用了 ref 状态的 setTimeout,
// 见下面 raceExit 的注释。修掉之后筛选矩阵全绿(连零匹配的 pattern 也是 exit 0)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'mixrouter.js');
const SHIM = path.join(__dirname, 'lifecycle-wiring-shim.js');
const REPO_MARKER = path.join(ROOT, 'lib', 'server', 'lifecycle.js');

// mixctl stop() 的强杀线(mixctl 的 stop():Date.now()-t0 > 4000 → SIGKILL)。
// 这是**外部**给的上限,写死在测试里当判据,不许跟着实现改动一起调。
const EXTERNAL_KILL_MS = 4000;
const MIN_FLUSH_BUDGET_MS = 1000;     // lifecycle 的落盘预算下限(排空后 flush 至少要留这么多)
const RESERVED_PORTS = [8787, 8788];

// ---------------------------------------------------------------- 判据的真值:从源码取
const entrySrc = () => fs.readFileSync(ENTRY, 'utf8');
const wiredDrainMs = () => Number(entrySrc().match(/drainTimeoutMs:\s*(\d+)/)[1]);
// 接线口径:排空上限 + 落盘下限 必须落在 mixctl 强杀线以内(余量留给进程启动/信号投递/抖动)
const budgetCeilingMs = () => wiredDrainMs() + MIN_FLUSH_BUDGET_MS;

// ---------------------------------------------------------------- 公共设施
// 保留端口硬闸门:写在注释里的约束不会被发现被违反,所以逐个用例真去连一下。
function connected(port) {
  return new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1');
    const done = v => { try { sock.destroy(); } catch {} resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 300);
  });
}
function guard(t) {
  for (const port of RESERVED_PORTS) assert.equal(typeof connected(port), 'object');
  t.diagnostic(`保留端口 ${RESERVED_PORTS.join('/')} 由公共前置核对`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 「等子进程退出,超时就判负」的看门狗。
//
// ⚠ 这里的定时器**必须 unref**,否则它会在孩子早已退出之后继续把事件循环吊住:
//   Promise.race 不会取消输的那一支,`sleep(40000)` 的定时器仍是 ref 状态,
//   于是**每个用到这条路径的用例都凭空多出最多 40s 的进程尾巴**。
//   CI 入口 scripts/run-tests.js 传的是 `--test-timeout=30000`,Node 22 把这截尾巴
//   算进**文件级**时长 → 文件被判 test timed out / cancelled(用例本身全绿)。
//   实测:本文件十条用例体合计 5.4s,进程却活 44.9s,差额正是这个定时器。
//
// unref 不会削弱看门狗:等待期间孩子的句柄本就在撑着事件循环,到点照常触发
//   (已独立实测:/tmp/unref-mech.js —— 活孩子在场时 unref 定时器照响)。
// 在 finally 里 clearTimeout,双保险。
function raceExit(exited, ms) {
  let wd;
  const timeout = new Promise(r => { wd = setTimeout(() => r(null), ms); if (wd.unref) wd.unref(); });
  return Promise.race([exited, timeout]).finally(() => clearTimeout(wd));
}

// 真发一次 HTTP(不是只看端口在不在):探针的 server 必须真能答。
function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

const tmpData = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-wiring-'));

// ---------------------------------------------------------------- 1) 静态接线判据
test('W1 只在 require.main 块里用 lifecycle;排空口径合规;保留合并后的导出契约', async t => {
  guard(t);
  const src = entrySrc();

  // (a) 落点:createLifecycle 只许出现在 require.main 块里。
  //     被测试 require 时行为必须一字不变(「不自动起服务、不吞异常」),所以这条要钉死。
  const mainAt = src.indexOf('if (require.main === module) {');
  assert.ok(mainAt > 0, '找不到 require.main 块');
  assert.equal(src.slice(0, mainAt).includes('createLifecycle'), false,
    'lib/server/lifecycle 只能在 require.main 块内使用 —— 顶层(被 require 时)引入会改变库行为');
  assert.ok(src.slice(mainAt).includes('createLifecycle'), 'require.main 块里没接上 lifecycle');

  // (b) 排空上限:必须是接线口径定下的 2000,不是 lifecycle 的默认 15000。
  assert.match(src, /drainTimeoutMs:\s*2000\s*,/,
    `drainTimeoutMs 必须显式传 2000;源码里现在读到 ${JSON.stringify(src.match(/drainTimeoutMs:\s*(\d+)/)?.[1] ?? null)}`);
  assert.equal((src.match(/drainTimeoutMs:\s*\d+/g) || []).length, 1,
    'drainTimeoutMs 只该有一处赋值,多出来的一处会盖掉接线口径');
  // 口径算术本身:2000 + 1000 = 3000 < 4000,余下约 1000ms 给进程启动/信号投递/抖动
  assert.ok(budgetCeilingMs() < EXTERNAL_KILL_MS,
    `排空 ${wiredDrainMs()}ms + 落盘下限 ${MIN_FLUSH_BUDGET_MS}ms = ${budgetCeilingMs()}ms,` +
    `已越过 mixctl 的 ${EXTERNAL_KILL_MS}ms 强杀线`);

  // (c) 生命周期接线不改变模块契约;合并保留 main 的 86 键及本地 Codex 更新入口。
  const home = tmpData();
  const r = spawnSync(process.execPath, ['-e', `console.log('KEYS=' + JSON.stringify(Object.keys(require(${JSON.stringify(ENTRY)})).sort()))`], {
    encoding: 'utf8', timeout: 30000, cwd: home,
    env: { ...process.env, HOME: home, MIXR_DATA_DIR: tmpData(), MIXROUTER_PORT: '0', MIXUI_PORT: '0' },
  });
  assert.equal(r.status, 0, r.stderr);
  const keys = JSON.parse(r.stdout.match(/KEYS=(.*)/)[1]);
  assert.equal(keys.length, 87, `合并后的导出键数目变了(应为 87,现在 ${keys.length})`);
  for (const k of ['proxyHandler', 'apiHandler', 'listen', 'explainRoute', 'resolveRoute', '_state',
    'sweepLogsNow', 'startLogRetention', 'updateCodexConfig'])
    assert.ok(keys.includes(k), `导出面少了 ${k}`);
});

// 「4000ms 这条线上限从哪来」也要有出处,否则预算断言只是我拍的数。
test('W2b 4000ms 强杀线确实来自 mixctl 与 README 的 plist,不是测试自己拍的', async t => {
  guard(t);
  const mixctl = fs.readFileSync(path.join(ROOT, 'mixctl'), 'utf8');
  const stopFn = mixctl.slice(mixctl.indexOf('function stop()'));
  assert.match(stopFn.slice(0, 600), /Date\.now\(\) - t0 > 4000/,
    'mixctl 的 stop() 里找不到 4000ms 强杀线 —— 上游改了,本文件的预算判据要重新核对');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/,
    'README 里的 KeepAlive.SuccessfulExit=false 找不到 —— 「非 0 退出会被立刻拉起」这条前提要重新核对');
});

// ---------------------------------------------------------------- 2) 子进程探针设施
function spawnShim(inject, { holdMs = 0, drainMs = wiredDrainMs(), timeoutMs = 25000 } = {}) {
  const dir = tmpData();
  const child = spawn(process.execPath, [SHIM, ROOT, inject, String(holdMs)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, MIXR_DATA_DIR: dir, MIXR_TEST_DRAIN_MS: String(drainMs),
      MIXR_DRAIN_TIMEOUT_MS: '',            // 清掉可能继承的旋钮,别让外层环境污染这次测量
    },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', c => { out += c.toString('utf8'); });
  child.stderr.on('data', c => { err += c.toString('utf8'); });
  const exited = new Promise(r => child.once('exit', (code, sig) => r({ code, sig })));

  const ready = (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const m = out.match(/LISTEN=(.*)/);
      if (m) return JSON.parse(m[1]);
      if (child.exitCode !== null) throw new Error(`探针提前退出 exit=${child.exitCode}\n${err}`);
      await sleep(50);
    }
    throw new Error(`探针 ${timeoutMs}ms 内没报监听\n${out}\n${err}`);
  })();

  return {
    child, dir, ready,
    get out() { return out; }, get err() { return err; },
    // 只对自己 spawn 的子进程发信号。给足等待:注入 drainTimeoutMs=15000 时
    // stop() 本来就要跑满 15s,若这里只等 15s 会以「杀不掉」收场,把预算断言
    // 的真实红因盖掉。所以等得比实现该用的时间更长,让停止能跑完、好量出真实耗时。
    async stop() {
      child.kill('SIGTERM');
      const e = await raceExit(exited, 40000);
      if (!e) { try { child.kill('SIGKILL'); } catch {} throw new Error('探针 40s 内没退出'); }
      return e;
    },
  };
}
const stopReport = out => JSON.parse(out.match(/STOP=(.*)/)[1]);
const touched = dir => fs.readdirSync(dir)
  .filter(f => f.startsWith('touched-')).map(f => f.replace(/touched-|\.txt/g, '')).sort();

// ---------------------------------------------------------------- 3) 预算:把 stop() 钉在 4000ms 以下
// 场景故意做成「排空排不掉」:一个连上但不发字节的 socket。lifecycle 头部注释说这类
// 半开连接会挡住温和 close()(已独立实测复核:/tmp/probe-halfopen.js —— 连上不发字节
// 与发了半个请求头两种状态,close 回调 600ms 内都不触发),所以这一次 stop 必然走超时
// 强清那条路径 —— 正是风险链里最坏的那条,也是唯一值得测的预算。
test('W2 最坏情况(排不掉的在途连接)下 stop() 总耗时 < mixctl 的 4000ms 强杀线', async t => {
  guard(t);
  const configured = wiredDrainMs();
  const p = spawnShim('none', { holdMs: 200 });   // 排空预算 = 源码里接的值
  try {
    const listen = await p.ready;
    const sock = net.connect(listen.proxy, '127.0.0.1');   // 连上,不发字节 → 排不掉
    await new Promise(r => sock.once('connect', r));
    await sleep(80);

    const t0 = Date.now();
    const { code } = await p.stop();
    const elapsedMs = Date.now() - t0;
    try { sock.destroy(); } catch {}

    assert.equal(code, 0, `必须 exit 0(launchd 只认 0 是正常停止)\n${p.err}`);
    const rep = stopReport(p.out);
    assert.equal(rep.forced, true, '这一档本该排不掉并走强清,没走到就说明场景没造出来');
    // 实测墙钟:含 SIGTERM 投递 + 排空 + 收尾落盘。这条是**硬上限**,外部给的:
    // 越过它,真实环境里这一步就是「停止」变「丢状态 + 被 launchd 拉起重启」。
    assert.ok(elapsedMs < EXTERNAL_KILL_MS,
      `stop() 总耗时 ${elapsedMs}ms 越过了 mixctl 的 ${EXTERNAL_KILL_MS}ms 强杀线;` +
      `当前排空口径 ${configured}ms + 落盘下限 ${MIN_FLUSH_BUDGET_MS}ms = ${budgetCeilingMs()}ms`);
    // 顺带钉住它确实等满了排空预算:若实现退化成「不排空直接退」,耗时掉到很低而上一行
    // 仍然绿 —— 那会丢掉在途响应,是另一条要防的路径。
    assert.ok(elapsedMs >= configured * 0.8,
      `stop() 只用了 ${elapsedMs}ms,不像真的等过 ${configured}ms 排空预算;` +
      `若这是「不排空直接落盘退出」的退化,在途响应会被连接 reset`);
  } finally { try { p.child.kill('SIGKILL'); } catch {} }
});

// ---------------------------------------------------------------- 4) 不变式:S4 收尾落盘必被执行
// 契约来自 lifecycle 的 runFlush:onFlush 返回按目标分列的对象,每个目标各自成败。
// 现役那句 try { 四个一起 } catch {} 在第一个目标抛错时会把后面三个**全部跳过**。
// 这里不看返回值,回到**文件系统**上核对每个目标真的被执行到了:
// 探针的目标文件在加载时就先落标记(早于 LISTEN 报告),所以「没跑到」是文件不存在,
// 不是我从返回值里反推的。
test('W3 一个目标落盘失败时,其余三个目标仍必须被执行到(现役写法会全跳过)', async t => {
  guard(t);
  const p = spawnShim('none', { drainMs: 200 });
  try {
    await p.ready;
    const { code } = await p.stop();
    assert.equal(code, 0, p.err);
    const rep = stopReport(p.out);
    assert.deepEqual(touched(p.dir), ['routes', 'sessions', 'slots', 'store'],
      '有个目标根本没被执行到');
    assert.equal(rep.flushResult.store.ok, false, 'store 的失败必须可见,不能被整体吞掉');
    assert.match(String(rep.flushResult.store.error), /注入/, 'store 的失败原因要带出来');
    for (const goal of ['routes', 'slots', 'sessions'])
      assert.equal(rep.flushResult[goal].ok, true, `${goal} 被 store 的异常带走了`);
    assert.equal(rep.ok, false, '有目标落盘失败,stop() 的整体结果不该报 ok');
  } finally { try { p.child.kill('SIGKILL'); } catch {} }
});

test('W3b 反面对照:现役那句 try{四个一起}catch{} 会把后面三个目标全部跳过', async t => {
  guard(t);
  // W3 的对照组:证明 W3 的鉴别力来自「分目标 try/catch」,而不是「反正四个都会跑到」。
  // 同一套设施只换 onFlush 形状,结果必须是只跑了 1 个。
  const p = spawnShim('naive', { drainMs: 200 });
  try {
    await p.ready;
    await p.stop();
    assert.deepEqual(touched(p.dir), ['store'],
      '现役写法本该只跑到 store —— 对照组没造出差别,说明 W3 测不出东西');
  } finally { try { p.child.kill('SIGKILL'); } catch {} }
});

test('W3c 对照:收尾落盘整个没执行时,文件系统上必须看得出「一个目标都没跑到」', async t => {
  guard(t);
  // 「超时直接 return、跳过 runFlush」这类缺陷在这里等价于 onFlush 不存在:
  // lifecycle 的 runFlush 在 !onFlush 时立刻返回 {result:{}},四个目标一个都不跑。
  //
  // ⚠ 这里如实记一个**实测出来的边界**:skip-flush 档下 stop() 仍然报 ok:true、
  // flushResult 是 {}。也就是说 **ok 不是「S4 有没有跑」的可靠信号** ——
  // 「一个目标都没跑」在 lifecycle 的返回值里是看不出来的(它不把「没配 onFlush」
  // 当成失败)。所以判「S4 被跳过」的唯一可靠证据是**目标本身有没有被执行**,
  // 也就是下面这个文件系统断言,以及 W5 里对 providers.json 落盘痕迹的核对。
  const p = spawnShim('skip-flush', { holdMs: 100, drainMs: 300 });
  try {
    await p.ready;
    await p.stop();
    assert.deepEqual(touched(p.dir), [], '这一档本该一个目标都没跑 —— 没造出对照,断言就没有依托');
    const rep = stopReport(p.out);
    assert.deepEqual(rep.flushResult, {}, '什么都没跑,flushResult 不该报出任何目标');
    assert.equal(rep.ok, true, '如实记录:这一档 lifecycle 仍报 ok —— 所以不能拿 ok 当 S4 的判据');
  } finally { try { p.child.kill('SIGKILL'); } catch {} }
});

test('W3d 落盘慢过排空时不许被排空吃掉,也不许让总预算翻倍', async t => {
  guard(t);
  // 排空预算 300ms,落盘要 1500ms。lifecycle 用「停止起点的绝对时刻 + drainTimeout」
  // 算 flush 预算,并且给 flush 留了 MIN_FLUSH_BUDGET_MS 下限,所以这一档应当成功落盘;
  // 总耗时仍必须守住 mixctl 的强杀线(这才是这条用例真正在乎的事)。
  const p = spawnShim('slow-flush', { holdMs: 100, drainMs: 300 });
  try {
    const listen = await p.ready;
    const sock = net.connect(listen.proxy, '127.0.0.1');    // 半开,让排空走满 300ms
    await new Promise(r => sock.once('connect', r));
    await sleep(60);
    const t0 = Date.now();
    const { code } = await p.stop();
    const elapsedMs = Date.now() - t0;
    try { sock.destroy(); } catch {}
    assert.equal(code, 0, p.err);
    const rep = stopReport(p.out);
    assert.deepEqual(touched(p.dir), ['routes', 'sessions', 'slots', 'store'],
      '落盘等到排空之后仍然必须四个目标都跑到');
    assert.equal(rep.flushIncomplete, false, '落盘被判超时 —— 排空把 flush 的预算吃光了');
    assert.ok(elapsedMs < EXTERNAL_KILL_MS,
      `排空 300ms + 落盘 1500ms 变成 ${elapsedMs}ms,越过了 mixctl 的 ${EXTERNAL_KILL_MS}ms 强杀线`);
  } finally { try { p.child.kill('SIGKILL'); } catch {} }
});

// ---------------------------------------------------------------- 5) 排空的正向价值
// 预算断言只说「不许太久」,这条说「排空确实在做事」。
test('W4 排得掉的在途请求:既不被掐断,也不等到超时(单次扫描的实现会红)', async t => {
  guard(t);
  const hold = 200;
  const configured = wiredDrainMs();
  const p = spawnShim('none', { holdMs: hold });
  try {
    const listen = await p.ready;
    const t0 = Date.now();
    // 在途请求在途那一刻发 SIGTERM:socket 是 busy 的,温和 close 必须等它答完
    const pending = get(listen.proxy, '/x').then(r => ({ ...r, at: Date.now() - t0 }), e => ({ err: e.message }));
    await sleep(60);
    const { code } = await p.stop();
    const resp = await pending;
    assert.equal(code, 0, p.err);
    const rep = stopReport(p.out);
    assert.equal(resp.status, 200, `在途请求被掐断了:${JSON.stringify(resp)}`);
    assert.equal(rep.forced, false, '排得掉却报强清 —— 周期重扫没起作用,或排空被写成了只扫一次');
    assert.equal(rep.drained, true);
    // 若排空退化成「只扫一次空闲连接」,这次要等到 keepAliveTimeout(5s)才收尾。
    // 上界跟着源码里的排空口径走,但必须显著小于它 —— 否则测不出「等满预算才结束」。
    assert.ok(rep.elapsedMs < configured * 0.75,
      `排空用了 ${rep.elapsedMs}ms,像只扫了一次空闲连接(排空口径 ${configured}ms)`);
  } finally { try { p.child.kill('SIGKILL'); } catch {} }
});

// ---------------------------------------------------------------- 6) 端到端:真入口 + 真信号
// 前几条在 shim 上测(onFlush 是抄的)。这条把**真 mixrouter.js** 当子进程拉起来,
// 发真 SIGTERM,证明接线后的 main 块真的会:排空 → 落盘 → exit 0。
// 端口与被写的文件全部落在临时目录:不碰 8787/8788,不写仓库里的 providers.json 等。
test('W5 真入口端到端:真 SIGTERM → 收尾落盘被执行 + exit 0(退 0 才不会被 launchd 拉起)', async t => {
  guard(t);
  const dataDir = tmpData();
  const home = tmpData();
  fs.writeFileSync(path.join(dataDir, 'providers.json'),
    JSON.stringify({ version: 2, current: {}, claude: [], codex: [] }));
  fs.writeFileSync(path.join(dataDir, 'routes.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(dataDir, 'slots.json'), JSON.stringify({ version: 1, claude: {}, codex: {} }));
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({ sessions: [], cooldowns: {}, pools: {} }));

  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, HOME: home, USERPROFILE: home, MIXR_DATA_DIR: dataDir,
      MIXROUTER_PORT: '0', MIXUI_PORT: '0', MIXROUTER_ALT_PORTS: '',
      MIXR_CLAUDE_SETTINGS: path.join(home, '.claude', 'settings.json'),
      MIXR_CODEX_CONFIG: path.join(home, '.codex', 'config.toml'),
    },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', c => { out += c.toString('utf8'); });
  child.stderr.on('data', c => { err += c.toString('utf8'); });
  const exited = new Promise(r => child.once('exit', (code, sig) => r({ code, sig })));
  try {
    const t0 = Date.now();
    while (!/代理 :\d+/.test(out) && Date.now() - t0 < 15000) {
      if (child.exitCode !== null) break;
      await sleep(50);
    }
    // 取**最后一条**横幅:接线后生命周期那条打的是内核实际分配的口。
    // 取第一条会拿到端口 0(配置常量),连上去就是 ECONNREFUSED —— 那正是接线要修的病。
    const banners = [...out.matchAll(/\[mixrouter v[\d.]+\] 代理 :(\d+)\(.*?控制台 http:\/\/([\d.]+):(\d+)/g)];
    assert.ok(banners.length >= 1, `没看到启动横幅\n${out}\n${err}`);
    const proxyPort = Number(banners[banners.length - 1][1]);
    assert.equal(RESERVED_PORTS.includes(proxyPort), false, `内核给到了现役端口 ${proxyPort},拒绝继续`);
    assert.notEqual(proxyPort, 0,
      `横幅自报端口 0 —— 接线后横幅必须按实际绑定结果报,不能打配置常量\n${out}`);
    // 真发一次请求:证明这次启动不是「横幅打出来但其实没在服务」
    assert.equal((await get(proxyPort, '/healthz')).status, 200);

    const stampBefore = fs.statSync(path.join(dataDir, 'providers.json')).mtimeMs;
    await sleep(30);
    const tStop = Date.now();
    child.kill('SIGTERM');                          // 只对这个自己 spawn 的 pid 发
    const e = await raceExit(exited, 20000);
    const elapsedMs = Date.now() - tStop;
    assert.ok(e, `发了 SIGTERM 但进程 20s 内没退出\n${out}\n${err}`);
    // 关键:退 0 且不是被信号打死。被打死 = launchd 立刻重新拉起 = 「停止」失效。
    assert.equal(e.sig, null, `进程被信号 ${e.sig} 终止(真实环境里 launchd 会立刻重新拉起)`);
    assert.equal(e.code, 0, `退出码 ${e.code} 不是 0 —— KeepAlive.SuccessfulExit=false 会重新拉起它`);
    assert.ok(elapsedMs < EXTERNAL_KILL_MS,
      `从 SIGTERM 到退出用了 ${elapsedMs}ms,越过了 mixctl 的 ${EXTERNAL_KILL_MS}ms 强杀线`);
    // S4 收尾落盘的痕迹:停止路径必须重写 providers.json。
    // 这条也顺带覆盖「排空被写成阻塞、吃掉全部预算」那条退化 —— 那时进程根本走不到落盘。
    assert.ok(fs.statSync(path.join(dataDir, 'providers.json')).mtimeMs > stampBefore,
      '停止路径没有重写 providers.json —— 收尾落盘没被执行到');
    assert.equal(/落盘在 \d+ms 预算内没结束/.test(err), false, `收尾落盘被判超时:\n${err}`);
  } finally {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
  }
});

// 本文件与探针只应在**仓库副本/沙箱**里跑:探针按 argv 里的 repo 路径 require,
// 本文件比对的是 ROOT 自己的源码。这里确认两者一致,免得在错的树上得出结论。
test('W0 前置:本文件读的源码与探针 require 的是同一个仓库', async t => {
  guard(t);
  assert.ok(fs.existsSync(REPO_MARKER), `找不到 ${REPO_MARKER}`);
  const r = spawnSync(process.execPath, ['-e',
    `console.log('OK=' + Object.keys(require(${JSON.stringify(path.join(ROOT, 'lib', 'server', 'lifecycle.js'))})).join(','))`],
    { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK=createLifecycle,DEFAULT_DRAIN_TIMEOUT_MS/);
});
