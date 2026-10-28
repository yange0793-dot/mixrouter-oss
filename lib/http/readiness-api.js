'use strict';
const crypto = require('node:crypto');
const { diagnosticReport } = require('../diagnostics/report');
const { resolveKey, activeKeyId } = require('../routing/keys');
const invalid = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const revision = store => crypto.createHash('sha256').update(JSON.stringify(store)).digest('hex');
function createReadinessApi(deps) {
  const { onboarding, compatibility, attemptTraces, keyFallback, explainError,
    previewProviderImport, mergeProviderImport, getStore, applyImport, publicProvider,
    version, healthStatus, liveState, requestLog } = deps;
  const imports = new Map();
  const cleanImports = () => {
    const now = Date.now();
    for (const [token, item] of imports) if (item.expires <= now) imports.delete(token);
    while (imports.size >= 20) imports.delete(imports.keys().next().value);
  };
  return async function readinessApi({ req, url, readObject, send }) {
    const p = url.pathname;
    let match = p.match(/^\/api\/onboarding\/(claude|codex)(?:\/(preview|apply|undo-preview|undo))?$/);
    if (match) {
      const [, app, action] = match;
      if (!action && req.method === 'GET') { send(200, onboarding.inspect(app)); return true; }
      if (action && req.method === 'POST') {
        const body = await readObject();
        const result = action === 'preview' ? onboarding.preview(app, body)
          : action === 'apply' ? onboarding.apply(app, body)
          : action === 'undo-preview' ? onboarding.previewUndo(app)
          : onboarding.undo(app, body);
        send(200, await result); return true;
      }
    }
    if (req.method === 'POST' && p === '/api/providers/import/preview') {
      const body = await readObject();
      if (!Object.hasOwn(body, 'input')) throw invalid('请选择有效的 JSON 导入文件');
      if (Buffer.byteLength(JSON.stringify(body.input)) > 512 * 1024) throw invalid('导入文件超过 512 KiB 上限');
      const store = getStore(), result = previewProviderImport(store, body.input);
      const response = { summary: result.summary, errors: result.errors || [] };
      if (!response.errors.length) {
        cleanImports();
        const token = crypto.randomUUID();
        imports.set(token, { draft: result.draft, revision: revision(store), expires: Date.now() + 5 * 60000 });
        response.token = token;
        const merged = mergeProviderImport(store, result.draft);
        response.providers = ['claude', 'codex'].flatMap(app => (merged[app] || []).map(provider => ({ app, ...publicProvider(provider) })));
      }
      send(200, response); return true;
    }
    if (req.method === 'POST' && p === '/api/providers/import/apply') {
      const body = await readObject();
      if (body.confirm !== true) throw invalid('导入须在预览后明确确认');
      const item = typeof body.token === 'string' ? imports.get(body.token) : null;
      if (!item || item.expires <= Date.now()) throw invalid('导入预览已过期，请重新预览', 409);
      if (item.revision !== revision(getStore())) throw invalid('渠道库已变化，请重新预览后合并', 409);
      const merged = mergeProviderImport(getStore(), item.draft);
      applyImport(merged); imports.delete(body.token);
      send(200, { ok: true }); return true;
    }
    match = p.match(/^\/api\/providers\/([^/]+)\/compatibility$/);
    if (req.method === 'POST' && match) {
      const body = await readObject(), id = decodeURIComponent(match[1]);
      const store = getStore();
      const group = store.claude.some(provider => provider.id === id) ? 'claude' : 'codex';
      const provider = store[group].find(provider => provider.id === id);
      const app = body.app === undefined ? group : body.app;
      if (!['claude', 'codex'].includes(app)) throw invalid('请选择有效的客户端');
      if (!provider) throw invalid('渠道不存在', 404);
      if (provider.enabled === false) throw invalid('渠道已停用，请先启用');
      const keyId = body.key_id === undefined || body.key_id === '' ? activeKeyId(provider) : body.key_id;
      if (!resolveKey(provider, keyId)) throw invalid('所选 Key 不可用，请重新选择');
      const model = body.model;
      if (typeof model !== 'string' || !model.trim() || model.length > 256 || /[\x00-\x1f\x7f]/.test(model)) throw invalid('请选择有效的模型名');
      send(200, await compatibility.test({ provider, app, model: model.trim(), key_id: keyId,
        client_wire: body.client_wire, confirm_run: body.confirm_run }));
      return true;
    }
    if (req.method === 'GET' && p === '/api/attempts') { send(200, { requests: attemptTraces.list() }); return true; }
    if (req.method === 'GET' && p === '/api/keys/health') { send(200, { keys: keyFallback.list() }); return true; }
    if (req.method === 'GET' && p === '/api/errors/guidance') {
      send(200, explainError({ status: Number(url.searchParams.get('status')), err_class: url.searchParams.get('err_class'), code: url.searchParams.get('code') }));
      return true;
    }
    if (req.method === 'GET' && p === '/api/diagnostics/report') {
      send(200, diagnosticReport({ version, health: healthStatus(), store: getStore(), live: liveState(), metrics: requestLog.metricsSnapshot() }));
      return true;
    }
    return false;
  };
}
module.exports = { createReadinessApi };
