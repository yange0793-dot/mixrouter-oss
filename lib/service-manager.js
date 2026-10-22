'use strict';
// 服务实例识别与 macOS 登录服务(LaunchAgent)。
//
// ---- 这个模块只管两件事,别的都不做 ----
//   1. **认出这台机器上的实例**,而不是"看到有个 pid 文件就当成自己的"。
//      本机可能同时有:从源码目录直接 npm start 的前台进程、mixctl 派生的后台进程、
//      launchd 拉起的常驻进程、以及别的版本留下的残留 pid 文件。判断一个 pid 属不属于
//      某个发布目录,唯一可靠的办法是看**该进程自己的命令行**是否指向这个目录;
//      只凭 pid 活着 + pid 文件存在,会把"旧进程恰好复用了同一个 PID"当成自己的服务。
//   2. **生成/写入/删除我们自己的 LaunchAgent**,并且只碰明确带 marker 的那一份。
//      ~/Library/LaunchAgents 下可能有用户手写的 plist、别的软件的同名 com.*.mixrouter。
//      凡是文件里没有 MANAGED_MARKER 的,一律只读展示、拒绝覆盖与删除 —— 这是
//      "不误控别的服务"在代码里的落点,不是一句注释。
//
// ---- 边界 ----
//   · require 本模块零副作用:不读 HOME、不扫目录、不执行 ps/launchctl。
//   · 纯函数(路径、plist 渲染、pid 判定)吃参数;需要外部世界的动作(ps、kill、launchctl)
//     由调用方注入或放在 CLI 里,测试因此不需要真的杀进程。
//   · **不**自动 bootstrap。install 的默认行为只是把 plist 写下来并打印下一步;
//     要真正装载必须显式 --load,且只在 CLI 里执行。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('./paths');
const { codeRevision } = require('./runtime-code');

// 我们在 plist 里留下的标记。写入时放在 XML 注释里,读取时只认这个字符串。
// 为什么不靠文件名:用户完全可能把 install-macos.sh 打印的建议配置原样拷进
// ~/Library/LaunchAgents,那份文件名一样、内容几乎一样,但它不属于本工具的托管范围。
const MANAGED_MARKER = 'mixrouter-managed';
// ---- 专属 label 命名空间 ----
// 本工具**只**写这一类 label:com.<用户名>.mixrouter.managed。
// 为什么不复用 install-macos.sh / 旧 mixctl 的 com.<用户名>.mixrouter:
// 那一份是**用户原有部署**的服务,可能接着别的发布目录、别的数据目录,甚至由
// launchctl 手工维护。接管它意味着本工具会改写并 bootout 一个不是它装的服务 ——
// 这既是"误控别的服务",也让"回退"变成在两条部署之间乱跳。所以:
//   · 默认 label 带 .managed 后缀;
//   · 显式 --label 也只能用这个命名空间,legacy label 直接拒绝;
//   · 扫描到的 legacy plist 只读展示,升级时会明确要求人工处理(见 upgrade-release)。
const MANAGED_LABEL_SUFFIX = '.mixrouter.managed';
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MANAGED_LABEL_PATTERN = new RegExp(`^com\\.[A-Za-z0-9][A-Za-z0-9._-]*\\.mixrouter\\.managed$`);
const LAUNCHD_RUN_REL = path.join('scripts', 'launchd-run.sh');

const fail = (code, message, extra = {}) =>
  Object.assign(new Error(message), { code, ...extra });

const abs = (name, value) => {
  if (typeof value !== 'string' || !path.isAbsolute(value))
    throw new TypeError(`${name} 必须是绝对路径,实得 ${JSON.stringify(value)}`);
  return value;
};

// 默认 label 用本工具专属命名空间;末尾的 .managed 就是"归本工具管"的声明。
function defaultLabel(user) {
  let name = user;
  if (!name) {
    try { name = os.userInfo().username; } catch { name = ''; }
  }
  if (!name) name = path.basename(os.homedir()) || 'user';
  const safe = String(name).replace(/[^A-Za-z0-9._-]/g, '_');
  return `com.${safe}${MANAGED_LABEL_SUFFIX}`;
}

