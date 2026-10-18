'use strict';
// 恢复只接受目标表中的原位备份。预览只报元数据,不输出配置值或解析器错误原文。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { backupTargets } = require('./targets');
const { baseFromBackupName, parseBackupName, backupPrefix } = require('./naming');
const { backupFile } = require('../config-backup');
const { writeFileAtomic } = require('../atomic-write');

const MAX_BYTES = 512 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// 不拿现有 TOML 顶层抽取器冒充语法校验。零依赖下仅接受可完整验证的保守子集;
// 数组、内联表、多行字符串、日期和点号赋值均拒绝,而不是跳过后宣称合法。
function validateToml(text) {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|\r(?!\n)/.test(text)) throw new Error('control character');
  const tables = new Set();
  const values = new Set();
  let table = '';
  const key = '(?:[A-Za-z0-9_-]+|"(?:[^"\\\\\\x00-\\x1f]|\\\\["\\\\])*"|\'[^\'\\x00-\\x1f]*\')';
  const section = new RegExp('^\\[(' + key + '(?:\\s*\\.\\s*' + key + ')*)\\]$');
  const assignment = new RegExp('^(' + key + ')\\s*=\\s*(.+)$');
  const decodeKey = s => s.startsWith('"') ? JSON.parse(s) : s.startsWith("'") ? s.slice(1, -1) : s;
  for (const raw of text.split(/\r?\n/)) {
    let quote = null, escaped = false, end = raw.length;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (quote === '"' && c === '\\') escaped = true;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '#') { end = i; break; }
    }
    if (quote) throw new Error('unsupported');
    const line = raw.slice(0, end).trim();
    if (!line) continue;
    const header = section.exec(line);
    if (header) {
      const parts = header[1].match(new RegExp(key, 'g')).map(decodeKey);
      table = JSON.stringify(parts);
      if (tables.has(table) || values.has(table)) throw new Error('duplicate');
      for (let n = 1; n < parts.length; n++) {
        if (values.has(JSON.stringify(parts.slice(0, n)))) throw new Error('conflict');
      }
      tables.add(table);
      continue;
    }
    const pair = assignment.exec(line);
    if (!pair) throw new Error('unsupported');
    const parts = table ? JSON.parse(table) : [];
    const full = JSON.stringify([...parts, decodeKey(pair[1])]);
    if (values.has(full) || tables.has(full)) throw new Error('duplicate');
    // 隐式父表也不能被同名标量覆盖。
    for (const t of tables) {
      const names = JSON.parse(t), own = JSON.parse(full);
      if (names.length > own.length && own.every((v, i) => names[i] === v)) throw new Error('conflict');
    }
    values.add(full);
    const v = pair[2];
    if (v.startsWith('"')) {
      if (!/^"(?:[^"\\\x00-\x1f]|\\(?:["\\btnfr]|u[0-9a-fA-F]{4}))*"$/.test(v)) throw new Error('unsupported');
      const decoded = JSON.parse(v);
      if (/[\uD800-\uDFFF]/u.test(decoded)) throw new Error('unicode');
    } else if (v.startsWith("'")) {
      if (!/^'[^'\x00-\x1f]*'$/.test(v)) throw new Error('unsupported');
    } else if (!/^(?:true|false|[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?)$/.test(v)) {
      throw new Error('unsupported');
    } else if (v !== 'true' && v !== 'false') {
      const n = Number(v.replace(/_/g, ''));
      if (!Number.isFinite(n) || (!/[.eE]/.test(v) && !Number.isSafeInteger(n))) throw new Error('range');
    }
  }
}

function validateProviders(value) {
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const lists = Array.isArray(value) ? [value] : object(value)
    && Array.isArray(value.claude) && Array.isArray(value.codex) ? [value.claude, value.codex] : null;
  if (!lists) throw new Error('provider groups');
  for (const list of lists) for (const p of list) {
    if (!object(p) || typeof p.id !== 'string' || !p.id
      || typeof p.base_url !== 'string' || typeof p.api_key !== 'string'
      || (p.models !== undefined && (!Array.isArray(p.models) || p.models.some(m => typeof m !== 'string')))
      || (p.slots !== undefined && !object(p.slots))) throw new Error('provider shape');
  }
  if (value.current !== undefined && (!object(value.current)
    || Object.values(value.current).some(v => v !== null && typeof v !== 'string'))) throw new Error('current shape');
}

function validate(bytes, format, targetId) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('nul');
    if (format === 'toml') validateToml(text);
    else {
      const value = JSON.parse(text);
      if (targetId === 'data') validateProviders(value);
      else if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    }
  } catch {
    throw fail(format === 'toml' ? 'unsupported_toml' : 'invalid_backup', format === 'toml'
      ? '无法完整验证该 TOML:仅支持普通表及单行字符串、布尔、十进制数;无效或不支持语法均拒绝自动恢复'
      : targetId === 'data' ? '备份必须是有效 UTF-8 渠道库:claude/codex 数组及渠道字段类型须合法（兼容旧裸数组）' : '备份必须是有效 UTF-8 JSON 对象');
  }
}

