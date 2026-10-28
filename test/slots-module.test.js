'use strict';
// 子代理槽位模块(lib/routing/slots.js)的回归。
//
// 本文件**全程纯注入**:不 require mixrouter.js、不起监听、不读真实 slots.json。
// 搬迁等价性(与 mixrouter.js:264-428 原实现逐函数比对)不在本文件里——
// 那需要一份"改动前"的实现,是 /tmp 隔离实验的产物,不属于提交内容。
//
// 模块的关键不变量:**无状态**。槽位表由调用方传入,模块既不持有它也不改它。
// 下面有专门一条断言钉住"传入的 slotMap 一个字节都没变",并用变异验证它真会红。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const slots = require('../lib/routing/slots.js');
const {
  CLAUDE_SLOTS, CLAUDE_SLOT_ENV, CLAUDE_SLOT_KEYS, CODEX_SLOT_NAME_RE,
  slotAlias, normalizeChannelSlots, normalizeSlotsFile, createSlotTable,
} = slots;

// ---------------------------------------------------------------- fixture
const STORE = {
  claude: [
    { id: 'pa', name: '主渠道', models: ['m-first', 'm-second'], model: 'ignored', enabled: true },
    { id: 'pb', name: '备渠道', models: [], enabled: true },
    { id: 'pdead', name: '停用渠道', models: ['x'], enabled: false },
  ],
  codex: [
    { id: 'px', name: 'Codex 渠道', model: 'gpt-5-codex', enabled: true },
    { id: 'pxdead', name: '停用 Codex', model: 'g', enabled: false },
  ],
};

const mkDeps = (over = {}) => {
  const store = over.store || STORE;
  const all = [...store.claude, ...store.codex];
  return {
    storeOf: app => (app === 'codex' ? store.codex : store.claude),
    findProvider: id => all.find(p => p.id === id) || null,
    providerApp: id => store.claude.some(p => p.id === id) ? 'claude'
      : (store.codex.some(p => p.id === id) ? 'codex' : null),
    ...over.deps,
  };
};
const T = (over) => createSlotTable(mkDeps(over));

// 可变槽位表由**调用方**持有(模块无状态),测试里显式构造再传入
const MAP = () => ({
  claude: {
    main: { provider: 'pa', model: 'm-first' },
    opus: { provider: 'pa', model: 'm-second' },
    sonnet: { provider: 'pb', model: 'm-first' },
    haiku: { provider: 'pa', model: 'm-first', dropTools: ['Bash', 'mcp__*'] },
  },
  codex: { worker: { provider: 'px' }, ghost: { provider: 'pdeleted' } },
});

// ---------------------------------------------------------------- 常量表
test('常量表:Claude 五槽与 env 映射一一对应,CLAUDE_SLOT_KEYS 不含 main', () => {
  assert.deepEqual(CLAUDE_SLOTS, ['main', 'opus', 'sonnet', 'haiku', 'subagent']);
  assert.deepEqual(CLAUDE_SLOT_KEYS, ['opus', 'sonnet', 'haiku', 'subagent']);
  // env 映射必须覆盖全部五槽(漏一个,该槽的别名就写不进客户端 env 而静默退化成普通模型名)
  assert.deepEqual(Object.keys(CLAUDE_SLOT_ENV).sort(), [...CLAUDE_SLOTS].sort());
  assert.equal(CLAUDE_SLOT_ENV.subagent, 'CLAUDE_CODE_SUBAGENT_MODEL');
  assert.equal(CLAUDE_SLOT_KEYS.includes('main'), false, 'main 不出现在渠道级映射里');
});

test('Codex 槽名规则:小写字母数字连字符,首字符非连字符,≤24 位', () => {
  for (const ok of ['worker', 'a', 'a1', 'my-worker-2', 'x'.repeat(24)]) assert.equal(CODEX_SLOT_NAME_RE.test(ok), true, ok);
  for (const bad of ['', '-x', 'X', 'a_b', 'a b', 'a'.repeat(25), '中文']) assert.equal(CODEX_SLOT_NAME_RE.test(bad), false, bad);
});

test('slotAlias:固定 mixr- 前缀', () => {
  assert.equal(slotAlias('claude', 'haiku'), 'mixr-haiku');
  assert.equal(slotAlias('codex', 'worker'), 'mixr-worker');
});

// ---------------------------------------------------------------- normalizeSlotsFile
test('normalizeSlotsFile:缺字段回落空对象,非对象同样回落', () => {
  assert.deepEqual(normalizeSlotsFile(null), { claude: {}, codex: {} });
  assert.deepEqual(normalizeSlotsFile({}), { claude: {}, codex: {} });
  assert.deepEqual(normalizeSlotsFile({ claude: { a: 1 }, codex: 'nope' }), { claude: {}, codex: {} });
  assert.deepEqual(normalizeSlotsFile({ claude: ['x'] }), { claude: {}, codex: {} });
});

