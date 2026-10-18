'use strict';
// mixctl sessions 的会话级 Key / 槽位覆盖子命令:参数闸门、读-改-写编排、冲突与错误的退出码。
//
// 三条线各自钉住一类事故:
//   1. 参数闸门:命令行**不接受 Key 明文**(argv 会进 shell 历史与 ps),短会话 id 定位不到会话,
//      `reset` 不给 --yes 不许清,子命令不认的选项当场报错而不是被忽略。
//   2. 编排:写之前必须先 GET 拿 revision、PUT 带 expected_revision、且只改点名的那一项
//      (整份替换覆盖会把用户没点名的槽位一起抹掉)。
//   3. 冲突与失败:409 直报且不重试、404/400/500 各自的退出码与文案,输出里不出现明文。
// 传输用注入的假 request 打桩(与 lib/cli/logs.js 同套路);另外几条真的把 mixctl 拉起来,
// 打到本测试自己起的回环端口上,验"分发到 sessions 子命令"和"实际发出去的 HTTP 形状"。
// 全程不启动常驻服务、不碰真实 HOME/数据/Key、不占 8787/8788。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runSessions, parseArgs, planFor, SESSIONS_USAGE } = require('../lib/cli/sessions');

const MIXCTL = path.join(__dirname, '..', 'mixctl');
// 明文形状的 Key:id / key / token 开头,后面一长串。任何一条输出里出现它都是缺陷。
const PLAINTEXT = 'sk-ant-api03-LEAKCANARY0123456789abcdef';
const KEY = 'cc:11111111-2222-3333-4444-555555555555';
const ROUTING_PATH = `/api/sessions/${encodeURIComponent(KEY)}/routing`;

function load(handlers) {
  const writes = [];
  const logs = [];
  const request = async (method, p, body) => {
    const verb = String(method || 'GET').toUpperCase();
    if (verb !== 'GET') writes.push({ method: verb, path: p, body });
    const hit = handlers[`${verb} ${p}`];
    if (!hit) throw new Error(`unexpected ${verb} ${p}`);
    return hit();
  };
  const stdout = { write: text => logs.push(text) };
  const stderr = { write: text => logs.push(text) };
  return { writes, logs, run: args => runSessions(args, { request, stdout, stderr }), text: () => logs.join('') };
}

const getRouting = (routing, revision) => () => ({ status: 200, data: { routing, revision } });
const okRouting = (routing, revision) => () => ({ status: 200, data: { ok: true, routing, revision } });

// ------------------------------------------------------------------ 1) 参数闸门

test('set-key 只认渠道内已有的 Key ID,Key 明文一律挡在参数解析这一步', () => {
  for (const bad of [PLAINTEXT, 'key-0123456789abcdef', 'a'.repeat(65)]) {
    assert.throws(() => planFor('set-key', parseArgs([KEY, 'p1', bad])), /Key 明文/,
      `${bad.slice(0, 24)}… 不该被当成 Key ID`);
    assert.throws(() => planFor('set-slot', parseArgs([KEY, 'haiku', 'p1', '--key-id', bad])), /Key 明文/);
  }
  // 正常形状照过
  assert.equal(planFor('set-key', parseArgs([KEY, 'p1', 'k2'])).keyId, 'k2');
  assert.equal(planFor('set-slot', parseArgs([KEY, 'haiku', 'p1', '--key-id', 'klegacy'])).keyId, 'klegacy');
});

