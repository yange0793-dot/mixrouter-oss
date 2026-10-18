'use strict';
// 代理请求体读取器(从 mixrouter.js 的 proxyHandler 内联逻辑抽出)的独立单测。
//
// 这里只用 EventEmitter 假件,不开真 socket:被测的是"什么时候调回调"这类时序契约,
// 真连接会把时序交给内核,测出来的红绿都不稳。假件各自记录自己的调用次数,断言落在
// **假件上的确定事实**(发了几次响应、pause 了几次、什么时候销毁),而不是落在时间上
// —— 只有排空超时那两条设时限,而且给的是量级余量,不贴边。
//
// 要钉死的事故(旧内联实现的行为,抽取时不能改掉):
//   - 上限判定按字节;UTF-8 必须在所有分片拼完后再解码,逐片 toString 会得到替换字符;
//   - 超限后立刻结束响应,Node 会直接销毁 socket,客户端只看到 ECONNRESET,连 413 都收不到
//     —— 所以 413 必须在请求体收完/排空超限/排空超时**之后**才发,而且只发一次;
//   - 触发超限的那个分片本身不计入排空预算(预算算的是"上限之后还允许再收多少");
//   - 排空预算击穿后 pause,真正的 destroy 要等响应 flush 完(等 finish 或 close),
//     否则刚写出的 413 会被一起掀掉;
//   - 排空定时器在五条出口上都要清掉,漏一条就留一个悬挂定时器把子进程吊住。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readProxyBody } = require('../lib/http/body');

// ---- 假件 -------------------------------------------------------------------
// req:data/end/error/close 自己 emit;resume/pause/destroy 只计数,不做真实流控,
// 因为被测代码对它们只有"调没调、调几次"这一种依赖。
function fakeReq() {
  const req = new EventEmitter();
  req.destroyed = false;
  req.paused = false;
  req.resumeCount = 0;
  req.pauseCount = 0;
  req.destroyedCount = 0;
  req.resume = () => { req.resumeCount++; req.paused = false; };
  req.pause = () => { req.pauseCount++; req.paused = true; };
  req.destroy = error => {
    if (req.destroyed) return req;
    req.destroyedCount++;
    req.destroyed = true;
    if (error) req.emit('error', error);
    return req;
  };
  // 真 IncomingMessage 在 close 之后 destroyed 就是 true,被测代码的守卫依赖这一点。
  const emit = req.emit.bind(req);
  req.emit = (event, ...args) => {
    if (event === 'close') req.destroyed = true;
    return emit(event, ...args);
  };
  return req;
}

// res:end() 之后异步 emit finish(和真 ServerResponse 一样),这样"等响应写完再销毁"
// 的语义才测得出来;close 由测试自己 emit,用来验证 finish 之外的第二条出口。
function fakeRes(writableEnded = false) {
  const res = new EventEmitter();
  res.writableEnded = writableEnded;
  res.headersSent = false;
  res.heads = [];
  res.writes = [];
  res.endedCount = 0;
  res.writeHead = (status, headers) => { res.headersSent = true; res.heads.push({ status, headers }); return res; };
  res.write = chunk => { res.writes.push(chunk); return true; };
  res.end = chunk => {
    res.endedCount++;
    if (chunk !== undefined) res.writes.push(chunk);
    res.writableEnded = true;
    process.nextTick(() => res.emit('finish'));
    return res;
  };
  return res;
}

// 真实调用方(mixrouter.js 里的 sendTooLarge)的形状:先自己守卫 destroyed/writableEnded,
// 再发协议响应。返回值里区分两件事:
//   calls —— 回调被调了几次;
//   sends —— 真正写出响应几次(这才是"客户端只收到一个 413"的那条契约)。
// 两个都留着:模块已经替调用方把状态守卫做了一遍(body.js 的 sendTooLarge),所以
// "已结束的响应"那条路径上 calls 是 0;sends 则是任何实现下都不该超过 1 的硬约束。
function tooLargeRecorder(req, res, app = 'claude') {
  const calls = [];
  const sends = [];
  const fn = () => {
    calls.push({ destroyed: req.destroyed, ended: res.writableEnded });
    if (req.destroyed || res.writableEnded) return;
    sends.push(true);
    if (!res.headersSent) res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', app } }));
  };
  return { fn, calls, sends };
}

