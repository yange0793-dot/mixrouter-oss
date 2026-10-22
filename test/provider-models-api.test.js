'use strict';
// POST /api/providers/models 的接口契约回归:真实主入口 apiHandler + 回环假上游。
//
// 钉的是这几件事(与 lib/provider-models.js 的单元测试分工不同,这里只看**接口**):
//   · 未保存渠道要 URL+Key;只给一半 → 400;非法 URL → 400,且不发出上游请求
//   · 已保存渠道用库里字段兜底;空 api_key 按 key_id / active_key 经 ringOf 解析(klegacy 支持)
//   · 显式非空 api_key 覆盖库里的 Key;未知 key_id 拒绝
//   · 上游 HTTP 错误 / 坏格式 / 超字节 → 502;超时 → 504(整段 15s 默认预算)
//   · 成功只回 { models },不泄漏 Key;也不把上游错误体(可能回显 Key)抄回来
//   · 调用不改渠道库、不落盘、不写请求日志
//   · 新端点在 /api/providers/:id 之前被匹配(否则会被当成 id=models 的渠道,404)
//
// 不联网、不用真实凭据;端口一律 listen(0)。临时 HOME/MIXR_DATA_DIR 由 scripts/run-tests.js 隔离。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-models-api-'));
process.env.HOME = TMP;
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude-settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex-config.toml');
process.env.MIXR_ZCODE_CONFIG = path.join(TMP, 'zcode-config.json');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXROUTER_PORT = '0';
process.env.MIXUI_PORT = '0';

const mod = require('../mixrouter');

let ui;
let uiPort;
let upstream;
let upstreamPort;
let respond = (res) => send(res, { data: [{ id: 'model-a' }] });

function send(res, body, status = 200, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function request(route, method = 'GET', body, { headers = {}, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: uiPort, path: route, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.on('error', reject);
    req.end(data);
  });
}
const discover = (body, opts) => request('/api/providers/models', 'POST', body, opts);

function provider(id, extra = {}) {
  return { id, name: id, base_url: `http://127.0.0.1:${upstreamPort}`, api_key: `sk-${id}-secret`,
    enabled: true, models: ['kept-model'], ...extra };
}

const diskSnapshot = () => {
  const out = {};
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs);
      else out[path.relative(TMP, abs)] = fs.readFileSync(abs, 'utf8');
    }
  })(TMP);
  return out;
};

before(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      upstream.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      respond(res);
    });
  });
  upstream.requests = [];
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = upstream.address().port;

  mod._state.store = {
    claude: [
      provider('psaved'),
      provider('pkeys', {
        keys: [
          { id: 'k1', label: 'one', key: 'sk-key-one-secret', enabled: true },
          { id: 'k2', label: 'two', key: 'sk-key-two-secret', enabled: true },
        ],
        active_key: 'k2', api_key: 'sk-key-two-secret',
      }),
      provider('plegacy', { api_key: 'sk-legacy-secret' }),
      provider('pnokey', { api_key: '' }),
      provider('pchat', { wire_api: 'chat', api_key: 'sk-chat-secret' }),
      provider('pua', { ua: 'saved-ua/1.0', api_key: 'sk-ua-secret' }),
      // 选中一把不可用的 Key 时不许后退到渠道当前生效的那把:下面两条各占一个失败分支
      provider('pbadkeys', {
        keys: [
          { id: 'kempty', label: 'empty', key: '', enabled: true },
          { id: 'koff', label: 'off', key: 'sk-disabled-secret', enabled: false },
        ],
        active_key: 'kempty', api_key: 'sk-active-secret',
      }),
      provider('pdead', { base_url: 'http://127.0.0.1:1', api_key: 'sk-dead-secret' }),
    ],
    codex: [],
  };
  mod._state.routes = { rules: [], default: { provider: '', model: '' } };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.sessions.clear();
  mod._state.cooldowns = {};
  ui = await mod.listen(0, mod.apiHandler);
  uiPort = ui.address().port;
});

