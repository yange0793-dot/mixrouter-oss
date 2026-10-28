'use strict';
// J10 抽出的模块 + 一条**真起服务**的接线断言。
//
// 两类用例混在一个文件里是有意的:
//   1) 纯函数模块(http-body / proto-error / model-suffix / tomllib / respond / collect / err-text)
//      —— 直接 require 模块,测形状与边界。
//   2) **接线**用例 —— 起 mixrouter.js 的两个服务、打真实请求,证明 /api/logs?since= 真的通、
//      /api/providers 的 400 真的还是那个形状、槽位 PUT 真的把旧字段留在原地。
// 第 2 类不能只测模块:模块自己好用,而调用点一处都没接上,第 1 类照样全绿。
//
// 本文件**不**替代 test/log-wiring.test.js(它管日志白名单/脱敏的接线)。这里管的是
// "抽出来之后,原来那条路径的行为没变"。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 先把数据目录重定向到临时目录,再 require mixrouter —— DATA_DIR 是加载期常量。
//
// ⚠ MIXR_CLAUDE_SETTINGS / MIXR_CODEX_CONFIG 只管 mixrouter.js 自己那两个常量,**不管
// lib/backup/targets.js 的目标表** —— 那张表里的客户端配置路径是按 HOME 推的,不读这两个
// 环境变量。所以光设它们**不足以**说"这个测试碰不到真实配置":只要 HOME 仍是真实的,
// 表里就还是 ~/.claude/settings.json。当前 test/run-tests.js 会把 HOME 一并重定向到
// 临时目录(见它的 testEnv),单独 `node --test test/modules-wiring.test.js` 跑就没有这层保护。
//
// 本文件的对策是**结构性**的:这里从不调用任何写客户端配置的路径(四个 switch* 入口,
// 以及控制台的 switch / router / claude-split 三个写端点),
// 只用 /api/providers、/api/routes、/api/slots 与代理入口 —— 它们写的是 MIXR_DATA_DIR 下的
// 数据文件。下面这条断言把这条纪律钉住:一旦有人在本文件里新添一次客户端配置写入,
// 或者把备份目标表接进某个被本文件调用的端点,它就会红。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-j10-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXROUTER_PORT = '0';
process.env.MIXUI_PORT = '0';
// 重试间隔默认 1s:本文件测的是接线(日志/错误体形状),不是重试节奏。
// 打死端口和打 500 上游的用例都会被重试放大成十秒级的空等。
process.env.MIXR_RETRY_DELAY_MS = '0';

const bodyLib = require('../lib/http/body');
const respondLib = require('../lib/http/respond');
const protoErrorLib = require('../lib/http/proto-error');
const collectLib = require('../lib/upstream-collect');
const errTextLib = require('../lib/observability/err-text');
const suffixLib = require('../lib/model-suffix');
const tomlLib = require('../lib/toml');
const respond = respondLib;

// ---------------------------------------------------------------- 纯函数

test('http-body:深度守卫在越界那一层就返回 false,不整份走完', () => {
  const deep = (n) => '['.repeat(n) + '1' + ']'.repeat(n);
  assert.equal(bodyLib.jsonDepthOk(deep(bodyLib.MAX_JSON_DEPTH)), true, '正好到上限要放行');
  assert.equal(bodyLib.jsonDepthOk(deep(bodyLib.MAX_JSON_DEPTH + 1)), false, '超一层就要拦');
  // 字符串里的括号不能算结构:JSON 正文里带代码/正则时,深度守卫必须看得见引号
  assert.equal(bodyLib.jsonDepthOk(JSON.stringify({ code: '[[[[[[[[[[{' })), true);
  // 转义引号不能让状态机提前出串
  assert.equal(bodyLib.jsonDepthOk('{"a":"\\"[[[[{"}'), true);
});

test('http-body:parseJsonBody 把"深度越界"与"不是 JSON"分成两句话', () => {
  const invalid = m => Object.assign(new Error(m), { statusCode: 400 });
  const deep = '['.repeat(bodyLib.MAX_JSON_DEPTH + 2) + '1' + ']'.repeat(bodyLib.MAX_JSON_DEPTH + 2);
  assert.throws(() => bodyLib.parseJsonBody(deep, { proxy: true, invalid }), /嵌套层数超过 256 层/);
  assert.throws(() => bodyLib.parseJsonBody('{oops', { proxy: true, invalid }), /不是合法 JSON/);
  // 非对象:proxy 入口不开 isObject,调用点自己判;控制台入口必须判
  assert.throws(() => bodyLib.parseJsonBody('[1,2]', { invalid, isObject: v => v !== null && typeof v === 'object' && !Array.isArray(v) }),
    /必须是 JSON 对象/);
  assert.deepEqual(bodyLib.parseJsonBody('{"a":1}', { invalid }), { a: 1 });
});

