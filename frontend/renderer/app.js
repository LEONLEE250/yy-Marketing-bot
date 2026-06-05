/* ============================================================
   壹准 AI 营销助手 v1.1.3 - 前端逻辑
   wxauto4 引擎 + 图片上传 + 会话列表 + 定时发送 + 朋友圈
   ============================================================ */

const API = 'http://127.0.0.1:5679';

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
  await loadConfig();
  await loadScripts();
  checkWxStatus();
  loadScheduledTasks();
  setInterval(loadScheduledTasks, 30000);
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
  img.src = src;
  img.classList.remove('hidden');
  if (icon) icon.classList.add('hidden');
  if (text) text.classList.add('hidden');
}

// ============================================================
// 会话管理
// ============================================================

async function loadSessions() {
  const list = document.getElementById('recipientList');
  list.classList.remove('hidden');
  list.innerHTML = '<div class="empty-state">正在读取微信会话列表...</div>';
  try {
    const res = await fetch(`${API}/api/sessions`);
    const data = await res.json();
    if (data.success) {
      state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
      renderRecipients();
      if (!state.sessions.length) {
        toast('未读取到真实会话昵称，请先把微信停在聊天首页并保持窗口可见');
      }
    } else {
      state.sessions = [];
      renderRecipients();
      const errorText = String(data.error || '获取会话失败，请手动输入联系人发送');
      const weakHint = data.can_manual_send ? '<div class="empty-state">会话列表暂不可用，但你仍可在上方手动输入联系人后直接发送</div>' : '';
      list.innerHTML = `${weakHint}<div class="empty-state">${escapeHtml(errorText)}</div>`;
      toast(errorText);
      console.error('[loadSessions] failed:', errorText, data);
    }
    checkWxStatus();
  } catch (err) {
    state.sessions = [];
    renderRecipients();
    list.innerHTML = `<div class="empty-state">连接后端失败：${escapeHtml(err.message)}</div>`;
    toast('连接后端失败: ' + err.message);
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

document.getElementById('manualField')?.addEventListener('input', updateSendInfo);
document.getElementById('copyText')?.addEventListener('input', updateSendInfo);

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
  if (manualTargets.length > 0 && selectedTargets.length === 0) sendMode = 'manual_only';
  else if (manualTargets.length > 0 && selectedTargets.length > 0) sendMode = 'mixed';
  else if (selectedTargets.length > 0) sendMode = 'session_selected';
  return { targets, sendMode, manualTargets, selectedTargets };
}

async function doBroadcast() {
  const { targets, sendMode } = _getTargets();
  const message = document.getElementById('copyText').value.trim();

  if (targets.length === 0) return toast('请输入收件人（逗号分隔）');
  if (!message && !state.imagePath) return toast('请至少输入发送内容或上传图片');

  const sendBtn = document.getElementById('sendBtn');
  sendBtn.textContent = '处理中...';
  sendBtn.classList.add('sending');
  sendBtn.disabled = true;

  try {
    if (state.sendMode === 'scheduled') {
      await doScheduledSend(targets, message);
    } else {
      await doImmediateSend(targets, message, sendMode);
    }
  } finally {
    updateSendUI();
    sendBtn.classList.remove('sending');
    sendBtn.disabled = false;
  }
}

async function doImmediateSend(targets, message, sendMode = 'default') {
  const interval = parseFloat(document.getElementById('sendInterval').value) || 0.8;

  try {
    const res = await fetch(`${API}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targets,
        message,
        image_path: state.imagePath || null,
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

async function doScheduledSend(targets, message) {
  const scheduledAt = document.getElementById('scheduledTime').value;
  if (!scheduledAt) return toast('请选择定时发送时间');

  try {
    const res = await fetch(`${API}/api/broadcast/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targets,
        message,
        image_path: state.imagePath || null,
        scheduled_at: scheduledAt
      })
    });
    const data = await res.json();
    if (data.success) {
      toast(`定时任务已创建 · ${data.targets_count}人 · ${data.delay_seconds}秒后执行`);
      loadScheduledTasks();
    } else {
      toast('创建失败: ' + (data.error || '未知错误'));
    }
  } catch (err) {
    toast('创建失败: ' + err.message);
  }
}

// ============================================================
// 定时任务管理
// ============================================================

async function loadScheduledTasks() {
  try {
    const res = await fetch(`${API}/api/broadcast/schedule`);
    const data = await res.json();
    if (data.success && data.tasks && data.tasks.length > 0) {
      renderScheduledTasks(data.tasks);
      document.getElementById('scheduledTasksCard').style.display = '';
    }
  } catch (err) {}
}

