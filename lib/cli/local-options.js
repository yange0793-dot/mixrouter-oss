'use strict';
const fs = require('node:fs');
const path = require('node:path');
const paths = require('../paths');

const DATA_FILES = ['providers.json', 'routes.json', 'slots.json', 'sessions.json'];
const VALUE_FLAGS = new Set(['--data-dir', '--port', '--ui-port']);

function localOptions(args, { root, home, env = process.env, doctor = false }) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') { values.help = true; continue; }
    if (doctor && (flag === '--json' || flag === '--offline')) { values[flag.slice(2)] = true; continue; }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`未知选项 ${flag};用 --help 查看用法`);
    if (values[flag] !== undefined) throw new Error(`${flag} 不能重复`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少值`);
    values[flag] = value;
  }
  if (values.help) return { help: true };
  const port = (value, fallback, label) => {
    const raw = value === undefined || value === '' ? String(fallback) : String(value);
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1 || n > 65535)
      throw new Error(`${label} 必须是 1–65535 的整数`);
    return n;
  };
  const configuredData = values['--data-dir'] || env.MIXR_DATA_DIR;
  if (configuredData && !path.isAbsolute(configuredData)) throw new Error('--data-dir / MIXR_DATA_DIR 必须是绝对路径');
  if (!configuredData && env.MIXR_INSTALL_PREFIX && !path.isAbsolute(env.MIXR_INSTALL_PREFIX))
    throw new Error('MIXR_INSTALL_PREFIX 必须是绝对路径');
  const dataDir = path.resolve(configuredData || paths.fixedDataDir(env, home));
  const proxyPort = port(values['--port'] ?? env.MIXROUTER_PORT, paths.DEFAULT_PORTS.proxy, '代理端口');
  const uiPort = port(values['--ui-port'] ?? env.MIXUI_PORT, paths.DEFAULT_PORTS.ui, '控制台端口');
  if (proxyPort === uiPort) throw new Error('代理端口和控制台端口不能相同');
  // 新入口不把旧安装当空库;必须由使用者明确指出要沿用哪份数据。
  const legacyData = !configuredData && path.resolve(root) !== dataDir
    && DATA_FILES.some(name => fs.existsSync(path.join(root, name)));
  return { root, home, dataDir, proxyPort, uiPort, legacyData,
    json: !!values.json, offline: !!values.offline };
}

module.exports = { localOptions, DATA_FILES };
