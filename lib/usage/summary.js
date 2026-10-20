'use strict';
// 用量统计:按区间聚合磁盘日志 + 内存环,折算 token / 速度 / 首字延迟 / 成本。
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
//
// 分桶:
//   today / 24h → 'hour';7d / 30d / all → 'day';自定义区间按跨度选(≤48h 用小时)。
//   `t` 一律是**本地时间**的字符串:
//     hour → `YYYY-MM-DDTHH:00`(例 `2026-10-20T14:00`)
//     day  → `YYYY-MM-DD`(例 `2026-10-20`)
//   空桶补齐(曲线不能断)。scope.from/to 是 UTC ISO,便于和日志里的 ts 对齐;
//   跨时区展示请看 scope.timezone。

const { inventory } = require('../observability/log-files');
const { records } = require('../observability/log-history');
const { DEFAULT_PRICING, priceEntry } = require('./pricing');

const HOUR = 3600000;
const DAY = 86400000;
const MAX_BUCKETS = 5000;
const MAX_CACHE_ROWS_PER_FILE = 500000;
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

  return {
    range, from, to, bucket,
    app: String(q.app || '').trim(),
    provider: String(q.provider || '').trim().toLowerCase(),
    model: String(q.model || '').trim().toLowerCase(),
  };
}

function matches(row, q) {
  if (q.app && (row.app || 'claude') !== q.app) return false;
  if (q.provider && !row.provider.toLowerCase().includes(q.provider)) return false;
  if (q.model
    && !row.modelOut.toLowerCase().includes(q.model)
    && !row.modelIn.toLowerCase().includes(q.model)) return false;
  return true;
}

// ---- 日志行 → 紧凑行 --------------------------------------------------------
// 只留聚合要用的字段。日志条目本身有 30+ 个字段,整份缓存会把 30 天的量放大成几十万对象。
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
    modelOut: typeof record.model_out === 'string' ? record.model_out : '',
    modelIn: typeof record.model_in === 'string' ? record.model_in : '',
    status: Number.isFinite(status) ? status : 0,
    ok,
    inTok: num(record.in),
    outTok: num(record.out),
    cache: num(record.cache_read),
    ttfb: num(record.ttfb_ms),
    ms: num(record.ms),
  };
}

