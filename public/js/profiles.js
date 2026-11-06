'use strict';
// 模型方案(#profiles)。与 app.js 共用同一个 realm(classic script,不是 ESM):
// 只声明本页自己的变量与函数,不重复声明 $ / esc / api / askConfirm / online。
//
// 只负责三件事:
//   1) 把所选协议组的当前全局槽位保存成快照(不切换、不写客户端配置);
//   2) 预览方案与当前槽位的逐槽差异,列出不可应用的原因;
//   3) 用户确认后原子替换所选协议组的全局槽位,只对后续新请求生效。
//
// 预览与切换的回包都可能包含服务端生成的槽位对象。这里只渲染白名单字段
// (provider / model / pool / strategy / dropTools / enabled),绝不回显 Key 或任意原文。

const INITIAL_SAVE_MESSAGE = '读取方案列表后才能保存。';

const profilesState = {
  visible: false,
  loaded: false,
  loading: false,
  saving: false,
  deleting: false,
  applying: false,
  revision: null,
  slotsRevision: null,
  profiles: [],
  seq: 0,
  listMessage: '尚未读取方案列表。',
  listKind: '',
  saveMessage: INITIAL_SAVE_MESSAGE,
  saveKind: '',
  previewOpen: false,
  preview: null,
  previewing: false,
  previewMessage: '尚未预览。',
  previewKind: '',
};

function profilesEl(id) {
  try { return document.getElementById(id); } catch { return null; }
}

function profilesEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function profilesOnline() {
  try { return typeof online === 'undefined' ? true : !!online; } catch { return true; }
}

function profilesAppLabel(app) {
  if (app === 'claude') return 'Claude';
  if (app === 'codex') return 'Codex';
  return app ? String(app) : '—';
}

function profilesAppsText(apps) {
  if (!Array.isArray(apps) || !apps.length) return '—';
  return apps.map(profilesAppLabel).join(' / ');
}

// 时间点:今天只写时分秒,今年写月-日 时:分,更早只写日期;完整时间放 title。
// 解析不了的值显示 —,原文留在 title 里,不拿内部格式当主文案。
function profilesWhen(value, now = new Date()) {
  if (value === null || value === undefined || value === '') return { text: '—', title: '' };
  const numeric = typeof value === 'number' || /^\d{10,}$/.test(String(value)) ? Number(value) : value;
  const date = new Date(numeric);
  if (Number.isNaN(date.getTime())) return { text: '—', title: `无法解析的时间：${value}` };
  const pad = n => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const text = date.toDateString() === now.toDateString() ? clock
    : date.getFullYear() === now.getFullYear() ? `${day.slice(5)} ${clock.slice(0, 5)}` : day;
  return { text, title: `${day} ${clock}` };
}

// 池策略的人话标签,与渠道页就绪检查同一套词;原值放在单元格 title 里。
const PROFILES_STRATEGY_LABEL = { priority: '主备顺序', round_robin: '轮询', weighted: '按权重', least_used: '最少使用', random: '随机' };

// 渠道 id 换成渠道名:控制台已有 /api/state 快照时查得到;查不到(或单独加载本文件)就原样显示 id。
function profilesProviderName(app, id) {
  const list = typeof state === 'undefined' ? null : state?.providers?.[app];
  const hit = Array.isArray(list) ? list.find(provider => provider && provider.id === id) : null;
  return hit && typeof hit.name === 'string' && hit.name ? hit.name : id;
}

// 槽位对象的展示白名单。pool 的成员也只取 provider/model,不渲染权重之外的未知字段,
// 更不会碰 key_id / Key 明文。raw=true 时给原始 id 与策略值(放 title,排查用)。
function profilesPoolText(pool, name) {
  const names = pool.slice(0, 4).map(member => {
    if (typeof member === 'string') return name(member);
    if (!member || typeof member !== 'object') return '?';
    const provider = typeof member.provider === 'string' ? name(member.provider) : '';
    const model = typeof member.model === 'string' ? member.model : '';
    return [provider, model].filter(Boolean).join('/') || '?';
  });
  return names.join('、') + (pool.length > 4 ? ` 等 ${pool.length} 个` : '');
}