test('http-body:readObject 空体按 {} 处理(空 ≠ 坏),超限则销毁请求', async () => {
  const fake = (chunks) => {
    const req = new (require('node:events').EventEmitter)();
    req.destroy = () => { req.destroyed = true; };
    setImmediate(() => { for (const c of chunks) req.emit('data', Buffer.from(c)); req.emit('end'); });
    return req;
  };
  assert.deepEqual(await bodyLib.readObject(fake(['']), { limit: 1000, invalid: m => new Error(m), isObject: () => true }), {},
    '空体必须被当成空对象,不是解析错误');
  const over = fake(['x'.repeat(50)]);
  await assert.rejects(() => bodyLib.readObject(over, { limit: 10, invalid: m => new Error(m), isObject: () => true }), /too large/);
  assert.equal(over.destroyed, true, '超限要销毁请求(控制台侧不排空)');
});

test('proto-error:两个端点的错误体形状各是各的(预览与实跑靠它对齐)', () => {
  const grab = () => {
    const out = {};
    return { res: { writeHead: (c, h) => Object.assign(out, { code: c, headers: h }), end: b => { out.body = b; return b; } }, out };
  };
  const a = grab(); protoErrorLib.protoError(a.res, 'claude', 503, 'provider_disabled_error', '停用了');
  assert.equal(a.out.code, 503);
  assert.equal(a.out.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(a.out.body), { type: 'error', error: { type: 'provider_disabled_error', message: '停用了' } });

  const o = grab(); protoErrorLib.protoError(o.res, 'codex', 400, 'invalid_request_error', '坏了');
  // OpenAI 形状:type 去掉 _error 后缀,code 保留全文 —— 落点与 anthropic 不同
  assert.deepEqual(JSON.parse(o.out.body), { error: { message: '坏了', type: 'invalid_request', code: 'invalid_request_error' } });
});

test('respond:sendJson 只写 Content-Type,不造 Content-Length(与原 send 逐字一致)', () => {
  const out = {};
  const res = { writeHead: (c, h) => Object.assign(out, { code: c, headers: h }), end: b => { out.body = b; return b; } };
  assert.equal(respond.sendJson(res, 200, { ok: true }), '{"ok":true}', '要能 return res.end 的值(调用点靠它 return)');
  assert.deepEqual(Object.keys(out.headers), ['Content-Type']);
  respond.sendError(res, 400, '不行');
  assert.equal(out.body, '{"error":"不行"}');
});

test('model-suffix:剥后缀 + 合并 beta 头;无后缀时不动 headers', () => {
  const h1 = {};
  assert.equal(suffixLib.applyModel('claude-opus-5', h1), 'claude-opus-5');
  assert.deepEqual(h1, {}, '无后缀不许动 headers');
  const h2 = { 'anthropic-beta': 'fine-grained-tool-streaming' };
  assert.equal(suffixLib.applyModel('Claude-Opus-5[1M]', h2), 'Claude-Opus-5');
  assert.equal(h2['anthropic-beta'], 'fine-grained-tool-streaming,context-1m-2025-08-07', '合并而不是覆盖');
  const h3 = { 'anthropic-beta': suffixLib.BETA_1M };
  suffixLib.applyModel('m[1m]', h3);
  assert.equal(h3['anthropic-beta'], suffixLib.BETA_1M, '已带过就不重复追加');
});

test('toml:codexTopLevel 只认第一个 [section] 之前的键,且容忍缩进', () => {
  const text = '  model = "a"\nmodel_provider = "b"\n[model_providers.x]\nmodel = "c"\n';
  assert.equal(tomlLib.codexTopLevel(text, 'model'), 'a', '带缩进的顶层键必须读得到');
  assert.equal(tomlLib.codexTopLevel(text, 'model_provider'), 'b');
  assert.equal(tomlLib.codexTopLevel('[s]\nmodel = "c"\n', 'model'), '', 'section 之后的同名键不算顶层');
  assert.equal(tomlLib.tomlStr('a"b\\c'), '"a\\"b\\\\c"');
});

// 一个够用的假上游响应:一个 EventEmitter,下一拍把给定的 chunk 依次发出来再 end。
// 不用真 http 请求:这里要测的是攒包形状,不是连接行为。
const fakeUpstream = (chunks) => {
  const r = new (require('node:events').EventEmitter)();
  setImmediate(() => { for (const c of chunks) r.emit('data', Buffer.from(c)); r.emit('end'); });
  return r;
};

