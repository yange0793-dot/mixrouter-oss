'use strict';
// 请求日志 store:可注入的环形缓冲 + 落盘 + 查询 + 摘要 + Prometheus 快照。
// 从 mixrouter.js 里就地写死的那一版抽出来,补上:白名单落盘、secret 脱敏、私有目录权限、
// 有界轮转、注入式时钟、注入式错误回调,以及 metrics 需要的**进程生命周期累加器**。
//
// 三条容易做错、这里刻意做对的:
//   1. 落盘走**白名单**而不是原样 JSON.stringify。prompt/headers/api_key/token 一旦被
//      stringify 进去就收不回来了,靠"调用方别传"是不设防的。
//   2. 脱敏在**进内存环之前**做。否则 /api/logs 会把未脱敏的 err 直接发给控制台,
//      等于绕过磁盘那一层。截断必须排在替换**之后** —— 反过来,一个横跨截断点的长密钥
//      会被切成两半,后半段原样漏出去。
//   3. counter 只累计、不回退:内存环有容量上限,从环重算的量会随淘汰变小,那是 gauge 的事。
//
// require 时不读盘、不建目录、**不起定时器**;目录与文件推迟到首次 append。

const fs = require('node:fs');
const path = require('node:path');
const { createLogFiles } = require('./log-files');
const { createHistory, cursorHttpStatus } = require('./log-history');
// 折算规则只有一份,定义在 metrics.js,这里 import 复用 —— 两边各写一套必然漂移。
const { metricsText, foldApp, foldStatusClass, foldWire } = require('./metrics');

const DEFAULT_CAPACITY = 500;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 与 mixrouter.js 既有的 LOG_ROTATE_BYTES 同值
const DEFAULT_LIMIT = 200;
const ERR_MAX_CHARS = 300;
const REDACTED = '[redacted]';
const SEP = '\u0000';

// 白名单 = 日志条目允许落盘的**全部**字段,35 个。
// effort 记录实际出站档位,key_id/key_source 与 slot 只记录非明文的选择来源。
// request_id 是本进程内的尝试过程 id(见 lib/observability/attempt-trace.js):它只用于把
// 这一行终态日志与 /api/attempts 的阶段流水对上,**不是**上游请求 id,也不含会话信息。
// 尝试过程本身不进日志(嵌套结构与脱敏边界都更难守),只留这一个关联键。
// bytes_in 是客户端请求体的**字节数**(不是 token):大上下文+截图时请求体可达十几 MB,
// 而首字延迟主要由它决定 —— 上游面板只从收完请求体开始计时,本地这一栏才看得见这段。
// ttfb_ms 是「请求开始 → 上游首个响应头到达」的毫秒数(多次尝试取最终给出响应的那一发,
// 全部失败时记到请求收尾),0 表示没测到(本地估算这类不发上游的路径)。
// 来源(测试里会机械复算,双向相等才算过):
//   grep -oE "entry\.[A-Za-z_][A-Za-z0-9_]*" mixrouter.js  ∪  entry 对象字面量(949-953) 的键
// think / reasoning / tools_dropped 是"先建对象后挂字段":既不在字面量里,手数也容易漏,
// 但它们确实进日志(mixrouter.js:1099-1100 的注释说明它们是排查 400 的关键证据),所以必须在列。
const LOG_FIELDS = Object.freeze([
  'app', 'attempts', 'bytes_in', 'cache_read', 'effort', 'err', 'err_class', 'failover', 'in', 'key_id', 'key_source', 'kind',
  'model_in', 'model_out', 'ms', 'out', 'pool', 'provider', 'reasoning', 'request_id', 'resource_recovery_skipped', 'retry_reason', 'rule',
  'session', 'session_kind', 'slot', 'status', 'sticky', 'strategy', 'stream', 'think',
  'tools_dropped', 'ts', 'ttfb_ms', 'wire',
]);
const LOG_FIELD_SET = new Set(LOG_FIELDS);

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