function profilesEntryText(entry, app = '', raw = false) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '（无此槽位）';
  const name = raw ? id => id : id => profilesProviderName(app, id);
  const parts = [];
  if (typeof entry.provider === 'string' && entry.provider) parts.push(`渠道 ${name(entry.provider)}`);
  if (entry.model === '' || entry.model === null || entry.model === undefined) parts.push('模型继承渠道默认');
  else if (typeof entry.model === 'string' || typeof entry.model === 'number') parts.push(`模型 ${entry.model}`);
  if (Array.isArray(entry.pool) && entry.pool.length) parts.push(`备池 ${profilesPoolText(entry.pool, name)}`);
  if (typeof entry.strategy === 'string' && entry.strategy) parts.push(`策略 ${raw ? entry.strategy : PROFILES_STRATEGY_LABEL[entry.strategy] || entry.strategy}`);
  const dropTools = entry.dropTools !== undefined ? entry.dropTools : entry.drop_tools;
  if (Array.isArray(dropTools)) parts.push(`丢弃工具 ${dropTools.length} 项`);
  else if (dropTools === true) parts.push('丢弃工具 是');
  else if (dropTools === false) parts.push('丢弃工具 否');
  if (entry.enabled === false) parts.push('已停用');
  return parts.length ? parts.join(' · ') : '（空槽位）';
}

function profilesDiffRow(change) {
  if (!change || typeof change !== 'object') return '';
  const before = profilesEntryText(change.before, change.app);
  const shownAfter = profilesEntryText(change.after, change.app);
  const rawBefore = profilesEntryText(change.before, change.app, true);
  const rawAfter = profilesEntryText(change.after, change.app, true);
  let after = shownAfter;
  // 判断"白名单外的字段有变化"要用原始值比:两个渠道同名时,显示文本一样但 id 不同。
  if (rawBefore === rawAfter) {
    try {
      if (JSON.stringify(change.before) !== JSON.stringify(change.after)) after += ' · 其他字段有变化';
    } catch { /* 服务端 JSON 不会循环;万一不可序列化就只显示白名单摘要 */ }
  }
  const title = (shown, rawText) => rawText !== shown ? ` title="${profilesEsc(rawText)}"` : '';
  // 变动类型只看两侧有没有槽位对象:当前没有＝新增,方案没有＝移除,两边都有＝变更。
  const isEntry = entry => !!entry && typeof entry === 'object' && !Array.isArray(entry);
  const kind = !isEntry(change.before) ? 'add' : !isEntry(change.after) ? 'del' : 'mod';
  const kindText = { add: '新增', del: '移除', mod: '变更' }[kind];
  return `<tr class="profiles-chg profiles-chg-${kind}">
    <td>${profilesEsc(profilesAppLabel(change.app))}</td>
    <td><span class="mono">${profilesEsc(change.slot || '—')}</span><span class="profiles-kind">${kindText}</span></td>
    <td class="profiles-before"${title(before, rawBefore)}>${profilesEsc(before)}</td>
    <td class="profiles-after"${title(shownAfter, rawAfter)}>${profilesEsc(after)}</td>
  </tr>`;
}

function profilesRow(profile, index) {
  const busy = profilesState.loading || profilesState.saving || profilesState.deleting || profilesState.applying;
  const disabled = busy || !profilesOnline() ? ' disabled' : '';
  const active = profile.active === true
    ? '<span class="badge on">上次读取时一致</span>'
    : '<span class="badge off">上次读取时不一致</span>';
  const when = profilesWhen(profile.created_at);
  return `<tr>
    <td><span class="profiles-name" title="${profilesEsc(profile.name || '')}">${profilesEsc(profile.name || '—')}</span></td>
    <td>${profilesEsc(profilesAppsText(profile.apps))}</td>
    <td class="profiles-when"${when.title ? ` title="${profilesEsc(when.title)}"` : ''}>${profilesEsc(when.text)}</td>
    <td>${active}</td>
    <td class="profiles-actions">
      <button class="small" type="button" onclick="profilesPreview(${index})"${disabled}>预览</button>
      <button class="small danger" type="button" onclick="profilesDelete(${index})"${disabled}>删除</button>
    </td>
  </tr>`;
}

