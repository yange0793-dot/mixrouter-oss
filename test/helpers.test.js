'use strict';
// 纯函数单测:模型改写 / beta 头 / header 消洗 / usage 抽取 / key 脱敏 / TOML 转义 / 路由解析
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离运行时数据目录,避免读到(更不能写到)仓库里的真实配置
process.env.MIXR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-helpers-'));
const {
  VERSION, resolveRoute, applyModel, safeHeader, extractUsage, maskKey, tomlStr, validBaseUrl, altPorts, _state,
} = require('../mixrouter.js');

test('altPorts:兼容监听端口解析,剔掉主端口/控制台/非法值并去重', () => {
  process.env.MIXROUTER_ALT_PORTS = '15721, 8787, 8788, 0, abc, 70000, 15721';
  assert.deepStrictEqual(altPorts(8787, 8788), [15721]);
  process.env.MIXROUTER_ALT_PORTS = '';
  assert.deepStrictEqual(altPorts(8787, 8788), []);
  delete process.env.MIXROUTER_ALT_PORTS;
  assert.deepStrictEqual(altPorts(8787, 8788), []);
});

test('applyModel 无 [1M] 后缀时原样返回且不动 headers', () => {
  const headers = {};
  assert.strictEqual(applyModel('claude-opus-5', headers), 'claude-opus-5');
  assert.strictEqual(headers['anthropic-beta'], undefined);
});

test('applyModel 剥离 [1M] 后缀并追加 context-1m beta 头', () => {
  const headers = {};
  assert.strictEqual(applyModel('Claude-Opus-5[1m]', headers), 'Claude-Opus-5');
  assert.strictEqual(headers['anthropic-beta'], 'context-1m-2025-08-07');
});

test('applyModel 已有 beta 头时合并且不重复', () => {
  const h1 = { 'anthropic-beta': 'other-beta' };
  applyModel('m[1M]', h1);
  assert.strictEqual(h1['anthropic-beta'], 'other-beta,context-1m-2025-08-07');
  const h2 = { 'anthropic-beta': 'context-1m-2025-08-07,x' };
  applyModel('m[1M]', h2);
  assert.strictEqual(h2['anthropic-beta'], 'context-1m-2025-08-07,x');
});

test('safeHeader 消洗非 ASCII 并 trim,空值返回空串', () => {
  assert.strictEqual(safeHeader('  渠道①名 ok '), 'ok');
  assert.strictEqual(safeHeader('claude-cli/1.0'), 'claude-cli/1.0');
  assert.strictEqual(safeHeader(null), '');
  assert.strictEqual(safeHeader(undefined), '');
});

test('extractUsage 从非流式 JSON 抽取 usage', () => {
  const u = extractUsage(JSON.stringify({ usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 } }));
  assert.deepStrictEqual(u, { in: 11, out: 7, cache_read: 3 });
});

test('extractUsage 从 SSE 累积文本抽取:输入取 message_start,输出取 message_delta', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":17,"cache_read_input_tokens":5}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":9}}',
    '',
  ].join('\n');
  const u = extractUsage(sse);
  assert.deepStrictEqual(u, { in: 17, out: 9, cache_read: 5 });
});

test('extractUsage 无 usage 时返回零值', () => {
  assert.deepStrictEqual(extractUsage('nothing here'), { in: 0, out: 0, cache_read: 0 });
});

test('maskKey 长 key 掐头去尾,短 key 全掩码', () => {
  assert.strictEqual(maskKey('sk-abcdefghijklmnop'), 'sk-abc…mnop');
  assert.strictEqual(maskKey('short'), '***');
  assert.strictEqual(maskKey(''), '');
  assert.strictEqual(maskKey(undefined), '');
});

test('tomlStr 转义反斜杠与双引号', () => {
  assert.strictEqual(tomlStr('a"b\\c'), '"a\\"b\\\\c"');
  assert.strictEqual(tomlStr(null), '""');
});

// ---- 精确落点:只认已登记模型(通用 match/when/default 已删除)----
const provider = (id, models, extra = {}) => ({ id, name: id, models, api_key: 'sk-' + id, enabled: true, ...extra });

test('resolveRoute 精确登记模型:大小写不敏感、剥 [1m] 后缀后全等才命中', () => {
  _state.store = { claude: [provider('p1', ['Claude-OPUS-5']), provider('p2', ['other-model'])], codex: [] };
  _state.routes = { rules: [], default: { provider: '', model: '' } };
  const r = resolveRoute('claude-opus-5');
  assert.strictEqual(r.stage, 'model');
  assert.strictEqual(r.rule.id, 'model:p1');
  assert.strictEqual(r.provider.id, 'p1');
  assert.strictEqual(r.model, 'Claude-OPUS-5');
  // [1m] 只影响窗口,不影响落点;返回的仍是登记原值
  assert.strictEqual(resolveRoute('CLAUDE-OPUS-5[1m]').provider.id, 'p1');
  // 子串不再命中
  assert.strictEqual(resolveRoute('claude-opus').provider, null);
});

