// 文件库视图：盘符扫描、分类展示、图片网格与列表
import { icons, iconFor } from './icons.js';
import { formatSize, formatTime, escapeHtml, fileUrl } from './util.js';
import { openImageViewer, openPdfViewer, openWordViewer, openVideoViewer } from './viewers.js';
import { getCachedSettings } from './settings.js';
import { toast } from './toast.js';
import { shareLocalPath } from './shareaction.js';

export { toast };

const CATS = [
  { key: 'images', label: '图片' },
  { key: 'videos', label: '视频' },
  { key: 'pdfs', label: 'PDF' },
  { key: 'words', label: 'Word' },
  { key: 'apps', label: '应用' },
  { key: 'others', label: '其他' },
];

const EMPTY_TEXT = {
  images: '这个盘符下还没有扫描到图片，试试切换盘符或重新扫描',
  videos: '这个盘符下还没有扫描到视频文件',
  pdfs: '这个盘符下还没有扫描到 PDF 文件',
  words: '这个盘符下还没有扫描到 Word 文档',
  apps: '这个盘符下还没有扫描到应用程序',
  others: '这个盘符下还没有扫描到其他文件',
};

const CAT_KEY_TO_KIND = {
  images: 'image',
  videos: 'video',
  pdfs: 'pdf',
  words: 'word',
  apps: 'app',
  others: 'file',
};

const state = {
  drives: [],
  drive: null,
  scanning: false,
  cat: 'images',
  sort: 'mtime',
  // 每分类分页状态
  pages: {},
  thumbCache: new Map(),
  imageSource: null,
  observer: null,
  initDone: false,
};

function el(id) {
  return document.getElementById(id);
}

export function initFilesView() {
  if (state.initDone) return;
  state.initDone = true;

  bindControls();
  const isUiTest = new URLSearchParams(window.location.search).has('uitest');
  loadDrives().then(() => {
    // 默认选 C 盘
    const c = state.drives.find((d) => d.name === 'C:');
    state.drive = c ? c.path : state.drives[0]?.path;
    el('drive-select').value = state.drive;
    if (isUiTest) return; // uitest 模式由测试脚本驱动

    const s = getCachedSettings();
    if (s.autoScanOnStart) {
      // 优先扫描上次使用的盘符
      if (s.lastDrive && state.drives.some((d) => d.path === s.lastDrive)) {
        state.drive = s.lastDrive;
        el('drive-select').value = s.lastDrive;
      }
      scan();
    }
  });
}

function bindControls() {
  el('scan-btn').addEventListener('click', () => {
    if (state.scanning) {
      window.lume.scan.cancel();
    } else {
      scan();
    }
  });
  el('scan-cancel').addEventListener('click', () => window.lume.scan.cancel());
  el('drive-select').addEventListener('change', (e) => {
    state.drive = e.target.value;
    loadCachedSummary();
    if (!hasSummary()) scan();
  });
  el('sort-select').addEventListener('change', (e) => {
    state.sort = e.target.value;
    reloadCategory();
  });

  const tabs = el('cat-tabs');
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    setCategory(btn.dataset.cat);
  });

  // 列表“加载更多”
  el('load-more-btn').addEventListener('click', () => loadMoreList());

  // 搜索：跨分类按名称搜索（输入防抖）
  const searchInput = el('search-input');
  const searchClear = el('search-clear');
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    searchClear.classList.toggle('hidden', !q);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(q), 280);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      doSearch(searchInput.value.trim());
    }
    if (e.key === 'Escape') {
      searchInput.value = '';
      searchClear.classList.add('hidden');
      clearTimeout(searchTimer);
      doSearch('');
    }
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.classList.add('hidden');
    clearTimeout(searchTimer);
    doSearch('');
    searchInput.focus();
  });
}

async function loadDrives() {
  state.drives = await window.lume.drives.list();
  const sel = el('drive-select');
  sel.innerHTML = state.drives
    .map((d) => '<option value="' + escapeHtml(d.path) + '">' + escapeHtml(d.name) + (d.isSystem ? '（系统盘）' : '') + '</option>')
    .join('');
}

function hasSummary() {
  return !!state.summary;
}

