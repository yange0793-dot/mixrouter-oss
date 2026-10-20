# 故障排查

这份文档按**症状**组织。每条先给可执行的排查命令,再给判据与处置。原则是:先看日志与
只读诊断,再谈改配置;不要在没定位前就重启或改 Key。

开始之前记住两件事:

- `./mixctl` 指仓库根的 `mixctl`;**多数命令需要控制台在跑**(走 `http://127.0.0.1:8788`);
  `backups` / `restore` / `gc` 是本地命令,与 `mixrouter.js` 无关。
- 请求日志在 `<MIXR_DATA_DIR>/logs/requests.jsonl`;旧入口默认数据目录是仓库根,
  `npm run local` 默认是 `~/.local/share/mixrouter/data`。**日志里不含 Key 明文**
  (只有 `key_id` / `key_source` 这类非明文来源字段)。

---

## 0. 先分清"服务有没有在跑"

包含新入口的源码/新版运行包可先跑 `npm run doctor`;只查文件、不连端口用
`npm run doctor -- --offline`。它不调用上游、不修改配置,也不会打印 Key 或会话内容。
默认数据目录与 `npm run local` 一致;旧部署用 `--data-dir <原数据目录>`。
纯 JSON 输出用 `npm run --silent doctor -- --json`,分享前检查其中的本机路径。
v3.6.1 发布包尚不含这个命令,使用下方旧入口诊断。

`npm run local` / `npm start` 的前台进程不写 `mixctl` PID 文件。对它们请看运行终端与
`doctor` 的回环服务结果,不要因 `mixctl status` 的“进程:未运行”就再启动一个服务。
以下 PID 判据仅适用于通过 `mixctl` 或 launchd 启动的部署:

```bash
./mixctl status
curl --fail http://127.0.0.1:8787/healthz
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/
```

`./mixctl status` 输出里的三个字段各有含义,别混:

| 输出 | 判据 |
| --- | --- |
| `进程` | `未运行` / pid。说"未运行"而 `curl` 又能通 → 你连的是**另一个实例**(见 §7 端口) |
| `版本` | `package.json` 的 `version` |
| `代码` | `已加载当前源码 <sha>` / `⚠ 源码已更新,运行进程仍是旧版` / `⚠ 无法核对已加载版本` |

**`/healthz` 回 200 只能证明进程活着,不能当作补丁生效的证据。** 判据是 `代码` 那一行:
它比服务启动时记下的 `/api/state.code_revision` 与磁盘当前源码的 SHA-256(`lib/runtime-code.js`)。

---

## 1. 请求 503:先看错误码

代理的错误码是分型的,`err_class` 与响应体里的 `error.type` 会直接告诉你该往哪查。

| 错误码 | 常见原因 | 怎么查 |
| --- | --- | --- |
| `no_route_error` | 没有匹配的路由,或规则指向已删除渠道(**僵尸引用**) | `./mixctl explain <claude\|codex> <模型>`;看返回值里的 `ghosts` |
| `provider_disabled_error` | 命中的渠道被停用(`enabled: false`) | `./mixctl ls`,渠道名后带 `(停用)` |
| `provider_key_unavailable_error` | 覆盖 / 压缩规则点名的 Key 被删、停用、重复或为空 | 控制台「渠道与 Key」页看失效 Key;`./mixctl sessions config <完整会话键>` |
| `wire_api_mismatch_error` | 路由命中的全是 `responses` 渠道,而客户端说的是 chat(或反过来) | `./mixctl ls` 看每个渠道的 `(responses)` / `(chat)` |

排查命令(只读、零副作用):

```bash
./mixctl ls                                  # 渠道 + 规则 + 当前生效 + 配置漂移标记
./mixctl explain claude claude-opus-5        # 这条请求会走哪条规则、落到哪个渠道、为什么
./mixctl explain claude claude-opus-5 --json # 结构化输出,失败时也输出可解析对象且 exit 1
```

### 僵尸引用(路由指着已删除渠道,命中即 503)

