'use strict';
// scripts/service.js、scripts/check-update.js、scripts/upgrade-release.js 的**安全 CLI 冒烟**。
//
// 与 test/release-update-cli.test.js 的分工:
//   · 那边直接 require 导出的 run(),测逻辑分支(排空超时、回滚、坏校验和);
//   · 这里只通过**子进程**跑真实命令行入口,测"打包后用户手上那条命令"能不能用:
//     参数解析、退出码、stdout/stderr 的措辞、--help 可读、以及**不写盘**。
//
// 三条硬约束(与 install-script.test.js 同一套路):
//   1. 临时 HOME + 临时安装根,真实 HOME 一个字节都不碰;
//   2. 不调用 launchctl(任何子进程都不执行它;测试注入不了 launchctl,所以
//      这些用例只覆盖 status / 预览 / 明确拒绝的路径);
//   3. 不联网:check-update 默认不联网;--check 的联网路径在别的用例里注入 fetch。
//
// 为什么值得单独测:这三个脚本是运行包里的 .js,`node --test` 的 require 测试
// 证明不了"可执行入口"没坏 —— shebang、require.main 分支、进程退出码,都只在
// 真正 spawn 时才暴露。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI_TIMEOUT_MS = 20000;

// 干净环境:不带 run-tests.js 设的 MIXR_*/MIXROUTER_*/MIXUI_*,否则"脚本有没有被
// 继承环境带跑"就测不出来。
function cleanEnv(home) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(MIXR_|MIXROUTER_|MIXUI_)/.test(key)) continue;
    if (key === 'NODE_OPTIONS' || key === 'NODE_PATH' || key === 'NODE_TEST_CONTEXT') continue;
    env[key] = value;
  }
  return { ...env, HOME: home, USERPROFILE: home, TMPDIR: path.join(home, 'tmp') };
}

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-cli-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
  const installRoot = path.join(home, 'install');
  const releaseRoot = path.join(installRoot, 'releases');
  const release = path.join(releaseRoot, '3.9.0-abcdef12');
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, 'package.json'), JSON.stringify({ name: 'mixrouter', version: '3.9.0' }));
  fs.writeFileSync(path.join(release, 'mixrouter.js'), "const VERSION = '3.9.0';\n");
  fs.mkdirSync(path.join(release, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'lib', 'runtime-code.js'), path.join(release, 'lib', 'runtime-code.js'));
  fs.symlinkSync(release, path.join(releaseRoot, 'current'), 'dir');
  return { home, installRoot, releaseRoot, release };
}

function runCli(script, args, { home, extraEnv = {}, input } = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    env: { ...cleanEnv(home), ...extraEnv },
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    input: input === undefined ? undefined : input,
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
}

// 整棵树快照:用来证明"预览/只读命令不写盘"。
function snapshot(root) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) out.push(`${rel}->${fs.readlinkSync(full)}`);
      else if (stat.isDirectory()) { out.push(`${rel}/`); walk(full, rel); }
      else out.push(`${rel}:${fs.readFileSync(full).toString('base64')}`);
    }
  };
  walk(root, '');
  return out;
}

