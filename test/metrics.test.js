'use strict';
// metrics 文本编码 + snapshot 语义。重点三条:
//   1. counter 与窗口量不许混(窗口量随 ring 淘汰会变小,发成 _total 就是错的);
//   2. label 基数必须有界 + 转义正确;
//   3. 文本能被标准解析器吃下(round-trip)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  metricsText, escapeLabel, formatNumber, foldApp, foldStatusClass, foldWire,
} = require('../lib/observability/metrics');
const { createRequestLog: createRequestLog2 } = require('../lib/observability/request-log');

const fs = require('node:fs');
const os = require('node:os');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-obs-m-'));
const entry = over => ({
  ts: '2026-09-19T10:00:00.000Z', app: 'claude', provider: 'FAKE-p', model_in: 'm', model_out: 'm',
  session: 's', status: 200, wire: 'anthropic', ms: 100, in: 1, out: 2, attempts: 1, failover: false, ...over,
});

// ---- 自造解析器:只认 Prometheus 文本格式的合法子集,用来做 round-trip ----
function parseProm(text) {
  const samples = [];
  const types = {};
  const helps = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# TYPE ')) {
      const [, , name, type] = line.split(/\s+/);
      types[name] = type;
      continue;
    }
    if (line.startsWith('# HELP ')) {
      const name = line.split(/\s+/)[2];
      helps[name] = line.slice(('# HELP ' + name + ' ').length);
      continue;
    }
    assert.equal(line.startsWith('#'), false, `无法解析的行: ${line}`);
    // name{labels} value  或 name value
    const m = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)(\{.*\})?\s+(-?[0-9.]+)$/);
    assert.ok(m, `样本行不合格式: ${line}`);
    const [, name, labelPart, value] = m;
    const labels = {};
    if (labelPart) {
      const body = labelPart.slice(1, -1);
      // 逐字符扫描,正确处理 \" \\ \n
      let i = 0;
      while (i < body.length) {
        const eq = body.indexOf('=', i);
        const key = body.slice(i, eq);
        assert.equal(body[eq + 1], '"', 'label 值必须带引号');
        let j = eq + 2, out = '';
        while (j < body.length) {
          const ch = body[j];
          if (ch === '\\') {
            const next = body[j + 1];
            out += next === 'n' ? '\n' : next;
            j += 2;
            continue;
          }
          if (ch === '"') break;
          out += ch; j++;
        }
        labels[key] = out;
        i = j + 2; // 跳过闭引号与逗号
      }
    }
    samples.push({ name, labels, value: Number(value) });
  }
  for (const s of samples) {
    assert.ok(types[s.name], `样本 ${s.name} 缺 # TYPE`);
    assert.ok(helps[s.name], `样本 ${s.name} 缺 # HELP`);
    assert.equal(/e[+-]?\d+$/i.test(String(s.value)), false, `数值不得用科学计数法: ${s.value}`);
  }
  return { samples, types, helps };
}
const find = (samples, name, labels = {}) => samples.find(s => s.name === name
  && Object.entries(labels).every(([k, v]) => s.labels[k] === v));

// 不变量:输出里绝不能出现重复的 (指标名, 标签集)。
// 这条比任何逐值断言都值钱 —— 它一次锁死"折算后没聚合"这一整类错误:
// 500/502/503 各自折成 5xx 后会输出三行标签集完全相同的序列,那是**非法**的
// Prometheus 文本(解析器要么报错要么任取一行,rate()/sum by() 全失真)。
// 自造解析器若是"后写覆盖前写"就不会报错,所以必须显式断言唯一性。
function assertNoDuplicateSeries(text) {
  const seen = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const key = line.slice(0, line.lastIndexOf(' '));
    assert.equal(seen.has(key), false, `重复序列(非法 Prometheus 输出): ${key}`);
    seen.set(key, true);
  }
  return seen.size;
}

