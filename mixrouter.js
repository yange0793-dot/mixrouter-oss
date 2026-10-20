#!/usr/bin/env node
// ============================================================================
// mixrouter v3.2 — 本地模型路由器 + cc-switch 式客户端配置切换
//   :8787  代理端口  Claude 组:/v1/messages、count_tokens(Anthropic 协议)
//                   Codex  组:/v1/responses、/v1/chat/completions(OpenAI 协议)
//   :8788  控制台   渠道(Claude Code / Codex 两组)/ 路由 / 槽位 / 会话 / 日志
// 零依赖,Node >= 18。数据文件:providers.json、routes.json、slots.json、sessions.json
//
// v3 核心:同一个 Agent 的多个对话可以走不同渠道(key)
//   Claude Code 每个对话都带 x-claude-code-session-id(metadata.user_id 里也有),
//   Codex 0.154 每个请求都带 session-id / thread-id 头(body.prompt_cache_key 同值),
//   代理以它为"对话"身份,把渠道池里的成员按会话粘性分配——每个对话锁一个渠道,
//   对话内所有请求(含子代理、count_tokens)始终走同一个,不会中途换 key 打断缓存。
//   Codex 上游若是只开 chat/completions 的网关,代理自动翻译协议(responses ⇄ chat)。
// ============================================================================
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zcodeConfig = require('./lib/zcode-config');
// saveJson 原来定义在本文件里;机制已合并进 lib/atomic-write.js
// (同一个仓库不留两份逐字相同的实现),这里只把名字接过来,
// 下面的调用点与注入 createSessionStore 的 deps 一字不用改。
const { writeFileAtomic, writeJsonAtomic: saveJson } = require('./lib/atomic-write');
// 运行期日志清理(responses 归档目录 + launchd.log)。requests.jsonl 由
// request-log/log-files 那套按天轮转管,不归这里 —— 见该模块头注释。
const { sweepLogs, DEFAULT_RETAIN_DAYS } = require('./lib/log-retention');
// claude 客户端 + chat/responses 上游两条翻译线共用的收尾(原来各写一遍,见该模块头注释)
const { createAnthropicTranslator } = require('./lib/wire-anthropic-translator');
const wireResponses = require('./lib/wire-responses');
const wireChat = require('./lib/wire-chat');
const { upstreamAgent, transportAgent, destroyAgents } = require('./lib/upstream-proxy');
const toolFilter = require('./lib/tool-filter');
const { codeRevision } = require('./lib/runtime-code');
// ---- 路由与会话模块(require 不启动服务)----
const endpoints = require('./lib/routing/endpoints');
const headersLib = require('./lib/routing/headers');
const rulesLib = require('./lib/routing/rules');
const strategyLib = require('./lib/routing/strategy');
const poolLib = require('./lib/routing/pool');
const compactLib = require('./lib/routing/compact');
const { ringOf } = require('./lib/routing/keys');
const sessionConfig = require('./lib/routing/session-config');
const { createCompactWindow } = require('./lib/compact-window');
const { createResolver } = require('./lib/routing/resolve');
const { createExplainer } = require('./lib/routing/explain');
const { createSessionStore } = require('./lib/routing/sessions');
const slotsLib = require('./lib/routing/slots');
const { createRequestLog } = require('./lib/observability/request-log');
// 用量统计(磁盘日志 + 内存环,lib/usage/*):控制台 /api/usage 的后端。
const { createUsageSummary } = require('./lib/usage/summary');
// 备份池目标表**唯一**一份(见该模块文件头:/api/backups 与 mixctl 都从它取,谁都不许自己再列)。
// LIVE_FILES 同时是本文件下面三个常量(DATA_DIR / CLAUDE_SETTINGS / CODEX_CONFIG)的真值来源 ——
// 同一条路径规则存两份,失败模式不是当场出错,是**很久以后在别处出错**(实测过:默认值写错时
// 全部用例仍绿,因为测试全程设着环境变量,默认值分支根本走不到)。见该模块 LIVE_FILES 那节。
const { LIVE_FILES } = require('./lib/backup/targets');
const wireOpenai = require('./lib/wire-openai-bridge');
const identity = require('./lib/session/identity');
const { createResponseArchive } = require('./lib/observability/response-archive');
// ---- 请求体 / 上游响应攒包 ----
// 这两组原来都在本文件里:深度守卫与两套读体各写一份、攒包模式在代理响应分支里抄了八遍。
// 判据与形状搬进模块,本文件只留调用点。
// 注意 http/api 两侧的响应体出口不同:代理走 protoErrorLib(OpenAI/Anthropic 形状),
// 控制台走 lib/http/respond.js —— 后者已随 apiHandler 一起搬进 lib/http/console.js。
const httpBody = require('./lib/http/body');
const protoErrorLib = require('./lib/http/proto-error');
const collect = require('./lib/upstream-collect');
// 上游错误体 → 人话原因(三条线共用;但**怎么写日志、回什么形状**各线有意不同)
const { upstreamErrorText } = require('./lib/upstream-error-text');
// 上游原因落进日志的写法(6 处 slice(0,400)。空体 → '(空响应体)')
const { clip, errBodyText, errLine, errLineOrPlaceholder } = require('./lib/observability/err-text');
// [1M] 后缀 → 剥后缀 + 追加 anthropic-beta(见模块头:headers 必须真传进来)
const { applyModel } = require('./lib/model-suffix');
// TOML 基本字符串与 config.toml 顶层键读取。读与写必须是同一套认法,所以这两个名字
// 由 lib/codex-config.js 统一提供(见下面 codexTopLevel 的定义处)。
// 客户端配置文件的写前备份(名字模板与保留池规则是契约,见模块头)
const { backupFile } = require('./lib/config-backup');
// 渠道连通性测试:先探隧道再探上游(拆成三个模块,这里只接总入口)
const { testProvider } = require('./lib/provider-test');
// Codex 配置的读写引擎:解析/校验/外科手术式改写 + 能力目录同步。
// **这是全树唯一的 TOML 实现**(第二期合并完成):lib/toml.js 与 lib/codex-toml.js 现在只是
// 它的薄适配(名字转发,没有自己的算法)。旧名字保留是为了既有导出面与测试,
// 见下面 writeCodexConfig / liveState 的说明。
const codexConfig = require('./lib/codex-config');

const VERSION = '3.7.0';
const ROOT = __dirname;
const CODE_REVISION = codeRevision(ROOT);
// 运行时数据(providers/routes/logs)目录可整体重定向(MIXR_DATA_DIR),测试用,避免碰真实配置
const DATA_DIR = LIVE_FILES.dataDir(process.env, ROOT);
const PROXY_PORT = Number(process.env.MIXROUTER_PORT || 8787);
const UI_PORT = Number(process.env.MIXUI_PORT || 8788);
const HOST = '127.0.0.1';
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');
const ROUTES_FILE = path.join(DATA_DIR, 'routes.json');
const LOG_FILE = path.join(DATA_DIR, 'logs', 'requests.jsonl');
// 返回正文可能含用户数据，只有显式开启才保存，不进入元数据日志或控制台 API。
const RESPONSE_ARCHIVE_ON = process.env.MIXR_RESPONSE_ARCHIVE === 'on';
const RESPONSE_ARCHIVE_DIR = process.env.MIXR_RESPONSE_ARCHIVE_DIR || path.join(DATA_DIR, 'logs', 'responses');
const PUBLIC_DIR = path.join(ROOT, 'public');
// 环境变量整数解析:非法值一律回落默认,不让 NaN 渗进后面的比较
// (定义放在 BODY_LIMIT 之前,因为 BODY_LIMIT 自己就要用它)
function envInt(name, fallback, min = 1, max = 2147483647) {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}
// 请求体上限可用环境变量调小(测试用),默认 64MB。
// 必须走整数校验:这里原先写的是 Number(process.env.MIXR_BODY_LIMIT_MB || 64),
// 传个非数字就得到 NaN,而 `size > NaN` 恒为 false —— 上限静默失效,多大的请求体都照收。
const BODY_LIMIT = envInt('MIXR_BODY_LIMIT_MB', 64, 1, 2048) * 1024 * 1024;
// 判定超限之后还愿意替客户端排空多少字节。排空是为了让 413 真能送达:请求体没收完就结束
// 响应,Node 会直接销毁这条 socket,客户端只看到 ECONNRESET、连错误体都拿不到
// (大请求用例那条偶发 write ECONNRESET 就是这么来的)。但排空不能没上限,
// 否则一个一直灌的客户端能把这条连接占死。取「再收一个 BODY_LIMIT」与 32MB 的较小值。
const BODY_DRAIN_EXTRA = Math.min(BODY_LIMIT, 32 * 1024 * 1024);
// 排空还受**时间**约束。字节预算只在客户端继续发的时候才会被撞到:一个超限之后干脆
// 停住不发的客户端(卡死、半开、或故意吊着),既撞不到预算也等不到 `end`,这条连接就会
// 一直挂到 Node 自己的 requestTimeout(默认 300s)。等一个不会再来的请求体没有意义,
// 到点就把 413 发出去再断开——对卡住的客户端,这与修复前的行为一致,不会更差。0 = 不设时限。
const BODY_DRAIN_MS = envInt('MIXR_BODY_DRAIN_MS', 10000, 0, 600000);
// 排空预算被击穿过的次数(客户端超限之后还在灌,代理不再陪它收)。
// 既是运维信号,也是测试唯一能确切观测的抓手:"413 有没有送到一个还在猛灌的客户端"
// 取决于内核缓冲与解析时序,拿它当断言会偶发红;击穿次数是服务端侧的确定事实。
let bodyDrainAborts = 0;
// 排空超时(客户端超限后停住不发)的次数。与上面同理:这是服务端侧的确定事实,
// 客户端那边看到的是 413 还是 ECONNRESET 取决于时序,不能拿来做断言。
let bodyDrainTimeouts = 0;
// JSON 嵌套深度上限与守卫、以及两套读体(代理入口 / 控制台写接口)的实现都在 lib/http/body.js,
// 连"超限时报哪句话"也在那边。这里不留裸名,调用点一律 httpBody.*。
// ---- 端到端超时预算 ----
// 客户端(Claude Code)默认 API_TIMEOUT_MS=300s 是整条请求的总预算,CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=120s
// 是"多久没收到字节就本地放弃"。本进程的三段超时必须**全部**落在客户端预算里面:
// 一旦反过来(以前三段都是 600s),客户端会先放弃并重发,我们还在替一条没人接收的响应占着
// 上游连接和渠道额度,日志也记成 499 client closed 而不是真实的 timeout。
// 所以:总 deadline 卡在最外层,三段各自再被它夹住,谁都超不出去。
const TOTAL_DEADLINE_MS = envInt('MIXR_TOTAL_DEADLINE_MS', 240000);
const FIRST_HEADER_TIMEOUT_MS = Math.min(envInt('MIXR_FIRST_HEADER_TIMEOUT_MS', 120000), TOTAL_DEADLINE_MS);
// 流式请求的上游一接受就会发响应头,迟迟等不到头基本就是死了,不必陪着耗到总预算
const STREAM_FIRST_HEADER_TIMEOUT_MS = Math.min(envInt('MIXR_STREAM_FIRST_HEADER_TIMEOUT_MS', 60000), TOTAL_DEADLINE_MS);
const firstHeaderTimeoutFor = stream => (stream ? STREAM_FIRST_HEADER_TIMEOUT_MS : FIRST_HEADER_TIMEOUT_MS);
// 兼容监听:旧客户端把 BASE_URL 写死到别的端口(如切换器/本地转换代理的端口)时,
// 让本进程顺带在那个端口上也服务——接管时**正在跑**的会话不必重启。best-effort,占不到只告警。
function altPorts(primary, ui) {
  const ports = String(process.env.MIXROUTER_ALT_PORTS || '').split(',').map(s => Number(s.trim()))
    .filter(p => Number.isInteger(p) && p > 0 && p < 65536 && p !== primary && p !== ui);
  return [...new Set(ports)];
}
// 上游两次字节之间:必须 **小于** 客户端的字节流空闲超时,否则客户端先本地放弃,
// 我们"上游空闲中断 + 换渠道"的诊断根本来不及送到(这正是长上下文被连杀的表现)
const STREAM_IDLE_TIMEOUT_MS = Math.min(envInt('MIXR_STREAM_IDLE_TIMEOUT_MS', 90000), TOTAL_DEADLINE_MS);
const NONSTREAM_TOTAL_TIMEOUT_MS = Math.min(envInt('MIXR_NONSTREAM_TOTAL_TIMEOUT_MS', 180000), TOTAL_DEADLINE_MS);
// 已经提交给客户端的流式响应:每隔这么久补一行 SSE 注释,让客户端的字节流空闲计时器知道连接还活着
// (上游在慢慢推理时这条通道会一直沉默)。0 = 关掉。
const SSE_KEEPALIVE_MS = envInt('MIXR_SSE_KEEPALIVE_MS', 15000, 0);
// 探活的时限、兜底 UA、响应体保留长度都不在这里了:它们随探测实现搬到
// lib/upstream-probe.js(那份 UA 是"探活时怎么自称",与下面两个转发的 UA 常量的用途不同)。
// agentrouter 等网关校验 UA 形态,裸 curl 一律 401;客户端没带 UA 时用它兜底
const DEFAULT_UA = 'claude-cli/2.1.219 (external, cli)';
// OpenAI 协议端点的兜底 UA(codex 自己带 codex_exec/… 或 codex_cli_rs/…,这个只兜非 codex 客户端)
const DEFAULT_UA_CODEX = 'codex_cli_rs/0.154.0 (external, cli)';
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const RING_SIZE = 500;
// ---- 运行期日志清理 ----
// responses 归档目录与 launchd.log 超过这么多天就清掉(requests.jsonl 走轮转,不在这里)。
// 启动即清一次(处理停机期间攒下的旧日志),之后每 RETENTION_SWEEP_EVERY_MS 清一次。
const LOG_RETAIN_DAYS = envInt('MIXR_LOG_RETAIN_DAYS', DEFAULT_RETAIN_DAYS, 0, 3650);
const RETENTION_SWEEP_EVERY_MS = Math.max(60 * 1000, envInt('MIXR_LOG_SWEEP_MS', 6 * 3600 * 1000, 0));
// 备份保留上限。**唯一定义在 lib/config-backup.js**,这里只把名字接过来:
// mixctl backups 与 /api/backups 报的 keep 必须与真实备份逻辑同值(见那里的 DEFAULT_KEEP)。
const BACKUP_KEEP = require('./lib/config-backup').DEFAULT_KEEP;
// 路由模式的客户端配置指向(代理不校验 token,仅占位——Codex 的 experimental_bearer_token 不能为空)
const ROUTER_ID = '@router';
const ROUTER_URL = `http://${HOST}:${PROXY_PORT}`;
const ROUTER_TOKEN = 'mixrouter-local';
const ROUTER_SECTION = 'mixr-router';
// ---- v3 会话分发 ----
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
// ---- v3.2 子代理槽位 ----
const SLOTS_FILE = path.join(DATA_DIR, 'slots.json');
// 会话绑定空闲多久后失效(默认 12h);同一对话中途换渠道会打断 prompt 缓存,故给足
const SESSION_TTL_MS = Number(process.env.MIXR_SESSION_TTL_MIN || 720) * 60 * 1000;
const SESSION_MAX = Number(process.env.MIXR_SESSION_MAX || 1000);
// 上游 429/5xx/连不上时把该渠道打入冷却:冷却只是软偏好,全池都在冷却时仍会退回全量候选。
const COOLDOWN_MS = envInt('MIXR_COOLDOWN_SEC', 60, 0, 2147483) * 1000;
// MAX_ATTEMPTS also caps actual network attempts, including conversion retries.
// 候选表按它循环填满(见 lib/proxy/prepare.js):单渠道时同一个渠道也会被重试,不是一次就放弃。
const MAX_ATTEMPTS = envInt('MIXR_MAX_ATTEMPTS', 10, 1, 100);
const CONV_RETRIES = envInt('MIXR_CONV_RETRIES', 3, 0, 100);
// 每次重试前的固定间隔:秒级 ECONNRESET 往往自己就恢复了,立刻重打只会连撞同一个故障窗口。
const RETRY_DELAY_MS = envInt('MIXR_RETRY_DELAY_MS', 1000, 0, 60000);

