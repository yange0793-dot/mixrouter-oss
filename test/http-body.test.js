'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { MAX_JSON_DEPTH, jsonDepthOk, parseJsonBody, readBodyLimited, readObject } = require('../lib/http/body');
const invalid = message => Object.assign(new Error(message), { statusCode: 400 });

function readText(text, reader = readObject) {
  const req = new PassThrough();
  const result = reader(req, { limit: 4096, invalid });
  req.end(text);
  return result;
}

test('JSON depth guard counts structure, not brackets or escaped quotes inside strings', () => {
  const raw = JSON.stringify({ text: '[{\\\"'.repeat(1000), nested: [{ ok: true }] });
  assert.equal(jsonDepthOk(raw), true);
  assert.deepEqual(parseJsonBody(raw, { invalid }), JSON.parse(raw));
  const nested = n => '['.repeat(n) + '0' + ']'.repeat(n);
  assert.equal(jsonDepthOk(nested(MAX_JSON_DEPTH)), true);
  assert.equal(jsonDepthOk(nested(MAX_JSON_DEPTH + 1)), false);
});

test('JSON parsing preserves distinct syntax, depth and object errors', () => {
  for (const raw of ['', 'not-json', '{"a":}']) {
    assert.throws(() => parseJsonBody(raw, { invalid }), { statusCode: 400, message: '请求体不是合法 JSON' });
  }
  for (const raw of ['null', '[]', '0', 'false', '"text"']) {
    assert.throws(() => parseJsonBody(raw, { invalid }), { statusCode: 400, message: '请求体必须是 JSON 对象' });
  }
  const raw = '{"a":'.repeat(300) + '0' + '}'.repeat(300);
  assert.throws(() => parseJsonBody(raw, { invalid, proxy: true }), {
    statusCode: 400, message: `请求体嵌套层数超过 ${MAX_JSON_DEPTH} 层,拒绝解析`,
  });
  assert.throws(() => parseJsonBody(raw, { invalid }), {
    statusCode: 400, message: `请求体嵌套层数超过 ${MAX_JSON_DEPTH} 层`,
  });
});

test('optional object predicate adds validation but cannot admit arrays or primitives', async () => {
  const error = { statusCode: 400, message: '请求体必须是 JSON 对象' };
  for (const raw of ['null', '[]', '0']) {
    assert.throws(() => parseJsonBody(raw, { invalid, isObject: () => true }), error);
  }
  assert.throws(() => parseJsonBody('{}', { invalid, isObject: () => false }), error);
  assert.deepEqual(parseJsonBody('{"ok":true}', { invalid, isObject: value => value.ok === true }), { ok: true });
  const req = new PassThrough();
  const rejected = assert.rejects(readObject(req, { invalid, isObject: () => false }), error);
  req.end('{}');
  await rejected;
});

test('console readObject accepts an empty body but not whitespace or primitive JSON', async () => {
  assert.deepEqual(await readText(''), {});
  assert.deepEqual(await readText('{"ok":true}'), { ok: true });
  await assert.rejects(readText('   '), { statusCode: 400, message: '请求体不是合法 JSON' });
  await assert.rejects(readText('null'), { statusCode: 400, message: '请求体必须是 JSON 对象' });
});

test('limited reader counts bytes and decodes UTF-8 only after chunks are joined', async () => {
  const raw = Buffer.from('{"text":"中文"}');
  const req = new PassThrough();
  const result = readBodyLimited(req, raw.length);
  const cut = raw.indexOf(Buffer.from('中')) + 1;
  req.write(raw.subarray(0, cut));
  req.end(raw.subarray(cut));
  assert.equal(await result, raw.toString('utf8'));

  const over = new PassThrough();
  const rejected = assert.rejects(readBodyLimited(over, raw.length - 1), /too large/);
  over.end(raw);
  await rejected;
  assert.equal(over.destroyed, true);
});

test('limited reader rejects transport errors rather than parsing a partial body', async () => {
  const req = new PassThrough();
  const rejected = assert.rejects(readBodyLimited(req, 100), /connection lost/);
  req.write('{"a":');
  req.destroy(new Error('connection lost'));
  await rejected;
});
