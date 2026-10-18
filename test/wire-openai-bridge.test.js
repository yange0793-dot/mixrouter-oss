'use strict';
// lib/wire-openai-bridge.js 的边界回归:Responses ⇄ Chat 转换层(两端都是 OpenAI 协议)。
//
// 与 test/codex.test.js 的分工:那边测的是**经 mixrouter 的整条 Codex 通路**(mock 上游 +
// 临时数据目录),这里只测本模块的纯函数与 SSE 收尾,不 require mixrouter.js。
// 两边对同一批行为故意各测一次:codex.test.js 保证"接得上",本文件保证"搬出来之后
// 逐条行为没变",所以重复是刻意的,不是冗余。
//
// 每条都对应一条会被静默毁掉的行为,改坏了必须红:
//   - 未知 input item 原样透传 → 上游 400(而客户端只看到"模型不支持")
//   - function_call_output 的对象形状不拆开 → 工具结果变成 [object Object]
//   - 整包 JSON 来的响应没有摊成 SSE 事件序列 → codex 报 "no active item"
//   - extraHeaders 里的 application/json 没被盖掉 → SSE 体配 JSON 头,客户端一个事件都解析不出
//   - usage 只在末尾那次出现 → 抠早了整条统计归零
//   - chat SSE 在 [DONE] 之后还继续收 → 收尾后重复写响应
// 全部纯内存,不连上游、不读配置。
const { test } = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');

const wire = require('../lib/wire-openai-bridge.js');

// 只实现 sse 收尾用到的成员。**write 在 end 之后抛异常**是刻意的:Node 的真 res 就是这样
// (ERR_STREAM_WRITE_AFTER_END),模块的 sse() 用 try/catch 把它吞掉。桩若不模拟这一条,
// "终态之后不许再写内容"就变成在测桩本身而不是测模块。
function sink() {
  return {
    headersSent: false, statusCode: 0, headers: null, text: '', ended: false,
    writeHead(status, headers) { this.headersSent = true; this.statusCode = status; this.headers = headers; },
    write(chunk) {
      if (this.ended) throw new Error('write after end');
      this.text += String(chunk); return true;
    },
    end() { this.ended = true; },
  };
}
const events = text => text.split('\n\n').filter(r => r.trim())
  .map(r => { try { return JSON.parse(r.slice(6)); } catch { return null; } });
const types = text => events(text).map(e => e && e.type);

// ---------------------------------------------------------------- 模块契约
test('require 本模块不读配置、不起监听:纯函数集合,导出面只含真有外部消费者的成员', () => {
  // 只被本模块内部使用的(randId / chatImagePart / responsesUsage / itemToChatMessages)
  // 故意不导出 —— 导出一多,搬迁后的调用点就会有人从模块外绕进去,边界又糊了
  assert.deepStrictEqual(Object.keys(wire).sort(),
    ['chatJsonToResponses', 'chatToolChoice', 'emitResponsesSse', 'extractUsageOpenAI',
      'lastNum', 'responsesToChat', 'streamChatAsResponses'].sort());
  assert.strictEqual(typeof wire.responsesUsage, 'undefined', '内部函数不该出现在导出面上');
  assert.strictEqual(typeof wire.itemToChatMessages, 'undefined');
  assert.strictEqual(typeof wire.chatImagePart, 'undefined');
  assert.strictEqual(typeof wire.randId, 'undefined');
});

