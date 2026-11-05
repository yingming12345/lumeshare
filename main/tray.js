// 系统托盘：关闭窗口时最小化到托盘（隐藏图标区），支持托盘菜单恢复与退出
const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const settings = require('./settings');

let tray = null;
let winRef = null; // 主窗口引用
let isQuitting = false; // 是否真正退出（托盘菜单触发）

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '..', 'build', 'icon.png');
}

function setQuitting(v) {
  isQuitting = v;
}
function isQuit() {
  return isQuitting;
}

// 绑定主窗口（创建托盘；窗口关闭行为已在 main.js 的 close 事件中处理）
function bind(win) {
  winRef = win;
  ensureTray();
}

function ensureTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(iconPath());
    const t = new Tray(img.resize({ width: 18, height: 18 }));
    t.setToolTip('LumeShare — 双击显示主界面');
    t.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主界面', click: () => showWindow() },
        { label: '关闭到托盘已启用' },
        { type: 'separator' },
        { label: '退出 LumeShare', click: () => quitApp() },
      ])
    );
    t.on('double-click', () => showWindow());
    tray = t;
  } catch {
    /* 托盘创建失败不影响使用 */
  }
}

function showWindow() {
  if (winRef && !winRef.isDestroyed()) {
    winRef.show();
    winRef.focus();
  }
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function destroy() {
  try {
    tray?.destroy();
  } catch {
    /* ignore */
  }
  tray = null;
}

module.exports = { bind, showWindow, quitApp, destroy, setQuitting, isQuit, ensureTray };
