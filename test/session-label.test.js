'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sessionLabel, looksInternal, applyLabel, firstUserText, codexFirstUserText, sessionIdentity } = require('../lib/session/identity');

const codexMessage = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const injected = [
  '# AGENTS.md instructions\n项目说明',
  '# claude.MD\n项目说明',
  '<INSTRUCTIONS source="project">规则</INSTRUCTIONS>',
  '<ENVIRONMENT_CONTEXT source="client">环境</ENVIRONMENT_CONTEXT>',
  '<user_instructions source="user">规则</user_instructions>',
  '<System-Reminder source="hook">通告</System-Reminder>',
];

test('sessionLabel(Codex):跳过已知注入前缀后保留包裹提问正文', () => {
  const body = { input: [...injected.map(codexMessage), codexMessage('<session>  帮我看下这个   问题 </session>'), codexMessage('后续提问')] };
  assert.equal(sessionLabel(body, 'codex'), '帮我看下这个 问题');
  assert.equal(sessionLabel({ input: injected.map(codexMessage) }, 'codex'), '');
  assert.equal(sessionLabel({ input: '<session>真实提问</session>' }, 'codex'), '真实提问');
});

test('sessionLabel(Claude):跳过已知注入文本块并剥掉真人话的标签', () => {
  const body = { messages: [{ role: 'user', content: [
    ...injected.map(text => ({ type: 'text', text })),
    { type: 'text', text: '<SESSION source="user">  真实   <question>提问</question> </SESSION>' },
  ] }] };
  assert.equal(sessionLabel(body), '真实 提问');
  assert.equal(sessionLabel({ messages: [{ role: 'user', content: '<session>真实提问</session>' }] }), '真实提问');
  assert.equal(sessionLabel({ messages: injected.map(content => ({ role: 'user', content })) }), '');
});

test('sessionLabel:不完整闭合的普通包裹仍保留正文', () => {
  for (const text of ['<session>真实提问', '<session>真实提问</session', '<session>真实提问</session>']) {
    assert.equal(sessionLabel({ input: text }, 'codex'), '真实提问');
    assert.equal(sessionLabel({ messages: [{ role: 'user', content: text }] }), '真实提问');
  }
});

test('sessionLabel/looksInternal:普通 # 标题和非白名单标签不是注入', () => {
  for (const text of ['# 正常标题', '# AGENTS.md-notes', '# CLAUDE.md-notes']) {
    assert.equal(sessionLabel({ input: text }, 'codex'), text);
    assert.equal(sessionLabel({ messages: [{ role: 'user', content: text }] }), text);
    assert.equal(looksInternal(text), false);
  }
  for (const text of ['<session>真实提问</session>', '<instructions-example>真实提问</instructions-example>']) {
    assert.equal(looksInternal(text), false);
    assert.equal(sessionLabel({ input: text }, 'codex'), '真实提问');
  }
});

test('applyLabel/looksInternal:旧注入标签可更新,已有真人包裹标签不可覆盖', () => {
  for (const label of injected) {
    assert.equal(looksInternal(label), true);
    const record = { label };
    applyLabel(record, '真实提问');
    assert.equal(record.label, '真实提问');
  }
  const record = { label: '<session>真实提问</session>' };
  applyLabel(record, '后续提问');
  applyLabel(record, injected[0]);
  assert.equal(record.label, '<session>真实提问</session>');
  const title = { label: '<session> hi </session> Write the title in the language' };
  applyLabel(title, '真实提问');
  assert.equal(title.label, '真实提问');
});

test('sessionLabel:工作目录优先与正文 60 字限制保持', () => {
  const messages = [{ role: 'user', content: '<session>真实提问</session>' }];
  assert.equal(sessionLabel({ system: '<env>\nWorking directory: /Users/dev/proj/app\n</env>', messages }), '~/proj/app');
  assert.equal(sessionLabel({ system: '<cwd>/home/dev/work</cwd>', messages }), '~/work');
  assert.equal(sessionLabel({ input: '<session>' + '问'.repeat(80) + '</session>' }, 'codex'), '问'.repeat(60));
});

test('标签剥除不改变首条原文或会话指纹', () => {
  const hash = seed => crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
  const wrapped = '<session>真实提问</session>';
  const claude = { system: 'sys', messages: [{ role: 'user', content: wrapped }] };
  assert.equal(firstUserText(claude), wrapped);
  assert.deepEqual(sessionIdentity({ headers: {} }, claude), { key: 'fp:' + hash('sys\u0000' + wrapped), kind: 'fingerprint' });
  const codex = { instructions: 'sys', input: [codexMessage(injected[0]), codexMessage(wrapped)] };
  assert.equal(codexFirstUserText(codex), injected[0]);
  assert.deepEqual(sessionIdentity({ headers: {} }, codex, 'codex'), { key: 'cxf:' + hash('sys\u0000' + injected[0]), kind: 'fingerprint' });
  assert.equal(sessionLabel(claude), '真实提问');
  assert.equal(sessionLabel(codex, 'codex'), '真实提问');
});
