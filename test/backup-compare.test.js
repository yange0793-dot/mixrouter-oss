'use strict';
// 差异预览(compare.js)与脱敏(redact.js / request-log.js 的 scrubSecrets)的回归。
//
// 这一组围绕两条不能反的次序:
//   1) **比较用原文,输出用脱敏后的值**。拿脱敏后的值去比,两把不同的密钥会长得一样
//      (掩码体只带 reason 与长度),于是"预览说没变化、实际换了 key" —— 最坏的一种错。
//   2) **脱敏在截断之前**。反过来会把一个横跨截断点的长密钥切成两半,后半段原样漏出去。
//
// 哨兵断言是这一组的主线:往输入里放唯一字符串,断言输出文本里搜不到,并且掩码里
// **不含原值任何前缀**(长度保留)。只断言"含 [redacted] 字样"是查不出漏的 ——
// 一个把原值原样带上的实现照样含有那个字样。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  compareWithLive, parseJsonText,
  normalizeTomlValue, stripTomlComment, bracketDepth, TOML_VALUE_MAX_CHARS, stripErrorEcho,
} = require('../lib/backup/compare');
const {
  redactValue, maskTree, maskLeaf, keyReason, keyTokens, MASKED_KEY, VALUE_RULES, EMBEDDED_RULES,
} = require('../lib/backup/redact');
const { scrubSecrets, REDACTED } = require('../lib/observability/request-log');
const { backupPrefix } = require('../lib/backup/naming');

const BASE = 'settings.json';
const PRE = backupPrefix(BASE);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-bak-cmp-'));

const tmpdir = () => fs.mkdtempSync(path.join(TMP, 'c-'));
const write = (dir, name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };

// 唯一哨兵。`SENTINEL-SECRET-` + 一次性随机,保证它与仓库里任何真实字符串都不撞。
const sentinel = tag => `SENTINEL-SECRET-${tag}-${crypto.randomBytes(8).toString('hex')}`;
// 形状判据(判据 B)认得的假 key:`sk-` + ≥8 位
const fakeSk = tag => `sk-live${crypto.randomBytes(9).toString('hex')}`;
const fakeBearer = tag => `Bearer ${crypto.randomBytes(12).toString('hex')}`;
const fakeJwt = () => `${'eyJhbGciOiJIUzI1NiJ9'}.${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(6).toString('base64url')}`;
const fakePem = () => `-----BEGIN RSA PRIVATE KEY-----\n${crypto.randomBytes(24).toString('base64')}\n-----END RSA PRIVATE KEY-----`;

// 输出里不许出现的片段:哨兵本体、哨兵的任意 8 字符以上子串、以及形状判据认得的 key 本体。
// 只查整串是不够的 —— 一个"掐头 6 位去尾 4 位"的掩码(mixrouter.js maskKey 的写法)会把
// 中间大半段留在结果里,整串查不到,信息却漏了。
function assertNoLeak(serialized, needles, label) {
  const text = typeof serialized === 'string' ? serialized : JSON.stringify(serialized);
  for (const needle of needles) {
    assert.ok(!text.includes(needle), `${label}: 输出里出现了原值 ${needle}`);
    for (let n = 8; n <= needle.length; n++) {
      for (let i = 0; i + n <= needle.length; i++) {
        const frag = needle.slice(i, i + n);
        assert.ok(!text.includes(frag), `${label}: 输出里出现了原值的子串 ${JSON.stringify(frag)}(长度 > 7 的片段一律不许留)`);
      }
    }
  }
  return text;
}

// ---------------------------------------------------------------- 脱敏两层:分工
test('redact: 掩码只带 reason 与长度,不含原值的任何字节', () => {
  const s = sentinel('mask');
  const leaf = maskLeaf(s, 'shape:sk-key');
  assert.deepEqual(leaf, { redacted: true, reason: 'shape:sk-key', type: 'string', length: s.length });
  assert.equal(leaf.length, s.length, '长度不是秘密,保留');
  assertNoLeak(leaf, [s], 'maskLeaf');

  // 形状层:sk- 形状即使挂在无害键名下也被盖上
  const sk = fakeSk('a');
  const r = redactValue('note', sk);
  assert.equal(r.redacted, true);
  assert.equal(r.reason, 'shape:sk-key');
  assert.equal(r.value.length, sk.length);

  // 已知值层:形状认不出来的自定义密钥,由 scrubSecrets 按**已知值**盖。
  // 两层互补的证据就在这两行上:同一个值,redact 层放过,scrubSecrets 层拦住。
  const custom = sentinel('custom');
  assert.equal(redactValue('note', custom).redacted, false, '形状层认不出自定义密钥,这是它公开的覆盖边界');
  assert.equal(scrubSecrets(`x=${custom}`, [custom]), `x=${REDACTED}`);
});

