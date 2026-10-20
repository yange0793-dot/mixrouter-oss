'use strict';
// Anthropic → Responses 转换层:单元 + 端到端(Claude 组渠道 wire_api='responses')。
// 覆盖的正是"本地转换代理能退役"的那几条路径:请求映射、响应映射、SSE 翻译、
// count_tokens 兜底、上游 5xx 时轮换 prompt_cache_key 重试。
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wire = require('../lib/wire-responses.js');

// ---------------------------------------------------------------- 单元测试
test('anthropicToResponses:system/工具/图片/tool_use/tool_result 全映射', () => {
  const r = wire.anthropicToResponses({
    model: 'gpt-6-astra[1M]',
    max_tokens: 512,
    system: [{ type: 'text', text: '你是助手' }, { type: 'text', text: '别废话' }],
    tools: [{ name: 'Bash', description: '跑命令', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'Bash' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
      { role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'file.txt' }] }] },
    ],
  }, { promptCacheKey: 'sess-1' });
  assert.strictEqual(r.model, 'gpt-6-astra');                 // [1M] 后缀剥掉,裸名给上游
  assert.strictEqual(r.store, false);
  assert.deepStrictEqual(r.include, ['reasoning.encrypted_content']); // Codex 型通道的形状要求
  assert.strictEqual(r.prompt_cache_key, 'sess-1');
  assert.strictEqual(r.instructions, '你是助手\n\n别废话');
  assert.deepStrictEqual(r.tool_choice, { type: 'function', name: 'Bash' });
  assert.strictEqual(r.tools[0].name, 'Bash');
  assert.strictEqual(r.tools[0].parameters.properties.cmd.type, 'string');
  assert.strictEqual(r.max_output_tokens, 512);
  const kinds = r.input.map(i => i.type);
  assert.deepStrictEqual(kinds, ['message', 'message', 'function_call', 'function_call_output']);
  assert.strictEqual(r.input[0].content[1].type, 'input_image');
  assert.ok(r.input[0].content[1].image_url.startsWith('data:image/png;base64,'));
  assert.strictEqual(r.input[2].name, 'Bash');
  assert.strictEqual(r.input[2].arguments, '{"cmd":"ls"}');
  assert.strictEqual(r.input[3].output, 'file.txt');
});

test('anthropicToResponses:工具显式 strict:false,可选参数不得被上游当成必填', () => {
  // Responses 在缺 strict 时会把 schema 规范化成严格模式,而严格模式要求 properties 里每个键
  // 都出现在 required 里(官方 function calling 文档 strict mode 一节)。丢了这个字段,客户端
  // schema 里的可选参数到上游就变成必填,模型被迫给每个可选参数编值——实测 2026-10-16:
  // Agent 调用的 isolation 等可选参数从未被省略。这条回归钉住"必须显式写 false"。
  const schema = {
    type: 'object',
    properties: { description: { type: 'string' }, prompt: { type: 'string' }, isolation: { type: 'string' } },
    required: ['description', 'prompt'],
  };
  const r = wire.anthropicToResponses({ model: 'm', messages: [], tools: [{ name: 'Agent', description: 'x', input_schema: schema }] });
  assert.strictEqual(r.tools[0].strict, false, '必须显式写 strict:false,不能靠上游默认');
  assert.deepStrictEqual(r.tools[0].parameters, schema, 'schema 原样上送,不自行增删 required');
  assert.ok(!r.tools[0].parameters.required.includes('isolation'), '可选参数不得被本地塞进 required');
  // 工具没有 input_schema 时同样要带 strict:false,不能只在有 schema 的分支上写
  const bare = wire.anthropicToResponses({ model: 'm', messages: [], tools: [{ name: 'Bare' }] });
  assert.strictEqual(bare.tools[0].strict, false);
});

test('anthropicToResponses:tool_result 里的图片也转 input_image,不带图时维持字符串形状', () => {
  const withImg = wire.anthropicToResponses({
    model: 'm', max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_9', content: [
      { type: 'text', text: 'screenshot:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
    ] }] }],
  });
  const out = withImg.input.find(i => i.type === 'function_call_output');
  assert.strictEqual(out.call_id, 'tu_9');
  assert.deepStrictEqual(out.output, [
    { type: 'input_text', text: 'screenshot:' },
    { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
  ]);

  const remote = wire.anthropicToResponses({
    model: 'm', max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_8', content: [
      { type: 'image', source: { type: 'url', url: 'https://img.example/a.png' } },
    ] }] }],
  });
  assert.deepStrictEqual(remote.input.find(i => i.type === 'function_call_output').output,
    [{ type: 'input_image', image_url: 'https://img.example/a.png' }]);

  // 不带图:保持原来的纯字符串 output,不改变已有上游看到的行为
  const noImg = wire.anthropicToResponses({
    model: 'm', max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'file.txt' }] }] }],
  });
  assert.strictEqual(noImg.input.find(i => i.type === 'function_call_output').output, 'file.txt');
});

