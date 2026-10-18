'use strict';
const http = require('node:http');
const https = require('node:https');
const { options, loadProvider } = require('./provider');
const { transportAgent, destroyAgents } = require('../upstream-proxy');
const { wireOf, upstreamPathOf, joinUpstreamPath } = require('../routing/endpoints');
const { applyModel } = require('../model-suffix');
const { DEFAULT_UA } = require('../upstream-probe');

function requestSpec(target) {
  const { app, provider, model, url } = target;
  const wire = wireOf(provider, app);
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + provider.api_key,
    'User-Agent': provider.ua || DEFAULT_UA };
  let body;
  if (wire === 'anthropic') {
    headers['x-api-key'] = provider.api_key;
    headers['anthropic-version'] = '2023-06-01';
    body = { model: applyModel(model, headers), max_tokens: 1, stream: false, messages: [{ role: 'user', content: 'ping' }] };
  } else if (wire === 'chat') {
    body = { model: model.replace(/\[1m\]$/i, ''), max_tokens: 1, stream: false, messages: [{ role: 'user', content: 'ping' }] };
  } else {
    body = { model: model.replace(/\[1m\]$/i, ''), max_output_tokens: 16, stream: false, input: 'ping' };
  }
  const data = JSON.stringify(body);
  headers['Content-Length'] = Buffer.byteLength(data);
  return { protocol: url.protocol, hostname: url.hostname, port: url.port || undefined,
    path: joinUpstreamPath(url.pathname, upstreamPathOf(wire, { path: '/v1/messages' })),
    method: 'POST', agent: transportAgent(url.protocol, provider), headers, data };
}
function one(spec, timeoutMs, signal) {
  return new Promise(resolve => {
    const start = performance.now();
    let req, timer, settled = false, status = 0, bytes = 0;
    const done = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
      resolve({ status, error, ms: performance.now() - start });
    };
    const cancel = () => { done('cancelled'); if (req) req.destroy(); };
    if (signal.aborted) return cancel();
    try {
      req = (spec.protocol === 'https:' ? https : http).request(spec, res => {
        status = res.statusCode;
        // 不存响应体,包括错误体;重定向也只记本次状态,绝不跟随。
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) { done('response-limit'); req.destroy(); }
        });
        res.once('end', () => done(''));
        res.once('aborted', () => done('aborted'));
        res.once('error', () => done('response-error'));
      });
      req.once('error', () => done('network-error'));
      timer = setTimeout(() => { done('client-timeout'); req.destroy(); }, timeoutMs);
      signal.addEventListener('abort', cancel, { once: true });
      req.end(spec.data);
    } catch { done('request-error'); if (req) req.destroy(); }
  });
}
async function execute(config, signal) {
  const target = loadProvider(process.env, config);
  const spec = requestSpec(target);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const start = performance.now();
  const timer = setTimeout(abort, config.durationMs);
  const rows = [];
  let count = 0, active = 0, peakConcurrency = 0;
  try {
    async function worker() {
      while (!controller.signal.aborted && count < config.requests && performance.now() - start < config.durationMs) {
        count++; active++; peakConcurrency = Math.max(peakConcurrency, active);
        rows.push(await one(spec, config.timeoutMs, controller.signal));
        active--;
      }
    }
    await Promise.all(Array.from({ length: config.concurrency }, worker));
    const statusDistribution = {}, errors = {};
    for (const row of rows) {
      statusDistribution[row.status] = (statusDistribution[row.status] || 0) + 1;
      if (row.error) errors[row.error] = (errors[row.error] || 0) + 1;
    }
    const latencies = rows.map(row => row.ms).sort((a, b) => a - b);
    const percentile = p => latencies.length ? Math.round(latencies[Math.ceil(latencies.length * p) - 1] * 100) / 100 : null;
    return { mode: 'provider', provider: config.provider, requests: rows.length,
      limits: { concurrency: config.concurrency, requests: config.requests, durationMs: config.durationMs, timeoutMs: config.timeoutMs },
      elapsedMs: Math.round(performance.now() - start), peakConcurrency,
      cancelled: controller.signal.aborted, statusDistribution, errors,
      clientTimeouts: errors['client-timeout'] || 0, latencyMs: { p50: percentile(0.5), p95: percentile(0.95), max: percentile(1) } };
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); destroyAgents();
  }
}
if (require.main === module) {
  const controller = new AbortController();
  let started = false;
  process.once('disconnect', () => process.exit(0));
  process.on('message', async message => {
    if (message.type === 'cancel') { controller.abort(); return; }
    if (message.type !== 'run' || started) return;
    started = true;
    if (message.cancelled) controller.abort();
    try {
      const report = await execute(options(message.config), controller.signal);
      process.send({ type: 'report', report });
    } catch (error) {
      // 只有配置校验错误可对外;transport 错误可能含 URL、代理凭据或请求头。
      const safe = /^(渠道|必须|所选|无法读取|不支持|model|concurrency|requests|durationMs|timeoutMs)/.test(error.message);
      process.send({ type: 'error', error: safe ? error.message : '渠道诊断无法执行,请检查所选配置' });
    }
  });
}
module.exports = { requestSpec, one, execute };
