# mixrouter 第二期集成记录

日期：2026-10-16

状态：实施中；三个独立任务已派发，尚未形成第二期集成候选。

## 基线与边界

- 开发目录：`<开发副本根>`，普通独立 clone。
- 当前分支：`refactor/phase1-reliability`；尚未 commit 或 push，不为第二期开工擅自提交第一期。
- 第一期同版证据：Node v24.18.0，全套 1334 通过、0 失败；离线 smoke 18/18 通过。详见 [第一期实施记录](phase1-implementation-2026-10-16.md)。
- 在线 `mixrouter-src`、运行数据、Key、客户端配置、LaunchAgent 与在线进程不在修改范围。
- 不创建或操作 worktree；开发/测试权限拒绝立即报告，不使用脚本或其他代理绕过。
- 保留全部核心及配套功能、零运行时依赖、Node ≥18、现有配置格式和路由优先级。

## 独立产出与编辑所有权

| 任务 | 范围 | 集成边界 |
| --- | --- | --- |
| 代理编排拆分 | `mixrouter.js` 代理入口及装配、新增 `lib/http/proxy.js` 和 `lib/proxy/*.js`、对应代理回归 | 先等价拆分，保留第一期健康/计数/终态/取消契约；不编辑会话或 TOML 实现 |
| 会话状态与在途保护 | 会话/池运行模块、会话 API、相关会话回归 | 提供请求 generation 捕获与受保护结算接口；主会话在代理装配处接线 |
| TOML 单一实现 | `codex-config`、旧 TOML 薄适配、备份恢复调用及相关回归 | 保留旧函数签名与安全拒绝边界；不修改代理或会话文件 |

主会话负责接口协调、整合以及必要的集成验证，不固定派审查/终审代理，也不重复执行独立任务。

## 验证约定

- 各任务只跑受影响回归，统一通过 `scripts/run-tests.js` 隔离入口；只用本地桩、假 Key、临时 HOME/配置与临时端口。
- 已有同版第一期结果复用，不因续会话或补记录重复跑全套。
- 第二期形成集成候选后，再执行必要的组合回归、全套和离线 smoke；结果与未测范围如实记录。
- 在途请求的会话保护需入口与 API 的延迟响应组合验证，模块测试不能替代接线证据。
- 未运行的 Node 版本、真实付费上游、浏览器/WKWebView 和安装上线不记作已验证。

## 顺带修复：Responses 工具 schema 必须显式 strict:false

独立于原计划、但由本轮实测暴露并已修的一处协议缺陷：

- 现象：本机主链（`mixr-main`，`rule: slot:claude/main`，provider AgentRouter，`wire: responses`）上，客户端工具调用的**可选参数从未被省略**——本该由模型自行决定省不省的字段每次都被填上（含 `isolation`、以及已废弃的 `mode`/`team_name`）。
- 定位：`anthropicToResponses` 转换工具定义时只输出 `type/name/description/parameters`，**没有 `strict` 字段**。官方 function calling 文档的 strict mode 一节写明：Responses 请求省略 `strict` 时会尝试把 schema 规范化成严格模式，而严格模式要求 `properties` 里每个键都出现在 `required` 里，无法满足才回退非严格。本地复现确认转换结果里 `strict_field_present: false`，`required` 仍是客户端原始三条。
- 旧防护为何无效：`lib/tool-input-prune.js` 只删**空占位**（`""`、`null`、`[]`、`{}`、全空对象），删不掉非空字符串，所以"上游把可选参数变必填"这类噪声穿过了它。
- 修复：`lib/wire-responses.js` 的工具映射**显式写 `strict: false`**（原生 Codex 通路本来就带 `strict:false`），`parameters` 原样上送、不自行增删 `required`。chat 线路按官方默认即为非严格，未改动。
- 回归：`test/wire-responses.test.js` 新增「工具显式 strict:false,可选参数不得被上游当成必填」，同时钉住有 `input_schema` 与无 `input_schema` 两条分支。
- 受影响范围回归：Node v24.18.0，`wire-responses`、`wire-responses-stream`、`codex`、`codex-bridge-modern`、`codex-bridge-entry`、`tool-input-prune` 六文件 **107 通过、0 失败**。
- 未做：未改运行中的服务，未重新发出真实上游请求验证线上行为；旧会话仍带着已填满的参数历史。此项属于代码修复，按 6.1 的窗口流程上线。