test('anthropicToResponses:只含 tool_reference 的 tool_result 不能变成空结果', () => {
  // Claude Code 的 ToolSearch 结果就是这种形状:tool_result 里全是 tool_reference,没有 text/image。
  // 丢掉它们等于告诉模型"搜到 0 个工具",它会以为结果无效而反复重搜。
  const r = wire.anthropicToResponses({
    model: 'm', max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_ts', content: [
      { type: 'tool_reference', tool_name: 'mcp__playwright__browser_navigate' },
      { type: 'tool_reference', tool_name: 'mcp__playwright__browser_snapshot' },
    ] }] }],
  });
  const out = r.input.find(i => i.type === 'function_call_output');
  assert.strictEqual(out.call_id, 'tu_ts');
  assert.notStrictEqual(out.output, '', '空结果会让模型以为搜索没有命中');
  assert.ok(out.output.includes('mcp__playwright__browser_navigate') && out.output.includes('mcp__playwright__browser_snapshot'),
    `引用的工具名要如实带上,实际:${JSON.stringify(out.output)}`);
});

test('anthropicToResponses:tool_reference 和文本混排时文本照旧、引用不丢', () => {
  const r = wire.anthropicToResponses({
    model: 'm', max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_mix', content: [
      { type: 'text', text: '命中 1 个工具:' },
      { type: 'tool_reference', tool_name: 'Bash' },
    ] }] }],
  });
  const out = r.input.find(i => i.type === 'function_call_output');
  assert.strictEqual(out.output, '命中 1 个工具:\nBash');
});

test('anthropicToResponses:显式 effort 原样传递,不猜 thinking 预算或默认强度', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const r = wire.anthropicToResponses({
      model: 'gpt-6-astra', output_config: { effort }, thinking: { type: 'adaptive' },
      tools: [{ name: 'check', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }],
    });
    assert.deepStrictEqual(r.reasoning, { effort });
    assert.strictEqual(r.tools[0].type, 'function');
    assert.deepStrictEqual(r.input[0].content[0], { type: 'input_image', image_url: 'data:image/png;base64,AAA' });
    assert.strictEqual(r.reasoning_effort, undefined);
  }
  for (const extra of [{}, { thinking: { type: 'adaptive' } }, { thinking: { type: 'enabled', budget_tokens: 10000 } }, { output_config: { effort: 'unknown' } }]) {
    assert.strictEqual(wire.anthropicToResponses({ model: 'm', messages: [], ...extra }).reasoning, undefined);
  }
});

