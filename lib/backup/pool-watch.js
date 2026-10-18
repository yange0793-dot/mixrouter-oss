'use strict';
// 备份池的**写前**预警:在 backupFile 真的删掉某一份之前,把"这一份会被顶掉"说出来。
//
// 为什么要有它(而不是复用现有两个只读口):`mixctl backups` 与 `GET /api/backups`
// 都只在**被读到时**才用 computeRetention 推算"下一份会删谁"——那是拉取模型,用户得先
// 想起来去看。生成备份的那条路径(lib/config-backup.js 的 backupFile)此前什么也不说:
// 超过保留上限时,最老的一份在 copyFileSync 之后被 unlinkSync 静默删掉,用户在删除
// **发生之后**才可能发现。本模块补的就是这个缺口:把删除**提前**告知。
//
// 与 inventory.computeRetention 的关系:规则只有一条真值,在 backupFile 里那三行
// (startsWith 捞池 -> 默认 .sort() 字典序 -> 删前 max(0, len - keep) 个)。
// 本模块**不重写**那条规则,只做两件事:①用 backupPrefix 捞池(与 backupFile 同源);
// ②把即将写入的新名字按同一套字典序排一遍,得出与 backupFile 将要做出的删除**同一个集合**。
// 排序必须与 backupFile 一致(字符串默认序),否则报出来的删除集合会与实际发生的不同
// ——那是最坏的一种报告:看着更专业,结论是错的。
//
// ⚠ **调用时机**:必须在 `copyFileSync` **之后**调(唯一调用方 lib/config-backup.js 就是
// 这么接的)。理由不是"先后无所谓",而是这份预警要报的**池子份数**必须是用户
// `ls` 一眼能看到的那个数 —— 那时新名字已经在盘上,池子就是 backupFile 马上要拿去删除的
// 同一个 readdir 结果,报出的份数与随后的删除逐项对得上。
//
// 本模块从写下来那天起,注释与自测都把时机写成了"copy 之前"(预演:`pool.concat([newName])`),
// 而调用方一直是 copy 之后才调 —— 契约与实现分叉,谁都没红,代价是新名字被数两遍、
// 报出的份数每多一份池子就多错一份。实测数据与改法见下面的 planDeletion。
//
// 名字模板与保留规则是**三处共读的契约**(见 lib/config-backup.js 文件头),
// 本模块只读不写那个契约。

const fs = require('node:fs');
const path = require('node:path');
const { backupPrefix, baseFromBackupName, parseBackupName } = require('./naming');

// 与 backupFile 同一个默认上限。不从 config-backup.js require 是为了不引入反向依赖:
// config-backup.js 在 lib/ 顶层(被 mixrouter.js 直接 require),而本模块在 lib/backup/,
// 两者互相 require 会成环。数值由 test/backup-pool-watch.test.js 断言与 DEFAULT_KEEP 同值。
const DEFAULT_KEEP = 5;

// 捞保留池。逐字照抄 backupFile 的过滤条件:`startsWith(base + '.bak-mixui-')`。
// **不做任何校验**(不查时间戳是否合法、不查是不是常规文件)——这是刻意的:
// backupFile 的删除集合就建立在这个粗糙的 startsWith 上,一个顶着前缀的目录或乱名
// 同样占池位、同样会被删。这里"顺手修好"就会算出一个与实际删除不同的集合。
function poolOf(dir, base) {
  const prefix = backupPrefix(base);           // base 非法时在这里抛,与 backupFile 同源
  return fs.readdirSync(dir).filter(f => f.startsWith(prefix)).sort();
}

