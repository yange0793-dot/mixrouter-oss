'use strict';
// 渠道导入:把用户上传的 JSON 变成**可预览、可合并**的渠道草稿。
//
// 支持两种来源:
//   1) mixrouter 自己的 providers.json 格式({ version, current, claude: [], codex: [] });
//   2) cc-switch 导出的 JSON(providers 行数组、按 app 分组的旧配置,或
//      { claude: { providers: {...} }, codex: { providers: {...} } }),包括
//      settings_config / settingsConfig 里的 env 与 Codex TOML。
//
// 两条硬规则:
//   · **只取白名单字段**。任何未知字段都不进草稿;prototype 污染键(__proto__ /
//     constructor / prototype)在扫描阶段就拒绝。对象只按已知字段重建,不 spread 输入。
//   · **合并只增不改**。已有的渠道(按 app + base_url + api_key 判定)、current 指针、
//     已有 id 一律不动;同名不同 key 的渠道会作为新渠道加入,不会覆盖旧渠道的 key。
//
// 密钥边界:preview 返回的 draft 是**服务端对象**,merge 需要 api_key;但它带 toJSON,
// 被 JSON.stringify(接口直接返回、日志打印)时自动换成 key_masked,不出现 key 正文。
// 需要显式构造预览响应时用 redactProviderImportPreview()。

const codexConfig = require('./codex-config');
const { validBaseUrl } = require('./routing/headers');

const APPS = Object.freeze(['claude', 'codex']);
const CLAUDE_SLOT_KEYS = Object.freeze(['opus', 'sonnet', 'haiku', 'subagent']);
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 500;
const MAX_MODELS = 200;
const MAX_MODEL_LENGTH = 256;
const MAX_KEY_LENGTH = 8192;
const MAX_NAME_LENGTH = 200;
const MAX_NOTE_LENGTH = 2000;
const MAX_UA_LENGTH = 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => Object.assign(new Error(message), { statusCode: 400 });

function maskKey(value) {
  const text = String(value ?? '');
  if (!text) return '';
  return text.length > 12 ? text.slice(0, 6) + '…' + text.slice(-4) : '***';
}
function publicUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    // 查询串与片段可能夹带凭据:预览里直接不显示,只保留 origin + pathname。
    return url.origin + url.pathname;
  } catch { return value; }
}
// —— 输入解析与污染防护 -------------------------------------------------------
function assertSafe(value, depth = 0) {
  if (depth > 24) throw fail('导入内容的嵌套层级过深');
  if (Array.isArray(value)) {
    if (value.length > 10000) throw fail('导入内容包含过长的数组');
    for (const item of value) assertSafe(item, depth + 1);
    return;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > 2000) throw fail('导入内容包含过多字段');
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) throw fail('导入内容包含非法字段名，已拒绝');
      if (key.length > 200) throw fail('导入内容包含过长的字段名');
      assertSafe(value[key], depth + 1);
    }
    return;
  }
  if (typeof value === 'string' && value.length > 1000000) throw fail('导入内容包含过长字符串');
}

function parseInput(input) {
  let root;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    const text = typeof input === 'string' ? input : input.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw fail('导入文件超过 2 MB，已拒绝');
    try { root = JSON.parse(text); }
    catch { throw fail('导入文件不是合法 JSON'); }
  } else if (isObject(input) || Array.isArray(input)) {
    // JSON 往返去掉 getter、函数与循环引用,保证后面看到的只是数据。
    try { root = JSON.parse(JSON.stringify(input)); }
    catch { throw fail('导入内容不是可序列化的 JSON'); }
  } else {
    throw fail('导入内容必须是 JSON 对象、数组或 JSON 文本');
  }
  assertSafe(root);
  return root;
}

// —— 来源识别 ---------------------------------------------------------------
function appOf(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'claude' || text === 'claude-desktop') return 'claude';
  if (text === 'codex') return 'codex';
  return null;
}
function hasProviderShape(value) {
  return isObject(value) && ['base_url', 'api_key', 'settings_config', 'settingsConfig', 'env', 'auth', 'config']
    .some(key => hasOwn(value, key));
}