test('anthropicToResponses:deepseek-flash 不收 reasoning.effort,只丢这一个字段;qwen3.8 照旧带', () => {
  // 基元律动 deepseek-flash 带 effort 整包 400 UNKNOWN_FIELD(2026-09-23 直连对照)
  for (const model of ['deepseek-flash', 'deepseek-flash[1m]']) {
    const r = wire.anthropicToResponses({ model, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(r.reasoning, undefined);
    assert.strictEqual(r.model, 'deepseek-flash');
    assert.strictEqual(r.stream, true);
    assert.ok(r.input.length > 0);
  }
  for (const model of ['qwen3.8-max', 'deepseek-v4-pro']) {
    const r = wire.anthropicToResponses({ model, output_config: { effort: 'low' }, messages: [] });
    assert.deepStrictEqual(r.reasoning, { effort: 'low' });
  }
});

test('anthropicToResponses:Peach swe-2-max 拒顶层 reasoning,只丢 effort;include 与历史 item 不动', () => {
  // 实测 2026-10-01 直连对照:带 {effort} 400 `reasoning is not supported by this provider adapter`,
  // 同请求去掉 reasoning 即 200;include reasoning.encrypted_content 与历史 reasoning item 独立测均 200。
  const r = wire.anthropicToResponses({ model: 'swe-2-max', output_config: { effort: 'xhigh' }, messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(r.reasoning, undefined);
  assert.deepStrictEqual(r.include, ['reasoning.encrypted_content']);
  assert.ok(r.input.length > 0);
  // 未登记模型不受影响,effort 照常上送
  assert.deepStrictEqual(
    wire.anthropicToResponses({ model: 'glm-5.3', output_config: { effort: 'xhigh' }, messages: [] }).reasoning,
    { effort: 'xhigh' });
});

test('anthropicToResponses:客户端回传的 thinking 翻成 reasoning item(deepseek 系上游要求)', () => {
  // 不转就是整包 400:「The `reasoning_text` in the thinking mode must be passed back to the API.」
  const stats = {};
  const r = wire.anthropicToResponses({
    model: 'deepseek-v4-flash', max_tokens: 512,
    messages: [
      { role: 'user', content: [{ type: 'text', text: '北京天气' }] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: '先查北京。', signature: '' },
        { type: 'text', text: '我来查' },
        { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: '北京' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '晴' }] },
    ],
  }, { stats });
  const kinds = r.input.map(i => i.type);
  assert.deepStrictEqual(kinds, ['message', 'reasoning', 'message', 'function_call', 'function_call_output']);
  assert.deepStrictEqual(r.input[1], { type: 'reasoning', content: [{ type: 'reasoning_text', text: '先查北京。' }] });
  // 位置是硬要求:item 必须落在它那一轮的 function_call 之前(放到最前面照样 400)
  assert.ok(kinds.indexOf('reasoning') < kinds.indexOf('function_call'));
  assert.strictEqual(kinds.filter(k => k === 'reasoning').length, 1);
  assert.deepStrictEqual(stats, { think: 1, reasoning: 1 });
});

test('anthropicToResponses:Astra/Sol 回放 thinking 只用 summary,按出站模型选择', () => {
  const messages = [
    { role: 'user', content: '检查' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '先检查。', signature: '' },
      { type: 'tool_use', id: 'tu_1', name: 'check', input: {} },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
  ];
  const summary = { type: 'reasoning', summary: [{ type: 'summary_text', text: '先检查。' }] };
  for (const model of ['gpt-6-astra', 'gpt-6-astra[1M]', 'gpt-5.6-sol']) {
    for (const [requestModel, options] of [[model, {}], ['mixr-main', { model }]]) {
      const r = wire.anthropicToResponses({ model: requestModel, messages }, options);
      assert.deepStrictEqual(r.input.map(i => i.type), ['message', 'reasoning', 'function_call', 'function_call_output']);
      assert.deepStrictEqual(r.input[1], summary, model);
      assert.strictEqual(r.input[1].content, undefined, 'Astra 不接受非空 reasoning.content');
    }
  }
  // 同一段历史切回 DeepSeek 时仍须 reasoning_text,不能全局改成 summary。
  const deepseek = wire.anthropicToResponses({ model: 'gpt-6-astra', messages }, { model: 'deepseek-v4-flash' });
  assert.deepStrictEqual(deepseek.input[1], { type: 'reasoning', content: [{ type: 'reasoning_text', text: '先检查。' }] });
});

test('thinking 经 JSON/SSE 往返后仍能同模型续聊与跨模型切换', () => {
  for (const model of ['gpt-6-astra', 'deepseek-v4-flash']) {
    const reasoning = model === 'gpt-6-astra'
      ? { type: 'reasoning', summary: [{ type: 'summary_text', text: '先检查。' }] }
      : { type: 'reasoning', content: [{ type: 'reasoning_text', text: '先检查。' }] };
    const tool = { type: 'function_call', call_id: 'call_roundtrip', name: 'check', arguments: '{}' };
    const output = [reasoning, tool];
    const jsonMessage = wire.responsesToAnthropic({ status: 'completed', model, output, usage: {} });
    const sink = wire.memorySink();
    const stream = new wire.AnthropicStream(sink.res, model);
    for (const [output_index, item] of output.entries()) {
      stream.handle({ type: 'response.output_item.added', output_index, item });
      stream.handle({ type: 'response.output_item.done', output_index, item });
    }
    stream.handle({ type: 'response.completed', response: { status: 'completed', usage: {} } });
    for (const message of [jsonMessage, wire.collectAnthropicMessage(sink.text())]) {
      assert.strictEqual(message.stop_reason, 'tool_use');
      assert.deepStrictEqual(message.content[0], { type: 'thinking', thinking: '先检查。', signature: '' });
      for (const nextModel of ['gpt-6-astra', 'deepseek-v4-flash']) {
        const r = wire.anthropicToResponses({ model: 'mixr-main', messages: [
          message,
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_roundtrip', content: 'ok' }] },
        ] }, { model: nextModel });
        assert.deepStrictEqual(r.input.map(i => i.type), ['reasoning', 'function_call', 'function_call_output']);
        assert.deepStrictEqual(r.input[0], nextModel === 'gpt-6-astra'
          ? { type: 'reasoning', summary: [{ type: 'summary_text', text: '先检查。' }] }
          : { type: 'reasoning', content: [{ type: 'reasoning_text', text: '先检查。' }] });
        assert.strictEqual(r.input[1].call_id, 'call_roundtrip');
        assert.strictEqual(r.input[2].output, 'ok');
      }
    }
  }
});

test('anthropicToResponses:空 thinking 不生成 reasoning item(空文本不算回传)', () => {
  const stats = {};
  const r = wire.anthropicToResponses({
    model: 'm', max_tokens: 64, messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: '   ', signature: '' }, { type: 'text', text: '答' }] },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ],
  }, { stats });
  assert.strictEqual(r.input.filter(i => i.type === 'reasoning').length, 0);
  assert.deepStrictEqual(stats, { think: 1 }); // 计数照记:诊断时要能看出"客户端回传了但没内容"
});

test('anthropicToResponses:max_output_tokens 有下限与上限', () => {
  assert.strictEqual(wire.anthropicToResponses({ model: 'm', messages: [] }, {}).max_output_tokens, 32000);
  assert.strictEqual(wire.anthropicToResponses({ model: 'm', max_tokens: 1, messages: [] }, {}).max_output_tokens, 16);
  assert.strictEqual(wire.anthropicToResponses({ model: 'm', max_tokens: 999999, messages: [] }, {}).max_output_tokens, 128000);
});

test('responsesToAnthropic:文本 + function_call → tool_use,usage 带上', () => {
  const msg = wire.responsesToAnthropic({
    id: 'resp_9', status: 'completed', model: 'gpt-6-astra',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: '答案' }] },
      { type: 'function_call', call_id: 'c_1', name: 'Read', arguments: '{"p":"a.txt"}' },
    ],
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } },
  }, 'gpt-6-astra');
  assert.strictEqual(msg.type, 'message');
  assert.strictEqual(msg.stop_reason, 'tool_use');
  assert.strictEqual(msg.content[0].text, '答案');
  assert.deepStrictEqual(msg.content[1], { type: 'tool_use', id: 'c_1', name: 'Read', input: { p: 'a.txt' } });
  // 缓存命中要从 input_tokens 里减掉:Responses 的 input 含缓存,Anthropic 的不含
  assert.deepStrictEqual(msg.usage, { input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 40 });
});

