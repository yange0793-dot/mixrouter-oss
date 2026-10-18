# 第三期任务 3–8：页面重组与体验（实施规格）

对应规划 `refactor-plan-2026-10-16.md` §5.3。任务 1（静态资源服务）、任务 2（CSS/JS 外置）、任务 5（会话三层页面）已分别派发/完成；本文定的是**任务 3、4、6、7、8** 的落点。

前置事实（10-17 实测）：

- `public/index.html` 已从 2207 行拆成 202 行骨架 + `public/styles/base.css` + `public/js/app.js`（1701 行）。
- `public/js/app.js` **必须保持 classic script 语义**：`test/ui.test.js`（51 例）与 `test/session-routing-ui.test.js`（27 例）用 `vm.runInContext` 直接读写脚本顶层 `let`/`const`，合计约 410 处断言。ESM 顶层绑定进模块作用域，`vm.runInContext` 摸不到（实测 `ReferenceError: view is not defined`），且 ESM live binding 从外部不可赋值。规划 §2.5 自己禁止"删除…测试来换取拆分顺利"，故**不采用 ESM**。
- 多个 classic script 在**同一 realm** 内依次执行可安全共享顶层绑定（实测跨文件读 `let` 成功、写后可见），且**重复声明会当场 `SyntaxError`**——白送的"每个顶层名字只有一个家"安全网。故按页拆文件是安全的，前置条件是**每个顶层绑定唯一**。
- 现有 `app.js` 顶层 **204 个**声明，**零重名**；且已有 `// ---- 渠道 ----` 这类分节注释，分节边界与模块边界几乎一一对应，拆分是机械的。

---

## 一、目标页面结构（任务 3）

规划要求：**概览、渠道与 Key、路由（槽位/规则/压缩）、会话、诊断、设置与备份**，且"不新增第二套路由编辑器；每项配置保留唯一主要编辑入口"。

现状只有 4 个视图（`providers` / `routes` / `sessions` / `logs`）。映射关系与改动：

| # | `data-view` | 侧栏文案 | 内容来源 | 动作 |
|---|---|---|---|---|
| 1 | `overview` | 概览 | **新建** `#view-overview` | 新增 |
| 2 | `providers` | 渠道与 Key | 现有 `#view-providers`（apptabs + 渠道库 + 子代理槽位） | 改文案 |
| 3 | `routes` | 路由 | 现有 `#view-routes`（压缩模型 + 压缩窗口 + 匹配与分流 + 默认路由） | 不动 |
| 4 | `sessions` | 会话 | 现有 `#view-sessions` | 不动（任务 5 已改） |
| 5 | `diagnostics` | 诊断 | 现有 `#view-logs`（请求日志 + 分槽用量） | **改名** |
| 6 | `settings` | 设置与备份 | **新建** `#view-settings` | 新增 |

**"概览"不是第二套编辑器**：它只读 `state`，不放任何可写控件（只有跳转按钮）。这一点是规划硬要求，评审时要能一眼看出来。

### 侧栏 nav 标记（`public/index.html`，替换现有 4 个 `<a>`）

```html
<a href="#overview"  data-view="overview"  class="active" aria-current="page"><span class="ic" aria-hidden="true">◎</span>概览<span class="nav-caption">01</span></a>
<a href="#providers" data-view="providers"><span class="ic" aria-hidden="true">▤</span>渠道与 Key<span class="nav-caption">02</span></a>
<a href="#routes"    data-view="routes"><span class="ic" aria-hidden="true">⑃</span>路由<span class="nav-caption">03</span></a>
<a href="#sessions"  data-view="sessions"><span class="ic" aria-hidden="true">◈</span>会话<span class="nav-caption">04</span></a>
<a href="#diagnostics" data-view="diagnostics"><span class="ic" aria-hidden="true">≣</span>诊断<span class="nav-caption">05</span></a>
<a href="#settings"  data-view="settings"><span class="ic" aria-hidden="true">⚙</span>设置与备份<span class="nav-caption">06</span></a>
```

### `app.js` 里必须同步改的三处

```js
const VIEWS = ['overview', 'providers', 'routes', 'sessions', 'diagnostics', 'settings'];
const VIEW_LABELS = { overview: '概览', providers: '渠道与 Key', routes: '路由',
  sessions: '会话', diagnostics: '诊断', settings: '设置与备份' };
```

以及 `view === 'logs'` 的**全部**分支（`refresh()` 里 136 行附近、nav onclick 里 152-155 行附近）改成 `'diagnostics'`。

### ⚠ 已知陷阱（必须一起改，否则静默坏）

