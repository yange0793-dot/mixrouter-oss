'use strict';
// 价目表:内置参考价 + 用户自定义覆盖,按「每 1M token 美元」计。
//
// ⚠ 默认价目表只是**参考值**,以渠道实际计费为准。同名模型在中转/池化渠道上的单价
//   常与官方牌价不同(有的按倍率折算,有的把 cache_read 单独计价),这里给的是公开牌价,
//   用途是让控制台有一个"大致花了多少"的量级判断,不是账单。
//
// 存储:<dataDir>/pricing.json,0600,原子写(lib/atomic-write.js)。
// 结构:
//   { "version": 1,
//     "models": { "<model>": { "in": USD/1M, "out": USD/1M, "cache_read": USD/1M } },
//     "providers": { "<providerId>": { "<model>": { "in": ..., "out": ..., "cache_read": ... } } } }
// provider 级覆盖 model 级。DEFAULT_PRICING **不写入磁盘**,只在读取时兜底 ——
// 这样升级默认价目表不会被用户磁盘上旧的一份冻住。
//
// 匹配规则(给"日志里的模型名常带日期后缀"留的):
//   1. provider 精确 → 2. models 精确 → 3. 两边取最长前缀(要求后缀从分隔符/数字开始,
//   避免 gpt-5 误吃 gpt-50),同长度时 provider 优先。
//   前缀匹配是为了 `claude-sonnet-4-5-20250929` 能落到 `claude-sonnet-4-5`。
//
// 校验:PUT 走**严格**校验(非对象、负数、非数字、未知字段一律拒绝);磁盘上被手改坏的
// 条目走**宽松**校验(丢掉坏条目而不是让整个控制台起不来)。未知模型键**保留不删** ——
// 用户给自建/内部模型定价是正当用途,不能因为不在默认表里就被清掉。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomic } = require('../atomic-write');

const PRICE_FIELDS = Object.freeze(['in', 'out', 'cache_read']);
const TOP_FIELDS = Object.freeze(['version', 'models', 'providers']);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

const invalid = (message, code = 'PRICING_INVALID') =>
  Object.assign(new Error(message), { statusCode: 400, code });
const conflict = revision =>
  Object.assign(new Error('价目表已被其他请求修改,请刷新后重试'), {
    statusCode: 409, code: 'PRICING_CONFLICT', revision,
  });

// 公开牌价(USD / 1M tokens),2026-10 参考值。cache_read 取各家公布的缓存命中价,
// 没有公开缓存价的按 0 处理(宁可低估,也不编一个看起来精准的数)。
const DEFAULT_MODELS = {
  // Anthropic Claude
  'claude-opus-4-5': { in: 15, out: 75, cache_read: 1.5 },
  'claude-opus-4-1': { in: 15, out: 75, cache_read: 1.5 },
  'claude-opus-4': { in: 15, out: 75, cache_read: 1.5 },
  'claude-3-opus': { in: 15, out: 75, cache_read: 1.5 },
  'claude-sonnet-4-5': { in: 3, out: 15, cache_read: 0.3 },
  'claude-sonnet-4': { in: 3, out: 15, cache_read: 0.3 },
  'claude-3-7-sonnet': { in: 3, out: 15, cache_read: 0.3 },
  'claude-3-5-sonnet': { in: 3, out: 15, cache_read: 0.3 },
  'claude-haiku-4-5': { in: 1, out: 5, cache_read: 0.1 },
  'claude-3-5-haiku': { in: 0.8, out: 4, cache_read: 0.08 },
  'claude-3-haiku': { in: 0.25, out: 1.25, cache_read: 0.03 },
  // OpenAI GPT-5 系
  'gpt-5': { in: 1.25, out: 10, cache_read: 0.125 },
  'gpt-5.1': { in: 1.25, out: 10, cache_read: 0.125 },
  'gpt-5-codex': { in: 1.25, out: 10, cache_read: 0.125 },
  'gpt-5-mini': { in: 0.25, out: 2, cache_read: 0.025 },
  'gpt-5-nano': { in: 0.05, out: 0.4, cache_read: 0.005 },
  'gpt-4.1': { in: 2, out: 8, cache_read: 0.5 },
  'gpt-4o': { in: 2.5, out: 10, cache_read: 1.25 },
  // DeepSeek(V3.2 公开价)
  'deepseek-chat': { in: 0.28, out: 0.42, cache_read: 0.028 },
  'deepseek-reasoner': { in: 0.28, out: 0.42, cache_read: 0.028 },
  'deepseek-v3.2': { in: 0.28, out: 0.42, cache_read: 0.028 },
  'deepseek-v3.1': { in: 0.28, out: 0.42, cache_read: 0.028 },
  'deepseek-v3': { in: 0.27, out: 1.1, cache_read: 0.07 },
  // 内部/渠道自定的 flash 类(无公开牌价,取同量级估一个;以渠道计费为准)
  'deepseek-v4.1-flash': { in: 0.05, out: 0.2, cache_read: 0.01 },
  'deepseek-v4-flash': { in: 0.05, out: 0.2, cache_read: 0.01 },
};

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const DEFAULT_PRICING = deepFreeze({ version: 1, models: DEFAULT_MODELS, providers: {} });
const EMPTY_TABLE = () => ({ version: 1, models: {}, providers: {} });

