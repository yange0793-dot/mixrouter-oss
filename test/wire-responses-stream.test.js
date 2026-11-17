'use strict';
// Responses 转换层的**终态与工具流完整性**回归。
// 这里每一条都对应一个实测复现过的缺陷(审查块1/1续/6/6续/7),改坏了必须红:
//   - 上游断流被补成"正常结束"(答案被截断却标记成功)
//   - 截断(incomplete)被工具块改写成 tool_use/end_turn
//   - 中文多字节跨 TCP 包被切坏、CRLF 分帧整条丢
//   - 两个 function_call 的增量参数拼进同一个块
//   - 工具参数残缺仍以 tool_use 正常收尾
//   - "先 res.end 再异步结算 usage"导致成功被记成 client closed
// 全部走内存桩,不连真实上游。
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { PassThrough } = require('node:stream');

const wire = require('../lib/wire-responses.js');

const EOL = '\n';
const sse = (o, eol = EOL) => `event: ${o.type}${eol}data: ${JSON.stringify(o)}${eol}${eol}`;

function upstreamFake(status = 200) {
  const up = new PassThrough();
  up.statusCode = status;
  return up;
}

// 只实现 relay 用到的那几个成员:writeHead / write / end / headersSent / writableEnded / destroyed
function sink() {
  return {
    headersSent: false, writableEnded: false, destroyed: false, statusCode: 0, headers: null, text: '',
    writeHead(status, headers) { this.headersSent = true; this.statusCode = status; this.headers = headers; },
    write(chunk) { this.text += String(chunk); return true; },
    end() { this.writableEnded = true; },
  };
}

function parseSse(text) {
  return text.split('\n\n').filter(raw => raw.trim()).map(raw => {
    const lines = raw.split('\n');
    const name = (lines.find(l => l.startsWith('event: ')) || '').slice(7);
    const data = lines.filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
    let json = null;
    try { json = JSON.parse(data); } catch {}
    return { name, json };
  });
}
const relay = (up, res, opts) => wire.relayAnthropicStream(up, res, 'gpt-6-astra', opts);

// ---------------------------------------------------------------- 终态状态机
test('断流:上游中断后不得补 message_stop,只发协议级 error', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.created', response: { id: 'r1', model: 'gpt-6-astra' } }));
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } }));
  up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: '半截答案' }));
  up.destroy(new Error('socket hang up'));
  const r = await p;

  assert.ok(res.text.includes('半截答案'), '已经产出的内容要留给客户端');
  assert.ok(!res.text.includes('event: message_stop'), '断流不得伪造正常结束');
  assert.ok(!res.text.includes('"stop_reason":"end_turn"'), '断流不得给出正常 stop_reason');
  assert.ok(res.text.includes('event: error'), '要给出协议级 error');
  assert.strictEqual(r.aborted, true, '外层要能知道这是夭折,好记日志');
  assert.strictEqual(r.retryable, false);
});

test('EOF 但没给终态:同样不算成功', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: '只有半句' }));
  up.end();
  const r = await p;
  assert.ok(!res.text.includes('event: message_stop'));
  assert.ok(res.text.includes('event: error'));
  assert.strictEqual(r.aborted, true);
});

test('提交前夭折:一个字节都不下行,交给外层整条重试', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: true });
  up.write(sse({ type: 'response.created', response: { id: 'r1', model: 'gpt-6-astra' } }));
  up.destroy(new Error('ECONNRESET'));
  const r = await p;
  assert.strictEqual(r.retryable, true);
  assert.strictEqual(res.headersSent, false, '重试前提是还没给客户端写过字节');
  assert.strictEqual(res.text, '');
  assert.strictEqual(res.writableEnded, false, '这条 res 还要留给下一次尝试,不能 end 掉');
});

