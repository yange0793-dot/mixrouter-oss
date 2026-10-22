#!/usr/bin/env node
'use strict';
// upgrade-release.js — 受控升级:校验官方 release → 停服务 → 装新目录 → 切 current →
// 启动并核对源码指纹;任何一步失败都切回旧 current 并尝试恢复旧服务。
//
// 默认**只预览**,不联网、不写文件。要执行必须同时给 --apply --yes。
// 联网也必须是显式的:--version <v> --download(或 --archive 本地离线包)。
//
// 为什么不用 `mixctl start` 来拉起升级后的服务:mixctl 在本机存在 *.mixrouter.plist 时
// 会去 kickstart 那个 label。升级工具无法确认那个 label 属于本次切换的发布目录,盲目
// 走它就可能把另一个版本/另一份数据拉起来。所以这里只走两条明确的路:
//   · 托管登录服务(--update-login-service):重写我们自己的 plist,再 bootout/bootstrap;
//   · 无登录服务:直接派生 node <release>/mixrouter.js,并把 pid 写进该发布目录的 .run/。
//
// 数据目录只读检查,不写、不迁移、不备份(备份是用户的动作,工具不替他决定)。

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const paths = require('../lib/paths');
const sm = require('../lib/service-manager');
const ru = require('../lib/release-update');
const { codeRevision } = require('../lib/runtime-code');

const HELP = `用法: node scripts/upgrade-release.js [选项]

默认只预览:不联网、不写文件、不动服务。执行需要 --apply --yes。

来源(二选一;都不给则只显示本机状态):
  --archive PATH       本地官方 release 包(.tar.gz)。默认要求同目录 .sha256 校验和
  --sha256 HEX         没有 .sha256 文件时显式给出校验和(不推荐)
  --release-info PATH  RELEASE-INFO.json 附件(可选;没有则用包内文件现算指纹)
  --version vX.Y.Z     目标版本。配合 --download 才联网查询/下载
  --download           显式允许访问官方 GitHub Releases(固定仓库,不跟重定向到别的主机)

安装与运行:
  --install-root DIR   安装根,默认 $MIXR_INSTALL_PREFIX 或 ~/.local/share/mixrouter
  --data-dir DIR       固定数据目录;默认沿用登录服务/RELEASE.json/env
  --release-name NAME  新发布目录名,默认 <version>-<源码指纹前 8 位>
  --port N             代理端口,默认 8787;--ui-port N 控制台端口,默认 8788
  --label NAME         托管登录服务的 Label(默认取现有托管 plist 或 com.<用户名>.mixrouter.managed)
  --update-login-service
                       本次升级同时重写并重载带 mixrouter-managed 标记的登录服务
  --no-start           只切换代码,不启动、不验证服务(会明确提示未验证)
  --allow-same         允许安装与当前相同的版本
  --drain-timeout MS   等排空/等进程退出的上限,默认 30000;排空超时即中止升级
  --start-timeout MS   启动后核对源码指纹的上限,默认 30000
  --keep               保留本次下载/解包的临时目录

回退:
  --rollback-to DIR    切回一个已存在的旧发布目录(同样默认预览,--apply --yes 执行)

  --apply              真正执行
  --yes                非交互确认(--apply 时必需)
  -h | --help          显示本帮助

边界:
  · 只从 ${ru.OFFICIAL.owner}/${ru.OFFICIAL.repo} 的 Release 获取;每一跳重定向都校验 HTTPS 与主机。
  · 只安装通过 sha256 + 解包路径检查 + 制品清单 + 版本三处一致的包。
  · 数据目录只读;不覆盖、不迁移、不删除。
  · 不停止命令行不属于目标发布目录的进程;不改写没有 mixrouter-managed 标记的 plist。`;

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const VALUE_FLAGS = new Set([
  '--archive', '--sha256', '--release-info', '--version', '--install-root', '--data-dir',
  '--release-name', '--port', '--ui-port', '--label', '--drain-timeout', '--start-timeout',
  '--rollback-to',
]);
const BOOL_FLAGS = new Set([
  '--download', '--update-login-service', '--no-start', '--allow-same',
  '--keep', '--apply', '--yes', '--help', '-h',
]);
const MAX_DRAIN_MS = 300000;

function parseArgs(argv) {
  const values = {};
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
    if (arg === '--force-kill' || arg === '--force')
      throw fail('invalid_arguments',
        `--${arg.slice(2)} 已移除:升级不会为了让流程"成功"而绕过安全检查。`
          + '排空/退出超时会中止升级(不打断在途请求);数据文件解析失败必须先人工处理,'
          + '不接受"跳过继续"');
    if (arg.startsWith('-')) throw fail('invalid_arguments', `未知选项:${arg}(没有 --repo / --url;来源固定为官方 Release)`);
    throw fail('invalid_arguments', `不接受位置参数:${arg}`);
  }
  if (values.sha256 !== undefined && !/^[0-9a-fA-F]{64}$/.test(values.sha256))
    throw fail('invalid_arguments', '--sha256 必须是 64 位十六进制');
  for (const key of ['port', 'ui-port', 'drain-timeout', 'start-timeout']) {
    if (values[key] === undefined) continue;
    if (!/^\d+$/.test(values[key])) throw fail('invalid_arguments', `--${key} 必须是整数`);
    values[key] = Number(values[key]);
  }
  for (const key of ['port', 'ui-port']) {
    if (values[key] === undefined) continue;
    if (values[key] < 1 || values[key] > 65535) throw fail('invalid_arguments', `--${key} 必须在 1–65535`);
  }
  if (values.port !== undefined && values.port === values['ui-port'])
    throw fail('invalid_arguments', '代理端口与控制台端口不能相同');
  for (const key of ['drain-timeout', 'start-timeout']) {
    if (values[key] === undefined) continue;
    if (values[key] < 1000 || values[key] > MAX_DRAIN_MS)
      throw fail('invalid_arguments', `--${key} 应在 1000–${MAX_DRAIN_MS}`);
  }
  if (values.archive && values.version && values.download)
    throw fail('invalid_arguments', '--archive 与 --download 不能同时使用');
  if (values['rollback-to'] && (values.archive || values.download))
    throw fail('invalid_arguments', '--rollback-to 与安装来源互斥');
  return values;
}

