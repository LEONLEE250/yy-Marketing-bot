# -*- coding: utf-8 -*-
"""
微信可视化群发工具 - Web 服务端
打开浏览器 http://localhost:5678 即可操作
"""
import os
import sys
import time
import json
import threading
from flask import Flask, request, jsonify, send_from_directory

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

app = Flask(__name__)

# ── 全局状态 ──────────────────────────────────────────
_wx = None
_wx_lock = threading.Lock()

def get_wx():
    global _wx
    if _wx is None:
        from wxauto4 import WeChat
        _wx = WeChat(ads=False)
    return _wx


# ── API: 获取会话列表 ────────────────────────────────
@app.route('/api/sessions')
def api_sessions():
    try:
        wx = get_wx()
        sessions = wx.GetSession()
        names = []
        for s in sessions:
            name = None
            # 尝试各种属性取名
            for attr in ('name', 'who', 'nickname', 'title'):
                val = getattr(s, attr, None)
                if val and isinstance(val, str) and val.strip():
                    name = val.strip()
                    break
            if not name:
                name = str(s).strip()
            if name:
                names.append(name)
        return jsonify({'success': True, 'sessions': names})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


# ── API: 群发 ────────────────────────────────────────
@app.route('/api/broadcast', methods=['POST'])
def api_broadcast():
    data = request.json or {}
    targets   = data.get('targets', [])
    message   = data.get('message', '')
    image_path = data.get('image_path', '').strip()

    if not targets:
        return jsonify({'success': False, 'error': '请选择发送目标'})

    try:
        wx = get_wx()
        results = []
        for target in targets:
            try:
                wx.ChatWith(target)
                time.sleep(0.5)
                if image_path and os.path.exists(image_path):
                    wx.SendFiles(image_path)
                    time.sleep(1)
                if message.strip():
                    wx.SendMsg(message)
                    time.sleep(0.3)
                results.append({'to': target, 'success': True})
            except Exception as e:
                results.append({'to': target, 'success': False, 'error': str(e)})
        
        ok  = [r['to'] for r in results if r['success']]
        err = [r for r in results if not r['success']]
        return jsonify({'success': True, 'ok': ok, 'errors': err})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