这是最容易被误判成"规则没生效"的一类。`no_route_error` 的文案会**直说**哪条规则指向了哪个已删
渠道(见 `lib/proxy/prepare.js` 的 `badRoute`),不会笼统报"没有匹配的路由"。服务启动时
`reportGhostRoutes()` 也会把全部僵尸引用打到服务日志:

```
[mixrouter] 路由里有 N 处僵尸引用(渠道已删除,规则还指着它)——命中这些规则的请求会直接 503:
  - 规则 r3(match "haiku")的provider指向已不存在的渠道 p2
  - 兜底路由的pool指向已不存在的渠道 p9
  请在控制台 http://127.0.0.1:8788 的「路由」页重新选择目标渠道。
```

怎么来的:删渠道时虽然会顺手解开引用,但 `routes.json` 可能是手改的、或从旧备份恢复的。
`PUT /api/routes` 现在会在写入时拒绝指向不存在渠道的规则(400);**读盘时**不拦,只告警——
为的是让你能看见并修,而不是拒绝启动。

处置:控制台「路由」页重新选择目标渠道,或删掉那条规则。

### 渠道停用 / 被删

```bash
./mixctl ls        # [停用] 标记;渠道列表里没有它 = 已被删除
```

停用只在控制台勾回 `enabled` 即可。删除会让引用它的规则/槽位/会话覆盖变成失效引用——上一条。

---

## 2. 渠道冷却与失败重试

**症状**:某渠道短时间内所有请求都失败,或"主渠道明明好好的却不用它",或一次请求迟迟不返回。

```bash
./mixctl sessions      # 末尾会列「冷却中的渠道」及剩余秒数
curl -s http://127.0.0.1:8788/api/health | python3 -m json.tool
```

`/api/health` 是只读视图,返回三段超时、重试与冷却配置,以及每个渠道的
`{provider, app, enabled, eligible, cooldown_until}`:`eligible` 是此刻能不能被挑中,
`cooldown_until` 是冷却截止时间(不在冷却时为 `0`)。

判定规则:

- **冷却**:429/5xx/连不上 → 打冷板凳,时长 `MIXR_COOLDOWN_SEC`(默认 60 秒)。
- **4xx**:证明渠道连通,只是这次请求有问题;处理和 5xx 一样,只进冷却。
- **冷却不拒绝请求**:冷却中的渠道通常不参与挑选,**全池都在冷却时仍会退回全量候选**,
  挑一个发出去。所以"全池冷却"不等于 502,客户端看到的可能是更慢的响应。
- **重试**:一次请求最多打 `MIXR_MAX_ATTEMPTS` 次上游(默认 10,同一个渠道会被重复尝试),
  每次重试前等待 `MIXR_RETRY_DELAY_MS`(默认 1000 毫秒)。渠道集中故障时,请求会按这个节奏
  重试到上限才失败;调小等待能更快拿到失败结果,调大则给上游更多恢复时间。
- **端到端总预算优先**:`MIXR_TOTAL_DEADLINE_MS` 用尽后不再重试,即使次数没用完。

**手动指定即视为"这个渠道我要用"**:控制台改绑 / `pin` 会清掉该渠道的冷却。

如果怀疑是临时故障把**手动钉定**废掉了,看会话记录:钉定值应当保住,`actual` 记录真实新落点。
当前实现的判据是"记录是钉定的就直接不许自动落点回写",所以渠道恢复后下一条会回到钉定的渠道;
若行为不是这样,先把 `./mixctl sessions config <完整会话键>` 的输出与 `/api/logs` 里的
`sticky` / `slot` 字段一起留证。

---

## 3. Key 失效

**症状**:401/403,`err_class` 是 `authentication`;或 `provider_key_unavailable_error`。

```bash
./mixctl logs --status err --err_class authentication --limit 50
./mixctl ls                                        # 渠道级
```

分三种,处置不同:

- **渠道本身 Key 被上游拒**:在控制台渠道弹窗里换 Key 或切账号。多 Key 渠道的「API key」是一颗
  下拉,点一下即切账号,立即生效,不用重启。换完在**直连模式**下需要点「重新写入」同步客户端配置;
  路由模式下不用管。
