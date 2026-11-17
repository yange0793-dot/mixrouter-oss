'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../lib/codex-config');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-codex-config-'));
const codexFile = path.join(temporary, 'config.toml');
const claudeFile = path.join(temporary, 'claude.json');
process.env.MIXR_DATA_DIR = temporary;
process.env.MIXR_CODEX_CONFIG = codexFile;
process.env.MIXR_CLAUDE_SETTINGS = claudeFile;
const router = require('../mixrouter');
const provider = { id: 'native', name: 'Native', base_url: 'https://native.example/prefix', api_key: 'private-test-key', model: 'known-model', enabled: true, wire_api: 'responses' };
const chat = { ...provider, id: 'chat', name: 'Chat', model: 'unknown-model', wire_api: 'chat' };
const originalClaude = '{"env":{"ANTHROPIC_MODEL":"untouched"},"custom":true}\n';
const model = { slug: 'known-model', display_name: 'Known', context_window: 1000000, base_instructions: 'Keep exact model instructions',
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }, { effort: 'ultra' }], input_modalities: ['text', 'image'] };
const initial = () => `model = 'mixr-main'
model_provider = "mixr-router"
review_model = "mixr-reviewer"
model_reasoning_effort = "max"
model_catalog_json = "catalog.json"
approval_policy = "never"
sandbox_mode = "danger-full-access"
developer_instructions = """Keep this
[not.a.real.table]
exactly"""

[model_providers."mixr-router"]
name = "Router"
base_url = "${router.ROUTER_URL}/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "${router.ROUTER_TOKEN}"
request_max_retries = 7
stream_idle_timeout_ms = 420000

[model_providers."mixr-router".http_headers]
"X-Client" = "keep"

[mcp_servers.test]
command = "node"
args = ["keep", "exact"]
`;

beforeEach(() => {
  fs.writeFileSync(codexFile, initial());
  fs.writeFileSync(claudeFile, originalClaude);
  fs.writeFileSync(path.join(temporary, 'catalog.json'), JSON.stringify({ models: [model] }));
  router._state.store = { claude: [], codex: [provider, chat] };
  router._state.current = { claude: '@router', codex: '@router', zcode: null };
  router._state.slotMap = { claude: {}, codex: { main: { provider: 'native' }, reviewer: { provider: 'chat' } } };
});
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test('Codex reads literal strings, quoted providers and multiline unrelated text', () => {
  const document = config.parse(initial());
  assert.equal(document.get('model'), 'mixr-main');
  assert.equal(document.get('model_providers', 'mixr-router', 'request_max_retries'), 7);
  assert.equal(document.get('not', 'a', 'real', 'table'), undefined);
  assert.equal(config.topLevel('"model" = "a\\\"b" # keep\n', 'model'), 'a"b');
});

test('Codex routing rewrite preserves actual effort, permissions, MCP and provider tuning', () => {
  router.switchCodexRouter();
  const text = fs.readFileSync(codexFile, 'utf8');
  const document = config.parse(text);
  assert.equal(document.get('model_reasoning_effort'), 'max');
  assert.equal(document.get('review_model'), 'mixr-reviewer');
  assert.equal(document.get('approval_policy'), 'never');
  assert.equal(document.get('sandbox_mode'), 'danger-full-access');
  assert.equal(document.get('model_providers', 'mixr-router', 'request_max_retries'), 7);
  assert.equal(document.get('model_providers', 'mixr-router', 'http_headers', 'X-Client'), 'keep');
  assert.ok(text.includes('[not.a.real.table]\nexactly"""'));
  assert.ok(text.includes('args = ["keep", "exact"]'));
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), originalClaude);
});

test('Codex status reports main, reviewer, effort and known capability gaps without credentials', () => {
  const live = router.liveState().codex;
  assert.equal(live.match, true);
  assert.equal(live.main.target, 'known-model');
  assert.equal(live.reviewer.target, 'unknown-model');
  assert.equal(live.model_reasoning_effort, 'max');
  assert.equal(live.main.context_window, 1000000);
  assert.deepEqual(live.main.reasoning_levels, ['low', 'max', 'ultra']);
  assert.ok(live.warnings.some(warning => warning.includes('Chat')));
  assert.ok(!JSON.stringify(live).includes(provider.api_key));
});

test('Codex drift detection checks endpoint, token and protocol, not just provider name', () => {
  for (const text of [initial().replace(`${router.ROUTER_URL}/v1`, 'https://wrong.example/v1'),
    initial().replace(`experimental_bearer_token = "${router.ROUTER_TOKEN}"`, 'experimental_bearer_token = "wrong"'),
    initial().replace('wire_api = "responses"', 'wire_api = "chat"')]) {
    fs.writeFileSync(codexFile, text);
    assert.equal(router.liveState().codex.match, false);
  }
});