test('不变量:折算后必须聚合,输出不得有重复的 (指标名, 标签集)', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = createRequestLog2({ file: path.join(root, 'logs', 'requests.jsonl'), capacity: 50 });
  // 三个都会折成 5xx 的原始状态码
  for (const s of [500, 502, 503]) log.append(entry({ status: s, wire: 'anthropic', ms: 5 }));
  const text = log.metrics();
  assertNoDuplicateSeries(text);
  const lines = text.split('\n').filter(l => l.startsWith('mixrouter_requests_total{'));
  assert.equal(lines.length, 1, `500/502/503 必须合成一行,实际 ${lines.length} 行`);
  assert.equal(lines[0].endsWith(' 3'), true, `计数应为 3,实际 ${lines[0]}`);
  parseProm(text);
});

test('不变量:手工喂入折算后会撞车的 duration 快照,输出仍无重复行', () => {
  // 'zed' 与 'yx' 都会折成 unknown。分位数**不能相加**,所以这里不可能"聚合出正确值",
  // 只能确定性地保留一行;关键是输出必须合法(无重复标签集)。
  const text = metricsText({
    counters: { requests: [], tokens: [], attempts: 0, failover: 0 },
    window: { capacity: 2, used: 2, duration: [
      { app: 'zed', quantile: '0.5', value: 11, samples: 1 },
      { app: 'yx', quantile: '0.5', value: 99, samples: 4 },
    ] },
  });
  assertNoDuplicateSeries(text);
  const samples = parseProm(text).samples.filter(s => s.name === 'mixrouter_request_duration_ms');
  assert.equal(samples.length, 1, '撞车后只能留一行,绝不能两行同标签');
  assert.equal(samples[0].labels.app, 'unknown');
  assert.equal(samples[0].value, 99, '确定性保留策略:样本多的优先');
});

test('不变量:折算后的 requests 撞车也要聚合(手工未折算快照)', () => {
  const text = metricsText({
    counters: { requests: [
      { app: 'claude', status_class: '500', wire: 'anthropic', count: 2 },
      { app: 'claude', status_class: '502', wire: 'anthropic', count: 3 },
    ], tokens: [
      { app: 'zed', direction: 'in', count: 1 },
      { app: 'yx', direction: 'in', count: 4 },
    ], attempts: 0, failover: 0 },
    window: { capacity: 1, used: 1, duration: [] },
  });
  assertNoDuplicateSeries(text);
  const { samples } = parseProm(text);
  assert.equal(find(samples, 'mixrouter_requests_total', { status_class: '5xx' }).value, 5, '折算后求和');
  assert.equal(find(samples, 'mixrouter_tokens_total', { app: 'unknown' }).value, 5, 'app 折算后求和');
});

test('store 侧就已折算:wire 空串落成 none,原始状态码不再进入计数器键', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = createRequestLog2({ file: path.join(root, 'logs', 'requests.jsonl') });
  log.append(entry({ wire: '', status: 200 }));
  log.append(entry({ wire: 'FAKE-wire', status: 0 }));
  const snap = log.metricsSnapshot();
  for (const row of snap.counters.requests) {
    assert.ok(['claude', 'codex', 'unknown'].includes(row.app), `app 必须已折算: ${row.app}`);
    assert.ok(['2xx', '3xx', '4xx', '5xx', 'other'].includes(row.status_class), `status_class 必须已折算: ${row.status_class}`);
    assert.ok(['anthropic', 'responses', 'chat', 'none'].includes(row.wire), `wire 必须已折算: ${row.wire}`);
  }
  assert.equal(snap.counters.requests.some(r => r.status_class === '200'), false, '不得残留原始状态码');
  assert.equal(snap.counters.requests.some(r => r.wire === ''), false, '不得残留空串 wire');
  // 缺 app 按 claude(既有语义),不是 unknown
  assert.equal(snap.counters.requests.every(r => r.app === 'claude'), true);
});

