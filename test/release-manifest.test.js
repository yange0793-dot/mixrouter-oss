'use strict';
// 制品清单(scripts/release-manifest.js)的回归。
//
// 这组用例防的是**发布包把运行数据带出去**和**发布包静默少东西**两类事故,而它们的
// 共同特点是:出问题时没有任何一步会报错 —— tarball 照样打得出来,`gh release create`
// 照样成功。所以这里不测"函数返回了真值",而是测两件具体的事:
//
//   · 判定:哪条路径进、哪条不进(含 providers.json / logs/ 这类**绝不能进**的);
//   · 存在:清单里写下的每条路径在仓库里**真有**。少一个改了名的目录时,判定用例
//     全绿、制品却少一整块 —— 这条比上一条更值钱。
//
// 另外专门为 `public/js/app.js` 与 `public/styles/base.css` 各写一条断言:它们是控制台
// 拆分**新增**的文件,旧清单/旧 archive 习惯里没有它们,是最容易漏的两个。
//
// 还有一条容易漏的是 docs:四份**用户文档**由 README 链接,不进制品就是解压即死链;
// 而 docs/changes/ 是内部记录必须挡住。两条都单独断言。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  INCLUDE, INCLUDE_WHY, EXCLUDE, RUNTIME_DATA_FILES, RUNTIME_DATA_DIRS,
  REQUIRED_ENTRIES, REQUIRED_MAINTENANCE_ENTRIES,
  inBase, isRuntimeData, isExcluded, include, filterTracked, releaseInfo, check,
  packageVersion, checkTag, entryVersion, checkVersions,
} = require('../scripts/release-manifest.js');
const { RELEASE_ITEMS, FORBIDDEN_IN_RELEASE } = require('../lib/paths');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- 单一来源
test('清单以 lib/paths.js 的 RELEASE_ITEMS 为基底,不另写第二份白名单', () => {
  // 这条是本模块最核心的约束:"装什么"只有一个来源,否则两个出口会分叉
  // (lib/backup/targets.js 的注释记过那次事故)。不是断言"内容相等",而是断言
  // INCLUDE **就是**那一份 —— 同一引用,改一处两边都动。
  assert.deepEqual([...INCLUDE], [...RELEASE_ITEMS], 'INCLUDE 必须与 RELEASE_ITEMS 同源同值');
  // 不得出现"清单里多出一个 RELEASE_ITEMS 没有的目录/文件"的情况 —— 那说明有人
  // 又在这里补了一份白名单。要加就加到 lib/paths.js 那一处。
  for (const item of INCLUDE) assert.ok(RELEASE_ITEMS.includes(item), `${item} 不在 RELEASE_ITEMS 里,说明清单被写成了第二份`);
});

test('每条纳入项都有"为什么"的解释,且解释不引入 RELEASE_ITEMS 里没有的项', () => {
  for (const item of INCLUDE) assert.ok(INCLUDE_WHY[item], `INCLUDE_WHY 缺少 ${item} 的说明`);
  for (const key of Object.keys(INCLUDE_WHY)) assert.ok(INCLUDE.includes(key), `INCLUDE_WHY 里的 ${key} 不在 RELEASE_ITEMS 里`);
});

// ---------------------------------------------------------------- 判定
test('include:产品源码与资源进包', () => {
  for (const rel of [
    'mixrouter.js', 'mixctl', 'package.json', 'LICENSE', 'README.md',
    'lib/routing/sessions.js', 'lib/http/console.js',
    'public/index.html', 'public/js/app.js', 'public/styles/base.css',
    'scripts/import-ccswitch.js', 'scripts/run-tests.js',
    'app/MixrouterApp.swift', 'providers.example.json', 'routes.example.json',
  ]) assert.equal(include(rel), true, `${rel} 应当进制品`);
});

test('inBase:基底判定对文件精确匹配、对目录前缀匹配', () => {
  assert.equal(inBase('mixrouter.js'), true, '基底里的文件本身');
  assert.equal(inBase('lib/a/b/c.js'), true, '基底里的目录 -> 其下任意层级');
  assert.equal(inBase('docs/quick-start.md'), true, 'docs 是基底目录');
  assert.equal(inBase('scripts/smoke-offline.js'), true, 'scripts 是基底目录');
  assert.equal(inBase('test/x.js'), false, 'test 是开发套件,只在 GitHub 源码仓库里跑');
  assert.equal(inBase('evidence/x.log'), false, 'evidence 不在基底里');
  assert.equal(inBase('libx/y.js'), false, 'lib 不得把 libx 也前缀命中(必须是 lib/)');
});

