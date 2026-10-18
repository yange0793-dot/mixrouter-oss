# 第二期:代理编排等价拆分

日期:2026-10-16

状态:等价搬迁已完成并在开发副本回归通过;尚未 commit、push 或上线。

范围对应规划文档 `refactor-plan-2026-10-16.md` 的 2.2 与 5.2 的第 1、2 项。

编辑范围:`mixrouter.js` 的代理入口区与装配、新增 `lib/http/proxy.js`、`lib/proxy/{prepare,context,
attempts,attempt,response}.js`、`test/proxy-boundaries.test.js`、`test/vision-entry.test.js`、
`test/session-entry.test.js`、`test/log-wiring.test.js` 的源码级抽取锚点。本任务**不**改
`lib/routing/{sessions,session-config,strategy}.js`、`lib/session/identity.js`、`lib/http/console.js`、
`lib/codex-*.js`、`lib/toml.js`、`lib/backup/*` —— 那些由另外的执行者负责。

## 一、拆成了什么

`proxyHandler` 原来是一个 854 行的函数(基线 `mixrouter.js:769–1622`,去注释去空行后 651 行):
HTTP 入口、身份/覆盖/内容规则/槽位/候选/Key 约束、请求预算与重试、单次尝试(HTTP 调用)、
协议分发、终态结算全在一个闭包里,四件事互相递归。现在按 2.2 的边界表分开:

| 文件 | 职责 | 输入 → 输出 |
| --- | --- | --- |
| `lib/http/proxy.js` | HTTP 入口编排:三个只读出口、端点识别、读体、入口错误、建日志条目与请求上下文、启动 attempts | `req/res` → 调用方注入的 `prepareRequest` / `createRequestContext` / `runAttempts` |
| `lib/proxy/prepare.js` | 身份与会话快照、内容规则、槽位、候选池、Key 约束、识图备选初判、在途结算令牌 | 已解析的 body + 端点 → 结构化计划(含 `flight`)或结构化入口错误 |
| `lib/proxy/context.js` | 请求级时间戳与预算、真实上游调用计数、客户端/上游取消器、唯一终态 | 埋点与窄接口注入 → `RequestContext` |
| `lib/proxy/attempts.js` | 请求级预算与重试决策:总调用上限、总预算、候选游标、换 key 配额、固定 Key 截断 | `plan` + `ctx` → 决定下一个候选(或收尾) |
| `lib/proxy/attempt.js` | 单次尝试:Key 重查、健康许可(硬闸门)、出站构造、HTTP 调用、看门狗 | `loop` + `plan` + `ctx` + 游标 → 交给响应分派 |
| `lib/proxy/response.js` | 响应分派:选**已有**转换器、usage/完整性/错误/是否已提交 | attempt 句柄 → 收尾或重试建议 |

`mixrouter.js` 从基线 2021 行降到 1339 行(代理段本身从 854 行降到约 125 行装配块);
六个新文件分别为 99 / 131 / 136 / 58 / 475 / 258 行。行数只用于核对职责边界,不是验收指标
—— `attempt.js` 与 `response.js` 偏大是**有意**的:它们各自是一条连续的控制流(一次 HTTP 尝试 /
一条响应分派分支链),再切只会把"try 里的 creq / cres 闭包"和"写头前后顺序"拆散。

### 状态所有权(规划 2.2 的约束逐条兑现)

1. 只有 `runAttempts` 决定下一次尝试。`attempt.js` 只能经 `loop.retry(i)` / `loop.pinTo(i)` /
   `loop.useConvRetry()` 回到调度层,没有任何一处自己挑候选。
2. 本次尝试的 HTTP 句柄、健康许可、看门狗计时器只在 `attempt.js` 里创建与释放。
3. 只有 `context.js` 写最终日志、累加会话用量,并保证只写一次(`finish` 幂等)。
4. 协议转换器不切渠道、不读写全局配置:`response.js` 只把"可重试 + 原因"提回 `attempt`。
5. 已发出的有效客户端响应字节关闭透明重试窗口:每条分支都在**写头之前**用掉可重试窗口
   (`mayRetry: !res.headersSent && convRetriesLeft > 0`),keepalive 只在提交之后启动。

### 活配置一律现取,不是快照

`storeOf` / `slotMapOf()` / `health` / `sessionConfig` 都以函数或 getter 注入。控制台刚保存的渠道、
槽位、Key 必须对在途重试立刻生效 —— 这是拆分前的语义,不是新增行为。会话快照则在入口取一次
(`prepare` 里的 `resolved` 与 `sessionRouting`),同一条请求的重试不跟控制台中途的改动跑。

