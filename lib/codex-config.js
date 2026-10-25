'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

// TOML 基本字符串。JSON 的转义集与 TOML 语义一致(\b \f \n \r \t \" \\ \uXXXX),
// 所以直接用 JSON.stringify —— 旧实现只手写转义 \ 和 ",遇到换行会吐出
// `x = "a<换行>b"` 这种非法 TOML,等于把损坏的配置写进客户端。
//
// 唯一的例外是 U+007F(DEL):TOML 1.0 要求控制字符里含 DEL 也必须转义,而 JSON 允许
// 原样输出。这行补掉它 —— 顺带也让写入侧与 restore.js 的 validateToml 对齐:后者按
// TOML 规则拒绝含裸 DEL 的文本,不补的话自己写出去的备份会过不了自己的校验。
const quote = value => JSON.stringify(String(value ?? '')).replace(/\u007f/g, '\\u007f');
const revision = text => crypto.createHash('sha256').update(text).digest('hex');
const keyOf = parts => JSON.stringify(parts);
// 「哪些 section 是本产品写的」只有这一处判定:patch 的清理与旧 removeOwnSections 都用它。
const MIXR_SECTION_PREFIX = 'mixr-';
const MIXR_SECTION_RE = /^\s*\[model_providers\.mixr-/;

function splitKey(source) {
  const parts = [];
  const pattern = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(\.|$)/gy;
  let offset = 0;
  while (offset < source.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match) throw invalid('Codex TOML 包含无法安全编辑的键');
    parts.push(match[1][0] === '"' ? JSON.parse(match[1]) : match[1][0] === "'" ? match[1].slice(1, -1) : match[1]);
    offset = pattern.lastIndex;
  }
  return parts;
}

