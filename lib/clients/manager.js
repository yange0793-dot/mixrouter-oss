'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic, writeJsonAtomic: saveJson } = require('../atomic-write');
const { backupFile } = require('../config-backup');
const { invalid, isObject } = require('../validation');
const codexConfig = require('../codex-config');
const { planCodexSlots } = require('../codex-router-plan');
const { wireOf } = require('../routing/endpoints');
const { CLAUDE_SLOTS, CLAUDE_SLOT_ENV, slotAlias } = require('../routing/slots');

function createClientManager({ config, getStore, getCurrent, getSlotMap, setSlotMap, slotsPublic, slotTable, setStoreWarnings, findProvider }) {
  const { CLAUDE_SETTINGS, CODEX_CONFIG, PROVIDERS_FILE, SLOTS_FILE, ROUTER_ID, ROUTER_URL, ROUTER_TOKEN, ROUTER_SECTION, PROXY_PORT } = config;
  function readClientConfig(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return { missing: true, cfg: {} };
      throw Object.assign(new Error('Claude 配置读取失败，请检查文件权限；未改写配置'), { statusCode: 400 });
    }
    const stripped = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    if (!stripped.trim()) return { cfg: {} };               // 空文件/纯空白:同上
    try {
      const cfg = JSON.parse(stripped);
      if (!isObject(cfg) || (cfg.env !== undefined && !isObject(cfg.env)))
        throw new Error('配置及 env 必须是 JSON 对象');
      return { cfg };
    }
    catch (e) {
      throw Object.assign(new Error(
        `${file} 解析失败(${e.message}),为避免把它整个覆盖掉,本次写入已中止。` +
        `请先修好该文件的 JSON(BOM、// 注释、尾逗号都会导致解析失败),或先备份再删掉它`),
        { statusCode: 400 });
    }
  }

  function backupWithWatch(file) {
    const warnings = [];
    const bak = backupFile(file, {
      onWarn: msg => { console.warn(`[mixrouter] ${msg}`); warnings.push(msg); },
    });
    return { bak, warnings };
  }

  function switchClaude(p) {
    if (wireOf(p, 'claude') !== 'anthropic')
      throw Object.assign(new Error(`该渠道标了 wire_api: ${wireOf(p, 'claude')}(模型只挂在 Codex/OpenAI 型通道上),直连后 Claude Code 的 /v1/messages 必然失败;请改用控制台的「路由模式」经本机代理转发`), { statusCode: 400 });
    let cfg = readClientConfig(CLAUDE_SETTINGS).cfg;
    const { warnings } = backupWithWatch(CLAUDE_SETTINGS);
    cfg.env = cfg.env || {};
    cfg.env.ANTHROPIC_BASE_URL = p.base_url;
    cfg.env.ANTHROPIC_AUTH_TOKEN = p.api_key;
    for (const [name, envKey] of Object.entries(CLAUDE_SLOT_ENV)) {
      const v = name === 'main' ? ((p.models && p.models[0]) || '') : ((p.slots && p.slots[name]) || '');
      if (v) cfg.env[envKey] = v;
      else if (String(cfg.env[envKey] || '').startsWith('mixr-')) delete cfg.env[envKey];
    }
    writeFileAtomic(CLAUDE_SETTINGS, JSON.stringify(cfg, null, 2) + '\n');
    return { warnings };
  }

  const tomlStr = codexConfig.quote;
  const codexTopLevel = codexConfig.topLevel;

  function commitCodexConfig(before, text, prepared, extraFiles = []) {
    const writes = [];
    if (prepared) {
      writes.push({ file: prepared.file, text: prepared.content, backup: true },
        { file: prepared.sourceFile, text: JSON.stringify({ source: prepared.source, legacy_models: prepared.legacyModels }, null, 2) + '\n', backup: true });
    }
    writes.push({ file: CODEX_CONFIG, text, backup: true, secure: true },
      ...extraFiles.map(write => ({ ...write, secure: write.file === PROVIDERS_FILE })));
    const snapshots = writes.map(write => {
      let previous = null, mode = 0o600, file = write.file;
      try {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) file = fs.realpathSync(file);
        const target = fs.statSync(file);
        if (!target.isFile()) throw new Error(`${path.basename(write.file)} 不是普通文件`);
        mode = target.mode & 0o777;
        previous = fs.readFileSync(file, 'utf8');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { ...write, file, previous, mode };
    });
    const configSnapshot = snapshots[prepared ? 2 : 0];
    if ((configSnapshot.previous ?? '') !== before.text) {
      throw Object.assign(new Error('Codex 配置已被外部修改，请刷新后重试'), { statusCode: 409 });
    }
    const changed = [], warnings = [];
    try {
      for (const item of snapshots) {
        if (item.previous === item.text && (!item.secure || item.mode === 0o600)) continue;
        fs.mkdirSync(path.dirname(item.file), { recursive: true });
        if (item.backup && item.previous !== item.text) warnings.push(...(backupWithWatch(item.file).warnings || []));
        writeFileAtomic(item.file, item.text, { mode: item.secure || item.previous === null ? 0o600 : item.mode });
        changed.push(item);
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const item of changed.reverse()) {
        try {
          if (item.previous === null) fs.unlinkSync(item.file);
          else writeFileAtomic(item.file, item.previous, { mode: item.mode });
        } catch (rollback) { rollbackErrors.push(`${path.basename(item.file)}: ${rollback.message}`); }
      }
      if (rollbackErrors.length) throw Object.assign(new Error(`Codex 同步失败: ${error.message};回滚也失败: ${rollbackErrors.join('; ')} —— 请检查上述文件`), { statusCode: 500 });
      throw error;
    }
    return { warnings };
  }

  function managedCodexDocument(before) {
    if (getCurrent().codex !== ROUTER_ID || !before.text.trim() || before.document.get('profile')) return false;
    const value = key => before.document.get('model_providers', before.document.get('model_provider'), key);
    return before.document.get('model_provider') === ROUTER_SECTION && value('base_url')?.replace(/\/+$/, '') === ROUTER_URL + '/v1' &&
      value('wire_api') === 'responses' && value('experimental_bearer_token') === ROUTER_TOKEN &&
      value('requires_openai_auth') !== true && !value('env_key');
  }

  function codexLegacyAlias(modelIn, ctx) {
    if (getCurrent().codex !== ROUTER_ID || ctx.token !== ROUTER_TOKEN || !codexConfig.nativeClient(ctx.ua) ||
        !String(ctx.session || '').startsWith('cx:')) return '';
    try {
      const before = codexConfig.read(CODEX_CONFIG);
      if (!managedCodexDocument(before) || path.basename(before.document.get('model_catalog_json') || '') !== 'mixrouter-model-catalog.json') return '';
      const source = JSON.parse(fs.readFileSync(path.join(path.dirname(CODEX_CONFIG), 'mixrouter-model-catalog.source.json'), 'utf8'));
      // 原生默认可为保留 Fast 使用真实模型名;不能只认上次同步目录时记录的旧 ID。
      // 当前默认优先于历史映射,主/审查同名时仍只认主槽,不猜请求身份。
      if (typeof modelIn === 'string' && modelIn && !modelIn.startsWith('mixr-')) {
        if (modelIn === before.document.get('model')) return 'mixr-main';
        if (modelIn === before.document.get('review_model')) return 'mixr-reviewer';
      }
      const alias = Object.hasOwn(source.legacy_models || {}, modelIn) ? source.legacy_models[modelIn] : '';
      return typeof alias === 'string' && /^mixr-(main|reviewer)$/.test(alias) ? alias : '';
    } catch { return ''; }
  }

  function prepareCodexSync(next = getSlotMap()) {
    if (getCurrent().codex !== ROUTER_ID) return null;
    const before = codexConfig.read(CODEX_CONFIG);
    if (!managedCodexDocument(before)) return null;
    const slots = slotTable.slotsPublic(next).codex;
    const prepared = codexConfig.prepareCatalog(CODEX_CONFIG, before.document, slots);
    const top = { model_catalog_json: path.basename(prepared.file) };
    if (next.codex.main && !String(before.document.get('model') || '').startsWith('mixr-')) top.model = slotAlias('codex', 'main');
    if (next.codex.reviewer && !String(before.document.get('review_model') || '').startsWith('mixr-')) top.review_model = slotAlias('codex', 'reviewer');
    return { before, text: codexConfig.patch(before.text, { top }), prepared };
  }

  function withCodexSync(save) {
    const plan = prepareCodexSync();
    if (!plan) return save();
    setStoreWarnings([]);
    const result = commitCodexConfig(plan.before, plan.text, plan.prepared, [{ file: PROVIDERS_FILE,
      text: JSON.stringify({ version: 2, current: getCurrent(), claude: getStore().claude, codex: getStore().codex }, null, 2) + '\n', backup: true }]);
    setStoreWarnings(result.warnings);
    return result;
  }

  function commitSlotUpdate(next, codexChanged) {
    const plan = codexChanged ? prepareCodexSync(next) : null;
    let warnings = [];
    if (plan) ({ warnings } = commitCodexConfig(plan.before, plan.text, plan.prepared, [{ file: SLOTS_FILE,
      text: JSON.stringify({ version: 1, claude: next.claude, codex: next.codex }, null, 2) + '\n' }]));
    else saveJson(SLOTS_FILE, { version: 1, claude: next.claude, codex: next.codex });
    setSlotMap(next);
    return { ok: true, slots: slotsPublic(), ...(codexChanged ? { live: { codex: liveState().codex } } : {}),
      ...(warnings.length ? { warnings } : {}) };
  }

  function updateCodexConfig(options) {
    const before = codexConfig.read(CODEX_CONFIG);
    if (typeof options.revision !== 'string' || options.revision !== before.revision)
      throw Object.assign(new Error('Codex 配置已变化或缺少版本号，请刷新后重试'), { statusCode: 409 });
    if (before.document.get('profile')) throw codexConfig.invalid('当前使用 Codex profile，未改写全局配置');
    let prepared = null;
    const top = {};
    const live = liveState().codex;
    if (options.action === 'direct_models' || (options.action === 'sync_catalog' && live.connection_mode === 'direct')) {
      if (live.connection_mode !== 'direct') throw codexConfig.invalid('只有直连模式可修改真实模型；路由模式请修改槽位');
      if (options.action === 'direct_models') {
        if (!Object.hasOwn(options, 'model') && !Object.hasOwn(options, 'review_model'))
          throw codexConfig.invalid('请选择主模型或审查模型');
        for (const key of ['model', 'review_model']) {
          if (!Object.hasOwn(options, key)) continue;
          const value = options[key];
          if (key === 'review_model' && value === null) { top[key] = null; continue; }
          if (typeof value !== 'string' || !value.trim() || /\s/.test(value.trim()) || value.trim().startsWith('mixr-'))
            throw codexConfig.invalid('直连模式必须使用真实模型名，不能使用 mixr-* 路由别名');
          top[key] = value.trim();
        }
      }
      const provider = getStore().codex.find(item => item.id === live.direct_provider_id);
      prepared = codexConfig.prepareDirectCatalog(CODEX_CONFIG, before.document,
        [provider?.model, ...(provider?.models || []), top.model ?? live.model,
          Object.hasOwn(top, 'review_model') ? top.review_model : live.review_model]);
      top.model_catalog_json = path.basename(prepared.file);
    } else if (options.action === 'sync_catalog') {
      prepared = codexConfig.prepareCatalog(CODEX_CONFIG, before.document, slotsPublic().codex);
      if (!prepared) throw codexConfig.invalid('没有配置本地模型目录；不会凭空生成模型能力');
      top.model_catalog_json = path.basename(prepared.file);
    } else if (options.action === 'reasoning') {
      const effort = options.model_reasoning_effort;
      const levels = liveState().codex.main?.reasoning_levels || [];
      if (effort !== null && (typeof effort !== 'string' || !levels.includes(effort)))
        throw codexConfig.invalid('推理档位必须来自当前模型的本地能力目录，或设为自动');
      top.model_reasoning_effort = effort;
    } else if (options.action === 'compact_threshold') {
      top.model_auto_compact_token_limit = codexConfig.parseCompactThreshold(options.model_auto_compact_token_limit);
    } else throw codexConfig.invalid('未知 Codex 配置操作');
    const result = commitCodexConfig(before, codexConfig.patch(before.text, { top }), prepared);
    return { ok: true, codex: liveState().codex, unknown_aliases: prepared?.unknown || [],
      ...(result.warnings.length ? { warnings: result.warnings } : {}) };
  }

  function writeCodexConfig({ section, name, base_url, api_key, wire_api, model, keepModel, reviewModel, catalogPath, memories, extraFiles = [], syncCatalog = false, directModels, expectedRevision }) {
    const before = codexConfig.read(CODEX_CONFIG);
    if (expectedRevision && expectedRevision !== before.revision)
      throw Object.assign(new Error('Codex 配置已被外部修改，请刷新后重试'), { statusCode: 409 });
    if (before.document.get('profile')) throw codexConfig.invalid('当前选择了 Codex profile，请先确认 profile 配置；未改写全局配置');
    const prepared = directModels ? codexConfig.prepareDirectCatalog(CODEX_CONFIG, before.document, directModels)
      : syncCatalog ? codexConfig.prepareCatalog(CODEX_CONFIG, before.document, slotsPublic().codex) : null;
    const tables = memories && Object.keys(memories).length ? [{ parts: ['memories'], values: memories }] : [];
    const text = codexConfig.patch(before.text, {
      top: { model: keepModel && before.document.get('model') ? before.document.get('model') : model,
        model_provider: section, review_model: reviewModel,
        ...(prepared ? { model_catalog_json: path.basename(prepared.file) } : {}),
        ...(catalogPath !== undefined ? { model_catalog_json: catalogPath } : {}) },
      section, provider: { name, base_url, wire_api: wire_api || 'responses', requires_openai_auth: false, experimental_bearer_token: api_key },
      ...(tables.length ? { tables } : {}),
    });
    commitCodexConfig(before, text, prepared, extraFiles);
  }

  function switchCodex(p) {
    if (p.wire_api === 'chat') throw codexConfig.invalid('Codex 只使用 Responses；Chat 渠道请绑定槽位并使用路由模式，不能直接写入客户端');
    const before = codexConfig.read(CODEX_CONFIG);
    const model = p.model || (p.models && p.models[0]) || '';
    const review = before.document.get('review_model');
    const reviewModel = typeof review === 'string' && review.startsWith('mixr-') ? model : review;
    const memories = {};
    if (model) {
      for (const key of ['extract_model', 'consolidation_model']) {
        const value = before.document.get('memories', key);
        if (typeof value === 'string' && value.startsWith('mixr-')) memories[key] = model;
      }
    }
    writeCodexConfig({ section: 'mixr-' + p.id, name: p.name, base_url: codexConfig.baseURL(p.base_url),
      api_key: p.api_key, wire_api: p.wire_api || 'responses',
      model, reviewModel, memories, directModels: [model, ...(p.models || []), reviewModel],
      expectedRevision: before.revision });
  }

  function switchClaudeRouter(options = {}) {
    let cfg = readClientConfig(CLAUDE_SETTINGS).cfg;
    const { warnings } = backupWithWatch(CLAUDE_SETTINGS);
    cfg.env = cfg.env || {};
    cfg.env.ANTHROPIC_BASE_URL = ROUTER_URL;
    cfg.env.ANTHROPIC_AUTH_TOKEN = ROUTER_TOKEN;
    if (options.slots) {
      for (const [name, envKey] of Object.entries(CLAUDE_SLOT_ENV)) {
        const s = (getSlotMap().claude || {})[name];
        if (s && s.provider) cfg.env[envKey] = slotAlias('claude', name);
        else if (String(cfg.env[envKey] || '').startsWith('mixr-')) delete cfg.env[envKey];
      }
    }
    writeFileAtomic(CLAUDE_SETTINGS, JSON.stringify(cfg, null, 2) + '\n');
    return { warnings };
  }
  function switchCodexRouter(options = {}) {
    const before = codexConfig.read(CODEX_CONFIG);
    if (options.revision && options.revision !== before.revision)
      throw Object.assign(new Error('Codex 配置已被外部修改，请刷新后重试'), { statusCode: 409 });
    if (before.document.get('profile')) throw codexConfig.invalid('当前选择了 Codex profile，请先确认 profile 配置；未改写全局配置');
    const next = structuredClone(getSlotMap());
    if (options.main) {
      const model = String(options.main.model || '').trim();
      next.codex.main = { provider: options.main.provider, ...(model ? { model } : {}) };
    }
    const plan = planCodexSlots(slotTable.slotsPublic(next).codex, getStore().codex, { strict: !!options.slots });
    for (const name of plan.bootstrap) next.codex[name] = { provider: plan.slots.find(slot => slot.name === name).provider };
    const prepared = codexConfig.prepareCatalog(CODEX_CONFIG, before.document, plan.slots);
    const text = codexConfig.patch(before.text, {
      top: { model: plan.model, review_model: plan.reviewModel,
        model_provider: ROUTER_SECTION, model_catalog_json: path.basename(prepared.file) },
      section: ROUTER_SECTION, provider: { name: `mixrouter(经 :${PROXY_PORT} 路由)`, base_url: ROUTER_URL + '/v1',
        wire_api: 'responses', requires_openai_auth: false, experimental_bearer_token: ROUTER_TOKEN },
    });
    const result = commitCodexConfig(before, text, prepared, [{ file: SLOTS_FILE,
      text: JSON.stringify({ version: 1, claude: next.claude, codex: next.codex }, null, 2) + '\n' }]);
    setSlotMap(next);
    return result;
  }
  function switchRouter(app, options = {}) {
    if (app === 'codex') return switchCodexRouter(options);
    if (app === 'claude') return switchClaudeRouter(options);
    throw invalid('未知客户端 app(只支持 claude / codex)');
  }

  const trimSlash = s => String(s || '').replace(/\/+$/, '');
  function liveState() {
    const live = {};
    let cfg = {}, claudeReadError = '';
    try { cfg = readClientConfig(CLAUDE_SETTINGS).cfg; }
    catch { claudeReadError = 'Claude 配置读取或解析失败，请检查 JSON 格式与文件权限'; }
    const env = cfg.env || {};
    const claudeBase = env.ANTHROPIC_BASE_URL || '';
    const curClaude = getCurrent().claude && getCurrent().claude !== ROUTER_ID ? findProvider(getCurrent().claude) : null;
    const claudeRouter = trimSlash(claudeBase) === ROUTER_URL;
    live.claude = { base_url: claudeBase, model: env.ANTHROPIC_MODEL || '', router: claudeRouter,
      ...(claudeReadError ? { error: claudeReadError } : {}),
      slots: Object.fromEntries(CLAUDE_SLOTS.map(n => [n, env[CLAUDE_SLOT_ENV[n]] || ''])),
      match: claudeRouter
        ? (getCurrent().claude === ROUTER_ID
          || !!(curClaude && trimSlash(curClaude.base_url) === ROUTER_URL && curClaude.api_key === (env.ANTHROPIC_AUTH_TOKEN || '')))
        : !!(curClaude && curClaude.base_url === claudeBase && curClaude.api_key === (env.ANTHROPIC_AUTH_TOKEN || '')) };

    live.codex = codexConfig.state(CODEX_CONFIG, { current: getCurrent().codex, providers: getStore().codex,
      routerURL: ROUTER_URL, routerToken: ROUTER_TOKEN, slots: slotsPublic().codex });
    let legacyModels = {};
    const hotEnabled = getCurrent().codex === ROUTER_ID && live.codex.provider === ROUTER_SECTION && live.codex.match && !live.codex.profile;
    if (hotEnabled && path.basename(live.codex.model_catalog_json || '') === 'mixrouter-model-catalog.json') {
      try {
        const source = JSON.parse(fs.readFileSync(path.join(path.dirname(CODEX_CONFIG), 'mixrouter-model-catalog.source.json'), 'utf8'));
        legacyModels = Object.fromEntries(Object.entries(source.legacy_models || {}).filter(([id, alias]) => id && /^mixr-(main|reviewer)$/.test(alias)).slice(-32));
      } catch {}
    }
    live.codex.hot_routing = { enabled: !!hotEnabled, legacy_models: legacyModels, native_picker_refresh: 'next-client' };
    return live;
  }


  return { readClientConfig, switchClaude, switchCodex, switchClaudeRouter, switchCodexRouter, switchRouter,
    liveState, writeCodexConfig, updateCodexConfig, prepareCodexSync, withCodexSync, commitSlotUpdate,
    codexLegacyAlias, tomlStr, codexTopLevel };
}

module.exports = { createClientManager };
