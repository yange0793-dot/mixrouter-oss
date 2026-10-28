'use strict';
// 主会话对照探针:预览先保持状态不动,再用同一快照跑真实 proxyHandler 核首选渠道。
// 所有配置与日志都在临时目录,HTTP 只连接本测试创建的动态回环端口。
//
// 瘦身后可选落点只有三条路:压缩内容规则 / 精确槽位(可带备池) / 唯一登记模型。
// 因此这里的"多成员 + 策略"夹具一律走**槽位备池**(default 池已删除),请求模型写 mixr-main;
// 只有单成员场景(唯一登记模型)才用具体模型名,压缩场景用真压缩指令并走 compactTexts。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');
const { testEnv } = require('../scripts/run-tests');
const { createMockUpstream } = require('./mock-upstream');
const { createExplainer, PREVIEW_LIMITS } = require('../lib/routing/explain');
const { createSessionStore } = require('../lib/routing/sessions');
const { slotAliases, stripContextSuffix } = require('../lib/routing/slots');
const { FIXED_PREFIX, COMPACT_RULES } = require('../lib/routing/compact-signature');

const SUMMARY = FIXED_PREFIX + 'Your task is to create a detailed summary of the conversation so far.';

function request(port, pathname, body, extraHeaders = {}, method = 'POST') {
  assert.ok(Number.isInteger(port) && port > 0 && ![8787, 8788].includes(port));
  const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, agent: false,
      headers: { ...(data === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }), ...extraHeaders },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('response aborted')));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(4000, () => req.destroy(new Error('test request timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

function fileSnapshot(root) {
  const rows = [];
  const visit = dir => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else rows.push({ file: path.relative(root, file), mode: stat.mode, size: stat.size,
        mtime: stat.mtimeMs, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    }
  };
  visit(root);
  return rows;
}

test('路由诊断:固定快照与真实转发的直接对照', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-diagnostics-evidence-'));
  const previousEnv = { ...process.env };
  const env = testEnv(process.env, tmp);
  for (const key of Object.keys(process.env)) if (/^(MIXR_|MIXROUTER_|MIXUI_)/.test(key)) delete process.env[key];
  Object.assign(process.env, env, { MIXR_SESSION_TTL_MIN: '1', MIXR_SESSION_MAX: '3',
    MIXR_SESSION_LABEL: '0' });
  for (const dir of ['home', 'data', 'data/logs', 'tmp']) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'data', 'sessions.json'), '{"version":1,"bindings":{}}\n');
  const mod = require('../mixrouter');
  const mock = createMockUpstream();
  const servers = [mock.server, http.createServer(mod.proxyHandler), http.createServer(mod.apiHandler)];
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await wait(1100); // 真实代理对照留下的 1s 去抖落盘结束后再清理目录。
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  for (const server of servers) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    assert.ok(![8787, 8788].includes(server.address().port));
  }
  const [mockPort, proxyPort, uiPort] = servers.map(server => server.address().port);
  const provider = (id, wire = 'anthropic') => ({ id, name: `Readable ${id}`, enabled: true,
    base_url: `http://127.0.0.1:${mockPort}`, api_key: `test-key:${id}`, wire_api: wire,
    model: `${id}-out`, models: [`${id}-out`], keys: [{ key: 'key-ring-only-sentinel' }],
    headers: { 'x-private': 'private-header-only-sentinel' } });
  const members = (...ids) => ids.map(id => ({ provider: id, model: `${id}-out` }));
  const binding = (providerId, extra = {}) => ({ providerId, model: '', lastUsed: Date.now(),
    created: Date.now(), pinned: false, label: 'private-label-only-sentinel', ...extra });
  // 压缩规则的身份来自 when.body(只认登记过的两条特征串)
  const compactRule = (o = {}) => ({ id: 'compact', match: '', app: '', enabled: true, priority: 90,
    when: { body: COMPACT_RULES[0].body }, provider: '', model: '', pool: [], strategy: 'priority', ...o });
  // slot=false:不绑槽位,只有"唯一登记模型"这一条路(单成员)。
  // 否则槽位 main 绑到 pool 首位并保留备池与策略 —— 这是瘦身后唯一还能配多成员的地方。
  const reset = ({ app = 'claude', strategy = 'priority', pool = members('a', 'b'), rules = [], slot = true } = {}) => {
    const group = ['a', 'b', 'c'].map(id => provider(id, app === 'codex' ? 'chat' : 'anthropic'));
    mod._state.store = { claude: app === 'claude' ? group : [], codex: app === 'codex' ? group : [] };
    mod._state.routes = { rules };
    mod._state.slotMap = slot
      ? { claude: app === 'claude' ? { main: { provider: pool[0].provider, model: pool[0].model, pool, strategy } } : {},
        codex: app === 'codex' ? { main: { provider: pool[0].provider, model: pool[0].model, pool, strategy } } : {} }
      : { claude: {}, codex: {} };
    mod._state.sessions = new Map();
    mod._state.cooldowns = {};
    mod._state.resetPools();
    mock.requests.length = 0;
  };
  const allProviders = () => [...mod._state.store.claude, ...mod._state.store.codex];
  const snapshot = () => structuredClone({ routes: mod._state.routes, store: mod._state.store,
    slots: mod._state.slotMap, sessions: [...mod._state.sessions], pools: mod._state.pools,
    cooldowns: mod._state.cooldowns });
  const explainer = options => createExplainer({
    getRoutes: () => mod._state.routes,
    storeOf: app => mod._state.store[app],
    resolveSlot: mod.resolveSlot,
    slotExists: (app, alias) => Object.keys(mod._state.slotMap[app] || {})
      .some(name => slotAliases(app, name).includes(stripContextSuffix(alias))),
    findProvider: id => allProviders().find(p => p.id === id) || null,
    providerApp: id => ['claude', 'codex'].find(app => mod._state.store[app].some(p => p.id === id)),
    listPools: () => mod._state.pools,
    // 装配处恒为 true:冷却已移除,渠道可用性只剩"启用/有可用 Key"
    healthEligible: () => true,
    sessionCounts: () => {
      const counts = {};
      for (const row of mod._state.sessions.values()) counts[row.providerId] = (counts[row.providerId] || 0) + 1;
      return counts;
    },
    sessionSnapshot: () => ({ bindings: mod._state.sessions, now: Date.now(), ttlMs: 60000, max: 3 }),
    ...options,
  });
  let caseNo = 0;
  async function compare({ expected, source = 'strategy', app = 'claude', model = 'mixr-main', kind,
    session = `${app === 'codex' ? 'cx' : 'cc'}:case-${++caseNo}`, text = 'hello', compact = false, options } = {}) {
    const sentText = compact ? SUMMARY : text;
    const input = { app, model, context: { session, bodyText: sentText,
      ...(compact ? { compactTexts: [SUMMARY] } : {}) }, ...(kind ? { kind } : {}) };
    const before = snapshot();
    const preview = explainer(options)(input);
    assert.deepEqual(snapshot(), before, '同步预览不得剪枝/触摸会话,或消耗游标与熔断许可');
    assert.equal(mock.requests.length, 0, '预览不发上游请求');
    const endpoint = app === 'claude' ? `/v1/${kind || 'messages'}` : `/v1/${kind || 'responses'}`;
    const body = app === 'claude' || kind === 'chat/completions'
      ? { model, max_tokens: 8, messages: [{ role: 'user', content: sentText }] }
      : { model, input: sentText };
    const header = app === 'claude' ? 'x-claude-code-session-id' : 'session-id';
    const actual = await request(proxyPort, endpoint, body, { [header]: session.slice(3) });
    assert.equal(actual.status, 200, actual.text);
    assert.equal(mock.requests.length, 1, '本用例是单次成功首选,不混入失败重试的落点');
    const sent = mock.requests[0];
    const key = sent.headers['x-api-key'] || String(sent.headers.authorization || '').replace(/^Bearer /, '');
    assert.equal(key, `test-key:${expected}`, '先核真实转发再核预览');
    assert.equal(preview.ok, true);
    assert.equal(preview.selection.predicted && preview.selection.predicted.providerId, expected);
    assert.equal(preview.selection.source, source);
    assert.equal(preview.selection.deterministic, true);
    assert.equal(preview.selection.predicted.model, sent.body.model);
    return preview;
  }

  // 先做异步 API 只读核验:尚未执行任何真实转发,没有之前请求留下的延迟落盘定时器。
  await t.test('POST API 只解释当前快照,不写文件/日志/状态也不泄露输入和凭据', async () => {
    reset({ slot: false, rules: [compactRule({ id: 'content', provider: 'a', model: 'a-out',
      pool: members('a') })] });
    mod._state.sessions.set('cc:expired', binding('b', { lastUsed: Date.now() - 120000 }));
    mod._state.cooldowns = { expired: Date.now() - 1000, b: Date.now() + 600000 };
    mod._state.pools['sentinel:keep'] = 7;
    const input = { app: 'claude', model: 'demo', context: { session: 'cc:request-session-only-sentinel',
      ua: 'request-ua-only-sentinel', token: 'token-needle request-token-only-sentinel',
      bodyText: 'route-needle request-body-only-sentinel', compactTexts: [SUMMARY] } };
    const memoryBefore = snapshot(), filesBefore = fileSnapshot(tmp);
    const logsBefore = await request(uiPort, '/api/logs', undefined, {}, 'GET');
    const response = await request(uiPort, '/api/routing/preview', input);
    const logsAfter = await request(uiPort, '/api/logs', undefined, {}, 'GET');
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.matched.via, 'compact');
    assert.equal(response.json.selection.predicted.providerId, 'a');
    assert.equal(response.json.selection.predicted.providerName, 'Readable a');
    assert.equal(response.json.selection.predicted.model, 'a-out');
    assert.equal(response.json.matched.ruleId, 'content');
    await wait(1100); // 不只检查同步写盘:saveSoon 的延迟写也必须能被抓到。
    assert.deepEqual(snapshot(), memoryBefore);
    assert.deepEqual(fileSnapshot(tmp), filesBefore);
    assert.equal(logsAfter.text, logsBefore.text);
    assert.equal(mock.requests.length, 0);
    for (const secret of ['request-session-only-sentinel', 'request-ua-only-sentinel', 'request-token-only-sentinel',
      'request-body-only-sentinel', 'private-label-only-sentinel', 'test-key:', 'key-ring-only-sentinel',
      'private-header-only-sentinel', `127.0.0.1:${mockPort}`]) assert.ok(!response.text.includes(secret), secret);
    assert.equal(response.json.input.context.hasToken, true);
    assert.equal(response.json.input.context.hasBodyText, true);
    // when 出口只剩 body:token 之类的旧通用条件字段与它们的 present/len 摘要一起删除
    assert.deepEqual(response.json.matched.rule.when, { body: COMPACT_RULES[0].body });
    assert.equal(response.json.matched.rule.when.token, undefined);
  });

  await t.test('API 校验与跨站闸门不变,失败结果保留结构化错误', async () => {
    reset({ slot: false });
    const missing = await request(uiPort, '/api/routing/preview', { app: 'claude', model: 'demo' });
    assert.equal(missing.status, 503);
    assert.equal(missing.json.error.code, 'no_route_error');
    assert.ok(missing.json.limits);
    assert.ok(Array.isArray(missing.json.warnings));
    for (const body of ['[1]', 'not json', { app: 'wrong' }, { app: 'claude', model: 1 }]) {
      assert.equal((await request(uiPort, '/api/routing/preview', body)).status, 400);
    }
    const crossSite = await request(uiPort, '/api/routing/preview', { app: 'claude' }, { Origin: 'https://other.invalid' });
    assert.equal(crossSite.status, 403);
    assert.equal(mock.requests.length, 0);
  });

  await t.test('槽位轮询读取槽位规则游标,不是下划线游标', async () => {
    reset({ strategy: 'round_robin' });
    mod._state.pools['slot:claude/main'] = 1;
    mod._state.pools._ = 0;
    await compare({ expected: 'b' });
  });
  await t.test('槽位主备不受轮询游标影响', async () => {
    reset();
    mod._state.pools['slot:claude/main'] = 1;
    mod._state.pools._ = 1;
    await compare({ expected: 'a' });
  });
  await t.test('槽位加权使用 __w_<槽位规则> 当前余量,预览不消耗它', async () => {
    reset({ strategy: 'weighted', pool: members('a', 'b') });
    mod._state.pools._ = 1;
    mod._state.pools['__w_slot:claude/main'] = mod._state.store.claude.slice(0, 2)
      .map((p, i) => ({ provider: p, model: `${p.id}-out`, weight: 1, current: i ? -3 : 3 }));
    await compare({ expected: 'a' });
  });
  await t.test('槽位 least_used 使用活跃会话数', async () => {
    reset({ strategy: 'least_used' });
    mod._state.sessions = new Map([['cc:a1', binding('a')], ['cc:a2', binding('a')], ['cc:b1', binding('b')]]);
    await compare({ expected: 'b' });
  });
  await t.test('compact 不重跑策略,首成员冷却时仍与转发首选一致', async () => {
    reset({ slot: false, rules: [compactRule({ id: 'content', provider: 'a', strategy: 'priority',
      pool: members('a', 'b') })] });
    mod._state.cooldowns.a = Date.now() + 600000;
    await compare({ expected: 'a', source: 'compact', compact: true });
  });
  await t.test('compact 的 random 配置也有确定首选', async () => {
    reset({ slot: false, rules: [compactRule({ id: 'content', provider: 'a', strategy: 'random',
      pool: members('a', 'b') })] });
    await compare({ expected: 'a', source: 'compact', compact: true });
  });
  await t.test('已有粘性绑定仍在候选里时复用,不在候选里则重新落点', async () => {
    // 唯一登记模型的候选恒为 1,所以这里核的是两条：绑定命中时给 sticky,
    // 绑定落在候选外时按策略落点并重绑(不让过期/串组的绑定把请求带走)。
    reset({ slot: false });
    mod._state.sessions.set('cc:sticky', binding('a'));
    await compare({ expected: 'a', source: 'sticky', session: 'cc:sticky', model: 'a-out' });
    mock.requests.length = 0; // 第二次对照前清掉上一条真实转发的记录
    mod._state.sessions.set('cc:rebound', binding('b'));
    await compare({ expected: 'a', source: 'strategy', session: 'cc:rebound', model: 'a-out' });
    assert.equal(mod._state.sessions.get('cc:rebound').providerId, 'a', '候选外的绑定应被改成真实落点');
  });
  await t.test('手动钉定可以选候选外渠道并保持绑定模型', async () => {
    reset({ slot: false });
    mod._state.sessions.set('cc:pinned', binding('b', { pinned: true, model: 'pinned-model' }));
    const result = await compare({ expected: 'b', source: 'pinned', session: 'cc:pinned', model: 'a-out' });
    assert.equal(result.selection.predicted.model, 'pinned-model');
  });
  await t.test('钉定渠道停用后不再强行预测它', async () => {
    reset({ slot: false });
    mod._state.store.claude[1].enabled = false;
    mod._state.sessions.set('cc:disabled', binding('b', { pinned: true }));
    await compare({ expected: 'a', session: 'cc:disabled', model: 'a-out' });
  });
  await t.test('旧冷却表不影响渠道钉定', async () => {
    reset({ slot: false });
    mod._state.cooldowns.b = Date.now() + 600000;
    mod._state.sessions.set('cc:cooldown', binding('b', { pinned: true, model: 'pinned-model' }));
    await compare({ expected: 'b', source: 'pinned', session: 'cc:cooldown', model: 'a-out' });
  });
  await t.test('槽位请求不被会话钉定劫持', async () => {
    reset();
    mod._state.sessions.set('cc:slot', binding('b', { pinned: true }));
    await compare({ expected: 'a', session: 'cc:slot' });
  });
  await t.test('槽位备池不复用池内对话粘性,预测与真实转发都按槽位策略', async () => {
    for (const pinned of [false, true]) {
      reset({ pool: members('a', 'b'), strategy: 'priority' });
      mod._state.sessions.set('cc:slot-pool', binding('b', { pinned }));
      await compare({ expected: 'a', source: 'strategy', session: 'cc:slot-pool' });
      assert.equal(mod._state.sessions.get('cc:slot-pool').providerId, 'b', '槽位请求不重绑对话');
    }
  });
  await t.test('compact 请求不被会话钉定劫持', async () => {
    reset({ slot: false, rules: [compactRule({ id: 'content', provider: 'a', strategy: 'priority',
      pool: members('a', 'b') })] });
    mod._state.sessions.set('cc:content-pin', binding('b', { pinned: true }));
    await compare({ expected: 'a', source: 'compact', session: 'cc:content-pin', compact: true });
  });
  await t.test('已过 TTL 的**自动**绑定不会被当作粘性,原表在预览后保留', async () => {
    reset({ slot: false });
    mod._state.sessions.set('cc:expired', binding('a', { lastUsed: Date.now() - 120000 }));
    // 绑定指向的正是候选渠道:不剪枝就会给 sticky,剪了才是 strategy
    await compare({ expected: 'a', source: 'strategy', session: 'cc:expired', model: 'a-out' });
  });
  await t.test('已过 TTL 的**手动钉定**不再被 TTL 回收,预览与实跑都继续粘它', async () => {
    // 手动配置(钉定/Key 槽位覆盖)不是自动记录:闲置再久也不能被静默丢掉。
    // 预览侧与实跑侧共用 session-config 的 explicitConfig,两处口径必须一致。
    reset({ slot: false });
    mod._state.sessions.set('cc:pinned-stale', binding('b', { pinned: true, model: 'b-out', lastUsed: Date.now() - 120000 }));
    await compare({ expected: 'b', source: 'pinned', session: 'cc:pinned-stale', model: 'a-out' });
  });
  await t.test('least_used 计数先在快照里应用 TTL', async () => {
    reset({ strategy: 'least_used', pool: members('b', 'a') });
    mod._state.sessions = new Map([
      ['cc:old-a1', binding('a', { lastUsed: Date.now() - 120000 })],
      ['cc:old-a2', binding('a', { lastUsed: Date.now() - 120000 })], ['cc:live-b', binding('b')],
    ]);
    await compare({ expected: 'a' });
  });
  await t.test('least_used 计数应用 MAX,淘汰最早 lastUsed', async () => {
    reset({ strategy: 'least_used', pool: members('b', 'a') });
    const now = Date.now();
    mod._state.sessions = new Map([
      ['cc:old-a', binding('a', { lastUsed: now - 4000 })], ['cc:new-b', binding('b', { lastUsed: now - 2000 })],
      ['cc:new-a', binding('a', { lastUsed: now - 1000 })], ['cc:new-b2', binding('b', { lastUsed: now })],
    ]);
    await compare({ expected: 'a' });
  });
  await t.test('MAX 的同时间戳淘汰按 Map 插入顺序,不按 key 排序', async () => {
    reset({ strategy: 'least_used', pool: members('b', 'a') });
    const lastUsed = Date.now() - 1000;
    mod._state.sessions = new Map([
      ['cc:z-first', binding('a', { lastUsed })], ['cc:a-second', binding('b', { lastUsed })],
      ['cc:m-third', binding('a', { lastUsed })], ['cc:n-fourth', binding('b', { lastUsed })],
    ]);
    await compare({ expected: 'a' });
  });
  await t.test('TTL 正好等于边界仍有效,用同一冻结时刻核真实 SessionStore', async () => {
    reset({ slot: false });
    const now = 200000, bound = binding('a', { lastUsed: now - 60000 });
    mod._state.sessions = new Map([['cc:boundary', bound]]);
    const before = snapshot();
    // 绑定指向候选渠道:边界上被误剪就会退回 strategy,source 直接露馅
    const result = explainer({ sessionSnapshot: () => ({ bindings: mod._state.sessions, now, ttlMs: 60000, max: 3 }) })
      ({ app: 'claude', model: 'a-out', context: { session: 'cc:boundary' } });
    assert.deepEqual(snapshot(), before);
    assert.equal(result.selection.source, 'sticky');
    assert.equal(result.selection.predicted.providerId, 'a');
    const actualStore = createSessionStore({ sessionsFile: 'unused', ttlMs: 60000, max: 3, now: () => now,
      loadJson: () => null, saveJson: () => assert.fail('resolveTarget 不应落盘'),
      storeOf: () => mod._state.store.claude, providerEligible: () => true });
    actualStore.sessions = structuredClone(mod._state.sessions);
    const resolved = mod.resolveRoute('a-out', {}, 'claude');
    const actual = actualStore.resolveTarget(null, resolved.members, 'cc:boundary', '', 'header', 'claude', resolved.strategy);
    assert.equal(actual.member.provider.id, 'a');
    assert.equal(actual.sticky, true, '边界上仍算已有粘性,不得剪枝');
    assert.equal(actualStore.sessions.has('cc:boundary'), true, '正好等于 TTL 的自动绑定不能被回收');
  });
  await t.test('random 仅一个可用成员时有确定首选', async () => {
    reset({ strategy: 'random' });
    mod._state.store.claude[0].enabled = false;
    await compare({ expected: 'b' });
  });
  await t.test('random 多候选不抽签,也不把首成员说成预测', () => {
    reset({ strategy: 'random' });
    const random = Math.random, before = snapshot();
    let result, randomCalls = 0;
    try {
      Math.random = () => { randomCalls++; throw new Error('预览不得消费 RNG'); };
      result = explainer()({ app: 'claude', model: 'mixr-main' });
    } finally { Math.random = random; }
    assert.equal(randomCalls, 0, '异常即使被预览吞掉,也不能掩盖 RNG 调用');
    assert.deepEqual(snapshot(), before);
    assert.equal(result.ok, true);
    assert.equal(result.selection.predicted, null);
    assert.equal(result.selection.deterministic, false);
    assert.deepEqual(result.selection.candidates, ['a', 'b']);
    assert.equal(result.selection.source, 'strategy');
  });
  await t.test('compact 先按 chat 协议筛选,再取筛选后首成员', async () => {
    reset({ slot: false, app: 'codex', rules: [compactRule({ id: 'content', app: 'codex', strategy: 'random',
      pool: members('a', 'b', 'c') })] });
    mod._state.store.codex[0].wire_api = 'responses';
    await compare({ expected: 'b', source: 'compact', app: 'codex', kind: 'chat/completions', compact: true });
  });
  for (const error of ['no_route_error', 'provider_disabled_error', 'wire_api_mismatch_error']) {
    await t.test(`${error} 同样保留精确截断计数与提醒`, () => {
      // 9 条停用的压缩规则各产生 1 条 skip 事件 → 计数有确定的来源。
      const rules = Array.from({ length: 9 }, (_, i) => compactRule({ id: `off-${i}`, enabled: false }));
      const app = error === 'wire_api_mismatch_error' ? 'codex' : 'claude';
      // provider_disabled 只能由精确槽位到达(停用渠道已不参与唯一登记模型)
      reset(error === 'provider_disabled_error'
        ? { app, rules, slot: true, pool: members('a') }
        : { app, rules, slot: false });
      if (error === 'provider_disabled_error') mod._state.store.claude[0].enabled = false;
      if (app === 'codex') mod._state.store.codex[0].wire_api = 'responses';
      // 槽位命中不再评模型阶段 → 事件数比另外两种少 1(9+1 vs 9+1+1)
      const total = error === 'provider_disabled_error' ? 10 : 11;
      const result = explainer({ limits: { maxTraceEvents: 2 } })
        ({ app, model: app === 'codex' ? 'a-out' : (error === 'provider_disabled_error' ? 'mixr-main' : 'demo'),
          ...(app === 'codex' ? { kind: 'chat/completions' } : {}) });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, error);
      assert.equal(result.limits.rulesTraced, 2);
      assert.equal(result.limits.rulesOmitted, total - 2);
      assert.equal(result.limits.truncated, true);
      assert.ok(result.warnings.some(w => w.code === 'rules_truncated'));
    });
  }
  await t.test('候选/有效成员/匹配池/ghost/kindFilter 都遵守展示上限', () => {
    reset({ slot: false, app: 'codex' });
    mod._state.store.codex = Array.from({ length: 120 }, (_, i) => provider(`p${i}`, i % 2 ? 'chat' : 'responses'));
    const pool = [...mod._state.store.codex.map(p => ({ provider: p.id, model: p.model })),
      ...Array.from({ length: 80 }, (_, i) => ({ provider: `missing-${i}` }))];
    mod._state.routes = { rules: [compactRule({ id: 'many', app: 'codex', pool })] };
    const result = explainer()({ app: 'codex', model: 'demo', kind: 'chat/completions',
      context: { compactTexts: [SUMMARY] } });
    assert.equal(result.ok, true);
    assert.equal(result.matched.via, 'compact');
    for (const items of [result.candidates, result.effective, result.selection.candidates,
      result.matched.rule.pool, result.ghosts, result.kindFilter.kept, result.kindFilter.dropped]) {
      assert.ok(items.length > 0, '不能用全空输出冒充安全');
      assert.ok(items.length <= PREVIEW_LIMITS.maxCandidates);
    }
    assert.ok(result.warnings.some(w => w.code.includes('truncated')));
  });
});
