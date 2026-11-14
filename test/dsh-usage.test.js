'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createDshSessionUsage } = require('../lib/usage/dsh-sessions');
const { createLocalSessionUsage } = require('../lib/usage/local-sessions');
const { createUsageSummary } = require('../lib/usage/summary');
const { runtimeConfig } = require('../lib/runtime/config');
const { testEnv } = require('../scripts/run-tests');

const now = Date.now(), time = now - 2000;
const header = (id = 'session-one', version = 4) => ({ type: 'session', version, id, createdAt: now - 10000,
  cwd: '/PRIVATE_PATH_SENTINEL', isSeeded: false, delegationDepth: 0 });
const route = (provider = 'ag', model = 'gpt-6.1-sol') => ({ type: 'request/header', time: now - 9000, seq: 0,
  data: { header: { config: { provider, model }, tools: ['PRIVATE_PROMPT_SENTINEL'] } } });
const usage = { inputTokens: 20, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 30, totalTokens: 100 };
const assistant = (id = 'response-one', options = {}) => ({ type: 'assistant/message', time, seq: 1,
  data: { turn: 1, step: 1, usage, message: { id, role: 'assistant', content: [{ text: 'PRIVATE_PROMPT_SENTINEL' }],
    source: { kind: 'model', provider: 'ag', model: 'gpt-6.1-sol', replayState: { response: {
      api: 'openai-responses', responseId: id, apiKey: 'PRIVATE_KEY_SENTINEL' } } } }, stream: [] }, ...options });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-dsh-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(name, rows, compressed = false) {
    const file = path.join(root, 'sessions', name, `session.v4.jsonl${compressed ? '.zstd' : ''}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = rows.map(row => Buffer.from(JSON.stringify(row) + '\n'));
    fs.writeFileSync(file, Buffer.concat(compressed ? bytes.map(b => zlib.zstdCompressSync(b)) : bytes));
    return file;
  }
  const options = { dshHome: root, now: () => now };
  return { root, write, options, reader: createDshSessionUsage(options) };
}

test('DSH usage preserves native uncached/cache-write buckets, recorded route and metadata privacy', async t => {
  const f = fixture(t), file = f.write('project/one', [header(), route(), assistant()]);
  const before = fs.readFileSync(file);
  const result = await f.reader.read();
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.in, 50); assert.equal(row.out, 10); assert.equal(row.cache_read, 40);
  assert.equal(row.cache_write, 30); assert.equal(row.status, null); assert.equal(row.ms, null);
  assert.equal(row.app, 'codex'); assert.equal(row.source, 'dsh-local');
  assert.equal(row.provider, 'DeepSeek Harness · ag'); assert.equal(row.provider_id, 'dsh:ag');
  assert.equal(row.model_out, 'gpt-6.1-sol');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|apiKey|content|cwd|jsonl/);
  assert.deepEqual(await f.reader.read(), result);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('DSH fork copies, repeated usage settlements and migrated generations count each attempt once', async t => {
  const f = fixture(t);
  f.write('project/parent', [header(), route(), assistant()]);
  f.write('project/child', [header('child'), route(), assistant(), assistant('child-response', { time: time + 100,
    data: { ...assistant('child-response').data, step: 2 } })]);
  const parent = path.join(f.root, 'sessions/project/parent');
  fs.writeFileSync(path.join(parent, 'session.v3.jsonl'), [header('session-one', 3), route(), assistant('obsolete')]
    .map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.equal((await f.reader.read()).rows.length, 2);
});

test('DSH replaces same-slot usage, retains retries and reads last stream usage sample', async t => {
  const f = fixture(t);
  const attempt = { type: 'assistant/attempt', time: time - 500, data: { turn: 1, step: 1,
    stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { ...usage, outputTokens: 3 } } }] } };
  const settled = assistant('settled');
  const retry = { type: 'llm/retry-started', time: time + 20, data: { turn: 1, step: 1 } };
  f.write('one', [header(), route(), attempt, settled, retry, { ...attempt, time: time + 30 }]);
  const result = await f.reader.read();
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.reduce((n, row) => n + row.out, 0), 13);
});

test('DSH stream-only usage uses historical header and message protocol; synthetic/no-usage events ignored', async t => {
  const f = fixture(t);
  const native = assistant('anthropic');
  delete native.data.usage;
  native.data.message.source.replayState.response.api = 'anthropic-messages';
  native.data.stream = [{ type: 'chunk', chunk: { type: 'usage', usage: { ...usage, outputTokens: 1 } } },
    { type: 'chunk', chunk: { type: 'usage', usage } }];
  const attempt = { type: 'assistant/attempt', time: time + 100, data: { turn: 1, step: 2,
    usage, stream: [] } };
  const synthetic = assistant('synthetic', { time: time + 200 });
  synthetic.data.message.source.kind = 'synthetic';
  const noUsage = assistant('none'); delete noUsage.data.usage;
  f.write('one', [header(), route('historic-provider', 'historic-model'), native, attempt, synthetic, noUsage]);
  const result = await f.reader.read();
  assert.equal(result.rows.length, 3, 'settled model calls with unreported usage still have a known outcome');
  assert.equal(result.rows.find(r => r.app === 'claude').out, 10);
  const historic = result.rows.find(r => r.model_out === 'historic-model');
  assert.equal(historic.model_out, 'historic-model');
  assert.equal(historic.provider, 'DeepSeek Harness · historic-provider');
  assert.equal((await f.reader.read({ app: 'claude' })).rows.length, 1);
});

test('DSH plain incremental reads wait for complete records and recover truncation/replacement/deletion', async t => {
  const f = fixture(t), file = f.write('one', [header(), route(), assistant()]);
  assert.equal((await f.reader.read()).rows.length, 1);
  const next = assistant('next', { time: time + 100, data: { ...assistant('next').data, step: 2 } });
  const text = JSON.stringify(next);
  fs.appendFileSync(file, text.slice(0, -8));
  assert.equal((await f.reader.read()).rows.length, 1);
  fs.appendFileSync(file, text.slice(-8) + '\n');
  assert.equal((await f.reader.read()).rows.length, 2);
  f.write('one', [header(), route(), assistant('rewrite')]);
  assert.deepEqual((await f.reader.read()).rows.map(r => r.request_id), ['dsh:rewrite']);
  fs.unlinkSync(file);
  assert.equal((await f.reader.read()).rows.length, 0);
});

test('DSH Zstandard reads all concatenated frames and resumes a torn final frame', {
  skip: typeof zlib.zstdCompressSync !== 'function',
}, async t => {
  const f = fixture(t), file = f.write('one', [header(), route(), assistant()], true);
  assert.equal((await f.reader.read()).rows.length, 1);
  const next = assistant('next', { time: time + 100, data: { ...assistant('next').data, step: 2 } });
  const frame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(next) + '\n'));
  fs.appendFileSync(file, frame.subarray(0, frame.length - 4));
  let result = await f.reader.read();
  assert.equal(result.rows.length, 1); assert.deepEqual(result.warnings, []);
  fs.appendFileSync(file, frame.subarray(frame.length - 4));
  result = await f.reader.read();
  assert.equal(result.rows.length, 2); assert.deepEqual(result.warnings, []);
  assert.deepEqual(await f.reader.read(), result);
});

test('损坏的完整 zstd 帧被跳过并推进游标,同文件后续帧与其他文件照常读取', {
  skip: typeof zlib.zstdCompressSync !== 'function',
}, async t => {
  const f = fixture(t);
  const frameOf = row => zlib.zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n'));
  const file = f.write('project/one', [header(), route()], true);
  const broken = frameOf(assistant('broken'));
  broken[6] ^= 0xff;                       // 帧头之后的内容大小/块数据被破坏
  fs.appendFileSync(file, broken);
  fs.appendFileSync(file, frameOf(assistant('next', { time: time + 100,
    data: { ...assistant('next').data, step: 2 } })));
  f.write('project/two', [header('session-two'), route(), assistant('other')]);
  const result = await f.reader.read();
  assert.deepEqual(result.rows.map(row => row.request_id).sort(), ['dsh:next', 'dsh:other'],
    '坏帧被跳过,后面的帧和其他文件都读到了');
  assert.ok(result.warnings.includes('Harness: ZSTD_DECODE_FAILED'));
  const again = await f.reader.read();
  assert.deepEqual(again.rows, result.rows);
  assert.deepEqual(again.warnings, [], '游标已越过坏帧,不会反复报同一条警告');
});

test('DSH future format and corrupt complete frames expose warnings without transcript details', async t => {
  const f = fixture(t);
  f.write('future', [header('future', 99), route(), assistant()]);
  let result = await f.reader.read();
  assert.equal(result.rows.length, 0); assert.deepEqual(result.warnings, ['Harness: DSH_FORMAT_UNSUPPORTED']);
  if (typeof zlib.zstdCompressSync === 'function') {
    const file = f.write('bad', [header(), route()], true);
    fs.appendFileSync(file, Buffer.from('PRIVATE_PROMPT_SENTINEL'));
    result = await f.reader.read();
    assert.ok(result.warnings.includes('Harness: ZSTD_DECODE_FAILED'));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  }
});

test('DSH source flows through summary, paging, filters and model outcomes without inventing HTTP status', async t => {
  const f = fixture(t); f.write('one', [header(), route(), assistant()]);
  const localUsage = createLocalSessionUsage(f.options);
  const summary = createUsageSummary({ localUsage, now: () => now });
  const result = await summary.summarize({ range: 'today', dashboard: '1', search: 'response-one' });
  assert.equal(result.totals.reqs, 1); assert.equal(result.totals.tokens_total, 100);
  assert.equal(result.totals.tokens_in, 50); assert.equal(result.scope.local_usage.dsh, 1);
  assert.equal(result.scope.local_usage.codex, 0); assert.equal(result.scope.source, 'gateway+local');
  assert.equal(result.scope.status_samples, 1); assert.equal(result.totals.ok_rate, 100);
  assert.equal(result.totals.speed_tps, null);
  assert.deepEqual(result.dashboard.outcomes, { succeeded: 1, failed: 0 });
  const row = result.dashboard.records.rows[0];
  assert.equal(row.source, 'dsh-local'); assert.equal(row.status, null); assert.equal(row.in, 50);
  assert.equal(result.dashboard.by_channel[0].channel, 'id:dsh:ag');
  assert.equal((await summary.summarize({ range: 'today', dashboard: '1', status: 'ok' })).totals.reqs, 1);
  assert.equal((await summary.summarize({ range: 'today', dashboard: '1', status: 'unknown' })).totals.reqs, 0);
  assert.equal((await summary.summarize({ range: 'today', dashboard: '1',
    status_code: 'unknown', channel: 'id:dsh:ag' })).totals.reqs, 1);
});

test('DSH retention and entry caps apply to accounting metadata and custom ranges', async t => {
  const f = fixture(t);
  f.write('one', [header(), route(), assistant('old', { time: now - 40 * 86400000 }),
    assistant('one'), assistant('two', { time: time + 100, data: { ...assistant('two').data, step: 2 } })]);
  const capped = createDshSessionUsage({ ...f.options, maxEntries: 1 });
  const result = await capped.read();
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].request_id, 'dsh:two');
  assert.equal(result.truncated, true);
  assert.equal((await f.reader.read({ from: time + 50 })).rows.length, 1);
});

test('live application usage API includes configured Harness metadata without touching routes or source files', async t => {
  const f = fixture(t), file = f.write('one', [header(), route(), assistant()]);
  const before = fs.readFileSync(file);
  const { createApplication } = require('../lib/application');
  const app = createApplication({ root: path.resolve(__dirname, '..'), version: 'test', home: f.root,
    env: { MIXR_DATA_DIR: path.join(f.root, 'router-data'), MIXR_DSH_HOME: f.root,
      MIXR_CODEX_CONFIG: path.join(f.root, 'codex/config.toml'),
      MIXR_CLAUDE_SETTINGS: path.join(f.root, 'claude/settings.json') } });
  const server = await app.listen(0, app.apiHandler);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const stateBefore = structuredClone({ routes: app._state.routes, store: app._state.store, slots: app._state.slotMap });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/usage?range=today&dashboard=1`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.scope.local_usage.dsh, 1);
  assert.equal(result.totals.tokens_total, 100);
  assert.equal(result.dashboard.records.rows[0].source, 'dsh-local');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|apiKey|content|cwd/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual({ routes: app._state.routes, store: app._state.store, slots: app._state.slotMap }, stateBefore);
});

