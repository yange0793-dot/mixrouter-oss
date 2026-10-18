# 第二期：TOML 单一实现

日期：2026-10-16

状态：实施完成，受影响回归通过；尚未 commit、push 或上线。规划条目见
[重构规划](refactor-plan-2026-10-16.md) 的 5.2 节第 6 条。

## 目标与结论

以 `lib/codex-config.js` 作为 **唯一** 的 Codex TOML 解析与改写实现。旧 `lib/codex-toml.js`
与 `lib/toml.js` 退化为**薄适配**：只做参数与返回形状的转换，自身不含解析、写行或转义
算法。这样既保住了既有调用与测试按名字取的导出面，又不维护第二份实现。

旧文件里被删掉的算法：

| 旧位置 | 旧算法 | 现在 |
| --- | --- | --- |
| `lib/toml.js:11` | `tomlStr` 自己转义 `\` 与 `"` | `codex-config.quote`（JSON.stringify） |
| `lib/toml.js:18` | `codexTopLevel` 自己扫第一个 `[section]` 之前的行 | `codex-config.topLevel`（结构化 parse） |
| `lib/codex-toml.js:16` | `removeOwnSections` 用行状态机删 `mixr-*` section | `codex-config.removeOwnSections`（按 section 范围） |
| `lib/codex-toml.js:32` | `setTopLevel` 用正则认顶层键并原位替换 | `codex-config.setTopLevel`（交给 patch） |
| `lib/codex-toml.js:53` | `providerSection` 用本地 `tomlStr` 拼行 | `codex-config.providerSection`（用 quote） |

## 改动文件

- `lib/codex-config.js`：新增薄适配导出 `MIXR_SECTION_RE`、`removeOwnSections`、`setTopLevel`、
  `providerSection`；把「哪些 section 是本产品写的」收成一个 `MIXR_SECTION_PREFIX`，
  patch 的清理与适配层共用同一判据。
- `lib/toml.js`：由 29 行的独立实现缩到 17 行的纯别名导出。
- `lib/codex-toml.js`：由 67 行的行状态机缩到 27 行的纯别名导出，并加一条载入期自检
  （codex-config 改了导出名时，失败点停在 require，不拖到写客户端配置文件那一刻）。
- `test/codex-config.test.js`、`test/backup-restore.test.js`：补兼容与边界回归。
- 新增 `test/codex-toml.test.js`、`test/toml.test.js`：钉住旧名字的契约与「别名而非复制品」。

## 保住的契约

- **函数签名与返回形状**：`removeOwnSections(text)` 仍返回行数组；`setTopLevel(kept, opts)`
  仍返回 `{ lines, hasModel, hasProvider }`；`providerSection` 仍返回带前导空行的行数组；
  `MIXR_SECTION_RE` 仍是同一个正则实例；`tomlStr` / `codexTopLevel` 仍是同一对名字。
- **错误类型与状态码**：解析失败一律 `statusCode === 400`，错误文案不变
  （「Codex TOML 存在重复键 …」「… 字符串未闭合」「… 无法安全解析，未写入」等）。
- **输出文本**：`quote` 的输出是合法 TOML 基本字符串；顶层键原位替换、缺失才补到最前；
  `keepModel` 时顶层模型名保持原值。
- **自定义 section 与 profile 一律不碰**：patch 不改 `[profiles.*]` 内的 `model` /
  `model_provider`，不删用户自己的 `[model_providers.*]`，`mixr-` 前缀只对
  `model_providers` 生效。
- **patch 后重新解析**：`codex-config.patch` 结尾仍 `parse(result)` 一遍，写出去的东西
  必须是能读回来的文档。
- **备份还原的安全边界不跟着放宽**：`lib/backup/restore.js` 的 `validateToml` 是**独立**
  的保守校验器，只接受普通表与单行字符串、布尔、十进制数。新解析器能吃下数组、内联表、
  多行字符串、日期、`0x`、前导零、点分键、数组表 —— 这些在还原路径上仍然 `unsupported_toml`
  拒绝。新增回归 `a wider Codex parser does not widen the restore safety boundary`
  把这两个边界的分离钉在代码里，并带反证（受支持子集的写法必须放行）。

## 有意的行为收窄（不是回归）

1. **重复顶层键从"取第一条"变成拒绝**。旧 `codexTopLevel` 遇到
   `model = "a"\nmodel = "b"` 返回 `"a"`，而写入侧按"存在即替换"处理 —— 同一份文件两边
   理解不一致。现在统一按坏文档拒绝（400）。理由：宁可让调用方去修文件，也不要按残值
   改写用户配置。
2. **`tomlStr` 的转义范围变宽**。旧版只转义 `\` 与 `"`，遇换行/制表符会原样吐进字符串，
   写出 `model = "a<换行>b"` 这种非法 TOML；现在统一 `JSON.stringify`，换行写成 `\n`、
   控制字符有 `\u` 形式。这是修真实缺陷，不是放宽。

