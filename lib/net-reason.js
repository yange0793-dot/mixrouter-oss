'use strict';
// 出站网络失败 → 受控措辞。**全仓唯一一份**(渠道模型发现与模型测活都用它)。
//
// 为什么不能拼接任意 e.message:
//   · lib/upstream-proxy.js 的隧道错误只有 message(`upstream proxy CONNECT <code>` /
//     `upstream proxy connect timeout`),把原文抄进控制台等于把代理侧的细节转述出去;
//   · TLS 与 socket 错误的 message 里常带上游主机、证书主题乃至请求片段,同样不该回显。
// 白名单里的措辞是固定的,既说清了"卡在哪一层",又不含任何来自上游的字符串。
const NET_REASONS = new Map([
  ['ECONNREFUSED', '上游拒绝连接'],
  ['ENOTFOUND', '上游域名解析失败'],
  ['EAI_AGAIN', '上游域名解析暂时失败'],
  ['ETIMEDOUT', '连接上游超时'],
  ['ECONNRESET', '上游重置了连接'],
  ['ECONNABORTED', '上游连接被中止'],
  ['EHOSTUNREACH', '无法路由到上游主机'],
  ['ENETUNREACH', '无法路由到上游网络'],
  ['EPIPE', '上游连接已断开'],
  ['CERT_HAS_EXPIRED', '上游 TLS 证书已过期'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', '上游 TLS 证书是自签名的'],
  ['SELF_SIGNED_CERT_IN_CHAIN', '上游 TLS 证书链里有自签名证书'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', '无法验证上游 TLS 证书'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', '上游 TLS 证书与域名不匹配'],
]);

function reasonOf(e) {
  const code = e && e.code;
  if (typeof code === 'string' && NET_REASONS.has(code)) return NET_REASONS.get(code);
  // 出站代理隧道的错误(见 lib/upstream-proxy.js)没有 code,只有 message;只认前缀,不回显原文
  if (e && typeof e.message === 'string' && /^upstream proxy /i.test(e.message))
    return '出站代理未能建立到上游的隧道';
  // 建连硬截止(lib/upstream-connect.js):DNS/TCP/TLS 只给 15 秒,超时那条错误没有固定 code。
  // 不认它的话会落进"出站请求失败"这句最没用的话 —— 用户看不出是连不上、还是上游不回话。
  if (e && typeof e.message === 'string' && /^upstream connection timeout$/i.test(e.message))
    return '连接上游超时(DNS/TCP/TLS 建连未在时限内完成)';
  return '出站请求失败';
}

module.exports = { NET_REASONS, reasonOf };
