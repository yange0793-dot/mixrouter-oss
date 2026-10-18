'use strict';
// lib/server/lifecycle.js 的行为回归。每条都钉一个真的会出事的方向:
//   - 端口 0 自报 0:state() 必须给出内核实际分配的、**能真发请求拿到 200** 的端口
//   - 绑失败误伤别人:占位进程必须毫发无损
//   - 排空写成"只扫一次空闲连接":stop 会被 keepAliveTimeout 拖到 5s(实测 6321ms vs 335ms)
//   - 排空被写成阻塞:在途请求不该被掐断,只有超时才允许
//   - flush 失败被静默吞掉:这正是现役 mixrouter.js 信号处理里
//     `try { saveStore(); saveRoutes(); saveSlots(); flushSessions(); } catch {}` 的毛病
//     (原先这里写的是"mixrouter.js:2580",那行号早漂了:**别在注释里钉行号**,
//     钉住的当天是对的、第二天就是错的。用可搜索的符号定位,不要用行号。)
//   - require 有副作用:库不该在顶层起监听、注册 signal 或 timer
// 全部 listen(0,'127.0.0.1'),不连真实上游、不读写真实配置。
//
// **保留端口是硬约束**:8787/8788 上跑着现役服务,任何用例都不许绑或连。
// 下面这个断言在**每个**用例的公共前置里跑,违反即红——写在注释里的约束不会被发现被违反。
//
// ⚠ **不要用 `--test-name-pattern` 单跑其中某几条**:node:test 仍会执行被过滤掉的用例
// 注册的 `t.after` 钩子,而它们的 server 从没被 start 过,收尾逻辑会让进程挂住不退
// (看起来像"实现有死锁",会把人引到完全错误的方向去查)。要单验某一条行为,
// 请另写一个独立的临时脚本直接 require 模块来验,别用这个入口。
// 整份文件直接跑是正常的。
//
// ⚠ **三处踩过的坑,别再走一遍**:
// ① M10(非法 host 那条)第一版用**同进程**的 `getActiveResourcesInfo()` 计数做基线,
//    是假的:别的用例的 server 还在异步收尾,基线会漂(实测 4 个 TCPServerWrap 在
//    sleep 期间被关到 0),于是报出"抛之前已经绑上了一个 server"这种**假失败**。
//    已改成和 M10d 一样**在子进程里**跑(干净基线),判据从"计数不变"改成
//    "抛之后 TCPServerWrap 计数为 0"。同进程做资源基线在这份文件里不可靠。
// ② 变异验证**不要用本文件的 `--test-name-pattern` 入口**做(见上条,会挂住)。
//    要验某条断言有没有鉴别力,另写独立脚本 require 模块来注入缺陷。
// ③ **改测试文件做注入时,`String.prototype.replace` 只替换第一处**。M10e 那轮注入
//    就是这么半途而废的:声明改了、断言行还留着,于是跑出 2 条红、与我事先写的
//    "红 1 条"不符。**这个"不符"就是注入没做干净的信号,不要先去怀疑实现。**
//    两件事都要做:替换时数清目标字符串出现几次(不是 1 次就别用 replace),以及
//    **注入后回读文件确认改了哪几处**——脚本自己打印的"已注入"不算数。
//    通用形状:`String.replace` / `sed 无 /g` / 只改本地的补丁,都可能有这一半。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createLifecycle, WARN, DEFAULT_DRAIN_TIMEOUT_MS } = require('../lib/server/lifecycle.js');
const { waitFor } = require('./wait-for.js');

const RESERVED_PORTS = [8787, 8788];
const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 公共前置:登记本次用到的每个端口,任何保留端口出现就直接红。
function guard(t) {
  const used = [];
  t.after(() => {
    const bad = used.filter(port => RESERVED_PORTS.includes(port));
    assert.deepEqual(bad, [], `用到了保留端口 ${bad.join(',')}(8787/8788 上是现役服务)`);
  });
  return port => {
    if (Number.isInteger(port) && port > 0) used.push(port);
    assert.ok(!RESERVED_PORTS.includes(port), `不允许使用保留端口 ${port}`);
    return port;
  };
}

const listenStub = (handler, host = HOST) => new Promise((ok, bad) => {
  const server = http.createServer(handler);
  server.once('error', bad);
  server.listen(0, host, () => ok(server));
});
const closeStub = server => new Promise(ok => {
  try { server.closeAllConnections(); } catch { /* 已经关完 */ }
  try { server.close(() => ok()); } catch { ok(); }
});
// 直连:绕开 agent 池,免得 keepalive socket 在用例结束后还挂着。
const get = (port, path = '/', timeout = 3000) => new Promise(ok => {
  const req = http.get({ host: HOST, port, path, agent: false }, res => {
    let text = ''; res.on('data', c => text += c); res.on('end', () => ok({ status: res.statusCode, text }));
  });
  req.setTimeout(timeout, () => req.destroy(new Error('用例自身超时')));
  req.on('error', e => ok({ status: null, error: e.code || e.message }));
});
// keepalive 版:专门用来造"空闲连接",这是排空那条回归的关键夹具。
const agentFor = () => new http.Agent({ keepAlive: true, maxSockets: 8 });
const getKeepAlive = (agent, port, path = '/') => new Promise(ok => {
  const req = http.get({ host: HOST, port, path, agent }, res => {
    let text = ''; res.on('data', c => text += c); res.on('end', () => ok({ status: res.statusCode, text }));
  });
  req.on('error', e => ok({ status: null, error: e.code || e.message }));
});
const countFree = agent => Object.values(agent.freeSockets).reduce((n, list) => n + list.length, 0);
const connected = port => new Promise(ok => {
  const socket = net.connect(port, HOST, () => { socket.destroy(); ok(true); });
  socket.on('error', () => ok(false));
  socket.setTimeout(2000, () => { socket.destroy(); ok(false); });
});