## 二、依赖方向与不新增机制

- 六个新文件都不 `require` 主入口(回归里按源码断言锁住),也不引入依赖或框架。
- 复用既有模块:读体 `lib/http/body.js`、错误体 `lib/http/proto-error.js`、攒包
  `lib/upstream/collect.js`、翻译收尾 `lib/wire-anthropic-translator.js`、`wire-chat` /
  `wire-responses` / `wire-openai-bridge`、健康 `lib/upstream-health.js`。
- 没有第二套 resolver、没有协议 IR、没有万能 context:回归里按源码断言锁住"新文件里不出现
  `createResolver` / `poolMembers` / `parseJsonBody` / `protoError` / `responsesToChat` 等实现"。

## 三、等价搬迁的核对办法

机械搬迁的判据是**旧代码逐行仍在**,不是"读起来差不多"。因此做了一次结构化比对:把基线
`proxyHandler` 的 651 行去注释后,逐行/逐 token 在新模块里找同一行;对不上的每一处都要求是
有意的、可点名的改写。结论是迁移只引入了**结构性重命名**,没有引入算法改动:

| 旧 | 新 | 说明 |
| --- | --- | --- |
| `finalize()` | `ctx.finish()` | 请求级终态,幂等标志与副作用顺序不变 |
| `netAttempts` / `deadlineHit` / `activeTimers` / `activeReq` / `activeRes` / `releaseCurrent` | `ctx` 上的取值/设置接口 | 权限收窄:attempt 只能读计数、只能设自己那一发 |
| `tryCandidate(i)` | `loop.retry(i)` | 递归改名,行为不变(含 `if (deadlineHit) return`) |
| `ordered.length = i + 1` | `loop.pinTo(i)` | 固定 Key 截断候选表,同义 |
| `convRetries` / `CONV_RETRIES` | `loop.convRetries` / `loop.convRetriesLeft` / `useConvRetry()` | 整条请求共用一个计数器的语义不变 |
| `relayInstead(status)` | `plan.vision.rewrite(status, ctx)` | 带图改写重打;`pendingRelay` 清零与定时器拆除顺序不变 |
| `buildUpstreamHeaders` / `buildOpenAiHeaders` | 同函数,移到装配块顶部 | 原位置在 `clientToken` 之后,会被 `const` 装配块 TDZ 挡住 |
| `finalize` 里的会话/日志两行 | `onFinish` → `settleSession` + `appendLog`(主入口注入) | 只搬位置,顺序不变(先累加会话、后 append 日志) |

一条与拆分同时发生的**删减**:`mixrouter.js` 里原来的 `function extractUsage` 包装变成直接在
`response.js` 里用注入的 `extractUsageFor` 分流。`extractUsage` 函数本身、`lastNum` 与
`module.exports.extractUsage` 一字未动,仍可从主入口取到。

## 四、与其它执行者的接口边界(已接线)

会话在途 guard(`captureRequest` / `settleRequest`)由另一条独立交付实现,见
`docs/changes/phase2-session-boundaries-2026-10-16.md`;**接线已由主会话完成**,落在拆分出来的
窄接口上,`lib/proxy/*` 的边界没有被突破 —— 三处都只是把"原地读写会话记录"换成"带令牌结算":

| 位置 | 现在的写法 |
| --- | --- |
| `lib/proxy/prepare.js` | deps 新增 `captureRequest`;`sessionEntryOf(...)` 之后取令牌,**随 plan 传出**(`plan.flight`)。捕获点必须在建记录之后:记录不存在时令牌 seal 为 `no-record` |
| `lib/proxy/attempt.js` | 自动落点从原地写 `sess.providerId/model/ruleId` 换成 `settleRequest(plan.flight, { binding, actual })`;`sess` 仍被读(判该不该重绑)并继续传给 `response.js`,行为面不变 |
| `lib/http/proxy.js` | `onFinish` 改成 `deps.settleSession(plan.flight, entry)`;`ident` 仍用于日志字段(`session`/`session_kind`),没有变成死变量 |

装配侧(`mixrouter.js`)注入 `sess.captureRequest` / `sess.settleRequest`,并把落盘收窄成
"只有这条结算真的改动了记录才排一次"(以前是"记录还在就排",被删的会话白排一次)。

