// 局域网分享视图：上传（点击/拖拽/粘贴）、提取码、获取文件（发现设备 + 预览/下载）
import { icons, iconFor } from './icons.js';
import { formatSize, escapeHtml, copyText, fileKind, baseName } from './util.js';
import { openImageViewer, openPdfViewer, openWordViewer } from './viewers.js';
import { toast } from './files.js';
import qrcode from 'qrcode-generator';

// 生成二维码 SVG（手机扫码即可打开分享页面，无需手动输入地址）
function qrSvg(text, cellSize) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(String(text || ''));
    qr.make();
    return qr.createSvgTag({ cellSize: cellSize || 4, margin: 2 });
  } catch {
    return '';
  }
}

const state = {
  active: false,
  info: null, // { port, urls }
  base: null, // http://127.0.0.1:port
  uploading: false,
  recent: [],
  servers: [],
  listeners: [],
};

function el(id) {
  return document.getElementById(id);
}

export function initShareView() {
  bindControls();

  el('file-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) uploadFiles(files);
  });

  window.addEventListener('paste', (e) => {
    if (!state.active) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      uploadFiles(files);
    }
  });
}

function bindControls() {
  const zone = el('drop-zone');

  zone.addEventListener('click', (e) => {
    if (e.target.closest('#upload-btn') || e.target === zone) {
      el('file-input').click();
    }
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add('drag-over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
    })
  );
  zone.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) uploadFiles(files);
  });

  el('copy-code-btn').addEventListener('click', async () => {
    const code = el('share-code').textContent.trim();
    const ok = await copyText(code);
    toast(ok ? '提取码已复制' : '复制失败', ok ? 'success' : 'error');
  });
  el('copy-url-btn').addEventListener('click', async () => {
    const ok = await copyText(state.lastShareUrl || state.currentUrl || '');
    toast(ok ? '链接已复制' : '复制失败', ok ? 'success' : 'error');
  });
  el('copy-link-btn').addEventListener('click', async () => {
    const ok = await copyText(state.lastShareUrl || state.currentUrl || '');
    toast(ok ? '链接已复制' : '复制失败', ok ? 'success' : 'error');
  });

  // 手机扫码：展示分享页面二维码，手机扫一下即可打开
  el('share-qr-btn').addEventListener('click', () => {
    if (!state.info || !state.info.port) {
      toast('请先开启分享服务，再生成扫码链接', 'error');
      return;
    }
    const url = state.lastShareUrl || state.currentUrl || state.base;
    showQrDialog(url);
  });

  // 开启 / 关闭分享服务
  el('share-toggle-btn').addEventListener('click', () => toggleShareService());

  // 获取文件（胶囊按钮）
  el('fetch-toggle').addEventListener('click', () => {
    const panel = el('fetch-panel');
    const open = !panel.classList.contains('hidden');
    panel.classList.toggle('hidden', open);
    el('fetch-toggle').classList.toggle('active', !open);
    if (!open) refreshDeviceOptions();
  });

  el('fetch-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });
  el('fetch-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doFetch();
  });
  el('fetch-btn').addEventListener('click', doFetch);

  el('fetch-device').addEventListener('change', (e) => {
    el('manual-addr-wrap').classList.toggle('hidden', e.target.value !== 'manual');
  });
}

// 进入分享视图：读取当前服务状态并展示（不自动启动，由用户开关决定）
export async function activateShareView() {
  state.active = true;
  try {
    const st = await window.lume.share.status();
    if (st && st.running && st.port) {
      state.info = { port: st.port, urls: st.urls || [] };
      state.base = 'http://127.0.0.1:' + st.port;
      state.currentUrl = st.urls && st.urls[0] ? st.urls[0].url : state.base;
      renderStatus();
      renderRecent();
    } else {
      state.info = null;
      state.base = null;
      state.currentUrl = null;
      renderOff();
    }
  } catch {
    state.info = null;
    renderOff();
  }
  renderShareToggle();
  refreshDeviceOptions();
}

export function deactivateShareView() {
  state.active = false;
}

function renderShareToggle() {
  const btn = el('share-toggle-btn');
  const txt = el('share-toggle-text');
  if (!btn || !txt) return;
  const on = !!(state.info && state.info.port);
  txt.textContent = on ? '关闭分享' : '开启分享';
  btn.classList.toggle('btn-primary', !on);
  btn.classList.toggle('btn-ghost', on);
  btn.title = on ? '停止分享服务，链接将无法访问' : '启动分享服务';
  setServiceUi(on);
}

