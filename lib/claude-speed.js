'use strict';
// Claude 卡片的速度档只支持 OpenAI 官方模型页明确列出对应 service_tier 的 GPT 模型,
// 且按档位分别判定:
//   Fast      GPT-5.6 Sol、GPT-6.2 Astra/Sol、GPT-6 Astra、GPT-6.1 Sol
//             (Fast 指南给出 gpt-5.6-sol;GPT-6 四个模型页标明 Speed Fast、Fast 2x 计费)。
//   Ultrafast GPT-6.2 Astra、GPT-6.2 Sol、GPT-6 Astra、GPT-6.1 Sol
//             (Ultrafast 指南与各自模型页明确支持;GPT-5.6 Sol 只是历史 preview,不列入)。
// DeepSeek/GLM/Qwen 等 OpenAI 兼容网关不认识 service_tier,不能放行。
const { modelsOf } = require('./model-probe');
const CLAUDE_SPEED_MODELS = Object.freeze({
  fast: new Set(['gpt-5.6-sol', 'gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.1-sol']),
  ultrafast: new Set(['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.1-sol']),
});
const CLAUDE_SPEED_MODES = Object.freeze(Object.keys(CLAUDE_SPEED_MODELS));
const stripModelSuffix = value => String(value || '').trim().replace(/\[[^\]]*\]\s*$/, '');

function isClaudeSpeedModel(model, mode) {
  const allowed = CLAUDE_SPEED_MODELS[mode];
  return !!allowed && allowed.has(stripModelSuffix(model).toLowerCase());
}

// 卡片是否显示某一档:渠道登记过至少一个该档可用的 GPT 模型。
function providerSupportsClaudeSpeedMode(provider, mode) {
  return modelsOf(provider).some(model => isClaudeSpeedModel(model, mode));
}

function providerSupportsClaudeSpeed(provider) {
  return CLAUDE_SPEED_MODES.some(mode => providerSupportsClaudeSpeedMode(provider, mode));
}

module.exports = {
  CLAUDE_SPEED_MODELS, CLAUDE_SPEED_MODES, isClaudeSpeedModel,
  providerSupportsClaudeSpeed, providerSupportsClaudeSpeedMode,
};
