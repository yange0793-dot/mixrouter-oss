'use strict';
// waitFor —— 夹具里"等某件事发生"的统一写法。
//
// **存在理由(不是洁癖,是实测出来的)**:
// 下面三处夹具以前都写成"先 sleep(一个小数字),再做一件依赖异步已完成的事",
// 而 sleep 只是**乐观**的等待。在共享 CI runner 上(2 核、同时还在跑别的作业)
// 或本机并发跑多份测试时,那个小数字随时会被调度延迟吃掉,失败信息却是
// "release is not a function" / "冷却期内全部落到 pb" 这种**指错方向**的话 ——
// 读的人会去查实现,而实现是对的。
//
// 实测(Node 18 本机并发跑全集,复现出与 CI 同一类失败):
//   · test/server-lifecycle.test.js M4  —— release 还没被赋值就调用,报 "release is not a function"
//   · test/health.test.js 加权池       —— 3 次串行请求耗到 >60ms,冷却自己过期了
//   · test/timeout-budget.test.js      —— 桩上游 flush 头的那一跳被调度推迟到 400ms 预算之后
//
// 症状的差别只在"心跳"是什么:句柄赋值、时间戳、还是 socket 里的字节。
// 判据一旦落到"心跳发生"上,这三处就都稳了,而且**失败时的信息说的是真话**:
// 超时时直接告诉你等的是什么、等了多久、现在什么状态,而不是丢一个 TypeError。
//
// 用法:
//   await waitFor(() => release, { label: '在途请求已被处理(处理函数已赋值)' });
//   await waitFor(() => Date.now() - t0 > 60, { label: '短冷却已过期' });
//   await waitFor(() => bytes.length > 0, { label: '桩上游已 flush 响应头' });
//
// 约定:
//   · 必须给 label —— 超时信息里没有它,下一个被这条坑到的人还得从头查一遍
//   · 默认 5s 上限。夹具里**不该**再出现"等不到就静默继续"的写法
//   · 轮询间隔默认 5ms:比任何一次事件循环往返都短,又不会把 CPU 烧满
//   · 不用 setTimeout(x, 0) 硬转圈:那会让"等不到"变成死循环而不是一条超时
class WaitForTimeout extends Error {}

function waitFor(predicate, { timeoutMs = 5000, intervalMs = 5, label = '条件' } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false;
      let value;
      try { value = predicate(); ok = !!value; }
      catch (e) {
        // 断言函数自己抛就别当成"条件不满足"死等:那不是等待失败,是判据写错了
        return reject(Object.assign(new Error(`${label} 的判定函数抛错: ${e.message}`), { cause: e }));
      }
      if (ok) return resolve(value);
      if (Date.now() - started >= timeoutMs) {
        return reject(new WaitForTimeout(`等不到「${label}」(已等 ${Date.now() - started}ms,上限 ${timeoutMs}ms)`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

module.exports = { waitFor, WaitForTimeout };
