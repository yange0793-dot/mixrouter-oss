/*
 * 多 Key 自动备用(可选,默认关闭)的控制台面板。
 *
 * 这是一个**独立 classic 脚本**:不碰 app.js 的渠道卡片、弹窗草稿与 5 秒刷新循环,
 * 只在自己的容器里提供:
 *   · 选渠道 → 显式开关(PUT /api/providers/:id { key_fallback });
 *   · Key 健康视图(GET /api/keys/health → { keys: [...] }),只显示 ID / 枚举 / 时间。
 *
 * 为什么不往每张渠道卡片里插按钮:app.js 用 `grid.innerHTML !== html` 判断要不要重绘,
 * 任何外部注入都会让这个判据永远为真,5 秒一次把整张网格重建。面板放在网格外面,
 * 渠道卡片的渲染路径一个字节都不变,也不会重绘编辑弹窗里的草稿。
 */
(function () {
  'use strict';

  const GROUP_ORDER = ['claude', 'codex'];
  const HEALTH_REFRESH_MS = 3000;
  const STATE_RETRY_MS = 2000;

  const cache = new Map();        // provider id -> { id, name, group, keys, key_fallback }
  const overrides = new Map();    // 刚 PUT 成功、等 /api/state 追上来的本地值
  let selectedId = '';
  let groupSig = '';
  let panel = null;
  let els = null;
  let scheduled = false;
  let healthAt = 0;
  let healthLoading = false;
  let stateFetchAt = 0;
  let stateFetching = false;

  // ---------------------------------------------------------------- 与 app.js 共用的只读入口
  // app.js 是 classic 脚本,顶层 state / providerGroup / api / toast 在同名全局词法环境里,
  // 后续 classic 脚本可以直接按名字读。全部包在 try 里:脚本若被提前加载(或将来改成模块),
  // 这里只是拿不到状态,不会把自己的面板拖崩。
  function appState() {
    try { return typeof state !== 'undefined' && state ? state : null; } catch (_) { return null; }
  }
  function currentGroup() {
    try { return typeof providerGroup === 'function' ? providerGroup() : 'claude'; } catch (_) { return 'claude'; }
  }
  // 离线时不能保存:app.js 的 online 是连接状态真相(顶部横幅同一判据)。
  // 拿不到时退回 body 的 data-connection,再拿不到才允许 —— 宁可多试一次 PUT,
  // 也不要在脚本加载顺序变化后把开关永久按住。
  function isOnline() {
    try { if (typeof online === 'boolean') return online; } catch (_) { /* 继续往下判 */ }
    try {
      const conn = document.body && document.body.dataset ? document.body.dataset.connection : '';
      if (conn) return conn !== 'offline';
    } catch (_) { /* 继续 */ }
    return true;
  }
  function apiRequest(path, opt) {
    try {
      if (typeof api === 'function') return Promise.resolve(api(path, opt));
    } catch (e) { return Promise.reject(e); }
    return fetch(path, {
      cache: 'no-store',
      ...opt,
      headers: { 'Content-Type': 'application/json', ...(opt && opt.headers) },
    }).then(async r => {
      let body = null;
      try { body = await r.json(); } catch (_) { /* 非 JSON 响应按状态码报错 */ }
      if (!r.ok) throw new Error((body && body.error) || `HTTP ${r.status}`);
      return body;
    });
  }
  function notify(text, kind) {
    try {
      if (typeof toast === 'function') { toast(text, kind || ''); return; }
    } catch (_) { /* 落到面板状态行 */ }
    setStatus(text);
  }
  function setStatus(text) {
    if (els && els.status) els.status.textContent = text || '';
  }
  const textOf = value => (value === undefined || value === null ? '' : String(value));

  // ---------------------------------------------------------------- 渠道缓存
  function ingest(next) {
    if (!next || !next.providers) return;
    cache.clear();
    for (const group of GROUP_ORDER) {
      const list = Array.isArray(next.providers[group]) ? next.providers[group] : [];
      for (const p of list) {
        if (!p || typeof p.id !== 'string') continue;
        let flag = p.key_fallback === true;
        if (overrides.has(p.id)) {
          // /api/state 已经追上保存结果:本地覆盖可以退休了
          if (overrides.get(p.id) === flag) overrides.delete(p.id);
          else flag = overrides.get(p.id) === true;
        }
        cache.set(p.id, {
          id: p.id,
          name: typeof p.name === 'string' && p.name ? p.name : p.id,
          group,
          keys: Array.isArray(p.keys) ? p.keys : [],
          key_fallback: flag,
        });
      }
    }
  }

  function refreshFromState() {
    const s = appState();
    if (s) { ingest(s); return Promise.resolve(true); }
    if (stateFetching || Date.now() - stateFetchAt < STATE_RETRY_MS) return Promise.resolve(false);
    stateFetching = true;
    stateFetchAt = Date.now();
    return apiRequest('/api/state')
      .then(s2 => { ingest(s2); return true; })
      .catch(() => false)
      .finally(() => { stateFetching = false; });
  }

  // ---------------------------------------------------------------- 面板骨架
  function providersVisible() {
    const view = document.getElementById('view-providers');
    return !!view && view.style.display !== 'none' && !view.hidden;
  }

  function ensurePanel() {
    if (panel && panel.isConnected) return panel;
    const grid = document.getElementById('prov-grid');
    if (!grid) return null;
    panel = document.createElement('section');
    panel.className = 'kf-panel';
    panel.id = 'kf-health';
    panel.setAttribute('aria-labelledby', 'kf-title');
    panel.innerHTML = `
      <div class="kf-head">
        <div class="kf-intro">
          <h2 id="kf-title">多 Key 自动备用</h2>
          <p class="hint" id="kf-hint">默认关闭。开启后，同一渠道的多把 Key 在账号、额度或模型权限失败时自动换号；会话固定 Key 与压缩专用 Key 永远不换，也不改渠道当前生效的 Key。</p>
        </div>
        <div class="kf-controls">
          <label class="kf-field" for="kf-provider">渠道<select id="kf-provider"></select></label>
          <button type="button" class="small kf-toggle" id="kf-toggle" aria-pressed="false" disabled>Key 自动备用 · 关</button>
          <span class="kf-status" id="kf-status" role="status"></span>
        </div>
      </div>
      <p class="hint kf-detail" id="kf-detail">选择一个渠道后可开启。</p>
      <div class="kf-health-body">
        <div class="kf-health-head">
          <h3>Key 状态</h3>
          <button type="button" class="small quiet" id="kf-refresh">刷新状态</button>
        </div>
        <p class="hint" id="kf-health-status" role="status">尚未读取。</p>
        <ul class="kf-rows" id="kf-rows"></ul>
        <p class="hint">只显示渠道 ID、Key ID、状态与时间；不显示 Key 正文，也没有删除操作。状态仅保存在本进程内存，服务重启后清零。</p>
      </div>`;
    const empty = document.getElementById('prov-empty');
    if (empty && empty.parentNode === grid.parentNode) empty.insertAdjacentElement('afterend', panel);
    else grid.insertAdjacentElement('afterend', panel);
    els = {
      select: panel.querySelector('#kf-provider'),
      toggle: panel.querySelector('#kf-toggle'),
      status: panel.querySelector('#kf-status'),
      detail: panel.querySelector('#kf-detail'),
      healthStatus: panel.querySelector('#kf-health-status'),
      rows: panel.querySelector('#kf-rows'),
      refresh: panel.querySelector('#kf-refresh'),
    };
    els.select.addEventListener('change', () => {
      selectedId = els.select.value;
      updateToggle();
    });
    els.toggle.addEventListener('click', onToggle);
    els.refresh.addEventListener('click', () => loadHealth(true, true));
    return panel;
  }

  // ---------------------------------------------------------------- 渠道下拉与开关
  function groupProviders(group) {
    const out = [];
    for (const p of cache.values()) if (p.group === group) out.push(p);
    return out;
  }

  function optionText(p) {
    const count = p.keys.length;
    return `${p.name} · ${count} 把 Key${p.key_fallback ? ' · 已开启' : ''}`;
  }

  function syncProviders() {
    if (!ensurePanel() || !providersVisible()) return;
    const group = currentGroup();
    const list = groupProviders(group);
    const sig = group + '|' + list.map(p => p.id).join(',');
    if (sig !== groupSig) {
      groupSig = sig;
      // 只重建选项,不重绘编辑弹窗:当前选择仍存在就保留,否则回到第一项。
      if (!list.some(p => p.id === selectedId)) selectedId = list[0] ? list[0].id : '';
      els.select.replaceChildren();
      for (const p of list) {
        const option = document.createElement('option');
        option.value = p.id;
        option.textContent = optionText(p);
        els.select.appendChild(option);
      }
      els.select.value = selectedId;
    } else {
      // 同一组渠道:原地更新文案与选中项,避免把用户正在展开的下拉关掉。
      for (const option of els.select.options) {
        const p = cache.get(option.value);
        if (p) option.textContent = optionText(p);
      }
      if (selectedId && cache.has(selectedId) && els.select.value !== selectedId) els.select.value = selectedId;
    }
    updateToggle();
  }

  function updateToggle() {
    if (!els) return;
    const p = cache.get(selectedId);
    const on = !!(p && p.key_fallback === true);
    const online = isOnline();
    els.toggle.disabled = !p || !online;
    els.toggle.setAttribute('aria-pressed', String(on));
    els.toggle.classList.toggle('on', on);
    els.toggle.textContent = on ? 'Key 自动备用 · 开' : 'Key 自动备用 · 关';
    if (!p) {
      els.detail.textContent = '选择一个渠道后可开启。';
      return;
    }
    const count = p.keys.length;
    els.detail.textContent = !online
      ? '控制台离线：连接恢复后才能保存开关。'
      : count <= 1
      ? `该渠道当前 ${count} 把 Key；至少 2 把才会触发自动备用。默认关闭，固定 Key 的会话不换。`
      : `${count} 把 Key。开启后失败时按健康状态换号；会话固定 Key、压缩专用 Key 不换，也不改当前生效 Key。`;
  }

  async function onToggle() {
    const p = cache.get(selectedId);
    if (!p || !els || els.toggle.disabled) return;
    if (!isOnline()) { notify('控制台离线，未保存切换', 'err'); return; }
    const next = !(p.key_fallback === true);
    const previous = els.toggle.textContent;
    els.toggle.disabled = true;
    els.toggle.textContent = '保存中…';
    try {
      const res = await apiRequest('/api/providers/' + encodeURIComponent(p.id), {
        method: 'PUT', body: JSON.stringify({ key_fallback: next }),
      });
      overrides.set(p.id, next);
      p.key_fallback = next;
      if (res && Array.isArray(res.warnings) && res.warnings.length) notify(res.warnings.join('\n'), 'warn');
      else notify(next ? '已开启 Key 自动备用；固定 Key 的会话不会换号' : '已关闭 Key 自动备用，恢复原有固定 Key 行为', next ? 'ok' : '');
      updateToggle();
      scheduleHealth(true);
    } catch (e) {
      els.toggle.textContent = previous;
      notify('保存 Key 自动备用失败：' + String((e && e.message) || e), 'err');
      updateToggle();
    }
  }

  // ---------------------------------------------------------------- Key 健康视图
  function fmtTime(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function providerLabel(id) {
    const p = cache.get(id);
    return p ? `${p.name}（${p.id}）` : textOf(id);
  }

  function renderHealth(rows) {
    if (!els) return;
    els.rows.replaceChildren();
    if (!rows.length) {
      els.healthStatus.textContent = '暂无 Key 故障记录。未开启自动备用的渠道不会记录。';
      return;
    }
    els.healthStatus.textContent = `共 ${rows.length} 条状态记录（新→旧）。`;
    for (const row of rows) {
      const li = document.createElement('li');
      li.className = 'kf-row';

      const who = document.createElement('span');
      who.className = 'kf-who';
      who.textContent = `${providerLabel(row.provider)} · ${textOf(row.key_id) || '（无 Key ID）'}`;

      const state = document.createElement('span');
      state.className = 'badge ' + (row.state === 'failed' ? 'off' : 'on');
      state.textContent = row.state === 'failed' ? '最近失败' : (row.state === 'healthy' ? '正常' : textOf(row.state) || '未知');

      const scope = document.createElement('span');
      scope.className = 'kf-scope';
      if (row.scope === 'account') scope.textContent = '账号级';
      else if (row.scope === 'model') scope.textContent = '模型级 · ' + (textOf(row.model) || '未知模型');
      else scope.textContent = '—';

      const when = document.createElement('span');
      when.className = 'kf-when mono';
      const statusText = Number.isFinite(Number(row.status)) && Number(row.status) > 0 ? `HTTP ${Number(row.status)}` : '';
      const timeText = `更新 ${fmtTime(row.updated_at)}`;
      when.textContent = [statusText, timeText].filter(Boolean).join(' · ');

      li.append(who, state, scope, when);
      els.rows.appendChild(li);
    }
  }

  // force:跳过"距上次读取不足 3 秒"的节流;manual:用户主动触发,显示读取中并禁用按钮。
  // 三秒轮询用 force 且 manual=false —— 已经渲染过内容时不能每三秒闪一下状态行。
  function loadHealth(force = false, manual = false) {
    if (!els) return Promise.resolve();
    if (!providersVisible()) return Promise.resolve();
    if (healthLoading) return Promise.resolve();
    if (!force && Date.now() - healthAt < HEALTH_REFRESH_MS) return Promise.resolve();
    healthLoading = true;
    if (manual || !els.rows.children.length) {
      els.healthStatus.textContent = '读取中…';
      els.refresh.disabled = true;
    }
    return apiRequest('/api/keys/health')
      .then(data => {
        const rows = Array.isArray(data) ? data : (data && Array.isArray(data.keys) ? data.keys : []);
        healthAt = Date.now();
        renderHealth(rows);
      })
      .catch(e => {
        healthAt = Date.now();
        els.rows.replaceChildren();
        els.healthStatus.textContent = /404/.test(String(e && e.message))
          ? '后端尚未提供 /api/keys/health（多 Key 自动备用为可选功能）。'
          : `读取 Key 状态失败：${e && e.message ? e.message : '未知错误'}`;
      })
      .finally(() => {
        healthLoading = false;
        if (els) els.refresh.disabled = false;
      });
  }

  // 健康列表每 3 秒最多重读一次:网格重绘(5 秒轮询)与手动刷新都不会把它变成高频请求。
  let healthTimer = null;
  function scheduleHealth(force) {
    if (force) { clearTimeout(healthTimer); healthTimer = null; }
    else if (healthTimer) return;
    healthTimer = setTimeout(() => { healthTimer = null; loadHealth(!!force, !!force); }, force ? 0 : 250);
  }

  // ---------------------------------------------------------------- 生命周期
  function sync() {
    if (!providersVisible()) return;
    ensurePanel();
    // 每次同步都重新读 app.js 的 state:网格重绘正是"渠道刚新建/删除/改名"的时刻,
    // 只靠 init 时那一次 ingest 会让下拉框永远停在首帧快照(新建渠道后可选项为空)。
    // 这里**只读** state,不调用 refresh():不触发重绘,编辑弹窗里的草稿不受影响。
    const fresh = appState();
    if (fresh) ingest(fresh);
    else if (!cache.size) scheduleStateFetch();
    syncProviders();
    scheduleHealth(false);
  }

  // 只有连 app.js 的 state 都拿不到(脚本加载顺序异常)时才自己读一次 /api/state;
  // 重试有节流,失败也不阻断面板本身的渲染。
  let stateRetryTimer = null;
  function scheduleStateFetch() {
    if (stateRetryTimer) return;
    stateRetryTimer = setTimeout(() => {
      stateRetryTimer = null;
      refreshFromState().then(ok => { if (ok) sync(); });
    }, STATE_RETRY_MS);
    if (stateRetryTimer && typeof stateRetryTimer.unref === 'function') stateRetryTimer.unref();
  }

  function scheduleSync() {
    if (scheduled) return;
    scheduled = true;
    const run = () => { scheduled = false; sync(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  function init() {
    const grid = document.getElementById('prov-grid');
    if (!grid) return;
    ensurePanel();
    refreshFromState().then(() => sync());
    sync();
    // 渠道网格由 app.js 每 5 秒重建;这里只跟着同步自己的下拉/健康视图,不修改卡片。
    new MutationObserver(() => { if (providersVisible()) scheduleSync(); }).observe(grid, { childList: true });
    const view = document.getElementById('view-providers');
    if (view) new MutationObserver(() => { if (providersVisible()) scheduleSync(); }).observe(view, { attributes: true, attributeFilter: ['style', 'hidden'] });
    window.addEventListener('hashchange', () => { if (providersVisible()) { healthAt = 0; scheduleSync(); } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && providersVisible()) scheduleHealth(true); });
    // 失败诊断记录不随时间过期,但新失败/成功会在后台改变它:三秒的有界轮询,
    // 只在可见 + 在线 + 面板存在时发一次读请求;切走标签页即停。
    startHealthPolling();
  }

  // 轮询有界(固定 3 秒,不叠加、不在隐藏页跑),并且与手动刷新共用同一个 in-flight 守卫。
  // unref:Node 测试里它不该成为进程退不出去的理由(浏览器没有 unref,不影响)。
  let healthPollTimer = null;
  function startHealthPolling() {
    if (healthPollTimer) return;
    healthPollTimer = setInterval(() => {
      if (document.hidden || !providersVisible() || !isOnline()) return;
      loadHealth(true);
    }, HEALTH_REFRESH_MS);
    if (healthPollTimer && typeof healthPollTimer.unref === 'function') healthPollTimer.unref();
  }
  function stopHealthPolling() {
    if (!healthPollTimer) return;
    clearInterval(healthPollTimer);
    healthPollTimer = null;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  // 给控制台脚本/调试留一个只读入口:不暴露内部状态,只允许主动同步、刷新与停轮询。
  window.KeyFallbackUI = {
    refresh: () => sync(),
    refreshHealth: () => loadHealth(true, true),
    stop: () => { stopHealthPolling(); clearTimeout(healthTimer); healthTimer = null; },
  };
})();
