'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { codeRevision } = require('../lib/runtime-code');

function run(args, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'mixctl'), ...args], {
      env: { ...process.env, MIXUI_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

test('mixctl status 比较运行源码指纹,旧进程和未知版本不得报告已生效', async t => {
  let revision = codeRevision(path.join(__dirname, '..'));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      version: 'test', uptime_s: 61, proxy_port: 8787, ui_port: 8788,
      code_revision: revision, stats: { reqs: 0, inTok: 0, outTok: 0 },
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const current = await run(['status'], port);
  assert.equal(current.code, 0);
  assert.match(current.output, /已加载当前源码/);
  revision = 'outdated';
  const stale = await run(['status'], port);
  assert.equal(stale.code, 1);
  assert.match(stale.output, /源码已更新,运行进程仍是旧版/);
  assert.match(stale.output, /mixctl restart/);
  revision = undefined;
  const unknown = await run(['status'], port);
  assert.equal(unknown.code, 1);
  assert.match(unknown.output, /无法核对已加载版本/);
  assert.doesNotMatch(unknown.output, /已加载当前源码/);
  assert.deepEqual(requests, Array.from({ length: 3 }, () => ({ method: 'GET', url: '/api/state' })),
    '状态检查只读,不自动重启或写配置');
});

test('mixctl route zcode sends protocol and describes registration rather than active-session switching', async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, live: { base_url: 'http://127.0.0.1:8787/v1' } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  for (const wire of ['anthropic', 'responses', 'chat']) {
    const result = await run(['route', 'zcode', wire], port);
    assert.equal(result.code, 0);
    assert.match(result.output, /已注册路由接入:ZCode/);
    assert.match(result.output, /未修改当前会话或默认模型/);
    assert.deepEqual(requests.pop(), { path: '/api/router/zcode', body: { wire_api: wire } });
  }
  await run(['route', 'zcode'], port);
  assert.equal(requests.pop().body.wire_api, 'anthropic');
  await run(['route', 'claude'], port);
  assert.deepEqual(requests.pop(), { path: '/api/router/claude', body: {} });
  const invalid = await run(['route', 'zcode', 'invalid'], port);
  assert.match(invalid.output, /协议必须/);
  assert.equal(requests.length, 0);
});

test('mixctl split --apply:服务端带回的备份轮换预警要打在终端上', async t => {
  // /api/claude/split 的 warnings 里并着两份:渠道库那份(drainStoreWarnings)与客户端配置那份
  // (switchClaudeRouter → backupWithWatch)。池满时最老那份在本次写入过程中已经被清掉,
  // 只留在服务端日志里的话,命令行用户看不见 —— 而这条命令恰好就是"改客户端配置"的那条。
  const WARN = '本次备份将顶掉 1 份 —— providers.json.bak-mixui-20260101-000000-000-abcd。';
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        ok: true, applied: true, warnings: [WARN],
        slots: [{ name: 'main', provider_name: 'Alpha', model: 'm' }, { name: 'subagent', provider_name: 'Beta', model: 'm2' }],
      }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const applied = await run(['split', 'p1', 'm', 'p2', 'm2', '--apply'], port);
  assert.equal(applied.code, 0);
  assert.ok(applied.output.includes(WARN), `预警必须露面;实得 ${JSON.stringify(applied.output)}`);
  assert.match(applied.output, /已写入 Claude Code 路由别名/, '成功那句不能被顶掉');
  assert.deepEqual(requests.pop(), {
    path: '/api/claude/split',
    body: { main: { provider: 'p1', model: 'm' }, subagent: { provider: 'p2', model: 'm2' }, apply: true },
  });
});

test('mixctl route:服务端带回的备份轮换预警要打在终端上(切换也会写渠道库)', async t => {
  // /api/router 写渠道库(saveStore),池满时会轮换掉最老那份备份 —— 它带的 warnings
  // 里既有客户端配置那份、也有渠道库那份。命令行不打印出来,用户就只看到"已切到路由模式"。
  const WARN = '本次备份将顶掉 1 份 —— providers.json.bak-mixui-20260101-000000-000-abcd。';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, live: { base_url: 'http://127.0.0.1:8787' }, warnings: [WARN] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const r = await run(['route', 'claude'], port);
  assert.equal(r.code, 0);
  assert.ok(r.output.includes(WARN), `预警必须露面;实得 ${JSON.stringify(r.output)}`);
  assert.match(r.output, /已切到路由模式/, '成功那句不能被顶掉');
});


