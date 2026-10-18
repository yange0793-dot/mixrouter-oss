'use strict';
// 绑定回环不等于网页不可访问:Host 白名单挡 DNS rebinding,来源/类型闸门挡跨站投递。
// 不解析域名、不接受 URL 对数字地址的宽松归一化;本机 CLI 不需要 Origin。
function isLoopbackHost(value) {
  if (typeof value !== 'string') return false;
  const match = /^(127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/.exec(value);
  return !!match && (match[2] === undefined || (Number(match[2]) > 0 && Number(match[2]) <= 65535));
}

function isCrossSiteRequest(req) {
  const headers = req.headers || {};
  const site = String(headers['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = String(headers.origin || '').trim();
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol !== 'http:' || url.host !== headers.host;
  } catch { return true; }
}

function isJsonRequest(req) {
  const type = String((req.headers || {})['content-type'] || '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

module.exports = { isLoopbackHost, isCrossSiteRequest, isJsonRequest };