// Responses 型的 Codex 通道会用 prompt_cache_key 做渠道亲和(TTL 1 小时),坏渠道
// 一旦钉上就整小时失败。key 按会话稳定(拿得到上游 prompt cache),失败时 +1 代。
const convCacheGens = new Map();
const convCacheBase = (sessionKey, providerId) => (`${providerId}-${sessionKey || 'anon'}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'mixrouter');
const convCacheKey = (sessionKey, providerId, gen) => (gen ? `${convCacheBase(sessionKey, providerId)}-g${gen}` : convCacheBase(sessionKey, providerId));
function rotateConvCacheGen(sessionKey, providerId) {
  const k = providerId + '\u0000' + (sessionKey || 'anon');
  if (convCacheGens.size > SESSION_MAX) convCacheGens.clear();
  const gen = ((convCacheGens.get(k) || 0) + 1) % 50;
  convCacheGens.set(k, gen);
  return gen;
}
const convCacheGen = (sessionKey, providerId) => convCacheGens.get(providerId + '\u0000' + (sessionKey || 'anon')) || 0;
// 会话标签开关(MIXR_SESSION_LABEL)与策略白名单都在拆分出去的模块里各留一份常量,
// 这里不再重复定义;需要用到的常量从模块取。
const { SESSION_LABEL } = identity;
// 客户端真实配置(测试时可用环境变量重定向到临时目录)
const CLAUDE_SETTINGS = LIVE_FILES.claudeSettings(process.env, os.homedir());
const compactWindow = createCompactWindow({ globalFile: CLAUDE_SETTINGS });
const CODEX_CONFIG = LIVE_FILES.codexConfig(process.env, os.homedir());

// ---------------------------------------------------------------- 配置存取
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
// saveJson 已迁到 lib/atomic-write.js(见顶部 require 处的说明)。
// 渠道库:按应用分组。兼容 v2.0 的裸数组格式
function loadStore() {
  const raw = loadJson(PROVIDERS_FILE, null);
  if (Array.isArray(raw)) return { claude: raw, codex: [] };
  return { claude: (raw && raw.claude) || [], codex: (raw && raw.codex) || [] };
}
let store = loadStore();
let current = { claude: null, codex: null, zcode: null };
{ const raw = loadJson(PROVIDERS_FILE, null); if (raw && raw.current) current = { ...current, ...raw.current }; }

// 落盘渠道库。**这是全仓唯一会覆盖 providers.json 的地方**,所以备份也收到这里一处,而不是
// 散到四个调用点各写一遍(withStoreRollback、拆分配置、删渠道时的清引用、退出前的收尾落盘)。
//
// 为什么这个文件非备份不可:它是唯一装**全部渠道明文 api_key** 的文件,而它此前是全仓
// 唯一"会被改写、却没有任何备份"的活文件 —— 客户端配置(settings.json / config.toml /
// zcode config)每次改写前都留一份,连 lib/backup/targets.js 都早把 providers.json 列成一个
// 备份池(`[data]`),可那个池子从建成起就恒为 0 份:清点报的是"这里查过、没有",看着像
// "目前还没有备份",实际是**永远不会有**。一次写坏的渠道库 = 全部渠道与 key 一起没了。
//
// 两个附带结果,都是这条路径本来就该有的:
//   1) backupFile 会把保留池收敛到 keep 份。存满了之后每次保存渠道都轮换,所以预警必须能
//      走出去 —— onWarn 收到 console.warn,同时挂到 storeWarnings 上,由这次保存所属的
//      HTTP 路径取走并带进响应体(与 backupWithWatch 同一条通道,见其说明)。
//   2) 落盘前先清掉本目标自己的临时残留(lib/atomic-write 的 purgeTmpSiblings 一并在
//      backup 选项里做)。那些残留的名字会占备份池名额,且内容是上一次没写完的半截 JSON。
const saveStore = () => {
  // 先清空:这是全仓唯一的落盘点,把"清掉上一次的预警"放在这里,就不必指望四个调用点
  // 各自记得在写之前清一次。写失败的那两条路径(withStoreRollback 抛错 → sendErr、
  // 删渠道时 saveStore 抛错 → 把渠道放回去再 sendErr)都是**不 drain 就返回**的 ——
  // 留着的话,上一次那句"顶掉了谁"会漏进下一次成功写入的提示里,而那次操作根本没轮换过。
  // 挂在落盘点上的清空让这种漏法结构性不可能,而不是靠每个调用点自觉。
  storeWarnings = [];
  saveJson(PROVIDERS_FILE, { version: 2, current, claude: store.claude, codex: store.codex }, {
    backup: true,
    onWarn: msg => { console.warn(`[mixrouter] ${msg}`); storeWarnings.push(msg); },
  });
};
// 渠道库备份的轮换预警,暂存在这里等这次保存所属的 HTTP 路径来取。
//
// 为什么不用返回值传:唯一的落盘点 saveStore 被四种形状的调用方围着 —— withStoreRollback
// 的契约是"失败即回滚并抛出"(返回值会被四个接口的 `catch (e)` 吞掉)、configureClaudeSplit
// 有它自己的返回体、退出前的收尾落盘更是连 HTTP 都没有。挂一个模块级的暂存,取走即清,
// 四个调用点各加一行 `drainStoreWarnings()`,不必为此改任何一处的返回契约。
//
// 只挂**最近一次** saveStore 的结果,不累积:预警说的是"这一次写入顶掉了谁",而面板要显示的
// 也正是用户刚点的那一下。攒着会把上一次操作的话带到下一次的提示里,那是编造。
// 于是两个方向各清一次:saveStore 落盘前清(见上,挡住"写失败却没 drain 就返回"的两条路径),
// 取走时清(见下)。两处都必要,少一处就会漏。
let storeWarnings = [];
// 取走并清空。必须在**每次**写渠道库的响应构造前调一次(无论这次有没有轮换),
// 否则上一次的预警会漏到下一次请求上。返回 undefined 表示这次什么也没发生。
function drainStoreWarnings() {
  if (storeWarnings.length === 0) return undefined;
  const out = storeWarnings;
  storeWarnings = [];
  return out;
}
// 落盘失败就把内存回滚到改动之前。以前是"先改内存、再写磁盘":磁盘写不动(只读目录、
// 磁盘满、权限不对)时接口回 500,可渠道**已经**进了 store —— /api/state 看得见它、
// /api/switch 能切到它,唯独 providers.json 里没有。重启后它凭空消失,而中途这一段
// 行为完全不可解释。对比:configureClaudeSplit 一直是失败即回滚的。
// 快照用结构化克隆:store 里全是纯 JSON 值(渠道对象/字符串/数组),没有函数和循环引用。
function withStoreRollback(mutate) {
  const before = structuredClone({ claude: store.claude, codex: store.codex, current });
  try {
    mutate();
    saveStore();
  } catch (e) {
    store.claude = before.claude; store.codex = before.codex; current = { ...current, ...before.current };
    throw e;
  }
}
// 切换客户端配置的**唯一编排**(/api/switch 与 /api/router 两扇门共用)。
// 这两扇门此前都犯了同一个错:先改客户端、后 saveStore —— 而渠道库落盘失败时接口回 500,
// 用户的 ~/.claude/settings.json / ~/.codex/config.toml 已经改完了(`withStoreRollback`
// 回滚的是**内存**里的 current,回不到客户端那一边)。实测:HTTP 500
// `{"error":"写入渠道库失败: simulated"}`,而 settings.json 里 BASE_URL/AUTH_TOKEN
// 与全部混进来的槽位别名都在。
//
// 顺序必须是"渠道库落盘 → 客户端写入":前者失败时什么副作用都还没发生,直接返回即可;
// 后者失败时把渠道库退回去。客户端那一步**失败即原子未生效**(writeFileAtomic 要么整份换新、
// 要么原样不动),所以不需要"写回旧内容"。
//
//   write  —— 真正改客户端配置的那一步,返回 { warnings }(备份池轮换预警)
//   value —— 渠道库 current 要记的值(渠道 id 或 ROUTER_ID)
function applyClientSwitch(app, write, value) {
  const before = { ...current };
  current[app] = value;
  try { saveStore(); }
  catch (e) {
    current = before;
    throw Object.assign(new Error('写入渠道库失败: ' + e.message), { statusCode: 500 });
  }
  // 这一步也会写渠道库,**也会轮换备份池**(池满时最老那份当场被清掉)。预警此前在这两扇门上
  // 整个丢了:响应体里没有 warnings,用户点完"切换"只看到成功。控制台那两扇门本来就在用
  // toastWithBackupWarnings,是服务端没把话说出来。取走即清,与其余出口同一套。
  // (失败那条路上 saveStore 已抛,暂存是空的;回滚那次 saveStore 的预警则留在暂存里,
  //  由下一次落盘的清空兜掉,不会漏进错误响应。)
  const storeWarnings = drainStoreWarnings();
  try {
    const client = write() || {};
    // 两份预警合成一个 warnings 字段:调用方(两扇切换门的 HTTP 出口)本来就在读这个字段,
    // 分成两个字段就要把每个调用点都改一遍,而"哪一份是谁的"对用户没有意义。
    return { ...client, warnings: [...(storeWarnings || []), ...(client.warnings || [])] };
  }
  catch (e) {
    // 客户端没改成就把 current 退回去,免得"控制台说在走路由、客户端却还直连"。
    current = before;
    try { saveStore(); }
    catch (rb) {
      throw Object.assign(new Error(`写入客户端配置失败: ${e.message};回退渠道库也失败: ${rb.message} —— 盘上已不一致,请检查 providers.json`), { statusCode: 500 });
    }
    // **原样透传 4xx**(校验类的拒绝:settings.json 解析不了、ZCode 的 wire_api 不认识……)。
    // 那不是"写客户端配置失败",是"你给的参数不对",回 500 会把用户引到错误的方向;
    // 而且这条路上的 4xx 一定是**在改客户端之前**抛的,所以连"可能已经写了一半"都不成立。
    const code = e.statusCode || 500;
    throw Object.assign(new Error(code < 500 ? e.message : '写入客户端配置失败: ' + e.message), { statusCode: code });
  }
}

// 切换失败时给用户的那句话。zcode 那条是自己的配置格式问题(与渠道库无关),措辞单列。
function clientSwitchMessage(app, e) {
  if (app === 'zcode' && !e.statusCode) return '写入 ZCode 配置失败，请检查配置格式、权限及自有 provider 冲突';
  // 两步各自点名了就不用再套一层;其余仍保持原来的"写入配置失败: <原文>",
  // 免得为这次改动顺手动了一批用户看得见的文案。
  if (/^写入(渠道库|客户端配置)失败/.test(e.message)) return e.message;
  return '写入配置失败: ' + e.message;
}

const storeOf = app => (app === 'codex' ? store.codex : store.claude);
const findProvider = id => store.claude.find(p => p.id === id) || store.codex.find(p => p.id === id) || null;
const providerApp = id => store.claude.some(p => p.id === id) ? 'claude' : (store.codex.some(p => p.id === id) ? 'codex' : null);

// 日志脱敏用的密钥清单:**每次调用现取**,不缓存、不导出。
// 必须是"现取"而不是构造时快照 —— store 里的渠道是运行时可变的:控制台新加的渠道、
// 新加的 key、以及 PUT /api/providers 换上的新 key,都不会进任何启动期快照。
// 而"新填的 key"恰恰是最容易填错、最容易撞上游 401、也最容易被 401 原文回显进 err 的那一把。
// 取 p.api_key 与 p.keys[].key 两处(老式单 key 渠道只有前者,多账号渠道两者都有),
// 顺带把 router token 带上:它同样会被上游当成 Authorization 回显。
function channelSecrets() {
  const out = [];
  for (const list of [store.claude, store.codex]) {
    for (const p of list || []) {
      if (!p) continue;
      if (typeof p.api_key === 'string' && p.api_key) out.push(p.api_key);
      if (Array.isArray(p.keys)) {
        for (const k of p.keys) if (k && typeof k.key === 'string' && k.key) out.push(k.key);
      }
    }
  }
  if (ROUTER_TOKEN) out.push(ROUTER_TOKEN);
  return out;
}

// 规则字段:
//   match    请求模型名子串(逗号分隔多个,大小写不敏感)
//   provider 单一目标渠道;pool 非空时优先用池(会话粘性分发)
//   pool     渠道池,元素为渠道 id 或 {provider, model, weight}
//   strategy round_robin(默认) | weighted | least_used | random
//   priority 数值大者先匹配(默认 0);同值按数组顺序
//   app      适用客户端组 claude | codex;留空 = 两组通用(池成员按组自动取舍)
//   when     附加匹配条件,全部满足才命中:{ session, ua, token } 均为子串
const defaultRoutes = () => ({
  rules: [
    { id: 'r1', match: 'opus, claude-3-opus', provider: '', model: '', pool: [], strategy: 'round_robin', priority: 0, when: {}, enabled: true },
    { id: 'r2', match: 'sonnet',              provider: '', model: '', pool: [], strategy: 'round_robin', priority: 0, when: {}, enabled: true },
    { id: 'r3', match: 'haiku',               provider: '', model: '', pool: [], strategy: 'round_robin', priority: 0, when: {}, enabled: true },
    { id: 'r4', match: 'fable',               provider: '', model: '', pool: [], strategy: 'round_robin', priority: 0, when: {}, enabled: true },
  ],
  default: { provider: '', model: '', pool: [], strategy: 'round_robin' },
});
let routes = loadJson(ROUTES_FILE, null);
if (!routes || !Array.isArray(routes.rules)) routes = defaultRoutes();
else routes = { rules: routes.rules.map(r => rulesLib.normalizeRule(r, { preserveInvalidPin: true })),
  default: rulesLib.normalizeRule(routes.default || {}, { preserveInvalidPin: true }) };
// 可选参数是给 PUT /api/routes 用的:那条路径要**先落盘、成功了再把新值提交到内存**,
// 否则落盘失败时接口回 500、内存里却已经是新规则 —— 而转发读的正是内存。
const saveRoutes = (value = routes) => saveJson(ROUTES_FILE, value);

// 启动时把"规则绑了个不存在的渠道"直接喊出来。这种规则平时安安静静,
// 直到请求打上来才 503,而报错还说"没有匹配的路由,或路由未绑定渠道"——
// 控制台里那条规则明明显示着"已绑定"。用户只能自己一条条翻规则找僵尸引用。
// 删渠道时虽然会顺手解开引用,但 routes.json 可能是手改的、或从旧备份恢复的。
function reportGhostRoutes() {
  const bad = [];
  // 兜底路由经 normalizeRule 也会拿到一个 id,不能靠"有没有 id"区分它和普通规则
  const scan = (r, label) => {
    for (const g of ghostRefs(r)) bad.push(`${label} 的${g.where}指向已不存在的渠道 ${g.id}`);
  };
  for (const r of routes.rules || []) scan(r, `规则 ${r && r.id ? r.id : '?'}(match "${(r && r.match) || '*'}")`);
  scan(routes.default, '兜底路由');
  if (bad.length) {
    console.warn(`[mixrouter] 路由里有 ${bad.length} 处僵尸引用(渠道已删除,规则还指着它)——命中这些规则的请求会直接 503:\n  - ${bad.join('\n  - ')}\n  请在控制台 http://127.0.0.1:${UI_PORT} 的「路由」页重新选择目标渠道。`);
  }
  return bad;
}

