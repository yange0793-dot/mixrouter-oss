'use strict';
// ---------------- 日志 ----------------
// 失败分类 err_class → 人话短标签,和 index.html「失败分类」筛选下拉是同一张对照表(单测里的 select 没有 options,
// 所以写成常量、不读 DOM)。单元格主文案用标签,原始枚举进 title;没收录的分类原样显示。尝试过程面板也读这张表。
const LOG_ERR_CLASS_LABEL = {
  stream_aborted: '断流', cancelled: '客户端取消', econnreset: '连接被重置', upstream_server: '上游故障', upstream_request: '上游拒绝',
  budget_exhausted: '额度耗尽', rate_limit: '限流', authentication: '认证失败', network_error: '网络错误',
};
let statsSequence = 0, slotStatsLoaded = false;
function slotStatsUnavailable(reason) {
  if (!slotStatsLoaded) $('slot-stats-table').hidden = true;
  $('slot-stats-status').textContent = reason + (slotStatsLoaded ? '；以下为陈旧数据，保留上次读取的分槽快照。' : '；尚无可用分槽快照。');
  $('slot-stats-status').classList.add('stale');
}
function renderSlotStats(s) {
  const bySlot = s.by_slot;
  if (!bySlot || typeof bySlot !== 'object' || Array.isArray(bySlot)) return slotStatsUnavailable('当前服务端未提供分槽统计');
  const scope = s.scope || {}, range = s.range || {};
  const count = n => typeof n === 'number' && Number.isFinite(n) ? fmtCount(n) : '未提供';
  // tokens 列与页面其他地方同一套 K/M/B 缩写;缩写了的格把完整数字放进 title。
  const tokCell = n => typeof n === 'number' && Number.isFinite(n)
    ? `<td${n >= 1000 ? ` title="${count(n)}"` : ''}>${fmtTok(n)}</td>` : '<td>未提供</td>';
  const windowText = scope.source === 'memory'
    ? `当前内存窗口，最近最多 ${count(scope.capacity)} 条`
    : scope.source === 'history' ? '磁盘保留历史窗口（非无限历史）' : '统计来源与窗口容量未提供';
  // 范围与分槽归属都来自统计接口，不用最多 200 条的日志列表或当前槽位配置反推。
  $('slot-stats-scope').textContent = `${windowText}；不是全天用量，也不是费用。与下方日志筛选独立。时间戳范围：${range.from ?? '未提供'} → ${range.to ?? '未提供'}（${scope.timezone || '时区未提供'}）。`;
  const names = Object.keys(bySlot).sort();
  const label = name => name === 'none' ? '未命中槽（none）' : name === 'unknown' ? '旧日志未知（unknown）' : name;
  $('slot-stats-body').innerHTML = names.map(name => {
    const row = bySlot[name];
    return `<tr><th scope="row">${esc(label(name))}</th><td>${count(row?.reqs)}</td>${['in', 'out', 'cache'].map(key => tokCell(row?.[key])).join('')}</tr>`;
  }).join('');
  $('slot-stats-table').hidden = names.length === 0;
  $('slot-stats-status').textContent = names.length ? '按请求实际命中的槽位聚合；旧日志缺少槽位时保留为未知。'
    : s.reqs === 0 ? '当前内存窗口没有请求。' : '本次响应没有分槽明细，不能视为零用量。';
  $('slot-stats-status').classList.remove('stale');
  slotStatsLoaded = true;
}
async function loadStats() {
  const sequence = ++statsSequence;
  try {
    const s = await api('/api/stats');
    if (sequence !== statsSequence) return;
    renderSlotStats(s);
    // 成功率按 ok/reqs 现算一位小数(服务端 ok_rate 已取整);没有请求是「—」而不是 100%。
    // fmtPct 把 99.95–100 之间写成「>99.9%」,有过失败不会被四舍五入抹成 100%。
    const tip = n => Number.isFinite(n) && n >= 1000 ? fmtCount(n) : '';
    const chips = [
      ['总请求', fmtCount(s.reqs)],
      ['成功率', fmtPct(s.reqs > 0 ? s.ok * 100 / s.reqs : null)],
      ['输入 tokens', fmtTok(s.inTok), tip(s.inTok)],
      ['输出 tokens', fmtTok(s.outTok), tip(s.outTok)],
      ['缓存读', fmtTok(s.cache), tip(s.cache)],
    ];
    $('stat-chips').innerHTML = chips.map(([k, v, title]) => `<div class="chip"${title ? ` title="${esc(title)}"` : ''}>${k}<b>${esc(String(v))}</b></div>`).join('');
    setLogError('stats', '');
  } catch (e) {
    if (sequence !== statsSequence) return;
    slotStatsUnavailable('分槽统计读取失败：' + e.message);
    setLogError('stats', '统计读取失败：' + e.message);
  }
}
let logsSequence = 0, lastLogsHtml = null;
const logErrors = {};
function setLogError(source, message) {
  logErrors[source] = message; const messages = Object.values(logErrors).filter(Boolean);
  $('logs-error').textContent = messages.join('；') + (messages.length ? '。已有数据为上次读取的快照。' : '');
  $('logs-error').classList.toggle('show', messages.length > 0);
}
async function loadLogs() {
  const sequence = ++logsSequence;
  try {
    const q = new URLSearchParams();
    if ($('f-app').value) q.set('app', $('f-app').value);
    if ($('f-provider').value.trim()) q.set('provider', $('f-provider').value.trim());
    if ($('f-model').value.trim()) q.set('model', $('f-model').value.trim());
    if ($('f-session').value.trim()) q.set('session', $('f-session').value.trim());
    if ($('f-status').value) q.set('status', $('f-status').value);
    if ($('f-errclass').value) q.set('err_class', $('f-errclass').value);
    q.set('limit', '200');
    const { logs } = await api('/api/logs?' + q.toString());
    if (sequence !== logsSequence) return;
    $('logs-empty').style.display = logs.length ? 'none' : '';
    $('logs-empty').innerHTML = '<b>没有匹配的请求</b>调整筛选条件，或通过本地路由发起调用。';
    const html = logs.map(l => {
      const cls = l.status >= 500 || l.status === 0 || l.err ? 'st5' : l.status >= 400 ? 'st4' : 'st2';
      const sess = l.session
        ? `<span class="sess-tag" title="${esc(l.session_kind || '')}">${esc(l.session)}</span>`
        : '<span class="dim">—</span>';
      const fo = l.failover ? ' <span class="cool" title="首选渠道失败,已转移到当前渠道">已转移</span>' : '';
      const tr = l.wire === 'chat' && (l.kind === 'responses') ? ' <span class="cool" title="responses→chat 协议翻译">协议翻译</span>' : '';
      const appTag = l.app === 'codex' ? '<span class="badge info">OpenAI</span>' : '<span class="badge info">Anthropic</span>';
      // 模型名常是长串:换行会把一列撑成三行,这里只做「入 → 出」两段,超宽由列宽截断。
      // 两段都带 title —— 被省略掉的那半截才是排查时要读的原文。
      const swap = l.model_out && l.model_out !== l.model_in
        ? `<span class="mdl-out" title="${esc(l.model_out)}">→ ${esc(l.model_out)}</span>` : '';
      // 错误列:失败分类给人话标签当主文案,原始枚举进 title;原始错误文本退到下一行小字,全文同样在 title。
      const errLabel = l.err_class ? `<span class="err-label" title="失败分类 ${esc(l.err_class)}">${esc(Object.hasOwn(LOG_ERR_CLASS_LABEL, l.err_class) ? LOG_ERR_CLASS_LABEL[l.err_class] : l.err_class)}</span>` : '';
      const errMsg = l.err ? `<span class="err-text" title="${esc(l.err)}">${esc(l.err)}</span>` : '';
      // tokens 与缓存合成一格(上行入/出,下行缓存读与命中率)。缓存读数不能只剩百分比 ——
      // 「命中 300、占比 75%」是两个不同的量,少了读数就没法判断省了多少。cacheHitText 两者都给。
      // 入/出 0 是没记到用量的占位,显示「—」;超过 1000 缩写成 K/M/B,完整数字放 title。
      const tokTitle = l.in >= 1000 || l.out >= 1000
        ? ` title="输入 ${fmtCount(l.in || 0)} / 输出 ${fmtCount(l.out || 0)}"` : '';
      const tok = `<span class="tok-main"${tokTitle}>${l.in ? fmtTok(l.in) : '—'} / ${l.out ? fmtTok(l.out) : '—'}</span><span class="tok-sub">缓存 ${cacheHitText(l)}</span>`;
      return `<tr><td class="c-time" title="${fmtFullTime(l.ts)}">${fmtWhen(l.ts)}</td><td class="c-sess">${sess}</td>
        <td class="c-prov"><span class="prov-name" title="${esc(l.provider || '')}">${esc(l.provider || '—')}</span><span class="prov-meta">${appTag}${fo}${tr}</span></td>
        <td class="c-model"><span class="mdl-in" title="${esc(l.model_in || '')}">${esc(l.model_in || '—')}</span>${swap}</td>
        <td class="num c-tok">${tok}</td>
        <td class="num">${fmtRate(l)}</td><td class="num">${fmtTtfb(l.ttfb_ms)}</td>
        <td class="num c-bytes"><span>${fmtTtfb(l.ms)}</span><span class="sub">${fmtBytes(l.bytes_in)}</span></td>
        <td class="num c-status"><span class="code-pill ${cls}">${l.status || '—'}</span></td>
        <td class="c-err">${errLabel}${errMsg}</td></tr>`;
    }).join('');
    // 5 秒自动刷新内容没变就不重写:整表重写会清掉用户正在选中复制的文字(错误文本、模型名)。
    if (html !== lastLogsHtml) { $('logs-body').innerHTML = html; lastLogsHtml = html; }
    setLogError('logs', '');
  } catch (e) { if (sequence === logsSequence) setLogError('logs', '日志读取失败：' + e.message); }
}
function clearFilters() {
  $('f-app').value = ''; $('f-provider').value = ''; $('f-model').value = ''; $('f-session').value = ''; $('f-status').value = ''; $('f-errclass').value = '';
  loadLogs();
}
function restartLogsTimer() { clearInterval(logsTimer); logsTimer = setInterval(() => { if ($('logs-auto').checked) { loadLogs(); loadStats(); } }, 5000); }
