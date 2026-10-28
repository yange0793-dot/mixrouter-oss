# 升级与回退

这份文档讲的是**换代码版本**。把它和"改配置"分开看:改配置在控制台里做,换版本是文件系统
与进程的事。

**先说清三件没有的东西**:

1. **没有后台自动更新。** `scripts/upgrade-release.js` 只在人显式运行时做一次升级,
   失败时会尝试回退 `current` 并恢复旧服务;它不是常驻监控,也不能阻止外部改动。
2. **持久格式没有"拒绝读取"的版本闸门。** `providers.json` / `routes.json` / `slots.json` /
   `sessions.json` 里写着 `version` 字段,但读取侧只做形状归一化,不校验它。
   没有自动机制能阻止旧版读新版写出的数据;回退前必须人工核对兼容性。
3. **没有签名/公证或 Windows/Linux 安装制品。** 新工具会核对官方 Release 的 SHA-256、
   解包路径与制品清单,但校验和不等于代码签名。`scripts/install-macos.sh` 是 macOS 上的
   源码复制工具,`app/MixrouterApp.swift` 是实验性桌面外壳。

---

## 受控工具:check-update / upgrade-release / service

三个脚本都随运行包发布,只用 Node 内置模块与系统 `tar`。**默认都是预览**:
`check-update.js` 默认不联网,`upgrade-release.js` 默认不联网、不写文件,
`service.js` 默认只读状态。

### 1. 看本机状态(不联网)

```bash
node scripts/check-update.js
node scripts/service.js status
```

前者报告 `current`、版本、源码指纹与发布目录数量;后者额外列出运行中的 pid
(只在命令行确认属于该发布目录时才标为"属于")和登录服务指向的目录。
两者都不写文件。

### 2. 预览升级

离线归档(校验和必须与包同目录,或显式 `--sha256`):

```bash
node scripts/upgrade-release.js --archive /path/mixrouter-3.9.1.tar.gz --version 3.9.1
```

在线获取(必须显式 `--download`;仓库固定为 `yange0793-dot/mixrouter-oss`):

```bash
node scripts/check-update.js --check
node scripts/upgrade-release.js --version 3.9.1 --download
```

预览会打印:当前版本 → 目标版本、归档来源与校验和、制品文件数、现算的
`code_revision`、数据目录(只读检查结果)、运行中的实例、登录服务处理方式与回退策略。
**预览不写安装根、不碰数据目录、不启动或停止服务。**

### 3. 执行

```bash
node scripts/upgrade-release.js --archive /path/mixrouter-3.9.1.tar.gz --version 3.9.1 --apply --yes
# 或
node scripts/upgrade-release.js --version 3.9.1 --download --apply --yes
```

非交互环境 `--apply` 必须同时给 `--yes`,否则当场中止。

执行顺序与判据:

1. **校验来源**:SHA-256(在线时还核对 GitHub `digest` 与 `.sha256` 附件)、解包成员
   不允许绝对路径/`..`/符号链接/硬链接、制品清单、`package.json` 与入口 `VERSION`
   与 `RELEASE-INFO.json` 三处版本一致、包内现算的源码指纹与声明值一致。
2. **预检**:拒绝降级与同版本安装(除非 `--allow-same`)、拒绝 Node 低于目标
   `engines`、拒绝任何不属于当前 `current` 的运行实例、拒绝会指向旧代码的登录服务。
   数据目录只读解析 `providers.json` / `routes.json` / `slots.json` / `sessions.json`;
   解析失败直接中止:本工具不改写数据,也不提供跳过该检查的开关,先人工处理再升级。
3. **停止**:先观察 `active_requests`,**等到归零**才发 SIGTERM。持续有新请求时计数不会
   归零 —— 排空在 `--drain-timeout`(默认 30s)内没结束就**中止升级**:不停止服务、
   不切换代码、不打断任何在途请求。工具没有"杀掉在途请求再宣布成功"的开关。
   只停归属可确认的 pid(命令行、pid 文件与进程启动时间、或服务自报的 pid + 指纹);
   退出超时同样中止,不自动 SIGKILL。
4. **安装**:解包已校验的目录复制到 `releases/<版本>-<指纹>`,写 `RELEASE.json`,
   再原子切换 `releases/current`。发布目录不可变,已存在同名目录直接拒绝。
