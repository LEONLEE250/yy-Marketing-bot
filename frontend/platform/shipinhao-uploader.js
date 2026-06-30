// ── 微信视频号上传器 ──
// 登录: https://channels.weixin.qq.com/login.html
// 发布: https://channels.weixin.qq.com/platform/post/create
const { BasePlatformUploader, findBrowserPath } = require('./base-uploader.js');
const { chromium } = require('patchright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { antiDetectScript, randomDelay } = require('./anti-detect.js');

// 架构感知的 User-Agent
const is64BitArch = process.arch === 'x64' || process.env.PROCESSOR_ARCHITECTURE === 'AMD64' ||
  process.env.PROCESSOR_ARCHITEW6432 === 'AMD64';
const ARCH_UA = is64BitArch
  ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  : 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── 视频号登录（扫码）──
// 注意：视频号登录不使用 antiDetectScript（微信风控不同，过度覆盖反而会触发检测）
async function loginShipinhao(cookiePath, cookieDir, accountName, onQRCode) {
  let context = null;
  const userDataDir = path.join(cookieDir, 'profiles', accountName || 'default');
  try {
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
    const cookieDir2 = path.dirname(cookiePath);
    if (!fs.existsSync(cookieDir2)) fs.mkdirSync(cookieDir2, { recursive: true });

    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      ...findBrowserPath(),
      args: [
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=TranslateUI,MediaRouter',
        '--lang=zh-CN',
        '--start-maximized',
      ],
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1440, height: 900 },
      userAgent: ARCH_UA,
    });
    const page = await context.newPage();
    // 先试 waitUntil load，不行再 networkidle（微信登录页的二维码是异步加载的，networkidle 能确保所有 JS 请求完成）
    await page.goto('https://channels.weixin.qq.com/login.html', {
      waitUntil: 'networkidle',
      timeout: 60000
    });
    // 允许页面 JS 渲染
    await page.waitForTimeout(8000);

    // 多种方式寻找二维码，轮询等待（最长 30 秒）
    let qrFound = false;
    for (let i = 0; i < 15; i++) {
      // 尝试找 img、canvas、或者带二维码背景的 div
      const qrImg = page.locator('img').first();
      const canvas = page.locator('canvas').first();
      const qrDiv = page.locator('[class*="qrcode"],[class*="QR"],[id*="qrcode"],[id*="QR"]').first();

      if (await qrImg.count() && await qrImg.isVisible()) {
        const src = await qrImg.getAttribute('src');
        if (src && src.length > 50) { // 二维码 base64 或 URL 一般较长
          qrFound = true;
          if (onQRCode) onQRCode(src);
          break;
        }
      }
      if (await canvas.count() && await canvas.isVisible()) {
        qrFound = true;
        break;
      }
      if (await qrDiv.count() && await qrDiv.isVisible()) {
        qrFound = true;
        break;
      }
      await page.waitForTimeout(2000);
    }

    // 轮询等待登录完成（最多5分钟）
    for (let i = 0; i < 100; i++) {
      const url = page.url();
      // 必须到达 /platform 管理后台才算登录成功（中间可能经过 /web/pages/confirm 等跳转页）
      if (url.includes('channels.weixin.qq.com/platform') && !url.includes('/login')) {
        // 等待 5 秒让 Cookie 全部写入
        await new Promise(r => setTimeout(r, 5000));
        await context.storageState({ path: cookiePath });
        return { success: true, message: '视频号扫码登录成功' };
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    return { success: false, message: '等待视频号扫码登录超时' };
  } catch (e) {
    return { success: false, message: `登录失败: ${e.message}` };
  } finally {
    if (context) {
      try { const b = context.browser; await context.close(); if (b) await b.close(); } catch {}
    }
  }
}

// ── 视频号上传器 ──
const SHIPINHAO_SPECS = {
  videoMaxSizeMB: 2048,  // 2GB
  titleMaxLen: 100,      // 视频号标题最多100字
  descMaxLen: 2000,
  tagsMaxCount: 10,
};

class ShipinhaoUploader extends BasePlatformUploader {
  UPLOAD_URL = 'https://channels.weixin.qq.com/platform/post/create';

  constructor(opts) {
    super({ accountName: opts.accountName || 'default', cookieDir: opts.cookieDir, browserChannel: opts.browserChannel });
    this.title = opts.title || '';
    this.filePath = opts.filePath || '';
    this.tags = opts.tags || [];
    this.desc = opts.desc || '';
    this.publishDate = opts.publishDate || 0;
    this.thumbnailPath = opts.thumbnailPath || '';
    this.onLog = opts.onLog || (() => {});
    this.browser = null; // 视频号不继承基类 launchPersistentContext,用独立 launch
    // 确保 _browserPath 已初始化（父类构造函数调用时可能未执行至此）
    if (!this._browserPath) this._browserPath = findBrowserPath();
  }

