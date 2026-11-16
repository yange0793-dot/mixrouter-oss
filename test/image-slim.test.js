'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETTINGS, slimImages } = require('../lib/image-slim');

const payload = 'a'.repeat(8192);
const dataUrl = data => `data:image/png;base64,${data}`;
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const enabled = overrides => ({ ...DEFAULT_SETTINGS, enabled: true, ...overrides });
const emptyStats = { images_total: 0, images_removed: 0, bytes_saved: 0 };

function image(protocol, data = payload) {
  if (protocol === 'anthropic') return { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
  if (protocol === 'responses') return { type: 'input_image', image_url: dataUrl(data) };
  return { type: 'image_url', image_url: { url: dataUrl(data), detail: 'high' } };
}

function message(protocol, role, content) {
  return { ...(protocol === 'responses' ? { type: 'message' } : {}), role, content };
}

function bodyOf(protocol, items) {
  return protocol === 'responses' ? { input: items } : { messages: items };
}

function toolPair(protocol, id, content, name = protocol === 'anthropic' ? 'Read' : 'view_image', args = { path: '/tmp/photo.png' }) {
  if (protocol === 'anthropic') return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input: args }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  ];
  if (protocol === 'responses') return [
    { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) },
    { type: 'function_call_output', call_id: id, output: content },
  ];
  return [
    { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: id, content },
  ];
}

test('exports the agreed frozen defaults', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    enabled: false, keep_last: 0, keep_last_turns: 1, min_bytes: 8192, attachments: true,
  });
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS), true);
});

test('disabled mode returns zero without inspecting the body', () => {
  const body = new Proxy({}, { get() { throw new Error('disabled mode inspected the body'); } });
  assert.deepEqual(slimImages(body, 'responses', DEFAULT_SETTINGS), emptyStats);
});

