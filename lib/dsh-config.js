'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { writeFileAtomic } = require('./atomic-write');
const paths = require('./paths');

const BEGIN = '# BEGIN MIXROUTER DSH MANAGED v1';
const END = '# END MIXROUTER DSH MANAGED v1';
const PRESETS = ['standard', 'ptc', 'cordis'];
const PLUGIN = '@deepseek-ai/dsh-agent-preset';
const ADAPTER = '@deepseek-ai/dsh-llm-pi-ai';
const TOOL = '@deepseek-ai/dsh-tool-subagent';
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

function splitManaged(text) {
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
  if (!match || hash(match[2]) !== match[1]) throw error('Harness 托管段被外部修改，拒绝覆盖；仅自动替换未改动的自有段', 409);
  const metadata = /^# spec: (.+)\n/.exec(match[2]);
  let spec;
  try { spec = JSON.parse(metadata[1]); } catch { throw error('Harness 托管段元数据无效，拒绝覆盖', 409); }
  return { prefix: source.slice(0, start), suffix: source.slice(end), managed: spec };
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

function effective(rows, id, name, fallback = {}) {
  let config = fallback;
  for (const row of rows) {
    if (row.insert) {
      const walk = list => { for (const item of list) {
        if (item.id === id && item.name === name && item.config !== undefined) config = item.config;
        if (item.group && Array.isArray(item.config)) walk(item.config);
      } };
      walk(row.insert);
    }
    if (row.id === id && (!row.name || row.name === name) && row.config !== undefined) config = row.config;
  }
  return config;
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
    if (Object.keys(m).some(k => !['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoning'].includes(k))) throw error('模型包含不支持的字段');
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
    if (m.reasoning !== undefined) {
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
  return { baseURL, models, defaultModel, defaultSubagent, ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }) };
}

