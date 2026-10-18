'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-split-'));
process.env.MIXR_DATA_DIR = tmp;
process.env.MIXR_CLAUDE_SETTINGS = path.join(tmp, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(tmp, 'config.toml');
const mod = require('../mixrouter');
const call = (port, route, body, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST',
    headers: { 'content-type': 'application/json', ...headers } }, res => {
    let text = ''; res.on('data', c => text += c);
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', reject); req.end(JSON.stringify(body));
});

test('双路配置:两协议完整 SSE、独立密钥、子代理热切换、重载不回放旧备份', async t => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    let text = ''; req.on('data', c => text += c);
    req.on('end', () => {
      const body = JSON.parse(text);
      hits.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
      if (req.url === '/v1/responses') {
        event({ type: 'response.created', response: { id: 'resp_split', model: body.model } });
        event({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_split' } });
        event({ type: 'response.output_text.delta', delta: 'ASTRA' });
        event({ type: 'response.output_item.done', item: { type: 'message' } });
        event({ type: 'response.completed', response: { id: 'resp_split', status: 'completed', model: body.model, usage: { input_tokens: 1, output_tokens: 1 } } });
      } else {
        event({ type: 'message_start', message: { id: 'msg_ds', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } });
        event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DEEPSEEK' } });
        event({ type: 'content_block_stop', index: 0 });
        event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
        event({ type: 'message_stop' });
      }
      res.end();
    });
  });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  const ui = await mod.listen(0, mod.apiHandler);
  const proxy = await mod.listen(0, mod.proxyHandler);
  t.after(async () => {
    await Promise.all([upstream, ui, proxy].map(s => new Promise(ok => s.close(ok))));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${upstream.address().port}`;
  mod._state.store = { claude: [
    { id: 'ds', name: 'DeepSeek', base_url: base, api_key: 'secret-ds', models: ['deepseek-v4-flash'], enabled: true },
    { id: 'astra-a', name: 'Astra A', base_url: base, api_key: 'secret-a', models: ['gpt-6-astra'], wire_api: 'responses', enabled: true },
    { id: 'astra-b', name: 'Astra B', base_url: base, api_key: 'secret-b', models: ['gpt-6-astra'], wire_api: 'responses', enabled: true },
    { id: 'disabled', enabled: false },
  ], codex: [] };
  mod._state.slotMap = { claude: {}, codex: { worker: { provider: 'untouched' } } };
  mod._state.routes = { rules: [], default: {} };
  fs.writeFileSync(process.env.MIXR_CLAUDE_SETTINGS, JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'old-model' }, permissions: { allow: ['Read'] } }));
  const original = fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8');
  const post = b => call(ui.address().port, '/api/claude/split', b);
  const main = { provider: 'ds', model: 'deepseek-v4-flash[1M]' };
  const subagent = { provider: 'astra-a', model: 'gpt-6-astra[1M]' };
  for (const bad of [{ subagent }, { main, subagent: { provider: 'disabled', model: 'x' } }, { main, subagent, apply: 'true' }, { main, subagent: { provider: 'ds' } }]) {
    assert.equal((await post(bad)).status, 400);
    assert.deepEqual(mod._state.slotMap.claude, {});
  }
  let r = await post({ main, subagent });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'), original);
  assert.equal(r.text.includes('secret-'), false);
  assert.deepEqual(mod._state.slotMap.codex, { worker: { provider: 'untouched' } });
  r = await post({ main, subagent, apply: true });
  assert.equal(r.status, 200);
  const live = JSON.parse(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'));
  assert.deepEqual(live.permissions, { allow: ['Read'] });
  for (const [name, key] of Object.entries(mod.CLAUDE_SLOT_ENV)) assert.equal(live.env[key], `mixr-${name}`);
  const requestSlot = model => call(proxy.address().port, '/v1/messages', {
    model, max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }],
  }, { authorization: 'Bearer PROXY_MANAGED', 'x-api-key': 'client-not-upstream', 'x-claude-code-session-id': 'same-session' });
  for (const name of ['main', 'opus', 'sonnet', 'haiku', 'subagent']) {
    r = await requestSlot(`mixr-${name}`);
    assert.equal(r.status, 200);
    assert.match(r.text, /event: message_stop/);
    const hit = hits.at(-1);
    const isSub = name === 'subagent';
    assert.equal(hit.url, isSub ? '/v1/responses' : '/v1/messages');
    assert.equal(hit.body.model, isSub ? 'gpt-6-astra' : 'deepseek-v4-flash');
    assert.equal(hit.headers.authorization, `Bearer ${isSub ? 'secret-a' : 'secret-ds'}`);
    assert.notEqual(hit.headers['x-api-key'], 'client-not-upstream');
    if (isSub) {
      assert.deepEqual(hit.body.include, ['reasoning.encrypted_content']);
      assert.ok(hit.body.prompt_cache_key);
      assert.match(r.text, /ASTRA/);
    } else assert.match(r.text, /DEEPSEEK/);
  }
  const before = JSON.parse(JSON.stringify(mod._state.slotMap.claude));
  const liveBefore = fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8');
  assert.equal((await post({ subagent: { ...subagent, provider: 'astra-b' } })).status, 200);
  for (const name of Object.keys(before).filter(n => n !== 'subagent')) assert.deepEqual(mod._state.slotMap.claude[name], before[name]);
  await requestSlot('mixr-subagent');
  assert.equal(hits.at(-1).headers.authorization, 'Bearer secret-b');
  await requestSlot('mixr-main');
  assert.equal(hits.at(-1).headers.authorization, 'Bearer secret-ds');
  assert.equal(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'), liveBefore);
  const child = spawnSync(process.execPath, ['-e', `
    const m = require(${JSON.stringify(path.resolve(__dirname, '../mixrouter.js'))});
    console.log(JSON.stringify({main:m.resolveSlot('claude','mixr-main').provider.id, sub:m.resolveSlot('claude','mixr-subagent').provider.id}));
  `], { env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { main: 'ds', sub: 'astra-b' });
  assert.equal(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'), liveBefore);
  assert.ok(fs.readdirSync(tmp).some(f => f.includes('.bak-mixui-')));
});

// 把"路由模式"这件事**退回原样**:内存 current 与盘上 providers.json 的 current 都设成 null。
// 必须显式做这一步 —— 本文件前一条用例 apply 成功过,`current.claude` 早就是 `@router` 了,
// 而这两条断言("失败后 current 要回到原值")在**原值本来就等于 @router** 时恒真。
// 注入实测过:不回退 current / 回滚只改内存不写盘 这两个缺陷,当时都全绿。
function resetCurrentToDirect() {
  const pf = path.join(process.env.MIXR_DATA_DIR, 'providers.json');
  const raw = JSON.parse(fs.readFileSync(pf, 'utf8'));
  raw.current = { ...raw.current, claude: null };
  fs.writeFileSync(pf, JSON.stringify(raw, null, 2) + '\n');
  mod._state.current = { ...mod._state.current, claude: null };
  assert.notEqual(mod._state.current.claude, mod.ROUTER_ID, '夹具:起点必须是"没在走路由"');
}

// ---------------------------------------------------------------- apply 失败时必须整体回退
// configureClaudeSplit 的 apply 会动三处:渠道库的 current、用户的 ~/.claude/settings.json、
// 内存 current。它此前的顺序与自己的注释**正好相反**(注释写"路由先持久化,再改客户端",
// 代码是先改客户端、再 saveStore),于是渠道库落盘失败时:接口回 500,
// 而 settings.json 已经被改成路由模式(BASE_URL / AUTH_TOKEN / 全部 mixr-* 槽位别名都写进去了),
// 内存 current 也已是 @router —— providers.json 上却什么都没变。
// 用户看到"应用失败",实际他的 Claude Code 已经被指到本机代理上,而渠道库不知道这件事。
test('claude/split apply:渠道库落盘失败时,客户端配置、槽位、current 一个都不许变', async t => {
  // 先把客户端的 settings.json 摆成一份已知内容(文件不存在时 readClientConfig 会造一份空壳,
  // 那样"变没变"就没有对照物了)。
  const SETTINGS = process.env.MIXR_CLAUDE_SETTINGS;
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify({ env: { KEEP: 'me' } }, null, 2));
  const settingsBefore = fs.readFileSync(SETTINGS, 'utf8');
  assert.ok(!settingsBefore.includes('ANTHROPIC_BASE_URL'), '夹具:这份配置本来不是路由模式');

  const server = await mod.listen(0, mod.apiHandler);
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;
  const ch = await call(port, '/api/providers', { app: 'claude', name: 'SPLIT-RB', base_url: 'http://127.0.0.1:8999', api_key: 'sk-x', models: ['m'] });
  assert.equal(ch.status, 200, ch.text);
  const id = JSON.parse(ch.text).id;

  resetCurrentToDirect();
  const slotsBefore = JSON.stringify(mod._state.slotMap.claude);
  const currentBefore = mod._state.current.claude;
  const liveBefore = fs.readFileSync(SETTINGS, 'utf8');

  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('providers.json')) throw Object.assign(new Error('simulated'), { code: 'EIO' });
    return realRename(from, to);
  };
  let r;
  try {
    // subagent 是必填的(`claudeSplitPatch` 无条件校验它),少给会在**进编排之前**就 400,
    // 那样这条用例验的就不是回滚,而是一次参数校验。
    r = await call(port, '/api/claude/split', {
      apply: true,
      main: { provider: id, model: 'm' },
      subagent: { provider: id, model: 'm' },
    });
  } finally { fs.renameSync = realRename; }

  assert.equal(r.status, 500, `夹具:这次 apply 必须失败(实得 ${r.status} ${r.text})`);
  // 报错要说清是哪一步没成,不能是裸的 e.message
  assert.match(r.text, /写入渠道库失败/, `错误文案要能看出是哪一步;实得 ${r.text}`);
  assert.equal(fs.readFileSync(SETTINGS, 'utf8'), liveBefore,
    '用户的客户端配置**一个字节都不许变** —— 这是这条路径最贵的那一步');
  assert.equal(JSON.stringify(mod._state.slotMap.claude), slotsBefore, '槽位表要回到原样');
  assert.equal(mod._state.current.claude, currentBefore, '内存 current 要回到原样');
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.MIXR_DATA_DIR, 'providers.json'), 'utf8'));
  assert.equal(onDisk.current.claude, currentBefore, '盘上 current 当然也没变');
});

test('claude/split apply:客户端配置写不进去时,渠道库的 current 必须退回原样(不许"控制台说在走路由、客户端却直连")', async t => {
  const SETTINGS = process.env.MIXR_CLAUDE_SETTINGS;
  fs.writeFileSync(SETTINGS, JSON.stringify({ env: { KEEP: 'me' } }, null, 2));

  const server = await mod.listen(0, mod.apiHandler);
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;
  const ch = await call(port, '/api/providers', { app: 'claude', name: 'SPLIT-RB2', base_url: 'http://127.0.0.1:8999', api_key: 'sk-x', models: ['m'] });
  assert.equal(ch.status, 200, ch.text);
  const id = JSON.parse(ch.text).id;

  resetCurrentToDirect();
  const currentBefore = mod._state.current.claude;
  const liveBefore = fs.readFileSync(SETTINGS, 'utf8');

  // 让**客户端配置**的原子替换失败(渠道库那一步已经成功落盘)—— 这两步都要各自回滚。
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('settings.json')) throw Object.assign(new Error('simulated'), { code: 'EIO' });
    return realRename(from, to);
  };
  let r;
  try {
    r = await call(port, '/api/claude/split', {
      apply: true,
      main: { provider: id, model: 'm' },
      subagent: { provider: id, model: 'm' },
    });
  } finally { fs.renameSync = realRename; }

  assert.equal(r.status, 500, `夹具:这次 apply 必须失败(实得 ${r.status} ${r.text})`);
  assert.match(r.text, /写入客户端配置失败/, `错误文案要能看出是哪一步;实得 ${r.text}`);
  assert.equal(fs.readFileSync(SETTINGS, 'utf8'), liveBefore, '客户端配置没写成就该保持原样');
  // 这一步是最容易漏的:客户端没切过去,而渠道库已经把 current 记成 @router 了 ——
  // 那时控制台显示"走路由",实际客户端直连,重启后两边也不会自己收敛。
  assert.equal(mod._state.current.claude, currentBefore, '内存 current 要退回去');
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.MIXR_DATA_DIR, 'providers.json'), 'utf8'));
  assert.equal(onDisk.current.claude, currentBefore, 'current 是落过盘的,回退也必须写回盘上,不能只改内存');
});

test('claude/split apply:备份池轮换预警要带进响应体(这条路径也会写渠道库)', async t => {
  const SETTINGS = process.env.MIXR_CLAUDE_SETTINGS;
  fs.writeFileSync(SETTINGS, JSON.stringify({ env: { KEEP: 'me' } }, null, 2));
  const DATA = process.env.MIXR_DATA_DIR;
  // 垫满 providers.json 的备份池:活文件必须存在(backupFile 在源文件缺失时直接不做),
  // 备份要超过保留上限,这一次 apply 才真的会顶掉一份。
  fs.writeFileSync(path.join(DATA, 'providers.json'),
    JSON.stringify({ version: 2, current: { claude: null, codex: null, zcode: null }, claude: [], codex: [] }, null, 2) + '\n');
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(DATA, `providers.json.bak-mixui-2026010100000${i}-000-abcd`), 'x');

  const server = await mod.listen(0, mod.apiHandler);
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;
  const ch = await call(port, '/api/providers', { app: 'claude', name: 'SPLIT-W', base_url: 'http://127.0.0.1:8999', api_key: 'sk-x', models: ['m'] });
  assert.equal(ch.status, 200, ch.text);
  const id = JSON.parse(ch.text).id;

  // 垫池子之后 create 那次已经自己轮换过一轮,重新量一次基线
  const before = fs.readdirSync(DATA).filter(f => f.startsWith('providers.json.bak-mixui-')).sort();
  const r = await call(port, '/api/claude/split', {
    apply: true, main: { provider: id, model: 'm' }, subagent: { provider: id, model: 'm' },
  });
  const after = fs.readdirSync(DATA).filter(f => f.startsWith('providers.json.bak-mixui-')).sort();
  const deleted = before.filter(n => !after.includes(n));
  assert.equal(r.status, 200, r.text);
  assert.ok(deleted.length, '夹具:这次 apply 必须真的轮换掉一份备份(否则断言是空的)');
  const w = JSON.parse(r.text).warnings;
  assert.ok(Array.isArray(w) && w.length, `响应体里必须带上轮换预警;实得 ${JSON.stringify(w)}`);
  assert.ok(deleted.every(d => w.some(line => line.includes(d))),
    `预警里点名的必须就是真被删的那份(实删 ${deleted.join('、')},报 ${JSON.stringify(w)})`);
});
