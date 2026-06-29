// ── 文件元信息读取（零依赖）──
// 解析图片/视频的尺寸信息，无需任何第三方库
const fs = require('fs');

/** 读取图片宽高（支持 JPEG/PNG，零依赖） */
function getImageDimensions(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(48);
  fs.readSync(fd, buf, 0, 48, 0);
  fs.closeSync(fd);

  // PNG: 前 8 字节 signature, bytes 16-19 = width, 20-23 = height
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
  }

  // JPEG: 搜索 0xFF 0xC0 (SOF0) 标记，之后 5-6 字节 = height, 7-8 = width
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let offset = 2;
    const maxSearch = 65536; // JPEG 头通常很小
    const bigBuf = Buffer.alloc(Math.min(maxSearch, fs.statSync(filePath).size));
    // 如果之前读的 48 字节不够，重新读更多
    if (buf.length < maxSearch) {
      const bigBuf2 = Buffer.alloc(Math.min(65536, fs.statSync(filePath).size));
      fs.readSync(fd, bigBuf2, 0, bigBuf2.length, 0);
      fs.closeSync(fd);
      return _jpegFromBuffer(bigBuf2);
    }
    fs.closeSync(fd);
    return _jpegFromBuffer(buf);
  }

  // BMP: bytes 18-21 = width, 22-25 = height
  if (buf[0] === 0x42 && buf[1] === 0x4D) {
    return { width: buf.readUInt32LE(18), height: buf.readUInt32LE(22), format: 'bmp' };
  }

  // WEBP: bytes 26-29 = width+height (packed), 最简单不深解析
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    // VP8/VP8L/VP8X 格式不同，简化返回标记
    return { width: 0, height: 0, format: 'webp' };
  }

  fs.closeSync(fd);
  return null;
}

function _jpegFromBuffer(buf) {
  let offset = 2;
  while (offset < buf.length - 1) {
    if (buf[offset] === 0xFF && buf[offset + 1] === 0xC0) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height, format: 'jpeg' };
    }
    offset++;
  }
  return null;
}

/** 获取文件大小（MB） */
function getFileSizeMB(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return Math.round(stat.size / (1024 * 1024) * 100) / 100;
  } catch { return 0; }
}

// ── 抖音发布标准 ──

const DOUYIN_SPECS = {
  // 视频
  titleMaxLen: 30,           // 标题最多 30 字
  descMaxLen: 1000,          // 描述最多 1000 字
  videoMaxSizeMB: 4096,      // 最大 4GB
  videoMinWidth: 540,        // 最低宽度
  videoMinHeight: 960,       // 最低高度（竖屏）
  videoRecommendedFormat: ['mp4', 'mov', 'avi', 'mkv', 'm4v', 'webm', 'flv', 'wmv'],
  // 封面
  coverMinWidth: 720,        // 封面最低宽度
  coverMinHeight: 1280,      // 封面最低高度
  coverRecommendedFormat: ['jpg', 'jpeg', 'png', 'webp', 'bmp'],
  // 标签
  tagsMaxCount: 10,          // 最多 10 个话题
  tagMaxLen: 20,             // 每个话题最多 20 字
  // 定时发布
  scheduleMinHours: 2,       // 最少提前 2 小时
  scheduleMaxDays: 14,       // 最多提前 14 天
};

/** 抖音内容验证（前端用） */
const DOUYIN_RULES = {
  title: {
    required: true,
    maxLen: 30,
    message: '标题必填，最多30字',
  },
  video: {
    required: true,
    maxSizeMB: 4096,
    message: '请选择视频文件（MP4/MOV等，最大4GB）',
  },
  cover: {
    required: false,
    minWidth: 720,
    minHeight: 1280,
    message: '封面图建议≥720×1280，过低分辨率会被抖音拒绝',
  },
  tags: {
    maxCount: 10,
    maxTagLen: 20,
    message: '话题最多10个，每个最长20字',
  },
};

module.exports = {
  getImageDimensions,
  getFileSizeMB,
  DOUYIN_SPECS,
  DOUYIN_RULES,
};
