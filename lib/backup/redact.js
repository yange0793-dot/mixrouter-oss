'use strict';
// 凭据脱敏。给"备份差异预览"用:预览要能给人看,但**原文一个字节都不许进结果**。
//
// ------------------------------------------------ 与 lib/observability/request-log.js 的分工
// 这是**形状层**。它与 request-log.js 的 scrubSecrets(**已知值层**)是互补的两层,不是同一件事
// 的两份实现,也不是重复代码:
//
//   形状层(本模块)  输入 = 一棵已经解析好的值(JSON 树 / TOML 顶层值)。
//                    判据 = **键名**像凭据(key/token/secret…)或**值的样子**像凭据
//                    (sk-… / Bearer … / 长 hex / JWT / AWS / GitHub / Slack / GitLab / PEM)。
//                    它**不知道任何具体密钥**,所以能盖住两种已知值层盖不住的情形:
//                    (a) 密钥被写进了别的内容里(`headers = "Authorization: Bearer sk-…"`);
//                    (b) 我们手上根本没有这份密钥(别处配置里的、别人给的)。
//   已知值层(scrubSecrets)  输入 = 一段**文本** + 一个**已知密钥列表**。
//                    做的事 = 把这几个已知字符串在文本里换成 `[redacted]`。
//                    它只在有列表时起作用,但一旦起作用就是**精确**的:
//                    自定义格式的密钥(内网网关的 token 长什么样没人规定)形状判据全落空,
//                    只有这一层认得出。
//
// 也就是说:**按已知值替换只有一份实现,在 request-log.js 里**。本模块内**不存在**
// 同义的"遍历已知密钥逐个 split/join"逻辑,也**不许**再写一份 —— 两份同义实现迟早会漂,
// 而漂掉的那一份就是漏。本模块只做形状判断,它的输出(掩码体)再交给已知值层过一遍,
// 两层串联的落点在 lib/backup/compare.js 的 jsonCell / tomlCell(那里写了为什么两层都要上、
// 以及为什么次序是形状层先)。
//
// 两条判据,命中其一就脱敏(OR,不是 AND):
//   A. 键名像凭据:key / api_key / token / secret / auth / password / credential / bearer / cookie …
//   B. 值本身像凭据:sk-… / Bearer … / 长 hex / JWT / AWS / GitHub / Slack / GitLab / PEM 私钥 …
//
// 命中 A 时**整棵子树**按敏感处理(auth 下面的 user 也一起盖掉)。理由:凭据很少单独出现,
// 而"auth 底下哪个字段才是密码"没有可靠答案;猜错的代价是明文进了结果,猜过头的代价只是
// 少看一个用户名。这个方向选错一次就够了,所以往紧的一边倒。
//
// 掩码里**不含原值的任何字符**,连前缀都不留,只留长度:`sk-` 这种"看着无害的前缀"正是
// mixrouter.js maskKey 的写法(掐头 6 位 + 去尾 4 位),密钥短到 12 位以内就等于没盖。
// 长度不是秘密,前缀是。所以这里一个字节都不给。
//
// 已知假阳性(故意留着,不修):判据 A 会盖住 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 这类**计数**字段
// (名字里有 token);判据 B 的第二族会盖住"夹在长文本里的 32 位 hex"(例如一处被钉住的摘要值)。
// 两条都是各自判据的必然结果;要救回来就得加白名单,而白名单一漂就是漏洞。
// 每个被盖的结果都带 reason,调用方看得见"为什么被盖",要不要放宽由调用方决定。
// 判据 B 只认**已知形状**,不认识的自定义密钥只能靠判据 A 兜 —— 这是本模块公开的覆盖边界,
// 不假装全覆盖;那条路的兜底在已知值层,不在这里。

const MASKED_KEY = '[redacted-key]';
const MAX_DEPTH = 32;
const MAX_ITEMS = 500;

