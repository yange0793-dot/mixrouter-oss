'use strict';
// 控制台与压缩专用 Key 共用同一份清单视图;查找不切换生效账号。
const { hasCtlChar } = require('./headers');
const LEGACY_KEY_ID = 'klegacy';
function ringOf(p) {
  if (Array.isArray(p?.keys) && p.keys.length) return p.keys;
  return p?.api_key ? [{ id: LEGACY_KEY_ID, label: '账号1', key: p.api_key }] : [];
}
function validKeyId(id) {
  return typeof id === 'string' && !!id.trim() && !hasCtlChar(id);
}
function resolveKey(p, id) {
  if (!validKeyId(id)) return null;
  const matches = ringOf(p).filter(k => k && k.id === id);
  if (matches.length !== 1) return null;
  const key = matches[0];
  if (key.enabled === false || typeof key.key !== 'string' || !key.key.trim() || hasCtlChar(key.key)) return null;
  return key;
}
function publicKeys(p) {
  return ringOf(p).filter(k => k && typeof k.id === 'string').map(k => ({
    id: k.id, label: typeof k.label === 'string' ? k.label : k.id, enabled: k.enabled !== false,
  }));
}
// 停用的 Key 不能被选为生效 Key:显式 active_key 停用后回退到第一把可用 Key,
// 全都停用时返回空串(下游 resolveKey 会明确报"没有可用的 Key",而不是继续拿停用那把)。
function activeKeyId(p) {
  const ring = ringOf(p).filter(k => k && typeof k.id === 'string');
  if (ring.some(k => k.id === p.active_key && k.enabled !== false)) return p.active_key;
  return ring.find(k => k.enabled !== false)?.id || '';
}
module.exports = { LEGACY_KEY_ID, ringOf, validKeyId, resolveKey, publicKeys, activeKeyId };
