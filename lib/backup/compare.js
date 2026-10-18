'use strict';
// 备份差异预览:**只读**,把一份备份与当前活文件按顶层键对照,给出 added / removed / changed。
//
// 方向约定(整个模块只有这一个方向,结果里也用 direction 再说一遍):
//   added   活文件有、备份没有   —— 备份之后**新增**的
//   removed 备份有、活文件没有   —— 备份之后**被删**的
//   changed 两边都有但值不同     from = 备份里的值(旧),to = 活文件里的值(新)
// 也就是说,这份输出回答的是"备份之后这个文件被改成了什么样"。
//
// 三件刻意做对的事:
//   1) 两边失败**分开报**。合并成一个 "parse error" 之后,调用方就没法回答"是备份坏了还是活文件坏了",
//      而这两个结论对应的动作正好相反(一个要护住备份,一个要先修活文件)。
//   2) 比较用**原文**,输出用**脱敏后的值**。拿脱敏后的值去比会得出"两把不同的密钥没有变化"
//      (掩码体长得一样),那是最坏的一种错:预览说没事,实际换了 key。
//   3) 截断排在脱敏**之后**。反过来会把一个横跨截断点的长密钥切成两半,后半段原样漏出去
//      (与 lib/observability/request-log.js 文件头第 2 条同一条理由)。
//
// 脱敏是**两层**,不是一个函数(分工与输入契约详见 lib/backup/redact.js 文件头):
//   · 已知值层:lib/observability/request-log.js 的 scrubSecrets(text, secrets) —— 把**我们
//     已经知道是密钥的那些字符串**从文本里换成 [redacted]。它只有拿着密钥列表时才起作用。
//   · 形状层:lib/backup/redact.js —— 按**键名与值的样子**判(键名像 key/token/secret、
//     值像 sk-… / Bearer … / JWT / PEM)。它不知道任何具体密钥,所以能盖住"密钥自己写在
//     别的内容里"和"我们手上根本没有这份密钥"两种情形。
// 两层都要上的理由:任何一层单独都在**已知的**输入上有一个现成的漏法 ——
//   · 只有已知值层:调用方给的 secrets 不全(它从哪拿到全量密钥?配置里可能存着别处的 key),
//     一个形状完全标准的 sk-… 就原样进结果。
//   · 只有形状层:自定义格式的密钥(内网网关的 token 长什么样没人规定)形状判据全落空,
//      而调用方明明已经知道那串是什么 —— 知道却不盖,没有理由。
// 两层都不是"备选实现",所以只保留一份**按已知值替换**的代码(在 request-log.js 里),
// 本模块不另写一份:两份同义实现迟早会漂,而漂掉的那一份就是漏。
// 次序是**形状层先、已知值层后**(jsonCell / tomlCell 里各写了一遍理由)。两者的作用集合不相交:
// 形状层盖过的地方结果里一个字符串都不剩(只剩 reason 与长度),后跑的已知值层在那里是空操作;
// 反过来先跑已知值层,一个既长得像 sk-… 又是已知密钥的值会先被压成常量 [redacted],
// 形状层再也看不出它本来是什么,而"为什么被盖"就少了一半信息。
//
// 覆盖边界(写在代码里,不靠 README):TOML 只取**顶层键**,第一个 [section] 之后一律不看;
// 值比较用"原文规范化"(去空白、去注释、把无转义的 basic/literal string 归一),不是 spec 完整的
// TOML 语义 —— 所以 `x = 1` 与 `x = 1.0` 会被报成 changed。这是**预览级**比较器,不是解析器。
// JSON 侧遇到带注释/BOM/尾逗号的文件会退一步做去噪解析,并在结果里标 lenient=true。

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { describeType, readBackup } = require('./inventory');
const { keyReason, valueReason, maskLeaf, redactValue } = require('./redact');
const { scrubSecrets } = require('../observability/request-log');

