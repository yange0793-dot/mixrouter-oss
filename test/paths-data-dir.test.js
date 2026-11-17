'use strict';
// 运行数据目录解析的回归:env → .run/data-dir 指针 → 代码目录。
//
// 这三态的失败模式不是"报错",是**安静地去另一个目录**读出一份空配置然后照常启动。
// 所以这里逐条钉住:
//   · MIXR_DATA_DIR 非空时永远优先,指针文件内容不影响结果;
//   · 指针文件只在"存在 + 一行绝对路径 + 指向一个真实目录"时才被采纳,其余一律回落;
//   · 读指针是惰性的(require 不 stat),并按 mtime/size/inode 缓存;
//   · 写指针是原子写、0600、一行绝对路径;清除只删这一个文件。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('../lib/paths');

function fixture(t, where = 'case') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `mixr-data-dir-${where}-`)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const dir = (t, name) => {
  const value = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `mixr-data-target-${name}-`)));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
};

// ---------------------------------------------------------------- 三态

test('默认:没有 env、没有指针时回落到代码目录', t => {
  const root = fixture(t, 'default');
  assert.equal(paths.runtimeDataDir({}, root), root);
  assert.equal(paths.runtimeDataDir({ MIXR_DATA_DIR: '' }, root), root);
  const info = paths.resolveDataDir({}, root);
  assert.equal(info.source, 'default');
  assert.equal(info.dir, root);
  assert.equal(info.pointer.exists, false);
});

test('MIXR_DATA_DIR 非空时优先于有效指针', t => {
  const root = fixture(t, 'env');
  const pointerTarget = dir(t, 'pointer');
  const envTarget = dir(t, 'env');
  paths.writeDataDirPointer(root, pointerTarget);
  assert.equal(paths.runtimeDataDir({ MIXR_DATA_DIR: envTarget }, root), envTarget);
  const info = paths.resolveDataDir({ MIXR_DATA_DIR: envTarget }, root);
  assert.equal(info.source, 'env');
  assert.equal(info.dir, envTarget);
  // 指针文件仍然存在且有效,但来源明确写着 env —— 显示层不能把两者混为一谈。
  assert.equal(info.pointer.exists, true);
  assert.equal(info.pointer.valid, true);
});

test('指针有效时采纳指针目录,来源标记为 pointer', t => {
  const root = fixture(t, 'pointer');
  const target = dir(t, 'ok');
  const file = paths.writeDataDirPointer(root, target);
  assert.equal(file, path.join(root, '.run', 'data-dir'));
  assert.equal(paths.runtimeDataDir({}, root), target);
  const info = paths.resolveDataDir({}, root);
  assert.equal(info.source, 'pointer');
  assert.equal(info.dir, target);
  assert.equal(info.pointer.value, target);
  assert.equal(info.pointer.valid, true);
});

// ---------------------------------------------------------------- 非法内容回落

test('非法指针内容一律忽略并回落,不抛', t => {
  const root = fixture(t, 'invalid');
  const file = path.join(root, '.run', 'data-dir');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cases = [
    ['相对路径', 'relative/data\n'],
    ['空内容', '\n  \n'],
    ['指向不存在的目录', path.join(root, 'does-not-exist') + '\n'],
  ];
  for (const [name, text] of cases) {
    fs.writeFileSync(file, text);
    fs.utimesSync(file, new Date(), new Date(Date.now() + Math.random() * 1000));
    assert.equal(paths.runtimeDataDir({}, root), root, `${name} 应回落到代码目录`);
    const info = paths.resolveDataDir({}, root);
    assert.equal(info.source, 'default', `${name} 的来源应是 default`);
    assert.equal(info.pointer.exists, true, `${name}:文件存在这件事要如实显示`);
    assert.equal(info.pointer.valid, false, `${name}:无效内容不能被标成有效`);
  }
  // 指针路径本身是目录(不是文件)时也不采纳。
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.equal(paths.runtimeDataDir({}, root), root);
  assert.equal(paths.resolveDataDir({}, root).source, 'default');
});

// ---------------------------------------------------------------- 缓存

test('指针读取按 mtime/size/inode 缓存:未变时不再读正文', t => {
  const root = fixture(t, 'cache');
  const first = dir(t, 'first');
  const file = paths.writeDataDirPointer(root, first);
  assert.equal(paths.runtimeDataDir({}, root), first);
  // 把文件改成不可读:如果第二次调用真的重新读了,这里会走 catch 回落;
  // 返回缓存值才说明"只 stat、不重读正文"。
  fs.chmodSync(file, 0o000);
  try {
    assert.equal(paths.runtimeDataDir({}, root), first, '缓存命中时不应因正文不可读而回落');
  } finally {
    fs.chmodSync(file, 0o600);
  }
});

