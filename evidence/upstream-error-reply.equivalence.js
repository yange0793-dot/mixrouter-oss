'use strict';
// 对照取证:把「上游 4xx/5xx 错误体 → 客户端」这一段的取值逻辑抽到
// lib/upstream-error-text.js 前后,客户端字节与 requests.jsonl 是否逐字节相同。
//
// 为什么必须单独一份:已有的两份端到端探针(translator / relay)**上游恒回 200**
// (源码里 `return { status: 200, ... }` 写死),所以本次重构所在的**整条错误路径
// 一条都没被覆盖**。拿"804 个测试全绿"当等价性证据是不够的 —— 那些测试里没有一条
// 走真上游 4xx。
//
// 覆盖维度(互相独立,不许绑在一起):
//   A. 上游线路 3 种:chat 翻译线 / responses 翻译线 / anthropic 直通线
//      这三条**有意不同**:前两条落日志用 errLine(纯截断)+ 手写 Anthropic 错误体,
//      第三条用 errLineOrPlaceholder(带空体占位)+ sendErr(状态码原样转发)。
//   B. 客户端要不要流(stream true/false)
//   C. 上游错误体的形状 7 种(见 ERR_BODIES)—— 这一维才是本次抽取的核心:
//      取值表达式要能从 JSON 的 error.message / error(字符串) / error(对象) /
//      顶层 message / 非 JSON 正文 / 空体 里各自抠出正确的东西,且**不能把原文吞掉**。
//
// 用法(仓库根):
//   node evidence/upstream-error-reply.equivalence.js                 # 打印摘要
//   node evidence/upstream-error-reply.equivalence.js --root=<树>     # 换一棵树跑
//   node evidence/upstream-error-reply.equivalence.js --json

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = (() => {
  const a = process.argv.find(x => x.startsWith('--root='));
  return a ? path.resolve(a.slice(7)) : path.resolve(__dirname, '..');
})();

const normalize = buf => Buffer.from(
  buf.toString('utf8').replace(/msg_[0-9a-f]{24}/g, 'msg_<RAND24>'), 'utf8');
const sha = b => crypto.createHash('sha256').update(normalize(b)).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- 上游错误体形状
// 这一维是本次抽取的核心:取值表达式必须对每种形状给出**同一个**结果。
const ERR_BODIES = {
  'json-error-message': () => JSON.stringify({ error: { message: 'EQ-UPSTREAM-MSG', type: 'server_error' } }),
  'json-error-string':  () => JSON.stringify({ error: 'EQ-UPSTREAM-STR' }),
  'json-error-object':  () => JSON.stringify({ error: { code: 'rate_limited', detail: 'EQ-DETAIL' } }),
  'json-top-message':   () => JSON.stringify({ message: 'EQ-TOP-MSG' }),
  'json-bare':          () => JSON.stringify({ status: 'failed' }),
  'html':               () => '<!doctype html><html><body>502 Bad Gateway</body></html>',
  'plain':              () => 'upstream exploded',
  'empty':              () => '',
  // 带首尾空白的 JSON:两条线的日志写法在"是否 trim"上**有意不同**,必须分别观察
  'json-padded':        () => '   ' + JSON.stringify({ error: { message: 'EQ-PADDED' } }) + '   ',
};

function startUpstream(status, bodyOf) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(bodyOf());
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

async function startRouter() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'err-eq-'));
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

async function scenarios(rt) {
  const obs = [];
  const addProvider = (name, port, upstreamKind) => request(rt.uiPort, {
    method: 'POST', path: '/api/providers',
    headers: { 'Content-Type': 'application/json' },
  }, JSON.stringify({ app: 'claude', name, base_url: `http://127.0.0.1:${port}`, api_key: 'sk-eq-0001', wire_api: upstreamKind, models: ['claude-opus-5'] }))
    .then(r => JSON.parse(r.buf.toString()).id);

  for (const upstreamKind of ['chat', 'responses', 'anthropic']) {
    for (const status of [400, 429, 500, 503]) {
      for (const bodyName of Object.keys(ERR_BODIES)) {
        for (const stream of [false, true]) {
          const { srv, port } = await startUpstream(status, ERR_BODIES[bodyName]);
          const pid = await addProvider(`eq-${upstreamKind}-${status}-${bodyName}-${stream}`, port, upstreamKind);
          await request(rt.uiPort, { method: 'PUT', path: '/api/routes', headers: { 'Content-Type': 'application/json' } },
            JSON.stringify({ rules: [{ id: `eq-${bodyName}-${status}-${stream}-${upstreamKind}`, match: 'eqprobe', pool: [{ provider: pid, model: 'claude-opus-5' }], strategy: 'priority', enabled: true }], default: { provider: '', model: '' } }));

          const r = await request(rt.proxyPort, {
            method: 'POST', path: '/v1/messages',
            headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': `eqe:${bodyName}:${status}:${stream}:${upstreamKind}` },
          }, JSON.stringify({ model: 'eqprobe', max_tokens: 8, stream, messages: [{ role: 'user', content: 'hi' }] }));

          await new Promise(res => setTimeout(res, 120));
          const logFile = path.join(rt.data, 'logs', 'requests.jsonl');
          const logsRaw = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];
          const entries = logsRaw.map(l => JSON.parse(l)).filter(e => e.model_in === 'eqprobe');
          const e = entries[entries.length - 1] || {};
          obs.push({
            name: `${upstreamKind}|${status}|${bodyName}|stream=${stream}`,
            status: r.status,
            ctype: (r.headers['content-type'] || '').split(';')[0],
            bodySha: sha(r.buf), bodyLen: r.buf.length,
            chunkCount: r.chunks.length, chunksSha: r.chunks.map(c => sha(c)).join(','),
            // entry.err 是本次抽取的核心可观测物:两条翻译线用 errLine,直通线用 errLineOrPlaceholder
            entry: { status: e.status, err: e.err || '', err_class: e.err_class || '', attempts: e.attempts ?? null },
          });
          srv.close();
        }
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
    console.log(`${o.name.padEnd(42)} -> ${String(o.status).padEnd(4)} body=${o.bodySha}[${o.bodyLen}] entry.err=${JSON.stringify(o.entry.err).slice(0, 60)}`);
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
