# 第四期任务 1–2：三类路径与 macOS 安装入口

> 历史开发记录：公开源码副本中的个人目录和账户标识已替换为占位值。本文保留当时取证口径，不代表当前实现或运行状态；使用说明以用户文档为准。

对应规划 `refactor-plan-2026-10-16.md` §5.4 任务 1、任务 2。任务 3（解除 WKWebView 个人路径依赖）、
任务 4（制品清单与校验和）、任务 5（README/文档整理）、任务 6（独立 HOME 演练）**不在本文范围**。

本轮交付：

| 文件 | 状态 | 说明 |
|---|---|---|
| `lib/paths.js` | 新增 | 三类路径的唯一来源（纯函数、require 零副作用） |
| `test/paths.test.js` | 新增 | 17 例；其中 6 例是"防漂移"断言（端口字面量、白名单与代码一致等） |
| `scripts/install-macos.sh` | 新增 | 安装/升级入口，干跑优先 |
| `test/install-script.test.js` | 新增 | 17 例，全部在临时 HOME + 临时安装根里跑 |
| `mixctl` | 改动 | 四行路径常量改为从 `lib/paths.js` 取（等价搬迁） |
| `lib/zcode-config.js` | 改动 | zcode 配置默认路径改为从 `lib/paths.js` 取（等价搬迁） |
| `docs/changes/phase4-paths-and-install-2026-10-17.md` | 新增 | 本文 |

行号基准：当前工作树（HEAD `67fd952`，分支 `refactor/phase1-reliability`）。工作树里另有并行
进行的第三期改动（`public/`、`lib/http/console.js`、`test/ui.test.js` 等），本文不涉及那些文件。
`mixrouter.js` 与 `lib/http/console.js` 在本文取证时正被其他分支改动，**它们的行号可能已经移动**；
表格里每一条都附了代码特征，行号对不上时按特征找。

---

## 一、只读审计：四个文件里所有读写文件系统路径的地方

未在本轮改动的文件按**原样**记录（本轮只审计，不动）。审计目的不是"改掉它们"，是让任务 3/4
知道有哪些依赖、以及哪些是"同一份知识写在多处"的重复。

### 1.1 `mixrouter.js`

| 行 | 读/写 | 路径怎么拼 | 环境变量 | 默认值 |
|---|---|---|---|---|
| `mixrouter.js:89` | — | `ROOT = __dirname` 源码根 | 无 | 仓库目录 |
| `mixrouter.js:90` | 读 | `codeRevision(ROOT)` 遍历 `lib/**.js` + `mixrouter.js` 算 sha256 | 无 | — |
| `mixrouter.js:92` | — | `DATA_DIR = LIVE_FILES.dataDir(env, ROOT)` | `MIXR_DATA_DIR` | `ROOT`（仓库目录） |
| `mixrouter.js:96` | 读+写 | `PROVIDERS_FILE = DATA_DIR/providers.json` | 经 DATA_DIR | — |
| `mixrouter.js:97` | 读+写 | `ROUTES_FILE = DATA_DIR/routes.json` | 经 DATA_DIR | — |
| `mixrouter.js:98` | 写 | `LOG_FILE = DATA_DIR/logs/requests.jsonl` | 经 DATA_DIR | — |
| `mixrouter.js:101` | 写 | `RESPONSE_ARCHIVE_DIR = MIXR_RESPONSE_ARCHIVE_DIR \|\| DATA_DIR/logs/responses` | `MIXR_RESPONSE_ARCHIVE_DIR` | `DATA_DIR/logs/responses` |
| `mixrouter.js:102` | 读 | `PUBLIC_DIR = ROOT/public` 静态页面 | 无 | 源码根下 |
| `mixrouter.js:183` | 读+写 | `SESSIONS_FILE = DATA_DIR/sessions.json` | 经 DATA_DIR | — |
| `mixrouter.js:185` | 读+写 | `SLOTS_FILE = DATA_DIR/slots.json` | 经 DATA_DIR | — |
| `mixrouter.js:216` | 读+写 | `CLAUDE_SETTINGS = LIVE_FILES.claudeSettings(env, homedir())` | `MIXR_CLAUDE_SETTINGS` | `~/.claude/settings.json` |
| `mixrouter.js:218` | 读+写 | `CODEX_CONFIG = LIVE_FILES.codexConfig(env, homedir())` | `MIXR_CODEX_CONFIG` | `~/.codex/config.toml` |
| `mixrouter.js:222` | 读 | `loadJson(file)` 通用读取（providers/routes/slots 共用） | — | — |
| `mixrouter.js:227/233` | 读 | `loadJson(PROVIDERS_FILE)` | 经 DATA_DIR | — |
| `mixrouter.js:257` | 写 | `saveJson(PROVIDERS_FILE, …)`，**全仓唯一覆盖 providers.json 的地方** | 经 DATA_DIR | — |
| `mixrouter.js:396/402` | 读/写 | `loadJson(ROUTES_FILE)` / `saveJson(ROUTES_FILE)` | 经 DATA_DIR | — |
| `mixrouter.js:441/446` | 读/写 | `loadJson(SLOTS_FILE)` / `saveJson(SLOTS_FILE)` | 经 DATA_DIR | — |
| `mixrouter.js:522` | 读写 | `createSessionStore({ sessionsFile: SESSIONS_FILE … })` | 经 DATA_DIR | — |
| `mixrouter.js:627` | 写 | `createRequestLog({ file: LOG_FILE … })` | 经 DATA_DIR | — |
| `mixrouter.js:638` | 删 | `sweepLogs({ directory: dirname(LOG_FILE) … })` 启动清一次 | 经 DATA_DIR + `MIXR_LOG_RETAIN_DAYS` | 30 天 |
| `mixrouter.js:840` | 写 | `responseArchiveDir: RESPONSE_ARCHIVE_DIR` 注入代理 | 见 101 行 | — |
| `mixrouter.js:894` | 读 | `readClientConfig(file)` 读客户端配置（带 BOM 处理） | — | — |
| `mixrouter.js:930/931/942` | 读 | `switchClaude`：读 `CLAUDE_SETTINGS` → `backupFile` → `writeFileAtomic` | `MIXR_CLAUDE_SETTINGS` | — |
| `mixrouter.js:1033/1034/1045` | 读+写 | `switchClaudeRouter`：同上路径 | 同上 | — |
| `mixrouter.js:956` | 建目录 | `fs.mkdirSync(dirname(CODEX_CONFIG), {recursive:true})` | `MIXR_CODEX_CONFIG` | — |
| `mixrouter.js:959-966` | 读+写 | `commitCodexConfig`：能力目录两文件 + `config.toml`，内容变了才备份+原子落盘 | `MIXR_CODEX_CONFIG` | — |
| `mixrouter.js:973/980/1001/1005/1017/1049` | 读+写 | `codexConfig.read/prepareCatalog` 读改写 `CODEX_CONFIG` | 同上 | — |
| `mixrouter.js:1139` | 读 | `liveState()` 读 `CLAUDE_SETTINGS` | 同上 | — |
| `mixrouter.js:1158` | 读 | `codexConfig.state(CODEX_CONFIG, …)` | 同上 | — |
| `mixrouter.js:1182` | 读 | `PUBLIC_DIR` 与 `ROOT` 注入 console handler | 无 | — |