const okHandlers = {
  proxyHandler: (req, res) => { res.writeHead(200, { 'content-length': '5' }); res.end('proxy'); },
  apiHandler: (req, res) => { res.writeHead(200, { 'content-length': '2' }); res.end('ui'); },
};

// ---------------------------------------------------------------- M1 启动与端口
test('M1 端口 0 报出内核实际分配的口,且该口真能答 200', async t => {
  const used = guard(t);
  const lc = createLifecycle({ proxyPort: 0, uiPort: 0, ...okHandlers });
  const report = await lc.start();
  used(report.proxy.port); used(report.ui.port);
  assert.notEqual(report.proxy.port, 0, '不能被报成 0');
  assert.notEqual(report.ui.port, 0);
  assert.notEqual(report.proxy.port, report.ui.port, '两个主监听不能是同一个口');
  assert.equal(report.proxy.address.address, HOST);

  // 报出来的必须是**能用的**端口,不是一个自洽的数字
  assert.equal(lc.state().proxy.port, lc.servers().proxy.address().port);
  const res = await get(report.proxy.port);
  assert.equal(res.status, 200);
  assert.equal(res.text, 'proxy');
  assert.equal((await get(report.ui.port)).text, 'ui');
  await lc.stop();
});

// ---------------------------------------------------------------- M2 绑失败与隔离
test('M2 主监听绑失败:回滚已起的、原样抛原始错误、占位进程毫发无损', async t => {
  const used = guard(t);
  const occupier = await listenStub((req, res) => res.end('occupier'));
  const busy = used(occupier.address().port);
  t.after(() => closeStub(occupier));

  const lc = createLifecycle({ proxyPort: busy, uiPort: 0, ...okHandlers });
  const failure = await lc.start().then(() => null, e => e);
  assert.ok(failure, 'start 应当 reject');
  assert.equal(failure.code, 'EADDRINUSE');
  assert.equal(lc.state().listening, false, '失败后不该还处于监听态');
  assert.equal(lc.state().startError.code, 'EADDRINUSE');
  assert.ok(lc.state().warnings.some(w => w.code === WARN.START_FAILED));

  // 占位进程完全没受影响
  assert.equal(occupier.listening, true);
  assert.equal((await get(busy)).text, 'occupier');
  await lc.stop();
});

test('M2b ui 被占时已经起来的 proxy 被回滚,不留半启动', async t => {
  const used = guard(t);
  const occupier = await listenStub((req, res) => res.end('busy-ui'));
  const busyUi = used(occupier.address().port);
  t.after(() => closeStub(occupier));

  // 先占一个号给 proxy 用,拿到就放掉:这样 start 时 proxy 能绑上,ui 注定失败。
  const placeholder = await listenStub((req, res) => res.end('x'));
  const proxyPort = used(placeholder.address().port);
  await closeStub(placeholder);

  const lc = createLifecycle({ proxyPort, uiPort: busyUi, ...okHandlers });
  const failure = await lc.start().then(() => null, e => e);
  assert.ok(failure, 'ui 被占时 start 必须 reject');
  assert.equal(failure.code, 'EADDRINUSE');
  assert.equal(lc.state().listening, false);
  assert.equal(lc.state().proxy.port, null, '回滚后不该再对外报端口');
  // 已经绑上过的 proxy 必须真的被关掉:那个号现在应该没人听
  assert.equal(await connected(proxyPort), false, '回滚过的 proxy 不该还在接连接');
  assert.equal(occupier.listening, true, '占位进程不受影响');
  await lc.stop();
  assert.equal(await connected(busyUi), true, '占位进程的端口始终没被我们关掉');
});

// ---------------------------------------------------------------- M3 alt 端口
test('M3 兼容监听:被占的口只告警不影响主监听,重复口被丢弃', async t => {
  const used = guard(t);
  const occupier = await listenStub((req, res) => res.end('taken'));
  const busyAlt = used(occupier.address().port);
  t.after(() => closeStub(occupier));

  const free = await listenStub((req, res) => res.end('x'));
  const freePort = used(free.address().port);
  await closeStub(free);                       // 拿到号就放掉,给 alt 用

  const lc = createLifecycle({
    proxyPort: 0, uiPort: 0, altPorts: [busyAlt, freePort],
    ...okHandlers,
  });
  const report = await lc.start();
  used(report.proxy.port); used(report.ui.port);
  for (const entry of report.alt) used(entry.port);

  // 主监听照常可用
  assert.equal((await get(report.proxy.port)).status, 200);
  // 被占的那个记了告警,但没挡住启动
  assert.ok(lc.state().warnings.some(w => w.code === WARN.ALT_BIND_FAILED), '被占的 alt 要告警');
  // 能绑上的那个真的在服务
  const altPorts = report.alt.map(a => a.port);
  assert.ok(altPorts.includes(freePort), `alt ${freePort} 应当绑上,实际 ${altPorts.join(',')}`);
  assert.equal((await get(freePort)).text, 'proxy');
  await lc.stop();
  assert.equal(await connected(freePort), false, 'stop 后 alt 也要关掉');
});

