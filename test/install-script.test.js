'use strict';
// scripts/install-macos.sh 的离线回归。
//
// 全部在**临时 HOME + 临时安装根**里跑,真实 HOME 一个字节都不碰:脚本自身的所有路径
// 都由 $HOME 推导,所以只换 HOME 就足以隔离 —— 这一点由下面第一条用例自证
// (临时 HOME 下跑完之后,那棵树里除了脚本声明的四处,不该多出任何东西)。
//
// 这条脚本的验收标准不是"能装出东西",是**它承诺不做的事都没做**:
//   · 干跑零写盘(只读性靠临时 HOME 的前后快照相等证明,不靠读代码);
//   · 重复运行不覆盖已存在的配置(预置一份,跑完断言内容逐字节未变);
//   · 三种不合规环境(node 太老 / 目录不可写 / 端口被占)都以非 0 退出码明确失败,
//     而不是"跳过这一项继续装";
//   · stdin 不是终端时**不许挂住**等一个回答 —— 没有 --yes 就必须当场失败。
//
// 为什么全程用 --port/--ui-port 指向临时端口:本机 8787 上真的跑着现役 mixrouter,
// 用默认端口测等于断言"这台机器的线上实例已经停了"。测试不该依赖也不该惊动它。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'install-macos.sh');

// 每次跑脚本的超时。脚本自身的每一步都是本地同步检查,正常两秒内结束;
// 留 20 秒是为了让"挂住"这件事表现成**失败**而不是让整套测试等下去。
const SCRIPT_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------- 夹具
// 临时 HOME 之下就是一个完整的世界:安装根、LaunchAgent 目录、客户端配置全在里面。
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-install-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prefix = path.join(home, '.local', 'share', 'mixrouter');
  return { home, prefix };
}

// 拿 n 个互不相同的空闲端口:绑 0 让内核分配,读出来再关掉,循环到收够 n 个为止。
// **不能**拿一个口然后假设 port+1 也空着 —— `node --test` 是按文件并行起进程的,
// 另一个测试文件的 listener 完全可能正好占着相邻那个口,于是脚本报"端口被占用"、
// 用例变成偶发红(实测踩过一次:171/172,单独跑那个文件又是全绿)。
// 中间那点窗口关不掉(内核给的端口随时可能被别人抢),但至少不再是"系统性地赌相邻端口"。
async function freePorts(count) {
  const held = [];
  const ports = new Set();
  try {
    while (ports.size < count) {
      const server = net.createServer();
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      ports.add(server.address().port);
      held.push(server);
    }
  } finally {
    // 全部绑住之后再统一释放:这样"内核刚给我的这几个口"在绑定期间不会互相撞。
    for (const server of held) await new Promise(resolve => server.close(resolve));
  }
  return [...ports];
}

async function freePort() {
  const [port] = await freePorts(1);
  return port;
}

// 常用形态:一次要两个口(代理 + 控制台)。
async function twoPorts() {
  const [proxy, ui] = await freePorts(2);
  return { proxy: String(proxy), ui: String(ui) };
}

