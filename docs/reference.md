# 参考手册

这份文档是机制的完整说明:匹配顺序、槽位与覆盖的判定、协议互转、压缩分流、上游健康、
日志与归档、全部环境变量。要"在哪里改什么"看[快速开始](quick-start.md);
按症状排查看[故障排查](troubleshooting.md)。

---

## 1. 请求怎么落到渠道

Claude Code / Codex 普通入口的判定顺序是固定的四段,唯一定义在 `lib/routing/resolve.js`。
DeepSeek Harness 的 `/dsh/v1/*` 入口使用独立槽位配置,见第 3 节,不按下面的普通规则兜底:

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
| `weighted` | 平滑加权轮询(nginx 式),按成员 `weight` 比例;冷却恢复的成员会重新进入轮转 | 主力渠道多分点 |
| `least_used` | 优先给当前挂载对话最少的成员 | 成员额度不等 |
| `random` | 随机 | 无特殊要求 |
| `priority` | 永远取池序里第一个可用渠道,主渠道不可用才落到下一个 | 主备降级 |

冷却中的成员不参与挑选;全池都不可用时退回全量候选(宁可再试也不死锁),请求照常发出。
冷却只影响挑选顺序,**不会拒绝请求**(见第 5 节)。

### 渠道字段

| 字段 | 说明 |
| --- | --- |
| `app` | 建渠道时选 `claude` / `codex`,建完之后不能改组 |
| `name` | 必填,非空 |
| `base_url` | 合法 `http(s)` URL;尾部 `/` 与末尾 `/v1` 会被规范化,路径前缀保留 |
| `api_key` | 不能含换行或控制字符;渠道有多 Key 清单时 `api_key` 恒等于生效那把 |
| `models` | Claude 组:模型名数组,第一项是主模型,支持 `[1M]` 后缀 |
| `model` | Codex 组必填:渠道自带模型名 |
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
仍复用 keep-alive。它不改客户端配置,也不能绕过操作系统 TUN/VPN。

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
`MIXR_COOLDOWN_SEC`(60)、`MIXR_MAX_ATTEMPTS`(10)、`MIXR_SESSION_LABEL=0`。

### 手动钉定与解绑

- **手动改绑(钉定)**压过策略,且允许指定池外的渠道;`POST /api/sessions/:key/pin`
  传空 `provider` = 解除钉定,下次请求重新按策略分配。钉定会清掉该渠道的冷却。
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
别名由 `slotAlias()` 生成:`mixr-` + 槽名。Harness 使用独立 `dsh.json`,不写这份槽位表。

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

**应用 Codex 槽位到客户端**:命令行没有 `route codex --slots`(会被拒绝),
用控制台的「应用槽位到客户端」或直接调接口:

```bash
# revision 取自 /api/state 的 live.codex.revision
curl -s -X POST http://127.0.0.1:8788/api/router/codex \
  -H 'content-type: application/json' \
  -d '{"slots":true,"revision":"<state.live.codex.revision>"}'
```

两个槽都必须绑定已启用、有模型名和 API Key 的渠道,否则接口直接 400,不会先写坏配置。
改完需重启 Codex 生效。

**槽位落点的性质**:

- 不走会话粘性、不复用对话钉定、不改变对话绑定;按槽位自己的池策略挑选(见第 5 节)。
- 槽位可以配 `pool` 与 `strategy`。`resolveSlot` 会**自动把槽位的 `provider` 排到池首**,
  `pool` 里只需写后备成员;`priority` 策略下主渠道仍是主选。
- 渠道停用/删除得到明确的 `provider_disabled_error` / `no_route_error`。
- 落点模型:Claude 槽绑定时选定(空 = 渠道 `models[0]`);Codex 槽用渠道自带模型名。

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

### DeepSeek Harness 独立槽位

控制台左侧 **DeepSeek Harness**(`http://127.0.0.1:8788/#dsh`)管理一个主模型与
按用途标记的子模型目录。代码编写、代码审查、资料检索等用途可快捷添加,也支持中文自定义名称。
默认子模型可选固定模型或“跟随当前对话”,并可允许主智能体显式选模;
能力声明、策略管理方、限额及诊断按需展开。旧配置不按模型品牌猜用途,已有落点和候选保持不变。

