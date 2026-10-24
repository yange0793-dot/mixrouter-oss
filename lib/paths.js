'use strict';
// 三类路径的**唯一**定义:开发副本 / 不可变发布目录 / 固定运行数据目录。
//
// ---- 为什么分三类,以及为什么不能合并 ----
//   开发副本(devRoot):可写、可改、随时切分支、随便跑测试。它的内容是"正在写的代码",
//     不是"正在对外服务的代码",两者生命周期完全不同。
//   发布目录(releaseRoot/<版本>-<源码修订>):装好之后**不再改写**。升级 = 装一个新目录,
//     回退 = 把 current 指回旧目录,整个过程不碰已经验证过的那一份字节。
//   运行数据目录(dataDir):providers.json / routes.json / slots.json / sessions.json / logs/,
//     是这台机器上**唯一**的用户状态。
//
//   现状是三者合一(代码目录就是数据目录,LaunchAgent 也指着它),后果不是"看着乱",是:
//     · 代码与数据同目录 ⇒ 切版本时会连数据一起换掉,或者两个进程同时写同一份 providers.json。
//       我们对 providers.json 的写入是**整份原子替换**,两个写者 = 后写的赢,先写的那份配置
//       无声消失,日志里只有一次成功的原子替换。
//     · 发布目录可改 ⇒ "这个进程到底加载了哪个修订"只能靠 mtime 猜;而 code_revision 的整套
//       核对(mixctl status / 控制台横幅)前提正是"同一份修订的字节不再变"。
//     · 数据目录跟着代码走 ⇒ 回退旧版本代码时找不到用户数据,只能靠人记住路径 ——
//       而第四期的目标就是"安装、升级和回退不依赖记住本机目录"。
//
// ---- 本模块的边界 ----
//   只回答"路径是什么",不建目录、不读配置、不发请求。**require 本身零副作用**
//   纯函数:吃 env + root + home,吐字符串;同一组入参永远同一个结果。
//
//   依赖方向:只 require node 内置 + lib/backup/targets.js。后者的 LIVE_FILES 是 dataDir 与
//   三个客户端配置文件的真值,**这里转发而不另写一份** —— 同一条路径规则存两份,失败模式不是
//   当场出错,是很久以后在别处出错。不 require mixrouter.js(会成环),也不 require mixctl
//   (它是脚本,顶层有副作用,require 进来会整个跑一遍)。
const path = require('node:path');
const { LIVE_FILES } = require('./backup/targets');

// 默认端口。放在这里不是因为它是"路径",而是让"安装时要检查哪两个端口"有唯一来源:
// 端口被占是安装脚本必须提前失败的条件之一,而 8787/8788 这两个字面量在
// mixrouter.js(PROXY_PORT/UI_PORT)与 mixctl(UI_PORT)里各写了一遍。
// 值必须与那两处一致 —— 安装脚本按它拦人;test/install-script.test.js 有断言盯着。
const DEFAULT_PORTS = Object.freeze({ proxy: 8787, ui: 8788 });

// 发布目录里**明确纳入**的源码与资源(白名单,不是黑名单)。
// 为什么用白名单:providers.json / routes.json / slots.json / sessions.json、logs/、.run/、
// backups/、test/、.git 都在仓库里,黑名单漏一项就是把带 key 的文件或本机状态
// 打进发布物。安装脚本按这份清单复制,并只对清单内的条目算指纹 —— 清单与指纹走同一份。
//
// test/ **不**在这里:Release 制品是**运行包**,验证方式固定为 `npm run smoke`
// (scripts/smoke-offline.js 在 scripts/ 里,随包走)。完整开发测试套件只在 GitHub 源码
// 仓库里跑;运行包里的 `npm test` 会明确报错,不会伪装成通过。
const RELEASE_ITEMS = Object.freeze([
  'mixrouter.js', 'mixctl', 'package.json', 'LICENSE', 'README.md',
  'README.en.md', 'SUPPORT.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md',
  'providers.example.json', 'routes.example.json',
  'lib', 'public', 'app', 'scripts', 'docs',
]);

