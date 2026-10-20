'use strict';
// 控制台 API:/api/* 全部端点 + /healthz + 静态首页。整块从 mixrouter.js 搬来,行为不变。
//
// **本模块不自持状态**:store / current / routes / slotMap / sess 都留在主入口,这里只拿
// 显式注入的 getter/setter。这一点是语义要求,不是风格:
//   PUT/POST 分支都先 `await readObject()` 再决定写什么,读到的现值必须是**那一刻**的值。
//   若在请求开始时快照成局部变量,一个慢请求就会用旧值覆盖掉这期间刚保存的配置。
// 所以下面所有对这两个状态的读都是**就地**调 getter,不做任何提前缓存。
//
// 叶子模块(respond / body / headers / log-history / inventory / targets / compact / rules /
// slots / session-config / keys / zcode-config)无副作用,直接 require,不在这里重抄实现;
// 会闭包住活状态或属于编排的(liveState / applyClientSwitch / mutateSessions / save* /
// requestLog / compactWindow / 槽位与路由的公开视图 …)一律由调用方注入。

const fs = require('fs');
const os = require('os');
const path = require('path');

const httpRespond = require('./respond');
const httpBody = require('./body');
const { isLoopbackHost, isCrossSiteRequest } = require('./local-access');
const headersLib = require('../routing/headers');
const { cursorHttpStatus } = require('../observability/log-history');
const { listBackups } = require('../backup/inventory');
const { backupTargets } = require('../backup/targets');
const compactLib = require('../routing/compact');
const rulesLib = require('../routing/rules');
const slotsLib = require('../routing/slots');
const sessionConfig = require('../routing/session-config');
const { ringOf } = require('../routing/keys');
const zcodeConfig = require('../zcode-config');

const { authHeaderValue, hasCtlChar, validBaseUrl } = headersLib;
const { normalizeChannelSlots } = slotsLib;
const normalizeRule = r => rulesLib.normalizeRule(r);

