'use strict';
// 原子写的回归。全部在 mkdtemp 出来的临时目录里做,不碰任何真实配置。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomic, writeJsonAtomic } = require('../lib/atomic-write');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 用一次性的 fs 补丁把"写入中途断掉"造出来。补丁打在 fs 单例上,
// 被测模块 require 到的是同一个对象,所以能真的影响它。
// 替换函数需要调用原实现时,先在替换函数外面把原函数抓下来。
async function patching(name, install, body) {
  const real = fs[name];
  fs[name] = install(real);
  try { return await body(); } finally { fs[name] = real; }
}

const tmpFiles = dir => fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));

test('原子写:写盘失败时终名保持旧的完整内容,异常冒泡,临时文件清干净', async t => {
  const dir = fixture(t);
  const file = path.join(dir, 'providers.json');
  fs.writeFileSync(file, 'OLD');

  const caught = await patching('fsyncSync', () => () => {
    throw Object.assign(new Error('boom'), { code: 'EIO' });
  }, () => {
    try { writeFileAtomic(file, 'NEW'); return null; } catch (e) { return e; }
  });

  assert.equal(caught?.code, 'EIO', '写失败必须冒泡,不能吞掉当成功');
  assert.equal(fs.readFileSync(file, 'utf8'), 'OLD', '终名必须还是旧的完整内容,不能是半成品');
  assert.deepEqual(tmpFiles(dir), [], '临时文件必须被清掉');
});

test('原子写:rename 那一刻临时文件已经是 0600,替换瞬间没有宽权限窗口', async t => {
  const dir = fixture(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'OLD');

  const prevUmask = process.umask(0o077); // 故意放宽到 077:若靠 umask 兜底,这里会露 0600 以外的东西
  let modeAtRename = null;
  try {
    await patching('renameSync', real => (from, to) => {
      if (to === file) modeAtRename = fs.statSync(from).mode & 0o777;
      return real(from, to);
    }, () => writeFileAtomic(file, 'NEW'));
  } finally { process.umask(prevUmask); }

  assert.equal(modeAtRename, 0o600, 'chmod 必须在 rename 之前就位,否则替换瞬间是 umask 决定的权限');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, '终名权限');
});

test('原子写:rename 之后终名内容整体可见,不会出现新旧内容混在一起', async t => {
  const dir = fixture(t);
  const file = path.join(dir, 'routes.json');
  const old = JSON.stringify({ version: 1, big: 'x'.repeat(200000) }, null, 2) + '\n';
  const next = JSON.stringify({ version: 2, big: 'y'.repeat(200000) }, null, 2) + '\n';
  fs.writeFileSync(file, old);

  const observed = [];
  const prevUmask = process.umask(0o077);
  try {
    await patching('renameSync', real => (from, to) => {
      if (to === file) observed.push(fs.readFileSync(to, 'utf8'));
      return real(from, to);
    }, () => writeFileAtomic(file, next));
  } finally { process.umask(prevUmask); }

  // rename 之前读到的那一份,必须是**完整**的旧内容或**完整**的新内容。
  // 就地写(O_TRUNC)在这一刻会读到被截断/写了一半的缓冲区,两种都不等于这两个值。
  assert.ok(observed.length > 0, '必须真的捕获到 rename');
  for (const seen of observed) {
    assert.ok(seen === old || seen === next, '替换瞬间读到的东西必须是完整的旧值或完整的新值');
  }
  assert.equal(fs.readFileSync(file, 'utf8'), next, '终名是新值');
});

test('原子写:临时名唯一,两次并发写的临时文件互不覆盖', async t => {
  const dir = fixture(t);
  const file = path.join(dir, 'slots.json');
  const seen = [];
  await patching('openSync', real => (p, ...rest) => {
    if (String(p).endsWith('.tmp')) seen.push(path.basename(p));
    return real(p, ...rest);
  }, async () => {
    await Promise.all([
      writeJsonAtomic(file, { who: 'a' }),
      writeJsonAtomic(file, { who: 'b' }),
    ]);
  });
  assert.equal(seen.length, 2, '两次写应该各开一个临时文件');
  assert.notEqual(seen[0], seen[1], '临时名必须唯一,固定名会让并发写者撞在同一路径上');
});

test('原子写:残留的临时文件不会让后续写入失败(唯一名而非固定名)', async t => {
  const dir = fixture(t);
  const file = path.join(dir, 'providers.json');
  fs.writeFileSync(file, 'OLD');
  // 模拟上一次崩溃留下的残留:`openSync(..., "wx")` 在固定名下会直接 EEXIST。
  fs.writeFileSync(`${file}.tmp`, 'leftover from a crashed writer');

  assert.doesNotThrow(() => writeFileAtomic(file, 'NEW'), '残留不能把之后的每一次写入都变成失败');
  assert.equal(fs.readFileSync(file, 'utf8'), 'NEW');
  assert.equal(fs.readFileSync(`${file}.tmp`, 'utf8'), 'leftover from a crashed writer', '不认识的残留不许动');
});

test('writeJsonAtomic:建目录、缩进 2 空格的 JSON、结尾换行', async t => {
  const dir = fixture(t);
  const file = path.join(dir, 'nested', 'deeper', 'data.json');
  writeJsonAtomic(file, { b: 1, a: [1, 2] });
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ b: 1, a: [1, 2] }, null, 2) + '\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, '默认 0600');
});

// ---------------------------------------------------------------- 落盘前的备份与残留清理
// 这两件事都在 writeJsonAtomic 的 backup 选项里。为什么它们必须在这里、而不是让调用方
// 自己在外面 copy 一份:见 lib/atomic-write.js 里那个选项的注释。这里只钉行为。