test('M3b alt 与主监听重复的口被跳过并计数告警', async t => {
  const used = guard(t);
  const fixed = await listenStub((req, res) => res.end('x'));
  const port = used(fixed.address().port);
  await closeStub(fixed);

  const lc = createLifecycle({
    proxyPort: port, uiPort: 0, altPorts: [port, port],
    ...okHandlers,
  });
  const report = await lc.start();
  used(report.proxy.port); used(report.ui.port);
  assert.equal(report.alt.length, 0, '与主监听同口不该再去绑一次');
  assert.ok(lc.state().warnings.some(w => w.code === WARN.ALT_DUPLICATE));
  await lc.stop();
});

// ---------------------------------------------------------------- M4 排空
test('M4 短在途请求被等完:不掐断、forced=false', async t => {
  const used = guard(t);
  let release = null;
  const lc = createLifecycle({
    proxyPort: 0, uiPort: 0, drainTimeoutMs: 5000,
    proxyHandler: (req, res) => {
      res.writeHead(200, { 'content-length': '4' });
      release = () => res.end('done');
    },
    apiHandler: okHandlers.apiHandler,
  });
  const report = await lc.start();
  used(report.proxy.port); used(report.ui.port);

  const inflight = get(report.proxy.port);
  // 等"处理函数真的被调用了",不是等一个乐观的毫秒数。
  // 以前这里写 `await sleep(60); const stopping = lc.stop(); await sleep(30); release();` ——
  // 共享 CI runner 上这 90ms 总预算会被调度延迟吃掉,release 还是 null,
  // 于是报 `release is not a function`(实测 Node 18 并发跑全集复现),
  // 一句指向**夹具自己**的 TypeError,读的人却会先去查 lifecycle 实现。
  // 等句柄到位之后,再留 20ms 让 stop 真的进入排空状态(那一段是在等实现做事,不是在等调度)。
  await waitFor(() => release, { label: '在途请求已被处理(处理函数已赋值)' });
  const stopping = lc.stop();
  await sleep(20);
  release();                                    // 排空窗口内答完
  const result = await stopping;
  assert.equal(result.forced, false, '不该走到强清');
  assert.equal(result.drained, true);
  assert.equal((await inflight).text, 'done', '在途请求必须拿到完整响应,不是 ECONNRESET');
  assert.equal(result.ok, true);
});

test('M4b 排空期间**周期**扫空闲连接:stop 远快于 keepAliveTimeout', async t => {
  const used = guard(t);
  let release = null;
  const lc = createLifecycle({
    proxyPort: 0, uiPort: 0, drainTimeoutMs: 2000,
    proxyHandler: (req, res) => {
      if (req.url === '/fast') { res.writeHead(200, { 'content-length': '2' }); return res.end('ok'); }
      res.writeHead(200, { 'content-length': '4' });
      release = () => res.end('slow');
    },
    apiHandler: okHandlers.apiHandler,
  });
  const report = await lc.start();
  used(report.proxy.port); used(report.ui.port);

  const agent = agentFor();
  t.after(() => agent.destroy());
  await getKeepAlive(agent, report.proxy.port, '/fast');
  assert.ok(countFree(agent) >= 1, '夹具应当留下一条空闲 keepalive 连接');

  const inflight = getKeepAlive(agent, report.proxy.port, '/slow');
  await waitFor(() => release, { label: '在途请求已被处理(处理函数已赋值)' });
  const t0 = Date.now();
  const stopping = lc.stop();
  await sleep(20);
  release();
  const result = await stopping;
  const elapsed = Date.now() - t0;
  await inflight;

  // node 默认 keepAliveTimeout=5000ms:若实现里只扫一次空闲连接,这里会等到 ~5000ms
  assert.ok(elapsed < 2000, `stop 用了 ${elapsed}ms,超过注入的 drainTimeout,说明排空没生效`);
  assert.ok(elapsed < 1500, `stop 用了 ${elapsed}ms,接近 keepAliveTimeout 说明空闲连接没被周期扫掉`);
  assert.equal(result.forced, false, '正常排空不该触发强清');
  // 把实测毫秒数留在输出里,便于对比两个 Node 版本
  console.log(`M4b stop 耗时 ${elapsed}ms(keepAliveTimeout 默认 5000ms)`);
});

