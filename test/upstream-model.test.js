'use strict';
// 上游模型证据(entry.upstream_model)的单元回归。
//
// 这个字段的失效方式不是崩溃,而是"看起来很真":把请求名、槽位名或转换器合成名写进去,
// 日志与模型洞察页都会把它当成上游自报值。这里的用例逐条钉住:
//   · 只认协议里明确的 model 字段(Anthropic message/message_start、Chat、Responses
//     response/response.*);
//   · 正文里出现的 {"model":"..."} 不算证据;
//   · 缺字段、坏 JSON、超长/含控制字符 → 未知(空串),绝不回落到调用方给的模型;
//   · 同一次尝试第一次观测生效,跨尝试的清零由调用方负责;
//   · 三个转换转发入口的可选回调真的只报上游值。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const upstreamModel = require('../lib/observability/upstream-model');
const wireChat = require('../lib/wire-chat');
const wireResponses = require('../lib/wire-responses');
const wireOpenai = require('../lib/wire-openai-bridge');
const { createAnthropicTranslator } = require('../lib/wire-anthropic-translator');

const {
  MODEL_MAX_CHARS, upstreamModelOf, upstreamModelFromJson, upstreamModelFromSse,
  upstreamModelFromText, rememberUpstreamModel, rememberUpstreamModelFromJson,
  rememberUpstreamModelFromSse, clearUpstreamModel,
} = upstreamModel;

const frame = value => `data: ${JSON.stringify(value)}\n\n`;

// ---------------------------------------------------------------- 清洗
test('upstreamModelOf:只接受干净的模型名字符串', () => {
  assert.equal(upstreamModelOf('gpt-6-astra'), 'gpt-6-astra');
  assert.equal(upstreamModelOf('  glm-5.3  '), 'glm-5.3', '只做首尾空白修剪,不改写名字');
  assert.equal(upstreamModelOf(''), '');
  assert.equal(upstreamModelOf('   '), '');
  assert.equal(upstreamModelOf(null), '');
  assert.equal(upstreamModelOf(undefined), '');
  assert.equal(upstreamModelOf(42), '', '数字不是上游协议里的 model 字符串');
  assert.equal(upstreamModelOf({ model: 'nested' }), '');
  assert.equal(upstreamModelOf('a\nb'), '', '换行/控制字符不进日志字段');
  assert.equal(upstreamModelOf('a\u007fb'), '');
  assert.equal(upstreamModelOf('x'.repeat(MODEL_MAX_CHARS)), 'x'.repeat(MODEL_MAX_CHARS));
  assert.equal(upstreamModelOf('x'.repeat(MODEL_MAX_CHARS + 1)), '', '超长值不截断,按未知处理');
});

// ---------------------------------------------------------------- JSON 协议位置
test('upstreamModelFromJson:Anthropic / Chat / Responses 的原始对象', () => {
  assert.equal(upstreamModelFromJson({ model: 'chat-model', choices: [] }), 'chat-model');
  assert.equal(upstreamModelFromJson({ type: 'message', role: 'assistant', model: 'claude-upstream' }), 'claude-upstream');
  assert.equal(upstreamModelFromJson({ type: 'message_start', message: { model: 'start-model' } }), 'start-model');
  assert.equal(upstreamModelFromJson({ type: 'response', status: 'completed', model: 'resp-model' }), 'resp-model');
  assert.equal(upstreamModelFromJson({ type: 'response.created', response: { model: 'resp-created' } }), 'resp-created');
  assert.equal(upstreamModelFromJson({ type: 'response.completed', response: { model: 'resp-done' } }), 'resp-done');
  assert.equal(upstreamModelFromJson({ type: 'response.output_text.delta', delta: 'hi' }), '');
  assert.equal(upstreamModelFromJson({ type: 'message_start', message: { content: [{ type: 'text', text: 'x' }] } }), '');
  assert.equal(upstreamModelFromJson(null), '');
  assert.equal(upstreamModelFromJson([]), '');
  assert.equal(upstreamModelFromJson('model'), '');
});

test('upstreamModelFromJson:正文里的同名字样不是证据', () => {
  // chat delta 的 content 是一段字符串;即使它恰好是 JSON,也不在顶层 model 路径上。
  assert.equal(upstreamModelFromJson({
    choices: [{ delta: { content: '{"model":"fake-from-content"}' } }],
  }), '');
  // Responses 的未知事件里塞 response 但不是 response.* 事件,不读。
  assert.equal(upstreamModelFromJson({ type: 'custom.event', response: { model: 'not-a-response-event' } }), '');
  // message 只在 message_start 下认,避免把聊天错误对象里的 message 当协议消息。
  assert.equal(upstreamModelFromJson({ type: 'error', message: { model: 'error-message' } }), '');
});