test('collect:bufferText 收全;tailText 只留前 n 个 chunk(与探活原写法同口径)', async () => {
  let got = null;
  collectLib.bufferText(fakeUpstream(['ab', 'cd']), t => { got = t; });
  await new Promise(r => setImmediate(() => setImmediate(r)));
  assert.equal(got, 'abcd');

  let tail = null;
  collectLib.tailText(fakeUpstream(['1', '2', '3']), 2, t => { tail = t; });
  await new Promise(r => setImmediate(() => setImmediate(r)));
  assert.equal(tail, '12', '按 chunk 序号截,不是按总字节');
});

test('collect:bufferAndForward 边攒边写,客户端拿到的分块与上游一致', () => {
  const em = require('node:events');
  const r = new em.EventEmitter();
  const written = [];
  collectLib.bufferAndForward(r, { write: c => written.push(c.toString()) }, () => {});
  r.emit('data', Buffer.from('x')); r.emit('data', Buffer.from('y')); r.emit('end');
  assert.deepEqual(written, ['x', 'y'], '逐块透传,不许攒完再一次性写(流式直通靠这个)');
});

test('collect:headTailUsage 头尾都留 —— 流式 usage 在末尾,只留头部就会整条记成 0', async () => {
  // 回归:原实现是 `if (acc.length < 1024*1024) acc += ...`,只留**前** 1MB,
  // 而 Anthropic 的 usage 真值在流末尾的 message_delta。实测复现:1.54MB 的 SSE,
  // 上游明确报了 in=12345/out=6789,落盘却是两个 0。
  const run = (chunks, opts) => new Promise(res => {
    const r = new (require('node:events').EventEmitter)();
    const written = [];
    collectLib.headTailUsage(r, { write: c => written.push(c.toString()) }, text => res({ text, written }), opts);
    for (const c of chunks) r.emit('data', Buffer.from(c));
    r.emit('end');
  });
  const opts = { headBytes: 64, tailBytes: 64 };

  // usage 在**尾部**、总长超过两段上限:这是原先必丢的形状
  const big = ':' + 'x'.repeat(498) + '\n';
  assert.ok((await run([big, '{"usage":{"in":999}}\n'], opts)).text.includes('"in":999'),
    '尾部完整行的 usage 必须抠得到(原先只留头部,这里会丢)');
  // usage 在**头部**也要在(Anthropic 的 message_start 就有,虽然是 0)
  assert.ok((await run(['{"usage":{"in":7}}\n', big], opts)).text.includes('"in":7'), '头部完整行的 usage 也要在');
  // 透传必须原样、逐块:攒样不得改变写出去的形状
  assert.deepEqual((await run(['aa', 'bb', 'cc'], opts)).written, ['aa', 'bb', 'cc'], '逐块原样透传');
  // 多字节字符横跨 chunk:逐块 toString 会在边界切出替换字符
  const s = '你好世界'.repeat(20);
  const buf = Buffer.from(s, 'utf8');
  const half = Math.floor(buf.length / 2);
  assert.equal((await run([buf.subarray(0, half + 1), buf.subarray(half + 1)],
    { headBytes: 4096, tailBytes: 4096 })).text, s, '跨 chunk 的多字节字符不得被切坏');
  // 内存有界:超大流攒样不超过两段上限之和
  const huge = Array.from({ length: 50 }, () => 'y'.repeat(100000));
  const got = await run(huge, opts);
  assert.ok(got.text.length <= 64 + 64 + 2, `攒样 ${got.text.length} 字符,超出两段上限 —— 内存不有界`);
});

