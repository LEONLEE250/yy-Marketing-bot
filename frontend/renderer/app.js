/* ============================================================
   壹准 AI 营销助手 - 前端逻辑
   ============================================================ */

const API = 'http://127.0.0.1:5679';

let state = {
  currentTab: 0,
  imagePath: null,
  processedImagePath: null,
  sessions: [],
  selectedRecipients: new Set(),
  selectedMode: 'manual',
  selectedScene: '以旧换新',
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
  setupRecipientMode();
  setupStylePills();
  setupScenePills();
  setupDragDrop();
  await loadConfig();
  await loadScripts();
  checkWxStatus();
  setInterval(checkWxStatus, 10000);
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

function setupScenePills() {
  document.getElementById('copyPills').addEventListener('click', (e) => {
    if (e.target.classList.contains('pill')) {
      state.selectedScene = e.target.dataset.scene;
      if (state.selectedScene === '手动输入') {
        document.getElementById('copyText').focus();
      }
    }
  });
}

function setupStylePills() {
  document.getElementById('stylePills').addEventListener('click', (e) => {
    if (e.target.classList.contains('pill')) {
      state.selectedStyle = e.target.dataset.style;
    }
  });
}

function setupRecipientMode() {
  document.getElementById('recipientMode').addEventListener('click', (e) => {
    if (!e.target.classList.contains('pill')) return;
    document.querySelectorAll('#recipientMode .pill').forEach(p => p.classList.remove('active'));
    e.target.classList.add('active');
    state.selectedMode = e.target.dataset.mode;
    const kwInput = document.getElementById('keywordInput');
    kwInput.classList.toggle('hidden', state.selectedMode !== 'keyword');
    loadSessions();
  });
}

// ============================================================
// 拖拽上传
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
    }
  } else {
    // fallback: 浏览器环境
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
// 图片工具
// ============================================================

async function selectImageForTool() {
  if (window.electronAPI) {
    const path = await window.electronAPI.selectImage();
    if (path) {
      state.imagePath = path;
      showImagePreview(path, 'imgToolPreview');
    }
  }
}

['brightness', 'contrast', 'saturation'].forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('input', () => {
      document.getElementById(id + 'Val').textContent = el.value + '%';
    });
  }
});

async function processImage() {
  if (!state.imagePath) return toast('请先上传图片');
  const textLines = document.getElementById('cardTextLines').value.trim().split('\n').filter(Boolean);
  const watermark = document.getElementById('wmText').value.trim();
  const position = document.getElementById('wmPosition').value;

  try {
    const res = await fetch(`${API}/api/image/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_path: state.imagePath,
        text_lines: textLines.length ? textLines : null,
        watermark: watermark || null,
        position,
        enhance: true,
        brightness: parseInt(document.getElementById('brightness').value) / 100,
        contrast: parseInt(document.getElementById('contrast').value) / 100,
        saturation: parseInt(document.getElementById('saturation').value) / 100,
      })
    });
    const data = await res.json();
    if (data.success) {
      state.processedImagePath = data.output;
      toast('图片处理完成');
    } else {
      toast('处理失败: ' + data.error);
    }
  } catch (err) {
    toast('处理失败: ' + err.message);
  }
}

async function exportImage() {
  if (!state.processedImagePath) return toast('请先处理图片');
  if (window.electronAPI) {
    const dest = await window.electronAPI.saveFile(state.processedImagePath);
    if (dest) toast('已导出');
  } else {
    toast('导出功能需 Electron 环境');
  }
}

// ============================================================
// 会话管理
// ============================================================

async function loadSessions() {
  try {
    const res = await fetch(`${API}/api/sessions`);
    const data = await res.json();
    if (data.success) {
      state.sessions = data.sessions || [];
      renderRecipients();
    } else {
      toast('无法获取会话列表');
    }
  } catch (err) {
    toast('连接后端失败: ' + err.message);
  }
}

function renderRecipients() {
  const list = document.getElementById('recipientList');
  let sessions = state.sessions;

  if (state.selectedMode === 'keyword') {
    const kw = document.getElementById('keywordField').value.trim();
    if (kw) {
      const keywords = kw.split(/[,，]/).map(k => k.trim()).filter(Boolean);
      sessions = sessions.filter(s => keywords.some(k => s.includes(k)));
    }
  }

  if (sessions.length === 0) {
    list.innerHTML = '<div class="empty-state">没有匹配的会话</div>';
  } else {
    list.innerHTML = sessions.map(s => {
      const initial = s.charAt(0);
      const selected = state.selectedRecipients.has(s);
      return `<div class="recipient-item${selected ? ' selected' : ''}" data-session="${s}" onclick="toggleRecipient('${s.replace(/'/g, "\\'")}', this)">
        <div class="avatar">${initial}</div>
        <div class="rec-name">${s}</div>
        <div class="check-circle"></div>
      </div>`;
    }).join('');
  }

  updateSendInfo();
}

function toggleRecipient(name, el) {
  if (state.selectedRecipients.has(name)) {
    state.selectedRecipients.delete(name);
    el.classList.remove('selected');
  } else {
    state.selectedRecipients.add(name);
    el.classList.add('selected');
  }
  updateSendInfo();
}

function updateSendInfo() {
  const info = document.getElementById('sendInfo');
  const count = state.selectedRecipients.size;
  if (state.selectedMode === 'all') {
    info.textContent = `全部 ${state.sessions.length} 个会话`;
  } else if (count > 0) {
    const hasImage = state.imagePath ? '含图片 + 文案' : '纯文案';
    info.innerHTML = `已选 <strong>${count}</strong> 人 · ${hasImage}`;
  } else {
    info.textContent = '尚未选择收件人';
  }
}

// ============================================================
// 群发
// ============================================================

async function doBroadcast() {
  const message = document.getElementById('copyText').value.trim();
  if (!message) return toast('请输入发送文案');

  let targets = [];
  let mode = state.selectedMode;

  if (mode === 'all') {
    targets = state.sessions;
  } else if (state.selectedRecipients.size === 0) {
    return toast('请选择收件人');
  } else {
    targets = Array.from(state.selectedRecipients);
    mode = 'manual';
  }

  const sendBtn = document.getElementById('sendBtn');
  sendBtn.textContent = '发送中...';
  sendBtn.classList.add('sending');
  sendBtn.disabled = true;

  try {
    const res = await fetch(`${API}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targets,
        message,
        image_path: state.imagePath,
        mode,
        exclude: (document.getElementById('excludeList')?.value || '').split(/[,，]/).map(s => s.trim()).filter(Boolean),
      })
    });
    const data = await res.json();
    if (data.success) {
      const sent = data.sent || data.results?.filter(r => r.success).length || targets.length;
      toast(`发送完成：${sent}/${targets.length}`);
    } else {
      toast('发送失败: ' + (data.error || '未知错误'));
    }
  } catch (err) {
    toast('发送失败: ' + err.message);
  } finally {
    sendBtn.textContent = '立即发送';
    sendBtn.classList.remove('sending');
    sendBtn.disabled = false;
  }
}

