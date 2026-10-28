'use strict';
// 模型槽位:常量表、精确别名、解析、写入校验、公开视图。
// 槽位表由调用方持有;本模块不读盘、不写盘,保存与回滚由调用方编排。
// 依赖只有三个纯读访问器,由 createSlotTable 注入。
const { invalid, isObject } = require('../validation');
// strategy 也是叶子模块(纯函数,require 时不读盘不起服务)。槽位的 strategy 校验要用它的
// STRATEGIES 白名单 —— 抄一份常量到这里会与真值漂移。
const { STRATEGIES } = require('./strategy');

// Claude 组固定五个槽(别名 mixr-<槽名> 写进客户端 env);Codex 组槽名自拟。
// fable 槽已移除:当前接法不消费其 env 映射,不再由 split 重建该槽。
const CLAUDE_SLOTS = ['main', 'opus', 'sonnet', 'haiku', 'subagent'];
const CLAUDE_SLOT_ENV = {
  main: 'ANTHROPIC_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  subagent: 'CLAUDE_CODE_SUBAGENT_MODEL',
};
// 渠道级模型映射(cc-switch 同款):直连「切换」时写入对应 env,值可带 [1M] 能力声明
const CLAUDE_SLOT_KEYS = ['opus', 'sonnet', 'haiku', 'subagent'];
const CODEX_SLOT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

// 注意:app 形参当前未被读取(别名不含组名)。**保留不改**:调用点在本模块之外有 6 处,
// 全在 mixrouter.js;改签名要连带改那一侧,留作后续单独清理。
const slotAlias = (app, name) => 'mixr-' + name;

// Claude 兼容别名:Claude Desktop 只接受名字里含 claude / opus / sonnet 的网关模型,
// 所以 Claude 组在规范别名 mixr-<槽名> 之外再精确接受 claude-mixr-<槽名>。
// 规范别名不变:客户端 env、直连清理与 rule.match 仍写 mixr-<槽名>。
// 只加在 Claude 组 —— Codex 组不认这个前缀,免得两组别名互相串。
const CLAUDE_COMPAT_PREFIX = 'claude-mixr-';
const slotAliases = (app, name) => app === 'claude'
  ? [slotAlias(app, name), CLAUDE_COMPAT_PREFIX + name]
  : [slotAlias(app, name)];

// 请求里的 [1m] 上下文标记(例如桌面别名 claude-mixr-main[1m])只改窗口大小,不改路由。
// 匹配槽位前先剥掉它,否则同一个槽会因为客户端多写一个后缀而落空。
const stripContextSuffix = value => String(value || '').trim().toLowerCase().replace(/\[1m\]$/, '');

// 请求模型名 → 槽名。只负责剥前缀并归一化,**不校验槽是否存在**
// (调用方拿槽位表或 CLAUDE_SLOTS 做精确比对)。不在别名前缀里的返回 null。
function slotNameFromAlias(app, modelIn) {
  const m = stripContextSuffix(modelIn);
  if (m.startsWith('mixr-')) return m.slice('mixr-'.length);
  if (app === 'claude' && m.startsWith(CLAUDE_COMPAT_PREFIX)) return m.slice(CLAUDE_COMPAT_PREFIX.length);
  return null;
}

// 渠道级 slots 归一化(渠道 CRUD 路径用,不属于槽位表解析)。
const normalizeChannelSlots = slots => {
  // 传了非对象(字符串/数字/数组)就明确报错。以前这里是 `typeof slots === 'object' ? slots : {}`,
  // 于是 {slots:"nope"} 会把该渠道**所有槽位一次清空**并回 200:用户以为自己改的是某一样,
  // 实际把整组映射抹平了,而且没有任何提示。
  if (slots !== undefined && slots !== null && (typeof slots !== 'object' || Array.isArray(slots)))
    throw invalid('slots 必须是对象(键为槽位名,值为模型名)');
  const src = (slots && typeof slots === 'object') ? slots : {};
  const out = {};
  for (const k of CLAUDE_SLOT_KEYS) {
    const v = src[k];
    if (v === undefined || v === null || v === '') { out[k] = ''; continue; }
    if (typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v)))
      throw invalid(`slots.${k} 必须是字符串`);
    out[k] = String(v).trim();
  }
  return out;
};