after(async () => {
  await new Promise(resolve => { ui.close(resolve); ui.closeAllConnections(); });
  await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 未保存渠道

test('未保存渠道:URL+Key 即可发现模型,成功只回 models 且不泄漏 Key', async () => {
  upstream.requests.length = 0;
  respond = res => send(res, { data: [{ id: 'model-a' }, { id: 'model-b' }] });
  const r = await discover({ base_url: `http://127.0.0.1:${upstreamPort}`, api_key: 'sk-unsaved-secret' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.models, ['model-a', 'model-b']);
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].headers['x-api-key'], 'sk-unsaved-secret');
  assert.ok(!r.text.includes('sk-unsaved-secret'), '响应体不应回显 API Key');
  assert.ok(!('api_key' in (r.json || {})), '响应体不应带凭据字段');
});

test('未保存渠道缺 URL 或 Key → 400,不发上游请求', async () => {
  upstream.requests.length = 0;
  respond = res => send(res, { data: [{ id: 'model-a' }] });
  for (const body of [
    {},
    { base_url: `http://127.0.0.1:${upstreamPort}` },
    { api_key: 'sk-only-key' },
    { base_url: `http://127.0.0.1:${upstreamPort}`, api_key: '   ' },
  ]) {
    const r = await discover(body);
    assert.equal(r.status, 400, `应 400: ${JSON.stringify(body)}`);
    assert.ok(r.json && typeof r.json.error === 'string', '错误体应是 { error: string }');
  }
  assert.equal(upstream.requests.length, 0);
});

test('非法 base_url → 400:非 http(s)、userinfo、查询串、片段', async () => {
  upstream.requests.length = 0;
  const base = `http://127.0.0.1:${upstreamPort}`;
  for (const base_url of [
    'ftp://127.0.0.1:1/v1',
    `http://user:pass@127.0.0.1:${upstreamPort}`,
    `${base}/v1?x=1`,
    `${base}/v1#frag`,
    'not-a-url',
  ]) {
    const r = await discover({ base_url, api_key: 'sk-invalid-url' });
    assert.equal(r.status, 400, `应 400: ${base_url}`);
  }
  assert.equal(upstream.requests.length, 0);
});

test('请求体不是对象 → 400', async () => {
  const r = await request('/api/providers/models', 'POST', []);
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------- 已保存渠道与 Key 解析

test('已保存渠道:不需要再传 URL/Key,用库里的字段', async () => {
  upstream.requests.length = 0;
  respond = res => send(res, { data: [{ id: 'saved-model' }] });
  const r = await discover({ provider_id: 'psaved' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.models, ['saved-model']);
  assert.equal(upstream.requests[0].headers['x-api-key'], 'sk-psaved-secret');
  assert.equal(upstream.requests[0].headers.authorization, 'Bearer sk-psaved-secret');
});

test('provider_id 不存在或没有可用 Key → 404', async () => {
  upstream.requests.length = 0;
  assert.equal((await discover({ provider_id: 'pnope' })).status, 404);
  assert.equal((await discover({ provider_id: 'pnokey' })).status, 404);
  assert.equal(upstream.requests.length, 0);
});

test('空 api_key + key_id 选指定 Key;不传 key_id 用 active_key', async () => {
  upstream.requests.length = 0;
  respond = res => send(res, { data: [{ id: 'm' }] });
  assert.equal((await discover({ provider_id: 'pkeys', key_id: 'k1' })).status, 200);
  assert.equal(upstream.requests.at(-1).headers['x-api-key'], 'sk-key-one-secret');
  assert.equal((await discover({ provider_id: 'pkeys', api_key: '' })).status, 200);
  assert.equal(upstream.requests.at(-1).headers['x-api-key'], 'sk-key-two-secret');
  assert.equal((await discover({ provider_id: 'pkeys' })).status, 200);
  assert.equal(upstream.requests.at(-1).headers['x-api-key'], 'sk-key-two-secret');
});

test('旧式单 Key 渠道的 klegacy 也能被 key_id 选中', async () => {
  upstream.requests.length = 0;
  respond = res => send(res, { data: [{ id: 'm' }] });
  const r = await discover({ provider_id: 'plegacy', key_id: 'klegacy' });
  assert.equal(r.status, 200);
  assert.equal(upstream.requests[0].headers['x-api-key'], 'sk-legacy-secret');
});

test('未知 key_id 拒绝(404),不静默退回别的账号', async () => {
  upstream.requests.length = 0;
  const r = await discover({ provider_id: 'pkeys', key_id: 'k-missing' });
  assert.equal(r.status, 404);
  assert.equal(upstream.requests.length, 0);
  // 显式给了 api_key 也要先校验 key_id:不能"Key 选错了就当没选"
  const withKey = await discover({ provider_id: 'pkeys', key_id: 'k-missing', api_key: 'sk-explicit-here' });
  assert.equal(withKey.status, 404);
  assert.equal(upstream.requests.length, 0);
});

test('没有 provider_id 却指定 key_id → 400(无从校验库内 Key)', async () => {
  upstream.requests.length = 0;
  const r = await discover({ base_url: `http://127.0.0.1:${upstreamPort}`, api_key: 'sk-x', key_id: 'k1' });
  assert.equal(r.status, 400);
  assert.equal(upstream.requests.length, 0);
});

test('选中的 key_id 值为空或已停用 → 404,且不后退用渠道当前的 Key', async () => {
  upstream.requests.length = 0;
  const empty = await discover({ provider_id: 'pbadkeys', key_id: 'kempty' });
  assert.equal(empty.status, 404, '选中的 Key 为空');
  const off = await discover({ provider_id: 'pbadkeys', key_id: 'koff' });
  assert.equal(off.status, 404, '选中的 Key 已停用');
  assert.equal(upstream.requests.length, 0, '两种情况都不应发出上游请求(不能改用别的 Key)');
  // 错误文案不能把库里的 Key 或 key_id 原文回显出去
  for (const r of [empty, off]) {
    assert.ok(!r.text.includes('sk-active-secret'), '错误响应不应回显渠道当前的 Key');
    assert.ok(!r.text.includes('sk-disabled-secret'), '错误响应不应回显停用的 Key');
    assert.ok(!r.text.includes('kempty') && !r.text.includes('koff'), '错误响应不应回显 key_id 原文');
  }
});

test('请求体 api_key 带控制字符 → 400,trim 之前就拒,不发上游请求', async () => {
  upstream.requests.length = 0;
  const base = `http://127.0.0.1:${upstreamPort}`;
  for (const api_key of ['sk-ok\n', 'sk-ok\r\n', '\tsk-ok', 'sk-o\u0000k']) {
    const r = await discover({ base_url: base, api_key });
    assert.equal(r.status, 400, `应 400: ${JSON.stringify(api_key)}`);
  }
  assert.equal(upstream.requests.length, 0, '带控制字符的 Key 不能发出(尾随 \\n 也不许被 trim 掉)');
});

test('显式非空 api_key 覆盖库里的 Key', async () => {
  upstream.requests.length = 0;
  respond = res => send(res, { data: [{ id: 'm' }] });
  const r = await discover({ provider_id: 'psaved', api_key: 'sk-override-secret' });
  assert.equal(r.status, 200);
  assert.equal(upstream.requests[0].headers['x-api-key'], 'sk-override-secret');
  assert.ok(!r.text.includes('sk-psaved-secret'), '响应体不应回显库里的 Key');
});

test('body 的 base_url 覆盖库里的地址,但 Key 仍按库里解析', async () => {
  upstream.requests.length = 0;
  respond = res => send(res, { data: [{ id: 'm' }] });
  const r = await discover({ provider_id: 'pdead', base_url: `http://127.0.0.1:${upstreamPort}` });
  assert.equal(r.status, 200);
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].headers['x-api-key'], 'sk-dead-secret');
});

test('库里 wire_api=chat 的渠道按 OpenAI 鉴权出站', async () => {
  upstream.requests.length = 0;
  respond = res => send(res, { data: [{ id: 'm' }] });
  const r = await discover({ provider_id: 'pchat' });
  assert.equal(r.status, 200);
  const headers = upstream.requests[0].headers;
  assert.equal(headers.authorization, 'Bearer sk-chat-secret');
});

test('库里配置的 UA 被带上去', async () => {
  upstream.requests.length = 0;
  respond = res => send(res, { data: [{ id: 'm' }] });
  assert.equal((await discover({ provider_id: 'pua' })).status, 200);
  assert.equal(upstream.requests[0].headers['user-agent'], 'saved-ua/1.0');
});

test('非法 wire_api / 非布尔 direct → 400', async () => {
  upstream.requests.length = 0;
  const base = { base_url: `http://127.0.0.1:${upstreamPort}`, api_key: 'sk-validate' };
  assert.equal((await discover({ ...base, wire_api: 'grpc' })).status, 400);
  assert.equal((await discover({ ...base, direct: 'true' })).status, 400);
  assert.equal(upstream.requests.length, 0);
});

test('api_key 只有空白时按"没给"处理,回落到库里的 Key', async () => {
  upstream.requests.length = 0;
  respond = res => send(res, { data: [{ id: 'm' }] });
  assert.equal((await discover({ provider_id: 'psaved', api_key: '   ' })).status, 200);
  assert.equal(upstream.requests[0].headers['x-api-key'], 'sk-psaved-secret');
});

// ---------------------------------------------------------------- 上游错误映射

test('上游 HTTP 错误 → 502,且不把上游错误体(可能回显凭据)抄给调用方', async () => {
  upstream.requests.length = 0;
  respond = res => send(res, { error: 'invalid api key sk-psaved-secret' }, 500);
  const r = await discover({ provider_id: 'psaved' });
  assert.equal(r.status, 502);
  assert.ok(!r.text.includes('sk-psaved-secret'), '错误响应不应转述上游正文里的凭据');
});

test('连不上上游 → 502,错误文案只说受控措辞,不回显 errno 或主机名', async () => {
  const r = await discover({ provider_id: 'pdead' });
  assert.equal(r.status, 502);
  for (const leak of ['ECONNREFUSED', '127.0.0.1', 'connect', 'refused'])
    assert.ok(!r.text.toLowerCase().includes(leak.toLowerCase()), `错误响应不应含 "${leak}"`);
  assert.ok(!r.text.includes('sk-dead-secret'), '错误响应不应回显库里的 Key');
});

test('上游回坏 JSON → 502', async () => {
  respond = res => send(res, 'this is not json');
  const r = await discover({ provider_id: 'psaved' });
  assert.equal(r.status, 502);
});

test('上游回合法 JSON 但不是任何已知形状 → 502', async () => {
  respond = res => send(res, { unexpected: true });
  const r = await discover({ provider_id: 'psaved' });
  assert.equal(r.status, 502);
});

test('响应超过 2 MiB 默认上限 → 502', async () => {
  respond = res => send(res, { data: [{ id: 'x'.repeat(2.5 * 1024 * 1024) }] });
  const r = await discover({ provider_id: 'psaved' });
  assert.equal(r.status, 502);
});

test('上游迟迟不回 → 504(默认整段 15s 预算)', async () => {
  respond = () => { /* 永不回包 */ };
  const r = await discover({ provider_id: 'psaved' }, { timeout: 25000 });
  assert.equal(r.status, 504);
});

// ---------------------------------------------------------------- 无副作用与访问闸门

test('调用不修改渠道库、不落盘、不写请求日志', async () => {
  upstream.requests.length = 0;
  respond = res => send(res, { data: [{ id: 'm' }] });
  const storeBefore = JSON.stringify(mod._state.store);
  const diskBefore = diskSnapshot();
  assert.equal((await discover({ provider_id: 'pkeys', key_id: 'k1' })).status, 200);
  assert.equal((await discover({ base_url: `http://127.0.0.1:${upstreamPort}`, api_key: 'sk-temp-secret' })).status, 200);
  assert.equal(JSON.stringify(mod._state.store), storeBefore, '渠道库被就地改写');
  assert.deepEqual(diskSnapshot(), diskBefore, '模型发现不应产生落盘(含请求日志)');
});

test('跨站来源的写入被拒(403),不发上游请求', async () => {
  upstream.requests.length = 0;
  const r = await discover({ provider_id: 'psaved' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal(upstream.requests.length, 0);
});

test('新端点是独立路由,不会被当成 id=models 的渠道(404 文案应是"渠道不存在")', async () => {
  upstream.requests.length = 0;
  respond = res => send(res, { data: [{ id: 'route-ok' }] });
  const r = await discover({ base_url: `http://127.0.0.1:${upstreamPort}`, api_key: 'sk-routing-check' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.models, ['route-ok']);
});