// ---------------------------------------------------------------- 请求方向
test('responsesToChat:instructions→system、developer→system、工具调用/结果成对映射', () => {
  const cc = wire.responsesToChat({
    model: 'm', instructions: '你是助手', max_output_tokens: 4096, temperature: 0.3,
    tools: [{ type: 'function', name: 'f', parameters: { type: 'object' } }, { type: 'web_search' }],
    tool_choice: { type: 'function', name: 'f' }, parallel_tool_calls: true,
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'skill' }] },
      { type: 'message', role: 'user', content: 'q' },
      { type: 'function_call', call_id: 'c9', name: 'f', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'c9', output: { content: [{ type: 'output_text', text: 'r' }] } },
    ],
  }, {});
  assert.strictEqual(cc.max_tokens, 4096);
  assert.strictEqual(cc.temperature, 0.3);
  assert.deepStrictEqual(cc.messages.map(m => m.role), ['system', 'system', 'user', 'assistant', 'tool']);
  assert.strictEqual(cc.messages[3].tool_calls[0].id, 'c9');
  assert.strictEqual(cc.messages[4].content, 'r');
  assert.strictEqual(cc.tools.length, 1, '非 function 工具丢弃');
  assert.deepStrictEqual(cc.tool_choice, { type: 'function', function: { name: 'f' } });
  assert.strictEqual(cc.parallel_tool_calls, true);
});

test('responsesToChat:未知 item 一律忽略,不原样透传(透传就是上游 400)', () => {
  const cc = wire.responsesToChat({ model: 'm', input: [
    { type: 'local_shell_call', action: {} }, { type: 'web_search_call' },
    { type: 'computer_call' }, { type: 'reasoning', summary: [] }, { type: 'reasoning_summary' },
    { type: 'message', role: 'user', content: '真问题' },
  ] }, {});
  assert.deepStrictEqual(cc.messages.map(m => m.role), ['user'], '五种未知 item 一个都不该落地');
  assert.strictEqual(cc.messages[0].content, '真问题');
});

test('responsesToChat:完全没有可用消息时补一条占位,不让上游收到空 messages', () => {
  const cc = wire.responsesToChat({ model: 'm', input: [{ type: 'reasoning' }] }, {});
  assert.deepStrictEqual(cc.messages, [{ role: 'user', content: '(empty request)' }]);
  assert.deepStrictEqual(wire.responsesToChat({ model: 'm' }, {}).messages, [{ role: 'user', content: '(empty request)' }]);
  // 只有 system 也算不上有 user
  assert.strictEqual(wire.responsesToChat({ model: 'm', instructions: 's', input: [] }, {}).messages.length, 2);
});

test('responsesToChat:输出恒为流式并主动要 usage(不要 usage 就永远拿不到统计)', () => {
  assert.deepStrictEqual(wire.responsesToChat({ model: 'm', input: 'q' }, {}).stream_options, { include_usage: true });
  const nonStream = wire.responsesToChat({ model: 'm', input: 'q', stream: false }, {});
  assert.strictEqual(nonStream.stream, false);
  assert.strictEqual(nonStream.stream_options, undefined, '非流式不该带 stream_options');
  // stream 只在严格等于 false 时才算关:上游默认流式,漏判会退化成"等整篇生成才发头"
  assert.strictEqual(wire.responsesToChat({ model: 'm', input: 'q', stream: 0 }, {}).stream, true);
});

