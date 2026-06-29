// 清除可能干扰 Electron 的环境变量
delete process.env.NODE_OPTIONS;
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const os = require('os');
const aiService = require(path.join(__dirname, 'ai-service.js'));
const DouyinUploader = require(path.join(__dirname, 'platform', 'douyin-uploader.js'));
const { checkDouyinCookie } = require(path.join(__dirname, 'platform', 'cookie-manager.js'));

// ── 单实例锁（防止双开）──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── 抑制空白弹窗（渲染进程崩溃/未捕获异常不弹错误窗）──
app.on('render-process-gone', (event, webContents, details) => {
  console.error('[Main] Renderer gone:', details.reason, details.exitCode);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }
});
process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught:', err.message);
});

// ── Preview 常量 ──────────────────────────────────────────
const BACKEND_PORT = 5680;
const EXPECTED_CHANNEL = 'preview';
const EXPECTED_VERSION = '4.0.1';

let mainWindow;
let backendProcess;
let runtimeMeta = {};  // 从 health 拉到的实例元数据

function resolvePythonPath() {
  // 本机稳定路径优先，其次环境变量，最后系统PATH
  const candidates = [
    'C:/Python312/python.exe',
    process.env.YIZHUN_PYTHON,
    process.env.PYTHON,
    'python',
  ].filter(Boolean);
  return candidates[0];
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * ping backend 并返回完整 health 数据（或 null）
 * 同时比对 channel / version / backend_path 确保连到 Preview 实例
 */
function pingBackend(expectedBackendPath = '') {
  return new Promise((resolve) => {
    const req = require('http').get(`http://127.0.0.1:${BACKEND_PORT}/api/health`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          // 基础存活检查
          if (res.statusCode !== 200 || data.status !== 'ok') { resolve(null); return; }
          // channel 必须对
          if (data.channel !== EXPECTED_CHANNEL) {
            console.warn(`[Preview] port ${BACKEND_PORT} is occupied by non-preview instance (channel=${data.channel})`);
            resolve(null); return;
          }
          // 如果指定了路径，必须匹配
          if (expectedBackendPath && data.backend_path && data.backend_path !== expectedBackendPath) {
            console.warn(`[Preview] backend_path mismatch: expected ${expectedBackendPath}, got ${data.backend_path}`);
            resolve(null); return;
          }
          resolve(data);
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function waitForBackendReady(expectedBackendPath = '', maxAttempts = 15) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const meta = await pingBackend(expectedBackendPath);
    if (meta) { runtimeMeta = meta; return true; }
    await wait(800);
  }
  return false;
}

function getExpectedBackendPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backend', 'backend.exe')
    : '';
}

/**
 * 启动时只清理 Preview 端口（5680）上非 Preview 实例的残留进程
 * 不再无差别清理正式版端口 5679
 */
function killConflictingBackend() {
  const script = [
    `$port = ${BACKEND_PORT}`,
    '$conns = @()',
    'try { $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop } catch {}',
    'if (-not $conns) { exit 0 }',
    'foreach ($conn in $conns) {',
    '  try { Stop-Process -Id $conn.OwningProcess -Force -Confirm:$false } catch {}',
    '}'
  ].join('; ');

  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, () => resolve());
  });
}

async function shutdownBackend() {
  if (!backendProcess) return;

  const pid = backendProcess.pid;

  // Step 1: 优雅关闭 — 调后端 /api/shutdown
  try {
    const http = require('http');
    await new Promise((resolve) => {
      const req = http.request(`http://127.0.0.1:${BACKEND_PORT}/api/shutdown`, {
        method: 'POST',
        timeout: 2000,
      }, () => resolve());
      req.on('error', () => resolve());
      req.end();
    });
    await wait(800);
  } catch (_) {}

  // Step 2: Node 进程 kill
  if (!backendProcess.killed) {
    try { backendProcess.kill(); } catch (_) {}
    await wait(300);
  }

  // Step 3: taskkill /F /T 强杀（不依赖 .killed 标志）
  if (pid) {
    try {
      await new Promise((resolve) => {
        execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, () => resolve());
      });
      await wait(500);
    } catch (_) {}
  }

  // Step 4: 全盘兜底 — 杀干净所有 backend.exe（无论 PID 多少）
  try {
    await new Promise((resolve) => {
      execFile('taskkill', ['/F', '/IM', 'backend.exe'], { windowsHide: true }, () => resolve());
    });
  } catch (_) {}
}

function startBackend() {
  const isPackaged = app.isPackaged;
  let cmd, args;

  if (isPackaged) {
    cmd = path.join(process.resourcesPath, 'backend', 'backend.exe');
    args = [];
  } else {
    cmd = resolvePythonPath();
    args = [path.join(__dirname, '..', 'backend', 'app.py')];
  }

  backendProcess = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  backendProcess.stdout.on('data', (data) => {
    console.log(`[Backend] ${data}`);
  });

  backendProcess.stderr.on('data', (data) => {
    console.error(`[Backend Error] ${data}`);
  });

  backendProcess.on('close', (code) => {
    console.log(`Backend exited with code ${code}`);
  });
}