test('sanitizeClaudeSlots 清除废弃和未知槽,保留备池、策略和剥离规则且不改原对象', () => {
  const main = { provider: 'pa', model: 'm', pool: [{ provider: 'pb' }], strategy: 'priority', dropTools: ['Bash'] };
  const raw = { main, fable: { provider: 'pa' }, bogus: { provider: 'pa' }, haiku: null };
  const before = JSON.stringify(raw);
  const cleaned = slots.sanitizeClaudeSlots(raw);
  assert.deepEqual(cleaned, { main });
  assert.equal(cleaned.main, main);
  assert.equal(JSON.stringify(raw), before);
  const codex = { fable: { provider: 'px' }, worker: { provider: 'px' } };
  const normalized = normalizeSlotsFile({ claude: raw, codex });
  assert.deepEqual(normalized.claude, cleaned);
  assert.equal(normalized.codex, codex, 'Codex 自定义槽保持原样');
  assert.equal(T().resolveSlot(normalized, 'claude', 'mixr-fable'), null);
  assert.match(T().validateSlotPut({ claude: { fable: null } }), /Claude 槽位只能是/);
  for (const input of [null, undefined, 'nope', [], 0]) assert.deepEqual(slots.sanitizeClaudeSlots(input), {});
  assert.deepEqual(slots.sanitizeClaudeSlots(Object.create({ main })), {}, '不采纳继承的槽位');
});

// ---------------------------------------------------------------- normalizeChannelSlots
test('normalizeChannelSlots:只留四个键、trim、空值归一为空串、丢弃未知键', () => {
  const norm = normalizeChannelSlots({ opus: ' a ', sonnet: null, fable: 'f[1M]', extra: 'x' });
  assert.deepEqual(Object.keys(norm), ['opus', 'sonnet', 'haiku', 'subagent']);
  assert.equal(norm.opus, 'a');
  assert.equal(norm.sonnet, '');
  assert.equal('fable' in norm, false);
  assert.equal(norm.subagent, '');
  assert.equal('extra' in norm, false);
  assert.deepEqual(normalizeChannelSlots(undefined), { opus: '', sonnet: '', haiku: '', subagent: '' });
});

test('normalizeChannelSlots:非对象(字符串/数组/数字/布尔)一律报错,不静默清空整组', () => {
  // 这条是防回归的核心:早年的 `typeof slots === 'object' ? slots : {}` 会让 {slots:"nope"}
  // 把该渠道全部槽位一次清空并回 200,用户看不出发生了什么。
  for (const bad of ['nope', [], 42, true, '']) {
    // 空串是 falsy 但不是 undefined/null → 也应报错
    assert.throws(() => normalizeChannelSlots(bad), /slots 必须是对象/, String(bad));
  }
  // null 与 undefined 是"没传",不是"传了坏值" → 回落全空
  assert.doesNotThrow(() => normalizeChannelSlots(null));
});

test('normalizeChannelSlots:键值非字符串/非有限数报错,数字接受并转字符串', () => {
  assert.throws(() => normalizeChannelSlots({ opus: {} }), /slots\.opus 必须是字符串/);
  assert.throws(() => normalizeChannelSlots({ haiku: NaN }), /slots\.haiku 必须是字符串/);
  assert.throws(() => normalizeChannelSlots({ sonnet: Infinity }), /slots\.sonnet 必须是字符串/);
  assert.equal(normalizeChannelSlots({ opus: 42 }).opus, '42');
});

test('normalizeChannelSlots:抛出的错误带 statusCode 400(API 层据此回 400 而非 500)', () => {
  try { normalizeChannelSlots('nope'); assert.fail('应当抛'); }
  catch (e) { assert.equal(e.statusCode, 400); }
});

// ---------------------------------------------------------------- resolveSlot
test('resolveSlot:精确匹配别名才命中,子串/前缀/大写不命中', () => {
  const t = T(); const map = MAP();
  assert.equal(t.resolveSlot(map, 'claude', 'mixr-main').name, 'main');
  // 子串不命中
  assert.equal(t.resolveSlot(map, 'claude', 'claude-mixr-haiku-x'), null);
  assert.equal(t.resolveSlot(map, 'claude', 'mixr-haiku-x'), null);
  assert.equal(t.resolveSlot(map, 'claude', 'mixr'), null);
  // 大小写不敏感(模块内 toLowerCase)
  assert.equal(t.resolveSlot(map, 'claude', 'MIXR-MAIN').name, 'main');
  assert.equal(t.resolveSlot(map, 'claude', '  Mixr-Main  ').name, 'main');
  // 空/非串
  for (const v of [null, undefined, '', 42, {}]) assert.equal(t.resolveSlot(map, 'claude', v), null, String(v));
});