const DEFAULT_MAX_BYTES = 1024 * 1024;
const TOML_VALUE_MAX_CHARS = 200;

const stripBom = text => (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------- 读文件
// 活文件与备份的读取策略**故意不同**:
//   活文件 follow 符号链接 —— 把 ~/.claude/settings.json 软链到 dotfiles 仓库是常见做法,
//     在只读预览里把它判成"非法文件"只会挡住正当用法;
//   备份 lstat + O_NOFOLLOW —— 备份是我们自己 copyFileSync 出来的常规文件,任何别的形态都不是它,
//     读它等于把一个来源不明的流喂给调用方。
// 这条不对称写进结果(sides.live.symlink),不留给读代码的人自己去发现。
function readLiveFile(file, maxBytes) {
  let before;
  try { before = fs.lstatSync(file); }
  catch (e) { return { ok: false, reason: e.code === 'ENOENT' ? 'missing' : 'stat-failed', code: e.code }; }
  let st;
  try { st = fs.statSync(file); }                        // 跟随符号链接之后再判类型
  catch (e) { return { ok: false, reason: e.code === 'ENOENT' ? 'missing' : 'stat-failed', code: e.code }; }
  if (!st.isFile()) return { ok: false, reason: 'not-a-regular-file', type: describeType(st) };
  const want = Math.min(maxBytes, Number(st.size));
  const fd = fs.openSync(file, fs.constants.O_RDONLY);
  try {
    const buf = Buffer.allocUnsafe(want);
    let got = 0;
    while (got < want) {
      const n = fs.readSync(fd, buf, got, want - got, got);
      if (n <= 0) break;
      got += n;
    }
    return {
      ok: true, text: buf.subarray(0, got).toString('utf8'), bytes: got, size: Number(st.size),
      truncated: Number(st.size) > maxBytes, symlink: before.isSymbolicLink(),
      mode: st.mode & 0o777, mtimeMs: st.mtimeMs,
    };
  } finally { fs.closeSync(fd); }
}

function readBackupSide(file, maxBytes) {
  try {
    const r = readBackup({ path: file, maxBytes });
    return {
      ok: true, text: r.text, bytes: r.bytesRead, size: r.size, truncated: r.truncated,
      symlink: false, mode: r.mode, mtimeMs: r.mtimeMs, binary: r.binary, sha256: r.sha256,
    };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, reason: 'missing', code: e.code };
    if (e.code === 'E_NOT_REGULAR_FILE') return { ok: false, reason: 'not-a-regular-file', type: e.type, code: e.code };
    return { ok: false, reason: 'read-failed', code: e.code, message: e.message };
  }
}

// ---------------------------------------------------------------- 形状判定
function stripTomlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#') return line.slice(0, i);
  }
  return line;
}

// 这段文本把括号开到哪里(字符串与注释都不算)。多行数组/内联表靠它续行。
function bracketDepth(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#') break;
    if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') depth -= 1;
  }
  return depth;
}

function sniffFormat(text) {
  const t = stripBom(String(text == null ? '' : text)).trim();
  if (!t) return null;
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  for (const line of t.split('\n')) {
    const s = stripTomlComment(line).trim();
    if (!s) continue;
    if (s.startsWith('[')) return 'toml';              // 有 section,只可能是 toml
    if (/^[A-Za-z0-9_"'-]/.test(s) && s.includes('=')) return 'toml';
    return null;                                       // 首行既不是 JSON 也不是 toml 键值对
  }
  return null;
}

const EXT_FORMAT = { '.json': 'json', '.jsonc': 'json', '.toml': 'toml' };

// ---------------------------------------------------------------- JSON 侧
// 去噪:注释与尾逗号。**一次扫描同时处理两件事**,而不是"先用正则删注释、再删尾逗号" ——
// 两步各自都要判断"我在不在字符串里",分开写必然有一遍写错,而写错的那遍会把字符串里的
// `, }` 当成尾逗号删掉,静默改写一个值。
function stripJsonNoise(text) {
  let out = '';
  let i = 0;
  let inString = false;
  let changed = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < n) { out += text[i + 1]; i += 2; continue; }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') { inString = true; out += c; i += 1; continue; }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl;                 // 换行留着,后面报错的行号才不会整体前移
      changed = true;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 ? n : close + 2;
      for (let k = i; k < stop; k++) if (text[k] === '\n') out += '\n';   // 块注释里的换行按原个数补回
      i = stop;
      changed = true;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') { i += 1; changed = true; continue; }
    }
    out += c;
    i += 1;
  }
  return { text: out, changed };
}