// 写入/删除前的强制校验。legacy 的 com.<用户>.mixrouter 与任意别的 label 都拒绝,
// 并在错误里说清为什么 —— 否则用户会把它当成"工具坏了",再去手工拷 plist。
function assertManagedLabel(label) {
  const value = String(label == null ? '' : label);
  if (MANAGED_LABEL_PATTERN.test(value)) return value;
  if (LABEL_PATTERN.test(value) && value.endsWith('.mixrouter'))
    throw fail('legacy_label',
      `${value} 是 install-macos.sh / 旧 mixctl 使用的 label,不归本工具管理。`
        + `本工具只写 ${MANAGED_LABEL_SUFFIX} 命名空间(默认 ${defaultLabel()});`
        + '请用原来的方式停用/更新那份服务,或换成本工具的默认 label');
  throw fail('invalid_label',
    `label 必须是 com.<用户名>${MANAGED_LABEL_SUFFIX} 形式,实得 ${JSON.stringify(label)}`);
}

function launchAgentPath(home, label) {
  abs('home', home);
  assertManagedLabel(label);
  return path.join(paths.launchAgentDir(home), `${label}.plist`);
}

// ---------------------------------------------------------------- 进程
function isAlive(pid, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; } // 存在但无权发信号 —— 活着
}

// 只读 `ps -p <pid> -o command=`。用 execFile 而不是 exec:pid 虽然是数字,但这道
// 参数边界不该靠"上游一定是数字"来维持。
function processCommand(pid, { execFileSyncImpl = execFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSyncImpl('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    });
    const text = String(out || '').trim();
    return text || null;
  } catch { return null; }
}

// ---- 进程归属:按"argv 形状"判定,绝不按子串 ----
// 之前的实现是 `command.includes(dir + '/')`,它把 `cat <release>/README.md`、
// `vim <release>/package.json` 这类**只是把目录当参数**的进程也算成自己的服务,
// 于是 stopOwnedProcess 会给一个编辑器发 SIGTERM。归属判断必须回答的是
// "这个进程的**入口**是不是该目录里的 mixrouter.js",而不是"命令行里有没有这个路径"。
//
// 认两种形状(分词后逐项比对,不做子串匹配):
//   A. node 入口:argv[0] 是 node,后面某个参数**恰好等于** <目录>/mixrouter.js。
//   B. process.title:mixrouter.js 启动后会执行 `process.title = 'mixrouter'`,
//      此时 `ps` 只剩一个词,路径彻底消失。这种情况下命令行无法自证归属,
//      只能落到二级证据(见 ownershipEvidence),返回 'title' 让调用方知道
//      "命令行没提供信息",而不是把它当成"命令行说明了它不是"。
const NODE_BASENAMES = /^(node|nodejs|node-\d+)$/;
const TITLE_BASENAME = 'mixrouter';

// 按 shell 习惯粗分:支持引号(单/双)与反斜杠转义,足够解析 ps 输出的 argv。
// 这不是完整 POSIX 解析器 —— 我们只用它把"路径参数"和"其它参数"分开,
// 且后续比较是**整项相等**,拼错一个 token 也不会造成误判,只会让它不算命中。
function splitCommand(command) {
  const text = String(command || '');
  const out = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < text.length) { current += text[++i]; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (ch === '\\' && i + 1 < text.length) { current += text[++i]; started = true; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started || current) { out.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started || current) out.push(current);
  return out;
}

const basenameOf = value => path.basename(String(value || ''));

// 入口是否是 <root>/mixrouter.js(逐项精确相等,并把 root 的符号链接真实路径也认上)。
function isRouterEntry(token, root) {
  if (!token || !root) return false;
  if (basenameOf(token) !== 'mixrouter.js') return false;
  const dir = path.dirname(token);
  const candidates = new Set([path.resolve(root)]);
  try { candidates.add(fs.realpathSync(root)); } catch { /* 目录不存在时只留字面值 */ }
  for (const candidate of candidates) {
    if (path.resolve(dir) === candidate) return true;
    // <root>/mixrouter.js 与经 current 启动时命令行里可能写成 .../current/mixrouter.js,
    // 这两种都是"同一份代码"的写法,但必须是**目录整体相等**,不是前缀相似。
    try {
      if (path.resolve(fs.realpathSync(dir)) === path.resolve(fs.realpathSync(candidate))) return true;
    } catch { /* 某一侧读不到真实路径:只信字面比较 */ }
  }
  return false;
}

// node 的"执行模式"开关:带上它们就不存在脚本入口(-e '…' 后面的词是**脚本参数**,
// 不是脚本文件)。这类进程一律 not_owned —— 它们的 argv 里可能出现任意路径。
const NODE_EXEC_MODE = new Set(['-e', '--eval', '-p', '--print', '-c', '--check',
  '-i', '--interactive', '--test', '--test-only']);

// 会**吃掉下一个 token 作为值**的 node 开关。不在这里的开关一律当作自包含
// (`--enable-source-maps`、`--no-warnings` 等),不跳过下一项。
// 漏判的代价是"把选项值误当成脚本名" → 判成 not_owned(安全方向);
// 多判的代价是"跳过真正的脚本名" → 也只会漏认,不会误杀。
const NODE_VALUE_FLAGS = new Set([
  '-r', '--require', '--loader', '--experimental-loader', '--import',
  '--max-old-space-size', '--max-semi-space-size', '--stack-size',
  '--inspect-port', '--debug-port', '--title', '--redirect-warnings',
  '--openssl-config', '--icu-data-dir', '--diagnostic-dir', '--env-file',
  '--cpu-prof-dir', '--heap-prof-dir', '--trace-event-file-pattern', '--conditions',
]);

// 从 `node [options] <script> [args…]` 里取出**真正的入口 token**。
// 规则(与 node 自己的解析一致到"够安全"的程度):
//   · 选项按出现顺序跳过;带值的选项连它的值一起跳过;
//   · `--` 之后的第一项就是脚本;
//   · **第一个非选项 token 即入口,之后不再扫描** —— 这正是修掉
//     `node /other/tool.js <release>/mixrouter.js` 误判的地方;
//   · 执行模式(-e/-p/-c/--test…)直接返回 null,不认任何入口。
function nodeEntryToken(argv) {
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') return argv[i + 1] || null;
    if (token.startsWith('-')) {
      const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
      if (NODE_EXEC_MODE.has(name)) return null;
      if (!token.includes('=') && NODE_VALUE_FLAGS.has(name)) i += 1; // 跳过它的值
      continue;
    }
    return token; // 首个非选项 = 入口;绝不继续往后找
  }
  return null;
}