test('mtime 变化后缓存失效,读到新指针', t => {
  const root = fixture(t, 'cache-invalidate');
  const first = dir(t, 'first');
  const second = dir(t, 'second');
  const file = paths.writeDataDirPointer(root, first);
  assert.equal(paths.runtimeDataDir({}, root), first);
  fs.writeFileSync(file, second + '\n', { mode: 0o600 });
  // 同一毫秒内改写时 mtime 可能不变;显式推后一秒,确保测的是缓存失效而不是文件系统精度。
  const future = new Date(Date.now() + 1000);
  fs.utimesSync(file, future, future);
  assert.equal(paths.runtimeDataDir({}, root), second);
});

// ---------------------------------------------------------------- 下游一致性

test('日志、备份目标表都跟 runtimeDataDir 走同一份指针', t => {
  const root = fixture(t, 'downstream');
  const target = dir(t, 'downstream-data');
  paths.writeDataDirPointer(root, target);

  // 解析实现只有 LIVE_FILES.dataDir 一处;runtimeDataDir 是它的转发名。
  assert.equal(paths.runtimeDataDir({}, root), paths.LIVE_FILES.dataDir({}, root));
  assert.equal(paths.logDir({}, root), path.join(target, 'logs'));
  assert.equal(paths.requestsLog({}, root), path.join(target, 'logs', 'requests.jsonl'));
  assert.equal(paths.responseArchiveDir({}, root), path.join(target, 'logs', 'responses'));

  // mixctl backups / restore / 服务端 /api/backups 都经 backupTargets;它必须与运行时同源,
  // 否则会在代码目录清点出一个"0 份备份"的假结果。
  const { backupTargets } = require('../lib/backup/targets');
  const dataTarget = backupTargets({ root, env: {}, home: '/home/example' }).find(x => x.id === 'data');
  assert.equal(dataTarget.file, path.join(target, 'providers.json'));
  assert.equal(dataTarget.dir, target);
  // env 仍然最高优先级。
  const redirected = backupTargets({ root, env: { MIXR_DATA_DIR: '/data/env' }, home: '/home/example' })
    .find(x => x.id === 'data');
  assert.equal(redirected.file, path.join('/data/env', 'providers.json'));
});

// ---------------------------------------------------------------- 写 / 清

test('writeDataDirPointer:一行绝对路径、0600、自动建 .run', t => {
  const root = fixture(t, 'write');
  const target = dir(t, 'target');
  const file = paths.writeDataDirPointer(root, target);
  assert.deepEqual(fs.readFileSync(file, 'utf8'), target + '\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, '指针文件必须是 0600');
  assert.ok(fs.statSync(path.join(root, '.run')).isDirectory());
  // 相对路径直接拒绝,不写半份文件。
  assert.throws(() => paths.writeDataDirPointer(root, 'relative/dir'), /必须是绝对路径/);
  assert.deepEqual(fs.readFileSync(file, 'utf8'), target + '\n', '拒绝写入时不得改动原指针');
});

test('clearDataDirPointer:只删指针文件,第二次返回 false;缓存同步失效', t => {
  const root = fixture(t, 'clear');
  const target = dir(t, 'target');
  const file = paths.writeDataDirPointer(root, target);
  assert.equal(paths.runtimeDataDir({}, root), target);
  assert.equal(paths.clearDataDirPointer(root), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(paths.clearDataDirPointer(root), false);
  assert.equal(paths.runtimeDataDir({}, root), root, '清除后缓存不得继续返回旧指针');
});

// ---------------------------------------------------------------- 清单

test('RUNTIME_DATA_FILES 只列运行数据,不包含代码与目录', () => {
  for (const name of ['providers.json', 'routes.json', 'slots.json', 'sessions.json', 'client-managed.json', 'image-slim.json']) {
    assert.ok(paths.RUNTIME_DATA_FILES.includes(name), `数据文件清单缺少 ${name}`);
  }
  assert.deepEqual(paths.RUNTIME_DATA_DIRS, ['logs']);
  for (const banned of ['mixrouter.js', 'lib', 'public', '.run', '.git']) {
    assert.ok(!paths.RUNTIME_DATA_FILES.includes(banned), `清单不该包含 ${banned}`);
  }
});

test('禁止清单里的每个运行数据文件都跟着数据目录迁移', () => {
  // 两份清单一个决定「发布物里不许出现」,一个决定「mixctl data-dir 迁移/部署备份要带上」。
  // 新加运行数据文件时只改前者的静默后果:换数据目录后该设置直接丢失。
  for (const name of paths.FORBIDDEN_IN_RELEASE.filter(item => item.endsWith('.json'))) {
    assert.ok(paths.RUNTIME_DATA_FILES.includes(name), `迁移清单缺少运行数据文件 ${name}`);
  }
});
