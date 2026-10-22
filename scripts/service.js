#!/usr/bin/env node
'use strict';
// service.js — 可选的后台登录服务(macOS LaunchAgent)与实例识别。
//
// 默认 `status` 只读;install / uninstall **默认都是预览**,真正写盘要 --apply。
// 本工具只碰文件里带 mixrouter-managed 标记的那一份 plist:
//   · 已存在但没有标记 → 拒绝覆盖/删除(可能是用户手写或别的安装方式);
//   · --apply 且 stdin 不是终端 → 必须同时给 --yes,不挂住等输入;
//   · 不执行 launchctl 除非显式 --load / --unload / start / stop / restart。
//
// 用法见 HELP。测试注入 deps(home、spawn、apply 等),不需要真的动 ~/Library。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const paths = require('../lib/paths');
const sm = require('../lib/service-manager');

const HELP = `用法: node scripts/service.js [status|install|uninstall|start|stop|restart] [选项]

status                 只读:发布目录、current、运行中的实例、登录服务与数据目录(默认)
install                生成/更新 LaunchAgent(macOS)。默认只预览;--apply 才写文件
uninstall              删除本工具写入的 LaunchAgent。默认只预览;--apply 才删文件
start | stop | restart 对本工具安装的 login service 执行 launchctl(需要已 install)

  --install-root DIR   安装根,默认 $MIXR_INSTALL_PREFIX 或 ~/.local/share/mixrouter
  --release DIR        指定发布目录;默认 current 指向的那一个
  --data-dir DIR       固定数据目录;默认沿用现有登录服务/RELEASE.json/env
  --label NAME         LaunchAgent Label,默认 com.<用户名>.mixrouter.managed
                       (只接受这个命名空间;install-macos/mixctl 的 com.<用户名>.mixrouter 不接管)
  --node PATH          写进 plist PATH 的 node 路径,默认当前 node
  --port N             代理端口,默认 8787;--ui-port N 控制台端口,默认 8788
  --apply              真正写入/删除 plist
  --yes                非交互确认(--apply 时必需)
  --load               写完立即 launchctl bootstrap + kickstart(默认不执行)
  --unload             删除前先 launchctl bootout(默认不执行)
  --json               状态/计划以 JSON 输出
  -h | --help          显示本帮助

边界:
  · 只管理带 mixrouter-managed 标记的 plist;不会覆盖或删除别人的服务配置。
  · 不会停止不是从目标发布目录启动的进程(PID 复用/别的服务一律拒绝)。
  · 不修改客户端配置,不碰数据目录里的 providers.json 等文件。`;

const fail = (code, message) => Object.assign(new Error(message), { code });
const out = line => console.log(line);

const VALUE_FLAGS = new Set(['--install-root', '--release', '--data-dir', '--label', '--node', '--port', '--ui-port']);
const BOOL_FLAGS = new Set(['--apply', '--yes', '--load', '--unload', '--json', '--help', '-h']);

function parseArgs(argv) {
  const values = { command: 'status' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') { values.help = true; continue; }
    if (BOOL_FLAGS.has(arg)) { values[arg.slice(2) || arg] = true; continue; }
    if (VALUE_FLAGS.has(arg)) {
      const key = arg.slice(2);
      if (values[key] !== undefined) throw fail('invalid_arguments', `${arg} 不能重复`);
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw fail('invalid_arguments', `${arg} 缺少值`);
      values[key] = value;
      continue;
    }
    if (arg.startsWith('-')) throw fail('invalid_arguments', `未知选项:${arg}`);
    positional.push(arg);
  }
  if (values.help) return values;
  if (positional.length > 1) throw fail('invalid_arguments', '只接受一个子命令');
  if (positional.length) values.command = positional[0];
  if (!['status', 'install', 'uninstall', 'start', 'stop', 'restart'].includes(values.command))
    throw fail('invalid_arguments', `未知子命令:${values.command}`);
  for (const key of ['port', 'ui-port']) {
    if (values[key] === undefined) continue;
    if (!/^\d+$/.test(values[key])) throw fail('invalid_arguments', `--${key} 必须是数字`);
    values[key] = Number(values[key]);
  }
  return values;
}