function parseJsonText(raw) {
  const text = stripBom(String(raw == null ? '' : raw));
  // 空文件按 {} 处理 —— 与 mixrouter.js readClientConfig 同一条语义:空 ≠ 坏。
  if (!text.trim()) return { ok: true, top: {}, lenient: false, empty: true };
  try { return { ok: true, top: JSON.parse(text), lenient: false, empty: false }; }
  catch (strictError) {
    // 严格解析失败才去噪重试。带注释/尾逗号的 settings.json 正是这个工具最该看懂的东西:
    // mixrouter.js 遇到它们会拒绝写入,用户来这里就是想知道"到底差在哪"。
    const noise = stripJsonNoise(text);
    if (noise.changed) {
      try { return { ok: true, top: JSON.parse(noise.text), lenient: true, empty: false }; }
      catch (lenientError) {
        return { ok: false, reason: 'parse-error', message: lenientError.message, strictMessage: strictError.message, lenientAttempted: true };
      }
    }
    return { ok: false, reason: 'parse-error', message: strictError.message, lenientAttempted: false };
  }
}

// ---------------------------------------------------------------- TOML 侧
// 只取顶层键 = 第一个 [section] 之前的键值对。section 里的东西(渠道 section)不参与对照:
// "顶层键被改回原样"才是这个文件被切坏时最直接的症状。
// 多行值(数组跨行)必须续上:不续的话 `x = [` 会存成一个残值,而两边都残得一样,
// 于是"这里明明改了"被报成没改 —— 漏报比误报更坏。
function parseTomlTopLevel(raw) {
  const text = stripBom(String(raw == null ? '' : raw));
  const top = new Map();
  const problems = [];
  let sawSection = false;
  let pending = null;
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo += 1;
    if (pending) {
      const cont = stripTomlComment(line);
      pending.raw += '\n' + cont;
      pending.depth += bracketDepth(cont);
      if (pending.depth <= 0) { top.set(pending.key, pending.raw.trim()); pending = null; }
      continue;
    }
    const bare = stripTomlComment(line);
    if (!bare.trim()) continue;
    if (/^\s*\[/.test(bare)) { sawSection = true; continue; }
    if (sawSection) continue;
    const m = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)\s*=\s*([\s\S]*)$/.exec(bare);
    // 顶层出现既不是 section 也不是键值对的行:不猜,记下来(文件可能已经坏了)
    if (!m) { problems.push({ line: lineNo, text: line.trim().slice(0, 80) }); continue; }
    const key = unquoteTomlKey(m[1]);
    const value = m[2];
    const depth = bracketDepth(value);
    if (depth > 0) pending = { key, raw: value, depth };
    else top.set(key, value.trim());
  }
  // 文件在中途结束 = 值没闭合。留下一截比丢掉整个键更接近事实,但要说出来。
  if (pending) { top.set(pending.key, pending.raw.trim()); problems.push({ line: lineNo, text: '未闭合的多行值' }); }
  return { ok: true, top, problems, empty: !text.trim() };
}

function unquoteTomlKey(key) {
  const t = key.trim();
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2)
    || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) return t.slice(1, -1);
  // 点分键按**原样**归一(只吃掉点两侧空白),不展开成嵌套表:
  // 展开就要先回答"a.b 与 [a] 下的 b 算不算同一个键",而这个问题本工具不回答。
  return t.replace(/\s*\.\s*/g, '.');
}