test('Codex sync copies known metadata and registers unknown target identities without invented capabilities', () => {
  const original = fs.readFileSync(path.join(temporary, 'catalog.json'), 'utf8');
  const result = router.updateCodexConfig({ action: 'sync_catalog', revision: router.liveState().codex.revision });
  const generated = JSON.parse(fs.readFileSync(path.join(temporary, 'mixrouter-model-catalog.json'), 'utf8'));
  const alias = generated.models.find(item => item.slug === 'mixr-main');
  assert.deepEqual(alias, { ...model, slug: 'mixr-main', display_name: 'known-model · main', visibility: 'list', priority: 0,
    x_mixrouter: { target: 'known-model', capabilities_known: true } });
  const reviewer = generated.models.find(item => item.slug === 'mixr-reviewer');
  assert.equal(reviewer.x_mixrouter.capabilities_known, false);
  assert.equal(reviewer.context_window, undefined);
  assert.deepEqual(reviewer.supported_reasoning_levels, []);
  assert.equal(reviewer.base_instructions, '');
  assert.equal(generated.models.find(item => item.slug === 'known-model').visibility, 'hide');
  assert.deepEqual(result.unknown_aliases, ['mixr-reviewer']);
  assert.equal(fs.readFileSync(path.join(temporary, 'catalog.json'), 'utf8'), original);
  assert.equal(result.codex.model_reasoning_effort, 'max');
  assert.equal(result.codex.main.catalog_match, true);
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), originalClaude);
  router._state.slotMap.codex.main.provider = 'chat';
  assert.equal(router.liveState().codex.main.catalog_match, false);
  router.updateCodexConfig({ action: 'sync_catalog', revision: router.liveState().codex.revision });
  assert.equal(JSON.parse(fs.readFileSync(path.join(temporary, 'mixrouter-model-catalog.json'), 'utf8')).models.find(item => item.slug === 'mixr-main').x_mixrouter.capabilities_known, false);
});

test('Codex routed catalog retains Fast from a namespaced canonical model declaration', () => {
  const canonical = { ...model, slug: 'auto/known-model', service_tiers: [{ id: 'priority', name: 'Fast' }] };
  const source = JSON.stringify({ models: [canonical, { ...model, slug: 'provider/unknown-model' }] });
  fs.writeFileSync(path.join(temporary, 'catalog.json'), source);
  router.updateCodexConfig({ action: 'sync_catalog', revision: router.liveState().codex.revision });
  const generated = JSON.parse(fs.readFileSync(path.join(temporary, 'mixrouter-model-catalog.json'), 'utf8'));
  const main = generated.models.find(item => item.slug === 'mixr-main');
  assert.deepEqual(main.service_tiers, canonical.service_tiers);
  assert.deepEqual(main.supported_reasoning_levels, canonical.supported_reasoning_levels);
  assert.equal(main.x_mixrouter.capabilities_known, true);
  assert.equal(main.x_mixrouter.target, 'known-model');
  assert.equal(generated.models.find(item => item.slug === 'mixr-reviewer').x_mixrouter.capabilities_known, false);
  assert.equal(fs.readFileSync(path.join(temporary, 'catalog.json'), 'utf8'), source);
});

test('Codex catalog prefers the exact model declaration over the canonical namespaced fallback', () => {
  const canonical = { ...model, slug: 'auto/known-model', service_tiers: [{ id: 'priority', name: 'Fast' }] };
  const exact = { ...model, service_tiers: [], supported_reasoning_levels: [{ effort: 'max' }] };
  fs.writeFileSync(path.join(temporary, 'catalog.json'), JSON.stringify({ models: [canonical, exact] }));
  router.updateCodexConfig({ action: 'sync_catalog', revision: router.liveState().codex.revision });
  const main = JSON.parse(fs.readFileSync(path.join(temporary, 'mixrouter-model-catalog.json'), 'utf8'))
    .models.find(item => item.slug === 'mixr-main');
  assert.deepEqual(main.service_tiers, []);
  assert.deepEqual(main.supported_reasoning_levels, [{ effort: 'max' }]);
});

test('router catalog can recover a managed catalog without its source sidecar', t => {
  const directory = fs.mkdtempSync(path.join(temporary, 'sidecar-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const managed = path.join(directory, 'mixrouter-model-catalog.json');
  fs.writeFileSync(managed, JSON.stringify({ models: [model] }));
  const document = config.parse('model_catalog_json = "mixrouter-model-catalog.json"\n');
  const prepared = config.prepareCatalog(path.join(directory, 'config.toml'), document, [
    { alias: 'mixr-main', model: model.slug, provider: 'native', enabled: true, name: 'main' },
  ]);
  const generated = JSON.parse(prepared.content);
  assert.equal(generated.models.find(item => item.slug === 'mixr-main').context_window, model.context_window);
  assert.equal(prepared.source, null);
});

test('status never treats an unknown target placeholder as a capability declaration', () => {
  const placeholder = { slug: 'unknown-model', x_mixrouter: { capabilities_known: false } };
  fs.writeFileSync(path.join(temporary, 'catalog.json'), JSON.stringify({ models: [model, placeholder] }));
  const live = router.liveState().codex;
  assert.equal(live.reviewer.capabilities_known, false);
  assert.equal(live.reviewer.metadata_source, '');
  assert.equal(live.reviewer.context_window, null);
});

test('Codex direct catalog retains Fast from a namespaced canonical model declaration', () => {
  const canonical = { ...model, slug: 'auto/known-model', service_tiers: [{ id: 'priority', name: 'Fast' }] };
  fs.writeFileSync(path.join(temporary, 'catalog.json'), JSON.stringify({ models: [canonical] }));
  const prepared = config.prepareDirectCatalog(codexFile, config.read(codexFile).document, ['known-model']);
  const direct = JSON.parse(prepared.content).models.find(item => item.slug === 'known-model');
  assert.deepEqual(direct.service_tiers, canonical.service_tiers);
  assert.deepEqual(direct.supported_reasoning_levels, canonical.supported_reasoning_levels);
  assert.deepEqual(prepared.unknown, []);
});

test('Codex 目录同步按同渠道两个槽的显式模型分别复制能力', () => {
  const reviewerModel = { ...model, slug: 'review-target', display_name: 'Reviewer', context_window: 128000,
    supported_reasoning_levels: [{ effort: 'medium' }], input_modalities: ['text'] };
  fs.writeFileSync(path.join(temporary, 'catalog.json'), JSON.stringify({ models: [model, reviewerModel] }));
  router._state.slotMap.codex = { main: { provider: 'native', model: 'known-model' },
    reviewer: { provider: 'native', model: 'review-target' } };
  router.switchCodexRouter({ slots: true });
  const generated = JSON.parse(fs.readFileSync(path.join(temporary, 'mixrouter-model-catalog.json'), 'utf8'));
  assert.deepEqual(generated.models.find(item => item.slug === 'mixr-reviewer'),
    { ...reviewerModel, slug: 'mixr-reviewer', display_name: 'review-target · reviewer', visibility: 'list', priority: 1,
      x_mixrouter: { target: 'review-target', capabilities_known: true } });
  const live = router.liveState().codex;
  assert.equal(live.main.target, 'known-model');
  assert.equal(live.reviewer.target, 'review-target');
  assert.equal(live.reviewer.context_window, 128000);
  assert.deepEqual(live.reviewer.reasoning_levels, ['medium']);
  assert.equal(live.reviewer.catalog_match, true);
  assert.equal(config.read(codexFile).document.get('review_model'), 'mixr-reviewer');
  assert.equal(config.read(codexFile).document.get('model_reasoning_effort'), 'max');
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), originalClaude);
  assert.equal(provider.model, 'known-model');
});