// 排空超时那两条要设时限,统一给"时限 + 一个量级余量"的上界,不贴边断言。
const waitFor = async (predicate, timeoutMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return predicate();
};

const tick = () => new Promise(resolve => setImmediate(resolve));

const utf8Body = '{"text":"中文ç√ — 混排"}';
const utf8Bytes = () => Buffer.from(utf8Body);

// 全部假件收尾:把监听器摘掉,免得悬挂的回调飘进下一个用例
function dispose(...emitters) {
  for (const emitter of emitters) emitter.removeAllListeners();
}

// ---- 上限边界 ---------------------------------------------------------------

test('accepts a body of exactly the byte limit and decodes UTF-8 after joining chunks', async () => {
  const raw = utf8Bytes();
  const req = fakeReq();
  const res = fakeRes();
  const calls = [];
  readProxyBody(req, res, { limit: raw.length, drainExtra: 1024, drainMs: 0 }, (text, size) => calls.push({ text, size }));

  // 故意切在一个多字节字符中间:逐片解码会得到 U+FFFD,拼完再解才是原文
  const cut = raw.indexOf(Buffer.from('中')) + 1;
  assert.equal(raw[cut] & 0xc0, 0x80, '切点必须落在续字节上,否则这条用例没测到跨片解码');
  req.emit('data', raw.subarray(0, cut));
  assert.deepEqual(calls, [], '分片没拼完之前不能回调');
  req.emit('data', raw.subarray(cut));
  req.emit('end');

  assert.deepEqual(calls, [{ text: utf8Body, size: raw.length }]);
  assert.equal(res.endedCount, 0, '正好等于上限不是超限,不该有任何响应');
  dispose(req, res);
});

test('accepts one byte under the limit and rejects exactly one byte over it', async () => {
  const raw = utf8Bytes();

  const under = fakeReq();
  const underRes = fakeRes();
  const underCalls = [];
  readProxyBody(under, underRes, { limit: raw.length + 1, drainExtra: 1024, drainMs: 0 },
    (text, size) => underCalls.push({ text, size }));
  under.emit('data', raw);
  under.emit('end');
  assert.deepEqual(underCalls, [{ text: utf8Body, size: raw.length }]);
  assert.equal(underRes.endedCount, 0);

  // 上限恰好少一个字节:这一片让 size 越过上限
  const over = fakeReq();
  const overRes = fakeRes();
  const recorder = tooLargeRecorder(over, overRes);
  const overCalls = [];
  readProxyBody(over, overRes, { limit: raw.length - 1, drainExtra: 1024, drainMs: 0, onTooLarge: recorder.fn },
    (text, size) => overCalls.push({ text, size }));
  over.emit('data', raw);
  over.emit('end');

  assert.deepEqual(overCalls, [], '超限请求体不进 onBody');
  assert.equal(recorder.sends.length, 1);
  assert.equal(overRes.heads[0].status, 413);
  dispose(under, underRes, over, overRes);
});

test('accepts an empty body: one onBody call with an empty string and size 0', async () => {
  const req = fakeReq();
  const res = fakeRes();
  const calls = [];
  readProxyBody(req, res, { limit: 1024, drainExtra: 1024, drainMs: 0 }, (text, size) => calls.push({ text, size }));
  req.emit('end');
  assert.deepEqual(calls, [{ text: '', size: 0 }]);
  assert.equal(res.endedCount, 0);
  dispose(req, res);
});

// ---- 超限后的排空 -----------------------------------------------------------