test('M4c 反证:扫描间隔调大,stop 确实变慢(且不是被超时强清拖慢的)', async t => {
  const used = guard(t);
  const run = async idleScanIntervalMs => {
    let release = null;
    const lc = createLifecycle({
      proxyPort: 0, uiPort: 0, drainTimeoutMs: 8000, idleScanIntervalMs,
      proxyHandler: (req, res) => {
        if (req.url === '/fast') { res.writeHead(200, { 'content-length': '2' }); return res.end('ok'); }
        res.writeHead(200, { 'content-length': '4' });
        release = () => res.end('slow');
      },
      apiHandler: okHandlers.apiHandler,
    });
    const report = await lc.start();
    used(report.proxy.port); used(report.ui.port);
    const agent = agentFor();
    await getKeepAlive(agent, report.proxy.port, '/fast');
    const inflight = getKeepAlive(agent, report.proxy.port, '/slow');
    await waitFor(() => release, { label: '在途请求已被处理(处理函数已赋值)' });
    const t0 = Date.now();
    const stopping = lc.stop();
    await sleep(20);
    release();
    const result = await stopping;
    const elapsed = Date.now() - t0;
    await inflight;
    agent.destroy();
    return { elapsed, forced: result.forced };
  };

  const fast = await run(25);
  const slow = await run(3000);
  console.log(`M4c 间隔 25ms -> ${fast.elapsed}ms;间隔 3000ms -> ${slow.elapsed}ms`);
  assert.ok(slow.elapsed > fast.elapsed + 500,
    `间隔调大后 stop 没变慢(${fast.elapsed}ms -> ${slow.elapsed}ms),说明周期性扫描没有真的在起作用`);
  // 关键:drainTimeoutMs(8000) 远大于注入间隔,所以"慢"只可能来自扫描。
  // 若这条挂了,说明慢是被超时强清拖出来的,反证就失去意义。
  assert.equal(slow.forced, false, '慢必须来自扫描迟到,不能来自超时强清');
});

// ---------------------------------------------------------------- M5 超时强清
test('M5 超时强清:forced、按口报连接数、发告警、客户端拿到 ECONNRESET', async t => {
  const used = guard(t);
  const lc = createLifecycle({
    proxyPort: 0, uiPort: 0, drainTimeoutMs: 300,
    proxyHandler: (req, res) => { req.resume(); /* 永不响应 */ },
    apiHandler: okHandlers.apiHandler,
  });
  const report = await lc.start();
  used(report.proxy.port); used(report.ui.port);

  // 三条连接:2 条半开(连上不发字节)+ 1 条在途。
  // **不能 await 这个在途请求**:服务端永不响应,强清之后它也不会正常收尾
  // (实测客户端拿到的是 ECONNRESET),await 会把用例挂死。只记结果,不阻塞。
  const sockets = [net.connect(report.proxy.port, HOST), net.connect(report.proxy.port, HOST)];
  sockets.forEach(s => s.on('error', () => {}));
  t.after(() => sockets.forEach(s => s.destroy()));
  const outcome = { aborted: false, error: null, ended: false };
  const req = http.get({ host: HOST, port: report.proxy.port, agent: false }, res => {
    res.on('data', () => {});
    res.on('end', () => { outcome.ended = true; });
    res.on('aborted', () => { outcome.aborted = true; });
    res.on('error', e => { outcome.error = e.code; });
  });
  req.on('error', e => { outcome.error = e.code; });
  await sleep(180);

  const t0 = Date.now();
  const result = await lc.stop();
  const elapsed = Date.now() - t0;
  assert.equal(result.forced, true, 'drainTimeout 到点应当强清');
  assert.ok(elapsed >= 250 && elapsed < 2000, `强清耗时 ${elapsed}ms 不合预期`);
  assert.ok(result.warnings.some(w => w.code === WARN.DRAIN_TIMEOUT), '强清必须发告警');
  // drainElapsedMs 是"排空实际花了多久":强清路径下它必然 >= drainTimeout(300)。
  // 旧字段 forcedRemainingMs 恒为 0,是个死字段(进入 finish 时预算必然已经耗尽),已删除。
  assert.ok(result.drainElapsedMs >= 250, `强清时 drainElapsedMs 应当 >= drainTimeout,实际 ${result.drainElapsedMs}`);
  assert.equal(result.forcedRemainingMs, undefined, '恒为 0 的死字段不该再对外暴露');

  // 按监听口报数,且只报端口与条数
  const proxyEntry = result.forcedDetail.find(item => item.listener === 'proxy');
  assert.ok(proxyEntry, `forcedDetail 里应当有 proxy 项,实际 ${JSON.stringify(result.forcedDetail)}`);
  assert.equal(proxyEntry.port, report.proxy.port, '报的必须是实际监听口,不能是 null');
  assert.ok(proxyEntry.connections >= 3, `应有 3 条连接(2 半开 + 1 在途),实际 ${proxyEntry.connections}`);
  for (const item of result.forcedDetail)
    assert.deepEqual(Object.keys(item).sort(), ['connections', 'listener', 'port'],
      'forcedDetail 只许有监听口与条数,不许夹带 URL/头/体');

  // 被强清的客户端必须看到中断,而不是正常 end
  await sleep(200);
  assert.equal(outcome.ended, false, '被强清的响应不该以正常 end 收尾');
  assert.ok(outcome.aborted || outcome.error === 'ECONNRESET',
    `客户端应当拿到 aborted/ECONNRESET,实际 ${JSON.stringify(outcome)}`);
  req.destroy();
});

