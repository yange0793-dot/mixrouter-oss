'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { performance } = require('node:perf_hooks');
const { bufferText, headTailUsage } = require('../lib/upstream-collect');
// npm test 的隔离入口先重定向 HOME/配置/日志；只 require，不启动服务。
const { extractUsageFor } = require('../mixrouter');

const W = 128 * 1024;
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const chunksOf = (bytes, size) => {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
  return chunks;
};

function sample(chunks) {
  const upstream = new EventEmitter();
  let text, calls = 0, writes = 0;
  headTailUsage(upstream, {
    write(chunk) {
      assert.strictEqual(chunk, chunks[writes++], '逐块透传同一个 Buffer，不插入采样缺口');
      return false; // 与旧路径一样，不在 collector 里另建背压机制。
    },
  }, value => { text = value; calls++; });
  for (const chunk of chunks) upstream.emit('data', chunk);
  upstream.emit('end');
  assert.equal(calls, 1);
  assert.equal(writes, chunks.length);
  assert.equal(upstream.listenerCount('data'), 0);
  return text;
}

// 参考只在测试里用全文：保留两段窗口；仅有缺口时裁去被切断的行。
function reference(bytes) {
  if (bytes.length <= W * 2) return bytes.toString('utf8');
  const head = bytes.subarray(0, W);
  const tail = bytes.subarray(bytes.length - W);
  const end = Math.max(head.lastIndexOf(10), head.lastIndexOf(13)) + 1;
  let start = 0;
  const before = bytes[bytes.length - W - 1];
  if (before !== 10 && before !== 13) {
    while (start < tail.length && tail[start] !== 10 && tail[start] !== 13) start++;
    if (start < tail.length) start++;
  }
  return Buffer.concat([head.subarray(0, end), Buffer.from([0]), tail.subarray(start)]).toString('utf8');
}

function exactComment(size, end = '\n') {
  return ':' + 'x'.repeat(size - end.length - 1) + end;
}

const protocols = {
  anthropic: {
    early: event({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 } } }),
    final: event({ type: 'message_delta', usage: { input_tokens: 12345, output_tokens: 6789, cache_read_input_tokens: 23 } }),
    ending: event({ type: 'message_stop' }), input: 'input_tokens',
  },
  responses: {
    early: event({ type: 'response.created', response: { usage: { input_tokens: 1, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } } } }),
    final: event({ type: 'response.completed', response: { usage: { input_tokens: 12345, output_tokens: 6789, input_tokens_details: { cached_tokens: 23 } } } }),
    ending: '', input: 'input_tokens',
  },
  chat: {
    early: event({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } } }),
    final: event({ choices: [], usage: { prompt_tokens: 12345, completion_tokens: 6789, prompt_tokens_details: { cached_tokens: 23 } } }),
    ending: 'data: [DONE]\n\n', input: 'prompt_tokens',
  },
};

for (const [kind, p] of Object.entries(protocols)) {
  test(`headTailUsage:${kind} 短/长流均取末次 usage，跨网络块不变`, () => {
    for (const padding of ['', exactComment(2 * 1024 * 1024)]) {
      const bytes = Buffer.from(p.early + padding + p.final + p.ending);
      for (const size of [71, 65537, bytes.length]) {
        const text = sample(chunksOf(bytes, size));
        assert.equal(text, reference(bytes));
        assert.deepEqual(extractUsageFor(kind, text), { in: 12345, out: 6789, cache_read: 23 });
        assert.ok(Buffer.byteLength(text) <= W * 2 + 1);
      }
    }
  });

  for (const prefix of [`data: {"usage":{"${p.input}":12`, `data: {"usage":{"${p.input}":`, 'data: {"usage":{"']) {
    test(`headTailUsage:${kind} 截断数字/冒号/字段边界 ${JSON.stringify(prefix)}`, () => {
      const head = exactComment(W - prefix.length) + prefix;
      const middle = prefix.endsWith(':12') ? '345},"padding":"' : prefix.endsWith(':') ? '12345},"padding":"' : `${p.input}":12345},"padding":"`;
      const suffix = '34}\n';
      const bytes = Buffer.from(head + middle + 'p'.repeat(W * 2) + '","count":' + suffix + exactComment(W - suffix.length));
      // 完整的 data 行是真 JSON；被删中段不能把 12+34 合为 1234，也不能留下截半的 12。
      JSON.parse(bytes.toString().split('\n').find(line => line.startsWith('data:')).slice(5));
      assert.equal(extractUsageFor(kind, bytes.toString()).in, 12345);
      for (const size of [19, W - 1, W, W + 1, bytes.length]) {
        const text = sample(chunksOf(bytes, size));
        assert.equal(text, reference(bytes));
        assert.equal(extractUsageFor(kind, text).in, 0, '整条跨缺口的行丢弃，不返回虚构或截半数字');
        assert.ok(text.includes('\0'));
      }
    });
  }
}

