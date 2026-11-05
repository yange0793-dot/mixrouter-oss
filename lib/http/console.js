'use strict';
const fs = require('node:fs');
const path = require('node:path');
const httpRespond = require('./respond');
const httpBody = require('./body');
const { isLoopbackHost, isCrossSiteRequest, isJsonRequest } = require('./local-access');
const { invalid, isObject } = require('../validation');
const { readBots, botsPublic, writeBots } = require('../bots');
const { createProvidersApi } = require('./providers-api');
const { createClientsApi } = require('./clients-api');
const { createStatusApi } = require('./status-api');
const { createRoutingApi } = require('./routing-api');

function createConsoleHandler(deps) {
  const { BODY_LIMIT, HOST, UI_PORT, PUBLIC_DIR, DATA_DIR, readinessApi, insightsApi, profilesApi, getStore, explainRoute } = deps;
  const handlers = [readinessApi, insightsApi, profilesApi,
    createClientsApi(deps), createStatusApi(deps), createProvidersApi(deps), createRoutingApi(deps)].filter(Boolean);

  const STATIC_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  function isInside(root, target) {
    if (target === root) return true;
    const rel = path.relative(root, target);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  function staticFileFor(pathname) {
    const bad = s => /[\\\u0000-\u001f\u007f]/.test(s);
    if (bad(pathname)) return null;
    let decoded;
    try { decoded = decodeURIComponent(pathname); }
    catch { return null; }                                  // `%zz`、裸 `%` 这类解不出来的一律不服务
    if (bad(decoded)) return null;                          // 解码后才现形的同样拒掉
    if (decoded.split('/').includes('..')) return null;

    const rel = decoded.replace(/^\/+/, '');
    const relPath = rel === '' ? 'index.html' : (rel.endsWith('/') ? rel + 'index.html' : rel);
    const abs = path.join(PUBLIC_DIR, relPath);
    const type = STATIC_TYPES[path.extname(abs).toLowerCase()];
    if (!type) return null;                                 // 不在白名单里:404,不回落 octet-stream
    const root = relPath === 'index.html';

    let realFile, realRoot;
    try {
      realFile = fs.realpathSync(abs);
      realRoot = fs.realpathSync(PUBLIC_DIR);
    } catch {
      return root ? { real: null, type, root } : null;
    }
    if (!isInside(realRoot, realFile)) return null;          // 软链指到 public 之外 → 不服务
    return { real: realFile, type, root };
  }

  function apiHandler(req, res) {
    const send = (code, obj) => httpRespond.sendJson(res, code, obj);
    const sendErr = (code, message) => httpRespond.sendError(res, code, message);
    if (!isLoopbackHost((req.headers || {}).host)) {
      return sendErr(403, '拒绝非回环 Host:请使用 http://127.0.0.1 访问控制台');
    }
    const url = new URL(req.url, `http://${HOST}:${UI_PORT}`);
    const p = url.pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD' && isCrossSiteRequest(req)) {
      return sendErr(403, '拒绝跨站写入:控制台只接受同源或本机客户端的请求');
    }
    const readObject = () => httpBody.readObject(req, {
      limit: BODY_LIMIT, invalid, isObject,
    });
    Promise.resolve().then(async () => {
      for (const handler of handlers) {
        if (await handler({ req, res, url, readObject, send, sendErr })) return;
      }
      if (req.method === 'POST' && p === '/api/routing/preview') {
        const result = explainRoute(await readObject());
        return send(result.ok ? 200 : result.error.httpStatus, result);
      }
      if (p === '/api/bots' && (req.method === 'GET' || req.method === 'PUT')) {
        if (req.method === 'PUT' && !isJsonRequest(req)) return sendErr(415, 'Content-Type 必须是 application/json');
        const input = req.method === 'PUT' ? await readObject() : null;
        const file = path.join(DATA_DIR, 'bots.json');
        const providers = getStore().claude;
        return send(200, input ? writeBots(file, providers, input) : botsPublic(readBots(file), providers));
      }
      if (p !== '/api' && !p.startsWith('/api/') && !p.startsWith('/healthz')
          && (req.method === 'GET' || req.method === 'HEAD')) {
        const hit = staticFileFor(p);
        if (hit) {
          let buf = null;
          if (hit.real) { try { buf = fs.readFileSync(hit.real); } catch { buf = null; } }
          if (buf) {
            res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'no-cache' });
            return res.end(req.method === 'HEAD' ? undefined : buf);
          }
          if (hit.root) { res.writeHead(500); return res.end(req.method === 'HEAD' ? undefined : 'public/index.html 缺失'); }
        }
      }
      if (req.method === 'GET' && p === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
      sendErr(404, 'not found');
    }).catch(e => { try { send(e.statusCode || 500, { error: e.message }); } catch {} });
  }

  return apiHandler;
}

module.exports = { createConsoleHandler };