test('err-text:两种写法各自与原来那两处字面量逐字同值', () => {
  // 关键点:这两种写法**不等价**,所以模块两种都留。合并成一种会改变落盘内容。
  assert.equal(errTextLib.errLine(200, 'hello'), 'HTTP 200: hello');
  assert.equal(errTextLib.errLineOrPlaceholder(200, 'hello'), 'HTTP 200: hello', '非空正文:两种写法给出同一句');
  assert.equal(errTextLib.errLine(200, ''), 'HTTP 200: ', '纯截断版:冒号后就空着(与原字面量一致)');
  assert.equal(errTextLib.errLineOrPlaceholder(200, ''), 'HTTP 200: (空响应体)', '占位版:空体要写占位');
  assert.equal(errTextLib.errLine(200, '   '), 'HTTP 200:    ', '纯截断版不 trim');
  assert.equal(errTextLib.errLineOrPlaceholder(200, '   '), 'HTTP 200: (空响应体)', '占位版先 trim 再判空');
  // 已 trim 且非空的正文:两版同值(trim 是幂等的)
  assert.equal(errTextLib.errBodyText('  配额池已耗尽  '), '配额池已耗尽');
  assert.equal(errTextLib.clip('x'.repeat(500)).length, 400, '截断到 400');
  assert.equal(errTextLib.errBodyText('x'.repeat(500)).length, 400);
  // 上游 500 那条用例的三个子串必须原样留在结果里
  const upstream = JSON.stringify({ error: { message: 'quota exhausted trace_id=zzz' } });
  const why = errTextLib.errBodyText(upstream);
  assert.ok(why.includes('trace_id=zzz'));
});

test('err-text:空值走占位分支,而不是字符串化的 "undefined"/"null"', () => {
  // 这条是**回归**用例,对应一次实测缺陷:`String(x)` 之后直接跟 `.trim() || 占位`,
  // 对 undefined/null 会得到字符串 'undefined'/'null' —— 它们是**真值**,`||` 后面的
  // 占位被跳过,兜底形同虚设。修复前实测:errBodyText(undefined) === 'undefined'(红)。
  //
  // 期望值全部写成**独立字面量**,不从模块里取(拿被测函数当自己的期望等于恒绿)。
  const PLACEHOLDER = '(空响应体)';
  assert.equal(errTextLib.errBodyText(undefined), PLACEHOLDER, 'undefined 是"上游没给正文",不是正文 "undefined"');
  assert.equal(errTextLib.errBodyText(null), PLACEHOLDER);
  assert.equal(errTextLib.errBodyText(''), PLACEHOLDER, '空串本来就是占位分支,一并钉住');
  assert.equal(errTextLib.errLineOrPlaceholder(502, undefined), `HTTP 502: ${PLACEHOLDER}`);
  assert.equal(errTextLib.errLineOrPlaceholder(502, null), `HTTP 502: ${PLACEHOLDER}`);
  // 纯截断那版**不兜底**(它与原字面量逐字一致,空就是空):这里只要求它别把 undefined 漏成
  // 中间带空白的句子,即归一成空 —— 但**不许**冒出占位符(那会改变落盘内容)。
  assert.equal(errTextLib.errLine(502, ''), 'HTTP 502: ', '纯截断版:冒号后就是空的');
  assert.equal(errTextLib.errLine(502, undefined), 'HTTP 502: ', '空值同样归一成空体,但不加占位');
  // 反证方向:确保上面几条不是因为我顺手把两个变体都改了而"看起来对"
  assert.equal(errTextLib.errBodyText('  x  '), 'x', '非空正文两版仍有 trim 差异,没被合并');
});

test('codex-toml:顶层键原位替换、没有才插最前;自己的 section 删干净,别人的不碰', () => {
  const codexToml = require('../lib/codex-toml');
  const kept = codexToml.removeOwnSections([
    'model = "keep-me"',
    '[model_providers.mixr-old]',
    'name = "旧"',
    '[model_providers.user]',
    'name = "用户的"',
  ].join('\n'));
  assert.deepEqual(kept, ['model = "keep-me"', '[model_providers.user]', 'name = "用户的"'],
    '只删自己写的 section,用户自己的 section 与它的正文都要在');

  const r = codexToml.setTopLevel(kept, { section: 'mixr-new', model: 'gpt-5.1', keepModel: false });
  // kept 里已经有顶层 model → 原位替换,不新增;model_provider 原本没有 → 补到最前。
  // 所以顺序是"补的那条在前、被替换的那条留在原位",与 writeCodexConfig 的 head.concat(out) 一致。
  assert.deepEqual(r.lines, ['model_provider = "mixr-new"', 'model = "gpt-5.1"', '[model_providers.user]', 'name = "用户的"']);
  assert.equal(r.hasModel, true);

  // 空文件:两个顶层键都要补
  const empty = codexToml.setTopLevel([], { section: 's', model: 'm', keepModel: true });
  assert.deepEqual(empty.lines, ['model = "m"', 'model_provider = "s"']);

  // keepModel:路由模式不许改顶层模型名(被替换的那条留在原位,补的那条在前面)
  const keep = codexToml.setTopLevel(['model = "原样"', '[x]'], { section: 's', model: '别的', keepModel: true });
  assert.deepEqual(keep.lines, ['model_provider = "s"', 'model = "原样"', '[x]'],
    'keepModel 时顶层 model 必须保持原值,不许被路由模式的入参覆盖');
});