test('redact: 键名判据按词比,同一个键名下字符串一律盖、非字符串标量不盖', () => {
  // 键名按词从左往右扫,第一个命中的词就是答案:ANTHROPIC_AUTH_TOKEN 里 auth 在 token 之前,
  // 所以这里得到 name:auth。要紧的不是命中哪一个词(两者都在词表里、都该盖),
  // 而是**命中**了 —— 所以断言只钉"是 name: 开头",不把词序也钉死。
  assert.match(keyReason('ANTHROPIC_AUTH_TOKEN'), /^name:(auth|token)$/);
  assert.equal(keyReason('apiKey'), 'name:key', 'camelCase 要能切出 key');
  assert.equal(keyReason('MONKEY'), null, '整串 includes 会误伤 MONKEY,按词比就不会');
  assert.equal(keyReason('AUTHOR'), null, 'AUTHOR 里含 auth 同理');
  assert.deepEqual(keyTokens('apiKeyName'), ['api', 'key', 'name']);

  const s = sentinel('subtree');
  const tree = maskTree({ user: s, count: 7, flag: true, nothing: null }, 'name:auth', 0, new Set());
  assert.equal(tree.redacted, true);
  assert.equal(tree.value.user.redacted, true);
  assert.equal(tree.value.count, 7, '数字不盖:max_output_tokens 从 32000 变 64000 是最该看见的变化');
  assert.equal(tree.value.flag, true);
  assert.equal(tree.value.nothing, null);
  assertNoLeak(tree.value, [s], 'maskTree');

  // 键名**自己**是明文凭据(把 key 当值用的人确实存在):键名过值判据,换成 MASKED_KEY
  const asKey = redactValue('', { [fakeSk('k')]: 1 });
  assert.ok(MASKED_KEY in asKey.value, '键名形如凭据时要换成掩码键名');
  assertNoLeak(asKey.value, [], '键名');

  // __proto__ 作为键名:JSON.parse 会把它建成自有属性,赋值语句会撞原型 setter
  const proto = redactValue('', JSON.parse('{"__proto__":{"sk":"' + fakeSk('p') + '"}}'));
  assert.equal(Object.getPrototypeOf(proto.value), Object.prototype, '不得改掉结果的原型');
  assert.ok(Object.prototype.hasOwnProperty.call(proto.value, '__proto__'), '必须是自有属性');
  assertNoLeak(proto.value, [], '__proto__');
});