配置保存在 `<MIXR_DATA_DIR>/dsh.json`(`0600`),v2 结构为 `{version: 2, slots, subagents}`。
**槽名**决定稳定别名 `mixr-dsh-<槽名>`;**用途标签 `label`**只决定目录显示名;
**候选名单**决定普通子工具可显式选择哪些模型。主智能体通过普通 `subagent` 调用选择模型,
代理按请求中的别名转发,不读取任务文字做自动分类或确定性用途路由。
标签不创建带 prompt、工具或记忆的角色;原生 Bot 身份和 preset 仍在 Harness 中管理。
不写 Claude / Codex 的 `slots.json`,不改其他客户端设置。

| 字段 | 约束与含义 |
| --- | --- |
| `slots` | 完整槽位映射,必须包含 `main`;最多 32 槽(含主槽,至多 31 个子槽);保存时整体替换,不是部分更新 |
| 槽名 | `^[a-z0-9][a-z0-9-]{0,23}$`,1–24 位小写字母、数字或连字符,首位不能是连字符;保留名 `constructor` / `prototype` / `__proto__` 不接受 |
| `slots.<name>.provider` | 已存在且启用的 `chat` / `responses` 渠道 ID;复用渠道库及 Key |
| `slots.<name>.model` | 必填非空模型名,最长 256 字符、不含控制字符;可填写渠道清单外的自定义模型,不保证账号有调用权限 |
| `slots.<name>.label` | v2 可选用途显示名;trim 后最多 24 字符,空字符串省略,非字符串或控制字符报错;子槽同步名称为 `Mixrouter · 用途标签 · 槽名`,无标签时为 `Mixrouter · 槽名`,主槽恒为 `Mixrouter · 主模型` |
| `slots.<name>.upstream_stream` | 可选布尔值:省略继承现有行为,`true` 上游流式,`false` 上游完整 JSON |
| `slots.<name>.capabilities` | v2 可选容量/输入/推理能力声明,不是上游探测结果;见下表 |
| `subagents.owner` | `mixrouter` 管理普通 spawn 的默认、候选和可选限额;`harness` 只同步 provider/别名目录,主模型、子策略和 preset 由 Harness 持有 |
| `subagents.allow_model_selection` | 布尔值,表示是否允许普通子工具显式选模,不是自动分类或是否运行子任务;MixRouter 管理时关闭此项会保留名单,使用固定默认或父模型 |
| `subagents.allowed_slots` | 唯一、已配置槽名数组;开启显式选模时至少一项;与全部模型目录独立,`main` 需显式勾选 |
| `subagents.default` | `{mode:'slot',slot:'worker'}` 固定任意已有槽,或 `{mode:'inherit'}` 真正省略子工具 provider/model/reasoningEffort 并继承父模型;固定默认须在开启的候选池内;Harness 管理时仅保留偏好,不应用 |
| `subagents.max_depth` | 可选整数 0–64;同时写 Host 与普通 spawn 工具实例,避免安装包工具默认值覆盖 Host;0 关闭该委派路径 |
| `subagents.max_active` | 可选整数 1–64;同一根 Agent 下所有层级的活跃子任务容量;不计主 Agent |

| 能力字段 | 约束与默认 |
| --- | --- |
| `context_window` / `max_tokens` | 正安全整数;都填写时输出上限须不大于上下文;省略采用 Harness 适配器默认 262144 / 32768,不代表已验证上游容量 |
| `input` | `['text']` 或 `['text','image']`;省略采用 Harness 适配器默认 text,不猜图片支持 |
| `reasoning_efforts` | `false` 表示不公布推理档位;或等级 → wire 值的精确映射,可用 off/minimal/low/medium/high/xhigh/max;仅 off 支持 null,至少一项非 off 等级 |

v1 `{version:1,slots,default_subagent}` 文件与旧 PUT 请求继续兼容。
旧 API 接受空 `default_subagent` 或已配置的非 `main` 槽名;空值同步后实际固定 `main`,
不是动态继承,旧名单包含全部槽。新简单默认选项通过 v2 `{mode:'inherit'}` 明确选择真正继承,
不将旧空值或兼容固定槽 setter 改读为继承。
读取只展示归一化迁移视图,不改文件;新页面首次保存才升级 v2,保留旧落点、声明、全部候选与固定默认。
已保存 v2 后,旧请求降级保存返回 409,避免丢失子策略。新页面还检查 `api_version:2`,
在仅静态资源更新、旧后端仍运行时保持只读,不向忽略新字段的旧后端提交 v2。