这组接线改变了**两条**原本属于本期的已知失败:上一轮我按分工把
`test/session-flight-guard-integration.test.js` 的两条记为"预期失败、等接线",现在已转绿
(5/5)。转绿的直接原因是 guard 的结算分支按记录世代判定,而不是"最后写入者胜"。

## 五、验证

Node v24.18.0,统一入口 `scripts/run-tests.js`;全部为本地桩、临时 `MIXR_DATA_DIR`、临时端口,
不读真实 Key、不绑定 8787/8788。

| 命令 | 结果 |
| --- | --- |
| `node scripts/run-tests.js test/proxy-refactor.test.js` | 6 通过、0 失败 |
| `node scripts/run-tests.js test/proxy-refactor.test.js test/proxy-boundaries.test.js test/vision-entry.test.js test/session-entry.test.js test/health-entry.test.js test/timeout-budget.test.js test/proxy.test.js test/tool-filter.test.js` | **79 通过、0 失败** |
| 上表再加 `routing-*` / `session-*` / `compact-*` / `slots*` / `wire-*` / `codex-bridge-*` / `audit-fixes` / `body-limit` / `proxy-body` / `response-archive-proxy` / `upstream-collect` / `modules-wiring` / `health` / `log-wiring` / `request-log`(36 个文件) | **713 通过、0 失败** |
| 接线后复跑代理面(10 文件:proxy-refactor / proxy-boundaries / vision-entry / session-entry / health-entry / timeout-budget / proxy / tool-filter / log-wiring / request-log) | **134 通过、0 失败** |
| 接线后复跑会话面(7 文件:session-flight-guard / -integration / session-routing / -ui / -cli / session-config / session) | **154 通过、0 失败**(两条原预期失败已转绿) |
| 接线后复跑路由与协议面(23 文件:routing-* / modules-wiring / health / audit-fixes / codex-bridge-* / wire-* / responses-compact / compact-* / slots / body-limit / proxy-body / response-archive-proxy / upstream-collect) | **495 通过、0 失败** |
| `node scripts/run-tests.js test/log-wiring.test.js test/request-log.test.js` | 14 + 41 通过、0 失败(两处源码级抽取改动后) |
| 代理面:`response-archive-proxy` / `proxy` / `proxy-refactor` / `proxy-boundaries` / `proxy-body` / `body-limit` / `vision-entry` / `session-entry` / `log-wiring` / `health-entry` | **93 通过、0 失败** |

新增回归:

- `test/proxy-boundaries.test.js`(10 项,全部注入假依赖、不起服务)
  - 六个新文件存在、导出工厂、不反向 `require` 主入口、不夹带 worktree/node_modules;
  - 新文件里没有第二套 resolver / 读体 / 错误体 / 转换器实现;
  - 请求上下文:预算 = 总预算 + 按体积放宽(封顶 10 分钟)、上限 = 候选数 + 换 key 重试 + 带图重打 1;
  - 请求上下文:`finish` 幂等、真实调用计数只加不减;
  - 请求上下文:取消中性收尾(只释放一次许可、不把取消算成渠道失败、499/cancelled);
  - 请求上下文:响应正常写完时 close 不覆盖终态;keepalive 只在提交后启动、收尾即停;
  - attempt 调度:总调用上限是硬闸门(打满后不再发起尝试、只结算一条 too_many_attempts);
  - attempt 调度:总预算用尽后不再打上游;候选游标 / 固定 Key 截断 / 换 key 配额都在调度层。
- `test/vision-entry.test.js`(1 项,真实入口):带图请求被上游 4xx 拒绝 → 图片落盘、原位换成指路
  文本、**原地重打一次**;429 不参与带图改写重打(限流与载荷无关),也不落盘新图。
- `test/session-entry.test.js`(2 项,真实入口):两条带会话头的对话各自粘性、槽位请求不改主对话
  绑定;在途请求用入口快照,同渠道重试不因控制台中途改路由而换渠道。
- `test/log-wiring.test.js` 的两条**源码级**用例:抽取锚点从"只读 `mixrouter.js`"改成读代理源码集
  (主入口 + 六个新文件)。不改这两条,`const entry = {` 的构造点搬走会让它们以"锚点失效"报红——
  看起来像失败,其实两条断言都没跑。断言面(越界字段、死字段)未放宽。