两条都已被既有断言钉住（`test/codex-config.test.js` 的往返用例），不新增"已知限制"式说明。

### 收窄的作用范围（只写不读）

两条收窄都只落在**写入/校验**路径上：`switchCodexRouter`、`writeCodexConfig`、
`updateCodexConfig` 撞上坏文档会拒绝且不写盘。**只读路径不许跟着抛**：

- `lib/codex-config.js` 的 `state()` 自己 `try/catch`，降级成
  `{ match: false, error: <原因>, warnings: ['读取失败时禁止写入，不会以空配置覆盖原文件'] }`；
- `mixrouter.js` 的 `liveState().codex` 走的就是 `state()`，所以控制台状态面板照常渲染，
  并显示读取失败的原因。

用例：`Codex TOML read paths degrade to "no value" instead of throwing on broken documents`、
`Codex refuses invalid TOML instead of replacing it with an empty config`。

### 重复键报错的定位能力

现网文件若真有重复键，用户是在点保存时才撞上拒绝的，所以文案必须指得到具体键，否则用户
只能把整份 `config.toml` 读一遍去猜。实测报错带**完整路径**：

| 输入 | 报错 |
| --- | --- |
| `model` 出现两次 | `Codex TOML 存在重复键 model` |
| `[model_providers.x]` 下 `name` 重复 | `Codex TOML 存在重复键 model_providers.x.name` |
| `[a.b]` 下 `name` 重复 | `Codex TOML 存在重复键 a.b.name` |
| `"model"` 与 `model` 混写 | `Codex TOML 存在重复键 model`（引号键与裸键归一后同路径） |

用例：`Codex TOML duplicate-key refusal names the offending key and its table`。

### `quote` 输出的 TOML 合法性（含 DEL 修正）

JSON 与 TOML 的基本字符串转义语义一致（`\b \f \n \r \t \" \\ \uXXXX`），所以借
`JSON.stringify` 是安全的 —— **但 DEL 是例外**：TOML 1.0 要求 U+007F 必须转义，而 JSON
允许原样输出。已补一行把 `\u007f` 转义。

不补的话有一条自相矛盾的路径：写入侧能吐出含裸 DEL 的文本，而 `lib/backup/restore.js` 的
`validateToml` 按 TOML 规则拒绝它 —— 自己写出去的备份过不了自己的校验。现在两侧对齐。

用例：`Codex TOML quote emits a legal TOML basic string for every control character`
（把 U+0000–U+001F 与 U+007F 逐个过一遍并断言能读回原值，含"写出的文本必须过 validateToml"）、
`Codex TOML quote keeps its non-string and empty-input contracts`（`null`/`undefined`/空串 →
`""`，数字与布尔 → 字面量串，有效代理对原样保留）。

## 验证

只跑受影响回归，统一走 `scripts/run-tests.js` 隔离入口；只用临时目录与本地夹具，不出网、
不碰真实客户端配置。未运行全套、未运行 smoke（第一期同版结果已记录，本次不重复）。

```
node scripts/run-tests.js test/backup-restore.test.js test/backup-api.test.js \
  test/backup-cli.test.js test/backup-compare.test.js test/backup-file.test.js \
  test/backup-inventory.test.js test/backup-naming.test.js test/backup-pool-watch.test.js \
  test/codex.test.js test/codex-config.test.js test/codex-toml.test.js test/toml.test.js \
  test/switch.test.js test/helpers.test.js test/modules-wiring.test.js
```

Node v24.18.0，15 个文件，**243 通过、0 失败、0 跳过**，耗时约 6.4 秒。

合并前另做了一次**差分验证**：把旧 `lib/toml.js` / `lib/codex-toml.js` 复制到仓库外的临时
目录，对同一批输入逐项比较旧实现与新适配层的返回值。转义、顶层键读取、删 section、
`setTopLevel` 的行数组与两个布尔、`providerSection` 全部逐项相同；差异只有上面「有意的
行为收窄」那两条。

## 未测范围与交给 main 的装配改动

- 未重复跑全套与离线 smoke；未跑真实付费上游、桌面外壳与浏览器。
- `mixrouter.js:82` 的 `const codexToml = require('./lib/codex-toml')` 是**死引用**
  （全树已无 `codexToml.` 成员访问）。删除它属于 `mixrouter.js` 的装配面，本任务不动该文件。
- `mixrouter.js:84` 与 `mixrouter.js:1723–1724` 的注释仍写「与 lib/toml.js + lib/codex-toml.js
  是同一件事的两套实现」，合并后已不成立，建议一并改为「旧名字只是 codex-config 的薄适配」。
- `lib/codex-toml.js` 的 `buildCodexConfig` 已无调用方（`writeCodexConfig` 改走
  `codex-config.patch`），作为别名保留，未在本次收窄导出面。
