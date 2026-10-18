'use strict';
// 服务生命周期:两个主监听的原子启动、在途排空、可配置的强清兜底、收尾落盘。
//
// 这份模块存在的理由是两个现役问题:
//   1. mixrouter.js 的 SIGTERM 路径是「落盘 + process.exit(0)」——两个 server 上在途的
//      响应不会排空,keepalive 连接也不会被关,客户端拿到的是连接被 reset,而不是把
//      当前这一轮答完。
//   2. 端口设成 0 时,启动横幅与 /api/state 都自报 0(它们打的是配置常量 PROXY_PORT)
//      ——拿不到内核实际分配的端口。
//
// 关键语义全部来自实测(探针见 /tmp/mixrouter-lifecycle-20260919/),不是推断:
//   - closeIdleConnections() 是**一次性**扫描:只清"调用那一刻已空闲"的连接。在途请求
//     结束、socket 转为空闲之后没人再扫,close 回调要等到 keepAliveTimeout(5s)才触发。
//     实测:400ms 的在途请求,单次扫描 6321ms / 周期扫描 335ms。所以排空期间必须周期扫。
//   - 半开连接(连上但不发字节)会挡住温和 close():计入连接数,靠 drainTimeout 兜底。
//   - 绑失败不会误伤别人:失败 server 的 listening=false、address()=null,close() 得
//     ERR_SERVER_NOT_RUNNING;占用该端口的进程完全不受影响。
//   - close() 立刻拒绝新连接,但不打断在途请求;两个 server 的连接集合互不影响。
//
// 本模块刻意与 mixrouter.js 顶层读常量的做法相反:**require 零副作用**。顶层不读
// process.env、不建 server、不注册任何进程级 signal 或 timer;全部输入靠参数注入。
//
// 不注册 signal、不决定退出码、不调用 process.exit——那些都是 main 的事。
const http = require('node:http');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_DRAIN_TIMEOUT_MS = 15000;
// 排空期间重扫空闲连接的间隔。它是内部常量,**不读环境变量**(这不是运维该调的旋钮);
// 测试可以通过 idleScanIntervalMs 注入别的值来反证扫描确实在起作用。
const DEFAULT_IDLE_SCAN_INTERVAL_MS = 25;
// flush 至少要留这么多预算,否则 drainTimeoutMs 很小时 flush 会被瞬间判超时。
const MIN_FLUSH_BUDGET_MS = 1000;
const DRAIN_ENV = 'MIXR_DRAIN_TIMEOUT_MS';

// 与 mixrouter.js 的 `function envInt(name, fallback, min, max)` 同口径:非安全整数或越界一律回落默认。
// (原先这里写的是"mixrouter.js:81-85",那个行号已经漂了:**别在注释里钉行号**,
//  钉住的当天是对的、第二天就是错的。用能搜到的符号定位。)
// 差别只在读取时机——那个是模块顶层读,这里是 createLifecycle() 被调用时读一次。
function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

const WARN = {
  ALT_BIND_FAILED: 'alt-bind-failed',
  CLOSE_FAILED: 'close-failed',
  ALT_DUPLICATE: 'alt-duplicate',
  DRAIN_TIMEOUT: 'drain-timeout',
  FLUSH_FAILED: 'flush-failed',
  FLUSH_TIMEOUT: 'flush-timeout',
  START_FAILED: 'start-failed',
  STOPPED_WITHOUT_START: 'stopped-without-start',
};