## TOML 单一实现（已完成）

`lib/codex-config.js` 现在是唯一的 TOML 解析/改写实现；`lib/toml.js`、`lib/codex-toml.js` 退化为纯别名壳（无 `function`/箭头定义、无正则或逐行处理），全树只剩一份 `parse`/`patch`/`removeOwnSections`/`setTopLevel`/`providerSection`。兼容导出断言的是**函数同一性**（`tomlStr === config.quote`、`codexTopLevel === config.topLevel`），不只是行为一致——否则日后把算法抄回来测试仍会全绿。

- 受影响回归：Node v24.18.0，15 个文件 **239 通过、0 失败**。
- 还原路径的安全边界与解析器能力**相互独立**：新解析器能读数组、内联表、多行字符串、日期、`0x`、前导零、点分键、数组表，而 `lib/backup/restore.js` 的 `validateToml` 仍把它们一律判 `unsupported_toml` 拒绝；回归带反证，不会因为"一律拒绝"而假通过。
- 两处有意收窄（属修真实缺陷）：重复顶层键由"取第一条"改为明确拒绝；`tomlStr` 由只转 `\`/`"` 改为走 `JSON.stringify`（旧实现遇换行会写出非法 TOML）。
- 第三处缺陷（本轮追加修复）：TOML 1.0 要求 U+007F（DEL）必须转义，而 JSON 原样输出。不修的话写入侧会吐出含裸 DEL 的文本，而还原侧 `validateToml` 按 TOML 规则拒绝它——**自己写出去的备份过不了自己的校验**。现已补 `\u007f` 转义。
- 主会话独立复核（在开发副本直接调用，非转述）：
  - 现网 `~/.codex/config.toml` 顶层 8 键**无重复**、未启用 profile，因此重复键收紧不会打到当前真实配置。
  - 重复键时 `read()` 抛 400 且**点出具体键名**（`Codex TOML 存在重复键 model`）；只读的 `state()`（`/api/state` 所用）**不抛错**，读路径照旧降级——写入拒绝与只读降级的分界符合预期。
  - DEL 复核：`quote("a\u007fb")` 输出 `"a\u007fb"`，**不含裸 DEL**、可原值读回；U+0000–U+001F 全部已转义。还原侧对写出的文本不报错，对裸 DEL 仍判 `control character` 拒绝——自相矛盾已消除，且**还原的保守边界没有被放宽**。
  - `quote(null)/quote(undefined)/quote('')===""`、`quote(0)==="0"`、`quote(42)==="42"`、`quote(false)==="false"`，中文与 emoji 原样保留不拆成 `\uXXXX`；既有断言仍成立。
- 证据：15 个受影响文件 Node v24.18.0 **243 通过、0 失败**（含本轮新增 4 条）。
- 未做：未跑全套/smoke（留待集成后统一执行），未改 `mixrouter.js` 装配面（该文件正由代理拆分重写，三处待办见下）。


## 待主会话处理的装配项（等代理拆分落地后统一改）

已办（主会话在集成时执行）：

1. `mixrouter.js` 中 `const codexToml = require('./lib/codex-toml');` 是死引用（全树无成员访问），已删除。
2. 同文件两处注释仍写「与 `lib/toml.js` + `lib/codex-toml.js` 是同一件事的两套实现」，已改为「旧名字只是 `codex-config` 的薄适配」。
3. `lib/codex-toml.js` 的 `buildCodexConfig` 与 `MIXR_SECTION_RE` **保留**（不收窄）：`test/codex-toml.test.js` 按名字断言别名同一性，删掉等于顺手改导出面；它们本身是别名，不构成第二份算法。此项不改。

## 接线：会话在途 guard 进入代理（主会话完成）

按 [会话边界记录](phase2-session-boundaries-2026-10-16.md) 的接口，三处全部接上（改的是 proxy-split 交付的文件，改前已与其对齐）：