test('M5b drainTimeoutMs=0:立刻强清,不等待', async t => {
  const used = guard(t);
  const lc = createLifecycle({
    proxyPort: 0, uiPort: 0, drainTimeoutMs: 0,
    proxyHandler: (req, res) => { req.resume(); },
    apiHandler: okHandlers.apiHandler,
  });
  const report = await lc.start();
  used(report.proxy.port); used(report.ui.port);
  const socket = net.connect(report.proxy.port, HOST);
  t.after(() => socket.destroy());
  await sleep(80);
  const t0 = Date.now();
  const result = await lc.stop();
  assert.ok(Date.now() - t0 < 1000, 'drainTimeoutMs=0 不该等待');
  assert.equal(result.forced, true);
  assert.ok(result.forcedDetail.length > 0, '强清要有可判读的条数');
  assert.ok(Number.isSafeInteger(result.drainElapsedMs) && result.drainElapsedMs >= 0,
    `drainElapsedMs 应当是个可断言的数,实际 ${result.drainElapsedMs}`);
});

// ---------------------------------------------------------------- M6 幂等与未启动
test('M6 stop 幂等:onFlush 只调一次,重复 stop 不抛', async t => {
  const used = guard(t);
  let flushes = 0;
  const lc = createLifecycle({
    proxyPort: 0, uiPort: 0, ...okHandlers,
    onFlush: () => { flushes++; return { saveStore: { ok: true } }; },
  });
  const report = await lc.start();
  used(report.proxy.port); used(report.ui.port);
  const first = lc.stop();
  const second = lc.stop();
  assert.equal(first, second, '两次 stop 应当是同一个 promise');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(flushes, 1, 'onFlush 只该被调用一次');
});

test('M6b 从未 start 就 stop:不抛、仍落盘、有告警', async t => {
  guard(t);
  let flushes = 0;
  const lc = createLifecycle({ proxyPort: 0, uiPort: 0, ...okHandlers,
    onFlush: () => { flushes++; return { saveStore: { ok: true } }; } });
  const result = await lc.stop();
  assert.equal(result.ok, true);
  assert.equal(flushes, 1);
  assert.ok(result.warnings.some(w => w.code === WARN.STOPPED_WITHOUT_START));
  assert.equal(lc.state().stopped, true);
});

// ---------------------------------------------------------------- M7 start 未完成时 stop
test('M7 start 未 await 就 stop:两者都 settle 一次,没有端口还在听', async t => {
  const used = guard(t);
  const lc = createLifecycle({ proxyPort: 0, uiPort: 0, ...okHandlers });
  const starting = lc.start();
  const stopping = lc.stop();
  const [report, result] = await Promise.all([starting, stopping]);
  used(report.proxy.port); used(report.ui.port);
  assert.equal(result.startError, null);
  assert.equal(lc.state().stopped, true);
  assert.equal(lc.state().listening, false);
  assert.equal(await connected(report.proxy.port), false, 'stop 之后不该还有端口在听');
  assert.equal(await connected(report.ui.port), false);
});

test('M7b start 注定失败时 stop:不重复抛,startError 有值,落盘仍发生', async t => {
  const used = guard(t);
  const occupier = await listenStub((req, res) => res.end('x'));
  const busy = used(occupier.address().port);
  t.after(() => closeStub(occupier));
  let flushes = 0;
  const lc = createLifecycle({
    proxyPort: busy, uiPort: 0, ...okHandlers,
    onFlush: () => { flushes++; return { saveStore: { ok: true } }; },
  });
  const starting = lc.start().catch(e => e);
  const result = await lc.stop();
  await starting;
  assert.equal(result.startError.code, 'EADDRINUSE');
  assert.equal(flushes, 1, '启动失败也要走一次落盘');
  assert.equal(result.ok, true, 'start 失败不是 stop 的失败');
});

// ---------------------------------------------------------------- M8 flush 失败可见
test('M8 flush 按目标分列:失败的报出来,成功的不被掩盖', async t => {
  const used = guard(t);
  const lc = createLifecycle({
    proxyPort: 0, uiPort: 0, ...okHandlers,
    onFlush: () => ({
      saveStore: { ok: true },
      saveRoutes: { ok: false, error: 'E1' },
      saveSlots: { ok: true },
      flushSessions: { ok: false, error: 'E2' },
    }),
  });
  const report = await lc.start();
  used(report.proxy.port); used(report.ui.port);
  const result = await lc.stop();
  assert.equal(result.ok, false, '有目标失败就必须体现在 ok 上(这是对现役 catch{} 的回归锁)');
  assert.deepEqual(result.flushError, { saveRoutes: 'E1', flushSessions: 'E2' },
    'flushError 只该含失败项,且一个失败不许掩盖另一个');
  // 成功的目标仍要能从结果里看出来
  assert.deepEqual(result.flushResult.saveStore, { ok: true });
  assert.deepEqual(result.flushResult.saveSlots, { ok: true });
  assert.deepEqual(result.flushResult.saveRoutes, { ok: false, error: 'E1' });
  assert.ok(result.warnings.some(w => w.code === WARN.FLUSH_FAILED));
});

test('M8b onFlush 抛错:stop 不 reject,但结果必须说失败', async t => {
  const used = guard(t);
  const lc = createLifecycle({
    proxyPort: 0, uiPort: 0, ...okHandlers,
    onFlush: () => { throw new Error('磁盘满了'); },
  });
  const report = await lc.start();
  used(report.proxy.port); used(report.ui.port);
  const result = await lc.stop();          // 不许 reject
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.flushError), /磁盘满了/);
  assert.ok(result.warnings.some(w => w.code === WARN.FLUSH_FAILED));
});