// 形状判据逐条取证。**表驱动**:下面每一行都直接引用判据表里的 id,
// 表里加了一族而这里没加,这条用例不会红(它只验证表里已有的那些行)—— 这是它的覆盖边界,
// 写在注释里而不是假装全覆盖。要防的是另一件事:某一族的正则被改坏(锚点去掉、
// 最小长度放宽)时,必须有一条用例单独红,而不是被别的族顺带盖住。
test('redact: 判据 B 的每一族都有正面例子,且判据 B 只认已知形状', () => {
  const samples = {
    'sk-key': () => fakeSk('v'),
    bearer: () => `Bearer ${crypto.randomBytes(12).toString('hex')}`,
    jwt: () => fakeJwt(),
    'private-key-pem': () => fakePem(),
    'long-hex': () => crypto.randomBytes(20).toString('hex'),
    'github-token': () => `ghp_${crypto.randomBytes(20).toString('hex')}`,
    'slack-token': () => `xoxb-${crypto.randomBytes(10).toString('hex')}`,
    'aws-access-key-id': () => `AKIA${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
    'gitlab-token': () => `glpat-${crypto.randomBytes(10).toString('hex')}`,
    'npm-token': () => `npm_${crypto.randomBytes(20).toString('hex')}`,
    'huggingface-token': () => `hf_${crypto.randomBytes(20).toString('hex')}`,
    'google-api-key': () => `AIza${crypto.randomBytes(18).toString('base64url')}`,
    'stripe-key': () => `sk_live_${crypto.randomBytes(12).toString('hex')}`,
  };
  const ids = VALUE_RULES.map(([id]) => id);
  for (const id of ids) {
    assert.ok(samples[id], `判据表里有 ${id},这条用例里没有对应的正面例子 —— 表变了要同步补,不然这一族没人守`);
  }
  for (const id of ids) {
    const sample = samples[id]();
    const r = redactValue('note', sample);          // 键名无害,只有形状判据能命中
    assert.equal(r.redacted, true, `${id} 的正面例子没被盖: ${sample.slice(0, 40)}`);
    assert.equal(r.reason, `shape:${id}`, `${id} 的 reason 应指向这一族,实得 ${r.reason}`);
    assertNoLeak(r.value, [sample], `判据 ${id}`);
  }
  // 判据 B 的公开覆盖边界:这套形状**不认识**的密钥一律放过(靠键名判据或已知值层兜)。
  // 把边界写成断言,"不假装全覆盖"才是一句可核的话。
  const custom = sentinel('unknown-shape');
  assert.equal(redactValue('note', custom).redacted, false, '自定义形状不在判据表里,形状层必须放过它');
  // 不带锚点的第二族:同一把 sk- 藏在别的文本里也要被认出来
  const embedded = `Authorization: ${fakeSk('e')}`;
  const r = redactValue('note', embedded);
  assert.equal(r.redacted, true);
  assert.ok(r.reason.startsWith('shape:embedded-'), `嵌入形态应走第二族,实得 ${r.reason}`);
  assert.ok(EMBEDDED_RULES.some(([id]) => `shape:${id}` === r.reason));
  assertNoLeak(r.value, [embedded], '嵌入形态');
});

// ---------------------------------------------------------------- compare:两层
test('compare: 脱敏出口同时上"已知值"与"形状"两层', () => {
  const dir = tmpdir();
  const custom = sentinel('known');
  const shaped = fakeSk('shape');
  const bearer = fakeBearer('b');
  const live = {
    env: { ANTHROPIC_AUTH_TOKEN: custom, NOTE: shaped, HEADERS: `Authorization: ${bearer}` },
  };
  const backup = { env: { ANTHROPIC_AUTH_TOKEN: sentinel('known2'), NOTE: shaped, HEADERS: `Authorization: ${bearer}` } };
  const livePath = write(dir, BASE, JSON.stringify(live, null, 2));
  const backupPath = write(dir, `${PRE}20200101-000000`, JSON.stringify(backup, null, 2));

  const r = compareWithLive({
    file: livePath, backupPath, secrets: [live.env.ANTHROPIC_AUTH_TOKEN, backup.env.ANTHROPIC_AUTH_TOKEN],
  });
  assert.equal(r.ok, true, `两边都该解析成功: ${JSON.stringify(r.errors)}`);
  const text = JSON.stringify(r);
  assertNoLeak(r, [custom, backup.env.ANTHROPIC_AUTH_TOKEN, shaped, bearer], 'compare 输出');

  // 两层各自都真的起了作用:byReason 里必须同时出现"键名/形状"与"已知值"的痕迹。
  // ANTHROPIC_AUTH_TOKEN 命中键名判据(name:token),它的值会在**进形状层之前**被 scrubSecrets
  // 换成 [redacted] —— 换完只剩 "[redacted]" 这个常量,形状层认不出它,于是记 name:token。
  // 这正是两层的分界:形状层盖的是"看着像凭据"的,已知值层盖的是"我们知道它是凭据"的。
  const reasons = r.redaction.byReason;
  assert.ok(r.redaction.masked > 0, '必须至少盖掉一处');
  assert.ok(Object.keys(reasons).some(k => k.startsWith('name:')),
    `键名层必须留下痕迹,实得 ${JSON.stringify(reasons)}`);
  for (const k of Object.keys(reasons)) assert.ok(k && k !== 'unknown', `byReason 的键必须是稳定标识符,实得 ${JSON.stringify(k)}`);
  // 已知值层在这里**不**该留下痕迹:env 的键名判据先命中,整棵子树变成掩码体
  // (只剩 reason 与 length),再交给已知值层时已经没有可替换的文本了。
  // 这条断言反过来钉住了"两层不会对同一个**叶子**各记一次账" —— 注意记账的粒度是叶子:
  // redaction.masked 数的是"被盖的叶子数",不是"命中的单元格数",所以下面那条 == 1
  // 说的是"env 这一整棵只算一个叶子"。
  assert.ok(!Object.keys(reasons).includes('known-secret'),
    `被形状/键名层整棵盖掉的叶子不该再被已知值层记一次: ${JSON.stringify(reasons)}`);
  // **只有 env 这一棵**被盖:两份配置都只有 env 一个顶层键,且两边都用同一把假 key,
  // 所以它是一条 changed —— from 与 to 各记一次。这条精确断言比 masked > 0 强得多:
  // 已知值层若对同一个叶子再记一次账(或键名判据变成逐字段判),这个数立刻变。
  assert.equal(r.redaction.masked, 2, `实得 ${JSON.stringify(r.redaction)}`);
  assert.deepEqual(r.redaction.byReason, { 'name:auth': 2 });
  // 已知值层单独取证:一个既不在敏感键名、形状也认不出的值,只有 scrubSecrets 能盖住它。
  const dir2 = tmpdir();
  const onlyKnown = sentinel('onlyknown');
  const p1 = write(dir2, BASE, JSON.stringify({ header_note: onlyKnown }));
  const p2 = write(dir2, `${PRE}20200101-000000`, JSON.stringify({ header_note: 'OTHER' }));
  const r2 = compareWithLive({ file: p1, backupPath: p2, secrets: [onlyKnown] });
  assertNoLeak(r2, [onlyKnown], '仅已知值层');
  assert.equal(r2.changed.length, 1);
  assert.equal(r2.changed[0].to.value, REDACTED, '已知值层把它换成了 [redacted] 常量');
  assert.equal(r2.changed[0].to.redacted, true, '换成常量也算"被盖过",必须记账');
  assert.deepEqual(r2.redaction.byReason, { 'known-secret': 1 },
    '已知值层要留下自己的记号,不然"这个值为什么被盖"在结果里指不出来');
  // 两层次序的取证:同一个值**既**长得像 sk-…,**又**在已知密钥列表里。
  //   形状层先跑 → 掩码体带 reason 'shape:sk-key'(它本来是什么,还看得见);
  //   已知值层先跑 → 先压成常量 [redacted],形状层认不出它,reason 只剩含糊的 'known-secret'。
  // 也就是说 reason 指不指得出"为什么被盖",取决于两层的次序 —— 这一条就是它的断言。
  const dir4 = tmpdir();
  const both = fakeSk('both');
  const b1 = write(dir4, BASE, JSON.stringify({ note: both }));
  const b2 = write(dir4, `${PRE}20200101-000000`, JSON.stringify({ note: 'other' }));
  const r4 = compareWithLive({ file: b1, backupPath: b2, secrets: [both] });
  assertNoLeak(r4, [both], '既是形状又是已知值');
  assert.equal(r4.changed[0].to.reason, 'shape:sk-key',
    '形状层必须先跑:否则 reason 会退化成一个指不出所以然的 known-secret');
  assert.deepEqual(r4.redaction.byReason, { 'shape:sk-key': 1 });

  // 不带 secrets 时同一个值原样出现 —— 说明上一条的红不是别的机制造成的
  const r3 = compareWithLive({ file: p1, backupPath: p2 });
  assert.equal(r3.changed[0].to.value, onlyKnown, '没有已知值列表时,形状层确实认不出它');
});

test('compare: TOML 侧的已知值层与截断也都走通', () => {
  // JSON 那一侧有"仅已知值层"的用例,TOML 这一侧是**另一条代码路径**(tomlCell),
  // 它的已知值层与截断次序各写了一遍 —— 只测 JSON 等于有一条分支没人走过。
  const dir = tmpdir();
  const custom = sentinel('toml-known');
  const livePath = write(dir, 'config.toml', `note = "${custom}"\n`);
  const backupPath = write(dir, `${PRE}20200101-000000`, 'note = "other"\n');
  const r = compareWithLive({ file: livePath, backupPath, secrets: [custom] });
  assert.equal(r.format, 'toml');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assertNoLeak(r, [custom], 'TOML 已知值层');
  // TOML 一侧的值是**原文**(含引号),不像 JSON 那样是解出来的字符串 —— 所以这里比的是带引号的那一串
  assert.equal(r.changed[0].to.value, `"${REDACTED}"`);
  assert.equal(r.changed[0].to.reason, 'known-secret');
  assert.deepEqual(r.redaction.byReason, { 'known-secret': 1 });

  // 已知密钥**横跨截断点**:截断排在替换之后,所以替换先发生、替换完再截。
  // 次序反了的话,先截掉一半的文本既不再等于那把密钥、也匹配不上任何形状判据。
  const dir2 = tmpdir();
  // 替换前长度 = 引号 2 + X 段 + 密钥长;替换后变成 `"XXX…[redacted]"`,
  // 缩掉的差额 = 密钥长 - '[redacted]'.length = 10,所以额度要按**替换之后**算:
  // pad 段必须 > TOML_VALUE_MAX_CHARS - 2 - '[redacted]'.length 才能在替换后仍然超阈值。
  const long = 'X'.repeat(TOML_VALUE_MAX_CHARS - 2) + custom;
  const p1 = write(dir2, 'config.toml', `note = "${long}"\n`);
  const p2 = write(dir2, `${PRE}20200101-000000`, 'note = "other"\n');
  const r2 = compareWithLive({ file: p1, backupPath: p2, secrets: [custom] });
  assertNoLeak(r2, [custom], 'TOML 跨截断点的已知密钥');
  assert.equal(r2.changed[0].to.reason, 'known-secret');
  assert.equal(r2.changed[0].to.truncated, true, '替换完仍然超过阈值 → 照样截断并标出来');
  // 密钥在末尾,所以被截掉的正是它 —— 返回的是替换后文本的前 200 个字符。
  // 真正要钉的是"截断的对象是**替换后**的文本":若次序反了,截出来的是**原文**的前 200 字符,
  // 那一段里会有密钥的绝大部分(密钥在这儿只有一二十字符,基本整段都在)。
  assert.equal([...r2.changed[0].to.value].length, TOML_VALUE_MAX_CHARS);
  assert.ok(r2.changed[0].to.value.startsWith('"X'.repeat(1).slice(0, 1) + 'X'), '截断回的是前缀');
  // 密钥放在**开头**再验一次:替换过的话前缀位置就是 [redacted],没替换过就是原密钥。
  const dir5 = tmpdir();
  const front = write(dir5, 'config.toml', `note = "${custom}${'X'.repeat(TOML_VALUE_MAX_CHARS)}"\n`);
  const front2 = write(dir5, `${PRE}20200101-000000`, 'note = "other"\n');
  const r6 = compareWithLive({ file: front, backupPath: front2, secrets: [custom] });
  assertNoLeak(r6, [custom], 'TOML 密钥在开头');
  assert.ok(r6.changed[0].to.value.startsWith(`"${REDACTED}`),
    `替换先于截断:截出来的前缀位置应该是常量而不是原密钥,实得 ${JSON.stringify(r6.changed[0].to.value.slice(0, 40))}`);

  // 形状层先于已知值层:一个既像 sk-… 又在已知列表里的 TOML 值,reason 必须指向形状
  const dir3 = tmpdir();
  const both = fakeSk('tomlboth');
  const q1 = write(dir3, 'config.toml', `note = "${both}"\n`);
  const q2 = write(dir3, `${PRE}20200101-000000`, 'note = "other"\n');
  const r3 = compareWithLive({ file: q1, backupPath: q2, secrets: [both] });
  assertNoLeak(r3, [both], 'TOML 既是形状又是已知值');
  // TOML 一侧的值是**带引号的原文**,所以带锚点的第一族(`^sk-…$`)在这里**必然落空** ——
  // 命中的是不带锚点的第二族。这不是缺陷,是两族分工在 TOML 上的具体表现:
  // 锚点族的锚点被引号挡住,嵌入族把引号里的密钥认了出来。
  assert.equal(r3.changed[0].to.reason, 'shape:embedded-sk-key');

  // 键名敏感时 TOML 一侧整格盖掉,reason 走键名判据
  const dir4 = tmpdir();
  const k1 = write(dir4, 'config.toml', 'api_key = "hunter2"\n');
  const k2 = write(dir4, `${PRE}20200101-000000`, 'api_key = "hunter2"\n');
  const r4 = compareWithLive({ file: k1, backupPath: k2 });
  assert.equal(r4.identical, true);
  assert.deepEqual(r4.redaction, { masked: 0, byReason: {} }, '两边一样就没有 from/to 要被盖 —— changed 根本没产生');
  const k3 = write(dir4, `${PRE}20200101-000001`, 'api_key = "hunter3"\n');
  const r5 = compareWithLive({ file: k1, backupPath: k3 });
  assert.equal(r5.changed.length, 1);
  assert.equal(r5.changed[0].from.reason, 'name:key', '键名敏感时 TOML 一侧的 reason 走键名判据');
  assert.equal(r5.changed[0].from.value.redacted, true);
});