test('200 里夹带的错误体:提交前整条重试,同样不许 end 下游', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: true });
  up.write('data: {"type":"error","error":{"message":"上游渠道池打满"}}\n\n');
  const r = await p;
  assert.strictEqual(r.retryable, true);
  assert.strictEqual(res.headersSent, false);
  assert.strictEqual(res.writableEnded, false, '重试要用同一条 res,提前 end 会让下一次什么都写不进去');
});

test('completed:当场结算并结束下游,不枯等上游 EOF', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.created', response: { id: 'r1', model: 'gpt-6-astra' } }));
  up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: '答案' }));
  up.write(sse({
    type: 'response.completed',
    response: { id: 'r1', status: 'completed', model: 'gpt-6-astra', usage: { input_tokens: 30, output_tokens: 9, input_tokens_details: { cached_tokens: 10 } } },
  }));
  // 故意不 end 上游:旧实现要等上游 end/close 才 resolve,下游与日志都被晾着
  let timer = null;
  const guard = new Promise((_, bad) => { timer = setTimeout(() => bad(new Error('给了终态却还在等上游 EOF')), 800); });
  if (timer.unref) timer.unref();
  const r = await Promise.race([p, guard]);
  clearTimeout(timer);

  assert.strictEqual(res.writableEnded, true, '终态一到就该结束下游');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['Content-Type'], 'text/event-stream');
  assert.strictEqual(r.aborted, false);
  // 交回外层的 usage 是 Anthropic 口径:input 已扣掉缓存命中(30-10),缓存另计
  assert.strictEqual(r.usage.input_tokens, 20);
  assert.strictEqual(r.usage.output_tokens, 9);
  assert.strictEqual(r.usage.cache_read_input_tokens, 10);
  assert.ok(res.text.includes('"input_tokens":20'), `message_delta 的 input 应为 30-10,实际:${res.text}`);
  assert.ok(res.text.includes('"cache_read_input_tokens":10'));
});

test('下游 close 早于结算回调时,writableFinished 能把它和真取消区分开', async () => {
  // 真机形态:close 走 nextTick,比 promise 微任务还早,光靠 resolve 顺序压不住。
  // 外层(mixrouter.js 的 res.on('close'))据此放行,不再把成功记成 client closed。
  const seen = [];
  const server = http.createServer((req, res) => {
    let finalized = false;
    res.on('close', () => { seen.push({ ev: 'close', writableFinished: res.writableFinished, finalized }); });
    const up = upstreamFake();
    relay(up, res, {}).then(() => { finalized = true; seen.push({ ev: 'settled' }); });
    up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } } }));
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  server.unref();
  await new Promise((ok, bad) => {
    const creq = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: '/v1/messages', headers: { connection: 'close' } }, cres => {
      cres.resume();
      cres.on('end', ok);
    });
    creq.on('error', bad);
    creq.end();
  });
  await new Promise(ok => setTimeout(ok, 50));

  const close = seen.find(s => s.ev === 'close');
  assert.ok(close, '正常写完也会收到 close 事件');
  assert.strictEqual(close.writableFinished, true, 'close 时刻响应必须已 finished,外层才能据此放行');
});

test('incomplete:stop_reason 必须是 max_tokens,不能被工具块改写成 tool_use', async () => {
  for (const terminal of [
    { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
    { type: 'response.completed', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
  ]) {
    const up = upstreamFake(); const res = sink();
    const p = relay(up, res, { mayRetry: false });
    up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'Write' } }));
    up.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"file_path":"a.txt","content":"写到一' }));
    up.write(sse(terminal));
    await p;
    const evs = parseSse(res.text);
    const delta = evs.find(e => e.name === 'message_delta');
    assert.ok(delta, '应给出 message_delta');
    assert.strictEqual(delta.json.delta.stop_reason, 'max_tokens', `${terminal.type} 被截断必须如实表达`);
    assert.ok(res.text.includes('event: message_stop'), '截断仍是上游给出的终态,可以正常收尾');
    assert.ok(!res.text.includes('event: error'));
  }
});