test('resolveSlot:不跨组命中(Claude 槽不会被 codex 请求选中)', () => {
  const t = T(); const map = MAP();
  assert.equal(t.resolveSlot(map, 'codex', 'mixr-main'), null, 'codex 组没有 main 槽');
  assert.equal(t.resolveSlot(map, 'claude', 'mixr-worker'), null, 'claude 组没有 worker 槽');
  assert.equal(t.resolveSlot(map, 'codex', 'mixr-worker').name, 'worker');
});

test('resolveSlot:只认绑了 provider 的槽;未绑定与渠道不存在的槽都跳过', () => {
  const t = T();
  const map = { claude: { main: { provider: '', model: 'm' }, opus: { model: 'm' } }, codex: {} };
  assert.equal(t.resolveSlot(map, 'claude', 'mixr-main'), null, 'provider 为空 → 不算绑定');
  assert.equal(t.resolveSlot(map, 'claude', 'mixr-opus'), null, '没有 provider 字段 → 跳过');
  // 绑了已删除渠道:仍返回结果,但 provider 为 null(转发层会据此报明确错误)
  const gone = { claude: { main: { provider: 'pdeleted', model: 'm' } }, codex: {} };
  const r = t.resolveSlot(gone, 'claude', 'mixr-main');
  assert.equal(r.provider, null);
  assert.equal(r.name, 'main');
});

test('resolveSlot:Claude 落点模型取 s.model,空则回退渠道第一个 models[0]', () => {
  const t = T();
  const withModel = { claude: { opus: { provider: 'pa', model: 'm-second' } }, codex: {} };
  assert.equal(t.resolveSlot(withModel, 'claude', 'mixr-opus').model, 'm-second');
  const noModel = { claude: { opus: { provider: 'pa', model: '' } }, codex: {} };
  assert.equal(t.resolveSlot(noModel, 'claude', 'mixr-opus').model, 'm-first', '空 → 渠道第一个模型');
  const undef = { claude: { opus: { provider: 'pa' } }, codex: {} };
  assert.equal(t.resolveSlot(undef, 'claude', 'mixr-opus').model, 'm-first');
  const noModels = { claude: { opus: { provider: 'pb', model: '' } }, codex: {} };
  assert.equal(t.resolveSlot(noModels, 'claude', 'mixr-opus').model, '', '渠道没有 models → 空串');
});

test('resolveSlot:同一 Codex 渠道的槽可选不同模型,省略或空串继承渠道默认', () => {
  const t = T();
  const map = { claude: {}, codex: {
    main: { provider: 'px', model: 'custom-main' },
    reviewer: { provider: 'px', model: 'custom-review' },
    worker: { provider: 'px' }, empty: { provider: 'px', model: '' },
  } };
  for (const [name, model] of [['main', 'custom-main'], ['reviewer', 'custom-review'],
    ['worker', 'gpt-5-codex'], ['empty', 'gpt-5-codex']]) {
    const resolved = t.resolveSlot(map, 'codex', 'mixr-' + name);
    assert.equal(resolved.model, model);
    assert.equal(resolved.rule.model, model, '规则必须携带同一个落点,供实际转发使用');
  }
  const store = { claude: [], codex: [{ ...STORE.codex[0], model: 'changed-default' }] };
  assert.equal(T({ store }).resolveSlot(map, 'codex', 'mixr-main').model, 'custom-main');
  assert.equal(T({ store }).resolveSlot(map, 'codex', 'mixr-worker').model, 'changed-default');
});

test('resolveSlot:Codex 备池主渠道用槽模型,备渠道继承槽模型或自己的显式覆盖', () => {
  const store = { claude: [], codex: [STORE.codex[0], STORE.codex[1],
    { id: 'backup', model: 'backup-default', enabled: true }, { id: 'custom', model: 'other-default', enabled: true }] };
  const map = { codex: { worker: { provider: 'px', model: 'slot-model',
    pool: ['backup', { provider: 'custom', model: 'backup-model' }, 'pxdead'], strategy: 'priority' } } };
  const resolved = T({ store }).resolveSlot(map, 'codex', 'mixr-worker');
  assert.deepEqual(resolved.rule.pool, [
    { provider: 'px', model: 'slot-model' }, { provider: 'backup', model: 'slot-model' },
    { provider: 'custom', model: 'backup-model' },
  ]);
  assert.equal(resolved.rule.strategy, 'priority');
});

