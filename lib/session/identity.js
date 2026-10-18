'use strict';
// 会话身份:把一次请求归一化成一个稳定的会话 key(以及给人看的标签)。
// 两种客户端各有一套身份来源,取不到官方 id 时用内容指纹兜底。
// 指纹用 crypto 计算;标签开关在加载时读取,applyLabel 原位更新传入的会话对象。

const crypto = require('crypto');

// 会话标签(从 system prompt 的工作目录 / 首条用户消息取,便于控制台认出是哪个对话);置 0 关闭
const SESSION_LABEL = process.env.MIXR_SESSION_LABEL !== '0';

// "对话"= 一个客户端会话。优先用官方头,其次请求体里的会话字段,
// 都没有(自定义客户端)就用 system/instructions + 首条用户消息的内容指纹兜底。
function parseSessionId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // CC 个别版本把 metadata.user_id 塞成 JSON 字符串,里面才是 session_id
  if (s.startsWith('{')) { try { return String(JSON.parse(s).session_id || '').trim(); } catch { return ''; } }
  return s;
}

function bodySystemText(body) {
  const sys = body && body.system;
  if (!sys) return '';
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) return sys.map(b => (typeof b === 'string' ? b : (b && b.text) || '')).join('\n');
  return '';
}

function firstUserText(body) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  for (const m of msgs) {
    // 数组元素不保证是对象:客户端可能塞 null / 数字进来。以前直接读 m.role,
    // 一个 messages:[null] 就能把整个进程掀掉(未捕获 TypeError,launchd 再拉起来,
    // 这条会话的请求全部作废),而这不是"恶意输入",只是客户端拼错了。
    if (!m || typeof m !== 'object' || m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      // 跳过 CC 注入的 <system-reminder> 块,取真正的人话
      for (const b of c) {
        if (b && b.type === 'text' && b.text && !/^\s*<system-reminder>/.test(b.text)) return b.text;
      }
    }
  }
  return '';
}

// ---- Codex(OpenAI 协议)侧的会话身份 ----
// 实测 codex-cli 0.154:每个请求都带 session-id / thread-id / x-client-request-id(同一个 UUID),
// 请求体里 prompt_cache_key 同值,client_metadata.session_id 与 x-codex-turn-metadata 里也各有一份
function codexHeaderSessionId(req) {
  const headers = (req && req.headers) || {};
  for (const h of ['session-id', 'thread-id', 'x-client-request-id']) {
    const v = String(headers[h] || '').trim();
    if (v) return v;
  }
  const tm = String(headers['x-codex-turn-metadata'] || '').trim();
  if (tm.startsWith('{')) { try { return String(JSON.parse(tm).session_id || '').trim(); } catch {} }
  return '';
}

function codexBodySessionId(body) {
  const direct = String((body && body.prompt_cache_key) || '').trim();
  if (direct) return direct;
  const cm = body && body.client_metadata;
  if (cm && typeof cm === 'object' && cm.session_id) return String(cm.session_id).trim();
  return '';
}

function codexSystemText(body) { return (body && typeof body.instructions === 'string') ? body.instructions : ''; }

// Codex 的 input 是 items 数组;把 role=user 的文本都取出来
function codexUserTexts(body) {
  const input = body && body.input;
  const out = [];
  if (typeof input === 'string') out.push(input);
  if (Array.isArray(input)) for (const it of input) {
    if (!it || it.type !== 'message' || it.role !== 'user') continue;
    const c = it.content;
    if (typeof c === 'string') { out.push(c); continue; }
    if (Array.isArray(c)) {
      const t = c.filter(b => b && (b.type === 'input_text' || b.type === 'text') && b.text).map(b => b.text).join('');
      if (t) out.push(t);
    }
  }
  return out;
}

// 指纹与标签都用首条用户文本(跨轮稳定):Codex 每轮把历史消息整体重发,首条不变
function codexFirstUserText(body) { return codexUserTexts(body)[0] || ''; }

// 返回 { key, kind }:kind 标明身份是怎么来的,便于日志排查。
// key 带来源前缀(cc/cx = 官方会话 id,fp/cxf = 内容指纹),两种客户端永不撞车
function sessionIdentity(req, body, app = 'claude') {
  if (app === 'codex') {
    const header = codexHeaderSessionId(req);
    if (header) return { key: 'cx:' + header, kind: 'header' };
    const meta = codexBodySessionId(body);
    if (meta) return { key: 'cx:' + meta, kind: 'metadata' };
    const chatSystem = (Array.isArray(body && body.messages) ? body.messages : [])
      .filter(m => m && typeof m === 'object' && (m.role === 'system' || m.role === 'developer'))
      .map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    const seed = (codexSystemText(body) || chatSystem) + '\u0000' + (codexFirstUserText(body) || firstUserText(body));
    if (!seed.replace(/\u0000/g, '').trim()) return { key: 'cx-anon', kind: 'anon' };
    return { key: 'cxf:' + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16), kind: 'fingerprint' };
  }
  const header = parseSessionId(req && req.headers && req.headers['x-claude-code-session-id']);
  if (header) return { key: 'cc:' + header, kind: 'header' };
  const meta = body && body.metadata && parseSessionId(body.metadata.user_id);
  if (meta) return { key: 'cc:' + meta, kind: 'metadata' };
  const seed = bodySystemText(body) + '\u0000' + firstUserText(body);
  if (!seed.replace(/\u0000/g, '').trim()) return { key: 'anon', kind: 'anon' };
  return { key: 'fp:' + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16), kind: 'fingerprint' };
}