test('compare: 比较用原文 —— 两把不同的密钥必须报 changed,不能被掩码体糊过去', () => {
  const dir = tmpdir();
  const a = sentinel('pa');
  const b = sentinel('pb');
  const livePath = write(dir, BASE, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: a } }));
  const backupPath = write(dir, `${PRE}20200101-000000`, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: b } }));
  const r = compareWithLive({ file: livePath, backupPath });
  assert.equal(r.changed.length, 1, `换 key 必须报 changed,实得 ${JSON.stringify(r.changed)}(identical=${r.identical})`);
  assert.equal(r.changed[0].key, 'env', '顶层键比较:env 整块的值变了');
  assert.equal(r.identical, false);
  // from/to 都是掩码体,长得一样 —— 而 changed 照样被报了出来。这就是"比较用原文"的证据:
  // 若拿掩码后的值去比,这两个对象 isDeepStrictEqual 为真,changed 会是空的。
  assert.equal(r.changed[0].from.redacted, true);
  assert.equal(r.changed[0].to.redacted, true);
  assert.deepEqual(
    { redacted: r.changed[0].from.redacted, reason: r.changed[0].from.reason },
    { redacted: r.changed[0].to.redacted, reason: r.changed[0].to.reason });
  assertNoLeak(r, [a, b], '换 key 的预览');
});

