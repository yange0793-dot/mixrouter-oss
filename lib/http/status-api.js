'use strict';
const { cursorHttpStatus } = require('../observability/log-history');
const { listBackups } = require('../backup/inventory');
const compactLib = require('../routing/compact');
const { publicProvider } = require('../providers/public');
function createStatusApi(deps) {
  const {
    VERSION, PROXY_PORT, UI_PORT, CODE_REVISION, ROUTER_ID, ROUTER_URL, ROUTER_TOKEN,
    BACKUP_KEEP, SESSION_TTL_MS, ENDPOINTS, backupFiles, getStore, getCurrent, getRoutes,
    liveState, healthStatus, sessionList, requestLog, slotsPublic, usageSummary, activeRequests,
  } = deps;

  return async function handle({ req, res, url, readObject, send, sendErr }) {
    const p = url.pathname;
    const sendCursorError = error => {
      const status = cursorHttpStatus(error.code);
      if (!status) return false;
      send(status, { error: error.message, code: error.code });
      return true;
    };
    if (!(['/api/state', '/api/health', '/api/logs', '/api/stats', '/api/usage', '/api/metrics', '/api/backups'].includes(p))) return false;
    await (async () => {
      if (req.method === 'GET' && p === '/api/state') {
        return send(200, {
          version: VERSION, proxy_port: PROXY_PORT, ui_port: UI_PORT,
          uptime_s: Math.floor(process.uptime()), pid: process.pid, code_revision: CODE_REVISION,
          active_requests: activeRequests ? activeRequests() : 0,
          stats: requestLog.today(),
          providers: { claude: getStore().claude.map(publicProvider), codex: getStore().codex.map(publicProvider) },
          current: getCurrent(), live: liveState(), slots: slotsPublic(),
          compact: compactLib.compactPublic(getRoutes(), getStore().claude),
          sessions: sessionList(),
          cooldowns: [],
          session_ttl_min: Math.round(SESSION_TTL_MS / 60000), cooldown_s: 0,
          router: { id: ROUTER_ID, url: ROUTER_URL, token: ROUTER_TOKEN,
            claude_base: ROUTER_URL, codex_base: ROUTER_URL + '/v1',
            endpoints: ENDPOINTS.map(e => `${e.app === 'claude' ? 'Anthropic' : 'OpenAI'} ${e.path}`) },
        });
      }
      if (req.method === 'GET' && p === '/api/health') {
        return send(200, healthStatus());
      }
      if (req.method === 'GET' && p === '/api/logs') {
        const query = Object.fromEntries(url.searchParams);
        if (query.history === '1' || query.cursor) {
          try { return send(200, await requestLog.listHistory(query)); }
          catch (e) { if (!sendCursorError(e)) throw e; return; }
        }
        return send(200, requestLog.list(query));
      }
      if (req.method === 'GET' && p === '/api/stats') {
        const query = Object.fromEntries(url.searchParams);
        if (query.history === '1') {
          try { return send(200, await requestLog.summaryHistory(query)); }
          catch (e) { if (!sendCursorError(e)) throw e; return; }
        }
        const { reqs, ok, ok_rate, inTok, outTok, cache, by_app, by_provider, by_model, by_slot, scope, range } = requestLog.summary(query);
        return send(200, { reqs, ok, ok_rate, inTok, outTok, cache, by_app, by_provider, by_model, by_slot, scope, range });
      }
      if (req.method === 'GET' && p === '/api/usage' && usageSummary) {
        const query = Object.fromEntries(url.searchParams);
        try { return send(200, await usageSummary.summarize(query)); }
        catch (e) {
          if (e.statusCode) return send(e.statusCode, { error: e.message, code: e.code });
          throw e;
        }
      }
      if (req.method === 'GET' && p === '/api/metrics') {
        const body = requestLog.metrics();
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Content-Length': Buffer.byteLength(body) });
        return res.end(body);
      }
      if (req.method === 'GET' && p === '/api/backups') {
        return send(200, {
          keep: BACKUP_KEEP,
          dirs: backupFiles.map(({ id, label, file, dir }) => {
            let listing;
            try { listing = listBackups({ dir, base: file, keep: BACKUP_KEEP }); }
            catch (e) { return { id, label, dir, ok: false, error: { code: e.code || 'list_failed' }, backups: [], unparsable: [], next_delete: [] }; }
            return {
              id, label, dir, ok: true,
              total: listing.total, legacy: listing.legacyCount,
              backups: listing.entries.map(e => ({
                name: e.name, size: e.size,
                iso: e.iso,
                mode: e.mode.toString(8).padStart(3, '0'),
                sha256_12: e.sha256 ? e.sha256.slice(0, 12) : null,
                legacy: e.legacy,
              })),
              unparsable: listing.unparsable.map(u => ({ name: u.name, reason: u.reason })),
              next_delete: listing.retention.wouldDeleteOnNextBackup,
              next_delete_count: listing.retention.wouldDeleteCount,
            };
          }),
        });
      }

      sendErr(404, 'not found');
    })();
    return true;
  };
}

module.exports = { createStatusApi };