每槽的客户端别名为 `mixr-dsh-<name>`,如 `mixr-dsh-main` / `mixr-dsh-worker`。
只在 `/dsh/v1/*` 入口解析这份配置,不使用普通规则兜底、会话粘性或手动渠道钉定;
每槽只绑定单一渠道与模型,不提供 `pool` / `strategy` / 固定 `key_id` 字段。
别名发到普通 `/v1/*` 不会选中 Harness 槽位。

#### 配置与同步 API(控制台口 8788)

- `GET /api/dsh` 返回 `api_version:2`、`supported_config_versions:[1,2]`、保存的 `version` / `slots`、
  归一化 `subagents`、`source_version` / `migration_required`、`revision`、`providers` 与 `client`;
  v1 另保留 `default_subagent`。`providers` 仅含公开 ID、名称、模型、协议和启用状态,不含 Key。
  `client` 的 `not_configured` / `configured` / `out_of_sync` / `conflict` 是安装与**磁盘配置**事实,
  `policy_owner`、`sync_needed`、`affected_sections` 和 warnings 辅助核对同步范围,
  不证明运行中的 Harness 会话已采用。top-level `policy_coverage` 明确覆盖差异。
  `observations` 只统计当前进程日志 ring 的最近 DSH 请求:sample/ok/error/cancelled 计数、
  `last_request` / `recent` / `by_slot`;仅白名单时间、alias、slot、渠道、模型、状态、错误类别与强度,
  不含 prompt、会话标识、正文或凭据。流内出错即使 HTTP 200 也不计为成功。
- `PUT /api/dsh` 接收整份槽位映射,带 `expected_revision`。必须使用最近一次 GET 的
  `revision`,版本不匹配或 `dsh.json` 已被外部改动时返回 409,不覆盖。
  配置校验失败返回 400;保存只更新 `dsh.json`,不修改 Harness 文件。已有别名的渠道、模型和
  上游流式模式对后续请求立即生效,在途请求不变。目录增删、用途显示名、能力声明、默认值与
  子策略只是已保存偏好,须另行预览/同步后重启 Harness 并新建会话,才由客户端读取。
  控制台读取与请求解析均刷新 `dsh.json` 的外部原子修改;
  文件损坏或配置过后被删除时停止转发,不沿用旧渠道。
- `POST /api/dsh/preview` 接收 `{"expected_revision":"<当前 revision>"}`,
  返回 `{preview,revision}`。仅预览已保存配置,不创建目录、备份或写文件;
  返回实际变更的 `affected_sections`、`released_sections`、`model_count`、`changes`、覆盖与 warnings;
  `changes` 分别标明目录、所有权、主默认、普通子策略和原生移交,不返回整段 preset 或秘密。
- `POST /api/dsh/sync` 接收 `{"confirm":true,"expected_revision":"<当前 revision>"}`。
  未明确确认不写文件;同步前同样校验已保存槽位和 revision。
  它写本机 `~/.dsh/profiles/desktop/cordis.patch.yml` 的受控托管区,
  可用 `MIXR_DSH_CONFIG` 重定向;保留已有 provider 与其他 patch,已有文件先留
  `.bak-mixrouter-<时间戳>-<随机>` 私有备份。托管区标记/校验和被外部修改,
  或同步期间文件变化时返回 409;托管区外的合法用户 patch 重新读取合并,不整份覆盖。
  不会安装或自动重启 Harness,返回 `restart_required: true`。
- **重新接入**:设置页改变可识别托管段时,普通同步仍返回冲突。
  `client.repair_available:true` 表示可先以 `POST /api/dsh/preview` 的 `repair:true`
  做零写预览;返回 `profile_revision`、`main_before`、`main_after` 与恢复说明。
  确认后 `POST /api/dsh/sync` 额外提交 `repair:true`、`expected_profile_revision`。
  仅精确匹配本工具生成的 provider 表达式、已知托管条目及有效元数据才提供此入口;
  profile 在预览后再变更即返回 409。恢复先备份,只重建自有段,段外字节不变。
  这不是普通保存流程,不会让更换真实模型顺带写入 Harness 配置。

保存示例(渠道 ID 和模型名换成自己已保存的值):