test('config-backup:名字保"定长前缀在前",保留池按字典序删最旧(与 inventory 同规则)', () => {
  const { backupFile, backupNameFor, DEFAULT_KEEP } = require('../lib/config-backup');
  assert.equal(DEFAULT_KEEP, 5);
  const n1 = backupNameFor('/x/settings.json', new Date(2026, 5, 1, 12, 0, 0, 7), 'aabb');
  const n2 = backupNameFor('/x/settings.json', new Date(2026, 5, 1, 12, 0, 0, 99), 'aabb');
  assert.ok(n1 < n2, `毫秒必须补到定长,否则字典序≠时间序: ${n1} vs ${n2}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-bak-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'live');
  try {
    for (let i = 0; i < 7; i++) backupFile(file, { name: backupNameFor(file, new Date(2026, 5, 1, 0, 0, i, 0), 'zzzz') });
    const left = fs.readdirSync(dir).filter(f => f.includes('.bak-mixui-')).sort();
    assert.equal(left.length, 5, '保留池要收敛到 5 份');
    // 被删的是**字典序最前**那一批:名字里的秒位从 0 数到 6,留下的应当是第 3~7 份
    assert.ok(!left.some(f => /-000000-/.test(f)), `只留 5 份时最早的(00:00:00)必须先被删:${left.join(' ')}`);
    assert.ok(left.some(f => /-000006-/.test(f)), '最新那一份必须还在');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('provider-test:未配置 API Key 时不发请求,直接如实报缺什么', async () => {
  const { testProvider } = require('../lib/provider-test');
  assert.deepEqual(await testProvider({ base_url: 'http://127.0.0.1:1', api_key: '' }), { ok: false, error: '未配置 API Key' });
});

// mixctl 的两个 CLI 模块不能在**本进程**里 require 进 mixrouter 侧的东西,但它们本身是纯的。
// 这里直接 require 模块本身,并把「用法串覆盖了每一个子命令」这件事钉住 ——
// 顶层总览漏掉一段,那个子命令就等于没有文档,而它不会让任何一条别的用例变红。
test('cli-usage:顶层总览收录了每一段用法,子命令名一个不缺', () => {
  const usage = require('../lib/cli/usage');
  for (const [name, s] of Object.entries(usage)) {
    assert.ok(typeof s === 'string' && s.length > 0, `${name} 不能是空串`);
  }
  // 顶层总览**逐字收录** EXPLAIN_USAGE 与 BACKUPS_USAGE(它们本来就是两行以上的整段)。
  // SPLIT_USAGE / ROUTE_USAGE 是**单行简写**:总览里那一行写的是它们的要点
  // (`split <主渠道ID> <主模型> …` / `route <claude|codex|zcode> [anthropic|responses|chat] [--slots]`),
  // 不是整段原文 —— 这是搬运前的原样,不为"整齐"去改用户可见的输出。所以这里只断言
  // **子命令名**必须出现,不断言逐字包含。
  assert.ok(usage.MAIN_USAGE.includes(usage.EXPLAIN_USAGE), '顶层总览必须逐字收录 EXPLAIN_USAGE');
  assert.ok(usage.MAIN_USAGE.includes(usage.BACKUPS_USAGE), '顶层总览必须逐字收录 BACKUPS_USAGE');
  // 分发器认得的每个子命令都要在总览里出现(mixctl 末尾那个 if/else 链的真值)
  for (const cmd of ['start', 'stop', 'restart', 'status', 'ls', 'sessions', 'slots', 'split', 'backups', 'logs', 'route', 'open'])
    assert.ok(usage.MAIN_USAGE.includes(cmd), `顶层总览漏了子命令 ${cmd}`);
  // 每段用法串各自要点到自己的子命令名
  assert.ok(usage.SPLIT_USAGE.includes('split'));
  assert.ok(usage.ROUTE_USAGE.includes('route'));
  assert.ok(usage.EXPLAIN_USAGE.includes('explain'));
  assert.ok(usage.BACKUPS_USAGE.includes('backups'));
});

test('cli-backup-view:摊平形状与端点共有字段同名同义,且只读(不碰 providers.json)', () => {
  const bv = require('../lib/cli/backup-view');
  assert.equal(bv.BACKUPS_KEEP, require('../lib/config-backup').DEFAULT_KEEP,
    'keep 必须与真实备份逻辑同值,否则 /api/backups 与 mixctl 会各报一个数');
  assert.equal(bv.matchesBase({ file: '/x/settings.json' }, 'settings.json'), true, '按基名匹配');
  assert.equal(bv.matchesBase({ file: '/x/settings.json' }, ''), true, '空串 = 没给,不是匹配所有');
  assert.equal(bv.matchesBase({ file: '/x/settings.json' }, 'config.toml'), false);
  // 目录不存在不是错误,是"查过、没有":要带着 ENOENT 进结果,不能抛也不能静默跳过
  const gone = bv.scanLocation({ id: 'claude', label: 'Claude Code', file: '/nope/settings.json', dir: '/nope' });
  assert.equal(gone.ok, false);
  assert.ok(gone.error && typeof gone.error.code === 'string', '失败要带原因码');
  assert.deepEqual(gone.backups, []);
  assert.equal(bv.shortSha('abcdef0123456789'), 'abcdef012345');
  assert.equal(bv.shortSha(null), '-');
  assert.equal(bv.sizeOf(2048), '2.0 KiB');
  // 差异条目的单元格是信封形状,打印的必须是里面的值
  assert.equal(bv.cellText({ value: 'v', redacted: true, reason: 'x' }), '"v"');
  assert.equal(bv.cellText('裸值'), '"裸值"');
});

// ---------------------------------------------------------------- 接线(真起服务)

let mod, uiSrv, uiPort, proxySrv, proxyPort;
const raw = (port, method, p, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request({ hostname: '127.0.0.1', port, method, path: p,
    headers: { host: `127.0.0.1:${port}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } },
    res => { const cs = []; res.on('data', c => cs.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(cs).toString('utf8') })); });
  r.on('error', reject); if (data) r.write(data); r.end();
});