test('completed 里带 status=failed / error 事件:不发 message_stop', async () => {
  for (const ev of [
    { type: 'response.completed', response: { status: 'failed', error: { message: '渠道池打满' } } },
    { type: 'response.failed', response: { status: 'failed', error: { message: '渠道池打满' } } },
    { type: 'error', error: { message: '渠道池打满' } },
  ]) {
    const up = upstreamFake(); const res = sink();
    const p = relay(up, res, { mayRetry: false });
    up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: 'x' }));
    up.write(sse(ev));
    const r = await p;
    assert.ok(!res.text.includes('event: message_stop'), `${ev.type} 不得以正常结束收尾`);
    assert.ok(res.text.includes('渠道池打满'), '原始错误要带给客户端');
    assert.strictEqual(r.aborted, true);
  }
});

test('empty failed terminal preserves the following gateway error in the same or next chunk', async () => {
  for (const separate of [false, true]) {
    const up = upstreamFake(); const res = sink();
    const p = relay(up, res, { mayRetry: true });
    const failed = sse({ type: 'response.failed', response: { status: 'failed', output: [], error: null } });
    const detail = sse({ type: 'error', error: { type: 'user_error', code: 'DeploymentNotFound',
      headers: { 'x-ms-fe-error': 'true' },
      message: 'Could not find an existing deployment to match the model in the request.' } });
    if (separate) {
      up.write(failed);
      assert.strictEqual(res.headersSent, false, 'wait for the error detail before committing');
      await new Promise(resolve => setImmediate(resolve));
      up.end(detail);
    } else up.end(failed + detail);
    const result = await p;
    assert.strictEqual(result.retryable, false, 'an unavailable deployment is not a generic transient error');
    assert.strictEqual(result.aborted, true);
    assert.match(result.detail, /DeploymentNotFound/);
    assert.match(res.text, /Could not find an existing deployment/);
    assert.doesNotMatch(res.text, /upstream failure|event: message_stop/);
  }
});

test('empty failed terminal at EOF still closes as a failure', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: true });
  up.end(sse({ type: 'response.failed', response: { status: 'failed', output: [], error: null } }));
  const result = await p;
  assert.strictEqual(result.retryable, false);
  assert.strictEqual(result.aborted, true);
  assert.match(result.detail, /response\.failed/);
  assert.ok(res.writableEnded);
  assert.doesNotMatch(res.text, /event: message_stop/);
});

test('pre-output transient failed terminals retry without leaking the failed stream', async () => {
  for (const detailedTail of [false, true]) {
    const up = upstreamFake(); const res = sink();
    const p = relay(up, res, { mayRetry: true });
    const error = { code: 'rate_limit_exceeded', type: 'too_many_requests',
      message: 'Too many requests', headers: { 'x-ms-fe-error': 'true' } };
    up.end(sse({ type: 'response.failed', response: { status: 'failed', output: [], error: detailedTail ? null : error } })
      + (detailedTail ? sse({ type: 'error', error }) : ''));
    const result = await p;
    assert.strictEqual(result.retryable, true);
    assert.strictEqual(res.headersSent, false);
    assert.strictEqual(res.text, '');
    assert.strictEqual(res.writableEnded, false);
    assert.match(result.detail, /Too many requests/);
  }
});

test('terminal auth errors and failures after output are never replayed', async () => {
  for (const hasOutput of [false, true]) {
    const up = upstreamFake(); const res = sink();
    const p = relay(up, res, { mayRetry: true });
    if (hasOutput) up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: 'already visible' }));
    up.end(sse({ type: 'response.failed', response: { status: 'failed', output: [],
      error: { code: hasOutput ? 'rate_limit_exceeded' : 'invalid_api_key', message: hasOutput ? 'Too many requests' : 'Invalid API key' } } }));
    const result = await p;
    assert.strictEqual(result.retryable, false);
    assert.strictEqual(result.aborted, true);
    assert.doesNotMatch(res.text, /event: message_stop/);
    if (hasOutput) assert.match(res.text, /already visible/);
  }
});

