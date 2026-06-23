// ═══════════════════════════════════════════════════════════
// ai-service.js — AI 服务层（main 进程，直调 AI API）
// 支持：OpenAI 兼容 LLM、Agnes/DALL-E 生图、Agnes 生视频
// ═══════════════════════════════════════════════════════════

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ── 工具：清理 API 地址（去末尾斜杠 + 去掉误填的端点路径）──
function cleanBaseUrl(apiUrl) {
  let u = (apiUrl || '').replace(/\/+$/, '');
  // 去掉用户可能误填的常见端点后缀
  u = u.replace(/\/chat\/completions$/, '').replace(/\/images\/generations$/, '').replace(/\/videos$/, '');
  return u;
}

// ── 工具：POST JSON（支持 AbortSignal 中断）──
function postJSON(apiUrl, headers, body, timeout = 30000, signal = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(apiUrl);
    const proto = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = proto.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
      timeout,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, data: buf, error: 'InvalidJSON' }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (signal) {
      signal.addEventListener('abort', () => { req.destroy(); reject(new Error('aborted')); }, { once: true });
      if (signal.aborted) { req.destroy(); reject(new Error('aborted')); return; }
    }
    req.write(data);
    req.end();
  });
}

// ── 工具：GET JSON ─────────────────────────────────────
function getJSON(apiUrl, headers, timeout = 15000, signal = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(apiUrl);
    const proto = u.protocol === 'https:' ? https : http;
    const req = proto.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'GET',
      headers,
      timeout,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, data: buf, error: 'InvalidJSON' }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (signal) {
      signal.addEventListener('abort', () => { req.destroy(); reject(new Error('aborted')); }, { once: true });
      if (signal.aborted) { req.destroy(); reject(new Error('aborted')); return; }
    }
    req.end();
  });
}

// ── 工具：下载文件到临时目录 ─────────────────────────────
function downloadToTemp(url, tmpDir, prefix = '') {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const proto = u.protocol === 'https:' ? https : http;
    const ext = path.extname(u.pathname).split('?')[0] || '.png';
    const fname = `${prefix}${Date.now()}${ext}`;
    const fpath = path.join(tmpDir, fname);
    const file = fs.createWriteStream(fpath);

    const req = proto.get(url, { headers: { 'User-Agent': 'YizhunApp/2.0' }, timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadToTemp(res.headers.location, tmpDir, prefix).then(resolve, reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(fpath); });
      file.on('error', (e) => { try { fs.unlinkSync(fpath); } catch (_) {} reject(e); });
    });
    req.on('error', (e) => { try { fs.unlinkSync(fpath); } catch (_) {} reject(e); });
    req.on('timeout', () => { req.destroy(); try { fs.unlinkSync(fpath); } catch (_) {} reject(new Error('download timeout')); });
  });
}

// ── 工具：联网搜索（DuckDuckGo 免费 API）──
async function webSearch(query, maxResults = 5) {
  const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  try {
    const resp = await getJSON(apiUrl, {}, 8000);
    if (resp.status !== 200) return [];
    const d = resp.data;
    const results = [];
    if (d.AbstractText) results.push({ title: d.Heading || '', snippet: d.AbstractText, url: d.AbstractURL || '' });
    if (Array.isArray(d.RelatedTopics)) {
      for (const t of d.RelatedTopics) {
        if (t.Text && results.length < maxResults) results.push({ title: '', snippet: t.Text, url: t.FirstURL || '' });
      }
    }
    return results;
  } catch (_) { return []; }
}

// ═══════════════════════════════════════════════════════
//  LLM 对话（OpenAI 兼容 Chat Completions API）
// ═══════════════════════════════════════════════════════
async function chatCompletion(config, messages, signal = null) {
  const apiUrl = cleanBaseUrl(config.api_url || 'https://api.openai.com/v1') + '/chat/completions';
  const resp = await postJSON(apiUrl, {
    'Authorization': `Bearer ${config.api_key}`,
  }, {
    model: config.model || 'gpt-4o-mini',
    messages,
    max_tokens: 1500,
    temperature: 0.8,
  }, 90000, signal);

  if (resp.status !== 200) {
    const msg = resp.data?.error?.message || `服务返回 HTTP ${resp.status}`;
    return { success: false, error: msg };
  }
  const content = resp.data?.choices?.[0]?.message?.content?.trim() || '';
  return { success: true, content };
}

