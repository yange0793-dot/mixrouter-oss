'use strict';
// 模型方案:把选定客户端(claude / codex)当前的全部槽位原样存成一份快照,
// 之后可以预览差异、再整体切回。纯领域层:不读 HTTP、不写客户端配置。
//
// 边界(和 Bots 一样独立落盘,但语义不同):
//   · 方案只保存槽位本身:provider / model / pool / strategy / dropTools。
//     Key、Bots、会话、压缩设置、客户端目录与推理档位一律不在快照里。
//   · 应用方案只调用注入的 applySlots(主入口用 commitSlotUpdate(next, false)),
//     不写 ~/.claude/settings.json 或 ~/.codex/config.toml,也不热切换正在跑的请求。
//   · 预览纯只读;GET / 预览不会创建 profiles.json("无数据不写盘")。
//   · 文件损坏(JSON、版本、字段、槽位名、目录内重复 id)一律明确失败,**绝不覆盖**。
//   · 预览 / 应用的目标校验会明确指出被删除或停用的渠道与失效后备引用,
//     不做静默过滤 —— 静默丢掉一个后备成员,用户会在 402 之后才发现备池没了。
//
// 文件形状(与 bots.json / model-specs.json 同为 version 1,revision 不落盘):
//   {version: 1, profiles: [{id, name, apps, created_at, slots}]}
// revision 由内容规范序列化后算出,和 bots.json 的 revision 语义相同。
const fs = require('node:fs');
const crypto = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-write');
const { invalid, isObject } = require('./validation');
const { STRATEGIES } = require('./routing/strategy');
const { CLAUDE_SLOTS, CODEX_SLOT_NAME_RE } = require('./routing/slots');