test('compare: 脱敏排在截断之前(横跨截断点的长密钥不许漏出后半段)', () => {
  const dir = tmpdir();
  // 阈值从实现里读出来,不写死 200:写死的话,常量一改这条用例就从"跨越截断点"静默退化成
  // "没跨越截断点",而它照样是绿的 —— 一条不再覆盖它声称覆盖的东西的断言。
  const secret = 'sk-' + crypto.randomBytes(40).toString('hex');
  const pad = 'x'.repeat(TOML_VALUE_MAX_CHARS - 10);               // 密钥一定跨过截断点
  const livePath = write(dir, 'config.toml', `note = "${pad}${secret}"\n`);
  const backupPath = write(dir, `${PRE}20200101-000000`, 'note = "short"\n');
  const r = compareWithLive({ file: livePath, backupPath });
  assert.equal(r.format, 'toml');
  assertNoLeak(r, [secret], 'TOML 长值');
  // 两边都有 note,所以是 changed(不是 added);长值在 to 一侧
  assert.deepEqual(r.changed.map(c => c.key), ['note'], `实得 changed=${JSON.stringify(r.changed)} added=${JSON.stringify(r.added)}`);
  const cell = r.changed[0].to;
  assert.equal(cell.redacted, true, '整个值命中形状判据,必须先盖后截');
  // 长度在掩码体(value)里,不在单元格上 —— 单元格只有 reason 与 redacted
  assert.ok(cell.value.length > TOML_VALUE_MAX_CHARS,
    `前置:被盖之前它确实超过截断阈值(${TOML_VALUE_MAX_CHARS}),否则这条用例没测到"跨过截断点"这件事`);
  assert.equal(cell.value.length, [...`"${pad}${secret}"`].length, '长度按字符数报(等价于 UTF-8 码点数)');
  // 反证这条用例不是恒绿:同一个值放在**不截断**的短 pad 下,输出同样是掩码体,
  // 但走到的是另一条分支(截断没发生)。两条都验,才能说"次序"这件事被测到了。
  const dir2 = tmpdir();
  const p1 = write(dir2, 'config.toml', `note = "${secret}"\n`);
  const p2 = write(dir2, `${PRE}20200101-000000`, 'note = "short"\n');
  const r2 = compareWithLive({ file: p1, backupPath: p2 });
  assertNoLeak(r2, [secret], 'TOML 短值');
  assert.equal(r2.changed[0].to.truncated, undefined, '被盖的值不报 truncated:它已经不是原文了');
  assert.equal(r.changed[0].to.truncated, undefined);
  // 还有一个**没被盖**的长值,用来把"截断这条路真的会走"钉住 —— 全是掩码体的话,
  // "截断排在脱敏之后"这句话在结果里根本看不见。
  const dir3 = tmpdir();
  const longPlain = 'y'.repeat(TOML_VALUE_MAX_CHARS + 50);
  const q1 = write(dir3, 'config.toml', `note = "${longPlain}"\n`);
  const q2 = write(dir3, `${PRE}20200101-000000`, 'note = "short"\n');
  const r3 = compareWithLive({ file: q1, backupPath: q2 });
  assert.equal(r3.changed[0].to.redacted, false);
  assert.equal(r3.changed[0].to.truncated, true, '不敏感的长值照样会被截断,并标 truncated');
  assert.equal([...r3.changed[0].to.value].length, TOML_VALUE_MAX_CHARS);
});

test('compare: JSON 侧注释/BOM/尾逗号退一步解析并标 lenient,两边分别标', () => {
  const dir = tmpdir();
  const livePath = write(dir, BASE, '{\n  // 注释\n  "a": 1,\n  "b": 2,\n}\n');
  const backupPath = write(dir, `${PRE}20200101-000000`, '{"a": 1, "b": 3}');
  const r = compareWithLive({ file: livePath, backupPath });
  assert.equal(r.ok, true, `去噪后应能解析: ${JSON.stringify(r.errors)}`);
  assert.ok(r.notes.some(n => n.id === 'live-lenient-json'), '活文件走了去噪路径要标出来');
  assert.ok(!r.notes.some(n => n.id === 'backup-lenient-json'), '备份是严格 JSON,不该标 lenient');
  assert.deepEqual(r.changed.map(c => c.key), ['b'], '只有 b 变了');
  assert.equal(r.changed[0].from.value, 3);
  assert.equal(r.changed[0].to.value, 2);
  assert.equal(r.identical, false);

  // BOM 也是同一档
  const bom = tmpdir();
  const p1 = write(bom, BASE, '﻿{"a": 1}');
  const p2 = write(bom, `${PRE}20200101-000000`, '{"a": 1}');
  const r2 = compareWithLive({ file: p1, backupPath: p2 });
  assert.equal(r2.ok, true);
  assert.equal(r2.identical, true, 'BOM 剥掉之后两边内容一样');
});

