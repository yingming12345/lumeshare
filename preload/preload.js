// 预加载脚本：通过 contextBridge 向渲染层暴露安全的 IPC 接口
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel) {
  return (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('lume', {
  platform: process.platform,

  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('win:maximize-toggle'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    onMaximizedChange: subscribe('win:maximized-change'),
  },

  drives: {
    list: () => ipcRenderer.invoke('drives:list'),
  },

  scan: {
    start: (root) => ipcRenderer.invoke('scan:start', root),
    cancel: () => ipcRenderer.invoke('scan:cancel'),
    data: (payload) => ipcRenderer.invoke('scan:data', payload),
    summary: (root) => ipcRenderer.invoke('scan:summary', root),
    search: (payload) => ipcRenderer.invoke('scan:search', payload),
    onProgress: subscribe('scan:progress'),
  },

  thumb: (filePath) => ipcRenderer.invoke('thumb:get', filePath),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    cacheInfo: () => ipcRenderer.invoke('settings:cache-info'),
    clearCache: () => ipcRenderer.invoke('settings:clear-cache'),
    pickCacheDir: () => ipcRenderer.invoke('settings:pick-cache-dir'),
    resetCacheDir: () => ipcRenderer.invoke('settings:reset-cache-dir'),
  },

  log: {
    event: (payload) => ipcRenderer.invoke('log:event', payload),
    todaySummary: () => ipcRenderer.invoke('log:today-summary'),
    download: () => ipcRenderer.invoke('log:download'),
  },

  tray: {
    setCloseToTray: (v) => ipcRenderer.invoke('tray:set-close-to-tray', v),
    status: () => ipcRenderer.invoke('tray:status'),
  },

  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: (payload) => ipcRenderer.invoke('update:download', payload),
    apply: (payload) => ipcRenderer.invoke('update:apply', payload),
    onProgress: subscribe('update:progress'),
  },

  file: {
    info: (filePath) => ipcRenderer.invoke('file:info', filePath),
    reveal: (filePath) => ipcRenderer.invoke('file:reveal', filePath),
    open: (filePath) => ipcRenderer.invoke('file:open', filePath),
    copy: (filePath) => ipcRenderer.invoke('file:copy', filePath),
    saveData: (payload) => ipcRenderer.invoke('file:save-data', payload),
    pickFolder: (opts) => ipcRenderer.invoke('dialog:folder', opts),
  },

  share: {
    start: () => ipcRenderer.invoke('share:start'),
    stop: () => ipcRenderer.invoke('share:stop'),
    status: () => ipcRenderer.invoke('share:status'),
    list: () => ipcRenderer.invoke('share:list'),
    remove: (code) => ipcRenderer.invoke('share:remove', code),
    save: (payload) => ipcRenderer.invoke('share:save', payload),
    pickSave: (code) => ipcRenderer.invoke('share:pick-save', code),
    shareFile: (filePath) => ipcRenderer.invoke('share:share-file', filePath),
    storageInfo: () => ipcRenderer.invoke('share:storage-info'),
    setStorageDir: (dir) => ipcRenderer.invoke('share:set-storage-dir', { dir }),
    clearFiles: () => ipcRenderer.invoke('share:clear-files'),
    onCleared: subscribe('share:cleared'),
    onServers: subscribe('share:servers'),
    onUploaded: subscribe('share:uploaded'),
  },

  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  },

  // 屏幕直播（局域网屏幕共享）
  live: {
    sources: () => ipcRenderer.invoke('live:sources'),
    start: (payload) => ipcRenderer.invoke('live:start', payload),
    stop: () => ipcRenderer.invoke('live:stop'),
    status: () => ipcRenderer.invoke('live:status'),
    setPreset: (preset) => ipcRenderer.invoke('live:set-preset', preset),
    setSource: (sourceId) => ipcRenderer.invoke('live:set-source', sourceId),
    resolve: (payload) => ipcRenderer.invoke('live:resolve', payload),
    connect: (payload) => ipcRenderer.invoke('live:connect', payload),
    remoteStatus: (payload) => ipcRenderer.invoke('live:remote-status', payload),
    onViewers: subscribe('live:viewers'),
    onError: subscribe('live:error'),
  },

  // 背景音乐（开关通过设置保存，这里只查询播放状态）
  music: {
    status: () => ipcRenderer.invoke('music:status'),
  },

  // 供自测使用
  selftest: {
    report: (results) => ipcRenderer.send('selftest:report', results),
  },
});