test('headTailUsage:Anthropic 头部输入/缓存与尾部仅输出的 usage 合并', () => {
  const bytes = Buffer.from(event({ type: 'message_start', message: { usage: { input_tokens: 17, cache_read_input_tokens: 5 } } }) +
    exactComment(2 * W) + event({ type: 'message_delta', usage: { output_tokens: 9 } }));
  assert.deepEqual(extractUsageFor('anthropic', sample(chunksOf(bytes, 97))), { in: 17, out: 9, cache_read: 5 });
});

test('headTailUsage:中文/四字节字符逐字节分片，短流保持全文', () => {
  const bytes = Buffer.from(event({ text: '中文跨块，𠮷字也完整', usage: { input_tokens: 12 } }));
  assert.equal(sample(chunksOf(bytes, 1)), bytes.toString());
  for (let split = 0; split <= bytes.length; split++) {
    assert.equal(sample([bytes.subarray(0, split), bytes.subarray(split)]), bytes.toString());
  }
});

test('headTailUsage:短流达到两窗上限，字符跨头尾分界仍完整', () => {
  const bytes = Buffer.from('x'.repeat(W - 1) + '中𠮷' + 'y'.repeat(W - 6));
  assert.equal(bytes.length, 2 * W);
  for (const size of [1, 17, W - 1, W, W + 1, bytes.length]) {
    assert.equal(sample(chunksOf(bytes, size)), bytes.toString());
  }
});

test('headTailUsage:常见短响应在所有双块切点保持全文', () => {
  const bytes = Buffer.from(event({ text: '跨块中文𠮷'.repeat(100), usage: { input_tokens: 17 } }));
  for (let split = 0; split <= bytes.length; split++) {
    assert.equal(sample([bytes.subarray(0, split), bytes.subarray(split)]), bytes.toString());
  }
});

test('headTailUsage:尾窗逐出字节记号在整窗替换和部分填充时正确', () => {
  const ending = Buffer.from(protocols.responses.final + exactComment(W - Buffer.byteLength(protocols.responses.final)));
  const head = Buffer.from(exactComment(W));
  for (const skipped of ['x\n', exactComment(W), exactComment(W * 2)]) {
    const middle = Buffer.from(skipped);
    assert.deepEqual(extractUsageFor('responses', sample([head, middle, ending])), { in: 12345, out: 6789, cache_read: 23 });
  }
  // 被逐出的最后一个字节不是换行：尾窗开头虽然长得像完整 usage，实为残行。
  const partial = Buffer.from('data: {"discarded":');
  assert.equal(extractUsageFor('responses', sample([head, partial, ending])).in, 0);
});

test('headTailUsage:空流、空块与损坏 UTF-8 保持 Buffer 全文解码语义', () => {
  assert.equal(sample([]), '');
  assert.equal(sample([Buffer.alloc(0), Buffer.alloc(0)]), '');
  const bytes = Buffer.from([0x61, 0xe4, 0xb8]);
  assert.equal(sample(chunksOf(bytes, 1)), bytes.toString());
});

test('headTailUsage:刚超上限一字节、CRLF/CR/LF 行首与环绕位置正确', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const usage = protocols.responses.final.replace(/\n/g, newline);
    const head = exactComment(W, newline);
    const tail = usage + exactComment(W - Buffer.byteLength(usage), newline);
    for (const middle of [newline, exactComment(W, newline), exactComment(W * 2 + 137, newline)]) {
      const bytes = Buffer.from(head + middle + tail);
      for (const size of [101, W - 1, W, W + 1, bytes.length]) {
        const text = sample(chunksOf(bytes, size));
        assert.equal(text, reference(bytes));
        assert.deepEqual(extractUsageFor('responses', text), { in: 12345, out: 6789, cache_read: 23 });
      }
    }
  }
});

test('headTailUsage:随机块大小覆盖尾环绕/大块替换，采样结果与全文参考一致', () => {
  let seed = 1234567;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const bytes = Buffer.from((event({ text: '跨块中文𠮷', usage: { input_tokens: 7 } }) + exactComment(733)).repeat(1300));
  for (let run = 0; run < 12; run++) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length;) {
      const length = 1 + random(W * 3);
      chunks.push(bytes.subarray(offset, offset + length));
      offset += length;
    }
    assert.equal(sample(chunks), reference(bytes));
  }
});

