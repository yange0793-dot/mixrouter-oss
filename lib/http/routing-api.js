'use strict';
const sessionConfig = require('../routing/session-config');
const compactLib = require('../routing/compact');
const { isObject } = require('../validation');
function createRoutingApi(deps) {
  const {
    getStore, getRoutes, setRoutes, getSlotMap, getSess, configureClaudeSplit, sessionList,
    sessionRecord, storeOf, mutateSessions, saveRoutes, compactWindow,
    slotsPublic, validateSlotPut, commitSlotUpdate,
  } = deps;

  return async function handle({ req, res, url, readObject, send, sendErr }) {
    const p = url.pathname;
    let m;
    if (!(p.startsWith('/api/sessions') || p.startsWith('/api/compact') || p === '/api/routes' || p === '/api/claude/split' || p === '/api/slots')) return false;
    await (async () => {
      if (req.method === 'GET' && p === '/api/sessions') {
        return send(200, { sessions: sessionList() });
      }
      if (req.method === 'DELETE' && p === '/api/sessions') {
        try { mutateSessions(() => getSess().sessions.clear()); }
        catch (e) { return sendErr(e.statusCode || 500, e.message); }
        return send(200, { ok: true, cleared: true });
      }
      let ms = p.match(/^\/api\/sessions\/([^/]+)\/routing$/);
      if (ms && (req.method === 'GET' || req.method === 'PUT')) {
        let key;
        try { key = decodeURIComponent(ms[1]); }
        catch { return sendErr(400, '会话键编码无效'); }
        const b = req.method === 'PUT' ? await readObject() : null;
        const s = sessionRecord(key);
        if (!s) return sendErr(404, '会话不存在(可能已过期)');
        const routing = sessionConfig.routingOf(s);
        const revision = sessionConfig.routingRevision(routing);
        if (!b) return send(200, { routing, revision });
        if (typeof b.expected_revision !== 'string') return sendErr(400, 'expected_revision 必须是字符串');
        if (b.expected_revision !== revision) return sendErr(409, '会话配置已变化，请重新载入后再保存');
        if (Object.keys(b).some(k => !['routing', 'expected_revision'].includes(k)))
          return sendErr(400, '会话配置请求包含未知字段');
        const nextRouting = sessionConfig.normalizeRouting(b.routing, s.app || 'claude', storeOf(s.app || 'claude'));
        const next = { ...s, routing: nextRouting };
        getSess().assertRoutingCapacity(key, nextRouting);
        getSess().assertRoutingConfigurable(key, nextRouting);
        try { mutateSessions(() => { getSess().sessions.set(key, next); getSess().carryMark(s, key); }); }
        catch (e) { return sendErr(e.statusCode || 500, e.message); }
        return send(200, { ok: true, routing: nextRouting, revision: sessionConfig.routingRevision(nextRouting) });
      }
      ms = p.match(/^\/api\/sessions\/([^/]+)\/pin$/);
      if (req.method === 'POST' && ms) {
        const key = decodeURIComponent(ms[1]);
        const b = await readObject();
        const s = getSess().sessions.get(key);
        if (!s) return sendErr(404, '会话不存在(可能已过期)');
        const id = String(b.provider || '');
        if (id) {
          const group = storeOf(s.app || 'claude');
          const prov = group.find(x => x.id === id);
          if (!prov) return sendErr(404, `渠道不存在(该对话属于 ${s.app === 'codex' ? 'Codex' : 'Claude'} 组,只能绑本组渠道)`);
          if (prov.enabled === false) return sendErr(400, `渠道 "${prov.name}" 已停用,不能绑定`);
        }
        try {
          mutateSessions(() => {
            const next = { ...s };
            if (id) {
              next.providerId = id;
              next.pinned = true;
              if (b.model !== undefined) next.model = String(b.model || '');
            } else {
              next.pinned = false; // 置空 = 解除钉定,下次请求重新按策略分配
              next.providerId = '';
            }
            getSess().sessions.set(key, next);
            getSess().carryMark(s, key);   // 钉定/解绑也是整条换对象,世代要跟过去
          });
        }
        catch (e) { return sendErr(e.statusCode || 500, e.message); }
        return send(200, { ok: true, session: sessionList().find(x => x.key === key) || null });
      }
      ms = p.match(/^\/api\/sessions\/([^/]+)$/);
      if (req.method === 'DELETE' && ms) {
        const key = decodeURIComponent(ms[1]);
        if (!getSess().sessions.has(key)) return sendErr(404, '会话不存在(可能已过期)');
        try { mutateSessions(() => getSess().sessions.delete(key)); }
        catch (e) { return sendErr(e.statusCode || 500, e.message); }
        return send(200, { ok: true });
      }

      if (req.method === 'GET' && p === '/api/compact/window') {
        const q = url.searchParams;
        return send(200, { window: compactWindow.get({ scope: q.get('scope') || 'global', project: q.get('project') || '' }) });
      }
      if (req.method === 'POST' && p === '/api/compact/window') {
        return send(200, { ok: true, ...compactWindow.set(await readObject()) });
      }
      if (req.method === 'GET' && p === '/api/compact') {
        return send(200, { compact: compactLib.compactPublic(getRoutes(), getStore().claude) });
      }
      if (req.method === 'POST' && p === '/api/compact') {
        const next = compactLib.selectCompact(getRoutes(), getStore().claude, await readObject());
        saveRoutes(next);
        setRoutes(next); getSess().resetPools();
        return send(200, { ok: true, compact: compactLib.compactPublic(getRoutes(), getStore().claude), routes: getRoutes() });
      }

      if (req.method === 'PUT' && p === '/api/routes') {
        await readObject();
        return sendErr(410, '通用路由规则已移除:压缩规则请在「压缩设置」里配置(POST /api/compact)');
      }

      if (req.method === 'POST' && p === '/api/claude/split') {
        try { return send(200, configureClaudeSplit(await readObject())); }
        catch (e) { return sendErr(e.statusCode || 500, e.message); }
      }

      if (req.method === 'GET' && p === '/api/slots') {
        return send(200, { slots: slotsPublic() });
      }
      if (req.method === 'PUT' && p === '/api/slots') {
        const b = await readObject();
        const err = validateSlotPut(b);
        if (err) return sendErr(400, err);
        const next = structuredClone(getSlotMap());
        for (const app of ['claude', 'codex']) {
          const patch = b[app];
          if (!isObject(patch)) continue;
          for (const [name, val] of Object.entries(patch)) {
            if (val === null) { delete next[app][name]; continue; }
            const before = next[app][name] || {};
            const model = val.model === undefined
              ? (before.provider === val.provider ? before.model : '') : val.model.trim();
            const slot = { provider: val.provider };
            if (app === 'claude' || model) slot.model = model || '';
            const drop = val.dropTools === undefined ? before.dropTools
              : val.dropTools.map(x => x.trim()).filter(Boolean);
            if (drop && drop.length) slot.dropTools = drop;
            const pool = val.pool === undefined ? before.pool : val.pool;
            if (Array.isArray(pool) && pool.length) {
              slot.pool = pool.map(x => (typeof x === 'string' ? { provider: x } : { ...x }));
            }
            const strat = val.strategy === undefined ? before.strategy : val.strategy;
            if (strat && slot.pool) slot.strategy = strat;
            next[app][name] = slot;
          }
        }
        try { return send(200, commitSlotUpdate(next, b.codex !== undefined)); }
        catch (e) { return sendErr(e.statusCode || 500, '写入槽位失败: ' + e.message); }
      }


      sendErr(404, 'not found');
    })();
    return true;
  };
}

module.exports = { createRoutingApi };
