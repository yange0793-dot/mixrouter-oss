'use strict';
// 请求日志 store 的行为回归。全部只用 mkdtemp 临时目录 + 本机内存:
// 不碰现役 logs/、不碰真实配置、不连上游。假密钥一律 FAKE- 前缀,便于一眼看出是占位。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createRequestLog, LOG_FIELDS, LOG_FIELD_SET, normalizeLimit, scrubText, parseSince,
  MAX_DEPTH, MAX_KEYS,
} = require('../lib/observability/request-log');
const { proxySource } = require('./proxy-sources.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-obs-'));
const readAll = file => fs.readFileSync(file, 'utf8');

// 与 store 无关的原始 entry 形状;字段名与 mixrouter.js 的日志条目一致
const entry = over => ({
  ts: '2026-09-19T10:00:00.000Z', app: 'claude', provider: 'FAKE-渠道', model_in: 'm-in', model_out: 'm-out',
  session: 'FAKE-sess-1', session_kind: 'chat', rule: 'default', pool: 2, strategy: 'priority',
  sticky: false, attempts: 1, failover: false, in: 10, out: 20, cache_read: 3, ms: 100,
  status: 200, stream: true, kind: 'messages', wire: 'anthropic', err: '', err_class: '',
  ...over,
});

test('require 零副作用:不建目录、不建文件、不起定时器', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const log = createRequestLog({ file });
  assert.equal(fs.existsSync(path.dirname(file)), false, 'require/构造不得建目录');
  assert.equal(fs.existsSync(file), false, '构造不得建文件');
  assert.deepEqual(log.list().logs, []);
  assert.equal(fs.existsSync(path.dirname(file)), false, '只读调用也不得建目录');
});

test('首次 append 才建目录与文件:目录 0700、文件 0600', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const log = createRequestLog({ file });
  log.append(entry());
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700, '日志目录必须是 0700');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, '日志文件必须是 0600');
});

test('已存在的目录不动它的权限', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'logs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  createRequestLog({ file: path.join(dir, 'requests.jsonl') }).append(entry());
  assert.equal(fs.statSync(dir).mode & 0o777, 0o755, '既有目录权限不得被改动');
});

test('白名单逐字段证明:prompt/messages/headers/api_key/token/body/system 一个都不出现', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const log = createRequestLog({ file });
  log.append(entry({
    prompt: 'FAKE-PROMPT-BODY', messages: [{ role: 'user', content: 'FAKE-MSG' }],
    headers: { authorization: 'Bearer FAKE-HEADER-TOKEN', cookie: 'FAKE-COOKIE' },
    api_key: 'FAKE-API-KEY', token: 'FAKE-TOKEN-VALUE', body: 'FAKE-RAW-BODY', system: 'FAKE-SYSTEM',
    Authorization: 'FAKE-CAP-AUTH', Cookie: 'FAKE-CAP-COOKIE',
  }));
  const raw = readAll(file);
  const written = JSON.parse(raw.trim());
  // 键名层面:越界键一个都不许落盘。这里断言的是**键**,不是裸子串 ——
  // 'messages' 这类词会作为合法值出现(kind:'messages' 是真实取值),拿裸子串断言会误报。
  for (const key of Object.keys(written)) assert.ok(LOG_FIELD_SET.has(key), `落盘出现越界字段 ${key}`);
  for (const key of ['prompt', 'messages', 'headers', 'api_key', 'token', 'body', 'system',
    'Authorization', 'Cookie']) {
    assert.equal(Object.hasOwn(written, key), false, `落盘不得出现越界键 ${key}`);
  }
  // 值层面:越界字段携带的内容一个都不许出现(这些串只出现在被丢弃的字段里)
  for (const needle of ['FAKE-PROMPT-BODY', 'FAKE-MSG', 'FAKE-HEADER-TOKEN', 'FAKE-COOKIE',
    'FAKE-API-KEY', 'FAKE-TOKEN-VALUE', 'FAKE-RAW-BODY', 'FAKE-SYSTEM', 'FAKE-CAP-AUTH', 'FAKE-CAP-COOKIE']) {
    assert.equal(raw.includes(needle), false, `落盘原文不得出现越界字段的值 ${needle}`);
  }
  // 行数口径:一条 entry 落成一行
  assert.equal(raw.trim().split('\n').length, 1);
});