// 键名判据是**按词**比,不是整串 includes。`AUTHOR` 里含 `auth`、`MONKEY` 里含 `key`,
// 整串匹配会把它们一起盖掉;按非字母数字切成词之后这类误伤自然消失。
// 词表里的每一项都是一个"拿到就得盖"的词,不含 `session`/`id`/`name` 这类太宽的:
// 它们一进表,半个配置都会被盖住,预览就没得看了。
const SENSITIVE_TOKENS = new Set([
  'key', 'keys', 'apikey', 'privatekey', 'accesskey', 'secretkey', 'publickey',
  'token', 'tokens', 'secret', 'secrets', 'auth', 'authorization', 'authentication',
  'password', 'passwd', 'pwd', 'passphrase', 'credential', 'credentials',
  'bearer', 'cookie', 'cookies', 'signature', 'salt',
]);

// 值判据,两族。
// 第一族**带锚点**:"这个值整体就是一把凭据"。锚点在这里是必要的 —— 去掉锚点之后
// `long-hex` 会在任何含 32 位 hex 的字符串里命中,误伤面大得多。
const VALUE_RULES = Object.freeze([
  ['private-key-pem', /-----BEGIN[^-]*PRIVATE KEY-----/],
  ['bearer', /^Bearer\s+\S+/i],
  ['sk-key', /^sk-[A-Za-z0-9_-]{8,}$/],
  ['stripe-key', /^(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}$/],
  ['github-token', /^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{10,}$/],
  ['slack-token', /^xox[baprs]-[A-Za-z0-9-]{10,}$/],
  ['aws-access-key-id', /^(AKIA|ASIA)[0-9A-Z]{16}$/],
  ['google-api-key', /^AIza[0-9A-Za-z_-]{20,}$/],
  ['gitlab-token', /^glpat-[A-Za-z0-9_-]{10,}$/],
  ['huggingface-token', /^hf_[A-Za-z0-9]{20,}$/],
  ['npm-token', /^npm_[A-Za-z0-9]{20,}$/],
  ['jwt', /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}$/],
  ['long-hex', /^[0-9a-fA-F]{32,}$/],
]);

