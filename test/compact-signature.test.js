'use strict';
// 压缩请求判据:固定前导开头 + 摘要模板,只看末条 user 的直接文本。
// 全部离线,临时数据目录 + loopback mock 上游,不碰真实配置、不出网、不调模型。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-compact-sig-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
const sig = require('../lib/routing/compact-signature');
const identity = require('../lib/session/identity');
const rules = require('../lib/routing/rules');
const { whenMissFields } = require('../lib/routing/resolve');
const mod = require('../mixrouter');

const SUMMARY = sig.FIXED_PREFIX + 'Your task is to create a detailed summary of the conversation so far, paying close attention to the user requests and your previous actions.';
const PARTIAL = sig.FIXED_PREFIX + 'Your task is to create a detailed summary of the RECENT portion of the conversation';
const MARKED = sig.FIXED_PREFIX + sig.MARKER + '\n=== TalentsAI 压缩保留要求 ===\nYour task is to create a detailed summary of this conversation.';
// 引用了规则特征串、但不是压缩请求的普通编程任务(本次误分流的实际形状)
const TASK = '请按 when.body 匹配两个特征串 your task is to create a detailed summary of / ' + sig.MARKER + ' 识别两条压缩规则,给压缩请求加判据。';
const compactRule = id => ({ id, match: '', app: 'claude', enabled: true, priority: 90,
  when: { body: 'your task is to create a detailed summary of' }, provider: 'pc', model: 'compact-model', pool: [] });

test('判据要开头锚定 + 摘要模板,引用特征串或只有前导都不算压缩', () => {
  assert.equal(sig.isCompactInstruction(SUMMARY), true);
  assert.equal(sig.isCompactInstruction(PARTIAL), true);
  assert.equal(sig.isCompactInstruction(MARKED), true);
  assert.equal(sig.isCompactInstruction(TASK), false, '任务讨论不得算压缩');
  assert.equal(sig.isCompactInstruction(sig.FIXED_PREFIX), false, '只有前导没有摘要模板');
  assert.equal(sig.isCompactInstruction('Your task is to create a detailed summary of the conversation'), false, '没有固定前导');
  assert.equal(sig.isCompactInstruction('转述: ' + SUMMARY), false, '前导必须开头,不得当子串');
  assert.equal(sig.isCompactInstruction(SUMMARY.slice(1)), false, '缺一个字就不算');
  assert.equal(sig.isCompactRequest([TASK, SUMMARY]), true, '末条 user 的任一直接文本块命中即可');
  assert.equal(sig.isCompactRequest([TASK]), false);
  assert.equal(sig.isCompactRequest([]), false);
});

test('规则身份来自 when.body 而不是 id;改名后仍判同一条', () => {
  assert.equal(sig.compactKind({ when: { body: sig.MARKER } }), 'talentsai');
  assert.equal(sig.compactKind({ id: 'rcompact-global-ds', when: { body: 'your task is to create a detailed summary of' } }), 'global');
  assert.equal(sig.compactKind({ id: 'rcompact-global-ds', when: { body: '别的内容' } }), '', 'id 同名但 body 不同就不是压缩规则');
  assert.equal(sig.compactKind({ id: 'anything', when: { body: sig.MARKER.toUpperCase() } }), 'talentsai', '大小写不敏感');
  assert.equal(sig.compactKind({}), '');
  assert.equal(sig.compactRuleMatches(compactRule('renamed'), [MARKED]), true);
  assert.equal(sig.compactRuleMatches(compactRule('renamed'), [TASK]), false);
  assert.equal(sig.compactRuleMatches({ when: { body: sig.MARKER } }, [SUMMARY]), false, 'global 压缩不带本条标记');
  assert.equal(sig.compactRuleMatches({ when: { body: sig.MARKER } }, [MARKED]), true);
});

test('compactTexts 只取末条 user 的直接文本,不读 tool_result、system、历史或嵌套引文', () => {
  assert.deepEqual(identity.compactTexts({ messages: [{ role: 'user', content: SUMMARY }] }), [SUMMARY]);
  // 工具结果里带着标记:不算(本次误判的实际入口)
  assert.deepEqual(identity.compactTexts({ messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: sig.MARKER + '\n' + SUMMARY }] }] }), []);
  // 系统说明里带着前导:不算
  assert.deepEqual(identity.compactTexts({ system: SUMMARY, messages: [{ role: 'user', content: '继续' }] }), ['继续']);
  // 末条 user 之后还挂着 system 通告(2.1.270 形状),仍取最后一条 user
  assert.deepEqual(identity.compactTexts({ messages: [
    { role: 'user', content: SUMMARY }, { role: 'assistant', content: 'ok' },
    { role: 'system', content: 'The following deferred tools are now available' }] }), [SUMMARY]);
  // 历史 user 消息里引用过特征串:末条才是判据,历史不进
  assert.deepEqual(identity.compactTexts({ messages: [
    { role: 'user', content: SUMMARY }, { role: 'assistant', content: 'ok' }, { role: 'user', content: TASK }] }), [TASK]);
  // 数组内容只收 type:text 的顶层块,顺序保留
  assert.deepEqual(identity.compactTexts({ messages: [{ role: 'user', content: [
    { type: 'thinking', thinking: SUMMARY }, { type: 'text', text: 'a' },
    { type: 'tool_result', content: SUMMARY }, { type: 'text', text: 'b' }, 'plain', 42, null] }] }), ['a', 'b']);
  // Responses 形状:string input 视为单条 user;items 里 role:user 的文本块同样只收 input_text/text
  assert.deepEqual(identity.compactTexts({ input: SUMMARY }), [SUMMARY]);
  assert.deepEqual(identity.compactTexts({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: SUMMARY }] }] }), [SUMMARY]);
  assert.deepEqual(identity.compactTexts({ input: [{ type: 'function_call_output', output: MARKED }] }), [], '工具输出不算 user 直接文本');
  assert.deepEqual(identity.compactTexts({ messages: [null, 42, { role: 'user' }] }), []);
  assert.deepEqual(identity.compactTexts(undefined), []);
  assert.deepEqual(identity.compactTexts({}), []);
});

