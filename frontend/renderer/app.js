/* ============================================================
   壹准 AI 营销助手 v1.2.2 - 前端逻辑
   wxauto4 引擎 + 图片上传 + 会话列表 + 定时发送 + 朋友圈
   ============================================================ */

const API = 'http://127.0.0.1:5680';

// 后端故障自动恢复计数器
let _apiFailCount = 0;
const _MAX_API_FAILS = 3;

async function apiFetch(url, options = {}) {
  try {
    const res = await fetch(url, options);
    _apiFailCount = 0;
    return res;
  } catch (err) {
    _apiFailCount++;
    if (_apiFailCount >= _MAX_API_FAILS) {
      console.warn('后端连续失败，尝试重启...');
      _apiFailCount = 0;
      try {
        if (window.electronAPI && window.electronAPI.restartBackend) {
          await window.electronAPI.restartBackend();
          await new Promise(r => setTimeout(r, 2000));
          return await fetch(url, options);
        }
      } catch (_) {}
    }
    throw err;
  }
}

let state = {
  currentTab: 0,
  imagePath: null,
  sessions: [],
  selectedRecipients: new Set(),
  sendMode: 'now',
  selectedStyle: '朋友圈',
  config: {},
  scripts: [],
};

// ============================================================
// 初始化
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupPills();
  setupStylePills();
  setupSendMode();
  setupDragDrop();
  document.getElementById('sendBtn')?.addEventListener('click', doBroadcast);
  document.getElementById('manualField')?.addEventListener('input', updateSendInfo);
  document.getElementById('copyText')?.addEventListener('input', updateSendInfo);
  await loadConfig();
  await loadScripts();
  checkWxStatus();
  loadBroadcastScheduledTasks();
  startBroadcastSchedulePoll();
});

// ============================================================
// Tab 切换
// ============================================================

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const idx = parseInt(tab.dataset.tab);
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.querySelector(`[data-panel="${idx}"]`).classList.add('active');
      state.currentTab = idx;
    });
  });
}

// ============================================================
// Pill 选择器
// ============================================================

function setupPills() {
  document.querySelectorAll('.pill-group').forEach(group => {
    group.addEventListener('click', (e) => {
      if (!e.target.classList.contains('pill')) return;
      group.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      e.target.classList.add('active');
    });
  });
}

function setupStylePills() {
  document.getElementById('stylePills').addEventListener('click', (e) => {
    if (e.target.classList.contains('pill')) {
      state.selectedStyle = e.target.dataset.style;
    }
  });
}

function setupSendMode() {
  document.getElementById('sendModeGroup').addEventListener('click', (e) => {
    if (!e.target.classList.contains('pill')) return;
    document.querySelectorAll('#sendModeGroup .pill').forEach(p => p.classList.remove('active'));
    e.target.classList.add('active');
    state.sendMode = e.target.dataset.mode;
    updateSendUI();
  });
}

function updateSendUI() {
  const isScheduled = state.sendMode === 'scheduled';
  document.getElementById('scheduledPanel').classList.toggle('hidden', !isScheduled);
  const btn = document.getElementById('sendBtn');
  btn.textContent = isScheduled ? '创建定时任务' : '立即发送';
  document.getElementById('sendLabel').textContent = isScheduled ? '定时发送' : '一键发送';
  updateSendInfo();
}

// ============================================================
// 图片上传 & 拖拽
// ============================================================

function setupDragDrop() {
  const zone = document.getElementById('uploadZone');
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.style.borderColor = '#0071e3'; });
  zone.addEventListener('dragleave', () => { zone.style.borderColor = ''; });
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.style.borderColor = '';
    const file = e.dataTransfer.files[0];
    if (file) await handleImageFile(file);
  });
}

async function selectImage() {
  if (window.electronAPI) {
    const path = await window.electronAPI.selectImage();
    if (path) {
      state.imagePath = path;
      showImagePreview(path, 'imagePreview', 'uploadIcon', 'uploadText');
      updateSendInfo();
    }
  } else {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (file) await handleImageFile(file);
    };
    input.click();
  }
}

async function handleImageFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch(`${API}/api/image/upload`, { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) {
      state.imagePath = data.path;
      const reader = new FileReader();
      reader.onload = (e) => showImagePreview(e.target.result, 'imagePreview', 'uploadIcon', 'uploadText');
      reader.readAsDataURL(file);
      updateSendInfo();
    } else {
      toast('上传失败: ' + data.error);
    }
  } catch (err) {
    toast('上传失败: ' + err.message);
  }
}

function showImagePreview(src, imgId, iconId, textId) {
  const img = document.getElementById(imgId);
  const icon = document.getElementById(iconId);
  const text = document.getElementById(textId);

  // 不直接加载原图（大图卡死 UI），占位显示文件名，异步尝试缩略图
  img.style.display = 'none';
  const wrap = document.getElementById('imagePreviewWrap');
  if (wrap) {
    let infoEl = document.getElementById('imagePreviewInfo');
    if (!infoEl) {
      infoEl = document.createElement('div');
      infoEl.id = 'imagePreviewInfo';
      infoEl.style.cssText = 'font-size:12px;color:var(--text);text-align:center;padding:8px 12px;word-break:break-all;max-width:100%;';
      wrap.appendChild(infoEl);
    }
    const name = src.split(/[/\\]/).pop() || src;
    infoEl.textContent = '\uD83D\uDDBC ' + name;
    wrap.classList.remove('hidden');
    // 异步小缩略图（失败不影响体验）
    if (window.electronAPI && window.electronAPI.getThumbnail) {
      requestAnimationFrame(() => {
        window.electronAPI.getThumbnail(src, 200).then(r => {
          if (r.dataUrl) { img.style.display = ''; img.src = r.dataUrl; infoEl.remove(); }
        }).catch(() => {});
      });
    }
  }
  if (icon) icon.classList.add('hidden');
  if (text) text.classList.add('hidden');
}

function clearBroadcastImage() {
  state.imagePath = null;
  const img = document.getElementById('imagePreview');
  const wrap = document.getElementById('imagePreviewWrap');
  const icon = document.getElementById('uploadIcon');
  const text = document.getElementById('uploadText');
  if (img) { img.src = ''; img.style.display = ''; }
  if (wrap) wrap.classList.add('hidden');
  const infoEl = document.getElementById('imagePreviewInfo');
  if (infoEl) infoEl.remove();
  if (icon) icon.classList.remove('hidden');
  if (text) text.classList.remove('hidden');
  toast('图片已清除');
}

// ============================================================
// 会话管理
// ============================================================

