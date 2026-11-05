// 查看器弹窗：图片 / PDF / Word / 视频（只读，不可编辑）
import { icons } from './icons.js';
import { shareLocalPath } from './shareaction.js';
import * as pdfjsLib from 'pdfjs-dist';
import * as docxPreview from 'docx-preview';

let pdfjs = null;
let docxRender = null;
let currentModal = null;

// 按需加载 PDF worker（约 1 MB），避免启动时解析大脚本拖慢首屏
function loadPdfWorkerScript() {
  if (window.__PDF_WORKER_SRC__) return Promise.resolve();
  if (window.__pdfWorkerLoading) return window.__pdfWorkerLoading;
  window.__pdfWorkerLoading = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'dist/pdf.worker.src.js';
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.appendChild(script);
  });
  return window.__pdfWorkerLoading;
}

export async function ensurePdfjs() {
  if (pdfjs) return pdfjs;
  await loadPdfWorkerScript();
  const workerSrc = window.__PDF_WORKER_SRC__;
  if (workerSrc) {
    try {
      const url = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
      pdfjsLib.GlobalWorkerOptions.workerSrc = url;
    } catch {
      /* 兜底：主线程 fake worker */
    }
  }
  pdfjs = pdfjsLib;
  return pdfjs;
}

export async function ensureDocx() {
  if (docxRender) return docxRender;
  docxRender = docxPreview;
  return docxRender;
}

function closeCurrent() {
  if (currentModal) {
    try {
      currentModal.close();
    } catch {
      /* ignore */
    }
    currentModal = null;
  }
}

function openModal(bodyHtml) {
  closeCurrent();
  const root = document.getElementById('modal-root');
  const overlay = document.createElement('div');
  overlay.className = 'overlay viewer-overlay';
  overlay.innerHTML = bodyHtml;
  root.appendChild(overlay);

  let closed = false;
  const modal = {
    el: overlay,
    close() {
      if (closed) return;
      closed = true;
      overlay.remove();
      currentModal = null;
    },
  };
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) modal.close();
  });
  currentModal = modal;
  return modal;
}

