'use strict';
// 用量统计:按区间聚合磁盘日志 + 内存环,给出 token / 速度 / 首字延迟。
//
// 为什么磁盘优先、内存只补"更新"的:
//   请求日志是**追加写**的,一条请求收尾时已经同步落盘;内存 ring(500 条)只是最近窗口。
//   两边都读会把同一条算两遍。判据取"磁盘已覆盖到的最大 ts",内存里 ts **更大**的才补进来
//   —— 不按 ts+session+model 去重:同一秒两条相同会话的请求完全合法,那种去重会少算。
//
// 进程内缓存:
//   控制台按 60s 轮询,不能每次都从零解析整份 JSONL。缓存 key = (dev, ino),值 = 已解析行
//   与**最后一个完整行之后**的字节偏移;普通文件只增量读新增部分(records 的 start 选项),
//   轮转出来的 .gz 归档按 inode+size 整份缓存一次。缓存随 inventory 回收。
//   每行还带一个**行号**(1..n 的物理行,不是数组下标):控制台请求单页明细时,按行号回到
//   该文件里只解析这一页,不必为整段历史再留一份原始行。行号只占一个整数/行,比把 30+ 字段
//   的原始日志行整份缓存小一个数量级(实测 20 万行:compact 31MB / 原始 114MB)。
//
// 分桶:
//   today / 24h → 'hour';7d / 30d / all → 'day';自定义区间按跨度选(≤48h 用小时)。
//   `t` 一律是**本地时间**的字符串:
//     hour → `YYYY-MM-DDTHH:00`(例 `2026-10-20T14:00`)
//     day  → `YYYY-MM-DD`(例 `2026-10-20`)
//   空桶补齐(曲线不能断)。scope.from/to 是 UTC ISO,便于和日志里的 ts 对齐;
//   跨时区展示请看 scope.timezone。
//
// 控制台扩展(dashboard=1,契约见 evidence/ccswitch-layout/contract.md):
//   老调用(不带 dashboard=1)的响应键、子串过滤语义原样不动。带上 dashboard=1 才追加
//   `dashboard` 键,并且:
//     · provider 按**渠道显示名精确匹配**、model 按**有效模型(model_out || model_in)精确匹配**、
//       status 取 ok / err(err 或 err_class 会盖掉数字上的 200);
//     · cards / daily / by_provider / by_model / records 全部出自**同一个**已过滤行集合与
//       同一对时间边界,内存行只补一次;
//     · records 分页(默认 50,上限 200)按时间新→旧、同 ts 按扫描位置新→旧(确定性),
//       total 是命中行数;行内容走请求日志白名单(LOG_FIELDS),磁盘里混进的未知字段一律不出现;
//     · facets 在 provider/model 过滤**之前**按时间+app+status 统计,选中值即使已无数据也保留;
//     · coverage 是**过滤前**全部可用源数据的最早/最晚 ts,不冒充"完整保留历史"。
//     · 渠道维度(by_channel / facets.channels / channel 参数):显示名不唯一,两个渠道库可以同名,
//       同一库里也可以同名。新日志按 provider_id 分组,协议组取渠道所在的库(provider_app);
//       旧日志没有 id,按 (app, 显示名) 找唯一的同名渠道并进去(规则见 channelResolver),
//       找不到或不唯一时单独成一组(provider_id 为空)。by_provider / provider 参数的口径不动。

const { inventory } = require('../observability/log-files');
const { records } = require('../observability/log-history');
// 白名单只有一份:沿用请求日志落盘时的那份字段表,不在这里另抄一张。
// (条数会随日志字段演进而变,例如新增的 request_id;这里不写死数字,免得两处漂移。)
const { LOG_FIELDS } = require('../observability/request-log');

const HOUR = 3600000;
const DAY = 86400000;
const MAX_BUCKETS = 5000;
const MAX_CACHE_ROWS_PER_FILE = 500000;
const DASHBOARD_DEFAULT_LIMIT = 50;
const DASHBOARD_MAX_LIMIT = 200;
const DASHBOARD_SORT_FIELDS = { ts: 'ts', in: 'inTok', out: 'outTok', cache_read: 'cache', ms: 'ms', ttfb_ms: 'ttfb', speed_tps: 'speed' };
const RANGES = new Set(['today', '24h', '7d', '30d', 'all', 'custom']);

const TIMEZONE = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; }
  catch { return 'local'; }
})();

const usageError = (message, code = 'USAGE_RANGE_INVALID') =>
  Object.assign(new Error(message), { statusCode: 400, code });
const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const pad = value => String(value).padStart(2, '0');

