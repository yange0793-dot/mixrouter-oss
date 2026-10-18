'use strict';
// `mixctl backups` 的离线回归:每个用例起一个真的 mixctl 子进程,环境变量把三处备份池
// (DATA_DIR / ~/.claude/settings.json / ~/.codex/config.toml)全部重定向到临时目录。
// 子进程里 HOME 也一起换掉,所以**碰不到真实 HOME 的配置**;测试自身也不读它们。
//
// 这一组的取舍:
//   · 走真实子进程而不是 require mixctl —— mixctl 是**脚本**,顶层直接读 process.argv 并执行,
//     require 进来就会跑 dispatch。而这条命令要证明的恰恰是"用户敲下去会发生什么",
//     参数解析、退出码、stdout 形状都是它的一半。
//   · 断言里同时钉住"该有的在"和"不该有的不在":`--diff` 那条如果不查密钥,一个
//     "把配置正文原样打印"的实现能全绿通过 —— 而那是这条命令唯一真正危险的地方。
//   · 只读性靠**磁盘快照**证明(文件名集合 + mtime + 内容哈希),不靠读代码。
//     一个"顺手清理了过期备份"的实现看起来更贴心,但它让这条命令从只读变成了会改盘的东西。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const MIXCTL = path.join(__dirname, '..', 'mixctl');

// ---------------------------------------------------------------- 夹具
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-bakcli-'));

// 一次运行的全部环境:三处重定向 + HOME。返回的 home 是它换掉的那个 HOME,
// 用来断言"真实 HOME 一点没被碰"这件事在测试里也是真的(这条只是自证夹具本身)。
function fixture() {
  const root = tmpdir();
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const settings = path.join(home, '.claude', 'settings.json');
  const codex = path.join(home, '.codex', 'config.toml');
  for (const d of [path.dirname(settings), path.dirname(codex), data]) fs.mkdirSync(d, { recursive: true });
  return { root, home, data, settings, codex };
}

// 备份名按 mixrouter.js backupFile 的真实模板拼:`<file>.bak-mixui-YYYYMMDD-HHMMSS-mmm-rrrr`。
// 手工拼而不是调 backupFile —— 要造的形态里有"秒级历史格式""前缀命中但时间不存在"这些
// backupFile 根本产生不出来的东西,而那正是清点必须让人看见的部分。
const bakName = (base, stamp, ms = '000', rand = 'abcd') => `${base}.bak-mixui-${stamp}-${ms}-${rand}`;
const put = (file, text) => fs.writeFileSync(file, text);