test('duration 按折算后的 app 合并算分位数(不是各算再撞车)', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = createRequestLog2({ file: path.join(root, 'logs', 'requests.jsonl') });
  // 两个非标准 app 都会折成 unknown;样本应合进同一组,分位数在合并样本上算
  log.append(entry({ app: 'zed', ms: 10 }));
  log.append(entry({ app: 'yx', ms: 20 }));
  log.append(entry({ app: 'yx', ms: 30 }));
  const duration = log.metricsSnapshot().window.duration.filter(d => d.app === 'unknown');
  assert.equal(duration.length, 2, 'unknown 下应有 0.5 与 0.95 两个分位数');
  assert.equal(duration.every(d => d.samples === 3), true, '样本应合并为 3(不是各自 1 和 2)');
  assert.equal(duration.find(d => d.quantile === '0.95').value, 30);
  assertNoDuplicateSeries(log.metrics());
});

test('折算必须幂等:store 已折过一次,metricsText 再折一次不得变样', () => {
  // 踩过的坑:metricsText 作为第二层防御会再折一次,若不认已折算的 '5xx',
  // Number('5xx')=NaN 会被误折成 other —— 于是 store 正确送出 5xx,输出变成 other。
  for (const v of ['2xx', '3xx', '4xx', '5xx', 'other']) {
    assert.equal(foldStatusClass(v), v, `${v} 二次折算必须不变`);
  }
  assert.equal(foldStatusClass(500), '5xx');
  assert.equal(foldStatusClass(0), 'other');
  // 端到端:store 折过之后,文本里的值必须仍是 5xx
  const log = createRequestLog2({ capacity: 4 });
  for (const s of [500, 502, 503]) log.append(entry({ status: s }));
  const { samples } = parseProm(log.metrics());
  assert.equal(find(samples, 'mixrouter_requests_total', { status_class: '5xx' }).value, 3);
  assert.equal(find(samples, 'mixrouter_requests_total', { status_class: 'other' }), undefined);
});

test('转义:反斜杠、双引号、换行都能 round-trip 回原值', () => {
  const nasty = 'a\\b"c\nd';
  assert.equal(escapeLabel(nasty), 'a\\\\b\\"c\\nd');
  const text = metricsText({
    counters: { requests: [{ app: 'claude', status_class: '2xx', wire: 'anthropic', count: 1 }], tokens: [], attempts: 0, failover: 0 },
    window: { capacity: 1, used: 1, duration: [] },
  });
  parseProm(text); // 基本形态可解析
  // 把带特殊字符的值塞进 label,验证解析器能还原
  const direct = `mixrouter_requests_total{app="x",status_class="2xx",wire="none"} 1\n`;
  const parsed = parseProm(`# HELP mixrouter_requests_total h\n# TYPE mixrouter_requests_total counter\n${direct}`);
  assert.equal(parsed.samples[0].labels.status_class, '2xx');
});

test('HELP/TYPE 齐全,空快照也输出合法文本', () => {
  const text = metricsText({ counters: { requests: [], tokens: [], attempts: 0, failover: 0 }, window: { capacity: 0, used: 0, duration: [] } });
  assert.ok(text.endsWith('\n'));
  const { types, samples } = parseProm(text);
  for (const name of ['mixrouter_requests_total', 'mixrouter_tokens_total', 'mixrouter_attempts_total',
    'mixrouter_failover_total', 'mixrouter_log_window', 'mixrouter_request_duration_ms']) {
    assert.ok(types[name], `${name} 缺 # TYPE`);
  }
  assert.equal(text.includes('NaN'), false, '绝不许把 NaN 写进文本');
  assert.equal(text.includes('Infinity'), false);
  assert.ok(samples.length >= 3);
});

