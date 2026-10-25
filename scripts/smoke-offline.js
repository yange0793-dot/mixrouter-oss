#!/usr/bin/env node
'use strict';
// smoke-offline — 离线端到端验收:不花钱、不碰真配置、不占 8787/8788
//
//   node scripts/smoke-offline.js
//
// 起一个临时实例跑真实一进一出。不需要任何真实渠道 Key,也不需要作者本机那套可选外壳工具。
// 隔离:临时 HOME + 临时 MIXR_DATA_DIR + 内核分配端口(断言不落在 8787/8788)+ 进程内 mock 上游。
// 收尾:子进程、监听、临时目录都在 finally 里清掉,清理失败会让退出码非 0。
//
// 边界:不读也不监视真实 HOME 下的客户端配置,也不拿仓库根运行时文件的 mtime 去推断自己有没有
// 污染——运行中的 router 本来就会写那些文件,据此判断只会误报。防污染靠严格环境隔离加临时
// HOME 里的哨兵(见 main() 里 sentinel 那段)。更细的说明见 docs/offline-run-and-acceptance.md。
// ============================================================================
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'mixrouter.js');
const RESERVED_PORTS = [8787, 8788]; // 现役实例的端口:绝不占用、绝不连接

// 现场编的占位 Key。形状像真的只是为了走完长度判断,值本身是编的。
const KEY_CLAUDE_A = 'sk-smoke-claude-a-0123456789abcdef';
const KEY_CLAUDE_B = 'sk-smoke-claude-b-0123456789abcdef';
const KEY_CLAUDE_C = 'sk-smoke-claude-c-0123456789abcdef';
const KEY_CODEX = 'sk-smoke-codex-0123456789abcdef';
const MOCK_PREFIX = 'mock-echo:';
const REQ_TIMEOUT_MS = 15000;   // 客户端侧单请求上限:挂住的请求必须自己死,不能拖住收尾
const CLEANUP_DEADLINE_MS = 8000;

// ------------------------------------------------------------------ 断言收集
// 每次 main() 重新赋一份,不在模块级跨 run 累积(测试可能多次调用)。
let results = [];
const ok = name => results.push({ name, pass: true });
const bad = (name, detail) => results.push({ name, pass: false, detail: String(detail).slice(0, 600) });
async function step(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    bad(name, e && e.message ? e.message : e);
  }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (got, want, what) => must(got === want, `${what}: 期望 ${JSON.stringify(want)},实际 ${JSON.stringify(got)}`);

// ------------------------------------------------------------------ 小工具
// 内核分配一个空闲端口,然后**立刻关闭**把它让出去。关闭到子进程 bind 之间有一个
// 真实存在的竞态窗口(端口可能被别的进程抢走),所以端口归属不靠"我探过就是我的",
// 靠起完之后比对 /api/state 的 pid 与子进程 pid——见 main() 里那条断言。
// 抢输了验收会明确 FAIL,而不是安安静静测到别人的实例。
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function req(port, method, reqPath, { headers = {}, body, timeoutMs = REQ_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const creq = http.request({
      hostname: '127.0.0.1', port, method, path: reqPath, timeout: timeoutMs,
      headers: { ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, cres => {
      const cs = [];
      // 响应中途被截断的两种收场必须都接住,否则 'end' 永远不来、promise 悬着,
      // 整个验收脚本就卡死在这一句上(挂住的测试比失败的测试难查得多):
      //   · 对端干净 FIN 但响应没收完 → 响应对象上发 'aborted'(实测 Node 24,
      //     'error' ECONNRESET 与 'close' 也会跟着来)
      //   · 对端 RST → 只有请求对象上的 'error',见下面 creq.on('error')
      cres.on('aborted', () => done(reject, new Error('响应在收完前被中断(aborted)')));
      cres.on('error', e => done(reject, new Error(`响应错误:${e.message}`)));
      cres.on('data', c => cs.push(c));
      cres.on('end', () => done(resolve, { status: cres.statusCode, headers: cres.headers, text: Buffer.concat(cs).toString('utf8') }));
    });
    creq.on('timeout', () => { creq.destroy(new Error(`客户端侧 ${timeoutMs}ms 无响应`)); });
    creq.on('error', e => done(reject, e));
    if (data) creq.write(data);
    creq.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 给清理动作加截止时间:清理本身卡住(close 等不到)不能把脚本永远吊住。
async function withDeadline(name, fn, ms = CLEANUP_DEADLINE_MS) {
  let timer = null;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`清理「${name}」超过 ${ms}ms 未完成`)), ms);
  });
  try {
    await Promise.race([Promise.resolve().then(fn), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ mock 上游
// 自带一份最小 mock,不 require test/mock-upstream.js:脚本要能单独跑,且别的测试文件
// 同时在改的时候不该把验收脚本一起带下水。
function createMockUpstream() {
  const seen = [];
  const server = http.createServer((creq, cres) => {
    if (creq.method !== 'POST') {
      cres.writeHead(404, { 'Content-Type': 'application/json' });
      return cres.end('{"error":"mock 只接 POST"}');
    }
    const cs = [];
    creq.on('data', c => cs.push(c));
    creq.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}'); } catch {}
      const url = String(creq.url || '').split('?')[0];
      seen.push({ url, method: creq.method, headers: creq.headers, body });
      const model = body.model || '(none)';
      const text = MOCK_PREFIX + model;
      if (url === '/v1/responses') return responsesReply(cres, body, model, text);
      if (url === '/v1/chat/completions') return chatReply(cres, body, model, text);
      return anthropicReply(cres, body, model, text);
    });
  });
  return { server, seen };
}

