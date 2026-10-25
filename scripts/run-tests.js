#!/usr/bin/env node
'use strict';
// npm/CI/Release 共用入口:Node 18 不传未支持的 --test-timeout,外层始终有整套超时。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEST_TIMEOUT_MS = 30000;
const TOTAL_TIMEOUT_MS = 300000;

function testFiles(root = ROOT) {
  const dir = path.join(root, 'test');
  let names;
  try { names = fs.readdirSync(dir); }
  catch {
    // Release 制品是**运行包**,不含开发测试套件(见 lib/paths.js 的 RELEASE_ITEMS 与
    // scripts/release-manifest.js)。这里必须明确失败:报一个空测试集"通过",等于把
    // "没有测试"伪装成"测试全绿"。
    throw new Error(`没有找到 ${dir}:此运行包不含开发测试套件。请在 GitHub 源码仓库运行 npm test,或在当前包运行 npm run smoke`);
  }
  return names
    .filter(name => name.endsWith('.test.js'))
    .sort()
    .map(name => path.join(root, 'test', name));
}

function testArgs(files, help) {
  return ['--test', ...(String(help || '').includes('--test-timeout')
    ? [`--test-timeout=${TEST_TIMEOUT_MS}`] : []), ...files];
}

function testEnv(parent, root) {
  const env = Object.fromEntries(Object.entries(parent)
    .filter(([key]) => !/^(MIXR_|MIXROUTER_|MIXUI_)/.test(key) && key !== 'NODE_TEST_CONTEXT'));
  // 从 node:test 派生时不能继承 child-v8,否则内层 --test 会跳过全部文件却退出 0。
  const home = path.join(root, 'home');
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    TMPDIR: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'),
    MIXR_DATA_DIR: path.join(root, 'data'),
    MIXR_CLAUDE_SETTINGS: path.join(home, '.claude', 'settings.json'),
    MIXR_CODEX_CONFIG: path.join(home, '.codex', 'config.toml'),
    MIXR_ZCODE_CONFIG: path.join(home, '.zcode', 'v2', 'config.json'),
    DSH_HOME: path.join(home, '.dsh'),
    MIXR_HARNESS_PROFILE: path.join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
    MIXR_UPSTREAM_PROXY: '',
    MIXROUTER_PORT: '0',
    MIXUI_PORT: '0',
  };
}

function main(args = process.argv.slice(2)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-tests-'));
  let child;
  let timer;
  let hardKill;
  let forcedCode = 0;
  let finished = false;
  const handlers = {};
  const cleanup = () => {
    clearTimeout(timer);
    clearTimeout(hardKill);
    for (const [signal, handler] of Object.entries(handlers)) process.removeListener(signal, handler);
    fs.rmSync(root, { recursive: true, force: true });
  };
  const finish = code => {
    if (finished) return;
    finished = true;
    try { cleanup(); } catch (e) {
      console.error(`[tests] 临时目录清理失败: ${e.message}`);
      code = code || 1;
    }
    process.exitCode = code;
  };
  const signalChild = signal => {
    if (!child || !child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal); // 本入口创建的独立进程组,包含测试派生进程
    } catch (e) {
      if (e.code !== 'ESRCH') console.error(`[tests] 停止测试失败: ${e.message}`);
    }
  };
  const stop = code => {
    if (forcedCode) return;
    forcedCode = code;
    signalChild('SIGTERM');
    hardKill = setTimeout(() => signalChild('SIGKILL'), 5000);
  };
  try {
    for (const dir of ['home', 'data', 'tmp']) fs.mkdirSync(path.join(root, dir), { mode: 0o700 });
    const files = args.length ? args.map(file => path.resolve(ROOT, file)) : testFiles();
    if (!files.length) throw new Error('没有找到 test/*.test.js');
    for (const file of files) {
      if (!file.endsWith('.test.js') || !fs.statSync(file).isFile())
        throw new Error(`测试入口只接受 .test.js 文件: ${file}`);
    }
    const env = testEnv(process.env, root);
    const help = spawnSync(process.execPath, ['--help'], { env, encoding: 'utf8', timeout: 5000 });
    if (help.error || help.status !== 0) throw help.error || new Error('无法读取 Node 测试选项');
    const argv = testArgs(files, help.stdout);
    console.log(`[tests] ${process.version}, ${files.length} files, total timeout ${TOTAL_TIMEOUT_MS}ms`);
    child = spawn(process.execPath, argv, { cwd: ROOT, env, stdio: 'inherit', detached: process.platform !== 'win32' });
    child.once('error', e => { console.error(`[tests] 无法启动: ${e.message}`); finish(1); });
    child.once('close', (code, signal) => finish(forcedCode || (Number.isInteger(code) ? code : signal ? 1 : 0)));
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      handlers[signal] = () => stop(code);
      process.once(signal, handlers[signal]);
    }
    timer = setTimeout(() => {
      console.error(`[tests] 整套测试超过 ${TOTAL_TIMEOUT_MS}ms,终止测试进程组`);
      stop(124);
    }, TOTAL_TIMEOUT_MS);
  } catch (e) {
    console.error(`[tests] ${e.message}`);
    finish(1);
  }
}

if (require.main === module) main();
module.exports = { testFiles, testArgs, testEnv, TEST_TIMEOUT_MS, TOTAL_TIMEOUT_MS };
