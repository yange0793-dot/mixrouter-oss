'use strict';
// 示例配置与槽位契约的一致性检查。
//
// 目的不是"跑一遍 JSON.parse",而是钉住三件容易在改文档时静默坏掉的事:
//   1. providers.example.json 与 routes.example.json **互相自洽**——路由里出现的每个渠道 id
//      都能在示例渠道库里找到,且在同一协议组;没有遗留的 fable / 渠道级 slots 字段;
//   2. 示例里的 key、域名都是占位值,不会被误当成可直接运行的凭据;
//   3. 槽位表接受的形状(含 pool / strategy)与这里写的说明一致,列表里没有 fable。
// 只读仓库内的示例文件;不建临时目录、不起服务、不联网。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeRule } = require('../lib/routing/rules');
const { poolMembers, ghostRefs } = require('../lib/routing/pool');
const { createSlotTable, CLAUDE_SLOTS, CLAUDE_SLOT_ENV, slotAlias, CODEX_SLOT_NAME_RE } = require('../lib/routing/slots');
const { createResolver } = require('../lib/routing/resolve');

const ROOT = path.join(__dirname, '..');
const providers = JSON.parse(fs.readFileSync(path.join(ROOT, 'providers.example.json'), 'utf8'));
const routesFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes.example.json'), 'utf8'));

const groupOf = id => (providers.claude.some(p => p.id === id) ? 'claude'
  : providers.codex.some(p => p.id === id) ? 'codex' : null);
const findProvider = id => [...providers.claude, ...providers.codex].find(p => p.id === id) || null;