test('sends 413 only after the drain ends, never on the triggering chunk', async () => {
  const req = fakeReq();
  const res = fakeRes();
  const recorder = tooLargeRecorder(req, res);
  const onBody = [];
  readProxyBody(req, res, { limit: 4, drainExtra: 64, drainMs: 0, onTooLarge: recorder.fn },
    (text, size) => onBody.push({ text, size }));

  req.emit('data', Buffer.from('12345'));            // 越限的那一片
  assert.equal(recorder.calls.length, 0, '请求体没收完就发响应会被 Node 掀掉 socket,413 得等排空结束');
  assert.equal(res.endedCount, 0);
  assert.equal(req.destroyed, false, '超限不等于立刻断连');

  req.emit('data', Buffer.from('6789'));             // 排空预算内,继续丢
  assert.equal(recorder.calls.length, 0);

  req.emit('end');
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.sends.length, 1);
  assert.equal(res.heads[0].status, 413);
  assert.deepEqual(onBody, []);
  dispose(req, res);
});

test('drops already buffered chunks on oversize and keeps draining to end', async () => {
  const req = fakeReq();
  const res = fakeRes();
  const recorder = tooLargeRecorder(req, res);
  const onBody = [];
  readProxyBody(req, res, { limit: 8, drainExtra: 4096, drainMs: 0, onTooLarge: recorder.fn },
    (text, size) => onBody.push({ text, size }));

  req.emit('data', Buffer.from('1234'));
  req.emit('data', Buffer.from('5678'));
  req.emit('data', Buffer.from('9'));                // 第 9 个字节越限
  req.emit('data', Buffer.from('x'.repeat(4000)));   // 预算内,排掉
  req.emit('end');

  assert.deepEqual(onBody, []);
  assert.equal(recorder.sends.length, 1, '整个排空过程只发一次 413');
  assert.equal(res.endedCount, 1);
  assert.ok(req.resumeCount >= 1, '超限后要继续排水,不能把连接挂住');
  dispose(req, res);
});

test('counts the drain budget after the triggering chunk and aborts only once', async () => {
  const req = fakeReq();
  const res = fakeRes();
  const recorder = tooLargeRecorder(req, res);
  let aborts = 0;
  readProxyBody(req, res, { limit: 2, drainExtra: 4, drainMs: 0, onTooLarge: recorder.fn,
    onDrainAbort: () => { aborts++; } }, () => {});

  req.emit('data', Buffer.from('123'));              // 触发片本身不占预算
  assert.equal(aborts, 0, '预算算的是"上限之后还收了多少",触发片不含在内');
  req.emit('data', Buffer.from('4'));                // 累计 1
  req.emit('data', Buffer.from('5'));                // 累计 2
  req.emit('data', Buffer.from('6'));                // 累计 3
  req.emit('data', Buffer.from('7'));                // 累计 4 = 预算,还没击穿
  assert.equal(aborts, 0);
  assert.equal(req.pauseCount, 0);

  req.emit('data', Buffer.from('89'));               // 累计 6 > 4,击穿
  assert.equal(aborts, 1);
  assert.equal(req.paused, true, '击穿后必须 pause,不能让客户端把连接占死');
  assert.equal(recorder.sends.length, 1);
  assert.equal(req.destroyed, false, '413 还没 flush,这时候断连会把响应一起掀掉');

  // pause() 之后已排队的 data 事件仍可能进来:不能再记一次、再发一次
  req.emit('data', Buffer.from('0'.repeat(64)));
  assert.equal(aborts, 1);
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.sends.length, 1);

  await tick();
  await tick();
  assert.equal(req.destroyed, true, '响应 finish 之后才销毁请求');
  assert.equal(req.destroyedCount, 1);
  dispose(req, res);
});

