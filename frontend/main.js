const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const os = require('os');

let mainWindow;
let backendProcess;

function startBackend() {
  const isPackaged = app.isPackaged;
  let cmd, args;

  if (isPackaged) {
    // 打包后：resources/backend/backend.exe
    cmd = path.join(process.resourcesPath, 'backend', 'backend.exe');
    args = [];
  } else {
    // 开发模式：用 python 启动 app.py
    cmd = 'python';
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
      https.get(downloadUrl, (response) => {
        // 处理重定向
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          fs.unlinkSync(filePath);
          https.get(response.headers.location, (redirectRes) => {
            downloadFile(redirectRes, file, filePath, resolve, reject);
          }).on('error', reject);
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
          // 弹窗询问是否安装
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '更新下载完成',
            message: '安装包已下载到下载文件夹',
            detail: '是否立即安装更新？（安装过程中软件将关闭）',
            buttons: ['稍后安装', '立即安装'],
            defaultId: 1,
          }).then((result) => {
            if (result.response === 1) {
              shell.openPath(filePath);
              // 延迟关闭，让安装程序启动
              setTimeout(() => {
                if (backendProcess) backendProcess.kill();
                app.quit();
              }, 1000);
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
      }).on('error', (err) => {
        file.close();
        try { fs.unlinkSync(filePath); } catch (e) {}
        mainWindow.webContents.send('download-progress', { status: 'error', error: err.message });
        reject(err);
      });
    });
  });
}

app.whenReady().then(() => {
  startBackend();
  // 等后端启动
  setTimeout(createWindow, 2000);
});

app.on('window-all-closed', () => {
  if (backendProcess) backendProcess.kill();
  app.quit();
});

app.on('before-quit', () => {
  if (backendProcess) backendProcess.kill();
});
