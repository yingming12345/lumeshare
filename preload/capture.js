// 画面采集窗口的预加载脚本：只暴露采集与推流所需的最小接口
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liveCapture', {
  onConfig: (cb) => {
    ipcRenderer.on('live:capture-config', (_e, cfg) => cb(cfg));
  },
  onStop: (cb) => {
    ipcRenderer.on('live:capture-stop', () => cb());
  },
  onViewerStart: (cb) => {
    ipcRenderer.on('live:viewer-start', (_e, payload) => cb(payload));
  },
  onViewerStop: (cb) => {
    ipcRenderer.on('live:viewer-stop', (_e, viewerId) => cb(viewerId));
  },
  frame: (viewerId, type, buffer) => {
    ipcRenderer.send('live:viewer-frame', viewerId, type, buffer);
  },
  report: (type, detail) => {
    ipcRenderer.send('live:capture-report', { type, detail });
  },
});
