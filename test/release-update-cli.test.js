'use strict';
// scripts/upgrade-release.js 与 scripts/check-update.js 的离线回归。
//
// 升级相关的用例**不启动真实服务、不联网**:
//   · 预览:安装根一个字节都不变;
//   · --no-start 的 apply:只换代码目录与 current,数据目录逐字节不变;
//   · 启动后核对失败:自动切回旧 current 并再次启动旧版本;
//   · 回退本身失败:输出里必须同时给出新旧目录与"回退未完成",不能含糊成一句失败;
//   · 没有 --yes 的非交互 apply:中止且不写文件。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const upgrade = require('../scripts/upgrade-release');
const check = require('../scripts/check-update');
const ru = require('../lib/release-update');
const fixture = require('./release-update-fixture');

function tempDir(t, prefix = 'mixr-up-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function capture(fn) {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    const code = await fn();
    return { code, text: lines.join('\n') };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

// 一个已有的安装:releases/<旧版本> + current 指向它 + 固定数据目录。
function setupInstall(base, { version = '3.9.0' } = {}) {
  const home = path.join(base, 'home');
  const installRoot = path.join(base, 'install');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(base, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'providers.json'), '{"version":2,"claude":[]}\n');
  fs.writeFileSync(path.join(dataDir, 'routes.json'), '{"version":1,"rules":[],"default":{}}\n');
  const old = fixture.makeRelease(path.join(installRoot, 'releases', `${version}-old`), { version });
  fs.symlinkSync(old.dir, path.join(installRoot, 'releases', 'current'), 'dir');
  return { home, installRoot, dataDir, old, version };
}

function treeSnapshot(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) out.push(`${rel}->${fs.readlinkSync(full)}`);
      else if (stat.isDirectory()) { out.push(`${rel}/`); walk(full, rel); }
      else out.push(`${rel}:${fs.readFileSync(full).toString('base64')}`);
    }
  };
  walk(root, '');
  return out;
}

function commonArgs(setup, archive) {
  return ['--archive', archive, '--install-root', setup.installRoot, '--data-dir', setup.dataDir];
}

// ---------------------------------------------------------------- check-update
test('check-update:默认不联网、不写文件', async t => {
  const base = tempDir(t);
  const setup = setupInstall(base);
  const before = treeSnapshot(base);
  const result = await capture(() => check.run(['--install-root', setup.installRoot], { home: setup.home, env: {} }));
  assert.equal(result.code, 0);
  assert.match(result.text, /未联网检查/);
  assert.match(result.text, /3\.9\.0/);
  assert.deepEqual(treeSnapshot(base), before);
});

test('check-update --check:显式请求才查询,并指出新版本', async t => {
  const base = tempDir(t);
  const setup = setupInstall(base);
  let calls = 0;
  const result = await capture(() => check.run(['--check', '--install-root', setup.installRoot], {
    home: setup.home, env: {},
    fetchRelease: async version => {
      calls += 1;
      assert.equal(version, undefined);
      return {
        version: '3.9.1', tag: 'v3.9.1', name: 'v3.9.1', htmlUrl: 'https://github.com/x/releases/tag/v3.9.1',
        publishedAt: '2026-10-22T00:00:00Z', prerelease: false, draft: false,
        assets: {
          names: ru.assetNames('3.9.1'),
          archive: { name: 'mixrouter-3.9.1.tar.gz' },
          sha256: { name: 'mixrouter-3.9.1.tar.gz.sha256' },
          releaseInfo: { name: 'mixrouter-3.9.1.RELEASE-INFO.json' },
        },
      };
    },
  }));
  assert.equal(result.code, 0);
  assert.equal(calls, 1);
  assert.match(result.text, /最新版本: 3\.9\.1/);
  assert.match(result.text, /upgrade-release\.js --version 3\.9\.1 --download/);

  const gated = await capture(() => check.run(['--check', '--fail-if-newer', '--install-root', setup.installRoot], {
    home: setup.home, env: {},
    fetchRelease: async () => ({
      version: '3.9.1', tag: 'v3.9.1', htmlUrl: null, publishedAt: null, prerelease: false,
      assets: { names: ru.assetNames('3.9.1'), archive: { name: 'a' }, sha256: { name: 'b' }, releaseInfo: null },
    }),
  }));
  assert.equal(gated.code, 1);
});