async function loadSessions() {
  const list = document.getElementById('recipientList');
  list.classList.remove('hidden');
  list.innerHTML = '<div class="empty-state">正在读取微信会话列表...</div>';
  
  // 最多尝试2次（首次超时可重试）
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      list.innerHTML = '<div class="empty-state">首次超时，正在重试...</div>';
      await new Promise(r => setTimeout(r, 1500));
    }
    try {
      const res = await apiFetch(`${API}/api/sessions`);
      const data = await res.json();
      if (data.success) {
        state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
        renderRecipients();
        // 会话加载成功说明微信已连接，直接更新状态
        const _dot = document.querySelector('.status-dot');
        const _txt = document.getElementById('statusText');
        _dot.classList.remove('off');
        _txt.textContent = '微信已连接 ✓';
        if (!state.sessions.length) {
          toast('未读取到真实会话昵称，请先把微信停在聊天首页并保持窗口可见');
        }
        _silent_check();  // 后台刷新（不覆盖已连接文字）
        return;
      } else if (attempt === 2 || !String(data.error || '').includes('超时')) {
        // 最后一次尝试或非超时错误，显示错误
        state.sessions = [];
        renderRecipients();
        const errorText = String(data.error || '获取会话失败，请手动输入联系人发送');
        const weakHint = data.can_manual_send ? '<div class="empty-state">会话列表暂不可用，但你仍可在上方手动输入联系人后直接发送</div>' : '';
        list.innerHTML = `${weakHint}<div class="empty-state">${escapeHtml(errorText)}</div>`;
        toast(errorText);
        console.error('[loadSessions] failed:', errorText, data);
        checkWxStatus();
        return;
      }
      // 超时错误，继续下一次重试
    } catch (err) {
      if (attempt === 2) {
        state.sessions = [];
        renderRecipients();
        list.innerHTML = `<div class="empty-state">连接后端失败：${escapeHtml(err.message)}</div>`;
        toast('连接后端失败: ' + err.message);
        return;
      }
    }
  }
}

function renderRecipients() {
  const list = document.getElementById('recipientList');
  const validSessions = (state.sessions || []).filter(session => {
    const name = String(session?.name || '').trim();
    const preview = String(session?.content || '').trim();
    return !!(name || preview);
  });

  if (validSessions.length === 0) {
    list.innerHTML = '<div class="empty-state">未读取到真实会话昵称，请保持微信聊天首页可见，或先手动输入联系人发送</div>';
  } else {
    list.innerHTML = validSessions.map((session) => {
      const name = String(session?.name || '').trim();
      const preview = String(session?.content || '').trim();
      const target = name || preview;
      const initial = target.charAt(0) || '#';
      const selected = state.selectedRecipients.has(target);
      return `<div class="recipient-item${selected ? ' selected' : ''}" data-target="${escapeHtml(target)}">
        <div class="avatar">${escapeHtml(initial)}</div>
        <div style="flex:1;min-width:0">
          <div class="rec-name">${escapeHtml(target)}</div>
          ${preview && preview !== target ? `<div class="rec-preview">${escapeHtml(preview)}</div>` : ''}
        </div>
        <div class="check-circle"></div>
      </div>`;
    }).join('');

    list.querySelectorAll('.recipient-item').forEach(item => {
      item.addEventListener('click', () => toggleRecipient(item.dataset.target, item));
    });
  }
  list.classList.remove('hidden');
  updateSendInfo();
}

function toggleRecipient(name, el) {
  if (!name) return;
  if (state.selectedRecipients.has(name)) {
    state.selectedRecipients.delete(name);
    el.classList.remove('selected');
  } else {
    state.selectedRecipients.add(name);
    el.classList.add('selected');
  }
  updateSendInfo();
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateSendInfo() {
  const info = document.getElementById('sendInfo');
  const manualText = document.getElementById('manualField').value.trim();

  // 合并手动输入 + 列表选择
  let targets = [];
  if (manualText) {
    targets = manualText.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
  }
  if (state.selectedRecipients.size > 0) {
    targets = [...new Set([...targets, ...Array.from(state.selectedRecipients)])];
  }

  if (targets.length > 0) {
    const hasImage = state.imagePath ? '含图片' : '';
    const hasText = document.getElementById('copyText').value.trim() ? ' + 文案' : '';
    info.innerHTML = `收件人 <strong>${targets.length}</strong> 位 · ${hasImage}${hasText}`;
  } else {
    info.textContent = '请输入收件人和内容';
  }
}


// ============================================================
// 群发 / 定时发送
// ============================================================

function _getTargets() {
  const manualText = document.getElementById('manualField').value.trim();
  let manualTargets = [];
  if (manualText) {
    manualTargets = manualText.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
  }
  const selectedTargets = Array.from(state.selectedRecipients);
  const targets = [...new Set([...manualTargets, ...selectedTargets])];
  let sendMode = 'default';
  // 手动输入收件人 + 有图片：不切 manual_only（键盘模式发不了图）
  if (manualTargets.length > 0 && selectedTargets.length === 0 && !state.imagePath) sendMode = 'manual_only';
  else if (manualTargets.length > 0 && selectedTargets.length > 0) sendMode = 'mixed';
  else if (selectedTargets.length > 0) sendMode = 'session_selected';
  return { targets, sendMode, manualTargets, selectedTargets };
}

async function _checkImageFile(imagePath) {
  // 通过 IPC 验证文件存在 + 大小，超过 2MB 自动压缩（避免 wxauto SendFiles 静默失败）
  if (!window.electronAPI || !window.electronAPI.getFileSize) return {};
  try {
    const r = await window.electronAPI.getFileSize(imagePath);
    if (r.size < 0) return { error: '图片文件不存在，请重新选择' };
    if (r.size === 0) return { error: '图片文件为空，请重新选择' };
    if (r.size > 25 * 1024 * 1024) {
      const mb = (r.size / 1024 / 1024).toFixed(1);
      return { error: `图片过大 (${mb}MB)，微信单张上限约 25MB` };
    }
    // 大于 5MB 自动压缩（wxauto SendFiles 对大文件高概率失败）
    if (r.size > 1 * 1024 * 1024 && window.electronAPI.compressImage) {
      const comp = await window.electronAPI.compressImage(imagePath);
      if (comp.success) {
        const mbBefore = (r.size / 1024 / 1024).toFixed(1);
        const mbAfter = (comp.size / 1024 / 1024).toFixed(1);
        return { size: comp.size, compressedPath: comp.path, note: `已自动压缩 ${mbBefore}MB → ${mbAfter}MB` };
      }
    }
    return { size: r.size };
  } catch (_) { return {}; }
}

async function doBroadcast() {
  const { targets, sendMode } = _getTargets();
  const message = document.getElementById('copyText').value.trim();

  if (targets.length === 0) return toast('请输入收件人（逗号分隔）');
  if (!message && !state.imagePath) return toast('请至少输入发送内容或上传图片');

  // 图片大小检查 + 自动压缩（避免 wxauto 对大图静默失败）
  let sendImagePath = state.imagePath;
  if (state.imagePath) {
    const checked = await _checkImageFile(state.imagePath);
    if (checked.error) return toast(checked.error);
    if (checked.compressedPath) {
      sendImagePath = checked.compressedPath;
      if (checked.note) toast(checked.note);
    }
  }

  const sendBtn = document.getElementById('sendBtn');
  sendBtn.textContent = '处理中...';
  sendBtn.classList.add('sending');
  sendBtn.disabled = true;

  try {
    if (state.sendMode === 'scheduled') {
      await doScheduledSend(targets, message, sendImagePath);
    } else {
      await doImmediateSend(targets, message, sendMode, sendImagePath);
    }
  } finally {
    updateSendUI();
    sendBtn.classList.remove('sending');
    sendBtn.disabled = false;
  }
}

async function doImmediateSend(targets, message, sendMode = 'default', imagePath = null) {
  const interval = parseFloat(document.getElementById('sendInterval').value) || 0.8;

  try {
    // 使用 apiFetch（带自动重启）而非原生 fetch
    const res = await apiFetch(`${API}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targets,
        message,
        image_path: imagePath || state.imagePath || null,
        interval,
        send_mode: sendMode
      })
    });
    const data = await res.json();
    const sent = Number(data.sent || 0);
    const total = Number(data.total || targets.length);
    const failed = Number(data.failed || Math.max(total - sent, 0));
    const fallbackCount = (data.results || []).filter(x => x.fallback === 'keyboard').length;
    const failedItems = (data.results || []).filter(x => !x.success);
    const firstError = failedItems[0]?.error || data.error || '';
    const modeText = data.send_mode === 'manual_only' ? ' · 手动发送模式' : data.send_mode === 'mixed' ? ' · 混合发送模式' : '';
    const extra = `${modeText}${fallbackCount ? ` · 兜底发送 ${fallbackCount} 个` : ''}`;

    if (sent === total && total > 0) {
      toast(`发送完成：${sent}/${total}${extra}`);
    } else if (sent > 0) {
      toast(`部分发送成功：${sent}/${total}，失败 ${failed} 个${firstError ? ' · ' + firstError : ''}`);
    } else {
      toast('发送失败: ' + (firstError || data.error || '全部发送失败'));
    }
  } catch (err) {
    toast('发送失败: ' + err.message);
  }
}

async function doScheduledSend(targets, message, imagePath = null) {
  const scheduledAt = document.getElementById('scheduledTime').value;
  if (!scheduledAt) return toast('请选择定时发送时间');

  try {
    const res = await apiFetch(`${API}/api/broadcast/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targets,
        message,
        image_path: imagePath || state.imagePath || null,
        scheduled_at: scheduledAt
      })
    });
    const data = await res.json();
    if (data.success) {
      toast(`定时任务已创建 · ${data.targets_count}人 · ${data.delay_seconds}秒后执行`);
      loadBroadcastScheduledTasks();
    } else {
      toast('创建失败: ' + (data.error || '未知错误'));
    }
  } catch (err) {
    toast('创建失败: ' + err.message);
  }
}

