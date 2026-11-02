'use strict';
// 模型方案领域层:快照、预览、应用、删除、损坏文件保护、不泄密。全部在临时目录,不碰真实配置。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profiles = require('../lib/route-profiles');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-route-profiles-'));
let seq = 0;
const tmpFile = () => path.join(DIR, `profiles-${++seq}.json`);

// 渠道表:claude 组有 p1 / p2,codex 组有 c1;另有一个停用渠道 off 与重复 id dup。
const store = () => ({
  claude: [
    { id: 'p1', name: 'Primary', enabled: true, models: ['model-a'] },
    { id: 'p2', name: 'Backup', enabled: true, models: ['model-b'] },
    { id: 'off', name: 'Off', enabled: false },
    { id: 'dup', name: 'Dup A', enabled: true },
    { id: 'dup', name: 'Dup B', enabled: true },
  ],
  codex: [{ id: 'c1', name: 'Codex One', enabled: true, model: 'gpt-x' }],
});
const storeOf = app => store()[app] || [];

// 简化版 validateSlotPut:只查渠道归属与 pool/strategy 形状,足以证明接线。
const validateSlotPut = body => {
  for (const [app, group] of Object.entries(body)) {
    for (const [name, slot] of Object.entries(group)) {
      if (app === 'claude' && !['main', 'opus', 'sonnet', 'haiku', 'subagent'].includes(name))
        return `Claude 槽位名无效: ${name}`;
      if (!storeOf(app).some(provider => provider.id === slot.provider))
        return `槽位 "${name}" 绑定的渠道不存在`;
      if (!Array.isArray(slot.pool || []))
        return `槽位 "${name}" 的 pool 必须是数组`;
      for (const member of slot.pool || []) {
        const id = typeof member === 'string' ? member : member.provider;
        if (!storeOf(app).some(provider => provider.id === id))
          return `槽位 "${name}" 的后备渠道 ${id} 不是本组渠道`;
      }
      if (slot.strategy !== undefined && !['round_robin', 'weighted', 'least_used', 'random', 'priority'].includes(slot.strategy))
        return `槽位 "${name}" 的 strategy 无效`;
    }
  }
  return null;
};

// 真实槽位表形状:claude 五个槽 + codex 自定义槽,带 pool / strategy / dropTools。
const slotMap = () => ({
  claude: {
    main: { provider: 'p1', model: 'model-a', pool: [{ provider: 'p2', model: 'model-b' }], strategy: 'priority', dropTools: ['mcp__*'] },
    opus: { provider: 'p1', model: 'model-a' },
    sonnet: { provider: 'p2', model: 'model-b' },
    haiku: { provider: 'p2', model: 'model-b' },
  },
  codex: { main: { provider: 'c1', model: 'gpt-x' }, worker: { provider: 'c1', model: 'gpt-x' } },
});
let applied = 0;
let lastApplied = null;
const applySlots = next => { applied++; lastApplied = next; };
const resetApply = () => { applied = 0; lastApplied = null; };
const deps = () => ({ storeOf, validateSlotPut, applySlots });

const create = (file, name, apps, map = slotMap()) =>
  profiles.createProfile(file, map, { name, apps, expected_revision: profiles.readProfiles(file).revision });
const preview = (file, map, id) => profiles.previewProfile(file, map, id, storeOf, validateSlotPut);

test('无文件:空表、不写盘;GET 与预览都不创建 profiles.json', () => {
  const file = tmpFile();
  const listed = profiles.listProfiles(file, slotMap());
  assert.deepEqual(listed.profiles, []);
  assert.match(listed.revision, /^[a-f0-9]{64}$/);
  assert.match(listed.slots_revision, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(file), false, 'GET 不应创建配置');
  // 预览/应用一个不存在的方案只报 404,同样不写盘。
  assert.throws(() => preview(file, slotMap(), '00000000-0000-4000-8000-000000000000'), { statusCode: 404 });
  assert.equal(fs.existsSync(file), false);
});

