'use strict';
// 备份池的**唯一**一张目标表:本产品里哪些文件会被 backupFile 备份、它们各在哪个目录。
//
// 为什么单列一个模块,而不是让两个调用方各列一份:
//   这张表原本在 mixrouter.js 的 /api/backups 分支与 mixctl 的 backupLocations() 里各写了一遍。
//   两份同一份知识的下场是**当场就分了叉**:CLI 那份多了个中文 label、端点那份没有;CLI 自己
//   用 `path.resolve(__dirname, '..')` 推 DATA_DIR 根,而端点用 PROVIDERS_FILE —— 后者是藏在
//   DATA_DIR 里的**文件名**,光看 dir 根本推不出来。两个出口报出不同的备份池,比只报一个更坏:
//   调用方会以为自己在看同一份东西。
//
// 为什么不放进 lib/backup/inventory.js:那个模块已复核、有独立测试盯着,而且它的职责是
// "给一个目录 + 一个 base,清点出什么"(纯函数,不碰环境)。"本产品有哪些备份池"是**装配知识**,
// 依赖环境变量与 HOME,两者混在一起会让 inventory 从"给参数就干活"变成"自己去找环境"。
// 分开之后 inventory 一个字节不用动。
//
// 依赖方向:本模块只 require node 内置。**不许 require mixrouter.js** —— 主文件 require 了
// lib/*,反向依赖会成环;而且 mixctl 是脚本,顶层有副作用,require 它会把 CLI 整个跑起来。

const path = require('node:path');
const os = require('node:os');

// 表项形状:{ id, label, file(env, root, home) -> 绝对路径 }。
// label 是给人看的名字,两个出口都要带上(端点也带)—— 一份表里的东西,不该只在其中一出口出现。
//
// 每一行的路径**不在这里另写一遍**,而是从下面的 LIVE_FILES 取 —— 那张表同时是
// mixrouter.js 的真值来源。表格与真值各存一份就是分叉的入口(见 LIVE_FILES 那节的实测)。
// 三个环境变量名必须与 mixrouter.js 逐字一致:测试靠它们把两处重定向到临时目录,
// 名字一旦分叉,测试会去清点一个空目录然后"通过"。
const DEFAULT_TARGETS = Object.freeze([
  { id: 'data', label: '数据目录', file: (env, root) => path.join(LIVE_FILES.dataDir(env, root), 'providers.json') },
  { id: 'claude', label: 'Claude 配置', file: (env, root, home) => LIVE_FILES.claudeSettings(env, home) },
  { id: 'codex', label: 'Codex 配置', file: (env, root, home) => LIVE_FILES.codexConfig(env, home) },
]);

// 解析成 [{ id, label, file, dir }]。dir 一律由 file 的 dirname 得出,不单独给 ——
// 两个字段各填一次就是下一次分叉的入口(备份就躺在活文件同目录,这是 backupFile 的性质)。
//
// root 必填且必须是绝对路径:它是 DATA_DIR 的默认值(见 mixrouter.js 的 DATA_DIR)。不校验的话,
// 传进来一个相对路径或写错的根,清点会**安安静静**地去另一个目录数出 0 份 —— 这正是本模块
// 要消灭的那种错(实测发生过:`path.resolve(__dirname, '..')` 少了一层,指到了仓库的父目录)。
function backupTargets(options = {}) {
  const { root, home = os.homedir(), env = process.env } = options;
  if (typeof root !== 'string' || !root || !path.isAbsolute(root)) {
    throw new TypeError(`backupTargets: root 必须是绝对路径,实得 ${JSON.stringify(root)}`);
  }
  return DEFAULT_TARGETS.map(({ id, label, file }) => {
    const resolved = file(env, root, home);
    return { id, label, file: resolved, dir: path.dirname(resolved) };
  });
}

// --- 与 mixrouter.js 共用的"活文件路径"真值 -------------------------------------
//
// 为什么要有这一节:**同一份知识写在两个地方,迟早分叉**。这张表原本只在 mixrouter.js 里
// (DATA_DIR / CLAUDE_SETTINGS / CODEX_CONFIG 三个常量),抽出来后两边各存一份同义默认值,
// 靠人眼维持一致 —— 而"靠人眼维持一致"的失败模式不是当场出错,是**很久以后在别处出错**。
//
// 实测过一次:把下面 claude 那条的默认值改成 WRONG-DEFAULT.json,`mixctl backups` 与
// `GET /api/backups` 的全部用例**仍然 26/26 绿** —— 因为测试全程设着 MIXR_CLAUDE_SETTINGS,
// 默认值分支根本走不到。**注入证明的不是"实现没问题",是"这里没有断言"。**
//
// 所以真值收到这里一份,mixrouter.js 从它取;`test/backup-cli.test.js` 里另有一条用例
// 断言"清点报出来的路径 == 主文件真正读写的那个路径",让**默认值分支也有断言**。
//
// ⚠ 这一节只描述**路径**,不读也不碰配置内容 —— 它不 require mixrouter.js(会成环),
// 也不读任何 key/token。
const LIVE_FILES = Object.freeze({
  // 数据目录根。providers.json 落在它里面(DATA_DIR 就是它)。
  dataDir: (env, root) => env.MIXR_DATA_DIR || root,
  // 客户端真实配置。改这两个文件**之前**都会先 backupFile 一份。
  claudeSettings: (env, home) => env.MIXR_CLAUDE_SETTINGS || path.join(home, '.claude', 'settings.json'),
  codexConfig: (env, home) => env.MIXR_CODEX_CONFIG || path.join(home, '.codex', 'config.toml'),
});

module.exports = { DEFAULT_TARGETS, backupTargets, LIVE_FILES };
