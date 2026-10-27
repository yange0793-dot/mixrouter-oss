# 变更记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/);版本号遵循语义化版本。
发布说明里只放摘要,细节与升级注意事项以本文件为准。

## [Unreleased]

#### 改进

- 控制台统一标题、操作栏和留白,桌面侧栏可收起并记住偏好,手机保持导航抽屉。
  概览按接入状态显示入口;渠道列表突出当前账号与生效状态,接入说明和次要配置按需展开。
- 用量页调整筛选、指标卡和明细表层级,热力图按日志覆盖默认显示最近 13–53 周,
  更早数据可继续展开。未覆盖日期与零请求仍分开,筛选与统计口径不变,不恢复费用估算。
- 路由、会话、诊断、Harness 与备份页压缩重复说明,保留配置和数据入口。
  会话绑定与实际落点分层显示,跨天活动时间补日期;诊断表合并相关指标,保留缓存读数与命中率。

#### 移除

- 移除旧 DeepSeek Harness 全配置托管、固定角色与子策略模块,旧 `/dsh/*`、`/api/dsh` 和
  `dsh.json` 不恢复。新的轻量入口仅管理主模型与子代理白名单池,不会自动迁移旧配置。
- 移除渠道与 Key 的时间冷却:429/4xx/5xx/网络失败不再建立禁用窗口,也不按 `Retry-After`
  追加等待。`MIXR_COOLDOWN_SEC` 不再生效。同一渠道多 Key 变坏时只在**本次请求**内排除
  失败 Key,重试次数、间隔与总预算沿用 `MIXR_MAX_ATTEMPTS` / `MIXR_RETRY_DELAY_MS` /
  `MIXR_TOTAL_DEADLINE_MS`,全部失败如实收尾,不拒绝新请求。控制台与 `mixctl` 不再展示
  冷却倒计时;`/api/health` 的 `cooldown_until`、`/api/state` 的 `cooldowns`/`cooldown_s`、
  会话记录的 `cooldown`、`/api/keys/health` 的 `until` 作为旧客户端兼容字段恒为 0/空/false。

#### 修复

- Codex 原生 Responses 与 Chat 转换线在完整临时错误帧后跟无输出尾帧时继续按原预算重试,
  不再因同批字节中的 `[DONE]`、注释或空帧直接把限流错误交给客户端。
  未知字段、非法帧、部分尾帧及正文/推理/工具输出仍是重放屏障;不增加限流窗口或额外退避。
- Azure 资源恢复补齐日志分类:首次投影、重发同一投影和官方 AgentRouter 窄历史错误分别记录
  `retry_reason`;首次恢复被预算拒绝或因输出提交、客户端断开、时限等条件跳过时记录固定原因。
  不扩大历史改写范围,不增加重试预算,不把旧日志缺少字段当成未恢复的证据。
- 原生 Responses 历史含投影无法处理的**已完成**内置项(典型 `web_search_call`)时,原先在
  `resource_recovery_skipped` 后直接放弃恢复。现在只要错误已判为可恢复(Azure 资源绑定或
  官方 AgentRouter 的窄 400)、目标是官方 AgentRouter HTTPS、且历史完整可复核,就在既有的
  次数与总预算、输出提交屏障内**原样**重投同一份字节:不删内置项 `id`、不改写历史,日志记
  `retry_reason: unprojected_resource_retry` 与被跳过的分类。未知内置项形状、未完成项、
  服务端历史引用、工具配对不全、已输出内容及非官方目标保持原有终态错误。
- AgentRouter 原生 Responses 的特定 HTTP 400 `Upstream rejected the request as invalid`
  在完整内联历史校验通过后复用资源 ID 投影恢复;仅匹配明确端点与错误结构,保持模型、账号、
  内容和预算,不把内容拦截、普通字段错误或未知渠道的 400 当成资源错误。
