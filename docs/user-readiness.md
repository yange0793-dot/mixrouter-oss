# 首次接入、兼容测试与自助恢复

这份文档讲的是**新用户从零接上本机路由,以及出问题后自己判断下一步**的界面与命令。
机制的完整定义在[参考手册](reference.md),按症状排查在[故障排查](troubleshooting.md);
这里只讲每个入口做什么、会改什么、不会改什么。

> **当前验证范围**:本页描述的是这一轮新增的入口,目前只在 **macOS + Node 24** 上跑过测试与
> 离线 fixture。兼容测试、渠道导入与客户端写入都没有对**真实上游**做过生成请求;
> 需要真实额度与真实渠道的结论,请以你自己机器上的结果为准。

---

## 1. 接入向导(控制台 → 渠道与 Key)

入口:**渠道与 Key** 页顶部的「接入向导」面板 →「打开接入向导」。它把五步串在一次流程里:

| 步骤 | 做什么 | 不会做什么 |
| --- | --- | --- |
| 1 检查客户端 | 读 PATH 里有没有 `claude` / `codex`,读客户端配置文件的当前内容 | 不执行客户端、不读 `--version`、不改任何文件 |
| 2 渠道 | 选已有渠道,或新建,或粘贴 JSON 导入 | 不在这一步写客户端配置 |
| 3 模型与主槽 | 选模型、Key、客户端协议;可选「设为主槽 main」 | 不改渠道库里的 `wire_api` |
| 4 兼容测试 | 可选;最多 3 次真实生成请求,分四项报告 | 不执行工具、不改真实会话绑定 |
| 5 写入客户端 | 先预览受管字段差异,再显式确认 | 没有预览令牌、或预览后文件被改过,一律不写 |

选好客户端后,向导会显示:**客户端是否安装**(PATH 中的常规文件 + 可执行位)、
**配置文件状态**(`ok` / `missing` / `invalid` / `error`)、**是否已指向本机路由**(`routed`)。

三种"读不到"必须分开看,向导也分开显示:

- `missing`:文件不存在。可以按"尚未配置"处理。
- `invalid`:文件存在但不是合法 JSON / TOML(或顶层结构不对)。**向导不会把它当成空配置去覆盖**,
  请先自己修文件。
- `error`:没有读取权限(`EACCES`,回 403)或路径不是普通文件(回 500)。预览与写入都会被拒绝,
  不会出现"用空配置盖掉原文件"。

没有在 PATH 里检测到客户端时,向导**仍可以写入配置层**(它不负责安装客户端),并显示
「手动接入参数」折叠区:base_url、协议与占位令牌;**令牌明文不在页面显示**。
手动填法见[快速开始](quick-start.md)§3。检测只看 PATH 里的常规文件与可执行位,
不执行客户端、不读 `--version`;二进制存在但没有可执行位会单独说明,不当作"没装"。

### 写入与撤销

- 预览(`POST /api/onboarding/<app>/preview`)返回**受管字段的写前 / 写后值**和一次性令牌,
  默认 5 分钟有效、用一次即作废。字段值里的令牌只显示掩码,URL 会去掉查询串与片段。
- 确认写入(`POST /api/onboarding/<app>/apply`)必须同时给 `token` 与 `confirm: true`。
  写入前对比配置文件指纹:预览之后文件被外部改过就返回 409,不拿旧快照去写。
- 写入走的是与 `./mixctl route` 相同的切换函数,写前按现有逻辑自动备份;
  写入后按**磁盘实际值**记账,不是按预览的预测值记账。
- 第 2–3 步选的渠道、模型与 Key 用于**兼容测试**;Claude / Codex 的写入
  只改接入字段,**不会**自动新建渠道、改槽位归属或把选中的渠道绑成主槽——要绑槽位,
  用第 3 步的槽位按钮或在槽位表里配置:
  - Claude:可选「只设为主槽 main」或「把全部槽位都设为该渠道」。只配 main 时其余槽位不写别名,
    原本手设的真实模型名会保留,过期的 `mixr-*` 会被清掉。
  - Codex:可以「把 main 与 reviewer 都设为该渠道」同时配置两槽;也可在 Codex 页分别选渠道与
    落点模型。接入会自动采用可用槽位,不再以 `slots` 选项决定是否写别名。