// 发布物里**绝不允许出现**的条目(相对发布根)。装完之后由安装脚本逐条核,出现即失败:
// 这些要么含明文 key,要么是本机运行状态,都不该跟着代码一起被复制到新目录。
const FORBIDDEN_IN_RELEASE = Object.freeze([
  'providers.json', 'routes.json', 'slots.json', 'harness.json', 'dsh.json', 'sessions.json', 'client-managed.json',
  'logs', 'backups', '.run', '.git', '.env', 'node_modules',
]);

// ---- 一、开发副本 ----------------------------------------------------------
// 默认值就是调用方的代码目录(通常是 __dirname),与今天的行为逐字一致;
// MIXR_DEV_ROOT 只是给"我明确想指出哪份是开发副本"留一个入口,没有任何现存调用方读它。
const devRoot = (env, root) => env.MIXR_DEV_ROOT || root;

// ---- 二、安装根与发布目录(发布目录不可变) ------------------------------------
// 安装根下面只有三样东西:releases/、data/、backups/ —— 代码、数据、备份各占一个,
// 这是"三类不合并"在磁盘上的样子。
const installRoot = (env, home) =>
  env.MIXR_INSTALL_PREFIX || path.join(home, '.local', 'share', 'mixrouter');
const releaseRoot = (env, home) =>
  env.MIXR_RELEASE_ROOT || path.join(installRoot(env, home), 'releases');
const currentRelease = (env, home) => path.join(releaseRoot(env, home), 'current');
const releaseDir = (releaseRootPath, name) => path.join(releaseRootPath, name);

// ---- 三、运行数据目录 -------------------------------------------------------
// 两个概念,名字必须分开,否则"复用 MIXR_DATA_DIR"就会变成"安装脚本可能写到线上数据目录":
//   runtimeDataDir(env, root) —— **今天**运行中的服务/CLI 去哪找数据 = MIXR_DATA_DIR || 代码目录。
//     这是现状、是既有契约,mixctl 现在按它取 REQ_LOG。改默认值等于让线上实例换个目录找
//     providers.json,所以一行不动。
//   fixedDataDir(env, home) —— 新安装建议落地的**固定**数据目录,与代码分离。
//     升级只换 releases/ 下的目录,这个目录跟着 HOME 走,不跟着代码走。
// 两者之间没有第二个环境变量:迁移就是给 LaunchAgent 显式设一次 MIXR_DATA_DIR=固定目录,
// 之后 runtimeDataDir 与 fixedDataDir 指向同一处。
const runtimeDataDir = (env, root) => LIVE_FILES.dataDir(env, root);
const fixedDataDir = (env, home) => path.join(installRoot(env, home), 'data');

// 日志:requests.jsonl 与 responses/ 在**数据目录**下;server.log 目前在**代码目录**下
// (launchd-run.sh 与 mixctl 都按代码目录拼)。这个不一致是既有耦合,见文件末的迁移点。
const logDir = (env, root) => path.join(runtimeDataDir(env, root), 'logs');
const requestsLog = (env, root) => path.join(logDir(env, root), 'requests.jsonl');
const responseArchiveDir = (env, root) =>
  env.MIXR_RESPONSE_ARCHIVE_DIR || path.join(logDir(env, root), 'responses');
const serverLog = root => path.join(root, 'logs', 'server.log');

// 备份:含明文 key 的文件副本,按规划 §6.1.3 放在**仓库之外**的受限目录,不进 git、不进发布物。
const backupRoot = (env, home) => path.join(installRoot(env, home), 'backups');

// PID 与 launchd 日志所在的 .run 目录。**在代码目录里**,不在数据目录里 ——
// 这是现状(launchd-run.sh 写 $DIR/.run/mixrouter.pid,mixctl 读 ROOT/.run/mixrouter.pid),
// 两边靠"都在仓库根"这一条巧合对齐。集中到这里是为了让第三处不必再各拼一遍。
const runDir = root => path.join(root, '.run');
const pidFile = root => path.join(runDir(root), 'mixrouter.pid');

// 静态页面:跟代码走(属于发布内容),不跟数据走。
const publicDir = root => path.join(root, 'public');