- `test/request-log.test.js` 的「白名单与 entry 字段实际集合双向相等」:**同一处锚点的第二种写法**。
  它把"字面量键"和"`entry.<f>` 赋值"分开扫(与 log-wiring 的合并扫法不同),两处都要跟着搬,
  否则要么以"找不到 entry 对象字面量"报红,要么**扫不全而静默放过**从新文件里新挂上去的字段
  (白名单漏字段 = 该字段被 `pick()` 静默丢弃)。断言面未放宽,`LOG_FIELDS.length === 30` 的硬钉子仍在。

### 未测与已知边界

- 本文自身只跑了定向回归;全套与离线 smoke 由主会话在集成完成后的轮次运行(结果见
  `docs/changes/phase2-implementation-2026-10-16.md`)。Node 18/22、真实付费上游、WKWebView、
  在线切换与回退均未验证。
- `mixrouter.js:1202` 附近(基线)的 `transport.request` 同步抛路径、`count_tokens` 本地估算、
  总调用上限这些分支在既有回归里有覆盖;但**带图改写重打与转换线同渠道重试的组合**
  (一次请求内既改写又换 cache 代际)没有专门用例。
- `test/session-flight-guard-integration.test.js` 的两条用例在接线前是**预期失败**,现已转绿
  (5/5);转绿依赖会话侧 guard 的按代判定,不是本拆分单独能给出的结论。

### 本期已修:手动钉定在回退后会被在途响应改写(成因先于第二期)

复核接线时发现的一条缺口,**本期已修**(实现与用例都在会话侧:
`lib/routing/sessions.js` 的 `settleRequest` 与
`test/session-flight-guard-integration.test.js` 的「钉定渠道不可用时,在途响应不改写钉定,
actual 如实记新落点」;契约依据见 `docs/changes/phase2-implementation-2026-10-16.md`)。

**成因先于第二期,缺口本身却是本期修掉的** —— 这两件事都要说清,否则读的人会误以为还挂着:

- 触发:用户钉定渠道 X → X 一次失败(5xx/429,进入冷却或熔断)→ 本条请求回退到池里的 Y
  并成功 → 自动落点**无条件写回** `providerId=Y`,而 `pinned` 仍为 true。
- 后果不是"这一条被改写",是**永久失效**:`resolveTarget` 的钉定分支读的是 `bound.providerId`
  (现在是 Y 且可用),所以 X 恢复后后续请求仍粘 Y,界面还显示"已钉定"。用户钉的 X 再也回不来。
- 实测(临时副本,单次真实 500,本机临时端口):钉 a → a 返回一次 500 → 客户端拿到 **200**
  (回退 b)→ 记录 `providerId=b, pinned=true` → 下一轮一切正常时仍落 b。用户钉的 a 丢失。
  **用户无感**是这条最值钱的地方:他得到一次成功响应,除非去翻控制台否则不可能发现。
- 根因在判据,不在守卫强度:`bindingsWritten` 没有该记录时基准取的是入口快照 `token.sig`,
  而"钉定后、此后没被任何结算写过"时该快照恰好等于用户改后的值 → 签名比较相等 → 判为"没人手改"。
- 修法:`s.pinned` 时直接 `binding_blocked`,不看签名。**不能**改成"没有写入记录就一律拦"——
  那会让全新记录的第一条请求永远写不进落点(临时副本实测 5 条红)。
- 为什么算本期契约而不是新增产品决策:规划 5.2.4 写的是"只允许更新仍属于相同有效记录的统计
  **或自动绑定**"——手动钉定不是自动绑定;5.2.5 与本期已定的 `explicitConfig = pinned || hasRouting`
  又要求显式设置不被静默丢弃。两条合起来,拦住它是本期**该有**的行为,不是可选的加强。
- 本拆分自身的贡献是零:基线 `mixrouter.js:1240` 的写回条件与现在逐字相同
  (`statusCode<400 && !content && !slot && (sess.providerId !== provider.id || entry.failover)`),
  基线 `resolveTarget` 的钉定分支同样在渠道不可用时 fall-through 到池;接线只是把同一个无条件
  写回搬到了 `settleRequest(flight, { binding })`。

**关于验证数字的取信范围(本节修订一处)**:上面"临时副本实测 5 条红"与本节早期版本里出现的
"试验副本全套 1387/0"都只是**方向探针**,在临时副本上跑,**不作为本期结论引用**。证据以开发副本
复跑为准:工作树 mtime 快照跑前跑后同哈希(`TREE STABLE during run`),全套 89 文件
**1388 通过 / 0 失败**,离线 smoke **18/18**。