test('responsesToChat:图片默认转 image_url,渠道标 drop_images 才降级为说明文字', () => {
  const body = { model: 'm', input: [{ type: 'message', role: 'user', content: [
    { type: 'input_text', text: '看' }, { type: 'input_image', image_url: 'data:image/png;base64,AA' },
  ] }] };
  const parts = wire.responsesToChat(body, {}).messages[0].content;
  assert.ok(Array.isArray(parts));
  assert.deepStrictEqual(parts[0], { type: 'text', text: '看' });
  assert.strictEqual(parts[1].image_url.url, 'data:image/png;base64,AA');

  const dropped = wire.responsesToChat(body, { drop_images: true }).messages[0].content;
  assert.strictEqual(typeof dropped, 'string', '全丢图之后不该再留数组形状');
  assert.ok(dropped.includes('丢弃图片'), '要留一句说明而不是静默丢');
  // 拿不到 url 的图片块同样降级,不能变成空 image_url 让上游 400
  const bad = wire.responsesToChat({ model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_image' }] }] }, {});
  assert.ok(String(bad.messages[0].content).includes('丢弃图片'));
});

test('responsesToChat:input 为字符串/数组/畸形值三种形状都兜住', () => {
  assert.deepStrictEqual(wire.responsesToChat({ model: 'm', input: 'hi' }, {}).messages, [{ role: 'user', content: 'hi' }]);
  // 数组里全是无效元素:会被当成"已经有 user 消息"(那条空消息确实被 push 了),
  // 于是不再补 "(empty request)"。这是原实现口径,照搬不改。
  assert.deepStrictEqual(wire.responsesToChat({ model: 'm', input: [null, undefined, 0, ''] }, {}).messages,
    [{ role: 'user', content: '' }]);
  assert.deepStrictEqual(wire.responsesToChat({ model: 'm', input: null }, {}).messages, [{ role: 'user', content: '(empty request)' }]);
  assert.deepStrictEqual(wire.responsesToChat({}, {}).messages, [{ role: 'user', content: '(empty request)' }]);
  // 缺少 provider 实参不能抛
  assert.deepStrictEqual(wire.responsesToChat({ model: 'm', input: 'q' }).messages, [{ role: 'user', content: 'q' }]);
});

// ---------------------------------------------------------------- 畸形 item
test('itemToChatMessages 的畸形形态经 responsesToChat 兜住,不抛不产生空消息', () => {
  const cases = [
    [{ type: 'message', content: null }, { role: 'user', content: '' }],
    [{ type: 'message', role: 'user', content: 42 }, { role: 'user', content: '' }],
    [{ type: 'message', role: 'user', content: [null, undefined] }, { role: 'user', content: '' }],
    [{ type: 'message', role: 'user', content: ['x', 'y'] }, { role: 'user', content: 'x\ny' }],
    [{ type: 'function_call' }, 'assistant-with-empty-name'],
    [{ type: 'function_call_output', output: { a: 1 } },  'tool-json'],
    [{ type: 'function_call_output', output: [1, 2] },    'tool-json'],
    [{ type: 'function_call_output', output: false },     'tool-json'],
    [{ type: 'function_call_output' },                    'tool-json'],
  ];
  for (const [item, want] of cases) {
    const cc = wire.responsesToChat({ model: 'm', input: [item] }, {});
    const msg = cc.messages[0];
    if (typeof want === 'string' && want.startsWith('tool-')) {
      assert.strictEqual(msg.role, 'tool', JSON.stringify(item));
      assert.strictEqual(typeof msg.content, 'string', '工具结果必须是字符串,不能是 [object Object]');
      assert.ok(msg.content.length > 0);
    } else if (want === 'assistant-with-empty-name') {
      assert.strictEqual(msg.role, 'assistant');
      assert.strictEqual(msg.tool_calls[0].function.name, '');
      assert.strictEqual(msg.tool_calls[0].function.arguments, '{}');
    } else {
      assert.deepStrictEqual({ role: msg.role, content: msg.content }, want, JSON.stringify(item));
    }
  }
});

// ---------------------------------------------------------------- 工具选择
test('chatToolChoice:字符串原样、function 两种写法归一、其余一律 auto', () => {
  assert.strictEqual(wire.chatToolChoice('auto'), 'auto');
  assert.strictEqual(wire.chatToolChoice('none'), 'none');
  assert.deepStrictEqual(wire.chatToolChoice({ type: 'function', name: 'f' }), { type: 'function', function: { name: 'f' } });
  const already = { type: 'function', function: { name: 'g' } };
  assert.strictEqual(wire.chatToolChoice(already), already, '已经是 chat 形状就原样，别包第二层');
  assert.strictEqual(wire.chatToolChoice({ type: 'web_search' }), 'auto');
  assert.strictEqual(wire.chatToolChoice({ type: 'function' }), 'auto');
  assert.strictEqual(wire.chatToolChoice(undefined), 'auto', '缺省要显式 auto，不能 undefined 传上去');
  assert.strictEqual(wire.chatToolChoice(null), null);
});

// ---------------------------------------------------------------- usage
test('extractUsageOpenAI/lastNum:取最后一次出现,中途的旧值不许留下', () => {
  assert.deepStrictEqual(
    wire.extractUsageOpenAI('responses', '{"input_tokens":1,"output_tokens":2}{"input_tokens":10,"output_tokens":20}'),
    { in: 10, out: 20, cache_read: 0 }, '首匹配会抠到中途的旧值');
  assert.deepStrictEqual(
    wire.extractUsageOpenAI('chat', 'data: {"usage":{"prompt_tokens":7,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":2}}}'),
    { in: 7, out: 5, cache_read: 2 });
  assert.deepStrictEqual(
    wire.extractUsageOpenAI('responses', '{"input_tokens_details":{"cached_tokens":4},"input_tokens":21,"output_tokens":13}'),
    { in: 21, out: 13, cache_read: 4 });
  assert.deepStrictEqual(wire.extractUsageOpenAI('chat', 'nothing'), { in: 0, out: 0, cache_read: 0 });
  assert.deepStrictEqual(wire.extractUsageOpenAI('chat', ''), { in: 0, out: 0, cache_read: 0 });
  // 带 g 标志的正则进来也必须只算一遍(复用 RegExp 会让 lastIndex 残留)
  assert.strictEqual(wire.lastNum('1 2 3', /(\d)/g), 3);
  assert.strictEqual(wire.lastNum('1 2 3', /(\d)/g), 3, '同一条正则连用两次结果必须一致');
});

// ---------------------------------------------------------------- 非流式响应方向
test('chatJsonToResponses:正文与工具调用都摊成 responses output', () => {
  const resp = wire.chatJsonToResponses({
    id: 'c1',
    choices: [{ message: { content: '好的', tool_calls: [{ id: 'k1', function: { name: 'f', arguments: '{"a":1}' } }] } }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, prompt_tokens_details: { cached_tokens: 2 } },
  }, 'm');
  assert.strictEqual(resp.object, 'response');
  assert.strictEqual(resp.model, 'm');
  assert.strictEqual(resp.id, 'c1');
  assert.deepStrictEqual(resp.output.map(o => o.type), ['message', 'function_call']);
  assert.strictEqual(resp.output[0].content[0].text, '好的');
  assert.strictEqual(resp.output[1].call_id, 'k1');
  assert.deepStrictEqual(resp.usage, { input_tokens: 3, output_tokens: 4, total_tokens: 7, input_tokens_details: { cached_tokens: 2 } });
});

test('chatJsonToResponses:畸形上游响应不抛,并给出可用的空壳', () => {
  for (const bad of [null, {}, { choices: [] }, { choices: [{}] }, { choices: [{ message: {} }] }]) {
    const r = wire.chatJsonToResponses(bad, 'm');
    assert.strictEqual(r.object, 'response', JSON.stringify(bad));
    assert.strictEqual(r.status, 'completed');
    assert.deepStrictEqual(r.output, [], JSON.stringify(bad) + ' 没有正文就不该凭空造一条 message');
    assert.ok(typeof r.id === 'string' && r.id.length > 0, '无 id 时要补一个可用的随机 id');
  }
  // 空串正文不算内容(否则会多出一条空 message)
  assert.deepStrictEqual(wire.chatJsonToResponses({ choices: [{ message: { content: '' } }] }, 'm').output, []);
});

// ---------------------------------------------------------------- SSE 收尾
test('emitResponsesSse:完整事件序列,且 Content-Type 由我们盖掉上游的', () => {
  const res = sink();
  wire.emitResponsesSse(res, {
    id: 'r1', model: 'm',
    output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi' }] }],
  }, { 'Content-Type': 'application/json', 'X-Up': '1' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['Content-Type'], 'text/event-stream', '上游的 application/json 必须被盖掉');
  assert.strictEqual(res.headers['X-Up'], '1', '上游其它头照旧透传');
  assert.strictEqual(res.ended, true);
  assert.deepStrictEqual(types(res.text), [
    'response.created', 'response.output_item.added', 'response.content_part.added',
    'response.output_text.delta', 'response.output_text.done', 'response.content_part.done',
    'response.output_item.done', 'response.completed',
  ]);
  const ev = events(res.text);
  assert.strictEqual(ev[1].item.status, 'in_progress');
  assert.strictEqual(ev[6].item.status, 'completed', 'item.done 要带终态');
  assert.strictEqual(ev[7].response.id, 'r1');
});

test('emitResponsesSse:空正文不发 delta,但 added/done 仍成对(顺序错了客户端会拒)', () => {
  const res = sink();
  wire.emitResponsesSse(res, { id: 'r', model: 'm', output: [{ type: 'message', id: 'i', content: [{ type: 'output_text', text: '' }] }] }, {});
  const t = types(res.text);
  assert.ok(!t.includes('response.output_text.delta'), '空正文不该发 delta');
  assert.ok(t.indexOf('response.output_item.added') < t.indexOf('response.content_part.added'));
  assert.ok(t.indexOf('response.content_part.added') < t.indexOf('response.output_item.done'));
  assert.strictEqual(t[t.length - 1], 'response.completed');
});

test('emitResponsesSse:没有 output / 非 message item / 多条 item 都不炸', () => {
  const a = sink(); wire.emitResponsesSse(a, { id: 'r', model: 'm' }, {});
  assert.deepStrictEqual(types(a.text), ['response.created', 'response.completed']);
  const b = sink(); wire.emitResponsesSse(b, { id: 'r', model: 'm', output: [] }, {});
  assert.deepStrictEqual(types(b.text), ['response.created', 'response.completed']);
  const c = sink();
  wire.emitResponsesSse(c, { id: 'r', model: 'm', output: [
    { type: 'function_call', id: 'fc_0', call_id: 'c0', name: 'f', arguments: '{}' },
    { type: 'message', id: 'i', content: [{ type: 'output_text', text: 'x' }] },
  ] }, {});
  assert.deepStrictEqual(events(c.text).filter(e => e.type === 'response.output_item.added').map(e => e.output_index), [0, 1]);
  // write 抛异常(客户端已断开)不能把整条收尾带崩
  const d = sink(); d.write = () => { throw new Error('boom'); };
  wire.emitResponsesSse(d, { id: 'r', model: 'm', output: [{ type: 'message', id: 'i', content: [{ type: 'output_text', text: 'x' }] }] }, {});
  assert.strictEqual(d.ended, true);
});

// ---------------------------------------------------------------- 流式响应方向
function runStream(chunks, { error = false } = {}) {
  return new Promise(resolve => {
    const up = new PassThrough();
    const res = sink();
    const usages = [];
    wire.streamChatAsResponses(up, res, 'm', u => usages.push(u), { 'Content-Type': 'application/json' });
    for (const c of chunks) up.write(c);
    if (error) up.emit('error', new Error('upstream died')); else up.end();
    setImmediate(() => setImmediate(() => resolve({ res, usages })));
  });
}
const F = c => `data: ${JSON.stringify(c)}\n\n`;

test('streamChatAsResponses:正文增量、首个 delta 前先发 added(否则 codex 报 no active item)', async () => {
  const { res } = await runStream([F({ choices: [{ delta: { content: '你' } }] }), F({ choices: [{ delta: { content: '好' } }] }), 'data: [DONE]\n\n']);
  assert.strictEqual(res.headers['Content-Type'], 'text/event-stream');
  const t = types(res.text);
  assert.ok(t.indexOf('response.output_item.added') < t.indexOf('response.output_text.delta'));
  assert.ok(t.indexOf('response.content_part.added') < t.indexOf('response.output_text.delta'));
  assert.deepStrictEqual(events(res.text).filter(e => e.type === 'response.output_text.delta').map(e => e.delta), ['你', '好']);
  const done = events(res.text).find(e => e.type === 'response.completed');
  assert.strictEqual(done.response.output[0].content[0].text, '你好');
  assert.strictEqual(res.ended, true);
});

test('streamChatAsResponses:收尾只发生一次,[DONE] 之后的事件不再写响应', async () => {
  const { res } = await runStream([F({ choices: [{ delta: { content: 'a' } }] }), 'data: [DONE]\n\n', F({ choices: [{ delta: { content: 'LATE' } }] })]);
  assert.strictEqual(types(res.text).filter(t => t === 'response.completed').length, 1);
  assert.ok(!res.text.includes('LATE'), '终态之后不许再写内容');
  // 上游 end 与 error 都调 finish,重复触发也只能收尾一次
  const up = new PassThrough(); const res2 = sink();
  wire.streamChatAsResponses(up, res2, 'm', () => {}, {});
  up.write(F({ choices: [{ delta: { content: 'a' } }] }));
  up.emit('error', new Error('x')); up.end();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(types(res2.text).filter(t => t === 'response.failed').length, 1);
});

test('streamChatAsResponses:上游断流也要收尾,不能把客户端挂住', async () => {
  const { res } = await runStream([F({ choices: [{ delta: { content: 'x' } }] })], { error: true });
  assert.strictEqual(res.ended, true);
  assert.strictEqual(types(res.text).filter(t => t === 'response.failed').length, 1);
  assert.strictEqual(types(res.text).filter(t => t === 'response.completed').length, 0);
});

test('streamChatAsResponses:usage 取最后一次并回报给调用方(统计靠它)', async () => {
  const { res, usages } = await runStream([
    F({ choices: [{ delta: { content: 'a' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    F({ choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11, prompt_tokens_details: { cached_tokens: 2 } } }),
    'data: [DONE]\n\n',
  ]);
  assert.deepStrictEqual(usages, [{ input_tokens: 5, output_tokens: 6, total_tokens: 11, input_tokens_details: { cached_tokens: 2 } }]);
  const done = events(res.text).find(e => e.type === 'response.completed');
  assert.deepStrictEqual(done.response.usage, usages[0], '终态里也要带同一份 usage');
});

test('streamChatAsResponses:工具调用按 index 分别攒参、整包下发,不与正文串块', async () => {
  const { res } = await runStream([
    F({ choices: [{ delta: { content: '想' } }] }),
    F({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'f', arguments: '{"a"' } }] } }] }),
    F({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] }),
    F({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'g', arguments: '{}' } }] } }] }),
    'data: [DONE]\n\n',
  ]);
  const out = events(res.text).find(e => e.type === 'response.completed').response.output;
  assert.deepStrictEqual(out.map(o => o.type), ['message', 'function_call', 'function_call']);
  assert.strictEqual(out[1].call_id, 'c0');
  assert.strictEqual(out[1].name, 'f');
  assert.strictEqual(out[1].arguments, '{"a":1}', '两个分片要攒成一个完整 JSON,不是后一片覆盖前一片');
  assert.strictEqual(out[2].name, 'g');
  assert.strictEqual(out[0].content[0].text, '想', '正文不受工具分片影响');
});

