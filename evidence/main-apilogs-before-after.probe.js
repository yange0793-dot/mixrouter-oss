#!/usr/bin/env node
// 主会话独立写 —— /api/logs 接线前后逐字对照（必交项②）
//
// 方法：两侧的 limit 语义都从**源码里机械抽出**，不用手抄。
//   单体侧：从 mixrouter.js 抽出真实表达式文本，用 new Function 还原成可调用函数
//           （只在探针进程里构造，不碰仓库、不碰生产）
//   模块侧：直接用生产模块 createRequestLog 的 list()
// 探针必须对**两侧都是真调用**，才叫对照；只跑一侧再手写另一侧期望值不算。

const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(REPO, 'mixrouter.js'), 'utf8');

// ---- 机械抽出单体侧的 limit 表达式 ----
const m = src.match(/const limit = Math\.min\(Number\(q\.get\('limit'\) \|\| \d+\)[^;]*;/);
if (!m) { console.log('❌ 未能从 mixrouter.js 抽出 limit 表达式，抽取值锚点失效'); process.exit(2); }
const MONO_LIMIT_SRC = m[0].replace(/^const limit = /, '').replace(/;$/, '');
const RING_SIZE = (() => {
  const r = src.match(/const RING_SIZE = (\d+)/);
  return r ? Number(r[1]) : null;
})();
console.log('从 mixrouter.js 抽出的单体侧表达式：');
console.log('   ', MONO_LIMIT_SRC);
console.log('    （RING_SIZE 读得 =', RING_SIZE, '）');

// 还原成可调用函数：'q' 用 Map 形态喂，'RING_SIZE' 注入
const monoLimit = new Function('q', 'RING_SIZE', `return ${MONO_LIMIT_SRC};`);

// 单体侧的行选择逻辑，也机械抽出
const selM = src.match(/return send\(200, \{ logs: items\.slice\((-?\w+)\)\.reverse\(\) \}\);/);
if (!selM) { console.log('❌ 未能抽出单体侧 slice 写法'); process.exit(2); }
const MONO_SLICE = selM[1];
console.log('从 mixrouter.js 抽出的单体侧选取写法： items.slice(' + MONO_SLICE + ').reverse()');

const { createRequestLog, DEFAULT_LIMIT } = require(path.join(REPO, 'lib/observability/request-log.js'));

// ---- 同一批输入 ----
const SECRET = 'sk-ant-api03-SUPERSECRETVALUE0123456789';
// ⚠ 环长必须 > DEFAULT_LIMIT(200) 且 > 5，否则 limit='abc' 与 limit=-5 两处的真实差异
//   会被"环比 limit 小"盖住，读成"两侧一致"。第一版探针用 3 条，就是这么漏掉 2/3 的。
const N = 250;
const TS = i => new Date(Date.UTC(2026, 8, 20, 10, 0, i)).toISOString();
const ENTRIES = Array.from({ length: N }, (_, i) => ({
  ts: TS(i), app: i % 3 === 0 ? 'codex' : 'claude', provider: 'p' + (i % 5),
  model_in: 'opus', status: 200, in: i, out: i, err: '',
}));
// 把三种特殊输入塞进环里，且落在"最近 N 条"窗口内
ENTRIES[N - 3].model_in = SECRET;                                   // 密钥被填进 model_in
ENTRIES[N - 2].status = 401;
ENTRIES[N - 2].provider = 'superseded';
ENTRIES[N - 2].err = `upstream said key=${SECRET} is invalid`;      // 密钥出现在 err 原文
Object.assign(ENTRIES[N - 1], { client_ip: '10.0.0.9', whoami: SECRET }); // 非白名单键
const CAP = ENTRIES.length;
const Q = { get: k => (k === 'limit' ? CUR : null) };
let CUR = null;

// ---- 两侧各自算一遍 ----
const monoSide = (limitRaw) => {
  const q = { get: k => (k === 'limit' ? limitRaw : null) };
  const limit = monoLimit(q, RING_SIZE);
  const items = ENTRIES;                       // 探针里 ring == ENTRIES
  return { limitValue: limit, logs: items.slice(eval(MONO_SLICE)).reverse() };
};
const modSide = (limitRaw) => {
  const rl = createRequestLog({ capacity: CAP, secrets: [SECRET] });
  for (const e of ENTRIES) rl.append({ ...e });
  const r = rl.list({ limit: limitRaw });
  return { limitValue: undefined, logs: r.logs, matched: r.matched, capacity: r.capacity };
};

const CASES = [
  ['limit 不传', undefined],
  ["limit='abc'（非数字）", 'abc'],
  ["limit=''（空串）", ''],
  ['limit=0', 0],
  ['limit=-5', -5],
  ['limit=2', 2],
  ['limit=1e9（超上限）', 1e9],
];

console.log('\n' + '='.repeat(78));
console.log('逐字对照（环 = ' + N + ' 条；末 3 条分别为「model_in 被填密钥」「err 含密钥」'
  + '「带非白名单键 client_ip/whoami」），环长刻意 > DEFAULT_LIMIT=200');
console.log('='.repeat(78));

let diffCount = 0;
for (const [name, raw] of CASES) {
  const A = monoSide(raw);
  const B = modSide(raw);
  const aN = A.logs.length, bN = B.logs.length;
  const same = aN === bN && JSON.stringify(A.logs.map(x => x.ts)) === JSON.stringify(B.logs.map(x => x.ts));
  if (!same) diffCount++;
  console.log(`\n【${name}】`);
  console.log(`  接线前(单体): limit=${A.limitValue}  返回 ${aN} 条  ${same ? '' : '  <<< 差异'}`);
  console.log(`  接线后(模块): limit=${B.limitValue === undefined ? '(normalizeLimit)' : B.limitValue}  返回 ${bN} 条  matched=${B.matched} capacity=${B.capacity}`);
  if (!same) console.log(`  ⇒ 条数/顺序不同：${aN} vs ${bN}`);
}

// ---- 响应形状与内容差异（固定用 limit=2 看内容） ----
console.log('\n' + '='.repeat(78));
console.log('响应形状与内容（limit=2）');
console.log('='.repeat(78));
const A2 = monoSide(2), B2 = modSide(2);
console.log('\n接线前 每条 entry 的键：');
console.log('  ', JSON.stringify(Object.keys(A2.logs[0])));
console.log('接线后 每条 entry 的键：');
console.log('  ', JSON.stringify(Object.keys(B2.logs[0])));
const beforeKeys = new Set(Object.keys(A2.logs[0]));
const afterKeys = new Set(Object.keys(B2.logs[0]));
console.log('  ⇒ 接线后会消失的键：', [...beforeKeys].filter(k => !afterKeys.has(k)));
const extra = [];
for (const e of A2.logs) for (const k of Object.keys(e)) if (!beforeKeys.has(k) && !afterKeys.has(k)) extra.push(k);
console.log('  ⇒ 接线后会消失的键（全体 entry 并集）：',
  [...new Set(A2.logs.flatMap(e => Object.keys(e)).filter(k => !afterKeys.has(k)))]);

console.log('\n密钥落盘对照：');
const beforeText = JSON.stringify(A2.logs);
const afterText = JSON.stringify(B2.logs);
console.log('  接线前 JSON 里出现密钥明文：', beforeText.includes(SECRET));
console.log('  接线后 JSON 里出现密钥明文：', afterText.includes(SECRET));
console.log('  ⇒ 接线前泄漏面：',
  A2.logs.filter(e => JSON.stringify(e).includes(SECRET)).map(e => e.ts));

console.log('\n白名单外键（client_ip / whoami）对照：');
console.log('  接线前保留：', A2.logs.some(e => 'client_ip' in e || 'whoami' in e));
console.log('  接线后保留：', B2.logs.some(e => 'client_ip' in e || 'whoami' in e));

console.log('\n' + '='.repeat(78));
console.log(`条数/顺序有差异的用例数：${diffCount} / ${CASES.length}`);
console.log('='.repeat(78));