test('resolveSlot:返回的 rule 形状固定(转发层依赖它)' , () => {
  const t = T(); const map = MAP();
  const r = t.resolveSlot(map, 'claude', 'mixr-opus');
  assert.deepEqual(r.rule, {
    id: 'slot:claude/opus', match: 'mixr-opus', provider: 'pa', model: 'm-second',
    pool: [], strategy: 'round_robin', priority: 1000, app: 'claude', when: {}, enabled: true,
  });
  // priority 1000 是"槽位压过一切规则"的实现手段,不能降
  assert.ok(r.rule.priority > 100);
});

test('resolveSlot:空槽位表 / 缺组 / undefined 表都不抛', () => {
  const t = T();
  for (const map of [{}, { claude: {} }, { claude: {}, codex: {} }, undefined, null]) {
    assert.equal(t.resolveSlot(map, 'claude', 'mixr-main'), null, JSON.stringify(map));
    assert.equal(t.resolveSlot(map, 'codex', 'mixr-worker'), null, JSON.stringify(map));
  }
});

// ---------------------------------------------------------------- validateSlotPut
test('validateSlotPut:合法入参返回 null(含 null 删除、codex 合法名、dropTools)', () => {
  const v = T().validateSlotPut;
  assert.equal(v({}), null);
  assert.equal(v({ claude: {} }), null);
  assert.equal(v({ claude: { opus: null } }), null, 'null = 删除该槽,合法');
  assert.equal(v({ claude: { opus: { provider: 'pa', model: 'm' } } }), null);
  assert.equal(v({ claude: { opus: { provider: 'pa', model: 'm', dropTools: ['Bash', 'mcp__*'] } } }), null);
  assert.equal(v({ claude: { opus: { provider: 'pa', model: 'm', dropTools: [] } } }), null, '空数组合法');
  assert.equal(v({ codex: { worker: { provider: 'px' } } }), null);
});

test('validateSlotPut:Claude 槽名白名单外的名字报错', () => {
  const v = T().validateSlotPut;
  assert.match(v({ claude: { nope: { provider: 'pa', model: 'm' } } }), /Claude 槽位只能是/);
  // main 在白名单里(与渠道级 CLAUDE_SLOT_KEYS 不同)
  assert.equal(v({ claude: { main: { provider: 'pa', model: 'm' } } }), null);
});

test('validateSlotPut:Codex 槽名不合规报错,组别串用报错', () => {
  const v = T().validateSlotPut;
  assert.match(v({ codex: { 'Bad_Name': { provider: 'px' } } }), /Codex 槽位名/);
  assert.match(v({ codex: { main: { provider: 'pa' } } }), /绑定的渠道不存在/, 'pa 是 claude 组渠道');
  assert.match(v({ claude: { opus: { provider: 'px', model: 'm' } } }), /绑定的渠道不存在/, 'px 是 codex 组渠道');
});

test('validateSlotPut:形状错误逐条报(非对象组/非对象值/缺 provider/非串 provider/非串 model)', () => {
  const v = T().validateSlotPut;
  assert.match(v({ claude: 'nope' }), /claude 槽位必须是对象/);
  assert.match(v({ codex: [] }), /codex 槽位必须是对象/);
  assert.match(v({ claude: { opus: 'nope' } }), /必须是 \{provider, model\} 或 null/);
  assert.match(v({ claude: { opus: { model: 'm' } } }), /必须是 \{provider, model\} 或 null/);
  assert.match(v({ claude: { opus: { provider: 42, model: 'm' } } }), /必须是 \{provider, model\} 或 null/);
  assert.match(v({ claude: { opus: { provider: 'pa', model: 42 } } }), /model 必须是字符串/);
  for (const app of ['claude', 'codex']) {
    const name = app === 'claude' ? 'opus' : 'worker';
    const provider = app === 'claude' ? 'pa' : 'px';
    for (const model of [null, 0, false, [], {}]) {
      assert.match(v({ [app]: { [name]: { provider, model } } }), /model 必须是字符串/);
    }
    for (const model of ['', 'custom-model']) assert.equal(v({ [app]: { [name]: { provider, model } } }), null);
    assert.equal(v({ [app]: { [name]: { provider } } }), null, '省略模型继承默认,不是坏值');
  }
});

test('validateSlotPut:dropTools 只接受非空字符串数组(坏值会静默失效,必须拦在入口)', () => {
  const v = T().validateSlotPut;
  assert.match(v({ claude: { opus: { provider: 'pa', model: 'm', dropTools: 'Bash' } } }), /dropTools 必须是非空字符串数组/);
  assert.match(v({ claude: { opus: { provider: 'pa', model: 'm', dropTools: [''] } } }), /dropTools 必须是非空字符串数组/);
  assert.match(v({ claude: { opus: { provider: 'pa', model: 'm', dropTools: ['  '] } } }), /dropTools 必须是非空字符串数组/);
  assert.match(v({ claude: { opus: { provider: 'pa', model: 'm', dropTools: [1] } } }), /dropTools 必须是非空字符串数组/);
  assert.match(v({ claude: { opus: { provider: 'pa', model: 'm', dropTools: null } } }), /dropTools 必须是非空字符串数组/);
});