function anthropicReply(res, body, model, text) {
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = ev => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    // usage 的真值只放 message_delta、message_start 给 0:贴近 glm-5.3 一类网关的真实形状
    send({ type: 'message_start', message: { id: 'msg_smoke', type: 'message', role: 'assistant', model, usage: { input_tokens: 0, output_tokens: 0 } } });
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    send({ type: 'content_block_stop', index: 0 });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 17, output_tokens: 9, cache_read_input_tokens: 5 } });
    send({ type: 'message_stop' });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg_smoke', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn',
    usage: { input_tokens: 17, output_tokens: 9, cache_read_input_tokens: 5 } }));
}

function responsesReply(res, body, model, text) {
  const usage = { input_tokens: 21, output_tokens: 13, total_tokens: 34, input_tokens_details: { cached_tokens: 4 } };
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const sse = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const rid = 'resp_smoke', mid = 'msg_smoke';
    sse({ type: 'response.created', response: { id: rid, object: 'response', status: 'in_progress', model, output: [] } });
    sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: mid, role: 'assistant', status: 'in_progress', content: [] } });
    sse({ type: 'response.output_text.delta', item_id: mid, output_index: 0, content_index: 0, delta: text });
    sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: mid, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] } });
    sse({ type: 'response.completed', response: { id: rid, object: 'response', status: 'completed', model, output: [], usage } });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'resp_smoke', object: 'response', status: 'completed', model,
    output: [{ type: 'message', id: 'msg_smoke', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage }));
}

function chatReply(res, body, model, text) {
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const sse = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
    sse({ id: 'chatcmpl-smoke', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: text } }] });
    // 终态块:真网关在这里给 finish_reason。缺了它,转换层只能靠断流收尾。
    // 顺序照惯例——finish_reason 块在 usage 块之前、[DONE] 之前;delta 留空。
    sse({ id: 'chatcmpl-smoke', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    // usage 只在客户端主动要的时候才给(chat 系网关的普遍行为)
    if (body.stream_options && body.stream_options.include_usage) {
      sse({ id: 'chatcmpl-smoke', object: 'chat.completion.chunk', model, choices: [],
        usage: { prompt_tokens: 21, completion_tokens: 13, total_tokens: 34, prompt_tokens_details: { cached_tokens: 4 } } });
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'chatcmpl-smoke', object: 'chat.completion', model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 21, completion_tokens: 13, total_tokens: 34 } }));
}

