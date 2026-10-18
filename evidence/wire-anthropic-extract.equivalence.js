'use strict';
// 对照取证:抽取 lib/wire-anthropic-sink.js 前后,转发路径上「客户端收到的字节」是否逐字节相同。
//
// 用法(在仓库根):
//   node evidence/wire-anthropic-extract.equivalence.js            # 打印摘要
//   node evidence/wire-anthropic-extract.equivalence.js --json     # 打印机器可读全量
//
// 覆盖:claude 客户端 × {chat 上游, responses 上游} × {流式, 非流式} × {上游正常, 上游整包自杀}
// 四类观测:
//   1) HTTP 状态码与响应头
//   2) 响应体逐字节(sha256)
//   3) 该条请求在 requests.jsonl 里的 entry(status/err/err_class/in/out)
//   4) 客户端收到的 RAW 字节序列(含 chunk 切分)
//
// 设计要点:**不改仓库任何文件**,起真服务、用真 HTTP,只把 providers.json 指到本地假上游。
// 每条用例前后重置 _state,免得上一条的状态渗进来。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// ROOT 可用 --root=<路径> 覆盖:脚本要能放在仓库外跑(对照取证时它就是一份独立副本)
const ROOT = (() => {
  const a = process.argv.find(x => x.startsWith('--root='));
  return a ? path.resolve(a.slice(7)) : path.resolve(__dirname, '..');
})();
// 归一化:Anthropic 流的 message_start 里 id 是 `msg_${crypto.randomBytes(12).toString('hex')}`
// (lib/wire-responses.js 的 AnthropicStream.start),**每次都不同**。不归一化的话,
// 流式那几条的 body/chunk 摘要每跑一次都不一样,对照根本无从比 —— 我第一遍就栽在这里,
// 差点把自己的噪声当成"抽取改坏了行为"。
const normalize = buf => Buffer.from(
  buf.toString('utf8').replace(/msg_[0-9a-f]{24}/g, 'msg_<RAND24>'), 'utf8');
const sha = b => crypto.createHash('sha256').update(normalize(b)).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- 假上游
// 每个场景一个 app 的响应,返回 { status, headers, body, mode }
// mode: 'once' | 'stream' | 'rawjson'
function startUpstream(plan) {
  return new Promise(resolve => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body: raw });
        const p = plan(req, seen.length);
        res.writeHead(p.status, p.headers || { 'Content-Type': 'application/json' });
        if (p.chunks) { for (const c of p.chunks) res.write(c); res.end(); }
        else res.end(p.body || '');
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
  });
}

// 把若干条 SSE 帧拼起来(每帧自带 event/data 行,末尾补空行)
const sseRaw = frames => frames.map(f => f + '\n\n').join('');

