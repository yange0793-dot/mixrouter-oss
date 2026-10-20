'use strict';
// 制品清单:release tarball 里"有哪些文件"的**唯一**定义。
//
// ---- 为什么要有这份清单,而不是继续用裸 `git archive HEAD` ----
//
//   1. 这个仓库的开发目录同时是运行目录,里面躺着 providers.json / routes.json /
//      sessions.json / slots.json / logs/ / backups/ —— 它们含**明文渠道 Key、会话
//      记录和请求日志**。"git 没跟踪它,所以不会进包"是一条**间接**保证:一旦仓库
//      的忽略规则被人改错、或有人 `git add -f` 把运行数据加进索引,制品就会被污染而
//      没人看得出来。显式清单把保证变成直接的 —— 没列进来的路径永远不进包。
//   2. 清单是纯数据,既被 workflow 消费,也被 test/release-manifest.test.js 断言。
//
// ---- "装什么"只有一个来源:lib/paths.js 的 RELEASE_ITEMS ----
//
// 本模块**不再自己列一遍纳入项**,而是以 `require('../lib/paths').RELEASE_ITEMS` 为基底。
// 那份清单同时被 scripts/install-macos.sh 用来"从本地克隆复制到发布目录",两边描述的是
// 同一件事:**发布物里装什么**。同一份知识写两遍的下场,本仓库已经吃过一次 —— 见
// lib/backup/targets.js 的注释(两个出口报出不同的备份池,比只报一个更坏)。
//
// 所以这里只做两件 RELEASE_ITEMS 表达不了的事,**不新写一份白名单**:
//   · EXCLUDE   —— 从基底里**再减掉**不该发布的细分项(内部记录与上线/回退运维脚本);
//   · isRuntimeData —— 按**路径形状**拦运行数据,防止有人 `git add -f` 之后它跟着基底
//                 里的某个目录(如 lib、public)混进来。
// 需要"多装一个目录/文件"时,改的是 lib/paths.js 的 RELEASE_ITEMS **那一处**,不是这里。
//
// 本模块**无副作用**:require 它不碰磁盘、不读 git。读写文件的逻辑只活在
// `require.main === module` 的 CLI 分支里,那条分支只服务 workflow 与人工核对。

const fs = require('node:fs');
const path = require('node:path');
const { RELEASE_ITEMS } = require('../lib/paths');

// ---------------------------------------------------------------- 纳入清单
//
// **就是 RELEASE_ITEMS 本身**,不复制、不改写 —— 复制品会和来源分叉。
// 每条可以是文件,也可以是目录:目录表示整棵子树都进(产品源码区,新加的模块应当自动
// 随包走)。判定用前缀匹配,所以不需要给每条标 type。
const INCLUDE = RELEASE_ITEMS;

// 每条纳入项**为什么**要进包。这是文档,不是第二份"装什么" ——
// 它只解释 RELEASE_ITEMS 里已有的项,列表里出现而这里没有的原因由测试逼着补上
// (见 test/release-manifest.test.js「每条纳入项都有 why」)。
const INCLUDE_WHY = Object.freeze({
  'mixrouter.js': '服务主入口,`node mixrouter.js` 就是它',
  'mixctl': '管理命令(sessions / slots / route / explain / backups / restore / logs)',
  'package.json': 'version 与 engines.node>=18 的来源;`npm test` / `npm run smoke` 也靠它',
  'LICENSE': 'MIT 许可证,发布物必须带',
  'README.md': '用户文档入口(快速开始、环境变量、命令总览)',
  'README.en.md': '英文项目入口与启动说明',
  'SUPPORT.md': '求助路径、诊断信息与隐私边界',
  'CONTRIBUTING.md': '测试与提交流程:完整开发测试在源码克隆里跑,运行包里用 `npm run smoke` 验证',
  'SECURITY.md': '安全问题的私密报告渠道:不要把 Key 或可利用细节发到公开 issue',
  'CHANGELOG.md': '本版改了什么、升级时要注意什么;发版说明只给摘要,细节在这里',
  'providers.example.json': 'providers.json 的模板(真文件含明文 Key,永不发布)',
  'routes.example.json': 'routes.json 的模板',
  'lib': '全部运行模块(路由 / 协议 / 备份 / 会话 / HTTP / 日志……),产品源码区',
  'public': '控制台页面与静态资源:index.html、js/app.js、js/workspace.js、js/usage.js、styles/base.css',
  'app': 'WKWebView 外壳源码(Swift + 图标 + 旧启动脚本)',
  'scripts': '用户可跑的脚本(安装 / 诊断 / 导入 / 离线验收);注意 scripts/run-tests.js 还是**运行期依赖**(lib/diagnostics/run.js 直接 require 它取 testEnv),所以它在包里,但运行包里 `npm test` 会明确报"没有开发测试套件"。上线/回退运维用的 deploy-live.sh 与 preflight-live-data.js 由 EXCLUDE 单独减掉',
  'docs': '用户文档(quick-start 等)',
});