// ---------------------------------------------------------------- 升级预览
test('upgrade-release 预览:不写安装根、不联网', async t => {
  const base = tempDir(t);
  const setup = setupInstall(base);
  const next = fixture.makeRelease(path.join(base, 'next'), { version: '3.9.1' });
  const assets = fixture.makeArchive(path.join(base, 'assets'), next);
  const before = treeSnapshot(base);
  const result = await capture(() => upgrade.run([...commonArgs(setup, assets.archive), '--version', '3.9.1'],
    { home: setup.home, env: {}, tmpdir: path.join(base, 'tmp') }));
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /升级:     3\.9\.0 → 3\.9\.1/);
  assert.match(result.text, /以上只是预览/);
  assert.deepEqual(treeSnapshot(base), before, '预览不得写入安装根或数据目录');
});

test('upgrade-release:没有 --download 时不会联网取版本', async t => {
  const base = tempDir(t);
  const setup = setupInstall(base);
  const result = await capture(() => upgrade.run(['--version', '3.9.1', '--install-root', setup.installRoot,
    '--data-dir', setup.dataDir], { home: setup.home, env: {}, tmpdir: path.join(base, 'tmp') }));
  assert.equal(result.code, 1);
  assert.match(result.text, /必须显式加 --download/);
});

// ---------------------------------------------------------------- 执行 / 回退
test('upgrade-release --apply --no-start:切换 current,旧版本与数据保持原样', async t => {
  const base = tempDir(t);
  const setup = setupInstall(base);
  const dataBefore = treeSnapshot(setup.dataDir);
  const next = fixture.makeRelease(path.join(base, 'next'), { version: '3.9.1' });
  const assets = fixture.makeArchive(path.join(base, 'assets'), next);
  const result = await capture(() => upgrade.run([
    ...commonArgs(setup, assets.archive), '--version', '3.9.1', '--apply', '--yes', '--no-start',
  ], { home: setup.home, env: {}, tmpdir: path.join(base, 'tmp') }));
  assert.equal(result.code, 0, result.text);
  const current = fs.readlinkSync(path.join(setup.installRoot, 'releases', 'current'));
  assert.notEqual(current, setup.old.dir);
  assert.ok(fs.existsSync(path.join(current, 'package.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8')).version, '3.9.1');
  assert.ok(fs.existsSync(path.join(setup.installRoot, 'releases', '3.9.0-old')), '旧发布目录必须保留');
  assert.deepEqual(treeSnapshot(setup.dataDir), dataBefore, '数据目录不得被改写');
  const manifest = JSON.parse(fs.readFileSync(path.join(current, 'RELEASE.json'), 'utf8'));
  assert.equal(manifest.sha256, assets.sha256);
  assert.equal(manifest.data_dir, setup.dataDir);
});

test('upgrade-release:非交互 --apply 没有 --yes 时中止且不写文件', async t => {
  const base = tempDir(t);
  const setup = setupInstall(base);
  const next = fixture.makeRelease(path.join(base, 'next'), { version: '3.9.1' });
  const assets = fixture.makeArchive(path.join(base, 'assets'), next);
  const before = treeSnapshot(path.join(setup.installRoot, 'releases'));
  const result = await capture(() => upgrade.run([
    ...commonArgs(setup, assets.archive), '--version', '3.9.1', '--apply', '--no-start',
  ], { home: setup.home, env: {}, tmpdir: path.join(base, 'tmp'), isTTY: false }));
  assert.equal(result.code, 1);
  assert.match(result.text, /需要同时给 --yes/);
  assert.deepEqual(treeSnapshot(path.join(setup.installRoot, 'releases')), before);
});

