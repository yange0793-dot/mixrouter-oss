'use strict';
/* Mixrouter 接入向导、槽位后备池与脱敏诊断报告预览。
 *
 * 与 app.js 共用同一个 realm(classic script,不是 ESM):只声明本文件自己的变量与函数,
 * 不重复声明 `$` / `esc` / `state` / `toast` —— 重复声明会当场报错,这是安全网。
 *
 * 这一层刻意**不接管**已有的渠道编辑、槽位保存与日志渲染:
 *   - 新建渠道仍走 openProvider();主槽仍走 putSlot();槽位保存仍走 PUT /api/slots。
 *   - 向导只做「把它们按顺序串起来」:检查客户端 → 选/导入渠道 → 选模型 → 兼容测试 →
 *     预览客户端写入 → 显式确认 → 撤销入口。每一步失败都留在原地并说明原因。
 *
 * 几条不允许含糊的口径:
 *   1) 客户端配置「读不到 / 解析失败」不是「未配置」。命中这两种状态时,向导禁止写入,
 *      也不显示成待写入的空配置 —— 否则用户会以为自己在从零接入,其实是在覆盖一份读不出来的文件。
 *   2) 兼容测试是「所选 provider / model / key / client wire 的一次测试(最多 3 次上游请求:
 *      生成 / 流式 / 工具调用)」,不是持续健康。
 *      服务端不返回结果就显示「未运行」,不拿旧的通过结果顶上;按钮旁先写明会消耗额度。
 *   3) 写入与撤销都必须先拿到预览 token、再由用户显式确认。预览过期或服务端拒绝时保留原因,
 *      不把 token 重试到天荒地老。
 *   4) 诊断报告只显示白名单字段的 JSON 文本;不自动读取、不自动上传,下载只在点击后发生。
 *   5) 槽位后备池只改 `pool` 顺序与成员模型:主渠道永远排第一(服务端保证),dropTools 原样带回,
 *      已有非 priority 策略原样保留 —— 不在「编辑后备池」里偷偷改掉用户的其他策略。
 */

