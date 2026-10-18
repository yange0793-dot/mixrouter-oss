'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { restoreBackup, validateToml, MAX_BYTES } = require('../lib/backup/restore');
const { runRestoreCmd, parseRestoreArgs } = require('../lib/cli/restore');

function fixture(t, base = 'settings.json') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, base);
  const backup = file + '.bak-mixui-20260101-120000-000-abcd';
  const json = base.endsWith('.json');
  const old = json ? '{"token":"live-secret"}\n' : 'model = "live"\n';
  const source = json ? '{"token":"backup-secret"}\n' : 'model = "backup"\n[model_providers.mixr]\nname = "local"\n';
  fs.writeFileSync(file, old, { mode: 0o600 });
  fs.writeFileSync(backup, source, { mode: 0o600 });
  const opts = { root, home: root, env: { MIXR_DATA_DIR: root,
    MIXR_CLAUDE_SETTINGS: json ? file : path.join(root, 'settings.json'),
    MIXR_CODEX_CONFIG: json ? path.join(root, 'config.toml') : file }, backup };
  return { root, file, backup, opts, old, source };
}
function snapshot(root) {
  return fs.readdirSync(root).sort().map(name => {
    const file = path.join(root, name), st = fs.lstatSync(file);
    return { name, mode: st.mode, mtime: st.mtimeMs, bytes: st.isFile() ? fs.readFileSync(file).toString('hex') : null };
  });
}

test('default and explicit dry-run perform zero writes and never print secrets', t => {
  const f = fixture(t), before = snapshot(f.root), output = [];
  for (const args of [[f.backup, '--json'], [f.backup, '--dry-run', '--file', f.file]]) {
    const r = runRestoreCmd(args, { ...f.opts, log: s => output.push(s) });
    assert.equal(r.dryRun, true);
    assert.equal(r.restored, false);
  }
  assert.deepEqual(snapshot(f.root), before);
  assert.doesNotMatch(output.join('\n'), /live-secret|backup-secret/);
});

test('actual mixctl restore dispatch stays dry by default and requires explicit yes', t => {
  const { spawnSync } = require('node:child_process');
  const f = fixture(t), before = snapshot(f.root);
  const run = args => {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'mixctl'), 'restore', ...args], {
      env: { ...process.env, ...f.opts.env, HOME: f.root }, encoding: 'utf8', timeout: 5000,
    });
    assert.ifError(result.error);
    assert.doesNotMatch(result.stdout + result.stderr, /live-secret|backup-secret/);
    return { code: result.status, data: JSON.parse(result.stdout) };
  };
  const preview = run([f.backup, '--json']);
  assert.equal(preview.code, 0);
  assert.equal(preview.data.dryRun, true);
  assert.deepEqual(snapshot(f.root), before);
  const conflict = run([f.backup, '--yes', '--dry-run', '--json']);
  assert.equal(conflict.code, 1);
  assert.equal(conflict.data.error.code, 'invalid_arguments');
  assert.deepEqual(snapshot(f.root), before);
  const restored = run([f.backup, '--yes', '--json']);
  assert.equal(restored.code, 0);
  assert.equal(restored.data.restored, true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.source);
  assert.equal(fs.readFileSync(restored.data.safetyBackup, 'utf8'), f.old);
  assert.equal(fs.readFileSync(f.backup, 'utf8'), f.source);
});

test('yes restores atomically, backs up live data, and preserves the selected old backup', t => {
  const f = fixture(t);
  for (let i = 0; i < 7; i++) fs.writeFileSync(f.file + `.bak-mixui-2026010${i + 2}-120000-000-abcd`, '{}');
  const r = restoreBackup({ ...f.opts, yes: true });
  assert.equal(r.restored, true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.source);
  assert.equal(fs.readFileSync(r.safetyBackup, 'utf8'), f.old);
  assert.equal(fs.readFileSync(f.backup, 'utf8'), f.source);
  assert.equal(fs.statSync(r.safetyBackup).mode & 0o777, 0o600);
  assert.match(r.note, /重启/);
  assert.equal(fs.readdirSync(f.root).filter(n => n.endsWith('.tmp')).length, 0);
});

for (const [liveMode, backupMode, expected] of [[0o644, 0o644, 0o600], [0o400, 0o600, 0o400], [0o600, 0o400, 0o400]]) {
  test(`permission intersection ${liveMode.toString(8)}/${backupMode.toString(8)}`, t => {
    const f = fixture(t);
    fs.chmodSync(f.file, liveMode); fs.chmodSync(f.backup, backupMode);
    const r = restoreBackup({ ...f.opts, yes: true });
    assert.equal(fs.statSync(f.file).mode & 0o777, expected);
    assert.equal(fs.statSync(r.safetyBackup).mode & 0o777, liveMode & 0o600);
  });
}

for (const text of ['{"token":"sensitive-broken', 'null', '[]', 'true', '\u0000', Buffer.from([0xff]), Buffer.alloc(MAX_BYTES + 1)]) {
  test('invalid backup rejected before any write: ' + (Buffer.isBuffer(text) ? 'bytes' : JSON.stringify(text)), t => {
    const f = fixture(t); fs.writeFileSync(f.backup, text);
    const before = snapshot(f.root);
    assert.throws(() => restoreBackup({ ...f.opts, yes: true }), /JSON|512 KiB/);
    assert.deepEqual(snapshot(f.root), before);
  });
}

