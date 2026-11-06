'use strict';
// 渠道弹窗里的「从上游获取模型」:只跑真实 public/js/app.js 的经典脚本,配一个最小 DOM/fetch 边界。
// 这里不碰真实网络、不写用户配置;每个用例自己决定 /api/providers/models 返回什么(含延迟响应)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const source = require('./console-source').consoleSource();
const { runConsole } = require('./console-source');

function fixture() {
  return {
    version: 'test', proxy_port: 8787, ui_port: 8788, uptime_s: 125, pid: 4242, code_revision: 'abcdef0123456789',
    stats: { reqs: 12, inTok: 100, outTok: 40 },
    providers: {
      claude: [
        { id: 'a1', name: 'Alpha', base_url: 'https://anthropic.example', models: ['claude-special'], slots: { opus: 'slot-model' }, enabled: true, key_masked: '***',
          keys: [{ id: 'k1', label: 'Account One', enabled: true }, { id: 'k2', label: 'Account Two', enabled: true }, { id: 'k-off', label: 'Disabled Key', enabled: false }], active_key: 'k1' },
        { id: 'a2', name: 'Solo', base_url: 'https://solo.example', models: ['solo-model'], enabled: true, key_masked: 'sk-***-saved' },
      ],
      codex: [
        { id: 'o1', name: 'Beta', base_url: 'https://openai.example/v1', model: 'gpt-test', wire_api: 'responses', enabled: true },
        { id: 'o2', name: 'Chat gateway', base_url: 'https://chat.example/v1', model: 'text-model', wire_api: 'chat', enabled: false },
      ],
    },
    current: { claude: 'a1', codex: null, zcode: null },
    live: {
      claude: { base_url: 'https://anthropic.example', model: 'claude-special', match: true, router: false },
      codex: { base_url: '', match: true, router: false },
      zcode: { base_url: '', model: '', match: true, router: false },
    },
    router: { id: '@router', url: 'http://127.0.0.1:8787', claude_base: 'http://127.0.0.1:8787', codex_base: 'http://127.0.0.1:8787/v1', zcode_base: 'http://127.0.0.1:8787/custom' },
    routes: { rules: [{ id: 'r1', match: 'claude', provider: 'a1', model: '', enabled: true, pool: [], when: {} }], default: { provider: 'a1', model: '', pool: [] } },
    slots: {
      claude: ['main', 'opus', 'sonnet', 'haiku', 'subagent'].map(name => ({
        name, alias: 'mixr-' + name,
        env: { main: 'ANTHROPIC_MODEL', subagent: 'CLAUDE_CODE_SUBAGENT_MODEL' }[name] || 'ANTHROPIC_DEFAULT_' + name.toUpperCase() + '_MODEL',
        provider: name === 'main' ? 'a1' : '', provider_name: name === 'main' ? 'Alpha' : '', enabled: true,
        model: name === 'main' ? 'claude-special' : '',
      })),
      codex: [],
    },
    sessions: [], cooldowns: [],
  };
}

function reply(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(payload) };
}
// vm 里造出来的数组有不同的原型;断言前转成本 realm 的普通数组。
const list = value => JSON.parse(JSON.stringify(value));

async function harness(data = fixture()) {
  const elements = new Map();
  const listeners = new Map();
  let document;
  class Element {
    constructor(id = '', tag = 'div') {
      this.id = id; this.tagName = tag.toUpperCase(); this.style = {}; this.dataset = {};
      this.attributes = {}; this.value = ''; this.checked = false; this.disabled = false;
      this.hidden = false; this.inert = false; this.isConnected = true; this.children = [];
      this.parentElement = null; this.events = {}; this.htmlWrites = 0; this.textContent = '';
      const classes = new Set();
      this.classList = {
        add: (...xs) => xs.forEach(x => classes.add(x)),
        remove: (...xs) => xs.forEach(x => classes.delete(x)),
        contains: x => classes.has(x),
        toggle: (x, force) => { const on = force ?? !classes.has(x); if (on) classes.add(x); else classes.delete(x); return on; },
      };
    }
    set innerHTML(value) {
      this._html = value; this.htmlWrites++;
      for (const match of value.matchAll(/<(input|select|button|div|label)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const el = new Element(match[2], match[1]); el.parentElement = this; elements.set(el.id, el);
        el.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
        el.checked = /\bchecked\b/.test(match[0]);
        if (/\bdisabled\b/.test(match[0])) el.disabled = true;
      }
    }
    get innerHTML() { return this._html || ''; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
    focus() { document.activeElement = this; for (const fn of this.events.focus || []) fn({ target: this }); }
    blur() { document.activeElement = document.body; for (const fn of this.events.blur || []) fn({ target: this }); }
    contains(el) { return el === this || !!el?.parentElement && this.contains(el.parentElement); }
    matches(selector) { return selector.split(',').some(s => s.trim() === this.tagName.toLowerCase()); }
    getClientRects() { return this.hidden ? [] : [{}]; }
    querySelectorAll(selector) {
      if (selector.includes(':disabled')) return this.children.filter(el => !el.disabled && ['BUTTON', 'INPUT', 'SELECT'].includes(el.tagName));
      if (selector === 'button') return this.children.filter(el => el.tagName === 'BUTTON');
      return [];
    }
    querySelector(selector) { return selector === '.modal' ? this.modal : this.querySelectorAll(selector)[0] || null; }
    reportValidity() { return true; }
    click() { if (this.onclick) this.onclick({ preventDefault() {} }); else if (this.inlineOnclick) inlineRun(this.inlineOnclick); }
  }
  let inlineRun = () => {};
  for (const m of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const el = new Element(m[2], m[1]);
    const inline = m[0].match(/\bonclick="([^"]*)"/)?.[1];
    if (inline) el.inlineOnclick = inline;
    const styleText = m[0].match(/\bstyle="([^"]*)"/)?.[1];
    if (styleText) for (const decl of styleText.split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) el.style[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
    elements.set(m[2], el);
  }
  const get = id => { assert.ok(elements.has(id), 'Unknown DOM id: ' + id); return elements.get(id); };
  const body = new Element('body', 'body');
  const nav = Array.from(html.matchAll(/<a\b[^>]*\bdata-view="([^"]+)"[^>]*>/g), match => {
    const el = new Element('nav-' + match[1], 'a');
    el.dataset.view = match[1];
    return el;
  });
  const tabs = new Element('tabs');
  document = {
    body, activeElement: body,
    getElementById: id => elements.get(id) || null,
    querySelectorAll: selector => selector === 'nav a' ? nav : [],
    querySelector: selector => selector === '.apptabs' ? tabs : nav.find(el => selector.includes(`data-view="${el.dataset.view}"`)) || null,
    addEventListener: (event, fn) => { (listeners.get(event) || listeners.set(event, []).get(event)).push(fn); },
    createElement: tag => new Element('', tag),
  };
  // 弹窗的取消/保存按钮和输入框挂在 #mask 下(焦点包含、保存时的表单校验都读它)。
  for (const [maskId, controls] of [['mask', ['m-name', 'm-base', 'm-key', 'save-provider']], ['confirm-mask', ['confirm-cancel', 'confirm-ok']]]) {
    const mask = get(maskId); mask.modal = new Element(maskId + '-dialog'); mask.modal.parentElement = mask;
    mask.children = controls.map(id => { const el = get(id); el.parentElement = mask; return el; });
  }
  get('provider-filter').value = 'all'; get('logs-auto').checked = true;
  const requests = [];
  let fetchImpl = null;
  const context = vm.createContext({
    document, window: { addEventListener() {}, localStorage: undefined }, console, URL, URLSearchParams, AbortController, structuredClone,
    Blob: class Blob { constructor(parts, opts = {}) { this.parts = parts; this.type = opts.type || ''; } },
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval() { return 1; }, clearInterval() {},
    fetch: async (url, options = {}) => {
      const bodyText = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, method: options.method || 'GET', body: bodyText });
      if (fetchImpl) return fetchImpl(url, options);
      if (url === '/api/state') return { ok: true, json: async () => structuredClone(data) };
      if (url === '/api/stats') return { ok: true, json: async () => ({ reqs: 12, ok_rate: 100, inTok: 100, outTok: 40, cache: 0 }) };
      if (url === '/api/logs' || url.startsWith('/api/logs?')) return { ok: true, json: async () => ({ logs: [] }) };
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  const run = code => vm.runInContext(code, context);
  inlineRun = code => run(`(function(event){${code}})({ preventDefault(){} })`);
  runConsole(context);
  await run('refreshTask');
  return {
    data, get, run, requests, document, listeners,
    fetchStub(fn) { fetchImpl = fn; },
  };
}