// 只替换、不截断:用于 err/err_class 之外的字符串字段,保持既有字段形状不变
const scrubSecrets = (text, secrets) => {
  let out = text;
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  return out;
};

// 收敛成字符串 → 脱敏 → 截断。顺序不可换(见文件头第 2 条)。
function scrubText(value, secrets) {
  if (value === undefined || value === null) return '';
  const text = scrubSecrets(typeof value === 'string' ? value : String(value), secrets);
  return text.length > ERR_MAX_CHARS ? text.slice(0, ERR_MAX_CHARS) : text;
}

// 先长后短:短串先替换会吃掉长串的前缀,剩下的尾巴反而漏出去
const normalizeSecrets = secrets => (secrets
  ? (typeof secrets === 'string' ? [secrets] : [...secrets])
    .filter(s => typeof s === 'string' && s.length > 0)
    .sort((a, b) => b.length - a.length)
  : []);

// 深度上限:1(非字符串标量) + 3 层嵌套。
// 取值理由(不是随手写的数):白名单 26 个字段在 mixrouter.js 里**全部**被赋值成标量
// (已逐条扫过:数字/布尔/字符串/undefined),数组与对象本来就不该出现在这里;能出现只有两种情形 ——
//   (a) 一两个对象的浅包装(请求体片段、错因上下文),不超过 2 层;
//   (b) 整块 req/res 之类的大对象,那是几百层也可能是环,本来就该被截掉。
// 3 层给 (a) 留足余量,同时让 (b) 在第 4 层就被标记——宁可丢信息,不可漏密钥。
const MAX_DEPTH = 3;
const DEPTH_MARKER = '[depth]';
const CYCLE_MARKER = '[circular]';
const DEPTH_KEYS = '[太多键]';
// 200 是防"宽对象"的,与深度上限各管一维;26 个字段各自的真实体量都是个位数
const MAX_KEYS = 200;

// 递归脱敏。数组与 plain object 都进;number/boolean/null/undefined 原样保留
// (**不** String() 化:`model_in: 3` 变成 `"3"` 会破坏日志字段的类型契约)。
// 环检测用**当前路径栈**而不是全局 visited —— 同一个对象合法地出现在两个字段里时,
// 那是值重复不是环,不该被标成 [circular]。只有"自己嵌自己"才是环。
function scrubDeep(value, secrets, depth = 0, path = new Set()) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? scrubSecrets(value, secrets) : value;
  }
  if (path.has(value)) return CYCLE_MARKER;          // 先查环,再查深度:环在任何深度都该被标记
  if (depth >= MAX_DEPTH) return DEPTH_MARKER;       // 撞到上限就截断,绝不再往里走
  const next = new Set(path);
  next.add(value);
  if (Array.isArray(value)) return value.map(item => scrubDeep(item, secrets, depth + 1, next));
  // Buffer / TypedArray 的 JSON 形态是**字节数组**({"0":98,"1":101,...}),原样透传等于把密钥
  // 写成可还原的字节序列 —— Buffer.from(Object.values(x)) 就回来了。"看着不是明文"不等于安全,
  // 所以这里必须转成字符串再过脱敏,而不是当"非 plain object"放行。
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    const buf = Buffer.isBuffer(value)
      ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return scrubSecrets(buf.toString('utf8'), secrets);
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  // 其余对象一律按 own enumerable 属性递归,**不能原样透传**:
  // 类实例的自有属性会带着未脱敏的字符串照常进 JSON.stringify(`new C(){this.k='KEY'}` → {"k":"KEY"});
  // Map/Set 的 entries 不在自有属性里,会落成 {},宁可丢信息不可漏密钥。
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(value)) {
    if (n++ >= MAX_KEYS) { out[DEPTH_KEYS] = true; break; }  // 键数也要有界,否则离环差一步的宽对象能撑爆日志
    out[scrubSecrets(k, secrets)] = scrubDeep(v, secrets, depth + 1, next);
  }
  return out;
}

const positiveNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// limit:非有限(含 NaN/undefined/'abc')→ 默认 200;<=0 → 0(返回空,**不**回退成全量)
function normalizeLimit(limit) {
  if (limit === undefined || limit === null || limit === '') return DEFAULT_LIMIT;
  const n = Number(limit);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return n > 0 ? Math.floor(n) : 0;
}

// since 支持 ISO 串或 epoch ms;解析不了就当没给(与 limit 的坏输入策略一致:不抛也不静默全空)
function parseSince(since) {
  if (since === undefined || since === null || since === '') return null;
  const raw = String(since);
  if (!/[-T:]/.test(raw)) {
    const direct = Number(raw);
    if (Number.isFinite(direct)) return direct;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
const tsOf = entry => {
  const n = Date.parse(entry && entry.ts);
  return Number.isFinite(n) ? n : null;
};

const isOk = entry => entry.status >= 200 && entry.status < 400 && !entry.err;
function matchesStatus(entry, status) {
  if (!status) return true;
  if (status === 'ok') return isOk(entry);
  if (status === 'err') return entry.status >= 400 || entry.status === 0 || !!entry.err;
  return String(entry.status) === String(status);
}
const hasSub = (value, needle) => String(value === undefined || value === null ? '' : value).toLowerCase().includes(needle);

function matchesQuery(entry, q) {
  if (q.app && (entry.app || 'claude') !== q.app) return false;
  if (q.provider && !hasSub(entry.provider, q.provider)) return false;
  if (q.model && !(hasSub(entry.model_in, q.model) || hasSub(entry.model_out, q.model))) return false;
  if (q.session && !hasSub(entry.session, q.session)) return false;
  if (!matchesStatus(entry, q.status)) return false;
  if (q.errClass && !hasSub(entry.err_class, q.errClass)) return false;
  if (q.slot && entry.slot !== q.slot) return false;
  if (q.untilMs !== null) {
    const at = tsOf(entry);
    if (at === null || at > q.untilMs) return false;
  }
  if (q.sinceMs !== null) {
    const at = tsOf(entry);
    // ts 缺失/坏掉的条目在给了 since 时按不匹配处理,不让它污染时间窗
    if (at === null || at < q.sinceMs) return false;
  }
  return true;
}

// 最近邻分位数(样本少时也稳定可预期,不做插值);空样本返回 null,不返回 0
function percentile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function createRequestLog(options = {}) {
  const file = options.file === undefined || options.file === null ? null : String(options.file);
  const capacity = positiveNumber(options.capacity, DEFAULT_CAPACITY);
  const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};

  // secrets 允许两种形态:
  //   可迭代对象 / 字符串 → 构造时快照(测试与一次性场景)
  //   函数                → 每次 append 前求值
  // 为什么必须有函数形态:接线侧的密钥来源是**运行时会变**的 —— log 在模块加载时构造,
  // 那一刻 store 里是从磁盘读出来的那批渠道;用户之后在控制台新加的渠道,它的 api_key
  // 不会进快照,而新填的 key 恰恰最容易填错、最容易撞上游 401、也最容易被 401 原文回显进 err。
  // 快照形态等于"对老渠道有效、对新渠道无效",正好漏在最需要它的场景上。
  const secretSource = typeof options.secrets === 'function' ? options.secrets : null;
  const secretList = secretSource ? null : normalizeSecrets(options.secrets);
  const currentSecrets = () => {
    if (!secretSource) return secretList;
    try { return normalizeSecrets(secretSource()); }
    // Fail closed: even the thrown error may contain a credential, so report a fixed message.
    catch { report(new Error('Secret source unavailable; unsafe fields omitted'), 'secret_source'); return null; }
  };

  const ring = [];
  // 进程生命周期累加器:与内存窗口无关,不随淘汰回退,只随进程重启归零。
  // 刻意不持久化、不读盘恢复——恢复会让"重启归零"这个 counter 语义变得不可预期。
  const counters = { requests: new Map(), tokens: new Map(), attempts: 0, failover: 0 };
  let dirMade = false;
  let warned = false; // 失败状态变化时才警告一次,同一故障连续 append 不刷屏
  let healthy = true;

  const key = parts => parts.join(SEP);
  const bumpMap = (map, parts, amount) => {
    const k = key(parts);
    map.set(k, (map.get(k) || 0) + amount);
  };

  // 只挑白名单字段,其余一律丢弃(而不是 stringify 进去)。
  // 脱敏覆盖**所有字符串值的白名单字段**,不只 err:model_in 等字段就是请求体原文,
  // 客户端把 Key 误填进 model(或刻意探测)会让密钥原样落盘,而这一层的全部意义就是
  // "落盘日志不含凭据"。截断仍只对 err/err_class 做,免得改变既有消费方看到的字段形状。
  const pick = entry => {
    const out = {};
    // **每次 append 求一次**,存进局部变量后整轮复用 —— 不要放进下面字段循环里,
    // 否则就是 O(字段数) 次求值(接入侧那个取值函数会去遍历渠道表)。
    const secrets = currentSecrets();
    if (secrets === null) {
      for (const field of LOG_FIELDS) {
        const value = entry[field];
        if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' || value === null) out[field] = value;
      }
      out.err_class = 'secret_source';
      out.err = 'Secret source unavailable; unsafe fields omitted';
      return out;
    }
    const hasSecrets = secrets.length > 0;
    for (const field of LOG_FIELDS) {
      const value = entry[field];
      if (value === undefined) continue;
      if (typeof value === 'string') {
        // 所有字符串字段都过替换;只有 err/err_class 额外截断
        out[field] = hasSecrets
          ? ((field === 'err' || field === 'err_class') ? scrubText(value, secrets) : scrubSecrets(value, secrets))
          : ((field === 'err' || field === 'err_class') ? scrubText(value, secrets) : value);
      } else if (value !== null && typeof value === 'object') {
        // R6:非字符串的**容器**必须递归脱敏。原样透传时,`model_in` 被塞成嵌套对象
        // (类型混淆的请求,或有人把 body 片段写进了字段)会让密钥以对象形态落盘 ——
        // 字符串脱敏整层被绕过,而日志是持久的:删掉请求也删不掉已经写下的行。
        // 一个"看着在脱敏、实际有洞"的脱敏器比没有脱敏器更危险。
        out[field] = scrubDeep(value, secrets);
      } else {
        out[field] = value;   // number/boolean/null/undefined 原样,不做 String() 化
      }
    }
    return out;
  };

  const ensureDir = () => {
    if (!file) return;
    const dir = path.dirname(file);
    let existed = true;
    try { fs.statSync(dir); } catch { existed = false; }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 只收紧**本进程新建**的目录:已存在的目录不动它的权限(mkdir 也不会改)。
    if (!existed) {
      try { fs.chmodSync(dir, 0o700); } catch {}
      dirMade = true;
    }
  };

  // 写失败不许把请求打崩,但必须可观测:首次失败警告一次,恢复后重置,下次再坏再警告一次。
  // ★ onError 的回调**只允许带 `ctx.op` 与 `error.message`**(接入侧给的示例就是这样)。
  //   `error.message` 可能含**文件路径**(不是凭据),这是有意保留的:去掉它这条 warning 就变成
  //   "落盘失败了,不知道哪儿",一个无法行动的告警等于没有告警。
  //   **但绝不要把 entry 传进去** —— entry 里可能带着未脱敏的 err 原文(取脱敏表失败时更是
  //   全量未脱敏),把它 JSON.stringify 进告警就等于把泄露从文件挪到了 stderr。
  const report = (error, op) => {
    healthy = false;
    if (warned) return;
    warned = true;
    try { onError(error, { op, file }); } catch {}
  };
  const recover = () => { if (!healthy) { healthy = true; warned = false; } };

  const files = createLogFiles({ file, maxBytes, now, report,
    retentionDays: options.retentionDays, compress: options.compress, rotateDaily: options.rotateDaily });

  const writeEntry = entry => {
    if (!file) return;
    try {
      ensureDir();
      files.beforeAppend();
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, `${JSON.stringify(entry)}\n`);
      } finally { fs.closeSync(fd); }
      recover();
    } catch (error) {
      report(error, 'append');
    }
  };

  function append(entry) {
    if (!isPlainObject(entry)) return;
    const record = pick(entry);
    const app = record.app || 'claude';
    // 先折算再建键:计数器的键必须是**折算后**的 (app,status_class,wire)。
    // 若按原始状态码建键,500/502/503 会在 metrics 侧各自折成 5xx 后输出三行
    // 标签集完全相同的序列 —— 那是非法的 Prometheus 文本。折在这里,基数天然 ≤3×6×4 且不可能重复。
    // 注意 app 的口径:缺 app 按 'claude'(沿用 mixrouter.js 全局 `e.app || 'claude'`),
    // foldApp 的 unknown 只兜"出现了 claude/codex 以外的值"。
    bumpMap(counters.requests, [foldApp(app), foldStatusClass(record.status), foldWire(record.wire)], 1);
    bumpMap(counters.tokens, [app, 'in'], num(record.in));
    bumpMap(counters.tokens, [app, 'out'], num(record.out));
    counters.attempts += num(record.attempts);
    if (record.failover) counters.failover += 1;
    ring.push(record);
    if (ring.length > capacity) ring.shift();
    writeEntry(record);
  }

  const buildQuery = query => {
    const q = isPlainObject(query) ? query : {};
    return {
      app: q.app || '',
      provider: String(q.provider || '').toLowerCase(),
      model: String(q.model || '').toLowerCase(),
      session: String(q.session || '').toLowerCase(),
      status: q.status ? String(q.status) : '',
      errClass: String(q.err_class || '').toLowerCase(),
      sinceMs: parseSince(q.since),
      untilMs: parseSince(q.until),
      slot: q.slot ? String(q.slot) : '',
    };
  };

  function list(query) {
    const q = buildQuery(query);
    const matched = ring.filter(entry => matchesQuery(entry, q));
    const limit = normalizeLimit(isPlainObject(query) ? query.limit : undefined);
    // 新→旧,与既有 /api/logs 的 slice(-limit).reverse() 保持一致
    const logs = limit === 0 ? [] : matched.slice(-limit).reverse();
    return { logs, matched: matched.length, capacity };
  }

  function summary(query) {
    const q = buildQuery(query);
    const items = ring.filter(entry => matchesQuery(entry, q));
    let reqs = 0, ok = 0, inTok = 0, outTok = 0, cache = 0, attempts = 0, failover = 0;
    // 渠道/模型名可为 __proto__、constructor 等,分组计数不能读取或写到原型。
    const byApp = Object.create(null), byProvider = Object.create(null), byModel = Object.create(null);
    const bySlot = Object.create(null);
    const durations = [], stamps = [];
    for (const e of items) {
      reqs++;
      const slot = typeof e.slot === 'string' ? (e.slot || 'none') : 'unknown';
      const totals = bySlot[slot] || (bySlot[slot] = { reqs: 0, in: 0, out: 0, cache: 0 });
      totals.reqs++; totals.in += num(e.in); totals.out += num(e.out); totals.cache += num(e.cache_read);
      if (isOk(e)) ok++;
      inTok += e.in || 0; outTok += e.out || 0; cache += e.cache_read || 0;
      attempts += num(e.attempts);
      if (e.failover) failover++;
      const ay = e.app || 'claude';
      byApp[ay] = (byApp[ay] || 0) + 1;
      const pv = e.provider || '(未知)';
      byProvider[pv] = (byProvider[pv] || 0) + 1;
      const mk = e.model_out || e.model_in || '(?)';
      byModel[mk] = (byModel[mk] || 0) + 1;
      // ms>0 才算样本:ms=0 是"没测到",不是"瞬时"
      const ms = Number(e.ms);
      if (Number.isFinite(ms) && ms > 0) durations.push(ms);
      const at = tsOf(e);
      if (at !== null) stamps.push(at);
    }
    durations.sort((a, b) => a - b);
    return {
      // 旧字段名与语义原样保留(下游契约)
      reqs, ok, ok_rate: reqs ? Math.round(ok * 100 / reqs) : 100, inTok, outTok, cache,
      by_app: { ...byApp }, by_provider: { ...byProvider }, by_model: { ...byModel },
      by_slot: { ...bySlot },
      scope: { source: 'memory', timezone: 'UTC', capacity, since: q.sinceMs, until: q.untilMs, inclusive: true },
      // 新增
      p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), ms_sample: durations.length,
      attempts, failover, capacity,
      range: {
        from: stamps.length ? new Date(Math.min(...stamps)).toISOString() : null,
        to: stamps.length ? new Date(Math.max(...stamps)).toISOString() : null,
      },
    };
  }

  // today:与 mixrouter.js 既有实现逐字段等价(按**本地日历日**比较,不是 24h 窗口)
  function today() {
    const d = new Date(now());
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    let reqs = 0, inTok = 0, outTok = 0;
    for (const e of ring) {
      const ed = new Date(e.ts);
      const eday = `${ed.getFullYear()}-${ed.getMonth() + 1}-${ed.getDate()}`;
      if (eday !== day) continue;
      reqs++; inTok += e.in || 0; outTok += e.out || 0;
    }
    return { reqs, inTok, outTok };
  }

  // 纯读:不改 ring、不落盘。counter 与窗口分两个顶层键,让"哪个单调"在形状里就看得出来。
  function metricsSnapshot() {
    const requests = [];
    for (const [k, count] of counters.requests) {
      const [app, status_class, wire] = k.split(SEP);
      requests.push({ app, status_class, wire, count });
    }
    const tokens = [];
    for (const [k, count] of counters.tokens) {
      const [app, direction] = k.split(SEP);
      tokens.push({ app, direction, count });
    }
    // 窗口分位数按**折算后**的 app 分组再算:两个非标准 app 会自然合进同一个 unknown 样本集,
    // 分位数在合并后的样本上算得出正确值。若改成各自算完再撞车,分位数不可相加,事后合并无定义。
    // 仍只吃 ms>0。
    const byApp = new Map();
    for (const e of ring) {
      const ms = Number(e.ms);
      if (!Number.isFinite(ms) || ms <= 0) continue;
      const app = foldApp(e.app || 'claude');
      if (!byApp.has(app)) byApp.set(app, []);
      byApp.get(app).push(ms);
    }
    const duration = [];
    for (const [app, samples] of byApp) {
      samples.sort((a, b) => a - b);
      for (const quantile of ['0.5', '0.95']) {
        duration.push({ app, quantile, value: percentile(samples, Number(quantile)), samples: samples.length });
      }
    }
    return {
      counters: { requests, tokens, attempts: counters.attempts, failover: counters.failover },
      window: { capacity, used: ring.length, duration },
    };
  }

  const history = createHistory({ file, now, pick, buildQuery, matchesQuery, normalizeLimit, report });
  return {
    append, list, summary, today,
    ...history, maintenance: files.maintenance, flush: files.flush,
    storageStatus: () => ({ ...files.status(), append_healthy: healthy }),
    metricsSnapshot,
    metrics: () => metricsText(metricsSnapshot()),
    // 暴露给测试的内部句柄(只读用途)
    _ring: ring, _counters: counters, _dirMade: () => dirMade,
  };
}

module.exports = {
  createRequestLog, cursorHttpStatus, LOG_FIELDS, LOG_FIELD_SET, scrubText, scrubSecrets, scrubDeep, normalizeLimit, parseSince,
  DEFAULT_CAPACITY, DEFAULT_MAX_BYTES, DEFAULT_LIMIT, ERR_MAX_CHARS, REDACTED,
  MAX_DEPTH, DEPTH_MARKER, CYCLE_MARKER, MAX_KEYS,
};