test('wrong name, directory, symlink, hardlink and arbitrary target are refused', t => {
  const f = fixture(t);
  assert.throws(() => restoreBackup({ ...f.opts, backup: f.file + '.bak-mixui-bad' }), { code: 'invalid_backup_name' });
  assert.throws(() => restoreBackup({ ...f.opts, file: path.join(f.root, 'other.json') }), { code: 'undecidable_target' });
  const elsewhere = path.join(f.root, 'elsewhere'); fs.mkdirSync(elsewhere);
  const moved = path.join(elsewhere, path.basename(f.backup)); fs.copyFileSync(f.backup, moved);
  assert.throws(() => restoreBackup({ ...f.opts, backup: moved }), { code: 'undecidable_target' });
  fs.unlinkSync(f.backup); fs.mkdirSync(f.backup);
  assert.throws(() => restoreBackup(f.opts), { code: 'unsafe_path' });
  fs.rmdirSync(f.backup); fs.symlinkSync(f.file, f.backup);
  assert.throws(() => restoreBackup(f.opts), { code: 'unsafe_path' });
  fs.unlinkSync(f.backup); fs.linkSync(f.file, f.backup);
  assert.throws(() => restoreBackup(f.opts), { code: 'unsafe_path' });
});

test('live symlink and symlink parent rejected; missing live is not created', t => {
  const f = fixture(t), real = f.file + '.original';
  fs.renameSync(f.file, real); fs.symlinkSync(real, f.file);
  assert.throws(() => restoreBackup({ ...f.opts, yes: true }), { code: 'unsafe_path' });
  fs.unlinkSync(f.file);
  assert.throws(() => restoreBackup({ ...f.opts, yes: true }), { code: 'ENOENT' });
  assert.equal(fs.existsSync(f.file), false);
  fs.renameSync(real, f.file);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.root, alias);
  assert.throws(() => restoreBackup({ ...f.opts, backup: path.join(alias, path.basename(f.backup)),
    env: { ...f.opts.env, MIXR_CLAUDE_SETTINGS: path.join(alias, 'settings.json') } }), { code: 'unsafe_path' });
});

for (const method of ['copyFileSync', 'chmodSync', 'renameSync']) {
  test(`${method} failure leaves original live content and mode intact`, t => {
    const f = fixture(t), original = fs[method];
    fs[method] = () => { throw Object.assign(new Error('injected failure secret'), { code: 'EACCES' }); };
    try {
      const output = [], exitCode = process.exitCode;
      try {
        const r = runRestoreCmd([f.backup, '--yes', '--json'], { ...f.opts, log: s => output.push(s) });
        assert.equal(r.ok, false); assert.equal(process.exitCode, 1);
      } finally { process.exitCode = exitCode; }
      assert.doesNotMatch(output.join(''), /secret|恢复成功/);
      assert.equal(fs.readFileSync(f.file, 'utf8'), f.old);
      assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
      assert.equal(fs.readdirSync(f.root).filter(n => n.endsWith('.tmp')).length, 0);
    } finally { fs[method] = original; }
  });
}

test('TOML supported subset validates full document; malformed or unsupported syntax rejected', t => {
  const f = fixture(t, 'config.toml');
  assert.equal(restoreBackup({ ...f.opts, yes: true }).format, 'toml');
  for (const text of ['model = "x"\n[bad', 'model = "x"\nfoo = arbitrary', 'x = 1\nx = 2', '[a]\nx = 1\n[a]\nx=2', 'x = [1,2]', 'x="\\q"', 'x=01', 'x=1\n[x]\ny=2', '[a.b]\nx=1\n[a]\nb=2']) {
    assert.throws(() => validateToml(text));
    fs.writeFileSync(f.backup, text);
    const before = snapshot(f.root);
    assert.throws(() => restoreBackup({ ...f.opts, yes: true }), { code: 'unsupported_toml' });
    assert.deepEqual(snapshot(f.root), before);
  }
  assert.doesNotThrow(() => validateToml('"model" = "x#y" # note\n[a."quoted.key"]\nb=true\nn=-1.25e+2\nx=\'local\''));
});

test('generated Codex config and trusted project tables are supported; arrays explicitly unsupported', t => {
  const f = fixture(t, 'config.toml');
  const { providerSection } = require('../lib/codex-toml');
  const text = ['model = "gpt-test"', 'model_provider = "mixr-test"',
    '[projects."/tmp/trusted.project"]', 'trust_level = "trusted"',
    ...providerSection({ section: 'mixr-test', name: 'local', base_url: 'https://example.invalid/v1', api_key: 'not-a-secret', wire_api: 'responses' })].join('\n');
  fs.writeFileSync(f.backup, text);
  assert.equal(restoreBackup({ ...f.opts, yes: true }).restored, true);
  fs.writeFileSync(f.backup, 'sandbox_workspace_write = ["/tmp/trusted"]');
  assert.throws(() => restoreBackup(f.opts), { code: 'unsupported_toml' });
});

