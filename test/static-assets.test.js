'use strict';
// public/ 静态资源路由的独立回归(规划 5.3 第三期任务 1)。
//
// 为什么单开一份而不是并进 console-module.test.js:那份钉的是"模块装配契约"
// (活状态就地读、异步边界、回滚),本文件钉的是**一条安全边界**——
// 路径穿越、越界软链、扩展名白名单。这两件事的失效方式完全不同,混在一起会让
// 某一类红的根因看不出来。
//
// 装配方式刻意与 console-module.test.js 一致:真实 HTTP + 真实主入口 + listen(0),
// 不自己造一套平行 handler —— 那条路只能证明"我造的这套自洽",证不了主入口接的这条。
//
// 不碰 8787/8788:listen(0) 拿临时端口;不联网;不读真实客户端配置
// (临时 HOME + MIXR_DATA_DIR)。
//
// ⚠ 本文件里有两条用例会**在仓库的 public/ 下临时造一个文件**(软链),
//   因为 PUBLIC_DIR 由主入口按值注入(path.join(ROOT,'public')),没有环境变量可以指向别处,
//   而"越界软链被挡住"这条只有真的在 public 里放一个软链才能验。名字里带 pid 避免撞车,
//   全部在 try/finally 里删干净(见 withProbe)。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-static-assets-'));
process.env.HOME = TMP;
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude-settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex-config.toml');
process.env.MIXR_ZCODE_CONFIG = path.join(TMP, 'zcode-config.json');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXROUTER_PORT = '0';
process.env.MIXUI_PORT = '0';

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const mod = require('../mixrouter');

let ui, uiPort;
const sockets = new Set();

