// 更新弹窗：自动检测 / 手动检查更新，强制更新与可选更新两种模式
import { icons } from './icons.js';
import { escapeHtml } from './util.js';
import { toast } from './files.js';

let dialogEl = null;
let escHandler = null;

function closeUpdateDialog() {
  if (dialogEl) {
    dialogEl.remove();
    dialogEl = null;
  }
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
}

// 检查更新；有更新则弹出对话框
// opts.auto: 是否由启动自动检测触发（被用户取消过的版本不再自动弹窗）
// 返回 { hasUpdate, forceUpdate, error } 或 null（无更新）
export async function checkAndShowUpdate(opts = {}) {
  const auto = !!opts.auto;
  let info;
  try {
    const r = await window.lume.update.check();
    if (r.ok === false) {
      if (!auto) toast('检查更新失败：' + (r.error || '无法连接更新服务器'), 'error');
      return { hasUpdate: false, error: r.error };
    }
    info = r;
  } catch (e) {
    if (!auto) toast('检查更新失败：' + e.message, 'error');
    return { hasUpdate: false, error: e.message };
  }

  if (!info.hasUpdate) {
    if (!auto) toast('已是最新版本', 'success');
    return { hasUpdate: false };
  }

  // 自动检测时：该版本若已被用户取消过，本次不再打扰
  if (auto && info.code) {
    try {
      const s = await window.lume.settings.get();
      if (s && s.updateDismissedCode === info.code) return { hasUpdate: false };
    } catch {
      /* ignore */
    }
  }

  showUpdateDialog(info, auto);
  return { hasUpdate: true, forceUpdate: info.forceUpdate };
}

function showUpdateDialog(info, auto) {
  closeUpdateDialog();
  const root = document.getElementById('modal-root');
  dialogEl = document.createElement('div');
  dialogEl.className = 'overlay update-overlay';
  dialogEl.innerHTML =
    '<div class="update-dialog">' +
    '<div class="ud-icon">' + icons.download + '</div>' +
    '<h2 class="ud-title">发现新版本</h2>' +
    '<p class="ud-text">检测到新版本' +
    (info.latestVersion ? ' v' + escapeHtml(info.latestVersion) : '') +
    '（更新日期 ' + escapeHtml(info.date || '-') + '），是否立即下载更新？</p>' +
    '<p class="ud-sub">' +
    (info.forceUpdate ? '此版本为强制更新，更新后才能继续使用' : '此版本为可选更新，也可以稍后在设置中手动检查') +
    '</p>' +
    '<div class="ud-progress hidden"><div class="progress-bar"><div id="ud-fill" class="progress-fill"></div></div>' +
    '<span id="ud-pct" class="progress-text">0%</span></div>' +
    '<div class="ud-actions">' +
    (info.forceUpdate ? '' : '<button id="ud-cancel" class="btn btn-ghost">取消</button>') +
    '<button id="ud-download" class="ud-download-btn">' + icons.download + '下载更新</button>' +
    '</div></div>';
  root.appendChild(dialogEl);

  // 非强制更新：允许点击遮罩关闭、Esc 关闭；强制更新时禁止一切关闭方式
  if (!info.forceUpdate) {
    dialogEl.addEventListener('mousedown', (e) => {
      if (e.target === dialogEl) closeUpdateDialog();
    });
    escHandler = (e) => {
      if (e.key === 'Escape') closeUpdateDialog();
    };
    document.addEventListener('keydown', escHandler);
  }

  const downloadBtn = dialogEl.querySelector('#ud-download');
  const cancelBtn = dialogEl.querySelector('#ud-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      // 记录本次取消的版本，自动检测时不再打扰
      window.lume.settings.set({ updateDismissedCode: info.code }).catch(() => {});
      closeUpdateDialog();
      toast('已取消更新，可在设置中手动检查', 'info');
    });
  }

  downloadBtn.addEventListener('click', async () => {
    downloadBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    const prog = dialogEl.querySelector('.ud-progress');
    const textEl = dialogEl.querySelector('.ud-text');
    const fill = dialogEl.querySelector('#ud-fill');
    const pct = dialogEl.querySelector('#ud-pct');
    prog.classList.remove('hidden');
    textEl.textContent = '正在下载新版本…';

    const off = window.lume.update.onProgress((p) => {
      fill.style.width = (p.percent || 0) + '%';
      pct.textContent = (p.percent || 0) + '%';
    });
    try {
      const dl = await window.lume.update.download({ url: info.url });
      if (!dl.ok) throw new Error(dl.error || '下载失败');
      fill.style.width = '100%';
      pct.textContent = '100%';
      textEl.textContent = '下载完成，正在启动安装程序…';
      downloadBtn.textContent = '正在安装…';
      const ap = await window.lume.update.apply({ path: dl.path, code: info.code });
      if (!ap.ok) throw new Error(ap.error || '安装程序启动失败');
      toast('新版本安装程序已启动，将自动完成更新', 'success');
      setTimeout(() => window.lume.win.close(), 1200);
    } catch (e) {
      textEl.textContent = '更新失败：' + e.message;
      toast('更新失败：' + e.message, 'error');
      downloadBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
    } finally {
      if (off) off();
    }
  });
}

// 启动时自动检测（静默，有更新才弹窗）
export function autoCheckOnStart() {
  setTimeout(() => {
    checkAndShowUpdate({ auto: true }).catch(() => {});
  }, 2500);
}