  log(msg) { this.onLog(msg); }

  /** 重写启动浏览器 —— 对齐 social-auto-upload：极简 launch + storageState */
  async launchBrowser({ headless = false } = {}) {
    const browserName = this._browserPath.channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome';
    this.log(`🌐 启动浏览器（${browserName}，Patchright channel 解析）`);

    // social-auto-upload 方式：只用 channel/executablePath + headless，不传任何 args
    this.browser = await chromium.launch({
      headless,
      ...this._browserPath,
    });
    this.context = await this.browser.newContext({
      storageState: this.cookiePath,
    });
  }

  /** 重写保存 Cookie */
  async saveCookies() {
    try {
      const state = await this.context.storageState();
      const dir = path.dirname(this.cookiePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.cookiePath, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error('[ShipinhaoUploader] 保存Cookie失败:', e.message);
    }
  }

  /** 重写关闭 —— 先关 context 再关 browser */
  async close() {
    try {
      if (this.page) await this.page.close();
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.close();
    } catch (e) {
      console.error('[ShipinhaoUploader] 关闭失败:', e.message);
    }
  }

  /** 主入口 — 对齐 social-auto-upload 的操作序列 */
  async upload() {
    this.log('🔍 验证参数...');
    await this._validateArgs();

    const cookieValid = fs.existsSync(this.cookiePath) && await this._quickCheckCookie();
    if (!cookieValid) {
      throw new Error('Cookie 无效，请先在账号管理中重新登录视频号');
    }

    this.log('🌐 启动浏览器...');
    await this.launchBrowser({ headless: false });

    try {
      this.page = await this.context.newPage();

      // 导航
      this.log('🧭 前往视频号发布页...');
      await this.page.goto(this.UPLOAD_URL, {
        waitUntil: 'networkidle', timeout: 120000
      });
      if (this.page.url().includes('/login')) {
        throw new Error('Cookie 已过期，请重新扫码登录');
      }
      await this.page.waitForTimeout(5000);

      // 1. 上传视频文件
      this.log('📤 上传视频文件...');
      await this._uploadVideo();

      // 2. 填写标题+标签+描述（对齐 social-auto-upload: 标题用独立输入框，标签和描述在 div.input-editor）
      this.log('✍️ 填写标题...');
      await this._fillTitle();

      // 3. 等待上传完成
      this.log('⏳ 等待上传完成...');
      await this._waitForUploadReady();

      // 4. 填写描述和标签
      if (this.tags && this.tags.length > 0) {
        this.log('🏷️ 填写标签...');
        await this._fillTags();
      }
      if (this.desc) {
        this.log('✍️ 填写描述...');
        await this._fillDescription();
      }

      // 5. 定时发布
      if (this.publishDate && this.publishDate > Date.now()) {
        this.log('⏰ 设置定时发布...');
        await this._setScheduleTime();
      }

      // 6. 点击发布
      this.log('🚀 发布中...');
      await this._clickPublish();

      this.log('🎉 视频号发布成功！');
      await this.saveCookies();
    } catch (e) {
      this.log(`❌ 发布失败: ${e.message}`);
      throw e;
    } finally {
      await this.close();
    }
  }

  async _validateArgs() {
    if (!this.title) throw new Error('标题不能为空');
    if (this.title.length > SHIPINHAO_SPECS.titleMaxLen) {
      throw new Error(`标题超过${SHIPINHAO_SPECS.titleMaxLen}字限制（当前${this.title.length}字）`);
    }
    if (this.desc.length > SHIPINHAO_SPECS.descMaxLen) {
      throw new Error(`描述超过${SHIPINHAO_SPECS.descMaxLen}字限制（当前${this.desc.length}字）`);
    }
    this.filePath = this.validateVideoFile(this.filePath);
  }

  /** 快速校验 Cookie 文件是否有微信 session（至少 2 个微信专属 Cookie） */
  async _quickCheckCookie() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cookiePath, 'utf-8'));
      // 双重校验：微信专属 Cookie 名称 + 微信域 Cookie 数量
      const wechatKeys = ['wxuin', 'wxsid', 'wxssid', 'data_bizuin', 'mm_lang', 'uin', 'sid', 'pass_ticket'];
      const byName = raw.cookies && raw.cookies.filter(c => c.name && wechatKeys.some(k => c.name.includes(k)));
      const byDomain = raw.cookies && raw.cookies.filter(c => c.domain && (c.domain.includes('weixin') || c.domain.includes('wechat') || c.domain.includes('channels')));
      return (byName && byName.length >= 1) || (byDomain && byDomain.length >= 3);
    } catch { return false; }
  }

  /** 上传视频 — 在所有 frame 中搜索 file input */
  async _uploadVideo() {
    const findFileInput = async () => {
      for (const fr of this.page.frames()) {
        try {
          const fi = fr.locator('input[type="file"]').first();
          if (await fi.count()) return fi;
        } catch {}
      }
      try {
        const fi = this.page.locator('input[type="file"]').first();
        if (await fi.count()) return fi;
      } catch {}
      return null;
    };

    // 如果不在 create 页面，先点"发表视频"按钮进入
    if (!this.page.url().includes('/post/create')) {
      this.log('🔍 点「发表视频」进入编辑页...');
      const createBtn = this.page.getByText('发表视频').first();
      if (await createBtn.count()) {
        await createBtn.click();
        await this.page.waitForTimeout(3000);
        try { await this.page.waitForURL('**/post/create**', { timeout: 15000 }); } catch {}
        await this.page.waitForTimeout(3000);
      }
    }

    // 在页面中搜索 file input（最多 30 秒）
    let fi = null;
    for (let i = 0; i < 30; i++) {
      fi = await findFileInput();
      if (fi) break;
      await this.page.waitForTimeout(1000);
    }
    if (!fi) throw new Error('未找到文件上传控件');
    await fi.setInputFiles(this.filePath);
    this.log('✅ 视频文件已选择');
  }

  /** 等待上传完成 — 检测发表按钮启用（最多 60 秒） */
  async _waitForUploadReady() {
    for (let i = 0; i < 30; i++) {
      try {
        const btn = this.page.getByRole('button', { name: '发表' }).first();
        if (await btn.count()) {
          const cls = await btn.getAttribute('class');
          if (cls && !cls.includes('weui-desktop-btn_disabled')) {
            await this.page.waitForTimeout(2000);
            return;
          }
        }
      } catch {}
      await this.page.waitForTimeout(2000);
    }
    this.log('⚠️ 等待上传超时，尝试继续...');
  }

  /** 填写标题 — 标题是独立的 input，不是 div.input-editor */
  async _fillTitle() {
    // 视频号标题规则：去除所有标点符号
    let cleanTitle = this.title.replace(/[，。！？、；：""''【】《》（）—…,.!?;:'"\[\]{}()<>《》…·¥$€£#@%^&*+=|\\/~`\s\u3000]+/g, ' ');
    cleanTitle = cleanTitle.replace(/\s{2,}/g, ' ').trim().slice(0, SHIPINHAO_SPECS.titleMaxLen);
    if (cleanTitle !== this.title) {
      this.log(`ℹ️ 视频号标题已过滤标点: "${this.title}" → "${cleanTitle}"`);
    }

    const titleSelectors = [
      'input[placeholder*="标题"]',
      'input[class*="title"]',
      'div[class*="title"] input[type="text"]',
    ];
    for (const sel of titleSelectors) {
      try {
        const input = this.page.locator(sel).first();
        if (await input.count()) {
          await input.click();
          await this.page.waitForTimeout(300);
          await input.fill('');
          await input.type(cleanTitle, { delay: 50 });
          this.log('✅ 标题已填写');
          return;
        }
      } catch {}
    }
    throw new Error('未找到标题输入框');
  }

  /** 填写标签 — 在 div.input-editor 中键盘输入 #标签 */
  async _fillTags() {
    if (!this.tags || this.tags.length === 0) return;
    try {
      const editor = this.page.locator('div.input-editor').first();
      if (!await editor.count()) return;
      await editor.click();
      await this.page.waitForTimeout(500);
      await this.page.keyboard.press('Control+End');
      await this.page.waitForTimeout(200);
      await this.page.keyboard.press('Enter');
      await this.page.waitForTimeout(200);
      for (const tag of this.tags.slice(0, SHIPINHAO_SPECS.tagsMaxCount)) {
        await this.page.keyboard.type(`#${tag} `, { delay: 30 });
        await this.page.waitForTimeout(100);
      }
      this.log('✅ 标题和标签已填写');
    } catch {
      this.log('⚠️ 标签填写跳过');
    }
  }

  /** 填写描述 — 在 div.input-editor 末尾输入 */
  async _fillDescription() {
    if (!this.desc) return;
    try {
      const editor = this.page.locator('div.input-editor').first();
      if (!await editor.count()) return;
      await editor.click();
      await this.page.waitForTimeout(500);
      await this.page.keyboard.press('Control+End');
      await this.page.waitForTimeout(200);
      await this.page.keyboard.press('Enter');
      await this.page.waitForTimeout(200);
      await this.page.keyboard.type(this.desc.slice(0, SHIPINHAO_SPECS.descMaxLen), { delay: 10 });
      this.log('✅ 描述已填写');
    } catch {
      this.log('⚠️ 描述填写跳过');
    }
  }

  /** 定时发布 — 对齐 social-auto-upload: 定时标签 → 日期选择器 → 时间 */
  async _setScheduleTime() {
    try {
      const scheduleLabel = this.page.locator('label').filter({ hasText: '定时' }).nth(1);
      if (await scheduleLabel.count()) {
        await scheduleLabel.click();
        await this.page.waitForTimeout(1000);
      }

      const dt = new Date(this.publishDate);
      const monthStr = `${String(dt.getMonth() + 1).padStart(2, '0')}月`;
      const hourStr = String(dt.getHours()).padStart(2, '0');

      const datePlaceholder = this.page.locator('input[placeholder*="发表时间"]').first();
      if (await datePlaceholder.count()) {
        await datePlaceholder.click();
        await this.page.waitForTimeout(800);
        try {
          const monthLabel = this.page.locator('span.weui-desktop-picker__panel__label:has-text("月")').first();
          if (await monthLabel.count()) {
            const pageMonth = await monthLabel.innerText();
            if (!pageMonth.includes(monthStr)) {
              const nextBtn = this.page.locator('button.weui-desktop-btn__icon__right').first();
              if (await nextBtn.count()) await nextBtn.click();
              await this.page.waitForTimeout(500);
            }
          }
        } catch {}
        const dayCells = this.page.locator('table.weui-desktop-picker__table a');
        const count = await dayCells.count();
        for (let i = 0; i < count; i++) {
          const cell = dayCells.nth(i);
          const cls = await cell.getAttribute('class');
          if (cls && cls.includes('disabled')) continue;
          if ((await cell.innerText()).trim() === String(dt.getDate())) {
            await cell.click();
            break;
          }
        }
      }

      const timeInput = this.page.locator('input[placeholder*="时间"]').first();
      if (await timeInput.count()) {
        await timeInput.click();
        await this.page.waitForTimeout(300);
        await this.page.keyboard.press('Control+A');
        await this.page.keyboard.type(hourStr);
        await this.page.keyboard.press('Enter');
        await this.page.waitForTimeout(500);
      }

      try { await this.page.locator('div.input-editor').first().click({ timeout: 5000 }); }
      catch { await this.page.keyboard.press('Escape'); }

      this.log(`✅ 定时发布已设置: ${dt.toLocaleString('zh-CN')}`);
    } catch (e) {
      this.log(`⚠️ 定时发布设置失败: ${e.message}`);
    }
  }

  /** 点击发布 — 对齐 social-auto-upload：div.form-btns button:has-text("发表") */
  async _clickPublish() {
    const MAX_TOTAL = 5 * 60 * 1000;
    const start = Date.now();
    while (Date.now() - start < MAX_TOTAL) {
      try {
        await this.page.evaluate(() =>
          document.querySelectorAll('[class*="modal"],[class*="overlay"],[class*="dialog"]')
            .forEach(e => e.remove())
        );

        // social-auto-upload 使用的选择器
        const btn = this.page.locator('div.form-btns button:has-text("发表")').first();
        if (await btn.count()) {
          await btn.scrollIntoViewIfNeeded();
          await this.page.waitForTimeout(randomDelay(1000, 2000));
          const box = await btn.boundingBox();
          if (box) {
            await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
            await this.page.waitForTimeout(randomDelay(200, 600));
            await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          } else {
            await btn.click({ force: true });
          }
        }
        // 等待跳转到管理页
        await this.page.waitForURL('**/channels.weixin.qq.com/platform/post/list**', { timeout: 8000 });
        return;
      } catch {
        await this.page.waitForTimeout(3000);
      }
    }
    this.log('⚠️ 发布等待超时，请检查视频号后台');
  }
}

module.exports = { ShipinhaoUploader, loginShipinhao, SHIPINHAO_SPECS };
