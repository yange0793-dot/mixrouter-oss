#!/usr/bin/env node
'use strict';
// verify-release — 验收**消费者真正拿到的那份制品**,而不是工作树里的源码。
//
//   node scripts/verify-release.js                  # 按 HEAD + 制品清单打包 → 解包 → 校验 → 跑 doctor/smoke
//   node scripts/verify-release.js --dir <解包目录>   # 验收一个已经解好的制品目录
//
// 只有这两个入口:制品来源必须是**我们自己的产出** —— 默认从本仓库 HEAD 按制品清单打包,
// 或指向一个已经解包好的目录。刻意不提供"解任意 tarball 再执行"的模式:这条脚本会运行
// 制品里的代码,不该顺手成为一个"给我一个包我就跑"的通用入口。
//
// 为什么需要它:工作流里已有的 `release-manifest.js check` 只证明"解包里有什么",
// 证明不了"解包里的东西能跑"。两者之间隔着一整类事故 —— 漏了一个被 require 的模块、
// 代码悄悄依赖 `test/` 或 `.git`、静态资源路径写死在工作树里 —— 这些在源码仓库里
// 怎么跑都是绿的,要到用户解压后才会露出来。所以本脚本在**解包目录内**实跑:
//   · `npm run doctor -- --offline`:验证入口能加载、首次运行只有警告、且**不写数据**;
//   · `npm run smoke`:真实一进一出,临时 HOME / 数据目录 / 端口。
// 目录里没有 .git / test / node_modules,两条跑通才说明运行包不依赖源码仓库。
//
// **这不是安全扫描。** 它执行制品里的代码(doctor 与 smoke 都会 require 包内模块),
// 所以只在可信来源上跑:本仓库 HEAD 的产出,或你自己解开的发行包。它不审计代码、
// 不查依赖漏洞、不判断上游行为。
//
// 刻意不做的两件事:
//   · 不复制一份制品清单。纳入/排除规则只来自 `scripts/release-manifest.js`
//     (它又以 `lib/paths.js` 的 RELEASE_ITEMS 为基底),这里只调用。
//   · 不接触真实 HOME 与运行数据目录。环境变量先按前缀清空,再把所有落点重定向到
//     本次的一次性临时目录;端口由 smoke 自己向内核申请(它会断言避开 8787/8788)。
//
// 本模块无副作用:require 它不读 git、不碰磁盘,CLI 只在 `require.main === module` 分支里跑。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const manifest = require('./release-manifest.js');

const ROOT = path.resolve(__dirname, '..');
const SMOKE_TIMEOUT_MS = 300000; // 与整套测试入口同一量级;smoke 正常在 30s 内结束
const DOCTOR_TIMEOUT_MS = 120000;

// 消费者拿到的运行包里**不应该**出现的东西。它们不是"发布内容规则"(那在制品清单里),
// 而是本条验收的前提:解包目录里若有源码仓库的 .git、开发测试套件或 node_modules,
// 那么 smoke 通过也不能说明制品自足 —— 它可能只是恰好借到了源码仓库的材料。
const SOURCE_ONLY_ENTRIES = ['.git', 'node_modules', 'test'];