test('mixctl explain 把模型名 POST 给 /api/routing/preview 并渲染预测落点/提醒', async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      requests.push({ path: req.url, body: parsed });
      res.setHeader('Content-Type', 'application/json');
      // 按请求的 model 返回不同预测:命中槽位 vs 落回兜底
      if (parsed.model === 'mixr-haiku') {
        res.end(JSON.stringify({ ok: true, input: { app: 'claude', model: 'mixr-haiku', kind: 'messages' },
          matched: { via: 'slot', ruleId: null, slot: 'haiku', strategy: 'round_robin' },
          selection: { strategy: 'round_robin', deterministic: true,
            predicted: { providerId: 'pa', providerName: '大渠道', model: 'deepseek-v4-flash', enabled: true, cooldown: false } },
          effective: [{ providerId: 'pa', providerName: '大渠道', model: 'deepseek-v4-flash', enabled: true, cooldown: false }],
          warnings: [], ghosts: [] }));
      } else {
        res.end(JSON.stringify({ ok: true, input: { app: 'claude', model: 'mixr-opus', kind: 'messages' },
          matched: { via: 'default', ruleId: null, slot: null, strategy: 'round_robin' },
          selection: { strategy: 'round_robin', deterministic: true, predicted: null }, effective: [],
          warnings: [{ code: 'slot_fell_through', message: '模型名 "mixr-opus" 像槽位别名,但槽位表里没有它' }], ghosts: [] }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const hit = await run(['explain', 'mixr-haiku'], port);
  assert.equal(hit.code, 0);
  assert.deepEqual(requests.at(-1), { path: '/api/routing/preview', body: { app: 'claude', model: 'mixr-haiku' } });
  assert.match(hit.output, /命中: slot/);
  assert.match(hit.output, /大渠道 \(pa\) @ deepseek-v4-flash/);

  const miss = await run(['explain', 'mixr-opus'], port);
  assert.equal(miss.code, 0);
  assert.match(miss.output, /命中: default \(兜底\)/);
  assert.match(miss.output, /slot_fell_through/);

  // 缺模型名 → 用法提示 + 非零退出,且不打服务端
  const before = requests.length;
  const usage = await run(['explain'], port);
  assert.equal(usage.code, 1);
  assert.match(usage.output, /mixctl explain/);
  assert.equal(requests.length, before, '缺参数时不应发预览请求');

  // 位置式解析:flag 值等于 'codex' 不得把预览的 app 翻成 codex
  await run(['explain', 'mixr-haiku', '--ua', 'codex'], port);
  assert.deepEqual(requests.at(-1).body, { app: 'claude', model: 'mixr-haiku', context: { ua: 'codex' } },
    "flag 值 'codex' 不能被当成组选择器");
  // 位置式解析:模型名正好等于某 flag 值时,仍能被识别为模型(不误报缺模型)
  await run(['explain', 'mixr-haiku', '--body', 'mixr-haiku'], port);
  assert.deepEqual(requests.at(-1).body, { app: 'claude', model: 'mixr-haiku', context: { bodyText: 'mixr-haiku' } },
    '与 flag 值同名的模型仍应被识别');
  // 会话键按完整前缀键校验(cc:/cx:/fp:/cxf:),短 id 在本地就被拦下
  const shortId = await run(['explain', 'mixr-haiku', '--session', 'mixr-haiku'], port);
  assert.equal(shortId.code, 1);
  assert.match(shortId.output, /完整会话键/);
  await run(['explain', 'mixr-haiku', '--session', 'cc:full-key-here'], port);
  assert.deepEqual(requests.at(-1).body, { app: 'claude', model: 'mixr-haiku', context: { session: 'cc:full-key-here' } });
});

test('mixctl gc:默认预览不动盘,--apply 才清理,且只碰 logs/ 下的本模块产物', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-gc-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const logs = path.join(dataDir, 'logs');
  const resp = path.join(logs, 'responses');
  const OLD = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  const oldId = `${Date.now() - 5 * 24 * 3600 * 1000}-${'a'.repeat(32)}`;
  fs.mkdirSync(path.join(resp, oldId), { recursive: true });
  fs.writeFileSync(path.join(logs, 'requests.jsonl'), JSON.stringify({ ts: OLD, app: 'claude' }) + '\n');

  const runGc = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'mixctl'), ...args], {
      env: { ...process.env, MIXR_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', c => { output += c; });
    child.stderr.on('data', c => { output += c; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });

  const preview = await runGc(['gc']);
  assert.equal(preview.code, 0);
  assert.match(preview.output, /预览/);
  assert.equal(fs.existsSync(path.join(resp, oldId)), true, '预览不得删目录');

  const applied = await runGc(['gc', '--apply']);
  assert.equal(applied.code, 0);
  assert.equal(fs.existsSync(path.join(resp, oldId)), false, '--apply 应删超期归档');
  assert.equal(fs.existsSync(path.join(logs, 'requests.jsonl')), true, '活跃日志保留文件本身');
});

test('mixctl gc --archives-only:只删 responses 归档,活跃日志逐字节不动', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-gc-archonly-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const logs = path.join(dataDir, 'logs');
  const resp = path.join(logs, 'responses');
  const FIVE = 5 * 24 * 3600 * 1000;
  const OLD = new Date(Date.now() - FIVE).toISOString();
  const FRESH = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const oldId = `${Date.now() - FIVE}-${'a'.repeat(32)}`;
  const freshId = `${Date.now() - 24 * 3600 * 1000}-${'b'.repeat(32)}`;
  fs.mkdirSync(path.join(resp, oldId), { recursive: true });
  fs.mkdirSync(path.join(resp, freshId), { recursive: true });
  // 活跃产物全部放超期内容:archiveOnly 下必须一字不改
  const reqBody = JSON.stringify({ ts: OLD, app: 'claude' }) + '\n';
  const rotBody = JSON.stringify({ ts: OLD, app: 'claude' }) + '\n';
  const logBody = `${OLD} boot\n`;
  fs.writeFileSync(path.join(logs, 'requests.jsonl'), reqBody);
  fs.writeFileSync(path.join(logs, 'requests.jsonl.old'), rotBody);
  fs.writeFileSync(path.join(logs, 'launchd.log'), logBody);

  const runGc = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'mixctl'), ...args], {
      env: { ...process.env, MIXR_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', c => { output += c; });
    child.stderr.on('data', c => { output += c; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });

  const applied = await runGc(['gc', '--archives-only', '--apply']);
  assert.equal(applied.code, 0);
  assert.match(applied.output, /仅 responses 归档/, '输出应标明只清归档');
  assert.equal(fs.existsSync(path.join(resp, oldId)), false, '超期归档应删除');
  assert.equal(fs.existsSync(path.join(resp, freshId)), true, '窗内归档保留');
  assert.equal(fs.readFileSync(path.join(logs, 'requests.jsonl'), 'utf8'), reqBody, 'requests.jsonl 逐字节不动');
  assert.equal(fs.readFileSync(path.join(logs, 'requests.jsonl.old'), 'utf8'), rotBody, '.old 逐字节不动');
  assert.equal(fs.readFileSync(path.join(logs, 'launchd.log'), 'utf8'), logBody, 'launchd.log 逐字节不动');
});

