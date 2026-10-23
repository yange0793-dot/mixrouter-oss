'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { localOptions } = require('../lib/cli/local-options');
const { diagnose, formatReport, getLocalJson } = require('../lib/cli/doctor');
const { testEnv } = require('../scripts/run-tests');
const ROOT = path.resolve(__dirname, '..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['home', 'data', 'tmp']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  return root;
}
const options = root => ({ root: ROOT, home: path.join(root, 'home'), dataDir: path.join(root, 'data'),
  proxyPort: 19001, uiPort: 19002, offline: true });
const put = (dir, name, raw) => fs.writeFileSync(path.join(dir, name), JSON.stringify(raw), { mode: 0o600 });

async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => { s.closeAllConnections(); return new Promise(resolve => s.close(resolve)); });
  return s.address().port;
}

test('新入口默认固定数据目录,兼容环境覆盖与显式端口', t => {
  const root = fixture(t), home = path.join(root, 'home');
  const defaults = localOptions([], { root, home, env: {} });
  assert.equal(defaults.dataDir, path.join(home, '.local/share/mixrouter/data'));
  assert.equal(defaults.proxyPort, 8787);
  const custom = localOptions(['--data-dir', root, '--port', '19010'], { root, home,
    env: { MIXR_DATA_DIR: path.join(root, 'elsewhere'), MIXROUTER_PORT: '19011', MIXUI_PORT: '19012' } });
  assert.equal(custom.dataDir, root);
  assert.equal(custom.proxyPort, 19010);
  assert.equal(custom.uiPort, 19012);
});

test('参数错误与旧目录中的数据不会被静默忽略', t => {
  const root = fixture(t), context = { root, home: path.join(root, 'home'), env: {} };
  for (const args of [['--port', '0'], ['--port', '65536'], ['--port', 'NaN'], ['--port'],
    ['--data-dir', 'relative'], ['--port', '9000', '--ui-port', '9000'], ['--wat'],
    ['--port', '9000', '--port', '9001']]) assert.throws(() => localOptions(args, context));
  assert.throws(() => localOptions([], { ...context, env: { MIXR_INSTALL_PREFIX: 'relative' } }), /绝对路径/);
  put(root, 'providers.json', { claude: [], codex: [] });
  assert.equal(localOptions([], context).legacyData, true);
  assert.equal(localOptions(['--data-dir', root], context).legacyData, false);
});

test('首次离线自检不创建数据、不访问网络,警告不冒充失败', async t => {
  const root = fixture(t), opts = { ...options(root), dataDir: path.join(root, 'new-data') };
  const report = await diagnose(opts, { request: () => { throw new Error('不能联网'); } });
  assert.equal(report.ok, true);
  assert.equal(fs.existsSync(opts.dataDir), false);
  assert.ok(report.checks.some(c => c.id === 'providers.json' && c.status === 'warn'));
  assert.match(formatReport(report), /不调用上游/);
});

test('JSON 错误、过新版本与错误结构有明确提示且不泄露正文', async t => {
  const root = fixture(t), opts = options(root), secret = 'secret-value-should-never-appear';
  fs.writeFileSync(path.join(opts.dataDir, 'providers.json'), '{ "api_key": "' + secret, { mode: 0o600 });
  put(opts.dataDir, 'slots.json', { version: 999, claude: {} });
  put(opts.dataDir, 'routes.json', { rules: 'wrong' });
  const before = fs.readFileSync(path.join(opts.dataDir, 'providers.json'));
  const report = await diagnose(opts);
  assert.equal(report.ok, false);
  for (const id of ['providers.json', 'slots.json', 'routes.json'])
    assert.ok(report.checks.some(c => c.id === id && c.status === 'error'));
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.deepEqual(fs.readFileSync(path.join(opts.dataDir, 'providers.json')), before);
});

test('成功自检也不输出Key、渠道地址或会话标签', async t => {
  const root = fixture(t), opts = options(root);
  put(opts.dataDir, 'providers.json', { version: 2, claude: [{ name: 'private-name',
    api_key: 'secret-value', base_url: 'https://private.example.test' }], codex: [] });
  put(opts.dataDir, 'sessions.json', { version: 1, bindings: { session: { label: 'private-conversation' } } });
  const report = await diagnose(opts);
  assert.equal(report.ok, true);
  for (const secret of ['private-name', 'secret-value', 'private.example', 'private-conversation'])
    assert.ok(!JSON.stringify(report).includes(secret));
});