- 原生 Codex 的完整内联历史允许工具结果项携带资源 `id`,Azure 跨资源恢复时一并移除,
  兼容原生推理项的 `content: null`,保留 `call_id`、工具结果、命名空间、加密推理与请求档位;历史验证拒绝时记录
  `resource_recovery_skipped` 固定分类,不再无说明地跳过恢复。用户会话存档与客户端配置不改写。
- `explain` / 路由预览接入与实跑相同的 Codex 旧登记 ID 兼容映射,保留身份与受管配置门槛;
  预览须显式提供原生标识、本地路由凭据与完整 `cx:` 会话键,不自动补齐身份,仍脱敏且零副作用。
- Codex 旧默认 ID 兼容映射支持原生 `codex_desktop/` 标识,保留登记 ID、本地凭据、可靠会话与
  受管接入门槛;路由准备阶段的本机拒绝同步记入脱敏请求日志,尝试数与 tokens 为 0,
  Codex 无路由附带布尔身份诊断,不回填历史失败。
- Codex 主模型、审查模型与自拟槽位分别选择渠道和落点模型,支持登记模型与自定义落点;
  修复保存时丢弃模型、转发强制使用渠道默认模型的问题。显式落点不修改其它槽或渠道默认值,
  留空继承默认;模型字段类型错误在写入前拒绝。槽位回显区分显式值、有效落点与客户端接入状态。
- Codex 渠道可登记多个候选模型,获取模型列表可批量追加,不自动改默认模型。
  模型列表接口同步列出登记模型与槽位有效落点。
- Codex 已接入路由时,保存槽位自动同步托管模型目录,后续别名请求热切换落点,
  移除重复应用步骤与独立推理设置面板。接入自动采用可用主槽与审查槽别名,
  目录显示名标明实际落点;已有推理强度与用户上下文设置不变。原生客户端缓存的显示名
  需重新打开客户端才读取新目录。已登记的旧默认 ID 仅在原生 Codex 标识、本地路由凭据和
  可靠会话同时满足时跟随槽位;显式选择同名 ID 也会命中,其它模型与客户端不受影响。
  已知落点使用自身能力,未知能力不猜测。
- Chat → Responses 的 JSON 与流式终态始终带齐缓存与推理用量明细,修复 Codex
  `ResponseCompleted` 缺少 `reasoning_tokens` 的解析错误;保留上游已报告的计数与扩展字段。
- 原生 Responses 在输出前连接中断、生命周期事件后提前结束,或收到明确的临时错误时,
  按现有次数与总时限重试;正文、推理或工具事件一经转发便不重放。恢复尝试固定同一渠道、
  账号、模型与请求,不改变既有普通 HTTP 错误的可选多 Key 备用和路由故障转移。
- 原生 Responses 保留 HTTP 错误的原始正文与响应头,不因 SSE MIME 把真实错误替换为
  “缺少完整终态”。已确认的 Azure 跨资源错误仅在完整内联历史验证通过后投影一次,
  移除受支持的 item ID,保留工具配对、推理和其余请求字段;重复故障只在原预算内重发
  同一投影。含服务器历史引用、`/responses/compact`、普通 400 与未知协议签名不猜测性改写。
- 原生 Responses 日志记录实际发送的推理档位;恢复成功后清理此前失败的错误分类。
- Codex 经 Chat 上游收到 HTTP 200 SSE 的明确临时错误时,在输出前用最多 64KiB 的严格空
  chunk 前缀门控恢复;延迟合成 `response.created`,避免转换器先输出而封死透明重试。
  同落点重发共用既有次数与总时限,日志记 `retry_reason: chat_preoutput_retry`;
  未知字段、部分帧、压缩前缀及已输出内容不重放,不删除 `response_format` 绕过格式限制。
- Responses → Chat 回放可读推理时优先用 `content`,无可读 content 才回退 `summary`;
  连续推理累积,空项或纯密文项不擦除已有可读内容,关联到 assistant 正文与同响应工具。
  新 reasoning 不覆盖此前 assistant 的推理,用户/system/developer/工具结果边界清空关联。
  只有密文的历史不能还原成 DeepSeek 明文,不伪造推理或补空字段;协议或格式不兼容仍失败。
