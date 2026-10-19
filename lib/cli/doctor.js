'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { codeRevision } = require('../runtime-code');
const { DATA_FILES } = require('./local-options');

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

// 只做本机 GET;不跟重定向、不回显响应体,也不探测用户的上游渠道。
function getLocalJson(port, pathname, timeoutMs = 1500) {
  return new Promise(resolve => {
    let settled = false, timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const req = http.get({ hostname: '127.0.0.1', port, path: pathname,
      headers: { Accept: 'application/json' } }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { finish({ kind: 'invalid' }); res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('error', () => finish({ kind: 'invalid' }));
      res.on('aborted', () => finish({ kind: 'invalid' }));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          finish({ kind: 'response', status: res.statusCode, body });
        } catch { finish({ kind: 'invalid' }); }
      });
    });
    timer = setTimeout(() => { finish({ kind: 'timeout' }); req.destroy(); }, timeoutMs);
    req.on('error', e => finish({ kind: e.code === 'ECONNREFUSED' ? 'offline' : 'unreachable' }));
  });
}

function validConfig(name, raw) {
  if (name === 'providers.json') {
    if (Array.isArray(raw)) return raw.every(object);
    return object(raw) && ['claude', 'codex'].every(key => raw[key] === undefined
      || (Array.isArray(raw[key]) && raw[key].every(object)));
  }
  if (!object(raw)) return false;
  if (name === 'routes.json') return Array.isArray(raw.rules) && raw.rules.every(object)
    && (raw.default === undefined || object(raw.default));
  if (name === 'slots.json') return ['claude', 'codex'].every(key => raw[key] === undefined || object(raw[key]));
  return raw.bindings === undefined || object(raw.bindings);
}