// 第二族**不带锚点**:"凭据被写进了别的内容里"。少了这一族就有一个现成的漏法 ——
// `headers = "Authorization: Bearer sk-…"` 这种值既不是"整体像凭据"(锚点判据全都落空),
// 键名也不敏感(`headers` 不在词表里),于是整行原样进结果。只在字符串**内部**找已知形状。
// 上面那族的锚点因此不能去掉:两族分工不同,不是同一套规则的松紧两档。
const EMBEDDED_RULES = Object.freeze([
  ['embedded-private-key-pem', /-----BEGIN[^-]*PRIVATE KEY-----/],
  ['embedded-bearer', /Bearer\s+\S{8,}/i],
  ['embedded-sk-key', /\bsk-[A-Za-z0-9_-]{8,}/],
  ['embedded-github-token', /\b(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{10,}/],
  ['embedded-slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['embedded-aws-key-id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['embedded-gitlab-token', /\bglpat-[A-Za-z0-9_-]{10,}/],
  ['embedded-jwt', /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/],
  ['embedded-long-hex', /\b[0-9a-fA-F]{32,}\b/],
]);

const keyTokens = key => String(key)
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')       // camelCase:apiKey -> api Key
  .split(/[^A-Za-z0-9]+/)
  .filter(Boolean)
  .map(t => t.toLowerCase());

function keyReason(key) {
  if (typeof key !== 'string' || !key) return null;
  for (const token of keyTokens(key)) if (SENSITIVE_TOKENS.has(token)) return `name:${token}`;
  return null;
}

function valueReason(value) {
  if (typeof value !== 'string' || !value) return null;
  for (const [id, re] of VALUE_RULES) if (re.test(value)) return `shape:${id}`;
  for (const [id, re] of EMBEDDED_RULES) if (re.test(value)) return `shape:${id}`;
  return null;
}

const leafType = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

// 掩码体:只有"被盖了"这个事实 + 为什么 + 长度,没有原值的任何字节。
function maskLeaf(value, reason) {
  const out = { redacted: true, reason, type: leafType(value) };
  if (typeof value === 'string') out.length = value.length;
  return out;
}

// 用 defineProperty 而不是 `out[k] = v`:JSON 里可以合法出现一个名叫 `__proto__` 的键
// (JSON.parse 会把它建成自有属性),而赋值语句会撞上原型上的 setter —— 那一行不但写不进
// 结果,还会顺手改掉 out 的原型。defineProperty 直接建自有属性,绕过 setter。
function defineKey(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

const noMask = value => ({ value, redacted: false, reason: null, masked: 0 });

// 容器遍历只写一遍,两条路径(逐项判断 / 整棵强盖)只差一个 mapChild。
function mapContainer(value, depth, seen, mapChild) {
  const next = new Set(seen);
  next.add(value);
  let masked = 0;
  let reason = null;
  const take = r => { masked += r.masked; if (!reason && r.reason) reason = r.reason; };
  if (Array.isArray(value)) {
    const out = [];
    const kept = value.slice(0, MAX_ITEMS);
    for (const item of kept) { const r = mapChild('', item, depth + 1, next); out.push(r.value); take(r); }
    // 超出上限的项收成一句话。不给个计数的话,"这个数组变短了"和"被截了"看起来一模一样。
    if (value.length > kept.length) out.push(`[+${value.length - kept.length} more]`);
    return { value: out, redacted: masked > 0, reason, masked };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const r = mapChild(k, v, depth + 1, next);
    // 键名自己也可能就是明文凭据(把 key 当值用的人确实存在),所以键名同样过一遍值判据。
    const leak = valueReason(k);
    if (leak) { defineKey(out, MASKED_KEY, r.value); masked += 1; if (!reason) reason = leak; }
    else defineKey(out, k, r.value);
    take(r);
  }
  return { value: out, redacted: masked > 0, reason, masked };
}

function redactValue(keyName, value, opts = {}) {
  const depth = opts.depth || 0;
  const seen = opts.seen || new Set();
  if (opts.forceReason) return maskTree(value, opts.forceReason, depth, seen);
  const nameHit = keyReason(keyName);
  if (nameHit) return maskTree(value, nameHit, depth, seen);
  // 值判据只在字符串叶子上判:"这个对象看起来像凭据"不是一句有意义的判据。
  if (typeof value === 'string') {
    const hit = valueReason(value);
    return hit ? { value: maskLeaf(value, hit), redacted: true, reason: hit, masked: 1 } : noMask(value);
  }
  if (value === null || typeof value !== 'object') return noMask(value);
  if (depth >= MAX_DEPTH) return { value: maskLeaf(value, 'max-depth'), redacted: true, reason: 'max-depth', masked: 0 };
  // 环检测用**当前路径栈**:同一个对象合法地出现在两个键下是值重复,不是环(与 request-log 同一条理由)。
  if (seen.has(value)) return { value: maskLeaf(value, 'circular'), redacted: true, reason: 'circular', masked: 0 };
  return mapContainer(value, depth, seen, (k, v, d, s) => redactValue(k, v, { depth: d, seen: s }));
}

// 整棵强盖:结构留着(看得见"这里有几个字段"),字符串叶子全换成掩码体。
//
// 非字符串标量**不盖**(数字/布尔/null 原样留下)。这是相对"键名命中就把整棵盖掉"的一处
// 有意收窄,理由:凭据一定是文本,一个 JSON 数字装不下一把密钥 —— 而把它一起盖掉,会把
// "max_output_tokens 从 32000 变成 64000" 这种**最该看见的变化**藏起来。判据 A 真正的用武之地
// 是"形状认不出来的字符串"(`"hunter2"` 挂在 `password` 下),那本来就是字符串的事。
// 收窄的是**类型**,不是键名表:同一个键名下只要是字符串,一律照盖。
function maskTree(value, reason, depth, seen) {
  if (typeof value === 'string') return { value: maskLeaf(value, reason), redacted: true, reason, masked: 1 };
  if (value === null || typeof value !== 'object') return { value, redacted: false, reason: null, masked: 0 };
  if (depth >= MAX_DEPTH) return { value: maskLeaf(value, 'max-depth'), redacted: true, reason: 'max-depth', masked: 0 };
  if (seen.has(value)) return { value: maskLeaf(value, 'circular'), redacted: true, reason: 'circular', masked: 0 };
  return mapContainer(value, depth, seen, (k, v, d, s) => maskTree(v, reason, d, s));
}

module.exports = {
  redactValue, maskTree, maskLeaf, keyReason, valueReason, keyTokens,
  MASKED_KEY, SENSITIVE_TOKENS, VALUE_RULES, EMBEDDED_RULES, MAX_DEPTH, MAX_ITEMS,
};