test('deployment recovery is scoped to official AgentRouter and an uncommitted empty response', async () => {
  for (const [base_url, hasOutput, allowed] of [
    ['https://agentrouter.org', false, true],
    ['https://ps.air-outer.com', false, true],
    ['https://other.example', false, false],
    ['http://agentrouter.org', false, false],
    ['https://agentrouter.org', true, false],
  ]) {
    const up = upstreamFake(); const res = sink();
    const p = relay(up, res, { mayRetry: true, provider: { base_url } });
    if (hasOutput) up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: 'already visible' }));
    up.write(sse({ type: 'response.failed', response: { status: 'failed', output: [], error: null } }));
    up.end(sse({ type: 'error', error: { type: 'user_error', code: 'DeploymentNotFound',
      headers: { 'x-ms-fe-error': 'true' }, message: 'Could not find an existing deployment.' } }));
    const result = await p;
    assert.strictEqual(result.retryable, allowed, `${base_url}, output=${hasOutput}`);
    assert.match(result.detail, /DeploymentNotFound/);
    assert.doesNotMatch(res.text, /event: message_stop/);
    if (allowed) assert.strictEqual(res.text, '');
  }
});

test('a detailed error cannot replay a failed response with output or overwrite it with success', async () => {
  for (const laterSuccess of [false, true]) {
    const up = upstreamFake(); const res = sink();
    const p = relay(up, res, { mayRetry: true });
    up.write(sse({ type: 'response.failed', response: { status: 'failed', error: null,
      output: laterSuccess ? [] : [{ type: 'function_call', call_id: 'do-once', name: 'Write', arguments: '{}' }] } }));
    up.end(sse(laterSuccess
      ? { type: 'response.completed', response: { status: 'completed', output: [] } }
      : { type: 'error', error: { code: 'rate_limit_exceeded', message: 'Too many requests' } }));
    const result = await p;
    assert.strictEqual(result.retryable, false);
    assert.strictEqual(result.aborted, true);
    assert.doesNotMatch(res.text, /event: message_stop/);
  }
});

// ---------------------------------------------------------------- 工具流完整性
test('多工具交错:两个 function_call 各自成块,参数不串', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'a', name: 'Write' } }));
  up.write(sse({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'b', name: 'Edit' } }));
  up.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"p":"a"}' }));
  up.write(sse({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"p":"b"}' }));
  up.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'a', name: 'Write' } }));
  up.write(sse({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'b', name: 'Edit' } }));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } }));
  await p;

  const evs = parseSse(res.text);
  const starts = evs.filter(e => e.name === 'content_block_start');
  assert.deepStrictEqual(starts.map(s => [s.json.index, s.json.content_block.id, s.json.content_block.name]),
    [[0, 'a', 'Write'], [1, 'b', 'Edit']], '每个工具调用一个块,id/name 归属正确');
  const args = evs.filter(e => e.name === 'content_block_delta' && e.json.delta.type === 'input_json_delta');
  assert.deepStrictEqual(args.map(a => [a.json.index, JSON.parse(a.json.delta.partial_json)]),
    [[0, { p: 'a' }], [1, { p: 'b' }]], '参数不许拼成一个');
  const delta = evs.find(e => e.name === 'message_delta');
  assert.strictEqual(delta.json.delta.stop_reason, 'tool_use');
});

test('零参数工具调用也要有 tool_use 块', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c9', name: 'Bash' } }));
  up.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c9', name: 'Bash' } }));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: {} } }));
  await p;
  const evs = parseSse(res.text);
  const start = evs.find(e => e.name === 'content_block_start');
  assert.strictEqual(start.json.content_block.type, 'tool_use');
  assert.strictEqual(start.json.content_block.id, 'c9');
  assert.deepStrictEqual(start.json.content_block.input, {});
  assert.strictEqual(evs.find(e => e.name === 'message_delta').json.delta.stop_reason, 'tool_use');
});