// ============================================================
// 定时任务管理 (群发中心)
// ============================================================

let _broadcastScheduleTimer = null;

async function loadBroadcastScheduledTasks() {
  try {
    const res = await fetch(`${API}/api/broadcast/schedule`);
    const data = await res.json();
    const card = document.getElementById('scheduledTasksCard');
    if (data.success && data.tasks && data.tasks.length > 0) {
      const activeTasks = data.tasks.filter(t => t.status !== 'cancelled');
      if (activeTasks.length === 0) { card.classList.add('hidden'); return; }
      renderBroadcastScheduledTasks(data.tasks);
      card.classList.remove('hidden');
    } else {
      card.classList.add('hidden');
    }
  } catch (err) {}
}

function startBroadcastSchedulePoll() {
  if (_broadcastScheduleTimer) clearInterval(_broadcastScheduleTimer);
  loadBroadcastScheduledTasks();
  _broadcastScheduleTimer = setInterval(loadBroadcastScheduledTasks, 5000);
}

function renderBroadcastScheduledTasks(tasks) {
  const list = document.getElementById('scheduledTasksList');
  const activeTasks = tasks.filter(t => t.status !== 'cancelled');
  const statusMap = {
    'pending': { text: '等待中', cls: 'tag-pending' },
    'running': { text: '发送中', cls: 'tag-pending' },
    'completed': { text: '已完成', cls: 'tag-ok' },
    'failed': { text: '失败', cls: '' },
  };
  list.innerHTML = activeTasks.map(t => {
    const s = statusMap[t.status] || { text: t.status, cls: '' };
    const timeStr = (t.scheduled_at || '').replace('T', ' ').slice(0, 16);
    return `<div class="schedule-task-item">
      <span class="schedule-task-time">${timeStr}</span>
      <span class="schedule-task-preview">${t.message_preview} · ${t.targets_count}人</span>
      <span class="schedule-task-status"><span class="tag ${s.cls || ''}" style="font-size:10px">${s.text}</span></span>
      ${t.status === 'pending' ? `<span class="ico-btn danger" onclick="cancelBroadcastTask('${t.id}')" title="取消" style="font-size:9px;width:20px;height:20px">✕</span>` : ''}
    </div>`;
  }).join('');
}

async function cancelBroadcastTask(taskId) {
  try {
    const res = await fetch(`${API}/api/broadcast/schedule/${taskId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      toast('任务已取消');
      loadBroadcastScheduledTasks();
    } else {
      toast('取消失败: ' + (data.error || '未知错误'));
    }
  } catch (err) {
    toast('取消失败: ' + err.message);
  }
}

// ============================================================
// AI 文案
// ============================================================

async function generateCopy() {
  const context = document.getElementById('copyText').value.trim();
  if (!context) return toast('请输入场景描述或已有内容');
  try {
    const res = await fetch(`${API}/api/copy/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, style: state.selectedStyle })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('copyText').value = data.copy;
      const badge = document.getElementById('copySourceBadge');
      badge.textContent = data.source === 'ai' ? 'AI 生成' : data.source === 'scripts' ? '话术库匹配' : '本地生成';
      badge.className = 'api-badge' + (data.source === 'ai' ? ' ok' : '');
    } else {
      toast('生成失败: ' + data.error);
    }
  } catch (err) {
    toast('生成失败: ' + err.message);
  }
}

