'use strict';
// 接线覆盖率:证明 mixrouter.js 的 /api/logs、/api/stats、/api/state、/api/metrics 真的
// 走 lib/observability/request-log.js 的白名单/脱敏/limit 语义,而不是只证明"模块自己好用"。
//
// 为什么必须有这个文件:lib 侧的 test/request-log.test.js 与 test/metrics.test.js **不 require
// mixrouter.js**,它们测的是模块自身;上面的实现即使一个调用点都没接上,那两个文件照样全绿。
// 本文件是唯一会因"接线被拆掉"而变红的测试。
//
// 条目**全部由真代理请求产生**(mock 上游 → proxyHandler → finalize → 日志实例),
// 不经过任何测试专用后门:写侧与读侧都必须是生产路径。
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMockUpstream } = require('./mock-upstream.js');
const { proxySource, PROXY_SOURCES } = require('./proxy-sources.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-logwiring-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
// 打的是死端口:重试照打(要的就是 N 条失败日志),但间隔不必真等
process.env.MIXR_RETRY_DELAY_MS = '0';

const mock = createMockUpstream();
// 渠道密钥 = 哨兵本身,而且**真的 seed 进 store**(下面的 providers.json)。这两件事缺一不可:
// 哨兵若不是 store 里的真密钥,脱敏表里就没有它,前后都不会被替换 —— 我第一版 harness 正是这么错的,
// 拿一段"像密钥的字符串"当哨兵,结果接线前后都原样透出,差点把"脱敏没生效"报成结论。
//
// ⚠ 泄漏路径是**手工喂进去的**,不要读成"上游会回显密钥":mock 上游**不读也不回显**任何请求头
// (test/mock-upstream.js 里零处读 headers)。下面用 setSseWrappedError(401, `invalid x-api-key: ${SENT_ERR}`)
// 把密钥原文塞进上游错误体,模拟"网关把 x-api-key 回显进 401 message"那类真实形状。
// 本用例要验的是**脱敏器认不认得这把 key**,不是 mock 会不会自己回显。
const SENT_ERR = 'sk-ant-ERR-SENTINEL-AAAABBBBCCCCDDDD';
const SENT_MODEL = 'sk-ant-MODEL-SENTINEL-EEEEFFFFGGGGHHHH';
const LOG_FILE = path.join(TMP, 'logs', 'requests.jsonl');

let mod, proxySrv, uiSrv, proxyPort, uiPort, mockPort;

const raw = (port, method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request({ hostname: '127.0.0.1', port, method, path: p,
    headers: { host: `127.0.0.1:${port}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } },
    res => { const cs = []; res.on('data', c => cs.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(cs).toString('utf8') })); });
  r.on('error', reject);
  if (data) r.write(data);
  r.end();
});
const ui = (m, p) => raw(uiPort, m, p);
const ask = (model, extra = {}) => raw(proxyPort, 'POST', '/v1/messages',
  { model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...extra });

// 与 entry 字面量 + entry.X 赋值点逐字对应的运行时字段。
// think / reasoning / tools_dropped 是**条件写入**(mixrouter.js 的 `if (dropped)` 与 `if (conv)`),
// 本文件的用例都不触发那两个分支,所以它们不在**运行时**出现 —— 但它们是**活字段**,
// 下面"白名单外字段会被静默丢弃"那条源码级断言才是它们的主场。
// request_id 也是运行时字段:它由入口写进字面量(没接 trace store 时是空串),
// 所以无论 /api/attempts 有没有接线,日志键集都是同一套。
const RUNTIME_FIELDS = ['app', 'attempts', 'bytes_in', 'cache_read', 'effort', 'err', 'err_class', 'failover', 'in', 'key_id', 'key_source', 'kind', 'model_in',
  'model_out', 'ms', 'out', 'pool', 'provider', 'request_id', 'rule', 'session', 'session_kind', 'slot', 'status', 'sticky',
  'strategy', 'stream', 'ts', 'ttfb_ms', 'wire'].sort();
const keysOf = o => Object.keys(o).sort();

test('setup:mock 上游 + 两个服务;渠道没有任何可用目标', async () => {
  await new Promise(ok => mock.server.listen(0, '127.0.0.1', ok));
  mockPort = mock.server.address().port;
  mock.server.unref();
  fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });   // 真实装机里 logs/ 已存在
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({
    version: 2, current: { claude: null, codex: null },
    claude: [
      // 绑定上游:用来产生"成功但有 err"的条目(上游 401 回显密钥)
      { id: 'p-echo', name: '回显渠道', base_url: `http://127.0.0.1:${mockPort}`, api_key: SENT_ERR, enabled: true, models: ['echo-model'] },
      // 多账号渠道、且没有任何路由指向它:它的密钥只能通过"密钥清单"这一层被脱敏覆盖
      { id: 'p-multi', name: '多账号渠道', base_url: 'http://127.0.0.1:1', api_key: SENT_MODEL, enabled: true,
        keys: [{ id: 'k1', label: '账号1', key: SENT_ERR }, { id: 'k2', label: '账号2', key: SENT_MODEL }] },
    ],
    codex: [],
  }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({
    rules: [
      { id: 'r-echo', match: 'echo-model', provider: 'p-echo', model: 'echo-model', enabled: true },
      // 规则把请求模型改写成 SENT_MODEL(另一个渠道的密钥)。落地后 entry.model_out 就是这把密钥
      // —— 这正是模块注释点名的威胁:客户端把 Key 误填进 model。model_out 只可能是路由改写的结果,
      // 所以这条用例要验的是"**不在用**的渠道的密钥同样被脱敏",即 secrets 取的是全量清单而非当前渠道。
      { id: 'r-leak', match: 'leaky-model', provider: 'p-echo', model: SENT_MODEL, enabled: true },
    ],
    default: { provider: '', model: '' },
  }));
  fs.writeFileSync(path.join(TMP, 'slots.json'), JSON.stringify({ version: 1, claude: { opus: { provider: 'p-echo', model: 'echo-model' } }, codex: {} }));
  mod = require('../mixrouter.js');
  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  proxySrv.unref(); uiSrv.unref();
});