function profilesSetListStatus(message, kind = '') {
  profilesState.listMessage = message;
  profilesState.listKind = kind;
  const node = profilesEl('profiles-list-status');
  if (node) {
    node.textContent = message;
    node.className = 'cfg-panel-hint' + (kind ? ' profiles-' + kind : '');
  }
}

function profilesSetSaveStatus(message, kind = '') {
  profilesState.saveMessage = message;
  profilesState.saveKind = kind;
  const node = profilesEl('profiles-save-status');
  if (node) {
    node.textContent = message;
    node.className = 'hint' + (kind ? ' profiles-' + kind : '');
  }
}

function profilesRenderPreview() {
  const panel = profilesEl('profiles-preview-panel');
  if (panel) panel.hidden = !profilesState.previewOpen;
  if (!profilesState.previewOpen) return;
  const status = profilesEl('profiles-preview-status');
  if (status) {
    status.textContent = profilesState.previewMessage;
    status.className = 'cfg-panel-hint' + (profilesState.previewKind ? ' profiles-' + profilesState.previewKind : '');
  }
  const body = profilesEl('profiles-preview-body');
  if (body) {
    const preview = profilesState.preview;
    if (!preview) {
      body.innerHTML = '<p class="hint">还没有可应用的预览。请关闭后重新选择方案。</p>';
    } else {
      const changes = Array.isArray(preview.changes) ? preview.changes : [];
      const apps = preview.apps;
      const warnings = Array.isArray(preview.warnings) ? preview.warnings : [];
      const warningHtml = warnings.length
        ? `<ul class="profiles-warnings">${warnings.map(warning => `<li>${profilesEsc(warning)}</li>`).join('')}</ul>`
        : '';
      const diffHtml = changes.length
        ? `<div class="table-wrap profiles-diff"><table>
            <caption class="sr-only">方案与当前槽位的差异</caption>
            <thead><tr><th scope="col">协议组</th><th scope="col">槽位</th><th scope="col">当前</th><th scope="col">方案</th></tr></thead>
            <tbody>${changes.map(profilesDiffRow).join('')}</tbody></table></div>`
        : '<p class="hint">方案与当前所选协议组的槽位一致，没有差异；应用不会改变槽位。</p>';
      body.innerHTML = `<p class="hint">方案「${profilesEsc(preview.name || '—')}」覆盖 ${profilesEsc(profilesAppsText(apps))}，共 ${changes.length} 处差异。应用会替换所选协议组的整张全局槽位表；未选的协议组原样保留。</p>
        ${warningHtml}${diffHtml}
        <p class="hint">槽位外的内容不会随方案变化：渠道 Key、生效账号、客户端配置、推理强度、压缩、Bots 与会话覆盖都保持原样。</p>`;
    }
  }
  const apply = profilesEl('profiles-apply');
  if (apply) {
    apply.disabled = !profilesState.preview || profilesState.preview.can_apply !== true
      || profilesState.applying || profilesState.previewing || !profilesOnline();
  }
}

