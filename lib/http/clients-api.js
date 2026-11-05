'use strict';
const { isJsonRequest } = require('./local-access');
const { syncCodexModel } = require('../clients/codex-runtime');
function createClientsApi(deps) {
  const {
    ROUTER_ID, getStore, liveState, updateCodexConfig, applyClientSwitch, clientSwitchMessage,
    findProvider, providerApp, slotsPublic, switchClaude, switchCodex, switchRouter,
  } = deps;

  return async function handle({ req, res, url, readObject, send, sendErr }) {
    const p = url.pathname;
    let m;
    if (!(p === '/api/codex/config' || p.startsWith('/api/switch/') || p.startsWith('/api/router/'))) return false;
    await (async () => {
      if (req.method === 'GET' && p === '/api/codex/config') return send(200, { codex: liveState().codex });
      if (req.method === 'POST' && p === '/api/codex/config') {
        if (!isJsonRequest(req)) return sendErr(415, 'Content-Type 必须是 application/json');
        try {
          const options = await readObject();
          const before = liveState().codex;
          const result = updateCodexConfig(options);
          if (options.action === 'direct_models' && Object.hasOwn(options, 'model')) {
            result.runtime = await syncCodexModel({ configFile: result.codex.config_path, before, after: result.codex });
          }
          return send(200, result);
        }
        catch (e) { return send(e.statusCode || 400, { error: e.message }); }
      }
      m = p.match(/^\/api\/switch\/([^/]+)$/);
      if (req.method === 'POST' && m) {
        const prov = findProvider(m[1]);
        if (!prov) return sendErr(404, '渠道不存在');
        const b = await readObject();
        const group = providerApp(prov.id);
        if (b.app !== undefined && !['claude', 'codex'].includes(b.app)) return sendErr(400, '未知客户端 app(只支持 claude / codex)');
        const app = b.app === undefined ? group : b.app;
        if (app !== group) return sendErr(400, '客户端与渠道协议组不兼容');
        if (b.mode !== undefined && app !== 'codex') return sendErr(400, 'mode 只适用于 Codex 渠道');
        if (b.mode !== undefined && !['direct', 'router'].includes(b.mode))
          return sendErr(400, 'mode 必须是 direct 或 router');
        const mode = app === 'codex'
          ? (b.mode || prov.codex_mode || (prov.wire_api === 'chat' ? 'router' : 'direct'))
          : null;
        if (mode === 'direct' && prov.wire_api === 'chat')
          return sendErr(400, 'Codex 直连模式只支持 Responses 渠道；Chat 渠道请使用路由模式');
        if (!prov.api_key) return sendErr(400, '渠道未配置 API Key,无法切换');
        let warnings;
        try { ({ warnings } = applyClientSwitch(app, () => {
          if (app === 'claude') return switchClaude(prov);
          if (mode === 'router') return switchRouter('codex', { main: { provider: prov.id, model: prov.model } });
          return switchCodex(prov);
        }, mode === 'router' ? ROUTER_ID : prov.id)); }
        catch (e) { return send(e.statusCode || 500, { error: clientSwitchMessage(app, e) }); }
        return send(200, { ok: true, app, live: liveState()[app], ...(warnings && warnings.length ? { warnings } : {}) });
      }

      m = p.match(/^\/api\/router\/([^/]+)$/);
      if (req.method === 'POST' && m) {
        const app = m[1];
        if (!['claude', 'codex'].includes(app)) return sendErr(400, '未知客户端 app(只支持 claude / codex)');
        const b = await readObject();
        if (b.app !== undefined && b.app !== app) return sendErr(400, 'app 与路径不一致');
        if (b.slots !== undefined && typeof b.slots !== 'boolean') return sendErr(400, 'slots 必须是布尔值');
        if (app === 'codex' && !getStore().codex.length) return sendErr(400, '还没有 Codex 组渠道,先添加渠道再切路由模式');
        if (app === 'claude' && !getStore().claude.length) return sendErr(400, '还没有 Claude 组渠道,先添加渠道再切路由模式');
        if (app === 'codex' && getStore().codex.every(p => !String(p.model || '').trim()))
          return sendErr(400, 'Codex 组渠道都没有填模型名,先补上模型名再切路由模式(否则会写出空 model)');
        let warnings;
        try { ({ warnings } = applyClientSwitch(app, () => switchRouter(app, b) || {}, ROUTER_ID)); }
        catch (e) { return send(e.statusCode || 500, { error: clientSwitchMessage(app, e) }); }
        return send(200, { ok: true, app, live: liveState()[app], ...(warnings && warnings.length ? { warnings } : {}), ...(app === 'claude' && b.slots ? { slots: slotsPublic().claude } : {}) });
      }


      sendErr(404, 'not found');
    })();
    return true;
  };
}

module.exports = { createClientsApi };