test('Codex 换槽模型后不再暴露旧别名能力,同步后目录匹配恢复', () => {
  const alternate = { ...model, slug: 'alternate-target', context_window: 128000,
    supported_reasoning_levels: [{ effort: 'medium' }] };
  fs.writeFileSync(path.join(temporary, 'catalog.json'), JSON.stringify({ models: [model, alternate] }));
  router.updateCodexConfig({ action: 'sync_catalog', revision: router.liveState().codex.revision });
  router._state.slotMap.codex.main.model = 'alternate-target';
  let live = router.liveState().codex;
  assert.equal(live.main.catalog_match, false);
  assert.equal(live.main.target, 'alternate-target');
  assert.equal(live.main.metadata_source, 'alternate-target');
  assert.equal(live.main.context_window, 128000);
  assert.deepEqual(live.main.reasoning_levels, ['medium']);
  const before = fs.readFileSync(codexFile, 'utf8');
  assert.throws(() => router.updateCodexConfig({ action: 'reasoning', model_reasoning_effort: 'ultra', revision: live.revision }),
    error => error.statusCode === 400, '不能按旧模型档位接受保存');
  assert.equal(fs.readFileSync(codexFile, 'utf8'), before);
  router.updateCodexConfig({ action: 'sync_catalog', revision: live.revision });
  live = router.liveState().codex;
  assert.equal(live.main.catalog_match, true);
  assert.equal(live.main.metadata_source, 'mixr-main');
  assert.deepEqual(live.main.reasoning_levels, ['medium']);
  router._state.slotMap.codex.main.model = 'unknown-target';
  live = router.liveState().codex;
  assert.equal(live.main.catalog_match, false);
  assert.equal(live.main.context_window, null);
  assert.deepEqual(live.main.reasoning_levels, []);
  assert.equal(live.main.metadata_source, '');
  assert.ok(live.warnings.some(warning => warning.includes('落点能力未知')));
});

test('Codex stale revision and invalid reasoning are rejected without writes', () => {
  const version = router.liveState().codex.revision;
  fs.appendFileSync(codexFile, '\n# external change\n');
  const before = fs.readFileSync(codexFile, 'utf8');
  assert.throws(() => router.updateCodexConfig({ action: 'reasoning', model_reasoning_effort: 'low', revision: version }), error => error.statusCode === 409);
  assert.equal(fs.readFileSync(codexFile, 'utf8'), before);
  assert.throws(() => router.updateCodexConfig({ action: 'reasoning', model_reasoning_effort: 'invented', revision: router.liveState().codex.revision }), error => error.statusCode === 400);
  assert.equal(fs.readFileSync(codexFile, 'utf8'), before);
});

test('Codex reasoning updates only its selected key and supports model default', () => {
  router.updateCodexConfig({ action: 'reasoning', model_reasoning_effort: 'ultra', revision: router.liveState().codex.revision });
  assert.equal(router.liveState().codex.model_reasoning_effort, 'ultra');
  router.updateCodexConfig({ action: 'reasoning', model_reasoning_effort: null, revision: router.liveState().codex.revision });
  assert.equal(config.read(codexFile).document.get('model_reasoning_effort'), undefined);
  assert.equal(config.read(codexFile).document.get('approval_policy'), 'never');
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), originalClaude);
});

test('Codex refuses invalid TOML instead of replacing it with an empty config', () => {
  for (const text of ['model = "unterminated', 'model = "a"\nmodel = "b"', 'model = invalid', 'x = [1,\n']) {
    fs.writeFileSync(codexFile, text);
    assert.throws(() => router.switchCodexRouter());
    assert.equal(fs.readFileSync(codexFile, 'utf8'), text);
    // 写路径拒绝,读路径(**只读的 liveState**)不许跟着抛:降级成"当没有",并把原因带出来。
    const live = router.liveState().codex;
    assert.equal(live.match, false);
    assert.equal(typeof live.error, 'string', '读不出来要说得出原因,不能静默当空配置');
    assert.ok(live.warnings.some(warning => warning.includes('禁止写入')), '降级时要说明"不会以空配置覆盖原文件"');
  }
});