// ---------------------------------------------------------------- 子代理槽位(v3.2)
// 槽位 = 一个命名别名绑定「渠道 + 模型」,让客户端的子代理/后台任务各走各的上游:
//   Claude 组固定四个槽(main/opus/sonnet/haiku),别名 mixr-<槽名> 写进客户端 env;
//   Codex 组槽名自拟(如 worker/reviewer),codex exec -m mixr-<槽名> 即可选用。
// 请求模型名精确等于别名时按槽位分发,优先于一切路由规则;槽位目标不受会话粘性影响
// (粘性只在同一条规则的池内生效),渠道停用会给出明确的 provider_disabled_error。
//
// 槽位的**形状逻辑**(常量表、别名、归一化、解析、写入校验、公开视图)整体搬到了
// lib/routing/slots.js;本文件只保留三件事,它们都不是"槽位形状"而是**编排与事务边界**:
//   1) 持有槽位表单例 slotMap(可变的,跨全文件共享)
//   2) 读盘 loadSlots / 落盘 saveSlots —— 模块不碰 I/O
//   3) configureClaudeSplit 的失败即回滚(previous / catch 回滚 / switchClaudeRouter)
// 模块无状态:上面这些调用点把 slotMap 逐个显式传进去,模块既不读它也不改它。
// 常量与别名用解构再导出的写法接过来,调用点与 module.exports 一字不用改。
const {
  CLAUDE_SLOTS, CLAUDE_SLOT_ENV, CLAUDE_SLOT_KEYS, slotAlias, slotAliases, stripContextSuffix,
  normalizeChannelSlots,
} = slotsLib;

function loadSlots() {
  const raw = loadJson(SLOTS_FILE, null);
  // 形状归一化在 lib/routing/slots.js(纯转换,不碰磁盘);这里只管读盘
  return slotsLib.normalizeSlotsFile(raw);
}
let slotMap = loadSlots();
const saveSlots = () => saveJson(SLOTS_FILE, { version: 1, claude: slotMap.claude, codex: slotMap.codex });

const slotTable = slotsLib.createSlotTable({ storeOf, findProvider, providerApp });
const validateSlotPut = body => slotTable.validateSlotPut(body);
const resolveSlot = (app, modelIn) => slotTable.resolveSlot(slotMap, app, modelIn);
const slotsPublic = () => slotTable.slotsPublic(slotMap);
const claudeSplitPatch = body => slotTable.claudeSplitPatch(slotMap, body);

// switchClaudeRouter 的返回值(客户端配置的备份池轮换预警)在 configureClaudeSplit 里的暂存。
// switchClaudeRouter 另有一个调用点直接把它转出去(switchRouter),那条路接得住返回值,
// 不需要这里;只有 configureClaudeSplit 有自己的返回体,才要暂存一下再并进去。
let clientWarnings = null;