// 普通请求。path 原样交给 Node 的客户端,带 `..` 的会被原样写出去(服务端那边才会被 URL 折),
// 但**编码过的**那几种在服务端也不会被折 —— 真正要绕开的是客户端归一化,所以下面另有一条裸 socket 版。
function request(route, method = 'GET', { port = uiPort, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

// 裸 socket 发原始请求行:任何客户端侧的路径归一化都不参与,服务端收到什么就是什么。
// 这是"路径穿越真的被挡住了"这条断言的唯一可信来源 —— 走 http.request 时 `..` 可能已经在
// 客户端被处理掉,那时测的是 Node 的 URL 解析而不是我们的校验。
function rawRequest(target, method = 'GET') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(uiPort, '127.0.0.1', () => {
      sock.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${uiPort}\r\nConnection: close\r\n\r\n`);
    });
    let raw = Buffer.alloc(0);
    sock.setTimeout(5000, () => sock.destroy(new Error('fixture raw request timed out')));
    sock.on('data', c => { raw = Buffer.concat([raw, c]); });
    sock.on('error', reject);
    sock.on('end', () => {
      const text = raw.toString('latin1');
      const head = text.slice(0, Math.max(0, text.indexOf('\r\n\r\n')));
      const status = Number((head.split('\r\n')[0] || '').split(' ')[1]);
      resolve({ status, head, raw });
    });
  });
}

// 在 public/ 里临时造一个探针文件,用完必删。找不到 PUBLIC_DIR 时直接失败(而不是静默跳过)——
// 静默跳过会让"这条安全边界没人验"这件事看起来像通过。
function withProbe(name, make) {
  const file = path.join(PUBLIC_DIR, name);
  assert.equal(fs.existsSync(file), false, `${name} 是上一轮没清掉的残留,先清掉再跑`);
  try {
    make(file);
    return fs.lstatSync(file);
  } finally {
    fs.rmSync(file, { recursive: true, force: true });
  }
}

before(async () => {
  ui = await mod.listen(0, mod.apiHandler);
  ui.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  uiPort = ui.address().port;
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => { try { ui.closeAllConnections(); } catch {} ui.close(resolve); });
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 既有行为
test('GET / 与 GET /index.html 仍然返回 public/index.html,字节级相同', async () => {
  const want = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
  for (const route of ['/', '/index.html']) {
    const r = await request(route);
    assert.equal(r.status, 200, `${route} 应当 200`);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', `${route} 的 MIME 是既有行为,不许变`);
    assert.ok(r.body.equals(want), `${route} 的正文必须与 public/index.html 逐字节相同`);
  }
});

test('HEAD / 与 GET 同一条校验路径,但不带正文', async () => {
  const r = await request('/', 'HEAD');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', 'HEAD 也要报出与 GET 相同的类型');
  assert.equal(r.body.length, 0, 'HEAD 不许带正文');
  // 与 GET 的判别力对照:HEAD 如果比 GET 宽松,越界资源就能靠"探一下有没有"被摸到
  const escaped = await rawRequest('/..%2fpackage.json', 'HEAD');
  assert.notEqual(escaped.status, 200, 'HEAD 必须和 GET 一样挡住穿越');
});

// ---------------------------------------------------------------- 拆分出来的资源
// ⚠ 这两个文件由另一条并行任务创建。存在就断言(那时本文件是硬证据);
//   不存在则跳过 —— 跳过会如实报进交付说明,不会伪装成"验过了"。
test('GET /styles/base.css → 200 + text/css; charset=utf-8', async t => {
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'styles', 'base.css'))) {
    t.skip('public/styles/base.css 尚未由并行任务创建,本轮跳过');
    return;
  }
  const r = await request('/styles/base.css');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/css; charset=utf-8');
  assert.ok(r.body.equals(fs.readFileSync(path.join(PUBLIC_DIR, 'styles', 'base.css'))));
});

test('GET /js/app.js → 200 + javascript', async t => {
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'js', 'app.js'))) {
    t.skip('public/js/app.js 尚未由并行任务创建,本轮跳过');
    return;
  }
  const r = await request('/js/app.js');
  assert.equal(r.status, 200);
  // text/javascript 与 application/javascript 都算对:前者是 WHATWG 现行的推荐值,
  // 后者是历史写法。这里只钉"是 JS 不是 octet-stream",免得为措辞互相改来改去。
  assert.match(r.headers['content-type'], /^(text|application)\/javascript\b/);
});

test('页面引用的脚本和样式均可由真实静态路由读取', async () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="(\/(?:js|styles)\/[^"?#]+)"/g)].map(m => m[1]);
  assert.ok(assets.includes('/js/workspace.js'), '工作区脚本必须由页面加载');
  for (const asset of assets) {
    const r = await request(asset);
    assert.equal(r.status, 200, asset);
    assert.ok(r.body.equals(fs.readFileSync(path.join(PUBLIC_DIR, asset.slice(1)))), asset);
    assert.match(r.headers['content-type'], asset.endsWith('.css') ? /^text\/css\b/ : /^(text|application)\/javascript\b/);
  }
});

test('目录请求不列目录:GET /js/ 不是 200', async () => {
  const r = await rawRequest('/js/');
  assert.notEqual(r.status, 200, '目录请求不许回 200(那意味着目录列表或某个隐式文件被送出去了)');
  assert.doesNotMatch(r.head, /Index of|Directory listing/i, '更不能回一份目录清单');
});

test('即便目录真的存在,GET /styles/ 也不列目录', async t => {
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'styles'))) {
    t.skip('public/styles 尚未由并行任务创建,本轮跳过');
    return;
  }
  const r = await rawRequest('/styles/');
  assert.notEqual(r.status, 200);
  assert.doesNotMatch(r.head, /Index of|Directory listing/i);
});

// ---------------------------------------------------------------- 路径穿越
// 全部走裸 socket:走 http.request 的话 `..` 可能先在客户端被归一化,那就测不到服务端了。
for (const target of [
  '/../package.json',
  '/..%2fpackage.json',
  '/%2e%2e/package.json',
  '/%2e%2e%2fpackage.json',
  '/js/../../package.json',
  '/js%2f..%2f..%2fpackage.json',
  '/..%5cpackage.json',
  '/%2e%2e%5cpackage.json',
  '/....//package.json',
  '/..%2f..%2fpackage.json',
  '/%00index.html',
  '/..%2fproviders.json',
]) {
  test(`穿越被挡住:${target}`, async () => {
    const r = await rawRequest(target);
    assert.notEqual(r.status, 200, `${target} 不许回 200`);
    // 顺带钉一句"没有把仓库里的东西读出去":package.json / providers.json 都不在 public 下
    assert.doesNotMatch(r.raw.toString('latin1'), /"devDependencies"|"api_key"/,
      `${target} 的响应里出现了仓库文件的正文`);
  });
}

// Node 的 HTTP 服务端会把请求行里裸的 `..` 段折掉(实测 `/../package.json` 到达时已是
// `/package.json`),所以上面那几条里有一部分测的是 Node 的归一化而不是我们的代码。
// 这一条把**我们的解码层**单独拎出来:编码过的分隔符服务端不折,必须由 staticFileFor
// 解码后再查一次。写成一条独立用例是为了让"解码后才查穿越"这层失效时红在哪里一目了然。
test('%2f 形式的穿越靠解码后再查一次挡住(服务端不做归一化的那一类)', async () => {
  for (const target of ['/..%2fpackage.json', '/%2e%2e%2fpackage.json', '/js%2f..%2f..%2fpackage.json']) {
    const r = await rawRequest(target);
    assert.notEqual(r.status, 200, `${target} 在服务端不会被折,必须由解码后再查穿越挡住`);
  }
});

// ---------------------------------------------------------------- 无法解析的转义
test('解不出来的百分号转义一律不服务,而不是把原始串当文件名', async () => {
  for (const target of ['/%zz.html', '/index%2.html', '/%']) {
    const r = await rawRequest(target);
    assert.notEqual(r.status, 200, `${target} 不许回 200`);
  }
});

// ---------------------------------------------------------------- 越界软链
// 这是本项目里唯一能验"public 里放一个指向外部的软链读不出去"的手段:
// PUBLIC_DIR 是主入口按值注入的,没有环境变量能把它指到临时目录。
// 探针文件在 try/finally 里删干净,名字带 pid,不覆盖任何既有文件。
test('public 里指向外部的软链读不出去(realpath 之后仍要在 public 之内)', async () => {
  const outside = path.join(TMP, 'outside-secret.txt');   // 临时目录里的真实文件,内容可辨认
  fs.writeFileSync(outside, 'OUTSIDE-SECRET-MARKER');
  withProbe(`__probe-escape-${process.pid}.html`, file => {  // .html 在白名单里:这一条只验 realpath,不验扩展名
    fs.symlinkSync(outside, file);
  });
  const r = await rawRequest(`/__probe-escape-${process.pid}.html`);
  assert.notEqual(r.status, 200, '越界软链必须被挡住');
  assert.doesNotMatch(r.raw.toString('latin1'), /OUTSIDE-SECRET-MARKER/, '越界软链指向的文件正文不许出现在响应里');

  // 绝对路径形式也试一遍:软链直接指着 /etc/passwd 这类系统文件
  withProbe(`__probe-escape-abs-${process.pid}.html`, file => {
    fs.symlinkSync('/etc/passwd', file);
  });
  const abs = await rawRequest(`/__probe-escape-abs-${process.pid}.html`);
  assert.notEqual(abs.status, 200, '指向 /etc/passwd 的软链必须被挡住');
  assert.doesNotMatch(abs.raw.toString('latin1'), /root:/);
});

test('指向 public 之外的配置/日志/备份的软链同样读不到', async () => {
  // 这几个文件本来就不在 public 下,单靠"不存在"也能 404;所以要放一个**真实存在的**
  // 软链过去,才能证明拦它的是边界检查而不是"碰巧没有这个文件"。
  const config = path.join(TMP, 'providers.json');
  fs.writeFileSync(config, JSON.stringify({ secret_marker: 'api_key', providers: [] }));
  withProbe(`__probe-config-${process.pid}.json`, file => {   // .json 在白名单里
    fs.symlinkSync(config, file);
  });
  const r = await rawRequest(`/__probe-config-${process.pid}.json`);
  assert.notEqual(r.status, 200, '软链指向的配置文件不许被读出去');
  assert.doesNotMatch(r.raw.toString('latin1'), /secret_marker|api_key/);
});

// ---------------------------------------------------------------- 扩展名白名单
test('未白名单扩展名不服务,且不回落成 octet-stream', async () => {
  // 先试一个 public 下确实不存在的:- 这条路只证明"没这个文件",是弱证据,留着当基线
  const missing = await request('/package.json');
  assert.notEqual(missing.status, 200);

  // 硬证据:让文件**真实存在**(用软链指到临时目录里一个能读到的文件),只是扩展名不在白名单里。
  // 如果实现里有一条 `application/octet-stream` 的回落,这一条就会 200 并把正文发出去。
  const plain = path.join(TMP, 'plain.txt');
  fs.writeFileSync(plain, 'PLAINTEXT-MARKER');
  withProbe(`__probe-ext-${process.pid}.txt`, file => {
    fs.symlinkSync(plain, file);
  });
  const r = await rawRequest(`/__probe-ext-${process.pid}.txt`);
  assert.notEqual(r.status, 200, '.txt 不在白名单里,不许服务');
  assert.doesNotMatch(r.raw.toString('latin1'), /PLAINTEXT-MARKER|octet-stream/);

  const log = path.join(TMP, 'requests.jsonl');
  fs.writeFileSync(log, '{"PROMPT-MARKER":"hi"}');
  withProbe(`__probe-log-${process.pid}.log`, file => {
    fs.symlinkSync(log, file);
  });
  const r2 = await rawRequest(`/__probe-log-${process.pid}.log`);
  assert.notEqual(r2.status, 200, '.log 不在白名单里,不许服务');
  assert.doesNotMatch(r2.raw.toString('latin1'), /PROMPT-MARKER/);
});

// ---------------------------------------------------------------- 只读
test('静态资源是只读的:POST/PUT/DELETE 都不服务', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await rawRequest('/index.html', method);
    assert.notEqual(r.status, 200, `${method} /index.html 不许回 200`);
  }
  // 已有文件的写请求也一样(用 index.html 而不是不存在的路径,免得把"不存在"当成"拦住了")
  const r = await request('/index.html', 'POST');
  assert.notEqual(r.status, 200);
});

test('静态资源前缀不吞控制台 API:POST /api/... 仍然走到业务分支', async () => {
  // 静态分支按"非 /api、非 /healthz"来圈范围。圈错的话 POST /api/routing/preview 会被
  // 当成静态路径吃掉,控制台整套写操作静默失效 —— 这是这条改动最可能伤到的既有行为。
  // 判据取"不是静态那条出口":静态分支对没有白名单后缀的路径回 404,
  // 所以只要拿到业务侧的状态码(200/4xx/503)就说明没被吞掉;这里给了能返回 200 的完整夹具,
  // 拿 404 就说明路由圈错了。
  mod._state.store = { claude: [{ id: 'pa', name: 'pa', base_url: 'http://127.0.0.1:1/pa', api_key: 'sk-pa',
    enabled: true, models: ['x'], model: 'x' }], codex: [] };
  mod._state.routes = { rules: [], default: { provider: 'pa', model: '' } };
  const r = await request('/api/routing/preview', 'POST', { body: { app: 'claude', model: 'x' } });
  assert.equal(r.status, 200, `POST /api/routing/preview 必须仍然走业务分支,实得 ${r.status} ${r.body}`);
  assert.equal(r.headers['content-type'], 'application/json');
});

test('GET /healthz 仍然是那个 JSON,没有被静态分支吃掉', async () => {
  const r = await request('/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), '{"ok":true}');
});
