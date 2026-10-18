# mixrouter 第一期实施记录

日期：2026-10-16

状态：第一期集成候选已完成，本机回归通过；尚未发布。

## 基线与环境

- 开发目录：`<开发副本根>`，普通独立 clone，不使用 worktree。
- 分支：`refactor/phase1-reliability`。
- 基线：`67fd952ae4fe8bc1f3300913da61dfe3a1ce239a`，来源为此前已核对并推送的 `refactor/console-api`。
- 开发副本 origin：`https://github.com/yange0793-dot/mixrouter.git`。
- Node：v24.18.0。
- 基线 bundle：`<开发副本根>-baseline-2026-10-16.bundle`；`git bundle verify` 已确认有效。
- 在线源码、实际配置、Key、LaunchAgent 和运行进程不在本轮编辑范围。

## 独立执行任务

1. 健康许可、响应终态、真实网络调用计数及受影响回归。
   - 主要文件：`mixrouter.js`、`test/health.test.js`、`test/audit-fixes.test.js`；必要时最小修改 `lib/upstream-health.js`。
2. Codex→Chat 桥接真实入口回归。
   - 主要文件：`test/codex-bridge-modern.test.js`、可新增入口测试；必要时最小修改 `lib/wire-openai-bridge.js`。
   - 两个 `mixrouter.js` 调用点由主会话集成，避免并发编辑同一文件。

## 已集成：Codex→Chat 请求上下文

- `mixrouter.js` 两处响应桥接调用均传入原始 `body`，保留 `stream:false`、namespace/custom tool 注册与输入输出。
- 新增 `test/codex-bridge-entry.test.js`：真实 `/v1/responses` 入口覆盖上游 JSON/SSE、忽略 stream、custom tool 下一轮回传、reasoning 与 usage。
- 测试监听仅使用本机临时端口，结束时显式关闭服务及连接；临时 HOME/数据目录由既有测试入口回收。
- 集成后执行 `node scripts/run-tests.js test/codex-bridge-entry.test.js test/codex-bridge-modern.test.js`：Node v24.18.0，**16 通过、0 失败**。补充显式资源清理后同组回归仍为 **16 通过、0 失败**，运行耗时约 245ms。
- 离线端到端 smoke：**18/18 通过**，无真实渠道调用，临时 HOME 哨兵未改变。
- 桥接候选全套隔离回归：Node v24.18.0，81 个测试文件，**1324 通过、0 失败、0 跳过**，耗时约 22.4 秒；健康补丁尚未包含在此版本中。
- 子代理受隔离守卫限制未能写入普通开发副本，主会话读取临时交付文件后集成。子代理临时副本结果不替代上述开发副本测试。

## 已集成：健康许可、终态与调用计数

- `health.acquire=null` 硬拒绝网络调用；同渠道重试重新申请许可。达到阈值后停止原样重试，保留已收到的最后一次真实上游错误体，不发额外请求绕过开路。
- 200 响应头不再结算成功。直通 SSE 按 data 帧的协议字段识别终态，正文引用终态名称不算成功；Responses failed 终态计失败，正常 token 上限终态可以成功。转换支线使用现有转换结果结算，Codex→Chat 也补齐这一契约。
- 本地 `count_tokens` 在许可和计数之前执行；坏 Key 等发送前拒绝不计网络调用。计数移到 HTTP 请求成功构造边界，归档 attempt 序号同步调整。
- 请求终态幂等；响应结束时清理 idle/body/deadline 定时器；取消中性释放许可，不清空已累积失败。
- 手动 pinned 渠道也做只读健康预检，发送前硬闸门仍是最终依据。路由预览同步说明与选择，避免预测开路渠道却实际转移。
- 新增 `test/health-entry.test.js`，覆盖全池开路/pinned、半开并发、200 头不恢复、缺终态、正文引用、本地估算、坏 Key、failed 终态、取消、token 上限、Codex→Chat 错误 JSON/断流。
- 更新旧断言：持续 HTTP 失败的调用数同时受重试预算与熔断阈值限制；预览不再宣称 pinned 可以忽略健康；心跳夹具补合法终态；旧审计用例独立重置健康，避免故障用例污染后续验证。未提高熔断阈值来凑通过。

## 验证状态

- 子代理交付的中间补丁：全套 **1317 通过、7 失败**，不是可发布结果；主会话接手修正后覆盖验证。
- 接手后的受影响回归：**149 通过、0 失败**（此时新增健康入口有 7 项）。
- 增补取消/token 上限/错误 JSON 回归后的全套第一次运行：**1333 通过、1 失败**；失败来自收紧 helper 破坏旧空壳兼容。已将结构校验放回真实入口，helper 维持旧契约。
- 修正后兼容/桥接/健康入口回归：**38 通过、0 失败**。
- 集成候选离线 smoke：**18/18 通过**。
- 最终全套回归：Node v24.18.0，82 个文件，**1334 通过、0 失败、0 跳过、0 取消**，耗时约 22.2 秒。只验证了 Node v24.18.0，本轮未跑 Node 18/22、真实付费上游或桌面外壳交互。

尚未 commit、push、发布或切换在线服务。
