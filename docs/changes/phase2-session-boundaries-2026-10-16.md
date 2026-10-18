# 第二期:会话与池状态边界 + 在途请求 guard

日期:2026-10-16

状态:核心 guard 与池边界已实施并回归通过;**代理装配的接线尚未完成**(见「待接线」一节),
两条集成验收用例现在是预期失败。尚未 commit、push 或上线。

范围对应规划文档 `refactor-plan-2026-10-16.md` 的 3.1 与 5.2 的第 3、4、5、7 项。
编辑范围:`lib/routing/{sessions,session-config,pool-state}.js`、`lib/http/console.js` 的会话 API、
`test/session*.test.js`。本任务**不**改 `mixrouter.js`、`lib/http/proxy.js`、`lib/proxy/*`。

## 一、池运行状态与会话记录分开

新增 `lib/routing/pool-state.js`:轮转游标(含加权轮的 `__w_<ruleId>` 余量)与渠道冷却表搬过去。
它不认识会话、不落盘——游标与冷却是进程内的瞬时状态,重启即归零;绑定表落盘是因为它代表
"这个对话走这里"的决定。

`lib/routing/sessions.js` 通过 getter/setter 保留全部旧引用语义,调用点一字未改:

| 旧引用 | 现在 | 说明 |
| --- | --- | --- |
| `sess.sessions` / setter | 不变 | 仍是 Map;setter 仍拒收非 Map |
| `sess.pools` | 转发到 pool-state 的 getter | `resetPools()` 会整份换对象,必须是 getter |
| `sess.cooldowns` / setter | 转发到 pool-state | 传非对象退化成空表,不抛(旧调用点就是这个语义) |
| `sess.resetPools()` / `markCooldown` / `inCooldown` | 不变 | 签名与行为一致 |
| `sess.activeCount(id)` | 不变 | 口径仍是"绑定到该渠道的会话条数",不是实时负载(规划 3.1 要求不升级语义) |

策略枚举(`round_robin` / `weighted` / `least_used` / `random` / `priority`)与
`lib/routing/strategy.js` 一字未动,文件格式(`{version:1, bindings:{...}}`)未变。
机械搬迁没有夹带语义变更,唯一的语义改动列在下面第三节。

## 二、在途请求 guard(窄接口)

`lib/routing/sessions.js` 新增两个入口:

```js
const token = sess.captureRequest(key);
const r = sess.settleRequest(token, {
  usage:   { in, out },                                   // 累加 reqs/inTok/outTok + 刷 lastUsed
  binding: { providerId, model, ruleId },                 // 受保护的自动落点绑定
  actual:  { providerId, model, ruleId, slot, sticky, status, in, out, ms },  // 最近一次真实落点
});
// r = { ok, applied:{usage,binding,actual}, reason, binding_blocked }
//   reason:          '' | 'no-record' | 'removed' | 'replaced'
//   binding_blocked: '' | 'binding-changed'
```

判定依据是**记录世代**(记录第一次被捕获时领一个递增序号,记在 WeakMap 里,不写进记录对象),
不是"最后写入者胜":

- 记录不存在 → 令牌 seal 为 `no-record`,结算什么都不写(请求不替一条并不存在的记录建档);
- 该键下已经是另一条记录(删掉后又新建)→ `replaced`,什么都不写;
- 同一条记录,但期间手动改过绑定(`providerId`/`model`/`ruleId`/`pinned` 签名变了)
  → **usage 与 actual 照记,binding 不写**。统计与"最近实际落点"描述的是这条会话真实发生过的事,
  碰不到任何用户配置;
- 同一代的并发请求各持各的令牌(令牌是只读快照),彼此不会作废。

