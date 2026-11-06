'use strict';
// ---------------- 会话 ----------------
const KIND_LABEL = { header: '会话头', metadata: 'metadata', fingerprint: '内容指纹', anon: '无身份' };
let sessApp = '', sessQuery = '', lastSessHtml = null;
// 会话页要同时读出三层,不能混成一个"已绑定":
//   required(用户要求) —— 本会话的渠道级 Key / 槽位覆盖,见 routingCell()
//   bound(当前绑定)    —— 现在会落到哪个渠道,以及这个落点是手动钉的还是自动分的
//   actual(最近实际请求)—— 最近一次**真的发出去**的请求落在哪;没有记录就是「暂无」
// 新版 /api/state 直接给结构化的 bound/actual;旧快照只有平铺的 provider/pinned,
// 这里按同一口径补齐,而不是让缺字段渲染成"未绑定"或"暂无"(那会把两种完全不同的情况
// 显示成一样)。补齐只影响显示,不改 state 本身。
function boundOf(s) {
  if (s.bound && typeof s.bound === 'object') return s.bound;
  const provider = s.provider || '';
  return { provider, provider_name: s.provider_name || '', model: s.model || '', rule: s.rule || '',
    pinned: !!s.pinned, source: !provider ? 'none' : (s.pinned ? 'manual' : 'auto') };
}
// 只有服务端记了实际请求才算实际落点。actual_source 缺省(旧快照)时以 actual 是否存在为准。
function actualOf(s) {
  if (s.actual_source === 'none') return null;
  return s.actual && typeof s.actual === 'object' ? s.actual : null;
}
// 绑定来源。显式 source 优先;旧快照没有 source 就用 pinned 推。
// 没有落点就无从谈来源,一律 none —— 免得"渠道被删了但绑定还在"被显示成自动分配。
function boundSourceOf(b) {
  if (!b.provider) return 'none';
  if (b.source === 'manual' || b.source === 'auto') return b.source;
  return b.pinned ? 'manual' : 'auto';
}
const BOUND_SOURCE = { manual: ['手动钉定', 'pin'], auto: ['自动分配', 'auto'], none: ['未绑定', 'off'] };
// 旧会话的对话名可能是从 system / developer 块里抽出来的(AGENTS.md、<INSTRUCTIONS>、<environment_context> …),
// 不是用户起的标题。显示成一句人话,原文留在 title 和搜索里;后端已改抽取逻辑,这里只兜旧数据。
const SYSTEM_LABEL_RE = /^\s*(?:#|<|(?:AGENTS|CLAUDE)\.md\b)/i;
function sessionLabelHtml(label) {
  if (!label) return '<span class="lbl" title="">—</span>';
  if (SYSTEM_LABEL_RE.test(label)) return `<span class="lbl lbl-system" title="${esc(label)}">系统指令，无标题</span>`;
  return `<span class="lbl" title="${esc(label)}">${esc(label)}</span>`;
}
// 搜索框里没有筛东西、也没选协议组 —— 空表的文案要按它决定该劝"换关键词"还是"换分组"。
const sessionFiltered = () => !!sessQuery.trim() || !!sessApp;
// 搜索命中面:短 id / 完整 id / 对话名 / 绑定渠道(名字与 id 都算)。
// 渠道名要现查一次 state.providers —— 会话记录里的 provider_name 在旧快照里没有。
function sessionMatches(s, q) {
  const b = boundOf(s);
  const p = (state?.providers?.[s.app || 'claude'] || []).find(x => x.id === b.provider);
  return [s.short, s.key, s.label, b.provider, b.provider_name, p?.name]
    .some(x => String(x || '').toLowerCase().includes(q));
}
// 搜索框的输入只准重渲染,不准碰任何数据。曾经有过"压缩控件冒泡事件污染通用路由草稿"的事故,
// 所以这里写死:setSessQuery 只改 sessQuery 这个筛选词,会话、compactDraft 一概不动。
// 过滤后的行数变化只发生在渲染层(state.sessions 始终是服务端那一份)。
function setSessQuery(value) {
  sessQuery = String(value ?? '');
  renderSessions();
}
function clearSessionFilters() {
  sessQuery = ''; sessApp = '';
  const sel = $('f-sess-app');
  if (sel) sel.value = '';
  const search = $('sess-search');
  if (search) search.value = '';
  renderSessions();
}
function renderSessions() {
  if (!state) return;
  const all = state.sessions || [];
  const inApp = sessApp ? all.filter(s => (s.app || 'claude') === sessApp) : all;
  const q = sessQuery.trim().toLowerCase();
  const list = q ? inApp.filter(s => sessionMatches(s, q)) : inApp;

  $('sess-empty').style.display = list.length ? 'none' : '';
  if (list.length) delete $('view-sessions').dataset.empty; else $('view-sessions').dataset.empty = '';
  const noSess = $('sess-empty-title'), hint = $('sess-empty-hint'), action = $('sess-empty-action');
  // 空表要说清是"筛没了"还是"真没有"。会话本身就一条都没有时,任何筛选条件都无关,
  // 文案就不能再劝"清空搜索"——那时给的是发起对话的指引,按钮也不摆。
  if (!all.length) {
    noSess.textContent = '还没有匹配的会话';
    hint.textContent = '通过本地路由发起对话后，会话绑定会出现在所属协议组；也可以调整分组筛选。';
    action.hidden = true;
  } else if (!list.length && sessionFiltered()) {
    noSess.textContent = '没有匹配当前搜索与筛选的会话';
    hint.textContent = `共 ${all.length} 个会话${sessApp ? `，其中 ${inApp.length} 个属于所选协议组` : ''}；换个关键词，或清空条件看全部。`;
    action.hidden = false; action.textContent = '清除搜索与筛选';
  } else {
    noSess.textContent = '当前协议组没有匹配的会话';
    hint.textContent = `其他协议组还有 ${all.length} 个会话；清空筛选即可看到。`;
    action.hidden = false; action.textContent = '显示全部协议组';
  }
  // 会话表为空时那句"共 N 个会话"只是去重后的数字,下面再给一条看得见短 id 的原始清单:
  // 用户搜完发现没命中,下一步得能盯着 id 核对到底差在哪。只在真的筛空了、且确实有会话时补。
  const why = $('sess-empty-why');
  if (why) {
    const show = !!all.length && !list.length && sessionFiltered();
    why.hidden = !show;
    if (show) why.textContent = '现有会话：' + all.map(s => s.short).join('、');
  }
  // 搜索框的值就是用户正在敲的那个草稿,只有与 sessQuery 不一致时才回填(程序化设置/深链)。
  // 5 秒轮询重渲染的是 chips 与表格,永远不会把这个 input 抹掉。
  const search = $('sess-search');
  if (search && search.value !== sessQuery) search.value = sessQuery;

  const pinned = list.filter(s => boundSourceOf(boundOf(s)) === 'manual').length;
  const withRouting = list.filter(s => routingDescribeOf(groupOfSession(s), s.routing).length).length;
  const mismatched = list.filter(s => actualDiffers(s)).length;
  // 「实际 ≠ 绑定」是这一页唯一必须一眼看到的计数:非零时加 chip-alert 染 warn,为零时保持安静。
  $('sess-chips').innerHTML = [
    ['活跃对话', list.length, false],
    ['Anthropic / OpenAI', `${all.filter(s => (s.app || 'claude') === 'claude').length} / ${all.filter(s => s.app === 'codex').length}`, false],
    ['手动钉定', pinned, false],
    ['实际 ≠ 绑定', mismatched, mismatched > 0],
    ['会话级 Key / 槽位', withRouting, false],
  ].map(([k, v, alert]) => `<div class="chip${alert ? ' chip-alert' : ''}">${k}<b>${esc(typeof v === 'number' ? fmtCount(v) : String(v))}</b></div>`).join('');

  // 重渲染前记下用户展开着的绑定行:焦点守卫只挡住"焦点还在表里"的轮询,
  // 展开后点到别处(或 Safari 点 summary 不给焦点)时,下一次 5 秒轮询会把它收起来。
  const openPins = new Set([...($('sess-body').querySelectorAll?.('details.session-pin[open]') || [])]
    .map(d => d.closest('tr').getAttribute('data-session-key')));
  const html = list.map(s => {
    const app = s.app || 'claude';
    const b = boundOf(s), src = boundSourceOf(b);
    const [srcText, srcCls] = BOUND_SOURCE[src];
    const opts = state.providers[app].map(p =>
      `<option value="${esc(p.id)}" ${p.id === b.provider ? 'selected' : ''}>${esc(p.name)}${p.enabled ? '' : '(停用)'}</option>`).join('');
    // 绑定列的摘要行:来源标标 + 渠道名。未绑定时只剩一个「未绑定」标标——
    // 每行都喊一遍"普通请求渠道 · 未绑定"是噪音;那句说明留在展开后的字段名里。
    const bindName = b.provider_name || b.provider || '';
    return `<tr data-session="${esc(s.short)}" data-session-key="${esc(s.key)}"${src === 'none' ? ' class="sess-unbound"' : ''}>
      <td class="c-sess"><span class="sess-tag" title="${esc(s.key)}">${esc(s.short)}</span>
        <span class="sess-kind">${esc(KIND_LABEL[s.kind] || s.kind || '')}</span></td>
      <td class="c-app"><span class="badge ${app === 'codex' ? 'info' : 'on'}">${app === 'codex' ? 'OpenAI' : 'Anthropic'}</span></td>
      <td class="c-label">${sessionLabelHtml(s.label)}</td>
      <td class="session-binding">
          <details class="session-pin"><summary><span class="badge ${srcCls}">${srcText}</span>${bindName ? `<span class="bind-line" title="${esc(bindName)}">${esc(bindName)}</span>` : ''}</summary>
            <label class="field" for="${esc(domIdOf(s.key))}">普通请求渠道（非槽位、非分流请求）<select id="${esc(domIdOf(s.key))}" class="pin-sel" onchange="pinSession(${handlerArg(s.key)}, this.value)" ${!online ? 'disabled' : ''}>
              <option value="" ${b.provider ? '' : 'selected'}>(未绑定)</option>${opts}</select></label>
            <div class="bind-src"><span class="badge ${srcCls}">${srcText}</span></div>
          </details>
          ${bindName ? `<div class="bind-meta" title="${esc([b.model, b.rule].filter(Boolean).join(' · '))}">${esc(b.model || '—')}${b.rule ? ` · ${esc(b.rule)}` : ''}</div>` : ''}</td>
      <td class="c-actual">${actualCell(s, b)}</td>
      <td class="c-routing">${routingCell(s)}</td>
      <td class="c-usage"><b>${fmtCount(s.reqs || 0)}</b><span title="输入 ${fmtCount(s.inTok || 0)} / 输出 ${fmtCount(s.outTok || 0)} tokens">${fmtTok(s.inTok || 0)} / ${fmtTok(s.outTok || 0)}</span></td>
      <td class="c-active"${s.lastUsed ? ` title="${fmtFullTime(s.lastUsed)}"` : ''}>${fmtWhen(s.lastUsed || null)}</td>
      <td class="c-ops"><div class="sess-acts">
        <button class="small sess-config" onclick="openRouting(${handlerArg(s.key)})" ${online ? '' : 'disabled'} aria-label="配置会话 ${esc(s.short)} 的 Key 与槽位">配置 Key / 槽位</button>
        <button class="small" onclick="gotoLogs(${handlerArg(s.short)})">日志</button>
        <button class="small danger" onclick="unbindSession(${handlerArg(s.key)})" ${online ? '' : 'disabled'}>解绑</button>
      </div></td></tr>`;
  }).join('');
  // 内容没变就不重写:5 秒轮询每次整表重写会清掉用户正在选中的文字(比如在复制会话 id)。
  // 下拉的当前值不在 HTML 字符串里,所以改绑失败时要把 lastSessHtml 清空,下一次渲染才会把下拉复位。
  if (html === lastSessHtml) return;
  $('sess-body').innerHTML = html; lastSessHtml = html;
  $('sess-body').querySelectorAll('details.session-pin').forEach(detail => {
    detail.open = openPins.has(detail.closest('tr').getAttribute('data-session-key'));
  });
}
// 「最近实际请求」这一格。没有记录就是明明白白的「暂无」——
// 绝不拿绑定值或路由预览顶上来充数:用户看到渠道名就会当成真实落点,而 actual 只认真的发出去过的那次。
function actualCell(s, bound) {
  const a = actualOf(s);
  if (!a) return '<span class="actual-cell"><span class="sub">暂无</span></span>';
  const name = a.provider_name || a.provider || s.actual_text || '未知渠道';
  // 普通请求对照渠道绑定,槽位请求对照该槽配置。没有配置渠道时无从比较,不报差异。
  const expected = actualExpectedProvider(s, bound);
  const diff = !!a.provider && !!expected && a.provider !== expected;
  // 差异提示写清比的是谁:槽位请求比该槽配置(会话覆盖或全局槽位),普通请求比当前绑定。
  const nameOf = id => (state?.providers?.[s.app || 'claude'] || []).find(p => p.id === id)?.name || id;
  const why = a.slot ? ['与槽位配置不同', `槽位 ${a.slot} 配置的渠道是 ${nameOf(expected)}，实际落在 ${name}`]
    : ['与当前绑定不同', `当前绑定的渠道是 ${nameOf(expected)}，实际落在 ${name}`];
  // 三行各自不换行:渠道 + 状态 → 模型 → 槽位/粘性/时间。信息一条不少,但不再把渠道、
  // 模型、状态、槽位、时间挤成同一段可换行文字(那会把行高撑到六七行)。
  const meta = [
    a.slot ? `槽位 ${esc(a.slot)}` : '',
    a.sticky ? '粘性' : '',
    a.ts ? esc(fmtWhen(a.ts)) : '',
  ].filter(Boolean);
  return `<span class="actual-cell${diff ? ' diff' : ''}">
    <span class="sum"><span class="ac-name" title="${esc(name)}">${esc(name)}</span>${a.status ? reqStatusHtml(a) : ''}</span>
    <span class="sub">${esc(a.model || '—')}</span>
    ${meta.length ? `<span class="meta">${meta.join(' · ')}</span>` : ''}
    ${diff ? `<span class="sub why" title="${esc(why[1])}">${why[0]}</span>` : ''}</span>`;
}
// 槽位请求对照该槽的独立/全局配置,不能拿普通请求渠道把正常的主链/子代理分流标成异常。
function actualExpectedProvider(s, bound = boundOf(s)) {
  const a = actualOf(s);
  if (a?.slot) {
    const entry = Object.hasOwn(s.routing?.slots || {}, a.slot)
      ? s.routing.slots[a.slot] : globalSessionSlot(groupOfSession(s), a.slot);
    return entry?.provider || '';
  }
  return bound.provider || '';
}
const actualDiffers = s => { const a = actualOf(s), expected = actualExpectedProvider(s); return !!a?.provider && !!expected && a.provider !== expected; };
async function pinSession(key, provider) {
  if (!online) return toast('控制台离线，未改绑会话', 'err');
  try {
    await api('/api/sessions/' + encodeURIComponent(key) + '/pin', { method: 'POST', body: JSON.stringify({ provider }) });
    toast(provider ? '已改绑该对话' : '已解除钉定,下次请求重新分配', 'ok');
    refresh();
  } catch (e) {
    lastSessHtml = null;
    const select = $(domIdOf(key)), session = sessionByIdentity(key);
    if (select && session) select.value = boundOf(session).provider;
    toast('改绑失败:' + e.message, 'err');
  }
}
// 会话页的确认框要过这一层:确认框是独占的,而会话配置弹窗可能正开着。
// 直接调 askConfirm 在那种情况下会静默返回 false —— 用户点了「解绑」却什么都不发生、也没有提示。
async function sessionConfirm(title, message, action) {
  if (!activeDialog) return askConfirm(title, message, action);
  if (activeDialog.id === 'routing-mask') return routingAsk(title, message, action);
  toast('请先关闭当前弹窗再操作', 'err');
  return false;
}
async function unbindSession(key) {
  if (!online) return toast('控制台离线，未解绑会话', 'err');
  const s = sessionByIdentity(key);
  const saved = s ? routingDescribeOf(groupOfSession(s), s.routing) : [];
  const warn = saved.length
    ? `\n\n这个会话的 Key / 槽位配置会一起删除：\n· ${saved.slice(0, 8).join('\n· ')}${saved.length > 8 ? `\n· 其余 ${saved.length - 8} 项` : ''}`
    : '';
  if (!await sessionConfirm('解绑该会话', '该对话将在下次请求时按策略重新分配渠道。' + warn, saved.length ? '解绑并删除配置' : '解绑')) return;
  try { await api('/api/sessions/' + encodeURIComponent(key), { method: 'DELETE' }); toast(saved.length ? '已解绑，会话级 Key / 槽位配置一并删除' : '已解绑', 'ok'); refresh(); }
  catch (e) { toast('解绑失败:' + e.message, 'err'); }
}
async function clearSessions() {
  if (!online) return toast('控制台离线，未清空会话绑定', 'err');
  const saved = (state?.sessions || []).reduce((n, s) => n + (routingDescribeOf(groupOfSession(s), s.routing).length ? 1 : 0), 0);
  const warn = saved ? `\n\n其中 ${saved} 个会话配了 Key / 槽位覆盖，这些配置会一并删除且不可恢复。` : '';
  if (!await sessionConfirm('清空全部会话绑定', '所有协议组的对话将在下次请求时重新分配渠道。' + warn, saved ? '清空全部（含配置）' : '清空绑定')) return;
  try { await api('/api/sessions', { method: 'DELETE' }); toast(saved ? `已清空会话绑定，并删除 ${saved} 个会话的 Key / 槽位配置` : '已清空会话绑定', 'ok'); refresh(); }
  catch (e) { toast('清空失败：' + e.message, 'err'); }
}
function gotoLogs(short) {
  // 走 showView 而不是去"点"导航项:后者依赖某个选择器恰好命中,视图一改名就返回 null,
  // .click() 抛 TypeError,而这个按钮在会话表里——整页都还看着正常,只有它当场失灵。
  showView('diagnostics');
  $('f-session').value = short;
  loadLogs();
}