// 死端口(1 号口不会有东西监听):请求打上去必然 ECONNREFUSED,但**必然产生一条请求日志**。
// 用它来造日志条目,比引 mock 上游少一层;同样不出网、不起子进程、不碰现役进程。
const DEAD = 'http://127.0.0.1:1';

test('setup:起控制台与代理两个服务;渠道指向死端口(只为造日志,不出网)', async () => {
  fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({
    version: 2, current: { claude: null, codex: null },
    claude: [{ id: 'p-dead', name: '死端口渠道', base_url: DEAD, api_key: 'sk-dead', enabled: true, models: ['j10-model'] }],
    codex: [],
  }));
  mod = require('../mixrouter.js');
  uiSrv = await mod.listen(0, mod.apiHandler);
  uiPort = uiSrv.address().port;
  uiSrv.unref();
  proxySrv = await mod.listen(0, mod.proxyHandler);
  proxyPort = proxySrv.address().port;
  proxySrv.unref();
  assert.ok(uiPort > 0 && proxyPort > 0);
});

test('接线:/api/logs 的 since 过滤真的生效', async () => {
  // 先造一条**真**条目:经代理路径打一条到死端口的请求,它会走 finalize → requestLog.append。
  const asked = await raw(proxyPort, 'POST', '/v1/messages',
    { model: 'j10-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(asked.status, 502, `死端口应当如实报 502:${asked.text.slice(0, 200)}`);
  const all = JSON.parse((await raw(uiPort, 'GET', '/api/logs')).text).logs;
  assert.ok(all.length >= 1, '代理路径必须留下日志条目,否则下面的差分没有鉴别力');
  assert.equal(all[0].model_in, 'j10-model');

  // 差分:未来时刻 → 空;过去时刻 → 与不传 since 逐条相同。
  // since 没接线时它只是一个被忽略的未知参数,两个读数都会等于 all —— 这条就会红。
  const future = encodeURIComponent(new Date(Date.now() + 3600_000).toISOString());
  const past = encodeURIComponent(new Date(Date.now() - 3600_000).toISOString());
  const after = JSON.parse((await raw(uiPort, 'GET', `/api/logs?since=${future}`)).text).logs;
  const before = JSON.parse((await raw(uiPort, 'GET', `/api/logs?since=${past}`)).text).logs;
  assert.deepEqual(after, [], 'since 在未来:现有条目全部落在窗口之外');
  assert.deepEqual(before, all, 'since 在一小时前:现有条目一条不少');
  // epoch 毫秒写法也必须认(parseSince 两种都收)
  const ms = JSON.parse((await raw(uiPort, 'GET', `/api/logs?since=${Date.now() + 3600_000}`)).text).logs;
  assert.deepEqual(ms, [], 'since 也接受 epoch 毫秒');
});

test('接线:控制台 400 的错误体仍是 { error: "…" }(sendErr 与手写 writeHead 同形状)', async () => {
  const r = await raw(uiPort, 'POST', '/api/providers', { app: 'nope' });
  assert.equal(r.status, 400);
  assert.deepEqual(JSON.parse(r.text), { error: '渠道 app 必须是 claude 或 codex' });
});

test('接线:发送畸形请求体仍得到 400 与那两句话(深度守卫搬走后没变)', async () => {
  const deep = '{"a":' + '['.repeat(bodyLib.MAX_JSON_DEPTH + 2) + '1' + ']'.repeat(bodyLib.MAX_JSON_DEPTH + 2) + '}';
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: uiPort, method: 'POST', path: '/api/compact',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(deep) } },
      res => { const cs = []; res.on('data', c => cs.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(cs).toString('utf8') })); });
    req.on('error', reject); req.end(deep);
  });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.text).error, /嵌套层数超过 256 层/);
});

