'use strict';
// Harness 集成已从控制台移除:这一页、脚本、样式与导航入口都不该再出现。
// 这里只做静态断言(不装浏览器、不发请求、不写任何配置),
// 保留原来的文件名,好让"Harness UI 已删"这件事仍有回归。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const exists = (...parts) => fs.existsSync(path.join(ROOT, ...parts));

const INDEX = read('public', 'index.html');
const APP = read('public', 'js', 'app.js');
const WORKSPACE = read('public', 'js', 'workspace.js');
const STYLES = ['base.css', 'config.css', 'observe.css', 'providers.css', 'readiness.css', 'usage.css']
  .map(name => read('public', 'styles', name)).join('\n');

test('Harness 页面脚本与样式已删除,index.html 不再加载它们', () => {
  assert.equal(exists('public', 'js', 'harness.js'), false, 'public/js/harness.js 应已删除');
  assert.equal(exists('public', 'styles', 'harness.css'), false, 'public/styles/harness.css 应已删除');
  assert.doesNotMatch(INDEX, /\/js\/harness\.js/);
  assert.doesNotMatch(INDEX, /\/styles\/harness\.css/);
});

test('index.html 不再有 Harness 视图、导航或控件', () => {
  for (const marker of ['id="view-harness"', 'data-view="harness"', 'href="#harness"',
    'id="harness-main"', 'id="harness-pool"', 'id="harness-preview"', 'id="harness-status"']) {
    assert.equal(INDEX.includes(marker), false, `index.html 不应再有 ${marker}`);
  }
});

test('app.js 不再调用 Harness 钩子或引它的 DOM', () => {
  assert.doesNotMatch(APP, /harnessSetVisible/);
  assert.doesNotMatch(APP, /\$\(\s*'harness-/);
  assert.doesNotMatch(APP, /view-harness/);
  assert.doesNotMatch(APP, /'harness'/);
});

test('外壳没有 Harness 视图、图标或快速跳转入口', () => {
  assert.doesNotMatch(WORKSPACE, /harness/iu);
  assert.doesNotMatch(STYLES, /#view-harness|\.harness-/);
});