async function generateAICopy() {
  const context = document.getElementById('copyContext').value.trim();
  if (!context) return toast('请输入场景描述');
  try {
    const res = await fetch(`${API}/api/copy/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, style: state.selectedStyle })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('copyResult').textContent = data.copy;
      const badge = document.getElementById('aiSourceBadge');
      badge.textContent = data.source === 'ai' ? 'AI 生成' : data.source === 'scripts' ? '话术库匹配' : '本地生成';
      badge.className = 'api-badge' + (data.source === 'ai' ? ' ok' : '');
      document.getElementById('noApiHint').classList.toggle('hidden', data.source === 'ai');
    } else {
      toast('生成失败: ' + data.error);
    }
  } catch (err) {
    toast('生成失败: ' + err.message);
  }
}

function useCopyForBroadcast() {
  const copy = document.getElementById('copyResult').textContent.trim();
  if (!copy) return toast('没有可用的文案');
  document.getElementById('copyText').value = copy;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.tab[data-tab="0"]').classList.add('active');
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-panel="0"]').classList.add('active');
  state.currentTab = 0;
  updateSendInfo();
  toast('文案已填入群发中心');
}

function copyToClipboard(id) {
  const text = document.getElementById(id).textContent;
  navigator.clipboard.writeText(text).then(() => toast('已复制'));
}

// ============================================================
// 话术库管理
// ============================================================

async function loadScripts() {
  try {
    // 纯 IPC 路径，不依赖 backend.exe
    if (!window.electronAPI || !window.electronAPI.getScripts) {
      state.scripts = [];
      renderScripts();
      console.warn('[Scripts] IPC not available');
      return;
    }
    const result = await window.electronAPI.getScripts();
    state.scripts = result.scripts || [];
    renderScripts();
  } catch (err) {
    console.error('[Scripts] load error:', err);
    state.scripts = [];
    renderScripts();
  }
}

function renderScripts() {
  const list = document.getElementById('scriptsList');
  if (state.scripts.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无话术</div>';
    return;
  }
  list.innerHTML = state.scripts.map(s => {
    const tagClass = getTagClass(s.tag);
    return `<div class="script-item">
      <span class="script-tag ${tagClass}">${s.tag}</span>
      <div class="script-text">${s.text}</div>
      <div class="script-actions">
        <div class="icon-btn" onclick="startEditScript('${s.id}')" title="编辑">&#x270E;</div>
        <div class="icon-btn danger" onclick="deleteScript('${s.id}')" title="删除">&#x2715;</div>
      </div>
    </div>`;
  }).join('');
}

function getTagClass(tag) {
  const map = { '以旧换新': '', '新品推荐': 'tag-new', '促销活动': 'tag-promo', '品牌宣传': 'tag-brand' };
  return map[tag] || '';
}

function showAddScript() {
  document.getElementById('addScriptForm').classList.remove('hidden');
  document.getElementById('editScriptForm').classList.add('hidden');
}

function hideAddScript() {
  document.getElementById('addScriptForm').classList.add('hidden');
  document.getElementById('newScriptTag').value = '';
  document.getElementById('newScriptText').value = '';
}

async function saveScript() {
  const tag = document.getElementById('newScriptTag').value.trim();
  const text = document.getElementById('newScriptText').value.trim();
  if (!tag || !text) return toast('请填写标签和内容');
  try {
    if (!window.electronAPI || !window.electronAPI.addScript) {
      toast('IPC 不可用，请重启应用');
      return;
    }
    const result = await window.electronAPI.addScript({ tag, text });
    if (result.success) {
      toast('话术已添加');
      hideAddScript();
      await loadScripts();
      return;
    }
    toast('添加失败: ' + (result.error || '未知错误'));
    console.error('[Scripts] add error:', result.error);
  } catch (err) {
    toast('添加失败: ' + err.message);
    console.error('[Scripts] add exception:', err);
  }
}

function startEditScript(id) {
  const script = state.scripts.find(s => s.id === id);
  if (!script) return;
  document.getElementById('editScriptForm').classList.remove('hidden');
  document.getElementById('addScriptForm').classList.add('hidden');
  document.getElementById('editScriptId').value = id;
  document.getElementById('editScriptTag').value = script.tag;
  document.getElementById('editScriptText').value = script.text;
}

function hideEditScript() {
  document.getElementById('editScriptForm').classList.add('hidden');
}

async function updateScript() {
  const id = document.getElementById('editScriptId').value;
  const tag = document.getElementById('editScriptTag').value.trim();
  const text = document.getElementById('editScriptText').value.trim();
  if (!tag || !text) return toast('请填写标签和内容');
  try {
    if (!window.electronAPI || !window.electronAPI.updateScript) {
      toast('IPC 不可用，请重启应用');
      return;
    }
    const result = await window.electronAPI.updateScript(id, { tag, text });
    if (result.success) {
      toast('话术已更新');
      hideEditScript();
      await loadScripts();
      return;
    }
    toast('更新失败: ' + (result.error || '未知错误'));
    console.error('[Scripts] update error:', result.error);
  } catch (err) {
    toast('更新失败: ' + err.message);
    console.error('[Scripts] update exception:', err);
  }
}

// 自定义确认弹窗（避免原生 confirm 导致 Electron 输入框失焦）
function _showConfirm(msg) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'toast-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <div class="confirm-text">${msg}</div>
        <div class="confirm-actions">
          <button class="btn btn-ghost" id="confirmCancel">取消</button>
          <button class="btn btn-primary" id="confirmOk">确定</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#confirmOk').onclick = () => { overlay.remove(); resolve(true); };
    overlay.querySelector('#confirmCancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } };
  });
}

async function deleteScript(id) {
  const ok = await _showConfirm('确定删除这条话术？');
  if (!ok) return;
  try {
    if (!window.electronAPI || !window.electronAPI.deleteScript) {
      toast('IPC 不可用，请重启应用');
      return;
    }
    const result = await window.electronAPI.deleteScript(id);
    if (result.success) {
      toast('已删除');
      await loadScripts();
      return;
    }
    toast('删除失败: ' + (result.error || '未知错误'));
    console.error('[Scripts] delete error:', result.error);
  } catch (err) {
    toast('删除失败: ' + err.message);
    console.error('[Scripts] delete exception:', err);
  }
}

// ============================================================
// 配置管理
// ============================================================

async function loadConfig() {
  try {
    const res = await fetch(`${API}/api/config`);
    const data = await res.json();
    if (data.success) {
      state.config = data.config;
      applyConfig();
    }
  } catch (err) {}
}

function applyConfig() {
  const c = state.config;
  if (!c) return;
  document.getElementById('aiEnabled').checked = c.ai?.enabled || false;
  document.getElementById('apiUrl').value = c.ai?.api_url || '';
  document.getElementById('apiKey').value = c.ai?.api_key || '';
  document.getElementById('aiModel').value = c.ai?.model || 'gpt-4o-mini';
  document.getElementById('useScripts').checked = c.fallback?.use_scripts !== false;
  document.getElementById('allowManual').checked = c.fallback?.allow_manual !== false;
  document.getElementById('sendInterval').value = c.broadcast?.interval || 0.8;
  document.getElementById('excludeList').value = (c.broadcast?.exclude || []).join(', ');
}

async function saveAllSettings() {
  const apiKeyInput = document.getElementById('apiKey').value.trim();
  const config = {
    ai: {
      enabled: document.getElementById('aiEnabled').checked,
      api_url: document.getElementById('apiUrl').value.trim(),
      api_key: apiKeyInput || undefined,
      model: document.getElementById('aiModel').value,
    },
    fallback: {
      use_scripts: document.getElementById('useScripts').checked,
      allow_manual: document.getElementById('allowManual').checked,
    },
    broadcast: {
      interval: parseFloat(document.getElementById('sendInterval').value) || 0.8,
      exclude: document.getElementById('excludeList').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
    }
  };
  Object.keys(config.ai).forEach(k => {
    if (config.ai[k] === undefined) delete config.ai[k];
  });

  try {
    const res = await fetch(`${API}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    const data = await res.json();
    if (data.success) {
      state.config = data.config;
      toast('设置已保存');
    }
  } catch (err) {
    toast('保存失败: ' + err.message);
  }
}

async function testApiConnection() {
  try {
    const res = await fetch(`${API}/api/copy/test-api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_url: document.getElementById('apiUrl').value.trim(),
        api_key: document.getElementById('apiKey').value.trim(),
        model: document.getElementById('aiModel').value,
      })
    });
    const data = await res.json();
    const badge = document.getElementById('apiTestBadge');
    if (data.success) {
      badge.textContent = '连接正常';
      badge.className = 'api-badge ok';
      toast('API 连接正常');
    } else {
      badge.textContent = '连接失败';
      badge.className = 'api-badge';
      toast('连接失败: ' + data.error);
    }
  } catch (err) {
    document.getElementById('apiTestBadge').textContent = '连接失败';
    toast('连接失败: ' + err.message);
  }
}

// ============================================================
// 微信状态检查
// ============================================================

async function checkWxStatus() {
  const dot = document.querySelector('.status-dot');
  const text = document.getElementById('statusText');

  try {
    const healthRes = await fetch(`${API}/api/health`);
    const health = await healthRes.json();
    if (!healthRes.ok || health.status !== 'ok') {
      throw new Error('health check failed');
    }
  } catch (err) {
    dot.classList.add('off');
    text.textContent = '后端未启动';
    return;
  }

  try {
    const res = await fetch(`${API}/api/status`);
    const data = await res.json();
    if (data.success === false) {
      dot.classList.add('off');
      text.textContent = data.info || '后端已启动，微信状态读取失败，但仍可手动输入联系人直接发送';
      return;
    }
    if (data.online) {
      dot.classList.remove('off');
      text.textContent = data.info || '微信已连接';
    } else {
      dot.classList.add('off');
      text.textContent = data.info || '可手动输入联系人后直接发送';
    }
  } catch (err) {
    dot.classList.add('off');
    text.textContent = '后端已启动，微信状态读取失败，但仍可手动输入联系人直接发送';
    console.error('[checkWxStatus] status api failed:', err);
  }
}

// 后台静默刷新状态（不覆盖前台显示的"已连接"文字）
async function _silent_check() {
  try {
    const res = await fetch(`${API}/api/status`);
    await res.json();
  } catch (_) {}
}

// ============================================================
// 更新检查
// ============================================================

async function checkUpdate() {
  try {
    const res = await fetch(`${API}/api/update/check`);
    const data = await res.json();
    if (!data.success) {
      toast('检查更新失败: ' + (data.error || '网络错误'));
      return;
    }
    // 前端自己比较版本号（backend.exe 是编译的旧版，_compare_versions 不支持 -preview 后缀）
    const hasUpdate = data.latest && data.current
      ? _compareVersions(data.latest, data.current) > 0
      : false;
    if (hasUpdate) {
      showUpdateDialog(data);
    } else {
      toast('已是最新版本 v' + data.current);
    }
  } catch (err) {
    toast('检查更新失败: ' + err.message);
  }
}

function _compareVersions(v1, v2) {
  function clean(v) {
    v = String(v).replace(/^v/i, '');
    for (const sep of ['-', '+', '_']) {
      const idx = v.indexOf(sep);
      if (idx !== -1) { v = v.substring(0, idx); break; }
    }
    return v.split('.').map(x => parseInt(x, 10) || 0);
  }
  try {
    const p1 = clean(v1);
    const p2 = clean(v2);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const a = p1[i] || 0;
      const b = p2[i] || 0;
      if (a > b) return 1;
      if (a < b) return -1;
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

function showUpdateDialog(updateInfo) {
  const dialog = document.createElement('div');
  dialog.className = 'update-dialog';
  dialog.innerHTML = `<div class="update-dialog-content">
    <div class="update-dialog-title">发现新版本 v${updateInfo.latest}</div>
    <div class="update-dialog-body">${updateInfo.release_notes || '暂无更新说明'}</div>
    <div class="update-dialog-actions">
      <button class="btn btn-ghost" onclick="this.closest('.update-dialog').remove()">稍后</button>
      <button class="btn btn-primary" onclick="downloadUpdate('${updateInfo.download_url || ''}', this.closest('.update-dialog-content'))">下载更新</button>
    </div>
  </div>`;
  document.body.appendChild(dialog);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.remove(); });
}

// 动态更新版本号显示（从后端获取）
async function _updateVersionDisplay() {
  try {
    if (window.electronAPI && window.electronAPI.getRuntimeMeta) {
      const meta = await window.electronAPI.getRuntimeMeta();
      if (meta.frontend_version) {
        const el = document.getElementById('aboutVersion');
        if (el) el.textContent = `v${meta.frontend_version} · 2026`;
        return;
      }
    }
  } catch (_) {}
  // 回退：后端 health 接口
  try {
    const res = await fetch(`${API}/api/health`);
    const data = await res.json();
    if (data.status === 'ok' && data.version) {
      const el = document.getElementById('aboutVersion');
      if (el) el.textContent = `v${data.version} · 2026`;
    }
  } catch (_) {}
}
// DOM 加载完成后自动更新版本显示
document.addEventListener('DOMContentLoaded', _updateVersionDisplay);

function downloadUpdate(url, contentEl) {
  if (!url) return toast('下载链接无效');
  if (!window.electronAPI) { window.open(url, '_blank'); toast('请在浏览器中下载更新包'); return; }

  // 把对话框内容替换为进度条
  contentEl.innerHTML = `
    <div class="update-dialog-title">正在下载更新</div>
    <div class="update-progress">
      <div class="update-progress-bar"><div class="update-progress-fill" id="updateProgressFill"></div></div>
      <div class="update-progress-text" id="updateProgressText">0%</div>
    </div>
    <div class="update-status-text" id="updateStatusText">准备下载...</div>
    <div class="update-dialog-actions">
      <button class="btn btn-ghost" id="updateCancelBtn" style="display:none">取消</button>
    </div>
  `;

  const fill = document.getElementById('updateProgressFill');
  const text = document.getElementById('updateProgressText');
  const status = document.getElementById('updateStatusText');
  const dialogEl = contentEl.closest('.update-dialog');
  let downloadedPath = null;

  window.electronAPI.onDownloadProgress((data) => {
    if (data.status === 'downloading') {
      if (data.totalSize > 0) {
        fill.style.width = data.progress + '%';
        text.textContent = data.progress + '%';
      } else {
        fill.style.width = '50%';  // indeterminate
        text.textContent = Math.round(data.downloaded / 1024 / 1024) + ' MB';
      }
      status.textContent = '正在下载安装包...';
    } else if (data.status === 'complete') {
      downloadedPath = data.filePath;
      fill.style.width = '100%';
      text.textContent = '100%';
      status.textContent = '下载完成';
      // 替换为安装按钮
      contentEl.querySelector('.update-dialog-actions').innerHTML = `
        <button class="btn btn-ghost" onclick="this.closest('.update-dialog').remove()">稍后安装</button>
        <button class="btn btn-primary" id="updateInstallBtn">立即安装</button>
      `;
      document.getElementById('updateInstallBtn').addEventListener('click', () => {
        if (dialogEl) dialogEl.remove();
        if (downloadedPath && window.electronAPI) {
          window.electronAPI.installUpdate(downloadedPath);
        }
      });
    } else if (data.status === 'error') {
      fill.style.background = '#ff3b30';
      status.textContent = '下载失败: ' + (data.error || '未知错误');
      contentEl.querySelector('.update-dialog-actions').innerHTML = `
        <button class="btn btn-ghost" onclick="this.closest('.update-dialog').remove()">关闭</button>
        <button class="btn btn-primary" onclick="downloadUpdate('${url}', this.closest('.update-dialog-content'))">重试</button>
      `;
    }
  });

  window.electronAPI.downloadUpdate(url).catch((err) => {
    status.textContent = '下载失败: ' + err.message;
    fill.style.background = '#ff3b30';
  });
}

// ============================================================
// Toast
// ============================================================

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ============================================================
// 定时时间默认值（5分钟后）
// ============================================================

(() => {
  const now = new Date();
  now.setMinutes(now.getMinutes() + 5);
  const pad = n => String(n).padStart(2, '0');
  const defaultTime = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const el = document.getElementById('scheduledTime');
  if (el) el.value = defaultTime;
})();

// ============================================================
// 朋友圈
// ============================================================

let momentState = {
  mediaPaths: [],    // 图片路径数组（最多9张）
  mediaPath: null,   // 视频路径（仅1个）
  mediaType: null,   // 'image' | 'video' | null
  selectedStyle: '朋友圈',
  sendMode: 'now',   // 'now' | 'scheduled'
  privacy: '公开',    // '公开' | '私密' | '谁可以看' | '不给谁看'
  contact: '',       // 联系人
};

// ── 定时任务存储 (localStorage) ──────────────────
const MOMENT_SCHEDULE_KEY = 'yizhun_moment_scheduled_tasks';

function loadScheduledTasks() {
  try {
    return JSON.parse(localStorage.getItem(MOMENT_SCHEDULE_KEY) || '[]');
  } catch { return []; }
}

function saveScheduledTasks(tasks) {
  localStorage.setItem(MOMENT_SCHEDULE_KEY, JSON.stringify(tasks));
}

function addScheduledTask(task) {
  const tasks = loadScheduledTasks();
  tasks.push(task);
  saveScheduledTasks(tasks);
  renderScheduledTasks();
}

function cancelScheduledTask(id) {
  const tasks = loadScheduledTasks();
  const t = tasks.find(t => t.id === id);
  if (t) {
    t.status = 'cancelled';
    if (t.timerId) clearTimeout(t.timerId);
    saveScheduledTasks(tasks);
    renderScheduledTasks();
    toast('已取消定时任务');
  }
}

function removeScheduledTask(id) {
  let tasks = loadScheduledTasks();
  tasks = tasks.filter(t => t.id !== id);
  saveScheduledTasks(tasks);
  renderScheduledTasks();
}

function renderScheduledTasks() {
  const card = document.getElementById('momentScheduledTasksCard');
  const list = document.getElementById('momentScheduledTasksList');
  const badge = document.getElementById('scheduleBadge');
  if (!card || !list) return;
  const tasks = loadScheduledTasks().filter(t => t.status !== 'cancelled');
  
  // Only show when tasks exist
  card.classList.add('hidden');
  if (badge) badge.classList.add('hidden');
  
  if (tasks.length === 0) return;
  
  card.classList.remove('hidden');
  if (badge) {
    const waiting = tasks.filter(t => t.status === 'waiting').length;
    badge.classList.remove('hidden');
    badge.textContent = waiting + ' 个待执行';
  }
  
  const now = Date.now();
  const items = tasks.map(t => {
    const scheduledMs = new Date(t.scheduledAt).getTime();
    const remaining = Math.max(0, scheduledMs - now);
    let statusHtml = '';
    if (t.status === 'running') {
      statusHtml = '<span class="tag tag-pending">发布中</span>';
    } else if (t.status === 'done') {
      statusHtml = '<span class="tag tag-ok">已完成</span>';
    } else if (remaining <= 0) {
      statusHtml = '<span class="tag tag-pending">执行中</span>';
    } else {
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      statusHtml = `<span style="font-size:10px;color:var(--text3);white-space:nowrap">${m}分${s}秒后</span>`;
    }
    const timeStr = new Date(t.scheduledAt).toLocaleString('zh-CN', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    const mediaCount = t.mediaPaths && t.mediaPaths.length > 0 ? t.mediaPaths.length : 0;
    const preview = (t.text || '无文案').slice(0, 20) + (mediaCount > 0 ? ` 📷${mediaCount}张图` : '');
    return `<div class="schedule-task-item">
      <span class="schedule-task-time">${timeStr}</span>
      <span class="schedule-task-preview" title="${escapeHtml(t.text || '')}">${escapeHtml(preview)}</span>
      <span class="schedule-task-status">${statusHtml}</span>
      ${t.status === 'waiting' ? `<span class="ico-btn danger" onclick="cancelScheduledTask('${t.id}')" title="取消" style="font-size:9px;width:20px;height:20px">✕</span>` : ''}
      ${t.status === 'done' ? `<span class="ico-btn" onclick="removeScheduledTask('${t.id}')" title="清除" style="font-size:9px;width:20px;height:20px">✕</span>` : ''}
    </div>`;
  }).join('');
  list.innerHTML = items;
}

// ── 倒计时 + 执行调度 ──────────────────
let _countdownTimer = null;

function startCountdownLoop() {
  if (_countdownTimer) clearInterval(_countdownTimer);
  _countdownTimer = setInterval(() => {
    renderScheduledTasks();
    // 检查是否有到时间的任务（用时间戳比较，避免时区问题）
    const nowMs = Date.now();
    const tasks = loadScheduledTasks();
    let changed = false;
    for (const t of tasks) {
      if (t.status === 'waiting') {
        const scheduledMs = new Date(t.scheduledAt).getTime();
        if (scheduledMs <= nowMs) {
          t.status = 'running';
          changed = true;
          console.log('[Schedule] 触发执行:', t.id, 'scheduled:', t.scheduledAt);
          // 异步执行发布
          execScheduledTask(t);
        }
      }
    }
    if (changed) saveScheduledTasks(tasks);
  }, 1000);
}

async function execScheduledTask(task) {
  console.log('[Schedule] 执行定时任务:', task.id);
  try {
    const result = await window.electronAPI.publishMoment({
      text: task.text,
      mediaPaths: task.mediaPaths,
      privacy: task.privacy || '公开',
      contact: task.contact || '',
    });
    const tasks = loadScheduledTasks();
    const t = tasks.find(t => t.id === task.id);
    if (t) {
      t.status = result.success ? 'done' : 'cancelled';
      t.result = result;
      saveScheduledTasks(tasks);
    }
    renderScheduledTasks();
    if (result.success) {
      toast('定时发布成功');
    } else {
      toast('定时发布失败: ' + (result.error || '未知错误'));
    }
  } catch (err) {
    console.error('[Schedule] 执行失败:', err);
    const tasks = loadScheduledTasks();
    const t = tasks.find(t => t.id === task.id);
    if (t) { t.status = 'cancelled'; t.error = err.message; saveScheduledTasks(tasks); }
    renderScheduledTasks();
  }
}

// 页面初始化时启动
startCountdownLoop();
renderScheduledTasks();

// 文案风格
(() => {
  const group = document.getElementById('momentStyleGroup');
  if (group) {
    group.addEventListener('click', (e) => {
      if (!e.target.classList.contains('pill')) return;
      group.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      e.target.classList.add('active');
      momentState.selectedStyle = e.target.dataset.style;
    });
  }
})();

// 字数
(() => {
  const ta = document.getElementById('momentText');
  if (ta) ta.addEventListener('input', () => {
    const c = document.getElementById('momentCharCount');
    if (c) c.textContent = ta.value.length;
  });
})();

// 发送模式
(() => {
  const group = document.getElementById('momentSendMode');
  if (group) {
    group.addEventListener('click', (e) => {
      if (!e.target.classList.contains('pill')) return;
      group.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      e.target.classList.add('active');
      momentState.sendMode = e.target.dataset.mode;
      document.getElementById('momentSchedulePanel').classList.toggle('hidden', e.target.dataset.mode !== 'scheduled');
      const btn = document.getElementById('momentPublishBtn');
      btn.textContent = e.target.dataset.mode === 'scheduled' ? '创建定时任务' : '发布朋友圈';
    });
  }
})();

// 上传区点击 → 选图片(多选)
(() => {
  const zone = document.getElementById('momentUploadZone');
  if (zone) {
    zone.addEventListener('click', async () => {
      if (momentState.mediaType === 'video') return; // 视频模式不切换
      await selectMomentImage();
    });
  }
})();

function setMomentPrivacy(mode) {
  momentState.privacy = mode;
  // 更新 pill 样式
  document.querySelectorAll('#privacyPublic, #privacyPrivate').forEach(el => {
    el.classList.remove('active');
  });
  const map = { '公开': 'privacyPublic', '私密': 'privacyPrivate' };
  if (map[mode]) document.getElementById(map[mode]).classList.add('active');
  // 联系人行始终隐藏（谁可以看/不给谁看暂未开放）
  document.getElementById('momentContactRow').classList.add('hidden');
  momentState.contact = '';
}

// 防止文件对话框重复打开
let _momentDialogBusy = false;

async function selectMomentImage() {
  if (_momentDialogBusy) return;
  _momentDialogBusy = true;
  try {
  if (window.electronAPI && window.electronAPI.selectMultipleImages) {
    const paths = await window.electronAPI.selectMultipleImages();
    if (paths && paths.length > 0) {
      for (const p of paths) addMomentImage(p);
    }
  } else if (window.electronAPI) {
    // fallback: single image
    const path = await window.electronAPI.selectImage();
    if (path) addMomentImage(path);
  } else {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
    input.onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      for (const file of files.slice(0, 9)) {
        const fd = new FormData(); fd.append('file', file);
        try {
          const res = await fetch(`${API}/api/image/upload`, { method: 'POST', body: fd });
          const data = await res.json();
          if (data.success) addMomentImage(data.path);
        } catch (err) { toast('上传失败: ' + err.message); }
      }
    };
      input.click();
  }
  } finally { _momentDialogBusy = false; }
}

function addMomentImage(path) {
  if (momentState.mediaType === 'video') return toast('已选择视频，请先清除后再选图片');
  if (momentState.mediaPaths.length >= 9) return toast('图片最多9张');
  if (momentState.mediaPaths.includes(path)) return toast('已添加该图片');
  momentState.mediaType = 'image';
  momentState.mediaPaths.push(path);
  renderMomentMediaGrid();
}

function removeMomentImage(index) {
  momentState.mediaPaths.splice(index, 1);
  if (momentState.mediaPaths.length === 0) {
    momentState.mediaType = null;
  }
  renderMomentMediaGrid();
}

function renderMomentMediaGrid() {
  const zone = document.getElementById('momentUploadZone');
  const grid = document.getElementById('momentMediaGrid');
  const icon = document.getElementById('momentUploadIcon');
  const text = document.getElementById('momentUploadText');
  const preview = document.getElementById('momentMediaPreview');
  preview.classList.add('hidden');

  if (momentState.mediaType === 'video' && momentState.mediaPath) {
    zone.classList.add('has-media');
    grid.innerHTML = '';
    grid.style.display = 'none';
    preview.innerHTML = `<span style="font-size:32px">🎬</span><div style="font-size:12px;color:var(--text2)">视频已选择</div>`;
    preview.classList.remove('hidden');
    icon?.classList.add('hidden');
    text?.classList.add('hidden');
  } else if (momentState.mediaPaths.length > 0) {
    zone.classList.add('has-media');
    grid.style.display = 'flex';
    icon?.classList.add('hidden');
    text?.classList.add('hidden');
    // 占位卡（不直接加载 file:// 原图，避免大图卡死 UI）
    let html = momentState.mediaPaths.map((p, i) => {
      const name = p.split(/[/\\]/).pop() || p;
      return `<div class="grid-item" style="font-size:11px;color:var(--text);text-align:center;padding:6px;word-break:break-all;display:flex;flex-direction:column;justify-content:center;overflow:hidden">
        <span style="font-size:18px;opacity:.6">🖼️</span>
        <span style="margin-top:2px;line-height:1.2;max-height:2.4em;overflow:hidden">${name}</span>
        <span class="del-btn" data-idx="${i}">✕</span>
      </div>`;
    }).join('');
    // Add more button
    if (momentState.mediaPaths.length < 9) {
      html += `<div class="grid-item add-more" id="momentAddMore">+</div>`;
    }
    grid.innerHTML = html;
    grid.querySelectorAll('.grid-item:not(.add-more) .del-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); removeMomentImage(parseInt(btn.dataset.idx)); });
    });
    const addMore = document.getElementById('momentAddMore');
    if (addMore) addMore.addEventListener('click', (e) => { e.stopPropagation(); selectMomentImage(); });
  } else {
    zone.classList.remove('has-media');
    grid.innerHTML = '';
    grid.style.display = 'none';
    icon?.classList.remove('hidden');
    text?.classList.remove('hidden');
  }
}

async function selectMomentVideo() {
  if (momentState.mediaPaths.length > 0) return toast('已添加图片，请先清除后再选视频');
  let path = null;
  if (window.electronAPI) {
    path = await window.electronAPI.selectVideo?.();
  }
  if (!path) {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'video/*';
    path = await new Promise(resolve => {
      input.onchange = (e) => resolve(e.target.files[0]?.path || null);
      input.click();
    });
  }
  if (path) {
    momentState.mediaType = 'video';
    momentState.mediaPath = path;
    renderMomentMediaGrid();
    toast('视频已选择');
  }
}

function clearMomentMedia() {
  momentState.mediaPaths = [];
  momentState.mediaPath = null;
  momentState.mediaType = null;
  const zone = document.getElementById('momentUploadZone');
  zone.classList.remove('has-media');
  document.getElementById('momentMediaGrid').innerHTML = '';
  document.getElementById('momentMediaGrid').style.display = 'none';
  document.getElementById('momentMediaPreview').innerHTML = '';
  document.getElementById('momentMediaPreview').classList.add('hidden');
  document.getElementById('momentUploadIcon')?.classList.remove('hidden');
  document.getElementById('momentUploadText')?.classList.remove('hidden');
}

// 点击上传区统一触发选图
async function handleMomentMediaClick(e) {
  if (e.target.closest('.del-btn') || e.target.closest('.media-chip') || e.target.closest('.add-more')) return;
  await selectMomentImage();
}

async function generateMomentCopy() {
  const ctx = document.getElementById('momentText').value.trim();
  if (!ctx) return toast('请先输入场景描述');
  try {
    const res = await fetch(`${API}/api/copy/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: ctx, style: momentState.selectedStyle })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('momentText').value = data.copy;
      document.getElementById('momentCharCount').textContent = data.copy.length;
      toast(data.source === 'ai' ? 'AI 已生成' : '话术库匹配');
    } else { toast('生成失败: ' + data.error); }
  } catch (err) { toast('生成失败: ' + err.message); }
}