**`MIXR_DATA_DIR` 之下有哪些东西**：`providers.json`、`routes.json`、`sessions.json`、`slots.json`、
`logs/requests.jsonl`、`logs/responses/` —— **全部在它下面**。`backups/` 与 `.run/` **不在**它下面
（备份池就躺在活文件同目录，见 `lib/backup/targets.js`；`.run/` 在代码目录）。

### 1.2 `mixctl`

| 行 | 读/写 | 路径怎么拼 | 环境变量 | 默认值 |
|---|---|---|---|---|
| `mixctl:27` | — | `ROOT = __dirname` | 无 | 仓库目录 |
| `mixctl:28` | 建目录 | `RUN_DIR = paths.runDir(ROOT)` = `ROOT/.run` | 无 | 仓库目录下 |
| `mixctl:29` | 读+写+删 | `PID_FILE = paths.pidFile(ROOT)` = `ROOT/.run/mixrouter.pid` | 无 | — |
| `mixctl:30` | 建目录+写 | `SERVER_LOG = paths.serverLog(ROOT)` = `ROOT/logs/server.log` | 无 | **代码目录下的 logs**，不是数据目录 |
| `mixctl:33` | 读 | `REQ_LOG = paths.requestsLog(env, ROOT)` | `MIXR_DATA_DIR` | `ROOT` |
| `mixctl:35` | — | `UI_PORT = MIXUI_PORT \|\| 8788` | `MIXUI_PORT` | 8788 |
| `mixctl:37` | 读 | `LAUNCHD_DIR = paths.launchAgentDir(homedir())` | 无 | `~/Library/LaunchAgents` |
| `mixctl:40-41` | 读 | `readdirSync(LAUNCHD_DIR)` 找 `*.mixrouter.plist` | 无 | — |
| `mixctl:46` | 读 | `readFileSync(PID_FILE)` | 无 | — |
| `mixctl:278-279` | 建目录 | `mkdirSync(RUN_DIR)` + `mkdirSync(dirname(SERVER_LOG))` | 无 | — |
| `mixctl:284` | 服务 | `launchctl kickstart -k gui/<uid>/<label>`（**不是文件路径，但是 plist 的真实使用点**） | — | — |
| `mixctl:296-299` | 写 | `openSync(SERVER_LOG,'a')` + `spawn(node, ROOT/mixrouter.js)` + `writeFileSync(PID_FILE)` | 无 | — |
| `mixctl:308/312` | 删 | `unlinkSync(PID_FILE)` | 无 | — |
| `mixctl:626` | 删 | `sweepLogs({ directory: paths.logDir(env, ROOT) })` | `MIXR_DATA_DIR` + `MIXR_LOG_RETAIN_DAYS` | 2 天（CLI 侧） |
| `mixctl:653` | 读 | `selectLogs(REQ_LOG, …)` 离线看日志 | 经 REQ_LOG | — |
| `mixctl:475` | 读 | `backupTargets({ root: ROOT, home: homedir(), env })`（三处备份池清点） | `MIXR_*` 三件套 | — |
| `mixctl:728` | 读+写 | `runRestoreCmd(…, { root: ROOT, home: homedir(), env })` | 同上 | — |

