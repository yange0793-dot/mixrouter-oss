'use strict';
// Harness 的模型槽位独立保存,渠道和 Key 仍引用同一份渠道库。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-write');
const { runtimeDataDir } = require('./paths');
const { inspectDsh, syncDsh, previewDsh } = require('./dsh-config');
const { normalizeDshConfig, configView, invalid } = require('./dsh-schema');

const PREFIX = 'mixr-dsh-';
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const revisionOf = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const aliasOf = name => PREFIX + name;
const modelNames = provider => [...new Set([
  ...(Array.isArray(provider.models) ? provider.models : []), provider.model,
].filter(value => typeof value === 'string' && value.trim()))];

function createDshRouting(options) {
  const { root, home, env = process.env, routerURL, getProviders } = options;
  const file = path.join(runtimeDataDir(env, root), 'dsh.json');
  let config = { version: 1, slots: {}, default_subagent: '' };
  let loadError = '';
  let loadedText;
  // 控制台与转发必须读同一版配置。外部工具/原子替换写了 dsh.json 后,不能继续
  // 用启动时那份内存路由;坏文件也不能静默沿用旧渠道。这里只解析变化后的字节。
  function refresh() {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (text !== loadedText) {
        const parsed = JSON.parse(text);
        if (!object(parsed) || ![1, 2].includes(parsed.version)) throw invalid('Harness 配置结构无效');
        config = normalizeDshConfig(parsed);
        loadedText = text;
      }
      loadError = '';
    } catch (error) {
      if (error.code === 'ENOENT' && loadedText === undefined && !loadError) return;
      loadError = 'Harness 路由配置读取失败,请检查 dsh.json;未按空配置覆盖';
    }
  }
  refresh();
  const providers = () => getProviders().filter(provider => provider &&
    ['chat', 'responses'].includes(provider.wire_api));
  const usable = id => providers().find(provider => provider.id === id && provider.enabled !== false);
  const revision = () => revisionOf(config);
  const publicProviders = () => providers().map(provider => ({
    id: provider.id, name: provider.name, models: modelNames(provider), model: provider.model || '',
    wire_api: provider.wire_api, enabled: provider.enabled !== false,
  }));
  function syncOptions(value = config) {
    const models = Object.entries(value.slots).map(([name, slot]) => {
      const model = { id: aliasOf(name), name: name === 'main' ? 'Mixrouter · 主模型'
        : slot.label ? `Mixrouter · ${slot.label} · ${name}` : `Mixrouter · ${name}` };
      if (value.version === 1) return { ...model, reasoning: true, input: ['text', 'image'] };
      const capabilities = slot.capabilities || {};
      if (own(capabilities, 'context_window')) model.contextWindow = capabilities.context_window;
      if (own(capabilities, 'max_tokens')) model.maxTokens = capabilities.max_tokens;
      if (own(capabilities, 'input')) model.input = [...capabilities.input];
      if (own(capabilities, 'reasoning_efforts')) model.reasoningEfforts = structuredClone(capabilities.reasoning_efforts);
      return model;
    });
    const common = { home, env, routerURL, models, defaultModel: aliasOf('main') };
    if (value.version === 1) return { ...common,
      defaultSubagent: value.default_subagent ? aliasOf(value.default_subagent) : undefined };
    const policy = value.subagents;
    return { ...common, policyOwner: policy.owner, subagentPolicy: {
      enabled: policy.allow_model_selection,
      allowedModels: policy.allowed_slots.map(name => ({ provider: 'mixrouter', model: aliasOf(name) })),
      defaultMode: policy.default.mode,
      ...(policy.default.mode === 'slot' ? { defaultModel: aliasOf(policy.default.slot) } : {}),
      ...(own(policy, 'max_depth') ? { maxDepth: policy.max_depth } : {}),
      ...(own(policy, 'max_active') ? { maxActiveSubagents: policy.max_active } : {}),
    } };
  }
  function read() {
    refresh();
    const client = inspectDsh(Object.keys(config.slots).length ? syncOptions() : { home, env });
    return { ...configView(config), api_version: 2, supported_config_versions: [1, 2],
      revision: revision(), providers: publicProviders(), client,
      warnings: warnings(), policy_coverage: policyCoverage(),
      ...(loadError ? { error: loadError } : {}) };
  }
  function warnings() {
    const policy = configView(config).subagents;
    const result = [];
    if (config.version === 1 && Object.keys(config.slots).length)
      result.push('旧配置保持原行为：全部模型槽是子候选，空默认值实际固定 main。保存新版后可独立管理名单与默认行为。');
    if (policy.owner === 'mixrouter' && policy.default.mode === 'inherit')
      result.push('继承父模型是实际继承，不受普通子工具的显式选模名单检查；父模型可能不在候选池内。');
    if (policy.owner === 'mixrouter' && policy.default.mode === 'slot' && policy.default.slot === 'main')
      result.push('默认子任务与 main 共用模型槽；并发任务可能争用相同上游配额。');
    if (policy.owner === 'mixrouter' && policy.max_active > 4)
      result.push('并行上限高于 4；建议根据真实 token 配额与限流记录调整。');
    if (config.version === 2 && Object.values(config.slots).some(slot => !slot.capabilities
      || !own(slot.capabilities, 'context_window') || !own(slot.capabilities, 'max_tokens')))
      result.push('未填写的模型容量采用 Harness 适配器默认值，不代表上游已验证容量。');
    for (const [name, slot] of Object.entries(config.slots)) if (!usable(slot.provider))
      result.push(`模型槽 ${name} 的渠道缺失或已停用；该别名不会改走其它渠道。`);
    return result;
  }
  function policyCoverage() {
    const owner = configView(config).subagents.owner;
    return { owner, global_enforcement: false, entries: [
      { entrypoint: 'subagent', behavior: owner === 'mixrouter' ? 'configured_default_and_explicit_model_selection' : 'harness_managed', allowlist: 'explicit_selection_only' },
      { entrypoint: 'subagent_fork', behavior: 'inherits_parent_model', allowlist: 'not_covered' },
      { entrypoint: 'spawn_teammate', behavior: 'inherits_lead_model', allowlist: 'not_covered' },
      { entrypoint: 'workflow', behavior: 'independent_model_options', allowlist: 'not_covered' },
      { entrypoint: 'ds-bot', behavior: 'per_bot_model_settings', allowlist: 'not_covered' },
    ] };
  }
  function checkRevision(expected) {
    refresh();
    if (loadError) throw invalid(loadError, 409);
    if (typeof expected !== 'string' || expected !== revision())
      throw invalid('Harness 配置已变化,请刷新后再保存', 409);
    try {
      const disk = normalizeDshConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (revisionOf(disk) !== revision()) throw invalid('Harness 配置在外部被修改,请重载后再保存', 409);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error.statusCode ? error : invalid('Harness 配置无法读取,未保存', 409);
      if (Object.keys(config.slots).length) throw invalid('Harness 配置在外部被删除,未保存', 409);
    }
  }
  function normalize(input) {
    return normalizeDshConfig(input, { providerAllowed: id => !!usable(id) });
  }
  function save(input) {
    if (!object(input)) throw invalid('Harness 保存请求须为对象');
    checkRevision(input.expected_revision);
    const { expected_revision, ...payload } = input;
    if (config.version === 2 && (payload.version === undefined || payload.version === 1))
      throw invalid('新版子策略已保存；请刷新页面使用 v2，旧客户端保存不会丢弃新版策略', 409);
    const next = normalize(payload);
    writeJsonAtomic(file, next, { mode: 0o600 });
    config = next;
    loadedText = fs.readFileSync(file, 'utf8');
    return { ok: true, ...read() };
  }
  function preview(input) {
    if (!object(input)) throw invalid('Harness 预览请求须为对象');
    checkRevision(input.expected_revision);
    const options = syncOptions(normalize(config));
    if (input.repair === true) options.repair = true;
    return { preview: previewDsh(options), revision: revision() };
  }
  function sync(input) {
    if (!object(input) || input.confirm !== true) throw invalid('同步到 Harness 前需要明确确认');
    checkRevision(input.expected_revision);
    const options = syncOptions(normalize(config));
    if (input.repair === true) {
      if (typeof input.expected_profile_revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_profile_revision))
        throw invalid('重新接入须先预览并提交 profile 指纹');
      options.repair = true;
      options.expectedProfileRevision = input.expected_profile_revision;
    }
    const result = syncDsh(options);
    return { ...result, ok: true, revision: revision(), restart_required: true, client: inspectDsh(options) };
  }
  function resolve(modelIn) {
    refresh();
    if (loadError) return null;
    const name = String(modelIn || '').startsWith(PREFIX) ? String(modelIn).slice(PREFIX.length) : '';
    if (!name || !own(config.slots, name)) return null;
    const slot = config.slots[name];
    const provider = providers().find(item => item.id === slot.provider);
    if (!provider) return null;
    return { name, provider, model: slot.model,
      rule: { id: `slot:dsh/${name}`, match: aliasOf(name), provider: slot.provider,
        model: slot.model, pool: [], strategy: 'round_robin', priority: 1000, app: 'claude', when: {}, enabled: true,
        ...(typeof slot.upstream_stream === 'boolean' ? { upstream_stream: slot.upstream_stream } : {}) } };
  }
  function modelList() {
    refresh();
    return { object: 'list', data: (loadError ? [] : Object.keys(config.slots)).map(name => ({
      id: aliasOf(name), object: 'model', created: 0, owned_by: 'mixrouter',
    })) };
  }
  return { read, save, preview, sync, resolve, modelList };
}
module.exports = { createDshRouting, aliasOf, modelNames };
