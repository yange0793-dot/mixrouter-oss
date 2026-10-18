'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codeRevision } = require('../lib/runtime-code');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-code-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'mixrouter.js'), 'server-v1');
  fs.writeFileSync(path.join(root, 'lib', 'wire-responses.js'), 'wire-v1');
  return root;
}

test('运行源码指纹:内容变化即变化,恢复内容即恢复,不按 mtime 猜', t => {
  const root = fixture(t);
  const original = codeRevision(root);
  assert.match(original, /^[a-f0-9]{64}$/);
  const file = path.join(root, 'lib', 'wire-responses.js');
  const stat = fs.statSync(file);
  fs.writeFileSync(file, 'wire-v2');
  fs.utimesSync(file, stat.atime, stat.mtime);
  assert.notEqual(codeRevision(root), original, '即使时间戳相同也要发现旧进程');
  fs.writeFileSync(file, 'wire-v1');
  assert.equal(codeRevision(root), original);
  fs.writeFileSync(path.join(root, 'mixrouter.js'), 'server-v2');
  assert.notEqual(codeRevision(root), original);
});

test('运行源码指纹:新模块及子目录纳入,配置/测试/文档/日志不触发重启提示', t => {
  const root = fixture(t);
  const original = codeRevision(root);
  for (const file of ['providers.json', 'routes.json', 'slots.json', 'sessions.json', 'README.md', 'mixctl']) {
    fs.writeFileSync(path.join(root, file), 'runtime data');
  }
  for (const dir of ['test', 'logs', 'public']) {
    fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, dir, 'file.js'), 'not loaded by server');
  }
  assert.equal(codeRevision(root), original);
  fs.mkdirSync(path.join(root, 'lib', 'nested'));
  const added = path.join(root, 'lib', 'nested', 'new.js');
  fs.writeFileSync(added, 'new module');
  assert.notEqual(codeRevision(root), original);
  fs.unlinkSync(added);
  assert.equal(codeRevision(root), original);
});

test('运行源码指纹:缺源码返回无法核对,不抛异常或伪造成功', t => {
  const root = fixture(t);
  fs.unlinkSync(path.join(root, 'mixrouter.js'));
  assert.equal(codeRevision(root), '');
  assert.equal(codeRevision(path.join(root, 'missing')), '');
});
