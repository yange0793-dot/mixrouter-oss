'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'public/js/settings.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const defaults = { enabled: false, keep_last: 0, keep_last_turns: 1, min_bytes: 8192, attachments: true };
const ids = {
  enabled: 'image-slim-enabled', keep_last: 'image-slim-keep-last',
  keep_last_turns: 'image-slim-keep-turns', min_bytes: 'image-slim-min-bytes', attachments: 'image-slim-attachments',
};

function harness() {
  const elements = new Map(), calls = [], confirmations = [], events = new Map();
  for (const match of html.matchAll(/<[\w-]+\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const attrs = Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    const classes = new Set();
    elements.set(match[1], {
      attrs, type: attrs.type, _value: '', checked: false, disabled: /\bdisabled\b/.test(match[0]),
      style: {}, textContent: '', title: '', valid: true, validityReports: 0,
      get value() { return this._value; },
      set value(value) { this._value = String(value); },
      get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      reportValidity() { this.validityReports++; return this.valid; },
      classList: {
        contains: name => classes.has(name),
        remove: name => classes.delete(name),
        toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      },
    });
  }
  const get = id => { assert.ok(elements.has(id), 'Unknown element: ' + id); return elements.get(id); };
  const server = { settings: { ...defaults }, stats: { requests: 0, images_removed: 0, bytes_saved: 0 } };
  const normalResponse = async (url, options = {}) => {
    assert.equal(url, '/api/image-slim');
    if (options.method === 'PUT') Object.assign(server.settings, JSON.parse(options.body));
    return structuredClone(server);
  };
  let respond = normalResponse, confirmResult = true;
  const context = vm.createContext({
    $: get, document: { getElementById: get, querySelector: () => null },
    window: { addEventListener: (name, fn) => events.set(name, fn) },
    api: (url, options = {}) => { calls.push({ url, options }); return respond(url, options); },
    askConfirm: async (...args) => { confirmations.push(args); return confirmResult; },
    fmtWhen: () => '12:34:56',
    VIEWS: ['overview', 'settings'], VIEW_LABELS: { overview: '概览', settings: '设置与备份' },
    view: 'overview', syncViewNav() {}, logsTimer: null, clearInterval() {}, ensureHealth() {}, refresh() {},
  });
  const run = code => vm.runInContext(code, context);
  run(appSource.slice(appSource.indexOf('const finiteOrNull'), appSource.indexOf('// 时延:')));
  run(source);
  run('backupsLoaded = true');
  run(appSource.slice(appSource.indexOf('function showView(name)'), appSource.indexOf('// 健康快照按需读取一次')));
  return {
    get, run, calls, server, confirmations, events,
    edit(key, value) {
      const input = get(ids[key]);
      if (input.type === 'checkbox') input.checked = value;
      else input.value = value;
      run('markImageSlimDirty()');
    },
    respond(fn = normalResponse) { respond = fn; },
    confirm(value) { confirmResult = value; },
    settle: () => new Promise(resolve => setImmediate(resolve)),
  };
}

async function loaded() {
  const h = harness();
  await h.run('loadImageSlim()');
  return h;
}

test('进入设置页读取真实设置；产品默认关闭，未读取时禁止编辑', async () => {
  const h = harness();
  assert.equal(h.get('image-slim-fields').disabled, true);
  assert.equal(h.get('image-slim-save').disabled, true);
  h.run("showView('overview')");
  assert.equal(h.calls.length, 0);
  h.run("showView('settings')");
  await h.settle();
  assert.deepEqual(h.calls.map(call => call.url), ['/api/image-slim']);
  assert.equal(h.get(ids.enabled).checked, false);
  assert.equal(h.get(ids.attachments).checked, true);
  assert.equal(h.get(ids.keep_last_turns).value, '1');
  assert.equal(h.get(ids.keep_last).value, '0');
  assert.equal(h.get(ids.min_bytes).value, '8192');
  assert.equal(h.get('image-slim-fields').disabled, false);
  assert.equal(h.get('image-slim-save').disabled, true);
  assert.equal(h.get('image-slim-requests').textContent, '0');
  assert.equal(h.get('image-slim-images').textContent, '0');
  assert.equal(h.get('image-slim-bytes').textContent, '0B');
});

test('表单沿用原生数值约束与提交处理，阈值单位明确为字节', () => {
  const h = harness();
  for (const key of ['keep_last_turns', 'keep_last', 'min_bytes']) {
    const input = h.get(ids[key]);
    assert.equal(input.type, 'number');
    assert.equal(input.attrs.min, '0');
    assert.equal(input.attrs.max, key === 'min_bytes' ? '2147483647' : '1000');
    assert.equal(input.attrs.step, '1');
    assert.match(html, new RegExp(`id="${ids[key]}"[^>]*\\brequired\\b`));
  }
  assert.match(html, /小图阈值（字节）/);
  assert.equal(h.get('image-slim-form').attrs.onsubmit, 'event.preventDefault();saveImageSlim()');
  assert.equal(h.get('image-slim-form').attrs.oninput, 'markImageSlimDirty()');
  assert.equal(h.get('image-slim-reload').attrs.onclick, 'loadImageSlim(true)');
  assert.equal(h.get('image-slim-status').attrs['aria-live'], 'polite');
  assert.doesNotMatch(html, /全部只读/);
});

test('编辑后标记草稿，改回已保存值后清除 dirty', async () => {
  const h = await loaded();
  h.edit('enabled', true);
  assert.equal(h.run('imageSlimDirty'), true);
  assert.equal(h.get('image-slim-save').disabled, false);
  assert.match(h.get('image-slim-status').textContent, /未保存/);
  h.edit('enabled', false);
  assert.equal(h.run('imageSlimDirty'), false);
  assert.equal(h.get('image-slim-save').disabled, true);
  await h.run('saveImageSlim()');
  assert.equal(h.calls.length, 1, '未修改不发 PUT');
});

test('保存只发送平铺的变更字段，布尔与整数不转成字符串', async () => {
  const h = await loaded();
  h.edit('enabled', true);
  h.edit('attachments', false);
  h.edit('keep_last_turns', 2);
  h.server.stats = { requests: 1234, images_removed: 2345, bytes_saved: 1048576 };
  await h.run('saveImageSlim()');
  const put = h.calls.find(call => call.options.method === 'PUT');
  assert.deepEqual(JSON.parse(put.options.body), { enabled: true, keep_last_turns: 2, attachments: false });
  assert.equal(h.get('image-slim-form').validityReports, 1);
  assert.equal(h.run('imageSlimDirty'), false);
  assert.equal(h.get('image-slim-save').disabled, true);
  assert.equal(h.get('image-slim-requests').textContent, '1,234');
  assert.equal(h.get('image-slim-images').textContent, '2,345');
  assert.equal(h.get('image-slim-bytes').textContent, '1.0MB');
  assert.equal(h.get('image-slim-bytes').title, '1,048,576 字节');
  assert.match(h.get('image-slim-status').textContent, /已保存并生效/);
});

test('原生校验失败不发请求，保留空白草稿', async () => {
  const h = await loaded();
  h.edit('min_bytes', '');
  h.get('image-slim-form').valid = false;
  await h.run('saveImageSlim()');
  assert.equal(h.get('image-slim-form').validityReports, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.get(ids.min_bytes).value, '');
  assert.equal(h.run('imageSlimDirty'), true);
  assert.match(h.get('image-slim-status').textContent, /范围内的整数/);
});

test('零值和允许的最大整数原样提交，阈值不做隐式单位转换', async () => {
  const h = await loaded();
  h.edit('keep_last_turns', 0);
  h.edit('min_bytes', 0);
  await h.run('saveImageSlim()');
  assert.deepEqual(JSON.parse(h.calls.at(-1).options.body), { keep_last_turns: 0, min_bytes: 0 });
  h.edit('keep_last_turns', 1000);
  h.edit('keep_last', 1000);
  h.edit('min_bytes', 2147483647);
  await h.run('saveImageSlim()');
  assert.deepEqual(JSON.parse(h.calls.at(-1).options.body), { keep_last_turns: 1000, keep_last: 1000, min_bytes: 2147483647 });
});

test('保存失败保留草稿与已读基线，重试成功后才清除 dirty', async () => {
  const h = await loaded();
  h.edit('keep_last', 3);
  h.respond(async () => { throw new Error('磁盘写入失败'); });
  await h.run('saveImageSlim()');
  assert.equal(h.get(ids.keep_last).value, '3');
  assert.equal(h.run('imageSlimSettings.keep_last'), 0);
  assert.equal(h.run('imageSlimDirty'), true);
  assert.equal(h.get('image-slim-save').disabled, false);
  assert.match(h.get('image-slim-status').textContent, /保存失败.*磁盘写入失败.*修改未保存/);
  assert.equal(h.get('image-slim-status').classList.contains('is-err'), true);
  h.respond();
  await h.run('saveImageSlim()');
  assert.equal(h.run('imageSlimSettings.keep_last'), 3);
  assert.equal(h.run('imageSlimDirty'), false);
  assert.equal(h.get('image-slim-status').classList.contains('is-err'), false);
});

test('初次读取失败允许重试，不把缺省值冒充已读取设置', async () => {
  const h = harness();
  h.respond(async () => { throw new Error('HTTP 503'); });
  await h.run('loadImageSlim()');
  assert.equal(h.run('imageSlimSettings'), null);
  assert.equal(h.get('image-slim-fields').disabled, true);
  assert.equal(h.get('image-slim-save').disabled, true);
  assert.equal(h.get('image-slim-reload').disabled, false);
  assert.match(h.get('image-slim-status').textContent, /读取失败.*503.*重新读取/);
  await h.run('saveImageSlim()');
  assert.equal(h.calls.length, 1);
  h.respond();
  h.server.settings.enabled = true;
  await h.run('loadImageSlim()');
  assert.equal(h.get(ids.enabled).checked, true, '本机已启用时显示服务器实际值');
  assert.equal(h.get('image-slim-fields').disabled, false);
});

test('切回页面和全局刷新保留草稿，重读只更新统计', async () => {
  const h = await loaded();
  h.edit('keep_last_turns', 7);
  h.server.settings.keep_last_turns = 2;
  h.server.stats = { requests: 4, images_removed: 12, bytes_saved: 65536 };
  h.run("showView('overview'); refresh(); showView('settings')");
  await h.settle();
  assert.equal(h.get(ids.keep_last_turns).value, '7');
  assert.equal(h.run('imageSlimDirty'), true);
  assert.equal(h.get('image-slim-requests').textContent, '4');
  assert.equal(h.get('image-slim-images').textContent, '12');
  assert.equal(h.get('image-slim-bytes').textContent, '64.0KB');
  assert.match(h.get('image-slim-status').textContent, /已更新统计.*未保存/);
  assert.equal(h.confirmations.length, 0);
});

test('手动重读先确认丢弃草稿，取消不请求；确认成功才更新表单', async () => {
  const h = await loaded();
  h.edit('keep_last_turns', 7);
  h.server.settings.keep_last_turns = 2;
  h.confirm(false);
  await h.run('loadImageSlim(true)');
  assert.equal(h.calls.length, 1);
  assert.equal(h.get(ids.keep_last_turns).value, '7');
  assert.equal(h.run('imageSlimDirty'), true);
  assert.match(h.confirmations[0][1], /丢弃未保存/);
  h.confirm(true);
  await h.run('loadImageSlim(true)');
  assert.equal(h.calls.length, 2);
  assert.equal(h.get(ids.keep_last_turns).value, '2');
  assert.equal(h.run('imageSlimDirty'), false);
});

test('确认后的重读失败仍保留草稿和旧统计，标明统计过期', async () => {
  const h = await loaded();
  h.edit('keep_last', 9);
  h.respond(async () => { throw new Error('离线'); });
  await h.run('loadImageSlim(true)');
  assert.equal(h.get(ids.keep_last).value, '9');
  assert.equal(h.run('imageSlimDirty'), true);
  assert.equal(h.get('image-slim-requests').textContent, '0');
  assert.equal(h.get('image-slim-stats').classList.contains('is-stale'), true);
  assert.equal(h.get('image-slim-save').disabled, false);
  assert.match(h.get('image-slim-status').textContent, /读取失败.*草稿已保留.*统计停在 12:34:56/);
});

test('保存进行中禁用表单和按钮，重复保存或读取不会再发请求', async () => {
  const h = await loaded();
  h.edit('enabled', true);
  let resolve;
  h.respond(() => new Promise(done => { resolve = done; }));
  const saving = h.run('saveImageSlim()');
  assert.equal(h.get('image-slim-fields').disabled, true);
  assert.equal(h.get('image-slim-save').disabled, true);
  assert.equal(h.get('image-slim-reload').disabled, true);
  assert.equal(h.get('image-slim-form').attrs['aria-busy'], 'true');
  assert.match(h.get('image-slim-status').textContent, /正在保存/);
  await h.run('saveImageSlim(); loadImageSlim(true)');
  assert.equal(h.calls.length, 2);
  resolve({ settings: { ...defaults, enabled: true }, stats: h.server.stats });
  await saving;
  assert.equal(h.get('image-slim-fields').disabled, false);
  assert.equal(h.get('image-slim-reload').disabled, false);
  assert.equal(h.get('image-slim-form').attrs['aria-busy'], 'false');
});

test('读取进行中禁用编辑且不重复请求，结束后恢复控件', async () => {
  const h = harness();
  let resolve;
  h.respond(() => new Promise(done => { resolve = done; }));
  const loading = h.run('loadImageSlim()');
  assert.equal(h.get('image-slim-fields').disabled, true);
  assert.equal(h.get('image-slim-reload').disabled, true);
  assert.match(h.get('image-slim-status').textContent, /正在读取/);
  await h.run('loadImageSlim()');
  assert.equal(h.calls.length, 1);
  resolve(structuredClone(h.server));
  await loading;
  assert.equal(h.get('image-slim-fields').disabled, false);
  assert.equal(h.get('image-slim-reload').disabled, false);
});

test('页面刷新或关闭时未保存草稿触发离开提醒，保存后不再触发', async () => {
  const h = await loaded();
  let prevented = 0;
  const unload = () => h.events.get('beforeunload')({ preventDefault() { prevented++; } });
  unload();
  assert.equal(prevented, 0);
  h.edit('enabled', true);
  unload();
  assert.equal(prevented, 1);
  await h.run('saveImageSlim()');
  unload();
  assert.equal(prevented, 1);
});
