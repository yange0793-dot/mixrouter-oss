'use strict';
// 会话身份、精确模型落点、槽位备用与会话 API;不使用通用匹配规则夹具。
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockUpstream } = require('./mock-upstream');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-session-'));
Object.assign(process.env, {
  MIXR_DATA_DIR: TMP, MIXR_CLAUDE_SETTINGS: path.join(TMP, 'settings.json'),
  MIXR_CODEX_CONFIG: path.join(TMP, 'config.toml'), MIXR_MAX_ATTEMPTS: '3', MIXR_RETRY_DELAY_MS: '0',
});
const mod = require('../mixrouter');
const { sessionIdentity, sessionLabel, parseSessionId, buildUpstreamHeaders, clientToken, applyLabel, _state } = mod;
const mock = createMockUpstream();
let proxySrv, uiSrv, failSrv, proxyPort, uiPort, providers;

async function request(port, method, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), text };
}
const api = (method, route, body) => request(uiPort, method, route, body);
async function call(session, model = 'session-model', extra = {}) {
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': session },
    body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...extra }),
  });
  const text = await response.text();
  return { status: response.status, provider: response.headers.get('x-mixrouter-provider'), body: JSON.parse(text), text };
}
const lastLog = async () => (await api('GET', '/api/logs?limit=1')).body.logs[0];
function slot(primary, backups = []) {
  _state.slotMap = { claude: { main: { provider: primary, model: 'primary-model',
    pool: backups.map(provider => ({ provider, model: `backup-${provider}` })), strategy: 'priority' } }, codex: {} };
  _state.resetPools();
}