test('DSH timestamps restore model elapsed, first event, TTFT and decode duration; rates use different denominators', async t => {
  const f = fixture(t), start = time - 10000;
  const message = assistant('timed');
  message.data.usage = { ...usage, outputTokens: 100 };
  message.data.stream = [
    { type: 'chunk', time: start + 2000, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { type: 'text-chunks', time0: start + 7500, index: 0, dt: [500, 500], texts: ['', 'PRIVATE_TEXT', 'output'] },
    { type: 'chunk', time: time - 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'PRIVATE_TEXToutput' } } },
    { type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ];
  f.write('timed', [header(), route(), { type: 'step/start', time: start, data: { turn: 1, step: 1 } }, message,
    { type: 'step/end', time: time + 100000, data: { turn: 1, step: 1 } }]);
  const { rows } = await f.reader.read();
  assert.equal(rows[0].ms, 10000, 'tool time after assistant settlement is excluded');
  assert.equal(rows[0].first_event_ms, 2000); assert.equal(rows[0].ttft_ms, 8000);
  assert.equal(rows[0].decode_ms, 2000); assert.equal(rows[0].timing_quality, 'streamed');
  assert.equal(rows[0].outcome, 'completed'); assert.equal(rows[0].status, null);
  const summary = createUsageSummary({ localUsage: f.reader, now: () => now });
  const result = await summary.summarize({ range: 'today', dashboard: '1' });
  const row = result.dashboard.records.rows[0];
  assert.equal(row.speed_tps, 10); assert.equal(row.speed_tpm, 600); assert.equal(row.decode_tps, 50);
  assert.equal(result.totals.speed_tps, 10); assert.equal(result.totals.speed_tpm, 600);
  assert.equal(result.totals.decode_tps, 50); assert.equal(result.totals.first_event_p50_ms, 2000);
  assert.equal(result.totals.ttft_p50_ms, 8000);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEXT/);
});

