'use strict';
// 对照取证:把 when 逐字段判定收敛成一份(rules.whenMissFields)前后,
// matchWhen 与 whenMissFields 的行为是否与旧实现逐字相同。
//
// 为什么单独一份:这次抽取动的是**路由判定的核心语义** —— 决定一条请求落到哪个渠道。
// "804 个全绿"是必要条件但不是充分条件:现有测试只钉了 8 + 5 组固定输入
// (test/routing-preview.test.js:158 / 606),覆盖不了字段组合、大小写、空值、
// 以及**惰性求值**(body 该不该被拼)这些维度。
//
// 直接 require 两棵树的模块比对,不起服务 —— 这是纯函数,不需要端到端。
//
// 维度(互相独立):
//   A. when 字段组合:与旧实现的 4 个字段(session/ua/token/body)全排列的抽样
//   B. 大小写 / 首尾空白 / 空串 / undefined / 非字符串(数字、对象)
//   C. ctx 侧同样这几种取值形状
//   D. **bodyText 是否被调用**(惰性契约):用计数回调量,两边必须一致
//   E. collectAll ∈ {false, true}
//
// 用法:
//   node evidence/when-match.equivalence.js --old=<旧树> --new=<新树>

const path = require('node:path');
const assert = require('node:assert');

const arg = n => {
  const a = process.argv.find(x => x.startsWith(`--${n}=`));
  return a ? path.resolve(a.slice(n.length + 3)) : null;
};
const OLD = arg('old'), NEW = arg('new');
if (!OLD || !NEW) { console.error('需要 --old=<旧树> --new=<新树>'); process.exit(2); }

// 旧树的 whenMissFields 在 resolve.js,新树在 rules.js —— 各自按存在处取,兼容两边
function load(root) {
  const rules = require(path.join(root, 'lib', 'routing', 'rules.js'));
  const resolve = require(path.join(root, 'lib', 'routing', 'resolve.js'));
  return {
    matchWhen: rules.matchWhen,
    whenMissFields: resolve.whenMissFields || rules.whenMissFields,
    from: resolve.whenMissFields ? 'resolve' : 'rules',
  };
}

// ---------------------------------------------------------------- 取值空间
// ⚠ 这里必须**真的包含**带首尾空白与大小写混排的值:`.trim()` 与 `.toLowerCase()`
// 是这段逻辑里两个独立的归一化步骤,少了任何一类取值,对应那一步就等于没被证明。
// 我第一版把 ' abc ' 写进了 VALS 却忘了 SAMPLE 才是实际采样集 —— 注入「去掉 trim」
// 因此红了 0 条,差点把"探针没覆盖"读成"trim 无关紧要"。VALS 是候选池,SAMPLE 是采样集,
// 下面显式断言 SAMPLE ⊆ VALS 且含空白样本。
const VALS = ['', 'abc', 'ABC', ' abc ', 'a b', 'A B', 'x', undefined, null, 0, 42, {}, ['abc'], 'token-value', 'UA/claude-cli'];
const SAMPLE = ['abc', 'ABC', ' abc ', undefined, '', 'A B'];
const FIELDS = ['session', 'ua', 'token', 'body'];
for (const v of SAMPLE) {
  if (!VALS.some(x => x === v)) throw new Error(`SAMPLE 里的 ${JSON.stringify(v)} 不在 VALS 里`);
}
if (!SAMPLE.some(v => typeof v === 'string' && v !== v.trim())) {
  throw new Error('SAMPLE 必须含带首尾空白的取值,否则 trim 这一步没有被证明');
}
if (!SAMPLE.some(v => typeof v === 'string' && v !== v.toLowerCase())) {
  throw new Error('SAMPLE 必须含大小写混排的取值,否则 toLowerCase 这一步没有被证明');
}
function* whenCombos() {
  for (const a of SAMPLE) for (const b of SAMPLE) for (const c of SAMPLE) for (const d of SAMPLE) {
    yield { session: a, ua: b, token: c, body: d };
  }
}