test('compare: JSON 两边解析失败能分辨是哪一边,并把原因各自报出', () => {
  const dir = tmpdir();
  const good = write(dir, BASE, '{"a": 1}');
  const badJson = write(dir, `${PRE}20200101-000000`, '{"a": 1,,}');

  const backupBad = compareWithLive({ file: good, backupPath: badJson });
  assert.equal(backupBad.ok, false);
  assert.equal(backupBad.errors.live, null, '活文件是好的,不该报它坏');
  assert.equal(backupBad.errors.backup.reason, 'parse-error');
  assert.ok(backupBad.errors.backup.message, '要带可读的解析报错');
  assert.equal(backupBad.identical, false, '解析失败时绝不能报 identical');
  assert.deepEqual(backupBad.added, []);
  assert.deepEqual(backupBad.removed, []);
  assert.deepEqual(backupBad.changed, []);

  const liveBad = compareWithLive({ file: badJson, backupPath: good });
  assert.equal(liveBad.ok, false);
  assert.equal(liveBad.errors.backup, null, '备份是好的,不该报它坏');
  assert.equal(liveBad.errors.live.reason, 'parse-error');

  // 两边都坏:各自报各自的,不做"合并成一个 parse error"
  const bothBad = compareWithLive({ file: badJson, backupPath: write(dir, `${PRE}20200101-000001`, '{"b": ,}') });
  assert.equal(bothBad.errors.live.reason, 'parse-error');
  assert.equal(bothBad.errors.backup.reason, 'parse-error');
});

test('compare: 顶层不是对象时单列 root-not-object,与语法错误分开', () => {
  const dir = tmpdir();
  const arr = write(dir, BASE, '[1,2,3]');
  const obj = write(dir, `${PRE}20200101-000000`, '{"a":1}');
  const r = compareWithLive({ file: arr, backupPath: obj });
  assert.equal(r.ok, false);
  assert.equal(r.errors.live.reason, 'root-not-object', '把形状不支持说成语法错会把人推去查语法,而语法一点问题都没有');
  // 不钉 errors.live.type:它来自一行三元表达式,而 Array.isArray(null) 为 false 会先把 null
  // 归成 'null' —— 只有数组才走得到 'array' 那一支,这个 type 字段比它看起来的窄。
  // 断言一个我不打算依赖的字段只会把将来的正常改动判成红。
  const nul = compareWithLive({ file: write(dir, 'n.json', 'null'), backupPath: obj });
  assert.equal(nul.ok, false);
  assert.equal(nul.errors.live.reason, 'root-not-object');
  const num = compareWithLive({ file: write(dir, 'num.json', '42'), backupPath: obj });
  assert.equal(num.errors.live.reason, 'root-not-object');
  // 形状问题与"某一边坏了"是同一档结构化输出,所以 format 与 sides 都在
  assert.ok('format' in r.errors && 'live' in r.errors && 'backup' in r.errors);
});

// ---------------------------------------------------------------- compare:TOML
test('compare: TOML 只取顶层键,section 里的东西不参与对照', () => {
  const dir = tmpdir();
  const live = [
    'model = "gpt-5"',
    'approval_policy = "never"',
    '',
    '[model_providers.p1]',
    'base_url = "http://a"',
    '',
    '[model_providers.p2]',
    'base_url = "http://b"',
    '',
  ].join('\n');
  const backup = 'model = "gpt-4"\n\n[model_providers.p1]\nbase_url = "http://old"\n';
  const livePath = write(dir, 'config.toml', live);
  const backupPath = write(dir, `${PRE}20200101-000000`, backup);
  const r = compareWithLive({ file: livePath, backupPath });
  assert.equal(r.format, 'toml');
  assert.equal(r.ok, true, `${JSON.stringify(r.errors)}`);
  assert.deepEqual(r.changed.map(c => c.key), ['model'], '只比顶层键;section 里的 base_url 改动不参与');
  // approval_policy 只在活文件里有 —— 它是顶层键,所以**该**报 added。这不是缺陷,
  // 是"只取顶层键"的必然结果:section 里的东西不比,顶层的东西照比。
  assert.deepEqual(r.added.map(c => c.key), ['approval_policy']);
  assert.deepEqual(r.removed, []);
  // 顶层键的键集合里没有 base_url —— 它只出现在 section 里,从来没被读进来过。
  assert.deepEqual(r.keys.live, ['approval_policy', 'model']);
  assert.deepEqual(r.keys.backup, ['model']);
  assert.ok(!r.keys.live.includes('base_url') && !r.keys.backup.includes('base_url'),
    'section 里的键不许出现在顶层键集合里');
  // 两份文件里 p1/p2 的 base_url 都不同,却没有一条差异报出来 —— 这正是"只取顶层键"的取证
  assert.ok(!JSON.stringify(r).includes('model_providers'), 'section 名本身也不该出现在结果里');
});

test('compare: TOML 多行值必须续行,否则"这里明明改了"会被报成没改', () => {
  const dir = tmpdir();
  const livePath = write(dir, 'config.toml', 'headers = [\n  "a: 1",\n  "b: 2",\n]\n');
  const backupPath = write(dir, `${PRE}20200101-000000`, 'headers = [\n  "a: 1",\n  "b: 3",\n]\n');
  const r = compareWithLive({ file: livePath, backupPath });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changed.map(c => c.key), ['headers'], '多行数组的差异必须被看见(漏报比误报更坏)');
  // 两边都残得一样时会被报成没改 —— 上面那条就是这一条的对照
  const same = compareWithLive({ file: livePath, backupPath: write(dir, `${PRE}20200101-000001`, 'headers = [\n  "a: 1",\n  "b: 2",\n]\n') });
  assert.equal(same.identical, true);
});