// ---------------------------------------------------------------- 排除清单
//
// 这里是**从基底里减掉**的细分项,以及"即使将来被加进基底也必须挡住"的项。
// 前两项(release 制品 vs 本地安装)口径可以不同,但每一条都要能回答"为什么不进包"。
const EXCLUDE = [
  // — 基底内部要减掉的细分 —
  { path: 'docs/changes', why: '内部改动记录,含尚未发布的规划与取证过程;是内部证据,不是用户文档,也不在公开仓库索引里' },
  { path: 'scripts/deploy-live.sh', why: '**上线/回退**运维脚本:会 checkout 代码、备份并 stop/restart 服务,前提是"一台长期维护的线上机器"。它必须先给 MIXR_LIVE_DIR 才动,不是公开安装路径;随包发布只会把一条会重启服务的命令递给别人' },
  { path: 'scripts/preflight-live-data.js', why: 'deploy-live.sh 的预检:读 MIXR_LIVE_DIR 下的数据、在临时端口拉起实例。与上线脚本同一适用范围,没有独立用途' },
  // — 绝不发布的运行数据(基底里没有,列在这里是"明令禁止"兼文档) —
  { path: 'providers.json', why: '**含全部渠道明文 api_key**,运行数据' },
  { path: 'routes.json', why: '本机路由规则,运行数据' },
  { path: 'sessions.json', why: '**含对话标签(对话内容片段)** 的会话绑定,运行数据' },
  { path: 'slots.json', why: '本机子代理槽位,运行数据' },
  { path: 'logs', why: '运行期日志(server.log / requests.jsonl / 响应归档)' },
  { path: 'backups', why: '历史备份归档,内含明文 Key 与渠道配置' },
  // — 内部材料与系统垃圾(基底里没有;写死防将来被误加进基底) —
  { path: 'test', why: '开发测试套件:只在 GitHub 源码仓库里跑。Release 是**运行包**,验证方式是随包的 `npm run smoke`;把整套测试塞进运行包会扩大包体,而且不少用例依赖 .github / .gitignore 这些同样不进包的文件' },
  { path: 'evidence', why: '内部取证脚本与运行日志(等价性对照、走线 diff);只留本地,不在公开仓库索引里' },
  { path: 'AUDIT-2026-09-17.md', why: '历史内部审计报告,记录的是当时状态;只留本地,不在公开仓库索引里' },
  { path: '.github', why: '上游仓库的 CI/发版自动化与 issue/PR 模板;制品消费者没有 workflow runner,收进去只会多一份会与仓库分叉的定义' },
  { path: 'node_modules', why: '本项目零依赖,本就不该存在;显式写死防误加' },
  { path: '.claude', why: '本地代理/子代理的临时工作区' },
  { path: '.gitignore', why: '仓库自身的忽略规则,制品是"解压即用"的源码包,不靠 git' },
  { path: '.DS_Store', why: 'macOS 系统垃圾' },
];

// 运行数据基线:全仓唯一一处定义"什么算绝不发布的运行数据"。
// 制品检查(CI)与单测都从这里取,不各自再抄一份。
const RUNTIME_DATA_FILES = ['providers.json', 'routes.json', 'sessions.json', 'slots.json'];
const RUNTIME_DATA_DIRS = ['logs', 'backups', '.run'];

// 控制台的每个脚本都必须随运行包交付,避免页面能打开但主题、导航或用量页失效。
const REQUIRED_ENTRIES = [
  'mixrouter.js', 'public/index.html', 'public/js/app.js',
  'public/js/workspace.js', 'public/js/usage.js', 'public/styles/base.css',
];

// 运行包的维护条目:解压后能验、能读、能报告问题。**不含 test/** —— 整套开发测试只在
// GitHub 源码仓库跑(不少用例依赖 .github / .gitignore 这些不进包的文件)。
// 运行包的验证入口是随包的 `npm run smoke`;`npm test` 在包里会明确失败,不会伪装通过。
const REQUIRED_MAINTENANCE_ENTRIES = [
  'package.json', 'scripts/smoke-offline.js', 'scripts/start-local.js', 'scripts/doctor.js',
  'README.en.md', 'SUPPORT.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md',
];