// 一次运行的完整磁盘快照:名字 + mtime + 内容哈希。只读性用**前后两份快照相等**来证明,
// 不用"代码里没有 unlink"来证明 —— 后者是读码结论,前者是实测。
function snapshot(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    out[name] = {
      size: st.size, mtimeMs: st.mtimeMs, mode: st.mode & 0o777,
      sha256: st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') : null,
    };
  }
  return out;
}

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MIXCTL, ...args], {
      env: {
        ...env,
        HOME: env.home, USERPROFILE: env.home, XDG_CONFIG_HOME: path.join(env.home, '.config'),
        MIXR_DATA_DIR: env.data, MIXR_CLAUDE_SETTINGS: env.settings, MIXR_CODEX_CONFIG: env.codex,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

// 输出里不许出现的片段:整串 + 它的任意 MIN_FRAG 字符以上子串。
//
// 阈值为什么是 6,不是"看着更稳妥的 8":这个仓库里现成的漏法是 mixrouter.js 的 maskKey ——
// `k.slice(0, 6) + '…' + k.slice(-4)`。掐头去尾之后**最长的一段连续原文就是 6 个字符**,
// 8 的阈值正好从它上面跨过去(实测:对一把 37 字符的哨兵,阈值 8 判 0 命中,阈值 6 才判出命中)。
// 所以"≥8"这条线单独用不够:它挡得住单侧截断,挡不住掐头去尾。反向证据在注入回归里 ——
// 把 --diff 的输出换成 maskKey 式掩码,阈值 8 的版本全绿通过。
const MIN_FRAG = 6;
function assertNoLeak(text, needles, label) {
  for (const needle of needles) {
    assert.ok(!text.includes(needle), `${label}: 输出里出现了原值 ${needle}`);
    for (let n = MIN_FRAG; n <= needle.length; n++) {
      for (let i = 0; i + n <= needle.length; i++) {
        const frag = needle.slice(i, i + n);
        assert.ok(!text.includes(frag), `${label}: 输出里出现了原值的子串 ${JSON.stringify(frag)}(长度 >= ${MIN_FRAG} 的一律不许留)`);
      }
    }
  }
}

// 哨兵密钥。用随机字节而不是字面量:字面量一旦在源码里重复出现,断言就可能被
// "输出里本来就有这个词"之类的原因误伤成假绿。
// 哨兵本体必须是**纯高熵串**,不能带字典词前缀:阈值 6 的断言会把 `backup-…` 里的
// "backup" 当成泄漏片段报出来(那是夹具的错,不是实现的错)。前缀只用来区分不同用例,
// 拼在**外面**(见 liveSecret / backupSecret 的构造),不进哨兵本体。
const sentinel = tag => `${tag}${crypto.randomBytes(16).toString('hex')}`;
const fakeSk = tag => `sk-${tag}${crypto.randomBytes(20).toString('base64url')}`;

// ---------------------------------------------------------------- 清点
test('backups: 列出备份池的名字/大小/时间/sha256 短摘要,并报出下一次会删哪几个', async () => {
  const env = fixture();
  const sentinelKey = fakeSk('list');
  put(env.settings, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: sentinelKey } }));
  // 六份备份:保留上限 5。下一次备份落盘后池子是 7 份,超上限 2,删字典序最前两个。
  const stamps = ['20260101-000000', '20260201-000000', '20260301-000000', '20260401-000000', '20260501-000000', '20260601-000000'];
  for (const s of stamps) put(path.join(path.dirname(env.settings), bakName('settings.json', s)), `{"env":{"n":"${s}"}}`);

  // 只看 claude 那一节:三个池子都会打印,不加前缀时 DATA_DIR 那一节先出现。
  const r = await run(['backups', 'settings.json'], env);
  assert.equal(r.code, 0, r.stderr);
  const oldest = bakName('settings.json', stamps[0]);
  const newest = bakName('settings.json', stamps[5]);
  assert.match(r.stdout, /备份保留上限: 5 份/);
  for (const s of stamps) assert.ok(r.stdout.includes(bakName('settings.json', s)), `缺少 ${s} 的条目`);
  assert.match(r.stdout, /共 6 份/);
  // 摘要必须是**备份文件**的摘要,不是配置正文的。拿真实字节核对一次,而不是只看长度像。
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(env.settings), newest))).digest('hex');
  assert.ok(r.stdout.includes(digest.slice(0, 12)), 'sha256 短摘要必须是该备份文件的真实摘要前 12 位');
  // 删除集合:6 份 + 新来 1 份 = 7,超上限 2,删字典序前 2 个。
  const del = r.stdout.match(/下一次备份会删: (.+)/);
  assert.ok(del, '必须报出下一次备份会删哪些');
  assert.ok(del[1].includes(oldest), '最早的一份必须在删除集合里');
  assert.equal(del[1].split(',').length, 2, '6 份 + 新来 1 份,应删 2 个');
  // 配置正文里的哨兵一个片段都不许出现(清点只需要文件名,没有理由读正文)
  assertNoLeak(r.stdout, [sentinelKey], 'backups 清点');
});

