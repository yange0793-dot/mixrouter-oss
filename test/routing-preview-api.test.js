'use strict';
// 真实 apiHandler 接线,只监听临时回环端口;不启动常驻入口,不调用 /api/state 或配置写 API。
// 瘦身之后预览只能解释三步:压缩内容规则 → 精确槽位别名 → 唯一登记模型。
// 因此所有夹具都按这三者搭:压缩规则要带登记过的 when.body,槽位要绑渠道,
// 普通请求用**唯一登记**的模型名(多渠道同名是 409 歧义,不能当普通夹具)。
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { testEnv } = require('../scripts/run-tests');
const { FIXED_PREFIX, COMPACT_RULES } = require('../lib/routing/compact-signature');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-preview-api-'));
const env = testEnv(process.env, TMP);
for (const key of Object.keys(process.env)) if (/^(MIXR_|MIXROUTER_|MIXUI_)/.test(key)) delete process.env[key];
Object.assign(process.env, env);
for (const dir of ['home', 'data', 'tmp']) fs.mkdirSync(path.join(TMP, dir));
const mod = require('../mixrouter');
let server, upstream, upstreamHits = 0;
const post = (body, headers = {}) => new Promise((resolve, reject) => {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/routing/preview',
    method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('error', reject);
    res.on('aborted', () => reject(new Error('response aborted')));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: res.statusCode, json: JSON.parse(text), text });
    });
  });
  req.on('error', reject);
  req.setTimeout(3000, () => req.destroy(new Error('test request timeout')));
  req.end(data);
});
// 每个渠道登记一个**独有**模型名 m-<id>:多渠道登记同一个模型在实跑里是 409 歧义。
const provider = (id, extra = {}) => ({ id, name: `channel-${id}`, enabled: true,
  base_url: `http://127.0.0.1:${upstream.address().port}`, api_key: 'FAKE-PROVIDER-SECRET',
  keys: [{ id: 'key', key: 'FAKE-KEY-SECRET' }], active_key: 'key', models: ['m-' + id], ...extra });
// 压缩规则的身份来自 when.body(见 compact-signature),id 随便写。
const compactRule = (extra = {}) => ({ id: 'compact-global', match: '', app: 'claude', enabled: true,
  priority: 90, when: { body: COMPACT_RULES[0].body }, provider: '', model: '', pool: [],
  strategy: 'priority', ...extra });
const SUMMARY = FIXED_PREFIX + 'Your task is to create a detailed summary of the conversation so far.';
const compactContext = extra => ({ compactTexts: [SUMMARY], ...extra });