test('本机服务停止是警告,占用或损坏响应是错误', async t => {
  const opts = { ...options(fixture(t)), offline: false };
  const offline = await diagnose(opts, { request: async () => ({ kind: 'offline' }) });
  assert.equal(offline.ok, true);
  const foreign = await diagnose(opts, { request: async () => ({ kind: 'response', status: 200, body: { ok: true } }) });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.checks.filter(c => c.status === 'error').length, 2);
});

test('服务源码身份可核对,不回显 API 里的私有字段', async t => {
  const opts = { ...options(fixture(t)), offline: false };
  const { codeRevision } = require('../lib/runtime-code');
  const report = await diagnose(opts, { request: async (_port, url) => ({ kind: 'response', status: 200,
    body: url === '/healthz' ? { ok: true, service: 'mixrouter' }
      : { pid: 1, code_revision: codeRevision(ROOT), providers: {}, private: 'hidden-api-value' } }) });
  assert.equal(report.ok, true);
  assert.ok(report.checks.some(c => c.id === 'loaded_code' && c.status === 'ok'));
  assert.ok(!JSON.stringify(report).includes('hidden-api-value'));
});

test('HTTP 自检有总超时,不跟随重定向', async t => {
  let redirected = 0;
  const target = await server(t, (_req, res) => { redirected++; res.end('{}'); });
  const source = await server(t, (_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${target}/` }); res.end('{}'); });
  const result = await getLocalJson(source, '/healthz');
  assert.equal(result.status, 302);
  assert.equal(redirected, 0);
  const hanging = await server(t, () => {});
  assert.equal((await getLocalJson(hanging, '/healthz', 40)).kind, 'timeout');
});

test('doctor CLI JSON 可解析,无配置首次使用退出 0', t => {
  const root = fixture(t), env = testEnv(process.env, root);
  env.MIXROUTER_PORT = '19001'; env.MIXUI_PORT = '19002';
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/doctor.js'), '--offline', '--json'],
    { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data')), []);
});

test('local 真实启动与停止,默认固定数据目录,客户端配置不动', { timeout: 15000 }, async t => {
  const root = fixture(t), env = testEnv(process.env, root);
  delete env.MIXR_DATA_DIR;
  const dataDir = path.join(root, 'home', '.local', 'share', 'mixrouter', 'data');
  async function freePort() {
    const s = http.createServer();
    await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
    const p = s.address().port;
    await new Promise(resolve => s.close(resolve));
    return p;
  }
  const proxy = await freePort(), ui = await freePort();
  assert.notEqual(proxy, ui);
  assert.ok(![8787, 8788].includes(proxy) && ![8787, 8788].includes(ui));
  fs.mkdirSync(path.dirname(env.MIXR_CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(env.MIXR_CLAUDE_SETTINGS, '{"sentinel":true}');
  // 模拟干净安装包,不能让源码仓库里正在使用的真实数据触发旧安装保护。
  const appRoot = path.join(root, 'app');
  fs.mkdirSync(appRoot);
  for (const item of require('../lib/paths').RELEASE_ITEMS)
    fs.cpSync(path.join(ROOT, item), path.join(appRoot, item), { recursive: true });
  const child = spawn(process.execPath, [path.join(appRoot, 'scripts/start-local.js'), '--port', String(proxy), '--ui-port', String(ui)],
    { env, cwd: appRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exit; } });
  const deadline = Date.now() + 8000;
  let response;
  while (Date.now() < deadline && child.exitCode === null) {
    response = await getLocalJson(proxy, '/healthz', 200);
    if (response.body && response.body.service === 'mixrouter') break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(response && response.body && response.body.service, 'mixrouter', output);
  child.kill('SIGTERM');
  assert.deepEqual(await exit, { code: 0, signal: null }, output);
  assert.equal(fs.readFileSync(env.MIXR_CLAUDE_SETTINGS, 'utf8'), '{"sentinel":true}');
  assert.ok(fs.existsSync(path.join(dataDir, 'providers.json')));
  assert.deepEqual(fs.readdirSync(path.join(root, 'data')), []);
  assert.equal((await getLocalJson(proxy, '/healthz')).kind, 'offline');
});
