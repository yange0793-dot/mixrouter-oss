# 快速开始

这份文档回答一件事:**要在哪里改什么,才能让 mixrouter 真的开始转发请求。**

原则是给路径、给字段名、给能直接敲的命令。命令里的 `./mixctl` 都指仓库根的
`mixctl`(可执行);Node 推荐 22 / 24,最低 `>= 18`(见 `package.json` 的 `engines.node`)。

本页只讲"在哪里改什么";机制说明在[参考手册](reference.md),按症状排查在[故障排查](troubleshooting.md)。

---

## 0. 起服务

以下新入口从 **v3.7.0** 起提供,用于包含这些脚本的源码或 v3.7.0 及之后的 Release 解压目录。已发布的 **v3.6.1** 运行包
不含 `local` / `doctor`,请按包内 README 使用 `npm start`,数据目录设置见[安装说明](installation.md)。

新安装在相应目录里运行:

```bash
node --version          # 推荐 v22 / v24;最低 v18
npm run doctor          # 本机只读自检;尚未启动、尚无渠道属于警告
npm run local           # 前台运行,Ctrl+C 停止;不需要 npm install
```

`local` 默认把数据放在 `~/.local/share/mixrouter/data`,不写进源码目录。
不自动添加渠道、改客户端配置或安装后台服务。端口被占时可以显式改端口:

```bash
npm run local -- --port 18787 --ui-port 18788
npm run doctor -- --port 18787 --ui-port 18788
```

自定义数据目录用 `--data-dir <绝对路径>`;命令行参数优先于对应环境变量。
`npm start` / `node mixrouter.js` 保留旧行为:不设 `MIXR_DATA_DIR` 时仍在代码目录存数据。
新入口发现源码目录已有运行数据时会要求明确指定,不自动迁移,也不静默开空库:

```bash
npm run local -- --data-dir "/原来保存 providers.json 的目录"
```

若接着用 `mixctl backups` / `restore` / 离线 `logs` 等读文件命令,须给它同一份
`MIXR_DATA_DIR`;`npm run local` 的环境不会反向写进另一个终端。

服务只绑回环,两个口:代理 `127.0.0.1:8787`、控制台 `127.0.0.1:8788`
(`mixrouter.js` 的 `HOST = '127.0.0.1'`,没有 `0.0.0.0` 分支)。前台跑起来后:

```bash
curl --fail http://127.0.0.1:8787/healthz     # 回 {"ok":true,"service":"mixrouter","version":"…"}
open http://127.0.0.1:8788/                   # macOS;其他系统浏览器打开同一地址
```

需要后台运行时使用旧版 `mixctl` 入口(它与前台 `npm run local` 二选一,不要同时启动)。
`mixctl` 默认仍读代码目录的数据,若沿用新入口数据,先设置 `MIXR_DATA_DIR`。
后台派生本身不保证崩溃自愈;只有另行配置了 launchd 托管才有该能力:

```bash
./mixctl start          # 后台常驻,pid 写进 .run/mixrouter.pid
./mixctl status
./mixctl stop
./mixctl restart
./mixctl open           # 打开控制台
./mixctl help           # 全部子命令的用法串
```

`./mixctl start` 如果检测到本机装的是 `*.mixrouter.plist`(launchd 常驻),会走
`launchctl kickstart`,不再另派生一个野进程。常驻 plist 的模板见[命令行与运行边界](cli.md)的常驻一节。

端口、数据目录都可用环境变量改,但**路径类与端口类必须在进程启动前设好**
(`mixrouter.js` 在模块顶层就读它们,require 之后再改不生效):

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `MIXROUTER_PORT` / `MIXUI_PORT` | 8787 / 8788 | 代理口 / 控制台口 |
| `MIXROUTER_ALT_PORTS` | 空 | 逗号分隔,在这些端口上也服务同一个代理(`mixrouter.js` 的 `altPorts()`) |
| `MIXR_DATA_DIR` | 仓库根 | `providers.json` / `routes.json` / `slots.json` / `sessions.json` / `logs/` 的总目录 |