function configureClaudeSplit(body) {
  const patch = claudeSplitPatch(body);
  const previous = slotMap;
  slotMap = { ...slotMap, claude: { ...slotMap.claude, ...patch } };
  try { saveSlots(); } catch (e) { slotMap = previous; throw e; }
  // 路由先持久化,再改客户端;启动只读 slots.json,不自动回放客户端备份。
  //
  // ⚠ 这两步的**顺序是这段代码的语义**,不是风格问题 —— 而它此前与这句注释正好相反:
  // 代码是"先改客户端、再 saveStore()"。于是渠道库落盘失败时,接口回 500,而用户的
  // `~/.claude/settings.json` **已经被改成路由模式**(BASE_URL/AUTH_TOKEN 与全部 mixr-*
  // 槽位别名都写进去了),内存里 current 也已经是 @router,只有 providers.json 上什么都没变。
  // 实测(探针,让原子替换抛 EIO):HTTP 500,客户端配置已改写,槽位已落盘,内存 current=@router
  // 而盘上仍是 null。用户看到的是"应用槽位失败",实际他的 Claude Code 已经被指到本机代理上,
  // 而渠道库不知道这件事 —— 下一次重启,current 从盘上读回来是 null,客户端却还指着路由器。
  //
  // 现在按注释的顺序来:先落盘(current + providers.json),成功了才动客户端。
  // 两步都可能失败,所以两步各自带回滚 —— 回滚本身若也失败,如实说出去,不回一句
  // "应用失败"让人以为什么都没变。
  if (body.apply) {
    try {
      // 与另外两扇切换门走**同一条编排**(见 applyClientSwitch):先落盘 current、再改客户端。
      // 客户端配置的备份池轮换预警也由它带出来 —— 这条路径此前把它整个丢了
      // (switchClaudeRouter 返回 { warnings },这里没接)。
      clientWarnings = applyClientSwitch('claude', () => switchClaudeRouter({ slots: true }), ROUTER_ID);
    } catch (e) {
      // 槽位那一步已经落盘了(它排在最前),所以要跟着退回去 ——
      // 否则"应用失败"之后槽位表里已经多了一套指向新渠道的槽,而渠道库那边什么都没变。
      slotMap = previous;
      try { saveSlots(); } catch { /* 尽力而为;内存与盘上至多多了一次等价写入 */ }
      throw e;
    }
  }
  // 这一条不是 HTTP 路径(configureClaudeSplit 被拆分配置与 CLI 两处调用),所以这里把预警
  // 挂在自己的返回体上给调用方 —— 不取就会漏到**下一次**写渠道库的那个请求的提示里,
  // 而那次操作根本没动过渠道库。见 drainStoreWarnings。
  //
  // 本函数**不自己 drain**:这条路径上唯一写渠道库的地方是 applyClientSwitch,它已经取走了
  // 那一份并并进自己返回的 warnings(客户端配置那份也在里面)。这里原来还留着一句
  // `...(drainStoreWarnings() || [])`,注入实测证明它是死代码(删掉全绿)—— 因为本函数里
  // 那次 saveSlots 走的是不带 backup 的 saveJson,根本不产生预警。
  const warnings = [...((clientWarnings && clientWarnings.warnings) || [])];
  clientWarnings = null;
  return { ok: true, applied: !!body.apply, slots: slotsPublic().claude, warnings: warnings.length ? warnings : undefined };
}

// 从控制台存进来的规则一律过一遍 rulesLib.normalizeRule(见 lib/routing/rules.js):
// 字段类型收敛,免得坏数据埋到转发时才炸。
// 用函数声明而不是 const 别名:routes 初始化在上面就要用到它,const 会踩 TDZ。
function normalizeRule(r) { return rulesLib.normalizeRule(r); }

// ---------------------------------------------------------------- 会话身份
// 身份提取(parseSessionId / bodySystemText / firstUserText / codex* / sessionIdentity /
// sessionLabel / applyLabel / bodyRouteText)整体搬到 lib/session/identity.js,这里只做再导出。
const {
  parseSessionId, bodySystemText, firstUserText,
  codexHeaderSessionId, codexBodySessionId, codexSystemText, codexUserTexts, codexFirstUserText,
  sessionIdentity, sessionLabel, applyLabel, sessionKeyOf, bodyRouteText, compactTexts,
} = identity;

// ---------------------------------------------------------------- 会话绑定与渠道池
// 绑定表、冷却表、轮转游标与"挑哪个渠道"的决定都在 lib/routing/sessions.js 的实例里
// (见该模块头部注释)。这里只把本进程的数据文件、TTL、上限与渠道可用性判断接进去。
const sess = createSessionStore({
  sessionsFile: SESSIONS_FILE, ttlMs: SESSION_TTL_MS, max: SESSION_MAX,
  cooldownMs: COOLDOWN_MS, loadJson, saveJson,
  storeOf: app => storeOf(app), providerEligible: id => providerEligible(id),
  // 去抖落盘失败时的出口。库不自己写日志(它不该决定日志长什么样),这里接上本进程的格式,
  // 并且**接住**它 —— 不接就是一个 uncaughtException(实测过,见 mutateSessions 的注释)。
  // 这条日志本身也是必要的:本次改动没落盘,而它要等到下一次落盘才有机会补上。
  onSaveError: e => console.error(`[sessions] 会话绑定落盘失败(本次改动会在下次落盘时重试): ${(e && e.message) || e}`),
});

// 渠道可用性只看冷却表(由 lib/routing/sessions.js 持有):它不拒绝请求,只在挑首选时降权。
const inCooldown = id => sess.inCooldown(id);
const providerEligible = id => !inCooldown(id);
const markCooldown = (providerId, status) => sess.markCooldown(providerId);
const pruneSessions = () => sess.prune();

// 立即落盘(退出路径)
function flushSessions() { sess.flush(); }
// 控制台的会话三扇门专用:确知内存刚被改过,绕过去抖标记强制写一次(见 sessions.js 的 flush)
function flushSessionsNow() { sess.flush(true); }
function saveSessionsSoon() { sess.saveSoon(); }
function loadSessions() { sess.load(); }

// 会话绑定改动的**立即落盘 + 失败即回滚**。清空/钉定/解绑这三扇门都要走它。
//
// 为什么不能像以前那样只调 saveSoon():它是 1s 去抖 + 后台定时器,接口当场回 200
// "已清空",盘上却要等一秒;而那一秒里的落盘失败**没有人接得住**(库那边是裸 timer 抛错,
// 实测就是一个 uncaughtException)。于是内存里会话没了、盘上还在,重启全部复活。
// 实测(探针让 sessions.json 的原子替换抛 EACCES):`DELETE /api/sessions` → 200
// `{"ok":true,"cleared":true}`,内存 2→0 条,盘上仍是 2 条。
//
// mutate 里改的是内存(先取 snapshot 供回滚),返回后立刻同步落盘:
//   · 成功 —— 顺带 downgrade 掉那个可能还挂着的去抖定时器(flush 自己会清)
//   · 失败 —— 把内存**整份**退回改动前的绑定表,再如实抛 5xx
// 绑定表在内存里就是个 Map,整份快照的代价可以忽略;这样回滚是精确的,不需要逐项逆操作。
function mutateSessions(mutate) {
  const before = new Map(sess.sessions);
  mutate();
  try { flushSessionsNow(); }
  catch (e) {
    sess.sessions.clear();
    for (const [k, v] of before) sess.sessions.set(k, v);
    throw Object.assign(new Error('写入会话绑定失败: ' + ((e && e.message) || e)), { statusCode: 500 });
  }
}

// 渠道级、与本次载荷无关的失败:换一条候选渠道重打可能就好了。
// 429 限流、5xx 上游故障是老面孔;402 是「这家池子的额度跑干了」
// (AgentRouter 等聚合站的 Budget pool 按放量窗口计费,窗口外恒 402),
// 语义上与 429 同类——错峰的另一家渠道此刻可能正好有量,不换就是白等。
const retryableStatus = status => status === 429 || status === 402 || status >= 500;
function errorClass(status, code = '') {
  if (code) return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(code) ? code.toLowerCase() : 'network_error';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'budget_exhausted';
  if (status >= 500) return 'upstream_server';
  return status >= 400 ? 'upstream_request' : '';
}
function healthStatus() {
  return { settings: { total_deadline_ms: TOTAL_DEADLINE_MS, first_header_timeout_ms: FIRST_HEADER_TIMEOUT_MS,
    stream_first_header_timeout_ms: STREAM_FIRST_HEADER_TIMEOUT_MS,
    stream_idle_timeout_ms: STREAM_IDLE_TIMEOUT_MS, sse_keepalive_ms: SSE_KEEPALIVE_MS,
    nonstream_total_timeout_ms: NONSTREAM_TOTAL_TIMEOUT_MS, max_attempts: MAX_ATTEMPTS, conversion_retries: CONV_RETRIES,
    // 一次请求真正允许的上游调用总数:候选渠道数 + 换 key 重试数。
    // 上界由实测得出(见 lib/proxy/context.js 的 maxUpstreamCalls),不是两个旋钮相乘
    max_upstream_calls: Math.max(1, MAX_ATTEMPTS) + Math.max(0, CONV_RETRIES),
    cooldown_ms: COOLDOWN_MS, retry_delay_ms: RETRY_DELAY_MS },
  providers: ['claude', 'codex'].flatMap(app => storeOf(app).map(p => ({ provider: p.id, app,
    enabled: p.enabled !== false, cooldown_until: inCooldown(p.id) ? sess.cooldowns[p.id] : 0,
    eligible: p.enabled !== false && providerEligible(p.id) }))) };
}

// 池成员归一化 / 僵尸引用 / 归属判断 / 策略挑选都在 lib/routing/ 下;
// 这里保持同名同签名的薄包装,调用点与 module.exports 一字不用改。
// pickMember 是例外:它去掉了从来没人读过的第三个按位形参,调用点同步改过。
const poolMembers = (rule, app = 'claude') => poolLib.poolMembers(storeOf(app), rule, app);
const ghostRefs = rule => poolLib.ghostRefs(findProvider, rule);
const ruleBelongsToApp = (rule, app) => rulesLib.ruleBelongsToApp(rule, app, providerApp);
const strategyOf = strategyLib.strategyOf;
const pickWeighted = strategyLib.pickWeighted;
// 第三个按位形参 key 是既存死参数:lib/routing/strategy.js 的 pickMember 从头到尾没读过
// 它(拆分前的单体同签名、同样不读,所以不是拆分带进来的)。留着它,读代码的人会以为
// 挑选是按会话分桶的,而游标实际只按 rule.id 存;签名一改,多出来的实参还会落进 opts 槽,
// 把 TypeError 埋在离真因很远的地方。删掉它,opts 直接落第三位。
const pickMember = (rule, members) => strategyLib.pickMember(rule, members,
  { eligible: providerEligible, activeCount: id => sess.activeCount(id), pools: sess.pools });

// 拿到本会话该走的渠道(粘性/钉定/重绑的语义见 lib/routing/sessions.js)
const resolveSessionTarget = (rule, members, key, label, kind, app = 'claude', fallbackStrategy) =>
  sess.resolveTarget(rule, members, key, label, kind, app, fallbackStrategy);

const sessionEntry = (key, kind, members, label, app = 'claude') => sess.entry(key, kind, label, app);

loadSessions();

// 控制台用:当前活跃会话一览(不含任何密钥;key 只给短 id 便于对照日志)
const sessionList = () => sess.list({ findProvider, short: sessionKeyOf });
const sessionRecord = key => sess.sessions.get(key);

// ---------------------------------------------------------------- 请求日志
// 环形缓冲 + 落盘 + 白名单 + 脱敏 + 累计器都在 lib/observability/request-log.js 里;
// 这里只建**一个实例**(不是模块级单例:实例持有 file/capacity/时钟/secrets 取值函数,
// 测试与将来的多实例都要能各建各的)并把上面那几个真值传进去。
// secrets 必须传**函数**:见 channelSecrets 的注释(启动期快照漏新渠道)。
const requestLog = createRequestLog({
  file: LOG_FILE, capacity: RING_SIZE, maxBytes: LOG_ROTATE_BYTES, secrets: channelSecrets,
  retentionDays: envInt('MIXR_LOG_RETENTION_DAYS', 30, 0, 36500),
  compress: process.env.MIXR_LOG_COMPRESS === 'on',
  onError: (error, ctx) => console.error(`[log] ${ctx.op} 落盘失败(${ctx.file}): ${error.message}`),
});

// ---- 用量统计 ------------------------------------------------------------------
const usageSummary = createUsageSummary({
  file: LOG_FILE,                             // 磁盘:requests.jsonl 及其轮转归档
  memoryEntries: () => requestLog.list({ limit: Number.MAX_SAFE_INTEGER }).logs,
});

