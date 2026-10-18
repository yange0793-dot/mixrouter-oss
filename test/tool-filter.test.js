'use strict';
// lib/tool-filter 单测:既测纯函数(匹配规则、幂等、边界),也测接线(槽位 dropTools 真的
// 作用在**发往上游的 body** 上,且只作用于配了 dropTools 的那个槽位)。
// 上游是本文件内的假服务,不发真实请求。
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const toolFilter = require('../lib/tool-filter');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-toolfilter-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude', 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex', 'config.toml');
const mod = require('../mixrouter');

let ui, proxy, upstream, base;
const hits = [];

function request(url, method = 'POST', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(url, { method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, text, data: JSON.parse(text || '{}'), headers: res.headers }); });
    });
    req.on('error', reject); req.end(data);
  });
}
const uiPort = () => ui.address().port;
const proxyPort = () => proxy.address().port;
const api = (route, body, method = 'POST') => request(`http://127.0.0.1:${uiPort()}${route}`, method, body);

const tool = name => ({ name, description: '', input_schema: { type: 'object', properties: {} } });

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      hits.push({ path: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 2 } }));
    });
  });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${upstream.address().port}`;
  ui = await mod.listen(0, mod.apiHandler);
  proxy = await mod.listen(0, mod.proxyHandler);
});

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(process.env.MIXR_CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(process.env.MIXR_CLAUDE_SETTINGS, JSON.stringify({ env: { ANTHROPIC_MODEL: 'keep-me-real' } }));
  hits.length = 0;
  mod._state.store = {
    claude: [{ id: 'pa', name: 'A', base_url: base, api_key: 'k', models: ['glm-5.3'], enabled: true }],
    codex: [],
  };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.current = { claude: null, codex: null, zcode: null };
});

// ---------------------------------------------------------------- 纯函数

test('matches:精确名不误伤同前缀的其它工具', () => {
  assert.equal(toolFilter.matches('Bash', 'Bash'), true);
  assert.equal(toolFilter.matches('BashOutput', 'Bash'), false);
  assert.equal(toolFilter.matches('Bash', 'bash'), false, '大小写敏感');
});

test('matches:尾部通配只吃前缀,不吃中间', () => {
  assert.equal(toolFilter.matches('mcp__playwright__browser_click', 'mcp__*'), true);
  assert.equal(toolFilter.matches('mcp__tavily__search', 'mcp__*'), true);
  assert.equal(toolFilter.matches('Read', 'mcp__*'), false);
  assert.equal(toolFilter.matches('mcp__x__y', 'mcp__playwright__*'), false, '别的 server 不放行');
});

test('matches:空值与坏输入一律不匹配', () => {
  for (const [n, p] of [['', 'Bash'], ['Bash', ''], [null, 'Bash'], ['Bash', null], [undefined, '*'], ['Bash', undefined]]) {
    assert.equal(toolFilter.matches(n, p), false, `${String(n)} / ${String(p)}`);
  }
});

test('apply:原地删元素并保持其它工具原形状(含 cache_control)', () => {
  const body = {
    tools: [
      { name: 'Bash', description: 'x' },
      { name: 'Read', description: 'y', cache_control: { type: 'ephemeral' } },
      { name: 'mcp__playwright__browser_click', description: 'z' },
      { name: 'Agent', description: 'w' },
    ],
  };
  assert.equal(toolFilter.apply(body, ['Bash', 'mcp__*']), 2);
  assert.deepEqual(body.tools.map(t => t.name), ['Read', 'Agent']);
  assert.deepEqual(body.tools[0].cache_control, { type: 'ephemeral' }, '保留下来的工具字段不动');
});

test('apply:幂等 —— 第二次调用删 0 条,不会重复计数', () => {
  const body = { tools: [{ name: 'Bash' }, { name: 'Read' }] };
  assert.equal(toolFilter.apply(body, ['Bash']), 1);
  assert.equal(toolFilter.apply(body, ['Bash']), 0);
  assert.deepEqual(body.tools.map(t => t.name), ['Read']);
});

test('apply:没有 tools / 没有规则 / 坏 body 时原样返回 0', () => {
  assert.equal(toolFilter.apply({ tools: [] }, ['Bash']), 0);
  assert.equal(toolFilter.apply({}, ['Bash']), 0);
  assert.equal(toolFilter.apply({ tools: [{ name: 'Bash' }] }, []), 0);
  assert.equal(toolFilter.apply({ tools: [{ name: 'Bash' }] }, undefined), 0);
  assert.equal(toolFilter.apply(null, ['Bash']), 0);
  assert.equal(toolFilter.apply('nope', ['Bash']), 0);
});

test('apply:tools 里混着无 name 的条目时不炸也不误删', () => {
  const body = { tools: [{ name: 'Bash' }, {}, null, { description: 'no-name' }, { name: 'Read' }] };
  assert.equal(toolFilter.apply(body, ['Bash']), 1);
  assert.equal(body.tools.length, 4);
});

// ---------------------------------------------------------------- 接线

test('接线:配了 dropTools 的槽位,出站 body 里这些工具真的没了', async () => {
  mod._state.slotMap = { claude: { main: { provider: 'pa', model: 'm-main', dropTools: ['Bash', 'mcp__*'] } }, codex: {} };
  const r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-main', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }],
      tools: [tool('Bash'), tool('Read'), tool('Edit'), tool('mcp__playwright__browser_click')] });
  assert.equal(r.status, 200);
  assert.deepEqual(hits.at(-1).body.tools.map(t => t.name), ['Read', 'Edit'], '上游拿到的 tools 已剥离');
});

test('接线:没配 dropTools 的槽位一个工具都不动(子代理槽不受影响)', async () => {
  mod._state.slotMap = {
    claude: {
      main: { provider: 'pa', model: 'm-main', dropTools: ['Bash'] },
      subagent: { provider: 'pa', model: 'm-sub' },
    }, codex: {},
  };
  const sent = [tool('Bash'), tool('Read')];
  const r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-subagent', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }], tools: sent });
  assert.equal(r.status, 200);
  assert.deepEqual(hits.at(-1).body.tools.map(t => t.name), ['Bash', 'Read'], 'subagent 槽原样透传');
});

test('接线:请求体本身没有被改写(tools 之外的部分照旧)', async () => {
  mod._state.slotMap = { claude: { main: { provider: 'pa', model: 'm-main', dropTools: ['Bash'] } }, codex: {} };
  await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-main', max_tokens: 7, system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [tool('Bash')], tool_choice: { type: 'auto' } });
  const up = hits.at(-1).body;
  assert.equal(up.model, 'm-main');
  assert.equal(up.max_tokens, 7);
  assert.equal(up.system, 'S');
  assert.deepEqual(up.tool_choice, { type: 'auto' }, '不额外设 tool_choice(会把 Agent 一起封死)');
  assert.deepEqual(up.tools, [], 'tools 空数组而不是删除字段');
});

test('API:dropTools 落盘、回读,并在部分更新时保留', async () => {
  let r = await api('/api/slots', { claude: { haiku: { provider: 'pa', model: 'glm-5.3', dropTools: ['Bash', 'mcp__*'] } } }, 'PUT');
  assert.equal(r.status, 200);
  let haiku = r.data.slots.claude.find(s => s.name === 'haiku');
  assert.deepEqual(haiku.dropTools, ['Bash', 'mcp__*']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(TMP, 'slots.json'), 'utf8')).claude.haiku.dropTools, ['Bash', 'mcp__*']);

  // 部分更新:只改 model,dropTools 必须留着
  r = await api('/api/slots', { claude: { haiku: { provider: 'pa', model: 'glm-5.4' } } }, 'PUT');
  assert.equal(r.status, 200);
  haiku = r.data.slots.claude.find(s => s.name === 'haiku');
  assert.equal(haiku.model, 'glm-5.4');
  assert.deepEqual(haiku.dropTools, ['Bash', 'mcp__*'], '改 model 不该抹掉剥离规则');

  // 显式清空
  r = await api('/api/slots', { claude: { haiku: { provider: 'pa', model: 'glm-5.4', dropTools: [] } } }, 'PUT');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.slots.claude.find(s => s.name === 'haiku').dropTools, []);
});

test('API:dropTools 是坏值时明确报错,不静默存进去', async () => {
  for (const bad of ['Bash', [1, 2], [''], ['  '], [null], {}]) {
    const r = await api('/api/slots', { claude: { haiku: { provider: 'pa', model: 'glm-5.3', dropTools: bad } } }, 'PUT');
    assert.equal(r.status, 400, `dropTools=${JSON.stringify(bad)} 应被拒`);
    assert.match(r.data.error, /dropTools/);
  }
});

after(async () => {
  await Promise.all([ui, proxy, upstream].map(s => new Promise(ok => s.close(ok))));
});
