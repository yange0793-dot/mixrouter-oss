'use strict';
// mixctl data-dir:显示"运行数据目录现在解析到哪、为什么",以及可选的迁移。
//
// 这个命令存在的理由:数据目录可以从三个地方来(env / .run/data-dir 指针 / 代码目录默认),
// 而猜错目录的后果不是报错,是"去另一个空目录里读出一份空配置然后照常启动"。所以显示时
// 必须把**来源**和**指针文件原文**一起摆出来,不能只报一个最终路径。
//
// 迁移(--move)的纪律:
//   · 默认干跑,只有 --apply 才写盘;
//   · 先备份、再复制、复制完逐项核对文件数与大小,全部通过后才写指针;
//   · 任何一步失败都不写指针 —— 指针一改,下一次启动就换目录找数据,这是唯一不可含糊的一步;
//   · 不删除源文件、不重启服务:迁移是"复制 + 改指向",回退只需改回/删掉指针。
const fs = require('node:fs');
const path = require('node:path');
const paths = require('../paths');

const DATA_DIR_USAGE = 'mixctl data-dir\n' +
  'mixctl data-dir --move <绝对路径> [--apply]\n' +
  '  显示运行数据目录、来源(MIXR_DATA_DIR / .run/data-dir 指针 / 代码目录默认)与指针文件状态\n' +
  '  --move  迁移数据目录:默认干跑;--apply 才执行 备份→复制→校验→写指针(不重启服务,\n' +
  '          不修改 MIXR_DATA_DIR 或 plist;环境变量优先级高于指针文件)';

const fail = message => Object.assign(new Error(message), { code: 'invalid_arguments' });

function parseDataDirArgs(args) {
  const opts = { move: null, apply: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') {
      if (opts.apply) throw fail('--apply 不能重复');
      opts.apply = true;
    } else if (arg === '--move') {
      if (opts.move !== null) throw fail('--move 不能重复');
      const value = args[++i];
      if (!value || value.startsWith('-')) throw fail('--move 缺少目标目录');
      opts.move = value;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw fail(`无法识别的 data-dir 参数: ${arg};仅支持 --move / --apply / --help`);
    }
  }
  if (opts.apply && opts.move === null) throw fail('--apply 只能与 --move 一起使用');
  return opts;
}

const sourceLabel = info => {
  if (info.source === 'env') return '环境变量 MIXR_DATA_DIR';
  if (info.source === 'pointer') return `指针文件 ${info.pointer.file}`;
  return '默认(代码目录)';
};

function printDataDir(context) {
  const info = paths.resolveDataDir(context.env, context.root);
  context.log(`数据目录: ${info.dir}`);
  context.log(`来源:     ${sourceLabel(info)}`);
  const pointer = info.pointer;
  if (!pointer.exists) {
    context.log(`指针文件: ${pointer.file}(不存在)`);
  } else {
    const state = pointer.valid ? '有效' : `无效${pointer.error ? `(${pointer.error})` : ''}`;
    context.log(`指针文件: ${pointer.file}(${state})`);
    context.log(`内容:     ${pointer.value === null ? '(空)' : JSON.stringify(pointer.value)}`);
  }
  if (info.source === 'env') {
    context.log('说明:     环境变量优先级最高;指针文件即使存在也不会被采纳。');
  } else if (pointer.exists && !pointer.valid) {
    context.log('说明:     指针内容为空、不是绝对路径或指向不存在的目录,已忽略并回落。');
  }
  return info;
}

// ---- 迁移 ------------------------------------------------------------------

// 递归扫描一棵树,产出 "相对路径 -> 签名"。签名区分普通文件(大小)、目录、符号链接(目标)。
// 用它做复制前后的逐项核对:文件数、总字节数、每一项的类型与大小都必须一致。
function scanTree(dir) {
  const out = new Map();
  let files = 0;
  let bytes = 0;
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) out.set(rel, `l:${fs.readlinkSync(full)}`);
      else if (stat.isDirectory()) { out.set(rel, 'd'); walk(full, rel); }
      else {
        out.set(rel, `f:${stat.size}`);
        files++;
        bytes += stat.size;
      }
    }
  };
  walk(dir, '');
  return { entries: out, files, bytes };
}

