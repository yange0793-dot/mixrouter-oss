'use strict';
// lib/backup/pool-watch.js 的回归。
//
// 这个模块只承诺一件事:**在 backupFile 真的删掉某一份之前,把同一批名字报出来**。
// 所以本文件的中心断言不是"有没有 warn",而是「预警集合 ≡ 随后实际消失的集合」。
// 两组用例分别在两个层面上验它:
//   ① 纯函数层(planDeletion/warnBeforeBackup 直调)—— 精确控制池内容,含边界;
//   ② 真实路径层(经 switchClaude 驱动 backupFile)—— 证明接线后报的就是真被删的。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planDeletion, warnBeforeBackup, poolOf, DEFAULT_KEEP } = require('../lib/backup/pool-watch');
const { DEFAULT_KEEP: CB_KEEP } = require('../lib/config-backup');

// ---------------------------------------------------------------- 纯函数层
const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-pw-'));
// 造一个名字合法的备份(时间戳定长在最前,字典序=时间序)。seq 控制先后。
const bakName = (base, seq, rand = 'aaaa') => {
  const z = n => String(n).padStart(2, '0');
  // 用固定基准日 + seq 秒,保证同 base 下 seq 越大名字字典序越大
  const d = new Date(Date.UTC(2026, 0, 1, 0, 0, seq));
  return `${base}.bak-mixui-${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}` +
    `-${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}-000-${rand}`;
};
const touch = (dir, name) => { fs.writeFileSync(path.join(dir, name), 'x'); return name; };

test('pool-watch:DEFAULT_KEEP 与 config-backup 同值(防两处各写一份后漂移)', () => {
  // 不是 require 过来的(会成环),所以必须由测试钉住同值
  assert.equal(DEFAULT_KEEP, CB_KEEP);
});

test('planDeletion:池未超限时不删任何东西', () => {
  const dir = mkdir();
  const base = 'settings.json';
  for (let i = 0; i < 3; i++) touch(dir, bakName(base, i));
  const plan = planDeletion({ dir, base, keep: 5 });
  assert.deepEqual(plan.wouldDelete, []);
  assert.equal(plan.poolSize, 3);
});

test('planDeletion:预警在落盘之后调,池子已含新名字,删的是字典序最前的那几份', () => {
  const dir = mkdir();
  const base = 'settings.json';
  const names = [];
  for (let i = 0; i < 5; i++) names.push(touch(dir, bakName(base, i)));
  // backupFile 的真实形状:先 copyFileSync 把新名字落到盘上,**再**调预警。
  // 所以这里 newName 也必须先 touch —— 盘上没有它就是在验一个不存在的调用形状,
  // 而那正是旧版把一个真缺陷(新名字被数两遍)供起来的原因(见 planDeletion 的文件注释)。
  const fresh = touch(dir, bakName(base, 9));
  const plan = planDeletion({ dir, base, newName: fresh, keep: 5 });
  assert.equal(plan.poolSize, 6, '池子份数就是此刻磁盘上的份数');
  assert.equal(plan.newNameVisible, true, '新名字已在池中');
  // 盘上连新名字共 6 份,上限 5 ⇒ 删最旧的 1 份
  assert.equal(plan.wouldDelete.length, 1);
  assert.deepEqual(plan.wouldDelete, [names[0]]);   // 字典序最前 = 最旧
  assert.equal(plan.deletesTheNewOne, false);
});

test('planDeletion:keep=0 时新写入的那一份自己就在删除集合里(退化情形要说出来)', () => {
  const dir = mkdir();
  const base = 'settings.json';
  const fresh = touch(dir, bakName(base, 3));
  const plan = planDeletion({ dir, base, newName: fresh, keep: 0 });
  assert.deepEqual(plan.wouldDelete, [fresh]);
  assert.equal(plan.deletesTheNewOne, true, 'keep=0 意味着写完就删,这一条必须能被调用方看见');
});

test('planDeletion:贴着前缀但不合法的时间戳同样占池位(与 backupFile 的粗糙 startsWith 一致)', () => {
  const dir = mkdir();
  const base = 'settings.json';
  // backupFile 只做 startsWith,不校验时间戳是否合法 —— 一个乱名同样进池、同样占位、
  // 同样可能被删。这里"顺手修好"(过滤掉非法名)就会算出一个与实际删除不同的集合。
  const junk = touch(dir, `${base}.bak-mixui-不可能-是-时间`);
  const old = touch(dir, bakName(base, 1));
  const fresh = touch(dir, bakName(base, 2));
  const plan = planDeletion({ dir, base, newName: fresh, keep: 2 });

  // 占位:池里 3 份(乱名 + 旧备份 + 刚落盘的新名字),上限 2 ⇒ 必须删掉 1 份。
  // 若模块"顺手"把乱名滤掉,这里会算出 0 份要删 —— 而 backupFile 实际仍会删 1 份。
  assert.equal(plan.poolSize, 3, '乱名必须被算进池位');
  assert.equal(plan.wouldDelete.length, 1);

  // 删谁由默认字符串序决定(UTF-16 码元):'2'(U+0032) < '不'(U+4E0D),
  // 所以带数字时间戳的那一份排在乱名**前面**,先被删。
  assert.deepEqual(plan.wouldDelete, [old]);
  assert.ok(!plan.wouldDelete.includes(junk),
    '乱名这次没被删,但它占掉的池位正是合法备份被删的原因 —— 这个因果不能靠"过滤掉乱名"抹平');
});