// 按服务开关状态同步页面 UI（提示条 / 上传区 / 复制链接按钮）
function setServiceUi(on) {
  const tip = el('share-off-tip');
  if (tip) tip.classList.toggle('hidden', !!on);
  const zone = el('drop-zone');
  if (zone) zone.classList.toggle('disabled', !on);
  const copy = el('copy-link-btn');
  if (copy) {
    copy.disabled = !on;
    copy.title = on ? '复制分享链接' : '分享服务未开启，暂时无法复制链接';
  }
}

// 开启 / 关闭分享服务
async function toggleShareService() {
  const btn = el('share-toggle-btn');
  btn.disabled = true;
  try {
    const on = !!(state.info && state.info.port);
    if (on) {
      await window.lume.share.stop();
      state.info = null;
      state.base = null;
      state.currentUrl = null;
      state.recent = [];
      el('recent-wrap')?.classList.add('hidden');
      const grid = el('recent-list');
      if (grid) grid.innerHTML = '';
      const box = el('share-success');
      if (box) box.classList.add('hidden');
      renderOff();
      toast('分享服务已关闭，之前的链接已不可访问', 'info');
    } else {
      const info = await window.lume.share.start();
      state.info = info;
      state.base = 'http://127.0.0.1:' + info.port;
      state.currentUrl = info.urls && info.urls[0] ? info.urls[0].url : state.base;
      renderStatus();
      renderRecent();
      toast('分享服务已开启', 'success');
    }
  } catch (e) {
    toast('操作失败：' + (e && e.message), 'error');
  } finally {
    btn.disabled = false;
    renderShareToggle();
    refreshDeviceOptions();
  }
}

function renderOff() {
  const chip = el('share-status-chip');
  if (chip) {
    chip.className = 'chip chip-off';
    chip.textContent = '服务未启动';
  }
  const url = el('share-url');
  if (url) url.textContent = '';
}

function renderStatus() {
  const chip = el('share-status-chip');
  if (state.info && state.info.port) {
    chip.className = 'chip chip-on';
    chip.innerHTML =
      '<span class="chip-dot"></span>服务运行中 · <span class="chip-url">' + escapeHtml(state.currentUrl) + '</span>';
  }
  el('share-url').textContent = state.currentUrl || '';
}

// ---------- 上传 ----------
function uploadFiles(files) {
  if (!state.base) return;
  if (state.uploading) {
    toast('已有文件在上传中，请稍候', 'info');
    return;
  }
  state.uploading = true;
  el('drop-zone').classList.add('hidden');
  el('uploading-card').classList.remove('hidden');

  const total = files.length;
  let done = 0;
  el('upload-status').textContent = '正在上传 0 / ' + total;

  const jobs = files.map(async (file) => {
    try {
      const resp = await fetch(state.base + '/api/upload', {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent(file.name) },
        body: file,
      });
      const json = await resp.json();
      if (!resp.ok || !json.code) throw new Error(json.error || '上传失败');
      return json;
    } catch (e) {
      throw e;
    } finally {
      done++;
      el('upload-status').textContent = '正在上传 ' + done + ' / ' + total;
    }
  });

  Promise.allSettled(jobs).then((results) => {
    state.uploading = false;
    el('drop-zone').classList.remove('hidden');
    el('uploading-card').classList.add('hidden');
    const okList = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = results.length - okList.length;

    if (okList.length) {
      for (const r of okList) addRecent(r);
      const last = okList[okList.length - 1];
      showSuccess(last);
    }
    if (failed) toast(failed + ' 个文件上传失败', 'error');
    if (okList.length && !failed) toast('分享成功，共生成 ' + okList.length + ' 个提取码', 'success');
  });
}