function resolveContext(values, deps = {}) {
  const home = path.resolve(deps.home || values.home || os.homedir());
  const env = deps.env || process.env;
  const installRoot = path.resolve(values['install-root'] || paths.installRoot(env, home));
  const detection = sm.detect({ installRoot, home, env, commandFor: deps.commandFor,
    isAliveImpl: deps.isAliveImpl });
  let releaseDir = null;
  if (values.release) releaseDir = path.resolve(values.release);
  else if (detection.current) releaseDir = path.resolve(detection.current);
  else {
    const latest = detection.releases[detection.releases.length - 1];
    releaseDir = latest ? latest.dir : null;
  }
  if (releaseDir && (!fs.existsSync(releaseDir) || !fs.statSync(releaseDir).isDirectory()))
    throw fail('release_missing', `发布目录不存在:${releaseDir}`);
  const release = releaseDir ? detection.releases.find(item => path.resolve(item.dir) === releaseDir) || {
    dir: releaseDir, name: path.basename(releaseDir),
    version: sm.readPackageVersion(releaseDir), code_revision: require('../lib/runtime-code').codeRevision(releaseDir),
    pid: sm.readPidFile(releaseDir), alive: false, owned: false, manifest: sm.readReleaseManifest(releaseDir),
    current: detection.current ? path.resolve(releaseDir) === path.resolve(detection.current) : false,
  } : null;
  const agents = detection.launchAgents;
  // **只接管自己命名空间里的 plist**。legacy 的 com.<用户>.mixrouter 属于
  // install-macos.sh / 旧 mixctl 那套部署,可能接着别的目录;把它当默认 label 会造成
  // "本工具改写并 bootout 了一个不是它装的服务"。这里它只作为只读信息出现在 status 里。
  const managedAgents = agents.filter(agent => agent.managed);
  const legacyAgents = agents.filter(agent => !agent.managed);
  const preferred = values.label
    ? managedAgents.find(agent => agent.label === values.label) || null
    : managedAgents.find(agent => agent.pinnedRelease && detection.current
        && path.resolve(agent.pinnedRelease) === path.resolve(detection.current))
      || managedAgents[0]
      || null;
  if (values.label) sm.assertManagedLabel(values.label);
  const label = values.label || (preferred && preferred.label) || sm.defaultLabel();
  const dataDir = resolveDataDir({ values, release, preferred, env, home });
  const nodePath = values.node ? path.resolve(values.node) : process.execPath;
  const proxyPort = values.port || envNumber(preferred && preferred.proxyPort) || paths.DEFAULT_PORTS.proxy;
  const uiPort = values['ui-port'] || envNumber(preferred && preferred.uiPort) || paths.DEFAULT_PORTS.ui;
  return { home, env, installRoot, detection, release, releaseDir, preferred, label, dataDir, nodePath, proxyPort, uiPort,
    managedAgents, legacyAgents };
}

function envNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function resolveDataDir({ values, release, preferred, env, home }) {
  const candidates = [];
  if (values['data-dir']) candidates.push({ value: values['data-dir'], source: '--data-dir' });
  if (preferred && preferred.dataDir) candidates.push({ value: preferred.dataDir, source: `plist ${path.basename(preferred.file)}` });
  if (release && release.manifest && release.manifest.data_dir)
    candidates.push({ value: release.manifest.data_dir, source: 'RELEASE.json' });
  if (env.MIXR_DATA_DIR) candidates.push({ value: env.MIXR_DATA_DIR, source: 'MIXR_DATA_DIR' });
  if (!candidates.length) return paths.fixedDataDir(env, home);
  const picked = candidates[0];
  if (!path.isAbsolute(picked.value)) throw fail('invalid_data_dir', `数据目录必须是绝对路径:${picked.value}(${picked.source})`);
  return path.resolve(picked.value);
}

