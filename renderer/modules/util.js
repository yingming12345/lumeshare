// 通用工具
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
}

export function formatTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  );
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...args);
      }, ms - (now - last));
    }
  };
}

// 本地文件 -> lume 只读 URL
export function fileUrl(filePath) {
  return 'lume://file/' + encodeURIComponent(filePath);
}

export function fileKind(ext) {
  const e = (ext || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'jfif', 'avif', 'heic', 'heif'].includes(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  if (['doc', 'docx', 'docm', 'dot', 'dotx', 'rtf', 'wps', 'wpt'].includes(e)) return 'word';
  if (['exe', 'msi', 'bat', 'cmd', 'com', 'cpl', 'scr'].includes(e)) return 'app';
  return 'file';
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

export function baseName(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
