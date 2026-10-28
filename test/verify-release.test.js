'use strict';
// scripts/verify-release.js 的回归。
//
// 这条脚本防的是"解包内容对、解包却跑不起来":内容清单由 release-manifest 管,
// 本文件只钉它的四件事 ——
//   · 环境隔离确实把 HOME / 数据目录 / TMPDIR 移走,并且不继承调用方的 MIXR_* 残值;
//   · 解包目录里出现 .git / test / node_modules 时必须拒绝(smoke 通过也不能算数);
//   · doctor --offline 先跑、必须退出 0、且一个文件都不写;
//   · doctor / smoke 的 cwd 都是解包目录,任一失败整轮失败。
//
// 不在这里跑真正的 npm run doctor / smoke:那属于 CI/Release 的制品验收,单测只验调用契约。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseArgs, scrubEnv, listTree, checkConsumerIndependence, verifyArtifact, buildFromHead,
  isDevCheckout, SMOKE_TIMEOUT_MS, DOCTOR_TIMEOUT_MS,
} = require('../scripts/verify-release.js');
const {
  REQUIRED_ENTRIES, REQUIRED_MAINTENANCE_ENTRIES,
} = require('../scripts/release-manifest.js');

function makeArtifact(root) {
  for (const rel of [...REQUIRED_ENTRIES, ...REQUIRED_MAINTENANCE_ENTRIES]) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
  }
}

function makeDirs(root) {
  // 与生产代码一致:data/ 故意不建,doctor 的"首次运行不写数据"要靠它仍然不存在来证明。
  const dirs = {
    home: path.join(root, 'home'),
    data: path.join(root, 'data'),
    tmp: path.join(root, 'tmp'),
  };
  fs.mkdirSync(dirs.home, { recursive: true });
  fs.mkdirSync(dirs.tmp, { recursive: true });
  return dirs;
}

test('parseArgs:默认从 HEAD 打包,只接受 --dir 一个来源', () => {
  assert.deepEqual(parseArgs([]), { mode: 'head', target: null, keep: false, help: false });
  assert.equal(parseArgs(['--dir', '/tmp/x']).mode, 'dir');
  assert.equal(parseArgs(['--keep']).keep, true);
  assert.throws(() => parseArgs(['--dir', 'a', '--dir', 'b']), /只能给一次/);
  assert.throws(() => parseArgs(['--dir']), /缺少值/);
  // 不接受"解任意 tarball 再执行"的入口:脚本会运行目录内的代码,只认自己的产出。
  assert.throws(() => parseArgs(['--tarball', 'x.tar.gz']), /未知参数/);
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
});