- **老式单 Key 渠道加第二把时把原 Key 挤掉**:渠道一旦有 `keys` 清单,弹窗顶栏那个单行 API Key
  就**不再参与保存**,清单是唯一真相。加第二把时留空的「账号1」会按原 Key 解析——若发现原账号
  没了,检查是不是把清单整体替换成了一行新的。
- **会话覆盖 / 压缩固定 Key 点名的那把不可用**:这是**有意的硬失败**,不会降级到渠道当前 Key。
  用 `./mixctl sessions config <完整会话键>` 看覆盖,`set-key … --inherit` 摘掉,或 `reset … --yes`
  清空重配。压缩规则的固定 Key 在控制台「路由 → 压缩模型」里重选。

**Key 明文不在日志里**:日志只有 `key_id` / `key_source`;控制台只拿得到掩码(`key_masked`)。
命令行 `sessions` 子命令也**不接受 Key 明文**(argv 会进 shell 历史与 `ps` 输出)。

---

## 4. 会话粘性异常

**症状**:同一个对话中途换了渠道(打断 prompt 缓存);或反过来,配置改了却没换。

先确认身份是怎么认出来的——**同一个对话里的所有请求应当共享同一个会话键**:

```bash
./mixctl sessions                       # 每行:分组 / 短 id / 渠道 / 请求数 / 对话标签
                                        # 末尾另附**完整会话键**逐条列出(带覆盖的标 *)
./mixctl logs --session <会话> --limit 50
./mixctl logs --slot none --limit 50    # 未命中槽的请求
```

| 客户端 | 1 | 2 | 3 |
| --- | --- | --- | --- |
| Claude Code | `x-claude-code-session-id` 头 | body `metadata.user_id` 里的 `session_id` | 内容指纹 `fp:` |
| Codex | `session-id` / `thread-id` / `x-client-request-id` 头 | body `prompt_cache_key`、`client_metadata.session_id` | 内容指纹 `cxf:` |

常见原因:

- **客户端没带会话头**(自定义客户端、中间有别的代理剥了头)→ 退到内容指纹 `fp:` / `cxf:`。
  此时"同内容即同对话";内容变了就是新对话,看起来就是"粘性丢了"。日志里的 `session_kind`
  会告诉你走的是哪一档。
- **手动改绑压过策略**:被钉定的对话不会按策略轮转。`./mixctl sessions` 里带 `★钉定` 的就是它。
- **会话过期**:空闲 `MIXR_SESSION_TTL_MIN`(默认 720 分钟 = 12 小时)后自动过期,下一条请求重新
  按策略分配。粘性异常先看是不是超过了 12 小时。
- **内容分流命中的请求不参与会话粘性**:它只代表"这一条请求"走那条路,不代表对话换了渠道。
  所以看到某一条请求落点不同,不一定是 bug——查那条请求的 `rule` 与日志里的 `sticky` 字段。
- **槽位请求不改对话绑定**:槽位(如 `mixr-haiku` 的标题生成)按槽位表直落,**不会**把对话重新绑到
  槽位渠道。这是有意的:否则下一条主模型请求会跟着跑偏。反过来,被手动改绑过的对话也不会把槽位
  请求拽到被钉定的渠道上。

**低可信身份不能新建覆盖**:`fp:` / `cxf:` / `anon` 这类身份 `PUT /api/sessions/:key/routing`
返回 400——内容指纹不足以当作稳定的配置对象。要配覆盖得先让客户端带上真实的会话 id。

---

## 5. 压缩没生效

**症状**:压缩请求走了主模型渠道,或压缩窗口"保存成功"但没感觉。

压缩识别是**内容分流**,判据很严:**只读最后一条 user 消息的直接文本块**,必须以发行版 CLI 的
压缩固定前导开头,并包含摘要模板。system、历史消息、工具结果、仅仅引用特征短语的编程任务都不算。