5. **启动与核对**:有托管登录服务时重写 plist 并重新 bootstrap;否则直接派生
   `node <新发布目录>/mixrouter.js`(不经过 `mixctl start`,避免它去 kickstart
   一个不确定的 LaunchAgent label)。随后轮询 `/api/state`,必须返回目标
   `code_revision`;只看到 `/healthz` 200 不算成功。
6. **失败回退**:切回旧 `current`,重新启动旧版本并核对旧指纹。回退成功、回退切换失败、
   回退后旧服务仍不可用,会分别报告并给出新旧目录路径;不会删除任何发布目录。

### 4. 停止或卸载登录服务

```bash
node scripts/service.js stop        # launchctl bootout 当前托管 label
node scripts/service.js restart
node scripts/service.js uninstall   # 预览;--apply --yes --unload 才删除并卸载
```

`service.js` 只认带 `mixrouter-managed` 标记、且 label 落在 `com.<用户名>.mixrouter.managed`
命名空间的 plist。install-macos.sh / 旧 mixctl 的 `com.<用户名>.mixrouter` 与任何手写配置
都不会被覆盖、删除或接管;升级工具在它指向当前目录时会拒绝继续,并要求先按原方式停用它。

### 5. 显式回退到某个发布目录

```bash
node scripts/upgrade-release.js --rollback-to /path/to/releases/3.9.0-abcdef12
node scripts/upgrade-release.js --rollback-to /path/to/releases/3.9.0-abcdef12 --apply --yes
```

同样先停服务、切 `current`、启动并核对目标目录的 `code_revision`;失败会尽量恢复到
回退前的 `current` 并如实报告。**它不检查数据格式兼容性** —— 下面第 3 节的人工核对
仍然适用。

### 数据目录

工具只读取数据目录做检查,**不写、不迁移、不备份**。需要备份时请自己在执行前完成
(第 7 节清单)。固定数据目录的优先级:`--data-dir` > 托管登录服务 plist >
当前发布目录的 `RELEASE.json` > `MIXR_DATA_DIR` > `~/.local/share/mixrouter/data`。

---

## 新入口的下载包升级(手工路径)

`npm run local` 默认采用固定数据目录 `~/.local/share/mixrouter/data`。
升级时将新版包解压到**新的空目录**,先在新版目录执行 `npm run doctor -- --offline` 与
`npm run smoke`,通过后在旧版终端按 Ctrl+C 并等待退出,备份原数据目录,再从新版目录运行
`npm run local`。若使用了 `--data-dir` / 自定义端口,新版也必须传相同参数。
完成后再跑 `npm run doctor`,确认服务加载的是新版源码。

回退时同样先停止新版,保留并核对数据兼容性,再从保留的旧版目录启动。
不把旧数据备份覆盖到后来更新的数据上,也不允许两个版本同时写同一目录。
这是**手动升级**的可靠起点,不是自动更新或一键回退。

`local` 的启动预检会拒绝已知配置文件中比本版更新的 `version`,但仅核对 JSON 与顶层结构,
不是完整的迁移或兼容性证明。旧版 `npm start` / `mixctl` 的读取行为没有改变,
下面关于旧入口与数据格式的边界仍然适用。

## 1. 三个目录:代码、安装根、数据

| 概念 | 默认值 | 说明 |
| --- | --- | --- |
| 代码目录 | 你 clone 的位置 | 运行 `node mixrouter.js` / `./mixctl` 时所在目录 |
| 安装根 | `~/.local/share/mixrouter`(`MIXR_INSTALL_PREFIX` 可覆盖) | `scripts/install-macos.sh` 的落点 |
| 运行数据目录 | `MIXR_DATA_DIR`,未设时 = **代码目录** | `providers.json` / `routes.json` / `slots.json` / `sessions.json` / `logs/` |

**最重要的一条**:数据目录默认跟着代码目录走。所以在换代码之前,先确认**现有数据在哪**,
让它在新代码下仍然指向**同一个目录**:

```bash
# 1) 找出当前实际用的数据目录:设了 MIXR_DATA_DIR 就是它,否则就是当前代码目录
echo "${MIXR_DATA_DIR:-$PWD}"
./mixctl backups          # 顺带确认 providers.json 等三处备份池能读到
```

