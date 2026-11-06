'use strict';
// /api/state 的 ui_revision:静态上线只换 public/**、不重启进程,前端靠它发现自己是旧页面。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { uiRevision } = require('../lib/http/status-api');

test('ui_revision 随 public/** 的文件增删、内容与修改时间变化;没有目录时为 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-ui-rev-'));
  fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'let a = 1;');
  const first = uiRevision(dir);
  assert.match(first, /^[0-9a-f]{12}$/);
  assert.equal(uiRevision(dir), first, '没有变化时指纹稳定');

  fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'let a = 22;');
  const edited = uiRevision(dir);
  assert.notEqual(edited, first, '子目录里的文件改了');

  fs.writeFileSync(path.join(dir, 'js', 'new.js'), '');
  assert.notEqual(uiRevision(dir), edited, '新增文件');

  assert.equal(uiRevision(null), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