```bash
./mixctl explain --input preview.json          # 带 --input 时不能再给位置参数(模型名)
./mixctl logs --history --json --limit 100 | grep -i compact
```

`--input` 吃的是**预览输入对象**,不是原始请求体;压缩判据读的是其中
`context.compactTexts`(末条 user 消息的直接文本块数组):

```json
{
  "app": "claude",
  "model": "claude-sonnet-5",
  "context": {
    "compactTexts": ["<最后一条 user 消息里的直接文本块>"]
  }
}
```

用 `--input -` 从 stdin 读同一形状:

```bash
echo '{"app":"claude","model":"m","context":{"compactTexts":["…"]}}' | ./mixctl explain --input -
```

判据核过发行版 CLI 2.1.282 的代码与离线反例,**未抓真实压缩请求包**;CLI 更新后判据可能失准
——这时用 `explain` 喂同形状的输入复现最直接。

**压缩窗口"保存成功"的三种不同含义**(别混成一件事):

1. **已写盘** —— 磁盘配置里的 `autoCompactWindow` 改了;
2. **已加载** —— 运行中的会话是否用到新值;保存**不会热改**运行中的会话;
3. **客户端需重开** —— 项目层设置须新开会话,或退出后在该项目目录用 `claude --continue` 继续。

`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 环境值优先于磁盘设置,托管策略与 `--settings` 也可能覆盖;
控件**无法清除环境覆盖**。项目层与本地层要填项目绝对路径,没填时界面显示的是磁盘设置,
**不冒充活会话实际窗口**。

---

## 6. 客户端没接入

**症状**:客户端还在直连上游,或报"连不上""模型不存在"。

```bash
./mixctl status     # 看两个口
./mixctl ls         # 每组的「当前生效」那一行会显示 路由模式 http://127.0.0.1:8787 或具体 base_url,
                    # 以及 ✓(一致) / ⚠配置漂移
```

- **`⚠配置漂移`**:库内选中的渠道与客户端磁盘配置对不上。直连模式下换过 Key / 渠道就要重新写入
  ——在控制台点对应渠道卡片上的「重新写入」,或重跑 `./mixctl route`(路由模式)。
  路由模式下不用管。
- **客户端 base_url 填错**:Claude Code 填 `http://127.0.0.1:8787`(**不带 `/v1`**),
  Codex 填 `http://127.0.0.1:8787/v1`(**带 `/v1`**)。
- **模型名不存在**:路由规则按模型名**子串**匹配,都不命中才走兜底路由;兜底路由没配目标就 503。
  `./mixctl explain` 能直接告诉你是没命中规则还是目标为空。
- **ZCode 新模型没出现**:重启客户端并新建会话;控制台显示的是「已注册的接入配置」,
  **不是**正在运行的 ZCode 会话所选模型。
- **`wire_api: responses` 的渠道不能直连**:它只挂 Codex 型通道,直连 `/v1/messages` 必然失败。
  控制台里那颗「切换」按钮是禁用的,请改用路由模式。

客户端配置的读写路径:`MIXR_CLAUDE_SETTINGS`(`~/.claude/settings.json`)、
`MIXR_CODEX_CONFIG`(`~/.codex/config.toml`)、`MIXR_ZCODE_CONFIG`(`~/.zcode/v2/config.json`)。
每次改写前都会自动备份。

---

## 7. 端口被占 / 起不来

服务启动失败时的原话是:

```
启动失败: <原因>(端口 8787/8788 是否被占用?)
```