// 值比较键。无转义的 basic string 与 literal string 语义相同("x" 与 'x'),归一掉;
// 带转义的、以及其它一切形式一律按原文比 —— 不解析就不知道它等于什么,不知道就不要猜。
function normalizeTomlValue(raw) {
  const t = String(raw == null ? '' : raw).trim();
  const basic = /^"([^"\\]*)"$/.exec(t);
  if (basic) return `str:${basic[1]}`;
  const literal = /^'([^']*)'$/.exec(t);
  if (literal) return `str:${literal[1]}`;
  return `raw:${t}`;
}

// ---------------------------------------------------------------- 单元格
// 脱敏出口。**只有这一个出口** —— added / removed / changed 三条路径都从这里走,
// 所以"两层都上了"这件事只需要在这里成立一次。
//
// 本模块**没有**自己写"按已知值替换":那一份实现在 lib/observability/request-log.js 的
// scrubSecrets,这里 require 过来用。同一个语义有第二份实现,就等于多一处会漂、会漏的地方。
//
// 两层的执行次序是**形状层先、已知值层后**,理由是可证明的"作用集合不相交":
//   · 形状层(maskLeaf / maskTree)盖过的地方,结果里**一个字符串都不剩**(只剩 reason 与长度),
//     所以后跑的已知值层在那里的替换是空操作 —— 一个叶子不可能被两层各记一次账。
//   · 反过来先跑已知值层,一个既长得像 sk-… 又是我们已知密钥的值会先被换成常量 [redacted],
//     形状层再也看不出它是什么,于是"这个值为什么被盖"只剩一个含糊的答案;
//     而先跑形状层,同一个值会拿到完整的掩码体(reason + 长度),信息更多、也不留原文。
// 两层都**必须**在,因为任何一层单独都在已知输入上有一个现成的漏法:
//   · 只有形状层:自定义格式的密钥(内网网关的 token 长什么样没人规定)形状判据全落空,
//     而调用方明明已经知道那串是什么 —— 知道却不盖,没有理由。
//   · 只有已知值层:调用方给的 secrets 不可能全(它从哪拿到全量?配置里可能存着别处的 key),
//     一个形状完全标准的 sk-… 就原样进结果。
//
// 已知值层作用在**整棵树**上,不只是顶层字符串:密钥嵌在 env / headers 这类对象里是最常见的
// 形态,只在顶层替换的实现会让"两层都上了"这句话只在上半层成立。
//
// 已知值列表**先长后短**排序后才交给 scrubSecrets。理由是一条真实的漏法:
// 短串先替换会吃掉长串的前缀 —— 已知 ["sk-abcd", "sk-abcdefgh"] 时,先把 "sk-abcd" 换掉就得到
// "[redacted]efgh",长串再也匹配不上,尾巴 "efgh" 原样留了下来。request-log.js 里的
// normalizeSecrets 做的是同一件事(它是内部函数,没在导出面上),这里按同一条规则归一。
function normalizeSecretList(secrets) {
  if (!secrets) return [];
  const list = typeof secrets === 'string' ? [secrets] : [...secrets];
  return list.filter(s => typeof s === 'string' && s.length > 0).sort((a, b) => b.length - a.length);
}

