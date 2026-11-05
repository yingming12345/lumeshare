// 磁盘扫描：递归遍历目录，按扩展名分类
const fs = require('fs');
const path = require('path');

const EXT_IMAGES = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico',
  'tif', 'tiff', 'jfif', 'avif', 'heic', 'heif',
]);
const EXT_VIDEOS = new Set([
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts',
  'mpg', 'mpeg', '3gp', 'rmvb', 'rm', 'm2ts', 'vob',
]);
const EXT_PDFS = new Set(['pdf']);
const EXT_WORDS = new Set(['doc', 'docx', 'docm', 'dot', 'dotx', 'rtf', 'wps', 'wpt']);
const EXT_APPS = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'cpl', 'scr']);

// 跳过系统/隐藏类目录，避免无意义耗时
const SKIP_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'windows', 'programdata',
  'recovery', 'documents and settings', 'perflogs', '$winreagent',
  'config.msi', 'msocache', 'windows.old', '$sysreset', '$windows.~bt', '$windows.~ws',
  // 本软件自身的缓存目录（缩略图缓存），无需纳入文件库
  'lumesharecache', 'thumb-cache',
]);

// 名称排序用统一的 Collator（比每次调用 localeCompare 快很多）
const NAME_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

const CATEGORY_KEYS = ['images', 'videos', 'pdfs', 'words', 'apps', 'others'];
const CATEGORY_LABELS = { images: '图片', videos: '视频', pdfs: 'PDF', words: 'Word', apps: '应用', others: '其他' };

function categorize(ext) {
  if (EXT_IMAGES.has(ext)) return 'images';
  if (EXT_VIDEOS.has(ext)) return 'videos';
  if (EXT_PDFS.has(ext)) return 'pdfs';
  if (EXT_WORDS.has(ext)) return 'words';
  if (EXT_APPS.has(ext)) return 'apps';
  return 'others';
}

function listDrives() {
  const out = [];
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const letter = String.fromCharCode(c);
      const root = letter + ':\\';
      try {
        fs.accessSync(root);
        out.push({ name: letter + ':', path: root, isSystem: letter === 'C' });
      } catch {
        /* 跳过不可访问盘符 */
      }
    }
  } else {
    try {
      fs.accessSync('/');
      out.push({ name: '/', path: '/', isSystem: false });
    } catch {
      /* ignore */
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 取文件元数据的并发上限（机械硬盘也不至于被压垮，SSD 上明显更快）
const STAT_CONCURRENCY = 24;

// 简易并发映射：限制同时进行的异步任务数量
async function mapLimit(items, limit, worker) {
  let cursor = 0;
  const runners = [];
  const n = Math.min(limit, items.length);
  for (let i = 0; i < n; i++) {
    runners.push(
      (async () => {
        while (cursor < items.length) {
          const idx = cursor++;
          await worker(items[idx], idx);
        }
      })()
    );
  }
  await Promise.all(runners);
}

/**
 * 扫描某个根目录，按分类收集文件。
 * @param {string} root 根路径
 * @param {object} opts { onProgress, signal: { cancelled } }
 * @returns {Promise<object>} { images: [], videos: [], pdfs: [], words: [], apps: [], others: [] }
 */
async function scanRoot(root, opts = {}) {
  const { onProgress, signal } = opts;
  const results = { images: [], videos: [], pdfs: [], words: [], apps: [], others: [] };
  const queue = [root];
  let pending = 1;
  let scanned = 0;
  let workers = 0;
  let lastEmit = 0;
  const CONCURRENCY = 8;
  let currentDir = root;
  let currentFile = '';

  const emit = () => {
    const now = Date.now();
    if (now - lastEmit > 200 && typeof onProgress === 'function') {
      lastEmit = now;
      onProgress({
        scanned,
        found:
          results.images.length + results.videos.length + results.pdfs.length +
          results.words.length + results.apps.length + results.others.length,
        currentDir,
        currentFile,
      });
    }
  };

  const done = () => {
    if (pending === 0 && workers === 0) {
      emit();
      resolveFn();
    }
  };

  let resolveFn;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });

  const processDir = async (dir) => {
    currentDir = dir;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      pending--;
      done();
      return;
    }
    // 先收集本目录的文件项，再并行取元数据（避免逐个 await stat 造成的串行等待）
    const files = [];
    for (const ent of entries) {
      if (signal && signal.cancelled) break;
      const name = ent.name;
      if (name.startsWith('$') || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name.toLowerCase())) continue;
        pending++;
        queue.push(full);
      } else if (ent.isFile()) {
        const ext = path.extname(name).slice(1).toLowerCase();
        files.push({ name, path: full, ext, cat: categorize(ext) });
      }
    }
    if (files.length) {
      await mapLimit(files, STAT_CONCURRENCY, async (f) => {
        let size = 0;
        let mtime = 0;
        try {
          const st = await fs.promises.stat(f.path);
          size = st.size;
          mtime = Math.floor(st.mtimeMs);
        } catch {
          /* 忽略无法读取的文件 */
        }
        f.size = size;
        f.mtime = mtime;
      });
      for (const f of files) {
        if (signal && signal.cancelled) break;
        results[f.cat].push({ name: f.name, path: f.path, ext: f.ext, size: f.size, mtime: f.mtime });
        scanned++;
        currentFile = f.name;
        if (scanned % 400 === 0) emit();
      }
    }
    pending--;
    done();
  };

  const pump = async () => {
    while (true) {
      if (signal && signal.cancelled) {
        workers--;
        done();
        return;
      }
      const dir = queue.shift();
      if (dir === undefined) {
        if (pending === 0) {
          workers--;
          done();
          return;
        }
        await sleep(4);
        continue;
      }
      await processDir(dir);
    }
  };

  for (let i = 0; i < CONCURRENCY; i++) {
    workers++;
    pump();
  }

  await promise;
  emit();
  return results;
}

function summarize(results) {
  const counts = {};
  const sizes = {};
  let total = 0;
  for (const key of CATEGORY_KEYS) {
    counts[key] = results[key].length;
    sizes[key] = results[key].reduce((s, f) => s + f.size, 0);
    total += results[key].length;
  }
  return { counts, sizes, total };
}

function sortFiles(list, sortBy, order) {
  const dir = order === 'asc' ? 1 : -1;
  const arr = list.slice();
  switch (sortBy) {
    case 'name':
      arr.sort((a, b) => NAME_COLLATOR.compare(a.name, b.name) * dir);
      break;
    case 'size':
      arr.sort((a, b) => (a.size - b.size) * dir);
      break;
    default:
      arr.sort((a, b) => (a.mtime - b.mtime) * dir || (b.size - a.size));
  }
  return arr;
}

module.exports = {
  listDrives,
  scanRoot,
  summarize,
  sortFiles,
  categorize,
  CATEGORY_KEYS,
  CATEGORY_LABELS,
};
