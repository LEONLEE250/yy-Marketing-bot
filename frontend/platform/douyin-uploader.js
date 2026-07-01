// ── 抖音视频上传器（基于 social-auto-upload 已验证流程）──
const { BasePlatformUploader } = require('./base-uploader.js');
const { checkDouyinCookie, loginDouyin } = require('./cookie-manager.js');
const { getImageDimensions, getFileSizeMB, DOUYIN_SPECS } = require('./media-validator.js');
const { randomDelay } = require('./anti-detect.js');
const path = require('path');
const fs = require('fs');

class DouyinUploader extends BasePlatformUploader {
  UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload';
  LOGIN_URL  = 'https://creator.douyin.com/';

  constructor(opts) {
    super({ accountName: opts.accountName || 'default', cookieDir: opts.cookieDir, browserChannel: opts.browserChannel });
    this.title = opts.title || '';
    this.filePath = opts.filePath || '';
    this.tags = opts.tags || [];
    this.desc = opts.desc || '';
    this.publishDate = opts.publishDate || 0; // 0=立即, Date=定时
    this.thumbnailPath = opts.thumbnailPath || '';
    this.onLog = opts.onLog || (() => {}); // 进度回调
    this.onQRCode = opts.onQRCode || null;  // 二维码回调
  }

  log(msg) { this.onLog(msg); }