test('validateSlotPut:绑到已停用渠道是允许的(停用由转发层给出明确错误,不在写入时拦)', () => {
  // 这是**刻意**的:写入时渠道可能临时停用,拦掉会让用户无法预先配置。
  assert.equal(T().validateSlotPut({ claude: { opus: { provider: 'pdead', model: 'm' } } }), null);
});

// ---------------------------------------------------------------- claudeSplitPatch
test('claudeSplitPatch:给了 main → 五个槽全指向该主槽', () => {
  const p = T().claudeSplitPatch(MAP(), { main: { provider: 'pa', model: 'm-main' }, subagent: { provider: 'pb', model: 'x' } });
  assert.deepEqual(Object.keys(p).sort(), [...CLAUDE_SLOTS].sort());
  assert.deepEqual(p.main, { provider: 'pa', model: 'm-main' });
  assert.deepEqual(p.subagent, { provider: 'pb', model: 'x' });
  assert.deepEqual(p.opus, p.main, '非 subagent 槽跟 main');
  // ⚠ haiku **不**等于 p.main:它原有 dropTools 会被保留(2026-09-20 起)。
  // 整体替换会把用户配好的剥离规则静默抹掉——打上去才发现工具没剥,所以要分开断言。
  assert.deepEqual(p.haiku, { ...p.main, dropTools: ['Bash', 'mcp__*'] },
    'haiku 跟 main 的 provider/model,但保留自己原有的 dropTools');
  assert.deepEqual(Object.keys(p).filter(n => p[n].dropTools), ['haiku'],
    '只有原本配了 dropTools 的槽带它,别的槽不许凭空长出来');
});

test('claudeSplitPatch:换主槽时保留各槽原有备池,但换了落点模型就丢弃', () => {
  const t = T();
  const pool = [{ provider: 'pb', model: 'm-main' }];
  const base = { claude: { ...MAP().claude, opus: { provider: 'pa', model: 'm-first', pool, strategy: 'priority' } }, codex: {} };
  // 落点模型没变 → 备池与策略都保留(整体替换会让备池静默消失,402 时才发现)
  const same = t.claudeSplitPatch(base, { main: { provider: 'pa', model: 'm-first' }, subagent: { provider: 'pb', model: 'x' } });
  assert.deepEqual(same.opus.pool, pool, '同落点模型时备池必须保留');
  assert.equal(same.opus.strategy, 'priority', '策略跟着备池一起保留');
  // 换了落点模型 → 旧备池配的就是别的模型,必须丢弃(否则会拿错模型打备渠道)
  const changed = t.claudeSplitPatch(base, { main: { provider: 'pa', model: 'm-OTHER' }, subagent: { provider: 'pb', model: 'x' } });
  assert.equal(changed.opus.pool, undefined, '落点模型变了,旧备池不该跟过来');
  assert.equal(changed.opus.strategy, undefined);
  assert.equal(changed.opus.model, 'm-OTHER');
});

test('claudeSplitPatch:不给 main 时要求现有固定槽已统一,否则报错', () => {
  const t = T();
  // MAP() 的固定槽不统一(sonnet 指向 pb) → 应报错
  assert.throws(() => t.claudeSplitPatch(MAP(), { subagent: { provider: 'pb', model: 'x' } }),
    /请先指定 main 建立统一主槽/);
  // 统一时通过,且只改 subagent
  const unified = { claude: Object.fromEntries(CLAUDE_SLOTS.filter(n => n !== 'subagent').map(n => [n, { provider: 'pa', model: 'm' }])), codex: {} };
  const p = t.claudeSplitPatch(unified, { subagent: { provider: 'pb', model: 'x' } });
  assert.deepEqual(Object.keys(p), ['subagent'], '只返回 subagent 一项');
  assert.deepEqual(p.subagent, { provider: 'pb', model: 'x' });
});

test('claudeSplitPatch:main 缺失但固定槽有空缺 / 缺 model 也报错', () => {
  const t = T();
  const mk = (fill) => ({ claude: Object.fromEntries(CLAUDE_SLOTS.filter(n => n !== 'subagent').map(n => [n, fill])), codex: {} });
  assert.throws(() => t.claudeSplitPatch(mk(undefined), { subagent: { provider: 'pb', model: 'x' } }), /请先指定 main/);
  assert.throws(() => t.claudeSplitPatch(mk({ provider: 'pa', model: '' }), { subagent: { provider: 'pb', model: 'x' } }), /请先指定 main/);
});

