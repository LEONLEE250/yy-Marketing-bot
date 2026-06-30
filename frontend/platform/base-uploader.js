// ── 基类：平台上传器 ──
const { chromium } = require('patchright');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { antiDetectScript } = require('./anti-detect.js');

/** 常见浏览器安装路径（供搜索用） */
function getStandardBrowserPaths() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const progFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const progFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

  return {
    chrome: [
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(progFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(progFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    msedge: [
      path.join(progFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(progFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
  };
}

/** 用 where 命令查找浏览器（覆盖非标准安装路径） */
function findByWhere(command) {
  try {
    const result = execSync(`where ${command}`, { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const lines = result.trim().split('\r\n').filter(Boolean);
    for (const line of lines) {
      const exe = line.trim();
      if (exe.toLowerCase().endsWith('.exe') && fs.existsSync(exe)) return exe;
    }
  } catch (_) {}
  return null;
}

/** 搜索所有已知 Chrome / Edge 安装位置 */
function findInstalledBrowsers() {
  const std = getStandardBrowserPaths();
  const found = { chrome: null, msedge: null };

  for (const p of std.chrome) {
    if (fs.existsSync(p)) { found.chrome = p; break; }
  }
  for (const p of std.msedge) {
    if (fs.existsSync(p)) { found.msedge = p; break; }
  }

  // where 命令兜底（可找到非标准路径，如绿色版、企业安装目录等）
  if (!found.chrome) found.chrome = findByWhere('chrome');
  if (!found.msedge) found.msedge = findByWhere('msedge');

  return found;
}

/** 检测可用浏览器（仅供前端显示用） */
function detectBrowserChannel() {
  const found = findInstalledBrowsers();
  if (found.msedge) return 'msedge';
  if (found.chrome) return 'chrome';
  return 'chrome'; // 默认返回 chrome，后续会报缺浏览器
}

/**
 * 查找浏览器，实际安装优先：
 * - 主方案：channel（已安装的浏览器，Patchright 注册表解析）
 * - 兜底：可执行文件路径，channel 失败时逐条尝试
 * - 32位系统 → 优先 Edge（CDP 协议不兼容旧 Chrome）
 * - 64位系统 → 优先 Chrome
 * - 如果优先浏览器未安装，自动换另一个浏览器
 *
 * @returns {{ channel: string, fallbackExes: string[] }}
 */
function findBrowserPath() {
  const is64Bit = process.arch === 'x64' || process.env.PROCESSOR_ARCHITECTURE === 'AMD64' ||
    process.env.PROCESSOR_ARCHITEW6432 === 'AMD64';

  const found = findInstalledBrowsers();
  let primary = is64Bit ? 'chrome' : 'msedge';
  let secondary = is64Bit ? 'msedge' : 'chrome';

  // 如果优先浏览器未安装，自动切换到另一个
  if (!found[primary] && found[secondary]) {
    console.log(`[Browser] ${primary} 未安装，切换到 ${secondary}`);
    [primary, secondary] = [secondary, primary];
  }

  // fallbackExes: 主浏览器 + 次浏览器（按优先级排序）
  const fallbackExes = [];
  if (found[primary]) fallbackExes.push(found[primary]);
  if (found[secondary]) fallbackExes.push(found[secondary]);

  console.log(`[Browser] arch=${process.arch}, primary=${primary}, secondary=${secondary}, found=${JSON.stringify(found)}`);

  return { channel: primary, fallbackExes };
}

/**
 * 通用浏览器启动回退封装
 * @param {{ channel: string, fallbackExes: string[] }} browserPath
 * @param {(opts: {channel?: string, executablePath?: string}) => Promise<any>} launchFn
 * @param {Function|null} logFn
 */
async function launchBrowserWithFallback(browserPath, launchFn, logFn = null) {
  const browserName = browserPath.channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome';

  // ── 方案 1：channel（Patchright 注册表解析）──
  try {
    logFn?.(`🌐 尝试 channel: ${browserName}`);
    console.log(`[Browser] try channel: ${browserPath.channel}`);
    return await launchFn({ channel: browserPath.channel });
  } catch (e1) {
    logFn?.(`⚠️ channel 方式失败: ${e1.message}`);
    console.error('[Browser] channel failed:', e1.message);
  }

  // ── 方案 2：逐条 executablePath 兜底 ──
  const fallbackExes = browserPath.fallbackExes || [];
  const existing = fallbackExes.filter(e => fs.existsSync(e));
  logFn?.(`🔄 channel 失败，尝试 ${existing.length} 个本地路径`);
  for (const exe of fallbackExes) {
    if (!fs.existsSync(exe)) continue;
    try {
      logFn?.(`🔄 尝试 executablePath: ${exe}`);
      console.log(`[Browser] try executablePath: ${exe}`);
      return await launchFn({ executablePath: exe });
    } catch (e2) {
      logFn?.(`⚠️ executablePath 也失败 (${path.basename(exe)}): ${e2.message}`);
      console.error('[Browser] fallback exe failed:', exe, e2.message);
    }
  }

  throw new Error(
    `无法启动浏览器。已尝试 channel (${browserName}) 和 ${existing.length} 个本地路径，均失败。\n` +
    `请确认已安装 ${browserName}（Edge / Chrome 均可）。`
  );
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
   * 复用模块级 launchBrowserWithFallback
   */
  async _tryLaunch(launchFn, browserName) {
    return await launchBrowserWithFallback(this._browserPath, (opts) => {
      this.log?.(`🌐 尝试启动 ${browserName}`);
      return launchFn(opts);
    }, (msg) => this.log?.(msg));
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

module.exports = { BasePlatformUploader, detectBrowserChannel, findBrowserPath, launchBrowserWithFallback };