// ------------------------------------------------------------------ 临时配置
// logs/ 这一层这里**仍然自己建**,但它已经不是"日志能不能落盘"的前提了:
// 请求日志目录现在由 lib/observability/request-log.js 在首次 append 时自己建(0700,
// 见 test/request-log.test.js「首次 append 才建目录与文件」),require 它零副作用。
// 保留这句 mkdir 是为了把「日志落盘」当成**被验收的行为**——目录先摆好,后面
// 「请求日志确实落在临时数据目录里」那条断言才是在验落盘本身,而不是在验建目录。
function writeTmpConfig(dataDir, upstreamBase) {
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  const providers = {
    version: 2,
    current: { claude: null, codex: null, zcode: null },
    claude: [
      { id: 'p-auth', name: 'smoke-anthropic', base_url: upstreamBase, api_key: KEY_CLAUDE_A,
        enabled: true, models: ['up-model-a'], ua: '', note: 'smoke' },
      { id: 'p-resp', name: 'smoke-resp', base_url: upstreamBase, api_key: KEY_CLAUDE_B,
        enabled: true, wire_api: 'responses', models: ['up-model-b'], ua: '', note: 'smoke' },
      { id: 'p-chat', name: 'smoke-chat', base_url: upstreamBase, api_key: KEY_CLAUDE_C,
        enabled: true, wire_api: 'chat', models: ['up-model-c'], ua: '', note: 'smoke' },
    ],
    codex: [
      { id: 'c-resp', name: 'smoke-codex', base_url: upstreamBase, api_key: KEY_CODEX,
        enabled: true, model: 'gpt-smoke', wire_api: 'responses', drop_images: false, note: 'smoke' },
    ],
  };
  const routes = {
    rules: [
      { id: 'r-auth', match: 'smoke-a', provider: 'p-auth', model: 'up-model-a', pool: [], strategy: 'round_robin', priority: 0, when: {}, enabled: true, app: 'claude' },
      { id: 'r-resp', match: 'smoke-b', provider: 'p-resp', model: 'up-model-b', pool: [], strategy: 'round_robin', priority: 0, when: {}, enabled: true, app: 'claude' },
      { id: 'r-chat', match: 'smoke-c', provider: 'p-chat', model: 'up-model-c', pool: [], strategy: 'round_robin', priority: 0, when: {}, enabled: true, app: 'claude' },
      { id: 'r-codex', match: 'gpt-smoke', provider: 'c-resp', model: 'gpt-smoke', pool: [], strategy: 'round_robin', priority: 0, when: {}, enabled: true, app: 'codex' },
    ],
    default: { provider: '', model: '', pool: [], strategy: 'round_robin' },
  };
  fs.writeFileSync(path.join(dataDir, 'providers.json'), JSON.stringify(providers, null, 2) + '\n');
  fs.writeFileSync(path.join(dataDir, 'routes.json'), JSON.stringify(routes, null, 2) + '\n');
}

// 子进程环境:先清掉调用方 shell 里所有 MIXR_/MIXROUTER_/MIXUI_ 残值,再显式给本次要用的
// ——调用方 shell 里一个陈旧的 MIXR_DATA_DIR 就能让"隔离"变成写真实数据目录。
function childEnv(ports, dirs) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(MIXR_|MIXROUTER_|MIXUI_)/.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: dirs.home,                                   // 兜底:没被下面覆盖的落点也落在临时目录
    MIXR_DATA_DIR: dirs.data,
    MIXR_CLAUDE_SETTINGS: path.join(dirs.home, '.claude', 'settings.json'),
    MIXR_CODEX_CONFIG: path.join(dirs.home, '.codex', 'config.toml'),
    MIXR_ZCODE_CONFIG: path.join(dirs.home, '.zcode', 'v2', 'config.json'),
    DSH_HOME: path.join(dirs.home, '.dsh'),
    MIXR_HARNESS_PROFILE: path.join(dirs.home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
    MIXR_UPSTREAM_PROXY: '',                           // 明确的空值:不回落到调用方 shell 的隧道
    MIXR_SESSION_LABEL: '0',
    MIXROUTER_PORT: String(ports.proxy),
    MIXUI_PORT: String(ports.ui),
    // 验收专用:三段超时收紧,失败几秒内暴露,而不是陪着默认 240s 干等
    MIXR_TOTAL_DEADLINE_MS: '20000',
    MIXR_FIRST_HEADER_TIMEOUT_MS: '6000',
    MIXR_STREAM_FIRST_HEADER_TIMEOUT_MS: '6000',
    MIXR_STREAM_IDLE_TIMEOUT_MS: '6000',
    MIXR_NONSTREAM_TOTAL_TIMEOUT_MS: '10000',
  };
}

async function waitHealthy(port, child, state, logs, deadlineMs = 20000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (state.spawnError) throw new Error(`子进程起不来:${state.spawnError.message}\n${logs()}`);
    if (child.signalCode) throw new Error(`子进程被信号 ${child.signalCode} 终止\n${logs()}`);
    if (child.exitCode !== null) throw new Error(`子进程提前退出(exit ${child.exitCode})\n${logs()}`);
    try {
      const r = await req(port, 'GET', '/healthz');
      if (r.status === 200) return r;
    } catch { /* 还没起来,继续等 */ }
    if (Date.now() > until) throw new Error(`等待 /healthz 超时(${deadlineMs}ms)\n${logs()}`);
    await sleep(150);
  }
}