function scanItem(file, isDir) {
  if (!isDir) {
    const stat = fs.statSync(file);
    return { entries: new Map([[path.basename(file), `f:${stat.size}`]]), files: 1, bytes: stat.size };
  }
  return scanTree(file);
}

function sameScan(a, b) {
  if (a.files !== b.files || a.bytes !== b.bytes || a.entries.size !== b.entries.size) return false;
  for (const [name, signature] of a.entries) if (b.entries.get(name) !== signature) return false;
  return true;
}

// 复制前的快照就是**校验基准**:复制目标必须与它逐项一致。不拿复制后的源目录再扫一遍 ——
// 源目录可能正被运行中的服务写日志,两次扫描不一致会把一次正确的复制判成失败。
function collectSource(source) {
  const files = [];
  for (const name of paths.RUNTIME_DATA_FILES) {
    const file = path.join(source, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.isFile())
      files.push({ name, size: stat.size, entries: new Map([[name, `f:${stat.size}`]]), files: 1, bytes: stat.size });
  }
  const dirs = [];
  for (const name of paths.RUNTIME_DATA_DIRS) {
    const dir = path.join(source, name);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (stat.isDirectory()) dirs.push({ name, ...scanTree(dir) });
  }
  return { files, dirs };
}

function runningServicePid(root) {
  let pid = 0;
  try { pid = Number(fs.readFileSync(paths.pidFile(root), 'utf8').trim()); } catch { return 0; }
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  try { process.kill(pid, 0); return pid; } catch { return 0; }
}

