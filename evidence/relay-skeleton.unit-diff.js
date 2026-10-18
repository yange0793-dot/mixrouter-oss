'use strict';
// 单元级差分探针:对 relay 骨架喂**合成的**上游事件序列,比对旧实现(抽取前)与新实现
// (抽取后)在客户端侧产生的字节。
//
// 为什么还要这一份:端到端那份(upstream-relay-extract.equivalence.js)走真 HTTP,
// 上游是由真实 socket 驱动的,拿不到「close 但没有 end」「error 但不 close」这类
// 精确的到达顺序 —— 而这正是本次抽出来的 transportDead 那一条的判定入口。
// 实测发现端到端 36 条里 transportDead **一次都没真的开火**(全部 no-op),
// 那条路径等于没被证明。这里用假流精确构造事件序列,把它补上。
//
// 用法:
//   node evidence/relay-skeleton.unit-diff.js --old=<旧树> --new=<新树>

const path = require('node:path');
const { EventEmitter } = require('node:events');

const arg = n => {
  const a = process.argv.find(x => x.startsWith(`--${n}=`));
  return a ? path.resolve(a.slice(n.length + 3)) : null;
};
const OLD = arg('old'), NEW = arg('new');
if (!OLD || !NEW) { console.error('需要 --old=<旧树> --new=<新树>'); process.exit(2); }

const load = root => require(path.join(root, 'lib', 'wire-responses.js'));

// ---------------------------------------------------------------- 假流
function fakeUpstream(statusCode = 200) {
  const up = new EventEmitter();
  up.statusCode = statusCode;
  up.destroy = () => { up.destroyed = true; };
  return up;
}
function fakeClient() {
  const chunks = [];
  const res = {
    headersSent: false, writableEnded: false, destroyed: false,
    statusCode: null, headers: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true; },
    write(t) { chunks.push(t); },
    end(t) { if (t !== undefined) chunks.push(t); this.writableEnded = true; },
    on() {}, once() {}, destroy() { this.destroyed = true; },
  };
  res.text = () => chunks.join('');
  res.chunkCount = () => chunks.length;
  return res;
}

// ---------------------------------------------------------------- 事件序列
const SSE_CHAT_OK = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"EQ"}\n\n'
  + 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n';
const SSE_HALF = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"EQ"}\n\n';
const BAD_BODY = '{"status":"failed","error":{"message":"EQ-TERM","code":"server_error"}}';

// 每条:名字 + 事件序列(每项 {ev, arg}) + 是否允许重试
const CASES = [
  { name: '正常完成:data(完整) → end',              seq: [['data', SSE_CHAT_OK], ['end']], retry: false },
  { name: '半截 → end(无终态)',                      seq: [['data', SSE_HALF], ['end']], retry: false },
  { name: '半截 → close(无 end,无终态)',             seq: [['data', SSE_HALF], ['close']], retry: false },
  { name: '半截 → close(允许重试)',                  seq: [['data', SSE_HALF], ['close']], retry: true },
  { name: '半截 → error(无 end,无终态)',             seq: [['data', SSE_HALF], ['error', Object.assign(new Error('boom'), { code: 'ECONNRESET' })]], retry: false },
  { name: '半截 → error(允许重试)',                  seq: [['data', SSE_HALF], ['error', Object.assign(new Error('boom'), { code: 'ECONNRESET' })]], retry: true },
  { name: 'close 先于任何 data',                     seq: [['close']], retry: false },
  { name: 'close 先于任何 data(允许重试)',           seq: [['close']], retry: true },
  { name: 'error 先于任何 data',                     seq: [['error', Object.assign(new Error('x'), { code: 'EPIPE' })]], retry: false },
  { name: 'error 先于任何 data(允许重试)',           seq: [['error', Object.assign(new Error('x'), { code: 'EPIPE' })]], retry: true },
  { name: 'end 之后再 close(重复终态)',              seq: [['data', SSE_CHAT_OK], ['end'], ['close']], retry: false },
  { name: 'end 之后再 error(重复终态)',              seq: [['data', SSE_CHAT_OK], ['end'], ['error', new Error('late')]], retry: false },
  { name: 'close 之后再来 data(终态后到达)',         seq: [['data', SSE_HALF], ['close'], ['data', SSE_CHAT_OK]], retry: false },
  { name: '提交前拿到错误体(terminalError 命中)',    seq: [['data', BAD_BODY], ['end']], retry: false },
  { name: '提交前拿到错误体 + 允许重试',             seq: [['data', BAD_BODY], ['end']], retry: true },
  { name: '分两段到达的错误体(跨 chunk 拼出)',       seq: [['data', BAD_BODY.slice(0, 20)], ['data', BAD_BODY.slice(20)], ['end']], retry: false },
  { name: '已提交后再来错误体(不该改判)',            seq: [['data', SSE_HALF], ['data', BAD_BODY], ['end']], retry: false },
  { name: '空流直接 end',                            seq: [['end']], retry: false },
  { name: '空流直接 close',                          seq: [['close']], retry: false },
  { name: '多字节 UTF-8 跨 chunk 切开',              seq: [['data', SSE_HALF.slice(0, 50)], ['data', SSE_HALF.slice(50)], ['end']], retry: false },
];

