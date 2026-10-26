'use strict';
// P3 多 Key 自动备用在**真代理链路**上的行为:换号只发生在该发生的地方。
//
// 这个文件不测 key-fallback 模块自己的状态机(那是 test/key-fallback.test.js),它测的是
// lib/proxy/attempt.js 的接线 —— 那种"模块全绿、接上去一处没生效"的假绿只有这里能拦住:
//   · 401/402 换号,403/404/429 只记模型级;网络错误与 5xx **不**换号;
//   · 未开启 key_fallback 的渠道原样不换;钉死的 Key 永不换;
//   · 换号重试打的是同一个渠道,**不扩大预算**(受 maxUpstreamCalls 约束);
//   · 只改这一次请求的副本,绝不写回渠道的 active_key。
//
// 隔离:Key 失败诊断记录按 **provider + key_id** 记在进程内存里,所以每个用例用**自己的一对
// Key**(k 池里按用例分组),互不影响;切换 primary 走控制台的 active_key 接口,与用户
// 手动在卡片上选账号是同一条路径。改 providers.json 是没用的 —— 渠道库在 require 时就
// 进了内存。
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-keyfb-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_RETRY_DELAY_MS = '0';   // 验的是换号决策,不是退避时长
process.env.MIXR_MAX_ATTEMPTS = '2';     // 预算上界 = 2 + CONV_RETRIES

// 每个用例**一个渠道、两把 Key**。这不是为了好写:自动备用是在**同一渠道的 Key 清单**里
// 挑下一把,把多组 Key 塞进同一个渠道,它就会跨组挑(那是对的行为,只是测不出各自的规则)。
// 渠道名与模型名一一对应,看日志一看就知道是哪个用例。
const MODELS = ['m-401', 'm-403', 'm-404', 'm-429', 'm-500', 'm-ok'];
const PAIRS = {
  swap401: ['sk-A-swap401', 'sk-B-swap401'],
  model403: ['sk-A-model403', 'sk-B-model403'],
  rate429: ['sk-A-rate429', 'sk-B-rate429'],
  server500: ['sk-A-server500', 'sk-B-server500'],
  budget: ['sk-A-budget', 'sk-B-budget'],
  off: ['sk-A-off', 'sk-B-off'],
  pinned: ['sk-A-pinned', 'sk-B-pinned'],
};
const ALL_KEYS = Object.entries(PAIRS).flatMap(([group, [a, b]]) => [
  { id: `${group}-a`, label: `${group} 账号1`, key: a },
  { id: `${group}-b`, label: `${group} 账号2`, key: b },
]);
const providerIdOf = group => `p-${group}`;
const keysOf = group => [0, 1].map((i, idx) => ({
  id: `${group}-${idx === 0 ? 'a' : 'b'}`,
  label: `${group} 账号${idx + 1}`,
  key: PAIRS[group][idx],
}));

// key → 状态码。表里没有的 key 回 200。
const perKey = new Map();
const seen = [];
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const key = String(req.headers['x-api-key'] || '');
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
    seen.push({ key, model: body.model, at: Date.now() });
    const status = perKey.get(key) || 200;
    if (status >= 400) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'x', message: 'mock failure' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 2 } }));
  });
});

let mod, proxySrv, uiSrv, proxyPort, uiPort, mockPort;

