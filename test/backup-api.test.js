'use strict';
// `GET /api/backups` 的离线回归:走**真实 apiHandler**,只监听临时回环端口。
// 环境变量(经 scripts/run-tests 的 testEnv)把 DATA_DIR 与两个客户端配置全部重定向到临时目录,
// 端口是 0(=内核分配),所以 8787/8788 上跑着的常驻服务一点不受影响,本用例也不读真实 HOME 配置。
//
// 这一组的取舍:
//   · 断言必须能抓住**最坏的一种错:端点把配置正文返回出去**。所以有一条专门的用例在
//     现役文件与它的备份里各放一把哨兵密钥,断言响应里既不出现哨兵本体、也不出现它
//     长度 ≥6 的**任意子串** —— 只查整串挡不住"掐头去尾"的假掩码,而那正是 mixrouter.js
//     maskKey 的写法,是这个仓库里现成的漏法(阈值为何是 6 见下面的 assertNoLeak)。
//   · 只读性同样用磁盘快照证明(名字 + mtime + 内容哈希),不读代码。
//   · 形状按"控制台要用的东西"钉:名字/大小/时间/短摘要 + 下一次删哪几个 + 保留上限。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { testEnv } = require('../scripts/run-tests');

// 环境必须在 require mixrouter.js **之前**定好:模块顶层就把 DATA_DIR / CLAUDE_SETTINGS /
// CODEX_CONFIG 三个常量读死了,之后再改 process.env 对它们无效。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-bak-api-'));
const env = testEnv(process.env, TMP);
for (const key of Object.keys(process.env)) if (/^(MIXR_|MIXROUTER_|MIXUI_)/.test(key)) delete process.env[key];
Object.assign(process.env, env);
for (const dir of ['home', 'data', 'tmp']) fs.mkdirSync(path.join(TMP, dir), { recursive: true });

const mod = require('../mixrouter');
let server;

const SETTINGS = path.join(TMP, 'home', '.claude', 'settings.json');
const CODEX = path.join(TMP, 'home', '.codex', 'config.toml');
const DATA = path.join(TMP, 'data');

const bakName = (base, stamp, ms = '000', rand = 'abcd') => `${base}.bak-mixui-${stamp}-${ms}-${rand}`;
const put = (file, text) => fs.writeFileSync(file, text);

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: pathname, method: 'GET' }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('response aborted')));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, type: res.headers['content-type'], text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('test request timeout')));
    req.end();
  });
}

function snapshot(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    out[name] = { size: st.size, mtimeMs: st.mtimeMs, mode: st.mode & 0o777,
      sha256: st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') : null };
  }
  return out;
}

// 输出里不许出现的片段:整串 + 它的任意 MIN_FRAG 字符以上子串。
//
// 阈值为什么是 6,而不是"看着更稳妥的 8":这个仓库里现成的漏法是 mixrouter.js 的
// maskKey —— `k.slice(0, 6) + '…' + k.slice(-4)`。掐头去尾之后**最长的一段连续原文
// 就是 6 个字符**,8 的阈值正好从它上面跨过去(实测:对一把 37 字符的哨兵,阈值 8 判 0 命中,
// 阈值 6 才判出命中)。所以"≥8"这条线单独用是不够的 —— 它挡得住单侧截断,挡不住掐头去尾。
// 反向证据在注入回归里:把端点改成返回 `maskKey` 式掩码,阈值 8 的版本全绿通过。
//
// 阈值也不能再往下压:6 已经是我们会留下来的**最短**有意义的连续片段(再短就是巧合了),
// 而这里所有哨兵都是几十字符的随机串,不存在"短片段本来就该出现"的误伤面。
const MIN_FRAG = 6;
function assertNoLeak(text, needles, label) {
  for (const needle of needles) {
    assert.ok(!text.includes(needle), `${label}: 响应里出现了原值 ${needle}`);
    for (let n = MIN_FRAG; n <= needle.length; n++) {
      for (let i = 0; i + n <= needle.length; i++) {
        const frag = needle.slice(i, i + n);
        assert.ok(!text.includes(frag), `${label}: 响应里出现了原值的子串 ${JSON.stringify(frag)}(长度 >= ${MIN_FRAG} 的一律不许留)`);
      }
    }
  }
}

// 哨兵本体必须是**纯高熵串**,不能带字典词前缀:阈值 6 的断言会把 `backup-…` 里的
// "backup" 当成泄漏片段报出来(那是夹具的错,不是实现的错)。前缀只用来区分不同用例,
// 拼在**外面**(见 liveSecret / backupSecret 的构造),不进哨兵本体。
const sentinel = tag => `${tag}${crypto.randomBytes(16).toString('hex')}`;
const fakeSk = tag => `sk-${tag}${crypto.randomBytes(20).toString('base64url')}`;

// 每个用例自己去清缓存目录里的夹具,免得上一条留下的备份跑进下一条的清点里。
function clearPool(dir, base) {
  for (const n of fs.readdirSync(dir)) if (n.startsWith(`${base}.bak-mixui-`)) fs.unlinkSync(path.join(dir, n));
}