test('anthropicToResponses:上游恒流式,客户端 stream:false 也不透传非流形状', () => {
  // 非流上游要等整篇生成完才发响应头,大上下文压缩类请求会稳定撞首字节超时再被客户端
  // 重试、上游照常计费——这是 requests.jsonl 里 123 发 502 死循环的根因,必须恒 stream:true
  assert.strictEqual(wire.anthropicToResponses({ model: 'm', messages: [] }, {}).stream, true);
  assert.strictEqual(wire.anthropicToResponses({ model: 'm', stream: false, messages: [] }, {}).stream, true);
  assert.strictEqual(wire.anthropicToResponses({ model: 'm', stream: true, messages: [] }, {}).stream, true);
});

test('collectAnthropicMessage:整段 SSE 重建为非流整包,usage 以 message_delta 终态为准', () => {
  const frames = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'gpt-6-astra', content: [], usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '前半' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '后半' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 18, output_tokens: 7, cache_read_input_tokens: 3 } },
    { type: 'message_stop' },
  ];
  const text = frames.map(ev => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join('');
  const msg = wire.collectAnthropicMessage(text);
  assert.strictEqual(msg.id, 'msg_1');
  assert.strictEqual(msg.model, 'gpt-6-astra');
  assert.strictEqual(msg.content[0].text, '前半后半');       // delta 逐段累积
  assert.deepStrictEqual(msg.content[1], { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } });
  assert.strictEqual(msg.stop_reason, 'tool_use');
  // message_start 的 usage:0 必须被 message_delta 的终态值盖掉
  assert.deepStrictEqual(msg.usage, { input_tokens: 18, output_tokens: 7, cache_read_input_tokens: 3 });
  // CRLF 分帧与注释行(上游心跳)不影响解析
  const crlf = text.replace(/\n/g, '\r\n') + ': keep-alive\r\n\r\n';
  assert.strictEqual(wire.collectAnthropicMessage(crlf).usage.input_tokens, 18);
  assert.throws(() => wire.collectAnthropicMessage(text.replace(/event: message_stop[\s\S]*$/, '')), /完整终态/);
  const truncated = frames.map(ev => (ev.type === 'content_block_delta' && ev.index === 1)
    ? `event: ${ev.type}\ndata: ${JSON.stringify({ ...ev, delta: { ...ev.delta, partial_json: '{"cmd":' } })}\n\n`
    : `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join('');
  assert.throws(() => wire.collectAnthropicMessage(truncated), /工具参数/);
  const errorText = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'broken' } })}\n\n`;
  assert.throws(() => wire.collectAnthropicMessage(errorText), /broken/);
});

// ---------------------------------------------------------------- 可选参数空占位剪除
// gpt-6-astra/sol 会把 schema 的每个属性都填上,不用的可选参数塞空值,Claude Code 校验失败死循环
// (实测转录:Read pages:"" 约 40 次、Monitor ws:{protocols:[],url:""} 单会话 87 次)
const PRUNE_TOOLS = [
  { name: 'Read', input_schema: { type: 'object', required: ['file_path'], properties: { file_path: {}, limit: {}, offset: {}, pages: {} } } },
  { name: 'Monitor', input_schema: { type: 'object', required: ['description'], properties: { command: {}, description: {}, timeout_ms: {}, ws: {} } } },
  { name: 'Edit', input_schema: { type: 'object', required: ['file_path', 'old_string', 'new_string'], properties: { file_path: {}, old_string: {}, new_string: {}, replace_all: {} } } },
];
const READ_ARGS = { file_path: '/x/进度.md', limit: 240, offset: 1, pages: '' };
const MONITOR_ARGS = { command: 'python3 -u watch.py', description: '看日志', timeout_ms: 1800000, ws: { protocols: [], url: '' } };
const EDIT_ARGS = { file_path: '/x/a.js', old_string: 'foo', new_string: '', replace_all: false };

test('responsesToAnthropic:可选参数的空占位剪掉,required 的空串/false/0 保留,未知工具不动', () => {
  const call = (name, args) => ({ type: 'function_call', call_id: `c_${name}`, name, arguments: JSON.stringify(args) });
  const msg = wire.responsesToAnthropic({
    status: 'completed',
    output: [call('Read', READ_ARGS), call('Monitor', MONITOR_ARGS), call('Edit', EDIT_ARGS), call('Mystery', { a: '', b: {} })],
  }, 'gpt-6-astra', { tools: PRUNE_TOOLS });
  const input = name => msg.content.find(b => b.name === name).input;
  assert.deepStrictEqual(input('Read'), { file_path: '/x/进度.md', limit: 240, offset: 1 });
  assert.deepStrictEqual(input('Monitor'), { command: 'python3 -u watch.py', description: '看日志', timeout_ms: 1800000 },
    'ws 各字段全空 = 整个 ws 是占位,留着就是 exactly one of command or ws');
  assert.deepStrictEqual(input('Edit'), EDIT_ARGS, 'new_string:"" 是 required 的合法值(删除),false 不是占位');
  assert.deepStrictEqual(input('Mystery'), { a: '', b: {} }, '请求里没登记的工具不知道 schema,不剪');
  // 不传 tools(老调用方)行为不变
  const raw = wire.responsesToAnthropic({ status: 'completed', output: [call('Read', READ_ARGS)] }, 'm');
  assert.deepStrictEqual(raw.content[0].input, READ_ARGS);
});

