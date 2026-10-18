'use strict';
// 对照取证:把「上游 SSE → Anthropic SSE」的转发骨架抽到 lib/upstream-relay.js 前后,
// 客户端收到的字节与 requests.jsonl 条目是否**逐字节相同**。
//
// 用法(在仓库根):
//   node evidence/upstream-relay-extract.equivalence.js                 # 打印摘要
//   node evidence/upstream-relay-extract.equivalence.js --json          # 全量机器可读
//   node evidence/upstream-relay-extract.equivalence.js --root=<树>     # 换一棵树跑(前后对照)
//
// 为什么要单独一份(而不是复用 translator 那份):那一份的上游回法是
// {整包 JSON, SSE 正常, SSE 截断} 三类,只走到骨架的 commit / settle / end 三条路径。
// 本次抽的骨架里还有三条**没有被它覆盖**:close/error 触发的 transportDead、
// [DONE]-与-终态信号的分歧(onEnd 里各线自己的判法)、提交前 rawPre 的 terminalError 试认。
// 漏掉这三条就与"抽了却没证明"无异 —— 上一份探针第一版正是这么栽的(见其 L115-117)。
//
// 观测维度(两条独立轴,不许绑在一起):
//   客户端要不要流(client_stream) × 上游实际回什么(up) × 上游是哪条线(kind)
// 每条观测记四样:HTTP 状态与响应头、响应体逐字节 sha256、客户端收到的 RAW chunk 切分、
// requests.jsonl 里那条 entry。前后两棵树跑同一套,摘要相同即等价。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// ROOT 可用 --root=<路径> 覆盖:对照取证时脚本本体留在仓里,只把"跑哪棵树"换掉
const ROOT = (() => {
  const a = process.argv.find(x => x.startsWith('--root='));
  return a ? path.resolve(a.slice(7)) : path.resolve(__dirname, '..');
})();

// 归一化:Anthropic 流的 message_start 里 id 是 `msg_${randomBytes(12).hex}`,每次都不同。
// 不归一化则流式那几条每跑一次摘要都变,对照根本无从比。
const normalize = buf => Buffer.from(
  buf.toString('utf8').replace(/msg_[0-9a-f]{24}/g, 'msg_<RAND24>'), 'utf8');
const sha = b => crypto.createHash('sha256').update(normalize(b)).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- 假上游
// plan(req, nth) 返回 { status, headers, body?, chunks?, destroyAfter? }
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
        if (p.chunks) {
          for (const c of p.chunks) res.write(c);
          if (p.destroyAfter) { res.socket.destroy(); return; } // 上游中途断连:走 close/error
          res.end();
        } else res.end(p.body || '');
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
  });
}

const sseRaw = frames => frames.map(f => f + '\n\n').join('');

// ---------------------------------------------------------------- 起 mixrouter
async function startRouter() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-eq-'));
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

