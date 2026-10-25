# DeepSeek Harness 轻量接入

这条入口只管理两个业务设置:

1. **主模型**:选择一个已经存在于 Mixrouter 渠道库中的渠道与模型。
2. **子代理白名单池**:列出主模型可以为普通子代理选择的渠道/模型组合,不预先分配固定角色。

工具、权限、工作区和其他 Harness 插件配置仍在 Harness 中维护。旧 `/dsh/*`、`/api/dsh`
与 `dsh.json` 不恢复,也不自动迁移旧配置。这里的白名单池不是失败转移池:一个模型别名只映射
一个确定的渠道/模型组合,不会失败后偷偷换成另一个池成员。

## 在哪里填什么

1. 在 Mixrouter 的 Claude Code 或 Codex 渠道库添加渠道、Key 与准确模型名。
2. 左侧进入 **DeepSeek Harness**。在「主模型」选渠道和模型。
3. 在「子代理白名单池」加入允许调用的模型,再保存。主模型组合会自动纳入池并显示在保存结果里。
4. 选择预览接入,检查将修改的 Harness 字段,确认后才写入本机配置。
5. 在 Harness 新开会话。主模型可在普通子代理的显式模型参数里选择池内别名。

**普通保存只修改 Mixrouter 的 `harness.json`**,不写 Harness 配置,也不重启任何进程。
更换主模型落点立即影响下一条主模型别名请求;白名单成员变动还需要再次预览/确认接入,
并新开 Harness 会话,因为原生白名单在会话创建时快照。

## 写入范围与凭据

默认目标是用户主目录下 `.dsh/profiles/desktop/cordis.patch.yml`。
可用 `MIXR_HARNESS_PROFILE` 指定绝对路径;未指定时其根目录取 `DSH_HOME` 或 `~/.dsh`。
启动服务不会读写该配置;打开状态页会只读检查,确认接入才写盘。

接入只合并以下原生配置:

| 字段 | 写入内容 |
| --- | --- |
| `llm-pi-ai.config.providers.mixrouter-harness` | 本机 Messages 入口、模型别名与凭据引用 |
| `agent-default-model.config.provider/model` | `mixrouter-harness` / `mixr-harness-main` |
| `subagent-model-selection-settings.config.enabled/allowedModels` | 启用普通子代理显式模型白名单,注册池内别名 |

供应商入口使用 `anthropic-messages`,`baseURL` 为 `http://127.0.0.1:8787/harness`
(实际端口随服务配置);SDK 将 `/v1/messages` 加在后面。Mixrouter 再按渠道的 `wire_api`
在进程内翻译为 Anthropic Messages、OpenAI Responses 或 Chat Completions。

配置使用 `apiKeyEnv: MIXROUTER_HARNESS_API_KEY`。令牌存入 Harness 的私有凭据引用库,
不把上游 Key 或令牌内联到 profile、不在 API 预览中回显。这个本机令牌不代表代理支持远程鉴权。
原有 profile 与凭据文件在覆盖前备份,新写文件与备份使用 `0600`。
这些文件可能含原有凭据,不要公开分享。

只对可安全定位的字面量 YAML 做局部合并,不执行 `!!js`。接入要求现有 profile 中已经明确列出
上述三个原生插件配置行;缺失时拒绝写入,不猜测或初始化未知的原生插件组合。
若目标行本身是表达式、结构含歧义、
同名供应商属于另一套配置,或预览后文件被外部修改,接入会拒绝而非覆盖。
不自动启动、重启或修补 Harness 安装包。连接状态只核对配置字节是否一致,不是原生插件已经装载
或实际请求成功的证据;原生组合仍须在 Harness 中验证。

## 模型池和路由边界

- 主入口别名固定为 `mixr-harness-main`;池成员使用独立稳定别名。
- `harness.json` 只存主模型和池组合,不存上游 Key、固定任务类型、角色、最大深度或并发策略。
- 主模型与池成员只可引用已启用、有 Key 且列出准确模型名的渠道。渠道失效会明确返回错误。
- `/harness/v1/*` 不使用普通路由规则、会话槽位覆盖或默认模型回落;未知别名明确拒绝。
- 对不兼容协议明确报错。例如 Responses 请求不能直接落到 Anthropic 上游;客户端接入使用
  通用 Messages 入口避免这一限制。
- 模型能力声明保守,未取得能力证据时仅注册文本输入,不凭别名推断图片或思考能力。

