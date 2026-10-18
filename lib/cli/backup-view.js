'use strict';
// 备份清点的**呈现层**:把 lib/backup/inventory.js 的清点结果摊成命令行 / JSON 的形状,
// 再打成人读的文本。
//
// 这一层与 `GET /api/backups` 的血缘关系最近:两边服务于同一件事,结果形状**共有字段**
// (id/dir/ok/total/legacy/backups/unparsable/next_delete/next_delete_count)同名同义。
// 命令行另有几个只服务于文本输出的字段(label 是给人看的名字、unreadable 是读不到的条目、
// retention_rule / retention_assumption 是那条删除规则的原文),端点不带。
//
// 呈现层不碰平台:不读 providers.json、不碰 _state.store、不发请求。

const path = require('path');
const { listBackups } = require('../backup/inventory');

const BACKUPS_KEEP = 5;   // = mixrouter.js BACKUP_KEEP(lib/backup/inventory.js 的 DEFAULT_KEEP 同值)

// 前缀过滤按**基名**比(与清点模块的 base 归一一致):用户敲 `settings.json` 与敲一个完整路径,
// 应当落到同一处。空串视为"没给",不是"匹配所有"。
function matchesBase(loc, prefix) {
  if (!prefix) return true;
  return path.basename(loc.file).startsWith(prefix);
}

// 一个位置的清点。目录不在时**不抛**:~/.codex 在没装 codex 的机器上根本不存在,那是常态,
// 不是错误 —— 但也不是静默跳过,状态会带着 ENOENT 进结果,调用方看得见"这里查过、没有"。
//
// 返回**摊平**的形状,而不是把 listBackups 的结果整份塞进一个 listing 字段:
// JSON 输出与 `GET /api/backups` 服务于同一件事,两边给出两套套法
// (shell 里 `.dirs[0].listing.total`、端点上 `.dirs[0].total`)是白送给调用方的坑。
//
// 备份条目里命令行多给一个**全长** sha256:端点是只读接口,少给一点是一点;而命令行就在本机,
// 给全长才有"核对这份备份完整没坏"这个用法(打印时仍只用前 12 位)。
function scanLocation(loc, keep = BACKUPS_KEEP) {
  let listing;
  try { listing = listBackups({ dir: loc.dir, base: loc.file, keep }); }
  catch (e) {
    return { id: loc.id, label: loc.label, file: loc.file, dir: loc.dir, ok: false,
      error: { code: e.code || 'list_failed', message: e.message }, backups: [], unparsable: [], unreadable: [], next_delete: [] };
  }
  return {
    id: loc.id, label: loc.label, file: loc.file, dir: loc.dir, ok: true,
    total: listing.total, legacy: listing.legacyCount,
    backups: listing.entries.map(e => ({
      name: e.name, size: e.size,
      // 时间统一用 entries 现成的 `iso`(= ts 的 ISO 写法),不在这里另造一个。
      // 三个出口都只认这一个字段名,免得同一份数据出现 iso / ts / mtime 三种写法;
      // 要跟磁盘 mtime 对照的地方用 inventory 的 mtimeMs,那是它唯一的用途。
      iso: e.iso,
      mode: e.mode.toString(8).padStart(3, '0'), sha256: e.sha256, sha256_12: e.sha256 ? e.sha256.slice(0, 12) : null,
      legacy: e.legacy,
    })),
    unparsable: listing.unparsable.map(u => ({ name: u.name, reason: u.reason, message: u.message })),
    unreadable: listing.unreadable.map(u => ({ name: u.name, reason: u.reason, code: u.code || null, type: u.type || null })),
    next_delete: listing.retention.wouldDeleteOnNextBackup,
    next_delete_count: listing.retention.wouldDeleteCount,
    future_dated: listing.retention.futureDated,
    retention_rule: 'backupFile 原规则:startsWith 捞池 -> .sort() 字典序 -> 删前 max(0, len - keep) 个',
    retention_assumption: listing.retention.assumption,
  };
}