for (const protocol of ['anthropic', 'responses', 'chat']) {
  test(`${protocol}: preserves whole current and completed turns, including image-only users`, () => {
    const oldest = [image(protocol), image(protocol)];
    const previous = [image(protocol), image(protocol), image(protocol)];
    const current = [image(protocol), image(protocol)];
    const previousRefs = [...previous], currentRefs = [...current];
    const items = [
      message(protocol, 'user', oldest),
      message(protocol, 'assistant', 'First answer'),
      message(protocol, 'user', previous),
      message(protocol, 'assistant', 'Second answer'),
      message(protocol, 'user', current),
    ];
    const body = bodyOf(protocol, items);
    const before = bytes(body);
    const stats = slimImages(body, protocol, enabled());
    assert.deepEqual(stats, { images_total: 7, images_removed: 2, bytes_saved: before - bytes(body) });
    assert.ok(stats.bytes_saved > 0);
    assert.equal(oldest[0].type, protocol === 'responses' ? 'input_text' : 'text');
    assert.equal(oldest[1].type, protocol === 'responses' ? 'input_text' : 'text');
    previous.forEach((part, at) => assert.equal(part, previousRefs[at]));
    current.forEach((part, at) => assert.equal(part, currentRefs[at]));
    assert.equal((body.input || body.messages), items);
    assert.equal(items[1].content, 'First answer');
  });

  test(`${protocol}: keep_last is a global image count and unions with retained turns`, () => {
    const old = [image(protocol), image(protocol)];
    const recent = [image(protocol), image(protocol)];
    const lastOld = old[1], recentRefs = [...recent];
    const body = bodyOf(protocol, [
      message(protocol, 'user', old),
      message(protocol, 'assistant', 'done'),
      message(protocol, 'user', recent),
      message(protocol, 'assistant', 'done'),
      message(protocol, 'user', 'continue'),
    ]);
    const stats = slimImages(body, protocol, enabled({ keep_last: 3 }));
    assert.equal(stats.images_removed, 1);
    assert.equal(old[1], lastOld);
    recent.forEach((part, at) => assert.equal(part, recentRefs[at]));
  });

  test(`${protocol}: current turn survives zero keep settings, including multiple tool results`, () => {
    const old = [image(protocol)];
    const first = [image(protocol)], second = [image(protocol), image(protocol)];
    const firstRefs = [...first], secondRefs = [...second];
    const body = bodyOf(protocol, [
      message(protocol, 'user', old),
      message(protocol, 'assistant', 'done'),
      message(protocol, 'user', 'inspect files'),
      ...toolPair(protocol, 'first', first),
      ...toolPair(protocol, 'second', second),
    ]);
    const stats = slimImages(body, protocol, enabled({ keep_last_turns: 0 }));
    assert.equal(stats.images_total, 4);
    assert.equal(stats.images_removed, 1);
    first.forEach((part, at) => assert.equal(part, firstRefs[at]));
    second.forEach((part, at) => assert.equal(part, secondRefs[at]));
  });

  test(`${protocol}: tool results do not consume the completed-turn allowance`, () => {
    const old = [image(protocol)];
    const previous = [image(protocol)];
    const results = [image(protocol), image(protocol)];
    const previousRef = previous[0], resultRefs = [...results];
    const body = bodyOf(protocol, [
      message(protocol, 'user', old),
      message(protocol, 'assistant', 'done'),
      message(protocol, 'user', previous),
      ...toolPair(protocol, 'previous-tool', results),
      message(protocol, 'assistant', 'done'),
      message(protocol, 'user', 'next'),
    ]);
    const stats = slimImages(body, protocol, enabled());
    assert.equal(stats.images_removed, 1);
    assert.equal(previous[0], previousRef);
    results.forEach((part, at) => assert.equal(part, resultRefs[at]));
  });

  test(`${protocol}: an incremental request with no user anchor keeps every image`, () => {
    const results = [image(protocol), image(protocol)];
    const items = toolPair(protocol, 'incremental', results);
    const body = bodyOf(protocol, items);
    const before = structuredClone(body);
    assert.deepEqual(slimImages(body, protocol, enabled({ keep_last_turns: 0 })), {
      images_total: 2, images_removed: 0, bytes_saved: 0,
    });
    assert.deepEqual(body, before);
  });

  test(`${protocol}: mixed tool output replaces individual images and keeps text, URLs and data`, () => {
    const text = { type: protocol === 'responses' ? 'input_text' : 'text', text: 'important OCR text' };
    const remote = protocol === 'anthropic'
      ? { type: 'image', source: { type: 'url', url: 'https://example.org/image.png' } }
      : { type: protocol === 'responses' ? 'input_image' : 'image_url', image_url: 'https://example.org/image.png' };
    const other = { type: 'resource', data: { count: 7 }, content: [image(protocol)] };
    const first = image(protocol), last = image(protocol);
    const output = [text, first, remote, other, 'raw text', null, last];
    const pair = toolPair(protocol, 'mixed', output);
    const result = pair[1];
    const body = bodyOf(protocol, [message(protocol, 'user', 'open image'), ...pair, message(protocol, 'user', 'next')]);
    const before = bytes(body), beforeBlocks = bytes(first) + bytes(last);
    const stats = slimImages(body, protocol, enabled({ keep_last_turns: 0, keep_last: 1 }));
    assert.equal(stats.images_total, 2);
    assert.equal(stats.images_removed, 1);
    assert.equal(stats.bytes_saved, bytes(first) - bytes(output[1]));
    assert.equal(stats.bytes_saved, before - bytes(body));
    assert.equal(beforeBlocks - bytes(output[1]) - bytes(output[6]), stats.bytes_saved);
    assert.equal(output[0], text);
    assert.equal(output[2], remote);
    assert.equal(output[3], other);
    assert.equal(output[4], 'raw text');
    assert.equal(output[5], null);
    assert.equal(output[6], last);
    assert.equal(protocol === 'responses' ? result.output
      : protocol === 'anthropic' ? result.content[0].content : result.content, output);
  });

  test(`${protocol}: attachments false only removes tool images`, () => {
    const attached = [image(protocol)];
    const original = attached[0];
    const output = [image(protocol)];
    const body = bodyOf(protocol, [
      message(protocol, 'user', attached), ...toolPair(protocol, 'tool', output),
      message(protocol, 'user', 'next'),
    ]);
    const stats = slimImages(body, protocol, enabled({ attachments: false, keep_last_turns: 0 }));
    assert.equal(stats.images_total, 2);
    assert.equal(stats.images_removed, 1);
    assert.equal(attached[0], original);
    assert.match(output[0].text, /Source: tool/);
  });

  test(`${protocol}: min_bytes measures the payload, excludes the data URL header and includes equality`, () => {
    const below = image(protocol, 'a'.repeat(8188));
    const boundary = image(protocol, payload);
    const content = [below, boundary];
    const body = bodyOf(protocol, [
      message(protocol, 'user', content), message(protocol, 'user', 'next'),
    ]);
    const stats = slimImages(body, protocol, enabled({ keep_last_turns: 0 }));
    assert.equal(stats.images_total, 2);
    assert.equal(stats.images_removed, 1);
    assert.equal(content[0], below);
    assert.equal(stats.bytes_saved, bytes(boundary) - bytes(content[1]));
  });

  test(`${protocol}: placeholders and the mutated body are stable across repeated calls`, () => {
    const content = [image(protocol)];
    const body = bodyOf(protocol, [
      message(protocol, 'user', content), message(protocol, 'user', [image(protocol)]),
    ]);
    const sameInput = structuredClone(body);
    const settings = enabled({ keep_last_turns: 0 });
    const first = slimImages(body, protocol, settings);
    assert.deepEqual(slimImages(sameInput, protocol, settings), first);
    assert.deepEqual(sameInput, body);
    const after = structuredClone(body);
    assert.deepEqual(slimImages(body, protocol, settings), { images_total: 1, images_removed: 0, bytes_saved: 0 });
    assert.deepEqual(body, after);
    assert.match(content[0].text, /No local path is available/);
    assert.doesNotMatch(content[0].text, /\/tmp\/|view_image|Use Read/);
  });
}