// ---------------------------------------------------------------- 参数
function parseArgs(argv = []) {
  const out = { mode: 'head', target: null, keep: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg === '--keep') { out.keep = true; continue; }
    if (arg === '--dir') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} 缺少值`);
      if (out.mode !== 'head') throw new Error('--dir 只能给一次');
      out.mode = 'dir';
      out.target = value;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }
  return out;
}

// ---------------------------------------------------------------- 隔离环境
// 与 `scripts/run-tests.js` / `scripts/smoke-offline.js` 同一口径:先清掉 MIXR_ /
// MIXROUTER_ / MIXUI_ 前缀的继承值(一个陈旧的 MIXR_DATA_DIR 就能让"隔离"写进真实
// 数据目录),再把 HOME / TMPDIR / 客户端配置落点全部指向本次临时目录。
//
// NODE_OPTIONS / NODE_PATH / NODE_TEST_CONTEXT 一并剔除:验收要模拟普通消费者,
// 不能让调用方 shell 或外层 node:test 往里注入 --require、额外模块搜索路径或 child-v8 上下文。
function scrubEnv(parent, dirs) {
  const env = {};
  for (const [key, value] of Object.entries(parent)) {
    if (/^(MIXR_|MIXROUTER_|MIXUI_)/.test(key)) continue;
    if (key === 'NODE_OPTIONS' || key === 'NODE_PATH' || key === 'NODE_TEST_CONTEXT') continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: path.join(dirs.home, '.config'),
    XDG_CACHE_HOME: path.join(dirs.home, '.cache'),
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    MIXR_DATA_DIR: dirs.data,
    MIXR_CLAUDE_SETTINGS: path.join(dirs.home, '.claude', 'settings.json'),
    MIXR_CODEX_CONFIG: path.join(dirs.home, '.codex', 'config.toml'),
    MIXR_ZCODE_CONFIG: path.join(dirs.home, '.zcode', 'v2', 'config.json'),
    MIXR_UPSTREAM_PROXY: '', // 明确的空值,不回落到调用方 shell 的隧道
    // npm 自己的缓存也放进临时目录,别在验证时往真实 HOME 写东西。
    npm_config_cache: path.join(dirs.tmp, 'npm-cache'),
    npm_config_update_notifier: 'false',
    NO_UPDATE_NOTIFIER: '1',
  };
}

function makeDirs(tempRoot) {
  // 故意**不建** data/:doctor 的"首次运行不写数据"要靠它仍然不存在来证明。
  const dirs = {
    home: path.join(tempRoot, 'home'),
    data: path.join(tempRoot, 'data'),
    tmp: path.join(tempRoot, 'tmp'),
  };
  fs.mkdirSync(dirs.home, { recursive: true });
  fs.mkdirSync(dirs.tmp, { recursive: true });
  return dirs;
}

// ---------------------------------------------------------------- 制品来源
// 打包**只从 HEAD 取内容**,与 release.yml 完全同源:
//   HEAD 里已跟踪的文件 → release-manifest 的 filterTracked 逐文件过滤 → git archive。
// 因此工作区里未提交的改动不会被误当成发布内容;清单里有路径尚未提交时,git archive
// 会直接失败,而不是静默少打一个文件。
function buildFromHead(sourceRoot, tarballPath) {
  // 运行包里没有 .git。在这里给出可执行的下一步,而不是把 git 的原始错误抛给用户。
  if (!fs.existsSync(path.join(sourceRoot, '.git')))
    throw new Error('默认模式需要完整 git 仓库(从 HEAD 打包);验收已解包的制品请用 --dir <目录>,或在该目录里直接 npm run smoke');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
  const paths = manifest.filterTracked(manifest.trackedFiles(sourceRoot));
  if (!paths.length) throw new Error('制品清单命中为空,拒绝打包');
  process.stdout.write(`打包源 HEAD ${revision.slice(0, 12)}:${paths.length} 个文件\n`);
  execFileSync('git', ['archive', '--format=tar.gz', '-9', '-o', tarballPath, 'HEAD', '--', ...paths],
    { cwd: sourceRoot, stdio: ['ignore', 'inherit', 'inherit'] });
  if (!fs.existsSync(tarballPath) || fs.statSync(tarballPath).size === 0)
    throw new Error(`git archive 没有产出有效文件: ${tarballPath}`);
}

// 只用于解开**本脚本刚从 HEAD 打出**的那份包;CLI 不提供解任意 tarball 的入口。
function extractTarball(tarballPath, destDir) {
  if (!fs.existsSync(tarballPath)) throw new Error(`tarball 不存在: ${tarballPath}`);
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarballPath, '-C', destDir], { stdio: ['ignore', 'inherit', 'inherit'] });
}

// ---------------------------------------------------------------- 校验与 smoke
function checkConsumerIndependence(dir) {
  const errors = [];
  for (const rel of SOURCE_ONLY_ENTRIES) {
    if (fs.existsSync(path.join(dir, rel)))
      errors.push(`解包目录含 ${rel}:smoke 必须不依赖源码仓库材料,否则通过也不能证明制品自足`);
  }
  return errors;
}

function runSmokeCommand({ cwd, env, timeoutMs }) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(npm, ['run', 'smoke'], { cwd, env, stdio: 'inherit', timeout: timeoutMs });
}

// `--offline` 不连任何端口;首次运行的数据目录还不存在,doctor 只应给出警告并退出 0。
function runDoctorCommand({ cwd, env, timeoutMs }) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(npm, ['run', 'doctor', '--', '--offline'], { cwd, env, stdio: 'inherit', timeout: timeoutMs });
}

// 目录树快照(相对路径,排序)。用来证明 doctor 只读:跑前跑后必须完全一致,
// 而不只是"没有我们认识的那四个配置文件"。
function listTree(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = [];
  const walk = (current, prefix) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  };
  walk(dir, '');
  return out;
}

// 对一份已解包的制品做完整验收。runSmoke / runDoctor 可注入,方便单测在不启动 npm
// 的前提下断言"cwd 就是解包目录、环境已重定向、doctor 未写数据",而不必把整套
// smoke 压进每个单测。
function verifyArtifact(artifactDir, {
  dirs, runSmoke = runSmokeCommand, runDoctor = runDoctorCommand,
  checkArtifact = manifest.check, independence = checkConsumerIndependence,
} = {}) {
  const dir = path.resolve(artifactDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`解包目录不存在: ${dir}`);
  if (!dirs) throw new Error('verifyArtifact: 缺少隔离目录(home/data/tmp)');

  const checked = checkArtifact(dir);
  if (!checked.ok) throw new Error('解包制品内容校验失败:\n' + checked.errors.join('\n')
    + '\n(默认模式只打包 HEAD 里已跟踪的文件;清单新增的路径若还没提交,先提交再验,或用 --dir 验收已解包的制品)');
  const leak = independence(dir);
  if (leak.length) throw new Error(leak.join('\n'));

  const env = scrubEnv(process.env, dirs);

  // 1) 自检入口:能加载,首次运行只有警告(exit 0),且一个文件都不写。
  process.stdout.write('在解包目录实跑 npm run doctor -- --offline(临时 HOME/数据目录)\n');
  const dataBefore = listTree(dirs.data);
  const doctor = runDoctor({ cwd: dir, env, timeoutMs: DOCTOR_TIMEOUT_MS });
  if (doctor && doctor.error) throw new Error(`npm run doctor 无法启动: ${doctor.error.message}`);
  if (doctor && doctor.signal) throw new Error(`npm run doctor 被信号 ${doctor.signal} 终止`);
  if (!doctor || doctor.status !== 0) throw new Error(`npm run doctor --offline 在解包制品里失败(exit ${doctor && doctor.status});首次运行只应有警告`);
  const dataAfter = listTree(dirs.data);
  if (JSON.stringify(dataAfter) !== JSON.stringify(dataBefore)) {
    const extra = (dataAfter || []).filter(rel => !(dataBefore || []).includes(rel));
    throw new Error(`npm run doctor 写入了数据目录(应当只读): ${extra.join(', ') || '目录本身被创建'}`);
  }

  // 2) 真实一进一出。smoke 自己再建一份临时 HOME/数据目录与内核分配端口。
  process.stdout.write('在解包目录实跑 npm run smoke(临时 HOME/数据目录,端口由内核分配)\n');
  const result = runSmoke({ cwd: dir, env, timeoutMs: SMOKE_TIMEOUT_MS });
  if (result && result.error) throw new Error(`npm run smoke 无法启动: ${result.error.message}`);
  if (result && result.signal) throw new Error(`npm run smoke 被信号 ${result.signal} 终止`);
  if (!result || result.status !== 0) throw new Error(`npm run smoke 在解包制品里失败(exit ${result && result.status});见上方输出`);
  return { files: checked.files.length };
}

// ---------------------------------------------------------------- CLI
// `--dir` 指着源码仓库跑,等于把"工作树能跑"当成"制品能跑"。但脚本本身也随包发布,
// 在解包制品里 ROOT 就是制品根,那里没有 .git —— 只有**带 .git 的仓库根**才拦,
// 否则会把制品里的 `--dir .` 误判成源码仓库。
function isDevCheckout(dir, root = ROOT) {
  return path.resolve(dir) === path.resolve(root) && fs.existsSync(path.join(root, '.git'));
}

function usage() {
  return '用法:\n'
    + '  node scripts/verify-release.js                 # 从 HEAD 按制品清单打包,解包后跑 doctor --offline 与 npm run smoke\n'
    + '  node scripts/verify-release.js --dir <目录>      # 验收一个已经解包的制品\n'
    + '选项:\n'
    + '  --keep   保留本次临时目录(排查失败时用)\n'
    + '\n只接受本仓库 HEAD 的产出或已解包的制品目录;脚本会执行目录内的代码,不是静态安全扫描。\n';
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${usage()}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }

  // 临时根目录由本脚本自建,也由本脚本清理(HOME/TMPDIR/数据目录都在它下面)。
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-verify-release-'));
  let code = 0;
  try {
    let artifactDir;
    if (args.mode === 'dir') {
      artifactDir = path.resolve(args.target);
      if (isDevCheckout(artifactDir, ROOT))
        throw new Error('--dir 指向源码仓库;验制品请解包到别处,或直接不带参数从 HEAD 打包');
    } else {
      artifactDir = path.join(tempRoot, 'artifact');
      buildFromHead(ROOT, path.join(tempRoot, 'mixrouter-head.tar.gz'));
      extractTarball(path.join(tempRoot, 'mixrouter-head.tar.gz'), artifactDir);
    }

    const dirs = makeDirs(tempRoot);
    process.stdout.write('只验本仓库 HEAD 产出或已解包的制品;下面会执行目录内代码,这不是静态安全扫描\n');
    const verified = verifyArtifact(artifactDir, { dirs });
    process.stdout.write(`\nRELEASE VERIFY PASS:${verified.files} 个文件;doctor --offline 只读通过,解包目录里的 npm run smoke 通过\n`);
  } catch (e) {
    process.stderr.write(`\nRELEASE VERIFY FAIL:${e.message}\n`);
    code = 1;
  } finally {
    if (args.keep) {
      process.stderr.write(`保留临时目录: ${tempRoot}\n`);
    } else {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (e) {
        process.stderr.write(`清理临时目录失败: ${e.message}\n`);
        code = 1;
      }
    }
  }
  return code;
}

if (require.main === module) process.exit(main());

module.exports = {
  SMOKE_TIMEOUT_MS, DOCTOR_TIMEOUT_MS, SOURCE_ONLY_ENTRIES, ROOT,
  parseArgs, scrubEnv, makeDirs, listTree, buildFromHead, extractTarball,
  checkConsumerIndependence, runSmokeCommand, runDoctorCommand, verifyArtifact, isDevCheckout, main, usage,
};
