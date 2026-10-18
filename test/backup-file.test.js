'use strict';
// backupFile 的回归。经真实调用路径 switchClaude 驱动(backupFile 不在导出面上),
// 全部在 mkdtemp 出来的临时目录里做,不碰真实配置。
// 环境变量必须在 require mixrouter.js 之前设好,否则模块顶层就把路径定死了。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-bak-'));
const SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-bak-data-'));
process.env.MIXR_CLAUDE_SETTINGS = SETTINGS;
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_ZCODE_CONFIG = path.join(TMP, 'zcode.json');

const { switchClaude } = require('../mixrouter.js');

const PRE = 'settings.json.bak-mixui-';
const channel = extra => ({
  id: 'p1', name: '备份测试', base_url: 'http://127.0.0.1:8787', api_key: 'sk-test',
  models: ['claude-opus-5'], ...extra,
});
const baks = () => fs.readdirSync(TMP).filter(f => f.startsWith(PRE)).sort();
const seed = (mode = 0o600) => {
  fs.writeFileSync(SETTINGS, JSON.stringify({ env: { ANTHROPIC_MODEL: 'keep-model' } }, null, 2) + '\n');
  fs.chmodSync(SETTINGS, mode);
};
const fresh = t => {
  for (const f of baks()) fs.rmSync(path.join(TMP, f));   // 用例之间互不可见
  t.after(() => { for (const f of baks()) fs.rmSync(path.join(TMP, f)); });
};

test('backupFile:同一秒内的连续备份不互相覆盖(名字含毫秒与随机段)', t => {
  fresh(t); seed();
  // 连做 3 次。名字只到秒并配固定名时,同一秒内会撞名;旧实现靠 copyFileSync 静默覆盖,
  // 结果是同一秒内只剩 1 份。
  switchClaude(channel());
  switchClaude(channel({ id: 'p2' }));
  switchClaude(channel({ id: 'p3' }));
  const names = baks();
  assert.equal(names.length, 3, `三次切换应留三份备份,实得 ${names.length}: ${names.join(', ')}`);
  assert.equal(new Set(names).size, 3, '三份备份的名字必须互不相同');
  // 名字形状:定长前缀 YYYYMMDD-HHMMSS 在最前,随后 3 位毫秒与随机段。
  // 保留池靠纯字典序认最旧的一份,这个形状是那个性质的前提。
  for (const n of names)
    assert.match(n, /^settings\.json\.bak-mixui-\d{8}-\d{6}-\d{3}-[a-f0-9]{4}$/, `名字形状不符: ${n}`);
});

// 这一条必须自己构造非 0600 的源。本机源恒为 0600,而 0600 下 `& 0o600` 是空操作
// (copyFileSync 本来就已把备份设成 0600),用默认源写断言会**恒绿**,什么都没测。
// 断言的形状是"每个 mode 都取 min(src,0600)":任何单点相等(如 644->644)都证明不了
// 取交生效,必须同时有 644->600(收紧)与 400->400(不放松)两侧。
test('backupFile:备份权限取 min(源 mode, 0600)——只收紧不放松', t => {
  const cases = [[0o600, 0o600], [0o644, 0o600], [0o640, 0o600], [0o666, 0o600], [0o400, 0o400]];
  for (const [srcMode, want] of cases) {
    fresh(t); seed(srcMode);
    switchClaude(channel());
    const [name] = baks();
    assert.equal(fs.statSync(path.join(TMP, name)).mode & 0o777, want,
      `源 ${srcMode.toString(8)} 的备份应为 ${want.toString(8)}`);
  }
});

test('backupFile:名字保持"定长前缀在前",混合新旧格式的保留池仍按时间删最旧', t => {
  fresh(t); seed();
  const old = [];
  for (let i = 0; i < 5; i++) {
    const name = `${PRE}20200101-00000${i}`;   // 旧格式(秒级),都早于现在
    fs.writeFileSync(path.join(TMP, name), 'old');
    old.push(name);
  }
  switchClaude(channel());                      // 第 6 份,新格式
  const names = baks();
  assert.equal(names.length, 5, `保留池应维持 5 份,实得 ${names.length}`);
  assert.ok(!names.includes(old[0]), `最旧的一份 ${old[0]} 应被删掉`);
  for (let i = 1; i < 5; i++) assert.ok(names.includes(old[i]), `${old[i]} 不该被删`);
  assert.deepEqual(names, [...names].sort(), '返回的顺序就是字典序');
});

// 撞名必须抛错、不许静默覆盖。这一条要能真的红,否则丢掉 COPYFILE_EXCL 没人拦得住:
// 只靠随机段的话,名字依然互不相同,上一类用例照样全绿。
// 做法:把时刻和随机段都钉死,让两次备份算出同一个名字。
test('backupFile:撞名时抛错而不是静默覆盖(COPYFILE_EXCL)', t => {
  fresh(t); seed();
  const FIXED = new Date('2026-09-19T12:27:50.123Z');
  const RealDate = global.Date;
  const realRandom = crypto.randomBytes;

  global.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(FIXED.getTime()); }
  };
  crypto.randomBytes = () => Buffer.from([0xab, 0x12]);
  let err = null;
  try {
    switchClaude(channel());                    // 第一次:正常写出固定名
    const [name] = baks();
    const target = path.join(TMP, name);
    assert.ok(fs.existsSync(target), '第一次应写出备份');
    fs.writeFileSync(target, 'SENTINEL');       // 标记,用来证明它没被覆盖
    try { switchClaude(channel({ id: 'p2' })); } catch (e) { err = e; }
  } finally {
    global.Date = RealDate;
    crypto.randomBytes = realRandom;
  }

  assert.ok(err, '同名第二次备份必须抛错,不能静默覆盖');
  assert.equal(err.code, 'EEXIST', `应为 EEXIST,实得 ${err.code}`);
  const target = path.join(TMP, baks()[0]);
  assert.equal(fs.readFileSync(target, 'utf8'), 'SENTINEL', '撞名时既有备份一字不动');
});