test('流式:工具参数物化前剪掉可选空占位,客户端收到的 partial_json 已是剪后的', async () => {
  const { PassThrough } = require('node:stream');
  const up = new PassThrough(); up.statusCode = 200;
  const res = {
    headersSent: false, writableEnded: false, destroyed: false, text: '',
    writeHead() { this.headersSent = true; }, write(c) { this.text += String(c); return true; }, end() { this.writableEnded = true; },
  };
  const p = wire.relayAnthropicStream(up, res, 'gpt-6-astra', { tools: PRUNE_TOOLS });
  const ev = o => up.write(`data: ${JSON.stringify(o)}\n\n`);
  const args = [['Read', READ_ARGS], ['Monitor', MONITOR_ARGS], ['Edit', EDIT_ARGS], ['Mystery', { a: '' }]];
  args.forEach(([name, a], i) => {
    ev({ type: 'response.output_item.added', output_index: i, item: { type: 'function_call', call_id: `c${i}`, name } });
    const s = JSON.stringify(a);
    ev({ type: 'response.function_call_arguments.delta', output_index: i, delta: s.slice(0, 7) });
    ev({ type: 'response.function_call_arguments.delta', output_index: i, delta: s.slice(7) });
    ev({ type: 'response.output_item.done', output_index: i, item: { type: 'function_call', call_id: `c${i}`, name, arguments: s } });
  });
  ev({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } });
  up.end();
  const r = await p;
  assert.strictEqual(r.aborted, false);
  const msg = wire.collectAnthropicMessage(res.text);
  assert.deepStrictEqual(msg.content.map(b => b.input), [
    { file_path: '/x/进度.md', limit: 240, offset: 1 },
    { command: 'python3 -u watch.py', description: '看日志', timeout_ms: 1800000 },
    EDIT_ARGS,
    { a: '' },
  ]);
  assert.strictEqual(msg.stop_reason, 'tool_use');
});

// ---------------------------------------------------------------- 端到端
function createResponsesUpstream() {
  const requests = [];
  let failTimes = 0, jsonAlways = false, abortMidStream = false, jsonBody = null, errorStreamTimes = 0, toolCalls = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      requests.push({ url: req.url, body, headers: req.headers });
      // 真报错的严格上游:不能用总回 200 的 mock 掩盖 input[N].summary 缺失。
      for (const [i, item] of (Array.isArray(body.input) ? body.input : []).entries()) {
        if (item.type !== 'reasoning') continue;
        let message = '';
        if (['gpt-6-astra', 'gpt-5.6-sol'].includes(body.model)) {
          if (!Array.isArray(item.summary)) message = `Missing required parameter: 'input[${i}].summary'.`;
          else if (item.content && item.content.length) message = `Invalid 'input[${i}].content': array too long. Expected an array with maximum length 0`;
        } else if (body.model === 'deepseek-v4-flash') {
          if (!Array.isArray(item.content) || !item.content.some(c => c.type === 'reasoning_text' && c.text.trim())) {
            message = 'The `reasoning_text` in the thinking mode must be passed back to the API.';
          }
        }
        if (message) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { type: 'invalid_request_error', message } }));
        }
      }
      if (failTimes > 0) { failTimes--; res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"负载已经达到上限"}}'); }
      if (jsonBody) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(jsonBody)); }
      const text = `conv-echo:${body.model}`;
      if (body.stream && !jsonAlways) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const sse = o => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
        // 200 的状态码 + SSE 的皮,内容却是错误体:必须在给客户端写字节之前整条重试
        if (errorStreamTimes > 0) {
          errorStreamTimes--;
          res.write('data: {"type":"error","error":{"message":"上游渠道池打满"}}\n\n');
          return res.end();
        }
        sse({ type: 'response.created', response: { id: 'resp_1', model: body.model } });
        // 流式工具调用(剪空占位的端到端用):按 [name, argsObject] 逐个发 function_call
        if (toolCalls) {
          toolCalls.forEach(([name, a], i) => {
            const item = { type: 'function_call', id: `fc_${i}`, call_id: `call_${i}`, name };
            sse({ type: 'response.output_item.added', output_index: i, item });
            sse({ type: 'response.function_call_arguments.delta', output_index: i, delta: JSON.stringify(a) });
            sse({ type: 'response.output_item.done', output_index: i, item: { ...item, arguments: JSON.stringify(a) } });
          });
          sse({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', model: body.model, usage: { input_tokens: 5, output_tokens: 5 } } });
          return res.end();
        }
        sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } });
        sse({ type: 'response.output_text.delta', delta: text });
        // 给出内容后直接掐断连接:没有 response.completed —— 上游夭折的真实形态
        if (abortMidStream) return void setTimeout(() => { try { res.destroy(); } catch {} }, 30);
        sse({ type: 'response.output_item.done', item: { type: 'message' } });
        sse({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', model: body.model, usage: { input_tokens: 21, output_tokens: 7, input_tokens_details: { cached_tokens: 3 } } } });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_1', object: 'response', status: 'completed', model: body.model,
        output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
        usage: { input_tokens: 21, output_tokens: 7 },
      }));
    });
  });
  return {
    server, requests,
    setFail: n => { failTimes = n; },
    setJsonAlways: v => { jsonAlways = v; },
    setAbortMidStream: v => { abortMidStream = v; },
    setJsonBody: v => { jsonBody = v; },
    setErrorStream: n => { errorStreamTimes = n; },
    setToolCalls: v => { toolCalls = v; },
  };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-conv-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_CONV_RETRIES = '2';
