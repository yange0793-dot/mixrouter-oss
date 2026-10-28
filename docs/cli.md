# 命令行与运行边界

这份文档是 `mixctl` 与运行期边界的完整参考:全部子命令、端口与数据目录、客户端接入命令、
槽位与会话覆盖、日志与归档、备份与还原、只读诊断、可选常驻。

要"在哪里改什么"看[快速开始](quick-start.md);机制细节看[参考手册](reference.md);
按症状排查看[故障排查](troubleshooting.md)。README 只保留最常用的几条命令。

## 1. 命令总览

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
./mixctl probe <渠道ID或渠道名> [模型...] [--key-id <KeyID>] [--wire <anthropic|responses|chat>] [--json]
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
`mixctl route codex --slots` 会被直接拒绝;普通 `route codex` 已自动使用可用主槽与审查槽别名。
`route` 会写客户端配置,
查询状态请用 `status` 或 `slots`。备份与还原是本地命令,不需要服务运行;
**日志查询需要服务运行**。`probe` 需要服务运行:它会**真的向上游发一次生成请求、消耗额度**
(每个模型一次),只读不落盘。

## 2. 端口、端点与数据目录

代理端口 **8787**,按端点自动分派到对应渠道组:

| 端点 | 协议 | 渠道组 |
| --- | --- | --- |
| `POST /v1/messages`、`/v1/messages/count_tokens` | Anthropic | Claude Code |
| `POST /v1/responses` | OpenAI responses(Codex 母语) | Codex |
| `POST /v1/responses/compact` | OpenAI responses | Codex(`responses` 渠道原样透传) |
| `POST /v1/chat/completions` | OpenAI chat | Codex(`wire_api=chat` 的渠道) |
| `GET /v1/models` | 只读模型清单 | Codex 组 + 路由目标 |
| `HEAD <上面的生成端点>` | 探活 | — |

生成请求必须是 `Content-Type: application/json` 的 POST(可带 charset),非 POST 的生成路径
直接 404、不会转发;模型清单使用 GET。响应头带
`x-mixrouter-app` / `x-mixrouter-provider` / `x-mixrouter-model` / `x-mixrouter-session`
便于排查。

控制台在 **8788**:概览、用量统计、渠道与 Key、路由、会话、诊断、设置与备份。渠道支持搜索、筛选、
测试、编辑、删除与客户端接入;路由编辑器支持渠道池、策略、优先级和匹配条件;
会话页可手动改绑;请求日志支持多条件筛选。「用量统计」按区间汇总请求数、tokens、缓存命中率、
速度与首字延迟,只报真实消耗,不折算金额。控制台与代理都只接受**字面量回环 Host**:
`127.0.0.1:端口` 或 `[::1]:端口`(当前服务只绑 IPv4)。用 `localhost` 或自定义域名访问
会得到 403——这不是故障,是 DNS rebinding 防护。写请求拒绝跨站/异源来源。

**启动入口与数据目录**:

- `npm run local` 是面向新安装的前台入口。它默认把数据放在用户主目录下的
  `.local/share/mixrouter/data`,支持 `--data-dir <绝对路径>`、`--port`、`--ui-port`,
  不写源码目录、不改客户端配置、不安装后台服务。若源码目录里已有存量数据
  (`providers.json` 等)而调用时没有显式给 `--data-dir`,它会**拒绝静默开空库**,
  要求用 `--data-dir` 指向已有数据目录。
- `npm start` 与 `node mixrouter.js` 保持原行为:数据目录默认是仓库根。已经在这样用的
  部署不需要迁移;运行 `npm run doctor` 时用 `--data-dir <原数据目录>` 检查那一份。
- `mixctl start` 是后台常驻入口,继续按 `MIXR_DATA_DIR` / 代码目录定位数据。
  `npm run local` 是前台进程、没有 pid 文件,不由 `mixctl` 管理:停止用 Ctrl+C,
  重启就是再跑一次同一命令;只有 `mixctl start` 起的实例才用 `mixctl restart`。

数据文件是 `providers.json`(含明文 Key,`0600`)、`routes.json`、
`slots.json`、`sessions.json` 与 `logs/`。
这些都是本机状态,不要提交到 git 或随发布包分发。
把 `MIXR_DATA_DIR` 指到一个固定目录,升级换代码时数据才不跟着代码走;
更换代码目录而不设它,服务会按空库启动。

**兼容监听**:`MIXROUTER_ALT_PORTS=15721`(逗号分隔)时,本进程在别的端口上也服务同一个
代理,用于接管旧客户端里写死的端口;端口被占用只告警,不影响主端口。

## 3. 客户端接入

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