- Chat SSE 中不可恢复的 `data.error` 译为 Responses `failed` 终态,保留原 message 及字符串/
  数字 code,缺少 code 才回退 `upstream_stream_error`,不冒称 `completed`。

#### 新增

- 官方 AgentRouter HTTPS 的原生 Responses 支持一次性加密 reasoning 有损降级:
  仅在尚未输出、完整未压缩的 HTTP 400/2xx 错误精确匹配 `invalid_encrypted_content`、且完整
  内联历史通过严格校验时,移除 reasoning 的密文及该项自身 `id`,保留可读推理和所有其他项
  ID,省略纯密文项。重试共用现有次数与总时限,保持渠道、模型、Key 和会话身份;
  响应带 `x-mixrouter-recovery: encrypted-reasoning-dropped`,日志记
  `retry_reason: encrypted_reasoning_downgrade`。鉴权、额度耗尽、上下文长度错误、未知/不完整
  历史或混合输出不触发降级,已输出内容不重放。这不是解密,未接入客户端 turn 自动续跑。
- Codex 页面接入自动压缩阈值,支持自定义 token 数、`k` / `m` 和恢复模型默认;
  只改全局 `model_auto_compact_token_limit`,保留模型、推理强度、窗口和其它原生配置。
  保存前备份并检查 revision,默认/有效阈值按已同步目录与显式窗口推算,已知上限为窗口的 90%;
  未知能力不猜测,已打开客户端须重新读取配置,不宣称热改活会话。
- 独立「DeepSeek Harness」页,只提供主模型与子代理白名单池两个业务配置区;
  路由保存到 `harness.json`,主模型自动纳入池,不影响其他客户端槽位与会话覆盖。
  使用 Harness 原生普通子代理白名单验证显式选择,主模型可按任务自主选择池内模型。
  预览并明确确认后才最小合并客户端字段与凭据引用,先备份、不重启;
  池更新需重新接入并新开会话,不声称覆盖所有 workflow/fork/team 调用。
- 新建 / 编辑渠道可根据 Base URL 和 API Key 获取上游模型列表,支持搜索选择、已有账号 Key
  及未保存的 Key。Claude 组去重追加且保留原主模型,Codex 组去重追加登记候选且保留默认模型;
  获取本身不保存渠道、不切换账号、不发送聊天请求。
- 新增 `POST /api/providers/models`,兼容 Anthropic / OpenAI 模型列表与 Anthropic 分页,
  沿用渠道出站代理和直连配置。限制请求时长、响应大小与页数,不跟随重定向,
  不回显上游错误正文或凭据;上游不支持列表时仍可手填模型。
- 控制台新增**首次接入向导**(渠道与 Key 页):检查客户端安装与配置、选/导入渠道、选模型与
  协议、可选兼容测试,最后预览受管字段并确认写入。预览令牌一次性、默认 5 分钟;
  预览后配置文件被外部修改则拒绝写入(409)。支持 Claude Code、Codex、ZCode;
  读配置区分 `missing` / `invalid` / `error`,不把"读不到"当作"未配置"。
- 接入后可**撤销本次写入**:账本 `client-managed.json`(`0600`)记录受管字段的写前/写后值,
  撤销只还原"当前值仍等于写后值"的字段;任何受管字段被改过就整体拒绝并列出冲突,
  不覆盖后来新增的其它设置,也不还原接入时被清理的其它 `mixr-*` 段。
- 控制台新增**渠道粘贴导入**:识别 mixrouter `providers.json` 与 cc-switch 导出(含
  `settings_config` / `settingsConfig` 里的 Claude env 与 Codex TOML)。先预览后确认,
  只取白名单字段,按 app + base_url + api_key 去重,只增不改,不覆盖已有 id、Key 与 `current`。
