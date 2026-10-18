'use strict';
// log-tail 的行尾读取回归:全部用 mkdtemp 合成数据,不碰现役 logs/、不碰真实配置。
// 核心断言两类:
//   1. 等价 —— 尾部 N 条的选取与解析,与 mixctl logs 旧实现 `readFileSync().trim().split('\n').slice(-n)`
//      的结果逐条相等(内容与顺序都一致)。
//   2. 有界 —— 大文件取少量尾行时实际读取的字节数远小于文件大小;且读取量随 N 而非文件大小增长。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readTailLines, readTailEntries, selectLogs, resolveCount, formatLogLine,
  DEFAULT_MAX_BYTES,
} = require('../lib/observability/log-tail');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-tail-'));
const at = i => ({ ts: `2026-09-19T10:${String(i % 60).padStart(2, '0')}:00.000Z`, app: i % 2 ? 'codex' : 'claude', provider: 'FAKE-渠道', model_in: 'm-in-' + i, model_out: 'm-out-' + i, in: i, out: i * 2, ms: i, status: 200 });

// 旧实现:全量读 → trim → split → 尾 N 行 → 逐行 JSON.parse(任一坏行即整批抛出)。
// 等价性测试只用全部可解析的内容,这里才拿得到"旧实现的成功输出"。
function refTail(file, n) {
  const text = fs.readFileSync(file, 'utf8');
  const trimmed = text.trim();
  const lines = trimmed === '' ? [] : trimmed.split('\n');
  return lines.slice(-Number(n)).map(l => JSON.parse(l));
}

test('尾部读取与旧全量实现逐条一致(含无尾换行/多尾换行/CRLF/前导空行)', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const body = Array.from({ length: 40 }, (_, i) => JSON.stringify(at(i))).join('\n');
  const variants = {
    '无尾换行': body,
    '单尾换行': body + '\n',
    '多尾换行': body + '\n\n\n',
    '前导空行': '\n\n' + body + '\n',
    'CRLF 行尾': Array.from({ length: 40 }, (_, i) => JSON.stringify(at(i))).join('\r\n') + '\r\n',
  };
  for (const [name, text] of Object.entries(variants)) {
    const file = path.join(root, name + '.jsonl');
    fs.writeFileSync(file, text);
    for (const n of [1, 2, 5, 20, 40, 41, 500]) {
      assert.deepEqual(selectLogs(file, n).entries, refTail(file, n), `${name} / n=${n} 应与旧实现一致`);
    }
  }
});

test('有界:大文件取少量尾行,实际读取量远小于文件大小', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.jsonl');
  const rows = [];
  for (let i = 0; i < 20000; i++) rows.push(JSON.stringify(at(i)));
  fs.writeFileSync(file, rows.join('\n') + '\n');
  const size = fs.statSync(file).size;
  assert.ok(size > 1024 * 1024, '合成文件应达到 MB 级,才谈得上读放大');

  const small = readTailEntries(file, { limit: 5 });
  assert.equal(small.entries.length, 5);
  // 只读最后一个块(默认 64KB)即可
  assert.ok(small.bytesRead <= 64 * 1024, `读 ${small.bytesRead} 字节应远小于文件大小`);
  assert.ok(size / small.bytesRead > 10, `读放大应显著:size=${size} read=${small.bytesRead}`);
  // 输出仍与旧实现一致
  assert.deepEqual(selectLogs(file, 5).entries, refTail(file, 5));

  // 读取量随 N 而非文件大小:要 500 行仍应远小于 2MB 文件
  const bigger = readTailEntries(file, { limit: 500 });
  assert.equal(bigger.entries.length, 500);
  assert.ok(bigger.bytesRead < size / 2, `取 500 行仍应远小于整份:read=${bigger.bytesRead} size=${size}`);
});

test('坏行容忍:损坏行被跳过而非整批失败', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.jsonl');
  const good = i => JSON.stringify(at(i));
  fs.writeFileSync(file, [
    good(1), '{ 这不是合法 JSON', good(2), '', good(3), ']', good(4), good(5),
  ].join('\n') + '\n');

  // 旧实现:循环里第一处 JSON.parse 抛错 → 整批被 catch 吞掉变为「暂无请求日志」
  let oldThrew = false;
  try { refTail(file, 3); } catch { oldThrew = true; }
  assert.equal(oldThrew, true, '旧实现对坏行会整批抛出(证明新行为不是等价退化)');

  // 新实现:跳过坏行,最后 3 条可解析记录照常给出(按文件顺序)
  const got = selectLogs(file, 3).entries;
  assert.deepEqual(got.map(e => e.model_in), ['m-in-3', 'm-in-4', 'm-in-5']);
  // 窗口内坏行多时继续向前扫描,凑够 N 条。
  assert.equal(selectLogs(file, 5).entries.length, 5);
});