// 短摘要。这里刻意**不**用 mixrouter.js 的 maskKey(掐头 6 位 + 去尾 4 位):那是给 api key 用的,
// sha256 不是凭据,但"掐头去尾"的写法套在摘要上会造出一个看着像摘要、实际核对不了完整性的片段。
// 前 12 位是十六进制摘要的常规短写,想核对就自己比全长。
const shortSha = sha => (sha ? sha.slice(0, 12) : '-');
const sizeOf = n => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`);

// 差异条目里的 from/to 是 compare.js 的**单元格**形状 `{value, redacted, reason,...}`,
// 不是裸值。直接 JSON.stringify 会把 `{"value":"x","redacted":false,...}` 打出来 ——
// 人读的是值,不是那个信封;而把它整个打出来还会让人以为"reason 也是给你看的正文"。
const cellText = cell => JSON.stringify(cell && typeof cell === 'object' && 'value' in cell ? cell.value : cell);

// 打印时用 log 之外还能喂进来(测试要抓文本,不想去截 process.stdout)
function printBackups(result, log = console.log) {
  log(`备份保留上限: ${result.keep} 份(规则见 lib/backup/inventory.js computeRetention;本命令只清点,不删任何东西)`);
  for (const loc of result.dirs) {
    log(`\n[${loc.id}] ${loc.label}  ${loc.file}`);
    if (!loc.ok) {
      log(`  无法清点 [${loc.error.code}]: ${loc.error.message}`);
      continue;
    }
    log(`  共 ${loc.total} 份(历史秒级格式 ${loc.legacy} 份)`);
    for (const e of loc.backups) {
      const t = e.iso.replace('T', ' ').slice(0, 19);
      log(`  ${e.name}\n    ${sizeOf(e.size)}  ${t}Z  权限 ${e.mode}  sha256 ${shortSha(e.sha256)}${e.legacy ? '  [历史格式:无毫秒,不保证唯一]' : ''}`);
    }
    for (const u of loc.unparsable) log(`  ${u.name}\n    前缀命中但解析不出时间: ${u.message}(它照样占保留池名额)`);
    for (const u of loc.unreadable) log(`  ${u.name}\n    读不到: ${u.reason}${u.code ? ' ' + u.code : ''}${u.type ? ' ' + u.type : ''}`);
    const w = loc.next_delete;
    log(`  下一次备份会删: ${w.length ? w.join(', ') : '(无)'}${w.length ? '' : ' —— 池子还没到上限'}`);
    if (loc.future_dated.length) log(`  注意: 池子里有时间戳晚于当前时刻的名字(${loc.future_dated.join(', ')}),上面的删除集合是按"时钟不倒走"推的`);
    log(`  ${loc.retention_assumption}`);
  }
  if (result.diff) printDiff(result.diff, log);
}

function printDiff(diff, log = console.log) {
  const r = diff.result;
  log(`\n差异预览 ${diff.backup}`);
  log(`  备份:   ${diff.backupPath}`);
  // 推出来的现役文件必须自报来源。少这一行,用户会以为 file 是自己指定的,而它其实是猜的。
  log(`  现役:   ${diff.file}${diff.fileInferred ? '   ⚠ 由备份名推出,未经确认' : '   (--file 显式指定)'}`);
  log(`  ${diff.fileSource}`);
  log(`  (added=备份之后新增 / removed=备份之后被删 / changed=两边都有但值不同)`);
  // 已知值层缺席:这条提示是"结果可能没盖全"的唯一出口,不能省。
  log(`  脱敏:   形状层已生效(${r.redaction.masked} 处) — ${diff.redaction.note}`);
  if (!r.ok) return log(`  预览失败:${JSON.stringify(r.errors)}`);
  log(`  ${r.identical ? '与现役文件完全一致' : `新增 ${r.added.length} / 删除 ${r.removed.length} / 变化 ${r.changed.length}`}  格式 ${r.format}`);
  for (const a of r.added) log(`    + ${a.key} = ${cellText(a)}`);
  for (const rem of r.removed) log(`    - ${rem.key} = ${cellText(rem)}`);
  for (const c of r.changed) log(`    ~ ${c.key}: ${cellText(c.from)} -> ${cellText(c.to)}`);
  for (const n of r.notes || []) log(`    · [${n.id}] ${n.message}`);
}

module.exports = { BACKUPS_KEEP, matchesBase, scanLocation, shortSha, sizeOf, cellText, printBackups, printDiff };
