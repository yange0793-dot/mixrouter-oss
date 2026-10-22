'use strict';
// 模型发现(lib/provider-models.js)的独立回归:真实回环 HTTP 上游 + 真实 fetchProviderModels。
//
// 这里只验**契约**本身,不复刻实现:
//   · 端点换算(root / /v1 / 自定义前缀 / 已写全的 …/v1/models)
//   · 三种回包形状与去重、稳定顺序、合法空表
//   · 两套鉴权头(Anthropic / OpenAI)与渠道 UA、direct 走 transportAgent
//   · 非法 URL/凭据拒收,不跟随重定向(Key 不外泄)
//   · 上游非 2xx / 坏 JSON / 坏形状 / 超字节 / 超时(含缓慢滴流与断流)一律拒绝
//   · Anthropic 分页(has_more/last_id、after_id 打在同一路径上)与页数/字节/整段截止预算
//   · 不写盘、不改传入的渠道对象
//
// 不碰真实网络、真实凭据、真实客户端配置(临时 MIXR_DATA_DIR/HOME 由脚本隔离)。
// 鉴权期望按契约书写;实现若与此不同,先与后端对齐契约,不在这里放宽。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-provider-models-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';

// transportAgent 必须在加载被测模块**之前**换掉:模块在 require 时会解构这个引用,
// 之后再改导出对它无效(与 test/provider-direct.test.js 同一手法)。
const transport = require('../lib/upstream-proxy');
const originalAgent = transport.transportAgent;
const agentSelections = [];
// 缺省出站失败只允许在**测试内**注入:设了 failWith 就返回一个必然失败的 agent。
// 这样错误文案的用例完全不碰网络(尤其不做 DNS),也不依赖本机解析器/代理的行为。
let failWith = null;
transport.transportAgent = (protocol, provider) => {
  agentSelections.push({ protocol, direct: provider && provider.direct });
  const injected = failWith && failWith();
  if (injected) return new FailingAgent(injected);
  return originalAgent(protocol, provider);
};
const { fetchProviderModels } = require('../lib/provider-models');

// 一个不建连、直接把给定错误交给 request 的 agent。走的是生产同一条 agent 钩子
// (lib/provider-models.js 里 `agent: transportAgent(...)`),因此注入点就是真实出站路径。
class FailingAgent extends http.Agent {
  constructor(err) { super(); this.err = err; }
  createConnection(options, cb) { cb(this.err); return undefined; }
}
const injectFailure = (t, err) => {
  failWith = () => err;
  t.after(() => { failWith = null; });
};

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = server => new Promise(resolve => {
  server.close(resolve);
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
});

function createUpstream(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(entry);
      Promise.resolve()
        .then(() => handler(req, res, entry, requests.length))
        .catch(() => { try { res.destroy(); } catch {} });
    });
  });
  return { server, requests };
}

async function withUpstream(t, handler, fn) {
  const up = createUpstream(handler);
  await listen(up.server);
  t.after(() => close(up.server));
  return fn(up);
}

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const providerAt = (up, extra = {}) => ({
  base_url: `http://127.0.0.1:${up.server.address().port}`,
  api_key: 'sk-fixture-secret-0001',
  ...extra,
});
const pathOf = url => new URL(url, 'http://fixture.invalid').pathname;

async function rejected(fn, label) {
  try { await fn(); }
  catch (e) { return e; }
  assert.fail(`${label}:预期拒绝,实际成功返回`);
}
async function rejectsWithin(fn, label, ms = 3000) {
  const started = Date.now();
  const err = await rejected(fn, label);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < ms, `${label}:拒绝用了 ${elapsed}ms,超过 ${ms}ms 预算(说明截止时间没有生效)`);
  return err;
}

// ---------------------------------------------------------------- 端点换算