```json
{
  "expected_revision": "<GET /api/dsh 返回的 revision>",
  "slots": {
    "main": {"provider": "p-main", "model": "main-model"},
    "worker": {"label": "代码审查", "provider": "p-sub", "model": "sub-model", "upstream_stream": false,
      "capabilities": {"context_window": 128000, "max_tokens": 8192,
        "input": ["text"], "reasoning_efforts": {"off": null, "low": "low", "high": "high"}}}
  },
  "version": 2,
  "subagents": {"owner": "mixrouter", "allow_model_selection": true,
    "allowed_slots": ["worker"], "default": {"mode": "slot", "slot": "worker"},
    "max_depth": 1, "max_active": 4}
}
```

#### 客户端 API(代理口 8787)

| 端点 | 用途 |
| --- | --- |
| `POST /dsh/v1/responses` | 推荐的 Harness Responses 接口,可翻译 Chat 上游 |
| `POST /dsh/v1/chat/completions` | Chat Completions 接口,须选择兼容的 Chat 渠道 |
| `GET /dsh/v1/models` | 本地已配置槽位别名列表,包含 `mixr-dsh-main`,不是上游模型清单 |

同步写入虚拟 mixrouter provider,Base URL 为 `http://127.0.0.1:8787/dsh/v1`,
真实上游 Key 仍由 mixrouter 转发时注入,无需在 Harness 再填写。全部槽注册到模型目录,
不是全部自动成为子候选;MixRouter 管理时另按 `allowed_slots` 同步普通子候选名单,
并将 `mixr-dsh-main` 写为主模型默认值。
`owner: harness` 只同步 provider/模型目录,不覆盖主模型、子策略或 preset;
从 MixRouter 移交时将最后有效原生值留在托管区外,保留原配置优先级和后续原生覆盖。
此后的主/子偏好只存在 `dsh.json`,不会因它们变化而自动改写 profile;
切回 MixRouter 管理并确认同步时才重新采用本页保存的偏好。
Harness 临时切到其他 provider 直连的对话不会经过 MixRouter,
须在其模型选择器选择已接入的 MixRouter 别名;同步不自动切换已有会话。

**子策略覆盖**:MixRouter 管理的普通 `subagent`(spawn)仅在显式指定 provider/model/effort
时检查模型名单。固定默认在保存时校验与候选的关系,默认/真正继承的运行路径不经过相同检查,
因此真正继承可能使用候选池外的父模型。`subagent_fork` 继承父模型,Team 成员继承 lead 模型;
workflow 可指定独立 route,DS Bot 支持逐 Bot 模型设置。本页不是全局白名单,
不强制其他创建路径。模型路由槽与原生 `agentPreset` 的角色/工具配置互相独立;
一次性具名角色可用原生子 preset / 具名工具,常驻具名智能体可用 DS Bot。

**流式边界**:上游传输与客户端响应格式分开。`upstream_stream: false` 不把客户端
SSE 请求改成 JSON 响应,而是在完整上游 JSON 返回后转成客户端 SSE;
它不是逐 token 实时输出,等待仍受非流式超时及端到端总预算约束。
省略此字段保持原有流式行为,不全局改动其他客户端。

**同步限制**:默认从 `/Applications/DeepSeek Harness.app/Contents/Resources/app`
读取安装内容,`MIXR_DSH_APP` 可指定 `.app` 路径或其内部 app 目录。mixrouter 无需安装
额外 npm 依赖;安全合并使用 Harness 自带的官方 `js-yaml` 与 `standard` / `ptc` / `cordis`
preset 模板。未安装 Harness 仍可配置路由,但不能同步;同步不会修改已安装 app。
缺少解析器或模板时拒绝同步,此入口不是通用 YAML 编辑器。目标配置含无法安全合并的
动态 `!!js`、已有非托管 `mixrouter` provider、损坏或重复托管标记时拒绝覆盖;
flow-style 顶层数组也拒绝追加,须先由用户整理为 block patch list。
已有其他 provider 的 Key 可能仍在原 patch 或备份中,请将这些文件按凭据文件保管。
备份与替换不构成文件锁,最终检查到原子替换之间仍有极小竞争窗。
不宣称支持任意 Harness 版本或其他平台安装布局。

---

## 4. 协议互转

三条线都是**进程内**双向转换。落点由渠道的 `wire_api` 决定。