// ---------------------------------------------------------------- 本机状态
function resolveInstallRoot(values, { env, home }) {
  const raw = values['install-root'] || paths.installRoot(env, home);
  if (!path.isAbsolute(raw)) throw fail('invalid_install_root', `安装根必须是绝对路径:${raw}`);
  return path.resolve(raw);
}

function resolveDataDir({ values, detection, currentDir, env, home }) {
  const candidates = [];
  if (values['data-dir']) candidates.push({ dir: values['data-dir'], source: '--data-dir' });
  for (const agent of detection.launchAgents) {
    const pinnedIsCurrent = !!(agent.pinnedRelease && currentDir
      && path.resolve(agent.pinnedRelease) === path.resolve(currentDir));
    if (agent.managed || pinnedIsCurrent)
      if (agent.dataDir) candidates.push({ dir: agent.dataDir, source: `plist ${path.basename(agent.file)}` });
  }
  if (currentDir) {
    const manifestInfo = sm.readReleaseManifest(currentDir);
    if (manifestInfo && manifestInfo.data_dir) candidates.push({ dir: manifestInfo.data_dir, source: 'RELEASE.json' });
  }
  if (env.MIXR_DATA_DIR) candidates.push({ dir: env.MIXR_DATA_DIR, source: 'MIXR_DATA_DIR' });
  if (!candidates.length) return { dir: paths.fixedDataDir(env, home), source: '默认固定目录', warnings: [] };
  const picked = candidates[0];
  if (!path.isAbsolute(picked.dir)) throw fail('invalid_data_dir', `数据目录必须是绝对路径:${picked.dir}(${picked.source})`);
  const warnings = [];
  const resolved = path.resolve(picked.dir);
  for (const other of candidates.slice(1)) {
    if (path.isAbsolute(other.dir) && path.resolve(other.dir) !== resolved)
      warnings.push(`数据目录来源不一致:采用 ${resolved}(${picked.source}),忽略 ${other.dir}(${other.source})`);
  }
  return { dir: resolved, source: picked.source, warnings };
}

function loginServiceInfo(detection, currentDir, values) {
  const agents = detection.launchAgents;
  const legacy = agents.filter(item => !item.managed);
  const managed = agents.filter(item => item.managed);
  // 只在我们自己的命名空间里选"可更新"的那一份。legacy(install-macos/mixctl)不属于
  // 本工具,它只可能作为**阻断条件**出现,绝不会成为待改写的目标。
  const agent = (values.label ? managed.find(item => item.label === values.label) : null)
    || managed.find(item => item.pinnedRelease && currentDir
      && path.resolve(item.pinnedRelease) === path.resolve(currentDir))
    || managed[0]
    || null;
  if (!agent) {
    // 没有托管服务:只有 legacy 指向当前目录时才阻断(升级后它仍会拉起旧代码)。
    const stuck = legacy.find(item => item.pinnedRelease && currentDir
      && path.resolve(item.pinnedRelease) === path.resolve(currentDir));
    if (stuck)
      return {
        present: true, agent: stuck, needsUpdate: false,
        label: values.label || sm.defaultLabel(), legacyOnly: true,
        blocking: `${stuck.file} 由 install-macos.sh / 旧 mixctl 或手工维护,但它指向当前发布目录;`
          + '升级后它仍会拉起旧代码。本工具不会接管这份服务:请先按原方式停用/更新它,'
          + '或改用 node scripts/service.js install --apply --yes 生成托管配置',
      };
    return { present: false, agent: null, needsUpdate: false, label: values.label || sm.defaultLabel() };
  }
  if (values.label) sm.assertManagedLabel(values.label);
  const label = values.label || agent.label || sm.defaultLabel();
  if (agent.invalid) return { present: true, agent, needsUpdate: false, label, blocking: '现有 plist 无法解析' };
  const pinned = agent.pinnedRelease;
  const pinnedIsCurrent = !!(pinned && currentDir && path.resolve(pinned) === path.resolve(currentDir));
  if (agent.managed && pinned && !pinnedIsCurrent)
    return {
      present: true, agent, needsUpdate: false, label,
      blocking: `托管登录服务 ${agent.file} 指向 ${pinned},不是当前发布目录 ${currentDir || '(无)'}。`
        + '先确认那是哪一份安装;本工具不会在升级时改写属于另一条部署的服务',
    };
  return {
    present: true, agent, needsUpdate: agent.managed && (pinnedIsCurrent || !pinned),
    label, blocking: null,
    pinnedIsCurrent,
    managed: agent.managed,
  };
}

