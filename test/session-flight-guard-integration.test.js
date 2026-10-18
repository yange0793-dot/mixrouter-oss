'use strict';
// 第二期:**需要代理装配接线**的集成验收(在途请求 guard 的真实入口部分)。
//
// 本文件验证第二期 5.2.4 要防的那件事——上游回得慢、控制台先动手(手动重绑 / 保存覆盖)时,
// 先前那条在途请求的响应不能覆盖新绑定或新配置。
// 接线已由主会话完成(在 `lib/proxy/prepare.js` 捕获令牌、`lib/proxy/attempt.js` 结算落点、
// `mixrouter.js` 的 `settleSession` 结算用量),本文件 5/5 通过,是接线完成的验收证据;
// 接线点在 lib/proxy/prepare.js 捕获令牌、lib/proxy/attempt.js 结算落点
// (内部规划记录不随仓库发布)。
//
// 两件事在这里同时钉:
// 上游是本进程内的桩(手动放行,不 sleep 猜时间),HTTP 全部走 127.0.0.1 临时端口,
// 临时 HOME/数据目录,不使用真实渠道与真实 Key。
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-flt-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_COOLDOWN_SEC = '60';
process.env.MIXR_MAX_ATTEMPTS = '2';

const mod = require('../mixrouter.js');
const { _state, normalizeRule } = mod;
const POOL = ['pa', 'pb', 'pc'];
// 三个渠道一个池,轮询策略:哪一条落到哪个渠道不写死(游标是跨请求状态),
// 断言一律以"这一条实际落在哪"为基准,不去猜顺序。
const routeFixture = () => { _state.routes = { rules: [normalizeRule({ id: 'flt', match: 'opus', pool: POOL, strategy: 'round_robin', enabled: true })], default: normalizeRule({}) }; };

// ---- 可控上游:请求到了先挂住,等测试放行才回 200 ----
const pending = [];
const upstream = http.createServer((req, res) => {
  const cs = [];
  req.on('data', c => cs.push(c));
  req.on('end', () => {
    pending.push({ url: req.url, headers: req.headers, res, replied: false });
  });
});
const reply = (i, { in: input = 17, out = 9 } = {}) => {
  const p = pending[i];
  if (!p || p.replied) return;            // 每条只回一次:重复 writeHead 会 ERR_HTTP_HEADERS_SENT
  p.replied = true;
  p.res.writeHead(200, { 'Content-Type': 'application/json' });
  p.res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock',
    content: [{ type: 'text', text: 'mock-echo' }], stop_reason: 'end_turn',
    usage: { input_tokens: input, output_tokens: out } }));
};
const settleAll = () => { for (let i = 0; i < pending.length; i++) reply(i); };
const waitFor = async (fn, what = 'fixture') => {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.fail(`${what} 未在超时前出现`);
};

const KEY_OF = { pa: 'sk-a', pb: 'sk-b', pc: 'sk-c' };
// 出站带的是哪个渠道的 Key → 反推这次落在哪个渠道(渠道名头在给客户端的响应上,不在出站请求里)
const providerOfKey = k => Object.keys(KEY_OF).find(id => KEY_OF[id] === k) || '';
let proxySrv, uiSrv, proxyPort, uiPort;
let sessionNo = 0;
const sessionId = () => `flt-${++sessionNo}-0000-0000-0000-000000000000`;
const keyOf = id => 'cc:' + id;
const shortOf = id => id.slice(0, 8);

