'use strict';
// 尝试过程 trace:一条请求从入口到终态的**阶段流水**,只存在本进程内存里。
//
// 存在的理由:requests.jsonl 每条请求只留一行终态(status / err_class / attempts),
// "为什么慢、为什么换渠道、现在卡在谁身上"发生在两次尝试之间,日志里看不到。控制台要能回答
// "这条请求正在等哪个渠道",同时又不能把 prompt、会话标签、Key、上游 URL 或上游错误正文
// 写进一个会被 /api 读出去的缓冲区。所以这里只认**字段白名单**:
//   · start(metadata) —— 只收 START_FIELDS 里的键;
//   · event(e)        —— 只收 EVENT_FIELDS 里的键;
//   · finish(f)       —— 只收 FINISH_FIELDS 里的键。
// 白名单不是风格问题:调用方最顺手的写法就是"把 entry 或 body 整个传进来",而 entry 里有
// 会话键、body 里有 prompt 与截图。少一个字段,泄露就少一条路。
//
// 有界生命周期,且**不起定时器**:
//   · 最多 limit 条(默认 100),超了删最旧的;
//   · 每条最多 eventLimit 个事件(默认 40),超了删最旧的(保留最新,已结束的最后一条一定在);
//   · ttlMs(默认 15 分钟)按**最近一次更新**过期,在 start/event/finish/list 时顺手清理。
// 不用定时器是有意的:诊断缓冲不该成为"进程退不出去"的理由,也不该在请求路径之外持续跑。
//
// 所有文本字段都收敛成**单行、有长度上限**的字符串:model_in/provider_id 这类值可以被客户端
// 或上游左右,换行与超长串不能顺着这里改写接口或页面。

const crypto = require('node:crypto');

const DEFAULT_LIMIT = 100;
const DEFAULT_EVENT_LIMIT = 40;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const TEXT_MAX = 64;
const CODE_MAX = 64;
const PHASE_MAX = 24;
const COUNT_MAX = 1e9;

// start() 接受的元数据。故意**没有** session(会话键/标签)、key(明文或指纹)、
// upstream url、prompt/body、错误正文 —— 这些一律不进 trace。
const START_FIELDS = Object.freeze(['app', 'kind', 'model_in', 'slot', 'rule', 'stream']);

// 一次尝试过程里允许出现的阶段与字段。
//   phase 'start' 由 start() 自己写;'attempt' 表示"已发上游、正在等响应头";
//   'response' 表示这一发拿到响应头;'error' 表示这一发作废(附 code,不带正文);
//   'retry_wait' 表示两次尝试之间的等待;'finished' 由 finish() 写。
const PHASES = Object.freeze(['start', 'attempt', 'response', 'error', 'retry_wait', 'finished']);
const PHASE_SET = new Set(PHASES);
const EVENT_FIELDS = Object.freeze(['phase', 'attempt', 'provider_id', 'model', 'key_id', 'status', 'code', 'wait_ms']);
const FINISH_FIELDS = Object.freeze(['status', 'code']);

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const positiveNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
// 非负整数;坏输入按 0(接口形状固定,不因为一个 NaN 就少一个键)
const countOf = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(COUNT_MAX, Math.floor(n));
};
// 单行化 + 截断。控制字符(含换行)换成空格,再按**字符**截断。
const textOf = (value, max) => {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
};

// 只挑白名单键;未知键丢弃而不是原样带上
function pickMetadata(input) {
  const src = isPlainObject(input) ? input : {};
  const out = {};
  for (const field of START_FIELDS) {
    if (field === 'stream') {
      if (src.stream !== undefined) out.stream = !!src.stream;
      continue;
    }
    const value = textOf(src[field], TEXT_MAX);
    if (value) out[field] = value;
  }
  return out;
}

// 返回 null 表示这条事件不合法(未知阶段),调用方与 store 都不记 —— 宁可不记,不记错的。
function pickEvent(input) {
  if (!isPlainObject(input)) return null;
  const phase = textOf(input.phase, PHASE_MAX).toLowerCase();
  if (!PHASE_SET.has(phase)) return null;
  return {
    phase,
    attempt: countOf(input.attempt),
    provider_id: textOf(input.provider_id, TEXT_MAX),
    model: textOf(input.model, TEXT_MAX),
    key_id: textOf(input.key_id, TEXT_MAX),
    status: countOf(input.status),
    code: textOf(input.code, CODE_MAX),
    wait_ms: countOf(input.wait_ms),
  };
}