test('会话键必须是带前缀的完整键,列表里的短 id 定位不到会话', () => {
  assert.equal(planFor('config', parseArgs([KEY])).session, KEY);
  assert.equal(planFor('config', parseArgs(['cx:abc-def'])).session, 'cx:abc-def');
  for (const bad of ['11111111', 'cc:abc def', 'session-1']) {
    assert.throws(() => planFor('config', parseArgs([bad])), /完整键|控制字符/);
  }
  // 身份取不到来源时 identity 给出的是这两个字面量,它们是真实存在的会话键
  assert.equal(planFor('config', parseArgs(['anon'])).session, 'anon');
  assert.equal(planFor('config', parseArgs(['cx-anon'])).session, 'cx-anon');
  assert.throws(() => planFor('config', parseArgs([KEY, 'x'])), /只接受一个参数/);
  assert.throws(() => planFor('set-slot', parseArgs([KEY, 'mixr-haiku', 'p1'])), /别名/);
});

test('子命令选项白名单:写错的选项当场报错,不用默认值兜过去', () => {
  assert.throws(() => planFor('reset', parseArgs([KEY, '--model', 'm'])), /reset 不支持 --model/);
  assert.throws(() => planFor('clear-slot', parseArgs([KEY, 'haiku', '--yes'])), /clear-slot 不支持 --yes/);
  assert.throws(() => planFor('config', parseArgs([KEY, '--inherit'])), /config 不支持 --inherit/);
  assert.throws(() => planFor('set-key', parseArgs([KEY, 'p1', 'k2', '--inherit'])), /不能再给 Key ID/);
  assert.throws(() => planFor('set-key', parseArgs([KEY, 'p1'])), /--inherit/);
  assert.throws(() => parseArgs(['--nope']), /无法识别的选项/);
  assert.throws(() => parseArgs(['--model']), /缺少值/);
  assert.throws(() => parseArgs(['--json', '--json']), /不能重复/);
  assert.throws(() => parseArgs(['--json=1']), /不接受值/);
  // set-slot 可以完全不写 --model:那就是"这一槽只换渠道,不覆盖模型"
  assert.deepEqual(planFor('set-slot', parseArgs([KEY, 'haiku', 'p2'])),
    { action: 'set-slot', session: KEY, slot: 'haiku', provider: 'p2' });
});

// ------------------------------------------------------------------ 2) 读-改-写编排

test('set-key 走 GET→PUT,PUT 带 expected_revision 且只动点名的渠道', async () => {
  const current = { keys: { p1: 'k1', p2: 'k2' }, slots: { haiku: { provider: 'p9' } } };
  const env = load({
    [`GET ${ROUTING_PATH}`]: getRouting(current, 'rev-1'),
    [`PUT ${ROUTING_PATH}`]: okRouting({ keys: { p1: 'k3', p2: 'k2' }, slots: { haiku: { provider: 'p9' } } }, 'rev-2'),
  });
  assert.equal(await env.run(['set-key', KEY, 'p1', 'k3']), 0);
  assert.equal(env.writes.length, 1);
  assert.equal(env.writes[0].method, 'PUT');
  assert.equal(env.writes[0].body.expected_revision, 'rev-1');
  assert.deepEqual(env.writes[0].body.routing, { keys: { p1: 'k3', p2: 'k2' }, slots: { haiku: { provider: 'p9' } } },
    '没点名的渠道与槽位必须原样带回去,不能被整份替换抹掉');
  assert.match(env.text(), /Key {2}p1 → k3/);
  assert.match(env.text(), /版本 rev-2/);
  assert.deepEqual(current.keys, { p1: 'k1', p2: 'k2' }, '调用方拿到的 routing 不能被就地改');
});

