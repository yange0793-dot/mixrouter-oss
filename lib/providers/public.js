'use strict';
const { ringOf, activeKeyId } = require('../routing/keys');

function maskKey(key) {
  if (!key) return '';
  return key.length > 12 ? key.slice(0, 6) + '…' + key.slice(-4) : '***';
}

function publicProvider(provider) {
  const { api_key, keys, ...rest } = provider;
  const ring = ringOf(provider);
  return { ...rest, key_masked: maskKey(api_key), has_key: !!api_key,
    keys: ring.map(key => ({ id: key.id, label: key.label, key_masked: maskKey(key.key), enabled: key.enabled !== false })),
    // 与控制台外的运行时同口径:停用的 Key 不会被显示成生效 Key;全都停用时为空。
    active_key: activeKeyId(provider) };
}

module.exports = { maskKey, publicProvider };