function scalar(source) {
  const value = source.trim();
  if (value.startsWith('"""') || value.startsWith("'''")) return undefined;
  const string = value.match(/^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
  if (string) {
    if (string[1][0] === "'") return string[1].slice(1, -1);
    try { return JSON.parse(string[1].replace(/\\U([0-9a-fA-F]{8})/g, (_, hex) => JSON.stringify(String.fromCodePoint(parseInt(hex, 16))).slice(1, -1))); }
    catch { throw invalid('Codex TOML 字符串转义无效'); }
  }
  const bare = value.split('#')[0].trim();
  if (bare === 'true' || bare === 'false') return bare === 'true';
  if (/^[+-]?\d[\d_]*$/.test(bare)) return Number(bare.replace(/_/g, ''));
  if (/^["']/.test(value)) throw invalid('Codex TOML 字符串未闭合');
  if (/^[\[{]/.test(bare) || /^[+-]?(?:\d[\d_.eE+-]*|0[xob][0-9a-fA-F_]+|inf|nan)$/.test(bare) || /^\d{4}-\d{2}-\d{2}/.test(bare) || /^\d{2}:\d{2}:\d{2}/.test(bare)) return undefined;
  throw invalid('Codex TOML 包含无效的值，未写入');
}

function parse(text) {
  const lines = String(text || '').split('\n');
  const values = new Map();
  const entries = [];
  const sections = [];
  let section = [], multiline = '', depth = 0;
  const scan = line => {
    let single = '';
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      if (multiline) {
        if (line.slice(index, index + 3) === multiline) { multiline = ''; index += 2; }
        else if (multiline === '"""' && character === '\\') index++;
        continue;
      }
      if (single) {
        if (single === '"' && character === '\\') index++;
        else if (character === single) single = '';
        continue;
      }
      if (character === '#') break;
      if (line.slice(index, index + 3) === '"""' || line.slice(index, index + 3) === "'''") { multiline = line.slice(index, index + 3); index += 2; }
      else if (character === '"' || character === "'") single = character;
      else if (character === '[' || character === '{') depth++;
      else if (character === ']' || character === '}') depth--;
    }
    if (single || depth < 0) throw invalid('Codex TOML 字符串或括号未闭合');
  };
  for (const [index, line] of lines.entries()) {
    if (!multiline && depth === 0) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const header = line.match(/^\s*\[\[?(.*?)\]\]?\s*(?:#.*)?$/);
      if (header) {
        section = splitKey(header[1]);
        sections.push({ parts: section, start: index, array: /^\s*\[\[/.test(line) });
        continue;
      }
      const assignment = line.match(/^\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_. -])+?)\s*=\s*(.*)$/);
      if (!assignment) throw invalid(`Codex TOML 第 ${index + 1} 行无法安全解析，未写入`);
      const parts = [...section, ...splitKey(assignment[1].trim())];
      const key = keyOf(parts);
      const inArray = sections[sections.length - 1]?.array;
      if (values.has(key) && !inArray) throw invalid(`Codex TOML 存在重复键 ${parts.join('.')}`);
      const value = scalar(assignment[2]);
      values.set(key, value);
      entries.push({ parts, index, value });
    }
    scan(line);
  }
  if (multiline || depth) throw invalid('Codex TOML 多行值未闭合，未写入');
  const get = (...parts) => values.get(keyOf(parts));
  return { lines, entries, sections, get };
}

function read(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') text = ''; else throw error; }
  return { text, document: parse(text), revision: revision(text) };
}

function topLevel(text, key) {
  const value = parse(text).get(key);
  return typeof value === 'string' ? value : '';
}

// —— 旧 lib/toml.js 与 lib/codex-toml.js 的薄适配 ——
// 这两个文件里已经没有第二份算法:下面每个函数只做参数与返回形状的转换,解析、改写、
// 转义全部落回本文件上面的 parse/patch/quote。旧名字保留,是因为 mixrouter.js 的导出面
// (test/codex.test.js 的 codexTopLevel、test/helpers.test.js 的 tomlStr)按这些名字取。
//
// removeOwnSections 与 setTopLevel 提供的是「行数组」这层旧形状。本文件的 patch 按文档
// 结构改写,不暴露中间行数组;所以这里把行拼回文本交给 patch,再把结果拆回行 —— 判定
// 「原本有没有这个键」也交给 parse,不再另写一遍正则认法(旧实现会把多行字符串里的
// `model = "x"` 也当成顶层键,现在按文档结构读,不会)。

// 删掉所有本产品写入过的 [model_providers.mixr-*] section,别的一行不碰。
// section 的范围 = 从它的 [头] 到下一个 [头] 之前。
function removeOwnSections(text) {
  const document = parse(text);
  const removals = new Set();
  for (const [index, table] of document.sections.entries()) {
    if (table.parts[0] !== 'model_providers' || !table.parts[1]?.startsWith(MIXR_SECTION_PREFIX)) continue;
    const end = document.sections[index + 1]?.start ?? document.lines.length;
    for (let line = table.start; line < end; line++) removals.add(line);
  }
  return document.lines.filter((line, index) => !removals.has(index));
}

// 顶层 model / model_provider 原位替换;原本没有的补到最前。
// keepModel 时顶层 model 保持原值 —— 路由规则就是按它匹配的。
// 补行的次序是 model 在前、model_provider 在后(patch 按传入对象的键序追加),与旧实现一致。
function setTopLevel(kept, { section, model, keepModel }) {
  const lines = [...kept];
  const text = lines.join('\n');
  const document = parse(text);
  const hasModel = document.get('model') !== undefined;
  const hasProvider = document.get('model_provider') !== undefined;
  const top = {};
  if (!(keepModel && hasModel)) top.model = model;
  top.model_provider = section;
  const out = patch(text, { top }).split('\n');
  // 空输入没有"末尾换行"这回事:patch 追加行的 join 会带出一个尾换行,去掉它才与旧返回逐项一致。
  if (!lines.length && out.at(-1) === '') out.pop();
  return { lines: out, hasModel, hasProvider };
}

// 一个 provider section 的行。wire_api 缺省 responses(Codex 侧渠道的默认协议)。
// 返回的是"这一组行"本身,插到哪里由调用方决定,所以只做构造,不走 patch。
function providerSection({ section, name, base_url, api_key, wire_api }) {
  return ['', `[model_providers.${section}]`,
    `name = ${quote(name)}`,
    `base_url = ${quote(base_url)}`,
    `wire_api = ${quote(wire_api || 'responses')}`,
    'requires_openai_auth = false',
    `experimental_bearer_token = ${quote(api_key)}`];
}

function patch(text, { top = {}, section, provider = {} } = {}) {
  const document = parse(text);
  const replacements = new Map();
  const removals = new Set();
  const additions = [];
  for (const [key, value] of Object.entries(top)) {
    if (value === undefined) continue;
    const existing = document.entries.find(entry => entry.parts.length === 1 && entry.parts[0] === key);
    if (value === null) { if (existing) removals.add(existing.index); continue; }
    if (existing && existing.value === undefined) throw invalid(`不能安全修改多行或复杂值 ${key}`);
    const line = `${key} = ${typeof value === 'string' ? quote(value) : String(value)}`;
    if (existing) { if (existing.value !== value) replacements.set(existing.index, line); }
    else additions.push(line);
  }
  if (section) {
    if (!/^[A-Za-z0-9_-]+$/.test(section)) throw invalid('Codex provider 标识无效');
    const referenced = new Set(document.entries.filter(entry => entry.parts.length > 1 && entry.parts.at(-1) === 'model_provider').map(entry => entry.value));
    for (const [index, table] of document.sections.entries()) {
      if (table.parts[0] !== 'model_providers' || !table.parts[1]?.startsWith(MIXR_SECTION_PREFIX) || table.parts[1] === section || referenced.has(table.parts[1])) continue;
      const end = document.sections[index + 1]?.start ?? document.lines.length;
      for (let line = table.start; line < end; line++) removals.add(line);
    }
    const table = document.sections.find(candidate => candidate.parts.length === 2 && candidate.parts[0] === 'model_providers' && candidate.parts[1] === section);
    const missing = [];
    for (const [key, value] of Object.entries(provider)) {
      const existing = document.entries.find(entry => keyOf(entry.parts) === keyOf(['model_providers', section, key]));
      if (existing && existing.value === undefined) throw invalid(`不能安全修改 provider 多行值 ${key}`);
      const line = `${key} = ${typeof value === 'string' ? quote(value) : String(value)}`;
      if (existing) { if (existing.value !== value) replacements.set(existing.index, line); }
      else missing.push(line);
    }
    if (table) replacements.set(table.start, [document.lines[table.start], ...missing].join('\n'));
    else additions.push('', `[model_providers.${section}]`, ...missing);
  }
  const topLines = additions.filter(line => !line.startsWith('['));
  const firstTable = additions.findIndex(line => line.startsWith('['));
  const head = firstTable >= 0 ? additions.slice(0, firstTable - 1) : topLines;
  const tail = firstTable >= 0 ? additions.slice(firstTable - 1) : [];
  const kept = document.lines.flatMap((line, index) => removals.has(index) ? [] : [replacements.get(index) ?? line]);
  const result = [...head, ...kept, ...tail].join('\n').replace(/\n{3,}$/, '\n\n');
  parse(result);
  return result;
}

function baseURL(base) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid('Codex base_url 必须是无凭据和查询参数的 HTTP(S) 地址');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
  return url.toString().replace(/\/+$/, '');
}

const catalogCache = new Map();
function catalog(file, document) {
  const configured = document.get('model_catalog_json');
  if (!configured) return { file: '', models: [] };
  if (typeof configured !== 'string') throw invalid('model_catalog_json 必须是路径字符串');
  const catalogFile = path.resolve(path.dirname(file), configured);
  const stat = fs.statSync(catalogFile);
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const cached = catalogCache.get(catalogFile);
  const raw = cached && cached.stamp === stamp ? cached.raw : JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  if (!cached || cached.stamp !== stamp) catalogCache.set(catalogFile, { stamp, raw });
  if (!raw || !Array.isArray(raw.models)) throw invalid('Codex 模型目录缺少 models 数组');
  return { file: catalogFile, models: raw.models, raw };
}

function state(file, { current, providers, routerURL, routerToken, slots = [] }) {
  try {
    const { text, document, revision: version } = read(file);
    const provider = document.get('model_provider') || 'openai';
    const value = key => document.get('model_providers', provider, key);
    const base = value('base_url') || '';
    const wire = value('wire_api') || 'responses';
    const token = value('experimental_bearer_token');
    const warnings = [];
    const router = [routerURL, routerURL + '/v1'].includes(base.replace(/\/+$/, ''));
    const selected = providers.find(item => item.id === current);
    const matches = current === '@router'
      ? router && wire === 'responses' && token === routerToken && value('requires_openai_auth') !== true && !value('env_key')
      : !!selected && wire === 'responses' && base.replace(/\/+$/, '') === baseURL(selected.base_url) && token === selected.api_key;
    let modelCatalog = { file: '', models: [] };
    try { modelCatalog = catalog(file, document); } catch { warnings.push('本地模型目录无法读取；不会猜测模型能力'); }
    const model = document.get('model') || '';
    const review = document.get('review_model') || '';
    const describe = alias => {
      const slot = slots.find(item => item.alias === alias);
      const metadata = modelCatalog.models.find(item => item.slug === alias);
      const target = modelCatalog.models.find(item => item.slug === slot?.model);
      const managed = path.basename(modelCatalog.file) === 'mixrouter-model-catalog.json';
      const synchronized = !!metadata && (!slot || !managed || metadata.x_mixrouter?.target === slot.model);
      // 未知落点只注册选择器身份;不能把客户端回落能力当作渠道声明的能力。
      const capability = synchronized && metadata.x_mixrouter?.capabilities_known !== false ? metadata : null;
      return { configured: alias, target: slot?.model || alias, provider: slot?.provider_name || '',
        catalog_match: synchronized, capabilities_known: !!(capability || target), metadata_source: capability?.slug || target?.slug || '',
        context_window: capability?.context_window ?? target?.context_window ?? null,
        reasoning_levels: (capability || target)?.supported_reasoning_levels?.map(item => item.effort) || [],
        wire_api: providers.find(item => item.id === slot?.provider)?.wire_api || '',
        enabled: slot ? slot.enabled : !alias.startsWith('mixr-') };
    };
    const main = describe(model), reviewer = describe(review);
    for (const entry of [main, reviewer]) {
      if (!entry.configured) continue;
      if (entry.configured.startsWith('mixr-') && !entry.catalog_match) warnings.push(`${entry.configured} 未出现在本地模型目录；${entry.metadata_source ? '可同步已知落点的能力' : '落点能力未知，保留 Codex 默认能力'}`);
      else if (entry.configured.startsWith('mixr-') && !entry.capabilities_known) warnings.push(`${entry.configured} 已注册落点身份；模型能力未知，未声明窗口、推理档位或多模态能力`);
      if (!entry.enabled) warnings.push(`${entry.configured} 的渠道已停用或删除`);
      if (entry.wire_api === 'chat') warnings.push(`${entry.configured} 使用 Chat 转换；原生 web_search 和远端压缩不可用，普通函数、MCP 与自定义工具可转换`);
    }
    if (document.get('profile')) warnings.push('配置选择了 profile；本面板显示全局默认值，不覆盖 profile、项目配置或命令行参数');
    if (wire !== 'responses') warnings.push('此 Codex 客户端应使用 Responses 协议；Chat 渠道请通过本地路由转换');
    const effort = document.get('model_reasoning_effort') || '';
    if (effort && main.reasoning_levels.length && !main.reasoning_levels.includes(effort)) warnings.push(`当前落点的本地目录未声明推理档位 ${effort}，不会自动降档`);
    return { provider, model, review_model: review, base_url: base, wire_api: wire, router, match: matches,
      config_path: file, revision: version, model_reasoning_effort: effort,
      model_context_window: document.get('model_context_window') ?? null,
      model_auto_compact_token_limit: document.get('model_auto_compact_token_limit') ?? null,
      model_catalog_json: document.get('model_catalog_json') || '', main, reviewer, warnings,
      profile: document.get('profile') || '', config_present: !!text.trim() };
  } catch (error) {
    return { config_path: file, error: error.message, router: false, match: false, warnings: ['读取失败时禁止写入，不会以空配置覆盖原文件'] };
  }
}

// 未知模型不复制其它落点的指令、窗口、推理档位或多模态能力。
// 这些是目录选择器的最低客户端字段,不是上游能力声明。
function unknownModel(slot) {
  return { slug: slot.alias, display_name: slot.model, description: '模型能力未由渠道声明',
    default_reasoning_level: null, supported_reasoning_levels: [], shell_type: 'shell_command',
    visibility: 'list', supported_in_api: true, priority: 0, upgrade: null,
    base_instructions: '', supports_reasoning_summaries: false, support_verbosity: false,
    default_verbosity: null, apply_patch_tool_type: 'freeform', supports_parallel_tool_calls: false,
    truncation_policy: { mode: 'tokens', limit: 10000 }, input_modalities: ['text'], experimental_supported_tools: [] };
}

function prepareCatalog(file, document, slots) {
  const loaded = catalog(file, document);
  const managed = path.join(path.dirname(file), 'mixrouter-model-catalog.json');
  const sourceFile = path.join(path.dirname(file), 'mixrouter-model-catalog.source.json');
  if (loaded.file !== managed && fs.existsSync(managed) && !fs.existsSync(sourceFile)) throw invalid('目标模型目录已存在且未由 mixrouter 托管，未覆盖');
  let source = loaded.file ? loaded : { file: null, raw: { models: [] }, models: [] };
  let legacyModels = {};
  if (loaded.file === managed) {
    const metadata = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    if (metadata.legacy_models && typeof metadata.legacy_models === 'object' && !Array.isArray(metadata.legacy_models)) legacyModels = { ...metadata.legacy_models };
    const raw = metadata.source ? JSON.parse(fs.readFileSync(metadata.source, 'utf8')) : { models: [] };
    if (!Array.isArray(raw.models)) throw invalid('原始 Codex 模型目录无效，未同步');
    source = { file: metadata.source, raw, models: raw.models };
  }
  const aliases = [], unknown = [];
  for (const slot of slots.filter(item => item.provider && item.enabled && item.model)) {
    const model = source.models.find(item => item.slug === slot.model);
    if (!model) unknown.push(slot.alias);
    aliases.push({ ...(model || unknownModel(slot)), slug: slot.alias,
      display_name: `${slot.model} · ${slot.name}`, visibility: 'list', priority: aliases.length,
      x_mixrouter: { target: slot.model, capabilities_known: !!model } });
  }
  // 仅记录这份配置曾经使用的精确默认模型,用于仍持有旧默认的原生 Codex 会话。
  // 主/审查旧 ID 相同时只能确定主槽,不猜审查请求身份。
  for (const [key, name] of [['model', 'main'], ['review_model', 'reviewer']]) {
    const value = document.get(key);
    if (typeof value === 'string' && value && !value.startsWith('mixr-') &&
        slots.some(slot => slot.name === name) && !Object.hasOwn(legacyModels, value)) legacyModels[value] = 'mixr-' + name;
  }
  // 只留最近 32 个精确默认 ID;不记录会话、凭据或请求正文。
  legacyModels = Object.fromEntries(Object.entries(legacyModels).filter(([id, alias]) => id && /^mixr-(main|reviewer)$/.test(alias)).slice(-32));
  const names = new Set(aliases.map(item => item.slug));
  return { file: managed, sourceFile, source: source.file, legacyModels, unknown,
    content: JSON.stringify({ ...source.raw, models: [...source.models.filter(item => !names.has(item.slug))
      .map(item => ({ ...item, visibility: 'hide' })), ...aliases] }, null, 2) + '\n' };
}

module.exports = { quote, revision, parse, read, topLevel, patch, baseURL, state, prepareCatalog, invalid,
  MIXR_SECTION_RE, removeOwnSections, setTopLevel, providerSection };