before(async () => {
  server = await mod.listen(0, mod.apiHandler);
  assert.ok(![8787, 8788].includes(server.address().port), '测试不得占用常驻端口');
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('GET /api/backups: 200 + JSON,清点三处备份池并给出下一次会删哪几个与保留上限', async () => {
  const dir = path.dirname(SETTINGS);
  fs.mkdirSync(dir, { recursive: true });
  put(SETTINGS, JSON.stringify({ env: {} }));
  clearPool(dir, 'settings.json');
  // 六份:保留上限 5,下一次备份落盘后池子 7 份,超上限 2 —— 删字典序最前两个。
  const stamps = ['20260101-000000', '20260201-000000', '20260301-000000', '20260401-000000', '20260501-000000', '20260601-000000'];
  for (const s of stamps) put(path.join(dir, bakName('settings.json', s)), `{"n":"${s}"}`);
  const newest = bakName('settings.json', stamps[5]);

  const r = await get('/api/backups');
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/json/);
  assert.equal(r.json.keep, 5);
  assert.deepEqual(r.json.dirs.map(d => d.id).sort(), ['claude', 'codex', 'data']);
  // label 两个出口都要有(目标表统一之后不再"CLI 有、端点没有")
  for (const d of r.json.dirs) assert.ok(typeof d.label === 'string' && d.label, `目标 ${d.id} 缺 label`);

  const claude = r.json.dirs.find(d => d.id === 'claude');
  assert.equal(claude.ok, true);
  // 端点现在从 lib/backup/targets.js 取目标表,而 mixrouter.js 另有 CLAUDE_SETTINGS /
  // CODEX_CONFIG 两个常量。两套推导必须落到同一个目录,否则端点会去清点一个没有备份的
  // 目录然后报"0 份"。
  //
  // ⚠ 这条**只证到哪一步,写清楚**:测试环境设了 MIXR_CLAUDE_SETTINGS,所以它证的是
  // "targets.js 认这个环境变量,并且认出来的目录和主文件用的是同一个" —— 也就是**环境变量
  // 那条分支**两边一致。它**证不了** env 未设时的**默认值**分支(`~/.claude/settings.json`
  // vs `~/.codex/config.toml` 这两个硬编码字符串)两边一致:那两个常量没从 mixrouter.js
  // 导出,测试拿不到它们作对照,而测试全程设着环境变量、默认值分支根本走不到。
  // 实测过:把 targets.js 里 claude 的默认值改成 WRONG-DEFAULT.json,这条用例**仍然全绿**。
  // 默认值分支不一致是**未覆盖**的残余风险,不是已证事实 —— 别把这两句读成同一件事。
  assert.equal(claude.dir, path.dirname(SETTINGS), 'claude 备份池目录必须与 mixrouter.js 的 CLAUDE_SETTINGS 同源(环境变量分支)');
  assert.equal(r.json.dirs.find(d => d.id === 'codex').dir, path.dirname(CODEX));
  assert.equal(claude.total, 6);
  assert.equal(claude.backups.length, 6);
  assert.equal(claude.next_delete.length, 2, '6 份 + 新来 1 份 = 7,超上限 2');
  assert.ok(claude.next_delete.includes(bakName('settings.json', stamps[0])), '最早一份在删除集合里');

  // 摘要必须是**备份文件**的摘要。拿真实字节核一次,而不是只看长度像。
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, newest))).digest('hex');
  const entry = claude.backups.find(b => b.name === newest);
  assert.equal(entry.sha256_12, digest.slice(0, 12));
  assert.equal(entry.sha256_12.length, 12);
  assert.equal(entry.size, fs.statSync(path.join(dir, newest)).size);
  assert.equal(entry.legacy, false);
  // 时间字段**统一叫 iso**(entries 里现成那个)。三个出口一个 iso、一个 ts、一个 mtime
  // 是同一份数据的三种写法,这里钉死只留 iso。
  assert.match(entry.iso, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!('mtime' in entry) && !('ts' in entry), '时间只许有一种写法(iso)');
  // 只给文件名/大小/时间/摘要/权限,不给任何正文。字段集**钉死**:以后往条目里加字段
  // (尤其是任何"顺手带上原文"的字段)必须在这里一并说明,否则这条用例会红。
  assert.deepEqual(Object.keys(entry).sort(), ['iso', 'legacy', 'mode', 'name', 'sha256_12', 'size'],
    '条目字段是固定的这几个,加字段要在这里一并说明');
  assert.match(entry.mode, /^[0-7]{3,4}$/);
});