test('保存快照保留原始槽位字段(pool/strategy/dropTools),不写盘外内容且 0600', () => {
  const file = tmpFile();
  const map = slotMap();
  const saved = create(file, '日常', ['claude', 'codex'], map);
  assert.equal(saved.profiles.length, 1);
  const row = saved.profiles[0];
  assert.deepEqual(row.apps, ['claude', 'codex']);
  assert.equal(row.active, true, '刚保存的快照就是当前槽位');
  assert.match(row.id, /^[0-9a-f-]{36}$/);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.version, 1);
  assert.deepEqual(Object.keys(stored.profiles[0]).sort(), ['apps', 'created_at', 'id', 'name', 'slots']);
  assert.deepEqual(stored.profiles[0].slots.claude.main, map.claude.main, 'pool/strategy/dropTools 原样保存');
  assert.deepEqual(stored.profiles[0].slots.codex, map.codex);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // 快照不是活槽位的别名:改活槽位不影响已保存方案。
  map.claude.main.model = 'changed';
  assert.equal(profiles.readProfiles(file).profiles[0].slots.claude.main.model, 'model-a');
});

test('只存选定客户端:claude 方案不含 codex 槽位,反之亦然', () => {
  const file = tmpFile();
  const saved = create(file, '只有 Claude', ['claude']);
  assert.deepEqual(saved.profiles[0].apps, ['claude']);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(stored.profiles[0].slots), ['claude']);
  assert.equal(stored.profiles[0].slots.codex, undefined);
});

test('active 按当前原始槽位实时计算,不是保存时的标记', () => {
  const file = tmpFile();
  const map = slotMap();
  const saved = create(file, '方案 A', ['claude'], map);
  const id = saved.profiles[0].id;
  assert.equal(profiles.listProfiles(file, map).profiles[0].active, true);
  const changed = slotMap();
  changed.claude.opus.model = 'model-b';
  assert.equal(profiles.listProfiles(file, changed).profiles[0].active, false, '任一槽位不同即不 active');
  // 方案范围外(codex)的变化不影响 claude 方案的 active。
  const codexChanged = slotMap();
  codexChanged.codex.worker.model = 'gpt-y';
  assert.equal(profiles.listProfiles(file, codexChanged).profiles[0].active, true);
  // 键顺序变化不算变化。
  const reordered = slotMap();
  reordered.claude.opus = { model: 'model-a', provider: 'p1' };
  assert.equal(profiles.listProfiles(file, reordered).profiles[0].active, true);
  assert.ok(id);
});

test('预览:before/after 只含差异,包含删除与新增槽位,null 表示该侧不存在', () => {
  resetApply();
  const file = tmpFile();
  const saved = create(file, '旧方案', ['claude', 'codex']);
  const id = saved.profiles[0].id;
  const current = slotMap();
  current.claude.opus = { provider: 'p2', model: 'model-b' };   // 改成别的模型
  delete current.claude.haiku;                                    // 方案里还有,活槽位没有 → 新增
  current.claude.subagent = { provider: 'p1', model: 'model-a' }; // 活槽位有,方案没有 → 删除
  const result = preview(file, current, id);
  const bySlot = Object.fromEntries(result.changes.map(change => [`${change.app}/${change.slot}`, change]));
  assert.deepEqual(Object.keys(bySlot).sort(), ['claude/haiku', 'claude/opus', 'claude/subagent']);
  assert.deepEqual(bySlot['claude/opus'].before, { provider: 'p2', model: 'model-b' });
  assert.deepEqual(bySlot['claude/opus'].after, { provider: 'p1', model: 'model-a' });
  assert.equal(bySlot['claude/haiku'].before, null);
  assert.deepEqual(bySlot['claude/haiku'].after, { provider: 'p2', model: 'model-b' });
  assert.equal(bySlot['claude/subagent'].after, null);
  assert.equal(result.can_apply, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.expected_revision, profiles.readProfiles(file).revision);
  assert.equal(result.slots_revision, profiles.slotsRevision(current));
  // 预览只读:没有调用 applySlots,文件 revision 不变。
  assert.equal(applied, 0);
  assert.equal(profiles.readProfiles(file).revision, saved.revision);
});

test('预览与列表不修改活槽位(对象引用与内容都不变)', () => {
  const file = tmpFile();
  const saved = create(file, '方案', ['claude', 'codex']);
  const map = slotMap();
  const snapshot = JSON.stringify(map);
  const beforeKeys = Object.keys(map.claude).sort();
  preview(file, map, saved.profiles[0].id);
  profiles.listProfiles(file, map);
  assert.equal(JSON.stringify(map), snapshot);
  assert.deepEqual(Object.keys(map.claude).sort(), beforeKeys);
});