before(async () => {
  upstream = http.createServer((_req, res) => { upstreamHits++; res.end('{}'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  server = await mod.listen(0, mod.apiHandler);
  for (const s of [server, upstream]) assert.ok(![8787, 8788].includes(s.address().port));
});
beforeEach(() => {
  mod._state.store = {
    claude: [provider('pa'), provider('pb'), provider('outside')],
    codex: [provider('pchat', { wire_api: 'chat', model: 'm-pchat' }),
      provider('presp', { model: 'm-presp' }), provider('presp2', { model: 'm-presp2' })],
  };
  mod._state.routes = { rules: [] };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.sessions = new Map();
  mod._state.cooldowns = {};
  mod._state.resetPools();
  upstreamHits = 0;
});
after(async () => {
  await Promise.all([server, upstream].filter(Boolean).map(s => new Promise(resolve => s.close(resolve))));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('preview API 返回 explainRoute 本体,含首选来源和默认 kind', async () => {
  const input = { app: 'claude', model: 'm-pa' };
  const r = await post(input);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, mod.explainRoute(input));
  assert.equal(r.json.input.kind, 'messages');
  assert.equal(r.json.matched.via, 'model');
  assert.equal(r.json.matched.ruleId, 'model:pa');
  assert.equal(r.json.selection.source, 'strategy');
  assert.equal(r.json.selection.predicted.providerId, 'pa');
  assert.equal(r.json.selection.predicted.model, 'm-pa');
  assert.ok(r.json.warnings.some(w => w.code === 'new_session_preview'));
  assert.equal(upstreamHits, 0);
});

test('preview API 注入真实 sessionSnapshot,不剪枝、不 touch、不写盘、不发上游', async () => {
  // 夹具的"过期"必须用**自动绑定**(没有 routing、没有 pinned)来表示:
  // 手动配置(钉定/Key 槽位覆盖)从第二期起不再被 TTL 回收,用 pinned 造过期夹具会变成"它本来就该留下"。
  const stale = Object.freeze({ providerId: 'pa', lastUsed: 0 });
  const live = Object.freeze({ providerId: 'outside', lastUsed: Date.now(), pinned: true, model: 'pinned-model', reqs: 7 });
  mod._state.sessions = new Map([['cc:stale', stale], ['cc:full-key', live]]);
  mod._state.cooldowns = { pa: 0 };
  const before = JSON.stringify({ sessions: [...mod._state.sessions], cooldowns: mod._state.cooldowns, pools: mod._state.pools });
  const dataBefore = fs.readdirSync(process.env.MIXR_DATA_DIR);
  const input = { app: 'claude', model: 'm-pa', context: { session: 'cc:full-key' } };
  for (let i = 0; i < 3; i++) {
    const r = await post(input);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.selection.source, 'pinned');
    assert.equal(r.json.selection.predicted.providerId, 'outside');
    assert.equal(r.json.selection.predicted.model, 'pinned-model');
    assert.equal(r.json.warnings.some(w => w.code === 'session_snapshot_unavailable'), false);
  }
  const expired = await post({ ...input, context: { session: 'cc:stale' } });
  assert.equal(expired.json.selection.source, 'strategy');
  assert.equal(expired.json.selection.predicted.providerId, 'pa');
  assert.equal(JSON.stringify({ sessions: [...mod._state.sessions], cooldowns: mod._state.cooldowns, pools: mod._state.pools }), before);
  assert.equal(mod._state.sessions.get('cc:stale'), stale);
  assert.equal(mod._state.sessions.get('cc:full-key'), live);
  assert.deepEqual(fs.readdirSync(process.env.MIXR_DATA_DIR), dataBefore);
  assert.equal(upstreamHits, 0);
});

test('preview API 按 slotMap 判断未绑定与不存在,不把内置槽名猜成现存', async () => {
  // 槽位别名解析不到渠道时不再"落到兜底池":明确 503,只在 warnings 里说清是
  // "槽位存在但没绑渠道"还是"槽位表里根本没有这个槽"。
  mod._state.slotMap = { claude: { empty: {} }, codex: {} };
  const unbound = await post({ app: 'claude', model: ' MIXR-EMPTY ' });
  assert.equal(unbound.status, 503, unbound.text);
  assert.equal(unbound.json.error.code, 'no_route_error');
  assert.equal(unbound.json.matched.via, 'model');
  assert.equal(unbound.json.matched.ruleId, null);
  assert.ok(unbound.json.warnings.some(w => w.code === 'slot_unbound'));
  const absent = await post({ app: 'claude', model: 'mixr-haiku' });
  assert.equal(absent.status, 503, absent.text);
  assert.ok(absent.json.warnings.some(w => w.code === 'slot_fell_through'));
  assert.equal(absent.json.warnings.some(w => w.code === 'slot_unbound'), false);
  assert.equal(upstreamHits, 0);
});

test('selection.candidates 在四个分支都列完整候选池,不因有首选就缩成单元素', async () => {
  // candidates 是候选池,不是最终落点:compact / sticky / pinned / strategy 四个分支给同一份
  // kind 过滤后的有效成员。钉定可以选池外渠道,那时 predicted 故意不在 candidates 里。
  // 池里有两个成员的只有压缩规则这一路(唯一登记模型的候选恒为 1),所以候选池宽度直接从它核。
  const binding = (providerId, extra = {}) => ({ providerId, lastUsed: Date.now(), pinned: false, ...extra });
  mod._state.routes = { rules: [compactRule({ provider: 'pa', pool: [
    { provider: 'pa', model: 'm-pa' }, { provider: 'pb', model: 'm-pb' }] })] };

  const strategy = await post({ app: 'claude', model: 'm-pa' });
  assert.equal(strategy.json.selection.source, 'strategy');
  assert.equal(strategy.json.selection.predicted.providerId, 'pa');
  assert.deepEqual(strategy.json.selection.candidates, ['pa']);

  mod._state.sessions = new Map([['cc:pooled', binding('pa')]]);
  const sticky = await post({ app: 'claude', model: 'm-pa', context: { session: 'cc:pooled' } });
  assert.equal(sticky.json.selection.source, 'sticky');
  assert.deepEqual(sticky.json.selection.candidates, ['pa']);

  mod._state.sessions = new Map([['cc:pinned', binding('outside', { pinned: true, model: 'pinned-model' })]]);
  const pinned = await post({ app: 'claude', model: 'm-pa', context: { session: 'cc:pinned' } });
  assert.equal(pinned.json.selection.source, 'pinned');
  assert.equal(pinned.json.selection.predicted.providerId, 'outside', '钉定故意选池外');
  assert.deepEqual(pinned.json.selection.candidates, ['pa'], '钉定可以选池外,候选池不因此变宽');

  mod._state.sessions = new Map();
  const content = await post({ app: 'claude', model: 'm-pa', context: compactContext() });
  assert.equal(content.json.selection.source, 'compact');
  assert.equal(content.json.matched.via, 'compact');
  assert.equal(content.json.selection.predicted.providerId, 'pa');
  assert.deepEqual(content.json.selection.candidates, ['pa', 'pb'], '压缩规则带备池时要列全');
  assert.deepEqual(content.json.limits.arrays['selection.candidates'], { total: 2, shown: 2, omitted: 0 });
  assert.equal(content.json.effective.length, 2);
  assert.deepEqual(content.json.limits.arrays['matched.rule.pool'], { total: 2, shown: 2, omitted: 0 });

  for (const [name, r] of [['strategy', strategy], ['sticky', sticky], ['pinned', pinned], ['compact', content]]) {
    assert.deepEqual(r.json.limits.arrays['selection.candidates'],
      { total: r.json.selection.candidates.length, shown: r.json.selection.candidates.length, omitted: 0 },
      `${name} 分支丢了候选池总数`);
  }
});

test('每个展示数组各自截断并保留总数,不被彼此的上限连坐', async () => {
  // 120 个渠道(60 chat / 60 responses)+ 40 个幽灵引用:六个数组的 total 各不相同,
  // 任何一个"顺手复用上一个上限"或"用 shown 冒充 total"的实现都会在这里露出来。
  mod._state.store.codex = Array.from({ length: 120 }, (_, i) =>
    provider(`p${i}`, i % 2 ? { wire_api: 'chat' } : {}));
  mod._state.routes = { rules: [compactRule({ app: 'codex', provider: '', model: '', pool: [
    ...mod._state.store.codex.map(p => ({ provider: p.id, model: 'provider-model', weight: 2, api_key: 'POOL-SECRET' })),
    ...Array.from({ length: 40 }, (_, i) => ({ provider: `gone-${i}` })),
  ] })] };
  const r = await post({ app: 'codex', model: 'm-p0', kind: 'chat/completions', context: compactContext() });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.matched.via, 'compact');
  const arrays = r.json.limits.arrays;
  assert.deepEqual(
    { pool: arrays['matched.rule.pool'], candidates: arrays.candidates, effective: arrays.effective,
      selection: arrays['selection.candidates'], kept: arrays['kindFilter.kept'],
      dropped: arrays['kindFilter.dropped'], ghosts: arrays.ghosts },
    { pool: { total: 160, shown: 50, omitted: 110 }, candidates: { total: 120, shown: 50, omitted: 70 },
      effective: { total: 60, shown: 50, omitted: 10 }, selection: { total: 60, shown: 50, omitted: 10 },
      kept: { total: 60, shown: 50, omitted: 10 }, dropped: { total: 60, shown: 50, omitted: 10 },
      ghosts: { total: 40, shown: 40, omitted: 0 } });
  for (const [field, len] of [['matched.rule.pool', 50], ['candidates', 50], ['effective', 50],
    ['selection.candidates', 50], ['kindFilter.kept', 50], ['kindFilter.dropped', 50], ['ghosts', 40]])
    assert.equal(field.split('.').reduce((v, k) => v[k], r.json).length, len, field);
  assert.equal(r.json.limits.arraysTruncated, true);
  assert.equal(r.text.includes('POOL-SECRET'), false, '池成员白名单化:非白名单字段不得随截断漏出');
  assert.deepEqual(r.json.matched.rule.pool[0], { provider: 'p0', model: 'provider-model', weight: 2 });
  assert.equal(upstreamHits, 0);
});

test('preview API 三种已解析错误按 error.httpStatus 返回,且元数据没有丢', async () => {
  for (const [target, input, code, status] of [
    // 压缩规则指向已删渠道:成员为空 + 幽灵引用,503 且带 ghost_ref 提醒
    [compactRule({ provider: 'gone' }), { app: 'claude', model: 'm-pa', context: compactContext() }, 'no_route_error', 503],
    // 唯一成员被停用:provider_disabled_error,不是含混的 no_route
    [compactRule({ provider: 'pa', model: 'm-pa' }), { app: 'claude', model: 'm-pa', context: compactContext() }, 'provider_disabled_error', 503],
    // chat 客户端撞上 responses-only 渠道:400
    [compactRule({ app: 'codex', provider: 'presp', model: 'm-presp' }),
      { app: 'codex', model: 'm-presp', kind: 'chat/completions', context: compactContext() }, 'wire_api_mismatch_error', 400],
  ]) {
    mod._state.store.claude[0].enabled = code !== 'provider_disabled_error';
    mod._state.routes = { rules: [target] };
    const r = await post(input);
    assert.equal(r.status, status, r.text);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, code);
    assert.equal(r.json.error.httpStatus, status);
    assert.deepEqual(r.json, mod.explainRoute(input));
    assert.ok(Array.isArray(r.json.warnings));
    assert.ok(r.json.matched);
    assert.ok(Number.isInteger(r.json.limits.rulesTraced));
    if (code === 'no_route_error') assert.ok(r.json.warnings.some(w => w.code === 'ghost_ref'));
  }
  assert.equal(upstreamHits, 0);
});

test('preview API 对多渠道登记同一模型明确 409,会话钉定可解歧义', async () => {
  mod._state.store.claude.push(provider('pa2', { models: ['m-pa'] }));
  const ambiguous = await post({ app: 'claude', model: 'm-pa' });
  assert.equal(ambiguous.status, 409, ambiguous.text);
  assert.equal(ambiguous.json.error.code, 'model_ambiguous_error');
  assert.deepEqual(ambiguous.json.candidates, []);
  assert.equal(ambiguous.json.selection, null);

  mod._state.sessions = new Map([['cc:pin-shared', { app: 'claude', providerId: 'pa2', model: 'm-pa',
    pinned: true, lastUsed: Date.now() }]]);
  const pinned = await post({ app: 'claude', model: 'm-pa', context: { session: 'cc:pin-shared' } });
  assert.equal(pinned.status, 200, pinned.text);
  assert.equal(pinned.json.selection.source, 'pinned');
  assert.equal(pinned.json.selection.predicted.providerId, 'pa2');
  assert.equal(upstreamHits, 0);
});

test('preview API 复用 JSON 对象验证与跨站闸门', async () => {
  for (const raw of ['not-json', '[]', 'null', '"a string"']) {
    const r = await post(raw);
    assert.equal(r.status, 400);
    assert.equal(typeof r.json.error, 'string');
  }
  for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://elsewhere.invalid' }]) {
    const r = await post({ app: 'claude', model: 'm-pa' }, headers);
    assert.equal(r.status, 403);
    assert.match(r.json.error, /跨站/);
  }
  assert.equal((await post({ app: 'claude', model: 'm-pa' }, { origin: `http://127.0.0.1:${server.address().port}` })).status, 200);
  const invalidApp = await post({ app: 'other', model: 'm-pa' });
  assert.equal(invalidApp.status, 400);
  assert.equal(invalidApp.json.error.code, 'bad_app');
  assert.ok(Array.isArray(invalidApp.json.warnings));
  assert.equal(upstreamHits, 0);
});