// ---- 时间与分桶(全部本地时区) ---------------------------------------------
const localDayStart = ms => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const localHourStart = ms => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
};
const bucketStart = (ms, bucket) => (bucket === 'hour' ? localHourStart(ms) : localDayStart(ms));
const bucketLabel = (ms, bucket) => {
  const d = new Date(ms);
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return bucket === 'hour' ? `${ymd}T${pad(d.getHours())}:00` : ymd;
};
const nextBucket = (ms, bucket) => {
  const d = new Date(ms);
  if (bucket === 'hour') return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

// 最近邻分位数(与 lib/observability/request-log.js 同一口径:样本少时也不插值)
function percentile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

// ---- 查询解析 --------------------------------------------------------------
function parseBoundary(value, label) {
  if (value === undefined || value === null || value === '') throw usageError(`${label} 不能为空`);
  const raw = String(value);
  // ISO 为主;纯数字按 epoch ms 接受(便于脚本调用,不改变 ISO 语义)
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(parsed)) throw usageError(`${label} 不是可解析的时间:${raw}`);
  return parsed;
}

// 分页参数只收非负整数;limit 有硬上限(200),超出按上限截断而不是悄悄放宽。
function parseCount(value, label, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) throw usageError(`${label} 必须是非负整数,收到 ${raw}`, 'USAGE_PAGINATION_INVALID');
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw usageError(`${label} 超出可表示范围:${raw}`, 'USAGE_PAGINATION_INVALID');
  return n;
}

function resolveQuery(query, now) {
  const q = query && typeof query === 'object' ? query : {};
  const rangeRaw = String(q.range || '').trim().toLowerCase();
  const hasFrom = q.from !== undefined && q.from !== '';
  const hasTo = q.to !== undefined && q.to !== '';
  let range = rangeRaw || 'today';
  if (hasFrom || hasTo) range = 'custom';
  if (!RANGES.has(range)) throw usageError(`range 只支持 today / 24h / 7d / 30d / all,收到 ${rangeRaw || '(空)'}`);

  let from, to = now;
  if (range === 'custom') {
    if (!hasFrom || !hasTo) throw usageError('自定义区间必须同时给 from 与 to(ISO 时间)');
    from = parseBoundary(q.from, 'from');
    to = parseBoundary(q.to, 'to');
    if (from > to) throw usageError('from 不能晚于 to');
  } else if (range === 'today') {
    from = localDayStart(now);
  } else if (range === '24h') {
    from = now - DAY;
  } else if (range === '7d') {
    from = now - 7 * DAY;
  } else if (range === '30d') {
    from = now - 30 * DAY;
  } else {
    from = null; // all:读完数据再定(见 summarize)
  }
  const span = from === null ? Infinity : to - from;
  const bucket = range === 'today' || range === '24h'
    ? 'hour'
    : range === '7d' || range === '30d' || range === 'all'
      ? 'day'
      : (span <= 2 * DAY ? 'hour' : 'day');

  // dashboard=1 是**显式选择性加入**:不带它时下面的精确匹配/分页/status 一律不参与,
  // 老调用连查询解析都走原来那一条(子串 + 小写),响应里也不会多出 dashboard 键。
  const dashboard = String(q.dashboard === undefined ? '' : q.dashboard) === '1';
  let offset = 0, limit = DASHBOARD_DEFAULT_LIMIT, status = '';
  let search = '', statusCode = '', sort = 'ts', order = 'desc', recordsScope = 'history';
  if (dashboard) {
    offset = parseCount(q.offset, 'offset', 0);
    // limit=0 会让"有数据但一页都没显示"看起来像空库,直接按非法参数拒掉。
    limit = parseCount(q.limit, 'limit', DASHBOARD_DEFAULT_LIMIT);
    if (limit < 1) throw usageError('limit 至少为 1', 'USAGE_PAGINATION_INVALID');
    if (limit > DASHBOARD_MAX_LIMIT) limit = DASHBOARD_MAX_LIMIT;
    status = String(q.status || '').trim().toLowerCase();
    if (status && status !== 'ok' && status !== 'err')
      throw usageError(`status 只支持 ok / err,收到 ${status}`, 'USAGE_STATUS_INVALID');
    search = String(q.search || '').trim().toLowerCase();
    if (search.length > 200) throw usageError('搜索内容不能超过 200 个字符', 'USAGE_SEARCH_INVALID');
    statusCode = String(q.status_code ?? '').trim();
    if (statusCode && !/^(0|[1-5]\d{2})$/.test(statusCode))
      throw usageError('status_code 必须是 100–599 或 0（未收到响应）', 'USAGE_STATUS_INVALID');
    sort = String(q.sort || 'ts');
    order = String(q.order || 'desc');
    if (!Object.hasOwn(DASHBOARD_SORT_FIELDS, sort) || !['asc', 'desc'].includes(order))
      throw usageError('不支持的排序字段或方向', 'USAGE_SORT_INVALID');
    recordsScope = String(q.records_scope || 'history');
    if (!['recent', 'history'].includes(recordsScope))
      throw usageError('records_scope 只支持 recent / history', 'USAGE_RECORDS_SCOPE_INVALID');
  }

  return {
    range, from, to, bucket, dashboard, offset, limit, status, search, statusCode, sort, order, recordsScope,
    app: String(q.app || '').trim(),
    // 老口径:小写子串。dashboard 另存**原样**选中值用于精确匹配与 facets 回填。
    provider: String(q.provider || '').trim().toLowerCase(),
    model: String(q.model || '').trim().toLowerCase(),
    providerExact: String(q.provider === undefined || q.provider === null ? '' : q.provider).trim(),
    modelExact: String(q.model === undefined || q.model === null ? '' : q.model).trim(),
    // 渠道键(by_channel[].channel)精确匹配;只在 dashboard=1 下生效。
    channel: dashboard ? String(q.channel === undefined || q.channel === null ? '' : q.channel).trim() : '',
  };
}