// ---------------------------------------------------------------- 纯函数
//
// 统一成"仓库相对路径 + 正斜杠",这样在 macOS 与 Linux runner 上判定一致。
function normalize(rel) {
  return String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

// 这条相对路径算不算运行数据。按**路径段**和**文件名**判定,不按前缀猜测,
// 所以 `providers.example.json` 不会被误伤(它不以 `providers.json` 结尾)。
function isRuntimeData(relPath) {
  const parts = normalize(relPath).split('/').filter(Boolean);
  if (!parts.length) return false;
  const base = parts[parts.length - 1];
  if (RUNTIME_DATA_FILES.includes(base)) return true;
  // providers.json.tmp / routes.json.bak-20260101-… 这类同上
  if (RUNTIME_DATA_FILES.some(name => base.startsWith(name + '.'))) return true;
  // *.bak / *.bak-mixui-* / *.bak-* —— 手工排查时留下的备份也可能带凭据
  if (/\.bak([-.].*)?$/.test(base)) return true;
  // 任一路径段落在运行目录里(logs/ backups/ .run/)
  if (parts.some(seg => RUNTIME_DATA_DIRS.includes(seg))) return true;
  return false;
}

// 在 RELEASE_ITEMS 基底里(文件精确匹配,目录前缀匹配)。
function inBase(relPath) {
  const rel = normalize(relPath);
  if (!rel) return false;
  return INCLUDE.some(item => rel === item || rel.startsWith(item + '/'));
}

function isExcluded(relPath) {
  const rel = normalize(relPath);
  if (!rel) return true;
  if (isRuntimeData(rel)) return true;
  return EXCLUDE.some(e => rel === e.path || rel.startsWith(e.path + '/'));
}

// 制品要不要收这个相对路径。**先看基底,再排运行数据,再排显式排除** ——
// 顺序重要:即使有人把 providers.json 加进 RELEASE_ITEMS,isRuntimeData 也会先挡住它。
function include(relPath) {
  const rel = normalize(relPath);
  if (!rel) return false;
  return inBase(rel) && !isExcluded(rel);
}

// 路径能不能安全地穿过 workflow 里的 shell 分词。
//
// workflow 用 `git archive ... $(cat /tmp/archive-files.txt)` 拿到这份清单——故意不加引号,
// 靠 IFS 把多行拆成参数(加引号会被当成**一个**巨大路径)。代价是路径必须只含 ASCII
// 路径字符:`lib/a b.js` 会被拆成两个参数,`*.js` 会被 glob 展开。真出现这种路径时,
// 把它放进制品而不是报错,会得到"打包命令看着成功、文件却拆错"的静默损坏,所以这里
// 宁可**让打包直接失败**。
function shellSafe(rel) {
  return /^[A-Za-z0-9._/-]+$/.test(rel);
}

// 把一份"HEAD 里已跟踪的文件清单"过成制品文件清单:**逐个文件**判定,不整目录收。
//
// 为什么不用 `git archive HEAD lib public …` 这种目录路径参数(它本来更省事):
// 目录参数是**整棵子树照收**,只认 git 的跟踪状态,不认这份清单。实测过一个反例:
// 有人 `git add -f public/providers.json` 之后,`git archive HEAD public/` 会把它收进去,
// 而 include('public/providers.json') 是 false —— 也就是说"显式清单"在目录参数下退化成
// 了"git 跟踪了什么"。逐文件过滤把这条缺口从源头堵死:清单说不要的,**任何位置**都进不去。
//
// 代价是新增文件必须先被 git 跟踪才进包 —— 对"从 tag 发布的制品"这不是代价,tag 本就
// 只覆盖已提交内容;相对的,清单漏了某个已提交文件时,check() 会立刻红出来。
//
// 命中清单但路径含 shell 元字符时**抛错**,不静默丢弃:那意味着 workflow 会少打或多打文件,
// 是必须有人看见的问题,不是可以跳过的一行。
function filterTracked(paths) {
  const hits = [...new Set(paths.map(normalize).filter(Boolean))].filter(include).sort();
  const unsafe = hits.filter(p => !shellSafe(p));
  if (unsafe.length) throw new Error(`制品路径含 shell 元字符,无法安全打包: ${unsafe.join(', ')}`);
  return hits;
}

// 制品的身份信息。**故意不含时间戳**:同一份源码重复打包要得到逐字节相同的 tarball,
// 校验和才有核对价值;发布时间由 git tag 与 Release 本身承载。
//
// revision 与 codeRevision 是两回事,不能混:
//   · revision      = `git rev-parse HEAD`,对外可核对的源码修订;
//   · code_revision = lib/runtime-code.js 的 codeRevision(),运行期"代码是否被换过"的
//     指纹(它只哈希 mixrouter.js + lib/**.js,与 git 无关)。两个值都给出,方便用户
//     在机器上对着线上进程自报的指纹核对。
function releaseInfo({ version, revision, codeRevision = null } = {}) {
  const ver = String(version == null ? '' : version).trim();
  const rev = String(revision == null ? '' : revision).trim();
  if (!ver) throw new Error('releaseInfo: 缺少 version(package.json 的 version)');
  if (!/^[0-9a-f]{40}$/.test(rev)) throw new Error(`releaseInfo: revision 必须是 40 位十六进制 git SHA,实得 ${JSON.stringify(rev)}`);
  if (codeRevision != null && !/^[0-9a-f]{64}$/.test(String(codeRevision).trim()))
    throw new Error(`releaseInfo: code_revision 必须是 64 位十六进制,实得 ${JSON.stringify(codeRevision)}`);
  return {
    _说明: 'revision 是 git 源码修订;code_revision 是运行期源码指纹(只哈希 mixrouter.js 与 lib/**.js)。两者都不是版本号。',
    name: 'mixrouter',
    version: ver,
    revision: rev,
    revision_short: rev.slice(0, 12),
    code_revision: codeRevision == null ? null : String(codeRevision).trim(),
  };
}

// 递归列出目录下的文件(仓库相对路径,正斜杠)。只服务 check() 与 CLI。
function walkFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`, rel);
      else out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

// 校验一个解包后的制品目录。CI 用来做"制品内容校验",单测也用它验证检查逻辑本身。
// 两件事:不含运行数据、含关键入口。
function check(dir) {
  const files = walkFiles(dir);
  const errors = [];
  for (const rel of files) if (isRuntimeData(rel)) errors.push(`制品含运行数据: ${rel}`);
  for (const need of REQUIRED_ENTRIES) if (!files.includes(need)) errors.push(`制品缺少关键入口: ${need}`);
  // 维护类条目全是文件(见 REQUIRED_MAINTENANCE_ENTRIES);目录形态的条目按前缀判,留着不碍事。
  for (const need of REQUIRED_MAINTENANCE_ENTRIES)
    if (!files.some(rel => rel === need || rel.startsWith(need + '/'))) errors.push(`制品缺少维护条目: ${need}`);
  return { ok: errors.length === 0, errors, files, required: REQUIRED_ENTRIES, maintenance: REQUIRED_MAINTENANCE_ENTRIES };
}

// 仓库根(本文件在 scripts/ 下)与 package.json 的版本 —— 发版工作流的 tag 校验要用。
// 只读一个 JSON 文件;不读 git,所以 require 本模块仍然没有副作用。
function packageVersion(root = path.join(__dirname, '..')) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = String(raw.version == null ? '' : raw.version).trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`package.json 的 version 不是 x.y.z 形式: ${JSON.stringify(version)}`);
  return version;
}

// tag(如 refs/tags/v3.6.1 或直接 v3.6.1)与 package.json 的 version 必须相等。
// 不等就是"发出去的制品说自己是一个版本、实际是另一个版本",没有任何后续步骤能发现它,
// 所以发版工作流在这里**直接失败**。允许 tag 带 `v` 前缀,也允许 tag 不带它。
function checkTag(tag, version) {
  const name = String(tag == null ? '' : tag).trim().replace(/^refs\/tags\//, '');
  const ver = String(version == null ? '' : version).trim();
  if (!name) throw new Error('checkTag: 缺少 tag');
  if (!ver) throw new Error('checkTag: 缺少 version');
  const bare = name.startsWith('v') ? name.slice(1) : name;
  if (bare !== ver) throw new Error(`tag 与 package.json 的 version 不一致: tag=${JSON.stringify(name)} version=${JSON.stringify(ver)}`);
  return { tag: name, version: ver };
}

// 入口文件里自报的 VERSION(`const VERSION = '3.6.1';`)。运行期横幅、/healthz、控制台
// 都读它;它和 package.json 分叉时,用户看到的版本号会是错的,而两处各自都"合法"。
function entryVersion(root = path.join(__dirname, '..')) {
  const src = fs.readFileSync(path.join(root, 'mixrouter.js'), 'utf8');
  const match = /^const VERSION = '([^']+)';/m.exec(src);
  if (!match) throw new Error('mixrouter.js 里找不到 `const VERSION = \'...\';` 这一行');
  return match[1];
}

