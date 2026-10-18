'use strict';
// 备份清点(inventory.js)的回归。**只读模块,这里的用例也一个字节都不改被测目录** ——
// 唯一的例外是"真实生产路径"那一条:它先由 switchClaude 真的产出一份备份,再清点。
//
// 这一组的取舍:
//   · 有**一条**用例走真实写入路径并在结果上再断言一次"磁盘上确实躺着这份备份"。
//     只用手工构造的文件名测清点等于自说自话:名字模板改了、写盘失败、保留池把刚写的删了,
//     这些错误全都测不出来,而它们恰恰是这个模块唯一的用途(回答"盘上有什么")。
//   · 其余用例全部手工造目录:清点要看的是"名字与磁盘事实不一致时怎么办",
//     靠真实写入造不出 unparsable / 非常规文件 / 超限这些形态。
//   · 保留池预测**不按"更合理"的规则算**,按 backupFile 里那条真实规则算(纯字典序 slice)。
//     下面 REFERENCE 那个函数是照着 mixrouter.js 原文抄的对照实现,与实现比对 ——
//     报告一个漂亮的、但和实际会发生的删除不一样的数,比不报更坏。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------- 隔离环境
// 环境变量必须在 require mixrouter.js **之前**设好:模块顶层就把 CLAUDE_SETTINGS 定死了。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-bak-inv-'));
const HOME = path.join(TMP, 'home');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.XDG_CONFIG_HOME = path.join(HOME, '.config');
process.env.MIXR_DATA_DIR = path.join(TMP, 'data');
process.env.MIXR_CLAUDE_SETTINGS = SETTINGS;
process.env.MIXR_CODEX_CONFIG = path.join(HOME, '.codex', 'config.toml');
process.env.MIXR_ZCODE_CONFIG = path.join(HOME, '.zcode', 'v2', 'config.json');
for (const d of ['home', 'data']) fs.mkdirSync(path.join(TMP, d), { recursive: true });

const { switchClaude } = require('../mixrouter.js');
const {
  listBackups, readBackup, computeRetention, sha256File,
  DEFAULT_KEEP, DEFAULT_HASH_MAX_BYTES,
} = require('../lib/backup/inventory');
const { backupPrefix } = require('../lib/backup/naming');

const BASE = 'settings.json';
const PRE = backupPrefix(BASE);
const list = dir => fs.readdirSync(dir).sort();

// 每个用例一个自己的目录:共用目录时上一条留下的备份会跑进下一条的保留池,
// 而"保留池里该有谁"正是这些用例的断言对象。
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-inv-'));
// 造一个文件。**返回基名**(清点用例把它当 entries/unparsable 的键来用),
// 需要完整路径的地方自己 path.join —— 这个返回值的模糊正是一次真实红灯的来源:
// readBackup / sha256File 收的是路径,传进去一个相对基名会以 ENOENT 报成"文件不存在",
// 而文件其实好好地躺在 dir 里。
const put = (dir, name, text = 'x') => { fs.writeFileSync(path.join(dir, name), text); return name; };

// ---------------------------------------------------------------- 对照实现
// 逐字照抄 mixrouter.js 的 backupFile 里那两行(原文在 mixrouter.js:81203-81204)。
// 它不是"我认为对的规则",是"实际会发生的删除"的对照 —— 所以实现一旦"顺手改良",
// 这两边就会分开,而分开正是这里要看见的信号。
const REAL_KEEP = 5;                 // = mixrouter.js BACKUP_KEEP(mixrouter.js:7296)
const REFERENCE = {
  // readdirSync(dir).filter(f => f.startsWith(base + '.bak-mixui-')).sort()
  pool: dir => list(dir).filter(f => f.startsWith(`${BASE}.bak-mixui-`)).sort(),
  // olds.slice(0, Math.max(0, olds.length - BACKUP_KEEP))
  deleted: pool => pool.slice(0, Math.max(0, pool.length - REAL_KEEP)),
};