// 端口归属硬闸门。**必须在任何业务请求之前跑完**,而且失败即整轮结束——不能记一条 FAIL
// 就继续往那个口发请求:如果那个口上跑的是别的实例(用户正在用的那个),后面的 POST 就会
// 打到**别人的真渠道**上去,那正是这套隔离要防的事。所以这里是 throw 而不是 step()。
// /healthz 回 200 只说明那个口上有个 mixrouter 在跑,说明不了是谁:freePort 探完就关,
// 到子进程 bind 之间端口可能被抢走。
//
// 判据的分量并不一样,**别把后两条当成"独立读到了真实端口"**:
//   · pid 对得上 —— 这是**真正的归属证据**:应答者就是本次拉起的那个 child。
//   · proxy_port / ui_port 对得上 —— 这是**接线一致性**检查。本脚本把探到的具体端口经
//     MIXROUTER_PORT/MIXUI_PORT 传给子进程,而 /api/state 回的正是这对配置常量,
//     所以这里比的是"子进程有没有按我们给的口起";它**不会**在端口被抢走时救场
//     (那种情况由 pid 那条拦下)。若脚本改传 0,这两条就恒真、等于没查(见 docs 的 §2)。
// 预探 + pid 这套**不消除** TOCTOU:探到 bind 之间那个窗口真实存在,只是抢输了会被明确判 FAIL。
async function assertPortsOwned(child, state, ports, logs) {
  if (state.spawnError) throw new Error(`子进程起不来:${state.spawnError.message}\n${logs()}`);
  const pid = child.pid;
  let r;
  try {
    r = await req(ports.ui, 'GET', '/api/state');
  } catch (e) {
    throw new Error(`控制台口 ${ports.ui} 上没有可应答的实例:${e.message}\n${logs()}`);
  }
  if (r.status !== 200) throw new Error(`控制台口 ${ports.ui} 返回 ${r.status},不是本轮的实例\n${logs()}`);
  let j;
  try { j = JSON.parse(r.text); }
  catch { throw new Error(`控制台口 ${ports.ui} 返回的不是 JSON,拒绝继续\n${logs()}`); }
  if (j.pid !== pid) throw new Error(
    `端口被抢占,拒绝继续:控制台口 ${ports.ui} 上跑的进程 pid=${j.pid},不是本次拉起的 ${pid}。\n` +
    `后面的请求会打到别人的实例上,已在发任何业务请求之前中止。\n${logs()}`);
  if (j.proxy_port !== ports.proxy || j.ui_port !== ports.ui) throw new Error(
    `端口归属不一致:服务自报 proxy=${j.proxy_port} ui=${j.ui_port},本次拉起的是 ${ports.proxy}/${ports.ui}\n${logs()}`);
  return j;
}