function createConsoleHandler(deps) {
  const {
    // 常量:进程启动时就定死,按值传入
    VERSION, PROXY_PORT, UI_PORT, CODE_REVISION, ROUTER_ID, ROUTER_URL, ROUTER_TOKEN,
    BACKUP_KEEP, SESSION_TTL_MS, COOLDOWN_MS, BODY_LIMIT, HOST, PUBLIC_DIR, ENDPOINTS, ROOT,
    // maskKey 是主入口的公开导出,这里只用不改
    maskKey,
    // 活状态:getter 每次现取;整份替换的那几个另有 setter
    getStore, getCurrent, setCurrent, getRoutes, setRoutes, getSlotMap, setSlotMap, getSess,
    // 闭包住活状态或属于编排的领域函数
    liveState, explainRoute, updateCodexConfig, configureClaudeSplit, healthStatus,
    applyClientSwitch, clientSwitchMessage, withStoreRollback, drainStoreWarnings, testProvider,
    sessionList, sessionRecord, storeOf, findProvider, providerApp, ghostRefs,
    mutateSessions, saveRoutes, saveSlots, saveStore, requestLog, compactWindow,
    slotsPublic, validateSlotPut,
    // 用量统计(lib/usage/*):统计是异步的(要读磁盘日志)。
    usageSummary,
    // 客户端切换:三扇门各自的编排都在主入口,这里只按 app 分派
    switchClaude, switchCodex, switchZcode, switchRouter,
  } = deps;

  // 旧式单 Key 渠道与压缩选择共用同一个合成 ID。
  function publicProvider(p) {
    const { api_key, keys, ...rest } = p;
    const ring = ringOf(p);
    return { ...rest, key_masked: maskKey(api_key), has_key: !!api_key,
      keys: ring.map(k => ({ id: k.id, label: k.label, key_masked: maskKey(k.key), enabled: k.enabled !== false })),
      active_key: ring.some(k => k.id === p.active_key) ? p.active_key : ((ring[0] || {}).id || '') };
  }
  // authHeaderValue / hasCtlChar 已在文件头部从 lib/routing/headers.js 引入(同实现同文案)

  // 控制台写接口的类型闸门。以前大量字段直接 String(b.x):对象会变成 "[object Object]"
  // 存进配置(models 就真被存成 ["[object Object]"])、数组会被当成字符串、数字/对象塞进
  // active_key 会静默把生效 Key 重置成第一把。这些都不是"用户想要的结果",而是**看起来保存
  // 成功了**的坏配置——比直接 400 难查得多(渠道名对、模型名却成了 [object Object])。
  // 只接受"本来就是字符串/数字"的值;其余一律 400 说清哪个字段。
  function strField(b, key, label) {
    if (b[key] === undefined) return undefined;
    const v = b[key];
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    throw zcodeConfig.invalid(`${label} 必须是字符串`);
  }
  // 字符串列表:数组里每个元素都得是字符串/数字。以前只判 Array.isArray,于是
  // [null,{},5] 原样存进 models,后续按模型名匹配全部失配却没有任何提示。
  function strListField(b, key, label) {
    if (b[key] === undefined) return undefined;
    const v = b[key];
    if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(v)) throw zcodeConfig.invalid(`${label} 必须是字符串或字符串数组`);
    return v.map((x, i) => {
      if (typeof x === 'string') return x.trim();
      if (typeof x === 'number' && Number.isFinite(x)) return String(x);
      throw zcodeConfig.invalid(`${label} 第 ${i + 1} 项不是字符串`);
    }).filter(Boolean);
  }
  // 同一渠道可存多把 Key(同 provider 多账号),切换 = 换生效 Key;api_key 始终等于生效那把,
  // 这样转发、测试、切换客户端这些老路径一行都不用改
  function normalizeKeys(input, prev = []) {
    const out = [];
    for (const raw of Array.isArray(input) ? input : []) {
      if (!raw || typeof raw !== 'object') continue;
      const id = String(raw.id || '').trim() || ('k' + Math.random().toString(36).slice(2, 8));
      const old = prev.find(x => x.id === id);
      const key = String(raw.key || '').trim() || (old ? old.key : '');
      if (!key) return { error: '每个 Key 都要有值（已有的留空表示不改）' };
      if (hasCtlChar(key)) return { error: 'API Key 不能包含换行或控制字符' };
      if (out.some(k => k.key === key)) continue;            // 同一个 Key 只留一条
      out.push({ id, label: String(raw.label || (old && old.label) || '').trim() || `账号${out.length + 1}`, key });
    }
    return { keys: out };
  }
  // 所有读写先过字面量回环 Host 白名单,避免 rebinding 让攻击者域名成为同源控制台。
  // 写操作再查浏览器来源;无 Origin 的本机 CLI 保持可用。判据取实际 Host,不取配置端口。
  // ---- public/ 静态资源:白名单扩展名 → MIME。
  // 只认下面这些后缀,**不认识的一律不服务**。以前这里只有一条硬编码的 `/` → index.html;
  // 把 CSS/JS/图标拆成独立文件之后需要通用路径,但"通用"不等于"什么文件都发":回落成
  // application/octet-stream 会把别人放进 public 的任何东西(备份副本、日志、临时产物)原样发出去。
  // .html/.css/.js/.json 带 charset=utf-8 —— 少了它浏览器按 locale 猜编码,中文控制台会乱码;
  // 二进制类型不带 charset(带了反而可能被当成文本处理)。
  const STATIC_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  // target 是否在 root 之内(两者都必须是**已经 realpath 过的**真实路径)。
  // 用 path.relative 而不是 `target.startsWith(root)`:后者在 `/x/public-evil` 这种
  // 与 `/x/public` 同前缀、却是另一个目录的路径上会误判成"在 public 之内"。
  function isInside(root, target) {
    if (target === root) return true;
    const rel = path.relative(root, target);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  // 把一个 URL 的 pathname 解析成"public/ 里一个可以读的文件";不满足任何一条安全条件就返回 null。
  // 判断顺序是**安全关键**,不能调换:
  //   1) 拒 `\`、NUL 与控制字符 —— `\` 在把路径按 Windows 语义解析的地方就是分隔符(`..\..\`),
  //      NUL 会截断路径,让"校验用的串"和"真正打开的串"不是同一个;
  //   2) decodeURIComponent —— **必须做**:`new URL(req.url, base).pathname` 不替你解码,
  //      `/..%2fpackage.json` 的 pathname 就是字面这一串;不解码等于拿编码后的串当文件名去读;
  //   3) 解码**之后**再查一遍穿越 —— 解码会把 `%2e%2e` 变成 `..`,只查解码前等于没查;
  //   4) 扩展名白名单 —— 不在表里的一律不认,不做 octet-stream 回落;
  //   5) realpathSync 解析软链后比较**真实路径** —— 这是唯一能挡住"public 里放一个指向
  //      /etc/passwd(或 ../../providers.json)的软链"的手段;只做字符串前缀判断在软链面前完全无效。
  function staticFileFor(pathname) {
    const bad = s => /[\\\u0000-\u001f\u007f]/.test(s);
    if (bad(pathname)) return null;
    let decoded;
    try { decoded = decodeURIComponent(pathname); }
    catch { return null; }                                  // `%zz`、裸 `%` 这类解不出来的一律不服务
    if (bad(decoded)) return null;                          // 解码后才现形的同样拒掉
    // 穿越判据:路径里任何一段**正好**是 `..`。不写成 includes('..') —— 那会把 `a..b.js`
    // 这种合法文件名一起拒掉。注意 URL 解析器已经替我们折掉了裸的 `/../`(见 test 里的原始请求行用例),
    // 但编码过的那些不会,所以这一层必须自己扛。
    if (decoded.split('/').includes('..')) return null;

    // 前导斜杠去掉,把 URL 路径变成相对路径;`/` 与 `/index.html` 都落到根的 index.html。
    const rel = decoded.replace(/^\/+/, '');
    // 目录请求(以 `/` 结尾)按该目录下的 index.html 处理,**不列目录**:列目录会把 public 下
    // 的完整文件清单(含还没接线的中间产物)送出去,而这不是一个给人浏览文件的服务。
    // 该目录没有 index.html 就是 404,与"资源不存在"同一个出口,不另立语义。
    // 不带结尾斜杠的 `/js` 不做特殊处理 —— 它没有后缀,会被下面的白名单拒掉,一样是 404。
    const relPath = rel === '' ? 'index.html' : (rel.endsWith('/') ? rel + 'index.html' : rel);
    const abs = path.join(PUBLIC_DIR, relPath);
    // path.join 只做字符串正常化、**不做边界检查**(它会把 `public/../x` 折成 `x`);上面的 `..`
    // 判据让这种情况到不了这里,真正兜底的是下面的 realpath 比较。
    const type = STATIC_TYPES[path.extname(abs).toLowerCase()];
    if (!type) return null;                                 // 不在白名单里:404,不回落 octet-stream
    // 根的 index.html 是控制台本体,读不到意味着部署坏了 —— 老行为回 500 而不是 404。
    // 这个标记跟着结果一起带出去,由调用方决定缺失时回哪个码。
    const root = relPath === 'index.html';

    let realFile, realRoot;
    try {
      // 两边都解析成真实路径再比,而且**目录也解析**:macOS 上 /tmp 是指向 /private/tmp 的软链,
      // 只解析文件那一侧会把 /tmp 下的合法资源判成"越界"。
      realFile = fs.realpathSync(abs);
      realRoot = fs.realpathSync(PUBLIC_DIR);
    } catch {
      // 不存在 / 断链 / 解不开:当作"这个资源没有"(根的 index 由调用方回 500)。
      return root ? { real: null, type, root } : null;
    }
    if (!isInside(realRoot, realFile)) return null;          // 软链指到 public 之外 → 不服务
    return { real: realFile, type, root };
  }

  function apiHandler(req, res) {
    // JSON 响应体的发送在 lib/http/respond.js(控制台侧的 { error: ... } 形状)。
    // 这里的 send 是它的 200/任意码出口;sendErr 走同一套,省得每处手写 writeHead。
    const send = (code, obj) => httpRespond.sendJson(res, code, obj);
    const sendErr = (code, message) => httpRespond.sendError(res, code, message);
    if (!isLoopbackHost((req.headers || {}).host)) {
      return sendErr(403, '拒绝非回环 Host:请使用 http://127.0.0.1 访问控制台');
    }
    const url = new URL(req.url, `http://${HOST}:${UI_PORT}`);
    const p = url.pathname;
    // Host 已校验,写操作再拒绝跨站来源;不新增远程鉴权或客户端 token。
    if (req.method !== 'GET' && req.method !== 'HEAD' && isCrossSiteRequest(req)) {
      return sendErr(403, '拒绝跨站写入:控制台只接受同源或本机客户端的请求');
    }
    // 读体(含体积上限、深度守卫、JSON 解析、必须是非数组对象)在 lib/http/body.js。
    // 上限与"超限即销毁请求"这套控制台侧的行为留在调用点传入:代理入口的排空语义不同。
    const readObject = () => httpBody.readObject(req, {
      limit: BODY_LIMIT, invalid: zcodeConfig.invalid, isObject: zcodeConfig.isObject,
    });
    // 历史查询的游标类错误(map 定义在 lib/observability/log-history.js,与抛这些码的地方同一处)。
    // 命中即回 4xx 并返回 true;不是游标错返回 false,由调用方原样抛出。
    const sendCursorError = e => {
      const status = cursorHttpStatus(e.code);
      if (!status) return false;
      send(status, { error: e.message, code: e.code });
      return true;
    };

    // 写渠道库成功后的统一回包:**必须**先把预警取出来(它顺带清空暂存,连调两次第二次就
    // 什么也拿不到了;不取的会把上一次的预警漏到下一次请求上)。
    // 为什么要带出去:渠道库默认只留 5 份备份,而每建/改一次渠道就写一次库,池满之后
    // **每次保存都在轮换** —— 用户的"渠道库有备份"这句话在这一次保存之后就只对最近 5 次
    // 成立了,他得当场知道,不能只写进服务端日志。
    const sendStoreOk = (extra = {}) => {
      const w = drainStoreWarnings();
      return send(200, { ok: true, ...extra, ...(w ? { warnings: w } : {}) });
    };

    Promise.resolve().then(async () => {
      // ---- 路由预览(POST 只为携带上下文,仍过 readObject 与跨站闸门)
      if (req.method === 'POST' && p === '/api/routing/preview') {
        const result = explainRoute(await readObject());
        return send(result.ok ? 200 : result.error.httpStatus, result);
      }
      // ---- Codex 配置:读现值 / 两个受控写入(同步能力目录、设推理档位)。
      // 写入要求 revision 对得上,面板渲染的是只读快照,对不上就必须让用户刷新重来。
      if (req.method === 'GET' && p === '/api/codex/config') return send(200, { codex: liveState().codex });
      if (req.method === 'POST' && p === '/api/codex/config') {
        try { return send(200, updateCodexConfig(await readObject())); }
        catch (e) { return send(e.statusCode || 400, { error: e.message }); }
      }
      // ---- 状态
      if (req.method === 'GET' && p === '/api/state') {
        return send(200, {
          version: VERSION, proxy_port: PROXY_PORT, ui_port: UI_PORT,
          uptime_s: Math.floor(process.uptime()), pid: process.pid, code_revision: CODE_REVISION,
          stats: requestLog.today(),
          providers: { claude: getStore().claude.map(publicProvider), codex: getStore().codex.map(publicProvider) },
          current: getCurrent(), live: liveState(), routes: getRoutes(), slots: slotsPublic(),
          routes_revision: compactLib.routeRevision(getRoutes()), compact: compactLib.compactPublic(getRoutes(), getStore().claude),
          sessions: sessionList(),
          cooldowns: Object.entries(getSess().cooldowns).map(([id, until]) => ({ provider: id, until, name: (findProvider(id) || {}).name || id })),
          session_ttl_min: Math.round(SESSION_TTL_MS / 60000), cooldown_s: Math.round(COOLDOWN_MS / 1000),
          router: { id: ROUTER_ID, url: ROUTER_URL, token: ROUTER_TOKEN,
            claude_base: ROUTER_URL, codex_base: ROUTER_URL + '/v1', zcode_base: ROUTER_URL,
            endpoints: ENDPOINTS.map(e => `${e.app === 'claude' ? 'Anthropic' : 'OpenAI'} ${e.path}`) },
        });
      }
      // ---- 健康状态(只读:冷却/可用性/超时与重试配置)
      if (req.method === 'GET' && p === '/api/health') {
        return send(200, healthStatus());
      }
      // ---- 日志(支持过滤:app / provider 模型子串 / model 子串 / status=ok|err|具体码 / limit)
      // 查询串是 URLSearchParams,得显式摊成普通对象:list() 的 limit 归一化读的是 `query.limit`,
      // 而 URLSearchParams 没有自有属性(取 query.limit 恒 undefined),直接透传会把**所有**
      // limit(含 limit=1)静默变成默认 200。摊平后 list 侧那条 limit 语义守卫才真的生效。
      if (req.method === 'GET' && p === '/api/logs') {
        const query = Object.fromEntries(url.searchParams);
        if (query.history === '1' || query.cursor) {
          try { return send(200, await requestLog.listHistory(query)); }
          catch (e) { if (!sendCursorError(e)) throw e; return; }
        }
        return send(200, requestLog.list(query));
      }
      // ---- 统计:ring 内存窗口内的全量聚合(总数/成功率/token/按组/按渠道/按模型)
      // 保留旧聚合字段，并增补明确记录的 slot；历史查询显式选择磁盘范围。
      if (req.method === 'GET' && p === '/api/stats') {
        const query = Object.fromEntries(url.searchParams);
        if (query.history === '1') {
          try { return send(200, await requestLog.summaryHistory(query)); }
          catch (e) { if (!sendCursorError(e)) throw e; return; }
        }
        const { reqs, ok, ok_rate, inTok, outTok, cache, by_app, by_provider, by_model, by_slot, scope, range } = requestLog.summary(query);
        return send(200, { reqs, ok, ok_rate, inTok, outTok, cache, by_app, by_provider, by_model, by_slot, scope, range });
      }
      // ---- 用量统计(磁盘历史 + 内存环;区间/渠道/模型过滤)。
      // 与 /api/stats 的分工:stats 是**内存 ring** 的即时快照(进程内窗口、UTC);
      // usage 会读 logs/requests.jsonl(含轮转归档),按本地时区分桶补齐空桶,并给 TTFB。
      // 响应里没有任何 Key:日志行在落盘前已过白名单+脱敏,这里只聚合数值与名字。
      if (req.method === 'GET' && p === '/api/usage' && usageSummary) {
        const query = Object.fromEntries(url.searchParams);
        try { return send(200, await usageSummary.summarize(query)); }
        catch (e) {
          if (e.statusCode) return send(e.statusCode, { error: e.message, code: e.code });
          throw e;
        }
      }
      // ---- Prometheus 文本指标(纯新增端点):进程生命周期 counter + 内存窗口 gauge。
      // 只读、无参数;不返回任何密钥(标签集固定 app/status_class/wire/direction/quantile/kind)。
      if (req.method === 'GET' && p === '/api/metrics') {
        const body = requestLog.metrics();
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Content-Length': Buffer.byteLength(body) });
        return res.end(body);
      }
      // ---- 备份清点(纯新增端点,只读、无参数)。backupFile 每次改写客户端配置前都复制一份
      // `.bak-mixui-<时间戳>-<随机>` 到同目录,池子满了按纯字典序删最前几个 —— 但从头到尾没有
      // 任何出口把这些备份列出来过,mixctl backups 也只服务于本机命令行。这个端点把同一份清点
      // 交给控制台用:每个备份的名字/大小/mtime/sha256 短摘要 + 下一次备份会删哪几个 + 保留上限。
      //
      // ⚠ 响应里**不得出现任何配置正文或密钥**:
      //   · 列池子只需要目录项里的**文件名**,所以这条路径根本不去读两个配置文件的内容
      //     (读它们正文的地方只有主入口的 readClientConfig / writeCodexConfig 那几个写路径)。
      //   · 摘要算的是备份文件本身,明文不进结果;sha256 截断到 12 位十六进制,是摘要不是凭据。
      //   · 不进请求日志,也不落盘。
      // 这一条是**独立分支**,不调用别的端点、不碰 proxyHandler / 路由块 / sess. / 槽位块。
      if (req.method === 'GET' && p === '/api/backups') {
        return send(200, {
          keep: BACKUP_KEEP,
          dirs: backupTargets({ root: ROOT, home: os.homedir(), env: process.env }).map(({ id, label, file, dir }) => {
            // 目录不在(比如没装 codex 的机器上没有 ~/.codex)不是错误,是"这里查过、没有";
            // 但状态要跟着结果一起报,别把"没查成"混进"零份备份"。
            let listing;
            try { listing = listBackups({ dir, base: file, keep: BACKUP_KEEP }); }
            catch (e) { return { id, label, dir, ok: false, error: { code: e.code || 'list_failed' }, backups: [], unparsable: [], next_delete: [] }; }
            return {
              id, label, dir, ok: true,
              total: listing.total, legacy: listing.legacyCount,
              backups: listing.entries.map(e => ({
                name: e.name, size: e.size,
                // 时间用 entries 里现成的 iso(= 同一个 ts 的 ISO 写法),不在这里另造一个。
                // 三个出口都只认这一个字段名,免得同一份数据出现"iso / ts / mtime"三种时间写法。
                iso: e.iso,
                mode: e.mode.toString(8).padStart(3, '0'),
                // 短摘要。刻意不用 maskKey 的"掐头 6 位 + 去尾 4 位":那是给 api key 的写法,
                // 套在摘要上会造出一个看着像摘要、其实核对不了完整性的片段。
                sha256_12: e.sha256 ? e.sha256.slice(0, 12) : null,
                legacy: e.legacy,
              })),
              // 前缀命中但解析不出时间的名字照样占保留池名额,单独报出来 —— 它们是"池子里有谁
              // 和名字说的不一致"的唯一线索。
              unparsable: listing.unparsable.map(u => ({ name: u.name, reason: u.reason })),
              next_delete: listing.retention.wouldDeleteOnNextBackup,
              next_delete_count: listing.retention.wouldDeleteCount,
            };
          }),
        });
      }
      // ---- 渠道 CRUD(app = claude | codex)
      if (req.method === 'POST' && p === '/api/providers') {
        const b = await readObject();
        if (b.app !== undefined && !['claude', 'codex'].includes(b.app)) return sendErr(400, '渠道 app 必须是 claude 或 codex');
        const app = b.app || 'claude';
        if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return sendErr(400, 'enabled 必须是布尔值');
        if (b.wire_api !== undefined && !(app === 'claude' ? ['anthropic', 'responses', 'chat'] : ['responses', 'chat']).includes(b.wire_api))
          return sendErr(400, app === 'claude' ? 'claude 渠道的 wire_api 必须是 anthropic、responses 或 chat' : 'wire_api 必须是 responses 或 chat');
        // name 也走类型闸门:以前 String({}) → "[object Object]" 直接存成渠道名
        if (b.name !== undefined) strField(b, 'name', '渠道名');
        if (!String(b.name || '').trim() || !b.base_url) return sendErr(400, 'name 与 base_url 必填');
        if (!validBaseUrl(b.base_url)) return sendErr(400, 'base_url 必须是合法的 http(s) URL,如 https://api.example.com');
        if (app === 'codex' && !b.model) return sendErr(400, 'Codex 渠道必须填模型名');
        const id = (app === 'codex' ? 'c' : 'p') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        // 凭据里的换行会让 transport.request 同步抛(见 authHeaderValue):写的时候就不收,
        // 并且不留"只有空白"的 key——PUT 里那是"不改动"的哨兵,存下来就成了一个永远 401 的渠道
        if (hasCtlChar(b.api_key)) return sendErr(400, 'API Key 不能包含换行或控制字符');
        const prov = { id, name: String(b.name).trim(), base_url: String(b.base_url).replace(/\/+$/, ''),
          api_key: authHeaderValue(b.api_key), enabled: b.enabled !== false,
          note: strField(b, 'note', '备注') ?? '', created_at: new Date().toISOString() };
        if (app === 'claude') {
          prov.models = strListField(b, 'models', '模型列表') || [];
          prov.slots = normalizeChannelSlots(b.slots);
          prov.ua = strField(b, 'ua', 'User-Agent') ?? '';
          // responses/chat:该渠道的模型只挂在 Codex(Responses)/OpenAI(Chat)型通道上,由本进程翻译
          if (b.wire_api === 'responses' || b.wire_api === 'chat') prov.wire_api = b.wire_api;
        } else {
          prov.model = strField(b, 'model', '模型名') ?? '';
          prov.wire_api = b.wire_api === 'chat' ? 'chat' : 'responses';
          // 纯文本网关(GLM 一类):把 responses 里的图片换成一句说明,而不是让上游 400
          prov.drop_images = !!b.drop_images;
        }
        if (b.direct !== undefined && typeof b.direct !== 'boolean') return sendErr(400, 'direct 必须是布尔值');
        if (b.direct) prov.direct = true;
        if (Array.isArray(b.keys) && b.keys.length) {
          const kr = normalizeKeys(b.keys, []);
          if (kr.error) return sendErr(400, kr.error);
          prov.keys = kr.keys;
          prov.active_key = prov.keys[0].id;
          prov.api_key = prov.keys[0].key;
        }
        try {
          withStoreRollback(() => getStore()[app].push(prov));
        } catch (e) { return sendErr(500, '写入渠道库失败: ' + e.message); }
        return sendStoreOk({ id });
      }
      let m = p.match(/^\/api\/providers\/([^/]+)$/);
      if (m) {
        const prov = findProvider(m[1]);
        if (!prov) return sendErr(404, '渠道不存在');
        if (req.method === 'PUT') {
          const b = await readObject();
          if (b.app !== undefined && b.app !== providerApp(prov.id)) return sendErr(400, '不能改变渠道所属协议组 app');
          if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return sendErr(400, 'enabled 必须是布尔值');
          if (b.wire_api !== undefined && !(providerApp(prov.id) === 'claude' ? ['anthropic', 'responses', 'chat'] : ['responses', 'chat']).includes(b.wire_api))
            return sendErr(400, providerApp(prov.id) === 'claude' ? 'claude 渠道的 wire_api 必须是 anthropic、responses 或 chat' : 'wire_api 必须是 responses 或 chat');
          // 先在副本上改,全部校验通过再整体替换。以前是直接往 prov 上赋值:base_url 校验失败
          // 之类的 400 只让**这一项**没写进去,前面已经写进去的 enabled/base_url/name 留在内存里,
          // 下一次保存别的渠道时被一起落盘——"保存失败"却真的改了配置(还可能顺手停用渠道)。
          const next = { ...prov };
          if (providerApp(prov.id) === 'claude' && Array.isArray(next.keys)) next.keys = next.keys.map(k => ({ ...k }));
          if (b.name !== undefined) next.name = String(strField(b, 'name', '渠道名')).trim();
          if (b.base_url !== undefined) {
            if (!validBaseUrl(b.base_url)) return sendErr(400, 'base_url 必须是合法的 http(s) URL,如 https://api.example.com');
            next.base_url = String(b.base_url).replace(/\/+$/, '');
          }
          // 留空 = 不改动。判据必须先 trim 再判:以前写的是 if (b.api_key),于是 "   " 是真值,
          // 会把一把能用的 Key 换成一串空格,渠道此后永远 401,而控制台看着像"设过了"
          if (b.api_key !== undefined) {
            const k = String(b.api_key);
            if (k.trim()) {
              if (hasCtlChar(k)) return sendErr(400, 'API Key 不能包含换行或控制字符');
              next.api_key = authHeaderValue(k);
            }
          }
          if (b.enabled !== undefined) next.enabled = !!b.enabled;
          if (b.note !== undefined) next.note = strField(b, 'note', '备注');
          if (providerApp(prov.id) === 'claude') {
            const models = strListField(b, 'models', '模型列表');
            if (models !== undefined) next.models = models;
            if (b.slots !== undefined) next.slots = normalizeChannelSlots(b.slots);
            if (b.ua !== undefined) next.ua = strField(b, 'ua', 'User-Agent');
            if (b.wire_api !== undefined) { if (b.wire_api === 'responses' || b.wire_api === 'chat') next.wire_api = b.wire_api; else delete next.wire_api; }
          } else {
            if (b.model !== undefined) next.model = strField(b, 'model', '模型名');
            if (b.wire_api !== undefined) next.wire_api = b.wire_api === 'chat' ? 'chat' : 'responses';
            if (b.drop_images !== undefined) next.drop_images = !!b.drop_images;
          }
          if (b.direct !== undefined) {
            if (typeof b.direct !== 'boolean') return sendErr(400, 'direct 必须是布尔值');
            if (b.direct) next.direct = true; else delete next.direct;
          }
          // 多 Key(同渠道多账号):keys 是清单,active_key 是当前生效那把,api_key 跟着它走
          if (b.keys !== undefined) {
            // keys 必须是数组。以前非数组 → normalizeKeys 的 `Array.isArray(input)?input:[]` 返回空表
            // → kr.keys.length===0 → `delete next.keys`,把该渠道**所有账号一次擦光**并回 200:
            // 界面显示"保存成功",实际只剩当前生效那把,其余账号静默消失,没法恢复。
            if (!Array.isArray(b.keys)) return sendErr(400, 'keys 必须是数组(每项形如 {key,label})');
            // 清单里留空的行按 prev 解析回原值;老式单 Key 渠道的现存 api_key 也算 prev 的一条,
            // 这样「再加一把」不会把老 Key 挤掉(丢 Key 的根因就在这)
            const kr = normalizeKeys(b.keys, ringOf(prov));
            if (kr.error) return sendErr(400, kr.error);
            // 显式传了非空清单却解析出 0 条:那是解析问题,不是"用户想清空",不能当删除办
            if (b.keys.length && !kr.keys.length) return sendErr(400, 'keys 里没有一条有效的 Key');
            if (kr.keys.length) next.keys = kr.keys; else delete next.keys;
          }
          // active_key 必须是字符串,而且**必须真的在清单里**:以前 String({}) → "[object Object]",
          // 下面 find 找不到就退回 keys[0] —— 用户以为切换了账号,实际生效的被悄悄换成了第一把
          if (b.active_key !== undefined) {
            const ak = strField(b, 'active_key', '生效 Key');
            if (ak && Array.isArray(prov.keys) && !prov.keys.some(k => k.id === ak))
              return sendErr(400, `生效 Key "${ak}" 不在该渠道的 Key 清单里`);
            next.active_key = ak;
          }
          if (Array.isArray(next.keys) && next.keys.length) {
            const act = next.keys.find(k => k.id === next.active_key) || next.keys[0];
            if (b.api_key) act.key = String(b.api_key).trim();   // 编辑弹窗里改的那把就是当前生效那把
            next.active_key = act.id;
            next.api_key = act.key;
          } else delete next.active_key;
          // 校验全过才落到真对象上:字段逐个赋值而不是整体替换,别把并发期间别处刚写上的字段挤掉
          try {
            withStoreRollback(() => {
              for (const k of Object.keys(prov)) if (!(k in next)) delete prov[k];
              Object.assign(prov, next);
            });
          } catch (e) { return sendErr(500, '写入渠道库失败: ' + e.message); }
          return sendStoreOk();
        }
        if (req.method === 'DELETE') {
          const app = providerApp(prov.id);
          // 这一次删除会动**三处**状态:渠道库、槽位表、路由规则。三处必须一起成功,或者
          // 一起回到原样 —— 回滚只做一处比不做更坏。
          //
          // 以前只回滚了渠道数组:槽位与路由的引用在 `saveStore()` **之前**就已经被摘掉、
          // 并且已经各自落盘了(saveSlots / saveRoutes)。于是"写入渠道库失败"这条路径实际
          // 做的是:内存里把渠道放回去,而盘上槽位与路由里对它的引用已经没了。下一次重启,
          // 渠道回来了、绑定它的槽位是空的 —— 而 HTTP 回的是 500「删除失败」,用户以为什么
          // 都没发生。实测(2026-09-27 探针,让原子替换那一步抛 EIO):渠道确实还在,而槽位
          // 从 `{provider: id, model: 'm'}` 变成 `{provider: '', model: ''}`,规则里的
          // provider 也被清空 —— 两处都已写进盘。
          //
          // 快照必须**在 mutate 之前**取,而且必须**深拷贝**。两处都不显然:
          //   · 槽位的摘除是 `delete slotMap[g][name]` —— **原地改嵌套对象**。存引用的话,
          //     回滚时拿到的是那个已经被改过的对象(实测踩过:渠道与路由都回来了,唯独槽位
          //     还是空的)。routes 同理,它在上面也是原地改 `rule.provider`。
          //   · 渠道条目未被修改,保留原数组即可恢复顺序;push 会把被删条目挪到队尾。
          const snapshot = {
            providers: getStore()[app],
            current: { ...getCurrent() },
            slotMap: structuredClone(getSlotMap()),
            routes: structuredClone(getRoutes()),
          };
          getStore()[app] = getStore()[app].filter(x => x.id !== prov.id);
          if (getCurrent()[app] === prov.id) getCurrent()[app] = null;
          if (getCurrent().zcode === prov.id) getCurrent().zcode = null;
          // 两处"改过没有"的标记**声明在 try 之外**:回滚分支要用它们决定写不写回盘,
          // 而那个分支在 catch 里 —— 声明在 try 内部会变成 TDZ 引用错误(实测踩到:
          // 回滚时抛 `routeChanged is not defined`,于是"回滚也失败"被误报)。
          let slotChanged = false;
          let routeChanged = false;
          // 引用该渠道的槽位一并摘除,免得别名路由到不存在的渠道
          for (const g of ['claude', 'codex']) {
            for (const [name, s] of Object.entries(getSlotMap()[g])) {
              if (s && s.provider === prov.id) { delete getSlotMap()[g][name]; slotChanged = true; }
            }
          }
          // ⚠ 从这里开始**每一步落盘都可能在中间失败**,所以三段写在同一个 try 里。
          // 此前只有最后那段 saveStore() 有 try —— 而 saveSlots()/saveRoutes() 是裸调,
          // 它们抛错时 store/current/slotMap/routes **四处内存已经全改完**,函数却直接冒泡到
          // 最外层那个 `send(e.statusCode || 500, { error: e.message })`,回一句裸的 `simulated`。
          // 实测(探针,让 slots.json 的原子替换抛 EIO):HTTP 500 `{"error":"simulated"}`,
          // 内存里渠道 1→0、槽位已摘掉、current 已置空,而盘上 providers.json 原封不动 ——
          // 重启后渠道回来、槽位却没了。这与上面注释里描述的那条老缺陷是同一形状,只是触发点
          // 从"最后一落盘"前移到了"第一落盘"。
          try {
          if (slotChanged) saveSlots();
          // 引用该渠道的路由也要一并解开。以前只清槽位和 current,规则里留着已删渠道的 id:
          // 控制台照旧显示"已绑定",请求打上去却得到 503「没有匹配的路由,或路由未绑定渠道」——
          // 报错说没绑定、界面说有绑定,用户只能自己一个个去翻规则找僵尸引用。
          // 单选目标直接清空;池里的引用逐个摘掉(池空则该规则等同未绑定)。
          for (const rule of [...(getRoutes().rules || []), getRoutes().default]) {
            if (!rule) continue;
            // 保留失效的专用 Key 绑定供修复，命中时明确拒绝而非退回其他账号。
            if (compactLib.hasKeyPin(rule)) continue;
            if (rule.provider === prov.id) { rule.provider = ''; routeChanged = true; }
            if (Array.isArray(rule.pool)) {
              const kept = rule.pool.filter(m => (typeof m === 'string' ? m : m && m.provider) !== prov.id);
              if (kept.length !== rule.pool.length) { rule.pool = kept; routeChanged = true; }
            }
          }
          if (routeChanged) saveRoutes();
          saveStore();
          } catch (e) {
            // 三处一起回滚(包括把槽位与路由重新落盘)。回滚本身若也失败,就只能如实报出去:
            // 那时盘上是不一致的,不能回一句"删除失败"让人以为什么都没变。
            //
            // 回滚里那两次落盘**要不要做**只看 slotChanged/routeChanged,不看"失败在哪一步":
            // 盘上可能已经被前两步写过(比如 saveRoutes 抛错时 slots.json 已经落了新的),
            // 所以只要这一轮改过就得写回旧值。多写一次的代价是零(写的是原内容)。
            getStore()[app] = snapshot.providers;
            setCurrent({ ...getCurrent(), ...snapshot.current });
            setSlotMap(snapshot.slotMap);
            setRoutes(snapshot.routes);
            // 两份文件独立恢复,一处失败不能阻止另一处恢复。
            const rollbackErrors = [];
            for (const [changed, file, save] of [
              [slotChanged, 'slots.json', saveSlots],
              [routeChanged, 'routes.json', saveRoutes],
            ]) {
              if (!changed) continue;
              try { save(); } catch (rb) { rollbackErrors.push(`${file}: ${rb.message}`); }
            }
            if (rollbackErrors.length) {
              return sendErr(500, `删除渠道失败: ${e.message};回滚也失败: ${rollbackErrors.join('; ')} —— 盘上已不一致,请检查上述文件`);
            }
            return sendErr(500, '删除渠道失败: ' + e.message);
          }
          return sendStoreOk();
        }
      }
      // ---- 连通性测试
      m = p.match(/^\/api\/providers\/([^/]+)\/test$/);
      if (req.method === 'POST' && m) {
        const prov = findProvider(m[1]);
        if (!prov) return sendErr(404, '渠道不存在');
        const started = Date.now();
        const result = await testProvider(prov);
        return send(200, { ...result, ms: Date.now() - started });
      }
      // ---- 切换客户端配置(cc-switch 核心动作)
      m = p.match(/^\/api\/switch\/([^/]+)$/);
      if (req.method === 'POST' && m) {
        const prov = findProvider(m[1]);
        if (!prov) return sendErr(404, '渠道不存在');
        const b = await readObject();
        const group = providerApp(prov.id);
        if (b.app !== undefined && !['claude', 'codex', 'zcode'].includes(b.app)) return sendErr(400, '未知客户端 app');
        const app = b.app === undefined ? group : b.app;
        if (app !== 'zcode' && app !== group) return sendErr(400, '客户端与渠道协议组不兼容');
        if (!prov.api_key) return sendErr(400, '渠道未配置 API Key,无法切换');
        // ⚠ 顺序是语义:先落盘渠道库,成功了再改客户端 —— 与下面那条注释反过来做过的代价,
        // 实测是"接口回 500、而用户的 ~/.claude/settings.json 已经被指向本机代理"。
        // 那时他以为没切成,重启后从盘上读回的 current 还是旧的,两边不会自己收敛。
        // 所以走同一条编排(见 applyClientSwitch),别在这里再写一遍先后顺序。
        let warnings;
        try { ({ warnings } = applyClientSwitch(app, () => {
          if (app === 'zcode') switchZcode(prov);
          else if (app === 'claude') return switchClaude(prov);
          else return switchCodex(prov);
        }, prov.id)); }
        catch (e) { return send(e.statusCode || 500, { error: clientSwitchMessage(app, e) }); }
        // 备份池轮换如实带出去(见 backupWithWatch):池满时最老那份在本次写入过程中已被清出,
        // 只进 console.warn 的话,点按钮的人当场看不见,事后也不会想起去看日志。
        return send(200, { ok: true, app, live: liveState()[app], ...(warnings && warnings.length ? { warnings } : {}) });
      }

      // ---- 路由模式:把客户端整体指向本机代理(此后流量按路由规则分发)
      //   body.slots = true(Claude)时同时按槽位表写入/清理槽位 env(子代理各走各的上游)
      m = p.match(/^\/api\/router\/([^/]+)$/);
      if (req.method === 'POST' && m) {
        const app = m[1];
        if (!['claude', 'codex', 'zcode'].includes(app)) return sendErr(400, '未知客户端 app');
        const b = await readObject();
        if (b.app !== undefined && b.app !== app) return sendErr(400, 'app 与路径不一致');
        if (b.slots !== undefined && typeof b.slots !== 'boolean') return sendErr(400, 'slots 必须是布尔值');
        if (app === 'codex' && !getStore().codex.length) return sendErr(400, '还没有 Codex 组渠道,先添加渠道再切路由模式');
        if (app === 'claude' && !getStore().claude.length) return sendErr(400, '还没有 Claude 组渠道,先添加渠道再切路由模式');
        // Codex 的 model 是 TOML 顶层 model,mixrouter 只换 model_provider。渠道模型名为空时
        // 写出来就是 `model = ""`,Codex 拿这个空模型名去请求必然失败,而接口回的是 200
        // (渠道创建时的 model 必填校验管不到 PUT 改空,也管不到这里)。
        if (app === 'codex' && getStore().codex.every(p => !String(p.model || '').trim()))
          return sendErr(400, 'Codex 组渠道都没有填模型名,先补上模型名再切路由模式(否则会写出空 model)');
        let warnings;
        try { ({ warnings } = applyClientSwitch(app, () => switchRouter(app, b) || {}, ROUTER_ID)); }
        catch (e) { return send(e.statusCode || 500, { error: clientSwitchMessage(app, e) }); }
        return send(200, { ok: true, app, live: liveState()[app], ...(warnings && warnings.length ? { warnings } : {}), ...(app === 'claude' && b.slots ? { slots: slotsPublic().claude } : {}) });
      }

      // ---- 会话:列表 / 手动改绑(把某个对话钉到指定渠道)/ 解绑
      if (req.method === 'GET' && p === '/api/sessions') {
        return send(200, { sessions: sessionList() });
      }
      if (req.method === 'DELETE' && p === '/api/sessions') {
        try { mutateSessions(() => getSess().sessions.clear()); }
        catch (e) { return sendErr(e.statusCode || 500, e.message); }
        return send(200, { ok: true, cleared: true });
      }
      let ms = p.match(/^\/api\/sessions\/([^/]+)\/routing$/);
      if (ms && (req.method === 'GET' || req.method === 'PUT')) {
        let key;
        try { key = decodeURIComponent(ms[1]); }
        catch { return sendErr(400, '会话键编码无效'); }
        const b = req.method === 'PUT' ? await readObject() : null;
        // 读完请求体后再取现值，避免慢请求用旧快照覆盖刚保存的配置。
        const s = sessionRecord(key);
        if (!s) return sendErr(404, '会话不存在(可能已过期)');
        const routing = sessionConfig.routingOf(s);
        const revision = sessionConfig.routingRevision(routing);
        // 响应形状保持 {routing, revision}(旧控制台与 mixctl 逐字段对照过):
        // 三层的结构化信息从条目上取 —— GET /api/sessions 的每一行都带
        // required / bound / actual(没有真实请求记录时 actual 为 null、actual_text 是「暂无」)。
        if (!b) return send(200, { routing, revision });
        if (typeof b.expected_revision !== 'string') return sendErr(400, 'expected_revision 必须是字符串');
        if (b.expected_revision !== revision) return sendErr(409, '会话配置已变化，请重新载入后再保存');
        if (Object.keys(b).some(k => !['routing', 'expected_revision'].includes(k)))
          return sendErr(400, '会话配置请求包含未知字段');
        const nextRouting = sessionConfig.normalizeRouting(b.routing, s.app || 'claude', storeOf(s.app || 'claude'));
        // 三个会整条换掉记录对象的门(保存覆盖 / 钉定 / 解绑)都要把世代交给新对象,
        // 否则在途响应会把自己的会话记录当成"已删除后重建的另一条",连统计都丢掉。
        // 见 lib/routing/sessions.js 的 carryMark。
        const next = { ...s, routing: nextRouting };
        getSess().assertRoutingCapacity(key, nextRouting);
        // 低可信身份(内容指纹/匿名)只能编辑或清空存量覆盖,不能新建:
        // 这类身份会把不同对话并成一条、又会因提示词变化拆开同一条,存下的 Key/槽位会串对话。
        getSess().assertRoutingConfigurable(key, nextRouting);
        try { mutateSessions(() => { getSess().sessions.set(key, next); getSess().carryMark(s, key); }); }
        catch (e) { return sendErr(e.statusCode || 500, e.message); }
        return send(200, { ok: true, routing: nextRouting, revision: sessionConfig.routingRevision(nextRouting) });
      }
      ms = p.match(/^\/api\/sessions\/([^/]+)\/pin$/);
      if (req.method === 'POST' && ms) {
        const key = decodeURIComponent(ms[1]);
        const b = await readObject();
        const s = getSess().sessions.get(key);
        if (!s) return sendErr(404, '会话不存在(可能已过期)');
        const id = String(b.provider || '');
        if (id) {
          const group = storeOf(s.app || 'claude');
          const prov = group.find(x => x.id === id);
          if (!prov) return sendErr(404, `渠道不存在(该对话属于 ${s.app === 'codex' ? 'Codex' : 'Claude'} 组,只能绑本组渠道)`);
          if (prov.enabled === false) return sendErr(400, `渠道 "${prov.name}" 已停用,不能绑定`);
        }
        // 改与落盘一起做(见 mutateSessions):落盘失败时这次钉定要整体退回,
        // 不能让接口回 500 而内存里已经钉好了。
        //
        // ⚠ 改的必须是**副本**再整条换回去,不能原地改 `s`:
        // mutateSessions 回滚的是"绑定表里每一条的引用",原地改的话回滚后那条还是被改过的对象。
        // 会话记录里那些字段(app/providerId/model/pinned/lastUsed)都是标量,
        // 浅拷贝一份就够,不需要深拷贝。
        try {
          mutateSessions(() => {
            const next = { ...s };
            if (id) {
              next.providerId = id;
              next.pinned = true;
              if (b.model !== undefined) next.model = String(b.model || '');
              delete getSess().cooldowns[id]; // 手动指定即视为"这个渠道我要用",清掉冷却
            } else {
              next.pinned = false; // 置空 = 解除钉定,下次请求重新按策略分配
              next.providerId = '';
            }
            getSess().sessions.set(key, next);
            getSess().carryMark(s, key);   // 钉定/解绑也是整条换对象,世代要跟过去
          });
        }
        catch (e) { return sendErr(e.statusCode || 500, e.message); }
        return send(200, { ok: true, session: sessionList().find(x => x.key === key) || null });
      }
      ms = p.match(/^\/api\/sessions\/([^/]+)$/);
      if (req.method === 'DELETE' && ms) {
        const key = decodeURIComponent(ms[1]);
        if (!getSess().sessions.has(key)) return sendErr(404, '会话不存在(可能已过期)');
        try { mutateSessions(() => getSess().sessions.delete(key)); }
        catch (e) { return sendErr(e.statusCode || 500, e.message); }
        return send(200, { ok: true });
      }

      // ---- 压缩窗口：只修改明确选定的磁盘配置层，不热改活会话。
      if (req.method === 'GET' && p === '/api/compact/window') {
        const q = url.searchParams;
        return send(200, { window: compactWindow.get({ scope: q.get('scope') || 'global', project: q.get('project') || '' }) });
      }
      if (req.method === 'POST' && p === '/api/compact/window') {
        return send(200, { ok: true, ...compactWindow.set(await readObject()) });
      }
      // 压缩规则身份来自 when.body，改名不影响选择。
      if (req.method === 'GET' && p === '/api/compact') {
        return send(200, { compact: compactLib.compactPublic(getRoutes(), getStore().claude) });
      }
      if (req.method === 'POST' && p === '/api/compact') {
        const next = compactLib.selectCompact(getRoutes(), getStore().claude, await readObject());
        saveRoutes(next);
        setRoutes(next); getSess().resetPools();
        return send(200, { ok: true, compact: compactLib.compactPublic(getRoutes(), getStore().claude), routes: getRoutes() });
      }

      // ---- 路由
      if (req.method === 'PUT' && p === '/api/routes') {
        const b = await readObject();
        compactLib.checkRevision(getRoutes(), b.expected_revision);
        if (!Array.isArray(b.rules)) return sendErr(400, 'rules 必须是数组');
        if ([...b.rules, b.default || {}].some(r => r && r.app !== undefined && !['', 'claude', 'codex'].includes(r.app)))
          return sendErr(400, '路由 app 必须是 claude、codex 或留空，ZCode 复用协议组');
        // 目标渠道必须真实存在。以前只查 app 字段,渠道 id 写成什么都照收:
        // 存进去之后请求命中这条规则就直接 503,报错还说"没有匹配的路由,或路由未绑定渠道"——
        // 控制台里明明显示已绑定,用户只能一条条翻规则找那个僵尸引用。
        const next = { rules: b.rules.map(normalizeRule), default: normalizeRule(b.default || {}) };
        // 按对象身份区分兜底路由,不靠 id——用户完全可能给规则起一个和兜底重名的 id
        for (const [r, label] of [
          ...next.rules.map(r => [r, `规则 ${r.id}`]),
          [next.default, '兜底路由'],
        ]) {
          const g = ghostRefs(r);
          if (g.length)
            return sendErr(400, `${label} 的${g.map(x => x.where).join('、')}指向不存在的渠道 ${g.map(x => x.id).join('、')}；请重新选择目标渠道，或先删掉该规则`);
          // 声明了 app 却绑了另一组的渠道:poolMembers 只在本组里找,找不到就当没目标,
          // 规则会静默失效成"未绑定渠道"。没声明 app 的规则允许只服务另一组(另一组会跳过它),
          // 所以只拦"规则自己声明的那一组里,一个能用的目标都没有"这一种。
          if (r.app && r.provider) {
            const owner = providerApp(r.provider);
            if (owner && owner !== r.app)
              return sendErr(400, `${label} 声明属于 ${r.app === 'claude' ? 'Claude' : 'Codex'} 组，目标渠道却属于 ${owner === 'claude' ? 'Claude' : 'Codex'} 组；两者必须一致`);
          }
        }
        // 先落盘、成功了再提交到内存。以前是 `routes = next; saveRoutes();` —— 落盘失败时
        // 接口回 500,而内存里已经是新规则,转发读的正是内存。于是"保存失败"的弹窗下面,
        // 新规则**已经生效**了;重启之后盘上还是旧的,又"改回来"。实测(探针,让原子替换抛 EIO):
        // HTTP 500,盘上 r1.match 仍 ORIGINAL,内存里已经是 CHANGED。
        try { saveRoutes(next); }
        catch (e) { return sendErr(500, '写入路由规则失败: ' + e.message); }
        setRoutes(next);
        getSess().resetPools(); // 规则变了,轮转游标作废
        return send(200, { ok: true, routes_revision: compactLib.routeRevision(getRoutes()) });
      }

      if (req.method === 'POST' && p === '/api/claude/split') {
        // 这一条会改写用户的 `~/.claude/settings.json`,所以失败必须回一个**带原因的 4xx/5xx**,
        // 不能让它冒泡到最外层那个 `catch (e) { send(e.statusCode || 500, {error: e.message}) }`
        // ——那条路只回一句裸的 e.message(实测是 `{"error":"simulated"}`),用户看不出是哪一步
        // 没成,更看不出"客户端配置有没有被改"。手工构造的 Error 各自带 statusCode 与说明。
        try { return send(200, configureClaudeSplit(await readObject())); }
        catch (e) { return sendErr(e.statusCode || 500, e.message); }
      }

      // ---- 子代理槽位:查 / 改(值 null = 删除该槽;按组部分更新)
      if (req.method === 'GET' && p === '/api/slots') {
        return send(200, { slots: slotsPublic() });
      }
      if (req.method === 'PUT' && p === '/api/slots') {
        const b = await readObject();
        const err = validateSlotPut(b);
        if (err) return sendErr(400, err);
        // 与 PUT /api/routes 同一个道理:先在**副本**上改完、落盘成功了再提交到内存。
        // 以前是边改 `slotMap` 边校验、最后 `saveSlots()`,落盘失败时接口回 500 而内存已经改了
        // —— 而槽位解析读的正是内存(实测:HTTP 500,内存 subagent.model 已是 CHANGED,
        // 盘上还是 ORIGINAL;重启后又变回去)。
        // 克隆而不是浅拷贝:下面要改的是 `next[app][name]` 这些嵌套对象,共享引用就白改了。
        const prev = getSlotMap();
        const next = structuredClone(getSlotMap());
        for (const app of ['claude', 'codex']) {
          const patch = b[app];
          if (!zcodeConfig.isObject(patch)) continue;
          for (const [name, val] of Object.entries(patch)) {
            if (val === null) { delete next[app][name]; continue; }
            if (app === 'claude') {
              // dropTools 是**部分更新**:这一轮没带就保留已有值。写成无条件赋值会把用户
              // 在控制台改 provider/model 时的剥离规则一起抹掉——剥离静默失效,主链又拿到 Bash。
              const before = next[app][name] || {};
              // 局部变量刻意**不叫** `entry`:test/log-wiring 与 test/request-log 各有一条
              // 源码级扫描(它们不剥注释),把源码里任何"entry 点某字段 后跟赋值号"的形状
              // 当作日志条目的字段写入去和白名单比对 —— 这个变量叫 entry 会被当成越界字段。
              // (所以本段注释也不写那个形状出来,免得自己变成一条假字段。)
              const slot = { provider: val.provider, model: String(val.model || '').trim() };
              const drop = val.dropTools === undefined ? before.dropTools
                : (val.dropTools || []).map(x => String(x).trim()).filter(Boolean);
              if (drop && drop.length) slot.dropTools = drop;
              // pool / strategy 同样是部分更新语义:没带就保留,带了 [] 就清空。
              // 写成无条件赋值会把已配好的备池抹掉——用户以为备池还在,打上去 402 才发现没了。
              const pool = val.pool === undefined ? before.pool : (val.pool || []);
              if (Array.isArray(pool) && pool.length) {
                slot.pool = pool.map(x => (typeof x === 'string' ? { provider: x } : { ...x }));
              }
              const strat = val.strategy === undefined ? before.strategy : val.strategy;
              if (strat && slot.pool) slot.strategy = strat;
              next[app][name] = slot;
            } else {
              next[app][name] = { provider: val.provider };
            }
          }
        }
        setSlotMap(next);
        try { saveSlots(); }
        catch (e) { setSlotMap(prev); return sendErr(500, '写入槽位失败: ' + e.message); }
        return send(200, { ok: true, slots: slotsPublic() });
      }

      // ---- 静态文件(public/ 之内的通用资源服务,判定见上面的 staticFileFor)
      // 只读:只接 GET 与 HEAD。HEAD 走的是**同一条**校验与读盘路径,只在最后一步不发体 ——
      // 另写一条"只回头"的分支很快会和 GET 的边界长歪(HEAD 通常被用来探测存在性,
      // 一旦它比 GET 宽松,越界就算能被看见)。POST 之类一律落到末尾的 404,不在这里另回 405:
      // 控制台的写操作全是 /api/*,这个前缀下没有任何合法的非 GET 语义。
      if (p !== '/api' && !p.startsWith('/api/') && !p.startsWith('/healthz')
          && (req.method === 'GET' || req.method === 'HEAD')) {
        const hit = staticFileFor(p);
        if (hit) {
          // 每次都重新读盘,进程内**刻意不做缓存**:这一期先要的是"拆文件之后行为不变",
          // 缓存要等发布修订整体版本化之后才有可靠的失效判据;现在加缓存会让"改了 public 里的
          // 文件、刷新看不到变化"变成一个新的排查方向。静态资源是本地回环、量极小,读盘成本可接受。
          let buf = null;
          if (hit.real) { try { buf = fs.readFileSync(hit.real); } catch { buf = null; } }
          if (buf) {
            res.writeHead(200, { 'Content-Type': hit.type });
            return res.end(req.method === 'HEAD' ? undefined : buf);
          }
          // 只有根的 index.html 缺失回 500(部署坏了的既有行为,不动);其余是"资源不存在"。
          if (hit.root) { res.writeHead(500); return res.end(req.method === 'HEAD' ? undefined : 'public/index.html 缺失'); }
        }
      }
      if (req.method === 'GET' && p === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
      sendErr(404, 'not found');
    }).catch(e => { try { send(e.statusCode || 500, { error: e.message }); } catch {} });
  }

  return apiHandler;
}

module.exports = { createConsoleHandler };