test('set-slot 是整槽替换,clear-slot 摘掉覆盖回落全局', async () => {
  const env = load({
    [`GET ${ROUTING_PATH}`]: getRouting({ keys: {}, slots: { haiku: { provider: 'p1', model: 'old', key_id: 'k1' }, opus: { provider: 'p2' } } }, 'r5'),
    [`PUT ${ROUTING_PATH}`]: okRouting({ keys: {}, slots: { haiku: { provider: 'p3', model: 'new' }, opus: { provider: 'p2' } } }, 'r6'),
  });
  assert.equal(await env.run(['set-slot', KEY, 'haiku', 'p3', '--model', 'new']), 0);
  assert.deepEqual(env.writes[0].body.routing.slots.haiku, { provider: 'p3', model: 'new' },
    'set-slot 整槽替换:旧的 key_id 不能留在新配置里');
  assert.deepEqual(env.writes[0].body.routing.slots.opus, { provider: 'p2' }, '别的槽一字不动');

  const env2 = load({
    [`GET ${ROUTING_PATH}`]: getRouting({ keys: {}, slots: { haiku: { provider: 'p1' } } }, 'r7'),
    [`PUT ${ROUTING_PATH}`]: okRouting({ keys: {}, slots: {} }, 'r8'),
  });
  assert.equal(await env2.run(['clear-slot', KEY, 'haiku']), 0);
  assert.deepEqual(env2.writes[0].body.routing, { keys: {}, slots: {} });
  assert.match(env2.text(), /回落全局槽位/);
});

test('set-key --inherit 摘掉覆盖;本来就没有覆盖时不发 PUT', async () => {
  const env = load({
    [`GET ${ROUTING_PATH}`]: getRouting({ keys: { p1: 'k1' }, slots: {} }, 'r1'),
    [`PUT ${ROUTING_PATH}`]: okRouting({ keys: {}, slots: {} }, 'r2'),
  });
  assert.equal(await env.run(['set-key', KEY, '--inherit', 'p1']), 0);
  assert.deepEqual(env.writes[0].body.routing.keys, {});

  const env2 = load({ [`GET ${ROUTING_PATH}`]: getRouting({ keys: {}, slots: {} }, 'r3') });
  assert.equal(await env2.run(['set-key', KEY, 'p1', '--inherit']), 0);
  assert.equal(env2.writes.length, 0, '没有覆盖可摘就不该写盘');
  assert.match(env2.text(), /未改动/);
  assert.match(env2.text(), /继承全局 Key/);
});

test('reset 不给 --yes 只提示、一个请求都不发;给了才清空并带版本', async () => {
  const env = load({});
  assert.equal(await env.run(['reset', KEY]), 1);
  assert.equal(env.writes.length, 0);
  assert.equal(env.logs.length > 0, true);
  assert.match(env.text(), /--yes/);

  const env2 = load({
    [`GET ${ROUTING_PATH}`]: getRouting({ keys: { p1: 'k1' }, slots: { haiku: { provider: 'p1' } } }, 'r9'),
    [`PUT ${ROUTING_PATH}`]: okRouting({ keys: {}, slots: {} }, 'r10'),
  });
  assert.equal(await env2.run(['reset', KEY, '--yes']), 0);
  assert.deepEqual(env2.writes[0].body.routing, { keys: {}, slots: {} });
  assert.equal(env2.writes[0].body.expected_revision, 'r9');
});

test('config 只读:打印覆盖与版本,不写盘', async () => {
  const env = load({ [`GET ${ROUTING_PATH}`]: getRouting({ keys: { p1: 'k1' }, slots: { haiku: { provider: 'p2', model: 'm', key_id: 'k9' } } }, 'rev-9') });
  assert.equal(await env.run(['config', KEY]), 0);
  assert.equal(env.writes.length, 0);
  assert.match(env.text(), /Key {2}p1 → k1/);
  assert.match(env.text(), /槽位 haiku → p2 @ m Key k9/);
  assert.match(env.text(), /版本 rev-9/);

  const empty = load({ [`GET ${ROUTING_PATH}`]: getRouting({ keys: {}, slots: {} }, 'v') });
  assert.equal(await empty.run(['config', KEY, '--json']), 0);
  assert.deepEqual(JSON.parse(empty.text()), { ok: true, session: KEY, routing: { keys: {}, slots: {} }, revision: 'v' });
});

// ------------------------------------------------------------------ 3) 冲突与失败