// 白名单必须与源码里 entry 字段的实际使用面**双向相等**。
// 扫法(两处都不能省,也不能多扫):
//   A. **赋值形式**:`entry.<name>` 后跟 = / ||= / += —— 只看赋值,不看读取、不看注释。
//      不能只扫读取:注释里会出现 `entry.ms`(mixrouter.js 里"其它终态都赋了 entry.ms"那句),
//      把它当字段会引入噪声;也不能扫裸标识符:同文件的 makeErrorEntry(targetModel) 与
//      entry(key,...) 是同名无关形参。
//   B. entry 对象字面量的键 —— 它支撑了那些建好之后不再被赋值的字段
//      (app/ts/rule/session/model_in/kind/pool/strategy/stream/session_kind)。
//
// ⚠ 第二期把代理编排拆成了 lib/http/proxy.js + lib/proxy/*.js:字面量构造点搬到了
// lib/http/proxy.js,而 entry.<f> 的写入点分散在六个新文件与主入口的终态注入里。
// 只扫 mixrouter.js 会立刻以"找不到 entry 对象字面量"报红,而且**扫不全会静默放过**
// 从新文件里新挂上去的字段(白名单漏字段 = 字段被 pick() 静默丢弃)。
// 文件清单已抽到 test/proxy-sources.js,与 test/log-wiring.test.js 共用同一份。
function literalKeys(source) {
  const at = source.indexOf('const entry = {');
  assert.ok(at > 0, '找不到 entry 对象字面量');
  let depth = 0, end = -1;
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > 0, 'entry 字面量没有闭合');
  const body = source.slice(source.indexOf('{', at) + 1, end);
  return [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(m => m[1]);
}