async function diagnose(options, { request = getLocalJson, nodeVersion = process.versions.node,
  platform = process.platform } = {}) {
  const { root, dataDir, proxyPort, uiPort, offline, legacyData } = options;
  const checks = [];
  const add = (id, status, message, hint) => checks.push({ id, status, message, ...(hint ? { hint } : {}) });
  let version = '', minimum = 18;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    version = pkg.version;
    minimum = Number((/>=\s*(\d+)/.exec(pkg.engines && pkg.engines.node) || [])[1]) || 18;
  } catch { add('package', 'error', '无法读取 package.json', '重新解压完整运行包,不要单独复制入口文件。'); }
  const major = Number(String(nodeVersion).split('.')[0]);
  add('node', major < minimum || !Number.isFinite(major) ? 'error' : major < 22 ? 'warn' : 'ok',
    `Node ${nodeVersion};最低 ${minimum},推荐 22 / 24`, major < 22 ? '升级到推荐版本后重试。' : undefined);

  const required = ['mixrouter.js', 'mixctl', 'public/index.html', 'public/js/app.js',
    'public/styles/base.css', 'scripts/start-local.js', 'scripts/smoke-offline.js'];
  const missing = required.filter(rel => { try { return !fs.statSync(path.join(root, rel)).isFile(); } catch { return true; } });
  add('files', missing.length ? 'error' : 'ok', missing.length ? `运行包缺少 ${missing.join(', ')}` : '运行入口与控制台资源齐全',
    missing.length ? '重新下载并解压完整 Release,不要把多个版本覆盖到同一目录。' : undefined);
  if (legacyData) add('legacy_data', 'error', '源码目录含已有运行数据,新入口不会自动迁移或忽略它',
    '沿用旧数据请加 --data-dir <原代码目录的绝对路径>;新安装请使用干净的解压目录。');

  let ancestor = dataDir;
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  try {
    if (!fs.statSync(ancestor).isDirectory()) throw new Error('not a directory');
    fs.accessSync(ancestor, fs.constants.W_OK | fs.constants.X_OK);
    add('data_directory', 'ok', fs.existsSync(dataDir) ? '数据目录存在且可访问' : '首次启动会创建数据目录;本次未创建');
  } catch { add('data_directory', 'error', '数据目录或其父目录不可写', '选择当前用户可写的绝对路径: --data-dir <路径>。'); }
  if (platform !== 'win32' && fs.existsSync(dataDir)) {
    try {
      if (fs.statSync(dataDir).mode & 0o077) add('data_permissions', 'warn', '数据目录允许其他本机用户访问',
        '目录内可能包含明文 Key;确认路径后将目录权限收紧为 0700。');
    } catch { /* 可访问性已经单独报告 */ }
  }

  for (const name of DATA_FILES) {
    const file = path.join(dataDir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) { add(name, 'error', `${name} 不是普通文件`, '不自动跟随或改写配置链接,请检查路径。'); continue; }
      if (stat.size > MAX_CONFIG_BYTES) { add(name, 'warn', `${name} 超过自检读取上限`, '本次未检查内容,请在本机手动核对。'); continue; }
      let raw;
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { add(name, 'error', `${name} 不是可解析的 JSON`, '保留原文件,从备份恢复或在本机修正;不要把含 Key 的内容贴进 issue。'); continue; }
      if (!validConfig(name, raw)) { add(name, 'error', `${name} 的顶层结构不符合当前格式`, '参考示例配置与升级文档;自检不修改文件。'); continue; }
      const supported = name === 'providers.json' ? 2 : 1;
      if (raw.version !== undefined && Number(raw.version) > supported) {
        add(name, 'error', `${name} 声明了比本版更新的格式`, '先保留备份并核对版本兼容性,不要用旧版覆盖它。'); continue;
      }
      add(name, 'ok', `${name} 可读取,JSON 与顶层结构正常`);
      if (platform !== 'win32' && (stat.mode & 0o077)) add(`${name}:permissions`, 'warn', `${name} 允许其他本机用户读取`,
        '配置可能包含凭据或会话内容;确认路径后将文件权限收紧为 0600。');
      if (name === 'providers.json') {
        const providers = Array.isArray(raw) ? raw : [...(raw.claude || []), ...(raw.codex || [])];
        if (!providers.some(p => p.enabled !== false)) add('channels', 'warn', '尚无启用的渠道',
          `启动后打开 http://127.0.0.1:${uiPort}/ 添加渠道;核心离线验收不需要 Key。`);
      }
    } catch (e) {
      if (e.code === 'ENOENT') add(name, 'warn', `${name} 尚未创建(首次使用正常)`,
        name === 'providers.json' ? `启动后在 http://127.0.0.1:${uiPort}/ 添加渠道。` : undefined);
      else add(name, 'error', `无法读取 ${name}`, '检查当前用户的读权限;自检不回显文件内容。');
    }
  }

  if (offline) add('service', 'warn', '已跳过本机服务探测(--offline)');
  else {
    const results = await Promise.all([request(proxyPort, '/healthz'), request(uiPort, '/api/state')]);
    for (const [i, result] of results.entries()) {
      const id = i ? 'console' : 'proxy';
      const port = i ? uiPort : proxyPort;
      if (result.kind === 'offline') { add(id, 'warn', `本机端口 ${port} 没有服务监听`, '尚未启动时正常;运行 npm run local 后再次自检。'); continue; }
      const b = result.body;
      const identity = result.kind === 'response' && result.status === 200 && object(b)
        && (i ? Number.isInteger(b.pid) && typeof b.code_revision === 'string' && object(b.providers)
          : b.ok === true && b.service === 'mixrouter');
      if (!identity) { add(id, 'error', `端口 ${port} 未返回可识别的 mixrouter 响应`,
        '可能被其他程序占用或服务无响应;选择空闲端口,不要直接杀掉未知进程。'); continue; }
      add(id, 'ok', `本机 ${id === 'proxy' ? '代理' : '控制台'}可达`);
      if (i) {
        const disk = codeRevision(root);
        add('loaded_code', disk && b.code_revision === disk ? 'ok' : 'warn',
          disk && b.code_revision === disk ? '服务已加载这份源码' : '运行服务与当前目录的源码不同或无法核对',
          disk && b.code_revision === disk ? undefined : '可能是另一份安装;确认路径与在途请求后再决定是否重启。');
      }
    }
  }
  return { ok: !checks.some(c => c.status === 'error'), version, node: nodeVersion, platform,
    data_dir: dataDir, ports: { proxy: proxyPort, ui: uiPort },
    scope: '本机文件与回环接口;不调用上游,不证明 Key 或模型可用;仅校验配置顶层结构。', checks };
}

function formatReport(report) {
  const icon = { ok: 'OK', warn: 'WARN', error: 'ERROR' };
  const lines = [`Mixrouter ${report.version} 本地自检`, `数据目录: ${report.data_dir}`, report.scope, ''];
  for (const c of report.checks) {
    lines.push(`[${icon[c.status]}] ${c.message}`);
    if (c.hint) lines.push(`       ${c.hint}`);
  }
  lines.push('', report.ok ? '没有发现阻断问题。WARN 为待配置项或未验证范围,不代表上游调用已通过。'
    : '发现阻断问题。先按 ERROR 提示处理,本次未修改任何配置。');
  return lines.join('\n');
}

module.exports = { diagnose, formatReport, getLocalJson, validConfig, MAX_CONFIG_BYTES };