// 分组用的显示名:与 by_provider / by_model 的键完全一致,否则下拉里选中的值和聚合会对不上。
const providerName = row => row.provider || '(未知)';
const effectiveModel = row => row.modelOut || row.modelIn || '(?)';

// 老口径:provider/model 都是**子串**(小写)匹配;app 精确。
function matchesLegacy(row, q) {
  if (q.provider && !row.provider.toLowerCase().includes(q.provider)) return false;
  if (q.model
    && !row.modelOut.toLowerCase().includes(q.model)
    && !row.modelIn.toLowerCase().includes(q.model)) return false;
  return true;
}

// 控制台口径:provider = 渠道显示名**精确**相等,model = 有效模型**精确**相等。
// 这是"渠道A"与"渠道A2"、"m-a"与"m-a-2"不再互相串数据的关键。
function matchesExact(row, q) {
  if (q.providerExact && providerName(row) !== q.providerExact) return false;
  if (q.modelExact && effectiveModel(row) !== q.modelExact) return false;
  return true;
}

// 没选出渠道就失败的请求(入口拒绝、选号失败)。名字与 by_provider 的「(未知)」一致。
const UNKNOWN_CHANNEL = Object.freeze({ channel: 'none', provider_id: '', app: '', name: '(未知)' });

// 行 → 渠道描述 { channel, provider_id, app, name }。按**全部**行建表(不受区间/筛选影响),
// 同一个渠道键在任何筛选下都指向同一组行,选中的渠道不会因为换了区间就换了含义。
//   · 新日志:键 `id:<provider_id>`;名字取这个 id 最新一条日志的显示名(改过名就用新名字)。
//   · 旧日志(没有 provider_id)按 (app, 显示名) 找渠道,依次:
//       1) 本库(app)里同名的 id 恰好一个;
//       2) 本库没有同名渠道时,新日志里**确实服务过这个 app** 的另一个库的同名 id 恰好一个
//          (Codex 共用压缩落在 Claude 渠道上:旧日志 app=codex,渠道在 claude 库);
//       3) 都不唯一就单独成组 `name:<app>:<显示名>`,provider_id 为空。
//     第 2 步不按"另一个库里同名"直接并:本库的同名渠道上线后还没被用过时,会把它的旧日志并到别的库。
// 旧日志分不出的情况(同一 app 名下既有本库渠道、又有共用压缩)按本库记,与改动前按名字合计一样,不会更错。
function channelResolver(rows) {
  const latest = new Map();  // provider_id → 最新一行
  const own = new Map();     // `${渠道库}:${显示名}` → Set(provider_id),改过名的 id 在每个名字下都有
  const served = new Map();  // `${请求 app}:${显示名}` → Set(provider_id),只记渠道库 ≠ 请求 app 的行
  const add = (map, key, id) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(id); };
  for (const row of rows) {
    if (!row.providerId || !row.provider) continue;
    const prev = latest.get(row.providerId);
    if (!prev || row.ts >= prev.ts) latest.set(row.providerId, row);
    const store = row.providerApp || row.app;
    add(own, `${store}:${row.provider}`, row.providerId);
    if (store !== row.app) add(served, `${row.app}:${row.provider}`, row.providerId);
  }
  const byId = new Map();
  for (const [id, row] of latest) {
    byId.set(id, { channel: `id:${id}`, provider_id: id, app: row.providerApp || row.app, name: row.provider });
  }
  const only = ids => (ids && ids.size === 1 ? byId.get(ids.values().next().value) : null);
  const legacy = new Map();
  return row => {
    if (!row.provider) return UNKNOWN_CHANNEL;
    if (row.providerId) return byId.get(row.providerId);
    const key = `${row.app}:${row.provider}`;
    let hit = legacy.get(key);
    if (!hit) {
      const same = own.get(key);
      hit = (same ? only(same) : only(served.get(key)))
        || { channel: `name:${key}`, provider_id: '', app: row.app, name: row.provider };
      legacy.set(key, hit);
    }
    return hit;
  };
}

