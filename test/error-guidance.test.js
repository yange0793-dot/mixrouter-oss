'use strict';
// 失败解释:分类必须能分开"凭据错 / 权限或风控 / 模型不存在 / 限流 / 额度尽 / 上游坏 /
// 网络 / 超时 / 配置错",而不是一句"请求失败"。
//
// 另外两条是安全契约:
//   · 输出里绝不回显输入(status/code/err_class 里的任何文本都不许被带出来);
//   · target 只能是内部控制台的 hash,不能是外部 URL。

const { test } = require('node:test');
const assert = require('node:assert');

const { explainError, CATEGORIES, TARGETS } = require('../lib/observability/error-guidance');

const KEYS = ['action', 'category', 'impact', 'target', 'title', 'uncertain'];
const INTERNAL = new Set(Object.values(TARGETS));

function checkShape(h) {
  assert.deepEqual(Object.keys(h).sort(), KEYS, '返回形状固定六个键');
  assert.ok(CATEGORIES.includes(h.category), `未登记的分类: ${h.category}`);
  for (const f of ['title', 'impact', 'action']) {
    assert.equal(typeof h[f], 'string', `${f} 必须是字符串`);
    assert.ok(h[f].length > 0, `${f} 不能为空`);
  }
  assert.equal(typeof h.uncertain, 'boolean');
  assert.equal(typeof h.target, 'string');
  assert.ok(h.target === '' || INTERNAL.has(h.target), `target 只能是内部页面: ${h.target}`);
  assert.doesNotMatch(h.title + h.impact + h.action, /https?:\/\//, '解释里不放外部 URL');
  return h;
}

test('401 与 403 分开说:403 是权限或风控,不是"账号坏了"', () => {
  const unauthorized = checkShape(explainError({ status: 401, err_class: 'authentication' }));
  assert.equal(unauthorized.category, 'auth');
  assert.match(unauthorized.title, /凭据/);
  assert.equal(unauthorized.uncertain, false);

  const forbidden = checkShape(explainError({ status: 403 }));
  assert.equal(forbidden.category, 'auth');
  assert.match(forbidden.impact, /权限|风控/);
  assert.match(forbidden.impact, /不等于/, '403 必须明确否掉"账号坏了"这种笼统结论');
  assert.equal(forbidden.uncertain, true, '403 的原因不止一种,必须标不确定');
  assert.equal(forbidden.target, TARGETS.providers);

  // 只有 err_class、没有状态码时:不能把 403 的语义说成 401
  const clsOnly = checkShape(explainError({ err_class: 'authentication' }));
  assert.equal(clsOnly.category, 'auth');
  assert.equal(clsOnly.uncertain, true);
});

test('模型 / 限流 / 额度 / 上游故障 / 超时 / 网络各自成类', () => {
  assert.equal(checkShape(explainError({ status: 404 })).category, 'model');
  assert.equal(checkShape(explainError({ status: 429 })).category, 'rate');
  assert.equal(checkShape(explainError({ status: 402 })).category, 'quota');
  assert.equal(checkShape(explainError({ status: 500 })).category, 'upstream');
  assert.equal(checkShape(explainError({ status: 503, err_class: 'upstream_server' })).category, 'upstream');
  assert.equal(checkShape(explainError({ status: 504 })).category, 'timeout');
  assert.equal(checkShape(explainError({ status: 0, err_class: 'timeout' })).category, 'timeout');
  assert.equal(checkShape(explainError({ status: 0, code: 'ECONNRESET' })).category, 'network');
  assert.equal(checkShape(explainError({ status: 0, code: 'econnrefused' })).category, 'network');
  assert.equal(checkShape(explainError({ status: 499, err_class: 'cancelled' })).category, 'cancelled');
  assert.equal(checkShape(explainError({ status: 200, err_class: 'stream_aborted' })).category, 'network');
  // 额度尽与限流必须分开:一个是这个窗口没量了,一个是并发太高
  assert.notEqual(explainError({ status: 402 }).title, explainError({ status: 429 }).title);
});

test('代理自己的配置类错误码:指向控制台具体页面,而不是"上游失败"', () => {
  const cases = {
    no_route_error: 'config',
    provider_disabled_error: 'config',
    provider_key_unavailable_error: 'config',
    wire_api_mismatch_error: 'config',
    bad_credential: 'config',
    unsupported_compaction: 'config',
    too_many_attempts: 'attempts',
  };
  for (const [code, category] of Object.entries(cases)) {
    const h = checkShape(explainError({ code, status: 503 }));
    assert.equal(h.category, category, `${code} 应归 ${category}`);
    assert.ok(h.target && INTERNAL.has(h.target), `${code} 必须指向一个内部控制台页面`);
    assert.doesNotMatch(h.title + h.impact, /上游失败|上游请求失败/, `${code} 不得笼统说成上游失败`);
  }
  assert.equal(explainError({ code: 'no_route_error' }).target, TARGETS.routes);
  assert.equal(explainError({ code: 'provider_disabled_error' }).target, TARGETS.providers);
});

test('未知输入:不编原因,落 unknown 并标不确定', () => {
  for (const input of [undefined, null, {}, { status: 'abc' }, { status: 999 }, { status: -1 },
    { status: 0 }, { err_class: 'something_new' }, { code: 'HTTP 500' }]) {
    const h = checkShape(explainError(input));
    assert.equal(h.category, 'unknown');
    assert.equal(h.uncertain, true);
    assert.equal(h.target, TARGETS.diagnostics);
  }
  // 成功区间没有"失败原因"可解释,同样标不确定
  const ok = checkShape(explainError({ status: 200 }));
  assert.equal(ok.category, 'unknown');
  assert.equal(ok.uncertain, true);
});

test('不回显输入:HTML / 脚本 / Key 形状的 code 一个字都不进输出', () => {
  const hostile = '<script>alert(1)</script>sk-ant-SECRET';
  const inputs = [
    { status: 500, code: hostile },
    { status: 418, err_class: hostile },
    { status: hostile, code: hostile, err_class: hostile },
  ];
  for (const input of inputs) {
    const h = checkShape(explainError(input));
    const text = h.title + h.impact + h.action + h.category + h.target;
    assert.ok(!text.includes('SECRET'), '输入不得被回显');
    assert.ok(!text.includes('<script'), '输入不得被回显');
    assert.doesNotMatch(text, /[<>]/, '输出里不该出现尖括号');
  }
  // 合法的错误类型仍然认得出来(输入归一化不能把大写/空白弄丢)
  assert.equal(explainError({ code: '  ECONNRESET  ' }).category, 'network');
  assert.equal(explainError({ err_class: 'UPSTREAM_SERVER' }).category, 'upstream');
});

test('每条解释都说清「影响」与「怎么办」,且动作里有可执行的落点', () => {
  const samples = [
    { status: 401 }, { status: 403 }, { status: 404 }, { status: 429 }, { status: 402 },
    { status: 500 }, { status: 504 }, { status: 0, code: 'ECONNRESET' },
    { code: 'no_route_error' }, { code: 'provider_key_unavailable_error' }, { status: 499 },
  ];
  for (const input of samples) {
    const h = checkShape(explainError(input));
    assert.ok(h.impact.length >= 12, `${JSON.stringify(input)} 的影响说明太短`);
    assert.ok(h.action.length >= 12, `${JSON.stringify(input)} 的处理建议太短`);
    // 每条动作都要给出"去哪儿/做什么",不允许只给一句"请检查配置"
    assert.match(h.action, /页|控制台|重试|换|确认|等待|核对|检查|重新|稍后|让|到|用/,
      `${JSON.stringify(input)} 的动作缺少落点: ${h.action}`);
  }
});