function profilesRender() {
  const list = Array.isArray(profilesState.profiles) ? profilesState.profiles : [];
  const revision = profilesState.revision === null || profilesState.revision === undefined
    ? '' : String(profilesState.revision).slice(0, 12);
  const slotsRevision = profilesState.slotsRevision === null || profilesState.slotsRevision === undefined
    ? '' : String(profilesState.slotsRevision).slice(0, 12);
  const hint = profilesEl('profiles-revision-hint');
  if (hint) {
    // 首屏只给容量;修订号是内部值,放 title,遇到 409 时对得上服务端。
    hint.textContent = !profilesState.loaded ? ''
      : list.length >= 30 ? '已达上限 30 个方案；先删除不用的再保存' : `已保存 ${list.length} / 30 个方案`;
    hint.title = profilesState.loaded ? `方案修订 ${revision || '—'} · 槽位修订 ${slotsRevision || '—'}` : '';
  }
  const rows = profilesEl('profiles-rows');
  if (rows) rows.innerHTML = list.map((profile, index) => profilesRow(profile, index)).join('');
  const table = profilesEl('profiles-table');
  if (table) table.hidden = !list.length;
  const empty = profilesEl('profiles-empty');
  if (empty) empty.hidden = !(profilesState.loaded && !list.length);
  const reload = profilesEl('profiles-reload');
  if (reload) reload.disabled = profilesState.loading || profilesState.saving || profilesState.deleting || profilesState.applying;
  const save = profilesEl('profiles-save');
  if (save) {
    save.disabled = !profilesOnline() || !profilesState.loaded || profilesState.revision === null
      || profilesState.loading || profilesState.saving || profilesState.deleting || profilesState.applying || profilesState.previewing || list.length >= 30;
  }
  profilesSetListStatus(profilesState.listMessage, profilesState.listKind);
  profilesSetSaveStatus(profilesState.saveMessage, profilesState.saveKind);
  profilesRenderPreview();
}

function profilesAccept(next) {
  if (!next || typeof next !== 'object' || !Array.isArray(next.profiles) || next.revision === undefined || next.revision === null
      || next.profiles.some(profile => !profile || typeof profile !== 'object'
        || typeof profile.id !== 'string' || !profile.id)) {
    throw new Error('方案数据不完整');
  }
  profilesState.profiles = next.profiles;
  profilesState.revision = next.revision;
  profilesState.slotsRevision = next.slots_revision === undefined ? null : next.slots_revision;
  profilesState.loaded = true;
  // 列表一更新,之前的预览就可能基于旧修订;关掉它,让用户按新数据重新预览。
  if (profilesState.previewOpen) {
    profilesState.previewOpen = false;
    profilesState.preview = null;
    profilesState.previewMessage = '方案列表已更新，请重新预览。';
    profilesState.previewKind = '';
  }
}

async function profilesLoad(manual = false) {
  if (!profilesState.visible || profilesState.loading || profilesState.saving || profilesState.deleting || profilesState.applying || profilesState.previewing) return;
  if (!profilesOnline()) {
    profilesSetListStatus('控制台离线：未读取方案列表。恢复连接后可重新读取。', 'error');
    profilesRender();
    return;
  }
  const seq = ++profilesState.seq;
  profilesState.loading = true;
  // 重新读取时旧列表留在原处(按钮先禁用),只改状态行。
  profilesSetListStatus(profilesState.loaded ? '正在重新读取…' : '正在读取方案列表…');
  profilesRender();
  try {
    const next = await api('/api/profiles');
    if (seq !== profilesState.seq) return;
    profilesAccept(next);
    profilesSetListStatus(`已读取 · ${profilesWhen(new Date()).text}`);
    if (profilesState.saveMessage === INITIAL_SAVE_MESSAGE) {
      profilesSetSaveStatus('填写名称并选择协议组后保存；保存只创建快照。');
    }
  } catch (e) {
    if (seq !== profilesState.seq) return;
    profilesSetListStatus(`读取失败：${e.message}` + (profilesState.loaded ? '（保留上次结果）' : ''), 'error');
  } finally {
    if (seq === profilesState.seq) {
      profilesState.loading = false;
      profilesRender();
    }
  }
}

