'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { gzipSync } = require('node:zlib');
const { createProviderTiming } = require('../lib/usage/provider-timing');
const { createUsageSummary, compact } = require('../lib/usage/summary');
const { createStatusApi } = require('../lib/http/status-api');

const NOW = Date.parse('2026-11-10T02:00:00Z');
const DAY = 86400000;
const AT = '2026-11-10T01:47:48.782Z';
const local = overrides => ({ ts: AT, source: 'codex-local', app: 'codex', provider_app: 'codex',
  provider_id: 'p1', provider: 'Test', model_out: 'model', request_id: 'local-response',
  in: 257, out: 204, cache_read: 190720, usage_normalized: true, status: 200,
  ms: 28551, ttft_ms: 25655, ttfb_ms: 25428, ...overrides });
const remote = overrides => ({ id: 10224230, request_id: 'client:test-request', model: 'model',
  input_tokens: 257, output_tokens: 204, cache_read_tokens: 190720,
  created_at: '2026-11-10T09:47:48.720515+08:00', duration_ms: 14060, first_token_ms: 11134,
  api_key: { key: 'SECRET-REMOTE-KEY' }, user: { email: 'PRIVATE-EMAIL' }, ...overrides });
const reply = (data, status = 200) => new Response(JSON.stringify({ data }), {
  status, headers: { 'Content-Type': 'application/json' },
});
function setup(t, fetchImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-provider-timing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authFile = path.join(root, 'auth.json'), file = path.join(root, 'cache.json');
  fs.writeFileSync(authFile, JSON.stringify({ connections: [{ app: 'codex', provider_id: 'p1',
    origin: 'https://provider.test', access_token: 'SECRET-ACCESS', refresh_token: 'SECRET-REFRESH',
    expires_at: NOW + 3600000 }] }), { mode: 0o600 });
  const options = { file, authFile, now: () => NOW, fetchImpl,
    getProviders: () => ({ codex: [{ id: 'p1', name: 'Test' }] }) };
  return { ...options, tracker: createProviderTiming(options) };
}

test('provider mode uses exact backend times for rows, sorting, TPS and totals while preserving local timing', async t => {
  const calls = [];
  const { tracker, file } = setup(t, async url => {
    calls.push(String(url));
    return reply({ items: [remote()], pages: 1 });
  });
  const rows = [local(), local({ request_id: 'unmatched', provider_id: 'other', ms: 1000 })];
  const summary = createUsageSummary({ memoryEntries: () => rows, providerTiming: tracker, now: () => NOW });
  await tracker.sync({ from: NOW - DAY, to: NOW });
  const result = await summary.summarize({ range: 'today', dashboard: '1', timing: 'provider', sort: 'ms', order: 'asc' });
  const [matched, missing] = result.dashboard.records.rows;
  assert.equal(matched.ms, 14060);
  assert.equal(matched.ttft_ms, 11134);
  assert.equal(matched.speed_tps, 14.51);
  assert.equal(matched.local_ms, 28551);
  assert.equal(matched.local_ttft_ms, 25655);
  assert.equal(matched.provider_timing_id, 10224230);
  assert.equal(matched.provider_request_id, 'client:test-request');
  assert.equal(matched.ttfb_ms, null);
  assert.equal(matched.decode_tps, null);
  assert.equal(missing.ms, null);
  assert.equal(missing.ttft_ms, null);
  assert.equal(missing.speed_tps, null);
  assert.equal(result.totals.speed_tps, 14.51);
  assert.equal(result.totals.ttft_p50_ms, 11134);
  assert.equal(result.totals.reqs, 2);
  assert.equal(rows[0].ms, 28551);
  const native = await summary.summarize({ range: 'today', dashboard: '1', timing: 'local' });
  assert.equal(native.dashboard.records.rows.find(r => r.request_id === 'local-response').ms, 28551);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8') + JSON.stringify(result), /SECRET|PRIVATE-EMAIL|access_token|refresh_token/);
});

