// 顶部下落式提示条：普通（蓝） / 成功（浅绿+深绿勾） / 失败（浅红+深红叉）
const ICON_OK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12.5l4.2 4.2L18 7.6"/></svg>';
const ICON_ERR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>';
const ICON_INFO =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 11v6"/><path d="M12 7.2v.2"/></svg>';

let box = null;

function getBox() {
  if (box && box.isConnected) return box;
  box = document.getElementById('toast-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast-box';
    document.body.appendChild(box);
  }
  return box;
}

// type: 'success' | 'error' | 'info'（普通提示）
export function toast(msg, type) {
  const kind = type === 'error' ? 'error' : type === 'success' ? 'success' : 'info';
  const el = document.createElement('div');
  el.className = 'toast toast-' + kind;
  const icon = kind === 'error' ? ICON_ERR : kind === 'success' ? ICON_OK : ICON_INFO;
  el.innerHTML = '<span class="toast-icon">' + icon + '</span><span class="toast-text"></span>';
  el.querySelector('.toast-text').textContent = String(msg == null ? '' : msg);
  getBox().appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 280);
  }, 2800);
}