// 推算"这次 backupFile 会删掉谁"。**纯函数**,不碰盘(除了 readdir 列目录)。
//   dir      备份所在目录(backupFile 恒把备份写在活文件同目录,见其注释)
//   base     活文件名(basename)
//   newName  这一次写下的那份备份名(basename),**调用时它已经在盘上了**。
//            undefined = 不关心是哪一次写入,只按现状报。
//   keep     保留上限
// 返回 { keep, poolSize, wouldDelete, deletesTheNewOne, rule, basis }
//
// ⚠ **调用时机是本函数的契约,不是调用方的自由**:必须在 `copyFileSync` **之后**调,
// 那时新名字已经躺在这个目录里、readdir 已经数得到它,于是池子就是 backupFile 马上要
// 用来删除的那个池子(它下面那三行也是 readdir + startsWith + sort)。
//
// 旧版假设"预警发生在 copy 之前",于是把 newName `concat` 进池子再算一次。但调用方
// lib/config-backup.js 一直是 copy 之后才调 —— 新名字被数了**两遍**,池子每多一份就多报一份。
// 实测(2026-09-27,在**改动前**的树上跑:5 份 providers 备份 + 3 份别的活文件的备份,
// 上限 5):预警报「保留池已满(**6**/5):本次备份将顶掉 **2** 份」,而实际只删 1 份,
// 池子也确实只有 5 份 —— 三个数里两个是错的,而"已满"更不成立。
// 这个池子现在由 providers.json **每次保存**都写入(见 mixrouter.js 的 saveStore),
// 所以这个数在日常路径上一直错着。
//
// 与 inventory.computeRetention 的差别:那个函数回答"下一份备份会删谁"(给清点用,它没有
// 一次具体的写入可依附,所以必须假设新名字排最后);本函数回答"**这一次**会删谁"。
function planDeletion({ dir, base, newName, keep = DEFAULT_KEEP } = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError(`planDeletion: dir 必须是非空字符串,实得 ${JSON.stringify(dir)}`);
  if (typeof base !== 'string' || !base) throw new TypeError(`planDeletion: base 必须是非空字符串,实得 ${JSON.stringify(base)}`);
  if (!Number.isInteger(keep) || keep < 0) throw new RangeError(`planDeletion: keep 必须是非负整数,实得 ${JSON.stringify(keep)}`);
  if (newName !== undefined && (typeof newName !== 'string' || !newName)) {
    throw new TypeError(`planDeletion: newName 若要给就必须是非空字符串,实得 ${JSON.stringify(newName)}`);
  }

  // 池子按 backupFile 那条**粗糙**的 startsWith 原样捞:顶着一个已删文件前缀的名字、
  // 目录、FIFO 都照样占池位、照样会被删(自测里有一条专门钉这个口径)。
  // `settings.json`(非 basename)仍然被吞进来,因为删除循环就是"去 dir 里 readdir + startsWith",
  // 在 dir 里这个前缀就是这个前缀 —— 与本文件顶部的说明一致,那不是新问题。
  const pool = poolOf(dir, base);
  const wouldDelete = pool.slice(0, Math.max(0, pool.length - keep));
  // 新名字是不是已经在池子里,由"本 base 的一份备份"这个定义回答,而不是由它在不在
  // `poolOf` 的结果里回答 —— 后者会把上面那条前融合并读成"新名字没写进去"。
  // 形状必须同时合法:预警要是报出一个永远不会落地的名字(带路径、时间戳不合法),
  // 那句"顶掉"就是在说一件不会发生的事。
  const isOurs = newName !== undefined
    && path.basename(newName) === newName
    && baseFromBackupName(newName) === base
    && parseBackupName(base, newName).ok;
  return {
    keep,
    poolSize: pool.length,
    wouldDelete,
    // 新名字自己在删除集合里 = 保留上限为 0 一类的退化情形,要说出来
    deletesTheNewOne: isOurs && wouldDelete.includes(newName),
    // 新名字没进池子说明调用时机的契约被破了(在 copy 之前就调了)。
    // 不抛 —— 预警的失败绝不能挡住备份本身(见 warnBeforeBackup)。报出来,让调用方自己看见。
    newNameVisible: newName === undefined ? false : pool.includes(newName),
    newNameIsOurs: isOurs,
    rule: 'backupFile 原规则:startsWith 捞池 -> .sort() 字典序 -> 删前 max(0, len - keep) 个',
    basis: newName === undefined ? '现状' : '现状(池子已含本次写入的新名字 —— 预警必须在 copy 之后调)',
  };
}

// 写前预警。**永不抛**:预警的失败绝不能挡住备份本身,更不能挡住后面的配置写入。
// 所以这里吞掉一切异常(目录不存在、权限不足、名字非法……)返回 { ok:false }。
//   onWarn 收到一句人话,调用方决定往哪儿送(控制台 / 日志 / 响应体)。
// 返回 { ok, warned, plan } —— ok:false 表示"没能算出预警",不是"没有要删的"。
function warnBeforeBackup({ dir, base, newName, keep = DEFAULT_KEEP, onWarn } = {}) {
  try {
    const plan = planDeletion({ dir, base, newName, keep });
    // 池子份数与"这次要删几份"是**两件事**,各说各的,不拼成"7/5"那种一个数两个含义的话。
    //
    // 旧版报的是 `保留池已满(${poolSize}/${keep})` —— 那句话把池子份数当成了"满没满"的
    // 唯一判据,而池子根本没满时它也在喊。实测(2026-09-27,探针手工造 6 份 + 备份 1 次):
    // 池子 6/5 且确实要删 1 份,预警却报「保留池已满(**7**/5):将顶掉 2 份」,
    // 三个数里两个是错的(7 是同一个新名字数了两遍,见 planDeletion)。
    // 现在拆开:池子多大就说多大,"确实要删几份"由删除集合自己说。
    const said = [];
    if (plan.poolSize > keep) {
      said.push(`[backup] ${base} 的备份池 ${plan.poolSize} 份,已超过保留上限 ${keep}。`);
    }
    if (plan.newNameIsOurs && !plan.newNameVisible) {
      // 只有一种成因:预警被安排在 copyFileSync **之前**了。那会让下面报出的删除集合
      // 与实际发生的对不上(新名字还没进 readdir),所以直说,而不是让调用方去猜。
      said.push('[backup] 预警是在本次备份落盘之前算的(池子里还看不到新名字),下面报的删除集合可能与实际不同。');
    }
    if (plan.wouldDelete.length > 0) {
      const who = plan.wouldDelete.join('、');
      const tail = plan.deletesTheNewOne
        ? `注意本次要写入的那一份也在其中(keep=${keep} 太小),它写完就会被删。`
        : '若要留下它,现在把它另存到别的目录。';
      said.push(`[backup] 本次备份将顶掉 ${plan.wouldDelete.length} 份 —— ${who}。${tail}`);
    }
    // warned ≡ "有没有要说的话",与 onWarn 传没传**无关** —— 判据只看算出来的结论。
    const warned = said.length > 0;
    if (warned && typeof onWarn === 'function') onWarn(said.join('\n'));
    return { ok: true, warned, plan, said };
  } catch (e) {
    return { ok: false, warned: false, error: e };
  }
}

module.exports = { DEFAULT_KEEP, poolOf, planDeletion, warnBeforeBackup };