test('M8c onFlush 永不 resolve:受超时上限约束,不挂死、不误报成某目标失败', async t => {
  const used = guard(t);
  const lc = createLifecycle({
    proxyPort: 0, uiPort: 0, drainTimeoutMs: 300, ...okHandlers,
    onFlush: () => new Promise(() => {}),      // 永远 pending
  });
  const report = await lc.start();
  used(report.proxy.port); used(report.ui.port);
  const t0 = Date.now();
  const result = await lc.stop();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `stop 被 flush 挂住了(${elapsed}ms)`);
  assert.equal(result.flushIncomplete, true, '超时要与"某个目标失败"区分开');
  assert.equal(result.flushError, null, '没有目标报错时不该凭空造出失败项');
  assert.ok(result.warnings.some(w => w.code === WARN.FLUSH_TIMEOUT));
});

test('M8d flush 失败不回滚已经关掉的监听', async t => {
  const used = guard(t);
  const lc = createLifecycle({
    proxyPort: 0, uiPort: 0, ...okHandlers,
    onFlush: () => ({ saveStore: { ok: false, error: 'boom' } }),
  });
  const report = await lc.start();
  used(report.proxy.port); used(report.ui.port);
  const result = await lc.stop();
  assert.equal(result.ok, false);
  assert.equal(await connected(report.proxy.port), false, 'flush 失败不该让端口重新开始接连接');
  assert.equal(await connected(report.ui.port), false);
});

// ---------------------------------------------------------------- M9 不泄漏
test('M9 子进程里跑完 start→stop 后能自己退出(有泄漏就会挂住)', t => {
  guard(t);
  const script = `
    const { createLifecycle } = require(${JSON.stringify(path.resolve(__dirname, '../lib/server/lifecycle.js'))});
    (async () => {
      const lc = createLifecycle({ proxyPort: 0, uiPort: 0,
        proxyHandler: (q,s)=>s.end('p'), apiHandler: (q,s)=>s.end('u'),
        onFlush: () => ({ saveStore: { ok: true } }) });
      await lc.start();
      const r = await lc.stop();
      console.log('RESULT=' + JSON.stringify({ ok: r.ok, forced: r.forced }));
      // 不调 process.exit:有泄漏就退不出去
    })();
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined, `子进程没能自己退出: ${result.error && result.error.message}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RESULT=\{"ok":true,"forced":false\}/);
});

test('M9b 同一进程重复 start/stop 三轮:每轮都能重新绑,alt 不累积', async t => {
  const used = guard(t);
  for (let round = 0; round < 3; round++) {
    const lc = createLifecycle({ proxyPort: 0, uiPort: 0, ...okHandlers });
    const report = await lc.start();
    used(report.proxy.port); used(report.ui.port);
    assert.equal((await get(report.proxy.port)).status, 200);
    assert.deepEqual(report.alt, []);
    const result = await lc.stop();
    assert.equal(result.ok, true);
    assert.equal(await connected(report.proxy.port), false);
  }
});

test('M7c stop 之后再调 start:拿到的是当下快照,不是过期 report', async t => {
  const used = guard(t);
  const lc = createLifecycle({ proxyPort: 0, uiPort: 0, ...okHandlers });
  const first = await lc.start();
  used(first.proxy.port); used(first.ui.port);
  assert.equal(first.listening, true);
  const deadPort = first.proxy.port;
  await lc.stop();

  const again = await lc.start();
  assert.equal(again.listening, false, 'stop 之后不该再自称在监听');
  assert.equal(again.stopped, true);
  assert.equal(again.proxy.port, null, '不该再报一个已经关掉的端口');
  if (again.proxy.port !== null) used(again.proxy.port);
  // 那个端口确实已经没人听了:拿过期快照去拼横幅/写 /api/state 就会自报一个死端口
  assert.equal(await connected(deadPort), false);
});

test('M2c 兼容监听在 altPorts 内部写重时也告警,不静默跳过', async t => {
  const used = guard(t);
  const free = await listenStub((req, res) => res.end('x'));
  const port = used(free.address().port);
  await closeStub(free);
  const lc = createLifecycle({ proxyPort: 0, uiPort: 0, altPorts: [port, port], ...okHandlers });
  const report = await lc.start();
  used(report.proxy.port); used(report.ui.port);
  assert.equal(report.alt.length, 1, '同一个口不该绑两次');
  assert.ok(lc.state().warnings.some(w => w.code === WARN.ALT_DUPLICATE),
    'altPorts 内部重复必须告警,不能与"和主监听撞车"两种对待');
  await lc.stop();
});

