'use strict';
// 渠道池的运行状态:现在只剩轮转游标。
//
// 渠道的时间冷却已整体移除,所以 `markCooldown` / `inCooldown` / `pruneCooldowns` /
// `cooldowns` 四个入口**保留签名但不保存任何状态**:线上调用点、控制台旧字段与既有测试
// 仍按这些名字访问,删名会让它们静默失效。它们不影响挑选顺序,也不拒绝请求。
// 失败处理只发生在当前请求内:同渠道换 Key 由 lib/routing/key-fallback.js 的
// failedKeys 集合负责,重试次数与间隔由 lib/proxy/attempts.js 的预算负责。
function createPoolState() {
  let pools = {};

  return {
    markCooldown() {}, inCooldown() { return false; }, pruneCooldowns() {},
    get pools() { return pools; },
    // 整份作废(测试与"规则变了、旧游标无意义"时用)
    resetPools() { pools = {}; },
    get cooldowns() { return {}; },
    set cooldowns(value) {},
  };
}

module.exports = { createPoolState };