test('planDeletion:改名(前缀不同)的文件不进池 —— 池是按 basename 前缀捞的', () => {
  const dir = mkdir();
  touch(dir, bakName('other.json', 0));           // 别人的备份
  touch(dir, bakName('settings.json', 0));
  assert.equal(poolOf(dir, 'settings.json').length, 1);
});

test('planDeletion:排序键必须是字典序而不是 mtime —— 两者冲突时以字典序为准(= backupFile 的行为)', () => {
  const dir = mkdir();
  const base = 'settings.json';
  // 造一个"名字早、mtime 新"的世界:字典序与 mtime 序**互相矛盾**。
  // 这是本模块唯一实质承诺的另一面 —— 它必须用与 backupFile 相同的排序,
  // 否则预警点名的文件与真被删的不是同一个(报告看着更专业,结论是错的)。
  // 只靠"按 seq 递增写文件"的用例区分不了两者:mtime 序恰好等于字典序,换键也不变。
  const older = bakName(base, 1);   // 字典序最小
  const newer = bakName(base, 5);
  const fresh = bakName(base, 9);
  touch(dir, newer); fs.utimesSync(path.join(dir, newer), new Date(2026, 0, 1), new Date(2026, 0, 1));
  touch(dir, older); fs.utimesSync(path.join(dir, older), new Date(2026, 0, 2), new Date(2026, 0, 2));
  // fresh 也要落盘 —— 预警恒在 copyFileSync 之后调,此刻它已经在池子里(见 planDeletion 注释)。
  touch(dir, fresh);

  const plan = planDeletion({ dir, base, newName: fresh, keep: 2 });
  // 池 3 份、上限 2 ⇒ 删 1 份
  assert.equal(plan.wouldDelete.length, 1);
  assert.deepEqual(plan.wouldDelete, [older],
    '字典序删 older(seq=1);若按 mtime 排会删 newer —— 那样报的就与 backupFile 实际删的不是同一份');
});

test('planDeletion:不传 newName 时("只报现状")仍按字典序,不按 mtime', () => {
  const dir = mkdir();
  const base = 'settings.json';
  // 这条分支与上面那条的实现路径不同:带 newName 时新名字已经在池子里(它是落盘之后才调的),
  // 而这条完全不看 newName。所以池层那个 sort 是不是字典序,只有本用例能证明 ——
  // 注入"poolOf 改按 mtime 排"时,其余用例全绿,只有这里会红。
  const older = bakName(base, 1);   // 字典序最小,但 mtime 最新
  const newer = bakName(base, 5);
  touch(dir, newer); fs.utimesSync(path.join(dir, newer), new Date(2026, 0, 1), new Date(2026, 0, 1));
  touch(dir, older); fs.utimesSync(path.join(dir, older), new Date(2026, 0, 2), new Date(2026, 0, 2));

  const plan = planDeletion({ dir, base, keep: 1 });   // 池 2 份、上限 1 ⇒ 删 1 份
  assert.equal(plan.basis, '现状');
  assert.deepEqual(plan.wouldDelete, [older], '字典序最小者先被删(与 backupFile 一致),而不是 mtime 最老者');
});

test('planDeletion:参数非法抛错,而不是静默返回空集合', () => {
  const dir = mkdir();
  assert.throws(() => planDeletion({ dir: '', base: 'a.json' }), TypeError);
  assert.throws(() => planDeletion({ dir, base: '' }), TypeError);
  assert.throws(() => planDeletion({ dir, base: 'a.json', keep: -1 }), RangeError);
  assert.throws(() => planDeletion({ dir, base: 'a.json', keep: 1.5 }), RangeError);
  assert.throws(() => planDeletion({ dir, base: 'a.json', newName: '' }), TypeError);
});

