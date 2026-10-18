# 第四期 · 发布制品清单与校验(2026-10-17)

对应规划 `refactor-plan-2026-10-16.md` §5.4 **任务 4**:

> 基于既有 `.github/workflows/ci.yml`、`.github/workflows/release.yml` 增加制品清单、
> SHA-256 校验和、版本/源码修订、兼容性及回滚说明。只打包明确纳入的源码和资源,
> 不把运行目录整包发布。

本文只记**实际改动与实跑结果**。凡是没能在本地验证的,一律在末节「未验证范围」写明。

---

## 一、先回答那个前置问题:裸 `git archive HEAD` 会带上运行数据吗?

**结论:在本仓库当前状态下不会,但这层保护是间接的、且会被一次 `git add -f` 打穿 ——
这正是任务要求把它换成显式清单的原因。**

`providers.json` / `routes.json` / `sessions.json` / `slots.json` / `logs/` / `backups/`
在 `.gitignore` 里,且当前**未跟踪**。`git archive HEAD` 只收 HEAD 里已跟踪的内容,
所以它们进不去。实测(在开发副本,HEAD
`67fd952ae4fe8bc1f3300913da61dfe3a1ce239a`):

```
$ git archive HEAD | tar -t | wc -l
215

$ git archive HEAD | tar -t | grep -E '(^|/)(providers\.json|routes\.json|sessions\.json|slots\.json)$|(^|/)(logs|backups)/'
$ echo $?
1                      # 无匹配 —— archive 里一个运行数据条目都没有

$ git ls-files | grep -cE '(^|/)(providers\.json|routes\.json|sessions\.json|slots\.json)$|(^|/)(logs|backups)/'
0                      # 它们也都不在索引里
```

> 说明:开发副本里当时连 `providers.json` 这类文件都不存在于磁盘(`ls` 报 No such file),
> 所以上面的结论对本机是"连候选都没有"。为了让结论不依赖某个副本的偶然状态,另做了一次
> **受控实验**:在一个一次性仓库里造出真实形态 —— 文件在 `.gitignore` 里、先只存在于工作区。

```
# 步1:运行数据只在工作区(未跟踪)
$ git archive HEAD | tar -t | grep -E 'providers.json|sessions.json|requests.jsonl'
（无输出）                       ← 未跟踪 → 不进 archive。裸 archive 在这一步确实是安全的。

# 步2:有人 git add -f 绕过忽略规则并提交
$ git add -f providers.json sessions.json logs/requests.jsonl && git commit -qm oops

# 步3:同一个裸 git archive HEAD,现在带上了
$ git archive HEAD | tar -t | grep -E 'providers.json|sessions.json|requests.jsonl'
logs/requests.jsonl
providers.json
sessions.json                   ← 裸 archive 已经不可靠
```

**所以"gitignore 拦住了"这件事成立,但它是"git 当前没跟踪"换来的,不是一条会主动报错的
保证。** `git add -f`、`.gitignore` 被改错、或者将来有人把运行目录挪进一个被跟踪的目录,
都能让它失效,而失效时**没有任何一步会报错**。任务 4 要求的显式清单就是去掉这个隐含前提。

---

## 二、制品清单:唯一来源是 `lib/paths.js` 的 `RELEASE_ITEMS`

新增 `scripts/release-manifest.js`。零运行时依赖、只 `require` node 内置 + `../lib/paths`;
`require` 它**无副作用**(不碰磁盘、不读 git),读写文件的逻辑只活在
`require.main === module` 的 CLI 分支里,那条分支只服务 workflow 与人工核对。

### 收拢:不再有第二份"装什么"

初版这份模块自己列了一份纳入清单(逐条列根文件、目录、`scripts/` 下 6 个脚本、单篇文档)。
但同一时间,`lib/paths.js` 为 `scripts/install-macos.sh`(把本地克隆复制到发布目录)
也定义了一份 `RELEASE_ITEMS`,两份**当下就不一致**:

- 它写整个 `docs`(⇒ 会把 `docs/changes/` 内部计划一起带上),初版按文件列且排掉 `docs/changes`;
- 它写整个 `scripts`,初版逐文件列。