function buildLocalPlan(values, deps = {}) {
  const home = deps.home || os.homedir();
  const env = deps.env || process.env;
  const installRoot = resolveInstallRoot(values, { env, home });
  const detection = sm.detect({ installRoot, home, env, commandFor: deps.commandFor,
    isAliveImpl: deps.isAliveImpl, processStartFor: deps.processStartFor });
  const currentDir = detection.current;
  const currentVersion = currentDir ? sm.readPackageVersion(currentDir) : null;
  if (currentDir && !currentVersion)
    throw fail('current_invalid', `current 指向 ${currentDir},但那里没有可读的 package.json;拒绝在状态不明时升级。`
      + '先核对 current 指向,或按 docs/upgrade-and-rollback.md 手工处理');
  const data = resolveDataDir({ values, detection, currentDir, env, home });
  const login = loginServiceInfo(detection, currentDir, values);
  const live = detection.releases.filter(item => item.alive);
  const currentInstance = live.find(item => currentDir && path.resolve(item.dir) === path.resolve(currentDir)) || null;
  const foreign = live.filter(item => !currentDir || path.resolve(item.dir) !== path.resolve(currentDir));
  return {
    values, home, env, installRoot, releaseRoot: path.join(installRoot, 'releases'),
    detection, currentDir, currentVersion, currentInstance, foreign,
    dataDir: data.dir, dataDirSource: data.source, dataWarnings: data.warnings,
    login, label: login.label,
    proxyPort: values.port || envNumber(env.MIXROUTER_PORT) || paths.DEFAULT_PORTS.proxy,
    uiPort: values['ui-port'] || envNumber(env.MIXUI_PORT) || paths.DEFAULT_PORTS.ui,
    warnings: [],
  };
}

function envNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function printLocal(plan) {
  console.log(`安装根:   ${plan.installRoot}`);
  console.log(`current:  ${plan.currentDir || '(未建立)'}`);
  console.log(`当前版本: ${plan.currentVersion || '(未安装)'}`);
  console.log(`数据目录: ${plan.dataDir}(${plan.dataDirSource})`);
  if (!plan.detection.launchAgents.length) console.log('登录服务: 未安装');
  else for (const agent of plan.detection.launchAgents) {
    console.log(`登录服务: ${agent.file}${agent.managed ? '' : '(无 marker,只读)'}`);
    if (agent.pinnedRelease) console.log(`          指向 ${agent.pinnedRelease}`);
  }
}

// ---------------------------------------------------------------- 来源
function archiveSidecar(archive) {
  return `${archive}.sha256`;
}

function releaseInfoSibling(archive) {
  return archive.replace(/\.tar\.gz$/i, '') + '.RELEASE-INFO.json';
}

async function acquireArchive(plan, deps) {
  const values = plan.values;
  let tempRoot = null;
  const makeTemp = () => {
    if (!tempRoot) tempRoot = fs.mkdtempSync(path.join(deps.tmpdir || os.tmpdir(), 'mixr-upgrade-'));
    return tempRoot;
  };
  if (values.archive) {
    const archive = path.resolve(values.archive);
    if (!fs.existsSync(archive)) throw fail('archive_missing', `压缩包不存在:${archive}`);
    const archiveName = path.basename(archive);
    let sha = values.sha256 ? String(values.sha256).toLowerCase() : null;
    let shaSource = sha ? '--sha256' : null;
    const sidecar = archiveSidecar(archive);
    if (fs.existsSync(sidecar)) {
      const fromFile = ru.parseSha256(fs.readFileSync(sidecar, 'utf8'), archiveName);
      if (sha && sha !== fromFile)
        throw fail('checksum_mismatch', `--sha256 与 ${path.basename(sidecar)} 不一致`);
      sha = fromFile;
      shaSource = path.basename(sidecar);
    }
    if (!sha)
      throw fail('checksum_required', `缺少校验和:${sidecar} 不存在,且没有 --sha256。没有校验和就不安装(这不是可跳过的步骤)`);
    const actual = await ru.sha256File(archive);
    if (actual !== sha) throw fail('sha256_mismatch', `压缩包校验失败:期望 ${sha},实得 ${actual}`);
    let infoPath = values['release-info'] ? path.resolve(values['release-info']) : null;
    if (!infoPath && fs.existsSync(releaseInfoSibling(archive))) infoPath = releaseInfoSibling(archive);
    if (infoPath && !fs.existsSync(infoPath)) throw fail('release_info_missing', `RELEASE-INFO 不存在:${infoPath}`);
    return { archive, sha256: sha, shaSource, releaseInfoPath: infoPath, tempRoot,
      source: `本地归档 ${archive}`, versionSource: '包内 package.json' };
  }

  // 远程:只有 --download 才走到这里
  if (!values.download)
    throw fail('download_required', `要从官方 Release 获取 ${values.version || '最新版本'},必须显式加 --download;离线请用 --archive <文件>`);
  const fetchReleaseImpl = deps.fetchRelease || ru.fetchRelease;
  const release = await fetchReleaseImpl(values.version, {
    transport: deps.transport,
    timeoutMs: deps.timeoutMs || ru.DEFAULT_TIMEOUT_MS,
    maxArchiveBytes: ru.DEFAULT_MAX_ARCHIVE_BYTES,
  });
  const assets = release.assets;
  const dir = makeTemp();
  const shaText = await (deps.fetchText || ru.fetchText)(assets.sha256.browser_download_url, {
    transport: deps.transport, timeoutMs: deps.timeoutMs || ru.DEFAULT_TIMEOUT_MS,
  });
  const expected = ru.parseSha256(shaText, assets.names.archive);
  const digest = String(assets.archive.digest || '');
  if (digest.startsWith('sha256:') && digest.slice(7).toLowerCase() !== expected)
    throw fail('checksum_mismatch', `GitHub digest(${digest.slice(0, 19)}…)与 .sha256 附件不一致`);
  const archive = path.join(dir, assets.names.archive);
  const download = await (deps.downloadAsset || ru.downloadAsset)({
    url: assets.archive.browser_download_url, dest: archive, expectedSha256: expected,
    maxBytes: ru.DEFAULT_MAX_ARCHIVE_BYTES, transport: deps.transport,
    timeoutMs: deps.timeoutMs || ru.DEFAULT_TIMEOUT_MS,
  });
  let releaseInfoPath = null;
  if (assets.releaseInfo) {
    releaseInfoPath = path.join(dir, assets.names.releaseInfo);
    await (deps.downloadAsset || ru.downloadAsset)({
      url: assets.releaseInfo.browser_download_url, dest: releaseInfoPath,
      maxBytes: ru.DEFAULT_MAX_JSON_BYTES, transport: deps.transport,
      timeoutMs: deps.timeoutMs || ru.DEFAULT_TIMEOUT_MS,
    });
  }
  return { archive, sha256: download.sha256, shaSource: assets.names.sha256,
    releaseInfoPath, tempRoot, source: `官方 Release ${release.tag}`, versionSource: 'Release tag',
    release };
}