test('claudeSplitPatch:target 校验(缺字段/空 model/非对象/渠道不存在/渠道停用)', () => {
  const t = T(); const map = MAP();
  const bad = (body) => assert.throws(() => t.claudeSplitPatch(map, body), /必须指定 provider 和 model|必须选择已启用的/);
  bad({ main: { provider: 'pa' }, subagent: { provider: 'pb', model: 'x' } });
  bad({ main: { provider: 'pa', model: '   ' }, subagent: { provider: 'pb', model: 'x' } });
  bad({ main: { provider: 'pa', model: 1 }, subagent: { provider: 'pb', model: 'x' } });
  bad({ main: null, subagent: { provider: 'pb', model: 'x' } });
  bad({ main: { provider: 'nosuch', model: 'm' }, subagent: { provider: 'pb', model: 'x' } });
  bad({ main: { provider: 'pdead', model: 'm' }, subagent: { provider: 'pb', model: 'x' } });
  // subagent 侧同样校验
  assert.throws(() => t.claudeSplitPatch(map, { main: { provider: 'pa', model: 'm' }, subagent: { provider: 'pdead', model: 'x' } }),
    /必须选择已启用的/);
});

test('claudeSplitPatch:model 两端 trim,apply 非布尔报错', () => {
  const t = T(); const map = MAP();
  const p = t.claudeSplitPatch(map, { main: { provider: 'pa', model: '  m  ' }, subagent: { provider: 'pb', model: ' x ' } });
  assert.equal(p.main.model, 'm');
  assert.equal(p.subagent.model, 'x');
  assert.throws(() => t.claudeSplitPatch(map, { apply: 'yes', main: { provider: 'pa', model: 'm' }, subagent: { provider: 'pb', model: 'x' } }),
    /apply 必须是布尔值/);
  // 抛出的错误带 statusCode 400
  try { t.claudeSplitPatch(map, { apply: 'yes', main: { provider: 'pa', model: 'm' }, subagent: { provider: 'pb', model: 'x' } }); }
  catch (e) { assert.equal(e.statusCode, 400); }
});

test('claudeSplitPatch:不返回 apply 字段(编排与落盘由调用方负责)', () => {
  const p = T().claudeSplitPatch(MAP(), { apply: true, main: { provider: 'pa', model: 'm' }, subagent: { provider: 'pb', model: 'x' } });
  assert.equal('apply' in p, false);
});

// ---------------------------------------------------------------- slotsPublic
test('slotsPublic:Claude 恒返回五槽(未绑的也在),Codex 只返回已绑定的', () => {
  const pub = T().slotsPublic(MAP());
  assert.equal(pub.claude.length, CLAUDE_SLOTS.length);
  assert.deepEqual(pub.claude.map(e => e.name), CLAUDE_SLOTS);
  assert.deepEqual(pub.codex.map(e => e.name), ['worker', 'ghost']);
  // 未绑定的槽:provider 空、enabled false、model 空
  const unbound = pub.claude.find(e => e.name === 'subagent');
  assert.equal(unbound.provider, '');
  assert.equal(unbound.enabled, false);
  assert.equal(unbound.model, '');
});