- 新增**编程兼容测试**:经真实转发链路分别检查认证(派生)、非流生成、流终态与工具调用形状;
  未显式 `confirm_run` 不发请求,一次最多 3 次上游调用,有总时限、单项时限、输出与结果大小上限。
  测试使用隔离依赖:不写会话绑定、不触发渠道冷却、不写响应归档、不读真实渠道库。
- 控制台 Claude 槽位行新增**后备池编辑器**:主渠道固定第一,后备成员可选渠道与落点模型、可排序;
  保存是对 `pool` / `strategy` / `dropTools` 的部分更新,不把非 `priority` 策略改成 `priority`;
  保存空列表即清空后备池。
- 新增**错误解释**与**尝试过程**:`GET /api/errors/guidance` 把代理错误码、401/402/403/429/5xx、
  超时与网络错误翻译成分类、影响、下一步与内部控制台目标页;403 标不确定,不判成 Key 失效。
  诊断页新增有界的实时尝试过程(最多 100 条、每条 40 个事件、15 分钟过期、仅内存),
  日志新增 `request_id` 与之关联;两者都不含 prompt、会话标签、Key 或上游 URL。
- 新增**脱敏诊断报告**:`GET /api/diagnostics/report` 只按白名单重建版本、运行时、
  客户端配置状态枚举、渠道计数、超时/重试设置与按组聚合计数;不含 Key、配置正文、
  日志原文、prompt、会话标题、用户名或私有路径,不自动上传。
- 新增**可选多 Key 自动备用**(按渠道,字段 `key_fallback`,默认关闭):正常请求保持账号粘性,
  仅 401/402(账号级)与 403/404/429(模型级)失败才换号;网络错误与 5xx 不换号。
  不写渠道库、不改 `active_key`、不删 Key;会话固定 Key 与压缩固定 Key 永不换,
  粘定 Key 被删/停用时返回 503 `provider_key_unavailable_error`。状态只在内存、有上限、无定时器。
- 新增可选的后台服务、检查更新与受控升级入口:`npm run service`
  (`status` / `install` / `uninstall` / `start` / `stop` / `restart`,默认预览)、
  `npm run update`(默认不联网,`--check` 才查询)、`npm run upgrade`
  (默认只预览,`--apply --yes` 才执行,支持本地包、`--download`、`--rollback-to`)。
  登录服务只写带 `mixrouter-managed` 标记的 LaunchAgent,不覆盖同 label 的手写 plist,
  `start/stop/restart` 只通过 launchctl 操作自己的 label;升级停旧实例时只停命令行确认从
  目标发布目录启动的进程;升级包校验 `.sha256`、解包路径、版本三处一致与制品清单,
  数据目录只读,失败切回旧 `current`。

#### 接口

- 新增 `GET/PUT /api/harness`、`POST /api/harness/{preview,connect}`,
  以及隔离模型池路由 `/harness/v1/{models,messages,messages/count_tokens,responses,chat/completions}`;
  未知别名和不兼容协议明确拒绝,不回落普通路由。
- 新增 `GET /api/onboarding/<claude|codex|zcode>`、
  `POST /api/onboarding/<app>/{preview,apply,undo-preview,undo}`。
- 新增 `POST /api/providers/import/{preview,apply}`、`POST /api/providers/<id>/compatibility`、
  `GET /api/attempts`、`GET /api/keys/health`、`GET /api/errors/guidance`、
  `GET /api/diagnostics/report`。
- `PUT /api/providers/:id` 接受布尔 `key_fallback`;为 `true` 时写入,为 `false` 时删除该字段。
- 请求日志白名单新增 `request_id`;`key_source` 在多 Key 备用换号时记为 `key_fallback`。
- 默认重试策略不变(`MIXR_MAX_ATTEMPTS` 10 次 × `MIXR_RETRY_DELAY_MS` 1000 毫秒);
  没有恢复熔断器,也没有加入 Retry-After 驱动的默认等待。

#### 安全