// ---------------------------------------------------------------- 计划
async function buildPlan(values, deps = {}) {
  const plan = buildLocalPlan(values, deps);
  if (values['rollback-to']) return buildRollbackPlan(plan, deps);
  if (!values.archive && !values.download) {
    if (values.version)
      throw fail('download_required', `要从官方 Release 获取 ${values.version},必须显式加 --download;离线请用 --archive <文件>`);
    return { ...plan, mode: 'status', apply: !!values.apply, confirmed: !!values.yes };
  }
  if (plan.foreign.length) {
    throw fail('foreign_instance',
      `发现不属于 current 的运行实例,拒绝升级:\n${plan.foreign.map(item => `  pid ${item.pid} ${item.dir}`).join('\n')}`
        + '\n先确认并停止它,或核对 --install-root 是否指对了安装根');
  }
  if (plan.currentDir) {
    try { ru.assertDirInside(plan.currentDir, plan.releaseRoot); }
    catch {
      throw fail('current_outside',
        `current 指向 ${plan.currentDir},不在本次安装根 ${plan.releaseRoot} 之下;`
          + '本工具无法保证回退到该目录。用 --install-root 指向正确的安装根,或先人工核对 current');
    }
  }
  if (plan.login.blocking) throw fail('login_service_blocked', plan.login.blocking);
  if (plan.login.needsUpdate && !values['update-login-service']) {
    throw fail('login_service_not_updated',
      `登录服务 ${plan.login.agent.file} 指向当前发布目录;不更新它,升级后服务仍会拉起旧代码。\n`
        + '请加 --update-login-service(仅对带 mixrouter-managed 标记的 plist 生效),'
        + '或先按你原来的方式停用该服务');
  }

  const acquired = await acquireArchive(plan, deps);
  // 在线下载时 tempRoot 里还有 tarball 与附件;离线时只解包到临时目录。
  // 两种都要有一个可清理的根,否则预览会在 TMPDIR 里留下解包副本。
  const extractRoot = acquired.tempRoot
    ? path.join(acquired.tempRoot, 'extracted')
    : fs.mkdtempSync(path.join(deps.tmpdir || os.tmpdir(), 'mixr-upgrade-extract-'));
  const cleanupRoot = acquired.tempRoot || extractRoot;
  const extractedDir = path.join(extractRoot, 'release');
  const extract = deps.extractArchive || ru.extractArchive;
  extract({ archive: acquired.archive, dest: extractedDir });
  const verified = ru.verifyReleaseDir({
    dir: extractedDir,
    expectedVersion: values.version,
    releaseInfoPath: acquired.releaseInfoPath,
  });
  const current = plan.currentVersion;
  const pkg = JSON.parse(fs.readFileSync(path.join(extractedDir, 'package.json'), 'utf8'));
  const compatibility = ru.checkUpgradeCompatibility({
    currentVersion: current, targetVersion: verified.version,
    targetEngines: pkg.engines, nodeVersion: deps.nodeVersion || process.versions.node,
    allowSame: !!values['allow-same'],
  });
  const dataInspection = ru.inspectDataDir(plan.dataDir);
  // 没有 --force:数据目录解析失败就是要人先看一眼。升级工具不改写数据,
  // 但"跳过检查继续装"会让一次坏配置在换版本时变成两个问题叠在一起。
  if (dataInspection.errors.length)
    throw fail('data_dir_invalid',
      `数据目录 ${plan.dataDir} 有无法解析的文件:\n${dataInspection.errors.map(line => `  ${line}`).join('\n')}`
        + '\n先备份并人工检查或修复;本工具不会替你改写数据,也不提供跳过该检查的开关');
  const releaseName = values['release-name'] || ru.releaseNameFor(verified.version, verified.code_revision);
  ru.assertReleaseName(releaseName);
  const targetDir = path.join(plan.releaseRoot, releaseName);
  if (fs.existsSync(targetDir))
    throw fail('release_exists', `发布目录已存在:${targetDir}(发布目录不可变,不覆盖;换 --release-name 或先人工确认)`);

  const warnings = [...plan.warnings];
  for (const line of compatibility.warnings) warnings.push(line);
  for (const line of verified.warnings) warnings.push(line);
  for (const line of plan.dataWarnings) warnings.push(line);
  return {
    ...plan,
    mode: 'upgrade',
    apply: !!values.apply,
    confirmed: !!values.yes,
    source: acquired.source,
    archive: acquired.archive,
    sha256: acquired.sha256,
    shaSource: acquired.shaSource,
    tempRoot: cleanupRoot,
    extractedDir,
    releaseName,
    targetDir,
    target: verified,
    compatibility,
    dataInspection,
    warnings,
  };
}

