const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const os = require('os');

let mainWindow;
let backendProcess;

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

function pingBackend(expectedBackendPath = '') {
  return new Promise((resolve) => {
    const req = require('http').get('http://127.0.0.1:5679/api/health', (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          const ok = res.statusCode === 200 && data.status === 'ok';
          const sameBackend = !expectedBackendPath || !data.backend_path || data.backend_path === expectedBackendPath;
          resolve(ok && sameBackend);
        } catch (_) {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForBackendReady(expectedBackendPath = '', maxAttempts = 15) {
  for (let i = 0; i < maxAttempts; i += 1) {
    if (await pingBackend(expectedBackendPath)) return true;
    await wait(800);
  }
  return false;
}

function getExpectedBackendPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backend', 'backend.exe')
    : '';
}

function killConflictingBackend(expectedBackendPath) {
  // 启动时无差别清除端口 5679 上所有监听进程，不比较路径
  // 因为上一轮退出残留的 backend 必须全部清理，否则新实例无法绑定端口
  const script = [
    '$conns = @()',
    'try { $conns = Get-NetTCPConnection -LocalPort 5679 -State Listen -ErrorAction Stop } catch {}',
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
      const req = http.request('http://127.0.0.1:5679/api/shutdown', {
        method: 'POST',
        timeout: 2000,
      }, () => resolve());
      req.on('error', () => resolve());
      req.end();
    });
    await wait(800);
  } catch (_) {}

  // Step 2: Node 进程 kill（Windows 上等效 TerminateProcess）
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

  // 文件选择
  ipcMain.handle('select-image', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'webp'] }]
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
    // 实际复制文件
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

    // 通知前端开始下载
    mainWindow.webContents.send('download-progress', { status: 'downloading', progress: 0 });

    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);

      function handleResponse(response) {
        // 处理重定向
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
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '更新下载完成',
            message: '安装包已下载到下载文件夹',
            detail: '是否立即安装更新？（安装过程中软件将关闭）',
            buttons: ['稍后安装', '立即安装'],
            defaultId: 1,
          }).then(async (result) => {
            if (result.response === 1) {
              shell.openPath(filePath);
              await shutdownBackend();
              setTimeout(() => app.quit(), 500);
            }
            resolve({ success: true, filePath });
          });
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
}

app.whenReady().then(async () => {
  const expectedBackendPath = getExpectedBackendPath();
  await killConflictingBackend(expectedBackendPath);
  startBackend();
  const ready = await waitForBackendReady(expectedBackendPath);
  if (!ready) {
    console.error('Backend did not become ready in time or is occupied by another instance');
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
    app.quit(); // 二次 quit，此时 backendProcess.killed 为 true，直接退出
  }
});