test('分块小于单行:跨块的非末行仍被拼回完整行', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.jsonl');
  const rows = Array.from({ length: 30 }, (_, i) => JSON.stringify(at(i)));
  fs.writeFileSync(file, rows.join('\n') + '\n');
  // chunkSize=7,远小于一行;拿到的行必须完整、且最后一条等于文件最后一条
  const { entries } = readTailEntries(file, { limit: 4, chunkSize: 7 });
  assert.equal(entries.length, 4);
  assert.deepEqual(entries, refTail(file, 4));
});

test('非整数、非正数与非有限计数保留旧 slice 语义', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.jsonl');
  const rows = Array.from({ length: 8 }, (_, i) => JSON.stringify(at(i)));
  fs.writeFileSync(file, rows.join('\n') + '\n');
  // |n|<1 / NaN → 全部;负数从文件开头跳过对应条数。
  for (const n of [NaN, 0, -3, 0.5, 1.5, -0.5, -2.5, Infinity, -Infinity]) {
    assert.deepEqual(selectLogs(file, n).entries, refTail(file, n), `n=${n}`);
  }
});

function trackReads(fn, read = fs.readSync) {
  const original = fs.readSync;
  const calls = [];
  fs.readSync = (fd, buffer, offset, length, position) => {
    const bytes = read(fd, buffer, offset, length, position);
    calls.push({ position, length, bytes });
    return bytes;
  };
  try { return { result: fn(), calls, bytes: calls.reduce((n, call) => n + call.bytes, 0) }; }
  finally { fs.readSync = original; }
}

test('maxBytes 严格约束实际 I/O,包含边界检查且不按块超读', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.jsonl');
  fs.writeFileSync(file, Array.from({ length: 1000 }, (_, i) => JSON.stringify(at(i))).join('\n') + '\n');
  for (const maxBytes of [1, 1001, 65536]) {
    const measured = trackReads(() => readTailLines(file, { maxLines: 2, maxBytes }));
    assert.equal(measured.result.bytesRead, measured.bytes, '报告值必须包含每一次 readSync');
    assert.ok(measured.bytes <= maxBytes, `实读 ${measured.bytes} 不得超过上限 ${maxBytes}`);
  }
});

test('大量坏行只扫描一次,不会反复读取同一窗口或漏计 I/O', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.jsonl');
  fs.writeFileSync(file, JSON.stringify(at(1)) + '\n' + '{bad}\n'.repeat(3000));
  const maxBytes = 8191;
  const measured = trackReads(() => readTailEntries(file, { limit: 3, maxBytes, chunkSize: 1024 }));
  assert.deepEqual(measured.result.entries, []);
  assert.equal(measured.result.truncated, true);
  assert.equal(measured.result.bytesRead, measured.bytes);
  assert.ok(measured.bytes <= maxBytes);
  const positions = measured.calls.map(call => call.position);
  assert.equal(new Set(positions).size, positions.length, '坏行不触发重复尾读');
});

test('短读按返回字节数继续补齐,UTF-8 跨读取不损坏', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.jsonl');
  fs.writeFileSync(file, Array.from({ length: 8 }, (_, i) => JSON.stringify(at(i))).join('\n') + '\n');
  const read = fs.readSync;
  const measured = trackReads(() => readTailEntries(file, { limit: 3, chunkSize: 64 }),
    (fd, buffer, offset, length, position) => {
      buffer.fill(0x3f, offset, offset + length);
      return read(fd, buffer, offset, Math.min(length, 7), position);
    });
  assert.deepEqual(measured.result.entries, refTail(file, 3));
  assert.equal(measured.result.bytesRead, measured.bytes);
});

test('读取期间被截短时停止,不解析未填充的 Buffer', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.jsonl');
  fs.writeFileSync(file, JSON.stringify(at(1)) + '\n');
  const measured = trackReads(() => readTailEntries(file, { limit: 1 }),
    (_fd, buffer) => { buffer.fill(Buffer.from(JSON.stringify(at(999)) + '\n')); return 0; });
  assert.deepEqual(measured.result.entries, []);
  assert.equal(measured.result.bytesRead, 0);
  assert.equal(measured.result.truncated, true);
});

test('缺失文件:missing=true,不抛', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'nope.jsonl');
  assert.equal(selectLogs(file, 5).missing, true);
  assert.equal(readTailEntries(file).missing, true);
  assert.deepEqual(readTailLines(file).lines, []);
});

