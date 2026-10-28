'use strict';
/* Mixrouter 控制台外壳:主题、URL 深链、移动端抽屉与快速跳转。
 *
 * 这一层只处理界面偏好(视图 / 客户端 / 主题),不读写任何业务接口,也不碰渠道或路由数据。
 * 主题在 <head> 里先执行:首帧之前把偏好落到 <html data-theme>,避免刷新时先闪深色。
 * 其余监听等 DOMContentLoaded(app.js 与 usage.js 已就绪)再挂。
 *
 * 与 app.js 的接口:
 *   app.js 的 showView()/setApp() 末尾各自调用 workspaceViewChanged(name) /
 *   workspaceAppChanged(app)。没有这个文件时那两个 typeof 检查直接跳过,页面照常工作。
 */
(function () {
  const VIEWS = ['overview', 'usage', 'providers', 'compact', 'sessions', 'diagnostics', 'settings'];
  const APPS = ['claude', 'codex'];
  const LABELS = {
    overview: '概览',
    usage: '用量统计',
    providers: '渠道与 Key',
    compact: '压缩设置',
    sessions: '会话',
    diagnostics: '诊断',
    settings: '设置与备份',
  };
  // 渠道页的标题按客户端写:侧栏的两个客户端入口都落在同一个视图上,标题必须能说明现在看的是谁。
  const CLIENTS = { claude: 'Claude Code', codex: 'Codex' };
  const KEYS = { view: 'mixr.ui.view', app: 'mixr.ui.app', theme: 'mixr.ui.theme', rail: 'mixr.ui.rail' };
  const THEMES = ['system', 'light', 'dark'];
  const DEFAULT_THEME = 'system';
  const DEFAULT_VIEW = 'overview';
  const DEFAULT_APP = 'claude';

  const state = { view: DEFAULT_VIEW, app: DEFAULT_APP, theme: DEFAULT_THEME };
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  let initialized = false;
  let drawerOpen = false;
  let quickOpen = false;
  let quickIndex = -1;
  let quickItems = [];
  let quickNodes = [];
  let quickReturnFocus = null;

  // ---------------------------------------------------------------- 存储

  function storage() {
    try { return typeof window !== 'undefined' ? window.localStorage || null : null; }
    catch { return null; }
  }
  function readPref(key) {
    const store = storage();
    if (!store) return null;
    try { return store.getItem(key); } catch { return null; }
  }
  function writePref(key, value) {
    const store = storage();
    if (!store) return;
    try { store.setItem(key, value); } catch { /* 隐私模式或配额满:偏好没存下,当次仍然生效 */ }
  }

  // ---------------------------------------------------------------- DOM 小工具

  function el(id) {
    try { return document.getElementById(id); } catch { return null; }
  }
  function all(selector) {
    try { return Array.from(document.querySelectorAll(selector)); } catch { return []; }
  }
  function hasGlobalFunction(name) {
    try { return typeof window !== 'undefined' && typeof window[name] === 'function'; }
    catch { return false; }
  }
  function isDialogOpen() {
    // app.js 的 let activeDialog 与这里共享同一个全局词法环境。
    try { return typeof activeDialog !== 'undefined' && !!activeDialog; } catch { return false; }
  }
  function currentHash() {
    try { return String(window.location.hash || ''); } catch { return ''; }
  }
  // 输入框里的 Ctrl+K 是系统自带的「删到行尾」,不能抢;Cmd+K 在所有位置都保留给跳转。
  function isEditableTarget(target) {
    if (!target) return false;
    const tag = String(target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    try { return target.isContentEditable === true; } catch { return false; }
  }

  // ---------------------------------------------------------------- 主题

  function normalizeTheme(value) {
    return THEMES.includes(value) ? value : DEFAULT_THEME;
  }
  function applyTheme(value, persist) {
    state.theme = normalizeTheme(value);
    if (root) {
      if (state.theme === 'system') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', state.theme);
      // 让原生控件(滚动条、日期选择器)跟着主题走;颜色变量本身交给 CSS。
      try { root.style.colorScheme = state.theme === 'system' ? 'light dark' : state.theme; } catch {}
    }
    const select = el('theme-select');
    if (select && select.value !== state.theme) select.value = state.theme;
    if (persist) writePref(KEYS.theme, state.theme);
  }

  // 在脚本解析时就落一次主题(此时还在 <head>,样式表尚未生效)。
  applyTheme(readPref(KEYS.theme) || DEFAULT_THEME, false);

  // ---------------------------------------------------------------- 侧栏收起(桌面)

  // 收起状态写在 <html data-sidebar="rail"> 上而不是 body:<head> 里就能落,刷新不闪。
  // 窄屏由样式表忽略这个属性,那里侧栏是抽屉,由 setDrawer 管。
  let rail = false;
  function applyRail(value, persist) {
    rail = !!value;
    if (root) {
      if (rail) root.setAttribute('data-sidebar', 'rail');
      else root.removeAttribute('data-sidebar');
    }
    const collapse = el('sidebar-collapse');
    if (collapse) {
      collapse.setAttribute('aria-expanded', String(!rail));
      collapse.setAttribute('aria-label', rail ? '展开侧栏' : '收起侧栏');
      collapse.setAttribute('title', rail ? '展开侧栏' : '收起侧栏');
    }
    // 顶栏那个开关在桌面端只用来把收起的侧栏叫回来;标签跟着这个用途写,
    // 窄屏仍由 setDrawer 按抽屉开合改写。
    const toggle = el('sidebar-toggle');
    if (toggle && !drawerOpen) toggle.setAttribute('aria-label', rail ? '展开侧栏' : '打开导航');
    if (persist) writePref(KEYS.rail, rail ? '1' : '0');
  }
  applyRail(readPref(KEYS.rail) === '1', false);

  // ---------------------------------------------------------------- 路由

  function parseRoute(hash) {
    const raw = String(hash == null ? '' : hash).replace(/^#/, '');
    if (!raw) return null;
    // skip-link 指向正文锚点 #main:它不是视图,但也绝不能当成"非法视图"跳回概览。
    if (raw === 'main') return { view: null, app: null, invalid: false, anchor: 'main' };
    const parts = raw.split('?');
    let name = parts[0];
    // 旧深链:#routes 的通用路由编辑器已删除,压缩设置独立成 #compact —— 直接归一到新视图,
    // 老书签还能落到管压缩的那一页,而不是掉回概览。已删掉的其它视图按非法视图回默认。
    if (name === 'routes') name = 'compact';
    if (!VIEWS.includes(name)) return { view: null, app: null, invalid: true };
    let app = null;
    if (name === 'providers') {
      for (const pair of (parts[1] || '').split('&')) {
        const at = pair.indexOf('=');
        if (at < 0) continue;
        if (pair.slice(0, at) === 'app') {
          const value = pair.slice(at + 1);
          // 已删除的客户端(如 zcode)不再有效:落回默认客户端,不改写用户已经打开的其他页面。
          if (APPS.includes(value)) app = value;
        }
      }
    }
    return { view: name, app, invalid: false };
  }
  function routeHash(viewName, appName) {
    const name = VIEWS.includes(viewName) ? viewName : DEFAULT_VIEW;
    const app = APPS.includes(appName) ? appName : DEFAULT_APP;
    // 只有渠道页有客户端标签,app 也只在这里进 URL;其余页面保持干净的 #view。
    return name === 'providers' && app !== DEFAULT_APP ? `#${name}?app=${app}` : `#${name}`;
  }
  function savedView() {
    const value = readPref(KEYS.view);
    return VIEWS.includes(value) ? value : null;
  }
  function savedApp() {
    const value = readPref(KEYS.app);
    return APPS.includes(value) ? value : null;
  }

  // 重定向(非法 hash、锚点归位)不是用户导航:期间不许再写一条 hash 历史,
  // 结束后用 replaceState 把 URL 归一到当前状态。否则一次 `#not-a-view` 会留下
  // 「坏 hash → 概览」两条记录,按后退又回到坏 hash。
  let suppressHash = false;
  function syncHash() {
    if (!initialized || suppressHash) return;
    const want = routeHash(state.view, state.app);
    if (currentHash() === want) return;
    // 每次导航都进历史记录,浏览器前进/后退能按 hashchange 回到上一页。
    try { window.location.hash = want; } catch {}
  }
  function rewriteHash() {
    const want = routeHash(state.view, state.app);
    if (currentHash() === want) return;
    try { window.history.replaceState(null, '', want); return; } catch {}
    try { window.location.hash = want; } catch {}
  }
  function redirectTo(viewName, appName) {
    const nextApp = APPS.includes(appName) ? appName : state.app;
    // 状态已经一致时只改写 URL:再调一次 setApp/showView 会白白重渲染一页。
    if (state.view !== viewName || state.app !== nextApp) {
      suppressHash = true;
      try { navigateTo(viewName, nextApp); }
      finally { suppressHash = false; }
    }
    rewriteHash();
  }

  function focusMain() {
    const main = el('main');
    if (main && typeof main.focus === 'function') main.focus();
  }
  function hasClass(node, name) {
    if (!node) return false;
    if (node.classList && typeof node.classList.contains === 'function') {
      if (node.classList.contains(name)) return true;
    }
    return String(node.className || '').split(/\s+/).includes(name);
  }
  function childNodes(node) {
    return node && node.children ? Array.prototype.slice.call(node.children) : [];
  }
  function viewTitle(viewName, appName) {
    if (viewName === 'providers') {
      const app = APPS.includes(appName) ? appName : DEFAULT_APP;
      return `${CLIENTS[app]} 渠道`;
    }
    return LABELS[viewName] || LABELS.overview;
  }
  function setTitle(viewName, appName) {
    const title = viewTitle(viewName, appName);
    // #breadcrumb-view 就是顶栏那个大标题。app.js 在 showView 里先写通用名,这里再按客户端收口:
    // 它一定跑在钩子之后,所以最终显示以这里为准。
    const node = el('breadcrumb-view');
    if (node) node.textContent = title;
    try { document.title = `${title} · Mixrouter`; } catch {}
  }
  // 客户端入口与普通页面入口共用一套 active:一个 data-app 链接只有在“渠道页 + 这个客户端”时亮,
  // 普通链接只看视图名。两者互斥,页面上永远只有一个 aria-current。
  function setNavState(viewName, appName) {
    const app = APPS.includes(appName) ? appName : state.app;
    for (const link of all('nav a')) {
      const data = link.dataset || {};
      const on = data.app
        ? (viewName === 'providers' && data.view === 'providers' && data.app === app)
        : (data.view === viewName && !data.app);
      link.classList.toggle('active', on);
      if (on) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  // ---------------------------------------------------------------- 顶栏外壳

  // 每个视图的 .head > .actions 原样搬进顶栏,切页时再放回它自己的 head。
  // 记下原父节点与它后面的兄弟,回来时才能保持原有顺序(而不是一律追加到末尾)。
  let actionsRecord = null;
  function restorePageActions() {
    const record = actionsRecord;
    actionsRecord = null;
    if (!record || !record.node || !record.parent) return;
    try {
      if (record.next && record.next.parentElement === record.parent) record.parent.insertBefore(record.node, record.next);
      else record.parent.appendChild(record.node);
    } catch {
      try { record.parent.appendChild(record.node); } catch {}
    }
  }
  function adoptPageActions(viewName) {
    const tray = el('topbar-page-actions');
    if (!tray) return;
    restorePageActions();
    const section = el('view-' + viewName);
    if (!section) return;
    let head = null;
    for (const child of childNodes(section)) if (hasClass(child, 'head')) { head = child; break; }
    if (!head) return;
    let actions = null;
    for (const child of childNodes(head)) if (hasClass(child, 'actions')) { actions = child; break; }
    if (!actions) return;
    const parent = actions.parentElement || head;
    const siblings = childNodes(parent);
    const index = siblings.indexOf(actions);
    actionsRecord = { node: actions, parent, next: index >= 0 ? siblings[index + 1] || null : null };
    try { tray.appendChild(actions); } catch { actionsRecord = null; }
  }

  // 顶栏图标只是当前页的注脚:渠道页按客户端区分,其余按视图。字符串全是本文件里的常量。
  const ICONS = {
    overview: '<rect x="2.5" y="2.5" width="5.2" height="5.2" rx="1.2"/><rect x="10.3" y="2.5" width="5.2" height="5.2" rx="1.2"/><rect x="2.5" y="10.3" width="5.2" height="5.2" rx="1.2"/><rect x="10.3" y="10.3" width="5.2" height="5.2" rx="1.2"/>',
    compact: '<path d="M3 5.5h12M3 12.5h12"/><path d="M6.5 5.5 9 3l2.5 2.5M6.5 12.5 9 15l2.5-2.5"/>',
    sessions: '<path d="M3 4h12v7.5H8L4.5 14v-2.5H3z"/><path d="M6 7h6"/>',
    usage: '<path d="M2.5 14.5h13"/><path d="M5 14V9M9 14V5M13 14v-3"/>',
    diagnostics: '<path d="M2 9h3l2-4 3 8 2-4h4"/>',
    settings: '<path d="M3 5.5h12M3 12.5h12"/><circle cx="7" cy="5.5" r="1.6"/><circle cx="11.5" cy="12.5" r="1.6"/>',
    claude: '<rect x="2.5" y="3" width="13" height="5" rx="1.5"/><rect x="2.5" y="10" width="13" height="5" rx="1.5"/><path d="M5.5 5.5h.01M5.5 12.5h.01"/>',
    codex: '<path d="M3 5.5 9 3l6 2.5v7L9 15l-6-2.5z"/><path d="M3 5.5 9 8l6-2.5M9 8v7"/>',
  };
  function setViewIcon(viewName, appName) {
    const icon = el('topbar-view-icon');
    if (!icon) return;
    const key = viewName === 'providers'
      ? (APPS.includes(appName) ? appName : DEFAULT_APP)
      : viewName;
    const parts = ICONS[key] || ICONS.overview;
    try {
      icon.innerHTML = '<svg viewBox="0 0 18 18" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + parts + '</svg>';
    } catch { /* 没有 innerHTML 的环境(测试替身)只跳过图标 */ }
  }

  function syncBodyState(viewName, appName) {
    const body = document.body;
    if (!body) return;
    try { body.setAttribute('data-view', viewName); } catch {}
    try { body.setAttribute('data-app', APPS.includes(appName) ? appName : DEFAULT_APP); } catch {}
  }
  // 用量页有自己的「立即同步」,顶栏的全局刷新在那里只会让人以为数据没刷新;其余页保留。
  function syncRefresh(viewName) {
    const button = el('refresh-btn');
    if (button) button.hidden = viewName === 'usage';
  }
  function eachH1(node, fn) {
    for (const child of childNodes(node)) {
      if (String(child.tagName || '').toUpperCase() === 'H1') fn(child);
      eachH1(child, fn);
    }
  }
  // shell-ready 之后顶栏已经给出页标题,章节里的 h1 只留语义:视觉上藏起来,读屏照常读。
  // 样式表按 body.shell-ready 处理;这里同时补 sr-only,脚本单独也能保证不出现两个大标题。
  function markShellReady() {
    const body = document.body;
    if (!body) return;
    try { body.classList.add('shell-ready'); } catch {}
    for (const name of VIEWS) {
      eachH1(el('view-' + name), h1 => {
        if (h1 && h1.classList && typeof h1.classList.add === 'function') h1.classList.add('sr-only');
      });
    }
  }
  function syncChrome(viewName, appName) {
    setNavState(viewName, appName);
    setViewIcon(viewName, appName);
    adoptPageActions(viewName);
    syncRefresh(viewName);
    syncBodyState(viewName, appName);
    setTitle(viewName, appName);
  }

  // 内层导航:先确定目标状态,再调用 app.js。两个 hook 里读到的 state 已经是新值,
  // 所以 setApp 与 showView 先后触发时不会各写一条历史记录。
  function navigateTo(viewName, appName) {
    if (!VIEWS.includes(viewName)) return;
    const nextApp = APPS.includes(appName) ? appName : state.app;
    state.view = viewName;
    state.app = nextApp;
    // 先落外壳(导航、标题、顶栏动作),再让 app.js 切视图:钩子回来时状态已经是新的,
    // 不会先闪一下旧标题或旧动作。
    syncChrome(viewName, nextApp);
    if (hasGlobalFunction('setApp')) { try { window.setApp(nextApp); } catch (e) { console.error(e); } }
    if (hasGlobalFunction('showView')) { try { window.showView(viewName); } catch (e) { console.error(e); } }
    syncHash();
  }

  function onRouteChange() {
    const route = parseRoute(currentHash());
    if (!route) return;                     // 没有 hash:保持当前视图
    if (route.anchor === 'main') {
      // skip-link:滚动交给浏览器,这里只把焦点补到正文并把 URL 归位到当前视图。
      // 归位必须 replaceState,否则点一次「跳至主要内容」就多一条历史。
      focusMain();
      rewriteHash();
      return;
    }
    if (route.invalid) {                    // 旧书签或手写错的视图名:回概览,并改写 URL
      redirectTo(DEFAULT_VIEW, state.app);
      return;
    }
    // 裸 #providers 一律代表 Claude:URL 是历史记录的一部分,不能拿"上次保存的客户端"去解释它,
    // 否则从 #providers?app=codex 后退回 #providers 会停在 Codex(用户看到的 URL 与页面不符)。
    // 首次落地没有 hash 时才恢复保存的偏好(见 init)。
    const nextApp = route.view === 'providers' ? (route.app || DEFAULT_APP) : state.app;
    if (route.view === state.view && nextApp === state.app) return;
    navigateTo(route.view, nextApp);
  }

  function bindRoute() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('popstate', onRouteChange);
  }

  // skip-link 是页面内锚点:自己接管这次跳转,焦点直接给正文。
  // 不接管的话浏览器会先压一条 #main 历史记录,再被 onRouteChange 改写成当前视图 ——
  // 记录数没变少,后退还会多停在同一个页面上。JS 不在时原生锚点照常工作。
  function bindSkipLink() {
    const link = (() => {
      try { return document.querySelector('.skip-link'); } catch { return null; }
    })();
    if (!link || typeof link.addEventListener !== 'function') return;
    link.addEventListener('click', event => {
      if (event.preventDefault) event.preventDefault();
      focusMain();
      // focus() 在多数浏览器里会滚动到目标;显式再滚一次,兼容 tabindex=-1 的容器。
      const main = el('main');
      if (main && typeof main.scrollIntoView === 'function') {
        try { main.scrollIntoView({ block: 'start' }); } catch {}
      }
      rewriteHash();
    });
  }

  // ---------------------------------------------------------------- 移动端抽屉

  function isMobileDrawer() {
    try { return !!(window.matchMedia && window.matchMedia('(max-width: 860px)').matches); }
    catch { return false; }
  }
  // 窄屏下收起的抽屉只是移出视口,链接仍在 Tab 序列里。用 inert 把它真正摘出去:
  // 弹窗开着时同样 inert(与 app.js showDialog 的做法一致),两种原因取并集,
  // 所以这里不会把弹窗设置的 inert 提前放开。
  function syncSidebarInert() {
    const sidebar = el('sidebar');
    if (!sidebar) return;
    const wanted = isDialogOpen() || (isMobileDrawer() && !drawerOpen);
    if (!!sidebar.inert !== wanted) sidebar.inert = wanted;
  }
  function watchSidebarInert() {
    const sidebar = el('sidebar');
    if (!sidebar || typeof MutationObserver !== 'function') return;
    // app.js 的 hideDialog 会无条件把 sidebar.inert 置回 false;窄屏下若抽屉仍收着,
    // 这里把它补回来,免得键盘又能 Tab 进看不见的导航。
    try {
      new MutationObserver(() => syncSidebarInert()).observe(sidebar, { attributes: true, attributeFilter: ['inert'] });
    } catch { /* 没有 MutationObserver 时只在状态切换处同步 */ }
  }

  function setDrawer(open, options = {}) {
    const next = !!open;
    if (next === drawerOpen && !options.force) return;
    drawerOpen = next;
    try { document.body.classList.toggle('nav-open', drawerOpen); } catch {}
    const toggle = el('sidebar-toggle');
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(drawerOpen));
      // 桌面端这个按钮在收起侧栏后出现,它那时的用途是「展开侧栏」;窄屏才是抽屉开关。
      toggle.setAttribute('aria-label', drawerOpen ? '关闭导航' : (rail && !isMobileDrawer() ? '展开侧栏' : '打开导航'));
    }
    const backdrop = el('sidebar-backdrop');
    if (backdrop) backdrop.hidden = !drawerOpen;
    syncSidebarInert();
    if (drawerOpen) {
      const first = all('nav a')[0];
      if (first && typeof first.focus === 'function') first.focus();
    } else if (options.restoreFocus && toggle && typeof toggle.focus === 'function') {
      toggle.focus();
    }
  }
  function openDrawer() {
    if (drawerOpen || quickOpen || isDialogOpen()) return;
    setDrawer(true);
  }
  function closeDrawer(options = {}) {
    if (!drawerOpen) return;
    setDrawer(false, options);
  }
  // 抽屉打开时焦点只能在这几项里循环:抽屉里的链接 + 顶栏的开关(唯一的关闭手段)。
  // 不能把整个 workspace inert 掉——开关就在里面,那样等于没有关闭方式。
  function drawerFocusables() {
    const items = all('nav a').filter(link => typeof link.focus === 'function');
    const toggle = el('sidebar-toggle');
    if (toggle && typeof toggle.focus === 'function') items.push(toggle);
    return items;
  }
  function trapDrawerTab(event) {
    if (!drawerOpen || !isMobileDrawer()) return false;
    const items = drawerFocusables();
    if (!items.length) return false;
    const first = items[0], last = items[items.length - 1];
    let active = null;
    try { active = document.activeElement; } catch {}
    if (!items.includes(active)) {
      if (event.preventDefault) event.preventDefault();
      first.focus();
      return true;
    }
    if (event.shiftKey && active === first) {
      if (event.preventDefault) event.preventDefault();
      last.focus();
      return true;
    }
    if (!event.shiftKey && active === last) {
      if (event.preventDefault) event.preventDefault();
      first.focus();
      return true;
    }
    return false;
  }

  function bindDrawer() {
    const toggle = el('sidebar-toggle');
    if (toggle) toggle.addEventListener('click', () => {
      // 桌面端这个按钮只有在侧栏收起后才出现,那时点它就是展开;其余情况仍是抽屉开关。
      if (rail && !isMobileDrawer()) { applyRail(false, true); focusFirstNav(); return; }
      if (drawerOpen) closeDrawer({ restoreFocus: true });
      else openDrawer();
    });
    const collapse = el('sidebar-collapse');
    if (collapse) collapse.addEventListener('click', () => {
      applyRail(true, true);
      const reopen = el('sidebar-toggle');
      if (reopen && typeof reopen.focus === 'function') reopen.focus();
    });
    const backdrop = el('sidebar-backdrop');
    if (backdrop) backdrop.addEventListener('click', () => closeDrawer({ restoreFocus: true }));
    try {
      const media = window.matchMedia && window.matchMedia('(min-width: 861px)');
      const onChange = event => { if (event.matches) closeDrawer({ restoreFocus: false }); syncSidebarInert(); };
      if (media && typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
      else if (media && typeof media.addListener === 'function') media.addListener(onChange);
    } catch { /* 没有 matchMedia 时抽屉仍可手动开关 */ }
  }
  // 展开后把焦点交给第一个导航项,键盘用户不用重新找位置。
  function focusFirstNav() {
    const first = all('nav a')[0];
    if (first && typeof first.focus === 'function') first.focus();
  }

  // ---------------------------------------------------------------- 快速跳转

  const PALETTE = [
    { view: 'overview', label: '概览', hint: '状态、待办与客户端接入' },
    { view: 'providers', label: '渠道与 Key', hint: '上游渠道与客户端接入', keywords: 'provider key' },
    { view: 'compact', label: '压缩设置', hint: '压缩模型与三层压缩窗口', keywords: 'compact window 压缩' },
    { view: 'sessions', label: '会话绑定', hint: '按会话配置渠道与 Key', keywords: 'session' },
    { view: 'usage', label: '用量统计', hint: '请求、tokens 与缓存命中', keywords: 'usage token' },
    { view: 'diagnostics', label: '诊断', hint: '请求日志与分槽用量', keywords: 'log logs' },
    { view: 'settings', label: '设置与备份', hint: '备份清点、健康与导出', keywords: 'settings backup' },
    { view: 'providers', app: 'claude', label: 'Claude Code 渠道', hint: '渠道与 Key', keywords: 'claude anthropic' },
    { view: 'providers', app: 'codex', label: 'Codex 渠道', hint: '渠道与 Key', keywords: 'codex openai' },
  ];

  function paletteMatches(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return PALETTE.slice();
    return PALETTE.filter(item =>
      `${item.label} ${item.hint} ${item.keywords || ''}`.toLowerCase().includes(q));
  }

  function setQuickActive(next) {
    if (!quickItems.length) {
      quickIndex = -1;
      return;
    }
    quickIndex = (next + quickItems.length) % quickItems.length;
    const input = el('quick-nav-input');
    quickNodes.forEach((node, index) => {
      node.setAttribute('aria-selected', String(index === quickIndex));
    });
    if (input && quickNodes[quickIndex]) input.setAttribute('aria-activedescendant', quickNodes[quickIndex].id);
    const active = quickNodes[quickIndex];
    if (active && typeof active.scrollIntoView === 'function') {
      try { active.scrollIntoView({ block: 'nearest' }); } catch {}
    }
  }

  function renderQuickList(query) {
    const list = el('quick-nav-list');
    const empty = el('quick-nav-empty');
    quickItems = paletteMatches(query);
    quickNodes = [];
    if (list) {
      while (list.firstChild) list.removeChild(list.firstChild);
      quickItems.forEach((item, index) => {
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'quick-nav-item';
        node.id = 'quick-nav-opt-' + index;
        node.setAttribute('role', 'option');
        node.setAttribute('tabindex', '-1');
        node.dataset.index = String(index);
        const label = document.createElement('span');
        label.className = 'quick-nav-item-label';
        label.textContent = item.label;
        const hint = document.createElement('span');
        hint.className = 'mono';
        hint.textContent = item.hint;
        node.appendChild(label);
        node.appendChild(hint);
        node.addEventListener('click', () => chooseQuickItem(index));
        list.appendChild(node);
        quickNodes.push(node);
      });
    }
    if (empty) empty.hidden = quickItems.length > 0;
    const input = el('quick-nav-input');
    if (input) input.setAttribute('aria-expanded', String(quickItems.length > 0));
    setQuickActive(0);
  }

  function openQuickNav() {
    if (quickOpen || isDialogOpen()) return false;
    const dialog = el('quick-nav-mask');
    if (!dialog) return false;
    if (drawerOpen) closeDrawer({ restoreFocus: false });
    quickReturnFocus = document.activeElement || null;
    quickOpen = true;
    const input = el('quick-nav-input');
    if (input) input.value = '';
    renderQuickList('');
    // hidden 只是样式表 display:flex 的兜底;打开时先放开再 showModal。
    dialog.hidden = false;
    if (typeof dialog.showModal === 'function') {
      try { dialog.showModal(); } catch {}
    } else {
      dialog.setAttribute('open', '');
    }
    if (input && typeof input.focus === 'function') input.focus();
    return true;
  }

  function closeQuickNav(options = {}) {
    if (!quickOpen) return;
    quickOpen = false;
    quickIndex = -1;
    const dialog = el('quick-nav-mask');
    if (dialog) {
      const open = dialog.open === true || (typeof dialog.hasAttribute === 'function' && dialog.hasAttribute('open'));
      if (open) {
        if (typeof dialog.close === 'function') { try { dialog.close(); } catch {} }
        else dialog.removeAttribute('open');
      }
      dialog.hidden = true;
    }
    if (options.restoreFocus) {
      const target = quickReturnFocus && quickReturnFocus.isConnected !== false ? quickReturnFocus : el('quick-nav-open');
      if (target && typeof target.focus === 'function') target.focus();
    }
    quickReturnFocus = null;
  }

  function chooseQuickItem(index) {
    const item = quickItems[index];
    if (!item) return;
    closeQuickNav({ restoreFocus: false });
    navigateTo(item.view, item.app || state.app);
    focusMain();
  }

  function bindQuickNav() {
    const opener = el('quick-nav-open');
    if (opener) opener.addEventListener('click', () => openQuickNav());
    const dialog = el('quick-nav-mask');
    if (!dialog) return;
    const input = el('quick-nav-input');
    if (input) {
      input.addEventListener('input', () => renderQuickList(input.value));
      input.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setQuickActive(quickIndex + (event.key === 'ArrowDown' ? 1 : -1));
        } else if (event.key === 'Enter') {
          if (quickIndex < 0) return;
          event.preventDefault();
          chooseQuickItem(quickIndex);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closeQuickNav({ restoreFocus: true });
        }
      });
    }
    dialog.addEventListener('click', event => {
      if (event.target === dialog) closeQuickNav({ restoreFocus: true });
    });
    // 原生 dialog 的 Esc 会先发 cancel;统一走自己的关闭逻辑,保证焦点回到打开前的位置。
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeQuickNav({ restoreFocus: true });
    });
    // 焦点落在列表项上时(指针点击前)也让方向键可用
    dialog.addEventListener('keydown', event => {
      if (event.target === input) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeQuickNav({ restoreFocus: true });
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setQuickActive(quickIndex + (event.key === 'ArrowDown' ? 1 : -1));
      }
    });
  }

  // ---------------------------------------------------------------- 全局按键

  function onKeydown(event) {
    if (event.defaultPrevented) return;
    const key = event.key;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (key === 'k' || key === 'K')) {
      // 别的弹窗开着时不抢键,也不 preventDefault:浏览器自己的查找/地址栏行为保持不变。
      if (isDialogOpen()) return;
      if (!event.metaKey && isEditableTarget(event.target)) return;
      if (event.preventDefault) event.preventDefault();
      if (quickOpen) closeQuickNav({ restoreFocus: true });
      else openQuickNav();
      return;
    }
    if (quickOpen) return;                  // 自己处理,别和抽屉的 Esc 抢
    if (key === 'Tab' && trapDrawerTab(event)) return;
    if (key === 'Escape' && drawerOpen && !isDialogOpen()) {
      if (event.preventDefault) event.preventDefault();
      closeDrawer({ restoreFocus: true });
    }
  }

  function bindGlobalKeys() {
    try { document.addEventListener('keydown', onKeydown); } catch {}
    try {
      document.addEventListener('focusin', () => {
        // 模态弹窗打开时把抽屉收起,避免两层浮层叠在一起。
        if (drawerOpen && isDialogOpen()) closeDrawer({ restoreFocus: false });
        // app.js hideDialog() 会无条件把 sidebar.inert 置回 false;焦点一离开弹窗就把
        // 「窄屏 + 抽屉收着 ⇒ inert」补回来(没有 MutationObserver 的老环境靠这条兜底)。
        syncSidebarInert();
      });
    } catch {}
  }

  // ---------------------------------------------------------------- app.js 钩子

  function workspaceViewChanged(name) {
    if (!VIEWS.includes(name)) return;
    const wasDrawer = drawerOpen;
    state.view = name;
    writePref(KEYS.view, name);
    closeDrawer({ restoreFocus: false });
    if (wasDrawer) focusMain();
    syncHash();
    // 钩子里的标题必须按当前客户端收口:切到渠道页时 URL 里带的是 app,不是视图名。
    syncChrome(state.view, state.app);
    syncSidebarInert();
  }
  function workspaceAppChanged(app) {
    if (!APPS.includes(app)) return;
    state.app = app;
    writePref(KEYS.app, app);
    syncHash();
    syncChrome(state.view, state.app);
    syncSidebarInert();
  }

  try {
    window.workspaceViewChanged = workspaceViewChanged;
    window.workspaceAppChanged = workspaceAppChanged;
    // 侧栏链接点击走这里:一次性给出视图与客户端,只写一条 URL 历史(app.js 的 onclick 会用)。
    window.workspaceNavigate = navigateTo;
  } catch {}

  // ---------------------------------------------------------------- 初始化

  function init() {
    if (initialized) return;
    applyTheme(readPref(KEYS.theme) || DEFAULT_THEME, false);
    const themeSelect = el('theme-select');
    if (themeSelect) themeSelect.addEventListener('change', () => applyTheme(themeSelect.value, true));
    // 快捷键提示按平台写,不让人去试一个在这台机器上不存在的组合。
    const kbd = el('quick-nav-kbd');
    if (kbd) {
      let mac = false;
      try { mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || ''); } catch {}
      kbd.textContent = mac ? '⌘K' : 'Ctrl K';
    }

    const route = parseRoute(currentHash());
    const initialView = route && route.view ? route.view : (route && route.invalid ? DEFAULT_VIEW : (savedView() || DEFAULT_VIEW));
    // 显式的 #providers(哪怕没有 ?app=)代表 Claude;只有完全没带视图信息时(首次打开、
    // 或 #main 锚点)才恢复上次选过的客户端。
    const initialApp = route && route.view
      ? (route.view === 'providers' ? (route.app || DEFAULT_APP) : (savedApp() || DEFAULT_APP))
      : (savedApp() || DEFAULT_APP);

    bindDrawer();
    bindQuickNav();
    bindRoute();
    bindSkipLink();
    bindGlobalKeys();

    // 初始化期间钩子不写 URL:最后用 replaceState 归一到解析结果,不额外产生一条历史记录。
    navigateTo(initialView, initialApp);
    initialized = true;
    rewriteHash();
    setTitle(state.view, state.app);
    // 外壳接管标题之后再加这个类:没有 JS 时章节 h1 仍是页面上唯一的标题。
    markShellReady();
    watchSidebarInert();
    syncSidebarInert();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})();