test('include:运行数据一律不进包', () => {
  // 这六条是硬底线:它们含明文 Key、会话记录和请求日志。
  for (const rel of [
    'providers.json', 'routes.json', 'sessions.json', 'slots.json',
    'logs/x.jsonl', 'backups/x',
  ]) assert.equal(include(rel), false, `${rel} 绝不能进制品`);
});

test('include:开发/内部材料不进包', () => {
  for (const rel of [
    'docs/changes/refactor-plan-2026-10-16.md',
    'evidence/wiring-fullrun.log', 'AUDIT-2026-09-17.md',
    '.github/workflows/ci.yml', 'node_modules/x/index.js', '.gitignore',
  ]) assert.equal(include(rel), false, `${rel} 不该进制品`);
});

test('include:作者本机的上线/预检脚本不进包,同目录的用户脚本照常进', () => {
  // deploy-live.sh 会 stop/restart 服务,preflight-live-data.js 读作者线上数据目录;
  // 两者的默认值都指向作者机器。随源码包发布等于把一条危险命令递给别人,而且
  // 它也不是任何文档里的公开安装路径。
  for (const rel of ['scripts/deploy-live.sh', 'scripts/preflight-live-data.js'])
    assert.equal(include(rel), false, `${rel} 只在作者机器上有意义,不该进制品`);
  // 同目录里的用户脚本不能被误伤 —— 排除是按精确路径,不是按 scripts/ 前缀。
  for (const rel of ['scripts/install-macos.sh', 'scripts/diagnose-upstream.js',
    'scripts/import-ccswitch.js', 'scripts/smoke-offline.js', 'scripts/run-tests.js'])
    assert.equal(include(rel), true, `${rel} 是用户脚本,应进制品`);
});

test('include:test/ 不进运行包,整套开发测试只在 GitHub 源码仓库跑', () => {
  // Release 制品是**运行包**:不少开发用例会读 .github / .gitignore / docs/changes / evidence,
  // 这些同样不进包 —— 把 test/ 单塞进运行包只会得到一套必然失败的测试,而不是"更好的制品"。
  // 运行包的验证入口是随包的 `npm run smoke`;包里 `npm test` 由 scripts/run-tests.js 明确报错。
  for (const rel of ['test/release-manifest.test.js', 'test/proxy.test.js'])
    assert.equal(include(rel), false, `${rel} 是开发测试,不该进运行包`);
  assert.equal(isExcluded('test'), true);
  // 而被脚本与文档引用的运行期测试入口仍在包里(它们不是测试套件本身)。
  for (const rel of ['scripts/run-tests.js', 'scripts/smoke-offline.js'])
    assert.equal(include(rel), true, `${rel} 是被文档引用的脚本,应进运行包`);
});

test('include:模板文件不被运行时数据规则误伤', () => {
  // providers.example.json 是给用户照着填的模板,它在仓库根、名字像 providers.json,
  // 但**不含任何真 Key**。它必须进包,否则用户没有起点。
  assert.equal(include('providers.example.json'), true);
  assert.equal(include('routes.example.json'), true);
  assert.equal(isRuntimeData('providers.example.json'), false);
});

test('isRuntimeData:.tmp / .bak / 运行目录的各种变体都算运行数据', () => {
  // 落盘是原子的:providers.json.tmp 是先写后 rename 的中间态;备份名是
  // `<file>.bak-mixui-<时间戳>`,手工排查还可能留 `<file>.bak`。这些都不是发布物。
  for (const rel of ['providers.json.tmp', 'routes.json.bak-20260101-000000-abcd',
    'sessions.json.tmp', 'slots.json.bak', 'settings.json.bak', '.run/x.pid']) {
    assert.equal(isRuntimeData(rel), true, `${rel} 应判为运行数据`);
    assert.equal(include(rel), false, `${rel} 绝不能进制品`);
  }
});

