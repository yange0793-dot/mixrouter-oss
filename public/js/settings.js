'use strict';
// ---------------- 设置与备份(只读) ----------------
// 这一页把后端早就存在、前端此前零引用的四个端点接出来。四条都是**只读**:
//   /api/backups        备份清点(只有文件名/大小/时间/摘要,响应里没有任何配置正文或密钥)
//   /api/health         渠道可用性与超时、重试配置(cooldown_* 是兼容旧客户端的恒 0 字段)
//   /api/routing/preview 路由解释(预测,不消耗游标、不写绑定)
//   /api/metrics        Prometheus 文本,可导出
// 全部走 api(),不新增任何写请求。这里没有任何"恢复"入口:真正的恢复写入不在本期。
let backupsLoaded = false;
async function loadBackups() {
  const box = $('backup-status');
  box.textContent = '正在清点备份…';
  try {
    const res = await api('/api/backups');
    const dirs = Array.isArray(res.dirs) ? res.dirs : [];
    $('backup-dirs').innerHTML = dirs.length ? dirs.map(d => backupDirCard(d, res.keep)).join('') : '<div class="empty"><b>没有备份目标</b>当前后端没有可清点的备份池。</div>';
    const bad = dirs.filter(d => !d.ok).length;
    box.textContent = `保留上限 ${res.keep ?? '未提供'} 份 · 共 ${dirs.length} 个备份池${bad ? ` · ${bad} 个目录读取失败` : ''}。只显示文件名与摘要，不含任何配置正文。`;
    backupsLoaded = true;
  } catch (e) {
    // 端点挂了只影响这一块:其它页的草稿、其它面板都不受牵连(每个 fetch 各自 try/catch)。
    $('backup-dirs').innerHTML = '';
    box.textContent = '备份清点读取失败：' + e.message + '。这不影响其它设置项，也不改动任何备份。';
  }
}
function backupDirCard(d, keep) {
  const list = Array.isArray(d.backups) ? d.backups : [];
  const unparsable = Array.isArray(d.unparsable) ? d.unparsable : [];
  const nextDelete = Array.isArray(d.next_delete) ? d.next_delete : [];
  const rows = list.slice(0, 12).map(b => `<tr><td class="mono">${esc(b.name)}</td><td>${esc(b.size)}</td><td class="mono">${esc(b.iso || '')}</td><td class="mono">${esc(b.sha256_12 || '')}</td>${b.legacy ? '<td>旧格式</td>' : '<td></td>'}</tr>`).join('');
  // 读失败的池不能说"这个池里还没有备份"——那是另一件事,并排摆出来会互相打脸。
  // 空池同理:上一行已经写了"共 0 份…",不再补一句同义的空话。
  return `<div class="bk-dir ${d.ok ? '' : 'is-failed'}">
    <div class="bk-head"><b>${esc(d.label || d.id)}</b><span class="badge ${d.ok ? 'on' : 'off'}">${d.ok ? '已清点' : '读取失败'}</span>
      <span class="mono">${esc(d.dir || '')}</span></div>
    ${d.ok ? `<p class="hint">共 ${d.total ?? list.length} 份${d.legacy ? `，其中 ${d.legacy} 份旧格式` : ''}；下一次备份会删：${nextDelete.length ? nextDelete.map(esc).join('、') : '无(池未满)'}。保留上限 ${keep ?? '未提供'} 份。</p>`
      : `<p class="hint">这个目录没查成：${esc(d.error?.code || '未知原因')}。不是"零份备份"——是"没查成"。</p>`}
    ${unparsable.length ? `<p class="hint">名字像备份但解析不出时间的有 ${unparsable.length} 个：${unparsable.map(esc).join('、')}。它们照样占保留池名额。</p>` : ''}
    ${rows ? `<div class="table-wrap"><table><caption class="sr-only">${esc(d.label || d.id)} 备份清单</caption><thead><tr><th scope="col">文件名</th><th scope="col">大小</th><th scope="col">时间</th><th scope="col">sha256(12)</th><th scope="col">备注</th></tr></thead><tbody>${rows}</tbody></table></div>${list.length > 12 ? `<p class="hint">只显示最近 12 份，共 ${list.length} 份。</p>` : ''}` : ''}
  </div>`;
}
async function loadHealth() {
  const box = $('health-status');
  box.textContent = '正在读取健康状态…';
  try {
    const h = await api('/api/health');
    liveHealth = h;
    const s = h.settings || {};
    const facts = [
      ['总预算(ms)', s.total_deadline_ms], ['首字节(ms)', s.first_header_timeout_ms],
      ['流式首字节(ms)', s.stream_first_header_timeout_ms], ['流式空闲(ms)', s.stream_idle_timeout_ms],
      ['非流式总超时(ms)', s.nonstream_total_timeout_ms], ['最大尝试', s.max_attempts],
      ['单请求上游调用上界', s.max_upstream_calls],
      ['重试间隔(ms)', s.retry_delay_ms],
    ].filter(([, v]) => v !== undefined);
    $('health-body').innerHTML = `<dl class="config-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(String(v))}</dd></div>`).join('')}</dl>`
      + (Array.isArray(h.providers) && h.providers.length
        ? `<div class="table-wrap"><table><caption class="sr-only">各渠道可用性</caption><thead><tr><th scope="col">渠道</th><th scope="col">协议组</th><th scope="col">启用</th><th scope="col">可用</th></tr></thead><tbody>${h.providers.map(p => `<tr><td class="mono">${esc(p.provider)}</td><td>${esc(p.app || '')}</td><td>${p.enabled ? '是' : '否'}</td><td>${p.eligible ? '是' : '否'}</td></tr>`).join('')}</tbody></table></div>`
        : '');
    box.textContent = '已读取;这是各渠道当前可用性视图,不改任何状态。';
    // 渠道页的卡片也要跟着更新(可用性徽标);拿不到健康不影响卡片渲染。
    if (view === 'providers') renderProviders();
  } catch (e) {
    liveHealth = null; healthError = e.message;
    $('health-body').innerHTML = '';
    box.textContent = '健康状态读取失败：' + e.message + '。可用性徽标暂时不可用，渠道列表照常显示。';
    if (view === 'providers') renderProviders();
  }
}
async function loadPreview() {
  const box = $('preview-status'), app = $('preview-app').value, model = $('preview-model').value.trim();
  box.textContent = '正在解释…';
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
    const m = res.matched || {}, sel = res.selection || {};
    const cands = Array.isArray(res.candidates) ? res.candidates : [];
    const chosen = sel.predicted?.providerName || sel.predicted?.providerId || '';
    $('preview-body').innerHTML = `<p class="hint"><strong>这是预测，不是实际落点。</strong>真实落点请看「会话」页每行的最近实际请求列。</p>`
      + `<dl class="config-facts">
        <div><dt>命中方式</dt><dd>${esc(m.via || '未提供')}</dd></div>
        <div><dt>命中规则</dt><dd>${esc(m.ruleId || '未命中(没有可走的规则)')}</dd></div>
        <div><dt>分配策略</dt><dd>${esc(m.strategy || '未提供')}</dd></div>
        <div><dt>预测首选</dt><dd>${esc(chosen || '无法确定(如随机策略)')}</dd></div>
      </dl>`
      + (cands.length
        ? `<div class="table-wrap"><table><caption class="sr-only">候选渠道</caption><thead><tr><th scope="col">候选</th><th scope="col">模型</th><th scope="col">协议</th><th scope="col">可用</th></tr></thead><tbody>${cands.map(c => `<tr><td class="mono">${esc(c.providerName || c.providerId)}</td><td class="mono">${esc(c.model || '透传')}</td><td>${esc(c.wire || '')}</td><td>${c.eligible ? '是' : '否'}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="hint">没有候选渠道。</p>')
      + (Array.isArray(res.warnings) && res.warnings.length ? `<ul class="config-warnings">${res.warnings.map(w => `<li>${esc(w.message || w.code)}</li>`).join('')}</ul>` : '');
    // textContent 不再转义一次,否则服务端消息里的引号会原样显示成 &quot;。
    box.textContent = res.ok ? '解释完成。'
      : `暂无可用落点：${(res.error && res.error.message) || '没有候选渠道'}`;
  } catch (e) {
    $('preview-body').innerHTML = '';
    box.textContent = '路由解释失败：' + e.message;
  }
}
// 脱敏导出:指标是纯文本,用 Blob + createObjectURL 存成文件。
// 标签集由服务端固定(不含会话、渠道、模型名或密钥),所以下载下来的东西可以直接给别人看。
async function exportMetrics() {
  const msg = $('metrics-msg');
  msg.textContent = '正在读取指标…';
  try {
    const r = await fetch('/api/metrics', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    // Blob/URL/createElement 任一缺失都明说,不静默失败、也不退化成"复制到剪贴板"之类的暗路
    // (那会让用户以为导出成功了)。真实浏览器三者都有。
    if (typeof Blob !== 'function' || !URL?.createObjectURL || typeof document.createElement !== 'function') { msg.textContent = '当前环境不支持下载，指标文本未能导出。'; return; }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `mixrouter-metrics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    msg.textContent = `已导出 ${text.length} 字节的指标文本；不含任何密钥。`;
  } catch (e) { msg.textContent = '指标导出失败：' + e.message; }
}