// 一条价格:只认 in / out / cache_read 三个非负有限数。
// strict=true 时任何一项不合规都抛 400;false 时丢掉坏项(磁盘手改容错)。
function normalizePriceEntry(raw, where, strict) {
  if (!isPlainObject(raw)) {
    if (strict) throw invalid(`${where} 必须是对象`);
    return null;
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!PRICE_FIELDS.includes(key)) {
      if (strict) throw invalid(`${where} 含未知字段 "${key}"(只允许 in / out / cache_read)`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      if (strict) throw invalid(`${where}.${key} 必须是非负有限数字`);
      continue;
    }
    out[key] = value;
  }
  if (!Object.keys(out).length) {
    if (strict) throw invalid(`${where} 至少要有一项 in / out / cache_read`);
    return null;
  }
  return out;
}

function assertSafeKey(key, where, strict) {
  if (typeof key !== 'string' || !key.trim()) {
    if (strict) throw invalid(`${where} 的键必须是非空字符串`);
    return false;
  }
  if (DANGEROUS_KEYS.has(key)) {
    if (strict) throw invalid(`${where} 不允许使用 "${key}" 作为键`);
    return false;
  }
  return true;
}

// 整表归一化。宽松模式用于读盘(坏条目丢掉,保留其余),严格模式用于 PUT。
function normalizePricing(raw, strict = false) {
  if (!isPlainObject(raw)) {
    if (strict) throw invalid('价目表必须是对象');
    return EMPTY_TABLE();
  }
  for (const key of Object.keys(raw)) {
    if (key === 'expected_revision') continue; // PUT 的并发令牌,不写盘
    if (!TOP_FIELDS.includes(key)) {
      if (strict) throw invalid(`价目表含未知字段 "${key}"(只允许 version / models / providers)`);
    }
  }
  if (raw.version !== undefined && raw.version !== 1) {
    if (strict) throw invalid('version 只支持 1');
  }
  const models = {};
  if (raw.models !== undefined) {
    if (!isPlainObject(raw.models)) {
      if (strict) throw invalid('models 必须是对象');
    } else {
      for (const [model, entry] of Object.entries(raw.models)) {
        if (!assertSafeKey(model, 'models', strict)) continue;
        const price = normalizePriceEntry(entry, `models["${model}"]`, strict);
        if (price) models[model] = price;
      }
    }
  }
  const providers = {};
  if (raw.providers !== undefined) {
    if (!isPlainObject(raw.providers)) {
      if (strict) throw invalid('providers 必须是对象');
    } else {
      for (const [provider, table] of Object.entries(raw.providers)) {
        if (!assertSafeKey(provider, 'providers', strict)) continue;
        if (!isPlainObject(table)) {
          if (strict) throw invalid(`providers["${provider}"] 必须是对象`);
          continue;
        }
        const perModel = {};
        for (const [model, entry] of Object.entries(table)) {
          if (!assertSafeKey(model, `providers["${provider}"]`, strict)) continue;
          const price = normalizePriceEntry(entry, `providers["${provider}"]["${model}"]`, strict);
          if (price) perModel[model] = price;
        }
        // 空对象 = 这层没有覆盖,允许(控制台删光某渠道的覆盖时会写成 {})。
        if (Object.keys(perModel).length) providers[provider] = perModel;
      }
    }
  }
  return { version: 1, models, providers };
}

// ---- 匹配 ----------------------------------------------------------------
const BOUNDARY = /[-_.:/@\d]/;

function exactEntry(map, model) {
  if (!isPlainObject(map) || !Object.hasOwn(map, model)) return null;
  return { key: model, entry: map[model] };
}

// 最长前缀。要求前缀之后是分隔符或数字:gpt-5 吃 gpt-5-2025 合法,吃 gpt-50 不合法。
function prefixEntry(map, model) {
  if (!isPlainObject(map)) return null;
  let best = null;
  for (const key of Object.keys(map)) {
    if (!key || !model.startsWith(key) || model.length === key.length) continue;
    if (!BOUNDARY.test(model[key.length])) continue;
    if (!best || key.length > best.length) best = key;
  }
  return best ? { key: best, entry: map[best] } : null;
}