对 `~/.codex/config.toml` 做原位改写:顶层 `model_provider` 换成本机 provider,
可用的 `main` / `reviewer` 自动写为 `model` / `review_model` 的槽位别名,
`model_catalog_json` 指向托管目录。缺少两个默认槽时,普通接入用首个启用且有默认模型与 Key 的
Codex 渠道补齐;已有无效槽不覆盖,需先修复。用户自己的 section 不动;
二次切换会清掉未被 profile 引用的旧 mixr section。
等价手改的 `base_url` 是 `http://127.0.0.1:8787/v1`(带 `/v1`),
`wire_api = "responses"`,`experimental_bearer_token` 填占位值。
首次切换接入后让客户端重新读取连接配置;已接入后的槽位落点变更不需要再重启,见下节。

### ZCode

```bash
./mixctl route zcode                # 默认 Anthropic
./mixctl route zcode responses      # OpenAI Responses
./mixctl route zcode chat           # OpenAI Chat
```

只写桌面端 `~/.zcode/v2/config.json` 的自有 provider 条目,不改默认模型、已有会话、
其它服务商或 CLI 扩展配置。配完在 ZCode 模型选择器里选 **Mixrouter · …**;
新条目没出现就重启客户端并新建会话。

## 4. 槽位与会话

**Claude Code 五个固定槽**:`main` / `opus` / `sonnet` / `haiku` / `subagent`,
别名 `mixr-<槽名>`,分别写 `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL` /
`CLAUDE_CODE_SUBAGENT_MODEL`。在控制台「渠道」页的槽位表里绑定「渠道 @ 模型」,
再点「应用槽位到客户端」。旧版本遗留的 `fable` 槽不再使用,加载时会从内存槽表清理。

**Codex 自拟槽名**(如 `worker` / `reviewer`):在控制台「渠道」页 Codex 标签下添加,
然后用 `codex exec -m mixr-worker`。每个槽分别选择渠道与落点模型,可选渠道登记项或自定义模型;
模型留空继承渠道默认 `model`,不修改渠道库默认值。已接入路由后,保存槽位即同步托管模型目录,
后续 `mixr-main` / `mixr-reviewer` 等别名请求按新落点转发,无需另点应用。
首次接入用 `./mixctl route codex`,命令行仍没有 `route codex --slots` 参数;
`POST /api/router/codex {"slots":true}` 保留为严格要求两个槽都可用的接入接口。
槽位保存不改 Codex 推理强度;原生选择器缓存显示名,重新打开客户端才读取新目录。
profile、项目覆盖和未登记的真实模型名不自动跟随主槽。
仅与登记项精确匹配的旧默认 ID 同时满足原生 Codex 标识、本地路由凭据、可靠 `cx:` 会话与
本机受管接入配置时按兼容映射跟随;标识支持现有 CLI 形式及 `codex_desktop/`,不放宽其它未知
`codex_*` 前缀。显式 `-m` 选择同一旧默认 ID 也会命中,因为请求上无法区别它与仍持有旧默认
的会话。无关原生模型 ID 与其它 OpenAI 客户端不受影响。

Claude 槽位可在控制台「后备渠道」编辑备池(`pool`)的顺序与成员模型，也可通过
`PUT /api/slots` 维护。槽位请求按槽位自己的策略选择，**不复用**对话的粘性或手动钉定，
不改写对话绑定。保存主渠道或模型仍保留未带出的 `pool` / `strategy` / `dropTools`；
清空备池必须明确传 `pool: []`。Codex 槽位界面暂不提供后备池。

**会话级 Key 与槽位覆盖**:控制台「会话 → 当前绑定 → 配置 Key / 槽位」逐槽编辑渠道、模型与 Key,
也可复制未覆盖的全局渠道/模型到草稿(不含备池),保存只影响该会话。普通请求的渠道钉定
在同列「普通请求渠道」展开设置。`sessions.json` 的会话记录里可存 `routing: {keys, slots}`,
只引用渠道内已有的 **Key ID**,**不重复存 Key 明文**。命令行同样**不接受 Key 明文**
(接 Key ID)。每次写入都是读-改-写并带 `expected_revision`,版本冲突直接拒绝。
**显式配置过的会话不被空闲 TTL 剪掉**;继承靠删除条目(`--inherit` / `clear-slot` / `reset`)。
**同身份子请求的边界**:只有传来同一会话身份的请求才继承覆盖,换了 `session_id` 的子代理
按自己的身份解析。Key 不可用时返回 `provider_key_unavailable_error`,不会悄悄换账号。

- **解除钉定**只清掉手动绑定的渠道,保留该会话的 Key / 槽位覆盖;
  **删除会话**(`DELETE /api/sessions/:key`,控制台「解绑」按钮)会连同覆盖一起删除。
  控制台在删除前会确认。