async function profilesSave() {
  if (profilesState.loading || profilesState.saving || profilesState.deleting || profilesState.applying || profilesState.previewing) return;
  if (!profilesOnline()) {
    profilesSetSaveStatus('控制台离线：方案未保存。', 'error');
    profilesRender();
    return;
  }
  if (!profilesState.loaded || profilesState.revision === null) {
    profilesSetSaveStatus('尚未读取方案列表，无法保存。', 'error');
    profilesRender();
    return;
  }
  const nameInput = profilesEl('profiles-name');
  const name = String(nameInput?.value ?? '').trim();
  if (!name) {
    profilesSetSaveStatus('请输入方案名称。', 'error');
    profilesRender();
    return;
  }
  if (name.length > 80) {
    profilesSetSaveStatus('方案名称最长 80 个字符。', 'error');
    profilesRender();
    return;
  }
  const apps = [];
  if (profilesEl('profiles-app-claude')?.checked) apps.push('claude');
  if (profilesEl('profiles-app-codex')?.checked) apps.push('codex');
  if (!apps.length) {
    profilesSetSaveStatus('至少选择一个协议组。', 'error');
    profilesRender();
    return;
  }
  if (profilesState.profiles.length >= 30) {
    profilesSetSaveStatus('最多保存 30 个方案；请先删除不再使用的方案。', 'error');
    profilesRender();
    return;
  }
  profilesState.saving = true;
  profilesSetSaveStatus('正在保存方案…');
  profilesRender();
  try {
    await api('/api/profiles', { method: 'POST', body: JSON.stringify({
      name,
      apps,
      expected_revision: profilesState.revision,
    }) });
  } catch (e) {
    profilesState.saving = false;
    profilesSetSaveStatus(e.status === 409
      ? '保存冲突：方案列表已变化，请重新读取后再保存。'
      : `保存失败：${e.message}`, 'error');
    profilesRender();
    return;
  }
  profilesState.saving = false;
  if (nameInput) nameInput.value = '';
  profilesSetSaveStatus(`已保存方案「${name}」。只创建快照，当前槽位未改变。`, 'ok');
  await profilesLoad(false);
  profilesRender();
}

async function profilesPreview(index) {
  if (profilesState.previewing || profilesState.loading) return;
  if (!profilesOnline()) {
    profilesSetListStatus('控制台离线：无法预览方案。', 'error');
    profilesRender();
    return;
  }
  const profile = profilesState.profiles[index];
  if (!profile) return;
  profilesState.previewOpen = true;
  profilesState.preview = null;
  profilesState.previewing = true;
  profilesState.previewMessage = '正在解析差异…';
  profilesState.previewKind = '';
  profilesRenderPreview();
  try {
    const next = await api(`/api/profiles/${encodeURIComponent(profile.id)}/preview`, { method: 'POST', body: '{}' });
    if (!next || typeof next !== 'object' || !Array.isArray(next.changes) || !Array.isArray(next.warnings)
        || typeof next.can_apply !== 'boolean' || next.expected_revision === undefined || next.expected_revision === null
        || next.slots_revision === undefined || next.slots_revision === null) {
      throw new Error('预览数据不完整');
    }
    profilesState.preview = { ...next, id: next.id || profile.id, name: next.name || profile.name, apps: profile.apps };
    profile.active = next.changes.length === 0;
    profilesState.slotsRevision = next.slots_revision;
    profilesState.previewMessage = next.can_apply
      ? `差异已读取，共 ${next.changes.length} 处；确认后才会写入槽位。`
      : '存在不可应用的变化，请先处理下面的警告。';
    profilesState.previewKind = next.can_apply ? '' : 'error';
  } catch (e) {
    profilesState.preview = null;
    profilesState.previewMessage = `预览失败：${e.message}`;
    profilesState.previewKind = 'error';
  } finally {
    profilesState.previewing = false;
    profilesRender();
  }
}

function profilesClosePreview() {
  profilesState.previewOpen = false;
  profilesState.preview = null;
  profilesState.previewing = false;
  profilesState.previewMessage = '尚未预览。';
  profilesState.previewKind = '';
  profilesRenderPreview();
}