function showSuccess(rec) {
  const box = el('share-success');
  box.classList.remove('hidden');
  el('share-code').textContent = rec.code;
  el('share-file-name').textContent = rec.name;
  el('share-file-size').textContent = formatSize(rec.size);
  const link = rec.webUrl || (state.currentUrl + '/?code=' + rec.code);
  state.lastShareUrl = link;
  el('share-url').textContent = link;
  // 文件链接二维码：手机扫码直接进入提取页面
  const qrBox = el('share-qr');
  if (qrBox) {
    qrBox.innerHTML = qrSvg(link, 4);
    qrBox.classList.toggle('hidden', !qrBox.innerHTML);
  }
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// 手机扫码弹窗：展示当前分享页面二维码
function showQrDialog(url) {
  const root = document.getElementById('modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'overlay qr-overlay';
  wrap.innerHTML =
    '<div class="qr-dialog">' +
    '<div class="qr-title">手机扫码打开分享页面</div>' +
    '<div class="qr-box">' + qrSvg(url, 6) + '</div>' +
    '<div class="qr-url">' + escapeHtml(url) + '</div>' +
    '<p class="qr-hint">手机连接同一个 Wi-Fi 后扫码即可在浏览器中获取文件，无需安装任何软件</p>' +
    '<div class="qr-actions">' +
    '<button class="btn btn-ghost" id="qr-copy">复制链接</button>' +
    '<button class="btn btn-primary" id="qr-close">完成</button>' +
    '</div></div>';
  root.appendChild(wrap);

  const close = () => wrap.remove();
  wrap.addEventListener('mousedown', (e) => {
    if (e.target === wrap) close();
  });
  wrap.querySelector('#qr-close').addEventListener('click', close);
  wrap.querySelector('#qr-copy').addEventListener('click', async () => {
    const ok = await copyText(url);
    toast(ok ? '链接已复制' : '复制失败', ok ? 'success' : 'error');
  });
  const onKey = (e) => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
}

function addRecent(rec) {
  state.recent.unshift(rec);
  renderRecent();
}

function renderRecent() {
  const listEl = el('recent-list');
  const wrap = el('recent-wrap');
  wrap.classList.toggle('hidden', state.recent.length === 0);
  listEl.innerHTML = state.recent
    .map(
      (r) =>
        '<div class="recent-item" data-code="' + r.code + '">' +
        '<span class="row-icon row-icon-file">' + icons.file + '</span>' +
        '<div class="recent-main"><span class="recent-name">' + escapeHtml(r.name) + '</span>' +
        '<span class="recent-sub">' + r.sizeText + ' · 提取码 ' + r.code + '</span></div>' +
        '<div class="recent-actions">' +
        '<button class="row-btn" data-act="copy" title="复制提取码">' + icons.copy + '</button>' +
        '<button class="row-btn" data-act="copylink" title="复制分享链接">' + icons.link + '</button>' +
        '<button class="row-btn" data-act="del" title="移除">' + icons.trash + '</button>' +
        '</div></div>'
    )
    .join('');
}

el('recent-list')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.row-btn');
  if (!btn) return;
  const itemEl = btn.closest('.recent-item');
  const code = itemEl.dataset.code;
  const rec = state.recent.find((r) => r.code === code);
  if (!rec) return;
  if (btn.dataset.act === 'copy') {
    const ok = await copyText(code);
    toast(ok ? '提取码已复制' : '复制失败', ok ? 'success' : 'error');
  } else if (btn.dataset.act === 'copylink') {
    const link = rec.webUrl || (state.currentUrl + '/?code=' + code);
    const ok = await copyText(link);
    toast(ok ? '分享链接已复制' : '复制失败', ok ? 'success' : 'error');
  } else if (btn.dataset.act === 'del') {
    try {
      await fetch(state.base + '/api/file/' + code, { method: 'DELETE' });
    } catch {
      /* ignore */
    }
    await window.lume.share.remove(code);
    state.recent = state.recent.filter((r) => r.code !== code);
    renderRecent();
  }
});