const VERSION = 1;
const PROFILE_LIMIT = 30;
const NAME_LIMIT = 80;
const SLOT_FIELDS = ['provider', 'model', 'pool', 'strategy', 'dropTools'];
const APPS = ['claude', 'codex'];
const PROFILE_FIELDS = ['id', 'name', 'apps', 'created_at', 'slots'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;

const configError = () => Object.assign(new Error('方案配置损坏或无法读取，未改动原文件'), {
  statusCode: 500, code: 'PROFILES_CONFIG_INVALID',
});
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const missing = () => Object.assign(new Error('方案不存在'), { statusCode: 404 });
const writeError = () => Object.assign(new Error('写入方案配置失败，原配置未变'), { statusCode: 500 });

// 规范序列化:对象键排序,数组保序(pool / dropTools 的顺序有意义)。
// revision 用它算,因此手工调整键顺序不算一次内容变化。
function canonical(value) {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const profileRevision = profiles => digest(canonical({ version: VERSION, profiles }));

// 当前槽位表的 revision(只含两组槽位)。键顺序不影响结果;任何槽位内容变化都会换值。
function slotsRevision(slotMap) {
  const map = isObject(slotMap) ? slotMap : {};
  return digest(canonical({ claude: map.claude || {}, codex: map.codex || {} }));
}

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function slotNameError(app, name) {
  if (app === 'claude' && !CLAUDE_SLOTS.includes(name))
    return `方案里的 Claude 槽位名 "${name}" 无效`;
  if (app === 'codex' && !CODEX_SLOT_NAME_RE.test(name))
    return `方案里的 Codex 槽位名 "${name}" 无效`;
  return null;
}

// 单个槽位的白名单归一化。
//   strict=true  — 读盘 / 快照字段白名单:出现未知字段就报错(坏文件不覆盖)。
//   strict=false — 从活槽位表取快照:只挑白名单字段,未知字段忽略(未来新增字段不拖垮保存)。
function pickSlot(name, raw, strict) {
  if (!isObject(raw)) throw invalid(`方案里的槽位 "${name}" 不是对象`);
  if (strict) {
    const extra = Object.keys(raw).filter(key => !SLOT_FIELDS.includes(key));
    if (extra.length) throw invalid(`方案里的槽位 "${name}" 含不支持的字段: ${extra.join(', ')}`);
  }
  if (typeof raw.provider !== 'string' || !raw.provider)
    throw invalid(`方案里的槽位 "${name}" 缺少 provider`);
  const slot = { provider: raw.provider };
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string') throw invalid(`方案里的槽位 "${name}" 的 model 必须是字符串`);
    slot.model = raw.model;
  }
  if (raw.pool !== undefined) {
    if (!Array.isArray(raw.pool)) throw invalid(`方案里的槽位 "${name}" 的 pool 必须是数组`);
    slot.pool = raw.pool.map(member => {
      if (typeof member === 'string') {
        if (!member) throw invalid(`方案里的槽位 "${name}" 的 pool 成员不能为空`);
        return member;
      }
      if (!isObject(member)) throw invalid(`方案里的槽位 "${name}" 的 pool 成员无效`);
      if (strict) {
        const extra = Object.keys(member).filter(key => !['provider', 'model'].includes(key));
        if (extra.length)
          throw invalid(`方案里的槽位 "${name}" 的 pool 成员含不支持的字段: ${extra.join(', ')}`);
      }
      if (typeof member.provider !== 'string' || !member.provider)
        throw invalid(`方案里的槽位 "${name}" 的 pool 成员缺少 provider`);
      if (member.model !== undefined && typeof member.model !== 'string')
        throw invalid(`方案里的槽位 "${name}" 的 pool 成员 model 必须是字符串`);
      return member.model !== undefined
        ? { provider: member.provider, model: member.model }
        : { provider: member.provider };
    });
  }
  if (raw.strategy !== undefined) {
    if (!STRATEGIES.includes(raw.strategy))
      throw invalid(`方案里的槽位 "${name}" 的 strategy 只能是 ${STRATEGIES.join(' / ')}`);
    slot.strategy = raw.strategy;
  }
  if (raw.dropTools !== undefined) {
    if (!Array.isArray(raw.dropTools) || raw.dropTools.some(tool => typeof tool !== 'string' || !tool.trim()))
      throw invalid(`方案里的槽位 "${name}" 的 dropTools 必须是非空字符串数组`);
    slot.dropTools = [...raw.dropTools];
  }
  return slot;
}

// 整组槽位:空绑定(null / false)不是槽位,和 normalizeSlotsFile / slotsPublic 一样跳过。
function pickGroup(app, rawGroup, strict) {
  const group = {};
  for (const name of Object.keys(rawGroup || {})) {
    if (!rawGroup[name]) continue;
    const bad = slotNameError(app, name);
    if (bad) throw invalid(bad);
    group[name] = pickSlot(name, rawGroup[name], strict);
  }
  return group;
}

function readProfiles(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    // 文件不存在就是空表,而且**不落盘**:GET 不能因为用户看了一眼方案就创建配置文件。
    if (error.code === 'ENOENT') return { version: VERSION, revision: profileRevision([]), profiles: [] };
    throw configError();
  }
  try {
    const data = JSON.parse(text);
    if (!isObject(data) || data.version !== VERSION
        || Object.keys(data).some(key => !['version', 'profiles'].includes(key))
        || !Array.isArray(data.profiles) || data.profiles.length > PROFILE_LIMIT)
      throw new Error('shape');
    const profiles = data.profiles.map(normalizeProfile);
    const ids = new Set();
    for (const profile of profiles) {
      if (ids.has(profile.id)) throw new Error('duplicate');
      ids.add(profile.id);
    }
    return { version: VERSION, revision: profileRevision(profiles), profiles };
  } catch {
    throw configError();
  }
}

