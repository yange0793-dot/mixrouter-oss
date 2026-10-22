'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  previewProviderImport, mergeProviderImport, redactProviderImportPreview,
} = require('../lib/provider-import');

const emptyStore = () => ({ version: 2, current: { claude: null, codex: null }, claude: [], codex: [] });
const storeWithExisting = () => ({
  version: 2,
  current: { claude: 'p1', codex: null },
  claude: [{ id: 'p1', name: 'Existing', base_url: 'https://existing.example', api_key: 'existing-key', models: ['m0'] }],
  codex: [],
});

test('mixrouter 格式:去重、不覆盖现有 key/current/id,预览序列化不含 key 正文', () => {
  const store = storeWithExisting();
  const input = {
    version: 2,
    current: { claude: 'pX', codex: 'cX' },
    claude: [
      { id: 'pZ', name: '重复现有', base_url: 'https://existing.example/', api_key: 'existing-key' },
      { id: 'p1', name: '新渠道', base_url: 'https://new.example', api_key: 'new-secret-key', models: ['m1', 'm1', ' m2 '] },
    ],
    codex: [{ name: '新 Codex', base_url: 'https://codex.example', api_key: 'codex-secret', model: 'gpt-x', wire_api: 'chat' }],
  };
  const { draft, summary, errors } = previewProviderImport(store, input);
  assert.deepEqual(errors, []);
  assert.equal(summary.duplicate_existing.claude, 1);
  assert.equal(summary.new.claude, 1);
  assert.equal(summary.new.codex, 1);
  assert.equal(draft.entries.length, 2);
  assert.equal(draft.entries[0].id, 'p2');
  assert.equal(draft.entries[1].id, 'c1');

  const serialized = JSON.stringify(draft);
  assert.ok(!serialized.includes('new-secret-key'));
  assert.ok(!serialized.includes('codex-secret'));
  assert.ok(serialized.includes('key_masked'));
  assert.ok(!JSON.stringify({ draft, summary, errors }).includes('new-secret-key'));
  assert.ok(!JSON.stringify(redactProviderImportPreview(draft)).includes('new-secret-key'));
  // 单独序列化 provider 也不会带出 key 正文(api_key 是草稿里的不可枚举属性)。
  assert.ok(!JSON.stringify(draft.entries[0].provider).includes('new-secret-key'));
  // 服务端草稿仍能读到真实 key,merge 需要它。
  assert.equal(draft.entries[0].provider.api_key, 'new-secret-key');

  const merged = mergeProviderImport(store, draft);
  assert.deepEqual(merged.current, { claude: 'p1', codex: null });
  assert.equal(merged.claude.length, 2);
  assert.equal(merged.claude[0].api_key, 'existing-key');
  assert.equal(merged.claude[1].id, 'p2');
  assert.deepEqual(merged.claude[1].models, ['m1', 'm2']);
  assert.equal(merged.codex[0].wire_api, 'chat');
  // 原 store 不被就地修改。
  assert.deepEqual(store, storeWithExisting());
});

