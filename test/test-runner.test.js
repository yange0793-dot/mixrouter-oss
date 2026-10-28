'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { testFiles, testArgs, testEnv } = require('../scripts/run-tests');
const runner = path.resolve(__dirname, '../scripts/run-tests.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-runner-spec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('测试入口:只收 *.test.js 并按文件名排序,不依赖 shell 通配符', t => {
  const root = fixture(t);
  const dir = path.join(root, 'test');
  fs.mkdirSync(dir);
  for (const name of ['z.test.js', 'a.test.js', 'mock-upstream.js', 'notes.txt']) fs.writeFileSync(path.join(dir, name), '');
  assert.deepEqual(testFiles(root).map(file => path.basename(file)), ['a.test.js', 'z.test.js']);
});

test('测试入口:按当前 Node 能力选 flag,18 不传 --test-timeout', () => {
  assert.deepEqual(testArgs(['a.test.js'], '  --test   run tests'), ['--test', 'a.test.js']);
  assert.deepEqual(testArgs(['a.test.js', 'b.test.js'], '  --test-timeout=...'),
    ['--test', '--test-timeout=30000', 'a.test.js', 'b.test.js']);
});

test('测试入口:隔离 HOME/数据/客户端与 tmp,不继承现役路由旋钮', t => {
  const root = fixture(t);
  const parent = { PATH: '/bin', HOME: '/real-home', MIXR_DATA_DIR: '/real-data',
    MIXROUTER_PORT: '8787', MIXUI_PORT: '8788', NODE_OPTIONS: '--trace-warnings', NODE_TEST_CONTEXT: 'child-v8',
    DSH_HOME: '/real-dsh' };
  const saved = { ...parent };
  const env = testEnv(parent, root);
  assert.deepEqual(parent, saved);
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'TMPDIR', 'TMP', 'TEMP',
    'MIXR_DATA_DIR', 'MIXR_CLAUDE_SETTINGS', 'MIXR_CODEX_CONFIG']) {
    assert.ok(env[key].startsWith(root + path.sep), `${key} 未隔离`);
  }
  // 已移除的客户端/集成不再有专属落点:不设这些变量,也就不会在临时目录里造空壳。
  for (const key of ['MIXR_ZCODE_CONFIG', 'DSH_HOME', 'MIXR_HARNESS_PROFILE']) {
    assert.equal(env[key], undefined, `${key} 不该再出现在测试环境里`);
  }
  assert.equal(env.MIXROUTER_ALT_PORTS, undefined);
  assert.equal(env.NODE_TEST_CONTEXT, undefined);
  assert.equal(env.MIXR_SESSION_LABEL, undefined);
  assert.equal(env.MIXR_UPSTREAM_PROXY, '');
  assert.equal(env.MIXROUTER_PORT, '0');
  assert.equal(env.MIXUI_PORT, '0');
  assert.equal(env.PATH, parent.PATH);
  assert.equal(env.NODE_OPTIONS, parent.NODE_OPTIONS);
});

test('测试入口:成功与失败保留真实退出码,结束后清理整个隔离目录', t => {
  const root = fixture(t);
  for (const fail of [false, true]) {
    const file = path.join(root, `${fail ? 'fail' : 'pass'}.test.js`);
    fs.writeFileSync(file, "const {test}=require('node:test'); const a=require('node:assert/strict');" +
      "console.log('ISOLATED_HOME='+process.env.HOME);" +
      `test('sample',()=>a.equal(1,${fail ? 2 : 1}));`);
    const result = spawnSync(process.execPath, [runner, file], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, fail ? 1 : 0, result.stderr + result.stdout);
    const match = result.stdout.match(/ISOLATED_HOME=([^\r\n]+)/);
    assert.ok(match, result.stdout);
    assert.equal(fs.existsSync(path.dirname(match[1])), false, '隔离根目录应完整清理');
  }
});

test('测试入口:不存在或非测试文件直接失败,不把空测试集报成通过', t => {
  const root = fixture(t);
  for (const file of [path.join(root, 'missing.test.js'), path.join(root, 'not-test.js')]) {
    if (file.endsWith('not-test.js')) fs.writeFileSync(file, 'process.exit(0);');
    const result = spawnSync(process.execPath, [runner, file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENOENT|只接受/);
  }
});

test('测试入口:运行包没有 test/ 时明确报错,不伪装成全绿', t => {
  // Release 制品是运行包,不含开发测试套件。`npm test` 在包里必须**失败并说清楚**,
  // 而不是回一个空测试集退出 0 —— 那会让"没跑测试"看起来和"测试全绿"一模一样。
  //
  // 入口的根目录取自脚本自身位置(__dirname/..),所以不能用 cwd 模拟"包里没 test/";
  // 这里把**随包发布的那份脚本**原样复制到一个没有 test/ 的临时根目录里再跑。
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'scripts'));
  const shipped = path.join(root, 'scripts', 'run-tests.js');
  fs.copyFileSync(runner, shipped);
  const result = spawnSync(process.execPath, [shipped], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, '缺少 test/ 时不得退出 0');
  const all = result.stderr + result.stdout;
  assert.match(all, /不含开发测试套件/, `错误信息要说明这是运行包: ${all}`);
  assert.match(all, /npm run smoke/, '错误信息要给出运行包里的验证方式');
  // 纯函数同样的口径,便于调用方(如 lib/diagnostics/run.js)复用而不必起子进程。
  assert.throws(() => testFiles(root), /不含开发测试套件/);
});