test('include:运行数据判定先于基底 —— 藏在基底目录里的运行数据也放行不了', () => {
  // include() 里运行数据的判定**先于**基底。证明方式:挑两条**确实在基底里**的路径
  // (lib/ 与 public/ 都是 RELEASE_ITEMS 的目录项),它们的名字却是运行数据文件名。
  // 只靠基底判定会放行,靠 isRuntimeData 才挡得住 —— 这正是"有人 git add -f 之后
  // 运行数据跟着某个目录混进来"的场景。
  const inBaseButRuntime = [
    { rel: 'lib/sessions.json', why: 'lib 是基底目录' },
    { rel: 'public/providers.json', why: 'public 是基底目录' },
    { rel: 'app/logs/requests.jsonl', why: 'app 是基底目录,且落在 logs/ 下' },
  ];
  for (const { rel, why } of inBaseButRuntime) {
    assert.equal(inBase(rel), true, `${rel} 应当命中基底(${why})——否则这条用例证明不了"先于基底"`);
    assert.equal(isRuntimeData(rel), true, `${rel} 应当被判为运行数据`);
    assert.equal(include(rel), false, `${rel} 运行数据判定必须先于基底`);
  }
  // 另一层保险:INCLUDE 是冻结的(它就是 Object.freeze 过的 RELEASE_ITEMS),
  // 想往里塞一条也塞不进 —— 与上面的顺序判定互为纵深防御。
  assert.ok(Object.isFrozen(INCLUDE), 'INCLUDE 应当是被冻结的 RELEASE_ITEMS');
  assert.throws(() => INCLUDE.push('providers.json'), TypeError);
});

// ---------------------------------------------------------------- 存在性(比判定更重要)
test('清单里每条路径在仓库里真实存在', () => {
  // 漏一条改过名的目录时,判定用例全绿,制品却少一整块。这条把它红出来。
  // RELEASE_ITEMS 里既有**文件**也有**目录**,所以这里不假设类型 —— 只要它存在:
  // 文件与目录各自 existSync 都成立,一条断言同时管两类。
  const missing = INCLUDE.filter(item => !fs.existsSync(path.join(ROOT, item)));
  assert.deepEqual(missing, [], `清单列了仓库里不存在的路径: ${missing.join(', ')}`);
  // 目录项额外要求"确实非空":空目录多半是改名后的残影,而存在性断言看不出这一点。
  for (const item of INCLUDE) {
    const full = path.join(ROOT, item);
    if (!fs.statSync(full).isDirectory()) continue;
    assert.ok(fs.readdirSync(full).length > 0, `${item} 是空目录,多半改过名`);
  }
});

// ---------------------------------------------------------------- docs 的两面
test('include:README 链接的四份用户文档进制品(否则解压即死链)', () => {
  // 这四份是任务 5 新增的**用户文档**,README 整理后会链接它们。README 在制品里,
  // 链接的目标也必须能在制品里解析,否则用户解压出来点开就是 404。
  // 此刻它们可能还没全部落盘 —— 所以断言的是**判定**(include),不是"文件存在"。
  for (const rel of ['docs/quick-start.md', 'docs/routing-and-sessions.md',
    'docs/troubleshooting.md', 'docs/upgrade-and-rollback.md'])
    assert.equal(include(rel), true, `${rel} 是用户文档,应进制品`);
  // 已经在盘上的那几份,顺带确认清单里的 docs 目录真的覆盖到它们
  for (const rel of ['docs/offline-run-and-acceptance.md', 'docs/quick-start.md'])
    assert.equal(include(rel), true, `${rel} 应进制品`);
});

test('include:docs/changes 仍然被排除(内部计划不随包发布)', () => {
  // 与上一条相对:docs 整个目录在基底里,但 docs/changes/ 是**内部证据**
  // (含尚未发布的规划与各期实施记录),必须单独减掉。这条防止将来有人
  // "为了省事"把 EXCLUDE 里的 docs/changes 删掉。
  for (const rel of [
    'docs/changes/refactor-plan-2026-10-16.md',
    'docs/changes/2026-10-16.md',
    'docs/changes/README.md',
    'docs/changes/phase4-release-2026-10-17.md',
  ]) assert.equal(include(rel), false, `${rel} 是内部记录,不该进制品`);
  assert.equal(isExcluded('docs/changes'), true);
});

