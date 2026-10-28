'use strict';
// 显式选择的单渠道限量诊断。子进程拥有 transport 连接池,取消时连未完成的 CONNECT 一并回收。
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const LIMITS = { concurrency: 4, requests: 20, durationMs: 30000, timeoutMs: 5000 };
const DEFAULTS = { concurrency: 1, durationMs: 5000, timeoutMs: 3000 };
function options(input = {}) {
  const allowed = ['mode', 'provider', 'confirm', 'model', 'requests', ...Object.keys(DEFAULTS)];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`渠道诊断不接受参数: ${key}`);
  if (input.mode !== 'provider' || input.confirm !== true) throw new Error('渠道诊断必须显式 --mode provider --confirm-run');
  if (typeof input.provider !== 'string' || !/^[\w.-]{1,128}$/.test(input.provider)) throw new Error('必须显式提供合法 --provider ID');
  const config = { ...DEFAULTS, ...input };
  for (const [key, max] of Object.entries(LIMITS)) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > max) throw new Error(`${key} 必须显式为 1..${max} 的整数`);
  }
  if (config.model !== undefined && (typeof config.model !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(config.model))) throw new Error('model 必须是长度不超过200的非空模型名');
  return config;
}
function loadProvider(env, config) {
  if (!env.MIXR_DATA_DIR || !path.isAbsolute(env.MIXR_DATA_DIR)) throw new Error('渠道诊断要求显式绝对路径 MIXR_DATA_DIR');
  let store;
  try {
    const file = path.join(env.MIXR_DATA_DIR, 'providers.json');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
    store = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { throw new Error('无法读取有效的 MIXR_DATA_DIR/providers.json（上限1MiB）'); }
  const matches = ['claude', 'codex'].flatMap(app => (Array.isArray(store[app]) ? store[app] : [])
    .filter(p => p && p.id === config.provider).map(provider => ({ app, provider })));
  if (matches.length !== 1) throw new Error('渠道ID不存在或不唯一;不会自动选择其他渠道');
  const { app, provider } = matches[0];
  if (provider.enabled === false) throw new Error('所选渠道已停用');
  if (typeof provider.api_key !== 'string' || !provider.api_key || /[^\x20-\x7e]/.test(provider.api_key)) throw new Error('所选渠道缺少有效 API Key');
  if (provider.direct !== undefined && typeof provider.direct !== 'boolean') throw new Error('渠道 direct 必须是布尔值');
  // 渠道级出站代理:诊断跑的是**真实出站路径**,代理地址坏了这里就该先拦下来,
  // 而不是让它进 createProxyAgents 后每次转发都抛。规则与控制台写入闸门同一套。
  if (provider.proxy_url !== undefined && provider.proxy_url !== '') {
    if (typeof provider.proxy_url !== 'string') throw new Error('渠道 proxy_url 必须是字符串');
    let pxy;
    try { pxy = new URL(provider.proxy_url); } catch { throw new Error('渠道 proxy_url 不是合法地址'); }
    if (pxy.protocol !== 'http:' || pxy.username || pxy.password || pxy.search || pxy.hash)
      throw new Error('渠道 proxy_url 只支持无凭据、无查询串的 http:// CONNECT 代理');
    if (provider.direct === true) throw new Error('渠道 direct 与 proxy_url 互斥');
  }
  let url;
  try { url = new URL(provider.base_url); } catch { throw new Error('渠道地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('渠道地址必须是无凭据、无查询参数的 HTTP(S) base URL');
  if (provider.wire_api && !['anthropic', 'responses', 'chat'].includes(provider.wire_api)) throw new Error('不支持该渠道协议');
  const model = config.model || provider.model || (Array.isArray(provider.models) && provider.models[0]);
  if (typeof model !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(model)) throw new Error('必须提供 --model 或在所选渠道配置已知模型');
  return { app, provider, model, url };
}
async function stopChild(child) {
  // spawn 失败没有 pid,也可能永远不发 exit;不能等一个根本没启动的进程。
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', exited);
      child.removeListener('error', failed);
      if (error) {
        try { if (child.connected) child.disconnect(); } catch {}
        try { child.unref(); } catch {}
        reject(error);
      } else resolve();
    };
    const exited = () => finish();
    const failed = () => finish(new Error('无法停止渠道诊断进程'));
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(new Error('500ms 内未确认渠道诊断进程退出,已尝试强制停止'));
    }, 500);
    child.once('exit', exited);
    child.once('error', failed);
    try { if (!child.kill('SIGTERM')) failed(); } catch { failed(); }
  });
}
async function run(input, { signal, forkProcess = fork } = {}) {
  const config = options(input);
  // 校验先于派生进程,未确认/未限量的调用连配置都不读取。
  const child = forkProcess(path.join(__dirname, 'provider-worker.js'), [], {
    env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let hardTimer, cancelTimer, abort;
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const done = (error, report) => { if (settled) return; settled = true; error ? reject(error) : resolve(report); };
      child.once('error', () => done(new Error('无法启动渠道诊断进程')));
      child.once('exit', () => done(new Error('渠道诊断进程提前退出')));
      child.on('message', data => {
        if (data.type === 'report') done(null, data.report);
        if (data.type === 'error') done(new Error(data.error));
      });
      abort = () => {
        if (child.connected) child.send({ type: 'cancel' }, () => {});
        cancelTimer = setTimeout(() => done(new Error('取消渠道诊断超时,已终止进程')), 2000);
      };
      child.send({ type: 'run', config, cancelled: !!(signal && signal.aborted) }, error => { if (error) done(new Error('无法发送诊断参数')); });
      if (signal) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }
      hardTimer = setTimeout(() => done(new Error('渠道诊断超过总执行上限,已终止进程')), config.durationMs + 5000);
    });
  } finally {
    clearTimeout(hardTimer); clearTimeout(cancelTimer);
    if (signal) signal.removeEventListener('abort', abort);
    await stopChild(child);
  }
}
module.exports = { options, loadProvider, run, LIMITS, DEFAULTS };