test('upgrade-release:启动后指纹核对失败 → 切回旧 current 并恢复旧服务', async t => {
  const base = tempDir(t);
  const setup = setupInstall(base);
  const next = fixture.makeRelease(path.join(base, 'next'), { version: '3.9.1' });
  const assets = fixture.makeArchive(path.join(base, 'assets'), next);
  let verifyCalls = 0;
  const started = [];
  const result = await capture(() => upgrade.run([
    ...commonArgs(setup, assets.archive), '--version', '3.9.1', '--apply', '--yes',
  ], {
    home: setup.home, env: {}, tmpdir: path.join(base, 'tmp'), isTTY: false,
    startService: async (plan, releaseDir) => { started.push(releaseDir); return { pid: 9999, login: false }; },
    verifyService: async () => {
      verifyCalls += 1;
      if (verifyCalls === 1) return { ok: false, error: 'mock:源码指纹不符' };
      return { ok: true, state: { code_revision: 'old' } };
    },
    rollbackUpgrade: async plan => {
      // 走真实切换 + 注入的启动/核对,验证"回退后 current 确实回到旧目录"。
      const real = await (async () => {
        ru.rollbackCurrent({ installRoot: plan.installRoot, previous: plan.currentDir });
        const startedOld = await (async () => { started.push(plan.currentDir); return true; })();
        const verified = await (async () => true)();
        return { attempted: true, switched: true, started: startedOld, verified, error: null };
      })();
      return real;
    },
  }));
  assert.equal(result.code, 1);
  assert.match(result.text, /升级失败:mock:源码指纹不符/);
  assert.match(result.text, /已回退:current → .*3\.9\.0-old/);
  assert.equal(fs.readlinkSync(path.join(setup.installRoot, 'releases', 'current')), setup.old.dir);
  assert.equal(started.length, 2, '新版启动一次,回退后旧版再启动一次');
});

test('upgrade-release:回退失败时明确报告新旧目录与"回退未完成"', async t => {
  const base = tempDir(t);
  const setup = setupInstall(base);
  const next = fixture.makeRelease(path.join(base, 'next'), { version: '3.9.1' });
  const assets = fixture.makeArchive(path.join(base, 'assets'), next);
  const result = await capture(() => upgrade.run([
    ...commonArgs(setup, assets.archive), '--version', '3.9.1', '--apply', '--yes',
  ], {
    home: setup.home, env: {}, tmpdir: path.join(base, 'tmp'), isTTY: false,
    startService: async () => ({ pid: 9999, login: false }),
    verifyService: async () => ({ ok: false, error: 'mock:未就绪' }),
    rollbackUpgrade: async plan => ({ attempted: true, switched: false, started: false,
      verified: false, error: 'mock:current 切换被拒绝', previous: plan.currentDir }),
  }));
  assert.equal(result.code, 1);
  assert.match(result.text, /回退未完成:mock:current 切换被拒绝/);
  assert.match(result.text, /当前 current 仍在/);
  assert.match(result.text, /旧版本目录保留在/);
  assert.match(result.text, /不要删除任何目录/);
});

test('upgrade-release:排空超时直接中止,不停止服务、不切换代码、不打断在途请求', async t => {
  const base = tempDir(t);
  const setup = setupInstall(base);
  // 让 old 目录看起来有一个正在运行的实例:pid 文件 + 命令行指向该目录。
  fs.mkdirSync(path.join(setup.old.dir, '.run'), { recursive: true });
  fs.writeFileSync(path.join(setup.old.dir, '.run', 'mixrouter.pid'), '4242');
  const next = fixture.makeRelease(path.join(base, 'next'), { version: '3.9.1' });
  const assets = fixture.makeArchive(path.join(base, 'assets'), next);
  const releasesBefore = treeSnapshot(path.join(setup.installRoot, 'releases'));
  let killed = 0;
  const result = await capture(() => upgrade.run([
    ...commonArgs(setup, assets.archive), '--version', '3.9.1', '--apply', '--yes', '--drain-timeout', '1000',
  ], {
    home: setup.home, env: {}, tmpdir: path.join(base, 'tmp'), isTTY: false,
    // 模拟"持续有新请求":active_requests 永不归零
    requestState: async () => ({ pid: 4242, active_requests: 3, code_revision: 'x' }),
    isAliveImpl: () => true,
    commandFor: () => `node ${setup.old.dir}/mixrouter.js`,
    kill: () => { killed += 1; },
    sleepImpl: async () => {},
  }));
  assert.equal(result.code, 1);
  assert.match(result.text, /升级失败:.*在途请求/);
  assert.match(result.text, /服务仍在按原样运行/);
  assert.equal(killed, 0, '排空超时不能为了让流程成功而发信号');
  assert.deepEqual(treeSnapshot(path.join(setup.installRoot, 'releases')), releasesBefore,
    '排空失败时不得安装新发布或切换 current');
});