// 时间戳解析本机挂钟语义的对照(与 naming.js 同一套字段,写法独立)。
// 毫秒段带不带随机段**都必须匹配** —— 写成 `(?:-\\d{3})?-...` 那种可选形状的话,
// 随机段那一节对现行名字恒为必然而对历史名字恒为可选,等于把"两种格式"这件事在对照里
// 又写了一遍;写成两个正则分别落在两段上,才真的是从原文独立复算。
const stampToMs = name => {
  const m = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([0-9a-f]{4})$/.exec(name)
    || /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})-[0-9a-f]{4}$/.exec(name);
  const d = new Date(0);
  d.setFullYear(+m[1], +m[2] - 1, +m[3]);
  d.setHours(+m[4], +m[5], +m[6], m[7] ? +m[7] : 0);
  return d.getTime();
};

// ---------------------------------------------------------------- 真实生产路径
test('inventory: 经 switchClaude 真实产出的备份被清点出来,时间与磁盘 mtime 一致且 legacy=false', t => {
  t.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify({ env: { ANTHROPIC_MODEL: 'keep-model' } }, null, 2) + '\n');
  const before = list(path.dirname(SETTINGS));

  const t0 = Date.now();
  switchClaude({
    id: 'p1', name: '清点测试', base_url: 'http://127.0.0.1:8787', api_key: 'sk-test',
    models: ['claude-opus-5'],
  });
  const t1 = Date.now();

  const dir = path.dirname(SETTINGS);
  const r = listBackups({ dir, base: BASE });

  // 活文件那一份不许被算成备份
  assert.equal(r.total, 1, `应清点出 1 份备份,实得 ${r.total}(目录:${list(dir).join(', ')})`);
  assert.equal(r.entries.length, 1);
  assert.equal(r.unparsable.length, 0, '真实产出的名字不该进 unparsable');
  assert.equal(r.unreadable.length, 0, '真实产出的备份必须是可读的常规文件');

  const e = r.entries[0];
  assert.equal(e.name, e.id);
  assert.equal(e.base, BASE);
  assert.equal(e.path, path.join(dir, e.name));
  assert.equal(e.legacy, false, '现行模板产出的名字必须判定为 legacy=false');
  assert.match(e.name, new RegExp(`^${BASE.replace('.', '\\.')}\\.bak-mixui-\\d{8}-\\d{6}-\\d{3}-[0-9a-f]{4}$`),
    `名字形状应与命名模板一致,实得 ${e.name}`);
  assert.equal(e.random.length, 4);
  assert.equal(e.ms, Number(e.name.slice(-8, -5)));
  assert.equal(before.filter(n => n.startsWith(PRE)).length, 0, '前置:切换之前目录里不该有备份');

  // 名字里解析出的时间 与 磁盘 mtime。两者是**两次独立记录同一时刻**:
  // 名字由 switchClaude 内部构造,但 mtime 是在落盘时由 CPU 时钟盖上并保留亚毫秒小数。
  // 所以这里比的是"落在同一次调用的时间窗口内",不是逐毫秒相等 —— APFS 的 mtime 带小数位,
  // 逐毫秒相等会因四舍五入而偶发假红,那种断言在 CI 上就是随机失败。
  assert.ok(e.ts >= t0 && e.ts <= t1, `名字时间戳 ${e.iso} 应落在这次调用的窗口 [${new Date(t0).toISOString()}, ${new Date(t1).toISOString()}] 内`);
  assert.equal(e.ts, stampToMs(e.name), 'ts 必须能由名字按本机挂钟语义复算出来');
  assert.ok(Math.abs(e.ts - e.mtimeMs) < 2000,
    `名字时间与磁盘 mtime 应一致(同一时刻的两次记录),实得差 ${e.ts - e.mtimeMs}ms`);
  assert.equal(e.iso, new Date(e.ts).toISOString());

  // 磁盘事实:这份备份真的存在、是常规文件、内容与活文件当时的模样一致(备份里留着改前的 ANTHROPIC_MODEL)
  const st = fs.statSync(e.path);
  assert.equal(e.size, st.size, '清点报的 size 应等于磁盘上的 size');
  assert.equal(e.mode, st.mode & 0o777, '清点报的 mode 应等于磁盘上的 mode');
  assert.equal(e.mtimeMs, st.mtimeMs, '清点报的 mtimeMs 应等于磁盘上的 mtimeMs');
  assert.match(fs.readFileSync(e.path, 'utf8'), /keep-model/, '备份内容应是切换前的活文件');

  // sha256:清点给的摘要能与独立复算对上(否则"这份和那份是不是一样"就没有依据)
  assert.equal(e.sha256, crypto.createHash('sha256').update(fs.readFileSync(e.path)).digest('hex'));
  assert.equal(e.hashed, true);
  assert.equal(e.hashSkipped, null);

  // 保留池预测 与 backupFile 真实规则一致(此刻只有 1 份,下次备份不该删任何东西)
  assert.deepEqual(r.retention.pool, REFERENCE.pool(dir), 'pool 必须与 readdirSync + startsWith + sort 逐项相同');
  assert.equal(r.retention.wouldDeleteCount, 0);
  assert.deepEqual(r.retention.wouldDeleteOnNextBackup, []);
  assert.equal(r.retention.deletesNothing, true, '清点只算不删');
  assert.equal(r.retention.total, r.total);

  // 隔离:这次运行在 HOME 下只该出现 settings.json 与它的备份,一个多余的路径都不许有。
  // 用"白名单之外的路径"而不是"某个路径不存在"来断言 —— 后者只挡住我已经想到的那个。
  const found = [];
  (function walk(parent) {
    for (const name of list(parent)) {
      const p = path.join(parent, name);
      found.push(path.relative(TMP, p));
      if (fs.lstatSync(p).isDirectory()) walk(p);
    }
  })(TMP);
  // 允许的是"形状":隔离 HOME 下除了活文件本身、它的备份、以及两个我们建出来的空目录,
  // 不该有任何别的东西。按形状而不是按枚举,是为了连"多出来的临时文件"也一并看见。
  const extra = found.filter(p => !(
    p === 'data' || p === 'home' || p === path.join('home', '.claude')
    || p === path.join('home', '.claude', BASE)
    || (path.dirname(p) === path.join('home', '.claude') && path.basename(p).startsWith(PRE))
  ));
  assert.deepEqual(extra, [], `隔离目录下出现了预期之外的路径: ${extra.join(', ')}`);
  assert.ok(!fs.existsSync(path.join(HOME, '.codex')), 'switchClaude 不该碰 Codex 配置目录');
  assert.ok(!fs.existsSync(path.join(HOME, '.zcode')), 'switchClaude 不该碰 ZCode 配置目录');

  // 真实 HOME:路径取自 os.userInfo().homedir —— 它由 getpwuid 给出,**不受 process.env.HOME 影响**,
  // 所以这一条查的确实是这台机器的真实 HOME,而不是我们自己设的那个。
  // 只取 stat 元数据,不读内容、不写:红线是"不碰真实配置",核对"没碰"至少要能看见它。
  const realHome = os.userInfo().homedir;
  assert.notEqual(path.resolve(realHome), path.resolve(HOME), '前置:真实 HOME 必须与隔离 HOME 不同,否则这条断言是空的');
  const realSettings = path.join(realHome, '.claude', 'settings.json');
  let realBefore = null;
  try { const s = fs.statSync(realSettings); realBefore = { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino }; } catch (err) { realBefore = null; }
  switchClaude({
    id: 'p2', name: '清点测试2', base_url: 'http://127.0.0.1:8787', api_key: 'sk-test',
    models: ['claude-opus-5'],
  });
  let realAfter;
  try { const s = fs.statSync(realSettings); realAfter = { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino }; } catch (err) { realAfter = null; }
  assert.deepEqual(realAfter, realBefore, `${realSettings} 被改动了(本次运行只许碰 ${SETTINGS})`);
  assert.equal(path.resolve(process.env.MIXR_CLAUDE_SETTINGS), path.resolve(SETTINGS), 'MIXR_CLAUDE_SETTINGS 必须仍指向隔离路径');
});