// ── 朋友圈任务管理 ─────────────────────────────────

let momentTaskId = null;
let momentPollTimer = null;

async function cancelMomentTask() {
  if (!momentTaskId) return;
  try {
    const res = await fetch(`${API}/api/moment/tasks/${momentTaskId}/cancel`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      toast('任务已取消');
      stopMomentPolling();
      updateMomentTaskUI({ status: 'cancelled' });
    } else {
      toast('取消失败: ' + (data.error || ''));
    }
  } catch (err) {
    toast('取消失败: ' + err.message);
  }
}

function startMomentPolling(taskId) {
  momentTaskId = taskId;
  stopMomentPolling();
  pollMomentTask();
  momentPollTimer = setInterval(pollMomentTask, 1500);
}

function stopMomentPolling() {
  if (momentPollTimer) { clearInterval(momentPollTimer); momentPollTimer = null; }
}

async function pollMomentTask() {
  if (!momentTaskId) return;
  try {
    const [taskRes, logRes] = await Promise.allSettled([
      fetch(`${API}/api/moment/tasks/${momentTaskId}`),
      fetch(`${API}/api/moment/tasks/${momentTaskId}/logs`)
    ]);

    if (taskRes.status === 'fulfilled' && taskRes.value.ok) {
      const taskData = await taskRes.value.json();
      updateMomentTaskUI(taskData);
      if (['completed', 'failed', 'cancelled'].includes(taskData.status)) {
        stopMomentPolling();
        document.getElementById('momentCancelBtn').style.display = 'none';
      }
    }

    if (logRes.status === 'fulfilled' && logRes.value.ok) {
      const logData = await logRes.value.json();
      renderMomentLogs(logData.logs || logData.events || []);
    }
  } catch (_) {}
}