// 只允许回环:8787/8788 写死只绑回环是现有的安全属性,这个模块不能成为松开它的口子。
// 只认**字面量**回环地址:'localhost' 被排除,因为 server.listen(port,'localhost') 是
// 按 hosts/DNS 解析之后再绑的——解析到什么就绑到什么,字符串校验通过不等于绑在回环上。
// 这道校验要守的是"绝不绑到非回环接口"这条现有安全属性,所以只接受没有解析余地的写法。
//
// 排除 'localhost' 是**安全策略,不是可用性限制**——别把它当成"这写法绑不上"来读:
// 本机实测(Node v24.18.0 / v18.20.8 各一次) listen(0,'localhost') 是**能绑成**的,
// 落到 addr=127.0.0.1。能绑成恰恰是它危险的地方:绑到哪由 /etc/hosts 决定,
// 哪天那行被改成外网地址,校验照样通过而服务已经暴露。
//
// 方括号形式 '[::1]' 反过来:**拒绝是对的,但理由不是安全问题**——它就是绑不上。
// 实测两个版本都直接 EADDRNOTAVAIL:方括号是 URL 里写 IPv6 字面量的记法,
// 不是 listen() 接受的 host 形态(不带括号的 '::1' 两个版本都正常绑成 addr=::1)。
// 留着它只会把必然失败推迟到 bind 才炸,所以这里只接受 '::1'。
//
// 每个点分段的十进制值必须 <=255:原先的形状正则 ^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$ 会
// **接受 '127.999.999.999'**——它只是长得像回环地址,其实不是合法 IPv4,实测绑定必然
// EADDRNOTAVAIL。加上区间校验后接受的正好是 127/8 这个 RFC 1122 定义的回环网段。
//
// 说清楚这道校验**能**保证什么、**不能**保证什么:它保证"接受 ⇒ 是字面量回环地址、
// 没有解析余地",不保证"接受 ⇒ 一定绑得上"。127/8 里只有 127.0.0.1 在本机 lo0 上有
// 地址(实测 '127.1.2.3'、'127.255.255.255'、'127.0.0.0' 两个版本都 EADDRNOTAVAIL,
// Linux 上则整段 127/8 都路由到 lo)。这类地址仍然是**真回环地址**,绑不上交给 bind
// 报 EADDRNOTAVAIL 是干净失败,不需要、也不该在这里拦。
const isLoopbackHost = host => {
  if (host === '::1') return true;
  const parts = host.split('.');
  return parts.length === 4
    && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)
    && Number(parts[0]) === 127;
};

const isPort = value => Number.isSafeInteger(value) && value >= 0 && value <= 65535;

