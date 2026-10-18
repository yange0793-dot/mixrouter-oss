'use strict';
const { restoreBackup } = require('../backup/restore');

const RESTORE_USAGE = `用法: mixctl restore <备份名或路径> [--file <受管现役路径>] [--dry-run | --yes] [--json]
默认只预览,显式 --yes 才恢复。只接受原目录的受管备份,拒绝链接与缺失现役文件。
恢复前请停止对应客户端及路由器;成功后重启。--yes 与 --dry-run 不能同时使用。
TOML 仅接受普通表及单行字符串、布尔、十进制数;其他语法拒绝自动恢复。`;
const invalid = message => Object.assign(new Error(message), { code: 'invalid_arguments' });

function parseRestoreArgs(args) {
  const opts = { backup: null, file: null, yes: false, dryRun: false, json: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--yes', '--dry-run', '--json', '--file'].includes(arg)) {
      if (seen.has(arg)) throw invalid(`${arg} 不能重复`);
      seen.add(arg);
      if (arg === '--file') {
        const value = args[++i];
        if (!value || value.startsWith('-')) throw invalid('--file 缺少值');
        opts.file = value;
      } else opts[{ '--yes': 'yes', '--dry-run': 'dryRun', '--json': 'json' }[arg]] = true;
    } else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('-')) throw invalid('无法识别的 restore 选项');
    else if (opts.backup === null) opts.backup = arg;
    else throw invalid('只接受一份备份');
  }
  if (opts.yes && opts.dryRun) throw invalid('--yes 与 --dry-run 不能同时使用');
  if (!opts.backup && !opts.help) throw invalid('必须指定一份备份');
  return opts;
}

function runRestoreCmd(args, context = {}) {
  const log = context.log || console.log;
  try {
    const opts = parseRestoreArgs(args);
    if (opts.help) { log(RESTORE_USAGE); return; }
    const result = restoreBackup({ ...context, ...opts });
    if (opts.json) log(JSON.stringify(result, null, 2));
    else {
      log(result.restored ? '恢复成功' : '预览:未写入任何文件;确认后加 --yes 执行');
      log(`备份: ${result.backupPath}\n现役: ${result.file}${result.fileInferred ? ' (由受管目标表推导)' : ' (--file 显式指定)'}`);
      log(`格式 ${result.format}; ${result.bytes} B; 权限 ${result.mode}; sha256 ${result.sha256}`);
      if (result.safetyBackup) log(`恢复前安全备份: ${result.safetyBackup}`);
      log(result.note);
    }
    return result;
  } catch (e) {
    // fs/解析器错误可能附原文;只输出我们自己定义的安全说明或通用错误。
    const own = ['invalid_arguments', 'invalid_backup', 'unsupported_toml', 'invalid_backup_name', 'undecidable_target', 'unsafe_path', 'too_large', 'changed_file', 'backup_failed'].includes(e.code);
    const error = { code: e.code || 'restore_failed', message: own ? e.message : '恢复失败;未确认写入成功,请检查文件权限与备份状态' };
    if (args.includes('--json')) log(JSON.stringify({ ok: false, error }, null, 2));
    else log(`恢复失败 [${error.code}]: ${error.message}`);
    process.exitCode = 1;
    return { ok: false, error };
  }
}

module.exports = { RESTORE_USAGE, parseRestoreArgs, runRestoreCmd };