// ---------------------------------------------------------------- 历史格式
test('inventory: 秒级历史格式被认作合法并标 legacy,与现行格式混在同一池里按时间排', t => {
  const dir = tmpdir();
  const legacy = put(dir, `${PRE}20200101-000000`, 'legacy-1');
  const legacy2 = put(dir, `${PRE}20200101-000001`, 'legacy-2');
  const modern = put(dir, `${PRE}20260920-153749-539-6de5`, 'modern');
  put(dir, BASE, 'live');                       // 活文件:前缀不命中,不进池

  const r = listBackups({ dir, base: BASE });
  assert.equal(r.total, 3, '活文件不该被算进 reservoir');
  assert.equal(r.entries.length, 3);
  assert.equal(r.legacyCount, 2, '两份秒级历史名的计数必须单独给出');

  const byName = Object.fromEntries(r.entries.map(e => [e.name, e]));
  assert.equal(byName[legacy].legacy, true);
  assert.equal(byName[legacy].ms, 0);
  assert.equal(byName[legacy].random, null);
  assert.equal(byName[legacy2].legacy, true);
  assert.equal(byName[modern].legacy, false);

  // entries 是**时间序**:历史那份 2020 必须排在现行那份 2026 前面
  assert.deepEqual(r.entries.map(e => e.name), [legacy, legacy2, modern], 'entries 必须按 ts 升序');
  assert.ok(byName[legacy].ts < byName[modern].ts);
  // 秒级格式的粒度就是秒:相邻两秒的名字必须差整整 1000ms(而不是差 1ms —— 那是把
  // 秒级名当成"毫秒段缺省"读错了位)。这一条同时钉住"秒字段落位正确"。
  assert.equal(byName[legacy2].ts - byName[legacy].ts, 1000, '相邻两秒的历史名应差 1000ms');
  assert.deepEqual(listBackups({ dir, base: BASE }).entries.map(e => e.name), r.entries.map(e => e.name),
    '两次清点必须给出同一个顺序');
});

