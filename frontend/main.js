// 清除可能干扰 Electron 的环境变量
delete process.env.NODE_OPTIONS;
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const os = require('os');

// ── 应用常量 ──────────────────────────────────────────
const BACKEND_PORT = 5679;
const EXPECTED_CHANNEL = 'release';
const EXPECTED_VERSION = '1.2.0';

let mainWindow;
let backendProcess;
let runtimeMeta = {};  // 从 health 拉到的实例元数据

function resolvePythonPath() {
  const candidates = [
    'C:/Python312/python.exe',
    process.env.YIZHUN_PYTHON,
    process.env.PYTHON,
    'python'
  ].filter(Boolean);
  return candidates[0];
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * ping backend 并返回完整 health 数据（或 null）
 * 同时比对 channel / version / backend_path 确保连到正确实例
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
            console.warn(`[Yizhun] port ${BACKEND_PORT} is occupied by another instance (channel=${data.channel})`);
            resolve(null); return;
          }
          // 如果指定了路径，必须匹配
          if (expectedBackendPath && data.backend_path && data.backend_path !== expectedBackendPath) {
            console.warn(`[Yizhun] backend_path mismatch: expected ${expectedBackendPath}, got ${data.backend_path}`);
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
 * 启动时清理端口上残留进程
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
  if (!backendProcess || backendProcess.killed) return;

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

  // Step 3: 兜底 — taskkill /F /T 强杀进程树
  if (!backendProcess.killed && backendProcess.pid) {
    try {
      await new Promise((resolve) => {
        execFile('taskkill', ['/F', '/T', '/PID', String(backendProcess.pid)], { windowsHide: true }, () => resolve());
      });
    } catch (_) {}
  }
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
    title: '壹准AI微信营销助手',
    titleBarStyle: 'hidden',
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
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

  ipcMain.handle('select-video', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'wmv', 'mkv', 'flv', 'm4v', 'webm'] }]
    });
    return result.canceled ? null : result.filePaths[0];
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

  // 打开外部链接
  ipcMain.on('open-url', (event, url) => shell.openExternal(url));

  // 下载更新包
  ipcMain.handle('download-update', async (event, downloadUrl) => {
    const downloadsDir = app.getPath('downloads');
    const fileName = '壹准AI微信营销助手_Setup.exe';
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
  await killConflictingBackend();
  startBackend();
  const ready = await waitForBackendReady(expectedBackendPath);
  if (!ready) {
    console.error('[Yizhun] Backend did not become ready in time');
  } else {
    console.log('[Yizhun] Backend ready, channel=', runtimeMeta.channel, 'version=', runtimeMeta.version);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async (event) => {
  if (backendProcess && !backendProcess.killed) {
    event.preventDefault();
    await shutdownBackend();
    app.quit();
  }
});
