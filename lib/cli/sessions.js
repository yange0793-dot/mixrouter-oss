'use strict';
// mixctl sessions 的会话级 Key / 槽位覆盖子命令:
//   config / set-key / set-slot / clear-slot / reset
//
// 传输由调用方注入(request(method, path, body) → Promise<{status, data}>),与 lib/cli/logs.js 同一个套路:
// 本模块 require 时不读配置、不连服务、不读环境变量,所以能在测试进程里直接加载并断言编排与请求体。
//
// 三条纪律(对应会话覆盖的写入语义):
//   · 只走会话覆盖这一个接口面:GET 拿最新覆盖与版本 → 只改用户点名的那一项 → PUT 带 expected_revision。
//     版本对不上就**直报冲突并放弃本次写入**,不覆盖、不强写、不自动重试。
//   · 命令行只接受渠道内已有的 **Key ID**,不接受 Key 明文:argv 里的东西会进 shell 历史与进程表。
//   · 不碰 /api/router/*、不写客户端配置、不改渠道的 active_key —— 那是 route / switch 的事。

// explain 已经用同一套前缀约定把"完整会话键"钉死(见 mixctl 的 EXPLAIN 校验),这里保持一致。
const SESSION_KEY_RE = /^(?:cc|cx|fp|cxf):\S+$/;
// 身份取不到任何来源时 identity 会给出这两个字面量,它们是真实存在的会话键,一并放行。
const ANON_SESSION_KEYS = ['anon', 'cx-anon'];
const CTRL_RE = /[\u0000-\u001f\u007f]/;
// 渠道内 Key ID 的上限。超过就当用户把 Key 明文贴上来了 —— 见 keyIdValue 的说明。
const KEY_ID_MAX = 64;

const SUBCOMMANDS = ['config', 'set-key', 'set-slot', 'clear-slot', 'reset'];
// 解析器先按这一份**全局**白名单收(不然 `--model` 这种词在别的子命令下会被当成路径参数),
// 再由 ALLOWED 按子命令收窄:`reset --model x` 这种写错的调用必须当场报错,不能静默忽略。
const ALL_FLAGS = ['json', 'inherit', 'yes'];
const ALL_VALUES = ['model', 'key-id'];
const ALLOWED = {
  config: { flags: ['json'], values: [] },
  'set-key': { flags: ['json', 'inherit'], values: [] },
  'set-slot': { flags: ['json'], values: ['model', 'key-id'] },
  'clear-slot': { flags: ['json'], values: [] },
  reset: { flags: ['json', 'yes'], values: [] },
};

const SESSIONS_USAGE = 'mixctl sessions\n' +
  'mixctl sessions config <完整会话键> [--json]\n' +
  'mixctl sessions set-key <完整会话键> <渠道ID> <KeyID|--inherit> [--json]\n' +
  'mixctl sessions set-slot <完整会话键> <槽名> <渠道ID> [--model <模型>] [--key-id <KeyID>] [--json]\n' +
  'mixctl sessions clear-slot <完整会话键> <槽名> [--json]\n' +
  'mixctl sessions reset <完整会话键> --yes [--json]\n' +
  '  无子命令 = 列出当前活跃对话(旧行为不变);子命令读写**这一条会话**的 Key 与槽位覆盖\n' +
  '  完整会话键 = cc:/cx:/fp:/cxf: 前缀 + 会话 id,取「会话」页那一列的完整形态,短 id 不能用\n' +
  '  set-key  只认渠道内已有的 Key ID,不接受 Key 明文;--inherit 摘掉该渠道的覆盖,回落全局\n' +
  '  set-slot 该槽整体替换:不给 --model 就是不覆盖模型(回落全局槽位的模型),--key-id 同理\n' +
  '  reset    清空这条会话的全部覆盖,需显式 --yes(默认只提示不做)\n' +
  '  读-改-写:GET 最新覆盖与版本 → 只改点名项 → PUT 带 expected_revision;版本冲突直报,不强写\n' +
  '  需控制台在运行(127.0.0.1:$MIXUI_PORT);输出不含任何 Key 明文';

const invalid = message => Object.assign(new Error(message), { code: 'invalid_arguments' });
const fail = (code, message) => Object.assign(new Error(message), { code });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const cloneRouting = value => JSON.parse(JSON.stringify(value));
// 路由数据来自 JSON 响应,没有循环引用与函数;这条克隆只是"不就地改服务端那份,也不改调用方那份"。