function createAttemptTraceStore(options = {}) {
  const limit = positiveNumber(options.limit, DEFAULT_LIMIT);
  const eventLimit = positiveNumber(options.eventLimit, DEFAULT_EVENT_LIMIT);
  const ttlRaw = Number(options.ttlMs);
  const ttlMs = Number.isFinite(ttlRaw) && ttlRaw >= 0 ? ttlRaw : DEFAULT_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const newId = typeof options.idFactory === 'function'
    ? options.idFactory
    : () => crypto.randomUUID();

  // Map 的插入顺序就是年龄顺序:最旧的在头部,list 反向读出即"新→旧"。
  const records = new Map();
  let sequence = 0;

  const iso = () => new Date(now()).toISOString();

  // 过期清理只在公开入口顺手做:**没有定时器**,所以一个空 Store 什么都不占。
  // 按 updated_at 判过期(不是 started_at):一条跑得久的流不该在诊断里半路消失。
  const prune = () => {
    if (!(ttlMs > 0)) return;
    const cutoff = now() - ttlMs;
    for (const [id, rec] of records) {
      const at = Date.parse(rec.updated_at);
      if (!Number.isFinite(at) || at < cutoff) records.delete(id);
    }
  };

  const trimEvents = rec => {
    if (rec.events.length > eventLimit) rec.events.splice(0, rec.events.length - eventLimit);
  };

  const snapshot = rec => {
    const startedMs = Date.parse(rec.started_at);
    const endMs = rec.terminal ? Date.parse(rec.finished_at) : now();
    const duration = Number.isFinite(startedMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startedMs) : 0;
    return {
      id: rec.id,
      started_at: rec.started_at,
      updated_at: rec.updated_at,
      finished_at: rec.finished_at,
      terminal: rec.terminal,
      status: rec.status,
      code: rec.code,
      duration_ms: duration,
      metadata: { ...rec.metadata },
      events: rec.events.map(e => ({ ...e })),
    };
  };

  // 建一条 trace,返回 id。id 由调用方带进 entry.request_id,日志与 /api/attempts 才关联得上。
  function start(metadata) {
    prune();
    let id = textOf(newId(), TEXT_MAX);
    if (!id) id = `trace-${++sequence}`;
    while (records.has(id)) id = `${textOf(newId(), TEXT_MAX) || 'trace'}-${++sequence}`;
    const at = iso();
    const rec = {
      id,
      started_at: at,
      updated_at: at,
      finished_at: null,
      terminal: false,
      status: 0,
      code: '',
      metadata: pickMetadata(metadata),
      events: [],
    };
    // 第一条事件就是 start:页面不必靠"events 为空"来猜请求刚开始。
    rec.events.push({ ts: at, phase: 'start', attempt: 0, provider_id: '', model: '', key_id: '',
      status: 0, code: '', wait_ms: 0 });
    records.set(id, rec);
    // 超出上限从**最旧**删。放在 set 之后,limit 被当成硬上限。
    while (records.size > limit) records.delete(records.keys().next().value);
    return id;
  }

  // 记一条阶段事件。未知 id(已过期/已淘汰)或已结束的 trace 返回 false,不复活、不补记。
  function event(id, input) {
    prune();
    const rec = records.get(textOf(id, TEXT_MAX));
    if (!rec || rec.terminal) return false;
    const picked = pickEvent(input);
    if (!picked) return false;
    const at = iso();
    rec.events.push({ ts: at, ...picked });
    trimEvents(rec);
    rec.updated_at = at;
    return true;
  }

  // 终态只写一次。重复 finish 返回 false,后到的状态不会覆盖第一次的结论。
  function finish(id, input) {
    prune();
    const rec = records.get(textOf(id, TEXT_MAX));
    if (!rec || rec.terminal) return false;
    const src = isPlainObject(input) ? input : {};
    const at = iso();
    rec.status = countOf(src.status);
    rec.code = textOf(src.code, CODE_MAX);
    rec.finished_at = at;
    rec.updated_at = at;
    rec.terminal = true;
    // 终态也进事件流:页面按"最后一条事件"决定显示等待还是结束,不必另建分支。
    rec.events.push({ ts: at, phase: 'finished', attempt: 0, provider_id: '', model: '', key_id: '',
      status: rec.status, code: rec.code, wait_ms: 0 });
    trimEvents(rec);
    return true;
  }

  // 新→旧。返回的是**副本**:调用方(HTTP 序列化)改不动 Store 里的状态。
  function list() {
    prune();
    return [...records.values()].reverse().map(snapshot);
  }

  return { start, event, finish, list };
}

module.exports = {
  createAttemptTraceStore,
  DEFAULT_LIMIT, DEFAULT_EVENT_LIMIT, DEFAULT_TTL_MS,
  START_FIELDS, EVENT_FIELDS, FINISH_FIELDS, PHASES,
  TEXT_MAX, CODE_MAX,
};
