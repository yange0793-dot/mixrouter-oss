'use strict';
// All fixtures are synthetic; no real config, provider, or service is touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createResponseArchive } = require('../lib/observability/response-archive');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-response-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const read = (archive, file) => fs.readFileSync(path.join(archive.directory, file), 'utf8');
const event = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const options = root => ({ enabled: true, directory: root, format: 'anthropic', stream: true, secrets: ['FAKE-SECRET'] });
async function archiveText(root, text, extra = {}, ending = {}) {
  const archive = createResponseArchive({ ...options(root), ...extra });
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += 7) assert.equal(archive.write(bytes.subarray(i, i + 7)), true);
  const meta = await archive.finish({ status: 200, complete: true, ...ending });
  return { archive, meta };
}

test('disabled by default performs no IO and does not call secret source', async t => {
  const root = fixture(t);
  const a = createResponseArchive({ directory: path.join(root, 'absent'), secrets: () => { throw new Error('must not call'); } });
  assert.equal(a.write('private'), false);
  assert.equal((await a.finish()).state, 'disabled');
  assert.deepEqual(fs.readdirSync(root), []);
});

test('raw disk cap and archive admission cap stop archiving without deleting old files', async t => {
  const root = fixture(t);
  const a = createResponseArchive({ ...options(root), maxRawBytes: 32, maxArchives: 1 });
  a.write(Buffer.alloc(64, 65));
  const first = await a.finish({ complete: true });
  assert.equal(first.state, 'archive_error');
  assert.ok(first.errors.includes('raw_limit'));
  assert.ok(fs.statSync(path.join(a.directory, 'raw-response.bin')).size <= 32);
  const b = createResponseArchive({ ...options(root), maxArchives: 1 });
  b.write('private');
  assert.equal((await b.finish()).state, 'archive_error');
  assert.equal(fs.readdirSync(root).length, 1);
  assert.equal(fs.existsSync(a.directory), true);
});

test('derived bytes including source labels stay within the attempt limit', async t => {
  const root = fixture(t);
  const text = JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'x' }] });
  const { archive, meta } = await archiveText(root, text, { stream: false, maxRawBytes: Buffer.byteLength(text) });
  assert.ok(fs.statSync(path.join(archive.directory, 'returned-thinking.txt')).size <= meta.limits.derived_total_bytes);
});

test('unsafe root, admission lock and excessive secrets fail closed', async t => {
  const root = fixture(t);
  fs.chmodSync(root, 0o755);
  const a = createResponseArchive(options(root)); a.write('PRIVATE');
  assert.equal((await a.finish()).state, 'archive_error');
  assert.deepEqual(fs.readdirSync(root), []);
  fs.chmodSync(root, 0o700);
  const lock = path.join(root, '.archive-admission.lock'); fs.writeFileSync(lock, 'existing');
  const b = createResponseArchive(options(root)); b.write('PRIVATE');
  assert.equal((await b.finish()).state, 'archive_error');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'existing');
  const c = createResponseArchive({ ...options(root), secrets: ['x'.repeat(4097)] }); c.write('PRIVATE');
  assert.ok((await c.finish()).errors.includes('secret_source'));
  assert.deepEqual(fs.readdirSync(root), ['.archive-admission.lock']);
});

test('concurrent attempts cannot exceed admission cap', async t => {
  const root = fixture(t);
  const attempts = Array.from({ length: 5 }, () => createResponseArchive({ ...options(root), maxArchives: 1 }));
  for (const a of attempts) a.write(event({ type: 'message_stop' }));
  const results = await Promise.all(attempts.map(a => a.finish({ complete: true })));
  assert.equal(results.filter(r => r.state === 'complete').length, 1);
  assert.equal(fs.readdirSync(root).length, 1);
});