// 迁移前的安全备份。源目录本身不会被删除,所以这份备份防的是"复制写坏了源目录"之外的
// 人工失误(选错目标、迁移后误删源)。放在 <源>/backups/data-move-<时间戳> 下,不参与迁移清单,
// 所以不会被当成数据复制到新目录。
function backupSource(source, files, dirs) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(source, 'backups', `data-move-${stamp}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const { name } of files) {
    const dest = path.join(dir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(source, name), dest);
  }
  for (const { name } of dirs)
    fs.cpSync(path.join(source, name), path.join(dir, name), { recursive: true, preserveTimestamps: true });
  return dir;
}

function moveDataDir(opts, context) {
  const info = paths.resolveDataDir(context.env, context.root);
  const source = info.dir;
  if (!path.isAbsolute(opts.move)) throw fail(`迁移目标必须是绝对路径,实得 ${JSON.stringify(opts.move)}`);
  const target = path.resolve(opts.move);
  if (target === path.resolve(source)) throw fail('迁移目标与当前数据目录相同,无需迁移');

  const { files, dirs } = collectSource(source);
  // 目标不能落在"要被复制的目录"里面:比如把新数据目录放到 logs/ 下,复制 logs 时会
  // 试图把目标复制进它自己。放在源根的其他子目录是允许的(只复制白名单,不整目录扫)。
  for (const dir of dirs) {
    const srcDir = path.join(source, dir.name);
    if (target === srcDir || target.startsWith(srcDir + path.sep))
      throw fail(`迁移目标不能位于要复制的 ${dir.name}/ 目录内: ${target}`);
  }
  if (!files.length && !dirs.length)
    throw Object.assign(new Error(`数据目录 ${source}(来源:${sourceLabel(info)})里没有任何已知运行数据文件;` +
      '不接受"0 个文件也迁移成功"。先用 mixctl data-dir 核对来源'), { code: 'no_data' });

  context.log(`迁移计划: ${source} → ${target}`);
  context.log(`来源:     ${sourceLabel(info)}`);
  for (const file of files) context.log(`  文件 ${file.name}  ${file.size} B`);
  for (const dir of dirs) context.log(`  目录 ${dir.name}/  ${dir.files} 个文件, ${dir.bytes} B`);
  const runningPid = runningServicePid(context.root);
  if (runningPid) {
    context.log(`注意:     服务进程 pid ${runningPid} 正在运行。日志可能持续写入,复制校验可能因此失败`);
    context.log('          (失败不会改指针)。建议先 mixctl stop,迁移完成后再启动。');
  }
  if (info.source === 'env') {
    context.log(`注意:     当前 MIXR_DATA_DIR=${source} 的优先级高于指针文件。`);
    context.log('          本次只写指针;要让运行时真正换目录,还需同步更新 MIXR_DATA_DIR(或 LaunchAgent plist)并重启。');
  }

  if (!opts.apply) {
    context.log('干跑:未写入任何文件。确认后加 --apply 执行(备份→复制→校验→写指针)。');
    return;
  }

  // 目标目录:允许不存在;存在则必须是空目录 —— 不合并、不覆盖,避免把两份数据混在一起。
  let targetStat = null;
  try { targetStat = fs.statSync(target); } catch { targetStat = null; }
  if (targetStat) {
    if (!targetStat.isDirectory()) throw fail(`迁移目标已存在且不是目录: ${target}`);
    if (fs.readdirSync(target).length) throw fail(`迁移目标目录不是空的: ${target};换一个目录,或先人工清空`);
  }

  const backupDir = backupSource(source, files, dirs);
  context.log(`已备份源数据: ${backupDir}`);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    for (const { name } of files) {
      const dest = path.join(target, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(source, name), dest);
    }
    for (const { name } of dirs)
      fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true, preserveTimestamps: true });
  } catch (e) {
    throw Object.assign(new Error(`复制失败(${e.message});指针未改动,目标目录可能留有半成品:${target}`), { code: 'copy_failed' });
  }

  // 复制后核对:与**复制前的快照**逐项比较文件数、总字节数与每一项的类型/大小。
  // 不通过就不写指针。
  const mismatches = [];
  for (const file of files) {
    let dst;
    try { dst = scanItem(path.join(target, file.name), false); }
    catch { mismatches.push(`${file.name}:目标缺失或不可读`); continue; }
    if (!sameScan(file, dst)) mismatches.push(`${file.name}:${file.files} 个文件/${file.bytes} B ≠ 目标 ${dst.files}/${dst.bytes}`);
  }
  for (const dir of dirs) {
    let dst;
    try { dst = scanTree(path.join(target, dir.name)); }
    catch { mismatches.push(`${dir.name}/:目标缺失或不可读`); continue; }
    if (!sameScan(dir, dst)) mismatches.push(`${dir.name}/:${dir.files} 个文件/${dir.bytes} B ≠ 目标 ${dst.files}/${dst.bytes}`);
  }
  if (mismatches.length)
    throw Object.assign(new Error(`复制校验失败,指针未改动:${mismatches.join(';')}`), { code: 'verify_failed' });

  const pointerFile = paths.writeDataDirPointer(context.root, target);
  context.log(`复制校验通过: ${files.length} 个文件、${dirs.length} 个目录(文件数与大小一致)`);
  context.log(`指针已写入: ${pointerFile}`);
  context.log('下一步:     重启服务使运行进程改读新目录(mixctl restart,或重新 kickstart LaunchAgent)。');
  context.log('             本命令没有重启任何服务,也没有修改 MIXR_DATA_DIR / plist。');
}

function runDataDirCmd(args, context = {}) {
  const ctx = { root: context.root, env: context.env || process.env, log: context.log || console.log };
  try {
    const opts = parseDataDirArgs(args);
    if (opts.help) { ctx.log(DATA_DIR_USAGE); return 0; }
    if (opts.move === null) { printDataDir(ctx); return 0; }
    moveDataDir(opts, ctx);
    return 0;
  } catch (e) {
    ctx.log(`数据目录操作失败 [${e.code || 'data_dir_failed'}]: ${e.message}`);
    if ((e.code || '') === 'invalid_arguments') ctx.log(DATA_DIR_USAGE);
    process.exitCode = 1;
    return 1;
  }
}

module.exports = { DATA_DIR_USAGE, parseDataDirArgs, printDataDir, runDataDirCmd };