test('warnBeforeBackup:没东西要删就不出声', () => {
  const dir = mkdir();
  const said = [];
  // 新名字先落盘(backupFile 的真实形状),池子 1 份、上限 5 —— 没有任何东西要被顶掉。
  const fresh = touch(dir, bakName('settings.json', 0));
  const r = warnBeforeBackup({ dir, base: 'settings.json', newName: fresh, keep: 5, onWarn: m => said.push(m) });
  assert.equal(r.ok, true);
  assert.equal(r.warned, false);
  assert.deepEqual(said, []);
});

test('warnBeforeBackup:要删就报出被删的名字,且措辞点明是"本次备份将顶掉"', () => {
  const dir = mkdir();
  const base = 'settings.json';
  const names = [];
  for (let i = 0; i < 5; i++) names.push(touch(dir, bakName(base, i)));
  // 新名字必须**已经在盘上** —— 这是 backupFile 的真实调用形状:它先 copyFileSync 落盘,
  // 再调预警。旧用例传了一个盘上没有的名字,无意中复现的是"预警发生在 copy 之前"这种
  // 不存在的形状,于是把一个真缺陷(新名字被数两遍)供了起来。
  const fresh = touch(dir, bakName(base, 9));
  const said = [];
  const r = warnBeforeBackup({ dir, base, newName: fresh, keep: 5, onWarn: m => said.push(m) });
  assert.equal(r.ok, true);
  assert.equal(r.warned, true);
  assert.equal(said.length, 1, '一次预警只该有一次 onWarn,不是一句一次');
  assert.ok(said[0].includes(names[0]), '被删的那一份名字必须出现在提示里');
  assert.ok(said[0].includes('顶掉'), '要说清是"顶掉",不能让用户以为是已发生的事');
  // 报出来的份数必须等于随后真会删的份数。池子 6 份(5 份旧的 + 刚落盘的新名字)、上限 5,
  // 删除循环拿到的是同一份 readdir —— 就是删 1 份。旧实现把新名字又并了一次,报 2 份。
  assert.equal(r.plan.wouldDelete.length, 1, '池子 6 份、上限 5 —— 要删的是 1 份,不是 2 份');
  assert.ok(said[0].includes('顶掉 1 份'), `提示里的份数要与实际一致;实得 ${JSON.stringify(said[0])}`);
  assert.ok(!said[0].includes('已满'), '池子 6/5 只是刚过上限,不该说"已满"(那是把份数当成"满没满"的判据)');
});

test('warnBeforeBackup:池子恰好等于上限时是沉默的(刚过上限与"已满"是两件事)', () => {
  // 判据必须是"有没有东西真的要被删",不是"份数到没到上限"。池子正好 5 份、上限 5 ——
  // 这一次备份会把它顶到 6 份、删掉 1 份。所以这里**会**出声,但说的是"将顶掉 1 份",
  // 而不是"已满";而在备份**之前**(poolOf 已含新名字之前的那个状态)没有任何东西要删。
  const dir = mkdir();
  const base = 'settings.json';
  for (let i = 0; i < 5; i++) touch(dir, bakName(base, i));
  const said = [];
  // 不传 newName = 只报现状:池子 5 份、上限 5,一份都不该删,也不该喊"已满"。
  const r = warnBeforeBackup({ dir, base, keep: 5, onWarn: m => said.push(m) });
  assert.equal(r.plan.wouldDelete.length, 0);
  assert.equal(r.warned, false, '恰好等于上限、且没有东西要被删 —— 这时候出声就是狼来了');
  assert.deepEqual(said, []);
});

test('warnBeforeBackup:报出来的删除份数随池子大小单调变化(多报一份是最容易蒙混过去的错)', () => {
  // 池子每多一份,该删的就多一份。这条钉的是**数字本身**,不是措辞 ——
  // 只验"有没有 warn / 名字在不在"的话,份数报错一倍也照样绿。
  const base = 'settings.json';
  for (const extra of [0, 1, 2]) {
    const dir = mkdir();
    const names = [];
    for (let i = 0; i < 5 + extra; i++) names.push(touch(dir, bakName(base, i)));
    const fresh = touch(dir, bakName(base, 20 + extra));
    const r = warnBeforeBackup({ dir, base, newName: fresh, keep: 5, onWarn: () => {} });
    const pool = poolOf(dir, base).length;
    assert.equal(pool, 6 + extra);
    assert.equal(r.plan.poolSize, pool, '报出的池子份数必须就是磁盘上的份数');
    assert.deepEqual(r.plan.wouldDelete, names.slice(0, 1 + extra), '删除集合必须是字典序最前的那几份');
  }
});

test('warnBeforeBackup:目录不存在时返回 ok:false 而不是抛 —— 预警的失败绝不能挡住备份', () => {
  const said = [];
  const r = warnBeforeBackup({ dir: path.join(os.tmpdir(), 'definitely-not-here-' + Date.now()), base: 'settings.json', newName: 'x', keep: 5, onWarn: m => said.push(m) });
  assert.equal(r.ok, false);
  assert.equal(r.warned, false);
  assert.ok(r.error, '要把真实错误带回去,不能吞成"没有要删的"');
  assert.deepEqual(said, []);
});