- **已有数据**:把 `MIXR_DATA_DIR` 显式设为上面那个**已有的**目录,不要新建一个空目录。
  它必须出现在**运行服务的那个进程**的环境里(前台启动是当前 shell,常驻则写进
  LaunchAgent 的 `EnvironmentVariables`)。`mixctl` 读同一个变量;设了之后
  `node mixrouter.js`、`./mixctl start` 与 `./mixctl backups` 看到的是同一份数据。
- **不要**为了升级顺手 `export MIXR_DATA_DIR=<一个新路径>`:那会让服务按空库启动,
  看起来像"配置全没了"。
- **真要迁移数据目录**:先停服务,再**完整复制**旧目录(含 `providers.json` / `routes.json` /
  `slots.json` / `sessions.json` / `logs/` 与客户端配置备份),把副本放到新位置、
  核对可读后再固定新路径启动。迁移期间不要两个进程同时写两份目录。

数据目录是这台机器上唯一需要备份的用户状态:`mixctl backups` 管的是其中三处
(`providers.json`、Claude `settings.json`、Codex `config.toml`),
整个数据目录另做文件系统备份更稳妥。`logs/` 与 `responses/` 可以不带。

---

## 2. 源码升级(推荐路径)

核心服务只依赖 Node 内置模块,升级就是换一份源码 + 重启进程。**没有构建、没有 install。**

顺序很重要:**先停旧进程,再换工作区里的代码**。代码与 `public/` 是同一个工作树,
`git checkout` 会同时换掉后端与静态资源;正在运行的服务若在读这些文件,可能读到新旧混合
的文件(静态资源甚至会白屏)。所以不要"先 checkout、再停旧进程"。

```bash
# 0) 确认数据目录:已有数据就设到现有目录(见上一节)
export MIXR_DATA_DIR="/已有数据的绝对路径"
./mixctl status
./mixctl backups             # 核对三处备份池可读

# 1) 只取对象,不动工作树(此时服务仍在跑)
git fetch --tags

# 2) 空闲窗口中停止旧进程,等它完全退出(会落盘会话与槽位)
./mixctl stop
./mixctl status              # 必须显示「未运行」
#    前台 `npm start` 起的没有 pid 文件,用 Ctrl+C 停,等到进程真正退出
#    确认无写入者后,把现有数据目录完整备份到仓库外;客户端配置与备份另存
#    备份失败或无法核对时,不要换代码

# 3) 换代码(后端与 public/ 同时切换)
git checkout v3.6.1          # 或目标提交
node --version               # 22 / 24 推荐,最低 18

# 4) 在新代码上验证
npm test
npm run smoke

# 5) 启动
./mixctl start
./mixctl status              # 「代码」行必须显示「已加载当前源码」

# 6) 控制台与代理自检
curl --fail http://127.0.0.1:8787/healthz
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/
```

几条纪律:

- **不要让两个版本同时写同一个数据目录。** 对 `providers.json` 的写入是整份原子替换,
  两个写者 = 后写的赢,先写的那份配置会无声消失。旧进程确认退出前,不要启动新进程。
- **`/healthz` 回 200 不能当作升级成功的证据**——它只说明进程活着。判据是
  `./mixctl status` 的「代码」行;它比服务启动时记下的 `code_revision` 与磁盘源码的 SHA-256,
  不一致或无法核对时退出码为 1。
- 代码修改不会热加载。`git checkout` 之后不重启,跑的还是旧进程。
- 在 `npm test` / `npm run smoke` 里失败就不要往下走;它们不碰真实配置,失败不会留下脏状态。
- 如果是用 launchd 常驻:先 `./mixctl stop`(正常退出不会被 `KeepAlive` 拉起),
  再在**同一个**代码目录启动,`launchd-run.sh` 与 `mixctl` 认的是同一个 pid 文件。

**回滚到升级前**同样先停服务,再 `git checkout` 换回旧 tag,然后验证与启动;
数据目录一个字节不动。

---

## 3. 回退

```bash
# 1) 先停服务(前台启动则 Ctrl+C,等到进程退出)
./mixctl stop
./mixctl status              # 必须显示「未运行」

# 2) 只取对象,再换回旧代码(后端与 public/ 一起切)
git fetch --tags
git checkout <旧 tag 或提交>

# 3) 验证并启动
npm test && npm run smoke
./mixctl start
./mixctl status              # 「代码」行应与预期的 code_revision 一致
```