// 跑脚本。env 的基准是**干净的一小撮**,不是 process.env —— 带着 run-tests.js 设的
// MIXR_DATA_DIR 之类进来,"脚本有没有被继承环境带跑"就测不出来了。
function runScript(args, options = {}) {
  const { home, env = {}, input, timeout = SCRIPT_TIMEOUT_MS } = options;
  const base = {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home, USERPROFILE: home,
    TMPDIR: process.env.TMPDIR || '/tmp',
    LANG: 'en_US.UTF-8',
    ...env,
  };
  return spawnSync('/bin/bash', [SCRIPT, ...args], {
    env: base,
    encoding: 'utf8',
    timeout,
    input: input === undefined ? undefined : input,
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
}

// 整棵树的快照(名字 + 类型 + 大小 + 内容哈希 + 符号链接目标)。
// 干跑的"零写盘"靠前后两份快照相等来证明。
function snapshot(root) {
  const out = {};
  const walk = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`;
      else if (st.isDirectory()) { out[rel] = `dir:${st.mode & 0o777}`; walk(full, rel); }
      else out[rel] = `file:${st.size}:${st.mode & 0o777}:${require('node:crypto').createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
    }
  };
  walk(root, '');
  return out;
}

// ---------------------------------------------------------------- 1. 干跑

test('--dry-run:退出码 0,先显示目标目录与备份位置,且不写任何文件', async t => {
  const { home, prefix } = fixture(t);
  const { proxy, ui } = await twoPorts();
  const before = snapshot(home);
  const r = runScript(['--dry-run', '--port', proxy, '--ui-port', ui], { home });

  assert.ifError(r.error);           // 超时会让 r.error 有值(ETIMEDOUT),这条同时守住"挂住"
  assert.equal(r.status, 0, `干跑应成功,实得 ${r.status}\n${r.stderr}`);
  const out = r.stdout + r.stderr;

  // "先显示再执行"的两个必答项:目标目录、备份位置。
  assert.ok(out.includes(`发布目录`), '输出里没有目标目录');
  assert.ok(out.includes(path.join(prefix, 'releases')), `输出里没有发布根 ${prefix}/releases`);
  assert.ok(out.includes(`备份位置`), '输出里没有备份位置');
  assert.ok(out.includes(path.join(prefix, 'backups')), '输出里没有备份目录');
  assert.ok(out.includes('运行数据目录'), '输出里没有运行数据目录');
  assert.ok(out.includes('干跑'), '输出里没有说明这是干跑');

  // 零写盘:整棵树连同权限逐项相等。
  assert.deepEqual(snapshot(home), before, '干跑不得创建、改写或删除任何文件');
  assert.ok(!fs.existsSync(prefix), '干跑不得把安装根建出来');
});

test('默认行为就是干跑:不带 --apply 时不写盘', async t => {
  const { home } = fixture(t);
  const { proxy, ui } = await twoPorts();
  const before = snapshot(home);
  const r = runScript(['--port', proxy, '--ui-port', ui], { home });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual(snapshot(home), before, '不带 --apply 时不得写盘');
});

// ---------------------------------------------------------------- 2. 报告内容

test('计划里列出的客户端配置与 LaunchAgent 路径都在 $HOME 下,不写死个人绝对路径', async t => {
  const { home } = fixture(t);
  const { proxy, ui } = await twoPorts();
  const r = runScript(['--port', proxy, '--ui-port', ui], { home });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const out = r.stdout + r.stderr;

  assert.ok(out.includes(path.join(home, '.claude', 'settings.json')), '没列出 Claude 配置路径');
  assert.ok(out.includes(path.join(home, '.codex', 'config.toml')), '没列出 Codex 配置路径');
  assert.ok(out.includes(path.join(home, '.zcode', 'v2', 'config.json')), '没列出 ZCode 配置路径');
  assert.ok(out.includes(path.join(home, 'Library', 'LaunchAgents')), '没列出 LaunchAgent 目录');
  assert.ok(out.includes('不写入'), '没有声明"这些地方不写入"');
  // 输出里允许出现的绝对路径只有两类:**调用方给的那个 HOME**,以及**调用方给的那个源码目录**
  // (测试里就是本仓库 = 开发副本)。除此之外任何 /Users/<名字>/... 都说明脚本自己拼了一条
  // 本机路径进来 —— 那正是任务 3 要去掉的依赖。
  const leaked = out.split('\n')
    .flatMap(line => line.match(/\/Users\/[A-Za-z0-9._-]+\/[^\s,;:)]*/g) || [])
    .filter(p => !p.startsWith(home) && !p.startsWith(ROOT));
  assert.deepEqual(leaked, [], `输出里出现了 $HOME 与源码目录之外的个人绝对路径:${leaked.join(', ')}`);
});

// ---------------------------------------------------------------- 3. 幂等:不覆盖