test('base_url 的 root、/v1、自定义前缀与已写全的 models 端点都落到同一个 models 端点', async t => {
  await withUpstream(t, (req, res) => json(res, { data: [{ id: 'm1' }] }), async up => {
    const base = `http://127.0.0.1:${up.server.address().port}`;
    const cases = [
      ['', '/v1/models'],
      ['/', '/v1/models'],
      ['/v1', '/v1/models'],
      ['/v1/', '/v1/models'],
      ['/v1/models', '/v1/models'],
      ['/custom', '/custom/v1/models'],
      ['/custom/', '/custom/v1/models'],
      ['/custom/v1', '/custom/v1/models'],
      ['/custom/v1/', '/custom/v1/models'],
      ['/custom/v1/models', '/custom/v1/models'],
      ['/models', '/models'],
    ];
    for (const [suffix, expected] of cases) {
      await fetchProviderModels({ base_url: base + suffix, api_key: 'sk-fixture-secret-0001' }, { timeoutMs: 3000 });
      assert.equal(pathOf(up.requests.at(-1).url), expected, `base_url 后缀 ${JSON.stringify(suffix)}`);
      assert.equal(up.requests.at(-1).method, 'GET');
    }
    assert.equal(up.requests.length, cases.length);
  });
});

// ---------------------------------------------------------------- 回包形状

test('标准 data/models/顶层数组三种形状都解析,去重、跳过空名、保持首次出现顺序', async t => {
  const shapes = [
    [{ data: [{ id: 'a' }, { id: 'b' }] }, ['a', 'b']],
    [{ models: ['x', 'y'] }, ['x', 'y']],
    [{ models: [{ id: 'x' }, { id: 'y' }] }, ['x', 'y']],
    [['p', 'q'], ['p', 'q']],
    [[{ id: 'p' }, { id: 'q' }], ['p', 'q']],
    [{ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] }, ['b', 'a']],
    [{ models: ['x', '', 'x', 'y'] }, ['x', 'y']],
    [{ data: [{ id: 5 }, { id: 'm' }] }, ['5', 'm']],
  ];
  for (const [body, expected] of shapes) {
    await withUpstream(t, (req, res) => json(res, body), async up => {
      const models = await fetchProviderModels(providerAt(up), { timeoutMs: 3000 });
      assert.deepEqual(models, { models: expected }, `回包形状 ${JSON.stringify(body)}`);
    });
  }
});

test('合法的空模型列表照常返回空数组,不当作错误', async t => {
  for (const body of [{ data: [] }, { models: [] }, []]) {
    await withUpstream(t, (req, res) => json(res, body), async up => {
      const result = await fetchProviderModels(providerAt(up), { timeoutMs: 3000 });
      assert.deepEqual(result, { models: [] }, `空表 ${JSON.stringify(body)}`);
    });
  }
});

test('坏 JSON 与坏形状拒绝,不把半解析结果当成功', async t => {
  for (const body of ['not json at all', { foo: 'bar' }, { data: 'nope' }, { models: 'nope' }, { data: [{ name: 'x' }] }]) {
    await withUpstream(t, (req, res) => json(res, body), async up => {
      await rejectsWithin(() => fetchProviderModels(providerAt(up), { timeoutMs: 3000 }),
        `坏形状 ${JSON.stringify(body)}`);
    });
  }
});

// ---------------------------------------------------------------- 鉴权与 UA

test('Anthropic 线同时带 x-api-key、Bearer 与 anthropic-version', async t => {
  await withUpstream(t, (req, res) => json(res, { data: [{ id: 'm1' }] }), async up => {
    const provider = providerAt(up, { api_key: 'sk-anthropic-secret' });
    await fetchProviderModels(provider, { timeoutMs: 3000 });
    const { headers } = up.requests[0];
    assert.equal(headers['x-api-key'], 'sk-anthropic-secret');
    assert.equal(headers.authorization, 'Bearer sk-anthropic-secret');
    assert.ok(String(headers['anthropic-version'] || '').trim(), '缺少 anthropic-version');
    assert.ok(String(headers['user-agent'] || '').trim(), '缺少 User-Agent');
  });
});