// 已知值层。输入是**形状层的产物**:那里没有环,深度也已被形状层自己限死,所以这里是一个
// 平凡的树遍历;键名一并过一遍 —— 把密钥当键名用的人确实存在。
function applyKnownValues(value, secrets) {
  if (!secrets.length) return { value, masked: 0 };
  if (typeof value === 'string') {
    const out = scrubSecrets(value, secrets);
    return out === value ? { value, masked: 0 } : { value: out, masked: 1 };
  }
  if (value === null || typeof value !== 'object') return { value, masked: 0 };
  let masked = 0;
  if (Array.isArray(value)) {
    const out = value.map(item => { const r = applyKnownValues(item, secrets); masked += r.masked; return r.value; });
    return masked ? { value: out, masked } : { value, masked: 0 };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const r = applyKnownValues(v, secrets);
    masked += r.masked;
    const key = scrubSecrets(k, secrets);
    if (key !== k) masked += 1;
    // defineProperty 而不是赋值:`__proto__` 是 JSON 里合法出现的键名,
    // 赋值语句会撞上原型 setter(与 redact.js 的 defineKey 同一条理由)。
    Object.defineProperty(out, key, { value: r.value, enumerable: true, writable: true, configurable: true });
  }
  return masked ? { value: out, masked } : { value, masked: 0 };
}

function jsonCell(key, value, secrets) {
  const shape = redactValue(key, value);
  const known = applyKnownValues(shape.value, secrets);
  return {
    value: known.value,
    redacted: shape.redacted || known.masked > 0,
    reason: shape.reason || (known.masked ? 'known-secret' : null),
    masked: shape.masked + known.masked,
  };
}

function tomlCell(key, raw, secrets) {
  const text = String(raw == null ? '' : raw).trim();
  // 形状层判据看的是**完整原文**,不是截断后的片段 —— 先截再判的话,一个横跨 200 字的长密钥
  // 会在截断之后就匹配不上任何形状判据,然后整段原样进结果。
  const reason = keyReason(key) || valueReason(text);
  if (reason) return { value: maskLeaf(text, reason), redacted: true, reason, masked: 1 };
  // 已知值层:形状认不出的自定义密钥靠它。替换之后才轮到截断 —— 次序反了的话,
  // 一把横跨截断点的已知密钥会被先切掉一半,剩下那半段既匹配不上判据、也不再等于那把密钥。
  const scrubbed = secrets.length ? scrubSecrets(text, secrets) : text;
  if (scrubbed !== text) {
    const chars = [...scrubbed];
    const cut = chars.length > TOML_VALUE_MAX_CHARS;
    return { value: cut ? chars.slice(0, TOML_VALUE_MAX_CHARS).join('') : scrubbed, redacted: true, reason: 'known-secret', masked: 1, truncated: cut };
  }
  const chars = [...text];
  const cut = chars.length > TOML_VALUE_MAX_CHARS;
  return { value: cut ? chars.slice(0, TOML_VALUE_MAX_CHARS).join('') : text, redacted: false, reason: null, masked: 0, truncated: cut };
}

// masked 只在聚合里报,不散在每条上:每条都带的话,"总共盖了几个叶子"就变成调用方自己加总的事。
const strip = cell => { const { masked, ...rest } = cell; return rest; };
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// JSON 与 TOML 的 added/removed/changed 只写一遍。两个形状各写一遍的话,迟早有一边的方向
// 写反,而方向写反是最不容易被发现的错:数量对、名字对、含义反了。
function diffKeys(liveKeys, liveValue, backupKeys, backupValue, cell, same) {
  const liveSet = new Set(liveKeys);
  const backupSet = new Set(backupKeys);
  const added = [];
  const removed = [];
  const changed = [];
  for (const key of liveKeys) {
    if (!backupSet.has(key)) { added.push({ key, ...strip(cell(key, liveValue(key))) }); continue; }
    // 比较用**原文**:same() 拿的是未经脱敏的 liveValue/backupValue。掩码只作用在写进结果的
    // from/to 上。这一行是"预览说没变化、实际换了 key"那条最坏的错的唯一防线。
    if (!same(liveValue(key), backupValue(key))) {
      changed.push({ key, from: strip(cell(key, backupValue(key))), to: strip(cell(key, liveValue(key))) });
    }
  }
  for (const key of backupKeys) {
    if (!liveSet.has(key)) removed.push({ key, ...strip(cell(key, backupValue(key))) });
  }
  return { added: added.sort(byKey), removed: removed.sort(byKey), changed: changed.sort(byKey) };
}

