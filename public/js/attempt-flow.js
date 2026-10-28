'use strict';
// 诊断页的「实时尝试过程」面板(GET /api/attempts 的消费者)。
//
// 它**独立**于 app.js 的日志表:不改 loadLogs 的渲染,也不依赖它的序列号/错误横幅,
// 只在诊断视图里往 #view-diagnostics 追加一块自己的面板。这样日志表怎么改版都不会把
// 这块带坏,反过来也一样。
//
// 三件事必须做对:
//   1. **只在看这一页时轮询**。诊断视图不可见、标签页在后台、或服务端已判定离线时,一律
//      不发请求;切走时清掉定时器。诊断轮询不该在用户看别的页面时继续占端口与 CPU。
//   2. **只读且无副作用**:GET /api/attempts 不写配置、不碰会话。失败就在面板里说一句,
//      弹 toast 会盖掉用户正在做的事。
//   3. **所有来自服务端的文本一律转义**。渠道 id、模型名、错误分类都可能被上游或客户端
//      左右(模型名就是请求体原文),拼进 innerHTML 前必须 esc;错误解释的正文虽由服务端
//      常量产出,也走同一条路 —— 这里不做"这个字段可信"的例外。
//
// 错误解释(GET /api/errors/guidance)按需拉:只有用户展开某条已结束的 trace 时才请求,
// 并按 status+err_class 缓存,不随轮询放大请求量。