test('Responses recognizes omitted message type and preserves wrapped custom tool output', () => {
  const output = {
    content: [
      { type: 'text', text: 'captured' },
      { type: 'image', data: payload, mimeType: 'image/png' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: payload } },
      { type: 'image_url', image_url: { url: dataUrl(payload) } },
      { type: 'input_image', file_id: 'file-keep-me' },
    ],
    metadata: { opaque: true },
  };
  const outputRefs = [...output.content], metadata = output.metadata;
  const attachment = [image('responses')];
  const body = { input: [
    { role: 'user', content: attachment },
    { type: 'custom_tool_call', call_id: 'custom', name: 'functions.view_image', input: '{"path":"/tmp/custom.png"}' },
    { type: 'custom_tool_call_output', call_id: 'custom', output },
    { role: 'user', content: 'next' },
  ] };
  const before = bytes(body);
  const stats = slimImages(body, 'responses', enabled({ keep_last_turns: 0 }));
  assert.deepEqual(stats, { images_total: 4, images_removed: 4, bytes_saved: before - bytes(body) });
  assert.equal(body.input[2].output, output);
  assert.equal(output.metadata, metadata);
  assert.equal(output.content[0], outputRefs[0]);
  assert.equal(output.content[4], outputRefs[4]);
  for (const part of output.content.slice(1, 4)) {
    assert.equal(part.type, 'input_text');
    assert.match(part.text, /Source: tool functions\.view_image/);
    assert.match(part.text, /Local path: "\/tmp\/custom\.png"/);
    assert.match(part.text, /Use functions\.view_image to view it again/);
  }
});

test('Anthropic maps each tool_use id to its real tool and file_path, including UTF-8 paths', () => {
  const first = [image('anthropic')], second = [image('anthropic')];
  const path = '/tmp/\u622a\u56fe "one".png';
  const body = { messages: [
    { role: 'user', content: 'inspect' },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: path } },
      { type: 'tool_use', id: 'browser', name: 'browser_screenshot', input: {} },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'browser', content: second },
      { type: 'tool_result', tool_use_id: 'read', content: first },
    ] },
    { role: 'user', content: 'next' },
  ] };
  const before = bytes(body);
  const stats = slimImages(body, 'anthropic', enabled({ keep_last_turns: 0 }));
  assert.equal(stats.images_removed, 2);
  assert.equal(stats.bytes_saved, before - bytes(body));
  assert.ok(first[0].text.includes(JSON.stringify(path)));
  assert.match(first[0].text, /Source: tool Read/);
  assert.match(first[0].text, /Use Read to read it again/);
  assert.doesNotMatch(first[0].text, /view_image/);
  assert.match(second[0].text, /Source: tool browser_screenshot/);
  assert.match(second[0].text, /No local path is available/);
  assert.doesNotMatch(second[0].text, /\/tmp\/|Use Read|view_image/);
});

test('Chat links tool_calls by id and uses known Windows and relative paths', () => {
  const first = [image('chat')], second = [image('chat')];
  const path = 'C:\\screenshots\\one.png';
  const body = { messages: [
    { role: 'user', content: 'inspect' },
    ...toolPair('chat', 'one', first, 'view_image', { path }),
    ...toolPair('chat', 'two', second, 'Read', { file_path: './two.png' }),
    { role: 'user', content: 'next' },
  ] };
  assert.equal(slimImages(body, 'chat', enabled({ keep_last_turns: 0 })).images_removed, 2);
  assert.ok(first[0].text.includes(JSON.stringify(path)));
  assert.match(first[0].text, /Source: tool view_image/);
  assert.match(first[0].text, /Use view_image to view it again/);
  assert.match(second[0].text, /Source: tool Read/);
  assert.ok(second[0].text.includes('"./two.png"'));
});