function presetPatches(app, yaml, rows, spec) {
  return PRESETS.map(id => {
    const template = path.join(app, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', id + '.patch.yml');
    let base;
    try { base = parse(yaml, fs.readFileSync(template, 'utf8')); } catch { throw error('Harness 内置 preset 模板缺失或无效，拒绝不完整同步', 409); }
    const config = structuredClone(effective(rows, 'preset-' + id, PLUGIN, effective(base, 'preset-' + id, PLUGIN)));
    if (!object(config) || config.__jsExpr || config.id !== id || !Array.isArray(config.plugins)) throw error('Harness preset config 无法安全合并', 409);
    let count = 0;
    const walk = plugins => {
      for (const row of plugins) {
        if (row.name === TOOL && row.config?.provider === 'spawn') {
          if (row.config.__jsExpr || row.config.agentOptions?.__jsExpr) throw error('Harness 子工具默认模型含动态表达式，拒绝覆盖', 409);
          row.config = { ...row.config, modelSelectionSettings: true,
            agentOptions: { ...row.config.agentOptions, provider: 'mixrouter', model: spec.defaultSubagent } };
          // An effort belongs to a model route; do not carry another provider's effort across it.
          delete row.config.agentOptions.reasoningEffort;
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

function makeBlock(file, app, yaml, rows, spec) {
  const old = safeObject(effective(rows, 'llm-pi-ai', ADAPTER));
  if (old.providers !== undefined && !object(old.providers)) throw error('Harness providers 必须是字典');
  if (Object.hasOwn(old.providers || {}, 'mixrouter')) throw error('非托管配置已占用 mixrouter provider，拒绝覆盖', 409);
  const defaultConfig = safeObject(effective(rows, 'agent-default-model', '@deepseek-ai/dsh-agent-default-model'));
  const selectionConfig = safeObject(effective(rows, 'subagent-model-selection-settings', '@deepseek-ai/dsh-tool-subagent/model-selection-settings'));
  const provider = { displayName: 'Mixrouter', api: 'openai-responses', baseURL: spec.baseURL,
    headers: { Authorization: 'Bearer mixrouter-local' }, models: spec.models,
    compat: { supportsStrictMode: true } };
  const main = { ...defaultConfig, provider: 'mixrouter', model: spec.defaultModel };
  delete main.reasoningEffort;
  if (spec.reasoningEffort !== undefined) main.reasoningEffort = spec.reasoningEffort;
  const patches = [
    { id: 'llm-pi-ai', name: ADAPTER, config: { __jsExpr: mergeExpression(file, provider) } },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: main },
    { id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings',
      config: { ...selectionConfig, enabled: true, allowedModels: spec.models.map(m => ({ provider: 'mixrouter', model: m.id })) } },
    ...presetPatches(app, yaml, rows, spec),
  ];
  const payload = '# spec: ' + JSON.stringify(spec) + '\n' + patches.map(p => '- ' + flow(p)).join('\n') + '\n';
  return BEGIN + '\n# sha256: ' + hash(payload) + '\n' + payload + END + '\n';
}

function inspectDsh(options = {}) {
  const { file, app } = locations(options);
  const result = { installed: fs.existsSync(path.join(app, 'package.json')), config_path: file,
    status: 'not_configured', routed: false, restart_required: true };
  try {
    const parts = splitManaged(read(file));
    if (!parts.managed) return result;
    const spec = validate({ ...options, ...parts.managed, routerURL: parts.managed.baseURL?.replace(/\/dsh\/v1$/, ''),
      models: parts.managed.models.map(m => ({ id: m.id, ...(m.name ? { name: m.name } : {}),
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}), ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
        ...(m.input ? { input: m.input } : {}), ...(m.reasoningEfforts === undefined ? {} : { reasoning: m.reasoningEfforts !== false }) })) });
    result.provider = 'mixrouter'; result.model = spec.defaultModel;
    result.status = 'configured'; result.routed = true;
    if (options.models && JSON.stringify(spec) !== JSON.stringify(validate(options))) { result.status = 'out_of_sync'; result.routed = false; }
  } catch { result.status = 'conflict'; }
  return result;
}

function syncDsh(options = {}) {
  const spec = validate(options);
  const { file, app } = locations(options);
  if (!fs.existsSync(path.join(app, 'package.json'))) throw error('未找到 Harness 安装，拒绝同步', 409);
  const yaml = parser(app);
  const original = read(file);
  const parts = splitManaged(original);
  const unmanaged = parts.prefix + parts.suffix;
  const rows = unmanaged.trim() ? parse(yaml, unmanaged) : [];
  // A flow-style root cannot accept appended block entries without rewriting user bytes.
  if (unmanaged.replace(/^\s*#.*$/gm, '').trim().startsWith('[')) throw error('Harness 使用 flow-style 根数组；请先转换为 block patch list 再同步');
  if (parts.suffix.trim()) {
    const tail = parts.suffix.replace(/^\s*#.*$/gm, '').trim();
    if (tail && parse(yaml, parts.suffix).some(row =>
      ['llm-pi-ai', 'agent-default-model', 'subagent-model-selection-settings', ...PRESETS.map(id => 'preset-' + id)].includes(row.id)))
      throw error('托管段之后存在用户模型覆盖，请先移动到托管段之前；拒绝产生不生效的同步', 409);
  }
  const block = makeBlock(file, app, yaml, rows, spec);
  const prefix = parts.prefix + (!parts.managed && parts.prefix && !parts.prefix.endsWith('\n') ? '\n' : '');
  const output = prefix + block + parts.suffix;
  parse(yaml, output);
  if (output === original) return { ...inspectDsh(options), changed: false, backup_path: null };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const backup = original === null ? null : file + '.bak-mixrouter-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex');
  if (backup) {
    const fd = fs.openSync(backup, 'wx', 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, original); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  if (read(file) !== original) throw error('Harness 配置在同步期间改变，拒绝覆盖', 409);
  writeFileAtomic(file, output, { mode: 0o600 });
  return { ...inspectDsh(options), changed: true, backup_path: backup };
}

module.exports = { inspectDsh, syncDsh };