**`mixctl` 里重复拼接的三处**（本轮已收拢）：`RUN_DIR`/`PID_FILE`（与 `scripts/launchd-run.sh` 的
`$DIR/.run` 是同一份知识）、`SERVER_LOG`、`REQ_LOG`（与 `mixrouter.js` 的 `DATA_DIR` 同一份语义）。
`mixctl:626` 此前**第三次**拼了 `MIXR_DATA_DIR || ROOT`，也一并收拢。

### 1.3 `scripts/launchd-run.sh`（全文 16 行）

| 行 | 读/写 | 路径怎么拼 | 环境变量 | 默认值 |
|---|---|---|---|---|
| `scripts/launchd-run.sh:7` | — | `DIR="$(cd "$(dirname "$0")/.." && pwd)"`（脚本在 `<root>/scripts/` 里，往上退一层） | 无 | 仓库目录 |
| `scripts/launchd-run.sh:8` | 读 | `command -v node` | `PATH` | — |
| `scripts/launchd-run.sh:10` | 读 | `ls $HOME/.nvm/versions/node/*/bin/node \| tail -1` | `HOME` | — |
| `scripts/launchd-run.sh:13` | 建目录 | `mkdir -p "$DIR/.run" "$DIR/logs"` | 无 | — |
| `scripts/launchd-run.sh:14` | 写 | `echo $$ > "$DIR/.run/mixrouter.pid"`（**与 `mixctl:29` 是同一个文件，两边各拼一次**） | 无 | — |
| `scripts/launchd-run.sh:15` | — | `exec "$NODE" "$DIR/mixrouter.js"` | 无 | — |

**这个脚本没有 `MIXR_DATA_DIR`**：它只经 `$DIR` 定位源码与 `.run/`，数据目录由被 exec 的
`mixrouter.js` 自己按环境解析。LaunchAgent 的 `EnvironmentVariables` 是数据目录注入口。

### 1.4 `app/MixrouterApp.swift`

| 行 | 读/写 | 路径怎么拼 | 环境变量 | 默认值 |
|---|---|---|---|---|
| `MixrouterApp.swift:10` | 连接 | `consoleBase = env["MIXROUTER_CONSOLE_URL"] ?? "http://127.0.0.1:8788"` | `MIXROUTER_CONSOLE_URL` | 8788 |
| `MixrouterApp.swift:11-12` | 连接 | `consoleURL` / `healthURL = consoleBase + "/healthz"` | 同上 | — |
| `MixrouterApp.swift:19-23` | 读 | `repoRoot()`：`MIXROUTER_REPO` → `Info.plist` 的 `MixrouterRepoRoot` → **`NSHomeDirectory() + "/<旧个人源码目录>/mixrouter"`** | `MIXROUTER_REPO` | **⚠ 见下** |
| `MixrouterApp.swift:29-33` | 读 | `findNode()`：`PATH` 各层 → `~/​.nvm/versions/node/*/bin/node` → `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin` | `PATH` | 写死的三个系统路径（可接受） |
| `MixrouterApp.swift:211-212` | 读 | `let mixctl = root + "/mixctl"`，`fileExists` 检查 | 经 repoRoot() | — |
| `MixrouterApp.swift:216-221` | — | `proc.executableURL = <node>`，`arguments = [mixctl, …]`；兜底 `/usr/bin/env node <mixctl>` | — | — |
| `MixrouterApp.swift:223` | — | `proc.currentDirectoryURL = root` | — | — |
| `MixrouterApp.swift:259-261` | 建目录+打开 | `openLogs()`：`URL(fileURLWithPath: repoRoot() + "/logs", isDirectory: true)`，`createDirectory` 后 `NSWorkspace.open` | 经 repoRoot() | — |
| `MixrouterApp.swift:198` | 文案 | 错误页里硬编码 `"logs/server.log"`（给人看的相对提示） | — | — |

**最值得注意的一条（任务 3 的输入）**：

- **`MixrouterApp.swift:22` 是本次审计里唯一写死的个人绝对路径** ——
  `NSHomeDirectory() + "/<旧个人源码目录>/mixrouter"`。它指向的是 **`mixrouter-src` 的兄弟目录名**
  （`mixrouter`），而本机实际在跑的是 `mixrouter-src`。也就是说：这个默认值**在本机也已经指错了**，
  只是因为 `build-app.sh` 每次构建都把真实仓库根烘进 `Info.plist` 的 `MixrouterRepoRoot`
  （`scripts/build-app.sh:86`），所以从没被走到过。任务 3 要处理的就是它。
- 与之配对的是 `scripts/build-app.sh:19` 的 `BUNDLE_ID="com.<用户名>.mixrouter.app"`：**写死了用户名**。
  它不影响文件路径，但同样是"个人标识进了仓库"。
- `mixctl` 与 `launchd-run.sh` 都**没有**写死个人路径，它们靠 `__dirname` / `$HOME` 推导 ——
  这一点上它们比 Swift 外壳干净。

### 1.5 LaunchAgent plist（只读审计，不在四个文件内，但它是路径依赖的落点）

本机实装两份（读取，未改动）：

