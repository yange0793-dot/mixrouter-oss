'use strict';
// Harness has one main route and an exact provider/model whitelist, not client slots.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeFileAtomic } = require('./atomic-write');
const { createHarnessConfig, readPrivateFile, fingerprint } = require('./harness-config');

const MAIN_ALIAS = 'mixr-harness-main';
const POOL_PREFIX = 'mixr-harness-pool-';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const pairKey = pair => JSON.stringify([pair.provider, pair.model]);
const autoId = pair => 'p-' + crypto.createHash('sha256').update(pairKey(pair)).digest('hex').slice(0, 20);
const validString = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const modelsOf = provider => [...new Set([
  ...(Array.isArray(provider.models) ? provider.models : []), provider.model,
].filter(validString))];
const hasKey = provider => typeof provider.api_key === 'string' && !!provider.api_key.trim();
const wireOf = provider => ['anthropic', 'responses', 'chat'].includes(provider.wire_api)
  ? provider.wire_api : provider.app === 'codex' ? 'responses' : 'anthropic';

function assertFields(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw fail(400, `${label} contains unsupported fields`);
}

function createHarnessPool({ file, profilePath, getProviders, routerURL, routerToken }) {
  if (!path.isAbsolute(file || '') || !path.isAbsolute(profilePath || '') || typeof getProviders !== 'function')
    throw new TypeError('Harness requires absolute file/profilePath and getProviders');
  let url;
  try { url = new URL(routerURL); } catch { throw new TypeError('Harness routerURL must be an http(s) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new TypeError('Harness routerURL cannot contain credentials, query or fragment');
  const base = url.toString().replace(/\/+$/, '');
  const profile = createHarnessConfig({ profilePath, routerURL: base, routerToken });

  function providers() {
    const list = getProviders();
    return (Array.isArray(list) ? list : []).filter(p => object(p) && validString(p.id) && ['claude', 'codex'].includes(p.app));
  }
  function raw() {
    const source = readPrivateFile(file);
    if (!source.exists) return { source, state: { api_version: 1, main: null, pool: [] } };
    let state;
    try { state = JSON.parse(source.text); } catch { throw fail(400, 'Harness pool file is not valid JSON; no changes made'); }
    assertFields(state, ['api_version', 'main', 'pool'], 'Harness pool file');
    if (state.api_version !== 1 || !Array.isArray(state.pool) || state.pool.length > 128)
      throw fail(400, 'Harness pool file has an unsupported schema');
    const checkPair = (pair, pool) => {
      assertFields(pair, pool ? ['id', 'provider', 'model'] : ['provider', 'model'], 'Harness route');
      if (!validString(pair.provider) || !validString(pair.model) || (pool && !ID_RE.test(pair.id || '')))
        throw fail(400, 'Harness pool file contains an invalid route');
    };
    if (state.main !== null) checkPair(state.main, false);
    state.pool.forEach(pair => checkPair(pair, true));
    if (new Set(state.pool.map(pairKey)).size !== state.pool.length || new Set(state.pool.map(p => p.id)).size !== state.pool.length ||
        (state.main && !state.pool.some(p => pairKey(p) === pairKey(state.main))) || (!state.main && state.pool.length))
      throw fail(400, 'Harness pool file contains inconsistent routes');
    return { source, state };
  }
  function revision(source, list) {
    // External pool writes and routing-relevant provider edits invalidate an open draft.
    return fingerprint(JSON.stringify([source.revision, list.map(p => ({
      id: p.id, app: p.app, models: modelsOf(p), enabled: p.enabled !== false, wire: wireOf(p),
      base: p.base_url || '', key: fingerprint(p.api_key || ''),
    }))]));
  }
  function aliases(state) {
    return { main: MAIN_ALIAS, pool: state.pool.map(p => ({ ...p, alias: POOL_PREFIX + p.id })) };
  }
  function read() {
    const { source, state } = raw(), list = providers();
    return {
      api_version: 1, revision: revision(source, list), configured: !!state.main,
      main: state.main ? { ...state.main } : null, pool: state.pool.map(p => ({ ...p })),
      providers: list.map(p => ({ id: p.id, name: validString(p.name) ? p.name : p.id, app: p.app,
        models: modelsOf(p), enabled: p.enabled !== false, has_key: hasKey(p) })),
      client: profile.inspect(state, aliases(state)), aliases: aliases(state), base_url: base + '/harness/v1',
    };
  }
  function checkRevision(expected) {
    if (typeof expected !== 'string' || expected !== read().revision)
      throw fail(409, 'Harness pool or providers changed; reload before saving or connecting');
  }
  function validatePair(pair, list, pool = false) {
    assertFields(pair, pool ? ['id', 'provider', 'model'] : ['provider', 'model'], 'Harness route');
    if (!validString(pair.provider) || !validString(pair.model)) throw fail(400, 'Harness route requires an exact provider and model');
    const matching = list.filter(p => p.id === pair.provider);
    if (matching.length !== 1 || matching[0].enabled === false || !hasKey(matching[0]) || !modelsOf(matching[0]).includes(pair.model))
      throw fail(400, 'Harness route must reference an enabled provider with a key and a configured exact model');
    if (pool && pair.id !== undefined && !ID_RE.test(pair.id)) throw fail(400, 'Harness pool id must be lowercase letters, digits or hyphens (maximum 48)');
    return { provider: pair.provider, model: pair.model };
  }
  function save(input) {
    assertFields(input, ['main', 'pool', 'expected_revision'], 'Harness save');
    checkRevision(input.expected_revision);
    if (!Array.isArray(input.pool) || input.pool.length > 128) throw fail(400, 'Harness pool must be an array of at most 128 routes');
    const list = providers(), previous = raw(), main = validatePair(input.main, list);
    const pool = [], ids = new Set(), seen = new Set();
    for (const value of input.pool) {
      const pair = validatePair(value, list, true), key = pairKey(pair);
      if (seen.has(key)) continue;
      const old = previous.state.pool.find(p => pairKey(p) === key);
      const id = old ? old.id : value.id || autoId(pair);
      if (old && value.id !== undefined && value.id !== old.id) throw fail(400, 'Existing Harness route id is stable; remove the route before renaming');
      const priorId = previous.state.pool.find(p => p.id === id);
      if (priorId && pairKey(priorId) !== key) throw fail(400, 'Harness pool alias cannot be reassigned to a different route');
      if (ids.has(id)) throw fail(400, 'Harness pool ids must be unique');
      ids.add(id); seen.add(key); pool.push({ id, ...pair });
    }
    if (!seen.has(pairKey(main))) {
      const old = previous.state.pool.find(p => pairKey(p) === pairKey(main));
      const id = old ? old.id : autoId(main);
      if (ids.has(id)) throw fail(400, 'Harness main route id conflicts with a pool route');
      pool.push({ id, ...main });
    }
    if (pool.length > 128) throw fail(400, 'Harness pool including the main route exceeds 128 routes');
    const next = JSON.stringify({ api_version: 1, main, pool }, null, 2) + '\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = file + '.lock';
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch { throw fail(409, 'Harness pool is being written by another process; reload and retry'); }
    try {
      fs.writeFileSync(fd, process.pid + '\n');
      // Recheck inside the writer lock, so concurrent expected-revision writes cannot both commit.
      checkRevision(input.expected_revision);
      writeFileAtomic(file, next, { mode: 0o600 });
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
    return read();
  }
  function models() {
    const { state } = raw();
    const ids = state.main ? [MAIN_ALIAS, ...aliases(state).pool.map(p => p.alias)] : [];
    return { object: 'list', data: ids.map(id => ({ id, object: 'model', created: 0, owned_by: 'mixrouter' })) };
  }
  function resolve(model, kind) {
    const error = (status, type, message) => ({ error: { status, type, message } });
    const { state } = raw();
    const target = model === MAIN_ALIAS ? state.main : aliases(state).pool.find(p => p.alias === model);
    if (!target) return error(404, 'harness_model_not_found', 'Unknown or unconfigured Harness model alias; ordinary routing is not used');
    const matches = providers().filter(p => p.id === target.provider), source = matches.length === 1 ? matches[0] : null;
    if (!source || source.enabled === false || !hasKey(source) || !modelsOf(source).includes(target.model))
      return error(503, 'harness_route_unavailable', 'Configured Harness provider/model is no longer available');
    const wire = wireOf(source);
    if (!['messages', 'count_tokens', 'responses', 'chat', 'chat/completions'].includes(kind) ||
        (kind === 'responses' && wire === 'anthropic') || (kind === 'count_tokens' && wire !== 'anthropic') ||
        (['chat', 'chat/completions'].includes(kind) && wire !== 'chat'))
      return error(400, 'harness_protocol_unsupported', 'This Harness route cannot use the requested protocol; use the Messages entrance');
    const provider = { ...source, wire_api: wire }, name = model === MAIN_ALIAS ? 'main' : target.id, slot = 'harness-' + name;
    const rule = { id: 'harness:' + name, match: model, provider: provider.id, model: target.model,
      pool: [], strategy: 'priority', priority: 1000, app: source.app, when: {}, enabled: true };
    return { rule, members: [{ provider, model: target.model, weight: 1 }], provider,
      model: target.model, strategy: 'priority', slot, ghosts: [] };
  }
  function preview(input = {}) {
    assertFields(input, ['expected_revision'], 'Harness preview');
    checkRevision(input.expected_revision);
    const state = read();
    if (!state.main) throw fail(400, 'Save a Harness main route and pool before previewing connection');
    state.pool.forEach(p => validatePair(p, providers(), true));
    return { revision: state.revision, ...profile.preview(state, state.aliases) };
  }
  function connect(input = {}) {
    assertFields(input, ['confirm', 'expected_revision', 'expected_profile_revision'], 'Harness connect');
    if (input.confirm !== true) throw fail(400, 'Harness connection requires explicit confirm: true');
    checkRevision(input.expected_revision);
    const plan = preview({ expected_revision: input.expected_revision });
    const result = profile.connect(read(), read().aliases, input.expected_profile_revision);
    return { state: read(), backup: result.backup, changes: plan.changes };
  }
  return { read, save, models, resolve, preview, connect };
}

module.exports = { createHarnessPool, MAIN_ALIAS, POOL_PREFIX };