test('代理请求真的写进了 /api/logs(写侧接线)', async () => {
  const r = await ask('echo-model');
  assert.strictEqual(r.status, 200);
  const { logs } = JSON.parse((await ui('GET', '/api/logs')).text);
  assert.strictEqual(logs.length, 1, '一次请求恰好一条日志');
  assert.strictEqual(logs[0].provider, '回显渠道');
  assert.strictEqual(logs[0].model_in, 'echo-model');
});

test('/api/logs:条目只含白名单字段,键集与调用点的写入面逐字相等', async () => {
  const { logs } = JSON.parse((await ui('GET', '/api/logs')).text);
  for (const e of logs) assert.deepStrictEqual(keysOf(e), RUNTIME_FIELDS);
  // 下面这一条守的是:**白名单内**的字段被新的写入点写出来。运行时可观测的键集是常量,
  // 所以某个白名单内字段一旦被新写入点填上,键集就对不上,这条会红。
  // 它**抓不到**"写了白名单外的字段" —— 那种字段会被 pick() 静默丢弃,运行时看不见,
  // 由本文件末尾那条**源码级**断言负责,不要在这里假装守住了。
  for (const e of logs) for (const f of ['think', 'reasoning', 'tools_dropped']) assert.ok(!(f in e), f);
});

test('上游 401 回显渠道密钥:err 里的密钥在响应与磁盘上都被脱敏', async () => {
  mock.setSseWrappedError(401, `invalid x-api-key: ${SENT_ERR}`);
  const r = await ask('echo-model');
  assert.notStrictEqual(r.status, 200, '上游 401 应当失败');
  assert.ok(r.text.includes(SENT_ERR), '前提:客户端自己应当看到上游原文(脱敏只针对日志)');

  const resp = await ui('GET', '/api/logs');
  assert.ok(!resp.text.includes(SENT_ERR), '渠道密钥不得出现在 /api/logs');
  const onDisk = fs.readFileSync(LOG_FILE, 'utf8');
  assert.ok(!onDisk.includes(SENT_ERR), '渠道密钥不得落盘');
  assert.ok(onDisk.includes('[redacted]'), '脱敏应留下痕迹,而不是把整条 err 丢掉');
  const failed = JSON.parse(resp.text).logs.find(e => e.err);
  assert.ok(failed && failed.err.includes('[redacted]'), 'err 字段应就地脱敏');
  assert.ok(!failed.err.includes(SENT_ERR));
});