test('preview API 保留诊断字段,但凭据与请求正文不回显', async () => {
  const token = 'FAKE-CLIENT-TOKEN', bodyText = 'FAKE-REQUEST-TEXT';
  mod._state.routes = { rules: [compactRule({ provider: 'pa', pool: [
    { provider: 'pa', model: 'member-model', weight: 3, api_key: 'FAKE-POOL-SECRET' }, 'pb',
  ] })] };
  const r = await post({ app: 'claude', model: 'm-pa',
    context: compactContext({ token, bodyText, session: 'cc:hidden-full-key' }) });
  assert.equal(r.status, 200, r.text);
  for (const secret of [token, bodyText, 'FAKE-PROVIDER-SECRET', 'FAKE-KEY-SECRET', 'FAKE-POOL-SECRET', 'cc:hidden-full-key'])
    assert.equal(r.text.includes(secret), false);
  assert.equal(r.text.includes('base_url'), false);
  assert.equal(r.json.candidates[0].providerName, 'channel-pa');
  assert.equal(r.json.candidates[0].model, 'member-model');
  assert.equal(r.json.candidates[0].weight, 3);
  // when 出口只剩 body:token 之类的旧通用条件字段整条不出现,连 present/len 摘要都不再生成
  assert.deepEqual(r.json.matched.rule.when, { body: COMPACT_RULES[0].body });
  assert.deepEqual(r.json.matched.rule.pool[0], { provider: 'pa', model: 'member-model', weight: 3 });
  assert.equal(upstreamHits, 0);
});