test('Anthropic SSE preserves raw bytes, Unicode thinking and terminal marker', async t => {
  const text = event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
    + event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '返回的思考' } })
    + event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ANSWER-NOT-THINKING' } })
    + event({ type: 'message_stop' });
  const { archive, meta } = await archiveText(fixture(t), text);
  assert.equal(read(archive, 'raw-response.bin'), text);
  assert.match(read(archive, 'returned-thinking.txt'), /返回的思考/);
  assert.doesNotMatch(read(archive, 'returned-thinking.txt'), /ANSWER-NOT-THINKING/);
  assert.equal(meta.state, 'complete');
  assert.equal(meta.returned_thinking, 'returned');
  assert.ok(meta.sources.includes('anthropic.thinking'));
  assert.equal(meta.raw.bytes, Buffer.byteLength(text));
  assert.equal(meta.raw.sha256, require('node:crypto').createHash('sha256').update(text).digest('hex'));
});

test('nonstream Anthropic thinking and Chat reasoning retain distinct sources', async t => {
  const root = fixture(t);
  const a = await archiveText(root, JSON.stringify({ type: 'message', stop_reason: 'end_turn', content: [
    { type: 'thinking', thinking: 'A-THINK' }, { type: 'text', text: 'A-ANSWER' },
  ] }), { stream: false });
  const b = await archiveText(root, JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
    reasoning_content: 'CHAT-CONTENT', reasoning: 'CHAT-REASONING', content: 'B-ANSWER',
  } }] }), { stream: false, format: 'chat' });
  assert.match(read(a.archive, 'returned-thinking.txt'), /A-THINK/);
  assert.doesNotMatch(read(a.archive, 'returned-thinking.txt'), /A-ANSWER/);
  assert.match(read(b.archive, 'returned-thinking.txt'), /CHAT-CONTENT/);
  assert.match(read(b.archive, 'returned-thinking.txt'), /CHAT-REASONING/);
  assert.deepEqual(b.meta.sources.sort(), ['chat.reasoning', 'chat.reasoning_content']);
  assert.equal(b.meta.state, 'complete');
  assert.notEqual(a.archive.directory, b.archive.directory);
});