const providerReqs = h => h.requests.filter(r => r.url === '/api/providers/models');

test('新渠道只填 URL 和 Key 就能取模型，勾选后追加到 Claude 列表且不自动保存', async () => {
  const h = await harness();
  h.fetchStub(async () => reply(200, { models: ['claude-a', 'claude-b', 'manual-first', 'claude-c'] }));
  h.run('openProvider()');
  h.get('m-base').value = 'https://api.example.com';
  h.get('m-key').value = 'sk-test';
  h.run("addModelDraft(); modelDraft[0].value='manual-first'");
  await h.run('fetchProviderModels()');
  assert.equal(providerReqs(h).length, 1);
  assert.deepEqual(providerReqs(h)[0].body, { base_url: 'https://api.example.com', api_key: 'sk-test', wire_api: 'anthropic', direct: false },
    '不要求名称/模型,只带地址、Key、协议与直连标记');
  assert.match(h.get('m-model-fetch-status').textContent, /已获取 4 个模型/);
  assert.match(h.get('m-model-discovery').innerHTML, /claude-a/);
  assert.equal(h.get('m-model-add-selected').disabled, true, '没勾选时不能应用');
  h.run('toggleDiscoveryModel(0,true); toggleDiscoveryModel(1,true); toggleDiscoveryModel(3,true)');
  assert.match(h.get('m-model-add-selected').textContent, /3/);
  h.run('applyDiscoverySelection()');
  assert.deepEqual(list(h.run('modelDraft.map(r => r.value)')), ['manual-first', 'claude-a', 'claude-b', 'claude-c'],
    '保留已填的第一项/手工行,只把勾选的模型追加到末尾');
  assert.equal(h.requests.some(r => r.url.startsWith('/api/providers') && r.url !== '/api/providers/models' && r.method !== 'GET'), false,
    '获取与勾选都不落库,必须手动保存');
});

test('重新获取只替换候选，搜索过滤与上游模型名转义', async () => {
  const h = await harness();
  let round = 0;
  h.fetchStub(async () => (++round === 1
    ? reply(200, { models: ['alpha', 'beta', 'gamma'] })
    : reply(200, { models: ['<img src=x onerror="alert(1)">', 'delta'] })));
  h.run('openProvider()');
  h.get('m-base').value = 'https://api.example.com'; h.get('m-key').value = 'sk-test';
  await h.run('fetchProviderModels()');
  h.run('toggleDiscoveryModel(0,true)');
  h.run("setDiscoveryQuery('bet')");
  assert.equal(h.run('discoveryVisibleModels().length'), 1);
  assert.match(h.get('m-model-discovery').innerHTML, /m-model-opt-1/, '过滤后保留原候选下标');
  h.run("setDiscoveryQuery('')");
  await h.run('fetchProviderModels()');
  assert.deepEqual(list(h.run('discoveryState.models')), ['<img src=x onerror="alert(1)">', 'delta']);
  assert.deepEqual(list(h.run('discoveryState.selected')), [], '新一轮候选不继承上一次勾选');
  assert.equal(h.get('m-model-discovery').innerHTML.includes('<img'), false, '模型名按文本转义,不当作 HTML');
  assert.match(h.get('m-model-discovery').innerHTML, /&lt;img/);
});

test('输入变化后旧响应作废：不覆盖候选、不写成功状态', async () => {
  const h = await harness();
  let release;
  h.fetchStub(() => new Promise(resolve => { release = resolve; }));
  h.run('openProvider()');
  h.get('m-base').value = 'https://api.example.com'; h.get('m-key').value = 'sk-test';
  const pending = h.run('fetchProviderModels()');
  assert.equal(h.get('m-fetch-models').disabled, true, '请求期间按钮禁用');
  assert.match(h.get('m-model-fetch-status').textContent, /正在向上游获取/);
  h.get('m-base').value = 'https://changed.example.com';
  for (const listener of h.get('m-base').events.input) listener({ target: h.get('m-base') });
  release(reply(200, { models: ['stale-model'] }));
  await pending;
  assert.deepEqual(list(h.run('discoveryState.models')), [], '改过地址后旧响应不能再填进表单');
  assert.doesNotMatch(h.get('m-model-fetch-status').textContent, /已获取/);
  assert.equal(h.get('m-fetch-models').disabled, false);
});