test('工具参数残缺却报 completed:按失败处理,不当成可执行调用', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'Write' } }));
  up.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"file_path":"a.tx' }));
  up.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'Write' } }));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: {} } }));
  const r = await p;
  assert.ok(!res.text.includes('event: message_stop'));
  assert.ok(res.text.includes('event: error'));
  assert.strictEqual(r.aborted, true);
});

test('output_item.done 带着非法 JSON 参数:工具块一个字节都不下行', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'Write' } }));
  // 上游把截断的参数当"完整 item"发下来:以前这里先开 tool_use 块、把坏 JSON 当
  // input_json_delta 发出去,随后 finishTerminal 才改口报错 —— 客户端已拿到可执行块。
  up.write(sse({ type: 'response.output_item.done', output_index: 0,
    item: { type: 'function_call', call_id: 'c1', name: 'Write', arguments: '{"file_path":"a.tx' } }));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: {} } }));
  const r = await p;

  assert.ok(!res.text.includes('"type":"tool_use"'), `坏参数工具块不许下行:${res.text}`);
  assert.ok(!res.text.includes('input_json_delta'), '坏参数不许当 partial_json 发给客户端');
  assert.ok(res.text.includes('event: error'), '要给出协议级 error');
  assert.ok(res.text.includes('工具调用参数不完整'));
  assert.strictEqual(r.aborted, true);
});

// ---------------------------------------------------------------- 增量解码
test('中文跨 TCP 包:多字节字符被切开也不许出现替换符', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  const frame = Buffer.from(sse({ type: 'response.output_text.delta', output_index: 0, delta: '中文答案' }), 'utf8');
  const cut = frame.indexOf(Buffer.from('中')) + 1; // 切在「中」的三个字节中间
  up.write(frame.subarray(0, cut));
  up.write(frame.subarray(cut));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: {} } }));
  await p;
  assert.ok(res.text.includes('中文答案'), `实际收到:${res.text}`);
  assert.ok(!res.text.includes('�'), '不许出现 U+FFFD 替换符');
});

test('CRLF 分帧的合法 SSE 也要认', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } }, '\r\n'));
  up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: 'CRLF 也要通' }, '\r\n'));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: { output_tokens: 3 } } }, '\r\n'));
  await p;
  assert.ok(res.text.includes('CRLF 也要通'), '只认 \\n\\n 会把 CRLF 流整条丢掉');
  assert.ok(res.text.includes('event: message_stop'));
});

test('注释行(上游心跳)不干扰分帧', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(': keep-alive\n\n');
  up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: 'ok' }));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: {} } }));
  await p;
  assert.ok(res.text.includes('ok'));
  assert.ok(res.text.includes('event: message_stop'));
});

test('上游不发 output_index:增量要归到同一个块,不能每个 delta 开一块', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_text.delta', delta: '甲' }));
  up.write(sse({ type: 'response.output_text.delta', delta: '乙' }));
  up.write(sse({ type: 'response.output_text.delta', delta: '丙' }));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: {} } }));
  await p;
  const evs = parseSse(res.text);
  assert.strictEqual(evs.filter(e => e.name === 'content_block_start').length, 1, '应只有一个文本块');
  const text = evs.filter(e => e.name === 'content_block_delta' && e.json.delta.type === 'text_delta')
    .map(e => e.json.delta.text).join('');
  assert.strictEqual(text, '甲乙丙');
});