test('providers.example.json:同组 id 唯一、必填字段齐全、没有遗留字段', () => {
  assert.equal(providers.version, 2, '渠道库落盘版本是 2');
  const ids = [...providers.claude, ...providers.codex].map(p => p.id);
  assert.equal(new Set(ids).size, ids.length, '渠道 id 必须唯一');
  for (const p of providers.claude) {
    assert.ok(p.name && p.base_url, `claude 渠道 ${p.id} 缺 name/base_url`);
    assert.match(p.base_url, /^https?:\/\//, `${p.id} 的 base_url 必须是 http(s)`);
    assert.ok(Array.isArray(p.models) && p.models.length, `${p.id} 至少一个模型`);
    assert.equal(typeof p.enabled, 'boolean', `${p.id} 的 enabled 必须是布尔值`);
    // 渠道级 slots 是旧形态(且带 fable);槽位现在在 slots.json / 控制台槽位表里维护。
    assert.equal('slots' in p, false, `${p.id} 不应再有渠道级 slots 映射`);
    if ('wire_api' in p) assert.ok(['anthropic', 'responses', 'chat'].includes(p.wire_api), `${p.id} 的 wire_api 取值`);
  }
  for (const p of providers.codex) {
    assert.ok(p.model, `Codex 渠道 ${p.id} 必须填 model`);
    assert.ok(['responses', 'chat'].includes(p.wire_api), `${p.id} 的 wire_api 必须是 responses 或 chat`);
  }
});

test('providers.example.json:示例凭据与域名都是占位值', () => {
  for (const p of [...providers.claude, ...providers.codex]) {
    assert.match(new URL(p.base_url).hostname, /(^|\.)example\.com$/, `${p.id} 的域名应是 example.com 占位`);
    assert.match(p.api_key, /^sk-placeholder-/, `${p.id} 的 key 应是 sk-placeholder-* 占位`);
  }
});

test('routes.example.json:每条规则都能归一化,且目标都在示例渠道库里', () => {
  assert.ok(Array.isArray(routesFile.rules) && routesFile.rules.length);
  for (const raw of routesFile.rules) {
    const rule = normalizeRule(raw);
    assert.equal(rule.enabled, raw.enabled, `${raw.id} 的 enabled 被归一化改动了`);
    assert.equal(rule.app, raw.app || '', `${raw.id} 的 app 取值无效`);
    // ghostRefs 只看"渠道 id 是否真实存在",与分组无关;这里要求示例里一个僵尸引用都没有。
    assert.deepEqual(ghostRefs(findProvider, rule), [], `${raw.id} 指向了不存在的渠道`);
    const app = rule.app || 'claude';
    for (const m of rule.pool) {
      const id = typeof m === 'string' ? m : m.provider;
      assert.equal(groupOf(id), app, `${raw.id} 的池成员 ${id} 不属于 ${app} 组`);
    }
    if (rule.provider) assert.equal(groupOf(rule.provider), app, `${raw.id} 的单一目标不属于 ${app} 组`);
    // 同一份规则在真实解析里应当至少能挑出成员(池成员全停用/不存在时会是空)。
    const members = poolMembers(app === 'codex' ? providers.codex : providers.claude, rule, app);
    assert.ok(members.length, `${raw.id} 在示例渠道库下挑不出任何成员`);
    assert.equal(new Set(members.map(m => m.provider.id)).size, members.length, `${raw.id} 的池成员重复`);
  }
  const def = normalizeRule(routesFile.default);
  assert.deepEqual(ghostRefs(findProvider, def), [], '默认路由指向了不存在的渠道');
});

test('routes.example.json:空默认路由是有意的(没有目标时明确 503)', () => {
  const def = normalizeRule(routesFile.default);
  assert.equal(def.provider, '');
  assert.deepEqual(def.pool, []);
  assert.match(routesFile.default._注释, /503|no_route/, '默认路由为空时必须写在注释里说明后果');
});

test('示例路由真能解析:两组各命中一条规则,未知模型落到空默认路由', () => {
  const routes = {
    rules: routesFile.rules.map(r => normalizeRule(r)),
    default: normalizeRule(routesFile.default),
  };
  const resolve = createResolver({
    getRoutes: () => routes,
    storeOf: app => providers[app],
    resolveSlot: () => null,
    findProvider,
    providerApp: id => groupOf(id),
  });
  const hit = (model, app) => resolve(model, { ua: 'claude-cli/2.1.0' }, app);

  const opus = hit('claude-opus-5', 'claude');
  assert.equal(opus.rule.id, 'r-claude-pool');
  assert.equal(opus.members.length, 2, '池里两个渠道都可用');
  assert.equal(opus.model, 'claude-opus-5[1M]', '池成员各自的目标模型生效');

  assert.equal(hit('claude-sonnet-5', 'claude').rule.id, 'r-claude-sonnet');
  assert.equal(hit('gpt-5-codex', 'codex').rule.id, 'r-codex-gpt');
  assert.equal(hit('glm-5', 'codex').rule.id, 'r-codex-glm');

  // 停用的规则不命中;默认路由没有目标 → members 为空,实跑会 503 no_route_error。
  const haiku = hit('claude-haiku-5', 'claude');
  assert.equal(haiku.rule, null);
  assert.deepEqual(haiku.members, []);
});

test('槽位表:五个 Claude 固定槽、没有 fable、别名与 env 一一对应', () => {
  assert.deepEqual(CLAUDE_SLOTS, ['main', 'opus', 'sonnet', 'haiku', 'subagent']);
  assert.equal(CLAUDE_SLOTS.includes('fable'), false, 'fable 槽应已移除');
  for (const name of CLAUDE_SLOTS) {
    assert.equal(slotAlias('claude', name), `mixr-${name}`);
    assert.match(CLAUDE_SLOT_ENV[name], /^ANTHROPIC_|^CLAUDE_CODE_/, `${name} 槽的 env 键名`);
  }
  assert.match('worker', CODEX_SLOT_NAME_RE);
  assert.doesNotMatch('Worker', CODEX_SLOT_NAME_RE, 'Codex 槽名只收小写');
});

test('槽位表校验:接受 {provider,model}、pool/strategy,拒绝 fable 与跨组渠道', () => {
  const slots = createSlotTable({
    storeOf: app => providers[app],
    findProvider,
    providerApp: id => groupOf(id),
  });
  assert.equal(slots.validateSlotPut({ claude: { main: { provider: 'p1', model: 'claude-opus-5' } } }), null);
  assert.equal(slots.validateSlotPut({
    claude: { subagent: { provider: 'p1', model: 'claude-sonnet-5', pool: ['p2'], strategy: 'priority' } },
  }), null, '槽位备池形状应被接受');
  assert.match(slots.validateSlotPut({ claude: { fable: { provider: 'p1', model: 'x' } } }), /main \/ opus/);
  assert.match(slots.validateSlotPut({ claude: { main: { provider: 'nope', model: 'x' } } }), /不存在/);
  assert.match(slots.validateSlotPut({ claude: { main: { provider: 'c1', model: 'x' } } }), /Claude 组渠道/);
  assert.match(slots.validateSlotPut({ codex: { worker: { provider: 'p1' } } }), /Codex 组渠道/);
  assert.equal(slots.validateSlotPut({ codex: { main: { provider: 'c1' } } }), null, 'Codex main 槽是合法名字');
  assert.match(slots.validateSlotPut({ claude: { main: { provider: 'p1', strategy: 'nope' } } }), /strategy/);
});

test('槽位解析:别名按槽位表落到「渠道 @ 模型」,不存在的别名返回 null', () => {
  const slots = createSlotTable({
    storeOf: app => providers[app],
    findProvider,
    providerApp: id => groupOf(id),
  });
  const map = {
    claude: { haiku: { provider: 'p1', model: 'claude-sonnet-5' } },
    codex: { worker: { provider: 'c1' } },
  };
  const claude = slots.resolveSlot(map, 'claude', 'mixr-haiku');
  assert.equal(claude.provider.id, 'p1');
  assert.equal(claude.model, 'claude-sonnet-5');
  assert.equal(claude.rule.id, 'slot:claude/haiku');
  assert.equal(claude.rule.strategy, 'round_robin', '没有备池时策略固定为 round_robin');

  const codex = slots.resolveSlot(map, 'codex', 'mixr-worker');
  assert.equal(codex.provider.id, 'c1');
  assert.equal(codex.model, providers.codex.find(p => p.id === 'c1').model, 'Codex 槽用渠道自带模型名');

  assert.equal(slots.resolveSlot(map, 'claude', 'mixr-worker'), null, '别组的槽名不跨组命中');
  assert.equal(slots.resolveSlot(map, 'claude', 'claude-opus-5'), null, '普通模型名不是槽位别名');
});

test('槽位备池:主渠道排在池首,停用的备渠道被跳过', () => {
  const slots = createSlotTable({
    storeOf: app => providers[app],
    findProvider,
    providerApp: id => groupOf(id),
  });
  const map = { claude: { subagent: { provider: 'p1', model: 'm', pool: [{ provider: 'p2' }], strategy: 'priority' } }, codex: {} };
  const hit = slots.resolveSlot(map, 'claude', 'mixr-subagent');
  assert.deepEqual(hit.rule.pool.map(m => m.provider), ['p1', 'p2'], '主渠道必须排在池首,否则 priority 会把备渠道当主选');
  assert.equal(hit.rule.pool[0].model, 'm', '主渠道成员沿用槽位落点模型');
  assert.equal(hit.rule.strategy, 'priority');

  const disabled = providers.claude.map(p => (p.id === 'p2' ? { ...p, enabled: false } : p));
  const table2 = createSlotTable({ storeOf: () => disabled, findProvider: id => disabled.find(p => p.id === id) || null, providerApp: () => 'claude' });
  const hit2 = table2.resolveSlot({ claude: { subagent: { provider: 'p1', model: 'm', pool: [{ provider: 'p2' }] } }, codex: {} }, 'claude', 'mixr-subagent');
  // 备渠道停用后池只剩主渠道:resolveSlot 不再把它当"备池",rule.pool 为空,
  // 主渠道仍由 rule.provider 落地(与没有备池的槽位逐字节相同)。
  assert.deepEqual(hit2.rule.pool, [], '停用的备渠道不进池,只剩主渠道时不是备池');
  assert.equal(hit2.provider.id, 'p1');
  assert.equal(hit2.rule.strategy, 'round_robin');
});

test('示例配置与 README 的「照抄示例」口径一致', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const quick = fs.readFileSync(path.join(ROOT, 'docs/quick-start.md'), 'utf8');
  for (const [file, text] of [['README.md', readme], ['docs/quick-start.md', quick]]) {
    assert.match(text, /providers\.example\.json|示例配置/, `${file} 应指向示例配置`);
    // 可以提到这个命令行参数,但必须同时说明它会被拒绝——不能把它当可用语法教给用户。
    if (text.includes('route codex --slots'))
      assert.match(text, /route codex --slots[\s\S]{0,80}会被(?:直接)?拒绝|没有 `route codex --slots`/,
        `${file} 提到 route codex --slots 时必须说明它不被接受`);
    assert.doesNotMatch(text, /^\.\/mixctl route codex --slots/m, `${file} 不应给出可执行的 route codex --slots 命令`);
  }
});