test('关闭弹窗或换开另一条渠道：清空候选，迟到响应不串到新编辑器', async () => {
  const h = await harness();
  let release;
  h.fetchStub(() => new Promise(resolve => { release = resolve; }));
  h.run("openProvider('a1')");
  await (async () => {
    // 先成功取一次候选，确认关闭后会被清掉
    h.fetchStub(async () => reply(200, { models: ['kept-model'] }));
    const pending = h.run('fetchProviderModels()');
    await pending;
  })();
  assert.deepEqual(list(h.run('discoveryState.models')), ['kept-model']);
  h.run("setDiscoveryQuery('keep'); toggleDiscoveryModel(0,true)");
  h.run('closeModal()');
  assert.deepEqual(list(h.run('discoveryState.models')), []);
  assert.equal(h.get('m-model-search').value, '');
  assert.match(h.get('m-model-discovery').innerHTML, /还没有获取到模型/);
  // 再开另一条渠道，并让上一次请求在关窗后才回来
  h.fetchStub(() => new Promise(resolve => { release = resolve; }));
  h.run("openProvider('a2')");
  const pending = h.run('fetchProviderModels()');
  h.run('closeModal()');
  h.run("openProvider('a1')");
  release(reply(200, { models: ['leaked-model'] }));
  await pending;
  assert.deepEqual(list(h.run('discoveryState.models')), [], '关窗后回来的响应不能落进下一个编辑器');
  assert.doesNotMatch(h.get('m-model-discovery').innerHTML, /leaked-model/);
  assert.equal(h.run('editing.id'), 'a1');
});

test('已取到候选后改地址/Key：候选与勾选立即清空，之后请求失败也加不进旧渠道的模型', async () => {
  const h = await harness();
  h.fetchStub(async () => reply(200, { models: ['old-a', 'old-b'] }));
  h.run('openProvider()');
  h.run("addModelDraft(); modelDraft[0].value='manual-keep'");   // 用户已填的行:清候选时不能动
  h.get('m-base').value = 'https://old.example'; h.get('m-key').value = 'sk-old';
  await h.run('fetchProviderModels()');
  h.run('toggleDiscoveryModel(0,true)');
  assert.equal(h.run('discoveryState.selected.length'), 1);
  // 换地址:候选与勾选一起作废,并提示重取
  h.get('m-base').value = 'https://new.example';
  for (const listener of h.get('m-base').events.input) listener({ target: h.get('m-base') });
  assert.deepEqual(list(h.run('discoveryState.models')), []);
  assert.deepEqual(list(h.run('discoveryState.selected')), []);
  assert.match(h.get('m-model-fetch-status').textContent, /重新获取/);
  assert.equal(h.get('m-model-add-selected').disabled, true);
  assert.doesNotMatch(h.get('m-model-discovery').innerHTML, /old-a/);
  // 新地址请求失败:也不能把旧候选加进模型列表
  h.fetchStub(async () => reply(502, { error: '上游 401' }));
  await h.run('fetchProviderModels()');
  h.run('applyDiscoverySelection()');
  assert.deepEqual(list(h.run('modelDraft.map(r => r.value)')), ['manual-keep'], '失败后模型列表仍是原样,旧渠道的模型没有被加进来');
  assert.equal(h.requests.some(r => r.url.startsWith('/api/providers') && r.method !== 'GET' && r.url !== '/api/providers/models'), false);
  // Key 改动同样清空
  h.fetchStub(async () => reply(200, { models: ['k-model'] }));
  h.get('m-key').value = 'sk-new';
  await h.run('fetchProviderModels()');
  h.get('m-key').value = 'sk-newer';
  for (const listener of h.get('m-key').events.input) listener({ target: h.get('m-key') });
  assert.deepEqual(list(h.run('discoveryState.models')), []);
  assert.equal(h.run('discoveryState.query'), '');
  // 没取到过候选时改输入,不弹一条莫名其妙的「请重新获取」
  h.run('resetModelDiscovery()');
  h.get('m-base').value = 'https://typed.example';
  for (const listener of h.get('m-base').events.input) listener({ target: h.get('m-base') });
  assert.match(h.get('m-model-fetch-status').textContent, /填好 Base URL 与 API Key/);
});

test('错误、空列表与缺字段都只给状态，不写候选', async () => {
  const h = await harness();
  const cases = [
    [reply(502, { error: '上游 401：Key 无效' }), /获取失败：上游 401：Key 无效/],
    [reply(200, { models: [] }), /空的模型列表/],
    [reply(200, { ok: true }), /响应缺少 models 列表/],
  ];
  h.run('openProvider()');
  h.get('m-base').value = 'https://api.example.com'; h.get('m-key').value = 'sk-test';
  for (const [response, expected] of cases) {
    h.fetchStub(async () => response);
    await h.run('fetchProviderModels()');
    assert.match(h.get('m-model-fetch-status').textContent, expected);
    assert.deepEqual(list(h.run('discoveryState.models')), []);
    assert.equal(h.get('m-fetch-models').disabled, false, '失败后按钮恢复可用');
  }
  const sent = providerReqs(h).length;
  h.run('closeModal()'); h.run('openProvider()');
  h.get('m-base').value = 'https://api.example.com';
  h.fetchStub(async () => { throw new Error('should not be called'); });
  await h.run('fetchProviderModels()');
  assert.match(h.get('m-model-fetch-status').textContent, /请先填 API Key/);
  assert.equal(providerReqs(h).length, sent, '新渠道没 Key 时不发请求');
});

test('已保存多账号渠道：默认用当前生效 Key，可指定账号，手填 Key 覆盖且绝不下发掩码', async () => {
  const h = await harness();
  h.fetchStub(async () => reply(200, { models: ['m1'] }));
  h.run("openProvider('a1')");
  assert.notEqual(h.get('m-fetch-key-wrap').style.display, 'none', '多账号渠道显示 Key 选择');
  assert.match(h.get('m-fetch-key').innerHTML, /Account One/);
  assert.equal(h.run('discoveryState.fetchKeyId'), '', '默认是当前生效 Key');
  await h.run('fetchProviderModels()');
  assert.deepEqual(providerReqs(h).at(-1).body, { base_url: 'https://anthropic.example', wire_api: 'anthropic', direct: false, provider_id: 'a1', key_id: 'k1' },
    '默认落到草稿里 active_key 那一行,只给 id 不给明文');
  // 指定第二把、但不手填 Key：只传 provider_id + key_id
  h.run("selectFetchKey('k2')");
  await h.run('fetchProviderModels()');
  assert.deepEqual(providerReqs(h).at(-1).body, { base_url: 'https://anthropic.example', wire_api: 'anthropic', direct: false, provider_id: 'a1', key_id: 'k2' });
  // 该账号本次手填了非空 Key：api_key 覆盖,key_id 仍带上
  h.run("keyDraft[1].key='sk-typed'; selectFetchKey('k2')");
  await h.run('fetchProviderModels()');
  assert.deepEqual(providerReqs(h).at(-1).body, { base_url: 'https://anthropic.example', wire_api: 'anthropic', direct: false, provider_id: 'a1', api_key: 'sk-typed', key_id: 'k2' });
  // 新加的未保存账号也能单独用来拉取
  h.run("addKeyDraft(); keyDraft[3].key='sk-draft'; renderFetchKeySelect(); selectFetchKey('draft:3')");
  await h.run('fetchProviderModels()');
  assert.deepEqual(providerReqs(h).at(-1).body, { base_url: 'https://anthropic.example', wire_api: 'anthropic', direct: false, provider_id: 'a1', api_key: 'sk-draft' });
  // 顶栏单行 Key 在多账号渠道不参与(与保存口径一致)
  h.get('m-key').value = 'sk-top-should-be-ignored';
  h.run("selectFetchKey('')");
  await h.run('fetchProviderModels()');
  assert.equal(Object.hasOwn(providerReqs(h).at(-1).body, 'api_key'), false);
  assert.equal(JSON.stringify(providerReqs(h).map(r => r.body)).includes('***'), false, '掩码 Key 绝不上送');
  // 单 Key 渠道:留空沿用已保存 Key
  h.run('closeModal()'); h.run("openProvider('a2')");
  await h.run('fetchProviderModels()');
  assert.deepEqual(providerReqs(h).at(-1).body, { base_url: 'https://solo.example', wire_api: 'anthropic', direct: false, provider_id: 'a2' });
});

