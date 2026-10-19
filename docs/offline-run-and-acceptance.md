# 离线运行与验收

这份文档回答一件事:**在一台没有渠道 API Key、也没有任何运行态文件的机器上,
怎么把 mixrouter 跑起来并确认它是好的。**

面向的是接手代码的人(以及 CI 之外的预检)。命令都可以直接复制执行;凡是没有亲自跑过的
条目,下面会写明「未验证」。

## 0. 硬门槛只有一个:Node

| 项 | 要求 | 出处 |
| --- | --- | --- |
| Node | `>= 18` | `package.json` 的 `engines.node` |
| 依赖 | **无**。零 `dependencies`、零 `devDependencies`、无 lockfile、无 `node_modules` | `package.json` |
| 安装步骤 | **无**。不需要 `npm install` | CI 里就没有 install 这一步 |
| 推荐版本 | Node 22 / 24;`>= 18` 仍可运行但只做兼容保留 | `package.json` 的 `engines.node` |
| Docker / 容器 | **不需要,仓库里也没有** | 全仓无 Dockerfile / docker-compose / Makefile |
| OS | 核心服务跨平台(Node 内置模块);可选外壳是 macOS 专有,见 §3 | — |

```bash
node -v          # 需要 v18 或更高
git clone https://github.com/yange0793-dot/mixrouter-oss.git
cd mixrouter-oss
npm run doctor   # 无 Key、未启动的警告是正常的;不修改配置
npm run local    # 前台启动;数据与代码分离,不需要 npm install
```

`npm run local` 会监听两个口(都可改,见 §2):代理 `127.0.0.1:8787`、控制台 `127.0.0.1:8788`。
两个口都**写死只绑回环**,代码里没有 `0.0.0.0` / `[::]`。
新入口默认数据目录为 `~/.local/share/mixrouter/data`,支持 `--data-dir`、`--port`、`--ui-port`。
旧版 `npm start` 不改变默认值:未设 `MIXR_DATA_DIR` 时仍使用代码目录。

`npm run doctor -- --offline` 完全不连接端口,也不建目录或修改配置。
机器可读输出用 `npm run --silent doctor -- --json`;它不输出 Key、渠道地址或会话内容,
但包含数据目录路径,分享前仍应检查用户名等本机信息。自检不调用上游,不能证明 Key 或模型有效。

## 1. 三分钟离线验收(推荐先跑这个)

```bash
npm run smoke                      # 等价于 node scripts/smoke-offline.js;退出码 0 = 全绿
```

它不需要你有任何真实 Key,也不会碰你的真实配置。做的隔离有六层:

1. **端口由内核分配**。脚本先 `listen(0)` 探出空闲口再交给子进程,并**显式断言**拿到的口
   不落在 8787 / 8788 上——正在跑的常驻实例完全不受影响。脚本全程不连接 8787/8788。
   探到的口在关闭到子进程 bind 之间有一个真实存在的竞态窗口,所以**端口归属另有一条程序保证**:
   起完之后比对 `/api/state` 报的 `pid` 与本次拉起的子进程 pid。抢输了会明确 FAIL,
   而不是安安静静测到别人的实例——`/healthz` 回 200 只说明那个口上有个 mixrouter 在跑,
   说明不了是谁。
2. **上游是本进程内的 mock**,监听 `127.0.0.1` 的临时口。不出网、不花上游钱、无真实计费。
3. **Key 是现场编的占位串**(`sk-smoke-…`),只用于走完长度/形状判断。
4. **`HOME` 指向临时目录**。这一层比逐个覆盖环境变量更稳:任何**没被显式覆盖**的落点
   (含将来新加的)也自动落在临时目录里,不会摸到真实的 `~/.claude`。
5. **`MIXR_DATA_DIR` 指向临时目录**,providers / routes / slots / sessions / logs 全在那一份。
6. **`MIXR_UPSTREAM_PROXY` 显式置空**(而不是依赖调用方 shell 里没有)。

**不监视真实 HOME**。脚本不去 stat 真实的 `~/.claude` / `~/.codex` / `~/.zcode`,也不拿仓库根
`providers.json` 之类的 mtime 去推断"我有没有污染":那些都是运行中本来就会被改写的文件,
其它会话正常操作就会让这类断言误报。防污染改成两条:严格的环境隔离(上面 4/5 条),加上
临时 `HOME` 里放一份**哨兵** `settings.json`,跑完比对内容原样未动——这才是在验证
"这条路径确实没被触发",而不是在监视别人的文件。

