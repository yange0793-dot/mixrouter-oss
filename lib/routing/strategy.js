'use strict';
// 渠道池选择策略。轮询游标由调用方持有;加权选择会更新成员的 current。
// require 不读取配置、不启动服务。

const STRATEGIES = ['round_robin', 'weighted', 'least_used', 'random', 'priority'];

const strategyOf = rule => STRATEGIES.includes(rule && rule.strategy) ? rule.strategy : 'round_robin';

// 平滑加权轮询(nginx 式):无需按权重展开数组,长期比例精确。m.current 是跨请求累积的余量
// ⚠ 本函数**就地改写你传进来的成员对象**(写 m.current 与 best.current)。调用方若要保留原对象,
//   先自行浅拷贝(explain.js 的 pickForPreview 正是这么做的)。
function pickWeighted(members) {
  if (!members.length) return null;
  let total = 0, best = null;
  for (const m of members) {
    m.current = (m.current || 0) + m.weight;
    total += m.weight;
    if (!best || m.current > best.current) best = m;
  }
  best.current -= total;
  return best;
}

// 从池里给这个会话挑一个渠道:冷却中的成员不参与挑选;
// 全池都不可用时退回全量兜底(宁可再试冷却渠道也不死锁)
//   eligible(id)   渠道当前是否可用(健康 + 不在冷却)
//   activeCount(id) 该渠道挂着几个活跃会话(least_used 用)
//   pools          跨请求游标表,由调用方持有,规则变化时整体作废
function pickMember(rule, members, { eligible, activeCount = () => 0, pools = {} } = {}) {
  const cands = members.filter(m => eligible(m.provider.id));
  const pool = cands.length ? cands : members;
  if (pool.length === 1) return pool[0];
  const strat = strategyOf(rule);
  // priority(主备):永远取池序里第一个可用渠道,主渠道冷却中才落到下一个——失败降级语义
  if (strat === 'priority') return pool[0];
  if (strat === 'random') return pool[Math.floor(Math.random() * pool.length)];
  if (strat === 'least_used') {
    let best = pool[0];
    for (const m of pool) if (activeCount(m.provider.id) < activeCount(best.provider.id)) best = m;
    return best;
  }
  const rid = (rule && rule.id) || '_';
  if (strat === 'weighted') {
    // 平滑加权轮询需要跨请求保留 current;按当前候选重建,冷却恢复/新增的渠道能重新进入轮转
    const wkey = '__w_' + rid;
    const prev = Array.isArray(pools[wkey]) ? pools[wkey] : [];
    const w = pool.map(m => {
      const old = prev.find(x => x.provider.id === m.provider.id);
      return old ? { ...m, current: old.current } : { ...m, current: 0 };
    });
    pools[wkey] = w;
    return pickWeighted(w) || pool[0];
  }
  // round_robin:每条规则一个全局游标,与会话标识无关(游标按规则 id 存,同一规则下所有会话共用)
  pools[rid] = pools[rid] || 0;
  const idx = (pools[rid]++) % pool.length;
  return pool[idx];
}

module.exports = { STRATEGIES, strategyOf, pickWeighted, pickMember };