// ------------------------------------------------------------------ 主流程
async function main() {
  results = [];                                  // 每次调用从零开始,不跨 run 累积
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-smoke-'));
  const dirs = { home: path.join(tmp, 'home'), data: path.join(tmp, 'data'), tmp };
  const mock = createMockUpstream();
  const cleanup = [];                            // [{name, fn}]
  const childState = { spawnError: null };
  let child = null;
  let out = '', err = '';
  const logs = () => `--- 子进程 stdout ---\n${out.slice(-2000)}\n--- 子进程 stderr ---\n${err.slice(-2000)}`;

  try {
    // 1) mock 上游:内核分配端口,只监听回环
    await new Promise((resolve, reject) => {
      mock.server.on('error', reject);
      mock.server.listen(0, '127.0.0.1', resolve);
    });
    cleanup.push({ name: 'mock 上游', fn: () => new Promise(r => mock.server.close(r)) });
    const mockPort = mock.server.address().port;
    const upstreamBase = `http://127.0.0.1:${mockPort}`;

    // 2) 临时实例的两个端口:内核分配,显式避开现役端口
    const proxyPort = await freePort();
    const uiPort = await freePort();
    for (const p of [proxyPort, uiPort, mockPort]) {
      must(!RESERVED_PORTS.includes(p), `内核给到了现役端口 ${p},拒绝继续(不占 8787/8788)`);
    }
    must(proxyPort !== uiPort, `代理口与控制台口撞了(${proxyPort})`);

    // 3) 临时配置、临时数据目录、以及一份**哨兵**客户端配置。
    //    哨兵只落在临时 HOME 里:它是用来证明"这次跑没有写客户端配置"的靶子。
    //    不拿真实 ~/.claude 做这件事——那是运行中用户的文件,别的会话正常改写会让它误报,
    //    而且本轮边界本来就不读真配置。
    writeTmpConfig(dirs.data, upstreamBase);
    const claudeCfg = path.join(dirs.home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(claudeCfg), { recursive: true });
    const sentinel = '{\n  "env": {\n    "SMOKE_SENTINEL": "untouched"\n  }\n}\n';
    fs.writeFileSync(claudeCfg, sentinel);
    const sentinelBefore = fs.readFileSync(claudeCfg, 'utf8');

    // 4) 起真实入口(mixrouter.js 直接运行的那条路径,含横幅/僵尸路由报告/信号处理)
    child = spawn(process.execPath, [ENTRY], {
      cwd: ROOT, env: childEnv({ proxy: proxyPort, ui: uiPort }, dirs), stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', e => { childState.spawnError = e; });
    child.stdout.on('data', c => { out += c.toString('utf8'); });
    child.stderr.on('data', c => { err += c.toString('utf8'); });
    const exited = new Promise(r => child.once('exit', (code, sig) => r({ code, sig })));
    const pid = child.pid;
    cleanup.push({
      name: '子进程',
      fn: async () => {
        // spawn 失败时 pid 是 undefined、'exit' 也**永远不会来**:这时候去等 exited 就是
        // 白等到截止时间。直接判掉,不制造一个没有 exit 事件的等待。
        if (!child.pid || childState.spawnError) return;
        if (child.exitCode !== null || child.signalCode) return;
        child.kill('SIGTERM');
        const t = await Promise.race([exited.then(() => 'gone'), sleep(5000).then(() => 'timeout')]);
        if (t === 'timeout' && child.exitCode === null && !child.signalCode) {
          child.kill('SIGKILL');
          await Promise.race([exited, sleep(2000)]);
        }
        if (child.exitCode === null && !child.signalCode) throw new Error(`子进程 pid ${pid} 杀不掉`);
      },
    });

    const health = await waitHealthy(proxyPort, child, childState, logs);

    // ---- 5) 端口归属硬闸门:过不了就整轮中止,后面一个业务请求都不发
    const state0 = await assertPortsOwned(child, childState, { proxy: proxyPort, ui: uiPort }, logs);

    // ---- 6) 健康与启动
    await step('/healthz:代理口回 200 且自报为 mixrouter', async () => {
      eq(health.status, 200, 'status');
      const j = JSON.parse(health.text);
      eq(j.ok, true, 'ok');
      eq(j.service, 'mixrouter', 'service');
      must(typeof j.version === 'string' && j.version.length, 'version 应为非空字符串');
    });
    await step('启动横幅落在本次指定的端口上', () => {
      must(out.includes(`:${proxyPort}`) && out.includes(`:${uiPort}`),
        `横幅里没同时出现 ${proxyPort}/${uiPort};实际输出:${out.slice(0, 400)}`);
    });
    await step('端口归属(硬闸门已先行通过)', () => {
      eq(state0.pid, child.pid, '控制台口上的 pid');
      eq(state0.proxy_port, proxyPort, '服务自报的代理口');
      eq(state0.ui_port, uiPort, '服务自报的控制台口');
    });
    await step('临时数据目录里确实落下了运行时文件(说明用的是临时库)', () => {
      must(fs.existsSync(path.join(dirs.data, 'providers.json')), 'providers.json 不在 MIXR_DATA_DIR 下');
      must(fs.existsSync(path.join(dirs.data, 'routes.json')), 'routes.json 不在 MIXR_DATA_DIR 下');
    });

    // ---- 7) 控制台:无 secret 泄露
    await step('/api/state:两份渠道都在,且原始 Key 一个字节都不出现在响应里', async () => {
      const r = await req(uiPort, 'GET', '/api/state');
      eq(r.status, 200, 'status');
      for (const key of [KEY_CLAUDE_A, KEY_CLAUDE_B, KEY_CLAUDE_C, KEY_CODEX]) {
        must(!r.text.includes(key), `/api/state 响应里出现了原始 Key(${key.slice(0, 12)}…)`);
      }
      const j = JSON.parse(r.text);
      eq(j.providers.claude.length, 3, 'claude 渠道数');
      eq(j.providers.codex.length, 1, 'codex 渠道数');
      for (const p of [...j.providers.claude, ...j.providers.codex]) {
        must(p.api_key === undefined, `渠道 ${p.id} 的 api_key 未脱敏`);
        must(typeof p.key_masked === 'string' && p.key_masked.length, `渠道 ${p.id} 缺少 key_masked`);
        must(p.has_key === true, `渠道 ${p.id} 的 has_key 应为 true`);
        must(typeof p.base_url === 'string' && p.base_url.includes(String(mockPort)), `渠道 ${p.id} 的 base_url 不是 mock 上游`);
      }
      must(!/sk-smoke/.test(r.text), '/api/state 里仍出现 sk-smoke 前缀');
    });
    await step('/api/health:只读健康视图可读', async () => {
      const r = await req(uiPort, 'GET', '/api/health');
      eq(r.status, 200, 'status');
      const j = JSON.parse(r.text);
      must(j.settings && j.settings.total_deadline_ms === 20000, '本脚本设的 MIXR_TOTAL_DEADLINE_MS 没生效');
      must(Array.isArray(j.providers) && j.providers.length === 4, `providers 应有 4 条,实际 ${j.providers && j.providers.length}`);
    });
    await step('/api/logs 与 /api/stats:控制台读接口可用', async () => {
      for (const p of ['/api/logs?limit=5', '/api/stats']) {
        const r = await req(uiPort, 'GET', p);
        eq(r.status, 200, `${p} status`);
        must(!/sk-smoke/.test(r.text), `${p} 里出现占位 Key`);
      }
    });

    // ---- 7) Anthropic 一进一出(直通)
    const NOSTREAM = { model: 'smoke-a', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] };
    const anthHeaders = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
    await step('Anthropic 非流式:messages → 上游 /v1/messages,响应回到 message 形状', async () => {
      const n = mock.seen.length;
      const r = await req(proxyPort, 'POST', '/v1/messages', { headers: anthHeaders, body: NOSTREAM });
      eq(r.status, 200, 'status');
      const j = JSON.parse(r.text);
      eq(j.type, 'message', 'type');
      must(j.content[0].text.startsWith(MOCK_PREFIX), `正文不是 mock 回显:${JSON.stringify(j.content[0].text)}`);
      eq(j.usage.input_tokens, 17, 'usage.input_tokens');
      const hit = mock.seen.slice(n);
      eq(hit.length, 1, '上游收到的请求数');
      eq(hit[0].url, '/v1/messages', '上游路径');
      eq(hit[0].body.model, 'up-model-a', '改写后的出站模型名');
      eq(hit[0].headers['x-api-key'], KEY_CLAUDE_A, '出站 x-api-key');
      eq(hit[0].headers['authorization'], 'Bearer ' + KEY_CLAUDE_A, '出站 Authorization');
    });
    await step('Anthropic 流式:SSE 事件序列以 message_stop 收尾', async () => {
      const r = await req(proxyPort, 'POST', '/v1/messages', { headers: anthHeaders, body: { ...NOSTREAM, stream: true } });
      eq(r.status, 200, 'status');
      must(String(r.headers['content-type']).includes('text/event-stream'), `content-type 不是 SSE:${r.headers['content-type']}`);
      for (const marker of ['message_start', 'content_block_delta', MOCK_PREFIX + 'up-model-a', 'message_stop']) {
        must(r.text.includes(marker), `SSE 里缺 ${marker}`);
      }
      // 终态纪律:最后一个事件必须是 message_stop。中途断开而补终态、或压根没发终态,
      // 都是客户端最难受的故障形状。
      const lastEvent = r.text.trimEnd().split('\n').filter(l => l.startsWith('event: ')).pop();
      eq(lastEvent, 'event: message_stop', '最后一个 SSE 事件');
    });

    // ---- 8) 转译线:claude 客户端 → 非 Anthropic 上游
    await step('Claude 组 wire_api=responses:客户端说 Anthropic,出站打到 /v1/responses 并翻回来', async () => {
      const n = mock.seen.length;
      const r = await req(proxyPort, 'POST', '/v1/messages', {
        headers: anthHeaders, body: { model: 'smoke-b', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] } });
      eq(r.status, 200, 'status');
      const j = JSON.parse(r.text);
      eq(j.type, 'message', 'type');
      must(j.content.some(b => b.type === 'text' && b.text.includes(MOCK_PREFIX + 'up-model-b')),
        `正文没翻回 Anthropic 形状:${JSON.stringify(j.content)}`);
      const hit = mock.seen.slice(n);
      eq(hit.length, 1, '上游收到的请求数');
      eq(hit[0].url, '/v1/responses', '上游路径');
      eq(hit[0].body.model, 'up-model-b', '出站模型名');
      eq(hit[0].headers['authorization'], 'Bearer ' + KEY_CLAUDE_B, '出站 Authorization');
      must(hit[0].headers['x-api-key'] === undefined, 'OpenAI 型上游不该收到 x-api-key');
    });
    await step('Claude 组 wire_api=chat:出站打到 /v1/chat/completions,整包翻回 Anthropic', async () => {
      const n = mock.seen.length;
      const r = await req(proxyPort, 'POST', '/v1/messages', {
        headers: anthHeaders, body: { model: 'smoke-c', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] } });
      eq(r.status, 200, 'status');
      const j = JSON.parse(r.text);
      eq(j.type, 'message', 'type');
      must(j.content.some(b => b.type === 'text' && b.text.includes(MOCK_PREFIX + 'up-model-c')),
        `正文没翻回 Anthropic 形状:${JSON.stringify(j.content)}`);
      const hit = mock.seen.slice(n);
      eq(hit.length, 1, '上游收到的请求数');
      eq(hit[0].url, '/v1/chat/completions', '上游路径');
      eq(hit[0].headers['authorization'], 'Bearer ' + KEY_CLAUDE_C, '出站 Authorization');
    });
    await step('Claude 组 wire_api=chat 流式:chat 的 finish_reason 终态要翻成 Anthropic 收尾', async () => {
      const r = await req(proxyPort, 'POST', '/v1/messages', {
        headers: anthHeaders, body: { model: 'smoke-c', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }], stream: true } });
      eq(r.status, 200, 'status');
      must(String(r.headers['content-type']).includes('text/event-stream'), `content-type 不是 SSE:${r.headers['content-type']}`);
      must(r.text.includes(MOCK_PREFIX + 'up-model-c'), 'SSE 里没有正文');
      // mock 现在会发 finish_reason:'stop' 的终态块;这条线必须照常收到完整 Anthropic 收尾。
      const lastEvent = r.text.trimEnd().split('\n').filter(l => l.startsWith('event: ')).pop();
      eq(lastEvent, 'event: message_stop', '最后一个 SSE 事件');
    });

    // ---- 9) OpenAI 一进一出
    await step('Responses 非流式:/v1/responses → 上游 /v1/responses,原样回 response 形状', async () => {
      const n = mock.seen.length;
      const r = await req(proxyPort, 'POST', '/v1/responses', {
        headers: { 'Content-Type': 'application/json', 'session-id': 'smoke-sess-1' },
        body: { model: 'gpt-smoke', input: [{ role: 'user', content: 'ping' }] } });
      eq(r.status, 200, 'status');
      const j = JSON.parse(r.text);
      eq(j.object, 'response', 'object');
      eq(j.status, 'completed', 'status');
      eq(j.output[0].content[0].text, MOCK_PREFIX + 'gpt-smoke', '正文');
      const hit = mock.seen.slice(n);
      eq(hit.length, 1, '上游收到的请求数');
      eq(hit[0].url, '/v1/responses', '上游路径');
      eq(hit[0].headers['authorization'], 'Bearer ' + KEY_CODEX, '出站 Authorization');
    });
    await step('Responses 流式:SSE 以 response.completed 收尾', async () => {
      const r = await req(proxyPort, 'POST', '/v1/responses', {
        headers: { 'Content-Type': 'application/json' },
        body: { model: 'gpt-smoke', input: [{ role: 'user', content: 'ping' }], stream: true } });
      eq(r.status, 200, 'status');
      must(String(r.headers['content-type']).includes('text/event-stream'), `content-type 不是 SSE:${r.headers['content-type']}`);
      for (const marker of ['response.created', 'response.output_text.delta', MOCK_PREFIX + 'gpt-smoke', 'response.completed']) {
        must(r.text.includes(marker), `SSE 里缺 ${marker}`);
      }
      const lastData = r.text.trimEnd().split('\n').filter(l => l.startsWith('data: ')).pop();
      must(lastData && lastData.includes('response.completed'), `最后一个 SSE data 不是 complete:${lastData}`);
    });
    await step('GET /v1/models 与 HEAD 探活', async () => {
      const r = await req(proxyPort, 'GET', '/v1/models');
      eq(r.status, 200, '/v1/models status');
      must(JSON.parse(r.text).object === 'list', '/v1/models 应回 list');
      const h = await req(proxyPort, 'HEAD', '/v1/messages');
      eq(h.status, 200, 'HEAD /v1/messages status');
    });
    await step('未知路径回 404,不漏路由', async () => {
      const r = await req(proxyPort, 'POST', '/v1/nope', { headers: { 'Content-Type': 'application/json' }, body: {} });
      eq(r.status, 404, 'status');
    });
    await step('请求日志确实落在临时数据目录里,且不含原始 Key', async () => {
      const r = await req(uiPort, 'GET', '/api/logs?limit=50');
      const j = JSON.parse(r.text);
      must(j.logs.length >= 5, `日志条数偏少:${j.logs.length}`);
      const f = path.join(dirs.data, 'logs', 'requests.jsonl');
      must(fs.existsSync(f), `requests.jsonl 没落在 MIXR_DATA_DIR 下:${f}`);
      const body = fs.readFileSync(f, 'utf8');
      must(!body.includes(KEY_CLAUDE_A), 'requests.jsonl 里落进了原始 Key');
      must(body.trim().split('\n').length >= 5, 'requests.jsonl 行数偏少');
    });
    await step('Harness 独立模型池:保存不写客户端,跨协议组 Messages 转译可用', async () => {
      const originalSlots = JSON.stringify(state0.slots);
      const state = JSON.parse((await req(uiPort, 'GET', '/api/harness')).text);
      const saved = await req(uiPort, 'PUT', '/api/harness', { headers: anthHeaders, body: {
        expected_revision: state.revision, main: { provider: 'c-resp', model: 'gpt-smoke' },
        pool: [{ provider: 'p-auth', model: 'up-model-a' }],
      } });
      eq(saved.status, 200, 'Harness save status');
      const configured = JSON.parse(saved.text);
      must(configured.pool.length === 2, '主模型应自动纳入池');
      must(!/sk-smoke/.test(saved.text), 'Harness state 不能回显 Key');
      const response = await req(proxyPort, 'POST', '/harness/v1/messages', { headers: anthHeaders,
        body: { ...NOSTREAM, model: 'mixr-harness-main' } });
      eq(response.status, 200, 'Harness Messages status');
      must(JSON.parse(response.text).content.some(block => block.text === MOCK_PREFIX + 'gpt-smoke'), 'Harness 主模型没有落到 Codex 组的准确模型');
      const after = JSON.parse((await req(uiPort, 'GET', '/api/state')).text);
      eq(JSON.stringify(after.slots), originalSlots, 'Harness 不改其他客户端槽位');
      must(fs.existsSync(path.join(dirs.data, 'harness.json')), '池只保存到隔离数据目录');
      must(!fs.existsSync(path.join(dirs.home, '.dsh')), '普通保存与请求不能创建 Harness profile');
    });
    await step('Harness 关键静态资源随运行包交付', async () => {
      for (const asset of ['/js/harness.js', '/styles/harness.css'])
        eq((await req(uiPort, 'GET', asset)).status, 200, asset);
    });
    await step('临时 HOME 里的哨兵客户端配置原样未动(本次跑没有触发客户端配置写入)', () => {
      eq(fs.readFileSync(claudeCfg, 'utf8'), sentinelBefore, '哨兵 settings.json 内容被改了');
    });
  } finally {
    // 清理**不能**吞失败:收不干净却打 SMOKE PASS,比不清理更误导。
    for (const { name, fn } of cleanup.reverse()) {
      try {
        await withDeadline(name, fn);
      } catch (e) {
        bad(`清理「${name}」`, e && e.message ? e.message : e);
      }
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { bad('清理「临时目录」', e.message); }
    if (fs.existsSync(tmp)) bad('清理「临时目录」', `${tmp} 仍然存在`);
  }

  const failed = results.filter(r => !r.pass);
  for (const r of results) console.log(`${r.pass ? '  ok  ' : ' FAIL '} ${r.name}${r.pass ? '' : '\n        ' + r.detail}`);
  console.log(`\n${failed.length ? 'SMOKE FAIL' : 'SMOKE PASS'} — ${results.length - failed.length}/${results.length} 项通过`);
  return failed.length ? 1 : 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => {
    console.error(`SMOKE FAIL — 脚本自身异常:${e && (e.stack || e.message || e)}`);
    process.exit(2);
  });
}

module.exports = {
  main, childEnv, createMockUpstream, writeTmpConfig, freePort, withDeadline, req, assertPortsOwned,
  RESERVED_PORTS, MOCK_PREFIX, REQ_TIMEOUT_MS,
};
