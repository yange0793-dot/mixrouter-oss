'use strict';
// 备份清点。**只读** —— 这个模块里没有 unlink / rename / write 任何一个写文件的调用,
// 唯一的副作用是 open 与读。
//
// 为什么要有它:mixrouter.js 的 backupFile 每次切客户端配置前会把活文件复制一份,
// 代码注释里写着"备份文件是唯一能捡回来的东西",但**全仓没有任何代码读回这些备份** ——
// 生成一次、列一次目录(为了删老的),然后就再没人碰过。于是"捡回来"这个动作一直是人工的,
// 而人工的第一步是"盘上到底有哪些备份、哪一份是什么时候的"。本模块补的就是这一步。
//
// 三件刻意做对的事:
//   1) entries 按**时间序**排(ts),retention.pool 按**字典序**排。这两个序不是同一个东西,
//      把它们混成一个字段,调用方迟早会拿错的那个去做判断。名字里的时间戳在定长字段下
//      两个序恰好一致,但"恰好一致"不是契约 —— 池子里还混着解析不出时间的名字(见下条)。
//   2) 前缀命中但解析不出时间的名字**单列在 unparsable 里,不静默丢弃**。它们对排序没有贡献,
//      但对**保留池**有贡献:backupFile 的过滤只做 startsWith,一个叫
//      `settings.json.bak-mixui-backup` 的手工副本照样进池子、照样占一个 keep 名额,
//      还能顶掉一份真备份。这正是"清点"必须让人看见的东西。
//   3) retention 只**算**不删,并且按 backupFile 用的那条真实规则算(纯字典序、先落盘再删),
//      不是按"更合理"的规则算 —— 报告一个漂亮的、但和实际会发生的删除不一样的数,比不报更坏。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REASONS, backupPrefix, baseFromBackupName, parseBackupName } = require('./naming');

// 与 mixrouter.js 的 BACKUP_KEEP 同值。刻意不 require mixrouter.js:lib 下的模块不得反向
// 依赖主文件(主文件 require 了 lib/*,反向依赖会把 require 图变成环,测试里也没法单独加载)。
// 代价是这个常量有两份,所以这里写死一处、名字里带上来源,改名时能 grep 到。
const DEFAULT_KEEP = 5;                    // = mixrouter.js BACKUP_KEEP
const DEFAULT_HASH_MAX_BYTES = 1024 * 1024;   // 清点时给 sha256 的上限
const DEFAULT_READ_MAX_BYTES = 256 * 1024;    // readBackup 默认读回上限
const HASH_CHUNK = 64 * 1024;

function describeType(st) {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFIFO()) return 'fifo';
  if (st.isSocket()) return 'socket';
  if (st.isBlockDevice()) return 'block-device';
  if (st.isCharacterDevice()) return 'character-device';
  if (st.isFile()) return 'file';
  return 'unknown';
}

function notRegularFileError(file, st) {
  const type = describeType(st);
  return Object.assign(new Error(`${file} 不是常规文件(${type}),拒绝读取`), {
    code: 'E_NOT_REGULAR_FILE', type, path: file,
  });
}

// 打开时不跟随符号链接。调用方都已经 lstat 确认过是常规文件,这一道防的是
// "lstat 与 open 之间被换成符号链接"那个窗口 —— 只读工具没有理由接受这个窗口。
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

// 有上限的流式摘要。返回的 sha256 永远是**整个文件**的摘要,不是前缀的:
// 一旦读过的字节超过上限就整体放弃(sha256:null),而不是给一个"看着像摘要的前缀摘要" ——
// 后者会被当成可以用来核对完整性的东西,而它核对不了任何东西。
function sha256File(file, maxBytes) {
  const fd = fs.openSync(file, OPEN_FLAGS);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw notRegularFileError(file, st);
    const hash = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(HASH_CHUNK);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      total += n;
      if (total > maxBytes) return { sha256: null, bytes: total, hashSkipped: 'over-max-bytes' };
      hash.update(buf.subarray(0, n));
    }
    return { sha256: hash.digest('hex'), bytes: total, hashSkipped: null };
  } finally { fs.closeSync(fd); }
}

// 截断点往回退到 UTF-8 序列边界。不回退的话,一刀切在多字节字符中间会在结果里留下一个
// U+FFFD —— 那是个**看起来像文件里真有这个字符**的假字符,而它其实是我们自己切出来的。
function completeUtf8End(buf, end) {
  if (end === 0) return 0;
  let cont = 0;
  while (cont < 3 && end - cont - 1 >= 0 && (buf[end - cont - 1] & 0xC0) === 0x80) cont++;
  if (cont === 0) {
    // 末字节不是续接字节:它是序列首字节(0b11xxxxxx)就说明这一整个序列都被切掉了,退一格;
    // 是 ASCII 则边界本来就干净。
    return (buf[end - 1] & 0xC0) === 0xC0 ? end - 1 : end;
  }
  const lead = end - cont - 1;
  if (lead < 0) return 0;                       // 整段都是续接字节,没有可保留的起点
  const b = buf[lead];
  const need = (b & 0x80) === 0 ? 1
    : (b & 0xE0) === 0xC0 ? 2
      : (b & 0xF0) === 0xE0 ? 3
        : (b & 0xF8) === 0xF0 ? 4 : 1;
  return cont + 1 >= need ? end : lead;
}

