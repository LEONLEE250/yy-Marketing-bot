// ── 基类：平台上传器 ──
const { chromium } = require('patchright');
const path = require('path');
const fs = require('fs');
const { antiDetectScript } = require('./anti-detect.js');

/** 检测可用浏览器（仅供前端显示用） */
function detectBrowserChannel() {
  const edgePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of edgePaths) {
    if (fs.existsSync(p)) return 'msedge';
  }
  return 'chrome';
}

/**
 * 查找浏览器，架构自适应（对标 social-auto-upload 的 channel 方式）：
 * - 主方案：channel，让 Patchright 通过注册表自行解析（版本兼容性校验）
 * - 兜底方案：executablePath 列表，channel 失败时逐条尝试
 * - 32位系统 → Edge（唯一保持更新的 Chromium 浏览器）
 * - 64位系统 → Chrome 优先
 *
 * @returns {{ channel: string, fallbackExes: string[] }}
 */
function findBrowserPath() {
  const is64Bit = process.arch === 'x64' || process.env.PROCESSOR_ARCHITECTURE === 'AMD64' ||
    process.env.PROCESSOR_ARCHITEW6432 === 'AMD64';

  const channel = is64Bit ? 'chrome' : 'msedge';
  console.log(`[Browser] arch=${process.arch}, is64Bit=${is64Bit}, channel=${channel}`);

  // 兜底：常见浏览器安装路径（channel 失败后逐条尝试）
  const fallbackExes = [];
  const localAppData = process.env.LOCALAPPDATA || '';
  const progFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const progFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

  if (is64Bit) {
    // 64位：Chrome 优先
    fallbackExes.push(
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(progFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(progFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      // Edge 兜底
      path.join(progFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(progFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else {
    // 32位：Edge 优先
    fallbackExes.push(
      path.join(progFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      // Chrome 兜底
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(progFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    );
  }

  return { channel, fallbackExes };
}

class BasePlatformUploader {
  SUPPORTED_VIDEO = ['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.webm', '.flv', '.wmv'];
  SUPPORTED_IMAGE = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];

  constructor({ accountName, cookieDir, browserChannel }) {
    this.accountName = accountName || 'default';
    this.cookieDir = cookieDir;
    this.cookiePath = path.join(cookieDir, `${this.accountName}.json`);
    this.userDataDir = path.join(cookieDir, 'profiles', this.accountName);
    this.browser = null;
    this.context = null;
    this.page = null;
    // 只用 channel 让 Patchright 通过注册表解析（跨架构兼容）
    this.browserChannel = browserChannel || detectBrowserChannel();
    this._browserPath = findBrowserPath();
  }

  /** 文件格式+存在性验证 */
  validateVideoFile(filePath) {
    if (!filePath) throw new Error('视频文件路径不能为空');
    const p = path.resolve(filePath);
    if (!fs.existsSync(p)) throw new Error(`视频文件不存在: ${p}`);
    const ext = path.extname(p).toLowerCase();
    if (!this.SUPPORTED_VIDEO.includes(ext)) {
      throw new Error(`不支持的视频格式: ${ext}，支持: ${this.SUPPORTED_VIDEO.join(', ')}`);
    }
    return p;
  }

  validateImageFile(filePath) {
    if (!filePath) throw new Error('图片文件路径不能为空');
    const p = path.resolve(filePath);
    if (!fs.existsSync(p)) throw new Error(`图片文件不存在: ${p}`);
    const ext = path.extname(p).toLowerCase();
    if (!this.SUPPORTED_IMAGE.includes(ext)) {
      throw new Error(`不支持的图片格式: ${ext}，支持: ${this.SUPPORTED_IMAGE.join(', ')}`);
    }
    return p;
  }

  /** 
   * 启动浏览器（channel 优先 + executablePath 兜底）
   * channel 可能因 asar 打包环境、注册表差异等原因失败，自动回退到逐路径尝试
   */
  async _tryLaunch(launchFn, browserName) {
    // ── 方案 1：channel（主方案）──
    try {
      this.log?.(`🌐 尝试 channel: ${browserName}`);
      return await launchFn({ channel: this._browserPath.channel });
    } catch (e1) {
      this.log?.(`⚠️ channel 方式失败: ${e1.message}`);
      console.error('[Browser] channel failed:', e1.message);
    }

    // ── 方案 2：逐条尝试 executablePath 兜底 ──
    const fallbackExes = this._browserPath.fallbackExes || [];
    for (const exe of fallbackExes) {
      if (!fs.existsSync(exe)) continue;
      try {
        this.log?.(`🔄 尝试 executablePath: ${exe}`);
        return await launchFn({ executablePath: exe });
      } catch (e2) {
        this.log?.(`⚠️ executablePath 也失败 (${path.basename(exe)}): ${e2.message}`);
        console.error('[Browser] fallback exe failed:', exe, e2.message);
      }
    }

    throw new Error(
      `无法启动浏览器。已尝试 channel (${browserName}) 和 ${fallbackExes.filter(e => fs.existsSync(e)).length} 个本地路径，均失败。\n` +
      `请确认已安装 ${browserName}。`
    );
  }

  /** 启动浏览器（patchright + channel 解析 + 持久化 Profile） */
  async launchBrowser({ headless = false } = {}) {
    const browserName = this._browserPath.channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome';
    this.log?.(`🌐 启动 ${browserName}（channel 优先，exe 兜底）`);

    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }

    // 使用 _tryLaunch 包装，自动 channel→exe 回退
    const launchOptions = await this._tryLaunch(
      (extraOpts) => chromium.launchPersistentContext(this.userDataDir, {
        headless,
        ...extraOpts,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        permissions: ['geolocation'],
        args: [
          '--disable-blink-features=AutomationControlled',
          '--lang=zh-CN',
          '--start-maximized',
          '--no-sandbox',
          '--no-first-run',
          '--no-default-browser-check',
        ]
      }),
      browserName
    );
    this.context = launchOptions;
    // 持久化 context 自带 storage，额外加载 Cookie JSON 确保抖音登录态
    if (fs.existsSync(this.cookiePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(this.cookiePath, 'utf-8'));
        const { cookies = [] } = state;
        if (cookies.length > 0) {
          await this.context.addCookies(cookies);
        }
      } catch (e) {
        console.warn('[BaseUploader] 加载 Cookie 失败:', e.message);
      }
    }
    await this.context.addInitScript(antiDetectScript);
  }

  /** 保存 Cookie */
  async saveCookies() {
    try {
      const state = await this.context.storageState();
      const dir = path.dirname(this.cookiePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.cookiePath, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error('[BaseUploader] 保存Cookie失败:', e.message);
    }
  }

  /** 关闭浏览器（浏览器进程 + context 全部关闭，确保下一个账号不冲突） */
  async close() {
    try {
      if (this.page) await this.page.close();
      // launchPersistentContext 需要关闭上下文和浏览器进程
      if (this.context) {
        const browser = this.context.browser;  // BrowserContext.browser 属性
        await this.context.close();
        if (browser) await browser.close();
      }
    } catch (e) {
      console.error('[BaseUploader] 关闭浏览器失败:', e.message);
    }
  }
}

module.exports = { BasePlatformUploader, detectBrowserChannel, findBrowserPath };