| 点 | 落点 | 改法 |
| --- | --- | --- |
| 捕获 | `lib/proxy/prepare.js` 的 `sessionEntryOf(...)` **之后** | 新增 `flight = captureRequestOf(ident.key)`，随计划传出；`createPreparer` 新增注入 `captureRequest`。必须在 entry 之后：记录不存在时令牌 seal 为 no-record |
| 落点结算 | `lib/proxy/attempt.js` 响应头落定处 | 原地写 `sess.providerId/model/ruleId` 换成 `settleRequest(plan.flight, { binding, actual })`；`createAttempt` 新增注入 `settleRequest`。`binding` 只在原来的 `rebind` 条件成立时提交 |
| 收尾结算 | `lib/http/proxy.js` 的 `onFinish` → `mixrouter.js` 的 `settleSession` | 入口把 `plan.flight` 传给 `settleSession`（原来传 `ident.key`），主入口改调 `settleRequest(flight, { usage })`，落盘只在真的写进记录时才排 |

令牌变量刻意不叫 `sess`：主入口模块级已有一个 `sess`（会话存储），而 `sessionEntry` 的返回值在 prepare 里也叫 `sess`，同名会遮蔽。

### 集成时发现并修掉的一处真实缺陷（不是接线问题）

会话 guard 原本在 `binding` 这一层多了一条判据：`(s.routing || null) !== token.routing` → `binding_blocked = 'config-changed'`，即**只要用户在响应回来之前保存过一次 Key/槽位覆盖，这条在途响应的自动绑定就不写**。

- 它与本条独立交付自己的验收用例直接矛盾：`test/session-flight-guard-integration.test.js`「在途请求跨过覆盖保存」断言 `afterSave.providerId === landed`（正是这条绑定），接线后报红在 `expected 'pa', actual ''`。
- 判据本身也不成立：存一份 Key/槽位覆盖**不改变"这个对话该走哪个渠道"**，自动绑定照常该记；而且 `config-changed` 这条分支在任何测试里都没有被断言过——`binding-changed` 那条有，`config-changed` 那条没有。
- 它也确实误伤：实测「跨过保存那一刻仍在途」的请求，响应回来写不进那条本该记下的绑定，粘性静默失效。保存**之后**新发的请求不受影响（新令牌带的是保存后的 routing），所以影响面是"跨过保存的在途请求"，不是"此后所有请求"。
- 另一个可用的判据是记录世代：控制台保存覆盖是整条换对象，`carryMark` 已把世代交给新记录，同一条记录仍认得出，本来就不该按 routing 再拦一道。
- 处置：删掉 `config-changed` 分支与令牌里的 `routing` 字段（留着不读会让人以为它在生效，正是这条缺陷的成因），注释与记录同步改。**没有削弱任何该有的保护**，实测：手动钉定后结算仍是 `binding_blocked='binding-changed'`、绑定保得住、统计与实际落点照记；被删记录仍是 `reason='removed'`、不复活。

### 接线后的验证

Node v24.18.0，统一入口 `scripts/run-tests.js`：

| 命令 | 结果 |
| --- | --- |
| `node scripts/run-tests.js test/session-flight-guard.test.js test/session-flight-guard-integration.test.js` | **17 通过、0 失败**（接线前 3 通过 / 2 失败；两条红用例转绿即接线验收证据。此后两处修订各增一条用例：14→15「同代并发」、15→17 含「钉定渠道不可用时在途响应不改写钉定」，集成文件 5→6） |
| `node scripts/run-tests.js`（全套 89 个文件） | **1388 通过、0 失败**（第一期基线 1334；+54 为第二期新增用例）。跑前跑后工作树 mtime 快照哈希一致（`TREE STABLE during run`），数字可判 |
| `node scripts/smoke-offline.js` | **18/18 通过**（同样在冻结树上跑） |

未测（如实记录）：Node 18/22、真实付费上游、WKWebView 与浏览器、在线切换与回退——均需授权空闲窗口。

### 同一处的第二处缺陷（由会话侧发现并修，主会话复核）

删掉 `config-changed` 之后，`binding-changed` 的判据本身还有一个**同源缺陷**：它拿**入口快照的 `bindingSig`** 当基准，而这三个字段**自动落点也写**——所以同一条记录的另一条同代请求先落账（失败转移换渠道）就会把签名改掉，后回来的那条被误判成"用户手改"，丢掉自己本该记下的落点。**触发不需要任何用户操作**，只需同一会话两条请求真并发。