test('非在用的渠道密钥也必须脱敏(secrets 取的是全量清单,不是当前渠道)', async () => {
  // 真实泄漏路径:请求模型名被路由改写成 SENT_MODEL(p-multi 的密钥),落进 entry.model_out。
  // p-multi 没有任何规则指向它,所以"按当前渠道取密钥"的实现拿不到这把 key —— 只有
  // "遍历全部渠道全部密钥"这一层能挡住它。
  const r = await ask('leaky-model');
  assert.strictEqual(r.status, 200);
  const resp = await ui('GET', '/api/logs?limit=1');
  assert.ok(!resp.text.includes(SENT_MODEL), '不在用渠道的密钥也不得出现在 /api/logs');
  const onDisk = fs.readFileSync(LOG_FILE, 'utf8');
  assert.ok(!onDisk.includes(SENT_MODEL), '不在用渠道的密钥也不得落盘');
  // 前提:这条条目确实把改写后的模型名写进了 model_out(否则本用例是空转,测不到脱敏)
  const e = JSON.parse(resp.text).logs[0];
  assert.strictEqual(e.rule, 'r-leak');
  assert.strictEqual(e.model_out, '[redacted]', 'model_out 应是被脱敏后的值');
});

test('全部既有端点在接线后仍返回原形状(回归闸门)', async () => {
  const stats = JSON.parse((await ui('GET', '/api/stats')).text);
  assert.deepStrictEqual(keysOf(stats),
    ['by_app', 'by_model', 'by_provider', 'by_slot', 'cache', 'inTok', 'ok', 'ok_rate', 'outTok', 'range', 'reqs', 'scope']);
  const all = JSON.parse((await ui('GET', '/api/logs?limit=500')).text);
  assert.strictEqual(stats.reqs, all.logs.length, '统计总数须与全量日志一致');
  assert.strictEqual(stats.scope.source, 'memory');
  assert.strictEqual(stats.scope.timezone, 'UTC');
  assert.strictEqual(stats.by_slot.none.reqs, stats.reqs);
  assert.deepStrictEqual(keysOf(stats.by_slot.none), ['cache', 'in', 'out', 'reqs']);
  const state = JSON.parse((await ui('GET', '/api/state')).text);
  assert.deepStrictEqual(keysOf(state.stats), ['inTok', 'outTok', 'reqs']);
  assert.strictEqual(state.stats.reqs, stats.reqs);
  assert.ok(Object.hasOwn(state, 'providers') && Object.hasOwn(state, 'slots'));
});

test('/api/logs:limit 边界按修正后的语义(0/负数/非数/超大)', async () => {
  // 灌到 250 条:超过默认 200,才能把"默认 200"与"全量"区分开。
  // 用真代理请求而不是后门:写侧与读侧都必须是生产路径。
  // 入口拒绝的日志另由 test/proxy-route-errors.test.js 验证,这里仍用成功请求灌数据。
  const before = JSON.parse((await ui('GET', '/api/logs?limit=500')).text).logs.length;
  for (let i = before; i < 250; i++) {
    const r = await ask('echo-model');
    assert.strictEqual(r.status, 200, '灌数据用的请求必须成功');
  }
  const n = async qs => JSON.parse((await ui('GET', '/api/logs' + qs)).text).logs.length;
  assert.strictEqual(await n('?limit=500'), 250, '前提:ring 里正好 250 条');
  assert.strictEqual(await n('?limit=0'), 0, 'limit=0 不得返回全量');
  assert.strictEqual(await n('?limit=-5'), 0, '负数不得丢掉最旧 N 条');
  assert.strictEqual(await n('?limit=abc'), 200, '非数回默认 200,不得返回全量');
  assert.strictEqual(await n('?limit=1'), 1, 'limit 必须真的生效(URLSearchParams 不能直接透传)');
  assert.strictEqual(await n(''), 200);
});

test('落盘文件权限被收紧到 0600(接线前是跟随 umask 的 0644)', async () => {
  assert.strictEqual(fs.statSync(LOG_FILE).mode & 0o777, 0o600);
});