// ---------------------------------------------------------------- 主入口
function compareWithLive(options = {}) {
  const { file, backupPath, format: formatOpt, maxBytes = DEFAULT_MAX_BYTES } = options;
  if (typeof file !== 'string' || !file) throw new TypeError(`compareWithLive: file 必须是非空字符串,实得 ${JSON.stringify(file)}`);
  if (typeof backupPath !== 'string' || !backupPath) throw new TypeError(`compareWithLive: backupPath 必须是非空字符串,实得 ${JSON.stringify(backupPath)}`);
  if (formatOpt !== undefined && formatOpt !== 'json' && formatOpt !== 'toml') throw new RangeError(`compareWithLive: format 只能是 json/toml,实得 ${JSON.stringify(formatOpt)}`);
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError(`compareWithLive: maxBytes 必须是正整数,实得 ${JSON.stringify(maxBytes)}`);

  // 已知值层用的密钥列表。归一在这里做一次,下面的 cell 不用每条各归一一次(那是每条各排一次序)。
  const secrets = normalizeSecretList(options.secrets);

  const notes = [];
  const liveRead = readLiveFile(file, maxBytes);
  const backupRead = readBackupSide(backupPath, maxBytes);

  const fmt = resolveFormat({ file, formatOpt, liveRead, backupRead });
  if (!fmt.format) {
    return finish({
      file, backupPath, format: null, ok: false, identical: false, notes,
      errors: { format: fmt, live: null, backup: null },
      sides: { live: null, backup: null }, keys: null, diff: emptyDiff(),
      redaction: { masked: 0, byReason: {} },
    });
  }
  const format = fmt.format;

  if (liveRead.ok && liveRead.truncated) notes.push({ id: 'live-truncated', message: `活文件超过 maxBytes(${maxBytes}),只解析了前 ${liveRead.bytes} 字节` });
  if (backupRead.ok && backupRead.truncated) notes.push({ id: 'backup-truncated', message: `备份超过 maxBytes(${maxBytes}),只解析了前 ${backupRead.bytes} 字节` });
  if (liveRead.ok && liveRead.symlink) notes.push({ id: 'live-symlink', message: '活文件是符号链接,已跟随(备份侧不跟随)' });
  if (backupRead.ok && backupRead.binary) notes.push({ id: 'backup-binary', message: '备份不是 UTF-8 文本,解析结论不可信' });

  const base = path.basename(file);
  const backupBase = path.basename(backupPath);
  if (backupBase !== base && !backupBase.startsWith(`${base}.bak-mixui-`)) {
    notes.push({ id: 'mismatched-base', message: `备份名 ${backupBase} 不像 ${base} 的备份(比对仍照做,但两边可能根本不是同一个文件)` });
  }

  const liveParse = liveRead.ok ? parseSide(format, liveRead.text) : null;
  const backupParse = backupRead.ok ? parseSide(format, backupRead.text) : null;
  if (liveParse && liveParse.ok && liveParse.lenient) notes.push({ id: 'live-lenient-json', message: '活文件严格 JSON 解析失败(注释/BOM/尾逗号),已去噪后解析' });
  if (backupParse && backupParse.ok && backupParse.lenient) notes.push({ id: 'backup-lenient-json', message: '备份严格 JSON 解析失败(注释/BOM/尾逗号),已去噪后解析' });
  if (liveParse && liveParse.problems && liveParse.problems.length) notes.push({ id: 'live-toml-problems', message: `活文件里有 ${liveParse.problems.length} 行没被认成顶层键值对` });
  if (backupParse && backupParse.problems && backupParse.problems.length) notes.push({ id: 'backup-toml-problems', message: `备份里有 ${backupParse.problems.length} 行没被认成顶层键值对` });

  const errors = {
    format: null,
    live: sideError(liveRead, liveParse),
    backup: sideError(backupRead, backupParse),
  };

  // 解析报错的 message 会把出错点附近的**原文**抄进去(V8 的 "Unexpected token 'o',
  // \"...\\\"90\\\", \\\"z\\\": oops}\" is not valid JSON" 就是这种形状)。原样放进 errors.*,
  // 一个"备份预览报错"就把活文件里那一段打进了控制台 —— 而预览存在的意义恰恰是不让人看见原文。
  // 两道处理,缺一不可:
  //   1) 摘掉 V8 回显的那一段。已知值层在这里**不够用**:它只能替换整把已知密钥,
  //      而被抄出来的是"出错点周围的短窗口"(实测 Node 24.18.0 下最长 10 个字符),
  //      是原值的一个**片段** —— 片段不等于任何一把已知密钥,替换不上,照样漏。
  //      位置信息(position / line / column)与错因描述全部保留,丢的只有回显。
  //   2) 已知值层再过一遍:出错点恰好落在一把已知密钥**中间**时,回显窗口可能完整包含它。
  // 两道都做过的痕迹写进 notes —— "这条报错怎么和原文不一样"不该让人去猜。
  for (const side of ['live', 'backup']) {
    const e = errors[side];
    if (!e) continue;
    let trimmed = false;
    let scrubbed = false;
    for (const field of ['message', 'strictMessage']) {
      if (typeof e[field] !== 'string') continue;
      const cut = stripErrorEcho(e[field]);
      if (cut !== e[field]) { e[field] = cut; trimmed = true; }
      if (secrets.length) {
        const out = scrubSecrets(e[field], secrets);
        if (out !== e[field]) { e[field] = out; scrubbed = true; }
      }
    }
    if (trimmed) notes.push({ id: `${side}-error-trimmed`, message: `${side} 侧解析报错里 V8 回显的原文片段已摘掉(位置与错因保留)` });
    if (scrubbed) notes.push({ id: `${side}-error-redacted`, message: `${side} 侧解析报错里含有已知密钥,已替换` });
  }

  let keys = null;
  let diff = emptyDiff();
  if (!errors.live && !errors.backup) {
    if (format === 'json') {
      const liveTop = liveParse.value;
      const backupTop = backupParse.value;
      keys = { live: Object.keys(liveTop).sort(), backup: Object.keys(backupTop).sort() };
      diff = diffKeys(keys.live, k => liveTop[k], keys.backup, k => backupTop[k],
        (k, v) => jsonCell(k, v, secrets), (a, b) => isDeepStrictEqual(a, b));
    } else {
      const liveTop = liveParse.value;
      const backupTop = backupParse.value;
      keys = { live: [...liveTop.keys()].sort(), backup: [...backupTop.keys()].sort() };
      diff = diffKeys(keys.live, k => liveTop.get(k), keys.backup, k => backupTop.get(k),
        (k, v) => tomlCell(k, v, secrets), (a, b) => normalizeTomlValue(a) === normalizeTomlValue(b));
    }
  }

  const byReason = {};
  let masked = 0;
  const tally = entry => {
    if (!entry.redacted) return;
    masked += 1;
    const reason = entry.reason || 'unknown';
    byReason[reason] = (byReason[reason] || 0) + 1;
  };
  for (const entry of [...diff.added, ...diff.removed]) tally(entry);
  for (const entry of diff.changed) { tally(entry.from); tally(entry.to); }

  const ok = !errors.live && !errors.backup;
  return finish({
    file, backupPath, format,
    ok,
    identical: ok && !diff.added.length && !diff.removed.length && !diff.changed.length,
    errors,
    sides: { live: liveRead.ok ? sideSummary(liveRead) : null, backup: backupRead.ok ? sideSummary(backupRead) : null },
    keys, diff, notes,
    redaction: { masked, byReason },
  });
}

