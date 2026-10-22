'use strict';
// 求助导出只重建允许的字段，不复制配置、日志或错误原文。
const { foldApp, foldStatusClass, foldWire } = require('../observability/metrics');
const SETTINGS = [
  'total_deadline_ms', 'first_header_timeout_ms', 'stream_first_header_timeout_ms',
  'stream_idle_timeout_ms', 'sse_keepalive_ms', 'nonstream_total_timeout_ms',
  'max_attempts', 'conversion_retries', 'max_upstream_calls', 'cooldown_ms', 'retry_delay_ms',
];
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(value) ? value : 'unknown';
const configStatus = client => client?.error ? 'unreadable' : client?.router ? 'router' : client?.base_url ? 'configured' : 'missing';
function diagnosticReport({ version: release, health = {}, store = {}, live = {}, metrics = {}, now = new Date() } = {}) {
  const clients = Object.fromEntries(['claude', 'codex', 'zcode'].map(app => [app, { config_status: configStatus(live[app]) }]));
  const providers = Object.fromEntries(['claude', 'codex'].map(app => {
    const list = Array.isArray(store[app]) ? store[app] : [];
    return [app, { total: list.length, enabled: list.filter(p => p?.enabled !== false).length,
      configured_keys: list.reduce((n, p) => n + (Array.isArray(p?.keys) && p.keys.length ? p.keys.filter(k => typeof k?.key === 'string' && !!k.key).length : Number(!!p?.api_key)), 0) }];
  }));
  const counters = metrics.counters || {}, window = metrics.window || {};
  return {
    schema_version: 1, generated_at: now.toISOString(), version: version(release),
    runtime: { platform: process.platform, arch: process.arch, node: process.versions.node },
    scope: '本机进程及当前内存窗口；无配置正文、日志原文或上游账单，不自动上传',
    clients, providers,
    settings: Object.fromEntries(SETTINGS.filter(key => typeof health.settings?.[key] === 'number').map(key => [key, count(health.settings[key])])),
    metrics: {
      attempts: count(counters.attempts), failovers: count(counters.failover),
      requests: (Array.isArray(counters.requests) ? counters.requests : []).slice(0, 60).map(r => ({ app: foldApp(r.app), status_class: foldStatusClass(r.status_class), wire: foldWire(r.wire), count: count(r.count) })),
      tokens: (Array.isArray(counters.tokens) ? counters.tokens : []).slice(0, 4).map(r => ({ app: foldApp(r.app), direction: r.direction === 'out' ? 'out' : 'in', count: count(r.count) })),
      window: { capacity: count(window.capacity), used: count(window.used) },
    },
  };
}
module.exports = { diagnosticReport };