test('默认「当前生效 Key」用草稿里的新 Key：编辑生效账号后不改选择也要用新值', async () => {
  const h = await harness();
  h.fetchStub(async () => reply(200, { models: ['m1'] }));
  h.run("openProvider('a1')");
  // 用户给生效账号(k1)换了新 Key,没有动「拉取用的 Key」下拉
  h.run("keyDraft[0].key='sk-new-for-active'; renderFetchKeySelect()");
  assert.equal(h.run('discoveryState.fetchKeyId'), '', '选择框仍停在默认项');
  await h.run('fetchProviderModels()');
  assert.deepEqual(providerReqs(h).at(-1).body, { base_url: 'https://anthropic.example', wire_api: 'anthropic', direct: false, provider_id: 'a1', api_key: 'sk-new-for-active', key_id: 'k1' },
    '默认项解析到 active_key 的草稿行,手填的新 Key 覆盖已保存的旧 Key');
  // 换到非生效账号:k2 未填 -> 只用 id,不把 k1 的草稿带过去
  h.run("selectFetchKey('k2')");
  await h.run('fetchProviderModels()');
  assert.deepEqual(providerReqs(h).at(-1).body, { base_url: 'https://anthropic.example', wire_api: 'anthropic', direct: false, provider_id: 'a1', key_id: 'k2' });
  // 清空该行草稿值后仍按已保存的 Key 走
  h.run("keyDraft[0].key=''; selectFetchKey('')");
  await h.run('fetchProviderModels()');
  assert.deepEqual(providerReqs(h).at(-1).body, { base_url: 'https://anthropic.example', wire_api: 'anthropic', direct: false, provider_id: 'a1', key_id: 'k1' });
});

test('Codex 渠道：获取与批量追加候选都不覆盖独立默认模型', async () => {
  const h = await harness();
  h.fetchStub(async () => reply(200, { models: ['gpt-new', 'gpt-other'] }));
  h.run("curApp='codex'; openProvider('o1')");
  assert.equal(h.get('m-model').value, 'gpt-test');
  await h.run('fetchProviderModels()');
  assert.equal(h.get('m-model').value, 'gpt-test', '拉取本身不覆盖手填模型');
  assert.equal(providerReqs(h).at(-1).body.wire_api, 'responses');
  assert.equal(providerReqs(h).at(-1).body.base_url, 'https://openai.example/v1');
  h.run('toggleDiscoveryModel(0,true); toggleDiscoveryModel(1,true)');
  assert.deepEqual(list(h.run('discoveryState.selected')), ['gpt-new', 'gpt-other']);
  h.run('applyDiscoverySelection()');
  assert.equal(h.get('m-model').value, 'gpt-test', '登记候选不修改渠道默认模型');
  assert.deepEqual(list(h.run('modelDraft.map(r => r.value)')), ['gpt-test', 'gpt-new', 'gpt-other']);
  h.run('applyDiscoverySelection()');
  assert.deepEqual(list(h.run('modelDraft.map(r => r.value)')), ['gpt-test', 'gpt-new', 'gpt-other'], '重复追加去重');
  assert.equal(h.requests.some(r => r.url.startsWith('/api/providers') && r.method !== 'GET' && r.url !== '/api/providers/models'), false, '追加不等于保存');
});

test('Codex 新渠道候选与默认值独立，编辑已登记渠道不丢候选', async () => {
  const data = fixture();
  data.providers.codex[0].models = ['gpt-test', 'registered-other'];
  const h = await harness(data);
  h.run("curApp='codex'; openProvider('o1')");
  assert.deepEqual(list(h.run('modelDraft.map(r => r.value)')), ['gpt-test', 'registered-other']);
  h.run('closeModal(); openProvider()');
  assert.equal(h.get('m-model').value, '');
  h.get('m-base').value = 'https://new.example'; h.get('m-key').value = 'sk-test';
  h.fetchStub(async () => reply(200, { models: ['new-one', 'new-two'] }));
  await h.run('fetchProviderModels()');
  h.run('toggleDiscoveryModel(0,true); toggleDiscoveryModel(1,true); applyDiscoverySelection()');
  assert.deepEqual(list(h.run('modelDraft.map(r => r.value)')), ['new-one', 'new-two']);
  assert.equal(h.get('m-model').value, '', '新渠道也不自动选择默认模型');
});

test('模型获取有独立 20 秒预算，不继承 api() 的 12 秒', async () => {
  const h = await harness();
  // 后端 fetchProviderModels 的 deadline 覆盖分页整轮 15 秒(lib/provider-models.js)。
  // 客户端若沿用 api() 的 12 秒,会在后端还在等上游时先把请求掐掉。
  const timeout = h.run('DISCOVERY_TIMEOUT_MS');
  assert.equal(timeout, 20000);
  assert.ok(timeout > 15000, '客户端预算必须长于后端 15 秒整轮 deadline');
  // 发现请求自己带 AbortController:12 秒那条只属于 api(),不能被顺手复用。
  let seenSignal;
  h.fetchStub(async (url, options) => { seenSignal = options.signal; return reply(200, { models: ['m'] }); });
  h.run('openProvider()');
  h.get('m-base').value = 'https://api.example.com'; h.get('m-key').value = 'sk-test';
  await h.run('fetchProviderModels()');
  assert.ok(seenSignal, '请求由 fetchProviderModels 直接发出并带自己的 signal');
});

