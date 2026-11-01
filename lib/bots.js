'use strict';
// Bot 绑定独立落盘，不改主路由、槽位或渠道当前生效的 Key。
const fs = require('fs');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./atomic-write');
const { ringOf, publicKeys, resolveKey, activeKeyId } = require('./routing/keys');
const { invalid, isObject } = require('./validation');

const configError = () => Object.assign(new Error('Bots 配置损坏或无法读取，请先修复配置文件'), {
  statusCode: 500, code: 'BOTS_CONFIG_INVALID',
});
const bindingError = message => Object.assign(new Error(message), {
  statusCode: 400, code: 'BOTS_BINDING_INVALID',
});
const revisionOf = config => crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
const validText = (value, max) => typeof value === 'string' && !!value.trim()
  && value.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(value);

function normalizeBots(bots) {
  if (!Array.isArray(bots) || bots.length > 100) throw invalid('bots 必须是最多 100 项的数组');
  const ids = new Set();
  const names = new Set();
  return bots.map(raw => {
    if (!isObject(raw) || Object.keys(raw).some(k => !['id', 'name', 'provider', 'model', 'key_id'].includes(k)))
      throw invalid('Bot 配置包含未知字段或不是对象');
    for (const [key, max] of [['id', 128], ['name', 256], ['provider', 128], ['model', 512]]) {
      if (!validText(raw[key], max)) throw invalid(`Bot ${key} 必须是长度受限的非空字符串，不能包含控制字符`);
    }
    if (raw.id !== raw.id.trim() || raw.name !== raw.name.trim())
      throw invalid('Bot id 与 name 不能包含前后空白，名称内部可以使用空格');
    if (raw.key_id !== undefined && raw.key_id !== '' && !validText(raw.key_id, 128))
      throw invalid('Bot key_id 必须是长度受限的字符串，不能包含控制字符');
    if (ids.has(raw.id) || names.has(raw.name)) throw invalid('Bot id 与 name 必须各自唯一');
    ids.add(raw.id); names.add(raw.name);
    return { id: raw.id, name: raw.name, provider: raw.provider, model: raw.model,
      ...(raw.key_id ? { key_id: raw.key_id } : {}) };
  });
}

function readBots(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, bots: [] }; throw configError(); }
  try {
    const config = JSON.parse(text);
    if (!isObject(config) || config.version !== 1 || Object.keys(config).some(k => !['version', 'bots'].includes(k)))
      throw configError();
    return { version: 1, bots: normalizeBots(config.bots) };
  } catch { throw configError(); }
}

function modelsOf(provider) {
  return [...new Set([provider.model, ...(Array.isArray(provider.models) ? provider.models : [])]
    .filter(model => validText(model, 512)))];
}

// 显式但失效的 active_key 不能被 activeKeyId 的兼容回退悄悄换成第一把。
function selectedKeyId(provider, keyId) {
  if (keyId) return keyId;
  if (provider.active_key !== undefined && provider.active_key !== '') return provider.active_key;
  return activeKeyId(provider);
}

function resolveBinding(bot, providers) {
  const matches = providers.filter(p => p && p.id === bot.provider);
  if (matches.length !== 1 || matches[0].enabled !== true)
    throw bindingError('Bot 绑定的 Claude 渠道不存在、重复或已停用');
  const provider = matches[0];
  if (!modelsOf(provider).includes(bot.model)) throw bindingError('Bot 绑定的模型未在该渠道登记');
  const keyId = selectedKeyId(provider, bot.key_id);
  const key = resolveKey(provider, keyId);
  if (!key) throw bindingError('Bot 绑定的 Key 不存在、重复、已停用或不可用');
}

function resolveBot(config, identity = {}, providers = []) {
  const bots = normalizeBots(config.bots);
  const bot = (typeof identity.name === 'string' && bots.find(b => b.name === identity.name))
    || (typeof identity.id === 'string' && bots.find(b => b.id === identity.id));
  if (!bot) return null;
  resolveBinding(bot, providers);
  return { ...bot };
}

function botsPublic(config, providers) {
  return { bots: config.bots.map(bot => ({ ...bot })), revision: revisionOf(config),
    providers: providers.filter(p => p && p.enabled === true && validText(p.id, 128)
      && providers.filter(other => other && other.id === p.id).length === 1
      && modelsOf(p).length && ringOf(p).some(k => k && resolveKey(p, k.id)))
      .map(p => ({ id: p.id, name: typeof p.name === 'string' ? p.name : p.id,
        models: modelsOf(p), keys: publicKeys(p), active_key: selectedKeyId(p, '') })) };
}

function writeBots(filePath, providers, input) {
  if (!isObject(input) || Object.keys(input).some(k => !['bots', 'expected_revision'].includes(k)))
    throw invalid('Bots 请求必须是对象且不能包含未知字段');
  if (typeof input.expected_revision !== 'string') throw invalid('expected_revision 必须是字符串');
  // 先读现存文件；损坏配置绝不按空表覆盖。同步读/校验/原子写之间不让出事件循环。
  const current = readBots(filePath);
  if (input.expected_revision !== revisionOf(current))
    throw Object.assign(new Error('Bots 配置已变化，请重新载入后再保存'), { statusCode: 409, code: 'BOTS_REVISION_CONFLICT' });
  const next = { version: 1, bots: normalizeBots(input.bots) };
  for (const bot of next.bots) resolveBinding(bot, providers);
  try { writeJsonAtomic(filePath, next, { mode: 0o600 }); }
  catch { throw Object.assign(new Error('写入 Bots 配置失败，原配置未变'), { statusCode: 500, code: 'BOTS_WRITE_FAILED' }); }
  return botsPublic(next, providers);
}

module.exports = { readBots, botsPublic, writeBots, resolveBot };