const emptyDiff = () => ({ added: [], removed: [], changed: [] });

// 返回 { format } 表示定了形状;返回 { reason, ... } 表示定不了(调用方把整个对象放进
// errors.format 原样报出去)。刻意不用异常:形状问题要和"某一边坏了"一样是结构化输出。
function resolveFormat({ file, formatOpt, liveRead, backupRead }) {
  if (formatOpt) return { format: formatOpt };
  const byExt = EXT_FORMAT[path.extname(file).toLowerCase()];
  if (byExt) return { format: byExt };
  const sniffLive = liveRead.ok ? sniffFormat(liveRead.text) : null;
  const sniffBackup = backupRead.ok ? sniffFormat(backupRead.text) : null;
  if (sniffLive && sniffBackup) {
    return sniffLive === sniffBackup ? { format: sniffLive }
      : { reason: 'format-mismatch', live: sniffLive, backup: sniffBackup };
  }
  const only = sniffLive || sniffBackup;
  if (only) return { format: only };
  return { reason: 'format-undetermined' };
}

function parseSide(format, text) {
  if (format === 'json') {
    const r = parseJsonText(text);
    if (!r.ok) {
      return { ok: false, reason: r.reason, message: r.message, strictMessage: r.strictMessage, lenientAttempted: r.lenientAttempted };
    }
    // 顶层不是对象就没法"按顶层键"比。这不是解析失败,是形状不支持 —— 单独一个 reason,
    // 否则会把人推去查语法,而语法一点问题都没有。
    if (!isPlainObject(r.top)) {
      return { ok: false, reason: 'root-not-object', type: r.top === null ? 'null' : Array.isArray(r.top) ? 'array' : typeof r.top };
    }
    return { ok: true, value: r.top, lenient: r.lenient, empty: r.empty };
  }
  const r = parseTomlTopLevel(text);
  return { ok: true, value: r.top, lenient: false, empty: r.empty, problems: r.problems };
}

