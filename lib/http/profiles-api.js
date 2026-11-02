'use strict';
// 模型方案 HTTP 层:/api/profiles。
// 只做路径 / 方法 / Content-Type 的形状校验与状态码;快照、预览、应用在 lib/route-profiles.js。
//
// 路由(与 contracts 一致):
//   GET    /api/profiles                    列表(revision / profiles / slots_revision)
//   POST   /api/profiles                    保存当前选定的客户端槽位组
//   POST   /api/profiles/:id/preview        差异预览(只读)
//   POST   /api/profiles/:id/apply          确认后应用(只调用注入的 applySlots)
//   DELETE /api/profiles/:id                只删除保存的方案,不动活槽位
// 未匹配的路径或方法返回 false,由控制台落到 404。
const { isJsonRequest } = require('./local-access');
const { invalid, isObject } = require('../validation');
const profiles = require('../route-profiles');

function createProfilesApi(deps) {
  const { file, getSlots, storeOf, validateSlotPut, applySlots } = deps || {};
  if (typeof file !== 'string' || !file) throw new TypeError('createProfilesApi: file 必须是非空路径');
  for (const [name, value] of Object.entries({ getSlots, storeOf, validateSlotPut, applySlots })) {
    if (typeof value !== 'function') throw new TypeError(`createProfilesApi: ${name} 必须是函数`);
  }
  const currentSlots = () => {
    const slots = getSlots();
    return isObject(slots) ? slots : { claude: {}, codex: {} };
  };
  // 与 /api/bots、/api/insights/models 同一道闸门:写操作必须是 application/json。
  const requireJson = (req, send) => {
    if (isJsonRequest(req)) return true;
    send(415, { error: 'Content-Type 必须是 application/json' });
    return false;
  };

  return async function profilesApi({ req, url, readObject, send }) {
    const path = url.pathname;
    if (path !== '/api/profiles' && !path.startsWith('/api/profiles/')) return false;

    if (path === '/api/profiles') {
      if (req.method === 'GET') {
        send(200, profiles.listProfiles(file, currentSlots()));
        return true;
      }
      if (req.method === 'POST') {
        if (!requireJson(req, send)) return true;
        // 先读完请求体再取活槽位:慢请求体期间别的窗口可能已经改过槽位,
        // CAS 必须对着"此刻"的表检查,并用此刻的表做快照,不能拿请求开始时的旧表覆盖。
        const input = await readObject();
        send(200, profiles.createProfile(file, currentSlots(), input));
        return true;
      }
      return false;
    }

    const match = /^\/api\/profiles\/([^/]+)(?:\/(preview|apply))?$/.exec(path);
    if (!match) return false;
    let id;
    try { id = decodeURIComponent(match[1]); } catch { return false; }
    const action = match[2];

    if (!action && req.method === 'DELETE') {
      if (!requireJson(req, send)) return true;
      send(200, profiles.deleteProfile(file, id, await readObject()));
      return true;
    }
    if (action === 'preview' && req.method === 'POST') {
      if (!requireJson(req, send)) return true;
      // 预览不接受任何入参:方案内容只来自磁盘,不能借预览注入槽位。
      const body = await readObject();
      if (Object.keys(body).length) throw invalid('预览请求不需要字段');
      send(200, profiles.previewProfile(file, currentSlots(), id, storeOf, validateSlotPut));
      return true;
    }
    if (action === 'apply' && req.method === 'POST') {
      if (!requireJson(req, send)) return true;
      // 同上:revision 比对与 applySlots 目标必须是读体之后那一刻的活槽位。
      const input = await readObject();
      const result = profiles.applyProfile(file, currentSlots(), id, input,
        { storeOf, validateSlotPut, applySlots });
      // 用应用后的活槽位重算 revision:客户端拿到它就能判断下一次预览是否仍对得上。
      send(200, { ...result, slots_revision: profiles.slotsRevision(currentSlots()) });
      return true;
    }
    return false;
  };
}

module.exports = { createProfilesApi };
