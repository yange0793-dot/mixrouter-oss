'use strict';
const path = require('node:path');
const os = require('node:os');
const paths = require('../paths');
const { DEFAULT_RETAIN_DAYS } = require('../log-retention');
const { DEFAULT_KEEP } = require('../config-backup');

function envInt(env, name, fallback, min = 1, max = 2147483647) {
  const raw = env[name];
  const value = raw === undefined || String(raw).trim() === '' ? fallback : Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

function altPorts(primary, ui, env = process.env) {
  return [...new Set(String(env.MIXROUTER_ALT_PORTS || '').split(',').map(value => Number(value.trim()))
    .filter(port => Number.isInteger(port) && port > 0 && port < 65536 && port !== primary && port !== ui))];
}

function runtimeConfig({ root, env = process.env, home = os.homedir() }) {
  const int = (name, fallback, min, max) => envInt(env, name, fallback, min, max);
  const DATA_DIR = paths.runtimeDataDir(env, root);
  const HOST = '127.0.0.1';
  const PROXY_PORT = int('MIXROUTER_PORT', paths.DEFAULT_PORTS.proxy, 0, 65535);
  const UI_PORT = int('MIXUI_PORT', paths.DEFAULT_PORTS.ui, 0, 65535);
  const BODY_LIMIT = int('MIXR_BODY_LIMIT_MB', 64, 1, 2048) * 1024 * 1024;
  const TOTAL_DEADLINE_MS = int('MIXR_TOTAL_DEADLINE_MS', 240000);
  const FIRST_HEADER_TIMEOUT_MS = Math.min(int('MIXR_FIRST_HEADER_TIMEOUT_MS', 120000), TOTAL_DEADLINE_MS);
  const STREAM_FIRST_HEADER_TIMEOUT_MS = Math.min(int('MIXR_STREAM_FIRST_HEADER_TIMEOUT_MS', 60000), TOTAL_DEADLINE_MS);
  const MAX_ATTEMPTS = int('MIXR_MAX_ATTEMPTS', 10, 1, 100);
  const CONV_RETRIES = int('MIXR_CONV_RETRIES', 3, 0, 100);
  const RETENTION_SWEEP_EVERY_MS = Math.max(60000, int('MIXR_LOG_SWEEP_MS', 6 * 3600 * 1000, 0));

  return Object.freeze({
    ROOT: root, DATA_DIR, HOST, PROXY_PORT, UI_PORT,
    PROVIDERS_FILE: path.join(DATA_DIR, 'providers.json'),
    ROUTES_FILE: path.join(DATA_DIR, 'routes.json'),
    SLOTS_FILE: path.join(DATA_DIR, 'slots.json'),
    SESSIONS_FILE: path.join(DATA_DIR, 'sessions.json'),
    LOG_FILE: paths.requestsLog(env, root),
    PUBLIC_DIR: paths.publicDir(root),
    CLAUDE_SETTINGS: paths.claudeSettings(env, home),
    CODEX_CONFIG: paths.codexConfig(env, home),
    RESPONSE_ARCHIVE_ON: env.MIXR_RESPONSE_ARCHIVE === 'on',
    RESPONSE_ARCHIVE_DIR: paths.responseArchiveDir(env, root),
    BODY_LIMIT,
    BODY_DRAIN_EXTRA: Math.min(BODY_LIMIT, 32 * 1024 * 1024),
    BODY_DRAIN_MS: int('MIXR_BODY_DRAIN_MS', 10000, 0, 600000),
    TOTAL_DEADLINE_MS, FIRST_HEADER_TIMEOUT_MS, STREAM_FIRST_HEADER_TIMEOUT_MS,
    STREAM_IDLE_TIMEOUT_MS: Math.min(int('MIXR_STREAM_IDLE_TIMEOUT_MS', 90000), TOTAL_DEADLINE_MS),
    NONSTREAM_TOTAL_TIMEOUT_MS: Math.min(int('MIXR_NONSTREAM_TOTAL_TIMEOUT_MS', 180000), TOTAL_DEADLINE_MS),
    SSE_KEEPALIVE_MS: int('MIXR_SSE_KEEPALIVE_MS', 15000, 0),
    DEFAULT_UA: 'claude-cli/2.1.219 (external, cli)',
    DEFAULT_UA_CODEX: 'codex_cli_rs/0.154.0 (external, cli)',
    LOG_ROTATE_BYTES: 5 * 1024 * 1024,
    RING_SIZE: 1000,
    LOG_RETAIN_DAYS: int('MIXR_LOG_RETAIN_DAYS', DEFAULT_RETAIN_DAYS, 0, 3650),
    REQUEST_LOG_RETAIN_DAYS: int('MIXR_LOG_RETENTION_DAYS', 30, 0, 36500),
    REQUEST_LOG_MAX_ENTRIES: 100000,
    RETENTION_SWEEP_EVERY_MS,
    RETENTION_CATCHUP_MS: Math.min(RETENTION_SWEEP_EVERY_MS, 30000),
    BACKUP_KEEP: DEFAULT_KEEP,
    ROUTER_ID: '@router',
    ROUTER_URL: `http://${HOST}:${PROXY_PORT}`,
    ROUTER_TOKEN: 'mixrouter-local',
    ROUTER_SECTION: 'mixr-router',
    SESSION_TTL_MS: int('MIXR_SESSION_TTL_MIN', 720) * 60000,
    SESSION_MAX: int('MIXR_SESSION_MAX', 1000),
    COOLDOWN_MS: 0,
    MAX_ATTEMPTS, CONV_RETRIES,
    MAX_UPSTREAM_CALLS: Math.min(MAX_ATTEMPTS + CONV_RETRIES,
      int('MIXR_MAX_UPSTREAM_CALLS', MAX_ATTEMPTS + CONV_RETRIES, 1, 200)),
    RETRY_DELAY_MS: int('MIXR_RETRY_DELAY_MS', 1000, 0, 60000),
    firstHeaderTimeoutFor: stream => stream ? STREAM_FIRST_HEADER_TIMEOUT_MS : FIRST_HEADER_TIMEOUT_MS,
  });
}

module.exports = { runtimeConfig, envInt, altPorts };
