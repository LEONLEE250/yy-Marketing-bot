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
 * - 只用 channel，让 Patchright 通过注册表自行解析浏览器路径 + 版本兼容性校验
 * - 不再使用 executablePath（32位 Chrome v128 的 CDP 协议不兼容 Patchright 1.61+，
 *   executablePath 会绕过兼容性检查导致启动失败）
 * - 32位系统 → Edge（唯一保持更新的 Chromium 浏览器）
 * - 64位系统 → Chrome 优先，如果 Patchright 找不到 Chrome 会自然回退
 *
 * @returns {{ channel: string }}
 */
function findBrowserPath() {
  const is64Bit = process.arch === 'x64' || process.env.PROCESSOR_ARCHITECTURE === 'AMD64' ||
    process.env.PROCESSOR_ARCHITEW6432 === 'AMD64';

  // 只用 channel，让 Patchright 通过 Windows 注册表解析（支持 WoW64 重定向）
  // social-auto-upload 就是只用 channel，不做 executablePath 搜索
  const channel = is64Bit ? 'chrome' : 'msedge';
  console.log(`[Browser] arch=${process.arch}, is64Bit=${is64Bit}, channel=${channel}`);
  return { channel };
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

  /** 启动浏览器（patchright + channel 解析 + 持久化 Profile） */
  async launchBrowser({ headless = false } = {}) {
    const browserName = this._browserPath.channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome';
    this.log?.(`🌐 使用 ${browserName}（Patchright channel 解析）`);

    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }

    // 使用 launchPersistentContext 替代 args/--user-data-dir
    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      headless,
      ...this._browserPath,  // 展开 executablePath 或 channel
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
    });
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
