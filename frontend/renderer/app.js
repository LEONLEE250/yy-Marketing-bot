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
  await loadAIConfigs();  // v2.3 AI 配置懒加载（不影响现有流程）
  checkWxStatus();
  loadBroadcastScheduledTasks();
  startBroadcastSchedulePoll();
  platformInit();
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
      // 切换到设置 Tab 时强制刷新 AI 配置
      if (idx === 4) { if (typeof loadAIConfigs === 'function') loadAIConfigs(); }
    });
  });
}

/** 微信助手子标签切换 */
function switchWechatSub(name) {
  document.querySelectorAll('.wechat-subtab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.wechat-subpanel').forEach(p => p.classList.remove('active'));
  const tab = document.querySelector(`.wechat-subtab[data-wechat="${name}"]`);
  if (tab) tab.classList.add('active');
  const panel = document.querySelector(`.wechat-subpanel[data-wechat-panel="${name}"]`);
  if (panel) panel.classList.add('active');
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
  const el = document.getElementById('stylePills');
  if (!el) return;
  el.addEventListener('click', (e) => {
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
  const context = (document.getElementById('copyText')?.value || '').trim();
  if (!context) return toast('请输入场景描述或已有内容');
  try {
    const res = await fetch(`${API}/api/copy/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, style: state.selectedStyle })
    });
    const data = await res.json();
    if (data.success) {
      const ta = document.getElementById('copyText'); if (ta) ta.value = data.copy;
      const badge = document.getElementById('copySourceBadge');
      if (badge) {
        badge.textContent = data.source === 'ai' ? 'AI 生成' : data.source === 'scripts' ? '话术库匹配' : '本地生成';
        badge.className = 'api-badge' + (data.source === 'ai' ? ' ok' : '');
      }
    } else {
      toast('生成失败: ' + data.error);
    }
  } catch (err) {
    toast('生成失败: ' + err.message);
  }
}

async function generateAICopy() {
  const context = (document.getElementById('copyContext')?.value || '').trim();
  if (!context) return toast('请输入场景描述');
  try {
    const res = await fetch(`${API}/api/copy/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, style: state.selectedStyle })
    });
    const data = await res.json();
    if (data.success) {
      const el1 = document.getElementById('copyResult'); if (el1) el1.textContent = data.copy;
      const badge = document.getElementById('aiSourceBadge');
      if (badge) {
        badge.textContent = data.source === 'ai' ? 'AI 生成' : data.source === 'scripts' ? '话术库匹配' : '本地生成';
        badge.className = 'api-badge' + (data.source === 'ai' ? ' ok' : '');
      }
      const hint = document.getElementById('noApiHint'); if (hint) hint.classList.toggle('hidden', data.source === 'ai');
    } else {
      toast('生成失败: ' + data.error);
    }
  } catch (err) {
    toast('生成失败: ' + err.message);
  }
}