// ---- 日志行 → 紧凑行 --------------------------------------------------------
// 只留聚合要用的字段。日志条目本身有 30+ 个字段,整份缓存会把 30 天的量放大成几十万对象。
// 成功口径有两份,刻意不合并:
//   ok       = 老口径(2xx/3xx 且没有 err),/api/usage 带不带 dashboard=1 都有人按这个数对齐;
//   okStrict = 再多看 err_class —— 契约要求 err/err_class 都能盖掉数字上的 200。
//   生产路径里 err_class 基本都与 err 或 >=400 的状态码同时出现(见 lib/proxy/attempt.js、
//   wire-anthropic-translator.js),所以两者对真实数据几乎总是相等;分开是为了**老响应一个数都不变**,
//   同时让控制台的成功率、状态筛选、明细页三者用同一套判定(否则卡片说成功、筛选里却能筛出它)。
function compact(record) {
  if (!record || typeof record !== 'object') return null;
  const ts = Date.parse(record.ts);
  if (!Number.isFinite(ts)) return null;
  const status = Number(record.status);
  const ok = Number.isFinite(status) && status >= 200 && status < 400 && !record.err;
  return {
    ts,
    app: typeof record.app === 'string' && record.app ? record.app : 'claude',
    provider: typeof record.provider === 'string' ? record.provider : '',
    // 旧日志没有这两个字段:空串 = 不知道是哪个渠道(见 channelResolver)。
    providerId: typeof record.provider_id === 'string' ? record.provider_id : '',
    providerApp: typeof record.provider_app === 'string' ? record.provider_app : '',
    modelOut: typeof record.model_out === 'string' ? record.model_out : '',
    modelIn: typeof record.model_in === 'string' ? record.model_in : '',
    requestId: typeof record.request_id === 'string' ? record.request_id : '',
    session: typeof record.session === 'string' ? record.session : '',
    status: Number.isFinite(status) ? status : 0,
    ok,
    okStrict: ok && !record.err_class,
    inTok: num(record.in),
    outTok: num(record.out),
    cache: num(record.cache_read),
    ttfb: num(record.ttfb_ms),
    ms: num(record.ms),
  };
}

// 明细行只放白名单字段:磁盘是追加写的历史文件,里面可能有旧版本留下的未知字段
// (甚至有人手抄进去的 api_key / 本机路径)。按 LOG_FIELDS 逐字段重挑一遍,
// 未知字段根本不会被返回;落盘前已经过脱敏,这里不再重写值,只做投影 + 深拷贝
// (内存环里的对象与运行中的环共用引用,直接返回等于把内部状态交给调用方)。
function projectLogRow(record) {
  if (!record || typeof record !== 'object') return null;
  const out = {};
  for (const field of LOG_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object') {
      try { out[field] = JSON.parse(JSON.stringify(value)); } catch { continue; }
    } else out[field] = value;
  }
  return out;
}