test('Responses summary and text are source-labelled, never called private internal thought', async t => {
  const text = event({ type: 'response.reasoning_summary_text.delta', item_id: 'item1', summary_index: 0, delta: 'SUMMARY' })
    + event({ type: 'response.reasoning_text.delta', item_id: 'item1', content_index: 0, delta: 'REASONING-TEXT' })
    + event({ type: 'response.completed', response: { status: 'completed', output: [
      { id: 'item1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'SUMMARY' }] },
    ] } });
  const { archive, meta } = await archiveText(fixture(t), text, { format: 'responses' });
  const derived = read(archive, 'returned-thinking.txt');
  assert.match(derived, /responses.reasoning_summary/);
  assert.match(derived, /responses.reasoning_text/);
  assert.equal(derived.split('SUMMARY').length - 1, 1, 'terminal aggregate must not duplicate prior deltas');
  assert.equal(meta.state, 'complete');
});

test('Responses output_item.done without delta retains returned summary', async t => {
  const text = event({ type: 'response.output_item.done', output_index: 0,
    item: { id: 'only', type: 'reasoning', summary: [{ type: 'summary_text', text: 'DONE-ONLY' }] } })
    + event({ type: 'response.completed', response: { output: [] } });
  const { archive, meta } = await archiveText(fixture(t), text, { format: 'responses' });
  assert.match(read(archive, 'returned-thinking.txt'), /DONE-ONLY/);
  assert.equal(meta.state, 'complete');
});

test('SSE CRLF blank lines dispatch records and multiline data stays readable', async t => {
  const text = 'event: content_block_delta\r\ndata: {"type":"content_block_delta",\r\n'
    + 'data: "delta":{"type":"thinking_delta","thinking":"CRLF-THOUGHT"}}\r\n\r\n'
    + 'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n';
  const { archive, meta } = await archiveText(fixture(t), text);
  assert.equal(meta.state, 'complete');
  assert.match(read(archive, 'returned-thinking.txt'), /CRLF-THOUGHT/);
});

test('Responses distinct items and done-only events are not dropped or duplicated', async t => {
  const item = (id, text) => ({ id, type: 'reasoning', summary: [{ type: 'summary_text', text }] });
  const text = event({ type: 'response.reasoning_summary_text.delta', item_id: 'one', summary_index: 0, delta: 'FIRST-ITEM' })
    + event({ type: 'response.reasoning_summary_text.done', item_id: 'one', summary_index: 0, text: 'FIRST-ITEM' })
    + event({ type: 'response.reasoning_summary_text.done', item_id: 'two', summary_index: 0, text: 'SECOND-ITEM' })
    + event({ type: 'response.completed', response: { output: [item('one', 'FIRST-ITEM'), item('two', 'SECOND-ITEM')] } });
  const { archive } = await archiveText(fixture(t), text, { format: 'responses' });
  const derived = read(archive, 'returned-thinking.txt');
  assert.equal(derived.split('FIRST-ITEM').length - 1, 1);
  assert.equal(derived.split('SECOND-ITEM').length - 1, 1);
});

test('Responses nonstream summary/text survive while encrypted reasoning is not invented', async t => {
  const text = JSON.stringify({ status: 'completed', output: [{ type: 'reasoning', id: 'one',
    summary: [{ type: 'summary_text', text: 'SUMMARY-JSON' }], content: [{ type: 'reasoning_text', text: 'TEXT-JSON' }],
    encrypted_content: 'NOT-READABLE-THOUGHT' }] });
  const { archive, meta } = await archiveText(fixture(t), text, { format: 'responses', stream: false });
  const derived = read(archive, 'returned-thinking.txt');
  assert.match(derived, /SUMMARY-JSON/);
  assert.match(derived, /TEXT-JSON/);
  assert.doesNotMatch(derived, /NOT-READABLE-THOUGHT/);
  assert.equal(meta.state, 'complete');
});

test('escaped secret bytes and caller-mutated input buffers cannot bypass scrubbing', async t => {
  const root = fixture(t);
  const secret = 'FAKE-"KEY\\\\TAIL';
  const text = JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: secret }] });
  const archive = createResponseArchive({ ...options(root), stream: false, secrets: [secret] });
  const bytes = Buffer.from(text);
  archive.write(bytes);
  bytes.fill(0);
  const meta = await archive.finish({ status: 200, complete: true });
  assert.equal(meta.state, 'complete');
  assert.doesNotMatch(read(archive, 'returned-thinking.txt'), /KEY|TAIL/);
  assert.doesNotMatch(read(archive, 'raw-response.bin'), /KEY|TAIL/);
});

test('no returned reasoning is explicitly not_returned and no text is fabricated', async t => {
  const { archive, meta } = await archiveText(fixture(t), event({ choices: [{ delta: { content: 'just answer' }, finish_reason: 'stop' }] }) + event('[DONE]'), { format: 'chat' });
  assert.equal(meta.returned_thinking, 'not_returned');
  assert.equal(read(archive, 'returned-thinking.txt'), '');
});

test('transport end alone is not completion and interrupted marked stream remains partial', async t => {
  const root = fixture(t);
  const a = await archiveText(root, event({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'PARTIAL' } }));
  const b = await archiveText(root, event({ type: 'message_stop' }), {}, { complete: false, errorClass: 'stream_aborted' });
  assert.equal(a.meta.state, 'partial');
  assert.equal(b.meta.state, 'partial');
  assert.match(read(a.archive, 'returned-thinking.txt'), /PARTIAL/);
});

test('secrets redact longest first across every byte boundary including escaped JSON', async t => {
  const root = fixture(t);
  const secret = 'FAKE-KEY-LONG-TAIL';
  const text = JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: secret + ' FAKE-KEY' }] });
  const archive = createResponseArchive({ ...options(root), stream: false, secrets: ['FAKE-KEY', secret] });
  for (const byte of Buffer.from(text)) archive.write(Buffer.from([byte]));
  const meta = await archive.finish({ status: 200, complete: true });
  for (const file of ['raw-response.bin', 'returned-thinking.txt', 'metadata.json']) {
    assert.doesNotMatch(read(archive, file), /FAKE-KEY|LONG-TAIL/);
  }
  assert.match(read(archive, 'raw-response.bin'), /\[redacted\]/);
  assert.equal(meta.state, 'complete');
});

