#!/usr/bin/env node
// 从 cc-switch 的 SQLite 备份库导入渠道,合并进 providers.json(v2 分组格式)。
//
// 用法:
//   node scripts/import-ccswitch.js [cc-switch.db] [providers.json] [--out <file>] [--apply]
//
// 默认是**预演**:只读数据库和目标库,打印将要新增/跳过的渠道(Key 一律掩码),不写任何文件。
// 确认无误后再加 --apply:
//   · 先给现有 providers.json 备份一份(backupFile 的 .bak-mixui-* 命名);
//   · 与现有渠道合并后**原子替换**(临时文件 + fsync + rename);
//   · 任何一步失败(数据库读不出、目标不是合法 JSON、合并校验失败)都保持旧库原样。
//
// 这里不再内置任何个人渠道或"已知失效"判据:停用/追加哪一家是用户的选择,不是脚本常量。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { previewProviderImport, mergeProviderImport, maskKey } = require('../lib/provider-import');
const { backupFile } = require('../lib/config-backup');
const { writeJsonAtomic } = require('../lib/atomic-write');

const QUERY = 'SELECT id, app_type, name, settings_config, notes FROM providers;';
const DEFAULT_OUT = path.join(__dirname, '..', 'providers.json');

function usage() {
  return [
    '用法: node scripts/import-ccswitch.js [cc-switch.db] [providers.json] [--out <file>] [--apply]',
    '',
    '  cc-switch.db   默认取家目录下最近的 cc-switch-backup-*/cc-switch.db',
    '  providers.json 默认是本仓库的 providers.json;也可用 --out 指定',
    '  --apply        真正写入。默认只预演,不写任何文件。',
    '  写入前会自动备份;合并只新增,不覆盖已有渠道、Key、current 或 id。',
  ].join('\n');
}

// 默认取家目录下最近一次 cc-switch 备份;库路径也可以直接当第一个参数传进来。
function defaultDb(home = os.homedir()) {
  try {
    const candidates = fs.readdirSync(home)
      .filter(name => /^cc-switch-backup-/.test(name))
      .map(name => path.join(home, name, 'cc-switch.db'))
      .filter(file => fs.existsSync(file))
      .sort();
    if (candidates.length) return candidates[candidates.length - 1];
  } catch {}
  return path.join(home, 'cc-switch-backup', 'cc-switch.db');
}

function parseArgs(argv) {
  const args = { db: '', out: '', apply: false, help: false };
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--apply') args.apply = true;
    else if (value === '--help' || value === '-h') args.help = true;
    else if (value === '--out') {
      if (index + 1 >= argv.length) throw new Error('--out 需要一个文件路径');
      args.out = argv[++index];
    } else if (value.startsWith('-')) throw new Error(`未知参数: ${value}`);
    else positional.push(value);
  }
  if (positional.length > 2) throw new Error('参数过多');
  args.db = positional[0] || '';
  args.out = args.out || positional[1] || DEFAULT_OUT;
  return args;
}

function loadStore(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 2, current: { claude: null, codex: null }, claude: [], codex: [] };
    throw new Error(`无法读取目标渠道库 ${file}: ${error.code || error.message}`);
  }
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error(`目标渠道库 ${file} 不是合法 JSON;为免覆盖,导入已中止`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Array.isArray(value.claude) || !Array.isArray(value.codex)) {
    throw new Error(`目标渠道库 ${file} 格式无效（需要 claude/codex 数组）;导入已中止`);
  }
  return value;
}

function readRows(db, exec = execFileSync) {
  let raw;
  try { raw = exec('sqlite3', ['-json', db, QUERY], { maxBuffer: 64 * 1024 * 1024 }); }
  catch (error) {
    const hint = error.code === 'ENOENT' ? '未找到 sqlite3 命令' : (error.message || '读取失败');
    throw new Error(`读取 cc-switch 数据库失败: ${hint}`);
  }
  let rows;
  try { rows = JSON.parse(raw || '[]'); }
  catch { throw new Error('cc-switch 数据库返回的不是 JSON;导入已中止'); }
  if (!Array.isArray(rows)) throw new Error('cc-switch 数据库返回格式无效;导入已中止');
  return rows;
}

function printPreview(preview, log) {
  const total = preview.draft.entries.length;
  log(`识别 ${preview.summary.input} 条:新增 claude ${preview.summary.new.claude} / codex ${preview.summary.new.codex},` +
    ` 已存在 claude ${preview.summary.duplicate_existing.claude} / codex ${preview.summary.duplicate_existing.codex},` +
    ` 批内重复 ${preview.summary.duplicate_input.claude + preview.summary.duplicate_input.codex},` +
    ` 跳过 ${preview.summary.skipped}, 无效 ${preview.summary.rejected}`);
  if (!total) log('没有可新增的渠道。');
  for (const entry of preview.draft.entries) {
    const provider = entry.provider;
    const detail = entry.app === 'claude'
      ? `${(provider.models || []).join(', ') || '(未配模型)'}`
      : `${provider.model} (${provider.wire_api})`;
    log(`  [${entry.app}][启用] ${provider.name}  ${provider.base_url}  key=${maskKey(provider.api_key)}  ${detail}`);
  }
}

function main(argv = process.argv.slice(2), io = {}) {
  const log = io.log || console.log;
  const error = io.error || console.error;
  const exec = io.execFileSync || execFileSync;
  let args;
  try { args = parseArgs(argv); }
  catch (failure) { error(failure.message); error(usage()); return 2; }
  if (args.help) { log(usage()); return 0; }

  const out = path.resolve(args.out);
  try {
    const db = args.db || defaultDb(io.home);
    const rows = readRows(db, exec);
    const store = loadStore(out);
    const preview = previewProviderImport(store, { providers: rows });
    for (const failure of preview.errors) {
      error(`[无效] ${failure.where || '#' + (failure.index + 1)} ${failure.name ? `「${failure.name}」` : ''}: ${failure.message}`);
    }
    printPreview(preview, log);
    if (preview.errors.length) {
      error(`发现 ${preview.errors.length} 条无效条目,本次不写入任何内容;请先修正来源或改用合法导出。`);
      return 1;
    }
    if (!args.apply) {
      log('预演模式:未写入任何文件。确认无误后重新运行并加 --apply。');
      return 0;
    }
    if (!preview.draft.entries.length) {
      log('没有新增渠道,未写入。');
      return 0;
    }
    let backup = null;
    try { backup = backupFile(out); }
    catch (failure) { error(`备份目标渠道库失败,未写入: ${failure.message}`); return 1; }
    if (backup) log(`已备份原渠道库: ${backup}`);
    const merged = mergeProviderImport(store, preview.draft);
    try { writeJsonAtomic(out, merged, { mode: 0o600 }); }
    catch (failure) { error(`写入渠道库失败,旧库保持原样: ${failure.message}`); return 1; }
    log(`已导入 claude ${preview.summary.new.claude} / codex ${preview.summary.new.codex} -> ${out}`);
    return 0;
  } catch (failure) {
    error(`${failure.message}；未写入任何内容。`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArgs, defaultDb, loadStore, readRows, usage };