const raw = (port, method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request({ hostname: '127.0.0.1', port, method, path: p,
    headers: { host: `127.0.0.1:${port}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } },
    res => { const cs = []; res.on('data', c => cs.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(cs).toString('utf8') })); });
  r.on('error', reject);
  if (data) r.write(data);
  r.end();
});
const ui = (m, p, body) => raw(uiPort, m, p, body);
// session 参数必须真的改变**会话身份**:客户端没带官方会话头时,身份是请求内容的指纹,
// 两条一模一样的 prompt 会被算成同一个对话 —— 那样上一条用例的粘性账号会漏到下一条里,
// 测出来的是"全都在用第一对 Key",而不是各自的规则。所以把 session 名写进正文。
// 会话身份用**官方头**(x-claude-code-session-id),不是内容指纹:指纹身份是"低可信"的,
// 产品明确不允许它新建会话级 Key 覆盖(会把不同对话并成一条)。这与真实客户端一致。
const ask = (model, session) => raw(proxyPort, 'POST', '/v1/messages',
  { model, max_tokens: 8, messages: [{ role: 'user', content: `hi ${session || ''}` }] },
  session ? { 'x-claude-code-session-id': session } : {});
const logs = async qs => JSON.parse((await ui('GET', '/api/logs' + (qs || '?limit=50'))).text).logs;

// 切主用账号 / 开关自动备用 —— 与用户在控制台点的是同一条写入路径。
async function useKey(group, which = 'a', fallback = true) {
  const r = await ui('PUT', `/api/providers/${providerIdOf(group)}`,
    { active_key: `${group}-${which}`, enabled: true, key_fallback: !!fallback });
  assert.strictEqual(r.status, 200, `配置渠道失败: ${r.text}`);
}

test('setup:mock 上游 + 两个服务 + 一个多账号渠道', async () => {
  await new Promise(ok => mock.listen(0, '127.0.0.1', ok));
  mockPort = mock.address().port;
  mock.unref();
  fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({
    version: 2, current: { claude: null, codex: null },
    claude: Object.keys(PAIRS).map(group => ({
      id: providerIdOf(group), name: `${group} 渠道`,
      base_url: `http://127.0.0.1:${mockPort}`,
      enabled: true, key_fallback: true, active_key: `${group}-a`,
      keys: keysOf(group), models: MODELS,
    })),
    codex: [],
  }));
  // 路由:模型名 → 同名渠道(每个用例的模型只落到自己的渠道)
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({
    rules: Object.keys(PAIRS).flatMap(group => MODELS.map(m => ({
      id: `r-${group}-${m}`, match: `${m}-${group}`, provider: providerIdOf(group), model: m, enabled: true,
    }))),
    default: { provider: '', model: '' },
  }));
  // 钉死的账号走**槽位** key_id:一条稳定的产品路径,验"钉死就不换"。
  fs.writeFileSync(path.join(TMP, 'slots.json'), JSON.stringify({
    // 槽位名只能用 CLAUDE_SLOTS 里的那几个(opus/sonnet/haiku/subagent/main),
    // 客户端请求的是别名 mixr-opus。
    version: 1, claude: { opus: { provider: providerIdOf('pinned'), model: 'm-401', key_id: 'pinned-a' } }, codex: {},
  }));
  mod = require('../mixrouter.js');
  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  proxySrv.unref(); uiSrv.unref();
});

test('401 换号:同一渠道换到健康账号并成功,active_key 不被改写', async () => {
  await useKey('swap401');
  perKey.clear(); seen.length = 0;
  perKey.set(PAIRS.swap401[0], 401);
  const r = await ask('m-401-swap401', 'session-swap401');
  assert.strictEqual(r.status, 200, '第二个账号应当接过这次请求');
  assert.deepStrictEqual(seen.map(s => s.key), PAIRS.swap401, '应当先试账号1、再换账号2 重打同一渠道');
  const entry = (await logs('?limit=1'))[0];
  assert.strictEqual(entry.status, 200);
  assert.strictEqual(entry.key_id, 'swap401-b');
  assert.strictEqual(entry.key_source, 'key_fallback', '日志要能看出这次换了号');
  assert.strictEqual(entry.attempts, 2, '两次上游调用都计入真实调用数');

  const provider = JSON.parse((await ui('GET', '/api/state')).text).providers.claude.find(p => p.id === providerIdOf('swap401'));
  assert.strictEqual(provider.active_key, 'swap401-a', '换号只影响这一条请求,不得改写渠道当前生效 Key');

  const health = JSON.parse((await ui('GET', '/api/keys/health')).text).keys;
  const failed = health.find(k => k.key_id === 'swap401-a');
  assert.ok(failed, '账号1 应当留下失败诊断记录');
  assert.strictEqual(failed.scope, 'account', '401 是账号级归因');
  const body = JSON.stringify(health);
  for (const [, [a, b]] of Object.entries(PAIRS)) {
    assert.ok(!body.includes(a) && !body.includes(b), '/api/keys/health 不得含 Key 正文');
  }
});

test('403 / 404 只记模型级:同一账号换其它模型仍可用', async () => {
  await useKey('model403');
  perKey.clear(); seen.length = 0;
  perKey.set(PAIRS.model403[0], 403);
  const denied = await ask('m-403-model403', 'session-model403');
  assert.strictEqual(denied.status, 200);
  assert.deepStrictEqual(seen.map(s => s.key), PAIRS.model403, '403 应当换号');

  const health = JSON.parse((await ui('GET', '/api/keys/health')).text).keys;
  const rec = health.find(k => k.key_id === 'model403-a' && k.status === 403);
  assert.ok(rec, '403 要被记下来');
  assert.strictEqual(rec.scope, 'model', '403 不能判成"账号全坏"');
  assert.strictEqual(rec.model, 'm-403');

  // 同一账号的另一个模型仍会回到账号1 —— 这就是"模型级"的可观测差异
  perKey.clear(); seen.length = 0;
  const other = await ask('m-ok-model403', 'session-model403b');
  assert.strictEqual(other.status, 200);
  assert.deepStrictEqual(seen.map(s => s.key), [PAIRS.model403[0]], '模型级失败不得波及同账号其它模型');
});