> **接线时的修订(主会话,已改代码与断言)**:初版还按 `(s.routing||null) !== token.routing`
> 拦一道 `config-changed`,即"响应回来前保存过一次 Key/槽位覆盖 → 在途响应不写自动绑定"。
> 这条与本节自己的验收用例矛盾(「在途请求跨过覆盖保存」断言 `providerId === landed`,接线后报红),
> 判据本身也不成立:存覆盖不改变"这个对话该走哪个渠道",且保存覆盖是整条换对象、`carryMark`
> 已把世代交过来,同一条记录认得出。实测它确实误伤——跨过保存那一刻仍在途的请求,响应回来
> 写不进那条本该记下的绑定(粘性静默失效;保存**之后**新发的请求不受影响)。
> 已删除该分支与令牌里的 `routing` 字段(留着不读会让人以为它在生效)。手动钉定的保护未削弱:
> 实测仍报 `binding-changed`、绑定保得住、统计与实际落点照记。

> **后续修订(session-boundaries 侧,已改代码与用例)**:删除 `config-changed` 之后,
> `binding-changed` 的判据本身还有一个同源缺陷——它拿**入口快照的 `bindingSig`** 当基准,
> 而这几个字段**自动落点也写**,所以同一条记录的另一条同代请求先落账(失败转移换渠道)就会
> 把签名改掉,后回来的那条被误判成"用户手改"、丢掉自己本该记下的落点。
> 触发条件:同一会话两条请求真的并发且都成功;与"是否跨过保存/钉定"无关,**不需要任何用户操作**
> (`test/session-flight-guard.test.js` 的「同代并发:先回来的那条落点不把后回来的那条误判成"用户手改"」正是这一条)。
> 修法:判"手改"的基准分两种——记录**自从捕获以来还没被任何结算写过**时用入口快照 `sig`(此时
> 快照仍然有效,一次手改也不会漏),已经被写过时用"我们上次写进去的值"。基准存在 WeakMap 里,
> 不写进记录、不落盘。
>
> **同一处的第三个缺口(已修,主会话指出)**:基准存在对象上的 WeakMap 里,而控制台三扇门是
> **整条换对象**——`carryMark` 当时只交了世代(`marks`),没交 `bindingsWritten`。于是"R1 已落账、
> R2 仍在途、期间用户只保存了一次覆盖(没碰绑定)"这个交错里,R2 的基准退回入口快照、当前值已
> 被 R1 改过 → 被判成"用户手改"、丢掉落点。修法:`carryMark` 一并交 `bindingsWritten`;
> 不采纳"在 captureRequest 里播基线"的替代方案——那会让真手改漏过一次(捕获发生在记录被改写之后,
> 播下去的基线正好等于用户改过的值)。用例:「保存覆盖(整条换对象)后,同代在途请求的落点照记;真手改仍拦得住」。
>
> **第四个缺口(已修,主会话定语义)**:钉定记录此前**会被自动落点回写**——`settleRequest` 的
> 签名比较只管"值有没有被手改",管不到"这条记录是钉定的":钉定渠道一次冷却/5xx 就足以让请求
> 回退到别的渠道并把 binding 写回,记录变成 `providerId=回退渠道, pinned=true`,而
> `resolveTarget` 的钉定分支读的正是 `bound.providerId`,于是**用户钉的渠道再也回不来,界面还显示
> "已钉定"**(实测复现，非推演)。修法:签名比较**之前**加一支 `if (s.pinned) → binding_blocked`
> 直接返回(`binding_blocked` 取值不变,不新增枚举)。语义依据:钉定是显式配置,不是自动绑定,
> 规划 5.2.4 只允许更新"统计**或自动绑定**",把自动落点写回钉定就已经越界;5.2.5 与
> `explicitConfig = pinned || hasRouting` 也要求显式设置不被静默丢弃。
> `actual` 照记,所以"最近实际落到哪"仍然看得到(三层状态不丢信息)。
> 用例:`test/session-flight-guard-integration.test.js`「钉定渠道不可用时,在途响应不改写钉定,actual 如实记新落点」
> —— **两头都钉**:钉定值保住 + `actual` 是真实新落点(只钉一头的话,以后有人"顺手"把 actual
> 也拦了不会报红)。修后模块级探针:钉定 X → X 不可用 → 落 Y,记录保持 `{providerId:X, pinned:true}`,
> X 恢复后下一条回 X。
>
> **仍然存在、没有修的窗口**(说清楚,不假装它拦得住每一种交错):判定用的是**当前值**而非版本号,
> 所以"A 结算写 binding(t1) → 用户立即手改(t2) → B 结算(t3)"这一交错里,B 看到的是用户改过的
> 当前状态,会照常把绑定写回去。要彻底关掉需要"写入者版本 + 用户改动版本"的乐观并发
> (与保存覆盖的 `expected_revision` 同形),那是一次接口扩展,不在本期范围。