test('Codex refuses direct Chat and removes router-only reviewer aliases on direct Responses', () => {
  assert.throws(() => router.switchCodex(chat), error => error.statusCode === 400);
  assert.equal(fs.readFileSync(codexFile, 'utf8'), initial());
  router.switchCodex(provider);
  const document = config.read(codexFile).document;
  assert.equal(document.get('model_providers', 'mixr-native', 'base_url'), 'https://native.example/prefix/v1');
  assert.equal(document.get('review_model'), 'known-model');
  assert.equal(document.get('model_reasoning_effort'), 'max');
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), originalClaude);
});

test('Codex direct keeps newer real-model metadata even when the original catalog exists', () => {
  const sourceFile = path.join(temporary, 'catalog.json');
  const originalSource = fs.readFileSync(sourceFile, 'utf8');
  const currentModel = { ...model, visibility: 'list', service_tiers: ['priority'], default_reasoning_level: 'ultra' };
  fs.writeFileSync(path.join(temporary, 'mixrouter-model-catalog.json'), JSON.stringify({
    models: [currentModel, { ...model, slug: 'mixr-main', visibility: 'list', x_mixrouter: { target: model.slug } }],
  }));
  fs.writeFileSync(path.join(temporary, 'mixrouter-model-catalog.source.json'), JSON.stringify({ source: sourceFile }));
  fs.writeFileSync(codexFile, initial().replace('model_catalog_json = "catalog.json"',
    'model_catalog_json = "mixrouter-model-catalog.json"\nservice_tier = "fast"'));
  router.switchCodex(provider);
  const document = config.read(codexFile).document;
  const selectedCatalog = path.resolve(temporary, document.get('model_catalog_json'));
  const entries = JSON.parse(fs.readFileSync(selectedCatalog, 'utf8')).models;
  assert.deepEqual(entries.find(item => item.slug === model.slug), { ...currentModel, supported_in_api: true });
  assert.ok(entries.filter(item => item.slug.startsWith('mixr-')).every(item => item.visibility !== 'list'));
  assert.equal(document.get('service_tier'), 'fast');
  assert.equal(document.get('model_reasoning_effort'), 'max');
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), originalSource);
});

test('Codex direct recovers Fast from restored source metadata over an unknown placeholder', () => {
  const sourceFile = path.join(temporary, 'catalog.json');
  const declared = { ...model, service_tiers: [{ id: 'priority', name: 'Fast' }],
    additional_speed_tiers: ['fast'], default_service_tier: 'priority' };
  fs.writeFileSync(sourceFile, JSON.stringify({ models: [declared] }));
  fs.writeFileSync(path.join(temporary, 'mixrouter-model-catalog.json'), JSON.stringify({
    models: [{ slug: model.slug, supported_reasoning_levels: [], base_instructions: 'Keep local instructions',
      x_mixrouter: { capabilities_known: false } }],
  }));
  fs.writeFileSync(path.join(temporary, 'mixrouter-model-catalog.source.json'), JSON.stringify({ source: sourceFile }));
  fs.writeFileSync(codexFile, initial().replace('model_catalog_json = "catalog.json"',
    'model_catalog_json = "mixrouter-model-catalog.json"\nservice_tier = "fast"'));

  router.switchCodex(provider);
  router.updateCodexConfig({ action: 'sync_catalog', revision: router.liveState().codex.revision });
  const entries = JSON.parse(fs.readFileSync(path.join(temporary, 'mixrouter-model-catalog.json'), 'utf8')).models;
  const restored = entries.find(item => item.slug === model.slug);
  assert.deepEqual(restored.service_tiers, declared.service_tiers);
  assert.deepEqual(restored.additional_speed_tiers, ['fast']);
  assert.deepEqual(restored.supported_reasoning_levels, model.supported_reasoning_levels);
  assert.equal(restored.base_instructions, 'Keep local instructions');
  assert.notEqual(restored.x_mixrouter?.capabilities_known, false);
  assert.equal(config.read(codexFile).document.get('service_tier'), 'fast');
});