test('404 同样只记模型级', async () => {
  await useKey('model403', 'a');
  perKey.clear(); seen.length = 0;
  perKey.set(PAIRS.model403[0], 404);
  const r = await ask('m-404-model403', 'session-404');
  assert.strictEqual(r.status, 200, '404 也该换号(账号不一定坏,是模型没权限/不存在)');
  assert.deepStrictEqual(seen.map(s => s.key), PAIRS.model403);
  const rec = JSON.parse((await ui('GET', '/api/keys/health')).text).keys
    .find(k => k.key_id === 'model403-a' && k.status === 404);
  assert.ok(rec && rec.scope === 'model');
});

test('429 换号;不按 Retry-After 等待', async () => {
  await useKey('rate429');
  perKey.clear(); seen.length = 0;
  perKey.set(PAIRS.rate429[0], 429);
  const started = Date.now();
  const r = await ask('m-429-rate429', 'session-429');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(seen.map(s => s.key), PAIRS.rate429);
  // 冷却与 Retry-After 等待都已移除:换号应当立即发生
  assert.ok(Date.now() - started < 5000, `换号不该等待冷却窗口(实际 ${Date.now() - started}ms)`);
});

test('网络错误与 5xx 不轮换 Key:账号没坏,也不禁用渠道', async () => {
  await useKey('server500');
  perKey.clear(); seen.length = 0;
  perKey.set(PAIRS.server500[0], 500);
  perKey.set(PAIRS.server500[1], 500);
  const r = await ask('m-500-server500', 'session-500');
  assert.ok(r.status >= 500, '两次都 500 时应当如实失败');
  assert.deepStrictEqual(seen.map(s => s.key), [PAIRS.server500[0], PAIRS.server500[0]], '5xx 不得触发换号');
  const health = JSON.parse((await ui('GET', '/api/keys/health')).text).keys;
  assert.deepStrictEqual(health.filter(k => String(k.key_id).startsWith('server500')), [], '5xx 不记 Key 状态');
});

test('预算不因换号扩大:两把号都被拒时在 maxUpstreamCalls 处停下', async () => {
  await useKey('budget');
  perKey.clear(); seen.length = 0;
  perKey.set(PAIRS.budget[0], 401);
  perKey.set(PAIRS.budget[1], 401);
  const started = Date.now();
  const r = await ask('m-401-budget', 'session-budget');
  assert.strictEqual(r.status, 401, '没有可用账号时应当把上游的 401 交给客户端');
  assert.strictEqual(seen.length, 2, `上游调用数不得超过预算(MIXR_MAX_ATTEMPTS=2),实际 ${seen.length}`);
  assert.deepStrictEqual(seen.map(s => s.key), PAIRS.budget, '两次分别试了两把号,没有第三发');
  assert.ok(Date.now() - started < 5000, '全部 Key 失败时不得原地等待');
  const entry = (await logs('?limit=1'))[0];
  assert.strictEqual(entry.attempts, 2);
  assert.strictEqual(entry.status, 401);
});

test('失败不跨请求保留:上一条请求两把号都被拒,下一条仍立刻用同一把号', async () => {
  await useKey('budget');
  perKey.clear(); seen.length = 0;
  perKey.set(PAIRS.budget[0], 401);
  perKey.set(PAIRS.budget[1], 401);
  const failed = await ask('m-401-budget', 'session-budget-reset');
  assert.strictEqual(failed.status, 401, '两把号都被拒时如实失败');

  // 上游修好账号 1:新请求必须立刻打到它,不需要等任何恢复窗口。
  perKey.clear(); seen.length = 0;
  const started = Date.now();
  const next = await ask('m-401-budget', 'session-budget-reset-2');
  assert.strictEqual(next.status, 200, '新请求不该被上一条请求的失败挡住');
  assert.deepStrictEqual(seen.map(s => s.key), [PAIRS.budget[0]], '仍从渠道当前生效账号开始,一次成功');
  assert.ok(Date.now() - started < 5000, '新请求不该等冷却窗口');

  // 诊断记录不参与选号:它仍留着上一条请求的失败事实,但不会改变这次落点。
  const health = JSON.parse((await ui('GET', '/api/keys/health')).text).keys
    .filter(k => String(k.key_id).startsWith('budget'));
  for (const row of health) {
    assert.strictEqual(row.until, 0, '失败记录不得带截止时间');
    assert.strictEqual(row.state, 'failed', '记录只表示"最近失败"');
  }
});