// ---------- 获取文件 ----------
function resolveBase() {
  const sel = el('fetch-device').value;
  if (sel === 'local') return state.base;
  if (sel === 'manual') {
    const v = el('manual-addr').value.trim().replace(/^https?:\/\//, '');
    if (!v) return null;
    return 'http://' + v;
  }
  return sel || null;
}

async function refreshDeviceOptions() {
  const sel = el('fetch-device');
  const prev = sel.value;
  const servers = await window.lume.share.status().then(() => state.servers);
  const opts = ['<option value="local">本机（当前电脑）</option>'];
  for (const s of servers) {
    opts.push('<option value="' + escapeHtml(s.url) + '">' + escapeHtml(s.name + ' · ' + s.ip) + '</option>');
  }
  opts.push('<option value="manual">手动输入地址…</option>');
  sel.innerHTML = opts.join('');
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function doFetch() {
  const code = el('fetch-code').value.trim();
  if (!/^\d{6}$/.test(code)) {
    toast('请输入 6 位数字提取码', 'error');
    return;
  }
  const base = resolveBase();
  if (!base) {
    if (el('fetch-device').value === 'local') toast('本机分享服务未开启，无法从本机获取文件', 'error');
    else toast('请先选择设备或输入服务器地址', 'error');
    return;
  }
  el('fetch-btn').disabled = true;
  el('fetch-btn').textContent = '获取中…';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const resp = await fetch(base + '/api/info/' + code, { signal: ctrl.signal });
    if (resp.status === 404) {
      toast('提取码不存在或已过期', 'error');
      return;
    }
    const info = await resp.json();
    if (!info.name) {
      toast('获取失败', 'error');
      return;
    }
    state.fetchBase = base;
    state.fetchInfo = { ...info, code };
    window.lume.log.event({ action: 'share:fetch', detail: { code, name: info.name, size: info.size } });
    renderFetchResult(info, base);
  } catch (e) {
    console.error('[fetch] 提取失败:', e);
    toast('无法连接到该设备，请检查地址与网络', 'error');
  } finally {
    clearTimeout(timer);
    el('fetch-btn').disabled = false;
    el('fetch-btn').textContent = '获取';
  }
}

function renderFetchResult(info, base) {
  const kind = fileKind(info.name.split('.').pop());
  const box = el('fetch-result');
  box.innerHTML =
    '<div class="fetch-card">' +
    '<span class="row-icon row-icon-' + kind + '">' + iconFor(kind) + '</span>' +
    '<div class="fetch-main"><span class="recent-name">' + escapeHtml(info.name) + '</span>' +
    '<span class="recent-sub">' + info.sizeText + ' · 来自 ' + escapeHtml(base) + '</span></div>' +
    '<div class="fetch-actions">' +
    '<button class="btn btn-primary" id="fetch-preview">预览</button>' +
    '<button class="btn btn-ghost" id="fetch-download">下载到…</button>' +
    '<button class="row-btn" id="fetch-clear" title="关闭">' + icons.close + '</button>' +
    '</div></div>';
  box.classList.remove('hidden');
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const item = { ...info, kind };
  el('fetch-preview').addEventListener('click', () => previewFetchItem(item, base));
  el('fetch-download').addEventListener('click', () => downloadFetchItem(item, base));
  el('fetch-clear').addEventListener('click', () => box.classList.add('hidden'));
}

function isLocalBase(base) {
  try {
    const u = new URL(base);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

async function previewFetchItem(item, base) {
  const url = base + '/api/file/' + item.code;
  toast('正在加载预览…', 'info');
  try {
    if (item.kind === 'image') {
      const blob = await (await fetch(url)).blob();
      const objectUrl = URL.createObjectURL(blob);
      openImageViewer({
        total: 1,
        getItem: () => Promise.resolve({ name: item.name, src: objectUrl, code: item.code }),
        initialIndex: 0,
        downloadItem: () => downloadFetchItem(item, base),
      });
    } else if (item.kind === 'pdf') {
      const buf = await (await fetch(url)).arrayBuffer();
      await openPdfViewer({
        name: item.name,
        data: buf,
        downloadItem: () => downloadFetchItem(item, base),
      });
    } else if (item.kind === 'word') {
      const buf = await (await fetch(url)).arrayBuffer();
      await openWordViewer({
        name: item.name,
        data: buf,
        downloadItem: () => downloadFetchItem(item, base),
      });
    } else {
      toast('该格式暂不支持预览，可直接下载', 'info');
      downloadFetchItem(item, base);
    }
  } catch {
    toast('预览加载失败', 'error');
  }
}

async function downloadFetchItem(item, base) {
  if (isLocalBase(base) && window.lume.share) {
    const r = await window.lume.share.pickSave(item.code);
    if (r && r.canceled) return;
    if (r && r.ok) toast('已保存到 ' + r.dest, 'success');
    else toast('保存失败：' + (r && r.error), 'error');
    return;
  }
  const destDir = await window.lume.file.pickFolder({ title: '选择保存位置' });
  if (!destDir) return;
  toast('正在下载…', 'info');
  try {
    const blob = await (await fetch(base + '/api/file/' + item.code)).blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const r = await window.lume.file.saveData({ data: b64, name: item.name });
    if (r && r.ok) toast('已保存到 ' + r.dest, 'success');
    else toast('保存失败：' + (r && r.error), 'error');
  } catch {
    toast('下载失败', 'error');
  }
}

// ---------- 分享事件绑定 ----------
export function bindShareEvents() {
  window.lume.share.onServers((list) => {
    state.servers = list;
    refreshDeviceOptions();
  });
  window.lume.share.onUploaded((rec) => {
    // 局域网网页端上传的文件也会出现在这里
    if (!state.recent.some((r) => r.code === rec.code)) addRecent(rec);
    if (state.active) showSuccess(rec);
  });
  window.lume.share.onCleared(() => {
    // 设置页一键清空后：清空本会话记录与分享成功卡片
    state.recent = [];
    el('recent-wrap')?.classList.add('hidden');
    const grid = el('recent-list');
    if (grid) grid.innerHTML = '';
    const box = el('share-success');
    if (box) box.classList.add('hidden');
  });
}
