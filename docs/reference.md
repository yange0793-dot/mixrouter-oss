# 参考手册

这份文档是机制的完整说明:匹配顺序、槽位与覆盖的判定、协议互转、压缩分流、上游健康、
日志与归档、全部环境变量。要"在哪里改什么"看[快速开始](quick-start.md);
按症状排查看[故障排查](troubleshooting.md)。

---

## 1. 请求怎么落到渠道

Claude Code / Codex 入口的判定顺序是固定的四段,唯一定义在 `lib/routing/resolve.js`:

| # | 阶段 | 说明 |
| --- | --- | --- |
| 1 | 内容分流 | 带 `when.body` 的规则,按 `priority` 降序评估;先于槽位别名与普通规则 |
| 2 | 槽位别名 | 请求模型名精确等于 `mixr-<槽名>` 时命中,优先于一切普通规则 |
| 3 | 普通规则 | 按 `priority` 降序,命中首个启用且满足 `when` 的规则 |
| 4 | 兜底路由 | 都不命中时走 `default`;它尊重自己配置的 `strategy` |

`mixctl explain` 与 `POST /api/routing/preview` 复用同一个 resolver 的 trace 回调,
不会出现"预览说一套、实跑另一套"。

### 路由规则字段

| 字段 | 说明 |
| --- | --- |
| `match` | 请求模型名的**子串**,逗号分隔多个,大小写不敏感;留空 = 不按模型名限制(内容分流用) |
| `provider` | 单一目标渠道 id |
| `pool` | 渠道池。成员写成字符串即用规则的目标模型;写成对象可各自给 `{provider, model, weight}` |
| `strategy` | `round_robin`(默认)/ `weighted` / `least_used` / `random` / `priority` |
| `model` | 目标模型;留空 = 透传请求模型;带 `[1M]` = 剥后缀并加 `anthropic-beta` 头(仅 Claude 通路) |
| `priority` | 数值大的先匹配;同优先级按数组顺序 |
| `app` | 这条规则只对哪一组生效:`claude` / `codex` / 留空 = 两组通用 |
| `when` | 附加条件,**全部**满足才命中;字段只有 `session` / `ua` / `token` / `body`,均为大小写不敏感子串 |
| `enabled` | `false` 即停用 |

两条硬约束:`PUT /api/routes` **写入时**会以 400 拒绝"目标渠道不存在"与"声明了 `app`
却绑了另一组渠道"的规则。读盘时不做这两项检查,只把僵尸引用打给日志——所以手改或从旧备份
恢复出来的规则仍会被加载,**命中这类规则的请求会 503**(而不是写入时那个 400)。
没声明 `app` 的规则若整条只绑了另一组渠道,那组请求会跳过它继续往下匹配。

**池策略**:

| 策略 | 行为 | 适合 |
| --- | --- | --- |
| `round_robin` | 新对话依次落到下一个成员;游标按规则 id 跨请求保留 | 均摊额度,最好预料 |
| `weighted` | 平滑加权轮询(nginx 式),按成员 `weight` 比例;失败不改变成员的轮转资格 | 主力渠道多分点 |
| `least_used` | 优先给当前挂载对话最少的成员 | 成员额度不等 |
| `random` | 随机 | 无特殊要求 |
| `priority` | 永远取池序里第一个可用渠道,主渠道不可用才落到下一个 | 主备降级 |

渠道和 Key 均不再进行时间冷却。失败不改变后续请求的成员选择;普通重试仍受次数、间隔与总预算约束。

### 渠道字段

| 字段 | 说明 |
| --- | --- |
| `app` | 建渠道时选 `claude` / `codex`,建完之后不能改组 |
| `name` | 必填,非空 |
| `base_url` | 合法 `http(s)` URL;尾部 `/` 与末尾 `/v1` 会被规范化,路径前缀保留 |
| `api_key` | 不能含换行或控制字符;渠道有多 Key 清单时 `api_key` 恒等于生效那把 |
| `models` | Claude 组:模型名数组,第一项是主模型,支持 `[1M]` 后缀;Codex 组:可选登记候选列表,须为字符串数组,去空白和重复项 |
| `model` | Codex 组必填:独立的渠道默认模型名,须非空;候选列表和槽位落点不覆盖它 |
| `wire_api` | Claude 组:`anthropic`(缺省)/ `responses` / `chat`;Codex 组:`responses`(缺省)/ `chat` |
| `ua` | 渠道级 User-Agent,压过客户端自己的 UA |
| `direct` | `true` = 这个渠道跳过 `MIXR_UPSTREAM_PROXY` 隧道 |
| `enabled` | 默认启用 |
| `keys` / `active_key` | 多 Key 清单 `[{id,label,key}]` 与当前生效 Key |
| `key_fallback` | 布尔值，默认关闭；明确开启后才在账号故障时尝试同渠道备用 Key，不改 `active_key` 或模型 |

`wire_api` 怎么选:渠道直接吃 Anthropic `/v1/messages` → 留空;模型只挂在
Responses 型通道上 → Claude 组标 `responses`;网关只开 `/v1/chat/completions` → 标 `chat`。
配错时不会静默降级:路由命中的渠道协议与请求端点不匹配会回 `wire_api_mismatch_error`;
但有些错误上游自己也会回 4xx,那种情况看到的是上游原文,不一定是这个错误码。

### 多 Key 渠道

同一个 provider 下有多把 Key(多账号、多额度池)时,一个渠道里存
`keys: [{id, label, key}]` + `active_key`:

- 普通转发、渠道测试、「切换」写客户端都用生效那把;
- 控制台的「API key」下拉点一下即切账号,立即生效;
- 老式只有 `api_key` 的渠道显示成一条「账号1」(固定 id `klegacy`)。加第二把时它按原 Key
  解析,不会丢;渠道一旦有清单,弹窗顶栏那个单行 API Key 就不再参与保存;
- 槽位绑的是渠道,换 Key 不需要重选槽位;直连模式下换 Key 会漂移,点「重新写入」同步。

### 模型列表获取

`POST /api/providers/models` 只获取上游清单,不新增/保存渠道、不改生效 Key、路由或客户端配置,
也不写请求日志。它与代理口 `GET /v1/models` 的本地已配置模型清单不同。
控制台同样执行回环 Host、同源与 JSON 对象请求体校验。

| JSON 字段 | 说明 |
| --- | --- |
| `base_url` | 新渠道必填;已有渠道可省略,默认保存值。仅 `http(s)`,不接受 URL 用户信息、查询参数或片段 |
| `api_key` | 新渠道必填;已有渠道省略或留空时使用保存的 Key。非空值仅覆盖本次请求 |
| `provider_id` | 已有渠道 ID;省略即作为未保存的渠道获取 |
| `key_id` | 指定该渠道中已保存的账号,包括旧单 Key 的 `klegacy`;省略用当前生效 Key,未知 ID 不回退 |
| `wire_api` | `anthropic` / `responses` / `chat`;省略用渠道值,新渠道默认 Anthropic |
| `direct` | 布尔值,决定本次是否跳过出站代理;省略用渠道值。保存的自定义 UA 同样沿用 |

成功返回 `{"models":["model-a","model-b"]}`,按上游顺序去重。接受标准 `data` 模型数组,
以及兼容网关的 `models` 数组或顶层数组;有效空列表返回空数组,不捏造默认模型。
请求使用 `GET /v1/models`,复用普通上游路径拼接规则,保留自定义路径前缀,
兼容末尾 `/v1` 或完整模型列表端点。Anthropic 请求带 `x-api-key`、Bearer 与版本头,
OpenAI 型请求使用 Bearer。

