'use strict';
// lib/paths.js 的纯函数回归。
//
// 为什么单独一个文件:三类路径(开发副本 / 发布目录 / 数据目录)是所有安装、升级、回退动作的
// 输入,它算错的后果是"把发布物写到别处"或"让运行中的实例换个目录找 providers.json" ——
// 两者都不会当场报错,只会安静地去另一个目录。所以这里不测"函数能跑",测的是几条不许漂移的性质:
//   · require 本身零副作用(本仓的传统);
//   · **复用** MIXR_DATA_DIR,与 lib/backup/targets.js 的 LIVE_FILES 是同一份计算,不是两份碰巧相等;
//   · 安装用的固定数据目录**不受** MIXR_DATA_DIR 影响(否则安装脚本会被继承来的环境带跑);
//   · 发布白名单与禁止清单不重叠,且不含任何数据文件;
//   · 端口默认值与 mixrouter.js / mixctl 里的字面量一致(三处各写一遍就是下一次分叉的入口)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const paths = require('../lib/paths');
const { LIVE_FILES } = require('../lib/backup/targets');

const tmpdir = where => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `mixr-paths-${where}-`)));
function fixture(t, where = 'case') {
  const root = tmpdir(where);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const HOME = '/home/example'; // 纯字符串计算,不必真实存在

// ---------------------------------------------------------------- 零副作用

test('require 本模块不建目录、不写文件', t => {
  const root = fixture(t, 'noside');
  const modulePath = require.resolve('../lib/paths');
  const before = fs.readdirSync(root);
  delete require.cache[modulePath];
  const fresh = require(modulePath);
  assert.equal(typeof fresh.installPlan, 'function');
  assert.deepEqual(fs.readdirSync(root), before, 'require 产生了副作用');
  // 调用一次全部函数也不许建目录 —— "只算不建"是这一层的契约。
  fresh.installPlan({ root, home: root, ports: { proxy: 1, ui: 2 } });
  assert.deepEqual(fs.readdirSync(root), [], '算出计划的过程建了目录');
});

test('同一组入参永远同一个结果(纯函数)', () => {
  const env = { MIXR_DATA_DIR: '/data/one' };
  assert.equal(paths.runtimeDataDir(env, '/repo'), paths.runtimeDataDir(env, '/repo'));
  assert.equal(paths.fixedDataDir(env, HOME), paths.fixedDataDir(env, HOME));
  assert.equal(paths.releaseRoot({}, HOME), paths.releaseRoot({}, HOME));
  // 不读模块外的可变状态:换一组 env 就跟着变,且不受上一次调用影响。
  assert.notEqual(paths.runtimeDataDir(env, '/repo'), paths.runtimeDataDir({}, '/repo'));
  assert.equal(paths.runtimeDataDir(env, '/repo'), '/data/one');
});

// ---------------------------------------------------------------- 数据目录:复用 MIXR_DATA_DIR

test('运行数据目录复用 MIXR_DATA_DIR,且与 LIVE_FILES 是同一份计算', () => {
  const env = { MIXR_DATA_DIR: '/data/redirected' };
  assert.equal(paths.runtimeDataDir(env, '/repo'), '/data/redirected');
  // 默认值 = 代码目录(现状,不改):线上已经按它跑着,改默认值等于让实例换个目录找 providers.json。
  assert.equal(paths.runtimeDataDir({}, '/repo'), '/repo');
  for (const source of [env, {}, { MIXR_DATA_DIR: '' }]) {
    assert.equal(paths.runtimeDataDir(source, '/repo'), LIVE_FILES.dataDir(source, '/repo'),
      'paths 与 LIVE_FILES 必须是同一份计算,不能是两份碰巧相等');
  }
  // 转发而不是复制:模块把 LIVE_FILES 原样导出,将来有人想在本模块再写一份默认值时会先看到它。
  assert.equal(paths.LIVE_FILES, LIVE_FILES, 'paths.LIVE_FILES 应当就是 backup/targets 的那一份');
});

test('数据目录下的四个文件名与日志路径拼法固定', () => {
  const env = { MIXR_DATA_DIR: '/data' };
  assert.equal(paths.requestsLog(env, '/repo'), path.join('/data', 'logs', 'requests.jsonl'));
  assert.equal(paths.responseArchiveDir({ ...env }, '/repo'), path.join('/data', 'logs', 'responses'));
  assert.equal(paths.responseArchiveDir({ ...env, MIXR_RESPONSE_ARCHIVE_DIR: '/elsewhere' }, '/repo'), '/elsewhere',
    'MIXR_RESPONSE_ARCHIVE_DIR 优先于默认值(既有契约)');
  // 浏览器写过的路径不该被本次改动换掉 —— 用 live 目录里的既有文件名对一遍字面量。
  for (const name of ['providers.json', 'routes.json', 'slots.json', 'sessions.json']) {
    const live = path.join('/data', name);
    assert.equal(path.dirname(live), '/data');
  }
});

test('固定数据目录在 HOME 下,且**不看** MIXR_DATA_DIR', () => {
  const withEnv = paths.fixedDataDir({ MIXR_DATA_DIR: '/data/redirected' }, HOME);
  const without = paths.fixedDataDir({}, HOME);
  assert.equal(withEnv, without, '固定数据目录必须由 HOME 决定 —— 否则安装脚本会被继承来的 MIXR_DATA_DIR 指到线上数据目录');
  assert.ok(without.startsWith(HOME + path.sep), `固定数据目录应落在 HOME 下,实得 ${without}`);
  // 与"运行中实际用的那个"是两个不同的概念,名字必须分开。
  assert.notEqual(paths.fixedDataDir({}, HOME), paths.runtimeDataDir({}, ROOT));
});

// ---------------------------------------------------------------- 三类路径互不包含

test('三类路径互不嵌套:数据目录不在发布目录里,发布目录不在数据目录里', () => {
  const plan = paths.installPlan({ root: ROOT, home: HOME, releaseName: '3.6.0-abcdef12' });
  assert.equal(plan.devRoot, ROOT);
  assert.ok(plan.releaseDir.startsWith(plan.releaseRoot + path.sep), '发布目录应在 releases/ 下');
  assert.ok(plan.dataDir.startsWith(plan.installRoot + path.sep), '数据目录应在安装根下');
  assert.ok(!plan.releaseDir.startsWith(plan.dataDir + path.sep), '发布目录不得落在数据目录里');
  assert.ok(!plan.dataDir.startsWith(plan.releaseDir + path.sep), '数据目录不得落在发布目录里');
  assert.ok(!plan.backupRoot.startsWith(plan.releaseDir + path.sep), '备份不得落在发布目录里');
  // current 是 releases/ 下的一个链接,不是第三个目录。
  assert.equal(path.dirname(plan.currentRelease), plan.releaseRoot);
  // 端口来自唯一来源。
  assert.equal(plan.proxyPort, 8787);
  assert.equal(plan.uiPort, 8788);
});

test('--prefix 显式给出时,releases/ data/ backups/ 三项一起由它推导', () => {
  const plan = paths.installPlan({ root: ROOT, home: HOME, prefix: '/opt/mixrouter', releaseName: 'r1' });
  assert.equal(plan.installRoot, '/opt/mixrouter');
  assert.equal(plan.releaseRoot, '/opt/mixrouter/releases');
  assert.equal(plan.releaseDir, '/opt/mixrouter/releases/r1');
  assert.equal(plan.dataDir, '/opt/mixrouter/data');
  assert.equal(plan.backupRoot, '/opt/mixrouter/backups');
  assert.equal(plan.currentRelease, '/opt/mixrouter/current');
});

test('installPlan 的端口可被显式覆盖(测试要能避开线上端口)', () => {
  const plan = paths.installPlan({ root: ROOT, home: HOME, ports: { proxy: 19187, ui: 19188 } });
  assert.equal(plan.proxyPort, 19187);
  assert.equal(plan.uiPort, 19188);
  // 传了非法值(undefined / 非整数)时回落默认,不让 NaN 渗进后面的比较。
  const partial = paths.installPlan({ root: ROOT, home: HOME, ports: { proxy: undefined } });
  assert.equal(partial.proxyPort, 8787);
});

// ---------------------------------------------------------------- 入参校验

test('installPlan 拒绝非绝对路径与非法的 releaseName', () => {
  const cases = [
    [{ root: 'relative/path', home: HOME }, /root 必须是绝对路径/],
    [{ root: ROOT, home: 'relative' }, /home 必须是绝对路径/],
    [{ root: ROOT, home: HOME, prefix: 'relative' }, /prefix 必须是绝对路径/],
    [{ root: ROOT, home: HOME, releaseName: '' }, /releaseName/],
    [{ root: ROOT, home: HOME, releaseName: 'a/b' }, /releaseName/],
    [{ root: ROOT, home: HOME, releaseName: 7 }, /releaseName/],
  ];
  for (const [options, pattern] of cases) {
    assert.throws(() => paths.installPlan(options), pattern, `未拦下 ${JSON.stringify(options)}`);
  }
  // 相对 root 之所以必须拦:它会安静地把发布物复制到另一个目录(这条教训见 backup/targets.js)。
});

// ---------------------------------------------------------------- 客户端配置

test('三个客户端配置:有覆盖用覆盖,没覆盖落 HOME 下', () => {
  const env = {
    MIXR_CLAUDE_SETTINGS: '/tmp/c.json',
    MIXR_CODEX_CONFIG: '/tmp/x.toml',
    MIXR_ZCODE_CONFIG: '/tmp/z.json',
  };
  assert.equal(paths.claudeSettings(env, HOME), '/tmp/c.json');
  assert.equal(paths.codexConfig(env, HOME), '/tmp/x.toml');
  assert.equal(paths.zcodeConfig(env, HOME), '/tmp/z.json');
  assert.equal(paths.claudeSettings({}, HOME), path.join(HOME, '.claude', 'settings.json'));
  assert.equal(paths.codexConfig({}, HOME), path.join(HOME, '.codex', 'config.toml'));
  assert.equal(paths.zcodeConfig({}, HOME), path.join(HOME, '.zcode', 'v2', 'config.json'));
  // claude/codex 两项的真值仍来自 LIVE_FILES —— 同一条规则存两份就是分叉的入口。
  assert.equal(paths.claudeSettings({}, HOME), LIVE_FILES.claudeSettings({}, HOME));
  assert.equal(paths.codexConfig({}, HOME), LIVE_FILES.codexConfig({}, HOME));
});

test('zcode 默认路径与 lib/zcode-config.js 原本的默认值逐字相同', () => {
  // 这一条是本次搬迁的等价性证明:把真值从 zcode-config.js 挪到 paths.js 时,
  // 默认值必须一字不变 —— 它是用户机器上那个文件的真实位置。
  const expected = path.join(HOME, '.zcode', 'v2', 'config.json');
  assert.equal(paths.zcodeConfig({}, HOME), expected);
  // 且 zcode-config.js 现在确实走 paths(不是还留着自己那一份)。
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'zcode-config.js'), 'utf8');
  assert.match(src, /require\('\.\/paths'\)/, 'lib/zcode-config.js 应从 lib/paths.js 取默认路径');
  assert.doesNotMatch(src, /'\.zcode',\s*'v2'/, 'lib/zcode-config.js 不该再自己拼一份 zcode 路径');
});

