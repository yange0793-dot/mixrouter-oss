'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createClientOnboarding } = require('../lib/client-onboarding');
const codexConfig = require('../lib/codex-config');
const { planCodexSlots } = require('../lib/codex-router-plan');

const ROUTER_URL = 'http://127.0.0.1:8787';
const ROUTER_TOKEN = 'mixrouter-local';

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-onboarding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const env = {
    PATH: bin,
    MIXR_DATA_DIR: path.join(dir, 'data'),
    MIXR_CLAUDE_SETTINGS: path.join(home, '.claude', 'settings.json'),
    MIXR_CODEX_CONFIG: path.join(home, '.codex', 'config.toml'),
  };
  return {
    dir, home, bin, env,
    claude: env.MIXR_CLAUDE_SETTINGS,
    codex: env.MIXR_CODEX_CONFIG,
    ledger: path.join(env.MIXR_DATA_DIR, 'client-managed.json'),
  };
}

function binary(ws, name, mode = 0o755) {
  fs.writeFileSync(path.join(ws.bin, name), '#!/bin/sh\nexit 0\n', { mode });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
// 与真实 switchClaude 一致:文件不存在时从 {} 建,而不是抛错。
function readJsonOrEmpty(file) {
  try { return readJson(file); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

function claudeStub(file, routerURL, routerToken) {
  return (app, options) => {
    const doc = readJsonOrEmpty(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    doc.env = doc.env || {};
    doc.env.ANTHROPIC_BASE_URL = routerURL;
    doc.env.ANTHROPIC_AUTH_TOKEN = routerToken;
    if (options.slots) doc.env.ANTHROPIC_MODEL = 'mixr-main';
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    return { warnings: ['backup-pool-warning'] };
  };
}

function codexStub(file, routerURL, routerToken, { slots = true } = {}) {
  return () => {
    const before = codexConfig.read(file);
    const currentModel = before.document.get('model') || 'gpt-5';
    const top = { model: slots ? 'mixr-main' : currentModel, model_provider: 'mixr-router',
      model_catalog_json: 'mixrouter-model-catalog.json' };
    if (slots) top.review_model = 'mixr-reviewer';
    const text = codexConfig.patch(before.text, {
      top,
      section: 'mixr-router',
      provider: {
        name: 'mixrouter(经 :8787 路由)',
        base_url: routerURL + '/v1',
        wire_api: 'responses',
        requires_openai_auth: false,
        experimental_bearer_token: routerToken,
      },
    });
    fs.writeFileSync(file, text);
    return { warnings: [] };
  };
}

function factory(ws, overrides = {}) {
  return createClientOnboarding({
    env: ws.env,
    home: ws.home,
    root: ws.dir,
    routerURL: ROUTER_URL,
    routerToken: ROUTER_TOKEN,
    getStore: () => ({
      claude: [{ id: 'p1', name: 'P1', enabled: true, api_key: 'store-key', models: ['m1'] }],
      codex: [{ id: 'c1', name: 'C1', enabled: true, api_key: 'codex-key', model: 'gpt-5', wire_api: 'responses' }],
    }),
    getSlots: () => ({
      claude: [{ name: 'main', provider: 'p1', alias: 'mixr-main', enabled: true, model: 'm1' }],
      codex: [
        { name: 'main', provider: 'c1', enabled: true, model: 'gpt-5' },
        { name: 'reviewer', provider: 'c1', enabled: true, model: 'gpt-5' },
      ],
    }),
    ...overrides,
  });
}

// ---------------------------------------------------------------- inspect

test('inspect 区分 missing / invalid / error(EACCES 不算 missing),安装检测只读 PATH', t => {
  const ws = workspace(t);
  binary(ws, 'claude');
  const onboarding = factory(ws, { applyRouter() {} });

  let state = onboarding.inspect('claude');
  assert.equal(state.config.status, 'missing');
  assert.equal(state.binary.found, true);
  assert.equal(state.binary.executable, true);

  fs.mkdirSync(path.dirname(ws.claude), { recursive: true });
  fs.writeFileSync(ws.claude, '{oops');
  state = onboarding.inspect('claude');
  assert.equal(state.config.status, 'invalid');
  assert.match(state.config.error, /JSON/);

  fs.writeFileSync(ws.claude, '{}\n');
  state = onboarding.inspect('claude');
  assert.equal(state.config.status, 'ok');
  assert.equal(state.routed, false);

  if (process.getuid && process.getuid() === 0) {
    t.diagnostic('以 root 运行,跳过 EACCES 用例');
  } else {
    fs.chmodSync(ws.claude, 0o000);
    state = onboarding.inspect('claude');
    assert.equal(state.config.status, 'error');
    assert.equal(state.config.code, 'EACCES');
    assert.notEqual(state.config.status, 'missing');
    fs.chmodSync(ws.claude, 0o600);

    binary(ws, 'codex', 0o000);
    const codexState = onboarding.inspect('codex');
    assert.equal(codexState.binary.found, true);
    assert.equal(codexState.binary.executable, false);
    assert.equal(codexState.binary.error, 'EACCES');
  }
});

// 服务常驻在 launchd / systemd 下时 PATH 往往只有 /usr/bin:/bin:/usr/sbin:/sbin,
// 而 Claude Code 官方安装器把可执行文件放在 ~/.local/bin。只查 PATH 会把"已经装好、
// 正在用"的客户端报成未安装,用户被引导去重装。这里钉住两件事:PATH 之外能找到;
// 并且要如实标出来源,不能假装它就在服务的 PATH 里。
test('PATH 里没有客户端时,仍能从常见安装目录找到并标出来源', t => {
  const ws = workspace(t);
  fs.mkdirSync(path.join(ws.home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(ws.home, '.local', 'bin', 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const onboarding = factory(ws, { applyRouter() {} });

  const state = onboarding.inspect('codex');
  assert.equal(state.binary.found, true);
  assert.equal(state.binary.executable, true);
  assert.equal(state.binary.source, 'known-dir');
  assert.equal(state.binary.path, path.join(ws.home, '.local', 'bin', 'codex'));

  // PATH 里能找到时来源如实写 path,不谎称来自固定目录。
  binary(ws, 'claude');
  assert.equal(onboarding.inspect('claude').binary.source, 'path');
});

test('Codex inspect 提供共享接入计划,脱敏且只读,无效槽与 profile 明确报错', t => {
  const ws = workspace(t);
  const onboarding = factory(ws, { applyRouter() {}, getSlots: () => ({ claude: [], codex: [] }) });
  const state = onboarding.inspect('codex');
  assert.equal(state.codex_plan.ok, true);
  assert.deepEqual(state.codex_plan.bootstrap, ['main', 'reviewer']);
  assert.equal(state.codex_plan.model, 'mixr-main');
  assert.equal(state.codex_plan.reviewModel, 'mixr-reviewer');
  assert.equal(state.codex_plan.slots.find(slot => slot.name === 'main').model, 'gpt-5');
  assert.equal(JSON.stringify(state).includes('codex-key'), false);
  assert.equal(fs.existsSync(ws.codex), false);
  assert.equal(fs.existsSync(ws.ledger), false);
  const invalid = factory(ws, { applyRouter() {},
    getSlots: () => ({ claude: [], codex: [{ name: 'main', provider: 'gone', model: 'gpt-5' }] }) }).inspect('codex');
  assert.equal(invalid.codex_plan.ok, false);
  assert.match(invalid.codex_plan.error, /main.*槽位/);
  fs.mkdirSync(path.dirname(ws.codex), { recursive: true });
  fs.writeFileSync(ws.codex, 'profile = "work"\n');
  assert.equal(onboarding.inspect('codex').codex_plan.ok, false);
  assert.match(onboarding.inspect('codex').codex_plan.error, /profile/);
});

// ---------------------------------------------------------------- Claude

test('Claude 接入:预览脱敏、令牌确认、账本 0600、只撤销受管字段', t => {
  const ws = workspace(t);
  const original = {
    permissions: { allow: ['Read'] },
    env: {
      KEEP: '1', ANTHROPIC_BASE_URL: 'https://old.example', ANTHROPIC_AUTH_TOKEN: 'old-secret-key',
      // 没有绑定槽位的 env 是用户手设的真实模型名,接入时不能动。
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'user-haiku',
    },
  };
  writeJson(ws.claude, original);
  const onboarding = factory(ws, { applyRouter: claudeStub(ws.claude, ROUTER_URL, ROUTER_TOKEN) });

  const preview = onboarding.preview('claude', { slots: true });
  assert.equal(preview.ok, true);
  assert.equal(typeof preview.token, 'string');
  const fields = preview.changes.map(change => change.field);
  assert.deepEqual(fields.sort(), ['env.ANTHROPIC_AUTH_TOKEN', 'env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_MODEL']);
  const serialized = JSON.stringify(preview);
  assert.ok(!serialized.includes('old-secret-key'));
  assert.ok(!serialized.includes(ROUTER_TOKEN));

  assert.throws(() => onboarding.apply('claude', { token: preview.token }),
    error => error.statusCode === 400 && /confirm/.test(error.message));
  // 未确认时令牌没有被消耗。
  const applied = onboarding.apply('claude', { token: preview.token, confirm: true });
  assert.deepEqual(applied.warnings, ['backup-pool-warning']);
  assert.equal(applied.ledger_saved, true);

  const routed = readJson(ws.claude);
  assert.deepEqual(routed.permissions, original.permissions);
  assert.equal(routed.env.KEEP, '1');
  assert.equal(routed.env.ANTHROPIC_BASE_URL, ROUTER_URL);
  assert.equal(routed.env.ANTHROPIC_AUTH_TOKEN, ROUTER_TOKEN);
  assert.equal(routed.env.ANTHROPIC_MODEL, 'mixr-main');
  assert.equal(routed.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'user-haiku');

  const ledgerStat = fs.statSync(ws.ledger);
  assert.equal(ledgerStat.mode & 0o777, 0o600);
  const ledger = readJson(ws.ledger);
  assert.ok(ledger.apps.claude.entries.length >= 3);

  // 用户改了非受管字段:撤销仍然可以,且保留这次修改。
  const edited = readJson(ws.claude);
  edited.env.KEEP = '2';
  writeJson(ws.claude, edited);
  const undoPreview = onboarding.previewUndo('claude');
  assert.equal(undoPreview.can_undo, true);
  assert.equal(undoPreview.conflicts.length, 0);
  const undone = onboarding.undo('claude', { token: undoPreview.token, confirm: true });
  assert.equal(undone.ok, true);
  assert.deepEqual(readJson(ws.claude), { ...original, env: { ...original.env, KEEP: '2' } });
  assert.deepEqual(readJson(ws.ledger).apps, {});
  assert.throws(() => onboarding.previewUndo('claude'), error => error.statusCode === 404);
});

test('配置文件原本不存在:可以接入,撤销后只留下空对象,不留下受管键', t => {
  const ws = workspace(t);
  const onboarding = factory(ws, { applyRouter: claudeStub(ws.claude, ROUTER_URL, ROUTER_TOKEN) });
  assert.equal(onboarding.inspect('claude').config.status, 'missing');
  const preview = onboarding.preview('claude');
  assert.equal(preview.config.status, 'missing');
  assert.ok(preview.changes.every(change => change.before === null));

  onboarding.apply('claude', { token: preview.token, confirm: true });
  assert.equal(readJson(ws.claude).env.ANTHROPIC_BASE_URL, ROUTER_URL);

  const undoPreview = onboarding.previewUndo('claude');
  onboarding.undo('claude', { token: undoPreview.token, confirm: true });
  const restored = readJson(ws.claude);
  assert.equal(Object.hasOwn(restored.env || {}, 'ANTHROPIC_BASE_URL'), false);
  assert.equal(Object.hasOwn(restored.env || {}, 'ANTHROPIC_AUTH_TOKEN'), false);
});

test('Claude slots 只清理旧的 mixr- 残留,不动用户手设的真实模型名', t => {
  const ws = workspace(t);
  writeJson(ws.claude, { env: {
    ANTHROPIC_BASE_URL: 'https://old.example',
    ANTHROPIC_AUTH_TOKEN: 'old-key',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'mixr-sonnet',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'user-haiku',
  } });
  const applyRouter = (app, options) => {
    const doc = readJson(ws.claude);
    doc.env.ANTHROPIC_BASE_URL = ROUTER_URL;
    doc.env.ANTHROPIC_AUTH_TOKEN = ROUTER_TOKEN;
    if (options.slots) {
      doc.env.ANTHROPIC_MODEL = 'mixr-main';
      if (String(doc.env.ANTHROPIC_DEFAULT_SONNET_MODEL || '').startsWith('mixr-')) delete doc.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    }
    writeJson(ws.claude, doc);
  };
  const onboarding = factory(ws, { applyRouter });
  const preview = onboarding.preview('claude', { slots: true });
  assert.ok(preview.changes.some(change => change.field === 'env.ANTHROPIC_DEFAULT_SONNET_MODEL' && change.after === null));
  assert.equal(preview.changes.some(change => change.field === 'env.ANTHROPIC_DEFAULT_HAIKU_MODEL'), false);

  onboarding.apply('claude', { token: preview.token, confirm: true });
  let doc = readJson(ws.claude);
  assert.equal(Object.hasOwn(doc.env, 'ANTHROPIC_DEFAULT_SONNET_MODEL'), false);
  assert.equal(doc.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'user-haiku');

  const undoPreview = onboarding.previewUndo('claude');
  onboarding.undo('claude', { token: undoPreview.token, confirm: true });
  doc = readJson(ws.claude);
  assert.equal(doc.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'mixr-sonnet');
  assert.equal(doc.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'user-haiku');
});

test('Claude 撤销冲突:受管字段被改过就整体拒绝,并给出脱敏预览', t => {
  const ws = workspace(t);
  writeJson(ws.claude, { env: { ANTHROPIC_BASE_URL: 'https://old.example', ANTHROPIC_AUTH_TOKEN: 'old-key' } });
  const onboarding = factory(ws, { applyRouter: claudeStub(ws.claude, ROUTER_URL, ROUTER_TOKEN) });

  const preview = onboarding.preview('claude');
  onboarding.apply('claude', { token: preview.token, confirm: true });
  const undoPreview = onboarding.previewUndo('claude');
  assert.equal(undoPreview.can_undo, true);

  const edited = readJson(ws.claude);
  edited.env.ANTHROPIC_BASE_URL = 'https://user-changed.example';
  writeJson(ws.claude, edited);
  const before = fs.readFileSync(ws.claude, 'utf8');
  assert.throws(() => onboarding.undo('claude', { token: undoPreview.token, confirm: true }),
    error => error.statusCode === 409 && error.conflicts.some(item => item.field === 'env.ANTHROPIC_BASE_URL'));
  assert.equal(fs.readFileSync(ws.claude, 'utf8'), before, '冲突时不得写入');

  const again = onboarding.previewUndo('claude');
  assert.equal(again.can_undo, false);
  assert.equal(again.token, null);
  assert.equal(again.conflicts[0].field, 'env.ANTHROPIC_BASE_URL');
  assert.ok(!JSON.stringify(again).includes('old-key'));
  // 预览里的 current 是**磁盘现值**,不是账本里的写后值。
  const changed = again.changes.find(change => change.field === 'env.ANTHROPIC_BASE_URL');
  assert.equal(changed.current, 'https://user-changed.example/');
  const conflict = again.conflicts.find(item => item.field === 'env.ANTHROPIC_BASE_URL');
  assert.equal(conflict.current, 'https://user-changed.example/');
});

test('Claude 预览后文件被外部修改:apply 以 409 拒绝,令牌过期也会拒绝', t => {
  const ws = workspace(t);
  writeJson(ws.claude, { env: { ANTHROPIC_BASE_URL: 'https://old.example' } });
  let clock = 1_000_000;
  const onboarding = factory(ws, {
    applyRouter: claudeStub(ws.claude, ROUTER_URL, ROUTER_TOKEN),
    now: () => clock,
  });

  const stale = onboarding.preview('claude');
  writeJson(ws.claude, { env: { ANTHROPIC_BASE_URL: 'https://someone-else.example' } });
  assert.throws(() => onboarding.apply('claude', { token: stale.token, confirm: true }),
    error => error.statusCode === 409 && /预览后/.test(error.message));

  const expiring = onboarding.preview('claude');
  clock += 6 * 60 * 1000;
  assert.throws(() => onboarding.apply('claude', { token: expiring.token, confirm: true }),
    error => error.statusCode === 400 && /过期/.test(error.message));

  const crossApp = onboarding.preview('claude');
  assert.throws(() => onboarding.apply('codex', { token: crossApp.token, confirm: true }),
    error => error.statusCode === 400 && /不匹配/.test(error.message));
});

// ---------------------------------------------------------------- Codex

test('Codex 纯槽位计划只补缺失默认槽,不改变输入或其它槽位', () => {
  const providers = [{ id: 'off', enabled: false, model: 'off', api_key: 'k' },
    { id: 'first', name: 'First', model: 'default', api_key: 'k' },
    { id: 'second', model: 'other', api_key: 'k' }];
  const slots = [{ name: 'worker', alias: 'mixr-worker', provider: 'second', model: 'custom', enabled: true },
    { name: 'main', alias: 'wrong-alias', provider: 'second', model: 'explicit', enabled: true }];
  const original = JSON.stringify({ slots, providers });
  const plan = planCodexSlots(slots, providers);
  assert.deepEqual(plan.bootstrap, ['reviewer']);
  assert.equal(plan.model, 'mixr-main');
  assert.equal(plan.reviewModel, 'mixr-reviewer');
  assert.equal(plan.slots.find(slot => slot.name === 'main').model, 'explicit');
  assert.equal(plan.slots.find(slot => slot.name === 'main').alias, 'mixr-main');
  assert.equal(plan.slots.find(slot => slot.name === 'reviewer').provider, 'first');
  assert.equal(plan.slots.find(slot => slot.name === 'reviewer').model, 'default');
  assert.deepEqual(plan.slots.find(slot => slot.name === 'worker'), slots[0]);
  assert.equal(JSON.stringify({ slots, providers }), original);
  assert.throws(() => planCodexSlots(slots, providers, { strict: true }),
    error => error.statusCode === 400 && /reviewer.*槽位/.test(error.message));
});

const CODEX_ORIGINAL = `model = "gpt-5"
model_provider = "custom"

# 用户注释保留
[model_providers.custom]
name = "custom"
base_url = "https://old.example/v1"
wire_api = "responses"
experimental_bearer_token = "old-codex-key"

[mcp_servers.fetch]
command = "uvx"
`;

test('Codex 接入:TOML 结构补丁只动受管字段,撤销可完整还原', t => {
  const ws = workspace(t);
  fs.mkdirSync(path.dirname(ws.codex), { recursive: true });
  fs.writeFileSync(ws.codex, CODEX_ORIGINAL);
  const onboarding = factory(ws, { applyRouter: codexStub(ws.codex, ROUTER_URL, ROUTER_TOKEN) });

  const preview = onboarding.preview('codex');
  assert.ok(preview.changes.some(change => change.field === 'model_provider' && change.after === 'mixr-router'));
  assert.ok(preview.changes.some(change => /experimental_bearer_token$/.test(change.field)));
  const serialized = JSON.stringify(preview);
  assert.ok(!serialized.includes('old-codex-key'));
  assert.ok(!serialized.includes(ROUTER_TOKEN));

  onboarding.apply('codex', { token: preview.token, confirm: true });
  let text = fs.readFileSync(ws.codex, 'utf8');
  assert.match(text, /model_provider = "mixr-router"/);
  assert.match(text, /\[model_providers\.custom\]/);
  assert.match(text, /# 用户注释保留/);
  assert.match(text, /\[mcp_servers\.fetch\]/);

  // 编辑无关字段不影响撤销。
  text = text.replace('command = "uvx"', 'command = "uvx --quiet"');
  fs.writeFileSync(ws.codex, text);
  const undoPreview = onboarding.previewUndo('codex');
  assert.equal(undoPreview.can_undo, true);
  onboarding.undo('codex', { token: undoPreview.token, confirm: true });
  text = fs.readFileSync(ws.codex, 'utf8');
  assert.doesNotMatch(text, /mixr-router/);
  assert.match(text, /model_provider = "custom"/);
  assert.match(text, /model = "gpt-5"/);
  assert.match(text, /experimental_bearer_token = "old-codex-key"/);
  assert.match(text, /command = "uvx --quiet"/);
  assert.deepEqual(readJson(ws.ledger).apps, {});
});

test('全局环境变量会覆盖配置文件:预览按变量名提示,值绝不出现在返回里', t => {
  const ws = workspace(t);
  writeJson(ws.claude, { env: { ANTHROPIC_BASE_URL: 'https://old.example' } });
  Object.assign(ws.env, {
    ANTHROPIC_BASE_URL: 'https://global-secret-host.example/v1?token=abc',
    ANTHROPIC_AUTH_TOKEN: 'sk-global-secret-value',
    ANTHROPIC_DEFAULT_OPUS_MODEL: '',
    UNRELATED_VAR: 'sk-not-ours',
  });
  const onboarding = factory(ws, { applyRouter: claudeStub(ws.claude, ROUTER_URL, ROUTER_TOKEN) });
  const preview = onboarding.preview('claude');
  const notice = preview.warnings.find(item => /环境变量/.test(item));
  assert.ok(notice, '应提示全局环境变量覆盖');
  assert.match(notice, /ANTHROPIC_BASE_URL/);
  assert.match(notice, /ANTHROPIC_AUTH_TOKEN/);
  // 空值的变量不算"已设置";别的客户端的变量不在这里提。
  assert.equal(/ANTHROPIC_DEFAULT_OPUS_MODEL/.test(notice), false);
  assert.equal(/UNRELATED_VAR/.test(notice), false);
  // 值一个字都不能回显。
  const serialized = JSON.stringify(preview);
  assert.equal(serialized.includes('sk-global-secret-value'), false);
  assert.equal(serialized.includes('global-secret-host'), false);

  // Codex 那条只看 Codex 的变量。
  fs.mkdirSync(path.dirname(ws.codex), { recursive: true });
  fs.writeFileSync(ws.codex, CODEX_ORIGINAL);
  Object.assign(ws.env, { OPENAI_API_KEY: 'sk-openai-global' });
  const codexPreview = factory(ws, { applyRouter: codexStub(ws.codex, ROUTER_URL, ROUTER_TOKEN) }).preview('codex');
  const codexNotice = codexPreview.warnings.find(item => /环境变量/.test(item));
  assert.match(codexNotice, /OPENAI_API_KEY/);
  assert.equal(/ANTHROPIC_AUTH_TOKEN/.test(codexNotice), false);
  assert.equal(JSON.stringify(codexPreview).includes('sk-openai-global'), false);
});

test('撤销在用户没有其它改动时逐字节还原两个客户端配置', t => {
  const ws = workspace(t);
  writeJson(ws.claude, { permissions: { allow: ['Read'] }, env: { ANTHROPIC_BASE_URL: 'https://old.example' } });
  fs.mkdirSync(path.dirname(ws.codex), { recursive: true });
  fs.writeFileSync(ws.codex, CODEX_ORIGINAL);
  const before = {
    claude: fs.readFileSync(ws.claude, 'utf8'),
    codex: fs.readFileSync(ws.codex, 'utf8'),
  };
  const onboarding = factory(ws, {
    applyRouter(app, options) {
      if (app === 'claude') return claudeStub(ws.claude, ROUTER_URL, ROUTER_TOKEN)(app, options);
      return codexStub(ws.codex, ROUTER_URL, ROUTER_TOKEN)(app, options);
    },
  });
  for (const app of ['claude', 'codex']) {
    const preview = onboarding.preview(app);
    onboarding.apply(app, { token: preview.token, confirm: true });
  }
  for (const app of ['claude', 'codex']) {
    const undoPreview = onboarding.previewUndo(app);
    assert.equal(undoPreview.can_undo, true, `${app} 撤销预览应可执行`);
    onboarding.undo(app, { token: undoPreview.token, confirm: true });
    assert.equal(fs.readFileSync(ws[app], 'utf8'), before[app], `${app} 未逐字节还原`);
  }
});

test('Codex 撤销冲突:受管 provider 字段或段内额外字段都会拒绝', t => {
  const ws = workspace(t);
  fs.mkdirSync(path.dirname(ws.codex), { recursive: true });
  fs.writeFileSync(ws.codex, CODEX_ORIGINAL);
  const onboarding = factory(ws, { applyRouter: codexStub(ws.codex, ROUTER_URL, ROUTER_TOKEN) });

  let preview = onboarding.preview('codex');
  onboarding.apply('codex', { token: preview.token, confirm: true });
  let undoPreview = onboarding.previewUndo('codex');
  let text = fs.readFileSync(ws.codex, 'utf8').replace(
    `base_url = "${ROUTER_URL}/v1"`, 'base_url = "https://tampered.example/v1"');
  fs.writeFileSync(ws.codex, text);
  assert.throws(() => onboarding.undo('codex', { token: undoPreview.token, confirm: true }),
    error => error.statusCode === 409 && error.conflicts.some(item => /base_url$/.test(item.field)));

  // 段内额外字段:不能直接删段,否则会连用户新增的字段一起删掉。
  text = fs.readFileSync(ws.codex, 'utf8').replace(
    '[model_providers.mixr-router]', '[model_providers.mixr-router]\nuser_extra = "keep"');
  fs.writeFileSync(ws.codex, text);
  undoPreview = onboarding.previewUndo('codex');
  assert.equal(undoPreview.can_undo, false);
  assert.match(JSON.stringify(undoPreview.conflicts), /额外字段/);
});

test('Codex 普通接入预览自动采用可用槽位并管理模型目录,不触碰推理强度', t => {
  const ws = workspace(t);
  fs.mkdirSync(path.dirname(ws.codex), { recursive: true });
  fs.writeFileSync(ws.codex, CODEX_ORIGINAL.replace('model_provider = "custom"',
    'model_provider = "custom"\nmodel_reasoning_effort = "max"'));
  const onboarding = factory(ws, { applyRouter: codexStub(ws.codex, ROUTER_URL, ROUTER_TOKEN) });
  const preview = onboarding.preview('codex');
  assert.ok(preview.changes.some(change => change.field === 'model' && change.after === 'mixr-main'));
  assert.ok(preview.changes.some(change => change.field === 'review_model' && change.after === 'mixr-reviewer'));
  assert.ok(preview.changes.some(change => change.field === 'model_catalog_json' && change.after === 'mixrouter-model-catalog.json'));
  assert.equal(preview.changes.some(change => change.field === 'model_reasoning_effort'), false);
  assert.ok(preview.warnings.some(warning => /撤销只还原 model_catalog_json/.test(warning)));
  const applied = onboarding.apply('codex', { token: preview.token, confirm: true });
  assert.deepEqual(applied.changed, preview.changes);
  assert.match(fs.readFileSync(ws.codex, 'utf8'), /model_reasoning_effort = "max"/);
  const undoPreview = onboarding.previewUndo('codex');
  onboarding.undo('codex', { token: undoPreview.token, confirm: true });
  const restored = codexConfig.read(ws.codex).document;
  assert.equal(restored.get('model'), 'gpt-5');
  assert.equal(restored.get('review_model'), undefined);
  assert.equal(restored.get('model_catalog_json'), undefined);
  assert.equal(restored.get('model_reasoning_effort'), 'max');
});

test('Codex slots 预览:写 mixr-main / mixr-reviewer,撤销后恢复原 model 且删除 review_model', t => {
  const ws = workspace(t);
  fs.mkdirSync(path.dirname(ws.codex), { recursive: true });
  fs.writeFileSync(ws.codex, CODEX_ORIGINAL);
  const onboarding = factory(ws, { applyRouter: codexStub(ws.codex, ROUTER_URL, ROUTER_TOKEN, { slots: true }) });

  const preview = onboarding.preview('codex', { slots: true });
  assert.ok(preview.changes.some(change => change.field === 'model' && change.after === 'mixr-main'));
  assert.ok(preview.changes.some(change => change.field === 'review_model' && change.after === 'mixr-reviewer'));
  onboarding.apply('codex', { token: preview.token, confirm: true });
  const text = fs.readFileSync(ws.codex, 'utf8');
  assert.match(text, /model = "mixr-main"/);
  assert.match(text, /review_model = "mixr-reviewer"/);

  const undoPreview = onboarding.previewUndo('codex');
  onboarding.undo('codex', { token: undoPreview.token, confirm: true });
  const restored = codexConfig.read(ws.codex);
  assert.equal(restored.document.get('model'), 'gpt-5');
  assert.equal(codexConfig.topLevel(fs.readFileSync(ws.codex, 'utf8'), 'review_model'), '');
});

test('预览的 after 与真实写入结果逐字段一致(Claude / Codex slots)', t => {
  const ws = workspace(t);
  writeJson(ws.claude, { env: { ANTHROPIC_BASE_URL: 'https://old.example', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'user-haiku' } });
  fs.mkdirSync(path.dirname(ws.codex), { recursive: true });
  fs.writeFileSync(ws.codex, CODEX_ORIGINAL);
  const onboarding = factory(ws, {
    applyRouter(app, options) {
      if (app === 'claude') return claudeStub(ws.claude, ROUTER_URL, ROUTER_TOKEN)(app, options);
      return codexStub(ws.codex, ROUTER_URL, ROUTER_TOKEN)(app, options);
    },
  });
  const cases = [['claude', { slots: true }], ['codex', {}], ['codex', { slots: true }]];
  for (const [app, options] of cases) {
    const preview = onboarding.preview(app, options);
    const applied = onboarding.apply(app, { token: preview.token, confirm: true });
    const key = entry => `${entry.field}=${JSON.stringify(entry.after ?? null)}`;
    assert.deepEqual(
      applied.changed.map(key).sort(),
      preview.changes.map(key).sort(),
      `${app} ${JSON.stringify(options)} 预览与写入不一致`);
    const undoPreview = onboarding.previewUndo(app);
    onboarding.undo(app, { token: undoPreview.token, confirm: true });
  }
});

test('getSlots 收到 slotMap 原始对象形状也能工作;渠道库/槽位在预览后变动则拒绝写入', t => {
  const ws = workspace(t);
  fs.mkdirSync(path.dirname(ws.codex), { recursive: true });
  fs.writeFileSync(ws.codex, CODEX_ORIGINAL);

  // slotMap 形状:{claude:{main:{provider:'p1'}}, codex:{main:{…}, reviewer:{…}}}
  let slotMap = {
    claude: { main: { provider: 'p1' } },
    codex: { main: { provider: 'c1' }, reviewer: { provider: 'c1' } },
  };
  const onboarding = factory(ws, {
    applyRouter: codexStub(ws.codex, ROUTER_URL, ROUTER_TOKEN, { slots: true }),
    getSlots: () => slotMap,
  });
  const preview = onboarding.preview('codex', { slots: true });
  assert.ok(preview.changes.some(change => change.field === 'model' && change.after === 'mixr-main'));
  assert.ok(preview.changes.some(change => change.field === 'review_model' && change.after === 'mixr-reviewer'));

  // 预览之后槽位绑定变了 → 实际写出来的别名会不一样,必须拒绝而不是照旧写着看过的方案。
  slotMap = { claude: { main: { provider: 'p1' } }, codex: { main: { provider: 'c1' } } };
  const before = fs.readFileSync(ws.codex, 'utf8');
  assert.throws(() => onboarding.apply('codex', { token: preview.token, confirm: true }),
    error => error.statusCode === 409 && /渠道库或槽位/.test(error.message));
  assert.equal(fs.readFileSync(ws.codex, 'utf8'), before, '拒绝时不得写入');
});

test('Codex 普通接入预览披露缺失槽位自动补齐,严格接入不自动补槽', t => {
  const ws = workspace(t);
  fs.mkdirSync(path.dirname(ws.codex), { recursive: true });
  fs.writeFileSync(ws.codex, CODEX_ORIGINAL);
  const onboarding = factory(ws, {
    applyRouter: codexStub(ws.codex, ROUTER_URL, ROUTER_TOKEN),
    getSlots: () => ({ claude: [], codex: [] }),
  });
  const preview = onboarding.preview('codex');
  assert.ok(preview.changes.some(change => change.field === 'model' && change.after === 'mixr-main'));
  assert.ok(preview.changes.some(change => change.field === 'review_model' && change.after === 'mixr-reviewer'));
  assert.ok(preview.warnings.some(warning => /自动补齐.*main.*reviewer/.test(warning)));
  assert.ok(preview.warnings.some(warning => /撤销.*不删除.*槽/.test(warning)));
  assert.throws(() => onboarding.preview('codex', { slots: true }),
    error => error.statusCode === 400 && /槽位/.test(error.message));
  assert.equal(fs.readFileSync(ws.codex, 'utf8'), CODEX_ORIGINAL, '预览不写客户端配置');
});

test('Codex 已有无效槽不被普通接入的自动补齐覆盖', t => {
  const ws = workspace(t);
  fs.mkdirSync(path.dirname(ws.codex), { recursive: true });
  fs.writeFileSync(ws.codex, CODEX_ORIGINAL);
  const onboarding = factory(ws, {
    applyRouter: codexStub(ws.codex, ROUTER_URL, ROUTER_TOKEN),
    getSlots: () => ({ claude: [], codex: [{ name: 'main', provider: 'missing', model: 'm', enabled: false }] }),
  });
  assert.throws(() => onboarding.preview('codex'),
    error => error.statusCode === 400 && /main.*槽位/.test(error.message));
  const raw = factory(ws, {
    applyRouter: codexStub(ws.codex, ROUTER_URL, ROUTER_TOKEN),
    getSlots: () => ({ claude: {}, codex: { main: { provider: '' } } }),
  });
  assert.throws(() => raw.preview('codex'),
    error => error.statusCode === 400 && /main.*槽位/.test(error.message));
});

test('Codex 没有任何可用模型名时不写 model = "",预览直接拒绝', t => {
  const ws = workspace(t);
  fs.mkdirSync(path.dirname(ws.codex), { recursive: true });
  fs.writeFileSync(ws.codex, '[mcp_servers.fetch]\ncommand = "uvx"\n');
  const onboarding = factory(ws, {
    applyRouter: codexStub(ws.codex, ROUTER_URL, ROUTER_TOKEN),
    getStore: () => ({ claude: [], codex: [{ id: 'c1', name: 'C1', enabled: false, api_key: 'k', model: 'gpt-5' }] }),
  });
  assert.throws(() => onboarding.preview('codex'),
    error => error.statusCode === 400 && /模型名|槽位/.test(error.message));
  assert.equal(fs.readFileSync(ws.codex, 'utf8'), '[mcp_servers.fetch]\ncommand = "uvx"\n');
});

test('Codex 选择 profile 时预览直接拒绝;缺主槽位绑定也会拒绝', t => {
  const ws = workspace(t);
  fs.mkdirSync(path.dirname(ws.codex), { recursive: true });
  fs.writeFileSync(ws.codex, CODEX_ORIGINAL.replace('model_provider = "custom"', 'model_provider = "custom"\nprofile = "work"'));
  const onboarding = factory(ws, { applyRouter: codexStub(ws.codex, ROUTER_URL, ROUTER_TOKEN) });
  assert.throws(() => onboarding.preview('codex'), error => error.statusCode === 400 && /profile/.test(error.message));

  fs.writeFileSync(ws.codex, CODEX_ORIGINAL);
  const noSlots = factory(ws, {
    applyRouter: codexStub(ws.codex, ROUTER_URL, ROUTER_TOKEN),
    getSlots: () => ({ claude: [], codex: [{ name: 'main', provider: '', enabled: false, model: '' }] }),
  });
  assert.throws(() => noSlots.preview('codex', { slots: true }),
    error => error.statusCode === 400 && /槽位/.test(error.message));
});

// ---------------------------------------------------------------- 已移除的 ZCode
// ZCode 接入整体移除:向导只接 claude / codex。app 非法时在**本地**就拒绝(400),
// 不落到任何读盘/写盘分支 —— 旧控制台或脚本仍可能带着 app=zcode 的请求过来。

test('ZCode 不再是可接入客户端:inspect / preview / apply / 撤销一律按非法 app 拒绝', t => {
  const ws = workspace(t);
  const onboarding = factory(ws, { applyRouter() { throw new Error('不该走到写入'); } });
  for (const call of [() => onboarding.inspect('zcode'), () => onboarding.preview('zcode'),
    () => onboarding.apply('zcode', { token: 'x', confirm: true }),
    () => onboarding.previewUndo('zcode'), () => onboarding.undo('zcode', { token: 'x', confirm: true })]) {
    assert.throws(call, error => error.statusCode === 400 && /claude 或 codex/.test(error.message));
  }
  assert.equal(fs.existsSync(ws.ledger), false, '拒绝时不能建账本');
});

test('旧账本里残留 app=zcode 的记录不影响 claude/codex 记账与撤销', t => {
  const ws = workspace(t);
  writeJson(ws.claude, { env: { ANTHROPIC_BASE_URL: 'https://old.example' } });
  const onboarding = factory(ws, { applyRouter: claudeStub(ws.claude, ROUTER_URL, ROUTER_TOKEN) });
  const preview = onboarding.preview('claude');
  onboarding.apply('claude', { token: preview.token, confirm: true });

  // 模拟升级前留下的 ZCode 账本:结构合法,但那条 app 已经没有对应客户端了。
  const ledger = readJson(ws.ledger);
  ledger.apps.zcode = { app: 'zcode', file: '/gone/.zcode/v2/config.json', mode: 'router',
    applied_at: '2026-01-01T00:00:00.000Z', revision_before: null, revision_after: 'x',
    entries: [{ kind: 'zcode-provider', path: ['provider', 'mixrouter-managed'], secret: false,
      before_absent: true, before: null, after_absent: false, after: {} }] };
  writeJson(ws.ledger, ledger);

  // 忽略而不是报错:一份历史账本不能让 claude 的撤销整份失效。
  const undoPreview = onboarding.previewUndo('claude');
  assert.equal(undoPreview.can_undo, true);
  onboarding.undo('claude', { token: undoPreview.token, confirm: true });
  assert.equal(fs.readFileSync(ws.claude, 'utf8').includes('https://old.example'), true);
  // 旧记录原样留着,不替用户删除他磁盘上的历史。
  assert.ok(readJson(ws.ledger).apps.zcode, '旧 zcode 账本条目应原样保留');
});

// ---------------------------------------------------------------- 账本

test('再次接入时提示上一次的撤销点会被覆盖;账本损坏则在预览阶段就失败', t => {
  const ws = workspace(t);
  writeJson(ws.claude, { env: { ANTHROPIC_BASE_URL: 'https://old.example' } });
  const onboarding = factory(ws, { applyRouter: claudeStub(ws.claude, ROUTER_URL, ROUTER_TOKEN) });
  const first = onboarding.preview('claude');
  assert.equal(first.warnings.some(item => /撤销记录/.test(item)), false);
  onboarding.apply('claude', { token: first.token, confirm: true });

  const second = onboarding.preview('claude');
  assert.ok(second.warnings.some(item => /撤销记录/.test(item)));

  fs.mkdirSync(path.dirname(ws.ledger), { recursive: true });
  fs.writeFileSync(ws.ledger, '{broken');
  assert.throws(() => onboarding.preview('claude'),
    error => error.statusCode === 500 && /账本/.test(error.message));
  assert.throws(() => onboarding.previewUndo('claude'),
    error => error.statusCode === 500 && /账本/.test(error.message));
});

test('客户端配置是软链时,撤销写回真实文件,不把软链换成常规文件', t => {
  const ws = workspace(t);
  const real = path.join(ws.home, 'dotfiles', 'claude-settings.json');
  writeJson(real, { env: { ANTHROPIC_BASE_URL: 'https://old.example' } });
  fs.mkdirSync(path.dirname(ws.claude), { recursive: true });
  fs.symlinkSync(real, ws.claude);

  const onboarding = factory(ws, {
    applyRouter: (app, options) => {
      const doc = readJson(real);
      doc.env = doc.env || {};
      doc.env.ANTHROPIC_BASE_URL = ROUTER_URL;
      doc.env.ANTHROPIC_AUTH_TOKEN = ROUTER_TOKEN;
      void options;
      fs.writeFileSync(real, JSON.stringify(doc, null, 2) + '\n');
    },
  });
  const preview = onboarding.preview('claude');
  onboarding.apply('claude', { token: preview.token, confirm: true });
  const undoPreview = onboarding.previewUndo('claude');
  onboarding.undo('claude', { token: undoPreview.token, confirm: true });

  assert.equal(fs.lstatSync(ws.claude).isSymbolicLink(), true, '软链被写坏了');
  assert.equal(fs.readFileSync(real, 'utf8').includes('https://old.example'), true);
});

test('账本被篡改成非法路径时拒绝撤销,不写文件', t => {
  const ws = workspace(t);
  writeJson(ws.claude, { env: { ANTHROPIC_BASE_URL: 'https://old.example' } });
  const onboarding = factory(ws, { applyRouter: claudeStub(ws.claude, ROUTER_URL, ROUTER_TOKEN) });
  const preview = onboarding.preview('claude');
  onboarding.apply('claude', { token: preview.token, confirm: true });

  const ledger = readJson(ws.ledger);
  ledger.apps.claude.entries[0].path = ['env', '__proto__'];
  writeJson(ws.ledger, ledger);
  const before = fs.readFileSync(ws.claude, 'utf8');
  assert.throws(() => onboarding.previewUndo('claude'),
    error => error.statusCode === 500 && /非法字段路径|账本/.test(error.message));
  assert.equal(fs.readFileSync(ws.claude, 'utf8'), before);
  assert.equal({}.polluted, undefined);
});

test('每个客户端的账本彼此独立,撤销一个不影响另一个', t => {
  const ws = workspace(t);
  writeJson(ws.claude, { env: { ANTHROPIC_BASE_URL: 'https://old-claude.example' } });
  fs.mkdirSync(path.dirname(ws.codex), { recursive: true });
  fs.writeFileSync(ws.codex, CODEX_ORIGINAL);
  const onboarding = factory(ws, {
    applyRouter(app, options) {
      if (app === 'claude') return claudeStub(ws.claude, ROUTER_URL, ROUTER_TOKEN)(app, options);
      return codexStub(ws.codex, ROUTER_URL, ROUTER_TOKEN)(app, options);
    },
  });
  const claudePreview = onboarding.preview('claude');
  onboarding.apply('claude', { token: claudePreview.token, confirm: true });
  const codexPreview = onboarding.preview('codex');
  onboarding.apply('codex', { token: codexPreview.token, confirm: true });

  const ledger = readJson(ws.ledger);
  assert.ok(ledger.apps.claude);
  assert.ok(ledger.apps.codex);
  const undoClaude = onboarding.previewUndo('claude');
  onboarding.undo('claude', { token: undoClaude.token, confirm: true });
  assert.equal(readJson(ws.ledger).apps.claude, undefined);
  assert.ok(readJson(ws.ledger).apps.codex);
  assert.match(fs.readFileSync(ws.codex, 'utf8'), /mixr-router/);
});
