'use strict';
// 托盘方案菜单:Swift 源码是单一事实源,这里做只读静态断言(不编译、不启动 app)。
// 目的只有三条:
//   1) 菜单确实读 /api/profiles 并在应用前做 preview + 确认;
//   2) 应用只走 POST …/apply,不带任何客户端/服务生命周期副作用;
//   3) 服务生命周期(healthz 探测、mixctl start/restart)没有因为方案菜单被改写。
// 可选:本机有 swiftc 时额外做一次 typecheck(没有就跳过,不让 CI 因缺工具链而红)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE = path.join(__dirname, '..', 'app', 'MixrouterApp.swift');
const text = fs.readFileSync(SOURCE, 'utf8');

test('托盘菜单读取 GET /api/profiles,只在打开菜单时刷新', () => {
  assert.match(text, /consoleBase \+ "\/api\/profiles"/);
  assert.match(text, /func loadProfiles/);
  assert.match(text, /func menuWillOpen\(_ menu: NSMenu\)/);
  assert.match(text, /guard menu === statusItem\?\.menu else \{ return \}/);
  // 打开菜单才读:没有新增常驻轮询(唯一的定时器仍是 3 秒的健康检查)。
  assert.equal((text.match(/Timer\.scheduledTimer/g) || []).length, 1);
  assert.match(text, /func refreshProfilesMenu/);
});

test('切换前必须预览并弹 NSAlert 确认;can_apply=false 时也要显示原因且不发 apply', () => {
  const switchBody = text.slice(text.indexOf('@objc func switchProfile'));
  assert.match(switchBody, /appendingPathComponent\("preview"\)/);
  assert.match(switchBody, /confirmAndApply\(preview\)/);
  const confirm = text.slice(text.indexOf('private func confirmAndApply'));
  assert.match(confirm, /NSAlert\(\)/);
  assert.match(confirm, /runModal\(\) == \.alertFirstButtonReturn/);
  assert.match(confirm, /warnings/);
  // canApply=false 必须弹一个只有“好”的提示再 return,不能靠 guard 短路把弹窗整个跳过。
  const blocked = confirm.slice(confirm.indexOf('guard preview.canApply else'));
  assert.match(blocked, /alert\.runModal\(\)/);
  assert.match(blocked, /addButton\(withTitle: "好"\)/);
  const guardBlock = blocked.slice(0, blocked.indexOf('alert.addButton(withTitle: "切换")'));
  assert.match(guardBlock, /return/, '不能应用的方案必须直接结束,不进入 apply 分支');
  assert.ok(!guardBlock.includes('appendingPathComponent("apply")'), 'guard 内不得发 apply');
});

test('菜单空表的“在控制台保存当前槽位”也带 target=self', () => {
  const menu = text.slice(text.indexOf('func applyProfileMenu'), text.indexOf('@objc func refreshProfilesMenu'));
  const line = menu.slice(menu.indexOf('在控制台保存当前槽位'));
  assert.ok(line.length, '缺少空表引导项');
  assert.match(line.slice(0, 300), /manage\.target = self/);
});

test('apply 只发送 confirm 与两份 revision,不改客户端、不重启服务', () => {
  const confirm = text.slice(text.indexOf('private func confirmAndApply'), text.indexOf('/// 快捷入口'));
  assert.match(confirm, /appendingPathComponent\(preview\.id\)\.appendingPathComponent\("apply"\)/);
  for (const key of ['"confirm": true', '"expected_revision"', '"slots_revision"'])
    assert.ok(confirm.includes(key), `apply 请求缺少 ${key}`);
  for (const forbidden of ['runMixctl', 'restart', 'mixctl', 'settings.json', 'config.toml', 'ANTHROPIC_'])
    assert.ok(!confirm.includes(forbidden), `apply 路径不应出现 ${forbidden}`);
  // 应用成功后只刷新菜单与页面,不重启服务。
  assert.match(confirm, /self\.refreshProfilesMenu\(nil\)/);
});

test('菜单与主菜单都有 #insights / #profiles / #diagnostics 快捷入口', () => {
  for (const view of ['insights', 'profiles', 'diagnostics']) {
    assert.ok(text.includes(`openConsoleView("${view}")`), `缺少 #${view} 快捷入口`);
  }
  assert.match(text, /func openConsoleView\(_ view: String\)/);
  assert.match(text, /consoleBase \+ "\/#" \+ view/);
  // 菜单栏与「控制台」主菜单各挂一次。
  for (const name of ['openInsightsView', 'openProfilesView', 'openDiagnosticsView'])
    assert.ok((text.match(new RegExp(name, 'g')) || []).length >= 2, `${name} 应在菜单栏与主菜单各挂一次`);
});

test('保留服务生命周期:healthz 探测、mixctl start 与重启确认原样存在', () => {
  assert.match(text, /\/healthz/);
  assert.match(text, /func bootService\(\)/);
  assert.match(text, /runMixctl\(\["start"\]\)/);
  assert.match(text, /runMixctl\(\["restart"\]\)/);
  assert.match(text, /messageText = "重启本地服务\?"/);
  // 方案菜单不参与启动/重启判定。
  const menu = text.slice(text.indexOf('private func buildStatusItem'), text.indexOf('func menuWillOpen'));
  assert.ok(!/runMixctl|bootService|checkHealth/.test(menu));
});

test('解析函数只认契约字段,不显示 Key 材料', () => {
  const parse = text.slice(text.indexOf('static func parseProfileList'), text.indexOf('/// GET /api/profiles'));
  for (const field of ['revision', 'slots_revision', 'profiles', 'id', 'name', 'apps', 'active'])
    assert.ok(parse.includes(`"${field}"`), `列表解析缺少 ${field}`);
  assert.ok(!/api_key|key_masked|base_url/.test(parse));
  const preview = text.slice(text.indexOf('static func parsePreview'), text.indexOf('/// GET /api/profiles'));
  for (const field of ['changes', 'warnings', 'can_apply', 'expected_revision'])
    assert.ok(preview.includes(`"${field}"`), `预览解析缺少 ${field}`);
  assert.match(text, /static func describeSlot/);
});

// Linux CI 预装 swiftc 但**没有 AppKit**,`swiftc --version` 会成功而编译 macOS 源码必然失败,
// 所以平台闸门放在 test 选项上,而不是探测二进制。没有工具链时用 t.skip 明确标成跳过,
// 不 return 伪装通过;能编的时候才真的 typecheck。
test('swiftc 可用时对源码做 typecheck(非 macOS 或缺工具链时跳过)',
  { skip: process.platform !== 'darwin' ? '需要 macOS 与 AppKit,Linux 预装 swiftc 也编不了' : false }, t => {
    const probe = spawnSync('swiftc', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) { t.skip('本机没有可用的 swiftc'); return; }
    const arch = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim() || 'x86_64';
    const compile = spawnSync('swiftc', ['-parse-as-library', '-typecheck', '-target', `${arch}-apple-macos11.0`, SOURCE],
      { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
  });