// ---------- 图片查看器 ----------
export function openImageViewer(opts) {
  const { total, getItem, initialIndex = 0, downloadItem, revealPath } = opts;
  const modal = openModal(`
    <div class="viewer img-viewer">
      <div class="viewer-top">
        <div class="v-title">
          <span class="v-name" id="iv-name"></span>
          <span class="v-counter" id="iv-counter"></span>
        </div>
        <div class="v-actions">
          <button class="v-btn v-btn-text iv-share" id="iv-share" title="一键分享（生成提取码并复制链接）" disabled>${icons.share}<span>分享</span></button>
          <button class="v-btn" id="iv-reveal" title="打开所在位置">${icons.folder}</button>
          <button class="v-btn" id="iv-download" title="下载到…">${icons.download}</button>
          <button class="v-btn v-close" id="iv-close" title="关闭">${icons.close}</button>
        </div>
      </div>
      <div class="iv-stage" id="iv-stage">
        <div class="iv-frame" id="iv-frame">
          <img id="iv-img" alt="" draggable="false">
          <div class="iv-loading" id="iv-loading">${icons.spinner}</div>
          <div class="iv-error hidden" id="iv-error">无法加载这张图片</div>
        </div>
        <button class="iv-arrow iv-prev" id="iv-prev" title="上一张">${icons.chevronL}</button>
        <button class="iv-arrow iv-next" id="iv-next" title="下一张">${icons.chevronR}</button>
      </div>
      <div class="viewer-bottom">
        <button class="v-btn" id="iv-zoomin" title="放大">${icons.zoomIn}</button>
        <span class="v-zoomval" id="iv-zoomval">100%</span>
        <button class="v-btn" id="iv-zoomout" title="缩小">${icons.zoomOut}</button>
        <button class="v-btn v-btn-text" id="iv-fit">适应窗口</button>
      </div>
    </div>
  `);

  const stage = modal.el.querySelector('#iv-stage');
  const frame = modal.el.querySelector('#iv-frame');
  const img = modal.el.querySelector('#iv-img');
  const loading = modal.el.querySelector('#iv-loading');
  const errorEl = modal.el.querySelector('#iv-error');
  const nameEl = modal.el.querySelector('#iv-name');
  const counterEl = modal.el.querySelector('#iv-counter');
  const zoomValEl = modal.el.querySelector('#iv-zoomval');
  const shareBtn = modal.el.querySelector('#iv-share');

  function syncShareButton() {
    const canShare = !!(item && item.path);
    shareBtn.disabled = !canShare;
    shareBtn.title = canShare ? '一键分享这张图片（生成提取码并复制链接）' : '仅支持分享本机文件';
  }

  let index = initialIndex;
  let item = null;
  let free = false; // false = 居中适配；true = 自由缩放平移
  let scale = 1;
  let tx = 0; // 相对中心的偏移（仅拖拽产生）
  let ty = 0;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // 居中适配：CSS 负责把图片放在正中心（max-size + translate(-50%,-50%)），
  // 不给任何 transform 覆盖 → 无论是否滚轮，只要用户不拖拽就固定居中。
  function resetToFit() {
    free = false;
    scale = 1;
    tx = 0;
    ty = 0;
    img.classList.remove('free');
    img.style.transform = 'translate(-50%, -50%)';
    zoomValEl.textContent = '适应窗口';
  }

  function applyTransform() {
    img.style.transform =
      'translate(calc(-50% + ' + tx + 'px), calc(-50% + ' + ty + 'px)) scale(' + scale + ')';
    zoomValEl.textContent = Math.round(scale * 100) + '%';
  }

  // 进入自由缩放（围绕图片自身中心缩放 → 图片保持居中，不跑偏）
  function enterFree(step) {
    if (!free) {
      free = true;
      img.classList.add('free');
      // 进入时先等比放大到实际像素 1:1 附近，保持居中
      const r = stage.getBoundingClientRect();
      const iw = img.naturalWidth || r.width;
      const ih = img.naturalHeight || r.height;
      const base = Math.min(r.width / iw, r.height / ih, 1);
      scale = clamp((step === 0 ? base : 1) * 1, 0.2, 12);
      tx = 0;
      ty = 0;
      applyTransform();
    }
  }

  function setLoading(on) {
    loading.classList.toggle('hidden', !on);
    errorEl.classList.add('hidden');
  }

  async function load(i) {
    index = ((i % total) + total) % total;
    setLoading(true);
    img.style.opacity = '0';
    try {
      item = await getItem(index);
      if (!item || !item.src) throw new Error('no item');
      img.src = item.src;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });
      nameEl.textContent = item.name || '';
      counterEl.textContent = '第 ' + (index + 1) + ' / ' + total + ' 张';
      errorEl.classList.add('hidden');
      resetToFit();
      img.style.opacity = '1';
    } catch {
      errorEl.classList.remove('hidden');
      nameEl.textContent = item ? item.name : '';
      counterEl.textContent = '第 ' + (index + 1) + ' / ' + total + ' 张';
    } finally {
      syncShareButton();
      setLoading(false);
    }
  }

  function step(dir) {
    load(index + dir);
  }

  // 滚轮：未进入自由态时首次滚动 → 进入自由态（仍居中）再缩放；
  // 缩放始终围绕图片自身中心（transform-origin:center），所以图片保持居中不跑偏。
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!free) {
      enterFree(1);
      // 让第一步以图片中心为中点：偏移保持 0 → 缩放后仍居中
      const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
      scale = clamp(scale * factor, 0.2, 12);
      tx = 0;
      ty = 0;
      applyTransform();
      return;
    }
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    scale = clamp(scale * factor, 0.2, 12);
    applyTransform();
    // 缩小回 1 且无偏移 → 恢复居中适配
    if (scale <= 1 && tx === 0 && ty === 0) resetToFit();
  }, { passive: false });

  // 拖拽平移（自由态才可拖）
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.iv-arrow, .v-btn')) return;
    if (!free) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    tx += e.clientX - lastX;
    ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    applyTransform();
  });
  stage.addEventListener('pointerup', () => {
    dragging = false;
    stage.classList.remove('dragging');
  });
  stage.addEventListener('pointercancel', () => {
    dragging = false;
    stage.classList.remove('dragging');
  });
  img.addEventListener('dblclick', () => {
    if (free) resetToFit();
    else enterFree(0);
  });

  modal.el.querySelector('#iv-prev').addEventListener('click', () => step(-1));
  modal.el.querySelector('#iv-next').addEventListener('click', () => step(1));
  modal.el.querySelector('#iv-close').addEventListener('click', () => modal.close());
  modal.el.querySelector('#iv-zoomin').addEventListener('click', () => {
    if (!free) enterFree(1);
    else {
      scale = clamp(scale * 1.25, 0.2, 12);
      applyTransform();
    }
  });
  modal.el.querySelector('#iv-zoomout').addEventListener('click', () => {
    if (!free) return;
    scale = clamp(scale / 1.25, 0.2, 12);
    applyTransform();
    if (scale <= 1 && tx === 0 && ty === 0) resetToFit();
  });
  modal.el.querySelector('#iv-fit').addEventListener('click', () => {
    if (item) resetToFit();
  });
  modal.el.querySelector('#iv-download').addEventListener('click', async () => {
    if (item) await downloadItem(item, index);
  });
  shareBtn.addEventListener('click', async () => {
    if (!item || !item.path) return;
    shareBtn.disabled = true;
    try {
      // 前置条件：需先在“局域网分享”中开启分享功能，未开启时由顶部提示条给出错误提示
      await shareLocalPath(item.path, item.name);
    } finally {
      if (item && item.path) shareBtn.disabled = false;
    }
  });
  const revealBtn = modal.el.querySelector('#iv-reveal');
  if (revealPath) {
    revealBtn.addEventListener('click', () => revealPath(item, index));
  } else {
    revealBtn.classList.add('hidden');
  }

  const onKey = (e) => {
    if (e.key === 'Escape') modal.close();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === '+' || e.key === '=') modal.el.querySelector('#iv-zoomin').click();
    else if (e.key === '-') modal.el.querySelector('#iv-zoomout').click();
    else if (e.key === '0') modal.el.querySelector('#iv-fit').click();
  };
  window.addEventListener('keydown', onKey);
  const origClose = modal.close;
  modal.close = () => {
    window.removeEventListener('keydown', onKey);
    origClose();
  };

  load(initialIndex);
  return modal;
}

