'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

// 入口文档、承接完整边界的文档,以及全部 docs/*.md 用户文档(不含内部记录 docs/changes/)。
// 链接检查只做本地文件存在性,不联网。
const DOCS = ['README.md', 'README.en.md', 'CONTRIBUTING.md', 'SUPPORT.md', 'SECURITY.md',
  'docs/cli.md', 'docs/installation.md', 'docs/quick-start.md', 'docs/routing-and-sessions.md',
  'docs/troubleshooting.md', 'docs/reference.md', 'docs/upgrade-and-rollback.md',
  'docs/offline-run-and-acceptance.md'];

function localLinks(text) {
  const links = [];
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
    links.push(target);
  }
  return links;
}

test('入口文档里的本地链接都指向仓库中存在的文件', () => {
  for (const doc of DOCS) {
    const dir = path.dirname(doc);
    for (const target of localLinks(read(doc))) {
      const file = target.split('#')[0].split('?')[0];
      if (!file) continue;
      const resolved = path.resolve(root, dir, file);
      assert.ok(fs.existsSync(resolved), `${doc} 的链接不存在: ${target}`);
      assert.ok(resolved.startsWith(root + path.sep), `${doc} 的链接越出仓库: ${target}`);
    }
  }
});

test('README 是项目入口，并链接到完整命令文档', () => {
  const zh = read('README.md');
  const en = read('README.en.md');
  for (const text of ['适用与不适用', '核心能力', '三分钟起步', '支持矩阵', '## 文档',
    '## 开发与测试', '支持、贡献与安全', 'docs/cli.md', 'SUPPORT.md', 'CONTRIBUTING.md',
    'SECURITY.md']) {
    assert.ok(zh.includes(text), `README.md 缺少入口段落或链接: ${text}`);
  }
  for (const text of ["Who it is for", "What it does", "Quick start", "Support matrix",
    "## Documentation", "Development and tests", "Support, contributing, and security",
    'docs/cli.md', 'SUPPORT.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
    assert.ok(en.includes(text), `README.en.md 缺少入口段落或链接: ${text}`);
  }
  assert.ok(zh.includes('[English](README.en.md)'));
  assert.ok(en.includes('[中文](README.md)'));
});

test('入口文档与 CLI 文档不写死本机路径或真实凭据', () => {
  const text = ['README.md', 'README.en.md', 'docs/cli.md', 'SUPPORT.md', 'CONTRIBUTING.md']
    .map(read).join('\n');
  assert.doesNotMatch(text, /\/Users\/[A-Za-z0-9._-]+/);
  assert.doesNotMatch(text, /[A-Za-z]:\\\\Users\\\\/);
  assert.doesNotMatch(text, /sk-[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(text, /(?:cc|cx|fp|cxf):[0-9a-f]{8,}/i);
});

test('支持文档明确没有商业 SLA 或固定响应时间', () => {
  const support = read('SUPPORT.md');
  assert.ok(support.includes('不提供商业支持、SLA 或固定响应时间'));
  assert.ok(support.includes('Windows'));
  assert.ok(support.includes('SECURITY.md'));
  assert.ok(support.includes('数据目录路径'), 'SUPPORT 必须提醒 doctor JSON 含数据目录路径');
});

test('贡献指南把制品验收限定在可信的 HEAD 或已解包目录', () => {
  const contributing = read('CONTRIBUTING.md');
  for (const text of ['npm run verify:release', '--dir', 'HEAD', '已跟踪', 'npm run local',
    'docs/installation.md']) {
    assert.ok(contributing.includes(text), `CONTRIBUTING.md 缺少制品验收边界: ${text}`);
  }
  // 不能把工作区未提交的改动当成已验证的制品。
  assert.match(contributing, /未提交的新增文件不会进包/, '必须说明默认模式只验 HEAD 已跟踪文件');
});

test('快速开始区分前台与后台重启,并提醒旧运行包不含新入口', () => {
  const quickStart = read('docs/quick-start.md');
  const restart = quickStart.split('## 5. 改完代码之后')[1];
  assert.ok(restart, '快速开始必须保留改代码后的操作说明');
  for (const text of ['前台 `npm run local`', 'Ctrl+C', '不由 `mixctl restart` 管理',
    'npm run doctor', '后台 `./mixctl start`', './mixctl status']) {
    assert.ok(restart.includes(text), `重启说明缺少: ${text}`);
  }
  assert.match(quickStart, /v3\.6\.1[\s\S]{0,200}npm start/);
});

test('新入口文档与已发布运行包的边界一致', () => {
  const zh = read('README.md');
  const en = read('README.en.md');
  const cli = read('docs/cli.md');
  const entry = `${zh}\n${cli}`;
  for (const text of ['npm run local', 'npm run doctor', 'npm run --silent doctor -- --json',
    '不需要 `npm install`', '拒绝静默开空库', '没有 pid 文件']) {
    assert.ok(entry.includes(text), `入口文档缺少: ${text}`);
  }
  assert.ok(zh.includes('源码目录'), 'README 必须说明在源码目录运行');
  // 新入口写清起始版本;旧运行包必须给出可用命令。
  assert.ok(zh.includes('从 v3.7.0 起提供'));
  assert.ok(/v3\.6\.1[\s\S]{0,200}npm start/.test(zh), 'v3.6.1 运行包必须指向 npm start');
  // 只说本项目未提供官方 npm 安装包,不断言整个 npm 上没有同名包。
  assert.ok(zh.includes('未提供官方 npm 安装包'));
  assert.doesNotMatch(zh, /没有(?:对应的|这个)?包|npm 上不存在/);
  // 不声称免 Node 安装。
  assert.doesNotMatch(zh + en, /无需安装 Node|免 ?Node|不需要安装 Node/);
  assert.ok(en.includes('does not provide an official npm package'));
});
