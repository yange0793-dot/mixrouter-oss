# 安装、运行与卸载

Mixrouter 是本机单用户的 Node 程序。当前推荐安装方式是下载运行包或克隆源码,
然后在终端前台启动。**没有免 Node 的桌面安装包**,也不会自动安装系统服务。

## 选择入口

| 目的 | 入口 | 数据位置 |
| --- | --- | --- |
| 第一次使用 / 从 Release 运行 | `npm run local` | 默认 `~/.local/share/mixrouter/data` |
| 沿用已有部署 | 保留原来的启动命令 | 原有 `MIXR_DATA_DIR`,未设则为原代码目录 |
| 开发 / 原始启动 | `npm start` | `MIXR_DATA_DIR`,未设则为代码目录 |
| 已配置的后台部署 | `node mixctl start` | 同上;不会继承另一个终端的参数 |

所有命令在源码或运行包目录执行。`npm run local` 与 `npm start` 都是前台运行,
关闭终端会结束服务。已运行其中一个时不要再启动另一个。

## 下载运行包

> `local` / `doctor` 从 **v3.7.0** 起提供。已发布的 **v3.6.1** 运行包仍使用 `npm start`,
> 可先设置 `MIXR_DATA_DIR` 把数据与代码分离(macOS/Linux):
>
> ```bash
> export MIXR_DATA_DIR="$HOME/.local/share/mixrouter/data"
> npm run smoke
> npm start
> ```
>
> 本文其余新入口示例用于包含这些脚本的源码或 v3.7.0 及之后的运行包,不代表 v3.6.1 已更新。

1. 在 [Releases](https://github.com/yange0793-dot/mixrouter-oss/releases) 中选择一个版本。
2. 下载 `mixrouter-<版本>.tar.gz` 和同名 `.sha256` 文件;GitHub 自动生成的
   “Source code”附件不是经过本项目清单筛选的运行包。
3. 核对校验和,再解压到一个**新的空目录**。不要覆盖正在运行的版本。

macOS 校验:

```bash
shasum -a 256 -c mixrouter-<版本>.tar.gz.sha256
```

Linux 校验:

```bash
sha256sum -c mixrouter-<版本>.tar.gz.sha256
```

`<版本>` 替换为你下载的版本号。校验和验证文件一致性,不是代码签名或安全背书。
需要 GitHub 之外的下载来源时,还要核对来源可信性,不能只相信它同时提供的校验和。

## 新安装的三条命令

先安装 Node 22 或 24。项目没有第三方依赖,无需 `npm install`:

```bash
npm run doctor
npm run smoke
npm run local
```

- `doctor` 只读检查本机环境、配置顶层结构、目录权限与服务。没有服务、没有渠道是首次使用的正常警告。
- `smoke` 启动临时实例和本地 mock 上游,不需要 Key,不访问真实渠道,不占用默认服务端口。
- `local` 启动真实的本机服务,在终端打印数据目录和控制台地址。

随后打开 `http://127.0.0.1:8788/`,依次添加渠道、配置模型/槽位、接入客户端。
具体字段见[快速开始](quick-start.md)。必须使用 `127.0.0.1`,不能用 `localhost` 替代。

### 自定义路径与端口

```bash
npm run local -- --data-dir "/你的私有数据目录" --port 18787 --ui-port 18788
npm run doctor -- --data-dir "/你的私有数据目录" --port 18787 --ui-port 18788
```

参数优先于 `MIXR_DATA_DIR` / `MIXROUTER_PORT` / `MIXUI_PORT`。
数据路径必须是绝对路径,两个端口必须不同且在 1–65535 范围内。
改端口后,客户端应使用启动输出的代理地址;控制台的接入按钮使用当前实例的端口。

`MIXR_INSTALL_PREFIX` 可改变新入口的默认安装根,数据落在该根的 `data/`。
如果源码目录已有 `providers.json` 等存量数据,新入口会停止并要求明确指定 `--data-dir`,
不会替你迁移或静默从空库开始。

`mixctl` 的文件命令保留旧路径约定。若要用它查看新入口的备份,
请显式传入相同的数据目录(此例为 macOS/Linux):

```bash
MIXR_DATA_DIR="$HOME/.local/share/mixrouter/data" node mixctl backups
```

## 停止与升级

在运行 `npm run local` 的终端按 **Ctrl+C**,等待服务退出。
新入口转发停止信号,不安装 launchd、systemd 或 Windows 服务。

升级用新目录保存新代码,继续使用同一份数据。先验证新版,再停止旧版、备份数据并启动新版。
详细步骤与回退限制见[升级与回退](upgrade-and-rollback.md)。不要同时运行两个版本写同一目录。

## 卸载

1. 先停止前台服务。若以前自行安装了系统常驻服务,先按当时的安装方式停用它;
   删除源码目录不会自动卸载常驻服务。
2. 如果通过控制台把 Claude Code、Codex 或 ZCode 指到了 Mixrouter,
   先恢复对应客户端配置,具体见[恢复客户端配置](upgrade-and-rollback.md#4-把客户端恢复成原来的配置)。
   只停止路由器而不恢复配置,客户端会继续连接已停止的本机端口。
3. 确认需要保留的配置已备份后,删除下载/解压的代码目录即可。
4. **数据默认保留**。确实不再需要时,由你手动删除启动输出中的数据目录。
   其中含明文 Key、会话标签与日志;不要把它上传到公开位置。

不提供自动删除数据的卸载命令,也不会在更新时删除旧代码或用户配置。

## 支持边界

- 核心程序由 Node 内置模块组成;Linux 有 Node 18/22/24 的 CI,macOS 有本地运行验证。
- Windows 目前没有完整测试矩阵,不能把“Node 可运行”当作所有 CLI、外壳与常驻功能都受支持。
- `scripts/install-macos.sh` 与 Swift 外壳仍是实验性组件,不属于上述推荐启动路径。
- 项目不提供模型账号、Key 或额度;真实上游的兼容性、稳定性和费用由你选择的服务决定。
- 故障先运行 `npm run doctor`;分享结果前检查本机路径,不要发送原始数据文件。见[求助说明](../SUPPORT.md)。
