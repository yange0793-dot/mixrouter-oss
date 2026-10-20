# 路由与会话

这份文档讲的是「一条请求最后落到哪个渠道的哪把 Key」这件事。规则怎么配的字段清单见
[`quick-start.md`](quick-start.md) §2,这里讲判定顺序、会话身份、覆盖语义与压缩分流。

一句话前提:**匹配顺序是固定的四段,槽位别名与显式配置都优先于自动推断**。

---

## 1. 匹配顺序(唯一定义在 `lib/routing/resolve.js`)

`resolveRoute()` 按下面的顺序求值,命中即返回:

| # | 阶段 | 说明 |
| --- | --- | --- |
| 1 | **内容分流** | 带 `when.body` 的规则,按 `priority` 降序评估;先于槽位别名与普通规则 |
| 2 | **槽位别名** | 请求模型名**精确等于** `mixr-<槽名>` 时命中,优先于一切普通规则 |
| 3 | **普通规则** | 按 `priority` 降序,命中首个启用且满足 `when` 的规则 |
| 4 | **兜底路由** | 都不命中时走 `default`;它**尊重自己配置的 `strategy`**,不是一律轮转 |

`mixctl explain` 与 `POST /api/routing/preview` **复用同一个 resolver** 的 trace 回调,不另写一套
匹配算法。预览只解释当时快照;配置、健康或池游标随后变化,以及重试/失败转移,都可能让实跑落点不同。

槽位没命中时,预览会把"像别名但不是"说清楚:`slot_unbound_falls_through`(别名在槽位表里但没绑
渠道,会静默落到普通规则)与 `no_such_slot`(压根没这个别名)是两个不同的结论。

---

## 2. 槽位路由(把某个槽钉到某个渠道 @ 模型)

槽位表全局只有一份,存在 `<MIXR_DATA_DIR>/slots.json`(`{ version: 1, claude, codex }`,
`mixrouter.js` 的 `saveSlots`)。别名由 `lib/routing/slots.js` 的 `slotAlias()` 生成:
`mixr-` + 槽名。

**Claude Code 五个固定槽**(`CLAUDE_SLOTS`),别名写进客户端 env 的键名在 `CLAUDE_SLOT_ENV`:

