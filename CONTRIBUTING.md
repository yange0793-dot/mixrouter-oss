# 贡献指南

mixrouter 是零依赖的 Node 项目:没有 `npm install`、没有构建步骤、没有 lockfile。
下面只讲**怎么改、怎么验、怎么提**,协议与路由原理见 [`README.md`](README.md)。

## 0. 环境

| 项 | 要求 |
| --- | --- |
| Node | `>= 18`(`package.json` 的 `engines.node`);开发与 CI 推荐用 **22 / 24** |
| 依赖 | 无。`dependencies` / `devDependencies` 都是空的 |
| 测试框架 | Node 自带的 `node:test`,不需要装任何东西 |

```bash
node --version                 # v18 或更高(推荐 22 / 24)
git clone <repo> mixrouter && cd mixrouter
npm test                       # = node scripts/run-tests.js
npm run smoke                  # = node scripts/smoke-offline.js,真实一进一出的离线验收
npm start                      # = node mixrouter.js,前台起服务
```

`npm test` 与 `npm run smoke` 都自带隔离:临时 `HOME`、临时 `MIXR_DATA_DIR`、内核分配的端口,
不读也不写你真实的 `~/.claude` / `~/.codex` / `~/.zcode`,不连 8787 / 8788。
**不要在仓库根造 `providers.json` 来测试** —— 测试不需要真实 Key,这个文件一旦存在就有被提交的风险。

## 1. 先读这两处

- `lib/paths.js`:开发副本 / 发布目录 / 数据目录的**唯一**定义。不要在任何脚本里另拼一遍路径。
- `scripts/release-manifest.js`:发布物里"装什么"的**唯一**来源(基底是 `lib/paths.js` 的
  `RELEASE_ITEMS`,再减去 `EXCLUDE`)。新增顶层文件或目录时,改 `RELEASE_ITEMS` 那一处,
  不要复制一份白名单。

改协议/路由之前,先看 README 的「环境变量」「命令总览」两节与 `test/*.test.js` 里的相关断言:
**有一部分**文档口径与测试断言是成对的(改了文档里那句承诺,对应断言会红)。不是所有文档都会这样,
但看到无端变红的断言时,先检查是不是自己改了它引用的那段话。

## 2. 测试

按改动范围跑受影响的文件即可,提交前跑一次全量:

```bash
node scripts/run-tests.js test/proxy.test.js test/session-routing.test.js   # 只跑受影响的部分
npm test                                                                   # 全量
```

`scripts/run-tests.js` 负责隔离环境与超时(单文件 30s、整套 5min),被 `npm test`、CI 与
`lib/diagnostics/run.js` 共用。绕过它直接 `node --test test/x.test.js` 会沿用你真实的 `HOME`,
**保护性断言因此不成立** —— 除非你正在排查隔离本身,否则别这么跑。

新增测试:

- 文件名以 `.test.js` 结尾,放在 `test/` 下(入口只收这一种);
- 用 `node:test` + `node:assert/strict`,不引第三方断言库;
- 测**行为与不变量**,不测"函数有没有被调用";一个用例只钉一件事,失败信息要能直接指出问题;
- 需要机器状态(真实端口、真实 HOME、真实 Key)的用例不要写进主线 —— 用临时目录与 `listen(0)`。

## 3. 不能进仓库的东西

以下文件含明文凭据或本机运行状态,已在 `.gitignore` 里,发布物也会按路径形状拦掉:

`providers.json`、`routes.json`、`slots.json`、`sessions.json`、`logs/`、`backups/`、`.run/`、
`*.bak*`、`*.json.*.tmp`。

- **不要**为了"这样方便复现"把它们 `git add -f`;发布清单会在打包时逐文件挡掉,CI 还会解包复核。
- 贴日志/贴配置前先删掉 `api_key` 与会话标签;控制台导出的 `key_masked` 才是可以贴的形态。
- 提交里带 Key = 视为已泄露。发现后先到对应渠道后台轮换 Key,再处理提交历史。

## 4. 提交与 PR

1. 先基于仓库的**默认分支**拉一个新分支,一个 PR 只做一件事(修复/特性/文档分开)。
2. 提交信息写清**为什么**改;涉及行为变化的,在 [`CHANGELOG.md`](CHANGELOG.md) 的未发布段加一行。
3. 跑过 `npm test` 再提;PR 模板里的检查项逐条确认,没跑就说没跑。
4. 不在 PR 里附真实 Key、真实会话内容或完整 `providers.json`。
5. 行为变化要同时更新:对应 `docs/*.md`、README 的相关段落、以及会因此变红的测试。

Review 时最常被问到的是:这条路径有没有第二份定义?有没有把作者本机路径/端口/标签写死?
新加的脚本是不是所有人都能跑、还是只在某台机器上有意义(后者请放进 `EXCLUDE` 并说明理由)。

## 5. 版本与发布(维护者)

版本号是三处**同源**的,发版工作流会校验一致,不一致直接失败:

```bash
# 1) package.json 的 version 与 mixrouter.js 的 `const VERSION = 'x.y.z';` 必须相同
# 2) tag 必须等于这个版本(可带 v 前缀)
node scripts/release-manifest.js version-check --tag v3.6.1

# 打包内容(只含清单内的已跟踪文件)与解包校验
node scripts/release-manifest.js paths
node scripts/release-manifest.js check <解包目录>
```

发布产物是**运行包**:解压后 `node mixrouter.js` 能直接跑,`npm run smoke` 也能直接跑;
**不含 `test/`**,所以在解压目录里跑 `npm test` 会明确报"此运行包不含开发测试套件"并以非 0 退出
(那是在提醒你去源码仓库跑,不是测试失败)。完整测试只在 GitHub 源码克隆里跑。

上线/回退用的 `scripts/deploy-live.sh` 与 `scripts/preflight-live-data.js` 不在发布物里,
它们不是安装路径。`scripts/install-macos.sh` 与 macOS 外壳仍是**实验性**组件,不是受支持的
正式安装入口;公开使用直接 `node mixrouter.js`(或用 `mixctl start` 常驻)。
