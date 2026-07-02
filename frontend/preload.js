const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// 直接读取 config.json（与 Flask backend 同一个文件），零 IPC 延迟
// 在 DOMContentLoaded 之前注入 window.__aiImageConfig
var __aiImageConfig = { ai_image: {}, ai_video: {} };
try {
  var cfgPath = path.join(process.env.APPDATA || '', 'yizhun-wechat-bot-preview', 'config.json');
  if (fs.existsSync(cfgPath)) {
    var cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    __aiImageConfig = {
      ai_image: cfg.ai_image || {},
      ai_video: cfg.ai_video || {},
    };
  }
} catch (_) {}

contextBridge.exposeInMainWorld('__aiImageConfig', __aiImageConfig);

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
  deleteScript: (id) => ipcRenderer.invoke('delete-script', id),
  updateScript: (id, data) => ipcRenderer.invoke('update-script', { id, ...data }),
  addScript: (data) => ipcRenderer.invoke('add-script', data),
  getScripts: () => ipcRenderer.invoke('get-scripts'),
  getFileSize: (path) => ipcRenderer.invoke('get-file-size', path),
  getThumbnail: (path, maxWidth) => ipcRenderer.invoke('get-thumbnail', path, maxWidth),
  compressImage: (path) => ipcRenderer.invoke('compress-image', path),

  // ── AI 创意中心 ──
  aiChat: (data) => ipcRenderer.invoke('ai-chat', data),
  aiGenerateImage: (data) => ipcRenderer.invoke('ai-generate-image', data),
  aiCreateVideoTask: (data) => ipcRenderer.invoke('ai-create-video-task', data),
  aiPollVideoTask: (data) => ipcRenderer.invoke('ai-poll-video-task', data),
  aiAbort: () => ipcRenderer.invoke('ai-abort'),
  aiGetConfig: () => ipcRenderer.invoke('ai-get-config'),
  aiSaveConfig: (data) => ipcRenderer.invoke('ai-save-config', data),
  selectReferenceImage: () => ipcRenderer.invoke('select-reference-image'),
  selectFile: (types) => ipcRenderer.invoke('select-file', types),
  selectFiles: (types) => ipcRenderer.invoke('select-files', types),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  openGuide: () => ipcRenderer.invoke('open-guide'),

  dbList: () => ipcRenderer.invoke('db-list'),
  dbGetPath: () => ipcRenderer.invoke('db-get-path'),
  dbSetPath: (dir) => ipcRenderer.invoke('db-set-path', dir),
  dbAdd: (item) => ipcRenderer.invoke('db-add', item),
  dbUpdate: (data) => ipcRenderer.invoke('db-update', data),
  dbDelete: (id) => ipcRenderer.invoke('db-delete', id),
  dbSearch: (data) => ipcRenderer.invoke('db-search', data),

  // ── 多平台分发 ──
  platformInit: () => ipcRenderer.invoke('platform:init'),
  platformCheckDouyin: (data) => ipcRenderer.invoke('platform:check-douyin', data),
  platformCheckDouyinQuick: (data) => ipcRenderer.invoke('platform:check-douyin-quick', data),
  platformLoginDouyin: (data) => ipcRenderer.invoke('platform:login-douyin', data),
  platformPublishDouyin: (data) => ipcRenderer.invoke('platform:publish-douyin', data),
  platformCancelPublish: () => ipcRenderer.invoke('platform:cancel-publish'),
  platformCheckFile: (data) => ipcRenderer.invoke('platform:check-file', data),
  platformLogout: (data) => ipcRenderer.invoke('platform:logout', data),
  platformGetBrowser: () => ipcRenderer.invoke('platform:get-browser'),
  platformListAccounts: () => ipcRenderer.invoke('platform:list-accounts'),
  platformAddAccount: (data) => ipcRenderer.invoke('platform:add-account', data),
  // 视频号
  platformListShipinhaoAccounts: () => ipcRenderer.invoke('platform:list-shipinhao-accounts'),
  platformCheckShipinhaoQuick: (data) => ipcRenderer.invoke('platform:check-shipinhao-quick', data),
  platformCheckShipinhao: (data) => ipcRenderer.invoke('platform:check-shipinhao', data),
  platformLoginShipinhao: (data) => ipcRenderer.invoke('platform:login-shipinhao', data),
  platformPublishShipinhao: (data) => ipcRenderer.invoke('platform:publish-shipinhao', data),
  onPlatformQRCode: (callback) => ipcRenderer.on('platform:qrcode', (event, data) => callback(data)),
  onPlatformLog: (callback) => ipcRenderer.on('platform:log', (event, data) => callback(data)),
});