// 运行期日志清理:启动即清一次(处理停机期间攒下的旧日志),之后周期性再清。
// 清理逻辑全在 lib/log-retention.js(带锁,可与 `mixctl gc` 并发而不互撞);这里只负责调度。
// 失败一律吞掉并告警一次:清理是后台维护,不该让一条清不掉的旧日志影响转发。
function sweepLogsNow(trigger) {
  if (LOG_RETAIN_DAYS <= 0) return null;
  const r = sweepLogs({ directory: path.dirname(LOG_FILE), retainDays: LOG_RETAIN_DAYS });
  if (r.errors && r.errors.length) console.error(`[retention] 日志清理有失败项(${trigger}): ${r.errors.join(', ')}`);
  else if (r.responses && (r.responses.removed || r.responses.truncated)) console.log(`[retention] ${trigger}:清理 responses 归档 ${r.responses.removed} 个(约 ${Math.round((r.responses.bytes || 0) / 1048576)}MB,保留 ${LOG_RETAIN_DAYS} 天)${r.responses.truncated ? ',单轮限额已满,稍后继续' : ''}`);
  return r;
}
let retentionTimer = null;
// 命中单轮限额(启动时撞上几万目录的积压)时用短周期追赶,把积压尽快清完;
// 追平后回到常规的长周期,不空转。
const RETENTION_CATCHUP_MS = Math.min(RETENTION_SWEEP_EVERY_MS, 30 * 1000);
function retentionTick() {
  const r = sweepLogsNow('周期');
  if (r && r.responses && r.responses.truncated) { scheduleRetention(RETENTION_CATCHUP_MS); return; }
  scheduleRetention(RETENTION_SWEEP_EVERY_MS);
}
function scheduleRetention(ms) {
  if (retentionTimer) clearTimeout(retentionTimer);
  retentionTimer = setTimeout(retentionTick, ms);
  if (retentionTimer.unref) retentionTimer.unref();   // 别用清理定时器钉住进程退出
}
function startLogRetention() {
  if (LOG_RETAIN_DAYS <= 0 || retentionTimer) return;
  const first = sweepLogsNow('启动');
  // 积压未清完:短周期接着清;清完则按常规长周期走
  scheduleRetention(first && first.responses && first.responses.truncated ? RETENTION_CATCHUP_MS : RETENTION_SWEEP_EVERY_MS);
}

// 内容分流(when.body)的匹配文本由 lib/session/identity.js 的 bodyRouteText 提供
// (只看 system/instructions + 最后一条消息,历史不进匹配文本)
// ---------------------------------------------------------------- 路由解析
// match 为请求模型名的子串,逗号分隔多个,大小写不敏感
// 先按 priority 降序(同值保持数组顺序),命中首个启用且满足 when 的规则
// 路由目标来自哪一组由端点决定:Anthropic 端点取 Claude 组,OpenAI 端点取 Codex 组
// 具体匹配顺序与返回形状见 lib/routing/resolve.js
const matchWhen = rulesLib.matchWhen;
const resolveRoute = createResolver({
  getRoutes: () => routes, storeOf: app => storeOf(app),
  resolveSlot: (app, modelIn) => resolveSlot(app, modelIn),
  findProvider, providerApp,
});
// 诊断只读装配:不经 /api/state、sessionList 或任何会剪枝/落盘的会话入口。
const explainRoute = createExplainer({
  getRoutes: () => routes, storeOf: app => storeOf(app),
  resolveSlot: (app, modelIn) => resolveSlot(app, modelIn), findProvider, providerApp,
  slotExists: (app, modelIn) => {
    const raw = stripContextSuffix(modelIn);
    // 精确比较每个槽名的**全部**别名(Claude 组含 claude-mixr-* 兼容别名),
    // 不做前缀猜测 —— "槽存在但没绑渠道"的预览提示据此区分。
    return Object.keys(slotMap[app] || {})
      .some(name => slotAliases(app, name).includes(raw));
  },
  listPools: () => sess.pools, inCooldown, healthEligible: () => true,
  sessionSnapshot: () => ({ bindings: sess.sessions, now: Date.now(), ttlMs: SESSION_TTL_MS, max: SESSION_MAX }),
  uiPort: UI_PORT,
});

// 目标模型带 [1M] 后缀 → 去掉后缀并追加 1M beta 头。
// 实现与它踩过的两个坑(headers 必须真传进来、beta 头是清单不是开关)都在 lib/model-suffix.js。
// BETA_1M 同处导出,这里不再另留一份常量。

// 错误体的两个形状(Anthropic / OpenAI 由端点决定)在 lib/http/proto-error.js。
// 这两个函数被测试按形状逐字对照(test/routing-preview-q3.test.js),所以运行时取的是模块里
// 那一份,本文件不留第二份实现——两份一旦分叉,预览的 error.code 就会与实跑对不上。
const { anthropicError, openaiError, protoError } = protoErrorLib;

// HTTP 头值消洗与 base_url 校验见 lib/routing/headers.js(与上游转发共用的纯函数)
const safeHeader = headersLib.safeHeader;
const authHeaderValue = headersLib.authHeaderValue;
const hasCtlChar = headersLib.hasCtlChar;
const validBaseUrl = headersLib.validBaseUrl;

// 从 SSE/JSON 响应文本里尽力抠 usage(输入来自 message_start,输出来自 message_delta)
function extractUsage(text) {
  // 三个字段一律取最后一次出现:Anthropic 系网关的 message_start 常给 usage:0,真值在流末尾的
  // message_delta——首匹配抠到 0,glm-5.3 直通 677/692 条 in/out 全 0 就是这么丢的
  return {
    in: lastNum(text, /"input_tokens"\s*:\s*(\d+)/),
    out: lastNum(text, /"output_tokens"\s*:\s*(\d+)/),
    cache_read: lastNum(text, /"cache_read_input_tokens"\s*:\s*(\d+)/),
  };
}

// OpenAI 双协议转换层(Responses ⇄ Chat)。require 不读配置、不起监听。
const { responsesToChat, chatJsonToResponses, streamChatAsResponses, emitResponsesSse,
        chatToolChoice, extractUsageOpenAI, lastNum } = wireOpenai;

const extractUsageFor = (wire, text) => wire === 'anthropic' ? extractUsage(text) : extractUsageOpenAI(wire, text);

// 同协议直通只认 SSE data 帧里的协议字段,不把正文中引用的终态名当成成功。
function sseResult(wire, text) {
  let terminal = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (wire === 'chat' && data === '[DONE]') { terminal = true; continue; }
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    if (event.error || event.type === 'error' || event.type === 'response.failed')
      return { ok: false, error: upstreamErrorText(JSON.stringify(event)) || '上游返回流式错误' };
    if (wire === 'anthropic' && event.type === 'message_stop') terminal = true;
    if (wire === 'responses' && ['response.completed', 'response.incomplete'].includes(event.type)) terminal = true;
    if (wire === 'chat' && event.choices?.some(choice => choice.finish_reason)) terminal = true;
  }
  return { ok: terminal, error: terminal ? '' : '上游流没有给出合法终态就结束了' };
}

// ---------------------------------------------------------------- 代理服务
// 端点 → 客户端组与协议:Claude 组说 Anthropic,Codex 组说 OpenAI
// 端点识别与协议→上游路径换算见 lib/routing/endpoints.js
const ENDPOINTS = endpoints.ENDPOINTS;
const classifyProxyRequest = endpoints.classifyProxyRequest;
const wireOf = endpoints.wireOf;
const upstreamPathOf = endpoints.upstreamPathOf;
const joinUpstreamPath = endpoints.joinUpstreamPath;

// GET /v1/models:只读清单(Codex 组渠道的模型 + 路由目标模型 + Codex 槽位别名),给会探模型的客户端用
function modelList() {
  const seen = new Set(), data = [];
  const add = (id, owner) => {
    const k = id + '\u0000' + owner;
    if (!id || seen.has(k)) return;
    seen.add(k);
    data.push({ id, object: 'model', owned_by: owner });
  };
  for (const p of store.codex) if (p.enabled !== false && p.model) add(p.model, p.name);
  for (const [name, s] of Object.entries(slotMap.codex || {})) {
    if (s && s.provider) add(slotAlias('codex', name), 'slot:' + name);
  }
  for (const r of [...(routes.rules || []), routes.default || {}]) {
    if (!r) continue;
    if (r.model) add(r.model, 'route');
    for (const m of r.pool || []) if (typeof m === 'object' && m && m.model) add(m.model, 'route');
  }
  return { object: 'list', data };
}

// ---------------------------------------------------------------- 代理编排装配
// proxyHandler 原来是一段约 780 行的单函数(HTTP 入口 + 身份/覆盖/内容规则/槽位/候选/Key
// 约束 + 预算与重试 + 单次尝试 + 协议分发 + 终态),四件事互相递归,改一种路由行为要同时
// 掌握整段闭包。按规划 2.2 的边界表拆成:
//
//   lib/http/proxy.js    HTTP 入口编排(端点识别、读体、入口错误、建上下文、启动 attempts)
//   lib/proxy/prepare.js 身份/覆盖/内容规则/槽位/候选/Key 约束 → RequestPlan
//   lib/proxy/context.js 请求级时间戳与预算、真实调用计数、取消器、唯一终态
//   lib/proxy/attempts.js 请求级预算与重试决策(下一次尝试只在这里决定)
//   lib/proxy/attempt.js 单次尝试(Key 重查、出站构造、HTTP 调用)
//   lib/proxy/response.js 响应分派(选已有转换器、usage/完整性/错误/是否已提交)
//
// 依赖方向:入口 → 编排 → routing/session/upstream/wire/observability → 纯工具。
// **下层不 require 主入口**:活配置(store / routes / slotMap)一律以 getter
// 或函数注入,不在这里快照 —— 控制台刚保存的渠道、槽位、Key 必须对在途重试立刻生效。
const proxyHttp = require('./lib/http/proxy');
const { createPreparer } = require('./lib/proxy/prepare');
const { createRequestContext } = require('./lib/proxy/context');
const { createAttemptRunner } = require('./lib/proxy/attempts');
const { createAttempt } = require('./lib/proxy/attempt');
const { createResponder } = require('./lib/proxy/response');

// ---- 出站构造(纯函数:渠道 + 客户端请求头 → 上游请求头)----
// 转发到上游时的请求头:渠道自定义 UA 优先,其次客户端 UA,最后兜底 claude-cli UA
function buildUpstreamHeaders(provider, req) {
  const key = authHeaderValue(provider.api_key);
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'Authorization': 'Bearer ' + key,
    'User-Agent': safeHeader(provider.ua) || safeHeader(req.headers['user-agent']) || DEFAULT_UA,
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
  };
  if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
  return headers;
}

// 转发到 OpenAI 协议上游时的请求头:只带最小集合(不撒 Anthropic 的 x-api-key / anthropic-* 头)
function buildOpenAiHeaders(provider, req, stream) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': stream ? 'text/event-stream' : 'application/json',
    'Authorization': 'Bearer ' + authHeaderValue(provider.api_key),
    'User-Agent': safeHeader(provider.ua) || safeHeader(req.headers['user-agent']) || DEFAULT_UA_CODEX,
  };
  if (req.headers.originator) headers['originator'] = safeHeader(req.headers.originator);
  // 会话 id 透传:个别网关按它做上游侧缓存粘性;带的是客户端自己的 id,不含本机信息
  const sid = codexHeaderSessionId(req);
  if (sid) headers['session-id'] = safeHeader(sid);
  return headers;
}

const { dispatchResponse } = createResponder({
  collect, createAnthropicTranslator, extractUsageFor, extractUsageOpenAI, sseResult,
  upstreamErrorText, errBodyText, errLine, errLineOrPlaceholder, clip,
  wireChat, wireResponses, wireOpenai,
});

