# 本次会话交付与验证记录（2026-10-17）

## 做了什么

按 `docs/changes/refactor-plan-2026-10-16.md` 四期计划继续推进：第二期收尾 + 第三期 + 第四期。

### 第二期收尾
- `lib/upstream/collect.js` 与五个同族兄弟统一为扁平命名 `lib/upstream-<topic>.js`，取消 `lib/upstream/` 目录（纯文件移动）。

### 第三期：控制台可维护性与体验
| 任务 | 产出 |
|---|---|
| 1 静态资源服务 | `lib/http/console.js` 增加限定 `public/` 的服务：MIME 白名单、路径穿越、越界软链（realpath 双侧比对）、只读、不列目录、无缓存 |
| 2 CSS/JS 外置 | `public/index.html` 2207 → 202 行；新增 `public/styles/base.css` + `public/js/app.js`（逐字节一致） |
| 3 页面重组 | 视图 4 → 6：`overview / providers / routes / sessions / diagnostics / settings`；修掉 `gotoLogs()` 的选择器陷阱 |
| 4 概览/渠道/路由显示 | 概览为**只读**页（无可写控件）+ "需处理事项"清单；渠道失效 Key/健康；路由主目标/后备/协议/来源/最近实际落点 |
| 5 会话三层 | 会话页新增「最近实际请求」列（无记录显示"暂无"，绝不用绑定或预览冒充）+ 绑定来源（手动钉定/自动分配/未绑定）+ 搜索 |
| 6 压缩分账 | 保存成功 / 已写盘 / 服务已加载 / 客户端需重开 分开表达 |
| 7 刷新协调 | 核查各去重/冲突机制在新页面下仍成立 |
| 8 设置与备份 | 接出前端原本零引用的只读端点：`/api/backups`、`/api/health`、`/api/routing/preview`、`/api/metrics` |

### 第四期：可恢复安装与发布
| 任务 | 产出 |
|---|---|
| 1 三类路径 | `lib/paths.js`（开发副本/发布目录/固定数据目录的唯一来源）；`mixctl` 与 `lib/zcode-config.js` 接入 |
| 2 安装入口 | `scripts/install-macos.sh`（干跑优先、幂等、三种明确失败、不碰 LaunchAgent） |
| 3 外壳解耦 | `app/MixrouterApp.swift` 过时兜底路径修正；`build-app.sh` 已从自身位置推导仓库根 |
| 4 发布制品 | `scripts/release-manifest.js`（显式白名单 + 先排运行数据）+ CI/Release 制品校验与 SHA-256 |
| 5 文档 | README 整理（+12/−3，保守）+ `docs/quick-start.md`、`routing-and-sessions.md`、`troubleshooting.md`、`upgrade-and-rollback.md` |
| 6 演练 | 隔离 HOME/数据/端口下干净安装、重复安装、启动发布物验证 |

### 架构纠正（重要）
规划 §2.5 原写"控制台迁到原生 ESM"。**实测该路与验收条件直接冲突**：ESM 顶层绑定进模块作用域，`vm.runInContext` 摸不到（`ReferenceError: view is not defined`），且 ESM live binding 外部不可赋值 —— 会打瞎 `test/ui.test.js` + `test/session-routing-ui.test.js` 合计约 410 处断言，而规划自己禁止"删测试换拆分"。改用**多文件 classic script 共用同一 realm**（实测跨文件读写都通，重复声明报错当安全网）。规划 §2.5/§5.3 已改正。

### 顺手修掉的真实覆盖漏洞
日志字段白名单扫描（`test/log-wiring.test.js` / `test/request-log.test.js`）原先各自只扫一份文件清单，漏了 `lib/wire-anthropic-translator.js`（它从 ctx 解构 `entry` 后真写 `entry.err/err_class/status`）。已把清单抽到 `test/proxy-sources.js` 单一来源并补入该文件，另加**反查守卫**用例（全仓按特征反查，漏登记即报红；已实测非空转）。

## 验证证据

| 项 | 结果 |
|---|---|
| 全量测试（除 3 个编辑中文件） | **1371 通过 / 0 失败**（90 文件） |
| README 三处钉子回归 | 51 通过 / 0 失败 |
| 离线冒烟 | **18/18** |
| 静态资源安全（独立探测，非子代理自测） | **15/15**：越界软链→404 无泄漏、`/etc/passwd`→404、`.log` 不服务、编码穿越→404、POST→404、不列目录、`public/` 无残留 |
| 真浏览器（headless Chrome，独立实例） | **17/17**：外置 CSS/JS 真加载、六个视图可切、概览零可写控件、会话三层列存在、无控制台报错 |
| 线上数据兼容预检 | **13/13**：新版代码吃线上数据副本，渠道 14/8、规则 40、会话 15 与线上一致 |
| 发布物演练 | 干净安装/重复安装幂等/发布物启动 + **发布树无密钥**（0 处 key 形态串） |

## 未验证（如实）
- 真实付费上游请求；WKWebView 实机；Node 18/22（本机 v24.18.0，CI 矩阵覆盖 18/22/24）
- 线上服务切换本身（在授权窗口执行，见下）
- `docs/` 中 `phase4-paths-and-install` 文档记录的部分安装边界

## 上线与回退
- 切换脚本：`scripts/deploy-live.sh`（**默认干跑**，`--apply` 才动线上；自动取证→预检→备份→切换→自检→**失败自动回退**）
- 回退：`scripts/deploy-live.sh --rollback --apply`
- 代码与 `public/` 必须**同一次**切换：控制台每请求读 `public/index.html`，新版引用 `/styles/base.css`、`/js/app.js`，只有新版 `console.js` 会服务它们。
- 数据文件只备份不迁移；`MIXR_DATA_DIR` 契约未变，回退后旧代码照常读同一份数据。