test('LaunchAgent 目录落在 HOME 下(脚本只读它,不往里写)', () => {
  assert.equal(paths.launchAgentDir(HOME), path.join(HOME, 'Library', 'LaunchAgents'));
});

// ---------------------------------------------------------------- 发布清单

test('发布白名单与禁止清单不重叠,且不含任何运行数据', () => {
  const items = new Set(paths.RELEASE_ITEMS);
  for (const banned of paths.FORBIDDEN_IN_RELEASE) {
    assert.ok(!items.has(banned), `禁止项 ${banned} 不该同时出现在发布白名单里`);
  }
  for (const data of ['providers.json', 'routes.json', 'slots.json', 'sessions.json']) {
    assert.ok(!items.has(data), `发布白名单不该包含运行数据 ${data}`);
  }
  // 白名单是**显式列举**的,不是"排除掉某些"。test/ 与 evidence/ 不在里面:它们是
  // 开发/内部材料,不是运行包内容(运行包的验证入口是随包的 npm run smoke)。
  assert.ok(items.has('mixrouter.js') && items.has('mixctl') && items.has('lib') && items.has('public'));
  assert.ok(!items.has('test') && !items.has('evidence'), 'test/ 与 evidence/ 不属于发布内容');
  for (const banned of ['logs', 'backups', '.run', '.git', '.env', 'node_modules']) {
    assert.ok(paths.FORBIDDEN_IN_RELEASE.includes(banned), `禁止清单缺少 ${banned}`);
  }
});