// V8 把出错点附近的原文塞在 message 的**一对双引号之间**。整段摘掉,只留一个省略号:
// 报错的诊断价值在 "Unexpected token 'o'... at position N (line L column C)" 那一半,
// 回显的那一截对它没有任何贡献。用贪婪匹配(第一个引号到最后一个引号)是有意的 ——
// 回显里本身就可能带引号(它抄的是一段 JSON),非贪婪会在第一个内层引号处收手,剩下的照漏。
const ERROR_ECHO_RE = /"[\s\S]*"/;
function stripErrorEcho(message) {
  return message.replace(ERROR_ECHO_RE, '"…"');
}

// 每边只报第一个失败:读都读不成,再报一条"解析也没成功"只是噪音。
// reason 保持稳定标识符,message 才是给人看的 —— 调用方按 reason 分支,不按文案分支。
function sideError(read, parsed) {
  if (!read.ok) return { reason: read.reason, code: read.code || null, type: read.type || null };
  if (!parsed.ok) {
    return {
      reason: parsed.reason, message: parsed.message || null, strictMessage: parsed.strictMessage || null,
      lenientAttempted: !!parsed.lenientAttempted, truncated: !!read.truncated,
    };
  }
  return null;
}

const sideSummary = read => ({
  bytes: read.bytes, size: read.size, truncated: read.truncated, binary: !!read.binary,
  symlink: !!read.symlink, mode: read.mode, mtimeMs: read.mtimeMs, sha256: read.sha256 || null,
});

function finish(result) {
  const { diff, ...rest } = result;
  return {
    ...rest,
    added: diff.added, removed: diff.removed, changed: diff.changed,
    direction: {
      added: 'live-only(备份之后新增)',
      removed: 'backup-only(备份之后被删)',
      changed: 'from=备份(旧) to=活文件(新)',
    },
  };
}

module.exports = {
  compareWithLive, sniffFormat, parseJsonText, parseTomlTopLevel, stripJsonNoise,
  normalizeTomlValue, stripTomlComment, bracketDepth, resolveFormat, normalizeSecretList, stripErrorEcho,
  DEFAULT_MAX_BYTES, TOML_VALUE_MAX_CHARS, EXT_FORMAT,
};