// ---------------------------------------------------------------- 非法名
test('inventory: 前缀命中但名字不合法的进 unparsable,不静默丢弃', t => {
  const dir = tmpdir();
  const good = put(dir, `${PRE}20260920-153749-539-6de5`);
  const badName = put(dir, `${PRE}notatimestamp`);
  const badTime = put(dir, `${PRE}20261340-999999`);
  // fuzz 出来的都进池子,但都不参与排序 —— 它们仍占 keep 名额,必须让人看见
  const fuzz = put(dir, `${PRE}!nope`);
  put(dir, `${BASE}.bak`);                      // 前缀都不命中:不是备份,连提都不用提
  put(dir, BASE);                               // 活文件

  const r = listBackups({ dir, base: BASE });
  assert.equal(r.total, 4, '前缀命中的全部进池(total 数的是前缀命中数,不是可解析数)');
  assert.equal(r.entries.length, 1, '只有一份能解析');
  assert.equal(r.entries[0].name, good);
  assert.equal(r.unparsable.length, 3, `三份必须都出现在 unparsable 里,实得 ${JSON.stringify(r.unparsable)}`);
  const reasons = Object.fromEntries(r.unparsable.map(u => [u.name, u.reason]));
  assert.deepEqual(reasons, {
    [badName]: 'bad-shape', [badTime]: 'bad-month', [fuzz]: 'bad-shape',
  });
  for (const u of r.unparsable) assert.ok(u.message, `${u.name} 的 unparsable 条目要带人话说明`);
  // 不许静默丢弃:池子里的每一个名字都得在 entries / unparsable / unreadable 之一里露面
  const seen = new Set([...r.entries.map(e => e.name), ...r.unparsable.map(u => u.name), ...r.unreadable.map(u => u.name)]);
  for (const n of list(dir).filter(f => f.startsWith(PRE))) assert.ok(seen.has(n), `${n} 被静默丢弃了`);
  // 磁盘一个字节没动(清点是只读模块)
  assert.equal(fs.readFileSync(path.join(dir, badName), 'utf8'), 'x');
});