test('backups: --json 可解析,形状与文本输出一致', async () => {
  const env = fixture();
  put(env.settings, '{"env":{}}');
  put(path.join(path.dirname(env.settings), bakName('settings.json', '20260601-120000', '123', 'beef')), '{"a":1}');

  const r = await run(['backups', '--json'], env);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.keep, 5);
  const claude = j.dirs.find(d => d.id === 'claude');
  assert.equal(claude.ok, true);
  assert.equal(claude.total, 1);
  assert.equal(claude.backups.length, 1);
  assert.equal(claude.backups[0].name, bakName('settings.json', '20260601-120000', '123', 'beef'));
  assert.equal(claude.backups[0].sha256_12.length, 12);
  assert.match(claude.backups[0].sha256_12, /^[0-9a-f]{12}$/);
  assert.equal(claude.backups[0].legacy, false);
  assert.deepEqual(claude.next_delete, []);
  assert.match(claude.retention_rule, /字典序/);
  // 三个池子都在结果里,没装 codex 的目录也只是 ok:false,不是缺项
  assert.equal(j.dirs.length, 3);
  assert.deepEqual(j.dirs.map(d => d.id).sort(), ['claude', 'codex', 'data']);
});

test('backups: 前缀只列那一处,未知选项与非唯一前缀都按用法报错且退出码 1', async () => {
  const env = fixture();
  put(env.settings, '{}');
  put(env.codex, 'model = "x"\n');

  const only = await run(['backups', 'settings.json'], env);
  assert.equal(only.code, 0, only.stderr);
  assert.ok(only.stdout.includes('settings.json'), '命中的池子要在输出里');
  assert.ok(!only.stdout.includes('[codex]'), '给了前缀就不该列别处');

  const bad = await run(['backups', '--nope'], env);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout + bad.stderr, /无法识别的 backups 选项/);

  const two = await run(['backups', 'settings.json', 'config.toml'], env);
  assert.equal(two.code, 1);
  assert.match(two.stdout + two.stderr, /只接受一个文件名前缀/);

  const none = await run(['backups', 'nope.json'], env);
  assert.equal(none.code, 1);
  assert.match(none.stdout + none.stderr, /没有配置匹配前缀/);

  const diffNoBase = await run(['backups', '--diff'], env);
  assert.equal(diffNoBase.code, 1);
  assert.match(diffNoBase.stdout + diffNoBase.stderr, /--diff 必须指定要预览的备份/);
});