- Claude 的 `main` 槽已绑定时,向导可连同槽位别名 env 一起写;缺少主槽时只写路由地址与令牌。
  Codex 接入自动使用 `main` / `reviewer` 的稳定别名,并设置托管模型目录;
  普通接入缺少这两个槽时,按渠道库顺序用首个启用且有默认模型与 Key 的 Codex 渠道补齐。
  已存在但无效的槽不会被自动覆盖,写入前直接拒绝;严格 `slots: true` 接入也不补槽。
  自动补齐保存到路由器槽位表,撤销客户端字段不会删除这些槽。
  后续槽位保存热更新别名请求落点与目录,不改客户端原有推理强度。
  首次连接仍须预览并确认;profile、项目覆盖与未登记的真实模型名不自动跟随主槽。
  已登记旧默认 ID 在原生 Codex 标识、本地路由凭据与可靠会话同时满足时按兼容映射跟随;
  显式选择同名 ID 仍会命中,无关原生模型与其它 OpenAI 客户端不受影响。
- 撤销(**「撤销上次写入」**)只还原**本次受管字段的写前值**:
  - Claude Code:`env` 里的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`,
    以及接入时一并写入的五个槽位 env 键;
  - Codex:顶层 `model` / `model_provider` / `review_model` / `model_catalog_json`,
    以及 `[model_providers.mixr-router]` 段的字段。
  Codex 的撤销只还原 `model_catalog_json` 字段,不删除接入时生成的目录文件;
  `model_reasoning_effort` 不属于接入受管字段,后来调整强度不妨碍撤销。
- **任何一个受管字段在接入后被改过,撤销整体拒绝**并列出冲突(当前值 / 期望值 / 想还原的值),
  不会为了撤销去覆盖整份文件。用户后来新增的其它设置不在受管字段里,撤销不碰它们。
- 接入账本落在 `<MIXR_DATA_DIR>/client-managed.json`(权限 `0600`)。它保存受管字段的写前与写后值,
  **可能包含你原来的令牌或 Key**;不要公开贴出,详见 [SECURITY.md](../SECURITY.md)。

### 已知边界

- Codex 当前选择了 `profile` 时,向导拒绝预览与写入(需要先人工确认 profile 配置)。
- 写入时若清理了其它 `mixr-*` provider 段,预览会警告;**撤销只恢复本次受管字段,不恢复那些段**。
- 首次切换接入后,客户端需重新读取连接配置(按客户端选择重新打开或新建会话)。
  Codex 已通过本机路由发送别名请求后,保存槽位对后续请求热生效,不用再次应用或重启;
  原生选择器缓存目录和显示名,重新打开客户端才读取新目录;转发更新不依赖界面刷新。
- 写入成功但随后读不到配置文件时,接口会明确报"已写入但未记录撤销账本";这种情况下撤销入口
  没有记录可用,请按自动备份核对,不要反复重试写入。
- 撤销写入后会重新读文件校验;若只还原了一部分,会报错并让你用备份核对,不会声称成功。

---

## 2. 渠道导入(粘贴 JSON)

入口:向导第 2 步的「粘贴导入」。也可以直接调接口。

支持两类输入:

- mixrouter 自己的 `providers.json` 形状(`{ version, current, claude: [], codex: [] }`);
- cc-switch 导出的渠道 JSON(`providers` 数组、按 app 分组的对象、
  含 `settings_config` / `settingsConfig` 的条目,包括其中的 Claude env 与 Codex TOML)。

两条硬规则:

- **只取白名单字段**。未知字段不进草稿;`__proto__` / `constructor` / `prototype` 这类键
  在解析阶段就拒绝,不做原型链合并。
- **只增不改**。已有渠道按「app + base_url + api_key」判定重复,重复项跳过;
  `current` 指针、已有渠道 id、已有渠道的 Key 一律不动。同名但 Key 不同的渠道会作为**新渠道**加入。

流程是两段,不能一步到底:

1. `POST /api/providers/import/preview`,body `{ "input": <JSON 对象或文本> }`。
   服务端解析、去重并返回摘要(`summary`)、逐条错误(`errors`)、预览令牌(`token`)
   和合并后的渠道摘要(只含 `key_masked`,不含 Key 明文)。
2. `POST /api/providers/import/apply`,body `{ "token": "…", "confirm": true }`。
   令牌 5 分钟有效、一次性;令牌无效/过期,或渠道库在预览后发生变化(版本对不上),
   都返回 409,需要重新预览。`confirm` 不是 `true` 时返回 400。

限额:单次最多 500 个条目;序列化后的输入超过 512 KiB 的请求会被拒绝(接口层),
直接调用 `lib/provider-import.js` 时原始文本上限是 2 MB。`PROXY_MANAGED` 这类路由占位值
不会被当成真实 Key 导入。

导入**只写渠道库**,不改客户端配置、不改槽位表、不切换当前生效渠道。

---

## 3. 兼容测试(可选,会消耗额度)

入口:向导第 4 步。接口 `POST /api/providers/<id>/compatibility`。

它检查的不是"端点通不通"(那是渠道卡片上的连通性测试),而是**客户端协议 → 路由/Key 选择
→ 上游协议转换 → 客户端拿到的结果**这一整条链。四项检查:

| 检查 | 判定方式 |
| --- | --- |
| `authentication` | 不单独发请求,由下面三项的结果反推 |
| `generation` | 一次非流请求,要求拿到非空文本 |
| `stream` | 一次流式请求,要求出现该协议的流终态(而不是"有字节返回") |
| `tools` | 要求模型调用探针工具 `mixrouter_probe`,并给出 `{value:"string"}` 形状的参数 |

边界(与实现一致):

- **没有 `confirm_run: true` 一个生成请求都不发。** 向导里对应「我知道这会消耗额度」勾选框。
- 一次测试**最多 3 次真实上游调用**(生成 / 流式 / 工具各一次,不重试),按这个顺序串行执行;
  总时限 90 秒、单项 30 秒,单次输出上限 256 KiB。总时限用尽后剩余检查标记为 skipped,
  超时或超限会中止并给出对应 code。
- 测试走的是真实转发链路(同一个 attempt runner 与响应转换),但**与真实会话隔离**:
  空槽位表、不写会话绑定、不写响应归档、不碰 8787/8788 上的现役实例,
  也不改动多 Key 备用的健康/粘性状态(探针用的是替身,不会让下一次真实请求换号)。
- 这些隔离请求**不会出现在诊断页的「实时尝试过程」里**(没有注入 trace),也不会写进请求日志;
  要看它们的过程,用的是本次测试结果里的四项检查与各自耗时。
- 工具探针只让模型回显参数,不执行文件或命令。
- 失败项只报状态码、错误分类与本项目固定文案,**不回显上游错误正文**(正文可能带账号信息)。

常见结论怎么读:

| code | 含义 | 下一步 |
| --- | --- | --- |
| `generation_ok` / `stream_complete` / `tool_ok` | 该项通过 | — |
| `authentication_rejected`(401) | 上游明确拒绝凭据 | 换 Key 或换账号 |
| `forbidden`(403) | 权限、区域或模型限制 | **不能判定 Key 失效**;换同渠道其它模型再试 |
| `rate_limit`(429) / `budget_exhausted`(402) | 限流 / 额度 | 等一下,或换渠道 |
| `stream_not_sse` | 上游整包回了 JSON,没按流工作 | 检查渠道是否支持 `stream` |
| `stream_incomplete` / `stream_aborted` | 流缺少终态 / 中途断流 | 看本次测试里这一项的耗时与状态码,再重跑一次确认是否稳定 |
| `tool_not_called` / `tool_name_mismatch` / `tool_args_invalid` | 工具调用没按预期发生 | 多为上游工具格式兼容问题 |
| `output_limit` / `time_limit` | 超过输出或时间上限 | 上游可能异常或无响应 |
| `confirmation_required` | 没有显式 `confirm_run` | 在界面上勾选确认 |

**一次通过不代表持续健康**:结果带 `checked_at` 与范围(渠道、模型、Key、协议),
只代表那一时刻、那一组参数。图片、思考回放、长上下文等能力不在这一轮检查范围内。

---

## 4. 槽位后备池(可视化)

入口:**渠道与 Key → 模型槽位配置**(Claude 组),每个 Claude 槽位行上的「编辑后备池」。
Codex 组切换过去时只显示一句说明,不提供编辑入口:Codex 的 `main` / `reviewer` 写入客户端时
是单一渠道,在这里显示一份客户端不会使用的备份没有意义。

- 编辑器里的第 1 行永远是**槽位自己的主渠道**(由服务端排在池首,不需要重复添加);
  下面按顺序排后备渠道,每个成员可选渠道与落点模型,可上下移动或移除。
- 保存是对该槽位的**部分更新**:只改 `pool` 成员与顺序,连同原有的 `strategy`、`dropTools`
  原样带回。编辑器不会把非 `priority` 的策略偷偷改成 `priority`。
- 保存空列表 = 清空后备池,主渠道不变。
- 后备渠道只在**这个槽位的请求**上按顺序重试;真实降级取决于上游错误与重试预算,
  **不保证图片、工具调用等能力与主渠道一致**。
- 停用的渠道由服务端直接跳过。池里指向已删除渠道的成员会在路由预览里作为**幽灵引用**报出来;
  槽位的主渠道被删除时,槽位请求按 `no_route_error` 处理,不会悄悄落到后备成员上。

槽位没命中、别名拼错、槽位未绑定渠道的排查见[路由与会话](routing-and-sessions.md)§2 与
[故障排查](troubleshooting.md)§4。

---

## 5. 错误解释与尝试过程(诊断页)

诊断页在「分槽用量」之后、日志筛选之前新增「实时尝试过程」面板(来源 `GET /api/attempts`),
只在**这一页可见时**每 2 秒读一次。

- 每条请求一条 trace:开始→每次尝试→拿到响应头→失败/重试等待→终态。页面展示等待、
  重试次数、每次尝试的渠道与模型;展开时最多列最近 12 步,并注明省略了多少步(服务端每条最多存 40 个事件)。
- 内容只在本进程内存里:**最多 100 条、每条最多 40 个事件、15 分钟未更新即过期**。
  重启服务后清空,不能当历史记录。
- 字段是白名单:只有请求 id、时间、阶段、尝试序号、渠道 id、模型名、`key_id`、状态码、
  错误 code、等待毫秒,以及 app / 协议线 / 槽位这类元数据。
  **不含 prompt、会话标签、Key 明文、上游 URL 或上游错误正文。**
- 尝试过程是旁路:不参与候选选择、预算或终态判定;没有它代理行为不变。
- 请求日志里的 `request_id` 就是这里的 trace id,可以互相对照。

对已结束的 trace 点开,会按需请求错误解释
(`GET /api/errors/guidance?status=<码>&err_class=<类>&code=<错误码>`),返回六项固定内容:

```json
{
  "category": "auth | model | rate | quota | network | timeout | upstream | request | config | attempts | cancelled | unknown",
  "title": "一句话结论",
  "impact": "影响:账号坏了、模型没了、还是这一发运气不好",
  "action": "下一步做什么,去控制台哪一页",
  "target": "#providers | #compact | #diagnostics | … | ''",
  "uncertain": true
}
```

判定顺序是有意的:先看代理自己产生的错误码(`no_route_error`、`provider_disabled_error`、
`provider_key_unavailable_error`、`wire_api_mismatch_error`、`bad_credential`、
`unsupported_compaction`、`too_many_attempts`),再看状态码,最后才用 `err_class` 兜底。

- 401(凭据被拒)、403(权限/风控)、402(额度)、429(限流)、5xx(上游故障)、
  超时、连接中断、客户端取消是分开的。
- **403 不会被写成"Key 失效"**,它标 `uncertain: true`,并给出"换同渠道其它模型再试"的判别法。
- 认不出来的一律 `unknown` + `uncertain`,不编原因。
- `target` 只指向内部控制台页面,没有合适页面时返回空串,不给外部 URL。

---

## 6. 脱敏诊断报告

入口:诊断页底部「脱敏诊断报告」→「读取报告预览」→「下载 JSON」。接口
`GET /api/diagnostics/report`。

只包含白名单字段:

- `schema_version`、`generated_at`、`version`;
- 运行时:`platform` / `arch` / `node`;
- Claude 与 Codex 两组的**配置状态枚举**(`router` / `configured` / `missing` / `unreadable`),不是路径;
- 渠道计数:每组总数、启用数、已配置 Key 数;
- 超时、重试等**数值型**设置在用的值;
- 请求计数按(app、状态类、协议线)聚合,以及 tokens 计数与内存窗口容量。

**不包含**:Key、`providers.json` 正文、日志原文、prompt、会话标签或标题、用户名、
数据目录与客户端配置的完整私有路径、上游地址。

报告**不会自动上传**;页面只在你点击后读取,下载在本机完成。分享前仍建议自己过一眼。

---

## 7. 多 Key 自动备用(可选,默认关闭)

入口:**渠道与 Key** 页渠道网格下方的「多 Key 自动备用」面板。选择渠道 → 打开开关
(`PUT /api/providers/:id { "key_fallback": true }`)。状态视图来自
`GET /api/keys/health`。面板按行显示渠道与 Key ID、状态(最近失败/正常)、范围(账号级或某个模型)、
最近状态码与时间;接口返回里另有失败次数,页面不单独展开。

默认关闭时,所有入口原样返回,不记录任何状态,行为与之前逐字一致。开启后:

- **正常请求保持账号粘性**:同一会话在同一渠道优先继续用上次成功的那把 Key,只有它被判定失败
  才换号。**这意味着在控制台切换渠道的生效 Key 不会迁移已经在粘性里的会话**——它们会继续用
  上次成功那把,直到那把失败(或粘性记录被容量上限淘汰)才重新按"生效 Key 优先"挑选。
  要让某条会话立刻换账号,用会话覆盖里的固定 Key,而不是只切 `active_key`。

**失败归因只影响本请求的换号**:

| 上游结果 | 归因 | 行为 |
| --- | --- | --- |
| 401 / 402 | 账号级 | 本请求跳过该账号的所有模型,尝试备用 Key |
| 403 / 404 / 429 | 模型级 | 本请求跳过该 Key 的对应模型,其他模型照常可用 |
| 其它 4xx | 请求自身 | 不归因到 Key,不换号 |
| 网络错误 / 5xx | 与账号无关 | 不换号,不禁用渠道或 Key |

- **不设冷却**。失败 Key 的排除集合属于当前请求,新请求和并发请求立即可用。诊断记录不参与选号。
- **不追加等待**。不解析或等待 `Retry-After`;`wait_ms` 恒为 `0`。本请求所有 Key 失败时标记 `all_failed`,使用原有调用上限、总预算和普通重试间隔。
- **固定账号不换**。会话固定 Key 与压缩专用 Key 保持不变;粘性账号删除或停用时明确返回 503。
- **不改配置**。不改渠道库、`active_key`、模型或 Key 清单;换号只替换本请求的副本,成功后更新该会话的粘性。
- **诊断记录有界**。只保存失败范围、状态码与时间,`state` 为 `failed`,`until` 恒为 `0`;成功时清理对应记录,重启即清空。
- 仅一把可用 Key 时不换号、不等待;普通重试仍受 `MIXR_MAX_ATTEMPTS`、`MIXR_RETRY_DELAY_MS` 与端到端总预算约束。
- 日志里换号来源记为 `key_source: "key_fallback"`,Key 明文不进日志。

---

## 8. 后台服务、检查更新与升级(入口)

这三个入口是**可选**的,面向从 Release 运行包长期运行的用户。`npm run service` /
`npm run update` / `npm run upgrade` 分别等价于 `node scripts/service.js`、
`node scripts/check-update.js`、`node scripts/upgrade-release.js`;
安装与升级的完整步骤见[安装、运行与卸载](installation.md)与
[升级与回退](upgrade-and-rollback.md);这里只说边界。

```bash
npm run service status                 # 只读:发布目录、current、运行中实例、登录服务
npm run service -- install             # 默认只预览;加 --apply --yes 才写 plist,--load 立即装载
npm run service -- restart             # start / stop / restart:只操作本工具安装的登录服务

