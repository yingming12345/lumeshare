'use strict';
// 屏幕画面采集控制：隐藏窗口负责采集屏幕并用 MediaRecorder 编码为 WebM 视频流
const path = require('path');
const { BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');

const PRESETS = {
  // 画质优先：屏幕原始分辨率 + 高码率（VP8）
  hd: { key: 'hd', label: '高清', fps: 24, hdBitrate: 10000000, webBitrate: 2500000 },
  // 省流量：同样分辨率，码率更低
  smooth: { key: 'smooth', label: '流畅', fps: 24, hdBitrate: 6000000, webBitrate: 2000000 },
};

let instance = null;
let ipcBound = false;
let permissionBound = false;
let captureWindowId = 0;

function ensurePermissions() {
  if (permissionBound) return;
  permissionBound = true;
  try {
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      if (wc && wc.id === captureWindowId) {
        cb(permission === 'media');
        return;
      }
      cb(true);
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => {
      if (wc && wc.id === captureWindowId) return permission === 'media';
      return true;
    });
  } catch {
    /* 个别系统不支持权限处理器时忽略 */
  }
}

class ScreenCapture {
  constructor(handlers) {
    const h = handlers || {};
    this.onReady = typeof h.onReady === 'function' ? h.onReady : function () {};
    this.onProfile = typeof h.onProfile === 'function' ? h.onProfile : function () {};
    this.onError = typeof h.onError === 'function' ? h.onError : function () {};
    this.onViewerFrame = typeof h.onViewerFrame === 'function' ? h.onViewerFrame : function () {};
    this.win = null;
    this.sourceId = '';
    this.preset = 'hd';
    this.watchdog = null;
    this.readyFull = false;
    this.viewers = new Set();
    ensurePermissions();
    this.bindIpc();
  }

  bindIpc() {
    if (ipcBound) {
      instance = this;
      return;
    }
    ipcBound = true;
    instance = this;
    ipcMain.on('live:viewer-frame', (e, viewerId, type, buffer) => {
      if (!instance || !instance.win || e.sender !== instance.win.webContents) return;
      if (!viewerId || !buffer) return;
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      if (!buf.length) return;
      try {
        instance.onViewerFrame(viewerId, Number(type) || 3, buf);
      } catch {
        /* 单个观看者的数据异常不影响其他人 */
      }
    });
    ipcMain.on('live:capture-report', (e, payload) => {
      if (!instance || !instance.win || e.sender !== instance.win.webContents) return;
      if (!payload) return;
      if (payload.type === 'ready') {
        instance.readyFull = true;
        instance.clearWatchdog();
        instance.onReady(payload.detail || {});
      } else if (payload.type === 'profile') {
        instance.onProfile(payload.detail || {});
      } else if (payload.type === 'error') {
        instance.onError(new Error((payload.detail && payload.detail.message) || '画面采集失败'));
      }
    });
  }

  async listSources() {
    let sources = [];
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
      });
    } catch {
      sources = [];
    }
    const screens = [];
    const windows = [];
    for (const s of sources) {
      const item = {
        id: s.id,
        name: s.name || '未命名画面',
        type: String(s.id).startsWith('screen') ? 'screen' : 'window',
        thumbnail: '',
      };
      try {
        if (s.thumbnail && !s.thumbnail.isEmpty()) item.thumbnail = s.thumbnail.toDataURL();
      } catch {
        /* ignore */
      }
      if (item.type === 'screen') screens.push(item);
      else windows.push(item);
    }
    windows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
    return screens.concat(windows.slice(0, 24));
  }

  isActive() {
    return !!(this.win && !this.win.isDestroyed() && this.sourceId);
  }

  presetInfo(preset) {
    return PRESETS[preset] || PRESETS.hd;
  }

  createWindow() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      width: 480,
      height: 270,
      show: false,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      fullscreenable: false,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'capture.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        devTools: false,
        // 窗口隐藏时仍保持实时采集编码，否则画面会掉帧
        backgroundThrottling: false,
      },
    });
    this.win = win;
    captureWindowId = win.webContents.id;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      captureWindowId = 0;
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'live-capture.html')).catch(() => {
      this.onError(new Error('画面采集窗口加载失败'));
    });
    return win;
  }

  configFor() {
    const p = this.presetInfo(this.preset);
    return {
      sourceId: this.sourceId,
      preset: p.key,
      label: p.label,
      fps: p.fps,
      hdBitrate: p.hdBitrate,
      webBitrate: p.webBitrate,
    };
  }

  pushConfig() {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      this.win.webContents.send('live:capture-config', this.configFor());
    } catch {
      /* ignore */
    }
  }

  async start(options) {
    const opts = options || {};
    if (opts.preset && PRESETS[opts.preset]) this.preset = opts.preset;
    this.sourceId = opts.sourceId || this.sourceId || '';
    this.viewers.clear();
    this.readyFull = false;
    this.createWindow();
    if (!this.sourceId) {
      const list = await this.listSources();
      const first = list.length ? list[0].id : '';
      if (!first) throw new Error('未找到可采集的屏幕画面');
      this.sourceId = first;
    }
    this.pushConfig();
    this.armWatchdog();
    return this.configFor();
  }

  // 每个观看者独立编码，保证每个观看者都从关键帧开始，接入即可出画
  startViewer(viewerId, quality) {
    if (!this.win || this.win.isDestroyed() || !viewerId) return false;
    const kind = quality === 'web' ? 'web' : 'hd';
    this.viewers.add(viewerId);
    try {
      this.win.webContents.send('live:viewer-start', { viewerId, quality: kind });
    } catch {
      this.viewers.delete(viewerId);
      return false;
    }
    return true;
  }

  stopViewer(viewerId) {
    if (!viewerId) return;
    this.viewers.delete(viewerId);
    if (!this.win || this.win.isDestroyed()) return;
    try {
      this.win.webContents.send('live:viewer-stop', viewerId);
    } catch {
      /* ignore */
    }
  }

  async setSource(sourceId) {
    if (!sourceId) return null;
    this.sourceId = sourceId;
    this.readyFull = false;
    this.pushConfig();
    this.armWatchdog();
    return this.configFor();
  }

  async setPreset(preset) {
    if (PRESETS[preset]) this.preset = preset;
    this.pushConfig();
    return this.configFor();
  }

  armWatchdog() {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      if (!this.readyFull) {
        this.onError(new Error('画面采集无响应，请检查系统是否允许屏幕捕获'));
      }
    }, 25000);
  }

  clearWatchdog() {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  stop() {
    this.clearWatchdog();
    this.sourceId = '';
    this.viewers.clear();
    this.readyFull = false;
    const win = this.win;
    this.win = null;
    captureWindowId = 0;
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('live:capture-stop');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          if (!win.isDestroyed()) win.destroy();
        } catch {
          /* ignore */
        }
      }, 120);
    }
    return { stopped: true };
  }
}

module.exports = { ScreenCapture, PRESETS };
