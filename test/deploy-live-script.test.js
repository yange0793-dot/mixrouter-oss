'use strict';
// 上线脚本的静态回归:数据目录解耦之后,最容易发生的退化是"shell 里又自己拼一遍路径"。
// 这条用例不跑完整上线(会 checkout / 重启服务),只钉住三件事:
//   · bash 语法可解析;
//   · 数据目录解析只经 lib/paths.js,不在 shell 里重写 `MIXR_DATA_DIR || LIVE_DIR`;
//   · 备份确实读解析出的数据目录,找不到数据时是硬失败,不是"备份 0 个文件"。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'deploy-live.sh');
const PREFLIGHT = path.join(ROOT, 'scripts', 'preflight-live-data.js');

test('deploy-live.sh:bash -n 通过', () => {
  const r = spawnSync('/bin/bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('deploy-live.sh:数据目录只从 lib/paths.js 解析,不再自己拼环境变量', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const code = src.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  assert.ok(code.includes('paths.resolveDataDir'), '应调用 lib/paths.js 的 resolveDataDir');
  assert.doesNotMatch(code, /MIXR_DATA_DIR\s*\|\|/, 'shell 里不得再出现 MIXR_DATA_DIR || ... 的拼接');
  assert.doesNotMatch(code, /\$LIVE_DIR\/providers\.json/, '备份循环不得再写死代码目录下的数据文件');
  // RUN_DIR / 台账留在代码目录:它们描述这份代码的部署状态,不跟数据目录走。
  assert.match(code, /RUN_DIR="\$LIVE_DIR\/\.run"/);
  // 备份前必须先数文件,找不到数据就退出 —— "备份 0 个文件也算成功"是这次要消灭的行为。
  assert.match(code, /FOUND_COUNT/);
  assert.match(code, /找不到任何已知数据文件/);
  // 台账要能支撑 status 的三项检查。
  assert.match(code, /"data_dir":data_dir/);
  assert.match(code, /data\["pid"\]/);
  assert.match(code, /data\["code_revision"\]/);
});

test('preflight-live-data.js:输入目录同样经 paths 解析,空数据明确失败', () => {
  const src = fs.readFileSync(PREFLIGHT, 'utf8');
  const code = src.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  assert.ok(code.includes('resolveDataDir'), '预检应解析真实数据目录');
  assert.ok(code.includes('RUNTIME_DATA_FILES'), '预检应按统一的数据文件清单复制');
  assert.doesNotMatch(code, /path\.join\(LIVE,\s*f\)/, '预检不得再从代码目录直接取数据文件');
  assert.match(src, /没有任何已知数据文件/);
});
