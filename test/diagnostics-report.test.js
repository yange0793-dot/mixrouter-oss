'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diagnosticReport } = require('../lib/diagnostics/report');
test('诊断报告重建白名单，不包含凭据、路径、正文和任意标识', () => {
  const secret = 'PRIVATE_MARKER';
  const result = diagnosticReport({ version: '3.9.0', store: {
    claude: [{ id: secret, name: secret, base_url: secret, api_key: secret, keys: [{ key: secret, label: secret }], models: [secret] }], codex: [],
  }, live: { claude: { base_url: secret, config_path: secret }, codex: { error: secret }, zcode: { router: true } },
  health: { settings: { max_attempts: 10, private_path: secret } },
  metrics: { counters: { requests: [{ app: secret, wire: secret, status_class: secret, count: 3, key: secret }],
    tokens: [{ app: 'claude', direction: 'out', count: 4 }], attempts: 5 }, window: { capacity: 500, used: 3, log: secret } },
  now: new Date('2026-01-01T00:00:00Z') });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.clients.claude.config_status, 'configured');
  assert.equal(result.clients.codex.config_status, 'unreadable');
  assert.deepEqual(result.providers.claude, { total: 1, enabled: 1, configured_keys: 1 });
  assert.deepEqual(result.settings, { max_attempts: 10 });
  assert.deepEqual(result.metrics.requests, [{ app: 'unknown', wire: 'none', status_class: 'other', count: 3 }]);
});
test('坏版本文本不会成为诊断泄漏入口', () => {
  assert.equal(diagnosticReport({ version: '/Users/private/token' }).version, 'unknown');
});
