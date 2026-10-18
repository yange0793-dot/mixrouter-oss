'use strict';
// 备份文件名的**唯一**真值在 mixrouter.js 的 backupFile 里 —— 那是一条模板字符串:
//   `${file}.bak-mixui-YYYYMMDD-HHMMSS-mmm-rrrr`
// 本模块不产生名字,只**认**名字。认的规则必须与那边逐字一致:一旦那边改了模板而这里没跟,
// "清点出来的备份"与"磁盘上躺着的备份"就成了两套东西,而清点的结论会被拿去决定删谁。
//
// 两种形状:
//   现行  <base>.bak-mixui-YYYYMMDD-HHMMSS-mmm-rrrr   毫秒补 3 位 + 随机段 4 位 hex(0e750ea 起)
//   历史  <base>.bak-mixui-YYYYMMDD-HHMMSS            秒级(0e750ea 之前,同秒内两次备份会静默覆盖)
// 历史名字磁盘上可能还躺着 —— 保留池是**按前缀捞**的,不按格式捞 —— 所以必须一并认,
// 但结果里用 legacy 标出来:调用方要知道"这一份没有毫秒,它不保证唯一"。
//
// 两件刻意不做的事:
//   1) 不宽松。`settings.json.bak-mixui-backup`(人手命名)、`...-20260920-120000-1-abcd`(毫秒没补零)
//      一律判不合法。宽松的代价不是"多认一个",而是**把不是备份的东西算进保留池**,
//      而保留池直接决定下一次备份删哪一份 —— 一个名字排错位置就能顶掉一份真备份。
//   2) 不只验形状。`20261340-999999` 形状完全合法,但它不是时间。正则通过 ≠ 时间存在,
//      所以年/月/日/时/分/秒逐项验真,日还要按月份与闰年算;只有形状对了、时间也真的存在,
//      才允许把一个名字当时间序的键来用。

const path = require('node:path');

const BACKUP_SUFFIX = '.bak-mixui-';

// 年份只收 4 位十进制里说得通的那一段。下界取 1970:这套备份是"程序跑起来才会生成"的,
// 它的时间戳不可能早于 Unix 纪元,早于纪元只可能是机器时钟坏了 —— 那种名字该进 unparsable
// 让人看见,而不是变成 ts=-1 悄悄排到队首被第一个删掉。
// 上界 2999 是 4 位字段的物理上界(3000 要 5 位,形状就已经不合法了)。
const MIN_YEAR = 1970;
const MAX_YEAR = 2999;

// 整条名字必须在正则里闭合:现行段与历史段用**同一个**可选组,
// 所以「秒级 + 多余的半个毫秒段」这种混搭不会拼出一个合法结果。
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{3})-([0-9a-f]{4}))?$/;

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeapYear = year => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const daysInMonth = (year, month) => (month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1]);

// 备份名里的时间是**本机挂钟时间**(backupFile 用的是 getFullYear/getMonth/... 这套本地字段)。
// 所以还原 ts 也必须按本地字段落位,否则东八区的名字会被当成 UTC 读,整整差 8 小时 ——
// 差值不影响"谁比谁旧"的排序,但会毁掉"这份备份是什么时候的"这个唯一的用途。
// 不用 `new Date(y, ...)` 构造:那个写法把 0..99 的年份映射成 1900+y,是一个静默错 1900 年的坑
// (当前 MIN_YEAR 挡得住,但让正确性依赖另一个常量是没必要的耦合)。
function localEpoch(year, month, day, hour, minute, second, ms) {
  const dt = new Date(0);
  dt.setFullYear(year, month - 1, day);
  dt.setHours(hour, minute, second, ms);
  return dt.getTime();
}

function backupPrefix(file) {
  if (typeof file !== 'string' || !file) {
    throw new TypeError(`backupPrefix: file 必须是非空字符串,实得 ${JSON.stringify(file)}`);
  }
  return path.basename(file) + BACKUP_SUFFIX;
}

// 反查:从一个备份文件名还原它备份的是谁(`settings.json.bak-mixui-…` -> `settings.json`)。
// readBackup 只拿到一个路径,没有 base;不给它这个函数,它就得把前缀拼法再写一遍 —— 也就是说,
// 名字格式的知识会散成两份。这里只做切分,不判断后缀形状(判断归 parseBackupName)。
function baseFromBackupName(fileName) {
  if (typeof fileName !== 'string') return null;
  const at = fileName.lastIndexOf(BACKUP_SUFFIX);
  return at > 0 ? fileName.slice(0, at) : null;
}