test('buffered text before late tool deltas never inflates generation TPS', async t => {
  const f = fixture(t), start = time - 10000;
  const message = assistant('buffered'); message.data.usage = { ...usage, outputTokens: 1000 };
  message.data.stream = [
    { type: 'chunk', time: start + 2000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
    { type: 'chunk', time: start + 9500, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE_REASONING' } } },
    { type: 'tool-call-chunks', time0: start + 9900, index: 1, name: 'tool', dt: [], args: ['{}'] },
    { type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
  ];
  f.write('one', [header(), route(), { type: 'step/start', time: start, data: { turn: 1, step: 1 } }, message]);
  const result = await createUsageSummary({ localUsage: f.reader, now: () => now }).summarize({ range: 'today', dashboard: '1' });
  const row = result.dashboard.records.rows[0];
  assert.equal(row.timing_quality, 'buffered'); assert.equal(row.ms, 10000);
  assert.equal(row.first_event_ms, 2000); assert.equal(row.ttft_ms, null); assert.equal(row.decode_ms, null);
  assert.equal(row.speed_tps, 100); assert.equal(row.speed_tpm, 6000);
  assert.equal(row.decode_tps, null, 'a late 100ms tool delta does not imply 10,000 TPS for prior text');
  assert.equal(result.totals.decode_tps, null);
});

test('packed tool-name deltas and whitespace count as first tokens; empty fragments and invalid times do not', () => {
  const { streamFacts } = require('../lib/usage/dsh-sessions');
  assert.equal(streamFacts([{ type: 'tool-call-chunks', time0: 100, dt: [], name: 'tool', args: [''] }]).firstToken, 100);
  assert.equal(streamFacts([{ type: 'reasoning-chunks', time0: 100, dt: [20, 30], texts: ['', '', ' '] }]).firstToken, 150);
  assert.equal(streamFacts([{ type: 'text-chunks', time0: 100, dt: [NaN], texts: ['', 'text'] }]).firstToken, null);
  assert.equal(streamFacts([{ type: 'chunk', time: 100, chunk: { type: 'block-start' } }]).firstToken, null);
  assert.equal(streamFacts([
    { type: 'text-chunks', time0: 100, index: 0, dt: [], texts: ['tail'] },
    { type: 'chunk', time: 200, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'missing prefix tail' } } },
  ]).buffered, true, 'a partial delta stream is not mistaken for a complete token-timed stream');
  assert.equal(streamFacts([
    { type: 'chunk', time: 100, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
    { type: 'chunk', time: 5000, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } } },
    { type: 'tool-call-chunks', time0: 5100, index: 1, name: 'tool', args: ['{}'], dt: [] },
  ]).buffered, true, 'hidden reasoning output has no token timestamp even when its text is empty');
});