test('cc-switch 行格式:claude env 与 codex TOML 都能识别,不支持的 app 跳过', () => {
  const rows = [
    {
      app_type: 'claude', name: 'CC Claude', notes: '备注',
      settings_config: JSON.stringify({ env: {
        ANTHROPIC_BASE_URL: 'https://cc.example/', ANTHROPIC_API_KEY: 'cc-key',
        ANTHROPIC_MODEL: 'cm', ANTHROPIC_DEFAULT_SONNET_MODEL: 'sm',
      } }),
    },
    {
      app_type: 'codex', name: 'CC Codex',
      settings_config: JSON.stringify({
        auth: { OPENAI_API_KEY: 'cx-key' },
        config: 'model = "gpt-x"\nmodel_provider = "x"\n[model_providers.x]\nbase_url = "https://cx.example/v1"\nwire_api = "responses"\n',
      }),
    },
    { app_type: 'gemini', name: '不支持' },
  ];
  const { draft, summary, errors } = previewProviderImport(emptyStore(), { providers: rows });
  assert.deepEqual(errors, []);
  assert.equal(summary.skipped, 1);
  assert.equal(draft.entries.length, 2);
  const claude = draft.entries.find(entry => entry.app === 'claude').provider;
  assert.equal(claude.base_url, 'https://cc.example');
  assert.equal(claude.api_key, 'cc-key');
  assert.deepEqual(claude.models, ['cm', 'sm']);
  assert.equal(claude.slots.sonnet, 'sm');
  const codex = draft.entries.find(entry => entry.app === 'codex').provider;
  assert.equal(codex.base_url, 'https://cx.example/v1');
  assert.equal(codex.api_key, 'cx-key');
  assert.equal(codex.model, 'gpt-x');
  assert.equal(codex.wire_api, 'responses');
  assert.ok(!JSON.stringify(draft).includes('cc-key'));
});

test('cc-switch 旧配置:providers 以对象键存放也能导入', () => {
  const input = {
    claude: { providers: { uuid: {
      name: '旧 Claude',
      settingsConfig: JSON.stringify({ env: {
        ANTHROPIC_BASE_URL: 'https://old-cc.example', ANTHROPIC_AUTH_TOKEN: 'old-cc-key',
        CLAUDE_CODE_SUBAGENT_MODEL: 'sub',
      } }),
    } } },
    codex: { providers: [{ name: '旧 Codex', auth: { OPENAI_API_KEY: 'old-cx-key' }, config: 'model = "g"\n[model_providers.k]\nbase_url = "https://old-cx.example/v1"\n' }] },
  };
  const { draft, errors } = previewProviderImport(emptyStore(), input);
  assert.deepEqual(errors, []);
  assert.equal(draft.entries.length, 2);
  const claude = draft.entries.find(entry => entry.app === 'claude').provider;
  assert.equal(claude.models.includes('sub'), true);
  assert.equal(claude.slots.subagent, 'sub');
  const codex = draft.entries.find(entry => entry.app === 'codex').provider;
  assert.equal(codex.api_key, 'old-cx-key');
  assert.equal(codex.model, 'g');
  assert.equal(codex.wire_api, 'responses');
});

test('严格校验 URL、Key、类型与占位值', () => {
  const cases = [
    { name: 'ftp URL', provider: { name: 'x', base_url: 'ftp://x.example', api_key: 'k' }, match: /http\(s\)/ },
    { name: '缺少 base_url', provider: { name: 'x', api_key: 'k' }, match: /base_url 必填/ },
    { name: '缺少 key', provider: { name: 'x', base_url: 'https://x.example' }, match: /API Key 必填/ },
    { name: 'key 不是字符串', provider: { name: 'x', base_url: 'https://x.example', api_key: 42 }, match: /API Key 必须是字符串/ },
    { name: 'key 带换行', provider: { name: 'x', base_url: 'https://x.example', api_key: 'a\nb' }, match: /控制字符/ },
    { name: '路由占位 key', provider: { name: 'x', base_url: 'https://x.example', api_key: 'PROXY_MANAGED' }, match: /占位/ },
    { name: 'enabled 类型错', provider: { name: 'x', base_url: 'https://x.example', api_key: 'k', enabled: 'yes' }, match: /布尔值/ },
    { name: 'models 元素类型错', provider: { name: 'x', base_url: 'https://x.example', api_key: 'k', models: ['ok', 5] }, match: /模型列表/ },
    { name: 'slots 类型错', provider: { name: 'x', base_url: 'https://x.example', api_key: 'k', slots: ['opus'] }, match: /slots 必须是对象/ },
    { name: 'codex 缺 model', app: 'codex', provider: { name: 'x', base_url: 'https://x.example', api_key: 'k' }, match: /模型名 必填/ },
  ];
  for (const item of cases) {
    const app = item.app || 'claude';
    const input = app === 'codex' ? { codex: [item.provider] } : { claude: [item.provider] };
    const { draft, summary, errors } = previewProviderImport(emptyStore(), input);
    assert.equal(errors.length, 1, item.name);
    assert.match(errors[0].message, item.match, item.name);
    assert.equal(summary.rejected, 1, item.name);
    assert.equal(draft.entries.length, 0, item.name);
  }
});

