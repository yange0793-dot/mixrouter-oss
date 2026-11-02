'use strict';
const { isJsonRequest } = require('./local-access');
const { readSpecs, writeSpecs, modelsPublic } = require('../model-specs');

const REQUEST_FIELDS = ['request_id', 'ts', 'app', 'provider', 'model_in', 'model_out', 'upstream_model',
  'session', 'status', 'in', 'out', 'cache_read', 'bytes_in', 'context'];

function createInsightsApi({ file, getStore, requestLog }) {
  return async function insightsApi({ req, url, readObject, send }) {
    if (url.pathname === '/api/insights/models' && ['GET', 'PUT'].includes(req.method)) {
      if (req.method === 'PUT' && !isJsonRequest(req)) {
        send(415, { error: 'Content-Type 必须是 application/json' }); return true;
      }
      const input = req.method === 'PUT' ? await readObject() : null;
      const store = getStore();
      const data = input ? writeSpecs(file, store, input) : readSpecs(file);
      send(200, modelsPublic(data, store, requestLog.list({ limit: 500 }).logs));
      return true;
    }
    if (url.pathname === '/api/insights/requests' && req.method === 'GET') {
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 100 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        send(400, { error: 'limit 必须是 1 到 500 的整数' }); return true;
      }
      const result = requestLog.list({ limit });
      send(200, { requests: result.logs.map(row => ({ ...Object.fromEntries(REQUEST_FIELDS
        .filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])),
        ok: row.status >= 200 && row.status < 400 && !row.err })),
        scope: { source: 'memory', capacity: result.capacity } });
      return true;
    }
    return false;
  };
}

module.exports = { createInsightsApi };
