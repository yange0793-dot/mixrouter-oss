'use strict';
// lib/toml.js 现在只是 lib/codex-config.js 的薄适配。这个文件钉住:
//   1) 旧名字(codexTopLevel / tomlStr)确实还指向同一份实现
//   2) 顶层键的**认法**——这是最容易漂移的一处(缩进、引号键、第一个 section 为界)
//   3) 转义闭环:写出去的东西必须能被自己的读法读回原值
const { test } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../lib/codex-config');
const { tomlStr, codexTopLevel } = require('../lib/toml');

test('toml:两个导出都是 codex-config 的别名,不是第二份实现', () => {
  assert.equal(tomlStr, config.quote);
  assert.equal(codexTopLevel, config.topLevel);
});

test('toml:codexTopLevel 只认第一个 [section] 之前的键,且容忍缩进', () => {
  const text = '  model = "a"\nmodel_provider = "b"\n[model_providers.x]\nmodel = "c"\n';
  assert.equal(codexTopLevel(text, 'model'), 'a', '带缩进的顶层键必须读得到');
  assert.equal(codexTopLevel(text, 'model_provider'), 'b');
  assert.equal(codexTopLevel('[s]\nmodel = "c"\n', 'model'), '', 'section 之后的同名键不算顶层');
  // 行尾注释与键侧空白都要吃掉,否则读出来的值会带一串尾巴。
  assert.equal(codexTopLevel('  model_provider  =  "b"  # tail\n', 'model_provider'), 'b');
});

test('toml:带引号的键与转义字符串按 TOML 语义读', () => {
  assert.equal(codexTopLevel('"model" = "a\\"b" # keep\n', 'model'), 'a"b');
  assert.equal(codexTopLevel("'model' = \"literal\"\n", 'model'), 'literal');
  assert.equal(codexTopLevel('model = "\\U0001F680"\n', 'model'), '\u{1F680}');
  // 没有这个键 → 空串(旧契约:调用方按空串判"没配置")
  assert.equal(codexTopLevel('model = "a"\n', 'review_model'), '');
});

test('toml:缩进、重复键、非法与空文本走同一套判定', () => {
  // 重复键不再"取第一条了事":同一份文档里出现两次就是坏文档,与写入侧同判。
  assert.throws(() => codexTopLevel('model = "a"\nmodel = "b"\n', 'model'), error => error.statusCode === 400);
  // 空文本不是错误,读出来就是空(ENOENT 时 read() 也走这条)。
  assert.equal(codexTopLevel('', 'model'), '');
  assert.equal(codexTopLevel(null, 'model'), '');
  assert.equal(codexTopLevel('# 只有注释\n', 'model'), '');
  for (const bad of ['model = "unterminated', 'model = invalid', 'x = [1,\n', '[bad']) {
    assert.throws(() => codexTopLevel(bad, 'model'), error => error.statusCode === 400,
      `坏文档必须拒绝而不是猜一个值: ${JSON.stringify(bad)}`);
  }
});

test('toml:tomlStr 写出的是合法 TOML 基本字符串(换行与控制字符也要转义)', () => {
  assert.equal(tomlStr('a"b\\c'), '"a\\"b\\\\c"', '反斜杠必须先转,否则结尾 \\c 是非法转义');
  assert.equal(tomlStr(null), '""');
  assert.equal(tomlStr(undefined), '""');
  // 旧实现只转义 \ 和 ",换行会原样吐进字符串里写出非法 TOML。这里钉住现在的宽契约。
  assert.equal(tomlStr('line\nnext'), '"line\\nnext"');
  assert.equal(tomlStr('tab\there'), '"tab\\there"');
  // 往返:写出去的值必须能被同一套读法读回。
  for (const value of ['plain', 'a"b\\c', 'line\nnext\t"\\end', '\u{1F680}', '中文', '']) {
    assert.equal(codexTopLevel(`model = ${tomlStr(value)}\n`, 'model'), value, `往返失败: ${JSON.stringify(value)}`);
  }
});
