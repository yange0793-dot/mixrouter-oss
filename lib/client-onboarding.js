'use strict';
// 首次向导:把 Claude Code / Codex / ZCode 安全接到本机路由,并且可以逐字段撤销。
//
// 为什么单列一个模块而不是塞进 mixrouter.js:
//   · 它只做三件事——**只读检查**(inspect)、**预览**(preview,发一个短命令牌)、
//     **写后记账与撤销**(apply/undo)。真正的写入仍走主入口已有的切换函数
//     (switchRouter / applyClientSwitch),通过 applyRouter 注入,这里不复制第二份写逻辑。
//   · 撤销必须知道"这次到底改了哪几个受管字段、写前是什么",而不是整份文件覆盖。
//     账本落在运行数据目录的 client-managed.json(mode 0600),只含受管字段。
//
// 安全边界(缺一不可):
//   1) 预览与写入分离:preview 返回的令牌只活在内存,携带写前的受管字段快照;
//      令牌一次性、短命,apply/undo 必须显式 confirm:true。
//   2) 预览后文件被外部修改 → revision 不一致直接拒绝(409),不拿旧快照去写。
//   3) 撤销只还原"当前值仍等于当初写后值"的受管字段;任何一个字段被用户改过就整体拒绝,
//      并在错误里给出脱敏的冲突预览。绝不为了撤销去覆盖整份配置。
//   4) 预览/错误里不出现 Key 正文:密钥字段一律掩码,URL 里的凭据与查询串也去掉。
//   5) 读配置区分 missing / invalid / error:EACCES 是 error,不是 missing ——
//      把读不到当成"没有配置"会在下一步用空配置把用户文件整个盖掉。
//
// 本模块 require 时不读盘、不起服务;所有路径在调用时按注入的 env/home 现算。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { writeFileAtomic, writeJsonAtomic } = require('./atomic-write');
const { backupFile } = require('./config-backup');
const { runtimeDataDir, claudeSettings, codexConfig: codexConfigPath, zcodeConfig: zcodeConfigPath } = require('./paths');
const codexConfig = require('./codex-config');
const { planCodexSlots } = require('./codex-router-plan');
const zcodeConfig = require('./zcode-config');

const APPS = Object.freeze(['claude', 'codex', 'zcode']);
const BINARIES = Object.freeze({ claude: 'claude', codex: 'codex', zcode: 'zcode' });
const ROUTER_SECTION = 'mixr-router';
const ROUTER_ID = '@router';
const ZCODE_PROVIDER = 'mixrouter-managed';
const LEDGER_FILE = 'client-managed.json';
const LEDGER_VERSION = 1;

// 与 lib/routing/slots.js 的 CLAUDE_SLOTS / CLAUDE_SLOT_ENV 同值。这里不 require 它:
// 那个模块会拉进 provider 校验的一整条链,而本模块只需要五个 env 键名;值由测试对照。
const CLAUDE_SLOT_ENV = Object.freeze({
  main: 'ANTHROPIC_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  subagent: 'CLAUDE_CODE_SUBAGENT_MODEL',
});
const CODEX_TOP = Object.freeze(['model', 'model_provider', 'review_model', 'model_catalog_json']);
const CODEX_PROVIDER = Object.freeze(['name', 'base_url', 'wire_api', 'requires_openai_auth', 'experimental_bearer_token']);
const ZCODE_FIELDS = Object.freeze([
  ['name'], ['kind'], ['source'], ['enabled'],
  ['options', 'apiKey'], ['options', 'baseURL'], ['options', 'apiKeyRequired'],
  ['x-mixrouter'],
]);
const ZCODE_SECRET_PATHS = new Set(['options.apiKey']);
const SECRET_RE = /(api[-_]?key|token|secret|password|bearer)/i;
// 会被客户端读走、且优先级高于配置文件的全局变量名。只用来判"在不在",不读值、不回显值 ——
// 这几组里本身就装 Key。代理变量(HTTPS_PROXY 等)故意不在里面:那是出网通道,不是配置覆盖,
// 几乎每台机器都有,报出来只会把真正的问题淹掉。
const CLAUDE_ENV_OVERRIDES = Object.freeze([
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
]);
const CODEX_ENV_OVERRIDES = Object.freeze(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL']);
const ZCODE_ENV_OVERRIDES = Object.freeze(['ZCODE_API_KEY', 'ZCODE_BASE_URL', 'ZCODE_MODEL']);
const SAFE_ZCODE_VALUE = /^[^\u0000-\u001f\u007f]*$/;

const ABSENT = Symbol('absent');
const COMPLEX = Symbol('complex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isAbsent = value => value === ABSENT;
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const revisionOf = text => crypto.createHash('sha256').update(String(text)).digest('hex');

function fail(statusCode, message, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}
function assertApp(app) {
  if (!APPS.includes(app)) throw fail(400, '客户端必须是 claude、codex 或 zcode');
}
function fieldName(parts) {
  return parts.filter(part => typeof part === 'string').join('.');
}
// HTTP 出口只回 e.message(见 lib/http/console.js 的 catch),结构化 conflicts 会被丢掉。
// 所以把冲突字段名并进 message,至少让调用方知道是哪一个字段挡住了撤销。
function conflictMessage(prefix, conflicts) {
  const fields = conflicts.map(item => item && item.field).filter(Boolean);
  return fields.length ? `${prefix}（冲突字段：${[...new Set(fields)].slice(0, 8).join('、')}）` : prefix;
}
function stable(value) {
  if (isAbsent(value)) return '\u0000absent';
  if (value === COMPLEX) return '\u0000complex';
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (isObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const same = (a, b) => stable(a) === stable(b);

// —— 脱敏 -------------------------------------------------------------------
// 令牌/Key 只回掩码;URL 去掉 userinfo、查询串与片段,路径保留(用户要靠它区分渠道)。
function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '';
  return text.length > 8 ? '***' + text.slice(-4) : '***';
}
function publicUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    // 查询串与片段可能夹带凭据:预览里直接不显示,只保留 origin + pathname。
    return url.origin + url.pathname;
  } catch { return value; }
}
function redactDeep(value, keyHint = '') {
  if (isAbsent(value)) return null;
  if (value === COMPLEX) return '（复杂值，未预览）';
  if (typeof value === 'string') {
    if (SECRET_RE.test(keyHint) && !/required$/i.test(keyHint)) return maskSecret(value);
    return publicUrl(value);
  }
  if (Array.isArray(value)) return value.map(item => redactDeep(item, keyHint));
  if (isObject(value)) {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = redactDeep(inner, SECRET_RE.test(key) && !/required$/i.test(key) ? key : keyHint);
    }
    return out;
  }
  return value;
}

// —— 路径与文件读取 -----------------------------------------------------------
function configFileOf(env, home, app) {
  if (app === 'claude') return claudeSettings(env, home);
  if (app === 'codex') return codexConfigPath(env, home);
  return zcodeConfigPath(env, home);
}

// missing / invalid / error 三态必须分开。stat 不是 readFile:目录、FIFO、软链循环
// 都会在 readFileSync 之前暴露,避免把怪文件当空配置。
function readTextFile(file) {
  let stat;
  try { stat = fs.statSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', text: '', revision: null };
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { status: 'error', code: 'EACCES', error: '没有读取权限（EACCES），未做任何改动', revision: null };
    }
    return { status: 'error', code: error.code || 'EIO', error: '无法读取配置，未做任何改动', revision: null };
  }
  if (!stat.isFile()) {
    return { status: 'error', code: 'ENOTFILE', error: '配置路径不是普通文件，未做任何改动', revision: null };
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { status: 'error', code: 'EACCES', error: '没有读取权限（EACCES），未做任何改动', revision: null };
    }
    return { status: 'error', code: error.code || 'EIO', error: '无法读取配置，未做任何改动', revision: null };
  }
  return { status: 'ok', text, revision: revisionOf(text) };
}

function parseJsonObject(text) {
  const stripped = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  if (!stripped.trim()) return { value: {} };
  let value;
  try { value = JSON.parse(stripped); }
  catch { return { error: '配置不是合法 JSON，未做任何改动' }; }
  if (!isObject(value)) return { error: '配置必须是 JSON 对象，未做任何改动' };
  return { value };
}

function readClaude(env, home) {
  const file = configFileOf(env, home, 'claude');
  const read = readTextFile(file);
  if (read.status !== 'ok') return { ...read, file };
  const parsed = parseJsonObject(read.text);
  if (parsed.error) return { status: 'invalid', file, revision: read.revision, error: parsed.error };
  if (parsed.value.env !== undefined && !isObject(parsed.value.env)) {
    return { status: 'invalid', file, revision: read.revision, error: 'env 必须是 JSON 对象，未做任何改动' };
  }
  return { status: 'ok', file, text: read.text, revision: read.revision, doc: parsed.value };
}

