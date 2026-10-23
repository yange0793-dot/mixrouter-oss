'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { writeFileAtomic } = require('./atomic-write');
const paths = require('./paths');
const { normalizeCapabilities } = require('./dsh-schema');

const BEGIN = '# BEGIN MIXROUTER DSH MANAGED v1';
const END = '# END MIXROUTER DSH MANAGED v1';
const PRESETS = ['standard', 'ptc', 'cordis'];
const PLUGIN = '@deepseek-ai/dsh-agent-preset';
const ADAPTER = '@deepseek-ai/dsh-llm-pi-ai';
const TOOL = '@deepseek-ai/dsh-tool-subagent';
const MAIN = '@deepseek-ai/dsh-agent-default-model';
const SELECTION = '@deepseek-ai/dsh-tool-subagent/model-selection-settings';
const HOST = '@deepseek-ai/dsh-subagent';
const NATIVE_IDS = ['agent-default-model', 'subagent-model-selection-settings', 'subagent', ...PRESETS.map(id => 'preset-' + id)];
const own = (value, key) => Object.hasOwn(value, key);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const modelId = id => typeof id === 'string' && /^mixr-dsh-[a-z0-9][a-z0-9_-]{0,63}$/.test(id);

function locations(options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const file = paths.dshConfig ? paths.dshConfig(env, home) :
    env.MIXR_DSH_CONFIG || path.join(env.DSH_HOME || path.join(home, '.dsh'), 'profiles', 'desktop', 'cordis.patch.yml');
  let app = options.appRoot || env.MIXR_DSH_APP || '/Applications/DeepSeek Harness.app';
  if (app.endsWith('.app')) app = path.join(app, 'Contents', 'Resources', 'app');
  if (!path.isAbsolute(file) || !path.isAbsolute(app)) throw error('Harness 配置及安装路径必须是绝对路径');
  return { file, app };
}

function read(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw error('Harness 配置必须是常规文件，拒绝覆盖');
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw error('无法安全读取 Harness 配置，拒绝覆盖');
  }
}