// ---------------------------------------------------------------- SSE 取样
test('upstreamModelFromSse:完整流、CRLF、event 行与 [DONE]', () => {
  const anthropic = [
    'event: message_start',
    `data: ${JSON.stringify({ type: 'message_start', message: { model: 'up-anthropic' } })}`,
    '',
    'data: [DONE]',
    '',
  ].join('\r\n');
  assert.equal(upstreamModelFromSse(anthropic), 'up-anthropic');

  const chat = `${frame({ model: 'up-chat', choices: [{ delta: { content: 'x' } }] })}data: [DONE]\n\n`;
  assert.equal(upstreamModelFromSse(chat), 'up-chat');

  const responses = frame({ type: 'response.created', response: { model: 'up-responses' } });
  assert.equal(upstreamModelFromSse(responses), 'up-responses');
});

test('upstreamModelFromSse:headTailUsage 的首尾样本(NUL 间隔、被裁断的行)', () => {
  const head = `${frame({ type: 'message_start', message: { model: 'head-model' } })}data: {"type":"content_block_delta","del`;
  const tail = `ta":{}}\n\n${frame({ type: 'message_stop' })}`.slice(3);
  assert.equal(upstreamModelFromSse(`${head}\u0000${tail}`), 'head-model');

  // 只在尾段出现时也要能认出来(首段是无关帧 + NUL + 尾段终态)。
  const headNoModel = `${frame({ type: 'response.output_text.delta', delta: 'hi' })}\u0000`;
  const tailTerminal = frame({ type: 'response.completed', response: { model: 'tail-model' } });
  assert.equal(upstreamModelFromSse(headNoModel + tailTerminal), 'tail-model');
});

test('upstreamModelFromSse:正文里的假 model、坏 JSON、缺字段一律未知', () => {
  const fake = frame({ choices: [{ delta: { content: 'here is {"model":"from-answer"}' } }] });
  assert.equal(upstreamModelFromSse(fake), '');
  assert.equal(upstreamModelFromSse('data: {not json}\n\n'), '');
  assert.equal(upstreamModelFromSse('data: [DONE]\n\n'), '');
  assert.equal(upstreamModelFromSse(''), '');
  assert.equal(upstreamModelFromSse('event: message_start\ndata: {"type":"message_start","message":{}}\n\n'), '');
  // 超长 data 行不解析(避免把整包回答当模型来源),按未知处理。
  const long = `data: ${JSON.stringify({ model: 'too-long', pad: 'x'.repeat(70 * 1024) })}\n\n`;
  assert.equal(upstreamModelFromSse(long), '');
});

test('upstreamModelFromText:整包 JSON 与 SSE,损坏的 JSON 不用正则兜底', () => {
  assert.equal(upstreamModelFromText(JSON.stringify({ model: 'json-model', choices: [] })), 'json-model');
  assert.equal(upstreamModelFromText(frame({ model: 'sse-model' })), 'sse-model');
  // 以 { 开头但解析失败:直接未知,不退回逐行"捞" model。
  assert.equal(upstreamModelFromText('{"model":"broken"'), '');
  assert.equal(upstreamModelFromText('回答里提到 {"model":"fake"}'), '');
});

// ---------------------------------------------------------------- 生命周期
test('remember/clear:同一次尝试第一次观测生效,未知不覆盖,跨尝试清零', () => {
  const entry = {};
  assert.equal(rememberUpstreamModel(entry, ''), '');
  assert.equal(entry.upstream_model, undefined, '未知不写字段');
  assert.equal(rememberUpstreamModel(entry, 'first'), 'first');
  assert.equal(entry.upstream_model, 'first');
  assert.equal(rememberUpstreamModel(entry, 'second'), 'first', '同一发的后续观测不覆盖第一次');
  assert.equal(entry.upstream_model, 'first');
  clearUpstreamModel(entry);
  assert.equal(entry.upstream_model, '');
  assert.equal(rememberUpstreamModelFromJson(entry, { model: 'next' }), 'next');
  assert.equal(entry.upstream_model, 'next');
  assert.equal(rememberUpstreamModelFromSse(entry, frame({ model: 'ignored' })), 'next');
  assert.equal(rememberUpstreamModel(null, 'x'), '', '没有 entry 时静默忽略');
});