async function loadCachedSummary() {
  state.summary = await window.lume.scan.summary(state.drive);
  if (state.summary) {
    setCounts(state.summary.counts);
  } else {
    resetCounts();
  }
}

function resetCounts() {
  for (const c of CATS) {
    const n = el('cnt-' + c.key);
    if (n) n.textContent = '-';
  }
}

function setCounts(counts) {
  for (const c of CATS) {
    const n = el('cnt-' + c.key);
    if (n) n.textContent = counts[c.key] ? counts[c.key].toLocaleString('zh-CN') : '0';
  }
}

async function scan() {
  if (state.scanning) return;
  if (!state.drive) return;
  state.scanning = true;
  state.summary = null;
  resetCounts();
  el('scan-btn').textContent = '扫描中…';
  el('scan-btn').disabled = true;
  el('scan-overlay').classList.remove('hidden');
  el('scan-status').textContent = '正在扫描 ' + state.drive + '，请稍候…';
  setCategory(state.cat);

  const off = window.lume.scan.onProgress((p) => {
    // 显示当前扫描到哪个文件夹、哪个文件
    let text = '正在扫描 ' + state.drive + '，已读取 ' + p.scanned.toLocaleString('zh-CN') + ' 个文件';
    if (p.currentDir) {
      const dir = p.currentDir.length > 48 ? '…' + p.currentDir.slice(-47) : p.currentDir;
      text += '\n当前目录：' + dir;
    }
    if (p.currentFile) {
      text += '\n当前文件：' + p.currentFile;
    }
    el('scan-status').textContent = text;
    el('scan-status').title = p.currentDir ? p.currentDir : '';
  });

  const res = await window.lume.scan.start(state.drive);
  off();

  state.scanning = false;
  el('scan-btn').textContent = '重新扫描';
  el('scan-btn').disabled = false;
  el('scan-overlay').classList.add('hidden');

  if (res && res.ok) {
    state.summary = res;
    setCounts(res.counts);
    reloadCategory();
    // 记录上次扫描的盘符，供下次启动自动扫描
    window.lume.settings.set({ lastDrive: state.drive }).catch(() => {});
  } else if (res && res.cancelled) {
    // 被取消，保留旧缓存（若有）
  } else if (res && res.error) {
    showScanError(res.error);
  }
}

function showScanError(msg) {
  const area = el('content-area');
  area.innerHTML =
    '<div class="empty-state"><div class="empty-icon">' + icons.info + '</div>' +
    '<p class="empty-title">扫描失败</p><p class="empty-sub">' + escapeHtml(msg || '无法访问该盘符') + '</p></div>';
  el('grid-wrap').classList.add('hidden');
  el('list-wrap').classList.add('hidden');
  el('empty-state').classList.remove('hidden');
}

function setCategory(cat) {
  state.cat = cat;
  for (const c of CATS) {
    const btn = el('tab-' + c.key);
    if (btn) btn.classList.toggle('active', c.key === cat);
  }
  reloadCategory();
}

function resetPages() {
  state.pages = {};
  state.imageSource = null;
}

async function reloadCategory() {
  resetPages();
  if (!state.summary) return;
  const cat = state.cat;

  // 搜索模式下展示搜索结果（跨分类），不按当前分类
  if (state.searchQuery) {
    renderSearchResults();
    return;
  }

  if (cat === 'images') {
    renderImageGrid();
  } else {
    renderList();
  }
}

// ---------- 搜索（跨分类按名称） ----------
async function doSearch(query) {
  state.searchQuery = query || '';
  const input = el('search-input');
  const searchClear = el('search-clear');
  if (searchClear) searchClear.classList.toggle('hidden', !state.searchQuery);
  if (!state.searchQuery) {
    // 清空搜索：恢复当前分类展示
    reloadCategory();
    return;
  }
  if (!state.summary) {
    toast('请先扫描盘符后再搜索', 'error');
    return;
  }
  renderSearchResults();
}