test('backups: 空池报出零份,目录不存在报"无法清点"而不是崩掉', async () => {
  const env = fixture();
  // codex 的目录**不建**:~/.codex 在没装 codex 的机器上根本不存在,那是常态不是错误。
  fs.rmSync(path.dirname(env.codex), { recursive: true, force: true });
  const r = await run(['backups'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /共 0 份/);
  // 要说清是哪一处、错在哪,而不是静静地少一节
  assert.match(r.stdout, /\[codex\]/);
  assert.match(r.stdout, /无法清点 \[ENOENT\]/);
});

test('backups: 前缀命中但解析不出时间的名字单列出来,并说明它照样占保留池名额', async () => {
  const env = fixture();
  const dir = path.dirname(env.settings);
  put(env.settings, '{}');
  put(path.join(dir, 'settings.json.bak-mixui-backup'), 'hand-made');
  put(path.join(dir, 'settings.json.bak-mixui-20260230-000000-000-abcd'), '2026 没有 2 月 30 日');

  const r = await run(['backups'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /settings\.json\.bak-mixui-backup/);
  assert.match(r.stdout, /settings\.json\.bak-mixui-20260230-000000-000-abcd/);
  assert.match(r.stdout, /解析不出时间/);
  assert.match(r.stdout, /占保留池名额/);
  // 共 2 份:清点的 total 是"前缀命中数",不是"解析成功的数" —— 后者会让保留池的份数看着比实际小
  assert.match(r.stdout, /共 2 份/);
});

test('backups: 秒级历史格式被标出来(它与现行格式不保证唯一)', async () => {
  const env = fixture();
  const dir = path.dirname(env.settings);
  put(env.settings, '{}');
  put(path.join(dir, bakName('settings.json', '20260101-000000', '000', 'aaaa')), 'new');
  put(path.join(dir, 'settings.json.bak-mixui-20251231-235959'), 'legacy');

  const r = await run(['backups', '--json'], env);
  assert.equal(r.code, 0, r.stderr);
  const claude = JSON.parse(r.stdout).dirs.find(d => d.id === 'claude');
  assert.equal(claude.total, 2);
  assert.equal(claude.legacy, 1);
  assert.deepEqual(claude.backups.map(b => b.legacy).sort(), [false, true]);
});

// ---------------------------------------------------------------- 只读
test('backups: 只读 —— 跑完磁盘快照逐字节不变,一份都不删(即使池子超限)', async () => {
  const env = fixture();
  const dir = path.dirname(env.settings);
  put(env.settings, '{"env":{"ANTHROPIC_AUTH_TOKEN":"x"}}');
  // 造 8 份(超出保留上限 5):一个"顺手清理"的实现会在这里删掉 3 份。
  for (let i = 1; i <= 8; i++) {
    put(path.join(dir, bakName('settings.json', `20260${i}01-000000`)), `{"i":${i}}`);
  }
  const before = snapshot(dir);
  assert.equal(Object.keys(before).length, 9, '夹具应有 1 份现役 + 8 份备份');

  const r = await run(['backups'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /共 8 份/);
  assert.deepEqual(snapshot(dir), before, 'backups 不得写盘:名字、mtime、内容哈希都必须一模一样');

  const d = await run(['backups', '--diff', bakName('settings.json', '20260101-000000')], env);
  assert.equal(d.code, 0, d.stderr);
  assert.deepEqual(snapshot(dir), before, '--diff 同样不得写盘(预览不是还原)');
});

// ---------------------------------------------------------------- 差异预览
test('backups --diff: 走通 compareWithLive,报出 added/removed/changed 计数与逐条 key', async () => {
  const env = fixture();
  const dir = path.dirname(env.settings);
  const backup = bakName('settings.json', '20260601-120000');
  // 备份里:keep_me(不变)、gone(活文件里没有)、moved(值变了);活文件里:added_new
  put(env.settings, JSON.stringify({ keep_me: 'same', moved: 'new-value', added_new: 42 }));
  put(path.join(dir, backup), JSON.stringify({ keep_me: 'same', moved: 'old-value', gone: 'bye' }));

  const r = await run(['backups', '--diff', backup], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /差异预览/);
  assert.match(r.stdout, /新增 1 \/ 删除 1 \/ 变化 1/);
  assert.match(r.stdout, /\+ added_new = 42/);
  assert.match(r.stdout, /- gone = "bye"/);
  assert.match(r.stdout, /~ moved: "old-value" -> "new-value"/);
  // 方向约定必须与 compare.js 一致:added = 活文件有、备份没有
  assert.match(r.stdout, /added=备份之后新增/);
  // 现役文件是**推**出来的(用户只给了备份名),必须自报 —— 不能静静替用户猜。
  assert.match(r.stdout, /现役:\s+.*settings\.json\s+⚠ 由备份名推出,未经确认/);
  assert.match(r.stdout, /由备份名推出\(base=settings\.json\),未经用户确认/);
  // 已知值层缺席要在输出里说清,不假装已完整脱敏
  assert.match(r.stdout, /形状层已生效|未提供已知密钥清单/);
});

test('backups --diff --json: 报出 fileInferred 与脱敏的来源,JSON 与文本同源', async () => {
  const env = fixture();
  const dir = path.dirname(env.settings);
  const backup = bakName('settings.json', '20260601-120000');
  put(env.settings, JSON.stringify({ a: 1 }));
  put(path.join(dir, backup), JSON.stringify({ a: 2 }));

  const inferred = await run(['backups', '--diff', backup, '--json'], env);
  assert.equal(inferred.code, 0, inferred.stderr);
  const j = JSON.parse(inferred.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.diff.fileInferred, true, '只给备份名时现役文件是推出来的');
  assert.equal(j.diff.backup, backup);
  assert.equal(j.diff.file, env.settings);
  assert.equal(j.diff.targetId, 'claude');
  assert.match(j.diff.fileSource, /由备份名推出/);
  assert.equal(j.diff.redaction.secrets, 'unavailable', '已知值层缺席要说出来');
  assert.match(j.diff.redaction.note, /形状层/);

  // --file 显式指定之后不再是"推的"
  const explicit = await run(['backups', '--diff', backup, '--file', env.settings, '--json'], env);
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).diff.fileInferred, false, '--file 给了就不是推断');
});

test('backups --diff: 输出里不含哨兵密钥的任何 6 字符以上子串(含备份与现役两侧)', async () => {
  const env = fixture();
  const dir = path.dirname(env.settings);
  const backup = bakName('settings.json', '20260601-120000');
  // 同一把哨兵密钥同时出现在**两侧**,且两侧值不同 —— 只盖一侧的实现会在这里红。
  // 两把哨兵用**单字母** tag 区分,不拼 `live-`/`backup-` 这种字典词前缀:阈值 6 的片段断言
  // 会把 "backup" 本身当成泄漏片段报出来 —— 那是夹具的错,不是实现的错。
  const liveSecret = sentinel('L');
  const backupSecret = sentinel('B');
  const sk = fakeSk('both');
  put(env.settings, JSON.stringify({
    env: { ANTHROPIC_AUTH_TOKEN: liveSecret, OPENAI_API_KEY: sk, harmless: 'visible-value' },
  }));
  put(path.join(dir, backup), JSON.stringify({
    env: { ANTHROPIC_AUTH_TOKEN: backupSecret, OPENAI_API_KEY: sk, harmless: 'visible-value', note: 'plain' },
  }));

  const r = await run(['backups', '--diff', backup], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /差异预览/);
  // 无害的值照常显示:证明"没漏"不是靠把整个预览关掉换来的
  assert.ok(r.stdout.includes('visible-value'), '非敏感值应当照常显示,否则这条断言可能被"什么都没输出"骗过');
  assertNoLeak(r.stdout, [liveSecret, backupSecret, sk], 'backups --diff');
  // 除了"没漏",还要证明**没漏是靠盖住换来的**,不是靠"什么都没输出"。
  // 键名命中判据 A(ANTHROPIC_AUTH_TOKEN 里的 auth/token),整棵子树按敏感处理。
  assert.match(r.stdout, /形状层已生效\(\d+ 处\)/, '必须报出形状层盖了几处');
  assert.match(r.stdout, /"redacted":true/, '被盖的值要以脱敏形状出现');
  // 已知值层缺席必须写在输出里 —— 这条命令手上没有渠道密钥清单,只靠形状层,
  // 自定义格式的密钥可能盖不住。不说清楚就等于把"可能没盖全"报成了"已完整脱敏"。
  assert.match(r.stdout, /未提供已知密钥清单/, '必须写明已知值层缺席,否则等于谎报已完整脱敏');
});

test('backups --diff: 未指定备份名时按用法报错(不接受"猜一个来比")', async () => {
  const env = fixture();
  put(env.settings, '{}');
  const r = await run(['backups', '--json', '--diff'], env);
  assert.equal(r.code, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.error.code, 'invalid_arguments');
});

test('backups --diff: 备份名推不出 base 就报错,不许猜一个来比', async () => {
  const env = fixture();
  put(env.settings, '{}');
  // 名字里没有 .bak-mixui- 段 -> baseFromBackupName 返回 null
  const r = await run(['backups', '--diff', 'some-random-file.json', '--json'], env);
  assert.equal(r.code, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.error.code, 'undecidable_base');
  assert.match(j.error.message, /不接受猜一个来比/);
  // 文本模式下也要说清楚,而不是静默什么都不打印
  const text = await run(['backups', '--diff', 'some-random-file.json'], env);
  assert.equal(text.code, 1);
  assert.match(text.stdout + text.stderr, /推不出它备份的是哪个文件/);
});

test('backups --diff: 推出的 base 不是受管配置时报错,并指出用 --file 覆盖', async () => {
  const env = fixture();
  put(env.settings, '{}');
  const r = await run(['backups', '--diff', bakName('other.conf', '20260601-120000'), '--json'], env);
  assert.equal(r.code, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.error.code, 'undecidable_target');
  assert.match(j.error.message, /--file/);
});

test('backups --diff --file: 提供本命令认不出的现役文件时按 --file 走', async () => {
  const env = fixture();
  const dir = path.dirname(env.settings);
  const other = path.join(env.root, 'custom.conf');
  const backup = bakName('custom.conf', '20260601-120000');
  put(other, JSON.stringify({ k: 'new' }));
  put(path.join(dir, backup), JSON.stringify({ k: 'old' }));

  // 备份在 settings 目录、现役在别处:--file 指明现役,备份用带路径的完整路径
  const r = await run(['backups', '--diff', path.join(dir, backup), '--file', other, '--json'], env);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.diff.fileInferred, false);
  assert.equal(j.diff.file, other);
  assert.equal(j.diff.result.changed.length, 1);
});