### ⚠ 数据格式没有版本闸门,不能盲目回退

- 若升级**没有改变** `providers.json` / `routes.json` / `sessions.json` / `slots.json`
  的结构,旧代码可以直接沿用现有数据。
- **若曾用更新版本改写过这些文件**,回退前先备份并确认旧代码能解析。两个只读工具:

  ```bash
  ./mixctl backups                          # 三处备份池与保留上限
  ./mixctl backups --diff <备份名>           # 预览一份备份与现役文件的差异(值已脱敏)
  ```

  解析不了就**停止回退并保留现场**,不要用旧快照覆盖用户后来保存的新设置。
- 回退前把整个数据目录复制一份(`cp -a`)。出了问题时你能原样放回去,而不是靠记忆重建。
- **`routes.json` 的语义变窄了**:这一版只用它承载压缩设置,旧的 `rules` / `default`
  字段留在盘上但**不再执行**,启动只读不写、不删文件。但它仍是活配置:保存压缩设置或
  服务正常退出时会用归一化结果整体重写,已废弃的条件字段与顶层 `default` 不会写回。
  从旧版本升级上来时,原来靠通用规则做分流会失效——升级前先复制整个数据目录,
  并把需要的落点改成槽位别名或精确登记模型名。反过来退回旧版本时,
  那份历史规则会被旧代码重新当作规则读入,回退前先确认你接受这个后果。