test('工具事件换称呼(只带 id / 只带 index)也算同一次调用', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read' } }));
  up.write(sse({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"p":1}' }));
  up.write(sse({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', name: 'Read' } }));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: {} } }));
  await p;
  const evs = parseSse(res.text);
  const starts = evs.filter(e => e.name === 'content_block_start' && e.json.content_block.type === 'tool_use');
  assert.strictEqual(starts.length, 1, '一次工具调用只能出一个块');
  const args = evs.find(e => e.name === 'content_block_delta' && e.json.delta.type === 'input_json_delta');
  assert.strictEqual(args.json.delta.partial_json, '{"p":1}', '增量要落到它自己的调用上');
  assert.strictEqual(evs.find(e => e.name === 'message_delta').json.delta.stop_reason, 'tool_use');
});

// ---------------------------------------------------------------- 非流式路径
test('responsesErrorOf:三种"200 但其实失败"都要认出来', () => {
  assert.ok(wire.responsesErrorOf({ status: 'failed', error: { message: 'mock failure' } }));
  assert.ok(wire.responsesErrorOf({ error: { message: '渠道池打满' } }));
  assert.ok(wire.responsesErrorOf({
    status: 'completed',
    output: [{ type: 'function_call', call_id: 'c1', name: 'Write', arguments: '{"file_path":"a.tx' }],
  }), 'completed 带着残缺工具参数同样是失败');
  assert.strictEqual(wire.responsesErrorOf({ status: 'completed', output: [{ type: 'message', content: [] }] }), null);
  assert.strictEqual(wire.responsesErrorOf({ status: 'incomplete', output: [] }), null, '截断不是错误');
});

test('responsesToAnthropic:截断与缓存计数的映射', () => {
  const cut = wire.responsesToAnthropic({ status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: '半句' }] }] }, 'm');
  assert.strictEqual(cut.stop_reason, 'max_tokens');
  const withCache = wire.responsesToAnthropic({
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }],
    usage: { input_tokens: 200, output_tokens: 5, input_tokens_details: { cached_tokens: 150 } },
  }, 'm');
  assert.strictEqual(withCache.usage.input_tokens, 50, '缓存命中要从 input 里减掉(Anthropic 语义)');
  assert.strictEqual(withCache.usage.cache_read_input_tokens, 150);
});

test('tool_choice:none 原样传 none,不许变成 auto', () => {
  const base = { model: 'm', messages: [], tools: [{ name: 'T', input_schema: { type: 'object', properties: {} } }] };
  assert.strictEqual(wire.anthropicToResponses({ ...base, tool_choice: { type: 'none' } }).tool_choice, 'none');
  assert.strictEqual(wire.anthropicToResponses({ ...base, tool_choice: { type: 'auto' } }).tool_choice, 'auto');
  assert.strictEqual(wire.anthropicToResponses({ ...base, tool_choice: { type: 'any' } }).tool_choice, 'required');
  assert.deepStrictEqual(wire.anthropicToResponses({ ...base, tool_choice: { type: 'tool', name: 'T' } }).tool_choice, { type: 'function', name: 'T' });
});

// ---------------------------------------------------------------- 思考转发
test('思考转发:reasoning 事件进 thinking 块(正文之前),以空 signature 收尾', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.created', response: { id: 'r1', model: 'qwen3.8-flash' } }));
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs1' } }));
  up.write(sse({ type: 'response.reasoning_text.delta', output_index: 0, delta: '想一下' }));
  up.write(sse({ type: 'response.reasoning_text.delta', output_index: 0, delta: '…' }));
  up.write(sse({ type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'm1' } }));
  up.write(sse({ type: 'response.output_text.delta', output_index: 1, delta: '好' }));
  up.write(sse({ type: 'response.completed', response: { id: 'r1', status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 9 } } }));
  const r = await p;

  const evs = parseSse(res.text);
  const starts = evs.filter(e => e.name === 'content_block_start');
  assert.strictEqual(starts[0].json.content_block.type, 'thinking', '思考块必须在正文块之前');
  assert.strictEqual(starts[1].json.content_block.type, 'text');
  const think = evs.filter(e => e.name === 'content_block_delta' && e.json.delta.type === 'thinking_delta')
    .map(e => e.json.delta.thinking).join('');
  assert.strictEqual(think, '想一下…', '思考内容要完整转发(思考关不掉的模型,这是花钱买的能力)');
  const sig = evs.filter(e => e.name === 'content_block_delta' && e.json.delta.type === 'signature_delta');
  assert.strictEqual(sig.length, 1, 'thinking 块要以 signature_delta 收尾');
  assert.strictEqual(sig[0].json.delta.signature, '');
  const text = evs.filter(e => e.name === 'content_block_delta' && e.json.delta.type === 'text_delta')
    .map(e => e.json.delta.text).join('');
  assert.strictEqual(text, '好', '思考不得混进正文');
  assert.strictEqual(r.aborted, false);
});