test('白名单与代理源码的 entry 字段实际集合双向相等', () => {
  const source = proxySource();
  const assigned = new Set();
  // = / ||= / += 三种赋值;=(?!=) 排除 ==
  for (const m of source.matchAll(/\bentry\.([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|\|=|\+=|=(?!=))/g)) assigned.add(m[1]);
  const used = new Set([...assigned, ...literalKeys(source)]);
  const missing = [...used].filter(f => !LOG_FIELD_SET.has(f)).sort();
  const extra = LOG_FIELDS.filter(f => !used.has(f)).sort();
  assert.deepEqual(missing, [], `白名单漏了源码里实际使用的字段: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `白名单里有源码根本没用的字段: ${extra.join(', ')}`);
  assert.equal(LOG_FIELDS.length, 30);
  // 先建后挂的三个字段只能靠赋值扫出来(不在字面量里),这里单独钉住扫描有效性
  for (const f of ['think', 'reasoning', 'tools_dropped', 'effort']) {
    assert.ok(assigned.has(f), `${f} 应由赋值扫描命中(它是先建后挂的)`);
  }
});

// 先建对象后挂字段的三个字段必须真的能落盘 —— 只列进白名单而不证明,等于躺着三个死字段
test('think / reasoning / tools_dropped 确实会出现在落盘原文里', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  createRequestLog({ file }).append(entry({ think: 7, reasoning: 3, tools_dropped: 2 }));
  const written = JSON.parse(readAll(file).trim());
  assert.equal(written.think, 7, 'think 必须落盘(排查 400 的关键证据)');
  assert.equal(written.reasoning, 3, 'reasoning 必须落盘');
  assert.equal(written.tools_dropped, 2, 'tools_dropped 必须落盘');
  assert.equal(readAll(file).includes('"think":7'), true);
});

test('容量:超过 capacity 从头部淘汰,list 只见窗口内的条目', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = createRequestLog({ file: path.join(root, 'logs', 'requests.jsonl'), capacity: 3 });
  for (let i = 1; i <= 5; i++) log.append(entry({ session: `s${i}`, ms: i }));
  assert.equal(log._ring.length, 3);
  assert.deepEqual(log.list().logs.map(e => e.session), ['s5', 's4', 's3'], '新→旧,只留最后 3 条');
});

test('轮转:超过 maxBytes 生成独立归档,新文件重新开始', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const log = createRequestLog({ file, maxBytes: 200 });
  for (let i = 0; i < 6; i++) log.append(entry({ session: `FAKE-${i}` }));
  const archives = fs.readdirSync(path.dirname(file)).filter(n => n.includes('.archive-'));
  assert.equal(archives.length, 5, '每次轮转保留独立归档,不得覆盖旧记录');
  assert.ok(fs.statSync(file).size <= 200 * 2, '轮转后新文件应重新开始');
});

test('脱敏在进内存环之前:环里与磁盘上都是脱敏后的', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const log = createRequestLog({ file, secrets: ['FAKE-SECRET-LONG', 'FAKE-SECRET'] });
  log.append(entry({ err: 'upstream said FAKE-SECRET-LONG bad' }));
  const disk = readAll(file);
  assert.equal(disk.includes('FAKE-SECRET'), false, '磁盘不得残留密钥');
  assert.ok(disk.includes('[redacted]'));
  // 内存环同样是脱敏后的,否则 /api/logs 会把未脱敏 err 直接发给控制台
  assert.equal(JSON.stringify(log._ring).includes('FAKE-SECRET'), false, '内存环也必须已脱敏');
});

test('截断必须发生在替换之后:横跨截断点的长密钥不得漏出后半段', t => {
  const secret = `FAKE-${'X'.repeat(60)}-TAIL`;
  // 让密钥正好横跨 300 字符的截断点:前缀填到 290,密钥从第 290 字符开始
  const prefix = 'A'.repeat(290);
  const scrubbed = scrubText(prefix + secret, [secret]);
  assert.equal(scrubbed.includes('TAIL'), false, '先把密钥切成两半就会漏出后半段');
  assert.equal(scrubbed.includes(secret), false);
  assert.ok(scrubbed.includes('[redacted]'));
  assert.ok(scrubbed.length <= 300, '截断上限仍生效');
});

test('脱敏表内条目互不为子串时的正确性:长串与其前缀同在表里,不得留半截', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const short = 'FAKE-KEY';
  const long = 'FAKE-KEY-AND-A-LONG-TAIL';
  // 喂入顺序刻意「短在前」:若实现按传入顺序替换,短串会先把长串切碎,
  // 剩下一截 'AND-A-LONG-TAIL' 明文漏出去 —— 这正是先长后短排序要防的。
  const log = createRequestLog({ file, secrets: [short, long] });
  log.append(entry({ err: `key=${long} also=${short} end` }));
  const disk = readAll(file);
  const written = JSON.parse(disk.trim());
  assert.equal(disk.includes(long), false, '长串不得残留');
  assert.equal(disk.includes(short), false, '短串不得残留');
  // 「半截」两种形态:长串的后半段、长串的前半段,都不许出现
  assert.equal(disk.includes('AND-A-LONG-TAIL'), false, '长串后半段不得漏出(短串先替换就会这样)');
  assert.equal(disk.includes('TAIL'), false);
  assert.equal(written.err, 'key=[redacted] also=[redacted] end', '两处都应被整体替换');
});

test('脱敏表内条目互不为子串时的正确性:n 次替换后不得二次扫描出新命中', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  // A 替换后产生的文本里不能命中 B;这里用「替换结果含另一条密钥」的形状构造
  const a = 'FAKE-KEY-A';
  const planted = 'FAKE-KEY-B';
  const log = createRequestLog({ file, secrets: [a, planted] });
  log.append(entry({ err: `${a} then ${planted}` }));
  const written = JSON.parse(readAll(file).trim());
  assert.equal(written.err, '[redacted] then [redacted]');
  // 幂等性:再跑一遍 scrubText 不应再变(否则说明替换产物本身会被再次命中)
  assert.equal(scrubText(written.err, [a, planted]), written.err, '替换结果必须稳定,不得二次命中');
});

test('脱敏覆盖所有字符串字段:model_in 等也是请求体原文,不得裸奔', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const log = createRequestLog({ file, secrets: ['FAKE-KEY-IN-MODEL'] });
  // 客户端把 Key 误填进 model 字段 —— 这是真实会发生的形状
  log.append(entry({ model_in: 'FAKE-KEY-IN-MODEL', model_out: 'FAKE-KEY-IN-MODEL', provider: 'FAKE-KEY-IN-MODEL' }));
  const disk = readAll(file);
  assert.equal(disk.includes('FAKE-KEY-IN-MODEL'), false, '磁盘不得残留(任何字符串字段都不许裸奔)');
  assert.equal(JSON.stringify(log._ring).includes('FAKE-KEY-IN-MODEL'), false, '内存环同样不得残留');
  const written = JSON.parse(disk.trim());
  assert.equal(written.model_in, '[redacted]', '应被替换成 [redacted]');
  assert.equal(written.provider, '[redacted]');
  // 其余字段不截断,保持既有形状
  assert.equal(written.session, 'FAKE-sess-1', '非敏感字段原样保留');
});

// R5:secrets 支持函数形态(惰性求值)。接线侧的渠道是运行时增删的,
// 构造时快照会让之后新加的 key 不脱敏 —— 而新填的 key 最容易填错、最容易撞 401 被回显。
test('secrets 函数形态:每次 append 求值,运行中新增的密钥也被脱敏', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  let keys = ['FAKE-KEY-A'];
  const log = createRequestLog({ file, secrets: () => keys });

  // 断言 1:函数形态下,首次 append 的 err 被替换
  log.append(entry({ session: 's1', err: 'upstream 401 for FAKE-KEY-A' }));
  let written = JSON.parse(readAll(file).trim().split('\n')[0]);
  assert.equal(written.err.includes('FAKE-KEY-A'), false, '函数形态必须生效');
  assert.equal(written.err.includes('[redacted]'), true);

  // 断言 2(R5 核心):运行中变更函数返回值 —— 证明不是构造时快照
  keys = ['FAKE-KEY-A', 'FAKE-KEY-B'];
  log.append(entry({ session: 's2', err: 'boom FAKE-KEY-B' }));
  const lines = readAll(file).trim().split('\n');
  written = JSON.parse(lines[1]);
  assert.equal(written.err.includes('FAKE-KEY-B'), false, '运行中新增的密钥也必须脱敏(不是快照)');
  assert.equal(written.err.includes('[redacted]'), true);
});

test('secrets 取值函数抛错:fail closed,安全数值保留、原文不落盘', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const errors = [];
  const log = createRequestLog({
    file, secrets: () => { throw new Error('FAKE-secret-source-broke'); },
    onError: () => errors.push(1),
  });
  log.append(entry({ session: 's-boom', err: 'FAKE-UNSCRUBBED' }));
  assert.deepEqual(errors, [1], 'secret_source failure must be observable');
  assert.equal(log._ring.length, 1, 'entry 仍进环');
  const written = JSON.parse(readAll(file).trim());
  // 无法取得密钥时不能让任何调用方字符串或容器透传。
  assert.equal(written.err_class, 'secret_source');
  assert.equal(readAll(file).includes('FAKE-UNSCRUBBED'), false);
  assert.equal(written.in, 10);
  assert.equal(written.session, undefined);
});

test('secrets 求值次数:每次 append 只求一次,不随字段数放大', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const log = createRequestLog({
    file: path.join(root, 'logs', 'requests.jsonl'),
    secrets: () => { calls++; return ['FAKE-KEY-A']; },
  });
  log.append(entry({}));
  assert.equal(calls, 1, `每次 append 只应求值一次,实际 ${calls} 次(否则是 O(字段数))`);
});

test('secrets 数组形态仍是构造时快照(向后兼容)', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const keys = ['FAKE-KEY-A'];
  const log = createRequestLog({ file, secrets: keys });
  keys.push('FAKE-KEY-B'); // 构造之后改数组,快照形态不应受影响
  log.append(entry({ err: 'x FAKE-KEY-B y' }));
  const written = JSON.parse(readAll(file).trim());
  assert.equal(written.err.includes('FAKE-KEY-B'), true, '数组形态是快照,构造后改数组不影响它');
});

// R6:非字符串容器必须递归脱敏。原样透传时密钥以**对象形态**落盘、字符串脱敏整层被绕过,
// 而日志是持久的 —— 删掉请求也删不掉已经写下的行。
test('R6 嵌套对象里的密钥必须被递归脱敏(对象形态不得绕过)', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const log = createRequestLog({ file, secrets: ['FAKE-KEY-NESTED'] });
  log.append(entry({ model_in: { outer: { inner: 'bearer FAKE-KEY-NESTED' } } }));
  const raw = readAll(file);
  assert.equal(raw.includes('FAKE-KEY-NESTED'), false, '嵌套对象里的密钥不得原样落盘');
  const written = JSON.parse(raw.trim());
  assert.equal(written.model_in.outer.inner, 'bearer [redacted]', '深层字符串仍要脱敏');
  // 对象形态本身要保留 —— 不是把它 String() 化
  assert.equal(typeof written.model_in, 'object', '容器形态必须保留,不得压成字符串');
});

test('R6 数组里的密钥也要脱敏', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  createRequestLog({ file, secrets: ['FAKE-KEY-ARR'] })
    .append(entry({ model_in: ['ok', 'k=FAKE-KEY-ARR', { deep: 'FAKE-KEY-ARR' }] }));
  const raw = readAll(file);
  assert.equal(raw.includes('FAKE-KEY-ARR'), false, '数组元素与数组内对象都要脱敏');
  assert.equal(JSON.parse(raw.trim()).model_in[0], 'ok', '非密钥元素原样保留');
});

test('R6 非字符串标量不做 String() 化(number/boolean/null 保持原类型)', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  // 这里要**同时有密钥**才走 scrubDeep 分支 —— 否则走的是 hasSecrets=false 的原值路径,测不到本轮改动
  createRequestLog({ file, secrets: ['FAKE-KEY-X'] })
    .append(entry({ model_in: 3, pool: false, sticky: null, err: 'FAKE-KEY-X' }));
  const written = JSON.parse(readAll(file).trim());
  assert.equal(written.model_in, 3, 'model_in: 3 不得变成 "3"(类型契约)');
  assert.equal(written.pool, false, 'false 不得变成 "false"');
  assert.equal(written.sticky, null, 'null 不得变成 "null"');
  assert.equal(written.err.includes('FAKE-KEY-X'), false);
});

test('R6 循环引用:append 不抛、不死循环、entry 仍落盘并标记 [circular]', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const errors = [];
  const log = createRequestLog({
    file, secrets: ['FAKE-KEY-CYCLE'], onError: (e, ctx) => errors.push(ctx.op),
  });
  const cyc = { name: 'x' };
  cyc.self = cyc;
  const t0 = Date.now();
  // append 抛会打断请求处理,比泄露更严重的故障 —— 这条是防它
  assert.doesNotThrow(() => log.append(entry({ model_in: cyc, err: 'k FAKE-KEY-CYCLE' })));
  assert.ok(Date.now() - t0 < 2000, '不得死循环(2s 上限)');
  assert.deepEqual(errors, [], '环不是落盘失败,不该调 onError');
  const written = JSON.parse(readAll(file).trim());
  assert.equal(written.model_in.self, '[circular]');
  assert.equal(written.err.includes('FAKE-KEY-CYCLE'), false, '同一 entry 里的平级字段仍要脱敏');
});

test('R6 同一对象出现在两个字段里不算环(环检测用路径栈,不是全局 visited)', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const shared = { k: 'FAKE-KEY-SHARED' };
  createRequestLog({ file, secrets: ['FAKE-KEY-SHARED'] })
    .append(entry({ model_in: shared, model_out: shared }));
  const written = JSON.parse(readAll(file).trim());
  // 共享是值重复,不是自引用;标成 [circular] 会丢掉真实内容
  assert.equal(written.model_in.k, '[redacted]');
  assert.equal(written.model_out.k, '[redacted]', '同一对象在另一字段里应正常展开,不是 [circular]');
});

test('R6 深度上限:撞到上限截断成 [depth],深层密钥不得漏出', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const deep = { lvl1: { lvl2: { lvl3: { lvl4: { lvl5: 'FAKE-KEY-DEEP' } } } } };
  createRequestLog({ file, secrets: ['FAKE-KEY-DEEP'] }).append(entry({ model_in: deep }));
  const raw = readAll(file);
  assert.equal(raw.includes('FAKE-KEY-DEEP'), false, '超出深度的密钥必须在截断处丢掉,不得原样透传');
  const written = JSON.parse(raw.trim());
  assert.equal(written.model_in.lvl1.lvl2.lvl3, '[depth]', `深度上限 ${MAX_DEPTH} 应在此截断`);
  assert.equal(written.model_in.lvl1.lvl2.lvl4, undefined, '截断后不得再往下走');
});

test('R6 宽对象键数有界:超上限截断为 [太多键]', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const wide = {};
  for (let i = 0; i < MAX_KEYS + 50; i++) wide[`k${i}`] = i;
  wide[`k${MAX_KEYS + 10}`] = 'FAKE-KEY-WIDE';   // 落在被丢弃的尾部
  createRequestLog({ file, secrets: ['FAKE-KEY-WIDE'] }).append(entry({ model_in: wide }));
  const raw = readAll(file);
  assert.equal(raw.includes('FAKE-KEY-WIDE'), false, '被丢弃的尾部内容不得落盘');
  const written = JSON.parse(raw.trim());
  assert.deepEqual(written.model_in['[太多键]'], true, '超上限必须有明确标记');
  assert.equal(Object.keys(written.model_in).length, MAX_KEYS + 1, '键数应被截到上限 + 标记位');
});

test('R6 对象形态不因 hasSecrets=false 而漏:无密钥时容器原样保留', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  createRequestLog({ file }).append(entry({ model_in: { a: { b: 1 } } }));
  const written = JSON.parse(readAll(file).trim());
  assert.deepEqual(written.model_in, { a: { b: 1 } }, '没配密钥时不该改动容器内容');
});

test('R6 Buffer 必须以字节数组形态拦下:密钥不得变成可还原的数字序列', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  createRequestLog({ file, secrets: ['FAKE-KEY-BUF'] })
    .append(entry({ model_in: Buffer.from('bearer FAKE-KEY-BUF') }));
  const raw = readAll(file);
  // 原样透传时 Buffer 会序列化成 {"0":98,"1":101,...} —— 明文一个字都不出现,
  // 但 Buffer.from(Object.values(x)) 就能还原。裸子串断言在这里**测不出来**,必须查字节语义。
  const written = JSON.parse(raw.trim());
  assert.equal(typeof written.model_in, 'string', 'Buffer 必须转成字符串,不得落成字节数组对象');
  assert.equal(written.model_in.includes('FAKE-KEY-BUF'), false, 'Buffer 里的密钥必须被脱敏');
  const bytes = Object.values(written.model_in || {}).filter(v => typeof v === 'number');
  assert.equal(bytes.length, 0, '不得留下可还原的字节序列');
});

test('R6 类实例的自有属性必须脱敏,不得原样透传', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  class Carrier { constructor(k) { this.k = k; this.n = 1; } }
  createRequestLog({ file, secrets: ['FAKE-KEY-INST'] })
    .append(entry({ model_in: new Carrier('FAKE-KEY-INST') }));
  const raw = readAll(file);
  assert.equal(raw.includes('FAKE-KEY-INST'), false, '类实例的自有属性会进 JSON.stringify,必须脱敏');
  const written = JSON.parse(raw.trim());
  assert.equal(written.model_in.k, '[redacted]');
  assert.equal(written.model_in.n, 1, '非密钥属性原样保留');
});

test('R6 Date 落成 ISO 字符串(TypedArray/Date 都不许原样透传)', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const when = new Date('2026-09-19T10:00:00.000Z');
  createRequestLog({ file, secrets: ['FAKE-KEY-D'] }).append(entry({ model_in: when, err: 'FAKE-KEY-D' }));
  const written = JSON.parse(readAll(file).trim());
  assert.equal(written.model_in, '2026-09-19T10:00:00.000Z', 'Date 应落成 ISO 串(JSON.stringify 本来就这个形态)');
});

test('写失败不崩且只警告一次,恢复后可继续落盘', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // 让父路径是一个**文件**:mkdir/append 必然失败
  const blocker = path.join(root, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const errors = [];
  const log = createRequestLog({ file: path.join(blocker, 'logs', 'requests.jsonl'), onError: (e, c) => errors.push(c.op) });
  for (let i = 0; i < 3; i++) log.append(entry({ session: `s${i}` }));
  assert.equal(errors.length, 1, '同一故障连续 append 只警告一次,不刷屏');
  assert.deepEqual(errors, ['append']);
  assert.equal(log._ring.length, 3, '写失败不影响内存环');
});

test('limit:非有限→200,<=0→[]', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = createRequestLog({ file: path.join(root, 'logs', 'requests.jsonl') });
  for (let i = 0; i < 250; i++) log.append(entry({ session: `s${i}` }));
  assert.equal(log.list({ limit: NaN }).logs.length, 200, 'NaN → 默认 200');
  assert.equal(log.list({ limit: 'abc' }).logs.length, 200, '非数 → 默认 200');
  assert.equal(log.list({ limit: undefined }).logs.length, 200);
  assert.deepEqual(log.list({ limit: -5 }).logs, [], '负数不得反转成全量');
  assert.deepEqual(log.list({ limit: 0 }).logs, []);
  assert.equal(log.list({ limit: 5 }).logs.length, 5);
  // 直接钉住纯函数,防回归
  assert.equal(normalizeLimit(NaN), 200);
  assert.equal(normalizeLimit(-1), 0);
  assert.equal(normalizeLimit('7'), 7);
});

// /api/logs 的 limit 语义守卫。**必须用字符串形态喂入** —— 查询串到达时就是字符串
// (`q.get('limit')` 永远返回 string 或 null),而上面那条 `limit:非有限→200,<=0→[]`
// 喂的是 number,覆盖不到真实传输形态。两者的差别是实质性的:
//   number 0  || 200 → 回落 200;字符串 '0' || 200 → '0' 是真值,不回落。
// **必须 250 条**:缺陷只在 ring 超过默认 200 条时才显形(全量 250 vs 默认 200 才有差),
// 放几条记录的 fixture 里这三条会恒绿 —— 那是装饰性断言,不是守卫。
const mkRing = n => {
  const root = tmpDir();
  const log = createRequestLog({ file: path.join(root, 'logs', 'requests.jsonl') });
  for (let i = 1; i <= n; i++) log.append(entry({ session: `s${i}`, status: 200 }));
  return log;
};

test('limit=0:必须是空,不得变成 slice(-0)=slice(0) 的全量', () => {
  assert.deepEqual(mkRing(250).list({ limit: '0' }).logs, []);
});

test('limit=abc:NaN 必须退化成默认 200,不得返回全量', () => {
  assert.equal(mkRing(250).list({ limit: 'abc' }).logs.length, 200);
});

test('limit=-5:必须是空,不得变成 slice(5) 砍掉最旧 5 条', () => {
  assert.deepEqual(mkRing(250).list({ limit: '-5' }).logs, []);
});

test('limit 正常路径不变:5→5 条、500→全部 250 条、缺参→200 条', () => {
  const log = mkRing(250);
  assert.equal(log.list({ limit: '5' }).logs.length, 5);
  // limit=500 必须继续给全量:test/proxy.test.js 用 stats.reqs === all.logs.length 对账
  assert.equal(log.list({ limit: '500' }).logs.length, 250);
  assert.equal(log.list({ limit: null }).logs.length, 200, '缺参(q.get() 返回 null)→ 默认 200');
});

test('list 过滤矩阵:app/provider/model/session/status/since 各一正一反', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = createRequestLog({ file: path.join(root, 'logs', 'requests.jsonl') });
  log.append(entry({ ts: '2026-09-19T10:00:00.000Z', app: 'claude', provider: 'Alpha', model_in: 'opus', session: 'sess-a', status: 200 }));
  log.append(entry({ ts: '2026-09-19T11:00:00.000Z', app: 'codex', provider: 'Beta', model_out: 'gpt-x', session: 'sess-b', status: 500, err: 'boom' }));
  assert.equal(log.list({ app: 'claude' }).matched, 1);
  assert.equal(log.list({ app: 'codex' }).matched, 1);
  assert.equal(log.list({ provider: 'alpha' }).matched, 1, 'provider 大小写不敏感子串');
  assert.equal(log.list({ provider: 'gamma' }).matched, 0);
  assert.equal(log.list({ model: 'opus' }).matched, 1, '命中 model_in');
  assert.equal(log.list({ model: 'gpt-x' }).matched, 1, '命中 model_out');
  assert.equal(log.list({ model: 'nope' }).matched, 0);
  assert.equal(log.list({ session: 'sess-a' }).matched, 1);
  assert.equal(log.list({ session: 'sess-z' }).matched, 0);
  assert.equal(log.list({ status: 'ok' }).matched, 1);
  assert.equal(log.list({ status: 'err' }).matched, 1);
  assert.equal(log.list({ status: '500' }).matched, 1);
  assert.equal(log.list({ status: '418' }).matched, 0);
  assert.equal(log.list({ since: '2026-09-19T10:30:00.000Z' }).matched, 1, '只留 11:00 那条');
  assert.equal(log.list({ since: '2026-09-19T12:00:00.000Z' }).matched, 0);
  assert.equal(log.list({ since: 'not-a-date' }).matched, 2, '坏 since 当没给');
  assert.equal(parseSince('not-a-date'), null);
  // 组合:DATE + app 同时收窄
  assert.equal(log.list({ app: 'codex', status: 'err' }).matched, 1);
});

test('summary 旧字段名与语义不变', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = createRequestLog({ file: path.join(root, 'logs', 'requests.jsonl') });
  const empty = log.summary();
  assert.equal(empty.reqs, 0);
  assert.equal(empty.ok_rate, 100, 'reqs=0 时 ok_rate 仍是 100');
  log.append(entry({ status: 200 }));
  log.append(entry({ status: 500, err: 'x', provider: '' }));
  const s = log.summary();
  assert.equal(s.reqs, 2);
  assert.equal(s.ok, 1);
  assert.equal(s.ok_rate, 50);
  assert.equal(s.inTok, 20);
  assert.equal(s.outTok, 40);
  assert.equal(s.cache, 6);
  assert.equal(s.by_app.claude, 2);
  assert.equal(s.by_provider['(未知)'], 1, '缺省 provider 标签保持现状');
  assert.equal(s.by_model['m-out'], 2);
  assert.equal(s.attempts, 2, '每个 entry 默认 attempts:1');
  assert.equal(s.failover, 0);
});

test('summary 分组名可以与 Object.prototype 同名,计数与 JSON 输出仍完整', () => {
  const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '普通名称'];
  for (const [field, group] of [
    ['app', 'by_app'], ['provider', 'by_provider'],
    ['model_out', 'by_model'], ['model_in', 'by_model'],
  ]) {
    const log = createRequestLog();
    for (const [i, name] of names.entries()) {
      for (let n = 0; n <= i; n++) log.append(entry({ model_out: '', [field]: name }));
    }
    const summary = log.summary();
    const counts = summary[group];
    const expected = Object.fromEntries(names.map((name, i) => [name, i + 1]));
    assert.deepEqual(counts, expected, `${field} 的所有名称都应有独立的数字计数`);
    assert.equal(Object.getPrototypeOf(counts), Object.prototype, '对外仍返回普通对象');
    assert.deepEqual(JSON.parse(JSON.stringify(summary))[group], expected, 'JSON 响应不得丢掉特殊名称');
    assert.equal(Object.values(counts).reduce((sum, n) => sum + n, 0), summary.reqs);
  }
});

test('summary 新字段:p50/p95 只吃 ms>0,attempts/failover/capacity/range', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = createRequestLog({ file: path.join(root, 'logs', 'requests.jsonl'), capacity: 500 });
  // count_tokens 形状:ms 恒为 0(成功路径不赋值),不得污染分位数
  log.append(entry({ ms: 0, kind: 'count_tokens' }));
  for (const ms of [10, 20, 30, 40]) log.append(entry({ ms }));
  const s = log.summary();
  assert.equal(s.ms_sample, 4, 'ms=0 不算样本');
  assert.equal(s.p50, 20);
  assert.equal(s.p95, 40);
  log.append(entry({ attempts: 3, failover: true }));
  log.append(entry({ attempts: 1 }));
  const s2 = log.summary();
  // 前 5 条各默认 attempts:1(=5),后两条 3 + 1 => 9
  assert.equal(s2.attempts, 9, 'attempts 按条求和');
  assert.equal(s2.failover, 1, 'failover 只数 true 的条数');
  assert.equal(s2.capacity, 500);
  assert.equal(s2.range.from, '2026-09-19T10:00:00.000Z');
  const emptyLog = createRequestLog({ file: path.join(root, 'logs', 'other.jsonl') });
  const e = emptyLog.summary();
  assert.equal(e.p50, null, '无样本返回 null,不返回 0');
  assert.equal(e.p95, null);
  assert.equal(e.range.from, null);
  assert.equal(e.range.to, null);
});

test('today 与既有实现等价:按本地日历日', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixed = new Date('2026-09-19T12:00:00').getTime();
  const log = createRequestLog({ file: path.join(root, 'logs', 'requests.jsonl'), now: () => fixed });
  const d = new Date(fixed);
  const stamp = at => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(at).padStart(2, '0')}T12:00:00.000Z`;
  log.append(entry({ ts: stamp(19), in: 5, out: 6 }));
  log.append(entry({ ts: stamp(18), in: 100, out: 100 })); // 昨天,不计
  assert.deepEqual(log.today(), { reqs: 1, inTok: 5, outTok: 6 });
});

test('零第三方依赖:模块只 require node: 内置', () => {
  for (const rel of ['../lib/observability/request-log', '../lib/observability/metrics']) {
    const source = fs.readFileSync(path.resolve(__dirname, rel) + '.js', 'utf8');
    for (const m of source.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
      const spec = m[2];
      assert.ok(spec.startsWith('node:') || spec.startsWith('.'), `${rel} 引入了非内置依赖: ${spec}`);
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'package.json 不得出现 dependencies');
});

test('err_class 单独一维:status 记 200 的断流也能被筛出来(status 与它是正交的)', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = createRequestLog({ file: path.join(root, 'logs', 'requests.jsonl') });
  // 成功、断流、普通 5xx 各一条。断流那条 status=200 且 err 非空 —— 就是 requests.jsonl
  // 里"客户端看着成功、实际流没跑完"的那类,只按 status 筛一颗都捞不到。
  log.append(entry({ ts: '2026-09-19T10:00:00.000Z', provider: 'Alpha', status: 200 }));
  log.append(entry({ ts: '2026-09-19T11:00:00.000Z', provider: 'Beta', status: 200, err: 'Responses 流式调用失败', err_class: 'stream_aborted' }));
  log.append(entry({ ts: '2026-09-19T12:00:00.000Z', provider: 'Gamma', status: 502, err: 'ECONNRESET', err_class: 'econnreset' }));

  // status 那两档把断流和 5xx 混在同一桶里:两者都落进 err,分不开是断流还是上游挂了。
  assert.equal(log.list({ status: 'ok' }).matched, 1, '断流带 err,本就不算 ok');
  assert.equal(log.list({ status: 'err' }).matched, 2, '断流与 5xx 同归 err —— 这一档分不出谁是谁');
  // err_class 的价值就在于从 err 桶里把具体某一类摘出来
  assert.equal(log.list({ err_class: 'stream_aborted' }).matched, 1);
  assert.equal(log.list({ err_class: 'econnreset' }).matched, 1);
  assert.equal(log.list({ err_class: 'stream_aborted' }).logs[0].provider, 'Beta');
  // 大小写不敏感
  assert.equal(log.list({ err_class: 'STREAM_ABORTED' }).matched, 1);
  // 子串匹配(与 provider/model 同口径)
  assert.equal(log.list({ err_class: 'stream' }).matched, 1);
  assert.equal(log.list({ err_class: 'nope' }).matched, 0);
  // 不带该参数时不过滤,三条都在
  assert.equal(log.list({}).matched, 3);
  assert.equal(log.list({ err_class: '' }).matched, 3, '空串当没给');
  // 与 status 叠加:两维各自独立收窄
  assert.equal(log.list({ err_class: 'stream_aborted', status: 'err' }).matched, 1);
  assert.equal(log.list({ err_class: 'stream_aborted', status: 'ok' }).matched, 0, '断流不是 ok,叠加后互斥');
  assert.equal(log.list({ err_class: 'econnreset', status: 'err' }).matched, 1);
});
