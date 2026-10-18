'use strict';

const crypto = require('node:crypto');

const identity = (name, namespace) => JSON.stringify([namespace || '', name || '']);

function registry(tools = []) {
  const specs = [];
  const collect = (items, namespace = '') => {
    for (const tool of Array.isArray(items) ? items : []) {
      if (!tool) continue;
      if (tool.type === 'namespace') {
        collect(tool.tools, namespace ? `${namespace}.${tool.name}` : tool.name);
      } else if (tool.type === 'function' || tool.type === 'custom') {
        const definition = tool.function || tool;
        if (typeof definition.name === 'string' && definition.name) specs.push({ ...definition, type: tool.type, namespace });
      }
    }
  };
  collect(tools);
  const byName = new Map();
  const byIdentity = new Map();
  const reserved = new Set(specs.filter(spec => !spec.namespace).map(spec => spec.name));
  for (const spec of specs) {
    const key = identity(spec.name, spec.namespace);
    if (byIdentity.has(key)) continue;
    let name = spec.namespace ? `${spec.namespace}__${spec.name}` : spec.name;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || byName.has(name) || (spec.namespace && reserved.has(name))) {
      const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
      name = `mixr_${hash}`;
    }
    const entry = { ...spec, chatName: name };
    byName.set(name, entry);
    byIdentity.set(key, entry);
  }
  return { byName, byIdentity };
}

function definitions(book) {
  return [...book.byName.values()].map(spec => ({ type: 'function', function: {
    name: spec.chatName,
    description: spec.description || '',
    parameters: spec.type === 'custom'
      ? { type: 'object', properties: { input: { type: 'string', description: 'The exact free-form tool input, without JSON encoding or Markdown fences.' } }, required: ['input'], additionalProperties: false }
      : spec.parameters || { type: 'object', properties: {} },
    ...(spec.type === 'function' && spec.strict !== undefined ? { strict: spec.strict } : {}),
  } }));
}

function callToChat(item, book) {
  const spec = book.byIdentity.get(identity(item.name, item.namespace));
  return { id: item.call_id || item.id || `call_${crypto.randomBytes(8).toString('hex')}`, type: 'function', function: {
    name: spec ? spec.chatName : item.name || '',
    arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input || '' }) : item.arguments || '{}',
  } };
}

function callFromChat(call, book, id) {
  const spec = book.byName.get(call.function?.name);
  const args = call.function?.arguments || '{}';
  let parsed;
  try { parsed = JSON.parse(args); } catch { throw new Error('Codex 工具参数不是完整 JSON，已阻止执行'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Codex 工具参数必须是 JSON 对象');
  const output = { id, call_id: call.id || id, name: spec?.name || call.function?.name || '', status: 'completed',
    ...(spec?.namespace ? { namespace: spec.namespace } : {}) };
  if (spec?.type === 'custom') {
    if (typeof parsed.input !== 'string') throw new Error('Codex 自定义工具缺少字符串 input，已阻止执行');
    return { ...output, type: 'custom_tool_call', input: parsed.input };
  }
  return { ...output, type: 'function_call', arguments: args };
}

function choiceToChat(choice, book) {
  if (!choice || typeof choice !== 'object') return choice === undefined ? 'auto' : choice;
  if (choice.type === 'function' && choice.function) return choice;
  if ((choice.type === 'function' || choice.type === 'custom') && choice.name) {
    const spec = book.byIdentity.get(identity(choice.name, choice.namespace));
    return { type: 'function', function: { name: spec?.chatName || choice.name } };
  }
  return 'auto';
}

function reasoningText(item) {
  return [...(Array.isArray(item?.summary) ? item.summary : []), ...(Array.isArray(item?.content) ? item.content : [])]
    .filter(part => part && typeof part.text === 'string').map(part => part.text).join('\n');
}

module.exports = { registry, definitions, callToChat, callFromChat, choiceToChat, reasoningText };
