'use strict';
// Harness 的模型槽位独立保存,渠道和 Key 仍引用同一份渠道库。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-write');
const { runtimeDataDir } = require('./paths');
const { inspectDsh, syncDsh } = require('./dsh-config');

const SLOT_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
const PREFIX = 'mixr-dsh-';
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
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
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!object(parsed) || parsed.version !== 1 || !object(parsed.slots)
      || Object.keys(parsed).some(key => !['version', 'slots', 'default_subagent'].includes(key)))
      throw invalid('Harness 配置结构无效');
    config = normalize(parsed, false);
  } catch (error) {
    if (error.code !== 'ENOENT') loadError = 'Harness 路由配置读取失败,请检查 dsh.json;未按空配置覆盖';
  }
  const providers = () => getProviders().filter(provider => provider &&
    ['chat', 'responses'].includes(provider.wire_api));
  const usable = id => providers().find(provider => provider.id === id && provider.enabled !== false);
  const revision = () => revisionOf(config);
  const publicProviders = () => providers().map(provider => ({
    id: provider.id, name: provider.name, models: modelNames(provider), model: provider.model || '',
    wire_api: provider.wire_api, enabled: provider.enabled !== false,
  }));
  function syncOptions(value = config) {
    return { home, env, routerURL,
      models: Object.keys(value.slots).map(name => ({ id: aliasOf(name),
        name: name === 'main' ? 'Mixrouter · 主模型' : `Mixrouter · ${name}`, reasoning: true, input: ['text', 'image'] })),
      defaultModel: aliasOf('main'),
      defaultSubagent: value.default_subagent ? aliasOf(value.default_subagent) : undefined };
  }
  function read() {
    const client = inspectDsh(Object.keys(config.slots).length ? syncOptions() : { home, env });
    return { ...config, revision: revision(), providers: publicProviders(), client,
      ...(loadError ? { error: loadError } : {}) };
  }
  function checkRevision(expected) {
    if (loadError) throw invalid(loadError, 409);
    if (typeof expected !== 'string' || expected !== revision())
      throw invalid('Harness 配置已变化,请刷新后再保存', 409);
    try {
      const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (revisionOf(disk) !== revision()) throw invalid('Harness 配置在外部被修改,请重载后再保存', 409);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error.statusCode ? error : invalid('Harness 配置无法读取,未保存', 409);
      if (Object.keys(config.slots).length) throw invalid('Harness 配置在外部被删除,未保存', 409);
    }
  }
  function normalize(input, checkProviders = true) {
    if (!object(input) || !object(input.slots) || !own(input.slots, 'main')) throw invalid('请配置 Harness 主模型 main');
    const entries = Object.entries(input.slots);
    if (entries.length > 32) throw invalid('Harness 最多配置 32 个模型槽位');
    const slots = {};
    for (const [name, value] of entries) {
      if (!SLOT_NAME.test(name) || ['constructor', 'prototype', '__proto__'].includes(name))
        throw invalid('槽名只能用小写字母、数字和连字符,最多 24 位');
      if (!object(value) || Object.keys(value).some(key => !['provider', 'model', 'upstream_stream'].includes(key)))
        throw invalid('Harness 槽位只能包含 provider、model、upstream_stream');
      if (typeof value.provider !== 'string' || !value.provider || (checkProviders && !usable(value.provider)))
        throw invalid(`槽位 ${name} 须选择已启用的 Chat 或 Responses 渠道`);
      if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 256 || /[\x00-\x1f\x7f]/.test(value.model))
        throw invalid(`槽位 ${name} 须填写有效模型名`);
      if (own(value, 'upstream_stream') && typeof value.upstream_stream !== 'boolean')
        throw invalid('upstream_stream 必须为布尔值;省略时继承默认');
      slots[name] = { provider: value.provider, model: value.model.trim(),
        ...(own(value, 'upstream_stream') ? { upstream_stream: value.upstream_stream } : {}) };
    }
    const selected = input.default_subagent === undefined ? '' : input.default_subagent;
    if (typeof selected !== 'string' || (selected && (selected === 'main' || !own(slots, selected))))
      throw invalid('默认子智能体须选择已配置的非 main 槽位');
    return { version: 1, slots, default_subagent: selected };
  }
  function save(input) {
    checkRevision(input.expected_revision);
    const next = normalize(input);
    writeJsonAtomic(file, next, { mode: 0o600 });
    config = next;
    return { ok: true, ...read() };
  }
  function sync(input) {
    if (input.confirm !== true) throw invalid('同步到 Harness 前需要明确确认');
    checkRevision(input.expected_revision);
    const valid = normalize(config);
    const options = syncOptions(valid);
    const result = syncDsh(options);
    return { ...result, ok: true, restart_required: true, client: inspectDsh(options) };
  }
  function resolve(modelIn) {
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
  const modelList = () => ({ object: 'list', data: Object.keys(config.slots).map(name => ({
    id: aliasOf(name), object: 'model', created: 0, owned_by: 'mixrouter',
  })) });
  return { read, save, sync, resolve, modelList };
}
module.exports = { createDshRouting, aliasOf, modelNames };