// =============== PDF 查看器 ===============
export async function openPdfViewer(opts) {
  const { name, data, downloadItem, revealPath } = opts;
  const pdfjsLib = await ensurePdfjs();

  const modal = openModal(`
    <div class="viewer pdf-viewer">
      <div class="viewer-top">
        <div class="v-title">
          <span class="v-name" id="pv-name"></span>
          <span class="v-counter" id="pv-counter"></span>
        </div>
        <div class="v-actions">
          <button class="v-btn" id="pv-reveal" title="打开所在位置">${icons.folder}</button>
          <button class="v-btn" id="pv-download" title="下载到…">${icons.download}</button>
          <button class="v-btn v-close" id="pv-close" title="关闭">${icons.close}</button>
        </div>
      </div>
      <div class="pv-toolbar">
        <button class="v-btn" id="pv-prev" title="上一页">${icons.chevronL}</button>
        <span class="pv-pageinfo" id="pv-pageinfo">1 / 1</span>
        <button class="v-btn" id="pv-next" title="下一页">${icons.chevronR}</button>
        <span class="pv-sep"></span>
        <button class="v-btn" id="pv-zoomin" title="放大">${icons.zoomIn}</button>
        <span class="v-zoomval" id="pv-zoomval">100%</span>
        <button class="v-btn" id="pv-zoomout" title="缩小">${icons.zoomOut}</button>
        <button class="v-btn v-btn-text" id="pv-fit">适应宽度</button>
      </div>
      <div class="pv-scroll" id="pv-scroll">
        <div class="pv-pages">
          <canvas id="pv-canvas"></canvas>
          <div class="iv-loading" id="pv-loading">${icons.spinner}</div>
          <div class="iv-error hidden" id="pv-error">PDF 打开失败或文件已损坏</div>
        </div>
      </div>
    </div>
  `);

  const scrollEl = modal.el.querySelector('#pv-scroll');
  const canvas = modal.el.querySelector('#pv-canvas');
  const ctx = canvas.getContext('2d');
  const nameEl = modal.el.querySelector('#pv-name');
  const pageInfoEl = modal.el.querySelector('#pv-pageinfo');
  const zoomValEl = modal.el.querySelector('#pv-zoomval');
  const loadingEl = modal.el.querySelector('#pv-loading');
  const errorEl = modal.el.querySelector('#pv-error');
  const prevBtn = modal.el.querySelector('#pv-prev');
  const nextBtn = modal.el.querySelector('#pv-next');
  const revealBtn = modal.el.querySelector('#pv-reveal');

  nameEl.textContent = name || 'PDF 文档';

  let pdf = null;
  let pageNum = 1;
  let zoom = 1;
  let renderToken = 0;
  let page = null;

  async function renderPage() {
    const token = ++renderToken;
    loadingEl.classList.remove('hidden');
    errorEl.classList.add('hidden');
    try {
      page = await pdf.getPage(pageNum);
      if (token !== renderToken) return;
      const pad = 48;
      const base = Math.max(scrollEl.clientWidth - pad, 200);
      const fitScale = base / page.view[2];
      const scale = fitScale * zoom;
      const vp = page.getViewport({ scale });
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      if (token !== renderToken) return;
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      if (token !== renderToken) return;
      pageInfoEl.textContent = pageNum + ' / ' + pdf.numPages;
      zoomValEl.textContent = Math.round(zoom * 100) + '%';
      prevBtn.disabled = pageNum <= 1;
      nextBtn.disabled = pageNum >= pdf.numPages;
      loadingEl.classList.add('hidden');
    } catch (e) {
      if (token === renderToken) {
        loadingEl.classList.add('hidden');
        errorEl.classList.remove('hidden');
      }
    }
  }

  function changePage(d) {
    const next = pageNum + d;
    if (next < 1 || next > pdf.numPages) return;
    pageNum = next;
    scrollEl.scrollTop = 0;
    renderPage();
  }

  function changeZoom(delta) {
    zoom = Math.min(4, Math.max(0.3, zoom * delta));
    renderPage();
  }

  try {
    pdf = await pdfjsLib.getDocument({ data }).promise;
  } catch {
    errorEl.classList.remove('hidden');
    loadingEl.classList.add('hidden');
    return modal;
  }

  let wheelTimer = null;
  scrollEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => changeZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1), 60);
  }, { passive: false });

  prevBtn.addEventListener('click', () => changePage(-1));
  nextBtn.addEventListener('click', () => changePage(1));
  modal.el.querySelector('#pv-zoomin').addEventListener('click', () => changeZoom(1.2));
  modal.el.querySelector('#pv-zoomout').addEventListener('click', () => changeZoom(1 / 1.2));
  modal.el.querySelector('#pv-fit').addEventListener('click', () => {
    zoom = 1;
    renderPage();
  });
  modal.el.querySelector('#pv-close').addEventListener('click', () => modal.close());
  modal.el.querySelector('#pv-download').addEventListener('click', () => downloadItem());
  if (revealPath) revealBtn.addEventListener('click', () => revealPath());
  else revealBtn.classList.add('hidden');

  const onKey = (e) => {
    if (e.key === 'Escape') modal.close();
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') changePage(-1);
    else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') changePage(1);
    else if (e.key === '+' || e.key === '=') changeZoom(1.2);
    else if (e.key === '-') changeZoom(1 / 1.2);
    else if (e.key === '0') {
      zoom = 1;
      renderPage();
    }
  };
  window.addEventListener('keydown', onKey);
  const origClose = modal.close;
  modal.close = () => {
    window.removeEventListener('keydown', onKey);
    origClose();
  };

  renderPage();
  return modal;
}