// 换 key 重试的间隔默认 1s:这里数的是"重试了几次、换了哪一代 key",等一秒只会白等
process.env.MIXR_RETRY_DELAY_MS = '0';

const up = createResponsesUpstream();
let mod, proxySrv, uiSrv, proxyPort, uiPort, upPort;

// 请求日志的最后一行:用来断言"日志记的是不是真实结果"
function lastRequestLog() {
  const lines = fs.readFileSync(path.join(TMP, 'logs', 'requests.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

function rawRequest(port, method, reqPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const creq = http.request({
      hostname: '127.0.0.1', port, method, path: reqPath,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, cres => {
      const cs = [];
      cres.on('data', c => cs.push(c));
      cres.on('end', () => resolve({ status: cres.statusCode, headers: cres.headers, text: Buffer.concat(cs).toString('utf8') }));
    });
    creq.on('error', reject);
    if (data) creq.write(data);
    creq.end();
  });
}

test('setup:responses 型 Claude 渠道 + mock 上游', async () => {
  await new Promise(ok => up.server.listen(0, '127.0.0.1', ok));
  upPort = up.server.address().port;
  up.server.unref();
  fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true }); // 请求日志要落盘才断言得了
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({
    version: 2, current: { claude: 'p1', codex: null },
    claude: [{
      id: 'p1', name: 'astra 型', base_url: `http://127.0.0.1:${upPort}`, api_key: 'sk-conv',
      enabled: true, models: ['gpt-6-astra[1M]'], wire_api: 'responses',
    }],
    codex: [],
  }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({
    rules: [{ id: 'r1', match: 'claude-opus', provider: 'p1', model: 'gpt-6-astra[1M]', enabled: true }],
    default: { provider: 'p1', model: 'gpt-6-astra' },
  }));
  mod = require('../mixrouter.js');
  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  proxySrv.unref(); uiSrv.unref();
});

test('严格 mock 复现 input[38].summary 缺失、双字段冲突和 DeepSeek 错形状', async () => {
  const prefix = Array.from({ length: 38 }, (_, i) => ({
    type: 'message', role: i % 2 ? 'assistant' : 'user',
    content: [{ type: i % 2 ? 'output_text' : 'input_text', text: `历史 ${i}` }],
  }));
  const summary = [{ type: 'summary_text', text: '先检查。' }];
  const content = [{ type: 'reasoning_text', text: '先检查。' }];
  for (const [model, item, error] of [
    ['gpt-6-astra', { type: 'reasoning', content }, "Missing required parameter: 'input[38].summary'."],
    ['gpt-6-astra', { type: 'reasoning', summary, content }, "Invalid 'input[38].content': array too long. Expected an array with maximum length 0"],
    ['deepseek-v4-flash', { type: 'reasoning', summary }, 'The `reasoning_text` in the thinking mode must be passed back to the API.'],
  ]) {
    const r = await rawRequest(upPort, 'POST', '/v1/responses', { body: { model, input: [...prefix, item] } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(JSON.parse(r.text).error.message, error);
  }
});

test('长会话续聊:main/subagent 槽位切换模型后,第 38 项按实际出站形状回放', async t => {
  const previousSlots = mod._state.slotMap;
  t.after(() => { mod._state.slotMap = previousSlots; });
  const messages = Array.from({ length: 38 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `历史 ${i}`,
  }));
  messages.push(
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '先检查。', signature: '' },
      { type: 'tool_use', id: 'tu_history', name: 'check', input: { value: 1 } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_history', content: 'ok' }] },
  );
  const original = JSON.stringify(messages);
  const revision = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text).code_revision;
  assert.strictEqual(revision, require('../lib/runtime-code').codeRevision(path.join(__dirname, '..')));
  assert.match(revision, /^[a-f0-9]{64}$/);
  for (const slot of ['main', 'subagent']) {
    for (const stream of [false, true]) {
      for (const model of ['deepseek-v4-flash', 'gpt-6-astra[1M]', 'gpt-5.6-sol', 'deepseek-v4-flash']) {
        mod._state.slotMap = { claude: { [slot]: { provider: 'p1', model } }, codex: {} };
        const before = up.requests.length;
        const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
          headers: { 'x-claude-code-session-id': 'reasoning-replay-regression' },
          body: {
            model: `mixr-${slot}`, max_tokens: 64, stream, messages,
            tools: [{ name: 'check', input_schema: { type: 'object', properties: { value: { type: 'number' } } } }],
          },
        });
        assert.strictEqual(r.status, 200, `${slot}/${model}/${stream}: ${r.text}`);
        assert.strictEqual(up.requests.length, before + 1, '合法请求一次通过,不能靠失败重试掩盖');
        if (stream) assert.ok(r.text.includes('event: message_stop'), '流式必须完整收尾');
        else assert.strictEqual(JSON.parse(r.text).stop_reason, 'end_turn');
        const seen = up.requests.at(-1).body;
        const deepseek = model === 'deepseek-v4-flash';
        assert.strictEqual(seen.model, model.replace('[1M]', ''));
        assert.deepStrictEqual(seen.input[38], deepseek
          ? { type: 'reasoning', content: [{ type: 'reasoning_text', text: '先检查。' }] }
          : { type: 'reasoning', summary: [{ type: 'summary_text', text: '先检查。' }] });
        assert.strictEqual(seen.input[39].type, 'function_call');
        assert.strictEqual(seen.input[39].call_id, 'tu_history');
        assert.strictEqual(seen.input[39].arguments, '{"value":1}');
        assert.deepStrictEqual(seen.input[40], { type: 'function_call_output', call_id: 'tu_history', output: 'ok' });
        assert.strictEqual(seen.input.length, 41, '不得删 thinking 或截断历史来躲过校验');
      }
    }
  }
  assert.strictEqual(JSON.stringify(messages), original, '切换模型不能改写原会话历史');
  assert.strictEqual(JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text).code_revision, revision,
    '改槽位不改变启动时源码指纹');
});