function useCopyForBroadcast() {
  const el = document.getElementById('copyResult');
  if (!el) return;
  const copy = el.textContent.trim();
  if (!copy) return toast('没有可用的文案');
  const ta = document.getElementById('copyText'); if (ta) ta.value = copy;
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
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" style="min-width:320px;max-width:400px">
        <div class="modal-header">
          <span>确认</span>
          <button class="modal-close" id="confirmClose">✕</button>
        </div>
        <div class="modal-body" style="text-align:center;font-size:14px;color:var(--text);padding:24px 20px">${msg}</div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="confirmCancel">取消</button>
          <button class="btn btn-primary" id="confirmOk">确定</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#confirmOk').onclick = () => { overlay.remove(); resolve(true); };
    overlay.querySelector('#confirmCancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('#confirmClose').onclick = () => { overlay.remove(); resolve(false); };
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
  const el = (id) => document.getElementById(id);
  const aiEnabledEl = el('aiEnabled'); if (aiEnabledEl) aiEnabledEl.checked = c.ai?.enabled || false;
  if (el('apiUrl')) el('apiUrl').value = c.ai?.api_url || '';
  if (el('apiKey')) el('apiKey').value = c.ai?.api_key || '';
  if (el('aiModel')) el('aiModel').value = c.ai?.model || '';
  if (el('useScripts')) el('useScripts').checked = c.fallback?.use_scripts !== false;
  if (el('allowManual')) el('allowManual').checked = c.fallback?.allow_manual !== false;
  if (el('sendInterval')) el('sendInterval').value = c.broadcast?.interval || 0.8;
  if (el('excludeList')) el('excludeList').value = (c.broadcast?.exclude || []).join(', ');
}

async function saveAllSettings() {
  const getEl = (id) => document.getElementById(id);
  const apiKeyInput = (getEl('apiKey')?.value || '').trim();
  const config = {
    ai: {
      enabled: getEl('aiEnabled')?.checked ?? true,
      api_url: (getEl('apiUrl')?.value || '').trim(),
      api_key: apiKeyInput || undefined,
      model: getEl('aiModel')?.value || '',
    },
    fallback: {
      use_scripts: getEl('useScripts')?.checked ?? true,
      allow_manual: getEl('allowManual')?.checked ?? true,
    },
    broadcast: {
      interval: parseFloat(getEl('sendInterval')?.value) || 0.8,
      exclude: (getEl('excludeList')?.value || '').split(/[,，]/).map(s => s.trim()).filter(Boolean),
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
    try { await saveAIConfigs(); } catch (_) {}
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
// 产品使用指南
// ============================================================

function openGuide() {
  var url = 'https://7bbf09e4ade04b45ba515b0a51e96f53.app.codebuddy.work';
  window.open(url, '_blank');
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
  dialog.className = 'modal-overlay';
  dialog.innerHTML = `<div class="modal-card" style="max-width:420px">
    <div class="modal-header">
      <span>发现新版本 v${updateInfo.latest}</span>
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
    </div>
    <div class="modal-body" style="max-height:160px;overflow-y:auto;font-size:13px;color:var(--text2);line-height:1.6">
      ${updateInfo.release_notes || '暂无更新说明'}
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">稍后</button>
      <button class="btn btn-primary" onclick="downloadUpdate('${updateInfo.download_url || ''}', this.closest('.modal-card'))">下载更新</button>
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
    <div class="modal-header">
      <span>正在下载更新</span>
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
    </div>
    <div class="modal-body" style="text-align:center">
      <div class="update-progress" style="margin:20px 0">
        <div class="update-progress-bar"><div class="update-progress-fill" id="updateProgressFill"></div></div>
        <div class="update-progress-text" id="updateProgressText">0%</div>
      </div>
      <div class="update-status-text" id="updateStatusText" style="font-size:13px;color:var(--text2)">准备下载...</div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="updateCancelBtn" style="display:none">取消</button>
    </div>
  `;

  const fill = document.getElementById('updateProgressFill');
  const text = document.getElementById('updateProgressText');
  const status = document.getElementById('updateStatusText');
  const dialogEl = contentEl.closest('.modal-overlay');
  let downloadedPath = null;

  window.electronAPI.onDownloadProgress((data) => {
    if (data.status === 'preparing') {
      fill.style.width = '0%';
      text.textContent = '0%';
      status.textContent = '正在解析下载地址...';
    } else if (data.status === 'resuming') {
      fill.style.width = '5%';
      text.textContent = '续传中...';
      status.textContent = '检测到未完成的下载，从断点继续';
    } else if (data.status === 'downloading') {
      if (data.totalSize > 0) {
        fill.style.width = data.progress + '%';
        text.textContent = data.progress + '%';
      } else {
        fill.style.width = '50%';
        text.textContent = Math.round(data.downloaded / 1024 / 1024) + ' MB';
      }
      let statusText = '正在下载...';
      if (data.speed) statusText += ' ' + data.speed;
      if (data.elapsed) statusText += ' | 已用时 ' + data.elapsed + 's';
      status.textContent = statusText;
    } else if (data.status === 'complete') {
      downloadedPath = data.filePath;
      fill.style.width = '100%';
      text.textContent = '100%';
      let completeText = '下载完成';
      if (data.speed) completeText += ' (平均 ' + data.speed + ')';
      status.textContent = completeText;
      // 替换为安装按钮
      contentEl.querySelector('.modal-footer').innerHTML = `
        <button class="btn btn-ghost" onclick="dialogEl.remove()">稍后安装</button>
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
      contentEl.querySelector('.modal-footer').innerHTML = `
        <button class="btn btn-ghost" onclick="dialogEl.remove()">关闭</button>
        <button class="btn btn-primary" onclick="downloadUpdate('${url}', dialogEl.querySelector('.modal-card'))">重试</button>
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
      const ta = document.getElementById('momentText'); if (ta) ta.value = data.copy;
      const cc = document.getElementById('momentCharCount'); if (cc) cc.textContent = data.copy.length;
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

function escapeHTML(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════════════════════
//  AI 创意中心 — 状态管理
// ═══════════════════════════════════════════════════════════
function safeErr(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  try { return JSON.stringify(e); } catch (_) { return String(e); }
}

const aiState = {
  subTab: 0,                    // 0=生文案, 1=生图, 2=生视频
  searchEnabled: false,         // 联网搜索开关
  chat:   { messages: [], refPath: null, thinking: false, likedIndex: -1 },
  image:  { messages: [], refPath: null, thinking: false, likedIndex: -1, selectedSize: '1024x1024' },
  video:  { messages: [], refPath: null, thinking: false, likedIndex: -1, selectedDuration: 5, taskId: null, pollingTimer: null, resultLocalPath: null },
};

// ── 工具：取当前模式的 section ──
function _as() { return [aiState.chat, aiState.image, aiState.video][aiState.subTab]; }

// ═══════════════════════════════════════════════════════════
//  AI 创意中心 — 子Tab 切换
// ═══════════════════════════════════════════════════════════
function setupAISubTabs() {
  // 子 tab 切换
  document.querySelectorAll('.ai-subtab').forEach(t => {
    t.addEventListener('click', () => {
      const idx = parseInt(t.dataset.aisub);
      document.querySelectorAll('.ai-subtab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      aiState.subTab = idx;

      // 显示/隐藏模式参数行
      document.querySelectorAll('.ai-mode-param-row').forEach(r => r.classList.add('hidden'));
      const row = document.querySelector(`.ai-mode-param-row[data-aimode="${idx}"]`);
      if (row) row.classList.remove('hidden');

      // 清空参考图标签（模式切换时重置）
      aiRemoveRef();

      // 渲染当前模式的消息
      aiRenderChat();
    });
  });

  // 生图尺寸选择
  const sizePills = document.getElementById('aiImageSizePills');
  if (sizePills) sizePills.addEventListener('click', e => {
    if (e.target.classList.contains('pill')) aiState.image.selectedSize = e.target.dataset.size;
  });

  // 生视频时长选择
  const durPills = document.getElementById('aiVideoDurationPills');
  if (durPills) durPills.addEventListener('click', e => {
    if (e.target.classList.contains('pill')) aiState.video.selectedDuration = parseInt(e.target.dataset.dur) || 5;
  });
}

// 输入框 Enter 发送 + 初始化
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('aiChatInput');
  if (input) input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSendMessage(); }
  });
  setupAISubTabs();
});

// ═══════════════════════════════════════════════════════════
//  发送 / 停止
// ═══════════════════════════════════════════════════════════

function _isAiBusy() {
  return aiState.chat.thinking || aiState.image.thinking || aiState.video.thinking;
}

async function aiSendMessage() {
  if (_isAiBusy()) { await aiStop(); return; }
  if (aiState.subTab === 0) await aiChatSend();
  else if (aiState.subTab === 1) await aiImageSend();
  else await aiVideoSend();
}

async function aiStop() {
  try { await window.electronAPI.aiAbort(); } catch (_) {}
  const sec = _as();
  sec.thinking = false;
  _updateSendBtn();
  sec.messages.push({ role: 'assistant', content: '⏹ 已停止', time: Date.now(), error: true });
  if (aiState.subTab === 2) _aiStopVideo();
  _updateSendBtn();
  aiRenderChat();
}

function _updateSendBtn() {
  const btn = document.getElementById('aiChatSendBtn');
  if (!btn) return;
  const busy = _isAiBusy();
  btn.textContent = busy ? '⏹ 停止' : '发送';
  btn.className = busy ? 'btn btn-sm ai-send-btn btn-danger' : 'btn btn-primary btn-sm ai-send-btn';
}

// ── 生文案发送 ──
async function aiChatSend() {
  const input = document.getElementById('aiChatInput');
  const text = input.value.trim();
  const sec = aiState.chat;
  if (!text && !sec.refPath) return;
  if (sec.thinking) return;

  sec.messages.push({ role: 'user', content: text, time: Date.now(), refPath: sec.refPath });
  input.value = '';
  aiRemoveRef();
  sec.thinking = true;
  _updateSendBtn();
  aiRenderChat();

  let result;
  try { result = await window.electronAPI.aiChat({ sessionId: 'default', messages: _chatMsgs(), searchEnabled: aiState.searchEnabled }); }
  catch (e) { result = { success: false, error: e.message }; }

  sec.thinking = false;
  _updateSendBtn();
  if (result.success) {
    sec.messages.push({ role: 'assistant', content: result.content, time: Date.now() });
    // 联网搜索状态提示
    if (result.searchInfo) {
      if (result.searchInfo.success) {
        sec.messages.push({ role: 'system', content: '🌐 已联网搜索「' + result.searchInfo.query + '」，找到 ' + result.searchInfo.count + ' 条结果', time: Date.now() });
      } else {
        sec.messages.push({ role: 'system', content: '🌐 联网搜索失败：' + result.searchInfo.reason + '（DuckDuckGo API 可能被墙，不影响对话）', time: Date.now() });
      }
    }
  } else {
    sec.messages.push({ role: 'assistant', content: '❌ ' + safeErr(result.error), time: Date.now(), error: true });
  }
  aiRenderChat();
}

function _chatMsgs() {
  const msgs = [{ role: 'system', content: '你是壹准二手手机店的营销文案助手。根据用户内容生成适合微信营销的文案，保持亲切自然，可带 emoji。' }];
  for (const m of aiState.chat.messages) {
    // 保留 refPath，由 main.js 转为 Vision base64（不在此处转文本）
    msgs.push({ role: m.role, content: m.content, refPath: m.refPath || null });
  }
  return msgs;
}

// ── 生图发送 ──
async function aiImageSend() {
  const input = document.getElementById('aiChatInput');
  const text = input.value.trim();
  const sec = aiState.image;
  if (!text && !sec.refPath) return;
  if (sec.thinking) return;

  sec.messages.push({ role: 'user', content: text || '生成图片', time: Date.now(), refPath: sec.refPath });
  input.value = '';
  sec.thinking = true;
  _updateSendBtn();
  aiRenderChat();

  const getV = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const cfg = { api_url: getV('aiImageApiUrl') || undefined, api_key: getV('aiImageApiKey') || undefined, model: getV('aiImageModel') || undefined };
  const opts = { size: sec.selectedSize };
  if (sec.refPath) opts.reference_image_path = sec.refPath;

  let result;
  try { result = await window.electronAPI.aiGenerateImage({ prompt: text || 'generate image', options: opts, config: cfg }); }
  catch (e) { result = { success: false, error: e.message }; }

  sec.thinking = false;
  _updateSendBtn();
  aiRemoveRef();

  if (result.success && result.images && result.images.length > 0) {
    sec.messages.push({ role: 'assistant', content: '已生成图片', time: Date.now(), type: 'image', images: result.images });
  } else {
    sec.messages.push({ role: 'assistant', content: '❌ 生成失败: ' + safeErr(result.error), time: Date.now(), error: true });
  }
  aiRenderChat();
}

// ── 生视频发送 ──
async function aiVideoSend() {
  const input = document.getElementById('aiChatInput');
  const text = input.value.trim();
  const sec = aiState.video;
  if (!text) return;
  if (sec.thinking) return;

  sec.messages.push({ role: 'user', content: text, time: Date.now(), refPath: sec.refPath });
  input.value = '';
  sec.thinking = true;
  _updateSendBtn();
  aiRenderChat();

  document.getElementById('aiVideoProgressCard').classList.remove('hidden');
  document.getElementById('aiVideoProgressBar').style.width = '5%';
  document.getElementById('aiVideoProgressText').textContent = '正在提交…';

  const getV = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const cfg = { api_url: getV('aiVideoApiUrl') || undefined, api_key: getV('aiVideoApiKey') || undefined, model: getV('aiVideoModel') || undefined };
  const opts = { duration: sec.selectedDuration };
  if (sec.refPath) opts.reference_image_path = sec.refPath;

  let cr;
  try { cr = await window.electronAPI.aiCreateVideoTask({ prompt: text, options: opts, config: cfg }); }
  catch (e) { cr = { success: false, error: e.message }; }

  aiRemoveRef();

  if (!cr.success || !cr.task_id) {
    sec.thinking = false;
  _updateSendBtn();
    document.getElementById('aiVideoProgressText').textContent = '提交失败: ' + safeErr(cr.error);
    sec.messages.push({ role: 'assistant', content: '❌ 创建失败: ' + safeErr(cr.error), time: Date.now(), error: true });
    aiRenderChat();
    return;
  }

  sec.taskId = cr.task_id;
  document.getElementById('aiVideoProgressBar').style.width = '10%';
  document.getElementById('aiVideoProgressText').textContent = '生成中，预计 2-5 分钟…';
  _aiPollVideoLoop();
}

async function _aiPollVideoLoop() {
  const sec = aiState.video;
  if (!sec.taskId) return;
  try {
    const r = await window.electronAPI.aiPollVideoTask({ taskId: sec.taskId });
    const bar = document.getElementById('aiVideoProgressBar');
    const text = document.getElementById('aiVideoProgressText');

    if (!r.success) {
      text.textContent = '查询失败: ' + safeErr(r.error);
      sec.thinking = false;
  _updateSendBtn();
      sec.messages.push({ role: 'assistant', content: '❌ 视频失败: ' + safeErr(r.error), time: Date.now(), error: true });
      aiRenderChat(); _aiStopVideo();
    } else if (r.status === 'completed') {
      bar.style.width = '100%'; text.textContent = '完成！';
      sec.thinking = false;
  _updateSendBtn(); sec.resultLocalPath = r.local_path;
      sec.messages.push({ role: 'assistant', content: '视频已生成', time: Date.now(), type: 'video', localPath: r.local_path, videoUrl: r.video_url });
      aiRenderChat(); _aiStopVideo();
    } else if (r.status === 'failed') {
      text.textContent = '失败: ' + safeErr(r.error);
      sec.thinking = false;
  _updateSendBtn();
      sec.messages.push({ role: 'assistant', content: '❌ 视频失败: ' + safeErr(r.error), time: Date.now(), error: true });
      aiRenderChat(); _aiStopVideo();
    } else {
      bar.style.width = Math.min((parseFloat(bar.style.width) || 10) + 8, 85) + '%';
      text.textContent = '生成中，预计还需 1-3 分钟…';
      sec.pollingTimer = setTimeout(_aiPollVideoLoop, 8000);
    }
  } catch (e) {
    document.getElementById('aiVideoProgressText').textContent = '轮询出错: ' + e.message;
    const s = aiState.video; s.thinking = false;
    s.messages.push({ role: 'assistant', content: '❌ 轮询出错: ' + e.message, time: Date.now(), error: true });
    aiRenderChat(); _aiStopVideo();
  }
}

function _aiStopVideo() {
  const sec = aiState.video;
  if (sec.pollingTimer) { clearTimeout(sec.pollingTimer); sec.pollingTimer = null; }
  document.getElementById('aiVideoProgressCard').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════
//  渲染聊天
// ═══════════════════════════════════════════════════════════
function aiRenderChat() {
  const area = document.getElementById('aiChatArea');
  const empty = document.getElementById('aiChatEmpty');
  const actions = document.getElementById('aiChatActions');
  const sec = _as();

  area.querySelectorAll('.ai-msg, .ai-msg-actions').forEach(m => m.remove());

  if (sec.messages.length === 0 && !sec.thinking) {
    empty.classList.remove('hidden');
    actions.classList.add('hidden');
    const icons = ['💬', '🎨', '🎬'];
    const hints = [
      '输入你的需求，AI 帮你写营销文案<br>支持连续对话，不满意可继续修改',
      '描述你想生成的图片<br>支持连续对话，可上传参考图进行图生图',
      '描述你想生成的视频内容<br>支持连续对话，可上传首帧图',
    ];
    empty.querySelector('.ai-chat-empty-icon').textContent = icons[aiState.subTab];
    empty.querySelector('.ai-chat-empty-text').innerHTML = hints[aiState.subTab];
    return;
  }
  empty.classList.add('hidden');

  let html = '';
  for (let i = 0; i < sec.messages.length; i++) {
    const m = sec.messages[i];
    const isUser = m.role === 'user';
    html += '<div class="ai-msg ' + (isUser ? 'user' : 'assistant') + '">';
    html += '<div class="ai-msg-avatar">' + (isUser ? '👤' : '🤖') + '</div>';
    html += '<div class="ai-msg-bubble">' + escapeHTML(m.content || '');
    // 用户消息：显示参考图缩略图
    if (isUser && m.refPath) {
      html += '<div class="ai-msg-ref-thumb" onclick="aiShowLightbox(\'img\',\'file://' + m.refPath + '\')"><img src="file://' + m.refPath + '" /></div>';
    }
    if (m.type === 'image' && m.images) {
      html += '<div class="ai-msg-media ai-img-grid">';
      m.images.forEach((img, j) => {
        const src = img.local_path ? 'file://' + img.local_path : img.url;
        html += '<img src="' + src + '" onclick="event.stopPropagation(); aiImgClick(' + i + ',' + j + '); aiShowLightbox(\'img\',\'' + src + '\')" class="' + (m.selectedIdx === j ? 'selected' : '') + '" onerror="this.style.display=\'none\'" />';
      });
      html += '</div>';
    }
    if (m.type === 'video') {
      const src = m.localPath ? 'file://' + m.localPath : (m.videoUrl || '');
      html += '<div class="ai-msg-media"><video controls src="' + src + '" onerror="this.style.display=\'none\'"></video></div>';
    }
    html += '</div></div>';

    if (!isUser && !m.error) {
      const liked = sec.likedIndex === i;
      html += '<div class="ai-msg-actions">';
      html += '<button class="' + (liked ? 'active' : '') + '" onclick="aiLikeMsg(' + i + ')">👍 满意</button>';
      html += '<button onclick="aiRetryMsg()">🔄 再改改</button>';
      html += '</div>';
    }
  }

  if (sec.thinking) {
    const verbs = ['思考', '生成图片', '生成视频'];
    html += '<div class="ai-msg assistant ai-thinking"><div class="ai-msg-avatar">🤖</div>';
    html += '<div class="ai-msg-bubble"><span>AI 正在' + verbs[aiState.subTab] + '</span>';
    html += '<span class="ai-thinking-dots"><span></span><span></span><span></span></span></div></div>';
  }

  const temp = document.createElement('div');
  temp.innerHTML = html;
  while (temp.firstChild) area.appendChild(temp.firstChild);
  area.scrollTop = area.scrollHeight;

  const hasResult = sec.messages.some(m => m.role === 'assistant' && !m.error);
  actions.classList.toggle('hidden', !hasResult);

  // 动态更新复制/保存按钮
  const btn = document.getElementById('aiActionCopySaveBtn');
  if (btn) {
    btn.innerHTML = (aiState.subTab === 0) ? '📋 复制' : '💾 保存';
    btn.onclick = aiCopyResult;
  }
}

function aiImgClick(msgIdx, imgIdx) {
  const sec = _as();
  const m = sec.messages[msgIdx];
  if (!m || !m.images) return;
  m.selectedIdx = (m.selectedIdx === imgIdx) ? -1 : imgIdx;
  aiRenderChat();
}

// ── 满意 / 再改改 ──
function aiLikeMsg(idx) {
  const sec = _as();
  sec.likedIndex = (sec.likedIndex === idx) ? -1 : idx;
  aiRenderChat();
  if (sec.likedIndex >= 0) toast('已标记为满意');
}
function aiRetryMsg() {
  const sec = _as();
  if (sec.thinking) return;
  const input = document.getElementById('aiChatInput');
  input.value = '请换一种风格重新生成';
  aiSendMessage();
}

// ── 清空对话 ──
function aiClearChat() {
  const sec = _as();
  sec.messages = [];
  sec.likedIndex = -1;
  sec.thinking = false;
  _updateSendBtn();
  if (aiState.subTab === 2) { _aiStopVideo(); aiState.video.taskId = null; aiState.video.resultLocalPath = null; }
  aiRemoveRef();
  aiRenderChat();
  toast('对话已清空');
}

// ── 复制 / 用于群发 / 用于朋友圈（直接填入 + 跳转）──
function _switchToTab(idx) {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(t => t.classList.remove('active'));
  const target = document.querySelector(`.tab[data-tab="${idx}"]`);
  if (target) target.classList.add('active');
  const panels = document.querySelectorAll('.panel');
  panels.forEach(p => p.classList.remove('active'));
  const panel = document.querySelector(`[data-panel="${idx}"]`);
  if (panel) panel.classList.add('active');
  state.currentTab = idx;
}

function aiCopyResult() {
  const sec = _as();
  const liked = _getLiked(sec);
  if (!liked) return toast('没有可复制的内容');
  
  if (liked.type === 'image' && liked.images) {
    // 生图：保存图片
    const img = liked.images[liked.selectedIdx || 0];
    if (!img) return toast('请先选中一张图片');
    const p = img.local_path || img.url;
    if (!p) return toast('图片路径无效');
    if (window.electronAPI && window.electronAPI.saveFile) {
      window.electronAPI.saveFile(p).then(r => { if (r) toast('已保存: ' + r); else toast('保存已取消'); });
    } else {
      navigator.clipboard.writeText(p).then(() => toast('路径已复制'));
    }
  } else if (liked.type === 'video' && liked.localPath) {
    // 生视频：保存视频
    if (window.electronAPI && window.electronAPI.saveFile) {
      window.electronAPI.saveFile(liked.localPath).then(r => { if (r) toast('已保存: ' + r); else toast('保存已取消'); });
    } else {
      navigator.clipboard.writeText(liked.localPath).then(() => toast('路径已复制'));
    }
  } else {
    navigator.clipboard.writeText(liked.content || '').then(() => toast('已复制'));
  }
}

function aiUseForBroadcast() {
  const sec = _as();
  const liked = _getLiked(sec);
  if (!liked) return toast('没有可用的内容');

  if (liked.type === 'image' && liked.images) {
    // 生图：填入群发中心图片
    const img = liked.images[liked.selectedIdx || 0];
    if (!img) return toast('请先选中一张图片');
    if (img.local_path) {
      showImagePreview('file://' + img.local_path, 'imagePreview', 'uploadIcon', 'uploadText');
      state.imagePath = img.local_path;
    } else if (img.url) {
      // local_path 为空时直接用 URL（走 file:// 不支持 URL，用 state 存 URL 标记）
      state.imagePath = img.url;
      showImagePreview(img.url, 'imagePreview', 'uploadIcon', 'uploadText');
    } else {
      return toast('图片数据无效');
    }
    _switchToTab(1);
    toast('图片已填入群发中心');
  } else if (liked.type === 'video' && liked.localPath) {
    // 生视频：填入群发中心
    state.imagePath = liked.localPath;
    updateSendInfo();
    _switchToTab(1);
    toast('视频路径已填入群发中心');
  } else {
    // 生文案：填入文字
    const ta = document.getElementById('copyText');
    if (ta) ta.value = liked.content || '';
    _switchToTab(1);
    updateSendInfo();
    toast('文案已填入群发中心');
  }
}

function aiUseForMoment() {
  const sec = _as();
  const liked = _getLiked(sec);
  if (!liked) return toast('没有可用的内容');

  if (liked.type === 'image' && liked.images) {
    // 生图：填入朋友圈媒体
    const img = liked.images[liked.selectedIdx || 0];
    if (!img) return toast('请先选中一张图片');
    const path = img.local_path || img.url;
    if (!path) return toast('图片数据无效');
    _addToMomentMedia(path);
    _switchToTab(2);
    toast('图片已添加到朋友圈');
  } else if (liked.type === 'video' && liked.localPath) {
    _addToMomentMedia(liked.localPath);
    _switchToTab(2);
    toast('视频已添加到朋友圈');
  } else {
    // 生文案：填入文字
    const ta = document.getElementById('momentText');
    if (ta) ta.value = liked.content || '';
    const cc = document.getElementById('momentCharCount');
    if (cc) cc.textContent = (liked.content || '').length;
    _switchToTab(2);
    toast('文案已填入朋友圈');
  }
}

function _addToMomentMedia(filePath) {
  if (!window.momentState) return;
  if (!momentState.mediaPaths) momentState.mediaPaths = [];
  if (momentState.mediaPaths.length >= 9) return toast('朋友圈最多9张/段媒体');
  momentState.mediaPaths.push(filePath);
  if (typeof renderMomentMediaGrid === 'function') renderMomentMediaGrid();
}

function _getLiked(sec) {
  return sec.likedIndex >= 0 ? sec.messages[sec.likedIndex]
    : [...sec.messages].reverse().find(m => m.role === 'assistant' && !m.error);
}

// ── 参考图上传（统一入口）──
async function aiPickRef() {
  if (!window.electronAPI || !window.electronAPI.selectReferenceImage) return toast('功能不可用');
  const p = await window.electronAPI.selectReferenceImage();
  if (!p) return;
  const sec = _as();
  sec.refPath = p;
  document.getElementById('aiChatImageTag').classList.remove('hidden');
  document.getElementById('aiChatThumb').src = 'file://' + p;
}
function aiRemoveRef() {
  [aiState.chat, aiState.image, aiState.video].forEach(s => s.refPath = null);
  document.getElementById('aiChatImageTag').classList.add('hidden');
  document.getElementById('aiChatThumb').src = '';
}

// ── 联网搜索开关 ──
function aiToggleSearch() {
  aiState.searchEnabled = !aiState.searchEnabled;
  const btn = document.getElementById('aiSearchToggle');
  if (btn) btn.style.opacity = aiState.searchEnabled ? '1' : '0.4';
  toast(aiState.searchEnabled ? '🌐 联网搜索已开启' : '联网搜索已关闭');
}

// ── 媒体灯箱 ──
function aiShowLightbox(mode, src) {
  const box = document.getElementById('aiLightbox');
  const img = document.getElementById('aiLightboxImg');
  const vid = document.getElementById('aiLightboxVideo');
  if (!box) return;
  box.classList.remove('hidden');
  if (mode === 'video') {
    img.style.display = 'none'; vid.style.display = 'block'; vid.src = src;
  } else {
    vid.style.display = 'none'; img.style.display = 'block'; img.src = src;
  }
}
function aiHideLightbox() {
  const box = document.getElementById('aiLightbox');
  if (box) box.classList.add('hidden');
}

// ── 点击气泡复制文案 ──
document.addEventListener('click', e => {
  const bubble = e.target.closest('.ai-msg-bubble');
  if (!bubble) return;
  // 不拦截媒体区域的点击
  if (e.target.closest('.ai-msg-media') || e.target.closest('video') || e.target.closest('img')) return;
  // 不拦截 action 按钮
  if (e.target.closest('.ai-msg-actions')) return;
  const text = bubble.innerText.trim();
  if (text && text.length > 3) {
    navigator.clipboard.writeText(text).then(() => toast('已复制文案'));
  }
});

// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
//  资源数据库
// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
//  资源数据库
// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
//  资源数据库 - 完整重写版
// ═══════════════════════════════════════════════════════════

const dbState = { 
  items: [], 
  filterType: '', 
  filterQuery: '', 
  selectedId: null, 
  pickerTarget: null, 
  pickerSelected: null
};

// ════════════════════════════
//  资源库 Tab
// ════════════════════════════

async function dbLoad() {
  try { dbState.items = await window.electronAPI.dbList() || []; } catch { dbState.items = []; }
  dbRender(); dbShowStoragePath();
}

function dbShowStoragePath() {
  if (!window.electronAPI || !window.electronAPI.dbGetPath) return;
  window.electronAPI.dbGetPath().then(function(p) {
    var el = document.getElementById('dbStoragePath'); if (el) el.textContent = '📁 ' + (p || '默认目录');
  }).catch(function(){});
}

function dbFilter() {
  dbState.filterQuery = (document.getElementById('dbSearchInput') || {}).value || '';
  dbRender();
}

function dbRender() {
  var list = document.getElementById('dbList'); if (!list) return;
  var q = dbState.filterQuery.toLowerCase();
  var items = dbState.items;
  if (dbState.filterType) items = items.filter(function(x) { return x.type === dbState.filterType; });
  if (q) items = items.filter(function(x) {
    return (x.title||'').toLowerCase().indexOf(q) >= 0 ||
           (x.content||'').toLowerCase().indexOf(q) >= 0 ||
           (x.tags||[]).some(function(t) { return t.toLowerCase().indexOf(q) >= 0; });
  });
  if (items.length === 0) {
    list.innerHTML = '<div style="padding:40px;text-align:center;color:#888;font-size:14px">暂无资源，点击「+ 新建」添加</div>';
    return;
  }
  var html = '<div class="db-grid">';
  items.forEach(function(x) {
    var sel = dbState.selectedId === x.id ? ' selected' : '';
    var body = '';
    if (x.type === 'image' && x.filePath) {
      body = '<div class="db-grid-img"><img src="file://' + x.filePath + '" onerror="this.style.display=\'none\'" /></div>';
    } else if (x.type === 'video') {
      body = '<div class="db-grid-vid">🎬 ' + escapeHTML((x.filePath||'').split(/[\\\\/]/).pop()||'视频') + '</div>';
    } else {
      body = '<div class="db-grid-txt">' + escapeHTML((x.content||'').slice(0,100)) + '</div>';
    }
    var tags = '';
    if (x.tags && x.tags.length) {
      tags = '<div class="db-tags">' + x.tags.map(function(t) { return '<span class="db-tag">' + escapeHTML(t) + '</span>'; }).join('') + '</div>';
    }
    html += '<div class="db-card' + sel + '" onclick="dbSelect(\'' + x.id + '\')">' +
      '<div class="db-card-hdr"><span>' + (x.type==='image'?'🖼':x.type==='video'?'🎬':'📝') + '</span><span style="flex:1"></span>' +
      '<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();dbEdit(\'' + x.id + '\')">✏️</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();dbDelete(\'' + x.id + '\')">🗑</button></div>' +
      body +
      '<div class="db-card-ftr"><div class="db-title">' + escapeHTML(x.title||'无标题') + '</div>' + tags + '</div></div>';
  });
  html += '</div>';
  list.innerHTML = html;
}

function dbSelect(id) { dbState.selectedId = (dbState.selectedId === id ? null : id); dbRender(); }

// ════════════════════════════
//  新建/编辑
// ════════════════════════════

var _dbFilePath = null;

function dbShowAdd() { _dbResetForm(); document.getElementById('dbModalTitle').textContent = '新建资源'; document.getElementById('dbSaveBtn').textContent = '保存'; document.getElementById('dbModal').classList.remove('hidden'); dbTypeChange(); }

function _dbResetForm() {
  document.getElementById('dbEditId').value = '';
  document.getElementById('dbType').value = 'text';
  document.getElementById('dbTitle').value = '';
  document.getElementById('dbTags').value = '';
  document.getElementById('dbContent').value = '';
  document.getElementById('dbFileName').textContent = '';
  _dbFilePath = null;
  document.getElementById('dbPreview').style.display = 'none';
}

function dbTypeChange() {
  var t = document.getElementById('dbType').value;
  document.getElementById('dbContentRow').classList.toggle('hidden', t !== 'text');
  document.getElementById('dbFileRow').classList.toggle('hidden', t === 'text');
}

function dbHideModal() { document.getElementById('dbModal').classList.add('hidden'); }

async function dbPickFile() {
  if (!window.electronAPI || !window.electronAPI.selectFile) {
    toast('文件选择功能暂不可用，请联系技术支持');
    return;
  }
  var t = document.getElementById('dbType').value;
  var types = t === 'video' ? ['video'] : t === 'image' ? ['image'] : ['doc'];
  var p = await window.electronAPI.selectFile(types);
  if (!p) return;
  _dbFilePath = p;
  document.getElementById('dbFileName').textContent = p.split(/[\\\\/]/).pop();
  document.getElementById('dbPreview').style.display = '';
  if (t === 'image') {
    document.getElementById('dbPreviewImg').src = 'file://' + p;
    document.getElementById('dbPreviewImg').style.display = '';
    document.getElementById('dbPreviewVid').style.display = 'none';
  } else if (t === 'video') {
    document.getElementById('dbPreviewVid').src = 'file://' + p;
    document.getElementById('dbPreviewVid').style.display = '';
    document.getElementById('dbPreviewImg').style.display = 'none';
  }
}

async function dbEdit(id) {
  var item = dbState.items.find(function(x) { return x.id === id; });
  if (!item) return;
  document.getElementById('dbEditId').value = item.id;
  document.getElementById('dbType').value = item.type;
  document.getElementById('dbTitle').value = item.title || '';
  document.getElementById('dbTags').value = (item.tags||[]).join(',');
  document.getElementById('dbContent').value = item.content || '';
  _dbFilePath = item.filePath;
  document.getElementById('dbFileName').textContent = item.filePath ? item.filePath.split(/[\\\\/]/).pop() : '';
  document.getElementById('dbModalTitle').textContent = '编辑资源';
  document.getElementById('dbSaveBtn').textContent = '更新';
  document.getElementById('dbModal').classList.remove('hidden');
  dbTypeChange();
  if ((item.type === 'image' || item.type === 'video') && item.filePath) {
    document.getElementById('dbPreview').style.display = '';
    if (item.type === 'image') {
      document.getElementById('dbPreviewImg').src = 'file://' + item.filePath;
      document.getElementById('dbPreviewImg').style.display = '';
      document.getElementById('dbPreviewVid').style.display = 'none';
    } else {
      document.getElementById('dbPreviewVid').src = 'file://' + item.filePath;
      document.getElementById('dbPreviewVid').style.display = '';
      document.getElementById('dbPreviewImg').style.display = 'none';
    }
  }
}

async function dbSave() {
  var id = document.getElementById('dbEditId').value;
  var type = document.getElementById('dbType').value;
  var title = document.getElementById('dbTitle').value.trim();
  var tags = document.getElementById('dbTags').value.split(/[,，]/).map(function(s) { return s.trim(); }).filter(Boolean);
  var content = document.getElementById('dbContent').value.trim();
  var filePath = _dbFilePath || '';
  if (!title) return toast('请输入标题');
  if (type === 'text' && !content) return toast('请输入内容');
  if ((type === 'image' || type === 'video') && !filePath) return toast('请选择文件');
  var data = { type: type, title: title, tags: tags, content: content, filePath: filePath };
  try {
    if (id) { await window.electronAPI.dbUpdate({ id: id, updates: data }); }
    else { await window.electronAPI.dbAdd(data); }
    dbHideModal(); dbLoad(); toast(id ? '已更新' : '已保存');
  } catch(e) { toast('保存失败'); }
}

async function dbDelete(id) {
  var ok = await _showConfirm('确定删除此资源？');
  if (!ok) return;
  try { await window.electronAPI.dbDelete(id); dbLoad(); toast('已删除'); } catch(e) {}
}

async function dbPickStorageDir() {
  if (!window.electronAPI || !window.electronAPI.selectFolder) {
    toast('存储目录功能暂不可用');
    return;
  }
  var p = await window.electronAPI.selectFolder();
  if (!p) return;
  try { await window.electronAPI.dbSetPath(p); dbShowStoragePath(); toast('存储目录已设置'); } catch(e) { toast('设置失败'); }
}

// ════════════════════════════
//  资源选取弹窗
// ════════════════════════════

// ════════════════════════════
//  资源选取弹窗 (修复版)
// ════════════════════════════

async function dbShowPicker(target) {
  dbState.pickerTarget = target;
  dbState.pickerSelected = null;
  var ps = document.getElementById('dbPickerSearch'); if (ps) ps.value = '';
  var pt = document.getElementById('dbPickerType'); if (pt) pt.value = '';
  var fb = document.getElementById('dbPickerFillBtn'); if (fb) fb.disabled = true;
  var pm = document.getElementById('dbPickerModal'); if (pm) pm.classList.remove('hidden');
  var sm = document.getElementById('dbPickerSearchMode'); if (sm) sm.classList.remove('hidden');
  var am = document.getElementById('dbPickerAIMode'); if (am) am.classList.add('hidden');
  var ti = document.getElementById('dbPickerTitle'); if (ti) ti.textContent = '📦 资源库';
  var pr = document.getElementById('dbPickerResults'); if (pr) pr.innerHTML = '';
}

function dbHidePicker() {
  var pm = document.getElementById('dbPickerModal'); if (pm) pm.classList.add('hidden');
}

function dbPickerFilter() {
  var q = ((document.getElementById('dbPickerSearch') || {}).value || '').toLowerCase().trim();
  var tp = (document.getElementById('dbPickerType') || {}).value || '';
  var grid = document.getElementById('dbPickerResults'); if (!grid) return;
  if (!q) { grid.innerHTML = ''; return; }
  var items = dbState.items || [];
  if (tp) items = items.filter(function(x) { return x.type === tp; });
  if (q) items = items.filter(function(x) {
    return (x.title||'').toLowerCase().indexOf(q) >= 0 ||
           (x.content||'').toLowerCase().indexOf(q) >= 0 ||
           (x.tags||[]).some(function(t) { return t.toLowerCase().indexOf(q) >= 0; });
  });
  if (items.length === 0) { grid.innerHTML = '<div style="text-align:center;color:#888;padding:20px;font-size:13px">未找到匹配资源</div>'; return; }
  grid.innerHTML = items.map(function(x) {
    var sel = '';
    if (dbState.pickerTarget === 'moment' && window._dbMomentSelected && window._dbMomentSelected.indexOf(x.id) >= 0) sel = ' selected';
    else if (dbState.pickerSelected && dbState.pickerSelected.id === x.id) sel = ' selected';
    if (x.type === 'image') {
      return '<div class="db-picker-item' + sel + '" onclick="dbPickerSelect(\'' + x.id + '\')"><img src="file://' + x.filePath + '" onerror="this.src=\'\'" /><div class="db-picker-label">' + escapeHTML(x.title) + '</div></div>';
    } else if (x.type === 'video') {
      return '<div class="db-picker-item' + sel + '" onclick="dbPickerSelect(\'' + x.id + '\')"><div style="font-size:24px">🎬</div><div class="db-picker-label">' + escapeHTML(x.title) + '</div></div>';
    } else {
      return '<div class="db-picker-item text-item' + sel + '" onclick="dbPickerSelect(\'' + x.id + '\')">' + escapeHTML((x.content || x.title).slice(0, 80)) + '</div>';
    }
  }).join('');
}

function dbPickerSelect(id) {
  var item = dbState.items.find(function(x) { return x.id === id; });
  // 朋友圈支持多选 (toggle)
  if (dbState.pickerTarget === 'moment') {
    if (!window._dbMomentSelected) window._dbMomentSelected = [];
    var idx = window._dbMomentSelected.indexOf(id);
    if (idx >= 0) { window._dbMomentSelected.splice(idx, 1); }
    else { window._dbMomentSelected.push(id); }
    dbState.pickerSelected = window._dbMomentSelected.length > 0 ? { _multi: true } : null;
  } else {
    dbState.pickerSelected = (dbState.pickerSelected && dbState.pickerSelected.id === id) ? null : item;
  }
  var fb = document.getElementById('dbPickerFillBtn');
  if (fb) fb.disabled = (dbState.pickerTarget === 'moment') ? (window._dbMomentSelected.length === 0) : !dbState.pickerSelected;
  if (dbState.pickerTarget !== 'moment') dbPickerFilter();
  else dbPickerFilter();
}

function dbPickerFill() {
  // 朋友圈多选
  if (dbState.pickerTarget === 'moment' && window._dbMomentSelected && window._dbMomentSelected.length > 0) {
    if (typeof momentState === 'undefined') { toast('朋友圈模块未初始化'); return; }
    if (!momentState.mediaPaths) momentState.mediaPaths = [];
    window._dbMomentSelected.forEach(function(id) {
      var it = dbState.items.find(function(x) { return x.id === id; });
      if (!it) return;
      if (it.type === 'text') {
        var ta = document.getElementById('momentText'); if (ta) { ta.value = (ta.value||'') + (ta.value?'\n':'') + it.content; }
      } else {
        if (momentState.mediaPaths.length >= 9) return;
        momentState.mediaPaths.push(it.filePath);
      }
    });
    var ta = document.getElementById('momentText'); if (ta) { var cc = document.getElementById('momentCharCount'); if (cc) cc.textContent = (ta.value||'').length; }
    if (typeof renderMomentMediaGrid === 'function') renderMomentMediaGrid();
    _switchToTab(2); dbHidePicker(); toast('已填入朋友圈');
    return;
  }

  var item = dbState.pickerSelected;
  if (!item) { toast('请先选择一个资源'); return; }
  if (dbState.pickerTarget === 'broadcast') {
    if (item.type === 'text') {
      var ta = document.getElementById('copyText'); if (ta) ta.value = item.content;
      _switchToTab(1); toast('文案已填入群发中心');
    } else if (item.type === 'image') {
      state.imagePath = item.filePath;
      _switchToTab(1);
      setTimeout(function() {
        showImagePreview(item.filePath, 'imagePreview', 'uploadIcon', 'uploadText');
        updateSendInfo();
      }, 300);
      toast('图片已填入群发中心');
    } else if (item.type === 'video') {
      state.imagePath = item.filePath;
      updateSendInfo();
      _switchToTab(1); toast('视频已填入群发中心');
    }
  } else if (dbState.pickerTarget === 'moment') {
    if (item.type === 'text') {
      var ta2 = document.getElementById('momentText');
      if (ta2) { ta2.value = item.content; var cc = document.getElementById('momentCharCount'); if (cc) cc.textContent = item.content.length; }
      _switchToTab(2); toast('文案已填入朋友圈');
    } else {
      if (typeof momentState !== 'undefined' && momentState) {
        if (!momentState.mediaPaths) momentState.mediaPaths = [];
        if (momentState.mediaPaths.length >= 9) { toast('最多9张/段媒体'); return; }
        momentState.mediaPaths.push(item.filePath);
        if (typeof renderMomentMediaGrid === 'function') renderMomentMediaGrid();
        _switchToTab(2); toast('媒体已填入朋友圈');
      }
    }
  }
  dbHidePicker();
}

// ════════════════════════════
//  AI帮 (修复版)
// ════════════════════════════

var dbAIChat = [];
var dbAISelected = null;

function dbPickerAIStart() {
  var sm = document.getElementById('dbPickerSearchMode'); if (sm) sm.classList.add('hidden');
  var am = document.getElementById('dbPickerAIMode'); if (am) am.classList.remove('hidden');
  var ti = document.getElementById('dbPickerTitle'); if (ti) ti.textContent = '🤖 AI帮';
  dbAIChat = [];
  dbAISelected = null;
  dbAIRenderChat();
  dbAIResRender();
}

function dbPickerAIBack() {
  var sm = document.getElementById('dbPickerSearchMode'); if (sm) sm.classList.remove('hidden');
  var am = document.getElementById('dbPickerAIMode'); if (am) am.classList.add('hidden');
  var ti = document.getElementById('dbPickerTitle'); if (ti) ti.textContent = '📦 资源库';
}

// AI帮资源搜索 (不直接展示所有)
function dbAIResSearch() {
  dbAIResRender();
}

function dbAIResRender() {
  var el = document.getElementById('dbAIResourceSelect'); if (!el) return;
  var q = ((document.getElementById('dbAIResSearchInput')||{}).value||'').toLowerCase().trim();
  var items = dbState.items || [];
  if (q) items = items.filter(function(x) {
    return (x.title||'').toLowerCase().indexOf(q) >= 0 ||
           (x.tags||[]).some(function(t) { return t.toLowerCase().indexOf(q) >= 0; });
  });
  items = items.slice(0, 15);

  var h = '<div style="display:flex;gap:4px;margin-bottom:4px">';
  h += '<input class="input small" id="dbAIResSearchInput" placeholder="搜索资源..." oninput="dbAIResRender()" style="flex:1;font-size:11px;height:26px" />';
  h += '</div><div style="display:flex;gap:4px;flex-wrap:wrap;max-height:80px;overflow-y:auto;">';
  if (items.length === 0 && q) { h += '<span style="font-size:11px;color:#888">无匹配</span>'; }
  items.forEach(function(x) {
    var icon = x.type === 'image' ? '🖼' : x.type === 'video' ? '🎬' : '📝';
    var selStyle = (dbAISelected && dbAISelected.id === x.id) ? 'background:#7c6ff7;color:#fff;' : 'background:#fff;';
    h += '<button onclick="dbAISelectRes(\'' + x.id + '\')" style="' + selStyle + 'border:1px solid #ddd;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;white-space:nowrap;overflow:hidden;max-width:120px;text-overflow:ellipsis;">' + icon + ' ' + escapeHTML(x.title||'') + '</button>';
  });
  h += '</div>';
  el.innerHTML = h;
}

function dbAISelectRes(id) {
  dbAISelected = (dbAISelected && dbAISelected.id === id) ? null : dbState.items.find(function(x) { return x.id === id; });
  dbAIResRender();
  if (dbAISelected) {
    dbAIChat.push({ role: 'system', content: '✅ 已选择: [' + (dbAISelected.type==='text'?'文案':dbAISelected.type==='image'?'图片':'视频') + '] ' + dbAISelected.title });
    dbAIRenderChat();
  }
}

function dbAIRenderChat() {
  var el = document.getElementById('dbPickerAIChat'); if (!el) return;
  var h = '';
  dbAIChat.forEach(function(m) {
    if (m.role === 'system') {
      h += '<div style="text-align:center;color:#888;font-size:11px;margin:4px 0">' + escapeHTML(m.content) + '</div>';
    } else if (m._img) {
      var imgSrc = m._img.startsWith('data:') || m._img.startsWith('http') ? m._img : 'file://' + m._img;
      h += '<div style="display:flex;justify-content:flex-start;margin:4px 0"><div style="max-width:80%;background:#f0f0f0;color:#333;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.5">';
      h += '<img src="' + imgSrc + '" style="max-width:200px;max-height:200px;border-radius:8px;display:block;margin-bottom:4px" onerror="this.style.display=\'none\'" />';
      h += escapeHTML(m.content || '') + '</div></div>';
    } else {
      var side = m.role === 'user' ? 'flex-end' : 'flex-start';
      var bg = m.role === 'user' ? '#7c6ff7' : '#f0f0f0';
      var clr = m.role === 'user' ? '#fff' : '#333';
      h += '<div style="display:flex;justify-content:' + side + ';margin:4px 0"><div style="max-width:80%;background:' + bg + ';color:' + clr + ';padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.5;word-break:break-word">' + escapeHTML(m.content) + '</div></div>';
    }
  });
  el.innerHTML = h;
  el.scrollTop = 99999;
}

async function dbPickerAIChatSend() {
  var inp = document.getElementById('dbPickerAIChatInput'); if (!inp) return;
  var text = (inp.value || '').trim(); if (!text) return;
  inp.value = '';
  dbAIChat.push({ role: 'user', content: text });
  dbAIChat.push({ role: 'assistant', content: '思考中...' });
  dbAIRenderChat();
  
  var model = (document.getElementById('dbPickerAIModel') || {}).value || 'chat';
  try {
    var prompt = '';
    if (dbAISelected) {
      var r = dbAISelected;
      if (r.type === 'text') {
        prompt = '【资源库文案】标题: ' + r.title + '\n内容: ' + r.content + '\n标签: ' + (r.tags||[]).join(',') + '\n\n用户指令: ' + text + '\n\n请根据指令处理这个文案。直接输出优化后的结果。';
      } else {
        prompt = '【资源库文件】类型: ' + (r.type==='image'?'图片':'视频') + '\n标题: ' + r.title + '\n文件路径: ' + r.filePath + '\n标签: ' + (r.tags||[]).join(',') + '\n\n用户指令: ' + text + '\n\n请根据指令处理这个资源。';
      }
    } else {
      // 无选定资源 → 搜索所有资源
      var allInfo = dbState.items.map(function(x) {
        return '[' + x.type + '] ' + x.title + ' | 标签: ' + (x.tags||[]).join(',') + ' | ' + (x.type==='text' ? '内容:' + (x.content||'').slice(0,100) : '');
      }).join('\n');
      prompt = '【资源库全部内容】\n' + allInfo + '\n\n用户需求: ' + text + '\n\n请搜索资源库找到匹配内容，并根据用户需求优化后输出。';
    }
    
    if (model === 'chat') {
      var r = await window.electronAPI.aiChat({ sessionId: 'dbai-' + Date.now(), messages: [{ role: 'user', content: prompt }], searchEnabled: false });
      dbAIChat.pop();
      if (r.success) { dbAIChat.push({ role: 'assistant', content: r.content }); }
      else { dbAIChat.push({ role: 'assistant', content: '❌ ' + (r.error || '') }); }
    } else if (model === 'image') {
      var cfgRes = await window.electronAPI.aiGetConfig();
      var imgCfg = (cfgRes && cfgRes.config && cfgRes.config.ai_image) ? cfgRes.config.ai_image : {};
      if (!imgCfg.api_key) {
        dbAIChat.pop(); dbAIChat.push({ role: 'assistant', content: '❌ 请先在设置中配置生图模型 API Key' });
      } else {
        // 如果有参考图路径，传给生图
        var opts = {};
        if (dbAISelected && dbAISelected.filePath) opts.reference_image_path = dbAISelected.filePath;
        var genRes = await window.electronAPI.aiGenerateImage({ prompt: text, options: opts, config: imgCfg });
        dbAIChat.pop();
        if (genRes.success && genRes.images && genRes.images.length > 0) {
          var img = genRes.images[0];
          dbAIChat.push({ role: 'assistant', content: '🎨 已生成图片', _img: img.local_path || img.url });
        } else {
          dbAIChat.push({ role: 'assistant', content: '❌ ' + (genRes.error || '生成失败') });
        }
      }
    } else {
      dbAIChat.pop(); dbAIChat.push({ role: 'assistant', content: '🎬 视频生成功能暂未开放' });
    }
    document.getElementById('dbPickerFillBtn').disabled = false;
    dbAIRenderChat();
  } catch(e) {
    dbAIChat.pop();
    dbAIChat.push({ role: 'assistant', content: '❌ ' + (e.message || '') });
    dbAIRenderChat();
  }
}

function dbPickerAIModeFill() {
  var last = null;
  for (var i = dbAIChat.length - 1; i >= 0; i--) { if (dbAIChat[i].role === 'assistant') { last = dbAIChat[i]; break; } }
  if (!last) { toast('没有可填入的内容'); return; }
  
  if (last._img) {
    state.imagePath = last._img;
    if (dbState.pickerTarget === 'moment') {
      if (typeof momentState !== 'undefined') {
        if (!momentState.mediaPaths) momentState.mediaPaths = [];
        momentState.mediaPaths.push(last._img);
        if (typeof renderMomentMediaGrid === 'function') renderMomentMediaGrid();
        _switchToTab(2); toast('图片已填入朋友圈');
      }
    } else {
      _switchToTab(1);
      setTimeout(function() { showImagePreview('file://' + last._img, 'imagePreview', 'uploadIcon', 'uploadText'); }, 200);
      toast('图片已填入群发中心');
    }
    dbHidePicker();
    return;
  }
  
  var content = (last.content || '').replace(/^❌ /, '');
  if (!content) { toast('没有可用内容'); return; }
  
  if (dbState.pickerTarget === 'moment') {
    var ta = document.getElementById('momentText');
    if (ta) { ta.value = content; var cc = document.getElementById('momentCharCount'); if (cc) cc.textContent = content.length; }
    _switchToTab(2);
  } else {
    var ta2 = document.getElementById('copyText'); if (ta2) ta2.value = content;
    _switchToTab(1);
  }
  toast('内容已填入');
  dbHidePicker();
}

// 填入分发器：搜索模式走 dbPickerFill，AI模式走 dbPickerAIModeFill
function dbPickerMainFill() {
  var am = document.getElementById('dbPickerAIMode');
  if (am && !am.classList.contains('hidden')) { dbPickerAIModeFill(); }
  else { dbPickerFill(); }
}

// Init
(function() {
  
// Tab筛选器
(function(){
  var pills = document.getElementById('dbTypePills');
  if (pills) {
    pills.addEventListener('click', function(e) {
      if (e.target.classList.contains('pill')) {
        [].forEach.call(pills.querySelectorAll('.pill'), function(p) { p.classList.remove('active'); });
        e.target.classList.add('active');
        dbState.filterType = e.target.dataset.dbtype || '';
        dbRender();
      }
    });
  }
})();

var orig = window.openTab;
  window.openTab = function(idx) {
    if (orig) orig.call(window, idx);
    if (idx === 3) setTimeout(dbLoad, 200);
    if (idx === 4) setTimeout(function() { if (typeof loadAIConfigs === "function") loadAIConfigs(); }, 300);
  };
})();
setTimeout(dbLoad, 500);



//  AI 配置管理（独立于 backend，走 main.js IPC）
// ═══════════════════════════════════════════════════════════

// 加载所有 AI 配置（图片、视频），填入设置页表单
function loadAIConfigs() {
  var setVal = function(id, val) { var el = document.getElementById(id); if (el) el.value = val || ''; };

  // 主方案: preload 直接读 config.json（零 IPC，DOMContentLoaded 前已就绪）
  if (window.__aiImageConfig) {
    var img = window.__aiImageConfig.ai_image || {};
    var vid = window.__aiImageConfig.ai_video || {};
    if (img.api_key) { setVal('aiImageApiUrl', img.api_url); setVal('aiImageApiKey', img.api_key); setVal('aiImageModel', img.model); }
    if (vid.api_key) { setVal('aiVideoApiUrl', vid.api_url); setVal('aiVideoApiKey', vid.api_key); setVal('aiVideoModel', vid.model); }
  }

  // 补充: localStorage（保存后立即刷新）
  try {
    var lsImg = localStorage.getItem('yizhun_ai_image');
    var lsVid = localStorage.getItem('yizhun_ai_video');
    if (lsImg) { var d = JSON.parse(lsImg); setVal('aiImageApiUrl', d.api_url); setVal('aiImageApiKey', d.api_key); setVal('aiImageModel', d.model); }
    if (lsVid) { var d2 = JSON.parse(lsVid); setVal('aiVideoApiUrl', d2.api_url); setVal('aiVideoApiKey', d2.api_key); setVal('aiVideoModel', d2.model); }
  } catch (_) {}
}

// 保存单个 AI 模块配置（通过 saveAISettings 调用，或 saveAllSettings 联动）
async function saveAIConfigs() {
  var get = function(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
  var imgData = { api_url: get('aiImageApiUrl'), api_key: get('aiImageApiKey'), model: get('aiImageModel') };
  var vidData = { api_url: get('aiVideoApiUrl'), api_key: get('aiVideoApiKey'), model: get('aiVideoModel') };

  // ── 主方案: localStorage（100% 可靠，不受 IPC/文件/Flask 任何影响）──
  try {
    if (imgData.api_key) localStorage.setItem('yizhun_ai_image', JSON.stringify(imgData));
    if (vidData.api_key) localStorage.setItem('yizhun_ai_video', JSON.stringify(vidData));
    console.log('[saveAIConfigs] ✅ 已保存到 localStorage');
  } catch (e) { console.error('[saveAIConfigs] localStorage 保存失败:', e); }

  // ── 副方案: IPC 文件持久化 ──
  if (!window.electronAPI || !window.electronAPI.aiSaveConfig) return;
  try { await window.electronAPI.aiSaveConfig({ section: 'ai_image', data: imgData }); } catch (_) {}
  try { await window.electronAPI.aiSaveConfig({ section: 'ai_video', data: vidData }); } catch (_) {}
}

// ── 设置页 "保存设置" 按钮（每个模块独立保存 + 测试连接标记）──
async function saveAISettings(section) {
  const map = {
    ai:      { api_url: 'apiUrl',      api_key: 'apiKey',      model: 'aiModel',      badge: 'apiTestBadge' },
    ai_image:{ api_url: 'aiImageApiUrl',api_key: 'aiImageApiKey',model: 'aiImageModel', badge: 'aiImageTestBadge' },
    ai_video:{ api_url: 'aiVideoApiUrl',api_key: 'aiVideoApiKey',model: 'aiVideoModel',badge: 'aiVideoTestBadge' },
  };
  const m = map[section];
  if (!m) return;

  const get = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const data = { api_url: get(m.api_url), api_key: get(m.api_key), model: get(m.model) };

  if (!data.api_key) { toast('请填写 API Key'); return; }

  // 如果是语言大模型，走原 config 通道（backend 保存）
  if (section === 'ai') {
    // 直接用 saveAllSettings 已包含 ai 保存，这里不再重复
    // 但独立按钮触发时也走一遍原逻辑
    const config = {
      ai: { enabled: true, api_url: data.api_url, api_key: data.api_key, model: data.model },
      fallback: { use_scripts: document.getElementById('useScripts')?.checked ?? true, allow_manual: document.getElementById('allowManual')?.checked ?? true },
      broadcast: { interval: parseFloat(document.getElementById('sendInterval')?.value) || 0.8, exclude: (document.getElementById('excludeList')?.value || '').split(/[,，]/).map(s => s.trim()).filter(Boolean) },
    };
    Object.keys(config.ai).forEach(k => { if (config.ai[k] === undefined) delete config.ai[k]; });
    try {
      const res = await fetch(`${API}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
      const j = await res.json();
      if (j.success) { state.config = j.config; toast('语言大模型设置已保存'); }
      else toast('保存失败: ' + (j.error || ''));
    } catch (e) { toast('保存失败: ' + e.message); }
    return;
  }

  // 图片/视频配置：先写 localStorage（主存储，启动时同步读取），再走 IPC（备份）
  // ── localStorage（100% 可靠，不依赖 IPC 竞态）──
  try {
    if (data.api_key) {
      localStorage.setItem('yizhun_ai_' + (section === 'ai_image' ? 'image' : 'video'), JSON.stringify(data));
    }
  } catch (_) {}

  // ── IPC（文件备份）──
  if (!window.electronAPI || !window.electronAPI.aiSaveConfig) { toast('保存功能不可用'); return; }
  try {
    const sr = await window.electronAPI.aiSaveConfig({ section, data });
    if (!sr || !sr.success) { toast('保存失败: ' + (sr?.error || '未知错误')); return; }
    toast((section === 'ai_image' ? '生图' : '生视频') + '大模型设置已保存'); await loadAIConfigs();
  } catch (e) { toast('保存失败: ' + e.message); }
}

// ── 生图连接测试 ──
async function testAiImageConnection() {
  const badge = document.getElementById('aiImageTestBadge');
  if (!badge) return;
  const get = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const apiKey = get('aiImageApiKey');
  if (!apiKey) { badge.textContent = '缺少Key'; badge.className = 'api-badge'; return; }
  badge.textContent = '测试中…'; badge.className = 'api-badge';

  try {
    const result = await window.electronAPI.aiGenerateImage({
      prompt: 'test',
      options: { size: '256x256' },
      config: { api_url: get('aiImageApiUrl') || 'https://apihub.agnes-ai.com/v1', api_key: apiKey, model: get('aiImageModel') || 'agnes-image-2.1-flash' },
    });
    badge.textContent = result.success ? '连接正常' : '连接失败';
    badge.className = 'api-badge' + (result.success ? ' ok' : '');
  } catch (e) {
    badge.textContent = '连接失败'; badge.className = 'api-badge';
  }
}

// ── 生视频连接测试 ──
async function testAiVideoConnection() {
  const badge = document.getElementById('aiVideoTestBadge');
  if (!badge) return;
  const get = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const apiKey = get('aiVideoApiKey');
  if (!apiKey) { badge.textContent = '缺少Key'; badge.className = 'api-badge'; return; }
  badge.textContent = '测试中…'; badge.className = 'api-badge';

  try {
    const result = await window.electronAPI.aiCreateVideoTask({
      prompt: 'test',
      options: { duration: 2 },
      config: { api_url: get('aiVideoApiUrl') || 'https://apihub.agnes-ai.com/v1', api_key: apiKey, model: get('aiVideoModel') || 'agnes-video-v2.0' },
    });
    badge.textContent = (result.success && result.task_id) ? '连接正常' : '连接失败';
    badge.className = 'api-badge' + ((result.success && result.task_id) ? ' ok' : '');
  } catch (e) {
    badge.textContent = '连接失败'; badge.className = 'api-badge';
  }
}

// ═══════════════════════════════════════════════════════════
// 多平台分发（Tab 0）— 多账号管理 + 发布
// ═══════════════════════════════════════════════════════════

let platformState = {
  douyin: { accounts: [], },         // [{ name, valid }]
  shipinhao: { accounts: [], },      // [{ name, valid }]
  activePlatform: 'douyin',          // 'douyin' | 'shipinhao'
};

async function platformInit() {
  try {
    if (window.electronAPI && window.electronAPI.platformInit) {
      await window.electronAPI.platformInit();
    }
  } catch (e) {
    console.warn('[Platform] init error:', e.message);
  }
  // 监听日志（来自后端的发布进度等）
  if (window.electronAPI && window.electronAPI.onPlatformLog) {
    window.electronAPI.onPlatformLog((data) => {
      platformLog(data.message);
    });
  }
  try {
    if (window.electronAPI && window.electronAPI.platformGetBrowser) {
      const browserInfo = await window.electronAPI.platformGetBrowser();
      if (browserInfo) platformLog(`🌐 检测到浏览器: ${browserInfo.label}`);
    }
  } catch (e) {}
  // 定时器范围
  const scheduleInput = document.getElementById('platformScheduleTime');
  if (scheduleInput) _platformApplyScheduleRange(scheduleInput);
  // 启动时快速扫描 Cookie 文件（不开浏览器），瞬间出列表
  await platformQuickScanAccounts();
}

function platformLog(msg) {
  const el = document.getElementById('platformLogContent');
  if (!el) return;
  const time = new Date().toLocaleTimeString();
  el.innerHTML += `<div>[${time}] ${msg}</div>`;
  el.scrollTop = el.scrollHeight;
}

// ── 账号管理 ──────────────────────────────────────────

/** 启动时快速扫描两个平台：只读文件，不开浏览器 */
async function platformQuickScanAccounts() {
  await _scanPlatform('douyin', 'platformListAccounts', 'platformCheckDouyinQuick');
  await _scanPlatform('shipinhao', 'platformListShipinhaoAccounts', 'platformCheckShipinhaoQuick');
  platformRenderAccounts();
  platformRenderTargetAccounts();
  _updatePlatformStatus();
}

/** 扫描指定平台的账号 */
async function _scanPlatform(platform, listIpc, checkIpc) {
  const ipc = window.electronAPI;
  if (!ipc || !ipc[listIpc]) return;
  try {
    const result = await ipc[listIpc]();
    const names = result.accounts || [];
    const accounts = [];
    for (const name of names) {
      try {
        const check = await ipc[checkIpc]({ accountName: name });
        accounts.push({ name, valid: check.valid });
      } catch { accounts.push({ name, valid: false }); }
    }
    platformState[platform].accounts = accounts;
  } catch (e) {
    platformLog(`⚠️ 扫描${platform === 'douyin' ? '抖音' : '视频号'}账号失败: ${e.message}`);
  }
}

/** 全局刷新状态：快速扫描 Cookie 文件（不弹浏览器） */
async function platformRefreshStatus() {
  const plat = platformState.activePlatform;
  const label = plat === 'douyin' ? '抖音' : '视频号';
  platformLog(`🔄 开始刷新${label}账号登录状态...`);
  const listIpc = plat === 'douyin' ? 'platformListAccounts' : 'platformListShipinhaoAccounts';
  const checkIpc = plat === 'douyin' ? 'platformCheckDouyinQuick' : 'platformCheckShipinhaoQuick';
  const ipc = window.electronAPI;
  if (!ipc || !ipc[listIpc]) return;
  try {
    const result = await ipc[listIpc]();
    const names = result.accounts || [];
    const accounts = [];
    for (const name of names) {
      try {
        const check = await ipc[checkIpc]({ accountName: name });
        accounts.push({ name, valid: check.valid });
      } catch (e) {
        platformLog(`⚠️ 检查「${name}」登录状态失败: ${e.message}`);
        accounts.push({ name, valid: false });
      }
    }
    platformState[plat].accounts = accounts;
    platformRenderAccounts();
    platformRenderTargetAccounts();
    _updatePlatformStatus();
    platformLog(`✅ ${label}账号刷新完成`);
  } catch (e) {
    platformLog(`❌ 刷新${label}账号失败: ` + e.message);
  }
}

function platformRenderAccounts() {
  const list = document.getElementById('platformAccountList');
  if (!list) return;
  const plat = platformState.activePlatform;
  const accounts = platformState[plat].accounts;
  if (accounts.length === 0) {
    list.innerHTML = `<div style="font-size:13px;color:var(--text3);padding:8px 0">暂无${plat === 'douyin' ? '抖音' : '视频号'}账号</div>`;
    return;
  }
  list.innerHTML = accounts.map(a => {
    const sc = a.valid ? 'green' : 'gray';
    const st = a.valid ? '已登录' : '未登录';
    return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
      <span style="flex:1;font-size:13px;font-weight:500">${a.name}</span>
      <span class="status-dot ${sc}" style="width:8px;height:8px"></span>
      <span style="font-size:12px;color:var(--text2);min-width:48px">${st}</span>
      <button class="btn btn-ghost btn-xs" onclick="platformClearAccount('${a.name}')" style="font-size:11px;color:var(--danger)">删除</button>
    </div>`;
  }).join('');
}

function platformRenderTargetAccounts() {
  const container = document.getElementById('platformTargetAccounts');
  if (!container) return;

  const groups = [
    { key: 'douyin', label: '🎵 抖音', accounts: platformState.douyin.accounts.filter(a => a.valid) },
    { key: 'shipinhao', label: '📺 视频号', accounts: platformState.shipinhao.accounts.filter(a => a.valid) },
  ];

  let html = '';
  for (const g of groups) {
    if (g.accounts.length === 0) {
      html += `<div class="platform-target-group">
        <div class="platform-target-group-label">${g.label}</div>
        <div style="font-size:12px;color:var(--text3);margin-top:2px">暂无已登录账号</div>
      </div>`;
    } else {
      html += `<div class="platform-target-group">
        <div class="platform-target-group-label">${g.label}</div>
        <div class="platform-target-group-accounts">
          ${g.accounts.map(a =>
            `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:13px">
              <input type="checkbox" class="platform-target-account" data-platform="${g.key}" value="${a.name}" checked> ${a.name}
            </label>`
          ).join('')}
        </div>
      </div>`;
    }
  }
  container.innerHTML = html;
}

async function platformAddNewAccount() {
  const plat = platformState.activePlatform;
  const label = plat === 'douyin' ? '抖音' : '视频号';
  const name = await _showPrompt(`添加并登录${label}账号`, '输入别名，如: 主号、运营号1');
  if (!name || !name.trim()) return;
  const alias = name.trim();
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/.test(alias)) {
    platformLog('❌ 别名只能包含字母、数字、中文、下划线、横线');
    return;
  }
  // 统一走 platformLogin，douyin 和 shipinhao 都用真实的登录流程
  await platformLogin(alias, plat);
}

async function platformLogin(accountName, platform) {
  if (!accountName || !platform) return;
  const label = platform === 'douyin' ? '抖音' : '视频号';
  const ipcFunc = platform === 'douyin' ? 'platformLoginDouyin' : 'platformLoginShipinhao';
  platformLog(`🔑 正在唤起浏览器进行${label}「${accountName}」的扫码登录...`);
  try {
    const result = await window.electronAPI[ipcFunc]({ accountName });
    if (!result) {
      platformLog(`❌ 「${accountName}」登录无响应（IPC 返回空）`);
    } else if (result.success) {
      platformLog(`✅ 「${accountName}」${label}扫码登录成功`);
    } else {
      platformLog(`❌ 「${accountName}」登录失败: ${result.message || '未知错误（请检查浏览器是否正常弹出）'}`);
    }
    await platformQuickScanAccounts();
  } catch (e) {
    platformLog(`❌ 「${accountName}」登录异常: ${e.message}`);
  }
}

/** 删除当前平台的某个账号 */
async function platformClearAccount(accountName) {
  if (!accountName) return;
  const plat = platformState.activePlatform;
  const ok = await _showConfirm(`确定删除「${accountName}」？删除后需要重新登录才能使用。`);
  if (!ok) return;
  try {
    // 直接删 Cookie 文件，不触发浏览器校验
    if (window.electronAPI && window.electronAPI.platformLogout) {
      await window.electronAPI.platformLogout({ accountName });
    }
    // 直接从内存状态移除
    platformState[plat].accounts = platformState[plat].accounts.filter(a => a.name !== accountName);
    platformRenderAccounts();
    platformRenderTargetAccounts();
    _updatePlatformStatus();
    platformLog(`🗑️ 已删除「${accountName}」`);
  } catch (e) {
    platformLog('❌ 删除失败: ' + e.message);
  }
}

function _updatePlatformStatus() {
  const plat = platformState.activePlatform;
  const accounts = platformState[plat].accounts;
  const anyValid = accounts.some(a => a.valid);
  const dot = document.getElementById('platformStatusDot');
  const text = document.getElementById('platformStatusText');
  if (dot) dot.className = 'status-dot ' + (anyValid ? 'green' : 'gray');
  if (text) {
    if (accounts.length === 0) text.textContent = '暂无账号';
    else if (anyValid) text.textContent = accounts.filter(a => a.valid).length + '/' + accounts.length + ' 已登录';
    else text.textContent = accounts.length + ' 个账号未登录';
  }
}

/** 切换账号管理 Tab */
function platformSwitchTab(platform) {
  if (platform === platformState.activePlatform) return;
  platformState.activePlatform = platform;
  document.querySelectorAll('.platform-tab').forEach(el => {
    el.classList.toggle('platform-tab-active', el.dataset.platform === platform);
  });
  // 显示/隐藏平台限制提示
  const hints = document.getElementById('platformHints');
  if (hints) hints.style.display = (platform === 'shipinhao') ? 'block' : 'none';
  platformRenderAccounts();
  _updatePlatformStatus();
}

// ── 发布 ──────────────────────────────────────────────

function platformSelectVideo() {
  if (!window.electronAPI || !window.electronAPI.selectFile) return;
  window.electronAPI.selectFile('video').then(async (path) => {
    if (path) {
      document.getElementById('platformVideoText').textContent = '✅ 已选择视频文件';
      document.getElementById('platformVideoPath').textContent = path;
      document.getElementById('platformVideoPath').classList.remove('hidden');
      document.getElementById('platformVideoPath').dataset.path = path;
      if (window.electronAPI.platformCheckFile) {
        const info = await window.electronAPI.platformCheckFile({ filePath: path, type: 'video' });
        if (info && info.valid) {
          const sizeText = info.sizeMB > 1000 ? `${(info.sizeMB/1024).toFixed(1)}GB` : `${info.sizeMB}MB`;
          platformLog(`📁 视频: ${sizeText}${info.sizeMB > 4000 ? ' ❌ 超过4GB限制' : ' ✅'}`);
        }
      }
    }
  });
}

function platformSelectThumbnail() {
  if (!window.electronAPI || !window.electronAPI.selectFile) return;
  window.electronAPI.selectFile('image').then(async (path) => {
    if (path) {
      document.getElementById('platformThumbnail').value = path;
      if (window.electronAPI.platformCheckFile) {
        const info = await window.electronAPI.platformCheckFile({ filePath: path, type: 'image' });
        if (info && info.valid && info.dimensions && info.dimensions !== 'unknown') {
          const parts = info.dimensions.split('×');
          const w = parseInt(parts[0]), h = parseInt(parts[1]);
          if (w < 720 || h < 1280) {
            platformLog(`⚠️ 封面分辨率${info.dimensions}，抖音推荐≥720×1280，过低可能失败`);
          } else {
            platformLog(`✅ 封面分辨率: ${info.dimensions}`);
          }
        }
      }
    }
  });
}

async function platformPublish() {
  const publishBtn = document.getElementById('platformPublishBtn');
  const cancelBtn = document.getElementById('platformCancelBtn');
  if (!publishBtn) return;

  // 收集目标账号（按平台分组）
  const checked = document.querySelectorAll('.platform-target-account:checked');
  if (checked.length === 0) { platformLog('❌ 请选择至少一个发布目标账号'); return; }

  const targets = { douyin: [], shipinhao: [] };
  checked.forEach(cb => {
    const plat = cb.dataset.platform || 'douyin';
    targets[plat].push(cb.value);
  });

  // 收集参数
  const title = document.getElementById('platformTitle')?.value?.trim();
  if (!title) { platformLog('❌ 请填写视频标题'); return; }

  const videoPathEl = document.getElementById('platformVideoPath');
  const filePath = videoPathEl?.dataset?.path;
  if (!filePath) { platformLog('❌ 请选择视频文件'); return; }

  const desc = document.getElementById('platformDesc')?.value?.trim() || '';
  const tagsStr = document.getElementById('platformTags')?.value?.trim() || '';
  const tags = tagsStr ? tagsStr.split(/[,，]/).map(t => t.trim()).filter(Boolean) : [];
  const thumbnailPath = document.getElementById('platformThumbnail')?.value?.trim() || '';
  const publishMode = document.querySelector('input[name="publishMode"]:checked')?.value || 'immediate';
  const scheduleInput = document.getElementById('platformScheduleTime')?.value;
  const publishDate = (publishMode === 'scheduled' && scheduleInput) ? new Date(scheduleInput).getTime() : 0;

  if (publishMode === 'scheduled' && !scheduleInput) { platformLog('❌ 请选择定时发布时间'); return; }
  if (publishMode === 'scheduled' && publishDate <= Date.now()) { platformLog('❌ 定时发布时间必须晚于当前时间'); return; }

  // 前端预校验
  const errors = [];
  if (!title) errors.push('标题不能为空');
  if (title.length > 30) errors.push(`标题最多30字（当前${title.length}字）`);
  if (desc.length > 1000) errors.push(`描述最多1000字（当前${desc.length}字）`);
  if (tags.length > 10) errors.push(`话题标签最多10个（当前${tags.length}个）`);
  for (const t of tags) { if (t.length > 20) { errors.push(`话题"${t}"超过20字`); break; } }
  if (errors.length > 0) { platformLog('❌ ' + errors.join('；')); return; }

  // 发布中
  publishBtn.disabled = true;
  publishBtn.textContent = '发布中...';
  if (cancelBtn) cancelBtn.classList.remove('hidden');
  document.getElementById('platformLogContent').innerHTML = '';
  const totalTargets = targets.douyin.length + targets.shipinhao.length;
  platformLog(`🚀 开始发布到 ${totalTargets} 个账号（抖音 ${targets.douyin.length}、视频号 ${targets.shipinhao.length}）`);

  let successCount = 0, failCount = 0;

  // 先发抖音
  for (const acct of targets.douyin) {
    platformLog(`📤 正在发布到抖音「${acct}」...`);
    try {
      const result = await window.electronAPI.platformPublishDouyin({
        accountName: acct, title, filePath, desc, tags, thumbnailPath, publishDate,
      });
      if (result.success) {
        platformLog(`✅ 抖音「${acct}」发布成功`);
        successCount++;
      } else {
        platformLog(`❌ 抖音「${acct}」发布失败: ${result.error || '未知错误'}`);
        failCount++;
      }
    } catch (e) {
      platformLog(`❌ 抖音「${acct}」发布异常: ${e.message}`);
      failCount++;
    }
  }

  // 再发视频号
  for (const acct of targets.shipinhao) {
    platformLog(`📤 正在发布到视频号「${acct}」...`);
    try {
      const result = await window.electronAPI.platformPublishShipinhao({
        accountName: acct, title, filePath, desc, tags, thumbnailPath, publishDate,
      });
      if (result.success) {
        platformLog(`✅ 视频号「${acct}」发布成功`);
        successCount++;
      } else {
        platformLog(`❌ 视频号「${acct}」发布失败: ${result.error || '即将上线'}`);
        failCount++;
      }
    } catch (e) {
      platformLog(`❌ 视频号「${acct}」发布异常: ${e.message}`);
      failCount++;
    }
  }

  platformLog(`📊 完成: ${successCount} 成功, ${failCount} 失败`);
  publishBtn.disabled = false;
  publishBtn.textContent = '🚀 多平台发布';
  if (cancelBtn) cancelBtn.classList.add('hidden');
}

async function platformCancelPublish() {
  try {
    await window.electronAPI.platformCancelPublish();
    platformLog('⏹️ 已取消当前发布');
  } catch (e) {
    platformLog('⚠️ 取消失败: ' + e.message);
  }
}

// ── 定时 ──

function platformToggleSchedule() {
  const mode = document.querySelector('input[name="publishMode"]:checked')?.value;
  const wrap = document.getElementById('platformScheduleWrap');
  const input = document.getElementById('platformScheduleTime');
  if (!wrap || !input) return;
  if (mode === 'scheduled') {
    wrap.classList.remove('hidden');
    _platformApplyScheduleRange(input);
  } else {
    wrap.classList.add('hidden');
    input.value = '';
  }
}

function _platformApplyScheduleRange(input) {
  const now = new Date();
  const min = new Date(now.getTime() + 2 * 60 * 60 * 1000 + 60000);
  const max = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  input.min = _formatLocalDatetime(min);
  input.max = _formatLocalDatetime(max);
  if (!input.value || new Date(input.value).getTime() < min.getTime()) {
    input.value = _formatLocalDatetime(min);
  }
}

function _formatLocalDatetime(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day}T${h}:${min}`;
}

// ── 简易输入弹窗（替代 Electron 禁用的 prompt()）─
function _showPrompt(title, placeholder) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);backdrop-filter:blur(8px)';
    overlay.innerHTML = `<div style="background:var(--surface);border-radius:16px;padding:24px;width:360px;box-shadow:0 8px 40px rgba(0,0,0,0.2)">
      <div style="font-size:15px;font-weight:600;margin-bottom:12px;color:var(--text1)">${title}</div>
      <input id="_promptInput" class="input" placeholder="${placeholder}" style="width:100%;box-sizing:border-box;font-size:14px" autofocus>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button class="btn btn-ghost" id="_promptCancel">取消</button>
        <button class="btn btn-primary" id="_promptConfirm">确定</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#_promptInput');
    input.focus();
    const cleanup = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
    overlay.querySelector('#_promptCancel').onclick = () => { cleanup(); resolve(null); };
    overlay.querySelector('#_promptConfirm').onclick = () => { cleanup(); resolve(input.value); };
    input.onkeydown = (e) => { if (e.key === 'Enter') { cleanup(); resolve(input.value); } };
    overlay.onclick = (e) => { if (e.target === overlay) { cleanup(); resolve(null); } };
  });
}

function platformUpdateTitleCount() {
  const el = document.getElementById('platformTitle');
  const count = document.getElementById('platformTitleCount');
  if (el && count) {
    const len = el.value.length;
    count.textContent = len + '/30';
    count.style.color = len >= 25 ? 'var(--danger)' : 'var(--text3)';
  }
}

function platformUpdateDescCount() {
  const el = document.getElementById('platformDesc');
  const count = document.getElementById('platformDescCount');
  if (!el || !count) return;
  let text = el.value;
  if (text.length > 1000) { el.value = text.slice(0, 1000); text = el.value; }
  count.textContent = text.length + '字';
  count.style.color = text.length >= 950 ? 'var(--danger)' : 'var(--text3)';
}