| 文件 | 引用的路径 |
|---|---|
| `~/Library/LaunchAgents/com.<用户名>.mixrouter.plist` | `ProgramArguments` → `<线上仓库根>/scripts/launchd-run.sh`；`WorkingDirectory` → 同目录；`StandardOut/ErrorPath` → `<src>/logs/launchd.log`；`EnvironmentVariables` 里 `MIXROUTER_ALT_PORTS=15721` 与五个 `MIXR_*_TIMEOUT_MS=900000`；**没有 `MIXR_DATA_DIR`**（⇒ 数据目录 = 代码目录） |
| `~/Library/LaunchAgents/com.<用户名>.mixrouter-log-retention.plist` | `ProgramArguments` → `/usr/local/bin/node <线上仓库根>/mixctl gc 2 --archives-only --apply`；`WorkingDirectory` → 同目录；**`MIXR_DATA_DIR` → 同目录**（显式等于代码目录）；`StartInterval=3600` |

两份 plist 里全是 `mixrouter-src` 的绝对路径 —— 这正是 §5.4 任务 1 要解开的东西：换发布目录要改
plist，而改 plist 要人记得路径。`scripts/install-macos.sh` 会把建议内容（数据目录与发布目录分离）
生成出来做差异对比，但**不落地**。

### 1.6 其他读路径的模块（审计补充，不在四个文件内）

任务 1 说"核对 `mixrouter.js`、`mixctl`、`scripts/launchd-run.sh`、`app/MixrouterApp.swift`
的实际读写路径"，但这四个文件并不拥有全部路径知识：`MIXR_DATA_DIR` 的真实语义定义在
`lib/backup/targets.js`，客户端配置另有两个模块各自拼过默认值。

| 位置 | 路径 | 环境变量 | 是否已有唯一来源 |
|---|---|---|---|
| `lib/backup/targets.js:67-73` | `LIVE_FILES`：`dataDir` / `claudeSettings` / `codexConfig` | `MIXR_DATA_DIR` / `MIXR_CLAUDE_SETTINGS` / `MIXR_CODEX_CONFIG` | **是**（既有真值，本轮复用） |
| `lib/zcode-config.js:12`（原） | `~/.zcode/v2/config.json` | `MIXR_ZCODE_CONFIG` | 否（本轮改为从 `paths` 取） |
| `lib/image-relay.js:14-17` | `INBOX`（`~/.claude/vision-inbox`）/ `VISION_HELPER` | `MIXR_IMAGE_INBOX` / `MIXR_VISION_HELPER` | 否（留在原处，见迁移点） |
| `lib/log-retention.js:161-163` | `MIXR_DATA_DIR \|\| process.cwd()` + `logs/`、`launchd.log`、`responses/` | `MIXR_DATA_DIR` | 否（**用的是 `process.cwd()`，不是 `__dirname`**，见下方"发现"） |
| `lib/http/console.js:319` | `backupTargets({ root: ROOT, home: homedir(), env })` | 同上 | 是 |
| `lib/codex-config.js:232/297/298` | 能力目录两文件落在 `dirname(config.toml)` 下 | 经 `MIXR_CODEX_CONFIG` | 是 |

**本轮审计里发现、但没改的既有问题**（见文末"未做"清单）：
`lib/log-retention.js:161` 的数据目录默认值是 `process.cwd()` 而不是 `__dirname`。这在
"launchd 以 `WorkingDirectory=<repo>` 启动"的前提下恰好等价，但用 `mixctl gc` 从别处调用、
或将来发布目录与工作目录分离时就会指错。本轮的 `lib/paths.js` 提供 `logDir(env, root)` 的正确形状，
但**没有改** `log-retention.js` —— 它有自己的 `options.directory` 显式参数路径，两个调用点
（`mixrouter.js:638`、`mixctl:626`）都显式传了目录，所以默认值那条线只有第三个未来调用方才会踩到。

---

## 二、三类路径的定义与理由

`lib/paths.js` 是唯一来源。三类：

| 类 | 函数 | 默认值 | 生命周期 |
|---|---|---|---|
| 开发副本 | `devRoot(env, root)` | `MIXR_DEV_ROOT \|\| root`（通常 `__dirname`） | 可写、可改、随时切分支 |
| 发布目录 | `releaseDir(releaseRoot, name)` | `<安装根>/releases/<版本>-<源码修订8位>`，`current` 符号链接指向其中一份 | 装好之后**不再改写** |
| 运行数据目录 | `runtimeDataDir(env, root)` | `MIXR_DATA_DIR \|\| root`（**现状，不改**） | 这台机器上唯一的用户状态 |
| 安装用的固定数据目录 | `fixedDataDir(env, home)` | `<安装根>/data`，**不看 `MIXR_DATA_DIR`** | 与代码分离，升级不换 |

`installPlan()` 把三者 + 端口 + 运行时文件位置一次算全，给 `scripts/install-macos.sh` 用；
**只算不建**。

### 为什么必须分三类，不能合并

合并的现状是"代码目录就是数据目录，LaunchAgent 也指着它"。三条后果都不是"看着乱"：

1. **代码与数据同目录 ⇒ 两个写者写同一份 `providers.json`。** 我们对它的写入是整份原子替换
   （`lib/atomic-write.js`），两个写者的结果是后写的赢，先写的那一份配置无声消失 ——
   日志里只有一次**成功**的原子替换，没有任何异常可查。规划 §5.4 的风险段说的"两个写入者"
   就是这条。
2. **发布目录可改 ⇒ "加载了哪个修订"只能靠 mtime 猜。** `codeRevision()` 的整套核对
   （`mixctl status`、控制台横幅、`RELEASE.json`）前提正是"同一份修订的字节不再变"。
   发布目录被就地改写之后，`code_revision` 相等也不再能证明客户端加载的是哪份代码。