function readRegular(file) {
  // 拒绝父目录重定向,包括间接符号链接。调用方应传真实路径,不沿链接猜目标。
  if (fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw fail('unsafe_path', '父目录含符号链接,请使用真实受管路径');
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw fail('unsafe_path', '只接受无链接的普通文件');
  if (before.size > MAX_BYTES) throw fail('too_large', '配置超过 512 KiB,拒绝自动恢复');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) throw fail('changed_file', '文件已变化,请重新预览');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0, count;
    while (size < bytes.length && (count = fs.readSync(fd, bytes, size, bytes.length - size, null))) size += count;
    if (size > MAX_BYTES) throw fail('too_large', '配置超过 512 KiB,拒绝自动恢复');
    return { bytes: bytes.subarray(0, size), st };
  } finally { fs.closeSync(fd); }
}

function unchanged(file, snapshot) {
  const current = readRegular(file);
  if (current.st.dev !== snapshot.st.dev || current.st.ino !== snapshot.st.ino
      || current.st.mode !== snapshot.st.mode || !current.bytes.equals(snapshot.bytes)) {
    throw fail('changed_file', '文件已变化,请重新预览');
  }
}

function restoreBackup(options = {}) {
  if (options.yes && options.dryRun) throw fail('invalid_arguments', '--yes 与 --dry-run 不能同时使用');
  if (typeof options.backup !== 'string' || !options.backup) throw fail('invalid_arguments', '必须指定一份备份');
  const name = path.basename(options.backup);
  const base = baseFromBackupName(name);
  if (!base || !parseBackupName(base, name).ok) throw fail('invalid_backup_name', '不是有效的受管备份名');
  const locations = backupTargets(options).map(loc => ({ ...loc, file: path.resolve(loc.file) }));
  let hits = locations.filter(loc => path.basename(loc.file) === base);
  if (options.file) hits = hits.filter(loc => loc.file === path.resolve(options.file));
  if (options.backup.includes(path.sep)) hits = hits.filter(loc => path.dirname(loc.file) === path.dirname(path.resolve(options.backup)));
  if (hits.length !== 1) throw fail('undecidable_target', '备份必须唯一对应受管文件且位于其原目录;可用 --file 明确目标,不接受任意路径');
  const target = hits[0];
  const backupPath = path.join(path.dirname(target.file), name);
  const source = readRegular(backupPath);
  const live = readRegular(target.file);
  const format = target.id === 'codex' ? 'toml' : 'json';
  validate(source.bytes, format, target.id);
  const mode = live.st.mode & source.st.mode & 0o600;
  const result = { ok: true, dryRun: !options.yes, restored: false, file: target.file,
    backupPath, targetId: target.id, fileInferred: !options.file, format,
    bytes: source.bytes.length, sha256: sha(source.bytes), mode: mode.toString(8).padStart(3, '0'),
    identical: source.bytes.equals(live.bytes), safetyBackup: null,
    note: '仅显示元数据,不显示配置值。恢复前请停止相关客户端及路由器,避免并发覆盖。' };
  if (!options.yes) return result;
  unchanged(backupPath, source);
  unchanged(target.file, live);
  // 恢复期间不轮换池:旧源与本次安全备份都必须留下,包括机器时钟倒退的情况。
  const keep = fs.readdirSync(path.dirname(target.file)).filter(n => n.startsWith(backupPrefix(target.file))).length + 1;
  const safetyBackup = backupFile(target.file, { keep });
  if (!safetyBackup) throw fail('backup_failed', '现役文件备份失败,未恢复');
  const saved = readRegular(safetyBackup);
  if ((saved.st.mode & 0o777) !== (live.st.mode & 0o600)) throw fail('backup_failed', '安全备份权限未正确收紧,未恢复');
  if (!saved.bytes.equals(live.bytes)) throw fail('changed_file', '安全备份与预览不同,未恢复');
  unchanged(target.file, live);
  writeFileAtomic(target.file, source.bytes, { mode });
  return { ...result, dryRun: false, restored: true, safetyBackup,
    note: (target.id === 'data' ? '恢复完成;请重启 mixrouter,运行中的路由器内存不会自动刷新。' : `恢复完成;请重启 ${target.id === 'codex' ? 'Codex' : 'Claude'} 客户端。`)
      + '本次保留全部旧备份,未执行轮换;未自动重启任何进程。' };
}

module.exports = { restoreBackup, validateToml, MAX_BYTES };