- 导入拒绝 `__proto__` / `constructor` / `prototype` 字段并按白名单重建对象;预览只返回掩码 Key。
- 诊断报告按白名单重建,不含私有路径、用户名、会话标题与凭据。
- 接入账本与客户端配置备份按凭据文件对待(`0600`);`SECURITY.md` 与 `SUPPORT.md`
  明确禁止公开贴出。
- 升级只信任固定官方仓库与 HTTPS 主机,每一跳重定向都重新校验;拒绝含绝对路径、`..`、
  链接或特殊文件的压缩包。

#### 未验证范围

- 请求内恢复与可读推理转换不保证所有跨协议历史兼容;纯密文推理不能还原为明文。
  未接入客户端 turn 自动续跑,也没有真实 GUI 续跑验证。
- 接入向导、兼容测试、撤销、服务与升级、多 Key 备用只在 **macOS + Node 24** 上跑过测试与
  离线 fixture;**没有对真实上游发起生成请求**;其他平台未实跑,也没有对应的 CI 通过结论。

## [3.9.0] - 2026-10-21

#### 改进

- 按桌面工具布局重排控制台:中性灰侧栏、白色内容区、统一页标题与操作栏,
  Claude Code / Codex / ZCode 可从左侧直接进入,选中态与浏览器历史同步。
- 用量页改为四张独立指标卡、按周排列的日历热力图和「请求日志 / 供应商 / 模型」标签表格;
  支持按日读数、请求翻页、键盘操作、浅深主题及移动端抽屉。
- 用量页共用时间、协议组、供应商、实际模型与请求状态筛选。供应商与模型精确匹配;
  请求记录和汇总来自同一份日志快照,不再把内存窗口当成历史明细。
- 数据来源显示当前可用日志范围与统计口径,未覆盖日期和零值区分显示;
  缺失测量值显示「—」,同步失败明确标记旧数据。首响应指上游响应头到达,不是首个文字 token。

#### 接口

- `GET /api/usage?dashboard=1` 可选扩展日汇总、请求分页、筛选选项与日志观测边界。
  不带扩展参数时保持既有响应结构和子串筛选;不改变路由、日志落盘格式或用户配置,
  不恢复价格表或费用估算。

## [3.8.0] - 2026-10-20

控制台改版为紧凑工作区,补主题、深链接与用量图表交互;新增槽位兼容别名与用量统计接口。
路由协议、落盘格式与既有接口保持兼容。

#### 新增

- Claude 组增加兼容别名 `claude-mixr-<槽名>`,与规范别名 `mixr-<槽名>` 指向同一个槽位;
  用于只接受名字含 `claude` 的网关模型名的客户端。Codex 组不认该前缀。
- 请求日志新增「请求体」列(`bytes_in`,客户端请求体字节数),用于观察大上下文下的首字延迟。
- 控制台新增「用量统计」页:按区间(今天 / 24 小时 / 7 天 / 30 天 / 全部)、协议组、渠道与模型
  汇总请求数、tokens、缓存命中率、速度与首字延迟。页面只报真实消耗,不折算金额。
  统计读磁盘 `requests.jsonl`(含轮转归档),内存环只补更新条目,不重复计数。
- 日志新增 `ttfb_ms`(请求开始到上游响应头到达),接口 `GET /api/usage`。

#### 改进

- 控制台改为紧凑工作区:导航按配置、观察与设置分组,统一三个客户端的接入摘要,
  渠道库移至高频操作区,模型槽位折叠展示,支持列表/卡片切换。启用状态与上游连通性仍分别标明。
- 新增系统/浅色/深色主题、`⌘K` / `Ctrl+K` 快速跳转、页面深链接和前进/后退导航;
  移动端改用抽屉导航。浏览器偏好只影响界面,不改路由、客户端或服务端配置。
- 用量趋势图统一主题配色,支持鼠标、触摸和键盘定位,并提供逐时间桶数据表;
  仅呈现已有请求日志,不新增费用估算。发布包检查覆盖工作区与用量脚本,防止漏发静态资源。