test('compare: TOML 值比较用原文规范化,无转义的 basic/literal string 等价', () => {
  assert.equal(normalizeTomlValue('"x"'), normalizeTomlValue("'x'"));
  assert.equal(normalizeTomlValue('1'), 'raw:1');
  assert.notEqual(normalizeTomlValue('1'), normalizeTomlValue('1.0'),
    '预览级比较器不解析数字语义,这条是公开的覆盖边界');
  assert.equal(stripTomlComment('a = "# not comment" # real'), 'a = "# not comment" ');
  assert.equal(bracketDepth('["a", "b"'), 1);
  assert.equal(bracketDepth('["a]", "b"]'), 0, '字符串里的括号不算');
});

test('compare: 两边形状不一致时定不了格式,而不是猜一个', () => {
  const dir = tmpdir();
  const livePath = write(dir, 'weird', '{"a":1}');
  const backupPath = write(dir, `${PRE}20200101-000000`, 'a = 1\n');
  const r = compareWithLive({ file: livePath, backupPath });
  assert.equal(r.ok, false);
  assert.equal(r.errors.format.reason, 'format-mismatch');
  assert.equal(r.errors.format.live, 'json');
  assert.equal(r.errors.format.backup, 'toml');
  assert.equal(r.format, null);
  assert.deepEqual(r.added, [], '定不了格式就不要给出半个结论');

  const undet = compareWithLive({ file: write(dir, 'u', 'hello'), backupPath: write(dir, `${PRE}20200101-000003`, 'world') });
  assert.equal(undet.errors.format.reason, 'format-undetermined');
  // 扩展名优先:文件名带 .json 就直接定 json,不去嗅
  const byExt = compareWithLive({ file: write(dir, 'x.json', '{}'), backupPath: write(dir, `${PRE}20200101-000004`, '{}') });
  assert.equal(byExt.format, 'json');
  assert.equal(byExt.identical, true);
});

// ---------------------------------------------------------------- compare:方向与边角
test('compare: 方向约定(added=活文件新增 / removed=备份独有 / changed from=旧 to=新)', () => {
  const dir = tmpdir();
  const livePath = write(dir, BASE, '{"keep": "same", "added": "new", "changed": 2}');
  const backupPath = write(dir, `${PRE}20200101-000000`, '{"keep": "same", "removed": "gone", "changed": 1}');
  const r = compareWithLive({ file: livePath, backupPath });
  assert.deepEqual(r.added.map(e => e.key), ['added']);
  assert.deepEqual(r.removed.map(e => e.key), ['removed']);
  assert.deepEqual(r.changed.map(e => e.key), ['changed']);
  assert.equal(r.changed[0].from.value, 1, 'from 是**备份**里的值(旧)');
  assert.equal(r.changed[0].to.value, 2, 'to 是**活文件**里的值(新)');
  assert.equal(r.keys.live.includes('removed'), false);
  assert.equal(r.identical, false);
  assert.match(r.direction.added, /live-only/);
  assert.match(r.direction.removed, /backup-only/);
  assert.match(r.direction.changed, /from=备份/);
});

test('compare: 活文件缺失/不是常规文件时仍能给结构化结论', () => {
  const dir = tmpdir();
  const backupPath = write(dir, `${PRE}20200101-000000`, '{"a":1}');
  const r = compareWithLive({ file: path.join(dir, 'nope.json'), backupPath });
  assert.equal(r.ok, false);
  assert.equal(r.errors.live.reason, 'missing');
  assert.equal(r.errors.backup, null);
  const d = path.join(dir, 'dir.json');
  fs.mkdirSync(d);
  assert.equal(compareWithLive({ file: d, backupPath }).errors.live.reason, 'not-a-regular-file');
  assert.throws(() => compareWithLive({ backupPath }), TypeError);
  assert.throws(() => compareWithLive({ file: backupPath }), TypeError);
  assert.throws(() => compareWithLive({ file: backupPath, backupPath, format: 'yaml' }), RangeError);
  assert.throws(() => compareWithLive({ file: backupPath, backupPath, maxBytes: 0 }), RangeError);
});

test('compare: 备份名与活文件不是同一个文件时要提示,但比对照做', () => {
  const dir = tmpdir();
  const livePath = write(dir, BASE, '{"a":1}');
  const other = write(dir, 'config.toml.bak-mixui-20200101-000000', '{"a":1}');
  const r = compareWithLive({ file: livePath, backupPath: other, format: 'json' });
  assert.ok(r.notes.some(n => n.id === 'mismatched-base'), '名字对不上要说出来');
  assert.equal(r.ok, true, '比对仍照做');
  assert.equal(r.identical, true);
});

test('compare: 同一把密钥在 added 与 changed 两侧都出现时都记账,不重复计数', () => {
  const dir = tmpdir();
  const s = sentinel('tally');
  const livePath = write(dir, BASE, JSON.stringify({ api_key: s, added_key: s }));
  const backupPath = write(dir, `${PRE}20200101-000000`, JSON.stringify({ api_key: 'other' }));
  const r = compareWithLive({ file: livePath, backupPath });
  assert.equal(r.ok, true);
  assertNoLeak(r, [s], '记账');
  // api_key 在两边都有 → changed(from 与 to 各记一次);added_key 只在活文件 → added 记一次
  assert.equal(r.redaction.masked, 3, `实得 ${JSON.stringify(r.redaction)}`);
  for (const n of Object.values(r.redaction.byReason)) assert.ok(n >= 1);
  assert.equal(Object.values(r.redaction.byReason).reduce((a, b) => a + b, 0), 3);
  // masked=0 时 byReason 必须是空对象而不是缺失
  const clean = compareWithLive({
    file: write(dir, 'c.json', '{"a":1}'), backupPath: write(dir, `${PRE}20200101-000007`, '{"a":1}'), format: 'json',
  });
  assert.deepEqual(clean.redaction, { masked: 0, byReason: {} });
});