async function renderSearchResults() {
  const grid = el('grid-wrap');
  const list = el('list-wrap');
  const empty = el('empty-state');
  const q = state.searchQuery;
  grid.classList.add('hidden');
  list.classList.remove('hidden');
  empty.classList.add('hidden');

  const head = el('list-head');
  head.innerHTML =
    '<div class="col col-name">名称</div><div class="col col-size">大小</div><div class="col col-time">修改时间</div>' +
    '<div class="col col-actions">查看</div>';
  const tbody = el('list-body');
  tbody.innerHTML = '';
  el('load-more-wrap').classList.add('hidden');

  const res = await window.lume.scan.search({ root: state.drive, query: q, limit: 500 });
  const items = (res && res.items) || [];

  if (!items.length) {
    list.classList.add('hidden');
    empty.classList.remove('hidden');
    el('empty-title').textContent = '未找到匹配文件';
    el('empty-sub').textContent = '没有名称包含「' + q + '」的文件，试试其他关键词';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const item of items) {
    frag.appendChild(makeSearchRow(item));
  }
  tbody.appendChild(frag);
  el('load-more-count').textContent = '搜索到 ' + items.length + ' 个匹配文件';
}

function makeSearchRow(item) {
  // 搜索结果带分类信息，便于区分
  const catKey = item.cat || 'others';
  const kind = CAT_KEY_TO_KIND[catKey] || 'file';
  const catLabel = (CATS.find((c) => c.key === catKey) || {}).label || '';
  const row = document.createElement('div');
  row.className = 'file-row';
  row.innerHTML =
    '<div class="col col-name"><span class="row-icon row-icon-' + kind + '">' + iconFor(kind) + '</span>' +
    '<span class="row-name" title="' + escapeHtml(item.path) + '">' + escapeHtml(item.name) + '</span>' +
    '<span class="search-cat-tag">' + catLabel + '</span></div>' +
    '<div class="col col-size">' + formatSize(item.size) + '</div>' +
    '<div class="col col-time">' + formatTime(item.mtime) + '</div>' +
    '<div class="col col-actions"><div class="row-btns">' + actionButtons(item, kind) + '</div></div>';

  bindRowActions(row, item, kind);
  return row;
}

// ---------- 图片网格 ----------
function renderImageGrid() {
  const grid = el('grid-wrap');
  const list = el('list-wrap');
  const empty = el('empty-state');
  grid.classList.remove('hidden');
  list.classList.add('hidden');
  empty.classList.add('hidden');

  grid.innerHTML = '';
  const sentinel = document.createElement('div');
  sentinel.className = 'grid-sentinel';
  grid.appendChild(sentinel);

  const src = createImageSource();
  let pageSize = 200;
  let loading = false;
  let finished = false;

  // 分块渲染：每帧最多插入 40 张，避免一次性创建大量 DOM 造成卡顿
  const renderBatch = (items) => {
    const CHUNK = 40;
    let i = 0;
    const flush = () => {
      if (finished && items.length === 0) return;
      const frag = document.createDocumentFragment();
      const end = Math.min(i + CHUNK, items.length);
      for (; i < end; i++) {
        frag.appendChild(makeImageTile(items[i]));
      }
      sentinel.before(frag);
      observeTiles(grid);
      if (i < items.length) {
        requestAnimationFrame(flush);
      }
    };
    flush();
  };

  const loadMore = async () => {
    if (loading || finished) return;
    loading = true;
    const before = src.items.length;
    const added = await src.loadMore(pageSize);
    loading = false;
    if (src.total === 0 && before === 0) {
      showEmpty();
      finished = true;
      return;
    }
    if (added.length) renderBatch(added);
    if (src.items.length >= src.total) finished = true;
  };

  const showEmpty = () => {
    grid.classList.add('hidden');
    empty.classList.remove('hidden');
    el('empty-title').textContent = '暂无图片';
    el('empty-sub').textContent = EMPTY_TEXT.images;
  };

  loadMore();

  // 无限滚动
  if (state.observer) state.observer.disconnect();
  state.observer = new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting)) loadMore();
  }, { root: grid, rootMargin: '400px' });
  state.observer.observe(sentinel);
}