function collectCandidates(root) {
  const list = [];
  let count = 0;
  const add = (appHint, raw, where) => {
    if (++count > MAX_ENTRIES) throw fail('导入条目超过 500 个，已拒绝');
    list.push({ appHint: appHint || null, raw, where });
  };
  const addSection = (app, value, where) => {
    if (Array.isArray(value)) value.forEach((raw, index) => add(app, raw, `${where}[${index + 1}]`));
    else if (isObject(value)) {
      if (hasProviderShape(value)) add(app, value, where);
      else {
        const nested = hasOwn(value, 'providers') ? value.providers : value;
        if (Array.isArray(nested)) nested.forEach((raw, index) => add(app, raw, `${where}.providers[${index + 1}]`));
        else if (isObject(nested)) {
          for (const [key, raw] of Object.entries(nested)) add(app, raw, `${where}.${key}`);
        }
      }
    }
  };

  if (Array.isArray(root)) {
    root.forEach((raw, index) => add(appOf(raw?.app_type ?? raw?.app ?? raw?.appType), raw, `#${index + 1}`));
  } else if (isObject(root)) {
    if (Array.isArray(root.providers)) {
      root.providers.forEach((raw, index) => add(appOf(raw?.app_type ?? raw?.app ?? raw?.appType), raw, `providers[${index + 1}]`));
    } else if (isObject(root.providers)) {
      for (const app of APPS) if (root.providers[app] !== undefined) addSection(app, root.providers[app], `providers.${app}`);
    }
    for (const app of APPS) {
      if (root[app] !== undefined) addSection(app, root[app], app);
    }
  }
  if (!list.length) throw fail('没有识别到可导入的渠道；支持 mixrouter providers.json 或 cc-switch 导出的 JSON');
  return list;
}

// —— 字段收敛 ---------------------------------------------------------------
function textField(value, label, { required = false, max = 1024 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw fail(`${label} 必填`);
    return '';
  }
  if (typeof value !== 'string') throw fail(`${label} 必须是字符串`);
  const text = value.trim();
  if (required && !text) throw fail(`${label} 必填`);
  if (text.length > max) throw fail(`${label} 过长`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw fail(`${label} 不能包含换行或控制字符`);
  return text;
}
function boolField(value, label, fallback = true) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw fail(`${label} 必须是布尔值`);
  return value;
}
function listField(value, label) {
  if (value === undefined || value === null) return [];
  const source = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(source)) throw fail(`${label} 必须是字符串数组`);
  if (source.length > MAX_MODELS) throw fail(`${label} 条目过多`);
  const out = [];
  for (const item of source) {
    if (typeof item !== 'string') throw fail(`${label} 的每一项都必须是字符串`);
    const text = item.trim();
    if (!text) continue;
    if (text.length > MAX_MODEL_LENGTH) throw fail(`${label} 中有过长的模型名`);
    if (!out.includes(text)) out.push(text);
  }
  return out;
}
function slotsField(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw fail('slots 必须是对象');
  const out = {};
  for (const key of CLAUDE_SLOT_KEYS) {
    if (!hasOwn(value, key) || value[key] === undefined || value[key] === null || value[key] === '') { out[key] = ''; continue; }
    if (typeof value[key] !== 'string') throw fail(`slots.${key} 必须是字符串`);
    const text = value[key].trim();
    if (text.length > MAX_MODEL_LENGTH) throw fail(`slots.${key} 过长`);
    out[key] = text;
  }
  return out;
}

