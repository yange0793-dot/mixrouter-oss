'use strict';
// 两个 HTTP 入口共用 JSON 深度与对象校验。代理超限后有界排空;
// 控制台读体保留原有的超限断开行为。
const MAX_JSON_DEPTH = 256;

// 只看结构深度,不是语法检查;字符串里的括号、转义引号不计入嵌套。
// 限制深度也保护解析后的遍历与协议转换,避免深递归耗尽调用栈。
function jsonDepthOk(text) {
  let depth = 0, inStr = false, escaped = false;
  const s = String(text === undefined || text === null ? '' : text);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === 92) escaped = true;
      else if (c === 34) inStr = false;
    } else if (c === 34) inStr = true;
    else if (c === 123 || c === 91) { if (++depth > MAX_JSON_DEPTH) return false; }
    else if (c === 125 || c === 93) depth--;
  }
  return true;
}

function parseJsonBody(raw, opts = {}) {
  const { invalid, proxy = false, isObject } = opts;
  if (typeof invalid !== 'function') throw new TypeError('parseJsonBody 需要 invalid 构造器');
  if (!jsonDepthOk(raw))
    throw invalid(`请求体嵌套层数超过 ${MAX_JSON_DEPTH} 层${proxy ? ',拒绝解析' : ''}`);
  let body;
  try { body = JSON.parse(raw); }
  catch { throw invalid('请求体不是合法 JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      (typeof isObject === 'function' && !isObject(body)))
    throw invalid('请求体必须是 JSON 对象');
  return body;
}

// 无界收集只供受控调用方复用;代理请求使用下面的 readProxyBody。
function collectBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    let settled = false;
    const done = value => { if (settled) return; settled = true; chunks.length = 0; resolve(value); };
    req.on('data', c => { if (!settled) chunks.push(c); });
    req.on('end', () => done({ text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', e => done({ error: e }));
  });
}

function readBodyLimited(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { chunks.length = 0; req.destroy(); reject(new Error('too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 代理不能像控制台一样超限即断开:上传还没收完就 end 响应会让客户端只看到
// ECONNRESET。先丢弃剩余数据，排空另受字节/时间上限约束；计数与协议错误由入口提供。
function readProxyBody(req, res, { limit, drainExtra, drainMs, onTooLarge, onDrainAbort, onDrainTimeout }, onBody) {
  const chunks = [];
  let size = 0, rejected = false, drained = 0, tooLargeSent = false, drainAborted = false;
  let drainTimer = null;
  const sendTooLarge = () => {
    if (tooLargeSent) return;
    tooLargeSent = true;
    // end/error/close/击穿/超时都经过这个出口，不留悬挂计时器。
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    if (req.destroyed || res.writableEnded) return;
    try { if (!res.headersSent) onTooLarge(); } catch {}
  };
  const killAfterResponse = () => {
    const kill = () => { try { req.destroy(); } catch {} };
    res.once('finish', kill);
    res.once('close', kill);
  };
  const overLimit = () => {
    if (rejected) return;
    rejected = true;
    chunks.length = 0;
    req.removeAllListeners('data');
    req.removeAllListeners('end');
    req.on('data', chunk => {
      drained += chunk.length;
      if (drained <= drainExtra || drainAborted) return;
      // 触发超限的原始块不计入额外排空预算，与旧代理入口保持一致。
      drainAborted = true;
      onDrainAbort();
      sendTooLarge();
      killAfterResponse();
      req.pause();
    });
    req.once('end', sendTooLarge);
    req.once('error', sendTooLarge);
    req.once('close', sendTooLarge);
    // 超限后停住不发的客户端既撞不到字节预算，也不会发 end。
    if (drainMs > 0) {
      drainTimer = setTimeout(() => {
        drainTimer = null;
        onDrainTimeout();
        sendTooLarge();
        killAfterResponse();
      }, drainMs);
    }
    req.resume();
  };
  req.on('data', chunk => {
    size += chunk.length;
    if (size > limit) return overLimit();
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (rejected) return;
    const raw = Buffer.concat(chunks, size).toString('utf8');
    chunks.length = 0;
    onBody(raw, size);
  });
}

async function readObject(req, opts = {}) {
  return parseJsonBody((await readBodyLimited(req, opts.limit)) || '{}', opts);
}

module.exports = { MAX_JSON_DEPTH, jsonDepthOk, collectBody, parseJsonBody, readBodyLimited, readProxyBody, readObject };