// 旧版本可能留下 fable 等废弃槽;只隐藏公开视图不够,resolveSlot 仍会命中它们。
// 加载时按当前槽名清理,保留有效绑定的全部字段;下次正常保存才落盘,这里不做 I/O。
function sanitizeClaudeSlots(claudeRaw) {
  const src = (claudeRaw && typeof claudeRaw === 'object') ? claudeRaw : {};
  const out = {};
  for (const name of CLAUDE_SLOTS) if (Object.hasOwn(src, name) && src[name]) out[name] = src[name];
  return out;
}

// slots.json 的**内容**归一化(纯转换)。读盘由调用方做,故这里收已解析的 JSON。
// Claude 只保留当前固定槽;Codex 自定义槽不参与这次清理。
const normalizeSlotsFile = raw => ({
  claude: sanitizeClaudeSlots(raw && raw.claude),
  codex: (raw && typeof raw.codex === 'object' && raw.codex) || {},
});

// deps(全部纯读,不写任何状态):
//   storeOf(app)   → 该组渠道数组
//   findProvider(id) → 渠道或 null
//   providerApp(id)  → 'claude' / 'codex' / null
function createSlotTable(deps) {
  const { storeOf, findProvider, providerApp } = deps;

  const effectiveModel = (app, slot, provider) => (slot && slot.model) ||
    (provider && (app === 'codex' ? provider.model : (Array.isArray(provider.models) && provider.models[0]))) || '';

  // 请求模型名 → 命中的槽位。返回 null 表示未命中槽位,由调用方检查登记模型。
  // 命中判据是槽名对应的**精确别名**:规范别名 mixr-<槽名> 与 Claude 兼容别名
  // claude-mixr-<槽名> 都算,二者返回同一个 rule(id 仍是 slot:<组>/<槽名>)。
  // 两组都优先用槽位选定模型;空串继承渠道默认(Claude models[0],Codex model)。
  function resolveSlot(slotMap, app, modelIn) {
    const m = stripContextSuffix(modelIn);
    const reg = (slotMap || {})[app] || {};
    for (const name of Object.keys(reg)) {
      if (!slotAliases(app, name).includes(m)) continue;
      const s = reg[name];
      if (!s || !s.provider) continue;
      const group = storeOf(app);
      const p = group.find(x => x.id === s.provider) || null;
      const model = effectiveModel(app, s, p);
      // 槽位备池:主渠道 `provider` 不变,可选 `pool` 给同一落点模型配后备渠道。
      // 没有池时行为与以前逐字节相同(pool: [] → membersFor 只返回主渠道这 1 个成员)。
      // 有了池,402/429/5xx 才有"换一家重打"的余地 —— resolve.js 里槽位"优先于一切规则",
      // 一旦命中就直接返回,所以池成员只能在**这里**进 rule,别处补不进去。
      //
      // ⚠ poolMembers 的语义是"pool 为空时才用 rule.provider 兜底"——所以池里**必须**
      // 写全所有候选(含主渠道),只写后备渠道会让主渠道整个消失(实测:配 1 个后备 → 池里只剩它)。
      // 主渠道由这里排到池首,保证 priority 策略下它仍是主选。
      const rawPool = Array.isArray(s.pool) ? s.pool : [];
      const pool = [];
      if (rawPool.length) {
        pool.push({ provider: s.provider, model });      // 主渠道置首
        for (const pm of rawPool) {
          const id = typeof pm === 'string' ? pm : (pm && pm.provider);
          if (!id || id === s.provider) continue;
          const pv = group.find(x => x.id === id);
          if (!pv || pv.enabled === false) continue;     // 停用的备渠道直接跳过,池的意义就是绕开不可用的
          const pmModel = (typeof pm === 'object' && pm && pm.model) ? pm.model : model;
          pool.push({ provider: id, model: pmModel });
        }
      }
      return {
        name,
        provider: p,
        model,
        // rule.model 带上落点模型,poolMembers 才能把 Claude 槽的模型送进转发(空 = 透传别名)
        rule: {
          id: `slot:${app}/${name}`, match: slotAlias(app, name), provider: s.provider,
          model, pool: pool.length > 1 ? pool : [], strategy: pool.length > 1 ? (s.strategy || 'priority') : 'round_robin',
          priority: 1000, app, when: {}, enabled: true,
        },
      };
    }
    return null;
  }

  // 槽位写入校验:返回错误文案或 null。body 形如 {claude:{opus:{provider,model}|null}, codex:{...}}
  // 注意:本函数**不读槽位表**,只校验入参形状与渠道引用。
  function validateSlotPut(body) {
    for (const app of ['claude', 'codex']) {
      const patch = body[app];
      if (patch === undefined) continue;
      if (!isObject(patch)) return `${app} 槽位必须是对象`;
      for (const [name, val] of Object.entries(patch)) {
        if (app === 'claude' && !CLAUDE_SLOTS.includes(name))
          return `Claude 槽位只能是 ${CLAUDE_SLOTS.join(' / ')},收到 "${name}"`;
        if (app === 'codex' && !CODEX_SLOT_NAME_RE.test(name))
          return `Codex 槽位名只能用小写字母、数字、连字符(≤24 位),收到 "${name}"`;
        if (val === null) continue;
        if (!isObject(val) || !val.provider || typeof val.provider !== 'string')
          return `槽位 "${name}" 必须是 {provider, model} 或 null`;
        if (!findProvider(val.provider) || providerApp(val.provider) !== app)
          return `槽位 "${name}" 绑定的渠道不存在(须为 ${app === 'codex' ? 'Codex' : 'Claude'} 组渠道)`;
        if (val.model !== undefined && typeof val.model !== 'string')
          return `槽位 "${name}" 的 model 必须是字符串`;
        // dropTools:字符串数组(工具名或尾通配 'mcp__*')。不校验就会带着坏值进转发,
        // 到请求时才以"工具没剥掉"的形式静默失效——查起来要翻日志才知道配错了。
        if (val.dropTools !== undefined) {
          if (!Array.isArray(val.dropTools) || val.dropTools.some(x => typeof x !== 'string' || !x.trim()))
            return `槽位 "${name}" 的 dropTools 必须是非空字符串数组(工具名,或尾部通配如 "mcp__*")`;
        }
        // pool:槽位的后备渠道(可选)。指向不存在的渠道必须当场拒——存进去之后
        // resolveSlot 会静默跳过它,用户以为配了备池、实际单点,只有打上去 402 才发现。
        if (val.pool !== undefined) {
          if (!Array.isArray(val.pool))
            return `槽位 "${name}" 的 pool 必须是数组(元素为渠道 id 或 {provider, model})`;
          for (const pm of val.pool) {
            const id = typeof pm === 'string' ? pm : (pm && isObject(pm) ? pm.provider : null);
            if (!id || typeof id !== 'string')
              return `槽位 "${name}" 的 pool 成员必须是渠道 id 字符串或 {provider, model}`;
            if (!findProvider(id) || providerApp(id) !== app)
              return `槽位 "${name}" 的 pool 成员 ${id} 不是本组渠道(须为 ${app === 'codex' ? 'Codex' : 'Claude'} 组)`;
            if (isObject(pm) && pm.model !== undefined && typeof pm.model !== 'string')
              return `槽位 "${name}" 的 pool 成员 ${id} 的 model 必须是字符串`;
          }
        }
        if (val.strategy !== undefined && !STRATEGIES.includes(val.strategy))
          return `槽位 "${name}" 的 strategy 只能是 ${STRATEGIES.join(' / ')}`;
      }
    }
    return null;
  }

  // 由 body 算出「主槽 + 子代理」的槽位补丁。纯函数:只读槽位表与渠道表,不写任何状态。
  // 落盘与客户端切换由调用方(configureClaudeSplit)编排。
  function claudeSplitPatch(slotMap, body) {
    const bad = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
    const target = (value, label) => {
      if (!isObject(value) || typeof value.provider !== 'string' ||
          typeof value.model !== 'string' || !value.model.trim()) bad(`${label} 必须指定 provider 和 model`);
      const provider = storeOf('claude').find(p => p.id === value.provider);
      if (!provider || provider.enabled === false) bad(`${label} 必须选择已启用的 Claude 组渠道`);
      return { provider: provider.id, model: value.model.trim() };
    };
    if (body.apply !== undefined && typeof body.apply !== 'boolean') bad('apply 必须是布尔值');
    const subagent = target(body.subagent, '子代理');
    if (body.main === undefined) {
      // 刻意与原实现逐字一致:**不**给 slotMap.claude 加 `|| {}` 兜底。
      // 加了会让"缺 claude 键"时从 TypeError 变成 400,而那是一次行为变更(搬迁等价性
      // 实测会红:982 checks 里出 1 条 mismatch)。生产上 slotMap 恒由 loadSlots() 构造、
      // 保证 claude 是对象,故该兜底不可达;真要加固应另起一批并配自己的断言,不混在纯搬迁里。
      const fixed = CLAUDE_SLOTS.filter(n => n !== 'subagent').map(n => slotMap.claude[n]);
      if (fixed.some(s => !s || !s.provider || !s.model) ||
          fixed.some(s => s.provider !== fixed[0].provider || s.model !== fixed[0].model))
        bad('请先指定 main 建立统一主槽，再单独切换 subagent');
      target(fixed[0], '主槽');
      return { subagent };
    }
    const main = target(body.main, '主槽');
    // 保留各槽原有的 pool / strategy / dropTools:整体替换会把用户配好的备池和剥离规则
    // 一起抹掉,而且是静默的 —— 打上去 402 才发现备池没了,那时已经晚了一步。
    return Object.fromEntries(CLAUDE_SLOTS.map(n => {
      const prev = slotMap.claude[n] || {};
      const next = { ...(n === 'subagent' ? subagent : main) };
      if (Array.isArray(prev.pool) && prev.pool.length) {
        // 备池只在它仍属于同一落点模型时才保留:换了模型,旧备池就是配错的了
        const sameModel = (n === 'subagent' ? subagent : main).model === prev.model;
        if (sameModel) {
          next.pool = prev.pool;
          if (prev.strategy) next.strategy = prev.strategy;
        }
      }
      if (Array.isArray(prev.dropTools) && prev.dropTools.length) next.dropTools = prev.dropTools;
      return [n, next];
    }));
  }

  // 控制台用:槽位一览(带渠道名/落点模型/停用状态;不含密钥)
  function slotsPublic(slotMap) {
    const map = slotMap || {};
    const entry = (app, name) => {
      const s = (map[app] || {})[name];
      const p = s && s.provider ? findProvider(s.provider) : null;
      const model = effectiveModel(app, s, p);
      const pool = (s && Array.isArray(s.pool)) ? s.pool : [];
      return {
        name, alias: slotAlias(app, name), env: app === 'claude' ? CLAUDE_SLOT_ENV[name] : '',
        provider: s ? s.provider : '', provider_name: p ? p.name : '',
        enabled: !!p && p.enabled !== false, model,
        configured_model: (s && typeof s.model === 'string') ? s.model : '',
        // 回给控制台,一是让剥离规则可见,二是防止 UI 保存 provider/model 时把它当未知字段丢掉
        dropTools: (s && Array.isArray(s.dropTools)) ? s.dropTools : [],
        // 备池同理:不回给控制台,UI 一保存就把它抹了(备池静默消失,402 时才发现)
        pool: pool.map(x => (typeof x === 'string' ? { provider: x } : { ...x })),
        strategy: (s && s.strategy) || (pool.length ? 'priority' : 'round_robin'),
      };
    };
    return {
      claude: CLAUDE_SLOTS.map(n => entry('claude', n)),
      codex: Object.keys(map.codex || {}).filter(n => map.codex[n]).map(n => entry('codex', n)),
    };
  }

  return { resolveSlot, validateSlotPut, claudeSplitPatch, slotsPublic };
}

module.exports = {
  CLAUDE_SLOTS, CLAUDE_SLOT_ENV, CLAUDE_SLOT_KEYS, CODEX_SLOT_NAME_RE, CLAUDE_COMPAT_PREFIX,
  slotAlias, slotAliases, slotNameFromAlias, stripContextSuffix, normalizeChannelSlots, sanitizeClaudeSlots,
  normalizeSlotsFile, createSlotTable,
};
