const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

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
    return result.canceled ? null : result.filePath;
  });

  // 打开外部链接
  ipcMain.on('open-url', (event, url) => shell.openExternal(url));
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