test('headTailUsage:长流 UTF-8 的采样边界裁掉残行，不输出截断字符', () => {
  const bytes = Buffer.from(exactComment(W - 1) + '中' + 'x'.repeat(W * 2) + '𠮷\n' +
    protocols.chat.final + exactComment(W - Buffer.byteLength('𠮷\n' + protocols.chat.final) + 2));
  const text = sample(chunksOf(bytes, 1001));
  assert.equal(text, reference(bytes));
  assert.ok(!text.includes('�'));
  assert.deepEqual(extractUsageFor('chat', text), { in: 12345, out: 6789, cache_read: 23 });
});

test('headTailUsage:usage 在超大单行前部或只在中段时不承诺恢复', () => {
  const singleLine = Buffer.from(event({ usage: { input_tokens: 12345 }, padding: 'x'.repeat(W * 3) }));
  assert.equal(extractUsageFor('responses', sample([singleLine])).in, 0);
  const middleOnly = Buffer.from(exactComment(W) + protocols.responses.final + exactComment(W * 2));
  assert.equal(extractUsageFor('responses', sample(chunksOf(middleOnly, 901))).in, 0);
});

test('collectors:真实流顺序与已有 end/error/close 监听兼容，不代替调用方收尾', async () => {
  for (const collect of [bufferText, (up, fn) => headTailUsage(up, { write() {} }, fn)]) {
    const up = new PassThrough();
    const order = [];
    up.on('end', () => order.push('existing-end'));
    up.on('error', () => order.push('existing-error'));
    up.on('close', () => order.push('existing-close'));
    const text = await new Promise(resolve => {
      collect(up, value => { order.push('callback'); resolve(value); });
      up.end(Buffer.from('中文'));
    });
    assert.equal(text, '中文');
    assert.deepEqual(order.slice(0, 2), ['existing-end', 'callback']);

    const failed = new PassThrough();
    let calls = 0;
    failed.on('error', () => order.push('error-handled'));
    collect(failed, () => calls++);
    const closed = new Promise(resolve => failed.once('close', resolve));
    failed.write(Buffer.from('partial'));
    failed.destroy(new Error('upstream failed'));
    await closed;
    assert.equal(calls, 0, '错误/取消不冒充完整 end，不补成功回调');
    assert.equal(order.at(-1), 'error-handled');
  }
});

test('collectors:正常 end 回调仅一次，不结束客户端响应', () => {
  for (const collect of [bufferText, (up, fn) => headTailUsage(up, { write() {}, end() { assert.fail('调用方负责 res.end'); } }, fn)]) {
    const up = new EventEmitter();
    let calls = 0;
    collect(up, () => calls++);
    up.emit('end');
    up.emit('end');
    assert.equal(calls, 1);
  }
});

test('bufferText:全文与空体保留，不隐式 trim、不截断、多字节跨块无损', () => {
  const bytes = Buffer.from(' \n' + '中文𠮷'.repeat(W) + '\n ');
  for (const chunks of [[], chunksOf(bytes, 91)]) {
    const up = new EventEmitter();
    let text;
    bufferText(up, value => { text = value; });
    for (const chunk of chunks) up.emit('data', chunk);
    up.emit('end');
    assert.equal(text, chunks.length ? bytes.toString() : '');
  }
});

// 合成性能证据，不设不稳定的速度门槛；不读取日志、不联网。
// 对比包含原始转发回调和最后 extractUsageFor，输入 Buffer 预先建好，不算入采样内存。
test('headTailUsage:合成 8MiB 的旧/新采样容量与耗时', t => {
  const source = Buffer.from(exactComment(1024).repeat(8 * 1024) + protocols.responses.final);
  function run(chunks, legacy) {
    const up = new EventEmitter();
    let text;
    const res = { write() {} };
    if (legacy) {
      let acc = '';
      up.on('data', c => { if (acc.length < 1024 * 1024) acc += c.toString('utf8'); res.write(c); });
      up.on('end', () => { text = acc; });
    } else headTailUsage(up, res, value => { text = value; });
    for (const chunk of chunks) up.emit('data', chunk);
    up.emit('end');
    return { chars: text.length, usage: extractUsageFor('responses', text) };
  }
  const median = numbers => numbers.sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
  for (const size of [65536, source.length]) {
    const chunks = chunksOf(source, size);
    const oldTimes = [], newTimes = [];
    let old, current;
    for (let i = 0; i < 9; i++) {
      let start = performance.now(); old = run(chunks, true); const oldMs = performance.now() - start;
      start = performance.now(); current = run(chunks, false); const newMs = performance.now() - start;
      if (i > 1) { oldTimes.push(oldMs); newTimes.push(newMs); }
    }
    assert.ok(current.chars <= W * 2 + 1);
    assert.deepEqual(current.usage, { in: 12345, out: 6789, cache_read: 23 });
    if (size < source.length) assert.equal(old.usage.in, 0);
    t.diagnostic(JSON.stringify({ node: process.version, sourceBytes: source.length, chunkBytes: size,
      legacySampleChars: old.chars, boundedSampleChars: current.chars, retainedBufferBytes: W * 2,
      legacyMedianMs: Number(median(oldTimes).toFixed(3)), boundedMedianMs: Number(median(newTimes).toFixed(3)) }));
  }
});