| 线路 | 请求方向 | 响应方向 |
| --- | --- | --- |
| Anthropic → Responses | `system→instructions`、`tool_use→function_call`、`tool_result→function_call_output`、图片→`input_image`、`max_tokens→max_output_tokens` | Responses 的 JSON/SSE 译回 `message` / `message_start…message_stop`(明文 reasoning 保留为 thinking,usage 穿过翻译层) |
| Claude → Chat Completions | system 进首条消息、`tool_use→tool_calls`、`tool_result→role:tool`、顶层图片转 `image_url` data URI、`reasoning_content→thinking` | chat SSE 译回 Anthropic SSE;工具参数攒齐再物化;没有终态不得补 `message_stop` |
| Responses → Chat | `instructions→system`、`developer→system`、`function_call→assistant.tool_calls`、`function_call_output→role:tool`、`reasoning` item 丢弃、自动加 `stream_options.include_usage` | chat SSE 译回 responses SSE;**首个文本 delta 之前先发 `response.output_item.added`**;工具调用整包下发 `function_call` item |

几条容易踩的实现约定:

- **思考回放按实际出站模型选格式**,不按渠道也不按客户端别名:有些模型用
  `summary:[{type:"summary_text",text}]`,DeepSeek 系用 `content:[{type:"reasoning_text",text}]`。
  不能同时塞两种字段,也不能删历史 thinking 规避校验;`[1M]` 后缀不改变这个选择。
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

请求日志的 `effort` 记的是**真的发上去的那一档**(转换层报回来的),不是客户端想要的那档
——两者的差正是"切了档却没效果"的案发现场。客户端没选或渠道收不了这个字段时它是空的。

---

## 5. 上游健康:超时、冷却、重试

- **三段超时**,分别独立配置:
  `MIXR_FIRST_HEADER_TIMEOUT_MS`(发请求到收到响应头)、
  `MIXR_STREAM_IDLE_TIMEOUT_MS`(流式两次数据之间的最大间隔)、
  `MIXR_NONSTREAM_TOTAL_TIMEOUT_MS`(非流式从头到 body 结束)。
  另有 `MIXR_TOTAL_DEADLINE_MS` 作端到端总预算。
- **冷却**:429/5xx/连不上 → 打冷板凳 `MIXR_COOLDOWN_SEC`(默认 60 秒),冷却期内不被选中。
  4xx 算 rejected:它证明渠道连通,只是这次请求有问题,处理和 5xx 一样——只进冷却。
- **重试**:一次请求最多打 `MIXR_MAX_ATTEMPTS` 次上游(默认 10),每次重试前等待
  `MIXR_RETRY_DELAY_MS`(默认 1000,范围 0–60000 毫秒)。同一个渠道也会被重复尝试,
  `MIXR_MAX_ATTEMPTS` 封顶的是**上游调用次数**,不是候选渠道数。冷却中的渠道通常不参与挑选;
  全池都不可用时退回全量候选,请求照常发出,不会因为冷却被拒绝。
- **端到端总预算优先**:`MIXR_TOTAL_DEADLINE_MS` 用尽后不再重试,在途请求按超时收尾。
- **错误分型** `err_class`:`authentication`(401/403)、`rate_limit`(429)、
  `upstream_server`(5xx)、`upstream_request`(其余 4xx)、`timeout`、网络错误码、
  `network_error`、`cancelled`(客户端主动断开)。转移成功的请求也带首次失败的
  `err_class` + `failover` 标记。
- **客户端断开**(取消/进程退出):代理立刻掐掉在途的上游请求,落一条 `err_class: cancelled`
  的日志(状态 499),**不算**渠道失败。
- **只读健康视图** `GET /api/health`:三段超时、重试与冷却配置,以及每个渠道的
  `{provider, app, enabled, eligible, cooldown_until}`。`eligible` 是此刻是否可被挑选,
  `cooldown_until` 是冷却截止时间,不在冷却时为 `0`。

已知限制:流式响应被掐断时只结束连接,**不补发**协议内 error 事件,客户端看到的是截断的
SSE。一次请求的上游调用总上界是 `MIXR_MAX_ATTEMPTS` + `MIXR_CONV_RETRIES`(默认 13);
`MIXR_CONV_RETRIES` 计的是同渠道内的换 Key / 换 cache 代际重试。

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
- **零副作用**。不写日志、不建会话、不动冷却表、不发上游请求、不改槽位与游标;
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
| `bytes_in` | 客户端请求体字节数(不是 token)。大上下文/带截图时可达十几 MB,而首字延迟主要由它决定 —— 上游面板只从收完请求体开始计时 |
| `ttfb_ms` | 请求开始 → 上游首个响应头到达的毫秒数(多次尝试取最终给出响应的那一发;全部失败记到收尾)。`0` 表示没测到(如本地估算的 count_tokens) |
| `slot` | 命中的槽位;空槽记 `none`,缺字段的旧日志记 `unknown` |
| `sticky` / `strategy` / `rule` | 是否走了会话粘性 / 策略 / 命中的规则 id |
| `key_id` / `key_source` | 用哪把 Key(**非明文**的来源标记) |
| `effort` | 真的发上去的思考强度档位 |
| `model_in` / `model_out` | 客户端说的模型 / 实际发给上游的模型 |
| `think` / `reasoning` / `tools_dropped` | 排查上游 400 的证据 |