本仓库为"同一份知识写两遍"已经吃过一次亏 —— `lib/backup/targets.js` 的注释记录了那场事故
(两个出口报出不同的备份池,"比只报一个更坏")。而 `RELEASE_ITEMS` 与这份清单描述的是
**同一件事:发布物里装什么**,只是一个给 GitHub Release、一个给本地安装。

**收拢做法:`require('../lib/paths').RELEASE_ITEMS` 作基底,本模块只做基底表达不了的两件事。**

| 导出 | 作用 |
| --- | --- |
| `INCLUDE`(=`RELEASE_ITEMS`) | 纳入项,**就是**那一份数组(同一引用),不复制、不改写 |
| `INCLUDE_WHY` | 每条纳入项**为什么**要进,纯文档(测试逼着每条都有) |
| `EXCLUDE` | 从基底里**再减掉**的细分项 + "即使被加进基底也必须挡住"的项,每条带 `why` |
| `include(relPath)` | 单条判定,纯函数 |
| `isRuntimeData(relPath)` | 「绝不能发布」的路径形状判定(含 `.tmp` / `.bak` / 运行目录变体) |
| `filterTracked(paths)` | 把 `git ls-tree -r` 的文件清单过成制品清单(**逐文件**,不整目录) |
| `releaseInfo({version,revision,codeRevision})` | 制品身份信息(形状校验,不含时间戳) |
| `check(dir)` | 校验解包后的制品:不含运行数据 + 关键入口齐全,CI 用它 |

要"多装一个目录/文件"时,改的是 `lib/paths.js` 的 `RELEASE_ITEMS` **那一处**,不是这里。
本模块**不另写白名单** —— 有一条测试专门盯着这点(`INCLUDE` 必须与 `RELEASE_ITEMS` 同源同值)。

> 注:`RELEASE_ITEMS` 是 `Object.freeze` 过的,所以 `INCLUDE` 也冻结 —— 想往清单里塞一条
> 会直接 `TypeError`,这是额外的一层纵深防御。

### 纳入什么(即 `RELEASE_ITEMS` 的内容)

- 根:`mixrouter.js`、`mixctl`、`package.json`、`LICENSE`、`README.md`、
  `providers.example.json`、`routes.example.json`
- 目录(整棵,源码区,新模块自动随包走):`lib/`、`public/`、`app/`、`scripts/`、`docs/`

`scripts/` 这次是**整目录**纳入(与 `lib`/`public` 一样)。因此并行代理新加的
`install-macos.sh`、`deploy-live.sh`、`preflight-live-data.js` 自动随包 —— 本模块不需要
跟着改。已扫过这三个新脚本,不含绝对个人路径、密钥或 token 字面量(实测 `grep` 无匹配)。
说明:`scripts/run-tests.js` 不只是开发工具 —— `lib/diagnostics/run.js:7` 在**运行期**
`require('../../scripts/run-tests.js')` 取 `testEnv`;实测拦截该模块解析后
`require('./lib/diagnostics/run')` 直接 `MODULE_NOT_FOUND`,少了它
`scripts/diagnose-upstream.js` 这条用户命令就废了。整目录纳入正好把这条硬依赖一起带上。

### `scripts/release-manifest.js` 自己要不要进制品?

**判断:要进,且现在确实进了。** 理由三条:

1. **与安装脚本口径一致。** `install-macos.sh` 按 `RELEASE_ITEMS` 复制,而 `scripts` 是整目录,
   所以本地安装出来的发布目录里**本来就有** `scripts/release-manifest.js`。GitHub Release
   制品若把它剔掉,两种发布路径就又不一致了 —— 而这次收拢的全部意义就是消除不一致。
2. **在制品里能正常跑,不是死代码。** 实测:从解包后的制品目录里执行
   `node scripts/release-manifest.js check .` → `制品校验通过:93 个文件,关键入口齐全,无运行数据`;
   `release-info --version …` 正常产出。配套的 `lib/paths.js` 也在制品里(`lib` 整目录),
   所以 `require('../lib/paths')` 能解析。
   (唯一跑不了的是 `paths` 子命令 —— 它要 `git ls-tree`,而解包目录没有 `.git`。
   它会明确报"无法读取 git 跟踪文件",不是静默给错结果。)
