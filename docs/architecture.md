# 运行与模块边界

2026-11-06 的重构保留现有渠道数据格式、路由优先级、协议转换、重试、共享压缩和 CLI 命令。
运行仍不需要安装第三方 Node 依赖。

## 后端

| 模块 | 职责 |
| --- | --- |
| `mixrouter.js` | 可执行入口、进程信号和原有公开导出 |
| `lib/application.js` | 创建应用实例、装配模块与启停 |
| `lib/runtime/config.js` | 从传入环境和用户目录一次性解析运行参数 |
| `lib/config/repository.js` | 配置加载、持久化、渠道与客户端切换回滚 |
| `lib/clients/manager.js` | Claude/Codex 配置、目录、槽位同步与磁盘状态 |
| `lib/clients/codex-runtime.js` | Codex 活动主会话的模型设置与确认 |
| `lib/http/console.js` | 本机访问边界、请求读取、静态资源和 API 分发 |
| `lib/http/{clients,providers,routing,status}-api.js` | 按客户端、渠道、路由、状态划分的接口 |
| `lib/providers/public.js` | 渠道的公开字段与 Key 脱敏 |
| `lib/routing/`、`lib/proxy/`、`lib/wire-*` | 原有路由、请求生命周期和协议转换 |

`createApplication({root, version, env, home})` 不会自动监听端口。
生产入口调用 `startApplication()`，收到退出信号后调用 `stopApplication()`。
配置路径来自同一份实例配置，Bots、备份与客户端接口不会另读进程全局目录。
无法解析的配置会阻止启动，并保留原文件。

`mixctl restart` 会等待旧进程实际退出，再启动替代进程。
重载后用 `mixctl status` 比较运行源码指纹，健康端点成功本身不等于新代码已加载。

## 控制台

`public/js/app.js` 保留公共状态、导航和概览。渠道、模型、压缩、会话、会话覆盖、
设置和日志分别由同名脚本负责，`bootstrap.js` 在模块就绪后启动刷新。
保留经典脚本方式和已有页面，不引入构建步骤。

HTML 中的 `data-console-core` 指定核心脚本及执行顺序。
UI 测试通过 `test/console-source.js` 逐个执行脚本，避免把所有脚本拼起来以后，
函数提升掩盖浏览器的实际加载顺序错误。

## Codex 模型热切换

直连主模型保存包含两个结果：磁盘配置提交、运行中会话同步。
`POST /api/codex/config` 的 `direct_models` 操作在保存 `model` 时额外返回：

```json
{
  "runtime": {
    "status": "applied",
    "updated": 2,
    "skipped": 1,
    "failed": 0
  }
}
```

只同步同一 provider、仍使用保存前默认模型的活动主会话。
子代理及另外选择了模型的会话不被批量改写。调用 `thread/settings/update` 后，
再通过 `thread/read` 核对模型。当前生成继续完成，新模型用于后续轮次。
不发送推理档位、速度档位、权限或恢复对话指令。

`applied` 表示会话模型已读回确认，`partial` 表示部分会话未确认。
`not_running`、`unsupported`、`unavailable`、`home_mismatch` 和
`no_matching_threads` 都不会显示为热切换成功。配置保存成功后，
运行时不可达不应伪装成配置保存失败。

此路径使用 Node.js 22+ 的原生 WebSocket，并通过临时本机连接访问同一配置目录下的
Codex Unix 控制 socket。配置目录按实际路径比较，支持符号链接和 macOS 的 `/tmp` 别名。
没有运行时接口的客户端仍可保存默认值。
审查模型、连接模式和直连渠道的更换仍需客户端重新读取配置。
路由模式下，槽位落点仍由 MixRouter 对每次请求即时解析。

## 验证入口

- `npm test`：隔离用户目录与数据运行全量回归。
- `npm run smoke`：临时实例和本地上游的离线端到端验证。
- `node test/codex-runtime-native.js`：需要本机 Codex CLI 和 Node.js 22+；
  使用独立临时配置与本地上游，经控制台接口在同一会话切换模型，
  验证上下文、推理档位及在途响应不被中断。不会调用真实模型服务。

原生客户端验证与普通测试桩分别记录；当前主会话、真实上游连通性及模型速度，
不能从上述离线结果推导。