function renderScheduledTasks(tasks) {
  const list = document.getElementById('scheduledTasksList');
  list.innerHTML = tasks.map(t => {
    const statusMap = {
      'pending': { text: '等待中', cls: 'tag-new' },
      'running': { text: '发送中', cls: 'tag-promo' },
      'completed': { text: '已完成', cls: '' },
      'failed': { text: '失败', cls: 'tag-brand' },
      'cancelled': { text: '已取消', cls: '' },
    };
    const s = statusMap[t.status] || { text: t.status, cls: '' };
    return `<div class="script-item">
      <span class="script-tag ${s.cls}">${s.text}</span>
      <div class="script-text">
        ${t.message_preview} · ${t.targets_count}人 · ${t.scheduled_at.replace('T', ' ')}
      </div>
      <div class="script-actions">
        ${t.status === 'pending' ? `<div class="icon-btn danger" onclick="cancelTask('${t.id}')" title="取消">&#x2715;</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function cancelTask(taskId) {
  try {
    const res = await fetch(`${API}/api/broadcast/schedule/${taskId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      toast('任务已取消');
      loadScheduledTasks();
    } else {
      toast('取消失败: ' + data.error);
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
    const res = await fetch(`${API}/api/scripts`);
    const data = await res.json();
    if (data.success) {
      state.scripts = data.scripts;
      renderScripts();
    }
  } catch (err) {}
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
    const res = await fetch(`${API}/api/scripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, text })
    });
    const data = await res.json();
    if (data.success) {
      toast('话术已添加');
      hideAddScript();
      await loadScripts();
    } else {
      toast('添加失败: ' + data.error);
    }
  } catch (err) {
    toast('添加失败: ' + err.message);
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
    const res = await fetch(`${API}/api/scripts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, text })
    });
    const data = await res.json();
    if (data.success) {
      toast('话术已更新');
      hideEditScript();
      await loadScripts();
    } else {
      toast('更新失败: ' + data.error);
    }
  } catch (err) {
    toast('更新失败: ' + err.message);
  }
}

async function deleteScript(id) {
  if (!confirm('确定删除这条话术？')) return;
  try {
    const res = await fetch(`${API}/api/scripts/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      toast('已删除');
      await loadScripts();
    }
  } catch (err) {
    toast('删除失败: ' + err.message);
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
    if (data.wx_online) {
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
    if (data.has_update) {
      showUpdateDialog(data);
    } else {
      toast('已是最新版本 v' + data.current);
    }
  } catch (err) {
    toast('检查更新失败: ' + err.message);
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
      fill.style.width = data.progress + '%';
      text.textContent = data.progress + '%';
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
  imagePath: null,
  selectedStyle: '朋友圈',
};

// 文案风格选择
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

// 字数统计
(() => {
  const ta = document.getElementById('momentText');
  if (ta) {
    ta.addEventListener('input', () => {
      const count = document.getElementById('momentCharCount');
      if (count) count.textContent = ta.value.length;
    });
  }
})();

async function selectMomentImage() {
  if (window.electronAPI) {
    const path = await window.electronAPI.selectImage();
    if (path) {
      momentState.imagePath = path;
      showImagePreview(path, 'momentImagePreview', 'momentUploadIcon', 'momentUploadText');
    }
  } else {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch(`${API}/api/image/upload`, { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success) {
          momentState.imagePath = data.path;
          const reader = new FileReader();
          reader.onload = (ev) => showImagePreview(ev.target.result, 'momentImagePreview', 'momentUploadIcon', 'momentUploadText');
          reader.readAsDataURL(file);
        } else {
          toast('上传失败: ' + data.error);
        }
      } catch (err) {
        toast('上传失败: ' + err.message);
      }
    };
    input.click();
  }
}

async function generateMomentCopy() {
  const context = document.getElementById('momentText').value.trim();
  if (!context) return toast('请先输入一些场景描述');

  try {
    const res = await fetch(`${API}/api/copy/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, style: momentState.selectedStyle })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('momentText').value = data.copy;
      const count = document.getElementById('momentCharCount');
      if (count) count.textContent = data.copy.length;
      toast(data.source === 'ai' ? 'AI 已生成文案' : '话术库已匹配');
    } else {
      toast('生成失败: ' + data.error);
    }
  } catch (err) {
    toast('生成失败: ' + err.message);
  }
}

async function publishMoment() {
  const text = document.getElementById('momentText').value.trim();
  if (!text && !momentState.imagePath) return toast('请至少输入文字或上传图片');
  if (text.length > 2000) return toast('文字不能超过2000字');

  const btn = document.getElementById('momentPublishBtn');
  btn.textContent = '发布中...';
  btn.disabled = true;

  try {
    const res = await fetch(`${API}/api/moment/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        image_path: momentState.imagePath || null
      })
    });
    const data = await res.json();

    const card = document.getElementById('momentResultCard');
    const result = document.getElementById('momentResult');
    card.classList.remove('hidden');

    if (data.success) {
      result.innerHTML = '<span style="color:#34c759">发布成功</span>';
      toast('朋友圈发布成功');
      document.getElementById('momentText').value = '';
      momentState.imagePath = null;
      document.getElementById('momentImagePreview').classList.add('hidden');
      const icon = document.getElementById('momentUploadIcon');
      const txt = document.getElementById('momentUploadText');
      if (icon) icon.classList.remove('hidden');
      if (txt) txt.classList.remove('hidden');
      const count = document.getElementById('momentCharCount');
      if (count) count.textContent = '0';
    } else {
      result.innerHTML = '<span style="color:#ff3b30">发布失败</span><br>' + (data.error || '未知错误');
      toast('发布失败: ' + (data.error || '未知错误'));
    }
  } catch (err) {
    const card = document.getElementById('momentResultCard');
    const result = document.getElementById('momentResult');
    card.classList.remove('hidden');
    result.innerHTML = '<span style="color:#ff3b30">发布失败</span><br>' + err.message;
    toast('发布失败: ' + err.message);
  } finally {
    btn.textContent = '发布朋友圈';
    btn.disabled = false;
  }
}
