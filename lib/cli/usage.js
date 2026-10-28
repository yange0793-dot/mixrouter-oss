'use strict';
// mixctl 的用法串。原来它们散在三个地方:顶层那一大串写在文件末尾的 else 分支里,
// EXPLAIN_USAGE 在 explain 块、BACKUPS_USAGE 在 backups 块。三个都要跟**同一批子命令**对齐,
// 而顶层那串是唯一总览 —— 加了子命令却只更新一处,用户敲错时看到的清单就是旧的。
//
// 这里只放文本,不放行为:每条子命令解析完再决定打哪一段。

// explain 单独走结构化协议,不复用会把 error 对象变成 [object Object] 的 apiPost。
// 末行说明**当前**的分发依据:通用匹配规则与兜底已移除,预览解释的是槽位与已登记模型这两条。
const EXPLAIN_USAGE = 'mixctl explain <claude|codex> <model> [--kind <kind>] [--session <cc:…|cx:…|fp:…|cxf:…>] [--ua <s>] [--body <文本>] [--json]\n' +
  'mixctl explain <model> [codex]                                            (app 缺省 claude)\n' +
  'mixctl explain --input <file|-> [--json]\n' +
  '  解释的是当前固定选择路径:精确槽位别名 → 该组唯一已登记模型;没有匹配或无对应时显式失败';

const BACKUPS_USAGE = 'mixctl backups [--json] [<文件名前缀>]\n' +
  'mixctl backups --diff <备份名> [--file <现役路径>] [--json]\n' +
  '  清点客户端配置的备份池(只读:不产生、不改写、不删除任何文件)\n' +
  '  无参数时列出 DATA_DIR 与两个客户端配置的备份;给了文件名前缀(如 settings.json)只列那一处\n' +
  '  --diff  预览一份备份与现役文件的差异(值由 lib/backup/compare.js 内部脱敏,这里不另做一层)\n' +
  '          现役文件默认由备份名推出并在输出里标出;推不出来就报错,不猜一个来比\n' +
  '  --file  在 --diff 下显式指定现役文件(覆盖推导);只在 --diff 下有意义\n' +
  '  --json  输出 JSON';

const SPLIT_USAGE = '用法: mixctl split <主渠道ID> <主模型> <子代理渠道ID> <子代理模型> [--apply]\n' +
  '      mixctl split subagent <渠道ID> <模型> [--apply]';

// probe 的结论是逐模型的,所以用法串必须让人一眼看出"位置参数 1 是渠道、其后才是模型":
// 顺序反了会把渠道名当成模型发出去,而那是一次真花钱的上游请求。
const PROBE_USAGE = '用法: mixctl probe <渠道ID或渠道名> [模型...] [--key-id <KeyID>] [--wire <anthropic|responses|chat>] [--json]\n' +
  '  逐模型探活(每个模型一次真实生成请求);不给模型名就用渠道登记的模型;有模型失败时退出码 1';

const ROUTE_USAGE = '用法: mixctl route <claude|codex> [--slots]';

const LOGS_USAGE = 'mixctl logs [n] [--history] [--since <时间>] [--until <时间>] [--cursor <游标>] [--limit <条数>] [--json]\n' +
  'mixctl logs [n] [--app <claude|codex>] [--provider <渠道>] [--model <模型>] [--session <会话>] [--status <ok|err|状态码>] [--slot <槽名>] [--err_class <错误分类>]\n' +
  '  两行选项可组合;默认最近 20 条,需服务运行,通过 /api/logs 查询\n' +
  '  --history 回读磁盘历史;--cursor 继续同一快照,并隐含 --history\n' +
  '  --since / --until 接受 ISO 时间或 epoch 毫秒,包含边界;下一页保留原筛选条件';

// 顶层总览。**必须包含上面每一段**:它同时是"敲了个不认识的子命令"时的出口,
// 漏掉哪一段,那个子命令就等于没有文档。
// 会话级 Key / 槽位覆盖(sessions 子命令)的用法串与它的解析器/执行器同处一个文件:
// 那段文本、那些选项白名单、以及真正读写的编排都在 lib/cli/sessions.js。
const { RESTORE_USAGE } = require('./restore');
const { SESSIONS_USAGE } = require('./sessions');
const MAIN_USAGE = '用法: mixctl <start|stop|restart|status|ls|sessions|slots|restore|split <主渠道ID> <主模型> <子代理渠道ID> <子代理模型> [--apply]|split subagent <渠道ID> <模型> [--apply]|backups|logs [n]|probe|gc [<天数>] [--apply]|route <claude|codex> [--slots]|open>\n' +
  `${EXPLAIN_USAGE}\n${BACKUPS_USAGE}\n${PROBE_USAGE}\n${RESTORE_USAGE}\n${LOGS_USAGE}\n${SESSIONS_USAGE}`;

module.exports = { EXPLAIN_USAGE, BACKUPS_USAGE, PROBE_USAGE, SPLIT_USAGE, ROUTE_USAGE, RESTORE_USAGE, LOGS_USAGE, SESSIONS_USAGE, MAIN_USAGE };