test('超长单行:正文照常取到(证明分块拼接对超长行成立)', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.jsonl');
  const table = ['x'.repeat(200000)];
  const big = JSON.stringify({ ...at(1), err: 'y'.repeat(200000) });
  fs.appendFileSync(file, table.join('\n') + '\n' + big + '\n');
  const { entries, bytesRead } = readTailEntries(file, { limit: 1 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].model_in, 'm-in-1');
  assert.equal(entries[0].err.length, 200000, '超长行正文应完整拼回');
  assert.ok(bytesRead <= DEFAULT_MAX_BYTES, '读取量受 maxBytes 兜底');
});

test('readTailLines 如实报告 truncated 与 bytesRead', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.jsonl');
  fs.writeFileSync(file, Array.from({ length: 1000 }, (_, i) => JSON.stringify(at(i))).join('\n') + '\n');
  const tail = readTailLines(file, { maxLines: 2 });
  assert.equal(tail.truncated, true);
  assert.equal(tail.lines.length, 2);
  assert.ok(tail.bytesRead < tail.size);
  assert.ok(tail.bytesRead <= DEFAULT_MAX_BYTES);
  // 从头就够:小文件取足够多行时 truncated=false
  const all = readTailLines(file, { maxLines: 5000 });
  assert.equal(all.truncated, false);
});

test('formatLogLine 与旧内联模板逐字节一致', () => {
  const sample = {
    ts: '2026-09-19T10:30:00.000Z', app: 'codex', session: 'sess-1234567890', provider: 'FAKE-渠道',
    model_in: 'm-in', model_out: 'm-out', in: 10, out: 20, ms: 123, status: 200, failover: true,
    wire: 'chat', kind: 'responses', err: 'boom',
  };
  const tr = (sample.wire === 'chat' && sample.kind === 'responses') ? ' ⇄翻译' : '';
  const expected = `${sample.ts.slice(5, 19)}  ${(sample.app === 'codex' ? 'Cx' : 'CC').padEnd(3)}${String(sample.session || '-').padEnd(10)}${String(sample.provider).padEnd(16)} ${sample.model_in} → ${sample.model_out}  in ${sample.in} out ${sample.out}  ${sample.ms}ms  ${sample.status}${sample.failover ? ' ↷转移' : ''}${tr}${sample.err ? '  ' + sample.err : ''}`;
  assert.equal(formatLogLine(sample), expected);
  // 缺 session/err 时的兜底与旧模板一致
  const bare = { ts: '2026-09-19T10:30:00.000Z', app: 'claude', provider: 'p', model_in: 'a', model_out: 'b', in: 1, out: 2, ms: 0, status: 0 };
  const expBare = `${bare.ts.slice(5, 19)}  ${'CC'.padEnd(3)}${'-'.padEnd(10)}${'p'.padEnd(16)} a → b  in 1 out 2  0ms  0`;
  assert.equal(formatLogLine(bare), expBare);
});

test('resolveCount:只有缺省参数用 20,其余保留旧 Number() 语义', () => {
  assert.equal(resolveCount(undefined), 20);
  assert.equal(resolveCount(null), 0);
  assert.equal(resolveCount(''), 0);
  assert.equal(resolveCount('5'), 5);
  assert.equal(resolveCount('abc'), NaN);
});

test('达到字节上限时显式报告 incomplete,不把不完整尾读当成全部记录', t => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.jsonl');
  fs.writeFileSync(file, [at(1), at(2), at(3)].map(e => JSON.stringify(e)).join('\n') + '\n');
  assert.equal(selectLogs(file, 3, { maxBytes: 200 }).incomplete, true);
  assert.equal(selectLogs(file, 1, { maxBytes: 200 }).incomplete, false);
  assert.equal(selectLogs(file, 10).incomplete, false, '完整文件不足 N 条不是截断');
});

test('零第三方依赖:模块只 require node: 内置', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../lib/observability/log-tail.js'), 'utf8');
  for (const m of source.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
    assert.ok(m[2].startsWith('node:') || m[2].startsWith('.'), `引入了非内置依赖: ${m[2]}`);
  }
  const mixctl = fs.readFileSync(path.resolve(__dirname, '../mixctl'), 'utf8');
  assert.match(mixctl, /require\('\.\/lib\/observability\/log-tail'\)/, 'mixctl 应复用 log-tail');
  assert.doesNotMatch(mixctl, /readFileSync\(REQ_LOG/, 'mixctl logs 不应再整体读 REQ_LOG');
});