function readCodex(env, home) {
  const file = configFileOf(env, home, 'codex');
  const read = readTextFile(file);
  if (read.status !== 'ok') return { ...read, file };
  try {
    const document = codexConfig.parse(read.text);
    return { status: 'ok', file, text: read.text, revision: read.revision, document, empty: !read.text.trim() };
  } catch (error) {
    return { status: 'invalid', file, revision: read.revision, error: 'Codex TOML 无法解析，未做任何改动' };
  }
}

function validateZcodeDoc(config) {
  if (!isObject(config)) return '配置必须是 JSON 对象，未做任何改动';
  if (config.provider !== undefined && !isObject(config.provider)) return 'provider 必须是 JSON 对象，未做任何改动';
  for (const provider of Object.values(config.provider || {})) {
    if (!isObject(provider) || (provider.options !== undefined && !isObject(provider.options)) ||
        (provider.models !== undefined && (!isObject(provider.models) || Object.values(provider.models).some(model => !isObject(model))))) {
      return 'provider/options/models 必须是 JSON 对象，未做任何改动';
    }
  }
  return '';
}

function readZcode(env, home) {
  const file = configFileOf(env, home, 'zcode');
  const read = readTextFile(file);
  if (read.status !== 'ok') return { ...read, file };
  const parsed = parseJsonObject(read.text);
  if (parsed.error) return { status: 'invalid', file, revision: read.revision, error: parsed.error };
  const problem = validateZcodeDoc(parsed.value);
  if (problem) return { status: 'invalid', file, revision: read.revision, error: problem };
  return { status: 'ok', file, text: read.text, revision: read.revision, doc: parsed.value };
}

function readConfig(env, home, app) {
  if (app === 'claude') return readClaude(env, home);
  if (app === 'codex') return readCodex(env, home);
  return readZcode(env, home);
}

// —— 安装检测(只读 PATH + 常见安装目录) ---------------------------------------
// 只看常规文件与 X_OK,不 spawn、不执行、不读 --version。
// 某个候选 EACCES 时记为 found 但不可执行,而不是"没装"——这两种情况用户要做的事完全不同。
//
// 为什么要额外查常见目录:本工具常驻在 launchd / systemd 下,PATH 往往是
// `/usr/bin:/bin:/usr/sbin:/sbin` 这种最小集合,而 Claude Code 官方安装器把可执行文件
// 放在 `~/.local/bin`。只查 PATH 的话,"已经装好、正在用"的客户端会被报成"未检测到",
// 用户被引导去重装。这里只做**只读探测**,找到就照实说明来源。
const COMMON_BIN_DIRS = Object.freeze([
  '.local/bin',        // Claude Code 官方安装器
  '.claude/local',     // 旧版 Claude Code 本地安装
  '.bun/bin',          // bun 安装的客户端
  '.npm-global/bin',   // 自定义 npm 前缀
  'bin',               // ~/bin
]);
const SYSTEM_BIN_DIRS = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']);

function probeBinary(candidate, name) {
  let stat;
  try { stat = fs.statSync(candidate); }
  catch (error) { return { denied: error.code === 'EACCES' || error.code === 'EPERM' }; }
  if (!stat.isFile()) return {};
  try { fs.accessSync(candidate, fs.constants.X_OK); }
  catch (error) { return { denied: error.code === 'EACCES' || error.code === 'EPERM' }; }
  return { hit: { name, found: true, executable: true, path: candidate } };
}

function findBinary(env, name, home) {
  const entries = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  let denied = '';
  const visited = new Set();
  const probe = dir => {
    if (!path.isAbsolute(dir) || visited.has(dir)) return null;
    visited.add(dir);
    const result = probeBinary(path.join(dir, name), name);
    if (result.denied) denied = denied || path.join(dir, name);
    return result.hit || null;
  };
  for (const dir of entries) {
    const hit = probe(dir);
    if (hit) return { ...hit, source: 'path' };
  }
  // PATH 里有同名文件但不可执行(EACCES):这是"要改权限",不是"没装"。
  // 不再去别的目录找同名副本 —— 同名但不同来源的程序算另一份安装,把它的可执行状态
  // 报上来会盖掉真正要用户处理的那个问题。
  if (denied) return { name, found: true, executable: false, path: denied, error: 'EACCES' };
  // PATH 里完全没有:再查常见安装目录。来源单独标出来,界面据此说明"是从固定目录找到的",
  // 而不是假装它就在服务的 PATH 里。
  const extra = [];
  if (typeof home === 'string' && home) for (const rel of COMMON_BIN_DIRS) extra.push(path.join(home, rel));
  extra.push(...SYSTEM_BIN_DIRS);
  for (const dir of extra) {
    const hit = probe(dir);
    if (hit) return { ...hit, source: 'known-dir' };
  }
  return { name, found: false, executable: false, path: '' };
}

// —— Codex TOML 取值 ---------------------------------------------------------
function findCodexEntry(document, parts) {
  return document.entries.find(entry => entry.parts.length === parts.length &&
    entry.parts.every((part, index) => part === parts[index])) || null;
}
function codexValue(document, parts) {
  const entry = findCodexEntry(document, parts);
  if (!entry) return ABSENT;
  return entry.value === undefined ? COMPLEX : entry.value;
}
function codexSectionExists(document, section) {
  return document.sections.some(table => table.parts.length === 2 && table.parts[0] === 'model_providers' && table.parts[1] === section);
}
function codexSectionState(document, section) {
  if (!codexSectionExists(document, section)) return { exists: false };
  const fields = {};
  let extra = false;
  let nested = false;
  for (const entry of document.entries) {
    if (entry.parts[0] !== 'model_providers' || entry.parts[1] !== section) continue;
    if (entry.parts.length !== 3) { nested = true; continue; }
    if (!CODEX_PROVIDER.includes(entry.parts[2])) { extra = true; continue; }
    if (entry.value === undefined) { fields[entry.parts[2]] = COMPLEX; continue; }
    fields[entry.parts[2]] = entry.value;
  }
  for (const table of document.sections) {
    if (table.parts[0] === 'model_providers' && table.parts[1] === section && table.parts.length > 2) nested = true;
  }
  return { exists: true, fields, extra, nested };
}

// —— 受管字段快照 -------------------------------------------------------------
function claudeSnapshot(document, options) {
  const keys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];
  if (options.slots) keys.push(...Object.values(CLAUDE_SLOT_ENV));
  const values = {};
  const env = isObject(document.env) ? document.env : {};
  for (const key of [...new Set(keys)]) values[key] = hasOwn(env, key) ? env[key] : ABSENT;
  return values;
}

function codexSnapshot(document) {
  const top = {};
  for (const key of CODEX_TOP) top[key] = codexValue(document, [key]);
  const section = codexSectionState(document, ROUTER_SECTION);
  const provider = {};
  for (const key of CODEX_PROVIDER) provider[key] = section.exists && hasOwn(section.fields, key) ? section.fields[key] : ABSENT;
  return { top, section, provider };
}

function zcodeOwnProvider(document) {
  return isObject(document.provider) && hasOwn(document.provider, ZCODE_PROVIDER) ? document.provider[ZCODE_PROVIDER] : ABSENT;
}
function zcodeSnapshot(document) {
  const provider = zcodeOwnProvider(document);
  return { provider, mapBeforeAbsent: !hasOwn(document, 'provider') };
}

// —— 预期写入结果(纯计算,不落盘) ------------------------------------------
function expectedClaude(options, slots, before = {}) {
  const values = {
    ANTHROPIC_BASE_URL: options._routerURL,
    ANTHROPIC_AUTH_TOKEN: options._routerToken,
  };
  if (options.slots) {
    const list = Array.isArray(slots.claude) ? slots.claude : [];
    for (const [name, envKey] of Object.entries(CLAUDE_SLOT_ENV)) {
      const slot = list.find(item => item && item.name === name);
      if (slot && slot.provider) { values[envKey] = slot.alias || 'mixr-' + name; continue; }
      const current = hasOwn(before, envKey) ? before[envKey] : ABSENT;
      if (!isAbsent(current) && String(current).startsWith('mixr-')) values[envKey] = ABSENT;
      else if (!isAbsent(current)) values[envKey] = current;   // 用户手设的真实模型名不动
    }
  }
  return values;
}

