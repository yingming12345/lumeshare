// 隐藏播放窗口的预加载：只暴露播放/停止与状态回报
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumeMusic', {
  onPlay: (cb) => {
    ipcRenderer.on('music:play', (_e, data) => cb(data || {}));
  },
  onStop: (cb) => {
    ipcRenderer.on('music:stop', () => cb());
  },
  report: (state) => ipcRenderer.send('music:state', state || {}),
});
