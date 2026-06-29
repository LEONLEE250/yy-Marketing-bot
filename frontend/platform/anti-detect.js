// ── 综合反检测脚本 ──
// 注入到 Playwright 页面中，覆盖所有已知的自动化检测点
// 基于 playwright-stealth 核心逻辑 + 抖音特定场景优化
// ⚠️ 重要：不要覆盖 navigator.userAgent / Function.prototype.toString
//    这些会导致白屏（无限递归 / 破坏 JS 框架检测）
const antiDetectScript = `
// ============================================================
// 1. 隐藏 webdriver 标志（最关键的检测点）
// ============================================================
Object.defineProperty(navigator, 'webdriver', { get: () => false });

// ============================================================
// 2. 完整的 chrome 对象（很多检测会遍历属性）
// ============================================================
window.chrome = {
  runtime: {
    onMessage: { addListener: function() {} },
    onConnect: { addListener: function() {} },
    onInstalled: { addListener: function() {} },
    sendMessage: function() {},
    connect: function() {},
    getManifest: function() { return {}; },
    getURL: function(p) { return p; },
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  loadTimes: function() { return {}; },
  csi: function() { return {}; },
  app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
  webstore: { onInstallStageChanged: {}, onDownloadProgress: {} },
  runtimeOnConnect: {},
  runtimeOnMessage: {},
};
// 深度填充 chrome.runtime 的属性
if (window.chrome && window.chrome.runtime) {
  const cr = window.chrome.runtime;
  ['onMessage', 'onConnect', 'onInstalled', 'onSuspend', 'onSuspendCanceled', 'onUpdateAvailable', 'onBrowserUpdateAvailable'].forEach(function(ev) {
    if (!cr[ev]) cr[ev] = { addListener: function() {}, removeListener: function() {}, hasListeners: function() {} };
  });
}

// ============================================================
// 3. 覆盖 permissions API（防止检测"自动化"权限）
// ============================================================
const originalQuery = window.navigator.permissions.query;
window.navigator.permissions.query = function(params) {
  if (params && params.name) {
    const blocked = ['notifications', 'clipboard-read', 'clipboard-write', 'geolocation', 'camera', 'microphone'];
    if (blocked.includes(params.name)) {
      return Promise.resolve({ state: 'granted', onchange: null });
    }
  }
  return originalQuery(params);
};

// ============================================================
// 4. plugins 数组（真实浏览器有5+插件）
// ============================================================
Object.defineProperty(navigator, 'plugins', {
  get: function() {
    const arr = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ];
    arr.item = function(i) { return this[i]; };
    arr.namedItem = function(n) { return this.find(function(p) { return p.name === n; }); };
    arr.refresh = function() {};
    return arr;
  }
});

// ============================================================
// 5. languages（中文环境）
// ============================================================
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' });

// ============================================================
// 6. WebGL vendor/renderer 覆盖
// ============================================================
try {
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Intel Inc.';
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter(param);
  };
  // 同样覆盖 WebGL2
  const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
  if (getParameter2) {
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter2(param);
    };
  }
} catch(e) {}

// ============================================================
// 7. 覆盖 navigator.hardwareConcurrency（CPU核心数）
// ============================================================
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

// ============================================================
// 8. 覆盖 navigator.deviceMemory（设备内存）
// ============================================================
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

// ============================================================
// 9. 覆盖屏幕属性
// ============================================================
Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

// ============================================================
// 10. 覆盖 MediaCodec（检测是否支持硬件解码）
// ============================================================
try {
  const origCreate = MediaSource.prototype.isTypeSupported;
  if (origCreate) {
    MediaSource.isTypeSupported = function(type) { return true; };
  }
} catch(e) {}

// ============================================================
// 11. 覆盖 Battery API（防止 unique fingerprint）
// ============================================================
try {
  if (navigator.getBattery) {
    navigator.getBattery = function() {
      return Promise.resolve({
        charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1,
        onchargingchange: null, onchargingtimechange: null, ondischargingtimechange: null, onlevelchange: null,
      });
    };
  }
} catch(e) {}

// ============================================================
// 12. 覆盖 iframe 检测（部分检测通过创建 iframe 判断）
// ============================================================
try {
  const origCreateElement = document.createElement.bind(document);
  document.createElement = function(tagName, options) {
    const el = origCreateElement(tagName, options);
    if (tagName && tagName.toLowerCase() === 'iframe') {
      Object.defineProperty(el, 'contentWindow', {
        get: function() { return window; },
        configurable: true,
      });
    }
    return el;
  };
} catch(e) {}

// ============================================================
// 13. 覆盖 navigator.connection（网络类型）
// ============================================================
try {
  if (navigator.connection) {
    Object.defineProperty(navigator.connection, 'type', { get: () => 'wifi' });
    Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
    Object.defineProperty(navigator.connection, 'downlink', { get: () => 10 });
    Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
  }
} catch(e) {}
`;

// ── 模拟人类行为的工具函数（在 uploader 中使用）──
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

async function humanLikeWait(pageOrMs) {
  if (typeof pageOrMs === 'number') {
    return new Promise(r => setTimeout(r, pageOrMs));
  }
  // 随机等待 1-3 秒，模拟人阅读/思考
  await pageOrMs.waitForTimeout(randomDelay(1000, 3000));
}

module.exports = { antiDetectScript, randomDelay, humanLikeWait };