test('secret source throws: fail closed without logging source error or response content', async t => {
  const errors = [];
  const archive = createResponseArchive({ ...options(fixture(t)), secrets: () => { throw new Error('FAKE-KEY-SOURCE'); },
    onError: (error, context) => errors.push([error.message, context]) });
  assert.equal(archive.write(Buffer.from('PRIVATE-RESPONSE')), false);
  const meta = await archive.finish({ status: 200, complete: true });
  assert.equal(meta.state, 'archive_error');
  assert.ok(errors.length > 0);
  assert.doesNotMatch(JSON.stringify(errors), /FAKE-KEY-SOURCE|PRIVATE-RESPONSE/);
  assert.equal(fs.existsSync(path.join(archive.directory, 'raw-response.bin')), false);
});

test('private modes and random attempt paths never incorporate user session input', async t => {
  const root = fixture(t);
  const { archive } = await archiveText(root, event({ type: 'message_stop' }), { session: '../../UNTRUSTED-SESSION', provider: 'FAKE-PROVIDER' });
  assert.doesNotMatch(archive.directory, /UNTRUSTED-SESSION/);
  assert.equal(path.dirname(archive.directory), root);
  assert.equal(fs.statSync(archive.directory).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(archive.directory)) assert.equal(fs.statSync(path.join(archive.directory, file)).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(root, 'requests.jsonl')), false);
});

test('queue overload and disk failure are observable, bounded and cannot throw into proxy', async t => {
  const root = fixture(t);
  const errors = [];
  const a = createResponseArchive({ ...options(root), maxQueuedBytes: 16, onError: (e, c) => errors.push(c.op) });
  assert.doesNotThrow(() => assert.equal(a.write(Buffer.alloc(17)), false));
  const ma = await a.finish({ complete: true, status: 200 });
  assert.equal(ma.state, 'archive_error');
  assert.ok(errors.includes('queue_limit'));
  assert.deepEqual(ma.queue_overflow, { actual_bytes: 17, limit_bytes: 16, actual_chunks: 1, limit_chunks: 8192 });
  const blocked = path.join(root, 'blocker');
  fs.writeFileSync(blocked, 'x');
  const b = createResponseArchive({ ...options(blocked), onError: () => { throw new Error('callback must not escape'); } });
  assert.doesNotThrow(() => b.write(Buffer.from('body')));
  const mb = await b.finish({ status: 500, complete: false });
  assert.equal(mb.state, 'archive_error');
});

test('caller metadata is retained, scrubbed and cannot carry bodies or reshape the path', async t => {
  const root = fixture(t);
  const archive = createResponseArchive({ ...options(root),
    metadata: { requestId: 'req-1', attempt: 2, model: 'FAKE-SECRET-model',
      sessionHash: 'abc123', nested: { body: 'SMUGGLED-BODY' }, list: ['x'], blob: Buffer.from('SMUGGLED-BUF') } });
  archive.write(Buffer.from(event({ type: 'message_stop' })));
  const meta = await archive.finish({ status: 200, complete: true });
  const disk = JSON.parse(read(archive, 'metadata.json'));
  assert.equal(disk.requestId, 'req-1');
  assert.equal(disk.attempt, 2);
  assert.equal(disk.model, '[redacted]-model');
  assert.equal(disk.sessionHash, 'abc123');
  assert.equal(disk.nested, undefined);
  assert.equal(disk.list, undefined);
  assert.equal(disk.blob, undefined);
  assert.doesNotMatch(read(archive, 'metadata.json'), /SMUGGLED/);
  assert.doesNotMatch(archive.directory, /req-1|abc123/);
  assert.equal(meta.requestId, 'req-1');
});