function printStatus(context, { json = false } = {}) {
  const { detection, release, dataDir, installRoot, home } = context;
  const running = detection.releases.filter(item => item.alive);
  const agents = detection.launchAgents;
  if (json) {
    out(JSON.stringify({
      install_root: installRoot,
      current: detection.current,
      release: release ? {
        dir: release.dir, version: release.version, code_revision: release.code_revision,
        pid: release.pid, alive: release.alive, owned: release.owned,
      } : null,
      releases: detection.releases.map(item => ({
        dir: item.dir, version: item.version, code_revision: item.code_revision,
        pid: item.pid, alive: item.alive, owned: item.owned, current: item.current,
      })),
      launch_agents: agents.map(agent => ({
        file: agent.file, label: agent.label, managed: agent.managed,
        pinned_release: agent.pinnedRelease, data_dir: agent.dataDir,
      })),
      data_dir: dataDir,
      home,
    }, null, 2));
    return 0;
  }
  out(`安装根:   ${installRoot}`);
  if (detection.current) out(`current:  ${detection.current}`);
  else out('current:  (未建立)');
  if (release) {
    out(`发布目录: ${release.dir}`);
    out(`版本:     ${release.version || '(未知)'}${release.code_revision ? `   代码 ${release.code_revision.slice(0, 12)}` : ''}`);
  } else out('发布目录: (没有可用的发布)');
  out(`数据目录: ${dataDir}`);
  if (!running.length) out('运行中:   无(未发现从发布目录启动的进程)');
  else {
    out(`运行中:   ${running.length} 个`);
    for (const item of running) {
      const owner = item.owned ? '属于该发布目录' : '⚠ 命令行对不上,未确认归属';
      out(`  pid ${item.pid}  ${item.dir}  ${owner}`);
    }
  }
  if (!agents.length) out('登录服务: 未安装');
  else {
    out(`登录服务: ${agents.length} 份`);
    for (const agent of agents) {
      out(`  ${agent.file}`);
      out(`    label ${agent.label || '(缺失)'}   ${agent.managed ? '本工具托管' : '⚠ 非本工具(只读,不接管)'}`);
      if (agent.pinnedRelease) out(`    指向 ${agent.pinnedRelease}`);
      if (agent.dataDir) out(`    数据 ${agent.dataDir}`);
      if (agent.invalid) out('    ⚠ 无法解析这份 plist');
    }
    if (context.legacyAgents && context.legacyAgents.length) {
      out('');
      out('提醒: 上面标"非本工具"的 plist 由 install-macos.sh / 旧 mixctl 或手工维护;');
      out('      本工具不会改写、删除或接管它们。要把它换成本工具托管的服务,先按原方式停用它,');
      out('      再运行 node scripts/service.js install --apply --yes。');
    }
  }
  const stale = agents.filter(agent => agent.managed && agent.pinnedRelease
    && detection.current && path.resolve(agent.pinnedRelease) !== path.resolve(detection.current));
  if (stale.length) {
    out('');
    out('提醒: 登录服务写死的是旧发布目录,current 已经换了。要让服务跟到 current:');
    out(`  node scripts/service.js install --release ${detection.current} --apply --yes --load`);
  }
  return 0;
}

function printPlan(plan) {
  out(`plist:  ${plan.plistPath}`);
  out(`action: ${plan.action}`);
  if (plan.action === 'blocked') for (const line of plan.warnings) out(`  ⚠ ${line}`);
  if (plan.action === 'unchanged') out('  内容与现有文件一致,不会重写');
  if (plan.action === 'update') out('  将覆盖并先备份原文件');
  if (plan.action === 'create') out('  将新建');
}

function confirm(question, { yes = false, isTTY = process.stdin.isTTY, readSync = fs.readSync } = {}) {
  if (yes) return true;
  if (!isTTY) return false;
  process.stdout.write(`${question}[y/N] `);
  const buffer = Buffer.alloc(16);
  let answer = '';
  try {
    const n = readSync(0, buffer, 0, buffer.length, null);
    answer = buffer.slice(0, n).toString('utf8').trim();
  } catch { answer = ''; }
  return /^(y|yes)$/i.test(answer);
}