test('resolveRoute 未登记模型:members 为空并明确报 no_route,不偷选其它渠道', () => {
  _state.store = { claude: [provider('p1', ['m1'])], codex: [] };
  const r = resolveRoute('nope-model');
  assert.strictEqual(r.stage, 'model');
  assert.deepStrictEqual(r.members, []);
  assert.strictEqual(r.provider, null);
  assert.strictEqual(r.error.type, 'no_route_error');
  assert.strictEqual(r.error.status, 503);
});

test('resolveRoute 多渠道登记同一模型:歧义明确失败,不按顺序偷选', () => {
  _state.store = { claude: [provider('p1', ['shared']), provider('p2', ['shared']), provider('p3', ['solo'])], codex: [] };
  const r = resolveRoute('shared');
  assert.deepStrictEqual(r.members, []);
  assert.strictEqual(r.error.type, 'model_ambiguous_error');
  assert.strictEqual(r.error.status, 409);
  assert.deepStrictEqual(r.candidates, ['p1', 'p2']);
  // 其它模型不受影响
  assert.strictEqual(resolveRoute('solo').provider.id, 'p3');
});

test('resolveRoute 停用或没有 Key 的渠道不算登记命中', () => {
  _state.store = { claude: [
    provider('off', ['m1'], { enabled: false }),
    provider('nokey', ['m2'], { api_key: '' }),
  ], codex: [] };
  assert.strictEqual(resolveRoute('m1').error.type, 'no_route_error');
  assert.strictEqual(resolveRoute('m2').error.type, 'no_route_error');
});

test('resolveRoute 精确槽位优先于已登记模型,并保留槽位备池策略', () => {
  _state.store = { claude: [provider('p1', ['mixr-main']), provider('p2', ['slot-model'])], codex: [] };
  _state.slotMap = { claude: { main: { provider: 'p2', model: 'slot-model',
    pool: [{ provider: 'p1', model: 'slot-model' }], strategy: 'priority' } }, codex: {} };
  const hit = resolveRoute('mixr-main');
  assert.strictEqual(hit.stage, 'slot');
  assert.strictEqual(hit.slot, 'main');
  assert.strictEqual(hit.rule.id, 'slot:claude/main');
  assert.strictEqual(hit.provider.id, 'p2');
  assert.strictEqual(hit.strategy, 'priority');
  assert.deepStrictEqual(hit.members.map(m => [m.provider.id, m.model]),
    [['p2', 'slot-model'], ['p1', 'slot-model']]);
});

test('validBaseUrl 只收 http(s) URL', () => {
  assert.strictEqual(validBaseUrl('https://api.example.com'), true);
  assert.strictEqual(validBaseUrl('http://127.0.0.1:8787'), true);
  assert.strictEqual(validBaseUrl('not-a-url'), false);
  assert.strictEqual(validBaseUrl('ftp://x.example.com'), false);
  assert.strictEqual(validBaseUrl('javascript:alert(1)'), false);
  assert.strictEqual(validBaseUrl(''), false);
  assert.strictEqual(validBaseUrl(null), false);
});

test('导出的 VERSION 与 package.json 一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(VERSION, pkg.version);
});

test('priority 主备策略:永远取池序第一个可用渠道,旧冷却接口不降级', () => {
  const { pickMember, markCooldown } = require('../mixrouter.js');
  const rule = { id: 't-pri', strategy: 'priority', pool: [] };
  const pa = { id: 'pa', name: '主', base_url: 'https://a.example', enabled: true };
  const pb = { id: 'pb', name: '备', base_url: 'https://b.example', enabled: true };
  const members = [{ provider: pa, model: 'm1', weight: 1 }, { provider: pb, model: 'm2', weight: 1 }];
  assert.strictEqual(pickMember(rule, members).provider.id, 'pa');
  assert.strictEqual(pickMember(rule, members).provider.id, 'pa', '不做轮询,始终主渠道');
  markCooldown('pa', 500);
  assert.strictEqual(pickMember(rule, members).provider.id, 'pa', '旧冷却接口不影响主渠道');
  assert.strictEqual(pickMember(rule, members).provider.id, 'pa');
  // 旧冷却接口调用两次也仍是池序首位
  markCooldown('pb', 500);
  assert.strictEqual(pickMember(rule, members).provider.id, 'pa');
  // 未知策略回落轮询,不受影响
  const rr = pickMember({ id: 't-rr', strategy: 'bogus', pool: [] }, members);
  assert.ok([pa, pb].some(p => p.id === rr.provider.id));
});