// ---------------------------------------------------------------- 上游回法
// 每条都是一个完整的 SSE 故事。chat 的终态信号是 [DONE] 或 finish_reason;
// responses 只有事件本身(response.completed/failed/incomplete 或 error 事件)。
const CHAT = {
  ok: () => ({ ctype: 'text/event-stream', chunks: [sseRaw([
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"EQ"}}]}',
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}',
    'data: [DONE]',
  ])] }),
  // 给了 finish_reason 却一直没等到 [DONE],然后上游关连接:按 chat 的判法这**不算夭折**
  nodone: () => ({ ctype: 'text/event-stream', chunks: [sseRaw([
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"EQ"}}]}',
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  ])] }),
  // 只有内容,两个终态信号都没有:夭折
  trunc: () => ({ ctype: 'text/event-stream', chunks: [
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"EQ"}}]}\n\n',
  ] }),
  // 内容发到一半上游直接掐断 socket:走 close/error 那条 transportDead
  abort: () => ({ ctype: 'text/event-stream', destroyAfter: true, chunks: [
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"EQ"}}]}\n\n',
  ] }),
  // 流里夹一条错误事件
  errev: () => ({ ctype: 'text/event-stream', chunks: [sseRaw([
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"EQ"}}]}',
    'data: {"error":{"message":"EQ-STREAM-ERR","type":"server_error"}}',
  ])] }),
  // 说是 SSE,正文其实是裸 JSON 错误体(渠道池打满那种):提交前的 terminalError 试认
  fakeseek: () => ({ ctype: 'text/event-stream', body: '{"error":{"message":"EQ-TERM","type":"server_error"}}' }),
};
const RESPONSES = {
  ok: () => ({ ctype: 'text/event-stream', chunks: [sseRaw([
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"EQ"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":11,"output_tokens":7}}}',
  ])] }),
  // 终态事件写了 incomplete:骨架照转,但 conv 的终态是 incomplete(不是 completed)
  nodone: () => ({ ctype: 'text/event-stream', chunks: [sseRaw([
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"EQ"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":11,"output_tokens":7}}}',
  ])] }),
  trunc: () => ({ ctype: 'text/event-stream', chunks: [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"EQ"}\n\n',
  ] }),
  abort: () => ({ ctype: 'text/event-stream', destroyAfter: true, chunks: [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"EQ"}\n\n',
  ] }),
  errev: () => ({ ctype: 'text/event-stream', chunks: [sseRaw([
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"EQ"}',
    'event: error\ndata: {"type":"error","error":{"message":"EQ-STREAM-ERR","type":"server_error"}}',
  ])] }),
  fakeseek: () => ({ ctype: 'text/event-stream', body: '{"status":"failed","error":{"message":"EQ-TERM","code":"server_error"}}' }),
};
// 完全不是 SSE 的上游(走整包 JSON 那条收尾,不经骨架;留着当前后对照的基线)
const JSON_REPLIES = {
  'json-ok': isChat => ({ ctype: 'application/json', body: JSON.stringify(isChat
    ? { id: 'c1', choices: [{ message: { role: 'assistant', content: 'EQ-OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } }
    : { id: 'r1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'EQ-OK' }] }], usage: { input_tokens: 11, output_tokens: 7 } }) }),
  'json-err': isChat => ({ ctype: 'application/json', body: JSON.stringify(isChat
    ? { error: { message: 'EQ-ERR', type: 'server_error' } }
    : { status: 'failed', error: { message: 'EQ-ERR', code: 'server_error' } }) }),
  'json-trunc': () => ({ ctype: 'application/json', body: '{"id":"x","cho' }),
};

// ---------------------------------------------------------------- 场景
async function scenarios(rt) {
  const obs = [];
  const addProvider = (name, port, kind, upstreamKind) => request(rt.uiPort, {
    method: 'POST', path: '/api/providers',
    headers: { 'Content-Type': 'application/json' },
  }, JSON.stringify({ app: kind, name, base_url: `http://127.0.0.1:${port}`, api_key: 'sk-eq-0001', wire_api: upstreamKind, models: kind === 'claude' ? ['claude-opus-5'] : ['gpt-5'] }))
    .then(r => JSON.parse(r.buf.toString()).id);

  for (const upstreamKind of ['chat', 'responses']) {
    const isChat = upstreamKind === 'chat';
    const table = isChat ? CHAT : RESPONSES;
    const replies = [...Object.keys(table), ...Object.keys(JSON_REPLIES)];
    for (const stream of [false, true]) {
      for (const reply of replies) {
        const plan = () => {
          const p = table[reply] ? table[reply]() : JSON_REPLIES[reply](isChat);
          return { status: 200, headers: { 'Content-Type': p.ctype }, body: p.body, chunks: p.chunks, destroyAfter: p.destroyAfter };
        };
        const { srv, port } = await startUpstream(plan);
        const pid = await addProvider(`eq-${upstreamKind}-${stream}-${reply}`, port, 'claude', upstreamKind);
        await request(rt.uiPort, { method: 'PUT', path: '/api/routes', headers: { 'Content-Type': 'application/json' } },
          JSON.stringify({ rules: [{ id: `eq-${reply}-${stream}-${upstreamKind}`, match: 'eqprobe', pool: [{ provider: pid, model: 'claude-opus-5' }], strategy: 'priority', enabled: true }], default: { provider: '', model: '' } }));

        const r = await request(rt.proxyPort, {
          method: 'POST', path: '/v1/messages',
          headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': `eq:${reply}${stream}${upstreamKind}` },
        }, JSON.stringify({ model: 'eqprobe', max_tokens: 8, stream, messages: [{ role: 'user', content: 'hi' }] }));

        await new Promise(res => setTimeout(res, 200));
        const logFile = path.join(rt.data, 'logs', 'requests.jsonl');
        const logsRaw = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];
        const entries = logsRaw.map(l => JSON.parse(l)).filter(e => e.model_in === 'eqprobe');
        const e = entries[entries.length - 1] || {};
        obs.push({
          name: `${upstreamKind}|client_stream=${stream}|up=${reply}`,
          status: r.status,
          ctype: (r.headers['content-type'] || '').split(';')[0],
          bodySha: sha(r.buf), bodyLen: r.buf.length,
          chunkCount: r.chunks.length, chunksSha: r.chunks.map(c => sha(c)).join(','),
          entry: { status: e.status, err: e.err || '', err_class: e.err_class || '', in: e.in ?? null, out: e.out ?? null, failover: !!e.failover, attempts: e.attempts ?? null },
        });
        srv.close();
      }
    }
  }
  return obs;
}

async function main() {
  const rt = await startRouter();
  const obs = await scenarios(rt);
  rt.child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 300));
  if (rt.child.exitCode === null) rt.child.kill('SIGKILL');
  fs.rmSync(rt.root, { recursive: true, force: true });
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ root: ROOT, obs }, null, 2)); return; }
  for (const o of obs) {
    console.log(`${o.name.padEnd(34)} -> ${String(o.status).padEnd(4)} ${o.ctype.padEnd(18)} body=${o.bodySha}[${o.bodyLen}] chunks=${o.chunkCount} entry.status=${o.entry.status} err_class=${o.entry.err_class} attempts=${o.entry.attempts}`);
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify(obs, Object.keys(obs[0]).sort())).digest('hex');
  console.log(`\nROOT=${ROOT}\nOBSERVATIONS=${obs.length}\nDIGEST_SHA256=${digest}`);
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