test('matchWhen 与 whenMissFields 对压缩规则同判定,且惰性不求值无关回调', () => {
  let bodyCalls = 0, textCalls = 0;
  const ctx = texts => ({ bodyText: () => { bodyCalls++; return SUMMARY.toLowerCase(); }, compactTexts: () => { textCalls++; return texts; } });
  const rule = compactRule('renamed');
  assert.equal(rules.matchWhen(rule, ctx([MARKED])), true);
  assert.equal(whenMissFields(rule, ctx([MARKED])) === null, true);
  assert.equal(rules.matchWhen(rule, ctx([TASK])), false);
  assert.deepEqual(whenMissFields(rule, ctx([TASK])), ['body']);
  assert.equal(bodyCalls, 0, '压缩规则不吃 bodyText');
  assert.equal(textCalls, 4);
  // 没有 compactTexts 回调时判"不匹配",不得抛
  assert.equal(rules.matchWhen(rule, { bodyText: () => SUMMARY.toLowerCase() }), false);
  assert.deepEqual(whenMissFields(rule, {}), ['body']);
  // 与 matchWhen 同一惰性短路:session 没过时不碰 compactTexts
  let calls = 0;
  assert.equal(rules.matchWhen({ ...rule, when: { session: 'nope', body: rule.when.body } }, { session: 'x', compactTexts: () => { calls++; return [MARKED]; } }), false);
  assert.equal(calls, 0);
  // 非压缩的通用 when.body 规则语义不变
  const generic = { id: 'g', when: { body: 'detailed summary of the conversation' } };
  assert.equal(rules.matchWhen(generic, { bodyText: () => 'please provide a detailed summary of the conversation' }), true);
  assert.equal(rules.matchWhen(generic, { bodyText: () => 'nothing' }), false);
  assert.equal(whenMissFields(generic, { bodyText: () => 'please provide a detailed summary of the conversation' }), null);
});

// ---------------- 端到端:代理真的不再被引用特征串的任务改道 ----------------
let ui, proxy, upstream, base;
const hits = [];
const post = (body, session = 'sess-sig') => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request(`http://127.0.0.1:${proxy.address().port}/v1/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-claude-code-session-id': session } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString() || '{}'), headers: res.headers }));
  });
  req.on('error', reject); req.end(data);
});

before(async () => {
  upstream = http.createServer((req, res) => { const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { const b = JSON.parse(Buffer.concat(chunks)); hits.push(b);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'mock', model: b.model, content: [], usage: { input_tokens: 1, output_tokens: 1 } })); }); });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${upstream.address().port}`;
  ui = await mod.listen(0, mod.apiHandler); proxy = await mod.listen(0, mod.proxyHandler);
  mod._state.store = { claude: [
    { id: 'pm', name: 'Main', base_url: base, api_key: 'fake', enabled: true, models: ['slot-model'] },
    { id: 'pc', name: 'Compact', base_url: base, api_key: 'fake', enabled: true, models: ['compact-model'] }], codex: [] };
  mod._state.slotMap = { claude: { main: { provider: 'pm', model: 'slot-model' } }, codex: {} };
  // 两条压缩规则都被改过名,身份只能靠 when.body
  mod._state.routes = { rules: [
    compactRule('renamed-global'),
    { id: 'renamed-talentsai', match: '', app: 'claude', enabled: true, priority: 100,
      when: { body: sig.MARKER }, provider: 'pc', model: 'compact-model', pool: [] }],
  default: { provider: 'pm', model: 'default-model' } };
});

test('真压缩命中压缩渠道;引用特征串的任务、工具结果与系统说明仍走槽位', async () => {
  const sent = async (messages, system) => { hits.length = 0;
    const r = await post({ model: 'mixr-main', max_tokens: 1, messages, ...(system ? { system } : {}) });
    assert.equal(r.status, 200); return hits[0].model; };
  assert.equal(await sent([{ role: 'user', content: SUMMARY }]), 'compact-model', '完整压缩');
  assert.equal(await sent([{ role: 'user', content: PARTIAL }]), 'compact-model', 'partial 压缩');
  assert.equal(await sent([{ role: 'user', content: MARKED }]), 'compact-model', '带 TalentsAI 标记');
  assert.equal(await sent([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: MARKED },
    { type: 'text', text: '请继续' }] }]), 'slot-model', '工具结果里的标记不改道');
  assert.equal(await sent([{ role: 'user', content: TASK }]), 'slot-model', '讨论压缩规则的编程任务不改道');
  assert.equal(await sent([{ role: 'user', content: '继续' }], SUMMARY), 'slot-model', '系统说明里的前导不改道');
  assert.equal(await sent([{ role: 'user', content: SUMMARY }, { role: 'assistant', content: 'ok' },
    { role: 'user', content: TASK }]), 'slot-model', '历史里出现过不改道');
  assert.equal(await sent([{ role: 'user', content: [{ type: 'text', text: 'A' }, { type: 'text', text: MARKED }] }]),
    'compact-model', '前导与标记拆成两个直接文本块仍算压缩');
});

after(async () => { await Promise.all([ui, proxy, upstream].map(s => new Promise(ok => s.close(ok))));
  fs.rmSync(TMP, { recursive: true, force: true }); });
