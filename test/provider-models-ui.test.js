'use strict';
// 渠道弹窗里的「从上游获取模型」:只跑真实 public/js/app.js 的经典脚本,配一个最小 DOM/fetch 边界。
// 这里不碰真实网络、不写用户配置;每个用例自己决定 /api/providers/models 返回什么(含延迟响应)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const script = new vm.Script(source, { filename: 'public/js/app.js' });

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
    focus() { document.activeElement = this; }
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
  script.runInContext(context);
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

test('Codex 渠道：获取不覆盖模型，只有显式填入才写 m-model', async () => {
  const h = await harness();
  h.fetchStub(async () => reply(200, { models: ['gpt-new', 'gpt-other'] }));
  h.run("curApp='codex'; openProvider('o1')");
  assert.equal(h.get('m-model').value, 'gpt-test');
  await h.run('fetchProviderModels()');
  assert.equal(h.get('m-model').value, 'gpt-test', '拉取本身不覆盖手填模型');
  assert.equal(providerReqs(h).at(-1).body.wire_api, 'responses');
  assert.equal(providerReqs(h).at(-1).body.base_url, 'https://openai.example/v1');
  h.run('toggleDiscoveryModel(0,true); toggleDiscoveryModel(1,true)');
  assert.deepEqual(list(h.run('discoveryState.selected')), ['gpt-other'], 'Codex 模型字段只有一个,选择是单选');
  h.run('applyDiscoverySelection()');
  assert.equal(h.get('m-model').value, 'gpt-other');
  assert.deepEqual(list(h.run('modelDraft.map(r => r.value)')), [], 'Codex 不走 Claude 的模型列表');
  assert.equal(h.requests.some(r => r.url.startsWith('/api/providers') && r.method !== 'GET' && r.url !== '/api/providers/models'), false, '填入不等于保存');
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