test('思考转发:reasoning_summary_text.delta(标准事件名)同样认', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs1' } }));
  up.write(sse({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '摘要思考' }));
  up.write(sse({ type: 'response.output_text.delta', output_index: 1, delta: '答' }));
  up.write(sse({ type: 'response.completed', response: { id: 'r1', status: 'completed', output: [], usage: {} } }));
  await p;
  const think = parseSse(res.text).filter(e => e.name === 'content_block_delta' && e.json.delta.type === 'thinking_delta')
    .map(e => e.json.delta.thinking).join('');
  assert.strictEqual(think, '摘要思考');
});

test('思考转发:只有思考没有正文(全花在 reasoning)也要正常收尾', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs1' } }));
  up.write(sse({ type: 'response.reasoning_text.delta', output_index: 0, delta: '全花在思考上' }));
  up.write(sse({ type: 'response.completed', response: { id: 'r1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: {} } }));
  const r = await p;
  const evs = parseSse(res.text);
  assert.strictEqual(evs.filter(e => e.name === 'content_block_start')[0].json.content_block.type, 'thinking');
  assert.ok(evs.some(e => e.name === 'content_block_stop'));
  assert.strictEqual(evs.find(e => e.name === 'message_delta').json.delta.stop_reason, 'max_tokens');
  assert.strictEqual(r.aborted, false);
});

test('思考转发:思考块之后的工具块不得把 signature 挤掉', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs1' } }));
  up.write(sse({ type: 'response.reasoning_text.delta', output_index: 0, delta: '先想' }));
  up.write(sse({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'c1', name: 'Bash' } }));
  up.write(sse({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"cmd":"ls"}' }));
  up.write(sse({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'c1', name: 'Bash', arguments: '{"cmd":"ls"}' } }));
  up.write(sse({ type: 'response.completed', response: { id: 'r1', status: 'completed', output: [], usage: {} } }));
  const r = await p;
  const evs = parseSse(res.text);
  const thinkStop = evs.findIndex(e => e.name === 'content_block_stop');
  const sigIdx = evs.findIndex(e => e.name === 'content_block_delta' && e.json.delta.type === 'signature_delta');
  const toolStart = evs.findIndex(e => e.name === 'content_block_start' && e.json.content_block.type === 'tool_use');
  assert.ok(sigIdx !== -1 && sigIdx < thinkStop, 'thinking 块关闭前必须先发 signature');
  assert.ok(thinkStop < toolStart, '思考块先关,工具块后开');
  assert.strictEqual(evs.find(e => e.name === 'message_delta').json.delta.stop_reason, 'tool_use');
  assert.strictEqual(r.aborted, false);
});

// ---------------------------------------------------------------- EOF 残帧
// 上游 res.end() 常常紧跟在最后一个事件后面:最后一条 `data:` 没有空行收尾。
// transition 线以前只处理完整帧,残段里的 response.completed 从没被解析过。
test('末帧 completed 没有 \\n\\n:EOF 补解析后判成功并结算 usage', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.created', response: { id: 'r-eof', model: 'gpt-6-astra' } }));
  up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: '答案' }));
  up.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r-eof', status: 'completed',
    output: [], usage: { input_tokens: 12, output_tokens: 4 } } })}`); // 无收尾空行
  const r = await p;

  assert.strictEqual(r.aborted, false, '残帧是正常终态,不能记成夭折');
  assert.strictEqual(r.retryable, false);
  assert.strictEqual(r.usage.input_tokens, 12);
  assert.strictEqual(r.usage.output_tokens, 4);
  assert.ok(res.text.includes('答案'), '已经产出的正文要留给客户端');
  assert.ok(res.text.includes('event: message_stop'));
  assert.ok(!res.text.includes('event: error'));
});

test('末帧 JSON 真截断:EOF 补分隔符后仍判夭折', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: '半截' }));
  up.end('data: {"type":"response.completed","response":{"status":"completed"');
  const r = await p;

  assert.strictEqual(r.aborted, true, '解析不出的残帧不能当成终态');
  assert.ok(!res.text.includes('event: message_stop'), '不得伪造正常结束');
  assert.ok(res.text.includes('event: error'));
});

// ---------------------------------------------------------------- 缓冲上限
// 单条事件一直不闭合(上游卡死/畸形流)时,残段不能无界增长。
test('单条事件超过 4MB 还不闭合:丢弃残段,后续帧在分隔符处重新对齐', () => {
  const res = sink();
  const st = new wire.AnthropicStream(res, 'gpt-6-astra', {});
  st.feed(`data: {"type":"response.output_text.delta","delta":"${'x'.repeat(wire.SSE_BUFFER_LIMIT + 1)}`);
  assert.strictEqual(st.buf, '', '超过上限的未闭合残段必须被丢掉');
  // 丢弃点落在事件中间:下一块直到分隔符前都是坏 JSON,解析器忽略;之后的完整事件照常处理
  st.feed('"}\n\ndata: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n');
  assert.strictEqual(st.finished, true, '重新对齐后的终态事件仍要认出');
  assert.strictEqual(st.terminal, 'completed');
});