// 会话标签:优先 system prompt 里的工作目录(CC 的 <env> 块),否则首条用户消息
function sessionLabel(body, app = 'claude') {
  if (!SESSION_LABEL) return '';
  if (app === 'codex') {
    // Codex 会在用户消息前面塞 <environment_context> / <user_instructions> 这类注入块,
    // 标签要跳过它们,取第一句真人话;全是注入块时才退回第一块
    const texts = codexUserTexts(body);
    const human = texts.find(t => !/^\s*</.test(t)) || texts[0] || '';
    const t = human.replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, 60) : '';
  }
  const sys = bodySystemText(body);
  const wd = sys.match(/Working directory:\s*(\S+)/) || sys.match(/<cwd>([^<]+)<\/cwd>/);
  if (wd) return wd[1].replace(/^\/(?:Users|home)\/[^/]+/, '~');
  const t = firstUserText(body).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 60) : '';
}

// CC 会为同一会话再发一次"起标题"之类的内部请求,它的首条消息不是用户真正说的话。
// 标签只在会话里还没标签、或现有标签是这种内部文案时才更新,免得把有用的标签覆盖掉。
const looksInternal = s => /^\s*</.test(s) || /Write the title/i.test(s);

function applyLabel(s, label) {
  if (!label || !SESSION_LABEL || !s) return;
  if (!s.label || (looksInternal(s.label) && !looksInternal(label))) s.label = label;
}

// 日志/控制台里显示的短 id:去掉来源前缀再取前 8 位,和客户端自己显示的会话号对得上
const sessionKeyOf = k => String(k || '').replace(/^(?:cc|fp|cx|cxf):/, '').slice(0, 8);

// 内容分流(when.body)的匹配文本:system/instructions + 最后一条消息。
// 不用整包 body——历史每轮重发,对话里出现过的短语会永久劫持路由(实测:一条引用了规则原文的
// 子代理报告进来后,主槽请求全部被判给内容分流规则)。压缩类请求的指令就在最后一条消息里。
function bodyRouteText(body) {
  const b = body && typeof body === 'object' ? body : {};
  const parts = [];
  const sys = b.system ?? b.instructions;
  if (typeof sys === 'string') parts.push(sys);
  else if (Array.isArray(sys)) {
    for (const x of sys) {
      if (typeof x === 'string') parts.push(x);
      else if (x && x.type === 'text') parts.push(x.text || '');
    }
  }
  // Responses 形状的 input 可以是字符串(等价于单条 user 消息),也可以是数组。
  // 以前只认数组,字符串形状的合法请求拿到空匹配文本、静默落到默认渠道——
  // 同一句话写成数组就能命中内容分流。两种形状现在一视同仁。
  const msgs = Array.isArray(b.messages) ? b.messages
    : (Array.isArray(b.input) ? b.input : (typeof b.input === 'string' && b.input ? [{ role: 'user', content: b.input }] : []));
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  if (last && typeof last === 'object') {
    const c = last.content ?? last.text ?? '';
    parts.push(typeof c === 'string' ? c : JSON.stringify(c));
  }
  // 压缩指令拼在最后一条 user 消息里,其后可能还挂着 system 通告(如 ToolSearch 工具清单)——
  // 实测 2.1.270 每条主链请求末尾都带 system 通告,只看数组末尾会漏掉全部真实 Claude Code 请求。
  // 补上最后一条 user 消息;历史消息依旧不进匹配文本,防劫持边界不变。
  let lastUser = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === 'user') { lastUser = msgs[i]; break; }
  }
  if (lastUser && lastUser !== last) {
    const c = lastUser.content ?? lastUser.text ?? '';
    parts.push(typeof c === 'string' ? c : JSON.stringify(c));
  }
  return parts.join('\n');
}

// 压缩请求判定专用的文本:末条 role=user 消息的**直接文本块**,不含 system、
// 不含 tool_result、不解析正文里的引文。返回字符串数组(通常 0 或 1 条)。
//
// 与 bodyRouteText 的区别是刻意的:bodyRouteText 把 system/instructions 和末条消息
// 整体(数组内容按 JSON.stringify)拼成一个大字符串给通用 when.body 子串匹配用,
// 那里"含这个短语"是用户自己声明的语义。压缩规则不能沿用——特征串会被任务说明
// 和工具结果原样引用(实测踩过),必须限定在"客户端真发压缩指令的那个位置"。
// 判据本身在 lib/routing/compact-signature.js(固定前导开头 + 摘要模板)。
function compactTexts(body) {
  const b = body && typeof body === 'object' ? body : {};
  const msgs = Array.isArray(b.messages) ? b.messages
    : (Array.isArray(b.input) ? b.input : (typeof b.input === 'string' && b.input ? [{ role: 'user', content: b.input }] : []));
  let lastUser = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && typeof m === 'object' && m.role === 'user') { lastUser = m; break; }
  }
  if (!lastUser) return [];
  const c = lastUser.content;
  if (typeof c === 'string') return [c];
  if (!Array.isArray(c)) return [];
  // 只收顶层文本块:Anthropic 的 type:'text' 与 Responses 的 type:'input_text'。
  // tool_result / thinking / document 等一律跳过:工具结果里引用过特征串,不等于这次请求是压缩。
  const text = x => x && typeof x === 'object' && (x.type === 'text' || x.type === 'input_text') && typeof x.text === 'string';
  return c.filter(text).map(x => x.text);
}

module.exports = {
  SESSION_LABEL,
  parseSessionId, bodySystemText, firstUserText,
  codexHeaderSessionId, codexBodySessionId, codexSystemText, codexUserTexts, codexFirstUserText,
  sessionIdentity, sessionLabel, looksInternal, applyLabel, sessionKeyOf, bodyRouteText, compactTexts,
};