- 原有那条「同一代并发请求互不作废」用例**掩盖了**它（先改 `providerId` 再结算，签名被重置成基准，恰好相等），所以双方此前都没看见。
- 修法：判"手改"的基准分两种——记录**自从捕获以来还没被任何结算写过**时用入口快照 `sig`（此时快照仍有效，一次手改也不会漏），已被写过时用"我们上次经 `settleRequest` 写进去的值"（存 WeakMap，不写进记录、不落盘）。
- 中途走过的弯路值得记下：会话侧先写成"一律以上次写入值为基准，没有基线就拦"，结果是**一条从没被写过的记录，其首次自动落点永远写不进去**（每条新会话第一条请求都会踩）——主会话在它编辑过程中跑到红用例并定位到 `!written` 那一支。改成上面的双基准后两侧都成立。
- 主会话独立复核（直接探针，非转述）：全新记录首次落点 `applied.binding=true`；手动钉定后仍 `binding-changed`、绑定保得住、统计照记；同代并发第二条落点 `applied.binding=true`。
- **仍然存在、没有修的窗口（会话侧如实申报，主会话照录）**：判定用的是**当前值**而非版本号，故"A 结算写 binding → 用户立即手改 → B 结算"这一交错里，B 看到的是用户改过的当前状态，会照常把绑定写回去。彻底关掉需要"写入者版本 + 用户改动版本"的乐观并发（与保存覆盖的 `expected_revision` 同形），属接口扩展，不在本期范围。

## 会话在途 guard 与池状态边界（接口已交付，接线待代理拆分落地）

窄接口都在 `sess` 实例上（`mixrouter.js` 里那个 `sess` 就是它）：

- `sess.captureRequest(key)` → 只读快照的令牌；记录不存在时令牌无目标，避免请求替不存在的记录建档。
- `sess.settleRequest(token, patch)` → 可多次调用，字段分层：`usage`（reqs/inTok/outTok/lastUsed）、`binding`（自动落点，受保护）、`actual`（最近实际落点，含 slot/sticky/status）。返回 `{ok, applied, reason, binding_blocked}`，`reason` 区分 `no-record`/`removed`/`replaced`，`binding_blocked` 为 `binding-changed`（`config-changed` 已在接线时删除，见下）。
- 判定：记录被删或被另一条记录替换 → 一律不写，不复活；同一条记录但期间改过覆盖或手动绑定 → `usage`/`actual` 照记（它们描述这条会话真实发生过的事），只有 `binding` 不写。同一代并发请求各持令牌、互不作废（按记录世代号比对，不是"最后写入者胜"）。

已独立复核的证据：`test/session-flight-guard.test.js` Node v24.18.0 接线后 **10 通过、0 失败**（含新增的同代并发用例）；受影响既有回归（routing-modules / session-config / routing-preview / routing-diagnostics-evidence / session / session-routing / session-routing-ui / session-routing-cli / console-module）报全绿。`test/session-flight-guard-integration.test.js` 原为 3 通过 / 2 失败（红的两条即接线验收证据），接线后 **5/5**。

既有断言变更（主会话已逐行核对，接受）：`test/routing-diagnostics-evidence.test.js` 的「已过 TTL 的绑定不会被当作粘性」原夹具用 `pinned: true`，依赖了旧语义；现改为自动绑定，并**新增**一条「已过 TTL 的手动钉定不再被回收，预览与实跑都继续粘它」。覆盖点是扩大而非削弱。同类第二处：`test/routing-preview-api.test.js` 的「不剪枝、不 touch、不写盘、不发上游」把过期夹具从 `pinned: true` 改成自动绑定（`live` 那条仍保留 `pinned`），用例本意不变。第二处**未在执行者报告中申报**，由主会话在改动清单里发现后核对确认——属同类夹具修正，非断言削弱。

**产品语义变化（需要用户知情）**：手动钉定从此属于显式配置，不再被 TTL 或容量自动回收——修的是"手动配置被静默丢弃"，代价是长跑实例里钉定会长期留在会话表；清除路径为控制台解绑或 `DELETE /api/sessions/:key`（会把手动标记置回）。钉定数量本身不受 `MIXR_SESSION_MAX` 淘汰（该上限只淘汰自动记录），无界增长风险如实记录。

低可信身份（`fp:`/`cxf:`/`anon`/`cx-anon`）不能**新建**持久覆盖（`PUT /api/sessions/:key/routing` 返回 400 并说明原因）；存量覆盖照读、照导出、照清理，不静默删除或转绑。`/api/sessions` 每行新增 `required`/`bound`/`actual`/`actual_source`/`actual_text`/`configured`，没有真实请求记录时 `actual` 为 `null`、`actual_text` 为「暂无」，不用预览冒充；旧字段全部保留。