// ---------------------------------------------------------------- 保留池
test('inventory: 保留池预测与 backupFile 的纯字典序 slice 规则逐项一致', t => {
  const dir = tmpdir();
  // 混合格式 + 两个能打乱"字典序=时间序"的名字。
  // `!nope` 排在所有 `${PRE}2…` 之前(ASCII 0x21 < '2'),它是 fuzz 名,没有时间;
  // `zz-nope` 排在所有数字之后。这两条把"按时间序删"与"按字典序删"分开:
  // 按时间序,`!nope` 没有 ts,要么被排到最后、要么被丢掉;按字典序它排第一、第一个被删。
  const names = [
    put(dir, `${PRE}!nope`),
    put(dir, `${PRE}zz-nope`),
    put(dir, `${PRE}20200101-000000`),                  // 最老
    put(dir, `${PRE}20210101-000000`),
    put(dir, `${PRE}20220101-000000`),
    put(dir, `${PRE}20230101-000000`),
  ];
  const pool = REFERENCE.pool(dir);

  const r = listBackups({ dir, base: BASE, keep: DEFAULT_KEEP });
  assert.equal(DEFAULT_KEEP, REAL_KEEP, 'DEFAULT_KEEP 必须与 mixrouter.js 的 BACKUP_KEEP 同值');
  assert.deepEqual(r.retention.pool, pool, 'pool 必须就是 readdirSync + startsWith + sort 的结果');
  assert.equal(r.retention.total, pool.length);
  assert.equal(r.retention.overage, pool.length - REAL_KEEP);
  // 对照实现:下一次备份先落盘,池子先变长 1,再删前 max(0, len - keep) 个。
  // 注意下一次备份的名字**还没存在** —— 所以实现里 wouldKeepOnNextBackup 是它在"未来那个池子"
  // 里会留下的**现存**名字,不含那个还没落盘的新名字。拿含新名字的数组去比会把
  // "报告里不能出现一个磁盘上不存在的名字"这条契约判成红。
  const nextPool = [...pool, `${PRE}29991231-235959-999-9f9f`].sort();
  const wantDeleted = nextPool.slice(0, Math.max(0, nextPool.length - REAL_KEEP));
  const wantKeepExisting = nextPool.slice(wantDeleted.length).filter(n => pool.includes(n));
  assert.deepEqual(r.retention.wouldDeleteOnNextBackup, wantDeleted,
    '下次会删哪几个,必须与"落盘后按字典序删前 N 个"逐项一致');
  assert.equal(r.retention.wouldDeleteCount, wantDeleted.length);
  assert.deepEqual(r.retention.wouldKeepOnNextBackup, wantKeepExisting);
  assert.deepEqual([...r.retention.wouldDeleteOnNextBackup, ...r.retention.wouldKeepOnNextBackup],
    pool.filter(n => !r.retention.wouldDeleteOnNextBackup.includes(n))
      .concat(r.retention.wouldDeleteOnNextBackup).sort(),
    '现存名字的一个都不许在报告里消失:每个都得落在"会删"或"会留"里');
  assert.ok(!r.retention.wouldKeepOnNextBackup.includes(`${PRE}29991231-235959-999-9f9f`),
    '下一次备份的新名字在报告里不该出现(它还没落盘;上限取 total 就是为这个)');
  // 关键区分:`!nope` 没有时间戳,按**时间序**它排不进任何位置,按字典序它排第一 ——
  // 这条断言就是把两种序分开的地方,它必须是"按字典序"的那个答案。
  assert.equal(r.retention.wouldDeleteOnNextBackup[0], `${PRE}!nope`,
    '按 backupFile 的真实规则,第一个被删的是字典序最小的那个,哪怕它根本不是备份');
  assert.ok(!r.retention.wouldDeleteOnNextBackup.includes(`${PRE}zz-nope`), '字典序最大的留在池子里');
  assert.equal(r.retention.wouldKeepOnNextBackup.length + r.retention.wouldDeleteCount, pool.length);
  // 清点不删:断言跑完池子里一个都没少
  assert.deepEqual(list(dir).sort(), names.slice().sort(), '清点必须一份都不删');
  assert.equal(r.retention.deletesNothing, true);

  // 反证这条用例不是恒绿:换一组"两种序结果相同"的数据,`!nope` 这条断言就会失去区分度 ——
  // 所以这里再钉一条:时间序的答案与字典序的答案在这组数据上**确实不同**。
  const byTime = r.entries.map(e => e.name);
  assert.notDeepEqual(byTime.slice(0, 2), r.retention.pool.slice(0, 2),
    '前置:这组数据必须让"时间序"和"字典序"给出不同的前两名,否则上面那条断言分不出两种实现');
});

