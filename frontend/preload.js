const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  selectImage: () => ipcRenderer.invoke('select-image'),
  saveFile: (path) => ipcRenderer.invoke('save-file', path),
  openURL: (url) => ipcRenderer.send('open-url', url),
  downloadUpdate: (url) => ipcRenderer.invoke('download-update', url),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, data) => callback(data)),
});