## 当前结果

第二期三个独立任务（代理编排拆分、会话与池边界 + 在途 guard、TOML 单一实现）均已落地；接口由主会话在装配处接线完成，全套 **1388 通过 / 0 失败**、离线 smoke 18/18（均在冻结树上跑，跑前跑后 mtime 快照哈希一致）。尚未 commit、push 或上线。

## `lib/upstream/` 命名统一（2026-10-17 收尾）

§5.2 任务 6 的第二个子项。原先 `lib/upstream/collect.js` 独占一个目录，而它的**五个同族兄弟**（`upstream-error-text` / `upstream-health` / `upstream-probe` / `upstream-proxy` / `upstream-proxy-check` / `upstream-relay`）都在 `lib/` 根下扁平命名 —— 同一类模块被拆到两种布局里，找文件要先猜它在不在子目录。

处置：`mv lib/upstream/collect.js lib/upstream-collect.js` + `rmdir lib/upstream`，使七个 upstream 模块统一为 `lib/upstream-<topic>.js`。**纯文件移动，零逻辑改动**（规划 §5.5 要求"文件等价移动与代码修复分开提交"，故此处只做移动）。

- 引用点 3 处同步：`mixrouter.js:69`、`test/upstream-collect.test.js`、`test/modules-wiring.test.js`。
- 活注释 1 处同步：`lib/proxy/response.js:226` 的"见 …collect.js"指路。
- 历史记录**不改写**：`docs/changes/2026-09-29.md` 与 `phase2-proxy-boundaries-2026-10-16.md` 里的旧路径是当时事实，保留。
- 验证：`test/upstream-collect.test.js` + `test/modules-wiring.test.js` + `test/runtime-code.test.js` **60 通过 / 0 失败**。
- 注：`lib/routing/pool-state.js`、`lib/http/proxy.js`、`lib/proxy/` 这些**同轮新增文件**在 git 里显示为未跟踪（`??`），因为本次重构全部改动尚未提交；`collect.js` 的移动同样显示为 `D lib/upstream/collect.js` + `?? lib/upstream-collect.js`，提交时按等价移动识别。

## 已知风险（如实记录）