function codexPort(routerURL) {
  const url = new URL(routerURL);
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

// 接入与预览共用纯槽位规划;文本仍由真正的 codexConfig.patch 计算。
// 普通接入自动补齐缺失槽,严格 slots:true 不补。目录路径固定,推理强度不受管。
function codexWriteArgs(options, slots, store) {
  const plan = planCodexSlots(slots.codex, store.codex, { strict: options.slots === true });
  return {
    top: { model: plan.model, model_provider: ROUTER_SECTION, review_model: plan.reviewModel,
      model_catalog_json: 'mixrouter-model-catalog.json' },
    bootstrap: plan.bootstrap,
    provider: {
      name: `mixrouter(经 :${codexPort(options._routerURL)} 路由)`,
      base_url: options._routerURL + '/v1',
      wire_api: 'responses',
      requires_openai_auth: false,
      experimental_bearer_token: options._routerToken,
    },
  };
}

// 用**真正的写入函数**(codexConfig.patch)在当前文本上算出"写完之后长什么样",
// 再和写前快照逐字段对比。这样预览的 after 就是 applyRouter 实际会写出来的值,
// 而不是另写一套预测逻辑去猜。
function planCodexAfter(snapshot, text, args) {
  let patched;
  try {
    patched = codexConfig.patch(text, { top: args.top, section: ROUTER_SECTION, provider: args.provider });
  } catch (error) {
    if (error && error.statusCode) throw error;
    throw fail(400, `Codex 配置无法安全改写：${error.message}`);
  }
  return codexSnapshot(codexConfig.parse(patched));
}

// zcode 的模型候选与 mixrouter.js 的 zcodeRouterSpec 同源:已启用、有 Key 的渠道,
// Chat 协议还要求该渠道本身是 chat。路由规则池里的独占模型这里看不到——预览会说明
// "以实际写入为准",apply 后的账本按**磁盘实际值**记录,不靠这份预测。
function wireOfProvider(provider, app) {
  if (app === 'claude') return provider && (provider.wire_api === 'responses' || provider.wire_api === 'chat') ? provider.wire_api : 'anthropic';
  return provider && provider.wire_api === 'chat' ? 'chat' : 'responses';
}
function zcodeModelsOf(provider) {
  return [...new Set([
    ...(Array.isArray(provider.models) ? provider.models : []), provider.model,
    ...Object.values(provider.slots || {}),
  ].filter(model => typeof model === 'string' && model.trim()).map(model => model.trim()))];
}
function expectedZcode(options, store) {
  const wire = options.wire_api || 'anthropic';
  if (!Object.hasOwn(zcodeConfig.KINDS, wire)) throw fail(400, 'wire_api 必须是 anthropic、responses 或 chat');
  const app = wire === 'anthropic' ? 'claude' : 'codex';
  const usable = provider => provider && provider.enabled !== false && provider.api_key &&
    (wire !== 'chat' || wireOfProvider(provider, app) === 'chat');
  const models = new Set((Array.isArray(store[app]) ? store[app] : []).filter(usable).flatMap(zcodeModelsOf));
  if (!models.size) throw fail(400, '对应协议没有已启用渠道的可用模型');
  const model = options.model === undefined ? [...models][0] : options.model;
  if (!models.has(model)) throw fail(400, 'model 不在对应协议的可用模型列表中');
  return {
    target: ROUTER_ID,
    base_url: zcodeConfig.baseURL(options._routerURL, wire),
    api_key: options._routerToken,
    wire_api: wire,
    models: [...models],
    model,
  };
}

function zcodeExpectedProvider(spec, old) {
  const kind = zcodeConfig.KINDS[spec.wire_api];
  const models = { ...(isObject(old?.models) ? old.models : {}) };
  const owned = new Set(Array.isArray(old?.['x-mixrouter']?.models) ? old['x-mixrouter'].models : []);
  for (const id of owned) if (!spec.models.includes(id)) delete models[id];
  for (const id of spec.models) models[id] = { ...(isObject(models[id]) ? models[id] : {}), name: `Mixrouter · ${id}` };
  return {
    ...(isObject(old) ? old : {}),
    name: 'Mixrouter',
    kind,
    source: 'custom',
    enabled: true,
    options: {
      ...(isObject(old?.options) ? old.options : {}),
      apiKey: spec.api_key,
      baseURL: spec.base_url,
      apiKeyRequired: true,
    },
    models,
    'x-mixrouter': {
      ...(isObject(old?.['x-mixrouter']) ? old['x-mixrouter'] : {}),
      owner: 'mixrouter', version: 1, target: spec.target,
      wire_api: spec.wire_api, model: spec.model, models: spec.models,
    },
  };
}

function zcodeOwns(provider) {
  return isObject(provider) && isObject(provider['x-mixrouter']) &&
    provider['x-mixrouter'].owner === 'mixrouter' && provider['x-mixrouter'].version === 1;
}

// 与 lib/zcode-config.js 的 writeConfig 同一组拒绝条件。预览先把它们跑一遍:
// 真实的写入会再拦一次(那是最后一道),但用户不该点完"确认"才看到 500。
function assertZcodeWritable(old, spec) {
  if (!isObject(old)) return;
  const models = isObject(old.models) ? old.models : {};
  const owned = new Set(Array.isArray(old['x-mixrouter']?.models) ? old['x-mixrouter'].models : []);
  const foreign = Object.keys(models).filter(id => !owned.has(id));
  if (foreign.length && (old.kind !== zcodeConfig.KINDS[spec.wire_api] ||
      old.options?.baseURL !== zcodeConfig.baseURL(spec.base_url, spec.wire_api) ||
      optionsKey(old) !== spec.api_key)) {
    throw fail(400, '自有 provider 中存在其它模型，拒绝改变其协议或上游');
  }
  for (const id of spec.models) {
    if (hasOwn(models, id) && !owned.has(id)) throw fail(400, '自有 provider 中模型 ID 已被其它配置占用，拒绝覆盖');
  }
}
const optionsKey = provider => (isObject(provider.options) ? provider.options.apiKey : undefined);

// —— 差异与账本条目 -----------------------------------------------------------
// 一条账本条目 = 一个受管字段的写前/写后。before_absent / after_absent 显式记录,
// 避免把"没有这个键"和"键值是 null"混为一谈(JSON 里 undefined 会被吞掉)。
function makeEntry(kind, parts, before, after, secret = false) {
  return {
    kind, path: [...parts], secret,
    before_absent: isAbsent(before), before: isAbsent(before) ? null : clone(before),
    after_absent: isAbsent(after), after: isAbsent(after) ? null : clone(after),
  };
}
function entriesForValues(kind, beforeValues, afterValues, secretKeys, prefix = [], splitKeys = false) {
  const out = [];
  const keys = new Set([...Object.keys(beforeValues), ...Object.keys(afterValues)]);
  for (const key of keys) {
    const before = hasOwn(beforeValues, key) ? beforeValues[key] : ABSENT;
    const after = hasOwn(afterValues, key) ? afterValues[key] : ABSENT;
    if (same(before, after)) continue;
    const parts = splitKeys ? key.split('.') : [key];
    out.push(makeEntry(kind, [...prefix, ...parts], before, after, !!secretKeys[key]));
  }
  return out;
}

function publicEntry(entry) {
  return {
    field: fieldName(entry.path),
    before: redactDeep(entry.before_absent ? ABSENT : entry.before, fieldName(entry.path)),
    after: redactDeep(entry.after_absent ? ABSENT : entry.after, fieldName(entry.path)),
    secret: !!entry.secret,
  };
}
function publicEntries(entries) {
  const out = [];
  for (const entry of entries) {
    if (entry.kind === 'codex-section') {
      const fields = isObject(entry.after) && isObject(entry.after.fields) ? entry.after.fields : {};
      for (const key of CODEX_PROVIDER) {
        out.push({
          field: `model_providers.${ROUTER_SECTION}.${key}`,
          before: null,
          after: redactDeep(hasOwn(fields, key) ? fields[key] : ABSENT, key),
          secret: key === 'experimental_bearer_token',
        });
      }
      continue;
    }
    out.push(publicEntry(entry));
  }
  return out;
}

// 账本字段路径的禁用键(与 lib/provider-import.js 的 FORBIDDEN_KEYS 同一组)。
const FORBIDDEN_PART = new Set(['__proto__', 'prototype', 'constructor']);
function assertSafeParts(parts) {
  if (parts.some(part => FORBIDDEN_PART.has(part))) throw fail(500, '撤销账本包含非法字段路径，未做任何改动');
}

// —— 令牌(只在内存) ----------------------------------------------------------
function createClientOnboarding(options = {}) {
  const {
    env = process.env,
    home = os.homedir(),
    root,
    routerURL,
    routerToken,
    getStore = () => ({ claude: [], codex: [] }),
    getSlots = () => ({ claude: [], codex: [] }),
    applyRouter,
    tokenTtlMs = 5 * 60 * 1000,
    now = () => Date.now(),
  } = options;

  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError(`createClientOnboarding: root 必须是绝对路径，实得 ${JSON.stringify(root)}`);
  }
  if (typeof home !== 'string' || !path.isAbsolute(home)) {
    throw new TypeError(`createClientOnboarding: home 必须是绝对路径，实得 ${JSON.stringify(home)}`);
  }
  if (typeof routerURL !== 'string' || !/^https?:\/\//.test(routerURL)) {
    throw new TypeError('createClientOnboarding: routerURL 必须是 http(s) 地址');
  }
  if (typeof routerToken !== 'string' || !routerToken || /[\u0000-\u001f\u007f]/.test(routerToken)) {
    throw new TypeError('createClientOnboarding: routerToken 必须是非空、无控制字符的字符串');
  }
  if (typeof getStore !== 'function' || typeof getSlots !== 'function') {
    throw new TypeError('createClientOnboarding: getStore / getSlots 必须是函数');
  }
  const baseURL = routerURL.replace(/\/+$/, '');
  const ttl = Math.max(30 * 1000, Math.min(15 * 60 * 1000, Number(tokenTtlMs) || 0));
  const tokens = new Map();
  const ledgerFile = () => path.join(runtimeDataDir(env, root), LEDGER_FILE);

  function pruneTokens() {
    const at = now();
    for (const [token, record] of tokens) if (record.expiresAt <= at) tokens.delete(token);
    while (tokens.size >= 64) tokens.delete(tokens.keys().next().value);
  }
  // 完整文件级恢复**不**在这里做:它一直是 `mixctl restore <备份名>` 的职责(有自己的
  // 校验与 --dry-run/--yes 两段确认)。向导只做按字段撤销,所以两者各自出现在响应里,
  // 用户不会把"撤掉这次写入"误当成"恢复整份配置"。
  function recoveryHint(file) {
    return {
      field_undo: '只还原本次受管字段；用户后来改的其它字段不受影响',
      full_restore: `整份配置恢复请用现有命令：mixctl restore <备份名> --file ${file}`,
      note: '两者互相独立：撤销失败或冲突时，可用写入前自动生成的 .bak-mixui-* 备份做整份恢复',
    };
  }

  function issueToken(action, app, payload) {
    pruneTokens();
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = now() + ttl;
    tokens.set(token, { action, app, expiresAt, ...payload });
    return { token, expires_at: new Date(expiresAt).toISOString() };
  }
  function consumeToken(token, action, app) {
    if (typeof token !== 'string' || !token) throw fail(400, '缺少预览令牌，请先预览');
    const record = tokens.get(token);
    if (!record) throw fail(400, '预览令牌无效或已使用，请重新预览');
    tokens.delete(token);
    if (record.action !== action || record.app !== app) throw fail(400, '预览令牌与本次操作不匹配');
    if (record.expiresAt <= now()) throw fail(400, '预览已过期，请重新预览');
    return record;
  }

  function sanitizeOptions(app, input) {
    if (input === undefined || input === null) return {};
    if (!isObject(input)) throw fail(400, 'options 必须是 JSON 对象');
    if (app === 'claude' || app === 'codex') {
      const out = {};
      if (input.slots !== undefined) {
        if (typeof input.slots !== 'boolean') throw fail(400, 'slots 必须是布尔值');
        if (input.slots) out.slots = true;
      }
      return out;
    }
    const out = {};
    if (input.wire_api !== undefined) {
      if (typeof input.wire_api !== 'string' || !Object.hasOwn(zcodeConfig.KINDS, input.wire_api)) {
        throw fail(400, 'wire_api 必须是 anthropic、responses 或 chat');
      }
      out.wire_api = input.wire_api;
    }
    if (input.model !== undefined) {
      if (typeof input.model !== 'string' || !SAFE_ZCODE_VALUE.test(input.model) || input.model.length > 256) {
        throw fail(400, 'model 必须是无控制字符的字符串');
      }
      // 空串 = 没选模型(控制台在未选时就会发 ''),按"用可用模型里的第一个"处理,
      // 与 mixrouter.js 的 zcodeRouterSpec 默认一致 —— 不是"必须给我一个模型名"。
      if (input.model.trim()) out.model = input.model.trim();
    }
    return out;
  }

  // —— inspect ---------------------------------------------------------------
  function inspect(app) {
    assertApp(app);
    const binary = findBinary(env, BINARIES[app], home);
    const config = readConfig(env, home, app);
    // routed 恒为布尔:配置读不出来时它不是"已路由",UI 不必分三种形状判断。
    const result = {
      app,
      binary,
      routed: false,
      config: { path: config.file, status: config.status },
    };
    if (config.revision) result.config.revision = config.revision;
    if (config.status !== 'ok' && config.error) result.config.error = config.error;
    if (config.status !== 'ok' && config.code) result.config.code = config.code;
    if (config.status === 'ok') {
      if (app === 'claude') {
        const base = isObject(config.doc.env) && typeof config.doc.env.ANTHROPIC_BASE_URL === 'string'
          ? config.doc.env.ANTHROPIC_BASE_URL.replace(/\/+$/, '') : '';
        result.routed = base === baseURL;
      } else if (app === 'codex') {
        const provider = codexValue(config.document, ['model_provider']);
        result.routed = provider === ROUTER_SECTION;
      } else {
        const provider = zcodeOwnProvider(config.doc);
        let routed = false;
        if (provider !== ABSENT && zcodeOwns(provider)) {
          const wire = Object.keys(zcodeConfig.KINDS).find(key => zcodeConfig.KINDS[key] === provider.kind);
          try { routed = !!wire && provider.options?.baseURL === zcodeConfig.baseURL(baseURL, wire); } catch {}
        }
        result.routed = routed;
      }
    }
    if (app === 'codex') {
      try {
        if (config.status === 'invalid' || config.status === 'error') throw fail(400, config.error);
        if (config.status === 'ok' && codexValue(config.document, ['profile']) !== ABSENT &&
            codexValue(config.document, ['profile'])) throw fail(400, '当前选择了 Codex profile，请先确认 profile 配置');
        const plan = planCodexSlots(safeGetSlots().codex, safeGetStore().codex);
        result.codex_plan = { ok: true, model: plan.model, reviewModel: plan.reviewModel, bootstrap: plan.bootstrap,
          slots: plan.slots.map(slot => ({ name: slot.name, alias: slot.alias, provider: slot.provider,
            provider_name: slot.provider_name || '', model: slot.model, enabled: slot.enabled !== false })) };
      } catch (error) {
        result.codex_plan = { ok: false, error: error.message };
      }
    }
    return result;
  }

  // —— preview ---------------------------------------------------------------
  function preview(app, input) {
    assertApp(app);
    const userOptions = sanitizeOptions(app, input);
    const options = { ...userOptions, _routerURL: baseURL, _routerToken: routerToken };
    const config = readConfig(env, home, app);
    if (config.status === 'invalid') throw fail(400, config.error);
    // 读不到(权限/不是普通文件)一律 403:这不是"配置为空",更不能继续写入。
    if (config.status === 'error') throw fail(403, config.error);

    const warnings = [];
    warnings.push(...globalEnvWarnings(app));
    let entries;
    let tokenPayload;
    let store;

    if (app === 'claude') {
      const before = config.status === 'ok' ? claudeSnapshot(config.doc, userOptions) : claudeSnapshot({}, userOptions);
      const after = expectedClaude(options, safeGetSlots(), before);
      const secretKeys = {
        ANTHROPIC_AUTH_TOKEN: true, ANTHROPIC_BASE_URL: false,
        ...Object.fromEntries(Object.values(CLAUDE_SLOT_ENV).map(key => [key, false])),
      };
      entries = entriesForValues('claude-env', before, after, secretKeys, ['env']);
      tokenPayload = { options: userOptions, before, beforeRevision: config.revision, planRevision: planRevision() };
    } else if (app === 'codex') {
      const profile = config.status === 'ok' ? codexValue(config.document, ['profile']) : ABSENT;
      if (profile !== ABSENT && profile) {
        throw fail(400, '当前选择了 Codex profile，请先确认 profile 配置；未预览也不会写入');
      }
      if (config.status === 'ok' && config.document) {
        const others = config.document.sections.filter(table => table.parts[0] === 'model_providers' &&
          typeof table.parts[1] === 'string' && table.parts[1].startsWith('mixr-') && table.parts[1] !== ROUTER_SECTION);
        if (others.length) warnings.push('写入时会清理其它 mixr-* provider 段；撤销只恢复本次受管字段，不会恢复它们');
      }
      warnings.push('模型目录由写入时生成；撤销只还原 model_catalog_json 字段，不删除目录文件');
      store = safeGetStore();
      const slots = safeGetSlots();
      const snapshot = config.status === 'ok' ? codexSnapshot(config.document) : codexSnapshot({ entries: [], sections: [] });
      const args = codexWriteArgs(options, slots, store);
      if (args.bootstrap.length) {
        warnings.push(`接入时将自动补齐 Codex 槽位：${args.bootstrap.join(' / ')}；撤销客户端字段不删除这些槽位`);
      }
      // 预览的 after 由真正的写入函数算出来(见 planCodexAfter),不是另一套预测。
      const after = planCodexAfter(snapshot, config.status === 'ok' ? config.text : '', args);
      entries = [];
      for (const key of CODEX_TOP) {
        const before = snapshot.top[key];
        const next = after.top[key];
        // 两边都是同一个复杂值 = 本次不动它,可以跳过;只有真需要改写时才拒绝。
        if (before === COMPLEX && next === COMPLEX) continue;
        if (before === COMPLEX || next === COMPLEX) throw fail(400, `顶层 ${key} 是复杂 TOML 值，无法安全改写`);
        if (same(before, next)) continue;
        entries.push(makeEntry('codex-top', [key], before, next, false));
      }
      if (!snapshot.section.exists) {
        entries.push(makeEntry('codex-section', ['model_providers', ROUTER_SECTION], ABSENT, { fields: clone(after.provider) }, false));
      } else {
        for (const key of CODEX_PROVIDER) {
          const before = snapshot.provider[key];
          const next = after.provider[key];
          if (before === COMPLEX) throw fail(400, `provider ${key} 是复杂 TOML 值，无法安全改写`);
          if (same(before, next)) continue;
          entries.push(makeEntry('codex-provider', [ROUTER_SECTION, key], before, next, key === 'experimental_bearer_token'));
        }
      }
      tokenPayload = { options: userOptions, snapshot, beforeRevision: config.revision, planRevision: planRevision() };
    } else {
      store = safeGetStore();
      const spec = expectedZcode(options, store);
      const before = config.status === 'ok' ? zcodeSnapshot(config.doc) : zcodeSnapshot({});
      const old = before.provider === ABSENT ? undefined : before.provider;
      if (old !== undefined && !zcodeOwns(old)) {
        throw fail(400, 'ZCode provider ID mixrouter-managed 已被非本集成占用，拒绝覆盖');
      }
      assertZcodeWritable(old, spec);
      const after = zcodeExpectedProvider(spec, old);
      const secretKeys = Object.fromEntries([...ZCODE_SECRET_PATHS].map(key => [key, true]));
      if (old === undefined) {
        entries = [makeEntry('zcode-provider', ['provider', ZCODE_PROVIDER], ABSENT, after, false)];
      } else {
        entries = [
          ...entriesForValues('zcode-field', flattenZcode(old), flattenZcode(after), secretKeys,
            ['provider', ZCODE_PROVIDER], true),
          ...zcodeModelEntries(old, after),
        ];
      }
      // 预览的模型列表只按渠道库算。真实写入还会带上路由规则池里的独占模型,
      // 所以这里如实说明"以实际写入为准",而不是假装预览就是完整清单。
      warnings.push('模型列表按渠道库预览;路由规则池里的独占模型以实际写入为准（账本仍记录磁盘实际值）');
      tokenPayload = { options: userOptions, snapshot: before, beforeRevision: config.revision, planRevision: planRevision() };
    }

    // 账本读不出来(损坏/无权限)在这里就暴露,而不是等写入成功之后才发现记不了账。
    // 已有记录则如实说明:撤销点会被这一次覆盖,只能撤到"本次接入之前"。
    const existing = readLedger();
    if (hasOwn(existing.apps, app)) {
      warnings.push('已有上次写入的撤销记录；本次接入成功后，撤销只会回到本次接入前的状态');
    }

    const issued = issueToken('apply', app, tokenPayload);
    return {
      ok: true,
      app,
      action: 'apply',
      config: { path: config.file, status: config.status, revision: config.revision || null },
      token: issued.token,
      expires_at: issued.expires_at,
      changes: publicEntries(entries),
      warnings,
      recovery: recoveryHint(config.file),
    };
  }

  function safeGetStore() {
    const value = getStore();
    if (!isObject(value)) return { claude: [], codex: [] };
    return { claude: Array.isArray(value.claude) ? value.claude : [], codex: Array.isArray(value.codex) ? value.codex : [] };
  }
  // getSlots 的契约:优先 `slotsPublic()` 的公开数组({claude:[{name,alias,provider,model,enabled}], codex:[…]})。
  // 但主入口也传过 slotMap 原始对象({claude:{main:{provider,model}}, codex:{}})。两种形状在这里
  // 归一,免得"哪一边没改"变成一次静默的槽位漏写。
  // slotMap 形状里没有 alias/model/enabled —— 按 slotsPublic 的同一条规则补齐:
  // model 缺省取渠道自己的模型,enabled 由渠道是否启用决定。不补的话 raw slotMap 会被当成
  // "槽位没有模型名"而误拒,而那正是主入口现在的传法。
  function safeGetSlots() {
    const value = getSlots();
    if (!isObject(value)) return { claude: [], codex: [] };
    const { claude: claudeStore, codex: codexStore } = safeGetStore();
    const normalize = (raw, app) => {
      const store = app === 'codex' ? codexStore : claudeStore;
      const providerOf = id => store.find(item => item && item.id === id) || null;
      if (Array.isArray(raw)) {
        return raw.filter(item => isObject(item) && (item.name || item.alias)).map(slot => {
          const provider = slot.provider ? providerOf(slot.provider) : null;
          const name = slot.name || slot.alias;
          const model = slot.model || (provider ? (app === 'codex' ? (provider.model || '')
            : (Array.isArray(provider.models) && provider.models[0]) || '') : '');
          return {
            ...slot, name, alias: slot.alias || 'mixr-' + name, model,
            enabled: slot.enabled !== false && !!provider && provider.enabled !== false,
          };
        });
      }
      if (!isObject(raw)) return [];
      return Object.entries(raw).filter(([, slot]) => isObject(slot)).map(([name, slot]) => {
        const provider = slot.provider ? providerOf(slot.provider) : null;
        const model = slot.model || (provider ? (app === 'codex' ? (provider.model || '')
          : (Array.isArray(provider.models) && provider.models[0]) || '') : '');
        return {
          ...slot, name, alias: slot.alias || 'mixr-' + name, model,
          enabled: slot.enabled !== false && !!provider && provider.enabled !== false,
        };
      }).filter(slot => app === 'codex' || slot.provider);
    };
    return { claude: normalize(value.claude, 'claude'), codex: normalize(value.codex, 'codex') };
  }

  // —— 全局环境变量覆盖提示 ------------------------------------------------------
  // 用户 shell 里 export 的 ANTHROPIC_* / OPENAI_* 优先级高于配置文件,写进 settings.json /
  // config.toml 的路由地址会被它们盖掉 —— 界面上"已接入",实际请求却直连别处。
  // 只能报**变量名在不在**(present / 非空),值一律不出现在返回值里:这些变量本身就装 Key。
  function globalEnvWarnings(app) {
    const check = (names, where) => {
      const hits = names.filter(name => typeof env[name] === 'string' && env[name] !== '');
      if (!hits.length) return '';
      return `${where}：环境变量 ${hits.join('、')} 已设置，优先级高于配置文件，写入后可能不生效；请在自己的 shell 里确认或取消`;
    };
    const out = [];
    if (app === 'claude') {
      const line = check(CLAUDE_ENV_OVERRIDES, 'Claude Code');
      if (line) out.push(line);
    } else if (app === 'codex') {
      const line = check(CODEX_ENV_OVERRIDES, 'Codex');
      if (line) out.push(line);
    } else {
      const line = check(ZCODE_ENV_OVERRIDES, 'ZCode');
      if (line) out.push(line);
    }
    return out;
  }

  // 渠道库 + 槽位表的指纹。预览的 after 值(Codex 兜底模型、catalog、slot 别名)是从这两份里
  // 推出来的;它们在预览之后变了,写出来的东西就和给用户看过的不一样 —— 那种"看起来一样、
  // 实际不一样"只能靠在这里拒绝来避免。
  function planRevision() {
    const store = safeGetStore(), slots = safeGetSlots();
    return revisionOf(JSON.stringify({
      claude: store.claude.map(planProvider).sort(planSort),
      codex: store.codex.map(planProvider).sort(planSort),
      slots: {
        claude: slots.claude.map(planSlot).sort(planSort),
        codex: slots.codex.map(planSlot).sort(planSort),
      },
    }));
  }
  // 只取影响预览结论的字段:改备注、改 Key 标签不该让预览失效,改模型/启用/上游/槽位绑定才该。
  function planProvider(provider) {
    if (!isObject(provider)) return {};
    const fields = {
      id: provider.id, enabled: provider.enabled !== false, models: provider.models,
      model: provider.model, wire_api: provider.wire_api, base_url: provider.base_url,
      slots: provider.slots, direct: provider.direct === true,
      // 出站代理会改变这次接入能不能真的走通,和 direct 同一档:改了它,旧预览就该失效。
      proxy_url: provider.proxy_url || '',
    };
    const key = typeof provider.api_key === 'string' ? provider.api_key : '';
    const keys = Array.isArray(provider.keys) ? provider.keys.map(item => (item && item.key) || '') : [];
    const active = typeof provider.active_key === 'string' ? provider.active_key : '';
    fields.key = revisionOf([key, ...keys, active].join('\u0000'));
    return fields;
  }
  function planSlot(slot) {
    if (!isObject(slot)) return {};
    return {
      name: slot.name, alias: slot.alias, provider: slot.provider, model: slot.model,
      enabled: slot.enabled !== false, strategy: slot.strategy,
      pool: Array.isArray(slot.pool) ? slot.pool : [], dropTools: Array.isArray(slot.dropTools) ? slot.dropTools : [],
    };
  }
  function planSort(a, b) { return String(a.name || a.id || '').localeCompare(String(b.name || b.id || '')); }

  // —— apply -----------------------------------------------------------------
  function apply(app, request = {}) {
    assertApp(app);
    if (!isObject(request) || request.confirm !== true) throw fail(400, '接入前需要显式确认（confirm: true）');
    if (typeof applyRouter !== 'function') throw fail(500, '未注入 applyRouter，无法写入客户端配置');
    const record = consumeToken(request.token, 'apply', app);

    const config = readConfig(env, home, app);
    if (config.status === 'invalid') throw fail(400, config.error);
    if (config.status === 'error') throw fail(403, config.error);
    if ((config.revision || null) !== (record.beforeRevision || null)) {
      throw fail(409, '配置在预览后被修改，接入已中止；请重新预览');
    }
    // Codex 的兜底模型 / catalog、Claude 的槽位 env、ZCode 的模型清单都是从渠道库与槽位表
    // 推出来的。这两份在预览后变了,写出去的东西就和给用户看过的 after 不一致 ——
    // 令牌里记着预览那一刻的指纹,对不上就整体拒绝,不写半份。
    if (record.planRevision && planRevision() !== record.planRevision) {
      throw fail(409, '渠道库或槽位在预览后发生变化，实际写入会与预览不一致；请重新预览');
    }

    let result;
    try {
      result = applyRouter(app, { ...record.options, revision: record.beforeRevision || undefined });
    } catch (error) { throw error; }
    // applyRouter 必须是同步完成的:后面要立刻读磁盘记"写后值"。异步写入会让账本记到
    // 还没写完的那一刻,撤销基准就错了 —— 与其悄悄记错,不如当场说清楚。
    if (result && typeof result.then === 'function') {
      throw fail(500, 'applyRouter 必须同步完成写入；本次未记录撤销账本，请检查客户端配置与备份', { applied: true });
    }

    const after = readConfig(env, home, app);
    if (after.status !== 'ok') {
      throw fail(500, '客户端配置已写入，但写入后无法读取；未记录撤销账本，请检查客户端配置与备份', { applied: true });
    }

    let entries;
    if (app === 'claude') {
      const before = record.before;
      const afterValues = claudeSnapshot(after.doc, record.options);
      entries = entriesForValues('claude-env', before, afterValues,
        { ANTHROPIC_AUTH_TOKEN: true }, ['env']);
    } else if (app === 'codex') {
      const before = record.snapshot;
      const current = codexSnapshot(after.document);
      entries = [];
      for (const key of CODEX_TOP) {
        if (same(before.top[key], current.top[key])) continue;
        if (before.top[key] === COMPLEX || current.top[key] === COMPLEX) {
          throw fail(500, '写入后受管字段变成复杂 TOML 值，账本未记录；请检查客户端配置与备份', { applied: true });
        }
        entries.push(makeEntry('codex-top', [key], before.top[key], current.top[key], false));
      }
      if (!before.section.exists && current.section.exists) {
        entries.push(makeEntry('codex-section', ['model_providers', ROUTER_SECTION], ABSENT,
          { fields: clone(current.section.fields) }, false));
      } else if (before.section.exists && current.section.exists) {
        for (const key of CODEX_PROVIDER) {
          if (same(before.provider[key], current.provider[key])) continue;
          if (before.provider[key] === COMPLEX || current.provider[key] === COMPLEX) {
            throw fail(500, '写入后受管字段变成复杂 TOML 值，账本未记录；请检查客户端配置与备份', { applied: true });
          }
          entries.push(makeEntry('codex-provider', [ROUTER_SECTION, key], before.provider[key],
            current.provider[key], key === 'experimental_bearer_token'));
        }
      } else if (before.section.exists && !current.section.exists) {
        throw fail(500, '写入后自有 provider 段消失，账本未记录；请检查客户端配置与备份', { applied: true });
      }
    } else {
      const before = record.snapshot;
      const current = zcodeSnapshot(after.doc);
      if (before.provider === ABSENT && current.provider !== ABSENT) {
        entries = [makeEntry('zcode-provider', ['provider', ZCODE_PROVIDER], ABSENT, current.provider, false)];
        entries[0].map_before_absent = before.mapBeforeAbsent;
      } else if (before.provider !== ABSENT && current.provider !== ABSENT) {
        const beforeValues = flattenZcode(before.provider);
        const afterValues = flattenZcode(current.provider);
        entries = entriesForValues('zcode-field', beforeValues, afterValues,
          Object.fromEntries([...ZCODE_SECRET_PATHS].map(key => [key, true])),
          ['provider', ZCODE_PROVIDER], true);
        // 模型 ID 是动态键:entriesForValues 只比了固定字段,这里补模型叶子。
        entries.push(...zcodeModelEntries(before.provider, current.provider));
        entries = entries.filter((entry, index, all) => all.findIndex(other => other.kind === entry.kind && stable(other.path) === stable(entry.path)) === index);
      } else if (before.provider !== ABSENT && current.provider === ABSENT) {
        throw fail(500, '写入后未找到自有 ZCode provider，账本未记录；请检查客户端配置与备份', { applied: true });
      } else {
        entries = [];
      }
    }

    if (entries.length) {
      try {
        saveLedger(app, {
          app,
          file: after.file,
          mode: 'router',
          applied_at: new Date(now()).toISOString(),
          revision_before: record.beforeRevision || null,
          revision_after: after.revision,
          entries,
        });
      } catch (error) {
        // 客户端已经写入成功,但账本没落下:这句必须说清"已经写了",否则用户会以为没生效。
        throw fail(500, `客户端配置已按路由模式写入，但撤销账本保存失败（${error.message}）；可用写入前的 .bak-mixui-* 备份恢复`, { applied: true });
      }
    }
    return {
      ok: true,
      app,
      changed: publicEntries(entries),
      ledger_saved: entries.length > 0,
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
      recovery: recoveryHint(after.file),
    };
  }

  function flattenZcode(provider) {
    const values = {};
    for (const parts of ZCODE_FIELDS) {
      let value = provider;
      let present = true;
      for (const part of parts) {
        if (!isObject(value) || !hasOwn(value, part)) { present = false; break; }
        value = value[part];
      }
      values[parts.join('.')] = present ? value : ABSENT;
    }
    return values;
  }
  function zcodeModelEntries(before, after) {
    const models = new Set([
      ...(isObject(before?.models) ? Object.keys(before.models) : []),
      ...(isObject(after?.models) ? Object.keys(after.models) : []),
    ]);
    const out = [];
    for (const id of models) {
      const hasBefore = isObject(before?.models) && hasOwn(before.models, id);
      const hasAfter = isObject(after?.models) && hasOwn(after.models, id);
      const beforeValue = hasBefore ? before.models[id] : ABSENT;
      const afterValue = hasAfter ? after.models[id] : ABSENT;
      if (same(beforeValue, afterValue)) continue;
      out.push(makeEntry('zcode-model', ['provider', ZCODE_PROVIDER, 'models', id], beforeValue, afterValue, false));
    }
    return out;
  }
  // —— 账本 -----------------------------------------------------------------
  function ledgerPath() { return ledgerFile(); }
  function readLedger() {
    const file = ledgerFile();
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: LEDGER_VERSION, apps: {} };
      if (error.code === 'EACCES' || error.code === 'EPERM') throw fail(403, '没有读取撤销账本的权限，未做任何改动');
      throw fail(500, '无法读取撤销账本，未做任何改动');
    }
    let value;
    try { value = JSON.parse(text); }
    catch { throw fail(500, '撤销账本不是合法 JSON，未做任何改动'); }
    if (!isObject(value) || !isObject(value.apps)) throw fail(500, '撤销账本格式无效，未做任何改动');
    for (const record of Object.values(value.apps)) {
      if (!isObject(record) || !Array.isArray(record.entries) || !APPS.includes(record.app)) {
        throw fail(500, '撤销账本条目无效，未做任何改动');
      }
      for (const entry of record.entries) {
        const kinds = ['claude-env', 'codex-top', 'codex-provider', 'codex-section', 'zcode-provider', 'zcode-field', 'zcode-model'];
        if (!isObject(entry) || !kinds.includes(entry.kind) || !Array.isArray(entry.path) ||
            entry.path.some(part => typeof part !== 'string' || !part || FORBIDDEN_PART.has(part))) {
          throw fail(500, '撤销账本条目无效，未做任何改动');
        }
      }
    }
    return value;
  }
  function saveLedger(app, record) {
    const ledger = readLedger();
    ledger.version = LEDGER_VERSION;
    ledger.apps = { ...ledger.apps, [app]: record };
    const file = ledgerFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, ledger, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
  }
  function removeLedger(app) {
    const ledger = readLedger();
    if (!hasOwn(ledger.apps, app)) return;
    const next = { ...ledger, apps: { ...ledger.apps } };
    delete next.apps[app];
    const file = ledgerFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, next, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
  }

  // —— 撤销:冲突判定 --------------------------------------------------------
  function currentCodexValue(document, entry) {
    if (entry.kind === 'codex-top') return codexValue(document, [entry.path[0]]);
    if (entry.kind === 'codex-provider') {
      const state = codexSectionState(document, ROUTER_SECTION);
      if (!state.exists) return ABSENT;
      return hasOwn(state.fields, entry.path[1]) ? state.fields[entry.path[1]] : ABSENT;
    }
    return ABSENT;
  }
  function conflictFor(entry, current) {
    const expected = entry.after_absent ? ABSENT : entry.after;
    if (same(current, expected)) return null;
    return {
      field: fieldName(entry.path),
      current: redactDeep(current, fieldName(entry.path)),
      expected: redactDeep(expected, fieldName(entry.path)),
      restore: redactDeep(entry.before_absent ? ABSENT : entry.before, fieldName(entry.path)),
    };
  }
  function sectionConflicts(entry, config) {
    const state = codexSectionState(config.document, ROUTER_SECTION);
    const expected = isObject(entry.after) && isObject(entry.after.fields) ? entry.after.fields : {};
    if (!state.exists) {
      return [{ field: `model_providers.${ROUTER_SECTION}`, current: null, expected: redactDeep(expected), restore: null }];
    }
    const conflicts = [];
    if (state.extra || state.nested) {
      conflicts.push({ field: `model_providers.${ROUTER_SECTION}`, current: '（段内存在额外字段）', expected: redactDeep(expected), restore: null });
      return conflicts;
    }
    for (const key of CODEX_PROVIDER) {
      const current = hasOwn(state.fields, key) ? state.fields[key] : ABSENT;
      const wanted = hasOwn(expected, key) ? expected[key] : ABSENT;
      if (!same(current, wanted)) {
        conflicts.push({
          field: `model_providers.${ROUTER_SECTION}.${key}`,
          current: redactDeep(current, key),
          expected: redactDeep(wanted, key),
          restore: null,
        });
      }
    }
    if (!conflicts.length) {
      const table = config.document.sections.find(item => item.parts.length === 2 && item.parts[0] === 'model_providers' && item.parts[1] === ROUTER_SECTION);
      const end = config.document.sections[config.document.sections.indexOf(table) + 1]?.start ?? config.document.lines.length;
      // 顶层 model_provider 指向本段是正常的(撤销时会一起还原),不算"段外引用"。
      // 只有 profile 等其它位置也引用它时,直接删段才会把别人的配置弄坏。
      const topProvider = config.document.entries.find(entry => entry.parts.length === 1 && entry.parts[0] === 'model_provider');
      const outside = config.document.lines
        .filter((_, index) => (index < table.start || index >= end) && index !== topProvider?.index)
        .join('\n');
      if (outside.includes(ROUTER_SECTION)) {
        conflicts.push({ field: `model_providers.${ROUTER_SECTION}`, current: '（段外仍有引用）', expected: redactDeep(expected), restore: null });
      }
    }
    return conflicts;
  }
  // 撤销写入后的校验用**写前值**做基准:此刻文件里应该是 before,而不是 after。
  // 不能复用 ledgerConflicts —— 那个函数的基准是 after,只适合"撤销前先看有没有人改过"。
  function undoConflicts(record, config) {
    if (config.status !== 'ok') return [{ field: '(file)', current: config.error || config.status, expected: '配置可读', restore: null }];
    const conflicts = [];
    for (const entry of record.entries) {
      const current = entry.kind === 'codex-section'
        ? (codexSectionExists(config.document, ROUTER_SECTION) ? '仍存在' : ABSENT)
        : currentValueOf(entry, config);
      const expected = entry.before_absent ? ABSENT : entry.before;
      if (!same(current, expected)) {
        conflicts.push({
          field: fieldName(entry.path),
          current: redactDeep(current, fieldName(entry.path)),
          expected: redactDeep(expected, fieldName(entry.path)),
          restore: null,
        });
      }
    }
    return conflicts;
  }

  // 磁盘上这个受管字段的当前值。三种客户端各一种读法,统一在这里,免得预览、冲突判定
  // 和撤销后校验各写一份、各差一点。
  function currentValueOf(entry, config) {
    if (entry.kind === 'claude-env') {
      return isObject(config.doc.env) && hasOwn(config.doc.env, entry.path[1]) ? config.doc.env[entry.path[1]] : ABSENT;
    }
    if (entry.kind === 'codex-top' || entry.kind === 'codex-provider') return currentCodexValue(config.document, entry);
    if (entry.kind === 'zcode-provider') {
      const provider = zcodeOwnProvider(config.doc);
      return provider === ABSENT ? ABSENT : provider;
    }
    return valueAt(config.doc, entry.path);
  }

  function ledgerConflicts(app, record, config) {
    if (config.status === 'missing') {
      return [{ field: '(file)', current: null, expected: '配置仍存在', restore: null }];
    }
    if (config.status !== 'ok') {
      return [{ field: '(file)', current: config.error, expected: '配置可读', restore: null }];
    }
    const conflicts = [];
    for (const entry of record.entries) {
      if (entry.kind === 'codex-section') { conflicts.push(...sectionConflicts(entry, config)); continue; }
      const conflict = conflictFor(entry, currentValueOf(entry, config));
      if (conflict) conflicts.push(conflict);
    }
    return conflicts;
  }
  function valueAt(root, parts) {
    let value = root;
    for (const part of parts) {
      if (!isObject(value) || !hasOwn(value, part)) return ABSENT;
      value = value[part];
    }
    return value;
  }

  // —— 撤销:预览 ------------------------------------------------------------
  function previewUndo(app) {
    assertApp(app);
    const ledger = readLedger();
    const record = ledger.apps[app];
    if (!record) throw fail(404, '没有可撤销的接入记录');
    const config = readConfig(env, home, app);
    if (config.status === 'error') throw fail(403, config.error);
    const conflicts = ledgerConflicts(app, record, config);
    // current 取**磁盘现值**(而不是账本里的写后值):账本与磁盘不一致时,预览要显示的是
    // 用户真正会看到的那一份,不能拿期望值冒充现状。
    const readable = config.status === 'ok';
    const changes = record.entries.map(entry => ({
      field: fieldName(entry.path),
      current: redactDeep(readable ? currentValueOf(entry, config) : (entry.after_absent ? ABSENT : entry.after),
        fieldName(entry.path)),
      restore: redactDeep(entry.before_absent ? ABSENT : entry.before, fieldName(entry.path)),
      secret: !!entry.secret,
    }));
    const issued = conflicts.length ? null : issueToken('undo', app, {
      entries: record.entries,
      ledgerHash: revisionOf(JSON.stringify(record)),
      fileRevision: config.revision,
    });
    return {
      ok: true,
      app,
      action: 'undo',
      can_undo: !conflicts.length,
      token: issued ? issued.token : null,
      expires_at: issued ? issued.expires_at : null,
      changes,
      conflicts,
      config: { path: config.file, status: config.status, revision: config.revision || null },
      recovery: recoveryHint(config.file),
    };
  }

  // —— 撤销:写入 ------------------------------------------------------------
  // 写盘目标:配置是软链(点文件仓库很常见)时必须写**真实文件**。
  // writeFileAtomic 是"临时文件 + rename",直接 rename 到软链路径会把链接本身换成常规文件,
  // 用户的 dotfiles 从此脱钩 —— 而名字对、内容对,没人会立刻发现。
  function writeTarget(file) {
    try { return fs.lstatSync(file).isSymbolicLink() ? fs.realpathSync(file) : file; }
    catch { return file; }
  }

  function applyUndoClaude(config, entries) {
    const doc = clone(config.doc);
    doc.env = isObject(doc.env) ? doc.env : {};
    for (const entry of entries) {
      const key = entry.path[1];
      if (entry.before_absent) delete doc.env[key];
      else doc.env[key] = clone(entry.before);
    }
    writeFileAtomic(writeTarget(config.file), JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  }

  function removeCodexSectionLines(text, section) {
    const document = codexConfig.parse(text);
    const table = document.sections.find(item => item.parts.length === 2 && item.parts[0] === 'model_providers' && item.parts[1] === section);
    if (!table) return text;
    const end = document.sections[document.sections.indexOf(table) + 1]?.start ?? document.lines.length;
    // 段前的那个空行是 codexConfig.patch 追加段时自己带的,一起删掉;
    // 末尾连续空行按 patch 的口径收敛到一行,避免撤销之后文件尾部越攒越长。
    const start = table.start > 0 && !document.lines[table.start - 1].trim() ? table.start - 1 : table.start;
    const result = document.lines.filter((_, index) => index < start || index >= end)
      .join('\n').replace(/\n{3,}$/, '\n\n');
    codexConfig.parse(result);
    return result;
  }

  function patchCodexProvider(text, section, sets, removes) {
    let document = codexConfig.parse(text);
    const replacements = new Map();
    const removed = new Set();
    const missing = [];
    for (const [key, value] of Object.entries(sets)) {
      const entry = findCodexEntry(document, ['model_providers', section, key]);
      const line = `${key} = ${codexConfig.quote(value)}`;
      if (!entry) { missing.push(line); continue; }
      if (entry.value === undefined) throw fail(400, `provider ${key} 是复杂 TOML 值，无法安全撤销`);
      replacements.set(entry.index, line);
    }
    for (const key of removes) {
      const entry = findCodexEntry(document, ['model_providers', section, key]);
      if (!entry) continue;
      if (entry.value === undefined) throw fail(400, `provider ${key} 是复杂 TOML 值，无法安全撤销`);
      removed.add(entry.index);
    }
    // 替换与删除都按**原**行号定位,所以先 map(原位换/标记),再 filter 掉删除行。
    const lines = document.lines.map((line, index) => (removed.has(index) ? null : (replacements.get(index) ?? line)))
      .filter(line => line !== null);
    let result = lines.join('\n');
    if (missing.length) {
      const parsed = codexConfig.parse(result);
      const table = parsed.sections.find(item => item.parts.length === 2 && item.parts[0] === 'model_providers' && item.parts[1] === section);
      if (table) {
        const next = [...lines];
        next.splice(table.start + 1, 0, ...missing);
        result = next.join('\n');
      } else {
        result = `${result.replace(/\n+$/, '')}\n\n[model_providers.${section}]\n${missing.join('\n')}\n`;
      }
    }
    codexConfig.parse(result);
    return result;
  }

  function applyUndoCodex(config, entries) {
    let text = config.text;
    const top = {};
    const sets = {};
    const removes = [];
    let dropSection = false;
    for (const entry of entries) {
      if (entry.kind === 'codex-section') { dropSection = true; continue; }
      if (entry.kind === 'codex-top') {
        top[entry.path[0]] = entry.before_absent ? null : clone(entry.before);
      } else if (entry.kind === 'codex-provider') {
        if (entry.before_absent) removes.push(entry.path[1]);
        else sets[entry.path[1]] = clone(entry.before);
      }
    }
    if (Object.keys(top).length) text = codexConfig.patch(text, { top });
    if (Object.keys(sets).length || removes.length) text = patchCodexProvider(text, ROUTER_SECTION, sets, removes);
    if (dropSection) text = removeCodexSectionLines(text, ROUTER_SECTION);
    writeFileAtomic(writeTarget(config.file), text, { mode: 0o600 });
  }

  function setDeep(root, parts, value) {
    // 账本是我们自己写的,但"磁盘文件可被改"这件事不能靠信任:路径里出现 __proto__
    // 之类的键时,朴素赋值会改原型链而不是配置。
    assertSafeParts(parts);
    let target = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const key = parts[index];
      if (!isObject(target[key])) target[key] = {};
      target = target[key];
    }
    const last = parts.at(-1);
    if (value === ABSENT) delete target[last];
    // defineProperty 而不是赋值:即使键名是 "__proto__"(上面已拒),路径也只会落在自有属性上。
    else Object.defineProperty(target, last, { value: clone(value), enumerable: true, writable: true, configurable: true });
  }

  function applyUndoZcode(config, entries) {
    const doc = clone(config.doc);
    for (const entry of entries) {
      if (entry.kind === 'zcode-provider') {
        if (isObject(doc.provider)) delete doc.provider[ZCODE_PROVIDER];
        if (entry.map_before_absent && isObject(doc.provider) && Object.keys(doc.provider).length === 0) delete doc.provider;
        continue;
      }
      const value = entry.before_absent ? ABSENT : entry.before;
      setDeep(doc, entry.path, value);
    }
    const problem = validateZcodeDoc(doc);
    if (problem) throw fail(500, '撤销后的 ZCode 配置结构无效，未写入');
    writeFileAtomic(writeTarget(config.file), JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  }

  function undo(app, request = {}) {
    assertApp(app);
    if (!isObject(request) || request.confirm !== true) throw fail(400, '撤销前需要显式确认（confirm: true）');
    const record = consumeToken(request.token, 'undo', app);
    const ledger = readLedger();
    const saved = ledger.apps[app];
    if (!saved) throw fail(404, '没有可撤销的接入记录');
    if (revisionOf(JSON.stringify(saved)) !== record.ledgerHash) {
      throw fail(409, '接入记录在预览后发生变化，撤销已中止；请重新预览');
    }
    const config = readConfig(env, home, app);
    if (config.status === 'error') throw fail(403, config.error);
    if (saved.file && saved.file !== config.file) {
      throw fail(409, '接入记录针对另一个配置文件，撤销已中止；请检查 MIXR_* 配置路径');
    }
    // 撤销不看整份文件的 revision:它只按受管字段逐个还原,用户在别处(权限、MCP、
    // 其它渠道)的改动不该阻塞撤销。真正要拒绝的是"受管字段已经不是当初写后的值"。
    const conflicts = ledgerConflicts(app, saved, config);
    if (conflicts.length) {
      throw fail(409, conflictMessage('配置在接入后被修改，撤销已中止；未写入任何内容', conflicts), { conflicts });
    }

    const warnings = [];
    // 接入前文件根本不存在:撤销后受管键会消失,但**不会删文件**。不删是有意的 ——
    // "删客户端配置文件"比"留下一个空对象"更难挽回,而空对象对三个客户端都是合法配置。
    if (saved.revision_before === null) {
      warnings.push('接入前该配置文件不存在；撤销只移除本次写入的受管字段，不删除文件本身');
    }
    try {
      backupFile(config.file, { onWarn: message => warnings.push(message) });
    } catch {
      throw fail(500, '备份客户端配置失败，撤销已中止；未写入任何内容');
    }
    if (app === 'claude') applyUndoClaude(config, saved.entries);
    else if (app === 'codex') applyUndoCodex(config, saved.entries);
    else applyUndoZcode(config, saved.entries);

    const after = readConfig(env, home, app);
    const left = undoConflicts(saved, after);
    if (left.length) {
      throw fail(500, '撤销写入后校验失败；客户端配置可能只还原了一部分，请用备份核对', { conflicts: left });
    }
    try { removeLedger(app); }
    catch { throw fail(500, '客户端配置已还原，但撤销账本清除失败；请手动检查 client-managed.json'); }
    return { ok: true, app, restored: publicEntries(saved.entries), warnings, recovery: recoveryHint(config.file) };
  }

  return { inspect, preview, apply, previewUndo, undo, ledgerPath };
}

module.exports = { createClientOnboarding, LEDGER_FILE, ROUTER_SECTION, ZCODE_PROVIDER, CLAUDE_SLOT_ENV };