function createUsageSummary(options = {}) {
  const file = options.file || null;
  const getPricing = typeof options.getPricing === 'function'
    ? options.getPricing
    : () => ({ ...DEFAULT_PRICING, source: 'default' });
  const memoryEntries = typeof options.memoryEntries === 'function' ? options.memoryEntries : () => [];
  const providerIdOf = typeof options.providerIdOf === 'function' ? options.providerIdOf : () => '';
  const now = typeof options.now === 'function' ? options.now : Date.now;

  // inode → { size, offset, rows }
  const cache = new Map();

  async function* diskRows() {
    if (!file) return;
    let rows;
    try { rows = inventory(file); } catch { return; }
    const live = new Set();
    for (const row of rows) {
      const key = `${row.dev}:${row.ino}`;
      live.add(key);
      let entry = cache.get(key);

      if (row.gz) {
        if (entry && entry.size === row.size) { yield* entry.rows; continue; }
        const parsed = [];
        try { for await (const { value } of records(row, file)) { const r = compact(value); if (r) parsed.push(r); } }
        catch { continue; } // 归档在读取中被删/压缩:跳过这一份,下次 inventory 会看到新状态
        cache.set(key, { size: row.size, offset: row.size, rows: parsed });
        yield* parsed;
        continue;
      }

      // 原地截断/重写(大小变小)⇒ 旧缓存作废;变大按追加处理(JSONL 的契约)。
      if (!entry || entry.offset > row.size) entry = { size: 0, offset: 0, rows: [] };
      for (const r of entry.rows) yield r;
      if (row.size <= entry.offset) { cache.set(key, entry); continue; }

      const fresh = [];
      try {
        for await (const { value, end } of records(row, file, { start: entry.offset })) {
          const r = compact(value);
          if (r) fresh.push(r);
          if (Number.isInteger(end)) entry.offset = end;
        }
      } catch {
        // 读到一半文件被换掉/删掉:已完整读出的行仍然有效(end 只在换行之后推进),
        // 剩下的留给下一次调用从 offset 续读。
      }
      if (fresh.length) entry.rows.push(...fresh);
      // 缓存行数有上限。超过就把缓存置空、游标归零,下次整份重读 —— 正确性优先于省这一次 IO。
      if (entry.rows.length > MAX_CACHE_ROWS_PER_FILE) { entry.rows = []; entry.offset = 0; }
      entry.size = row.size;
      cache.set(key, entry);
      yield* fresh;
    }
    for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
  }

  function memoryRows() {
    let list;
    try { list = memoryEntries(); } catch { return []; }
    return (Array.isArray(list) ? list : []).map(compact).filter(Boolean);
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

  async function doSummarize(query) {
    const at = now();
    const q = resolveQuery(query, at);

    // 1) 磁盘行 + 磁盘已覆盖的最大 ts(全局,不受过滤影响 —— 它就是"落盘到哪里了"的标记)
    const rows = [];
    let diskMaxTs = null;
    for await (const row of diskRows()) {
      if (diskMaxTs === null || row.ts > diskMaxTs) diskMaxTs = row.ts;
      rows.push(row);
    }
    // 2) 内存只补磁盘没有的(ts 严格更大),避免同一条请求算两遍
    for (const row of memoryRows()) {
      if (diskMaxTs !== null && row.ts <= diskMaxTs) continue;
      rows.push(row);
    }

    const selected = [];
    for (const row of rows) {
      if (!matches(row, q)) continue;
      if (q.from !== null && row.ts < q.from) continue; // all 的 from 要读完才知道,不能拿 null 当 0 比较
      if (row.ts > q.to) continue;
      selected.push(row);
    }
    // all:区间从最早一条开始(bucket 对齐后再往左取整)
    let earliest = null;
    if (q.from === null) for (const row of selected) if (earliest === null || row.ts < earliest) earliest = row.ts;
    const from = q.from === null ? (earliest === null ? localDayStart(at) : earliest) : q.from;
    const to = q.to;

    const pricing = getPricing() || DEFAULT_PRICING;
    const table = pricing.pricing || pricing;
    const pricingSource = pricing.source === 'custom' ? 'custom' : 'default';

    // 3) 分桶(先补齐空桶,再填数)
    const buckets = new Map();
    let label = bucketLabel(bucketStart(from, q.bucket), q.bucket);
    for (let t = bucketStart(from, q.bucket), guard = 0; t <= to && guard < MAX_BUCKETS; t = nextBucket(t, q.bucket), guard++) {
      label = bucketLabel(t, q.bucket);
      buckets.set(label, { t: label, cost: 0, reqs: 0, tokens_in: 0, tokens_out: 0, cache_read: 0 });
    }
    // 区间为空(例如 all 且没有任何数据)时也给一个桶,前端不必处理 series:[]
    if (!buckets.size) buckets.set(label, { t: label, cost: 0, reqs: 0, tokens_in: 0, tokens_out: 0, cache_read: 0 });

    const totals = {
      cost: 0, reqs: 0, ok: 0,
      tokens_in: 0, tokens_out: 0, cache_read: 0,
      speed_out: 0, speed_ms: 0,
    };
    const ttfb = [];
    const byProvider = new Map();
    const byModel = new Map();
    const missing = new Set();

    for (const row of selected) {
      const model = row.modelOut || row.modelIn || '(?)';
      const providerId = providerIdOf(row.provider) || row.provider || '(未知)';
      // id 与名字都试:价目表结构按 providerId 组织,但日志里只有渠道名。
      const price = priceEntry(table, model, [providerId, row.provider].filter(Boolean));
      let cost = 0;
      if (price) {
        cost = row.inTok / 1e6 * (price.in || 0)
          + row.outTok / 1e6 * (price.out || 0)
          + row.cache / 1e6 * (price.cache_read || 0);
      } else {
        missing.add(model);
      }

      totals.reqs++;
      if (row.ok) totals.ok++;
      totals.cost += cost;
      totals.tokens_in += row.inTok;
      totals.tokens_out += row.outTok;
      totals.cache_read += row.cache;
      if (row.ms > 0) { totals.speed_out += row.outTok; totals.speed_ms += row.ms; }
      if (row.ttfb > 0) ttfb.push(row.ttfb);

      const bucket = buckets.get(bucketLabel(bucketStart(row.ts, q.bucket), q.bucket));
      if (bucket) {
        bucket.cost += cost; bucket.reqs++;
        bucket.tokens_in += row.inTok; bucket.tokens_out += row.outTok; bucket.cache_read += row.cache;
      }

      const pkey = row.provider || '(未知)';
      const p = byProvider.get(pkey) || { provider: providerId, name: pkey, reqs: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cost: 0 };
      p.reqs++; p.tokens_in += row.inTok; p.tokens_out += row.outTok; p.cache_read += row.cache; p.cost += cost;
      byProvider.set(pkey, p);

      const m = byModel.get(model) || { model, reqs: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cost: 0 };
      m.reqs++; m.tokens_in += row.inTok; m.tokens_out += row.outTok; m.cache_read += row.cache; m.cost += cost;
      byModel.set(model, m);
    }

    const tokensTotal = totals.tokens_in + totals.tokens_out + totals.cache_read;
    const cacheDenom = totals.tokens_in + totals.cache_read;
    ttfb.sort((a, b) => a - b);

    const byCostThenReqs = (a, b) => (b.cost - a.cost) || (b.reqs - a.reqs)
      || String(a.model || a.name).localeCompare(String(b.model || b.name));

    return {
      scope: {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        timezone: TIMEZONE,
        bucket: q.bucket,
        source: diskMaxTs === null ? 'memory' : 'disk+memory',
      },
      totals: {
        cost: round(totals.cost, 6),
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
        t: b.t, cost: round(b.cost, 6), reqs: b.reqs,
        tokens_in: b.tokens_in, tokens_out: b.tokens_out, cache_read: b.cache_read,
      })),
      by_provider: [...byProvider.values()]
        .map(p => ({ ...p, cost: round(p.cost, 6) })).sort(byCostThenReqs),
      by_model: [...byModel.values()]
        .map(m => ({ ...m, cost: round(m.cost, 6) })).sort(byCostThenReqs),
      pricing: { source: pricingSource, missing: [...missing].sort() },
    };
  }

  return { summarize, _cache: cache };
}

module.exports = {
  createUsageSummary, resolveQuery, compact, percentile,
  bucketStart, bucketLabel, nextBucket, TIMEZONE, RANGES,
};