test('matching requires provider, model, exact usage and a unique completion window; gateway start timestamps work', async t => {
  const { tracker } = setup(t, async () => reply({ items: [remote()], pages: 1 }));
  await tracker.sync({ from: NOW - DAY, to: NOW });
  assert.equal(tracker.match(compact(local())).duration_ms, 14060);
  for (const overrides of [{ provider_id: 'other' }, { model_out: 'other' }, { out: 205 },
    { cache_read: 190721 }, { ts: '2026-11-10T01:47:45Z' }])
    assert.equal(tracker.match(compact(local(overrides))), null);
  const gateway = local({ source: 'gateway', ts: new Date(Date.parse(AT) - 28551).toISOString() });
  assert.equal(tracker.match(compact(gateway)).duration_ms, 14060);
  const other = setup(t, async () => reply({ items: [remote(), remote({ id: 2 })], pages: 1 }));
  await other.tracker.sync({ from: NOW - DAY, to: NOW });
  assert.equal(other.tracker.match(compact(local())), null);
});

test('pagination and session renewal persist only sanitized timing data and fresh credentials', async t => {
  const requests = [];
  const config = setup(t, async (url, options) => {
    requests.push({ path: new URL(url).pathname, authorization: options.headers.Authorization });
    if (new URL(url).pathname.endsWith('/refresh'))
      return reply({ access_token: 'NEW-ACCESS', refresh_token: 'NEW-REFRESH', expires_in: 3600 });
    if (options.headers.Authorization === 'Bearer SECRET-ACCESS') return reply({}, 401);
    const page = new URL(url).searchParams.get('page');
    return reply({ items: page === '1' ? [remote()] : [remote({ id: 2, output_tokens: 300 })], pages: 2 });
  });
  const status = await config.tracker.sync({ from: NOW - DAY, to: NOW });
  assert.deepEqual(status.warnings, []);
  assert.equal(requests.filter(r => r.path.endsWith('/refresh')).length, 1);
  assert.ok(requests.slice(2).every(r => r.authorization === 'Bearer NEW-ACCESS'));
  assert.equal(JSON.parse(fs.readFileSync(config.authFile, 'utf8')).connections[0].refresh_token, 'NEW-REFRESH');
  assert.equal(fs.statSync(config.authFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(config.file, 'utf8')).rows.length, 2);
  const restored = createProviderTiming({ ...config, fetchImpl: async () => { throw new Error('unexpected request'); } });
  assert.equal(restored.match(compact(local())).first_token_ms, 11134);
  assert.doesNotMatch(JSON.stringify(status), /SECRET|NEW-ACCESS|NEW-REFRESH/);
});

test('provider failures retain cached measurements and leave unmatched rows empty instead of substituting local timing', async t => {
  const config = setup(t, async () => reply({ items: [remote()], pages: 1 }));
  await config.tracker.sync({ from: NOW - DAY, to: NOW });
  const tracker = createProviderTiming({ ...config, now: () => NOW + 120000,
    fetchImpl: async () => reply({}, 503) });
  await tracker.sync({ from: NOW - DAY, to: NOW + 120000 });
  const rows = [local(), local({ request_id: 'new-request', ts: new Date(NOW + 60000).toISOString() })];
  const result = await createUsageSummary({ memoryEntries: () => rows, providerTiming: tracker, now: () => NOW + 120000 })
    .summarize({ dashboard: '1', timing: 'provider' });
  assert.match(result.scope.provider_timing.warnings[0], /HTTP 503/);
  assert.equal(result.dashboard.records.rows.find(r => r.request_id === 'local-response').ms, 14060);
  assert.equal(result.dashboard.records.rows.find(r => r.request_id === 'new-request').ms, null);
});

