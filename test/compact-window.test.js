'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCompactWindow, parseWindow } = require('../lib/compact-window');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-window-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), globalFile = path.join(root, 'user/settings.json');
  fs.mkdirSync(path.dirname(globalFile)); fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(globalFile, JSON.stringify({ autoCompactWindow: 1000000, env: { SECRET: 'fixture-key' }, hooks: { Keep: [1] } }));
  fs.writeFileSync(path.join(project, '.claude/settings.json'), JSON.stringify({ autoCompactWindow: 256000, hooks: { Keep: [2] } }));
  const api = createCompactWindow({ globalFile, env: {} });
  return { api, globalFile, project, root, load: scope => api.get({ scope, project }) };
}
const put = (f, scope, value, more = {}) => f.api.set({ scope, project: f.project, value, expected_revision: f.load(scope).revision, ...more });

test('window parsing accepts explicit units and rejects invalid or ambiguous input', () => {
  for (const [s, n] of [['100k', 100000], ['1M', 1000000], ['256000', 256000], [333000, 333000], ['auto', 'auto']]) assert.equal(parseWindow(s), n);
  for (const value of [0, -1, 99999, 1000001, 333000.5, true, null, {}, '200', '300junk', 'Infinity', '1mX']) assert.throws(() => parseWindow(value));
});
test('GET reflects disk precedence and exposes no env values or unrelated fields', t => {
  const f = fixture(t), view = f.load('global');
  assert.equal(view.value, 1000000);
  assert.deepEqual(view.configured, { value: 256000, source: 'project' });
  assert.deepEqual(view.coverage, { project_checked: true, overridden_by: 'project', environment_override: false });
  assert.ok(view.warnings.some(w => w.includes('project')));
  assert.doesNotMatch(JSON.stringify(view), /fixture-key|SECRET|Keep/);
  assert.equal(view.restart_required, true);
});
test('only selected key changes; exact private backup preserves previous bytes', t => {
  const f = fixture(t), before = fs.readFileSync(f.globalFile);
  const result = put(f, 'global', '500k');
  const cfg = JSON.parse(fs.readFileSync(f.globalFile));
  assert.deepEqual(cfg, { autoCompactWindow: 500000, env: { SECRET: 'fixture-key' }, hooks: { Keep: [1] } });
  assert.deepEqual(fs.readFileSync(result.backup), before);
  assert.equal(fs.statSync(result.backup).mode & 0o077, 0);
  assert.equal(f.load('project').value, 256000);
  assert.deepEqual(result.window.coverage, { project_checked: true, overridden_by: 'project', environment_override: false });
  assert.deepEqual(result.window.configured, { value: 256000, source: 'project' });
  assert.ok(result.window.warnings.some(w => w.includes('保存本层不会改变')));
  assert.equal(put(f, 'global', 'auto').window.configured.value, 256000, 'auto 删除全局键，不碰项目覆盖');
});
test('project auto inherits global, local override remains visible and independently editable', t => {
  const f = fixture(t);
  put(f, 'local', '700k');
  assert.deepEqual(f.load('project').configured, { value: 700000, source: 'local' });
  assert.equal(f.load('project').coverage.overridden_by, 'local');
  assert.equal(f.load('local').coverage.overridden_by, null);
  put(f, 'local', 'auto'); put(f, 'project', 'auto');
  assert.deepEqual(f.load('global').configured, { value: 1000000, source: 'global' });
  const cfg = JSON.parse(fs.readFileSync(path.join(f.project, '.claude/settings.json')));
  assert.deepEqual(cfg, { hooks: { Keep: [2] } });
});
test('stale revision detects edits to any layer and missing revision is rejected', t => {
  const f = fixture(t), old = f.load('global'), before = fs.readFileSync(f.globalFile);
  put(f, 'project', 400000);
  assert.throws(() => f.api.set({ scope: 'global', project: f.project, value: 600000, expected_revision: old.revision }), e => e.statusCode === 409);
  assert.throws(() => f.api.set({ value: 600000 }), e => e.statusCode === 400);
  assert.deepEqual(fs.readFileSync(f.globalFile), before);
});
test('invalid JSON, non-object, directory and symlink all fail without overwrite', t => {
  const f = fixture(t);
  for (const value of ['{broken fixture-secret', '[]', 'null', '']) {
    fs.writeFileSync(f.globalFile, value);
    assert.throws(() => f.load('global'), e => !e.message.includes('fixture-secret'));
    assert.equal(fs.readFileSync(f.globalFile, 'utf8'), value);
  }
  fs.unlinkSync(f.globalFile); fs.mkdirSync(f.globalFile);
  assert.throws(() => f.load('global'));
  fs.rmdirSync(f.globalFile); fs.symlinkSync(path.join(f.project, '.claude/settings.json'), f.globalFile);
  assert.throws(() => f.load('global'));
});
test('environment override warning never exports its value and save does not remove env', t => {
  const f = fixture(t), cfg = { autoCompactWindow: 256000, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '777777', DISABLE_AUTO_COMPACT: '1' } };
  fs.writeFileSync(path.join(f.project, '.claude/settings.json'), JSON.stringify(cfg));
  const view = f.load('project');
  assert.equal(view.layers[1].env_override, true); assert.doesNotMatch(JSON.stringify(view), /777777/);
  assert.equal(view.coverage.environment_override, true);
  assert.ok(view.warnings.some(w => w.includes('不能清除')));
  assert.ok(view.warnings.some(w => w.includes('禁用')));
  put(f, 'project', '400k');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.project, '.claude/settings.json'))).env, cfg.env);
});
test('project selection must be explicit and existing; no project scan is implied', t => {
  const f = fixture(t);
  for (const project of ['', 'relative/path', '/does-not-exist-for-window-test']) assert.throws(() => f.api.get({ scope: 'project', project }));
  const view = f.api.get(); assert.equal(view.layers.length, 1);
  assert.deepEqual(view.coverage, { project_checked: false, overridden_by: null, environment_override: false });
  assert.ok(view.warnings.some(w => w.includes('尚未指定项目')));
  const saved = f.api.set({ scope: 'global', value: '500k', expected_revision: view.revision });
  assert.equal(saved.window.coverage.project_checked, false);
  assert.equal(saved.window.configured.value, 500000);
  assert.equal(f.load('project').value, 256000);
});
test('process env is reported only as a boolean and cannot be cleared by auto', t => {
  const f = fixture(t), env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'process-window-secret', UNRELATED: 'other-secret' };
  const api = createCompactWindow({ globalFile: f.globalFile, env });
  const initial = api.get({ scope: 'global' });
  assert.deepEqual(initial.coverage, { project_checked: false, overridden_by: null, environment_override: true });
  const result = api.set({ scope: 'global', value: 'auto', expected_revision: initial.revision });
  assert.equal(result.window.coverage.environment_override, true);
  assert.doesNotMatch(JSON.stringify(result), /process-window-secret|other-secret/);
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, 'process-window-secret');
});
test('canonical project path keeps coverage and revision stable', t => {
  const f = fixture(t), alias = path.join(f.root, 'project-alias');
  fs.symlinkSync(f.project, alias);
  const view = f.api.get({ scope: 'global', project: alias });
  assert.equal(view.project, fs.realpathSync(f.project));
  assert.equal(view.revision, f.load('global').revision);
  assert.equal(view.coverage.overridden_by, 'project');
});
