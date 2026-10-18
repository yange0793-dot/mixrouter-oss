'use strict';
// Prometheus 文本编码器:纯函数,无 I/O、无时间、无全局状态。
// 输入形状 = lib/observability/request-log.js 的 metricsSnapshot(),见契约 §11.2。
//
// 为什么 counter 与 gauge 分得这么死 —— 这不是命名口味问题:
//   内存 window 有容量上限(默认 500)。任何从 window 重算出来的量,在旧条目被淘汰之后会**变小**,
//   即非单调。对非单调序列跑 rate()/increase() 会得到垃圾甚至负数,而 "_total" 这个名字本身
//   就是在向抓取方承诺单调递增。所以:
//     - 真正的累计量(store 里的进程生命周期累加器)才发 counter;
//     - 窗口口径一律 gauge,并且 HELP 里必须写明"窗口内、非累计"。
//
// 本模块是**第二层**防御:折算(折叠)的权威实现在 store 侧(request-log.js 建键时就折好),
// 这里再折一遍是为了挡住调用方手工喂进来的未折算快照。折完必须**聚合**——否则
// status 500/502/503 会各自折成 5xx,输出三行标签集完全相同的序列,那是**非法**的
// Prometheus 文本(解析器要么报错要么任取一行,rate()/sum by() 全失真)。
//
// 标签基数必须**有界**:只允许 app / status_class / wire / direction / quantile / kind。
// 越界值一律折进 unknown / none / other,绝不把 session、provider、model、err 或任意长名字
// 放进 label —— 那既会炸基数,也会把本不该出现在指标里的内容泄出去。

const APP_UNKNOWN = 'unknown';
const WIRE_NONE = 'none';
const STATUS_OTHER = 'other';
const APPS = new Set(['claude', 'codex']);
const WIRES = new Set(['anthropic', 'responses', 'chat']);

// 注意:store 侧缺 app 时按 'claude' 兜(沿用 mixrouter.js 全局 `e.app || 'claude'` 的既有语义),
// 与这里的 unknown 不是一回事 —— unknown 只兜"出现了 claude/codex 以外的值"。
const foldApp = value => (APPS.has(String(value)) ? String(value) : APP_UNKNOWN);
const foldWire = value => (WIRES.has(String(value)) ? String(value) : WIRE_NONE);
// 状态码折算:0/缺失/非数一律 other;499 是本项目的"客户端取消"标记(见 mixrouter.js 的
// entry.status = 499),它不是真的 4xx,所以也归 other。
// **必须幂等**:store 侧已折过一次,这里作为第二层防御会再折一次;
// 若不认已折算的 '5xx' 这类值,Number('5xx')=NaN 会被误折成 other(实测踩到过)。
const CLASSES = new Set(['2xx', '3xx', '4xx', '5xx', 'other']);
function foldStatusClass(status) {
  const raw = String(status);
  if (CLASSES.has(raw)) return raw;
  const code = Number(status);
  if (!Number.isFinite(code) || code === 0 || code === 499) return STATUS_OTHER;
  if (code >= 200 && code < 300) return '2xx';
  if (code >= 300 && code < 400) return '3xx';
  if (code >= 400 && code < 500) return '4xx';
  if (code >= 500 && code < 600) return '5xx';
  return STATUS_OTHER;
}
const foldDirection = value => (value === 'out' ? 'out' : 'in');
const foldQuantile = value => (String(value) === '0.95' ? '0.95' : '0.5');

// label 值转义:反斜杠、双引号、换行。顺序要紧 —— 先转义反斜杠,否则会把后面新加的
// 转义符再转义一遍。
const escapeLabel = value => String(value)
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\n/g, '\\n');

// 数值:绝不输出科学计数法(部分解析器不认 e 记法),非有限值返回 null 让调用方整行不输出。
function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) >= 1e21) return null; // 再大 toFixed 也会退化成指数记法
  if (Number.isInteger(n)) return String(n);
  const fixed = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return fixed === '' || fixed === '-' ? '0' : fixed;
}

const labels = pairs => (pairs.length
  ? `{${pairs.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`
  : '');

// 行序固定排序:同一份快照编出来的文本必须逐字节可复现,便于 diff 与测试比对。
const byKey = keys => (a, b) => {
  for (const k of keys) { const r = String(a[k]).localeCompare(String(b[k])); if (r) return r; }
  return 0;
};

// counter 行按**折算后**的键求和:同一标签集只能出现一行。
function aggregate(rows, keyOf) {
  const merged = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const prev = merged.get(key);
    if (prev) prev.count += row.count;
    else merged.set(key, { ...row });
  }
  return [...merged.values()];
}