test('GET /api/backups: 响应里不含配置正文的哨兵密钥(现役与备份两侧都不许出现)', async () => {
  const dir = path.dirname(SETTINGS);
  fs.mkdirSync(dir, { recursive: true });
  // 两把哨兵用**单字母** tag 区分,不拼 `live-`/`backup-` 这种字典词前缀:
  // 阈值 6 的片段断言会把 "backup" 本身当成泄漏片段报出来 —— 那是夹具的错,不是实现的错。
  const liveSecret = sentinel('L');
  const backupSecret = sentinel('B');
  const sk = fakeSk('api');
  put(SETTINGS, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: liveSecret, OPENAI_API_KEY: sk } }));
  clearPool(dir, 'settings.json');
  put(path.join(dir, bakName('settings.json', '20260601-000000')), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: backupSecret, OPENAI_API_KEY: sk } }));

  const r = await get('/api/backups');
  assert.equal(r.status, 200);
  // 先证明这个端点确实在工作(报出了那一份备份),否则"没漏"可能只是"什么都没返回"
  const claude = r.json.dirs.find(d => d.id === 'claude');
  assert.equal(claude.total, 1, '端点必须真的清点到了那份备份,否则这条断言会被空响应骗过');
  // ⚠ 扫描前先摘掉 `dir` 字段:`/api/backups` 会在 `dir` 里回本机备份目录的**绝对路径**,
  // 而本用例的临时目录名是 `mixr-bak-api-XXXX` —— 它含 `k-api-`。
  // `assertNoLeak` 会枚举哨兵的**所有** ≥6 字符子串,而 `sk-api` + base64url 随机段
  // 在随机段以 `-` 开头时正好含 `k-api-`(base64url 字母表里有 `-`,实测约 1.49%),
  // 于是响应里的**目录名**被报成"密钥泄漏"。
  // 实测:818 字节的响应里出现的 `k-api-` 全部来自 `mixr-bak-api-ICTvve`,与哨兵无关。
  // 这正是本文件开头那条规矩警告过的形态(哨兵本体不许带会撞上别处的结构),
  // 只是这次撞上的是**路径**而不是别的字典词。路径不是配置正文,摘掉它再扫,
  // 这条断言才真的在查它声称要查的东西 —— 其余字段一个不落,仍全扫。
  const scan = r.text.replace(/"dir":"[^"]*"/g, '"dir":"<path>"');
  assertNoLeak(scan, [liveSecret, backupSecret, sk], 'GET /api/backups');
  // 连键名也不行:ANTHROPIC_AUTH_TOKEN 是配置里的字段名,它不该跟着正文一起过来
  assert.ok(!r.text.includes('ANTHROPIC_AUTH_TOKEN'), '配置正文的键名同样不许出现');
  assert.ok(!r.text.includes('OPENAI_API_KEY'), '配置正文的键名同样不许出现');
});

test('GET /api/backups: 只读 —— 跑完磁盘快照逐字节不变,一份备份都不删(即使池子超限)', async () => {
  const dir = path.dirname(SETTINGS);
  fs.mkdirSync(dir, { recursive: true });
  put(SETTINGS, JSON.stringify({ env: {} }));
  clearPool(dir, 'settings.json');
  for (let i = 1; i <= 8; i++) put(path.join(dir, bakName('settings.json', `20260${i}01-000000`)), `{"i":${i}}`);
  const before = snapshot(dir);
  assert.equal(Object.keys(before).length, 9);

  const r = await get('/api/backups');
  assert.equal(r.status, 200);
  assert.equal(r.json.dirs.find(d => d.id === 'claude').total, 8);
  assert.deepEqual(snapshot(dir), before, '端点不得写盘:名字、mtime、内容哈希都必须一模一样');
});

test('GET /api/backups: 空池与不存在的目录都是 200 —— "没查成"要能被区分出来', async () => {
  const dir = path.dirname(SETTINGS);
  fs.mkdirSync(dir, { recursive: true });
  put(SETTINGS, JSON.stringify({ env: {} }));
  clearPool(dir, 'settings.json');
  // codex 目录不存在:~/.codex 在没装 codex 的机器上是常态
  fs.rmSync(path.dirname(CODEX), { recursive: true, force: true });

  const r = await get('/api/backups');
  assert.equal(r.status, 200);
  const claude = r.json.dirs.find(d => d.id === 'claude');
  assert.equal(claude.total, 0);
  assert.deepEqual(claude.backups, []);
  assert.deepEqual(claude.next_delete, []);
  const codex = r.json.dirs.find(d => d.id === 'codex');
  assert.equal(codex.ok, false, '目录不存在不等于"零份备份",状态要分开报');
  assert.equal(codex.error.code, 'ENOENT');
  assert.deepEqual(codex.backups, []);
});

test('GET /api/backups: 前缀命中但解析不出时间的名字照样算进池子份数,并单列出来', async () => {
  const dir = path.dirname(SETTINGS);
  fs.mkdirSync(dir, { recursive: true });
  put(SETTINGS, JSON.stringify({ env: {} }));
  clearPool(dir, 'settings.json');
  put(path.join(dir, 'settings.json.bak-mixui-backup'), 'hand-made');
  put(path.join(dir, bakName('settings.json', '20260601-000000')), '{}');

  const r = await get('/api/backups');
  assert.equal(r.status, 200);
  const claude = r.json.dirs.find(d => d.id === 'claude');
  assert.equal(claude.total, 2, 'total 是"前缀命中数",不是"解析成功的数" —— 后者会让保留池看着比实际小');
  assert.equal(claude.backups.length, 1);
  assert.deepEqual(claude.unparsable, [{ name: 'settings.json.bak-mixui-backup', reason: 'bad-shape' }]);
});