function listBackups(options = {}) {
  const { dir, base, keep = DEFAULT_KEEP, maxBytes = DEFAULT_HASH_MAX_BYTES } = options;
  if (typeof dir !== 'string' || !dir) throw new TypeError(`listBackups: dir 必须是非空字符串,实得 ${JSON.stringify(dir)}`);
  const prefix = backupPrefix(base);            // base 不合法时在这里抛
  if (!Number.isInteger(keep) || keep < 0) throw new RangeError(`listBackups: keep 必须是非负整数,实得 ${JSON.stringify(keep)}`);
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new RangeError(`listBackups: maxBytes 必须是非负整数,实得 ${JSON.stringify(maxBytes)}`);

  const baseName = path.basename(base);
  // 目录不存在直接抛 ENOENT,不返回"零份备份":"没有备份"与"路径写错了"是两件事,
  // 把它们都变成空数组,前者的结论会被后者的输入悄悄冒充。
  const names = fs.readdirSync(dir).sort();
  const entries = [];
  const unparsable = [];
  const unreadable = [];

  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const parsed = parseBackupName(base, name);
    if (!parsed.ok) {
      unparsable.push({ name, reason: parsed.reason, message: REASONS[parsed.reason] || parsed.reason });
      continue;
    }
    const full = path.join(dir, name);
    // lstat 而不是 stat:名字命中了前缀不等于它是备份。目录、符号链接、设备文件都可能顶着
    // 这个前缀躺在同一个目录里,而"顶着前缀"正是 backupFile 会把它算进保留池的全部条件。
    let st;
    try { st = fs.lstatSync(full); }
    catch (e) { unreadable.push({ name, reason: 'stat-failed', code: e.code }); continue; }
    if (!st.isFile()) { unreadable.push({ name, reason: 'not-a-regular-file', type: describeType(st) }); continue; }
    let digest;
    try { digest = sha256File(full, maxBytes); }
    catch (e) { unreadable.push({ name, reason: 'read-failed', code: e.code }); continue; }
    entries.push({
      id: name, name, path: full,
      base: parsed.base, prefix: parsed.prefix, stamp: parsed.stamp,
      ts: parsed.ts, iso: parsed.iso, legacy: parsed.legacy, ms: parsed.ms, random: parsed.random,
      size: st.size, mode: st.mode & 0o777, mtimeMs: st.mtimeMs,
      sha256: digest.sha256, hashed: digest.sha256 !== null, hashSkipped: digest.hashSkipped,
    });
  }

  // 时间序。ts 相同时按名字排,让顺序**确定** —— 不稳定的排序会让两次清点给出两个顺序,
  // 而"哪一份更旧"是这里的全部结论。
  entries.sort((a, b) => (a.ts - b.ts) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const pool = names.filter(n => n.startsWith(prefix));
  const retention = computeRetention(pool, keep, entries);

  return {
    dir, base: baseName, prefix, keep,
    total: pool.length,
    entries, unparsable, unreadable,
    // 只数 entries 里的历史格式(能读回来的那些)。unreadable 里的名字解析成功但读不到,
    // 把它们算进来会让这个数既不是"能用的老备份数"也不是"老名字数",两头都不对。
    legacyCount: entries.filter(e => e.legacy).length,
    retention,
    order: 'entries 按 ts 升序(时间序);retention.pool 按字典序 —— 两个序不是同一个,别混用',
  };
}

