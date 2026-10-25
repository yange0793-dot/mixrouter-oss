'use strict';

const { invalid } = require('./codex-config');

// 只规划公开槽位,不读写配置。接入与预览共用缺槽补齐和已有槽校验的同一条规则。
function planCodexSlots(slots, providers, { strict = false } = {}) {
  const list = Array.isArray(slots) ? slots.map(slot => ({ ...slot })) : [];
  const store = Array.isArray(providers) ? providers : [];
  const fallback = store.find(provider => provider && provider.enabled !== false && provider.model && provider.api_key);
  const bootstrap = [];
  for (const name of ['main', 'reviewer']) {
    let slot = list.find(item => item && item.name === name);
    if (!slot && !strict && fallback) {
      slot = { name, alias: 'mixr-' + name, provider: fallback.id, provider_name: fallback.name,
        model: fallback.model, enabled: true };
      list.push(slot);
      bootstrap.push(name);
    }
    const provider = slot && store.find(item => item && item.id === slot.provider);
    if (!slot || !slot.provider || slot.enabled === false || !provider || provider.enabled === false ||
        !provider.api_key || !(slot.model || provider.model)) {
      throw invalid(`Codex ${name} 槽位须绑定已启用、有模型名和 API Key 的渠道`);
    }
    slot.alias = 'mixr-' + name;
    slot.model = slot.model || provider.model;
    slot.enabled = true;
  }
  return { slots: list, model: 'mixr-main', reviewModel: 'mixr-reviewer', bootstrap };
}

module.exports = { planCodexSlots };