// ---------------------------------------------------------------- 输出序号缺一半
// 同一 item 的早期事件只带 item_id、done 才带 output_index 的上游形状:
// 键必须归一到同一个,否则正文会重发一遍、工具调用会变成两个 tool_use。
test('output_index 只在 done 出现:正文不重复,同一次工具调用不拆成两块', async () => {
  {
    const up = upstreamFake(); const res = sink();
    const p = relay(up, res, { mayRetry: false });
    up.write(sse({ type: 'response.created', response: { id: 'r1', model: 'gpt-6-astra' } }));
    up.write(sse({ type: 'response.output_item.added', item: { type: 'message', id: 'm1' } }));
    up.write(sse({ type: 'response.output_text.delta', item_id: 'm1', delta: 'hello' }));
    up.write(sse({ type: 'response.output_text.done', output_index: 0, item_id: 'm1', text: 'hello' }));
    up.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1' } }));
    up.write(sse({ type: 'response.completed', response: { id: 'r1', model: 'gpt-6-astra', usage: {} } }));
    up.end();
    await p;
    const deltas = parseSse(res.text)
      .filter(e => e.name === 'content_block_delta' && e.json?.delta?.type === 'text_delta')
      .map(e => e.json.delta.text);
    assert.deepEqual(deltas, ['hello'], 'done 自带的全文不能因为换了键就再发一遍');
  }
  {
    const up = upstreamFake(); const res = sink();
    const p = relay(up, res, { mayRetry: false });
    up.write(sse({ type: 'response.created', response: { id: 'r1', model: 'gpt-6-astra' } }));
    up.write(sse({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c1', name: 'Write' } }));
    up.write(sse({ type: 'response.function_call_arguments.delta', item_id: 'c1', delta: '{"p":"a"}' }));
    up.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'Write' } }));
    up.write(sse({ type: 'response.completed', response: { id: 'r1', model: 'gpt-6-astra', usage: {} } }));
    up.end();
    await p;
    const starts = parseSse(res.text)
      .filter(e => e.name === 'content_block_start' && e.json?.content_block?.type === 'tool_use');
    assert.equal(starts.length, 1, '同一次工具调用不能发两个 tool_use');
    assert.equal(starts[0].json.content_block.id, 'c1');
  }
});
