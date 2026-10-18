'use strict';
// endBufferedStream 第 68 行那个析取项的**单元级取证**。
//
// 缘起:三份端到端探针(translator / relay / relay-skeleton.unit-diff)在 L68 上
// **一条有鉴别力的观测都没有** —— 把整个 `(sink && (parseError || (r && r.aborted)))`
// 删掉,三份探针的摘要全部不变。成因不是"这条分支结构上不可达",而是
// **采样里造不出它唯一不可替代的那一族取值**(见下)。
//
// 为什么必须单独做单元级:端到端探针要同时张罗 客户端流/非流 × 上游线 × 回法,
// 而 L68 的四个操作数(res.headersSent / clientClosed / r.aborted / 解析是否抛)
// 在端到端里被上游行为**间接**决定,相互耦合 —— 想让「hdrsSent=true 且还没 502」
// 同时成立,端到端场景里要凑齐一串巧合。直接调函数则四个操作数逐个可控。
//
// 这条分支唯一不可替代的取值(willFail 为假、第二项为真):
//   sink=true(有攒包) 且 res.headersSent=true(响应头已提交) 且 msg=null(解析抛错或 r.aborted)
// 此时 willFail = !!(sink && !headersSent && …) = false,只有第二项能把它判成 502。
// 生产语义:响应头已经发出去了才发现上游给的是残缺工具参数/流夭折 ——
// 客户端拿不到 502 状态码(headersSent 已定),**但 requests.jsonl 必须记 502**,
// 否则「日志记 200、实际是坏响应」那类故障会重演(该文件头注释点名的正是这个)。

const path = require('path');
const fs = require('fs');

const ROOT = process.argv[2] || path.resolve(__dirname, '..');
const { createAnthropicTranslator } = require(path.join(ROOT, 'lib', 'wire-anthropic-translator.js'));