test('直连标记与协议跟随当前草稿', async () => {
  const h = await harness();
  h.fetchStub(async () => reply(200, { models: ['x'] }));
  h.run('openProvider()');
  h.get('m-base').value = 'https://gateway.example';
  h.get('m-key').value = 'sk-test';
  h.get('m-direct').checked = true;
  h.get('m-wire-claude').value = 'chat';
  await h.run('fetchProviderModels()');
  assert.equal(providerReqs(h).at(-1).body.direct, true);
  assert.equal(providerReqs(h).at(-1).body.wire_api, 'chat');
});

// 第 2 轮 #2/#3/#16/#17:Claude 路由模式下的渠道卡与槽位摘要。
function claudeRouterFixture() {
  const data = fixture();
  data.current.claude = '@router';
  data.live.claude = { base_url: 'http://127.0.0.1:8787', model: 'mixr-main', match: true, router: true,
    slots: { main: 'mixr-main', opus: 'mixr-opus', haiku: 'mixr-haiku' } };
  data.providers.claude.push({ id: 'a3', name: 'Conv', base_url: 'https://conv.example/v1', models: ['gpt-x'], wire_api: 'responses', enabled: true, key_masked: '***' });
  for (const s of data.slots.claude) {
    const to = { opus: 'a2', sonnet: 'a2', haiku: 'a1' }[s.name];
    if (to) Object.assign(s, { provider: to, provider_name: to === 'a1' ? 'Alpha' : 'Solo', model: to === 'a1' ? 'claude-special' : 'solo-model' });
  }
  return data;
}
const cardOf = (h, id) => h.get('prov-grid').innerHTML.match(new RegExp(`<article\\b[^>]*data-provider="${id}"[^>]*>[\\s\\S]*?</article>`))?.[0] || '';
const cardOrder = h => Array.from(h.get('prov-grid').innerHTML.matchAll(/<article\b[^>]*data-provider="([^"]+)"/g), match => match[1]);

test('直连渠道置顶,其余启用与停用渠道按原顺序分组,不修改渠道库', async () => {
  const data = fixture(), [alpha, solo] = data.providers.claude;
  data.providers.claude = [
    { ...solo, id: 'off-1', enabled: false }, solo,
    { ...solo, id: 'off-2', enabled: false }, { ...solo, id: 'enabled-2' }, alpha,
  ];
  const original = data.providers.claude.map(p => p.id);
  const h = await harness(data);
  h.run("view = 'providers'; renderProviders()");
  assert.deepEqual(cardOrder(h), ['a1', 'a2', 'enabled-2', 'off-1', 'off-2']);
  assert.deepEqual(list(h.run('providers("claude").map(p => p.id)')), original, '只排序显示,不改配置顺序');
  h.get('provider-filter').value = 'enabled'; h.run('renderProviders()');
  assert.deepEqual(cardOrder(h), ['a1', 'a2', 'enabled-2'], '筛选后仍按同一优先级显示');
});

test('Claude 路由:main 渠道→所有槽引用→启用→停用,未写入 env 的引用也置前且组内稳定', async () => {
  const data = claudeRouterFixture(), [alpha, solo, conv] = data.providers.claude;
  data.providers.claude = [
    { ...conv, id: 'off-1', enabled: false }, conv,
    { ...solo, id: 'sonnet-only', enabled: false }, { ...conv, id: 'enabled-2' },
    solo, { ...conv, id: 'off-2', enabled: false }, alpha,
  ];
  Object.assign(data.slots.claude.find(s => s.name === 'sonnet'), { provider: 'sonnet-only', enabled: false });
  const original = data.providers.claude.map(p => p.id);
  const h = await harness(data);
  h.run("view = 'providers'; renderProviders()");
  assert.deepEqual(cardOrder(h), ['a1', 'sonnet-only', 'a2', 'a3', 'enabled-2', 'off-1', 'off-2']);
  assert.doesNotMatch(cardOf(h, 'sonnet-only'), /路由在用/, '排序优先引用不等于客户端已在用');
  assert.deepEqual(list(h.run('providers("claude").map(p => p.id)')), original);
});

test('Codex 直连按实际渠道置顶,路由按 main 与其它槽引用置顶', async () => {
  const data = fixture(), [beta, chat] = data.providers.codex;
  data.providers.codex = [chat, { ...beta, id: 'enabled-extra' }, { ...beta, id: 'review-only' }, beta];
  data.current.codex = '@router';
  Object.assign(data.live.codex, { router: false, connection_mode: 'direct', direct_provider_id: 'o1', direct_provider_name: 'Beta', base_url: beta.base_url, model: beta.model, review_model: '', revision: 'direct-one' });
  const h = await harness(data);
  h.run("view = 'providers'; setApp('codex')");
  assert.deepEqual(cardOrder(h), ['o1', 'enabled-extra', 'review-only', 'o2'], '库内 current 仍为 @router 时也看实际直连渠道');
  Object.assign(data.live.codex, { router: true, connection_mode: 'router', direct_provider_id: '', base_url: data.router.codex_base, model: 'mixr-main', review_model: 'mixr-reviewer' });
  data.slots.codex = [
    { name: 'main', alias: 'mixr-main', provider: 'o1', provider_name: 'Beta', model: 'gpt-test', enabled: true },
    { name: 'reviewer', alias: 'mixr-reviewer', provider: 'review-only', provider_name: 'Beta', model: 'gpt-test', enabled: true },
  ];
  await h.run('refresh()');
  assert.deepEqual(cardOrder(h), ['o1', 'review-only', 'enabled-extra', 'o2']);
  for (const id of ['o1', 'review-only', 'enabled-extra', 'o2']) {
    const buttons = [...cardOf(h, id).matchAll(/<button\b[^>]*data-action="switch-(?:router|direct)"[^>]*>/g)];
    assert.equal(buttons.length, 2, '路由与直连入口同时保留');
    for (const [button] of buttons)
      assert.doesNotMatch(button, /class="[^"]*\bprimary\b/, '路由模式不突出切换接入方式');
  }
});