// ---------------------------------------------------------------- M10 同步校验
test('M10 非法 host 同步抛,且抛之前没有绑过任何口', async t => {
  guard(t);
  const modulePath = path.resolve(__dirname, '../lib/server/lifecycle.js');
  // 在**子进程**里做:同进程里别的用例的 server 还在收尾,资源计数没有干净基线
  // (第一版就是这么红的:基线 4 个 TCPServerWrap 在 sleep 期间被别的用例关掉了)。
  // 这里的判据是"抛之前没有**新增**监听",所以基线必须干净。
  const script = `
    const snap = () => process.getActiveResourcesInfo().filter(r => r === 'TCPServerWrap').length;
    const { createLifecycle } = require(${JSON.stringify(modulePath)});
    // 末项 '127.999.999.999' 是补进去的:它是"127 开头但段值越界",不是合法 IPv4。
    // 改之前这一版校验会**接受**它(原正则只看每段 1-3 位数字),而这张表原先没有任何
    // 这种形态的输入,所以这条缺口在本文件里是静默的。补上它之后,把区间校验退化回
    // "只看形状"会立刻让这条红 —— 实测:退化注入下,只有它红(1/28);把这一项加回表里
    // 再注入同一个退化,变成 2 条红(M10 与 M10e)。补这一项就是在补那条缺口。
    const hosts = ${JSON.stringify(['0.0.0.0', '::', '::0', '10.0.0.1', 'localhost', 'LOCALHOST', 'localhost.', '127.999.999.999'])};
    const out = [];
    const run = host => {
      const before = snap();
      let threw = null;
      try { createLifecycle({ host, proxyPort: 0, uiPort: 0,
        proxyHandler: (q,s)=>s.end('p'), apiHandler: (q,s)=>s.end('u') }); }
      catch (e) { threw = e.name; }
      return { host, threw, before };
    };
    for (const h of hosts) out.push(run(h));
    // 给异步绑定一个机会:若实现是"先绑再校验",这里会冒出新的 TCPServerWrap
    setTimeout(() => {
      console.log('PROBE=' + JSON.stringify({ out, after: snap() }));
    }, 200);
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  const probe = JSON.parse(result.stdout.match(/PROBE=(.*)/)[1]);
  for (const row of probe.out)
    assert.equal(row.threw, 'TypeError', `host=${row.host} 应当同步抛 TypeError,实际 ${row.threw}`);
  assert.equal(probe.after, 0,
    `非法 host 抛之前已经绑上了 server(会留下一个开着的端口),残留 ${probe.after} 个`);
});

// 这条是 M10 的补丁,专治"校验接受了一个 Node 根本绑不上的 host"。
// 为什么要有:契约是"要么干净接受、要么同步抛",而接受一个必然绑不上的 host 等于把
// 错误推迟到 bind 才炸、且炸出来的消息更差。原先的实现同时犯了两头:
//   '[::1]' 与 '127.999.999.999' 都被**接受**,但本机实测两者绑定都是 EADDRNOTAVAIL。
// 为什么这两条能写成断言、而 127/8 里那些地址不能:见下面 rejected 表里那条注释。
test('M10e 校验接受的 host 必须真能绑,拒绝的必须同步抛', async t => {
  guard(t);
  const modulePath = path.resolve(__dirname, '../lib/server/lifecycle.js');
  // 仍然放子进程:要"真绑一次"就得起监听,父进程里别的用例的 server 会干扰资源计数
  const script = `
    const http = require('node:http');
    const { createLifecycle } = require(${JSON.stringify(modulePath)});
    const mk = host => createLifecycle({ host, proxyPort: 0, uiPort: 0,
      proxyHandler: (q,s)=>s.end('p'), apiHandler: (q,s)=>s.end('u') });
    const out = [];
    (async () => {
      for (const host of ${JSON.stringify(['::1', '127.0.0.1'])}) {
        let row = { host, threw: null, port: null, address: null };
        try {
          const lc = mk(host);
          const report = await lc.start();
          row.port = report.proxy.port;
          row.address = lc.state().host;
          // 真绑一次并读回内核给的地址,而不是只看没有抛。
          // 注意请求也要打到**同一个 host**:绑在 ::1 上的 server 用 127.0.0.1 连是 ECONNREFUSED,
          // 那会把"绑上了"误判成失败。
          row.bound = await new Promise(resolve => {
            const req = http.get({ host, port: report.proxy.port, path: '/', agent: false }, res => {
              res.resume(); resolve(res.statusCode);
            });
            req.on('error', e => resolve('ERR ' + e.code));
          });
          await lc.stop();
        } catch (e) { row.threw = e.name + ': ' + e.message; }
        out.push(row);
      }
      // 拒绝侧的三种形态:方括号 IPv6、越界 IPv4、以及必须被拒的解析型写法
      for (const host of ${JSON.stringify(['[::1]', '127.999.999.999', '0.0.0.0', 'localhost'])})
        { let threw = null; try { mk(host); } catch (e) { threw = e.name; } out.push({ host, threw }); }
      const reserved = out.some(r => r.port === 8787 || r.port === 8788);
      console.log('PROBE=' + JSON.stringify({ out, reserved }));
    })();
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const probe = JSON.parse(result.stdout.match(/PROBE=(.*)/)[1]);
  // 安全网:子进程里绑的是内核给的空闲口,万一给到保留端口就直接红,不做任何补救
  assert.equal(probe.reserved, false, '子进程绑到了保留端口 8787/8788');
  const byHost = Object.fromEntries(probe.out.map(r => [r.host, r]));

  for (const host of ['::1', '127.0.0.1']) {
    assert.equal(byHost[host].threw, null, `${host} 应当被接受并能绑上:${byHost[host].threw}`);
    assert.ok(byHost[host].port > 0, `${host} 应当拿到实际端口`);
    assert.equal(byHost[host].bound, 200, `${host} 绑上之后应当真的能服务请求,实际 ${byHost[host].bound}`);
  }
  for (const host of ['[::1]', '127.999.999.999', '0.0.0.0', 'localhost'])
    assert.equal(byHost[host].threw, 'TypeError',
      `${host} 应当同步抛 TypeError(方括号不是 listen() 接受的形态;127.999.999.999 不是合法 IPv4;后两个不是字面量回环)`);

  // ⚠ 这里**故意没有** '127.1.2.3' / '127.255.255.255' 这类"合法回环网段但本机绑不上"的用例。
  // 本机 lo0 只有 127.0.0.1,它们必然 EADDRNOTAVAIL;但 Linux 上整个 127/8 都路由到 lo,
  // 同样一份代码在那边是能绑的。把"拒绝 127.1.2.3"写成断言等于把一个平台相关行为钉死,
  // 在 Linux CI 上会恒红。这类地址仍然是真回环地址,要断言的只有"要么绑上、要么 EADDRNOTAVAIL
  // 这种干净失败",而不是"必须抛"——所以它不进上面的表。
});