3. **数据目录跟着代码走 ⇒ 回退旧代码时找不到用户数据。** 只能靠人记住路径 ——
   而 §5.4 的目标原文就是"安装、升级和回退**不依赖记住本机目录**"。

还有一条工程上的：**三类混在一起时"纯搬迁"不可能**。想把 `src/` 挪个地方，就得同时处理
`logs/`、`.run/`、`providers.json`、备份池和 plist；于是"搬家"永远变成"迁移 + 数据迁移 + 服务
切换"三件事绑在一起（这正是现状：本机 `mixrouter-src` 目录名与实际用途已经对不上）。

### 为什么 `runtimeDataDir` 与 `fixedDataDir` 是两个函数而不是两个环境变量

**没有第二个数据目录环境变量。** 搬迁的动作是给 LaunchAgent 显式设一次
`MIXR_DATA_DIR=<固定目录>`，此后两个函数指向同一处：

- `runtimeDataDir(env, root)` = **今天**运行中的服务去哪找数据，等价于现状 `MIXR_DATA_DIR || root`。
  线上已经按它跑着，改默认值等于让运行中的实例换个目录找 `providers.json`。
- `fixedDataDir(env, home)` = 新安装**建议**落地的固定目录，与代码分离，由 `HOME` 推导。
  它**刻意不看 `MIXR_DATA_DIR`** —— 否则一次继承来的环境变量就能把发布物/骨架指到线上数据目录去。

两者只在"这次要不要给 `MIXR_DATA_DIR` 赋值"上不同。这条设计由
`test/paths.test.js` 的「固定数据目录在 HOME 下，且**不看** `MIXR_DATA_DIR`」一例钉住。

---

## 三、本轮接上了哪几处

按"风险最低、最独立"选，只接了**两处**，都是等价搬迁（不改变任何行为）：

1. **`mixctl`（四行常量 + 一处）**：`RUN_DIR` / `PID_FILE` / `SERVER_LOG` / `REQ_LOG` 改为从
   `lib/paths.js` 取；`mixctl:626` 第三次拼的 `MIXR_DATA_DIR || ROOT` 一并收拢进
   `paths.logDir()`；`LAUNCHD_DIR` 收进 `paths.launchAgentDir()`。
   **为什么选它**：`mixctl` 是这三个"重复拼接"里**唯一同时拥有全部三份知识**的文件之一
   （另外两个是 `launchd-run.sh` 和 `mixrouter.js`），而它自己**不是常驻进程** —— 改错了重启
   `mixctl` 就退回去，不涉及在途请求。等价性由 `test/paths.test.js` 的
   「mixctl 从 paths 取到的四个路径与改动前逐字相同」+ 既有 `test/mixctl.test.js`（含
   「不设环境变量时清点用的默认路径与主文件读写的是同一份计算」那条默认值分支断言）双侧钉住。
2. **`lib/zcode-config.js`**：zcode 配置默认路径从 `paths.zcodeConfig()` 取。
   **为什么选它**：这是审计里**唯一一处"默认值写在别处、没有中心来源"的客户端配置** ——
   claude/codex 两项早已在 `LIVE_FILES`，只有 zcode 还在自己拼。而且它是一个 200 行的独立
   模块，`configPath()` 本来就是**每次现读环境变量**的函数式写法（不是加载期常量），
   换成转发 `paths` 之后语义完全不变（`test/paths.test.js` 的
   「zcode 默认路径与 lib/zcode-config.js 原本的默认值逐字相同」+ 既有 `test/zcode.test.js`
   双证）。

**为什么没接 `scripts/launchd-run.sh`（本来选中的第二个候选）**：它是一个 16 行的 POSIX `sh`
脚本，没有 JS 运行时，要用 `lib/paths.js` 就只能 shell 调 `node -e`，把一个本来零依赖、
零延迟、launchd 冷启动路径上的脚本变成"必须先起来一个 node 才能知道路径"。收益（消掉一行
`$DIR/.run` 的重复）远小于代价（给启动路径加一道进程）。**保留现状**，列进迁移点。

**为什么一处 `mixrouter.js` 都没接**：它的三个常量已经在用 `LIVE_FILES`（上一轮已收拢过），
本次能接的只是 `PROVIDERS_FILE`/`ROUTES_FILE`/`LOG_FILE`/`PUBLIC_DIR` 这几个
`path.join(DATA_DIR, …)`。这些是**加载期常量**（`const`，在模块顶部，测试靠
"先设 `MIXR_DATA_DIR` 再 require"来注入），改成 `paths.xxx(process.env, ROOT)` 之后形状不同、
需要逐个核对约 30 个测试文件的注入时序。收益是"少一层 `path.join`"，风险是"测试注入点移位" ——
不值得在这一轮做。规划 §5.4 也明确本期只要求"引入集中定义"。

---

## 四、后续可迁移点清单

按"收益 / 风险"排序。每一条都注明了本轮为什么没做。