test('slotsPublic:alias/env/provider_name/停用状态逐条正确', () => {
  const pub = T().slotsPublic(MAP());
  const haiku = pub.claude.find(e => e.name === 'haiku');
  assert.equal(haiku.alias, 'mixr-haiku');
  assert.equal(haiku.env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL');
  assert.equal(haiku.provider_name, '主渠道');
  assert.equal(haiku.enabled, true);
  assert.deepEqual(haiku.dropTools, ['Bash', 'mcp__*']);
  // 未绑槽的 env 仍要给出(UI 靠它展示)
  assert.equal(pub.claude.find(e => e.name === 'subagent').env, 'CLAUDE_CODE_SUBAGENT_MODEL');
  // codex 槽 env 恒为空
  assert.equal(pub.codex.every(e => e.env === ''), true);
});

test('slotsPublic:绑到已删渠道 → provider 名空、enabled false,但仍列出(让 UI 能显示脏绑定)', () => {
  const pub = T().slotsPublic(MAP());
  const ghost = pub.codex.find(e => e.name === 'ghost');
  assert.equal(ghost.provider, 'pdeleted');
  assert.equal(ghost.provider_name, '');
  assert.equal(ghost.enabled, false);
});

test('slotsPublic:绑到存在但已停用的渠道 → enabled false,但 provider 与渠道名照给(停用≠已删)', () => {
  // 覆盖缺口:接线后的反证里,把 `enabled: !!p && p.enabled !== false` 改成 `enabled: !!p`
  // (丢掉"渠道停用"这一维)时,9 个测试文件 195 条测试全绿——这条行为此前零覆盖。
  // 它和上一条"已删渠道"是**两种不同的脏状态**,别混:
  //   已删(pdeleted):findProvider 返回 null → provider_name 空、model 回退到槽里存的值;
  //   停用(pdead)  :渠道还在,名字/模型都能取到,只有 enabled 这一维要说 false。
  // 把两者混成一条断言,就只能测出"有个东西是 false",测不出是哪一维在起作用。
  const pub = T().slotsPublic({ claude: { haiku: { provider: 'pdead', model: 'm-off' } }, codex: {} });
  const haiku = pub.claude.find(e => e.name === 'haiku');
  assert.equal(haiku.enabled, false, '停用渠道上的槽必须报 enabled:false');
  // 仍被列出、且渠道身份信息完整(别和"已删"混同)
  assert.equal(haiku.provider, 'pdead');
  assert.equal(haiku.provider_name, '停用渠道', '渠道还在,名字必须取得到');
  assert.equal(haiku.alias, 'mixr-haiku');
  assert.equal(haiku.model, 'm-off');
  // 反证:同一次调用里,绑在**启用**渠道上的槽必须是 enabled:true——
  // 否则上面那条可能只是"整个字段恒 false",压根没在区分渠道状态
  const mixed = T().slotsPublic({ claude: { haiku: { provider: 'pdead', model: 'm-off' },
                                            main: { provider: 'pa', model: 'm-first' } }, codex: {} });
  assert.equal(mixed.claude.find(e => e.name === 'haiku').enabled, false);
  assert.equal(mixed.claude.find(e => e.name === 'main').enabled, true, '反证失败:启用渠道的槽本该 true');
  // codex 组同样遵守(夹具里 pxdead 是停用的 Codex 渠道)
  const cx = T().slotsPublic({ claude: {}, codex: { worker: { provider: 'pxdead' } } });
  assert.equal(cx.codex.find(e => e.name === 'worker').enabled, false);
  assert.equal(cx.codex.find(e => e.name === 'worker').provider_name, '停用 Codex');
});

test('slotsPublic:codex 表里的空条目(null/undefined/空串)被过滤掉,不产出空槽', () => {
  // 变异验证时发现的覆盖缺口:原实现的 `filter(n => slotMap.codex[n])` 防的是
  // slots.json 被手工改坏/留下 {worker: null} 这种空条目。没有这条断言时,
  // 把 filter 整个删掉测试仍全绿——即那个守卫从来没被测过。
  const map = { claude: {}, codex: { worker: { provider: 'px' }, empty: null, undef: undefined, blank: '', zero: 0 } };
  const pub = T().slotsPublic(map);
  assert.deepEqual(pub.codex.map(e => e.name), ['worker'], '只保留真值条目');
});

test('slotsPublic:dropTools 缺省为空数组(不是 undefined,UI 直接 map 它)', () => {
  const pub = T().slotsPublic(MAP());
  assert.deepEqual(pub.claude.find(e => e.name === 'main').dropTools, []);
  assert.deepEqual(pub.codex.find(e => e.name === 'worker').dropTools, []);
});

test('slotsPublic:有效模型与显式覆盖分开返回,两组都能继承渠道默认', () => {
  const t = T();
  const map = { claude: { main: { provider: 'pa' }, opus: { provider: 'pa', model: 'm-second' } },
    codex: { main: { provider: 'px', model: 'custom-model' }, worker: { provider: 'px', model: '' },
      ghost: { provider: 'gone', model: 'kept-model' } } };
  const pub = t.slotsPublic(map);
  for (const [app, name, model, configured] of [
    ['claude', 'main', 'm-first', ''], ['claude', 'opus', 'm-second', 'm-second'],
    ['claude', 'subagent', '', ''], ['codex', 'main', 'custom-model', 'custom-model'],
    ['codex', 'worker', 'gpt-5-codex', ''], ['codex', 'ghost', 'kept-model', 'kept-model'],
  ]) {
    const slot = pub[app].find(item => item.name === name);
    assert.equal(slot.model, model);
    assert.equal(slot.configured_model, configured);
    if (slot.provider) assert.equal(t.resolveSlot(map, app, slot.alias).model, slot.model, '公开落点必须与实际解析一致');
  }
});

test('slotsPublic:空表/undefined 不抛,仍返回五个 Claude 槽', () => {
  for (const map of [{}, { claude: {} }, undefined, null]) {
    const pub = T().slotsPublic(map);
    assert.equal(pub.claude.length, 5);
    assert.deepEqual(pub.codex, []);
  }
});

// ---------------------------------------------------------------- 无状态(核心不变量)
test('无状态:传入的 slotMap 在全部读路径上逐字节不变', () => {
  const t = T();
  const map = MAP();
  const before = JSON.stringify(map);
  t.resolveSlot(map, 'claude', 'mixr-main');
  t.resolveSlot(map, 'codex', 'mixr-worker');
  t.validateSlotPut({ claude: { opus: { provider: 'pa', model: 'm' } } });
  t.slotsPublic(map);
  assert.equal(JSON.stringify(map), before, '槽位表不得被改写');

  // 反证:上面那条不是"压根没走到代码"——同一批调用确实读到了值
  assert.equal(t.resolveSlot(map, 'claude', 'mixr-main').name, 'main', '反证失败:本应命中');
  assert.equal(t.slotsPublic(map).claude.length, 5);
});

test('无状态:claudeSplitPatch 不改传入的槽位表,只返回补丁', () => {
  const t = T();
  const map = MAP();
  const before = JSON.stringify(map);
  t.claudeSplitPatch(map, { main: { provider: 'pa', model: 'm' }, subagent: { provider: 'pb', model: 'x' } });
  assert.equal(JSON.stringify(map), before, 'claudeSplitPatch 必须是纯函数');
});

test('无状态:两个 createSlotTable 实例互不共享任何状态', () => {
  const a = T(); const b = T();
  const map = MAP();
  assert.equal(a.resolveSlot(map, 'claude', 'mixr-main').name, 'main');
  assert.equal(b.resolveSlot(map, 'claude', 'mixr-main').name, 'main');
  // 不同 deps 的实例按各自渠道表解析(证明没有模块级缓存)
  const other = createSlotTable(mkDeps({ store: { claude: [{ id: 'pa', name: '别的', models: ['ZZZ'], enabled: true }], codex: [] } }));
  assert.equal(other.slotsPublic(map).claude.find(e => e.name === 'opus').model, 'm-second', '槽里写的不受渠道影响');
  assert.equal(other.slotsPublic({ claude: { opus: { provider: 'pa', model: '' } }, codex: {} }).claude.find(e => e.name === 'opus').model, 'ZZZ');
});

// ---------------------------------------------------------------- 无 I/O
test('无 I/O:模块不 require 网络/文件模块,不读环境变量', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/routing/slots.js'), 'utf8');
  for (const bad of ['fs', 'http', 'https', 'net', 'node:fs', 'path', 'os']) {
    assert.equal(new RegExp(`require\\(['"](node:)?${bad}['"]\\)`).test(src), false, `不该 require ${bad}`);
  }
  assert.equal(/process\.env/.test(src), false, '不该读环境变量');
  // 只允许 require 叶子模块。白名单**逐项列全**,新增一项必须在这里显式登记:
  //   ../validation —— 类型判断工具(invalid/isObject)。原先长在 zcode-config 里,
  //                   ZCode 接入移除后搬到通用模块,槽位校验继续用同一份。
  //   ./strategy    —— 取 STRATEGIES 白名单校验槽位 strategy。它自身**零 require**,
  //                   是纯函数叶子,不违反本用例要防的"模块偷偷做 I/O"。
  //                   (2026-09-20 加入:校验收到的 strategy 必须是真策略名,抄一份常量会与真值漂移)
  const reqs = [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)].map(m => m[2]);
  assert.deepEqual(reqs, ['../validation', './strategy'], 'require 清单变了就必须显式登记');
  // 逐个核白名单里的模块本身也是叶子:否则"间接 I/O"会绕过上面所有断言
  for (const m of ['../lib/routing/strategy.js', '../lib/validation.js']) {
    const leaf = require('node:fs').readFileSync(require.resolve(m), 'utf8');
    assert.equal(/require\(/.test(leaf), false, `${m} 必须零 require`);
  }
});

test('无 I/O:require 本模块不产生副作用(不抛、导出齐全、无计时器)', () => {
  const before = process._getActiveHandles ? process._getActiveHandles().length : 0;
  delete require.cache[require.resolve('../lib/routing/slots.js')];
  const fresh = require('../lib/routing/slots.js');
  const after = process._getActiveHandles ? process._getActiveHandles().length : 0;
  assert.equal(after > before, false, 'require 不应新增活动句柄(timer/socket)');
  for (const k of ['CLAUDE_SLOTS', 'CLAUDE_SLOT_ENV', 'CLAUDE_SLOT_KEYS', 'CODEX_SLOT_NAME_RE',
    'slotAlias', 'normalizeChannelSlots', 'normalizeSlotsFile', 'createSlotTable']) {
    assert.ok(k in fresh, `缺导出 ${k}`);
  }
});