日志**不含 Key 明文**,也不含会话标签;内容包括渠道名、模型名、会话键(哈希/ID 形态)
与错误文本。

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
**ZCode 的备份暂未纳入清点表。** 路径可分别用 `MIXR_DATA_DIR`、`MIXR_CLAUDE_SETTINGS`、
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
恢复 ZCode 配置请用它的备份文件手工替换。Harness 的 `cordis.patch.yml` 与
`.bak-mixrouter-*` 备份同样不在这两个命令的范围内,需停止客户端后手工恢复。

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
| `MIXR_DATA_DIR` | 仓库根 | providers / routes / slots / sessions / dsh / logs 的总目录 |
| `MIXR_LOG_RETENTION_DAYS` | 30 | 新请求日志归档保留天数(0–36500);`0` 永久保留 |
| `MIXR_LOG_COMPRESS` | 关 | 仅 `on` 启用新请求日志归档 gzip |
| `MIXR_LOG_RETAIN_DAYS` / `MIXR_LOG_SWEEP_MS` | 2 / 21600000 | responses 归档与 launchd.log 的保留天数与清理周期 |
| `MIXR_CLAUDE_SETTINGS` | `~/.claude/settings.json` | Claude Code 客户端配置 |
| `MIXR_CODEX_CONFIG` | `~/.codex/config.toml` | Codex 客户端配置 |
| `MIXR_ZCODE_CONFIG` | `~/.zcode/v2/config.json` | ZCode 客户端配置 |
| `MIXR_DSH_CONFIG` | `~/.dsh/profiles/desktop/cordis.patch.yml` | Harness 显式同步的 desktop profile patch 路径,须为绝对路径 |
| `MIXR_DSH_APP` | `/Applications/DeepSeek Harness.app` | Harness 安装路径,同步时读取其官方 YAML 解析器与 preset 模板,须为绝对路径 |
| `MIXR_RESPONSE_ARCHIVE` | 关 | 仅 `on` 开启上游响应正文归档 |
| `MIXR_RESPONSE_ARCHIVE_DIR` | `<MIXR_DATA_DIR>/logs/responses` | 返回归档私有目录 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 未设 | 压缩窗口的环境覆盖,优先于磁盘设置 |
| `MIXR_UPSTREAM_PROXY` / `MIXR_UPSTREAM_PROXY_BYPASS` | 空 | 出站 HTTP CONNECT 隧道;环回地址永不隧道 |
| `MIXR_UPSTREAM_IDLE_MS` | 5000 | 出站空闲连接回收阈值;`0` = 关掉空闲计时 |
| `MIXR_BODY_LIMIT_MB` | 64 | 请求体上限 |
| `MIXR_TOTAL_DEADLINE_MS` | 240000 | 端到端总预算 |
| `MIXR_FIRST_HEADER_TIMEOUT_MS` | 120000 | 等上游响应头 |
| `MIXR_STREAM_FIRST_HEADER_TIMEOUT_MS` | 60000 | 恒流式形状的等响应头预算 |
| `MIXR_STREAM_IDLE_TIMEOUT_MS` | 90000 | 流式两次数据之间的最大间隔 |
| `MIXR_NONSTREAM_TOTAL_TIMEOUT_MS` | 180000 | 非流式响应从头到 body 结束 |
| `MIXR_SSE_KEEPALIVE_MS` | 15000 | 已提交给客户端的流补 SSE 注释的间隔;`0` 关掉 |
| `MIXR_COOLDOWN_SEC` | 60 | 429/5xx 打冷板凳的时长 |
| `MIXR_MAX_ATTEMPTS` / `MIXR_CONV_RETRIES` | 10 / 3 | 一次请求最多打多少次上游(同一渠道也会被重复尝试)/ 同渠道内换 cache 代际重试次数 |
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