世代记在 WeakMap 而不是记录字段上,有两个实打实的原因:记录对象会写进 `sessions.json`,
也会被 `/api/state` 与测试的整表替换(含 `Object.freeze` 的夹具)拿到——往记录上挂字段会改到
落盘形状,还会在冻结对象上直接抛;而"删掉后再建一条"本来就是另一个对象,自然拿到新世代号。

配套:`carryMark(from, key)`。控制台的三扇门(保存覆盖 / 钉定 / 解绑)都是**整条换掉**记录对象
(`console.js` 的 `mutateSessions` 注释:原地改会让落盘失败时的回滚退不回原对象)。换对象之后,
在途响应拿的还是旧对象,只比对象身份会把"用户改配置"误判成"记录已删后重建",于是这条请求的
统计被整条丢掉。三扇门在 `set` 之后各调一次 `carryMark(旧记录, key)` 把世代交给新记录;
"删掉后重新建档"不走这条路径,所以仍然换新代。

### 待接线(主会话负责)—— **已完成**

本任务不编辑代理文件,接线点与等价替换关系已发 main,三处(主会话已按实际符号面接完,
见 [第二期集成记录](phase2-implementation-2026-10-16.md) 的「接线」一节):

1. `sessionEntry(...)` **之后**新增 `const flight = captureRequest(ident.key)`(实际落在
   `lib/proxy/prepare.js`,令牌随计划传出;必须在 entry 之后:记录不存在时令牌 seal 为 no-record)。
2. 响应头落定处的自动绑定:原地写 `sess.providerId/model/ruleId` 换成
   `settleRequest(flight, { binding, actual })`(实际落在 `lib/proxy/attempt.js`)。**这正是复活/
   覆盖的根因**:旧代码不检查这条记录期间有没有被手动钉定或重存,响应回来就无条件写回。
3. 终态 `finalize`/`onFinish`:整段 `currentSession.reqs/inTok/outTok/lastUsed` 换成
   `settleRequest(flight, { usage })`(实际落在 `mixrouter.js` 的 `settleSession`,令牌由
   `lib/http/proxy.js` 的 `onFinish` 从计划里带出)。重复累加由既有 `finalized` 幂等标志负责。

`test/session-flight-guard-integration.test.js` 的两条红用例(「在途请求跨过手动重绑」
「在途请求跨过覆盖保存」)已随接线转绿;**接线后该文件 5/5、与本任务模块用例合计 14/14**。

## 三、语义与兼容差异

1. **手动钉定(手动配置)不再被 TTL 回收。** 以前 `prune` 只按 `hasRouting` 豁免,而手动钉定
   写的是 `pinned` + `providerId`、没有 `routing`,于是一条钉定的对话闲置 12 小时会被静默丢掉——
   正是 5.2.5 要防的"手动配置被 TTL 静默丢弃"。现在判据统一为 `explicitConfig` =
   `pinned || hasRouting`,会话侧(`sessions.js` 的 `prune` / `configuredCount` / 列表)与诊断预览
   (`explain.js` 的会话快照模拟)共用 `lib/routing/session-config.js` 里的同一个函数——
   两处口径必须一致,否则"预览说这条会被回收、实跑却不回收"。
   影响面:长跑实例里常驻的钉定会话会留在会话表内,但没有"无界"风险——表上限(`MIXR_SESSION_MAX`)
   本身就把显式配置一起夹住(推导与实测见 3.1 节更正版:钉定与覆盖都不会超过表上限)。
   受影响的既有断言两处,均已按新契约改写(未删断言、未改阈值):
   - `test/routing-diagnostics-evidence.test.js`「已过 TTL 的绑定不会被当作粘性」——原夹具用
     `pinned:true` 造过期条目,现改为自动绑定;另加一条「已过 TTL 的手动钉定不再被回收」,
     仍走它原有的"预览 vs 实跑"对照。
   - `test/routing-preview-api.test.js` 的 `stale` 夹具同步改为自动绑定。