test('backups --file: 不在 --diff 下用就报错(清点没有"指定现役文件"这回事)', async () => {
  const env = fixture();
  put(env.settings, '{}');
  const r = await run(['backups', '--file', env.settings], env);
  assert.equal(r.code, 1);
  assert.match(r.stdout + r.stderr, /--file 只在 --diff 下有意义/);
});

test('backups --help: 打印用法,不读盘也不报错', async () => {
  const env = fixture();
  const r = await run(['backups', '--help'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /mixctl backups \[--json\] \[<文件名前缀>\]/);
  assert.match(r.stdout, /mixctl backups --diff <备份名> \[--file <现役路径>\]/);
  assert.match(r.stdout, /只读/);
});

test('backups: DATA_DIR 与 mixrouter.js 同一条解析规则(MIXR_DATA_DIR 生效)', async () => {
  const env = fixture();
  // providers.json 的备份池在 DATA_DIR 里。若 mixctl 只认 ROOT,这里会报"共 0 份"。
  put(path.join(env.data, bakName('providers.json', '20260601-120000')), '{"version":2}');
  put(env.settings, '{}');

  const r = await run(['backups', '--json'], env);
  assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(r.stdout).dirs.find(d => d.id === 'data');
  assert.equal(data.ok, true);
  assert.equal(data.total, 1, 'MIXR_DATA_DIR 指到哪儿,就在哪儿清点 providers.json 的备份池');
  assert.equal(data.backups[0].name, bakName('providers.json', '20260601-120000'));
});

// 上面那条只证明"MIXR_DATA_DIR 生效"。它**证明不了默认路径对不对** —— 那条路径全程设着
// MIXR_DATA_DIR,而 MIXR_DATA_DIR 一旦设上,`env.MIXR_DATA_DIR || root` 就永远短路到 env,
// root 是对是错都照不出来。这条就是来补那个盲区的:不设 MIXR_DATA_DIR,只用 CLI 自己进程的
// root 推,并且断言**推出来的目录里确实躺着那份备份**。
//
// 它防的是一个真发生过的错:root 曾写成 `path.resolve(__dirname, '..')`,那是仓库的**父目录**,
// 不是仓库目录 —— 默认路径下会在父目录清点 providers.json 然后报"0 份",而真备份在仓库里。
// 所以断言不看"total >= 1"(父目录恰好也有备份时会假绿),而是**先放一份已知备份再去数它**。
test('backups: 默认路径(DATA_DIR 未重定向)指向仓库目录本身,不是它的父目录', async () => {
  const env = fixture();
  // 只重定向两个客户端配置,故意**不设** MIXR_DATA_DIR:走 `|| root` 那条分支。
  const runNoDataDir = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MIXCTL, ...args], {
      env: { ...env, HOME: env.home, USERPROFILE: env.home, XDG_CONFIG_HOME: path.join(env.home, '.config'),
        MIXR_CLAUDE_SETTINGS: env.settings, MIXR_CODEX_CONFIG: env.codex, MIXR_DATA_DIR: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { out += c; });
    child.on('error', reject); child.on('close', code => resolve({ code, out }));
  });
  const r = await runNoDataDir(['backups', '--json', 'providers.json']);
  assert.equal(r.code, 0, r.out);
  const data = JSON.parse(r.out).dirs.find(d => d.id === 'data');
  assert.equal(data.ok, true, 'DATA_DIR 默认值必须存在(仓库目录)');
  // 关键断言:dir 必须是**仓库目录本身**。父目录与仓库目录在路径上只差一段,
  // 用 basename 对照而不是写死绝对路径,这样换机器/换 clone 位置都成立。
  const repo = path.join(__dirname, '..');
  assert.equal(data.dir, repo, `DATA_DIR 默认值应是仓库目录 ${repo},实得 ${data.dir}`);
  assert.notEqual(data.dir, path.dirname(repo), '不得是仓库的父目录(root 少写一层就指到这里)');
  // 与**另一个消费方**对表,而不是与我自己写的字符串对表:这条备份池的活文件必须是
  // mixrouter.js 用的那一个 —— `DATA_DIR` + `providers.json`。root 少一层时,上面那条
  // 目录断言会红,但这一条能直接说清"错的是哪个文件"。两个消费方各推各的路径,
  // 这里就是把它们钉在一起的地方(目标表统一之后,两边本应推出同一个绝对路径)。
  assert.equal(path.join(data.dir, 'providers.json'), path.join(repo, 'providers.json'),
    'DATA_DIR 默认值与 mixrouter.js 的 PROVIDERS_FILE = path.join(DATA_DIR, \'providers.json\') 必须同源');
  // 目标表里不得出现"仓库父目录"这个错值 —— 它是这次修掉的那个 bug 的特征。
  assert.ok(!data.dir.endsWith(path.sep + path.basename(repo) + path.sep + '..'),
    'data.dir 里不该有 ".." 残留');
});