// 保留池。规则**逐字照抄** backupFile 里那三行,不改良:
//   readdirSync(dir).filter(f => f.startsWith(base + '.bak-mixui-')).sort()
//   olds.slice(0, Math.max(0, olds.length - BACKUP_KEEP))
// 关键在 .sort() 是默认排序(UTF-16 码元序),而 startsWith 不校验时间戳是否合法。
// 把这两点"顺手修好",算出来的删除集合就和实际会发生的删除不一样了 —— 那是最坏的一种报告:
// 看着更专业,结论是错的。
function computeRetention(pool, keep, entries) {
  const sorted = pool.slice().sort();
  const total = sorted.length;
  // 当前已经超出上限的份数(此刻不再写新备份的话,下一次调用前盘上多出来的就是这些)。
  const overage = Math.max(0, total - keep);
  // 下一次备份先 copyFileSync 落盘、再列目录删 —— 新名字在池子里。新名字的时间戳比盘上所有
  // 名字都新,定长字段下"最新"必然排在字典序最后,所以被删的仍是池子的前 N 个。
  // 上限取 total:新名字还没存在,报告里不能出现一个磁盘上不存在的名字。
  const wouldDeleteCount = Math.min(total, Math.max(0, total + 1 - keep));
  // 上面那条"新名字排最后"的推理依赖时钟不倒走。盘上真有未来时间的名字时推理不成立,
  // 所以把它找出来单独说,而不是让调用方自己去信一个没有前提的结论。
  const now = Date.now();
  const futureDated = entries.filter(e => e.ts > now).map(e => e.name);
  return {
    keep, total, overage,
    rule: 'backupFile 原规则:startsWith 捞池 -> .sort() 字典序 -> 删前 max(0, len - keep) 个',
    pool: sorted,
    wouldDeleteOnNextBackup: sorted.slice(0, wouldDeleteCount),
    wouldDeleteCount,
    wouldKeepOnNextBackup: sorted.slice(wouldDeleteCount),
    futureDated,
    assumption: futureDated.length
      ? '盘上存在时间戳晚于当前时刻的名字,下一次备份的新名字未必排最后,删除集合可能与此处不同'
      : '假设下一次备份的名字排字典序最后(时钟不倒走),此时被删的就是池子前 N 个',
    deletesNothing: true,
  };
}

// 有上限地读回一份备份。上限是**截断**不是拒绝:预览要能看见"这文件很大",而不是拿到一个报错。
// 非常规文件一律拒绝(符号链接 / 目录 / 设备 / FIFO / socket)—— 备份是我们自己 copyFileSync
// 出来的常规文件,任何别的形态都不是它,读它只会把一个来源不明的流喂给调用方。
function readBackup(options = {}) {
  const { path: file, maxBytes = DEFAULT_READ_MAX_BYTES } = options;
  if (typeof file !== 'string' || !file) throw new TypeError(`readBackup: path 必须是非空字符串,实得 ${JSON.stringify(file)}`);
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new RangeError(`readBackup: maxBytes 必须是非负整数,实得 ${JSON.stringify(maxBytes)}`);

  const before = fs.lstatSync(file);              // 不跟随:符号链接在这里就被判掉
  if (!before.isFile()) throw notRegularFileError(file, before);

  const fd = fs.openSync(file, OPEN_FLAGS);
  let text; let truncated; let binary; let digest;
  try {
    const st = fs.fstatSync(fd);                  // lstat 与 open 之间可能被换过,以 fd 上的为准
    if (!st.isFile()) throw notRegularFileError(file, st);
    // 想读 maxBytes + 1 字节:多出来的那 1 字节只用来判断"还有没有"。但分配量还不能由调用方
    // 随便开 —— 取 min(maxBytes, size) 之后,缓冲区不会比这个文件本身更大。
    const want = Math.min(maxBytes, Number(st.size)) + 1;
    const buf = Buffer.allocUnsafe(want);
    let got = 0;
    while (got < want) {
      const n = fs.readSync(fd, buf, got, want - got, got);
      if (n <= 0) break;
      got += n;
    }
    truncated = got > maxBytes;
    const end = truncated ? completeUtf8End(buf, maxBytes) : got;
    const bytes = buf.subarray(0, end);
    text = bytes.toString('utf8');
    // 回程比对:解出来的文本再编码回去与原始字节不一致,说明这份"文本"不是 UTF-8。
    // 不报的话,一个二进制垃圾文件会安静地变成一串带 U+FFFD 的字符串被人当成配置正文读。
    binary = !Buffer.from(text, 'utf8').equals(bytes);
    digest = crypto.createHash('sha256').update(bytes).digest('hex');
    return {
      path: file, name: path.basename(file),
      size: Number(st.size), mode: st.mode & 0o777, mtimeMs: st.mtimeMs,
      maxBytes, bytesRead: end, truncated, text, binary, encoding: 'utf8',
      // 摘要算的是**这次返回的字节**。截断时它只是前缀的摘要,所以范围要一起说清楚,
      // 否则调用方会拿它去核对整个文件。
      sha256: digest, sha256Scope: truncated ? 'returned-prefix' : 'whole-file',
      naming: namingOf(file),
    };
  } finally { fs.closeSync(fd); }
}

function namingOf(file) {
  const name = path.basename(file);
  const base = baseFromBackupName(name);
  return base ? parseBackupName(base, name) : null;
}

module.exports = {
  listBackups, readBackup, computeRetention, sha256File, describeType, completeUtf8End,
  DEFAULT_KEEP, DEFAULT_HASH_MAX_BYTES, DEFAULT_READ_MAX_BYTES,
};