2. **低可信身份不能新建持久覆盖。** `fp:` / `cxf:` / `anon` / `cx-anon` 走
   `assertRoutingConfigurable`:`PUT /api/sessions/:key/routing` 在**新建**覆盖时返回 400 并说明
   原因是身份不可靠、应让客户端带上会话 ID 头。存量覆盖(该键上已经有 routing)照读、照导出、
   照编辑、照清空,不静默删除、不转绑。判定只挂在 PUT 这一扇门上,读取与列表不受影响。
   三期的控制台若要加写入口,需要把这条拒绝理由呈现出来。
3. **列表新增结构化三层。** `GET /api/sessions` 每行新增
   `configured` / `required`(routing + revision + keys/slots 计数)/ `bound`(provider/model/rule/pinned/source)
   / `actual` / `actual_source` / `actual_text`。没有真实请求记录时 `actual` 为 `null`、
   `actual_text` 是「暂无」——**不用路由预览冒充实际落点**。旧字段
   (`provider`/`provider_name`/`model`/`rule`/`reqs`/`inTok`/`outTok`/`pinned`/`cooldown`/`routing`/`routing_revision`)
   逐字保留供旧控制台过渡。`PUT/GET /api/sessions/:key/routing` 的响应形状**未变**
   (仍只有 `ok`/`routing`/`revision`),旧的逐字段对照回归靠这一点。
4. 新增 `actual` 只存标识与计数:`providerId`(渠道 ID,不是 Key)、`model`、`ruleId`、`slot`、
   `sticky`、`status`、`in`/`out`/`ms`/`ts`。不记请求正文,不记任何 Key 明文(覆盖里只有 Key ID,
   与既有约定一致)。

### 3.1 的配套事实:钉定怎么清、钉定有没有上限

**清除钉定的路径只有两条**(都已核对到实现):

| 操作 | 效果 | 位置 |
| --- | --- | --- |
| 控制台会话行的渠道下拉选「不钉定(按策略)」 | `POST /api/sessions/:key/pin` 带空 provider → `pinned=false`、`providerId=''`,记录与 Key/槽位覆盖**都还在**,下一次请求按策略重新分配 | `lib/http/console.js:619`;UI `public/index.html` 的 `pinSession` |
| 控制台「解绑」/ `DELETE /api/sessions/:key` | 整条记录删除,连同该会话的 Key/槽位覆盖一并删除 | `lib/http/console.js:633` |

`mixctl sessions reset` 只清 Key/槽位覆盖(`routing.keys/slots`),**不动 `pinned`**
(`lib/cli/sessions.js` 的 `mutate`)。清空整表是 `DELETE /api/sessions`。

**钉定的容量事实(实测,不是推断)** —— ⚠ **本节初版结论已被主会话复核推翻,以下为更正后的版本**:

- `pinned` 从第二期起算显式配置,而 `assertRoutingCapacity` 只在保存**覆盖**时调用
  (`lib/http/console.js:582`),钉定走的是另一扇门。**但这不等于钉定无界增长。**
- 初版写的"`max=3` 的 store 里连写 20 条钉定、`prune()` 一条都不回收、`sessions.size = 20`"
  **是在插入期间从不调用 `prune` 的测法**,与在线节奏不符。在线按实际调用顺序复测:
  `resolveTarget`(每条代理请求)与 `/api/sessions`(控制台每次刷新)都在**建记录之前**
  先 `prune()`,而在线装配不传 `maxConfigured` ⇒ `limit = max` —— 表上限与"显式配置上限"
  是同一个数、同一条淘汰规则。