// 有完整终态(sawStart/sawStop 都真)但 tool_use 的 input 不是完整 JSON
// ⇒ 越过前两关,走到 tool_use 的 JSON.parse ⇒ 抛。
// 这正是模块注释点名的场景,也是 willFail 为假时唯一能造出 parseError 的输入。
const sse = evs => evs.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');
const TOOLTRUNC = sse([
  { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'x', content: [], usage: { input_tokens: 3 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'f', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
  { type: 'message_stop' },
]);
const OK = sse([
  { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'x', content: [], usage: { input_tokens: 3 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]);

const mkRes = headersSent => {
  const chunks = [];
  return {
    headersSent, writableEnded: false, destroyed: false, _chunks: chunks,
    writeHead(s, h) { this.headersSent = true; this._h = [s, h]; },
    write(c) { chunks.push(String(c)); return true; },
    end(c) { if (c !== undefined) chunks.push(String(c)); this.writableEnded = true; },
  };
};
const mkSink = text => {
  const parts = [];
  return {
    res: { headersSent: true, writableEnded: false, destroyed: false, write(c) { parts.push(String(c)); return true; }, end() { this.writableEnded = true; } },
    text: () => text,
  };
};

// 穷举 L68 的四个操作数:body(2) × sink(2) × headersSent(2) × clientClosed(2) × aborted(2) = 32
function observe() {
  const rows = [];
  for (const [bodyName, body] of [['ok', OK], ['tooltrunc', TOOLTRUNC]]) {
    for (const hasSink of [true, false]) {
      for (const headersSent of [true, false]) {
        for (const clientClosed of [false, true]) {
          for (const aborted of [false, true]) {
            const entry = {};
            const res = mkRes(headersSent);
            const sink = hasSink ? mkSink(body) : null;
            const r = { aborted, detail: 'EQ-DETAIL', usage: { input_tokens: 11, output_tokens: 7 } };
            const t = createAnthropicTranslator({ convertError: () => null, convertMessage: x => x });
            t.endBufferedStream({
              entry, res, headers: {}, model: 'm', clientClosed, sink, r,
              finishEntry: () => {}, disarmIdle: () => {}, setResponseDone: () => {}, collect: {},
            });
            // parseError 是否发生:tooltrunc + 没被 aborted 短路 ⇒ 真走进了 JSON.parse 并抛。
            // 直接读 entry.err 的文案会把"外层先赋的值"当成解析错误(entry.err 有 || 链),
            // 所以单独记一个布尔,不靠文案反推。
            const parseError = entry.err === '上游工具参数不是完整 JSON';
            rows.push({
              name: `${bodyName}|sink=${hasSink}|hdrsSent=${headersSent}|cliClosed=${clientClosed}|aborted=${aborted}`,
              parseError,
              status: entry.status === undefined ? null : entry.status,
              err: entry.err || null,
              errClass: entry.err_class || null,
            });
          }
        }
      }
    }
  }
  return rows;
}

// 该分支**唯一不可替代**的取值:willFail 自己为假、却仍被判 502。
//
// willFail = !!(sink && !headersSent && !clientClosed && !msg)
// 只要 headersSent 为真,willFail 就必然是假 —— 与 msg 无关。所以"不可替代族"就是:
//   sink=true 且 headersSent=true 且 (parseError || r.aborted)
// 这四行(hdrsSent 真 × aborted 真/假 × cliClosed 真/假)是删掉第二项后**必须**从 502 退化的。
// 判据写成这个精确形状,而不是"看起来像 tooltrunc"的近似 —— 近似判据对几乎所有行都返回真,
// 注入前后都非空,等于没有鉴别力(这是本探针第一版踩到的坑,照录)。
const isIrreplaceable = x => {
  const f = Object.fromEntries(x.name.split('|').map(s => s.split('=')));
  const isToolTrunc = x.name.startsWith('tooltrunc');
  const parseErr = x.parseError === true;
  const aborted = f.aborted === 'true';
  return isToolTrunc && f.sink === 'true' && f.hdrsSent === 'true' && (parseErr || aborted);
};

// 钉死的摘要。**这份探针的判别力靠它，不靠"不可替代族非空"**:
// 只判非空只能挡住"整个第二项被删掉"(那会把 4 降到 0),
// 而"第二项只留 parseError、去掉 r.aborted"会把 4 降到 **2** —— 非空仍成立,漏判。
// 钉死摘要才能把这一类半删也逮住。**改动 lib/wire-anthropic-translator.js 的收尾逻辑后,
// 这个值要跟着重算**(重算前先确认新摘要是你预期的那个,别直接盖上)。
const EXPECTED_DIGEST = '19f7c74b7a4b2b6e06eb211f44a93581bbc95da9cb3eee68c20cfa9b05a63a70';
// 不可替代族的确切条数:headersSent 真时 willFail 恒假,故 = sink(1) × hdrsSent(1) × cliClosed(2)
// × [parseError ∨ aborted](2:aborted=false 走 parseError,aborted=true 走 aborted)= 4。
const EXPECTED_IRREPLACEABLE = 4;

function main() {
  const rows = observe();
  const must502 = rows.filter(x => x.name.startsWith('tooltrunc') && x.name.includes('sink=true') && x.status === 502);
  const irreplaceable = must502.filter(isIrreplaceable);

  console.log(`ROOT=${ROOT}`);
  console.log(`观测条数: ${rows.length}`);
  console.log(`判成 502 的: ${must502.length}`);
  console.log(`其中只有第 68 行第二项能判出来的: ${irreplaceable.length}（应恒为 ${EXPECTED_IRREPLACEABLE}）`);
  for (const x of irreplaceable) console.log(`  ★ ${x.name} -> status=${x.status} err=${x.err}`);

  const digest = require('crypto').createHash('sha256')
    .update(rows.map(x => JSON.stringify(x)).join('\n')).digest('hex');
  console.log(`DIGEST_SHA256=${digest}`);
  return { rows, irreplaceable, digest };
}

if (require.main === module) {
  const { irreplaceable, digest } = main();
  let bad = false;
  // ① 不可替代族必须非空 —— 空了说明第二项被整个删掉,这份探针已退化成"看着覆盖、实际没有"。
  if (irreplaceable.length === 0) {
    console.error('取证失败:没有一条观测落在"只有第 68 行第二项能判 502"的取值上');
    bad = true;
  }
  // ② 条数必须正好是理论值 —— 挡住"删一半"(只留 parseError 或只留 aborted)。
  if (irreplaceable.length !== EXPECTED_IRREPLACEABLE) {
    console.error(`取证失败:不可替代族 ${irreplaceable.length} 条,应为 ${EXPECTED_IRREPLACEABLE} 条`);
    bad = true;
  }
  // ③ 摘要钉死 —— 上面两条都是"结构性"的,这一条才覆盖全部字段的任意改动。
  if (digest !== EXPECTED_DIGEST) {
    console.error(`取证失败:摘要 ${digest} 与钉死值不符（预期 ${EXPECTED_DIGEST}）`);
    bad = true;
  }
  if (bad) process.exit(1);
  console.log('取证通过:第 68 行第二项有 4 条观测只能由它判出,且全字段摘要与钉死值一致');
}

module.exports = { observe, TOOLTRUNC, OK };
