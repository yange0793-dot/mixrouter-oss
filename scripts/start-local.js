'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { localOptions } = require('../lib/cli/local-options');
const { diagnose, formatReport } = require('../lib/cli/doctor');

const HELP = `用法: npm run local -- [--data-dir <绝对路径>] [--port <端口>] [--ui-port <端口>]

前台启动,Ctrl+C 停止。默认数据保存在 ~/.local/share/mixrouter/data,
不写入源码目录,不修改客户端配置,不安装后台服务。
命令行参数优先于对应的 MIXR_DATA_DIR / MIXROUTER_PORT / MIXUI_PORT 环境变量。
旧版 npm start 保持原行为;沿用其数据请显式给 --data-dir。`;

async function start(args = process.argv.slice(2)) {
  let options;
  try {
    options = localOptions(args, { root: path.resolve(__dirname, '..'), home: os.homedir() });
  } catch (e) { console.error(`${e.message}\n${HELP}`); return 2; }
  if (options.help) { console.log(HELP); return 0; }
  const report = await diagnose({ ...options, offline: true });
  if (!report.ok) { console.error(formatReport(report)); return 1; }
  try { fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 }); }
  catch { console.error('无法创建数据目录;运行 npm run doctor 检查路径与权限。'); return 1; }
  console.log(`数据目录: ${options.dataDir}\n控制台: http://127.0.0.1:${options.uiPort}/\n前台运行,Ctrl+C 停止;不会自动改写客户端配置。`);
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(options.root, 'mixrouter.js')], {
      cwd: options.root, stdio: 'inherit',
      env: { ...process.env, MIXR_DATA_DIR: options.dataDir,
        MIXROUTER_PORT: String(options.proxyPort), MIXUI_PORT: String(options.uiPort) },
    });
    let finished = false, timer;
    const handlers = {};
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const [signal, handler] of Object.entries(handlers)) process.removeListener(signal, handler);
      resolve(code);
    };
    for (const signal of ['SIGINT', 'SIGTERM']) {
      handlers[signal] = () => {
        if (timer) return;
        child.kill(signal);
        timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      };
      process.on(signal, handlers[signal]);
    }
    child.once('error', () => { console.error('无法启动 Node 子进程;运行 npm run doctor 检查环境。'); finish(1); });
    child.once('exit', (code, signal) => finish(Number.isInteger(code) ? code : signal ? 1 : 0));
  });
}
if (require.main === module) start().then(code => { process.exitCode = code; })
  .catch(() => { console.error('启动失败;请运行 npm run doctor。'); process.exitCode = 1; });
module.exports = { start, HELP };
