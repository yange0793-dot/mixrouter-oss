'use strict';
// 备份名解析(naming.js)的回归。**纯函数,不碰磁盘** —— 磁盘那一半在 backup-inventory.test.js。
//
// 这一组用例的取向与 naming.js 的两条"刻意不做的事"对齐:
//   1) 不宽松:`...-backup`(人手命名)、`...-539-6de`(随机段少一位)、`...-53-6de5`(毫秒没补零)
//      必须**全部**判不合法。宽松的代价不是"多认一个",而是把不是备份的东西算进保留池,
//      而保留池直接决定下一次备份删哪一份。所以下面每一条宽松方向的输入都单独列了一条。
//   2) 不只验形状:形状合法但时间不存在(`20261340-999999`)必须判不合法。
//      正则通过 ≠ 时间存在,所以年/月/日/时/分/秒逐项有反例。
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  backupPrefix, baseFromBackupName, parseBackupName,
  isLeapYear, daysInMonth, REASONS, BACKUP_SUFFIX, MIN_YEAR, MAX_YEAR,
} = require('../lib/backup/naming');

const BASE = 'settings.json';
const PRE = backupPrefix(BASE);

// 时间戳**本机挂钟**语义验真:还原出的 ts 拿回 Date 之后,本地字段必须逐个对得上。
// 不写 `new Date(y, m-1, ...)` 复算一遍 —— 那是把被测算法抄一遍当断言,抄错也一起错。
// 也不硬编码 +0800:挂钟语义与具体时区无关,而断言本地字段恰好把"被当成 UTC 读了"这个
// 最容易犯的错(整整差一个偏移量)挡在门外。
const assertLocalStamp = (ts, want, label) => {
  const d = new Date(ts);
  assert.equal(d.getFullYear(), want.year, `${label}: 年`);
  assert.equal(d.getMonth() + 1, want.month, `${label}: 月`);
  assert.equal(d.getDate(), want.day, `${label}: 日`);
  assert.equal(d.getHours(), want.hour, `${label}: 时`);
  assert.equal(d.getMinutes(), want.minute, `${label}: 分`);
  assert.equal(d.getSeconds(), want.second, `${label}: 秒`);
  assert.equal(d.getMilliseconds(), want.ms || 0, `${label}: 毫秒`);
};

test('naming: 现行格式 YYYYMMDD-HHMMSS-mmm-rrrr 被认且带毫秒与随机段', () => {
  const r = parseBackupName(BASE, PRE + '20260920-153749-539-6de5');
  assert.equal(r.ok, true, `应被认作合法,实得 ${r.reason}`);
  assert.equal(r.legacy, false, '带毫秒随机段的不是历史格式');
  assert.equal(r.ms, 539);
  assert.equal(r.random, '6de5');
  assert.equal(r.stamp, '20260920-153749', 'stamp 只到秒,不含毫秒与随机段');
  assert.equal(r.base, BASE);
  assert.equal(r.name, PRE + '20260920-153749-539-6de5');
  assertLocalStamp(r.ts, { year: 2026, month: 9, day: 20, hour: 15, minute: 37, second: 49, ms: 539 });
  assert.equal(r.iso, new Date(r.ts).toISOString(), 'iso 必须是 ts 的 ISO 形式');
});

test('naming: 历史秒级格式 YYYYMMDD-HHMMSS 仍被认作合法,并标 legacy', () => {
  // 0e750ea 之前的名字磁盘上可能还躺着(保留池按前缀捞,不按格式捞),不认它就会让
  // 一份真备份落进"读不出时间"那一类 —— 那正是保留池算错的入口。
  const r = parseBackupName(BASE, PRE + '20260920-153749');
  assert.equal(r.ok, true, `历史格式必须仍被认,实得 ${r.reason}`);
  assert.equal(r.legacy, true, '历史格式必须标 legacy(它不保证唯一,同秒两次会撞名)');
  assert.equal(r.ms, 0);
  assert.equal(r.random, null);
  assertLocalStamp(r.ts, { year: 2026, month: 9, day: 20, hour: 15, minute: 37, second: 49, ms: 0 });
  // 同一秒的历史名与现行名,秒级部分必须落在同一个 ts 上(毫秒补 0),否则两种格式
  // 排不出同一个时间轴。
  const modern = parseBackupName(BASE, PRE + '20260920-153749-000-0000');
  assert.equal(modern.ts, r.ts, '历史名的 ts 应等于同秒现行名毫秒为 0 的 ts');
});