test('GET /api/backups: 秒级历史格式被标成 legacy(它与现行格式不保证唯一)', async () => {
  const dir = path.dirname(SETTINGS);
  fs.mkdirSync(dir, { recursive: true });
  put(SETTINGS, JSON.stringify({ env: {} }));
  clearPool(dir, 'settings.json');
  put(path.join(dir, bakName('settings.json', '20260101-000000', '000', 'aaaa')), 'new');
  put(path.join(dir, 'settings.json.bak-mixui-20251231-235959'), 'legacy');

  const r = await get('/api/backups');
  const claude = r.json.dirs.find(d => d.id === 'claude');
  assert.equal(claude.total, 2);
  assert.equal(claude.legacy, 1);
  assert.deepEqual(claude.backups.map(b => b.legacy).sort(), [false, true]);
});

test('GET /api/backups: 只接受 GET,且不影响别的端点', async () => {
  const post = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/backups', method: 'POST' }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(post.status, 404, '这条只读分支不接 POST');
  // 新增分支不得改变既有端点的行为
  const metrics = await get('/api/metrics');
  assert.equal(metrics.status, 200);
  assert.match(metrics.text, /^# /m);
});

// ---------------------------------------------------------------- 备份池轮换的对外出口
// lib/backup/pool-watch.js 从写下来那天起就能算"这一份会顶掉谁",但三个调用点只把它
// console.warn 出去 —— 点在控制台里那个按钮的人当场看不见,面板上照样显示"已写入配置"。
// 这一节钉的就是那条通道:轮换必须随 /api/switch 与 /api/router 的响应一起回来。
//
// 措辞断言只认会变的部分(被顶掉的文件名),不认整句:整句跟文案走,改一个字就红,
// 而这里要证明的是"响应里说了哪几个文件被清出去",不是"文案长什么样"。

const CHANNEL = { app: 'claude', name: '池预警渠道', base_url: 'http://127.0.0.1:8999', api_key: 'sk-test-not-real', models: ['claude-opus-5'] };

async function post(pathname, body, method = 'POST') {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: pathname, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function del(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: pathname, method: 'DELETE' }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// 垫满保留池(默认 5 份),好让下一次备份必然触发轮换。名字按现行模板拼,字典序最小的
// 就是最先被清出去的那一份 —— 断言用的正是它。
function fillPool(t) {
  const dir = path.dirname(SETTINGS);
  fs.mkdirSync(dir, { recursive: true });
  clearPool(dir, 'settings.json');
  put(SETTINGS, JSON.stringify({ env: {} }, null, 2));
  for (let i = 0; i < 5; i++) put(path.join(dir, bakName('settings.json', `2026010${i + 1}-000000`)), '{}');
  const names = fs.readdirSync(dir).filter(n => n.startsWith('settings.json.bak-mixui-')).sort();
  assert.equal(names.length, 5, '夹具:池子要正好垫满');
  t.after(() => clearPool(dir, 'settings.json'));
  return names[0];                       // 字典序最小 = 这次会被顶掉的那份
}

test('POST /api/switch/:id:备份池满时,被顶掉的那份随响应回来(不再只写进服务端日志)', async t => {
  const doomed = fillPool(t);
  // 渠道 id 由服务端生成,不认客户端传进来的 id —— 拿返回值里的那个。
  const created = await post('/api/providers', CHANNEL);
  assert.equal(created.status, 200, '夹具:先建一个可切换的渠道');
  const id = created.json.id;

  const r = await post(`/api/switch/${id}`, {});
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.warnings), '池满时必须有 warnings 数组');
  assert.equal(r.json.warnings.length, 1, '有且只有一条轮换预警');
  assert.ok(r.json.warnings.join('\n').includes(doomed),
    `预警必须点名被顶掉的那一份 ${doomed};实得 ${JSON.stringify(r.json.warnings)}`);
  assert.ok(!fs.existsSync(path.join(path.dirname(SETTINGS), doomed)), '它确实已被清出池,预警说的是已发生的事');
});