test('mixctl logs:尾读渲染、坏行跳过,且尊重 MIXR_DATA_DIR', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-logs-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const logs = path.join(dataDir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const row = i => JSON.stringify({
    ts: `2026-09-19T10:${String(i).padStart(2, '0')}:00.000Z`, app: i % 2 ? 'codex' : 'claude',
    session: 's' + i, provider: 'FAKE-渠道', model_in: 'm-in-' + i, model_out: 'm-out-' + i,
    in: i, out: i * 2, ms: i, status: 200,
  });
  // 中间夹一条坏行:旧实现会因它整批抛出
  fs.writeFileSync(path.join(logs, 'requests.jsonl'), [row(1), '{ 坏行', row(2), row(3)].join('\n') + '\n');

  // `mixctl logs` 先探控制台、连不上才退回读本机文件(见 mixctl 的 logsCmd)。
  // 本机要是正跑着一个真控制台(默认 8788),它就会走 API 拿到**线上**日志,
  // 这条"尊重 MIXR_DATA_DIR"的断言就变成在看别人的数据。指向一个不可能在听的端口
  // (1 号端口要 root 才绑得上),让它稳定走离线尾读 —— 这才是这条用例要验的那条路。
  const runLogs = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'mixctl'), ...args], {
      env: { ...process.env, MIXR_DATA_DIR: dataDir, MIXUI_PORT: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', c => { output += c; });
    child.stderr.on('data', c => { output += c; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });

  const two = await runLogs(['logs', '2']);
  assert.equal(two.code, 0);
  assert.match(two.output, /m-in-3/, '应显示最后一条');
  assert.match(two.output, /m-in-2/, '应显示倒数第二条');
  assert.doesNotMatch(two.output, /m-in-1/, '不应显示窗口外的一条');
  assert.doesNotMatch(two.output, /暂无请求日志/, '坏行不得吞掉整批');
  assert.equal((two.output.match(/→/g) || []).length, 2, '恰好两行');
  const three = await runLogs(['logs', '3']);
  assert.equal(three.code, 0);
  assert.equal((three.output.match(/→/g) || []).length, 3, '跨过坏行继续取够三条');
  assert.doesNotMatch(three.output, /暂无请求日志/);

  fs.writeFileSync(path.join(logs, 'requests.jsonl'), '');
  const empty = await runLogs(['logs']);
  assert.equal(empty.code, 0);
  assert.match(empty.output, /暂无请求日志/);

  const { DEFAULT_MAX_BYTES } = require('../lib/observability/log-tail');
  fs.writeFileSync(path.join(logs, 'requests.jsonl'), row(1) + '\n' + 'x'.repeat(DEFAULT_MAX_BYTES + 1));
  const capped = await runLogs(['logs', '1']);
  assert.equal(capped.code, 0);
  assert.match(capped.output, /达到上限或文件在读取期间被截短/);
  assert.doesNotMatch(capped.output, /暂无请求日志/, '未读到不等于文件里没有记录');
});