test('版本冲突直报并放弃本次写入:PUT 只发一次、不重试、不回退成强写', async () => {
  const env = load({
    [`GET ${ROUTING_PATH}`]: getRouting({ keys: {}, slots: {} }, 'rev-old'),
    [`PUT ${ROUTING_PATH}`]: () => ({ status: 409, data: { error: '服务端会话覆盖已变化' } }),
  });
  assert.equal(await env.run(['set-key', KEY, 'p1', 'k1']), 1);
  assert.equal(env.writes.length, 1, '冲突后不重试');
  assert.equal(env.writes[0].body.expected_revision, 'rev-old');
  assert.match(env.text(), /revision_conflict/);
  assert.match(env.text(), /本次未写入/);
  assert.doesNotMatch(env.text(), /已保存/);
});

test('404 / 400 / 500 各自的码与退出码;读接口失败就不写', async () => {
  const cases = [
    [404, /session_not_found/, /会话不存在/],
    [400, /invalid_routing/, /输入或引用非法/],
    [500, /write_failed/, /回滚|失败/],
  ];
  for (const [status, code, message] of cases) {
    const env = load({
      [`GET ${ROUTING_PATH}`]: getRouting({ keys: {}, slots: {} }, 'r1'),
      [`PUT ${ROUTING_PATH}`]: () => ({ status, data: {} }),
    });
    assert.equal(await env.run(['set-slot', KEY, 'haiku', 'p1']), 1, `HTTP ${status} 必须退出码 1`);
    assert.match(env.text(), code);
    assert.match(env.text(), message);
  }
  const readFail = load({ [`GET ${ROUTING_PATH}`]: () => ({ status: 404, data: { error: '会话不存在(可能已过期)' } }) });
  assert.equal(await readFail.run(['set-key', KEY, 'p1', 'k1']), 1);
  assert.equal(readFail.writes.length, 0, '读不到当前覆盖就不许写');
  assert.match(readFail.text(), /session_not_found/);
});