test('GET /api/metrics:Prometheus 文本、标签有界、不含密钥', async () => {
  const r = await ui('GET', '/api/metrics');
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers['content-type'].startsWith('text/plain; version=0.0.4'));
  assert.match(r.text, /^# HELP mixrouter_requests_total /m);
  assert.match(r.text, /^# TYPE mixrouter_requests_total counter$/m);
  assert.match(r.text, /^# TYPE mixrouter_log_window gauge$/m);
  assert.match(r.text, /^# TYPE mixrouter_request_duration_ms gauge$/m);
  // 标签基数必须**有界**:provider/model/session/err 这些高基数字段一个都不许进 label
  const labels = [...r.text.matchAll(/\{([^}]*)\}/g)].map(m => m[1]).join(',');
  for (const forbidden of ['provider=', 'model=', 'session=', 'err=', 'key='])
    assert.ok(!labels.includes(forbidden), `标签里不得出现 ${forbidden}`);
  assert.ok(!r.text.includes(SENT_ERR) && !r.text.includes(SENT_MODEL));
});

// ---------------------------------------------------------------- 源码级契约
// 为什么要有这一节:上面的 /api/logs 断言**只看得见白名单内的字段**。mixrouter.js 一旦写出
// 白名单外的字段,pick() 会把它静默丢掉 —— 运行时两边都看不见它(响应里没有,磁盘上也没有),
// 只有读源码才能发现"写了却记不下来"。这条断言就是为它而设的。
//
// 断言 并集(entry.X 赋值 ∪ entry['X'] 赋值 ∪ 构造字面量的键) ⊆ LOG_FIELDS。
// LOG_FIELDS 从 request-log.js **导出读**,不手抄 —— 手写常量会跟被测对象一起漂。
const { LOG_FIELDS } = require('../lib/observability/request-log');

// 去注释:**必须先剥再抽**,否则注释里出现的 `entry.xxx` 会被当成写入点。
// 这不是假想风险 —— mixrouter.js 里就有一处注释正文写着 `entry.status = cres.statusCode`
// (说明"以前 finishEntry() 的顺序让状态码记错"那段),纯注释、不是写入点。
// 所以本节的抽取口径**一律是去注释后的源码**。
//
// ⚠ 反证这条时有个坑,实测踩过:把 stripComments 换成恒等函数**并不一定变红**。
//   上面那处真实注释里的 `entry.status` 是**白名单内**的名字,恒等化后它只是让 sites 多出
//   一个已在白名单里的字段,`extra` 仍是空集 ⇒ 断言照样全绿(实测 identity → 0 红)。
//   要让它真的红,必须**恒等化 ＋ 注释里的假写点用白名单外的名字**(实测换成
//   `entry.interceptor_id` 后 identity → 1 红)。别把"恒等化就够"当成反证方法。
function stripComments(src) {
  let out = '', i = 0; const n = src.length; let str = null;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (str) { out += c; if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; } if (c === str) str = null; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; out += c; i++; continue; }
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}
// 从 `{` 处按花括号配对取出**第一层**的键(嵌套对象的键不算)
function literalKeys(code, openIdx) {
  const keys = []; let depth = 0, buf = '';
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i];
    if (c === '{' || c === '[' || c === '(') { depth++; if (depth === 1) continue; }
    else if (c === '}' || c === ']' || c === ')') { depth--; if (depth === 0) break; }
    if (depth === 1 && c === ':') {
      const tok = buf.trim().split(/[,\s]/).pop();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(tok)) keys.push(tok);
      buf = ''; continue;
    }
    if (depth >= 1) buf += c;
  }
  return keys;
}
// 第二期把 `const entry = {` 的构造点从 mixrouter.js 搬到了 lib/http/proxy.js(代理入口编排),
// 字段写入点则分散在 lib/proxy/*.js 与主入口的终态注入里。源码级抽取必须跟着走 —— 否则
// 锚点失效会让这两条用例既测不到越界字段、也测不到死字段,却看起来"通过/失败得很合理"。
//
// 文件清单已抽到 test/proxy-sources.js(与 test/request-log.test.js 共用同一份)——
// 两份手写清单会分叉,而漏掉一个参与 entry 生命周期的文件就是最坏的假绿。
function entrySource() {
  return proxySource();
}
function entryWriteFields(src) {
  const code = stripComments(src);
  const sites = new Map();
  const add = (f, where) => { if (!sites.has(f)) sites.set(f, []); sites.get(f).push(where); };
  for (const m of code.matchAll(/\bentry\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=(?!=)/g)) add(m[1], `entry.${m[1]}=`);
  for (const m of code.matchAll(/\bentry\[\s*['"]([A-Za-z_$][A-Za-z0-9_$]*)['"]\s*\]\s*=(?!=)/g)) add(m[1], `entry['${m[1]}']=`);
  const decl = /\b(?:const|let|var)\s+entry\s*=\s*\{/.exec(code);
  assert.ok(decl, '在 mixrouter.js 里找不到 `const entry = {` 构造点 —— 抽取器锚点失效,不是"没有越界字段"');
  for (const k of literalKeys(code, decl.index + decl[0].length - 1)) add(k, `字面量键 ${k}`);
  return sites;
}

test('源码级:代理写出的日志字段全部在 LOG_FIELDS 内(白名单外会被静默丢弃)', () => {
  const src = entrySource();
  const sites = entryWriteFields(src);
  assert.ok(sites.size >= 20, `抽取器只抽到 ${sites.size} 个字段,锚点可能失效`);
  const extra = [...sites.keys()].filter(f => !LOG_FIELDS.includes(f));
  assert.deepStrictEqual(extra, [],
    `代理写了白名单外的日志字段,它们会被 pick() 静默丢弃(响应与磁盘都看不见):\n` +
    extra.map(f => `  ${f}  ← ${sites.get(f).join(', ')}`).join('\n'));
});

test('源码级:白名单里的每个字段都确有写入点(死字段会让下游恒 undefined)', () => {
  const src = entrySource();
  const unused = LOG_FIELDS.filter(f => !entryWriteFields(src).has(f));
  assert.deepStrictEqual(unused, [], `白名单里这些字段在代理源码里没有任何写入点:${unused.join(', ')}`);
});

// 清单漏文件的守卫。上面两条用例只扫 PROXY_SOURCES 里列出的文件,所以**一个参与 entry
// 生命周期、却没被列进清单的文件,它写出的字段既测不到越界也测不到死字段,而用例照样全绿**
// —— 这是最坏的一种假绿。实测漏过一个:lib/wire-anthropic-translator.js 从 ctx 解构 entry
// 后直接写 entry.err/err_class/status 再 finishEntry(),原先不在任何清单里。
// 这里按特征(path.join(__dirname,'..') 之外,凡出现 ctx 解构 entry / ctx.entry / finishEntry)
// 反查全仓,要求它们**全部**已在清单内;新增写入点忘了登记会在这里报红,而不是静默漏掉。
test('源码级:参与 entry 生命周期的文件都已列进 PROXY_SOURCES(漏文件=静默漏字段)', () => {
  const root = path.join(__dirname, '..');
  const listed = new Set(PROXY_SOURCES.map(rel => path.resolve(root, rel)));
  const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(rel);
    return entry.isFile() && entry.name.endsWith('.js') ? [rel] : [];
  });
  // 判据:从 ctx 拿到 entry,或显式写 ctx.entry,或调用 finishEntry —— 三者只认**去注释后**的代码,
  // 免得被注释里的举例(如 err-text.js 顶部的说明)误报。
  const participates = rel => {
    const code = stripComments(fs.readFileSync(path.join(root, rel), 'utf8'));
    return /\}\s*=\s*ctx\b/.test(code) && /\bentry\b/.test(code)
      || /\bctx\.entry\b/.test(code)
      || /\bfinishEntry\s*\(/.test(code);
  };
  const missing = ['mixrouter.js', ...walk('lib')].filter(rel => participates(rel) && !listed.has(path.resolve(root, rel)));
  assert.deepStrictEqual(missing, [],
    `这些文件参与 entry 生命周期却没列进 PROXY_SOURCES,它们写的日志字段会被源码级用例静默漏掉:\n` +
    missing.map(f => `  ${f}`).join('\n') + `\n(若确认与请求日志无关,请在该文件或 test/proxy-sources.js 里写明理由)`);
});


test('HTTP history pagination retains initial snapshot and stats counts disk scope', async () => {
  const expected = JSON.parse((await ui('GET', '/api/logs?history=1&limit=1000')).text).logs;
  let page = JSON.parse((await ui('GET', '/api/logs?history=1&limit=37')).text);
  assert.strictEqual(page.logs.length, 37);
  assert.strictEqual(page.scope.source, 'history');
  assert.strictEqual(page.scope.order, 'append-desc');
  assert.ok(page.next_cursor);
  const snapshotAt = page.scope.snapshot_at;
  const all = [...page.logs];
  await ask('echo-model');
  while (page.next_cursor) {
    const response = await ui('GET', '/api/logs?' + new URLSearchParams({ cursor: page.next_cursor, limit: '37' }));
    assert.strictEqual(response.status, 200);
    page = JSON.parse(response.text);
    assert.strictEqual(page.scope.snapshot_at, snapshotAt);
    all.push(...page.logs);
  }
  assert.deepStrictEqual(all, expected, 'concurrent later request must not enter initial snapshot');
  const stats = JSON.parse((await ui('GET', '/api/stats?history=1')).text);
  assert.strictEqual(stats.reqs, expected.length + 1);
  assert.strictEqual(stats.scope.source, 'history');
  assert.strictEqual(stats.scope.timezone, 'UTC');
  assert.strictEqual(stats.by_slot.none.reqs, stats.reqs);
  assert.strictEqual(stats.by_slot.none.in, stats.inTok);
  assert.strictEqual(stats.by_slot.none.out, stats.outTok);
  assert.strictEqual(stats.by_slot.none.cache, stats.cache);
  const at = expected[0].ts;
  const query = new URLSearchParams({ history: '1', since: at, until: at, limit: '1000' });
  const filtered = JSON.parse((await ui('GET', '/api/logs?' + query)).text);
  assert.ok(filtered.logs.length > 0);
  assert.ok(filtered.logs.every(e => e.ts === at));
  const summary = JSON.parse((await ui('GET', '/api/stats?' + query)).text);
  assert.strictEqual(summary.reqs, filtered.logs.length);
  assert.ok(!JSON.stringify(filtered).includes(SENT_ERR));
  assert.ok(!JSON.stringify(filtered).includes(SENT_MODEL));
});

test('HTTP cursor errors have explicit status and machine-readable codes', async () => {
  const invalid = await ui('GET', '/api/logs?cursor=invalid');
  assert.strictEqual(invalid.status, 400);
  assert.strictEqual(JSON.parse(invalid.text).code, 'CURSOR_INVALID');
  const summary = await ui('GET', '/api/stats?history=1&cursor=invalid');
  assert.strictEqual(summary.status, 400);
  assert.strictEqual(JSON.parse(summary.text).code, 'CURSOR_INVALID');
  const page = JSON.parse((await ui('GET', '/api/logs?history=1&limit=1')).text);
  assert.ok(page.next_cursor);
  const moved = LOG_FILE + '.test-held';
  fs.renameSync(LOG_FILE, moved);
  try {
    const expired = await ui('GET', '/api/logs?' + new URLSearchParams({ cursor: page.next_cursor }));
    assert.strictEqual(expired.status, 410);
    assert.strictEqual(JSON.parse(expired.text).code, 'CURSOR_EXPIRED');
  } finally { fs.renameSync(moved, LOG_FILE); }
});

test('real slot request records resolved slot and both stats scopes expose slot totals', async () => {
  assert.strictEqual((await ask('echo-model')).status, 200);
  const response = await ask('mixr-opus');
  assert.strictEqual(response.status, 200);
  const recent = JSON.parse((await ui('GET', '/api/logs?slot=opus')).text).logs;
  assert.strictEqual(recent.length, 1);
  assert.strictEqual(recent[0].slot, 'opus');
  assert.strictEqual(recent[0].model_in, 'mixr-opus');
  for (const suffix of ['', '?history=1']) {
    const stats = JSON.parse((await ui('GET', '/api/stats' + suffix)).text);
    assert.strictEqual(stats.by_slot.opus.reqs, 1);
    assert.strictEqual(stats.by_slot.none.reqs, stats.reqs - 1);
    assert.strictEqual(stats.by_slot.opus.in, recent[0].in);
    assert.strictEqual(stats.by_slot.opus.out, recent[0].out);
    assert.strictEqual(stats.by_slot.opus.cache, recent[0].cache_read);
  }
});
