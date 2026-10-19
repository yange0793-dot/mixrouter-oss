'use strict';
// 会话覆盖只保存渠道/Key ID;每次请求使用独立快照,不切换渠道的共享账号。
const crypto = require('crypto');
const { CLAUDE_SLOTS, CODEX_SLOT_NAME_RE, slotNameFromAlias } = require('./slots');
const { resolveKey, activeKeyId } = require('./keys');
const { hasCtlChar } = require('./headers');

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value, key) => !!value && Object.hasOwn(value, key);
const unsafeName = name => ['__proto__', 'prototype', 'constructor'].includes(name);
const invalid = message => Object.assign(new Error(message), { statusCode: 400 });
const text = value => typeof value === 'string' && !!value.trim() && !hasCtlChar(value);
function fields(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k)))
    throw invalid(`${label} 必须是对象，且只能包含 ${allowed.join(' / ')}`);
}
function providerFor(providers, id) {
  const matches = (Array.isArray(providers) ? providers : []).filter(p => p && p.id === id);
  return matches.length === 1 ? matches[0] : null;
}

function normalizeRouting(value, app, providers) {
  if (!['claude', 'codex'].includes(app)) throw invalid('会话组必须是 claude 或 codex');
  fields(value, ['keys', 'slots'], 'routing');
  const keys = value.keys === undefined ? {} : value.keys;
  const slots = value.slots === undefined ? {} : value.slots;
  if (!object(keys) || !object(slots)) throw invalid('routing.keys 和 routing.slots 必须是对象');
  const out = { keys: {}, slots: {} };
  const target = id => {
    if (!text(id) || unsafeName(id)) throw invalid('渠道 ID 必须是非空字符串，不能包含控制字符或保留名称');
    const p = providerFor(providers, id);
    if (!p || p.enabled === false) throw invalid('所选渠道不存在、重复、已停用或不属于本会话组');
    return p;
  };
  const checkKey = (p, id) => {
    if (!text(id) || !resolveKey(p, id)) throw invalid('所选 Key 不存在、重复、已停用或不可用');
    return id;
  };
  for (const id of Object.keys(keys).sort()) out.keys[id] = checkKey(target(id), keys[id]);
  for (const name of Object.keys(slots).sort()) {
    if (unsafeName(name) || (app === 'claude' ? !CLAUDE_SLOTS.includes(name) : !CODEX_SLOT_NAME_RE.test(name)))
      throw invalid('会话槽位名称不合法');
    const slot = slots[name];
    fields(slot, ['provider', 'model', 'key_id'], '会话槽位');
    const p = target(slot.provider);
    const next = { provider: p.id };
    if (own(slot, 'model')) {
      if (typeof slot.model !== 'string' || hasCtlChar(slot.model)) throw invalid('模型名必须是字符串，不能包含控制字符');
      if (slot.model.trim()) next.model = slot.model.trim();
    }
    if (own(slot, 'key_id')) next.key_id = checkKey(p, slot.key_id);
    out.slots[name] = next;
  }
  return out;
}

// 读取不查渠道清单:渠道/Key 删除后保留引用,让请求报错和控制台修复,不能静默继承。
function routingOf(session) {
  const raw = session && session.routing;
  const out = { keys: {}, slots: {} };
  if (!object(raw)) return out;
  if (object(raw.keys)) for (const id of Object.keys(raw.keys).sort()) {
    if (!unsafeName(id)) out.keys[id] = typeof raw.keys[id] === 'string' ? raw.keys[id] : '';
  }
  if (object(raw.slots)) for (const name of Object.keys(raw.slots).sort()) {
    if (unsafeName(name)) continue;
    const slot = raw.slots[name];
    const next = { provider: typeof slot?.provider === 'string' ? slot.provider : '' };
    if (typeof slot?.model === 'string') next.model = slot.model;
    if (own(slot, 'key_id')) next.key_id = typeof slot.key_id === 'string' ? slot.key_id : '';
    out.slots[name] = next;
  }
  return out;
}
const routingRevision = routing => crypto.createHash('sha256')
  .update(JSON.stringify(routingOf({ routing }))).digest('hex');
const hasRouting = session => {
  const routing = routingOf(session);
  return !!(Object.keys(routing.keys).length || Object.keys(routing.slots).length);
};

// 显式配置 = 用户存下来的东西:Key/槽位覆盖(routing)或手动钉定(pinned)。
// 自动粘性绑定两者都不是。TTL 与容量上限**只回收自动记录**——闲置 12 小时或表满
// 都不能把用户存过的覆盖悄悄丢掉(以前只按 hasRouting 判,pinned 的对话会被 TTL 回收)。
// 会话侧(lib/routing/sessions.js 的 prune/configuredCount/列表)与诊断预览
// (lib/routing/explain.js 的会话快照模拟)共用这一个判据,两处口径必须一致,
// 否则"预览说这条会被回收、实跑却不回收"。
const explicitConfig = session => !!(session && (session.pinned || hasRouting(session)));

function resolveSessionSlot(globalSlot, modelIn, app, routing, providers) {
  const alias = String(modelIn || '').trim().toLowerCase();
  // 别名识别与全局槽位共用一份实现:Claude 组同时认 mixr-<槽名> 与 claude-mixr-<槽名>,
  // Codex 组只认 mixr-<槽名>。会话覆盖按**槽名**匹配,不按别名字面量。
  const name = slotNameFromAlias(app, alias);
  if (name === null) return globalSlot;
  if (app === 'claude' ? !CLAUDE_SLOTS.includes(name) : !CODEX_SLOT_NAME_RE.test(name)) return globalSlot;
  if (!own(routing?.slots, name)) return globalSlot;
  const slot = routing.slots[name];
  const provider = providerFor(providers, slot.provider);
  const model = slot.model || (app === 'codex' ? provider?.model : provider?.models?.[0]) || '';
  const rule = { id: `slot:${app}/${name}`, match: alias, provider: slot.provider, model,
    pool: [], strategy: 'round_robin', priority: 1000, app, when: {}, enabled: true };
  if (own(slot, 'key_id')) rule.key_id = slot.key_id;
  return { name, provider, model, rule, session: true };
}

function selectSessionKey(provider, resolved, routing) {
  let key_id = activeKeyId(provider || {}), key_source = 'provider_active', pinned = false;
  if (!resolved?.content) {
    const name = typeof resolved?.slot === 'string' ? resolved.slot : resolved?.name;
    const slot = name && own(routing?.slots, name) ? routing.slots[name] : null;
    if (slot && own(slot, 'key_id')) {
      key_id = slot.key_id; key_source = 'session_slot'; pinned = true;
      if (provider?.id !== slot.provider) throw unavailable();
    } else if (own(routing?.keys, provider?.id)) {
      key_id = routing.keys[provider.id]; key_source = 'session_provider'; pinned = true;
    }
  }
  const key = pinned ? resolveKey(provider, key_id) : null;
  if (pinned && (!provider || provider.enabled === false || !key)) throw unavailable();
  return { provider: pinned ? { ...provider, api_key: key.key } : provider, key_id, key_source, pinned };
}
function unavailable() {
  return Object.assign(new Error('会话指定的渠道 Key 不存在、重复、已停用或不可用'),
    { statusCode: 503, code: 'provider_key_unavailable_error', type: 'provider_key_unavailable_error' });
}

module.exports = { normalizeRouting, routingOf, routingRevision, hasRouting, explicitConfig, resolveSessionSlot, selectSessionKey };