function createImageSource() {
  const src = {
    root: state.drive,
    cat: 'images',
    items: [],
    total: null,
    async loadMore(limit) {
      const res = await window.lume.scan.data({
        root: this.root,
        category: 'images',
        sort: 'mtime',
        order: 'desc',
        offset: this.items.length,
        limit,
      });
      if (this.total === null) this.total = res.total;
      const added = res.items || [];
      this.items.push(...added);
      return added;
    },
    async get(i) {
      while (this.items.length <= i && (this.total === null || this.items.length < this.total)) {
        const before = this.items.length;
        await this.loadMore(400);
        if (this.items.length === before) break;
      }
      return this.items[i];
    },
  };
  state.imageSource = src;
  return src;
}

// ---------- 缩略图加载：限并发 + 仅可视区域加载（性能优化） ----------
const THUMB_CONCURRENCY = 3;
let thumbActive = 0;
const thumbQueue = [];

function requestThumb(path) {
  return new Promise((resolve) => {
    thumbQueue.push({ path, resolve });
    pumpThumbQueue();
  });
}

function pumpThumbQueue() {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
    const job = thumbQueue.shift();
    thumbActive++;
    window.lume
      .thumb(job.path)
      .then((data) => job.resolve(data))
      .catch(() => job.resolve(null))
      .finally(() => {
        thumbActive--;
        pumpThumbQueue();
      });
  }
}

let tileObserver = null;
function observeTileLoad(tile, start) {
  if (typeof IntersectionObserver !== 'function') {
    start();
    return;
  }
  if (!tileObserver) {
    tileObserver = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          tileObserver.unobserve(en.target);
          const fn = en.target.__tileLoad;
          en.target.__tileLoad = null;
          if (fn) fn();
        }
      },
      { rootMargin: '320px' }
    );
  }
  tile.__tileLoad = start;
  tileObserver.observe(tile);
}

function makeImageTile(item) {
  const tile = document.createElement('div');
  tile.className = 'img-tile';
  tile.title = item.name;
  tile.innerHTML =
    '<div class="tile-img"><span class="tile-placeholder">' + icons.image + '</span>' +
    '<img alt="" loading="lazy" decoding="async"></div>' +
    '<div class="tile-meta"><span class="tile-name">' + escapeHtml(item.name) + '</span>' +
    '<span class="tile-time">' + formatTime(item.mtime) + '</span></div>';
  const img = tile.querySelector('img');
  const placeholder = tile.querySelector('.tile-placeholder');
  const showImg = () => {
    placeholder.style.display = 'none';
    img.classList.add('loaded');
  };

  img.addEventListener('error', () => {
    // 原图也失败时保留占位符
    img.style.display = 'none';
  });
  img.addEventListener('load', () => {
    if (!img.classList.contains('loaded')) showImg();
  });

  // 仅在瓦片进入（或接近）可视区域后才真正加载，避免一次性发起大量缩略图请求
  const startLoad = () => {
    if (!img.isConnected) return;
    const key = item.path;
    const cached = state.thumbCache.get(key);
    if (cached) {
      img.src = cached;
      showImg();
      return;
    }
    img.style.opacity = '0';
    if (getCachedSettings().gridImageQuality === 'original') {
      img.src = fileUrl(key);
      showImg();
      return;
    }
    requestThumb(key)
      .then((dataUrl) => {
        if (!img.isConnected) return;
        if (dataUrl) {
          state.thumbCache.set(key, dataUrl);
          img.src = dataUrl;
        } else {
          img.src = fileUrl(key);
        }
        showImg();
      })
      .catch(() => {
        if (img.isConnected) {
          img.src = fileUrl(key);
          showImg();
        }
      });
  };
  observeTileLoad(tile, startLoad);

  tile.addEventListener('click', () => {
    window.lume.log.event({ action: 'view:open', detail: { name: item.name, kind: 'image' } });
    openImageViewer({
      total: state.imageSource.total,
      getItem: (i) => state.imageSource.get(i).then((it) => ({ name: it.name, src: fileUrl(it.path), path: it.path })),
      initialIndex: state.imageSource.items.indexOf(item),
      downloadItem: (it) => window.lume.file.copy(it.path),
      revealPath: (it) => window.lume.file.reveal(it.path),
    });
  });
  return tile;
}

function observeTiles() {
  // 瓦片自行按可视区域懒加载（见 observeTileLoad），此处无需额外处理
}

