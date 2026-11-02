'use strict';
// 只供模型诊断展示的手工声明，不参与路由、请求改写或客户端配置。
const fs = require('node:fs');
const crypto = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-write');
const { invalid, isObject } = require('./validation');
const { registeredModels } = require('./routing/resolve');

const FIELDS = ['context_window', 'max_output_tokens', 'vision', 'reasoning_levels'];
const revisionOf = data => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
const text = (value, max) => typeof value === 'string' && !!value.trim()
  && value === value.trim() && value.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(value);

function normalizeSpec(raw) {
  if (!isObject(raw) || Object.keys(raw).some(key => !FIELDS.includes(key)))
    throw invalid('模型声明包含未知字段或不是对象');
  const spec = {};
  for (const field of FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (field === 'vision') {
      if (typeof value !== 'boolean') throw invalid('vision 必须是布尔值或 null');
    } else if (field === 'reasoning_levels') {
      if (!Array.isArray(value) || !value.length || value.length > 12
          || value.some(level => !text(level, 32)) || new Set(value).size !== value.length)
        throw invalid('推理档位必须是最多 12 个不重复的短名称，未知请用 null');
    } else if (!Number.isSafeInteger(value) || value < 1 || value > 100000000) {
      throw invalid(`${field} 必须是 1 到 100000000 的整数或 null`);
    }
    spec[field] = Array.isArray(value) ? [...value] : value;
  }
  return spec;
}

function normalizeRecord(raw) {
  if (!isObject(raw) || Object.keys(raw).some(key => !['app', 'provider', 'model', 'spec'].includes(key))
      || !['claude', 'codex'].includes(raw.app) || !text(raw.provider, 128) || !text(raw.model, 512))
    throw invalid('模型声明必须指定有效的协议组、渠道和模型');
  return { app: raw.app, provider: raw.provider, model: raw.model, spec: normalizeSpec(raw.spec) };
}
const sameModel = (a, b) => a.app === b.app && a.provider === b.provider && a.model === b.model;

function readSpecs(file) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 1, models: [] };
    throw Object.assign(new Error('模型声明配置损坏或无法读取，未覆盖原文件'), { statusCode: 500 });
  }
  try {
    if (!isObject(data) || data.version !== 1 || Object.keys(data).some(k => !['version', 'models'].includes(k))
        || !Array.isArray(data.models) || data.models.length > 1000) throw invalid('invalid');
    const models = data.models.map(normalizeRecord);
    const keys = new Set(models.map(row => JSON.stringify([row.app, row.provider, row.model])));
    if (keys.size !== models.length) throw invalid('duplicate');
    return { version: 1, models };
  } catch {
    throw Object.assign(new Error('模型声明配置损坏或格式不受支持，未覆盖原文件'), { statusCode: 500 });
  }
}

function writeSpecs(file, store, input) {
  if (!isObject(input) || Object.keys(input).some(key => !['app', 'provider', 'model', 'spec', 'expected_revision'].includes(key)))
    throw invalid('模型声明请求包含未知字段');
  const { expected_revision, ...raw } = input;
  if (typeof expected_revision !== 'string') throw invalid('缺少 expected_revision');
  const record = normalizeRecord(raw);
  const providers = (store[record.app] || []).filter(p => p.id === record.provider);
  if (providers.length !== 1 || !registeredModels(providers[0]).includes(record.model))
    throw invalid('所选渠道或登记模型已变化，请重新读取');
  const current = readSpecs(file);
  if (expected_revision !== revisionOf(current))
    throw Object.assign(new Error('模型声明已变化，请重新读取后保存'), { statusCode: 409 });
  const models = current.models.filter(row => !sameModel(row, record));
  if (Object.keys(record.spec).length) models.push(record);
  if (models.length > 1000) throw invalid('最多保存 1000 个模型声明');
  const next = { version: 1, models };
  try { writeJsonAtomic(file, next, { mode: 0o600 }); }
  catch { throw Object.assign(new Error('模型声明写入失败，原配置未变'), { statusCode: 500 }); }
  return next;
}

function modelsPublic(data, store, logs) {
  const models = [];
  for (const app of ['claude', 'codex']) {
    const providers = store[app] || [];
    for (const provider of providers) {
      // 既有日志按渠道名称记账；同名渠道不能可靠归属，宁可不显示观察结果。
      const logName = provider.name || provider.id;
      const uniqueName = providers.filter(p => (p.name || p.id) === logName).length === 1;
      for (const model of registeredModels(provider)) {
        const spec = data.models.find(row => sameModel(row, { app, provider: provider.id, model }))?.spec || {};
        const seen = uniqueName && logs.find(row => row.app === app && row.provider === logName
          && row.model_out === model && row.status >= 200 && row.status < 300 && !row.err && row.upstream_model);
        models.push({ app, provider: provider.id, provider_name: logName, model,
          capabilities: Object.fromEntries(FIELDS.map(field => [field, {
            value: spec[field] ?? null, source: Object.hasOwn(spec, field) ? 'manual' : 'unknown',
          }])),
          observation: seen ? { requested_model: seen.model_out, upstream_model: seen.upstream_model,
            status: seen.status, ts: seen.ts } : null });
      }
    }
  }
  return { revision: revisionOf(data), models };
}

module.exports = { readSpecs, writeSpecs, modelsPublic, normalizeSpec, revisionOf };