test('Codex speed selection persists both switches across direct and routed model changes', () => {
  for (const tier of ['ultrafast', 'fast']) {
    const result = router.updateCodexConfig({ action: 'service_tier', service_tier: tier,
      revision: router.liveState().codex.revision });
    assert.equal(result.restart_required, true);
    assert.equal(result.codex.service_tier, tier);
    assert.equal(result.codex.fast_mode, true);
    assert.equal(result.codex.ultrafast_mode, tier === 'ultrafast');
    router.switchCodex(provider);
    router.updateCodexConfig({ action: 'direct_models', model: 'known-model',
      revision: router.liveState().codex.revision });
    router.switchCodexRouter();
    const document = config.read(codexFile).document;
    assert.equal(document.get('service_tier'), tier);
    assert.equal(document.get('features', 'fast_mode'), true);
    assert.equal(document.get('features', 'ultrafast_mode'), tier === 'ultrafast');
    assert.equal(document.get('model_reasoning_effort'), 'max');
    assert.equal(fs.readFileSync(claudeFile, 'utf8'), originalClaude);
  }
  const text = fs.readFileSync(codexFile, 'utf8');
  assert.throws(() => router.updateCodexConfig({ action: 'service_tier', service_tier: 'off',
    revision: router.liveState().codex.revision }), /fast、ultrafast 或关闭/);
  assert.equal(fs.readFileSync(codexFile, 'utf8'), text);
  const off = router.updateCodexConfig({ action: 'service_tier', service_tier: null,
    revision: router.liveState().codex.revision });
  assert.equal(off.restart_required, true);
  assert.equal(off.codex.service_tier, '');
  assert.equal(off.codex.fast_mode, false);
  assert.equal(off.codex.ultrafast_mode, false);
  const closed = config.read(codexFile).document;
  assert.equal(closed.get('service_tier'), undefined, '关闭后删除 service_tier，而不是留一个空值');
  assert.equal(closed.get('features', 'fast_mode'), false);
  assert.equal(closed.get('features', 'ultrafast_mode'), false);
});

test('direct catalog recovers an unknown placeholder from an auto/<id> declaration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-catalog-auto-'));
  try {
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, 'model_catalog_json = "mixrouter-model-catalog.json"\n');
    fs.writeFileSync(path.join(dir, 'mixrouter-model-catalog.json'), JSON.stringify({ models: [
      { slug: 'gpt-x', x_mixrouter: { capabilities_known: false } },
    ] }));
    fs.writeFileSync(path.join(dir, 'mixrouter-model-catalog.source.json'),
      JSON.stringify({ source: path.join(dir, 'catalog.json') }));
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ models: [
      { ...model, slug: 'auto/gpt-x', service_tiers: [{ id: 'priority', name: 'Fast' }] },
    ] }));
    const prepared = config.prepareDirectCatalog(file, config.parse(fs.readFileSync(file, 'utf8')), ['gpt-x']);
    const generated = JSON.parse(prepared.content).models.find(item => item.slug === 'gpt-x');
    assert.deepEqual(generated.service_tiers, [{ id: 'priority', name: 'Fast' }],
      '恢复声明是 auto/<id> 时也要顶掉旧占位');
    assert.notEqual(generated.x_mixrouter?.capabilities_known, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('原始模型目录被删后同步不再抛裸 ENOENT(用托管副本里的原始模型继续)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-catalog-source-'));
  try {
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, 'model_catalog_json = "mixrouter-model-catalog.json"\n');
    fs.writeFileSync(path.join(dir, 'mixrouter-model-catalog.json'), JSON.stringify({ models: [
      { slug: 'gpt-x', display_name: 'X', visibility: 'list' },
      { slug: 'mixr-main', display_name: 'main', visibility: 'list' },
    ] }));
    fs.writeFileSync(path.join(dir, 'mixrouter-model-catalog.source.json'),
      JSON.stringify({ source: path.join(dir, 'gone.json') }));
    const prepared = config.prepareDirectCatalog(file, config.parse(fs.readFileSync(file, 'utf8')), ['gpt-x']);
    const generated = JSON.parse(prepared.content).models.find(item => item.slug === 'gpt-x');
    assert.equal(generated.visibility, 'list', '原目录没了也要能继续同步,不能每次保存都 500');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('一条 base_url 非法的 Codex 渠道不拖垮整份状态读取', () => {
  const file = path.join(temporary, 'state-invalid-base.toml');
  fs.writeFileSync(file, 'model_provider = "mixr-good"\n[model_providers.mixr-good]\n'
    + 'base_url = "https://good.example/v1"\nwire_api = "responses"\nexperimental_bearer_token = "sk-good"\n');
  const providers = [
    { id: 'bad', name: 'Bad', base_url: 'https://bad.example/v1?x=1', api_key: 'sk-bad' },
    { id: 'good', name: 'Good', base_url: 'https://good.example', api_key: 'sk-good', model: 'm', models: [] },
  ];
  const st = config.state(file, { current: 'good', providers, routerURL: 'http://127.0.0.1:8787', routerToken: 't', slots: [] });
  assert.equal(st.error, undefined, '非法渠道只该被跳过,不该让整份状态读取失败');
  assert.equal(st.match, true);
  assert.equal(st.direct_provider_id, 'good');
});

test('CRLF 配置照常解析,写回保持原换行', () => {
  const text = 'model = "a"\r\n[model_providers.mixr-x]\r\nname = "X"\r\n';
  assert.equal(config.parse(text).get('model'), 'a');
  const patched = config.patch(text, { top: { model_provider: 'mixr-x' },
    section: 'mixr-x', provider: { base_url: 'https://x.example/v1' } });
  assert.equal(config.parse(patched).get('model_provider'), 'mixr-x');
  assert.equal(config.parse(patched).get('model_providers', 'mixr-x', 'base_url'), 'https://x.example/v1');
  assert.match(patched, /\r\n/, '写回沿用原文件的 CRLF,不混入裸 LF');
  for (const line of patched.split('\r\n').slice(0, -1)) assert.doesNotMatch(line, /\n/);
});