// =============== Word 查看器 ===============
export async function openWordViewer(opts) {
  const { name, data, downloadItem, revealPath } = opts;
  const mod = await ensureDocx();

  const modal = openModal(`
    <div class="viewer word-viewer">
      <div class="viewer-top">
        <div class="v-title">
          <span class="v-name" id="wv-name"></span>
          <span class="v-counter" id="wv-counter">文档预览</span>
        </div>
        <div class="v-actions">
          <button class="v-btn" id="wv-reveal" title="打开所在位置">${icons.folder}</button>
          <button class="v-btn" id="wv-download" title="下载到…">${icons.download}</button>
          <button class="v-btn v-close" id="wv-close" title="关闭">${icons.close}</button>
        </div>
      </div>
      <div class="wv-scroll" id="wv-scroll">
        <div class="wv-doc" id="wv-doc"></div>
        <div class="iv-loading" id="wv-loading">${icons.spinner}</div>
        <div class="iv-error hidden" id="wv-error">无法预览该文档（仅支持 .docx 格式，.doc 请下载后用 Office 打开）</div>
      </div>
    </div>
  `);

  const docEl = modal.el.querySelector('#wv-doc');
  const loadingEl = modal.el.querySelector('#wv-loading');
  const errorEl = modal.el.querySelector('#wv-error');
  const nameEl = modal.el.querySelector('#wv-name');
  nameEl.textContent = name || 'Word 文档';

  modal.el.querySelector('#wv-close').addEventListener('click', () => modal.close());
  modal.el.querySelector('#wv-download').addEventListener('click', () => downloadItem());
  const revealBtn = modal.el.querySelector('#wv-reveal');
  if (revealPath) revealBtn.addEventListener('click', () => revealPath());
  else revealBtn.classList.add('hidden');

  try {
    const blob = new Blob([data], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await mod.renderAsync(blob, docEl, null, {
      inWrapper: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
    });
    loadingEl.classList.add('hidden');
    if (docEl.childElementCount === 0) {
      errorEl.classList.remove('hidden');
    }
  } catch {
    loadingEl.classList.add('hidden');
    errorEl.classList.remove('hidden');
  }

  const onKey = (e) => {
    if (e.key === 'Escape') modal.close();
  };
  window.addEventListener('keydown', onKey);
  const origClose = modal.close;
  modal.close = () => {
    window.removeEventListener('keydown', onKey);
    origClose();
  };

  return modal;
}

// =============== 视频播放器 ===============
export function openVideoViewer(opts) {
  const { name, src, downloadItem, revealPath } = opts;
  const modal = openModal(`
    <div class="viewer video-viewer">
      <div class="viewer-top">
        <div class="v-title">
          <span class="v-name" id="vv-name"></span>
          <span class="v-counter" id="vv-state">视频播放</span>
        </div>
        <div class="v-actions">
          <button class="v-btn" id="vv-reveal" title="打开所在位置">${icons.folder}</button>
          <button class="v-btn" id="vv-download" title="下载到…">${icons.download}</button>
          <button class="v-btn v-close" id="vv-close" title="关闭">${icons.close}</button>
        </div>
      </div>
      <div class="vv-stage">
        <video id="vv-video" controls playsinline preload="metadata"></video>
        <div class="vv-loading" id="vv-loading">${icons.spinner}</div>
      </div>
      <div class="vv-toolbar">
        <button class="v-btn" id="vv-play" title="播放/暂停">${icons.play}</button>
        <input type="range" id="vv-seek" min="0" max="1000" value="0" step="1">
        <span class="vv-time" id="vv-time">0:00 / 0:00</span>
        <label class="vv-speed">
          <select id="vv-speed">
            <option value="0.5">0.5x</option>
            <option value="0.75">0.75x</option>
            <option value="1" selected>1x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
          </select>
        </label>
        <button class="v-btn" id="vv-vol" title="音量">${icons.volume}</button>
        <input type="range" id="vv-volume" min="0" max="100" value="100" step="1">
        <button class="v-btn" id="vv-fullscreen" title="全屏">${icons.fullscreen}</button>
      </div>
    </div>
  `);

  const video = modal.el.querySelector('#vv-video');
  const nameEl = modal.el.querySelector('#vv-name');
  const stateEl = modal.el.querySelector('#vv-state');
  const loadingEl = modal.el.querySelector('#vv-loading');
  const playBtn = modal.el.querySelector('#vv-play');
  const seekEl = modal.el.querySelector('#vv-seek');
  const timeEl = modal.el.querySelector('#vv-time');
  const speedEl = modal.el.querySelector('#vv-speed');
  const volBtn = modal.el.querySelector('#vv-vol');
  const volEl = modal.el.querySelector('#vv-volume');

  nameEl.textContent = name || '视频';
  video.src = src;

  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const pad = (n) => String(n).padStart(2, '0');
    return (h ? h + ':' + pad(m) : m) + ':' + pad(sec);
  };

  const updateUI = () => {
    if (video.duration && isFinite(video.duration)) {
      seekEl.max = 1000;
      seekEl.value = String((video.currentTime / video.duration) * 1000);
      timeEl.textContent = fmt(video.currentTime) + ' / ' + fmt(video.duration);
    }
    playBtn.innerHTML = video.paused ? icons.play : icons.pause;
  };

  video.addEventListener('loadedmetadata', () => {
    loadingEl.classList.add('hidden');
    updateUI();
  });
  video.addEventListener('timeupdate', updateUI);
  video.addEventListener('play', updateUI);
  video.addEventListener('pause', updateUI);
  video.addEventListener('waiting', () => loadingEl.classList.remove('hidden'));
  video.addEventListener('playing', () => {
    loadingEl.classList.add('hidden');
    updateUI();
  });
  video.addEventListener('error', () => {
    loadingEl.classList.add('hidden');
    stateEl.textContent = '视频加载失败或格式不受支持';
  });

  playBtn.addEventListener('click', () => {
    if (video.paused) video.play();
    else video.pause();
  });
  seekEl.addEventListener('input', () => {
    if (video.duration && isFinite(video.duration)) {
      video.currentTime = (Number(seekEl.value) / 1000) * video.duration;
    }
  });
  speedEl.addEventListener('change', () => {
    video.playbackRate = Number(speedEl.value);
  });
  volEl.addEventListener('input', () => {
    video.volume = Number(volEl.value) / 100;
    video.muted = Number(volEl.value) === 0;
  });
  modal.el.querySelector('#vv-fullscreen').addEventListener('click', () => {
    const stage = modal.el.querySelector('.vv-stage');
    if (stage.requestFullscreen) stage.requestFullscreen();
  });

  modal.el.querySelector('#vv-close').addEventListener('click', () => modal.close());
  modal.el.querySelector('#vv-download').addEventListener('click', () => downloadItem());
  const revealBtn = modal.el.querySelector('#vv-reveal');
  if (revealPath) revealBtn.addEventListener('click', () => revealPath());
  else revealBtn.classList.add('hidden');

  const onKey = (e) => {
    if (e.key === 'Escape') modal.close();
    else if (e.key === ' ') {
      e.preventDefault();
      playBtn.click();
    }
  };
  window.addEventListener('keydown', onKey);
  const origClose = modal.close;
  modal.close = () => {
    video.pause();
    video.removeAttribute('src');
    window.removeEventListener('keydown', onKey);
    origClose();
  };

  return modal;
}

// 打开任意查看器（按类型分发）
export async function openFileViewer(kind, opts) {
  if (kind === 'image') return openImageViewer(opts);
  if (kind === 'video') return openVideoViewer(opts);
  if (kind === 'pdf') return openPdfViewer(opts);
  if (kind === 'word') return openWordViewer(opts);
  return null;
}