**白名单覆盖范围:**当前 Harness 原生普通子代理入口会验证显式 `provider/model` 选择。
省略参数的调用继承主链实际落点;fork/team 有自己的继承行为,workflow 的显式调用可能不经过
同一白名单验证。这里不把它宣传成所有子调用的统一权限防火墙,也不写固定角色策略。

## 资源绑定错误恢复

某些多账号网关后端会改变资源落点。原生 Responses 历史中的 `rs_...`、`fc_...` 等输出项
`id` 绑定生成它们的资源,原样回放可能得到「来自不同资源」错误。问题不是本机 session ID。

Mixrouter 在共用代理链中识别这类已知错误,不限定某个客户端名。安全投影仍按协议区分:

| 请求历史 | 行为 |
| --- | --- |
| 原生 Responses,可携带的完整历史且含受支持的输出项资源 ID | 输出前投影一次,仅移除 message/reasoning/function_call 的 `id`;重复故障在原预算内重发同一投影 |
| 含 `previous_response_id`、`conversation` 或 `item_reference` 等服务器历史引用 | 明确拒绝恢复;混合 input 也无法证明旧历史完整,不删除引用 |
| Messages / Chat 或未知签名与语义 ID | 返回原有错误,不猜测性删除工具配对或签名 |
| `/responses/compact`、普通 400、已经发送正文/工具/无法判定的流数据 | 不使用这条资源绑定恢复 |

恢复保留 `call_id`、工具名/参数/结果、正文与 `encrypted_content`,也保留 custom tool 和
additional_tools 的语义 ID,不修改调用方原始请求。完整历史验证要求工具调用与结果类型配对。
渠道、模型、Key、session ID 与缓存身份保持不变。每个入站请求最多投影一次,之后仅重发
同一投影;所有调用共用原有次数、总时限与取消控制。预算不足或不能安全投影时保留实际
上游错误,不伪造上下文或成功终态,不会额外突破次数上限。

尝试过程里可见 `resource_binding_recovery`;只记元数据,不为此新增正文或加密推理归档。
「共用识别」不等于「所有协议任意历史都能修复」,也不保证多账号上游此后永不出错。
没有明确资源绑定错误的零用量、空 completed 或无细节 `PI_AI_ERROR` 不属于这条投影。
原生 Responses 的输出前断流、纯生命周期 EOF 与明确临时错误另走有界恢复;任何正文、推理、
工具、未知/部分帧或超限前缀都会关闭透明重试窗口。普通 HTTP 错误仍沿用已有可选 Key 备用
与路由故障转移,不据“无正文”重放所有请求。

### 不使用 Mixrouter 时

可使用独立的 [resource-history-bridge](https://github.com/yange0793-dot/resource-history-bridge):
它是本机 HTTP 桥和 Node.js 库,不依赖 Mixrouter。客户端须能修改 API Base URL 并使用 Responses;
封闭客户端或其他协议不会自动获得资源绑定恢复。独立桥有自己的保守历史类型边界,
不等同于 Mixrouter 的全部转换能力;接入命令、限制与当前验证范围以该仓库 README 为准。

## 本机 API

- `GET /api/harness`:脱敏配置、渠道可选项、连接状态与乐观版本号。
- `PUT /api/harness`:保存 `{ main, pool, expected_revision }`,不改客户端文件。
- `POST /api/harness/preview`:传 `expected_revision`,返回目标字段与 `profile_revision`,无写入。
- `POST /api/harness/connect`:传 `confirm: true`、`expected_revision`、
  `expected_profile_revision`,备份后最小写入。
- `GET /harness/v1/models`:只列这条模型池的别名。
- `POST /harness/v1/messages`、`messages/count_tokens`、`responses`、`chat/completions`:
  隔离路由入口,协议兼容性仍由实际渠道决定。

写接口沿用本机控制台的回环 Host、同源与 JSON 检查,不是公网 API。

## 已验证与未验证

实现验证使用隔离的临时 HOME、数据目录、profile 与进程内 mock 上游。
配置合并、模型池路由与资源恢复通过本地测试不等于已在真实 Harness 会话中完成端到端验收。
真实接入、真实工具循环、池更新后新会话行为,以及其他版本 Harness/其他操作系统的覆盖,
须在各自实际环境中验证。更改配置不会自动重启正在运行的客户端。
