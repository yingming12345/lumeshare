// 应用设置：读写 userData/settings.json，提供默认值解析
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  // 缩略图缓存
  thumbCacheDir: null, // null = 默认 <userData>/thumb-cache
  thumbCacheLimitMB: 300, // 0 = 不限制
  // 局域网分享
  shareStorageDir: null, // null = 默认 <userData>/share（分享上传文件的保存目录）
  // 屏幕直播（直播与观看双方都需要开启）
  liveEnabled: false, // 是否开启屏幕直播功能
  livePreset: 'hd', // hd = 1080P 高清 | smooth = 720P 流畅
  liveLastHost: '', // 上次观看使用的主播地址
  // 启动行为
  autoScanOnStart: false, // 启动时自动扫描上次盘符
  autoStartShare: false, // 下次打开应用时是否默认开启局域网分享
  launchAtStartup: false, // 开机自启动
  // 背景音乐（默认关闭；开启后自动下载到本地并后台循环播放，无界面）
  bgmEnabled: false,
  // 性能
  gridImageQuality: 'thumb', // thumb = 缩略图（低配推荐）| original = 原图
  defaultVideoPlayer: 'builtin', // builtin = 内置播放器 | system = 系统默认播放器
  compatMode: false, // 兼容模式：禁用硬件加速（低配置电脑，重启后生效）
  // 关闭软件行为：true = 关闭后最小化到托盘（隐藏图标区）
  closeToTray: false,
  // 更新检测
  updateCode: null, // 已确认版本的下载链接验证码（验证码变化 = 有新版本）
  updateDismissedCode: null, // 用户取消过的版本验证码（自动检测时不再打扰）
  // 内部状态
  lastDrive: null,
  lastLogUploadAt: 0, // 上次日志上报时间（避免频繁重复上报）
};

let settingsFile = null;
let cache = null;

function filePath() {
  if (!settingsFile) settingsFile = path.join(app.getPath('userData'), 'settings.json');
  return settingsFile;
}

// 查找第一个可写的非系统盘（默认缓存应存放在系统盘以外的盘）
function findNonSystemDrive() {
  if (process.platform !== 'win32') return null;
  const sysLetter = (process.env.SystemDrive || 'C:').replace(/[\\/:]/g, '').toUpperCase();
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    if (letter === sysLetter) continue;
    const root = letter + ':\\';
    try {
      fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
      return root;
    } catch {
      /* 该盘不可用 */
    }
  }
  return null;
}

// 默认缓存目录：优先使用非系统盘（如 D:\LumeShareCache），其次回退到应用数据目录
function defaultCacheDir() {
  const drive = findNonSystemDrive();
  if (drive) return path.join(drive, 'LumeShareCache', 'thumb-cache');
  return path.join(app.getPath('userData'), 'thumb-cache');
}

function load() {
  if (cache) return cache;
  cache = Object.assign({}, DEFAULTS);
  try {
    const saved = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    for (const k of Object.keys(DEFAULTS)) {
      if (saved[k] !== undefined) cache[k] = saved[k];
    }
  } catch {
    /* 首次运行或无配置文件 */
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.error('[settings] 保存失败:', e.message);
  }
}

function get() {
  return load();
}

function getResolved() {
  const s = load();
  return Object.assign({}, s, {
    thumbCacheDir: s.thumbCacheDir ? s.thumbCacheDir : defaultCacheDir(),
  });
}

function set(patch) {
  const s = load();
  for (const k of Object.keys(patch)) {
    if (k in DEFAULTS) s[k] = patch[k];
  }
  save();
  return getResolved();
}

function reset() {
  cache = Object.assign({}, DEFAULTS);
  save();
  return getResolved();
}

module.exports = { get, getResolved, set, reset, defaultCacheDir, DEFAULTS };