test('点号键写 features 时继续用点号键,内联表则明确拒绝而不是写重复表', () => {
  const dotted = config.patch('features.web_search_request = true\n',
    { tables: [{ parts: ['features'], values: { fast_mode: true } }] });
  assert.match(dotted, /features\.fast_mode = true/);
  assert.doesNotMatch(dotted, /^\[features\]/m, '点号键已定义隐式表,不能再追加同名表头');
  const document = config.parse(dotted);
  assert.equal(document.get('features', 'fast_mode'), true);
  assert.equal(document.get('features', 'web_search_request'), true);

  assert.throws(() => config.patch('features = { web_search_request = true }\n',
    { tables: [{ parts: ['features'], values: { fast_mode: true } }] }), /已定义为值/,
  '内联表不能从外面追加键,必须报错而不是写坏 config.toml');
});

test('Codex preserves providers referenced by profiles and blocks ambiguous profile writes', () => {
  const text = '[model_providers.mixr-old]\nname = "Old"\n[profiles.ci]\nmodel_provider = "mixr-old"\n';
  const patched = config.patch(text, { top: { model_provider: 'mixr-new' }, section: 'mixr-new', provider: { name: 'New' } });
  assert.equal(config.parse(patched).get('model_providers', 'mixr-old', 'name'), 'Old');
  fs.writeFileSync(codexFile, 'profile = "ci"\n' + initial());
  assert.throws(() => router.switchCodexRouter(), error => error.statusCode === 400);
});

test('Codex TOML encoding safely round-trips newline and control characters', () => {
  const value = 'line\nnext\t"\\end';
  assert.equal(config.topLevel(`model = ${config.quote(value)}\n`, 'model'), value);
  assert.equal(config.topLevel('model = "\\U0001F680"\n', 'model'), '🚀');
});

test('Codex TOML quote emits a legal TOML basic string for every control character', () => {
  // TOML 1.0 要求 U+0000–U+0008、U+000A–U+001F、U+007F 必须转义。JSON 与 TOML 的转义
  // 语义一致,所以直接借 JSON.stringify 是安全的 —— **但 DEL 是例外**:JSON 允许原样输出,
  // TOML 不允许。这条把全部控制字符过一遍,漏掉任何一个都会在这里红。
  const escaped = /\\[btnfr"\\]|\\u[0-9a-fA-F]{4}/;
  for (let code = 0; code <= 0x1f; code++) {
    const raw = String.fromCharCode(code);
    const out = config.quote('a' + raw + 'b');
    assert.ok(escaped.test(out), `U+${code.toString(16).padStart(4, '0')} 未被转义: ${JSON.stringify(out)}`);
    assert.equal(config.topLevel(`model = ${out}\n`, 'model'), 'a' + raw + 'b', '转义后必须能读回原值');
  }
  // U+007F(DEL):JSON 会原样吐出来,TOML 要求写成 \u007f。
  assert.equal(config.quote('a\u007fb'), '"a\\u007fb"');
  assert.equal(config.topLevel(`model = ${config.quote('a\u007fb')}\n`, 'model'), 'a\u007fb');
  // 自己写出去的东西必须能过自己的还原校验器:写入侧与 backup/restore.js 的 TOML 规则
  // 不能各说各话(旧写入路径能吐出含裸 DEL 的文本,而 restore 按 TOML 规则拒绝它)。
  const { validateToml } = require('../lib/backup/restore');
  assert.doesNotThrow(() => validateToml(`model = ${config.quote('a\u007fb')}\n`));
  assert.throws(() => validateToml('model = "a\u007fb"\n'), /control character/, '裸 DEL 仍应被还原侧拒绝');
});

test('Codex TOML quote keeps its non-string and empty-input contracts', () => {
  // 这几个是既有断言钉住的契约,合并实现时不许丢。
  assert.equal(config.quote('a"b\\c'), '"a\\"b\\\\c"', '反斜杠必须先转,否则结尾 \\c 是非法转义');
  assert.equal(config.quote(null), '""');
  assert.equal(config.quote(undefined), '""');
  assert.equal(config.quote(''), '""');
  // 非字符串走 String(value ?? ''):数字与布尔写成它们的字面量串。
  assert.equal(config.quote(0), '"0"');
  assert.equal(config.quote(42), '"42"');
  assert.equal(config.quote(false), '"false"');
  // 有效的代理对原样保留(不拆成两个 \uXXXX),这样中文与 emoji 在文件里可读。
  assert.equal(config.quote('🚀'), '"🚀"');
  assert.equal(config.quote('中文'), '"中文"');
});

// —— 单一实现之后的兼容回归 ——
// lib/toml.js 与 lib/codex-toml.js 已退化成薄适配(见 test/toml.test.js、
// test/codex-toml.test.js 的"别名"断言)。下面几条把**同一份读法**在
// 各种写法上的行为钉在这里,免得将来有人为兼容旧调用又长出一份解析器。

test('Codex TOML reads quoted keys, literal strings and indentation the same way everywhere', () => {
  // 键本身带引号:双引号键要按基本字符串解转义,单引号键按字面量取。
  assert.equal(config.topLevel('"model" = "a\\"b"\n', 'model'), 'a"b');
  assert.equal(config.topLevel("'model_provider' = 'literal'\n", 'model_provider'), 'literal');
  // 缩进:默认(键值对两侧空白随意)必须读得到 —— 读漏了写入侧就会再补一条同名键,变成重复键。
  assert.equal(config.topLevel('  model  =  "indented"  # tail\n', 'model'), 'indented');
  // section 之后的同名键不算顶层。
  assert.equal(config.topLevel('[model_providers.x]\nmodel = "inside"\n', 'model'), '');
});

test('Codex TOML treats a duplicate top-level key as a broken document, not a first-wins read', () => {
  // 旧兼容读取器取第一条了事,写入侧却按"存在即替换"处理,两边对同一份文件的理解不一致。
  // 现在统一按坏文档拒绝:宁可让调用方去修文件,也不要按残值改写用户配置。
  assert.throws(() => config.parse('model = "a"\nmodel = "b"\n'), error => error.statusCode === 400 && /重复键/.test(error.message));
  assert.throws(() => config.topLevel('model = "a"\nmodel = "b"\n', 'model'), error => error.statusCode === 400);
  // section 之间互不影响:不同表下的同名键是正常的。
  assert.equal(config.parse('[a]\nx = 1\n[b]\nx = 2\n').get('b', 'x'), 2);
});

test('Codex TOML duplicate-key refusal names the offending key and its table', () => {
  // 现网已存在的文件若真有重复键,用户是在点保存时才撞上这条拒绝的。报错只说"重复键"
  // 而不说**哪个键**,用户就得自己把整份 config.toml 读一遍去猜 —— 所以文案必须带全路径,
  // 且带序号的是"行无法解析"那类,重复键这类要指得到具体键。
  const cases = [
    ['model = "a"\nmodel = "b"\n', 'model'],
    ['[model_providers.x]\nname = "a"\nname = "b"\n', 'model_providers.x.name'],
    ['[a.b]\nname = "a"\nname = "b"\n', 'a.b.name'],
    // 引号键与裸键指的是同一个键,归一之后按同一路径报。
    ['"model" = "a"\nmodel = "b"\n', 'model'],
  ];
  for (const [text, expected] of cases) {
    assert.throws(() => config.parse(text), error => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.message.includes(expected), `报错必须点名具体键 ${expected},实得: ${error.message}`);
      return true;
    });
  }
});