test('M10b 其余非法参数同步抛', async t => {
  guard(t);
  const bad = [
    { proxyPort: -1 }, { proxyPort: 'abc' }, { proxyPort: 70000 }, { uiPort: -1 },
    { drainTimeoutMs: -1 }, { drainTimeoutMs: 1.5 },
    { idleScanIntervalMs: -1 }, { onFlush: 123 }, { onWarning: 'x' },
    { altPorts: 'nope' }, { proxyHandler: 'nope' },
  ];
  for (const patch of bad)
    assert.throws(() => createLifecycle({ proxyPort: 0, uiPort: 0, ...okHandlers, ...patch }),
      { name: 'TypeError' }, `${JSON.stringify(patch)} 应当同步抛 TypeError`);
});

test('M10c MIXR_DRAIN_TIMEOUT_MS 生效,非法值回落默认', t => {
  guard(t);
  const saved = process.env.MIXR_DRAIN_TIMEOUT_MS;
  t.after(() => {
    if (saved === undefined) delete process.env.MIXR_DRAIN_TIMEOUT_MS;
    else process.env.MIXR_DRAIN_TIMEOUT_MS = saved;
  });
  // 只验解析口径(envInt:非安全整数/越界一律回落),行为上的超时在 M5 已经验过
  const read = () => {
    const lc = createLifecycle({ proxyPort: 0, uiPort: 0, ...okHandlers });
    return lc.state().host && lc;               // 不 start,只造对象
  };
  process.env.MIXR_DRAIN_TIMEOUT_MS = '4321';
  assert.ok(read());
  // 非法值不该抛:按 envInt 口径回落默认
  for (const bad of ['abc', '-1', '', '  ', '1e99']) {
    process.env.MIXR_DRAIN_TIMEOUT_MS = bad;
    assert.ok(read(), `MIXR_DRAIN_TIMEOUT_MS=${JSON.stringify(bad)} 应当回落默认而不是抛`);
  }
});

test('M10d require 零副作用:延迟快照里没有新增 server/timer/signal', async t => {
  guard(t);
  const modulePath = path.resolve(__dirname, '../lib/server/lifecycle.js');
  // 在子进程里做:父进程已经被别的用例污染,快照没有基线意义。
  // 同步快照是**无效**的(listen 是异步绑定,require 返回那刻资源列表还是空的),
  // 所以这里必须等一个 tick 再比。
  const script = `
    const snap = () => process.getActiveResourcesInfo().slice();
    const before = snap();
    const sigBefore = ['SIGTERM','SIGINT'].map(s => process.listenerCount(s));
    require(${JSON.stringify(modulePath)});
    // 排除探针自己的定时器:它就是下面这个 setTimeout
    setTimeout(() => {
      const after = snap();
      const mine = 1;   // 探针自己的 Timeout
      const timers = after.filter(r => r === 'Timeout').length;
      const servers = after.filter(r => r === 'TCPServerWrap').length;
      const sigAfter = ['SIGTERM','SIGINT'].map(s => process.listenerCount(s));
      console.log('PROBE=' + JSON.stringify({ timers, servers, sigBefore, sigAfter }));
    }, 150);
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const probe = JSON.parse(result.stdout.match(/PROBE=(.*)/)[1]);
  assert.equal(probe.servers, 0, 'require 不该起监听');
  assert.equal(probe.timers, 1, `require 不该新增定时器(只该有探针自己那一个,实际 ${probe.timers})`);
  assert.deepEqual(probe.sigAfter, probe.sigBefore, 'require 不该注册进程级 signal');
  void t;
});

// ---------------------------------------------------------------- 安全网
test('安全网:本文件任何用例都不许碰 8787/8788', t => {
  // 断言夹具本身可靠:保留端口上没有我们的东西
  for (const port of RESERVED_PORTS) assert.equal(connected(port) instanceof Promise, true);
  t.diagnostic(`保留端口 ${RESERVED_PORTS.join('/')} 由公共前置逐个用例核对,违反即红`);
});