test('OpenAI 线(responses/chat)只带 Bearer', async t => {
  for (const wire_api of ['responses', 'chat']) {
    await withUpstream(t, (req, res) => json(res, { data: [{ id: 'm1' }] }), async up => {
      await fetchProviderModels(providerAt(up, { api_key: 'sk-openai-secret', wire_api }), { timeoutMs: 3000 });
      const { headers } = up.requests[0];
      assert.equal(headers.authorization, 'Bearer sk-openai-secret', `wire_api=${wire_api}`);
    });
  }
});

test('渠道配置的 UA 原样带上', async t => {
  await withUpstream(t, (req, res) => json(res, { data: [{ id: 'm1' }] }), async up => {
    await fetchProviderModels(providerAt(up, { ua: 'fixture-ua/9.9' }), { timeoutMs: 3000 });
    assert.equal(up.requests[0].headers['user-agent'], 'fixture-ua/9.9');
  });
});

test('direct 渠道经 transportAgent 出站', async t => {
  await withUpstream(t, (req, res) => json(res, { data: [{ id: 'm1' }] }), async up => {
    agentSelections.length = 0;
    await fetchProviderModels(providerAt(up, { direct: true }), { timeoutMs: 3000 });
    assert.equal(agentSelections.at(-1).protocol, 'http:');
    assert.equal(agentSelections.at(-1).direct, true);
  });
});

// ---------------------------------------------------------------- 入参拒收

test('非 http(s)、带 userinfo、带查询串或片段的 URL 一律拒收,且不发请求', async t => {
  await withUpstream(t, (req, res) => json(res, { data: [{ id: 'm1' }] }), async up => {
    const base = `http://127.0.0.1:${up.server.address().port}`;
    const bad = [
      'ftp://127.0.0.1:1/v1',
      `http://user:pass@127.0.0.1:${up.server.address().port}`,
      base + '/v1?api_version=2',
      base + '/v1#fragment',
      'not-a-url',
    ];
    for (const base_url of bad) {
      await rejectsWithin(() => fetchProviderModels({ base_url, api_key: 'sk-fixture-secret-0001' }, { timeoutMs: 3000 }),
        `非法 URL ${base_url}`);
    }
    await rejectsWithin(() => fetchProviderModels({ base_url: base }, { timeoutMs: 3000 }), '缺少 API Key');
    assert.equal(up.requests.length, 0, '非法入参不应发出任何上游请求');
  });
});

// ---------------------------------------------------------------- 上游错误

test('上游非 2xx 拒绝', async t => {
  for (const status of [401, 404, 500, 503]) {
    await withUpstream(t, (req, res) => json(res, { error: 'nope' }, status), async up => {
      await rejectsWithin(() => fetchProviderModels(providerAt(up), { timeoutMs: 3000 }), `上游 ${status}`);
    });
  }
});

test('不跟随重定向:302 一律按上游错误拒绝,且不带 Key 去第二个地址', async t => {
  const redirectTargets = [];
  await withUpstream(t, (req, res) => json(res, { data: [{ id: 'leak' }] }), async target => {
    await withUpstream(t, (req, res) => {
      redirectTargets.push(req.url);
      res.writeHead(302, { location: `http://127.0.0.1:${target.server.address().port}/v1/models` });
      res.end();
    }, async up => {
      await rejectsWithin(() => fetchProviderModels(providerAt(up), { timeoutMs: 3000 }), '302 重定向');
      assert.equal(target.requests.length, 0, '不允许跟随重定向把 Key 带到新地址');
      assert.equal(redirectTargets.length, 1);
    });
  });
});

test('超过 maxBytes 的响应拒绝', async t => {
  const big = JSON.stringify({ data: [{ id: 'x'.repeat(4096) }] });
  await withUpstream(t, (req, res) => json(res, big), async up => {
    await rejectsWithin(() => fetchProviderModels(providerAt(up), { timeoutMs: 3000, maxBytes: 512 }), '单页超字节');
  });
});

