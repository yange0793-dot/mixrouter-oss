'use strict';
// ---------------- 设置与备份(只读) ----------------
// 这一页把后端早就存在、前端此前零引用的四个端点接出来。四条都是**只读**:
//   /api/backups        备份清点(只有文件名/大小/时间/摘要,响应里没有任何配置正文或密钥)
//   /api/health         渠道可用性与超时、重试配置(cooldown_* 是兼容旧客户端的恒 0 字段)
//   /api/routing/preview 路由解释(预测,不消耗游标、不写绑定)
//   /api/metrics        Prometheus 文本,可导出
// 全部走 api(),不新增任何写请求。这里没有任何"恢复"入口:真正的恢复写入不在本期。
//
// 显示口径:重新读取时保留上一次的结果、只改状态行;读失败也不清空,而是标明"下面是几点的结果"。
// 时间点、计数、时长与字节一律走 app.js 的 fmtWhen / fmtCount / fmtTtfb / fmtBytes,不在这里另写一套。
let backupsLoaded = false, backupsBusy = false, backupsReadAt = null;
let healthBusy = false, healthReadAt = null, previewSeq = 0;
// 状态行三种语气:普通 / 过期(读失败但下面还留着上一次的结果)/ 出错(下面什么都没有)。
function settingsStatus(box, text, tone = '') {
  box.textContent = text;
  box.classList.toggle('stale', tone === 'stale');
  box.classList.toggle('is-err', tone === 'err');
}
// 读取进行中:数据区标 aria-busy,对应的顶栏按钮禁用。顶栏按钮没有 id,按它调用的函数找。
function settingsBusy(areaId, fn, busy) {
  $(areaId)?.setAttribute('aria-busy', busy ? 'true' : 'false');
  const button = document.querySelector(`#view-settings button[onclick="${fn}()"]`);
  if (button) button.disabled = busy;
}
async function loadBackups() {
  if (backupsBusy) return;
  const box = $('backup-status');
  backupsBusy = true; settingsBusy('backup-dirs', 'loadBackups', true);
  settingsStatus(box, backupsLoaded ? '正在重新清点…' : '正在清点备份…');
  try {
    const res = await api('/api/backups');
    const dirs = Array.isArray(res.dirs) ? res.dirs : [];
    $('backup-dirs').innerHTML = dirs.length ? dirs.map(d => backupDirCard(d, res.keep)).join('') : '<div class="empty"><b>没有备份目标</b>当前后端没有可清点的备份池。</div>';
    $('backup-dirs').classList.remove('is-stale');
    const bad = dirs.filter(d => !d.ok).length;
    backupsReadAt = new Date(); backupsLoaded = true;
    settingsStatus(box, `已清点 ${dirs.length} 个备份池${bad ? `（${bad} 个目录读取失败）` : ''} · ${fmtWhen(backupsReadAt)}。只显示文件名与摘要，不含任何配置正文。`);
  } catch (e) {
    // 端点挂了只影响这一块:其它页的草稿、其它面板都不受牵连(每个 fetch 各自 try/catch)。
    // 上一次的清点结果留在原处,标成过期;从没读成功过时下面本来就是空的。
    $('backup-dirs').classList.toggle('is-stale', !!backupsReadAt);
    settingsStatus(box, `备份清点读取失败：${e.message}。${backupsReadAt ? `下面是 ${fmtWhen(backupsReadAt)} 的清点结果；` : ''}可点「重新清点备份」再试，这不改动任何备份。`, backupsReadAt ? 'stale' : 'err');
  } finally { backupsBusy = false; settingsBusy('backup-dirs', 'loadBackups', false); }
}
function backupDirCard(d, keep) {
  const list = Array.isArray(d.backups) ? d.backups : [];
  const unparsable = Array.isArray(d.unparsable) ? d.unparsable : [];
  const nextDelete = Array.isArray(d.next_delete) ? d.next_delete : [];
  // 清单按时间升序回来:取最近 12 份并把新的放上面。大小按 1024 进制,精确字节数放 title。
  const rows = list.slice(-12).reverse().map(b => {
    const full = fmtFullTime(b.iso);
    // 手机上摘要列收起、大小与时间并到文件名下面一行(config.css),所以文件名的 title 带上摘要。
    const nameTitle = b.sha256_12 ? `${b.name}\n摘要 ${b.sha256_12}` : b.name;
    return `<tr><td class="mono bk-name" title="${esc(nameTitle)}">${esc(b.name)}${b.legacy ? '<span class="badge off bk-legacy">旧格式</span>' : ''}</td>`
      + `<td class="num bk-size"${Number.isFinite(b.size) ? ` title="${fmtCount(b.size)} 字节"` : ''}>${fmtBytes(b.size)}</td>`
      + `<td class="mono bk-time"${full === '—' ? '' : ` title="${full}"`}>${fmtWhen(b.iso)}</td>`
      + `<td class="mono bk-sha">${esc(b.sha256_12 || '—')}</td></tr>`;
  }).join('');
  // 读失败的池不能说"这个池里还没有备份"——那是另一件事,并排摆出来会互相打脸。
  // 空池同理:上一行已经写了"共 0 份…",不再补一句同义的空话。错误码给人话,原值放 mono。
  const reason = { ENOENT: '目录不存在', EACCES: '没有读取权限', EPERM: '没有读取权限', ENOTDIR: '路径不是目录' }[d.error?.code];
  const code = d.error?.code ? `<span class="mono">${esc(d.error.code)}</span>` : '';
  return `<div class="bk-dir ${d.ok ? '' : 'is-failed'}">
    <div class="bk-head"><b>${esc(d.label || d.id)}</b><span class="badge ${d.ok ? 'on' : 'off'}">${d.ok ? '已清点' : '读取失败'}</span>
      <span class="mono">${esc(d.dir || '')}</span></div>
    ${d.ok ? `<p class="hint">共 ${fmtCount(d.total ?? list.length)} 份${d.legacy ? `，其中 ${fmtCount(d.legacy)} 份旧格式` : ''} · 保留上限 ${keep == null ? '—' : `${fmtCount(keep)} 份`}</p>
      <p class="hint bk-next${nextDelete.length ? ' has-next' : ''}">下一次备份会删：${nextDelete.length ? nextDelete.map(esc).join('、') : '无（池未满）'}</p>`
      : `<p class="hint">这个目录没查成：${reason ? `${reason}（${code}）` : code || '未知原因'}。没查成不等于零份备份。</p>`}
    ${unparsable.length ? `<p class="hint">名字像备份但解析不出时间的有 ${fmtCount(unparsable.length)} 个：${unparsable.map(u => `<span class="mono" title="${esc(u.reason || '')}">${esc(u.name)}</span>`).join('、')}。它们照样占保留池名额。</p>` : ''}
    ${rows ? `<div class="table-wrap"><table><caption class="sr-only">${esc(d.label || d.id)} 备份清单</caption><thead><tr><th scope="col">文件名</th><th scope="col" class="num">大小</th><th scope="col">时间</th><th scope="col" title="sha256 的前 12 位">摘要</th></tr></thead><tbody>${rows}</tbody></table></div>${list.length > 12 ? `<p class="hint">只显示最近 12 份，共 ${fmtCount(list.length)} 份。</p>` : ''}` : ''}
  </div>`;
}
// 「可参与路由」只是配置口径(已启用、没被健康快照排除),不代表上游此刻连得通。
function routeBadge(p) {
  if (p.enabled === false) return '<span class="badge off">已停用</span>';
  return p.eligible === false ? '<span class="badge warn">暂不可用</span>' : '<span class="badge on">可参与路由</span>';
}
async function loadHealth() {
  if (healthBusy) return;
  const box = $('health-status');
  healthBusy = true; settingsBusy('health-body', 'loadHealth', true);
  settingsStatus(box, healthReadAt ? '正在重新读取…' : '正在读取健康状态…');
  try {
    const h = await api('/api/health');
    liveHealth = h;
    const s = h.settings || {};
    // 人话标签 + 带单位的时长;原始字段名与毫秒值放在 title,排查时对得上服务端启动参数。
    const ms = v => v === 0 ? '0ms' : fmtTtfb(v);
    const facts = [
      ['单请求总预算', 'total_deadline_ms', ms], ['非流式首响应超时', 'first_header_timeout_ms', ms],
      ['流式首响应超时', 'stream_first_header_timeout_ms', ms], ['流式空闲超时', 'stream_idle_timeout_ms', ms],
      ['非流式总超时', 'nonstream_total_timeout_ms', ms], ['最多尝试渠道', 'max_attempts', fmtCount],
      ['单请求上游调用上限', 'max_upstream_calls', fmtCount], ['重试间隔', 'retry_delay_ms', ms],
    ].filter(([, key]) => s[key] !== undefined);
    const names = new Map(['claude', 'codex'].flatMap(app => providers(app).map(p => [app + ':' + p.id, p.name])));
    $('health-body').innerHTML = `<dl class="config-facts">${facts.map(([label, key, fmt]) => `<div title="${key} = ${esc(String(s[key]))}"><dt>${label}</dt><dd>${fmt(s[key])}</dd></div>`).join('')}</dl>`
      + (Array.isArray(h.providers) && h.providers.length
        ? `<div class="table-wrap"><table><caption class="sr-only">各渠道可用性</caption><thead><tr><th scope="col">渠道</th><th scope="col">协议组</th><th scope="col" title="按配置与健康快照判断,不代表上游此刻连得通">路由状态</th></tr></thead><tbody>${h.providers.map(p => `<tr><td title="${esc(p.provider)}">${esc(names.get(p.app + ':' + p.provider) || p.provider)}</td><td>${esc(GROUPS[p.app] || p.app || '—')}</td><td>${routeBadge(p)}</td></tr>`).join('')}</tbody></table></div>`
        : '');
    $('health-body').classList.remove('is-stale');
    healthReadAt = new Date();
    settingsStatus(box, `已读取 · ${fmtWhen(healthReadAt)}。只读视图，不改任何状态。`);
    // 渠道页的卡片也要跟着更新(可用性徽标);拿不到健康不影响卡片渲染。
    if (view === 'providers') renderProviders();
  } catch (e) {
    liveHealth = null; healthError = e.message;
    $('health-body').classList.toggle('is-stale', !!healthReadAt);
    settingsStatus(box, `健康状态读取失败：${e.message}。${healthReadAt ? `下面是 ${fmtWhen(healthReadAt)} 的结果，可能已过期；` : ''}渠道页的可用性徽标暂时不可用，渠道列表照常显示。`, healthReadAt ? 'stale' : 'err');
    if (view === 'providers') renderProviders();
  } finally { healthBusy = false; settingsBusy('health-body', 'loadHealth', false); }
}
async function loadPreview() {
  const box = $('preview-status'), app = $('preview-app').value, model = $('preview-model').value.trim();
  // 连点或切协议组会并发几次请求:只认最后一次,晚到的旧回包直接丢掉。
  const seq = ++previewSeq;
  settingsBusy('preview-body', 'loadPreview', true);
  settingsStatus(box, '正在解释…');
  try {
    // POST 只为携带上下文;这条路径只读:不消耗轮询游标,也不写会话绑定(服务端保证)。
    //
    // 这条端点**自己处理非 2xx**:预演的"没有可用候选"是 503、参数不对是 400,而它们都带
    // 一份**有意义的 JSON**(ok:false + stages/candidates 说明为什么),不是传输故障。
    // 走 api() 会把它们当异常抛出来,于是界面上只剩一句报错 ——
    // 而且 503 体里的 error 是个**对象**({code,message,httpStatus}),api() 的 `new Error(j.error)`
    // 会把它串成 "[object Object]",用户看到"路由解释失败:[object Object]"。
    // 所以这里自己 fetch 一次,拿到 body 就按"解释结果"渲染;只有真的连不上/解析不了才进 catch。
    const r = await fetch('/api/routing/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app, model }), cache: 'no-store',
    });
    const res = await r.json();
    if (seq !== previewSeq) return;
    $('preview-body').innerHTML = previewBody(res);
    // textContent 不再转义一次,否则服务端消息里的引号会原样显示成 &quot;。
    settingsStatus(box, res.ok ? '解释完成。'
      : `暂无可用落点：${(res.error && res.error.message) || '没有候选渠道'}`);
  } catch (e) {
    if (seq !== previewSeq) return;
    $('preview-body').innerHTML = '';
    settingsStatus(box, `路由解释失败：${e.message}。请检查协议组与模型名后再点「解释一次」。`, 'err');
  } finally { if (seq === previewSeq) settingsBusy('preview-body', 'loadPreview', false); }
}
// 协议枚举给人话,原值放在后面的 mono 小字里;规则 id 本身就是名字,只换成 mono。
function previewBody(res) {
  const m = res.matched || {}, sel = res.selection || {};
  const cands = Array.isArray(res.candidates) ? res.candidates : [];
  const chosen = sel.predicted?.providerName || sel.predicted?.providerId || '';
  const labelled = (labels, value, empty) => !value ? esc(empty)
    : labels[value] ? `${labels[value]} <span class="mono">${esc(value)}</span>` : `<span class="mono">${esc(value)}</span>`;
  const via = { compact: '压缩标记', slot: '槽位别名', model: '模型名' };
  const strategy = { priority: '主备顺序', round_robin: '轮询', weighted: '按权重', least_used: '最少使用', random: '随机' };
  const wire = { anthropic: 'Anthropic Messages', responses: 'Responses', chat: 'Chat Completions' };
  return `<p class="hint"><strong>这是预测，不是实际落点。</strong></p>`
    + `<dl class="config-facts">
        <div><dt>命中方式</dt><dd>${labelled(via, m.via, '未提供')}</dd></div>
        <div><dt>命中规则</dt><dd>${m.ruleId ? `<span class="mono">${esc(m.ruleId)}</span>` : '未命中(没有可走的规则)'}</dd></div>
        <div><dt>分配策略</dt><dd>${labelled(strategy, m.strategy, '未提供')}</dd></div>
        <div><dt>预测首选</dt><dd>${esc(chosen || '无法确定(如随机策略)')}</dd></div>
      </dl>`
    + (cands.length
      ? `<div class="table-wrap"><table><caption class="sr-only">候选渠道</caption><thead><tr><th scope="col">候选</th><th scope="col">模型</th><th scope="col">协议</th><th scope="col" title="按配置与健康快照判断,不代表上游此刻连得通">路由状态</th></tr></thead><tbody>${cands.map(c => `<tr><td title="${esc(c.providerId || '')}">${esc(c.providerName || c.providerId)}</td><td class="mono">${esc(c.model || '透传')}</td><td>${labelled(wire, c.wire, '—')}</td><td>${routeBadge(c)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="hint">没有候选渠道。</p>')
    + (Array.isArray(res.warnings) && res.warnings.length ? `<ul class="config-warnings">${res.warnings.map(w => `<li>${esc(w.message || w.code)}</li>`).join('')}</ul>` : '');
}
// 脱敏导出:指标是纯文本,用 Blob + createObjectURL 存成文件。
// 标签集由服务端固定(不含会话、渠道、模型名或密钥),所以下载下来的东西可以直接给别人看。
async function exportMetrics() {
  const msg = $('metrics-msg'), button = $('metrics-export');
  button.disabled = true;
  msg.textContent = '正在读取指标…';
  try {
    const r = await fetch('/api/metrics', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    // Blob/URL/createElement 任一缺失都明说,不静默失败、也不退化成"复制到剪贴板"之类的暗路
    // (那会让用户以为导出成功了)。真实浏览器三者都有。
    if (typeof Blob !== 'function' || !URL?.createObjectURL || typeof document.createElement !== 'function') { msg.textContent = '当前环境不支持下载，指标文本未能导出。'; return; }
    // 大小取 Blob 的字节数:指标的 HELP 行有中文,字符数比字节数少三成。
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `mixrouter-metrics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    msg.textContent = `已导出 ${fmtBytes(blob.size)} 的指标文本；不含任何密钥。`;
  } catch (e) { msg.textContent = `指标导出失败：${e.message}。可以稍后再点一次。`; }
  finally { button.disabled = false; }
}