function defaultLaunchctl(args, { spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl('launchctl', args, { encoding: 'utf8', timeout: 30000 });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function uidOf(deps = {}) {
  if (Number.isInteger(deps.uid)) return deps.uid;
  try { return process.getuid(); } catch { return null; }
}

function launchctlFor(context, args, deps) {
  const run = deps.launchctl || defaultLaunchctl;
  return run(args, { spawnSyncImpl: deps.spawnSyncImpl });
}

function serviceDomain(deps) {
  const uid = uidOf(deps);
  if (uid === null) throw fail('unsupported_platform', '取不到当前 uid,无法操作 LaunchAgent');
  return `gui/${uid}`;
}

function bootstrap(context, deps) {
  const domain = serviceDomain(deps);
  const boot = launchctlFor(context, ['bootstrap', domain, context.plan.plistPath], deps);
  // 无论 bootstrap 返回什么,都再 kickstart 一次:已装载时 bootstrap 可能报
  // EEXIST/"already bootstrapped",而这时 kickstart -k 才是让它重读配置的动作。
  // 只有 kickstart 也失败才算启动失败,并在错误里同时带上两条输出。
  const kick = launchctlFor(context, ['kickstart', '-k', `${domain}/${context.label}`], deps);
  if (kick.ok) return kick;
  return {
    ok: false,
    status: kick.status,
    stdout: kick.stdout,
    stderr: [boot.ok ? '' : `bootstrap: ${boot.stderr || boot.stdout || `exit ${boot.status}`}`,
      `kickstart: ${kick.stderr || kick.stdout || `exit ${kick.status}`}`].filter(Boolean).join('; '),
  };
}

function runInstall(values, deps) {
  const context = resolveContext(values, deps);
  if (!context.releaseDir) {
    out('没有可安装的发布目录。先用 scripts/install-macos.sh --apply --yes 安装一份,或传 --release <目录>。');
    return 1;
  }
  const darwin = process.platform === 'darwin' || deps.forcePlatform;
  if (!darwin && values.apply) {
    out('登录服务只支持 macOS(LaunchAgent)。当前平台不能写入或装载;预览仍可查看将要生成的内容。');
    return 1;
  }
  const plan = sm.planInstall({
    home: context.home, label: context.label, releaseDir: context.releaseDir,
    dataDir: context.dataDir, nodePath: context.nodePath,
    proxyPort: context.proxyPort, uiPort: context.uiPort,
    logDir: path.join(context.dataDir, 'logs'),
  });
  context.plan = plan;
  if (values.json) out(JSON.stringify({ plist: plan.plistPath, action: plan.action, warnings: plan.warnings }, null, 2));
  else {
    printPlan(plan);
    out('');
    out('将写入(预览):');
    out(plan.content.split('\n').map(line => `  ${line}`).join('\n'));
  }
  if (!values.apply) {
    out('');
    out('预览结束,没有写入任何文件。确认后加 --apply --yes;要立即装载再加 --load。');
    return 0;
  }
  if (!confirm(`把上面的登录服务配置写入 ${plan.plistPath}?`, { yes: values.yes, isTTY: deps.isTTY, readSync: deps.readSync })) {
    out('已取消,没有写入任何文件。');
    return 1;
  }
  try {
    const applied = sm.applyInstall(plan, { now: deps.now ? deps.now() : new Date(), pid: deps.pid });
    out(applied.written ? `已写入 ${applied.plistPath}` : `内容一致,未重写 ${applied.plistPath}`);
    if (applied.backup) out(`原文件已备份到 ${applied.backup}`);
  } catch (e) {
    out(`写入失败:${e.message}`);
    return 1;
  }
  if (values.load) {
    const result = bootstrap(context, deps);
    if (!result.ok) {
      out(`launchctl 装载失败(exit ${result.status}):${result.stderr || result.stdout || '无输出'}`);
      out(`配置已写入;可稍后手工执行: launchctl bootstrap ${serviceDomain(deps)} ${plan.plistPath}`);
      return 1;
    }
    out(`已装载并启动 ${context.label}`);
  } else {
    out('');
    out(darwin
      ? '配置已写入,但**没有**执行任何 launchctl 命令。装载与启动:'
      : '以上是配置内容;非 macOS 平台不会装载 LaunchAgent。');
    if (darwin) {
      out(`  launchctl bootstrap ${serviceDomain(deps)} ${plan.plistPath}`);
      out(`  launchctl kickstart -k ${serviceDomain(deps)}/${context.label}`);
    }
  }
  return 0;
}

function runUninstall(values, deps) {
  const context = resolveContext(values, deps);
  if (process.platform !== 'darwin' && !deps.forcePlatform && values.apply) {
    out('登录服务只支持 macOS(LaunchAgent)。当前平台不能删除或卸载;预览仍可查看计划。');
    return 1;
  }
  const plan = sm.planUninstall({ home: context.home, label: context.label });
  if (values.json) out(JSON.stringify({ plist: plan.plistPath, action: plan.action, warnings: plan.warnings }, null, 2));
  else {
    out(`plist:  ${plan.plistPath}`);
    out(`action: ${plan.action}`);
    for (const line of plan.warnings) out(`  ⚠ ${line}`);
  }
  if (!values.apply) {
    out('');
    out('预览结束,没有删除任何文件。确认后加 --apply --yes。');
    return plan.action === 'blocked' ? 1 : 0;
  }
  if (plan.action === 'blocked') { out('拒绝删除:这份 plist 不是本工具写入的。'); return 1; }
  if (plan.action === 'missing') { out('没有找到要删除的 plist。'); return 0; }
  if (!values.yes && !deps.isTTY) { out('非交互环境下 --apply 需要同时给 --yes。已中止,未删除任何文件。'); return 1; }
  if (!confirm(`删除 ${plan.plistPath}?`, { yes: values.yes, isTTY: deps.isTTY, readSync: deps.readSync })) {
    out('已取消,没有删除任何文件。');
    return 1;
  }
  if (values.unload) {
    const result = launchctlFor(context, ['bootout', `${serviceDomain(deps)}/${context.label}`], deps);
    if (!result.ok) out(`launchctl bootout 返回非 0(继续删除文件):${result.stderr || result.stdout || '无输出'}`);
    else out(`已卸载 ${context.label}`);
  }
  const applied = sm.applyUninstall(plan, { now: deps.now ? deps.now() : new Date() });
  out(`已删除 ${applied.plistPath}`);
  if (applied.backup) out(`删除前已备份到 ${applied.backup}`);
  return 0;
}

function requireManagedPlan(context, deps) {
  const plan = sm.planUninstall({ home: context.home, label: context.label });
  if (plan.action === 'missing') {
    out(`没有找到 ${plan.plistPath};先执行 node scripts/service.js install --apply --yes。`);
    return null;
  }
  if (plan.action === 'blocked') {
    out(`拒绝操作:${plan.plistPath} 不是本工具写入的。`);
    return null;
  }
  context.plan = { plistPath: plan.plistPath };
  return plan;
}

function runStart(values, deps) {
  const context = resolveContext(values, deps);
  if (!requireManagedPlan(context, deps)) return 1;
  const result = bootstrap(context, deps);
  if (!result.ok) { out(`启动失败:${result.stderr || result.stdout || `exit ${result.status}`}`); return 1; }
  out(`已启动 ${context.label}`);
  return 0;
}

function runStop(values, deps) {
  const context = resolveContext(values, deps);
  if (!requireManagedPlan(context, deps)) return 1;
  // KeepAlive 会让 launchd 把进程拉回来;真正的"停"是 bootout(卸载),不是 kill。
  const result = launchctlFor(context, ['bootout', `${serviceDomain(deps)}/${context.label}`], deps);
  if (!result.ok) { out(`停止失败:${result.stderr || result.stdout || `exit ${result.status}`}`); return 1; }
  out(`已停止并卸载 ${context.label}(再启动用 service.js start)`);
  return 0;
}

function runRestart(values, deps) {
  const context = resolveContext(values, deps);
  if (!requireManagedPlan(context, deps)) return 1;
  launchctlFor(context, ['bootout', `${serviceDomain(deps)}/${context.label}`], deps);
  const result = bootstrap(context, deps);
  if (!result.ok) { out(`重启失败:${result.stderr || result.stdout || `exit ${result.status}`}`); return 1; }
  out(`已重启 ${context.label}`);
  return 0;
}

function run(argv = process.argv.slice(2), deps = {}) {
  let values;
  try { values = parseArgs(argv); }
  catch (e) { console.error(`${e.message}\n\n${HELP}`); return 2; }
  if (values.help) { out(HELP); return 0; }
  try {
    if (values.command === 'status') {
      const context = resolveContext(values, deps);
      return printStatus(context, { json: values.json });
    }
    if (values.command === 'install') return runInstall(values, deps);
    if (values.command === 'uninstall') return runUninstall(values, deps);
    if (process.platform !== 'darwin' && !deps.forcePlatform) {
      out('launchctl 只存在于 macOS;当前平台不支持登录服务操作。');
      return 1;
    }
    if (values.command === 'start') return runStart(values, deps);
    if (values.command === 'stop') return runStop(values, deps);
    if (values.command === 'restart') return runRestart(values, deps);
    return 2;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}

if (require.main === module) process.exitCode = run();

module.exports = { HELP, parseArgs, resolveContext, printStatus, run, confirm, resolveDataDir };
