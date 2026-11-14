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
// 依赖方向:node 内置 + lib/paths.js。**不许 require mixrouter.js** —— 主文件 require 了
// lib/*,反向依赖会成环;而且 mixctl 是脚本,顶层有副作用,require 它会把 CLI 整个跑起来。
// LIVE_FILES 已收进 lib/paths.js(数据目录的解析必须只有一处),这里只转发不复制。

const path = require('node:path');
const os = require('node:os');
const { LIVE_FILES } = require('../paths');

// 表项形状:{ id, label, file(env, root, home) -> 绝对路径 }。
// label 是给人看的名字,两个出口都要带上(端点也带)—— 一份表里的东西,不该只在其中一出口出现。
//
// 每一行的路径**不在这里另写一遍**,而是从 lib/paths.js 的 LIVE_FILES 取 —— 那张表同时是
// 运行时配置的真值来源。表格与真值各存一份就是分叉的入口(见 paths.js 的 LIVE_FILES 一节)。
// 三个环境变量名必须与 paths.js 逐字一致:测试靠它们把两处重定向到临时目录,
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
// 这张表曾经定义在这里,后来收进了 lib/paths.js:数据目录现在还要考虑 `.run/data-dir`
// 指针文件,而服务端 /api/backups、mixctl backups、restore 必须与运行时用同一份解析。
// 留在这里就必然出现"backups 还按 MIXR_DATA_DIR || ROOT 拼、运行服务却按指针找"的分叉。
//
// 本文件只保留 DEFAULT_TARGETS(受管文件是哪几个)与 backupTargets(root/home/env 校验),
// 路径本身一律从 LIVE_FILES 取 —— 那张表是 paths.js 导出的同一个对象,不是复制品。
//
// ⚠ 只描述**路径**,不读也不碰配置内容 —— 它不 require mixrouter.js(会成环),
// 也不读任何 key/token。
module.exports = { DEFAULT_TARGETS, backupTargets, LIVE_FILES };