test('abort path also kills the request on response close when finish never comes', async () => {
  const req = fakeReq();
  const res = fakeRes();
  const recorder = tooLargeRecorder(req, res);
  let aborts = 0;
  readProxyBody(req, res, { limit: 1, drainExtra: 2, drainMs: 0, onTooLarge: recorder.fn,
    onDrainAbort: () => { aborts++; } }, () => {});

  req.emit('data', Buffer.from('ab'));               // 触发
  req.emit('data', Buffer.from('cde'));              // 3 > 2,击穿
  assert.equal(aborts, 1);
  assert.equal(recorder.sends.length, 1);
  assert.equal(req.destroyed, false);

  res.emit('close');                                 // 客户端先走了,没有 finish
  await tick();
  assert.equal(req.destroyed, true, 'close 也是"响应结束"的一条出口');
  dispose(req, res);
});

// ---- 排空超时与关掉定时器 ----------------------------------------------------

test('drain timeout fires once, reports 413, and destroys the request after the response', async () => {
  const req = fakeReq();
  const res = fakeRes();
  const recorder = tooLargeRecorder(req, res);
  let timeouts = 0;
  let aborts = 0;
  readProxyBody(req, res, { limit: 4, drainExtra: 1024, drainMs: 40, onTooLarge: recorder.fn,
    onDrainAbort: () => { aborts++; }, onDrainTimeout: () => { timeouts++; } }, () => {});

  req.emit('data', Buffer.from('12345'));            // 越限后客户端停住不发,一个事件都不来
  assert.equal(timeouts, 0);
  assert.equal(recorder.calls.length, 0);

  assert.equal(await waitFor(() => timeouts > 0), true, '排空时限内必须自己收场,不能挂到 Node 的 requestTimeout');
  assert.equal(timeouts, 1);
  assert.equal(aborts, 0, '停住不发不是预算击穿');
  assert.equal(recorder.sends.length, 1);

  await tick();
  await tick();
  assert.equal(req.destroyed, true, '超时同样等响应 flush 完再销毁');

  // 超时之后再来的事件不能再记一次账,也不能再写一次响应
  req.emit('data', Buffer.from('x'.repeat(4096)));
  req.emit('end');
  await tick();
  assert.equal(timeouts, 1);
  assert.equal(recorder.sends.length, 1);
  assert.equal(res.endedCount, 1);
  dispose(req, res);
});

test('drainMs 0 disables the timer and leaves no exit hanging: end and error still finish it', async () => {
  const ended = fakeReq();
  const endedRes = fakeRes();
  const endedRecorder = tooLargeRecorder(ended, endedRes);
  let endedTimeouts = 0;
  readProxyBody(ended, endedRes, { limit: 2, drainExtra: 1024, drainMs: 0, onTooLarge: endedRecorder.fn,
    onDrainTimeout: () => { endedTimeouts++; } }, () => {});
  ended.emit('data', Buffer.from('abcd'));
  // 等待窗故意开得比"默认排空时限"短得多:这里只证明"这个窗口内没有超时动作",
  // 真要证明没装定时器得等到默认值(10s)才看得见,代价不值得 —— 出口仍然走得通就够了。
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(endedTimeouts, 0, 'drainMs=0 是有意义的取值,不能被当成"用默认时限"');
  assert.equal(endedRecorder.sends.length, 0);
  ended.emit('end');
  assert.equal(endedRecorder.sends.length, 1, 'end 仍然是正常出口');
  await tick();
  await tick();
  assert.equal(ended.destroyed, false, '走 end 出口时请求已收完,不需要再销毁');
  assert.equal(endedTimeouts, 0);
  dispose(ended, endedRes);

  const errored = fakeReq();
  const erroredRes = fakeRes();
  const erroredRecorder = tooLargeRecorder(errored, erroredRes);
  let erroredTimeouts = 0;
  readProxyBody(errored, erroredRes, { limit: 2, drainExtra: 1024, drainMs: 0, onTooLarge: erroredRecorder.fn,
    onDrainTimeout: () => { erroredTimeouts++; } }, () => {});
  errored.emit('data', Buffer.from('abcd'));
  errored.emit('error', new Error('socket hang up'));
  assert.equal(erroredRecorder.sends.length, 1);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(erroredTimeouts, 0);
  assert.equal(erroredRecorder.sends.length, 1, 'error 出口也只发一次');
  dispose(errored, erroredRes);
});