function fromClaudeSettings(outer, settings) {
  const env = isObject(settings.env) ? settings.env : settings;
  const model = value => (typeof value === 'string' ? value.trim() : '');
  return {
    name: outer.name,
    base_url: env.ANTHROPIC_BASE_URL ?? settings.base_url,
    api_key: env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? settings.api_key,
    models: [env.ANTHROPIC_MODEL, env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL, env.CLAUDE_CODE_SUBAGENT_MODEL]
      .map(model).filter(Boolean),
    slots: {
      opus: model(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
      sonnet: model(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
      haiku: model(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
      subagent: model(env.CLAUDE_CODE_SUBAGENT_MODEL),
    },
    ua: outer.ua,
    wire_api: outer.wire_api,
    enabled: outer.enabled,
    note: outer.note ?? outer.notes,
  };
}

function fromCodexSettings(outer, settings) {
  const auth = isObject(settings.auth) ? settings.auth : {};
  let model = settings.model;
  let base = settings.base_url;
  let wire = settings.wire_api;
  let key = auth.OPENAI_API_KEY ?? settings.OPENAI_API_KEY ?? settings.api_key;
  const toml = settings.config ?? settings.toml;
  if (toml !== undefined && toml !== null) {
    if (typeof toml !== 'string') throw fail('Codex settings_config.config 必须是 TOML 字符串');
    let document;
    try { document = codexConfig.parse(toml); }
    catch { throw fail('Codex TOML 无法解析'); }
    let providerId = document.get('model_provider');
    if (!providerId) {
      // 有些导出只留一个 [model_providers.x] 段,没有顶层 model_provider;
      // 唯一一段就是它的上游,不猜多段时的归属。
      const tables = document.sections.filter(table => table.parts.length === 2 && table.parts[0] === 'model_providers');
      providerId = tables.length === 1 ? tables[0].parts[1] : 'openai';
    }
    model = model ?? document.get('model');
    base = base ?? document.get('model_providers', providerId, 'base_url');
    wire = wire ?? document.get('model_providers', providerId, 'wire_api');
    key = key ?? document.get('model_providers', providerId, 'experimental_bearer_token');
  }
  return {
    name: outer.name,
    base_url: base,
    api_key: key,
    model,
    wire_api: wire,
    enabled: outer.enabled,
    note: outer.note ?? outer.notes,
    drop_images: outer.drop_images,
  };
}

function normalizeCandidate(candidate, index) {
  const raw = candidate.raw;
  if (!isObject(raw)) return { error: '条目必须是 JSON 对象' };
  const declared = appOf(raw.app_type ?? raw.app ?? raw.appType);
  if (candidate.appHint && declared && declared !== candidate.appHint) {
    return { error: `条目声明的 app（${declared}）与所在分组（${candidate.appHint}）不一致` };
  }
  const app = candidate.appHint || declared;
  if (!app) return { skip: '不支持的 app 类型' };

  let source;
  const hasSettings = hasOwn(raw, 'settings_config') || hasOwn(raw, 'settingsConfig');
  if (hasSettings) {
    let settings = raw.settings_config ?? raw.settingsConfig;
    if (typeof settings === 'string') {
      try { settings = JSON.parse(settings); }
      catch { return { error: 'settings_config 不是合法 JSON' }; }
    }
    if (!isObject(settings)) return { error: 'settings_config 必须是 JSON 对象或对象字符串' };
    source = app === 'claude' ? fromClaudeSettings(raw, settings) : fromCodexSettings(raw, settings);
  } else if (hasOwn(raw, 'env') || hasOwn(raw, 'auth') || hasOwn(raw, 'config')) {
    source = app === 'claude' ? fromClaudeSettings(raw, raw) : fromCodexSettings(raw, raw);
  } else {
    source = {
      name: raw.name, base_url: raw.base_url, api_key: raw.api_key,
      models: raw.models, slots: raw.slots, ua: raw.ua, wire_api: raw.wire_api,
      enabled: raw.enabled, note: raw.note ?? raw.notes,
      model: raw.model, drop_images: raw.drop_images,
    };
  }

  try {
    return { app, provider: buildProvider(app, source, index) };
  } catch (error) {
    return { app, error: error.message };
  }
}

function buildProvider(app, source, index) {
  if (!isObject(source)) throw fail('渠道必须是 JSON 对象');
  const name = textField(source.name, '渠道名', { max: MAX_NAME_LENGTH }) || `导入渠道 ${index + 1}`;
  const baseRaw = textField(source.base_url, 'base_url', { required: true, max: 2048 });
  if (!validBaseUrl(baseRaw)) throw fail('base_url 必须是合法的 http(s) URL，且不能包含凭据');
  const base = baseRaw.replace(/\/+$/, '');
  const key = textField(source.api_key, 'API Key', { required: true, max: MAX_KEY_LENGTH });
  if (key === 'PROXY_MANAGED') throw fail('API Key 是路由占位值（PROXY_MANAGED），不是真实密钥，未导入');
  const enabled = boolField(source.enabled, 'enabled');
  const note = textField(source.note, '备注', { max: MAX_NOTE_LENGTH });

  if (app === 'claude') {
    const wire = source.wire_api;
    if (wire !== undefined && wire !== null && !['anthropic', 'responses', 'chat'].includes(wire)) {
      throw fail('claude 渠道的 wire_api 必须是 anthropic、responses 或 chat');
    }
    const provider = {
      name, base_url: base, api_key: key,
      models: listField(source.models, '模型列表'),
      slots: slotsField(source.slots) || { opus: '', sonnet: '', haiku: '', subagent: '' },
      ua: textField(source.ua, 'User-Agent', { max: MAX_UA_LENGTH }),
      enabled, note,
    };
    if (wire === 'responses' || wire === 'chat') provider.wire_api = wire;
    return provider;
  }

  const model = textField(source.model, '模型名', { required: true, max: MAX_MODEL_LENGTH });
  const wire = source.wire_api;
  if (wire !== undefined && wire !== null && !['responses', 'chat'].includes(wire)) {
    throw fail('codex 渠道的 wire_api 必须是 responses 或 chat');
  }
  return {
    name, base_url: base, api_key: key, model,
    wire_api: wire === 'chat' ? 'chat' : 'responses',
    enabled, note,
    drop_images: boolField(source.drop_images, 'drop_images', false),
  };
}

// —— 指纹与 id ---------------------------------------------------------------
function fingerprintBase(value) {
  try {
    const url = new URL(value);
    return (url.origin + url.pathname.replace(/\/+$/, '') + url.search).toLowerCase();
  } catch { return String(value).trim().replace(/\/+$/, '').toLowerCase(); }
}
const fingerprint = (app, provider) => `${app}\u0000${fingerprintBase(provider.base_url)}\u0000${provider.api_key}`;

function storeArrays(store) {
  if (!isObject(store) || !Array.isArray(store.claude) || !Array.isArray(store.codex)) {
    throw fail('渠道库格式无效，未合并');
  }
  return store;
}
function takenIds(store) {
  const ids = new Set();
  for (const provider of [...store.claude, ...store.codex]) if (provider && typeof provider.id === 'string') ids.add(provider.id);
  return ids;
}
function nextId(app, ids) {
  const prefix = app === 'codex' ? 'c' : 'p';
  for (let index = 1; index < ids.size + 1000; index++) {
    const id = prefix + index;
    if (!ids.has(id)) return id;
  }
  return prefix + Date.now().toString(36);
}
function existingFingerprints(store) {
  const set = new Set();
  for (const app of APPS) {
    for (const provider of store[app]) {
      if (!provider || typeof provider !== 'object') continue;
      if (typeof provider.base_url !== 'string' || typeof provider.api_key !== 'string') continue;
      set.add(fingerprint(app, provider));
    }
  }
  return set;
}

// —— 预览 -------------------------------------------------------------------
function makeDraft(entries, rejected) {
  const draft = {
    kind: 'mixrouter-providers',
    version: 1,
    created_at: new Date().toISOString(),
    rejected,
    entries,
  };
  // 服务端仍能读 entries[i].provider.api_key(merge 需要);任何 JSON 序列化都自动脱敏。
  Object.defineProperty(draft, 'toJSON', {
    enumerable: false,
    value() {
      return {
        kind: this.kind,
        version: this.version,
        created_at: this.created_at,
        rejected: this.rejected,
        entries: this.entries.map(entry => ({
          app: entry.app, id: entry.id, provider: publicProvider(entry.provider),
        })),
      };
    },
  });
  return draft;
}

function publicProvider(provider) {
  const out = { ...provider };
  const key = provider.api_key ?? out.api_key;
  delete out.api_key;
  out.base_url = publicUrl(out.base_url);
  out.key_masked = maskKey(key);
  out.has_key = !!key;
  return out;
}

// 预览草稿里的 provider 把 api_key 收成**不可枚举**属性:
//   · merge 直接读 provider.api_key 仍然拿得到(服务端内部使用);
//   · 任何 JSON.stringify(provider) / {...provider} 都不会带出 key 正文,
//     即使调用方没有先走 draft.toJSON 也一样。
// merge 重建渠道时会生成 api_key 可枚举的新对象,落盘 providers.json 不受影响。
function sealPreviewProvider(provider) {
  const out = { ...provider };
  const key = provider.api_key;
  delete out.api_key;
  Object.defineProperty(out, 'api_key', { value: key, enumerable: false, writable: true, configurable: true });
  out.key_masked = maskKey(key);
  out.has_key = !!key;
  return out;
}

function emptyCounts() {
  return { claude: 0, codex: 0 };
}

function previewProviderImport(store, input) {
  storeArrays(store);
  const root = parseInput(input);
  const candidates = collectCandidates(root);
  const existing = existingFingerprints(store);
  const batch = new Set();
  const ids = takenIds(store);
  const entries = [];
  const errors = [];
  const summary = {
    input: candidates.length,
    valid: 0,
    rejected: 0,
    skipped: 0,
    new: emptyCounts(),
    duplicate_existing: emptyCounts(),
    duplicate_input: emptyCounts(),
  };

  candidates.forEach((candidate, index) => {
    const normalized = normalizeCandidate(candidate, index);
    if (normalized.skip) { summary.skipped++; return; }
    if (normalized.error) {
      summary.rejected++;
      errors.push({
        index,
        where: candidate.where,
        app: candidate.appHint || null,
        name: typeof candidate.raw?.name === 'string' ? candidate.raw.name.slice(0, 60) : '',
        message: normalized.error,
      });
      return;
    }
    const provider = normalized.provider;
    const app = normalized.app;
    summary.valid++;
    const fp = fingerprint(app, provider);
    if (existing.has(fp)) { summary.duplicate_existing[app]++; return; }
    if (batch.has(fp)) { summary.duplicate_input[app]++; return; }
    batch.add(fp);
    const id = nextId(app, ids);
    ids.add(id);
    entries.push({ app, id, provider: sealPreviewProvider(provider) });
    summary.new[app]++;
  });

  return { draft: makeDraft(entries, summary.rejected), summary, errors };
}

// —— 合并 -------------------------------------------------------------------
function mergeProviderImport(store, draft) {
  storeArrays(store);
  if (!isObject(draft) || draft.kind !== 'mixrouter-providers' || !Array.isArray(draft.entries)) {
    throw fail('导入草稿无效，未合并');
  }
  if (draft.entries.length > MAX_ENTRIES) throw fail('导入草稿条目超过 500 个，未合并');
  const merged = clone(store);
  merged.version = Number.isInteger(merged.version) ? merged.version : 2;
  if (!isObject(merged.current)) merged.current = { claude: null, codex: null };
  const ids = takenIds(merged);
  const fingerprints = existingFingerprints(merged);
  const added = new Set();
  const createdAt = typeof draft.created_at === 'string' && !Number.isNaN(Date.parse(draft.created_at))
    ? draft.created_at : new Date().toISOString();

  for (const entry of draft.entries) {
    if (!isObject(entry) || !APPS.includes(entry.app) || !isObject(entry.provider)) {
      throw fail('导入草稿条目无效，未合并');
    }
    // 草稿可能来自客户端回传:合并前按同一套白名单重建,不信任任何现成对象。
    const provider = buildProvider(entry.app, entry.provider, 0);
    const fp = fingerprint(entry.app, provider);
    if (fingerprints.has(fp) || added.has(fp)) continue;
    const id = typeof entry.id === 'string' && ID_RE.test(entry.id) && !ids.has(entry.id)
      ? entry.id : nextId(entry.app, ids);
    ids.add(id);
    merged[entry.app].push({ id, ...provider, created_at: createdAt });
    added.add(fp);
  }
  return merged;
}

function redactProviderImportPreview(draft) {
  if (!isObject(draft) || !Array.isArray(draft.entries)) throw fail('导入草稿无效');
  return {
    kind: draft.kind,
    version: draft.version,
    created_at: draft.created_at,
    rejected: draft.rejected,
    entries: draft.entries.map(entry => ({
      app: entry.app, id: entry.id, provider: publicProvider(entry.provider),
    })),
  };
}

module.exports = {
  previewProviderImport, mergeProviderImport, redactProviderImportPreview,
  publicProvider, maskKey, fingerprint, MAX_ENTRIES,
};