test('Responses keeps tool names but never invents local paths from invalid arguments or URLs', () => {
  for (const args of ['broken JSON', 'null', '42', '[]', '{"path":"https://example.org/image.png"}']) {
    const output = [image('responses')];
    const body = { input: [
      { role: 'user', content: 'inspect' },
      { type: 'function_call', call_id: 'call', name: 'view_image', arguments: args },
      { type: 'function_call_output', call_id: 'call', output },
      { role: 'user', content: 'next' },
    ] };
    assert.equal(slimImages(body, 'responses', enabled({ keep_last_turns: 0 })).images_removed, 1, args);
    assert.match(output[0].text, /Source: tool view_image/);
    assert.match(output[0].text, /No local path is available/);
    assert.doesNotMatch(output[0].text, /Local path:|https:\/\/|\/tmp\//);
  }
});

test('unmatched tool results remain tools when attachments is false', () => {
  for (const protocol of ['anthropic', 'responses', 'chat']) {
    const content = [image(protocol)];
    const result = toolPair(protocol, 'missing', content)[1];
    const body = bodyOf(protocol, [
      message(protocol, 'user', 'inspect'), result, message(protocol, 'user', 'next'),
    ]);
    assert.equal(slimImages(body, protocol, enabled({ keep_last_turns: 0, attachments: false })).images_removed, 1);
    assert.match(content[0].text, /Source: tool \(unknown\)/);
    assert.match(content[0].text, /No local path is available/);
  }
});

test('remote images, file IDs, non-image data URLs and unknown shapes are preserved', () => {
  const content = [
    null, 42, 'text',
    { type: 'input_image', image_url: 'https://example.org/image.png' },
    { type: 'input_image', file_id: 'file-1' },
    { type: 'input_image', image_url: 'data:image/svg+xml,%3Csvg%3E' },
    { type: 'input_image', image_url: 'data:application/pdf;base64,' + payload },
    { type: 'input_image', image_url: 'data:image/png;base64,' },
    { type: 'image_url', image_url: { url: 'https://example.org/image.png' } },
    { type: 'image_url', image_url: { unknown: dataUrl(payload) } },
    { type: 'image', source: { type: 'url', url: 'https://example.org/image.png' } },
    { type: 'image', source: { type: 'base64', media_type: 'application/pdf', data: payload } },
    { type: 'image', source: { type: 'base64', data: payload } },
    { type: 'image', data: payload },
    { type: 'input_file', file_data: dataUrl(payload) },
    { type: 'unknown', image_url: dataUrl(payload), content: [image('responses')] },
  ];
  for (const protocol of ['anthropic', 'responses', 'chat']) {
    const body = bodyOf(protocol, [
      message(protocol, 'user', content),
      ...toolPair(protocol, 'unknown', content),
      message(protocol, 'user', 'next'),
    ]);
    const before = structuredClone(body);
    assert.deepEqual(slimImages(body, protocol, enabled({ keep_last_turns: 0, min_bytes: 0 })), emptyStats, protocol);
    assert.deepEqual(body, before, protocol);
  }
});

test('unsupported protocols and body shapes stay unchanged', () => {
  for (const body of [null, [], 'text', {}, { input: 'text' }, { messages: { content: [] } }]) {
    const before = structuredClone(body);
    for (const protocol of ['anthropic', 'responses', 'chat', 'unknown']) {
      assert.deepEqual(slimImages(body, protocol, enabled()), emptyStats);
      assert.deepEqual(body, before);
    }
  }
  const body = { input: [
    null, 1, { type: 'unknown', role: 'user', content: [image('responses')] },
    { type: 'function_call_output', call_id: 'unknown', output: { unexpected: [image('responses')] } },
  ] };
  const before = structuredClone(body);
  assert.deepEqual(slimImages(body, 'responses', enabled()), emptyStats);
  assert.deepEqual(body, before);
});

test('keeping more turns or images than available preserves the complete history', () => {
  for (const settings of [enabled({ keep_last_turns: 99 }), enabled({ keep_last_turns: 0, keep_last: 99 })]) {
    const body = { input: [
      { role: 'user', content: [image('responses'), image('responses')] },
      { role: 'user', content: 'next' },
    ] };
    const before = structuredClone(body);
    assert.deepEqual(slimImages(body, 'responses', settings), { images_total: 2, images_removed: 0, bytes_saved: 0 });
    assert.deepEqual(body, before);
  }
});

test('only replaced blocks are serialized for byte accounting', () => {
  const output = [image('responses')];
  const body = { input: [
    { role: 'user', content: 'inspect' },
    ...toolPair('responses', 'tool', output),
    { role: 'user', content: 'next' },
  ] };
  body.toJSON = () => { throw new Error('whole body serialization is forbidden'); };
  body.input[0].toJSON = () => { throw new Error('whole message serialization is forbidden'); };
  body.input[2].toJSON = () => { throw new Error('whole output serialization is forbidden'); };
  const before = bytes(output[0]);
  const stats = slimImages(body, 'responses', enabled({ keep_last_turns: 0 }));
  assert.equal(stats.images_removed, 1);
  assert.equal(stats.bytes_saved, before - bytes(output[0]));
});