(function () {
  // 浏览器里 window === globalThis;测试/嵌入环境里两者可能不是同一个对象。
  // 内联 onclick 与其它脚本都按全局名字查找,所以两条路都挂上,别只在 window 上挂一份。
  const rGlobal = (typeof globalThis !== 'undefined' && globalThis)
    || (typeof window !== 'undefined' ? window : {});
  if (rGlobal.__mixrReadinessUi) return;
  rGlobal.__mixrReadinessUi = true;

  // 客户端协议不是随便挑的:Claude 只说 Anthropic Messages,Codex 只说 OpenAI Responses,
  // 上游用哪种由渠道的 wire_api 决定(chat/responses 渠道由 mixrouter 现场转换)。只有 ZCode
  // 三种都能说,选 Anthropic 复用 Claude 组渠道、选 OpenAI 复用 Codex 组渠道。
  const R_APPS = {
    claude: {
      label: 'Claude Code', cfg: '~/.claude/settings.json', clientWire: 'messages',
      note: 'Claude Code 固定发 Anthropic Messages；上游协议由渠道的 wire_api 决定（responses / chat 渠道由 mixrouter 现场转换）。',
    },
    codex: {
      label: 'Codex', cfg: '~/.codex/config.toml', clientWire: 'responses',
      note: 'Codex 固定发 OpenAI Responses；上游协议由渠道的 wire_api 决定（chat 渠道由 mixrouter 现场转换）。',
    },
    zcode: {
      label: 'ZCode', cfg: '~/.zcode/v2/config.json', wires: ['anthropic', 'responses', 'chat'],
      note: 'ZCode 可选三种客户端协议；选 Anthropic 复用 Claude 组渠道，选 OpenAI 复用 Codex 组渠道。',
    },
  };
  const R_WIRE_LABEL = { anthropic: 'Anthropic Messages', responses: 'OpenAI Responses', chat: 'OpenAI Chat Completions' };
  // ZCode 的 wire 选择 → 客户端实际发出的协议名(与服务端兼容探针的枚举一致)。
  const R_ZCODE_CLIENT_WIRE = { anthropic: 'messages', responses: 'responses', chat: 'chat' };
  const R_CLIENT_WIRE_LABEL = { messages: 'Anthropic Messages', responses: 'OpenAI Responses', chat: 'OpenAI Chat Completions' };
  const R_OFFLINE_INSPECT = '控制台离线';
  // 兼容测试在后端是最多 3 次上游调用(每次默认 30 秒,总时限约 90 秒)。前端若按 65 秒断开,
  // 会把一次仍在进行的真实测试报成「请求超时」,而后端还会把剩下那几次跑完并计费。
  // 留出余量:100 秒 > 后端 90 秒总时限。
  const R_COMPAT_TIMEOUT_MS = 100000;
  const R_STATUS_LABEL = {
    ok: '通过', pass: '通过', green: '通过',
    fail: '失败', error: '失败', red: '失败',
    warn: '警告', warning: '警告',
    unknown: '未确认', skip: '跳过', skipped: '跳过',
  };
  // 服务端字段名可能随实现微调:只按一组已知别名读取,读到什么显示什么,读不到就明说「未提供」。
  const R_CONFIG_STATES = {
    missing: 'missing', absent: 'missing', not_found: 'missing', notfound: 'missing', none: 'missing',
    ok: 'ok', present: 'ok', found: 'ok', exists: 'ok', configured: 'ok', ready: 'ok',
    invalid: 'invalid', corrupt: 'invalid', parse_error: 'invalid', parseerror: 'invalid', malformed: 'invalid',
    error: 'error', read_error: 'error', unreadable: 'error', eacces: 'error', permission_denied: 'error',
  };

  const rEl = id => { try { return document.getElementById(id); } catch { return null; } };
  const rEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rIsObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const rList = v => v == null ? [] : (Array.isArray(v) ? v : [v]);
  const rText = value => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try { return JSON.stringify(value); } catch { return String(value); }
  };

  // app.js 的全局词法环境。页面缺少 app.js(被单独打开/测试片段)时全部按「未就绪」处理。
  const rState = () => (typeof state !== 'undefined' ? state : null);
  const rOnline = () => (typeof online !== 'undefined' ? !!online : false);
  const rCurApp = () => (typeof curApp !== 'undefined' && R_APPS[curApp] ? curApp : 'claude');
  const rToast = (msg, cls) => { if (typeof toast === 'function') toast(msg, cls); };
  const rRefresh = async () => { if (typeof refresh === 'function') { try { await refresh(); } catch { /* refresh 自己会显示离线状态 */ } } };

  const readinessState = {
    mounted: false, open: false,
    app: 'claude', zcodeWire: 'anthropic', providerId: '', model: '', keyId: '',
    inspect: null, inspectError: '', busy: '',
    importOpen: false, importText: '', importToken: '', importPreview: null, importError: '',
    preview: null, previewError: '', applyResult: null, applyWarnings: [], applyError: '',
    test: null, testError: '',
    undo: null, undoError: '', undoResult: null,
    slot: null, slotStatus: null, slotSetup: null,
    report: null, reportError: '', reportBusy: false,
    entryStatus: '', focusAfter: '',
    mountedPoolSig: '',
  };

  // ---------------------------------------------------------------- 基础读取

  function readinessApps() { return Object.keys(R_APPS); }
  function readinessGroup() {
    if (readinessState.app === 'zcode') return readinessState.zcodeWire === 'anthropic' ? 'claude' : 'codex';
    return readinessState.app === 'codex' ? 'codex' : 'claude';
  }
  // 兼容测试要的是"客户端会发出什么协议",不是"上游是什么协议"。
  function readinessClientWire() {
    if (readinessState.app === 'zcode') return R_ZCODE_CLIENT_WIRE[readinessState.zcodeWire] || 'messages';
    return R_APPS[readinessState.app].clientWire;
  }
  function readinessProviders() {
    const s = rState();
    return s?.providers?.[readinessGroup()] || [];
  }
  function readinessSelectedProvider() {
    return readinessProviders().find(p => p.id === readinessState.providerId) || null;
  }
  // ZCode 的默认协议跟随渠道自己的 wire_api:选 Claude 组渠道默认 Anthropic,Codex 组渠道默认 Responses。
  function readinessDefaultZcodeWire(provider) {
    const allowed = R_APPS.zcode.wires;
    return provider && allowed.includes(provider.wire_api) ? provider.wire_api : 'anthropic';
  }
  function readinessDefaultModel(provider) {
    if (!provider) return '';
    return readinessGroup() === 'codex' ? (provider.model || '') : ((provider.models || [])[0] || '');
  }
  function readinessDefaultKey(provider) {
    return provider?.active_key || (provider?.keys || [])[0]?.id || '';
  }
  function readinessSlots() { return rState()?.slots || { claude: [], codex: [] }; }
  function readinessClaudeSlot(name) { return (readinessSlots().claude || []).find(s => s.name === name) || null; }

  function readinessBlockedReason() {
    if (readinessState.inspectError) return '无法检查客户端配置：' + readinessState.inspectError;
    const info = readinessInspectInfo();
    if (info.config.state === 'invalid') return '客户端配置存在但无法解析。向导不会写入，也不会把它当作未配置；请先修复或备份后删除该文件。';
    if (info.config.state === 'error') return '客户端配置读取失败（可能是权限或 IO 错误）。向导不会写入，也不会把它当作未配置；请先确认该文件可读。';
    return '';
  }
  // 写入门禁还要等检查结果落地:没检查过就写,等于不知道要覆盖的是什么。
  function readinessCanWrite() {
    return rOnline() && !readinessState.busy && !!readinessState.inspect && !readinessBlockedReason();
  }

  async function readinessCall(path, opt = {}, timeout = 12000) {
    if (!rOnline()) throw new Error('控制台离线，未发送请求');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(path, {
        ...opt,
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (!res.ok) {
        const reason = body && (typeof body.error === 'string'
          ? body.error
          : (body.error && (body.error.message || body.error.code)) || body.message || body.detail);
        throw new Error(reason || `HTTP ${res.status}`);
      }
      return body;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`请求超时（${Math.round(timeout / 1000)} 秒）`);
      throw error;
    } finally { clearTimeout(timer); }
  }

  // 写入方式取决于槽位表,不是向导里选的那一行:Claude/Codex 的服务端预览走路由模式,
  // 只有 slots:true 才会把槽位别名写进 env / top model。这里如实算出"这次会写什么"。
  function readinessWriteMode() {
    const app = readinessState.app;
    if (app === 'zcode') {
      return {
        kind: 'zcode', slots: false, model: readinessState.model,
        note: '按所选客户端协议写入 ZCode 自有 provider（模型与 base URL 由服务端按渠道库生成）。写入不会切换你正在用的会话；之后要在 ZCode 的模型选择器里选 Mixrouter。',
      };
    }
    const missing = readinessMissingSlots(app);
    const main = readinessSlotState(app, 'main').slot;
    if (!missing.length) {
      const aliased = (R_SLOT_NAMES[app] || []).filter(name => readinessSlotState(app, name).configured);
      return {
        kind: 'slots', slots: true, model: main?.model || '',
        note: `路由模式 + 槽位别名：${aliased.join(' / ')} 会指向 ${main?.provider_name || main?.provider || '所选渠道'}。`,
      };
    }
    const unaliased = app === 'claude'
      ? '其余槽位不写别名（手设的真实模型名保留，过期的 mixr-* 清掉），这些请求按路由规则分发。'
      : 'Codex 需要 main 与 reviewer 两个槽位都可用；缺一个时只写路由地址，不会自动补槽。';
    return {
      kind: 'router', slots: false, model: '',
      note: `只写路由地址与令牌，不写槽位别名（缺少：${missing.join(' / ')}）。${unaliased}`,
    };
  }

  // ---------------------------------------------------------------- 检查结果归一化

  function readinessInspectInfo() {
    const raw = rIsObj(readinessState.inspect) ? readinessState.inspect : {};
    let binary = null;
    const binRaw = raw.binary !== undefined ? raw.binary : (rIsObj(raw.install) ? raw.install.binary : undefined);
    if (binRaw === false) binary = { found: false, path: '', version: '' };
    else if (typeof binRaw === 'string') binary = { found: true, path: binRaw, version: '' };
    else if (rIsObj(binRaw)) binary = {
      found: binRaw.found ?? binRaw.exists ?? binRaw.present ?? (binRaw.path ? true : undefined),
      executable: binRaw.executable,
      path: binRaw.path || binRaw.command || binRaw.bin || '',
      version: binRaw.version || binRaw.release || '',
      error: binRaw.error || '',
    };
    else if (typeof raw.installed === 'boolean') binary = { found: raw.installed, path: '', version: '' };
    if (binary && binary.found === undefined) binary.found = binary.path ? true : undefined;

    let cfgRaw = raw.config !== undefined ? raw.config : (rIsObj(raw.client) ? raw.client.config : undefined);
    let cfg = null;
    if (typeof cfgRaw === 'string') cfg = { state: 'ok', path: cfgRaw, error: '' };
    else if (rIsObj(cfgRaw)) cfg = {
      state: cfgRaw.state || cfgRaw.status || cfgRaw.kind || '',
      path: cfgRaw.path || cfgRaw.file || '',
      error: cfgRaw.error || cfgRaw.message || '',
      exists: cfgRaw.exists,
    };
    else if (typeof raw.config_state === 'string' || typeof raw.config_path === 'string') cfg = {
      state: raw.config_state || '', path: raw.config_path || '', error: raw.config_error || '', exists: raw.config_exists,
    };
    if (!cfg) cfg = { state: '', path: '', error: '', exists: undefined };
    const rawState = String(cfg.state || '').toLowerCase();
    let stateName = R_CONFIG_STATES[rawState] || '';
    if (!stateName) {
      if (cfg.exists === false) stateName = 'missing';
      else if (cfg.exists === true) stateName = 'ok';
      else stateName = 'unknown';
    }
    return {
      raw,
      binary,
      routed: typeof raw.routed === 'boolean' ? raw.routed : null,
      config: { ...cfg, state: stateName, rawState: rawState || String(cfg.state || '') },
    };
  }

  function readinessBinaryBadge(binary) {
    if (!binary) return '<span class="badge off">安装状态未提供</span>';
    // 找到了但不可执行与「没装」处理方式完全不同:前者要改权限,后者要安装。
    if (binary.found === true && binary.executable === false) return '<span class="badge drift">已检测到但不可执行</span>';
    if (binary.found === true) return '<span class="badge on">已检测到客户端</span>';
    if (binary.found === false) return '<span class="badge off">未检测到客户端</span>';
    return '<span class="badge off">安装状态未提供</span>';
  }
  function readinessConfigBadge(config) {
    const map = {
      ok: ['on', '客户端配置已存在'],
      missing: ['info', '尚未配置（可新建）'],
      invalid: ['drift', '配置无法解析'],
      error: ['drift', '配置读取失败'],
      unknown: ['off', '配置状态未提供'],
    };
    const [cls, text] = map[config.state] || map.unknown;
    return `<span class="badge ${cls}">${text}</span>`;
  }

  // ---------------------------------------------------------------- 渲染:检查

  function readinessInspectHtml() {
    const info = readinessInspectInfo();
    const busy = readinessState.busy === 'inspect';
    const retry = `<button class="small" type="button" id="readiness-inspect-retry" onclick="readinessInspect()" ${busy || !rOnline() ? 'disabled' : ''}>${busy ? '检查中…' : '重新检查'}</button>`;
    const bits = [
      readinessBinaryBadge(info.binary),
      readinessConfigBadge(info.config),
      info.routed === true ? '<span class="badge info">当前已指向本机路由</span>' : '',
    ].join('');
    const pathLine = [
      info.binary?.path ? `可执行文件：${rEsc(info.binary.path)}${info.binary.version ? ' · ' + rEsc(info.binary.version) : ''}` : '',
      info.config.path ? `配置文件：${rEsc(info.config.path)}（${rEsc(info.config.rawState || info.config.state)}）` : '',
    ].filter(Boolean).join('<br>');
    let banner = '';
    if (!rOnline()) {
      banner = readinessNeverSynced()
        ? '<div class="banner show" role="status">正在读取控制台状态：拿到第一份状态快照前不做任何判断。</div>'
        : '<div class="banner offline show" role="alert">控制台离线：向导不会读取或写入客户端配置，也不会把读不到的状态显示成「未配置」。</div>';
    } else if (readinessState.inspectError) {
      banner = `<div class="banner offline show" role="alert" id="readiness-inspect-error" tabindex="-1"><div><strong>检查失败，不能当作未配置。</strong><div>${rEsc(readinessState.inspectError)}</div></div></div>`;
    } else {
      const blocked = readinessBlockedReason();
      if (blocked) banner = `<div class="banner offline show" role="alert"><div><strong>写入已停用。</strong><div>${rEsc(blocked)}</div></div></div>`;
    }
    const pending = rOnline() && !readinessState.inspect && !readinessState.inspectError
      ? '<p class="hint readiness-path">尚未完成客户端检查：检查结束前写入与撤销保持禁用。</p>'
      : '';
    const denied = info.binary?.found === true && info.binary.executable === false
      ? `<p class="hint readiness-path">可执行文件存在但没有执行权限${info.binary.error ? '（' + rEsc(info.binary.error) + '）' : ''}：修正权限后重新检查，不要按「未安装」重装。</p>`
      : '';
    const fallback = info.binary && info.binary.found === false ? readinessFallbackHtml() : '';
    return `<div class="readiness-badges">${bits}${retry}</div>
      ${pathLine ? `<p class="hint mono readiness-path">${pathLine}</p>` : ''}
      ${pending}${denied}
      ${banner}${fallback}`;
  }

  function readinessConnectionParams() {
    const s = rState();
    const r = s?.router || {};
    const app = readinessState.app;
    const base = app === 'zcode' ? (r.zcode_base || r.url || '') : app === 'claude' ? (r.claude_base || r.url || '') : (r.codex_base || r.url || '');
    // 客户端侧协议是固定的,上游协议由渠道决定 —— 参数里只写客户端真正要填的那几项。
    const clientWire = R_CLIENT_WIRE_LABEL[readinessClientWire()] || readinessClientWire();
    const upstream = readinessSelectedProvider()?.wire_api || '';
    const model = readinessState.model || 'mixr-main';
    const lines = app === 'claude'
      ? [`ANTHROPIC_BASE_URL=${base || '（路由地址未提供）'}`, 'ANTHROPIC_AUTH_TOKEN=<本机路由令牌，界面不显示明文>', `ANTHROPIC_MODEL=${model}`]
      : app === 'codex'
        ? [`base_url = ${base || '（路由地址未提供）'}`, `wire_api = ${upstream || '由渠道决定'}`, `model = ${model}`]
        : [`base_url: ${base || '（路由地址未提供）'}`, `客户端协议: ${clientWire}`, `模型: ${model}（ZCode 没有槽位表）`];
    return `客户端：${R_APPS[app].label}（未检测到可执行文件）\n配置文件：${R_APPS[app].cfg}\n${lines.join('\n')}`;
  }
  function readinessFallbackHtml() {
    return `<details class="readiness-fallback" id="readiness-fallback">
      <summary>没检测到客户端时：手动接入参数</summary>
      <p class="hint">这些参数只用于手动填写客户端配置；向导仍可在配置层写入，但不会替你安装客户端。令牌明文不在本页显示。</p>
      <pre class="readiness-copy" id="readiness-copy-text">${rEsc(readinessConnectionParams())}</pre>
      <div class="savebar"><button class="small" type="button" id="readiness-copy-params" onclick="readinessCopyParams()">复制接入参数</button><span class="msg" id="readiness-copy-status" role="status"></span></div>
    </details>`;
  }

  function readinessCopyParams() {
    const text = readinessConnectionParams();
    const done = ok => {
      const el = rEl('readiness-copy-status');
      if (el) el.textContent = ok ? '参数已复制。令牌明文未包含在内。' : '复制不可用，请手动选择上面的参数。';
    };
    try {
      if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
        return;
      }
    } catch { /* 落到下面的兜底 */ }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(area);
      done(!!ok);
    } catch { done(false); }
  }

  // ---------------------------------------------------------------- 渲染:渠道与导入

  function readinessProviderHtml() {
    const list = readinessProviders();
    const p = readinessSelectedProvider();
    const opts = list.length
      ? list.map(item => `<option value="${rEsc(item.id)}" ${item.id === readinessState.providerId ? 'selected' : ''}>${rEsc(item.name)}${item.enabled === false ? '（停用）' : ''}</option>`).join('')
      : '<option value="">（还没有渠道）</option>';
    const hint = p
      ? `${rEsc(p.base_url || '地址未提供')} · ${(p.models || (p.model ? [p.model] : [])).length} 个模型${p.enabled === false ? ' · 已停用，写入前需启用' : ''}`
      : (list.length ? '选择一个渠道，或新建 / 粘贴导入。' : '渠道库为空：先新建渠道，或粘贴一份 JSON 导入。');
    const importBox = readinessState.importOpen ? readinessImportHtml() : '';
    return `<section class="readiness-step" aria-labelledby="readiness-step-provider">
      <h3 id="readiness-step-provider"><span class="readiness-step-no" aria-hidden="true">2</span>渠道</h3>
      <div class="readiness-row">
        <label class="field readiness-grow">渠道<select id="readiness-provider-select" onchange="readinessPickProvider(this.value)" ${list.length ? '' : 'disabled'}>${opts}</select></label>
        <button class="small" type="button" id="readiness-new-provider" onclick="readinessNewProvider()" ${!rOnline() ? 'disabled' : ''}>新建渠道…</button>
        <button class="small" type="button" id="readiness-import-toggle" onclick="readinessToggleImport()" aria-expanded="${readinessState.importOpen ? 'true' : 'false'}">粘贴导入${readinessState.importOpen ? '（收起）' : ''}</button>
      </div>
      <p class="hint" id="readiness-provider-hint">${hint}</p>
      ${importBox}
    </section>`;
  }

  function readinessImportHtml() {
    return `<div class="readiness-import" id="readiness-import-box">
      <label class="field" for="readiness-import-text">粘贴 JSON（mixrouter 导出或 cc-switch 渠道导出）</label>
      <textarea id="readiness-import-text" rows="6" spellcheck="false" autocapitalize="off" autocomplete="off" oninput="readinessSetImportText(this.value)" placeholder='例如 {"providers": [...]}'>${rEsc(readinessState.importText)}</textarea>
      <p class="hint">先在本地解析再发预览；预览只返回脱敏的渠道摘要，不显示 Key 明文。看到摘要后才会出现「确认导入」。</p>
      <div class="savebar">
        <button class="small" type="button" id="readiness-import-preview" onclick="readinessImportPreview()" ${!rOnline() || readinessState.busy === 'import' ? 'disabled' : ''}>${readinessState.busy === 'import' ? '解析中…' : '解析并预览'}</button>
        <button class="primary" type="button" id="readiness-import-apply" onclick="readinessImportApply()" disabled>确认导入</button>
        <label class="chk readiness-inline-check" for="readiness-import-confirm"><input type="checkbox" id="readiness-import-confirm" onchange="readinessSyncButtons()">我确认把这些渠道合并进渠道库</label>
        <span class="msg" id="readiness-import-status" role="status" tabindex="-1">${rEsc(readinessState.importError || '')}</span>
      </div>
      ${readinessImportResultHtml()}
    </div>`;
  }

  function readinessExistingIds() {
    const s = rState();
    const ids = new Set();
    for (const group of ['claude', 'codex']) for (const p of (s?.providers?.[group] || [])) ids.add(group + '/' + p.id);
    return ids;
  }

  function readinessImportResultHtml() {
    const p = readinessState.importPreview;
    if (!p) return '';
    const errors = rList(p.errors).map(item => {
      if (!rIsObj(item)) return rText(item);
      const where = item.where || (item.index == null ? '' : `第 ${Number(item.index) + 1} 项`);
      return [where, item.name, item.message].filter(Boolean).join(' · ');
    }).filter(Boolean);
    const warnings = readinessWarningList(p.warnings);
    const providers = rList(p.providers);
    const summary = p.summary;
    const fresh = rIsObj(summary) && rIsObj(summary.new) ? Number(summary.new.claude || 0) + Number(summary.new.codex || 0) : null;
    const rows = readinessSummaryRows(summary);
    const existing = readinessExistingIds();
    // 导入预览回的是**合并后的整个渠道库**(不是"本次导入的这些")。所以要逐条标出新增/已存在,
    // 否则用户会以为库里多了这么多条,或者以为预览在自作主张合并别的渠道。
    const items = providers.map(item => {
      if (!rIsObj(item)) return `<li class="readiness-import-item">${rEsc(rText(item))}</li>`;
      const group = item.app === 'codex' ? 'codex' : 'claude';
      const isNew = !existing.has(group + '/' + item.id);
      const models = rList(item.models).length ? item.models.map(rText) : (item.model ? [rText(item.model)] : []);
      const masked = item.key_masked || item.masked_key || (rList(item.keys).map(k => (rIsObj(k) ? (k.key_masked || k.masked || '') : '')).filter(Boolean).join('、'));
      return `<li class="readiness-import-item">
        <b>${rEsc(item.name || item.id || '未命名渠道')}</b>
        <span class="badge info">${rEsc(group === 'codex' ? 'Codex' : 'Claude')}</span>
        <span class="mono">${rEsc(item.base_url || item.baseUrl || '')}</span>
        <span class="hint">${models.length ? rEsc(models.slice(0, 4).join(' / ')) + (models.length > 4 ? ' 等' : '') : '模型未提供'}</span>
        <span class="mono">${rEsc(masked || 'Key 未提供或已脱敏')}</span>
        <span class="badge ${isNew ? 'on' : 'off'}">${isNew ? '新增' : '已在库里'}</span>
      </li>`;
    }).join('');
    const title = fresh == null
      ? `预览：合并后渠道库共 ${providers.length} 个渠道，尚未写入`
      : `预览：本次新增 ${fresh} 个；合并后共 ${providers.length} 个渠道，尚未写入`;
    return `<div class="readiness-result" id="readiness-import-result">
      <p class="readiness-result-title">${rEsc(title)}</p>
      ${rows ? `<dl class="readiness-facts">${rows}</dl>` : ''}
      ${errors.length ? `<ul class="readiness-warnings err">${errors.map(e => `<li>${rEsc(e)}</li>`).join('')}</ul>` : ''}
      ${warnings.length ? `<ul class="readiness-warnings">${warnings.map(w => `<li>${rEsc(w)}</li>`).join('')}</ul>` : ''}
      ${items ? `<ul class="readiness-import-list">${items}</ul>` : '<p class="hint">预览里没有可导入的渠道。</p>'}
    </div>`;
  }

  function readinessSummaryRows(summary) {
    if (summary == null) return '';
    if (typeof summary === 'string') return `<div><dt>摘要</dt><dd>${rEsc(summary)}</dd></div>`;
    if (Array.isArray(summary)) return summary.map(item => `<div><dt>摘要</dt><dd>${rEsc(rText(item))}</dd></div>`).join('');
    if (!rIsObj(summary)) return '';
    return Object.entries(summary).map(([key, value]) => `<div><dt>${rEsc(key)}</dt><dd>${rEsc(rText(value))}</dd></div>`).join('');
  }

  // ---------------------------------------------------------------- 渲染:模型与主槽

  // 写入槽位这一步不是"可选的顺手活儿":Codex 的 slots 写入要求 main 与 reviewer 都有可用槽,
  // Claude 只配 main 时其余槽不会有别名(会保留真实模型名或清掉过期 mixr-*)。所以这里把
  // 每个客户端真正需要的槽位逐个列出来,并按用户点的那一下去配 —— 不承诺"配了 main 就通了"。
  const R_SLOT_NAMES = { claude: ['main', 'opus', 'sonnet', 'haiku', 'subagent'], codex: ['main', 'reviewer'] };
  const R_SLOT_LABEL = { main: 'main 主模型', reviewer: 'reviewer 审查模型', opus: 'opus 槽', sonnet: 'sonnet 槽', haiku: 'haiku 槽', subagent: 'subagent 槽' };

  function readinessSlotsFor(app) { return (readinessSlots()[app] || []); }
  function readinessSlotState(app, name) {
    const slot = readinessSlotsFor(app).find(s => s.name === name) || null;
    if (!slot || !slot.provider) return { slot, configured: false, text: '未配置' };
    return {
      slot,
      configured: true,
      text: `${slot.provider_name || slot.provider} @ ${slot.model || '渠道第一个模型'}`,
    };
  }
  // 缺哪些"可转发"的槽位:Claude 只把 main 当必需(其余未配置时保留真实模型名,不写别名);
  // Codex 两个都是必需项 —— 少一个 switchCodexRouter 会直接拒绝。
  function readinessMissingSlots(app) {
    const need = app === 'codex' ? ['main', 'reviewer'] : ['main'];
    return need.filter(name => !readinessSlotState(app, name).configured);
  }

  function readinessSlotSetupHtml(p) {
    const app = readinessState.app;
    if (app === 'zcode') {
      return '<p class="hint">ZCode 没有槽位表；接入时按所选协议写入 ZCode 自己的 provider 字段，不改 Claude / Codex 槽位。</p>';
    }
    const names = R_SLOT_NAMES[app] || ['main'];
    const can = !!p && readinessCanWrite();
    const rows = names.map(name => {
      const state = readinessSlotState(app, name);
      const required = readinessMissingSlots(app).includes(name) || (app === 'codex');
      return `<li class="readiness-slot-row" id="readiness-slot-row-${app}-${name}">
        <span class="readiness-slot-name">${rEsc(R_SLOT_LABEL[name] || name)}</span>
        <span class="badge ${state.configured ? 'on' : (required ? 'drift' : 'off')}">${state.configured ? '已配置' : '未配置'}</span>
        <span class="mono readiness-slot-target">${rEsc(state.text)}</span>
      </li>`;
    }).join('');
    const status = readinessState.slotSetup || null;
    // Claude:主槽必配;其余四个是"要不要一起挂到这个渠道"。Codex:两个一起配,否则写入只能退回
    // 纯路由且 reviewer 仍是旧值 —— 这正是"只配 main 却承诺接通"的坑。
    const actions = app === 'codex'
      ? `<button class="small" type="button" id="readiness-set-main" onclick="readinessSetMain()" ${can ? '' : 'disabled'}>把 main 设为该渠道</button>
         <button class="small primary" type="button" id="readiness-set-main-both" onclick="readinessSetSlots('codex')" ${can ? '' : 'disabled'}>把 main 与 reviewer 都设为该渠道</button>`
      : `<button class="small" type="button" id="readiness-set-main" onclick="readinessSetMain()" ${can ? '' : 'disabled'}>只设为主槽 main</button>
         <button class="small primary" type="button" id="readiness-set-main-both" onclick="readinessSetSlots('claude')" ${can ? '' : 'disabled'}>把全部槽位都设为该渠道</button>`;
    const explain = app === 'codex'
      ? 'Codex 写入槽位别名时要求 main 与 reviewer 都有可用槽；只配 main，写入就会退回「只写路由地址」，不会自动补 reviewer。'
      : '只配 main 时，其余槽位不写别名：原本手设的真实模型名会保留，过期的 mixr-* 会被清掉；这些请求会按路由规则分发，而不是按槽位落点。';
    return `<div class="readiness-slots" id="readiness-slot-setup">
      <p class="readiness-section-label">槽位（${app === 'codex' ? '两个都要' : 'main 必需'}）</p>
      <ul class="readiness-slot-list">${rows}</ul>
      <p class="hint">${rEsc(explain)}</p>
      <div class="savebar">${actions}<span class="msg" id="readiness-main-status" role="status">${rEsc(status?.text || '')}</span></div>
    </div>`;
  }

  function readinessModelHtml() {
    const p = readinessSelectedProvider();
    const list = p ? (readinessGroup() === 'codex' ? [p.model].filter(Boolean) : (p.models || [])) : [];
    const keys = p?.keys || [];
    const wireChoices = R_APPS[readinessState.app].wires;
    const wireOptions = wireChoices
      ? wireChoices.map(w => `<option value="${rEsc(w)}" ${w === readinessState.zcodeWire ? 'selected' : ''}>${rEsc(R_WIRE_LABEL[w] || w)}</option>`).join('')
      : '';
    const keyOptions = ['<option value="">跟随渠道当前 Key</option>']
      .concat(keys.map(k => `<option value="${rEsc(k.id)}" ${k.id === readinessState.keyId ? 'selected' : ''}>${rEsc(k.label || k.id)}${k.key_masked ? ' · ' + rEsc(k.key_masked) : ''}${k.enabled === false ? '（已停用）' : ''}</option>`))
      .join('');
    const datalist = [...new Set(list.map(rText).filter(Boolean))]
      .map(m => `<option value="${rEsc(m)}"></option>`).join('');
    const slotBlock = readinessSlotSetupHtml(p);
    return `<section class="readiness-step" aria-labelledby="readiness-step-model">
      <h3 id="readiness-step-model"><span class="readiness-step-no" aria-hidden="true">3</span>模型与主槽</h3>
      ${p ? '' : '<p class="hint">先选择或创建一个渠道。</p>'}
      <div class="readiness-row">
        <label class="field readiness-grow">模型<input type="text" id="readiness-model-input" list="readiness-model-options" value="${rEsc(readinessState.model)}" placeholder="模型名，可带 [1M] 后缀" spellcheck="false" autocomplete="off" oninput="readinessSetModel(this.value)" onchange="readinessRender()" ${p ? '' : 'disabled'}><datalist id="readiness-model-options">${datalist}</datalist></label>
        ${wireChoices
          ? `<label class="field">客户端协议<select id="readiness-wire-select" onchange="readinessPickWire(this.value)">${wireOptions}</select></label>`
          : `<div class="field"><span>客户端协议</span><b class="readiness-fixed" id="readiness-wire-fixed">${rEsc(R_CLIENT_WIRE_LABEL[R_APPS[readinessState.app].clientWire])}（固定）</b></div>`}
        <label class="field">Key<select id="readiness-key-select" onchange="readinessSetKey(this.value);readinessRender()" ${keys.length ? '' : 'disabled'}>${keyOptions}</select></label>
      </div>
      <p class="hint">${rEsc(R_APPS[readinessState.app].note)} 渠道在库里的 wire_api 不因这里的选择被修改；写入时以预览列出的字段为准。</p>
      ${slotBlock}
    </section>`;
  }

  // ---------------------------------------------------------------- 渲染:兼容测试

  function readinessTestHtml() {
    const p = readinessSelectedProvider();
    const result = readinessState.test;
    const checks = rList(result?.checks);
    const rows = checks.map(check => {
      if (!rIsObj(check)) return `<li class="readiness-check"><span class="badge off">结果</span><span>${rEsc(rText(check))}</span></li>`;
      const status = String(check.status || '').toLowerCase();
      const cls = ['ok', 'pass', 'green'].includes(status) ? 'on' : ['fail', 'error', 'red'].includes(status) ? 'drift' : 'off';
      const label = R_STATUS_LABEL[status] || check.status || '未标注';
      return `<li class="readiness-check"><span class="badge ${cls}">${rEsc(label)}</span><span class="readiness-check-id mono">${rEsc(check.id || check.code || '检查')}</span><span class="readiness-check-msg">${rEsc(check.message || check.code || '')}</span><span class="readiness-check-ms mono">${check.ms == null ? '' : rEsc(String(check.ms) + 'ms')}</span></li>`;
    }).join('');
    const verified = result ? (result.ok === true ? '<span class="badge on">本次通过</span>' : result.ok === false ? '<span class="badge drift">本次未通过</span>' : '<span class="badge off">服务端未标注总体结果</span>') : '';
    const checkedAt = result?.checked_at ? new Date(result.checked_at) : null;
    const checkedText = result?.checked_at
      ? (checkedAt && !Number.isNaN(checkedAt.getTime()) ? checkedAt.toLocaleString('zh-CN', { hour12: false }) : String(result.checked_at))
      : '未提供';
    // scope 是对象:{app, client_wire, wire_api, model, key_id}。逐项拼成一行,别把 JSON 怼给用户。
    const scopeBits = rIsObj(result?.scope)
      ? [result.scope.client_wire && `协议 ${result.scope.client_wire}`, result.scope.wire_api && `上游 ${result.scope.wire_api}`,
        result.scope.model && `模型 ${result.scope.model}`, result.scope.key_id && `Key ${result.scope.key_id}`].filter(Boolean)
      : [];
    const scopeText = result ? (rIsObj(result.scope) ? (scopeBits.join(' · ') || '未提供') : (result.scope == null ? '未提供' : rText(result.scope))) : '未提供';
    const msText = result?.ms == null ? '未提供' : `${result.ms}ms`;
    const resultBlock = readinessState.testError
      ? `<div class="banner offline show" role="alert" id="readiness-test-error" tabindex="-1">兼容测试未运行或失败：${rEsc(readinessState.testError)}</div>`
      : result
        ? `<div class="readiness-result" id="readiness-test-result">
            <p class="readiness-result-title">${verified} <span class="hint">检查时间 ${rEsc(checkedText)} · 范围 ${rEsc(scopeText)} · 总耗时 ${rEsc(msText)}</span></p>
            ${rows ? `<ul class="readiness-checks">${rows}</ul>` : '<p class="hint">服务端没有返回检查项；这不等于通过。</p>'}
            ${readinessWarningList(result.warnings).length ? `<ul class="readiness-warnings">${readinessWarningList(result.warnings).map(w => `<li>${rEsc(w)}</li>`).join('')}</ul>` : ''}
            <p class="hint">这是 ${rEsc(readinessState.model || '所选模型')} 在 ${rEsc(p?.name || '所选渠道')} 上的一次测试（最多 3 次上游请求：生成 / 流式 / 工具调用），只代表这一时刻；不是持续健康，也不代表其他模型、Key、图片或工具能力。</p>
          </div>`
        : '<p class="hint" id="readiness-test-result">尚未运行兼容测试。</p>';
    return `<section class="readiness-step" aria-labelledby="readiness-step-test">
      <h3 id="readiness-step-test"><span class="readiness-step-no" aria-hidden="true">4</span>兼容测试</h3>
      <p class="hint">最多会向所选渠道发 3 次真实请求（生成、流式、工具调用各一次），会消耗额度。只测所选的模型、Key 与客户端协议。三项检查按顺序都跑；只有总时限用尽时才跳过剩下的检查，超时或出错的项会单独标出来。</p>
      <label class="chk readiness-inline-check" for="readiness-test-ack"><input type="checkbox" id="readiness-test-ack" onchange="readinessSyncButtons()" ${p ? '' : 'disabled'}>我知道这会消耗额度，并同意运行兼容测试（最多 3 次上游请求）</label>
      <div class="savebar"><button class="small" type="button" id="readiness-test-btn" onclick="readinessRunTest()" disabled>${readinessState.busy === 'test' ? '测试中…' : '运行兼容测试'}</button><span class="msg" id="readiness-test-status" role="status">${readinessState.busy === 'test' ? '正在向上游发请求（最多 3 次）…' : ''}</span></div>
      ${resultBlock}
    </section>`;
  }

  // ---------------------------------------------------------------- 渲染:写入与撤销

  function readinessWriteHtml() {
    const p = readinessSelectedProvider();
    const changes = readinessState.preview;
    const token = changes?.token;
    const blocked = readinessBlockedReason();
    const previewBlock = readinessState.previewError
      ? `<div class="banner offline show" role="alert" id="readiness-write-error" tabindex="-1">写入预览失败：${rEsc(readinessState.previewError)}</div>`
      : changes
        ? `<div class="readiness-result" id="readiness-preview-result">
            <p class="readiness-result-title">写入预览：尚未改动任何文件</p>
            ${readinessChangesHtml(changes.changes, '预览没有列出受管字段差异；这不表示不会写入，先检查服务端返回。')}
            ${readinessWarningList(changes.warnings).length ? `<ul class="readiness-warnings">${readinessWarningList(changes.warnings).map(w => `<li>${rEsc(w)}</li>`).join('')}</ul>` : ''}
            <p class="hint">预览令牌由服务端一次性签发；确认写入后立即作废。原文件会按现有逻辑自动备份。</p>
          </div>`
        : '<p class="hint" id="readiness-preview-result">预览只读取计划，不写客户端配置。</p>';
    const appliedRow = readinessState.applyResult
      ? (readinessState.applyResult.changed ?? readinessState.applyResult.changes)
      : null;
    const appliedListed = appliedRow != null;
    const applied = readinessState.applyResult
      ? `<div class="readiness-result" id="readiness-apply-result" role="status" aria-live="polite">
          <p class="readiness-result-title"><span class="badge on">已确认写入</span> ${appliedListed && !rList(appliedRow).length ? '配置已是最新，没有字段需要改动' : '受管字段已按预览落盘'}</p>
          ${readinessChangesHtml(appliedRow, '服务端没有回传写入后的字段清单；这不等于没有改动，请用撤销预览核对受管字段。', '本次没有字段差异，客户端配置保持原样。')}
          ${readinessState.applyResult.ledger_saved === false ? '<p class="hint">服务端没有记录撤销账本（本次没有受管字段差异），所以撤销入口不会还原任何字段。' : ''}
          ${readinessWarningList(readinessState.applyWarnings).length ? `<ul class="readiness-warnings">${readinessWarningList(readinessState.applyWarnings).map(w => `<li>${rEsc(w)}</li>`).join('')}</ul>` : ''}
          <p class="hint">${readinessState.app === 'claude'
            ? 'Claude Code 需重启会话生效。'
            : readinessState.app === 'codex'
              ? 'Codex 需重启生效。'
              : `写入只改了 ZCode 的接入配置，不会切换你正在用的会话：请在 ZCode 的模型选择器里选择 Mixrouter${readinessState.model ? ' · ' + rEsc(readinessState.model) : ''}（必要时重启客户端），再开新会话。`} 如要回退，使用下面的撤销入口。</p>
        </div>`
      : readinessState.applyError
        ? `<div class="banner offline show" role="alert" id="readiness-apply-error" tabindex="-1">写入失败：${rEsc(readinessState.applyError)}</div>`
        : '';
    return `<section class="readiness-step" aria-labelledby="readiness-step-write">
      <h3 id="readiness-step-write"><span class="readiness-step-no" aria-hidden="true">5</span>写入客户端</h3>
      <p class="hint">${blocked ? rEsc(blocked) : '先预览将要改动的字段，再显式确认。向导不会把「读不到配置」当作「未配置」，也不会在没有预览令牌时写入。'}</p>
      <p class="hint" id="readiness-write-mode"><b>这次会写：</b>${rEsc(readinessWriteMode().note)}</p>
      <div class="savebar"><button class="small" type="button" id="readiness-preview-btn" onclick="readinessPreviewWrite()" disabled>${readinessState.busy === 'preview' ? '读取预览…' : '预览将写入的字段'}</button><span class="msg" id="readiness-preview-status" role="status">${rEsc(readinessState.previewError || '')}</span></div>
      ${previewBlock}
      <label class="chk readiness-inline-check" for="readiness-write-confirm"><input type="checkbox" id="readiness-write-confirm" onchange="readinessSyncButtons()" ${token ? '' : 'disabled'}>我确认按上面的预览写入客户端配置</label>
      <div class="savebar"><button class="primary" type="button" id="readiness-apply-btn" onclick="readinessApplyWrite()" disabled>${readinessState.busy === 'apply' ? '写入中…' : '确认写入客户端'}</button><span class="msg" id="readiness-apply-status" role="status">${readinessState.busy === 'apply' ? '正在写入，等待服务端返回…' : (p ? '' : '先选择渠道。')}</span></div>
      ${applied}
    </section>`;
  }

  // 撤销预览的真实形状:{ok, can_undo, token, expires_at, changes[{field,current,restore}], conflicts[{field,current,expected,restore}], config}
  // can_undo=false 时 token 是 null —— 这不是"接口没返回令牌",而是账本对不上,必须当成阻断原因说出来。
  function readinessUndoHtml() {
    const u = readinessState.undo;
    const token = u?.token;
    const blocked = readinessBlockedReason();
    const rows = readinessChangeRows(u?.changes);
    const managed = [...new Set(rows.map(row => row.field).filter(Boolean))];
    const conflicts = readinessConflictRows(u?.conflicts);
    const canUndo = u ? (u.can_undo !== false && !!token) : false;
    const preview = readinessState.undoError
      ? `<div class="banner offline show" role="alert" id="readiness-undo-error" tabindex="-1">撤销预览失败：${rEsc(readinessState.undoError)}</div>`
      : u
        ? `<div class="readiness-result" id="readiness-undo-result">
            <p class="readiness-result-title">${canUndo ? '<span class="badge info">可以撤销</span>' : '<span class="badge drift">撤销已阻断</span>'} <span class="hint">预览：尚未改动任何文件</span></p>
            <p class="readiness-section-label">受管字段（${managed.length}）：撤销只把这些字段还原成写入前的值</p>
            ${readinessChangesHtml(rows.map(row => ({ field: row.field, current: row.before, restore: row.after, secret: row.secret })), '账本里没有受管字段，撤销不会改动任何内容。')}
            ${conflicts.length ? `<div><p class="readiness-section-label">冲突（受管字段已不是写入后的值）</p>${readinessConflictsHtml(u.conflicts)}<p class="hint">${canUndo ? '这些字段不在本次还原范围内，或者需要你先核对。' : '冲突时服务端不签发撤销令牌：撤销不会覆盖这些字段。先手动核对，或用完整备份恢复（那是另一条独立路径）。'}</p></div>` : ''}
            ${readinessWarningList(u.warnings).length ? `<ul class="readiness-warnings">${readinessWarningList(u.warnings).map(w => `<li>${rEsc(w)}</li>`).join('')}</ul>` : ''}
            <p class="hint">撤销只还原这次接入管理的字段，不做整文件覆盖；其他字段与其他客户端的配置保持不动。完整备份恢复不在本向导里。</p>
          </div>`
        : `<p class="hint" id="readiness-undo-result">${blocked ? rEsc(blocked) : '撤销入口会先读取服务端保存的受管字段账本，再让你确认。'}</p>`;
    const done = readinessState.undoResult
      ? `<div class="readiness-result" role="status" aria-live="polite"><p class="readiness-result-title"><span class="badge on">已撤销</span> 受管字段已还原</p>${readinessWarningList(readinessState.undoResult.warnings).map(w => `<p class="hint">${rEsc(w)}</p>`).join('')}</div>`
      : '';
    return `<section class="readiness-step readiness-undo" aria-labelledby="readiness-step-undo">
      <h3 id="readiness-step-undo"><span class="readiness-step-no" aria-hidden="true">6</span>撤销上次写入</h3>
      <p class="hint">适用于本向导写入过的客户端配置。先预览受管字段与冲突，再显式确认；不会还原完整备份，也不碰其他工具改过的字段。</p>
      <div class="savebar"><button class="small" type="button" id="readiness-undo-preview" onclick="readinessUndoPreview()" ${!readinessCanWrite() ? 'disabled' : ''}>${readinessState.busy === 'undo-preview' ? '读取撤销预览…' : '检查撤销影响'}</button><span class="msg" id="readiness-undo-status" role="status">${rEsc(readinessState.undoError || '')}</span></div>
      ${preview}
      <label class="chk readiness-inline-check" for="readiness-undo-confirm"><input type="checkbox" id="readiness-undo-confirm" onchange="readinessSyncButtons()" ${canUndo ? '' : 'disabled'}>我确认只还原本向导管理的字段</label>
      <div class="savebar"><button class="danger" type="button" id="readiness-undo-btn" onclick="readinessUndoApply()" disabled>${readinessState.busy === 'undo' ? '撤销中…' : '确认撤销'}</button><span class="msg" id="readiness-undo-apply-status" role="status">${readinessState.busy === 'undo' ? '正在还原受管字段…' : ''}</span></div>
      ${done}
    </section>`;
  }

  // ---------------------------------------------------------------- 变动/警告渲染

  function readinessWarningList(value) {
    return rList(value).map(item => {
      if (typeof item === 'string') return item;
      if (typeof item === 'number' || typeof item === 'boolean') return String(item);
      if (rIsObj(item)) {
        const code = item.code || item.id || '';
        const message = item.message || item.text || item.detail || '';
        return [code, message].filter(Boolean).join('：') || rText(item);
      }
      return rText(item);
    }).filter(Boolean);
  }

  function readinessChangeRows(value) {
    let list = value;
    if (rIsObj(list)) list = Object.entries(list).map(([key, item]) => (rIsObj(item) ? { field: key, ...item } : { field: key, after: item }));
    if (typeof list === 'string') list = [{ field: '变更', after: list }];
    if (!Array.isArray(list)) list = list == null ? [] : [list];
    return list.map(item => {
      if (!rIsObj(item)) return { field: '变更', before: '', after: rText(item), note: '', secret: false };
      const field = item.field || item.path || item.key || item.name || item.id || item.label || '字段';
      const before = item.before ?? item.from ?? item.old ?? item.previous ?? item.current;
      // after / restore 是不同接口的叫法:apply 预览用 after,撤销预览用 restore(要还原成的值)。
      const after = item.after ?? item.to ?? item.new ?? item.next ?? item.restore ?? item.value;
      const absent = item.before_absent ? '' : (item.after_absent && after == null ? '（将删除）' : '');
      return {
        field: rText(field),
        before: item.before_absent ? '' : rText(before),
        after: absent || rText(after),
        note: item.note || item.message || '',
        secret: item.secret === true,
      };
    });
  }

  // 撤销预览的冲突:每个字段写清「现在是什么」与「账本期望是什么」,不替用户猜哪个才对。
  function readinessConflictRows(value) {
    return rList(value).map(item => {
      if (!rIsObj(item)) return { field: '', current: rText(item), expected: '' };
      return {
        field: rText(item.field || item.path || '(文件)'),
        current: item.current == null ? '（不存在）' : rText(item.current),
        expected: item.expected == null ? '（不存在）' : rText(item.expected),
      };
    });
  }

  function readinessConflictsHtml(value) {
    const rows = readinessConflictRows(value).filter(row => row.field || row.current || row.expected);
    if (!rows.length) return '';
    return `<ul class="readiness-changes readiness-conflicts">${rows.map(row => `<li>
      <span class="readiness-change-field">${rEsc(row.field)}</span>
      <span class="hint">当前</span><span class="readiness-change-before mono">${rEsc(row.current)}</span>
      <span class="hint">账本期望</span><span class="readiness-change-after mono">${rEsc(row.expected)}</span>
    </li>`).join('')}</ul>`;
  }

  function readinessChangesHtml(value, emptyText, emptyListedText) {
    const rows = readinessChangeRows(value);
    // 空数组 = 服务端确实回了清单，只是没有差异；null/缺字段 = 根本没回。两句话不能混。
    if (!rows.length) return `<p class="hint">${rEsc(Array.isArray(value) && emptyListedText ? emptyListedText : emptyText)}</p>`;
    return `<ul class="readiness-changes">${rows.map(row => `<li>
      <span class="readiness-change-field">${rEsc(row.field)}</span>
      <span class="readiness-change-before mono">${rEsc(row.before || '（空）')}</span>
      <span class="readiness-change-arrow" aria-hidden="true">→</span>
      <span class="readiness-change-after mono">${rEsc(row.after || '（空）')}</span>
      ${row.secret ? '<span class="badge off" title="服务端只回传掩码，预览里看不到完整密钥">已脱敏</span>' : ''}
      ${row.note ? `<span class="hint">${rEsc(row.note)}</span>` : ''}
    </li>`).join('')}</ul>`;
  }

  // ---------------------------------------------------------------- 渲染总入口

  function readinessRender() {
    const body = rEl('readiness-body');
    if (!body) return;
    readinessSyncClients();
    const focusId = readinessState.focusAfter;
    readinessState.focusAfter = '';
    body.innerHTML = readinessInspectHtml() + readinessProviderHtml() + readinessModelHtml()
      + readinessTestHtml() + readinessWriteHtml() + readinessUndoHtml();
    readinessSyncButtons();
    if (focusId) { const el = rEl(focusId); if (el?.focus) el.focus(); }
    const status = rEl('readiness-status');
    if (status) status.textContent = readinessState.entryStatus || '';
    readinessSyncEntry();
  }

  function readinessSyncClients() {
    for (const app of readinessApps()) {
      const el = rEl('readiness-client-' + app);
      if (!el) continue;
      const on = app === readinessState.app;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      el.tabIndex = on ? 0 : -1;
    }
  }

  // 首帧时 /api/state 还没回来,online 仍是 false。这时候说「离线」是假话 —— 用 lastSync
  // 区分「从未连上过」与「连过又断了」。
  function readinessNeverSynced() {
    if (typeof lastSync === 'undefined') return false;
    return !lastSync;
  }

  function readinessSyncEntry() {
    // 报告面板的可用性也跟着连接状态走(readinessRenderPools 每轮 refresh 都会到这里);
    // 只在挂载时算一次的话,首帧离线就再也不会恢复成可点。
    readinessSyncReport();
    // 弹窗打开着而渠道表是后到的(离线打开、重连后才读到 state,或渠道刚被删):
    // 选中项要跟着渠道库收敛,否则第 3 步以后一直是禁用状态,看着像坏了。
    if (readinessState.open) {
      const list = readinessProviders();
      const known = readinessState.providerId && list.some(p => p.id === readinessState.providerId);
      if (!known && (list.length || readinessState.providerId)) {
        readinessPickProvider(list.length ? list[0].id : '', { render: false });
        readinessRender();
        return;
      }
    }
    // 重连后补一次检查:只针对"因为离线根本没发出去"的那种失败,真实读取错误仍要用户自己重试。
    if (readinessState.open && rOnline() && readinessState.inspectError === R_OFFLINE_INSPECT
      && !readinessState.busy && readinessState.inspect == null) {
      readinessInspect();
      return;
    }
    const el = rEl('readiness-entry-status');
    if (!el) return;
    const fallback = !rOnline()
      ? (readinessNeverSynced()
        ? '正在读取控制台状态…（尚未拿到第一份状态快照）'
        : '控制台离线：不会读取或写入客户端配置。')
      : `当前选择：${R_APPS[readinessState.app].label}。没有确认写入之前，向导不会改动任何配置文件。`;
    el.textContent = readinessState.entryStatus || fallback;
  }

  function readinessSyncButtons() {
    const online = rOnline();
    const blocked = !!readinessBlockedReason();
    const p = readinessSelectedProvider();
    const gate = (id, enabled, text) => {
      const el = rEl(id);
      if (!el) return;
      el.disabled = !enabled;
      if (text != null) el.textContent = text;
    };
    gate('readiness-import-preview', online && readinessState.busy !== 'import', readinessState.busy === 'import' ? '解析中…' : '解析并预览');
    gate('readiness-import-apply', online && !!readinessState.importToken
      && !!rEl('readiness-import-confirm')?.checked && readinessState.busy !== 'import');
    gate('readiness-set-main', !!p && readinessCanWrite() && readinessState.busy !== 'main');
    gate('readiness-set-main-both', !!p && readinessCanWrite() && readinessState.busy !== 'main',
      readinessState.app === 'codex' ? '把 main 与 reviewer 都设为该渠道' : '把全部槽位都设为该渠道');
    // 兼容测试只发一次上游请求,不写客户端配置:即使配置读不出来也能测渠道本身。
    gate('readiness-test-btn', !!p && !!readinessState.model && online
      && !!rEl('readiness-test-ack')?.checked && readinessState.busy !== 'test',
      readinessState.busy === 'test' ? '测试中…' : '运行兼容测试');
    gate('readiness-preview-btn', !!p && readinessCanWrite(), readinessState.busy === 'preview' ? '读取预览…' : '预览将写入的字段');
    gate('readiness-apply-btn', !!readinessState.preview?.token && !!rEl('readiness-write-confirm')?.checked
      && readinessCanWrite(), readinessState.busy === 'apply' ? '写入中…' : '确认写入客户端');
    gate('readiness-undo-preview', readinessCanWrite(), readinessState.busy === 'undo-preview' ? '读取撤销预览…' : '检查撤销影响');
    gate('readiness-undo-btn', !!readinessState.undo?.token && !!rEl('readiness-undo-confirm')?.checked
      && readinessCanWrite(), readinessState.busy === 'undo' ? '撤销中…' : '确认撤销');
  }

  // ---------------------------------------------------------------- 动作:客户端与检查

  function readinessSetApp(app) {
    if (!R_APPS[app]) return;
    readinessState.app = app;
    readinessState.zcodeWire = 'anthropic';
    readinessState.providerId = '';
    readinessState.model = '';
    readinessState.keyId = '';
    readinessState.inspect = null;
    readinessState.inspectError = '';
    readinessState.preview = null;
    readinessState.previewError = '';
    readinessState.applyResult = null;
    readinessState.applyWarnings = [];
    readinessState.applyError = '';
    readinessState.test = null;
    readinessState.testError = '';
    readinessState.undo = null;
    readinessState.undoError = '';
    readinessState.undoResult = null;
    readinessState.entryStatus = '';
    const list = readinessProviders();
    if (list.length) readinessPickProvider(list[0].id, { render: false });
  }

  function readinessPickClient(app) {
    if (!R_APPS[app] || app === readinessState.app) return;
    readinessSetApp(app);
    readinessRender();
    readinessInspect();
  }

  async function readinessInspect() {
    if (readinessState.busy === 'inspect') return;
    if (!rOnline()) {
      readinessState.inspect = null;
      readinessState.inspectError = R_OFFLINE_INSPECT;
      readinessRender();
      return;
    }
    readinessState.busy = 'inspect';
    readinessState.inspect = null;
    readinessState.inspectError = '';
    readinessRender();
    try {
      readinessState.inspect = await readinessCall('/api/onboarding/' + encodeURIComponent(readinessState.app));
    } catch (error) {
      readinessState.inspectError = error.message;
      readinessState.focusAfter = 'readiness-inspect-error';
    } finally {
      readinessState.busy = '';
      readinessRender();
    }
  }

  function readinessPickProvider(id, opt = {}) {
    const p = readinessProviders().find(item => item.id === id) || null;
    readinessState.providerId = p ? p.id : '';
    readinessState.model = p ? readinessDefaultModel(p) : '';
    readinessState.keyId = p ? readinessDefaultKey(p) : '';
    if (readinessState.app === 'zcode') readinessState.zcodeWire = readinessDefaultZcodeWire(p);
    readinessState.preview = null;
    readinessState.previewError = '';
    readinessState.applyResult = null;
    readinessState.applyWarnings = [];
    readinessState.applyError = '';
    readinessState.test = null;
    readinessState.testError = '';
    if (opt.render !== false) readinessRender();
  }

  function readinessPickWire(wire) {
    if (readinessState.app !== 'zcode') return;
    if (!R_APPS.zcode.wires.includes(wire)) return;
    readinessState.zcodeWire = wire;
    readinessState.preview = null;
    readinessState.test = null;
    readinessState.testError = '';
    // ZCode 换了协议就等于换了渠道库分组:旧渠道不在新组里时明确清空,不拿另一组的渠道硬测。
    const list = readinessProviders();
    if (!list.some(p => p.id === readinessState.providerId)) {
      if (list.length) readinessPickProvider(list[0].id, { render: false });
      else { readinessState.providerId = ''; readinessState.model = ''; readinessState.keyId = ''; }
    }
    readinessRender();
  }

  function readinessSetModel(value) {
    readinessState.model = String(value || '');
    readinessState.preview = null;
    readinessState.test = null;
    readinessState.testError = '';
    readinessSyncButtons();
  }

  function readinessSetKey(value) {
    readinessState.keyId = String(value || '');
    readinessState.preview = null;
    readinessState.test = null;
    readinessState.testError = '';
  }

  function readinessNewProvider() {
    if (!rOnline()) return rToast('控制台离线，未打开新建渠道', 'err');
    readinessClose();
    if (typeof openProvider === 'function') openProvider();
    readinessState.entryStatus = '新建渠道保存后，回到接入向导继续；向导会自动列出新渠道。';
    readinessSyncEntry();
  }

  async function readinessSetMain() {
    if (readinessState.app === 'zcode') return;
    return readinessSetSlots(readinessState.app, { all: false });
  }

  // 逐个 putSlot:每个槽位单独一次 PUT /api/slots,失败就停在那一步并保留原因(不部分成功还报"已配齐")。
  async function readinessSetSlots(app, { all = true } = {}) {
    const p = readinessSelectedProvider();
    if (!p || app === 'zcode') return;
    if (!readinessCanWrite()) return rToast(readinessBlockedReason() || '当前不能写入', 'err');
    if (typeof putSlot !== 'function') return rToast('槽位接口未就绪', 'err');
    const names = all
      ? (R_SLOT_NAMES[app] || ['main'])
      : ['main'];
    readinessState.busy = 'main';
    readinessState.slotSetup = { text: all ? `正在把 ${names.join(' / ')} 设为该渠道…` : '正在保存主槽…' };
    readinessRender();
    const model = readinessState.model || '';
    const failed = [];
    for (const name of names) {
      const value = app === 'claude' ? { provider: p.id, model } : { provider: p.id };
      // eslint 风格上这里不并行:PUT /api/slots 每次都会重写 slots.json,并发写会互相覆盖。
      const ok = await putSlot(app, name, value);
      if (!ok) { failed.push(name); break; }
    }
    readinessState.busy = '';
    if (failed.length) {
      const reason = rEl('toast')?.textContent || '服务端拒绝';
      readinessState.slotSetup = { text: `槽位保存失败（${failed.join(' / ')}）：${reason}` };
    } else {
      readinessState.slotSetup = {
        text: all
          ? `已把 ${names.join(' / ')} 设为 ${p.name}${app === 'claude' && model ? ' @ ' + model : ''}。`
          : `已设为主槽 main：${p.name}${model ? ' @ ' + model : ''}。`,
      };
      rToast(all ? `槽位已更新：${names.join(' / ')}` : '已设为主槽 main', 'ok');
    }
    await rRefresh();
    readinessRender();
  }

  // ---------------------------------------------------------------- 动作:导入

  function readinessToggleImport() {
    readinessState.importOpen = !readinessState.importOpen;
    readinessRender();
    if (readinessState.importOpen) {
      const text = rEl('readiness-import-text');
      if (text?.focus) text.focus();
    }
  }

  function readinessSetImportText(value) {
    readinessState.importText = String(value ?? '');
  }

  async function readinessImportPreview() {
    if (readinessState.busy === 'import') return;
    const area = rEl('readiness-import-text');
    if (area) readinessState.importText = area.value;
    readinessState.importPreview = null;
    readinessState.importToken = '';
    readinessState.importError = '';
    const text = String(readinessState.importText || '').trim();
    if (!text) {
      readinessState.importError = '先粘贴 JSON 内容';
      readinessRender();
      return;
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (error) {
      readinessState.importError = 'JSON 解析失败：' + error.message;
      readinessRender();
      return;
    }
    if (!rIsObj(parsed) && !Array.isArray(parsed)) {
      readinessState.importError = 'JSON 顶层必须是对象或数组';
      readinessRender();
      return;
    }
    readinessState.busy = 'import';
    readinessRender();
    try {
      const res = await readinessCall('/api/providers/import/preview', {
        method: 'POST',
        body: JSON.stringify({ input: parsed }),
      });
      readinessState.importPreview = rIsObj(res) ? res : { providers: [] };
      readinessState.importToken = readinessState.importPreview.token || '';
      if (!readinessState.importToken) readinessState.importError = '服务端没有返回预览令牌，不能导入。';
    } catch (error) {
      readinessState.importError = error.message;
      readinessState.focusAfter = 'readiness-import-status';
    } finally {
      readinessState.busy = '';
      readinessRender();
    }
  }

  async function readinessImportApply() {
    if (readinessState.busy === 'import') return;
    const token = readinessState.importToken;
    if (!token) { readinessState.importError = '没有预览令牌，先解析并预览'; readinessRender(); return; }
    if (!rEl('readiness-import-confirm')?.checked) return;
    readinessState.busy = 'import';
    readinessRender();
    try {
      await readinessCall('/api/providers/import/apply', {
        method: 'POST',
        body: JSON.stringify({ token, confirm: true }),
      });
      const summary = readinessState.importPreview?.summary;
      const count = rIsObj(summary) && rIsObj(summary.new)
        ? Number(summary.new.claude || 0) + Number(summary.new.codex || 0)
        : null;
      readinessState.importPreview = null;
      readinessState.importToken = '';
      readinessState.importText = '';
      readinessState.importOpen = false;
      readinessState.busy = '';
      await rRefresh();
      // 预览里那句数量是服务端给的合并摘要;拿不到就不编数字,只说明导入已完成。
      readinessState.entryStatus = count == null
        ? '渠道已导入；尚未写入任何客户端配置。'
        : `已导入 ${count} 个新渠道；尚未写入任何客户端配置。`;
      rToast(count == null ? '渠道已导入' : `已导入 ${count} 个新渠道`, 'ok');
    } catch (error) {
      readinessState.importError = error.message;
    } finally {
      readinessState.busy = '';
      readinessRender();
    }
  }

  // ---------------------------------------------------------------- 动作:兼容测试

  async function readinessRunTest() {
    const p = readinessSelectedProvider();
    if (!p || readinessState.busy === 'test') return;
    if (!readinessState.model) return rToast('先填写要测试的模型名', 'err');
    if (!rEl('readiness-test-ack')?.checked) return;
    readinessState.busy = 'test';
    readinessState.test = null;
    readinessState.testError = '';
    readinessRender();
    try {
      const res = await readinessCall(`/api/providers/${encodeURIComponent(p.id)}/compatibility`, {
        method: 'POST',
        body: JSON.stringify({
          // app 决定 client_wire 怎么解释:Codex 的 chat 是「Responses→chat 上游」,
          // ZCode 的 chat 才是「chat 客户端→chat 上游」。缺了 app 服务端只能按渠道分组猜。
          app: readinessState.app,
          model: readinessState.model,
          key_id: readinessState.keyId || undefined,
          client_wire: readinessClientWire(),
          confirm_run: true,
        }),
      }, R_COMPAT_TIMEOUT_MS);
      readinessState.test = rIsObj(res) ? res : { ok: null, checks: [] };
    } catch (error) {
      readinessState.testError = error.message;
      readinessState.focusAfter = 'readiness-test-error';
    } finally {
      readinessState.busy = '';
      readinessRender();
    }
  }

  // ---------------------------------------------------------------- 动作:写入 / 撤销

  async function readinessPreviewWrite() {
    const p = readinessSelectedProvider();
    if (!p || readinessState.busy === 'preview') return;
    const blocked = readinessBlockedReason();
    if (blocked) return rToast(blocked, 'err');
    readinessState.busy = 'preview';
    readinessState.preview = null;
    readinessState.previewError = '';
    readinessState.applyResult = null;
    readinessState.applyWarnings = [];
    readinessState.applyError = '';
    readinessRender();
    try {
      const mode = readinessWriteMode();
      const options = {
        // provider_id / model / key_id / client_wire 是向导的选择:当前服务端对 Claude/Codex
        // 只消费 slots,其余键会被忽略(不会报错);后端支持后即可让选择直接驱动写入。
        provider_id: p.id,
        model: mode.model || readinessState.model,
        key_id: readinessState.keyId || undefined,
        client_wire: readinessClientWire(),
      };
      if (readinessState.app === 'zcode') {
        options.wire_api = readinessState.zcodeWire;
        options.model = readinessState.model;
      } else if (mode.slots) options.slots = true;
      const res = await readinessCall(`/api/onboarding/${encodeURIComponent(readinessState.app)}/preview`, {
        method: 'POST',
        body: JSON.stringify(options),
      });
      readinessState.preview = rIsObj(res) ? res : { changes: res };
      if (!readinessState.preview.token) readinessState.previewError = '服务端没有返回预览令牌，不能写入。';
    } catch (error) {
      readinessState.previewError = error.message;
      readinessState.focusAfter = 'readiness-write-error';
    } finally {
      readinessState.busy = '';
      readinessRender();
    }
  }

  async function readinessApplyWrite() {
    const token = readinessState.preview?.token;
    if (!token || readinessState.busy === 'apply') return;
    if (!rEl('readiness-write-confirm')?.checked) return;
    if (readinessBlockedReason()) { readinessState.applyError = readinessBlockedReason(); readinessRender(); return; }
    readinessState.busy = 'apply';
    readinessState.applyError = '';
    readinessRender();
    try {
      const res = await readinessCall(`/api/onboarding/${encodeURIComponent(readinessState.app)}/apply`, {
        method: 'POST',
        body: JSON.stringify({ token, confirm: true }),
      }, 65000);
      readinessState.applyResult = rIsObj(res) ? res : { changes: [] };
      readinessState.applyWarnings = rList(readinessState.applyResult.warnings);
      readinessState.preview = null;
      readinessState.busy = '';
      await rRefresh();
      await readinessInspect();   // 写完之后"当前是否指向路由"变了,徽标要跟着更新,不能留旧结论
      readinessState.entryStatus = `${R_APPS[readinessState.app].label} 已写入；可随时从撤销入口还原受管字段。`;
      rToast('客户端配置已写入', 'ok');
    } catch (error) {
      readinessState.applyError = error.message;
      readinessState.focusAfter = 'readiness-apply-error';
      rToast('写入失败：' + error.message, 'err');
    } finally {
      if (readinessState.busy === 'apply') readinessState.busy = '';
      readinessRender();
    }
  }

  async function readinessUndoPreview() {
    if (readinessState.busy === 'undo-preview') return;
    const blocked = readinessBlockedReason();
    if (blocked) return rToast(blocked, 'err');
    readinessState.busy = 'undo-preview';
    readinessState.undo = null;
    readinessState.undoError = '';
    readinessState.undoResult = null;
    readinessRender();
    try {
      const res = await readinessCall(`/api/onboarding/${encodeURIComponent(readinessState.app)}/undo-preview`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      readinessState.undo = rIsObj(res) ? res : { changes: res };
      // can_undo=false 是账本冲突导致的阻断(服务端刻意不签发令牌),不是接口故障:交给预览块说明。
      if (!readinessState.undo.token && readinessState.undo.can_undo !== false)
        readinessState.undoError = '服务端没有返回撤销令牌，不能撤销。';
    } catch (error) {
      readinessState.undoError = error.message;
      readinessState.focusAfter = 'readiness-undo-error';
    } finally {
      readinessState.busy = '';
      readinessRender();
    }
  }

  async function readinessUndoApply() {
    const token = readinessState.undo?.token;
    if (!token || readinessState.busy === 'undo') return;
    if (!rEl('readiness-undo-confirm')?.checked) return;
    readinessState.busy = 'undo';
    readinessState.undoError = '';
    readinessRender();
    try {
      const res = await readinessCall(`/api/onboarding/${encodeURIComponent(readinessState.app)}/undo`, {
        method: 'POST',
        body: JSON.stringify({ token, confirm: true }),
      }, 65000);
      readinessState.undoResult = rIsObj(res) ? res : {};
      readinessState.undo = null;
      readinessState.busy = '';
      await rRefresh();
      await readinessInspect();
      readinessState.entryStatus = `${R_APPS[readinessState.app].label} 的受管字段已还原。`;
      rToast('已撤销上次写入', 'ok');
    } catch (error) {
      readinessState.undoError = error.message;
      readinessState.focusAfter = 'readiness-undo-error';
      rToast('撤销失败：' + error.message, 'err');
    } finally {
      if (readinessState.busy === 'undo') readinessState.busy = '';
      readinessRender();
    }
  }

  // ---------------------------------------------------------------- 槽位后备池

  function readinessPoolMembersOf(slot) {
    return rList(slot?.pool).map(item => {
      const provider = typeof item === 'string' ? item : (rIsObj(item) ? item.provider : '');
      const model = rIsObj(item) ? String(item.model || '') : '';
      return { provider: String(provider || ''), model };
    }).filter(m => m.provider && m.provider !== slot?.provider);
  }

  function readinessPoolBadge(slot) {
    const pool = readinessPoolMembersOf(slot);
    if (!slot?.provider) return '<span class="badge off">未绑定主渠道</span>';
    if (!pool.length) return '<span class="badge off">单一渠道</span>';
    const strategy = slot.strategy || 'priority';
    return `<span class="badge info">后备池 ${pool.length} 个 · ${rEsc(strategy)}</span>`;
  }

  function readinessPoolEditorHtml(name, slot) {
    const draft = readinessState.slot?.name === name ? readinessState.slot : null;
    if (!draft) return '';
    const used = new Set([slot?.provider || '', ...draft.members.map(m => m.provider)]);
    const candidates = readinessProviders().filter(p => p.id !== slot?.provider && !used.has(p.id));
    const addOptions = candidates.length
      ? candidates.map(p => `<option value="${rEsc(p.id)}">${rEsc(p.name)}${p.enabled === false ? '（停用）' : ''}</option>`).join('')
      : '<option value="">（没有其他 Claude 渠道）</option>';
    const strategyNote = draft.strategy && draft.strategy !== 'priority' && draft.preserveStrategy
      ? `<p class="hint readiness-pool-strategy">现有策略是 <b>${rEsc(draft.strategy)}</b>：本编辑器只调整后备成员与顺序，保存时原样保留该策略，不会偷偷改成 priority。</p>`
      : '<p class="hint readiness-pool-strategy">仅按 priority（主渠道优先，失败后依次尝试后备）解释这里的顺序；主渠道始终由服务端排在第一位。</p>';
    const rows = draft.members.map((member, index) => {
      const provider = readinessProviders().find(p => p.id === member.provider);
      const models = provider ? (provider.models || [provider.model].filter(Boolean)) : [];
      const datalist = [...new Set(models.map(rText).filter(Boolean))].map(m => `<option value="${rEsc(m)}"></option>`).join('');
      const options = readinessProviders().map(p => `<option value="${rEsc(p.id)}" ${p.id === member.provider ? 'selected' : ''}>${rEsc(p.name)}${p.enabled === false ? '（停用）' : ''}</option>`).join('');
      return `<li class="readiness-pool-member">
        <span class="readiness-pool-order" aria-hidden="true">${index + 2}</span>
        <label class="field readiness-pool-provider">渠道<select id="readiness-pool-provider-${name}-${index}" onchange="readinessPoolSetProvider('${rEsc(name)}',${index},this.value)">${options}</select></label>
        <label class="field readiness-pool-model">模型<input type="text" id="readiness-pool-model-${name}-${index}" list="readiness-pool-models-${name}-${index}" value="${rEsc(member.model)}" placeholder="${rEsc(slot?.model ? '跟随主槽模型 ' + slot.model : '跟随主槽模型')}" spellcheck="false" autocomplete="off" oninput="readinessPoolSetModel('${rEsc(name)}',${index},this.value)"><datalist id="readiness-pool-models-${name}-${index}">${datalist}</datalist></label>
        <div class="readiness-pool-buttons">
          <button class="iconbtn" type="button" id="readiness-pool-up-${name}-${index}" aria-label="后备渠道上移" onclick="readinessPoolMove('${rEsc(name)}',${index},-1)" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="iconbtn" type="button" id="readiness-pool-down-${name}-${index}" aria-label="后备渠道下移" onclick="readinessPoolMove('${rEsc(name)}',${index},1)" ${index === draft.members.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="iconbtn" type="button" id="readiness-pool-remove-${name}-${index}" aria-label="移除这个后备渠道" onclick="readinessPoolRemove('${rEsc(name)}',${index})">×</button>
        </div>
      </li>`;
    }).join('');
    const primary = `<li class="readiness-pool-member readiness-pool-primary">
      <span class="readiness-pool-order" aria-hidden="true">1</span>
      <span class="readiness-pool-provider"><b>${rEsc(slot?.provider_name || slot?.provider || '未绑定')}</b></span>
      <span class="readiness-pool-model mono">${rEsc(slot?.model || '渠道第一个模型')}</span>
      <span class="badge info">主渠道 · 固定第一</span>
    </li>`;
    return `<div class="readiness-pool-editor" id="readiness-pool-editor-${name}">
      <ol class="readiness-pool-list">${primary}${rows}</ol>
      ${draft.members.length ? '' : '<p class="hint">还没有后备渠道；保存空列表会把已有后备池清空（主渠道不变）。</p>'}
      <div class="readiness-row readiness-pool-add-row">
        <label class="field readiness-grow">添加后备渠道<select id="readiness-pool-add-${name}">${addOptions}</select></label>
        <button class="small" type="button" id="readiness-pool-add-btn-${name}" onclick="readinessPoolAdd('${rEsc(name)}')" ${candidates.length ? '' : 'disabled'}>＋ 加到末尾</button>
      </div>
      ${strategyNote}
      <p class="hint">后备渠道只在这个槽位的请求上按顺序重试；真实降级取决于上游错误与重试预算，不能保证图片、工具调用等能力和主渠道一致。停用的渠道会被服务端直接跳过。</p>
      <div class="savebar">
        <button class="primary" type="button" id="readiness-pool-save-${name}" onclick="readinessPoolSave('${rEsc(name)}')" ${readinessState.busy === 'pool' ? 'disabled' : ''}>${readinessState.busy === 'pool' ? '保存中…' : '保存后备池'}</button>
        <button class="small" type="button" id="readiness-pool-cancel-${name}" onclick="readinessPoolCancel()">取消</button>
      </div>
    </div>`;
  }

  function readinessPoolsHtml() {
    if (!rState()) return '<p class="hint">等待状态数据；读取到槽位表后这里会显示后备池。</p>';
    if (rCurApp() !== 'claude') {
      return `<p class="hint">后备池编辑器只维护 Claude 槽位。Codex 的 main / reviewer 写入客户端配置时是单一渠道，这里不提供编辑入口，避免显示一份客户端不会使用的备份。</p>`;
    }
    const slots = readinessSlots().claude || [];
    if (!slots.length) return '<p class="hint">还没有可编辑的 Claude 槽位。</p>';
    const rows = slots.map(slot => {
      const open = readinessState.slot?.name === slot.name;
      const status = readinessState.slotStatus?.name === slot.name ? readinessState.slotStatus : null;
      return `<div class="readiness-pool-row" id="readiness-pool-row-${slot.name}">
        <div class="readiness-pool-head">
          <div class="readiness-pool-ident"><b>${rEsc(slotLabel(slot.name))}</b><span class="mono">${rEsc(slot.alias || '')}</span></div>
          <div class="readiness-pool-summary">${readinessPoolBadge(slot)}${slot.dropTools?.length ? `<span class="badge off">剥离 ${slot.dropTools.length} 个工具规则</span>` : ''}</div>
          <button class="small" type="button" id="readiness-pool-edit-${slot.name}" onclick="readinessPoolToggle('${rEsc(slot.name)}')" aria-expanded="${open ? 'true' : 'false'}" ${slot.provider ? '' : 'disabled'}>${open ? '收起后备池' : '编辑后备池'}</button>
        </div>
        ${status ? `<p class="msg ${status.kind === 'err' ? 'err' : 'ok'}" id="readiness-pool-note-${slot.name}" role="status">${rEsc(status.text)}</p>` : ''}
        ${open ? readinessPoolEditorHtml(slot.name, slot) : ''}
      </div>`;
    }).join('');
    return `<h3>槽位后备池</h3>
      <p class="hint">主渠道由上面的槽位表决定，固定排第一；这里只维护后备成员、它们的模型与顺序。保存仍走 PUT /api/slots，未列出的 dropTools 与已有非 priority 策略会原样保留。</p>
      ${rows}`;
  }

  function slotLabel(name) {
    const labels = { main: '主模型 main', opus: 'Opus 槽', sonnet: 'Sonnet 槽', haiku: 'Haiku 槽', subagent: 'Subagent 槽' };
    return labels[name] || name;
  }

  function readinessRenderPools(force) {
    // refresh 每 5 秒都会走这里:顺手把入口那句状态跟上连接状态,别让首帧的"离线"一直挂着。
    readinessSyncEntry();
    const host = rEl('readiness-slot-pools');
    if (!host) return;
    if (rCurApp() !== 'claude' && readinessState.slot) readinessState.slot = null;
    if (!force && (readinessState.slot || host.contains?.(document.activeElement))) return;
    const sig = JSON.stringify([rCurApp(), rState()?.slots?.claude || null]);
    if (!force && sig === readinessState.mountedPoolSig) return;
    readinessState.mountedPoolSig = sig;
    host.innerHTML = readinessPoolsHtml();
  }

  function readinessPoolToggle(name) {
    if (readinessState.slot?.name === name) { readinessState.slot = null; readinessState.slotStatus = null; }
    else {
      const slot = readinessClaudeSlot(name);
      if (!slot || !slot.provider) return;
      const members = readinessPoolMembersOf(slot);
      const hadPool = Array.isArray(slot.pool) && slot.pool.length > 0;
      readinessState.slot = {
        name,
        members,
        strategy: slot.strategy || (hadPool ? 'priority' : 'priority'),
        preserveStrategy: hadPool && !!slot.strategy && slot.strategy !== 'priority',
      };
      readinessState.slotStatus = null;
      readinessState.focusAfter = '';
    }
    readinessRenderPools(true);
    const btn = rEl('readiness-pool-edit-' + name);
    if (btn?.focus) btn.focus();
  }

  function readinessPoolSetProvider(name, index, value) {
    const draft = readinessState.slot?.name === name ? readinessState.slot : null;
    const member = draft?.members[index];
    if (!member) return;
    member.provider = String(value || '');
    member.model = '';
    readinessRenderPools(true);
    const el = rEl(`readiness-pool-provider-${name}-${index}`);
    if (el?.focus) el.focus();
  }

  function readinessPoolSetModel(name, index, value) {
    const draft = readinessState.slot?.name === name ? readinessState.slot : null;
    const member = draft?.members[index];
    if (!member) return;
    member.model = String(value ?? '');
  }

  function readinessPoolMove(name, index, delta) {
    const draft = readinessState.slot?.name === name ? readinessState.slot : null;
    if (!draft) return;
    const next = index + delta;
    if (next < 0 || next >= draft.members.length) return;
    const [member] = draft.members.splice(index, 1);
    draft.members.splice(next, 0, member);
    readinessRenderPools(true);
    const el = rEl(`readiness-pool-${delta < 0 ? 'up' : 'down'}-${name}-${next}`);
    if (el?.focus) el.focus();
  }

  function readinessPoolRemove(name, index) {
    const draft = readinessState.slot?.name === name ? readinessState.slot : null;
    if (!draft) return;
    draft.members.splice(index, 1);
    readinessRenderPools(true);
    const el = rEl(`readiness-pool-add-${name}`);
    if (el?.focus) el.focus();
  }

  function readinessPoolAdd(name) {
    const draft = readinessState.slot?.name === name ? readinessState.slot : null;
    if (!draft) return;
    const select = rEl('readiness-pool-add-' + name);
    const value = select?.value || '';
    if (!value) return;
    if (draft.members.some(m => m.provider === value)) return rToast('这个渠道已经在后备池里', 'err');
    draft.members.push({ provider: value, model: '' });
    readinessRenderPools(true);
    const el = rEl(`readiness-pool-provider-${name}-${draft.members.length - 1}`);
    if (el?.focus) el.focus();
  }

  function readinessPoolCancel() {
    readinessState.slot = null;
    readinessState.slotStatus = null;
    readinessRenderPools(true);
  }

  async function readinessPoolSave(name) {
    if (readinessState.busy === 'pool') return;
    const slot = readinessClaudeSlot(name);
    const draft = readinessState.slot?.name === name ? readinessState.slot : null;
    if (!slot || !slot.provider || !draft) return;
    if (typeof putSlot !== 'function') { readinessState.slotStatus = { name, text: '槽位接口未就绪，未保存。' }; readinessRenderPools(true); return; }
    const seen = new Set();
    const members = [];
    for (const member of draft.members) {
      if (!member.provider || member.provider === slot.provider || seen.has(member.provider)) continue;
      seen.add(member.provider);
      members.push(member.model && member.model.trim() ? { provider: member.provider, model: member.model.trim() } : { provider: member.provider });
    }
    const hadPool = Array.isArray(slot.pool) && slot.pool.length > 0;
    // 已有池的策略原样保留;只有新建池时才写 priority(主用 + 后备)。
    const strategy = hadPool ? (slot.strategy || 'priority') : 'priority';
    const body = {
      provider: slot.provider,
      model: slot.model || '',
      // 部分更新语义:显式带回 dropTools,避免把用户的剥离规则一起抹掉。
      dropTools: Array.isArray(slot.dropTools) ? slot.dropTools.slice() : [],
      pool: members,
    };
    if (members.length) body.strategy = strategy;
    readinessState.busy = 'pool';
    readinessState.slotStatus = { name, text: members.length ? '正在保存后备池…' : '正在清空后备池…', kind: '' };
    readinessRenderPools(true);
    let ok = false;
    let failure = '';
    try { ok = await putSlot('claude', name, body); }
    catch (error) { failure = error.message; }
    readinessState.busy = '';
    if (ok) {
      readinessState.slot = null;
      readinessState.slotStatus = { name, text: members.length ? `已保存 ${members.length} 个后备渠道（策略 ${strategy}）。` : '已清空后备池；主渠道保持不变。', kind: 'ok' };
      rToast(members.length ? `槽位 ${name} 的后备池已保存` : `槽位 ${name} 的后备池已清空`, 'ok');
    } else {
      const reason = failure || rEl('toast')?.textContent || '服务端拒绝';
      readinessState.slotStatus = { name, text: '保存失败：' + reason, kind: 'err' };
    }
    readinessState.mountedPoolSig = '';
    readinessRenderPools(true);
  }

  // ---------------------------------------------------------------- 诊断报告

  function readinessReportPanelHtml() {
    return `<h2 id="readiness-report-title">脱敏诊断报告</h2>
      <p class="hint">只包含服务端白名单字段（版本、运行状态、计数与错误分类），不含 prompt、会话标签、渠道地址或任何密钥。预览只在点击后读取，不自动上传。</p>
      <div class="savebar">
        <button class="small" type="button" id="readiness-report-preview" onclick="readinessReportPreview()" ${readinessState.reportBusy ? 'disabled' : ''}>${readinessState.reportBusy ? '读取中…' : '读取报告预览'}</button>
        <button class="small" type="button" id="readiness-report-download" onclick="readinessReportDownload()" disabled>下载 JSON</button>
        <span class="msg" id="readiness-report-status" role="status">${rEsc(readinessState.reportError || '尚未读取。')}</span>
      </div>
      <pre class="readiness-report-output" id="readiness-report-output" tabindex="0" hidden></pre>`;
  }

  async function readinessReportPreview() {
    if (readinessState.reportBusy) return;
    readinessState.reportBusy = true;
    readinessState.reportError = '';
    readinessSyncReport();
    try {
      const res = await readinessCall('/api/diagnostics/report', {}, 20000);
      readinessState.report = res;
    } catch (error) {
      readinessState.report = null;
      readinessState.reportError = '读取失败：' + error.message;
    } finally {
      readinessState.reportBusy = false;
      readinessSyncReport();
    }
  }

  function readinessSyncReport() {
    const out = rEl('readiness-report-output');
    const status = rEl('readiness-report-status');
    const preview = rEl('readiness-report-preview');
    const download = rEl('readiness-report-download');
    if (preview) {
      // 离线时按钮直接禁用:点了也只会得到一句"控制台离线",不如先说清楚。
      preview.disabled = readinessState.reportBusy || !rOnline();
      preview.textContent = readinessState.reportBusy ? '读取中…' : (!rOnline() ? '离线，无法读取' : '读取报告预览');
    }
    if (download) download.disabled = !readinessState.report;
    if (out) {
      const text = readinessState.report ? (typeof readinessState.report === 'string' ? readinessState.report : JSON.stringify(readinessState.report, null, 2)) : '';
      out.textContent = text;
      out.hidden = !readinessState.report;
    }
    if (status) status.textContent = readinessState.reportError
      || (readinessState.report ? '报告已读取；确认字段都在白名单内后再下载。' : (!rOnline() ? '控制台离线：报告预览不可用，且不会自动重试。' : '尚未读取。'));
  }

  function readinessReportDownload() {
    const report = readinessState.report;
    if (!report) return;
    const text = typeof report === 'string' ? report : JSON.stringify(report, null, 2);
    const status = rEl('readiness-report-status');
    try {
      if (typeof Blob !== 'function' || typeof URL === 'undefined' || !URL.createObjectURL || typeof document.createElement !== 'function') {
        if (status) status.textContent = '当前环境不支持下载，报告未导出。';
        return;
      }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `mixrouter-diagnostics-${stamp}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      if (status) status.textContent = `已导出 ${text.length} 字节的白名单报告。`;
    } catch (error) {
      if (status) status.textContent = '报告导出失败：' + error.message;
    }
  }

  // ---------------------------------------------------------------- 打开 / 关闭 / 挂载

  function readinessOpen() {
    const dialog = rEl('readiness-dialog');
    if (!dialog) return;
    // 从渠道页某个客户端入口点进来时,向导默认跟着那一页的客户端;已经打开的向导不重置。
    if (!readinessState.open && rCurApp() !== readinessState.app) readinessSetApp(rCurApp());
    readinessState.open = true;
    if (!readinessState.providerId) {
      const list = readinessProviders();
      if (list.length) readinessPickProvider(list[0].id, { render: false });
    }
    readinessRender();
    try {
      if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
      else dialog.setAttribute('open', '');
    } catch { dialog.setAttribute('open', ''); }
    const first = rEl('readiness-client-' + readinessState.app) || rEl('readiness-close');
    if (first?.focus) first.focus();
    if (!readinessState.inspect || readinessState.inspectError) return readinessInspect();
    return null;
  }

  // 从概览跳进渠道页再打开向导:走外壳导航(有动画/URL),失败就退回 direct 调用。
  function readinessOpenFromOverview(app) {
    const target = R_APPS[app] ? app : 'claude';
    try {
      if (typeof window !== 'undefined' && typeof window.workspaceNavigate === 'function') {
        window.workspaceNavigate('providers', target);
      } else {
        if (typeof setApp === 'function') setApp(target);
        if (typeof showView === 'function') showView('providers');
      }
    } catch (error) { console.error(error); }
    readinessState.app = target;
    return readinessOpen();
  }

  function readinessOpenUndo() {
    readinessOpen();
    readinessState.focusAfter = 'readiness-undo-preview';
    readinessRender();
    const el = rEl('readiness-undo-preview');
    if (el?.focus) el.focus();
  }

  function readinessClose() {
    const dialog = rEl('readiness-dialog');
    readinessState.open = false;
    if (!dialog) return;
    try {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else dialog.removeAttribute('open');
    } catch { dialog.removeAttribute('open'); }
  }

  function readinessMount() {
    if (readinessState.mounted) return;
    const view = rEl('view-providers');
    if (!view) return;
    readinessState.mounted = true;
    readinessState.app = rCurApp();
    readinessState.zcodeWire = 'anthropic';

    const entry = document.createElement('section');
    entry.id = 'readiness-entry';
    entry.className = 'panel readiness-entry';
    entry.setAttribute('aria-labelledby', 'readiness-entry-title');
    entry.innerHTML = `<div class="readiness-entry-row">
        <div class="readiness-entry-copy">
          <h2 id="readiness-entry-title">接入向导</h2>
          <p class="hint">从空渠道库接通一个客户端：选客户端、加渠道、挑模型、跑一次兼容测试、预览并确认写入。没确认之前不会改动配置；写入后可以从同一个入口撤销。</p>
        </div>
        <div class="readiness-entry-actions">
          <button class="primary" type="button" id="readiness-open" onclick="readinessOpen()">打开接入向导</button>
          <button class="small" type="button" id="readiness-undo-open" onclick="readinessOpenUndo()">撤销上次写入</button>
        </div>
      </div>
      <p class="hint" id="readiness-entry-status" role="status">读取客户端安装与配置状态后再开始。</p>`;
    const tabs = view.querySelector('.apptabs');
    if (tabs && tabs.parentNode === view) view.insertBefore(entry, tabs);
    else view.appendChild(entry);

    // 概览页只加一个跳转入口,不放任何配置控件:点下去是切到渠道页并打开向导弹窗。
    const overview = rEl('view-overview');
    if (overview) {
      const jump = document.createElement('div');
      jump.id = 'readiness-overview';
      jump.className = 'panel readiness-overview-jump';
      jump.innerHTML = `<div class="readiness-entry-row">
          <div class="readiness-entry-copy">
            <h2 id="readiness-overview-title">还没接通客户端？</h2>
            <p class="hint" id="readiness-overview-status">接入向导会带着你检查客户端、选渠道与模型、跑一次兼容测试，再预览并确认写入。这一页仍然只读。</p>
          </div>
          <div class="readiness-entry-actions">
            <button class="small" type="button" id="readiness-overview-open" onclick="readinessOpenFromOverview('claude')">打开接入向导</button>
          </div>
        </div>`;
      const anchor = rEl('overview-todo')?.parentNode;
      if (anchor && anchor.parentNode === overview) anchor.parentNode.insertBefore(jump, anchor.nextSibling);
      else overview.appendChild(jump);
    }

    const dialog = document.createElement('dialog');
    dialog.id = 'readiness-dialog';
    dialog.className = 'readiness-dialog';
    dialog.setAttribute('aria-labelledby', 'readiness-title');
    dialog.innerHTML = `<div class="readiness-dialog-head">
        <div><h2 id="readiness-title">接入向导</h2><p class="hint" id="readiness-subtitle">写入的是客户端配置文件；渠道库仍是同一个库。每一步都可以失败后重试。</p></div>
        <button class="small quiet" type="button" id="readiness-close" onclick="readinessClose()">关闭</button>
      </div>
      <div class="readiness-clients" role="tablist" aria-label="选择客户端">
        ${readinessApps().map(app => `<button class="seg" type="button" role="tab" id="readiness-client-${app}" aria-controls="readiness-body" aria-selected="false" tabindex="-1" onclick="readinessPickClient('${app}')">${rEsc(R_APPS[app].label)}</button>`).join('')}
      </div>
      <div id="readiness-body" class="readiness-body"></div>
      <p id="readiness-status" class="readiness-status" role="status"></p>`;
    document.body.appendChild(dialog);
    if (dialog.addEventListener) {
      dialog.addEventListener('cancel', () => { readinessState.open = false; });
      dialog.addEventListener('close', () => { readinessState.open = false; });
    }
    readinessSyncClients();
    // 客户端切换用方向键在标签间移动(与渠道页的 apptabs 同一套键位),Home/End 到首尾。
    const clientBar = dialog.querySelector?.('.readiness-clients');
    if (clientBar?.addEventListener) {
      clientBar.addEventListener('keydown', event => {
        const keys = readinessApps();
        let index = keys.indexOf(readinessState.app);
        if (event.key === 'ArrowRight') index = (index + 1) % keys.length;
        else if (event.key === 'ArrowLeft') index = (index + keys.length - 1) % keys.length;
        else if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = keys.length - 1;
        else return;
        event.preventDefault();
        readinessPickClient(keys[index]);
        rEl('readiness-client-' + keys[index])?.focus?.();
      });
    }

    const slotsPanel = rEl('slots-panel');
    const slotsRows = rEl('slots-rows');
    if (slotsPanel && slotsRows && slotsRows.parentNode === slotsPanel) {
      const host = document.createElement('div');
      host.id = 'readiness-slot-pools';
      host.className = 'readiness-slot-pools';
      slotsRows.parentNode.insertBefore(host, slotsRows.nextSibling);
    }

    const diagnostics = rEl('view-diagnostics');
    if (diagnostics) {
      const panel = document.createElement('section');
      panel.id = 'readiness-report-panel';
      panel.className = 'panel readiness-report-panel';
      panel.setAttribute('aria-labelledby', 'readiness-report-title');
      panel.innerHTML = readinessReportPanelHtml();
      diagnostics.appendChild(panel);
      readinessSyncReport();
    }

    readinessSyncEntry();
    readinessRenderPools(true);

    // renderSlots 每 5 秒被 refresh 调用一次:包一层只追加后备池渲染,不改变原行为。
    const slotsUnsafe = typeof renderSlots === 'function' ? renderSlots : null;
    if (slotsUnsafe && !slotsUnsafe.__readinessWrapped) {
      const wrapped = function (force) {
        const out = slotsUnsafe.apply(this, arguments);
        try { readinessRenderPools(!!force); } catch (error) { console.error(error); }
        return out;
      };
      wrapped.__readinessWrapped = true;
      rGlobal.renderSlots = wrapped;
      if (typeof window !== 'undefined' && window !== rGlobal) window.renderSlots = wrapped;
    }
  }

  // 只读的当前选择快照:给测试与排查用,不含任何密钥或配置正文。
  function readinessUiState() {
    return {
      app: readinessState.app,
      zcodeWire: readinessState.zcodeWire,
      clientWire: readinessClientWire(),
      group: readinessGroup(),
      providerId: readinessState.providerId,
      model: readinessState.model,
      keyId: readinessState.keyId,
      busy: readinessState.busy,
      compatTimeoutMs: R_COMPAT_TIMEOUT_MS,
    };
  }

  const readinessExports = {
    readinessOpen, readinessOpenUndo, readinessOpenFromOverview, readinessClose, readinessRender,
    readinessPickClient, readinessInspect, readinessPickProvider, readinessNewProvider,
    readinessToggleImport, readinessSetImportText, readinessImportPreview, readinessImportApply,
    readinessSetModel, readinessSetKey, readinessPickWire, readinessSetMain, readinessSetSlots,
    readinessRunTest, readinessPreviewWrite, readinessApplyWrite,
    readinessUndoPreview, readinessUndoApply, readinessCopyParams,
    readinessPoolToggle, readinessPoolSetProvider, readinessPoolSetModel, readinessPoolMove,
    readinessPoolRemove, readinessPoolAdd, readinessPoolSave, readinessPoolCancel,
    readinessReportPreview, readinessReportDownload, readinessSyncButtons, readinessUiState,
  };
  Object.assign(rGlobal, readinessExports);
  if (typeof window !== 'undefined' && window !== rGlobal) Object.assign(window, readinessExports);

  if (document.readyState === 'loading' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', readinessMount, { once: true });
  } else {
    readinessMount();
  }
})();
