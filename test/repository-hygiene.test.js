'use strict';
// 公共源码的隐私边界与用户文档链接,不扫描或输出任何真实运行配置。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

function ignoredFiles(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-ignore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.join(ROOT, '.gitignore'), path.join(root, '.gitignore'));
  execFileSync('git', ['init', '--quiet', root], { stdio: 'pipe' });
  return execFileSync('git', ['-C', root, 'check-ignore', '--stdin'], {
    input: files.join('\n') + '\n', encoding: 'utf8',
  }).trim().split('\n');
}

test('gitignore 包含运行配置、原子写临时名、日志和客户端备份', t => {
  const configs = ['providers.json', 'routes.json', 'sessions.json', 'slots.json'];
  const files = [
    ...configs,
    ...configs.map(name => name + '.1760700000000-' + 'a'.repeat(32) + '.tmp'),
    'logs/requests.jsonl', '.run/mixrouter.pid', 'backups/providers.json', '.env', '.env.local',
    'settings.json.bak-mixui-20261018-000000-000-abcd',
  ];
  assert.deepEqual(ignoredFiles(t, files), files);
});

test('源码索引没有误跟踪运行数据或环境凭据', () => {
  const { isRuntimeData } = require('../scripts/release-manifest');
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const unsafe = tracked.filter(file => isRuntimeData(file)
    || /^\.env(?:\.|$)/.test(file) && file !== '.env.example');
  assert.deepEqual(unsafe, [], '运行数据即使被强制加入索引也不能公开');
});

test('公开用户文档的相对文件链接都存在,不指向作者机器绝对目录', () => {
  const docs = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md',
    'docs/quick-start.md', 'docs/routing-and-sessions.md', 'docs/troubleshooting.md',
    'docs/offline-run-and-acceptance.md', 'docs/upgrade-and-rollback.md'];
  const reference = path.join(ROOT, 'docs/reference.md');
  if (fs.existsSync(reference)) docs.push('docs/reference.md');
  for (const relative of docs) {
    const file = path.join(ROOT, relative);
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\/Users\/[^/\s]+\/Documents\/zcode\//, relative);
    for (const match of text.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      const href = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href)) continue;
      const target = decodeURIComponent(href.split('#')[0]);
      if (!target) continue;
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), target)), `${relative}: ${href}`);
    }
  }
});