test('streamChatAsResponses:畸形/无关行一律跳过,不中断也不写坏事件', async () => {
  const { res } = await runStream([
    'event: ping\n\n',
    'data: {not json}\n\n',
    'data: {"id":"x"}\n\n',
    F({ choices: [{ delta: {} }] }),
    F({ choices: [{ delta: { content: 'ok' } }] }),
    'data: [DONE]\n\n',
  ]);
  const out = events(res.text).find(e => e.type === 'response.completed').response.output;
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].content[0].text, 'ok');
  assert.deepStrictEqual(types(res.text).filter(t => t === 'response.completed').length, 1);
  // 分片被切断的 JSON 要能跨 chunk 拼回来
  const { res: r2 } = await runStream(['data: {"choices":[{"delta":{"cont', 'ent":"z"}}]}\n\ndata: [DONE]\n\n']);
  assert.strictEqual(events(r2.text).find(e => e.type === 'response.completed').response.output[0].content[0].text, 'z');
});

test('streamChatAsResponses:一个字都没吐就 [DONE],收尾仍要给出合法的空 output', async () => {
  const { res, usages } = await runStream(['data: [DONE]\n\n']);
  assert.deepStrictEqual(types(res.text), ['response.created', 'response.completed']);
  assert.deepStrictEqual(events(res.text).find(e => e.type === 'response.completed').response.output, []);
  assert.deepStrictEqual(usages, [{ input_tokens: 0, output_tokens: 0, total_tokens: 0 }]);
  assert.strictEqual(res.ended, true);
});