// ---- 正常结束路径不受影响 ----------------------------------------------------

test('a premature close before the body ends calls neither onBody nor onTooLarge', async () => {
  // 客户端半路走掉的真实机制是 close,不是 req 上的 error(实测 Node 不会为这种断连
  // 往 IncomingMessage 上抛 error),所以这里照真实事件序列发。
  const req = fakeReq();
  const res = fakeRes();
  const recorder = tooLargeRecorder(req, res);
  const onBody = [];
  readProxyBody(req, res, { limit: 4096, drainExtra: 1024, drainMs: 0, onTooLarge: recorder.fn },
    (text, size) => onBody.push({ text, size }));

  req.emit('data', Buffer.from('{"model":"x"'));
  req.emit('close');

  assert.deepEqual(onBody, [], '半截请求体不能当成功解析出去');
  assert.equal(recorder.sends.length, 0, '没超限就不该发 413');
  assert.equal(res.endedCount, 0);
  assert.equal(req.destroyed, true, '客户端断连时请求对象已是销毁态,后续出口都该跳过');
  // 不再补发 end:真 socket 上 close 之后 end 永不到来(IncomingMessage 的 'end' 在 close 时
  // 已被摘掉),造这个序列属于伪造事件,测到的东西在真实路径上不存在。
  dispose(req, res);
});

// ---- 定时器不许漏 ------------------------------------------------------------
// 用进程级的定时器账本比"断言回调被调了几次"更直接:漏清一个 setTimeout,排空时限一到
// 回调照样会跑,只有"进程里还剩几个活动定时器"能把这件事看出来。账本是全局的,
// 所以每条用例自己取前后差值,不跟别的用例的定时器混在一起。

test('clears the drain timer on the end, error, close and abort exits', async () => {
  const withCase = async (name, drive, opts = {}) => {
    const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    const req = fakeReq();
    const res = fakeRes();
    const recorder = tooLargeRecorder(req, res);
    readProxyBody(req, res, { limit: 2, drainExtra: 64, drainMs: 60000, onTooLarge: recorder.fn, ...opts }, () => {});
    req.emit('data', Buffer.from('abcd'));            // 越限,定时器装上(时限很长,自己不会响)
    const armed = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    assert.equal(armed, before + 1, `${name}: 超限后应当装上排空定时器`);
    drive(req, res);
    await tick();
    await tick();
    const after = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    assert.ok(after <= before, `${name}: 出口处必须把排空定时器清掉,否则悬挂定时器会把进程吊住`);
    dispose(req, res);
  };

  await withCase('排空走 end', req => req.emit('end'));
  await withCase('排空走 error', req => req.emit('error', new Error('socket hang up')));
  await withCase('排空走 close', req => req.emit('close'));
  await withCase('排空预算击穿', req => req.emit('data', Buffer.from('x'.repeat(4096))),
    { drainExtra: 2, onDrainAbort: () => {} });
});

// ---- 回调自身出问题时不能把调用方带走 ----------------------------------------