test('重复运行不覆盖:预置的配置文件逐字节未变,发布目录一致时跳过复制', async t => {
  const { home, prefix } = fixture(t);
  const { proxy, ui } = await twoPorts();
  const dataDir = path.join(prefix, 'data');
  const existing = {
    'providers.json': '{"version":2,"current":{"claude":"keepme"},"claude":[],"codex":[]}\n',
    'routes.json': '{"keep":"me"}\n',
    'slots.json': '{"slots":{"claude":{"opus":"keepme"}}}\n',
    'sessions.json': '{"sessions":{"keepme":{}}}\n',
  };
  fs.mkdirSync(dataDir, { recursive: true });
  for (const [name, text] of Object.entries(existing)) fs.writeFileSync(path.join(dataDir, name), text);

  const args = ['--apply', '--yes', '--port', proxy, '--ui-port', ui];
  const first = runScript(args, { home });
  assert.equal(first.status, 0, `首次安装应成功\n${first.stdout}\n${first.stderr}`);

  // 预置内容一字未改:这是"重复运行不覆盖用户配置"的可验证形式。
  for (const [name, text] of Object.entries(existing)) {
    assert.equal(fs.readFileSync(path.join(dataDir, name), 'utf8'), text, `${name} 被改动了`);
  }

  const releaseDir = fs.readlinkSync(path.join(prefix, 'releases', 'current'));
  const marker = path.join(releaseDir, 'public', 'index.html');
  assert.ok(fs.existsSync(marker), '发布目录里应含 public/index.html');
  const markerBefore = fs.statSync(marker).mtimeMs;
  const releaseBefore = snapshot(releaseDir);

  // 第二次:内容一致 ⇒ 必须跳过而不是重写。mtime 是这里唯一能区分
  // "原样跳过"与"重新复制了一遍恰好一样的内容"的证据。
  await new Promise(resolve => setTimeout(resolve, 30));
  const second = runScript(args, { home });
  assert.equal(second.status, 0, `重复运行应成功(跳过复制)\n${second.stdout}\n${second.stderr}`);
  assert.ok((second.stdout + second.stderr).includes('跳过复制'), '重复运行没有报告跳过复制');
  assert.equal(fs.statSync(marker).mtimeMs, markerBefore, '重复运行重写了一致的发布目录');
  assert.deepEqual(snapshot(releaseDir), releaseBefore, '重复运行改动了发布目录');

  for (const [name, text] of Object.entries(existing)) {
    assert.equal(fs.readFileSync(path.join(dataDir, name), 'utf8'), text, `${name} 在第二次运行时被改动`);
  }
});

test('发布目录已存在但与源码不同:拒绝覆盖并以非 0 退出', async t => {
  const { home, prefix } = fixture(t);
  const { proxy, ui } = await twoPorts();
  const args = ['--apply', '--yes', '--port', proxy, '--ui-port', ui, '--release', 'fixed-name'];
  const first = runScript(args, { home });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

  const releaseDir = path.join(prefix, 'releases', 'fixed-name');
  fs.writeFileSync(path.join(releaseDir, 'mixrouter.js'), '// 被人改过的发布物\n');

  const second = runScript(args, { home });
  assert.notEqual(second.status, 0, '内容不同的同名发布目录必须拒绝安装');
  assert.match(second.stderr + second.stdout, /拒绝覆盖/);
  // 拒绝之后不许留下暂存目录。
  const leftovers = fs.readdirSync(path.join(prefix, 'releases')).filter(n => n.startsWith('.staging'));
  assert.deepEqual(leftovers, [], `拒绝时留下了暂存目录:${leftovers.join(', ')}`);
  assert.equal(fs.readFileSync(path.join(releaseDir, 'mixrouter.js'), 'utf8'), '// 被人改过的发布物\n',
    '拒绝覆盖时改动了已存在的发布目录');
});