test('naming: 非法时间戳逐项被拒(形状对但不是时间)', () => {
  const cases = [
    ['20261340-999999', 'bad-month', '月份 13'],
    ['20260020-120000', 'bad-month', '月份 00'],
    ['20260932-120000', 'bad-day', '9 月没有 32 日'],
    ['20260900-120000', 'bad-day', '日 00'],
    ['20260920-250000', 'bad-hour', '25 时'],
    ['20260920-156100', 'bad-minute', '61 分'],
    ['20260920-153760', 'bad-second', '60 秒(闰秒不产生新秒值,不接受)'],
    ['19691231-235959', 'bad-year', `年份早于 ${MIN_YEAR},只可能是时钟坏了`],
    ['30000101-000000', 'bad-year', `年份晚于 ${MAX_YEAR}`],
  ];
  for (const [stamp, reason, why] of cases) {
    const r = parseBackupName(BASE, PRE + stamp);
    assert.equal(r.ok, false, `${stamp} 必须判不合法(${why})`);
    assert.equal(r.reason, reason, `${stamp} 的 reason 应为 ${reason},实得 ${r.reason}`);
    assert.ok(REASONS[r.reason], `${r.reason} 必须在 REASONS 里有对应人话`);
  }
});

test('naming: 日期按当月天数与闰年算', () => {
  const ok = ['20240229-000000', '20200229-000000', '20240229-000000-000-aaaa', '20000229-000000'];
  for (const stamp of ok) {
    assert.equal(parseBackupName(BASE, PRE + stamp).ok, true, `${stamp} 应合法`);
  }
  // 2026 不是闰年;2100 是百年不闰(能被 4 整除但被 100 整除),两条分开列,
  // 因为只判 `% 4` 的实现能过第一条、过不了第二条。
  const bad = [
    ['20260229-000000', 'bad-day', '2026 不是闰年'],
    ['21000229-000000', 'bad-day', '2100 是百年不闰(1900 会被 MIN_YEAR 挡掉,所以用 2100)'],
  ];
  for (const [stamp, reason, why] of bad) {
    const r = parseBackupName(BASE, PRE + stamp);
    assert.equal(r.ok, false, `${stamp} 应不合法(${why})`);
    assert.equal(r.reason, reason, `${stamp} 的 reason 应为 ${reason},实得 ${r.reason}`);
  }
  assert.equal(isLeapYear(2000), true, '2000 能被 400 整除,是闰年');
  assert.equal(isLeapYear(2100), false, '2100 百年不闰');
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2026, 4), 30);
});