- **手动钉定不再被 TTL 回收（本期的有意改动）**：以前 `prune` 只按 `hasRouting` 豁免，手动钉定写的是 `pinned`+`providerId`、没有 `routing`，于是一条钉定的对话闲置 12 小时会被静默丢掉。现在判据统一为 `explicitConfig = pinned || hasRouting`，会话侧与诊断预览共用同一个函数。清除路径为控制台解绑或 `DELETE /api/sessions/:key`；钉定总数仍受 `MIXR_SESSION_MAX` 约束（见下）。
- **"钉定无界增长"经复核为误判，已撤销**（原记录为"第二期唯一新增的无界状态"，**不成立**）。会话侧当初的实测是"`max=3` 的 store 连写 20 条钉定、`prune()` 一条都不回收"——但那个测法是**在插入期间从不调用 prune**，与在线节奏不符。按实际调用顺序复测：`resolveTarget`（每条代理请求）与 `/api/sessions`（控制台每次刷新）都在**建记录之前**先 `prune()`，而在线装配不传 `maxConfigured` ⇒ `limit = max`，表上限与"显式配置上限"是同一个数、同一条淘汰规则。实测（`max=3`，每轮 prune）：钉定数稳定在 **3**，第 4 条起新记录在建档前就被容量淘汰（`pin` 得到的是 404「会话不存在」而非 400）。**结论：在线不存在钉定无界增长**；`MIXR_SESSION_MAX` 换代后约 1.2 天轮空一次，正常使用（实测 14 条、TTL 12h）不会触到。
- **顺带证伪一个"该修"的方向**：曾按"钉定也占显式配置名额、该与保存覆盖共用闸门"给 pin 门加了 `assertPinCapacity`（超限 400）。实跑探针证明它是**死代码**——要触发需「`configuredCount >= max`」且「目标记录仍在表里」，而在 `limit = max` 下后者会先被 `prune` 淘汰，永远拿不到 400；只有有人显式设置 `maxConfigured < max` 时才有意义，而在线装配没有这样设。已连同其用例一起撤除，不留无用路径（依据：先量化路径触发频率再谈机制，零频率路径不加机制）。
- **已决并已落地：钉定渠道不可用时，在途响应不改写钉定**。原为待定项，现按本期已有契约判定为**应修**——规划 5.2.4 只允许更新"统计**或自动绑定**"（钉定不是自动绑定），5.2.5 与本期的 `explicitConfig = pinned || hasRouting` 又要求显式设置不被静默丢弃。
  - 缺陷不止"一条在途响应改写钉定"，而是**临时故障会把钉定永久废掉**。探针（钉定 X → X 一次冷却 → 请求回退到 Y → 在途响应写回 → 记录变 `providerId=Y, pinned=true` → X 恢复）：下一条请求**仍粘 Y**，因为 `resolveTarget` 的钉定分支读的是 `bound.providerId`（现在是 Y，可用）。用户钉的 X 再也回不来，界面还显示"已钉定"。一次 500 即可触发。
  - 成因是两条**旧有**语义叠加：`rebind` 条件（`mixrouter.js` 基线 1240 行起就逐字相同）要求"落点变了"才提交 binding，而 `resolveTarget` 在钉定渠道 disabled/冷却时会落到池里，于是落点确实变了。**不是本期引入**，但本期承诺的显式配置语义要求修它。
  - 修法（由会话侧落地，实现 + 用例一起进）：`settleRequest` 的 binding 分支改为"记录是钉定的就直接 `binding-changed`，不走签名比较"；`actual` 照记，故控制台仍能看到"最近实际落到哪"。用例放 `test/session-flight-guard-integration.test.js`，**两头都钉**：钉定值保住 + `actual` 记真实新落点。
  - 会话侧提出的另一修法 `baseline = written ? written.sig : null` 已实测会打掉"全新记录第一次落点"，不可采用；`proxy-split` 的试验副本数字（1387/0）不采信为证据，以开发副本复跑为准。
  - **落地证据（会话侧，开发副本，Node v24.18.0）**：实现 = `lib/routing/sessions.js` 的 `settleRequest` 在签名比较**之前**加一支 `if (s.pinned) { out.binding_blocked = 'binding-changed'; return out; }`；`binding_blocked` 取值不变（不加新枚举），`actual` 已在其前面写完，故照记。
    - 模块级探针（钉定 X → X 不可用 → 落 Y → 结算 binding）：修前 `binding applied = true`、记录变 `{providerId:Y, pinned:true}`、X 恢复后下一条仍粘 Y（钉定被永久废掉）；修后 `binding applied = false`、记录保持 `{providerId:X, pinned:true}`、X 恢复后下一条回 X。
    - 入口级用例 `test/session-flight-guard-integration.test.js`「钉定渠道不可用时,在途响应不改写钉定,actual 如实记新落点」：走真实代理入口与可控上游，**两头都断言** —— 钉定值保住（`providerId===X && pinned`）+ `actual.providerId` 等于真实回退渠道 + 三层里 `bound.provider` 与 `actual.provider` 分开可读 + 钉定渠道恢复后下一条回 X。
    - 验收集（会话侧自跑，`session-flight-guard` + `-integration` + `session-entry` + `session-routing*` + `session-config` + `routing-diagnostics-evidence` + `routing-preview*`）：**270 通过、0 失败**；跑前跑后对 `lib`/`mixrouter.js`/`test`/`public` 做了 mtime 快照对比，结果 **TREE STABLE during run**（这轮两次瞬时红皆因读到编辑中的文件，此法可排除）。

## 派发环境问题（已修，记录备查）

本轮派发子代理时调用参数误带 `isolation: "remote"`（连续 15 次），而本机 claude.ai 门禁/登录不可用，安装的 CLI（2.1.301）在 remote 不可用时**回退成 `isolation: 'worktree'`**，于是子代理被放进 `mixrouter-src/.claude/worktrees/agent-*`，对普通开发副本的写入被守卫拒绝。原 `~/.claude/hooks/no-worktree.py` 只匹配 `isolation == "worktree"`，`"remote"` 原样透传，禁令在参数层就被绕过。

处置：hook 改为删除 `isolation` 的**任何取值**（本地 13 例回归：remote/worktree/空/缺省均被剥离，其余参数保持不变，普通工具不受影响，EnterWorktree 仍拒绝）；派发改为完全不写 `isolation`。此问题属于派发侧，不是子代理行为；未因此创建、迁移或清理任何工作树。