async function profilesApply() {
  const preview = profilesState.preview;
  if (!preview || preview.can_apply !== true || profilesState.applying || profilesState.previewing) return;
  if (!profilesOnline()) {
    profilesState.previewMessage = '控制台离线：未应用方案。';
    profilesState.previewKind = 'error';
    profilesRenderPreview();
    return;
  }
  const changes = Array.isArray(preview.changes) ? preview.changes : [];
  const apps = preview.apps || [];
  const appText = apps.length ? profilesAppsText(apps) : '所选协议组';
  const confirmed = typeof askConfirm === 'function'
    ? await askConfirm('切换模型方案',
      `将把 ${appText} 的全局槽位替换为方案「${preview.name}」（${changes.length} 处差异）。`
      + '只影响后续新请求：在途请求不会迁移，已有会话级槽位覆盖仍然优先；不改客户端配置、模型选择器或推理强度。',
      '确认切换')
    : false;
  if (!confirmed) return;
  profilesState.applying = true;
  profilesState.previewMessage = '正在切换…';
  profilesState.previewKind = '';
  profilesRenderPreview();
  try {
    await api(`/api/profiles/${encodeURIComponent(preview.id)}/apply`, { method: 'POST', body: JSON.stringify({
      confirm: true,
      expected_revision: preview.expected_revision,
      slots_revision: preview.slots_revision,
    }) });
  } catch (e) {
    profilesState.applying = false;
    if (e.status === 409) {
      profilesState.preview = null;
      profilesState.previewMessage = '槽位或方案已变化，未应用。请关闭预览后重新预览。';
      profilesState.previewKind = 'error';
    } else {
      profilesState.previewMessage = `切换失败：${e.message}`;
      profilesState.previewKind = 'error';
    }
    profilesRenderPreview();
    return;
  }
  profilesState.applying = false;
  profilesState.previewOpen = false;
  profilesState.preview = null;
  await profilesLoad(false);
  profilesSetListStatus(`已切换到「${preview.name}」。后续新请求使用新槽位；在途请求不迁移，会话级覆盖仍然优先；客户端配置与推理强度未改动。`, 'ok');
  profilesRender();
}

async function profilesDelete(index) {
  const profile = profilesState.profiles[index];
  if (!profile || profilesState.deleting || profilesState.applying) return;
  if (!profilesOnline()) {
    profilesSetListStatus('控制台离线：未删除方案。', 'error');
    profilesRender();
    return;
  }
  if (!profilesState.loaded || profilesState.revision === null) {
    profilesSetListStatus('尚未读取方案列表，无法删除。', 'error');
    profilesRender();
    return;
  }
  const confirmed = typeof askConfirm === 'function'
    ? await askConfirm('删除方案', `只删除保存的方案「${profile.name}」，不会回退或改动当前槽位。`, '删除方案')
    : false;
  if (!confirmed) return;
  profilesState.deleting = true;
  profilesSetListStatus(`正在删除方案「${profile.name}」…`);
  profilesRender();
  try {
    await api(`/api/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE', body: JSON.stringify({
      expected_revision: profilesState.revision,
      confirm: true,
    }) });
  } catch (e) {
    profilesState.deleting = false;
    profilesSetListStatus(e.status === 409
      ? '删除冲突：方案列表已变化，请重新读取后再删除。'
      : `删除失败：${e.message}`, 'error');
    profilesRender();
    return;
  }
  profilesState.deleting = false;
  await profilesLoad(false);
  profilesSetListStatus(`已删除方案「${profile.name}」。当前槽位未改变。`, 'ok');
  profilesRender();
}

function profilesSetVisible(on) {
  profilesState.visible = !!on;
  if (profilesState.visible && !profilesState.loaded && !profilesState.loading) profilesLoad(false);
}

if (typeof document !== 'undefined') profilesRender();
