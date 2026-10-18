'use strict';
// 只在 test/lifecycle-wiring.test.js 里被 spawn 的探针进程,不是产品代码。
// 用途:把 mixrouter.js 里那段 onFlush **抄成可注入的三档形状**,再用真 lifecycle 的
// 公开入口 stop() 跑一遍,把「分目标 try/catch」与「一句 try{四个一起}catch{}」的差别
// 变成可观测的输出。不这么抄就没法对照:现役写法长在 main 块里,被 require 时不执行。
//
// 档位(inject):
//   'none'        每个目标各自 try/catch(接线后 mixrouter.js 的形状)
//   'naive'       现役形状:一句 try 包住四个
//   'skip-flush'  flush 整个不执行(lifecycle 在 !onFlush 时立刻返回 {})——用来构造
//                 「S4 收尾落盘没被执行」的对照,证明那条不变式的断言有鉴别力
//   'slow-flush'  落盘耗时超过排空预算,用来验「排空不许把 flush 的预算吃光」
//
// 每个目标先落一个标记文件再去判断要不要抛:这样「这个目标到底跑没跑到」是文件系统上的
// 事实,不是我从返回值里反推的。
const fs = require('node:fs');
const path = require('node:path');

const repo = process.argv[2];
const inject = process.argv[3] || 'none';
const holdMs = Number(process.argv[4] || 0);

const { createLifecycle } = require(path.join(repo, 'lib/server/lifecycle.js'));

const DATA_DIR = process.env.MIXR_DATA_DIR;
const GOALS = ['store', 'routes', 'slots', 'sessions'];

// store 抛 + 其余三个不抛:这是把「第一个抛,后面全跳过」暴露得最干净的一档
// (若改成最后一个抛,前面三个已经跑过,缺失只剩 1 个,差别不显眼)。
const throwsFor = goal => (inject === 'naive' || inject === 'none') && goal === 'store';

const touch = goal => fs.writeFileSync(path.join(DATA_DIR, `touched-${goal}.txt`), '1');
const target = goal => () => { touch(goal); if (throwsFor(goal)) throw new Error(`${goal} 写失败(注入)`); };

const perTargetFlush = () => {
  const result = {};
  for (const goal of GOALS) {
    try { target(goal)(); result[goal] = { ok: true }; }
    catch (e) { result[goal] = { ok: false, error: e.message }; }
  }
  return result;
};
// 现役那一句的忠实复刻:第一个抛,后面三个连跑都没跑,而且没人知道。
const naiveFlush = () => {
  for (const goal of GOALS) target(goal)();
  return { store: { ok: true }, routes: { ok: true }, slots: { ok: true }, sessions: { ok: true } };
};

// 慢落盘:落盘本身没错,但慢到吃光预算 —— 这一档测的是「排空不能把预算耗尽,
// 让 flush 被瞬间判超时」。lifecycle 用停止起点的绝对时刻 + drainTimeout 兜底时,
// 这一档照样会成功;若被写成「先排空 drainTimeout、再给 flush 一个 drainTimeout」,
// 总预算就会变成两倍,并且这一档会以 flush 超时收场。
const slowFlush = () => {
  const until = Date.now() + 1500;
  while (Date.now() < until) { /* 忙等,占住这 1.5s */ }
  return perTargetFlush();
};

const onFlush = inject === 'skip-flush' ? undefined
  : inject === 'slow-flush' ? slowFlush
    : (inject === 'naive' ? naiveFlush : perTargetFlush);

const lc = createLifecycle({
  host: '127.0.0.1', proxyPort: 0, uiPort: 0, altPorts: [],
  proxyHandler: (req, res) => {
    // 在途响应:排空必须等它,而不是掐断它
    setTimeout(() => { try { res.writeHead(200); res.end('ok'); } catch { /* 已被强清 */ } }, holdMs);
  },
  apiHandler: (req, res) => { res.writeHead(200); res.end('{}'); },
  drainTimeoutMs: Number(process.env.MIXR_TEST_DRAIN_MS || 2000),
  idleScanIntervalMs: 25,
  onFlush,
  onWarning: () => {},
});

process.on('SIGTERM', async () => {
  const t0 = Date.now();
  const r = await lc.stop();
  console.log('STOP=' + JSON.stringify({
    elapsedMs: Date.now() - t0,
    ok: r.ok,
    forced: r.forced,
    drained: r.drained,
    flushError: r.flushError,
    flushIncomplete: r.flushIncomplete,
    flushResult: r.flushResult,
  }));
  process.exit(0);
});

lc.start().then(rep => {
  console.log('LISTEN=' + JSON.stringify({ proxy: rep.proxy.port, ui: rep.ui.port }));
}).catch(e => { console.error('start 失败: ' + e.message); process.exit(1); });