function normalizeProfile(raw) {
  if (!isObject(raw) || Object.keys(raw).some(key => !PROFILE_FIELDS.includes(key)))
    throw new Error('profile fields');
  if (typeof raw.id !== 'string' || !UUID_RE.test(raw.id)) throw new Error('id');
  const name = raw.name;
  if (typeof name !== 'string' || !name.trim() || name !== name.trim()
      || name.length > NAME_LIMIT || CONTROL_RE.test(name)) throw new Error('name');
  if (!Array.isArray(raw.apps) || !raw.apps.length || raw.apps.length > APPS.length
      || raw.apps.some(app => !APPS.includes(app)) || new Set(raw.apps).size !== raw.apps.length)
    throw new Error('apps');
  if (typeof raw.created_at !== 'string' || !TIME_RE.test(raw.created_at)
      || Number.isNaN(Date.parse(raw.created_at))) throw new Error('created_at');
  const apps = APPS.filter(app => raw.apps.includes(app));
  if (!isObject(raw.slots) || Object.keys(raw.slots).length !== apps.length
      || Object.keys(raw.slots).some(app => !apps.includes(app))) throw new Error('slots');
  const slots = {};
  for (const app of apps) {
    // 组本身必须是非数组对象。null / false / [] 若被当成空表放过去,一份损坏的文件
    // 就会变成"应用后清空整组槽位"的方案。
    if (!isObject(raw.slots[app])) throw new Error('slots group');
    slots[app] = pickGroup(app, raw.slots[app], true);
  }
  return { id: raw.id, name, apps, created_at: raw.created_at, slots };
}

function writeProfiles(file, profiles) {
  const revision = profileRevision(profiles);
  try { writeJsonAtomic(file, { version: VERSION, profiles }, { mode: 0o600 }); }
  catch { throw writeError(); }
  return { version: VERSION, revision, profiles };
}

// 活槽位的**展示/比较用**视图:只保留白名单字段,不做类型校验。
// 存在的理由有两个,都来自"活槽位是外部可写的":
//   · 预览的 before 会原样回给浏览器。手工改过 slots.json 的人可能在里面留下
//     api_key / base_url 之类字段,不筛就会经 /api/profiles/:id/preview 泄出去。
//   · 生效判定应当只看真正的绑定字段;多一个无关字段不该让方案显示成"不是当前"。
// 不校验类型:坏数据照样展示出来,让用户看见它坏了,而不是被静默吞成 null。
function liveSlotView(raw) {
  if (!isObject(raw)) return null;
  const slot = {};
  for (const field of SLOT_FIELDS) {
    if (raw[field] !== undefined) slot[field] = clone(raw[field]);
  }
  return slot;
}
function liveGroupView(rawGroup) {
  const group = {};
  for (const name of Object.keys(rawGroup || {})) {
    if (!rawGroup[name]) continue;
    const slot = liveSlotView(rawGroup[name]);
    if (slot) group[name] = slot;
  }
  return group;
}

// 当前活槽位是否与方案快照一致。比较用规范序列化,键顺序不影响;任何一组不一致就是 false。
function isActive(profile, slotMap) {
  return profile.apps.every(app => canonical(liveGroupView((slotMap || {})[app] || {}))
    === canonical(profile.slots[app]));
}

const publicRow = (profile, slotMap) => ({
  id: profile.id, name: profile.name, apps: [...profile.apps],
  created_at: profile.created_at, active: isActive(profile, slotMap),
});

function listProfiles(file, slotMap) {
  const data = readProfiles(file);
  return {
    revision: data.revision,
    profiles: data.profiles.map(profile => publicRow(profile, slotMap)),
    slots_revision: slotsRevision(slotMap),
  };
}