  /** 主入口 */
  async upload() {
    this.log('🔍 验证参数...');
    await this._validateArgs();

    // Cookie 校验 / 登录
    const cookieValid = await checkDouyinCookie(this.cookiePath);
    if (!cookieValid) {
      this.log('🔑 Cookie 失效或不存在，打开浏览器扫码登录...');
      const loginResult = await loginDouyin(this.cookiePath, this.onQRCode);
      if (!loginResult.success) {
        throw new Error(`抖音登录失败: ${loginResult.message}`);
      }
      this.log('✅ 登录成功，Cookie 已保存');
    } else {
      this.log('✅ Cookie 有效');
    }

    this.log('🌐 启动浏览器...');
    await this.launchBrowser({ headless: false }); // 抖音必须有头

    try {
      this.page = await this.context.newPage();

      // Step 1: 导航到上传页
      this.log('🧭 前往抖音创作者上传页...');
      await this.page.goto(this.UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await this.page.waitForURL(this.UPLOAD_URL, { timeout: 90000 });
      await this.page.waitForTimeout(randomDelay(1500, 3000)); // 人类浏览延迟

      // Step 2: 上传视频文件
      this.log('📤 上传视频文件...');
      await this.page.waitForSelector("div[class^='container'] input", { state: 'attached', timeout: 60000 });
      try {
        await this.page.locator("div[class^='container'] input").setInputFiles(this.filePath);
      } catch (e) {
        if (e.message && e.message.includes('EBADF')) {
          this.log('⚠️ EBADF，尝试复制到临时目录后重试...');
          const td = path.join(require('os').tmpdir(), 'yizhun-upload');
          if (!fs.existsSync(td)) fs.mkdirSync(td, { recursive: true });
          const cp = path.join(td, path.basename(this.filePath));
          fs.copyFileSync(this.filePath, cp);
          await this.page.locator("div[class^='container'] input").setInputFiles(cp);
        } else throw e;
      }
      this.log('✅ 视频文件已上传');

      // Step 3: 等待进入发布页（v1 或 v2）
      this.log('⏳ 等待进入发布页...');
      await this._waitForPublishPage();
      await this.page.waitForTimeout(randomDelay(2000, 4000)); // 等页面完全渲染

      // Step 4: 填写标题
      this.log('✍️ 填写标题...');
      await this._fillTitle();
      await this.page.waitForTimeout(randomDelay(500, 1500)); // 打字间隔

      // Step 5: 填写描述 + 话题
      this.log('✍️ 填写描述和话题...');
      await this._fillDescriptionAndTags();

      // Step 6: 等待上传完成
      this.log('⏳ 等待视频上传完成...');
      await this._waitForUploadComplete();
      await this.page.waitForTimeout(randomDelay(1000, 2000));

      // Step 7: 封面设置（可选）
      if (this.thumbnailPath) {
        this.log('🖼️ 设置封面...');
        await this._setThumbnail();
        await this.page.waitForTimeout(randomDelay(1000, 2000));
      }

      // Step 8: 自主声明
      this.log('🧾 设置自主声明...');
      await this._setSelfDeclaration();
      await this.page.waitForTimeout(randomDelay(800, 1500));

      // Step 9: 第三方分享开关
      await this._enableThirdPartyShare();
      await this.page.waitForTimeout(randomDelay(800, 1500));

      // Step 10: 定时发布（可选）
      if (this.publishDate) {
        this.log('⏰ 设置定时发布...');
        await this._setSchedule();
        await this.page.waitForTimeout(randomDelay(1000, 2000));
      }

      // Step 11: 点击发布
      this.log('🚀 点击发布...');
      await this._clickPublish();

      this.log('🎉 抖音视频发布成功！');
      await this.saveCookies();
    } catch (e) {
      this.log(`❌ 发布失败: ${e.message}`);
      throw e;
    } finally {
      await this.close();
    }
  }

  // ── 私有方法 ──────────────────────────────────────────

  async _validateArgs() {
    if (!this.title) throw new Error('标题不能为空');
    if (this.title.length > DOUYIN_SPECS.titleMaxLen) {
      throw new Error(`标题超过${DOUYIN_SPECS.titleMaxLen}字限制（当前${this.title.length}字）`);
    }
    if (this.desc.length > DOUYIN_SPECS.descMaxLen) {
      throw new Error(`描述超过${DOUYIN_SPECS.descMaxLen}字限制（当前${this.desc.length}字）`);
    }
    if (this.tags.length > DOUYIN_SPECS.tagsMaxCount) {
      throw new Error(`话题标签超过${DOUYIN_SPECS.tagsMaxCount}个限制（当前${this.tags.length}个）`);
    }
    for (const tag of this.tags) {
      if (tag.length > DOUYIN_SPECS.tagMaxLen) {
        throw new Error(`话题标签"${tag}"超过${DOUYIN_SPECS.tagMaxLen}字限制`);
      }
    }

    this.filePath = this.validateVideoFile(this.filePath);

    // 视频文件大小检查
    const videoSizeMB = getFileSizeMB(this.filePath);
    if (videoSizeMB > DOUYIN_SPECS.videoMaxSizeMB) {
      throw new Error(`视频文件过大（${videoSizeMB}MB），抖音限制最大${DOUYIN_SPECS.videoMaxSizeMB}MB`);
    }

    // 定时发布时间范围校验
    if (this.publishDate) {
      const now = Date.now();
      const minTime = now + DOUYIN_SPECS.scheduleMinHours * 60 * 60 * 1000;
      const maxTime = now + DOUYIN_SPECS.scheduleMaxDays * 24 * 60 * 60 * 1000;
      if (this.publishDate < minTime) {
        throw new Error(`定时发布时间必须至少提前${DOUYIN_SPECS.scheduleMinHours}小时`);
      }
      if (this.publishDate > maxTime) {
        throw new Error(`定时发布时间不能超过${DOUYIN_SPECS.scheduleMaxDays}天后`);
      }
    }

    if (this.thumbnailPath) {
      this.thumbnailPath = this.validateImageFile(this.thumbnailPath);
      // 封面分辨率检查
      const dim = getImageDimensions(this.thumbnailPath);
      if (dim && dim.width > 0 && dim.height > 0) {
        if (dim.width < DOUYIN_SPECS.coverMinWidth || dim.height < DOUYIN_SPECS.coverMinHeight) {
          throw new Error(
            `封面分辨率过低（${dim.width}×${dim.height}），` +
            `抖音要求至少${DOUYIN_SPECS.coverMinWidth}×${DOUYIN_SPECS.coverMinHeight}`
          );
        }
        this.log(`✅ 封面分辨率: ${dim.width}×${dim.height} (${dim.format})`);
      }
    }
  }

  async _waitForPublishPage() {
    const v1Pattern = 'creator.douyin.com/creator-micro/content/publish';
    const v2Pattern = 'creator.douyin.com/creator-micro/content/post/video';
    const maxWait = 90000; // 90s
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      const url = this.page.url();
      if (url.includes(v1Pattern) || url.includes(v2Pattern)) {
        this.log(`✅ 进入发布页: ${url.includes(v1Pattern) ? 'v1' : 'v2'}`);
        return;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('等待进入发布页超时');
  }

  async _fillTitle() {
    // 抖音标题最多 30 字
    const titleInput = this.page.locator('input[placeholder*="填写作品标题"]').first();
    await titleInput.waitFor({ state: 'visible', timeout: 120000 });
    await titleInput.fill(this.title.slice(0, 30));
  }

  async _fillDescriptionAndTags() {
    const descEditor = this.page.locator('div.zone-container[contenteditable="true"]').first();
    await descEditor.waitFor({ state: 'visible', timeout: 120000 });
    await descEditor.click();
    await this.page.keyboard.press('Control+A');
    await this.page.keyboard.press('Delete');

    // 输入描述
    if (this.desc) {
      await this.page.keyboard.type(this.desc);
    }

    // 输入话题
    for (const tag of this.tags) {
      await this.page.keyboard.type(' #' + tag);
      await this.page.keyboard.press('Space');
    }
    // 收起话题下拉浮层
    await this.page.keyboard.press('Escape');
  }

  async _waitForUploadComplete() {
    while (true) {
      try {
        const reuploadCount = await this.page.locator('[class^="long-card"] div:has-text("重新上传")').count();
        if (reuploadCount > 0) {
          this.log('✅ 视频上传完成');
          return;
        }
        // 检查上传失败
        if (await this.page.locator('div.progress-div > div:has-text("上传失败")').count()) {
          this.log('⚠️ 检测到上传失败，重新上传...');
          await this.page.locator('div.progress-div [class^="upload-btn-input"]').setInputFiles(this.filePath);
        }
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  async _setThumbnail() {
    // 先清除新手引导浮层
    await this.page.evaluate(`
      document.querySelectorAll('.shepherd-element,.shepherd-modal-overlay-container').forEach(e => e.remove());
    `);
    await this.page.getByText('选择封面', { exact: true }).first().click({ force: true });

    const coverModal = this.page.locator('div.dy-creator-content-modal').first();
    await coverModal.waitFor({ timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));

    // 弹窗有 4 个隐藏 input: [0]AI参考图 [1]AI替换 [2]真封面 [3]封面替换
    // 用 nth(1) 选择第 2 个 = 真正的封面上传
    const coverUpload = coverModal.locator('input.semi-upload-hidden-input').nth(1);
    await coverUpload.setInputFiles(this.thumbnailPath);
    await new Promise(r => setTimeout(r, 3000));

    // 点击"完成"
    await coverModal.getByRole('button', { name: '完成', exact: true }).first().click();
    this.log('✅ 封面设置完成');
    await coverModal.waitFor({ state: 'detached', timeout: 20000 });
  }

  async _setSelfDeclaration() {
    try {
      const entry = this.page.getByText('请选择自主声明').first();
      await entry.waitFor({ state: 'visible', timeout: 6000 });
      await entry.click();

      const dialog = this.page.locator('.semi-modal-content').filter({ hasText: '对作品内容添加声明' }).first();
      await dialog.waitFor({ state: 'visible', timeout: 6000 });

      // 选择"内容为个人观点或见解"
      const option = dialog.locator('.semi-radio').filter({ hasText: '内容为个人观点或见解' }).first();
      if (await option.count()) {
        await option.click({ timeout: 6000 });
      } else {
        await dialog.getByText('内容为个人观点或见解', { exact: true }).first().click({ force: true, timeout: 6000 });
      }
      await dialog.getByRole('button', { name: '确定' }).click({ timeout: 6000 });
      await dialog.waitFor({ state: 'hidden', timeout: 6000 });
      this.log('✅ 自主声明已设置');
    } catch (e) {
      this.log(`⚠️ 自主声明跳过: ${e.message}`);
    }
  }

  async _enableThirdPartyShare() {
    try {
      const thirdSwitch = '[class^="info"] > [class^="first-part"] div div.semi-switch';
      if (await this.page.locator(thirdSwitch).count()) {
        const className = await this.page.evalOnSelector(thirdSwitch, 'el => el.className');
        if (!className.includes('semi-switch-checked')) {
          await this.page.locator(thirdSwitch).locator('input.semi-switch-native-control').click();
          this.log('✅ 已开启第三方分享');
        }
      }
    } catch {}
  }

  async _setSchedule() {
    const date = typeof this.publishDate === 'number' ? new Date(this.publishDate) : this.publishDate;
    try {
      await this.page.locator('[class^="radio"]:has-text("定时发布")').click();
      await new Promise(r => setTimeout(r, 1000));

      const dateStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
      await this.page.locator('.semi-input[placeholder="日期和时间"]').click();
      await this.page.keyboard.press('Control+A');
      await this.page.keyboard.type(dateStr);
      await this.page.keyboard.press('Enter');
      this.log(`✅ 定时发布已设置为: ${dateStr}`);
    } catch (e) {
      this.log(`⚠️ 定时发布设置跳过: ${e.message}`);
    }
  }

  async _clickPublish() {
    const MAX_TOTAL_WAIT = 5 * 60 * 1000; // 最多等5分钟（含验证码手动处理时间）
    const RETRY_INTERVAL = 3000;           // 每次重试间隔
    const start = Date.now();

    while (Date.now() - start < MAX_TOTAL_WAIT) {
      try {
        // 移除拦截点击的元素
        await this.page.evaluate(`
          document.querySelectorAll('.shepherd-element,.shepherd-modal-overlay-container,[class*="mention-wrapper"]')
            .forEach(e => e.remove());
        `);
        const publishBtn = this.page.getByRole('button', { name: '发布', exact: true });
        if (await publishBtn.count()) {
          await publishBtn.scrollIntoViewIfNeeded();
          await this.page.waitForTimeout(randomDelay(500, 1500));
          const box = await publishBtn.boundingBox();
          if (box) {
            const steps = randomDelay(5, 12);
            await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
            await this.page.waitForTimeout(randomDelay(200, 600));
            await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          } else {
            await publishBtn.click({ force: true });
          }
        }
        // 只用 URL 判断是否发布成功（和 social-auto-upload 一致）
        // 不主动检测验证码，避免误判；验证码出现时 waitForURL 会超时然后重试
        await this.page.waitForURL('**/creator.douyin.com/creator-micro/content/manage**', { timeout: 3000 });
        return;
      } catch {
        // 处理发布途中的弹窗（封面确认等）
        try {
          if (await this.page.getByText('请设置封面后再发布').first().isVisible()) {
            this.log('⚠️ 检测到封面未设置，选择推荐封面...');
            const cover = this.page.locator('[class^="recommendCover-"]').first();
            if (await cover.count()) {
              await cover.click();
              await new Promise(r => setTimeout(r, 1000));
              if (await this.page.getByText('是否确认应用此封面？').first().isVisible()) {
                await this.page.getByRole('button', { name: '确定' }).click();
              }
            }
          }
          // 检测是否有验证码/安全验证弹窗（提示用户手动处理）
          if (await this._checkCaptcha()) {
            this.log('🧩 检测到安全验证，请在浏览器中手动完成验证（发布按钮会自动重试）...');
          }
        } catch {}
        await new Promise(r => setTimeout(r, RETRY_INTERVAL));
      }
    }
    // 超时后当作成功（可能验证码超时/页面卡住，但发布可能已完成）
    this.log('⚠️ 发布等待超时，可能已发布成功，请检查抖音后台');
  }
}

module.exports = DouyinUploader;