test('五个次级操作收为具名图标按钮,原 small/data-action/onclick 与危险类保留', async () => {
  const h = await harness();
  h.run("view = 'providers'; renderProviders()");
  const cases = [
    ['test', '测试', 'testProvider'], ['probe', '测活', 'probeModels'], ['edit', '编辑', 'openProvider'],
    ['toggle', '停用', 'toggleProvider'], ['delete', '删除', 'delProvider'],
  ];
  const checkActions = (card, id, labels = {}) => {
    assert.equal((card.match(/<button\b[^>]*\bprovider-icon-action\b/g) || []).length, 5);
    for (const [action, defaultLabel, handler] of cases) {
      const label = labels[action] || defaultLabel;
      const button = card.match(new RegExp(`<button\\b[^>]*data-action="${action}"[^>]*>[\\s\\S]*?</button>`))?.[0];
      assert.ok(button, action + ' 保留按钮');
      assert.match(button, /class="[^"]*\bsmall\b/);
      assert.match(button, /class="[^"]*\bprovider-icon-action\b/);
      assert.ok(button.includes(`data-provider="${id}"`));
      assert.ok(button.includes(`onclick="${handler}(${h.run('handlerArg(' + JSON.stringify(id) + ')')})"`), action + ' 保留原处理器与 HTML/JS 双层转义');
      assert.ok(button.includes(`aria-label="${label}"`), action + ' 有可访问名称');
      assert.match(button, /\btitle="[^"]+"/);
      assert.match(button, /<span\b[^>]*aria-hidden="true"[^>]*>/, action + ' 图标不重复朗读');
      assert.ok(new RegExp(`<span\\b[^>]*class="[^"]+"[^>]*>${label}</span>`).test(button), action + ' 保留隐藏文字');
      if (action === 'delete') assert.match(button, /class="[^"]*\bdanger\b/);
    }
  };
  checkActions(cardOf(h, 'a1'), 'a1');
  h.run("curApp='codex'; renderProviders()");
  checkActions(cardOf(h, 'o2'), 'o2', { test: '路由器检测', probe: '路由器测活', toggle: '启用' });
});

test('Claude 路由模式:按客户端 env 实际写入的槽位标「路由在用」,按钮写明会退出路由', async () => {
  const h = await harness(claudeRouterFixture());
  h.run("view = 'providers'; renderProviders()");
  const main = cardOf(h, 'a1'), solo = cardOf(h, 'a2'), conv = cardOf(h, 'a3');
  // main 槽渠道:on 色 + 当前行高亮;同渠道的其它已写入槽一并写明
  assert.match(main, /<span class="badge on"[^>]*>路由在用 · 主模型 · 槽位 haiku<\/span>/);
  assert.match(main, /class="card\s+cur\b/);
  // 只被非主槽引用:次一级 route 色;sonnet 没写进 env,不算在用
  assert.match(solo, /<span class="badge route"[^>]*>路由在用 · 槽位 opus<\/span>/);
  assert.doesNotMatch(solo, /sonnet/);
  assert.doesNotMatch(main + solo, /库内选中|已写入配置/);
  // 按钮做的是 switchClaude:写直连 = 退出路由,文案与 title 按真实效果写
  assert.match(main, /data-action="switch"[^>]*title="把此渠道写入 Claude 配置并退出路由模式[^"]*">改为直连<\/button>/);
  for (const card of [main, solo]) assert.doesNotMatch(card.match(/<button\b[^>]*data-action="switch"[^>]*>/)?.[0] || '', /class="[^"]*\bprimary\b/, '路由模式下改为直连不是主操作');
  // #3 只能走路由的渠道不摆禁用主按钮,换成说明标签,原因在 title
  assert.doesNotMatch(conv, /data-action="switch"/);
  assert.match(conv, /<span class="tag route-only-tag" title="该渠道只挂 Codex 型通道[^"]*">仅路由可用<\/span>/);
  // 离线没有"在用"这回事
  h.run('online = false; renderProviders()');
  assert.doesNotMatch(h.get('prov-grid').innerHTML, /路由在用/);
});