test('POST /api/switch/:id:池子没满时响应里不带 warnings 字段(不能变成每次都喊)', async t => {
  const dir = path.dirname(SETTINGS);
  fs.mkdirSync(dir, { recursive: true });
  clearPool(dir, 'settings.json');
  put(SETTINGS, JSON.stringify({ env: {} }, null, 2));
  t.after(() => clearPool(dir, 'settings.json'));
  const created = await post('/api/providers', CHANNEL);
  assert.equal(created.status, 200);
  const id = created.json.id;

  const r = await post(`/api/switch/${id}`, {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.warnings, undefined, '池没满就不该有这个字段');
  assert.ok(fs.readdirSync(dir).filter(n => n.startsWith('settings.json.bak-mixui-')).length >= 1, '但备份本身照做');
});

// ---------------------------------------------------------------- 渠道库的备份(providers.json)
// providers.json 是全仓唯一装**全部渠道明文 key**的活文件,而它此前是这个仓库里唯一
// "会被改写、却没有任何备份"的活文件 —— lib/backup/targets.js 早把它列成 [data] 备份池,
// 那个池子却从建成起恒为 0 份:面板上看着"这里有备份在管",实际一份都不会有。
// 这一节钉住它现在真的会备,且备份走的是与客户端配置同一条预警通道。

const DATA_POOL_BASE = 'providers.json';
const dataBaks = () => fs.readdirSync(DATA).filter(n => n.startsWith(`${DATA_POOL_BASE}.bak-mixui-`)).sort();
const wipeData = () => {
  fs.mkdirSync(DATA, { recursive: true });
  clearPool(DATA, DATA_POOL_BASE);
  fs.rmSync(path.join(DATA, DATA_POOL_BASE), { force: true });
};

test('POST /api/providers:保存渠道前先备份渠道库,且备份的是**写入前**的内容', async t => {
  wipeData();
  t.after(wipeData);

  const first = await post('/api/providers', { ...CHANNEL, name: 'ONE', api_key: `sk-ONE-${'a'.repeat(12)}` });
  assert.equal(first.status, 200);
  assert.deepEqual(dataBaks(), [], '首次保存时活文件还不存在,没有"旧内容"可备份(backupFile 的既有约定)');

  const second = await post('/api/providers', { ...CHANNEL, name: 'TWO', api_key: `sk-TWO-${'b'.repeat(12)}` });
  assert.equal(second.status, 200);
  const baks = dataBaks();
  assert.equal(baks.length, 1, '第二次保存必须留下备份 —— 此前这里恒为 0 份');
  const saved = fs.readFileSync(path.join(DATA, baks[0]), 'utf8');
  assert.ok(saved.includes(`sk-ONE-${'a'.repeat(12)}`), '备份里要有写入前那个渠道');
  assert.ok(!saved.includes(`sk-TWO-${'b'.repeat(12)}`), '不许把刚写进去的内容也备份进去 —— 那不是"可捡回来的旧版本"');
  assert.equal(fs.statSync(path.join(DATA, baks[0])).mode & 0o777, 0o600, '装着明文 key 的备份必须 0600');
});

test('POST /api/providers:渠道库备份池满时,被顶掉的那份随响应回来(与 /api/switch 同一条通道)', async t => {
  wipeData();
  t.after(wipeData);
  put(path.join(DATA, DATA_POOL_BASE), JSON.stringify({ version: 2, current: {}, claude: [], codex: [] }));
  const filled = [];
  for (let i = 0; i < 5; i++) {
    const n = bakName(DATA_POOL_BASE, `2026010${i + 1}-000000`);
    filled.push(path.join(DATA, n));
    put(path.join(DATA, n), '{}');
  }

  const r = await post('/api/providers', { ...CHANNEL, name: 'ROT', api_key: `sk-ROT-${'c'.repeat(12)}` });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.warnings), '池满时渠道库的轮换也要随响应回来,不能只写进服务端日志');
  assert.ok(r.json.warnings.join('\n').includes(path.basename(filled[0])),
    `要点名被顶掉的那一份;实得 ${JSON.stringify(r.json.warnings)}`);
  assert.ok(!fs.existsSync(filled[0]), '它确实已被清出池,预警说的是已发生的事');
  assert.equal(dataBaks().length, 5, '保留池收敛到 keep 份');
});

test('POST /api/providers:池子没满时响应里不带 warnings(不能变成每存一次渠道就喊一句)', async t => {
  wipeData();
  t.after(wipeData);
  const r = await post('/api/providers', { ...CHANNEL, name: 'QUIET', api_key: `sk-Q-${'d'.repeat(12)}` });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.warnings, undefined, '没轮换就不该有这个字段');
});

test('GET /api/backups:data 池不再是结构性恒空 —— 清点得到刚存渠道留下的那一份', async t => {
  wipeData();
  t.after(wipeData);
  await post('/api/providers', { ...CHANNEL, name: 'P1', api_key: `sk-P1-${'e'.repeat(12)}` });
  await post('/api/providers', { ...CHANNEL, name: 'P2', api_key: `sk-P2-${'f'.repeat(12)}` });

  const r = await get('/api/backups');
  assert.equal(r.status, 200);
  const data = r.json.dirs.find(d => d.id === 'data');
  assert.equal(data.ok, true);
  assert.equal(data.dir, DATA, 'data 池的目录就是管线真正写 providers.json 的那个目录');
  assert.equal(data.total, 1, '面板上"数据目录"这一格此前永远显示 0 份,现在要能真的清点到');
  assert.match(data.backups[0].name, /^providers\.json\.bak-mixui-/);
});