test('a throwing onTooLarge is swallowed and does not stop the abort or timeout path', async () => {
  // onTooLarge 是真实调用方(mixrouter.js 的 sendTooLarge)那一步,会碰 res 写协议响应,
  // 所以模块必须自己 try/catch(抽取说明里写明)。反过来说,调用方自己的计数器回调
  // (onDrainAbort/onDrainTimeout)按契约只是 `x++`,模块不为它们兜底 —— 这里就照契约
  // 只让 onTooLarge 抛,顺便验证它抛了以后后面的收尾动作一个都没被跳过。
  const abortReq = fakeReq();
  const abortRes = fakeRes();
  const abortRecorder = tooLargeRecorder(abortReq, abortRes);
  let aborts = 0;
  readProxyBody(abortReq, abortRes, {
    limit: 2, drainExtra: 1, drainMs: 0,
    // 真实调用方是这个形状:先把 413 写出去,写的过程中(或写完之后)才可能抛。
    // 抛在写响应之前的话,res 永远不会 finish,销毁也就不该发生 —— 那是另一回事。
    onTooLarge: () => { abortRecorder.fn(); throw new Error('protoError blew up'); },
    onDrainAbort: () => { aborts++; },
  }, () => {});

  abortReq.emit('data', Buffer.from('abc'));
  abortReq.emit('data', Buffer.from('de'));          // 累计 2 > 1,击穿
  assert.equal(aborts, 1, 'onTooLarge 抛错不能把 onDrainAbort 那一步一起吞掉');
  assert.equal(abortRecorder.sends.length, 1, '抛错发生在回调内部,响应该写还是要写出去');
  assert.equal(abortReq.paused, true, '回调抛错也不能跳过 pause');
  await tick();
  await tick();
  assert.equal(abortReq.destroyed, true, '回调抛错也不能跳过 finish 之后的销毁');
  dispose(abortReq, abortRes);

  const timeoutReq = fakeReq();
  const timeoutRes = fakeRes();
  const timeoutRecorder = tooLargeRecorder(timeoutReq, timeoutRes);
  let timeouts = 0;
  readProxyBody(timeoutReq, timeoutRes, {
    limit: 2, drainExtra: 1024, drainMs: 30,
    onTooLarge: () => { timeoutRecorder.fn(); throw new Error('protoError blew up'); },
    onDrainTimeout: () => { timeouts++; },
  }, () => {});

  timeoutReq.emit('data', Buffer.from('abcd'));      // 越限后停住不发
  assert.equal(await waitFor(() => timeouts > 0), true, 'onTooLarge 抛错不能把排空定时器废掉');
  assert.equal(timeouts, 1);
  assert.equal(timeoutRecorder.sends.length, 1);
  await tick();
  await tick();
  assert.equal(timeoutReq.destroyed, true, '超时出口的销毁也要照做');
  dispose(timeoutReq, timeoutRes);
});

test('oversize on an already finished response writes nothing and stays quiet', async () => {
  // writableEnded 的守卫有个容易漏掉的入口:响应写完之后**才**继续来 data。
  // 数据是异步到的,收完请求体才回头看 res 拿到的可能已是结束态;那时若还去
  // writeHead/write,Node 抛 ERR_STREAM_WRITE_AFTER_END。假件把 write 换成会抛的版本,
  // 漏了守卫就会当场炸出来,而不是只留下一句"响应少写了一次"。
  const explodeOnWrite = res => {
    res.writeHead = () => { throw new Error('write after end: writeHead'); };
    res.write = () => { throw new Error('write after end: write'); };
    res.end = () => { throw new Error('write after end: end'); };
    return res;
  };

  const req = fakeReq();
  const res = explodeOnWrite(fakeRes());
  const recorder = tooLargeRecorder(req, res);
  readProxyBody(req, res, { limit: 2, drainExtra: 1024, drainMs: 0, onTooLarge: recorder.fn }, () => {});

  req.emit('end');                                   // 响应此前已结束,而 end 之后照样超限数据
  res.writableEnded = true;
  req.emit('data', Buffer.from('abcd'));
  req.emit('end');
  assert.equal(recorder.sends.length, 0, 'writableEnded 之后不能再写响应');
  assert.equal(recorder.calls.length, 0, '连通知都不该发生,守卫在回调之前');
  dispose(req, res);

  const deadReq = fakeReq();
  deadReq.destroy();
  const deadRes = explodeOnWrite(fakeRes());
  const deadRecorder = tooLargeRecorder(deadReq, deadRes);
  readProxyBody(deadReq, deadRes, { limit: 2, drainExtra: 1024, drainMs: 0, onTooLarge: deadRecorder.fn }, () => {});
  deadReq.emit('data', Buffer.from('abcd'));
  deadReq.emit('end');
  assert.equal(deadRecorder.sends.length, 0, '请求已销毁时也不该写响应');
  assert.equal(deadRecorder.calls.length, 0);
  dispose(deadReq, deadRes);
});