test('mixctl 的用法输出里包含 backups', async () => {
  const env = fixture();
  // 不带命令时 mixctl 走的是 status(要连本机控制台),用法在**未知命令**那条分支上。
  const r = await run(['--help'], env);
  assert.match(r.stdout, /backups/);
  assert.match(r.stdout, /mixctl backups \[--json\] \[<文件名前缀>\]/);
  assert.match(r.stdout, /mixctl backups --diff <备份名>/);
});

// ---------------------------------------------------------------- 默认值分支必须有断言
//
// 上面那些用例**全部设着 MIXR_DATA_DIR / MIXR_CLAUDE_SETTINGS / MIXR_CODEX_CONFIG**,
// 于是 `env.X || <默认>` 永远短路到 env 那一侧,默认值分支一次都走不到。
// 实测过一次代价:把 `lib/backup/targets.js` 里 claude 的默认值改成 WRONG-DEFAULT.json,
// 本文件全部用例**仍然全绿** —— 那个注入证明的不是"实现没问题",是"这里没有断言"。
//
// 所以这一条**故意不设三个环境变量**,拿默认值去对真值:
//   真值 = `lib/backup/targets.js` 的 LIVE_FILES —— 而它同时是 `mixrouter.js` 里
//   DATA_DIR / CLAUDE_SETTINGS / CODEX_CONFIG 三个常量的来源(主文件已改为从它取)。
// 于是"清点报出来的路径"与"主文件真正读写的那个路径"是**同一份计算**,不是两份碰巧相等。
test('backups: 不设环境变量时,清点用的默认路径与主文件读写的活文件是同一份计算', async () => {
  const { LIVE_FILES } = require('../lib/backup/targets');
  const root = path.join(__dirname, '..');           // = mixrouter.js 的 ROOT(__dirname)
  const home = os.homedir();                          // 不换 HOME:这一条就是要走默认分支
  const fakeEnv = {};                                 // 三个变量全缺席 ⇒ 只能走默认值

  // (a) 真值侧:**写死在用例里的字面量**,不从 LIVE_FILES 推导。
  //     ⚠ 第一版我写成 `want.claude = LIVE_FILES.claudeSettings(...)` —— 那是**恒绿**的:
  //     被测方与期望方读同一个来源,把 LIVE_FILES 改坏时两侧一起坏、照样相等。
  //     实测过:注入 WRONG-DEFAULT.json 后第一版 20/20 全绿。
  //     用例的期望值必须是**独立于实现**的一份,否则它测的是"实现等于它自己"。
  const want = {
    data: path.join(root, 'providers.json'),
    claude: path.join(home, '.claude', 'settings.json'),
    codex: path.join(home, '.codex', 'config.toml'),
  };
  // 顺带核 LIVE_FILES 确实还在(它是主文件的来源),但不拿它当期望值。
  assert.equal(typeof LIVE_FILES.claudeSettings, 'function', 'LIVE_FILES 应仍导出,主文件靠它');
  // 默认值必须是"家目录下",不能退化成仓库里 —— 那正是 mixctl 曾经犯过的错
  // (把 DATA_DIR 的默认根写成 path.resolve(__dirname,'..') = 仓库的父目录)。
  assert.ok(want.claude.startsWith(home + path.sep),
    `claude 默认值应落在家目录下,实得 ${want.claude}`);
  assert.ok(want.codex.startsWith(home + path.sep),
    `codex 默认值应落在家目录下,实得 ${want.codex}`);
  assert.ok(want.data.startsWith(root + path.sep) || want.data === root,
    `data 默认值应落在仓库目录(ROOT),实得 ${want.data}`);

  // (b) 消费侧:真跑一次 mixctl backups --json —— 用**裸环境**起,三个变量一个都不设。
  //     ⚠ 不能复用上面的 run():它**硬编码**了 MIXR_DATA_DIR/CLAUDE_SETTINGS/CODEX_CONFIG,
  //     用它就等于又走 env 分支,这条用例会变成恒绿。这是本用例唯一容易写错的地方。
  const r = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MIXCTL, 'backups', '--json'], {
      env: { ...process.env, HOME: home, USERPROFILE: home,
             MIXR_DATA_DIR: '', MIXR_CLAUDE_SETTINGS: '', MIXR_CODEX_CONFIG: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(r.code, 0, `退出码 ${r.code}\n${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  // 比**全长路径**,只比目录不够:第一版我只比了 path.dirname,于是把默认值改成
  // WRONG-DEFAULT.json 时目录没变、照样绿 —— 比目录的断言看不见文件名的分叉。
  // —— `dirs[].file` 是 JSON 里现成的全长路径,直接用它,不用从 dir 拼回来。
  const got = {};
  for (const d of parsed.dirs) got[d.id] = d.file;
  assert.equal(got.claude, want.claude,
    `claude 默认路径不一致:清点报 ${got.claude},真值 ${want.claude}`);
  assert.equal(got.codex, want.codex,
    `codex 默认路径不一致:清点报 ${got.codex},真值 ${want.codex}`);
  assert.equal(got.data, want.data,
    `data 默认路径不一致:清点报 ${got.data},真值 ${want.data}`);
});