function createUsageSummary(options = {}) {
  const file = options.file || null;
  const memoryEntries = typeof options.memoryEntries === 'function' ? options.memoryEntries : () => [];
  const now = typeof options.now === 'function' ? options.now : Date.now;

  // inode → { size, offset, rows, lines, lineBase, row }
  //   rows/lines 一一对应:lines[i] 是 rows[i] 在**该文件**里的物理行号(0 起),
  //   控制台要单页明细时按它回读,不必缓存原始行。
  const cache = new Map();

  async function* diskBatches() {
    if (!file) return;
    let rows;
    try { rows = inventory(file); } catch { return; }
    const live = new Set();
    for (const inv of rows) {
      const key = `${inv.dev}:${inv.ino}`;
      live.add(key);
      let entry = cache.get(key);

      if (inv.gz) {
        if (entry && entry.size === inv.size && entry.rows) { yield { rows: entry.rows, lines: entry.lines, entry }; continue; }
        const parsed = [], lines = [];
        try {
          for await (const { value, line } of records(inv, file)) {
            const r = compact(value);
            if (r) { parsed.push(r); lines.push(line); }
          }
        } catch { continue; } // 归档在读取中被删/压缩:跳过这一份,下次 inventory 会看到新状态
        entry = { size: inv.size, offset: inv.size, rows: parsed, lines, lineBase: 0, row: inv };
        cache.set(key, entry);
        yield { rows: entry.rows, lines: entry.lines, entry };
        continue;
      }

      // 原地截断/重写(大小变小)⇒ 旧缓存作废;变大按追加处理(JSONL 的契约)。
      if (!entry || entry.offset > inv.size) entry = { size: 0, offset: 0, rows: [], lines: [], lineBase: 0, row: inv };
      entry.row = inv; // 单页回读要用最新一次 inventory 的 dev/ino/size

      if (inv.size > entry.offset) {
        const fresh = [], freshLines = [];
        let lastLine = -1;
        try {
          for await (const { value, line, end } of records(inv, file, { start: entry.offset })) {
            // records 从 start 起重新数行:加上这一份文件已经读过的行数才是物理行号。
            const abs = entry.lineBase + line;
            const r = compact(value);
            if (r) { fresh.push(r); freshLines.push(abs); }
            if (Number.isInteger(end)) entry.offset = end;
            lastLine = line;
          }
        } catch {
          // 读到一半文件被换掉/删掉:已完整读出的行仍然有效(end 只在换行之后推进),
          // 剩下的留给下一次调用从 offset 续读。
        }
        if (lastLine >= 0) entry.lineBase += lastLine + 1;
        if (fresh.length) { entry.rows.push(...fresh); entry.lines.push(...freshLines); }
        entry.size = inv.size;
        // 先把本次可见的视图取出来:缓存超限时下面会把 entry.rows/lines 置空,
        // 但**本次查询**已经读到的行必须照常参与聚合(正确性优先于省这一次 IO)。
        const view = { rows: entry.rows, lines: entry.lines, entry };
        if (entry.rows.length > MAX_CACHE_ROWS_PER_FILE) {
          entry.rows = []; entry.lines = []; entry.offset = 0; entry.lineBase = 0;
        }
        cache.set(key, entry);
        yield view;
        continue;
      }
      cache.set(key, entry);
      yield { rows: entry.rows, lines: entry.lines, entry };
    }
    for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
  }

  // 内存环是**新→旧**返回的(mixrouter 接的是 requestLog.list)。这里转成追加顺序(旧→新),
  // 让"全局下标越大越新"对磁盘与内存都成立 —— 明细排序的并列时才有一致的次序。
  function memoryRows() {
    let list;
    try { list = memoryEntries(); } catch { return { compact: [], raws: [] }; }
    const items = Array.isArray(list) ? list : [];
    const compacted = [], raws = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const row = compact(items[i]);
      if (!row) continue;
      compacted.push(row);
      raws.push(items[i]);
    }
    return { compact: compacted, raws };
  }

  // 磁盘增量缓存是**有状态**的:两次查询并发跑到 await 之间会从同一个 offset 各读一遍,
  // 同一行被计入两次。控制台 60s 轮询通常不会撞上,但刷新/多标签页会。串行化调用即可,
  // 反正每次查询本身是毫秒级;前一次失败不阻断后一次。
  let chain = Promise.resolve();

  function summarize(query) {
    const run = chain.then(() => doSummarize(query));
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  // 按行号从单个日志文件里取回指定行。只解析需要的行之外的整段 JSON —— records 是流式的,
  // 单页最多 200 行、通常只碰 1~2 个文件(最新行都在活动文件里),代价远小于为整段历史
  // 再缓存一份原始行。
  async function readEntryLines(entry, wanted) {
    const found = new Map();
    if (!file || !entry || !entry.row) return found;
    try {
      for await (const { value, line } of records(entry.row, file)) {
        if (!wanted.has(line)) continue;
        found.set(line, value);
        if (found.size === wanted.size) break;
      }
    } catch {
      // 扫描与回读之间文件被压缩/替换:能读到的先给,读不到的由 ts 校验丢掉,
      // 宁可少一行,也不能把别的行当成这一条返回。
    }
    return found;
  }

  async function doSummarize(query) {
    const at = now();
    const q = resolveQuery(query, at);

    // 1) 磁盘批 + 磁盘已覆盖的最大 ts(全局,不受过滤影响 —— 它就是"落盘到哪里了"的标记)
    //    spans 只记"第几行到第几行来自哪一份缓存",一个文件一条,不按行存定位信息。
    const rows = [];
    const spans = [];
    let diskMaxTs = null;
    for await (const batch of diskBatches()) {
      const start = rows.length;
      for (const row of batch.rows) {
        if (diskMaxTs === null || row.ts > diskMaxTs) diskMaxTs = row.ts;
        rows.push(row);
      }
      if (batch.rows.length) spans.push({ start, len: batch.rows.length, entry: batch.entry, lines: batch.lines, raws: null });
    }
    // 2) 内存只补磁盘没有的(ts 严格更大),避免同一条请求算两遍
    const mem = memoryRows();
    const memRows = [], memRaw = [];
    for (let i = 0; i < mem.compact.length; i++) {
      const row = mem.compact[i];
      if (diskMaxTs !== null && row.ts <= diskMaxTs) continue;
      memRows.push(row); memRaw.push(mem.raws[i]);
    }
    if (memRows.length) {
      spans.push({ start: rows.length, len: memRows.length, entry: null, raws: memRaw });
      for (const row of memRows) rows.push(row);
    }

    // 3) 一趟扫完:覆盖率(过滤前)、facets(时间+app+status,provider/model 之前)、命中集合。
    const selected = [];
    const selectedIdx = q.dashboard ? [] : null;
    const selectedChannels = q.dashboard ? [] : null;
    const channelOf = q.dashboard ? channelResolver(rows) : null;
    let chosenChannel = null; // 选中的渠道键对应的描述:被区间/app/status 筛掉时,下拉仍要写人话名字
    let firstTs = null, lastTs = null;
    const facetProviders = new Map(), facetModels = new Map(), facetChannels = new Map(), facetStatuses = new Map();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (firstTs === null || row.ts < firstTs) firstTs = row.ts;
      if (lastTs === null || row.ts > lastTs) lastTs = row.ts;
      const channel = channelOf ? channelOf(row) : null;
      if (channel && q.channel && channel.channel === q.channel) chosenChannel = channel;
      if (q.from !== null && row.ts < q.from) continue; // all 的 from 要读完才知道,不能拿 null 当 0 比较
      if (row.ts > q.to) continue;
      if (q.app && (row.app || 'claude') !== q.app) continue;
      if (q.status === 'ok' && !row.okStrict) continue;
      if (q.status === 'err' && row.okStrict) continue;
      if (q.dashboard) {
        if (q.search && ![row.provider, row.providerId, row.modelIn, row.modelOut, row.requestId, row.session]
          .some(value => value.toLowerCase().includes(q.search))) continue;
        bumpFacet(facetStatuses, String(row.status), row.status ? `HTTP ${row.status}` : '未收到响应');
        if (q.statusCode && String(row.status) !== q.statusCode) continue;
        bumpFacet(facetProviders, providerName(row));
        bumpFacet(facetModels, effectiveModel(row));
        bumpFacet(facetChannels, channel.channel, channel.name, { app: channel.app, provider_id: channel.provider_id });
        if (!matchesExact(row, q)) continue;
        if (q.channel && channel.channel !== q.channel) continue;
      } else if (!matchesLegacy(row, q)) continue;
      selected.push(row);
      if (selectedIdx) selectedIdx.push(i);
      if (selectedChannels) selectedChannels.push(channel);
    }
    // all:区间从最早一条开始(bucket 对齐后再往左取整)
    let earliest = null;
    if (q.from === null) for (const row of selected) if (earliest === null || row.ts < earliest) earliest = row.ts;
    const from = q.from === null ? (earliest === null ? localDayStart(at) : earliest) : q.from;
    const to = q.to;

    // 4) 分桶(先补齐空桶,再填数)。series 按查询粒度,daily 固定按日(小时区间汇总成天)。
    const buckets = emptyBuckets(from, to, q.bucket);
    const daily = q.dashboard ? emptyBuckets(from, to, 'day') : null;

    const totals = {
      reqs: 0, ok: 0,
      tokens_in: 0, tokens_out: 0, cache_read: 0,
      speed_out: 0, speed_ms: 0,
    };
    const ttfb = [];
    const byProvider = new Map();
    const byModel = new Map();
    const byChannel = new Map();

    for (let s = 0; s < selected.length; s++) {
      const row = selected[s];
      const model = effectiveModel(row);
      totals.reqs++;
      // 控制台的 ok 率与状态筛选必须同一口径(见 compact 的说明);老响应继续用老口径。
      if (q.dashboard ? row.okStrict : row.ok) totals.ok++;
      totals.tokens_in += row.inTok;
      totals.tokens_out += row.outTok;
      totals.cache_read += row.cache;
      if (row.ms > 0) { totals.speed_out += row.outTok; totals.speed_ms += row.ms; }
      if (row.ttfb > 0) ttfb.push(row.ttfb);

      fillBucket(buckets, row, q.bucket);
      if (daily) fillBucket(daily, row, 'day');

      const pkey = providerName(row);
      const p = byProvider.get(pkey) || { provider: pkey, name: pkey, reqs: 0, tokens_in: 0, tokens_out: 0, cache_read: 0 };
      p.reqs++; p.tokens_in += row.inTok; p.tokens_out += row.outTok; p.cache_read += row.cache;
      byProvider.set(pkey, p);

      const m = byModel.get(model) || { model, reqs: 0, tokens_in: 0, tokens_out: 0, cache_read: 0 };
      m.reqs++; m.tokens_in += row.inTok; m.tokens_out += row.outTok; m.cache_read += row.cache;
      byModel.set(model, m);

      if (selectedChannels) {
        const channel = selectedChannels[s];
        const c = byChannel.get(channel.channel) || { ...channel, reqs: 0, tokens_in: 0, tokens_out: 0, cache_read: 0 };
        c.reqs++; c.tokens_in += row.inTok; c.tokens_out += row.outTok; c.cache_read += row.cache;
        byChannel.set(channel.channel, c);
      }
    }

    const tokensTotal = totals.tokens_in + totals.tokens_out + totals.cache_read;
    const cacheDenom = totals.tokens_in + totals.cache_read;
    ttfb.sort((a, b) => a - b);

    // 排行榜按请求数降序,同数按名字 —— 读的人关心的是"谁在干活",不是金额
    const byReqsThenName = (a, b) => (b.reqs - a.reqs)
      || String(a.model || a.name).localeCompare(String(b.model || b.name));

    const out = {
      scope: {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        timezone: TIMEZONE,
        bucket: q.bucket,
        source: diskMaxTs === null ? 'memory' : 'disk+memory',
      },
      totals: {
        reqs: totals.reqs,
        ok_rate: totals.reqs ? round(totals.ok * 100 / totals.reqs, 2) : null,
        tokens_in: totals.tokens_in,
        tokens_out: totals.tokens_out,
        cache_read: totals.cache_read,
        tokens_total: tokensTotal,
        cache_hit_rate: cacheDenom ? round(totals.cache_read / cacheDenom, 4) : null,
        speed_tps: totals.speed_ms > 0 ? round(totals.speed_out / (totals.speed_ms / 1000), 2) : null,
        ttfb_p50_ms: percentile(ttfb, 0.5),
      },
      series: [...buckets.values()].map(b => ({
        t: b.t, reqs: b.reqs,
        tokens_in: b.tokens_in, tokens_out: b.tokens_out, cache_read: b.cache_read,
      })),
      by_provider: [...byProvider.values()].sort(byReqsThenName),
      by_model: [...byModel.values()].sort(byReqsThenName),
    };

    if (q.dashboard) {
      out.dashboard = {
        outcomes: { succeeded: totals.ok, failed: totals.reqs - totals.ok },
        daily: [...daily.values()].map(b => ({
          t: b.t, reqs: b.reqs,
          tokens_in: b.tokens_in, tokens_out: b.tokens_out, cache_read: b.cache_read,
        })),
        // 每项 { channel, provider_id, app, name, reqs, tokens_in, tokens_out, cache_read }
        by_channel: [...byChannel.values()].sort(byReqsThenName),
        records: await buildRecords(rows, selectedIdx, q, spans),
        facets: {
          status_codes: facetList(facetStatuses, q.statusCode, {
            value: q.statusCode, label: q.statusCode === '0' ? '未收到响应' : `HTTP ${q.statusCode}`,
          }),
          // 选中值即使已经不在数据里也要留在列表里(标记成选中、结果为空),
          // 前端不能因为"选项消失"就把过滤条件悄悄重置成全量。
          providers: facetList(facetProviders, q.providerExact),
          models: facetList(facetModels, q.modelExact),
          // { value: 渠道键, label: 显示名, app, provider_id };不认识的键原样回填
          channels: facetList(facetChannels, q.channel, chosenChannel
            ? { value: chosenChannel.channel, label: chosenChannel.name, app: chosenChannel.app, provider_id: chosenChannel.provider_id }
            : { value: q.channel, label: q.channel, app: '', provider_id: '' }),
        },
        coverage: {
          first_ts: firstTs === null ? null : new Date(firstTs).toISOString(),
          last_ts: lastTs === null ? null : new Date(lastTs).toISOString(),
        },
      };
    }

    return out;
  }

  // 行内容不在聚合缓存里 —— 按行号回读原文件,再过白名单投影。
  async function buildRecords(rows, selectedIdx, q, spans) {
    const matchedTotal = selectedIdx.length;
    // 近期明细先按时间截取窗口,再在窗口内排序;聚合仍使用完整筛选集合。
    const windowIdx = q.recordsScope === 'recent'
      ? selectedIdx.slice().sort((a, b) => rows[b].ts - rows[a].ts || b - a).slice(0, 1000)
      : selectedIdx;
    const total = windowIdx.length;
    const field = DASHBOARD_SORT_FIELDS[q.sort];
    const sortValue = row => {
      if (field === 'speed') return row.ms > 0 && row.outTok > 0 ? row.outTok * 1000 / row.ms : null;
      if ((field === 'ms' || field === 'ttfb') && row[field] <= 0) return null;
      return row[field];
    };
    const direction = q.order === 'asc' ? 1 : -1;
    const ordered = windowIdx.slice().sort((left, right) => {
      const leftValue = sortValue(rows[left]), rightValue = sortValue(rows[right]);
      if (leftValue === null && rightValue !== null) return 1;
      if (rightValue === null && leftValue !== null) return -1;
      return (leftValue - rightValue) * direction || (rows[right].ts - rows[left].ts) || (right - left);
    });
    const page = ordered.slice(q.offset, q.offset + q.limit);
    const out = new Array(page.length).fill(null);
    if (page.length) {
      const expected = page.map(idx => rows[idx].ts); // 回读后校验用:这一页每行聚合时的 ts

      const groups = new Map(); // entry → { entry, wanted: Map(line → [位置]) }
      for (let pos = 0; pos < page.length; pos++) {
        const loc = locate(spans, page[pos]);
        if (!loc) continue;
        if (loc.entry === null) {
          out[pos] = projectLogRow(loc.raws[loc.line]);
          continue;
        }
        let group = groups.get(loc.entry);
        if (!group) { group = { entry: loc.entry, wanted: new Map() }; groups.set(loc.entry, group); }
        const positions = group.wanted.get(loc.line);
        if (positions) positions.push(pos); else group.wanted.set(loc.line, [pos]);
      }
      for (const group of groups.values()) {
        const found = await readEntryLines(group.entry, new Set(group.wanted.keys()));
        for (const [line, positions] of group.wanted) {
          const raw = projectLogRow(found.get(line));
          if (!raw) continue;
          for (const pos of positions) {
            // 回读的行必须还是聚合时那一条;文件被替换过的话宁可让它空着(前端显示 —)。
            if (Date.parse(raw.ts) !== expected[pos]) continue;
            out[pos] = raw;
          }
        }
      }
    }
    const picked = out.filter(Boolean);
    return {
      rows: picked,
      total,
      scope: q.recordsScope,
      matched_total: matchedTotal,
      offset: q.offset,
      limit: q.limit,
      sort: q.sort,
      order: q.order,
      has_more: q.offset + page.length < total,
    };
  }

  return { summarize, _cache: cache };
}