test('warm dashboards return cached timing during a slow sync and concurrent readers share the request',
  { timeout: 2000 }, async t => {
  const config = setup(t, async () => reply({ items: [remote()], pages: 1 }));
  await config.tracker.sync({ from: NOW - DAY, to: NOW });
  let finish, calls = 0;
  const tracker = createProviderTiming({ ...config, now: () => NOW + 120000,
    fetchImpl: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const summary = createUsageSummary({ memoryEntries: () => [local()],
    providerTiming: tracker, now: () => NOW + 120000 });
  const result = await summary.summarize({ range: 'today', dashboard: '1', timing: 'provider' });
  assert.equal(result.dashboard.records.rows[0].ms, 14060);
  assert.equal(result.scope.provider_timing.connections[0].syncing, true);
  await summary.summarize({ range: 'today', dashboard: '1', timing: 'provider' });
  assert.equal(calls, 1);
  const completed = tracker.sync({ from: NOW - DAY, to: NOW + 120000 });
  finish(reply({ items: [remote({ duration_ms: 20000 })], pages: 1 }));
  assert.equal((await completed).connections[0].syncing, false);
  assert.equal(tracker.match(compact(local())).duration_ms, 20000);
});

test('a wider history query keeps the warm dashboard responsive while missing history loads',
  { timeout: 2000 }, async t => {
  const config = setup(t, async () => reply({ items: [remote()], pages: 1 }));
  await config.tracker.sync({ from: NOW - DAY, to: NOW });
  let finish, requestedFrom;
  const tracker = createProviderTiming({ ...config, now: () => NOW + 120000,
    fetchImpl: url => {
      requestedFrom = url.searchParams.get('start_date');
      return new Promise(resolve => { finish = resolve; });
    } });
  const result = await tracker.sync({ from: NOW - 7 * DAY, to: NOW + 120000, background: true });
  assert.equal(result.connections[0].syncing, true);
  assert.ok(requestedFrom < '2026-11-09');
  assert.equal(tracker.match(compact(local())).duration_ms, 14060);
  const completed = tracker.sync({ from: NOW - 7 * DAY, to: NOW + 120000 });
  finish(reply({ items: [remote()], pages: 1 }));
  await completed;
});

test('connection overlap controls the incremental window without discarding delayed records', async t => {
  const config = setupNewApi(t, async () => new Response(JSON.stringify({
    success: true, data: [newApiRow()],
  })), { overlap_ms: 1800000 });
  await config.tracker.sync({ from: NOW - DAY, to: NOW });
  let from;
  const tracker = createProviderTiming({ ...config, now: () => NOW + 120000,
    fetchImpl: async url => {
      from = Number(url.searchParams.get('start_timestamp')) * 1000;
      return new Response(JSON.stringify({ success: true, data: [] }));
    } });
  await tracker.sync({ from: NOW - DAY, to: NOW + 120000 });
  assert.equal(from, NOW - 1800000);
  assert.equal(tracker.match(compact(local())).duration_ms, 14000);
});

test('zero backend first-token time is preserved and malformed or impossible measurements are not imported', async t => {
  const { tracker } = setup(t, async () => reply({ items: [
    remote({ first_token_ms: 0 }), remote({ id: 2, model: 'bad', first_token_ms: 15000 }),
    remote({ id: 3, model: 'bad-date', created_at: 'invalid' }),
  ], pages: 1 }));
  await tracker.sync({ from: NOW - DAY, to: NOW });
  assert.equal(tracker.match(compact(local())).first_token_ms, 0);
  assert.equal(tracker.match(compact(local({ model_out: 'bad' }))), null);
});

const newApiRow = overrides => ({ id: 1, type: 2, created_at: Math.floor(Date.parse(AT) / 1000),
  model_name: 'model', prompt_tokens: 190977, completion_tokens: 204, use_time: 14,
  token_id: 41, other: JSON.stringify({ cache_tokens: 190720, frt: 11134 }), ...overrides });

function setupNewApi(t, fetchImpl, extra = {}) {
  const config = setup(t, fetchImpl);
  const connection = { app: 'codex', provider_id: 'p1', origin: 'https://provider.test',
    kind: 'new-api', ...extra };
  fs.writeFileSync(config.authFile, JSON.stringify({ connections: [connection] }));
  config.getProviders = () => ({ codex: [{ id: 'p1', name: 'Test', base_url: connection.origin,
    keys: [{ id: 'key1', key: 'SECRET-API-KEY', enabled: true }] }] });
  return { ...config, tracker: createProviderTiming(config) };
}

test('account timing refreshes a gzip ACW challenge and persists cookies without exposing credentials', async t => {
  let requests = 0;
  const expected = 'acw_sc__v2=6af2f4c0a5661cc6399730362da1e1e68b1567d0';
  const server = http.createServer((req, res) => {
    requests++;
    assert.match(req.headers.cookie, /session=SECRET-COOKIE/);
    res.setHeader('Content-Encoding', 'gzip');
    if (!req.headers.cookie.includes(expected) || !req.headers.cookie.includes('edge=fresh')) {
      res.setHeader('Set-Cookie', 'edge=fresh; Path=/; HttpOnly');
      res.end(gzipSync("<html><script>var arg1='A896C8E55A2AF153A1E6DC0232C5F83AE6A54037';"
        + "document.cookie='acw_sc__v2';</script></html>"));
      return;
    }
    res.end(gzipSync(JSON.stringify({ success: true, data: [newApiRow()] })));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = setupNewApi(t, undefined, { origin: `http://127.0.0.1:${server.address().port}`,
    mode: 'account', cookie: 'session=SECRET-COOKIE; acw_sc__v2=stale', cookie_challenge: 'acw_sc_v2' });
  const status = await config.tracker.sync({ from: NOW - DAY, to: NOW });
  assert.equal(requests, 2);
  assert.deepEqual(status.warnings, []);
  assert.equal(config.tracker.match(compact(local())).duration_ms, 14000);
  assert.ok(JSON.parse(fs.readFileSync(config.authFile)).connections[0].cookie.includes(expected));
  assert.doesNotMatch(JSON.stringify(status) + fs.readFileSync(config.file, 'utf8'), /SECRET|acw_sc__v2|edge=fresh/);
});

test('New API key logs normalize cached input, preserve integer-second precision, and use the configured transport', async t => {
  const calls = [];
  const config = setupNewApi(t, async (url, options, provider) => {
    calls.push({ url, options, provider });
    return new Response(JSON.stringify({ success: true, data: [newApiRow()] }));
  });
  await config.tracker.sync({ from: NOW - DAY, to: NOW });
  const result = config.tracker.match(compact(local({ key_id: 'key1' })));
  assert.equal(result.duration_ms, 14000);
  assert.equal(result.first_token_ms, 11134);
  assert.equal(result.precision_ms, 1000);
  assert.equal(result.input, 257);
  assert.equal(calls[0].url.pathname, '/api/log/token');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer SECRET-API-KEY');
  assert.equal(calls[0].provider.id, 'p1');
  assert.equal(config.tracker.match(compact(local({ key_id: 'another-account' }))), null);
  assert.doesNotMatch(fs.readFileSync(config.file, 'utf8'), /SECRET/);
});

test('New API matches backend completion within the actual request and combines Anthropic cache writes once', async t => {
  const config = setupNewApi(t, async () => new Response(JSON.stringify({ success: true,
    data: [newApiRow({ created_at: Math.floor(Date.parse(AT) / 1000) - 30,
      prompt_tokens: 2, use_time: 12,
      other: JSON.stringify({ claude: true, cache_tokens: 190720, cache_creation_tokens: 255,
        cache_write_tokens: 255, cache_creation_tokens_5m: 255, frt: 12200 }) })] })));
  await config.tracker.sync({ from: NOW - DAY, to: NOW });
  const row = compact(local({ ms: 45000 }));
  assert.equal(config.tracker.match(row).duration_ms, 12000);
  assert.equal(config.tracker.match(row).first_token_ms, 12200);
  assert.equal(config.tracker.match(compact(local({ ms: 10000 }))), null);
});

test('New API missing first-token time keeps total duration, including zero-second records', async t => {
  const config = setupNewApi(t, async () => new Response(JSON.stringify({ success: true, data: [
    newApiRow({ use_time: 0, other: JSON.stringify({ cache_tokens: 190720, frt: -1000 }) }),
  ] })));
  await config.tracker.sync({ from: NOW - DAY, to: NOW });
  assert.equal(config.tracker.match(compact(local())).duration_ms, 0);
  assert.equal(config.tracker.match(compact(local())).first_token_ms, null);
});

test('New API cache identity survives page renumbering and does not make duplicate requests unambiguous', async t => {
  let items = [newApiRow()];
  const config = setupNewApi(t, async () => new Response(JSON.stringify({ success: true, data: items })));
  await config.tracker.sync({ from: NOW - DAY, to: NOW });
  items = [newApiRow({ id: 2 }), newApiRow({ id: 1, completion_tokens: 300 })];
  const next = createProviderTiming({ ...config, now: () => NOW + 120000 });
  await next.sync({ from: NOW - DAY, to: NOW + 120000 });
  assert.equal(JSON.parse(fs.readFileSync(config.file, 'utf8')).rows.length, 2);
  assert.equal(next.match(compact(local())).duration_ms, 14000);
  items = [newApiRow({ id: 1 }), newApiRow({ id: 2 })];
  const ambiguous = createProviderTiming({ ...config, now: () => NOW + 240000 });
  await ambiguous.sync({ from: NOW - DAY, to: NOW + 240000 });
  assert.equal(ambiguous.match(compact(local())), null);
});

test('New API account logs paginate and bind only the configured account token', async t => {
  const pages = [];
  const config = setupNewApi(t, async (url, options) => {
    pages.push(Number(url.searchParams.get('p')));
    assert.equal(url.pathname, '/api/log/self');
    assert.equal(options.headers['New-Api-User'], '7');
    const item = pages.length === 1 ? newApiRow({ token_id: 99 }) : newApiRow();
    return new Response(JSON.stringify({ success: true, data: { items: [item], total: 2, page_size: 1 } }));
  }, { mode: 'account', page_base: 0, user_id: 7, cookie: 'SECRET-COOKIE',
    bindings: [{ app: 'codex', provider_id: 'p1', key_id: 'key1', token_id: 41 }] });
  await config.tracker.sync({ from: NOW - DAY, to: NOW });
  assert.deepEqual(pages, [0, 1]);
  assert.equal(JSON.parse(fs.readFileSync(config.file, 'utf8')).rows.length, 1);
  assert.ok(config.tracker.match(compact(local({ key_id: 'key1' }))));
});

test('shared Sub2API sessions sync once for both protocol bindings and filter API keys', async t => {
  let calls = 0;
  const config = setup(t, async () => {
    calls++;
    return reply({ items: [remote({ api_key_id: 41, cache_creation_tokens: 12 })], pages: 1 });
  });
  const auth = JSON.parse(fs.readFileSync(config.authFile, 'utf8'));
  auth.connections[0].bindings = [
    { app: 'codex', provider_id: 'p1', key_id: 'one', api_key_id: 41 },
    { app: 'claude', provider_id: 'p2', key_id: 'two', api_key_id: 41 },
    { app: 'claude', provider_id: 'p3', key_id: 'other', api_key_id: 42 },
  ];
  fs.writeFileSync(config.authFile, JSON.stringify(auth));
  const tracker = createProviderTiming({ ...config, getProviders: () => ({
    codex: [{ id: 'p1', name: 'Test' }], claude: [{ id: 'p2', name: 'Test' }, { id: 'p3', name: 'Other' }],
  }) });
  await tracker.sync({ from: NOW - DAY, to: NOW });
  assert.equal(calls, 1);
  assert.equal(JSON.parse(fs.readFileSync(config.file, 'utf8')).rows.length, 2);
  assert.ok(tracker.match(compact(local({ in: 269, key_id: 'one' }))));
  assert.ok(tracker.match(compact(local({ in: 269, provider_app: 'claude', provider_id: 'p2', key_id: 'two' }))));
});

test('cold dashboards return sync progress and cache-only followups expose completed timing', async t => {
  let finish, calls = 0;
  const { tracker } = setup(t, () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  });
  const summary = createUsageSummary({ memoryEntries: () => [local()], providerTiming: tracker, now: () => NOW });
  const query = { dashboard: '1', timing: 'provider' };
  const first = await summary.summarize(query);
  assert.equal(first.dashboard.records.rows[0].ms, null);
  assert.equal(first.scope.provider_timing.connections[0].syncing, true);
  const completed = tracker.sync({ refresh: false });
  finish(reply({ items: [remote()], pages: 1 }));
  await completed;
  const second = await summary.summarize({ ...query, timing_refresh: 'cache' });
  assert.equal(second.dashboard.records.rows[0].ms, 14060);
  assert.equal(second.scope.provider_timing.connections[0].syncing, false);
  assert.equal(calls, 1);
});

test('a batch writes history once and unchanged refreshes only write the small coverage file', async t => {
  const config = setup(t, async () => reply({ items: [remote()], pages: 1 }));
  const auth = JSON.parse(fs.readFileSync(config.authFile, 'utf8'));
  auth.connections.push({ ...auth.connections[0], provider_id: 'p2' });
  fs.writeFileSync(config.authFile, JSON.stringify(auth));
  const tracker = createProviderTiming({ ...config, getProviders: () => ({
    codex: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
  }) });
  const writes = [], rename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    writes.push(to);
    return rename(from, to);
  };
  t.after(() => { fs.promises.rename = rename; });
  const first = await tracker.sync({ from: NOW - DAY, to: NOW });
  assert.deepEqual(writes, [config.file, `${config.file}.coverage.json`]);
  assert.equal(JSON.parse(fs.readFileSync(config.file, 'utf8')).rows.length, 2);
  assert.deepEqual(first.connections.map(c => c.cached_rows), [1, 1]);
  assert.equal(fs.statSync(config.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${config.file}.coverage.json`).mode & 0o777, 0o600);
  const before = fs.statSync(config.file);
  writes.length = 0;
  await tracker.sync({ from: NOW - DAY, to: NOW, force: true });
  assert.deepEqual(writes, [`${config.file}.coverage.json`]);
  assert.equal(fs.statSync(config.file).ino, before.ino);
  assert.equal(fs.statSync(config.file).mtimeMs, before.mtimeMs);
  const restored = createProviderTiming({ ...config, fetchImpl: async () => {
    throw new Error('covered history must not refetch');
  } });
  const status = await restored.sync({ from: NOW - DAY, to: NOW });
  assert.deepEqual(status.warnings, []);
  assert.equal(status.connections[0].synced_at, new Date(NOW).toISOString());
  assert.equal(restored.match(compact(local())).duration_ms, 14060);
});

test('manual refresh bypasses freshness while cache-only reads never start synchronization', async t => {
  let calls = 0;
  const { tracker } = setup(t, async () => {
    calls++;
    return reply({ items: [remote()], pages: 1 });
  });
  await tracker.sync({ from: NOW - DAY, to: NOW, refresh: false });
  assert.equal(calls, 0);
  await tracker.sync({ from: NOW - DAY, to: NOW });
  await tracker.sync({ from: NOW - DAY, to: NOW });
  assert.equal(calls, 1);
  await tracker.sync({ from: NOW - DAY, to: NOW, force: true });
  assert.equal(calls, 2);
  await tracker.sync({ from: NOW - 2 * DAY, to: NOW, refresh: false });
  assert.equal(calls, 2);
});

test('selected channels scope network work and warnings while disabled bindings stay excluded', async t => {
  const called = [];
  const config = setup(t, async url => {
    called.push(url.hostname);
    return url.hostname === 'one.test' ? reply({ items: [remote()], pages: 1 }) : reply({}, 503);
  });
  const base = JSON.parse(fs.readFileSync(config.authFile, 'utf8')).connections[0];
  fs.writeFileSync(config.authFile, JSON.stringify({ connections: [
    { ...base, provider_id: 'p1', origin: 'https://one.test', key_id: 'key1' },
    { ...base, provider_id: 'p2', origin: 'https://two.test' },
    { ...base, provider_id: 'p3', origin: 'https://disabled.test' },
    { ...base, provider_id: 'p4', origin: 'https://retired.test', enabled: false },
  ] }));
  const tracker = createProviderTiming({ ...config, getProviders: () => ({ codex: [
    { id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' },
    { id: 'p3', name: 'Disabled', enabled: false }, { id: 'p4', name: 'Retired' },
  ] }) });
  const one = await tracker.sync({ from: NOW - DAY, to: NOW, providerIds: ['p1'] });
  assert.deepEqual(called, ['one.test']);
  assert.deepEqual(one.warnings, []);
  assert.deepEqual(one.connections.map(c => [c.provider_id, c.key_id, c.cached_rows]), [['p1', 'key1', 1]]);
  const all = await tracker.sync({ from: NOW - DAY, to: NOW });
  assert.deepEqual(called, ['one.test', 'two.test']);
  assert.deepEqual(all.connections.map(c => c.provider_id), ['p1', 'p2']);
  const filtered = await tracker.sync({ providerIds: ['p1'], refresh: false });
  assert.deepEqual(filtered.warnings, []);
});

test('summary passes channel and protocol filters plus the manual/cache refresh contract', async () => {
  const calls = [];
  const summary = createUsageSummary({ now: () => NOW,
    memoryEntries: () => [
      local({ provider: 'One' }),
      local({ provider_id: 'p2', provider: 'Two', app: 'claude', provider_app: 'claude' }),
      local({ provider_id: 'p3', provider: 'Shared', app: 'codex', provider_app: 'claude' }),
    ], providerTiming: {
      sync: async options => { calls.push(options); return { connections: [], warnings: [] }; },
      match: () => null,
    } });
  const query = { dashboard: '1', timing: 'provider' };
  await summary.summarize({ ...query, channel: 'id:p1', timing_refresh: 'force' });
  assert.deepEqual(calls.at(-1).providerIds, ['p1']);
  assert.equal(calls.at(-1).force, true);
  await summary.summarize({ ...query, provider: 'Two', timing_refresh: 'cache' });
  assert.deepEqual(calls.at(-1).providerIds, ['p2']);
  assert.equal(calls.at(-1).refresh, false);
  await summary.summarize({ ...query, app: 'codex' });
  assert.deepEqual(calls.at(-1).providerIds.sort(), ['p1', 'p3']);
  await summary.summarize(query);
  assert.equal(calls.at(-1).providerIds, null);
  await assert.rejects(summary.summarize({ ...query, timing_refresh: 'invalid' }), { code: 'USAGE_TIMING_INVALID' });
});

test('cancelled queued summaries skip history collection and do not block the next valid query', async () => {
  let release, started, reads = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const summary = createUsageSummary({ now: () => NOW, localUsage: {
    read: async () => {
      reads++;
      if (reads === 1) { started(); await new Promise(resolve => { release = resolve; }); }
      return { rows: [], warnings: [], routed: 0 };
    },
  } });
  const query = { dashboard: '1', range: 'today' };
  const first = summary.summarize(query);
  await entered;
  const controller = new AbortController();
  const abandoned = summary.summarize(query, { signal: controller.signal });
  const rejected = assert.rejects(abandoned, { name: 'AbortError' });
  const latest = summary.summarize(query);
  controller.abort();
  release();
  await Promise.all([first, rejected, latest]);
  assert.equal(reads, 2);
});

test('history loads lazily on first use instead of during construction', async t => {
  const config = setup(t, async () => reply({ items: [remote()], pages: 1 }));
  await config.tracker.sync({ from: NOW - DAY, to: NOW });
  assert.ok(fs.existsSync(config.file));
  // 构造后立刻删掉文件:如果构造阶段就解析过,内存里仍然有旧行。
  const lazy = createProviderTiming({ ...config, fetchImpl: async () => { throw new Error('no request expected'); } });
  fs.unlinkSync(config.file);
  await lazy.sync({ from: NOW - DAY, to: NOW, refresh: false });
  assert.equal(lazy.match(compact(local())), null, '首次使用时文件已不存在,说明构造阶段没有读取');
  // 同一份快照在首次 match() 时也能加载。
  const restored = createProviderTiming({ ...config, fetchImpl: async () => { throw new Error('no request expected'); } });
  fs.writeFileSync(config.file, JSON.stringify({ rows: [JSON.parse(JSON.stringify({
    app: 'codex', provider_id: 'p1', id: 10224230, key_id: '', backend: 'sub2api', precision_ms: 1,
    request_id: 'client:test-request', model: 'model', input: 257, output: 204, cache: 190720,
    at: Date.parse('2026-11-10T01:47:48.720Z'), duration_ms: 14060, first_token_ms: 11134,
  }))] }));
  assert.equal(restored.match(compact(local())).duration_ms, 14060);
});

test('auth file is parsed once per (mtime, size) instead of every sync', async t => {
  const config = setup(t, async () => reply({ items: [], pages: 1 }));
  const reads = [];
  const realRead = fs.readFileSync;
  fs.readFileSync = (file, ...args) => { reads.push(String(file)); return realRead(file, ...args); };
  t.after(() => { fs.readFileSync = realRead; });
  await config.tracker.sync({ from: NOW - DAY, to: NOW, refresh: false });
  const first = reads.filter(file => file === config.authFile).length;
  assert.equal(first, 1);
  await config.tracker.sync({ from: NOW - DAY, to: NOW, refresh: false });
  assert.equal(reads.filter(file => file === config.authFile).length, first, 'mtime 与 size 未变时复用解析结果');
  fs.writeFileSync(config.authFile, JSON.stringify({ connections: [] }));
  await config.tracker.sync({ from: NOW - DAY, to: NOW, refresh: false });
  assert.equal(reads.filter(file => file === config.authFile).length, first + 1, '文件变化后重新解析');
});

test('history writes are coalesced inside the interval and flushed after it', async t => {
  let clock = NOW, items = [remote()];
  const config = setup(t, async () => reply({ items, pages: 1 }));
  const tracker = createProviderTiming({ ...config, now: () => clock, writeIntervalMs: 5000 });
  const first = await tracker.sync({ from: NOW - DAY, to: NOW });
  assert.deepEqual(first.connections.map(connection => connection.cached_rows), [1]);
  assert.equal(JSON.parse(fs.readFileSync(config.file, 'utf8')).rows.length, 1);
  items = [remote(), remote({ id: 10224231, request_id: 'second-request', output_tokens: 300, duration_ms: 20000 })];
  clock += 1000;
  const second = await tracker.sync({ from: NOW - DAY, to: NOW, force: true });
  assert.deepEqual(second.connections.map(connection => connection.cached_rows), [2], '计数增量维护');
  assert.equal(JSON.parse(fs.readFileSync(config.file, 'utf8')).rows.length, 1, '间隔内合并成一次写盘');
  assert.equal(tracker.match(compact(local())).duration_ms, 14060, '内存中的数据立即可用');
  clock += 5000;
  await tracker.sync({ from: NOW - DAY, to: NOW, force: true });
  assert.equal(JSON.parse(fs.readFileSync(config.file, 'utf8')).rows.length, 2, '间隔过后补写');
});

test('usage HTTP disconnect aborts its queued summary and sends no late response', async () => {
  let signal, release;
  const res = new EventEmitter(), sent = [];
  res.writableFinished = false;
  const handle = createStatusApi({ usageSummary: {
    summarize: (_query, options) => {
      signal = options.signal;
      return new Promise(resolve => { release = resolve; });
    },
  } });
  const request = handle({ req: { method: 'GET' }, res, url: new URL('http://local/api/usage'),
    send: (...args) => sent.push(args), sendErr: (...args) => sent.push(args) });
  assert.equal(signal.aborted, false);
  res.emit('close');
  assert.equal(signal.aborted, true);
  release({});
  await request;
  assert.deepEqual(sent, []);
  assert.equal(res.listenerCount('close'), 0);
});