3. **它是发布工具,但不需要"被制品消费"才能进。** 即使没有制品内的消费方,它随包也不构成
   风险:它只读自己的仓库、只写 CLI 标准输出。把它排除反而要引入一条"从 `scripts` 基底里
   减掉一个文件"的例外,而这个例外没有收益。

一句话:**不需要制品里的东西去读它,但"要不要进"的判据是"是否与另一条发布路径一致",
而不是"制品里有没有人读"。** 顺带,`docs/changes/` 里那份实施记录本也在仓库里,
读者若想核对这份清单的形状,在源码仓库即可读到,不需要制品内再放一份。

### 排除什么,以及每条的理由

| 路径 | 为什么不进制品 |
| --- | --- |
| `docs/changes/` | 内部改动记录,**含尚未发布的规划(refactor-plan、各期 implementation)与取证过程** |
| `providers.json` | **含全部渠道明文 api_key**,运行数据 |
| `routes.json` | 本机路由规则,运行数据 |
| `sessions.json` | **含对话标签(对话内容片段)** 的会话绑定,运行数据 |
| `slots.json` | 本机子代理槽位,运行数据 |
| `logs/` | 运行期日志(server.log / requests.jsonl / 响应归档) |
| `backups/` | 历史备份归档,内含明文 Key 与渠道配置 |
| `test/` | 开发测试套件,产品运行不需要;CI 自己会跑 |
| `evidence/` | 内部取证脚本与运行日志,README 不引用 |
| `AUDIT-2026-09-17.md` | 历史内部审计报告,记录的是当时状态,README 不引用 |
| `.github/` | 上游仓库的 CI/发版自动化;**制品消费者没有 workflow runner**,收进去只会多一份会与仓库分叉的定义 |
| `node_modules/` | 本项目零依赖,本就不该存在;显式写死防误加 |

注意:`providers.json` 这几项**并不在基底里**,排除它们主要靠 `isRuntimeData()`(按路径形状
判定)。这一层是必须的 —— 因为有人 `git add -f` 之后,运行数据可能**藏在基底目录内部**
(如 `lib/sessions.json`、`public/providers.json`),只靠"不在基底里"是拦不住的。

### `docs/`:这条取舍的最后形状