- 实测(`max=3`,每轮照在线节奏 prune):钉定数稳定在 **3**;第 4 条起,新记录在建档前就被
  容量淘汰,`pin` 拿到的是 **404「会话不存在(可能已过期)」**而不是 400。**结论:在线不存在
  钉定无界增长**,`MIXR_SESSION_MAX` 换代后约 1.2 天轮空一次,正常使用(实测 14 条、TTL 12h)不会触到。
- 钉定确实**占用**覆盖容量:`maxConfigured=2` 且已有 20 条钉定时,保存一条**新覆盖**会被拒
  (`400 已配置会话数量达到上限…`)。在线两值同源,所以这条只对有显式设 `maxConfigured` 的装配有意义。
- 症状可发现、不静默:控制台会话页有「手动钉定 N」计数并按 `lastUsed` 倒序列出全部会话。

**按"钉定该与覆盖共用闸门"加过一版 `assertPinCapacity`,实跑证明是死代码,已撤除**:
要触发它需「`configuredCount >= max`」且「目标记录仍在表里」同时成立,而在 `limit = max` 下
后者会先被 `prune` 淘汰,永远拿不到 400;它只在有人显式设置 `maxConfigured < max` 时才有意义,
而在线装配没有这样设。所以它既不是"该修未修",也不该留在代码里当摆设(零频率路径不加机制)。

**当前处置**:不改代码 —— 表上限本身已经把显式配置夹住了,再加一条闸门只是把同样的拒绝
从 404 换成 400,没有增加任何保护。

### 3.2 改动清单(含所有动到既有断言/夹具的位置)

新增:`lib/routing/pool-state.js`、`test/session-flight-guard.test.js`、
`test/session-flight-guard-integration.test.js`、本文件。

修改的实现文件(全部在本任务授权范围内):
`lib/routing/sessions.js`、`lib/routing/session-config.js`、`lib/http/console.js`。

`lib/routing/explain.js` 我**只改了会话快照/剪枝这一处**(`hasRouting` → 显式配置
`explicitConfig`,两处循环 + 一处 import);同文件里"钉定预览改用健康许可预检
`eligibleById`"那段是**第一期第二组改动**留下的,不是本轮。

动到既有断言/夹具的位置,逐条列出:

| 文件 / 用例 | 改了什么 | 为什么必须改 | 覆盖点变化 |
| --- | --- | --- | --- |
| `test/routing-diagnostics-evidence.test.js`「已过 TTL 的绑定不会被当作粘性,原表在预览后保留」 | 夹具从 `pinned: true` 改为自动绑定(去掉 pinned);用例名加"**自动**" | 原夹具用钉定表示"已过期",依赖了旧语义(钉定记录没有 routing,会被 TTL 剪掉);新语义下钉定本来就该留下,用例本意不再成立 | 只覆盖自动绑定的 TTL 回收;新增下面那条补回钉定一侧 |
| `test/routing-diagnostics-evidence.test.js`「已过 TTL 的**手动钉定**不再被 TTL 回收,预览与实跑都继续粘它」(新增) | 新增用例 | 补上被上一条移走的覆盖面 | 新增:钉定 + 过 TTL → 预览与实跑都继续粘它 |
| `test/routing-preview-api.test.js`「preview API 注入真实 sessionSnapshot,不剪枝、不 touch、不写盘、不发上游」 | 过期夹具 `stale` 从 `pinned: true` 改为自动绑定;`live` 那条**保留** `pinned` | 同上:用钉定表示过期会变成"它本来就该留下",断言会红 | 不变(仍是"过期的不粘、在册的不被剪枝、预览无副作用");`live` 的钉定覆盖仍保留 |

