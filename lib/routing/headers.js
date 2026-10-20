'use strict';
// 首部与凭据归一化:所有会进 HTTP 头(上游请求头或回给客户端的响应头)的字符串都在这里收敛。
// 纯函数,只依赖 URL。

// HTTP 头只允许 latin-1:渠道名等注入头之前消洗掉非 ASCII,避免 ERR_INVALID_CHAR 打崩进程
// 头部值消洗:去掉非可见 ASCII,并**截断**。
// 截断不是洁癖:这些值会原样进响应头(x-mixrouter-model / -session / -provider),
// 而模型名和会话 id 都是客户端说了算的。几十 KB 的模型名会让响应头越过 Node 的
// 16KB 上限,客户端拿到的是 HPE_HEADER_OVERFLOW 这种协议级报错——连一个 HTTP 状态码
// 都看不到,比 "模型名太长" 难查得多。256 对 UA / 模型名 / 渠道名都足够宽裕。
const safeHeader = s => String(s ?? '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 256);

// 凭据能不能安全地放进 HTTP 头。换行/回车不只是"看着别扭":Node 的 transport.request 会
// **同步**抛 ERR_INVALID_CHAR,而那一抛发生在转发候选里、任何 try 之外——这一次请求
// 就此消失:不写日志、客户端干等到自己的超时。CRLF 还会顺带把后面的内容
// 变成额外的上游请求头(凭据注入)。控制台写入时拦一道,转发时再兜一道。
function authHeaderValue(v) {
  const s = String(v == null ? '' : v);
  return /[\x00-\x1F\x7F]/.test(s) ? s.replace(/[\x00-\x1F\x7F]/g, '') : s;
}

const hasCtlChar = v => /[\x00-\x1F\x7F]/.test(String(v == null ? '' : v));

// base_url 必须是合法 http(s) URL;坏值存进库会埋雷到首次转发才炸
function validBaseUrl(u) {
  try {
    const x = new URL(String(u));
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return false;
    // URL 里带 user:pass 时必须拒绝:转发只用 hostname,凭据会被**静默丢弃**,
    // 用户以为凭据写进去了、实际请求一个字节都没带,只拿到 401 却看不出原因。
    // 凭据该填在渠道的 API Key 字段里(那才是会进 Authorization/x-api-key 的地方)
    if (x.username || x.password) return false;
    return true;
  } catch { return false; }
}

module.exports = { safeHeader, authHeaderValue, hasCtlChar, validBaseUrl };