test('compare: 解析失败时的原始报错不许把原文带出来', () => {
  // Node 的 JSON.parse 报错会把出错的片段抄进 message。原样放进 errors.live.message,
  // 一个"备份预览报错"就把活文件里的密钥打进了控制台 —— 而预览存在的意义恰恰是不让人看见原文。
  //
  // 先量一下这行输入到底会不会带出哨兵(实测,Node 24.18.0):
  //   整条输入就是一个裸标识符时,V8 只回显前 10 个字符("Unexpected token 'S', \"SENTINEL-S\"...");
  //   裸标识符只有 19 字符时整串回显("Unexpected token 'S', \"SENTINEL-SECRET-x1\" is not valid JSON");
  //   夹在 JSON 里当**引号内的值**时,只回显出错点附近的短窗口(实测最长只带出 2 个字符)。
  // 也就是说:回显长度是"出错点周围的短窗口",不是"整条输入"。
  // 所以哨兵在这里必须足够长,才能让"前 10 个字符"这一段本身成为可判定的泄漏。
  //
  // ⚠ 但**回显本身是按 V8 版本分档的**,实测三版:
  //   V8 12.x / 13.x(Node 22.23.2 / 24.18.0,CI 矩阵的两条腿):
  //     `Unexpected token 'S', "SENTINEL-S"... is not valid JSON`  —— 带原文片段;
  //   V8 10.2(Node 18.20.8,engines 写着 >=18、CI 矩阵也跑这条腿):
  //     `Unexpected token S in JSON at position 0`                  —— **一个字的原文都不带**。
  //   于是"摘回显"这一步在 Node 18 上根本没有输入:message 与原文逐字相同,notes 也不该出现。
  //   若把"V8 会回显"写成无条件前置,红的是**测试**而不是产物 —— 那一版上产物反而更安全。
  //   所以下面分两档断言:**不漏**在任何版本都必须成立;**摘回显并点名**只在真有回显时成立,
  //   没有回显的那一档反过来钉住"不许凭空点名、不许改动原文"(多出来的覆盖面,不是放宽)。
  const long = `SENTINEL-SECRET-err-${crypto.randomBytes(24).toString('hex')}`;
  const dir = tmpdir();
  const livePath = write(dir, BASE, long);                    // 整条输入就是哨兵本身
  const backupPath = write(dir, `${PRE}20200101-000000`, '{"a":1}');

  // 前置:先确认这条输入真的会让 strict JSON 解析失败,否则下面全是空的
  assert.equal(parseJsonText(long).ok, false, '前置:这条输入必须让严格 JSON 解析失败');

  // 原始 V8 报错从 parseJsonText 直接拿 —— compareWithLive 的输出也走过剥回显那道,
  // 拿它当"未经处理的原文"是自欺。
  const rawMsg = parseJsonText(long).message;
  // 能力探测,不是断言:这一版 V8 到底回不回显原文?
  const v8Echoes = rawMsg.includes('SENTINEL-S');
  if (v8Echoes) {
    // 反证:**不剥**回显的话同一条输入就真的漏 —— 拿原始 message 跑已知值层,漏点重现。
    const unfixed = scrubSecrets(rawMsg, [long]);
    assert.ok(unfixed.includes('SENTINEL-S'),
      `前置:只上已知值层拦不住这个片段(它不是整把密钥),实得 ${JSON.stringify(unfixed)}`);
  } else {
    assert.equal(rawMsg.includes(long), false,
      `这一版 V8 不带回显,却把整把密钥抄进了 message:${JSON.stringify(rawMsg)}`);
  }

  const r = compareWithLive({ file: livePath, backupPath, secrets: [long] });
  assert.equal(r.ok, false);
  assert.equal(r.errors.live.reason, 'parse-error');
  assertNoLeak(r, [long], '解析报错');          // 任何 V8 版本都必须成立
  const trimNotes = r.notes.filter(n => n.id === 'live-error-trimmed');
  if (v8Echoes) {
    assert.equal(trimNotes.length, 1, `摘掉回显就要点名,实得 ${JSON.stringify(r.notes)}`);
  } else {
    // 没有回显可摘:既不该有摘除痕迹,也不该改动原始报错
    assert.equal(trimNotes.length, 0,
      `这一版 V8 没有回显可摘,却报了点名 ${JSON.stringify(trimNotes)}`);
    assert.equal(r.errors.live.message, rawMsg, '没有回显可摘时不许改动原始报错');
  }
  // 摘掉的只有回显:错因描述与位置信息必须还在,否则这条报错就不可用了
  assert.match(r.errors.live.message, /Unexpected token/);
  assert.equal(r.errors.live.message, stripErrorEcho(rawMsg));
  // 已知值层那一道:出错点恰好落在一把已知密钥中间时,回显窗口可能完整包含它。
  // 补一条能真的触发它的输入,否则 notes 里那条路径没有任何用例走过。
  const dir2 = tmpdir();
  const inner = `abc${long}def`;
  const midPath = write(dir2, 'm.json', inner);
  const mid = compareWithLive({ file: midPath, backupPath, secrets: [long] });
  // 这条输入是裸标识符,回显窗口盖不到 key 的中间 —— 触发不到那条路径时,这里只验"没漏",
  // 并明确记下未覆盖:见文件末尾的"未覆盖"清单。
  assertNoLeak(mid, [long], '回显窗口落在一把已知密钥内部');
  assert.equal(typeof r.errors.live.message, 'string');
  // strictMessage 同样处理:它也是 V8 原话,同样是漏点
  assertNoLeak(r, [long], 'strictMessage');
});