| 槽 | 别名 | 客户端 env |
| --- | --- | --- |
| `main` | `mixr-main` | `ANTHROPIC_MODEL` |
| `opus` | `mixr-opus` | `ANTHROPIC_DEFAULT_OPUS_MODEL` |
| `sonnet` | `mixr-sonnet` | `ANTHROPIC_DEFAULT_SONNET_MODEL` |
| `haiku` | `mixr-haiku` | `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| `subagent` | `mixr-subagent` | `CLAUDE_CODE_SUBAGENT_MODEL` |

`fable` 槽已移除(Claude Code 在当前接法下不消费 `ANTHROPIC_DEFAULT_FABLE_MODEL`),
加载时会从内存槽表清理旧 `fable` 与未知 Claude 槽,**不因启动而改写磁盘槽表或客户端配置**。

**Codex 自拟槽名**:槽名须匹配 `^[a-z0-9][a-z0-9-]{0,23}$`(`CODEX_SLOT_NAME_RE`),
如 `worker`、`reviewer`;路由模式下直接 `codex exec -m mixr-worker`。`GET /v1/models` 也会列出这些别名。

槽位落点的三条性质:

- **不走会话粘性、不复用对话钉定**。槽位请求按槽位自己的池策略挑选;被手动改绑过的对话
  不会把槽位请求拽到钉定的渠道上(那会把槽位的落点模型发给错的账号)。
- **槽位可以配后备池**。在槽位绑定的主渠道之外,`pool` 里只写**后备成员**即可——
  `resolveSlot` 会自动把槽位的 `provider` 排到池首(不用重复写主渠道);`strategy` 默认
  `priority`,主渠道不可用时落到后备。备池通过 `PUT /api/slots` 或 `slots.json` 维护;
  控制台的槽位面板会显示已有备池,但只提供渠道与落点模型两个编辑项——面板保存对
  `pool` / `strategy` / `dropTools` 是部分更新,不会把它们抹掉。
- **不改变对话的渠道绑定**。槽位请求只代表"这一条请求"照槽位表走,既不会把对话重新绑到
  槽位渠道。槽位自己配了 pool 时,它会推进**槽位自己的**池策略游标(与普通规则的游标分开)。
  渠道停用/删除会得到明确的
  `provider_disabled_error` / `no_route_error`。

```bash
./mixctl slots                  # 查看槽位表(别名 → 渠道 @ 模型)
./mixctl route claude --slots   # 切路由模式并同时写入槽位 env
```

### 主链 + 子代理双路(`/api/claude/split`)

「主链固定走便宜渠道,子代理换来源」这类配置,原先要在控制台逐槽绑定,容易漏改某一槽。
`mixctl split` 把它收成一次原子操作:

```bash
./mixctl split p-main main-model p-sub sub-model --apply    # 主链四槽 + 子代理槽
./mixctl split subagent p-alt alt-model[1M] --apply         # 只换子代理来源
```

- 一次请求里 `main` / `opus` / `sonnet` / `haiku` **四个槽绑定同一个**「渠道 @ 模型」,`subagent`
  单独绑一个——这样任一副槽漏配都不会悄悄回落到主链模型上。
- 换来源只改槽位表:已在运行的进程下一次请求就读到新落点(读内存槽表),**不必重启**;
  不带 `--apply` 时只落 `slots.json`,**不碰客户端配置**。
- 两路各用各的 Key:转发时按命中渠道取上游凭据,客户端送来的 token 顶不掉它。
- 重启不回放旧快照:客户端 env 只在 `--apply` 时写一次,进程启动只读 `slots.json`。

---

## 3. 会话级渠道分发(同一个 Agent 的多对话走不同渠道)

想让同一个 Agent 里**不同的对话用不同渠道的 Key**,不用多开客户端:把路由规则的目标设成
**渠道池**即可。

### 对话身份是怎么认出来的

按可靠性依次兜底(`lib/session/identity.js`):

| 客户端 | 1 | 2 | 3 |
| --- | --- | --- | --- |
| Claude Code | `x-claude-code-session-id` 头 | body `metadata.user_id` 里的 `session_id` | 内容指纹 |
| Codex | `session-id` / `thread-id` / `x-client-request-id` 头 | body `prompt_cache_key`、`client_metadata.session_id` | 内容指纹 |

两种客户端的会话键前缀不同、互不串味:Claude 是 `cc:`(头/元数据)与 `fp:`(指纹),
Codex 是 `cx:` 与 `cxf:`。都没有(自定义客户端)就用「system/instructions + 首条用户消息」做
sha1 内容指纹,同内容即同对话。

同一个对话里的所有请求——包括子代理、`count_tokens`、标题生成——只要客户端带了同一身份,
就共享会话键,默认落在同一个渠道上,不会因为中途换 Key 打断 prompt 缓存。这是**默认**,
不是绝对保证:槽位请求按槽位表走、内容分流命中的请求不参与粘性、失败转移会把对话改绑到
成功的渠道,显式改绑与会话覆盖也会改变落点。

### 池策略(`strategy`,五种)

| 策略 | 行为 | 适合 |
| --- | --- | --- |
| `round_robin`(默认) | 新对话依次落到下一个成员;游标按**规则 id**存在跨请求的表里,同一规则下所有会话共用 | 均摊额度,最好预料 |
| `weighted` | 平滑加权轮询(nginx 式),按成员 `weight` 比例;成员冷却恢复后会重新进入轮转 | 主力渠道多分点 |
| `least_used` | 优先给当前挂载对话最少的成员 | 成员额度不等、想动态均衡 |
| `random` | 随机 | 无特殊要求 |
| `priority` | **永远取池序里第一个可用渠道**,主渠道冷却中才落到下一个(主备降级语义) | 主备 |

池成员冷却是动态的:冷却/熔断中的成员通常不参与首选;全池未通过预检时,首选策略会退回全量候选。
冷却中的渠道可能再试,但熔断开路仍由健康许可硬闸门拦截,不会发起上游请求。

### 失败转移与冷却

池里选中的渠道返回 429/5xx 或连不上时,代理会在**尚未向客户端写任何字节**之前换下一个成员重试
(候选数由 `MIXR_MAX_ATTEMPTS` 封顶,默认 3),并把坏渠道打入冷却(默认 60 秒,`MIXR_COOLDOWN_SEC`),
同时把该对话重新绑到成功的渠道。全部失败才回 502。

同一渠道内的协议转换线另有自己的重试预算:`MIXR_CONV_RETRIES`(默认 3,`responses` 线上是轮换
`prompt_cache_key`)。

### 手动改绑(钉定)

控制台「会话」页在「当前绑定 → 普通请求渠道」展开下拉,改绑某个对话到指定渠道。
**手动指定压过普通请求的池策略**,且允许指定池外的渠道;槽位与内容分流请求不受这个钉定控制。
`POST /api/sessions/:key/pin` 就是这条路径;置空 = 解除钉定,下次请求重新按策略分配,
**保留**这条会话已有的 Key / 槽位覆盖。`DELETE /api/sessions/:key`(控制台「解绑」)
则是删除整条会话记录,连同覆盖一起删除。

**钉定属于显式配置**:它不会被空闲 TTL 或容量自动回收——修的是"手动配置被静默丢弃"。
代价是长跑实例里钉定会长期留在会话表,受 `MIXR_SESSION_MAX`(默认 1000)约束。

> 相关环境变量:`MIXR_SESSION_TTL_MIN`(默认 720 分钟)、`MIXR_SESSION_MAX`(1000)、
> `MIXR_COOLDOWN_SEC`(60)、`MIXR_MAX_ATTEMPTS`(3)、`MIXR_SESSION_LABEL=0`(关掉对话标签采集)。
> 对话标签存在 `sessions.json` 的会话记录里,**不写进请求日志,也不进 `/api/metrics`**;
> 也就是说 `sessions.json` 含对话内容片段,属于敏感文件。`MIXR_SESSION_LABEL=0` 关闭采集。

---

## 4. 会话级 Key 与槽位覆盖

同一个渠道里有多把 Key 时,默认所有对话都用该渠道当前生效那把。想让**某一条对话**固定烧另一个
账号、或单独换掉某个槽位的落点,给这条会话配**覆盖**。

控制台「会话 → 当前绑定 → 配置 Key / 槽位」按行展示 main / opus / sonnet / haiku / subagent,
每行独立选择渠道、落点模型与 Key;模型下拉包含渠道登记项和「自定义模型…」。未覆盖项显示继承的
全局落点,可逐槽恢复继承。也可「复制全局槽位为独立配置」后再改:只复制未覆盖槽位的渠道与模型,
**不复制全局后备池**,不改已有覆盖。渠道级 Key 设置位于下面的折叠区。
改动先留在草稿,点击「保存该会话配置」才写入,不改全局 `slots.json` 或客户端配置。
请求仍须携带对应 `mixr-<槽名>` 别名;普通模型名不自动映射槽位,压缩等内容分流仍优先。

覆盖存在 `sessions.json` 的会话记录里(`routing: { keys, slots }`),**只引用渠道内已有的 Key ID,
不重复存 Key 明文**;空映射即继承全局。接口是 `GET/PUT /api/sessions/:key/routing`
(命令行包装见 `mixctl sessions config|set-key|set-slot|clear-slot|reset`)。

- **Key 覆盖** `routing.keys`:`{渠道ID: KeyID}`。这条对话打到该渠道时用指定的账号。
- **槽位覆盖** `routing.slots`:`{槽名: {provider, model?, key_id?}}`。覆盖按**槽名**命中:
  同名的槽位在不同会话里可以各指各的渠道、各用各的 Key。Claude 组固定五槽,Codex 组槽名自拟;
  一个覆盖限**单一渠道**,没有独立备池(要池化就在全局槽位表里配)。

### 省略字段时的落点(最容易踩的地方)

覆盖是**这一槽整体替换**全局槽位,不是逐字段合并:

- **不给 `model`**:这一槽**不覆盖模型**,落点取所绑渠道自己的默认模型——Claude 渠道取模型列表
  首个(`models[0]`),Codex 渠道取渠道的 `model`。它**不是**"回落全局槽位那一档的模型";
  要与全局槽位用同一个模型,就得把那个模型名显式写进 `--model`。
- **不给 `key_id`**:先看这条会话的 `routing.keys[渠道]`(有就用它),没有才用渠道当前生效 Key
  (`active_key`)。也就是说 Key 覆盖与槽位覆盖是叠加的,而槽位级 `key_id` 更具体、优先。

### 优先级与边界

- **普通内容请求**:槽位先看这条会话的槽位覆盖,再看全局槽位表;**普通路由规则与手动渠道钉定
  保持原语义**,不因会话覆盖改变。压缩分流不变。
- **继承与恢复**:条目不存在就是继承全局;`set-key --inherit` 与 `clear-slot` 都是删条目;
  `reset` 一次清空整条会话的覆盖。改动**从后续新请求生效**——在途请求持有开始处理时的配置快照,
  不会中途换 Key。
- **同身份子请求的边界**:覆盖只适用于传来**同一会话身份**的请求。同一个对话里的子代理、
  `count_tokens`、标题生成通常共享身份,但一个传了不同 `session_id` 的子代理**不**自动继承
  ——它按自己的身份解析,没有覆盖就走全局配置。
- **Key 不可用时不降级**:覆盖里点名的 Key 被删除、停用、重复或为空时,这条会话返回 503
  `provider_key_unavailable_error`,不会悄悄改用渠道当前 Key 或池里的其他渠道;固定 Key 的请求也
  只在同一账号上重试,不改渠道的 `active_key`。
- **低可信身份不能新建覆盖**:`fp:` / `cxf:` / `anon` / `cx-anon` 这类走内容指纹的身份,
  `PUT /api/sessions/:key/routing` 返回 400 并说明原因;存量覆盖照读、照导出、照清理,不静默删除。

```bash
KEY=cc:1f2e3d4c-5a6b-7c8d-9e0f-112233445566
./mixctl sessions config "$KEY"                    # 看这条会话的覆盖与版本
./mixctl sessions set-key "$KEY" pa k2             # 这条会话打到渠道 pa 时用 Key k2
./mixctl sessions set-key "$KEY" pa --inherit      # 摘掉覆盖,回落全局 Key
./mixctl sessions set-slot "$KEY" haiku pb --model your-model-name
./mixctl sessions clear-slot "$KEY" haiku
./mixctl sessions reset "$KEY" --yes
```

命令行**不接受 Key 明文**(argv 会进 shell 历史与 `ps` 输出);每次写入都是读-改-写并带
`expected_revision`,版本对不上报 `revision_conflict` 并放弃本次写入。服务端校验的是**整份**会话
覆盖:盘上有一处引用已删渠道或 Key,连"只改一项"的保存也会被拒。完整用法见
`./mixctl sessions --help`。

---

## 5. 显式配置优先于自动推断

这是本路由器的核心不变量,分三处落地:

**1. 钉定不被自动落点回写。** 代理每次请求结束都会结算两样东西:`actual`(最近实际落点,含
slot/sticky/status,**照记**)与 `binding`(自动落点)。结算时按记录世代与"是否手动钉定"分层判定,
返回 `{ok, applied, reason, binding_blocked}`:

- 记录被删或被另一条记录替换 → 一律不写,不复活(`reason` 是 `removed` / `replaced`)。
- 记录是**手动钉定**的 → 直接 `binding_blocked = 'binding-changed'`,不走签名比较;`actual` 照记,
  所以控制台仍能看到"最近实际落到哪"。

修的是这条真实缺陷:钉定渠道临时故障(如一次 500)时,请求会回退到池里另一个渠道,而旧的
`rebind` 条件(落点变了就提交)会把这个回退写进记录,于是**临时故障把钉定永久废掉**——渠道恢复后
下一条仍粘在那个回退渠道上,界面还显示"已钉定"。

**2. 没有实际请求记录时显示「暂无」,不用预览冒充。** `sessionList()` 给每条会话三层分开的状态:

```jsonc
{
  "configured": true,                       // 是否有显式配置(钉定或覆盖)
  "required":   { "routing": {...}, "revision": "…" },   // 用户存下来的要求
  "bound":      { "provider": "…", "pinned": true, "source": "manual" },  // 当前绑定(manual/auto/none)
  "actual":     null,                       // 最近一次真实请求的落点;没有就是 null
  "actual_source": "none",
  "actual_text": "暂无"
}
```

`actual` 为 `null` 时 `actual_text` 就是「暂无」。**路由预览(`explain` / `routing/preview`)不写成
实际落点**——它只解释当前快照,不承诺上游成功,也不代表重试之后的落点。

**3. 槽位请求不改对话绑定**(见 §2),手动改绑也不会把槽位请求拽走。

---

## 6. 协议互转(Anthropic ↔ Responses ↔ Chat)

三条线都是**进程内**双向转换,不用在客户端那侧再挂一个转换代理。落点由渠道的 `wire_api` 决定
(`lib/routing/endpoints.js` 的 `wireOf`):Claude 组默认 Anthropic,标了 `responses`/`chat` 就走转换;
Codex 组默认 `responses`,`chat` 型才转换。

| 线路 | 请求方向 | 响应方向 |
| --- | --- | --- |
| Anthropic → Responses | `system→instructions`、`tool_use→function_call`、`tool_result→function_call_output`、图片→`input_image`、`max_tokens→max_output_tokens` | Responses 的 JSON/SSE 译回 `message` / `message_start…message_stop`(明文 reasoning 保留为 thinking,usage 穿过翻译层) |
| Responses → Chat | `instructions→system`、`developer→system`、`function_call→assistant.tool_calls`、`function_call_output→role:tool`、`reasoning` item 丢弃、自动加 `stream_options.include_usage` | chat SSE 译回 responses SSE;**首个文本 delta 之前先发 `response.output_item.added`**;工具调用整包下发 `function_call` item |

几条容易踩的实现约定(实测得出,已进回归):

- **思考回放按实际出站模型选格式**,不按渠道也不按客户端别名:`gpt-6-astra` / `gpt-5.6-sol` 用
  `summary:[{type:"summary_text",text}]`,DeepSeek 用 `content:[{type:"reasoning_text",text}]`。
  不能同时塞两种字段,也不能删历史 thinking 规避校验;`[1M]` 后缀不改变这个选择。
- **工具定义必须显式写 `strict: false`**。Responses 请求省略 `strict` 时上游会尝试把 schema 规范化成
  严格模式,严格模式要求 `properties` 里每个键都出现在 `required` 里——结果是客户端工具调用的
  **可选参数从未被省略**(`isolation` 一类字段每次都被填满)。`lib/tool-input-prune.js` 只删空占位,
  删不掉非空字符串,所以旧防护挡不住它。
- **图片两处都转**:消息体里的图片,以及 `tool_result` 里的图片(截图类工具的结果就是这种形状)。
- **`count_tokens`** 在 Responses 型上游没有对应端点,mixrouter 本地按请求体积估一个 `input_tokens` 回去。
- `/v1/chat/completions` 端点也开着。若路由命中的全是 `responses` 协议渠道,会明确回
  `wire_api_mismatch_error`,不做静默降级。
- **`/v1/responses/compact`** 归 Codex 组(`kind='responses/compact'`),`responses` 协议渠道
  **原样透传**到上游的 `/v1/responses/compact`(不翻译、不降级、不悄悄落到 `/v1/responses`);
  `chat` 网关没有这个端点,会明确拒绝。

> 各线完整的字段映射、思考回放与 /effort 口径见 [`reference.md`](reference.md#4-协议互转)。

---

## 7. 压缩专用路由与压缩窗口

压缩是**内容分流**,不是把整个会话改绑到压缩渠道。它由两条带 `when.body` 的内容规则承载
(`lib/routing/compact-signature.js` 的 `COMPACT_RULES`),在匹配顺序的第 1 段生效。

**识别判据**:只读**最后一条 user 消息的直接文本**块,必须以发行版 CLI 的压缩固定前导开头,
并包含摘要模板。system、历史消息、工具结果或仅仅引用特征短语的编程任务都不算。当前判据核过
CLI 2.1.282 的发行代码和离线反例,**未抓真实压缩请求包**;CLI 更新后需重新核对。

**专用模型 / Key**:控制台「路由 → 压缩模型」(接口 `GET/POST /api/compact`)选择渠道、模型及该
渠道的 Key,一次同步两条压缩规则,替换旧备池,**不修改主模型和普通路由**。

- Key 默认「跟随渠道当前 Key」,选择固定 `key_id` 后**只影响压缩规则**,不改 `active_key`、槽位或
  普通转发。
- 固定 Key 只支持单渠道,不能与 `pool` 并用;Key 被删、停用、重复或不可用时返回
  `provider_key_unavailable_error`,不会悄悄改用当前 Key。下拉框只显示标签与 ID,不显示密钥。
- 单一目标被删后,`compactPublic()` 仍显示原渠道与 Key ID(`enabled: false`),让你能看见并修复
  失效绑定,而不是静默变成空。

**压缩上下文窗口**:控制台「路由 → 压缩上下文窗口」(接口 `GET/POST /api/compact/window`),改的是
Claude Code 磁盘配置里的 `autoCompactWindow`,可选**三层**:

1. 用户全局(`~/.claude/settings.json`,可用 `MIXR_CLAUDE_SETTINGS` 重定向)
2. 项目 `.claude/settings.json`
3. 项目本地 `.claude/settings.local.json`

项目层与本地层必须提供项目绝对路径;未提供时无法核对该项目的覆盖,界面显示的是磁盘设置,
**不冒充活会话实际窗口**。取值接受 `100k`–`1M` token 或 `auto`(`auto` 只删除所选层的
`autoCompactWindow` 键并继承,**不是关闭自动压缩**,也不清除环境覆盖)。

生效范围的边界(如实):

- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 环境值优先;托管策略与 `--settings` 也可能覆盖;控件
  **无法清除环境覆盖**。
- 保存使用 `expected_revision` 防止覆盖已变更的配置,已有文件先留私有备份;外部写入与保存之间仍有
  极小的检查—替换竞争窗,**备份不是文件锁**。
- 保存**不会热改运行中的会话**;项目层设置须新开会话,或退出后在该项目目录用 `claude --continue`
  继续。
- 窗口值不是最终触发 token 数,还受客户端策略和模型上限影响;本控件不修改压缩禁用开关。

> 压缩判据与窗口三层的完整说明见 [`reference.md`](reference.md#6-压缩分流与压缩窗口)。

---

## 8. 只读诊断(解释一条请求会去哪)

```bash
./mixctl explain claude claude-opus-5                      # 自然语言摘要
./mixctl explain codex gpt-5 --kind chat/completions       # 指定端点类型
./mixctl explain claude claude-opus-5 --session cc:完整会话键  # 让预览带上已有粘性/钉定
./mixctl explain claude claude-opus-5 --json
./mixctl explain --input body.json                         # 文件名写 - 则读 stdin
```

三条边界最容易被误读:

- **只解释当前快照,不是承诺**。首选渠道是"此刻这条请求会落到哪",不保证上游成功。
  `random` 策略在多个可选成员时**只给候选、不预测**;`round_robin`/`weighted` 给的是"当前游标/
  余量下的下一位",预览**不消耗**它们。
- **零副作用**。不写日志、不建会话、不动冷却或熔断计数、不发上游请求、不改槽位与游标。已有会话
  粘性与 `least_used` 计数都在**副本**上按真实的 TTL/容量规则重算,原会话表一个字节不动。
- **不回显敏感内容**。渠道字段走白名单(`id/name/model/models/wire_api/ua/enabled/slots`),
  `base_url`、`api_key`、`keys`、`active_key`、请求头原文一律不出现;`when.token` 只回显
  `{present, len}`。展示数组有长度上限,触顶会在 `warnings` 与 `limits.arrays` 里注明**省略了多少**,
  不静默截断,也不用全空数组冒充"已经脱敏"。

错误分型与实跑对齐:`provider_disabled` / `wire_api_mismatch` / `no_route` 三个码分别映射到实跑
`protoError` 的 `provider_disabled_error` / `wire_api_mismatch_error` / `no_route_error`。
`bad_app` / `bad_model` / `kind_app_mismatch` 是**预览专有**码,实跑里构造不出对应路径,故不加
`_error` 后缀。

排查会话相关的故障见 [`troubleshooting.md`](troubleshooting.md)。
