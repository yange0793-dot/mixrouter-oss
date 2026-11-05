'use strict';
const { authHeaderValue, hasCtlChar, validBaseUrl } = require('../routing/headers');
const { normalizeChannelSlots } = require('../routing/slots');
const { ringOf, resolveKey, activeKeyId } = require('../routing/keys');
const { fetchProviderModels } = require('../provider-models');
const { probeModels, modelsOf, wireOfProvider, WIRES, ModelProbeError } = require('../model-probe');
const compactLib = require('../routing/compact');
const { invalid } = require('../validation');
function createProvidersApi(deps) {
  const {
    getStore, getCurrent, setCurrent, getRoutes, setRoutes, getSlotMap, setSlotMap,
    withStoreRollback, drainStoreWarnings, testProvider, findProvider, providerApp,
    saveRoutes, saveSlots, saveStore, syncCodexStore,
  } = deps;
  function proxyUrlField(b) {
    if (b.proxy_url === undefined) return undefined;
    const raw = strField(b, 'proxy_url', '出站代理');
    const s = String(raw).trim();
    if (!s) return '';                       // 显式空串 = 清除
    let u;
    try { u = new URL(s); }
    catch { throw invalid('出站代理必须是合法地址,如 http://127.0.0.1:7890'); }
    if (u.protocol !== 'http:')
      throw invalid('出站代理只支持 http:// 的 CONNECT 代理(如 http://127.0.0.1:7890)');
    if (u.username || u.password)
      throw invalid('出站代理不能带用户名或密码:代理口令会明文写进渠道库并出现在接口响应里');
    if (u.search || u.hash)
      throw invalid('出站代理不能带查询串或片段,出站只用到主机与端口');
    return s;
  }
  function assertProxyExclusive(direct, proxyUrl) {
    if (direct && proxyUrl)
      throw invalid('「直连上游」与「出站代理」互斥:要出境就填代理,要绕开隧道就别填代理');
  }

  function strField(b, key, label) {
    if (b[key] === undefined) return undefined;
    const v = b[key];
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    throw invalid(`${label} 必须是字符串`);
  }
  function strListField(b, key, label) {
    if (b[key] === undefined) return undefined;
    const v = b[key];
    if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(v)) throw invalid(`${label} 必须是字符串或字符串数组`);
    return v.map((x, i) => {
      if (typeof x === 'string') return x.trim();
      if (typeof x === 'number' && Number.isFinite(x)) return String(x);
      throw invalid(`${label} 第 ${i + 1} 项不是字符串`);
    }).filter(Boolean);
  }
  function numField(b, key, label) {
    if (b[key] === undefined) return undefined;
    const v = b[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    throw invalid(`${label} 必须是数字`);
  }
  function codexModelsField(b) {
    if (b.models === undefined) return undefined;
    if (!Array.isArray(b.models)) throw invalid('模型列表必须是字符串数组');
    const models = b.models.map((value, index) => {
      if (typeof value !== 'string') throw invalid(`模型列表第 ${index + 1} 项不是字符串`);
      return value.trim();
    }).filter(Boolean);
    return [...new Set(models)];
  }
  function codexModeField(b, app) {
    if (b.codex_mode === undefined) return undefined;
    if (app !== 'codex') throw invalid('codex_mode 只适用于 Codex 渠道');
    if (b.codex_mode !== 'direct' && b.codex_mode !== 'router')
      throw invalid('codex_mode 必须是 direct 或 router');
    return b.codex_mode;
  }
  function assertCodexMode(mode, wire) {
    if (mode === 'direct' && wire === 'chat')
      throw invalid('Codex 直连模式只支持 Responses 渠道；Chat 渠道请使用路由模式');
  }
  function normalizeKeys(input, prev = []) {
    const out = [];
    for (const raw of Array.isArray(input) ? input : []) {
      if (!raw || typeof raw !== 'object') continue;
      const id = String(raw.id || '').trim() || ('k' + Math.random().toString(36).slice(2, 8));
      const old = prev.find(x => x.id === id);
      const key = String(raw.key || '').trim() || (old ? old.key : '');
      if (!key) return { error: '每个 Key 都要有值（已有的留空表示不改）' };
      if (hasCtlChar(key)) return { error: 'API Key 不能包含换行或控制字符' };
      if (out.some(k => k.key === key)) continue;            // 同一个 Key 只留一条
      out.push({ id, label: String(raw.label || (old && old.label) || '').trim() || `账号${out.length + 1}`, key });
    }
    return { keys: out };
  }

  return async function handle({ req, res, url, readObject, send, sendErr }) {
    const p = url.pathname;
    let m;
    const sendStoreOk = (extra = {}) => {
      const warnings = drainStoreWarnings();
      return send(200, { ok: true, ...extra, ...(warnings ? { warnings } : {}) });
    };
    if (!(p.startsWith('/api/providers'))) return false;
    await (async () => {
      if (req.method === 'POST' && p === '/api/providers/models') {
        const b = await readObject();
        const wireIn = strField(b, 'wire_api', 'wire_api');
        if (wireIn !== undefined && !['anthropic', 'responses', 'chat'].includes(wireIn))
          return sendErr(400, 'wire_api 必须是 anthropic、responses 或 chat');
        if (b.direct !== undefined && typeof b.direct !== 'boolean') return sendErr(400, 'direct 必须是布尔值');
        const pid = strField(b, 'provider_id', '渠道');
        const kid = strField(b, 'key_id', 'Key');
        const prov = pid ? findProvider(pid) : null;
        if (pid && !prov) return sendErr(404, '渠道不存在');
        if (kid && !prov) return sendErr(400, '指定 key_id 时必须同时提供 provider_id');
        const baseIn = strField(b, 'base_url', 'base_url');
        const keyIn = strField(b, 'api_key', 'API Key');
        if (keyIn !== undefined && hasCtlChar(keyIn)) return sendErr(400, 'API Key 不能包含换行或控制字符');
        const baseUrl = String(baseIn || (prov && prov.base_url) || '').trim();
        if (!baseUrl) return sendErr(400, '新渠道必须提供 base_url');
        if (!validBaseUrl(baseUrl)) return sendErr(400, 'base_url 必须是合法的 http(s) URL,如 https://api.example.com');
        let apiKey = keyIn && keyIn.trim() ? keyIn.trim() : '';
        if (kid) {
          const hit = ringOf(prov).find(k => k.id === kid);
          if (!hit) return sendErr(404, '指定的 Key 不在该渠道的 Key 清单里');
          if (!apiKey) {
            if (hit.enabled === false) return sendErr(404, '指定的 Key 已停用,不能用于获取模型列表');
            const k = String(hit.key || '').trim();
            if (!k || hasCtlChar(k)) return sendErr(404, '指定的 Key 没有可用的值,请检查该账号');
            apiKey = k;
          }
        } else if (!apiKey && prov) apiKey = String(prov.api_key || '').trim();
        if (!apiKey) return sendErr(prov ? 404 : 400, prov ? '该渠道没有可用的 API Key' : '新渠道必须提供 base_url 与 api_key');
        const app = prov ? providerApp(prov.id) : 'claude';
        const wire = wireIn || (prov ? (prov.wire_api || (app === 'codex' ? 'responses' : 'anthropic')) : 'anthropic');
        const direct = b.direct !== undefined ? b.direct : !!(prov && prov.direct);
        const proxyUrl = b.proxy_url !== undefined ? proxyUrlField(b) : ((prov && prov.proxy_url) || '');
        try {
          return send(200, await fetchProviderModels({
            base_url: baseUrl, api_key: apiKey, wire_api: wire, direct,
            proxy_url: proxyUrl || undefined,
            ua: (prov && prov.ua) || '',
          }));
        } catch (e) {
          return sendErr(e.status || 502, e.message);
        }
      }
      if (req.method === 'POST' && p === '/api/providers') {
        const b = await readObject();
        if (b.app !== undefined && !['claude', 'codex'].includes(b.app)) return sendErr(400, '渠道 app 必须是 claude 或 codex');
        const app = b.app || 'claude';
        if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return sendErr(400, 'enabled 必须是布尔值');
        if (b.wire_api !== undefined && !(app === 'claude' ? ['anthropic', 'responses', 'chat'] : ['responses', 'chat']).includes(b.wire_api))
          return sendErr(400, app === 'claude' ? 'claude 渠道的 wire_api 必须是 anthropic、responses 或 chat' : 'wire_api 必须是 responses 或 chat');
        let codexMode;
        try {
          codexMode = codexModeField(b, app);
          if (app === 'codex') assertCodexMode(codexMode ?? (b.wire_api === 'chat' ? 'router' : 'direct'),
            b.wire_api === 'chat' ? 'chat' : 'responses');
        } catch (e) { return sendErr(e.statusCode || 400, e.message); }
        if (b.name !== undefined) strField(b, 'name', '渠道名');
        if (!String(b.name || '').trim() || !b.base_url) return sendErr(400, 'name 与 base_url 必填');
        if (!validBaseUrl(b.base_url)) return sendErr(400, 'base_url 必须是合法的 http(s) URL,如 https://api.example.com');
        const codexModel = app === 'codex' ? (strField(b, 'model', '模型名') || '').trim() : '';
        if (app === 'codex' && !codexModel) return sendErr(400, 'Codex 渠道必须填模型名');
        const id = (app === 'codex' ? 'c' : 'p') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        if (hasCtlChar(b.api_key)) return sendErr(400, 'API Key 不能包含换行或控制字符');
        const prov = { id, name: String(b.name).trim(), base_url: String(b.base_url).replace(/\/+$/, ''),
          api_key: authHeaderValue(b.api_key), enabled: b.enabled !== false,
          note: strField(b, 'note', '备注') ?? '', created_at: new Date().toISOString() };
        if (app === 'claude') {
          prov.models = strListField(b, 'models', '模型列表') || [];
          prov.slots = normalizeChannelSlots(b.slots);
          prov.ua = strField(b, 'ua', 'User-Agent') ?? '';
          if (b.wire_api === 'responses' || b.wire_api === 'chat') prov.wire_api = b.wire_api;
        } else {
          prov.model = codexModel;
          const models = codexModelsField(b);
          if (models !== undefined) prov.models = models;
          prov.wire_api = b.wire_api === 'chat' ? 'chat' : 'responses';
          if (codexMode) prov.codex_mode = codexMode;
          prov.drop_images = !!b.drop_images;
        }
        if (b.direct !== undefined && typeof b.direct !== 'boolean') return sendErr(400, 'direct 必须是布尔值');
        if (b.direct) prov.direct = true;
        const proxyIn = proxyUrlField(b);
        assertProxyExclusive(prov.direct, proxyIn);
        if (proxyIn) prov.proxy_url = proxyIn;
        if (b.key_fallback !== undefined && typeof b.key_fallback !== 'boolean') return sendErr(400, 'key_fallback 必须是布尔值');
        if (b.key_fallback === true) prov.key_fallback = true;
        if (Array.isArray(b.keys) && b.keys.length) {
          const kr = normalizeKeys(b.keys, []);
          if (kr.error) return sendErr(400, kr.error);
          prov.keys = kr.keys;
          prov.active_key = prov.keys[0].id;
          prov.api_key = prov.keys[0].key;
        }
        try {
          withStoreRollback(() => getStore()[app].push(prov));
        } catch (e) { return sendErr(500, '写入渠道库失败: ' + e.message); }
        return sendStoreOk({ id });
      }
      m = p.match(/^\/api\/providers\/([^/]+)$/);
      if (m) {
        const prov = findProvider(m[1]);
        if (!prov) return sendErr(404, '渠道不存在');
        if (req.method === 'PUT') {
          const b = await readObject();
          if (b.app !== undefined && b.app !== providerApp(prov.id)) return sendErr(400, '不能改变渠道所属协议组 app');
          if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return sendErr(400, 'enabled 必须是布尔值');
          if (b.wire_api !== undefined && !(providerApp(prov.id) === 'claude' ? ['anthropic', 'responses', 'chat'] : ['responses', 'chat']).includes(b.wire_api))
            return sendErr(400, providerApp(prov.id) === 'claude' ? 'claude 渠道的 wire_api 必须是 anthropic、responses 或 chat' : 'wire_api 必须是 responses 或 chat');
          let codexMode;
          try { codexMode = codexModeField(b, providerApp(prov.id)); }
          catch (e) { return sendErr(e.statusCode || 400, e.message); }
          const next = { ...prov };
          if (providerApp(prov.id) === 'claude' && Array.isArray(next.keys)) next.keys = next.keys.map(k => ({ ...k }));
          if (b.name !== undefined) next.name = String(strField(b, 'name', '渠道名')).trim();
          if (b.base_url !== undefined) {
            if (!validBaseUrl(b.base_url)) return sendErr(400, 'base_url 必须是合法的 http(s) URL,如 https://api.example.com');
            next.base_url = String(b.base_url).replace(/\/+$/, '');
          }
          if (b.api_key !== undefined) {
            const k = String(b.api_key);
            if (k.trim()) {
              if (hasCtlChar(k)) return sendErr(400, 'API Key 不能包含换行或控制字符');
              next.api_key = authHeaderValue(k);
            }
          }
          if (b.enabled !== undefined) next.enabled = !!b.enabled;
          if (b.key_fallback !== undefined) {
            if (typeof b.key_fallback !== 'boolean') return sendErr(400, 'key_fallback 必须是布尔值');
            if (b.key_fallback) next.key_fallback = true; else delete next.key_fallback;
          }
          if (b.note !== undefined) next.note = strField(b, 'note', '备注');
          if (providerApp(prov.id) === 'claude') {
            const models = strListField(b, 'models', '模型列表');
            if (models !== undefined) next.models = models;
            if (b.slots !== undefined) next.slots = normalizeChannelSlots(b.slots);
            if (b.ua !== undefined) next.ua = strField(b, 'ua', 'User-Agent');
            if (b.wire_api !== undefined) { if (b.wire_api === 'responses' || b.wire_api === 'chat') next.wire_api = b.wire_api; else delete next.wire_api; }
          } else {
            if (b.model !== undefined) {
              const model = strField(b, 'model', '模型名').trim();
              if (!model) return sendErr(400, 'Codex 渠道必须填模型名');
              next.model = model;
            }
            const models = codexModelsField(b);
            if (models !== undefined) next.models = models;
            if (b.wire_api !== undefined) next.wire_api = b.wire_api === 'chat' ? 'chat' : 'responses';
            if (b.drop_images !== undefined) next.drop_images = !!b.drop_images;
            try { assertCodexMode(codexMode ?? next.codex_mode, next.wire_api || 'responses'); }
            catch (e) { return sendErr(e.statusCode || 400, e.message); }
            if (codexMode !== undefined) next.codex_mode = codexMode;
          }
          if (b.direct !== undefined) {
            if (typeof b.direct !== 'boolean') return sendErr(400, 'direct 必须是布尔值');
            if (b.direct) next.direct = true; else delete next.direct;
          }
          const proxyIn = proxyUrlField(b);
          if (proxyIn !== undefined) { if (proxyIn) next.proxy_url = proxyIn; else delete next.proxy_url; }
          assertProxyExclusive(next.direct, next.proxy_url);
          if (b.keys !== undefined) {
            if (!Array.isArray(b.keys)) return sendErr(400, 'keys 必须是数组(每项形如 {key,label})');
            const kr = normalizeKeys(b.keys, ringOf(prov));
            if (kr.error) return sendErr(400, kr.error);
            if (b.keys.length && !kr.keys.length) return sendErr(400, 'keys 里没有一条有效的 Key');
            if (kr.keys.length) next.keys = kr.keys; else delete next.keys;
          }
          if (b.active_key !== undefined) {
            const ak = strField(b, 'active_key', '生效 Key');
            if (ak && Array.isArray(prov.keys) && !prov.keys.some(k => k.id === ak))
              return sendErr(400, `生效 Key "${ak}" 不在该渠道的 Key 清单里`);
            next.active_key = ak;
          }
          if (Array.isArray(next.keys) && next.keys.length) {
            const act = next.keys.find(k => k.id === next.active_key) || next.keys[0];
            if (b.api_key) act.key = String(b.api_key).trim();   // 编辑弹窗里改的那把就是当前生效那把
            next.active_key = act.id;
            next.api_key = act.key;
          } else delete next.active_key;
          try {
            withStoreRollback(() => {
              for (const k of Object.keys(prov)) if (!(k in next)) delete prov[k];
              Object.assign(prov, next);
            }, { syncCodex: providerApp(prov.id) === 'codex' && ['model', 'enabled', 'name', 'models'].some(key => Object.hasOwn(b, key)) });
          } catch (e) { return sendErr(500, '写入渠道库失败: ' + e.message); }
          return sendStoreOk();
        }
        if (req.method === 'DELETE') {
          const app = providerApp(prov.id);
          const snapshot = {
            providers: getStore()[app],
            current: { ...getCurrent() },
            slotMap: structuredClone(getSlotMap()),
            routes: structuredClone(getRoutes()),
          };
          getStore()[app] = getStore()[app].filter(x => x.id !== prov.id);
          if (getCurrent()[app] === prov.id) getCurrent()[app] = null;
          let slotChanged = false;
          let routeChanged = false;
          for (const g of ['claude', 'codex']) {
            for (const [name, s] of Object.entries(getSlotMap()[g])) {
              if (!s) continue;
              if (s.provider === prov.id) { delete getSlotMap()[g][name]; slotChanged = true; continue; }
              if (!Array.isArray(s.pool)) continue;
              const kept = s.pool.filter(m => (typeof m === 'string' ? m : m && m.provider) !== prov.id);
              if (kept.length !== s.pool.length) { s.pool = kept; slotChanged = true; }
            }
          }
          try {
          if (slotChanged) saveSlots();
          for (const rule of (getRoutes().rules || [])) {
            if (!rule) continue;
            if (compactLib.hasKeyPin(rule)) continue;
            if (rule.provider === prov.id) { rule.provider = ''; routeChanged = true; }
            if (Array.isArray(rule.pool)) {
              const kept = rule.pool.filter(m => (typeof m === 'string' ? m : m && m.provider) !== prov.id);
              if (kept.length !== rule.pool.length) { rule.pool = kept; routeChanged = true; }
            }
          }
          if (routeChanged) saveRoutes();
          if (app === 'codex') syncCodexStore(); else saveStore();
          } catch (e) {
            getStore()[app] = snapshot.providers;
            setCurrent({ ...getCurrent(), ...snapshot.current });
            setSlotMap(snapshot.slotMap);
            setRoutes(snapshot.routes);
            const rollbackErrors = [];
            for (const [changed, file, save] of [
              [slotChanged, 'slots.json', saveSlots],
              [routeChanged, 'routes.json', saveRoutes],
            ]) {
              if (!changed) continue;
              try { save(); } catch (rb) { rollbackErrors.push(`${file}: ${rb.message}`); }
            }
            if (rollbackErrors.length) {
              return sendErr(500, `删除渠道失败: ${e.message};回滚也失败: ${rollbackErrors.join('; ')} —— 盘上已不一致,请检查上述文件`);
            }
            return sendErr(500, '删除渠道失败: ' + e.message);
          }
          return sendStoreOk();
        }
      }
      m = p.match(/^\/api\/providers\/([^/]+)\/test$/);
      if (req.method === 'POST' && m) {
        const prov = findProvider(m[1]);
        if (!prov) return sendErr(404, '渠道不存在');
        const started = Date.now();
        const result = await testProvider(prov);
        return send(200, { ...result, ms: Date.now() - started });
      }
      m = p.match(/^\/api\/providers\/([^/]+)\/models\/test$/);
      if (req.method === 'POST' && m) {
        const prov = findProvider(m[1]);
        if (!prov) return sendErr(404, '渠道不存在');
        const b = await readObject();
        const kid = strField(b, 'key_id', 'Key');
        const hit = kid ? resolveKey(prov, kid) : resolveKey(prov, activeKeyId(prov));
        if (!hit) {
          if (!kid) return sendErr(404, '该渠道没有可用的 API Key');
          const listed = ringOf(prov).some(k => k && k.id === kid);
          return sendErr(404, listed ? '指定的 Key 已停用或没有可用的值' : '指定的 Key 不在该渠道的 Key 清单里');
        }
        const key = String(hit.key).trim();
        const wireIn = strField(b, 'wire', 'wire');
        if (wireIn !== undefined && !WIRES.includes(wireIn))
          return sendErr(400, 'wire 必须是 anthropic、responses 或 chat');
        const modelsIn = strListField(b, 'models', '模型列表');
        const models = modelsIn !== undefined ? modelsIn : modelsOf(prov);
        if (!models.length) return sendErr(400, '该渠道还没有登记模型名,先补模型或显式指定 models');
        const timeoutMs = numField(b, 'timeout_ms', '超时(毫秒)');
        const concurrency = numField(b, 'concurrency', '并发数');
        try {
          const r = await probeModels({
            provider: prov, models, key, wire: wireIn || wireOfProvider(prov), timeoutMs, concurrency,
          });
          const passed = r.results.filter(x => x.ok).length;
          return send(200, { ok: true, provider: prov.id, wire: r.wire, total_ms: r.total_ms,
            passed, failed: r.results.length - passed, results: r.results });
        } catch (e) {
          if (e instanceof ModelProbeError) return sendErr(e.status, e.message);
          throw e;
        }
      }

      sendErr(404, 'not found');
    })();
    return true;
  };
}

module.exports = { createProvidersApi };