| # | 位置 | 迁移到 | 收益 | 本轮未做的原因 |
|---|---|---|---|---|
| 1 | `mixrouter.js:96/97/98/102/183/185` | `paths.providersFile(env,root)` 等 | 消掉六个 `path.join(DATA_DIR, …)` | 加载期常量，改形状要动约 30 个测试文件的注入时序 |
| 2 | `scripts/launchd-run.sh:13-14` | 由 `mixctl start` 或一个共享 shell 片段提供 | 消掉 `.run/mixrouter.pid` 的第二次拼接 | 会让零依赖的启动脚本依赖 node（见上） |
| 3 | `lib/log-retention.js:161` | `paths.logDir(env, root)`，并把 `process.cwd()` 换成显式 root | 消掉"用 cwd 推数据目录"这条隐性依赖 | 两个现存调用点都显式传了 `directory`，默认值这条线当前无人踩；改动会碰 `log-retention` 的既有测试 |
| 4 | `lib/image-relay.js:14-17` | `paths` 里加 `imageInbox(env, home)` / `visionHelper(env, home)` | 把"视觉中继的文件落点"也纳入三类路径 | 它有自己的 `~/` 展开逻辑与 `path.resolve` 归一，语义比其余几项复杂；且 `test/image-relay.test.js` 有 20+ 例盯着 INBOX 的解析规则 |
| 5 | `scripts/build-app.sh:18-19`（`APP_BUNDLE` + `BUNDLE_ID="com.<用户名>.mixrouter.app"`） | `BUNDLE_ID` 去掉用户名 | **任务 3** | 属任务 3 范围（解除个人路径/标识依赖） |
| 6 | `app/MixrouterApp.swift:22` | 去掉 `<旧个人源码目录>/mixrouter` 默认值，改为明确报错 | **任务 3** | 同上；本轮只标注 |
| 7 | `lib/http/console.js:319`、`mixctl:475`、`mixctl:728` | 复用 `paths` 里的 `home`/`root` 取值 | 消掉 `os.homedir()` 的三处直接调用 | 它们经 `backupTargets({home})` 已经收敛到一处，再收一层收益很小 |
| 8 | 两份 LaunchAgent plist | 由 `install-macos.sh` 生成（建议内容已生成，未落地） | 换发布目录不再需要手改 plist | 需要在线运行授权，本轮无 |
| 9 | `lib/paths.js` 的 `RELEASE_ITEMS` 与 `scripts/release-manifest.js` 的 `INCLUDE` | 让安装脚本从 manifest 取清单 | 消掉"该进发布物的有哪些"的第二份列表 | 见下 |

**第 9 条要特别说明：本轮出现了一份**平行的**清单，但**不是**重复。**
`scripts/release-manifest.js`（**任务 4 的交付物，由另一个并行分支新增**）定义的是
**发布 tarball** 里有哪条相对路径；本轮的 `lib/paths.js:RELEASE_ITEMS` 定义的是
**安装脚本往本地发布目录复制**哪些条目。两者有几处**有意**不同：

- tarball 逐文件列 `scripts/*`（只进用户工具），安装脚本整目录复制 `scripts/`（本地安装
  连开发脚本一起带上是可接受的，且发布目录的 `launchd/` 还要往那儿放建议 plist）。
- tarball 只列 `docs/offline-run-and-acceptance.md`，安装脚本整目录复制 `docs/`。
- 两者**共有**的硬底线一致：`providers.json` / `routes.json` / `sessions.json` /
  `slots.json` / `logs/` / `backups/` / `.run/` 一律不进（两边各有一份禁止清单，
  且各自有断言；`test/paths.test.js` 断言 `RELEASE_ITEMS` 与 `FORBIDDEN_IN_RELEASE` 不重叠）。

**建议后续加一条一对一的守卫**：断言 `release-manifest.js` 的 `INCLUDE` 里每条路径，
都落在 `RELEASE_ITEMS` 的某一条目之下（"能发布的必定能安装"）。本轮**没有加**：
那会让本文件依赖另一个并行分支正在写的模块，两个分支互相绊住。这条守卫属任务 4 的收尾，
或第四期合流之后。

---

## 五、`scripts/install-macos.sh`：使用方式与它明确不做的事

### 用法

```bash
scripts/install-macos.sh                 # 干跑(默认):只显示计划,不写任何文件
scripts/install-macos.sh --apply --yes   # 真正写入发布目录与数据目录骨架
scripts/install-macos.sh --help
```

| 选项 | 作用 |
|---|---|
| `--dry-run` | 干跑，**默认行为** |
| `--apply` | 真正写入；非交互时必须同时给 `--yes` |
| `--yes` | 非交互确认。stdin 不是终端时**没有它就是硬失败**，不会挂住等输入 |
| `--prefix DIR` | 安装根，默认 `$HOME/.local/share/mixrouter`（其下 `releases/` `data/` `backups/`） |
| `--release NAME` | 发布目录名，默认 `<版本>-<源码修订前8位>` |
| `--source DIR` | 源码来源，默认本脚本所在仓库 |
| `--port N` / `--ui-port N` | 端口，默认 8787 / 8788（值来自 `lib/paths.js` 的 `DEFAULT_PORTS`） |

**先显示、再执行**：干跑与 `--apply` 都会先把「开发副本 / 安装根 / 发布目录 / current /
运行数据目录 / 日志目录 / 备份位置 / 端口 / 发布内容白名单 / 发布物禁止项」和「写入范围（恰好
四处）」打印出来，再把**建议的 LaunchAgent 与现状的 diff** 打印出来，然后才动手。`--apply`
动笔之前还有一次 `[y/N]` 确认（除给了 `--yes`）。