test('include:scripts 里的开发专用脚本与 lib 都来自基底,无需逐条列举', () => {
  // RELEASE_ITEMS 把 scripts / lib 整目录纳入,所以新脚本自动随包走;
  // 同时 lib/runtime-code.js 这类也要在(发布说明要用它的 codeRevision 概念)。
  for (const rel of ['scripts/install-macos.sh', 'scripts/run-tests.js', 'lib/paths.js', 'lib/runtime-code.js'])
    assert.equal(include(rel), true, `${rel} 应进制品`);
});

test('两个消费方口径一致:RELEASE_ITEMS 的每项都进,FORBIDDEN_IN_RELEASE 的每项都不进', () => {
  // "装什么"现在只有一个来源(RELEASE_ITEMS),而"绝不装什么"的另一份基线在
  // lib/paths.js 的 FORBIDDEN_IN_RELEASE(安装脚本装完后靠它逐条核)。两份清单必须
  // 在**交集为空**这条上一致:白名单里的项永远不会同时出现在禁止清单里。
  for (const item of RELEASE_ITEMS)
    assert.ok(!FORBIDDEN_IN_RELEASE.includes(item), `${item} 同时在白名单与禁止清单里`);
  // 禁止清单的每一项都必须被 include() 拒绝 —— 否则发布物会带上安装脚本随后要拦的东西
  // (含明文 key 的文件、运行状态)。这条把两个出口钉在一起,而不是各测各的。
  for (const item of FORBIDDEN_IN_RELEASE) {
    assert.equal(include(item), false, `${item} 在 FORBIDDEN_IN_RELEASE 里,必须不进制品`);
    assert.equal(include(`${item}/x`), false, `${item}/ 下的内容同样不进制品`);
  }
});

// ---------------------------------------------------------------- filterTracked
test('filterTracked:逐个文件过滤,不整目录收', () => {
  // 输入是"HEAD 里已跟踪的文件"清单(workflow 由 `git ls-tree -r` 得到)。
  const tracked = [
    'mixrouter.js', 'lib/a.js', 'lib/routing/sessions.js',
    'public/index.html', 'public/js/app.js', 'public/styles/base.css',
    'providers.example.json', 'routes.example.json',
    'docs/quick-start.md', 'docs/changes/2026-10-16.md',
    'test/release-manifest.test.js', 'evidence/x.log', '.github/workflows/ci.yml',
    'scripts/deploy-live.sh',
    'providers.json', 'sessions.json', 'logs/2026-10-17.jsonl',
    'mixrouter.js', // 重复项:去重后只能出现一次
  ];
  const out = filterTracked(tracked);
  for (const rel of ['mixrouter.js', 'lib/a.js', 'lib/routing/sessions.js',
    'public/index.html', 'public/js/app.js', 'public/styles/base.css',
    'providers.example.json', 'docs/quick-start.md'])
    assert.ok(out.includes(rel), `${rel} 应当进制品`);
  for (const rel of ['docs/changes/2026-10-16.md', 'test/release-manifest.test.js', 'evidence/x.log',
    '.github/workflows/ci.yml', 'scripts/deploy-live.sh', 'providers.json', 'sessions.json', 'logs/2026-10-17.jsonl'])
    assert.ok(!out.includes(rel), `${rel} 不该进制品`);
  assert.equal(out.filter(p => p === 'mixrouter.js').length, 1, '重复项应去重');
  assert.deepEqual(out, [...out].sort(), '输出应排序(打包字节可复现)');
});

test('filterTracked:把 `git add -f` 过的运行数据挡在**任何位置**', () => {
  // 这是逐文件过滤相对"整目录收"的关键差别。反例:有人 `git add -f public/providers.json`,
  // `git archive HEAD public/` 会照收 —— 而清单判定是 false。逐文件过滤后,in／out 两边的
  // 判定完全由 include() 决定,不再受"父目录被收进来"影响。
  const out = filterTracked([
    'public/index.html', 'public/js/app.js', 'public/styles/base.css',
    'public/providers.json',              // 被 force-add 的运行数据
    'lib/sessions.json',                  // 藏在 lib 里的同名文件
    'app/logs/2026-10-17.jsonl',          // 藏在 app 里的日志目录
    'docs/changes/hidden-plan.md',        // 藏在基底目录里的内部记录
    'test/providers.json',                // 即使哪天 test/ 被放进基底,里面也不许夹带运行数据
  ]);
  assert.deepEqual(out, ['public/index.html', 'public/js/app.js', 'public/styles/base.css']);
});