test('Codex TOML read paths degrade to "no value" instead of throwing on broken documents', () => {
  // 收窄只作用在**写入/校验**:`switchCodexRouter` / `writeCodexConfig` / `updateCodexConfig`
  // 撞上坏文档会拒绝(且不写盘)。只读的 `state()`(控制台状态)与 `liveState().codex`
  // 不许因此抛错 —— 读路径的契约是降级成"当没有配置",面板照常渲染并给出原因。
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-readonly-'));
  const file = path.join(temporary, 'config.toml');
  try {
    for (const text of ['model = "a"\nmodel = "b"\n', 'model = "unterminated', 'model = invalid', 'x = [1,\n', '[bad']) {
      fs.writeFileSync(file, text);
      // state() 不抛,降级成带 error 与 warnings 的形状。
      const state = config.state(file, { current: '@router', providers: [], routerURL: 'http://127.0.0.1:1', routerToken: 't' });
      assert.equal(state.match, false, '读不出来就不能报成"已匹配"');
      assert.equal(typeof state.error, 'string');
      assert.ok(state.warnings.length, '降级时要给出人话原因,不能静默');
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('Codex TOML rejects invalid or unsafe input instead of guessing a value', () => {
  for (const text of ['model = "unterminated', 'model = invalid', 'x = [1,\n', '[bad', 'model = "a\\q"\n']) {
    assert.throws(() => config.parse(text), error => error.statusCode === 400, `必须拒绝: ${JSON.stringify(text)}`);
    assert.throws(() => config.topLevel(text, 'model'), error => error.statusCode === 400);
  }
});

test('Codex TOML treats empty and comment-only text as an empty document, not an error', () => {
  // 空文本不是坏文档:read() 在 ENOENT 时也走这条路径,不能把"还没有配置"判成解析失败。
  for (const text of ['', '# 只有注释\n', '   \n']) {
    assert.equal(config.parse(text).get('model'), undefined);
    assert.equal(config.topLevel(text, 'model'), '');
    // 补进去的顶层键在**最前**,原有内容(含注释)一律留在原处 —— patch 只增删自己要动的行。
    const patched = config.patch(text, { top: { model: 'x' } });
    assert.equal(config.parse(patched).get('model'), 'x');
    assert.equal(patched.startsWith('model = "x"'), true);
    for (const kept of text.split('\n').filter(line => line.trim())) assert.ok(patched.includes(kept), `原有内容不许被吞: ${kept}`);
  }
  // 非字符串输入按空文档处理(旧兼容读取器的契约)。
  assert.equal(config.topLevel(null, 'model'), '');
  assert.equal(config.topLevel(undefined, 'model'), '');
});

test('Codex TOML leaves custom sections and profiles untouched when patching', () => {
  const text = ['model = "gpt-5.1"',
    '[profiles.ci]', 'model = "ci-model"', 'model_provider = "mixr-ci"',
    '[model_providers."quoted.provider"]', 'name = "用户自己的"',
    '[mcp_servers.test]', 'command = "node"'].join('\n');
  const patched = config.patch(text, { top: { model_provider: 'mixr-router' }, section: 'mixr-router', provider: { name: 'R' } });
  const document = config.parse(patched);
  // profile 表里的 model / model_provider 是 profile 自己的,不许被顶层改写碰到。
  assert.equal(document.get('profiles', 'ci', 'model'), 'ci-model');
  assert.equal(document.get('profiles', 'ci', 'model_provider'), 'mixr-ci');
  assert.equal(document.get('model_providers', 'quoted.provider', 'name'), '用户自己的');
  assert.equal(document.get('mcp_servers', 'test', 'command'), 'node');
  assert.equal(document.get('model_provider'), 'mixr-router');
  assert.equal(document.get('model'), 'gpt-5.1', '顶层 model 没在 top 里,必须原样留着');
});

test('Codex 热路径配置与模型目录源文件按文件签名缓存,变化后失效', () => {
  const { createClientManager } = require('../lib/clients/manager');
  const hotFile = path.join(temporary, 'hot-config.toml');
  const sourceFile = path.join(temporary, 'mixrouter-model-catalog.source.json');
  const write = legacy => {
    fs.writeFileSync(hotFile, ['model_provider = "mixr-router"',
      'model_catalog_json = "mixrouter-model-catalog.json"',
      '',
      '[model_providers.mixr-router]',
      'name = "Router"',
      `base_url = "${router.ROUTER_URL}/v1"`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      `experimental_bearer_token = "${router.ROUTER_TOKEN}"`,
      ''].join('\n'));
    fs.writeFileSync(sourceFile, JSON.stringify({ legacy_models: legacy }));
  };
  const manager = createClientManager({
    config: { CLAUDE_SETTINGS: claudeFile, CODEX_CONFIG: hotFile, PROVIDERS_FILE: path.join(temporary, 'providers.json'),
      SLOTS_FILE: path.join(temporary, 'slots.json'), ROUTER_ID: router.ROUTER_ID, ROUTER_URL: router.ROUTER_URL,
      ROUTER_TOKEN: router.ROUTER_TOKEN, ROUTER_SECTION: router.ROUTER_SECTION, PROXY_PORT: 0 },
    getStore: () => ({ claude: [], codex: [] }), getCurrent: () => ({ claude: '@router', codex: router.ROUTER_ID }),
    getSlotMap: () => ({ claude: {}, codex: {} }), setSlotMap: () => {},
    slotsPublic: () => ({ claude: {}, codex: [] }), slotTable: { slotsPublic: () => ({ codex: [] }) },
    setStoreWarnings: () => {}, findProvider: () => null,
  });
  const context = { token: router.ROUTER_TOKEN, ua: 'codex_desktop/0.162.1', session: 'cx:one' };
  write({ 'legacy-model': 'mixr-main' });
  assert.equal(manager.codexLegacyAlias('legacy-model', context), 'mixr-main');
  assert.equal(manager.codexLegacyAlias('unknown-model', context), '');

  // 文件未变:一次 readFileSync 都不该再发生(TOML 解析与 JSON 解析都省掉)。
  const reads = [];
  const realRead = fs.readFileSync;
  fs.readFileSync = (file, ...args) => { reads.push(String(file)); return realRead(file, ...args); };
  try {
    assert.equal(manager.codexLegacyAlias('legacy-model', context), 'mixr-main');
    assert.deepEqual(reads, []);
    write({ 'legacy-model': 'mixr-reviewer' });
    assert.equal(manager.codexLegacyAlias('legacy-model', context), 'mixr-reviewer');
    assert.equal(reads.filter(file => file === hotFile).length, 1, '配置变化后重新读取一次');
    assert.equal(reads.filter(file => file === sourceFile).length, 1, '源目录变化后重新读取一次');
  } finally {
    fs.readFileSync = realRead;
  }
});

test('手动速度声明只补 service_tiers / additional_speed_tiers，不猜其他能力', () => {
  const directory = fs.mkdtempSync(path.join(temporary, 'speed-declared-'));
  const file = path.join(directory, 'config.toml');
  fs.writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify({ models: [model] }));
  const document = config.parse('model_catalog_json = "catalog.json"\n');
  const slots = [{ alias: 'mixr-main', model: 'unknown-model', provider: 'native', enabled: true, name: 'main' }];

  const routed = JSON.parse(config.prepareCatalog(file, document, slots, {
    'unknown-model': ['fast', 'ultrafast'],
  }).content).models.find(item => item.slug === 'mixr-main');
  assert.deepEqual(routed.service_tiers.map(tier => tier.id), ['priority', 'ultrafast']);
  assert.deepEqual(routed.additional_speed_tiers, ['fast']);
  assert.equal(routed.x_mixrouter.capabilities_known, false, '速度声明不等于模型能力已知');
  assert.deepEqual(routed.supported_reasoning_levels, []);

  const fastOnly = JSON.parse(config.prepareCatalog(file, document, slots, {
    'unknown-model': ['fast'],
  }).content).models.find(item => item.slug === 'mixr-main');
  assert.deepEqual(fastOnly.service_tiers.map(tier => tier.id), ['priority']);

  const direct = JSON.parse(config.prepareDirectCatalog(file, document, ['unknown-model'], {
    'unknown-model': ['fast'],
  }).content).models.find(item => item.slug === 'unknown-model');
  assert.deepEqual(direct.service_tiers.map(tier => tier.id), ['priority']);
  assert.deepEqual(direct.additional_speed_tiers, ['fast']);

  const canonical = { ...model, slug: 'known-model', service_tiers: [{ id: 'priority', name: 'Fast' }] };
  fs.writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify({ models: [canonical] }));
  const merged = JSON.parse(config.prepareDirectCatalog(file, document, ['known-model'], {
    'known-model': ['fast', 'ultrafast'],
  }).content).models.find(item => item.slug === 'known-model');
  assert.deepEqual(merged.service_tiers.map(tier => tier.id), ['priority', 'ultrafast'], '已有声明不重复，只补缺的档');
});
