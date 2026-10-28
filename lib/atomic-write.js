'use strict';
// 原子写:同目录唯一临时文件 → fsync → rename 覆盖终名。
//
// 边界(别把"原子"读成"并发安全"):
//   保证   —— 终名要么是旧的完整内容,要么是新的完整内容;崩在 rename 之前,
//             终名原封不动,不会读到写了一半的文件。
//   不保证 —— 不丢更新。调用方只要是"读原文 → 改 → 整个覆盖"这种形状,
//             两个并发写者之间仍然是最后写者赢,与就地写没有区别。
//   不保证 —— 掉电后的持久性:rename 之后没有 fsync 目录。掉电可能让 rename
//             回退,那时终名是**旧的完整内容**,仍然不是坏文件。
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// 原子写时残留的临时文件长这样:`<file>.<毫秒>-<32 位十六进制>.tmp`。
// 单独一个正则,因为**判断"这是不是本模块的临时文件"这件事有两个读者**:writeFileAtomic
// 自己(下次写入不会撞上它 —— 名字唯一),以及调用方落盘前的备份(`saveJson` 的 backup 选项)。
// 后者要靠它把残留从备份池里排除掉,写两处就该分叉了。
const TMP_RE = /\.\d+-[0-9a-f]{32}\.tmp$/;
const uniqueSuffix = () => `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;

// 备份保留上限。= lib/config-backup.js 的 DEFAULT_KEEP 与 lib/backup/inventory.js 的
// DEFAULT_KEEP(test/atomic-write.test.js 断言三处同值)。
// 刻意不 require 过来:config-backup 会拉进 backup 那一条链,而本模块是被谁都 require 的底座。
const DEFAULT_BACKUP_KEEP = 5;

// 为什么临时名要唯一,而不是固定 `${file}.tmp`:
//   1) 固定名下两个并发写者会撞同一路径,互相把对方的半成品 rename 出去;
//   2) 残留会让 openSync(tmp, 'wx') 直接 EEXIST 抛错——上一进程崩在 rename 之前
//      留下的临时文件,会把之后**每一次**写入都变成失败。
//      (系统里现存的 `..codex-global-state.json.tmp-*` 就是这类残留的实证。)
// 唯一名 + rename 本身是原子的,所以选"名字唯一",不做启动时扫残留:
// 残留退化成同目录里的垃圾文件,不会让任何一次写入失败。
function writeFileAtomic(file, text, { mode = 0o600 } = {}) {
  const tmp = `${file}.${uniqueSuffix()}.tmp`;
  try {
    // 0600 在 rename 之前就位。顺序不能反:先 rename 再 chmod 的话,
    // 替换瞬间终名上挂的是一个按 umask 建出来的 inode(本机 022 ⇒ 0644),
    // 而这些文件里有上游 API key。
    const fd = fs.openSync(tmp, 'wx', mode);
    try {
      // openSync 的 mode 会被 umask 掩掉。0o600 被掩只会更紧,但调用方传 0o644 之类
      // 时结果会随 umask 漂。显式 fchmod 让落盘 mode 与调用方要求逐位相等。
      try { fs.fchmodSync(fd, mode); } catch {}
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

// 覆盖写 JSON。**唯一顺带备份的一个** —— 见下面 writeJsonAtomic 的 backup 选项。
//
// 为什么多一个 backup 选项,而不是让调用方自己在外面 copyFileSync 一份:
//   · 备份必须发生在**写入之前**,而且必须紧贴写入。想备份的那个文件(providers.json,
//     装着全部渠道的明文 key)在极端情况下(进程被 SIGKILL)会留下一份临时残留,
//     而那个残留正是**最后一次没写完的内容** —— 比旧备份新,比当前文件旧。恢复的优先级是
//     "临时残留 > 备份 > 当前文件":两者出于同一个目的、要在同一个时刻比较,各写一处
//     迟早会分叉(比如一边在写前、一边在写后,后者备份到的是坏文件)。
//   · 反过来,备份不该默认打开:每次 saveSlots / flushSessions 都复制一份是把写放大
//     塞进高频路径。所以这是个**显式**选项,默认 off。
// 备份职责委托给 backupFile(lib/config-backup.js):名字模板与保留池规则是全仓共读的
// 一套契约(见那里的文件头),这里不再造第二套。
function writeJsonAtomic(file, data, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2) + '\n';
  if (options.backup) {
    const keep = Number.isInteger(options.keep) ? options.keep : DEFAULT_BACKUP_KEEP;
    if (typeof options.onWarn === 'function') purgeTmpSiblings(file, options.onWarn);
    const { backupFile } = require('./config-backup');
    // 打不开最外层 require:config-backup -> backup/pool-watch -> backup/naming 是一条
    // 链,而 atomic-write 是**被谁都 require 的底座**,顶层引它会把这条链绑进每个用户的
    // require 图。惰性 require 之后,没开 backup 的调用方一个字节都不多加载。
    //
    // 明确写 keep:backupFile 的默认值(5)与这里的默认值是同一个数,但那是两处知识。
    // 传进去,让"这一份保留几份"只有 backupFile 说了算。onWarn 原样透传:
    // 覆盖掉池轮换时,预警要能一路走到 HTTP 响应体(见 mixrouter.js 的 backupWithWatch)。
    backupFile(file, { keep, onWarn: options.onWarn });
  }
  writeFileAtomic(file, text, options);
}

// 落盘前的**残留清理**:本模块的临时文件可能真的留在盘上。
//
// 为什么会有残留:`writeFileAtomic` 的 finally 里 unlink 临时文件,但**进程被 SIGKILL**
// (kill -9、launchd 强杀、掉电)时 finally 根本不执行,临时文件原地留下。
// 它本身是良性的(唯一名,不会让下一次写入失败),但**会被备份卷进去**:
//   · 名字是 `providers.json.<唯一后缀>.tmp` —— 与备份池的过滤条件
//     `startsWith('providers.json.')` 撞上,于是它占一个 keep 名额,还能顶掉一份真备份;
//   · 更要命的是内容 —— 它正是**最后一次写入没写完的那一半**。备份池最老的那份被清掉、
//     换进来一份半截 JSON,而"备份"这个词让人以为捡回来的至少是个完整文件。
// 所以:备份之前,把该目标自己的临时残留清掉(它们是写坏的那次留下的,没有任何抢救价值)。
//
// 只删**比对中的这个目标**:`<file>.<后缀>.tmp` 精确匹配,不碰别的目标、
// 不碰 *.bak-mixui-*(那是上一份备份,是本次真正要保护的东西)、不碰目录。
// 永远不抛:清理是尽力而为的顺手活,清不掉(权限、只读目录)不该让这次配置写入失败。
function purgeTmpSiblings(file, onWarn) {
  const dir = path.dirname(file); const base = path.basename(file);
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(base + '.')) continue;
    if (!TMP_RE.test(name)) continue;                 // 只认本模块的临时名,不碰备份
    const full = path.join(dir, name);
    try {
      const st = fs.lstatSync(full);
      // 只删常规文件与符号链接。同名的目录不该被一条"顺手清理"删掉 ——
      // 名字是我们生成的,但盘上的东西不一定是。
      if (!st.isFile() && !st.isSymbolicLink()) continue;
      fs.unlinkSync(full);
      removed++;
    } catch { /* 单份清不掉就算了,见上 */ }
  }
  if (removed) onWarn(`[atomic-write] ${base}: 落盘前清掉 ${removed} 份上次写入留下的临时残留(它们的名字会占备份池名额,内容还是半截的)`);
  return removed;
}

module.exports = { writeFileAtomic, writeJsonAtomic, uniqueSuffix, purgeTmpSiblings, TMP_RE, DEFAULT_BACKUP_KEEP };