before(async () => {
  await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve));
  failSrv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'boom' } })); });
  });
  await new Promise(resolve => failSrv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${mock.server.address().port}`;
  providers = [
    { id: 'pa', name: 'provA', base_url: base, api_key: 'sk-a', enabled: true, models: ['session-model'] },
    { id: 'pb', name: 'provB', base_url: base, api_key: 'sk-b', enabled: true, models: ['other-model'] },
    { id: 'pc', name: 'provC', base_url: base, api_key: 'sk-c', enabled: true, models: ['third-model'] },
    { id: 'pdead', name: 'dead', base_url: 'http://127.0.0.1:1', api_key: 'sk-dead', enabled: true, models: [] },
    { id: 'pbad', name: 'bad5xx', base_url: `http://127.0.0.1:${failSrv.address().port}`, api_key: 'sk-bad', enabled: true, models: [] },
  ];
  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port; uiPort = uiSrv.address().port;
});
beforeEach(() => {
  _state.store = { claude: structuredClone(providers), codex: [] };
  _state.routes = { rules: [], default: {} };
  _state.slotMap = { claude: {}, codex: {} };
  _state.sessions.clear(); _state.cooldowns = {}; _state.resetPools();
  mock.requests.length = 0;
});
after(async () => {
  _state.sessions.clear();
  for (const server of [proxySrv, uiSrv, failSrv, mock.server]) {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('parseSessionId 支持裸 id 与 JSON,缺失身份不猜测', () => {
  assert.equal(parseSessionId('abc-123'), 'abc-123');
  assert.equal(parseSessionId('{"device_id":"d","session_id":"sess-9"}'), 'sess-9');
  for (const value of ['{"device_id":"d"}', '   ', null]) assert.equal(parseSessionId(value), '');
});

test('会话身份优先头、其次 metadata,内容指纹稳定且两组不串号', () => {
  assert.deepEqual(sessionIdentity({ headers: { 'x-claude-code-session-id': 'uuid-1' } }, { metadata: { user_id: 'other' } }), { key: 'cc:uuid-1', kind: 'header' });
  assert.deepEqual(sessionIdentity({ headers: {} }, { metadata: { user_id: '{"session_id":"uuid-2"}' } }), { key: 'cc:uuid-2', kind: 'metadata' });
  assert.deepEqual(sessionIdentity({ headers: {} }, { metadata: { user_id: 'uuid-3' } }), { key: 'cc:uuid-3', kind: 'metadata' });
  const body = { system: 'be helpful', messages: [{ role: 'user', content: 'first question' }] };
  const a = sessionIdentity({ headers: {} }, body);
  assert.equal(a.kind, 'fingerprint');
  assert.equal(sessionIdentity({ headers: {} }, body).key, a.key);
  assert.notEqual(sessionIdentity({ headers: {} }, { ...body, messages: [{ role: 'user', content: 'other question' }] }).key, a.key);
  assert.deepEqual(sessionIdentity({ headers: {} }, {}), { key: 'anon', kind: 'anon' });
  assert.equal(sessionIdentity({ headers: { 'thread-id': 'uuid-1' } }, {}, 'codex').key, 'cx:uuid-1');
});

test('会话标签取工作目录或首条正文,内部通告不覆盖真标签', () => {
  assert.equal(sessionLabel({ system: [{ type: 'text', text: '<env>\nWorking directory: /Users/dev/proj/app\n</env>' }] }), '~/proj/app');
  assert.equal(sessionLabel({ system: [{ type: 'text', text: '<env>\nWorking directory: /home/dev/work\n</env>' }] }), '~/work');
  assert.equal(sessionLabel({ messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>' }, { type: 'text', text: '  帮我看下这个   问题 ' }] }] }), '帮我看下这个 问题');
  assert.equal(sessionLabel({}), '');
  const record = { label: '' };
  applyLabel(record, '真正的问题'); applyLabel(record, '后来的标题');
  assert.equal(record.label, '真正的问题');
  const internal = { label: '<session> hi </session> Write the title in the language' };
  applyLabel(internal, '真正的问题'); assert.equal(internal.label, '真正的问题');
  const blank = { label: '' }; applyLabel(blank, ''); assert.equal(blank.label, '');
});

test('出站 UA 与凭据沿用渠道优先级,不由会话身份覆盖', () => {
  const req = { headers: { 'user-agent': 'client/1', 'anthropic-beta': 'b1' } };
  const custom = buildUpstreamHeaders({ api_key: 'k', ua: 'custom/9' }, req);
  assert.equal(custom['User-Agent'], 'custom/9'); assert.equal(custom.Authorization, 'Bearer k');
  assert.equal(custom['anthropic-beta'], 'b1');
  assert.equal(buildUpstreamHeaders({ api_key: 'k' }, req)['User-Agent'], 'client/1');
  assert.ok(buildUpstreamHeaders({ api_key: 'k' }, { headers: {} })['User-Agent'].startsWith('claude-cli/'));
  assert.equal(clientToken({ headers: { authorization: 'Bearer tok-1' } }), 'tok-1');
  assert.equal(clientToken({ headers: { 'x-api-key': 'tok-2' } }), 'tok-2');
  assert.equal(clientToken({ headers: {} }), '');
});

test('唯一登记模型建立会话绑定,后续请求复用且日志如实记账', async () => {
  assert.equal((await call('sess-a')).status, 200);
  assert.equal((await call('sess-a')).status, 200);
  assert.deepEqual(mock.requests.map(r => r.headers['x-api-key']), ['sk-a', 'sk-a']);
  const log = await lastLog();
  assert.equal(log.session, 'sess-a'); assert.equal(log.sticky, true);
  assert.equal(log.attempts, 1); assert.equal(log.failover, false);
});

test('槽位备用带各自模型,失效主渠道不会被永久换掉', async () => {
  slot('pdead', ['pa']);
  const configured = JSON.stringify(_state.slotMap);
  const first = await call('backup-session', 'mixr-main');
  assert.equal(first.status, 200, first.text);
  assert.equal(mock.requests.at(-1).body.model, 'backup-pa');
  assert.equal((await lastLog()).attempts, 2); assert.equal((await lastLog()).failover, true);
  assert.equal((await call('backup-session', 'mixr-main')).status, 200);
  assert.equal((await lastLog()).attempts, 2, '后续仍从明确主渠道开始,不偷偷改槽位或粘到备用');
  assert.equal(JSON.stringify(_state.slotMap), configured);
});

test('槽位多次失败共享 attempts 预算,5xx 可在输出前转备用', async () => {
  slot('pdead', ['pbad', 'pb']);
  const response = await call('attempts', 'mixr-main');
  assert.equal(response.status, 200, response.text);
  assert.equal(mock.requests.at(-1).headers['x-api-key'], 'sk-b');
  assert.equal(mock.requests.at(-1).body.model, 'backup-pb');
  assert.equal((await lastLog()).attempts, 3);
});

test('旧冷却表不影响主槽选择', async () => {
  slot('pa', ['pb']);
  _state.cooldowns = { pa: Date.now() + 60000, pb: Date.now() + 60000 };
  const response = await call('old-cooldowns', 'mixr-main');
  assert.equal(response.status, 200, response.text);
  assert.equal(mock.requests.at(-1).headers['x-api-key'], 'sk-a');
  assert.equal((await lastLog()).attempts, 1);
});

test('槽位唯一目标不可连接时如实返回错误,不假记失败转移', async () => {
  slot('pdead');
  const response = await call('all-failed', 'mixr-main');
  assert.equal(response.status, 502, response.text);
  assert.equal(response.body.error.type, 'api_error');
  assert.equal((await lastLog()).failover, false);
});

test('普通旧规则和默认回退不能把未登记模型送到其它渠道', async () => {
  _state.routes = { rules: [{ id: 'legacy', match: 'unknown', provider: 'pb', model: 'changed-model', enabled: true }], default: { provider: 'pa' } };
  const response = await call('legacy-rejected', 'unknown-model');
  assert.equal(response.status, 503, response.text);
  assert.equal(mock.requests.length, 0);
});

test('会话列表、显式钉定解开同名模型歧义、解除后恢复明确失败', async () => {
  const key = 'cc:api-sess-1';
  // 先打一条唯一模型的请求,让会话在列表里有一条真实记录(歧义请求本身不建档)
  assert.equal((await call('api-sess-1')).status, 200);
  const mine = (await api('GET', '/api/sessions')).body.sessions.find(s => s.key === key);
  assert.ok(mine); assert.equal(mine.short, 'api-sess');
  _state.store.claude.find(p => p.id === 'pc').models.push('dual-model');
  _state.store.claude.find(p => p.id === 'pa').models.push('dual-model');
  const before = mock.requests.length;
  const ambiguous = await call('api-sess-1', 'dual-model');
  assert.equal(ambiguous.status, 409, ambiguous.text);
  assert.equal(ambiguous.body.error.type, 'model_ambiguous_error');
  assert.equal(mock.requests.length, before, '歧义不得擅自选一家渠道');
  const pinned = await api('POST', `/api/sessions/${encodeURIComponent(key)}/pin`, { provider: 'pc' });
  assert.equal(pinned.status, 200, pinned.text);
  const resolved = await call('api-sess-1', 'dual-model');
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal(mock.requests.at(-1).headers['x-api-key'], 'sk-c', '显式钉定解开歧义');
  assert.equal((await api('POST', `/api/sessions/${encodeURIComponent(key)}/pin`, { provider: 'ghost' })).status, 404);
  assert.equal((await api('POST', `/api/sessions/${encodeURIComponent(key)}/pin`, { provider: '' })).body.session.pinned, false);
  const again = await call('api-sess-1', 'dual-model');
  assert.equal(again.status, 409, '解除钉定后歧义重新明确失败');
  assert.equal((await api('DELETE', `/api/sessions/${encodeURIComponent(key)}`)).status, 200);
  assert.ok(!(await api('GET', '/api/sessions')).body.sessions.some(s => s.key === key));
  assert.equal((await api('DELETE', `/api/sessions/${encodeURIComponent(key)}`)).status, 404);
});

test('停用渠道拒绝新增钉定,槽位绑定的停用目标明确报错', async () => {
  await call('disabled-pin');
  _state.store.claude.find(p => p.id === 'pa').enabled = false;
  const pin = await api('POST', '/api/sessions/cc%3Adisabled-pin/pin', { provider: 'pa' });
  assert.equal(pin.status, 400); assert.match(pin.body.error, /停用/);
  slot('pa');
  const response = await call('disabled-slot', 'mixr-main');
  assert.equal(response.status, 503);
  assert.equal(response.body.error.type, 'provider_disabled_error');
});

test('日志按会话过滤,状态不回显 Key,私密正文不进入请求日志', async () => {
  await call('log-one', 'session-model', { messages: [{ role: 'user', content: '这是我的私密提问内容' }] });
  await call('log-two');
  const logs = (await api('GET', '/api/logs?session=log-one')).body.logs;
  assert.ok(logs.length > 0); assert.ok(logs.every(l => l.session === 'log-one' && l.session_kind === 'header'));
  assert.ok(!JSON.stringify(logs).includes('私密提问'));
  const state = (await api('GET', '/api/state')).body;
  assert.ok(Array.isArray(state.sessions)); assert.deepEqual(state.cooldowns, []); assert.equal(state.cooldown_s, 0);
  assert.equal(typeof state.session_ttl_min, 'number');
  assert.doesNotMatch(JSON.stringify(state.sessions), /sk-a|sk-b|sk-c/);
});

function blockSessionsWrite() {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('sessions.json')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return rename(from, to);
  };
  return () => { fs.renameSync = rename; };
}
function seedSessions(bindings) {
  _state.sessions.clear();
  for (const [key, value] of Object.entries(bindings)) _state.sessions.set(key, value);
  fs.writeFileSync(path.join(TMP, 'sessions.json'), JSON.stringify({ version: 1, bindings }));
}
const onDisk = () => JSON.parse(fs.readFileSync(path.join(TMP, 'sessions.json'), 'utf8')).bindings;

test('清空会话写盘失败时内存与磁盘全部保留', async () => {
  seedSessions({ a: { app: 'claude', providerId: 'pa', lastUsed: Date.now() }, b: { app: 'claude', providerId: 'pb', lastUsed: Date.now() } });
  const before = JSON.stringify(onDisk()), unblock = blockSessionsWrite();
  let response;
  try { response = await api('DELETE', '/api/sessions'); } finally { unblock(); }
  assert.equal(response.status, 500, response.text); assert.match(response.text, /写入会话绑定失败/);
  assert.equal(_state.sessions.size, 2); assert.equal(JSON.stringify(onDisk()), before);
});

test('解绑会话写盘失败时不能先从内存删除', async () => {
  seedSessions({ keep: { app: 'claude', providerId: 'pa', lastUsed: Date.now() } });
  const before = JSON.stringify(onDisk()), unblock = blockSessionsWrite();
  let response;
  try { response = await api('DELETE', '/api/sessions/keep'); } finally { unblock(); }
  assert.equal(response.status, 500); assert.equal(_state.sessions.has('keep'), true);
  assert.equal(JSON.stringify(onDisk()), before);
});

test('钉定写盘失败整体回滚,不留下假成功配置', async () => {
  seedSessions({ keep: { app: 'claude', providerId: 'pa', pinned: false, lastUsed: Date.now() } });
  const before = JSON.stringify(onDisk()), unblock = blockSessionsWrite();
  let response;
  try { response = await api('POST', '/api/sessions/keep/pin', { provider: 'pb' }); } finally { unblock(); }
  assert.equal(response.status, 500); assert.equal(_state.sessions.get('keep').providerId, 'pa');
  assert.equal(_state.sessions.get('keep').pinned, false); assert.equal(JSON.stringify(onDisk()), before);
});

test('删除成功响应发出时磁盘已同步,不依赖后台去抖', async () => {
  seedSessions({ gone: { app: 'claude', providerId: 'pa', lastUsed: Date.now() } });
  const response = await api('DELETE', '/api/sessions');
  assert.equal(response.status, 200, response.text); assert.deepEqual(onDisk(), {}); assert.equal(_state.sessions.size, 0);
});