test('inventory: keep=0 与 keep 大于池子时的边界', t => {
  const dir = tmpdir();
  for (const n of ['20200101-000000', '20210101-000000', '20220101-000000']) put(dir, PRE + n);
  const pool = REFERENCE.pool(dir);
  const zero = listBackups({ dir, base: BASE, keep: 0 });
  assert.equal(zero.retention.overage, pool.length);
  assert.equal(zero.retention.wouldDeleteCount, pool.length, 'keep=0 时上限取池子长度,不报一个磁盘上不存在的名字');
  assert.deepEqual(zero.retention.wouldDeleteOnNextBackup, pool, 'keep=0 时下次把池子清空(新名字也在被删之列)');
  const big = listBackups({ dir, base: BASE, keep: 99 });
  assert.equal(big.retention.overage, 0);
  assert.equal(big.retention.wouldDeleteCount, 0);
  assert.deepEqual(big.retention.wouldDeleteOnNextBackup, []);
});

test('inventory: 盘上有未来时间的名字时,结论的不确定性被写出来而不是藏起来', t => {
  const dir = tmpdir();
  put(dir, `${PRE}20200101-000000`);
  const future = put(dir, `${PRE}29991231-235959`);
  const r = listBackups({ dir, base: BASE });
  assert.deepEqual(r.retention.futureDated, [future], '晚于当前时刻的名字必须被点名');
  assert.match(r.retention.assumption, /未必排最后/, '有未来时间时不能继续宣称"新名字必然排最后"');
  const plain = listBackups({ dir: tmpdir(), base: BASE, keep: 1 });
  assert.deepEqual(plain.retention.futureDated, []);
  assert.match(plain.retention.assumption, /排字典序最后/);
});

// ---------------------------------------------------------------- 输入校验
test('inventory: dir 写错是 ENOENT,不返回"零份备份"', t => {
  // "没有备份"和"路径写错了"是两件事,都变成空数组的话,前者的结论会被后者的输入悄悄冒充。
  assert.throws(() => listBackups({ dir: path.join(tmpdir(), 'nope'), base: BASE }), { code: 'ENOENT' });
  const empty = tmpdir();
  assert.deepEqual(listBackups({ dir: empty, base: BASE }).entries, [], '目录存在但一份都没有 —— 这才是"零份备份"');
  assert.equal(listBackups({ dir: empty, base: BASE }).total, 0);
  assert.throws(() => listBackups({ base: BASE }), TypeError);
  assert.throws(() => listBackups({ dir: empty, base: '' }), TypeError);
  assert.throws(() => listBackups({ dir: empty, base: BASE, keep: -1 }), RangeError);
  assert.throws(() => listBackups({ dir: empty, base: BASE, keep: 1.5 }), RangeError);
  assert.throws(() => listBackups({ dir: empty, base: BASE, maxBytes: -1 }), RangeError);
});