- 会话页「当前绑定」只保留一个「配置 Key / 槽位」入口,点开即编辑该会话的整组槽位;
  编辑器沿用全局槽位的行式布局,支持模型下拉、自定义模型、复制全局渠道/模型到草稿及逐槽恢复继承。
  渠道 Key 与普通请求钉定分开设置;保存只影响该会话,沿用现有路由优先级与落盘格式。

- 请求重试放宽:`MIXR_MAX_ATTEMPTS` 默认 3 → 10,语义是**一次请求最多打多少次上游**——
  同一个渠道也会被重复尝试,不再是"最多几个候选渠道";新增 `MIXR_RETRY_DELAY_MS`
  (默认 1000,范围 0–60000)控制每次重试前的等待毫秒数。一次请求的上游调用总上界为
  `MIXR_MAX_ATTEMPTS` + `MIXR_CONV_RETRIES`(默认 13);端到端总预算仍优先,预算用尽后不再重试。

#### 移除

- 上游健康里的断路器整体移除:不再有闭/开/半开状态、失败阈值、恢复阈值与半开探测名额,
  也没有 `circuit_open` 错误类。渠道失败后只进冷却:在 `MIXR_COOLDOWN_SEC`(默认 60 秒)内
  不参与挑选,全池都不可用时退回全量候选,请求照常发出,不会被拒绝。
  `MIXR_BREAKER_FAILURE_THRESHOLD` 与 `MIXR_BREAKER_RECOVERY_THRESHOLD` 随之删除(启动参数里
  还留着不会报错,但已无作用);设置里的 `failure_threshold` / `recovery_threshold` /
  `half_open_max_probes` 一并移除,新增 `retry_delay_ms`。`GET /api/health` 的 providers 每项为
  `{provider, app, enabled, eligible, cooldown_until}`;控制台渠道卡片不再显示断路器徽标,
  设置页健康表不再有这一列。
- 用量统计不再折算金额:移除价格表 `pricing.json` 与 `GET/PUT /api/pricing`(现在返回 404)、
  控制台价格表弹窗、金额指标卡、金额图表 tab 与明细表的金额列。`GET /api/usage` 的 `totals` 为
  `{reqs, ok_rate, tokens_in, tokens_out, cache_read, tokens_total, cache_hit_rate, speed_tps, ttfb_p50_ms}`,
  `series` 每桶 `{t, reqs, tokens_in, tokens_out, cache_read}`,
  `by_provider` / `by_model` 每项 `{provider, name | model, reqs, tokens_in, tokens_out, cache_read}`,
  按请求数降序。

#### 修复

- 槽位别名匹配先剥掉 `[1m]` 上下文后缀,客户端多写这一段不会再掉进普通规则;
  `explain` / 路由预览的别名判据与真实解析共用同一实现。

## [3.7.0] - 2026-10-19

改进开源交付:首次启动、只读诊断、安装与升级说明、解包制品验收。路由协议与落盘格式不变。

#### 新增

- `npm run local`:面向新安装的前台启动入口,默认将运行数据放在固定的用户目录,与源码分离。
  支持 `--data-dir`、`--port`、`--ui-port`;发现源码目录已有数据时要求明确选择,不自动迁移。
- `npm run doctor`:本机只读自检 Node、运行文件、配置顶层结构、数据权限与回环服务;
  支持 `--offline` / `--json`,不调用真实上游、不回显 Key 或会话内容。

#### 文档与发布

- 整理中英文项目入口与求助说明,完整命令及边界移至专题文档,保留原有行为约束。
- 增加安装、运行与卸载说明,区分 v3.6.1 旧入口与 v3.7.0 新入口,不把实验性桌面外壳当作正式安装包。
- CI 与 Release 在解包目录执行只读自检与离线 smoke,不再只检查文件清单;
  新增 macOS Node 24 制品验收任务。GitHub Actions 依赖按月检查更新,普通 CI 权限限于只读。
