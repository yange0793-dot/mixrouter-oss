'use strict';
// lib/service-manager.js 的离线回归。
//
// 全部在临时 HOME / 临时安装根里跑:不碰真实 ~/Library/LaunchAgents,不调用 launchctl,
// 不向真实进程发信号。进程相关的动作全部注入(isAlive / kill / commandFor)。
//
// 重点不是"函数能返回",而是**承诺不做的事**:
//   · 不属于目标目录的 pid 不发信号;
//   · 没有 marker 的 plist 不覆盖、不删除;
//   · 预览模式零写盘。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sm = require('../lib/service-manager');

const ROOT = path.join(__dirname, '..');

function tempDir(t, prefix = 'mixr-sm-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRelease(dir, { version = '3.9.0', pid = 0 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'mixrouter', version }));
  fs.writeFileSync(path.join(dir, 'mixrouter.js'), `const VERSION = '${version}';\n`);
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'x.js'), 'module.exports = 1;\n');
  if (pid) {
    fs.mkdirSync(path.join(dir, '.run'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.run', 'mixrouter.pid'), String(pid));
  }
  return dir;
}

function plistText({ label = 'com.test.mixrouter.managed', runScript, dataDir, marker = true, proxy = 8787 } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
${marker ? `<!-- ${sm.MANAGED_MARKER}: test fixture -->` : '<!-- copied by hand -->'}
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>${runScript}</string></array>
  <key>WorkingDirectory</key><string>${path.dirname(path.dirname(runScript))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MIXR_DATA_DIR</key><string>${dataDir}</string>
    <key>MIXROUTER_PORT</key><string>${proxy}</string>
    <key>MIXUI_PORT</key><string>${proxy + 1}</string>
  </dict>
</dict>
</plist>`;
}

// ---------------------------------------------------------------- plist 渲染
test('renderLaunchAgent:路径转义、固定数据目录、托管标记与端口', () => {
  const text = sm.renderLaunchAgent({
    label: 'com.test.mixrouter.managed',
    releaseDir: '/tmp/a&b/release',
    dataDir: '/tmp/data <x>',
    nodePath: '/usr/local/bin/node',
    logDir: '/tmp/data <x>/logs',
    proxyPort: 18787, uiPort: 18788,
  });
  assert.ok(text.includes(sm.MANAGED_MARKER));
  assert.ok(text.includes('com.test.mixrouter.managed'));
  assert.ok(text.includes('/tmp/a&amp;b/release/scripts/launchd-run.sh'));
  assert.ok(text.includes('/tmp/data &lt;x&gt;'));
  assert.ok(text.includes('<key>MIXROUTER_PORT</key>'));
  assert.ok(text.includes('18787'));
  assert.ok(text.includes('18788'));
  assert.ok(text.includes('/usr/local/bin:/usr/bin:/bin'));
});

test('renderLaunchAgent:拒绝非法 label、相对路径、越界端口', () => {
  const base = { label: 'com.test.mixrouter.managed', releaseDir: '/tmp/r', dataDir: '/tmp/d',
    logDir: '/tmp/l', nodePath: '/bin/node' };
  assert.throws(() => sm.renderLaunchAgent({ ...base, label: '../evil' }), /label/);
  assert.throws(() => sm.renderLaunchAgent({ ...base, releaseDir: 'relative' }), /绝对路径/);
  assert.throws(() => sm.renderLaunchAgent({ ...base, uiPort: 0 }), /1–65535/);
  assert.throws(() => sm.renderLaunchAgent({ ...base, proxyPort: 9000, uiPort: 9000 }), /不能相同/);
});

test('label 命名空间:默认 .managed;legacy com.<用户>.mixrouter 明确拒绝接管', () => {
  const label = sm.defaultLabel('tufu');
  assert.equal(label, 'com.tufu.mixrouter.managed');
  assert.equal(sm.assertManagedLabel(label), label);
  // legacy:install-macos.sh / 旧 mixctl 的 label —— 只读展示,拒绝写入与删除
  for (const legacy of ['com.tufu.mixrouter', 'com.example.mixrouter']) {
    assert.throws(() => sm.assertManagedLabel(legacy), error => error.code === 'legacy_label');
    assert.throws(() => sm.launchAgentPath('/tmp/home', legacy), error => error.code === 'legacy_label');
    assert.throws(() => sm.planUninstall({ home: '/tmp/home', label: legacy }), error => error.code === 'legacy_label');
  }
  assert.throws(() => sm.assertManagedLabel('com.tufu.other'), error => error.code === 'invalid_label');
  assert.throws(() => sm.assertManagedLabel(''), error => error.code === 'invalid_label');
});

test('defaultLabel 与现役 legacy 同名冲突时:不认领、不覆盖、不删除', t => {
  // 主会话问的那条:如果 defaultLabel 仍是 com.<user>.mixrouter,遇上现役 live plist
  // 会怎样。现在默认值带 .managed,所以同名冲突不可能由默认值产生;真正要锁的是
  // "假设有人手工把 .managed 那份写成没有 marker"—— 那也是拒绝,不是接管。
  const home = tempDir(t);
  const release = makeRelease(path.join(tempDir(t), 'releases', '3.9.0'));
  const defaultLabel = sm.defaultLabel('tufu');
  assert.ok(defaultLabel.endsWith('.mixrouter.managed'));
  assert.notEqual(defaultLabel, 'com.tufu.mixrouter');

  // 1) 现役(无 marker)legacy plist 摆在那里:默认 label 指向另一个文件,不会碰它
  const agentDir = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agentDir, { recursive: true });
  const legacyPath = path.join(agentDir, 'com.tufu.mixrouter.plist');
  const legacyRaw = plistText({ label: 'com.tufu.mixrouter',
    runScript: path.join(release, 'scripts', 'launchd-run.sh'), dataDir: '/live/data', marker: false });
  fs.writeFileSync(legacyPath, legacyRaw);

  const plan = sm.planInstall({ home, label: defaultLabel, releaseDir: release,
    dataDir: path.join(home, 'data'), nodePath: '/usr/bin/node', proxyPort: 18787, uiPort: 18788 });
  assert.equal(plan.action, 'create');
  assert.notEqual(plan.plistPath, legacyPath);
  sm.applyInstall(plan);
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), legacyRaw, '现役 legacy plist 一个字节都不能变');

  // 2) 就算目标路径上真的躺着一份无 marker 的 .managed 文件:拒绝覆盖/删除
  const collisionPath = path.join(agentDir, `${defaultLabel}.plist`);
  fs.writeFileSync(collisionPath, legacyRaw.replace('com.tufu.mixrouter', defaultLabel));
  const blocked = sm.planInstall({ home, label: defaultLabel, releaseDir: release,
    dataDir: path.join(home, 'data'), nodePath: '/usr/bin/node', proxyPort: 18787, uiPort: 18788 });
  assert.equal(blocked.action, 'blocked');
  assert.throws(() => sm.applyInstall(blocked), /不属于自己|没有 mixrouter-managed/);
  const uninstall = sm.planUninstall({ home, label: defaultLabel });
  assert.equal(uninstall.action, 'blocked');
  assert.throws(() => sm.applyUninstall(uninstall), /不属于自己/);
});

test('detect:legacy plist 被识别为"非本工具",不进 preferred', t => {
  const home = tempDir(t);
  const installRoot = path.join(home, '.local', 'share', 'mixrouter');
  const release = makeRelease(path.join(installRoot, 'releases', '3.9.0'));
  const agentDir = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'com.tufu.mixrouter.plist'),
    plistText({ label: 'com.tufu.mixrouter', runScript: path.join(release, 'scripts', 'launchd-run.sh'),
      dataDir: path.join(home, 'legacy-data'), marker: false }));
  const detection = sm.detect({ installRoot, home, commandFor: () => null, isAliveImpl: () => false });
  const legacy = detection.launchAgents.find(item => item.label === 'com.tufu.mixrouter');
  assert.equal(legacy.managed, false);
  // 它仍被解析出来(状态里要看得到),但任何写路径都不会认它
  assert.throws(() => sm.planInstall({ home, label: legacy.label, releaseDir: release,
    dataDir: path.join(home, 'data'), nodePath: '/usr/bin/node', proxyPort: 18787, uiPort: 18788 }),
  error => error.code === 'legacy_label');
});

// ---------------------------------------------------------------- 安装计划
test('planInstall/applyInstall:预览零写盘,apply 才创建,重复内容不重写', t => {
  const home = tempDir(t);
  const release = makeRelease(path.join(tempDir(t), 'releases', '3.9.0'));
  const options = { home, label: 'com.test.mixrouter.managed', releaseDir: release,
    dataDir: path.join(home, 'data'), nodePath: '/usr/bin/node', proxyPort: 18787, uiPort: 18788 };
  const plan = sm.planInstall(options);
  assert.equal(plan.action, 'create');
  assert.ok(!fs.existsSync(plan.plistPath), '计划阶段不许创建目录或文件');

  const applied = sm.applyInstall(plan, { now: new Date('2026-10-22T10:00:00Z') });
  assert.equal(applied.written, true);
  assert.ok(fs.existsSync(plan.plistPath));
  const written = fs.readFileSync(plan.plistPath, 'utf8');
  assert.ok(written.includes(sm.MANAGED_MARKER));
  assert.equal(fs.statSync(plan.plistPath).mode & 0o777, 0o644);

  const again = sm.planInstall(options);
  assert.equal(again.action, 'unchanged');
  const second = sm.applyInstall(again);
  assert.equal(second.written, false);
  assert.equal(second.unchanged, true);
});

test('planInstall:已存在的非托管 plist 只读,apply 拒绝覆盖且原文件不变', t => {
  const home = tempDir(t);
  const release = makeRelease(path.join(tempDir(t), 'releases', '3.9.0'));
  const plistPath = sm.launchAgentPath(home, 'com.test.mixrouter.managed');
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  const original = plistText({ runScript: '/old/scripts/launchd-run.sh', dataDir: '/old/data', marker: false });
  fs.writeFileSync(plistPath, original);

  const plan = sm.planInstall({ home, label: 'com.test.mixrouter.managed', releaseDir: release,
    dataDir: path.join(home, 'data'), nodePath: '/usr/bin/node', proxyPort: 18787, uiPort: 18788 });
  assert.equal(plan.action, 'blocked');
  assert.throws(() => sm.applyInstall(plan), /没有 mixrouter-managed|不属于自己/);
  assert.equal(fs.readFileSync(plistPath, 'utf8'), original);
});

test('planInstall/applyInstall:托管文件内容变化时先备份再原子替换', t => {
  const home = tempDir(t);
  const release = makeRelease(path.join(tempDir(t), 'releases', '3.9.0'));
  const plistPath = sm.launchAgentPath(home, 'com.test.mixrouter.managed');
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  const old = plistText({ runScript: path.join(release, 'scripts', 'launchd-run.sh'),
    dataDir: path.join(home, 'data'), proxy: 8787 });
  fs.writeFileSync(plistPath, old);

  const plan = sm.planInstall({ home, label: 'com.test.mixrouter.managed', releaseDir: release,
    dataDir: path.join(home, 'data'), nodePath: '/usr/bin/node', proxyPort: 18787, uiPort: 18788 });
  assert.equal(plan.action, 'update');
  const applied = sm.applyInstall(plan, { now: new Date('2026-10-22T10:00:00Z') });
  assert.equal(applied.written, true);
  assert.ok(applied.backup && fs.existsSync(applied.backup));
  assert.equal(fs.readFileSync(applied.backup, 'utf8'), old);
  assert.ok(fs.readFileSync(plistPath, 'utf8').includes('18787'));
});

test('planUninstall/applyUninstall:只删托管文件,删除前留备份', t => {
  const home = tempDir(t);
  const release = makeRelease(path.join(tempDir(t), 'releases', '3.9.0'));
  const options = { home, label: 'com.test.mixrouter.managed', releaseDir: release,
    dataDir: path.join(home, 'data'), nodePath: '/usr/bin/node', proxyPort: 18787, uiPort: 18788 };
  assert.equal(sm.planUninstall({ home, label: 'com.test.mixrouter.managed' }).action, 'missing');
  sm.applyInstall(sm.planInstall(options));
  const plan = sm.planUninstall({ home, label: 'com.test.mixrouter.managed' });
  assert.equal(plan.action, 'remove');
  const applied = sm.applyUninstall(plan, { now: new Date('2026-10-22T10:00:00Z') });
  assert.equal(applied.removed, true);
  assert.ok(applied.backup && fs.existsSync(applied.backup));
  assert.ok(!fs.existsSync(plan.plistPath));

  // 非托管文件:拒绝删除
  fs.writeFileSync(plan.plistPath, plistText({ runScript: '/x/scripts/launchd-run.sh', dataDir: '/x', marker: false }));
  const foreign = sm.planUninstall({ home, label: 'com.test.mixrouter.managed' });
  assert.equal(foreign.action, 'blocked');
  assert.throws(() => sm.applyUninstall(foreign), /不属于自己/);
  assert.ok(fs.existsSync(plan.plistPath));
});

// ---------------------------------------------------------------- 实例识别
test('detect:按命令行判断 pid 归属,不把别的目录的进程算成自己', t => {
  const home = tempDir(t);
  const installRoot = path.join(home, '.local', 'share', 'mixrouter');
  const releaseRoot = path.join(installRoot, 'releases');
  const a = makeRelease(path.join(releaseRoot, '3.9.0'), { pid: 4242 });
  const b = makeRelease(path.join(releaseRoot, '3.8.0'), { pid: 4343 });
  fs.symlinkSync(a, path.join(releaseRoot, 'current'), 'dir');
  const commands = { 4242: `node ${a}/mixrouter.js`, 4343: 'node /somewhere/else/mixrouter.js' };
  const detection = sm.detect({
    installRoot, home,
    commandFor: pid => commands[pid] || null,
    isAliveImpl: pid => pid === 4242 || pid === 4343,
  });
  assert.equal(detection.current, a);
  const first = detection.releases.find(item => item.dir === a);
  const second = detection.releases.find(item => item.dir === b);
  assert.equal(first.owned, true);
  assert.equal(first.current, true);
  assert.equal(second.owned, false, '命令行指向别处就不能算自己的实例');
  assert.deepEqual(sm.foreignLiveInstances(detection, { allowedDirs: [a] }).map(item => item.dir), [b]);
});

test('detect/listLaunchAgents:解析托管标记、指向目录、数据目录与端口', t => {
  const home = tempDir(t);
  const installRoot = path.join(home, '.local', 'share', 'mixrouter');
  const release = makeRelease(path.join(installRoot, 'releases', '3.9.0'));
  const agentDir = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'com.a.mixrouter.plist'),
    plistText({ label: 'com.a.mixrouter', runScript: path.join(release, 'scripts', 'launchd-run.sh'), dataDir: path.join(home, 'data') }));
  fs.writeFileSync(path.join(agentDir, 'com.b.mixrouter.plist'),
    plistText({ label: 'com.b.mixrouter', runScript: '/old/scripts/launchd-run.sh', dataDir: '/old', marker: false }));
  fs.writeFileSync(path.join(agentDir, 'unrelated.plist'), '<plist></plist>');

  const detection = sm.detect({ installRoot, home, commandFor: () => null, isAliveImpl: () => false });
  assert.equal(detection.launchAgents.length, 2);
  const a = detection.launchAgents.find(item => item.label === 'com.a.mixrouter');
  assert.equal(a.managed, true);
  assert.equal(a.pinnedRelease, release);
  assert.equal(a.dataDir, path.join(home, 'data'));
  assert.equal(a.proxyPort, 8787);
  assert.equal(a.uiPort, 8788);
  const b = detection.launchAgents.find(item => item.label === 'com.b.mixrouter');
  assert.equal(b.managed, false);
  assert.equal(b.pinnedRelease, '/old');
});

// ---------------------------------------------------------------- 停止
test('stopOwnedProcess:只对确认属于该目录的 pid 发 SIGTERM,并等它退出', async () => {
  const calls = [];
  let alive = true;
  const result = await sm.stopOwnedProcess({
    releaseDir: '/opt/mixr/releases/3.9.0', pid: 5555,
    commandFor: () => 'node /opt/mixr/releases/3.9.0/mixrouter.js',
    isAliveImpl: () => alive,
    kill: (pid, signal) => { calls.push([pid, signal]); alive = false; },
    sleepImpl: async () => {},
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(calls, [[5555, 'SIGTERM']]);
});

test('stopOwnedProcess:命令行对不上时拒绝,不发任何信号', async () => {
  const calls = [];
  await assert.rejects(sm.stopOwnedProcess({
    releaseDir: '/opt/mixr/releases/3.9.0', pid: 5555,
    commandFor: () => 'node /opt/other/mixrouter.js',
    isAliveImpl: () => true,
    kill: (...args) => calls.push(args),
  }), error => error.code === 'not_owned');
  assert.deepEqual(calls, []);
});

test('ownershipEvidence:process.title 改成 mixrouter 后,靠 pid 文件与进程启动时间认领', t => {
  const dir = makeRelease(path.join(tempDir(t), 'releases', '3.9.0'), { pid: 6001 });
  // mixrouter.js 启动后执行 process.title = 'mixrouter',ps 只剩一个词。
  const evidence = sm.ownershipEvidence({
    pid: 6001, releaseDir: dir,
    commandFor: () => 'mixrouter',
    processStartFor: () => fs.statSync(path.join(dir, '.run', 'mixrouter.pid')).mtimeMs + 1000,
  });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.evidence, 'pidfile+start_time');
});

test('ownershipEvidence:PID 被别的 mixrouter 复用时,启动时间对不上就拒绝', t => {
  const dir = makeRelease(path.join(tempDir(t), 'releases', '3.9.0'), { pid: 6002 });
  const evidence = sm.ownershipEvidence({
    pid: 6002, releaseDir: dir,
    commandFor: () => 'mixrouter',
    processStartFor: () => fs.statSync(path.join(dir, '.run', 'mixrouter.pid')).mtimeMs + 3600_000,
  });
  assert.equal(evidence.ok, false);
  assert.equal(evidence.reason, 'start_time');
  // 命令行不是 mixrouter 的活进程一律拒绝,连启动时间都不看
  const other = sm.ownershipEvidence({ pid: 6003, releaseDir: dir, commandFor: () => 'postgres -D /data' });
  assert.equal(other.ok, false);
  assert.equal(other.reason, 'command');
});

test('stopOwnedProcess:/api/state 自报 pid 与指纹吻合时可作为归属证据', async t => {
  const calls = [];
  let alive = true;
  const dir = makeRelease(path.join(tempDir(t), 'releases', '3.9.0'), { pid: 6004 });
  const revision = require('../lib/runtime-code').codeRevision(dir);
  const result = await sm.stopOwnedProcess({
    releaseDir: dir, pid: 6004,
    commandFor: () => 'mixrouter',
    processStartFor: () => 0, // 与 pid 文件时间不吻合
    state: { pid: 6004, code_revision: revision },
    isAliveImpl: () => alive,
    kill: (pid, signal) => { calls.push([pid, signal]); alive = false; },
    sleepImpl: async () => {},
  });
  assert.equal(result.stopped, true);
  assert.equal(result.evidence, 'state');
  assert.deepEqual(calls, [[6004, 'SIGTERM']]);
});

test('stopOwnedProcess:两种证据都不成立时拒绝,不发信号', async t => {
  const calls = [];
  const dir = makeRelease(path.join(tempDir(t), 'releases', '3.9.0'), { pid: 6005 });
  await assert.rejects(sm.stopOwnedProcess({
    releaseDir: dir, pid: 6005,
    commandFor: () => 'mixrouter',
    processStartFor: () => 0,
    state: { pid: 6005, code_revision: 'f'.repeat(64) },
    isAliveImpl: () => true,
    kill: (...args) => calls.push(args),
  }), error => error.code === 'not_owned');
  assert.deepEqual(calls, []);
});

// ---- 归属判断必须按 argv 入口,不能按"命令行里有没有这个路径" ----
// 这是一条真实缺陷的回归锁:旧实现用 `command.includes(dir + '/')`,
// 于是 `cat <release>/README.md`、`vim <release>/package.json`、甚至
// `node <release>/some-other-script.js` 都会被当成"自己的服务",被 stopOwnedProcess 发 SIGTERM。
test('commandRunsFrom:只有入口恰为 <root>/mixrouter.js 才算命中', t => {
  const base = tempDir(t);
  const release = makeRelease(path.join(base, 'releases', '3.9.0'));
  const entry = path.join(release, 'mixrouter.js');

  const matched = sm.commandRunsFrom(`node ${entry}`, release);
  assert.deepEqual({ entry: matched.entry, matched: matched.matched }, { entry: 'node', matched: true });
  assert.equal(sm.commandRunsFrom(`/usr/local/bin/node --enable-source-maps ${entry}`, release).matched, true);
  // 带引号也认(ps 输出里可能有空格路径,这里用引号包住同一个入口)
  assert.equal(sm.commandRunsFrom(`node "${entry}"`, release).matched, true);

  // 目录只是**参数**的进程:一律不算
  for (const command of [
    `cat ${release}/README.md`,
    `vim ${release}/package.json`,
    `less ${release}/mixrouter.js`,          // 入口是 less,不是 node
    `node ${release}/other-script.js`,       // node 但脚本不是 mixrouter.js
    `node /somewhere/else/mixrouter.js`,     // 同名不同目录
    `node ${release}-old/mixrouter.js`,      // 前缀相似
    `grep -r mixrouter ${release}`,
    `tail -f ${release}/logs/server.log`,
  ]) {
    const result = sm.commandRunsFrom(command, release);
    assert.equal(result.matched, false, `误判为已归属:${command}`);
    assert.equal(result.entry, 'other', `应当明确判为"别的东西":${command}`);
  }
});

test('commandRunsFrom:process.title 之后命令行只剩一个词,标为 title 而不是 other', t => {
  const base = tempDir(t);
  const release = makeRelease(path.join(base, 'releases', '3.9.0'));
  assert.equal(sm.commandRunsFrom('mixrouter', release).entry, 'title');
  // 别的单进程名不能被当成我们的服务
  assert.equal(sm.commandRunsFrom('postgres', release).entry, 'other');
  assert.equal(sm.commandRunsFrom('', release).entry, 'other');
});

test('ownershipEvidence:带该目录参数的编辑器/查看器不得被认领', t => {
  const base = tempDir(t);
  const release = makeRelease(path.join(base, 'releases', '3.9.0'), { pid: 7001 });
  const pidFileMtime = fs.statSync(path.join(release, '.run', 'mixrouter.pid')).mtimeMs;
  for (const command of [`vim ${release}/package.json`, `cat ${release}/README.md`,
    `node ${release}/scripts/doctor.js`]) {
    const evidence = sm.ownershipEvidence({
      pid: 7001, releaseDir: release, commandFor: () => command,
      processStartFor: () => pidFileMtime, // 时间吻合也不该救它:它是明确别的东西
    });
    assert.equal(evidence.ok, false, `被误认领:${command}`);
    assert.equal(evidence.reason, 'command');
  }
});

test('stopOwnedProcess:正文里提到该目录的进程不会被发信号', async t => {
  const base = tempDir(t);
  const release = makeRelease(path.join(base, 'releases', '3.9.0'), { pid: 7002 });
  const calls = [];
  await assert.rejects(sm.stopOwnedProcess({
    releaseDir: release, pid: 7002,
    commandFor: () => `vim ${release}/provider.json`,
    processStartFor: () => fs.statSync(path.join(release, '.run', 'mixrouter.pid')).mtimeMs,
    isAliveImpl: () => true,
    kill: (...args) => calls.push(args),
  }), error => error.code === 'not_owned');
  assert.deepEqual(calls, [], '编辑器进程绝不能收到 SIGTERM');
});

test('commandRunsFrom:入口 token 之后出现的 mixrouter.js 不算入口(不扫后续参数)', t => {
  const base = tempDir(t);
  const release = makeRelease(path.join(base, 'releases', '3.9.0'));
  const entry = path.join(release, 'mixrouter.js');
  // 主会话指出的两种误杀:真正的脚本在别的目录,或根本是 -e 执行模式,
  // 而 mixrouter.js 只是被当成**参数**传进去。
  for (const command of [
    `node /other/tool.js ${entry}`,
    `node -e 'console.log(1)' ${entry}`,
    `node --eval ${entry}`,
    `node -p 1 ${entry}`,
    `node -c ${entry}`,                       // --check:检查语法,不运行
    `node --test ${entry}`,
    `node --enable-source-maps /other/tool.js ${entry}`,
  ]) {
    const result = sm.commandRunsFrom(command, release);
    assert.equal(result.matched, false, `误判为已归属:${command}`);
    assert.equal(result.entry, 'other', `应当明确判为"别的东西":${command}`);
  }
});

test('commandRunsFrom:入口前有 node 选项时仍认得出来;带值选项不吃掉脚本名', t => {
  const base = tempDir(t);
  const release = makeRelease(path.join(base, 'releases', '3.9.0'));
  const entry = path.join(release, 'mixrouter.js');
  assert.equal(sm.commandRunsFrom(`node --enable-source-maps ${entry}`, release).matched, true);
  assert.equal(sm.commandRunsFrom(`node --no-warnings ${entry}`, release).matched, true);
  assert.equal(sm.commandRunsFrom(`node --max-old-space-size=512 ${entry}`, release).matched, true);
  // 带值的开关:+ 它的值 + 入口
  assert.equal(sm.commandRunsFrom(`node -r ./hook.js ${entry}`, release).matched, true);
  assert.equal(sm.commandRunsFrom(`node --require ./hook.js ${entry}`, release).matched, true);
  // `--` 之后的第一项是脚本
  assert.equal(sm.commandRunsFrom(`node -- ${entry}`, release).matched, true);
  // 入口之后的参数不做任何判断(不会被误当成"另一个脚本")
  assert.equal(sm.commandRunsFrom(`node ${entry} --inspect /other/tool.js`, release).matched, true);
});

test('ownershipEvidence:入口是别的脚本时,即使 pid 文件时间吻合也拒绝', t => {
  const base = tempDir(t);
  const release = makeRelease(path.join(base, 'releases', '3.9.0'), { pid: 7003 });
  const mtime = fs.statSync(path.join(release, '.run', 'mixrouter.pid')).mtimeMs;
  for (const command of [`node /other/tool.js ${release}/mixrouter.js`,
    `node -e 'x' ${release}/mixrouter.js`]) {
    const evidence = sm.ownershipEvidence({
      pid: 7003, releaseDir: release, commandFor: () => command, processStartFor: () => mtime,
    });
    assert.equal(evidence.ok, false, `被误认领:${command}`);
    assert.equal(evidence.reason, 'command');
  }
});

test('waitForExit:超时返回 exited=false', async () => {
  const result = await sm.waitForExit(1234, { timeoutMs: 0, isAliveImpl: () => true, sleepImpl: async () => {} });
  assert.equal(result.exited, false);
});

test('waitForDrain:字段存在时等它归零;字段缺失时如实报告不支持', async () => {
  const states = [{ active_requests: 3 }, { active_requests: 1 }, { active_requests: 0 }];
  const drained = await sm.waitForDrain({
    uiPort: 8788, requestState: async () => states.shift(), sleepImpl: async () => {}, timeoutMs: 1000,
  });
  assert.deepEqual({ supported: drained.supported, drained: drained.drained, active: drained.active },
    { supported: true, drained: true, active: 0 });

  const missing = await sm.waitForDrain({ uiPort: 8788, requestState: async () => ({ ok: true }), timeoutMs: 1000 });
  assert.equal(missing.supported, false);
  assert.equal(missing.reason, 'field_absent');
});

// ---------------------------------------------------------------- CLI 预览
test('scripts/service.js:status 与 install 预览都不写文件', t => {
  const home = tempDir(t);
  const installRoot = path.join(home, '.local', 'share', 'mixrouter');
  const release = makeRelease(path.join(installRoot, 'releases', '3.9.0'), { version: '3.9.0' });
  fs.mkdirSync(path.dirname(path.join(installRoot, 'releases', 'current')), { recursive: true });
  fs.symlinkSync(release, path.join(installRoot, 'releases', 'current'), 'dir');
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    TMPDIR: process.env.TMPDIR || '/tmp', LANG: 'en_US.UTF-8',
  };
  const before = snapshot(home);
  const status = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'service.js'), 'status'], {
    env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /3\.9\.0/);
  assert.match(status.stdout, /登录服务: 未安装/);
  const preview = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'service.js'), 'install',
    '--release', release, '--data-dir', path.join(home, 'data'), '--port', '18787', '--ui-port', '18788'], {
    env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /没有写入任何文件/);
  assert.deepEqual(snapshot(home), before, '预览模式不得创建 plist 或数据目录');
});

function snapshot(root) {
  const out = [];
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