test('--apply 不写 LaunchAgent,也不碰客户端配置', async t => {
  const { home, prefix } = fixture(t);
  const { proxy, ui } = await twoPorts();
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.mkdirSync(launchAgents, { recursive: true });
  fs.writeFileSync(settings, '{"env":{"ANTHROPIC_BASE_URL":"https://example.invalid"}}\n');
  const plist = path.join(launchAgents, `com.${os.userInfo().username}.mixrouter.plist`);
  fs.writeFileSync(plist, '<plist>现役配置,不许动</plist>\n');

  const r = runScript(['--apply', '--yes', '--port', proxy, '--ui-port', ui], { home });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

  assert.equal(fs.readFileSync(settings, 'utf8'), '{"env":{"ANTHROPIC_BASE_URL":"https://example.invalid"}}\n',
    '安装改动了客户端配置');
  assert.equal(fs.readFileSync(plist, 'utf8'), '<plist>现役配置,不许动</plist>\n', '安装改动了 LaunchAgent');
  assert.deepEqual(fs.readdirSync(launchAgents).sort(), [path.basename(plist)], 'LaunchAgent 目录里多出了文件');
  // 建议的服务配置只落在**发布目录**的 launchd/ 下。
  const releaseDir = fs.readlinkSync(path.join(prefix, 'releases', 'current'));
  assert.ok(fs.existsSync(path.join(releaseDir, 'launchd', path.basename(plist))),
    '建议的 plist 应落在发布目录的 launchd/ 下');
});