function parseArgs(argv) {
  const opts = { flags: new Set(), values: new Map(), positional: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { opts.help = true; continue; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const known = ALL_FLAGS.includes(name) ? 'flag' : (ALL_VALUES.includes(name) ? 'value' : null);
      if (known === null) throw invalid(`无法识别的选项 ${arg};仅支持 ${ALL_FLAGS.map(f => '--' + f).join(' / ')} 与 ` +
        `${ALL_VALUES.map(v => '--' + v + ' <值>').join(' / ')}`);
      if (known === 'flag') {
        if (opts.flags.has(name)) throw invalid(`--${name} 不能重复`);
        if (eq >= 0) throw invalid(`--${name} 不接受值`);
        opts.flags.add(name);
        continue;
      }
      if (opts.values.has(name)) throw invalid(`--${name} 不能重复`);
      let value;
      if (eq >= 0) value = arg.slice(eq + 1);
      else {
        value = argv[++i];
        if (value === undefined || value.startsWith('--')) throw invalid(`--${name} 缺少值`);
      }
      if (!value) throw invalid(`--${name} 缺少值`);
      opts.values.set(name, value);
      continue;
    }
    if (arg.startsWith('-')) throw invalid(`无法识别的选项 ${arg}`);
    opts.positional.push(arg);
  }
  return opts;
}

function checkAllowed(sub, opts) {
  const allowed = ALLOWED[sub];
  for (const name of opts.flags) if (!allowed.flags.includes(name)) throw invalid(`${sub} 不支持 --${name}`);
  for (const name of opts.values.keys()) if (!allowed.values.includes(name)) throw invalid(`${sub} 不支持 --${name}`);
}

// ---- 形状校验(只判"能当标识用",引用是否真的存在由服务端判定并 400)

function plainText(raw, label) {
  const value = String(raw == null ? '' : raw);
  if (!value) throw invalid(`${label}不能为空`);
  if (CTRL_RE.test(value)) throw invalid(`${label}不能包含控制字符`);
  return value;
}

function plainId(raw, label) {
  const value = plainText(raw, label);
  if (/\s/.test(value)) throw invalid(`${label}不能包含空白字符`);
  return value;
}

function sessionKeyValue(raw) {
  const value = String(raw == null ? '' : raw);
  if (!value) throw invalid('必须给出完整会话键(形如 cc:… / cx:…),列表里的短 id 定位不到会话');
  if (CTRL_RE.test(value)) throw invalid('会话键不能包含控制字符');
  if (ANON_SESSION_KEYS.includes(value)) return value;
  if (!SESSION_KEY_RE.test(value)) throw invalid('会话键必须是带 cc:/cx:/fp:/cxf: 前缀的完整键,不能用列表里的短 id');
  return value;
}

// Key ID 是渠道内已有的账号标识(如 k2),**不是** Key 本身。
// 认不出来的长串一律按"贴了明文"处理:命令行不接受密钥,argv 会进 shell 历史、
// ps 输出与终端回滚,把明文拦在参数解析这一步,别让它有机会发给任何人。
function keyIdValue(raw) {
  const value = plainId(raw, 'Key ID');
  if (value.length > KEY_ID_MAX || /^(?:sk|key|ak)-/i.test(value))
    throw invalid('这里只接受渠道内已有的 Key ID(控制台渠道弹窗里那一行的标识),不接受 Key 明文;' +
      '新账号请在控制台添加到渠道后,再用它的 ID 绑定');
  return value;
}

function slotNameValue(raw) {
  const value = plainId(raw, '槽名');
  if (value.startsWith('mixr-'))
    throw invalid(`槽名要写槽位表里的名字(如 haiku),不用写客户端别名 ${value};别名由路由模式写入客户端`);
  return value;
}

// ---- 传输