- 新入口不改变 `npm start` 的数据目录默认值,不自动接入客户端或安装后台服务。
  现有部署保持兼容;`npm run doctor` 检查旧部署时需显式指定其数据目录。

## [3.6.1] - 2026-10-18

首个公开版本。把"自己能用"推到"别人拿到源码能看、能验、能报问题"。协议层没有新能力。

#### 安全

- 代理与控制台只接受字面量回环 `Host`(`127.0.0.1` / `[::1]`,可带端口)。这不只是网页的事:
  **用 `localhost` 或自定义域名访问的本机客户端(含 CLI)也会被拒**,统一改用
  `http://127.0.0.1:8787` / `http://127.0.0.1:8788`。目的是挡住 DNS rebinding 让外部域名
  成为同源页面后直读控制台或消耗上游 Key。
- 控制台写操作拒绝跨站来源(`Sec-Fetch-Site` / `Origin`);不带这些头的本机 CLI 不受影响。
- 代理只接受 `Content-Type: application/json` 的 POST,拒绝 `no-cors` 形式的跨站简单投递;
  非 POST 的协议路径直接 404,不再落进读体分支。

#### 修复

- 槽位请求(别名 `mixr-*`)不再被对话粘性劫持:备池落点按槽位自己的策略选,不再沿用
  该对话之前绑定的渠道。
- 路由预览的落点展示:原先取的是**错误的层级**(把"当前选中项"当成了预测结果),
  所以推断不出真实落点时页面显示的并不是预测。现在改读 `selection.predicted`,
  并对槽位请求、全候选未通过预检两种情况的说明文字一并对齐;预测与实际落点仍是两个概念,
  页面上分别标注。

#### 文档

- README 按"安装 → 配置 → 路由 → 排障"重排,补上专题文档与可直接复制的示例配置。
- 新增 `CONTRIBUTING.md`(测试与提交流程)、`SECURITY.md`(私密报告渠道)、本变更记录;
  内部开发记录(`docs/changes/`、`evidence/`、审计报告)只留本地,不进公开索引。

#### 发布与工程

- 发版制品是**运行包**(不是完整源码镜像):`test/`、`.github/` 与上线/回退运维脚本都不进包
  (内部开发记录与取证材料也不在公开仓库索引里)。运行包里的验证方式是 `npm run smoke`;在那里跑 `npm test`
  会明确报"此运行包不含开发测试套件"并以非 0 退出,不会伪装成全绿。
- 上线/回退用的 `scripts/deploy-live.sh` 与 `scripts/preflight-live-data.js` 不再进发布物;
  两者改为必须显式给 `MIXR_LIVE_DIR`,launchd 标签与开发目录也改为按当前用户推导/可配置,
  不再写死任何人的主目录。
- 发版工作流校验 tag、`package.json` 的 `version`、`mixrouter.js` 的 `VERSION` 三处一致,
  不一致直接失败;CI 额外断言运行包里没有开发/内部材料、且验证入口与维护文档齐全。
- macOS 外壳(`app/MixrouterApp.swift` + `scripts/build-app.sh`)去掉写死的个人目录兜底,
  改为按安装根的 `releases/current` 链接定位;`BUNDLE_ID` 改为通用值并可用
  `MIXROUTER_BUNDLE_ID` 覆盖。安装器与外壳都仍是**实验性**的,不是受支持的正式入口。

#### 兼容性

- 运行时仍要求 Node ≥ 18,零第三方依赖。
- `providers.json`(version 2)、`sessions.json` / `slots.json`(version 1)的落盘格式不变,
  与 3.6.0 双向兼容;读取侧不做版本闸门,回退前请人工核对,见
  [`docs/upgrade-and-rollback.md`](docs/upgrade-and-rollback.md)。
- Host / 来源检查会影响使用 `localhost` 或域名的本机客户端(见上「安全」);改用
  `127.0.0.1` 字面量即可。

## 更早的版本

本文件从 3.6.1 开始维护。3.6.0 及之前没有逐版变更记录,仓库的 git 历史与 tag 是唯一来源。