// ── IPC: 暴露 runtime meta 给渲染进程 ─────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 860,
    minHeight: 600,
    frame: false,
    title: '壹准AI营销助手',
    titleBarStyle: 'hidden',
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 标题栏按钮
  ipcMain.on('window-minimize', () => mainWindow.minimize());
  ipcMain.on('window-maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window-close', () => mainWindow.close());

  // 同步读取 AI 配置（在 preload 阶段注入，使用隔离文件，避免 Flask 干扰）
  ipcMain.on('get-ai-config-sync', (event) => {
    const mediaCfg = _loadMediaConfig();
    const sharedCfg = _loadAIConfig();
    // 优先隔离文件，回退共享文件
    const ai_image = (mediaCfg && mediaCfg.ai_image && Object.keys(mediaCfg.ai_image).length > 0)
      ? mediaCfg.ai_image : ((sharedCfg && sharedCfg.ai_image) || {});
    const ai_video = (mediaCfg && mediaCfg.ai_video && Object.keys(mediaCfg.ai_video).length > 0)
      ? mediaCfg.ai_video : ((sharedCfg && sharedCfg.ai_video) || {});
    event.returnValue = { ai_image, ai_video };
  });

  // 返回当前 runtime meta
  ipcMain.handle('get-runtime-meta', async () => {
    const health = await pingBackend(getExpectedBackendPath());
    if (health) runtimeMeta = health;
    return {
      frontend_version: EXPECTED_VERSION,
      frontend_channel: EXPECTED_CHANNEL,
      backend_info: runtimeMeta,
      expected_backend_path: getExpectedBackendPath(),
      is_packaged: app.isPackaged,
      backend_port: BACKEND_PORT,
    };
  });

  // 文件选择
  ipcMain.handle('select-image', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'webp'] }]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('select-multiple-images', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'webp'] }]
    });
    return result.canceled ? [] : result.filePaths.slice(0, 9);
  });

  ipcMain.handle('select-video', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'wmv', 'mkv', 'flv', 'm4v', 'webm'] }]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // 后端重启（朋友圈/群发互斥崩溃后自动恢复，等待就绪）
  ipcMain.handle('restart-backend', async () => {
    console.log('[Main] restart-backend: shutting down...');
    await shutdownBackend();
    await wait(500);
    console.log('[Main] restart-backend: starting...');
    startBackend();
    const ready = await waitForBackendReady(getExpectedBackendPath(), 25);
    console.log('[Main] restart-backend: ready=', ready);
    return { success: ready };
  });

  // 朋友圈发布 — 独立脚本直调（不走 Flask，避免 COM 互崩）
  ipcMain.handle('publish-moment', async (event, { text, mediaPaths, privacy, contact }) => {
    // 打包模式：优先使用内置 exe（跨电脑无需 Python），exe 不存在时回退 Python 脚本
    if (app.isPackaged) {
      const bundledExe = path.join(process.resourcesPath, 'moment_publisher.exe');
      if (fs.existsSync(bundledExe)) {
        const args = ['--text', text, '--privacy', privacy || '公开', '--json'];
        if (contact) args.push('--contact', contact);
        if (mediaPaths && mediaPaths.length > 0) args.push('--media', ...mediaPaths);
        return new Promise((resolve) => {
          const proc = spawn(bundledExe, args, { windowsHide: true });
          proc.stdout.setEncoding('utf8');
          proc.stderr.setEncoding('utf8');
          let stdout = '', stderr = '';
          proc.stdout.on('data', d => stdout += d);
          proc.stderr.on('data', d => stderr += d);
          proc.on('close', (code) => {
            try {
              const lines = stdout.trim().split('\n');
              for (let i = lines.length - 1; i >= 0; i--) {
                try { resolve(JSON.parse(lines[i].trim())); return; } catch (_) {}
              }
              const tail = (stdout + '\n---STDERR---\n' + stderr).slice(-500).trim() || `退出(code=${code})`;
              resolve({ success: false, error: tail });
            } catch { resolve({ success: false, error: `退出(code=${code})` }); }
          });
          proc.on('error', (err) => resolve({ success: false, error: `无法启动: ${err.message}` }));
          setTimeout(() => { try { proc.kill(); } catch(_){} }, 120000);
        });
      }
    }
    // 开发模式 / 回退：始终用 Python 脚本（与 v2.0.0 完全一致）
    const python = resolvePythonPath();
    // 打包模式：extraResources 把 wechat-wxauto/ 复制到 resources/wechat-wxauto/
    // 开发模式：wechat-wxauto/ 在项目根目录
    const wechatDir = app.isPackaged
      ? path.join(process.resourcesPath, 'wechat-wxauto')
      : path.join(__dirname, '..', 'wechat-wxauto');
    const script = path.join(wechatDir, 'moment_publisher_v9.py');
    const args = [script, '--text', text, '--privacy', privacy || '公开', '--json'];
    if (contact) {
      args.push('--contact', contact);
    }
    if (mediaPaths && mediaPaths.length > 0) {
      args.push('--media', ...mediaPaths);
    }

    return new Promise((resolve) => {
      const proc = spawn(python, args, {
        cwd: wechatDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => stdout += d);
      proc.stderr.on('data', d => stderr += d);
      proc.on('close', (code) => {
        try {
          // 从 stdout 中提取最后一行 JSON（忽略前面的 log 行）
          const lines = stdout.trim().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const result = JSON.parse(lines[i].trim());
              resolve(result);
              return;
            } catch (_) {}
          }
          // 所有行都不是 JSON — 构造有意义的错误信息
          const tail = (stdout + '\n---STDERR---\n' + stderr).slice(-500).trim()
            || `脚本退出(code=${code})，无输出`;
          resolve({ success: false, error: tail });
        } catch {
          const tail = (stdout + '\n---STDERR---\n' + stderr).slice(-500).trim()
            || `脚本退出(code=${code})，无输出`;
          resolve({ success: false, error: tail });
        }
      });
      proc.on('error', (err) => {
        console.error('[publish-moment] spawn error:', err.message);
        resolve({ success: false, error: `无法启动脚本: ${err.message} (python=${python})` });
      });
      // 120秒超时
      setTimeout(() => {
        console.error('[publish-moment] timeout after 120s, killing');
        try { proc.kill(); } catch(_){}
      }, 120000);
    });
  });

  // 保存文件
  ipcMain.handle('save-file', async (event, sourcePath) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: 'processed_image.png',
      filters: [{ name: 'PNG', extensions: ['png'] }]
    });
    if (result.canceled) return null;
    try {
      fs.copyFileSync(sourcePath, result.filePath);
      return result.filePath;
    } catch (err) {
      console.error('File copy failed:', err);
      return null;
    }
  });

  // ── 话术库管理（直接操作 scripts.json，不依赖 backend.exe 版本）──
  function _getScriptsPath() {
    const dataDir = path.join(app.getPath('appData'), 'yizhun-wechat-bot-preview');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    return path.join(dataDir, 'scripts.json');
  }
  function _loadScriptsSafe() {
    const p = _getScriptsPath();
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf-8');
    if (!raw || !raw.trim()) return [];
    try { return JSON.parse(raw); } catch (_) { return []; }
  }
  function _saveScriptsSafe(arr) {
    const p = _getScriptsPath();
    fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf-8');
  }

  ipcMain.handle('get-scripts', async () => {
    try {
      const scripts = _loadScriptsSafe();
      return { success: true, scripts };
    } catch (err) {
      console.error('[get-scripts]', err.message);
      return { success: false, error: err.message, scripts: [] };
    }
  });

  ipcMain.handle('add-script', async (event, { tag, text }) => {
    try {
      const scripts = _loadScriptsSafe();
      const newId = 'sc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      scripts.push({ id: newId, tag: (tag || '').trim(), text: (text || '').trim() });
      _saveScriptsSafe(scripts);
      return { success: true, id: newId };
    } catch (err) {
      console.error('[add-script]', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('delete-script', async (event, scriptId) => {
    try {
      const scripts = _loadScriptsSafe();
      _saveScriptsSafe(scripts.filter(s => s.id !== scriptId));
      return { success: true };
    } catch (err) {
      console.error('[delete-script]', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('update-script', async (event, { id, tag, text }) => {
    try {
      const scripts = _loadScriptsSafe();
      for (const s of scripts) {
        if (s.id === id) {
          if (tag !== undefined) s.tag = (tag || '').trim();
          if (text !== undefined) s.text = (text || '').trim();
          _saveScriptsSafe(scripts);
          return { success: true, script: s };
        }
      }
      return { success: false, error: '话术不存在' };
    } catch (err) {
      console.error('[update-script]', err.message);
      return { success: false, error: err.message };
    }
  });

  // ── 文件大小查询 ──
  ipcMain.handle('get-file-size', async (event, filePath) => {
    try {
      const stat = fs.statSync(filePath);
      return { size: stat.size };
    } catch (err) {
      return { size: -1, error: err.message };
    }
  });

  // ── 图片缩略图生成（解决大图预览卡顿）──
  ipcMain.handle('get-thumbnail', async (event, filePath, maxWidth = 400) => {
    try {
      if (!fs.existsSync(filePath)) return { dataUrl: null };
      // 用 Electron nativeImage 读取并缩放
      const img = nativeImage.createFromPath(filePath);
      if (img.isEmpty()) return { dataUrl: null };
      const orig = img.getSize();
      let w = orig.width, h = orig.height;
      if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
      const thumb = img.resize({ width: w, height: h, quality: 'good' });
      return { dataUrl: thumb.toDataURL() };
    } catch (err) {
      console.error('[get-thumbnail]', err.message);
      return { dataUrl: null };
    }
  });

  // ── 图片压缩（解决大图 wxauto SendFiles 静默失败）──
  ipcMain.handle('compress-image', async (event, filePath) => {
    try {
      if (!fs.existsSync(filePath)) return { success: false, error: 'file not found' };
      const img = nativeImage.createFromPath(filePath);
      if (img.isEmpty()) return { success: false, error: 'cannot read image' };
      const orig = img.getSize();
      const MAX_DIM = 2880;
      let w = orig.width, h = orig.height;
      if (w > MAX_DIM || h > MAX_DIM) {
        if (w >= h) { h = Math.round(h * MAX_DIM / w); w = MAX_DIM; }
        else        { w = Math.round(w * MAX_DIM / h); h = MAX_DIM; }
      }
      const compressed = img.resize({ width: w, height: h, quality: 'best' });
      const jpegBuf = compressed.toJPEG(85);
      const tmpDir = path.join(app.getPath('temp'), 'yizhun-images');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const tmpPath = path.join(tmpDir, `compressed_${Date.now()}.jpg`);
      fs.writeFileSync(tmpPath, jpegBuf);
      return { success: true, path: tmpPath, size: jpegBuf.length };
    } catch (err) {
      console.error('[compress-image]', err.message);
      return { success: false, error: err.message };
    }
  });

  // 打开外部链接
  ipcMain.on('open-url', (event, url) => shell.openExternal(url));

  // ═══════════════════════════════════════════════════
  //  AI 创意中心 — 配置管理
  // ═══════════════════════════════════════════════════
  function _getAIConfigPath() {
    const dataDir = path.join(app.getPath('appData'), 'yizhun-wechat-bot-preview');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    return path.join(dataDir, 'config.json');
  }
  // 图片/视频配置使用独立的隔离文件（userData 目录，Flask 绝不会碰）
  function _getMediaConfigPath() {
    const dir = path.join(app.getPath('userData'), 'ai-config');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'ai-media-config.json');
  }
  function _loadAIConfig() {
    const p = _getAIConfigPath();
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, 'utf-8');
    try { return JSON.parse(raw); } catch (_) { return null; }  // null = 解析失败（数据损坏，保护不写入）
  }
  function _saveAIConfig(obj) {
    const p = _getAIConfigPath();
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
  }
  // 隔离文件的读写函数（不受 Flask 干扰）
  function _loadMediaConfig() {
    const p = _getMediaConfigPath();
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, 'utf-8');
    try { return JSON.parse(raw); } catch (_) { return {}; }
  }
  function _saveMediaConfig(obj) {
    const p = _getMediaConfigPath();
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
  }

  ipcMain.handle('ai-get-config', async () => {
    try {
      const mediaCfg = _loadMediaConfig();
      const full = _loadAIConfig() || {};
      // 优先使用隔离文件中的数据，回退到共享文件
      return {
        success: true,
        config: {
          ai: full.ai || {},
          ai_image: (mediaCfg.ai_image && Object.keys(mediaCfg.ai_image).length > 0)
            ? mediaCfg.ai_image : (full.ai_image || {}),
          ai_video: (mediaCfg.ai_video && Object.keys(mediaCfg.ai_video).length > 0)
            ? mediaCfg.ai_video : (full.ai_video || {}),
        },
      };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('ai-save-config', async (event, { section, data }) => {
    try {
      // ── 写入隔离文件（主要存储，Flask 无访问）──
      let mediaCfg = _loadMediaConfig();
      if (typeof mediaCfg !== 'object' || mediaCfg === null) mediaCfg = {};
      var existing = mediaCfg[section] || {};
      var merged = {};
      Object.keys(existing).forEach(function(k) { merged[k] = existing[k]; });
      Object.keys(data).forEach(function(k) {
        if (data[k] !== undefined && data[k] !== null && data[k] !== '') merged[k] = data[k];
      });
      mediaCfg[section] = merged;
      _saveMediaConfig(mediaCfg);

      // ── 同步写入共享 config.json（保持与 Flask 兼容）──
      let full = _loadAIConfig();
      if (full === null) {
        const p = _getAIConfigPath();
        if (!fs.existsSync(p)) { full = {}; }
        else { return { success: true }; }  // 共享文件损坏但不影响隔离文件，返回成功
      }
      full[section] = merged;
      if (!full.ai) full.ai = { enabled: true };
      if (!full.fallback) full.fallback = { use_scripts: true, allow_manual: true };
      if (!full.broadcast) full.broadcast = {};
      if (!full.app) full.app = { version: EXPECTED_VERSION, update_channel: 'github' };
      _saveAIConfig(full);
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // 确保 AI 媒体临时目录存在
  function _ensureAITmpDir() {
    const tmpDir = path.join(app.getPath('temp'), 'yizhun-ai-media');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
  }

  // ── AbortController 管理（支持停止生成）──
  let _aiAbortController = null;

  ipcMain.handle('ai-abort', async () => {
    if (_aiAbortController) {
      _aiAbortController.abort();
      _aiAbortController = null;
      return { success: true };
    }
    return { success: false, error: '没有正在进行的请求' };
  });

  // ═══════════════════════════════════════════════════
  //  AI 创意中心 — 对话式生文
  // ═══════════════════════════════════════════════════
  ipcMain.handle('ai-chat', async (event, { sessionId, messages, config, searchEnabled }) => {
    try {
      const cfg = config || ((_loadAIConfig() || {}).ai || {});
      if (!cfg.api_key) return { success: false, error: '请先在设置中配置语言大模型 API Key' };
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return { success: false, error: '消息列表为空' };
      }

      // 处理参考图：将 refPath 转为 vision 格式的 base64
      const processedMessages = [];
      for (const m of messages) {
        if (m.role === 'user' && m.refPath && fs.existsSync(m.refPath)) {
          try {
            const buf = fs.readFileSync(m.refPath);
            const ext = path.extname(m.refPath).toLowerCase();
            const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif' };
            const mime = mimeMap[ext] || 'image/jpeg';
            const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
            processedMessages.push({
              role: 'user',
              content: [
                { type: 'text', text: m.content || '请描述这张图片' },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            });
          } catch (imgErr) {
            console.error('[ai-chat] 参考图读取失败:', imgErr.message);
            processedMessages.push({ role: m.role, content: m.content + '\n[图片读取失败: ' + m.refPath + ']' });
          }
        } else {
          processedMessages.push({ role: m.role, content: m.content });
        }
      }

      // 联网搜索：从最后一条用户消息提取搜索词，注入结果到系统提示
      let searchInfo = null;
      if (searchEnabled) {
        const lastUser = [...processedMessages].reverse().find(m => m.role === 'user');
        if (lastUser) {
          const query = typeof lastUser.content === 'string' ? lastUser.content : (lastUser.content?.[0]?.text || '');
          if (query) {
            try {
              const searchResults = await aiService.webSearch(query, 3);
              if (searchResults && searchResults.length > 0) {
                const searchText = searchResults.map((r, i) => `${i + 1}. ${r.snippet}`).join('\n');
                processedMessages.unshift({
                  role: 'system',
                  content: `以下是与用户问题相关的实时网络搜索结果，请参考这些信息回答：\n${searchText}`,
                });
                searchInfo = { success: true, count: searchResults.length, query };
              } else {
                searchInfo = { success: false, reason: '无搜索结果', query };
              }
            } catch (_) { searchInfo = { success: false, reason: '搜索超时', query }; }
          }
        }
      }

      _aiAbortController = new AbortController();
      const result = await aiService.chatCompletion(cfg, processedMessages, _aiAbortController.signal);
      _aiAbortController = null;
      if (searchInfo) result.searchInfo = searchInfo;
      return result;
    } catch (e) {
      _aiAbortController = null;
      if (e.message === 'aborted') return { success: false, error: '已停止' };
    }
  });

  // ═══════════════════════════════════════════════════
  //  AI 创意中心 — 生图
  // ═══════════════════════════════════════════════════
  ipcMain.handle('ai-generate-image', async (event, { prompt, options, config }) => {
    try {
      const cfg = config || ((_loadAIConfig() || {}).ai_image || {});
      if (!cfg.api_key) return { success: false, error: '请先在设置中配置生图大模型 API Key' };

      // 处理参考图 base64
      const opts = { ...options };
      if (opts.reference_image_path) {
        try {
          const buf = fs.readFileSync(opts.reference_image_path);
          const ext = path.extname(opts.reference_image_path).toLowerCase();
          const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' };
          const mime = mimeMap[ext] || 'image/jpeg';
          opts.reference_image_base64 = `data:${mime};base64,${buf.toString('base64')}`;
        } catch (imgErr) { console.error('[ai-generate-image] 参考图读取失败:', imgErr.message); }
      }

      _aiAbortController = new AbortController();
      const result = await aiService.generateImage(cfg, prompt, opts, _aiAbortController.signal);
      _aiAbortController = null;
      if (!result.success) return result;

      // 下载生成的图片到本地临时目录
      const tmpDir = _ensureAITmpDir();
      const localPaths = [];
      for (const img of result.images) {
        if (img.url) {
          try {
            const localPath = await aiService.downloadToTemp(img.url, tmpDir, 'img_');
            localPaths.push({ url: img.url, local_path: localPath });
          } catch (e) {
            console.error('[ai-generate-image] download failed:', e.message);
            // 下载失败不阻塞，仍保留 url
            localPaths.push({ url: img.url, local_path: null });
          }
        }
      }
      return { success: true, images: localPaths };
    } catch (e) {
      _aiAbortController = null;
      if (e.message === 'aborted') return { success: false, error: '已停止' };
      return { success: false, error: `生图失败: ${e.message}` };
    }
  });

  // ── 选择单张图片（生图/生视频参考图用）──
  ipcMain.handle('select-reference-image', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'webp'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // 选择多类型文件（图片/视频/文档）
  ipcMain.handle('select-file', async (event, types) => {
    const filters = [];
    if (!types || types.includes('image')) filters.push({ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'webp', 'gif'] });
    if (!types || types.includes('video')) filters.push({ name: '视频', extensions: ['mp4', 'avi', 'mov', 'mkv', 'wmv'] });
    if (!types || types.includes('doc')) filters.push({ name: '文档', extensions: ['txt', 'doc', 'docx', 'pdf'] });
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters });
    return result.canceled ? null : result.filePaths[0];
  });

  // 选择文件夹（存储目录用）
  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  // 从配置读取存储目录（使用统一的 _loadAIConfig / _saveAIConfig 避免数据损坏）
  let _storageDir = (() => {
    const cfg = _loadAIConfig() || {};
    if (cfg.storage_dir && fs.existsSync(cfg.storage_dir)) return cfg.storage_dir;
    return path.join(app.getPath('userData'), 'resources');
  })();

  // 确保隔离文件和共享文件都包含 ai_image / ai_video 段
  (() => {
    const cfg = _loadAIConfig();
    if (cfg && !cfg.ai_image) { cfg.ai_image = {}; _saveAIConfig(cfg); }
    if (cfg && !cfg.ai_video) { cfg.ai_video = {}; _saveAIConfig(cfg); }
    // 隔离文件也初始化
    const mcfg = _loadMediaConfig();
    if (!mcfg.ai_image) { mcfg.ai_image = {}; _saveMediaConfig(mcfg); }
    if (!mcfg.ai_video) { mcfg.ai_video = {}; _saveMediaConfig(mcfg); }
  })();

  const _dbFile = path.join(app.getPath('userData'), 'resource-db.json');

  function _dbRead() {
    try { const raw = fs.readFileSync(_dbFile, 'utf-8'); return JSON.parse(raw); }
    catch { return []; }
  }
  function _dbWrite(items) {
    fs.writeFileSync(_dbFile, JSON.stringify(items, null, 2), 'utf-8');
  }
  function _dbNextId() { return 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

  ipcMain.handle('db-list', async () => _dbRead());
  ipcMain.handle('db-get-path', async () => _storageDir);

  ipcMain.handle('db-set-path', async (event, dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _storageDir = dir;
    // 持久化 — 使用统一的 _loadAIConfig/_saveAIConfig，不会损坏已有数据
    const cfg = _loadAIConfig();
    if (cfg !== null) {
      cfg.storage_dir = dir;
      _saveAIConfig(cfg);
    }
    return { success: true, dir };
  });

  ipcMain.handle('db-add', async (event, item) => {
    const list = _dbRead();
    const now = Date.now();
    const entry = { id: _dbNextId(), type: item.type || 'text', title: item.title || '', tags: item.tags || [], content: item.content || '', filePath: item.filePath || '', thumbnail: '', createdAt: now, updatedAt: now };
    if ((entry.type === 'image' || entry.type === 'video') && entry.filePath && fs.existsSync(entry.filePath)) {
      const ext = path.extname(entry.filePath);
      const dest = path.join(_storageDir, entry.id + ext);
      try { fs.copyFileSync(entry.filePath, dest); entry.filePath = dest; } catch {}
      if (entry.type === 'image') {
        try { entry.thumbnail = dest; } catch {}
      }
    }
    list.push(entry);
    _dbWrite(list);
    return { success: true, item: entry };
  });

  ipcMain.handle('db-update', async (event, { id, updates }) => {
    const list = _dbRead();
    const idx = list.findIndex(x => x.id === id);
    if (idx < 0) return { success: false, error: '未找到' };
    Object.assign(list[idx], updates, { updatedAt: Date.now() });
    _dbWrite(list);
    return { success: true, item: list[idx] };
  });

  ipcMain.handle('db-delete', async (event, id) => {
    const list = _dbRead();
    const idx = list.findIndex(x => x.id === id);
    if (idx < 0) return { success: false, error: '未找到' };
    const removed = list.splice(idx, 1)[0];
    _dbWrite(list);
    // 清理文件
    if (removed.filePath && fs.existsSync(removed.filePath)) {
      try { fs.unlinkSync(removed.filePath); } catch {}
    }
    return { success: true };
  });

  ipcMain.handle('db-search', async (event, { query, type }) => {
    const list = _dbRead();
    const q = (query || '').toLowerCase();
    return list.filter(x => {
      if (type && x.type !== type) return false;
      if (!q) return true;
      return (x.title || '').toLowerCase().includes(q) || (x.content || '').toLowerCase().includes(q) || (x.tags || []).some(t => t.toLowerCase().includes(q));
    });
  });

  // ═══════════════════════════════════════════════════
  //  AI 创意中心 — 生视频
  // ═══════════════════════════════════════════════════
  ipcMain.handle('ai-create-video-task', async (event, { prompt, options, config }) => {
    try {
      const cfg = config || ((_loadAIConfig() || {}).ai_video || {});
      if (!cfg.api_key) return { success: false, error: '请先在设置中配置生视频大模型 API Key' };

      const opts = { ...options };
      if (opts.reference_image_path) {
        try {
          const buf = fs.readFileSync(opts.reference_image_path);
          const ext = path.extname(opts.reference_image_path).toLowerCase();
          const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' };
          const mime = mimeMap[ext] || 'image/jpeg';
          opts.reference_image_base64 = `data:${mime};base64,${buf.toString('base64')}`;
        } catch (imgErr) { console.error('[ai-generate-image] 参考图读取失败:', imgErr.message); }
      }

      _aiAbortController = new AbortController();
      const result = await aiService.createVideoTask(cfg, prompt, opts, _aiAbortController.signal);
      _aiAbortController = null;
      return result;
    } catch (e) {
      _aiAbortController = null;
      if (e.message === 'aborted') return { success: false, error: '已停止' };
      return { success: false, error: `创建视频任务失败: ${e.message}` };
    }
  });

  ipcMain.handle('ai-poll-video-task', async (event, { taskId, config }) => {
    try {
      const cfg = config || ((_loadAIConfig() || {}).ai_video || {});
      _aiAbortController = new AbortController();
      const result = await aiService.pollVideoTask(cfg, taskId, _aiAbortController.signal);
      _aiAbortController = null;
      // 如果完成且有视频 URL，下载到本地
      if (result.success && result.status === 'completed' && result.video_url) {
        try {
          const tmpDir = _ensureAITmpDir();
          const localPath = await aiService.downloadToTemp(result.video_url, tmpDir, 'vid_');
          result.local_path = localPath;
        } catch (e) {
          console.error('[ai-poll-video-task] download failed:', e.message);
        }
      }
      return result;
    } catch (e) {
      return { success: false, status: 'error', error: `查询视频失败: ${e.message}` };
    }
  });

  // 下载更新包
  ipcMain.handle('download-update', async (event, downloadUrl) => {
    const downloadsDir = app.getPath('downloads');
    const fileName = '壹准AI营销助手_Setup.exe';
    const filePath = path.join(downloadsDir, fileName);

    mainWindow.webContents.send('download-progress', { status: 'downloading', progress: 0 });

    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      let finalUrl = downloadUrl;
      let redirectCount = 0;

      function makeRequest(url) {
        finalUrl = url;
        const proto = url.startsWith('https') ? https : require('http');
        const req = proto.get(url, { headers: { 'User-Agent': 'YizhunApp/2.0' } }, (response) => {
          // Follow redirects (GitHub → S3)
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            redirectCount++;
            if (redirectCount > 5) return reject(new Error('Too many redirects'));
            return makeRequest(response.headers.location);
          }

          const totalSize = parseInt(response.headers['content-length'] || '0', 10);
          let downloaded = 0;

          response.on('data', (chunk) => {
            downloaded += chunk.length;
            const pct = totalSize > 0 ? Math.round((downloaded / totalSize) * 100) : Math.round(downloaded / 1024 / 1024);
            mainWindow.webContents.send('download-progress', { status: 'downloading', progress: pct, downloaded, totalSize });
          });

          response.pipe(file);

          file.on('finish', () => {
            file.close();
            mainWindow.webContents.send('download-progress', { status: 'complete', filePath });
            resolve({ success: true, filePath });
          });

          file.on('error', (err) => {
            file.close();
            try { fs.unlinkSync(filePath); } catch (e) {}
            mainWindow.webContents.send('download-progress', { status: 'error', error: err.message });
            reject(err);
          });
        });

        req.on('error', (err) => {
          file.close();
          try { fs.unlinkSync(filePath); } catch (e) {}
          mainWindow.webContents.send('download-progress', { status: 'error', error: err.message });
          reject(err);
        });

        req.setTimeout(30000, () => {
          req.destroy();
          reject(new Error('连接超时'));
        });
      }

      makeRequest(downloadUrl);
    });
  });

  // 安装更新
  ipcMain.handle('install-update', async (event, filePath) => {
    shell.openPath(filePath);
    await shutdownBackend();
    setTimeout(() => app.quit(), 500);
    return { success: true };
  });
  // ── 多平台分发 IPC ──
  const platformCookieDir = path.join(process.env.APPDATA || os.homedir(), 'yizhun-wechat-bot-preview', 'platform-cookies');

  // 初始化目录
  ipcMain.handle('platform:init', async () => {
    try { fs.mkdirSync(platformCookieDir, { recursive: true }); } catch (_) {}
    return { cookieDir: platformCookieDir };
  });

  // 检查抖音 Cookie 状态（完整校验：开浏览器验证）
  ipcMain.handle('platform:check-douyin', async (event, { accountName }) => {
    const acct = accountName || 'default';
    const cookiePath = path.join(platformCookieDir, `${acct}.json`);
    const valid = await checkDouyinCookie(cookiePath);
    return { valid, accountName: acct };
  });

  // 快速检查 Cookie 状态（只读文件，不开浏览器 — 启动时用）
  ipcMain.handle('platform:check-douyin-quick', async (event, { accountName }) => {
    const acct = accountName || 'default';
    const cookiePath = path.join(platformCookieDir, `${acct}.json`);
    if (!fs.existsSync(cookiePath)) return { valid: false, accountName: acct };
    try {
      const raw = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
      const now = Date.now() / 1000;
      // 检查 sessionid/passport 且未过期
      const hasSession = raw.cookies && raw.cookies.some(c =>
        c.name && (c.name.includes('sessionid') || c.name.includes('passport')) &&
        (!c.expires || c.expires === -1 || c.expires > now)
      );
      return { valid: hasSession, accountName: acct };
    } catch { return { valid: false, accountName: acct }; }
  });

  // 列出所有账号
  ipcMain.handle('platform:list-accounts', async () => {
    try {
      if (!fs.existsSync(platformCookieDir)) return { accounts: [] };
      const files = fs.readdirSync(platformCookieDir).filter(f => f.endsWith('.json'));
      const accounts = files.map(f => f.replace('.json', ''));
      return { accounts };
    } catch { return { accounts: [] }; }
  });

  // 添加账号（创建空 cookie 占位）
  ipcMain.handle('platform:add-account', async (event, { accountName }) => {
    if (!accountName || !/^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/.test(accountName)) {
      return { success: false, error: '账号名只能包含字母、数字、中文、下划线、横线' };
    }
    try {
      if (!fs.existsSync(platformCookieDir)) fs.mkdirSync(platformCookieDir, { recursive: true });
      const cookiePath = path.join(platformCookieDir, `${accountName}.json`);
      if (fs.existsSync(cookiePath)) return { success: false, error: '账号已存在' };
      fs.writeFileSync(cookiePath, '{"cookies":[],"origins":[]}', 'utf-8');
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // 抖音扫码登录
  ipcMain.handle('platform:login-douyin', async (event, { accountName }) => {
    const acct = accountName || 'default';
    const cookiePath = path.join(platformCookieDir, `${acct}.json`);
    console.log(`[Platform] login-douyin called for ${acct}, cookiePath=${cookiePath}`);
    try {
      const { loginDouyin } = require(path.join(__dirname, 'platform', 'cookie-manager.js'));
      const result = await loginDouyin(cookiePath, platformCookieDir, acct, (qrcodeDataURL) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('platform:qrcode', { dataURL: qrcodeDataURL });
        }
      });
      console.log(`[Platform] login-douyin result for ${acct}:`, JSON.stringify(result));
      return result;
    } catch (e) {
      console.error(`[Platform] login-douyin error for ${acct}:`, e.message, e.stack);
      return { success: false, message: `后端错误: ${e.message}` };
    }
  });

  // 抖音视频发布
  let currentPublishCancel = false;

  ipcMain.handle('platform:publish-douyin', async (event, params) => {
    currentPublishCancel = false;
    const cookiePath = path.join(platformCookieDir, `${params.accountName || 'default'}.json`);

    const uploader = new DouyinUploader({
      accountName: params.accountName || 'default',
      cookieDir: platformCookieDir,
      title: params.title,
      filePath: params.filePath,
      tags: params.tags || [],
      desc: params.desc || '',
      publishDate: params.publishDate || 0,
      thumbnailPath: params.thumbnailPath || '',
      onLog: (msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('platform:log', { message: msg });
        }
      },
    });

    let success = false;
    try {
      await uploader.upload();
      success = true;
    } catch (e) {
      return { success: false, error: e.message };
    }
    return { success: true };
  });

  // ── 视频号 IPC ──

  ipcMain.handle('platform:list-shipinhao-accounts', async () => {
    try {
      const dir = path.join(platformCookieDir, 'shipinhao');
      if (!fs.existsSync(dir)) return { accounts: [] };
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      return { accounts: files.map(f => f.replace('.json', '')) };
    } catch { return { accounts: [] }; }
  });

  ipcMain.handle('platform:check-shipinhao-quick', async (event, { accountName }) => {
    const acct = accountName || 'default';
    const cookiePath = path.join(platformCookieDir, 'shipinhao', `${acct}.json`);
    if (!fs.existsSync(cookiePath)) return { valid: false, accountName: acct };
    try {
      const raw = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
      // 双重校验：1. 微信专属 Cookie 名称 2. 来自微信域的 Cookie 数量
      const wechatKeys = ['wxuin', 'wxsid', 'wxssid', 'data_bizuin', 'mm_lang', 'uin', 'sid', 'pass_ticket'];
      const byName = raw.cookies && raw.cookies.filter(c => c.name && wechatKeys.some(k => c.name.includes(k)));
      const byDomain = raw.cookies && raw.cookies.filter(c => c.domain && (c.domain.includes('weixin') || c.domain.includes('wechat') || c.domain.includes('channels')));
      const hasSession = (byName && byName.length >= 1) || (byDomain && byDomain.length >= 3);
      return { valid: hasSession, accountName: acct };
    } catch { return { valid: false, accountName: acct }; }
  });

  ipcMain.handle('platform:check-shipinhao', async (event, { accountName }) => {
    const acct = accountName || 'default';
    const cookiePath = path.join(platformCookieDir, 'shipinhao', `${acct}.json`);
    if (!fs.existsSync(cookiePath)) return { valid: false, accountName: acct };
    try {
      const raw = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
      const wechatKeys = ['wxuin', 'wxsid', 'wxssid', 'data_bizuin', 'mm_lang', 'uin', 'sid', 'pass_ticket'];
      const byName = raw.cookies && raw.cookies.filter(c => c.name && wechatKeys.some(k => c.name.includes(k)));
      const byDomain = raw.cookies && raw.cookies.filter(c => c.domain && (c.domain.includes('weixin') || c.domain.includes('wechat') || c.domain.includes('channels')));
      const hasSession = (byName && byName.length >= 1) || (byDomain && byDomain.length >= 3);
      return { valid: hasSession, accountName: acct };
    } catch { return { valid: false, accountName: acct }; }
  });

  ipcMain.handle('platform:login-shipinhao', async (event, { accountName }) => {
    const acct = accountName || 'default';
    const cookiePath = path.join(platformCookieDir, 'shipinhao', `${acct}.json`);
    try {
      const cookieDir2 = path.join(platformCookieDir, 'shipinhao');
      if (!fs.existsSync(cookieDir2)) fs.mkdirSync(cookieDir2, { recursive: true });
      const { loginShipinhao } = require(path.join(__dirname, 'platform', 'shipinhao-uploader.js'));
      const result = await loginShipinhao(cookiePath, cookieDir2, acct, null);
      return result;
    } catch (e) {
      return { success: false, message: `登录失败: ${e.message}` };
    }
  });

  ipcMain.handle('platform:publish-shipinhao', async (event, params) => {
    currentPublishCancel = false;
    const { ShipinhaoUploader } = require(path.join(__dirname, 'platform', 'shipinhao-uploader.js'));
    const cookieDir = path.join(platformCookieDir, 'shipinhao');
    if (!fs.existsSync(cookieDir)) fs.mkdirSync(cookieDir, { recursive: true });

    const uploader = new ShipinhaoUploader({
      accountName: params.accountName || 'default',
      cookieDir,
      title: params.title,
      filePath: params.filePath,
      tags: params.tags || [],
      desc: params.desc || '',
      publishDate: params.publishDate || 0,
      thumbnailPath: params.thumbnailPath || '',
      onLog: (msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('platform:log', { message: msg });
        }
      },
    });

    try {
      await uploader.upload();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 取消发布
  ipcMain.handle('platform:cancel-publish', async () => {
    currentPublishCancel = true;
    return { success: true };
  });

  // 文件信息校验（前端预检用）
  const { getImageDimensions, getFileSizeMB } = require(path.join(__dirname, 'platform', 'media-validator.js'));
  ipcMain.handle('platform:check-file', async (event, { filePath, type }) => {
    try {
      if (!fs.existsSync(filePath)) return { valid: false, error: '文件不存在' };
      const sizeMB = getFileSizeMB(filePath);
      if (type === 'image') {
        const dim = getImageDimensions(filePath);
        return { valid: true, sizeMB, dimensions: dim ? `${dim.width}×${dim.height}` : 'unknown', format: dim ? dim.format : 'unknown' };
      }
      return { valid: true, sizeMB };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  });

  // 删除账号 Cookie 文件（账号从列表消失）
  ipcMain.handle('platform:logout', async (event, { accountName }) => {
    const acct = accountName || 'default';
    // 抖音和视频号路径不同，都要尝试删除
    const douyinPath = path.join(platformCookieDir, `${acct}.json`);
    const shipinhaoPath = path.join(platformCookieDir, 'shipinhao', `${acct}.json`);
    try {
      for (const p of [douyinPath, shipinhaoPath]) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 获取浏览器信息
  const { detectBrowserChannel } = require(path.join(__dirname, 'platform', 'base-uploader.js'));
  ipcMain.handle('platform:get-browser', async () => {
    const channel = detectBrowserChannel();
    return { channel, label: channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome' };
  });
}

app.whenReady().then(async () => {
  const expectedBackendPath = getExpectedBackendPath();

  // 预创建空话术文件，避免后端用内置模板初始化
  const appDataDir = path.join(process.env.APPDATA || os.homedir(), 'yizhun-wechat-bot-preview');
  const scriptsFile = path.join(appDataDir, 'scripts.json');
  try {
    fs.mkdirSync(appDataDir, { recursive: true });
    if (!fs.existsSync(scriptsFile)) {
      fs.writeFileSync(scriptsFile, '[]', 'utf-8');
    }
    // 创建平台 Cookie 目录
    const platformCookieDir = path.join(appDataDir, 'platform-cookies');
    fs.mkdirSync(platformCookieDir, { recursive: true });
  } catch (_) {}

  await killConflictingBackend();
  startBackend();
  const ready = await waitForBackendReady(expectedBackendPath);
  if (!ready) {
    console.error('[Preview] Backend did not become ready in time');
  } else {
    console.log('[Preview] Backend ready, channel=', runtimeMeta.channel, 'version=', runtimeMeta.version);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async (event) => {
  event.preventDefault();
  await shutdownBackend();
  app.exit(0);
});
