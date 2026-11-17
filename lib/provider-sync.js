'use strict';
// 渠道跨组同步:把一条渠道复制到另一组(Claude ↔ Codex),免去同一个上游两边各填一遍。
//
// 两组的字段并不对称,复制时按目标端的需要换算:
//   · 地址:Codex 把 base_url 原样写进 config.toml,请求拼在它后面(/responses);
//     Claude Code 在 ANTHROPIC_BASE_URL 后面拼 /v1/messages。所以同一台上游两侧的
//     习惯写法差一个 /v1:去 Codex 补齐,回 Claude 去掉,自定义路径前缀保持不动。
//   · 模型:Claude 只有 models[],Codex 还必须有单个 model —— 取 Claude 的第一项
//     (与「第一项当主模型」同一口径);回 Claude 时把 model 并进 models 去重。
//   · 协议:Codex 只认 responses/chat;Claude 的 anthropic 渠道复制过去就是 responses。
//     chat 渠道在 Codex 只能走路由(codex_mode=router),其余默认直连。
//   · Key 清单、生效账号、备注、寻址别名、Key 回退、出站代理原样带走。
//
// 目标组里已有同址渠道(比较时忽略末尾 /v1 与斜杠)时就地更新,不重复创建:
// 保留目标端的 id、创建时间、启用状态、Claude 槽位分配与 Codex 接入方式/纯文本开关,
// 其余连接信息以源渠道为准。

const { validBaseUrl } = require('./routing/headers');
const { normalizeChannelSlots } = require('./routing/slots');
const { modelsOf } = require('./model-probe');