function createProfile(file, slotMap, input) {
  if (!isObject(input) || Object.keys(input).some(key => !['name', 'apps', 'expected_revision'].includes(key)))
    throw invalid('方案请求包含未知字段');
  const name = input.name;
  if (typeof name !== 'string' || !name.trim() || name !== name.trim()
      || name.length > NAME_LIMIT || CONTROL_RE.test(name))
    throw invalid(`方案名称必须是 1 到 ${NAME_LIMIT} 个字符，不能有前后空白或控制字符`);
  if (!Array.isArray(input.apps) || !input.apps.length || input.apps.length > APPS.length
      || input.apps.some(app => !APPS.includes(app)) || new Set(input.apps).size !== input.apps.length)
    throw invalid('方案范围只能是 claude、codex 中的一到两个');
  if (typeof input.expected_revision !== 'string') throw invalid('缺少 expected_revision');
  const data = readProfiles(file);
  if (input.expected_revision !== data.revision) throw conflict('方案配置已变化，请重新载入后再保存');
  if (data.profiles.length >= PROFILE_LIMIT) throw invalid(`最多保存 ${PROFILE_LIMIT} 个方案，请先删除不用的方案`);
  const apps = APPS.filter(app => input.apps.includes(app));
  const slots = {};
  // 保存只做快照,不校验渠道当前是否启用:停用的渠道可以在重新启用后再应用。
  for (const app of apps) slots[app] = pickGroup(app, (slotMap || {})[app] || {}, false);
  const profile = { id: crypto.randomUUID(), name, apps, created_at: new Date().toISOString(), slots };
  const profiles = [...data.profiles, profile];
  const written = writeProfiles(file, profiles);
  return {
    revision: written.revision,
    profiles: profiles.map(row => publicRow(row, slotMap)),
    slots_revision: slotsRevision(slotMap),
  };
}

// before / after 都是对象或 null(null = 该槽位只在一边存在)。
// 只比较方案范围内的客户端;范围外的槽位不会出现在 changes 里,也不会被应用改动。
function diffSlots(profile, slotMap) {
  const changes = [];
  for (const app of profile.apps) {
    const current = liveGroupView((slotMap || {})[app] || {});
    const target = profile.slots[app] || {};
    const names = [...new Set([...Object.keys(current), ...Object.keys(target)])]
      .filter(name => current[name] || target[name]).sort();
    for (const name of names) {
      const before = current[name] ? clone(current[name]) : null;
      const after = target[name] ? clone(target[name]) : null;
      if (canonical(before) !== canonical(after)) changes.push({ app, slot: name, before, after });
    }
  }
  return changes;
}

// 目标校验:明确点名被删除 / 停用 / 重复的渠道与失效后备引用,不静默过滤。
// 结构性检查复用主入口注入的 validateSlotPut(槽位名、渠道归属、pool 形状、strategy)。
// validateSlotPut 只报第一处,且与下面的逐槽检查在"渠道不存在"上重叠:先逐槽收集精确原因,
// 再把 validateSlotPut 的结论并进来 —— 它点到的槽已经报过就不再重复一句更模糊的。
function targetWarnings(profile, storeOf, validateSlotPut) {
  const warnings = [];
  const flagged = new Set();
  const groupOf = app => (typeof storeOf === 'function' ? storeOf(app) || [] : []);
  for (const app of profile.apps) {
    const group = profile.slots[app] || {};
    const label = app === 'claude' ? 'Claude' : 'Codex';
    for (const [name, slot] of Object.entries(group)) {
      const providers = groupOf(app).filter(provider => provider && provider.id === slot.provider);
      if (!providers.length) {
        warnings.push(`槽位 "${name}" 绑定的渠道 "${slot.provider}" 不在当前 ${label} 组或已删除`);
        flagged.add(name);
        continue;
      }
      if (providers.length > 1) {
        warnings.push(`槽位 "${name}" 绑定的渠道 "${slot.provider}" 在同一组内重复，无法确定落点`);
        flagged.add(name);
        continue;
      }
      if (providers[0].enabled === false) {
        warnings.push(`槽位 "${name}" 绑定的渠道 "${slot.provider}" 已停用`);
        flagged.add(name);
      }
      for (const member of Array.isArray(slot.pool) ? slot.pool : []) {
        const id = typeof member === 'string' ? member : member.provider;
        const matches = groupOf(app).filter(provider => provider && provider.id === id);
        if (!matches.length) warnings.push(`槽位 "${name}" 的后备渠道 "${id}" 不在当前组或已删除`);
        else if (matches.length > 1) warnings.push(`槽位 "${name}" 的后备渠道 "${id}" 在同一组内重复`);
        else if (matches[0].enabled === false) warnings.push(`槽位 "${name}" 的后备渠道 "${id}" 已停用`);
      }
    }
    if (typeof validateSlotPut === 'function') {
      const message = validateSlotPut({ [app]: clone(group) });
      // 形状类错误(槽位名 / pool 不是数组 / strategy 未知)这里不重复实现,原样带出;
      // 只是"某槽渠道不对"且该槽已经报过精确原因时,不再叠一句。
      const mentioned = [...String(message || '').matchAll(/槽位 "([^"]+)"/g)].map(hit => hit[1]);
      if (message && !(mentioned.length && mentioned.every(name => flagged.has(name))))
        warnings.push(message);
    }
  }
  return warnings;
}