// ---- 客户端配置(其真值在 lib/backup/targets.js 的 LIVE_FILES) ---------------
// zcode 那一项的真值原本在 lib/zcode-config.js,现已改为从本模块取,避免第二份默认值。
const claudeSettings = (env, home) => LIVE_FILES.claudeSettings(env, home);
const codexConfig = (env, home) => LIVE_FILES.codexConfig(env, home);
const zcodeConfig = (env, home) =>
  env.MIXR_ZCODE_CONFIG || path.join(home, '.zcode', 'v2', 'config.json');

// 本机 LaunchAgent 目录。只用来"读现有 plist 做差异对比",脚本不往里写。
const launchAgentDir = home => path.join(home, 'Library', 'LaunchAgents');

// ---- 安装计划 --------------------------------------------------------------
// 给 scripts/install-macos.sh 用的一次性汇总:三类路径 + 端口 + 运行时文件位置。
// **只算不建**。prefix 显式给出时,releases/ data/ backups/ 三项一起由它推导,
// 且**不看 MIXR_DATA_DIR** —— 安装脚本因此不可能被一个继承来的环境变量指到线上数据目录去。
// root / home 必须绝对路径:传进来一个相对路径或写错的根,安装脚本会安静地把发布物
// 复制到另一个目录(这条教训在 lib/backup/targets.js 里已经吃过一次)。
function installPlan(options = {}) {
  const { env = process.env, root, home, prefix, releaseName, ports = {} } = options;
  for (const [name, value] of [['root', root], ['home', home]]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new TypeError(`installPlan: ${name} 必须是绝对路径,实得 ${JSON.stringify(value)}`);
    }
  }
  if (prefix !== undefined && (typeof prefix !== 'string' || !path.isAbsolute(prefix))) {
    throw new TypeError(`installPlan: prefix 必须是绝对路径,实得 ${JSON.stringify(prefix)}`);
  }
  if (releaseName !== undefined && (typeof releaseName !== 'string' || !releaseName || releaseName.includes('/'))) {
    throw new TypeError(`installPlan: releaseName 必须是不含 / 的非空字符串,实得 ${JSON.stringify(releaseName)}`);
  }
  const base = prefix || installRoot(env, home);
  const rel = prefix ? path.join(prefix, 'releases') : releaseRoot(env, home);
  const data = prefix ? path.join(prefix, 'data') : fixedDataDir(env, home);
  const dir = releaseName === undefined ? rel : releaseDir(rel, releaseName);
  return {
    devRoot: devRoot(env, root),
    installRoot: base,
    releaseRoot: rel,
    currentRelease: prefix ? path.join(prefix, 'current') : currentRelease(env, home),
    releaseDir: dir,
    dataDir: data,
    logDir: path.join(data, 'logs'),
    backupRoot: prefix ? path.join(prefix, 'backups') : backupRoot(env, home),
    publicDir: publicDir(root),
    runDir: runDir(dir),
    pidFile: pidFile(dir),
    serverLog: serverLog(dir),
    claudeSettings: claudeSettings(env, home),
    codexConfig: codexConfig(env, home),
    zcodeConfig: zcodeConfig(env, home),
    launchAgentDir: launchAgentDir(home),
    proxyPort: Number.isInteger(ports.proxy) ? ports.proxy : DEFAULT_PORTS.proxy,
    uiPort: Number.isInteger(ports.ui) ? ports.ui : DEFAULT_PORTS.ui,
    releaseItems: [...RELEASE_ITEMS],
    forbiddenInRelease: [...FORBIDDEN_IN_RELEASE],
  };
}

module.exports = {
  DEFAULT_PORTS, RELEASE_ITEMS, FORBIDDEN_IN_RELEASE,
  devRoot, installRoot, releaseRoot, currentRelease, releaseDir,
  runtimeDataDir, fixedDataDir, dataDir: runtimeDataDir,
  logDir, requestsLog, responseArchiveDir, serverLog, runDir, pidFile, publicDir, backupRoot,
  claudeSettings, codexConfig, zcodeConfig, launchAgentDir,
  installPlan,
  // 转发而不复制:断言"这是同一份来源",防止将来有人在本文件里再写一份默认值。
  LIVE_FILES,
};