const { runAttempt } = createAttempt({
  http, https,
  storeOf, slotMapOf: () => slotMap, sessionConfig, compactLib,
  wireOf, upstreamPathOf, joinUpstreamPath,
  buildUpstreamHeaders, buildOpenAiHeaders, applyModel, toolFilter,
  safeHeader, hasCtlChar, transportAgent, createResponseArchive, channelSecrets, clientToken,
  errorClass, retryableStatus, markCooldown,
  settleRequest: (flight, patch) => sess.settleRequest(flight, patch),
  sha256: text => crypto.createHash('sha256').update(text).digest('hex'),
  wireResponses, wireChat, wireOpenai,
  convCacheKey, convCacheGen, rotateConvCacheGen,
  firstHeaderTimeoutFor, streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  nonstreamTotalTimeoutMs: NONSTREAM_TOTAL_TIMEOUT_MS,
  responseArchiveOn: RESPONSE_ARCHIVE_ON, responseArchiveDir: RESPONSE_ARCHIVE_DIR,
  uiPort: UI_PORT, DEFAULT_UA_CODEX, dispatchResponse,
});

const { runAttempts } = createAttemptRunner({ runAttempt, convRetries: CONV_RETRIES, retryDelayMs: RETRY_DELAY_MS });

const prepareRequest = createPreparer({
  UI_PORT, MAX_ATTEMPTS,
  storeOf, sessionRecord, sessionConfig, sessionKeyOf, sessionIdentity, sessionLabel,
  bodyRouteText, compactTexts, resolveRoute, compactLib, wireOf,
  resolveSessionTarget, sessionEntry, clientToken,
  captureRequest: key => sess.captureRequest(key),
}).prepareRequest;

const proxyHandler = proxyHttp.createProxyHandler({
  VERSION, BODY_LIMIT, BODY_DRAIN_EXTRA, BODY_DRAIN_MS,
  TOTAL_DEADLINE_MS, MAX_ATTEMPTS, CONV_RETRIES, SSE_KEEPALIVE_MS,
  RESPONSE_ARCHIVE_ON,
  onBodyDrainAbort: () => { bodyDrainAborts++; },
  onBodyDrainTimeout: () => { bodyDrainTimeouts++; },
  randomUUID: () => crypto.randomUUID(),
  httpBody, protoError, classifyProxyRequest, ENDPOINTS, modelList, sessionKeyOf,
  prepareRequest, createRequestContext, runAttempts,
  // 终态的两个副作用仍然留在主入口:会话计数/用量累加(会话语义不在这里)与请求日志落盘。
  // 会话这一半走**在途 guard**:令牌是入口捕获的那个(flight),由 settleRequest 按记录世代
  // 判定该不该落账 —— 响应回来时这条会话可能已被手动重绑/解绑/清空/重存覆盖。
  // "不复活被删除的会话"与"不覆盖用户刚做的绑定"都由它判定,这里不再自己读一遍记录。
  settleSession: (flight, finished) => {
    const r = sess.settleRequest(flight, { usage: { in: finished.in || 0, out: finished.out || 0 } });
    // 落盘只在这条结算真的改动了记录时才排一次(以前是"记录还在就排",被删的会话也白排一次)。
    if (r.ok && r.applied.usage) saveSessionsSoon();
  },
  // append 是同步的:先于客户端看到终态 —— 现有的 /api/logs 即时可见性靠这一点
  appendLog: finished => requestLog.append(finished),
});

// 客户端带来的凭据(可当路由维度用:不同对话配不同 token 即可分流)
function clientToken(req) {
  const a = String(req.headers['authorization'] || '');
  if (a) return a.replace(/^Bearer\s+/i, '').trim();
  return String(req.headers['x-api-key'] || '').trim();
}

// ---------------------------------------------------------------- 客户端配置切换(cc-switch 式)
// 读客户端配置文件(settings.json 这类)。**读不出来不等于文件是空的**——这一条踩过:
// 原来这里统一是 `try { cfg = JSON.parse(readFileSync(...)) } catch {}`,解析一失败就退回 {}:
//   · 文件带 UTF-8 BOM(Windows 记事本、某些编辑器另存就会加)、带 // 注释、带尾逗号
//     → JSON.parse 抛 → cfg={} → 写回时整个文件只剩我们塞的那几个 env 键。
//     permissions、hooks、statusLine、用户自己的 env 变量全部静默消失,而接口回的是 200,
//     控制台还显示"配置正常"。备份文件是唯一能捡回来的东西。
//   · BOM 本身顺手剥掉:JSON.parse 不认它,但文件内容其实是合法 JSON。
// 现在:能解析就解析;解析不了就**拒绝写入**,把决定权交回用户(调用方负责这一句)。
function readClientConfig(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { missing: true, cfg: {} }; }        // 文件不存在:从零建,正常
  const stripped = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  if (!stripped.trim()) return { cfg: {} };               // 空文件/纯空白:同上
  try { return { cfg: JSON.parse(stripped) }; }
  catch (e) {
    throw Object.assign(new Error(
      `${file} 解析失败(${e.message}),为避免把它整个覆盖掉,本次写入已中止。` +
      `请先修好该文件的 JSON(BOM、// 注释、尾逗号都会导致解析失败),或先备份再删掉它`),
      { statusCode: 400 });
  }
}

// backupFile 已迁到 lib/config-backup.js(名字模板与保留池规则是三处共读的契约,注释随它搬走)

// 备份前的保留池预警(见 lib/backup/pool-watch.js)。三个调用点都走它,免得各写一遍措辞。
// 只在真要删东西时才出声:池没满时是静默的,否则每切一次渠道就喊一句,真出事那次会被淹掉。
//
// 两个出口都要给:
//   · console.warn —— 服务端日志,事后排查用。
//   · **返回值** —— 调用它的那条 HTTP 写路径要把 warnings 一路带进响应体;不给返回值,
//     预警就只有服务端看得见,而"池满了、你那份最老的被清了"这件事,该看见的人正坐在
//     控制台前点按钮。备份池默认只留 5 份,轮换是常态而不是异常。
function backupWithWatch(file) {
  const warnings = [];
  const bak = backupFile(file, {
    onWarn: msg => { console.warn(`[mixrouter] ${msg}`); warnings.push(msg); },
  });
  return { bak, warnings };
}

function switchClaude(p) {
  // 标了 wire_api:'responses'/'chat' 的渠道只挂 Codex/OpenAI 型通道,上游根本没有 /v1/messages:
  // 直连写进去等于把客户端写坏(而且界面上还显示切换成功)。拒绝,让它走路由模式。
  if (wireOf(p, 'claude') !== 'anthropic')
    throw Object.assign(new Error(`该渠道标了 wire_api: ${wireOf(p, 'claude')}(模型只挂在 Codex/OpenAI 型通道上),直连后 Claude Code 的 /v1/messages 必然失败;请改用控制台的「路由模式」经本机代理转发`), { statusCode: 400 });
  let cfg = readClientConfig(CLAUDE_SETTINGS).cfg;
  const { warnings } = backupWithWatch(CLAUDE_SETTINGS);
  cfg.env = cfg.env || {};
  cfg.env.ANTHROPIC_BASE_URL = p.base_url;
  cfg.env.ANTHROPIC_AUTH_TOKEN = p.api_key;
  // 槽位模型:渠道里填了才写;没填的槽位若当前是控制台托管的 mixr- 别名,必须清掉——
  // 否则直连时客户端会把 mixr-haiku 当模型名发给真实上游(与路由模式的清理逻辑一致)
  for (const [name, envKey] of Object.entries(CLAUDE_SLOT_ENV)) {
    const v = name === 'main' ? ((p.models && p.models[0]) || '') : ((p.slots && p.slots[name]) || '');
    if (v) cfg.env[envKey] = v;
    else if (String(cfg.env[envKey] || '').startsWith('mixr-')) delete cfg.env[envKey];
  }
  writeFileAtomic(CLAUDE_SETTINGS, JSON.stringify(cfg, null, 2) + '\n');
  return { warnings };
}

// TOML 基本字符串与顶层键读取,由 lib/codex-config.js 提供(quote/topLevel);
// lib/toml.js 与 lib/codex-toml.js 已退化为它的薄适配,**全树只有一套认法** ——
// 读与写若各认各的,同一份 TOML 的解析就会漂移(本轮踩过一次:缩进顶层键一边认一边不认)。
// codexTopLevel 保留这个壳,是因为导出面(test/codex.test.js 与 module.exports)按这个名字取。
const tomlStr = codexConfig.quote;
const codexTopLevel = codexConfig.topLevel;