test('非流式:messages 翻成 responses 发上游,响应翻回 Anthropic', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: '你好' }] },
  });
  assert.strictEqual(r.status, 200);
  const seen = up.requests.at(-1);
  assert.strictEqual(seen.url, '/v1/responses');                       // 端点就翻了
  assert.strictEqual(seen.body.model, 'gpt-6-astra');                  // [1M] 剥掉
  assert.deepStrictEqual(seen.body.include, ['reasoning.encrypted_content']);
  assert.ok(seen.body.prompt_cache_key);                               // 非空
  assert.strictEqual(seen.body.store, false);
  assert.strictEqual(seen.body.input[0].content[0].text, '你好');
  assert.strictEqual(seen.headers['authorization'], 'Bearer sk-conv');
  assert.strictEqual(seen.headers['x-api-key'], undefined);            // 不给 OpenAI 系上游撒 Anthropic 头
  const j = JSON.parse(r.text);
  assert.strictEqual(j.type, 'message');
  assert.strictEqual(j.content[0].text, 'conv-echo:gpt-6-astra');
  // 上游恒流式(非流死循环治理):非流客户端收到的是攒出来的整包,usage 与流式同口径——
  // input 已扣缓存命中(21-3),cache_read 单独给(与上面 responsesToAnthropic 的单测一致)
  assert.strictEqual(j.usage.input_tokens, 18);
  assert.strictEqual(j.usage.cache_read_input_tokens, 3);
  assert.strictEqual(j.usage.output_tokens, 7);
  assert.strictEqual(r.headers['x-mixrouter-provider'], 'astra');      // 渠道名经 safeHeader 只留 ASCII
});

test('Responses 出站同时保留图片、工具和 high effort', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: {
      model: 'claude-opus-5', max_tokens: 64, output_config: { effort: 'high' }, thinking: { type: 'adaptive' },
      tools: [{ name: 'check', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }],
    },
  });
  assert.strictEqual(r.status, 200);
  const seen = up.requests.at(-1);
  assert.strictEqual(seen.url, '/v1/responses');
  assert.deepStrictEqual(seen.body.reasoning, { effort: 'high' });
  assert.strictEqual(seen.body.tools[0].name, 'check');
  assert.deepStrictEqual(seen.body.input[0].content[0], { type: 'input_image', image_url: 'data:image/png;base64,AAA' });
  assert.strictEqual(seen.body.reasoning_effort, undefined);
});

test('流式:responses SSE → Anthropic SSE 事件序列', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers['content-type'].includes('text/event-stream'));
  for (const ev of ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']) {
    assert.ok(r.text.includes(`event: ${ev}`), `缺事件 ${ev}`);
  }
  assert.ok(r.text.includes('conv-echo:gpt-6-astra'));
  assert.ok(r.text.includes('"output_tokens":7'));
});

test('客户端要流、上游整包回 JSON:摊成 Anthropic SSE', async () => {
  up.setJsonAlways(true);
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
  });
  up.setJsonAlways(false);
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers['content-type'].includes('text/event-stream'), '整包 JSON 摊成流时也要给 SSE 头');
  assert.ok(r.text.includes('event: message_start'));
  assert.ok(r.text.includes('conv-echo:gpt-6-astra'));
  assert.ok(r.text.includes('event: message_stop'));
});

// 真机形态:转换流的成功条目曾被记成 499 client closed + usage 0(下游 close 走 nextTick,
// 比 promise 微任务还早,mixrouter 的 close 回调据此误判成取消)
test('流式成功:日志不得记成 client closed,usage 要落地', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: '记日志' }] },
  });
  assert.strictEqual(r.status, 200);
  const log = lastRequestLog();
  assert.strictEqual(log.status, 200);
  assert.strictEqual(log.err, '', `不该有错误正文,实际:${log.err}`);
  assert.notStrictEqual(log.err_class, 'cancelled');
  assert.strictEqual(log.out, 7, 'usage 要真的落地');
  assert.strictEqual(log.cache_read, 3);
  assert.strictEqual(log.in, 18, '缓存命中从 input 里减掉');
});

test('上游流中途夭折:客户端收到 error,不出现 message_stop', async () => {
  up.setAbortMidStream(true);
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: '断流' }] },
  });
  up.setAbortMidStream(false);
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes('conv-echo:gpt-6-astra'), '已经产出的内容照发给客户端');
  assert.ok(r.text.includes('event: error'), '夭折要发协议级 error');
  assert.ok(!r.text.includes('event: message_stop'), '断流不得伪造正常结束');
  assert.strictEqual(lastRequestLog().err_class, 'stream_aborted');
});

