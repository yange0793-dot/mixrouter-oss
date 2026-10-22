#!/usr/bin/env node
'use strict';
// check-update.js — 查看本机安装状态与(显式请求时)官方 Release 的最新版本。
//
// 默认**不联网**,只报告本机 current / 版本 / 源码指纹与登录服务位置。
// 只有显式 --check 才会向固定仓库 yange0793-dot/mixrouter-oss 的 GitHub Releases
// 发一个只读请求;没有 --repo / --url 入口。下载与安装都不在这里做,只给下一步命令。
//
// 本脚本不写任何文件(不缓存检查结果):一个"上次检查时间"的缓存文件,很容易
// 被当成"现在是最新"的证据。

const os = require('node:os');
const path = require('node:path');
const paths = require('../lib/paths');
const sm = require('../lib/service-manager');
const ru = require('../lib/release-update');

const HELP = `用法: node scripts/check-update.js [选项]

默认只读本机状态,不联网、不写文件。

  --check              向官方 GitHub Releases 查询最新版本(显式联网)
  --version <v>        查询指定 tag(仍需同时给 --check)
  --fail-if-newer      有新版本时以退出码 1 结束(便于脚本判断)
  --install-root DIR   安装根,默认 $MIXR_INSTALL_PREFIX 或 ~/.local/share/mixrouter
  --timeout MS         网络超时,默认 ${ru.DEFAULT_TIMEOUT_MS}
  --json               以 JSON 输出
  -h | --help          显示本帮助

只查询 ${ru.OFFICIAL.owner}/${ru.OFFICIAL.repo}。没有 --repo / --url;下载与安装请用
node scripts/upgrade-release.js(默认预览,--apply --yes 才执行)。`;

const fail = (code, message) => Object.assign(new Error(message), { code });
const VALUE_FLAGS = new Set(['--version', '--install-root', '--timeout']);
const BOOL_FLAGS = new Set(['--check', '--fail-if-newer', '--json', '--help', '-h']);

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') { values.help = true; continue; }
    if (BOOL_FLAGS.has(arg)) { values[arg.slice(2) || arg] = true; continue; }
    if (VALUE_FLAGS.has(arg)) {
      const key = arg.slice(2);
      if (values[key] !== undefined) throw fail('invalid_arguments', `${arg} 不能重复`);
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw fail('invalid_arguments', `${arg} 缺少值`);
      values[key] = value;
      continue;
    }
    if (arg.startsWith('-')) throw fail('invalid_arguments', `未知选项:${arg}`);
    throw fail('invalid_arguments', `不接受位置参数:${arg}`);
  }
  if (values.timeout !== undefined) {
    if (!/^\d+$/.test(values.timeout)) throw fail('invalid_arguments', '--timeout 必须是整数毫秒');
    values.timeout = Number(values.timeout);
    if (values.timeout < 1000 || values.timeout > 120000) throw fail('invalid_arguments', '--timeout 应在 1000–120000 之间');
  }
  if (values.version !== undefined && !values.check)
    throw fail('invalid_arguments', '--version 只用于指定要查询的 tag;请同时加 --check(默认不联网)');
  return values;
}

function localState({ installRoot, home, env = process.env }) {
  const detection = sm.detect({ installRoot, home, env });
  const current = detection.current;
  let version = null;
  let code = null;
  if (current) {
    version = sm.readPackageVersion(current);
    code = require('../lib/runtime-code').codeRevision(current) || null;
  } else {
    const latest = detection.releases[detection.releases.length - 1];
    if (latest) { version = latest.version; code = latest.code_revision; }
  }
  return { installRoot, current, version, code_revision: code,
    releases: detection.releases.length, launchAgents: detection.launchAgents.length };
}

function printLocal(state) {
  console.log(`安装根:   ${state.installRoot}`);
  console.log(`current:  ${state.current || '(未建立)'}`);
  console.log(`版本:     ${state.version || '(未安装)'}${state.code_revision ? `   代码 ${state.code_revision.slice(0, 12)}` : ''}`);
  console.log(`发布目录: ${state.releases} 个   登录服务: ${state.launchAgents} 份`);
}

async function run(argv = process.argv.slice(2), deps = {}) {
  let values;
  try { values = parseArgs(argv); }
  catch (e) { console.error(`${e.message}\n\n${HELP}`); return 2; }
  if (values.help) { console.log(HELP); return 0; }
  const home = deps.home || os.homedir();
  const env = deps.env || process.env;
  let installRoot;
  try { installRoot = path.resolve(values['install-root'] || paths.installRoot(env, home)); }
  catch (e) { console.error(e.message); return 1; }
  const state = localState({ installRoot, home, env: deps.env });

  if (!values.check) {
    if (values.json) console.log(JSON.stringify({ local: state, checked: false }, null, 2));
    else {
      printLocal(state);
      console.log('\n未联网检查。要查询官方最新版本:  node scripts/check-update.js --check');
    }
    return 0;
  }

  let release;
  try {
    const fetch = deps.fetchRelease || ru.fetchRelease;
    release = await fetch(values.version, {
      transport: deps.transport,
      timeoutMs: values.timeout || ru.DEFAULT_TIMEOUT_MS,
    });
  } catch (e) {
    console.error(`查询官方 Release 失败:${e.message}`);
    return 1;
  }

  const comparison = state.version ? ru.compareVersions(release.version, state.version) : null;
  const newer = state.version ? comparison > 0 : true;
  if (values.json) {
    console.log(JSON.stringify({
      checked: true,
      local: state,
      latest: {
        version: release.version, tag: release.tag, url: release.htmlUrl,
        published_at: release.publishedAt, prerelease: release.prerelease,
        assets: {
          archive: release.assets.archive.name,
          sha256: release.assets.sha256.name,
          release_info: release.assets.releaseInfo ? release.assets.releaseInfo.name : null,
        },
      },
      newer,
    }, null, 2));
  } else {
    printLocal(state);
    console.log(`最新版本: ${release.version}${release.prerelease ? '(预发布)' : ''}${release.publishedAt ? `   发布于 ${release.publishedAt}` : ''}`);
    if (release.htmlUrl) console.log(`发布页:   ${release.htmlUrl}`);
    console.log(`附件:     ${release.assets.archive.name} + ${release.assets.sha256.name}`);
    if (!state.version) console.log('\n本机还没有可用发布。安装请直接用 upgrade-release.js(它会核对校验和与制品清单)。');
    else if (newer) {
      console.log('\n有新版本。升级工具默认预览:');
      console.log(`  node scripts/upgrade-release.js --version ${release.version} --download`);
      console.log(`  确认后加: --apply --yes`);
    } else if (comparison === 0) console.log('\n已经是最新版本。');
    else console.log(`\n本机版本 ${state.version} 高于官方最新 ${release.version}(可能是本地构建或预发布)。`);
  }
  if (values['fail-if-newer'] && newer) return 1;
  return 0;
}

if (require.main === module) run().then(code => { process.exitCode = code; })
  .catch(e => { console.error(e.message); process.exitCode = 1; });

module.exports = { HELP, parseArgs, localState, run };