function buildRollbackPlan(plan, deps = {}) {
  const values = plan.values;
  if (plan.login.blocking) throw fail('login_service_blocked', plan.login.blocking);
  const targetDir = path.resolve(values['rollback-to']);
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory())
    throw fail('rollback_target_missing', `回退目标不存在或不是目录:${targetDir}`);
  ru.assertDirInside(targetDir, plan.releaseRoot);
  const targetVersion = sm.readPackageVersion(targetDir);
  if (!targetVersion) throw fail('rollback_target_invalid', `回退目标里没有可读的 package.json:${targetDir}`);
  const checked = ru.verifyInstalledReleaseDir(targetDir);
  if (plan.currentDir && path.resolve(plan.currentDir) === targetDir)
    throw fail('rollback_same', '回退目标就是当前发布目录');
  return {
    ...plan,
    mode: 'rollback',
    apply: !!values.apply,
    confirmed: !!values.yes,
    source: `本地发布目录 ${targetDir}`,
    releaseName: path.basename(targetDir),
    targetDir,
    target: { version: checked.version, code_revision: checked.code_revision, warnings: [] },
    warnings: [...plan.warnings, ...plan.dataWarnings],
    compatibility: { from: plan.currentVersion, to: targetVersion, rollback: true },
  };
}

// ---------------------------------------------------------------- 预览
function printPlan(plan) {
  printLocal(plan);
  console.log('');
  console.log(plan.mode === 'rollback'
    ? `回退:     ${plan.currentDir || '(无)'} → ${plan.targetDir}`
    : `升级:     ${plan.currentVersion || '(全新安装)'} → ${plan.target.version}`);
  if (plan.mode === 'upgrade') {
    console.log(`来源:     ${plan.source}`);
    console.log(`校验和:   ${plan.sha256.slice(0, 16)}… (${plan.shaSource})`);
    console.log(`源码指纹: ${plan.target.code_revision.slice(0, 16)}…`);
    console.log(`制品文件: ${plan.target.files} 个`);
    console.log(`新发布:   ${plan.targetDir}`);
  }
  console.log(`数据目录: ${plan.dataDir}(${plan.dataDirSource}) — 只读检查,不会写入`);
  if (plan.dataInspection && plan.dataInspection.files.length)
    console.log(`数据文件: ${plan.dataInspection.files.map(item => item.name).join(', ')}`);
  if (plan.currentInstance) {
    console.log(`当前实例: pid ${plan.currentInstance.pid}  ${plan.currentInstance.owned ? '确认属于当前发布目录' : '⚠ 命令行对不上'}`);
  }
  if (plan.login.present) {
    console.log(`登录服务: ${plan.login.agent.file}`);
    console.log(`          ${plan.login.needsUpdate ? '将重写并重载' : '不更新(升级后请自行确认)'}`);
  }
  for (const line of plan.warnings) console.log(`提醒: ${line}`);
  console.log('');
  console.log('执行步骤:');
  if (plan.currentInstance || (plan.login.present && plan.login.needsUpdate))
    console.log('  1) 等待在途请求并停止当前服务(只停确认属于当前发布目录的进程)');
  else console.log('  1) 当前没有运行中的实例,跳过停止');
  console.log(`  2) 安装新发布目录并原子切换 current`);
  if (plan.values['no-start']) console.log('  3) --no-start:不启动、不验证(代码已切换)');
  else console.log('  3) 启动并核对服务自报的源码指纹');
  if (plan.currentDir) console.log('  失败时:切回 current 并恢复旧服务,再报告两边结果');
  console.log('');
  console.log('以上只是预览。执行:再加 --apply --yes');
}