test('当前配置按接入方式/当前渠道/默认模型分栏,长值保留 title,配置状态不冒充连通性', async () => {
  const h = await harness();
  h.run("view = 'providers'; renderProviders()");
  const live = h.get('liveinfo').innerHTML;
  const labels = [...live.matchAll(/<dt>([^<]+)<\/dt>/g)].map(match => match[1]);
  assert.deepEqual(labels.slice(0, 3), ['接入方式', '当前渠道', '默认模型']);
  assert.match(live, /<dd title="Alpha">Alpha<\/dd>/);
  assert.match(live, /<dd class="mono" title="claude-special">claude-special<\/dd>/);
  assert.match(live, /已写入配置/);
  assert.doesNotMatch(live, /上游连通|上游可用/);
  const css = fs.readFileSync(path.join(__dirname, '../public/styles/providers.css'), 'utf8');
  assert.match(css, /#liveinfo \.current-config \{\s*display: grid; grid-template-columns:/);
  assert.match(css, /\.keypick \{[^}]*padding: 2px 28px 2px 8px;/, '下拉文本留出箭头位置');
  assert.match(css, /#view-providers \.prov-help > summary \{[^}]*display: list-item;/, 'WebKit 保留原生 disclosure 箭头');
});

test('Codex 接入单选的选中/禁用状态由 JS class 同步,模型发现清单状态也不依赖动态 has', async () => {
  const h = await harness();
  h.run("curApp='codex'; openProvider('o1'); document.getElementById('m-codex-mode-direct').parentElement=document.createElement('label'); document.getElementById('m-codex-mode-router').parentElement=document.createElement('label'); syncCodexModeDraft()");
  const direct = h.get('m-codex-mode-direct'), router = h.get('m-codex-mode-router');
  assert.equal(direct.parentElement.classList.contains('is-selected'), true);
  assert.equal(router.parentElement.classList.contains('is-selected'), false);
  h.get('m-wire').value = 'chat'; h.run('syncCodexModeDraft()');
  assert.equal(direct.parentElement.classList.contains('is-disabled'), true);
  assert.equal(direct.parentElement.classList.contains('is-selected'), false);
  assert.equal(router.parentElement.classList.contains('is-selected'), true);
  h.run("discoveryState.models=['visible-model']; renderModelDiscovery()");
  assert.equal(h.get('m-model-discovery').classList.contains('has-models'), true);
  h.run("setDiscoveryQuery('no-match')");
  assert.equal(h.get('m-model-discovery').classList.contains('has-models'), false);
  const css = fs.readFileSync(path.join(__dirname, '../public/styles/providers.css'), 'utf8');
  assert.doesNotMatch(css, /:has\([^)]*(?:input:checked|input:disabled|\.md-list)/);
});

test('Claude 直连模式:当前渠道「重新写入」,其他渠道「直连此渠道」,路由徽标不出现', async () => {
  const h = await harness();
  h.run("view = 'providers'; renderProviders()");
  assert.match(cardOf(h, 'a1'), />重新写入<\/button>/);
  assert.match(cardOf(h, 'a2'), /title="把此渠道写入 Claude 配置（直连）[^"]*">直连此渠道<\/button>/);
  assert.doesNotMatch(h.get('prov-grid').innerHTML, /路由在用/);
});

test('渠道卡:开发备注单行截断留全文 title,停用 Key 告警照常换行;Key 小标签替代「API key ·」', async () => {
  const data = fixture();
  data.providers.claude[0].note = '很长的开发备注';
  const h = await harness(data);
  h.run("view = 'providers'; renderProviders()");
  const card = cardOf(h, 'a1');
  assert.match(card, /<p class="note dev-note" title="很长的开发备注">很长的开发备注<\/p>/);
  assert.match(card, /<p class="note dead-keys">已停用的 Key：/);
  assert.match(card, /<div class="provider-meta mono keyrow"><span class="key-label">Key<\/span><select class="keypick"/);
  assert.doesNotMatch(card, /API key ·/);
  const css = fs.readFileSync(path.join(__dirname, '../public/styles/providers.css'), 'utf8');
  assert.match(css, /#prov-grid \.note\.dev-note \{[^}]*text-overflow: ellipsis/);
});

test('槽位折叠标题摘要:相同落点合并,每槽别名/env/渠道留在 title,未配置单独标出', async () => {
  const data = claudeRouterFixture();
  const h = await harness(data);
  h.run("view = 'providers'; renderSlots(true)");
  const summary = h.get('slots-summary').innerHTML;
  assert.equal((summary.match(/<span class="tag/g) || []).length, 3);
  assert.match(summary, />main \/ haiku → Alpha · claude-special<\/span>/);
  assert.match(summary, />opus \/ sonnet → Solo · solo-model<\/span>/);
  for (const slot of data.slots.claude) {
    const tag = Array.from(summary.matchAll(/<span class="tag[^\"]*" title="([^\"]*)">([^<]*)<\/span>/g))
      .find(match => match[2].split(' → ')[0].split(' / ').includes(slot.name));
    assert.ok(tag, slot.name + ' 保留在摘要中');
    assert.ok(tag[1].includes(slot.alias), slot.name + ' 保留别名');
    assert.ok(tag[1].includes(slot.env), slot.name + ' 保留 env');
    assert.ok(tag[1].includes(slot.provider ? `${slot.provider_name} @ ${slot.model}` : '未配置'), slot.name + ' 保留完整落点');
  }
  assert.match(summary, /<span class="tag unset" title="Subagent 槽 · mixr-subagent · CLAUDE_CODE_SUBAGENT_MODEL · 未配置">subagent → 未配置<\/span>/);
});

test('五个槽位有效落点相同只显示一枚 tag,配置模型留空也按渠道默认合并', async () => {
  const data = claudeRouterFixture();
  for (const slot of data.slots.claude) Object.assign(slot, { provider: 'a1', provider_name: 'Alpha', model: slot.name === 'main' ? 'claude-special' : '' });
  const h = await harness(data);
  h.run("view = 'providers'; renderSlots(true)");
  const summary = h.get('slots-summary').innerHTML;
  assert.equal((summary.match(/<span class="tag/g) || []).length, 1);
  assert.match(summary, />main \/ opus \/ sonnet \/ haiku \/ subagent → Alpha · claude-special<\/span>/);
  for (const slot of data.slots.claude) {
    assert.ok(summary.includes(slot.alias));
    assert.ok(summary.includes(slot.env));
  }
});

test('同名渠道同模型不按显示名合并,不同失效渠道引用也各自保留', async () => {
  const data = claudeRouterFixture();
  data.providers.claude[1].name = 'Alpha';
  for (const slot of data.slots.claude) Object.assign(slot, {
    provider: { main: 'a1', opus: 'a2', sonnet: 'missing-1', haiku: 'missing-2', subagent: '' }[slot.name],
    model: 'same-model',
  });
  const h = await harness(data);
  h.run("view = 'providers'; renderSlots(true)");
  const summary = h.get('slots-summary').innerHTML;
  assert.equal((summary.match(/<span class="tag/g) || []).length, 5);
  assert.match(summary, />main → Alpha · same-model<\/span>/);
  assert.match(summary, />opus → Alpha · same-model<\/span>/);
  assert.match(summary, /<span class="tag unset" title="[^"]*missing-1（渠道已删除）">sonnet → 渠道已删除<\/span>/);
  assert.match(summary, /<span class="tag unset" title="[^"]*missing-2（渠道已删除）">haiku → 渠道已删除<\/span>/);
});

function codexCompactUiFixture() {
  const data = fixture();
  data.current.codex = '@router';
  Object.assign(data.live.codex, { router: true, connection_mode: 'router', model: 'mixr-main', review_model: 'mixr-reviewer',
    base_url: data.router.codex_base, revision: 'compact-one', config_file: '/home/test/.codex/config.toml', model_auto_compact_token_limit: 500000,
    compaction: { configured: 500000, default_limit: 900000, effective_limit: 500000, context_window: 1000000, context_source: 'catalog', capped: false, warnings: [] } });
  return data;
}

test('Codex 阈值:失焦正整数千分位,聚焦恢复原始数字,轮询与焦点切换不领取新草稿版本', async () => {
  const data = codexCompactUiFixture(), h = await harness(data);
  h.run("view = 'providers'; setApp('codex')");
  const input = h.get('codex-compact-input');
  assert.equal(input.value, '500,000');
  assert.equal(h.run('codexCompactDraft.value'), '500000', '显示格式不改变原始草稿');
  assert.equal(input.events.focus.length, 1); assert.equal(input.events.blur.length, 1);
  input.focus();
  assert.equal(input.value, '500000');
  assert.equal(h.run('codexCompactDraft.dirty'), false, '聚焦不是编辑');
  h.run("setCodexCompactValue('750000')");
  const editRevision = h.run('codexCompactEditRevision');
  assert.equal(input.value, '750000', '聚焦时不格式化');
  input.blur();
  assert.equal(input.value, '750,000');
  assert.equal(h.run('codexCompactDraft.value'), '750000');
  assert.equal(h.run('codexCompactEditRevision'), editRevision, '格式化不增加编辑版本');
  Object.assign(data.live.codex, { revision: 'compact-external', model_auto_compact_token_limit: 600000 });
  data.live.codex.compaction.configured = 600000;
  await h.run('refresh()');
  assert.equal(input.value, '750,000', '轮询保留已有草稿');
  assert.equal(h.run('codexCompactDraft.revision'), 'compact-one', '轮询不为草稿领取新磁盘版本');
  input.focus();
  assert.equal(input.value, '750000');
  assert.equal(h.run('codexCompactDraft.revision'), 'compact-one');
  input.blur();
  assert.equal(input.value, '750,000');
  assert.equal(input.events.focus.length, 1); assert.equal(input.events.blur.length, 1, '重绘不重复绑定');
  for (const raw of ['auto', '200k', '1m', '1.5m', '0', '-10', '1.5', '500,00']) {
    input.focus(); h.run(`setCodexCompactValue(${JSON.stringify(raw)})`); input.blur();
    assert.equal(input.value, raw, raw + ' 不是正整数字符串,显示原样');
    input.focus(); assert.equal(input.value, raw);
  }
  h.run("setCodexCompactValue('9007199254740991')"); input.blur();
  assert.equal(input.value, '9,007,199,254,740,991', '显示分组直接操作字符串,不经过浮点数');
  input.focus(); assert.equal(input.value, '9007199254740991');
});

test('正确分组的阈值粘贴按原始字段发送去逗号值,仍保留精度安全 k/m 解析', async () => {
  const data = codexCompactUiFixture(), h = await harness(data);
  h.run("view = 'providers'; setApp('codex')");
  const input = h.get('codex-compact-input');
  const cases = [
    ['500,000', '500000', 500000], ['1,234.5k', '1234.5k', 1234500],
    ['0.5m', '0.5m', 500000], ['9,007,199,254,740,991', '9007199254740991', Number.MAX_SAFE_INTEGER],
  ];
  let saves = 0;
  h.fetchStub(async (url, options) => {
    assert.equal(url, '/api/codex/config');
    const body = JSON.parse(options.body), current = cases[saves++];
    const codex = { ...data.live.codex, revision: 'compact-saved-' + saves, model_auto_compact_token_limit: current[2],
      compaction: { ...data.live.codex.compaction, configured: current[2], effective_limit: current[2] } };
    assert.equal(body.model_auto_compact_token_limit, current[1]);
    return reply(200, { ok: true, codex });
  });
  for (const [pasted, normalized, value] of cases) {
    input.focus(); h.run(`setCodexCompactValue(${JSON.stringify(pasted)})`); input.blur();
    const revision = h.run('codexCompactDraft.revision');
    assert.equal(h.run('codexCompactDraft.value'), pasted, '保存前不重写原始草稿');
    const saving = h.run('saveCodexCompact()');
    assert.ok(h.get('confirm-text').textContent.includes(String(value)));
    h.run('finishConfirm(true)'); await saving;
    assert.deepEqual(h.requests.findLast(r => r.url === '/api/codex/config' && r.method === 'POST').body,
      { action: 'compact_threshold', model_auto_compact_token_limit: normalized, revision });
    assert.equal(h.run('codexCompactDraft.dirty'), false);
    assert.equal(input.value, String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  }
});

test('不合法的逗号分组不能被去逗号后放行,小数与安全整数边界继续拒绝', async () => {
  const h = await harness(codexCompactUiFixture());
  h.run("view = 'providers'; setApp('codex')");
  const input = h.get('codex-compact-input');
  for (const invalid of ['500,00', '50,0000', '5,00,000', '500,,000', ',500000', '500000,', '1,23k', '0,000', '1,234.5', '1,234.5678k', '9,007,199,254,740,993']) {
    input.focus(); h.run(`setCodexCompactValue(${JSON.stringify(invalid)})`); input.blur();
    await h.run('saveCodexCompact()');
    assert.match(h.get('codex-compact-status').textContent, /请输入 auto 或正整数 tokens/, invalid);
    assert.equal(h.run('codexCompactDraft.value'), invalid, '失败时保留草稿');
    assert.equal(h.run('codexCompactDraft.revision'), 'compact-one', '失败时保留原磁盘版本');
    assert.equal(h.run('activeDialog'), null, '无效输入不进入确认');
  }
  assert.equal(h.requests.some(r => r.url === '/api/codex/config' && r.method === 'POST'), false, '无效分组不发送保存请求');
});

test('#29 多 Key 渠道隐藏无效的单行 API Key;清单删空后退回单 Key 并恢复提示', async () => {
  const h = await harness();
  h.run("openProvider('a1')");
  assert.equal(h.get('m-key').hidden, true, '有清单时单行 Key 不参与保存,不该摆出来');
  assert.match(h.get('m-key-hint').textContent, /清单/);
  h.run('removeKeyDraft(2); removeKeyDraft(1); removeKeyDraft(0)');
  assert.equal(h.get('m-key').hidden, false);
  assert.match(h.get('m-key-hint').textContent, /留空保持不变/);
  h.run('closeModal()'); h.run("openProvider('a2')");
  assert.equal(h.get('m-key').hidden, false, '单 Key 渠道照常显示');
  h.run('closeModal()'); h.run('openProvider()');
  assert.equal(h.get('m-key').hidden, false, '新建渠道照常显示');
  assert.equal(h.get('m-key-hint').textContent, '');
});

test('#15 Codex:main/reviewer 连排、阈值卡不进槽位行;直连时渠道名与下拉同一行;状态放卡头', async () => {
  const data = fixture();
  data.current.codex = '@router';
  data.live.codex = { router: true, connection_mode: 'router', model: 'mixr-main', review_model: 'mixr-reviewer', base_url: 'http://127.0.0.1:8787/v1', match: true, revision: 'r1' };
  data.slots.codex = ['main', 'reviewer'].map(name => ({ name, alias: 'mixr-' + name, provider: 'o1', provider_name: 'Beta', model: 'gpt-test', configured_model: '', enabled: true }));
  const h = await harness(data);
  h.run("view = 'providers'; setApp('codex')");
  const rows = h.get('codex-model-fields').innerHTML;
  assert.ok(rows.indexOf('id="codex-slot-main"') < rows.indexOf('id="codex-slot-reviewer"'));
  assert.doesNotMatch(rows, /codex-compact-panel/);
  assert.notEqual(h.get('codex-compact-panel').parentElement, h.get('codex-model-fields'), '槽位重绘不拆阈值草稿');
  const css = fs.readFileSync(path.join(__dirname, '../public/styles/providers.css'), 'utf8');
  const order = sel => Number(css.match(new RegExp(sel.replace(/[#.-]/g, m => '\\' + m) + ' \\{ order: (-?\\d+)'))?.[1]);
  assert.ok(order('#view-providers #codex-slot-reviewer') < order('#view-providers #codex-compact-panel'), '阈值卡排在两行槽位之后');
  assert.match(css, /#view-providers \.codex-models > \.model-actions \{\s*order: -1; grid-column: 2;/, '状态在卡头右侧');
  // 直连:渠道名作为控件标签,和下拉在同一个横排 label 里
  Object.assign(data.live.codex, { router: false, connection_mode: 'direct', direct_provider_id: 'o1', direct_provider_name: 'Beta', base_url: 'https://openai.example/v1', model: 'gpt-test', review_model: '' });
  data.current.codex = 'o1';
  await h.run('refresh()');
  assert.match(h.get('codex-direct-fields').innerHTML, /<label class="field direct-control"><span class="direct-provider" title="直连渠道 Beta">Beta<\/span><select id="codex-direct-model"/);
  assert.equal(h.get('codex-model-status').textContent, '当前直连 · 模型配置已读取');
});