test('窗口量一律 gauge,counter 才用 _total:分类不许混', () => {
  const text = metricsText({
    counters: { requests: [{ app: 'claude', status_class: '2xx', wire: 'anthropic', count: 5 }], tokens: [{ app: 'claude', direction: 'in', count: 9 }], attempts: 4, failover: 1 },
    window: { capacity: 500, used: 7, duration: [{ app: 'claude', quantile: '0.5', value: 12.5, samples: 3 }] },
  });
  const { types } = parseProm(text);
  assert.equal(types.mixrouter_requests_total, 'counter');
  assert.equal(types.mixrouter_tokens_total, 'counter');
  assert.equal(types.mixrouter_attempts_total, 'counter');
  assert.equal(types.mixrouter_failover_total, 'counter');
  assert.equal(types.mixrouter_log_window, 'gauge', '窗口水位必须是 gauge');
  assert.equal(types.mixrouter_request_duration_ms, 'gauge', '窗口分位数必须是 gauge');
  // 不许出现会被当成 counter 读的伴随序列
  assert.equal(text.includes('mixrouter_request_duration_ms_sum'), false);
  assert.equal(text.includes('mixrouter_request_duration_ms_count'), false);
  assert.equal(types.mixrouter_log_window_sum, undefined);
});

test('label 基数有界:越界值折成 unknown/none/other,长名不得进 label', () => {
  assert.equal(foldApp('codex'), 'codex');
  assert.equal(foldApp('FAKE-'.repeat(50)), 'unknown');
  assert.equal(foldWire('chat'), 'chat');
  assert.equal(foldWire(''), 'none');
  assert.equal(foldWire('FAKE-wire'), 'none');
  assert.equal(foldStatusClass(200), '2xx');
  assert.equal(foldStatusClass(404), '4xx');
  assert.equal(foldStatusClass(503), '5xx');
  assert.equal(foldStatusClass(0), 'other');
  assert.equal(foldStatusClass(499), 'other', '499 是本项目的客户端取消,不是 4xx');
  const longProvider = 'P'.repeat(500);
  const longSession = 'S'.repeat(500);
  const text = metricsText({
    // 即使调用方硬把长名塞进 app/wire,也必须被折掉
    counters: { requests: [{ app: longProvider, status_class: 200, wire: longSession, count: 1 }], tokens: [], attempts: 0, failover: 0 },
    window: { capacity: 1, used: 1, duration: [{ app: longProvider, quantile: '0.5', value: 1, samples: 1 }] },
  });
  assert.equal(text.includes(longProvider), false, '长 provider 名不得进 label');
  assert.equal(text.includes(longSession), false, '长 session 名不得进 label');
  parseProm(text);
});

test('counter 不回退:append 超过 ring 容量后 requests_total 仍是全部次数', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = createRequestLog2({ file: path.join(root, 'logs', 'requests.jsonl'), capacity: 3 });
  for (let i = 0; i < 5; i++) log.append(entry({ ms: i + 1 }));
  const snap = log.metricsSnapshot();
  const total = snap.counters.requests.reduce((sum, r) => sum + r.count, 0);
  assert.equal(total, 5, 'counter 必须等于全部 append 次数,不因淘汰回退');
  assert.equal(snap.window.used, 3, '窗口 gauge 等于容量');
  const parsed = parseProm(metricsText(snap));
  assert.equal(find(parsed.samples, 'mixrouter_requests_total').value, 5);
  assert.equal(find(parsed.samples, 'mixrouter_log_window', { kind: 'used' }).value, 3);
  assert.equal(find(parsed.samples, 'mixrouter_log_window', { kind: 'capacity' }).value, 3);
});

test('单调性:连续两次抓取之间只 append,四个 counter 都不回退', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = createRequestLog2({ file: path.join(root, 'logs', 'requests.jsonl'), capacity: 500 });
  log.append(entry({ attempts: 2, failover: true }));
  const before = parseProm(metricsText(log.metricsSnapshot())).samples;
  for (let i = 0; i < 3; i++) log.append(entry({ attempts: 1, failover: true }));
  const after = parseProm(metricsText(log.metricsSnapshot())).samples;
  for (const name of ['mixrouter_requests_total', 'mixrouter_tokens_total', 'mixrouter_attempts_total', 'mixrouter_failover_total']) {
    const sum = list => list.filter(s => s.name === name).reduce((a, s) => a + s.value, 0);
    assert.ok(sum(after) >= sum(before), `${name} 不得回退`);
  }
  assert.equal(find(after, 'mixrouter_attempts_total').value, 5);
  assert.equal(find(after, 'mixrouter_failover_total').value, 4);
});