test('预览点名删除/停用渠道、失效后备引用与重复渠道,不静默过滤', () => {
  const file = tmpFile();
  const saved = create(file, '含备池', ['claude']);
  const id = saved.profiles[0].id;
  // 直接构造目标:把方案里的 main 指向停用渠道,pool 指向已删除渠道。
  const written = profiles.readProfiles(file);
  written.profiles[0].slots.claude.main = {
    provider: 'off', model: 'model-a',
    pool: [{ provider: 'gone' }, { provider: 'dup' }], strategy: 'priority',
  };
  written.profiles[0].slots.claude.opus = { provider: 'dup', model: 'model-a' };
  profiles.writeProfiles(file, written.profiles);
  const result = preview(file, slotMap(), id);
  assert.equal(result.can_apply, false);
  const text = result.warnings.join('\n');
  assert.match(text, /渠道 "off" 已停用/);
  assert.match(text, /后备渠道 "gone" 不在当前组或已删除/);
  assert.match(text, /后备渠道 "dup" 在同一组内重复/);
  assert.match(text, /渠道 "dup" 在同一组内重复/);
});

test('应用:只替换方案范围,先校验两份 revision,提交给 applySlots 的是完整槽位表副本', () => {
  resetApply();
  const file = tmpFile();
  const saved = create(file, '切回 A', ['claude']);
  const id = saved.profiles[0].id;
  const map = slotMap();
  map.claude.main.model = 'drifted';
  map.codex.worker.model = 'gpt-kept';
  const result = profiles.applyProfile(file, map, id, {
    confirm: true, expected_revision: saved.revision, slots_revision: profiles.slotsRevision(map),
  }, deps());
  assert.deepEqual(result, { ok: true, id, name: '切回 A', apps: ['claude'] });
  assert.equal(applied, 1);
  // claude 组替换成方案快照;codex 组原样保留。
  assert.deepEqual(lastApplied.claude, profiles.readProfiles(file).profiles[0].slots.claude);
  assert.equal(lastApplied.codex.worker.model, 'gpt-kept');
  // 传给 applySlots 的是副本:改它不会改到活槽位。
  assert.notEqual(lastApplied, map);
  assert.equal(map.claude.main.model, 'drifted');
  // 应用不改文件。
  assert.equal(profiles.readProfiles(file).revision, saved.revision);
});

test('应用拒绝过期 revision、缺 confirm 与带警告的目标,且不调用 applySlots', () => {
  resetApply();
  const file = tmpFile();
  const saved = create(file, '方案', ['claude']);
  const id = saved.profiles[0].id;
  const map = slotMap();
  const slotsRev = profiles.slotsRevision(map);
  for (const patch of [
    { confirm: false },
    { expected_revision: 'stale' },
    { slots_revision: 'stale' },
  ]) {
    assert.throws(() => profiles.applyProfile(file, map, id,
      { confirm: true, expected_revision: saved.revision, slots_revision: slotsRev, ...patch }, deps()),
      error => error.statusCode === (patch.expected_revision || patch.slots_revision ? 409 : 400));
  }
  // 方案配置本身变化(另一个方案被删除)后旧 revision 失效。
  const other = create(file, '另一个', ['codex']);
  profiles.deleteProfile(file, other.profiles[1].id, {
    confirm: true, expected_revision: profiles.readProfiles(file).revision,
  });
  assert.throws(() => profiles.applyProfile(file, map, id, {
    confirm: true, expected_revision: other.revision, slots_revision: slotsRev,
  }, deps()), { statusCode: 409 });
  // 目标含停用渠道:明确 400,不静默过滤。
  const written = profiles.readProfiles(file);
  written.profiles[0].slots.claude.main = { provider: 'off', model: 'model-a' };
  profiles.writeProfiles(file, written.profiles);
  assert.throws(() => profiles.applyProfile(file, slotMap(), id, {
    confirm: true, expected_revision: profiles.readProfiles(file).revision, slots_revision: profiles.slotsRevision(slotMap()),
  }, deps()), error => error.statusCode === 400 && /已停用/.test(error.message));
  assert.equal(applied, 0);
});

