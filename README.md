# Mixrouter

[![CI](https://github.com/yange0793-dot/mixrouter-oss/actions/workflows/ci.yml/badge.svg)](https://github.com/yange0793-dot/mixrouter-oss/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](package.json)

本机单用户的模型路由器。一个进程同时服务两套协议:

- **Claude Code(Anthropic)`/v1/messages`** 与 **Codex(OpenAI)`/v1/responses`、`/v1/chat/completions`**
  都走 `127.0.0.1:8787`,按模型名和会话身份分发到你配置的渠道;
- 只挂 Codex / OpenAI 型通道的模型也能直接给 Claude Code 用——渠道标 `wire_api: responses`
  就翻 Responses,标 `wire_api: chat` 就翻 Chat Completions,转换在进程内完成,
  客户端那侧不用再挂第二个代理;
- 同一个 Agent 的多个对话可以落在不同渠道的不同 Key 上,并**尽量**让一个对话留在同一渠道
  (默认会话粘性)。这不是硬保证:渠道冷却、熔断、失效重绑定、失败转移,以及手动改绑与会话覆盖
  都可能改变这条对话的落点;
- 子代理槽位把「渠道 @ 模型」绑到 `mixr-<槽名>` 别名,主链与子代理可以各烧各的账号;
- 浏览器控制台(`127.0.0.1:8788`)管理渠道、路由、会话、槽位、日志与备份。

> 定位是**本机单用户**工具:只绑回环地址,没有账号体系与远程鉴权。不要把它暴露到公网,
> 也不要让其他机器通过端口转发访问。数据目录里是**明文渠道 Key**。

## 快速开始

要求 Node.js。推荐 **22 或 24**;`>= 18` 仍可运行,但老版本只做兼容保留,不在当前测试重点内。
零第三方依赖,不需要 `npm install`。

```bash
git clone https://github.com/yange0793-dot/mixrouter-oss.git
cd mixrouter-oss
node --version                  # 22 / 24 推荐,最低 18
npm start                       # = node mixrouter.js,前台运行
# 另开一个终端:
curl --fail http://127.0.0.1:8787/healthz
open http://127.0.0.1:8788/     # macOS;其他系统在浏览器打开同一地址
```

控制台里添加渠道与模型,再按「客户端接入」把 Claude Code / Codex / ZCode 指到本机。
没有渠道 Key 也能启动控制台并跑离线验收,只是不能转发到真实模型。

不想从空控制台开始,可以照着仓库根的示例配置建库:`providers.example.json` 与
`routes.example.json`(全是占位值,不要直接当真实配置用)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [快速开始](docs/quick-start.md) | 在哪里改什么:起服务、加渠道、配路由、接客户端、跑测试 |
| [路由与会话](docs/routing-and-sessions.md) | 匹配顺序、会话身份、槽位、池策略、会话级覆盖、协议互转 |
| [故障排查](docs/troubleshooting.md) | 按症状查:503 分型、冷却熔断、Key 失效、粘性异常、日志位置 |
| [参考手册](docs/reference.md) | 完整机制与字段、全部环境变量、诊断参数上限 |
| [升级与回退](docs/upgrade-and-rollback.md) | 源码升级/回退、数据目录、客户端配置恢复、安装脚本的边界 |
| [离线运行与验收](docs/offline-run-and-acceptance.md) | 无 Key、不出网的验收流程与已验证范围 |
| [贡献指南](CONTRIBUTING.md) | 开发、测试与提交流程 |
| [变更记录](CHANGELOG.md) | 版本差异 |
| [安全政策](SECURITY.md) | 私密报告漏洞的方式与威胁模型 |

## 运行

```text
./mixctl start | stop | restart | status | ls | open | help
./mixctl explain <claude|codex> <model> [--kind <kind>] [--session <cc:…|cx:…|fp:…|cxf:…>] [--ua <s>] [--body <文本>] [--json]
./mixctl explain <model> [codex]                                            (app 缺省 claude)
./mixctl explain --input <file|-> [--json]
./mixctl split <主渠道ID> <主模型> <子代理渠道ID> <子代理模型> [--apply]
./mixctl split subagent <渠道ID> <模型> [--apply]
./mixctl route <claude|codex|zcode> [anthropic|responses|chat] [--slots]
./mixctl backups [--json] [<文件名前缀>]
./mixctl backups --diff <备份名> [--file <现役路径>] [--json]
./mixctl restore <备份名或路径> [--file <受管现役路径>] [--dry-run | --yes] [--json]
./mixctl logs [n] [--history] [--since <时间>] [--until <时间>] [--cursor <游标>] [--limit <条数>] [--json]
./mixctl logs [n] [--app <claude|codex>] [--provider <渠道>] [--model <模型>] [--session <会话>] [--status <ok|err|状态码>] [--slot <槽名>] [--err_class <错误分类>]
./mixctl sessions
./mixctl sessions config <完整会话键> [--json]
./mixctl sessions set-key <完整会话键> <渠道ID> <KeyID|--inherit> [--json]
./mixctl sessions set-slot <完整会话键> <槽名> <渠道ID> [--model <模型>] [--key-id <KeyID>] [--json]
./mixctl sessions clear-slot <完整会话键> <槽名> [--json]
./mixctl sessions reset <完整会话键> --yes [--json]
./mixctl gc [<天数>] [--apply]
```

`start` / `stop` / `restart` 管后台进程(pid 在 `.run/mixrouter.pid`);`status` 同时核对
运行进程加载的源码指纹。`--slots` 只对 `route claude` 有效;Codex 槽位不是客户端 env,
`mixctl route codex --slots` 会被直接拒绝,应用方式见下方「槽位」。`route` 会写客户端配置,
查询状态请用 `status` 或 `slots`。备份与还原是本地命令,不需要服务运行;日志查询需要服务运行。

- **代理端口 8787**,按端点自动分派到对应渠道组:

  | 端点 | 协议 | 渠道组 |
  | --- | --- | --- |
  | `POST /v1/messages`、`/v1/messages/count_tokens` | Anthropic | Claude Code |
  | `POST /v1/responses` | OpenAI responses(Codex 母语) | Codex |
  | `POST /v1/responses/compact` | OpenAI responses | Codex(`responses` 渠道原样透传) |
  | `POST /v1/chat/completions` | OpenAI chat | Codex(`wire_api=chat` 的渠道) |
  | `GET /v1/models` | 只读模型清单 | Codex 组 + 路由目标 |
  | `HEAD <上面任意端点>` | 探活 | — |

  请求必须是 `Content-Type: application/json` 的 POST(可带 charset),非 POST 的协议路径
  直接 404、不会转发;响应头带
  `x-mixrouter-app` / `x-mixrouter-provider` / `x-mixrouter-model` / `x-mixrouter-session`
  便于排查。
- **控制台 8788**:概览、渠道与 Key、路由、会话、诊断、设置与备份。渠道支持搜索、筛选、
  测试、编辑、删除与客户端接入;路由编辑器支持渠道池、策略、优先级和匹配条件;
  会话页可手动改绑;请求日志支持多条件筛选。控制台与代理都只接受**字面量回环 Host**:
  `127.0.0.1:端口` 或 `[::1]:端口`(当前服务只绑 IPv4)。用 `localhost` 或自定义域名访问
  会得到 403——这不是故障,是 DNS rebinding 防护。写请求拒绝跨站/异源来源。
- **数据目录**:默认是仓库根。`providers.json`(含明文 Key,`0600`)、`routes.json`、
  `slots.json`、`sessions.json`、`logs/` 都在这里,均已加入 `.gitignore`。
  把 `MIXR_DATA_DIR` 指到一个固定目录,升级换代码时数据才不跟着代码走;
  更换代码目录而不设它,服务会按空库启动。
- **兼容监听**:`MIXROUTER_ALT_PORTS=15721`(逗号分隔)时,本进程在别的端口上也服务同一个
  代理,用于接管旧客户端里写死的端口;端口被占用只告警,不影响主端口。

## 客户端接入

真实 Key 全部留在 `providers.json`,代理转发时才注入;客户端配置里只放占位值。

### Claude Code

```bash
./mixctl route claude               # 改 ~/.claude/settings.json 的 env,写前自动备份
./mixctl route claude --slots       # 同时把槽位表写成客户端别名
```

等价手改:`ANTHROPIC_BASE_URL=http://127.0.0.1:8787`(不带 `/v1`)、
`ANTHROPIC_AUTH_TOKEN` 填任意非空占位值,模型名保持不动——路由规则就是按它匹配的。
标了 `wire_api: responses` 的渠道**不能直连切换**(它只挂 Codex 型通道),
控制台里那颗按钮是禁用的,请走路由模式。

### Codex

```bash
./mixctl route codex                # config.toml 顶层 model_provider 换成 mixr-router
```

对 `~/.codex/config.toml` 做原位改写:顶层 `model` / `model_provider` 替换,追加
`[model_providers.mixr-*]` section,用户自己的 section 不动;二次切换会清掉旧的 mixr section。
等价手改的 `base_url` 是 `http://127.0.0.1:8787/v1`(带 `/v1`),
`wire_api = "responses"`,`experimental_bearer_token` 填占位值。Codex 需重启生效。

### ZCode

```bash
./mixctl route zcode                # 默认 Anthropic
./mixctl route zcode responses      # OpenAI Responses
./mixctl route zcode chat           # OpenAI Chat
```

只写桌面端 `~/.zcode/v2/config.json` 的自有 provider 条目,不改默认模型、已有会话、
其它服务商或 CLI 扩展配置。配完在 ZCode 模型选择器里选 **Mixrouter · …**;
新条目没出现就重启客户端并新建会话。

## 槽位与会话

**Claude Code 五个固定槽**:`main` / `opus` / `sonnet` / `haiku` / `subagent`,
别名 `mixr-<槽名>`,分别写 `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL` /
`CLAUDE_CODE_SUBAGENT_MODEL`。在控制台「渠道」页的槽位表里绑定「渠道 @ 模型」,
再点「应用槽位到客户端」。旧版本遗留的 `fable` 槽不再使用,加载时会从内存槽表清理。

**Codex 自拟槽名**(如 `worker` / `reviewer`):在控制台「渠道」页 Codex 标签下添加,
然后用 `codex exec -m mixr-worker`。`main` / `reviewer` 两个槽通过
「应用槽位到客户端」写入 `model` / `review_model`;命令行没有 `route codex --slots`
这个入口,接口是 `POST /api/router/codex {"slots":true}`。

槽位可以配备池(`pool`)和 `strategy`:槽位请求按槽位自己的池策略选择,**不复用**对话的
粘性或手动钉定,也不改写对话绑定。控制台槽位面板会显示已有备池,但只能编辑渠道与落点模型;
备池通过 `PUT /api/slots` 或 `slots.json` 维护,面板保存时不会抹掉它。

**会话级 Key 与槽位覆盖**:`sessions.json` 的会话记录里可存 `routing: {keys, slots}`,
只引用渠道内已有的 **Key ID**,**不重复存 Key 明文**。命令行同样**不接受 Key 明文**
(接 Key ID)。每次写入都是读-改-写并带 `expected_revision`,版本冲突直接拒绝。
**显式配置过的会话不被空闲 TTL 剪掉**;继承靠删除条目(`--inherit` / `clear-slot` / `reset`)。
`同身份子请求的边界`:只有传来同一会话身份的请求才继承覆盖,换了 `session_id` 的子代理按
自己的身份解析。Key 不可用时返回 `provider_key_unavailable_error`,不会悄悄换账号。

- **解除钉定**只清掉手动绑定的渠道,保留该会话的 Key / 槽位覆盖;
  **删除会话**(`DELETE /api/sessions/:key`,控制台「解绑」按钮)会连同覆盖一起删除。
  控制台在删除前会确认。
- 会话标签(工作目录 / 首条用户消息片段)存在 `sessions.json` 的会话记录里,
  **不写进请求日志或 `/api/metrics`**,但 `sessions.json` 本身是敏感文件,
  不要提交或外发。`MIXR_SESSION_LABEL=0` 可关闭标签采集。

## 压缩、日志与归档

- **压缩模型**:控制台「路由 → 压缩模型」或 `GET/POST /api/compact`。它只改两条压缩内容
  规则,不动主模型与普通路由。Key 默认跟随渠道当前账号;固定 `key_id` 只影响压缩,
  且只支持单渠道。失效时返回 `provider_key_unavailable_error`。压缩识别只读最后一条 user
  消息的直接文本,命中判据见[参考手册](docs/reference.md#6-压缩分流与压缩窗口)。
- **压缩窗口**:控制台「路由 → 压缩上下文窗口」或 `GET/POST /api/compact/window`,
  改磁盘配置里的 `autoCompactWindow`,接受 `100k`–`1M` 或 `auto`。
  环境变量 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 优先于磁盘设置,保存不会热改运行中的会话。
- **请求日志**:`mixctl logs` 走运行中服务的 `GET /api/logs`,**服务必须运行**
  (控制台不可达时退回本机 `requests.jsonl` 的有界尾读,只支持位置式条数)。
  默认查当前进程内存环,重启后归零;要查旧记录用 `--history`。
  游标是短期快照,`CURSOR_EXPIRED` 时重新发起查询,不能当永久书签。
  `GET /api/stats` 聚合当前内存窗口,`history=1` 查磁盘;`by_slot` 只按日志里明确记录的
  槽位统计,空槽记 `none`,旧日志缺字段记 `unknown`,不拿模型名猜。
- **返回归档默认关闭**:只有以 `MIXR_RESPONSE_ARCHIVE=on` 启动才开启。
  它保存上游响应正文,每次尝试一个私有目录(`0700`/`0600`),raw 与 derived **分别最多 16MiB**,最多 100 份归档,**不自动删除旧档**。已知渠道 Key 与本次客户端凭据会被替换,
  但**响应正文仍可能含其他敏感数据**,分享前逐份检查。
- **运行期清理**:`responses` 归档目录与 `logs/launchd.log` 由 `MIXR_LOG_RETAIN_DAYS`
  (默认 2 天,`0` 关闭)清理;`mixctl gc` 可预览或执行。`requests.jsonl` 另有一套
  UTC 日界 + 5MiB 轮转,默认保留 30 天。

## 备份与还原

每次改写客户端配置或渠道库前,都会在同目录留一份 `.bak-mixui-<时间戳>-<随机>` 备份,
每个池默认保留 5 份。轮换会在删除前给出预警。

```bash
./mixctl backups                     # 清点 providers.json / settings.json / config.toml 三处
./mixctl backups --diff <备份名>      # 与现役文件比较(值已脱敏)
./mixctl restore <备份名>             # **默认只预览**,不写文件
./mixctl restore <备份名> --yes       # 确认后原子替换,写入前另存安全备份
```

`restore` 只接受受管文件原目录里的 `.bak-mixui-*`,拒绝链接、目录与超过 512KiB 的文件;
TOML 只接受普通表、单行字符串、布尔与十进制数,其他合法语法报 `unsupported_toml`
—这是拒绝自动恢复,不是判定配置损坏。恢复前请停止对应客户端与路由器。

## 只读诊断

```bash
./mixctl explain claude claude-opus-5
./mixctl explain codex gpt-5 --kind chat/completions
./mixctl explain --input body.json
```

`explain` 与 `POST /api/routing/preview` 复用真实 resolver,零副作用、不回显凭据,
且只解释当前快照,不承诺上游成功。离线故障注入脚本**默认离线**:

```bash
node scripts/diagnose-upstream.js --help
node scripts/diagnose-upstream.js --scenario mixed --concurrency 2 --requests 8
```

它起临时实例、上游只连本地故障桩,不读真实配置或 Key。会花钱的渠道模式必须显式确认:

```text
MIXR_DATA_DIR=/absolute/path node scripts/diagnose-upstream.js --mode provider --provider ID --requests N --confirm-run [--model NAME]
```

`--confirm-run` 只是执行确认,不等于取得账号使用授权。该模式**未实际测试真实上游**,
低输出上限也不承诺零费用。

## 常驻(可选,launchd,macOS)

想要开机自启与崩溃拉起,可以放一个 LaunchAgent 指向仓库里的 `scripts/launchd-run.sh`:

```xml
<key>ProgramArguments</key><array>
  <string>/bin/sh</string><string>/绝对路径/mixrouter/scripts/launchd-run.sh</string>
</array>
<key>WorkingDirectory</key><string>/绝对路径/mixrouter</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
```

脚本先写 `.run/mixrouter.pid` 再 `exec`(exec 不换 PID),所以 `mixctl status|stop` 认的是
同一个进程;正常退出不会被拉起,非正常退出由 launchd 自愈。装了 `*.mixrouter.plist` 的机器上,
`mixctl start` 会走 `launchctl kickstart`,不再另派生进程。

`scripts/install-macos.sh` 与 `app/MixrouterApp.swift` 桌面外壳是**可选、实验性**的:
安装脚本只把源码复制到一个不可变发布目录并生成建议 plist,不装载服务、不写
`~/Library/LaunchAgents`、不改客户端配置;桌面外壳需要 macOS + CommandLineTools。
当前**没有**可用的「切 `current` 符号链接即完成升级」流程,详见
[升级与回退](docs/upgrade-and-rollback.md)。

## 开发与测试

```bash
npm test                 # = node scripts/run-tests.js,隔离环境跑整套 test/*.test.js
npm test -- test/codex.test.js   # 单文件,同样经过隔离入口
npm run smoke            # 离线端到端验收;退出码 0 = 全绿
```

`npm test` 会在临时 `HOME`、临时数据目录与内核分配的端口下运行,过滤调用方环境里的
`MIXR_` / `MIXROUTER_` / `MIXUI_` 变量,不碰真实配置。直接 `node --test` 会跳过这层隔离。
源码修改不热加载:改完先跑测试,再 `./mixctl restart`,最后 `./mixctl status` 必须显示
「已加载当前源码」;`/healthz` 回 200 只说明进程活着。

验证记录(2026-10-18,v3.6.1 本地工作树,Node v24.18.0):
`npm test` 94 个文件、**1512/1512 通过**(0 fail / cancelled / skipped,约 26.8s);
`npm run smoke` 18/18 通过(本地 mock,不出网)。Node 18/22 本轮未重跑,
不构成当前兼容性保证;历史真实客户端端到端记录来自旧版本,也不代表当前版本的兼容性。
详见[离线运行与验收](docs/offline-run-and-acceptance.md)。

**两个入口的测试范围不同**:GitHub 源码 clone 里有完整 `test/`,可以 `npm test`;
Release 运行包**不含** `test/`、`.github/` 等开发材料,保留用户文档;`npm test` 会明确提示缺开发套件,
验收请用 `npm run smoke`。

## 安全

- 只绑回环;控制台与代理校验**字面量**回环 `Host`(`127.0.0.1` / `[::1]`,`localhost`
  也会被拒),写操作拒绝跨站/异源来源,代理只收 `application/json`(可带 charset)的 POST。
  这些防的是浏览器页面借你的本机服务消耗 Key 或改配置,不防本机上的其他程序。
- `providers.json` 与备份目录里是**明文 Key**;`sessions.json` 含对话标签。
  不要把数据目录同步到公开位置或提交进 git。
- 漏洞请走私密通道,不要开公开 issue,见 [SECURITY.md](SECURITY.md)。

## License

[MIT](LICENSE)