test('连不上控制台时如实报错,不把失败说成成功', async () => {
  const logs = [];
  const code = await runSessions(['config', KEY], {
    request: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8788'); },
    stdout: { write: t => logs.push(t) }, stderr: { write: t => logs.push(t) },
  });
  assert.equal(code, 1);
  assert.match(logs.join(''), /request_failed/);
  assert.match(logs.join(''), /是否在运行/);
  assert.doesNotMatch(logs.join(''), /已保存|ok":true/);
});

test('控制台挂着不回时命令有界收尾:超时报 request_timeout,不悬挂等待', async () => {
  // 一个永不落地的传输:没有超时的话这条用例会挂到测试框架自己超时(而不是断言失败)。
  const forever = () => new Promise(() => {});
  const logs = [];
  const t0 = Date.now();
  const code = await runSessions(['config', KEY], {
    request: forever, timeoutMs: 60,
    stdout: { write: t => logs.push(t) }, stderr: { write: t => logs.push(t) },
  });
  const elapsed = Date.now() - t0;
  assert.equal(code, 1);
  assert.match(logs.join(''), /request_timeout/);
  assert.match(logs.join(''), /超过 60ms/);
  assert.match(logs.join(''), /本次未确认写入/);
  assert.ok(elapsed < 5000, `必须靠自己的超时收尾,实耗 ${elapsed}ms`);

  // 写路径同样有界:GET 成功后 PUT 挂住
  const writes = [];
  const hangOnPut = async (method, p) => {
    if (String(method).toUpperCase() === 'PUT') { writes.push(p); return new Promise(() => {}); }
    return { status: 200, data: { routing: { keys: {}, slots: {} }, revision: 'r1' } };
  };
  const logs2 = [];
  const code2 = await runSessions(['set-key', KEY, 'p1', 'k1'], {
    request: hangOnPut, timeoutMs: 60,
    stdout: { write: t => logs2.push(t) }, stderr: { write: t => logs2.push(t) },
  });
  assert.equal(code2, 1);
  assert.equal(writes.length, 1, 'PUT 发出去了但没等到响应,不许重发');
  assert.match(logs2.join(''), /request_timeout/);
  assert.doesNotMatch(logs2.join(''), /已保存/);
});

test('响应收一半就断:如实报中断,不把半截体当成功', async () => {
  const truncated = async () => { throw new Error('控制台响应被截断'); };
  const logs = [];
  assert.equal(await runSessions(['config', KEY], {
    request: truncated, stdout: { write: t => logs.push(t) }, stderr: { write: t => logs.push(t) },
  }), 1);
  assert.match(logs.join(''), /request_failed/);
  assert.match(logs.join(''), /被截断/);
  assert.doesNotMatch(logs.join(''), /ok":true/);
});

test('超时默认值有界且可调:默认 10s,环境变量只认正数', () => {
  const { timeoutFromEnv, DEFAULT_TIMEOUT_MS } = require('../lib/cli/sessions');
  assert.equal(DEFAULT_TIMEOUT_MS, 10000);
  assert.equal(timeoutFromEnv({}), DEFAULT_TIMEOUT_MS);
  assert.equal(timeoutFromEnv({ MIXR_SESSION_CLI_TIMEOUT_MS: '2000' }), 2000);
  for (const bad of ['0', '-1', 'abc', '']) assert.equal(timeoutFromEnv({ MIXR_SESSION_CLI_TIMEOUT_MS: bad }), DEFAULT_TIMEOUT_MS,
    `${JSON.stringify(bad)} 不是合法超时,必须落回默认而不是变成 0(0 = 无限等)`);
});

test('--json 下失败也回 JSON,且任何输出里都不出现明文 Key', async () => {
  const env = load({
    [`GET ${ROUTING_PATH}`]: getRouting({ keys: {}, slots: {} }, 'r1'),
    [`PUT ${ROUTING_PATH}`]: () => ({ status: 409, data: { error: '冲突' } }),
  });
  assert.equal(await env.run(['set-key', KEY, 'p1', PLAINTEXT, '--json']), 1);
  assert.equal(env.writes.length, 0, '明文在解析阶段就该被拦下,一个请求都不发');
  const parsed = JSON.parse(env.text());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'invalid_arguments');
  assert.doesNotMatch(env.text(), /sk-ant/);

  const conflict = load({
    [`GET ${ROUTING_PATH}`]: getRouting({ keys: {}, slots: {} }, 'r1'),
    [`PUT ${ROUTING_PATH}`]: () => ({ status: 409, data: { error: '服务端会话覆盖已变化' } }),
  });
  assert.equal(await conflict.run(['set-key', KEY, 'p1', 'k1', '--json']), 1);
  assert.equal(JSON.parse(conflict.text()).error.code, 'revision_conflict');
});

// ------------------------------------------------------------------ 4) 整份校验的失败出路

test('invalid_routing 时把"整份校验"这件事说清楚,并给出一定能写进去的两条路', async () => {
  // 服务端校验的是**整份**会话覆盖:盘上任何一处引用已删渠道/Key,连"只改一项"的保存也会被拒。
  // 那句"所选渠道不存在"看不出这一层,命令要补上 config 与 reset 两条出路,免得反复重试。
  const env = load({
    [`GET ${ROUTING_PATH}`]: getRouting({ keys: {}, slots: {} }, 'r1'),
    [`PUT ${ROUTING_PATH}`]: () => ({ status: 400, data: { error: '所选渠道不存在、重复、已停用或不属于本会话组' } }),
  });
  assert.equal(await env.run(['set-slot', KEY, 'haiku', 'pGONE']), 1);
  assert.match(env.text(), /invalid_routing/);
  assert.match(env.text(), /所选渠道不存在/);
  assert.match(env.text(), /整份/);
  assert.match(env.text(), new RegExp(`mixctl sessions config ${KEY}`));
  assert.match(env.text(), new RegExp(`mixctl sessions reset ${KEY} --yes`));
  assert.doesNotMatch(env.text(), /已保存/);
});

test('成功保存时不打这条提示,别的错误码也不打', async () => {
  const good = load({
    [`GET ${ROUTING_PATH}`]: getRouting({ keys: {}, slots: {} }, 'r1'),
    [`PUT ${ROUTING_PATH}`]: okRouting({ keys: {}, slots: { haiku: { provider: 'p1' } } }, 'r2'),
  });
  assert.equal(await good.run(['set-slot', KEY, 'haiku', 'p1']), 0);
  assert.doesNotMatch(good.text(), /整份/);

  const conflict = load({
    [`GET ${ROUTING_PATH}`]: getRouting({ keys: {}, slots: {} }, 'r1'),
    [`PUT ${ROUTING_PATH}`]: () => ({ status: 409, data: {} }),
  });
  assert.equal(await conflict.run(['set-slot', KEY, 'haiku', 'p1']), 1);
  assert.doesNotMatch(conflict.text(), /整份/);
});

// ------------------------------------------------------------------ 5) 未知子命令与用法

test('未知子命令与 sessions --help 打出用法串,不发任何请求', async () => {
  const env = load({});
  assert.equal(await env.run(['--json']), 1);
  assert.match(env.text(), /需要子命令/);
  const help = load({});
  assert.equal(await help.run(['--help']), 0);
  assert.match(help.text(), /mixctl sessions config <完整会话键>/);
  assert.match(help.text(), /expected_revision/);
  const bogus = load({});
  assert.equal(await bogus.run(['keys', KEY]), 1);
  assert.match(bogus.text(), /未知子命令/);
  assert.equal(bogus.writes.length, 0);
});

// ------------------------------------------------------------------ 6) README 与用法串

test('README 命令总览逐行收录 sessions 覆盖子命令,边界也写进正文', () => {
  const fs = require('node:fs');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const overview = readme.split('## 运行\n')[1].split('\n- **代理端口')[0];
  for (const line of SESSIONS_USAGE.split('\n').slice(0, 6))
    assert.ok(overview.includes(`./${line}`), `README 缺少 ${line}`);
  assert.ok(require('../lib/cli/usage').MAIN_USAGE.includes(SESSIONS_USAGE), '总览必须收录整段用法');
  // 交付物只描述接口约定与本地行为:不写"已部署/已联调真实上游"这类没做过的验证。
  for (const text of ['不接受 Key 明文', '不重复存 Key 明文', 'expected_revision',
    '同身份子请求的边界', 'provider_key_unavailable_error', '显式配置过的会话不被空闲 TTL 剪掉']) {
    assert.ok(readme.includes(text), `README 缺少边界说明:${text}`);
  }
});

// ------------------------------------------------------------------ 7) mixctl 分发与真实 HTTP

function run(args, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MIXCTL, ...args], {
      env: { ...process.env, MIXUI_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

test('mixctl sessions set-slot 真的发 GET+PUT,形状与文档一致', async t => {
  const requests = [];
  const routing = { keys: {}, slots: {} };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      res.end(req.method === 'GET'
        ? JSON.stringify({ routing, revision: 'rev-a' })
        : JSON.stringify({ ok: true, routing: { keys: {}, slots: { haiku: { provider: 'p1', model: 'm' } } }, revision: 'rev-b' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await run(['sessions', 'set-slot', KEY, 'haiku', 'p1', '--model', 'm'], server.address().port);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(requests.map(r => `${r.method} ${r.path}`), [`GET ${ROUTING_PATH}`, `PUT ${ROUTING_PATH}`]);
  assert.deepEqual(requests[1].body, {
    routing: { keys: {}, slots: { haiku: { provider: 'p1', model: 'm' } } }, expected_revision: 'rev-a',
  });
  assert.match(result.output, /已保存会话覆盖/);
  assert.match(result.output, /版本 rev-b/);
});

test('mixctl sessions config --json 直接透出接口字段,不改写形状', async t => {
  const payload = { routing: { keys: { p1: 'k1' }, slots: {} }, revision: 'rev-x' };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await run(['sessions', 'config', KEY, '--json'], server.address().port);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(result.output), { ok: true, session: KEY, routing: payload.routing, revision: payload.revision });
});

test('mixctl sessions 无参数仍是原来的活跃对话列表', async t => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      sessions: [{ key: KEY, short: '11111111', app: 'claude', provider_name: '大渠道', reqs: 3, lastUsed: Date.now(), label: '对话',
        routing: { keys: {}, slots: {} } }],
      cooldowns: [], session_ttl_min: 720, cooldown_s: 60,
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await run(['sessions'], server.address().port);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /活跃对话 1 个/);
  assert.match(result.output, /11111111/);
  assert.match(result.output, /大渠道/);
});

test('列表给每条都印完整会话键:新会话(还没覆盖)也必须拿得到,才能做第一次 set-key', async t => {
  const fresh = 'cc:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const set = 'cx:99999999-8888-7777-6666-555555555555';
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      sessions: [
        { key: fresh, short: 'aaaaaaaa', app: 'claude', provider_name: 'PA', reqs: 1, lastUsed: Date.now(), label: '新对话', routing: { keys: {}, slots: {} } },
        { key: set, short: '99999999', app: 'codex', provider_name: 'PB', reqs: 2, lastUsed: Date.now(), label: '已配', routing: { keys: { p1: 'k2' }, slots: {} } },
      ],
      cooldowns: [], session_ttl_min: 720, cooldown_s: 60,
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await run(['sessions'], server.address().port);
  assert.equal(result.code, 0, result.output);
  const tail = result.output.split('完整会话键')[1];
  assert.ok(tail, '列表必须给出完整会话键那一段');
  assert.ok(tail.includes(fresh), `新会话的完整键必须印出来(否则第一次 set-key 无从下手):${tail}`);
  assert.ok(tail.includes(set), '已配会话的完整键也要在');
  // 覆盖与否只靠标记区分;上面的两列原样保留
  assert.match(tail, new RegExp(`\\* ${set.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(tail, new RegExp(`   ${fresh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.output, /会话 {2,}组 {2,}渠道/);
});

test('控制台挂着不回:真实 mixctl 必须**自己退出**,不留挂着连接的进程', async t => {
  // 这条用例只认"进程退没退",不认提示文案 —— 传输层的超时必须真的
  // destroy 掉那条连接。实测过的失败形状:提示照打、退出码也对,而 socket 还开着,
  // 进程永远不退(从用户那边看就是命令还在挂)。
  const net = require('node:net');
  const silent = net.createServer(socket => { socket.on('data', () => {}); socket.on('error', () => {}); });
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => silent.close(resolve)));
  const port = silent.address().port;

  const t0 = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MIXCTL, 'sessions', 'config', KEY], {
      env: { ...process.env, MIXUI_PORT: String(port), MIXR_SESSION_CLI_TIMEOUT_MS: '700' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', c => output += c);
    child.stderr.on('data', c => output += c);
    child.on('error', reject);
    // 到这里还没退,就是"挂着"——杀掉并把耗时如实带出去,断言里会说清。
    const killer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, killed: true, output, ms: Date.now() - t0 }); }, 6000);
    child.on('close', code => { clearTimeout(killer); resolve({ code, killed: false, output, ms: Date.now() - t0 }); });
  });
  assert.equal(result.killed, false, `mixctl 没有自己退出(等了 ${result.ms}ms),说明超时没关掉连接:${result.output}`);
  assert.equal(result.code, 1);
  assert.match(result.output, /request_timeout/);
  assert.ok(result.ms < 5000, `应当按 700ms 的超时收尾,实耗 ${result.ms}ms`);
});