// ============================================================
// AI 文案
// ============================================================

async function generateCopy() {
  const context = document.getElementById('copyText').value.trim() || state.selectedScene;
  if (!context) return toast('请输入场景描述');
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
  // 切换到群发中心
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.tab[data-tab="0"]').classList.add('active');
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-panel="0"]').classList.add('active');
  state.currentTab = 0;
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
        <div class="icon-btn" onclick="startEditScript('${s.id}')" title="编辑">\u270E</div>
        <div class="icon-btn danger" onclick="deleteScript('${s.id}')" title="删除">\u2715</div>
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
  document.getElementById('defaultWM').value = c.watermark?.text || '';
  document.getElementById('defaultWMPos').value = c.watermark?.position || 'bottom-right';
  document.getElementById('adaptiveColor').checked = c.watermark?.adaptive_color !== false;
  document.getElementById('sendInterval').value = c.broadcast?.interval || 0.8;
  document.getElementById('excludeList').value = (c.broadcast?.exclude || []).join(', ');
  document.getElementById('wmText').value = c.watermark?.text || '';
  document.getElementById('wmPosition').value = c.watermark?.position || 'bottom-right';
}

async function saveAllSettings() {
  const config = {
    ai: {
      enabled: document.getElementById('aiEnabled').checked,
      api_url: document.getElementById('apiUrl').value.trim(),
      api_key: document.getElementById('apiKey').value.trim(),
      model: document.getElementById('aiModel').value,
    },
    fallback: {
      use_scripts: document.getElementById('useScripts').checked,
      allow_manual: document.getElementById('allowManual').checked,
    },
    watermark: {
      text: document.getElementById('defaultWM').value.trim(),
      position: document.getElementById('defaultWMPos').value,
      adaptive_color: document.getElementById('adaptiveColor').checked,
    },
    broadcast: {
      interval: parseFloat(document.getElementById('sendInterval').value) || 0.8,
      exclude: document.getElementById('excludeList').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
    }
  };

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
  try {
    const res = await fetch(`${API}/api/status`);
    const data = await res.json();
    const dot = document.querySelector('.status-dot');
    const text = document.getElementById('statusText');
    if (data.wx_online) {
      dot.classList.remove('off');
      text.textContent = '微信已连接 · 准备就绪';
    } else {
      dot.classList.add('off');
      text.textContent = '微信未连接 · 请打开微信';
    }
  } catch (err) {
    document.querySelector('.status-dot').classList.add('off');
    document.getElementById('statusText').textContent = '后端未启动';
  }
}

// ============================================================
// 更新检查
// ============================================================

async function checkUpdate() {
  try {
    const res = await fetch(`${API}/api/update/check`);
    const data = await res.json();
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
      <button class="btn btn-primary" onclick="downloadUpdate('${updateInfo.download_url || ''}')">下载更新</button>
    </div>
  </div>`;
  document.body.appendChild(dialog);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.remove(); });
}

function downloadUpdate(url) {
  if (url && window.electronAPI) {
    window.electronAPI.openURL(url);
  }
  toast('请在浏览器中下载更新包');
  document.querySelector('.update-dialog')?.remove();
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
// 关键词输入实时筛选
// ============================================================

document.getElementById('keywordField')?.addEventListener('input', () => {
  if (state.selectedMode === 'keyword') renderRecipients();
});
