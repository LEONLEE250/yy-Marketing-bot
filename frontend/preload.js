const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  selectImage: () => ipcRenderer.invoke('select-image'),
  selectMultipleImages: () => ipcRenderer.invoke('select-multiple-images'),
  selectVideo: () => ipcRenderer.invoke('select-video'),
  saveFile: (path) => ipcRenderer.invoke('save-file', path),
  openURL: (url) => ipcRenderer.send('open-url', url),
  downloadUpdate: (url) => ipcRenderer.invoke('download-update', url),
  installUpdate: (filePath) => ipcRenderer.invoke('install-update', filePath),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, data) => callback(data)),
  getRuntimeMeta: () => ipcRenderer.invoke('get-runtime-meta'),
  restartBackend: () => ipcRenderer.invoke('restart-backend'),
  publishMoment: (data) => ipcRenderer.invoke('publish-moment', data),
});
