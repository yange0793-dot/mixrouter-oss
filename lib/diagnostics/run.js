'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { testEnv } = require('../../scripts/run-tests.js');
const { SCENARIOS } = require('./fixture');
const LIMITS = { concurrency: 8, requests: 100, durationMs: 30000, timeoutMs: 5000 };
const DEFAULTS = { concurrency: 2, requests: 8, durationMs: 5000, timeoutMs: 2500, scenario: 'mixed' };

function options(input = {}) {
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`未知参数: ${key}`);
  const out = { ...DEFAULTS, ...input };
  for (const [key, max] of Object.entries(LIMITS)) {
    if (!Number.isSafeInteger(out[key]) || out[key] < 1 || out[key] > max) throw new Error(`${key} 必须是 1..${max} 的整数`);
  }
  if (!['mixed', ...SCENARIOS].includes(out.scenario)) throw new Error('未知故障场景');
  return out;
}

function request(port, scenario, timeoutMs, signal) {
  return new Promise(resolve => {
    const start = performance.now();
    let settled = false, status = 0, bytes = 0;
    let timer;
    const done = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      resolve({ scenario, status, error, ms: performance.now() - start });
    };
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      agent: false, headers: { 'content-type': 'application/json' } }, res => {
      status = res.statusCode;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) req.destroy(new Error('response-limit')); });
      res.once('end', () => done(''));
      res.once('aborted', () => done('aborted'));
      res.once('error', () => done('response-error'));
    });
    const cancel = () => { done('cancelled'); req.destroy(); };
    req.once('error', () => done('network-error'));
    timer = setTimeout(() => { done('client-timeout'); req.destroy(); }, timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) return cancel();
    req.end(JSON.stringify({ model: scenario, stream: true, max_tokens: 1, messages: [{ role: 'user', content: 'offline diagnostic' }] }));
  });
}

function message(child, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const done = (err, value) => {
      clearTimeout(timer); child.removeListener('message', receive); child.removeListener('exit', exit); child.removeListener('error', exit);
      err ? reject(err) : resolve(value);
    };
    const receive = value => { if (value.type === type) done(null, value); };
    const exit = () => done(new Error('离线实例提前退出'));
    const timer = setTimeout(() => done(new Error('离线实例响应超时')), timeoutMs);
    child.on('message', receive); child.once('exit', exit); child.once('error', exit);
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function run(input, { signal } = {}) {
  const config = options(input);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-diagnostic-'));
  let child, duration;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal) { signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); }
  try {
    for (const dir of ['home', 'data', 'tmp']) fs.mkdirSync(path.join(root, dir), { mode: 0o700 });
    child = fork(path.join(__dirname, 'fixture.js'), [], {
      // 诊断探针的总预算只有一秒多:每次重试前的等待会直接把重试窗口吃掉,
      // 让「主渠道失败 → 备用渠道接手」这条最该被验证的路径一次都跑不到。
      env: { ...testEnv(process.env, root), MIXR_RETRY_DELAY_MS: '0' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const ready = await message(child, 'ready', 5000);
    const start = performance.now();
    const rows = [];
    let count = 0, active = 0, peakConcurrency = 0;
    duration = setTimeout(cancel, config.durationMs);
    async function worker() {
      while (!controller.signal.aborted && count < config.requests && performance.now() - start < config.durationMs) {
        const index = count++;
        const scenario = config.scenario === 'mixed' ? SCENARIOS[index % 4] : config.scenario;
        active++; peakConcurrency = Math.max(peakConcurrency, active);
        rows.push(await request(ready.port, scenario, config.timeoutMs, controller.signal));
        active--;
      }
    }
    await Promise.all(Array.from({ length: config.concurrency }, worker));
    clearTimeout(duration);
    const pending = message(child, 'report', 2000);
    child.send('report');
    const evidence = await pending;
    const latencies = rows.map(row => row.ms).sort((a, b) => a - b);
    const statusDistribution = {}, errors = {};
    for (const row of rows) {
      statusDistribution[row.status] = (statusDistribution[row.status] || 0) + 1;
      if (row.error) errors[row.error] = (errors[row.error] || 0) + 1;
    }
    const percentile = p => latencies.length ? Math.round(latencies[Math.ceil(latencies.length * p) - 1] * 100) / 100 : null;
    return {
      mode: 'offline-temporary-router', config, budgets: ready.budgets, requests: rows.length,
      upstreamRequests: evidence.seen.length, upstreamRequestCap: config.requests * 2,
      elapsedMs: Math.round(performance.now() - start), peakConcurrency, cancelled: controller.signal.aborted,
      statusDistribution, errors, latencyMs: { p50: percentile(0.5), p95: percentile(0.95), max: percentile(1) },
      clientTimeouts: errors['client-timeout'] || 0,
      routerTimeouts: evidence.logs.filter(log => log.err_class === 'timeout').length,
      rows, evidence,
    };
  } finally {
    clearTimeout(duration); controller.abort();
    if (signal) signal.removeEventListener('abort', cancel);
    if (child) await stop(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = { run, options, LIMITS, DEFAULTS };