// 跑一条:返回可序列化的观测
async function runOne(impl, c) {
  const up = fakeUpstream(200);
  const res = fakeClient();
  const p = impl(up, res, 'test-model', { mayRetry: c.retry, headers: { 'x-t': '1' }, onCommit: null });
  for (const [ev, arg] of c.seq) {
    up.emit(ev, arg);
    await new Promise(r => setImmediate(r)); // 让微任务/nextTick 跑完,贴近真实到达节奏
  }
  let settled = 'pending', result = null;
  const t = new Promise(r => setTimeout(() => r('timeout'), 300));
  const got = await Promise.race([p.then(v => ({ v })), t]);
  if (got && got.v !== undefined) { settled = 'resolved'; result = got.v; }
  else if (got === 'timeout') { settled = 'timeout'; }
  return {
    name: c.name,
    settled,
    client: {
      status: res.statusCode, headersSent: res.headersSent, writableEnded: res.writableEnded,
      chunkCount: res.chunkCount(),
      // 归一化随机 msg_ id,否则流式那几条每次都不一样
      text: res.text().replace(/msg_[0-9a-f]{24}/g, 'msg_<RAND24>'),
    },
    result: result && {
      converted: result.converted, retryable: result.retryable, aborted: result.aborted,
      detail: result.detail, model: result.model,
      usage: result.usage || null,
    },
  };
}

async function main() {
  const oldImpl = load(OLD).relayAnthropicStream;
  const newImpl = load(NEW).relayAnthropicStream;
  if (typeof oldImpl !== 'function' || typeof newImpl !== 'function') throw new Error('拿不到 relayAnthropicStream');

  const rows = [];
  let mismatch = 0;
  for (const c of CASES) {
    const a = await runOne(oldImpl, c);
    const b = await runOne(newImpl, c);
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (!same) mismatch++;
    rows.push({ case: c.name, same, old: a, new: b });
    console.log(`${same ? '✔' : '✘'} ${c.name.padEnd(34)} settled=${a.settled.padEnd(9)} status=${a.client.status} chunks=${a.client.chunkCount} retryable=${a.result ? a.result.retryable : '-'}`);
    if (!same) { console.log('   旧:', JSON.stringify(a)); console.log('   新:', JSON.stringify(b)); }
  }
  console.log(`\nOLD=${OLD}\nNEW=${NEW}\nCASES=${CASES.length}\nMISMATCH=${mismatch}`);
  // 为了自证有鉴别力,顺带报一下 transportDead 真的开火过几条
  const fired = rows.filter(r => r.old.result && (r.old.result.aborted || r.old.result.retryable)).length;
  console.log(`有终态被判为「夭折或可重试」的用例数=${fired}(>0 才说明这套合成序列真的走到了 transportDead 那条分支)`);
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  process.exit(mismatch ? 1 : 0);
}
main().catch(e => { console.error('差分探针失败:', e); process.exit(1); });
