'use strict';
// P3 可选多 Key 自动备用(默认关闭)。
//
// 职责边界:
//   · 只回答"这一次尝试该用哪把 Key"和"这一发失败后还能不能换号";
//   · 不写渠道库、不改 active_key / 模型落点、不落盘;返回的 provider 是**副本**,
//     api_key 只在这条请求里被替换(与 session-config.js 的固定 Key 路径同一做法);
//   · provider.key_fallback !== true 时所有入口原样返回,不记录任何状态 —— 默认完全不变;
//   · 会话/压缩固定 Key(pinned)永远不换;会话粘性 Key 被删除/停用时**抛明确错误**,
//     不静默改号、不悄悄回落到渠道当前生效 Key。
//   · **没有时间冷却**:失败只把该 Key 记进本次请求的 failedKeys 集合,新请求与并发请求
//     立即可用同一把 Key;不解析 Retry-After、不产生 wait_ms。剩余的重试节奏完全由
//     lib/proxy/attempts.js 的 MIXR_MAX_ATTEMPTS / MIXR_RETRY_DELAY_MS / 总预算决定。
//   · 状态表只保留**诊断记录**(范围、状态码、时间),有界且只在内存;成功即清掉对应记录。
//

const { ringOf } = require('./keys');
const { hasCtlChar } = require('./headers');
const crypto = require('node:crypto');

const SEP = '\u0000';
const ACCOUNT_MODEL = '*';
const KEY_SOURCE_FALLBACK = 'key_fallback';
const STATUS_TEXT_MAX = 200;

const SCOPE_ACCOUNT = 'account';
const SCOPE_MODEL = 'model';
const SCOPE_NONE = 'none';

const positiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

// 模型名只当**状态表的键**用:去掉控制字符并截断,不参与任何上游字段。
const modelText = value => (typeof value === 'string'
  ? value.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, STATUS_TEXT_MAX)
  : '');

const idText = value => (typeof value === 'string' ? value : '');

function isEnabled(provider) {
  return !!provider && provider.key_fallback === true;
}

// 可用 Key 清单。判据与 lib/routing/keys.js 的 resolveKey 对齐:停用、空 Key、
// 控制字符、重复 id 一律不算候选 —— 重复 id 的账号本来就没法被明确点名。
function usableRing(provider) {
  const ring = ringOf(provider);
  const counts = new Map();
  for (const k of ring) {
    if (!k || typeof k.id !== 'string' || hasCtlChar(k.id)) continue;
    counts.set(k.id, (counts.get(k.id) || 0) + 1);
  }
  const out = [];
  for (const k of ring) {
    if (!k || typeof k.id !== 'string' || !k.id.trim() || hasCtlChar(k.id)) continue;
    if (counts.get(k.id) !== 1) continue;
    if (k.enabled === false) continue;
    if (typeof k.key !== 'string' || !k.key.trim() || hasCtlChar(k.key)) continue;
    out.push(k);
  }
  return out;
}

// 偏好顺序:渠道当前生效 Key 优先,其余按清单顺序。只是**候选顺序**,
// 不会写回 active_key。
function preferenceOrder(provider, ring) {
  const ids = ring.map(k => k.id);
  const active = idText(provider && provider.active_key);
  if (!active || !ids.includes(active)) return ids;
  return [active, ...ids.filter(id => id !== active)];
}

// 失败状态表的两把键:账号级(model='*')与模型级(该模型名)。
const stateKey = (providerId, keyId, scopeModel) => `${providerId}${SEP}${keyId}${SEP}${scopeModel}`;