没有删除任何断言,没有调整任何阈值。两份文件的最终断言条数与改动前一致(一条改名 + 一条新增、
一条夹具字段调整)。测试新增/改名之外,未改动 `test/` 下其它文件。

## 四、验证

Node v24.18.0,统一入口 `scripts/run-tests.js`,全部为本地桩/编译期假 Key/临时数据目录与临时端口。

| 命令 | 结果 |
| --- | --- |
| `node scripts/run-tests.js test/session-flight-guard.test.js` | **11 通过、0 失败** |
| `node scripts/run-tests.js test/session-flight-guard-integration.test.js` | **6 通过、0 失败**(接线后转绿,见下) |
| 会话/池/预览/诊断/控制台/入口面 14 个文件一轮(接线后):`session-flight-guard`、`session-flight-guard-integration`、`session`、`session-routing`、`session-routing-ui`、`session-routing-cli`、`console-module`、`session-config`、`routing-modules`、`routing-preview`、`routing-preview-api`、`routing-preview-q3`、`routing-diagnostics-evidence`、`session-entry` | **319 通过、0 失败** |
| 代理与相邻面 11 个文件一轮(接线后):`proxy-refactor`、`proxy-boundaries`、`proxy`、`mixctl`、`audit-fixes`、`health`、`health-entry`、`backup-pool-watch`、`compact-keys`、`timeout-budget`、`wire-responses` | **216 通过、0 失败** |

新增 `test/session-flight-guard.test.js` 覆盖:

- 池状态与会话记录分开:`sess.sessions`/`pools`/`cooldowns` 三个视图各归各的,写冷却表不长会话,
  `resetPools()` 后 getter 现取新对象;
- 模块级 guard:同代并发两条各自累加且互不作废、删除不复活、删除后重建(新代)旧令牌不认、
  清空整表后结算不凭空建回;
- 真实入口:一条在途请求跨过该会话的 `DELETE`,响应回来不得复活记录,同一模板下**另一条**
  在途请求的统计照旧;
- 三层状态:无真实请求记录时 `actual_text === '暂无'`,结算后三层齐备且绑定与实际分开;
- 低可信身份只拦新建,存量覆盖可读、可编辑、可清空;
- TTL 与容量只回收自动绑定,钉定与覆盖留下;
- 控制台三扇门整条换记录对象之后,在途响应的统计仍落在同一条会话上(`carryMark`),
  而手动钉定仍不被在途响应改回去;
- 同代并发的两条各自落账(先回来的那条不把后回来的误判成"用户手改"),而真正的手改仍被拦住;
- 保存覆盖(整条换对象 + `carryMark`)之后,同代在途请求的落点照记,换对象之后的手改仍拦得住;
- 钉定记录一律不被自动落点回写(模块级),入口级同一条走真实代理,并同时断言 `actual` 记真实新落点。

接线状态:主会话已按窄接口接线(捕获在 `lib/proxy/prepare.js` 的 `sessionEntryOf(...)` 之后、
落点在 `lib/proxy/attempt.js` 的响应头处、收尾在 `lib/http/proxy.js` 的 `onFinish` → `mixrouter.js`
的 `settleSession`),集成验收文件因此由 3/2 转为 **5/0**。接线后的 `binding` 提交条件与原实现逐字
等价(`statusCode<400 && !content && !slot && (落点变了||failover)`),`actual` 每次成功响应都记。

钉定语义那条的验收集(mtime 快照确认 TREE STABLE during run,排除了"读到编辑中的文件"这类假红):
`session-flight-guard` + `-integration` + `session-entry` + `session-routing*` + `session-config` +
`routing-diagnostics-evidence` + `routing-preview*` 共 12 文件,**270 通过、0 失败**。

未测(如实记录):Node 18/22、真实付费上游、桌面外壳(WKWebView)、第二期其余任务
(TOML 单一实现);以及 3.1 节记录的"钉定无容量上限"与上文"结算交错的残留窗口"——两者都是
已知未修项,不是已修但未验证。