test('接线:PUT /api/routes 固定 410,不落盘也不改内存', async () => {
  const before = JSON.stringify(mod._state.routes);
  const r = await raw(uiPort, 'PUT', '/api/routes', { rules: [], default: {} });
  assert.equal(r.status, 410);
  assert.equal(JSON.stringify(mod._state.routes), before);
});

test('接线:槽位 PUT 是**部分更新** —— 没带 dropTools 时旧值必须留在原地', async () => {
  const put = (body) => raw(uiPort, 'PUT', '/api/slots', body);
  const first = await put({ claude: { main: { provider: 'p1', model: 'm1', dropTools: ['Bash'] } } });
  assert.equal(first.status, 400, '渠道不存在就该被拦(证明校验还在)');
  // 用一个真渠道:先建一个
  const created = await raw(uiPort, 'POST', '/api/providers', { name: '接线渠道', base_url: 'https://x.example.com', api_key: 'sk-x' });
  const id = JSON.parse(created.text).id;
  assert.ok(id, created.text);
  await put({ claude: { main: { provider: id, model: 'm1', dropTools: ['Bash'] } } });
  const s1 = JSON.parse((await raw(uiPort, 'GET', '/api/slots')).text).slots.claude.find(x => x.name === 'main');
  assert.deepEqual(s1.dropTools, ['Bash'], '第一次写入的 dropTools 应当落库');
  // 第二轮只改 model:dropTools 不在 body 里 → 必须原样保留
  await put({ claude: { main: { provider: id, model: 'm2' } } });
  const s2 = JSON.parse((await raw(uiPort, 'GET', '/api/slots')).text).slots.claude.find(x => x.name === 'main');
  assert.equal(s2.model, 'm2', 'model 这一轮要更新');
  assert.deepEqual(s2.dropTools, ['Bash'], '这一轮没带 dropTools,旧值不许被抹掉');
});