test('filterTracked:空白与非字符串条目被忽略,不制造假路径', () => {
  assert.deepEqual(filterTracked(['mixrouter.js', '', '  ', null, undefined, './README.md']),
    ['README.md', 'mixrouter.js'], '空/空串应丢弃,`./` 前缀应归一化');
});

test('filterTracked 的结果全部能安全穿过 shell 分词,含元字符时抛错', () => {
  // workflow 里是 `git archive ... $(cat /tmp/archive-files.txt)` —— 依赖 IFS 把这份
  // 多行清单拆成参数。一旦有条目带空白、引号或 shell 元字符,拆分就会走样,`git archive`
  // 要么报 pathspec 不匹配(打包失败,还算好事),要么按错误的前缀收进一整棵子树
  // (静默多发东西)。正常清单必须全是纯 ASCII 路径字符。
  for (const p of filterTracked(['lib/routing/sessions.js', 'public/js/app.js', 'mixrouter.js'])) {
    assert.match(p, /^[A-Za-z0-9._/-]+$/, `${p} 含可能干扰 shell 分词的字符`);
    assert.ok(!p.startsWith('/') && !p.includes('..'), `${p} 必须是仓库内的相对路径`);
  }
  // 反过来:命中清单却带空白/引号的路径必须**抛错**,而不是静默丢弃 ——
  // 静默丢弃会让"打包成功"与"文件少了"同时发生,那正是本清单要防的事。
  assert.throws(() => filterTracked(['lib/存在 空格的模块.js']), /shell 元字符/);
  assert.throws(() => filterTracked(['lib/quote"d.js']), /shell 元字符/);
});

