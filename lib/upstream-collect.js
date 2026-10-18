'use strict';

// 全文收集只用于确实需要完整正文的分支;没有大小上限,不把错误体假定为“小响应”。
// 只注册 data/end,错误、取消、超时及 res.end() 仍由调用方负责。
function bufferText(cres, fn) {
  const parts = [];
  const onData = chunk => parts.push(chunk);
  cres.on('data', onData);
  cres.once('end', () => {
    cres.removeListener('data', onData);
    const text = Buffer.concat(parts).toString('utf8');
    parts.length = 0;
    fn(text);
  });
}

// 非流式直通同时收全文与逐块转发;流式用下面的有界 usage 采样。
function bufferAndForward(cres, res, fn) {
  const parts = [];
  const onData = chunk => { parts.push(chunk); res.write(chunk); };
  cres.on('data', onData);
  cres.once('end', () => {
    cres.removeListener('data', onData);
    const text = Buffer.concat(parts).toString('utf8');
    parts.length = 0;
    fn(text);
  });
}

// 探活只留前 max 个 chunk,不是总字节上限;保留原探活的序号语义。
function tailText(cres, max, fn) {
  const parts = [];
  const onData = chunk => { if (parts.length < max) parts.push(chunk); };
  cres.on('data', onData);
  cres.once('end', () => {
    cres.removeListener('data', onData);
    const text = Buffer.concat(parts).toString('utf8');
    parts.length = 0;
    fn(text);
  });
}

const WINDOW_BYTES = 128 * 1024;
const GAP = Buffer.from([0]);
const lineEnd = byte => byte === 10 || byte === 13;
const windowSize = value => Number.isSafeInteger(value) && value > 0 ? value : WINDOW_BYTES;

// 同协议 SSE 直通的 usage 采样:前 128KiB + 后 128KiB,按原始字节计。
// 适用 Anthropic 的 message_start/message_delta、Responses 的 response.completed、
// Chat 的末块 usage;fn 收到的仅是供现有 usage 提取器使用的样本,不是客户端正文。
//
// 短流(<=两窗之和)完整保留,结束时统一解码,UTF-8 跨网络块/窗口边界不会损坏。
// 长流删掉中段,并裁掉头末/尾首被采样切断的行,再用 NUL 隔开;仅加分隔符不够,
// 因为现有正则会把头段末尾的 "input_tokens":12(原值 12345)误读成 12。
// 首尾完整行以外的 usage 仍可能丢失:超长单行、usage 只在中段、末尾有 >128KiB
// 附加数据均不保证审计完整。这不是 SSE/JSON 解析器,不适合非流式 JSON 统计。
//
// 流中只持有两个固定 Buffer(默认共 256KiB),不保存上游 chunk 引用、不逐块解码或
// 重拼尾串。结束时另分配 <=两窗之和+1 的样本 Buffer 和其 UTF-8 解码字符串。
// 客户端原始 chunk 逐块透传;不改变既有背压、异常、取消和结束处理。
function headTailUsage(cres, res, fn, opts = {}) {
  const headBytes = windowSize(opts.headBytes);
  const tailBytes = windowSize(opts.tailBytes);
  let head = Buffer.allocUnsafe(headBytes);
  let tail = Buffer.allocUnsafe(tailBytes);
  let headLength = 0, tailLength = 0, tailWrite = 0;
  let truncated = false, beforeTail;

  const onData = chunk => {
    res.write(chunk);
    const take = Math.min(headBytes - headLength, chunk.length);
    if (take) {
      chunk.copy(head, headLength, 0, take);
      headLength += take;
    }
    const length = chunk.length - take;
    if (!length) return;

    // 一个块已足够填满尾窗:只拷它的最后一窗,避免持有或解码整个大块。
    if (length >= tailBytes) {
      const start = chunk.length - tailBytes;
      if (length > tailBytes) beforeTail = chunk[start - 1];
      else if (tailLength) beforeTail = tail[(tailWrite + tailBytes - 1) % tailBytes];
      if (tailLength + length > tailBytes) truncated = true;
      chunk.copy(tail, 0, start);
      tailLength = tailBytes;
      tailWrite = 0;
      return;
    }

    const nextWrite = (tailWrite + length) % tailBytes;
    if (tailLength + length > tailBytes) {
      truncated = true;
      // 覆盖前记住新尾窗的前一个字节,窗口恰从行首开始时不误删整行。
      beforeTail = tail[(nextWrite + tailBytes - 1) % tailBytes];
    }
    const first = Math.min(length, tailBytes - tailWrite);
    chunk.copy(tail, tailWrite, take, take + first);
    if (first < length) chunk.copy(tail, 0, take + first);
    tailWrite = nextWrite;
    tailLength = Math.min(tailBytes, tailLength + length);
  };

  cres.on('data', onData);
  cres.once('end', () => {
    cres.removeListener('data', onData);
    let headEnd = headLength, tailSkip = 0;
    if (truncated) {
      headEnd = Math.max(head.lastIndexOf(10), head.lastIndexOf(13)) + 1;
      if (!lineEnd(beforeTail)) {
        while (tailSkip < tailLength && !lineEnd(tail[(tailWrite + tailSkip) % tailBytes])) tailSkip++;
        if (tailSkip < tailLength) tailSkip++;
      }
    }
    const start = ((tailLength === tailBytes ? tailWrite : 0) + tailSkip) % tailBytes;
    const length = tailLength - tailSkip;
    const first = Math.min(length, tailBytes - start);
    const parts = [head.subarray(0, headEnd)];
    if (truncated) parts.push(GAP);
    parts.push(tail.subarray(start, start + first), tail.subarray(0, length - first));
    const text = Buffer.concat(parts).toString('utf8');
    head = tail = null;
    fn(text);
  });
}

module.exports = { bufferText, bufferAndForward, tailText, headTailUsage };
