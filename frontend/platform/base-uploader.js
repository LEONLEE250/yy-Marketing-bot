// ── 基类：平台上传器 ──
const { chromium } = require('patchright');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { antiDetectScript } = require('./anti-detect.js');

/** 写日志到临时文件（打包后 console.log 看不到） */
function _browserLog(msg) {
  const logFile = path.join(require('os').tmpdir(), 'yizhun-browser.log');
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(logFile, line); } catch (_) {}
  console.log(line.trim());
}

/** 标准路径 + 注册表 + where + PowerShell 全搜索浏览器 */
function findBrowserPath() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const progFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const progFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

  const paths = {
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

  // 1. 标准路径
  let found = { chrome: null, msedge: null };
  for (const p of paths.chrome) if (fs.existsSync(p)) { found.chrome = p; break; }
  for (const p of paths.msedge) if (fs.existsSync(p)) { found.msedge = p; break; }
  _browserLog(`[findBrowserPath] 标准路径: chrome=${found.chrome}, msedge=${found.msedge}`);

  // 2. 注册表
  if (!found.msedge) {
    try {
      const r = execSync(`reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe" /ve`, { encoding: 'utf8', timeout: 3000, windowsHide: true });
      const m = r.match(/REG_SZ\s+(.*\.exe)/i);
      if (m && fs.existsSync(m[1].trim())) { found.msedge = m[1].trim(); _browserLog(`[findBrowserPath] 注册表找到 Edge: ${found.msedge}`); }
    } catch (_) { _browserLog('[findBrowserPath] 注册表 Edge 未找到'); }
  }
  if (!found.chrome) {
    try {
      const r = execSync(`reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve`, { encoding: 'utf8', timeout: 3000, windowsHide: true });
      const m = r.match(/REG_SZ\s+(.*\.exe)/i);
      if (m && fs.existsSync(m[1].trim())) { found.chrome = m[1].trim(); _browserLog(`[findBrowserPath] 注册表找到 Chrome: ${found.chrome}`); }
    } catch (_) { _browserLog('[findBrowserPath] 注册表 Chrome 未找到'); }
  }

  // 3. where 命令（搜索 PATH 环境变量）
  if (!found.msedge) {
    try {
      const r = execSync('chcp 65001>nul && where msedge', { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const p = r.trim().split(/\r?\n/).filter(Boolean)[0];
      if (p && fs.existsSync(p)) { found.msedge = p; _browserLog(`[findBrowserPath] where 找到 Edge: ${p}`); }
    } catch (_) { _browserLog('[findBrowserPath] where 未找到 Edge'); }
  }
  if (!found.chrome) {
    try {
      const r = execSync('chcp 65001>nul && where chrome', { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const p = r.trim().split(/\r?\n/).filter(Boolean)[0];
      if (p && fs.existsSync(p)) { found.chrome = p; _browserLog(`[findBrowserPath] where 找到 Chrome: ${p}`); }
    } catch (_) { _browserLog('[findBrowserPath] where 未找到 Chrome'); }
  }

  // 4. PowerShell 全盘搜索（C:\，不是只搜 C:\Users）
  if (!found.msedge) {
    try {
      _browserLog('[findBrowserPath] PowerShell 全盘搜索 Edge...');
      const ps = `Get-ChildItem -Path 'C:\\' -Filter 'msedge.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 FullName | ForEach-Object { $_.FullName }`;
      const r = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', timeout: 15000, windowsHide: true });
      const p = r.trim().split(/\r?\n/).filter(Boolean)[0];
      if (p && fs.existsSync(p)) { found.msedge = p; _browserLog(`[findBrowserPath] PowerShell 找到 Edge: ${p}`); }
      else { _browserLog('[findBrowserPath] PowerShell 未找到 Edge'); }
    } catch (e) { _browserLog(`[findBrowserPath] PowerShell 搜索 Edge 失败: ${e.message}`); }
  }
  if (!found.chrome) {
    try {
      _browserLog('[findBrowserPath] PowerShell 全盘搜索 Chrome...');
      const ps = `Get-ChildItem -Path 'C:\\' -Filter 'chrome.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 FullName | ForEach-Object { $_.FullName }`;
      const r = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', timeout: 15000, windowsHide: true });
      const p = r.trim().split(/\r?\n/).filter(Boolean)[0];
      if (p && fs.existsSync(p)) { found.chrome = p; _browserLog(`[findBrowserPath] PowerShell 找到 Chrome: ${p}`); }
      else { _browserLog('[findBrowserPath] PowerShell 未找到 Chrome'); }
    } catch (e) { _browserLog(`[findBrowserPath] PowerShell 搜索 Chrome 失败: ${e.message}`); }
  }

  // 返回结果（同时保留 chrome/msedge 路径，供不同平台自行选择）
  if (found.msedge) {
    _browserLog(`[findBrowserPath] 最终: channel=msedge, path=${found.msedge}, chrome=${found.chrome}`);
    return { channel: 'msedge', executablePath: found.msedge, edgePath: found.msedge, chromePath: found.chrome };
  }
  if (found.chrome) {
    _browserLog(`[findBrowserPath] 最终: channel=chrome, path=${found.chrome}`);
    return { channel: 'chrome', executablePath: found.chrome, edgePath: null, chromePath: found.chrome };
  }
  _browserLog('[findBrowserPath] 最终: 未找到任何浏览器');
  return { channel: 'chrome', edgePath: null, chromePath: null };
}

/** 检测可用浏览器（仅供显示） */
function detectBrowserChannel() {
  const bp = findBrowserPath();
  return bp.channel;
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
    this.browserChannel = browserChannel || detectBrowserChannel();
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

  /** 启动浏览器（patchright + system Edge/Chrome + 持久化 Profile） */
  async launchBrowser({ headless = false } = {}) {
    const channel = this.browserChannel;
    this.log?.(`🌐 使用 ${channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome'}（patchright + 持久化 Profile）`);

    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }

    // 使用 launchPersistentContext 替代 args/--user-data-dir
    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      headless,
      channel,
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