test('跨页累计超过 maxBytes 也拒绝', async t => {
  await withUpstream(t, (req, res, entry, n) => {
    // 每页约 400 字节且继续分页,总量超过 700
    json(res, { data: [{ id: `model-${n}-${'x'.repeat(300)}` }], has_more: true, last_id: `c${n}` });
  }, async up => {
    await rejectsWithin(() => fetchProviderModels(providerAt(up), { timeoutMs: 3000, maxBytes: 700 }), '跨页超字节');
    assert.ok(up.requests.length >= 2, '应至少取了两页才累计超限');
  });
});

// ---------------------------------------------------------------- 超时与断流

test('上游不给响应时按 timeoutMs 拒绝', async t => {
  await withUpstream(t, () => { /* 永不回包 */ }, async up => {
    await rejectsWithin(() => fetchProviderModels(providerAt(up), { timeoutMs: 250 }), '无响应超时', 2000);
  });
});

test('缓慢滴流的响应也受整段截止时间约束,不被当成"还在活着"', async t => {
  await withUpstream(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"data":[');
    const timer = setInterval(() => { try { res.write(' '); } catch { clearInterval(timer); } }, 40);
    res.on('close', () => clearInterval(timer));
  }, async up => {
    await rejectsWithin(() => fetchProviderModels(providerAt(up), { timeoutMs: 300 }), '滴流超时', 2000);
  });
});

test('分页之间共用同一条整段截止时间,不按页重新计时', async t => {
  // 只让"第二页挂住"证明不了预算共享:第一页瞬间返回时,按页重置与整段共用都要等一个
  // timeoutMs,两者分不出差别。所以让**第一页先吃掉大部分预算**(650/800),第二页再挂住:
  //   · 整段共用:总共约 800ms 结束;
  //   · 按页重置:650 + 800 ≈ 1450ms 才结束。
  // 阈值取 1200ms:既容得下 CI 的计时抖动(800 + 400 余量),又把"按页重置"挡在外面。
  const TIMEOUT = 800;
  const PAGE1_DELAY = 650;
  const PER_PAGE_RESET_COST = PAGE1_DELAY + TIMEOUT;
  await withUpstream(t, (req, res, entry, n) => {
    if (n === 1) {
      setTimeout(() => { try { json(res, { data: [{ id: 'a' }], has_more: true, last_id: 'c1' }); } catch {} }, PAGE1_DELAY);
      return;
    }
    /* 第二页永不回包 —— 让截止时间成为唯一的结束方式 */
  }, async up => {
    const started = Date.now();
    const err = await rejected(
      () => fetchProviderModels(providerAt(up), { timeoutMs: TIMEOUT }), '跨页整段超时');
    const elapsed = Date.now() - started;
    assert.equal(up.requests.length, 2, `第二页必须真的发出,否则这条用例什么都没证明(实际 ${up.requests.length} 次请求)`);
    assert.equal(err.status, 504, `应报超时(504),实际 ${err.status}`);
    assert.ok(elapsed >= TIMEOUT - 100, `应真的等满整段预算,实际只用了 ${elapsed}ms`);
    assert.ok(elapsed < 1200,
      `跨页共用的截止时间没有生效:耗时 ${elapsed}ms,若按页重置应约 ${PER_PAGE_RESET_COST}ms、共用应约 ${TIMEOUT}ms`);
  });
});