test('naming: 形状上任何一处松动都被拒(宽松会把非备份算进保留池)', () => {
  const cases = [
    ['backup', 'bad-shape', '人手命名'],
    ['notatimestamp', 'bad-shape', '任务书点名的这一条'],
    ['20260920-153749-53-6de5', 'bad-shape', '毫秒没补零(-53 会排在 -123 之后)'],
    ['20260920-153749-5396de5', 'bad-shape', '毫秒与随机段之间缺分隔符'],
    ['20260920-153749-539-6de', 'bad-shape', '随机段 3 位(应为 4 位)'],
    ['20260920-153749-539-6deg', 'bad-shape', '随机段不是 hex'],
    ['20260920-153749-539-6DE5', 'bad-shape', '随机段大写 hex(模板产出的是小写)'],
    ['20260920-153749-539-6de5-extra', 'bad-shape', '尾部多一段'],
    ['20260920-153749-539', 'bad-shape', '只有毫秒没有随机段(半截的中间态)'],
    ['20260920-153749-6de5', 'bad-shape', '只有随机段没有毫秒'],
    ['2026092-153749', 'bad-shape', '日期少一位'],
    ['20260920-15374', 'bad-shape', '时间少一位'],
    ['20260920 153749', 'bad-shape', '用空格代替连字符'],
    ['20260920-153749-539-6de5 ', 'bad-shape', '尾部空白'],
    ['', 'bad-shape', '前缀之后一个字符都不剩'],
  ];
  for (const [stamp, reason, why] of cases) {
    const r = parseBackupName(BASE, PRE + stamp);
    assert.equal(r.ok, false, `${JSON.stringify(stamp)} 必须判不合法(${why})`);
    assert.equal(r.reason, reason, `${JSON.stringify(stamp)} 的 reason 应为 ${reason},实得 ${r.reason}`);
  }
  // 非字符串一律不许抛,必须是结构化的 ok:false(调用方要能按 reason 分支)
  for (const weird of [null, undefined, 42, {}, []]) {
    const r = parseBackupName(BASE, weird);
    assert.equal(r.ok, false, `${JSON.stringify(weird)} 应返回 ok:false 而不是抛`);
    assert.equal(r.reason, 'name-not-a-string');
    assert.equal(r.name, null);
  }
  // 空串走的是另一条分支(它过了"是字符串"那一关,再过不了"非空"),reason 是 name-not-a-string。
  // 这个区分不重要,重要的是两种空都**必须**被判不合法。
  assert.equal(parseBackupName(BASE, '').ok, false);
  assert.equal(parseBackupName(BASE, '').reason, 'name-not-a-string');
});

test('naming: 前缀不对与带路径的名字被拒', () => {
  const mismatch = parseBackupName(BASE, 'config.toml' + BACKUP_SUFFIX + '20260920-153749');
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'prefix-mismatch');

  // 带路径的名字不是"一个名字"。放行的话 `/a/x.bak-mixui-…` 就成了合法备份名,
  // 而保留池比较的永远是基名 —— 两种读法都说得通的地方就是将来出错的地方。
  const withPath = parseBackupName(BASE, '/a/b/' + PRE + '20260920-153749');
  assert.equal(withPath.ok, false);
  assert.equal(withPath.reason, 'not-a-basename');

  // 前缀命中但后面一个字符都不剩
  const empty = parseBackupName(BASE, PRE);
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'bad-shape');
});

test('naming: base 不合法是调用方 bug,抛而不是返回 ok:false', () => {
  // 返回 ok:false 会让一个写错的 base 变成"目录里全是坏名字"这种看着像数据问题的假象。
  for (const bad of ['', null, undefined, 42]) {
    assert.throws(() => parseBackupName(bad, PRE + '20260920-153749'), TypeError, `base=${JSON.stringify(bad)} 应抛 TypeError`);
    assert.throws(() => backupPrefix(bad), TypeError, `backupPrefix(${JSON.stringify(bad)}) 应抛 TypeError`);
  }
});

test('naming: prefix 与 base 反查互为逆运算', () => {
  for (const base of ['settings.json', 'config.toml', 'a/b/settings.json']) {
    const prefix = backupPrefix(base);
    const flat = base.split('/').pop();
    assert.equal(prefix, flat + BACKUP_SUFFIX, 'prefix 用基名拼,不带目录');
    assert.equal(baseFromBackupName(prefix + '20260920-153749'), flat);
    assert.equal(baseFromBackupName('nope'), null, '没有后缀就反查不出 base');
    assert.equal(baseFromBackupName(42), null, '非字符串返回 null,不抛');
  }
});