`docs` 整目录在基底里(所以四份**用户文档** `quick-start.md`、`routing-and-sessions.md`、
`troubleshooting.md`、`upgrade-and-rollback.md` 都会进包,不会出现"README 进了包、它链接的
文档没进"的死链);而 `docs/changes/` 由 `EXCLUDE` 单独减掉。

这一条在收拢过程中被修正过一次:初版按文件列 `docs`,只写了 `offline-run-and-acceptance.md`,
于是那四份新用户文档 `include()` 全返回 `false`。这是"另写一份白名单"必然的失败模式 ——
来源那边加了东西,这边的复制品不会跟着动。改成以 `RELEASE_ITEMS` 为基底后自动解决,
且新增了一条测试专门断言这四份必须进包。

### 判定的顺序(有序,不能反)

`include()`: **先看基底 → 再排运行数据 → 再排显式排除**。测试用"藏在 `lib/` / `public/`
里的运行数据文件名"钉住这条顺序:`inBase()` 明明返回 `true`,而 `include()` 仍是 `false`。

---

## 三、打包:逐文件过滤,而不是整目录收

`git archive HEAD <路径>` 有两种形态,我们**故意选了逐文件**:

- ~~`git archive HEAD lib public …`(目录参数)~~ —— 整棵子树照收,只认 git 的跟踪状态,
  **不认这份清单**。受控实验实测:`git add -f public/providers.json` 之后,
  `git archive HEAD public/` 会把它收进去,而 `include('public/providers.json')` 是 `false`。
  也就是说,目录参数会让"显式清单"退化成"git 跟踪了什么" —— **正好是我们要摆脱的东西**。
- ✅ `git ls-tree -r HEAD` 列出已跟踪文件 → `filterTracked()` 逐文件过滤 → 结果作为
  `git archive` 的路径参数。清单说不要的,**任何位置**都进不去。

副作用(免费的第二道闸):清单里若有**尚未提交**的路径,`git archive` 会以退出码 128
直接失败,而不是静默少打一个文件 —— 实测:

```
$ git archive --format=tar.gz -o /tmp/x.tgz HEAD mixrouter.js public/js/app.js
fatal: pathspec 'public/js/app.js' did not match any files     # exit 128
```

### 为什么打包是 `git archive --format=tar.gz`,而不是"先 tar、追加身份文件、再 gzip"

初版按任务提示把 `RELEASE-INFO.json` 用 `tar -rf` 追加进 tarball。**本地实测发现这条路
产不出稳定的校验和,于是改掉了:**

```
# 同一份源码,前后隔 1 秒各打一次(旧写法)
run1: a1b2…        # gzip 把输入文件的 mtime 写进压缩头
run2: c3d4…        # tar -rf 也记下身份文件的落盘时间 → 两次字节不同
```

校验和的意义是"同一件东西两处对得上"。两次打包 sha 不同,它就退化成随机串。
改成 `git archive --format=tar.gz -9` 直接产出后:

```
run1: b855b0f03d5caaac78abee89caa3e39f1e6146d61ffa4079bd856972695574b2
run2: b855b0f03d5caaac78abee89caa3e39f1e6146d61ffa4079bd856972695574b2   ← 可复现
```

代价:`RELEASE-INFO.json` 不再躺在 tarball 里,改为**同一次 Release 的另一个附件**
(`mixrouter-<ver>.RELEASE-INFO.json`)。任务原文允许"制品里(或随 Release 一起)",
所以这是二选一里更稳的那个。

> 也试过 `git archive --add-virtual-file=RELEASE-INFO.json:…`,它确实可复现,
> 但该选项需要 git ≥ 2.35,对老 runner 不保险,所以没采用。

### 单个 `git archive` 调用

文件清单用**命令替换** `$(cat …)` 展开,不用 `xargs`:`xargs` 在文件多时可能拆成多次
调用,每次都会覆盖同一个 `-o`,只剩最后一批 —— 制品静默少东西。命令替换保证单次调用。
未加引号是靠 IFS 分词,前提是清单路径不含空白或 shell 元字符;
**这条前提由测试钉死**,`filterTracked()` 遇到含元字符的命中路径会**抛错**(不静默丢弃)。

---

## 四、CI 校验做了什么(只验不发)

`.github/workflows/ci.yml` 只加了一步,保留原 Node 18/22/24 矩阵与 `npm test` /
`npm run smoke`,**不加任何发布动作**。新增步骤「校验制品内容(release tarball)」:

1. 用清单生成 tarball(命令与 `release.yml` **逐字相同**,保证 CI 验的就是发版真正会产出的东西);
2. 解开;
3. 用 shell 显式数一遍 `providers.json`/`routes.json`/`sessions.json`/`slots.json` 与
   `logs/`/`backups/`/`.run/` —— 证明"解包目录里确实一个都没有",而不是只看函数返回值;
4. 跑 `node scripts/release-manifest.js check <解包目录>` —— 断言**不含**运行数据、
   **包含** `mixrouter.js` / `public/index.html` / `public/js/app.js` / `public/styles/base.css`。

`release.yml` 侧,除同样的内容校验外,还多一步 `sha256sum -c` 校验自己的校验和文件。

---

## 五、发布说明里的兼容性与回滚口径(写实话)

Release 正文由 workflow 的「撰写发布说明」步生成(heredoc 写好后交给 `--notes-file`,
再叠 `--generate-notes` 追加本次改动)。要点:

**兼容性**

- Node ≥ 18,零依赖,解压即可 `node mixrouter.js`,无需 `npm install`。
- 配置格式:`providers.json` 落盘 `version: 2`,`sessions.json` / `slots.json` 为 `version: 1`。
  读取侧对旧形态向前兼容(v2.0 的裸数组渠道库仍可读、缺 `version` 按当前结构解析)。

**回滚 —— 这里如实说明现状,不声称有自动保护**

规划 §5.4 的验收写的是「回退恢复旧代码且保留兼容的新配置;**旧版不能读取的数据版本必须
阻止盲目回退**」。核对代码后的实情是:

- 这些文件**确实带 `version` 字段**(`providers.json:2`、`sessions.json:1`、`slots.json:1`,
  `routes.json` 无版本字段),但**读取侧只做形状归一化,没有任何"version 高于本版就报错"
  的闸门**。搜遍 `lib/`、`mixrouter.js`、`mixctl`,没有一处做版本比较或拒绝。
- 也就是说:**没有任何自动机制能阻止用旧版去读新版写出的数据。**

所以发布说明里写的是「**当前持久化格式没有"拒绝读取"的版本闸门……回退版本前请人工核对
配置兼容性**」,而不是含糊地说"有回滚保护"。回滚步骤按 §6.1 的顺序落地:

1. 先停服务再换代码(不要让两个版本同时写同一个数据目录);
2. 用对应版本的 `.sha256` 核对旧版制品完整,再解压;
3. 若新版本没改过 `providers.json`/`routes.json`/`sessions.json`/`slots.json` 的结构
   (本版即是),旧代码可直接沿用;若曾用更新版本改写过,先备份对比
   (控制台备份 / `mixctl backups --diff`),解析不了就**停止回退并保留现场**,
   不用旧快照覆盖用户后来保存的新设置;
4. 回退后用运行期源码指纹确认跑的是旧版代码。

**版本 vs 源码修订:两个值都给,且不混为一谈**

- `revision` = `git rev-parse HEAD`(40 位 SHA),对外可核对的 git 修订;
- `code_revision` = `lib/runtime-code.js` 的 `codeRevision()`(64 位哈希),
  **运行期**"代码是否被换过"的指纹 —— 它只哈希 `mixrouter.js` 与 `lib/**.js`,与 git 无关。
  两者都写进 `RELEASE-INFO.json`,并说明"源码修订相同不证明客户端环境或所有配置已加载"。

---

## 六、跑的测试与原始结果

命令(按任务要求,只跑自己那份 + 相关的,不跑全量以免与并行改动互相污染):

```
$ node scripts/run-tests.js test/release-manifest.test.js test/paths.test.js
[tests] v24.18.0, 2 files, total timeout 300000ms
...
ℹ tests 42
ℹ suites 0
ℹ pass 42
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 153.786827
```

`test/release-manifest.test.js`(新建,42 条里 27 条是它)覆盖:

- **单一来源**:`INCLUDE` 必须与 `lib/paths.js` 的 `RELEASE_ITEMS` 同源同值,且不得出现
  `RELEASE_ITEMS` 里没有的项(有人又补第二份白名单时红)。每条纳入项都要有 `INCLUDE_WHY` 解释。
- **两个消费方口径一致**:`RELEASE_ITEMS` 的每项都不在 `FORBIDDEN_IN_RELEASE` 里;
  后者每项都被 `include()` 拒绝(含 `<item>/x` 子路径)。
- **判定**:源码/资源进;`providers.json`/`routes.json`/`sessions.json`/`slots.json`/
  `logs/x.jsonl`/`backups/x` 全不进;`test/ui.test.js`、`docs/changes/…`、`evidence/…`、
  `.github/…` 不进;`.tmp`/`.bak`/`.run/` 变体都判为运行数据;`*.example.json` 不被误伤。
- **判定顺序**:藏在 `lib/`、`public/`、`app/` **内部**的运行数据文件名,`inBase()` 明明是
  `true`,而 `include()` 仍为 `false`(证明"运行数据判定先于基底");另断言 `INCLUDE` 已冻结、
  塞不进新项。
- **每条列出的路径在仓库里真实存在** —— 这条比判定更重要:漏一个改过名的目录时判定用例全绿、
  制品却少一整块。`RELEASE_ITEMS` 里既有**文件**(`mixrouter.js`…)也有**目录**(`lib`、`docs`…),
  所以这条不假设类型:对每一项都跑 `existsSync`(文件与目录都成立),再对**是目录**的那几项
  额外要求"确实非空"(空目录多半是改名后的残影)。
- **docs 的两面**:README 链接的四份**用户文档**(`quick-start.md`、`routing-and-sessions.md`、
  `troubleshooting.md`、`upgrade-and-rollback.md`)必须进包(否则解压即死链);`docs/changes/…`
  必须不进包。两条分开断言,防止哪天"为了省事"把 `docs` 的排除项删掉。
- **`public/js/app.js` 与 `public/styles/base.css` 各有一条专门断言**(新拆出的文件,最易漏),
  且核对 `index.html` 确实引用这两个路径。
- **`filterTracked`**:逐文件过滤;把 `git add -f` 过的运行数据挡在**任何位置**
  (`public/providers.json`、`lib/sessions.json`、`app/logs/…`、`docs/changes/hidden-plan.md`
  都进不来);空白/非字符串条目被忽略;含 shell 元字符的命中路径**抛错**而非静默丢弃。
- **`releaseInfo`**:version / 40 位 revision / 短 sha / code_revision 的形状;
  缺项或形状不对时抛错;同一份输入重复产出逐字节相同。
- **`check()`**:干净制品绿;塞入 `sessions.json` 或删掉 `public/js/app.js` 时红并点名。

### 端到端演练(用一份一次性仓库复刻 workflow)

在 `/tmp` 下把工作区(含尚未提交的 `lib/paths.js`、四份用户文档、
`public/js/app.js`、`public/styles/base.css` 等并行改动)快照成一个 git 仓库(205 个跟踪文件),
然后**逐步跑 workflow 里抽出来的每个 run 块**:

```
$ bash <ci.yml「校验制品内容」步>       # 与 release.yml 逐字相同的打包命令
制品校验通过:93 个文件,关键入口齐全,无运行数据

$ bash <release「生成制品文件清单」步>   # 93 个文件,无运行数据
$ bash <release「打包源码」步>
b7676c682b41e4940bfcdde82d63654dfb3219111c3562656cdaf2e02f8b265f  mixrouter-3.6.0.tar.gz
$ bash <release「生成版本与源码修订」步>
{ "version":"3.6.0", "revision":"…", "revision_short":"…", "code_revision":"…" }
$ bash <release「校验制品内容」步>
制品校验通过:93 个文件,关键入口齐全,无运行数据
mixrouter-3.6.0.tar.gz: OK
```

制品里的 docs(用户文档进了、`changes/` 没进):

```
$ tar -tzf mixrouter-3.6.0.tar.gz | grep '^docs/'
docs/
docs/offline-run-and-acceptance.md
docs/quick-start.md
docs/routing-and-sessions.md
docs/troubleshooting.md
docs/upgrade-and-rollback.md
```

**注入演练**:往该仓库里 `git add -f` 塞进 `public/providers.json`、`lib/sessions.json`、
`app/logs/requests.jsonl`、`slots.json`、`docs/changes/leaked-plan.md` 并提交
(模拟忽略规则被打穿),重跑:

```
# 旧目录参数写法会带上它们:
$ git archive HEAD lib public app scripts docs mixrouter.js | tar -t | grep -E 'providers.json|sessions.json|requests.jsonl|leaked-plan'
LEAK: app/logs/requests.jsonl
LEAK: docs/changes/leaked-plan.md
LEAK: lib/sessions.json
LEAK: public/providers.json

# 新逐文件清单:一个都不在
$ node scripts/release-manifest.js paths | grep -E 'providers.json|sessions.json|requests.jsonl|leaked-plan'
（无输出）

$ node scripts/release-manifest.js check <解包目录>
制品校验通过:93 个文件,关键入口齐全,无运行数据
```

同一次演练还确认:同一 commit 前后两次打包得到**相同的 sha256**;tarball 里 `mixctl`
的可执行位保留;解包后四个关键入口齐全;从**解包后的制品内部**执行
`node scripts/release-manifest.js check .` 也能通过。

---

## 七、未验证范围(如实说明)

1. **没有在本地真跑 GitHub Actions。** 本机是 macOS,GitHub runner 是 Linux。上面所有
   演练都是把 workflow 的 `run:` 块抽出来在本地 bash 里跑的,能证明脚本逻辑与打包/校验
   结果,**不能**证明 actions 生态(`actions/checkout`、`setup-node`)、runner 镜像预装工具
   或 `GITHUB_*` 上下文的行为。
2. **`sha256sum` 未在本机跑到。** macOS 没有该命令(本机是 `shasum -a 256`),演练时用一个
   `shasum` 包装垫过了它。Linux runner 上 `sha256sum` 是 coreutils 自带的,预期可用,
   但**本轮未在 Linux 上实跑**。同理 `sed -i`(若有)在 GNU/BSD 语义不同 —— 现已不使用它。
3. **没有真正创建 Release 或 tag。** `gh release create` 只做了参数层面的核对
   (`--notes-file` 与 `--generate-notes` 可同时给,二者会先过参数校验再走到认证),
   **没有**打 tag、没有推远端、没有产出一个真实 Release。发版正文的实际渲染效果未经 GitHub
   端验证。
4. **命名与路径参数的假设未在 Windows 上验证**(本项目 README 明说核心服务跨平台,但 CI
   runner 只有 Linux)。

---

## 八、发现但**没改**的既有问题

1. **持久化格式没有版本闸门。** 各文件写了 `version`,但读取侧从不比较、也从不因版本过高
   而拒绝(见 §五)。规划 §5.4 验收要求的"旧版不能读取的数据版本必须阻止盲目回退"**目前
   没有实现**,本轮只在发布说明里如实写明,未动读取逻辑 —— 加闸门属于行为改动,
   不在这份任务(发布制品与说明)的授权范围内。
2. **`lib/diagnostics/run.js` 在运行期 `require` 测试入口 `scripts/run-tests.js`。**
   一个"运行诊断"模块依赖"测试运行器",职责上是倒挂的。本轮把它**纳入**了制品(否则用户
   命令会 `MODULE_NOT_FOUND`),没有重构这条依赖。
3. **`git archive` 的目录参数会整棵收已跟踪文件。** 这不是 bug,但很反直觉,且与"显式
   清单"的意图冲突;已在清单模块与本文件里写明为何弃用它。
4. **`public/js/app.js` / `public/styles/base.css`、`lib/paths.js`、四份用户文档在本轮开始时
   仍未提交**(并行工作正在进行)。CI 的制品校验因此在它们被提交之前会红 —— 这是**正确行为**
   (制品确实缺了控制台资源 / 清单基底解析不了),不是 CI 配置错误;提交后即绿。
   实测:在一次性仓库里把它们提交后,check 通过,且解包后目录从 87 个文件涨到 93 个。

---

## 九、本轮之后的一次修正(收拢"装什么"的唯一来源)

写完之后,主会话核对时发现两处与"制品到底装什么"有关的问题,已在本轮内修正:

1. **四份用户文档不进制品。** 初版自列的纳入清单里 `docs` 只写了
   `offline-run-and-acceptance.md`,于是 `docs/quick-start.md` 等的 `include()` 返回 `false`。
   而这几份是给用户看的、README 整理后会链接 —— **README 进了包、它链接的文档没进 = 死链**。
2. **出现了第二份"制品清单"。** `lib/paths.js` 的 `RELEASE_ITEMS`(给 `install-macos.sh` 用)
   与初版自列的清单描述的是同一件事,且**当下就不一致**(它写整个 `docs`,初版排掉
   `docs/changes`;它写整个 `scripts`,初版逐文件列)。本仓库已为"同一份知识写两遍"吃过一次亏。

修正方式:**改为以 `require('../lib/paths').RELEASE_ITEMS` 为基底**,本模块只做基底表达不了
的两件事(`EXCLUDE` 细化 + `isRuntimeData` 形状拦截)。两个问题一并解决:四份用户文档
因为 `docs` 整目录在基底里而自动进包;而 `docs/changes/` 仍由 `EXCLUDE` 单独减掉。
新增两条测试分别盯着这两件事,外加一条盯着"两个消费方口径一致"
(`RELEASE_ITEMS` 与 `FORBIDDEN_IN_RELEASE` 不重叠、后者每项都被拒绝)。

**没有改 `lib/paths.js`** —— 那个文件归另一个子代理,且已完成自测;收拢全部在我自己的文件里做。