test('finish stream override reparses a JSON failure body requested as a stream', async t => {
  const body = JSON.stringify({ error: { message: 'upstream fixture' }, content: [{ type: 'thinking', thinking: 'ERR-THINK' }] });
  const { archive, meta } = await archiveText(fixture(t), body, {}, { status: 500, complete: true, stream: false });
  assert.equal(meta.stream, false);
  assert.equal(meta.state, 'complete');
  assert.match(read(archive, 'returned-thinking.txt'), /ERR-THINK/);
});

test('midstream raw disk error resolves metadata and only reports fixed diagnostics', async t => {
  const root = fixture(t), errors = [];
  const original = fs.promises.open;
  fs.promises.open = async function(file, ...args) {
    const handle = await original.call(this, file, ...args);
    if (String(file).endsWith('raw-response.bin')) {
      handle.write = async () => { throw new Error('PRIVATE-RESPONSE FAKE-SECRET'); };
    }
    return handle;
  };
  try {
    const archive = createResponseArchive({ ...options(root), onError: (e, c) => errors.push([e.message, c]) });
    assert.equal(archive.write(Buffer.from('PRIVATE-RESPONSE body')), true);
    const meta = await archive.finish({ status: 200, complete: true });
    assert.equal(meta.state, 'archive_error');
    assert.equal(meta.raw.complete, false);
    assert.ok(meta.errors.includes('raw_write'));
    assert.doesNotMatch(JSON.stringify(errors), /PRIVATE-RESPONSE|FAKE-SECRET/);
    assert.equal(JSON.parse(read(archive, 'metadata.json')).state, 'archive_error');
  } finally { fs.promises.open = original; }
});

test('many small SSE events preserve raw beyond the per-record extraction bound', async t => {
  const root = fixture(t), textParts = [];
  const archive = createResponseArchive({ ...options(root), maxRecordBytes: 256 });
  for (let i = 0; i < 300; i++) {
    const part = event({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: `fragment-${i}` } });
    textParts.push(part);
    assert.equal(archive.write(Buffer.from(part)), true);
    if (i % 20 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  textParts.push(event({ type: 'message_stop' }));
  archive.write(Buffer.from(textParts.at(-1)));
  const meta = await archive.finish({ status: 200, complete: true });
  assert.equal(read(archive, 'raw-response.bin'), textParts.join(''));
  assert.equal(meta.state, 'complete');
  assert.match(read(archive, 'returned-thinking.txt'), /fragment-299/);
  assert.equal(meta.limits.raw_total_bytes, 16 * 1024 * 1024);
});

test('derived record limit preserves complete raw and explicitly marks extraction partial', async t => {
  const text = event({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x'.repeat(4096) } }) + event({ type: 'message_stop' });
  const { archive, meta } = await archiveText(fixture(t), text, { maxRecordBytes: 256 });
  assert.equal(read(archive, 'raw-response.bin'), text);
  assert.equal(meta.raw.complete, true);
  assert.equal(meta.derived.complete, false);
  assert.ok(meta.derived.errors.includes('record_limit'));
  assert.equal(meta.derived.max_record_bytes, 256);
  assert.ok(meta.derived.max_observed_record_bytes > 256);
  assert.equal(meta.returned_thinking, 'unknown');
});

test('real loopback streaming preserves all chunks and finish is idempotent', async t => {
  const root = fixture(t);
  const text = event({ choices: [{ delta: { reasoning_content: 'LOOPBACK' }, finish_reason: null }] })
    + event({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + event('[DONE]');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < text.length; i += 11) res.write(text.slice(i, i + 11));
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const archive = createResponseArchive({ ...options(root), format: 'chat' });
  await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${server.address().port}`, response => {
    response.on('data', chunk => archive.write(chunk));
    response.on('end', resolve);
    response.on('error', reject);
  }).on('error', reject));
  const first = archive.finish({ status: 200, complete: true });
  assert.equal(archive.finish({ status: 500, complete: false }), first);
  const meta = await first;
  assert.equal(meta.state, 'complete');
  assert.equal(read(archive, 'raw-response.bin'), text);
  assert.match(read(archive, 'returned-thinking.txt'), /LOOPBACK/);
  assert.equal(archive.write(Buffer.from('late')), false);
});
