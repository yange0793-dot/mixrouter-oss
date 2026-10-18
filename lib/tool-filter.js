// 槽位级工具剥离:把某个槽位别名(如 mixr-main)的请求里指定的工具从 tools 里删掉。
// 目的不是省 token,而是**让主会话在工具声明层就没有执行类工具**——这样"主链只做规划/
// 整合/质检、执行活派给子代理"是机制约束,不依赖模型自觉。子代理槽(mixr-subagent)不配
// dropTools 就不受任何影响。
//
// 落点在 mixrouter.js tryCandidate 内出站 body 拼装之前,三种 wire(anthropic 直通 /
// responses 转换 / chat 转换)共用同一个 body,所以只过滤一次即可全覆盖。
// 必须**原地删除数组元素**而不是改写形状:转换层按 `t.name` / `t.type==='function' &&
// t.name` 判有效工具,改形状会让本该保留的工具被静默丢掉。
'use strict';

// 支持精确工具名与尾部通配('mcp__playwright__*' 命中该 server 的全部工具)。
// 只支持**尾部**单个 '*':MCP 工具名里带冒号和下划线,中缀通配没有实际用例,
// 多一条解析规则就多一类匹配错的可能。
function matches(name, pat) {
  if (typeof name !== 'string' || !name || typeof pat !== 'string' || !pat) return false;
  if (pat.endsWith('*')) return name.startsWith(pat.slice(0, -1));
  return name === pat;
}

// 原地过滤 body.tools,返回删掉的条数。没有 tools / 没有规则时原样返回 0。
// 幂等:同一 body 被 failover 复用再调一次,第二次匹配不到任何工具,返回 0,
// 不会把 entry.tools_dropped 重复计数成"又剥了一次"。
function apply(body, dropTools) {
  if (!body || typeof body !== 'object') return 0;
  if (!Array.isArray(body.tools) || !body.tools.length) return 0;
  if (!Array.isArray(dropTools) || !dropTools.length) return 0;
  let dropped = 0;
  body.tools = body.tools.filter(t => {
    const name = t && t.name;
    if (name && dropTools.some(p => matches(name, p))) { dropped++; return false; }
    return true;
  });
  return dropped;
}

module.exports = { apply, matches };
