# 历史图片精简

MixRouter 在转发请求前，把较早的内联 base64 图片替换为文字占位，减少重复上传。覆盖经过 MixRouter 的 Codex Responses、Chat Completions 和 Claude Messages，包括用户附件与工具返回的图片。不需要安装或运行 Magpie，不改本地会话记录、原始图片或工具调用参数。

## 启用与配置

进入控制台「设置与备份 → 历史图片精简」，修改后点「保存」。保存成功即持久化到 MixRouter 数据目录的 `image-slim.json`，后续请求立即使用，无需重启。产品默认关闭；本机启用时将 `enabled` 设为 `true`。

**请求必须经过 MixRouter。** 客户端直接连接上游时，本功能不生效。控制台能打开、渠道已登记，并不代表客户端正在使用路由。

| 字段 | 产品默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `false` | 是否启用历史图片精简 |
| `keep_last_turns` | `1` | 保留最近多少个已完成用户轮的全部图片；整数 `0..1000` |
| `keep_last` | `0` | 按图片顺序保留最新 N 张，与按轮保留的集合合并；整数 `0..1000` |
| `min_bytes` | `8192` | 小于此值的 base64 payload 不处理；单位为字节，整数 `0..2147483647` |
| `attachments` | `true` | 是否精简历史用户附件；关闭后仍可精简历史工具图片 |

界面阈值直接使用字节，`8192` 等于 `8 KiB`，不是图片解码后的文件大小。两个布尔字段只接受 JSON `true` / `false`，不接受字符串或 `0` / `1`。

**当前用户轮的图片始终保留**，包括该轮内工具返回的图片和没有附带文字的用户图片。工具返回不会独立算作新用户轮。默认另外保留上一整个用户轮；把 `keep_last_turns` 和 `keep_last` 都设为 `0`，也不会移除当前轮图片。

切回设置页会更新统计并保留未保存草稿。手动「重新读取」在有草稿时先确认丢弃；读取或保存失败会保留草稿。页面刷新或关闭时，有草稿会触发浏览器离开提醒。

## API 与统计

控制台 API：

```http
GET /api/image-slim
```

```json
{
  "settings": {
    "enabled": false,
    "keep_last": 0,
    "keep_last_turns": 1,
    "min_bytes": 8192,
    "attachments": true
  },
  "stats": { "requests": 0, "images_removed": 0, "bytes_saved": 0 }
}
```

PUT 接受平铺的部分配置，未提交的字段保持原值；不要包在 `settings` 中，也不要提交 `stats`。响应与 GET 同形状。例如启用并保留上一轮：

```http
PUT /api/image-slim
Content-Type: application/json

{"enabled":true,"keep_last_turns":1}
```

`stats` 是**当前进程累计值**，重启后归零：

- `requests`：确实移除了图片的入站请求数。每次入站只计一次，不因上游重试而重复累计。
- `images_removed`：累计移除的图片数。
- `bytes_saved`：累计节省的 JSON 请求体字节数，已扣除占位文本开销；不是 token 数或费用。

每条请求日志另含 `images_removed` 和 `image_bytes_saved`，用于查看该次请求的精简结果。关闭功能不会清零已有进程统计。

## 重读图片与缓存

占位文本会保留能从工具参数识别出的图片路径。模型需要重新查看时，可调用 `view_image` 等读图工具；前提是原文件仍在，且当前客户端能访问该路径。精简不会把原图另存到服务器，也不会替模型自动重读。

粘贴的图片或其他没有本地路径的附件，无法仅凭占位符恢复像素；需要用户重新附图。只有请求体实际携带的内联图片可被精简，远程图片 URL 和仅由上游保存的历史不在处理范围内。

老图片首次被替换时会改变请求的缓存前缀，可能降低该次请求的缓存命中。占位文本随后保持稳定，但随着图片继续超出保留范围，前缀仍可能变化。减少上传字节不等于保证更低费用或更快响应；模型也不再看到被精简图片的像素，只能依据保留的对话文字或重新读图。

## 来源

基于 Euan Guo 的 `euanguo/magpie-middleware-image-slim`（本地参考版本 `0.2.0`）适配为 MixRouter 原生实现，增加本地持久化配置、控制台 API 与统计。上游采用 MIT 许可证，版权为 `Copyright (c) 2026 Euan Guo`，全文见 [image-slim-MIT.txt](licenses/image-slim-MIT.txt)。MixRouter 的默认值与覆盖范围以上文为准。

上游仓库：`https://github.com/euanguo/magpie-middleware-image-slim`