- 会话标签(工作目录 / 首条用户消息片段)存在 `sessions.json` 的会话记录里,
  **不写进请求日志或 `/api/metrics`**,但 `sessions.json` 本身是敏感文件,
  不要提交或外发。`MIXR_SESSION_LABEL=0` 可关闭标签采集。

## 5. 压缩、日志与归档

- **压缩模型**:控制台「路由 → 压缩模型」或 `GET/POST /api/compact`。它只改两条压缩内容
  规则,不动主模型与普通路由。Key 默认跟随渠道当前账号;固定 `key_id` 只影响压缩,
  且只支持单渠道。失效时返回 `provider_key_unavailable_error`。压缩识别只读最后一条 user
  消息的直接文本,命中判据见[参考手册](reference.md#6-压缩分流与压缩窗口)。
- **压缩窗口**:控制台「路由 → 压缩上下文窗口」或 `GET/POST /api/compact/window`,
  改磁盘配置里的 `autoCompactWindow`,接受 `100k`–`1M` 或 `auto`。
  环境变量 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 优先于磁盘设置,保存不会热改运行中的会话。
- **请求日志**:`mixctl logs` 走运行中服务的 `GET /api/logs`,**服务必须运行**
  (控制台不可达时退回本机 `requests.jsonl` 的有界尾读,只支持位置式条数)。
  默认查当前进程内存环,重启后归零;要查旧记录用 `--history`。
  游标是短期快照,`CURSOR_EXPIRED` 时重新发起查询,不能当永久书签。
  路由准备阶段的本机拒绝在返回错误前同步入日志,`attempts` 与 tokens 为 0、渠道与出站模型
  及 `rule` / `slot` 为空,不发上游。记录日志不额外创建/结算会话或尝试过程、不计为 active;
  无路由失败不新建会话,固定 Key 等准备路径此前可能已有记录。不回填历史,
  入口安全/格式校验错误不记入这类日志。
  统计包含这些新拒绝;0 tokens 本身不代表有没有调用上游,需结合 `attempts` 与错误码。
  `GET /api/stats` 聚合当前内存窗口,`history=1` 查磁盘;`by_slot` 只按日志里明确记录的
  槽位统计,空槽记 `none`,旧日志缺字段记 `unknown`,不拿模型名猜。
- **返回归档默认关闭**:只有以 `MIXR_RESPONSE_ARCHIVE=on` 启动才开启。
  它保存上游响应正文,每次尝试一个私有目录(`0700`/`0600`),raw 与 derived **分别最多 16MiB**,
  最多 100 份归档,**不自动删除旧档**。已知渠道 Key 与本次客户端凭据
  会被替换,但**响应正文仍可能含其他敏感数据**,分享前逐份检查。
- **运行期清理**:`responses` 归档目录与 `logs/launchd.log` 由 `MIXR_LOG_RETAIN_DAYS`
  (默认 2 天,`0` 关闭)清理;`mixctl gc` 可预览或执行。`requests.jsonl` 另有一套
  UTC 日界 + 5MiB 轮转,默认保留 30 天。

## 6. 备份与还原

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

## 7. 只读诊断

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

## 8. 常驻(可选,launchd,macOS)

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
新入口 `npm run service` 管理可选 macOS 登录服务，`npm run update` 明确检查官方更新，
`npm run upgrade` 校验运行包并执行受控切换与失败回退。服务安装、升级默认预览，
只有明确 `--apply` 才写入；不接管其它部署。仅切 `current` 不能代表进程已加载新代码，
完整参数与边界见[安装说明](installation.md)和[升级与回退](upgrade-and-rollback.md)。

## 9. 本机自检

```bash
npm run doctor
npm run --silent doctor -- --json      # 纯 JSON;普通 npm run 会先印命令横幅
npm run doctor -- --offline            # 完全不连接本机端口
npm run doctor -- --data-dir /absolute/path --port 8787 --ui-port 8788
```

`npm run doctor` 是本机只读检查:Node 版本、运行入口文件、数据目录可写与权限、
四个配置文件的 JSON 与顶层结构,以及回环地址上的代理/控制台是否可达。默认数据目录与
`npm run local` 相同;检查旧 `npm start` 的数据时用 `--data-dir` 明确指定。
`--offline` 不连接端口,也不建目录或改配置。

它**不发上游请求、不修改配置、不打印 Key、渠道 URL 或会话内容**,也不证明 Key 或模型可用;
配置只校验顶层结构。服务未启动属于 **WARN**,不是失败。退出码:`0` 无阻断问题(可以有警告),
`1` 发现阻断问题,`2` 参数写错。JSON 输出包含数据目录路径,分享前检查其中的用户名与本机路径。