// ═══════════════════════════════════════════════════════
//  图片生成
// ═══════════════════════════════════════════════════════
async function generateImage(config, prompt, options = {}, signal = null) {
  // 自动检测提供商：model 含 dall-e 或 api_url 含 openai → DALL-E；否则 Agnes
  const isDalle = (config.model || '').toLowerCase().includes('dall') || (config.api_url || '').includes('openai');

  let apiUrl, body;
  if (isDalle) {
    apiUrl = cleanBaseUrl(config.api_url || 'https://api.openai.com/v1') + '/images/generations';
    body = {
      model: config.model || 'dall-e-3',
      prompt,
      n: options.n || 1,
      size: options.size || '1024x1024',
      response_format: 'url',
    };
  } else {
    // Agnes Image
    const hasRef = !!options.reference_image_base64;
    // 有参考图 → 自动切 2.0-flash（图生图），用 extra_body 格式
    const model = hasRef ? 'agnes-image-2.0-flash' : (config.model || 'agnes-image-2.1-flash');
    apiUrl = cleanBaseUrl(config.api_url || 'https://apihub.agnes-ai.com/v1') + '/images/generations';
    body = {
      model,
      prompt,
      size: options.size || '1024x1024',
    };
    if (hasRef) {
      body.extra_body = {
        tags: ['img2img'],
        image: [options.reference_image_base64],
        response_format: 'url',
      };
    }
  }

  const resp = await postJSON(apiUrl, {
    'Authorization': `Bearer ${config.api_key}`,
  }, body, 120000, signal);

  if (resp.status !== 200) {
    const msg = resp.data?.error?.message || `生图服务返回 HTTP ${resp.status}`;
    return { success: false, error: msg };
  }

  const imageData = resp.data?.data || [];
  if (imageData.length === 0) {
    return { success: false, error: '生图服务未返回图片' };
  }

  return { success: true, images: imageData };
}

// ═══════════════════════════════════════════════════════
//  视频生成 — 创建任务
// ═══════════════════════════════════════════════════════
async function createVideoTask(config, prompt, options = {}, signal = null) {
  const apiUrl = cleanBaseUrl(config.api_url || 'https://apihub.agnes-ai.com/v1') + '/videos';
  const fps = 24;

  // Agnes Video 要求 num_frames = 8n+1 且 ≤ 441
  function frameCount(seconds) {
    const raw = Math.round(seconds * fps);
    const n = Math.round((raw - 1) / 8);
    const f = 8 * n + 1;
    return Math.max(9, Math.min(441, f));  // 至少 9 帧
  }

  const duration = options.duration || 5;
  const body = {
    model: config.model || 'agnes-video-v2.0',
    prompt,
    width: options.width || 1152,
    height: options.height || 768,
    num_frames: frameCount(duration),
    frame_rate: fps,
  };

  if (options.reference_image_base64) {
    body.image = options.reference_image_base64;
  }

  const resp = await postJSON(apiUrl, {
    'Authorization': `Bearer ${config.api_key}`,
  }, body, 30000, signal);

  if (resp.status !== 200 && resp.status !== 201) {
    const msg = resp.data?.error?.message || `生视频服务返回 HTTP ${resp.status}`;
    return { success: false, error: msg };
  }
  return { success: true, task_id: resp.data?.task_id };
}

// ═══════════════════════════════════════════════════════
//  视频生成 — 轮询任务状态
// ═══════════════════════════════════════════════════════
async function pollVideoTask(config, taskId, signal = null) {
  const apiUrl = cleanBaseUrl(config.api_url || 'https://apihub.agnes-ai.com/v1') + `/videos/${taskId}`;
  const resp = await getJSON(apiUrl, {
    'Authorization': `Bearer ${config.api_key}`,
  }, 15000, signal);

  if (resp.status !== 200) {
    const msg = resp.data?.error?.message || `查询视频任务返回 HTTP ${resp.status}`;
    return { success: false, status: 'error', error: msg };
  }
  const d = resp.data;
  return {
    success: true,
    status: d.status, // pending / processing / completed / failed
    video_url: d.video_url || d.remixed_from_video_id,
    error: d.error,
  };
}

module.exports = {
  postJSON,
  getJSON,
  downloadToTemp,
  webSearch,
  chatCompletion,
  generateImage,
  createVideoTask,
  pollVideoTask,
};