test('native finish and interrupted flags distinguish completion, failure and cancellation without invented HTTP status', async t => {
  const f = fixture(t), events = [header(), route()];
  for (const [index, kind] of ['stop', 'tool-calls', 'max-tokens', 'error', 'aborted'].entries()) {
    events.push({ type: 'step/start', time: time - 1000 + index * 20, data: { turn: 1, step: index + 1 } });
    events.push({ type: kind === 'error' || kind === 'aborted' ? 'assistant/attempt' : 'assistant/message', time: time + index * 20,
      data: { ...assistant(kind).data, step: index + 1, stream: [
        { type: 'chunk', time: time + index * 20, chunk: { type: 'finish', reason: {
          kind, ...(kind === 'error' ? { failure: { code: 'AUTH', message: 'PRIVATE_KEY_SENTINEL' } } : {}) } } },
      ] } });
  }
  events.push({ ...assistant('interrupted'), time: time + 200, data: { ...assistant('interrupted').data, step: 6, interrupted: true } });
  f.write('outcomes', events);
  const rows = (await f.reader.read()).rows;
  assert.deepEqual(rows.filter(r => r.outcome === 'completed').map(r => r.finish_reason).sort(), ['max-tokens', 'stop', 'tool-calls']);
  assert.equal(rows.filter(r => r.outcome === 'failed').length, 1);
  assert.equal(rows.filter(r => r.outcome === 'cancelled').length, 2);
  assert.ok(rows.every(r => r.status === null));
  const summary = createUsageSummary({ localUsage: f.reader, now: () => now });
  const result = await summary.summarize({ range: 'today', dashboard: '1' });
  assert.deepEqual(result.dashboard.outcomes, { succeeded: 3, failed: 3 });
  assert.equal(result.totals.ok_rate, 50);
  assert.equal((await summary.summarize({ range: 'today', dashboard: '1', status: 'err' })).totals.reqs, 3);
  assert.equal((await summary.summarize({ range: 'today', dashboard: '1', status_code: 'unknown' })).totals.reqs, 6);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEY_SENTINEL/);
});