Anthropic `has_more` / `last_id` 分页通过同一端点的 `after_id` 继续获取。
整次获取最多 **15 秒、20 页、累计 2 MiB 响应**;超限报错,不把截断结果当完整清单。
不跟随重定向,避免把 Key 送往另一个地址;也不发送聊天或连通性探活请求。

错误返回 `{"error":"说明"}`:参数无效 `400`,渠道/账号不存在 `404`,
上游 HTTP 失败、格式异常或超限 `502`,超时 `504`。错误信息不回显上游响应正文或凭据。
若上游未提供模型列表,请手填模型;列表存在不代表账号对每个模型都有调用权限。

### 出站直连

渠道的 `direct: true` 只让这个渠道的转发与探活跳过进程内 HTTP CONNECT 隧道,直连连接
仍复用 keep-alive。它不改客户端配置,也不能绕过操作系统 TUN/VPN。未配置
`MIXR_UPSTREAM_PROXY` 时本来就直连,不会自动跟随 macOS 系统代理或其他代理软件的规则。
「直连」只决定路径,不保证 DNS 返回的每个 CDN 地址都可达。

直连池显式启用多地址尝试,每个候选等待 1000ms 再切下一个,避免沿用 Node 部分版本的
250ms 窗口而过早放弃高延迟地址。DNS、TCP 与 TLS 初次建连共用独立的 15 秒硬截止
(`MIXR_UPSTREAM_CONNECT_TIMEOUT_MS`),超时销毁 socket 并进入既有请求重试,不另开调用预算。
TCP/HTTPS 握手完成就清理建连计时器,后续首响应、推理等待、流空闲与复用连接不受它限制。
不钉死 IP、不缓存地址健康、不自动改走代理;多地址全部不通或 HTTP 响应阶段卡住仍会失败。

---

## 2. 会话级分发与覆盖

### 对话身份

| 客户端 | 1 | 2 | 3 |
| --- | --- | --- | --- |
| Claude Code | `x-claude-code-session-id` 头 | body `metadata.user_id` 里的 `session_id` | 内容指纹 |
| Codex | `session-id` / `thread-id` / `x-client-request-id` 头 | body `prompt_cache_key`、`client_metadata.session_id` | 内容指纹 |

会话键前缀:Claude 是 `cc:`(头/元数据)与 `fp:`(指纹),Codex 是 `cx:` 与 `cxf:`。
内容指纹 = 「system/instructions + 首条用户消息」的 sha1,同内容即同对话。
同一个对话里的所有请求(子代理、`count_tokens`、标题生成)**只要客户端带了同一身份**,
就共享会话键并默认落在同一个渠道上,从而不打断 prompt 缓存。这个"默认"不是绝对承诺:
槽位请求按槽位表走、内容分流命中的请求不参与粘性、失败转移会把对话改绑到成功的渠道,
显式改绑与覆盖也会改变落点。

相关变量:`MIXR_SESSION_TTL_MIN`(默认 720)、`MIXR_SESSION_MAX`(1000)、
`MIXR_MAX_ATTEMPTS`(10)、`MIXR_SESSION_LABEL=0`。

### 手动钉定与解绑

- **手动改绑(钉定)**压过策略,且允许指定池外的渠道;`POST /api/sessions/:key/pin`
  传空 `provider` = 解除钉定,下次请求重新按策略分配。
- 钉定属于**显式配置**,不会被空闲 TTL 或容量上限自动回收;代价是长跑实例里会长期留在
  会话表,受 `MIXR_SESSION_MAX` 约束。
- **解除钉定**只清钉定,保留这条会话的 Key / 槽位覆盖;
  **删除会话**(`DELETE /api/sessions/:key`,控制台「解绑」)连同覆盖一起删除。
- 代理每次请求结束会记录 `actual`(最近实际落点,**照记**)与 `binding`(自动落点)。
  手动钉定的记录**不允许自动落点回写**——否则一次临时故障回退到池里另一个渠道,
  就等于把钉定永久废掉。这是"显式配置优先于自动推断"的第一处落地。
- 会话列表给每条会话三层状态:`configured`(有没有显式配置)、`required`(存下来的要求)、
  `bound`(当前绑定及来源 manual/auto/none)、`actual`(最近真实请求落点)。
  没有真实请求时 `actual` 为 `null`,显示「暂无」,不拿路由预览冒充实际落点。

### 会话级 Key 与槽位覆盖

覆盖存在 `sessions.json` 的会话记录里(`routing: {keys, slots}`),只引用渠道内已有的
**Key ID**,**不重复存 Key 明文**;空映射即继承全局。控制台入口为
「会话 → 当前绑定 → 配置 Key / 槽位」:逐槽选择渠道和落点模型,模型可自定义,
可复制未覆盖的全局渠道/模型到草稿(不含备池),点击保存才写入。普通请求钉定在
「普通请求渠道」展开设置,渠道级 Key 位于槽位编辑器下方。接口是
`GET/PUT /api/sessions/:key/routing`,命令行包装是
`mixctl sessions config|set-key|set-slot|clear-slot|reset`。

- **Key 覆盖** `routing.keys`:`{渠道ID: KeyID}`。这条对话打到该渠道时用指定账号。
- **槽位覆盖** `routing.slots`:`{槽名: {provider, model?, key_id?}}`,按**槽名**命中。
  Claude 组固定五槽,Codex 组槽名自拟;一个覆盖限单一渠道,没有独立备池
  (要池化就在全局槽位表里配)。

**省略字段时的落点**(覆盖是这一槽**整体替换**全局槽位,不是逐字段合并):

- 不给 `model`:这一槽不覆盖模型,落点取所绑渠道自己的默认模型——Claude 渠道取
  `models[0]`,Codex 渠道取渠道的 `model`。它不是"回落全局槽位那一档的模型"。
- 不给 `key_id`:先看这条会话的 `routing.keys[渠道]`,没有才用渠道当前生效 Key。
  槽位级 `key_id` 更具体、优先。

**优先级与边界**:

- 普通内容请求:槽位先看会话覆盖,再看全局槽位表;普通路由规则与手动钉定保持原语义。
- 条目不存在就是继承;`--inherit` / `clear-slot` 删条目,`reset` 一次清空。
  改动从后续新请求生效——在途请求持有开始处理时的配置快照。
- 只适用于传来**同一会话身份**的请求。传了不同 `session_id` 的子代理不自动继承。
- 覆盖里点名的 Key 被删除、停用、重复或为空时返回 503 `provider_key_unavailable_error`,
  不会改用渠道当前 Key;固定 Key 的请求也只在同一账号上重试。
- 低可信身份(`fp:` / `cxf:` / `anon` / `cx-anon`)不能**新建**覆盖
  (`PUT` 返回 400);存量覆盖照读、照导出、照清理。
- 每次写入读-改-写并带 `expected_revision`:版本冲突报 `revision_conflict` 并放弃写入。
  服务端校验**整份**覆盖,盘上有一处引用已删渠道或 Key,连"只改一项"也会被拒。

命令行**不接受 Key 明文**(argv 会进 shell 历史与 `ps` 输出),只认 Key ID。
每次请求有有界超时(`MIXR_SESSION_CLI_TIMEOUT_MS`,默认 10 秒);超时只保证命令会回来,
不保证没写进去,报错后请用 `config` 复核。

### 会话标签

标签取自 Claude 的 system prompt 工作目录 / Codex 的首条用户消息(跳过
`<environment_context>` 一类注入块)。它**不进请求日志,也不进 `/api/metrics`**
(指标标签集固定,不按会话展开),而是存在 `sessions.json` 的会话记录里——
也就是说,**`sessions.json` 含对话内容片段**,属于敏感文件,不要提交或外发。
`MIXR_SESSION_LABEL=0` 关闭采集。