test('会话覆盖预览使用相同槽位解析和固定 Key，过期配置保留且不改变状态', async () => {
  mod._state.slotMap = { claude: { opus: { provider: 'pa', model: 'global-model' } }, codex: {} };
  const routing = { keys: { outside: 'key' }, slots: { opus: { provider: 'outside', model: 'session-model' } } };
  mod._state.sessions = new Map([['cc:configured', { app: 'claude', lastUsed: 0, routing }]]);
  const before = JSON.stringify([...mod._state.sessions]);
  const r = await post({ app: 'claude', model: 'mixr-opus', context: { session: 'cc:configured' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.matched.via, 'slot');
  assert.equal(r.json.matched.slot, 'opus');
  assert.equal(r.json.matched.ruleId, 'slot:claude/opus');
  assert.equal(r.json.selection.predicted.providerId, 'outside');
  assert.equal(r.json.selection.predicted.model, 'session-model');
  assert.equal(r.json.selection.key_id, 'key');
  assert.equal(r.json.selection.key_pinned, true);
  assert.equal(r.text.includes('FAKE-KEY-SECRET'), false);
  assert.equal(JSON.stringify([...mod._state.sessions]), before);
  assert.equal(upstreamHits, 0);
});

test('会话固定 Key 失效时预览拒绝而非回退默认账号', async () => {
  mod._state.slotMap = { claude: { opus: { provider: 'pa', model: 'global-model' } }, codex: {} };
  mod._state.sessions = new Map([['cc:configured', { app: 'claude', lastUsed: Date.now(),
    routing: { keys: { pa: 'deleted' }, slots: {} } }]]);
  const r = await post({ app: 'claude', model: 'mixr-opus', context: { session: 'cc:configured' } });
  assert.equal(r.status, 503, r.text);
  assert.equal(r.json.error.code, 'provider_key_unavailable_error');
  assert.equal(upstreamHits, 0);
});

// ---------------------------------------------------------------------------
// 钉定 + kind:'chat/completions':钉定分支**不重跑** kind 过滤。
//
// 这是**照抄真实路径的忠实行为,不是预览缺陷**。2026-09-20 用独立探针(真实 proxyHandler + mock
// 上游)核过三种组合:钉定到池外 responses 渠道时,真实转发首发就命中该渠道——代理自己把
// chat 翻译成 responses 送上游(`/v1/responses`,model=钉定 model),客户端拿 200;预览给同一落点。
// 只有"命中成员全无 chat 协议"才在上游之前 400 `wire_api_mismatch_error`,两边同码、零上游命中。
// 当时的探针与日志属内部取证材料,不随仓库发布。
//
// ⚠ 改这一带之前先看 `lib/routing/explain.js` 的钉定分支:它只检查"本组渠道存在、启用且通过可用性预检",
//   拿到的 members 已经被 kind 过滤过,但钉定根本不用那份 members。谁把钉定分支"顺手修成"
//   再过滤一次 kind,谁就把预览改成了不忠实——这两个用例就是拿来挡这一手的。
const pinnedKindCase = (model, sessionKey) => {
  mod._state.store.codex = [provider('pchat', { wire_api: 'chat', model: 'm-pchat' }),
    provider('presp', { model: 'm-presp' }), provider('presp2', { model: 'm-presp2' })];
  mod._state.sessions = new Map([[sessionKey, { providerId: 'presp', model: 'resp-pinned-model',
    pinned: true, lastUsed: Date.now() }]]);
  return post({ app: 'codex', model, kind: 'chat/completions', context: { session: sessionKey } });
};

test('钉定到池外 responses 渠道时不被 chat 过滤挡住,候选池仍只列过滤后的池', async () => {
  // 命中的唯一登记模型在 chat 渠道上,kind 过滤后池里只剩它;钉定指向池外 responses 渠道。
  const r = await pinnedKindCase('m-pchat', 'cx:pinned-kind');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.selection.source, 'pinned');
  assert.equal(r.json.selection.predicted.providerId, 'presp');
  assert.equal(r.json.selection.predicted.model, 'resp-pinned-model', '沿用钉定时绑定的模型');
  assert.equal(r.json.selection.predicted.wire, 'responses');
  assert.equal(r.json.selection.deterministic, true);
  assert.deepEqual(r.json.selection.candidates, ['pchat'], '候选池是 kind 过滤后的池');
  assert.equal(r.json.selection.candidates.includes('presp'), false, '钉定可以选池外,候选池不因此变宽');
  assert.equal(r.json.limits.arrays['selection.candidates'].total, 1);
  assert.equal(upstreamHits, 0);
});

test('命中成员全无 chat 协议时在会话解析之前就 400,钉定救不了协议不匹配', async () => {
  const r = await pinnedKindCase('m-presp2', 'cx:pinned-mismatch');
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'wire_api_mismatch_error');
  assert.equal(r.json.error.httpStatus, 400);
  assert.ok(Array.isArray(r.json.warnings));
  assert.equal(r.json.selection, null, '报错早于选择,不该出现半截 selection');
  assert.equal(upstreamHits, 0);
});