# ── 前端页面（内嵌 HTML）─────────────────────────────
HTML = r"""<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>壹准 · 微信群发助手</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
         background: #f5f6f8; color: #222; min-height: 100vh; }

  .header { background: linear-gradient(135deg, #1a73e8, #0052cc);
             color: #fff; padding: 18px 24px; display: flex; align-items: center; gap: 10px; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header .tag { background: rgba(255,255,255,0.2); border-radius: 4px;
                  font-size: 11px; padding: 2px 8px; }

  .container { max-width: 820px; margin: 24px auto; padding: 0 16px;
               display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }

  .card { background: #fff; border-radius: 12px; padding: 20px;
          box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .card h2 { font-size: 14px; font-weight: 600; color: #555; margin-bottom: 14px;
              display: flex; align-items: center; gap: 6px; }
  .card h2 .badge { background: #e8f0fe; color: #1a73e8; border-radius: 20px;
                     font-size: 11px; padding: 1px 8px; font-weight: 500; }

  /* 会话列表 */
  .session-toolbar { display: flex; gap: 8px; margin-bottom: 10px; }
  .session-toolbar button { font-size: 12px; padding: 4px 12px; border: 1px solid #ddd;
                             border-radius: 6px; background: #fff; cursor: pointer; color: #555; }
  .session-toolbar button:hover { background: #f0f4ff; border-color: #1a73e8; color: #1a73e8; }
  .session-list { max-height: 320px; overflow-y: auto; border: 1px solid #eee;
                   border-radius: 8px; }
  .session-item { display: flex; align-items: center; gap: 10px; padding: 10px 14px;
                   border-bottom: 1px solid #f3f3f3; cursor: pointer; transition: background .15s; }
  .session-item:last-child { border-bottom: none; }
  .session-item:hover { background: #f8f9ff; }
  .session-item.selected { background: #e8f0fe; }
  .session-item input[type=checkbox] { accent-color: #1a73e8; width: 16px; height: 16px; }
  .avatar { width: 34px; height: 34px; border-radius: 50%; background: linear-gradient(135deg,#74b9ff,#0984e3);
             display: flex; align-items: center; justify-content: center;
             font-size: 13px; color: #fff; flex-shrink: 0; font-weight: 600; }
  .session-name { font-size: 14px; }
  .loading-tip { text-align: center; padding: 28px; color: #aaa; font-size: 13px; }
  .refresh-btn { margin-top: 10px; width: 100%; padding: 8px; border: 1.5px dashed #1a73e8;
                  border-radius: 8px; background: none; color: #1a73e8; font-size: 13px; cursor: pointer; }
  .refresh-btn:hover { background: #f0f4ff; }

  /* 内容区 */
  .content-card { display: flex; flex-direction: column; gap: 12px; }
  .form-label { font-size: 12px; color: #888; margin-bottom: 4px; }
  textarea { width: 100%; border: 1px solid #e0e0e0; border-radius: 8px; padding: 10px 12px;
              font-size: 13px; resize: vertical; min-height: 140px; line-height: 1.6;
              font-family: inherit; outline: none; transition: border .2s; }
  textarea:focus { border-color: #1a73e8; }
  .img-drop { border: 2px dashed #ddd; border-radius: 8px; padding: 16px;
               text-align: center; cursor: pointer; transition: border .2s, background .2s; }
  .img-drop:hover { border-color: #1a73e8; background: #f8f9ff; }
  .img-drop p { font-size: 13px; color: #aaa; }
  .img-drop.has-img { border-color: #0f9d58; }
  .img-path { font-size: 11px; color: #0f9d58; margin-top: 4px; word-break: break-all; }
  .img-path-input { width: 100%; border: 1px solid #e0e0e0; border-radius: 8px;
                     padding: 8px 10px; font-size: 12px; color: #555; outline: none; }
  .img-path-input:focus { border-color: #1a73e8; }

  /* 发送按钮 */
  .send-area { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 10px; }
  .selected-tags { display: flex; flex-wrap: wrap; gap: 6px; min-height: 24px; }
  .tag-item { background: #e8f0fe; color: #1a73e8; border-radius: 20px;
               font-size: 12px; padding: 3px 10px; display: flex; align-items: center; gap: 4px; }
  .tag-item .remove { cursor: pointer; font-size: 14px; line-height: 1; color: #999; }
  .tag-item .remove:hover { color: #e53935; }
  .btn-send { background: linear-gradient(135deg, #1a73e8, #0052cc); color: #fff;
               border: none; border-radius: 10px; padding: 13px 0; font-size: 15px;
               font-weight: 600; cursor: pointer; width: 100%; transition: opacity .2s; }
  .btn-send:hover { opacity: .9; }
  .btn-send:disabled { opacity: .5; cursor: not-allowed; }

  /* 结果 */
  .result-box { padding: 12px 14px; border-radius: 8px; font-size: 13px; line-height: 1.8; }
  .result-box.ok  { background: #e6f9ee; color: #0f7a3a; border: 1px solid #b7edc9; }
  .result-box.err { background: #fff3f3; color: #c62828; border: 1px solid #f5b8b8; }
  .result-box.info { background: #e8f0fe; color: #1a56c4; border: 1px solid #c5d8f8; }
</style>
</head>
<body>

<div class="header">
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
  <h1>壹准 · 微信群发助手</h1>
  <span class="tag">v1.0</span>
</div>

<div class="container">

  <!-- 左：会话列表 -->
  <div class="card">
    <h2>
      选择发送对象
      <span class="badge" id="selCount">已选 0</span>
    </h2>
    <div class="session-toolbar">
      <button onclick="selectAll()">全选</button>
      <button onclick="clearAll()">清空</button>
    </div>
    <div class="session-list" id="sessionList">
      <div class="loading-tip">⏳ 正在连接微信...</div>
    </div>
    <button class="refresh-btn" onclick="loadSessions()">↻ 刷新会话列表</button>
  </div>

  <!-- 右：内容编辑 -->
  <div class="card content-card">
    <h2>编辑发送内容</h2>
    <div>
      <div class="form-label">文案（必填）</div>
      <textarea id="msgText" placeholder="输入要发送的文案..."></textarea>
    </div>
    <div>
      <div class="form-label">图片路径（选填，粘贴本地绝对路径）</div>
      <input class="img-path-input" id="imgPath" type="text"
             placeholder="例如: C:\Users\EDY\Desktop\poster.jpg">
    </div>
  </div>

  <!-- 底部发送区 -->
  <div class="send-area card">
    <div style="font-size:13px;color:#888;margin-bottom:4px;">将发送给：</div>
    <div class="selected-tags" id="selectedTags">
      <span style="color:#bbb;font-size:12px;">尚未选择联系人</span>
    </div>
    <button class="btn-send" id="sendBtn" onclick="doSend()" disabled>🚀 一键群发</button>
    <div id="resultBox" style="display:none"></div>
  </div>

</div>

<script>
let selected = new Set();
let allSessions = [];

async function loadSessions() {
  document.getElementById('sessionList').innerHTML = '<div class="loading-tip">⏳ 读取会话列表...</div>';
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    if (!data.success) {
      document.getElementById('sessionList').innerHTML =
        `<div class="loading-tip" style="color:#e53935">❌ ${data.error}</div>`;
      return;
    }
    allSessions = data.sessions;
    renderSessions();
  } catch(e) {
    document.getElementById('sessionList').innerHTML =
      `<div class="loading-tip" style="color:#e53935">❌ 无法连接服务</div>`;
  }
}

function renderSessions() {
  const el = document.getElementById('sessionList');
  if (!allSessions.length) {
    el.innerHTML = '<div class="loading-tip">没有找到会话，请确保微信已打开</div>';
    return;
  }
  el.innerHTML = allSessions.map(name => {
    const checked = selected.has(name) ? 'checked' : '';
    const selClass = selected.has(name) ? 'selected' : '';
    const avatar = name.length > 0 ? name[0] : '?';
    return `<div class="session-item ${selClass}" onclick="toggleItem('${name.replace(/'/g, "\\'")}')">
      <input type="checkbox" ${checked} onclick="event.stopPropagation(); toggleItem('${name.replace(/'/g, "\\'")}')">
      <div class="avatar">${avatar}</div>
      <span class="session-name">${name}</span>
    </div>`;
  }).join('');
}

function toggleItem(name) {
  if (selected.has(name)) selected.delete(name);
  else selected.add(name);
  renderSessions();
  updateSelectedTags();
}

function selectAll() {
  allSessions.forEach(n => selected.add(n));
  renderSessions();
  updateSelectedTags();
}

function clearAll() {
  selected.clear();
  renderSessions();
  updateSelectedTags();
}

function updateSelectedTags() {
  const tagsEl = document.getElementById('selectedTags');
  const countEl = document.getElementById('selCount');
  const sendBtn = document.getElementById('sendBtn');
  countEl.textContent = `已选 ${selected.size}`;
  sendBtn.disabled = selected.size === 0;
  if (selected.size === 0) {
    tagsEl.innerHTML = '<span style="color:#bbb;font-size:12px;">尚未选择联系人</span>';
    return;
  }
  tagsEl.innerHTML = [...selected].map(name =>
    `<span class="tag-item">${name}
       <span class="remove" onclick="toggleItem('${name.replace(/'/g, "\\'")}')">×</span>
     </span>`
  ).join('');
}

async function doSend() {
  const msg = document.getElementById('msgText').value.trim();
  const imgPath = document.getElementById('imgPath').value.trim();
  if (!msg && !imgPath) {
    showResult('error', '请至少填写文案或图片路径');
    return;
  }
  if (selected.size === 0) {
    showResult('error', '请选择至少一个发送目标');
    return;
  }
  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  btn.textContent = '发送中...';
  showResult('info', `正在向 ${selected.size} 个对象发送...`);
  try {
    const res = await fetch('/api/broadcast', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ targets: [...selected], message: msg, image_path: imgPath })
    });
    const data = await res.json();
    if (data.success) {
      let html = `✅ 成功发送 ${data.ok.length} 人：${data.ok.join('、')}`;
      if (data.errors && data.errors.length) {
        html += `<br>❌ 失败 ${data.errors.length} 人：` +
                data.errors.map(e => `${e.to}(${e.error})`).join('、');
        showResult('err', html);
      } else {
        showResult('ok', html);
      }
    } else {
      showResult('err', '❌ 发送失败：' + data.error);
    }
  } catch(e) {
    showResult('err', '❌ 请求异常：' + e.message);
  }
  btn.disabled = false;
  btn.textContent = '🚀 一键群发';
}

function showResult(type, html) {
  const box = document.getElementById('resultBox');
  box.style.display = 'block';
  box.className = 'result-box ' + type;
  box.innerHTML = html;
}

// 初始加载
loadSessions();
</script>
</body>
</html>"""

@app.route('/')
def index():
    return HTML

if __name__ == '__main__':
    print('=' * 50)
    print('壹准 · 微信群发助手已启动')
    print('浏览器打开: http://localhost:5678')
    print('=' * 50)
    app.run(host='127.0.0.1', port=5678, debug=False)