test('写渠道库的三扇门(POST/PUT/DELETE)各自都要把轮换带出来 —— 少接一扇就少一处告知', async t => {
  // 逐扇门单独验,不是"随便打一个写接口看看有没有 warnings":三处是三条独立的返回语句
  // (POST 建渠道 / PUT 改渠道或启停 / DELETE 删渠道),改错一扇另外两扇照样绿。
  // 用一个接口代表三处,等于没验后两处。
  //
  // 顺序要紧:每扇门都要**先建好渠道、再垫满池子、最后只打那一次写入**。先建渠道是为了
  // 拿到服务端生成的 id,而它自己也会写一次库、也会轮换 —— 夹在垫池子之后就等于把
  // 断言用的那份备份提前顶掉了(实测踩过:PUT 那扇门报"要点名被顶掉的那一份"失败)。
  const doors = [
    { label: 'POST', key: 'j', run: () => post('/api/providers', { ...CHANNEL, name: 'DOOR-POST', api_key: `sk-D1-${'j'.repeat(12)}` }) },
    { label: 'PUT', key: 'k', run: id => post(`/api/providers/${id}`, { app: 'claude', enabled: false }, 'PUT') },
    { label: 'DELETE', key: 'l', run: id => del(`/api/providers/${id}`) },
  ];
  for (const door of doors) {
    wipeData();
    const created = await post('/api/providers', { ...CHANNEL, name: `DOOR-${door.label}`, api_key: `sk-${door.key.repeat(12)}` });
    assert.equal(created.status, 200, `${door.label}: 夹具建渠道失败 ${created.text}`);
    assert.ok(fs.existsSync(path.join(DATA, DATA_POOL_BASE)), '夹具:活文件已在盘上');

    // 垫满保留池(5 份)。字典序最小的那份就是这一次必然被顶掉的。
    const doomed = bakName(DATA_POOL_BASE, '20260101-000000');
    for (let i = 1; i <= 5; i++) put(path.join(DATA, bakName(DATA_POOL_BASE, `2026010${i}-000000`)), '{}');

    const r = await door.run(created.json.id);
    assert.equal(r.status, 200, `${door.label}: 这一次写入必须成功(实得 ${r.status} ${r.text})`);
    assert.ok(Array.isArray(r.json.warnings), `${door.label}: 轮换必须随响应回来`);
    assert.ok(r.json.warnings.join('\n').includes(doomed),
      `${door.label}: 要点名被顶掉的那一份 ${doomed};实得 ${JSON.stringify(r.json.warnings)}`);
  }
  wipeData();
});

test('写渠道库失败时,上一次的轮换预警不许漏进下一次成功的提示里', async t => {
  // 真正的窗口很窄,但确实存在:备份与**轮换预警**都已经发生过(备份文件已落盘、池子里
  // 最老那份已被顶掉),紧接着的**原子替换**那一步失败。此时 saveStore 抛错,调用方
  // (withStoreRollback / 删渠道)直接 sendErr(500) 返回 —— 走不到那四个 drainStoreWarnings,
  // 预警就留在暂存里,漏进下一次**成功**写入的提示。而那次操作根本没轮换过,提示是编造的。
  // 清空因此挂在唯一的落盘点(saveStore)上,而不是指望每个调用点自觉。
  //
  // 造法:把 fs.renameSync 打桩 —— backup-api 与 lib/atomic-write 拿到的是同一个 fs 单例,
  // 所以这里挡住 providers.json 的替换,就能只让"替换"这一步失败,前面的备份照常发生。
  wipeData();
  t.after(wipeData);
  const first = await post('/api/providers', { ...CHANNEL, name: 'LEAK-A', api_key: `sk-L1-${'m'.repeat(12)}` });
  assert.equal(first.status, 200, '夹具:先有一个可用的渠道库');

  // 垫满池子 —— 下一次备份必然轮换,也就是必然会暂存一句预警。
  for (let i = 1; i <= 5; i++) put(path.join(DATA, bakName(DATA_POOL_BASE, `2026010${i}-000000`)), '{}');

  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith(DATA_POOL_BASE)) throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
    return realRename(from, to);
  };
  let failed;
  try {
    failed = await post('/api/providers', { ...CHANNEL, name: 'LEAK-B', api_key: `sk-L2-${'n'.repeat(12)}` });
  } finally { fs.renameSync = realRename; }
  assert.equal(failed.status, 500, `夹具:这一次写入必须在替换那一步失败(实得 ${failed.status} ${failed.text})`);
  // 夹具自证:备份确实发生了 —— 池子里已经有一份更早的被顶掉(5 份手工垫的 + 这次新备的 - keep)
  assert.equal(dataBaks().length, 5, '夹具:备份这一步必须成功过,否则根本没暂存预警,后面那条断言就是空的');

  // 把池子清到不超限,再成功写一次:这一次没有轮换,响应里就不该有 warnings。
  for (const n of dataBaks().slice(0, 4)) fs.rmSync(path.join(DATA, n));
  const ok = await post('/api/providers', { ...CHANNEL, name: 'LEAK-C', api_key: `sk-L3-${'o'.repeat(12)}` });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.warnings, undefined,
    '上一次失败留下的预警不许跟到这一次 —— 它说的是上一次那份备份,与这次操作无关');
});