function updateMomentTaskUI(task) {
  const card = document.getElementById('momentTaskCard');
  card.classList.remove('hidden');

  // status badge
  const statusTexts = {
    created: { text: '已创建', cls: 'pending' },
    pending: { text: '等待中', cls: 'pending' },
    running: { text: '执行中', cls: 'running' },
    completed: { text: '已完成', cls: 'completed' },
    failed: { text: '失败', cls: 'failed' },
    cancelled: { text: '已取消', cls: 'cancelled' },
  };
  const s = statusTexts[task.status] || { text: task.status, cls: 'pending' };
  document.getElementById('momentTaskStatus').innerHTML = `
    <span style="font-size:12px;color:var(--text2)">任务 ${task.task_id || momentTaskId}</span>
    <span class="task-status ${s.cls}" style="margin-left:8px">${s.text}</span>
    ${task.current_step ? `<span style="margin-left:8px;font-size:11px;color:var(--text2)">步骤: ${escapeHtml(task.current_step)}</span>` : ''}
  `;

  // steps
  const steps = task.steps || [];
  document.getElementById('momentStepList').innerHTML = steps.map(step => {
    let iconCls = 'pending';
    if (step.status === 'done') iconCls = 'done';
    else if (step.status === 'current') iconCls = 'current';
    else if (step.status === 'error') iconCls = 'error';
    return `<div class="task-step"><span class="step-icon ${iconCls}">${iconCls === 'done' ? '✓' : iconCls === 'error' ? '✗' : '·'}</span> ${escapeHtml(step.name || step.step)}</div>`;
  }).join('');

  // cancel button
  if (['created', 'pending', 'running'].includes(task.status)) {
    document.getElementById('momentCancelBtn').style.display = '';
  }

  // if completed/failed, show result summary
  const resultCard = document.getElementById('momentResultCard');
  const result = document.getElementById('momentResult');
  if (task.status === 'completed') {
    resultCard.classList.remove('hidden');
    result.innerHTML = '<span style="color:#34c759">发布成功</span>';
  } else if (task.status === 'failed') {
    resultCard.classList.remove('hidden');
    result.innerHTML = `<span style="color:#ff3b30">失败</span><br>${escapeHtml(task.error || task.reason || '未知错误')}`;
  }

  // show log card
  document.getElementById('momentLogCard').classList.remove('hidden');
}