test('上半截响应被断开时拒绝,不挂起等待', async t => {
  await withUpstream(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"data":[{"id":"half');
    setTimeout(() => res.destroy(), 20);
  }, async up => {
    await rejectsWithin(() => fetchProviderModels(providerAt(up), { timeoutMs: 3000 }), '响应中途断开', 2000);
  });
});

// ---------------------------------------------------------------- 分页

test('Anthropic 分页按 has_more/last_id 在同一端点继续,after_id 带上游标', async t => {
  await withUpstream(t, (req, res, entry, n) => {
    if (n === 1) return json(res, { data: [{ id: 'b' }, { id: 'a' }], has_more: true, last_id: 'cursor-1' });
    if (n === 2) return json(res, { data: [{ id: 'c' }], has_more: true, last_id: 'cursor-2' });
    return json(res, { data: [{ id: 'd' }], has_more: false });
  }, async up => {
    const result = await fetchProviderModels(providerAt(up, { base_url: `http://127.0.0.1:${up.server.address().port}/v1` }), { timeoutMs: 3000 });
    assert.deepEqual(result, { models: ['b', 'a', 'c', 'd'] });
    assert.equal(up.requests.length, 3);
    const urls = up.requests.map(r => new URL(r.url, 'http://fixture.invalid'));
    assert.deepEqual(urls.map(u => u.pathname), ['/v1/models', '/v1/models', '/v1/models']);
    assert.equal(urls[0].searchParams.get('after_id'), null);
    assert.equal(urls[1].searchParams.get('after_id'), 'cursor-1');
    assert.equal(urls[2].searchParams.get('after_id'), 'cursor-2');
  });
});

test('页数超过 maxPages 时拒绝,不在一直 has_more 的上游上无限翻页', async t => {
  await withUpstream(t, (req, res, entry, n) => {
    json(res, { data: [{ id: `m${n}` }], has_more: true, last_id: `c${n}` });
  }, async up => {
    await rejectsWithin(() => fetchProviderModels(providerAt(up), { timeoutMs: 3000, maxPages: 2 }), '超页数');
    assert.equal(up.requests.length, 2, `只应请求 maxPages 页,实际 ${up.requests.length}`);
  });
});

test('默认页数上限是 20:一直 has_more 的上游在第 20 页后被拒绝', async t => {
  await withUpstream(t, (req, res, entry, n) => {
    json(res, { data: [{ id: `m${n}` }], has_more: true, last_id: `c${n}` });
  }, async up => {
    await rejectsWithin(() => fetchProviderModels(providerAt(up), { timeoutMs: 5000 }), '默认 20 页上限');
    assert.equal(up.requests.length, 20, `默认上限应为 20 页,实际请求 ${up.requests.length} 页`);
  });
});

test('IPv6 字面量 base_url(带方括号)可正常出站', async t => {
  // 只绑 ::1 上的回环地址:brackets 由 URL 解析带出、由实现剥掉再交给 request,
  // 不剥就是 ENOTFOUND。运行环境没有 IPv6 时明确跳过,不静默通过。
  const server = http.createServer((req, res) => json(res, { data: [{ id: 'v6-model' }] }));
  const bound = await new Promise(resolve => {
    server.once('error', () => resolve(false));
    server.listen(0, '::1', () => resolve(true));
  });
  if (!bound) { server.close(); return t.skip('本机没有可用的 IPv6 回环'); }
  t.after(() => close(server));
  const port = server.address().port;
  const result = await fetchProviderModels(
    { base_url: `http://[::1]:${port}`, api_key: 'sk-fixture-secret-0001' }, { timeoutMs: 3000 });
  assert.deepEqual(result, { models: ['v6-model'] });
  // 没有方括号的写法是非法 URL,应 400 而不是拿它去解析
  await rejectsWithin(() => fetchProviderModels(
    { base_url: `http://::1:${port}`, api_key: 'sk-fixture-secret-0001' }, { timeoutMs: 3000 }), '无方括号的 IPv6');
});

// ---------------------------------------------------------------- 出站错误文案

test('连接失败只回受控措辞:不拼接 errno、主机名或代理原文', async t => {
  const err = await rejected(() => fetchProviderModels(
    { base_url: 'http://127.0.0.1:1', api_key: 'sk-fixture-secret-0001' }, { timeoutMs: 3000 }), '端口不可达');
  assert.equal(err.status, 502);
  // 连接阶段的文案是「无法连接上游: <白名单短语>」,两段都固定 —— 这里钉整串,回退或改写都会被抓住
  assert.equal(err.message, '无法连接上游: 上游拒绝连接', `ECONNREFUSED 的文案应固定,实际: ${err.message}`);
  for (const leak of ['ECONNREFUSED', '127.0.0.1', 'connect', '::1', 'refused'])
    assert.ok(!err.message.toLowerCase().includes(leak.toLowerCase()), `错误文案不应含 "${leak}"`);
});

test('出站失败只回受控措辞:注入的 errno/隧道错误原文不外泄,也不做真实 DNS', async t => {
  // 解析器/出站代理的原始 message 里常有上游主机、代理细节。用一个**注入**的失败 agent
  // 承接这类错误:不查 DNS、不联网,结果与本机解析器无关(以前用 *.invalid 做真解析,
  // 同一用例在不同机器上会拿到 EAI_AGAIN 或 ECONNRESET,既不稳定也不是离线测试)。
  const cases = [
    // 白名单里的 errno:映射成固定短语,原文里的主机名与 errno 都不许出现
    [Object.assign(new Error('getaddrinfo ENOTFOUND no-such-host.invalid'), { code: 'EAI_AGAIN' }),
      '无法连接上游: 上游域名解析暂时失败'],
    // 出站代理隧道错误没有 code,只有 message;只认前缀,不转述原文
    [new Error('upstream proxy CONNECT 407 Proxy Authentication Required'),
      '无法连接上游: 出站代理未能建立到上游的隧道'],
    // 白名单之外的错误码:一句固定兜底,不拼接任意 e.message
    [Object.assign(new Error('some libuv detail at 10.1.2.3'), { code: 'EWHATEVER' }),
      '无法连接上游: 出站请求失败'],
  ];
  for (const [err, expected] of cases) {
    injectFailure(t, err);
    // base_url 也取本机回环:万一注入失效,请求只会落到本地拒连,不会真的去解析域名
    const got = await rejected(() => fetchProviderModels(
      { base_url: 'http://127.0.0.1:1', api_key: 'sk-fixture-secret-0001' }, { timeoutMs: 3000 }),
    `注入失败: ${err.code || err.message}`);
    assert.equal(got.status, 502);
    assert.equal(got.message, expected, `文案应固定,实际: ${got.message}`);
    for (const leak of ['no-such-host', 'ENOTFOUND', 'EAI_AGAIN', 'getaddrinfo', 'upstream proxy',
      'CONNECT', '407', '10.1.2.3', 'EWHATEVER', 'libuv'])
      assert.ok(!got.message.includes(leak), `错误文案不应含原文片段 "${leak}": ${got.message}`);
  }
});

// ---------------------------------------------------------------- 无副作用

test('不修改传入的渠道对象,也不往数据目录落任何文件', async t => {
  await withUpstream(t, (req, res) => json(res, { data: [{ id: 'm1' }] }), async up => {
    const provider = providerAt(up, { models: ['kept'], note: 'kept' });
    const before = JSON.stringify(provider);
    const tree = dir => {
      const out = {};
      (function walk(d) {
        if (!fs.existsSync(d)) return;
        for (const name of fs.readdirSync(d)) {
          const abs = path.join(d, name);
          const st = fs.statSync(abs);
          if (st.isDirectory()) walk(abs);
          else out[path.relative(TMP, abs)] = fs.readFileSync(abs, 'utf8');
        }
      })(dir);
      return out;
    };
    const diskBefore = tree(TMP);
    await fetchProviderModels(provider, { timeoutMs: 3000 });
    assert.equal(JSON.stringify(provider), before, '渠道对象被就地改写了');
    assert.deepEqual(tree(TMP), diskBefore, '模型发现不应写数据目录(不使用也会被记录)');
  });
});