// ---------------------------------------------------------------- 磁盘事实与清点不一致
test('inventory: 顶着前缀的非常规文件进 unreadable,不被当成备份', t => {
  const dir = tmpdir();
  const file = put(dir, `${PRE}20200101-000000`, 'real');
  const asDir = path.join(dir, `${PRE}20200101-000002`);
  fs.mkdirSync(asDir);
  const linkTarget = path.join(dir, 'outside');
  fs.writeFileSync(linkTarget, 'outside-content');
  const asLink = path.join(dir, `${PRE}20200101-000003`);
  fs.symlinkSync(linkTarget, asLink);

  const r = listBackups({ dir, base: BASE });
  assert.deepEqual(r.entries.map(e => e.name), [file], '只有常规文件算备份');
  const byName = Object.fromEntries(r.unreadable.map(u => [u.name, u]));
  assert.equal(byName[path.basename(asDir)].reason, 'not-a-regular-file');
  assert.equal(byName[path.basename(asDir)].type, 'directory');
  assert.equal(byName[path.basename(asLink)].reason, 'not-a-regular-file');
  assert.equal(byName[path.basename(asLink)].type, 'symlink');
  // 但它们在**池子**里 —— 这正是要让人看见的:一个手工 mkdir 出来的同名目录照样占 keep 名额
  assert.equal(r.retention.total, 3);
  assert.ok(r.retention.pool.includes(path.basename(asLink)));
});

test('inventory: 超过 maxBytes 的文件不给半截摘要(sha256 为 null 而不是前缀摘要)', t => {
  const dir = tmpdir();
  const big = put(dir, `${PRE}20200101-000000`, 'A'.repeat(4096));
  const small = put(dir, `${PRE}20210101-000000`, 'B'.repeat(64));
  const r = listBackups({ dir, base: BASE, maxBytes: 1024 });
  const byName = Object.fromEntries(r.entries.map(e => [e.name, e]));
  assert.equal(byName[big].sha256, null, '半截摘要会被当成能核对完整性的东西,而它核对不了任何东西');
  assert.equal(byName[big].hashed, false);
  assert.equal(byName[big].hashSkipped, 'over-max-bytes');
  assert.equal(byName[big].size, 4096, 'size 仍报真实大小');
  assert.equal(byName[small].sha256, crypto.createHash('sha256').update('B'.repeat(64)).digest('hex'));
  assert.equal(byName[small].hashed, true);
  assert.equal(DEFAULT_HASH_MAX_BYTES, 1024 * 1024);
});