test('接线:chat 上游的错误正文翻给客户端时是**纯截断**,与原实现逐字一致', async () => {
  // 这条是**回归**用例,对应一次实测缺陷:原实现里 chat/responses 错误体那两处的**客户端**
  // message 是 `String(msg).slice(0,400)`(纯截断),而日志 entry.err 才是有区别的两种写法。
  // 抽出模块时把客户端那处也换成了带 trim+占位的版本 —— 上游回 `"  padded  "` 时,
  // 客户端收到的 message 会从 `"  padded  "` 变成 `"padded"`,回空体会从 `""` 变成 `"(空响应体)"`。
  // 这是**改语义**,不是搬。测试模块本身发现不了它:调用点换错了函数,模块单测照样全绿,
  // 所以必须起真服务、经真实分支打一次。
  //
  // 判据是**独立字面量**:期望值直接写死在这里,不从 lib/observability/err-text 取
  // (拿被测函数当自己的期望 = 恒绿)。
  const upstreamBody = '{"error":{"message":"  padded  "}}';   // 首尾各两个空格,trim 版会切掉
  const upstream = http.createServer((req, r) => {
    r.writeHead(500, { 'Content-Type': 'application/json' });
    r.end(upstreamBody);
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  try {
    // claude 渠道标 wire_api:'chat' → 客户端 /v1/messages 走"现场翻译"分支(就是那两处所在的分支)
    const created = await raw(uiPort, 'POST', '/api/providers',
      { name: 'chat 上游', base_url: `http://127.0.0.1:${upPort}`, api_key: 'sk-x', wire_api: 'chat', models: ['j10-chat'] });
    const pid = JSON.parse(created.text).id;
    assert.ok(pid, `建渠道失败:${created.text}`);
    // 精确登记模型即落点:无需再写通用规则(PUT /api/routes 已固定 410)
    const model = JSON.parse((await raw(uiPort, 'GET', '/api/state')).text)
      .providers.claude.find(p => p.id === pid).models[0];
    assert.equal(model, 'j10-chat');
    // 非流式,避免摊 SSE;这条路径与流式共用同一个错误分支
    const got = await raw(proxyPort, 'POST', '/v1/messages',
      { model: 'j10-chat', max_tokens: 8, stream: false, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(got.status, 500, `上游 500 应当如实翻给客户端:${got.text.slice(0, 200)}`);
    const body = JSON.parse(got.text);
    // 独立字面量:上游正文首尾各两个空格 + 三个空格 —— 纯截断原样带出,带 trim 的会被切掉
    assert.equal(body.error.message, '  padded  ', '客户端 message 必须原样带出上游正文(纯截断,不 trim)');
    assert.equal(body.error.type, 'api_error');
    // 同一分支的日志那边是**另一种**写法(带占位):这条钉住"两种写法没有在抽取时被合并"
    const logs = JSON.parse((await raw(uiPort, 'GET', '/api/logs')).text).logs;
    assert.equal(logs[0].err, 'HTTP 500:   padded  ', '日志 entry.err 走纯截断版,不 trim');
  } finally { upstream.close(); }
});

test('接线:导出面保留转发/槽位/压缩入口,harness 与 zcode 入口已消失', () => {
  for (const name of ['resolveRoute', 'explainRoute', 'resolveSlot', 'slotsPublic', 'pickMember',
    'classifyProxyRequest', 'wireOf', 'updateCodexConfig', 'bodyRouteText'])
    assert.equal(typeof mod[name], 'function', `导出面缺 ${name}`);
  // 已删除的接入面:不留半截入口(留一个空函数比直接没有更难发现)
  for (const name of ['resolveHarness', 'switchZcode', 'zcodeSpec', 'zcodeRouterSpec', 'liveZcodeState'])
    assert.equal(mod[name], undefined, `${name} 应当随瘦身一起删除`);
});

test('本文件不许出现任何写客户端配置的路径(结构性保证不碰 ~/.claude 与 ~/.codex)', () => {
  // 见文件头的长注释:MIXR_CLAUDE_SETTINGS 只管 mixrouter.js 的常量,管不到
  // lib/backup/targets.js 里按 HOME 推出来的目标表。单独跑本文件时 HOME 仍是真实的,
  // 所以"碰不到真实配置"这件事必须由**不去调那些路径**来保证,而不是靠环境变量。
  //
  // 判据用**拼出来的**针:直接把函数名加左括号写进代码字面量,'本文件'里就出现了它,
  // 断言会红在自己身上(这条已实测:前两版都是这么红的)。拼装之后,针只存在于运行时。
  const sw = 'switch', api = '/api/', fn = '(', q = "'";
  const forbidden = [sw + 'Claude' + fn, sw + 'Codex' + fn, sw + 'Router' + fn, sw + 'Zcode' + fn,
    q + api + 'switch/', q + api + 'router/', q + api + 'claude/' + 'split'];
  const src = fs.readFileSync(__filename, 'utf8');
  // 只扫**测试体**:从第一个 test( 开始,避开上面这段针与文件头的说明文字。
  // 末行那个 `\n` 也一并砍掉 —— 拼装用的字面量都写在文件的最后几行里,留着尾巴等于没避开。
  const body = src.slice(src.indexOf('\ntest('));
  const scan = body.slice(0, body.indexOf('// 自证这条断言有力气'));
  for (const needle of forbidden)
    assert.ok(!scan.includes(needle), `本文件不得出现 ${needle}(它会写真实客户端配置)`);
  // 自证这条断言有力气:拿一个**确实含有**违规写法的样本走同一套判据,必须全部命中。
  // 少了这一步,上面那个 for 全绿也可能只是因为针拼错了(拼错的针永远不命中)。
  const planted = `await raw(uiPort, 'POST', '${api}${'switch'}/p1'); ${sw}${'Claude'}(p);`
    + ` ${sw}${'Codex'}(p); ${sw}${'Router'}('claude'); ${sw}${'Zcode'}(p);`
    + ` raw(uiPort,'POST','${api}${'router'}/claude'); raw(uiPort,'POST','${api}${'claude'}/${'split'}');`;
  const hits = forbidden.filter(n => planted.includes(n));
  assert.equal(hits.length, forbidden.length,
    `自证失败:有 ${forbidden.length - hits.length} 根针在注入样本里也没命中,说明针本身是坏的`);
});