test('upgrade-release:--force-kill 与 --force 都已移除,并说明理由', async t => {
  const base = tempDir(t);
  const setup = setupInstall(base);
  for (const flag of ['--force-kill', '--force']) {
    const result = await capture(() => upgrade.run([
      '--install-root', setup.installRoot, '--data-dir', setup.dataDir, flag,
    ], { home: setup.home, env: {} }));
    assert.equal(result.code, 2, `${flag} 应当被参数层拒绝`);
    assert.match(result.text, new RegExp(`${flag} 已移除`));
    assert.match(result.text, /不会为了让流程"成功"而绕过安全检查/);
  }
});

test('upgrade-release:数据目录解析失败不可用 --force 跳过', async t => {
  const base = tempDir(t);
  const setup = setupInstall(base);
  fs.writeFileSync(path.join(setup.dataDir, 'providers.json'), '{ broken');
  const next = fixture.makeRelease(path.join(base, 'next'), { version: '3.9.1' });
  const assets = fixture.makeArchive(path.join(base, 'assets'), next);
  const before = treeSnapshot(path.join(setup.installRoot, 'releases'));
  const result = await capture(() => upgrade.run([
    ...commonArgs(setup, assets.archive), '--version', '3.9.1', '--apply', '--yes', '--no-start',
  ], { home: setup.home, env: {}, tmpdir: path.join(base, 'tmp'), isTTY: false }));
  assert.equal(result.code, 1);
  assert.match(result.text, /有无法解析的文件/);
  assert.match(result.text, /不提供跳过该检查的开关/);
  assert.deepEqual(treeSnapshot(path.join(setup.installRoot, 'releases')), before);
});

test('upgrade-release:坏校验和直接拒绝,连解包都不做', async t => {
  const base = tempDir(t);
  const setup = setupInstall(base);
  const next = fixture.makeRelease(path.join(base, 'next'), { version: '3.9.1' });
  const assets = fixture.makeArchive(path.join(base, 'assets'), next);
  // 篡改 sidecar:哈希对不上
  fs.writeFileSync(assets.sidecar, `${'0'.repeat(64)}  ${path.basename(assets.archive)}\n`);
  const before = treeSnapshot(path.join(setup.installRoot, 'releases'));
  const result = await capture(() => upgrade.run([
    ...commonArgs(setup, assets.archive), '--version', '3.9.1', '--apply', '--yes', '--no-start',
  ], { home: setup.home, env: {}, tmpdir: path.join(base, 'tmp'), isTTY: false }));
  assert.equal(result.code, 1);
  assert.match(result.text, /压缩包校验失败/);
  assert.deepEqual(treeSnapshot(path.join(setup.installRoot, 'releases')), before);
});

test('upgrade-release --rollback-to:切回旧目录并核对', async t => {
  const base = tempDir(t);
  const setup = setupInstall(base, { version: '3.9.0' });
  // 先装一个 3.9.1,再显式回退到 3.9.0
  const next = fixture.makeRelease(path.join(base, 'next'), { version: '3.9.1' });
  const assets = fixture.makeArchive(path.join(base, 'assets'), next);
  const applied = await capture(() => upgrade.run([
    ...commonArgs(setup, assets.archive), '--version', '3.9.1', '--apply', '--yes', '--no-start',
  ], { home: setup.home, env: {}, tmpdir: path.join(base, 'tmp') }));
  assert.equal(applied.code, 0, applied.text);
  const newDir = fs.readlinkSync(path.join(setup.installRoot, 'releases', 'current'));

  let verified = null;
  const result = await capture(() => upgrade.run([
    '--rollback-to', setup.old.dir, '--install-root', setup.installRoot, '--data-dir', setup.dataDir,
    '--apply', '--yes',
  ], {
    home: setup.home, env: {}, isTTY: false,
    startService: async () => ({ pid: 9999, login: false }),
    verifyService: async (plan, expected) => { verified = expected; return { ok: true }; },
  }));
  assert.equal(result.code, 0, result.text);
  assert.equal(fs.readlinkSync(path.join(setup.installRoot, 'releases', 'current')), setup.old.dir);
  assert.equal(verified.version, '3.9.0');
  assert.ok(fs.existsSync(newDir), '被切下来的新版目录必须保留,不能删');
});