(() => {
  const PANEL_ID = 'attempt-flow';
  const POLL_MS = 2000;
  const ACTIVE_MAX = 50;
  const TERMINAL_MAX = 20;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const state = {
    timer: null,
    inflight: null,
    lastError: '',
    traces: [],
    // 展开过的终态 trace:id -> true(重渲染后保持展开)
    open: new Set(),
    // 错误解释缓存:`status|err_class` -> {category,title,impact,action,target,uncertain} 或 {error}
    guidance: new Map(),
    guidanceInflight: new Set(),
  };

  const view = () => document.getElementById('view-diagnostics');
  const isActive = () => {
    const el = view();
    if (!el) return false;
    // 视图切换是 style.display 控制的;再叠一层"文档可见 + 没被判离线"
    if (el.style.display === 'none' || el.hidden) return false;
    if (document.visibilityState === 'hidden') return false;
    const conn = document.body && document.body.dataset ? document.body.dataset.connection : '';
    return conn !== 'offline';
  };

  function panel() {
    let el = document.getElementById(PANEL_ID);
    if (el) return el;
    const host = view();
    if (!host) return null;
    el = document.createElement('section');
    el.id = PANEL_ID;
    el.className = 'panel attempt-flow';
    el.setAttribute('aria-labelledby', 'attempt-flow-title');
    el.innerHTML = `
      <h2 id="attempt-flow-title">实时尝试过程</h2>
      <p class="hint" id="attempt-flow-hint">只在这一页可见时每 ${POLL_MS / 1000} 秒读取一次；内容仅在本进程内存里，
        不含 prompt、会话标签、Key 或上游错误正文。已结束的记录保留 15 分钟后自动过期，重启后清空。</p>
      <div class="attempt-flow-status" id="attempt-flow-status" role="status">尚未读取</div>
      <div class="attempt-flow-list" id="attempt-flow-active"></div>
      <details class="attempt-flow-done" id="attempt-flow-done-wrap" hidden>
        <summary id="attempt-flow-done-summary">已结束的尝试过程</summary>
        <div class="attempt-flow-list" id="attempt-flow-done"></div>
      </details>`;
    // 插在分槽用量之后、日志筛选之前:先看"现在在等谁",再看历史日志。
    const anchor = host.querySelector('.logbar');
    if (anchor && anchor.parentNode === host) host.insertBefore(el, anchor);
    else host.appendChild(el);
    return el;
  }

  // ---------------------------------------------------------------- 渲染
  const PHASE_TEXT = {
    start: '已接收，正在路由',
    attempt: '等待上游响应头',
    response: '已收到响应头，正在转发',
    error: '这一发失败',
    retry_wait: '等待后重试',
    finished: '已结束',
  };

  const ms = value => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '';
    return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
  };

  function lastEvent(trace) {
    const events = Array.isArray(trace.events) ? trace.events : [];
    return events.length ? events[events.length - 1] : null;
  }

  // 一条 trace 的"现在在干什么"。终态优先看 trace.status;进行中看最后一条事件。
  function phaseLabel(trace) {
    if (trace.terminal) return PHASE_TEXT.finished;
    const ev = lastEvent(trace);
    if (!ev) return PHASE_TEXT.start;
    const base = PHASE_TEXT[ev.phase] || ev.phase || '';
    if (ev.phase === 'retry_wait') return `${base}（约 ${ms(ev.wait_ms) || '0ms'}）`;
    return base;
  }

  function eventLine(ev) {
    const parts = [];
    if (ev.attempt) parts.push(`#${ev.attempt}`);
    if (ev.provider_id) parts.push(ev.provider_id);
    if (ev.model) parts.push(ev.model);
    if (ev.status) parts.push(String(ev.status));
    if (ev.code) parts.push(ev.code);
    if (ev.wait_ms) parts.push(`等 ${ms(ev.wait_ms)}`);
    const when = String(ev.ts || '').slice(11, 23);
    return `<li><time>${esc(when)}</time><b>${esc(PHASE_TEXT[ev.phase] || ev.phase || '')}</b>
      <span class="mono">${esc(parts.join(' · '))}</span></li>`;
  }

  function metaLine(trace) {
    const m = trace.metadata || {};
    const bits = [];
    if (m.app) bits.push(m.app);
    if (m.kind) bits.push(m.kind);
    if (m.model_in) bits.push(m.model_in);
    if (m.rule) bits.push(`规则 ${m.rule}`);
    if (m.slot) bits.push(`槽位 ${m.slot}`);
    if (m.stream) bits.push('流式');
    return bits;
  }

  function guidanceBlock(trace) {
    const key = `${trace.status || 0}|${trace.code || ''}`;
    const hit = state.guidance.get(key);
    if (!hit) {
      loadGuidance(key, trace.status, trace.code);
      return '<p class="attempt-flow-guide hint" role="status">正在读取失败解释…</p>';
    }
    if (hit.error) return `<p class="attempt-flow-guide hint">失败解释读取失败：${esc(hit.error)}</p>`;
    // target 只接受内部页面 hash(#compact 这类)。服务端已按白名单收窄,这里再挡一次:
    // 一个 href 一旦允许任意字符串,`javascript:` 就成了可执行入口,而这段文本的最终来源
    // 仍是一条 HTTP 响应 —— 两处都挡,谁被改坏都还有另一半。
    const target = /^#[a-z]+$/.test(String(hit.target || '')) ? ` <a href="${esc(hit.target)}">到控制台对应页面</a>` : '';
    const flags = [hit.uncertain ? '<span class="badge drift">可能另有原因</span>' : '', `<span class="badge info">${esc(hit.category)}</span>`].join(' ');
    return `<div class="attempt-flow-guide">
      <p class="attempt-flow-guide-title">${esc(hit.title)} ${flags}</p>
      <p class="hint"><b>影响</b>${esc(hit.impact)}</p>
      <p class="hint"><b>怎么办</b>${esc(hit.action)}${target}</p>
    </div>`;
  }

  function activeCard(trace) {
    const ev = lastEvent(trace);
    return `<article class="attempt-card${trace.terminal ? ' done' : ' live'}" data-id="${esc(trace.id)}">
      <header>
        <span class="attempt-dot" aria-hidden="true"></span>
        <b>${esc(phaseLabel(trace))}</b>
        <span class="mono">${esc(metaLine(trace).join(' · '))}</span>
        <span class="attempt-time">${esc(ms(trace.duration_ms))}</span>
      </header>
      ${ev && !trace.terminal ? `<p class="hint attempt-now">最近一步：${esc(PHASE_TEXT[ev.phase] || ev.phase)}</p>` : ''}
    </article>`;
  }

  function terminalCard(trace) {
    const open = state.open.has(trace.id);
    const events = Array.isArray(trace.events) ? trace.events : [];
    // 事件条数有上限(服务端 40 条);这里只展示最后 12 条,避免一条长重试把面板撑爆。
    // 截掉了多少要说出来 —— 默认 10 次上游 + 换 key 重试很容易超过 12 步,
    // 不说明的话,用户会以为流程从 #7 开始。
    const TAIL = 12;
    const tail = events.slice(-TAIL);
    const hiddenCount = events.length - tail.length;
    // 状态码单独染一个基调:一眼能分出成功与失败,不用逐字读数字。
    const code = Number(trace.status);
    const codeCls = !code ? '' : code >= 400 ? ' err' : ' ok';
    return `<article class="attempt-card done${open ? ' open' : ''}" data-id="${esc(trace.id)}">
      <header>
        <button type="button" class="attempt-toggle" aria-expanded="${open ? 'true' : 'false'}"
          aria-label="${open ? '收起这条尝试过程' : '展开这条尝试过程'}"
          data-attempt-toggle="${esc(trace.id)}">${open ? '▾' : '▸'}</button>
        <b class="attempt-code${codeCls}">${esc(trace.status || '-')}</b>
        <span class="mono">${esc(metaLine(trace).join(' · '))}</span>
        <span class="attempt-time">${esc(ms(trace.duration_ms))}</span>
        ${trace.code ? `<span class="cool">${esc(trace.code)}</span>` : ''}
      </header>
      ${open ? `<div class="attempt-detail">
        <p class="mono">request_id ${esc(trace.id)}</p>
        ${hiddenCount > 0 ? `<p class="hint attempt-truncated">更早的 ${hiddenCount} 步未显示（下面是最新 ${TAIL} 步）</p>` : ''}
        <ol class="attempt-events">${tail.map(eventLine).join('')}</ol>
        ${trace.status >= 400 || trace.code ? guidanceBlock(trace) : ''}
      </div>` : ''}
    </article>`;
  }

  function render() {
    const el = panel();
    if (!el) return;
    const statusEl = el.querySelector('#attempt-flow-status');
    if (state.lastError) {
      statusEl.textContent = `读取失败：${state.lastError}。显示的是上次读取的快照。`;
      statusEl.classList.add('err');
    } else {
      statusEl.textContent = state.traces.length
        ? `共 ${state.traces.length} 条记录（内存窗口最多 100 条，15 分钟未更新自动过期）`
        : '暂无记录；通过本地路由发起一次调用后会出现。';
      statusEl.classList.remove('err');
    }

    const live = state.traces.filter(t => !t.terminal).slice(0, ACTIVE_MAX);
    const done = state.traces.filter(t => t.terminal).slice(0, TERMINAL_MAX);
    // 面板在"什么都没有"时收成三行,不拿一整块空白把下面的日志表推下去;
    // 有进行中或有历史时才铺开提示文案。
    el.dataset.state = live.length ? 'live' : done.length ? 'history' : 'empty';
    const activeEl = el.querySelector('#attempt-flow-active');
    activeEl.innerHTML = live.length
      ? live.map(activeCard).join('')
      : '<p class="hint attempt-flow-empty">当前没有进行中的请求。</p>';

    const wrap = el.querySelector('#attempt-flow-done-wrap');
    wrap.hidden = done.length === 0;
    el.querySelector('#attempt-flow-done-summary').textContent = `已结束的尝试过程（最近 ${done.length} 条）`;
    el.querySelector('#attempt-flow-done').innerHTML = done.map(terminalCard).join('');
  }

  // 展开/收起只改本地状态,不重新拉取:数据已在这一轮响应里。
  function bindClicks() {
    const el = document.getElementById(PANEL_ID);
    if (!el || el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-attempt-toggle]');
      if (!btn) return;
      const id = btn.getAttribute('data-attempt-toggle');
      if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
      render();
    });
  }

  // ---------------------------------------------------------------- 数据
  async function loadGuidance(key, status, code) {
    if (state.guidance.has(key) || state.guidanceInflight.has(key)) return;
    state.guidanceInflight.add(key);
    const q = new URLSearchParams();
    if (status) q.set('status', String(status));
    if (code) q.set('err_class', String(code));
    try {
      const r = await fetch(`/api/errors/guidance?${q.toString()}`, { cache: 'no-store' });
      const body = await r.json();
      if (!r.ok) throw new Error(body && body.error ? body.error : `HTTP ${r.status}`);
      state.guidance.set(key, body);
    } catch (err) {
      state.guidance.set(key, { error: (err && err.message) || '读取失败' });
    } finally {
      state.guidanceInflight.delete(key);
      if (isActive()) render();
    }
  }

  async function refresh() {
    if (!isActive()) return;
    if (state.inflight) return;
    const controller = new AbortController();
    state.inflight = controller;
    try {
      const r = await fetch('/api/attempts', { signal: controller.signal, cache: 'no-store' });
      const body = await r.json();
      if (!r.ok) throw new Error(body && body.error ? body.error : `HTTP ${r.status}`);
      const requests = Array.isArray(body.requests) ? body.requests : [];
      state.traces = requests;
      state.lastError = '';
      // 已经不在列表里的 trace 从 open 集合里去掉,集合不会无限长。
      const ids = new Set(requests.map(t => t && t.id));
      for (const id of [...state.open]) if (!ids.has(id)) state.open.delete(id);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      state.lastError = (err && err.message) || '读取失败';
    } finally {
      state.inflight = null;
      if (isActive()) render();
    }
  }

  // 轮询只在"这一页可见 + 文档在前台 + 未离线"时跑。切走 2 秒内就会停下,
  // 回来时 showView/refresh 侧调用 AttemptFlow.refresh() 立刻补一次。
  function tick() {
    if (!isActive()) return;
    refresh();
  }

  function startPolling() {
    if (state.timer) return;
    state.timer = setInterval(tick, POLL_MS);
  }

  function mount() {
    panel();
    bindClicks();
    // 先按"空快照"渲染一次:面板刚插进 DOM 时状态行是模板里的「尚未读取」,
    // 而第一次真正读取可能因为视图还没切过来而按设计跳过 —— 那行字就会一直挂着,
    // 看着像坏了。渲染一次后它至少是诚实的"暂无记录 / 读取失败"。
    if (!state.traces.length && !state.lastError) render();
  }

  window.AttemptFlow = {
    mount,
    refresh,
    // app.js 的 showView 已按视图停/起日志轮询;这里给同一个位置一个可选钩子。
    // 没有接线时面板仍然能工作:定时器每次 tick 自己判 isActive()。
    onViewChange() {
      if (isActive()) { mount(); refresh(); }
    },
  };

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
  window.addEventListener('hashchange', () => { tick(); });
  // 首次落地可能已经停在 #diagnostics(刷新/深链):挂完面板立刻读一次,不必等第一个 2 秒。
  const boot = () => { mount(); startPolling(); tick(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
