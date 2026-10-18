'use strict';
// 压缩选择只管理两类内容规则;规则名可改,身份来自 when.body。
const crypto = require('crypto');
const { poolMembers } = require('./pool');
const { normalizeRule } = require('./rules');
const { COMPACT_RULES, compactKind } = require('./compact-signature');
const { resolveKey, publicKeys, activeKeyId } = require('./keys');
const invalid = message => Object.assign(new Error(message), { statusCode: 400 });
const routeRevision = routes => crypto.createHash('sha256').update(JSON.stringify(routes)).digest('hex');
const hasKeyPin = rule => !!compactKind(rule) && rule.key_id !== undefined && rule.key_id !== '';
function pinnedProvider(rule, providers) {
  if (!hasKeyPin(rule) || (rule.pool && (!Array.isArray(rule.pool) || rule.pool.length))) return null;
  const matches = providers.filter(p => p.id === rule.provider);
  const provider = matches.length === 1 ? matches[0] : null;
  const key = provider && provider.enabled !== false && resolveKey(provider, rule.key_id);
  return key ? { ...provider, api_key: key.key } : null;
}
function checkRevision(routes, expected) {
  if (expected === undefined) return; // 脚本可省略;控制台总带载入时的版本。
  if (typeof expected !== 'string') throw invalid('expected_revision 必须是字符串');
  if (expected !== routeRevision(routes)) throw Object.assign(new Error('服务端路由已变化，请重新载入后再保存'), { statusCode: 409 });
}
function compactPublic(routes, providers) {
  const rules = (routes.rules || []).filter(compactKind).map(rule => {
    const pinned = hasKeyPin(rule);
    const members = poolMembers(providers, rule);
    // 单一目标被删后仍显示原渠道与 Key ID,让用户能看见并修复失效绑定。
    if (!members.length && rule.provider && !rule.pool?.length)
      members.push({ provider: { id: rule.provider, enabled: false }, model: rule.model || '', weight: 1 });
    const targets = members.map(m => {
      const p = m.provider;
      const keyId = pinned ? rule.key_id : '';
      const resolvedKeyId = pinned ? keyId : activeKeyId(p);
      const key = resolveKey(p, resolvedKeyId);
      const labels = publicKeys(p).filter(k => k.id === resolvedKeyId);
      return { provider: p.id, name: p.name || p.id, model: m.model,
        enabled: p.enabled !== false, weight: m.weight, key_id: keyId,
        key_label: labels.length === 1 ? labels[0].label : (typeof keyId === 'string' ? keyId : ''),
        key_available: !!key && p.enabled !== false && (!pinned || !!pinnedProvider(rule, providers)) };
    });
    return { id: rule.id, kind: compactKind(rule), enabled: rule.enabled !== false,
      strategy: rule.strategy, has_pool: !!rule.pool?.length, targets };
  });
  const complete = COMPACT_RULES.every(spec => rules.some(r => r.kind === spec.kind));
  const first = rules[0]?.targets[0];
  const single = complete && first && rules.every(r => r.enabled && r.targets.length === 1
    && r.targets[0].enabled && r.targets[0].key_available && r.targets[0].provider === first.provider
    && r.targets[0].model === first.model && r.targets[0].key_id === first.key_id);
  return { key_selection_supported: true, revision: routeRevision(routes), mode: !rules.length ? 'unconfigured' : single ? 'single' : 'mixed',
    selection: single ? { provider: first.provider, model: first.model, key_id: first.key_id } : null, rules,
    providers: providers.filter(p => p.enabled !== false).map(p => ({ id: p.id, name: p.name || p.id,
      models: [...new Set((p.models || []).filter(m => typeof m === 'string' && m.trim()))],
      keys: publicKeys(p), active_key: activeKeyId(p) })) };
}
function selectCompact(routes, providers, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('请求体必须是 JSON 对象');
  checkRevision(routes, input.expected_revision);
  if (typeof input.provider !== 'string' || !input.provider.trim()) throw invalid('请选择 Claude 组渠道');
  const provider = input.provider.trim();
  const selected = providers.find(p => p.id === provider);
  if (!selected) throw invalid('Claude 组渠道不存在');
  if (selected.enabled === false) throw invalid('所选渠道已停用');
  if (typeof input.model !== 'string' || !input.model.trim() || /[\x00-\x1f\x7f]/.test(input.model))
    throw invalid('模型名必须是非空字符串，不能包含控制字符');
  const model = input.model.trim();
  if (input.key_id !== undefined && typeof input.key_id !== 'string') throw invalid('key_id 必须是字符串');
  const keyId = input.key_id || '';
  if (keyId && input.pool && (!Array.isArray(input.pool) || input.pool.length))
    throw invalid('压缩专用 Key 只支持单一渠道，不能同时配置 pool');
  if (keyId && !resolveKey(selected, keyId)) throw invalid('所选 Key 不存在、重复、已停用或不可用');
  const next = structuredClone(routes);
  const found = new Set();
  for (const rule of next.rules) {
    const kind = compactKind(rule);
    if (!kind) continue;
    found.add(kind);
    // pool 的成员 model 优先于 rule.model。显式选单渠道必须同时清池。
    Object.assign(rule, { provider, model, pool: [], app: 'claude', enabled: true });
    if (keyId) rule.key_id = keyId; else delete rule.key_id;
  }
  for (const spec of COMPACT_RULES) {
    if (found.has(spec.kind)) continue;
    let id = 'compact-' + spec.kind;
    while (next.rules.some(r => r.id === id)) id += '-new';
    next.rules.push(normalizeRule({ id, match: '', app: 'claude', enabled: true,
      priority: spec.priority, strategy: 'priority', when: { body: spec.body }, provider, model, pool: [], key_id: keyId }));
  }
  return next;
}
module.exports = { COMPACT_RULES, compactKind, routeRevision, checkRevision, compactPublic, selectCompact,
  hasKeyPin, pinnedProvider };
