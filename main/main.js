// LumeShare 主进程入口
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, protocol } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { registerLumeProtocol, WEB_ROOT } = require('./protocol');
const { listDrives, scanRoot, summarize, sortFiles, CATEGORY_KEYS, CATEGORY_LABELS } = require('./scan');
const { get: getThumb, info: thumbInfo, clear: clearThumbs, trim: trimThumbs } = require('./thumb');
const settings = require('./settings');
const { ShareService, migrateStorageDir, cleanupMigrated, storageSummary, clearStorageDir } = require('./share');
const logger = require('./logger');
const logcrypto = require('../shared/logcrypto');
const endpoints = require('../shared/endpoints');
const updater = require('./updater');
const music = require('./music');
const trayCtrl = require('./tray');
const { LiveService, normalizeHost, parseLiveText, probeLive } = require('./live');
const { ScreenCapture } = require('./live-capture');

const START_TS = Date.now();
const APP_NAME = 'LumeShare';

// 兜底异常处理：记录日志而不是让进程直接退出（避免普通用户遇到偶发崩溃）
process.on('uncaughtException', (e) => {
  try {
    logger.error('app:uncaught', { error: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 600) });
  } catch {
    /* ignore */
  }
});
process.on('unhandledRejection', (reason) => {
  try {
    logger.error('app:unhandled-rejection', { error: String((reason && reason.message) || reason) });
  } catch {
    /* ignore */
  }
});
const APP_VERSION = app.getVersion();

// 兼容模式：低配置电脑禁用硬件加速（需在 ready 前生效）
try {
  if (settings.get().compatMode) {
    app.disableHardwareAcceleration();
  }
} catch {
  /* 首次运行等场景忽略 */
}

// ---------- 系统校验：仅 Windows 10 及以上才允许使用 ----------
function checkSystem() {
  if (process.platform !== 'win32') return true; // 非 Windows（开发调试）放行
  const m = /^(\d+)\.(\d+)/.exec(os.release());
  if (!m) return true;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return major >= 10; // 10.0 = Windows 10 / 11，低于 10 的系统（7 / 8 / 8.1）不支持
}

if (!checkSystem()) {
  try {
    dialog.showErrorBox(
      '系统版本过低',
      'LumeShare 需要 Windows 10 及以上系统才能运行。\n当前系统版本过低（Windows 7 / 8 / 8.1 已不再支持），无法使用本软件。'
    );
  } catch {
    /* ignore */
  }
  app.exit(1);
}

// lume 协议需在 ready 之前注册
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lume',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '..', 'build', 'icon.png');
}

let win = null;
let shareService = null;
let discoveryListener = null;

// ---------- 分享存储目录 ----------
// 默认位置 = 软件安装目录下的 share 子文件夹：
// 用户把软件装在哪个盘，分享文件就默认存在哪个盘（不再默认占 C 盘）。
function defaultShareDir() {
  if (app.isPackaged) return path.join(path.dirname(process.execPath), 'share');
  // 开发调试（未打包）时沿用应用数据目录，避免污染源码目录
  return path.join(app.getPath('userData'), 'share');
}

// 旧版本默认位置（%APPDATA%\<App>\share，位于 C 盘）
function legacyShareDir() {
  return path.join(app.getPath('userData'), 'share');
}

function shareStorageDir() {
  const custom = settings.get().shareStorageDir;
  return custom ? path.resolve(String(custom)) : defaultShareDir();
}

// 升级迁移：v1.4.3 之前默认把分享文件存在 %APPDATA% 下（通常在 C 盘）。
// 若旧默认位置仍有分享文件、且新默认位置（安装目录）还没有数据，则自动迁移过去，避免文件“消失”。
async function migrateLegacyShareDir() {
  try {
    const def = defaultShareDir();
    const legacy = legacyShareDir();
    if (legacy.toLowerCase() === def.toLowerCase()) return;
    if (!fs.existsSync(legacy)) return;
    const sum = storageSummary(legacy);
    if (!sum.fileCount) return; // 旧位置没有分享文件
    if (fs.existsSync(def) && storageSummary(def).fileCount) return; // 新位置已有数据，不打扰
    const mig = migrateStorageDir(legacy, def);
    if (!mig.ok) {
      logger.warn('share:legacy-migrate:fail', { errors: mig.errors });
      return;
    }
    cleanupMigrated(legacy, mig.moved);
    logger.info('share:legacy-migrate', { from: legacy, to: def, moved: mig.moved.length });
  } catch (e) {
    logger.warn('share:legacy-migrate:skip', { error: e.message });
  }
}

// 创建/复用分享服务实例（服务实例的存储目录取自当前设置）
function ensureShareService() {
  if (!shareService) {
    shareService = new ShareService({
      storageDir: shareStorageDir(),
      iconPath: iconPath(),
      appName: APP_NAME,
    });
    shareService.onServersChange = (list) => win?.webContents.send('share:servers', list);
    shareService.onUpload = (rec) => {
      win?.webContents.send('share:uploaded', rec);
      logger.info('share:upload', { name: rec.name, size: rec.size, code: rec.code });
    };
  }
  return shareService;
}

// ---------------- 屏幕直播 ----------------
let liveService = null;
let liveCapture = null;

function ensureLiveService() {
  if (!liveService) {
    liveService = new LiveService({
      pagePath: path.join(__dirname, '..', 'live-web', 'index.html'),
      sharedDir: path.join(__dirname, '..', 'shared'),
    });
    liveService.onViewers = (v) => {
      try {
        win?.webContents.send('live:viewers', v);
      } catch {
        /* ignore */
      }
    };
    // 有观众接入 / 离开时，采集端为该观众建立或结束独立编码会话（每路都从关键帧开始）
    liveService.onViewerStart = (viewerId, kind) => {
      try {
        ensureLiveCapture().startViewer(viewerId, kind);
      } catch {
        /* ignore */
      }
    };
    liveService.onViewerStop = (viewerId) => {
      try {
        ensureLiveCapture().stopViewer(viewerId);
      } catch {
        /* ignore */
      }
    };
  }
  return liveService;
}

function applyLiveProfile(detail) {
  if (!liveService || !liveService.session || !detail) return;
  const label = (() => {
    try {
      return liveCapture.configFor().label;
    } catch {
      return '';
    }
  })();
  liveService.session.profile = {
    label,
    width: detail.hdW || 0,
    height: detail.hdH || 0,
    sourceW: detail.sourceW || detail.width || 0,
    sourceH: detail.sourceH || detail.height || 0,
    mime: detail.mime || '',
  };
}

