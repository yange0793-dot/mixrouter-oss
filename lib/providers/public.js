'use strict';
const { ringOf } = require('../routing/keys');

function maskKey(key) {
  if (!key) return '';
  return key.length > 12 ? key.slice(0, 6) + '…' + key.slice(-4) : '***';
}

function publicProvider(provider) {
  const { api_key, keys, ...rest } = provider;
  const ring = ringOf(provider);
  return { ...rest, key_masked: maskKey(api_key), has_key: !!api_key,
    keys: ring.map(key => ({ id: key.id, label: key.label, key_masked: maskKey(key.key), enabled: key.enabled !== false })),
    active_key: ring.some(key => key.id === provider.active_key) ? provider.active_key : ring[0]?.id || '' };
}

module.exports = { maskKey, publicProvider };
