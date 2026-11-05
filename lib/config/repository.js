'use strict';
const fs = require('node:fs');
const { writeJsonAtomic } = require('../atomic-write');
const { normalizeRule } = require('../routing/rules');
const { normalizeSlotsFile } = require('../routing/slots');

function readConfig(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`${file} 不是有效的 JSON，未加载或覆盖配置；请修复文件或恢复备份`); }
}

function loadConfiguration({ PROVIDERS_FILE, ROUTES_FILE, SLOTS_FILE }) {
  const raw = readConfig(PROVIDERS_FILE, null);
  if (raw !== null && !Array.isArray(raw) && (typeof raw !== 'object'
      || ['claude', 'codex'].some(app => raw[app] !== undefined && !Array.isArray(raw[app])))) {
    throw new Error('providers.json 的渠道组必须是数组，未加载或覆盖配置');
  }
  const rules = readConfig(ROUTES_FILE, { rules: [] });
  if (!rules || typeof rules !== 'object' || (rules.rules !== undefined && !Array.isArray(rules.rules)))
    throw new Error('routes.json 的 rules 必须是数组，未加载或覆盖配置');
  return {
    store: Array.isArray(raw) ? { claude: raw, codex: [] } : { claude: raw?.claude || [], codex: raw?.codex || [] },
    current: { claude: raw?.current?.claude || null, codex: raw?.current?.codex || null },
    routes: { rules: (rules.rules || []).map(rule => normalizeRule(rule, { preserveInvalidPin: true })) },
    slotMap: normalizeSlotsFile(readConfig(SLOTS_FILE, null)),
  };
}

function createRepository({ files, getStore, getCurrent, setCurrent, getRoutes, getSlotMap, syncCodex }) {
  let warnings = [];
  const saveStore = () => {
    warnings = [];
    const store = getStore();
    writeJsonAtomic(files.PROVIDERS_FILE, { version: 2, current: getCurrent(), claude: store.claude, codex: store.codex }, {
      backup: true,
      onWarn: message => { console.warn(`[mixrouter] ${message}`); warnings.push(message); },
    });
  };
  const saveRoutes = (value = getRoutes()) => writeJsonAtomic(files.ROUTES_FILE, value);
  const saveSlots = () => {
    const slots = getSlotMap();
    writeJsonAtomic(files.SLOTS_FILE, { version: 1, claude: slots.claude, codex: slots.codex });
  };
  const drainStoreWarnings = () => {
    const result = warnings.length ? warnings : undefined;
    warnings = [];
    return result;
  };
  function withStoreRollback(mutate, { syncCodex: synchronize = false } = {}) {
    const before = structuredClone({ ...getStore(), current: getCurrent() });
    try {
      mutate();
      if (synchronize) syncCodex(saveStore);
      else saveStore();
    } catch (error) {
      Object.assign(getStore(), { claude: before.claude, codex: before.codex });
      setCurrent({ ...getCurrent(), ...before.current });
      throw error;
    }
  }
  function applyClientSwitch(app, write, value) {
    const before = { ...getCurrent() };
    getCurrent()[app] = value;
    try { saveStore(); }
    catch (error) {
      setCurrent(before);
      throw Object.assign(new Error('写入渠道库失败: ' + error.message), { statusCode: 500 });
    }
    const storeWarnings = drainStoreWarnings();
    try {
      const client = write() || {};
      return { ...client, warnings: [...(storeWarnings || []), ...(client.warnings || [])] };
    } catch (error) {
      setCurrent(before);
      try { saveStore(); }
      catch (rollback) {
        throw Object.assign(new Error(`写入客户端配置失败: ${error.message};回退渠道库也失败: ${rollback.message} —— 盘上已不一致,请检查 providers.json`), { statusCode: 500 });
      }
      const statusCode = error.statusCode || 500;
      throw Object.assign(new Error(statusCode < 500 ? error.message : '写入客户端配置失败: ' + error.message), { statusCode });
    }
  }
  return { saveStore, saveRoutes, saveSlots, withStoreRollback, applyClientSwitch, drainStoreWarnings,
    setStoreWarnings: value => { warnings = value; } };
}

module.exports = { readConfig, loadConfiguration, createRepository };
