// 工具参数占位值剪除:OpenAI 系模型(gpt-6-astra/sol)会把 schema 里**每个**属性都填上,
// 不打算用的可选参数就塞空值。Claude Code 按"出现即使用"校验,于是整次调用被拒、模型死循环重试。
// 实测转录:Read 带 pages:"" → `Invalid pages parameter`(约 40 次);Monitor 带
// ws:{protocols:[],url:""} → `exactly one of command or ws`(单会话 87 次)。
//
// 只剪**顶层、不在 required 里**的键:required 的空串是合法值(Edit 的 new_string:"" 就是删除),
// false/0 是真值不是占位。认不出工具名、工具没 schema 就原样不动——宁可漏剪,不可误删。
// responses / chat 两条转换线共用这一份,改规则只改这里。
'use strict';

// "空" = ""、null、[]、{},或每个值都空的对象(递归,{protocols:[],url:""} 算空)。
// 数组只认长度 0:[""] 里有元素,是不是占位说不准,不动。
function isEmpty(v) {
  if (v === '' || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.values(v).every(isEmpty);
  return false;
}

// 请求的 tools → name → required 集合。没 input_schema 的(服务端工具等)不登记,查不到就不剪
function requiredIndex(tools) {
  const idx = new Map();
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || typeof t.name !== 'string' || !t.input_schema || typeof t.input_schema !== 'object') continue;
    const req = Array.isArray(t.input_schema.required) ? t.input_schema.required : [];
    idx.set(t.name, new Set(req));
  }
  return idx;
}

// 返回剪过的新对象;什么都没剪就原样返回同一个引用(调用方据此判断要不要重新序列化)
function pruneInput(input, required) {
  if (!required || !input || typeof input !== 'object' || Array.isArray(input)) return input;
  let out = null;
  for (const k of Object.keys(input)) {
    if (required.has(k) || !isEmpty(input[k])) continue;
    if (!out) out = { ...input };
    delete out[k];
  }
  return out || input;
}

// 转换层用的剪除器:按请求 tools 建一次索引。
//   value(name, obj) —— 整包分支,对象进对象出
//   raw(name, str)   —— 流式分支,JSON 串进串出;没剪到或解析不了就原样返回原串(坏参数由别处判)
function makePruner(tools) {
  const idx = requiredIndex(tools);
  const value = (name, input) => (idx.size ? pruneInput(input, idx.get(name)) : input);
  const raw = (name, str) => {
    const required = idx.get(name);
    if (!required || typeof str !== 'string') return str;
    let obj;
    try { obj = JSON.parse(str.trim() || '{}'); } catch { return str; }
    const out = pruneInput(obj, required);
    return out === obj ? str : JSON.stringify(out);
  };
  return { value, raw };
}

module.exports = { isEmpty, requiredIndex, pruneInput, makePruner };