test('窗口淘汰后 counter 仍单调,而窗口分位数只反映窗口内样本', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = createRequestLog2({ file: path.join(root, 'logs', 'requests.jsonl'), capacity: 2 });
  // 先塞两条慢的(会被淘汰),再塞两条快的
  log.append(entry({ ms: 900 })); log.append(entry({ ms: 800 }));
  log.append(entry({ ms: 10 })); log.append(entry({ ms: 20 }));
  const snap = log.metricsSnapshot();
  assert.equal(snap.counters.requests.reduce((a, r) => a + r.count, 0), 4, 'counter 记全部 4 次');
  const p95 = snap.window.duration.find(d => d.quantile === '0.95');
  assert.equal(p95.value, 20, '窗口分位数只看窗口内样本,不看已淘汰的慢请求');
  assert.equal(p95.samples, 2);
});

test('metricsSnapshot 是纯读:不改 ring、不落盘', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'requests.jsonl');
  const log = createRequestLog2({ file });
  log.append(entry());
  const sizeBefore = fs.statSync(file).size;
  const ringBefore = log._ring.length;
  const countersBefore = JSON.stringify([...log._counters.requests]);
  log.metricsSnapshot(); log.metrics(); log.metricsSnapshot();
  assert.equal(log._ring.length, ringBefore);
  assert.equal(fs.statSync(file).size, sizeBefore, '快照不得写盘');
  assert.equal(JSON.stringify([...log._counters.requests]), countersBefore, '快照不得改计数器');
});

test('数值格式:整数不带小数,小数不带科学计数法,非有限整行不输出', () => {
  assert.equal(formatNumber(5), '5');
  assert.equal(formatNumber(5.0), '5');
  assert.equal(formatNumber(12.5), '12.5');
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
  assert.equal(formatNumber(NaN), null);
  assert.equal(formatNumber(Infinity), null);
  assert.equal(formatNumber(1e21), null);
  const text = metricsText({
    counters: { requests: [], tokens: [], attempts: NaN, failover: Infinity },
    window: { capacity: 1, used: 1, duration: [{ app: 'claude', quantile: '0.5', value: NaN, samples: 0 }] },
  });
  assert.equal(text.includes('NaN'), false);
  assert.equal(text.includes('Infinity'), false);
  // 按**解析后的样本**断言,不按裸子串:HELP/TYPE 行里本来就含指标名
  const parsed = parseProm(text);
  assert.equal(find(parsed.samples, 'mixrouter_attempts_total'), undefined, '非有限值不该输出该样本行');
  assert.equal(find(parsed.samples, 'mixrouter_failover_total'), undefined);
  assert.ok(parsed.types.mixrouter_attempts_total, 'TYPE 行仍在(只是没有样本)');
  assert.equal(find(parsed.samples, 'mixrouter_request_duration_ms'), undefined);
  assert.equal(/e[+-]?\d/i.test(text), false, '不得出现科学计数法');
});

test('输出确定性:同一快照两次编码逐字节相同且行序稳定', () => {
  const snap = {
    counters: {
      requests: [
        { app: 'codex', status_class: '5xx', wire: 'chat', count: 2 },
        { app: 'claude', status_class: '2xx', wire: 'anthropic', count: 1 },
      ],
      tokens: [{ app: 'codex', direction: 'out', count: 3 }, { app: 'claude', direction: 'in', count: 4 }],
      attempts: 1, failover: 0,
    },
    window: { capacity: 10, used: 2, duration: [{ app: 'codex', quantile: '0.95', value: 5, samples: 1 }, { app: 'claude', quantile: '0.5', value: 7, samples: 1 }] },
  };
  const a = metricsText(snap); const b = metricsText(JSON.parse(JSON.stringify(snap)));
  assert.equal(a, b);
  // 行序按 key 排序:claude 必须排在 codex 之前
  assert.ok(a.indexOf('app="claude"') < a.indexOf('app="codex"'), '行序必须确定可 diff');
});