function ensureLiveCapture() {
  if (!liveCapture) {
    liveCapture = new ScreenCapture({
      onViewerFrame: (viewerId, type, buffer) => {
        if (liveService) liveService.pushViewerFrame(viewerId, type, buffer);
      },
      onReady: (detail) => {
        logger.info('live:capture-ready', detail || {});
        applyLiveProfile(detail);
      },
      onProfile: (p) => {
        applyLiveProfile(p);
      },
      onError: (e) => {
        try {
          win?.webContents.send('live:error', { message: e.message });
        } catch {
          /* ignore */
        }
        logger.warn('live:capture-error', { error: e.message });
      },
    });
  }
  return liveCapture;
}

async function stopLiveAll() {
  try {
    if (liveCapture) liveCapture.stop();
  } catch {
    /* ignore */
  }
  try {
    if (liveService) await liveService.stop();
  } catch {
    /* ignore */
  }
}

// 扫描状态
let activeScan = null; // { root, signal, cacheKey }
const scanCache = new Map(); // root -> { results, counts, sizes, scannedAt, sorted: {key: array} }

// ---------------- 窗口 ----------------
function createWindow(loadUrl, opts) {
  const { bindTray = false } = opts || {};
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: '#f4f6fb',
    icon: iconPath(),
    title: 'LumeShare',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      sandbox: false,
      spellcheck: false,
      // 正式版本关闭开发者工具，避免被用于窥探内部接口（安全加固）
      devTools: !app.isPackaged,
    },
  });

  win.loadURL(loadUrl || 'lume://app/index.html');
  win.once('ready-to-show', () => win.show());
  win.once('ready-to-show', () => logger.info('app:window-ready', { ms: Date.now() - START_TS }));

  // 安全加固：禁止打开新窗口 / 禁止跳转到外部地址，只允许应用自身的 lume:// 页面
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!String(url).startsWith('lume://app/')) {
      e.preventDefault();
      logger.warn('window:navigate-blocked', { url: String(url).slice(0, 120) });
    }
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  win.on('maximize', () => win.webContents.send('win:maximized-change', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized-change', false));

  // 关闭到托盘：开启后点关闭按钮 → 最小化到隐藏图标区（不退出）
  if (bindTray) {
    win.on('close', (e) => {
      if (!trayCtrl.isQuit() && settings.get().closeToTray) {
        e.preventDefault();
        win.hide();
      }
    });
    trayCtrl.bind(win);
  }

  win.on('closed', () => {
    win = null;
  });
}

// ---------------- IPC ----------------
function registerIpc() {
  // 窗口控制
  ipcMain.handle('win:minimize', () => win?.minimize());
  ipcMain.handle('win:maximize-toggle', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('win:close', () => win?.close());
  ipcMain.handle('win:is-maximized', () => (win ? win.isMaximized() : false));

  // 盘符
  ipcMain.handle('drives:list', () => listDrives());

  // 扫描
  ipcMain.handle('scan:start', async (_e, root) => {
    logger.info('scan:start', { drive: root });
    if (activeScan && activeScan.root === root) {
      return scanCache.get(root) ? summarize(scanCache.get(root).results) : { scanning: true };
    }
    if (activeScan) activeScan.signal.cancelled = true;
    const signal = { cancelled: false };
    activeScan = { root, signal };
    console.log('[scan:start] root=' + root);
    try {
      const results = await scanRoot(root, {
        signal,
        onProgress: (p) => win?.webContents.send('scan:progress', { ...p, root }),
      });
      if (signal.cancelled) {
        logger.info('scan:cancel', { drive: root });
        return { cancelled: true };
      }
      const sum = summarize(results);
      logger.info('scan:done', { drive: root, total: sum.total, counts: sum.counts });
      console.log('[scan:done] root=' + root + ' counts=' + JSON.stringify(sum.counts));
      const sorted = {};
      for (const key of CATEGORY_KEYS) {
        sorted[key] = { name: sortFiles(results[key], 'name', 'asc'), size: sortFiles(results[key], 'size', 'desc'), mtime: sortFiles(results[key], 'mtime', 'desc') };
      }
      // 构建名称小写索引，加速跨分类搜索
      const nameIndex = new Map(); // lowerName -> item
      for (const key of CATEGORY_KEYS) {
        for (const it of results[key]) {
          const low = it.name.toLowerCase();
          const arr = nameIndex.get(low);
          if (arr) arr.push(Object.assign({}, it, { cat: key }));
          else nameIndex.set(low, [Object.assign({}, it, { cat: key })]);
        }
      }
      scanCache.set(root, { results, sorted, nameIndex, scannedAt: Date.now() });
      return { ok: true, ...sum };
    } catch (e) {
      logger.error('scan:error', { drive: root, error: e.message });
      return { ok: false, error: e.message };
    } finally {
      if (activeScan && activeScan.signal === signal) activeScan = null;
    }
  });

  ipcMain.handle('scan:cancel', () => {
    if (activeScan) activeScan.signal.cancelled = true;
    return true;
  });

  ipcMain.handle('scan:data', (_e, payload) => {
    const { root, category, sort, order, offset, limit } = payload;
    const cached = scanCache.get(root);
    if (!cached) return { items: [], total: 0 };
    const list = cached.sorted[category]?.[sort || 'mtime'] || [];
    const items = list.slice(offset || 0, (offset || 0) + (limit || 200));
    return { items, total: list.length, scannedAt: cached.scannedAt };
  });

  ipcMain.handle('scan:summary', (_e, root) => {
    const cached = scanCache.get(root);
    return cached ? summarize(cached.results) : null;
  });

  // 文件库搜索：在已扫描缓存中跨分类按名称模糊搜索（不重新扫描磁盘）
  ipcMain.handle('scan:search', (_e, payload) => {
    const { root, query, limit } = payload || {};
    const cached = scanCache.get(root);
    if (!cached || !query) return { items: [], total: 0 };
    const q = String(query).trim().toLowerCase();
    if (!q) return { items: [], total: 0 };
    const cap = Math.min(Number(limit) || 500, 1000);
    const out = [];
    // 使用名称索引：先查完全匹配，再查包含匹配
    if (cached.nameIndex) {
      const exact = cached.nameIndex.get(q);
      if (exact) for (const it of exact) out.push(it);
      for (const [low, arr] of cached.nameIndex) {
        if (low.includes(q)) {
          for (const it of arr) {
            if (it.name.toLowerCase() !== q) out.push(it);
            if (out.length >= cap) break;
          }
        }
        if (out.length >= cap) break;
      }
    } else {
      // 无索引（旧缓存）时线性扫描兜底
      for (const key of CATEGORY_KEYS) {
        const arr = cached.results[key] || [];
        for (const it of arr) {
          if (it.name.toLowerCase().includes(q)) {
            out.push(Object.assign({}, it, { cat: key }));
            if (out.length >= cap) break;
          }
        }
        if (out.length >= cap) break;
      }
    }
    // 按修改时间倒序
    out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    logger.info('scan:search', { root, query: q, found: out.length });
    return { items: out, total: out.length };
  });

  // 缩略图
  ipcMain.handle('thumb:get', async (_e, filePath) => getThumb(filePath));

  // 设置
  ipcMain.handle('settings:get', () => {
    const s = settings.getResolved();
    return Object.assign({}, s, { systemRelease: os.release() });
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    const prev = settings.getResolved();
    const next = settings.set(patch || {});
    // 缓存目录变化：清空内存缓存
    if (next.thumbCacheDir !== prev.thumbCacheDir) {
      clearThumbs();
      trimThumbs();
    }
    // 开机自启
    if (patch && patch.launchAtStartup !== undefined) {
      try {
        app.setLoginItemSettings({ openAtLogin: !!patch.launchAtStartup, path: process.execPath });
      } catch (e) {
        console.error('[settings] 设置开机自启失败:', e.message);
      }
    }
    // 背景音乐：设置变更后立即生效（开启=下载并后台循环播放，关闭=停止）
    if (patch && patch.bgmEnabled !== undefined) {
      music.applySetting(!!patch.bgmEnabled).catch((e) => {
        logger.warn('music:apply-fail', { error: e.message });
      });
    }
    return next;
  });

  // 背景音乐状态（供设置页显示"播放中/正在下载"等）
  ipcMain.handle('music:status', () => music.status());

  ipcMain.handle('settings:cache-info', () => thumbInfo());
  ipcMain.handle('settings:clear-cache', () => {
    clearThumbs();
    return thumbInfo();
  });
  ipcMain.handle('settings:pick-cache-dir', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择缩略图缓存目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });
  ipcMain.handle('settings:reset-cache-dir', () => {
    clearThumbs();
    return settings.set({ thumbCacheDir: null }).thumbCacheDir;
  });

  // 日志
  ipcMain.handle('log:event', (_e, payload) => {
    logger.log(
      String(payload?.action || 'unknown'),
      payload?.detail || null,
      payload?.level || 'info'
    );
    return true;
  });

  ipcMain.handle('log:today-summary', () => logger.summary());

  // 下载日志：把本机操作日志按三级加密导出为 .lslog 文件保存到本地（不上传任何服务器）
  // 加密格式与旧版本完全一致，只能由管理员客户端解密查看
  ipcMain.handle('log:download', async () => {
    const entries = logger.readAll();
    const text = entries.map((e) => JSON.stringify(e)).join('\n');
    const encrypted = logcrypto.encryptExport(text);
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    let range = '';
    if (entries.length) {
      const first = new Date(entries[0].ts);
      const last = new Date(entries[entries.length - 1].ts);
      if (!isNaN(first.getTime()) && !isNaN(last.getTime())) {
        const fd = first.getFullYear() + pad(first.getMonth() + 1) + pad(first.getDate());
        const ld = last.getFullYear() + pad(last.getMonth() + 1) + pad(last.getDate());
        range = '_' + fd + '-' + ld;
      }
    }
    const exportTime =
      now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '_' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
    const defaultName = 'LumeShare' + range + '_' + exportTime + logcrypto.EXT;
    const r = await dialog.showSaveDialog(win, {
      title: '保存加密日志',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: 'LumeShare 加密日志', extensions: [logcrypto.EXT.replace(/^\./, '')] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    try {
      fs.writeFileSync(r.filePath, encrypted);
      logger.info('log:download', { path: r.filePath, count: entries.length });
      try {
        shell.showItemInFolder(r.filePath);
      } catch {
        /* 打开文件夹失败不影响保存结果 */
      }
      return { ok: true, path: r.filePath, count: entries.length, encrypted: true };
    } catch (e) {
      logger.error('log:download:error', { error: e.message });
      return { ok: false, error: e.message };
    }
  });

  // 更新检测
  ipcMain.handle('update:check', async () => {
    try {
      const info = await updater.checkUpdate();
      logger.log('update:check', { hasUpdate: info.hasUpdate, code: info.code, date: info.date }, info.hasUpdate ? 'warn' : 'info');
      return info;
    } catch (e) {
      logger.error('update:check:error', { error: e.message });
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('update:download', async (_e, payload) => {
    const url = payload && payload.url;
    if (!url) return { ok: false, error: '缺少下载地址' };
    try {
      const filePath = await updater.downloadUpdate(url, (p) => {
        win?.webContents.send('update:progress', p);
      });
      logger.info('update:download', { path: filePath });
      return { ok: true, path: filePath };
    } catch (e) {
      logger.error('update:download:error', { error: e.message });
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('update:apply', (_e, payload) => {
    try {
      const r = updater.applyUpdate(payload && payload.path, payload && payload.code);
      logger.info('update:apply', { installDir: r.installDir });
      return { ok: true, installDir: r.installDir };
    } catch (e) {
      logger.error('update:apply:error', { error: e.message });
      return { ok: false, error: e.message };
    }
  });

  // 文件操作
  ipcMain.handle('file:info', (_e, filePath) => {
    try {
      const st = fs.statSync(filePath);
      return { name: path.basename(filePath), size: st.size, mtime: Math.floor(st.mtimeMs), ext: path.extname(filePath).slice(1) };
    } catch {
      return null;
    }
  });

  ipcMain.handle('file:reveal', (_e, filePath) => {
    shell.showItemInFolder(filePath);
    return true;
  });

  ipcMain.handle('file:open', async (_e, filePath) => {
    const err = await shell.openPath(filePath);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle('dialog:folder', async (_e, opts) => {
    const r = await dialog.showOpenDialog(win, {
      title: opts?.title || '选择保存位置',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('file:copy', async (_e, srcPath) => {
    const destDir = await pickFolder('选择保存位置');
    if (!destDir) return { canceled: true };
    const r = copyFileTo(srcPath, destDir);
    logger.log('file:copy', { name: path.basename(srcPath), dest: r.ok ? r.dest : undefined, error: r.error }, r.ok ? 'info' : 'warn');
    return r;
  });

  ipcMain.handle('file:save-data', async (_e, payload) => {
    // payload: { data: base64, name, hint }
    const destDir = await pickFolder(payload?.hint || '选择保存位置');
    if (!destDir) return { canceled: true };
    try {
      const dest = path.join(destDir, sanitizeName(payload.name || '文件'));
      fs.writeFileSync(dest, Buffer.from(payload.data, 'base64'));
      return { ok: true, dest };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 分享
  ipcMain.handle('share:start', async () => {
    const svc = ensureShareService();
    const cur = svc.status();
    if (cur.running) {
      logger.info('share:start', { port: cur.port });
      return { port: cur.port, urls: cur.urls };
    }
    const info = await svc.start();
    logger.info('share:start', { port: info.port });
    return info;
  });

  ipcMain.handle('share:stop', () => {
    shareService?.stop();
    return true;
  });

  ipcMain.handle('share:status', () => (shareService ? shareService.status() : { running: false, urls: [], codeCount: 0 }));

  ipcMain.handle('share:list', () => (shareService ? shareService.list() : []));

  ipcMain.handle('share:remove', (_e, code) => {
    shareService?.removeFiles(code);
    return true;
  });

  // 分享存储目录信息（设置页展示所在盘符与占用）
  ipcMain.handle('share:storage-info', () => {
    const dir = shareStorageDir();
    const sum = storageSummary(dir);
    let drive = '';
    try {
      drive = path.parse(dir).root || '';
    } catch {
      /* ignore */
    }
    return Object.assign({ dir, drive, isDefault: !settings.get().shareStorageDir }, sum);
  });

  // 一键清空：删除本机保存的全部分享文件与提取码（仅限本应用生成的记录，不碰目录里其它文件）
  ipcMain.handle('share:clear-files', () => {
    const dir = shareStorageDir();
    const mappedRemoved = shareService ? shareService.clearRecordsIn(dir) : [];
    const staleRemoved = clearStorageDir(dir);
    const removed = mappedRemoved.length + staleRemoved;
    logger.info('share:clear-files', { dir, removed });
    win?.webContents.send('share:cleared');
    return { ok: true, removed, dir };
  });

  // 一键分享本地文件：复制到分享存储目录并生成提取码
  // 前置条件：必须先在“局域网分享”中开启分享服务，否则返回错误提示（不自动开启）
  ipcMain.handle('share:share-file', async (_e, filePath) => {
    if (!filePath || typeof filePath !== 'string') return { ok: false, error: '参数错误' };
    try {
      const svc = ensureShareService();
      if (!svc.status().running) {
        logger.info('share:share-file:blocked', { reason: 'service-off' });
        return { ok: false, needService: true, error: '请先在「局域网分享」中开启分享功能，然后再分享文件' };
      }
      const r = svc.shareLocalFile(filePath);
      if (!r.ok) return { ok: false, error: r.error || '分享失败' };
      logger.info('share:share-file', { name: r.name, code: r.code, size: r.size });
      return r;
    } catch (e) {
      logger.error('share:share-file:error', { error: e.message });
      return { ok: false, error: e.message };
    }
  });

  // 更改分享存储目录：迁移全部已分享文件到新目录后切换配置（不影响已有提取码）
  ipcMain.handle('share:set-storage-dir', async (_e, payload) => {
    const requested = payload && payload.dir ? String(payload.dir).trim() : null;
    const target = requested ? path.resolve(requested) : defaultShareDir();
    const current = shareStorageDir();
    if (target.toLowerCase() === current.toLowerCase()) {
      return { ok: true, same: true, dir: current };
    }
    // 目标目录必须可写
    try {
      fs.mkdirSync(target, { recursive: true });
      const probe = path.join(target, '.lumeshare-write-test');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
    } catch (e) {
      logger.warn('share:storage-dir:unwritable', { target, error: e.message });
      return { ok: false, error: '所选位置无法写入：' + e.message };
    }
    // 迁移期间先停止服务，避免读写冲突
    const wasRunning = !!(shareService && shareService.status().running);
    try {
      shareService?.stop();
    } catch {
      /* ignore */
    }
    shareService = null;
    // 先复制全部文件到新目录（源文件暂不删除）
    const mig = migrateStorageDir(current, target);
    if (!mig.ok) {
      logger.error('share:storage-dir:migrate-fail', { current, target, errors: mig.errors });
      // 迁移失败：源文件保持不动，按旧目录恢复服务
      if (wasRunning) {
        try {
          await ensureShareService().start();
        } catch {
          /* ignore */
        }
      }
      return { ok: false, error: '迁移文件失败：' + (mig.errors || []).join('；') || '未知错误' };
    }
    // 确认迁移成功后保存配置并清理旧目录中已迁移的文件
    settings.set({ shareStorageDir: requested ? target : null });
    try {
      cleanupMigrated(current, mig.moved);
    } catch {
      /* ignore */
    }
    let restarted = false;
    let restartError = null;
    if (wasRunning) {
      try {
        await ensureShareService().start();
        restarted = true;
      } catch (e) {
        restartError = e.message;
      }
    }
    logger.info('share:storage-dir', {
      from: current,
      to: target,
      moved: mig.moved.length,
      restarted,
      restartError,
    });
    return { ok: true, moved: mig.moved.length, dir: target, restarted, restartError };
  });

  ipcMain.handle('share:save', async (_e, payload) => {
    const { code, destDir } = payload;
    if (!shareService) return { ok: false, error: '服务未启动' };
    const r = shareService.saveTo(code, destDir);
    logger.log('share:download', { code, dest: r.ok ? r.dest : undefined, error: r.error }, r.ok ? 'info' : 'warn');
    return r;
  });

  ipcMain.handle('share:pick-save', async (_e, code) => {
    const destDir = await pickFolder('选择保存位置');
    if (!destDir) return { canceled: true };
    if (!shareService) return { ok: false, error: '服务未启动' };
    const r = shareService.saveTo(code, destDir);
    logger.log('share:download', { code, dest: r.ok ? r.dest : undefined, error: r.error }, r.ok ? 'info' : 'warn');
    return r;
  });

  // ---------- 屏幕直播 ----------
  ipcMain.handle('live:sources', async () => {
    if (!settings.get().liveEnabled) throw new Error('请先开启屏幕直播');
    return ensureLiveCapture().listSources();
  });

  ipcMain.handle('live:start', async (_e, payload) => {
    if (!settings.get().liveEnabled) throw new Error('请先开启屏幕直播');
    const p = payload || {};
    const preset = p.preset === 'smooth' ? 'smooth' : 'hd';
    await stopLiveAll();
    const service = ensureLiveService();
    const capture = ensureLiveCapture();
    try {
      const cfg = await capture.start({ sourceId: p.sourceId || '', preset });
      const sourceName = String(p.sourceName || '') || '屏幕';
      const status = await service.start({
        preset,
        fps: cfg.fps,
        profile: { label: cfg.label, width: 0, height: 0, mime: '' },
        sourceName,
      });
      logger.info('live:start', { preset, port: status.web.port, hdPort: status.hd.port });
      return status;
    } catch (err) {
      await stopLiveAll();
      logger.warn('live:start-fail', { error: (err && err.message) || String(err) });
      throw err;
    }
  });

  ipcMain.handle('live:stop', async () => {
    await stopLiveAll();
    logger.info('live:stop', {});
    return { running: false };
  });

  ipcMain.handle('live:status', () => (liveService ? liveService.status() : { running: false }));

  ipcMain.handle('live:set-preset', async (_e, preset) => {
    if (!liveCapture || !liveService || !liveService.session) throw new Error('当前没有进行中的直播');
    const cfg = await liveCapture.setPreset(preset === 'smooth' ? 'smooth' : 'hd');
    liveService.session.preset = cfg.preset;
    liveService.session.fps = cfg.fps;
    liveService.session.profile = { label: cfg.label, width: 0, height: 0, mime: '' };
    return liveService.status();
  });

  ipcMain.handle('live:set-source', async (_e, sourceId) => {
    if (!liveCapture || !liveService || !liveService.session) throw new Error('当前没有进行中的直播');
    const cfg = await liveCapture.setSource(sourceId);
    if (cfg) liveService.session.source = String(sourceId || '');
    return liveService.status();
  });

  ipcMain.handle('live:resolve', (_e, payload) => {
    const parsed = parseLiveText((payload && payload.input) || '');
    if (!parsed) return { ok: false };
    return {
      ok: true,
      host: parsed.host || '',
      code: parsed.code || '',
      token: parsed.token || '',
    };
  });

  ipcMain.handle('live:connect', async (_e, payload) => {
    if (!settings.get().liveEnabled) throw new Error('请先开启屏幕直播');
    const p = payload || {};
    const host = normalizeHost(p.host);
    const key = String(p.code || '').trim();
    if (!host) throw new Error('请填写主播地址');
    if (!/^\d{10}$/.test(key) && !/^[A-Za-z0-9]{38}$/.test(key)) {
      throw new Error('房间码应为 10 位数字');
    }
    const status = await probeLive(host);
    if (!status || !status.running) throw new Error('主播还没有开始直播');
    const parts = host.split(':');
    const port = Number(parts[1]) || 16900;
    const hdPort = Number(status.hdPort) || port + 1;
    return {
      host: parts[0],
      port,
      hdPort,
      token: key,
      room: /^\d{10}$/.test(key) ? key : '',
    };
  });

  ipcMain.handle('live:remote-status', async (_e, payload) => {
    const p = payload || {};
    const host = normalizeHost(p.port ? p.host + ':' + p.port : p.host);
    if (!host) return { running: false };
    try {
      return await probeLive(host, 3500);
    } catch {
      return { running: false };
    }
  });

  ipcMain.handle('app:info', () => ({ name: APP_NAME, version: APP_VERSION, feedbackUrl: endpoints.FEEDBACK_FORM_URL }));

  // ---------- 关闭到托盘 ----------
  ipcMain.handle('tray:set-close-to-tray', (_e, v) => {
    settings.set({ closeToTray: !!v });
    return { ok: true, closeToTray: !!v };
  });
  ipcMain.handle('tray:status', () => ({ closeToTray: !!settings.get().closeToTray }));

  // ---------- 打开外部链接（意见反馈表单等，仅允许 https） ----------
  ipcMain.handle('app:open-external', async (_e, url) => {
    const target = String(url || '');
    if (!/^https:\/\//i.test(target)) return { ok: false, error: '地址无效' };
    const list = [endpoints.FEEDBACK_FORM_URL, endpoints.API_BASE].filter(Boolean);
    const allowed = list.some((it) => target.startsWith(it));
    if (!allowed) return { ok: false, error: '不允许打开该地址' };
    try {
      await shell.openExternal(target);
      logger.info('app:open-external', { host: new URL(target).host });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });



}

async function pickFolder(title) {
  const r = await dialog.showOpenDialog(win, {
    title,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
}

function copyFileTo(srcPath, destDir) {
  try {
    const dest = path.join(destDir, path.basename(srcPath));
    if (fs.existsSync(dest)) {
      // 同名文件自动加后缀，避免覆盖
      const ext = path.extname(dest);
      const base = path.basename(dest, ext);
      let i = 1;
      let candidate = path.join(destDir, base + ' (副本' + i + ')' + ext);
      while (fs.existsSync(candidate)) {
        i++;
        candidate = path.join(destDir, base + ' (副本' + i + ')' + ext);
      }
      fs.copyFileSync(srcPath, candidate);
      return { ok: true, dest: candidate };
    }
    fs.copyFileSync(srcPath, dest);
    return { ok: true, dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function sanitizeName(name) {
  return String(name || '文件')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim() || '文件';
}

// ---------------- 启动 ----------------
const isSelftest = process.argv.includes('--selftest');
const isTestMode =
  isSelftest ||
  process.argv.includes('--smoke') ||
  process.argv.includes('--uitest') ||
  process.argv.includes('--livetest') ||
  process.argv.includes('--uismoke') ||
  process.argv.includes('--aitest') ||
  process.argv.includes('--logintest') ||
  process.argv.includes('--chattest');

// 单实例运行：重复启动时聚焦已有窗口，避免多个实例抢占端口导致异常
if (!isTestMode) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });
  }
}

const isSmoke = process.argv.includes('--smoke');
const isUiTest = process.argv.includes('--uitest');
const isLiveTest = process.argv.includes('--livetest');
const isUiSmoke = process.argv.includes('--uismoke');

// 屏幕直播自动化验证：真实采集 + 真实 HTTP 访问 + 应用内观看截图
async function runLiveTest() {
  const httpMod = require('http');
  const outDir = path.join(app.getPath('temp'), 'livetest');
  fs.mkdirSync(outDir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), img.toPNG());
    console.log('[livetest] shot ' + path.join(outDir, name));
  };
  const getText = (url) =>
    new Promise((resolve) => {
      const req = httpMod.get(url, { timeout: 5000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', (e) => resolve({ status: 0, text: 'ERR ' + e.message }));
      req.on('timeout', () => req.destroy(new Error('timeout')));
    });
  const postJson = (url, body) =>
    new Promise((resolve) => {
      const payload = Buffer.from(JSON.stringify(body));
      const req = httpMod.request(
        url,
        { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length }, timeout: 5000 },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('error', (e) => resolve({ status: 0, text: 'ERR ' + e.message }));
      req.write(payload);
      req.end();
    });
  // 直接读取视频流协议：校验 LSV1 标识与「元数据 / 初始化段 / 媒体块」帧
  const readStream = (url, ms) =>
    new Promise((resolve) => {
      const out = { status: 0, magic: '', meta: null, initBytes: 0, chunkCount: 0, bytes: 0 };
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(out);
      };
      let req = null;
      const u = new URL(url);
      req = httpMod.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, timeout: 8000 }, (res) => {
        out.status = res.statusCode;
        let buf = Buffer.alloc(0);
        let magicOk = false;
        const timer = setTimeout(() => {
          try {
            req.destroy();
          } catch {
            /* ignore */
          }
          finish();
        }, ms);
        res.on('data', (c) => {
          out.bytes += c.length;
          buf = Buffer.concat([buf, c]);
          if (!magicOk) {
            if (buf.length < 4) return;
            out.magic = buf.slice(0, 4).toString('latin1');
            buf = buf.slice(4);
            magicOk = true;
          }
          while (buf.length >= 5) {
            const type = buf[0];
            const len = buf.readUInt32BE(1);
            if (buf.length < 5 + len) break;
            const payload = buf.slice(5, 5 + len);
            buf = buf.slice(5 + len);
            if (type === 1 && !out.meta) {
              try {
                out.meta = JSON.parse(payload.toString('utf8'));
              } catch {
                /* ignore */
              }
            } else if (type === 2) {
              out.initBytes += payload.length;
            } else if (type === 3) {
              out.chunkCount += 1;
            }
          }
        });
        res.on('end', () => {
          clearTimeout(timer);
          finish();
        });
        res.on('error', () => {
          clearTimeout(timer);
          finish();
        });
      });
      req.on('error', () => finish());
    });

  settings.set({ liveEnabled: true, autoScanOnStart: false });
  await wait(2200);
  await win.webContents.executeJavaScript('document.querySelector(\'[data-view="live"]\').click()');
  await wait(1000);
  await shot('01-live-page.png');

  await win.webContents.executeJavaScript(
    "(function(){var s=document.getElementById('live-enable');s.checked=true;s.dispatchEvent(new Event('change'));return s.checked})()"
  );
  await wait(1500);
  await shot('02-live-enabled.png');

  await win.webContents.executeJavaScript("document.getElementById('live-start-btn').click()");
  await wait(4500);
  const st = liveService ? liveService.status() : null;
  console.log('[livetest] STATUS ' + JSON.stringify(st));
  if (!st || !st.running) throw new Error('直播未启动');
  await shot('03-live-broadcasting.png');

  const page = await getText('http://127.0.0.1:' + st.web.port + '/');
  console.log('[livetest] PAGE status=' + page.status + ' len=' + page.text.length + ' room=' + /房间码/.test(page.text));
  const playerJs = await getText('http://127.0.0.1:' + st.web.port + '/player.js');
  console.log('[livetest] PLAYERJS status=' + playerJs.status + ' hasMSE=' + /MediaSource/.test(playerJs.text));
  const badCode = await postJson('http://127.0.0.1:' + st.web.port + '/api/live/check', { code: '0000000000' });
  console.log('[livetest] BAD_CODE ' + badCode.text);
  const goodCode = await postJson('http://127.0.0.1:' + st.web.port + '/api/live/check', { code: st.roomCode });
  console.log('[livetest] GOOD_CODE ' + goodCode.text);

  const webStream = await readStream('http://127.0.0.1:' + st.web.port + '/stream/' + st.roomCode, 3000);
  console.log('[livetest] WEB_STREAM ' + JSON.stringify(webStream));
  const hdStream = await readStream('http://127.0.0.1:' + st.hd.port + '/hd/' + st.token, 3000);
  console.log('[livetest] HD_STREAM ' + JSON.stringify(hdStream));
  const badKey = await readStream('http://127.0.0.1:' + st.web.port + '/stream/12345', 1500);
  console.log('[livetest] WRONG_KEY ' + JSON.stringify(badKey));

  await win.webContents.executeJavaScript(
    "(function(){var r=document.getElementById('live-room-input');r.value='" +
      st.roomCode +
      "';var h=document.getElementById('live-host-input');h.value='127.0.0.1:" +
      st.web.port +
      "';document.getElementById('live-watch-btn').click();})()"
  );
  await wait(5000);
  const watchState = await win.webContents.executeJavaScript(
    "(function(){var v=document.getElementById('live-video');var card=document.getElementById('live-player-card');" +
      "return JSON.stringify({visible:!card.classList.contains('hidden'),w:v.videoWidth,h:v.videoHeight," +
      "t:Number(v.currentTime.toFixed(2)),state:v.readyState,paused:v.paused," +
      "meta:document.getElementById('live-player-meta').textContent})})()"
  );
  console.log('[livetest] WATCH ' + watchState);
  // 采样观看端解码帧数与播放进度（不注入任何可见元素，避免干扰真实界面）
  const q1 = await win.webContents.executeJavaScript(
    "(function(){var v=document.getElementById('live-video');var q=v.getVideoPlaybackQuality?v.getVideoPlaybackQuality():null;" +
      "return JSON.stringify({q:q?{t:q.totalVideoFrames,d:q.droppedVideoFrames}:null,t:v.currentTime})})()"
  );
  await wait(3000);
  const q2 = await win.webContents.executeJavaScript(
    "(function(){var v=document.getElementById('live-video');var q=v.getVideoPlaybackQuality?v.getVideoPlaybackQuality():null;" +
      "return JSON.stringify({q:q?{t:q.totalVideoFrames,d:q.droppedVideoFrames}:null,t:v.currentTime})})()"
  );
  const s1 = JSON.parse(q1);
  const s2 = JSON.parse(q2);
  const fpsText = s1.q && s2.q ? ((s2.q.t - s1.q.t) / 3).toFixed(1) : 'n/a';  console.log(
    '[livetest] DECODE_FPS ' + fpsText + ' dropped=' + (s1.q && s2.q ? s2.q.d - s1.q.d : 'n/a')
  );
  await shot('04-live-watching.png');
  await wait(1200);
  await shot('05-live-watching-2.png');

  // 网页端：房间码入口 + 原生 <video> 播放
  const testAddr = 'http://127.0.0.1:' + st.web.port;
  const shotWin = async (w, name) => {
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), img.toPNG());
    console.log('[livetest] shot ' + path.join(outDir, name));
  };
  const webWin = new BrowserWindow({
    width: 980,
    height: 680,
    show: true,
    x: 40,
    y: 40,
    title: 'livetest-web',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  webWin.webContents.on('console-message', (_e, level, message) => {
    console.log('[webwin:' + level + '] ' + message);
  });
  await webWin.loadURL(testAddr + '/');
  await wait(1200);
  await shotWin(webWin, '06-web-join.png');
  await webWin.webContents.executeJavaScript(
    "document.getElementById('room-input').value='" + st.roomCode + "';document.getElementById('join-btn').click();"
  );
  await wait(6000);
  const webState = await webWin.webContents.executeJavaScript(
    "(function(){var v=document.getElementById('player');return JSON.stringify({stage:!document.getElementById('stage').classList.contains('hidden')," +
      "w:v.videoWidth,h:v.videoHeight,t:Number(v.currentTime.toFixed(2)),state:v.readyState," +
      "overlay:!document.getElementById('overlay').classList.contains('hidden')," +
      "overlayText:document.getElementById('overlay-text').textContent," +
      "meta:document.getElementById('tb-meta').textContent})})()"
  );
  console.log('[livetest] WEB_VIDEO ' + webState);
  await shotWin(webWin, '07-web-playing.png');
  const segInfo = await webWin.webContents.executeJavaScript(
    "(function(){var b=document.querySelectorAll('#quality-seg button');return JSON.stringify({count:b.length,qs:document.querySelector('#quality-seg')?'yes':'no'});})()"
  );
  console.log('[livetest] SEG ' + segInfo);
  try {
    await webWin.webContents.executeJavaScript(
      "(function(){var b=document.querySelector('#quality-seg button[data-q=\"web\"]');if(!b)return 'no-button';b.click();return 'clicked';})()"
    ).then((r) => console.log('[livetest] SMOOTH_CLICK ' + r));
  } catch (e) {
    console.log('[livetest] SMOOTH_CLICK_ERROR ' + ((e && e.message) || e));
  }
  await wait(7000);
  const webSmooth = await webWin.webContents.executeJavaScript(
    "(function(){var v=document.getElementById('player');return JSON.stringify({w:v.videoWidth,h:v.videoHeight,t:Number(v.currentTime.toFixed(2))," +
      "state:v.readyState,overlay:!document.getElementById('overlay').classList.contains('hidden')," +
      "overlayText:document.getElementById('overlay-text').textContent})})()"
  );
  console.log('[livetest] WEB_SMOOTH ' + webSmooth);
  await shotWin(webWin, '08-web-smooth.png');

  const webWin2 = new BrowserWindow({
    width: 980,
    height: 680,
    show: true,
    x: 300,
    y: 90,
    title: 'livetest-web-token',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  webWin2.webContents.on('console-message', (_e, level, message) => {
    console.log('[webwin2:' + level + '] ' + message);
  });
  await webWin2.loadURL(testAddr + '/' + st.token);
  await wait(9000);
  const webToken = await webWin2.webContents.executeJavaScript(
    "(function(){var v=document.getElementById('player');return JSON.stringify({stage:!document.getElementById('stage').classList.contains('hidden')," +
      "w:v.videoWidth,h:v.videoHeight,t:Number(v.currentTime.toFixed(2)),state:v.readyState," +
      "overlay:!document.getElementById('overlay').classList.contains('hidden')," +
      "overlayText:document.getElementById('overlay-text').textContent})})()"
  );
  console.log('[livetest] WEB_TOKEN ' + webToken);
  await shotWin(webWin2, '09-web-token.png');
  try {
    webWin.destroy();
    webWin2.destroy();
  } catch {
    /* ignore */
  }

  await stopLiveAll();
  settings.set({ liveEnabled: false, liveLastHost: '' });
  console.log('[livetest] DONE');
  app.exit(0);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 界面冒烟测试：默认页（局域网分享）/ 文件库 / 屏幕直播 / 设置
async function runUiSmoke() {
  const outDir = path.join(app.getPath('temp'), 'uismoke');
  fs.mkdirSync(outDir, { recursive: true });
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), img.toPNG());
    console.log('[uismoke] shot ' + name);
  };
  const js = (code) => win.webContents.executeJavaScript(code);
  win.webContents.on('console-message', (_e, level, message) => console.log('[renderer:' + level + '] ' + message));
  await wait(2600);
  await shot('01-default.png');
  const base = await js(
    "(()=>JSON.stringify({view:document.querySelector('.view.active')?.id||'',navs:[...document.querySelectorAll('.nav-item')].map(n=>n.dataset.view),version:document.getElementById('side-version').textContent,hasMemoryView:!!document.getElementById('view-memory'),memoryCode:typeof window.lume.memory}))()"
  );
  console.log('[uismoke] BASE ' + base);
  const share = await js(
    "(()=>JSON.stringify({toggle:!!document.getElementById('share-toggle-btn'),status:document.getElementById('share-status-chip')?.textContent||'',drop:!!document.querySelector('#view-share .upload-zone, #view-share .drop-zone, #view-share #upload-zone')}))()"
  );
  console.log('[uismoke] SHARE ' + share);
  await js("document.getElementById('share-toggle-btn').click()");
  await wait(3000);
  const shareOn = await js("(()=>JSON.stringify({status:document.getElementById('share-status-chip')?.textContent||'',toggleText:document.getElementById('share-toggle-text')?.textContent||'',hasUrl:!!document.querySelector('#view-share .share-url, #view-share .share-addr, #view-share code')}))()");
  console.log('[uismoke] SHARE_ON ' + shareOn);
  await shot('02b-share-on.png');
  await js("document.getElementById('share-toggle-btn').click()");
  await wait(1500);
  console.log('[uismoke] SHARE_OFF ' + (await js("document.getElementById('share-status-chip')?.textContent||''")));
  await shot('02-share.png');
  await js("window.dispatchEvent(new CustomEvent('lume:navigate',{detail:'files'}))");
  await wait(2500);
  const files = await js(
    "(()=>JSON.stringify({view:document.querySelector('.view.active')?.id||'',driveOptions:document.getElementById('drive-select')?.options.length||0,hasScanBtn:!!document.getElementById('scan-btn'),tabs:document.querySelectorAll('#view-files .tab').length,listRows:document.querySelectorAll('#list-body .file-row').length}))()"
  );
  console.log('[uismoke] FILES ' + files);
  // 文件库：直接扫描当前磁盘（默认 C:），扫描完成后切换分类检查列表渲染

  await wait(600);
  await js("document.getElementById('scan-btn').click()");
  for (let i = 0; i < 60; i++) {
    const hidden = await js("document.getElementById('scan-overlay').classList.contains('hidden')");
    if (hidden) break;
    await wait(300);
  }
  await wait(800);
  const scanResult = await js(
    "(()=>JSON.stringify({others:document.getElementById('cnt-others')?.textContent||'',images:document.getElementById('cnt-images')?.textContent||'',rows:document.querySelectorAll('#list-body .file-row').length,shareBtns:document.querySelectorAll('#list-body .file-row .row-btn-share').length}))()"
  );
  console.log('[uismoke] SCAN ' + scanResult);
  await js("document.getElementById('tab-others').click()");
  await wait(1800);
  const listState = await js("(()=>JSON.stringify({rows:document.querySelectorAll('#list-body .file-row').length,shareBtns:document.querySelectorAll('#list-body .file-row .row-btn-share').length,firstName:document.querySelector('#list-body .row-name')?.textContent?.slice(0,30)||''}))()");
  console.log('[uismoke] FILE_LIST ' + listState);
  await shot('03b-files-scanned.png');
  await shot('03-files.png');
  await js("window.dispatchEvent(new CustomEvent('lume:navigate',{detail:'live'}))");
  await wait(2200);
  const live = await js(
    "(()=>JSON.stringify({view:document.querySelector('.view.active')?.id||'',hasSwitch:!!document.getElementById('live-enabled'),hasStart:!!document.getElementById('live-start-btn'),sourceOptions:document.getElementById('live-source-select')?.options.length||0}))()"
  );
  console.log('[uismoke] LIVE ' + live);
  await shot('04-live.png');
  await js("window.dispatchEvent(new CustomEvent('lume:navigate',{detail:'settings'}))");
  await wait(1500);
  const settings = await js(
    "(()=>JSON.stringify({view:document.querySelector('.view.active')?.id||'',hasLogDownload:!!document.getElementById('log-download-btn'),hasUpdate:!!document.getElementById('update-check-btn'),appVersion:document.getElementById('app-version')?.textContent||''}))()"
  );
  console.log('[uismoke] SETTINGS ' + settings);
  await shot('05-settings.png');
  await js("window.dispatchEvent(new CustomEvent('lume:navigate',{detail:'share'}))");
  await wait(1200);
  console.log('[uismoke] BACK ' + (await js("document.querySelector('.view.active')?.id||''")));
  console.log('[uismoke] DONE');
  app.exit(0);
}


// 首页 → 对话页 → 流式回答 全链路测试（临时登录态，结束后自动退出登录）

app.whenReady().then(async () => {
  // 每次启动都做一次系统校验（安装时已校验，运行时再次校验）
  if (!checkSystem()) {
    try {
      dialog.showErrorBox(
        '系统版本过低',
        'LumeShare 需要 Windows 10 及以上系统才能运行。\n当前系统版本过低（Windows 7 / 8 / 8.1 已不再支持），无法使用本软件。'
      );
    } catch {
      /* ignore */
    }
    app.exit(1);
    return;
  }

  registerLumeProtocol();
  registerIpc();

  // 记录本次启动
  logger.info('app:start', { version: APP_VERSION, system: os.release(), platform: process.platform });

  // 缩略图缓存清理放到窗口显示之后，避免拖慢启动
  setTimeout(() => {
    try {
      trimThumbs();
    } catch {
      /* ignore */
    }
  }, 2500);

  if (isSelftest) {
    const { runSelftest } = require('./selftest');
    const code = await runSelftest({ copyFileTo });
    app.exit(code);
    return;
  }

  if (isUiTest) {
    const { runUiTest, runWebTest, makeSamples } = require('./uitest');
    const idx = process.argv.indexOf('--uitest');
    const samplesDir = process.argv[idx + 1] || path.join(app.getPath('temp'), 'lumeshare-uitest-samples');
    makeSamples(samplesDir);
    createWindow('lume://app/index.html?uitest=1');
    win.webContents.on('console-message', (_e, level, message) => {
      console.log('[renderer:' + level + '] ' + message);
    });
    win.once('ready-to-show', () => {
      win.show();
      runUiTest(win, samplesDir)
        .then(async (res) => {
          // 截图设置页
          try {
            await win.webContents.executeJavaScript('document.querySelector(\'[data-view="settings"]\').click()');
            await new Promise((r) => setTimeout(r, 900));
            const shot = await win.webContents.capturePage();
            fs.writeFileSync(path.join(__dirname, '..', 'dist', 'uitest-settings.png'), shot.toPNG());
          } catch (e) {
            console.log('[uitest] 设置页截图失败 ' + e.message);
          }
          // 截图当前界面（图片网格）
          try {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(path.join(__dirname, '..', 'dist', 'uitest-images.png'), img.toPNG());
          } catch (e) {
            console.log('[uitest] 截图失败 ' + e.message);
          }
          const webRes = await runWebTest(res.port, res.code);
          console.log('[uitest] RESULT ' + JSON.stringify(Object.assign({}, res, { web: webRes })));
          app.exit(0);
        })
        .catch((e) => {
          console.log('[uitest] FAIL ' + ((e && e.stack) || e));
          app.exit(1);
        });
    });
    return;
  }

  createWindow(undefined, { bindTray: true });

  // 低频维护任务延迟执行：分享目录迁移与音乐预加载，避免与首屏渲染抢资源
  setTimeout(() => {
    migrateLegacyShareDir().catch((e) => logger.warn('share:legacy-migrate:error', { error: e.message }));
  }, 3000);

  if (isUiSmoke) {
    setTimeout(() => {
      runUiSmoke().catch((e) => {
        console.log('[uismoke] FAIL ' + ((e && e.stack) || e));
        app.exit(1);
      });
    }, 400);
    return;
  }


  if (isLiveTest) {
    setTimeout(() => {
      runLiveTest().catch((e) => {
        console.log('[livetest] FAIL ' + ((e && e.stack) || e));
        app.exit(1);
      });
    }, 600);
    return;
  }

  // 背景音乐：设置里开启过后，每次启动都自动在后台循环播放（无界面）
  if (!isSelftest && !isUiTest) {
    try {
      if (settings.get().bgmEnabled) {
        music.applySetting(true).catch((e) => logger.warn('music:start-fail', { error: e.message }));
      }
    } catch {
      /* ignore */
    }
  }

  if (isSmoke) {
    // 冒烟测试：记录渲染层日志、截图后自动退出
    win.webContents.on('console-message', (_e, level, message) => {
      console.log('[renderer:' + level + '] ' + message);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log('[smoke] did-fail-load code=' + code + ' desc=' + desc);
    });
    win.once('ready-to-show', () => {
      win.show();
      const shot = async (name) => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(app.getPath('temp'), name), img.toPNG());
        console.log('[smoke] 截图已保存 ' + path.join(app.getPath('temp'), name));
      };
      setTimeout(async () => {
        try {
          await shot('smoke-shot.png');
        } catch (e) {
          console.log('[smoke] 截图失败: ' + e.message);
        }
        try {
          await win.webContents.executeJavaScript('document.querySelector(\'[data-view="share"]\').click()');
        } catch (e) {
          console.log('[smoke] 切换分享页失败: ' + e.message);
        }
        setTimeout(async () => {
          try {
            await win.webContents.executeJavaScript('document.getElementById("copy-link-btn").click()');
          } catch (e) {
            console.log('[smoke] 触发提示失败: ' + e.message);
          }
          setTimeout(async () => {
            try {
              await shot('smoke-shot-share.png');
            } catch (e) {
              console.log('[smoke] 分享页截图失败: ' + e.message);
            }
            console.log('[smoke] 冒烟测试结束');
            app.exit(0);
          }, 1200);
        }, 4000);
      }, 10000);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(undefined, { bindTray: true });
  });
});

app.on('window-all-closed', () => {
  // 自测/集成测试模式没有主窗口，隐藏播放器窗口的销毁不应导致进程提前退出
  if (isSelftest || isUiTest) return;
  app.quit();
});

app.on('before-quit', () => {
  trayCtrl.setQuitting(true);
  trayCtrl.destroy();
  shareService?.stop();
  try {
    liveCapture?.stop();
  } catch {
    /* ignore */
  }
  try {
    liveService?.stop();
  } catch {
    /* ignore */
  }
  try {
    music.stop();
  } catch {
    /* ignore */
  }
  logger.info('app:quit', {});
});
