'use strict';
// 客户端配置文件的读前备份。
//
// 谁在用它:mixrouter.js 里凡是**改写**客户端配置的地方,写之前都先调一次 backupFile,
// 让用户永远能从一堆 `<file>.bak-mixui-<时间戳>-<随机>` 里捡回被写坏的那份。
// 名字与保留规则同时被三处读:lib/backup/naming.js(从名字反推备份的是哪个文件)、
// lib/backup/inventory.js(按字典序推算下一份会顶掉谁)、以及 mixctl backups 的清点输出。
// 所以**模板字符串与保留池规则是契约,不是实现细节** —— 改这里要同步那三处。
//
// 保留池:同名前缀备份按**纯字典序**排序,删掉最前面 max(0, len - keep) 个。
// 字典序 = 时间序,只在时间戳段定长时成立,所以名字必须保住"定长前缀 YYYYMMDD-HHMMSS 在最前"。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// 保留池写前预警。依赖方向:config-backup(顶层) -> backup/pool-watch -> backup/naming
// -> node:path,单链无环。反向(backup/ 里 require 本模块)会成环,所以 pool-watch 的
// DEFAULT_KEEP 是各写一份 + 测试断言同值,不是 require 过来的 —— 别去"顺手统一"。
const poolWatch = require('./backup/pool-watch');

// 保留上限。= lib/backup/inventory.js 的 DEFAULT_KEEP(test/backup-inventory.test.js 断言两者同值)。
const DEFAULT_KEEP = 5;

// 备份文件名的模板。返回完整路径。
function backupNameFor(file, now = new Date(), rand = crypto.randomBytes(2).toString('hex')) {
  const z = n => String(n).padStart(2, '0');
  // 毫秒补到 3 位:-99 会被排在 -123 之后(字典序),补零才让"字典序=时间序"继续成立。
  // 原先是秒级,同一秒内两次备份会同名静默覆盖。
  return `${file}.bak-mixui-${now.getFullYear()}${z(now.getMonth() + 1)}${z(now.getDate())}` +
    `-${z(now.getHours())}${z(now.getMinutes())}${z(now.getSeconds())}` +
    `-${String(now.getMilliseconds()).padStart(3, '0')}-${rand}`;
}

// 备份一份文件,并把保留池收敛到 keep 份。文件不存在则什么都不做(没什么可备份的)。
// 返回备份路径,或 null(源文件不存在)。
//
// 保留池超限时,被顶掉的那几份在**删除发生之前**经 opts.onWarn 报出去(见
// lib/backup/pool-watch.js)。此前这条路径什么也不说:最老的一份在 copyFileSync 之后
// 被 unlinkSync 静默删掉,用户只能在事后发现。预警由 pool-watch 负责算集合与措辞,
// 本函数只传 onWarn 与即将写入的名字 —— 删除规则仍是本函数下面那三行,一字未动。
// 返回值里**不放**"删了哪几份":那个集合就是 pool-watch 报出来的同一批,多一个出口
// 就多一处要与它同步的口径(见 pool-watch 文件头"看着更专业、结论是错的"那条)。
function backupFile(file, opts = {}) {
  if (!fs.existsSync(file)) return null;
  const keep = Number.isInteger(opts.keep) ? opts.keep : DEFAULT_KEEP;
  const bak = opts.name === undefined ? backupNameFor(file) : opts.name;
  // COPYFILE_EXCL:撞名就让它抛,不做重试。名字已带毫秒+随机,撞车概率可忽略,这一道是
  // 最后防线;而 backupFile 的调用点外面没有 try/catch,重试或吞错会把"名字还不够唯一"
  // 这个信号藏起来——那正是本批要修的病症。
  fs.copyFileSync(file, bak, fs.constants.COPYFILE_EXCL);
  // 备份权限取源文件当时的 mode,再与 0600 取交:只收紧、不放松。
  // 不写成 `statSync(file).mode` 就收工——那是空操作:copyFileSync 本来就把 dst 设成
  // src 的 mode,再 chmod 成同一个值等于什么都没做(实测 644/600/400 三种源下
  // chmod 前后逐位相同)。
  // 不硬写 0600:backupFile 对 CLAUDE_SETTINGS 与 CODEX_CONFIG 两处生效(将来可能更多),
  // 硬写会把一个 0400 的源放宽成 0600,即"备份比源更松"——安全动机的改动不该让任何
  // 东西变松。`& 0o600` 的形状是单调收紧 min(src, 0600)。
  // 这里不套 catch:套上就等于"chmod 失败时回落到 copyFileSync 的平台行为",
  // 而摆脱对那个平台行为的依赖正是这一行的目的。
  fs.chmodSync(bak, fs.statSync(file).mode & 0o600);
  const dir = path.dirname(file); const base = path.basename(file);
  // 预警必须在 unlink 之前,而且必须在**上面那次 copyFileSync 之后**:预警报出的池子份数
  // 要与用户 `ls` 看到的、以及下面 actualOlds 将要删的那个池子**是同一个数**。
  // 传进来的 newName 是刚落地的那一份,此刻它已经在池子里 —— pool-watch 因此不再把它
  // 并第二遍(旧版并了,报出的份数每多一份池子就多错一份,见 pool-watch 文件头)。
  // 预警自身永不抛(见 pool-watch.warnBeforeBackup),配 base 而不是完整路径
  // 是因为 backupFile 下面的过滤用的是 basename 前缀。
  if (typeof opts.onWarn === 'function') {
    poolWatch.warnBeforeBackup({ dir, base, newName: path.basename(bak), keep, onWarn: opts.onWarn });
  }
  const olds = fs.readdirSync(dir).filter(f => f.startsWith(base + '.bak-mixui-')).sort();
  for (const f of olds.slice(0, Math.max(0, olds.length - keep))) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  return bak;
}

module.exports = { DEFAULT_KEEP, backupNameFor, backupFile };