它验收的行为(逐条断言,失败会打印期望值与实际值):

- 代理口 `GET /healthz` 回 200 且自报 `service: "mixrouter"`;
- **端口归属**:控制台口上应答的进程 pid 就是本次拉起的子进程(见上面第 1 条);
- 临时数据目录里确实落下了 `providers.json` / `routes.json`(证明用的是临时库);
- 控制台 `GET /api/state` 里**原始 Key 一个字节都不出现**,渠道以 `key_masked` / `has_key` 形式暴露;
- `GET /api/health`、`/api/logs`、`/api/stats` 可用;
- **Anthropic 直通**非流式一进一出:出站打到 `/v1/messages`、模型名按路由改写、`x-api-key` 与
  `Authorization` 都是该渠道的占位 Key;
- **Anthropic 流式**:SSE 最后一个事件必须是 `message_stop`(中途夭折补终态是客户端最难受的故障形状);
- **`wire_api=responses` 的 Claude 渠道**:客户端说 Anthropic,出站打到 `/v1/responses`,
  响应翻回 Anthropic `message`,且**不往 OpenAI 型上游发 `x-api-key`**;
- **`wire_api=chat` 的 Claude 渠道**非流式与流式各一进一出:出站打到 `/v1/chat/completions`,
  整包翻回 Anthropic `message` / 流式翻回完整 SSE 收尾(mock 会发 `finish_reason: 'stop'`
  终态块,所以这条同时钉住了"chat 的终态要翻成 Anthropic 收尾"而不是靠断流兜底);
- **Responses 一进一出**非流式与流式(最后一条 SSE 必须是 `response.completed`);
- `GET /v1/models` 与 `HEAD /v1/messages` 探活,未知路径回 404;
- 请求日志确实落在 `MIXR_DATA_DIR` 下,且里面不含原始 Key;
- 临时 `HOME` 里的**哨兵**客户端配置内容原样未动。

收尾在 `finally` 里:子进程先 `SIGTERM`(它会走自己的优雅退出落盘),5 秒不退再 `SIGKILL`;
监听关闭;临时目录 `rm -rf`。每一步清理都带**截止时间**,而且**清理失败会被记成一条 FAIL
并让退出码非 0**——收不干净却打 `SMOKE PASS` 比不清理更误导。

> 一个**已经变过的前提**(曾经是脚本要补的疏漏):请求日志的落盘目录现在由
> `lib/observability/request-log.js` 在**首次 append 时自己建**(`0700`,见
> `test/request-log.test.js` 的「首次 append 才建目录与文件:目录 0700、文件 0600」),
> `require` 它本身零副作用——不建目录、不起定时器,目录与文件推迟到第一次真写。
> 所以 `MIXR_DATA_DIR` 指向干净目录时请求日志会照常落盘,不再像以前那样静默丢失、
> 只剩控制台内存 ring 有数据(只看 UI 看不出来)。
> `scripts/launchd-run.sh` 里那句 `mkdir -p ... logs` 现在只是装机习惯,不是日志能否落盘的
> 唯一来源。验收脚本**仍然显式建一次** `logs/`:把「日志落盘」当作被验收的行为,
> 而不是继承一个前提。

## 2. 环境变量

**路径类与端口类都在 `mixrouter.js` 模块顶层读取**:必须在 `require()` **之前**设好,
require 之后再改不生效。这也是为什么 `test/` 下每个文件都在 `require('../mixrouter.js')`
之前就把 `process.env` 写好。