> 端口设成 `0` 时**不要拿 `/api/state` 的 `proxy_port` / `ui_port` 当真实端口**:
> 那两个字段回的是配置常量,真实绑定端口只在启动横幅里。这条细节与全部路径类变量的
> 完整清单见 [`offline-run-and-acceptance.md`](offline-run-and-acceptance.md) §2,
> 以及 [`reference.md`](reference.md#10-环境变量) 的完整变量表。

---

## 1. 加一个渠道(在哪改)

**首选在控制台改**:`http://127.0.0.1:8788/` → 左侧选择 Claude Code / Codex / ZCode → 「新建渠道」。
字段落进 `<MIXR_DATA_DIR>/providers.json`,接口是 `POST /api/providers`。

三个客户端共用渠道管理页,左侧入口直接切到对应客户端;页内标签也可切换。
渠道库默认列表显示,右上可切成卡片;搜索与启用状态筛选对两种视图都生效。
主模型和子代理的编辑入口在渠道库下方「模型槽位配置」,展开后配置与应用。
上方「连接配置」可查看接入地址、协议和写入边界;「已写入配置」不代表真实上游连通。

界面支持系统/浅色/深色主题,`⌘K`(Windows/Linux 为 `Ctrl+K`)打开快速跳转。
页面链接可收藏,浏览器前进/后退可切回访问过的页面。主题、视图等偏好只保存在当前浏览器,
不会改动路由或客户端配置;浏览器不允许存储时仍可正常使用。

必填与关键字段(`lib/http/console.js` 的 POST 分支逐条校验):

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `app` | 否 | `claude`(默认)/ `codex`。决定进哪一组;建完之后**不能改组** |
| `name` | 是 | 渠道名,须非空 |
| `base_url` | 是 | 合法 `http(s)` URL,尾部 `/` 会被去掉 |
| `api_key` | Claude 组可后补 | 含换行或控制字符会被拒(400) |
| `models` | Claude 组 | 模型名数组;第一项是主模型,支持 `[1M]` 后缀 |
| `model` | **Codex 组必填** | Codex 渠道自带模型名,不填直接 400 |
| `wire_api` | 否 | Claude 组:`anthropic` / `responses` / `chat`;Codex 组:`responses` / `chat` |
| `ua` | 否 | 渠道级 User-Agent,压过客户端自己的 UA |
| `direct` | 否 | `true` = 这个渠道跳过 `MIXR_UPSTREAM_PROXY` 隧道(国内站点用) |
| `enabled` | 否 | 默认启用 |
| `keys` | 否 | 多 Key 清单 `[{id,label,key}]`;建渠道时给了就取第一项当生效 Key |

各字段的完整形状与模板可以直接照抄 `providers.example.json`(仓库根有配套的 `routes.example.json`)。

**不用手抄模型名**:在「新建渠道」或「编辑」弹窗填入 Base URL 与 API Key,选好上游协议,
点击「获取模型列表」。不用先填名称或保存渠道。已有渠道可使用保存的 Key,多账号可选择
本次获取所用的账号;如果在该账号行填了新 Key,本次会使用尚未保存的新值。

- 获取后可搜索并选择模型。Claude 组追加到模型草稿、去重且不改变原主模型;Codex 组选择一个
  填入模型字段。原有手填入口保留。
- 获取与选择只改弹窗草稿,最后点「保存渠道」才会落盘;不会切换生效账号或修改客户端配置。
- 获取会向该 URL 发送 Key,只请求模型清单,不调用聊天接口。列表来自渠道自身,不代表列出的每个
  模型都能成功调用。401/403 请检查 Key 和权限;404 或格式不支持时可继续手填模型。
- 支持裸域名、末尾 `/v1` 与自定义路径前缀。获取接口也接受完整 `/v1/models` 地址,
  但**保存渠道时仍应填 Base URL**,不要保存模型清单端点。不要在 URL 中携带账号、查询参数或片段。

接口参数与获取限额见[参考手册的模型列表获取](reference.md#模型列表获取)。

**`wire_api` 怎么选**(这是最容易配错的一项):

- 渠道直接吃 Anthropic `/v1/messages` → 留空(即 `anthropic`,Claude 组默认)。
- 模型只挂在 Codex/Responses 型通道上(网关不提供 `/v1/messages`)→ Claude 组渠道标
  `responses`,代理在自己进程内翻译 Anthropic ↔ Responses。
- 网关只开 `/v1/chat/completions`(GLM 一类)→ 标 `chat`。
- Codex 组:绝大多数网关是 `responses`(原样转发);只有 `/v1/chat/completions` 的网关才标 `chat`。

配错的表现是 `wire_api_mismatch_error`,不会静默降级。

> 转换线的形状与边界见 [`reference.md`](reference.md#4-协议互转)。

**多 Key(同一渠道多账号)**:渠道里的 `keys: [{id,label,key}]` + `active_key`。控制台渠道卡片的
「API key」是一颗下拉,点一下即切账号,不用重启。老式只有 `api_key` 的渠道会被显示成一条
「账号1」(固定 id `klegacy`);加第二把时它按原 Key 解析,不会丢。

---

## 2. 配路由规则与默认路由(在哪改)

**在控制台「路由」页改**,落进 `<MIXR_DATA_DIR>/routes.json`,接口是 `PUT /api/routes`
(带 `expected_revision`,版本对不上回 409)。命令行可以只看不写:`./mixctl ls`。

规则字段(`lib/routing/rules.js` 的 `normalizeRule`):

| 字段 | 说明 |
| --- | --- |
| `match` | 请求模型名的**子串**,逗号分隔多个,大小写不敏感 |
| `provider` | 单一目标渠道 id |
| `pool` | 渠道池。成员写成字符串即用规则的目标模型;写成对象可各自给 `{provider, model, weight}` |
| `strategy` | `round_robin`(默认)/ `weighted` / `least_used` / `random` / `priority` |
| `model` | 目标模型;留空 = 透传请求模型;带 `[1M]` = 剥后缀并加 `anthropic-beta` 头(仅 Claude 通路) |
| `priority` | 数值大的先匹配;同优先级按数组顺序 |
| `app` | 这条规则只对哪一组生效:`claude` / `codex` / 留空 = 两组通用 |
| `when` | 附加匹配条件,**全部**满足才命中;字段只有 `session` / `ua` / `token` / `body`,均为大小写不敏感子串 |
| `enabled` | `false` 即停用 |

`default`(默认路由)是同一个形状的对象,**它尊重自己配置的 `strategy`**,不是一律轮转。
都不命中时走它。模板见 `routes.example.json`。

两条保存时的硬约束(违反时 `PUT /api/routes` 返回 400;手改文件后的请求行为另见下文):

- 目标渠道必须真实存在。指向已删除渠道的规则会被 `PUT /api/routes` 拒绝;若 `routes.json`
  是手改或从旧备份恢复出来的,服务启动时会用 `reportGhostRoutes()` 把僵尸引用打到日志里
  ——**命中这类规则的请求会 503**。
- 规则自己声明了 `app`,却绑了另一组的渠道,会被拒;没声明 `app` 的规则允许只服务另一组
  (另一组会跳过它继续往下匹配)。

**压缩模型/Key 单独一块**:控制台「路由 → 压缩模型」,接口 `GET/POST /api/compact`。
它替换两条压缩规则的旧备池,不改主模型和普通路由。Key 默认跟随渠道当前账号;选了固定
`key_id` 就只用于压缩请求,不改渠道的 `active_key`;固定 Key 只支持单渠道,不能与 `pool` 并用。
**压缩上下文窗口**是另一块(`GET/POST /api/compact/window`),改的是 Claude Code 磁盘配置里的
`autoCompactWindow`,可选用户全局 / 项目 `.claude/settings.json` / 项目本地
`.claude/settings.local.json` 三层,项目层要填项目绝对路径。

> 会话级分发、槽位、池策略、压缩判据的细节见 [`routing-and-sessions.md`](routing-and-sessions.md)。

---

## 3. 接入客户端(客户端 base_url 填什么)

### Claude Code(Anthropic 协议)

一条命令搞定,它改的是 `~/.claude/settings.json` 的 env,其余键原样保留、写前自动备份:

```bash
./mixctl route claude               # 切到路由模式
./mixctl route claude --slots       # 顺带把槽位表写进客户端 env
```

等价手改是这三样:

```
ANTHROPIC_BASE_URL   = http://127.0.0.1:8787      # 不带 /v1
ANTHROPIC_AUTH_TOKEN = 任意占位值                  # 代理不校验
# 模型名与槽位保持不动 —— 路由规则就是按它匹配的
```

槽位别名由 `--slots` 写入,键名见 `lib/routing/slots.js` 的 `CLAUDE_SLOT_ENV`:
`ANTHROPIC_MODEL`(main)、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、
`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`。

> 标了 `wire_api: responses` 的渠道**不能**直接「切换」到直连模式(它只挂 Codex 型通道,
> 直连 `/v1/messages` 必然失败);这种渠道要走**路由模式**。

### Codex(OpenAI Responses 协议)

```bash
./mixctl route codex                # config.toml 顶层 model_provider 换成 mixr-router
```

Codex 槽位(如 `main` / `reviewer`)不是客户端 env 别名,**没有 `route codex --slots`
这个命令行参数**——`./mixctl route codex --slots` 会被 `mixctl` 直接拒绝。应用槽位用
控制台「渠道」页 Codex 标签下的「应用槽位到客户端」按钮,它实际调的是
`POST /api/router/codex {"slots": true, "revision": "<state.live.codex.revision>"}`。
两个槽都必须已绑定启用、有模型名和 API Key 的渠道;改完需重启 Codex 生效。

等价手改是在 `~/.codex/config.toml` 里加一个 provider section:

```
base_url               = "http://127.0.0.1:8787/v1"      # 带 /v1
wire_api               = "responses"
experimental_bearer_token = "mixrouter-local"            # 占位,不能为空
# 顶层 model 保持不动
```

`./mixctl route codex` 是**外科手术式**改写:顶层原位替换、追加 `[model_providers.mixr-*]`
section,用户自己的 section 一字不动,二次切换会清掉旧的 mixr section。

### ZCode(三种协议都行)

```bash
./mixctl route zcode                # 默认 Anthropic
./mixctl route zcode responses      # OpenAI Responses
./mixctl route zcode chat           # OpenAI Chat
```

只写桌面端 `~/.zcode/v2/config.json` 的自有 provider 条目,**不修改默认模型、已有会话、
其它服务商或 CLI 扩展配置**。配完在 ZCode 的模型选择器里选 **Mixrouter · …**;新条目没出现
就重启客户端并新建会话。

| 接入协议 | ZCode provider kind | 复用渠道组 |
| --- | --- | --- |
| Anthropic | `anthropic` | Claude / Anthropic |
| OpenAI Responses | `openai` | Codex / OpenAI |
| OpenAI Chat | `openai-compatible` | Codex / OpenAI 中的 chat 渠道 |

> ZCode 接入的写入边界见 [`reference.md`](reference.md) 与[命令行与运行边界](cli.md#3-客户端接入)。

### 代理端点一览(不用背,记住"两个口")

| 端点 | 协议 | 渠道组 |
| --- | --- | --- |
| `POST /v1/messages`、`/v1/messages/count_tokens` | Anthropic | Claude Code |
| `POST /v1/responses` | OpenAI responses | Codex |
| `POST /v1/responses/compact` | OpenAI responses | Codex(`responses` 协议渠道原样透传) |
| `POST /v1/chat/completions` | OpenAI chat | Codex(`wire_api=chat` 的渠道) |
| `GET /v1/models`、`HEAD <任意端点>` | 探活 / 只读模型清单 | 两组 + 路由目标 |

响应头带 `x-mixrouter-app` / `x-mixrouter-provider` / `x-mixrouter-model` / `x-mixrouter-session`,
排查时先看这四个。

---

## 查看用量

左侧「用量统计」按当前可用日志汇总,不使用供应商账单,也不估算费用。

- 顶部选择协议组、供应商、实际模型、时间与请求状态。指标卡、热力图和下方明细共用这些条件。
  Anthropic / OpenAI 是协议分组,不代表能区分 Claude Code、桌面客户端和 ZCode。
- 四张指标卡显示请求数、总 tokens、缓存命中率与成功率。总 tokens = 新增输入 + 输出 + 缓存读;
  缓存命中率 = 缓存读 / (新增输入 + 缓存读)。缺少测量值时显示「—」。
- 热力图按本地日期排列,周一在上,可切换 Tokens / 请求。悬停、键盘或「按日查看数据」都能读数。
  默认展示最近 53 周,有更早日志时可展开。未覆盖日期不等于零请求;默认日志保留期是 30 天,
  「全部」也只是目前还能读取的日志,不是历史总账。
- 下方切换「请求日志 / 供应商 / 模型」。日志支持翻页,实际模型优先展示,
  请求别名与实际模型不同时可查看别名。供应商和模型下拉精确匹配,不会把相似名字混在一起。
- 「数据来源」解释日志覆盖与统计口径。「首响应」测的是请求开始到上游响应头到达,
  不是模型首个文字 token。同步失败会保留并标记旧数据,不会把旧结果说成新筛选的统计。

## 4. 跑测试与离线验收

```bash
npm test                 # = node scripts/run-tests.js,整套 test/*.test.js(仅源码 clone)
npm test -- test/codex.test.js   # 单文件,同样经过隔离入口
npm run smoke            # = node scripts/smoke-offline.js,离线端到端验收,退出码 0 = 全绿
```

**两个入口不同**:GitHub 源码 clone 带完整 `test/`,可以跑 `npm test`;Release 运行包(tarball)
不含开发测试套件,`npm test` 会明确提示缺 `test/` 并让你改用 `npm run smoke`,
不要把它当成安装失败。`npm run smoke` 两个入口都能跑。

`npm test` 走的是 `scripts/run-tests.js`,不是裸 `node --test`。它在跑之前把 `HOME`、
`TMPDIR`、`MIXR_DATA_DIR`、三个客户端配置路径统一重定向到临时目录,并**过滤掉调用方环境里
所有 `MIXR_` / `MIXROUTER_` / `MIXUI_` 变量**。所以它**永远不碰你的真实配置**,也用不到任何
安装步骤。直接 `node --test` 会跳过这层隔离与总时限。

`npm run smoke` 起一个**临时实例**跑一进一出的真流量:端口由内核分配(显式断言不落在
8787/8788)、上游是进程内 mock(不出网、不花钱)、Key 是现场编的占位串。它不需要你有任何真实
渠道 Key。完整的隔离层次与验收清单见 [`offline-run-and-acceptance.md`](offline-run-and-acceptance.md)。

### 离线故障注入(不花钱)

```bash
node scripts/diagnose-upstream.js --help
node scripts/diagnose-upstream.js --scenario mixed --concurrency 2 --requests 8
```

**默认离线**:起真实临时 mixrouter,上游只连本地故障桩,不读真实渠道配置或 Key。
`--scenario` 可选 `mixed|success|429|500|first-byte|idle|deadline|401`。
受控并发参数(`--concurrency` / `--requests` / `--duration-ms` / `--timeout-ms`)各有硬上限。

还有一种**会花钱**的渠道模式(连接一个真实渠道,须显式确认):

```text
MIXR_DATA_DIR=/absolute/path node scripts/diagnose-upstream.js --mode provider --provider ID --requests N --confirm-run [--model NAME]
```

`--confirm-run` 是执行确认,**不等于取得账号使用授权**;只读该目录的 `providers.json`,
只发 ping 与低输出上限请求。**未实际测试真实上游**。

> 两套模式各自的限额与边界见 [`reference.md`](reference.md#离线故障注入的参数上限)。

---

## 5. 改完代码之后

先在源码仓库跑 `npm test`。`mixrouter.js` 与 `lib/**/*.js` **不热加载**;
等手上在途的请求结束,再按启动方式重启:

- **前台 `npm run local`**:回到原终端按 Ctrl+C,退出后再执行原来的启动命令。
  它没有 pid 文件,不由 `mixctl restart` 管理。另开终端执行 `npm run doctor`,
  自定义的 `--data-dir`、`--port`、`--ui-port` 要与启动时一致。
- **后台 `./mixctl start`**:才使用下面的命令,并沿用启动时的数据目录和端口环境变量:

```bash
./mixctl restart
./mixctl status          # 必须显示「已加载当前源码」
```

`npm run doctor` 与 `./mixctl status` 都会比较服务启动时记下的 `/api/state.code_revision`
与磁盘当前源码的 SHA-256(由 `lib/runtime-code.js` 的 `codeRevision()` 算)。
服务未启动在 doctor 中只是 WARN;重启后还要确认服务探测及源码核对均为 OK。
`./mixctl status` 在不一致或无法核对时退出码为 1。
**`/healthz` 回 200 不能当作补丁生效的证据**——它只说明进程活着。

槽位 / 渠道 / 会话 / 路由等**运行时配置**不计入源码指纹,改它们不需要重启。

改完 UI 顺手确认控制台还能开:

```bash
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/
```

排查常见故障见 [`troubleshooting.md`](troubleshooting.md);升级与回退见
[`upgrade-and-rollback.md`](upgrade-and-rollback.md)。