function renderMomentLogs(logs) {
  if (!logs || !logs.length) return;
  const list = document.getElementById('momentLogList');
  list.innerHTML = logs.slice(0, 100).map(l => {
    const lvl = (l.level || 'info').toLowerCase();
    const time = (l.timestamp || l.time || '').slice(-8) || '';
    const msg = l.message || l.msg || JSON.stringify(l);
    return `<div class="log-entry">
      <span class="log-time">${escapeHtml(time)}</span>
      <span class="log-level ${lvl}">${escapeHtml(lvl)}</span>
      <span class="log-msg">${escapeHtml(msg)}</span>
    </div>`;
  }).join('');
}

async function refreshMomentLogs() {
  if (!momentTaskId) return toast('没有活跃任务');
  try {
    const res = await fetch(`${API}/api/moment/tasks/${momentTaskId}/logs`);
    const data = await res.json();
    renderMomentLogs(data.logs || data.events || []);
  } catch (_) {}
}

// ── 发布朋友圈 (task 驱动版) ────────────────────────

async function publishMoment() {
  const text = document.getElementById('momentText').value.trim();
  const hasMedia = momentState.mediaType === 'video' ? !!momentState.mediaPath : momentState.mediaPaths.length > 0;
  if (!text && !hasMedia) return toast('请至少输入文字或上传图片/视频');
  if (text.length > 2000) return toast('文字不能超过2000字');

  // 修复视频扩展名校验
  if (momentState.mediaType === 'video' && momentState.mediaPath) {
    const validExts = /\.(mp4|mov|avi|wmv|mkv|flv|m4v|webm)$/i;
    if (!validExts.test(momentState.mediaPath))
      return toast('视频格式暂不支持，仅支持 mp4/mov/avi/wmv/mkv/flv/m4v/webm');
  }

  const btn = document.getElementById('momentPublishBtn');
  const orig = btn.textContent;
  btn.textContent = '发布中...'; btn.disabled = true;

  const isScheduled = momentState.sendMode === 'scheduled';
  const scheduledAt = isScheduled ? document.getElementById('momentScheduledTime')?.value : null;
  if (isScheduled && !scheduledAt) { btn.textContent = orig; btn.disabled = false; return toast('请选择定时时间'); }

  try {
    // 媒体路径数组
    let mediaPaths = [];
    if (momentState.mediaType === 'video' && momentState.mediaPath) {
      mediaPaths = [momentState.mediaPath];
    } else if (momentState.mediaPaths.length > 0) {
      mediaPaths = momentState.mediaPaths;
    }

    // 读取隐私设置
    const privacy = momentState.privacy || '公开';
    const contact = (privacy === '谁可以看' || privacy === '不给谁看')
      ? (document.getElementById('momentContact')?.value || '').trim()
      : '';

    // ═══ 定时任务：存入 localStorage，由倒计时循环执行 ═══
    if (isScheduled) {
      const task = {
        id: 'm-schedule-' + Date.now(),
        text, mediaPaths, privacy, contact,
        scheduledAt, createdAt: new Date().toISOString(),
        status: 'waiting',
        timerId: null,
      };
      addScheduledTask(task);
      btn.textContent = orig; btn.disabled = false;
      document.getElementById('momentText').value = '';
      document.getElementById('momentCharCount').textContent = '0';
      clearMomentMedia();
      toast('定时任务已创建');
      return;
    }

    // ═══ 即时发送 → Electron IPC ═══
    let result;
    result = await window.electronAPI.publishMoment({ text, mediaPaths, privacy, contact });

    if (result.success) {
      const card = document.getElementById('momentResultCard');
      card.classList.remove('hidden');
      document.getElementById('momentResult').innerHTML = '<span style="color:#34c759">发布成功</span>';
      toast('发布成功');
      document.getElementById('momentText').value = '';
      document.getElementById('momentCharCount').textContent = '0';
      clearMomentMedia();
    } else {
      const card = document.getElementById('momentResultCard');
      card.classList.remove('hidden');
      document.getElementById('momentResult').innerHTML = `<span style="color:#ff3b30">失败</span><br>${result.error || '未知错误'}`;
      toast('失败: ' + (result.error || '未知错误'));
    }

    // 朋友圈发布后静默重启后端（publish_moment.py 已操作微信，
    // wxauto 需要重新初始化 UIA/COM 连接，否则群发中心会挂）
    if (window.electronAPI && window.electronAPI.restartBackend) {
      setTimeout(async () => {
        try {
          const r = await window.electronAPI.restartBackend();
          console.log('[Moments] 后端重启' + (r.success ? '完成' : '超时'));
        } catch (_) {}
      }, 1000);
    }
  } catch (err) {
    document.getElementById('momentResultCard').classList.remove('hidden');
    document.getElementById('momentResult').innerHTML = `<span style="color:#ff3b30">失败</span><br>${err.message}`;
    toast('失败: ' + err.message);
  } finally {
    btn.textContent = orig; btn.disabled = false;
  }
}