function request(port, method, reqPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, method, path: reqPath,
      headers: { ...(data ? { 'Content-Length': Buffer.byteLength(data), 'Content-Type': 'application/json' } : {}), ...headers } },
    res => {
      const cs = [];
      res.on('data', c => cs.push(c));
      res.on('end', () => {
        const text = Buffer.concat(cs).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 发起一条代理请求,不 await 完成:等上游真的收到为止(拿到在途句柄)
async function startProxy(sid, { model = 'claude-opus-5', body = {} } = {}) {
  const before = pending.length;
  const done = request(proxyPort, 'POST', '/v1/messages', {
    headers: { 'x-claude-code-session-id': sid },
    body: { model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...body },
  });
  await waitFor(() => pending.length > before, '上游收到在途请求');
  const hit = pending[pending.length - 1];
  const key = hit.headers['x-api-key'] || String(hit.headers.authorization || '').replace(/^Bearer /, '');
  return { done, hit, key, provider: providerOfKey(key) };
}
const rowOf = async sid => {
  const r = await request(uiPort, 'GET', '/api/sessions');
  return (r.json && r.json.sessions || []).find(s => s.key === keyOf(sid)) || null;
};
// 直接问会话记录(不走接口,免得接口自身的剪枝/口径混进断言)
const recordOf = sid => _state.sessions.get(keyOf(sid));

test('setup:本地可控上游 + 代理/控制台端口', async () => {
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  upstream.unref();
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const prov = id => ({ id, name: '渠道' + id, base_url: base,
    api_key: KEY_OF[id], enabled: true, models: ['claude-opus-5'], slots: {} });
  const provs = ['pa', 'pb', 'pc'].map(prov);
  _state.store = { claude: provs, codex: [] };
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({ version: 2, current: { claude: null, codex: null }, claude: provs, codex: [] }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({ rules: [], default: { provider: '', model: '' } }));
  routeFixture();
  _state.sessions.clear();
  _state.cooldowns = {};
  _state.resetPools();
  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
});

test('在途请求跨过解绑:响应不复活绑定,但仍记统计与实际落点', async () => {
  const sid = sessionId(), key = keyOf(sid);
  _state.sessions.clear(); _state.resetPools();
  const flight = await startProxy(sid);
  const landed = flight.provider;
  assert.equal(flight.key, KEY_OF[landed], '出站带的是该渠道的 Key');
  const captured = recordOf(sid);
  assert.ok(captured, '发起请求就已经建档');
  const created = captured.created;

  // 控制台在响应回来之前把这个会话解绑并删除
  const del = await request(uiPort, 'DELETE', '/api/sessions/' + encodeURIComponent(key));
  assert.equal(del.status, 200, del.text);
  assert.equal(recordOf(sid), undefined, '删除后记录不在内存里');

  settleAll();
  const done = await flight.done;
  assert.equal(done.status, 200, done.text);
  assert.equal(recordOf(sid), undefined, '在途响应不得把被删的会话复活(不重新建档)');
  assert.equal((await rowOf(sid)), null, '接口列表里也不得冒出来');
  assert.equal(_state.sessions.has(key), false);
  // 后续请求仍按新会话处理:重新建档,而不是捡回旧统计
  const again = await startProxy(sid);
  settleAll();
  await again.done;
  const fresh = recordOf(sid);
  assert.equal(fresh.reqs, 1, '重建的记录只算这一条新请求');
  assert.ok(fresh.created > created, '是新记录,不是旧记录被复活');
});

test('在途请求跨过手动重绑:先钉好的渠道不被旧响应覆盖回去', async () => {
  const sid = sessionId(), key = keyOf(sid);
  _state.sessions.clear(); _state.resetPools();
  const flight = await startProxy(sid);
  const landed = flight.provider;
  // 钉到一个**不是**这条在途请求落点的渠道
  const target = POOL.find(id => id !== landed);

  const pinned = await request(uiPort, 'POST', `/api/sessions/${encodeURIComponent(key)}/pin`, { body: { provider: target } });
  assert.equal(pinned.status, 200, pinned.text);
  assert.equal(recordOf(sid).providerId, target);
  assert.equal(recordOf(sid).pinned, true);

  settleAll();
  const done = await flight.done;
  assert.equal(done.status, 200, done.text);
  const after = recordOf(sid);
  assert.equal(after.providerId, target, '手动钉定的渠道不被在途响应改回旧落点');
  assert.equal(after.pinned, true);
  assert.equal(after.reqs, 1, '统计照记(它描述的确实是这条会话发生过的事)');
  assert.equal(after.actual && after.actual.providerId, landed, '最近实际落点如实记旧落点');
  assert.equal(after.actual && after.actual.status, 200);
  // 下一条请求按手动钉定走 target(钉定压过池策略)
  const next = await startProxy(sid);
  assert.equal(next.provider, target);
  settleAll();
  await next.done;
});


test('在途请求跨过覆盖保存:新配置不被旧响应改回,存量覆盖仍在', async () => {
  const sid = sessionId(), key = keyOf(sid);
  _state.sessions.clear(); _state.resetPools();
  // 给 pb 加 Key 环,才有可保存的覆盖
  const pb = _state.store.claude.find(p => p.id === 'pb');
  pb.keys = [{ id: 'kb', label: '账号B', key: 'sk-b-2' }];
  pb.active_key = 'kb';
  const flight = await startProxy(sid);
  const landed = flight.provider;

  const got = await request(uiPort, 'GET', `/api/sessions/${encodeURIComponent(key)}/routing`);
  assert.equal(got.status, 200, got.text);
  const put = await request(uiPort, 'PUT', `/api/sessions/${encodeURIComponent(key)}/routing`, {
    body: { expected_revision: got.json.revision, routing: { keys: { pb: 'kb' }, slots: {} } },
  });
  assert.equal(put.status, 200, put.text);
  assert.equal(recordOf(sid).routing.keys.pb, 'kb', '覆盖已保存');

  settleAll();
  const done = await flight.done;
  assert.equal(done.status, 200, done.text);
  const afterSave = recordOf(sid);
  assert.equal(afterSave.routing.keys.pb, 'kb', '存下来的覆盖不被在途响应抹掉或改回');
  assert.equal(afterSave.providerId, landed, '这条请求本来就落在 landed,绑定照常记它');
  assert.equal(afterSave.reqs, 1, '统计照记');
  assert.equal(afterSave.actual.providerId, landed, '实际落点记的是真实那一次');
  // 下一条请求:路由规则仍会轮到别的渠道,但**固定 Key 覆盖**只对 pb 生效——
  // 所以这里只核"覆盖还在、能读出来",不假设下一条一定落 pb
  const row = await rowOf(sid);
  assert.deepEqual(row.required.keys, 1, '三层里的 required 仍是一份可读的覆盖');
});

test('钉定渠道不可用时,在途响应不改写钉定,actual 如实记新落点', async () => {
  const sid = sessionId(), key = keyOf(sid);
  _state.sessions.clear(); _state.resetPools();
  // 先让一条普通请求钉住某渠道,再用控制台钉定它(模拟用户钉了 X)
  const first = await startProxy(sid);
  const X = first.provider;
  settleAll();
  await first.done;
  const pin = await request(uiPort, 'POST', `/api/sessions/${encodeURIComponent(key)}/pin`, { body: { provider: X } });
  assert.equal(pin.status, 200, pin.text);
  assert.deepEqual([recordOf(sid).providerId, recordOf(sid).pinned], [X, true], '已钉定 X');

  // 钉定渠道不可用(实测等价于一次 5xx 冷却/停用):请求回退到池里的别人,这条在途响应提交 binding
  const px = _state.store.claude.find(p => p.id === X);
  const wasEnabled = px.enabled;
  px.enabled = false;
  try {
    const flight = await startProxy(sid);
    assert.notEqual(flight.provider, X, '钉定渠道不可用时落到了别的渠道(前提成立)');
    settleAll();
    const done = await flight.done;
    assert.equal(done.status, 200, done.text);
    const after = recordOf(sid);
    // 两头都要钉住,否则以后有人"顺手"把 actual 也拦了不会报红
    assert.deepEqual([after.providerId, after.pinned], [X, true],
      '钉定是显式配置:自动落点不得把它改写成回退到的渠道(改了就等于把用户的钉定永久废掉)');
    assert.equal(after.actual && after.actual.providerId, flight.provider, 'actual 如实记这一条真实落到哪');
    assert.equal(after.actual && after.actual.status, 200);
    assert.equal(after.reqs, 2, '统计照记');
    const row = await rowOf(sid);
    assert.equal(row.bound.provider, X, '三层里的"当前绑定"仍是钉定的 X');
    assert.equal(row.actual.provider, flight.provider, '三层里的"最近实际结果"是回退到的渠道');
    assert.notEqual(row.bound.provider, row.actual.provider, '两层分开,不混成一句"已绑定"');
  } finally {
    px.enabled = wasEnabled;
  }

  // 钉定渠道恢复后:下一条仍回 X(钉定没被废掉)——这是"永久废掉"那条后果的反证
  const back = await startProxy(sid);
  assert.equal(back.provider, X, '恢复后仍走用户钉定的渠道');
  settleAll();
  await back.done;
});

test('teardown:放行未结算的上游并关掉本测试起的端口', async () => {
  for (let i = 0; i < pending.length; i++) { try { reply(i); } catch {} }
  await new Promise(r => proxySrv.close(r));
  await new Promise(r => uiSrv.close(r));
  await new Promise(r => upstream.close(r));
});
