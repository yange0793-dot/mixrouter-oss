'use strict';
// 渠道池的**运行状态**:轮转游标 + 渠道冷却表。
//
// 这三样以前和"哪个对话绑哪个渠道"(会话绑定表)挤在同一个工厂里(sessions.js:24-26),
// 于是"会话"这个词同时指三件事:用户显式保存的覆盖、代理自动记下的粘性绑定、以及纯粹
// 属于池子自己的运行时数据。拆开之后 sessions.js 只管会话,这里只管池子:
//   · 本模块不认识会话,也不落盘——游标与冷却是进程内的瞬时状态,重启即归零
//     (绑定表要落盘是因为它代表"这个对话走这里"的决定;冷却不是决定,是一次失败之后的等待)
//   · 与 sessions.js 一样是工厂 + 注入时钟,方便隔离测试
//
// 语义与原实现逐字一致:游标按 ruleId 存(同一规则下所有会话共用一个游标),
// 加权轮的余量存在 `__w_<ruleId>` 键下;冷却截止时间到点即自然失效。

function createPoolState(deps = {}) {
  const { cooldownMs } = deps;
  const now = deps.now || (() => Date.now());

  let pools = {};       // ruleId -> 轮转游标(round_robin / weighted 用)
  let cooldowns = {};   // providerId -> 冷却截止时间戳

  function markCooldown(providerId) {
    if (!providerId) return;
    cooldowns[providerId] = now() + cooldownMs;
  }
  const inCooldown = id => (cooldowns[id] || 0) > now();

  // 到点的冷却条目删掉,别让表无限长下去(渠道 id 会随删改累积)
  function pruneCooldowns() {
    const t = now();
    for (const [id, until] of Object.entries(cooldowns)) if (until <= t) delete cooldowns[id];
  }

  return {
    markCooldown, inCooldown, pruneCooldowns,
    get pools() { return pools; },
    // 整份作废(测试与"规则变了、旧游标无意义"时用)
    resetPools() { pools = {}; },
    get cooldowns() { return cooldowns; },
    // 传非对象退化成空表,不抛:旧调用点就是 `cooldowns = {}` 这种整份赋值语义
    set cooldowns(v) { cooldowns = (v && typeof v === 'object') ? v : {}; },
  };
}

module.exports = { createPoolState };