function createKeyFallback(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxEntries = positiveInt(options.maxEntries, 1000);

  // providerId+keyId+scopeModel -> 失败记录。插入顺序当年龄用,更新时先删后插。
  const failures = new Map();
  // providerId+sessionKey -> { key_id, updated_at }。只用于账号粘性,不含任何 Key 明文。
  const sticky = new Map();

  // 会话键只当内存表的键用,所以取**定长摘要**而不是截断:
  //   · 截断会让"前 256 字符相同"的两个不同会话撞成同一个粘性条目,于是 A 会话换号后
  //     B 会话直接继承它的账号 —— 静默的跨会话串号;
  //   · 不截断又会让客户端可控的键按会话数放大内存。
  // 摘要同时解决两件事:定长(64 个十六进制字符)且不同会话键不会相同。
  // 这里只产出摘要,原文不落任何表、不进日志、不进 /api/keys/health。
  const sessionText = value => (typeof value === 'string' && value
    ? crypto.createHash('sha256').update(value).digest('hex')
    : '');

  // 有界:优先淘汰最旧的失败记录;没有失败记录时再淘汰最旧的粘性记录。
  function trim() {
    while (failures.size + sticky.size > maxEntries) {
      const first = failures.keys().next();
      if (!first.done) { failures.delete(first.value); continue; }
      const next = sticky.keys().next();
      if (next.done) break;
      sticky.delete(next.value);
    }
  }

  function setFailure(record) {
    const k = stateKey(record.provider, record.key_id, record.scope === SCOPE_ACCOUNT ? ACCOUNT_MODEL : record.model);
    // 先删再插:Map 的插入顺序要反映"最近一次失败",淘汰时才是真的最旧。
    const previous = failures.get(k);
    failures.delete(k);
    failures.set(k, {
      ...record,
      // 记录上的 failures 是累计失败次数(接口字段名),不是这张表本身
      failures: (previous ? previous.failures : 0) + 1,
    });
    trim();
  }

  // 本次请求内是否还可以用这把 Key:只有 failedKeys(请求级排除集)会让它为 false。
  const usableThisRequest = (providerId, keyId, model, failedKeys) => !(failedKeys instanceof Set
    && (failedKeys.has(stateKey(providerId, keyId, ACCOUNT_MODEL)) || failedKeys.has(stateKey(providerId, keyId, model))));

  function setSticky(providerId, sessionKey, keyId) {
    const k = `${providerId}${SEP}${sessionKey}`;
    sticky.delete(k);
    sticky.set(k, { key_id: keyId, updated_at: now() });
    trim();
  }

  function stickyOf(providerId, sessionKey) {
    if (!sessionKey) return null;
    return sticky.get(`${providerId}${SEP}${sessionKey}`) || null;
  }

  // 不改 provider 本体:只把这一发要用的 Key 放进副本,与固定 Key 路径同形。
  function choiceWith(provider, key, meta) {
    return {
      provider: { ...provider, api_key: key.key },
      key_id: key.id,
      key_source: KEY_SOURCE_FALLBACK,
      pinned: false,
      fallback: meta,
    };
  }

  const unchanged = (choice, meta) => (choice && typeof choice === 'object'
    ? { ...choice, fallback: meta }
    : choice);

  // 粘性 Key 被删除/停用:请求已经按这把账号跑过(或正要跑),此时换号等于在
  // 用户不知情的情况下改了会话身份。明确失败,让用户去控制台修。
  function stickyUnavailable(provider, keyId) {
    const err = new Error(`会话粘定的 Key "${keyId}" 在该渠道已删除或停用,请求未发出。请到控制台「渠道与 Key」检查该渠道的 Key 清单`);
    err.statusCode = 503;
    err.code = 'provider_key_unavailable_error';
    err.type = 'provider_key_unavailable_error';
    err.key_id = keyId;
    err.provider = idText(provider && provider.id);
    return err;
  }

  // ⚠ sessionKey 必须是调用方的**完整会话身份键**(会话存储与在途 guard 用的那一把,
  //   如 ident.key),不能传日志里的短键(形如 sessionKeyOf(ident.key) 的 8 位截断)。
  //   粘性表按 provider+sessionKey 索引:传短键会让前 8 位相同的两个会话撞成一条,
  //   于是 A 会话换号后 B 会话直接继承它的账号 —— 跨会话串号,且用户完全看不出来。
  //   本模块对传入的键取摘要,不保存原文。
  function select(input = {}) {
    const { provider, keyChoice } = input;
    const choice = keyChoice && typeof keyChoice === 'object' ? keyChoice : null;
    // 默认关闭 / 没有上游 Key 选择结果:原样返回同一个对象,调用方行为逐字不变。
    if (!isEnabled(provider) || !choice) return keyChoice;

    // 固定 Key:会话槽位/会话渠道的 pinned,以及压缩专用 Key(key_source='compact')。
    // 后者哪怕调用方漏传 pinned 也不能换 —— 用户明确钉死的账号换掉等于改了压缩落点。
    const pinned = input.pinned === true || choice.pinned === true || choice.key_source === 'compact';
    if (pinned) return choice;
    if (provider.enabled === false) return choice;

    const providerId = idText(provider.id);
    if (!providerId) return choice;
    const model = modelText(input.model);
    const sessionKey = sessionText(input.sessionKey);
    const ring = usableRing(provider);
    if (!ring.length) return choice;

    const byId = new Map(ring.map(k => [k.id, k]));
    const currentId = idText(choice.key_id);
    const stickyEntry = stickyOf(providerId, sessionKey);

    if (stickyEntry) {
      const stickyId = stickyEntry.key_id;
      const stickyKey = byId.get(stickyId);
      // 在途请求的粘性账号被控制台删/停用:明确报错,不换号。
      if (!stickyKey) throw stickyUnavailable(provider, stickyId);
      if (usableThisRequest(providerId, stickyId, model, input.failedKeys)) {
        if (stickyId === currentId) return choice;
        return choiceWith(provider, stickyKey, {
          enabled: true, switched: true, reason: 'sticky', key_id: stickyId, wait_ms: 0,
        });
      }
    }

    const ordered = preferenceOrder(provider, ring)
      .map(id => byId.get(id))
      .filter(Boolean);
    const healthy = ordered.filter(k => usableThisRequest(providerId, k.id, model, input.failedKeys));
    if (healthy.length) {
      const picked = healthy[0];
      if (sessionKey && !stickyEntry) setSticky(providerId, sessionKey, picked.id);
      if (picked.id === currentId) return choice;
      return choiceWith(provider, picked, {
        enabled: true, switched: true, reason: 'fallback', key_id: picked.id, wait_ms: 0,
      });
    }

    const reported = stickyEntry && byId.get(stickyEntry.key_id)
      ? byId.get(stickyEntry.key_id)
      : byId.get(currentId) || null;
    const meta = {
      enabled: true, switched: false, reason: 'all_failed',
      key_id: (reported && reported.id) || currentId,
      wait_ms: 0,
    };
    if (reported && reported.id !== currentId) {
      return {
        provider: { ...provider, api_key: reported.key },
        key_id: reported.id,
        key_source: KEY_SOURCE_FALLBACK,
        pinned: false,
        fallback: meta,
      };
    }
    return unchanged(choice, meta);
  }

  function failure(input = {}) {
    const { provider, key_id: keyIdRaw, status } = input;
    const out = { switchable: false, scope: SCOPE_NONE, wait_ms: 0 };
    if (!isEnabled(provider)) return out;
    if (input.pinned === true) return out;

    const statusCode = Number(status);
    let scope = SCOPE_NONE;
    if (statusCode === 401 || statusCode === 402) scope = SCOPE_ACCOUNT;
    else if (statusCode === 403 || statusCode === 404 || statusCode === 429) scope = SCOPE_MODEL;
    out.scope = scope;
    if (scope === SCOPE_NONE) return out;

    const providerId = idText(provider.id);
    const keyId = idText(keyIdRaw);
    const model = modelText(input.model);
    const ring = usableRing(provider);
    const known = ring.some(k => k.id === keyId);

    if (providerId && keyId && known) {
      if (input.failedKeys instanceof Set)
        input.failedKeys.add(stateKey(providerId, keyId, scope === SCOPE_ACCOUNT ? ACCOUNT_MODEL : model));
      setFailure({
        provider: providerId,
        key_id: keyId,
        scope,
        model: scope === SCOPE_ACCOUNT ? '' : model,
        status: statusCode,
        until: 0,
        updated_at: now(),
      });
    }

    const alternatives = ring.filter(k => k.id !== keyId && usableThisRequest(providerId, k.id, model, input.failedKeys));
    out.switchable = provider.enabled !== false && alternatives.length > 0;
    return out;
  }

  // 成功即恢复:清掉这把 Key 的账号级记录与**本次模型**的记录。
  // 粘性只在会话键存在时前移 —— 换号成功确认后,后续请求继续用这把。
  // sessionKey 同上:必须是完整会话身份键,不是日志短键。
  function success(input = {}) {
    const { provider } = input;
    if (!isEnabled(provider)) return { restored: false };
    const providerId = idText(provider.id);
    const keyId = idText(input.key_id);
    if (!providerId || !keyId) return { restored: false };
    const model = modelText(input.model);

    let restored = false;
    const accountKey = stateKey(providerId, keyId, ACCOUNT_MODEL);
    if (failures.delete(accountKey)) restored = true;
    const localKey = stateKey(providerId, keyId, model);
    if (failures.delete(localKey)) restored = true;

    const sessionKey = sessionText(input.sessionKey);
    if (sessionKey && usableRing(provider).some(k => k.id === keyId)) {
      setSticky(providerId, sessionKey, keyId);
    }
    return { restored };
  }

  // 脱敏状态视图:只有 ID / 枚举 / 状态码 / 时间,没有密钥正文,也没有删除动作。
  // 无参返回全部;传 { provider } 时只看该渠道(接线 /api/keys/health 用)。
  function list(filter = {}) {
    const providerFilter = idText(filter && filter.provider);
    return [...failures.values()]
      .filter(rec => !providerFilter || rec.provider === providerFilter)
      .sort((a, b) => b.updated_at - a.updated_at)
      .map(rec => ({
        provider: rec.provider,
        key_id: rec.key_id,
        state: 'failed',
        scope: rec.scope,
        model: rec.model,
        status: rec.status,
        until: rec.until,
        updated_at: rec.updated_at,
        failures: rec.failures,
      }));
  }

  // 维护入口(控制台关掉开关或测试用):清空全部内存状态,不碰任何配置。
  function reset() {
    failures.clear();
    sticky.clear();
  }

  return { select, failure, success, list, reset };
}

module.exports = { createKeyFallback, isEnabled, usableRing, KEY_SOURCE_FALLBACK, SCOPES: {
  ACCOUNT: SCOPE_ACCOUNT, MODEL: SCOPE_MODEL, NONE: SCOPE_NONE,
} };