// ---------------------------------------------------------------- 探测与启动
function httpJson(port, pathname, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: pathname,
      headers: { Accept: 'application/json' }, timeout: timeoutMs }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { res.destroy(); reject(fail('response_too_large', '探测响应过大')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(fail('http_status', `HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(fail('invalid_json', '探测响应不是 JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(fail('timeout', '探测超时')));
    req.on('error', reject);
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function verifyService(plan, expected, deps = {}) {
  const probe = deps.probeState || (port => httpJson(port, '/api/state'));
  const deadline = Date.now() + (plan.values['start-timeout'] || 30000);
  let last = null;
  while (Date.now() <= deadline) {
    try {
      const state = await probe(plan.uiPort);
      last = state;
      if (state && state.code_revision === expected.code_revision) return { ok: true, state };
      if (state && state.code_revision)
        last = { ...state, mismatch: `源码指纹 ${String(state.code_revision).slice(0, 12)}… ≠ 期望 ${expected.code_revision.slice(0, 12)}…` };
    } catch (e) { last = { error: e.message }; }
    await (deps.sleepImpl || sleep)(500);
  }
  return { ok: false, state: last,
    error: last && last.mismatch ? last.mismatch : `服务未在限定时间内报告期望的源码指纹`
      + (last && last.error ? `(${last.error})` : '') };
}

async function startDetached(plan, releaseDir, deps = {}) {
  const pidFile = path.join(releaseDir, '.run', 'mixrouter.pid');
  fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  const logDir = path.join(plan.dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const log = path.join(logDir, 'server.log');
  const spawnImpl = deps.spawn || spawn;
  const out = fs.openSync(log, 'a', 0o600);
  try {
    const child = spawnImpl(process.execPath, [path.join(releaseDir, 'mixrouter.js')], {
      cwd: releaseDir, detached: true, stdio: ['ignore', out, out],
      env: { ...(plan.env || process.env), MIXR_DATA_DIR: plan.dataDir,
        MIXROUTER_PORT: String(plan.proxyPort), MIXUI_PORT: String(plan.uiPort) },
    });
    child.unref();
    if (!child.pid) throw fail('start_failed', '派生进程没有拿到 pid');
    fs.writeFileSync(pidFile, String(child.pid));
    return { pid: child.pid, log };
  } finally {
    fs.closeSync(out);
  }
}

function launchctlRun(args, deps = {}) {
  const run = deps.launchctl || ((argv, options) => {
    const result = spawnSync('launchctl', argv, { encoding: 'utf8', timeout: 30000 });
    return { ok: result.status === 0, status: result.status,
      stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
  });
  return run(args, options);
}

function uidOf(deps = {}) {
  if (Number.isInteger(deps.uid)) return deps.uid;
  try { return process.getuid(); } catch { return null; }
}

function serviceDomain(deps) {
  const uid = uidOf(deps);
  if (uid === null) throw fail('unsupported_platform', '取不到当前 uid,无法操作 LaunchAgent');
  return `gui/${uid}`;
}

async function startManagedLogin(plan, releaseDir, deps = {}) {
  const install = sm.planInstall({
    home: plan.home, label: plan.label, releaseDir, dataDir: plan.dataDir,
    nodePath: deps.nodePath || process.execPath,
    proxyPort: plan.proxyPort, uiPort: plan.uiPort, logDir: path.join(plan.dataDir, 'logs'),
  });
  if (install.action === 'blocked') throw fail('foreign_plist', install.warnings[0] || '拒绝覆盖非托管 plist');
  const applied = sm.applyInstall(install, { now: deps.now ? deps.now() : new Date() });
  const domain = serviceDomain(deps);
  const boot = launchctlRun(['bootstrap', domain, install.plistPath], deps);
  if (!boot.ok && !/already|EEXIST|37/i.test(boot.stderr || boot.stdout))
    throw fail('launchctl_failed', `launchctl bootstrap 失败:${boot.stderr || boot.stdout || `exit ${boot.status}`}`);
  const kick = launchctlRun(['kickstart', '-k', `${domain}/${plan.label}`], deps);
  if (!kick.ok) throw fail('launchctl_failed', `launchctl kickstart 失败:${kick.stderr || kick.stdout || `exit ${kick.status}`}`);
  return { pid: 0, plist: install.plistPath, backup: applied.backup || null, login: true };
}

async function startService(plan, releaseDir, deps = {}) {
  if (plan.login.present && plan.login.managed) return startManagedLogin(plan, releaseDir, deps);
  // 非托管 plist 指向别的目录时 buildPlan 已经拦截;走到这里的没有登录服务需要处理,
  // 直接派生可以避免 mixctl 看到 *.mixrouter.plist 就去 kickstart 一个不确定的 label。
  return startDetached(plan, releaseDir, deps);
}

// ---------------------------------------------------------------- 停止
// 排空是升级的**前置条件**,不是尽力而为的观察:
//   · 服务在上报 active_requests 时,必须等到它归零才发停止信号;
//   · 持续有新请求进来就能一直不归零 —— 这时正确的结局是**拒绝升级**,
//     不是把在途请求砍掉再宣布成功。砍掉的请求对客户端就是一个断流。
//   · 服务没有上报该字段时(旧版本),看不到就不假装看到:如实说明后
//     交给 SIGTERM 的排空窗口,但同样受超时约束(超时即失败)。
async function waitForDrain(plan, deps = {}) {
  const probe = deps.requestState || (port => httpJson(port, '/api/state'));
  const timeoutMs = plan.values['drain-timeout'] || 30000;
  const result = await sm.waitForDrain({
    uiPort: plan.uiPort, timeoutMs, requestState: probe, sleepImpl: deps.sleepImpl || sleep,
  });
  if (!result.supported) {
    console.log('  在途请求:服务没有上报 active_requests,无法确认归零;交给 SIGTERM 的排空窗口');
    return result;
  }
  if (!result.drained) {
    throw fail('drain_timeout',
      `${timeoutMs}ms 内仍有 ${result.active} 个在途请求,升级已中止(未停止服务、未切换代码、未打断任何请求)。`
        + '持续的新请求会让计数一直不归零;请在客户端空闲时重试,或加大 --drain-timeout');
  }
  console.log('  在途请求:已排空');
  return result;
}

async function stopForUpgrade(plan, deps = {}) {
  const stopped = [];
  const releaseDir = plan.currentDir;
  const pid = plan.currentInstance ? plan.currentInstance.pid : (releaseDir ? sm.readPidFile(releaseDir) : 0);
  const isAliveImpl = deps.isAliveImpl || sm.isAlive;
  const alive = pid && isAliveImpl(pid);
  let drainState = null;
  if (alive) {
    if (releaseDir && !plan.currentInstance) {
      const owned = sm.pidBelongsTo(pid, releaseDir, { commandFor: deps.commandFor,
        processStartFor: deps.processStartFor });
      if (!owned) throw fail('not_owned', `pid ${pid} 不能确认属于 ${releaseDir},拒绝停止`);
    }
    // 先观察在途请求,再发停止信号。顺序反了就只能看到"服务已经没了"。
    const drain = await waitForDrain(plan, deps);
    drainState = drain && drain.lastState ? drain.lastState : null;
  }
  if (plan.login.present && plan.login.managed) {
    // 托管登录服务:bootout 会发 SIGTERM,服务自己排空。
    const domain = serviceDomain(deps);
    const boot = launchctlRun(['bootout', `${domain}/${plan.label}`], deps);
    if (!boot.ok) console.log(`  launchctl bootout 返回非 0(继续):${boot.stderr || boot.stdout || '无输出'}`);
    else stopped.push(`launchctl bootout ${plan.label}`);
  }
  if (alive) {
    const timeoutMs = plan.values['drain-timeout'] || 30000;
    let result;
    if (plan.login.present && plan.login.managed) {
      result = await sm.waitForExit(pid, { timeoutMs, isAliveImpl: deps.isAliveImpl || sm.isAlive,
        sleepImpl: deps.sleepImpl || sleep });
      result.stopped = result.exited;
    } else {
      result = await sm.stopOwnedProcess({
        releaseDir, pid, timeoutMs, state: drainState,
        commandFor: deps.commandFor, processStartFor: deps.processStartFor,
        isAliveImpl: deps.isAliveImpl || sm.isAlive,
        kill: deps.kill || process.kill, sleepImpl: deps.sleepImpl || sleep,
      });
    }
    if (!result.stopped) {
      // 不提供"杀掉再宣布成功"的开关:停不下来就如实失败,代码与 current 都还没动。
      throw fail('stop_timeout',
        `pid ${pid} 在 ${timeoutMs}ms 内没有退出,升级已中止(未切换代码、未强制结束进程)。`
          + '查服务日志后再重试,或先人工停止服务');
    }
    stopped.push(`pid ${pid}`);
  }
  // 再查一次:任何仍活着且不属于 current 的实例都意味着"两个版本会同时写数据"。
  const detection = sm.detect({ installRoot: plan.installRoot, home: plan.home, env: plan.env,
    commandFor: deps.commandFor, isAliveImpl: deps.isAliveImpl, processStartFor: deps.processStartFor });
  const liveNow = detection.releases.filter(item => item.alive);
  const remainingCurrent = liveNow.filter(item => plan.currentDir && path.resolve(item.dir) === path.resolve(plan.currentDir));
  if (remainingCurrent.length) {
    const pids = remainingCurrent.map(item => item.pid).join(', ');
    throw fail('service_still_running', `当前发布目录仍有进程在运行(pid ${pids}),拒绝继续`);
  }
  return { stopped };
}

// ---------------------------------------------------------------- 执行
function installRelease(plan, deps = {}) {
  const install = deps.installRelease || ru.installExtractedRelease;
  return install({
    extractedDir: plan.extractedDir,
    installRoot: plan.installRoot,
    releaseName: plan.releaseName,
    dataDir: plan.dataDir,
    source: plan.source,
    version: plan.target.version,
    revision: plan.target.revision,
    codeRevision: plan.target.code_revision,
    sha256: plan.sha256,
    now: deps.now ? deps.now() : new Date(),
  });
}

function cleanupTemp(plan, deps = {}) {
  if (!plan.tempRoot || plan.values.keep) {
    if (plan.tempRoot && plan.values.keep) console.log(`临时目录已保留:${plan.tempRoot}`);
    return;
  }
  try { fs.rmSync(plan.tempRoot, { recursive: true, force: true }); } catch { /* 清不掉不影响结果 */ }
}

async function rollbackUpgrade(plan, deps = {}) {
  const report = { attempted: true, switched: false, started: false, verified: false, error: null, previous: plan.currentDir };
  try {
    // 先停掉可能已经起来的新版(只认新发布目录的 pid)
    const newPid = sm.readPidFile(plan.targetDir);
    if (newPid && sm.isAlive(newPid) && sm.pidBelongsTo(newPid, plan.targetDir, { commandFor: deps.commandFor })) {
      try { (deps.kill || process.kill)(newPid, 'SIGTERM'); } catch { /* 已退出 */ }
      await sm.waitForExit(newPid, { timeoutMs: plan.values['drain-timeout'] || 30000,
        isAliveImpl: deps.isAliveImpl || sm.isAlive, sleepImpl: deps.sleepImpl || sleep });
    }
    if (plan.login.present && plan.login.managed) {
      launchctlRun(['bootout', `${serviceDomain(deps)}/${plan.label}`], deps);
    }
    if (!plan.currentDir) {
      report.error = '本次是全新安装,没有上一版可回退;current 仍指向新发布目录';
      return report;
    }
    ru.rollbackCurrent({ installRoot: plan.installRoot, previous: plan.currentDir,
      now: deps.now ? deps.now() : new Date() });
    report.switched = true;
  } catch (e) {
    report.error = `切回旧 current 失败:${e.message}`;
    return report;
  }
  if (plan.values['no-start']) return report;
  try {
    await startService(plan, plan.currentDir, deps);
    const oldExpected = { version: plan.currentVersion, code_revision: codeRevision(plan.currentDir) };
    const verified = await verifyService(plan, oldExpected, deps);
    report.started = true;
    report.verified = verified.ok;
    if (!verified.ok) report.error = `旧版已启动,但核对失败:${verified.error}`;
  } catch (e) {
    report.error = `旧版启动失败:${e.message}`;
  }
  return report;
}

async function executeUpgrade(plan, deps = {}) {
  if (!plan.apply) { printPlan(plan); return 0; }
  if (!plan.confirmed && !deps.isTTY) {
    console.error('非交互环境下 --apply 需要同时给 --yes。已中止,没有写任何文件。');
    return 1;
  }
  console.log(`开始升级:${plan.currentVersion || '(全新安装)'} → ${plan.target.version}`);
  let installed = null;
  try {
    const stopped = await (deps.stopService || stopForUpgrade)(plan, deps);
    if (stopped.stopped.length) console.log(`已停止:${stopped.stopped.join(', ')}`);
    installed = (deps.installRelease || installRelease)(plan, deps);
    console.log(`已安装:${installed.releaseDir}`);
    if (plan.values['no-start']) {
      console.log('--no-start:代码已切换,但**没有启动与验证服务**。下一版启动后请核对 code_revision。');
      cleanupTemp(plan, deps);
      return 0;
    }
    const started = await (deps.startService || startService)(plan, installed.releaseDir, deps);
    console.log(`已启动${started.login ? `(登录服务 ${plan.label})` : `(pid ${started.pid})`}`);
    const verified = await (deps.verifyService || verifyService)(plan, plan.target, deps);
    if (!verified.ok) throw fail('verify_failed', verified.error || '服务未报告期望的源码指纹');
    console.log(`升级完成:${plan.target.version}   源码指纹 ${plan.target.code_revision.slice(0, 12)}`);
    cleanupTemp(plan, deps);
    return 0;
  } catch (e) {
    console.error(`升级失败:${e.message}`);
    if (!installed) {
      // 排空/归属/停止失败都发生在切换代码之前。分开措辞:排空超时时服务仍在跑,
      // 不能让人以为"可能已经停了"而去做多余的启动动作。
      if (e.code === 'drain_timeout' || e.code === 'not_owned')
        console.error('服务仍在按原样运行;没有安装、没有切换 current、没有打断任何请求。');
      else
        console.error('current 没有被切换;代码保持原样(若前面已停止服务,它可能仍是停止状态)。');
      console.error('排查后可重试,或按原方式启动服务。');
      cleanupTemp(plan, deps);
      return 1;
    }
    console.error('开始回退…');
    const report = await (deps.rollbackUpgrade || rollbackUpgrade)(plan, deps);
    if (report.switched && report.verified) {
      console.error(`已回退:current → ${plan.currentDir},旧版服务已启动并核对通过(${plan.currentVersion})`);
    } else if (report.switched) {
      console.error(`已切回 current → ${plan.currentDir},但旧服务未确认可用:${report.error || '未知原因'}`);
      console.error(`请人工检查: node ${path.join(plan.currentDir || '', 'mixctl')} status`);
    } else {
      console.error(`回退未完成:${report.error || '未知原因'}`);
      console.error(`当前 current 仍在 ${plan.targetDir};旧版本目录保留在 ${plan.currentDir || '(无)'}`);
      console.error('不要删除任何目录,先把现场交给人工处理。');
    }
    cleanupTemp(plan, deps);
    return 1;
  }
}

async function executeRollback(plan, deps = {}) {
  if (!plan.apply) { printPlan(plan); return 0; }
  if (!plan.confirmed && !deps.isTTY) {
    console.error('非交互环境下 --apply 需要同时给 --yes。已中止,没有写任何文件。');
    return 1;
  }
  console.log(`开始回退:${plan.currentVersion || '(无)'} → ${plan.target.version}`);
  try {
    await (deps.stopService || stopForUpgrade)(plan, deps);
  } catch (e) {
    console.error(`停止当前服务失败:${e.message}`);
    return 1;
  }
  let switched = false;
  try {
    ru.rollbackCurrent({ installRoot: plan.installRoot, previous: plan.targetDir,
      now: deps.now ? deps.now() : new Date() });
    switched = true;
    console.log(`已切换 current → ${plan.targetDir}`);
    if (plan.values['no-start']) {
      console.log('--no-start:代码已切回,但没有启动与验证服务。');
      return 0;
    }
    await (deps.startService || startService)(plan, plan.targetDir, deps);
    const verified = await (deps.verifyService || verifyService)(plan, plan.target, deps);
    if (!verified.ok) throw fail('verify_failed', verified.error);
    console.log(`回退完成:${plan.target.version}   源码指纹 ${plan.target.code_revision.slice(0, 12)}`);
    return 0;
  } catch (e) {
    console.error(`回退失败:${e.message}`);
    if (switched && plan.currentDir) {
      console.error('尝试切回回退前的 current…');
      try {
        ru.rollbackCurrent({ installRoot: plan.installRoot, previous: plan.currentDir,
          now: deps.now ? deps.now() : new Date() });
        await (deps.startService || startService)(plan, plan.currentDir, deps);
        console.error(`已恢复 current → ${plan.currentDir};请用 status 确认服务`);
      } catch (restore) {
        console.error(`恢复也失败:${restore.message}`);
        console.error(`当前 current 在 ${plan.targetDir};两个目录都保留着,请人工处理。`);
      }
    }
    return 1;
  }
}

async function run(argv = process.argv.slice(2), deps = {}) {
  let values;
  try { values = parseArgs(argv); }
  catch (e) { console.error(`${e.message}\n\n${HELP}`); return 2; }
  if (values.help) { console.log(HELP); return 0; }
  let plan;
  try { plan = await buildPlan(values, deps); }
  catch (e) { console.error(`预检失败:${e.message}`); return 1; }
  if (plan.mode === 'status') {
    printLocal(plan);
    console.log('');
    console.log('没有指定安装来源。用 --archive <本地发布包> 或 --version <v> --download 预览升级;');
    console.log('也可用 --rollback-to <旧发布目录> 预览回退。以上都不会写文件。');
    return 0;
  }
  try {
    if (plan.mode === 'rollback') return await executeRollback(plan, deps);
    return await executeUpgrade(plan, deps);
  } finally {
    // 预览模式也要清掉下载/解包的临时目录(失败路径在 execute 里已经清过一次,重复无害)
    if (!plan.apply) cleanupTemp(plan, deps);
  }
}

if (require.main === module) run().then(code => { process.exitCode = code; })
  .catch(e => { console.error(e.message); process.exitCode = 1; });

module.exports = {
  HELP, parseArgs, buildLocalPlan, buildPlan, buildRollbackPlan, printPlan, printLocal,
  acquireArchive, startDetached, startService, stopForUpgrade, verifyService,
  executeUpgrade, executeRollback, rollbackUpgrade, resolveDataDir, httpJson, run,
};