npm run update                         # 默认不联网,只读本机状态
npm run update -- --check              # 显式向官方 Releases 查询最新版本

npm run upgrade                        # 默认只预览:不联网、不写文件
npm run upgrade -- --version 3.x.y --download   # 显式允许联网取官方发布
npm run upgrade -- --archive ./mixrouter-3.x.y.tar.gz   # 或本地包 + .sha256
# 以上都在确认后加 --apply --yes 才执行
npm run upgrade -- --rollback-to <旧发布目录> --apply --yes
```

> `npm run` 会把不带 `--` 的参数当成 npm 自己的选项丢掉,所以给脚本传 flag 必须写成
> `npm run <脚本> -- <参数>`;只传子命令(如 `status`)时不加也可以。

边界(与实现一致):

- 登录服务只写 **macOS LaunchAgent**,默认 label 是 `com.<用户名>.mixrouter.managed`,
  且只认文件里带 `mixrouter-managed` 标记的那一份;同 label 的手写 plist 只会被展示,
  **不会被覆盖或删除**。`install-macos.sh` / 旧 `mixctl` 用的 `com.<用户名>.mixrouter`
  不在接管范围,指定它会直接报 `legacy_label`。
- 发布根默认是 `<安装根>/releases`(可用 `MIXR_RELEASE_ROOT` 改);显式 `--install-root`
  时以该根下的 `releases/` 为准,不读 `MIXR_RELEASE_ROOT`,避免环境变量改道。
  历史上还有一种 `<安装根>/current` 落点,工具两种都认;两份同时存在会作为漂移报出来。
- `service start` / `stop` / `restart` 通过 launchctl 操作**本工具自己的 label**
  (装载 / 卸载 / 重启),不会去猜别的服务。
- 升级工具停旧实例前先取归属证据。第一级是**命令行按 argv 形状精确识别**:分词后逐项比较,
  只认「`node` 入口 + 某个参数恰好等于该发布目录下的 `mixrouter.js`」,不做路径子串匹配
  (否则 `vim <目录>/package.json` 也会被当成服务)。服务启动后会把 `process.title` 改成
  `mixrouter`,此时命令行只剩一个词、无法自证归属,于是落到二级证据:pid 文件与进程启动时间吻合
  (容忍 2 分钟),或服务自报的 pid 与源码指纹一致。都不成立就报 `not_owned`,
  不误停其它服务或 PID 复用的进程。
  停之前先看在途请求
  (服务没有上报 `active_requests` 时如实说"看不到",不当成 0),再等进程退出;
  `--drain-timeout` / `--start-timeout` 控制等待上限。
- `update --check` 只查固定仓库 `yange0793-dot/mixrouter-oss`,没有 `--repo` / `--url`;
  结果不缓存。
- `upgrade` 只从官方 Release 下载,每一跳重定向都校验 HTTPS 与主机;装配前依次校验
  `.sha256`、解包成员路径(拒绝绝对路径、`..`、符号链接)、版本三处一致与制品清单。
  默认安装到 `releases/<版本>-<源码指纹前 8 位>`(可用 `--release-name` 指定),整份就绪后
  原子切换 `current`;已存在的发布目录不会被覆盖。
- **数据目录只读**:升级不写、不迁移、不备份 `providers.json` 等文件;数据文件解析失败会中止,
  必须人工处理后重试。
- **没有绕过开关**:`--force` 与 `--force-kill` 已移除,传了直接报参数错误。排空或退出超时会中止升级
  (不打断在途请求),不会为了让流程"成功"而跳过检查。
- 失败会切回旧 `current` 并尝试恢复旧服务;恢复失败会明确报告,不静默留在半升级状态。
- 升级不通过 `mixctl start` 拉起服务(它可能在存在 plist 时 kickstart 另一个 label),
  只走"托管登录服务"或"直接派生并写 `.run/mixrouter.pid`"两条明确路径。

---

## 9. 相关接口一览

| 方法与路径 | 作用 | 写操作 |
| --- | --- | --- |
| `GET /api/onboarding/<claude\|codex>` | 检查客户端安装、配置状态、是否已路由 | 否 |
| `POST /api/onboarding/<app>/preview` | 预览受管字段差异,签发一次性令牌 | 否 |
| `POST /api/onboarding/<app>/apply` | 确认写入(`token` + `confirm: true`) | 是 |
| `POST /api/onboarding/<app>/undo-preview` | 预览撤销与冲突 | 否 |
| `POST /api/onboarding/<app>/undo` | 确认撤销(`token` + `confirm: true`) | 是 |
| `POST /api/providers/import/preview` | 解析、去重、脱敏预览 | 否 |
| `POST /api/providers/import/apply` | 合并进渠道库(`token` + `confirm: true`) | 是 |
| `POST /api/providers/<id>/compatibility` | 兼容测试,需 `confirm_run: true` | 发真实上游请求 |
| `GET /api/attempts` | 本进程内存里的尝试过程 | 否 |
| `GET /api/keys/health` | 多 Key 备用状态(脱敏) | 否 |
| `GET /api/errors/guidance` | 错误解释六项 | 否 |
| `GET /api/diagnostics/report` | 脱敏诊断报告 | 否 |

所有接口都只在本机回环地址上提供;`Host` 与来源检查、写操作拒绝跨站来源的规则不变,
见 [SECURITY.md](../SECURITY.md)。