// ---------------------------------------------------------------- --help 与参数
test('三个脚本的 --help 可直接读完,且退出码 0', t => {
  const f = fixture(t);
  for (const script of ['service.js', 'check-update.js', 'upgrade-release.js']) {
    const result = runCli(script, ['--help'], { home: f.home });
    assert.equal(result.status, 0, `${script} --help 退出码 ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /用法:/, `${script} --help 没有用法段`);
    assert.ok(result.stdout.length > 200, `${script} --help 太短,读不出边界`);
  }
});

test('未知参数与非法值都以非 0 退出,且不写文件', t => {
  const f = fixture(t);
  const before = snapshot(f.home);
  const cases = [
    ['service.js', ['--nope']],
    ['service.js', ['install', '--port', 'abc', '--apply', '--yes']],
    ['check-update.js', ['--timeout', '5']],
    ['check-update.js', ['--bogus']],
    ['upgrade-release.js', ['--repo', 'evil/repo']],
    ['upgrade-release.js', ['--force-kill']],
    ['upgrade-release.js', ['--archive', '/tmp/x.tar.gz', '--rollback-to', '/tmp/y']],
  ];
  for (const [script, args] of cases) {
    const result = runCli(script, args, { home: f.home });
    assert.notEqual(result.status, 0, `${script} ${args.join(' ')} 应当失败`);
  }
  assert.deepEqual(snapshot(f.home), before, '参数错误时不得留下任何文件');
});

test('upgrade-release 明确没有 --repo / --url:来源固定', t => {
  const f = fixture(t);
  const result = runCli('upgrade-release.js', ['--repo', 'attacker/mixrouter'], { home: f.home });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /没有 --repo \/ --url/);
});

// ---------------------------------------------------------------- 只读命令
test('service status / check-update 默认不联网、不写盘', t => {
  const f = fixture(t);
  const before = snapshot(f.home);
  const status = runCli('service.js', ['status', '--install-root', f.installRoot], { home: f.home });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /3\.9\.0/, 'status 应当报出 current 的版本');
  assert.match(status.stdout, /登录服务: 未安装/);

  const update = runCli('check-update.js', ['--install-root', f.installRoot], { home: f.home });
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /未联网检查/);
  // 离线提示里也会出现"官方最新版本:"这几个字,所以判据必须是**结果行**(带版本号),
  // 不是"文本里出现过最新版本"。
  assert.doesNotMatch(update.stdout, /^最新版本: \d/m, '默认不能联网查询');
  assert.deepEqual(snapshot(f.home), before, '只读命令不得创建 plist/数据目录/缓存');
});

test('service status --json 是合法 JSON,字段可供脚本消费', t => {
  const f = fixture(t);
  const result = runCli('service.js', ['status', '--json', '--install-root', f.installRoot], { home: f.home });
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.install_root, f.installRoot);
  assert.equal(json.current, f.release);
  assert.equal(json.release.version, '3.9.0');
  assert.deepEqual(json.launch_agents, []);
});

// ---------------------------------------------------------------- 预览
test('service install 预览打印 plist 但不写盘;--apply 无 --yes 且非交互时拒绝', t => {
  const f = fixture(t);
  const before = snapshot(f.home);
  const args = ['install', '--install-root', f.installRoot, '--release', f.release,
    '--data-dir', path.join(f.home, 'data'), '--port', '18787', '--ui-port', '18788'];
  const preview = runCli('service.js', args, { home: f.home });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /没有写入任何文件/);
  assert.match(preview.stdout, /mixrouter-managed/);
  assert.deepEqual(snapshot(f.home), before, '预览不得创建 LaunchAgents 或数据目录');

  // 非交互 + --apply 但缺 --yes:必须当场失败,不能挂住等输入
  const refused = runCli('service.js', [...args, '--apply'], { home: f.home, input: '' });
  assert.notEqual(refused.status, 0);
  assert.deepEqual(snapshot(f.home), before, '拒绝后也不得留下文件');
});

test('upgrade-release 无来源时只报状态;--version 无 --download 时明确要求显式联网', t => {
  const f = fixture(t);
  const before = snapshot(f.home);
  const status = runCli('upgrade-release.js', ['--install-root', f.installRoot], { home: f.home });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /没有指定安装来源/);
  assert.match(status.stdout, /--archive/);

  const gated = runCli('upgrade-release.js', ['--install-root', f.installRoot, '--version', '3.9.1'], {
    home: f.home,
  });
  assert.equal(gated.status, 1);
  assert.match(gated.stderr, /必须显式加 --download/);
  assert.deepEqual(snapshot(f.home), before);
});

// ---------------------------------------------------------------- 拒绝接管 legacy label
test('service install 拒绝 legacy label(com.<用户>.mixrouter),且不写文件', t => {
  const f = fixture(t);
  const before = snapshot(f.home);
  const result = runCli('service.js', ['install', '--install-root', f.installRoot, '--release', f.release,
    '--data-dir', path.join(f.home, 'data'), '--port', '18787', '--ui-port', '18788',
    '--label', 'com.example.mixrouter'], { home: f.home });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不归本工具管理/);
  assert.match(result.stderr, /mixrouter\.managed/);
  assert.deepEqual(snapshot(f.home), before);
});

test('service uninstall 对缺失的托管 plist 是 no-op,不写盘', t => {
  const f = fixture(t);
  const before = snapshot(f.home);
  const result = runCli('service.js', ['uninstall'], { home: f.home });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /没有找到要删除的 plist|action: missing/);
  assert.deepEqual(snapshot(f.home), before);
});