test('a wider Codex parser does not widen the restore safety boundary', t => {
  // lib/codex-config.js 是唯一的 TOML 实现,它按文档结构读,能吃下数组、内联表、多行
  // 字符串、日期等。**解析器能力更宽不等于放宽还原**:恢复仍只接受能完整验证的保守子集,
  // 超出子集一律 unsupported_toml 拒绝。这条把"两个边界是分开的"钉在代码里 ——
  // 否则将来有人顺手把 validateToml 也接到新解析器上,还原就会静默接受没验证过的文件。
  const config = require('../lib/codex-config');
  const f = fixture(t, 'config.toml');
  const beyond = ['x = [1, 2]', 'x = { a = 1 }', 'x = """\nmulti\n"""', 'x = 2026-10-16', 'x = 0xff', 'x = 01', 'a.b = 1', '[[t]]\nx = 1'];
  for (const text of beyond) {
    assert.doesNotThrow(() => config.parse(text), `新解析器应当能吃下: ${JSON.stringify(text)}`);
    assert.throws(() => validateToml(text), `恢复的安全边界不能被放宽: ${JSON.stringify(text)}`);
    fs.writeFileSync(f.backup, text);
    const before = snapshot(f.root);
    assert.throws(() => restoreBackup({ ...f.opts, yes: true }), { code: 'unsupported_toml' });
    assert.deepEqual(snapshot(f.root), before, '被拒绝的备份一个字节都不许动盘');
  }
  // 反证方向:支持子集里的写法仍然放行,上面那组不是"一律拒绝"。
  for (const text of ['model = "gpt-test"\n', '[model_providers.mixr-test]\nname = "n"\n', 'x = -1.25e+2\n', 'b = true\n']) {
    assert.doesNotThrow(() => validateToml(text), `受支持子集必须放行: ${JSON.stringify(text)}`);
  }
});

test('providers validates group and entry types and supports legacy arrays', t => {
  const f = fixture(t), file = path.join(f.root, 'providers.json');
  fs.writeFileSync(file, '{"claude":[],"codex":[]}');
  const backup = file + '.bak-mixui-20260101-120000-000-abcd';
  const opts = { ...f.opts, backup };
  for (const value of [{}, { claude: {}, codex: [] }, { claude: [null], codex: [] },
    { claude: [], codex: [], current: [] }]) {
    fs.writeFileSync(backup, JSON.stringify(value));
    assert.throws(() => restoreBackup(opts), { code: 'invalid_backup' });
  }
  for (const value of [{ claude: [], codex: [] }, [{ id: 'legacy', base_url: 'https://example.invalid', api_key: 'test' }]]) {
    fs.writeFileSync(backup, JSON.stringify(value));
    assert.match(restoreBackup({ ...opts, yes: true }).note, /重启 mixrouter/);
  }
});

test('silent safety-backup chmod failure cannot report restore success', t => {
  const f = fixture(t), chmod = fs.chmodSync;
  fs.chmodSync(f.file, 0o644);
  fs.chmodSync = () => {};
  try {
    assert.throws(() => restoreBackup({ ...f.opts, yes: true }), { code: 'backup_failed' });
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.old);
  } finally { fs.chmodSync = chmod; }
});

test('a live change during safety backup is detected rather than overwritten', t => {
  const f = fixture(t), copy = fs.copyFileSync;
  fs.copyFileSync = (...args) => {
    fs.writeFileSync(f.file, '{"changed":true}');
    return copy(...args);
  };
  try {
    assert.throws(() => restoreBackup({ ...f.opts, yes: true }), { code: 'changed_file' });
    assert.equal(fs.readFileSync(f.file, 'utf8'), '{"changed":true}');
  } finally { fs.copyFileSync = copy; }
});

test('argument parser rejects ambiguity and conflicts without writes', t => {
  const f = fixture(t), before = snapshot(f.root);
  for (const args of [[], [f.backup, '--yes', '--dry-run'], [f.backup, '--yes', '--yes'],
    [f.backup, '--json', '--json'], [f.backup, '--file'], [f.backup, '--file', '--yes'],
    [f.backup, '--file', f.file, '--file', f.file], [f.backup, 'extra'], [f.backup, '--unknown']]) {
    assert.throws(() => parseRestoreArgs(args), { code: 'invalid_arguments' });
  }
  assert.equal(parseRestoreArgs(['--help']).help, true);
  assert.deepEqual(snapshot(f.root), before);
});

test('basename resolution requires --file when targets share a basename', t => {
  const f = fixture(t), second = path.join(f.root, 'second'); fs.mkdirSync(second);
  const opts = { ...f.opts, backup: path.basename(f.backup), env: { ...f.opts.env,
    MIXR_CODEX_CONFIG: path.join(second, 'settings.json') } };
  assert.throws(() => restoreBackup(opts), { code: 'undecidable_target' });
  assert.equal(restoreBackup({ ...opts, file: f.file }).file, f.file);
});