// 全局下标 → 来源(哪个缓存/哪一行)。spans 按 start 升序、覆盖 [0, rows.length),二分即可。
// 注意物理行号来自 lines[]:**坏的/超长的行也被跳过但照样占一行**,数组下标和行号会错开;
// 拿下标当行号回读会读到隔壁那条(ts 一样时就"看起来对了")。
function locate(spans, index) {
  let lo = 0, hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (index < span.start) hi = mid - 1;
    else if (index >= span.start + span.len) lo = mid + 1;
    else {
      const offset = index - span.start;
      return { entry: span.entry, line: span.lines ? span.lines[offset] : offset, raws: span.raws };
    }
  }
  return null;
}

function emptyBuckets(from, to, bucket) {
  const buckets = new Map();
  let label = bucketLabel(bucketStart(from, bucket), bucket);
  for (let t = bucketStart(from, bucket), guard = 0; t <= to && guard < MAX_BUCKETS; t = nextBucket(t, bucket), guard++) {
    label = bucketLabel(t, bucket);
    buckets.set(label, { t: label, reqs: 0, tokens_in: 0, tokens_out: 0, cache_read: 0 });
  }
  // 区间为空(例如 all 且没有任何数据)时也给一个桶,前端不必处理 series:[]
  if (!buckets.size) buckets.set(label, { t: label, reqs: 0, tokens_in: 0, tokens_out: 0, cache_read: 0 });
  return buckets;
}