// 返回值是**判据**而不是布尔:
//   { entry: 'node', matched: true }  —— 入口 token 恰为 <root>/mixrouter.js
//   { entry: 'title' }                —— 标题被改成 mixrouter,命令行不再携带路径
//   { entry: 'other', matched: false } —— 明确的"不是这个目录的服务"
function commandRunsFrom(command, root) {
  if (!command || !root) return { entry: 'other', matched: false };
  const argv = splitCommand(command);
  if (!argv.length) return { entry: 'other', matched: false };
  const head = basenameOf(argv[0]);
  if (NODE_BASENAMES.test(head)) {
    // 只按**入口 token**判,不看它后面的脚本参数。
    const entryToken = nodeEntryToken(argv);
    if (!entryToken) return { entry: 'other', matched: false, execMode: true };
    const matched = isRouterEntry(entryToken, root);
    return { entry: matched ? 'node' : 'other', matched, script: entryToken };
  }
  // process.title 之后 ps 只剩一个词;这不是"命令行证明了它属于谁",
  // 只是"命令行不再提供信息"。
  if (argv.length === 1 && head === TITLE_BASENAME) return { entry: 'title', matched: false };
  return { entry: 'other', matched: false };
}

// mixrouter 启动后会把 process.title 改成 'mixrouter'(mixrouter.js 里的
// `process.title = 'mixrouter'`),此后 `ps -o command=` 只剩一个词,**看不到脚本路径**。
// 因此命令行匹配只对还没改标题的瞬间/别的启动方式有效;常驻进程要靠下面两条二级证据:
//   · pid 文件所在目录 + 进程启动时间与 pid 文件 mtime 吻合(排除 PID 复用);
//   · 服务自己通过 /api/state 报出的 pid 与 code_revision(调用方能拿到时)。
function parseElapsed(text) {
  // ps 的 etime:[[dd-]hh:]mm:ss
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (((Number(days || 0) * 24 + Number(hours || 0)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

function processStartTime(pid, { execFileSyncImpl = execFileSync, now = Date.now } = {}) {
  try {
    const out = execFileSyncImpl('ps', ['-p', String(pid), '-o', 'etime='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    });
    const elapsed = parseElapsed(out);
    return elapsed === null ? null : now() - elapsed;
  } catch { return null; }
}

function pidFileStartMatches(pid, releaseDir, { processStartFor = processStartTime,
  statSync = fs.statSync, toleranceMs = 120000 } = {}) {
  let mtime;
  try { mtime = statSync(path.join(releaseDir, '.run', 'mixrouter.pid')).mtimeMs; } catch { return false; }
  const started = processStartFor(pid);
  if (!started) return false;
  // pid 文件在服务启动时写入,两者时间应几乎相同。差距过大说明 pid 文件是旧的,
  // 当前这个 pid 只是被系统复用 —— 不能当成自己的服务。
  return Math.abs(started - mtime) <= toleranceMs;
}

function ownershipEvidence({ pid, releaseDir, commandFor = processCommand,
  processStartFor, statSync = fs.statSync } = {}) {
  const command = commandFor(pid);
  const runs = commandRunsFrom(command, releaseDir);
  // 一级证据:入口确实指向这个目录里的 mixrouter.js
  if (runs.entry === 'node' && runs.matched) return { ok: true, evidence: 'command', command };
  // 命令行**明确**是别的东西(编辑器、cat、另一个 node 脚本):直接拒绝,不再看二级证据。
  // 这条是防"参数里带了该目录路径就被当成服务"的关键 —— 二级证据只对
  // "命令行不再提供信息"(标题被改)的进程开放。
  if (runs.entry === 'other')
    return { ok: false, reason: 'command', command,
      message: `pid ${pid} 的入口不是 ${releaseDir}/mixrouter.js` };
  // 二级证据(仅对 process.title 之后的进程):pid 文件与进程启动时间吻合。
  if (!pidFileStartMatches(pid, releaseDir, { processStartFor, statSync }))
    return { ok: false, reason: 'start_time', command,
      message: `pid ${pid} 的启动时间与 ${releaseDir}/.run/mixrouter.pid 不吻合(可能是 PID 复用)` };
  return { ok: true, evidence: 'pidfile+start_time', command };
}

function pidBelongsTo(pid, root, { commandFor = processCommand, processStartFor, statSync } = {}) {
  return ownershipEvidence({ pid, releaseDir: root, commandFor, processStartFor, statSync }).ok;
}

// ---------------------------------------------------------------- 发布目录
function readPidFile(releaseDir, { readFileSync = fs.readFileSync } = {}) {
  try {
    const raw = String(readFileSync(path.join(releaseDir, '.run', 'mixrouter.pid'), 'utf8')).trim();
    if (!/^\d+$/.test(raw)) return 0;
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
  } catch { return 0; }
}

function readPackageVersion(dir, { readFileSync = fs.readFileSync } = {}) {
  try { return String(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version || ''); }
  catch { return ''; }
}

function readReleaseManifest(dir, { readFileSync = fs.readFileSync } = {}) {
  try { return JSON.parse(readFileSync(path.join(dir, 'RELEASE.json'), 'utf8')); }
  catch { return null; }
}

function listReleaseDirs(releaseRoot, { readdirSync = fs.readdirSync } = {}) {
  let entries;
  try { entries = readdirSync(releaseRoot, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => path.join(releaseRoot, entry.name))
    .sort();
}

// 发布根与 current 的**唯一**解析点(service-manager 是 detection 的归属模块,
// release-update / 两个 CLI 都从这里取,不另写一份)。
//
// 真相来自 lib/paths.js,这里只做"显式安装根 vs 默认安装根"的分派:
//   · installRoot 就是 paths.installRoot(env, home) 时,直接用 paths.releaseRoot() /
//     paths.currentRelease() —— 它们已经处理了 MIXR_INSTALL_PREFIX 与 MIXR_RELEASE_ROOT。
//   · 传了别的安装根(CLI 的 --install-root)时,发布根就是该根的 releases/;
//     此时不读 MIXR_RELEASE_ROOT,否则一个环境变量会把显式参数悄悄改道。
//   · current 另有一个历史落点 <安装根>/current(paths.installPlan 带 prefix 时写出),
//     两个都认,优先 paths.currentRelease() 那个。
function isDefaultInstallRoot(installRoot, env = process.env, home = os.homedir()) {
  return path.resolve(installRoot) === path.resolve(paths.installRoot(env, home));
}

function releaseRootOf(installRoot, env = process.env, home = os.homedir()) {
  if (isDefaultInstallRoot(installRoot, env, home)) return paths.releaseRoot(env, home);
  return path.join(path.resolve(installRoot), 'releases');
}

function currentLinkCandidates(installRoot, env = process.env, home = os.homedir()) {
  const preferred = isDefaultInstallRoot(installRoot, env, home)
    ? paths.currentRelease(env, home)
    : path.join(releaseRootOf(installRoot, env, home), 'current');
  return [preferred, path.join(path.resolve(installRoot), 'current')];
}

function currentLinkPath(installRoot, { lstatSync = fs.lstatSync, env = process.env,
  home = os.homedir() } = {}) {
  const [preferred, legacy] = currentLinkCandidates(installRoot, env, home);
  for (const candidate of [preferred, legacy]) {
    try { lstatSync(candidate); return candidate; } catch { /* 继续看下一个 */ }
  }
  return preferred;
}

// 同时存在的两份 current 是配置漂移,不是正常状态:调用方要能报出来。
function strayCurrentLink(installRoot, { lstatSync = fs.lstatSync, env = process.env,
  home = os.homedir() } = {}) {
  const [preferred, legacy] = currentLinkCandidates(installRoot, env, home);
  const exists = candidate => { try { lstatSync(candidate); return true; } catch { return false; } };
  if (!exists(preferred) || !exists(legacy)) return null;
  return { used: preferred, ignored: legacy };
}

function currentReleaseTarget(installRoot, { readlinkSync = fs.readlinkSync, statSync = fs.statSync,
  lstatSync = fs.lstatSync, env = process.env, home = os.homedir() } = {}) {
  const link = currentLinkPath(installRoot, { lstatSync, env, home });
  let target;
  try {
    // current 也可能是普通目录(有人手工建过),readlink 会抛;stat 能分辨。
    target = readlinkSync(link);
  } catch {
    try { if (statSync(link).isDirectory()) return link; } catch { /* 没有 current */ }
    return null;
  }
  return path.resolve(path.dirname(link), target);
}

// ---------------------------------------------------------------- plist 解析
function xmlUnescape(text) {
  return String(text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function plistString(raw, key) {
  // 只匹配 <key>KEY</key> 后紧跟的 <string>。环境变量与顶层键都可能重名
  // (本文件目前只有 MIXR_DATA_DIR 一个),取第一个就够;取不到返回 null。
  const re = new RegExp(`<key>${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</key>\\s*<string>([\\s\\S]*?)</string>`);
  const match = re.exec(raw);
  return match ? xmlUnescape(match[1]) : null;
}

function plistProgramArguments(raw) {
  const match = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(raw);
  if (!match) return [];
  const args = [];
  for (const item of match[1].matchAll(/<string>([\s\S]*?)<\/string>/g)) args.push(xmlUnescape(item[1]));
  return args;
}

// 一份 plist 里"它到底会启动哪个目录"。优先看 ProgramArguments 里的 launchd-run.sh,
// 退而看 WorkingDirectory —— install-macos.sh 建议的那份两个都写死了绝对路径。
function pinnedReleaseOf(programArguments, workingDirectory) {
  for (const arg of programArguments) {
    if (arg.endsWith(path.sep + LAUNCHD_RUN_REL) || arg.endsWith('/scripts/launchd-run.sh')) {
      return path.dirname(path.dirname(arg));
    }
  }
  if (workingDirectory && path.isAbsolute(workingDirectory)) return workingDirectory;
  return null;
}

function envPort(raw, key) {
  const value = Number(plistString(raw, key));
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

function parseLaunchAgent(file, raw) {
  const label = plistString(raw, 'Label');
  const programArguments = plistProgramArguments(raw);
  const workingDirectory = plistString(raw, 'WorkingDirectory');
  return {
    file,
    label,
    managed: raw.includes(MANAGED_MARKER),
    programArguments,
    workingDirectory,
    pinnedRelease: pinnedReleaseOf(programArguments, workingDirectory),
    dataDir: plistString(raw, 'MIXR_DATA_DIR'),
    proxyPort: envPort(raw, 'MIXROUTER_PORT'),
    uiPort: envPort(raw, 'MIXUI_PORT'),
    raw,
  };
}

function listLaunchAgents(home, { readdirSync = fs.readdirSync, readFileSync = fs.readFileSync } = {}) {
  const dir = paths.launchAgentDir(home);
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.plist') || !/mixrouter/i.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const raw = String(readFileSync(file, 'utf8'));
      out.push(parseLaunchAgent(file, raw));
    } catch {
      out.push({ file, label: path.basename(name, '.plist'), managed: false, invalid: true,
        programArguments: [], workingDirectory: null, pinnedRelease: null, dataDir: null, raw: '' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 实例汇总
// 只读:不连端口、不发信号、不调用 launchctl。CLI 的 status 与升级工具的预检都用它。
function detect({ installRoot, home, env = process.env, commandFor = processCommand,
  isAliveImpl = isAlive, readFileSync = fs.readFileSync, readdirSync = fs.readdirSync,
  readlinkSync = fs.readlinkSync, statSync = fs.statSync, lstatSync = fs.lstatSync,
  processStartFor } = {}) {
  abs('installRoot', installRoot);
  abs('home', home);
  const releaseRoot = releaseRootOf(installRoot, env, home);
  const current = currentReleaseTarget(installRoot, { readlinkSync, statSync, lstatSync, env, home });
  const releases = listReleaseDirs(releaseRoot, { readdirSync }).map(dir => {
    const pid = readPidFile(dir, { readFileSync });
    const alive = pid ? isAliveImpl(pid) : false;
    const evidence = alive
      ? ownershipEvidence({ pid, releaseDir: dir, commandFor, processStartFor, statSync })
      : null;
    return {
      dir,
      name: path.basename(dir),
      version: readPackageVersion(dir, { readFileSync }),
      code_revision: codeRevision(dir),
      pid,
      alive,
      owned: !!(evidence && evidence.ok),
      evidence,
      command: alive ? commandFor(pid) : null,
      manifest: readReleaseManifest(dir, { readFileSync }),
      current: current ? path.resolve(dir) === path.resolve(current) : false,
    };
  });
  const launchAgents = listLaunchAgents(home, { readdirSync, readFileSync });
  return { installRoot, releaseRoot, current, releases, launchAgents };
}

// 升级/停止前要回答的两个问题:
//   · 有没有**别人的**活实例?(不是 current 指向的那个发布目录)
//   · 有没有登录服务把某个目录写死在里面?
// 分开报,CLI 才能给出不同的下一步,而不是一句"有冲突"。
function liveInstances(detection) {
  return detection.releases.filter(item => item.alive);
}

function foreignLiveInstances(detection, { allowedDirs = [] } = {}) {
  const allowed = new Set(allowedDirs.map(dir => path.resolve(dir)));
  return liveInstances(detection)
    .filter(item => !allowed.has(path.resolve(item.dir)) || !item.owned);
}

// ---------------------------------------------------------------- LaunchAgent 渲染
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// 生成一份**只属于本工具**的 plist。结构照 install-macos.sh 的建议配置来:
// 经 launchd-run.sh 启动,这样 pid 文件与 mixctl 看到的是同一份状态。
function renderLaunchAgent(options = {}) {
  const { label = defaultLabel(), releaseDir, dataDir, nodePath, logDir,
    proxyPort = paths.DEFAULT_PORTS.proxy, uiPort = paths.DEFAULT_PORTS.ui } = options;
  assertManagedLabel(label);
  abs('releaseDir', releaseDir);
  abs('dataDir', dataDir);
  const resolvedLogDir = abs('logDir', logDir === undefined ? path.join(dataDir, 'logs') : logDir);
  const node = nodePath === undefined ? process.execPath : nodePath;
  abs('nodePath', node);
  for (const [name, value] of [['proxyPort', proxyPort], ['uiPort', uiPort]]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw fail('invalid_port', `${name} 必须是 1–65535 的整数,实得 ${JSON.stringify(value)}`);
  }
  if (proxyPort === uiPort) throw fail('invalid_port', '代理端口与控制台端口不能相同');
  const log = path.join(resolvedLogDir, 'launchd.log');
  const runScript = path.join(releaseDir, LAUNCHD_RUN_REL);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<!-- ${MANAGED_MARKER}: 本文件由 mixrouter scripts/service.js 写入。
     删除或手工改写后,本工具不再认它;同一 label 的其它 plist 也绝不会被覆盖。 -->
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xmlEscape(runScript)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(releaseDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- 数据目录固定,不跟着 current 符号链接走:升级换的是 releases/ 下的目录。 -->
    <key>MIXR_DATA_DIR</key>
    <string>${xmlEscape(dataDir)}</string>
    <key>MIXROUTER_PORT</key>
    <string>${xmlEscape(proxyPort)}</string>
    <key>MIXUI_PORT</key>
    <string>${xmlEscape(uiPort)}</string>
    <key>PATH</key>
    <string>${xmlEscape(path.dirname(node) + ':/usr/bin:/bin:/usr/sbin:/sbin')}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------- 安装/卸载计划
function backupName(file, stamp) {
  return `${file}.bak-mixr-service-${stamp}`;
}

function fileExists(file, { existsSync = fs.existsSync } = {}) {
  try { return existsSync(file); } catch { return false; }
}

function readText(file, { readFileSync = fs.readFileSync } = {}) {
  try { return String(readFileSync(file, 'utf8')); } catch { return null; }
}

// 计划阶段只读。返回的 action 是给人看的判据:
//   create / update / unchanged / blocked(存在但不是我们写的) / invalid_existing
function planInstall(options = {}) {
  const { home, label = defaultLabel(), releaseDir, dataDir, nodePath, logDir,
    proxyPort, uiPort, existsSync = fs.existsSync, readFileSync = fs.readFileSync } = options;
  abs('home', home);
  const plistPath = launchAgentPath(home, label);
  const content = renderLaunchAgent({ label, releaseDir, dataDir, nodePath, logDir, proxyPort, uiPort });
  const exists = fileExists(plistPath, { existsSync });
  const existingRaw = exists ? readText(plistPath, { readFileSync }) : null;
  const existing = existingRaw === null ? null : parseLaunchAgent(plistPath, existingRaw);
  let action;
  if (!exists) action = 'create';
  else if (existingRaw === content) action = 'unchanged';
  else if (existing && existing.managed) action = 'update';
  else action = 'blocked';
  const warnings = [];
  if (action === 'blocked')
    warnings.push(`${plistPath} 已存在且没有 ${MANAGED_MARKER} 标记;本工具不会覆盖不属于自己的服务配置`);
  if (action === 'update' && existing && existing.label && existing.label !== label)
    warnings.push(`现有 plist 的 Label 是 ${existing.label},与文件名 ${label} 不一致;覆盖前请人工确认`);
  return { plistPath, label, content, action, exists, existing, warnings };
}

function stamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// 真正写盘。原子替换 + 覆盖前在同目录留一份 .bak(与客户端配置的备份纪律一致)。
function applyInstall(plan, { now = new Date(), mkdirSync = fs.mkdirSync, writeFileSync = fs.writeFileSync,
  renameSync = fs.renameSync, copyFileSync = fs.copyFileSync, chmodSync = fs.chmodSync,
  unlinkSync = fs.unlinkSync, existsSync = fs.existsSync, pid = process.pid } = {}) {
  if (!plan || typeof plan !== 'object') throw new TypeError('applyInstall: 缺少计划');
  if (plan.action === 'blocked') throw fail('foreign_plist', plan.warnings[0] || '拒绝覆盖不属于本工具的 plist');
  if (plan.action === 'unchanged') return { written: false, unchanged: true, plistPath: plan.plistPath };
  const dir = path.dirname(plan.plistPath);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  let backup = null;
  if (existsSync(plan.plistPath)) {
    backup = backupName(plan.plistPath, stamp(now));
    copyFileSync(plan.plistPath, backup);
    chmodSync(backup, 0o600);
  }
  const tmp = path.join(dir, `.${path.basename(plan.plistPath)}.tmp-${pid}-${Math.random().toString(16).slice(2)}`);
  try {
    writeFileSync(tmp, plan.content, { mode: 0o644 });
    renameSync(tmp, plan.plistPath);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 已是半截,能删就删 */ }
    throw e;
  }
  return { written: true, backup, plistPath: plan.plistPath, action: plan.action };
}

function planUninstall(options = {}) {
  const { home, label = defaultLabel(), existsSync = fs.existsSync, readFileSync = fs.readFileSync } = options;
  abs('home', home);
  const plistPath = launchAgentPath(home, label);
  if (!fileExists(plistPath, { existsSync }))
    return { plistPath, label, action: 'missing', existing: null, warnings: [] };
  const raw = readText(plistPath, { readFileSync });
  const existing = raw === null ? null : parseLaunchAgent(plistPath, raw);
  const managed = !!(existing && existing.managed);
  return {
    plistPath, label, existing, action: managed ? 'remove' : 'blocked',
    warnings: managed ? [] : [`${plistPath} 没有 ${MANAGED_MARKER} 标记;本工具不会删除不属于自己的服务配置`],
  };
}

function applyUninstall(plan, { now = new Date(), copyFileSync = fs.copyFileSync, chmodSync = fs.chmodSync,
  unlinkSync = fs.unlinkSync } = {}) {
  if (!plan || typeof plan !== 'object') throw new TypeError('applyUninstall: 缺少计划');
  if (plan.action === 'missing') return { removed: false, missing: true, plistPath: plan.plistPath };
  if (plan.action === 'blocked') throw fail('foreign_plist', plan.warnings[0] || '拒绝删除不属于本工具的 plist');
  const backup = backupName(plan.plistPath, stamp(now));
  copyFileSync(plan.plistPath, backup);
  chmodSync(backup, 0o600);
  unlinkSync(plan.plistPath);
  return { removed: true, backup, plistPath: plan.plistPath };
}

// ---------------------------------------------------------------- 停止/等待
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForExit(pid, { timeoutMs = 30000, intervalMs = 200, isAliveImpl = isAlive,
  sleepImpl = sleep, now = Date.now } = {}) {
  const started = now();
  if (!pid) return { exited: true, waitedMs: 0, pid: 0 };
  while (isAliveImpl(pid)) {
    if (now() - started >= timeoutMs) return { exited: false, waitedMs: now() - started, pid };
    await sleepImpl(intervalMs);
  }
  return { exited: true, waitedMs: now() - started, pid };
}

// 在发停止信号前观察在途请求。**字段是否存在是契约的一部分**:
// 服务没有上报 active_requests 时,我们只能如实说"看不到",不能把"没读到"当成 0。
async function waitForDrain({ uiPort, timeoutMs = 15000, intervalMs = 500, requestState,
  sleepImpl = sleep, now = Date.now } = {}) {
  if (typeof requestState !== 'function') return { supported: false, reason: 'no_probe' };
  const started = now();
  let last = null;
  let lastState = null;
  while (true) {
    let state = null;
    try { state = await requestState(uiPort); } catch { state = null; }
    if (!state || !Number.isFinite(state.active_requests)) {
      return { supported: false, reason: state ? 'field_absent' : 'unreachable', state: last, lastState: state };
    }
    lastState = state;
    last = state.active_requests;
    if (last <= 0) return { supported: true, drained: true, active: 0, waitedMs: now() - started, lastState };
    if (now() - started >= timeoutMs)
      return { supported: true, drained: false, active: last, waitedMs: now() - started, lastState };
    await sleepImpl(intervalMs);
  }
}

// 只停"确认属于该发布目录"的 pid。判据依次是命令行路径、pid 文件与进程启动时间、
// 以及调用方拿到的 /api/state 自报(pid + code_revision)。都不成立就报 not_owned,
// 绝不发信号。
async function stopOwnedProcess({ releaseDir, pid, timeoutMs = 30000, intervalMs = 200,
  commandFor = processCommand, processStartFor, statSync = fs.statSync,
  state = null, isAliveImpl = isAlive, kill = process.kill,
  sleepImpl = sleep, now = Date.now } = {}) {
  abs('releaseDir', releaseDir);
  if (!pid) return { stopped: false, reason: 'no_pid' };
  if (!isAliveImpl(pid)) return { stopped: false, reason: 'not_alive' };
  const evidence = ownershipEvidence({ pid, releaseDir, commandFor, processStartFor, statSync });
  const diskRevision = codeRevision(releaseDir);
  const stateMatches = !!(state && Number(state.pid) === pid && diskRevision
    && state.code_revision === diskRevision);
  if (!evidence.ok && !stateMatches)
    throw fail('not_owned', evidence.message || `pid ${pid} 不能确认属于 ${releaseDir},拒绝停止`);
  kill(pid, 'SIGTERM');
  const waited = await waitForExit(pid, { timeoutMs, intervalMs, isAliveImpl, sleepImpl, now });
  return { stopped: waited.exited, pid, waitedMs: waited.waitedMs,
    reason: waited.exited ? 'exited' : 'timeout', evidence: evidence.ok ? evidence.evidence : 'state' };
}

module.exports = {
  MANAGED_MARKER, MANAGED_LABEL_SUFFIX, MANAGED_LABEL_PATTERN, LABEL_PATTERN, LAUNCHD_RUN_REL,
  defaultLabel, assertManagedLabel, launchAgentPath,
  isAlive, processCommand, commandRunsFrom, pidBelongsTo,
  parseElapsed, processStartTime, pidFileStartMatches, ownershipEvidence,
  readPidFile, readPackageVersion, readReleaseManifest, listReleaseDirs,
  isDefaultInstallRoot, releaseRootOf, currentLinkCandidates, currentLinkPath, strayCurrentLink,
  currentReleaseTarget,
  parseLaunchAgent, listLaunchAgents, pinnedReleaseOf,
  detect, liveInstances, foreignLiveInstances,
  xmlEscape, renderLaunchAgent, planInstall, applyInstall, planUninstall, applyUninstall,
  waitForExit, waitForDrain, stopOwnedProcess, stamp,
};
