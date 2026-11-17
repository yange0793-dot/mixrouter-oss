'use strict';
// POST /api/providers/:id/sync 的接口契约回归:真实主入口 + 临时数据目录。
//
// 钉的是:字段怎么跨组换算、同址副本怎么就地更新、哪些本地状态不被覆盖、
// 缺模型时明确 400 且不落库、响应不泄漏 Key 正文。
//
// 不联网、不碰真实配置;端口一律 listen(0),临时 HOME/MIXR_DATA_DIR 由本文件与
// scripts/run-tests.js 隔离。
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-provider-sync-'));
process.env.HOME = TMP;
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude-settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex-config.toml');
process.env.MIXR_RESPONSE_ARCHIVE = 'off';
process.env.MIXROUTER_PORT = '0';
process.env.MIXUI_PORT = '0';

const mod = require('../mixrouter');

let ui;
let uiPort;

function request(route, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: uiPort, path: route, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

const diskStore = () => JSON.parse(fs.readFileSync(path.join(TMP, 'providers.json'), 'utf8'));

function claudeProvider(extra = {}) {
  return {
    id: 'psync1', name: 'Pair', base_url: 'https://pair.example', api_key: 'sk-pair-secret',
    enabled: true, note: '备注', created_at: '2026-11-01T00:00:00.000Z',
    models: ['m-one', 'm-two'], slots: { opus: 'm-two', sonnet: '', haiku: '', subagent: '' }, ua: 'ua/1.0',
    keys: [
      { id: 'k1', label: '一号', key: 'sk-key-one-secret' },
      { id: 'k2', label: '二号', key: 'sk-key-two-secret', enabled: false },
    ], active_key: 'k1',
    ...extra,
  };
}

function codexProvider(extra = {}) {
  return {
    id: 'csync1', name: 'Back', base_url: 'https://back.example/v1', api_key: 'sk-back-secret',
    enabled: true, note: '', created_at: '2026-11-02T00:00:00.000Z',
    model: 'gpt-x', models: ['gpt-y'], wire_api: 'responses', codex_mode: 'direct',
    ...extra,
  };
}

beforeEach(() => {
  mod._state.store = { claude: [claudeProvider()], codex: [] };
  mod._state.current = { claude: null, codex: null };
  mod._state.routes = { rules: [], default: { provider: '', model: '' } };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.sessions.clear();
});

before(async () => {
  ui = await mod.listen(0, mod.apiHandler);
  uiPort = ui.address().port;
});

after(async () => {
  await new Promise(resolve => { ui.close(resolve); ui.closeAllConnections(); });
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('Claude → Codex:补齐 /v1、取第一项模型、复制 Key 清单并落盘', async () => {
  const r = await request('/api/providers/psync1/sync', 'POST');
  assert.equal(r.status, 200);
  assert.equal(r.json.action, 'created');
  assert.equal(r.json.app, 'codex');
  assert.equal(r.json.name, 'Pair');
  assert.equal(mod._state.store.codex.length, 1, '内存里的目标组同步可见');
  const [copy] = list(diskStore().codex);
  assert.match(copy.id, /^c/);
  assert.equal(copy.name, 'Pair');
  assert.equal(copy.base_url, 'https://pair.example/v1', 'Codex 直连在 base 后拼 /responses,必须带 /v1');
  assert.equal(copy.api_key, 'sk-pair-secret');
  assert.equal(copy.enabled, true);
  assert.equal(copy.note, '备注');
  assert.equal(copy.model, 'm-one');
  assert.deepEqual(copy.models, ['m-one', 'm-two']);
  assert.equal(copy.wire_api, 'responses');
  assert.equal(copy.codex_mode, 'direct');
  assert.deepEqual(copy.keys, [
    { id: 'k1', label: '一号', key: 'sk-key-one-secret' },
    { id: 'k2', label: '二号', key: 'sk-key-two-secret', enabled: false },
  ], 'Key 清单与停用状态原样带走');
  assert.equal(copy.active_key, 'k1');
  assert.equal(r.text.includes('sk-pair-secret') || r.text.includes('sk-key-one-secret'), false,
    '响应不泄漏 Key 正文');
});

test('Claude 的 chat 渠道同步到 Codex:保持 chat,只能走路由', async () => {
  mod._state.store.claude = [claudeProvider({ id: 'pchat', wire_api: 'chat', base_url: 'https://chat.example/v1' })];
  const r = await request('/api/providers/pchat/sync', 'POST');
  assert.equal(r.status, 200);
  const [copy] = list(diskStore().codex);
  assert.equal(copy.base_url, 'https://chat.example/v1', '/v1 不重复拼');
  assert.equal(copy.wire_api, 'chat');
  assert.equal(copy.codex_mode, 'router');
});

test('Codex → Claude:去掉 /v1、model 并入模型列表、槽位留空', async () => {
  mod._state.store.codex = [codexProvider()];
  const r = await request('/api/providers/csync1/sync', 'POST');
  assert.equal(r.status, 200);
  assert.equal(r.json.app, 'claude');
  const [copy] = list(diskStore().claude).filter(p => p.id !== 'psync1');
  assert.match(copy.id, /^p/);
  assert.equal(copy.base_url, 'https://back.example', 'Claude Code 在 base 后拼 /v1/messages,不能带 /v1');
  assert.deepEqual(copy.models, ['gpt-x', 'gpt-y'], 'model 排第一并去重');
  assert.deepEqual(copy.slots, { opus: '', sonnet: '', haiku: '', subagent: '' });
  assert.equal(copy.wire_api, 'responses');
  assert.equal(copy.ua, '');
});

test('同址副本已存在时就地更新:保留 id、启用状态与本地接入方式,不重复创建', async () => {
  mod._state.store.codex = [codexProvider({
    base_url: 'https://pair.example/v1', id: 'cold', name: '旧名', enabled: false, model: 'old-model',
    keys: [{ id: 'kold', label: '旧账号', key: 'sk-old-secret' }], active_key: 'kold',
  })];
  mod._state.store.claude = [claudeProvider({ proxy_url: 'http://127.0.0.1:7890' })];
  const r = await request('/api/providers/psync1/sync', 'POST');
  assert.equal(r.status, 200);
  assert.equal(r.json.action, 'updated');
  const codex = list(diskStore().codex);
  assert.equal(codex.length, 1, '同址渠道只更新,不新增');
  const copy = codex[0];
  assert.equal(copy.id, 'cold');
  assert.equal(copy.created_at, '2026-11-02T00:00:00.000Z');
  assert.equal(copy.enabled, false, '目标端停用状态不被同步悄悄改回启用');
  assert.equal(copy.name, 'Pair');
  assert.equal(copy.model, 'm-one');
  assert.equal(copy.api_key, 'sk-pair-secret');
  assert.equal(copy.active_key, 'k1');
  assert.deepEqual(copy.keys.map(k => k.id), ['k1', 'k2']);
  assert.equal(copy.proxy_url, 'http://127.0.0.1:7890');
  assert.equal(copy.codex_mode, 'direct');

  // 再点一次仍然是同一条,字段不漂移
  const again = await request('/api/providers/psync1/sync', 'POST');
  assert.equal(again.json.action, 'updated');
  assert.equal(list(diskStore().codex).length, 1);
});

test('Claude 渠道没有模型名 → 400,不落库', async () => {
  mod._state.store.claude = [claudeProvider({ models: [] })];
  const before = fs.existsSync(path.join(TMP, 'providers.json')) ? fs.readFileSync(path.join(TMP, 'providers.json'), 'utf8') : null;
  const r = await request('/api/providers/psync1/sync', 'POST');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /模型名/);
  const after = fs.existsSync(path.join(TMP, 'providers.json')) ? fs.readFileSync(path.join(TMP, 'providers.json'), 'utf8') : null;
  assert.equal(after, before, '被拒绝的同步不改渠道库文件');
});

test('不存在的渠道 → 404', async () => {
  const r = await request('/api/providers/nope/sync', 'POST');
  assert.equal(r.status, 404);
});

function list(value) { return JSON.parse(JSON.stringify(value)); }
