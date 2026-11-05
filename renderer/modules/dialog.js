// 通用确认弹窗：替代浏览器原生 confirm，提供美观的样式
// 用法：const ok = await confirmDialog({ title, text, okText, danger })
let openCount = 0;

export function confirmDialog(opts = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    if (!root) {
      resolve(false);
      return;
    }
    const id = 'dlg-' + ++openCount;
    const wrap = document.createElement('div');
    wrap.id = id;
    wrap.className = 'overlay confirm-overlay';
    wrap.innerHTML =
      '<div class="confirm-box">' +
      '<div class="confirm-icon' + (opts.danger ? ' danger' : '') + '">' +
      (opts.danger
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.8L2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="M12 7.5V13"/><path d="M12 16.4h.01"/></svg>') +
      '</div>' +
      '<h3 class="confirm-title">' + (opts.title || '请确认') + '</h3>' +
      '<p class="confirm-text">' + (opts.text || '') + '</p>' +
      '<div class="confirm-actions">' +
      '<button class="btn btn-ghost confirm-cancel">取消</button>' +
      '<button class="btn ' + (opts.danger ? 'btn-danger-solid' : 'btn-primary') + ' confirm-ok">' + (opts.okText || '确定') + '</button>' +
      '</div>' +
      '</div>';
    root.appendChild(wrap);

    let closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
      }
    }
    wrap.addEventListener('mousedown', (e) => {
      if (e.target === wrap) close(false);
    });
    wrap.querySelector('.confirm-cancel').addEventListener('click', () => close(false));
    wrap.querySelector('.confirm-ok').addEventListener('click', () => close(true));
    document.addEventListener('keydown', onKey);
    const okBtn = wrap.querySelector('.confirm-ok');
    if (okBtn) okBtn.focus();
  });
}