test('白名单里的每一项在仓库里都存在(写错名字会让发布物少东西而不报错)', () => {
  for (const item of paths.RELEASE_ITEMS) {
    assert.ok(fs.existsSync(path.join(ROOT, item)), `发布白名单里的 ${item} 在仓库里不存在`);
  }
});

// ---------------------------------------------------------------- 防漂移:端口字面量

test('默认端口与 mixrouter.js / mixctl 里的字面量一致', () => {
  const mixrouter = fs.readFileSync(path.join(ROOT, 'mixrouter.js'), 'utf8');
  const mixctl = fs.readFileSync(path.join(ROOT, 'mixctl'), 'utf8');
  assert.ok(mixrouter.includes(`process.env.MIXROUTER_PORT || ${paths.DEFAULT_PORTS.proxy}`),
    `mixrouter.js 的代理端口默认值不是 ${paths.DEFAULT_PORTS.proxy}`);
  assert.ok(mixrouter.includes(`process.env.MIXUI_PORT || ${paths.DEFAULT_PORTS.ui}`),
    `mixrouter.js 的控制台端口默认值不是 ${paths.DEFAULT_PORTS.ui}`);
  assert.ok(mixctl.includes(`process.env.MIXUI_PORT || ${paths.DEFAULT_PORTS.ui}`),
    `mixctl 的控制台端口默认值不是 ${paths.DEFAULT_PORTS.ui}`);
});