`mixctl restore` 是**配置备份还原**,不是版本回退工具,别拿它当回退手段。它的边界见
[参考手册 §9](reference.md#9-备份与还原)。

---

## 4. 把客户端恢复成原来的配置

路由器只在两个地方碰客户端:`~/.claude/settings.json` 与 `~/.codex/config.toml`。
每次写入前都会在同目录留一份 `.bak-mixui-<时间戳>-<随机>` 备份。
旧的 ZCode 接入已移除,`~/.zcode/v2/config.json` 不再由本项目读写。

### 用备份恢复(推荐)

```bash
./mixctl backups                                  # 先列出备份,复制你要的那份的完整名字
./mixctl restore <备份名>                          # 默认只预览,不写文件
./mixctl restore <备份名> --yes                    # 预览无误后执行
```

- 先停掉对应客户端与路由器,恢复成功后再启动。
- 恢复只接受受管文件原目录里的 `.bak-mixui-*`,拒绝链接、目录与超过 512KiB 的文件;
  写入前另存安全备份,原子替换,**不会自动重启任何进程**。
- TOML 只接受普通表、单行字符串、布尔与十进制数;其他合法语法报 `unsupported_toml`。
  这是拒绝自动恢复,不是判定配置损坏。

### 手工恢复

- **Claude Code**:把 `settings.json` 的 `env` 里 `ANTHROPIC_BASE_URL` /
  `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` 与四个槽位键
  (`ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` /
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL`)改回原值。
  `mixr-*` 形态的值是路由器写的别名,直连上游不能留。
- **Codex**:删掉 `[model_providers.mixr-*]` section,把顶层 `model_provider` 改回原来的值,
  `model` 改回原来的模型名。用户自己的 section 一直没被改动。
- **ZCode(仅旧版本写过)**:这一版不再触碰 `~/.zcode/v2/config.json`。若你以前用过
  ZCode 接入,旧版本写过的条目是 `provider` 对象下 `id` 为 `mixrouter-managed` 的那一个;
  删掉它,或整份恢复到备份。本版不会自动清理它。
- 恢复后重启客户端。正在跑的会话不会热读新配置。

如果原来的客户端配置里本来就指向别的本地代理,恢复的是那份配置——路由器不会猜
"你原本想直连哪一家"。

---

## 5. 安装脚本与桌面外壳的边界

### `scripts/install-macos.sh`(可选,实验性)

它做两件事:把源码复制进一个不可变发布目录,并把建议的服务配置写到该目录的 `launchd/` 下
供你对比。它**不**执行服务管理命令、不写 `~/Library/LaunchAgents`、不改任何客户端配置、
不碰数据目录里的配置文件。

```bash
scripts/install-macos.sh                 # 默认干跑:只显示计划
scripts/install-macos.sh --apply --yes   # 真正写入
```

已知限制,不要按想象操作:

- 它会更新 `<安装根>/releases/current` 这个符号链接,但**当前没有任何运行入口跟着这个链接
  走**。`mixctl` 以自身所在目录为根,`scripts/launchd-run.sh` 以脚本所在目录为根,
  生成的服务配置也把发布目录的**绝对路径**写死在 `ProgramArguments` 与
  `WorkingDirectory` 里。所以「切 `current` 就完成升级」**不成立**;
  桌面外壳(`app/MixrouterApp.swift`)会读 `releases/current`,那是它自己的定位方式。
- 重复运行不会覆盖已存在的发布目录:内容一致就跳过,不一致直接拒绝。
- 装完之后服务仍然要你自己启动,数据目录仍然要你自己用 `MIXR_DATA_DIR` 固定。
- 需要常驻时另用 `node scripts/service.js install --apply --yes` 写入**带标记的**托管
  LaunchAgent;它不会接管 install-macos.sh 只放在 `launchd/` 下的建议文件。
- 它不校验升级后的数据结构兼容性,也不提供回退。

### 桌面外壳(可选,实验性)

`app/MixrouterApp.swift` + `scripts/build-app.sh` 把控制台包成原生 macOS 窗口,
需要 macOS 与 CommandLineTools。它只显示与遥控,不管服务生命周期:
已经在跑就只加载页面,不重启。它不是安装路径,用浏览器开
`http://127.0.0.1:8788` 功能一样。

---

## 6. 发布物与校验(维护者)

推 `v*` tag 触发 Release 工作流。它先跑 `npm test` 与 `npm run smoke`,均通过后才打包。
制品只来自显式清单(`scripts/release-manifest.js`),解包后还能用同一份清单复核:

```bash
node scripts/release-manifest.js paths                  # 打印要打包的文件路径
node scripts/release-manifest.js check <解包目录>        # 静态校验制品内容
npm run verify:release -- --dir <解包目录>              # 执行可信制品里的离线自检与 smoke
node scripts/release-manifest.js release-info --version <v> --revision <40位sha> [--code-revision <64位哈希>]
```

| 名字 | 是什么 | 怎么核对 |
| --- | --- | --- |
| `version` | `package.json` 的 `version` | `./mixctl status` 的「版本」行 |
| `revision` | `git rev-parse HEAD` | `RELEASE-INFO.json` / Release 正文 |
| `code_revision` | `lib/runtime-code.js` 的 `codeRevision()` | `./mixctl status` 的「代码」行 |

制品附带 `.sha256` 校验和(Windows 上用 `sha256sum`,macOS 上用
`shasum -a 256 -c`)。控制台自报的指纹应与制品里的运行期源码指纹一致;
不一致说明跑的不是这份代码。`codeRevision()` 只哈希 `mixrouter.js` 与 `lib/**/*.js`,
改配置、槽位、会话或日志不会让它变化。

---

## 7. 升级/回退前的最小核对清单

```bash
./mixctl status                       # 进程、版本、代码指纹、端口
./mixctl backups                      # 三处备份池的份数与下一次会删谁
./mixctl ls                           # 渠道、规则、当前生效、配置漂移
node -v                               # 22 / 24 推荐,最低 18
curl --fail http://127.0.0.1:8787/healthz
node scripts/check-update.js           # 本机 current 与版本(不联网)
node scripts/service.js status        # 运行实例、登录服务与固定数据目录
```

- [ ] 数据目录已用 `MIXR_DATA_DIR` 固定,不跟着代码目录走。
- [ ] 数据目录已整份复制一份到别处。
- [ ] 手上有一份可核验的源码归档(制品 + `.sha256`,或 Git 仓库)。
- [ ] 旧进程完全退出,`./mixctl status` 显示「未运行」。
- [ ] 新旧代码不会同时写同一个数据目录。
- [ ] 升级/回退后 `./mixctl status` 的「代码」行与预期的 `code_revision` 一致。
- [ ] 使用 `scripts/upgrade-release.js` 时先把预览输出核对一遍;联网只加 `--download`,
      离线归档带 `.sha256`(`--archive`)。
- [ ] 客户端配置要动时,先 `./mixctl backups` 核对,再 `--diff` 预览。

演练请在**独立 HOME、数据目录、端口**下做,不要把在线实例当演练环境,
也不要改现网 LaunchAgent。
