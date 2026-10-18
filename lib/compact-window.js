'use strict';
// Disk settings only. No process restart, active-session mutation, or unrelated config export.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic, uniqueSuffix } = require('./atomic-write');
const MIN = 100000, MAX = 1000000;
const ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function parseWindow(value) {
  if (value === 'auto') return 'auto';
  let n = value;
  if (typeof value === 'string') {
    const m = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(k|m)?$/);
    if (!m) throw error('压缩窗口须为 auto 或 100k–1M token');
    n = Number(m[1]) * (m[2] === 'm' ? 1000000 : m[2] === 'k' ? 1000 : 1);
  }
  if (!Number.isSafeInteger(n) || n < MIN || n > MAX) throw error('压缩窗口须为 auto 或 100k–1M token');
  return n;
}
function checkPath(file) {
  for (const p of [path.dirname(file), file]) {
    let stat;
    try { stat = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') continue; throw error('无法读取配置文件状态'); }
    if (stat.isSymbolicLink()) throw error('配置文件或 .claude 目录是符号链接，请在真实位置编辑');
    if (p === file ? !stat.isFile() : !stat.isDirectory()) throw error('配置路径不是普通文件或目录');
  }
}
function readSettings(file, scope) {
  checkPath(file);
  let raw = null, cfg = {};
  try {
    if (fs.statSync(file).size > 4 * 1024 * 1024) throw error('配置文件超过安全读取上限，未作修改');
    raw = fs.readFileSync(file);
  } catch (e) { if (e.code !== 'ENOENT') throw error('无法完整读取配置文件，未作修改'); }
  if (raw !== null) {
    try { cfg = JSON.parse(raw.toString('utf8').replace(/^﻿/, '')); }
    catch { throw error('配置文件 JSON 无效，未作修改；请先修复原文件'); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw error('配置必须为 JSON 对象，未作修改');
  }
  const present = Object.hasOwn(cfg, 'autoCompactWindow');
  const valid = !present || (Number.isSafeInteger(cfg.autoCompactWindow) && cfg.autoCompactWindow >= MIN && cfg.autoCompactWindow <= MAX);
  return { scope, file, raw, cfg, valid, value: present && valid ? cfg.autoCompactWindow : 'auto',
    envOverride: !!(cfg.env && cfg.env[ENV]), revision: raw === null ? 'missing' : digest(raw) };
}
function createCompactWindow({ globalFile, env = process.env }) {
  function snapshot(input = {}) {
    const scope = input.scope || 'global';
    if (!['global', 'project', 'local'].includes(scope)) throw error('scope 须为 global、project 或 local');
    let project = input.project || '';
    if (typeof project !== 'string' || (project && (!path.isAbsolute(project) || project.includes('\0')))) throw error('项目目录须为绝对路径');
    if (scope !== 'global' && !project) throw error('请指定项目绝对目录');
    if (project) {
      try { if (!fs.statSync(project).isDirectory()) throw Error(); project = fs.realpathSync(project); }
      catch { throw error('项目目录不存在或无法读取'); }
    }
    const files = [{ scope: 'global', file: path.resolve(globalFile) }];
    if (project) files.push({ scope: 'project', file: path.join(project, '.claude/settings.json') },
      { scope: 'local', file: path.join(project, '.claude/settings.local.json') });
    const rows = files.map(f => readSettings(f.file, f.scope));
    const selected = rows.find(r => r.scope === scope);
    const numeric = rows.filter(r => typeof r.value === 'number');
    const top = numeric.at(-1);
    const coverage = { project_checked: !!project,
      overridden_by: top && rows.indexOf(top) > rows.indexOf(selected) ? top.scope : null,
      environment_override: !!env[ENV] || rows.some(r => r.envOverride) };
    const warnings = ['这里只显示磁盘配置；活会话、托管策略、--settings 和模型上下文上限可能不同。',
      '外部保存不会热改运行中的会话。项目层设置需新开会话，或退出后在该项目目录用 claude --continue 继续。',
      '当前会话可用 /autocompact <值> 调整，但它写用户层，仍可能被项目或环境覆盖；请核对窗口与 capped 提示。',
      '全局只改全局文件；auto 只删除所选层的键并继承下层，不关闭自动压缩。窗口值也不等于最终触发 token 数。'];
    if (!project) warnings.push('尚未指定项目，未核对项目级与本地级覆盖；不能据此判断某个项目的新会话窗口。');
    if (coverage.overridden_by) warnings.push(`所选层被 ${coverage.overridden_by} 层覆盖；保存本层不会改变该项目的有效磁盘值 ${top.value}。`);
    if (coverage.environment_override) warnings.push('检测到 CLAUDE_CODE_AUTO_COMPACT_WINDOW 环境覆盖；其优先级高于本设置，本控件不能清除它，改窗口或设 auto 均不会删除它。');
    if (env.DISABLE_AUTO_COMPACT || env.DISABLE_COMPACT || rows.some(r => r.cfg.env?.DISABLE_AUTO_COMPACT || r.cfg.env?.DISABLE_COMPACT))
      warnings.push('检测到禁用压缩的环境设置；本控件不会修改该开关。');
    for (const r of rows) if (!r.valid) warnings.push(`${r.scope} 层现有 autoCompactWindow 无效；下方显示 auto 占位，保存只修所选层。`);
    const revision = digest(JSON.stringify(rows.map(r => [r.scope, r.file, r.revision])));
    return { rows, selected, view: { scope, project, target: selected.file, revision, value: selected.value,
      layers: rows.map(r => ({ scope: r.scope, file: r.file, exists: r.raw !== null, value: r.value, valid: r.valid, env_override: r.envOverride })),
      configured: { value: top?.value || 'auto', source: top?.scope || 'auto' }, coverage, warnings,
      min: MIN, max: MAX, restart_required: true } };
  }
  function get(input) { return snapshot(input).view; }
  function set(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('请求体须为 JSON 对象');
    const value = parseWindow(input.value);
    const state = snapshot(input);
    if (typeof input.expected_revision !== 'string') throw error('请先读取窗口配置，再带 expected_revision 保存');
    if (input.expected_revision !== state.view.revision) throw error('配置已被其他窗口修改，请重新载入后保存', 409);
    const { selected } = state;
    const cfg = selected.cfg;
    if (value === 'auto') delete cfg.autoCompactWindow;
    else cfg.autoCompactWindow = value;
    const text = JSON.stringify(cfg, null, 2) + '\n';
    // No asynchronous gap between checking revisions and replacing; external writers can still
    // race rename, so keep a private exact backup. This is optimistic concurrency, not a lock.
    const latest = snapshot(input);
    if (latest.view.revision !== state.view.revision) throw error('配置已变化，请重新载入', 409);
    let backup = null;
    if (selected.raw !== null) {
      backup = `${selected.file}.bak-mixr-window-${uniqueSuffix()}`;
      fs.writeFileSync(backup, selected.raw, { flag: 'wx', mode: fs.statSync(selected.file).mode & 0o600 });
    }
    fs.mkdirSync(path.dirname(selected.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(selected.file, text);
    return { window: get(input), backup };
  }
  return { get, set };
}
module.exports = { createCompactWindow, parseWindow };