function splitManaged(text, { allowAltered = false } = {}) {
  const source = text || '';
  const starts = [...source.matchAll(/^# BEGIN MIXROUTER DSH MANAGED.*$/gm)];
  const ends = [...source.matchAll(/^# END MIXROUTER DSH MANAGED.*$/gm)];
  if (!starts.length && !ends.length) return { prefix: source, suffix: '', managed: null };
  if (starts.length !== 1 || ends.length !== 1 || starts[0][0] !== BEGIN || ends[0][0] !== END || ends[0].index < starts[0].index)
    throw error('Harness 托管段标记已改变或重复，拒绝覆盖', 409);
  const start = starts[0].index;
  const end = ends[0].index + END.length + (source[ends[0].index + END.length] === '\n' ? 1 : 0);
  const body = source.slice(start + BEGIN.length + 1, ends[0].index);
  const match = /^# sha256: ([a-f0-9]{64})\n([\s\S]*)$/.exec(body);
  if (!match) throw error('Harness 托管段校验标记缺失，请核对配置', 409);
  const altered = hash(match[2]) !== match[1];
  if (altered && !allowAltered) throw error('Harness 托管段被外部修改，拒绝覆盖；仅自动替换未改动的自有段', 409);
  const metadata = /^# spec: (.+)\n/.exec(match[2]);
  let spec;
  try { spec = JSON.parse(metadata[1]); } catch { throw error('Harness 托管段元数据无效，拒绝覆盖', 409); }
  return { prefix: source.slice(0, start), suffix: source.slice(end), managed: spec, payload: match[2], altered };
}

function parser(app) {
  try {
    const req = createRequire(path.join(app, 'dsh', 'package.json'));
    const yaml = req('js-yaml');
    const tag = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar', resolve: data => typeof data === 'string', construct: data => ({ __jsExpr: data }),
    });
    return { load: text => yaml.load(text, { schema: yaml.JSON_SCHEMA.extend(tag) }) };
  } catch { throw error('Harness 安装缺少官方 YAML 解析器，无法安全同步', 409); }
}

function parse(yaml, text) {
  let data;
  try { data = yaml.load(text); } catch { throw error('Harness 配置不是合法的官方 patch YAML，拒绝覆盖'); }
  if (!Array.isArray(data) || data.some(row => !object(row))) throw error('Harness 配置必须是 patch mapping 的顶层数组');
  return data;
}

// JSON flow values are legal YAML. Preserve official !!js nodes without evaluating them.
function flow(value) {
  if (object(value) && Object.keys(value).length === 1 && typeof value.__jsExpr === 'string') return '!!js ' + JSON.stringify(value.__jsExpr);
  if (Array.isArray(value)) return '[' + value.map(flow).join(', ') + ']';
  if (object(value)) return '{' + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ': ' + flow(v)).join(', ') + '}';
  return JSON.stringify(value);
}

function safeObject(value) {
  if (!object(value) || Object.hasOwn(value, '__jsExpr')) throw error('目标 Harness config 使用动态表达式，无法无执行地合并，拒绝覆盖', 409);
  const visit = x => {
    if (object(x) && Object.hasOwn(x, '__jsExpr')) throw error('目标 Harness config 含旧 !!js 表达式，拒绝执行或覆盖', 409);
    if (x && typeof x === 'object') Object.values(x).forEach(visit);
  };
  visit(value);
  return value;
}

function visitRows(rows, callback) {
  for (const row of rows) {
    callback(row);
    if (Array.isArray(row.insert)) visitRows(row.insert, callback);
    if (row.group && Array.isArray(row.config)) visitRows(row.config, callback);
  }
}
function effective(rows, id, name, fallback = {}) {
  let config = fallback;
  visitRows(rows, row => {
    if (row.id === id && (!row.name || row.name === name) && row.config !== undefined) config = row.config;
  });
  return config;
}
function currentPolicy(spec) {
  return spec.subagentPolicy || { enabled: true, allowedModels: spec.models.map(m => ({ provider: 'mixrouter', model: m.id })),
    defaultMode: 'slot', defaultModel: spec.defaultSubagent };
}

function validate(options) {
  let url;
  try { url = new URL(options.routerURL); } catch { throw error('routerURL 必须是合法 HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw error('routerURL 不能包含凭据、查询参数或片段');
  const baseURL = url.toString().replace(/\/+$/, '') + '/dsh/v1';
  if (!Array.isArray(options.models) || !options.models.length || options.models.length > 128) throw error('models 必须是非空模型清单');
  const ids = new Set();
  const models = options.models.map(m => {
    if (!object(m) || !modelId(m.id) || ids.has(m.id)) throw error('模型 ID 必须是唯一 mixr-dsh 槽位别名');
    if (Object.keys(m).some(k => !['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'reasoningEfforts'].includes(k))) throw error('模型包含不支持的字段');
    ids.add(m.id);
    const out = { id: m.id };
    if (m.name !== undefined) {
      if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 200 || /[\x00-\x1f]/.test(m.name)) throw error('模型名称无效');
      out.name = m.name;
    }
    for (const key of ['contextWindow', 'maxTokens']) if (m[key] !== undefined) {
      if (!Number.isSafeInteger(m[key]) || m[key] < 1) throw error('模型 token 容量必须是正整数');
      out[key] = m[key];
    }
    if (m.input !== undefined) {
      if (!Array.isArray(m.input) || !m.input.length || new Set(m.input).size !== m.input.length || m.input.some(v => !['text', 'image'].includes(v))) throw error('模型输入类型无效');
      out.input = [...m.input];
    }
    if (out.contextWindow !== undefined && out.maxTokens !== undefined && out.maxTokens > out.contextWindow)
      throw error('模型输出容量须小于或等于上下文');
    if (own(m, 'reasoning') && own(m, 'reasoningEfforts')) throw error('reasoning 与 reasoningEfforts 应仅声明一个');
    if (own(m, 'reasoningEfforts')) out.reasoningEfforts = normalizeCapabilities({ reasoning_efforts: m.reasoningEfforts }).reasoning_efforts;
    else if (m.reasoning !== undefined) {
      if (typeof m.reasoning !== 'boolean') throw error('reasoning 必须是布尔值');
      out.reasoningEfforts = m.reasoning ? { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } : false;
    }
    return out;
  });
  const defaultModel = options.defaultModel;
  const defaultSubagent = options.defaultSubagent || defaultModel;
  if (!ids.has(defaultModel) || !ids.has(defaultSubagent)) throw error('主模型及默认子模型必须属于托管模型清单');
  if (options.reasoningEffort !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(options.reasoningEffort)) throw error('reasoningEffort 无效');
  const main = models.find(m => m.id === defaultModel);
  if (options.reasoningEffort !== undefined && (main.reasoningEfforts === false || (object(main.reasoningEfforts) && !Object.hasOwn(main.reasoningEfforts, options.reasoningEffort)))) throw error('主模型不支持指定的思考强度');
  const base = { baseURL, models, defaultModel, ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }) };
  if (options.policyOwner === undefined && options.subagentPolicy === undefined) return { baseURL, models, defaultModel,
    defaultSubagent, ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }) };
  if (!['mixrouter', 'harness'].includes(options.policyOwner) || !object(options.subagentPolicy)) throw error('子策略管理方与完整 subagentPolicy 必须同时提供');
  const p = options.subagentPolicy;
  if (Object.keys(p).some(k => !['enabled', 'allowedModels', 'defaultMode', 'defaultModel', 'maxDepth', 'maxActiveSubagents'].includes(k))
    || typeof p.enabled !== 'boolean' || !Array.isArray(p.allowedModels) || p.allowedModels.length > models.length)
    throw error('subagentPolicy 字段无效');
  const candidates = new Set();
  const allowedModels = p.allowedModels.map(m => {
    if (!object(m) || Object.keys(m).some(k => !['provider', 'model'].includes(k)) || m.provider !== 'mixrouter'
      || !ids.has(m.model) || candidates.has(m.model)) throw error('子候选须为不重复的已注册 mixrouter 模型');
    candidates.add(m.model); return { provider: 'mixrouter', model: m.model };
  });
  if (p.enabled && !allowedModels.length) throw error('启用选模时须提供子候选');
  if (!['slot', 'inherit'].includes(p.defaultMode)) throw error('默认子行为须为 slot 或 inherit');
  if (p.defaultMode === 'slot' && (!ids.has(p.defaultModel) || p.enabled && !candidates.has(p.defaultModel)))
    throw error('默认子模型須已注册且属于开启的候选名单');
  if (p.defaultMode === 'inherit' && own(p, 'defaultModel')) throw error('继承父模型时省略 defaultModel');
  const subagentPolicy = { enabled: p.enabled, allowedModels, defaultMode: p.defaultMode,
    ...(p.defaultMode === 'slot' ? { defaultModel: p.defaultModel } : {}) };
  for (const [key, min] of [['maxDepth', 0], ['maxActiveSubagents', 1]]) if (own(p, key)) {
    if (!Number.isSafeInteger(p[key]) || p[key] < min || p[key] > 64) throw error(`${key} 超出整数范围`);
    subagentPolicy[key] = p[key];
  }
  return { ...base, policyOwner: options.policyOwner, subagentPolicy };
}

function presetPatches(app, yaml, rows, spec) {
  return PRESETS.map(id => {
    const template = path.join(app, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', id + '.patch.yml');
    let base;
    try { base = parse(yaml, fs.readFileSync(template, 'utf8')); } catch { throw error('Harness 内置 preset 模板缺失或无效，拒绝不完整同步', 409); }
    const config = structuredClone(effective(rows, 'preset-' + id, PLUGIN, effective(base, 'preset-' + id, PLUGIN)));
    if (!object(config) || config.__jsExpr || config.id !== id || !Array.isArray(config.plugins)) throw error('Harness preset config 无法安全合并', 409);
    const policy = currentPolicy(spec);
    let count = 0;
    const walk = plugins => {
      for (const row of plugins) {
        if (row.name === TOOL && row.config?.provider === 'spawn') {
          if (row.config.__jsExpr || row.config.agentOptions?.__jsExpr) throw error('Harness 子工具默认模型含动态表达式，拒绝覆盖', 409);
          const agentOptions = { ...row.config.agentOptions };
          delete agentOptions.provider; delete agentOptions.model; delete agentOptions.reasoningEffort;
          if (policy.defaultMode === 'slot') Object.assign(agentOptions, { provider: 'mixrouter', model: policy.defaultModel });
          row.config = { ...row.config, modelSelectionSettings: policy.enabled, agentOptions };
          if (own(policy, 'maxDepth')) row.config.maxDepth = policy.maxDepth;
          count++;
        }
        if (row.group && Array.isArray(row.config)) walk(row.config);
      }
    };
    walk(config.plugins);
    if (!count) throw error('Harness 内置 preset 缺少 spawn 子工具，拒绝无效同步', 409);
    return { id: 'preset-' + id, name: PLUGIN, config };
  });
}

function mergeExpression(file, provider) {
  // This expression reads only its own patch file, parses !!js into inert nodes,
  // and never evaluates existing user expressions or copies credentials into this block.
  return `(() => { const req = process.getBuiltinModule('node:module').createRequire(baseUrl); const yaml = req('js-yaml'); const fs = process.getBuiltinModule('node:fs'); const t = fs.readFileSync(${JSON.stringify(file)}, 'utf8'); const a = t.indexOf(${JSON.stringify(BEGIN + '\n')}); const b = t.indexOf(${JSON.stringify('\n' + END + '\n')}, a); if(a < 0 || b < a) throw new Error('mixrouter managed block missing'); const source = t.slice(0,a) + t.slice(b + ${END.length + 2}); const tag = new yaml.Type('tag:yaml.org,2002:js', {kind:'scalar',resolve:x=>typeof x==='string',construct:x=>({__jsExpr:x})}); const rows = yaml.load(source, {schema:yaml.JSON_SCHEMA.extend(tag)}) || []; let c = {}; const walk = list => { for(const r of list) { if(r.insert) walk(r.insert); if(r.id==='llm-pi-ai' && (!r.name || r.name===${JSON.stringify(ADAPTER)}) && r.config !== undefined) c=r.config; if(r.group && Array.isArray(r.config)) walk(r.config); } }; walk(rows); const check=x=>{if(x && typeof x==='object'){if(Object.prototype.hasOwnProperty.call(x,'__jsExpr')) throw new Error('mixrouter refuses dynamic provider config'); Object.values(x).forEach(check);}}; check(c); if(!c || Array.isArray(c) || typeof c!=='object' || (c.providers!==undefined && (!c.providers || Array.isArray(c.providers) || typeof c.providers!=='object'))) throw new Error('mixrouter invalid provider config'); return {...c,providers:{...c.providers,mixrouter:${JSON.stringify(provider)}}}; })()`;
}

function catalogProvider(spec) {
  return { displayName: 'Mixrouter', api: 'openai-responses', baseURL: spec.baseURL,
    headers: { Authorization: 'Bearer mixrouter-local' }, models: spec.models, compat: { supportsStrictMode: true } };
}

function makeBlock(file, app, yaml, rows, spec, currentRows = rows, oldOwnedRows = []) {
  const old = safeObject(effective(rows, 'llm-pi-ai', ADAPTER));
  if (old.providers !== undefined && !object(old.providers)) throw error('Harness providers 必须是字典');
  if (Object.hasOwn(old.providers || {}, 'mixrouter')) throw error('非托管配置已占用 mixrouter provider，拒绝覆盖', 409);
  const provider = catalogProvider(spec);
  const patches = [{ id: 'llm-pi-ai', name: ADAPTER, config: { __jsExpr: mergeExpression(file, provider) } }];
  if (spec.policyOwner !== 'harness') {
    const policy = currentPolicy(spec);
    const main = { ...safeObject(effective(currentRows, 'agent-default-model', MAIN)), provider: 'mixrouter', model: spec.defaultModel };
    delete main.reasoningEffort;
    if (spec.reasoningEffort !== undefined) main.reasoningEffort = spec.reasoningEffort;
    const selection = safeObject(effective(currentRows, 'subagent-model-selection-settings', SELECTION));
    patches.push({ id: 'agent-default-model', name: MAIN, config: main },
      { id: 'subagent-model-selection-settings', name: SELECTION, config: { ...selection, enabled: policy.enabled, allowedModels: policy.allowedModels } },
      ...presetPatches(app, yaml, currentRows, spec));
    if (own(policy, 'maxDepth') || own(policy, 'maxActiveSubagents') || oldOwnedRows.some(row => row.id === 'subagent')) {
      const limits = { ...safeObject(effective(currentRows, 'subagent', HOST)) };
      if (own(policy, 'maxDepth')) limits.maxDepth = policy.maxDepth;
      if (own(policy, 'maxActiveSubagents')) limits.maxActiveSubagents = policy.maxActiveSubagents;
      patches.push({ id: 'subagent', name: HOST, config: limits });
    }
  }
  const payload = '# spec: ' + JSON.stringify(spec) + '\n' + patches.map(p => '- ' + flow(p)).join('\n') + '\n';
  return BEGIN + '\n# sha256: ' + hash(payload) + '\n' + payload + END + '\n';
}

function storedSpec(parts) {
  const saved = parts.managed;
  if (!saved) return null;
  // Do not mix desired options into disk metadata, and never booleanize exact maps.
  return validate({ ...saved, routerURL: saved.baseURL?.replace(/\/dsh\/v1$/, '') });
}
function comparable(spec) {
  return spec?.policyOwner === 'harness' ? { baseURL: spec.baseURL, models: spec.models, policyOwner: 'harness' } : spec;
}
function sameSpec(a, b) { return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b)); }
function coverage(spec) {
  return { ordinary_spawn: spec.policyOwner === 'harness' ? 'harness_managed' : 'explicit_selection_and_configured_default',
    implicit_inheritance: 'outside_explicit_allowlist_check', fork: 'inherits_parent_model',
    team: 'inherits_parent_model', workflow: 'independent_creation_path', ds_bot: 'per_bot_model_settings',
    global_enforcement: false, runtime_adoption: 'unverified' };
}
function validateRepair(parts, file, yaml, previous) {
  if (!parts.managed || !previous) throw error('重新接入需要可识别的 MixRouter 托管段', 409);
  const owned = parse(yaml, parts.payload);
  const ids = new Set();
  const names = { 'llm-pi-ai': ADAPTER, 'agent-default-model': MAIN,
    'subagent-model-selection-settings': SELECTION, subagent: HOST,
    ...Object.fromEntries(PRESETS.map(id => ['preset-' + id, PLUGIN])) };
  for (const row of owned) {
    if (!own(names, row.id) || row.name !== names[row.id] || ids.has(row.id)
      || Object.keys(row).some(key => !['id', 'name', 'config'].includes(key)))
      throw error('托管段包含额外条目，请核对后再接入；原配置保留', 409);
    ids.add(row.id);
  }
  const adapter = owned.find(row => row.id === 'llm-pi-ai');
  const expression = mergeExpression(file, catalogProvider(previous));
  if (!adapter || !object(adapter.config) || Object.keys(adapter.config).length !== 1
    || adapter.config.__jsExpr !== expression)
    throw error('托管 provider 表达式已改变，请核对后再接入；原配置保留', 409);
  if (previous.policyOwner !== 'harness' && ['agent-default-model', 'subagent-model-selection-settings',
    ...PRESETS.map(id => 'preset-' + id)].some(id => !ids.has(id)))
    throw error('托管策略条目缺失，请核对后再接入；原配置保留', 409);
  return owned;
}
function modelFact(value) {
  return { provider: typeof value?.provider === 'string' ? value.provider : '',
    model: typeof value?.model === 'string' ? value.model : '' };
}
function planSync(options) {
  const spec = validate(options);
  const { file, app } = locations(options);
  if (!fs.existsSync(path.join(app, 'package.json'))) throw error('未找到 Harness 安装，拒绝同步', 409);
  const yaml = parser(app);
  const original = read(file);
  const parts = splitManaged(original, { allowAltered: options.repair === true });
  const previous = storedSpec(parts);
  const repairing = options.repair === true && parts.altered === true;
  if (options.repair === true) validateRepair(parts, file, yaml, previous);
  const unmanaged = parts.prefix + parts.suffix;
  const rows = unmanaged.trim() ? parse(yaml, unmanaged) : [];
  if (unmanaged.replace(/^\s*#.*$/gm, '').trim().startsWith('[')) throw error('Harness 使用 flow-style 根数组；请先转换为 block patch list 再同步');
  const currentRows = original?.trim() ? parse(yaml, original) : [];
  const oldOwned = parts.payload ? parse(yaml, parts.payload) : [];
  const tail = parts.suffix.replace(/^\s*#.*$/gm, '').trim();
  if (tail) visitRows(parse(yaml, parts.suffix), row => {
    if (row.id === 'llm-pi-ai' || spec.policyOwner !== 'harness' && NATIVE_IDS.includes(row.id))
      throw error('托管段之后存在用户模型覆盖，请先移动到托管段之前；拒绝产生不生效的同步', 409);
  });
  const transitioning = previous && previous.policyOwner !== 'harness' && spec.policyOwner === 'harness';
  // Release only rows previously owned by our checksummed block, at the same
  // precedence position. Suffix native edits keep winning; provider remains owned.
  const released = transitioning ? oldOwned.filter(row => NATIVE_IDS.includes(row.id)) : [];
  const releaseText = released.length ? '# MIXROUTER RELEASED NATIVE SETTINGS — Harness now owns these rows\n'
    + released.map(row => '- ' + flow(row)).join('\n') + '\n' : '';
  // With native ownership, policy preferences are stored in dsh.json only. A
  // change to those preferences alone must not rewrite the route catalog.
  const writingSpec = previous?.policyOwner === 'harness' && sameSpec(previous, spec) ? previous : spec;
  const block = makeBlock(file, app, yaml, rows, writingSpec, currentRows, oldOwned);
  const prefix = parts.prefix + (!parts.managed && parts.prefix && !parts.prefix.endsWith('\n') ? '\n' : '');
  const output = prefix + releaseText + block + parts.suffix;
  parse(yaml, output);
  const changed = output !== original;
  const newOwned = parse(yaml, block);
  const changedRows = newOwned.filter(row => flow(row) !== flow(oldOwned.find(old => old.id === row.id)));
  const affected = changed ? [...new Set([...changedRows.map(row => row.id), ...released.map(row => row.id)])] : [];
  const warnings = ['磁盘配置状态不是运行中会话采用状态；策略/能力变更后重启 Harness 并新建会话。',
    '候选名单仅用于普通 spawn 的显式选模检查，不覆盖 fork、Team、workflow 或 DS Bot 的全部创建路径。'];
  if (repairing) warnings.unshift('Harness 设置页已改写托管段。确认重新接入后，仅重建此段并备份原文件；托管段中的主模型和子设置将按本页保存值更新。');
  if (spec.policyOwner === 'harness') warnings.push('本次只管理 mixrouter provider 与模型目录；本页保留的主/子偏好不覆盖 Harness 原生设置。');
  if (transitioning) warnings.push('将先前托管的主模型、子策略、preset 与限额放到托管区外，保留最后有效值和后续原生覆盖。');
  if (currentPolicy(spec).defaultMode === 'inherit' && spec.policyOwner !== 'harness') warnings.push('继承父模型是动态继承，可能落在显式候选名单之外。');
  if (spec.models.some(m => m.contextWindow === undefined || m.maxTokens === undefined)) warnings.push('未声明容量采用 Harness 适配器默认，不代表上游已验证容量。');
  return { original, output, file, spec, facts: { installed: true, config_path: file,
    status: changed ? previous ? 'out_of_sync' : 'not_configured' : 'configured',
    routed: !!previous, policy_owner: spec.policyOwner || 'mixrouter', changed, sync_needed: changed,
    affected_sections: affected, released_sections: released.map(row => row.id),
    model_count: spec.models.length, ownership_transition: !!previous && (previous.policyOwner || 'mixrouter') !== (spec.policyOwner || 'mixrouter'),
    ...(options.repair === true ? { repair_mode: repairing, profile_revision: hash(original || ''),
      main_before: modelFact(effective(currentRows, 'agent-default-model', MAIN)),
      main_after: spec.policyOwner === 'harness' ? modelFact(effective(currentRows, 'agent-default-model', MAIN))
        : { provider: 'mixrouter', model: spec.defaultModel } } : {}),
    changes: { route_catalog: affected.includes('llm-pi-ai'),
      ownership: !!previous && (previous.policyOwner || 'mixrouter') !== (spec.policyOwner || 'mixrouter'),
      main_default: affected.includes('agent-default-model'),
      ordinary_subagent_policy: spec.policyOwner !== 'harness' && affected.some(id => id !== 'llm-pi-ai' && id !== 'agent-default-model'),
      native_handoff: !!transitioning },
    coverage: coverage(spec), warnings, restart_required: true, runtime_adoption: 'unverified' } };
}
function inspectDsh(options = {}) {
  const { file, app } = locations(options);
  const result = { installed: fs.existsSync(path.join(app, 'package.json')), config_path: file,
    status: 'not_configured', routed: false, restart_required: true, runtime_adoption: 'unverified',
    affected_sections: [], warnings: [] };
  try {
    const parts = splitManaged(read(file));
    const spec = storedSpec(parts);
    if (spec) {
      result.provider = 'mixrouter';
      if (spec.policyOwner !== 'harness') result.model = spec.defaultModel;
      result.policy_owner = spec.policyOwner || 'mixrouter';
      result.status = 'configured'; result.routed = true;
      result.coverage = coverage(spec);
    }
    if (options.models && result.installed) {
      const plan = planSync(options);
      Object.assign(result, plan.facts);
      if (spec) { result.routed = true; result.provider = 'mixrouter'; }
    } else if (options.models) result.sync_needed = !spec || !sameSpec(spec, validate(options));
  } catch { result.status = 'conflict'; result.sync_needed = true;
    result.warnings = ['磁盘配置或托管段存在冲突，尚未确认可同步；只读预览可定位具体错误。'];
    if (options.models && result.installed) {
      try {
        const recovery = planSync({ ...options, repair: true }).facts;
        result.repair_available = recovery.repair_mode === true;
        if (result.repair_available) {
          result.model = recovery.main_before?.model || '';
          result.main_provider = recovery.main_before?.provider || '';
          result.warnings = ['Harness 设置页已更新托管段；模型路由仍可单独保存。重新接入会先预览和备份，不自动切换当前会话。'];
        }
      } catch { result.repair_available = false; }
    }
  }
  return result;
}
function previewDsh(options = {}) { return planSync(options).facts; }
function syncDsh(options = {}) {
  const plan = planSync(options);
  const { original, output, file } = plan;
  if (options.repair === true && (typeof options.expectedProfileRevision !== 'string'
    || options.expectedProfileRevision !== hash(original || '')))
    throw error('Harness 配置在重新接入预览后已变化，请重新预览；原文件保留', 409);
  if (output === original) return { ...inspectDsh(options), changed: false, backup_path: null };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const backup = original === null ? null : file + '.bak-mixrouter-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex');
  if (backup) {
    const fd = fs.openSync(backup, 'wx', 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, original); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  if (read(file) !== original) throw error('Harness 配置在同步期间改变，拒绝覆盖', 409);
  writeFileAtomic(file, output, { mode: 0o600 });
  return { ...inspectDsh(options), changed: true, affected_sections: plan.facts.affected_sections,
    released_sections: plan.facts.released_sections, backup_path: backup };
}
module.exports = { inspectDsh, syncDsh, previewDsh };