完整的变量表见 [`reference.md`](reference.md#10-环境变量),这里只列做离线验证一定会用到的:

```bash
MIXR_DATA_DIR=/tmp/mixr-run \
MIXR_CLAUDE_SETTINGS=/tmp/mixr-run/claude/settings.json \
MIXR_CODEX_CONFIG=/tmp/mixr-run/codex/config.toml \
MIXR_ZCODE_CONFIG=/tmp/mixr-run/zcode/config.json \
MIXROUTER_PORT=0 MIXUI_PORT=0 \
node mixrouter.js
```

`MIXROUTER_PORT=0` 让内核分配端口。**启动横幅现在打的是真实绑定端口**——监听与上报都交给
`lib/server/lifecycle.js`,它的 `start()` 解析后给出 `{ proxy: { port }, ui: { port } }`,
`mixrouter.js` 拿这两个值拼横幅(`rep.proxy.port` / `rep.ui.port`),不再是配置常量
(端口要 bind 成功那刻就记下来:`close()` 之后 `address()` 立刻返回 null,而超时强清正好
发生在那之后)。

**但 `/api/state` 的 `proxy_port` / `ui_port` 仍然是配置常量 `PROXY_PORT` / `UI_PORT`**
(`mixrouter.js` 的 `/api/state` 分支直接回这对常量)。所以设成 0 时:
**横幅能拿到真实端口,`/api/state` 仍自报 `0`。** 两处口径不一致是有意的历史遗留——
`apiHandler` 是个独立函数,拿不到 `lifecycle.start()` 的解析结果。

推论:
- **不要拿 `/api/state` 的 `proxy_port` / `ui_port` 当真实监听端口**;
- 端口实际是多少,看**启动横幅**(它用的是绑定结果);
- 测试里断言「路由目标端口」时要用模块导出的 `ROUTER_URL`(由 `PROXY_PORT` 拼出),
  不能写死 `8787`——`test/codex.test.js` 就是这么处理的;`ROUTER_URL` 与 `/api/state`
  的 `proxy_port` 同源(都是配置常量),但都**不等于**端口设 0 时的真实监听端口。

验收脚本因此不依赖服务自报端口:先 `listen(0)` 探一个空闲口再交给子进程,**把探到的具体端口
用 `MIXROUTER_PORT` / `MIXUI_PORT` 传给子进程**(不是传 0),再拿 `/api/state` 的 `pid` 做
**归属硬闸门**——pid 必须是本次拉起的子进程,`proxy_port` / `ui_port` 也必须与预期一致
(这两个值此时等于实际端口,因为脚本给的就是具体端口,与配置常量同值)。
这套预探机制**不能消除**探口到子进程 bind 之间的竞态:端口可能在这中间被别的进程抢走,
所以才有那条 pid 归属断言兜底;校验失败时立即中止,不发送任何业务请求。

> 关于「读真实端口」:进程内路径(启动横幅)已能拿到绑定结果,但**没有 HTTP 接口**把它暴露出来
> ——`/api/state` 回的是配置常量。脚本不依赖它是有意的:预探 + pid 归属这套不依赖服务自报端口,
> 在各 Node 版本上都能判定;而"读服务自报端口"在端口设 0 时反而读不到真值。

## 3. 可选依赖与可选外壳(都不是启动必需)

| 组件 | 边界 | 缺了会怎样 |
| --- | --- | --- |
| `scripts/import-ccswitch.js` | 需要系统 `sqlite3` 命令(不在 Node 里,也不在 `package.json` 里) | 导入命令直接失败;核心服务不受影响。**未验证**:仓库里没有 cc-switch 库的样本,没在干净环境实跑过 |
| `~/Library/LaunchAgents/*.mixrouter.plist` | 开机常驻,纯可选外壳,仅 macOS。plist 内容见 [CLI 文档的常驻一节](cli.md#8-常驻可选launchdmacos) | `mixctl start` 退回自己 `spawn` 一个后台进程,功能一样,只是没有开机自启与崩溃拉起 |
| `app/MixrouterApp.swift` + `scripts/build-app.sh` | **实验性**桌面窗口,纯可选外壳。需要 macOS + CommandLineTools 里的 `swiftc`、`codesign`、`plutil` | 用浏览器开 `http://127.0.0.1:8788` 即可,功能一样 |
| `MIXR_UPSTREAM_PROXY` | 出站 CONNECT 隧道,只在"端口式代理"的网络里需要 | 直连。注意 `lib/upstream-proxy.js` 只支持 `http://` 的 CONNECT;环回地址永不隧道 |

**完整 CI 跑在 Linux 上**(`.github/workflows/ci.yml`,`ubuntu-latest`,Node 18/22/24 矩阵),
先 `npm test` 再 `npm run smoke`。工作流另有 macOS Node 24 的解包制品验收任务,
但不跑 Swift 桌面外壳构建。工作流已配置不等于本次分支已在 GitHub 跑过;
实际运行结果以 Actions 为准,Windows 与桌面外壳不在该矩阵范围内。

## 4. 跑测试

**两个入口的测试范围不同**:

| 入口 | 有什么 | 验收命令 |
| --- | --- | --- |
| GitHub 源码 clone | 完整 `test/`、`.github/`、`docs/` | `npm test` + `npm run smoke` |
| Release 运行包(tarball) | 运行所需源码与资源,**不含开发测试套件** | `npm run smoke` |

在运行包里跑 `npm test` 会明确报"此运行包不含开发测试套件"并指向源码仓库,
不会把它伪装成一个空的通过结果,也不是一个看不懂的 ENOENT。

```bash
npm test                 # → node scripts/run-tests.js(仅源码仓库)
npm run smoke            # → node scripts/smoke-offline.js(两个入口都可跑)
```

**`npm test` 走的就是 `scripts/run-tests.js`**,不是直接调 `node --test`。它在跑之前做三件事
(以下都按 `scripts/run-tests.js` 现役源码写):

1. **整份环境重定向到一次性临时目录**:`HOME`、`USERPROFILE`、`XDG_CONFIG_HOME`、
   `TMPDIR`/`TMP`/`TEMP`、`MIXR_DATA_DIR`、三个客户端配置路径(`MIXR_CLAUDE_SETTINGS` /
   `MIXR_CODEX_CONFIG` / `MIXR_ZCODE_CONFIG`)。调用方环境里所有 `MIXR_` / `MIXROUTER_` / `MIXUI_` 前缀的变量
   **整个过滤掉**,不继承现役路由旋钮;`MIXROUTER_PORT` / `MIXUI_PORT` 显式设成 `'0'`,
   `MIXR_UPSTREAM_PROXY` 显式置空。跑完把整个临时根目录删掉。
   > 注意 `MIXROUTER_PORT='0'` 在这套环境里的实际效果:见 §2,`ROUTER_URL` 与
   > `/api/state` 的 `proxy_port` 都按配置常量算,等于 `0`。所以测试里断言端口相关的
   > 契约(路由模式要指向哪个 base_url)时用模块导出的 `ROUTER_URL`,不能写死 `8787`
   > (`test/codex.test.js` 就是这么处理的)。测试**不**起常驻监听,所以这条路径上不存在
   > 「真实绑定端口」——那是 `lib/server/lifecycle.js` 的事,归 `npm run smoke` 那类
   > 起真实进程的验收管。
2. **按当前 Node 能力选 flag**:先跑 `node --help` 看有没有 `--test-timeout`,没有(Node 18)
   就自动不传,不靠 workflow 兜。
3. **整套截止 300000ms(5 分钟)**。POSIX 平台将测试派生到独立进程组,超时或收到
   `SIGINT`/`SIGTERM` 时先发 SIGTERM,5 秒后仍未结束再发 SIGKILL;Windows 使用直接子进程的
   `kill()`。Node 支持 `--test-timeout` 时另设 30000ms 默认测试超时,单项显式超时可覆盖该值;
   Node 18 依靠各测试自身的超时和入口总时限。

`NODE_TEST_CONTEXT` 会被显式剔除:从 node:test 进程里再派生这个入口时,继承下来的
`child-v8` 会让内层 `node --test` 跳过全部文件却仍然退出 0——剔除它才拿得到真实退出码。

单个文件也走同一隔离入口:

```bash
npm test -- test/codex.test.js
```

直接 `node --test` 会跳过入口的环境清理与总时限,只在自行配置好隔离环境时使用。

`npm test` 与 `npm run smoke` 都写在 CI 与 Release 工作流里(先 test 再 smoke),
CI 的 Node 18/22/24 矩阵在上游仓库运行。本地验证记录(2026-10-18,v3.6.1 工作树,Node v24.18.0):
`npm test` 94 个文件、**1512/1512 通过**(0 fail / cancelled / skipped,约 26.8s);
`npm run smoke` 18/18 通过。Node 18 / 22 本轮未重跑,不写成"全矩阵已通过"。

## 5. 最小自检清单

接手一段不熟的改动、或换了一台机器时,按这个顺序过一遍就够定位「是环境问题还是代码问题」:

1. `node -v` ≥ 18;
2. `npm test` 全绿(不需要 install)——仅源码 clone;运行包用 `npm run smoke`;
3. `npm run smoke` 退出码 0;
4. 若要起常驻:`./mixctl start` 后 `./mixctl status` 显示「已加载当前源码」——
   `/healthz` 回 200 **不能**当作补丁生效的证据(它只说明进程活着);
5. 控制台能开:`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/`。

## 未验证范围

这份文档里带「**未验证**」标记的条目没有实跑过,不要当成结论引用:
`sqlite3` 导入路径、cc-switch 库结构、macOS 外壳脚本(本机没有相应环境时)、
以及任何真实上游渠道的行为(离线验收全程不出网)。历史版本上的真实客户端端到端记录
同样不代表当前版本的兼容性。