const { extractUsageOpenAI } = require('../lib/wire-openai-bridge');

function sampleOptions(chunks, opts) {
  const upstream = new EventEmitter();
  const written = [];
  let text, calls = 0;
  headTailUsage(upstream, { write: c => written.push(c) }, value => { text = value; calls++; }, opts);
  for (const chunk of chunks) upstream.emit('data', chunk);
  upstream.emit('end');
  assert.equal(calls, 1);
  assert.equal(written.length, chunks.length);
  for (let i = 0; i < chunks.length; i++) assert.strictEqual(written[i], chunks[i], '透传必须保留原始 Buffer');
  return text;
}

// 合法 SSE:头部注释补齐 head,JSON 的 padding 占据被丢弃的中段,尾部注释补齐 tail。
// 两段之间只有日志采样会删掉内容,客户端拿到的 JSON 仍完整。
function separated(headEnd, middleEnd, tailStart, size = 64) {
  const head = ':' + 'h'.repeat(size - headEnd.length - 2) + '\n' + headEnd;
  const middle = middleEnd.replace('PADDING', 'x'.repeat(size * 2));
  const tail = tailStart + '\n\n:' + 't'.repeat(size - tailStart.length - 3);
  const source = head + middle + tail;
  JSON.parse(source.split('\n').find(line => line.startsWith('data: ')).slice(6));
  return Buffer.from(source);
}

for (const [name, head, middle, tail, expected] of [
  ['数字不能跨缺口粘成更大的用量', 'data: {"usage":{"input_tokens":12', '},"padding":"PADDING","count":', '34}', 12],
  ['字段名不能跨缺口拼出来', 'data: {"usage":{"input_', 'tokens":0},"padding":"PADDING","total_', 'tokens":99}', 0],
  ['冒号和数字之间的缺口不能当成空白', 'data: {"usage":{"input_tokens":', '0},"padding":"PADDING","count":', ' 99}', 0],
]) {
  test(`headTailUsage:${name}`, () => {
    const source = separated(head, middle, tail);
    const expectedUsage = { in: expected, out: 0, cache_read: 0 };
    assert.deepEqual(extractUsageOpenAI('responses', source.toString()), expectedUsage, '完整响应的用量作为对照');
    const text = sampleOptions([source.subarray(0, 71), source.subarray(71)], { headBytes: 64, tailBytes: 64 });
    const sampledUsage = { in: 0, out: 0, cache_read: 0 };
    assert.deepEqual(extractUsageOpenAI('responses', text), sampledUsage, '跨缺口的整行丢弃,不保留截半或虚构的数字');
    assert.ok(text.length <= 64 + 64 + 1, '缺口标记只能增加一个字符');
  });
}

test('headTailUsage:默认 128KiB 窗口同样不能粘接用量数字', () => {
  const source = separated('data: {"usage":{"input_tokens":12', '},"padding":"PADDING","count":', '34}', 128 * 1024);
  const text = sample([source]);
  assert.deepEqual(extractUsageOpenAI('responses', text), { in: 0, out: 0, cache_read: 0 }, '默认窗口也丢弃跨缺口的整行');
});

test('headTailUsage:没有丢弃内容时必须无缝拼回,包括恰好填满两个窗口', () => {
  const source = Buffer.from('data: {"usage":{"input_tokens":123,"output_tokens":45}}\n\n');
  for (const tailBytes of [source.length - 30, source.length]) {
    const text = sampleOptions([source.subarray(0, 20), source.subarray(20)], { headBytes: 30, tailBytes });
    assert.equal(text, source.toString(), '真实连续的 token 不能被缺口标记拆开');
    assert.deepEqual(extractUsageOpenAI('responses', text), { in: 123, out: 45, cache_read: 0 });
  }
});

test('headTailUsage:有缺口仍按末次 usage 取值,尾部完整字段优先', () => {
  const chunks = [
    Buffer.from('data: {"usage":{"input_tokens":1,"output_tokens":2}}\n\n'),
    Buffer.from(':' + 'x'.repeat(1024) + '\n\n'),
    Buffer.from('data: {"usage":{"input_tokens":13,"output_tokens":17}}\n\n'),
  ];
  const text = sampleOptions(chunks, { headBytes: 64, tailBytes: 64 });
  assert.deepEqual(extractUsageOpenAI('responses', text), { in: 13, out: 17, cache_read: 0 });
});