// ---------- 列表（PDF / Word / 应用 / 其他） ----------
function renderList() {
  const grid = el('grid-wrap');
  const list = el('list-wrap');
  const empty = el('empty-state');
  grid.classList.add('hidden');
  list.classList.remove('hidden');
  empty.classList.add('hidden');

  const cat = state.cat;
  state.pages[cat] = { items: [], total: 0, offset: 0, finished: false };
  const p = state.pages[cat];

  const tbody = el('list-body');
  const head = el('list-head');
  tbody.innerHTML = '';

  // 表头随分类变化
  const showAction = cat === 'apps' ? '运行' : cat === 'others' ? '打开' : '查看';
  head.innerHTML =
    '<div class="col col-name">名称</div><div class="col col-size">大小</div><div class="col col-time">修改时间</div>' +
    '<div class="col col-actions">' + showAction + '</div>';

  const loadMore = async () => {
    if (p.finished || p.loading) return;
    p.loading = true;
    const res = await window.lume.scan.data({
      root: state.drive,
      category: cat,
      sort: state.sort,
      order: 'desc',
      offset: p.offset,
      limit: 200,
    });
    p.loading = false;
    p.total = res.total;
    const items = res.items || [];
    p.items.push(...items);
    p.offset += items.length;
    if (p.items.length >= p.total) p.finished = true;
    renderListRows(items);
    if (p.items.length === 0) {
      list.classList.add('hidden');
      empty.classList.remove('hidden');
      el('empty-title').textContent = '暂无文件';
      el('empty-sub').textContent = EMPTY_TEXT[cat];
    } else {
      el('load-more-wrap').classList.toggle('hidden', p.finished);
    }
  };

  el('load-more-wrap').classList.remove('hidden');
  loadMore();
}

function renderListRows(items) {
  const tbody = el('list-body');
  if (!items.length) return;
  const CHUNK = 60;
  let i = 0;
  const flush = () => {
    const frag = document.createDocumentFragment();
    const end = Math.min(i + CHUNK, items.length);
    for (; i < end; i++) frag.appendChild(makeListRow(items[i]));
    tbody.appendChild(frag);
    if (i < items.length) requestAnimationFrame(flush);
  };
  flush();
}

function makeListRow(item) {
  const cat = state.cat;
  const kind = CAT_KEY_TO_KIND[cat];
  const row = document.createElement('div');
  row.className = 'file-row';
  row.innerHTML =
    '<div class="col col-name"><span class="row-icon row-icon-' + kind + '">' + iconFor(kind) + '</span>' +
    '<span class="row-name" title="' + escapeHtml(item.path) + '">' + escapeHtml(item.name) + '</span></div>' +
    '<div class="col col-size">' + formatSize(item.size) + '</div>' +
    '<div class="col col-time">' + formatTime(item.mtime) + '</div>' +
    '<div class="col col-actions"><div class="row-btns">' + actionButtons(item, kind) + '</div></div>';

  bindRowActions(row, item, kind);
  return row;
}

function actionButtons(item, kind) {
  const path = escapeHtml(item.path);
  let main = '';
  if (kind === 'image' || kind === 'pdf' || kind === 'word' || kind === 'video') {
    main = '<button class="row-btn row-btn-primary" data-act="view" data-path="' + path + '">' + (kind === 'video' ? '观看' : '查看') + '</button>';
  } else if (kind === 'app') {
    main = '<button class="row-btn row-btn-primary" data-act="run" data-path="' + path + '">运行</button>';
  } else {
    main = '<button class="row-btn row-btn-primary" data-act="open" data-path="' + path + '">打开</button>';
  }
  return (
    '<button class="row-btn row-btn-share" data-act="share" data-path="' + path + '" title="分享（生成提取码）">' + icons.share + '</button>' +
    main +
    '<button class="row-btn" data-act="reveal" data-path="' + path + '" title="打开所在位置">' + icons.folder + '</button>' +
    '<button class="row-btn" data-act="copy" data-path="' + path + '" title="复制到…">' + icons.download + '</button>'
  );
}