// ---------------------------------------------------------------- 起 mixrouter
async function startRouter() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-eq-'));
  for (const d of ['home', 'data']) fs.mkdirSync(path.join(root, d), { mode: 0o700 });
  const data = path.join(root, 'data');
  const child = spawn(process.execPath, [path.join(ROOT, 'mixrouter.js')], {
    cwd: ROOT,
    env: {
      ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      MIXR_DATA_DIR: data, MIXROUTER_PORT: '0', MIXUI_PORT: '0', MIXROUTER_ALT_PORTS: '',
      MIXR_CLAUDE_SETTINGS: path.join(root, 'home', '.claude', 'settings.json'),
      MIXR_CODEX_CONFIG: path.join(root, 'home', '.codex', 'config.toml'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  const stderrAfterBanner = { text: '' };
  child.stdout.on('data', c => { out += c; });
  child.stderr.on('data', c => { err += c; });
  const t0 = Date.now();
  while (!/代理 :\d+/.test(out) && Date.now() - t0 < 20000) {
    if (child.exitCode !== null) throw new Error(`router 提前退出\n${out}\n${err}`);
    await new Promise(r => setTimeout(r, 50));
  }
  const m = [...out.matchAll(/代理 :(\d+)\(.*?控制台 http:\/\/([\d.]+):(\d+)/g)];
  if (!m.length) throw new Error(`没看到横幅\n${out}\n${err}`);
  // 横幅到手后 router 再往 stderr 写东西,一律当作**本次取证不可信**并立刻报出来。
  // 原先 stderr 只在"router 提前退出"那条错误路径里被带出,正常路径直接丢弃 ——
  // 于是任何被 router 吞掉/降级的异常都成了静默的背景噪声。
  // 本批踩过的真实形态:`--root` 指向不存在的路径时不是干净报错,而是崩在
  // startRouter 的裸 'error' 事件上;若它没走到退出分支,这份对照就会拿一份
  // **没跑起来的树**的摘要去和另一份比,而摘要相同这件事本身看不出任何异常。
  child.stderr.on('data', c => { stderrAfterBanner.text += c.toString(); });
  const last = m[m.length - 1];
  return { child, data, proxyPort: Number(last[1]), uiPort: Number(last[3]), root, stderrAfterBanner };
}

const request = (port, opts, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, ...opts }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, chunks, buf: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

// ---------------------------------------------------------------- 场景
// 每条场景返回一个"可序列化的观测",供前后对照
async function scenarios(rt, up) {
  const obs = [];
  const diag = [];
  global.__diag = diag;
  const addProvider = (name, port, kind, upstreamKind) => request(rt.uiPort, {
    method: 'POST', path: '/api/providers',
    headers: { 'Content-Type': 'application/json' },
  }, JSON.stringify({ app: kind, name, base_url: `http://127.0.0.1:${port}`, api_key: 'sk-eq-0001', wire_api: upstreamKind, models: kind === 'claude' ? ['claude-opus-5'] : ['gpt-5'] }))
    .then(r => JSON.parse(r.buf.toString()).id);

  // 两个维度独立:客户端要不要流(决定走哪条收尾) × 上游实际回了什么(决定走哪条分支)。
  // ⚠ 必须让上游的 Content-Type **独立**于客户端的 stream —— 第一版探针把两者绑在一起,
  // 结果「客户端要非流、上游却回 SSE」那条路径(sink≠null 那半)一次都没跑到,
  // 被抽取的那段代码等于没被证明。反证(注入 A 预期红 2 条实得 0 条)把它揪了出来。
  const REPLIES = ['json-ok', 'json-err', 'json-trunc', 'sse-ok', 'sse-trunc'];
  for (const [kind, upstreamKind] of [['claude', 'chat'], ['claude', 'responses']]) {
    for (const stream of [false, true]) {
      for (const reply of REPLIES) {
        const isChat = upstreamKind === 'chat';
        const okBody = JSON.stringify(isChat
          ? { id: 'c1', choices: [{ message: { role: 'assistant', content: 'EQ-OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } }
          : { id: 'r1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'EQ-OK' }] }], usage: { input_tokens: 11, output_tokens: 7 } });
        const errBody = JSON.stringify(isChat
          ? { error: { message: 'EQ-ERR', type: 'server_error' } }
          : { status: 'failed', error: { message: 'EQ-ERR', code: 'server_error' } });
        const okSse = sseRaw(isChat
          ? ['data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"EQ"}}]}',
             'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}',
             'data: [DONE]']
          : ['event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"EQ"}',
             'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":11,"output_tokens":7}}}']);
        const truncSse = isChat
          ? 'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"EQ"}}]}\n\n'
          : 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"EQ"}\n\n';
        const plan = () => {
          switch (reply) {
            case 'json-ok':    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: okBody };
            case 'json-err':   return { status: 200, headers: { 'Content-Type': 'application/json' }, body: errBody };
            case 'json-trunc': return { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"id":"x","cho' };
            case 'sse-ok':     return { status: 200, headers: { 'Content-Type': 'text/event-stream' }, chunks: [okSse] };
            default:           return { status: 200, headers: { 'Content-Type': 'text/event-stream' }, chunks: [truncSse] };
          }
        };
        const { srv, port } = await startUpstream(plan);
        const pid = await addProvider(`eq-${kind}-${upstreamKind}-${stream}-${reply}`, port, kind, upstreamKind);
        await request(rt.uiPort, { method: 'PUT', path: '/api/routes', headers: { 'Content-Type': 'application/json' } },
          JSON.stringify({ rules: [{ id: `eq-${reply}-${stream}-${upstreamKind}`, match: 'eqprobe', pool: [{ provider: pid, model: kind === 'claude' ? 'claude-opus-5' : 'gpt-5' }], strategy: 'priority', enabled: true }], default: { provider: '', model: '' } }));

        const r = await request(rt.proxyPort, {
          method: 'POST', path: '/v1/messages',
          headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': `eq:${reply}${stream}${upstreamKind}` },
        }, JSON.stringify({ model: 'eqprobe', max_tokens: 8, stream, messages: [{ role: 'user', content: 'hi' }] }));

        await new Promise(res => setTimeout(res, 150));
        const logFile = path.join(rt.data, 'logs', 'requests.jsonl');
        const logsRaw = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];
        const entries = logsRaw.map(l => JSON.parse(l)).filter(e => e.model_in === 'eqprobe');
        const e = entries[entries.length - 1] || {};
        obs.push({
          name: `${kind}|${upstreamKind}|client_stream=${stream}|up=${reply}`,
          status: r.status,
          ctype: (r.headers['content-type'] || '').split(';')[0],
          bodySha: sha(r.buf), bodyLen: r.buf.length,
          chunkCount: r.chunks.length, chunksSha: r.chunks.map(c => sha(c)).join(','),
          entry: { status: e.status, err: e.err || '', err_class: e.err_class || '', in: e.in ?? null, out: e.out ?? null, failover: !!e.failover },
        });
        diag.push({ name: `${kind}|${upstreamKind}|client_stream=${stream}|up=${reply}`, logsTotal: logsRaw.length, bodyHead: normalize(r.buf).toString('utf8').slice(0, 120) });
        srv.close();
      }
    }
  }
  return { obs, diag };
}

async function main() {
  const up = { srv: null };
  const rt = await startRouter();
  const { obs, diag } = await scenarios(rt, up);
  rt.child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 300));
  if (rt.child.exitCode === null) rt.child.kill('SIGKILL');
  fs.rmSync(rt.root, { recursive: true, force: true });
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ obs, diag }, null, 2)); return; }
  for (const o of obs) {
    console.log(`${o.name.padEnd(38)} -> ${String(o.status).padEnd(4)} ${o.ctype.split(';')[0].padEnd(18)} body=${o.bodySha}[${o.bodyLen}] chunks=${o.chunkCount} entry.status=${o.entry.status} err_class=${o.entry.err_class}`);
  }
  // 摘要**只覆盖观测体**(不含 diag),这样"字段全等"与"摘要相同"永远一致
  const digest = crypto.createHash('sha256').update(JSON.stringify(obs, Object.keys(obs[0]).sort())).digest('hex');
  console.log(`\nOBSERVATIONS=${obs.length}\nDIGEST_SHA256=${digest}`);
  // ⚠ 摘要可比的前提:两次跑必须真的都跑在这棵树上、且 router 没在背后报错。
  // 摘要只覆盖观测体,所以"同一份坏树跑两次"也会得到相同摘要 —— 那种绿是假的。
  if (rt.stderrAfterBanner.text.trim()) {
    console.error(`取证失败:router 在横幅之后往 stderr 写了内容,本次摘要不可信:\n${rt.stderrAfterBanner.text}`);
    process.exitCode = 1;
  }
  const srcSha = require('crypto').createHash('sha256')
    .update(require('fs').readFileSync(require('path').join(ROOT, 'lib', 'wire-anthropic-translator.js')))
    .digest('hex').slice(0, 16);
  console.log(`SRC wire-anthropic-translator.js=${srcSha}`);

}
main().catch(e => { console.error('取证脚本失败:', e); process.exit(1); });
