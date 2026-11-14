'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { writeJsonAtomic, uniqueSuffix } = require('../atomic-write');
const { transportAgent } = require('../upstream-proxy');
const { ringOf } = require('../routing/keys');

const DAY = 86400000;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const keyOf = row => JSON.stringify([row.app, row.provider_id, row.model, row.input, row.output, row.cache]);
const rowId = row => `${row.app}:${row.provider_id}:${row.id}`;

async function writeTimingFile(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${uniqueSuffix()}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(data) + '\n');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temp, file);
  } finally {
    if (handle) await handle.close();
    await fs.promises.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function providerFetch(url, options, provider) {
  const { cookieChallenge, ...requestOptions } = options;
  const cookies = new Map((options.headers.Cookie || '').split(';').filter(Boolean).map(value => {
    const at = value.indexOf('=');
    return [value.slice(0, at).trim(), value.slice(at + 1)];
  }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        ...requestOptions, headers: { ...options.headers,
          ...(cookies.size ? { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
        agent: transportAgent(url.protocol, provider),
      }, response => {
        const chunks = [];
        response.on('data', chunk => { chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode,
          headers: response.headers, body: Buffer.concat(chunks) }));
      });
      request.on('error', reject);
      request.end(options.body);
    });
    const text = (response.headers['content-encoding'] === 'gzip'
      ? gunzipSync(response.body) : response.body).toString('utf8');
    for (const value of response.headers['set-cookie'] || []) {
      const pair = value.split(';', 1)[0], at = pair.indexOf('=');
      cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1));
    }
    const challenge = cookieChallenge === 'acw_sc_v2' && text.includes('acw_sc__v2')
      && text.match(/\bvar\s+arg1\s*=\s*['"]([a-f0-9]{40})['"]/i);
    if (challenge && attempt === 0) {
      // The observed ACW challenge permutes 40 hex digits and XORs a fixed mask.
      const order = [15, 35, 29, 24, 33, 16, 1, 38, 10, 9, 19, 31, 40, 27, 22, 23, 25, 13, 6, 11,
        39, 18, 20, 8, 14, 21, 32, 26, 2, 30, 7, 4, 17, 5, 3, 28, 34, 37, 12, 36];
      const arranged = Buffer.from(order.map(n => challenge[1][n - 1]).join(''), 'hex');
      const mask = Buffer.from('3000176000856006061501533003690027800375', 'hex');
      cookies.set('acw_sc__v2', Buffer.from(arranged.map((byte, i) => byte ^ mask[i])).toString('hex'));
      continue;
    }
    return { ok: response.status >= 200 && response.status < 300, status: response.status,
      cookie: cookies.size ? [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') : undefined,
      json: async () => {
        try { return JSON.parse(text); }
        catch { throw new Error('后台返回了网页，登录或站点验证需要更新'); }
      } };
  }
}

function createProviderTiming({ file, authFile, getProviders = () => ({}), retentionDays = 30,
  maxEntries = 100000, now = Date.now, fetchImpl = providerFetch } = {}) {
  const saved = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { rows: [], coverage: {} };
  const coverageFile = file && `${file}.coverage.json`;
  if (coverageFile && fs.existsSync(coverageFile))
    saved.coverage = { ...saved.coverage, ...JSON.parse(fs.readFileSync(coverageFile, 'utf8')).coverage };
  saved.coverage ||= {};
  const cached = new Map(), indexed = new Map();
  const calendar = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const checked = new Map(), errors = new Map(), inFlight = new Map();
  let revision = 0, persistedRevision = 0, persistence = Promise.resolve();

  function removeRow(row) {
    const key = keyOf(row), id = rowId(row);
    cached.delete(id);
    const group = indexed.get(key);
    group.delete(id);
    if (!group.size) indexed.delete(key);
    revision++;
  }
  function putRow(row) {
    const id = rowId(row), previous = cached.get(id);
    if (previous && Object.keys(previous).length === Object.keys(row).length
      && Object.keys(row).every(key => row[key] === previous[key])) return;
    if (previous) removeRow(previous);
    cached.set(id, row);
    const key = keyOf(row);
    if (!indexed.has(key)) indexed.set(key, new Map());
    indexed.get(key).set(id, row);
    revision++;
  }
  for (const row of saved.rows) putRow(row);
  delete saved.rows;
  persistedRevision = revision;

  async function sync({ from, to, background = false, force = false, refresh = true, providerIds = null } = {}) {
    const auth = authFile && fs.existsSync(authFile)
      ? JSON.parse(fs.readFileSync(authFile, 'utf8')) : { connections: [] };
    const providers = getProviders();
    const selected = [], due = [], excluded = new Set();
    const until = Math.min(to ?? now(), now());
    const since = Math.max(from ?? now() - (retentionDays || 30) * DAY, now() - (retentionDays || 30) * DAY);
    for (const connection of auth.connections || []) {
      const bindings = (connection.bindings || [connection]).flatMap(binding => {
        const provider = (providers[binding.app] || []).find(p => p.id === binding.provider_id);
        return provider && provider.enabled !== false ? [{ ...binding, provider }] : [];
      });
      if (connection.enabled === false) {
        for (const binding of bindings) excluded.add(binding.provider_id);
        continue;
      }
      const visible = bindings.filter(binding => !providerIds || providerIds.includes(binding.provider_id));
      if (!visible.length) continue;
      const provider = bindings[0].provider;
      const id = connection.id || `${bindings[0].app}:${provider.id}`;
      const backend = connection.kind || 'sub2api';
      const item = { connection, bindings, visible, provider, id, backend };
      selected.push(item);
      const coverage = saved.coverage[id];
      const covered = coverage && coverage.from <= since && coverage.to >= until;
      const fresh = now() - (checked.get(id) || 0) < 60000;
      if (refresh && !inFlight.has(id) && (force || !(covered || (fresh && (!coverage || coverage.from <= since)))))
        due.push(item);
    }
    if (due.length) {
      const batch = Promise.all(due.map(async ({ connection, bindings, provider, id, backend }) => {
        checked.set(id, now());
        const coverage = saved.coverage[id];
            try {
              const headers = { 'User-Agent': connection.user_agent || 'MixRouter', Accept: 'application/json',
                ...(connection.cookie ? { Cookie: connection.cookie } : {}) };
              const transport = connection.proxy_url === undefined ? provider : { ...provider, proxy_url: connection.proxy_url };
              const request = async (url, options = {}) => {
                const response = await fetchImpl(url, {
                  ...options, headers: { ...headers, ...options.headers },
                  cookieChallenge: connection.cookie_challenge,
                  signal: AbortSignal.timeout(connection.request_timeout_ms ?? 15000),
                }, transport);
                if (response.cookie && response.cookie !== headers.Cookie) {
                  headers.Cookie = connection.cookie = response.cookie;
                  writeJsonAtomic(authFile, auth);
                }
                return response;
              };
              async function refresh() {
                if (!connection.refresh_token) throw new Error('后台登录已过期');
                const response = await request(new URL('/api/v1/auth/refresh', connection.origin), {
                  method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ refresh_token: connection.refresh_token }),
                });
                if (!response.ok) throw new Error(`后台登录续期失败 (HTTP ${response.status})`);
                const body = await response.json(), tokens = body.data;
                if (!tokens?.access_token || !tokens.refresh_token) throw new Error('后台登录续期未返回凭据');
                connection.access_token = tokens.access_token;
                connection.refresh_token = tokens.refresh_token;
                connection.expires_at = now() + tokens.expires_in * 1000;
                writeJsonAtomic(authFile, auth);
              }
              // Use the dashboard's local calendar and retain an overlap for delayed usage writes.
              const fetchFrom = coverage && coverage.from <= since
                ? Math.max(since, coverage.to - (connection.overlap_ms ?? DAY)) : since;
              const collected = [];
              if (backend === 'sub2api') {
                if (connection.expires_at <= now() + 30000) await refresh();
                for (let page = 1; ; page++) {
                  const url = new URL('/api/v1/usage', connection.origin);
                  for (const [key, value] of Object.entries({ page, page_size: 1000, timezone: calendar.resolvedOptions().timeZone,
                    start_date: calendar.format(new Date(fetchFrom)),
                    end_date: calendar.format(new Date(until)), sort_by: 'created_at', sort_order: 'desc' }))
                    url.searchParams.set(key, String(value));
                  let response = await request(url, {
                    headers: { Authorization: `Bearer ${connection.access_token}` },
                  });
                  if (response.status === 401) {
                    await refresh();
                    response = await request(url, {
                      headers: { Authorization: `Bearer ${connection.access_token}` },
                    });
                  }
                  if (!response.ok) throw new Error(`后台记录读取失败 (HTTP ${response.status})`);
                  const body = await response.json(), data = body.data;
                  if (!Array.isArray(data?.items) || !Number.isInteger(data.pages) || data.pages < 0)
                    throw new Error('后台记录格式不受支持');
                  for (const item of data.items) {
                    const at = Date.parse(item.created_at), input = number(item.input_tokens), output = number(item.output_tokens);
                    const cache = number(item.cache_read_tokens), duration = number(item.duration_ms), first = number(item.first_token_ms);
                    if (!Number.isFinite(at) || !Number.isSafeInteger(item.id) || typeof item.model !== 'string'
                      || input === null || output === null || cache === null || duration === null
                      || (first !== null && first > duration)) continue;
                    for (const binding of bindings) {
                      if (binding.api_key_id && item.api_key_id !== binding.api_key_id) continue;
                      collected.push({ app: binding.app, provider_id: binding.provider_id, id: item.id,
                        key_id: binding.key_id || '', backend, precision_ms: 1,
                        request_id: typeof item.request_id === 'string' ? item.request_id : '',
                        model: item.model, input: input + (number(item.cache_creation_tokens) ?? 0),
                        output, cache, at, duration_ms: duration, first_token_ms: first });
                    }
                  }
                  if (page >= data.pages) break;
                }
              } else if (backend === 'new-api') {
                const sources = connection.mode === 'account' ? [{ bindings }] : bindings.flatMap(binding =>
                  ringOf(binding.provider).filter(key => key.enabled !== false
                    && (!binding.key_id || binding.key_id === key.id)).map(key =>
                    ({ key: key.key, bindings: [{ ...binding, key_id: key.id }] })));
                for (const source of sources) {
                  const occurrences = new Map();
                  const pageBase = connection.page_base ?? 1;
                  for (let page = pageBase; ; page++) {
                    const url = new URL(source.key ? '/api/log/token' : connection.logs_path || '/api/log/self', connection.origin);
                    for (const [key, value] of Object.entries({ p: page, page_size: 100, size: 100, type: 2,
                      start_timestamp: Math.floor(fetchFrom / 1000), end_timestamp: Math.ceil(until / 1000) }))
                      url.searchParams.set(key, String(value));
                    const response = await request(url, { headers: {
                      ...(connection.user_id ? { 'New-Api-User': String(connection.user_id) } : {}),
                      ...(source.key || connection.access_token
                        ? { Authorization: `Bearer ${source.key || connection.access_token}` } : {}),
                    } });
                    if (!response.ok) throw new Error(`后台记录读取失败 (HTTP ${response.status})`);
                    const body = await response.json();
                    const items = Array.isArray(body.data) ? body.data : body.data?.items;
                    if (body.success !== true || !Array.isArray(items)) throw new Error('后台日志读取失败，请更新后台登录');
                    for (const item of items) {
                      if (item.type !== 2) continue;
                      let other;
                      try { other = typeof item.other === 'string' ? JSON.parse(item.other || '{}') : item.other || {}; }
                      catch { continue; }
                      const at = number(item.created_at), prompt = number(item.prompt_tokens);
                      const output = number(item.completion_tokens), seconds = number(item.use_time);
                      const cache = number(other.cache_tokens) ?? 0;
                      const write = number(other.cache_write_tokens) ?? number(other.cache_creation_tokens) ?? 0;
                      const input = other.claude || other.usage_semantic === 'anthropic'
                        ? prompt + write : prompt - cache;
                      if (at === null || prompt === null || input < 0 || output === null || seconds === null
                        || typeof item.model_name !== 'string') continue;
                      const duration = seconds * 1000, first = number(other.frt);
                      // New API truncates total time to seconds but retains millisecond first-token time.
                      if (first !== null && first >= duration + 1000) continue;
                      const requestId = typeof item.request_id === 'string' ? item.request_id : '';
                      // User-facing IDs are page positions. Preserve indistinguishable same-second duplicates.
                      const fingerprint = requestId || createHash('sha256').update(JSON.stringify([
                        item.token_id, at, item.model_name, input, output, cache, duration, first,
                      ])).digest('hex');
                      const occurrence = occurrences.get(fingerprint) || 0;
                      occurrences.set(fingerprint, occurrence + 1);
                      for (const binding of source.bindings) {
                        if (binding.token_id && binding.token_id !== item.token_id) continue;
                        collected.push({ app: binding.app, provider_id: binding.provider_id,
                          key_id: binding.key_id || '', id: `new-api:${fingerprint}:${occurrence}`,
                          backend, precision_ms: 1000, request_id: requestId,
                          model: item.model_name, input, output, cache, at: at * 1000,
                          duration_ms: duration, first_token_ms: first });
                      }
                    }
                    if (source.key || !items.length || (Array.isArray(body.data) ? items.length < 100
                      : (page - pageBase + 1) * body.data.page_size >= body.data.total)) break;
                  }
                }
              } else {
                throw new Error('后台计时类型不受支持');
              }
              for (const row of collected) putRow(row);
              saved.coverage[id] = { from: Math.min(coverage?.from ?? since, since),
                to: Math.max(coverage?.to ?? until, until), synced_at: now() };
              errors.delete(id);
            } catch (error) {
              // A provider outage must not erase previously synchronized measurements.
              errors.set(id, ['TimeoutError', 'AbortError'].includes(error.name) ? '后台记录读取超时' : error.message);
            }
      })).then(() => {
        // Publish one snapshot per batch. Freshness is small and independent of the row history.
        const write = persistence.then(async () => {
          const cutoff = retentionDays > 0 ? now() - retentionDays * DAY : -Infinity;
          for (const row of cached.values()) if (row.at < cutoff) removeRow(row);
          if (maxEntries > 0 && cached.size > maxEntries) {
            const ordered = [...cached.values()].sort((a, b) => b.at - a.at);
            for (const row of ordered.slice(maxEntries)) removeRow(row);
          }
          const currentRevision = revision;
          if (file && (persistedRevision !== currentRevision || !fs.existsSync(file))) {
            await writeTimingFile(file, { rows: [...cached.values()] });
            persistedRevision = currentRevision;
          }
          if (coverageFile) await writeTimingFile(coverageFile, { coverage: saved.coverage });
        });
        persistence = write.catch(() => {});
        return write;
      }).catch(error => {
        for (const { id } of due) errors.set(id, `后台计时保存失败: ${error.code || error.message}`);
      }).finally(() => {
        for (const { id } of due) if (inFlight.get(id) === batch) inFlight.delete(id);
      });
      for (const { id } of due) inFlight.set(id, batch);
    }
    if (!background) await Promise.all(selected.map(({ id }) => inFlight.get(id)));

    const counts = new Map();
    for (const row of cached.values()) {
      const key = `${row.app}:${row.provider_id}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      counts.set(`${key}:${row.key_id}`, (counts.get(`${key}:${row.key_id}`) || 0) + 1);
    }
    const connections = [];
    for (const { visible, id, backend } of selected) {
      for (const binding of visible) {
        const countKey = `${binding.app}:${binding.provider_id}${binding.key_id ? ':' + binding.key_id : ''}`;
        connections.push({ app: binding.app,
          provider_id: binding.provider_id, provider: binding.provider.name, backend,
          key_id: binding.key_id || null, cached_rows: counts.get(countKey) || 0,
          synced_at: saved.coverage[id]?.synced_at ? new Date(saved.coverage[id].synced_at).toISOString() : null,
          error: errors.get(id) || null, syncing: inFlight.has(id) });
      }
    }
    for (const app of ['claude', 'codex']) for (const provider of providers[app] || []) {
      if (provider.enabled === false || excluded.has(provider.id) || (providerIds && !providerIds.includes(provider.id))
        || connections.some(c => c.app === app && c.provider_id === provider.id)) continue;
      connections.push({ app, provider_id: provider.id, provider: provider.name,
        synced_at: null, error: '后台计时尚未连接' });
    }
    return { connections, warnings: connections.filter(c => c.error).map(c => `${c.provider}: ${c.error}`) };
  }

  function match(row) {
    const key = keyOf({ app: row.providerApp || row.app, provider_id: row.providerId,
      model: row.modelOut || row.modelIn, input: row.inTok, output: row.outTok, cache: row.cache });
    const completedAt = row.source === 'gateway' ? row.ts + row.ms : row.ts;
    const startedAt = completedAt - row.ms;
    const matches = [...(indexed.get(key)?.values() || [])].filter(sample =>
      (!row.keyId || !sample.key_id || row.keyId === sample.key_id)
      && sample.at >= startedAt - (sample.precision_ms || 1)
      && sample.at <= completedAt + 1000);
    // Never transfer a measurement between indistinguishable concurrent requests.
    return matches.length === 1 ? matches[0] : null;
  }
  return { sync, match };
}

module.exports = { createProviderTiming };