function bindRowActions(row, item, kind) {
  row.addEventListener('click', (e) => {
    const btn = e.target.closest('.row-btn');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'share') {
      // 一键分享（需先在“局域网分享”中开启分享功能）
      shareLocalPath(item.path, item.name);
      return;
    }
    if (act === 'view') {
      window.lume.log.event({ action: 'view:open', detail: { name: item.name, kind } });
      if (kind === 'image') {
        // 图片列表里不应出现，但兜底直接看单张
        openImageViewer({
          total: 1,
          getItem: () => Promise.resolve({ name: item.name, src: fileUrl(item.path), path: item.path }),
          initialIndex: 0,
          downloadItem: (it) => window.lume.file.copy(it.path),
          revealPath: (it) => window.lume.file.reveal(it.path),
        });
      } else if (kind === 'pdf') {
        openLocalPdf(item);
      } else if (kind === 'word') {
        openLocalWord(item);
      } else if (kind === 'video') {
        openLocalVideo(item);
      }
    } else if (act === 'run') {
      window.lume.file.open(item.path).then((r) => {
        if (r && !r.ok) toast('无法运行：' + r.error, 'error');
      });
    } else if (act === 'open') {
      window.lume.file.open(item.path).then((r) => {
        if (r && !r.ok) toast('无法打开：' + r.error, 'error');
      });
    } else if (act === 'reveal') {
      window.lume.file.reveal(item.path);
    } else if (act === 'copy') {
      window.lume.file.copy(item.path).then((r) => {
        if (r && r.canceled) return;
        if (r && r.ok) toast('已复制到 ' + r.dest, 'success');
        else if (r && r.error) toast('复制失败：' + r.error, 'error');
      });
    }
  });
}

async function openLocalPdf(item) {
  toast('正在打开 PDF…', 'info');
  try {
    const res = await fetch(fileUrl(item.path));
    const buf = await res.arrayBuffer();
    await openPdfViewer({
      name: item.name,
      data: buf,
      downloadItem: () => window.lume.file.copy(item.path),
      revealPath: () => window.lume.file.reveal(item.path),
    });
  } catch {
    toast('PDF 打开失败', 'error');
  }
}

async function openLocalWord(item) {
  if (!/\.docx$/i.test(item.name)) {
    toast('.doc 旧格式暂不支持预览，请下载后用 Office 打开', 'info');
    return;
  }
  toast('正在打开文档…', 'info');
  try {
    const res = await fetch(fileUrl(item.path));
    const buf = await res.arrayBuffer();
    await openWordViewer({
      name: item.name,
      data: buf,
      downloadItem: () => window.lume.file.copy(item.path),
      revealPath: () => window.lume.file.reveal(item.path),
    });
  } catch {
    toast('文档打开失败', 'error');
  }
}

// 打开视频：按设置使用内置播放器或系统默认播放器
async function openLocalVideo(item) {
  window.lume.log.event({ action: 'view:open', detail: { name: item.name, kind: 'video' } });
  const s = getCachedSettings();
  if (s.defaultVideoPlayer === 'system') {
    const r = await window.lume.file.open(item.path);
    if (r && !r.ok) toast('无法打开：' + r.error, 'error');
    return;
  }
  openVideoViewer({
    name: item.name,
    src: fileUrl(item.path),
    downloadItem: () => window.lume.file.copy(item.path),
    revealPath: () => window.lume.file.reveal(item.path),
  });
}

async function loadMoreList() {
  const cat = state.cat;
  const p = state.pages[cat];
  if (!p || p.finished || p.loading) return;
  p.loading = true;
  const res = await window.lume.scan.data({
    root: state.drive,
    category: cat,
    sort: state.sort,
    order: 'desc',
    offset: p.offset,
    limit: 200,
  });
  p.loading = false;
  p.total = res.total;
  const items = res.items || [];
  p.items.push(...items);
  p.offset += items.length;
  if (p.items.length >= p.total) p.finished = true;
  renderListRows(items);
  el('load-more-wrap').classList.toggle('hidden', p.finished);
  el('load-more-count').textContent = '已加载 ' + p.items.length.toLocaleString('zh-CN') + ' / ' + p.total.toLocaleString('zh-CN') + ' 项';
}

// 简单 toast 已迁移到 toast.js（顶部下落式提示条），这里保持原有导出以便其它模块继续使用

export function refreshFilesView() {
  // 切换回文件库时若已扫描则直接展示
  if (state.summary) reloadCategory();
}