function fillBucket(buckets, row, bucket) {
  const bucketRow = buckets.get(bucketLabel(bucketStart(row.ts, bucket), bucket));
  if (!bucketRow) return;
  bucketRow.reqs++;
  bucketRow.tokens_in += row.inTok;
  bucketRow.tokens_out += row.outTok;
  bucketRow.cache_read += row.cache;
}

// extra 是随选项一起返回的附加字段(渠道的 app / provider_id),只在第一次见到这个值时记下。
function bumpFacet(map, value, label = value, extra = null) {
  const item = map.get(value);
  if (item) item.reqs++;
  else map.set(value, { value, label, ...extra, reqs: 1 });
}

// facets 的排序口径与 by_provider / by_model 一致(请求数降序、同数按名字),选中值缺失时补到末尾。
function facetList(map, selected, missing = { value: selected, label: selected }) {
  const list = [...map.values()]
    .sort((a, b) => (b.reqs - a.reqs) || a.label.localeCompare(b.label))
    .map(({ reqs, ...item }) => item);
  if (selected && !list.some(item => item.value === selected)) list.push(missing);
  return list;
}

module.exports = {
  createUsageSummary, resolveQuery, compact, percentile, projectLogRow,
  bucketStart, bucketLabel, nextBucket, TIMEZONE, RANGES,
  DASHBOARD_DEFAULT_LIMIT, DASHBOARD_MAX_LIMIT,
};
