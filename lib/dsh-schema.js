'use strict';
// Pure DSH configuration validation. v1 keeps its original semantics; v2 separates
// the route catalog from ordinary-subagent preferences. Never persist credentials.
const SLOT_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
const RESERVED = new Set(['constructor', 'prototype', '__proto__']);
const MAX_SLOTS = 32;
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const nameValid = name => typeof name === 'string' && SLOT_NAME.test(name) && !RESERVED.has(name);
const onlyKeys = (value, keys, message) => {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw invalid(message);
};
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${label}须为 ${min}–${max} 的整数`);
  return value;
}
function normalizeCapabilities(input) {
  onlyKeys(input, ['context_window', 'max_tokens', 'input', 'reasoning_efforts'], '能力配置只接受容量、输入类型和推理强度映射');
  const out = {};
  for (const key of ['context_window', 'max_tokens']) if (own(input, key))
    out[key] = integer(input[key], 1, Number.MAX_SAFE_INTEGER, key);
  if (out.context_window !== undefined && out.max_tokens !== undefined && out.max_tokens > out.context_window)
    throw invalid('max_tokens 须小于或等于 context_window');
  if (own(input, 'input')) {
    const values = input.input;
    if (!Array.isArray(values) || values.length < 1 || values.length > 2 || !values.includes('text')
      || new Set(values).size !== values.length || values.some(item => !['text', 'image'].includes(item)))
      throw invalid('输入类型须包含 text，可额外选择 image');
    out.input = ['text', ...(values.includes('image') ? ['image'] : [])];
  }
  if (own(input, 'reasoning_efforts')) {
    const mapping = input.reasoning_efforts;
    if (mapping === false) out.reasoning_efforts = false;
    else {
      if (!object(mapping) || !Object.keys(mapping).length || Object.keys(mapping).some(key => !THINKING_LEVELS.includes(key))
        || !Object.keys(mapping).some(key => key !== 'off')) throw invalid('推理映射须声明至少一个有效思考等级，或设置为 false');
      const result = {};
      for (const key of THINKING_LEVELS) if (own(mapping, key)) {
        const value = mapping[key];
        if (key === 'off' && value === null) result[key] = null;
        else {
          if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\x00-\x1f\x7f]/.test(value))
            throw invalid(`推理映射 ${key} 须填写有效 wire 值；仅 off 支持 null`);
          result[key] = value.trim();
        }
      }
      out.reasoning_efforts = result;
    }
  }
  return out;
}
function normalizeSubagents(input, slots) {
  onlyKeys(input, ['owner', 'allow_model_selection', 'allowed_slots', 'default', 'max_depth', 'max_active'], '子策略包含不支持的字段');
  if (!['mixrouter', 'harness'].includes(input.owner)) throw invalid('子策略管理方须为 mixrouter 或 harness');
  if (typeof input.allow_model_selection !== 'boolean') throw invalid('allow_model_selection 须为布尔值');
  const names = input.allowed_slots;
  if (!Array.isArray(names) || names.length > MAX_SLOTS || new Set(names).size !== names.length
    || names.some(name => !nameValid(name) || !own(slots, name))) throw invalid('候选名单须为不重复且已配置的模型槽位');
  if (input.allow_model_selection && !names.length) throw invalid('开启子任务自主选模时至少选择一个候选槽');
  const preference = input.default;
  onlyKeys(preference, ['mode', 'slot'], '默认子模型只接受 mode 和 slot');
  if (!['slot', 'inherit'].includes(preference.mode)) throw invalid('默认子模型须明确选择固定槽或继承父模型');
  let selected;
  if (preference.mode === 'slot') {
    if (!nameValid(preference.slot) || !own(slots, preference.slot)) throw invalid('默认子模型须引用已配置的槽位');
    if (input.allow_model_selection && !names.includes(preference.slot)) throw invalid('默认固定槽须包含在子候选名单中');
    selected = { mode: 'slot', slot: preference.slot };
  } else {
    if (own(preference, 'slot')) throw invalid('继承父模型时应省略固定 slot');
    selected = { mode: 'inherit' };
  }
  const out = { owner: input.owner, allow_model_selection: input.allow_model_selection, allowed_slots: [...names], default: selected };
  if (own(input, 'max_depth')) out.max_depth = integer(input.max_depth, 0, 64, '最大递归深度');
  if (own(input, 'max_active')) out.max_active = integer(input.max_active, 1, 64, '并行子任务上限');
  return out;
}
function legacyPolicy(config) {
  const names = Object.keys(config.slots);
  return names.length ? { owner: 'mixrouter', allow_model_selection: true, allowed_slots: names,
    default: { mode: 'slot', slot: config.default_subagent || 'main' } }
    : { owner: 'harness', allow_model_selection: false, allowed_slots: [], default: { mode: 'inherit' } };
}
function normalizeDshConfig(input, options = {}) {
  if (!object(input) || !object(input.slots)) throw invalid('请配置 Harness 模型路由槽');
  const version = input.version === undefined ? 1 : input.version;
  if (![1, 2].includes(version)) throw invalid('Harness 配置版本须为 1 或 2');
  onlyKeys(input, version === 1 ? ['version', 'slots', 'default_subagent'] : ['version', 'slots', 'subagents'], 'Harness 配置结构或字段无效');
  const entries = Object.entries(input.slots);
  if (!own(input.slots, 'main') && !(options.allowEmpty && !entries.length)) throw invalid('请配置 Harness 主模型 main');
  if (entries.length > MAX_SLOTS) throw invalid('Harness 最多配置 32 个模型槽位');
  const slots = {};
  for (const [name, value] of entries) {
    if (!nameValid(name)) throw invalid('槽名只能用小写字母、数字和连字符,最多 24 位；保留名称不适用');
    onlyKeys(value, ['provider', 'model', 'upstream_stream', ...(version === 2 ? ['capabilities', 'label'] : [])],
      version === 1 ? 'Harness 槽位只能包含 provider、model、upstream_stream' : 'Harness 路由槽包含不支持的字段');
    if (typeof value.provider !== 'string' || !value.provider || /[\x00-\x1f\x7f]/.test(value.provider)
      || (options.providerAllowed && !options.providerAllowed(value.provider))) throw invalid(`槽位 ${name} 须选择已启用的 Chat 或 Responses 渠道`);
    if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 256 || /[\x00-\x1f\x7f]/.test(value.model))
      throw invalid(`槽位 ${name} 须填写有效模型名`);
    if (own(value, 'upstream_stream') && typeof value.upstream_stream !== 'boolean') throw invalid('upstream_stream 必须为布尔值;省略时继承默认');
    const slot = { provider: value.provider, model: value.model.trim(),
      ...(own(value, 'upstream_stream') ? { upstream_stream: value.upstream_stream } : {}) };
    if (version === 2 && own(value, 'label')) {
      if (typeof value.label !== 'string' || /[\x00-\x1f\x7f]/.test(value.label))
        throw invalid(`槽位 ${name} 的类型须为不含控制字符的文本`);
      const label = value.label.trim();
      if (label.length > 24) throw invalid(`槽位 ${name} 的类型最多 24 字符`);
      if (label) slot.label = label;
    }
    if (own(value, 'capabilities')) {
      const capabilities = normalizeCapabilities(value.capabilities);
      if (Object.keys(capabilities).length) slot.capabilities = capabilities;
    }
    slots[name] = slot;
  }
  if (version === 1) {
    const selected = input.default_subagent === undefined ? '' : input.default_subagent;
    if (typeof selected !== 'string' || (selected && (selected === 'main' || !own(slots, selected))))
      throw invalid('默认子智能体须选择已配置的非 main 槽位');
    return { version: 1, slots, default_subagent: selected };
  }
  return { version: 2, slots, subagents: normalizeSubagents(input.subagents, slots) };
}
function configView(config) {
  return { ...config, source_version: config.version, migration_required: config.version === 1 && Object.keys(config.slots).length > 0,
    subagents: config.version === 2 ? config.subagents : legacyPolicy(config) };
}
module.exports = { SLOT_NAME, MAX_SLOTS, THINKING_LEVELS, nameValid, invalid, normalizeCapabilities, normalizeSubagents, normalizeDshConfig, configView, legacyPolicy };