test('DELETE /api/providers 失败时,槽位与路由的引用要跟着渠道一起回滚(只回滚一处比不做更坏)', async t => {
  // 这一条不在"备份"的题目里,但它是同一次改动撞出来的:`DELETE` 会动**三处**状态
  // (渠道库 / 槽位表 / 路由规则),而旧代码只回滚了渠道数组 —— 槽位与路由的引用在
  // saveStore 之前就已经摘掉并各自落盘了。于是 HTTP 回 500「删除失败」,用户以为什么都
  // 没发生,而盘上槽位已经空了:下一次重启,渠道回来了、绑它的槽位是空的。
  // 实测(探针):槽位从 {provider: id, model: 'm'} 变成 {provider: '', model: ''},规则里的
  // provider 也被清空。回滚只做一处比不做更坏 —— 它让人以为已经回滚过了。
  wipeData();
  t.after(wipeData);
  const created = await post('/api/providers', { ...CHANNEL, name: 'RB', api_key: `sk-RB-${'q'.repeat(12)}` });
  assert.equal(created.status, 200);
  const id = created.json.id;
  // 让这个渠道被一个槽位和一条路由引用着 —— 删除时这两处都会被改写
  const slotPut = await post('/api/slots', { claude: { subagent: { provider: id, model: 'slot-model' } } }, 'PUT');
  assert.equal(slotPut.status, 200, `夹具:槽位绑定失败 ${slotPut.text}`);
  // 压缩设置是瘦身后唯一还会引用渠道 id 的规则面(普通路由规则已删除)
  const routePut = await post('/api/compact', { provider: id, model: 'claude-opus-5' });
  assert.equal(routePut.status, 200, `夹具:压缩设置绑定失败 ${routePut.text}`);

  const before = (await get('/api/state')).json;
  const slotBefore = before.slots.claude.find(s => s.name === 'subagent');
  assert.equal(slotBefore.provider, id, '夹具:槽位确实绑在这个渠道上');

  // 让落盘在**原子替换**那一步失败(备份照常发生,只有替换失败)。
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith(DATA_POOL_BASE)) throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
    return realRename(from, to);
  };
  let res;
  try { res = await del(`/api/providers/${id}`); } finally { fs.renameSync = realRename; }
  assert.equal(res.status, 500, `夹具:这次删除必须失败(实得 ${res.status} ${res.text})`);

  const after = (await get('/api/state')).json;
  assert.equal(after.providers.claude.some(p => p.id === id), true, '渠道要回来(旧代码这条已经对了)');
  const slotAfter = after.slots.claude.find(s => s.name === 'subagent');
  assert.equal(slotAfter.provider, id, '槽位对它的引用必须一起回来 —— 否则渠道在、槽位空,是另一种不一致');
  assert.equal(slotAfter.model, 'slot-model', '槽位其余字段一个字都不该丢');
  const ruleAfter = after.compact.rules.find(r => r.kind === 'global');
  assert.equal(ruleAfter.targets[0].provider, id, '压缩设置的引用同样要回来');
  // provider 被删时公开视图会补一个 enabled:false 的占位成员,所以必须同时看 enabled
  // 才证明渠道是真的回来了,而不是"占位符长得像回来"。
  assert.equal(ruleAfter.targets[0].enabled, true, '压缩设置的落点渠道要真的可用');

  // 内存对了还不够:**盘上**也得是对的。槽位与路由各自在删除过程中落过一次盘,
  // 回滚若没把它们写回去,重启之后就是另一个样子。
  // 盘上 slots.json 里那一组是**对象表**(名字 → 条目),不是数组 —— 与 /api/state 的公开视图不同形。
  const slotsOnDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'slots.json'), 'utf8'));
  assert.equal(slotsOnDisk.claude.subagent.provider, id,
    'slots.json 里也必须恢复 —— 只改内存的话重启后又变空');
  const routesOnDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'routes.json'), 'utf8'));
  assert.equal((routesOnDisk.rules || []).find(r => r.id === 'compact-global').provider, id,
    'routes.json 同理');
});

// ---------------------------------------------------------------- 删渠道:第一段落盘就失败
// 这条与上面那条"删渠道回滚"是**同一条路径上的不同触发点**,所以要各有一条用例。
// 上面那条让**最后**一步(saveStore)失败;这条让**第一步**(saveSlots)失败 —— 而第一步
// 此前是裸调、没有 try:它抛错时四处内存(store/current/slotMap/routes)已经全改完,
// 接口却冒泡出一句裸的 `simulated`,用户以为删除失败、什么都没变。
// 实测(探针,让 slots.json 的原子替换抛 EIO):HTTP 500 `{"error":"simulated"}`,
// 内存里渠道 1→0、槽位已摘掉、current 已置空,而盘上 providers.json 原封不动。
test('删渠道:第一段落盘(槽位)就失败时,四处内存与盘上都不许变', async t => {
  wipeData();
  t.after(wipeData);
  const created = await post('/api/providers', { ...CHANNEL, name: 'DEL-FIRST', api_key: `sk-DF-${'f'.repeat(12)}` });
  assert.equal(created.status, 200);
  const id = created.json.id;
  const slotPut = await post('/api/slots', { claude: { subagent: { provider: id, model: 'slot-model' } } }, 'PUT');
  assert.equal(slotPut.status, 200, `夹具:槽位绑定失败 ${slotPut.text}`);
  const routePut = await post('/api/compact', { provider: id, model: 'claude-opus-5' });
  assert.equal(routePut.status, 200, `夹具:压缩设置绑定失败 ${routePut.text}`);

  const slotsBefore = fs.readFileSync(path.join(DATA, 'slots.json'), 'utf8');
  const providersBefore = fs.readFileSync(path.join(DATA, 'providers.json'), 'utf8');

  // 只让**第一次** slots.json 落盘失败(前向那一次),好让回滚那次能成功 ——
  // 两次都失败是"回滚也失败"那条分支,不在这里验。
  const realRename = fs.renameSync;
  let seen = 0;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('slots.json') && ++seen === 1) throw Object.assign(new Error('simulated'), { code: 'EIO' });
    return realRename(from, to);
  };
  let res;
  try { res = await del(`/api/providers/${id}`); } finally { fs.renameSync = realRename; }

  assert.equal(res.status, 500, `夹具:这次删除必须失败(实得 ${res.status} ${res.text})`);
  assert.ok(seen >= 2, `夹具:回滚那次落盘必须真的被尝试过(实得 ${seen} 次)`);
  // 报错要说清是哪一步,不能是裸的 e.message
  assert.match(res.json.error, /删除渠道失败/, `错误文案要能看出是哪一步;实得 ${res.text}`);
  assert.equal(fs.readFileSync(path.join(DATA, 'slots.json'), 'utf8'), slotsBefore, '槽位必须写回原样');
  assert.equal(fs.readFileSync(path.join(DATA, 'providers.json'), 'utf8'), providersBefore, '这一步没碰过渠道库,渠道库自然不该变');

  const after = (await get('/api/state')).json;
  assert.equal(after.providers.claude.some(p => p.id === id), true,
    '内存里渠道要还在 —— 否则控制台显示它没了、盘上却还在');
  assert.equal(after.slots.claude.find(s => s.name === 'subagent').provider, id, '内存槽位要回到原样');
  const compactAfter = after.compact.rules.find(r => r.kind === 'global').targets[0];
  assert.equal(compactAfter.provider, id, '内存里的压缩设置引用也要回到原样');
  assert.equal(compactAfter.enabled, true, '占位成员不算回来 —— 渠道必须在库里');
});