1. **`gotoLogs()`（`app.js:1130-1131`）**：
   ```js
   document.querySelector('nav a[data-view="logs"]').click();
   ```
   改名后这条选择器返回 `null`，`.click()` 抛 TypeError，**会话页的"日志"按钮当场失效**。要改成 `data-view="diagnostics"`。建议顺手加一道存在性防御（拿不到就退回直接切视图函数），别让它再静默炸。
2. **`test/ui.test.js:95`** 硬编码了导航：
   ```js
   const nav = ['providers', 'routes', 'sessions', 'logs'].map(view => { ... });
   ```
   必须同步成 6 项（含 `overview`、`diagnostics`、`settings`），否则 `nav a` 的 click 断言与 `data-view` 查找会找不到元素。
3. **`test/ui.test.js:104-109`** 用 `parentElement` 手工搭了几个容器的从属关系（`rules-box`/`def-box`/`compact-panel`/`compact-window-panel` → `view-routes`）。新增两个 `<section>` 时，凡是断言"某控件在自己的视图里"的用例都要补上新的从属关系。
4. 新增的视图节必须**默认隐藏**，与现有写法一致（`style="display:none"`），由 nav 切换函数统一 `$('view-' + v).style.display`。
5. 侧栏顺序变了，`aria-current` 的初始值要从 `providers` 挪到 `overview`。

---

## 二、各页要显示什么（任务 4 / 6 / 8）

### 概览（任务 4）

只读，全部来自 `/api/state`：

- **服务版本** `state.version`；**源码修订** `state.code_revision`（截短显示 + `title` 给全长）；**进程** `pid`；**运行时长** `fmtUp(state.uptime_s)`；端口 `proxy_port` / `ui_port`。
- **客户端接入状态**：按 `state.live`（claude/codex/zcode）+ `state.current` 三行，复用 `liveLine()` 的判断口径（已写入配置 / 直连 / 尚未配置 / 配置读取失败），**不要**另造一套判定。
- **今日请求 / tokens**：`state.stats`。
- **客户端接入信息**：`state.router` 的 `claude_base` / `codex_base` / `zcode_base` / `endpoints`（这三个 base 是把客户端指向本机的地址，属于"我在哪里填什么"级别的高价值信息）。
- **需处理事项（新增，这是概览的核心价值）**：把"需要用户动手"的状态收成一张清单，每条带跳到对应页的按钮。**当前可见的问题**（都是在只读数据里已有的）：
  - 有渠道 `enabled === false` → "N 个渠道已停用"
  - 某渠道 `keys` 里存在 `enabled === false` 的 Key → "N 把 Key 已停用"（任务 4 要求渠道页显示"失效 Key"，这里给个总数并跳转）
  - `state.cooldowns.length > 0` → "N 个渠道冷却中"，列出渠道名
  - `state.routes` 里有池成员命中已删除渠道 → 主入口启动时会告警的**僵尸引用**（`ghostRefs`），概览应能看出"路由里有失效引用，命中即 503"
  - 有会话 `routing` 里引用已失效的渠道/Key → 面板里 `routingStaleOf()` 已能算，概览给总数
  - **"暂无"原则**：没有要处理的事就明确写"没有需要处理的事项"，不要留空白让人以为没加载出来。

### 渠道与 Key（任务 4）

现有渠道卡片增加：
- **失效 Key**：`p.keys` 里 `enabled === false` 的，在卡片上明确标出（"N 把 Key 已停用"），并在展开时看得出来是哪几把（只有 label 与 id，**绝不显示 Key 明文**——`test/session-routing-ui.test.js` 有反向断言盯着这条）。
- **健康状态**：`state.cooldowns` 里该渠道是否冷却中（冷却到什么时候）；`/api/health` 的熔断器状态。**注意**：`/api/health` 目前前端一次都没调用过，加它要新增一次 fetch，并处理失败（健康端点挂了不能拖垮整页渲染）。

### 路由（任务 4）

要求"显示主目标、后备、协议、配置来源与最近实际落点"：
- 主目标 / 后备：规则卡的 `provider` 与 `pool`（已有 `ruleTargetBox()`），补上**协议**（该渠道的 `wire_api`）。
- **配置来源**：该规则是默认路由还是显式规则、池策略（`strategy`）。
- **最近实际落点**：来自会话的 `actual`。**不要**用预览（`/api/routing/preview`）冒充实际落点——这是第二期的硬要求。**没有实际请求记录时显示"暂无"**。
- 压缩部分见下。

### 压缩（任务 6）

