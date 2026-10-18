'use strict';
// lib/codex-toml.js 现在只是 lib/codex-config.js 的薄适配。这个文件钉住两件事:
//   1) **契约**没跟着实现搬家一起消失(删自己的 section、留用户的、原位替换、没有才插最前)
//   2) 壳与实现**真的是同一个函数**,不是又长出来的一份复制品
// 第 2 条是这轮合并的要点:只断言行为的话,将来有人把算法抄回来,下面这些断言照样全绿。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../lib/codex-config');
const codexToml = require('../lib/codex-toml');

const { removeOwnSections, setTopLevel, providerSection } = codexToml;

test('codex-toml:导出面是 codex-config 的别名,不是第二份实现', () => {
  assert.equal(codexToml.removeOwnSections, config.removeOwnSections);
  assert.equal(codexToml.setTopLevel, config.setTopLevel);
  assert.equal(codexToml.providerSection, config.providerSection);
  assert.equal(codexToml.buildCodexConfig, config.providerSection, '旧名字 buildCodexConfig 直接指向 providerSection');
  assert.equal(codexToml.tomlStr, config.quote);
  assert.equal(codexToml.codexTopLevel, config.topLevel);
  assert.equal(codexToml.MIXR_SECTION_RE, config.MIXR_SECTION_RE);
});

test('codex-toml:自己的 section 删干净,用户的 section 与正文一行不碰', () => {
  const kept = removeOwnSections([
    'model = "keep-me"',
    '[model_providers.mixr-old]',
    'name = "旧"',
    'user_line_inside = "也跟着删"',
    '[model_providers.user]',
    'name = "用户的"',
  ].join('\n'));
  assert.deepEqual(kept, ['model = "keep-me"', '[model_providers.user]', 'name = "用户的"'],
    '只删自己写的 section(含它的正文),用户自己的 section 与它的正文都要在');

  // 只认 model_providers.mixr-* :名字像但不是这个前缀的,以及别的表,都不许动。
  const untouchable = ['[model_providers.mixrouter]', 'name = "不是我们写的"', '[mcp_servers.mixr-x]', 'command = "node"'].join('\n');
  assert.deepEqual(removeOwnSections(untouchable), untouchable.split('\n'),
    '前缀只对 model_providers 生效,别的表里叫 mixr- 也不能删');
});

test('codex-toml:顶层键原位替换;原本没有的才补到最前', () => {
  const kept = ['model = "keep-me"', '[model_providers.user]', 'name = "用户的"'];
  const r = setTopLevel(kept, { section: 'mixr-new', model: 'gpt-5.1', keepModel: false });
  // kept 里已经有顶层 model → 原位替换,不新增;model_provider 原本没有 → 补到最前。
  assert.deepEqual(r.lines, ['model_provider = "mixr-new"', 'model = "gpt-5.1"', '[model_providers.user]', 'name = "用户的"']);
  assert.equal(r.hasModel, true);
  assert.equal(r.hasProvider, false);

  // 空文件:两个顶层键都要补,顺序是 model 在前。
  assert.deepEqual(setTopLevel([], { section: 's', model: 'm', keepModel: true }).lines,
    ['model = "m"', 'model_provider = "s"']);
});

test('codex-toml:keepModel 时顶层模型名原样,不被入参覆盖', () => {
  const keep = setTopLevel(['model = "原样"', '[x]'], { section: 's', model: '别的', keepModel: true });
  assert.deepEqual(keep.lines, ['model_provider = "s"', 'model = "原样"', '[x]'],
    '路由模式靠顶层 model 匹配,不能被路由模式的入参改掉');
  assert.equal(keep.hasModel, true);
  assert.equal(keep.hasProvider, false, '输入里没有顶层 model_provider,补了一条也算"原本没有"');
});

test('codex-toml:providerSection 生成可被 codex-config 解析的 section,wire_api 缺省 responses', () => {
  const lines = providerSection({ section: 'mixr-test', name: 'local', base_url: 'https://example.invalid/v1', api_key: 'k', wire_api: 'responses' });
  const text = ['model = "m"', ...lines].join('\n');
  const document = config.parse(text);
  assert.equal(document.get('model_providers', 'mixr-test', 'name'), 'local');
  assert.equal(document.get('model_providers', 'mixr-test', 'requires_openai_auth'), false);
  assert.equal(document.get('model_providers', 'mixr-test', 'experimental_bearer_token'), 'k');
  // 缺省 wire_api 也要写出来:少这一行,Codex 侧就没有明确的协议声明。
  const bare = providerSection({ section: 's', name: 'n', base_url: 'b', api_key: 'k' });
  assert.equal(bare.find(line => line.startsWith('wire_api')), 'wire_api = "responses"');
});

test('codex-toml:空文本与非字符串输入不抛,按空文档处理', () => {
  assert.deepEqual(removeOwnSections(''), ['']);
  assert.deepEqual(removeOwnSections(null), ['']);
  assert.deepEqual(removeOwnSections(undefined), ['']);
  assert.equal(codexToml.codexTopLevel('', 'model'), '');
});

test('codex-toml:写出去的转义与 codex-config 的读法闭环', () => {
  // 值里带反斜杠与双引号:写出来的字符串必须能被同一套 parse 读回原值。
  const value = 'a"b\\c\nd';
  const lines = providerSection({ section: 's', name: value, base_url: 'https://example.invalid/v1', api_key: 'k' });
  const document = config.parse(['model = "m"', ...lines].join('\n'));
  assert.equal(document.get('model_providers', 's', 'name'), value);
  assert.equal(codexToml.tomlStr(value), '"' + 'a\\"b\\\\c\\nd' + '"');
});