// 绑一个监听口。**任何参数校验都必须已经在这个函数之外完成**——主会话要求
// 「非法 host 在 create 时同步抛,且抛之前没有 listen 过任何口」,所以这里只管绑。
function bind(port, host, handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    const onError = error => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(server); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// flush 整体失败(没法分到某个目标上)时用的 key,与真实目标名区分开。
const OVERALL = '_overall';

function createLifecycle(options = {}) {
  const {
    host = DEFAULT_HOST,
    proxyPort = 0,
    uiPort = 0,
    altPorts = [],
    proxyHandler,
    apiHandler,
    idleScanIntervalMs = DEFAULT_IDLE_SCAN_INTERVAL_MS,
    onFlush,
    onWarning,
  } = options;

  // ---- 先把参数全部校验完,再碰任何监听。顺序不能反:先绑上再抛会留下一个开着的端口。
  if (typeof host !== 'string' || !isLoopbackHost(host))
    throw new TypeError(`host 只允许回环地址,收到 ${JSON.stringify(host)}`);
  if (!isPort(proxyPort)) throw new TypeError(`proxyPort 必须是 0..65535 的整数,收到 ${JSON.stringify(proxyPort)}`);
  if (!isPort(uiPort)) throw new TypeError(`uiPort 必须是 0..65535 的整数,收到 ${JSON.stringify(uiPort)}`);
  if (!Array.isArray(altPorts)) throw new TypeError('altPorts 必须是数组');
  if (proxyHandler !== undefined && typeof proxyHandler !== 'function')
    throw new TypeError('proxyHandler 必须是函数');
  if (apiHandler !== undefined && typeof apiHandler !== 'function')
    throw new TypeError('apiHandler 必须是函数');
  if (!Number.isSafeInteger(idleScanIntervalMs) || idleScanIntervalMs < 0)
    throw new TypeError(`idleScanIntervalMs 必须是非负整数,收到 ${JSON.stringify(idleScanIntervalMs)}`);
  if (onFlush !== undefined && typeof onFlush !== 'function') throw new TypeError('onFlush 必须是函数');
  if (onWarning !== undefined && typeof onWarning !== 'function') throw new TypeError('onWarning 必须是函数');

  const drainTimeoutMs = options.drainTimeoutMs === undefined
    ? envInt(DRAIN_ENV, DEFAULT_DRAIN_TIMEOUT_MS, 0, 2147483647)
    : options.drainTimeoutMs;
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 0)
    throw new TypeError(`drainTimeoutMs 必须是非负整数,收到 ${JSON.stringify(drainTimeoutMs)}`);

  const warnings = [];
  const warn = (code, message, detail) => {
    warnings.push({ code, message, detail });
    if (!onWarning) return;
    try { onWarning(code, message, detail); }
    catch (e) { console.error(`[lifecycle] onWarning 自身抛错: ${e && e.message}`); }
  };

  // 每个监听口自己数连接:走公开的 'connection' 事件维护 socket 集合,不读
  // server._connections(内部字段,不适合用来对外上报)。
  const tracked = new Map(); // server -> Set<socket>
  // 幂等:重复调用直接返回,不清空已经收集到的连接集合。
  // 这个 guard 不是为修漏计(漏计已由上面的调用时机修掉),而是为了让"误用无害":
  // 无 guard 时,同一个 server 传第二次会 set 一个新的 Set 覆盖旧的,已收集的连接被
  // 静默清空(独立探针实测:重复 track 前计数 1 → 后计数 0;有 guard 时 1 → 1)。
  //
  // **这个 guard 同样没有回归锁**,原因是"重复 track"在当前代码里根本不可达:
  // start() 记忆化了 doStart(),连调三次 start 也只会执行一次 track(实测 proxy 上
  // 只有我们注册的那一个 'connection' 监听器;listenerCount 读到的 2 = Node 内部
  // 那一个 + 我们这一个,别把它当成"执行了两次")。三个调用点(proxy/ui/alt)各传
  // 不同 server。所以注入"重复 track"后整份测试仍然 27/27 绿 —— 这是诚实记录,
  // 不是漏测:这条 guard 的价值是"万一将来有人在别处多调一次也不会丢数据",
  // 而不是被某个断言钉住。
  const track = server => {
    if (tracked.has(server)) return;
    const sockets = new Set();
    tracked.set(server, sockets);
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
  };
  const connectionsOf = server => (tracked.get(server) || new Set()).size;

  let proxyServer = null;
  let uiServer = null;
  // close() 一旦调用 address() 立刻返回 null,而超时强清正好发生在那之后,
  // 所以实际端口要在 bind 成功时就记下来,不能等到上报时再问 server。
  let proxyBoundPort = null;
  let uiBoundPort = null;
  const altServers = [];
  let startup = null;      // 记忆化的 start promise
  let report = null;       // start 成功后的快照
  let startError = null;
  let stopping = null;     // 记忆化的 stop promise
  let stopped = false;
  let lastStop = null;

  const listeners = () => {
    const out = [];
    if (proxyServer) out.push({ name: 'proxy', server: proxyServer, port: proxyBoundPort, requested: proxyPort });
    if (uiServer) out.push({ name: 'ui', server: uiServer, port: uiBoundPort, requested: uiPort });
    for (const entry of altServers)
      out.push({ name: 'alt', server: entry.server, port: entry.port, requested: entry.requested });
    return out;
  };

  const snapshot = () => {
    const describe = server => server && server.address()
      ? { port: server.address().port, address: { ...server.address() } }
      : { port: null, address: null };
    return {
      host,
      // stop 之后 server 句柄还留着(用于收尾与诊断),但已经不再接连接了。
      listening: !stopped && !!(proxyServer || uiServer),
      starting: !!startup && !report && !startError,
      stopping: !!stopping && !stopped,
      stopped,
      proxy: describe(proxyServer),
      ui: describe(uiServer),
      alt: altServers.map(entry => ({
        requested: entry.requested,
        port: entry.server.address() ? entry.server.address().port : null,
        address: entry.server.address() ? { ...entry.server.address() } : null,
      })),
      warnings: warnings.map(entry => ({ ...entry })),
      startError: startError ? { ...startError } : null,
    };
  };

  // 只关自己持有的句柄。实测:绑失败的 server listening=false/address()=null,
  // 对它 close() 得 ERR_SERVER_NOT_RUNNING,占用该端口的**别的进程完全不受影响**。
  const closeServer = (server, label) => new Promise(resolve => {
    if (!server) return resolve();
    try {
      server.close(error => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING')
          warn(WARN.CLOSE_FAILED, `关闭 ${label} 监听时出错: ${error.message}`);
        resolve();
      });
    } catch (e) {
      // 从未 listen 过的 server 在某些版本上 close 会同步抛
      if (e.code !== 'ERR_SERVER_NOT_RUNNING')
        warn(WARN.CLOSE_FAILED, `关闭 ${label} 监听时出错: ${e.message}`);
      resolve();
    }
  });

  // ---- 启动
  function doStart() {
    const started = [];
    const cleanupStarted = async () => {
      await Promise.all(started.map(entry => closeServer(entry.server, entry.name)));
      for (const entry of started) tracked.delete(entry.server);
    };
    return (async () => {
      let proxy;
      let ui;
      try {
        // 两个主监听都要成功才算成功:先起一个,失败即回滚。
        // track 必须在 bind 成功的当场调用,不能等两个主监听都绑完:bind 在 'listening'
        // 上 resolve,**proxy 从这一行返回就已在接受连接**,而这中间还隔着 ui 的 await,
        // 晚一步就会漏计那段窗口里到达的连接 —— 独立探针实测漏计成立(计数 1 / 实际 2),
        // 于是 forcedDetail 与强清告警的条数会少报(排空本身不受影响,是观测失真)。
        //
        // **这条时序没有回归测试**:窗口是亚毫秒级,走公开 API 打不中(顺序发包 0/15 次,
        // 并发 8 个 connect 抢时间对未修复版本 0/12 次),而写一条对未修复版本也永远绿的
        // 断言没有意义。改为让 track 幂等,把"误用"的代价降为零(见下面 track 的定义,
        // 那里另记了"连幂等性本身也没有回归锁"及实测依据)。
        // 改动记录里也必须写明这一处**没有回归锁**——"有测试文件"不等于"有回归锁"。
        proxy = await bind(proxyPort, host, proxyHandler).then(server => {
          started.push({ name: 'proxy', server }); track(server); return server;
        });
        ui = await bind(uiPort, host, apiHandler).then(server => {
          started.push({ name: 'ui', server }); track(server); return server;
        });
      } catch (e) {
        await cleanupStarted();              // 清掉已经起来的那个,不留半启动
        startError = { code: e.code || '', message: e.message };
        warn(WARN.START_FAILED, `主监听启动失败: ${e.message}`, startError);
        throw e;                             // 原始错误原样抛出,不被清理错误顶掉
      }
      proxyServer = proxy;
      uiServer = ui;
      proxyBoundPort = proxy.address().port;
      uiBoundPort = ui.address().port;

      // 兼容监听:best-effort,失败只告警,保留主监听。
      const taken = new Set([proxyBoundPort, uiBoundPort]);
      const seen = new Set();
      for (const requested of altPorts) {
        if (!isPort(requested) || requested === 0) continue;
        const duplicateOfPrimary = requested === proxyPort || requested === uiPort;
        if (seen.has(requested)) {          // altPorts 自身写重了,与"和主监听撞车"同样告警
          warn(WARN.ALT_DUPLICATE, `兼容监听端口 ${requested} 在 altPorts 里重复,已跳过`);
          continue;
        }
        seen.add(requested);
        if (duplicateOfPrimary || taken.has(requested)) {   // proxyPort=0 时也可能与实际分配的口撞上
          warn(WARN.ALT_DUPLICATE, `兼容监听端口 ${requested} 与主监听重复,已跳过`);
          continue;
        }
        try {
          const server = await bind(requested, host, proxyHandler);
          track(server);
          altServers.push({ requested, server, port: server.address().port });
          taken.add(server.address().port);
        } catch (e) {
          warn(WARN.ALT_BIND_FAILED, `兼容监听 :${requested} 未拿到(${e.code || e.message})——该端口上还有别的服务在跑,不影响主端口`);
        }
      }
      report = snapshot();
      return report;
    })();
  }

  function start() {
    if (!startup) startup = doStart();
    // 返回**当下重新求值**的快照,不是 doStart 里定格的 report:
    // stop 之后再调 start 时,定格的 report 里还写着 listening:true 与一个已经关掉的端口,
    // 调用方拿它去拼横幅或写 /api/state 就会自报一个没人监听的端口。
    return startup.then(() => snapshot());
  }

  // ---- 排空:周期重扫空闲连接。
  // 单次扫描不够(实测 6321ms vs 335ms):在途请求结束、socket 转空闲之后没人再扫,
  // close 回调要等到 keepAliveTimeout。
  function drain(timeoutMs) {
    const entries = listeners();
    const closed = Promise.all(entries.map(entry => closeServer(entry.server, entry.name)));
    let finished = false;
    closed.then(() => { finished = true; });
    if (!entries.length) return { closed: Promise.resolve(), stopSweeping: () => {}, forced: () => [] };
    const sweep = () => {
      if (finished) return;
      for (const entry of entries)
        try { entry.server.closeIdleConnections(); } catch { /* 已经关完 */ }
    };
    sweep();
    // 不 unref:排空期间必须让事件循环活着,否则 drain 还没走完进程就先退了。
    const tick = timeoutMs > 0 && idleScanIntervalMs > 0
      ? setInterval(sweep, idleScanIntervalMs)
      : null;
    const stopSweeping = () => {
      if (tick) clearInterval(tick);
      finished = true;
    };
    return {
      closed,
      stopSweeping,
      // 超时后强清**自己的**连接,并按监听口报数(只报端口与条数)。
      forced: () => entries.map(entry => ({
        listener: entry.name,
        port: entry.port,
        connections: connectionsOf(entry.server),
      })).filter(item => item.connections > 0),
    };
  }

  const withTimeout = (promise, ms) => {
    if (!(ms > 0)) return Promise.resolve({ timedOut: true });
    let timer;
    return Promise.race([
      Promise.resolve(promise).then(value => ({ timedOut: false, value })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), ms); }),
    ]).finally(() => clearTimeout(timer));
  };

  // ---- 收尾落盘。按目标分列求值:一个失败不掩盖另外三个的结果。
  async function runFlush(budgetMs) {
    if (!onFlush) return { result: {}, flushError: null, incomplete: false };
    let outcome;
    try {
      outcome = await withTimeout(Promise.resolve().then(() => onFlush()), budgetMs);
    } catch (e) {
      return { result: {}, flushError: { [OVERALL]: e && e.message ? e.message : String(e) }, incomplete: false };
    }
    if (outcome.timedOut)
      return { result: {}, flushError: null, incomplete: true };

    const raw = outcome.value;
    if (!raw || typeof raw !== 'object')
      return {
        result: {},
        flushError: { [OVERALL]: `onFlush 必须返回按目标分列的对象,收到 ${JSON.stringify(raw)}` },
        incomplete: false,
      };

    const result = {};    // 每个目标各自的结局(成与败都留)
    const flushError = {}; // 只放失败项
    for (const [goal, value] of Object.entries(raw)) {
      if (value && typeof value === 'object' && 'ok' in value) {
        result[goal] = value.ok === true ? { ok: true } : { ok: false, error: value.error };
        if (value.ok !== true) flushError[goal] = value.error;
      } else if (value === undefined || value === null) {
        result[goal] = { ok: true };
      } else {
        result[goal] = { ok: false, error: '目标返回值形状不对' };
        flushError[goal] = '目标返回值形状不对';
      }
    }
    return { result, flushError: Object.keys(flushError).length ? flushError : null, incomplete: false };
  }

  // ---- 停止:幂等,固定顺序 停收新连接 -> 排空 -> flush -> 超时才强清。
  function doStop() {
    const stopStartedAt = Date.now();
    const drainTimeout = drainTimeoutMs;
    let drained = false;
    let forced = false;
    let forcedDetail = [];
    let flushError = null;
    let flushIncomplete = false;
    let flushResult = {};

    const finish = () => {
      stopped = true;
      // 进入这里时排空已经结束(要么排空完、要么撞上 drainTimeout),这个耗时才有意义。
      // 不要报"强清时还剩多少预算":那必然已 <= 0,是个恒为 0 的死字段。
      const drainElapsedMs = Date.now() - stopStartedAt;
      const result = {
        ok: !flushError && !flushIncomplete,
        forced,
        forcedDetail,
        drained,
        flushResult,
        flushError,
        flushIncomplete,
        startError: startError ? { ...startError } : null,
        warnings: warnings.map(entry => ({ ...entry })),
        drainElapsedMs,
        stoppedAt: new Date().toISOString(),
      };
      lastStop = result;
      return result;
    };

    return (async () => {
      // S1 等启动 settle:避免绑定中途被拆。start 失败不重复抛,只记进 startError。
      if (startup && !report) {
        try { await startup; } catch { /* startError 已经记过 */ }
      }
      if (!startup && !proxyServer && !uiServer)
        warn(WARN.STOPPED_WITHOUT_START, '在 start 之前调用了 stop,只做收尾落盘');

      // S2/S3 停收新连接 + 排空(周期扫空闲连接)
      if (listeners().length) {
        const drainer = drain(drainTimeout);
        const outcome = await withTimeout(drainer.closed, drainTimeout);
        drainer.stopSweeping();
        if (outcome.timedOut) {
          forced = true;
          forcedDetail = drainer.forced();
          const detail = forcedDetail.map(item => `${item.listener}:${item.port} ${item.connections} 条`).join(', ');
          warn(WARN.DRAIN_TIMEOUT,
            `${drainTimeout}ms 内没能排空,强制断开自己的 ${forcedDetail.reduce((n, i) => n + i.connections, 0)} 条连接(${detail || '无'})`,
            forcedDetail);
          for (const entry of listeners()) {
            try { entry.server.closeAllConnections(); } catch { /* 已经关完 */ }
          }
          await Promise.all(listeners().map(entry => closeServer(entry.server, entry.name)));
        }
        drained = !forced;
      }

      // S4 收尾落盘。**排在关连接之后**:它失败也不回滚前面已经关掉的监听。
      // flush 自己受剩余预算约束,不让 stop 挂死。
      const remaining = drainTimeout > 0 ? Math.max(MIN_FLUSH_BUDGET_MS, stopStartedAt + drainTimeout - Date.now()) : MIN_FLUSH_BUDGET_MS;
      const flushed = await runFlush(remaining);
      flushError = flushed.flushError;
      flushIncomplete = flushed.incomplete;
      flushResult = flushed.result;
      if (flushIncomplete) warn(WARN.FLUSH_TIMEOUT, `落盘在 ${remaining}ms 预算内没结束,已放弃等待(不代表落盘成功)`, flushed.result);
      else if (flushError) warn(WARN.FLUSH_FAILED, `落盘有目标失败: ${Object.keys(flushError).join(', ')}`, flushError);

      return finish();
    })();
  }

  function stop() {
    if (!stopping) stopping = doStop().catch(e => {
      // doStop 自身意外出错也要给出一个可判读的结果,而不是把 stop 挂成永远 pending
      warn(WARN.FLUSH_FAILED, `停止流程意外出错: ${e && e.message}`);
      stopped = true;
      lastStop = { ok: false, forced: false, forcedDetail: [], drained: false, flushResult: {},
        flushError: { [OVERALL]: e && e.message ? e.message : String(e) }, flushIncomplete: false,
        startError: startError ? { ...startError } : null, warnings: warnings.map(w => ({ ...w })),
        drainElapsedMs: 0, stoppedAt: new Date().toISOString() };
      return lastStop;
    });
    return stopping;
  }

  return {
    start,
    stop,
    state: () => ({ ...snapshot(), lastStop: lastStop ? { ...lastStop } : null }),
    servers: () => ({ proxy: proxyServer, ui: uiServer, alt: altServers.map(entry => entry.server) }),
  };
}

module.exports = { createLifecycle, DEFAULT_DRAIN_TIMEOUT_MS, DEFAULT_IDLE_SCAN_INTERVAL_MS, WARN };