// ---------------------------------------------------------------- 关键入口
test('public 下的静态资源在清单内:app.js 与 base.css 是新增文件,最易漏', () => {
  // 控制台由单一 index.html 拆成 index.html + js/app.js + styles/base.css。旧清单与
  // "整包 archive"的习惯里没有后两个,所以单独钉死。
  assert.equal(include('public/js/app.js'), true, 'public/js/app.js 必须进制品');
  assert.equal(include('public/styles/base.css'), true, 'public/styles/base.css 必须进制品');
  assert.equal(include('public/index.html'), true, 'public/index.html 必须进制品');
  // 它们既要被判为"进",也真的在盘上(与上面的存在性用例互补)
  for (const rel of ['public/js/app.js', 'public/styles/base.css', 'public/index.html'])
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} 应当存在于仓库`);
  // 页面确实引用它们(拆分后 index.html 是靠这两个路径加载的)
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('/js/app.js'), 'index.html 应引用 /js/app.js');
  assert.ok(html.includes('/styles/base.css'), 'index.html 应引用 /styles/base.css');
});

test('REQUIRED_ENTRIES 覆盖 mixrouter.js 与控制台全部脚本和样式', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="(\/(?:js|styles)\/[^"?#]+)"/g)].map(m => 'public' + m[1]);
  assert.ok(assets.includes('public/js/workspace.js'));
  assert.ok(assets.includes('public/js/usage.js'));
  for (const rel of ['mixrouter.js', 'public/index.html', ...assets])
    assert.ok(REQUIRED_ENTRIES.includes(rel), `${rel} 应在关键入口列表里`);
  // 关键入口必须真的在清单内,否则 CI 会在解包后立刻红
  for (const rel of REQUIRED_ENTRIES) assert.equal(include(rel), true, `${rel} 是关键入口,必须在清单内`);
});

test('维护条目在清单内:验证入口与三份维护文档缺一不可', () => {
  // 运行包要能验、能读、能报告问题。这一组少了任意一条,制品照样能解压、服务照样能起 ——
  // 只有用户会撞上"不知道用什么验证"或"无处报告安全问题"。
  for (const rel of REQUIRED_MAINTENANCE_ENTRIES) {
    assert.equal(include(rel), true, `${rel} 是关键维护条目,必须在清单内`);
    // INCLUDE_WHY 按**基底条目**写(scripts 整目录一条),子路径不单独要求。
    const top = INCLUDE.find(item => rel === item || rel.startsWith(item + '/'));
    assert.ok(top && INCLUDE_WHY[top], `${rel} 所属的基底条目 ${top} 在 INCLUDE_WHY 里没有说明`);
  }
  // 运行包的验证入口是 smoke,不是 npm test —— 后者在包里会被明确拒绝。
  assert.ok(REQUIRED_MAINTENANCE_ENTRIES.includes('scripts/smoke-offline.js'));
  assert.ok(!REQUIRED_MAINTENANCE_ENTRIES.includes('test'), 'test/ 不属于运行包的维护条目');
});

// ---------------------------------------------------------------- 运行数据基线
test('运行数据基线本身不含模板文件,且全部都在排除清单里', () => {
  assert.deepEqual(RUNTIME_DATA_FILES, ['providers.json', 'routes.json', 'sessions.json', 'slots.json', 'client-managed.json']);
  assert.deepEqual(RUNTIME_DATA_DIRS, ['logs', 'backups', '.run']);
  // 基线里的每一项都被 include() 拒绝(注意:它们不在基底里,靠的是 isRuntimeData 兜底)
  for (const rel of [...RUNTIME_DATA_FILES, ...RUNTIME_DATA_DIRS.map(d => `${d}/x`)])
    assert.equal(include(rel), false, `${rel} 绝不能进制品`);
  // 每一项都要能在某处找到"为什么不进包"的说明,不能只靠 isRuntimeData 兜底而没人解释
  const explained = new Set([...RUNTIME_DATA_FILES, ...RUNTIME_DATA_DIRS]);
  for (const rel of explained)
    assert.ok(isExcluded(rel), `${rel} 应被判为排除`);
});

// ---------------------------------------------------------------- 发布身份信息
test('releaseInfo:输出 version / 40 位 revision / 短 sha,且与 codeRevision 分开', () => {
  const sha = 'a'.repeat(40);
  const code = 'b'.repeat(64);
  const info = releaseInfo({ version: '3.6.0', revision: sha, codeRevision: code });
  assert.equal(info.version, '3.6.0');
  assert.equal(info.revision, sha);
  assert.equal(info.revision_short, 'a'.repeat(12));
  assert.equal(info.code_revision, code);           // 运行期指纹,与 git 修订不同字段
  assert.notEqual(info.revision, info.code_revision);
  assert.equal(info.name, 'mixrouter');
  // 缺 codeRevision 时给 null,不拿 revision 顶上(冒充"已核对运行指纹"是最坏的一种谎)
  const bare = releaseInfo({ version: '3.6.0', revision: sha });
  assert.equal(bare.code_revision, null);
});

test('releaseInfo:版本或修订形状不对时抛错,不产出半份身份', () => {
  const sha = 'a'.repeat(40);
  assert.throws(() => releaseInfo({ revision: sha }), /version/);
  assert.throws(() => releaseInfo({ version: '3.6.0' }), /revision/);
  assert.throws(() => releaseInfo({ version: '3.6.0', revision: 'ABC' }), /revision/);
  assert.throws(() => releaseInfo({ version: '3.6.0', revision: sha, codeRevision: 'xyz' }), /code_revision/);
});

test('releaseInfo:同一份源码重复产出的身份逐字节相同(校验和才有意义)', () => {
  // 身份里带时间戳的话,同一 commit 两次打包 sha256 不同,"比对校验和"这件事就废了。
  const args = { version: '3.6.0', revision: 'c'.repeat(40) };
  assert.equal(JSON.stringify(releaseInfo(args)), JSON.stringify(releaseInfo({ ...args })));
});

// ---------------------------------------------------------------- check()(CI 用的那一步)
test('check:含运行数据或不含关键入口时红,干净制品绿', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-manifest-'));
  try {
    const put = (rel, text) => {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
    };
    // 干净制品:四个关键入口 + 维护条目齐全
    for (const rel of REQUIRED_ENTRIES) put(rel, 'x');
    for (const rel of REQUIRED_MAINTENANCE_ENTRIES) put(rel, 'x');
    assert.equal(check(dir).ok, true, check(dir).errors.join('; '));

    // 塞一个会话文件进去 —— 必须红,且错误里点名是哪条
    put('sessions.json', '{"version":1,"bindings":{}}');
    const dirty = check(dir);
    assert.equal(dirty.ok, false);
    assert.ok(dirty.errors.some(e => e.includes('sessions.json')), `错误应点名 sessions.json: ${dirty.errors}`);
    fs.rmSync(path.join(dir, 'sessions.json'));

    // 少了 public/js/app.js —— 必须红
    fs.rmSync(path.join(dir, 'public/js/app.js'));
    const thin = check(dir);
    assert.equal(thin.ok, false);
    assert.ok(thin.errors.some(e => e.includes('public/js/app.js')), `错误应点名 public/js/app.js: ${thin.errors}`);
    for (const rel of REQUIRED_ENTRIES) put(rel, 'x');

    // 少验证入口 scripts/smoke-offline.js —— 运行包就没法自证,必须红且点名
    fs.rmSync(path.join(dir, 'scripts/smoke-offline.js'));
    const noSmoke = check(dir);
    assert.equal(noSmoke.ok, false);
    assert.ok(noSmoke.errors.some(e => e.includes('smoke-offline.js')), `错误应点名缺失的 smoke 入口: ${noSmoke.errors}`);
    put('scripts/smoke-offline.js', 'x');

    // 少了 SECURITY.md —— 用户无处私密报告,同样算制品不合格
    fs.rmSync(path.join(dir, 'SECURITY.md'));
    const noSec = check(dir);
    assert.equal(noSec.ok, false);
    assert.ok(noSec.errors.some(e => e.includes('SECURITY.md')), `错误应点名 SECURITY.md: ${noSec.errors}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 版本一致性(发版工作流用)
//
// 这一组防的是"发出去的制品说自己是一个版本、实际是另一个版本"。tag、package.json、
// mixrouter.js 的 VERSION 三处各自都合法,只有互相比对才看得出来;漏掉的后果是
// 用户的 /healthz、控制台横幅与 Release 标题互相矛盾,而没有任何一步会报错。
test('checkTag:tag 与 package.json 的 version 必须相等,允许 v 前缀与 refs/tags/ 形式', () => {
  assert.deepEqual(checkTag('v3.6.1', '3.6.1'), { tag: 'v3.6.1', version: '3.6.1' });
  assert.equal(checkTag('refs/tags/v3.6.1', '3.6.1').version, '3.6.1', 'refs/tags/ 前缀应被剥掉');
  assert.equal(checkTag('3.6.1', '3.6.1').tag, '3.6.1', '不带 v 前缀的 tag 也接受');
  // 不等就必须抛错,不能"记一条警告接着发"。
  assert.throws(() => checkTag('v3.6.0', '3.6.1'), /不一致/);
  assert.throws(() => checkTag('v3.6.1', '3.6.0'), /不一致/);
  assert.throws(() => checkTag('', '3.6.1'), /缺少 tag/);
  assert.throws(() => checkTag('v3.6.1', ''), /缺少 version/);
});

test('entryVersion:从 mixrouter.js 读入口自报的 VERSION,读不到就抛错', () => {
  assert.equal(entryVersion(), packageVersion(), '仓库当前 package.json 与 mixrouter.js 的 VERSION 应一致');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-entryver-'));
  try {
    fs.writeFileSync(path.join(dir, 'mixrouter.js'), "const VERSION = '9.9.9';\n");
    assert.equal(entryVersion(dir), '9.9.9');
    fs.writeFileSync(path.join(dir, 'mixrouter.js'), '// 没有 VERSION 行\n');
    assert.throws(() => entryVersion(dir), /找不到/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkVersions:tag / package.json / 入口 VERSION 三处一致才算通过', () => {
  assert.deepEqual(checkVersions({ version: '3.6.1', entry: '3.6.1' }),
    { version: '3.6.1', entry: '3.6.1', tag: null });
  assert.doesNotThrow(() => checkVersions({ tag: 'v3.6.1', version: '3.6.1', entry: '3.6.1' }));
  // 入口比 package.json 旧:运行期横幅会报错版本。必须失败。
  assert.throws(() => checkVersions({ version: '3.6.1', entry: '3.6.0' }), /VERSION.*不一致/);
  assert.throws(() => checkVersions({ tag: 'v3.6.0', version: '3.6.1', entry: '3.6.1' }), /不一致/);
  assert.throws(() => checkVersions({}), /缺少 version/);
});

test('packageVersion:当前 package.json 可解析,且形状是 x.y.z', () => {
  const version = packageVersion();
  assert.match(version, /^[0-9]+\.[0-9]+\.[0-9]+$/, `当前版本 ${version} 应是 x.y.z`);
  assert.equal(checkVersions({ version }).version, version);
});