test('删渠道失败:恢复渠道的原始顺序,不能把它追加到队尾', async t => {
  wipeData();
  t.after(wipeData);
  const first = await post('/api/providers', { ...CHANNEL, name: 'ORDER-FIRST' });
  const second = await post('/api/providers', { ...CHANNEL, name: 'ORDER-SECOND' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const before = (await get('/api/state')).json.providers.claude;
  const diskBefore = fs.readFileSync(path.join(DATA, DATA_POOL_BASE), 'utf8');
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(DATA, DATA_POOL_BASE)) throw Object.assign(new Error('providers write failed'), { code: 'EIO' });
    return realRename(from, to);
  };
  let res;
  try { res = await del(`/api/providers/${first.json.id}`); } finally { fs.renameSync = realRename; }

  assert.equal(res.status, 500);
  assert.equal(fs.readFileSync(path.join(DATA, DATA_POOL_BASE), 'utf8'), diskBefore);
  assert.deepEqual((await get('/api/state')).json.providers.claude, before,
    '失败操作不得改变渠道列表的顺序');
});

test('删渠道回滚:槽位恢复失败也必须继续恢复路由', async t => {
  wipeData();
  t.after(wipeData);
  const created = await post('/api/providers', { ...CHANNEL, name: 'RB-INDEPENDENT' });
  assert.equal(created.status, 200);
  const id = created.json.id;
  assert.equal((await post('/api/slots', { claude: { subagent: { provider: id, model: 'slot-model' } } }, 'PUT')).status, 200);
  assert.equal((await post('/api/compact', { provider: id, model: 'claude-opus-5' })).status, 200);
  const routesBefore = fs.readFileSync(path.join(DATA, 'routes.json'), 'utf8');
  const providersBefore = fs.readFileSync(path.join(DATA, DATA_POOL_BASE), 'utf8');
  const realRename = fs.renameSync;
  let slotWrites = 0;
  let routeWrites = 0;
  fs.renameSync = (from, to) => {
    if (to === path.join(DATA, 'routes.json')) routeWrites++;
    if (to === path.join(DATA, 'slots.json') && ++slotWrites === 2)
      throw Object.assign(new Error('slots restore failed'), { code: 'EIO' });
    if (to === path.join(DATA, DATA_POOL_BASE))
      throw Object.assign(new Error('providers write failed'), { code: 'EIO' });
    return realRename(from, to);
  };
  let res;
  try { res = await del(`/api/providers/${id}`); } finally { fs.renameSync = realRename; }

  assert.equal(res.status, 500);
  assert.equal(slotWrites, 2, '槽位前向写入成功,恢复时失败');
  assert.equal(routeWrites, 2, '槽位恢复失败不得跳过路由恢复');
  assert.equal(fs.readFileSync(path.join(DATA, 'routes.json'), 'utf8'), routesBefore);
  assert.equal(fs.readFileSync(path.join(DATA, DATA_POOL_BASE), 'utf8'), providersBefore);
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'slots.json'), 'utf8')).claude.subagent, undefined,
    '夹具确实留下无法恢复的槽位文件,不能假称完整回滚');
  assert.match(res.json.error, /slots\.json.*slots restore failed/);
  assert.match(res.json.error, /盘上已不一致/);
  const after = (await get('/api/state')).json;
  assert.equal(after.slots.claude.find(s => s.name === 'subagent').provider, id);
  // 压缩设置是唯一还会引用渠道 id 的规则面:回滚失败时它仍必须回到原样(内存层面)
  for (const rule of after.compact.rules) assert.equal(rule.targets[0].provider, id, '压缩设置的引用要回到原样');
});