// 有界等待。控制台卡住、或响应收一半就断,命令必须自己收尾并如实报错 ——
// 一条管理命令挂在原地比失败更糟:用户不知道它是在等、还是已经没戏了。
// unref 不在这里做:超时本身就是要等出来的结论,提前退出等于把"挂了"报成"没事"。
//
// 10s 对回环是绰绰有余的;要过慢链路可用 MIXR_SESSION_CLI_TIMEOUT_MS 放宽(毫秒,>0 才认)。
// 这个值**在调用时读**:require 本模块不读环境变量,测试进程才能按用例改。
const DEFAULT_TIMEOUT_MS = 10000;
function timeoutFromEnv(env) {
  const raw = env && env.MIXR_SESSION_CLI_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

const sessionPath = key => `/api/sessions/${encodeURIComponent(key)}/routing`;

function serverMessage(res, fallback) {
  const data = res && res.data;
  if (data && typeof data.error === 'string' && data.error.trim()) return data.error.trim();
  return fallback;
}

function statusError(status, res) {
  if (status === 404) return fail('session_not_found', serverMessage(res, '会话不存在(可能已过期或从未建立)'));
  if (status === 409) return fail('revision_conflict',
    '会话覆盖已被其他操作改动(版本不匹配),本次未写入;请重新执行一次,本命令不会覆盖新版本');
  if (status === 400) return fail('invalid_routing', serverMessage(res, '输入或引用非法(渠道或 Key 可能已删除、停用)'));
  if (status === 500) return fail('write_failed', serverMessage(res, '写入会话覆盖失败,服务端已回滚'));
  return fail('http_error', serverMessage(res, `控制台返回 HTTP ${status}`));
}

async function send(request, method, path, body, timeoutMs) {
  let res;
  let timer = null;
  let timedOut = false;
  try {
    res = await Promise.race([
      // ⚠ 超时必须**同时**交给传输层:这里的 race 只保证"命令会回来",它并不关闭底层连接
      // (实测:漏传时提示照打、退出码也对,而那条 socket 还开着,进程永远不退 —— 从用户
      // 那边看就是命令还在挂)。传输层(self 那侧)按这个值 destroy 掉请求,连接才真的收尾;
      // 这里的 race 只当兜底:注入的传输若忽略这个参数,至少命令不会无限等。
      Promise.resolve().then(() => request(method, path, body, timeoutMs)),
      new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(new Error('timeout')); }, timeoutMs);
      }),
    ]);
  } catch (e) {
    if (timedOut) throw fail('request_timeout',
      `等待控制台响应超过 ${timeoutMs}ms,本次未确认写入(检查服务是否卡住;命令没有悬挂等待)`);
    throw fail('request_failed',
      `无法连接本机控制台或响应中断(检查 mixrouter 是否在运行):${(e && e.message) || e}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res || typeof res.status !== 'number') throw fail('invalid_response', '控制台返回的不是合法结果');
  return res;
}

function readRoutingShape(data) {
  if (!isObject(data) || !isObject(data.routing) || typeof data.revision !== 'string' || !data.revision)
    throw fail('invalid_response', '会话覆盖接口返回的字段不完整(需要 routing 与 revision)');
  const routing = data.routing;
  if (routing.keys !== undefined && !isObject(routing.keys))
    throw fail('invalid_response', '会话覆盖的 keys 不是对象');
  if (routing.slots !== undefined && !isObject(routing.slots))
    throw fail('invalid_response', '会话覆盖的 slots 不是对象');
  return { routing, revision: data.revision };
}

async function readConfig(request, key, timeoutMs) {
  const res = await send(request, 'GET', sessionPath(key), undefined, timeoutMs);
  if (res.status !== 200) throw statusError(res.status, res);
  return readRoutingShape(res.data);
}

async function writeConfig(request, key, routing, expectedRevision, timeoutMs) {
  const res = await send(request, 'PUT', sessionPath(key), { routing, expected_revision: expectedRevision }, timeoutMs);
  if (res.status !== 200) throw statusError(res.status, res);
  const data = res.data;
  if (!isObject(data) || data.ok !== true) throw fail('invalid_response', '控制台未确认保存成功(响应缺少 ok),不确定是否已写入');
  const saved = isObject(data.routing) ? data.routing : routing;
  const revision = typeof data.revision === 'string' && data.revision ? data.revision : expectedRevision;
  return { routing: saved, revision };
}

// ---- 参数 → 计划

function planFor(sub, opts) {
  checkAllowed(sub, opts);
  const p = opts.positional;
  if (sub === 'config') {
    if (p.length !== 1) throw invalid('config 只接受一个参数:完整会话键');
    return { action: 'config', session: sessionKeyValue(p[0]) };
  }
  if (sub === 'set-key') {
    const inherit = opts.flags.has('inherit');
    if (p.length < 2 || p.length > 3) throw invalid('set-key 需要 <完整会话键> <渠道ID>,再加一个 <KeyID> 或 --inherit');
    if (inherit && p.length !== 2) throw invalid('给了 --inherit 就不能再给 Key ID');
    if (!inherit && p.length !== 3) throw invalid('set-key 需要 Key ID,或用 --inherit 恢复继承全局 Key');
    return { action: 'set-key', session: sessionKeyValue(p[0]), provider: plainId(p[1], '渠道ID'),
      inherit, keyId: inherit ? '' : keyIdValue(p[2]) };
  }
  if (sub === 'set-slot') {
    if (p.length !== 3) throw invalid('set-slot 需要 <完整会话键> <槽名> <渠道ID>');
    const plan = { action: 'set-slot', session: sessionKeyValue(p[0]), slot: slotNameValue(p[1]),
      provider: plainId(p[2], '渠道ID') };
    if (opts.values.has('model')) plan.model = plainText(opts.values.get('model'), '模型名');
    if (opts.values.has('key-id')) plan.keyId = keyIdValue(opts.values.get('key-id'));
    return plan;
  }
  if (sub === 'clear-slot') {
    if (p.length !== 2) throw invalid('clear-slot 需要 <完整会话键> <槽名>');
    return { action: 'clear-slot', session: sessionKeyValue(p[0]), slot: slotNameValue(p[1]) };
  }
  if (p.length !== 1) throw invalid('reset 需要 <完整会话键>');
  return { action: 'reset', session: sessionKeyValue(p[0]), yes: opts.flags.has('yes') };
}

// ---- 覆盖改写(就地改 next,并如实说明改了什么)

const slotText = slot => {
  const provider = slot && typeof slot.provider === 'string' && slot.provider ? slot.provider : '(缺渠道)';
  const model = slot && typeof slot.model === 'string' && slot.model ? ` @ ${slot.model}` : '';
  const key = slot && typeof slot.key_id === 'string' && slot.key_id ? ` Key ${slot.key_id}` : '';
  return `${provider}${model}${key}`;
};
const sameSlot = (a, b) => !!a && a.provider === b.provider
  && (a.model || '') === (b.model || '') && (a.key_id || '') === (b.key_id || '');

function mutate(plan, routing) {
  if (!isObject(routing.keys)) routing.keys = {};
  if (!isObject(routing.slots)) routing.slots = {};
  if (plan.action === 'set-key') {
    if (plan.inherit) {
      if (!(plan.provider in routing.keys))
        return { changed: false, line: `渠道 ${plan.provider} 本来就没有 Key 覆盖(已在继承全局 Key)` };
      delete routing.keys[plan.provider];
      return { changed: true, line: `Key  ${plan.provider} 摘掉覆盖,回落全局 Key` };
    }
    if (routing.keys[plan.provider] === plan.keyId)
      return { changed: false, line: `渠道 ${plan.provider} 已经指向 Key ${plan.keyId}` };
    routing.keys[plan.provider] = plan.keyId;
    return { changed: true, line: `Key  ${plan.provider} → ${plan.keyId}` };
  }
  if (plan.action === 'set-slot') {
    const next = { provider: plan.provider };
    if (plan.model !== undefined) next.model = plan.model;
    if (plan.keyId !== undefined) next.key_id = plan.keyId;
    const prev = routing.slots[plan.slot];
    if (sameSlot(prev, next))
      return { changed: false, line: `槽位 ${plan.slot} 已经是 ${slotText(next)}` };
    routing.slots[plan.slot] = next;
    return { changed: true, line: `槽位 ${plan.slot} → ${slotText(next)}` };
  }
  if (plan.action === 'clear-slot') {
    if (!(plan.slot in routing.slots))
      return { changed: false, line: `槽位 ${plan.slot} 本来就没有覆盖(已在继承全局槽位)` };
    delete routing.slots[plan.slot];
    return { changed: true, line: `槽位 ${plan.slot} 摘掉覆盖,回落全局槽位` };
  }
  if (!Object.keys(routing.keys).length && !Object.keys(routing.slots).length)
    return { changed: false, line: '这条会话本来就没有覆盖,Key 与槽位都继承全局配置' };
  routing.keys = {};
  routing.slots = {};
  return { changed: true, line: 'Key 与槽位覆盖已整条清空,全部回落全局配置' };
}

// ---- 输出

function printConfig(out, key, routing, revision) {
  const keys = Object.entries(routing.keys || {});
  const slots = Object.entries(routing.slots || {});
  if (!keys.length && !slots.length) {
    out.write(`会话 ${key} 没有覆盖:Key 与槽位都继承全局配置(版本 ${revision})。\n`);
    return;
  }
  out.write(`会话 ${key} 的覆盖(版本 ${revision}):\n`);
  for (const [provider, id] of keys) out.write(`  Key  ${provider} → ${id}\n`);
  for (const [name, slot] of slots) out.write(`  槽位 ${name} → ${slotText(slot)}\n`);
  out.write('未列出的渠道与槽位继承全局配置(版本一致才能保存,冲突时本命令不写入)。\n');
}

// argv 是用户可见输入;错误里只回显"哪个参数不对",不回显调用方给的值(可能夹着明文)。
const jsonError = error => ({ ok: false, error: { code: error.code || 'sessions_failed', message: error.message } });

async function runSessions(args, io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const argv = Array.isArray(args) ? args : [];
  // 超时可由调用方(测试)缩短;默认 10s,足够本机回环,又不至于让命令无限等下去。
  const timeoutMs = Number.isFinite(io.timeoutMs) && io.timeoutMs > 0 ? io.timeoutMs : timeoutFromEnv(io.env || process.env);
  // 解析失败也要按用户要的格式输出,所以先粗看一遍有没有 --json。
  // session 也要提到 try 外面:错误分支要拿它拼"下一步怎么办"的命令,而 plan 只活在 try 里。
  let json = argv.includes('--json');
  let session = '';
  try {
    if (!argv.length || argv.some(a => a === '-h' || a === '--help')) { out.write(`${SESSIONS_USAGE}\n`); return 0; }
    const sub = argv[0];
    if (sub.startsWith('-'))
      throw invalid(`sessions 需要子命令(${SUBCOMMANDS.join(' / ')});只看活跃对话请直接执行 mixctl sessions`);
    if (!SUBCOMMANDS.includes(sub)) throw invalid(`未知子命令 ${sub};可用:${SUBCOMMANDS.join(' / ')}`);
    const opts = parseArgs(argv.slice(1));
    json = opts.flags.has('json');
    const plan = planFor(sub, opts);
    session = plan.session;
    const request = io.request;
    if (typeof request !== 'function') throw fail('no_transport', '会话子命令需要注入 HTTP 传输(request)');

    if (plan.action === 'reset' && !plan.yes)
      throw invalid('reset 会清空这条会话的全部 Key 与槽位覆盖;确认后加 --yes 执行(未做任何改动)');

    const current = await readConfig(request, plan.session, timeoutMs);
    if (plan.action === 'config') {
      if (json) out.write(`${JSON.stringify({ ok: true, session: plan.session, ...current }, null, 2)}\n`);
      else printConfig(out, plan.session, current.routing, current.revision);
      return 0;
    }

    const next = cloneRouting(current.routing);
    const change = mutate(plan, next);
    if (!change.changed) {
      const result = { ok: true, session: plan.session, action: plan.action, changed: false,
        routing: current.routing, revision: current.revision };
      if (json) out.write(`${JSON.stringify(result, null, 2)}\n`);
      else out.write(`会话覆盖 ${plan.session} 未改动:\n  ${change.line}\n版本 ${current.revision}\n`);
      return 0;
    }

    const saved = await writeConfig(request, plan.session, next, current.revision, timeoutMs);
    if (json) out.write(`${JSON.stringify({ ok: true, session: plan.session, action: plan.action, changed: true,
      routing: saved.routing, revision: saved.revision }, null, 2)}\n`);
    else out.write(`已保存会话覆盖 ${plan.session}:\n  ${change.line}\n版本 ${saved.revision}\n`);
    return 0;
  } catch (e) {
    const error = { code: e.code || 'sessions_failed', message: e.message };
    if (json) out.write(`${JSON.stringify({ ok: false, error }, null, 2)}\n`);
    else {
      err.write(`会话覆盖失败 [${error.code}]: ${error.message}\n`);
      // 会话覆盖是**整份**校验:盘上任何一处引用已删渠道/Key,服务端都会拒掉这次保存 ——
      // 包括看起来只改了一项的那次。这一点从服务端那句"所选渠道不存在…"看不出来,
      // 所以把两条"一定能写进去"的路一并说清,免得用户反复重试同一条命令。
      if (error.code === 'invalid_routing')
        err.write('提示:服务端校验的是整份会话覆盖。若其中有过期引用(渠道或 Key 已删),' +
          '任何一次保存都会被拒;可先清空再重配:\n' +
          `  mixctl sessions config ${session}         # 看完整覆盖,定位过期项\n` +
          `  mixctl sessions reset ${session} --yes    # 清空这条会话的覆盖,回到全部继承\n`);
    }
    return 1;
  }
}

module.exports = { SESSIONS_USAGE, SUBCOMMANDS, DEFAULT_TIMEOUT_MS, timeoutFromEnv, parseArgs, planFor, mutate, runSessions, sessionKeyValue, keyIdValue };