**幂等**：重复运行不覆盖。
- 发布目录已存在且与源码一致 ⇒ 报告"跳过复制"，一个字节不写（`test/install-script.test.js`
  用 mtime + 全树快照证明它没有"重新复制了一遍恰好一样的内容"）。
- 发布目录已存在但内容不同 ⇒ **拒绝覆盖并非 0 退出**，提示改用 `--release` 换个名字。
- 数据目录里的 `providers.json`/`routes.json`/`slots.json`/`sessions.json` 一律**只建目录、不读、
  不写、不备份**（测试预置四份文件，跑完断言逐字节未变）。

**三条硬失败**（都以非 0 退出码结束，都打印中文原因）：
1. node 缺失、或主版本低于 `package.json` 的 `engines`（`>=N` 由 sed 从 package.json 解出，
   不写死）。
2. 发布目录 / 数据目录 / 备份目录的**最邻近已存在祖先**不可写（不为"测一下能不能写"而先把目录
   建出来 —— 干跑绝不许留下痕迹）。
3. 代理端口或控制台端口已被占用（`lsof` 优先，退到 `nc`，再退到 node 兜底）。

**发布物白名单与自检**：按 `lib/paths.js` 的 `RELEASE_ITEMS` 复制（`rsync -a --relative`），
复制完再逐条核 `FORBIDDEN_IN_RELEASE` —— 出现 `providers.json` / `routes.json` / `slots.json` /
`sessions.json` / `logs` / `backups` / `.run` / `.git` / `.env` / `node_modules` 任一即失败。
判据是**清单**而不是"复制过程没带过来"：将来有人往白名单里加错一项，这里会当场拦住。

**写盘范围**（正好四处）：发布目录、数据目录与日志目录（只建目录）、备份目录（只建目录）、
`current` 符号链接。半路失败不留半个发布目录（先写带 pid 的暂存名，整份就绪后再改名；
失败时只删自己建的那一个暂存目录）。

### 它明确不做的事

- **不执行任何服务管理命令**：不装载、不卸载、不重启、不重新拉起服务。脚本里没有任何
  `launchctl` 调用（`test/install-script.test.js` 有静态断言盯着**可执行行**，注释里那句
  "不执行 launchctl bootstrap" 不算命中）。
- **不写入 `~/Library/LaunchAgents`**：只读出现有 `*.mixrouter.plist` 做差异对比；建议内容
  生成在一个临时文件里，打印完就删，另存一份到**发布目录**的 `launchd/` 下（那是发布内容，
  不是本机服务状态）。
- **不改客户端配置**：`~/.claude/settings.json`、`~/.codex/config.toml`、
  `~/.zcode/v2/config.json` 三个路径在计划里打印出来，明确标为"本脚本不写入"。
- **不碰运行数据**：不读、不写、不备份数据目录里的任何文件。
- **不写死个人绝对路径**：所有路径都经 `$HOME` 或 `lib/paths.js` 推导。测试断言"输出里的
  `<绝对路径>` 只能是调用方给的 HOME 或源码目录"。
- **脚本开发完成不等于已获得在线运行授权。** 这一点写在脚本头注释与 `--help` 里，
  并由测试断言它没被删掉。

### 一个实现上的坑（写下来免得被"优化"回去）

**bash 3.2 下 `$VAR` 后面紧跟中文字符会被当成变量名的一部分**，`set -u` 当场报
`unbound variable`，而且报出来的名字带一个乱码字节。macOS 自带的 `/bin/bash` 就是 3.2。所以
`"…>= $REQUIRED_MAJOR。请先升级…"` 必须写成 `"…>= ${REQUIRED_MAJOR}。请先升级…"`。
本文件里有两处这样的位置，都用了花括号。本仓库另有同类教训。

---

## 六、未验证范围

**没做的事，以及为什么**：

1. **没有在真实 HOME 跑过 `scripts/install-macos.sh`。** 全部 17 例都在 `mkdtemp` 出来的临时
   HOME + 临时安装根 + 临时端口里跑。本任务明确禁止对真实 HOME 执行安装。
   ⇒ 「在真实 `$HOME/.local/share` 下装一遍」**未验证**。
2. **没有验证真实 LaunchAgent 的切换。** 本机两份 plist（`com.<用户名>.mixrouter`、
   `com.<用户名>.mixrouter-log-retention`）只被**读取**过，用于审计表与差异对比的样例。
   没有 `bootstrap` / `bootout` / `kickstart`，脚本里也没有这些调用。
   ⇒ 「按建议 plist 切换服务、`mixctl status` 报新修订」**未验证**；这需要在线运行授权。
3. **没有验证"用固定 `MIXR_DATA_DIR` 启动的新实例能读到旧数据"。** 迁移动作（给 plist 设
   `MIXR_DATA_DIR=<固定目录>` 并把现有数据搬过去）本轮完全没有执行 —— 数据目录里的文件被
   规则禁止触碰。`test/install-script.test.js` 只证明了"脚本不去动已存在的配置文件"。
   ⇒ 「升级后实例仍能读到升级前的 providers/routes/slots/sessions」**未验证**。
4. **没有跑全量测试。** 本任务明确禁止（会与并行改动互相污染）。只跑了与本轮相关的一组：
   `test/install-script.test.js test/paths.test.js test/mixctl.test.js test/backup-cli.test.js
   test/zcode.test.js test/modules-wiring.test.js test/slots-module.test.js test/backup-restore.test.js`
   → **172/172 通过**（见交付说明）。与路径无关的套件（`test/ui.test.js`、
   `test/session-routing-ui.test.js`、`test/static-assets.test.js` 等并行改动中的文件）**未运行**。