// ---------------------------------------------------------------- 转换入口的可选回调
// 只实现 relay 用到的成员:writeHead / write / end / headersSent / writableEnded / destroyed
function fakeResponse() {
  return {
    headersSent: false, writableEnded: false, destroyed: false, statusCode: 0, headers: null, text: '',
    writeHead(status, headers) { this.headersSent = true; this.statusCode = status; this.headers = headers; },
    write(chunk) { this.text += String(chunk); return true; },
    end() { this.writableEnded = true; },
  };
}
const upstreamStream = () => {
  const up = new PassThrough();
  up.statusCode = 200;
  return up;
};

test('relayChatStream:只报原始 chat chunk 的 model,不报请求名', async () => {
  const up = upstreamStream();
  const res = fakeResponse();
  const seen = [];
  const done = wireChat.relayChatStream(up, res, 'requested-chat-model', {
    onUpstreamModel: model => seen.push(model),
  });
  up.write(frame({ model: 'served-chat-model', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }));
  up.write(frame({ model: 'served-chat-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  up.end('data: [DONE]\n\n');
  await done;
  assert.deepEqual([...new Set(seen)], ['served-chat-model']);
  assert.ok(!seen.includes('requested-chat-model'));
});

test('relayChatStream:上游没报 model 时不回调(绝不回落到参数)', async () => {
  const up = upstreamStream();
  const seen = [];
  const done = wireChat.relayChatStream(up, fakeResponse(), 'requested-chat-model', {
    onUpstreamModel: model => seen.push(model),
  });
  up.write(frame({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }));
  up.end('data: [DONE]\n\n');
  await done;
  assert.deepEqual(seen, []);
});

test('relayAnthropicStream:从 response.created/终态事件取自报 model', async () => {
  const up = upstreamStream();
  const seen = [];
  const done = wireResponses.relayAnthropicStream(up, fakeResponse(), 'requested-responses-model', {
    onUpstreamModel: model => seen.push(model),
  });
  up.write(frame({ type: 'response.created', response: { id: 'r', status: 'in_progress', model: 'served-responses-model', output: [] } }));
  up.write(frame({ type: 'response.output_text.delta', output_index: 0, delta: 'hi' }));
  up.write(frame({ type: 'response.completed', response: { id: 'r', status: 'completed', model: 'served-responses-model', output: [], usage: {} } }));
  up.end();
  await done;
  assert.deepEqual([...new Set(seen)], ['served-responses-model']);
  assert.ok(!seen.includes('requested-responses-model'));
});

test('streamChatAsResponses:只报原始 chat chunk 的 model', async () => {
  const up = upstreamStream();
  const res = fakeResponse();
  const seen = [];
  const done = new Promise(resolve => {
    wireOpenai.streamChatAsResponses(up, res, 'requested-bridge-model', () => resolve(), {}, {}, {
      onUpstreamModel: model => seen.push(model),
    });
  });
  up.write(frame({ model: 'served-bridge-model', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }));
  up.write(frame({ model: 'served-bridge-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  up.end('data: [DONE]\n\n');
  await done;
  assert.deepEqual([...new Set(seen)], ['served-bridge-model']);
  assert.ok(!seen.includes('requested-bridge-model'));
});

test('endWholeJson:整包转换只报原始 JSON 的 model,缺字段时不报合成名', () => {
  const translator = createAnthropicTranslator({
    convertError: wireChat.chatErrorOf,
    convertMessage: wireChat.chatToAnthropic,
  });
  const seen = [];
  const base = {
    headers: {}, model: 'requested-text-model', bodyStream: false,
    finishEntry() {}, onUpstreamModel: model => seen.push(model),
  };
  translator.endWholeJson({
    ...base, res: fakeResponse(), entry: {},
    text: JSON.stringify({ model: 'served-text-model', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
  });
  assert.deepEqual(seen, ['served-text-model']);

  const seenAbsent = [];
  translator.endWholeJson({
    ...base, res: fakeResponse(), entry: {},
    onUpstreamModel: model => seenAbsent.push(model),
    text: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
  });
  assert.deepEqual(seenAbsent, [], '转换结果的 model 会回落到请求名,但那不是上游证据');
});