test('warnBeforeBackup:没传 onWarn 也算算过了(warned 仍反映真实结论)', () => {
  const dir = mkdir();
  const base = 'settings.json';
  for (let i = 0; i < 5; i++) touch(dir, bakName(base, i));
  touch(dir, bakName(base, 9));                  // 同前:新名字先落盘,再算预警
  const r = warnBeforeBackup({ dir, base, newName: bakName(base, 9), keep: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.warned, true, 'onWarn 缺失不该把 warned 变成 false');
});

// ---------------------------------------------------------------- 真实路径层
// 经 switchClaude 驱动真实的 backupFile:证明接线后报出的集合,就是随后真的消失的集合。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-pw-live-'));
const SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-pw-live-data-'));
process.env.MIXR_CLAUDE_SETTINGS = SETTINGS;
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_ZCODE_CONFIG = path.join(TMP, 'zcode.json');

const { switchClaude } = require('../mixrouter.js');

const PRE = 'settings.json.bak-mixui-';
const liveBaks = () => fs.readdirSync(TMP).filter(f => f.startsWith(PRE)).sort();
const channel = () => ({
  id: 'p1', name: '池预警测试', base_url: 'http://127.0.0.1:8787', api_key: 'sk-test',
  models: ['claude-opus-5'],
});
const fresh = t => {
  for (const f of liveBaks()) fs.rmSync(path.join(TMP, f));
  t.after(() => { for (const f of liveBaks()) fs.rmSync(path.join(TMP, f)); });
};

test('真实路径:backupFile 触发预警,且预警集合 ≡ 随后实际被删的集合', t => {
  fresh(t);
  const base = 'settings.json';
  fs.writeFileSync(SETTINGS, JSON.stringify({ env: {} }, null, 2));
  // 先垫满保留池(默认 5 份)
  for (let i = 0; i < 5; i++) touch(TMP, bakName(base, i));

  const before = liveBaks();
  const said = [];

  // 打桩 process.emitWarning/console.warn 都不必要 —— 走 onWarn 需要调用方传,
  // 而三个真实调用点没传。所以这里直接调 backupFile 并自带 onWarn,验的是接线本身。
  const { backupFile } = require('../lib/config-backup');
  const bak = backupFile(SETTINGS, { onWarn: m => said.push(m) });

  const after = liveBaks();
  const actuallyDeleted = before.filter(n => !after.includes(n));

  assert.equal(said.length, 1, '池满时必须有且只有一条预警');
  assert.equal(actuallyDeleted.length, 1);
  assert.ok(said[0].includes(actuallyDeleted[0]),
    `预警里点名的必须就是真被删的:报[${said[0]}] 实删[${actuallyDeleted}]`);
  assert.ok(after.includes(path.basename(bak)), '新备份本身要留在盘上');
  assert.equal(after.length, 5, '保留池收敛到 keep 份');
});

test('真实路径:池未满时一条预警都不出(不能变成每次都喊)', t => {
  fresh(t);
  fs.writeFileSync(SETTINGS, JSON.stringify({ env: {} }, null, 2));
  const said = [];
  const { backupFile } = require('../lib/config-backup');
  backupFile(SETTINGS, { onWarn: m => said.push(m) });
  assert.deepEqual(said, []);
});

test('真实路径:不传 onWarn 时行为与改动前完全一致(不因预警缺失而改变删除)', t => {
  fresh(t);
  const base = 'settings.json';
  fs.writeFileSync(SETTINGS, JSON.stringify({ env: {} }, null, 2));
  for (let i = 0; i < 5; i++) touch(TMP, bakName(base, i));
  const before = liveBaks();
  const { backupFile } = require('../lib/config-backup');
  const bak = backupFile(SETTINGS);              // 旧的调用形态
  const after = liveBaks();
  assert.equal(before.filter(n => !after.includes(n)).length, 1, '删除仍恰好发生一次');
  assert.ok(after.includes(path.basename(bak)));
  assert.equal(after.length, 5);
});

test('真实路径:switchClaude 全链路仍能正常切换(预警不阻断配置写入)', t => {
  fresh(t);
  fs.writeFileSync(SETTINGS, JSON.stringify({ env: {} }, null, 2));
  const base = 'settings.json';
  for (let i = 0; i < 5; i++) touch(TMP, bakName(base, i));   // 故意垫满,让预警一定会触发
  switchClaude(channel());
  const cfg = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  assert.equal(cfg.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787', '配置必须真的写进去了');
  assert.equal(liveBaks().length, 5);
});
