// 图片缩略图：内存 LRU + 磁盘持久化缓存，低配置电脑也能流畅加载
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nativeImage } = require('electron');
const settings = require('./settings');
const logger = require('./logger');

const MEM_MAX = 4000; // 内存缓存条数上限
const THUMB_SIZE = 320;
const CONCURRENCY = 4; // 同时生成缩略图的任务数（避免低配机卡顿）

const mem = new Map(); // path -> dataURL
let active = 0;
const queue = [];
const inflight = new Map(); // path -> Promise（同一文件并发生成时复用，避免重复解码）

function memGet(key) {
  const v = mem.get(key);
  if (v) {
    mem.delete(key);
    mem.set(key, v);
  }
  return v;
}

function memSet(key, value) {
  mem.set(key, value);
  while (mem.size > MEM_MAX) {
    const oldest = mem.keys().next().value;
    if (oldest === undefined) break;
    mem.delete(oldest);
  }
}

function cacheDir() {
  return settings.getResolved().thumbCacheDir;
}

function cacheFile(filePath) {
  const hash = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 32);
  return path.join(cacheDir(), hash + '.png');
}

function ensureDir() {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
  } catch {
    /* ignore */
  }
}

async function generate(filePath) {
  let img;
  try {
    img = await nativeImage.createThumbnailFromPath(filePath, {
      width: THUMB_SIZE,
      height: THUMB_SIZE,
    });
  } catch (e) {
    // 缩略图生成失败（某些格式/系统缩略图服务异常）：记录并回退，由调用方加载原图
    logger.warn('thumb:fail', { file: filePath, error: e.message });
    return null;
  }
  if (img.isEmpty()) return null;
  const png = img.toPNG();
  // 写磁盘缓存（失败不影响本次使用）
  try {
    ensureDir();
    fs.writeFileSync(cacheFile(filePath), png);
  } catch {
    /* ignore */
  }
  return 'data:image/png;base64,' + png.toString('base64');
}

// 简单信号量：限制并发生成，避免同时创建大量 nativeImage 导致卡顿
function acquire() {
  return new Promise((resolve) => {
    queue.push(resolve);
    pump();
  });
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const resolve = queue.shift();
    active++;
    resolve();
  }
}

function release() {
  active--;
  pump();
}

async function get(filePath) {
  const key = filePath;
  // 1) 内存缓存
  const memHit = memGet(key);
  if (memHit) return memHit;

  // 2) 同一文件的并发请求复用同一个任务
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    // 3) 磁盘缓存（异步读取，避免阻塞主进程）
    const file = cacheFile(filePath);
    try {
      const buf = await fs.promises.readFile(file);
      const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
      memSet(key, dataUrl);
      return dataUrl;
    } catch {
      /* 磁盘无缓存，继续生成 */
    }

    // 4) 生成（限并发）
    await acquire();
    try {
      const again = memGet(key);
      if (again) return again;
      try {
        const fileBuf = await fs.promises.readFile(file);
        const dataUrl = 'data:image/png;base64,' + fileBuf.toString('base64');
        memSet(key, dataUrl);
        return dataUrl;
      } catch {
        /* 仍无缓存 */
      }
      const dataUrl = await generate(filePath);
      if (dataUrl) memSet(key, dataUrl);
      return dataUrl;
    } finally {
      release();
    }
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

// 缓存信息：目录、文件数、总大小
function info() {
  const dir = cacheDir();
  let count = 0;
  let size = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) {
          count++;
          size += st.size;
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return { dir, count, size };
}

// 清空缓存
function clear() {
  const dir = cacheDir();
  try {
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  } catch {
    /* ignore */
  }
  mem.clear();
}

// 按上限清理（删除最旧的缓存文件）
function trim() {
  const limitMB = settings.getResolved().thumbCacheLimitMB;
  if (!limitMB) return;
  const limitBytes = limitMB * 1024 * 1024;
  const cur = info();
  if (cur.size <= limitBytes) return;
  let files = [];
  try {
    files = fs
      .readdirSync(cur.dir)
      .map((f) => {
        const p = path.join(cur.dir, f);
        try {
          return { p, mtime: fs.statSync(p).mtimeMs, size: fs.statSync(p).size };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return;
  }
  files.sort((a, b) => a.mtime - b.mtime);
  let freed = 0;
  for (const f of files) {
    if (cur.size - freed <= limitBytes) break;
    try {
      fs.unlinkSync(f.p);
      freed += f.size;
    } catch {
      /* ignore */
    }
  }
}

module.exports = { get, info, clear, trim };
