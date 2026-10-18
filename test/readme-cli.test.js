'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse: parseDiagnostic } = require('../scripts/diagnose-upstream');
const { BACKUPS_USAGE, ROUTE_USAGE, RESTORE_USAGE, LOGS_USAGE, MAIN_USAGE } = require('../lib/cli/usage');
const { parseLogsArgs } = require('../lib/cli/logs');
const { CLAUDE_SLOTS } = require('../lib/routing/slots');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const overview = readme.split('## 运行\n')[1].split('\n- **代理端口')[0];

test('README 命令总览包含备份清点与差异预览的完整参数', () => {
  for (const line of BACKUPS_USAGE.split('\n').slice(0, 2)) {
    assert.ok(overview.includes(`./${line}`), `README 缺少 ${line}`);
  }
});

test('README 命令总览与 route 帮助中的协议参数一致', () => {
  const command = ROUTE_USAGE.replace(/^用法: /, '');
  assert.ok(overview.includes(`./${command}`), `README 缺少 ${command}`);
});

test('README 和主帮助包含 restore 默认预览及完整参数', () => {
  const command = RESTORE_USAGE.split('\n')[0].replace(/^用法: /, '');
  assert.ok(overview.includes(`./${command}`), `README 缺少 ${command}`);
  assert.ok(MAIN_USAGE.includes(RESTORE_USAGE));
  assert.ok(readme.includes('**默认只预览**'));
  assert.ok(readme.includes('`unsupported_toml`'));
  assert.doesNotMatch(readme, /restore` 尚未实现|\[ \] \*\*`mixctl restore`/);
});

test('README 与 logs 主帮助的选项一致且解析器接受文档格式', () => {
  const values = { since: '2026-09-01T00:00:00Z', until: '2026-09-29T23:59:59.999Z', cursor: 'snapshot',
    limit: '50', app: 'claude', provider: 'channel', model: 'model', session: 'cc:session',
    status: 'err', slot: 'subagent', err_class: 'timeout' };
  for (const line of LOGS_USAGE.split('\n').slice(0, 2)) {
    assert.ok(overview.includes(`./${line}`), `README 缺少 ${line}`);
    const args = [...line.matchAll(/--([a-z_]+)(?: <[^>]+>)?/g)]
      .flatMap(([, option]) => option === 'history' || option === 'json' ? [`--${option}`] : [`--${option}`, values[option]]);
    assert.doesNotThrow(() => parseLogsArgs(args));
  }
  assert.ok(MAIN_USAGE.includes(LOGS_USAGE));
  assert.ok(readme.includes('**服务必须运行**'));
  assert.ok(readme.includes('`CURSOR_EXPIRED`'));
  assert.ok(readme.includes('`by_slot`'));
});

test('README 的槽位、诊断与返回归档边界未沿用旧说明', () => {
  assert.deepEqual(CLAUDE_SLOTS, ['main', 'opus', 'sonnet', 'haiku', 'subagent']);
  assert.ok(readme.includes('**Claude Code 五个固定槽**'));
  assert.doesNotMatch(readme, /六个固定槽|主链五槽|main\/opus\/sonnet\/fable\/haiku/);
  for (const text of ['scripts/diagnose-upstream.js', '**默认离线**', '**未实际测试真实上游**', 'MIXR_RESPONSE_ARCHIVE=on',
    'raw 与 derived **分别最多 16MiB**', '最多 100 份归档', '**不自动删除旧档**',
    '**响应正文仍可能含其他敏感数据**', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'provider_key_unavailable_error']) {
    assert.ok(readme.includes(text), `README 缺少边界: ${text}`);
  }
});

test('README 渠道诊断命令与实际 help 一致，解析不执行真实调用', () => {
  const script = path.join(__dirname, '..', 'scripts', 'diagnose-upstream.js');
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(help.status, 0, help.stderr);
  const command = help.stdout.split('\n').find(line => line.startsWith('MIXR_DATA_DIR='));
  assert.ok(command, 'help 缺少渠道模式调用格式');
  assert.ok(readme.includes(command), 'README 渠道模式调用格式必须与 help 一致');
  assert.doesNotMatch(readme, /没有远端模式|没有远端压测模式|不包含真实渠道的并发压测/);
  assert.doesNotThrow(() => parseDiagnostic(['--mode', 'offline']));
  const args = ['--mode', 'provider', '--provider', 'example', '--requests', '1', '--confirm-run'];
  assert.equal(parseDiagnostic(args).concurrency, 1);
  assert.throws(() => parseDiagnostic(args.filter(arg => arg !== '--confirm-run')));
  assert.throws(() => parseDiagnostic([...args, '--concurrency', '5']));
  assert.throws(() => parseDiagnostic(['--mode', 'provider', '--provider', 'example', '--requests', '21', '--confirm-run']));
});