// 三处版本必须一致:tag(发版时) / package.json / mixrouter.js 的 VERSION。
// tag 可以缺席(本地核对、CI 的 push/PR 构建),此时只比后两处。
function checkVersions({ tag = null, version, entry = null } = {}) {
  const ver = String(version == null ? '' : version).trim();
  if (!ver) throw new Error('checkVersions: 缺少 version');
  const entryVer = entry == null ? entryVersion() : String(entry).trim();
  if (entryVer !== ver)
    throw new Error(`mixrouter.js 的 VERSION 与 package.json 的 version 不一致: VERSION=${JSON.stringify(entryVer)} version=${JSON.stringify(ver)}`);
  if (tag != null) checkTag(tag, ver);
  return { version: ver, entry: entryVer, tag: tag == null ? null : String(tag).trim().replace(/^refs\/tags\//, '') };
}

// ---------------------------------------------------------------- CLI
// 只服务 workflow 与人工核对:`paths` 打印给 `git archive` 的路径参数,
// `release-info` 产出写进制品的 RELEASE-INFO.json,`check` 校验解包结果。
//
// `paths` 要读 git 里的已跟踪文件,所以用 child_process —— 但**只在 CLI 分支里**调,
// require 本模块仍然零副作用(测试与其它消费方不受影响)。
function trackedFiles(cwd = process.cwd()) {
  const { execFileSync } = require('node:child_process');
  // -z:文件名按 NUL 分隔,含空格/换行的路径不会被拆错;-r:递归到文件,不带目录条目。
  const out = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return out.toString('utf8').split('\0').filter(Boolean);
}

function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (cmd === 'paths') {
    let tracked;
    try { tracked = trackedFiles(); }
    catch (e) { process.stderr.write(`无法读取 git 跟踪文件(需要完整仓库、且 HEAD 可解析): ${e.message}\n`); return 1; }
    const paths = filterTracked(tracked);
    if (!paths.length) { process.stderr.write('制品清单命中为空,拒绝继续\n'); return 1; }
    process.stdout.write(paths.join('\n') + '\n');
    return 0;
  }
  if (cmd === 'release-info') {
    const arg = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : null; };
    try {
      const info = releaseInfo({ version: arg('version'), revision: arg('revision'), codeRevision: arg('code-revision') });
      process.stdout.write(JSON.stringify(info, null, 2) + '\n');
      return 0;
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
  }
  if (cmd === 'version-check') {
    // 参数:--tag <tag> 可选(发版时传 GITHUB_REF_NAME)。不给就只核 package.json 与入口 VERSION。
    const i = rest.indexOf('--tag');
    const tag = i >= 0 ? rest[i + 1] : null;
    if (i >= 0 && !tag) { process.stderr.write('--tag 缺少值\n'); return 1; }
    try {
      const result = checkVersions({ tag, version: packageVersion() });
      process.stdout.write(`版本一致:${result.version}${result.tag ? `(tag ${result.tag})` : ''}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
  }
  if (cmd === 'check') {
    const dir = rest[0];
    if (!dir) { process.stderr.write('用法: node scripts/release-manifest.js check <解包目录>\n'); return 1; }
    const result = check(dir);
    if (result.ok) {
      process.stdout.write(`制品校验通过:${result.files.length} 个文件,关键入口与维护条目齐全,无运行数据\n`);
      return 0;
    }
    for (const line of result.errors) process.stderr.write(`${line}\n`);
    return 1;
  }
  process.stderr.write('用法:\n'
    + '  node scripts/release-manifest.js paths                  # 打印要交给 git archive 的文件路径(读 git 跟踪列表后按清单过滤)\n'
    + '  node scripts/release-manifest.js release-info --version <v> --revision <40位sha> [--code-revision <64位哈希>]\n'
    + '  node scripts/release-manifest.js check <解包目录>        # 校验制品内容(运行数据、关键入口、维护条目)\n'
    + '  node scripts/release-manifest.js version-check [--tag <tag>]  # 核对 tag / package.json / 入口 VERSION 三处一致\n');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = {
  INCLUDE, INCLUDE_WHY, EXCLUDE, RUNTIME_DATA_FILES, RUNTIME_DATA_DIRS,
  REQUIRED_ENTRIES, REQUIRED_MAINTENANCE_ENTRIES,
  normalize, inBase, isRuntimeData, isExcluded, include, filterTracked, releaseInfo, check,
  packageVersion, checkTag, entryVersion, checkVersions, main, trackedFiles,
};