// ctx 取值:每个字段单独给几种,其余保持"会命中"的基线
const CTX_BASES = [
  { session: 'cc:abc-1', ua: 'UA/claude-cli/2', token: 'token-value', bodyText: () => 'please abc now' },
  { session: 'zzz', ua: 'curl/8', token: 'other', bodyText: () => 'nothing' },
  {},
  { session: undefined, ua: null, token: 0 },
];
// 额外的 ctx 变体:同一字段给"大小写不同 / 带空白 / 类型不同"的值
function ctxVariants() {
  const out = [];
  for (const f of FIELDS) {
    for (const v of ['ABC', ' abc ', 42, {}, ['abc'], undefined]) {
      const base = { session: 'cc:abc-1', ua: 'UA/claude-cli/2', token: 'token-value', bodyText: () => 'please abc now' };
      if (f === 'body') base.bodyText = () => (typeof v === 'string' ? v : '');
      else base[f] = v;
      out.push(base);
    }
  }
  return out;
}

function runOne(impl, rule, ctx, collectAll) {
  // 惰性契约:bodyText 被调用几次。两个实现必须给出同一个次数。
  let bodyCalls = 0;
  const wrapped = { ...ctx };
  if (typeof ctx.bodyText === 'function') {
    const inner = ctx.bodyText;
    wrapped.bodyText = () => { bodyCalls++; return inner(); };
  }
  let miss = null, threw = null;
  try { miss = impl.whenMissFields(rule, wrapped, collectAll); } catch (e) { threw = String(e && e.message); }
  const pass = miss === null;
  return { miss, pass, threw, bodyCalls };
}

function main() {
  const A = load(OLD), B = load(NEW);
  console.log(`旧树 whenMissFields 取自: ${A.from}   新树取自: ${B.from}`);

  const cases = [];
  for (const w of whenCombos()) cases.push({ name: `when=${JSON.stringify(w)}`, rule: { when: w } });
  // 无 when / when 非对象 / rule 本身缺失
  cases.push({ name: 'rule 无 when', rule: {} });
  cases.push({ name: 'rule=undefined', rule: undefined });
  cases.push({ name: 'when=null', rule: { when: null } });
  cases.push({ name: 'when=字符串', rule: { when: 'abc' } });

  let n = 0, mismatch = 0;
  const diffs = [];
  for (const c of cases) {
    const ctxs = [...CTX_BASES, ...ctxVariants()];
    for (const ctx of ctxs) {
      for (const collectAll of [false, true]) {
        const ra = runOne(A, c.rule, ctx, collectAll);
        const rb = runOne(B, c.rule, ctx, collectAll);
        n++;
        if (JSON.stringify(ra) !== JSON.stringify(rb)) {
          mismatch++;
          if (diffs.length < 10) diffs.push({ ...c, ctx: JSON.stringify(ctx).slice(0, 90), collectAll, old: ra, new: rb });
        }
      }
    }
  }
  // matchWhen 单独对齐(它就是薄包装,必须与旧实现逐值一致)
  let mn = 0, mmis = 0;
  for (const c of cases) {
    for (const ctx of [...CTX_BASES, ...ctxVariants()]) {
      let ra, rb;
      try { ra = A.matchWhen(c.rule, ctx); } catch (e) { ra = 'throw:' + e.message; }
      try { rb = B.matchWhen(c.rule, ctx); } catch (e) { rb = 'throw:' + e.message; }
      mn++;
      if (ra !== rb) { mmis++; if (diffs.length < 10) diffs.push({ matchWhen: c.name, old: ra, new: rb }); }
    }
  }

  for (const d of diffs) console.log('✘', JSON.stringify(d));
  console.log(`\nwhenMissFields 比对 ${n} 组,不等价 ${mismatch}`);
  console.log(`matchWhen     比对 ${mn} 组,不等价 ${mmis}`);
  // 自证有鉴别力:惰性契约真的被观测到了吗
  const bodyEvaluated = (() => {
    let calls = 0;
    const ctx = { session: 'zzz', bodyText: () => { calls++; return 'abc'; } };
    A.whenMissFields({ when: { session: 'abc', body: 'abc' } }, ctx, false);
    return calls;
  })();
  console.log(`惰性契约自证:先命中不匹配的 session 时 bodyText 被求值 ${bodyEvaluated} 次(应为 0,否则"不求值 body"这条没被观测到)`);
  const total = mismatch + mmis;
  console.log(`\nOLD=${OLD}\nNEW=${NEW}\nMISMATCH=${total}`);
  process.exit(total ? 1 : 0);
}
main();