const trimBase = value => String(value ?? '').trim().replace(/\/+$/, '');
const splitQuery = value => {
  const cut = value.search(/[?#]/);
  return cut < 0 ? [value, ''] : [value.slice(0, cut), value.slice(cut)];
};

function syncBaseUrl(baseUrl, toApp) {
  // 只在路径上增删 /v1:查询串/片段原样留在末尾,不能把 /v1 拼到 ? 后面去。
  const [raw, suffix] = splitQuery(String(baseUrl ?? '').trim());
  const clean = trimBase(raw);
  const path = toApp === 'codex'
    ? (clean.endsWith('/v1') ? clean : clean + '/v1')
    : clean.replace(/\/v1$/, '');
  return path + suffix;
}

// 同址判定只用于找已有副本:/v1 在两侧本来就写法不同,不算不同的上游;
// 查询串/片段不影响上游判定,也比较时忽略。
const baseKey = value => {
  const [raw] = splitQuery(String(value ?? '').trim());
  const clean = trimBase(raw).replace(/\/v1$/, '');
  try {
    const url = new URL(clean);
    return url.origin + url.pathname;
  } catch { return clean; }
};

function findSyncTarget(list, source, toApp) {
  const wanted = baseKey(syncBaseUrl(source.base_url, toApp));
  const candidates = (list || []).filter(p => p && baseKey(p.base_url) === wanted);
  if (candidates.length <= 1) return candidates[0] || null;
  // 同一个上游可能挂多条不同账号的渠道:先按生效 Key 认领,再按名称认领;
  // 都对不上就不猜,另建一条 —— 不能把另一份账号的 Key 清单悄悄覆盖掉。
  const key = typeof source.api_key === 'string' ? source.api_key : '';
  const byKey = key ? candidates.filter(p => p.api_key === key) : [];
  if (byKey.length === 1) return byKey[0];
  const name = String(source.name || '').trim().toLowerCase();
  const byName = candidates.filter(p => String(p.name || '').trim().toLowerCase() === name);
  return byName.length === 1 ? byName[0] : null;
}

// 构造复制出来的目标端渠道(已含 id 之外的全部字段)。返回 { provider } 或 { error }。
function buildSyncedProvider(source, toApp, { id, now = new Date() } = {}) {
  if (!validBaseUrl(source.base_url)) return { error: '源渠道的 Base URL 不是合法的 http(s) 地址，未同步' };
  // 模型名收敛与模型测活同口径(modelsOf:只收字符串、去空白重复、限长),
  // 避免同步出一个测活和路由都看不见的默认模型。Codex 的 model 在列表末尾,Claude 没有独立 model 字段。
  const models = modelsOf(source);
  const common = {
    name: String(source.name || '').trim(),
    base_url: syncBaseUrl(source.base_url, toApp),
    api_key: typeof source.api_key === 'string' ? source.api_key : '',
    enabled: source.enabled !== false,
    note: typeof source.note === 'string' ? source.note : '',
    created_at: now.toISOString(),
  };
  if (id) common.id = id;
  if (Array.isArray(source.keys) && source.keys.length) common.keys = source.keys.map(key => ({ ...key }));
  if (typeof source.active_key === 'string' && source.active_key) common.active_key = source.active_key;
  if (typeof source.slug === 'string' && source.slug) common.slug = source.slug;
  if (source.key_fallback === true) common.key_fallback = true;
  if (source.direct === true) common.direct = true;
  if (typeof source.proxy_url === 'string' && source.proxy_url) common.proxy_url = source.proxy_url;

  if (toApp === 'codex') {
    // Codex 渠道必须有一个模型名;没有就不能同步,让用户先在源渠道里补。
    if (!models.length) return { error: '该渠道没有登记模型名，Codex 渠道必须有一个模型名；先在渠道编辑里补一个再同步' };
    const wire = source.wire_api === 'chat' ? 'chat' : 'responses';
    return { provider: { ...common, model: models[0], models, wire_api: wire,
      codex_mode: wire === 'chat' ? 'router' : 'direct' } };
  }
  // Codex 的 model 是渠道默认模型,回 Claude 时排第一(Claude 第一项即主模型)。
  const main = models.find(name => name === String(source.model ?? '').trim());
  const modelsOut = main ? [main, ...models.filter(name => name !== main)] : models;
  if (!modelsOut.length) return { error: '该渠道没有登记模型名，同步到 Claude 后无法路由；先在渠道编辑里补一个再同步' };
  return { provider: { ...common, models: modelsOut, slots: normalizeChannelSlots(), ua: '',
    // Codex 上游只讲 OpenAI 协议:回 Claude 侧由 Mixrouter 现场翻译。
    wire_api: source.wire_api === 'chat' ? 'chat' : 'responses' } };
}

// 就地更新已有副本:以复制结果为准,但保留目标端自己的本地状态。
function mergeSyncedProvider(previous, built, toApp) {
  const merged = { ...built, id: previous.id, created_at: previous.created_at || built.created_at,
    enabled: previous.enabled !== false };
  if (!merged.slug && previous.slug) merged.slug = previous.slug;
  if (toApp === 'claude') {
    merged.slots = previous.slots || merged.slots;   // 槽位分配属于目标端,不在同步范围
    merged.ua = previous.ua || merged.ua;
  } else {
    merged.codex_mode = merged.wire_api === 'chat' ? 'router'
      : (previous.codex_mode === 'router' ? 'router' : 'direct');
    if (previous.drop_images === true) merged.drop_images = true;
  }
  // 源渠道没填的连接字段保留目标端原值:尤其是一条必须先走代理才能连通的渠道,
  // 不能因为源端没填 proxy_url 就被同步清空、随后直连失败。
  if (!('proxy_url' in built) && !('direct' in built)) {
    if (previous.direct === true) merged.direct = true;
    else if (typeof previous.proxy_url === 'string' && previous.proxy_url) merged.proxy_url = previous.proxy_url;
  }
  // 同理:源渠道只有单 Key 时不覆盖目标端的多账号清单;api_key 仍等于生效那把。
  if (!('keys' in built) && Array.isArray(previous.keys) && previous.keys.length) {
    const ring = previous.keys;
    const active = ring.find(key => key.id === previous.active_key && key.enabled !== false)
      || ring.find(key => key.enabled !== false) || ring[0];
    merged.keys = ring;
    merged.active_key = active.id;
    merged.api_key = active.key;
  }
  return merged;
}

module.exports = { syncBaseUrl, buildSyncedProvider, findSyncTarget, mergeSyncedProvider };