// 认一个名字。返回 { ok:true, ... } 或 { ok:false, reason }。
// reason 是稳定标识符(不进日志的散文),调用方可以直接按它分支;
// 人看的说明在 REASONS 里,不在这里拼字符串。
function parseBackupName(base, fileName) {
  // base 不合法是**调用方 bug**(不是"这个名字不合法"),所以抛而不是返回 ok:false ——
  // 返回 ok:false 会让一个写错的 base 变成"目录里全是坏名字"这种看着像数据问题的假象。
  const prefix = backupPrefix(base);
  const baseName = path.basename(base);
  const fail = (reason, extra) => ({
    ok: false, reason, base: baseName, prefix,
    name: typeof fileName === 'string' ? fileName : null, ...extra,
  });

  if (typeof fileName !== 'string' || !fileName) return fail('name-not-a-string');
  // 带路径的名字不是"一个名字"。放行的话 `/a/x.bak-mixui-20200101-000000` 就成了合法备份名,
  // 而保留池比较的永远是基名 —— 两种读法都说得通的地方就是将来出错的地方,所以只留一种。
  if (fileName !== path.basename(fileName)) return fail('not-a-basename');
  if (!fileName.startsWith(prefix)) return fail('prefix-mismatch');

  const m = STAMP_RE.exec(fileName.slice(prefix.length));
  // 形状不对就到此为止 —— 下面所有分支都建立在"7 段字段都在"之上。
  if (!m) return fail('bad-shape', { stamp: fileName.slice(prefix.length) });

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  // 毫秒段与随机段在**同一个**可选组里,要么都有要么都没有,不存在只缺一个的中间态。
  const legacy = m[7] === undefined;
  const ms = legacy ? 0 : Number(m[7]);
  const random = legacy ? null : m[8];
  const stamp = `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}`;
  const bad = reason => fail(reason, { stamp, legacy });

  // 下界(月>=1、日>=1、时>=0…)在正则的 `\d{2}` 里已经结构性成立,只写真正会漏的那一侧。
  if (year < MIN_YEAR || year > MAX_YEAR) return bad('bad-year');
  if (month < 1 || month > 12) return bad('bad-month');
  // 日必须按当月天数算:20260230 在 JS 里会被 Date 顺延成 3 月 2 日,不显式拦就等于放行了一个
  // 不存在的日期,而它排出来的先后是"3 月 2 日"——一份永远排不对的备份。
  if (day < 1 || day > daysInMonth(year, month)) return bad('bad-day');
  if (hour > 23) return bad('bad-hour');
  if (minute > 59) return bad('bad-minute');
  // 60 不接受:这条时间戳要参与排序与"是不是比现在早"的比较,闰秒在挂钟里不产生新的秒值。
  if (second > 59) return bad('bad-second');
  // 正则把毫秒限死在 3 位(<=999),所以这一条当前不可达;留着是为了正则一旦放宽时
  // 校验仍然自洽 —— 正确性不该依赖另一个常量的位数。
  if (ms > 999) return bad('bad-millisecond');

  const ts = localEpoch(year, month, day, hour, minute, second, ms);
  return {
    ok: true,
    base: baseName, prefix, name: fileName, stamp,
    legacy, random, ms,
    ts, iso: new Date(ts).toISOString(),
  };
}

// reason -> 人话。集中在一处,免得每个调用点各写一句、各说各的。
const REASONS = Object.freeze({
  'name-not-a-string': '名字不是字符串或为空',
  'not-a-basename': '带路径分隔符,不是单个文件名',
  'prefix-mismatch': `不以 <base>${BACKUP_SUFFIX} 开头`,
  'bad-shape': '时间戳形状不符(只认 YYYYMMDD-HHMMSS 与 YYYYMMDD-HHMMSS-mmm-rrrr 两种)',
  'bad-year': `年份不在 ${MIN_YEAR}..${MAX_YEAR}`,
  'bad-month': '月份不在 01..12',
  'bad-day': '该月没有这一天',
  'bad-hour': '小时不在 00..23',
  'bad-minute': '分钟不在 00..59',
  'bad-second': '秒不在 00..59',
  'bad-millisecond': '毫秒不在 000..999',
});

module.exports = {
  BACKUP_SUFFIX, MIN_YEAR, MAX_YEAR, STAMP_RE, REASONS,
  backupPrefix, baseFromBackupName, parseBackupName, isLeapYear, daysInMonth,
};