test('--apply 的发布物不含数据文件与日志,且带 RELEASE.json 清单', async t => {
  const { home, prefix } = fixture(t);
  const { proxy, ui } = await twoPorts();
  const r = runScript(['--apply', '--yes', '--port', proxy, '--ui-port', ui], { home });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const releaseDir = fs.readlinkSync(path.join(prefix, 'releases', 'current'));

  for (const banned of ['providers.json', 'routes.json', 'slots.json', 'sessions.json', 'logs', '.run', '.git']) {
    assert.ok(!fs.existsSync(path.join(releaseDir, banned)), `发布物里不该有 ${banned}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, 'RELEASE.json'), 'utf8'));
  assert.equal(typeof manifest.version, 'string');
  assert.match(manifest.code_revision, /^[0-9a-f]{64}$/, 'RELEASE.json 应记下源码修订(与 mixctl status 同一份哈希)');
  assert.equal(manifest.data_dir, path.join(prefix, 'data'), '清单里的数据目录应指向固定数据目录');
});

test('--apply 把数据目录建在安装根下,不在发布目录里', async t => {
  const { home, prefix } = fixture(t);
  const { proxy, ui } = await twoPorts();
  const r = runScript(['--apply', '--yes', '--port', proxy, '--ui-port', ui], { home });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const releaseDir = fs.readlinkSync(path.join(prefix, 'releases', 'current'));
  assert.ok(fs.statSync(path.join(prefix, 'data')).isDirectory(), '数据目录应存在于安装根下');
  assert.ok(!releaseDir.startsWith(path.join(prefix, 'data')), '发布目录不该落在数据目录里');
  assert.ok(!fs.existsSync(path.join(releaseDir, 'logs')), '发布目录里不该出现 logs/');
});

// ---------------------------------------------------------------- 4. 非交互不挂住

test('stdin 不是终端且没有 --yes:当场失败,不挂住等输入', async t => {
  const { home } = fixture(t);
  const { proxy, ui } = await twoPorts();
  const r = runScript(['--apply', '--port', proxy, '--ui-port', ui], { home });
  assert.ifError(r.error);                       // ETIMEDOUT 会落在这里
  assert.notEqual(r.status, 0, '非交互 --apply 缺少 --yes 时必须失败');
  assert.match(r.stderr + r.stdout, /--yes/, '错误信息里要说明需要 --yes');
});

test('--yes 是非交互 --apply 的唯一放行方式;干跑不需要它', async t => {
  const { home, prefix } = fixture(t);
  const { proxy, ui } = await twoPorts();
  const dry = runScript(['--apply', '--dry-run', '--port', proxy, '--ui-port', ui], { home });
  assert.equal(dry.status, 0, '同时给 --apply --dry-run 时以干跑为准,且无需 --yes');
  assert.ok(!fs.existsSync(prefix), '带 --dry-run 时不得写盘');
});

// ---------------------------------------------------------------- 5. 三种明确失败

test('node 版本不合要求:非 0 退出并说明原因', async t => {
  const { home, prefix } = fixture(t);
  const { proxy, ui } = await twoPorts();
  // 在 PATH 最前面塞一个假 node:只认 --version,回一个低版本号。
  // 这样脚本的版本判定被真实走了一遍,而不是被跳过。
  const fakeBin = path.join(home, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeNode = path.join(fakeBin, 'node');
  fs.writeFileSync(fakeNode, '#!/bin/sh\necho v11.15.0\n', { mode: 0o755 });

  const r = runScript(['--dry-run', '--port', proxy, '--ui-port', ui], {
    home, env: { PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.notEqual(r.status, 0, `node 版本太老必须失败,实得 ${r.status}\n${r.stdout}`);
  assert.match(r.stderr + r.stdout, /node 版本/, '错误信息要指出是 node 版本问题');
  assert.match(r.stderr + r.stdout, />= 18/, '错误信息要给出要求的版本');
  assert.ok(!fs.existsSync(prefix), '检查失败时不得写盘');
});

test('node 缺失:非 0 退出', async t => {
  const { home } = fixture(t);
  const { proxy, ui } = await twoPorts();
  // 真机上"没装 node"的样子:系统目录还在(脚本要用 dirname/cat/lsof),
  // 但 PATH 里没有任何 node。这里**逐个目录筛**而不是按名字挑:node 可能挂在
  // 任意一层(本机就同时有 /usr/local/bin/node 和 nvm 里那一份),只去掉 execPath
  // 所在的那一层是不够的。若本机确实没有第二份 node(下面自证会看到 none),
  // 这条用例就没有它要模拟的场景,跳过而不是假装通过。
  const cleanPath = (process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin')
    .split(':')
    .filter(dir => dir && !fs.existsSync(path.join(dir, 'node')))
    .join(':');
  const anyNode = spawnSync('/bin/sh', ['-c', 'command -v node || true'], {
    env: { ...process.env, PATH: cleanPath }, encoding: 'utf8',
  }).stdout.trim();
  assert.equal(anyNode, '', `夹具没做到"PATH 里没有 node"(仍找到 ${anyNode}),这条用例的结论不成立`);

  const r = runScript(['--dry-run', '--port', proxy, '--ui-port', ui], {
    home, env: { PATH: cleanPath },
  });
  assert.notEqual(r.status, 0, `PATH 里没有 node 时必须失败,实得 ${r.status}\n${r.stdout}`);
  assert.match(r.stderr + r.stdout, /找不到 node/);
  // 自证这条用的是"没有 node"而不是"PATH 坏掉":同一个 PATH 下别的系统命令要在。
  const sanity = spawnSync('/bin/sh', ['-c', 'command -v dirname'], { env: { ...process.env, PATH: cleanPath }, encoding: 'utf8' });
  assert.equal(sanity.status, 0, '这条用例的 PATH 应当仍然有系统命令 —— 否则测的是另一个失败');
});

test('目标目录不可写:非 0 退出(非 root 才断言 —— root 会绕过权限检查)', async t => {
  const { home } = fixture(t);
  const { proxy, ui } = await twoPorts();
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root 会绕过目录权限,这条在本机没有意义');
    return;
  }
  // 只读的安装根:脚本要在建任何东西之前就发现写不进去。
  const readonlyPrefix = path.join(home, 'readonly');
  fs.mkdirSync(readonlyPrefix, { recursive: true, mode: 0o500 });
  fs.chmodSync(readonlyPrefix, 0o500);
  t.after(() => { try { fs.chmodSync(readonlyPrefix, 0o700); } catch {} });

  const r = runScript(['--apply', '--yes', '--prefix', readonlyPrefix,
    '--port', proxy, '--ui-port', ui], { home });
  assert.notEqual(r.status, 0, `不可写的 --prefix 必须失败,实得 ${r.status}\n${r.stdout}`);
  assert.match(r.stderr + r.stdout, /不可写/, '错误信息要指出目录不可写');
  assert.deepEqual(fs.readdirSync(readonlyPrefix), [], '失败时不该在只读目录里留下东西');
});

test('端口被占:非 0 退出,且测完释放端口', async t => {
  const { home, prefix } = fixture(t);
  const held = net.createServer();
  await new Promise(resolve => held.listen(0, '127.0.0.1', resolve));
  const busyPort = held.address().port;
  // 用 held 的 close 回调收尾:端口在本用例结束前一定释放,后面的用例还能用。
  t.after(() => new Promise(resolve => held.close(resolve)));

  const r = runScript(['--dry-run', '--port', String(busyPort), '--ui-port', String(busyPort + 1)], { home });
  assert.notEqual(r.status, 0, `端口被占必须失败,实得 ${r.status}\n${r.stdout}`);
  assert.match(r.stderr + r.stdout, /已被占用/, '错误信息要指出端口被占用');
  assert.ok(!fs.existsSync(prefix), '端口检查失败时不得写盘');
});

test('控制台端口被占同样失败(两个端口都要查)', async t => {
  const { home } = fixture(t);
  const held = net.createServer();
  await new Promise(resolve => held.listen(0, '127.0.0.1', resolve));
  const busyPort = held.address().port;
  t.after(() => new Promise(resolve => held.close(resolve)));

  const freeOne = await freePort();
  const r = runScript(['--dry-run', '--port', String(freeOne), '--ui-port', String(busyPort)], { home });
  assert.notEqual(r.status, 0, `控制台端口被占必须失败,实得 ${r.status}\n${r.stdout}`);
  assert.match(r.stderr + r.stdout, /控制台端口/);
});

test('--help 与非法参数:帮助可读,非法参数以非 0 退出', async t => {
  const { home } = fixture(t);
  const help = runScript(['--help'], { home });
  assert.equal(help.status, 0);
  const helpText = help.stdout + help.stderr;
  for (const needle of ['--dry-run', '--apply', '--yes', '--prefix', '--release', '--port']) {
    assert.ok(helpText.includes(needle), `帮助里缺少 ${needle}`);
  }
  // 头注释里的两条承诺必须在帮助里能被读到。
  assert.ok(helpText.includes('在线运行授权'), '帮助里要有"不等于已获得在线运行授权"');
  assert.ok(helpText.includes('不装载、不卸载、不重启'), '帮助里要说明不碰服务');

  const bad = runScript(['--nonsense'], { home });
  assert.notEqual(bad.status, 0, '无法识别的参数必须失败,不能忽略');
  assert.match(bad.stderr + bad.stdout, /无法识别的参数/);
});

// ---------------------------------------------------------------- 6. 脚本自身纪律

test('脚本不调用 launchctl,不调用 EnterWorktree 之外的东西(静态自检)', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // 只扫**可执行行**(去掉注释),否则头注释里那句"不执行 launchctl bootstrap"会自己命中。
  const code = src.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  for (const banned of ['launchctl', 'bootstrap', 'bootout', 'kickstart']) {
    assert.ok(!code.includes(banned), `脚本里不该出现 ${banned}`);
  }
  assert.ok(src.includes('set -euo pipefail'), '脚本要用 set -euo pipefail');
  assert.ok(src.includes('在线运行授权'), '头注释要写明"不等于已获得在线运行授权"');
  assert.ok(/^#!\/bin\/bash/.test(src), 'shebang 必须是 /bin/bash');
  // 不许写死家目录:所有路径都要经 $HOME 或 lib/paths.js 推导。
  assert.doesNotMatch(code, /\/Users\/[A-Za-z0-9._-]+/, '脚本里出现了写死的个人绝对路径');
});