test('scrubEnv:清掉 MIXR_* 残值,把 HOME/数据目录/TMPDIR 全部重定向', () => {
  const dirs = { home: '/tmp/h', data: '/tmp/d', tmp: '/tmp/t' };
  const env = scrubEnv({
    PATH: '/bin', KEEP_ME: '1',
    MIXR_DATA_DIR: '/real/data', MIXROUTER_PORT: '8787', MIXUI_PORT: '8788',
    MIXR_ZCODE_CONFIG: '/real-zcode/config.json', DSH_HOME: '/real-dsh',
    MIXR_HARNESS_PROFILE: '/real-dsh/profile.yml',
    NODE_OPTIONS: '--require ./leak.js', NODE_PATH: '/leak', NODE_TEST_CONTEXT: 'child-v8',
  }, dirs);

  assert.equal(env.PATH, '/bin');
  assert.equal(env.KEEP_ME, '1');
  for (const key of ['MIXROUTER_PORT', 'MIXUI_PORT', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_TEST_CONTEXT'])
    assert.equal(key in env, false, `${key} 不应被继承`);
  assert.equal(env.HOME, dirs.home);
  assert.equal(env.USERPROFILE, dirs.home);
  assert.equal(env.TMPDIR, dirs.tmp);
  assert.equal(env.TMP, dirs.tmp);
  assert.equal(env.TEMP, dirs.tmp);
  assert.equal(env.MIXR_DATA_DIR, dirs.data);
  assert.equal(env.MIXR_CLAUDE_SETTINGS, path.join(dirs.home, '.claude', 'settings.json'));
  assert.equal(env.MIXR_CODEX_CONFIG, path.join(dirs.home, '.codex', 'config.toml'));
  // 已移除的 ZCode / Harness 集成不再有专属落点:残值被清掉,也不会被重新指到临时目录。
  for (const key of ['MIXR_ZCODE_CONFIG', 'DSH_HOME', 'MIXR_HARNESS_PROFILE'])
    assert.equal(key in env, false, `${key} 不该被继承,也不该再被设置`);
  assert.equal(env.MIXR_UPSTREAM_PROXY, '', '必须显式置空,不能回落到调用方 shell');
  assert.equal(env.npm_config_cache, path.join(dirs.tmp, 'npm-cache'));
});

test('isDevCheckout:只拦带 .git 的仓库根,不误伤解包制品里的 --dir .', () => {
  // 脚本随包发布;在制品里 ROOT 就是制品根。那里没有 .git,`--dir .` 是合法用法。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-verify-root-'));
  try {
    assert.equal(isDevCheckout(root, root), false, '没有 .git 的目录不是源码仓库');
    fs.mkdirSync(path.join(root, '.git'));
    assert.equal(isDevCheckout(root, root), true, '带 .git 的仓库根应被拦');
    assert.equal(isDevCheckout(path.join(root, 'sub'), root), false, '其他目录不拦');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildFromHead:没有 git 仓库时给出可执行的提示', () => {
  // 运行包没有 .git。默认模式在包里跑会失败,但失败信息必须指向 --dir / npm run smoke,
  // 而不是一段裸的 git stderr。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-verify-nogit-'));
  try {
    assert.throws(() => buildFromHead(root, path.join(root, 'x.tar.gz')), /--dir|npm run smoke/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkConsumerIndependence:解包里出现 .git / test / node_modules 就拒绝', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-verify-indep-'));
  try {
    assert.deepEqual(checkConsumerIndependence(root), []);
    for (const rel of ['.git', 'test', 'node_modules']) fs.mkdirSync(path.join(root, rel));
    const errors = checkConsumerIndependence(root);
    assert.equal(errors.length, 3);
    for (const rel of ['.git', 'test', 'node_modules'])
      assert.ok(errors.some(line => line.includes(rel)), `错误应点名 ${rel}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listTree:缺失目录给 null,存在时给排序后的相对路径', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-verify-tree-'));
  try {
    assert.equal(listTree(path.join(root, 'missing')), null);
    fs.mkdirSync(path.join(root, 'data', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'providers.json'), '{}');
    fs.writeFileSync(path.join(root, 'data', 'logs', 'requests.jsonl'), '');
    assert.deepEqual(listTree(path.join(root, 'data')), ['logs/requests.jsonl', 'providers.json']);
    assert.deepEqual(listTree(root), ['data/logs/requests.jsonl', 'data/providers.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verifyArtifact:先在解包目录跑 doctor --offline,再跑 smoke', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-verify-order-'));
  try {
    const artifact = path.join(root, 'artifact');
    fs.mkdirSync(artifact, { recursive: true });
    makeArtifact(artifact);
    const dirs = makeDirs(root);
    const calls = [];

    verifyArtifact(artifact, {
      dirs,
      runDoctor: opts => { calls.push(['doctor', opts]); return { status: 0 }; },
      runSmoke: opts => { calls.push(['smoke', opts]); return { status: 0 }; },
    });

    assert.deepEqual(calls.map(c => c[0]), ['doctor', 'smoke'], 'doctor 必须先跑:它负责发现入口缺失');
    const [, doctor] = calls[0];
    assert.equal(doctor.cwd, path.resolve(artifact));
    assert.equal(doctor.timeoutMs, DOCTOR_TIMEOUT_MS);
    assert.equal(doctor.env.HOME, dirs.home);
    assert.equal(doctor.env.MIXR_DATA_DIR, dirs.data);
    assert.equal(calls[1][1].cwd, path.resolve(artifact), 'smoke 也必须在解包目录里跑');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verifyArtifact:doctor 非 0 退出或写数据都算失败,且不再跑 smoke', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-verify-doctor-'));
  try {
    const artifact = path.join(root, 'artifact');
    fs.mkdirSync(artifact, { recursive: true });
    makeArtifact(artifact);
    const dirs = makeDirs(root);

    let smokeCalled = false;
    assert.throws(() => verifyArtifact(artifact, {
      dirs,
      runDoctor: () => ({ status: 1 }),
      runSmoke: () => { smokeCalled = true; return { status: 0 }; },
    }), /doctor.*exit 1|doctor.*失败/i);
    assert.equal(smokeCalled, false, 'doctor 失败时不应继续跑 smoke');

    // 首次运行正常只有警告;若 doctor 建了目录或写了文件,就必须判失败。
    assert.throws(() => verifyArtifact(artifact, {
      dirs,
      runDoctor: () => { fs.mkdirSync(dirs.data, { recursive: true }); return { status: 0 }; },
      runSmoke: () => ({ status: 0 }),
    }), /写入了数据目录/);
    fs.rmSync(dirs.data, { recursive: true, force: true });

    assert.throws(() => verifyArtifact(artifact, {
      dirs,
      runDoctor: () => {
        fs.mkdirSync(dirs.data, { recursive: true });
        fs.writeFileSync(path.join(dirs.data, 'providers.json'), '{}');
        return { status: 0 };
      },
      runSmoke: () => ({ status: 0 }),
    }), /providers\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verifyArtifact:解包目录里跑 smoke,环境隔离;非 0 退出即失败', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-verify-artifact-'));
  try {
    const artifact = path.join(root, 'artifact');
    fs.mkdirSync(artifact, { recursive: true });
    makeArtifact(artifact);
    const dirs = makeDirs(root);

    let seen = null;
    const cleanDoctor = () => ({ status: 0 });
    const result = verifyArtifact(artifact, {
      dirs,
      runDoctor: cleanDoctor,
      runSmoke: opts => { seen = opts; return { status: 0 }; },
    });
    assert.equal(result.files, new Set([...REQUIRED_ENTRIES, ...REQUIRED_MAINTENANCE_ENTRIES]).size);
    assert.equal(seen.cwd, path.resolve(artifact), 'smoke 必须在解包目录里跑');
    assert.equal(seen.timeoutMs, SMOKE_TIMEOUT_MS);
    assert.equal(seen.env.HOME, dirs.home);
    assert.equal(seen.env.MIXR_DATA_DIR, dirs.data);

    assert.throws(() => verifyArtifact(artifact, {
      dirs,
      runDoctor: cleanDoctor,
      runSmoke: () => ({ status: 7 }),
    }), /exit 7/);

    // 解包里混入源码仓库材料时,即便两步都会返回 0 也不能放行
    fs.mkdirSync(path.join(artifact, '.git'));
    let called = false;
    assert.throws(() => verifyArtifact(artifact, {
      dirs,
      runDoctor: () => { called = true; return { status: 0 }; },
      runSmoke: () => { called = true; return { status: 0 }; },
    }), /\.git/);
    assert.equal(called, false, '独立性检查失败时不应启动 doctor / smoke');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