5. **没有 shellcheck。** 本机未安装，按要求没有去装。`bash -n` 通过（语法检查），
   但 shellcheck 级别的检查（引号、未用变量、`local` 语义等）**未做**。
6. **没有验证性能/规模。** 发布目录约 **2.0 MiB**（`lib/` 864K、`app/` 320K（含 300K 的
   `appicon.icns`）、`docs/` 320K、`public/` 196K、`scripts/` 116K、`mixrouter.js` 88K），
   `rsync` 一次复制在本机是亚秒级。没有测更大仓库或网络盘上的行为。
7. **`--source` 指向非本仓库时的行为未验证。** 脚本要求 `--source` 里有 `package.json` 与
   `lib/paths.js`，但只测过"默认 = 本脚本所在仓库"。跨目录安装（例如从解包出的 tarball 装）
   **未验证** —— 那属于任务 4（制品清单）与任务 6（独立 HOME 演练）。
8. **端口探测在"端口被 TIME_WAIT 占着"或"只被 UDP 占用"时未验证。** 测的是 TCP LISTEN
   （`lsof -sTCP:LISTEN`）与 `nc -z`。SO_REUSEADDR 场景下 `nc -z` 可能报"空闲"而实际
   绑不上，此时会留到服务真正启动才失败。
9. **`RELEASE.json` 的 `code_revision` 与运行实例自报的修订"相等"这件事未验证。** 两边用的是
   同一个函数（`lib/runtime-code.js` 的 `codeRevision`），`test/install-script.test.js` 断言了
   它就是 64 位 sha256 字符串；但没有起一个从发布目录运行的实例，去比对 `mixctl status` 报出的值。

---

## 七、本轮发现但没改的问题

按"只报可执行的"整理：

1. **`lib/log-retention.js:161` 用 `process.cwd()` 当数据目录默认值。** 详见 §1.6。当前两个
   调用点都显式传目录，所以是**潜在**问题，不是现行故障。已在迁移点清单里。
2. **`scripts/build-app.sh:19` 的 `BUNDLE_ID="com.<用户名>.mixrouter.app"` 写死用户名。**
   不影响路径，但属任务 3 范围。
3. **`app/MixrouterApp.swift:22` 的默认仓库根 `~/<旧个人源码目录>/mixrouter` 在本机已经指错**
   （实际是 `mixrouter-src`），只因 `Info.plist` 每次构建都覆盖才没暴露。属任务 3。
4. **`.gitignore:28` 的 `/backups/` 是"归档的历史备份"，与 `lib/backup/*` 的"备份池"是两个不同
   概念，用同一个词。** 本轮 `lib/paths.js` 新增的 `backupRoot()` 指的是**安装根的 `backups/`**
   （第三种含义：客户端配置/渠道库的受限副本，规划 §6.1.3）。三个"backups"含义不同，
   本文件在注释里点明了，但**没有改名**（改名会牵连 `.gitignore` 与文档，且不影响正确性）。
5. **`README.md:247-262` 的「常驻」一节仍按"仓库目录 = 运行目录"写**（plist 指向
   `<repo>/scripts/launchd-run.sh`，数据目录隐含就是仓库）。本轮没有改 README ——
   §5.4 任务 5 才是文档整理，且现在改会与并行进行的第三期文档改动冲突。
6. **`.run/` 没有任何测试覆盖。** 全仓 `grep` 只在 `mixctl`（`28-29` / `278` / `299` / `308`）、
   `scripts/launchd-run.sh:13-14` 与 `mixrouter.js:1274` 的注释里出现。
   `test/` 里没有一个用例碰 `.run/mixrouter.pid` —— 也就是说"`launchd-run.sh` 写下的 pid 与
   `mixctl` 读的是同一个文件"这条约定**目前只靠代码看着对**，没有回归。本轮把两边的拼接
   收进了 `lib/paths.js`（`runDir`/`pidFile`），但**没有补这条回归**：它需要起一个真实的
   launchd 或至少跑一次 `launchd-run.sh`，那是任务 6（独立 HOME 演练）的范围。

---

## 八、本轮实际跑过的命令与结果

```
$ node scripts/run-tests.js test/install-script.test.js
ℹ tests 17
ℹ pass 17
ℹ fail 0

$ node scripts/run-tests.js test/paths.test.js
ℹ tests 17
ℹ pass 17
ℹ fail 0

$ node scripts/run-tests.js test/install-script.test.js test/paths.test.js test/mixctl.test.js \
    test/backup-cli.test.js test/zcode.test.js test/modules-wiring.test.js \
    test/slots-module.test.js test/backup-restore.test.js
ℹ tests 172
ℹ pass 172
ℹ fail 0

$ bash -n scripts/install-macos.sh        # 通过
$ node --check lib/paths.js mixctl lib/zcode-config.js   # 通过
$ plutil -lint <临时 HOME 里生成的建议 plist>   # OK
$ command -v shellcheck                    # 未安装(按指示跳过)
```

人工干跑与 `--apply` 各在**临时 HOME**（`mktemp -d`）里试过一遍，试完删除，
真实 `$HOME` 未被写入。