function metricsText(snapshot = {}) {
  const counters = snapshot.counters || {};
  const window_ = snapshot.window || {};
  const out = [];

  const block = (name, type, help, rows) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...rows);
  };

  // ---- counter:进程生命周期累计,不随内存窗口淘汰回退 ----
  const requestRows = (counters.requests || [])
    .map(r => ({ app: foldApp(r.app), status_class: foldStatusClass(r.status_class), wire: foldWire(r.wire), count: Number(r.count) }))
    .filter(r => formatNumber(r.count) !== null);
  // 折算后聚合:500/502/503 要合成一行 5xx,而不是三行同标签序列(非法输出)
  const requests = aggregate(requestRows, r => `${r.app}\u0000${r.status_class}\u0000${r.wire}`)
    .sort(byKey(['app', 'status_class', 'wire']));
  block('mixrouter_requests_total', 'counter',
    '请求数,进程生命周期累计(不随内存窗口淘汰回退,进程重启归零)',
    requests.map(r => `mixrouter_requests_total${labels([['app', r.app], ['status_class', r.status_class], ['wire', r.wire]])} ${formatNumber(r.count)}`));

  const tokenRows = (counters.tokens || [])
    .map(r => ({ app: foldApp(r.app), direction: foldDirection(r.direction), count: Number(r.count) }))
    .filter(r => formatNumber(r.count) !== null);
  const tokens = aggregate(tokenRows, r => `${r.app}\u0000${r.direction}`)
    .sort(byKey(['app', 'direction']));
  block('mixrouter_tokens_total', 'counter',
    'token 数,进程生命周期累计(不随内存窗口淘汰回退,进程重启归零)',
    tokens.map(r => `mixrouter_tokens_total${labels([['app', r.app], ['direction', r.direction]])} ${formatNumber(r.count)}`));

  block('mixrouter_attempts_total', 'counter',
    '上游调用次数,进程生命周期累计(不随内存窗口淘汰回退,进程重启归零)',
    [formatNumber(counters.attempts) === null ? null : `mixrouter_attempts_total ${formatNumber(counters.attempts)}`].filter(Boolean));

  block('mixrouter_failover_total', 'counter',
    '换渠道次数,进程生命周期累计(不随内存窗口淘汰回退,进程重启归零)',
    [formatNumber(counters.failover) === null ? null : `mixrouter_failover_total ${formatNumber(counters.failover)}`].filter(Boolean));

  // ---- gauge:内存窗口口径,名字与 HELP 都写明 ----
  const capacity = formatNumber(window_.capacity);
  const used = formatNumber(window_.used);
  block('mixrouter_log_window', 'gauge',
    '内存日志窗口水位(窗口口径,非累计):capacity=容量,used=当前条数',
    [capacity === null ? null : `mixrouter_log_window${labels([['kind', 'capacity']])} ${capacity}`,
      used === null ? null : `mixrouter_log_window${labels([['kind', 'used']])} ${used}`].filter(Boolean));

  // 分位数是窗口重算的,所以是 gauge;不发 _sum/_count —— 那两个伴随序列会被当成 counter 读。
  // **分位数不能相加**:若折算后仍有两行撞到同一 (app, quantile)(说明调用方喂了未折算的快照),
  // 不能聚合出"正确"的值,只能确定性地保留一行(样本多的优先,再比数值),保证输出合法。
  // store 侧已按折算后的 app 分组算分位数,正常路径不会走到这个分支。
  const durationRows = (window_.duration || [])
    .map(r => ({ app: foldApp(r.app), quantile: foldQuantile(r.quantile), value: Number(r.value), samples: Number(r.samples) || 0 }))
    .filter(r => formatNumber(r.value) !== null);
  const durationBest = new Map();
  for (const row of durationRows) {
    const key = `${row.app}\u0000${row.quantile}`;
    const prev = durationBest.get(key);
    if (!prev || row.samples > prev.samples || (row.samples === prev.samples && row.value > prev.value)) durationBest.set(key, row);
  }
  const duration = [...durationBest.values()].sort(byKey(['app', 'quantile']));
  block('mixrouter_request_duration_ms', 'gauge',
    '耗时分位数,内存窗口内重算(窗口口径,非累计)',
    duration.map(r => `mixrouter_request_duration_ms${labels([['app', r.app], ['quantile', r.quantile]])} ${formatNumber(r.value)}`));

  return out.join('\n') + '\n';
}

module.exports = {
  metricsText, foldApp, foldStatusClass, foldWire, escapeLabel, formatNumber,
  APP_UNKNOWN, WIRE_NONE, STATUS_OTHER,
};