test('拒绝原型污染字段,且输入非法 JSON 直接失败', () => {
  assert.throws(() => previewProviderImport(emptyStore(), '{"__proto__":{"polluted":true}}'),
    error => error.statusCode === 400 && /非法字段名/.test(error.message));
  // 对象字面量里的 __proto__ 会改原型而不是建自有键;用 JSON 文本构造真正的自有键。
  assert.throws(() => previewProviderImport(emptyStore(),
    '{"claude":[{"name":"x","base_url":"https://x.example","api_key":"k","slots":{"__proto__":{"polluted":true}}}]}'),
    error => error.statusCode === 400 && /非法字段名/.test(error.message));
  assert.throws(() => previewProviderImport(emptyStore(), {
    claude: [{ name: 'x', base_url: 'https://x.example', api_key: 'k', meta: { constructor: { x: 1 } } }],
  }), error => error.statusCode === 400 && /非法字段名/.test(error.message));
  assert.throws(() => previewProviderImport(emptyStore(), '{not json'), /不是合法 JSON/);
  assert.throws(() => previewProviderImport(emptyStore(), { nothing: true }), /没有识别到可导入的渠道/);
});

test('merge 不信任回传草稿:脱敏后的草稿不能合并,篡改字段会被重新校验', () => {
  const { draft } = previewProviderImport(emptyStore(), {
    claude: [{ name: 'x', base_url: 'https://x.example', api_key: 'real-secret', models: ['m'] }],
  });
  const roundTripped = JSON.parse(JSON.stringify(draft));
  assert.throws(() => mergeProviderImport(emptyStore(), roundTripped), /API Key 必填/);

  const tampered = {
    kind: 'mixrouter-providers',
    version: 1,
    entries: [{ app: 'claude', id: 'p1', provider: { name: 'x', base_url: 'not-a-url', api_key: 'k' } }],
  };
  assert.throws(() => mergeProviderImport(emptyStore(), tampered), /http\(s\)/);
  assert.throws(() => mergeProviderImport({ nope: true }, draft), /渠道库格式无效/);
});

test('merge 遇到已有 id 会重新分配,重复渠道不会覆盖', () => {
  const store = storeWithExisting();
  const draft = {
    kind: 'mixrouter-providers',
    version: 1,
    entries: [
      { app: 'claude', id: 'p1', provider: { name: '占 id', base_url: 'https://new-a.example', api_key: 'a-key' } },
      { app: 'claude', id: 'p99', provider: { name: '重复现有', base_url: 'https://existing.example/', api_key: 'existing-key' } },
    ],
  };
  const merged = mergeProviderImport(store, draft);
  assert.equal(merged.claude.length, 2);
  assert.equal(merged.claude[1].name, '占 id');
  assert.notEqual(merged.claude[1].id, 'p1');
  assert.equal(merged.claude[0].api_key, 'existing-key');
  assert.equal(merged.current.claude, 'p1');
});

test('未知字段不会进入合并结果', () => {
  const { draft } = previewProviderImport(emptyStore(), {
    claude: [{ name: 'x', base_url: 'https://x.example', api_key: 'k', evil: 'payload', keys: [{ key: 'other' }] }],
  });
  const merged = mergeProviderImport(emptyStore(), draft);
  const provider = merged.claude[0];
  for (const key of ['evil', 'keys']) assert.equal(Object.hasOwn(provider, key), false);
});