test('failed attempts without usage are counted, with status only when explicitly recorded', async t => {
  const f = fixture(t);
  f.write('failures', [header(), route(),
    { type: 'assistant/attempt', time, data: { turn: 1, step: 1, stream: [
      { type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'error', failure: { status: 429 } } } },
    ] } },
    { type: 'step/start', time: time + 1, data: { turn: 1, step: 2 } },
    { type: 'assistant/attempt', time: time + 2, data: { turn: 1, step: 2, stream: [] } },
    { type: 'step/end', time: time + 3, data: { turn: 1, step: 2 } },
    { type: 'turn/end', time: time + 4, data: { reason: { kind: 'error' } } },
  ]);
  const rows = (await f.reader.read()).rows;
  assert.equal(rows.length, 2); assert.ok(rows.every(r => r.outcome === 'failed'));
  assert.equal(rows.find(r => r.finish_reason === 'error' && r.status === 429).out, null);
  assert.equal(rows.find(r => r.status === null).finish_reason, 'error');
});

test('first-token timing survives same-step retries and uses the native settlement boundary', async t => {
  const f = fixture(t), start = time - 10000;
  const attempt = { type: 'assistant/attempt', time: time - 4000, data: { turn: 1, step: 1, stream: [
    { type: 'reasoning-chunks', time0: start + 2000, index: 0, dt: [], texts: ['reasoning'] },
    { type: 'chunk', time: time - 4000, chunk: { type: 'finish', reason: { kind: 'error' } } },
  ] } };
  const done = assistant('retry-success'); done.data.stream = [
    { type: 'text-chunks', time0: time - 1000, index: 0, dt: [], texts: ['text'] },
    { type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ];
  f.write('retry', [header(), route(), { type: 'step/start', time: start, data: { turn: 1, step: 1 } }, attempt,
    { type: 'llm/retry-started', time: time - 3000, data: { turn: 1, step: 1 } }, done]);
  const row = (await f.reader.read()).rows.find(r => r.outcome === 'completed');
  assert.equal(row.ms, 10000); assert.equal(row.ttft_ms, 2000); assert.equal(row.decode_ms, 8000);
});

test('DSH home is configurable and the test runner never inherits real accounting paths', () => {
  const config = env => runtimeConfig({ root: '/fixture/router', home: '/fixture/home', env });
  assert.equal(config({}).DSH_HOME, path.join('/fixture/home', '.dsh'));
  assert.equal(config({ DSH_HOME: '/fixture/custom' }).DSH_HOME, '/fixture/custom');
  assert.equal(config({ DSH_HOME: '/fixture/custom', MIXR_DSH_HOME: '/fixture/override' }).DSH_HOME, '/fixture/override');
  const isolated = testEnv({ DSH_HOME: '/PRIVATE_PATH_SENTINEL', MIXR_DSH_HOME: '/PRIVATE_PATH_SENTINEL' }, '/fixture/test');
  assert.equal(isolated.DSH_HOME, undefined); assert.equal(isolated.MIXR_DSH_HOME, undefined);
});