function previewProfile(file, slotMap, id, storeOf, validateSlotPut) {
  const data = readProfiles(file);
  const profile = data.profiles.find(row => row.id === id);
  if (!profile) throw missing();
  const warnings = targetWarnings(profile, storeOf, validateSlotPut);
  return {
    id: profile.id,
    name: profile.name,
    expected_revision: data.revision,
    slots_revision: slotsRevision(slotMap),
    changes: diffSlots(profile, slotMap),
    warnings,
    can_apply: warnings.length === 0,
  };
}

// 应用:两份 revision 都必须在预览之后没变,目标仍通过校验,才交给注入的 applySlots。
// 只替换方案范围内的组;范围外的组原样保留。不写客户端配置、不碰在途请求。
function applyProfile(file, slotMap, id, input, deps) {
  const { storeOf, validateSlotPut, applySlots } = deps;
  if (!isObject(input) || Object.keys(input).some(key => !['confirm', 'expected_revision', 'slots_revision'].includes(key)))
    throw invalid('应用方案请求包含未知字段');
  if (input.confirm !== true) throw invalid('应用方案须明确确认');
  if (typeof input.expected_revision !== 'string') throw invalid('缺少 expected_revision');
  if (typeof input.slots_revision !== 'string') throw invalid('缺少 slots_revision');
  const data = readProfiles(file);
  const profile = data.profiles.find(row => row.id === id);
  if (!profile) throw missing();
  if (input.expected_revision !== data.revision) throw conflict('方案配置已变化，请重新预览后再应用');
  if (input.slots_revision !== slotsRevision(slotMap)) throw conflict('槽位已在预览后变化，请重新预览');
  const warnings = targetWarnings(profile, storeOf, validateSlotPut);
  if (warnings.length) throw invalid('方案无法应用: ' + warnings.join('; '));
  const next = clone(isObject(slotMap) ? slotMap : {});
  for (const app of profile.apps) next[app] = clone(profile.slots[app]);
  try { applySlots(next); }
  catch (error) {
    if (error && error.statusCode) throw error;
    throw Object.assign(new Error('应用方案失败，槽位未变: ' + ((error && error.message) || error)), { statusCode: 500 });
  }
  return { ok: true, id: profile.id, name: profile.name, apps: [...profile.apps] };
}

function deleteProfile(file, id, input) {
  if (!isObject(input) || Object.keys(input).some(key => !['expected_revision', 'confirm'].includes(key)))
    throw invalid('删除方案请求包含未知字段');
  if (input.confirm !== true) throw invalid('删除方案须明确确认');
  if (typeof input.expected_revision !== 'string') throw invalid('缺少 expected_revision');
  const data = readProfiles(file);
  if (input.expected_revision !== data.revision) throw conflict('方案配置已变化，请重新载入后再删除');
  if (!data.profiles.some(profile => profile.id === id)) throw missing();
  const profiles = data.profiles.filter(profile => profile.id !== id);
  const written = writeProfiles(file, profiles);
  return { ok: true, revision: written.revision };
}

module.exports = {
  VERSION, PROFILE_LIMIT, NAME_LIMIT, SLOT_FIELDS,
  readProfiles, writeProfiles, profileRevision, slotsRevision, listProfiles,
  createProfile, previewProfile, applyProfile, deleteProfile,
};