要求：**分开显示专用模型/Key、窗口层级和客户端生效范围**；且"保存成功、配置已写盘、服务已加载、旧客户端需重开分别表达，不统一显示成'已生效'"。
- 现状 `compact-msg` / `window-msg` 是单条 `msg` 文本，容易把四件事揉成一句。要拆成可区分的状态表达（至少：**已写盘** vs **已加载** vs **客户端需重开**）。
- 窗口层级已有 `window-layers` / `window-coverage` / `window-warnings` / `window-restart` 四块，检查它们是否已各自表达清楚，不足则补，**不要推倒重来**。

### 设置与备份（任务 8）

要求：收拢**日志、健康、路由解释、备份恢复及脱敏诊断导出**入口。现状前端对 `/api/backups`、`/api/health`、`/api/routing/preview`、`/api/metrics` **零引用**——后端有端点，前端没有任何入口。本页就是把它们接出来：

- **备份清点**：`GET /api/backups` → `keep` / `dirs[]{ id, label, dir, ok, total, legacy, backups[], unparsable[], next_delete[] }`。显示每个池的份数、下一次会删哪几个、保留上限。**响应里没有任何配置正文或密钥**（服务端已保证，前端也**不要**去请求正文）。
- **健康**：`GET /api/health`（熔断/冷却/超时与重试配置）。
- **路由解释**：`GET /api/routing/preview`（只读预览，**不得消耗游标、不得写绑定**——服务端已保证，前端只读）。
- **脱敏诊断导出**：`GET /api/metrics` 是 Prometheus 文本格式，可作为"导出"的一种。**注意**它靠标签集固定来保证不含密钥；导出下来的文件里也不应有密钥。若要做成"下载"，用 `Blob` + `URL.createObjectURL`，**不要**引入新依赖。
- **恢复/回退**：`lib/cli/restore.js` 与 `/api/backups` 只提供清点；**真正的恢复写入不在本期做**（规划 §5.4 才涉及发布与回退）。本页只做"看得见 + 能导出"，**不要**加"一键恢复"按钮（那是危险动作，且没有接口）。

### 刷新协调（任务 7）

要求：统一刷新协调、取消过期读取或丢弃旧结果、快照与草稿分离、保留 revision/409 冲突处理、切客户端/轮询/后台报错不得抹掉用户正在编辑的值。

现状已有较多机制：`refreshTask` 去重、`logsSequence` / `statsSequence`（丢弃过期响应）、`routesRevision` / `compactRevision` 冲突号、`windowLoadTask`、以及 `refresh()` 里"会话表格正在被编辑就不重渲染"的保护。**本任务多半是核查+补齐，不是重写**：
- 逐条核对上面每个机制**在新增页面后仍然成立**（尤其"概览/设置页的 fetch 失败不能影响其它页的草稿"）。
- 发现空档再补，**不要**为"统一"而重写已工作的去重逻辑（本仓库的教训：为统一而重写会引入静默回归）。

---

## 三、实施顺序（避免文件互相踩）

1. **C1 页面重组**（任务 3）：nav + `VIEWS`/`VIEW_LABELS` + 两个新 `<section>` 骨架 + `gotoLogs` 陷阱 + 两个 UI 测试的 harness 同步。**必须全绿后再动内容**。
2. **C2 内容充实**（任务 4/6/8）：概览的需处理事项、渠道失效 Key/健康、路由来源、压缩分账、设置页四个入口。
3. **C3 刷新协调核查**（任务 7）：逐机制核对 + 补测试。

C1 与 C2 分开的理由：重组是"搬"，充实是"加"。混在一起时，测试红了分不清是搬错还是加错——规划 §5.2 风险节的原话是"文件移动与语义调整混在一起会使回归难以定位"。

---

## 四、不可动摇的约束

- **不引入打包器、前端框架或任何新依赖**（规划 §2.5 明文）。
- **不新增第二套路由编辑器**；每项配置只有一个主要编辑入口。
- **不用预览冒充实际落点**；没有记录就是"暂无"。
- **不显示任何 Key 明文**（只有 label 与 id）；`test/session-routing-ui.test.js` 已有反向断言。
- **不删除既有测试**来换取重构顺利（规划 §2.5 / §5.3 验收）。
- 保持回环监听与跨站写保护（`lib/http/console.js` 的 `Sec-Fetch-Site` / `Origin` 判定），新页面**不得**引入任何放宽。
- 新增资源（CSS/JS）不得被 `lib/runtime-code.js` 的源码指纹算进去——它只 walk `lib/**/*.js` 与 `mixrouter.js`，`public/` 天然排除。**这是刻意的**（改样式不该要求重启服务），但也意味着**静态资源没有版本信号**：规划 §5.3 风险节说的"缓存可能造成新旧资源混用"正指此处，故本期**不加缓存**（任务 1 已定"初期保守缓存"= 不缓存）。