// 返回 {in, out, cache_read} 或 null(完全没定价)。
// provider 可以是 id、名字,或两者的数组(按顺序挑第一个"有覆盖"的键):日志里存的是渠道名
// (entry.provider = provider.name),而价目表结构按 providerId 组织;调用方同时给 id 与名字,
// 谁真的配了覆盖就用谁,都没配则落到 models 的全局价。
function priceEntry(table, model, provider) {
  if (!model) return null;
  const t = isPlainObject(table) ? table : DEFAULT_PRICING;
  const models = isPlainObject(t.models) ? t.models : {};
  const providers = isPlainObject(t.providers) ? t.providers : {};
  const keys = (Array.isArray(provider) ? provider : [provider]).filter(nonEmptyString);
  const overrideMaps = keys
    .map(key => (isPlainObject(providers[key]) ? providers[key] : null))
    .filter(Boolean);

  let base = exactEntry(models, model);
  let over = null;
  for (const map of overrideMaps) { over = exactEntry(map, model); if (over) break; }
  if (!base && !over) {
    const bp = prefixEntry(models, model);
    let op = null;
    for (const map of overrideMaps) { op = prefixEntry(map, model); if (op) break; }
    // 同长度时 provider 优先(更具体的那一层)
    if (op && (!bp || op.key.length >= bp.key.length)) over = op;
    else base = bp;
  }
  if (!base && !over) return null;
  const price = { in: 0, out: 0, cache_read: 0 };
  if (base) Object.assign(price, base.entry);
  if (over) Object.assign(price, over.entry);
  return price;
}

const nonEmptyString = value => typeof value === 'string' && value.length > 0;

// 单条用量的成本(USD)。未定价 → cost 0 且 priced=false。
function costOf(table, { model, provider, in: inTok = 0, out = 0, cache_read = 0 } = {}) {
  const price = priceEntry(table, model, provider);
  if (!price) return { cost: 0, priced: false };
  const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return {
    cost: num(inTok) / 1e6 * price.in + num(out) / 1e6 * price.out + num(cache_read) / 1e6 * price.cache_read,
    priced: true,
  };
}

// ---- 存储 ----------------------------------------------------------------
const pricingFile = dataDir => path.join(dataDir, 'pricing.json');
const emptyRevision = () => crypto.createHash('sha256').update('').digest('hex').slice(0, 16);
const hashText = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

// 自定义表与默认表合并成"生效表"。providers 只来自自定义(默认没有 provider 覆盖)。
function effectiveOf(custom) {
  const table = normalizePricing(custom, false);
  return {
    version: 1,
    models: { ...DEFAULT_MODELS, ...table.models },
    providers: table.providers,
  };
}
const hasCustom = custom => {
  const table = normalizePricing(custom, false);
  return Object.keys(table.models).length > 0 || Object.keys(table.providers).length > 0;
};

function createPricingStore({ file } = {}) {
  if (!file) throw new TypeError('createPricingStore: file 必填');

  function readRaw() {
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (text === null) return { custom: EMPTY_TABLE(), revision: emptyRevision(), invalid: false };
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 手改坏了:按默认表继续,并把问题报给调用方 */ }
    if (parsed === null) return { custom: EMPTY_TABLE(), revision: hashText(text), invalid: true };
    return { custom: normalizePricing(parsed, false), revision: hashText(text), invalid: false };
  }

  function listing() {
    const raw = readRaw();
    const table = effectiveOf(raw.custom);
    const source = hasCustom(raw.custom) ? 'custom' : 'default';
    return {
      pricing: table,
      // custom 只含**自定义过的**键(不是合并后的生效表):控制台编辑后要原样写回,
      // 把默认证价也一起写进 pricing.json 会让"改了一个模型"变成"冻结整张默认表"。
      custom: raw.custom,
      revision: raw.revision,
      source,
      ...(raw.invalid ? { warning: 'pricing.json 不是有效 JSON,当前使用默认价目表' } : {}),
    };
  }

  function write(input, options = {}) {
    if (!isPlainObject(input)) throw invalid('价目表必须是对象');
    const expected = options.expected_revision !== undefined
      ? options.expected_revision
      : input.expected_revision;
    if (expected !== undefined) {
      if (typeof expected !== 'string') throw invalid('expected_revision 必须是字符串');
      const current = readRaw().revision;
      if (expected !== current) throw conflict(current);
    }
    const normalized = normalizePricing(input, true);
    writeJsonAtomic(file, normalized, { mode: 0o600 });
    return listing();
  }

  return { file, read: listing, effective: () => effectiveOf(readRaw().custom), write };
}

module.exports = {
  DEFAULT_PRICING, DEFAULT_MODELS, PRICE_FIELDS,
  pricingFile, normalizePricing, priceEntry, costOf, effectiveOf,
  createPricingStore, emptyRevision,
};