const { DEFAULT_BACKUP_KEEP } = require('../lib/atomic-write');
const { DEFAULT_KEEP: CB_KEEP } = require('../lib/config-backup');
const { TMP_RE } = require('../lib/atomic-write');

const baksOf = (dir, base) => fs.readdirSync(dir).filter(f => f.startsWith(`${base}.bak-mixui-`)).sort();

test('writeJsonAtomic:默认不备份(高频的 slots/sessions 不该被写放大拖累)', async t => {
  const dir = fixture(t);
  const file = path.join(dir, 'slots.json');
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2 });
  assert.deepEqual(baksOf(dir, 'slots.json'), [], '没开 backup 就一份都不该产生');
});

test('writeJsonAtomic:backup:true 时备份的是**写入前**的内容,权限只收紧不放松', async t => {
  const dir = fixture(t);
  const file = path.join(dir, 'providers.json');
  writeJsonAtomic(file, { v: 'OLD' }, { backup: true });
  // 第一次写:文件原本不存在,没有可备份的东西 —— 这是 backupFile 的既有约定(返回 null)
  assert.deepEqual(baksOf(dir, 'providers.json'), [], '首次写入没有"旧内容"可备');

  writeJsonAtomic(file, { v: 'NEW' }, { backup: true });
  const baks = baksOf(dir, 'providers.json');
  assert.equal(baks.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, baks[0]), 'utf8'));
  assert.deepEqual(saved, { v: 'OLD' }, '备份必须是**写入前**的那一份,不是刚写进去的');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 'NEW', '活文件是新内容');
  assert.equal(fs.statSync(path.join(dir, baks[0])).mode & 0o777, 0o600, '含密钥的文件备份必须 0600');
});

test('writeJsonAtomic:keep 生效,超限的按字典序顶掉最老的', async t => {
  const dir = fixture(t);
  const file = path.join(dir, 'providers.json');
  for (let i = 0; i < 4; i++) writeJsonAtomic(file, { i }, { backup: true, keep: 2 });
  const baks = baksOf(dir, 'providers.json');
  assert.equal(baks.length, 2, '保留池收敛到 keep 份');
});

test('writeJsonAtomic:默认保留上限与 config-backup 同值(两处各写一份,必须钉住)', () => {
  assert.equal(DEFAULT_BACKUP_KEEP, CB_KEEP);
});

test('writeJsonAtomic:备份前清掉本目标的临时残留 —— 它们会占池位,内容还是半截的', async t => {
  const dir = fixture(t);
  const file = path.join(dir, 'providers.json');
  writeJsonAtomic(file, { v: 1 }, { backup: true });
  // 造两份本模块会产出的残留名(进程被 SIGKILL 时 finally 不执行,它们就留在盘上)
  const stale = [`${file}.1700000000000-${'ab'.repeat(16)}.tmp`, `${file}.1700000000001-${'cd'.repeat(16)}.tmp`];
  for (const s of stale) fs.writeFileSync(s, '{"half":');
  // 以及一份**别的**目标的残留,和一份人手命名的 .tmp:都不该被这次清理碰到
  const foreign = path.join(dir, `routes.json.1700000000002-${'ef'.repeat(16)}.tmp`);
  const handmade = `${file}.tmp`;
  fs.writeFileSync(foreign, '{"other":');
  fs.writeFileSync(handmade, 'by hand');

  const said = [];
  writeJsonAtomic(file, { v: 2 }, { backup: true, onWarn: m => said.push(m) });

  for (const s of stale) assert.ok(!fs.existsSync(s), `残留 ${path.basename(s)} 必须被清掉`);
  assert.ok(fs.existsSync(foreign), '别的目标的残留不归这次管');
  assert.ok(fs.existsSync(handmade), '人手命名的 .tmp 不是本模块的产物,不许动');
  assert.ok(said.some(m => m.includes('临时残留')), `清理要出声;实得 ${JSON.stringify(said)}`);
  // 残留被清掉之后,它们不会混进备份池
  assert.ok(baksOf(dir, 'providers.json').every(n => !n.endsWith('.tmp')));
});

test('writeJsonAtomic:不开 backup 就不清残留(别让高频路径多一堆删除)', async t => {
  const dir = fixture(t);
  const file = path.join(dir, 'slots.json');
  const stale = `${file}.1700000000000-${'ab'.repeat(16)}.tmp`;
  fs.writeFileSync(stale, '{"half":');
  writeJsonAtomic(file, { v: 1 });
  assert.ok(fs.existsSync(stale), '没开 backup 时清理不该发生 —— 那是顺手活,绑在备份这一步上');
});

test('TMP_RE 只认本模块产出的临时名(留成 public 是因为有两个读者)', () => {
  assert.ok(TMP_RE.test(`providers.json.1700000000000-${'ab'.repeat(16)}.tmp`));
  assert.ok(!TMP_RE.test('providers.json.tmp'), '固定名 .tmp 不是本模块的(那是人手/别的工具的)');
  assert.ok(!TMP_RE.test(`providers.json.1700000000000-${'ab'.repeat(15)}.tmp`), '随机段短一位就不是它');
  assert.ok(!TMP_RE.test(`providers.json.1700000000000-${'AB'.repeat(16)}.tmp`), '随机段是大写 hex 不是它');
  assert.ok(!TMP_RE.test('providers.json.bak-mixui-20260927-120000-000-abcd'), '备份不是临时文件');
});