// Codex 配置写入的事务收尾:能力目录(prepared.file / prepared.sourceFile)与配置正文
// 三份文件各自"内容变了才备份 + 原子落盘",任何一份都没变就不碰它 —— 不产生空备份。
function commitCodexConfig(before, text, prepared) {
  fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true });
  if (prepared) {
    let previous = '';
    try { previous = fs.readFileSync(prepared.file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous !== prepared.content) { backupWithWatch(prepared.file); writeFileAtomic(prepared.file, prepared.content); }
    const source = JSON.stringify({ source: prepared.source }, null, 2) + '\n';
    let oldSource = '';
    try { oldSource = fs.readFileSync(prepared.sourceFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (oldSource !== source) { backupWithWatch(prepared.sourceFile); writeFileAtomic(prepared.sourceFile, source); }
  }
  if (text !== before.text) { backupWithWatch(CODEX_CONFIG); writeFileAtomic(CODEX_CONFIG, text); }
}

// 控制台「Codex」页的两个动作:同步能力目录 / 设置推理档位。都要求 revision 对得上 ——
// 面板是只读渲染的,用户点了保存说明他看到的版本就是落盘依据;对不上就必须让他刷新,
// 否则会把外部(或另一个面板)刚改的内容按旧快照覆盖掉。
function updateCodexConfig(options) {
  const before = codexConfig.read(CODEX_CONFIG);
  if (typeof options.revision !== 'string' || options.revision !== before.revision)
    throw Object.assign(new Error('Codex 配置已变化或缺少版本号，请刷新后重试'), { statusCode: 409 });
  if (before.document.get('profile')) throw codexConfig.invalid('当前使用 Codex profile，未改写全局配置');
  let prepared = null;
  const top = {};
  if (options.action === 'sync_catalog') {
    prepared = codexConfig.prepareCatalog(CODEX_CONFIG, before.document, slotsPublic().codex);
    if (!prepared) throw codexConfig.invalid('没有配置本地模型目录；不会凭空生成模型能力');
    top.model_catalog_json = path.basename(prepared.file);
  } else if (options.action === 'reasoning') {
    const effort = options.model_reasoning_effort;
    const levels = liveState().codex.main?.reasoning_levels || [];
    if (effort !== null && (typeof effort !== 'string' || !levels.includes(effort)))
      throw codexConfig.invalid('推理档位必须来自当前模型的本地能力目录，或设为自动');
    top.model_reasoning_effort = effort;
  } else throw codexConfig.invalid('未知 Codex 配置操作');
  commitCodexConfig(before, codexConfig.patch(before.text, { top }), prepared);
  return { ok: true, codex: liveState().codex, unknown_aliases: prepared?.unknown || [] };
}

// 往 ~/.codex/config.toml 写一个渠道 section(外科手术):
//   1) 先整体删掉以前写入的 mixr-* section(用户自己的 section 一律不碰;
//      被 profile 引用的 mixr-* 保留 —— 删掉会让那份 profile 直接失效)
//   2) 顶层 model / model_provider / review_model 原位替换;没有就插到文件最前
//   3) 追加/更新 model_providers.<section>(沿用本机已验证的 bearer-token 模式,不依赖 auth.json)
// 解析不了的 TOML 一律拒绝写(codexConfig.read 抛),不以空配置覆盖原文件。
function writeCodexConfig({ section, name, base_url, api_key, wire_api, model, keepModel, reviewModel, syncCatalog = false, expectedRevision }) {
  const before = codexConfig.read(CODEX_CONFIG);
  if (expectedRevision && expectedRevision !== before.revision)
    throw Object.assign(new Error('Codex 配置已被外部修改，请刷新后重试'), { statusCode: 409 });
  if (before.document.get('profile')) throw codexConfig.invalid('当前选择了 Codex profile，请先确认 profile 配置；未改写全局配置');
  const prepared = syncCatalog ? codexConfig.prepareCatalog(CODEX_CONFIG, before.document, slotsPublic().codex) : null;
  const text = codexConfig.patch(before.text, {
    top: { model: keepModel && before.document.get('model') ? before.document.get('model') : model,
      model_provider: section, review_model: reviewModel,
      ...(prepared ? { model_catalog_json: path.basename(prepared.file) } : {}) },
    section, provider: { name, base_url, wire_api: wire_api || 'responses', requires_openai_auth: false, experimental_bearer_token: api_key },
  });
  commitCodexConfig(before, text, prepared);
}

function switchCodex(p) {
  if (p.wire_api === 'chat') throw codexConfig.invalid('Codex 只使用 Responses；Chat 渠道请绑定槽位并使用路由模式，不能直接写入客户端');
  const before = codexConfig.read(CODEX_CONFIG);
  const model = p.model || (p.models && p.models[0]) || '';
  // 旧配置里的 review_model 若还是本产品写的 mixr- 别名,直连时必须一起改掉:
  // 留着别名而 model_provider 已经换成真实渠道,审查模型会指向一个不存在的 provider。
  const review = before.document.get('review_model');
  writeCodexConfig({ section: 'mixr-' + p.id, name: p.name, base_url: codexConfig.baseURL(p.base_url),
    api_key: p.api_key, wire_api: p.wire_api || 'responses',
    model, ...(typeof review === 'string' && review.startsWith('mixr-') ? { reviewModel: model } : {}) });
}

// 路由模式:把客户端指向本机代理,流量开始按路由规则分发
//   Claude Code → settings.json 的 env(模型名/槽位保持不动,路由就靠它匹配)
//   Codex      → config.toml 顶层 model_provider 换成 mixr-router,顶层 model 保持不动
// options.slots = true 时按当前槽位表同步 Claude 的槽位 env:
//   已配置的槽写别名(mixr-…),没配置的槽只清理以前写入过的别名残留,用户手设的真实模型名不动
function switchClaudeRouter(options = {}) {
  let cfg = readClientConfig(CLAUDE_SETTINGS).cfg;
  const { warnings } = backupWithWatch(CLAUDE_SETTINGS);
  cfg.env = cfg.env || {};
  cfg.env.ANTHROPIC_BASE_URL = ROUTER_URL;
  cfg.env.ANTHROPIC_AUTH_TOKEN = ROUTER_TOKEN;
  if (options.slots) {
    for (const [name, envKey] of Object.entries(CLAUDE_SLOT_ENV)) {
      const s = (slotMap.claude || {})[name];
      if (s && s.provider) cfg.env[envKey] = slotAlias('claude', name);
      else if (String(cfg.env[envKey] || '').startsWith('mixr-')) delete cfg.env[envKey];
    }
  }
  writeFileAtomic(CLAUDE_SETTINGS, JSON.stringify(cfg, null, 2) + '\n');
  return { warnings };
}
function switchCodexRouter(options = {}) {
  const { text } = codexConfig.read(CODEX_CONFIG);
  const cur = codexTopLevel(text, 'model');
  const fallback = (store.codex.find(p => p.enabled !== false && p.model) || {}).model || '';
  let model = cur || fallback, reviewModel;
  if (options.slots) {
    // 两个槽位都要先验证再动客户端配置:主槽缺 provider / 子代理槽指了个没有 Key 的渠道,
    // 写进 config.toml 之后 Codex 启动才报错,那时用户已经看不到是哪一步配错了。
    for (const name of ['main', 'reviewer']) {
      const slot = resolveSlot('codex', slotAlias('codex', name));
      if (!slot || !slot.provider || slot.provider.enabled === false || !slot.model || !slot.provider.api_key) {
        const err = new Error(`Codex ${name} 槽位须绑定已启用、有模型名和 API Key 的渠道`);
        err.statusCode = 400;
        throw err;
      }
    }
    model = slotAlias('codex', 'main');
    reviewModel = slotAlias('codex', 'reviewer');
  }
  writeCodexConfig({ section: ROUTER_SECTION, name: `mixrouter(经 :${PROXY_PORT} 路由)`,
    base_url: ROUTER_URL + '/v1', api_key: ROUTER_TOKEN, wire_api: 'responses',
    model, reviewModel, keepModel: !options.slots, syncCatalog: !!options.slots, expectedRevision: options.revision });
}
function switchRouter(app, options = {}) {
  if (app === 'zcode') return switchZcodeRouter(options);
  if (app === 'codex') return switchCodexRouter(options);
  if (app === 'claude') return switchClaudeRouter(options);
  throw zcodeConfig.invalid('未知客户端 app');
}

const zcodeModelsOf = p => [...new Set([
  ...(Array.isArray(p.models) ? p.models : []), p.model,
  ...Object.values(p.slots || {}),
].filter(m => typeof m === 'string' && m.trim()).map(m => m.trim()))];

function zcodeSpec(p) {
  const app = providerApp(p.id);
  if (!app) throw zcodeConfig.invalid('渠道不存在');
  if (p.enabled === false) throw zcodeConfig.invalid('渠道已停用，无法注册 ZCode');
  if (!p.api_key) throw zcodeConfig.invalid('渠道未配置 API Key');
  const models = zcodeModelsOf(p);
  if (!models.length) throw zcodeConfig.invalid('渠道没有可用模型，无法注册 ZCode');
  const wire = wireOf(p, app);
  return { target: p.id, base_url: zcodeConfig.baseURL(p.base_url, wire), api_key: p.api_key,
    wire_api: wire, models, model: models[0] };
}

function zcodeRouterSpec(options = {}) {
  if (!zcodeConfig.isObject(options)) throw zcodeConfig.invalid('请求体必须是 JSON 对象');
  const wire = options.wire_api === undefined ? 'anthropic' : options.wire_api;
  if (typeof wire !== 'string' || !Object.hasOwn(zcodeConfig.KINDS, wire)) throw zcodeConfig.invalid('wire_api 必须是 anthropic、responses 或 chat');
  if (options.model !== undefined && (typeof options.model !== 'string' || !options.model.trim()))
    throw zcodeConfig.invalid('model 必须是非空字符串');
  const app = wire === 'anthropic' ? 'claude' : 'codex';
  // Responses can use either OpenAI upstream via the existing responses→chat adapter.
  const usable = p => p && p.enabled !== false && p.api_key &&
    (wire !== 'chat' || wireOf(p, app) === 'chat');
  const models = new Set(storeOf(app).filter(usable).flatMap(zcodeModelsOf));
  // Explicit route/pool model overrides are real configured models too. Never
  // synthesize IDs from substring match patterns (e.g. "opus, sonnet").
  for (const r of [...routes.rules, routes.default || {}]) {
    if (r.enabled === false || !ruleBelongsToApp(r, app)) continue;
    for (const member of poolMembers(r, app)) {
      if (usable(member.provider) && typeof member.model === 'string' && member.model.trim()) models.add(member.model.trim());
    }
  }
  if (!models.size) throw zcodeConfig.invalid('对应协议没有已启用渠道的可用模型');
  const model = options.model === undefined ? [...models][0] : options.model.trim();
  if (!models.has(model)) throw zcodeConfig.invalid('model 不在对应协议的可用模型列表中');
  return { target: ROUTER_ID, base_url: zcodeConfig.baseURL(ROUTER_URL, wire), api_key: ROUTER_TOKEN,
    wire_api: wire, models: [...models], model };
}

function switchZcode(p) { zcodeConfig.writeConfig(zcodeSpec(p)); }
function switchZcodeRouter(options = {}) { zcodeConfig.writeConfig(zcodeRouterSpec(options)); }
function liveZcodeState() {
  return zcodeConfig.liveState(meta => {
    if (!current.zcode || current.zcode !== meta.target) return null;
    if (current.zcode === ROUTER_ID) return zcodeRouterSpec({ wire_api: meta.wire_api, model: meta.model });
    const p = findProvider(current.zcode);
    return p ? zcodeSpec(p) : null;
  }, ROUTER_URL);
}

// 读取客户端当前实际生效的上游(与渠道库比对,给 UI 显示"配置漂移"用)
const trimSlash = s => String(s || '').replace(/\/+$/, '');
function liveState() {
  const live = {};
  // 只读:解析不了就当没有(读不出配置只影响"漂移"提示,不该让整个控制台报错)。
  // 写入路径走 readClientConfig,那里是"解析不了就拒绝写",两边的取舍不同是有意的。
  let cfg = {};
  try { cfg = readClientConfig(CLAUDE_SETTINGS).cfg; } catch {}
  const env = cfg.env || {};
  const claudeBase = env.ANTHROPIC_BASE_URL || '';
  const curClaude = current.claude && current.claude !== ROUTER_ID ? findProvider(current.claude) : null;
  const claudeRouter = trimSlash(claudeBase) === ROUTER_URL;
  live.claude = { base_url: claudeBase, model: env.ANTHROPIC_MODEL || '', router: claudeRouter,
    // 槽位 env 现值(控制台对比槽位表,提示漂移):别名 = 已托管,其他值 = 用户手设
    slots: Object.fromEntries(CLAUDE_SLOTS.map(n => [n, env[CLAUDE_SLOT_ENV[n]] || ''])),
    match: claudeRouter
      // 路由模式:current 记的是 "@router" 哨兵,或库里有渠道自己就指向代理
      ? (current.claude === ROUTER_ID
        || !!(curClaude && trimSlash(curClaude.base_url) === ROUTER_URL && curClaude.api_key === (env.ANTHROPIC_AUTH_TOKEN || '')))
      : !!(curClaude && curClaude.base_url === claudeBase && curClaude.api_key === (env.ANTHROPIC_AUTH_TOKEN || '')) };

  // Codex 侧的状态由 lib/codex-config.js 的 state() 给出:它按 **TOML 文档结构**读,
  // 而不是按正则抠一段正文。main 原来那版用 `\[model_providers\.<id>\][^\[]*` 去匹配 section,
  // 读不到"这个 section 属于谁、profile 是否引用了它、能力目录有没有覆盖这个别名",
  // 而控制台要报的正是这些(渠道停用/未同步/协议不支持)。两套并存会让面板与写入
  // 各说各话,这里统一到一套。
  live.codex = codexConfig.state(CODEX_CONFIG, { current: current.codex, providers: store.codex,
    routerURL: ROUTER_URL, routerToken: ROUTER_TOKEN, slots: slotsPublic().codex });
  live.zcode = liveZcodeState();
  return live;
}

// ---------------------------------------------------------------- 渠道连通性测试
// testProvider 的编排在 lib/provider-test.js(先探隧道再探上游),
// 隧道探测在 lib/upstream-proxy-check.js,两个协议上游探测在 lib/upstream-probe.js。
// 本文件不再留实现——探活的两条坑(responses 线的路径规则、anthropic 线的 headers 必须先建好)
// 都写在那边。

// ---------------------------------------------------------------- 控制台
function maskKey(k) {
  if (!k) return '';
  return k.length > 12 ? k.slice(0, 6) + '…' + k.slice(-4) : '***';
}
// 控制台 API 整块在 lib/http/console.js。这里只做一次工厂接线:
// 活状态以 getter/setter 注入(不是快照)——每个写分支都是 `await readObject()` 之后才取现值,
// 用请求开始时的快照会让慢请求覆盖掉这期间刚保存的配置。
const createConsoleHandler = require('./lib/http/console').createConsoleHandler;
const apiHandler = createConsoleHandler({
  // 常量
  VERSION, PROXY_PORT, UI_PORT, CODE_REVISION, ROUTER_ID, ROUTER_URL, ROUTER_TOKEN,
  BACKUP_KEEP, SESSION_TTL_MS, COOLDOWN_MS, BODY_LIMIT, HOST, PUBLIC_DIR, ENDPOINTS, ROOT,
  maskKey,                       // 主入口的公开导出,工厂只用不改
  // 活状态:读用 getter;整份替换的那几个另有 setter
  getStore: () => store,
  getCurrent: () => current, setCurrent: v => { current = v; },
  getRoutes: () => routes, setRoutes: v => { routes = v; },
  getSlotMap: () => slotMap, setSlotMap: v => { slotMap = v; },
  getSess: () => sess,
  // 闭包住活状态或属于编排的领域函数
  liveState, explainRoute, updateCodexConfig, configureClaudeSplit, healthStatus,
  applyClientSwitch, clientSwitchMessage, withStoreRollback, drainStoreWarnings, testProvider,
  sessionList, sessionRecord, storeOf, findProvider, providerApp, ghostRefs,
  mutateSessions, saveRoutes, saveSlots, saveStore, requestLog, compactWindow,
  slotsPublic, validateSlotPut,
  usageSummary,
  switchClaude, switchCodex, switchZcode, switchRouter,
});

// ---------------------------------------------------------------- 启动
function listen(port, handler, label) {
  return new Promise((ok, bad) => {
    const srv = http.createServer(handler);
    srv.on('error', bad);
    srv.listen(port, HOST, () => ok(srv));
  });
}
// 被测试 require 时不自动起服务、不吞异常;只有直接运行才进入常驻模式
if (require.main === module) {
  process.title = 'mixrouter';
  // 长驻进程兜底:单次请求内的意外异常只记日志,不退出
  process.on('uncaughtException', e => console.error(`[uncaught] ${new Date().toISOString()} ${e.stack || e}`));
  process.on('unhandledRejection', e => console.error(`[unhandled] ${new Date().toISOString()} ${e && (e.stack || e.message) || e}`));
  // 监听、排空、收尾落盘都交给 lib/server/lifecycle.js。它 require 零副作用,不注册 signal、
  // 不决定退出码、不调 process.exit —— 那些仍然留在下面这块 main 里。
  // ⚠ 这是**改关停语义**,不是把上面那几行搬个家:
  //   现役:收到 SIGTERM → 同步落盘四个目标 → process.exit(0),**不排空**,
  //         两个 server 上在途的响应直接被连接 reset 掉;
  //   现在:停收新连接 → 排空在途响应(周期扫空闲连接)→ 落盘 → exit(0)。
  //   能这么改而不把「停止」变成「重启」,全靠下面 drainTimeoutMs 那个推算。
  const { createLifecycle } = require('./lib/server/lifecycle');
  const lifecycle = createLifecycle({
    host: HOST, proxyPort: PROXY_PORT, uiPort: UI_PORT,
    altPorts: altPorts(PROXY_PORT, UI_PORT),
    proxyHandler, apiHandler,
    // ⚠ 这一行是整套接线唯一「差一点就出事」的地方:别删、别改大、别交给默认值。
    // 排空最多能拖多久,由**关停方的耐心**决定,不是由这里定。两条耐心:
    //   - mixctl 的 stop():process.kill(pid,'SIGTERM') 之后每 200ms 轮询 alive(pid),
    //     Date.now()-t0 > 4000 就 process.kill(pid,'SIGKILL');
    //   - launchd 的 KeepAlive.SuccessfulExit=false 只认 exit 0 是「正常停止」,
    //     被信号打死 = 非正常退出 = **立刻重新拉起**。
    // 两条合起来:排空+落盘一旦越过 4000ms,进程会在收尾落盘跑完之前被 SIGKILL,
    // 于是「停止」退化成「丢状态 + 被拉起重启」。lifecycle 的默认值是 15000,
    // 照默认接上去正好落进这条路径。
    // 取 2000:2000(排空上限)+ MIN_FLUSH_BUDGET_MS 1000(lifecycle 的落盘预算下限,
    // 排空之后 flush 至少要留这么多,否则排空吃光预算、flush 被瞬间判超时)
    // = 3000 < 4000,余下约 1000ms 留给进程启动、信号投递与调度抖动。
    drainTimeoutMs: 2000,
    // 契约来自 lifecycle 的 runFlush:**返回按目标分列的对象**,每项 {ok:true} 或
    // {ok:false,error};返回非对象记 _overall 失败;**抛错则整体失败且后面的目标不再跑**。
    // 所以四个目标各自 try/catch —— 这是对现役那句
    //   try { saveStore(); saveRoutes(); saveSlots(); flushSessions(); } catch {}
    // 的净改进:现役第一个抛异常,后面三个全部跳过,而且没人知道跳过了。分目标返回之后,
    // 「哪个没落成」是 stop() 结果里的一个字段(flushResult/flushError),不再是悄无声息。
    // 四个目标都是同步的(saveJson 是 lib/atomic-write 的同步原子写,sess.flush() 同步刷盘),
    // 直接返回普通对象即可,不需要是 async 函数。
    onFlush: () => {
      const goals = [['store', saveStore], ['routes', saveRoutes], ['slots', saveSlots], ['sessions', flushSessions]];
      const result = {};
      for (const [goal, fn] of goals) {
        try { fn(); result[goal] = { ok: true }; }         // 单个目标抛错不带走在它后面的目标
        catch (e) { result[goal] = { ok: false, error: (e && e.message) || String(e) }; }
      }
      return result;
    },
    // 沿用现役那两行 console.error 的风格,不新造一套日志格式
    onWarning: (code, message) => console.error(`[lifecycle] ${code} ${message}`),
  });
  lifecycle.start().then(rep => {
    // 端口从**实际绑定结果**取,不再打配置常量:PROXY_PORT/UI_PORT 设成 0 时,
    // 原先的横幅与 /api/state 会一起自报 0,拿不到内核真正分配的口。
    console.log(`[mixrouter v${VERSION}] 代理 :${rep.proxy.port}(Claude /v1/messages · Codex /v1/responses)  控制台 http://${HOST}:${rep.ui.port}  渠道 claude ${store.claude.length} / codex ${store.codex.length}`);
    reportGhostRoutes();
    // 兼容监听:best-effort。拿不到的口 lifecycle 已经按同样的措辞 warn 过,
    // 这里只补报拿到的那些(与现役一行一条的格式一致)。
    for (const entry of rep.alt) console.log(`  兼容监听 :${entry.port}(旧客户端指向的端口,同一份状态)`);
    // 运行期日志清理:启动即清一次(处理停机期间攒下的旧日志),之后每 RETENTION_SWEEP_EVERY_MS 清一次。
    // 清理由 lib/log-retention.js 执行,带锁可与 `mixctl gc` 并发;本调用只在进程启动时生效一次。
    startLogRetention();
  }).catch(e => {
    console.error(`启动失败: ${e.message}(端口 ${PROXY_PORT}/${UI_PORT} 是否被占用?)`);
    process.exit(1);
  });
  // 优雅退出:先停收新连接、排空在途响应,再落盘,最后以 0 退出。launchd 的
  // KeepAlive.SuccessfulExit=false 靠这个区分「mixctl stop / launchctl kickstart -k 的正常停止」
  // 与「真崩了」,前者不会被立刻重新拉起 —— 而这套区分成立的前提,是整条路径不越过
  // mixctl 的 4000ms 强杀线(推算见上面 drainTimeoutMs),否则进程被信号打死 = 非 0 退出
  // = 反而被 launchd 立刻拉起来。
  // 关停时把两条出站连接池也放掉:直连与隧道的 agent 都持有 keep-alive socket,
  // 它们已经 unref(不会挡退出),但显式销毁能让对端立刻看到 FIN,而不是等空闲超时。
  // 必须在 lifecycle.stop() **之后**:排空阶段还在用这些连接转发在途响应,提前销毁会把它们掐断。
  for (const sig of ['SIGTERM', 'SIGINT'])
    process.on(sig, () => { lifecycle.stop().then(() => { destroyAgents(); process.exit(0); }); });
}

// 供测试与脚本复用;store/routes/current 经 _state 存取以保持闭包绑定
module.exports = {
  VERSION, proxyHandler, apiHandler, listen,
  // 新增只读诊断导出;resolveRoute 与真实请求的选择入口保持不变。
  explainRoute,
  // 运行期日志清理:一次性入口(给 `mixctl gc` 复用)与调度器(测试用临时 MIXR_DATA_DIR 注入)
  sweepLogsNow, startLogRetention, LOG_RETAIN_DAYS, RETENTION_SWEEP_EVERY_MS,
  resolveRoute, applyModel, safeHeader, extractUsage, maskKey, tomlStr, validBaseUrl,
  switchClaude, switchCodex, switchClaudeRouter, switchCodexRouter, switchRouter,
  switchZcode, switchZcodeRouter, zcodeSpec, zcodeRouterSpec, liveZcodeState, joinUpstreamPath,
  liveState, testProvider, codexTopLevel, writeCodexConfig, updateCodexConfig,
  // v3 会话分发
  sessionIdentity, sessionLabel, parseSessionId, matchWhen, normalizeRule, poolMembers, ruleBelongsToApp, bodyRouteText,
  ghostRefs, reportGhostRoutes,
  sessionList, buildUpstreamHeaders, clientToken, strategyOf, applyLabel,
  // v3.1 OpenAI 端点(Codex 组)
  ENDPOINTS, classifyProxyRequest, wireOf, upstreamPathOf, modelList, buildOpenAiHeaders,
  codexHeaderSessionId, codexBodySessionId, codexFirstUserText, codexUserTexts, extractUsageOpenAI, extractUsageFor,
  responsesToChat, chatJsonToResponses, streamChatAsResponses, chatToolChoice,
  // claude 组 chat 上游翻译(lib/wire-chat.js)
  wireChat,
  // v3.2 子代理槽位
  slotAlias, resolveSlot, slotsPublic, validateSlotPut, CLAUDE_SLOTS, CLAUDE_SLOT_ENV,
  normalizeChannelSlots, CLAUDE_SLOT_KEYS, claudeSplitPatch, configureClaudeSplit, altPorts,
  // v3.2 渠道池主备策略
  pickMember, markCooldown, inCooldown,
  // v3.4 上游健康(冷却/超时与重试配置)
  healthStatus, errorClass, providerEligible,
  ROUTER_ID, ROUTER_URL, ROUTER_TOKEN, ROUTER_SECTION,
  _state: {
    get store() { return store; }, set store(v) { store = v; },
    get routes() { return routes; }, set routes(v) { routes = v; },
    get current() { return current; }, set current(v) { current = v; },
    get sessions() { return sess.sessions; }, set sessions(v) { sess.sessions = v; },
    get cooldowns() { return sess.cooldowns; }, set cooldowns(v) { sess.cooldowns = v; },
    get slotMap() { return slotMap; }, set slotMap(v) { slotMap = v; },
    // 池轮转游标表(ruleId -> 游标)。**必须是 getter**:resetPools() 会整份换掉这个对象,
    // 快照下来的引用会在重置后指向旧表。路由预览的「看一眼不改游标」断言要拿它做前后对照。
    get pools() { return sess.pools; },
    // 生效中的请求体上限与超限后的排空预算(只读)。测试用它证明非法的 MIXR_BODY_LIMIT_MB
    // 会回落默认值,而不是变成 NaN 把上限静默取消(`size > NaN` 恒 false = 多大的体都照收)。
    get bodyLimit() { return BODY_LIMIT; },
    get bodyDrainExtra() { return BODY_DRAIN_EXTRA; },
    get bodyDrainMs() { return BODY_DRAIN_MS; },
    get bodyDrainAborts() { return bodyDrainAborts; },
    get bodyDrainTimeouts() { return bodyDrainTimeouts; },
    resetPools() { sess.resetPools(); },
    bindSession(key, providerId, extra = {}) {
      sess.sessions.set(key, { providerId, model: '', ruleId: '', label: '', kind: 'header',
        created: Date.now(), lastUsed: Date.now(), reqs: 0, inTok: 0, outTok: 0, pinned: false, ...extra });
      return sess.sessions.get(key);
    },
  },
};