test('inventory: readBackup 拒绝非常规文件与符号链接,并给出截断范围', t => {
  const dir = tmpdir();
  const text = '正文-' + 'x'.repeat(100);
  const file = path.join(dir, put(dir, 'a.txt', text));
  assert.equal(path.dirname(file), dir, '前置:交给 readBackup 的必须是完整路径');
  const ok = readBackup({ path: file });
  assert.equal(ok.text, text);
  assert.equal(ok.truncated, false);
  assert.equal(ok.sha256Scope, 'whole-file');
  assert.equal(ok.encoding, 'utf8');
  assert.equal(ok.binary, false);

  const cut = readBackup({ path: file, maxBytes: 7 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.sha256Scope, 'returned-prefix', '截断时必须说清摘要只覆盖返回的这段');
  assert.notEqual(cut.sha256, ok.sha256);
  assert.ok(text.startsWith(cut.text), '截断回的是前缀');
  // 回退到 UTF-8 边界:`正文-` 是 3+3+3 字节,"正文" 的后两个字节在 7 字节处被切开,
  // 不许在结果里留下我们自己切出来的 U+FFFD —— 那看起来像文件里真有这个字符。
  assert.ok(!cut.text.includes('�'), `截断点应回退到字符边界,实得 ${JSON.stringify(cut.text)}`);

  const dirPath = path.join(dir, 'sub');
  fs.mkdirSync(dirPath);
  assert.throws(() => readBackup({ path: dirPath }), { code: 'E_NOT_REGULAR_FILE' });
  const link = path.join(dir, 'link.txt');
  fs.symlinkSync(file, link);
  assert.throws(() => readBackup({ path: link }), { code: 'E_NOT_REGULAR_FILE' }, '符号链接不许跟随');
  assert.throws(() => readBackup({ path: path.join(dir, 'nope') }), { code: 'ENOENT' });
  assert.throws(() => readBackup({}), TypeError);
  assert.throws(() => readBackup({ path: file, maxBytes: 1.5 }), RangeError);

  // naming 随读回一起给出:调用方拿一个路径就能知道"这是谁的备份、什么时候的"
  const bak = path.join(dir, put(dir, `${PRE}20200101-000000`, 'bak'));
  assert.equal(readBackup({ path: bak }).naming.ok, true);
  assert.equal(readBackup({ path: bak }).naming.stamp, '20200101-000000');
  assert.equal(readBackup({ path: file }).naming, null, '不是备份的文件没有 naming');
});

test('inventory: 二进制文件被标出来,不当成配置正文读', t => {
  const dir = tmpdir();
  const bin = path.join(dir, 'bin.dat');
  fs.writeFileSync(bin, Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81]));
  const r = readBackup({ path: bin });
  assert.equal(r.binary, true, '解出来的文本再编码回去对不上,必须标 binary');
  assert.match(r.text, /�/, '这一段本来就含 U+FFFD —— 与截断回退造出来的假字符是两回事');
});

test('inventory: computeRetention 与 listBackups 用的是同一条规则', t => {
  const pool = [`${PRE}20200101-000000`, `${PRE}zz`, `${PRE}!a`];
  const entries = [{ name: `${PRE}20200101-000000`, ts: 1 }];
  const direct = computeRetention(pool, 2, entries);
  const viaList = listBackups({ dir: tmpdir(), base: BASE, keep: 2 });
  assert.deepEqual(direct.pool, pool.slice().sort());
  assert.equal(direct.wouldDeleteCount, Math.min(3, Math.max(0, 3 + 1 - 2)));
  assert.deepEqual(direct.wouldKeepOnNextBackup, pool.slice().sort().slice(direct.wouldDeleteCount));
  assert.equal(direct.deletesNothing, true);
  assert.equal(viaList.retention.keep, 2);
  assert.equal(viaList.retention.rule, direct.rule, '两条路径必须报同一条规则文本');
});

test('inventory: sha256File 给的是整个文件的摘要', t => {
  const dir = tmpdir();
  const file = path.join(dir, put(dir, 'f.bin', 'hello'));
  const r = sha256File(file, 1024);
  assert.equal(r.sha256, crypto.createHash('sha256').update('hello').digest('hex'));
  assert.equal(r.bytes, 5);
  assert.equal(r.hashSkipped, null);
  assert.equal(sha256File(file, 2).sha256, null);
  assert.equal(sha256File(file, 2).hashSkipped, 'over-max-bytes');
  // maxBytes 恰好等于文件大小时**不**跳过:边界是多读一个字节才判超
  assert.equal(sha256File(file, 5).sha256, r.sha256);
  const d = path.join(dir, 'd');
  fs.mkdirSync(d);
  assert.throws(() => sha256File(d, 10), { code: 'E_NOT_REGULAR_FILE' });
});