`mixrouter.js` 的 `listen()` 不绑 `0.0.0.0`,只绑 `127.0.0.1`。

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
lsof -nP -iTCP:8788 -sTCP:LISTEN
```

占用的可能是**另一份 mixrouter**(旧 clone、上次没停掉的常驻实例)。判据不是"端口能通",
而是 `./mixctl status` 报的 pid 与 `lsof` 报的 pid 一致。对不上就说明你连的不是这一份。

- 换端口:`MIXROUTER_PORT=8787 MIXUI_PORT=8788` 改端口,但记得**端口类变量必须在 `npm start`
  之前设**(模块顶层读取)。
- **兼容监听**:`MIXROUTER_ALT_PORTS=15721`(逗号分隔)让本进程在别的端口上也服务同一个代理,
  用于接管「旧客户端把 BASE_URL 写死到旧代理端口」的场景。best-effort:端口被别人占着只告警,
  不影响主端口。
- 装 `*.mixrouter.plist` 的机器上,`./mixctl start` 会走 `launchctl kickstart`,不再另派生进程。
  **安装前**用 `scripts/install-macos.sh`(默认干跑)会先检查两个端口是否空闲,占用即失败。

> 端口设成 `0` 时,`/api/state` 的 `proxy_port` / `ui_port` 仍回配置常量(`0`),真实绑定端口只在
> 启动横幅里。这条历史遗留见 [`offline-run-and-acceptance.md`](offline-run-and-acceptance.md) §2。

---

## 8. 日志在哪、怎么读

| 文件 | 内容 | 谁在管 |
| --- | --- | --- |
| `<MIXR_DATA_DIR>/logs/requests.jsonl` | 每条请求一行 JSON,32 个白名单字段 | 按 UTC 日界 + 5MiB 轮转 |
| `<MIXR_DATA_DIR>/logs/requests.jsonl.old` | 更早的遗留轮转文件 | **只读、不清理、不压缩** |
| `<MIXR_DATA_DIR>/logs/responses/<id>/` | 返回正文归档(**默认关闭**) | `lib/log-retention.js`,默认保留 2 天 |
| `<代码目录>/logs/launchd.log` | launchd 把 stdout/stderr 重定向到这里 | `lib/log-retention.js`,默认保留 2 天 |
| `<代码目录>/logs/server.log` | 服务日志 | — |

`requests.jsonl` 的关键字段:

| 字段 | 含义 |
| --- | --- |
| `attempts` / `failover` | 实际网络尝试次数 / 是否发生过失败转移 |
| `err` / `err_class` | 终态错误文本 / 错误分型(`authentication`、`rate_limit`、`upstream_server`、`timeout`、`cancelled`…) |
| `slot` | 命中的槽位;空槽记 `none`,缺字段的旧日志记 `unknown` |
| `sticky` / `strategy` / `rule` | 是否走了会话粘性 / 用的策略 / 命中的规则 id |
| `key_id` / `key_source` | 用的是哪把 Key(**非明文**的来源标记) |
| `effort` | **真的发上去的那一档**思考强度(转换层报回来的),不是客户端想要的那档 |
| `model_in` / `model_out` | 客户端说的模型 / 实际发给上游的模型 |
| `bytes_in` | 客户端请求体字节数。首字慢但输出很快时先看这一栏:带截图的历史会让请求体涨到十几 MB,而这段时间上游面板里看不见 |
| `think` / `reasoning` / `tools_dropped` | 排查上游 400 的关键证据 |

### 用 `mixctl logs` 查(需服务运行)

```bash
./mixctl logs 50                                     # 内存中最近 50 条
./mixctl logs --status err --err_class timeout       # 按分型筛
./mixctl logs --app claude --slot subagent --json
./mixctl logs --history --since 2026-09-01T00:00:00Z --until 2026-09-29T23:59:59.999Z --limit 100
```

- 默认查当前进程**内存环**(最近 500 条),默认返回 20 条,**重启后内存环重新开始**;
  查旧记录必须显式 `--history`。
- `--since` / `--until` 包含两端边界,接受 ISO 时间或 epoch 毫秒;建议带 `Z` 或明确时区。
- `--provider`、`--model`、`--session`、`--err_class` 是忽略大小写的**子串**筛选;`--slot` 精确匹配;
  `--status` 接受 `ok`、`err` 或具体状态码。
- `--history` 每页最多 1000 条,响应给 `scope`、`skipped`(跳过的坏行/超长行)和 `next_cursor`。
  下一页用 `--cursor <next_cursor>` 并保留原筛选条件(它隐含 `--history`)。
- 游标是**当前进程的历史快照**,按物理追加顺序从新到旧读,不是按时间戳重排;最多保留 15 分钟、
  进程最多存 32 个快照。`CURSOR_EXPIRED` = 重新发起历史查询;`CURSOR_INVALID` = 检查游标和筛选条件。
  **不能把游标当永久书签。**
- **控制台连不上时**:`mixctl logs` 会退回本机 `requests.jsonl` 的只读尾读(有界反读、坏行跳过),
  只支持位置式条数——带选项的查询没有文件版对应物。只有**连不上**才退回;真的 API 报错原样报到
  stderr 并以非 0 退出。

### 聚合统计

```bash
curl -s 'http://127.0.0.1:8788/api/stats' | python3 -m json.tool
curl -s 'http://127.0.0.1:8788/api/stats?history=1' | python3 -m json.tool
```

`by_slot` 按日志里**明确记录**的槽位累计;空槽记 `none`,缺字段的旧日志记 `unknown`,
**不拿模型名或会话类型猜槽位**。两种统计都返回 `scope` 与 `range`,明确内存/磁盘来源与实际记录范围。
这是用量统计,**不做金额折算**,也不是预算限流。

### 磁盘日志清理

```bash
./mixctl gc            # 预览:只报数,不动盘
./mixctl gc --apply    # 真删
./mixctl gc 7 --apply  # 按 7 天保留
```

清的是 `responses` 归档目录与 `launchd.log`(`MIXR_LOG_RETAIN_DAYS`,默认 2 天,`0` 关闭),
**不碰** `requests.jsonl`。服务内定时器与 `mixctl gc` 共用同一份逻辑,靠 `logs/.retention.lock`
串行——服务在跑时执行也安全。单轮最多删 2000 个归档目录。

---

## 9. 备份与还原(本地命令,不需要服务)

```bash
./mixctl backups                     # 列出三处备份池
./mixctl backups settings.json       # 按文件名前缀筛选
./mixctl backups --diff <备份名>      # 预览一份备份与现役文件的差异(脱敏)
./mixctl restore <备份名>             # 默认只预览,不写文件
./mixctl restore <备份名> --yes       # 确认后执行恢复
```

`backups` 与 `restore` 都是**本地命令**,只读本地备份,不会创建、改写或删除文件(除非 `restore --yes`)。
清点当前覆盖 `providers.json`、`~/.claude/settings.json`、`~/.codex/config.toml` **三处**;
ZCode 的备份暂未纳入。备份保留上限 5 份,轮换在**删除发生之前**预警。

常见问题:

- **`unsupported_toml`**:TOML 只接受普通表及单行字符串、布尔、十进制数。数组、内联表、多行字符串
  等合法但超出子集的语法会被拒绝。**这是拒绝自动恢复,不是判定原配置损坏**——先自行检查原文件与
  备份,不要为了让命令通过而删掉配置。
- **`undecidable_target`**:未给 `--file` 时按备份名推导受管现役文件,推不出或有歧义就拒绝。
  用 `--file <受管现役路径>` 显式指定。
- **还原只接受原目录里的 `.bak-mixui-*`**:不接受任意文件复制,拒绝符号链接、硬链接、目录和超过
  512KiB 的文件。备份内容须通过 UTF-8 与格式校验;写入前会另存安全备份,保留旧备份,再原子替换。

升级与回退的完整流程见 [`upgrade-and-rollback.md`](upgrade-and-rollback.md);
字段与变量的完整清单见 [`reference.md`](reference.md)。

---

## 10. 兜底:先跑这三条

环境是不是好的、问题在代码还是在环境,按这个顺序过一遍就够:

```bash
node -v                                  # 需要 ≥ 18
npm test                                 # 全绿;不需要 install
npm run smoke                            # 退出码 0 = 全绿;零 Key、不出网、不占 8787/8788
```

若 `npm run smoke` 挂了,按它的 FAIL 行定位——它的端口归属硬闸门会明确区分"我起不来"与
"那个口上是别人的实例"。完整验收清单见 [`offline-run-and-acceptance.md`](offline-run-and-acceptance.md)。