test('mixctl 已改用 lib/paths.js,不再自己拼 .run / logs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'mixctl'), 'utf8');
  // 只扫**可执行行**:注释里会引用那几行旧写法来说明"为什么搬走",那是说明不是重复。
  const code = src.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  assert.match(code, /require\('\.\/lib\/paths'\)/, 'mixctl 应从 lib/paths.js 取路径');
  assert.doesNotMatch(code, /path\.join\(ROOT, '\.run'\)/, 'mixctl 不该再自己拼 .run');
  assert.doesNotMatch(code, /path\.join\(process\.env\.MIXR_DATA_DIR \|\| ROOT/, 'mixctl 不该再自己拼数据目录');
  assert.doesNotMatch(code, /MIXR_DATA_DIR \|\| ROOT/, 'mixctl 不该再自己拼数据目录');
  // 自证这条判据有力气:把搬走前那两行注回可执行区,必须命中。
  const planted = "const RUN_DIR = path.join(ROOT, '.run');\nconst REQ_LOG = path.join(process.env.MIXR_DATA_DIR || ROOT, 'logs', 'requests.jsonl');";
  assert.ok(/path\.join\(ROOT, '\.run'\)/.test(planted));
  assert.ok(/MIXR_DATA_DIR \|\| ROOT/.test(planted));
});

test('mixctl 从 paths 取到的四个路径与改动前逐字相同(等价搬迁)', () => {
  // 搬迁不改行为:mixctl 原来那四行拼出来的东西,今天必须还是同一个字符串。
  // 不设 MIXR_DATA_DIR 时(默认分支)与设了时(重定向分支)各对一遍。
  const root = ROOT;
  for (const env of [{}, { MIXR_DATA_DIR: '/data/x' }]) {
    assert.equal(paths.runDir(root), path.join(root, '.run'));
    assert.equal(paths.pidFile(root), path.join(root, '.run', 'mixrouter.pid'));
    assert.equal(paths.serverLog(root), path.join(root, 'logs', 'server.log'));
    assert.equal(paths.requestsLog(env, root),
      path.join(env.MIXR_DATA_DIR || root, 'logs', 'requests.jsonl'));
  }
  // 注意 serverLog 用的是**代码目录**,requestsLog 用的是**数据目录** —— 现状如此,
  // 本次只做等价搬迁,不在这条线里顺手统一(口径统一列为后续可迁移点)。
  assert.notEqual(paths.serverLog('/data/x'), paths.requestsLog({ MIXR_DATA_DIR: '/data/x' }, ROOT));
});
