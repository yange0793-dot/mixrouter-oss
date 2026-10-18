'use strict';
// 渠道池成员归一化 + 规则里指向已删渠道的引用检查。
// 纯查表:本组渠道数组 group、渠道 id → 渠道对象 findProvider 都由调用方注入,不持有 store。

// 把规则的 pool 归一化成 [{provider, model, weight}],只取本组(app)的渠道
// 池成员里"不存在/已停用"的直接跳过(池的意义就是自动绕开不可用的);
// 但单一 provider 目标即使停用也保留成成员——好让调用方给出 provider_disabled_error
// 而不是含混的 no_route_error
function poolMembers(group, rule, app = 'claude') {
  const raw = (rule && Array.isArray(rule.pool)) ? rule.pool : [];
  const out = [];
  for (const m of raw) {
    const id = typeof m === 'string' ? m : (m && m.provider);
    if (!id) continue;
    const p = group.find(x => x.id === id);
    if (!p || p.enabled === false) continue;
    // Codex 渠道自己就带模型名,池成员/规则没写就用它;Claude 侧是"留空即透传请求模型"
    const model = (typeof m === 'object' && m && m.model) ? m.model
      : (app === 'codex' ? (rule.model || p.model || '') : (rule.model || ''));
    const weight = typeof m === 'object' && m && Number(m.weight) > 0 ? Number(m.weight) : 1;
    out.push({ provider: p, model, weight });
  }
  if (!out.length && rule && rule.provider) {
    const p = group.find(x => x.id === rule.provider);
    if (p) out.push({ provider: p, model: app === 'codex' ? (rule.model || p.model || '') : (rule.model || ''), weight: 1 });
  }
  return out;
}

// 规则里指向"根本不存在的渠道"的引用。停用不算——停用是用户主动的状态,池会跳过、
// 单选会给出 provider_disabled_error;而"渠道 id 压根查不到"只可能是渠道被删了之后
// 规则没跟着解开,用户看不出任何异常,直到请求打上来才发现。
// 返回 [{where, id}],where 说清是单选目标还是池里第几个成员。
function ghostRefs(findProvider, rule) {
  if (!rule) return [];
  const out = [];
  const pool = Array.isArray(rule.pool) ? rule.pool : [];
  pool.forEach((m, i) => {
    const id = typeof m === 'string' ? m : (m && m.provider);
    if (id && !findProvider(id)) out.push({ where: `池成员 ${i + 1}`, id });
  });
  if (rule.provider && !findProvider(rule.provider)) out.push({ where: '单一目标', id: rule.provider });
  return out;
}

module.exports = { poolMembers, ghostRefs };