test('applySlots 抛错时原样上报,不声称成功', () => {
  resetApply();
  const file = tmpFile();
  const saved = create(file, '方案', ['claude']);
  const map = slotMap();
  const boom = () => { throw Object.assign(new Error('磁盘满'), { statusCode: 500 }); };
  assert.throws(() => profiles.applyProfile(file, map, saved.profiles[0].id,
    { confirm: true, expected_revision: saved.revision, slots_revision: profiles.slotsRevision(map) },
    { storeOf, validateSlotPut, applySlots: boom }), { message: '磁盘满' });
  const plain = () => { throw new Error('意外'); };
  assert.throws(() => profiles.applyProfile(file, map, saved.profiles[0].id,
    { confirm: true, expected_revision: saved.revision, slots_revision: profiles.slotsRevision(map) },
    { storeOf, validateSlotPut, applySlots: plain }), { statusCode: 500 });
});

test('删除只移除保存的方案,不动活槽位与其它方案', () => {
  resetApply();
  const file = tmpFile();
  create(file, 'A', ['claude']);
  create(file, 'B', ['codex']);
  const listed = profiles.listProfiles(file, slotMap());
  assert.deepEqual(listed.profiles.map(row => row.name), ['A', 'B']);
  const revision = listed.revision;
  const result = profiles.deleteProfile(file, listed.profiles[0].id, { confirm: true, expected_revision: revision });
  assert.equal(result.ok, true);
  assert.notEqual(result.revision, revision);
  assert.deepEqual(profiles.listProfiles(file, slotMap()).profiles.map(row => row.name), ['B']);
  assert.equal(applied, 0);
  assert.throws(() => profiles.deleteProfile(file, listed.profiles[0].id, {
    confirm: true, expected_revision: result.revision,
  }), { statusCode: 404 });
  assert.throws(() => profiles.deleteProfile(file, listed.profiles[1].id, {
    confirm: true, expected_revision: revision,
  }), { statusCode: 409 });
});

test('名称 / 范围 / 数量 / 未知字段校验;上限 30 个,名称 ≤80', () => {
  const file = tmpFile();
  const revision = () => profiles.readProfiles(file).revision;
  for (const name of ['', '   ', ' padded', 'trailing ', 'x'.repeat(81), 'bad\u0000', 'bad\u0085', 5, null]) {
    assert.throws(() => profiles.createProfile(file, slotMap(), { name, apps: ['claude'], expected_revision: revision() }),
      { statusCode: 400 }, String(name));
  }
  for (const apps of [[], ['claude', 'claude'], ['other'], 'claude', null, ['claude', 'codex', 'x']]) {
    assert.throws(() => profiles.createProfile(file, slotMap(), { name: 'ok', apps, expected_revision: revision() }),
      { statusCode: 400 });
  }
  assert.throws(() => profiles.createProfile(file, slotMap(), {
    name: 'ok', apps: ['claude'], expected_revision: revision(), extra: 1,
  }), { statusCode: 400 });
  assert.throws(() => profiles.createProfile(file, slotMap(), { name: 'ok', apps: ['claude'] }), { statusCode: 400 });
  assert.throws(() => profiles.createProfile(file, slotMap(), {
    name: 'ok', apps: ['claude'], expected_revision: 'stale',
  }), { statusCode: 409 });
  assert.equal(fs.existsSync(file), false, '全部被拒后不创建文件');
  for (let index = 0; index < profiles.PROFILE_LIMIT; index++) create(file, `方案 ${index}`, ['claude']);
  assert.throws(() => create(file, '第 31 个', ['claude']), { statusCode: 400 });
  assert.equal(profiles.listProfiles(file, slotMap()).profiles.length, profiles.PROFILE_LIMIT);
  // 中文名与内部空格保留原文。
  const trimmed = tmpFile();
  const saved = create(trimmed, '日常 主力', ['claude']);
  assert.equal(saved.profiles[0].name, '日常 主力');
});