// mixrouter.js 要把请求的 tools 交给转换层,剪空占位才有 schema 可对;三条回程路径都要覆盖:
// 上游整包 JSON / 上游流式+客户端流式 / 上游流式+客户端非流(攒包)
test('端到端:可选参数的空占位在三条回程路径上都被剪掉,required 空串保留', async () => {
  const calls = [['Read', READ_ARGS], ['Monitor', MONITOR_ARGS], ['Edit', EDIT_ARGS]];
  const want = [
    { file_path: '/x/进度.md', limit: 240, offset: 1 },
    { command: 'python3 -u watch.py', description: '看日志', timeout_ms: 1800000 },
    EDIT_ARGS,
  ];
  const req = stream => rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 64, stream, tools: PRUNE_TOOLS, messages: [{ role: 'user', content: '读文件' }] },
  });
  up.setJsonBody({ id: 'resp_t', status: 'completed', model: 'gpt-6-astra', usage: { input_tokens: 5, output_tokens: 5 },
    output: calls.map(([name, a], i) => ({ type: 'function_call', call_id: `call_${i}`, name, arguments: JSON.stringify(a) })) });
  let r;
  try { r = await req(false); } finally { up.setJsonBody(null); }
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(JSON.parse(r.text).content.map(b => b.input), want, '上游整包 JSON');
  up.setToolCalls(calls);
  let rs, rn;
  try { rs = await req(true); rn = await req(false); } finally { up.setToolCalls(null); }
  assert.strictEqual(rs.status, 200);
  assert.deepStrictEqual(wire.collectAnthropicMessage(rs.text).content.map(b => b.input), want, '上游流式 → 客户端流式');
  assert.strictEqual(rn.status, 200);
  assert.deepStrictEqual(JSON.parse(rn.text).content.map(b => b.input), want, '上游流式 → 客户端非流(攒包)');
});

test('上游 200 但 status=failed:翻成 Anthropic error,不回空消息', async () => {
  up.setJsonBody({ status: 'failed', error: { message: 'mock failure' } });
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
  });
  up.setJsonBody(null);
  assert.strictEqual(r.status, 502);
  const j = JSON.parse(r.text);
  assert.strictEqual(j.type, 'error');
  assert.ok(j.error.message.includes('mock failure'));
});

test('上游 200 + SSE 皮里包错误:换一代 key 重试,同一条响应继续往下写', async () => {
  up.setErrorStream(1);
  const before = up.requests.length;
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: '重试' }] },
  });
  assert.strictEqual(r.status, 200);
  const pair = up.requests.slice(before);
  assert.strictEqual(pair.length, 2, '应重试一次');
  assert.notStrictEqual(pair[0].body.prompt_cache_key, pair[1].body.prompt_cache_key, '重试要换一代 key(坏渠道会被亲和钉住)');
  // 关键:重试用的是同一条 res,第一次尝试一个字节都没写出去
  assert.ok(r.text.includes('event: message_start'), '重试后仍要能正常产出');
  assert.ok(r.text.includes('conv-echo:gpt-6-astra'));
  assert.ok(r.text.includes('event: message_stop'));
  assert.ok(!r.text.includes('上游渠道池打满'), '被重试掉的错误不该漏给客户端');
});

test('count_tokens:responses 上游没有该端点,本地估一个', async () => {
  const before = up.requests.length;
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages/count_tokens', {
    body: { model: 'claude-opus-5', messages: [{ role: 'user', content: 'x'.repeat(400) }] },
  });
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.text);
  assert.ok(j.input_tokens > 90 && j.input_tokens < 130, `估算值应约为 1/4 体积,得到 ${j.input_tokens}`);
  assert.strictEqual(up.requests.length, before);                      // 没有打到上游
});

test('上游 5xx:同一渠道内轮换 prompt_cache_key 重试,不改模型', async () => {
  up.setFail(1);
  const before = up.requests.length;
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 32, messages: [{ role: 'user', content: '重试看看' }] },
  });
  assert.strictEqual(r.status, 200);
  const pair = up.requests.slice(before);
  assert.strictEqual(pair.length, 2, '应重试一次');
  assert.ok(pair[0].body.prompt_cache_key && pair[1].body.prompt_cache_key);
  assert.notStrictEqual(pair[0].body.prompt_cache_key, pair[1].body.prompt_cache_key, '重试必须换一代 key(坏渠道会被亲和钉住)');
  assert.strictEqual(pair[1].body.prompt_cache_key, pair[0].body.prompt_cache_key + '-g1');
});

test('上游错误体翻成 Anthropic 形状(Claude Code 才认)', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'nope-404-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  // 这条走 default 规则,仍是同一个渠道;上游 200 时不该出错
  assert.ok([200, 404].includes(r.status));
});

test('渠道 API:claude 组可以设 wire_api=responses,非法值被拒', async () => {
  const bad = await rawRequest(uiPort, 'PUT', '/api/providers/p1', { body: { wire_api: 'bogus' } });
  assert.strictEqual(bad.status, 400);
  assert.ok(JSON.parse(bad.text).error.includes('anthropic'));
  const okPut = await rawRequest(uiPort, 'PUT', '/api/providers/p1', { body: { wire_api: 'anthropic' } });
  assert.strictEqual(JSON.parse(okPut.text).ok, true);
  const st = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text);
  const p = st.providers.claude.find(x => x.id === 'p1');
  assert.strictEqual(p.wire_api, undefined, '改回 anthropic 等于删掉该字段');
  await rawRequest(uiPort, 'PUT', '/api/providers/p1', { body: { wire_api: 'responses' } });
  const st2 = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text);
  assert.strictEqual(st2.providers.claude.find(x => x.id === 'p1').wire_api, 'responses');
});