test('未开启 key_fallback:行为逐字不变(401 一次都不重试)', async () => {
  await useKey('off', 'a', false);
  perKey.clear(); seen.length = 0;
  perKey.set(PAIRS.off[0], 401);
  const r = await ask('m-401-off', 'session-off');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(seen.length, 1, '没开自动备用就一次都不该重试');
  const health = JSON.parse((await ui('GET', '/api/keys/health')).text).keys;
  assert.deepStrictEqual(health.filter(k => String(k.key_id).startsWith('off')), [], '关闭时模块不记录任何状态');
  await useKey('off', 'a', true);   // 还原开关
});

test('钉死的 Key 不换号:会话点名 pinned-a 时即使 401 也不自动切换', async () => {
  await useKey('pinned');
  perKey.clear(); seen.length = 0;
  // ① 先发一次**成功**的请求,让这条会话出现在会话表里(会话键是按内容算的,
  //    所以后面用同一段 prompt 就还是同一条会话)。
  assert.strictEqual((await ask('m-ok-pinned', 'session-pinned')).status, 200);
  const sessions = JSON.parse((await ui('GET', '/api/sessions')).text).sessions;
  const mine = sessions.find(x => String(x.key || '').length);
  assert.ok(mine, '先要有一条会话记录,才能给它配 Key');

  // ② 把这条会话的 Key 钉到 pinned-a(与「会话」页保存 Key 是同一条写入路径)
  // 写入是乐观锁:先读当前 revision,再带着它保存(与控制台保存同一套语义)。
  const current = JSON.parse((await ui('GET', `/api/sessions/${encodeURIComponent(mine.key)}/routing`)).text);
  const put = await ui('PUT', `/api/sessions/${encodeURIComponent(mine.key)}/routing`,
    { routing: { keys: { [providerIdOf('pinned')]: 'pinned-a' } }, expected_revision: current.revision });
  assert.strictEqual(put.status, 200, `钉定会话 Key 失败: ${put.text}`);

  // ③ 现在让 pinned-a 401:钉死就必须如实失败,不静默换成 pinned-b
  perKey.clear(); seen.length = 0;
  perKey.set(PAIRS.pinned[0], 401);
  const r = await ask('m-401-pinned', 'session-pinned');
  assert.strictEqual(r.status, 401, `钉定的账号失败就失败,不静默换号(实际 ${r.status}: ${r.text.slice(0, 160)})`);
  assert.deepStrictEqual(seen.map(s => s.key), [PAIRS.pinned[0]], '钉定账号不得被换掉');
});

test('粘性按完整会话键:一条会话换到的账号不会漏给另一条会话', async () => {
  await useKey('server500');
  perKey.clear(); seen.length = 0;
  // 用**模型级**失败:账号1 只在 m-403 上留下失败记录,换到账号2 并把这条会话粘住。
  // 账号级(401)失败会让"另一条会话也用账号2"变成必然,那样就分不清是粘性漏了还是账号被跳过。
  perKey.set(PAIRS.server500[0], 403);
  assert.strictEqual((await ask('m-403-server500', 'sess-shared-aaaa-0001')).status, 200);
  assert.deepStrictEqual(seen.map(s => s.key), PAIRS.server500);

  // 会话二、**另一个模型**(账号1 在这个模型上没有失败记录):它应当从渠道当前生效账号开始。
  // 两条会话 id 的**前 8 个字符完全相同**(日志用的短键 sessionKeyOf 只取前 8 位):
  // 若粘性表按短键存,这两条会话就会互相看到对方的换号结果 —— 这正是本用例要拦的。
  perKey.clear(); seen.length = 0;
  const second = await ask('m-ok-server500', 'sess-shared-bbbb-0002');
  assert.strictEqual(second.status, 200);
  assert.deepStrictEqual(seen.map(s => s.key), [PAIRS.server500[0]],
    '另一条会话不应继承上一条会话换号的结果');

  // 会话一再来一次同一个模型:它的粘性已经前移到账号2 → 直接用账号2,
  // 不必先撞一次 401/403。
  perKey.clear(); seen.length = 0;
  assert.strictEqual((await ask('m-403-server500', 'sess-shared-aaaa-0001')).status, 200);
  assert.deepStrictEqual(seen.map(s => s.key), [PAIRS.server500[1]], '同一条会话应继续用上次成功的账号');
});

test('cleanup', () => {
  try { proxySrv && proxySrv.close(); } catch {}
  try { uiSrv && uiSrv.close(); } catch {}
  try { mock.close(); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
});