---

## 3. 槽位

Claude Code / Codex 的全局槽位表存在 `<MIXR_DATA_DIR>/slots.json`(`{version, claude, codex}`),
别名由 `slotAlias()` 生成:`mixr-` + 槽名。

| 槽 | 别名 | 客户端 env |
| --- | --- | --- |
| `main` | `mixr-main` | `ANTHROPIC_MODEL` |
| `opus` | `mixr-opus` | `ANTHROPIC_DEFAULT_OPUS_MODEL` |
| `sonnet` | `mixr-sonnet` | `ANTHROPIC_DEFAULT_SONNET_MODEL` |
| `haiku` | `mixr-haiku` | `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| `subagent` | `mixr-subagent` | `CLAUDE_CODE_SUBAGENT_MODEL` |

`fable` 槽已移除:Claude Code 在当前接法下不消费对应 env。加载时会从内存槽表清理旧
`fable` 与未知 Claude 槽,不因启动而改写磁盘槽表或客户端配置;`fable` 作为普通模型名
的一部分不受影响。

**Codex 自拟槽名**须匹配 `^[a-z0-9][a-z0-9-]{0,23}$`,如 `worker` / `reviewer`。
路由模式下直接 `codex exec -m mixr-worker`;`GET /v1/models` 也会列出这些别名。
`main` / `reviewer` 两个槽可写到 Codex 全局配置的 `model` / `review_model`。

**Codex 接入与热切换**:普通 `./mixctl route codex` 或接入向导自动采用可用的 `main` /
`reviewer` 别名,并将 `model_catalog_json` 指向 `mixrouter-model-catalog.json`。
普通接入缺少 `main` / `reviewer` 时,按渠道库顺序用首个启用且有默认模型与 Key 的 Codex
渠道补齐;已有无效槽不覆盖,写入前返回 400。自动补齐保存在路由器槽位表,
接入向导撤销客户端受管字段时不会删除这些槽。
命令行没有 `route codex --slots`(仍会被拒绝);`POST /api/router/codex {"slots":true}`
保留为不自动补槽的严格接入方式,要求两个槽都有效,否则写入前返回 400。

首次从直连切换时须确认接入,让 Codex 读取本机 provider 与别名配置。
已经接入路由后,一次 `PUT /api/slots` 保存就更新后续别名请求的落点与托管目录,
不需要再点应用或重启来改变转发落点;目录显示名标明槽位的当前实际目标。
同步不改 `model_reasoning_effort`、用户上下文设置或其它客户端字段。

托管目录优先采用本地原始目录中的目标模型能力;未知目标只登记身份,不猜测上下文窗口、
推理档位或工具能力。原生选择器会缓存目录和显示名,实测没有可用的刷新接口;
重新打开客户端可读取新目录,磁盘更新不会即时刷新已打开的选择器。
`profile`、项目配置及未登记的真实模型名不自动跟随全局主槽。

兼容旧会话仅精确匹配托管目录登记的旧默认模型 ID,并同时要求原生 Codex 标识、本地路由凭据、
可靠 `cx:` 会话与本机受管接入配置。标识支持现有 Codex CLI 形式和 `codex_desktop/`,
不放宽其它未知 `codex_*` 前缀;满足时映射到对应槽别名再按当前槽位转发。显式 `-m` 选择
同一旧默认 ID 仍会命中,请求上无法区别它与仍持有旧默认的会话。无关原生 ID 与其它 OpenAI
客户端不受影响。
通常使用对应 `mixr-<槽名>` 请求按槽路由;在途请求不因保存而中途换模型。

**槽位落点的性质**:

- 不走会话粘性、不复用对话钉定、不改变对话绑定;按槽位自己的池策略挑选(见第 5 节)。
- 槽位可以配 `pool` 与 `strategy`。`resolveSlot` 会**自动把槽位的 `provider` 排到池首**,
  `pool` 里只需写后备成员;`priority` 策略下主渠道仍是主选。
- 渠道停用/删除得到明确的 `provider_disabled_error` / `no_route_error`。
- 落点模型:Claude 与 Codex 槽都可独立选定。模型留空时继承渠道默认值:
  Claude 取 `models[0]`,Codex 取 `model`;显式落点不修改渠道的默认模型。
- `PUT /api/slots` 的 `model` 须为字符串。显式 `model: ""` 恢复继承;同渠道省略 `model`
  保留已有落点,换渠道且省略 `model` 则恢复新渠道默认值。状态的 `model` 是有效落点,
  `configured_model` 是保存的显式值(空串表示继承)。

**Claude 槽位备池可在控制台编辑**:展开「后备渠道」选择顺序和每个成员的模型，确认后保存。
主渠道不变；不同模型需明确确认降级，界面不推断图片或工具能力。已有其它策略保留，
不是把轮转池静默改成主备池。`PUT /api/slots` 对 `pool` / `strategy` / `dropTools` 保持
**部分更新**(没带就保留，`pool: []` 才清空)。Codex 槽位编辑目前不提供后备池。

**主链 + 子代理双路**:`mixctl split` 把 `main` / `opus` / `sonnet` / `haiku` 四槽统一
绑到同一「渠道 @ 模型」,`subagent` 单独绑一个——任一副槽漏配都不会悄悄回落到主链模型。

```bash
./mixctl split p1 claude-sonnet-5 p2 claude-opus-5 --apply
./mixctl split subagent p2 claude-opus-5 --apply
```

不带 `--apply` 只落 `slots.json`,不碰客户端配置;换来源只改槽位表,运行中的进程下一次
请求就读到新落点,不必重启。重启只读 `slots.json`,不会拿备份或启动快照反写槽位。

---

## 4. 协议互转

三条线都是**进程内**双向转换。落点由渠道的 `wire_api` 决定。

| 线路 | 请求方向 | 响应方向 |
| --- | --- | --- |
| Anthropic → Responses | `system→instructions`、`tool_use→function_call`、`tool_result→function_call_output`、图片→`input_image`、`max_tokens→max_output_tokens` | Responses 的 JSON/SSE 译回 `message` / `message_start…message_stop`(明文 reasoning 保留为 thinking,usage 穿过翻译层) |
| Claude → Chat Completions | system 进首条消息、`tool_use→tool_calls`、`tool_result→role:tool`、顶层图片转 `image_url` data URI、`reasoning_content→thinking` | chat SSE 译回 Anthropic SSE;工具参数攒齐再物化;没有终态不得补 `message_stop` |
| Responses → Chat | `instructions→system`、`developer→system`、`function_call→assistant.tool_calls`、`function_call_output→role:tool`、可读 `reasoning` 关联为 assistant 的 `reasoning_content`、自动加 `stream_options.include_usage` | chat SSE 译回 responses SSE;**首个文本 delta 之前先发 `response.output_item.added`**;工具调用整包下发 `function_call` item |

几条容易踩的实现约定:

- **思考回放按实际出站模型选格式**,不按渠道也不按客户端别名:有些模型用
  `summary:[{type:"summary_text",text}]`,DeepSeek 系用 `content:[{type:"reasoning_text",text}]`。
  不能同时塞两种字段,也不能删历史 thinking 规避校验;`[1M]` 后缀不改变这个选择。
- **Chat → Responses 用量明细完整**:JSON 与流终态始终包含 `input_tokens_details.cached_tokens`
  和 `output_tokens_details.reasoning_tokens`;缺省补 0,保留上游已报告计数与扩展字段,不从正文推算。
- **Responses → Chat 可读推理回放**:优先读取 reasoning 的可读 `content`,没有可读 content
  才回退到 `summary`,不把两者拼成新推理。连续 reasoning 累积为 Chat `reasoning_content`,
  空项或纯密文项不擦除已有可读内容;推理关联到随后的 assistant 正文及同响应工具调用。
  新 reasoning 不覆盖此前 assistant 已绑定的推理,用户/system/developer/工具结果边界重置
  关联。`encrypted_content` 无法解密成 DeepSeek 明文,不会伪造推理或补空 `reasoning_content`
  使上游看起来接受了完整推理历史。
- **格式要求不绕过**:Responses `text.format` 的 JSON 格式转为 Chat `response_format`,
  不因上游不支持就删除该字段。跨协议或格式不兼容仍如实失败,推理回放修复不保证兼容所有历史。
- **工具定义显式写 `strict: false`**。Responses 省略 `strict` 时上游可能把 schema 规范化成
  严格模式,要求 `properties` 每个键都在 `required` 里——结果是客户端工具调用的可选参数
  从未被省略。空占位清理器删不掉非空字符串,挡不住它。
- **图片两处都转**:消息体里的图片,以及 `tool_result` 里的图片。
- **`count_tokens`** 在 Responses 型上游没有对应端点,本地按请求体积估一个 `input_tokens`。
- **`/v1/responses/compact`** 归 Codex 组,`responses` 渠道**原样透传**到上游同名端点,
  不翻译、不降级;`chat` 网关会明确拒绝。
- **同渠道内自愈**:上游 5xx/429 且还没写出任何字节时,先轮换一代 `prompt_cache_key`
  重试(`MIXR_CONV_RETRIES`,默认 3),用完才换池里的下一个渠道。
- **可选工具参数**:两条转换线返回的工具调用会按本次工具 schema 清掉顶层非必填的空参数
  (`""`、`null`、空数组、空对象),保留必填字段、`false` 和 `0`。

### 思考强度(/effort)

客户端把强度放在 `output_config.effort`(`low`…`max`),代理按线路各自落地:

| 线路 | 落点 | 口径 |
| --- | --- | --- |
| Anthropic 直通 | `output_config.effort` 原样带上 | 不解释、不改值 |
| `wire_api: "responses"` | `reasoning: {effort}` | 只认 `low/medium/high/xhigh/max`;登记为不支持该字段的模型整字段不发 |
| `wire_api: "chat"` | 顶层 `reasoning_effort` | `xhigh` 夹到 `high`;认不出的值不发明默认档 |

请求日志的 `effort` 记的是**真的发上去的那一档**:原生 Responses 读取出站 `reasoning.effort`,
转换线读取转换结果,不是客户端想要的那档。两者的差正是"切了档却没效果"的案发现场。
客户端没选或渠道收不了这个字段时它是空的。

---

## 5. 上游健康:超时、重试

已知 Azure 输出项资源绑定错误使用协议限定投影:只有不含服务器历史引用、工具类型配对完整的
原生 Responses input 才移除受支持的 message/reasoning/function_call `id`,保持 `call_id`、
工具内容、加密推理、custom/additional_tools ID、session 和缓存身份。每请求最多投影一次,
重复故障同渠道/模型/Key 重发相同投影,计入已有总调用上限和时限。已提交输出后、
`/responses/compact`、普通 400 或其他协议的签名不改写。含
`previous_response_id`/`conversation`/`item_reference` 不删除引用,保留原始上游错误。
详见[资源绑定恢复边界](harness.md#资源绑定错误恢复)。

原生 Responses 的输出前连接中断、纯生命周期 EOF、明确临时错误与 HTTP408 也共用原预算
恢复。完整临时错误帧后同一批字节仅跟空生命周期、注释或严格的 `data: [DONE]` 标记时,
不会因这段无输出尾部放弃重试。已提交正文/推理/工具、未知/部分帧或超过 64KiB 的前缀不重放;
空 completed 不改成成功或额外重试。恢复开始后固定出站快照,
普通 HTTP 错误的已有 Key 备用/路由故障转移不受影响。

**加密 reasoning 有损降级**只在官方 AgentRouter HTTPS(`agentrouter.org` 或 `ps.air-outer.com`)
的原生 Responses 请求上启用。HTTP 400 或 2xx 响应中的错误必须精确包含
`code: invalid_encrypted_content`,且整个错误响应完整结束、未压缩、没有正文/推理/工具输出;
不凭部分 SSE 错误帧提前改写历史,未知字段或混合输出也不触发降级。
请求须带可严格校验的完整内联 `input`:无服务器历史引用、压缩项或未知项,工具调用与结果
一一配对且顺序完整。校验失败、没有加密 reasoning 或移除后无可用输入时保留原错误。
每请求最多降级一次:仅删除 reasoning 的 `encrypted_content` 和该 reasoning 自身 `id`,
保留其中可读的 `summary`/`content` 及所有其他项 ID;只有密文、无可读推理的项整体省略。
这是丢弃无法使用的密文,不是解密或无损恢复,不改写客户端会话存档。
降级重试保持渠道、模型、Key 和会话身份,与其他恢复共用已有上游调用次数及端到端总时限,
不另开预算。降级后的响应带 `x-mixrouter-recovery: encrypted-reasoning-dropped`,请求日志记
`retry_reason: encrypted_reasoning_downgrade`。鉴权、额度耗尽、上下文长度错误不触发这条降级;
已提交输出、截断或压缩错误不重放。上述能力仅在当前 HTTP 请求内恢复,
未接入 Codex/Harness 客户端 turn 自动续跑。

**Codex 的 Chat 输出前恢复**在 Chat → Responses 转换前最多暂存 64KiB SSE 前缀,
只把严格校验为空的 Chat chunk 或注释视为尚未输出。HTTP 200 SSE 内明确的临时错误
(包括已识别的限流/服务端临时错误)可在此窗口内同落点重试,不先发送合成 `response.created`
封死窗口;日志记 `retry_reason: chat_preoutput_retry`。输出前连接中断或仅空 chunk 后提前 EOF
也复用此窗口。临时错误后跟严格的 `data: [DONE]`、注释或空 chunk 仍可重试,
不是把错误当作成功完成。重试固定渠道、模型、Key 与出站快照,共用既有尝试次数和总时限,
不另开预算。一旦出现正文、推理、工具、带输出的终态、未知字段、压缩内容或超过前缀上限,不丢弃这些内容来
重放;断开/结束时仍有未完成的部分帧也不重放。鉴权、格式不兼容等终态错误不改成成功。

不可恢复的 Chat SSE `data.error` 转为 Responses `failed` 终态,保留原 `message` 及字符串/
数字 `code`;没有 code 才用 `upstream_stream_error`,不伪装为 `completed`。

验证边界:上述请求内恢复与可读推理转换不保证所有跨协议历史兼容;纯密文推理不能还原为
明文。未接入客户端 turn 自动续跑,也没有真实 GUI 续跑验证。

- **三段超时**,分别独立配置:
  `MIXR_FIRST_HEADER_TIMEOUT_MS`(发请求到收到响应头)、
  `MIXR_STREAM_IDLE_TIMEOUT_MS`(流式两次数据之间的最大间隔)、
  `MIXR_NONSTREAM_TOTAL_TIMEOUT_MS`(非流式从头到 body 结束)。
  另有 `MIXR_TOTAL_DEADLINE_MS` 作端到端总预算。
- **不设冷却**:429、4xx、5xx 与网络失败均不建立渠道或 Key 的禁用时间。旧 `MIXR_COOLDOWN_SEC` 参数不再生效。
- **重试**:一次请求有 `MIXR_MAX_ATTEMPTS` 个候选尝试配额(默认 10),每次重试前等待
  `MIXR_RETRY_DELAY_MS`(默认 1000,范围 0–60000 毫秒)。同一个渠道也会被重复尝试,
  转换重试共用额外配额,总调用上限见下文。失败后的渠道仍可参与后续请求,不需要等待恢复。
- **端到端总预算优先**:`MIXR_TOTAL_DEADLINE_MS` 用尽后不再重试,在途请求按超时收尾。
- **错误分型** `err_class`:`authentication`(401/403)、`rate_limit`(429)、
  `upstream_server`(5xx)、`upstream_request`(其余 4xx)、`timeout`、网络错误码、
  `network_error`、`cancelled`(客户端主动断开)。转移成功的请求也带首次失败的
  `err_class` + `failover` 标记。
- **客户端断开**(取消/进程退出):代理立刻掐掉在途的上游请求,落一条 `err_class: cancelled`
  的日志(状态 499),**不算**渠道失败。
- **只读健康视图** `GET /api/health`:三段超时与重试配置,以及每个渠道的
  `{provider, app, enabled, eligible, cooldown_until}`。`eligible` 是此刻是否可被挑选,
  `cooldown_until` 为旧客户端保留,恒为 `0`;`settings.cooldown_ms` 同样恒为 `0`。
- **其他兼容字段**:`GET /api/state` 的 `cooldowns` 恒为空数组、`cooldown_s` 恒为 `0`;
  会话列表每条记录的 `cooldown` 恒为 `false`;`/api/keys/health` 每行的 `until` 恒为 `0`
  (`state` 只有 `failed`,成功即删除该行)。这些字段不再参与任何挑选或重试决定。

已知限制:流式响应被掐断时只结束连接,**不补发**协议内 error 事件,客户端看到的是截断的
SSE。一次请求的上游调用总上界是 `MIXR_MAX_ATTEMPTS` + `MIXR_CONV_RETRIES`(默认 13);
`MIXR_CONV_RETRIES` 计的是同渠道内的换 Key / 换 cache 代际重试。
可用 `MIXR_MAX_UPSTREAM_CALLS` 进一步限制总次数(含首次调用),不扩大原有配额。
例如同时设 `MIXR_MAX_ATTEMPTS=50`、`MIXR_MAX_UPSTREAM_CALLS=50`,总调用数不会因额外配额超过 50。

---

## 6. 压缩分流与压缩窗口

压缩是**内容分流**,不是把整个会话改绑到压缩渠道。它由两条带 `when.body` 的内容规则承载,
在匹配顺序的第 1 段生效。

**识别判据**:只读**最后一条 user 消息的直接文本**块,必须以发行版 CLI 的压缩固定前导开头,
并包含摘要模板。system、历史消息、工具结果或仅仅引用特征短语的编程任务都不算。
普通 `when.body` 规则仍按当前请求的 system/instructions + 最后一条消息做子串匹配,不扫历史。

**专用模型 / Key**:`GET/POST /api/compact` 选择渠道、模型及该渠道的 Key,一次同步两条
压缩规则、替换旧备池,**不修改主模型和普通路由**。

- Key 默认跟随渠道当前 Key;固定 `key_id` 只影响压缩规则,不改 `active_key`、槽位或普通转发。
- 固定 Key 只支持单渠道,不能与 `pool` 并用;失效时返回 `provider_key_unavailable_error`,
  不悄悄改用当前 Key。下拉只显示标签与 ID,不显示密钥。
- 单一目标被删后仍显示原渠道与 Key ID(`enabled: false`),让你能看见并修复失效绑定。

**压缩上下文窗口**:`GET/POST /api/compact/window` 改 Claude Code 磁盘配置里的
`autoCompactWindow`,可选三层:

1. 用户全局(`~/.claude/settings.json`)
2. 项目 `.claude/settings.json`
3. 项目本地 `.claude/settings.local.json`

项目层与本地层必须提供项目绝对路径;未提供时无法核对该项目的覆盖,界面显示的是磁盘设置,
不冒充活会话实际窗口。取值接受 `100k`–`1M` 或 `auto`(`auto` 只删除所选层的键并继承,
不是关闭自动压缩,也不清除环境覆盖)。

边界:

- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 环境值优先;托管策略与 `--settings` 也可能覆盖;
  控件无法清除环境覆盖。
- 保存用 `expected_revision` 防覆盖已变更的配置,已有文件先留私有备份;外部写入与保存之间
  仍有极小的检查—替换竞争窗,**备份不是文件锁**。
- 保存**不会热改运行中的会话**;项目层设置须新开会话,或退出后在该项目目录用
  `claude --continue` 继续。
- 窗口值不是最终触发 token 数,还受客户端策略和模型上限影响;本控件不修改压缩禁用开关。

**Codex 自动压缩阈值**在 Codex 页面单独编辑,不共用 Claude 的窗口控件。
`GET /api/codex/config` 返回磁盘快照与 `codex.compaction`;
`POST /api/codex/config` 接受
`{action:"compact_threshold", model_auto_compact_token_limit:250000, revision:"当前版本"}`。
取值为正安全整数 token 数,或 `250k` / `0.5m` 等字符串;`auto` / `null` 只删除顶层阈值键,
不是关闭自动压缩。缺少值、零、负数、布尔、对象、非整数 token 数和溢出均在写入前拒绝。

- 只改所选全局 Codex 配置里的 `model_auto_compact_token_limit`,不改模型、推理强度、
  `model_context_window`、目录、权限、MCP、其它客户端或压缩路由。
- 保存沿用 Codex 的私有备份、原子替换与 revision 冲突检查;版本已变返回 409,
  当前明确选择 profile 时拒绝全局写入。profile、项目与命令行覆盖不在本控件范围内。
- `compaction` 的 `configured` / `default_limit` / `effective_limit` 是磁盘推算,不是运行测量。
  已知窗口优先取显式窗口,显式值按目录 `max_context_window` 截断;
  未显式配置时取当前已同步目录的 `context_window`,缺少时才取 `max_context_window`。
  阈值上限是窗口的 90%,而可用上下文百分比(通常 95%)不是压缩公式。
  目录自带阈值作为模型默认;显式阈值覆盖默认,两者仍受已知 90% 上限约束。
  配置值超限仍原样保存,`capped` 和提示标明推算有效值,不静默扩大窗口。
- 窗口/默认值未知时返回 `null` 并说明上限未确认,不复制其它模型的 1M 或内置回退值。
  自动同步槽位会保留显式阈值,不会为了新模型改写它。
- 保存只更新磁盘,需 Codex 重新读取配置;重新打开客户端并新建会话是明确的读取方式。
  不重启客户端、不热改活会话,服务升级本身也不自动写入某个数值。

---

## 7. 只读诊断(explain)

```bash
./mixctl explain claude claude-opus-5
./mixctl explain codex gpt-5 --kind chat/completions
./mixctl explain claude claude-opus-5 --session cc:完整会话键
./mixctl explain --input preview.json
echo '{"app":"claude","model":"m","context":{"bodyText":"…"}}' | ./mixctl explain --input -
```

`--input` 与位置参数、`--kind`、`--session` 互斥;两种形态都不接受在 argv 里明文写凭据。
它吃的是**预览输入对象**(`{app, model, kind?, context?}`),不是原始请求体:
`context.bodyText` 给普通 `when.body` 规则用,`context.compactTexts`(字符串数组,
末条 user 消息的直接文本块)给压缩判据用。

三条边界:

- **只解释当前快照,不是承诺**。首选渠道是"此刻这条请求会落到哪",不保证上游成功,
  也不代表重试之后的落点。`random` 策略只给候选、不预测;`round_robin`/`weighted` 给的是
  当前游标下的下一位,预览不消耗它们。
- **零副作用**。不写日志、不建会话、不发上游请求、不改槽位与游标;
  已有会话粘性与 `least_used` 计数都在副本上重算。
- **不回显敏感内容**。渠道字段走白名单(`id/name/model/models/wire_api/ua/enabled/slots`),
  `base_url`、`api_key`、`keys`、`active_key`、请求头原文一律不出现;`when.token`
  只回显 `{present, len}`。展示数组触顶时在 `warnings` 与 `limits.arrays` 里注明省略条数。

错误码与实跑对齐:`provider_disabled` / `wire_api_mismatch` / `no_route` 分别对应实跑的
`*_error` 形态;`bad_app` / `bad_model` / `kind_app_mismatch` 是预览专有码。

### 离线故障注入的参数上限

`node scripts/diagnose-upstream.js` 默认离线:起真实临时 mixrouter,上游只连本地故障桩,
不读真实渠道配置或 Key。`--scenario` 可选
`mixed|success|429|500|first-byte|idle|deadline|401`。

| 参数 | 默认 | 硬上限 |
| --- | --- | --- |
| `--concurrency` | 2 | 8 |
| `--requests` | 8 | 100 |
| `--duration-ms` | 5000 | 30000 |
| `--timeout-ms` | 2500 | 5000 |

总请求数指客户端请求,每条最多两次本地上游调用;时长同时约束发送窗口与在途请求,
另有启动 5 秒、取证 2 秒、清理 1.5 秒上限。离线结果只说明该次本地故障场景,
不能外推到真实上游的可用性。

### 单渠道限量诊断(显式确认)

渠道模式会产生费用、可能触发限流。`--confirm-run` 是执行确认,**不等于取得账号使用授权**。

```text
MIXR_DATA_DIR=/absolute/path node scripts/diagnose-upstream.js --mode provider --provider ID --requests N --confirm-run [--model NAME]
```

必须显式指定 `--mode provider`、`--provider`、`--requests`、`--confirm-run`,
并设置绝对路径 `MIXR_DATA_DIR`。只读取该目录的 `providers.json`,只调用指定的一个启用渠道;
不接受命令行 URL 或 Key,不自动选其他渠道、不扫描,不读取模型列表。凭据用该渠道当前
`api_key`,模型依次取 `--model`、渠道 `model` 或 `models` 首项;无已知模型就拒绝。
只发 ping 与低输出上限(`max_tokens=1`,`max_output_tokens=16`),不重试、不跟随重定向,
单次响应读取超过 1MiB 即停止,不保存或输出响应正文。报告不含 Key、URL 或原始网络错误。

| 渠道模式参数 | 默认 | 硬上限 |
| --- | --- | --- |
| `--concurrency` | 1 | 4 |
| `--requests` | 必须显式指定 | 20 |
| `--duration-ms` | 5000 | 30000 |
| `--timeout-ms` | 3000 | 5000 |

时长到点同时停止发送并取消在途请求。实现已用临时配置与本地 mock 验证,
**未实际测试真实上游**,没有使用真实账号取得性能结论,低输出上限也不承诺零费用。

---

## 8. 请求日志、统计与归档

### 请求日志

`<MIXR_DATA_DIR>/logs/requests.jsonl`,每条一行,字段以 `LOG_FIELDS` 白名单为准。按 **UTC 跨日 + 5MiB**
轮转,使用不覆盖的唯一归档名,默认保留 30 天;gzip 默认关闭,`MIXR_LOG_COMPRESS=on` 启用。
旧 `requests.jsonl.old` 可查但不覆盖、不压缩、不自动清理。

关键字段:

| 字段 | 含义 |
| --- | --- |
| `attempts` / `failover` | 实际网络尝试次数 / 是否发生过失败转移 |
| `request_id` | 本进程请求 ID，可关联有界内存尝试过程；旧日志没有此字段，过程过期不补造 |
| `err` / `err_class` | 终态错误文本 / 错误分型 |
| `retry_reason` | 最近一次已执行的恢复类型:`resource_binding_recovery` 为 Azure 资源 ID 投影,`native_history_recovery` 为官方 AgentRouter 窄历史错误投影,`projected_resource_retry` 为重复发送已投影历史;`unprojected_resource_retry` 为历史不改写的资源错误重投,`encrypted_reasoning_downgrade` 为加密推理有损降级,`chat_preoutput_retry` 为 Codex Chat 输出前重试 |
| `resource_recovery_skipped` | 资源投影或恢复未执行的固定分类,多个不同原因按首次出现用 `+` 连接;可能与成功重投的 `retry_reason` 同时存在,不表示历史已被投影 |
| `bytes_in` | 客户端请求体字节数(不是 token)。大上下文/带截图时可达十几 MB,而首字延迟主要由它决定 —— 上游面板只从收完请求体开始计时 |
| `ttfb_ms` | 请求开始 → 上游首个响应头到达的毫秒数(多次尝试取最终给出响应的那一发;全部失败记到收尾)。`0` 表示没测到(如本地估算的 count_tokens) |
| `slot` | 命中的槽位;空槽记 `none`,缺字段的旧日志记 `unknown` |
| `sticky` / `strategy` / `rule` | 是否走了会话粘性 / 策略 / 命中的规则 id |
| `key_id` / `key_source` | 用哪把 Key(**非明文**的来源标记) |
| `effort` | 真的发上去的思考强度档位 |
| `model_in` / `model_out` | 客户端说的模型 / 实际发给上游的模型 |
| `think` / `reasoning` / `tools_dropped` | 排查上游 400 的证据 |

`resource_recovery_skipped` 保留历史校验分类(如 `unsupported_item_id`),并补充
`no_native_state`、`response_committed`、`request_finished`、`client_closed`、`deadline_exceeded`。
已识别资源错误但首次恢复就被重试预算拒绝时记 `retry_budget_exhausted`;若之前已执行过恢复,
以 `retry_reason` 和 `attempts` 说明发生过什么。旧版本没有这些记录,不能用字段缺失推断恢复从未执行。

日志**不含 Key 明文**,也不含会话标签;内容包括渠道名、模型名、会话键(哈希/ID 形态)
与错误文本。

路由准备阶段的拒绝(无路由、渠道停用、协议不匹配、固定 Key 不可用等)在 HTTP 返回错误前
同步追加日志,记录短会话身份、请求模型、状态码与错误码;`attempts` 为 0,`provider`、
`model_out`、`rule` 与 `slot` 为空,tokens 为 0,不臆测尚未取得的路由计划。这些拒绝不发上游;
记录日志不额外创建/结算会话、不计为 active、不创建尝试过程。无路由失败不新建会话,
但固定 Key 错误等准备路径此前可能已有会话记录。不回填历史拒绝;Host、跨站来源、内容类型与
坏 JSON 等入口校验错误不写这类日志。
Codex `no_route_error` 的日志 `err` 以固定布尔诊断
`[Codex identity: native=<bool>, local_auth=<bool>, reliable_session=<bool>]` 开头,
截断错误文本时仍保留身份诊断,HTTP 错误 message 原样不改。日志脱敏也覆盖本次客户端令牌
(即使它未登记),不保存凭据、原始 UA、请求头或请求体;三个值不能替代旧 ID 登记与受管配置检查。

**查询**:`mixctl logs` 走运行中服务的 `GET /api/logs`,默认查内存环(最近 500 条),
默认返回 20 条;重启后内存环重新开始,查旧记录用 `--history`。
`--since` / `--until` 含边界,接受 ISO 时间或 epoch 毫秒;`--provider`、`--model`、
`--session`、`--err_class` 是忽略大小写的子串筛选,`--slot` 精确匹配,`--status` 接受
`ok`、`err` 或具体状态码。`--history` 每页最多 1000 条,响应给 `scope`、`skipped` 和
`next_cursor`。

游标是当前进程的历史快照,按物理追加顺序从新到旧读;最多保留 15 分钟,进程最多 32 个快照。
`CURSOR_EXPIRED` 时重新发起历史查询,`CURSOR_INVALID` 时检查游标和筛选条件。
**不能把游标当永久书签。**

控制台连不上时,`mixctl logs [条数]` 退回本机 `requests.jsonl` 的只读尾读(有界反读、
坏行跳过);带选项的查询没有文件版对应物,会明确报错。只有**连不上**才退回,API 真报错
原样报到 stderr 并以非 0 退出。

### 统计与指标

统计包含新记录的路由准备阶段本机拒绝,它们增加失败请求数但不增加 tokens;
0 tokens 本身不能证明是否调用过上游,需结合 `attempts`、错误码与实际落点判断。

- `GET /api/stats` 聚合当前内存窗口;`history=1` 查磁盘历史,可带相同时间与筛选条件。
  两者都返回 `scope` 与 `range`,历史统计另带跳过条数,不提供历史延迟分位数。
- `by_slot` 按日志里明确记录的槽位累计请求、输入/输出 token 和缓存 token;
  空槽记 `none`,旧日志缺字段记 `unknown`,不拿模型名或会话类型猜槽位。
- `GET /api/metrics` 是 Prometheus 文本端点(进程生命周期 counter + 内存窗口 gauge),
  标签集固定,不按会话或对话标签展开。这是用量统计,不做金额折算,也不是预算限流。
- `GET /api/usage?range=&app=&provider=&model=&from=&to=` 读磁盘日志(含轮转归档)并可补上
  内存环里更新的条目,按本地时区分桶补齐空桶。`range` 取 `today`(默认)/`24h`/`7d`/`30d`/`all`;
  同时给 `from`/`to`(ISO)即自定义区间。返回 `scope`、`totals`、`series`、`by_provider`
  与 `by_model`。`totals` 为 `{reqs, ok_rate, tokens_in, tokens_out, cache_read, tokens_total,
  cache_hit_rate, speed_tps, ttfb_p50_ms}`;`series` 每桶为 `{t, reqs, tokens_in, tokens_out,
  cache_read}`;`by_provider` / `by_model` 每项为 `{provider, name | model, reqs, tokens_in,
  tokens_out, cache_read}`,按请求数降序。
  `series[].t` 是本地时间:`bucket=hour` 为 `YYYY-MM-DDTHH:00`,`bucket=day` 为 `YYYY-MM-DD`。
- 控制台使用 `GET /api/usage?dashboard=1`。这是显式扩展;不带它的旧调用保持原字段与子串筛选。
  扩展模式下 `provider` 精确匹配日志供应商名,`model` 精确匹配实际模型(`model_out || model_in`),
  `status=ok|err` 筛选请求结果;带错误信息的 200 也算失败。时间、协议组、供应商、模型与状态
  同时约束指标、日历与三类明细,不把磁盘累计和内存日志窗口混在一起。
  原响应额外包含 `dashboard`:
  - `daily`:按本地日期汇总的 `{t, reqs, tokens_in, tokens_out, cache_read}`。
  - `records`: `{rows, total, offset, limit, has_more}`。`rows` 只含日志白名单字段,
    按时间倒序;`offset` 默认 0,`limit` 默认 50、最多 200(超出按上限截断)。每次同步为当前快照,
    翻页不是永久游标。`offset` / `limit` 非非负整数、或 `status` 不是 `ok|err` 时返回 400,
    错误码分别是 `USAGE_PAGINATION_INVALID` 与 `USAGE_STATUS_INVALID`。
  - `facets.providers` / `facets.models`: `{value, label}` 选项。按时间、协议组与状态生成,
    不被当前供应商/模型选择截成单一选项;选择没有结果时不会静默清空筛选。
  - `coverage`: `{first_ts, last_ts}` 是当前可用日志的观测边界(筛选前),不是连续完整保留的承诺;
    无日志时为 `null`。默认保留 30 天,不为画满一年的格子而改保留设置。

### 返回归档(显式开启)

默认关闭,只有以 `MIXR_RESPONSE_ARCHIVE=on` 启动才开启。目录默认
`<MIXR_DATA_DIR>/logs/responses`,可用 `MIXR_RESPONSE_ARCHIVE_DIR` 指向另一个私有目录。

- 每次 HTTP 上游尝试单独建目录,含 `raw-response.bin`、`metadata.json` 和可解析时的
  `returned-thinking.txt`。raw 保存响应体字节(已知凭据会替换),不含 HTTP 头,
  不保存请求 prompt 或请求头。派生文本只提取上游实际返回的 thinking/reasoning 字段,
  Responses 的 summary 明确标为 summary。
- 目录权限 `0700`,文件 `0600`;已有根目录不是私有普通目录时拒绝归档。
  raw 与 derived 分别最多 16MiB,根目录最多 100 份,额度满后停止新增,**不自动删除旧档**。
  超限、积压或写盘失败只停止归档并报告,不阻断正常转发。
- 已知渠道 Key 与本次客户端凭据会被替换,但这是有限的凭据脱敏:
  **响应正文仍可能含其他敏感数据**。不要把归档目录当成可公开日志。

### 运行期日志清理

`responses` 归档目录与 `logs/launchd.log` 由 `lib/log-retention.js` 清理,
默认保留 2 天(`MIXR_LOG_RETAIN_DAYS`,`0` 关闭),周期 `MIXR_LOG_SWEEP_MS`(默认 6 小时)。
服务启动即清一次,之后按周期清。也可以手动 `./mixctl gc`(预览)、`--apply`(真删)、
`gc 7 --apply`(按 7 天)。服务内定时器与命令共用一份逻辑,靠 `logs/.retention.lock` 串行,
服务在跑时执行也安全。单轮最多删 2000 个归档目录,撞到上限时改用 30 秒短周期追赶。
`requests.jsonl` 不归这里管。

---

## 9. 备份与还原

保留池与命名:

| 位置 | 内容 | 保留 |
| --- | --- | --- |
| 与现役文件同目录的 `<文件>.bak-mixui-<YYYYMMDD-HHMMSS-mmm-rrrr>` | 每次改写客户端配置 / 渠道库前自动留一份 | 同前缀按字典序排序,删掉最前 `max(0, len - keep)` 个;`keep = 5` |
| `<安装根>/backups/` | 历史备份归档(手工移入) | 本地留存,`.gitignore` 已排除 |
| `*.bak` / `*.bak-*` / `*.bak.*` | 手工排查留下的副本 | 不入库 |

历史秒级命名(同秒内两次备份会覆盖)在清点里标为 `legacy`。清点会告诉你下一次备份会删
哪几份,但**删除照做**,没有"停下等我另存"这一步。

三处备份池:`providers.json`、Claude `settings.json`、Codex `config.toml`。
**ZCode 与 Harness 的备份暂未纳入清点表。** Harness 接入返回其 profile/凭据备份路径,
不在 `mixctl restore` 自动还原范围内。路径可分别用 `MIXR_DATA_DIR`、`MIXR_CLAUDE_SETTINGS`、
`MIXR_CODEX_CONFIG` 覆盖。

`mixctl restore` 的边界:

- **默认只预览**,显式 `--yes` 才写入;`--dry-run` 与 `--yes` 不能同时使用。
- 只接受受管文件**原目录**里的 `.bak-mixui-*`;未给 `--file` 时按备份名推导受管现役文件,
  推不出或有歧义就拒绝(`undecidable_target`)。
- 备份和现役文件都必须存在且为普通文件;拒绝符号链接、硬链接、目录和超过 512KiB 的文件。
- 备份内容须通过 UTF-8 与格式校验;TOML 只接受普通表、单行字符串、布尔、十进制数,
  其他合法语法报 `unsupported_toml`——这是拒绝自动恢复,不是判定配置损坏。
- 写入前另存安全备份,保留全部旧备份,不执行轮换;原子替换后**不会自动重启任何进程**。

覆盖范围就是上面三处受管文件(`providers.json`、Claude `settings.json`、Codex `config.toml`)。
**ZCode 的 `~/.zcode/v2/config.json` 不在 `mixctl backups` / `mixctl restore` 的范围内**,
恢复 ZCode 配置请用它的备份文件手工替换。

恢复前请停止对应客户端与路由器,成功后再重启。`providers.json` 恢复后要重启 mixrouter
——运行中的路由器内存不会自动刷新。

---

## 10. 环境变量

路径类与端口类都在 `mixrouter.js` 模块顶层读取,必须在 `require()` **之前**设好;
require 之后再改不生效。

下表保留原始入口 `npm start` / `node mixrouter.js` 的默认值。
新入口 `npm run local` 会先设置固定数据目录 `~/.local/share/mixrouter/data`,再启动服务;
命令行 `--data-dir` / `--port` / `--ui-port` 优先于对应环境变量。
`npm run doctor` 使用同一套路径选择,旧部署需显式给出原数据目录。
`MIXR_INSTALL_PREFIX` 可改变新入口的默认安装根,数据位于该根的 `data/`。
这些入口不修改客户端配置或现有常驻配置。

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `MIXROUTER_PORT` / `MIXUI_PORT` | 8787 / 8788 | 代理口 / 控制台口 |
| `MIXROUTER_ALT_PORTS` | 空 | 逗号分隔,在这些端口上也服务同一个代理 |
| `MIXR_DATA_DIR` | 仓库根 | providers / routes / slots / harness / sessions / logs 的总目录 |
| `MIXR_LOG_RETENTION_DAYS` | 30 | 新请求日志归档保留天数(0–36500);`0` 永久保留 |
| `MIXR_LOG_COMPRESS` | 关 | 仅 `on` 启用新请求日志归档 gzip |
| `MIXR_LOG_RETAIN_DAYS` / `MIXR_LOG_SWEEP_MS` | 2 / 21600000 | responses 归档与 launchd.log 的保留天数与清理周期 |
| `MIXR_CLAUDE_SETTINGS` | `~/.claude/settings.json` | Claude Code 客户端配置 |
| `MIXR_CODEX_CONFIG` | `~/.codex/config.toml` | Codex 客户端配置 |
| `MIXR_ZCODE_CONFIG` | `~/.zcode/v2/config.json` | ZCode 客户端配置 |
| `MIXR_HARNESS_PROFILE` | `<DSH_HOME 或 ~/.dsh>/profiles/desktop/cordis.patch.yml` | Harness 预览/确认接入的字面量 patch 配置路径 |
| `MIXR_RESPONSE_ARCHIVE` | 关 | 仅 `on` 开启上游响应正文归档 |
| `MIXR_RESPONSE_ARCHIVE_DIR` | `<MIXR_DATA_DIR>/logs/responses` | 返回归档私有目录 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 未设 | 压缩窗口的环境覆盖,优先于磁盘设置 |
| `MIXR_UPSTREAM_PROXY` / `MIXR_UPSTREAM_PROXY_BYPASS` | 空 | 出站 HTTP CONNECT 隧道;环回地址永不隧道 |
| `MIXR_UPSTREAM_IDLE_MS` | 5000 | 出站空闲连接回收阈值;`0` = 关掉空闲计时 |
| `MIXR_UPSTREAM_CONNECT_TIMEOUT_MS` | 15000 | 直连 DNS/TCP/TLS 初次建连硬截止,握手后清理;正整数 1–600000,非法值或 0 回默认;不改模型等待预算 |
| `MIXR_BODY_LIMIT_MB` | 64 | 请求体上限 |
| `MIXR_TOTAL_DEADLINE_MS` | 240000 | 端到端总预算 |
| `MIXR_FIRST_HEADER_TIMEOUT_MS` | 120000 | 等上游响应头 |
| `MIXR_STREAM_FIRST_HEADER_TIMEOUT_MS` | 60000 | 恒流式形状的等响应头预算 |
| `MIXR_STREAM_IDLE_TIMEOUT_MS` | 90000 | 流式两次数据之间的最大间隔 |
| `MIXR_NONSTREAM_TOTAL_TIMEOUT_MS` | 180000 | 非流式响应从头到 body 结束 |
| `MIXR_SSE_KEEPALIVE_MS` | 15000 | 已提交给客户端的流补 SSE 注释的间隔;`0` 关掉 |
| `MIXR_COOLDOWN_SEC` | 不再生效 | 历史参数;渠道与 Key 已移除时间冷却 |
| `MIXR_MAX_ATTEMPTS` / `MIXR_CONV_RETRIES` | 10 / 3 | 候选尝试配额(同一渠道可重复)/ 同渠道内换 cache 代际额外重试配额 |
| `MIXR_MAX_UPSTREAM_CALLS` | 两项配额之和 | 可选的总调用硬上限(含首次),只收紧预算,范围 1–200 |
| `MIXR_RETRY_DELAY_MS` | 1000 | 每次重试前的等待毫秒数(0–60000) |
| `MIXR_SESSION_TTL_MIN` / `MIXR_SESSION_MAX` | 720 / 1000 | 会话绑定空闲失效时间(分钟)/ 会话表上限 |
| `MIXR_SESSION_LABEL` | 开 | `0` 关掉会话标签采集 |
| `MIXR_SESSION_CLI_TIMEOUT_MS` | 10000 | `mixctl sessions` 每次请求的有界超时 |

---

## 11. 已知环境坑

- **fake-IP 模式的网络**(198.18.0.0/15):不存在的域名会被劫持,TLS 直接重置——
  「TLS 断连」多数是域名不存在而非网络故障。这类网络里给出站隧道
  `MIXR_UPSTREAM_PROXY=http://127.0.0.1:7890`(HTTP CONNECT,支持 `user:pass@`),
  隧道不通时渠道测试会直接报「出站代理不可用」,不会用直连结果报"通"。
- **国内站点不该进境外隧道**:在渠道上标 `direct: true`,该渠道的转发与探活一律直连,
  `MIXR_UPSTREAM_PROXY` 设了也不进隧道。探活也跳过"先探隧道"那一跳。
- **出网若是 TUN 模式**(系统级已接管路由),**不要再设** `MIXR_UPSTREAM_PROXY`
  ——填一个没人监听的端口会把本来能通的上游全弄死。
- **响应头的值只能是 latin-1**:渠道名里的非 ASCII 字符在 `x-mixrouter-*` 头里会被消洗
  (日志与控制台不受影响)。
- **有网关校验客户端形态**:部分网关对 `User-Agent` 有硬要求(裸 `curl/…` 直接 401),
  Codex 型通道只认 `codex_cli_rs/…`。渠道的 `ua` 字段就是给这种上游固定 UA 用的。