test('损坏 / 版本不符 / 未知字段 / 重复 id 的文件明确失败,且不会被覆盖', () => {
  const cases = [
    '{broken',
    JSON.stringify({ version: 2, profiles: [] }),
    JSON.stringify({ version: 1, profiles: [], api_key: 'sk-private-stowaway' }),
    JSON.stringify({ version: 1, profiles: [{ id: 'not-a-uuid', name: 'x', apps: ['claude'], created_at: '2026-01-01T00:00:00.000Z', slots: { claude: {} } }] }),
    JSON.stringify({ version: 1, profiles: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'a', apps: ['claude'], created_at: '2026-01-01T00:00:00.000Z', slots: { claude: {} } },
      { id: '11111111-1111-4111-8111-111111111111', name: 'b', apps: ['claude'], created_at: '2026-01-01T00:00:00.000Z', slots: { claude: {} } },
    ] }),
    JSON.stringify({ version: 1, profiles: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'a', apps: ['claude'], created_at: '2026-01-01T00:00:00.000Z',
        slots: { claude: { main: { provider: 'p1', api_key: 'sk-private-stowaway' } } } },
    ] }),
    JSON.stringify({ version: 1, profiles: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'a', apps: ['claude'], created_at: '2026-01-01T00:00:00.000Z',
        slots: { claude: { nope: { provider: 'p1' } } } },
    ] }),
    // 组本身不是对象:null / false / [] 若被当成空表,一份损坏文件就变成"清空整组槽位"的方案。
    ...[[null], [false], [[]]].map(([group]) => JSON.stringify({ version: 1, profiles: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'a', apps: ['claude'], created_at: '2026-01-01T00:00:00.000Z',
        slots: { claude: group } },
    ] })),
  ];
  for (const text of cases) {
    const file = tmpFile();
    fs.writeFileSync(file, text);
    assert.throws(() => profiles.listProfiles(file, slotMap()), { statusCode: 500 }, text);
    assert.throws(() => profiles.createProfile(file, slotMap(), { name: 'x', apps: ['claude'], expected_revision: 'any' }),
      { statusCode: 500 });
    assert.equal(fs.readFileSync(file, 'utf8'), text, '损坏文件不能被覆盖');
  }
});

test('快照跳过空绑定(null / false),与 normalizeSlotsFile 一致', () => {
  const file = tmpFile();
  const map = slotMap();
  map.claude.haiku = null;
  map.claude.sonnet = false;
  create(file, '跳过空槽', ['claude'], map);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(stored.profiles[0].slots.claude).sort(), ['main', 'opus']);
});

test('预览不回显活槽位里的未知字段(手工改过 slots.json 时可能藏着密钥)', () => {
  const file = tmpFile();
  const saved = create(file, '方案', ['claude']);
  const map = slotMap();
  map.claude.main = { ...map.claude.main, api_key: 'sk-private-stowaway', base_url: 'https://private.example' };
  map.claude.opus = { ...map.claude.opus, keys: [{ key: 'sk-private-ring' }] };
  const result = preview(file, map, saved.profiles[0].id);
  const text = JSON.stringify(result);
  assert.ok(!text.includes('sk-private'), '预览不得带出活槽位里的密钥材料');
  assert.ok(!text.includes('private.example'));
  // main 只有未知字段不同:有效绑定没变,所以不算差异。
  assert.deepEqual(result.changes, []);
  // active 判定同样只看白名单字段。
  assert.equal(profiles.listProfiles(file, map).profiles[0].active, true);
});

test('快照拒绝含有坏类型的活槽位,而不是把坏数据写进配置文件', () => {
  const file = tmpFile();
  const map = slotMap();
  map.claude.opus = { provider: 'p1', model: 42 };
  assert.throws(() => profiles.createProfile(file, map, { name: '坏数据', apps: ['claude'],
    expected_revision: profiles.readProfiles(file).revision }), { statusCode: 400 });
  assert.equal(fs.existsSync(file), false);
});

test('slotsRevision 对键顺序不敏感、对槽位内容敏感', () => {
  const a = slotMap();
  const b = slotMap();
  b.claude.main = { dropTools: ['mcp__*'], strategy: 'priority',
    pool: [{ model: 'model-b', provider: 'p2' }], model: 'model-a', provider: 'p1' };
  assert.equal(profiles.slotsRevision(a), profiles.slotsRevision(b));
  b.claude.main.model = 'model-z';
  assert.notEqual(profiles.slotsRevision(a), profiles.slotsRevision(b));
  assert.equal(profiles.slotsRevision(null), profiles.slotsRevision({ claude: {}, codex: {} }));
});

test('落盘前原子替换失败保留旧内容,不清理临时文件以外的东西', () => {
  const file = tmpFile();
  const saved = create(file, '方案', ['claude']);
  const bytes = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === file) throw new Error('simulated'); return rename(from, to); };
  try {
    assert.throws(() => profiles.deleteProfile(file, saved.profiles[0].id, {
      confirm: true, expected_revision: saved.revision,
    }), { statusCode: 500 });
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(fs.readdirSync(DIR).filter(name => name.startsWith(path.basename(file) + '.')), []);
});
