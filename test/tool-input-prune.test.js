'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makePruner, isEmpty } = require('../lib/tool-input-prune');

test('pruner 只剪顶层可选空值,不改原对象、required、false、0 或非空数组', () => {
  const prune = makePruner([{ name: 'Edit', input_schema: { required: ['new_string'] } }]);
  const input = { new_string: '', enabled: false, count: 0, array: [''], empty: [], nil: null, nested: { url: '', protocols: [] } };
  assert.deepEqual(prune.value('Edit', input), { new_string: '', enabled: false, count: 0, array: [''] });
  assert.equal(input.nil, null);
  assert.deepEqual(input.nested, { url: '', protocols: [] });
  assert.equal(prune.value('Unknown', input), input);
  assert.equal(makePruner([{ name: 'Edit' }]).value('Edit', input), input);
  assert.equal(isEmpty({ value: false }), false);
});

test('pruner 无变化或坏JSON保留原串,只在实际剪除后重新序列化', () => {
  const prune = makePruner([{ name: 'Read', input_schema: { required: ['file_path'] } }]);
  const raw = '{ "file_path": "/a", "offset": 0 }';
  assert.equal(prune.raw('Read', raw), raw);
  assert.equal(prune.raw('Read', '{bad'), '{bad');
  assert.equal(prune.raw('Read', '{"file_path":"/a","pages":""}'), '{"file_path":"/a"}');
});

test('Responses effort统计只记录实际发送值,模型覆盖后再判断排除表', () => {
  const { anthropicToResponses } = require('../lib/wire-responses');
  const stats = {};
  const body = { model: 'deepseek-flash', output_config: { effort: 'low' }, messages: [] };
  const sent = anthropicToResponses(body, { model: 'qwen3.8-max', stats });
  assert.deepEqual(sent.reasoning, { effort: 'low' });
  assert.equal(stats.effort, 'low');
  const omittedStats = {};
  const omitted = anthropicToResponses(body, { model: 'deepseek-flash[1m]', stats: omittedStats });
  assert.equal(omitted.reasoning, undefined);
  assert.equal(omittedStats.effort, undefined);
});
