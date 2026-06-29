// ── Cookie 管理：登录 + 校验 ──
const { chromium } = require('patchright');
const path = require('path');
const fs = require('fs');
const { antiDetectScript } = require('./anti-detect.js');
const { detectBrowserChannel } = require('./base-uploader.js');

// ── Cookie 校验（用系统浏览器 + channel）──

async function checkDouyinCookie(cookiePath) {
  if (!fs.existsSync(cookiePath)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
    const hasSession = raw.cookies && raw.cookies.some(c => c.name && (c.name.includes('sessionid') || c.name.includes('passport')));
    if (!hasSession) return false;
  } catch { return false; }

  let browser = null;
  const channel = detectBrowserChannel();
  try {
    browser = await chromium.launch({
      headless: false,
      channel,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });
    const context = await browser.newContext({ storageState: cookiePath });
    await context.addInitScript(antiDetectScript);
    const page = await context.newPage();
    await page.goto('https://creator.douyin.com/creator-micro/content/upload', {
      waitUntil: 'domcontentloaded', timeout: 90000
    });
    try {
      await page.waitForURL('**/creator-micro/**', { timeout: 15000 });
    } catch { return false; }
    const hasLoginForm = await page.getByText('手机号登录').count() ||
                         await page.getByText('扫码登录').count();
    return !hasLoginForm;
  } catch (e) {
    console.error('[CookieManager] 校验失败:', e.message);
    return false;
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

// ── 抖音扫码登录（持久化 profile 确保同一设备）──

async function loginDouyin(cookiePath, cookieDir, accountName, onQRCode) {
  let context = null;
  const channel = detectBrowserChannel();
  const userDataDir = path.join(cookieDir, 'profiles', accountName || 'default');
  try {
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    // 持久化 context — 替代 chromium.launch + user-data-dir args
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      permissions: ['geolocation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
    });
    await context.addInitScript(antiDetectScript);
    const page = await context.newPage();
    await page.goto('https://creator.douyin.com/', { waitUntil: 'domcontentloaded' });

    // 等待扫码登录 Tab
    const scanTab = page.getByText('扫码登录', { exact: true }).first();
    await scanTab.waitFor({ timeout: 30000 });

    // 提取二维码
    let qrcodeImg = scanTab.locator('..')
      .locator('xpath=following-sibling::div[1]')
      .locator('img[aria-label="二维码"]').first();
    if (!(await qrcodeImg.count())) {
      qrcodeImg = page.getByRole('img', { name: '二维码' }).first();
    }
    await qrcodeImg.waitFor({ state: 'visible', timeout: 30000 });
    const qrcodeSrc = await qrcodeImg.getAttribute('src');

    if (onQRCode && qrcodeSrc) onQRCode(qrcodeSrc);

    // 轮询等待登录完成（最多 5 分钟）
    for (let i = 0; i < 100; i++) {
      if (page.url().includes('creator.douyin.com/creator-micro')) {
        const stillHasLogin = await page.getByText('扫码登录', { exact: true }).first().count();
        if (!stillHasLogin) {
          await new Promise(r => setTimeout(r, 2000));
          await context.storageState({ path: cookiePath });
          return { success: true, message: '抖音扫码登录成功' };
        }
      }

      // 二维码失效处理
      const expired = page.getByText('二维码失效', { exact: true }).first();
      if (await expired.count() && await expired.isVisible()) {
        await expired.locator('..').first().click();
        await new Promise(r => setTimeout(r, 1000));
        const newQr = page.getByRole('img', { name: '二维码' }).first();
        await newQr.waitFor({ state: 'visible', timeout: 10000 });
        const newSrc = await newQr.getAttribute('src');
        if (onQRCode && newSrc) onQRCode(newSrc);
      }

      await new Promise(r => setTimeout(r, 3000));
    }

    return { success: false, message: '等待扫码登录超时' };
  } catch (e) {
    return { success: false, message: `登录失败: ${e.message}` };
  } finally {
    if (context) {
      try {
        const browser = context.browser;
        await context.close();
        if (browser) await browser.close();
      } catch {}
    }
  }
}

module.exports = { checkDouyinCookie, loginDouyin };
