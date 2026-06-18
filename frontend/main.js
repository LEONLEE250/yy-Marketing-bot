// 清除可能干扰 Electron 的环境变量
delete process.env.NODE_OPTIONS;
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const os = require('os');

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

// ── Preview 常量 ──────────────────────────────────────────
const BACKEND_PORT = 5680;
const EXPECTED_CHANNEL = 'preview';
const EXPECTED_VERSION = '2.2.0';

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

  // 下载更新包
  ipcMain.handle('download-update', async (event, downloadUrl) => {
    const downloadsDir = app.getPath('downloads');
    const fileName = '壹准AI营销助手_Setup.exe';
    const filePath = path.join(downloadsDir, fileName);

    mainWindow.webContents.send('download-progress', { status: 'downloading', progress: 0 });

    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);

      function handleResponse(response) {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          https.get(response.headers.location, handleResponse).on('error', reject);
          return;
        }

        const totalSize = parseInt(response.headers['content-length'] || '0', 10);
        let downloaded = 0;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (totalSize > 0) {
            const progress = Math.round((downloaded / totalSize) * 100);
            mainWindow.webContents.send('download-progress', { status: 'downloading', progress });
          }
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
      }

      https.get(downloadUrl, handleResponse).on('error', (err) => {
        file.close();
        try { fs.unlinkSync(filePath); } catch (e) {}
        mainWindow.webContents.send('download-progress', { status: 'error', error: err.message });
        reject(err);
      });
    });
  });

  // 安装更新
  ipcMain.handle('install-update', async (event, filePath) => {
    shell.openPath(filePath);
    await shutdownBackend();
    setTimeout(() => app.quit(), 500);
    return { success: true };
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
