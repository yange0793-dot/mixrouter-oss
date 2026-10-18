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

test('Codex sync copies only known model metadata and preserves the original catalog', () => {
  const original = fs.readFileSync(path.join(temporary, 'catalog.json'), 'utf8');
  const result = router.updateCodexConfig({ action: 'sync_catalog', revision: router.liveState().codex.revision });
  const generated = JSON.parse(fs.readFileSync(path.join(temporary, 'mixrouter-model-catalog.json'), 'utf8'));
  const alias = generated.models.find(item => item.slug === 'mixr-main');
  assert.deepEqual(alias, { ...model, slug: 'mixr-main', display_name: 'mixr-main · known-model' });
  assert.equal(generated.models.some(item => item.slug === 'mixr-reviewer'), false);
  assert.deepEqual(result.unknown_aliases, ['mixr-reviewer']);
  assert.equal(fs.readFileSync(path.join(temporary, 'catalog.json'), 'utf8'), original);
  assert.equal(result.codex.model_reasoning_effort, 'max');
  assert.equal(result.codex.main.catalog_match, true);
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), originalClaude);
  router._state.slotMap.codex.main.provider = 'chat';
  assert.equal(router.liveState().codex.main.catalog_match, false);
  router.updateCodexConfig({ action: 'sync_catalog', revision: router.liveState().codex.revision });
  assert.equal(JSON.parse(fs.readFileSync(path.join(temporary, 'mixrouter-model-catalog.json'), 'utf8')).models.some(item => item.slug === 'mixr-main'), false);
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
