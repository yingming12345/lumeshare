// 局域网分享服务：HTTP 上传/提取 + UDP 设备发现 + 本地存储管理
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');
const endpoints = require('../shared/endpoints');

const DISCOVERY_PORT = 17890;
const DISCOVERY_MAGIC = 'LUMESHARE-V1';
const BROADCAST_INTERVAL = 3000;
const STALE_SERVER_MS = 12000;
const EXPIRE_MS = 24 * 60 * 60 * 1000; // 提取码 24 小时有效
// 固定首选服务端口：关闭后再次开启（或下次启动自动开启）时，已发出的链接仍指向同一端口、可继续访问；
// 若端口被其它程序占用，则自动回退到随机端口，保证服务可用。
const PREFERRED_PORT = 16888;
const CODE_FILE_RE = /^\d{6}\.json$/;
// 上传体积安全上限（防止异常/恶意写入占满磁盘；正常使用远达不到该值）
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

function sanitizeName(name) {
  let n = String(name || 'unnamed')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim();
  if (!n || n === '.' || n === '..') n = 'unnamed';
  if (n.length > 180) n = n.slice(-180);
  return n;
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
}

function lanUrls(port) {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        out.push({ url: 'http://' + iface.address + ':' + port, ip: iface.address });
      }
    }
  }
  return out;
}

class ShareService {
  constructor({ storageDir, iconPath, appName }) {
    this.storageDir = storageDir;
    this.iconPath = iconPath;
    this.appName = appName || 'LumeShare';
    this.codes = new Map(); // code -> record
    this.server = null;
    this.port = 0;
    this.udp = null;
    this.bcastTimer = null;
    this.cleanupTimer = null;
    this.sockets = new Set(); // 活动连接（关闭服务时强制断开，保证链接立即不可访问）
    this.servers = new Map(); // key ip:port -> {name, ip, port, lastSeen}
    this.onServersChange = null;
    this.onUpload = null;
  }

  // ---------- 生命周期 ----------
  async start() {
    fs.mkdirSync(this.storageDir, { recursive: true });
    this.loadExisting();

    await new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on('connection', (sock) => {
        this.sockets.add(sock);
        sock.on('close', () => this.sockets.delete(sock));
      });
      const listen = (port) => {
        this.server.once('error', (e) => {
          if (e && e.code === 'EADDRINUSE' && port !== 0) {
            // 首选端口被占用：回退到随机端口，保证服务可用
            listen(0);
          } else {
            reject(e);
          }
        });
        this.server.listen(port, '0.0.0.0', () => {
          this.port = this.server.address().port;
          resolve();
        });
      };
      listen(PREFERRED_PORT);
    });

    this.startDiscovery();
    this.cleanupTimer = setInterval(() => this.purgeExpired(), 60 * 60 * 1000);
    this.cleanupTimer.unref?.();

    return { port: this.port, urls: lanUrls(this.port) };
  }

  stop() {
    // 先断开全部活动连接（含长连接），再关闭监听：关闭后链接立即不可访问
    for (const sock of this.sockets) {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();
    try {
      this.server?.close();
    } catch {
      /* ignore */
    }
    this.server = null;
    this.stopDiscovery();
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  status() {
    return {
      running: !!this.server,
      port: this.port,
      urls: this.server ? lanUrls(this.port) : [],
      codeCount: this.codes.size,
    };
  }

  list() {
    return [...this.codes.values()]
      .sort((a, b) => b.uploadAt - a.uploadAt)
      .map((r) => ({
        code: r.code,
        name: r.name,
        size: r.size,
        uploadAt: r.uploadAt,
        url: r.url,
        webUrl: r.webUrl,
      }));
  }

  // ---------- 存储 ----------
  loadExisting() {
    try {
      const files = fs.readdirSync(this.storageDir);
      const now = Date.now();
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(this.storageDir, f), 'utf8'));
          if (meta.code && meta.filePath && fs.existsSync(meta.filePath) && now - meta.uploadAt < EXPIRE_MS) {
            this.codes.set(meta.code, meta);
          } else {
            this.removeFiles(meta.code);
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  removeFiles(code) {
    const rec = this.codes.get(code);
    if (rec) {
      try {
        fs.unlinkSync(rec.filePath);
        fs.unlinkSync(path.join(this.storageDir, code + '.json'));
      } catch {
        /* ignore */
      }
      this.codes.delete(code);
    }
  }

  purgeExpired() {
    const now = Date.now();
    for (const [code, rec] of this.codes) {
      if (now - rec.uploadAt > EXPIRE_MS) this.removeFiles(code);
    }
  }

  // 清空指定目录内的全部本应用分享记录（内存映射 + 磁盘文件）
  clearRecordsIn(dir) {
    const target = path.resolve(dir).toLowerCase();
    const prefix = target.endsWith(path.sep) ? target : target + path.sep;
    const removed = [];
    for (const [code, rec] of [...this.codes]) {
      if (rec.filePath && path.resolve(rec.filePath).toLowerCase().startsWith(prefix)) {
        this.removeFiles(code);
        removed.push(code);
      }
    }
    return removed;
  }

  // 一键分享本地文件：复制到分享存储目录并生成提取码（不经过 HTTP 上传）
  shareLocalFile(srcPath) {
    try {
      const stat = fs.statSync(srcPath);
      if (!stat.isFile()) return { ok: false, error: '所选文件不存在或不可读取' };
      const name = sanitizeName(path.basename(srcPath));
      const code = this.makeCode();
      const filePath = path.join(this.storageDir, code + '_' + name);
      fs.copyFileSync(srcPath, filePath);
      const port = this.port || PREFERRED_PORT;
      const urls = lanUrls(port);
      const webBase = urls.length ? urls[0].url : 'http://127.0.0.1:' + port;
      const record = {
        code,
        name,
        size: stat.size,
        sizeText: humanSize(stat.size),
        filePath,
        uploadAt: Date.now(),
        url: webBase + '/api/file/' + code,
        webUrl: webBase + '/?code=' + code,
      };
      this.codes.set(code, record);
      try {
        fs.writeFileSync(path.join(this.storageDir, code + '.json'), JSON.stringify(record, null, 2), 'utf8');
      } catch {
        /* 元数据写入失败不阻塞（内存记录仍有效） */
      }
      this.onUpload?.(record);
      return {
        ok: true,
        code,
        name,
        size: record.size,
        sizeText: record.sizeText,
        url: record.url,
        webUrl: record.webUrl,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  makeCode() {
    for (let i = 0; i < 50; i++) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      if (!this.codes.has(code)) return code;
    }
    return String(Date.now()).slice(-6);
  }

  // ---------- HTTP ----------
  handle(req, res) {
    this.cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;

    try {
      if (req.method === 'GET' && p === '/') return this.serveWebIndex(res);
      if (req.method === 'GET' && p.startsWith('/static/')) return this.serveStatic(res, u.pathname);
      if (req.method === 'POST' && p === '/api/upload') return this.handleUpload(req, res);
      if (req.method === 'GET' && p.startsWith('/api/info/')) return this.handleInfo(res, p.slice('/api/info/'.length));
      if (req.method === 'GET' && p.startsWith('/api/file/')) {
        return this.handleDownload(res, p.slice('/api/file/'.length), u.searchParams.get('download') === '1');
      }
      if (req.method === 'DELETE' && p.startsWith('/api/file/')) {
        return this.handleDelete(res, p.slice('/api/file/'.length));
      }
      if (req.method === 'GET' && p === '/api/status') {
        // 状态接口：附带协议版本与平台信息，方便未来的安卓（APK）客户端做兼容性判断
        return this.json(res, 200, {
          name: this.appName,
          codeCount: this.codes.size,
          version: endpoints.SHARE_API_VERSION,
          api: endpoints.SHARE_API_VERSION,
          platform: 'windows',
          port: this.port,
        });
      }
      return this.json(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[share] 请求处理失败:', e);
      try {
        this.json(res, 500, { error: 'internal error' });
      } catch {
        /* ignore */
      }
    }
  }

  cors(res) {
    // 应用内（lume:// ）与局域网网页端都需要跨域读取本机分享服务，因此放开来源；
    // 仅开放实际使用的方法与请求头。
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-file-name, x-filename');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }

  json(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }

  serveWebIndex(res) {
    const file = path.join(__dirname, '..', 'share-web', 'index.html');
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(data);
    } catch {
      this.json(res, 500, { error: 'web page missing' });
    }
  }

  // 静态资源：严格限制在 share-web 目录（含固定图标与 docx-preview），防止目录穿越
  serveStatic(res, pathname) {
    let rel = '';
    try {
      rel = decodeURIComponent(pathname.slice('/static/'.length));
    } catch {
      this.json(res, 404, { error: 'not found' });
      return;
    }
    rel = rel.replace(/\\/g, '/');
    if (rel.includes('\0') || rel.split('/').some((seg) => seg === '..')) {
      this.json(res, 404, { error: 'not found' });
      return;
    }
    const webRoot = path.resolve(__dirname, '..', 'share-web');
    const docxFile = path.resolve(__dirname, '..', 'node_modules', 'docx-preview', 'dist', 'docx-preview.min.js');
    let file;
    if (rel === 'icon.png') {
      file = path.resolve(this.iconPath);
    } else if (rel === 'docx-preview.js') {
      file = docxFile;
    } else {
      file = path.resolve(webRoot, rel);
    }
    const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
    const allowed =
      (file === docxFile) ||
      inside(webRoot, file) ||
      (file === path.resolve(this.iconPath) && inside(path.resolve(path.dirname(this.iconPath)), file));
    if (!allowed) {
      this.json(res, 404, { error: 'not found' });
      return;
    }
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        'content-type': mimeFor(file),
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      res.end(data);
    } catch {
      this.json(res, 404, { error: 'not found' });
    }
  }

  handleUpload(req, res) {
    let rawName = req.headers['x-file-name'] || req.headers['x-filename'];
    let name = 'unnamed';
    if (rawName) {
      try {
        name = sanitizeName(decodeURIComponent(String(rawName)));
      } catch {
        name = sanitizeName(String(rawName));
      }
    }

    const code = this.makeCode();
    const filePath = path.join(this.storageDir, code + '_' + name);
    const tmpPath = filePath + '.tmp-' + crypto.randomBytes(4).toString('hex');

    const urls = lanUrls(this.port);
    const webBase = urls.length ? urls[0].url : 'http://127.0.0.1:' + this.port;

    const record = {
      code,
      name,
      size: 0,
      filePath,
      uploadAt: Date.now(),
      url: webBase + '/api/file/' + code,
      webUrl: webBase + '/?code=' + code,
    };

    const out = fs.createWriteStream(tmpPath);
    let aborted = false;

    req.on('data', (chunk) => {
      record.size += chunk.length;
      if (record.size > MAX_UPLOAD_BYTES && !aborted) {
        aborted = true;
        try {
          out.destroy();
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }
        this.json(res, 413, { error: '文件过大，已被拒绝' });
      }
    });

    req.on('end', () => {
      if (aborted) return;
      out.end(() => {
        try {
          fs.renameSync(tmpPath, filePath);
        } catch (e) {
          try {
            fs.copyFileSync(tmpPath, filePath);
            fs.unlinkSync(tmpPath);
          } catch (e2) {
            this.json(res, 500, { error: '写入失败' });
            return;
          }
        }
        record.mime = mimeFor(filePath);
        this.codes.set(code, record);
        try {
          fs.writeFileSync(
            path.join(this.storageDir, code + '.json'),
            JSON.stringify(record, null, 2)
          );
        } catch {
          /* ignore */
        }
        this.onUpload?.(record);
        this.json(res, 200, {
          code,
          name,
          size: record.size,
          sizeText: humanSize(record.size),
          url: record.webUrl,
          webUrl: record.webUrl,
        });
      });
    });

    req.on('error', () => {
      aborted = true;
      try {
        out.destroy();
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    });

    req.pipe(out);
  }

  handleInfo(res, code) {
    const rec = this.codes.get(code);
    if (!rec || !fs.existsSync(rec.filePath)) {
      this.json(res, 404, { error: '提取码不存在或已过期' });
      return;
    }
    this.json(res, 200, {
      code: rec.code,
      name: rec.name,
      size: rec.size,
      sizeText: humanSize(rec.size),
      uploadAt: rec.uploadAt,
      mime: mimeFor(rec.filePath),
      url: rec.url,
      webUrl: rec.webUrl,
    });
  }

  handleDownload(res, code, download) {
    const rec = this.codes.get(code);
    if (!rec || !fs.existsSync(rec.filePath)) {
      this.json(res, 404, { error: '提取码不存在或已过期' });
      return;
    }
    const stat = fs.statSync(rec.filePath);
    const asciiName = rec.name.replace(/[^\x20-\x7e]/g, '_');
    const disposition = download
      ? 'attachment; filename="' + asciiName + '"'
      : 'inline; filename="' + asciiName + '"';
    res.writeHead(200, {
      'content-type': mimeFor(rec.filePath),
      'content-length': stat.size,
      'content-disposition': disposition,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
    });
    fs.createReadStream(rec.filePath).pipe(res);
  }

  handleDelete(res, code) {
    if (!this.codes.has(code)) {
      this.json(res, 404, { error: '提取码不存在' });
      return;
    }
    this.removeFiles(code);
    this.json(res, 200, { ok: true });
  }

  // 应用内“下载到…”：直接把分享文件复制到用户选择的目录
  saveTo(code, destDir) {
    const rec = this.codes.get(code);
    if (!rec || !fs.existsSync(rec.filePath)) {
      return { ok: false, error: '提取码不存在或已过期' };
    }
    try {
      const dest = path.join(destDir, rec.name);
      fs.copyFileSync(rec.filePath, dest);
      return { ok: true, dest };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------- UDP 设备发现 ----------
  startDiscovery() {
    try {
      this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.udp.on('message', (msg, rinfo) => {
        const text = msg.toString('utf8').trim();
        if (!text.startsWith(DISCOVERY_MAGIC + '|')) return;
        const parts = text.split('|');
        if (parts.length < 3) return;
        const name = parts[1];
        const port = parseInt(parts[2], 10);
        if (!port) return;
        this.servers.set(rinfo.address + ':' + port, {
          name,
          ip: rinfo.address,
          port,
          lastSeen: Date.now(),
        });
        this.emitServers();
      });
      this.udp.on('error', () => {
        /* 忽略（例如防火墙限制） */
      });
      this.udp.bind(DISCOVERY_PORT, () => {
        try {
          this.udp.setBroadcast(true);
        } catch {
          /* ignore */
        }
      });

      this.bcastTimer = setInterval(() => {
        this.purgeServers();
        try {
          const msg = Buffer.from(DISCOVERY_MAGIC + '|' + this.appName + '|' + this.port);
          this.udp.send(msg, 0, msg.length, DISCOVERY_PORT, '255.255.255.255');
        } catch {
          /* ignore */
        }
      }, BROADCAST_INTERVAL);
      this.bcastTimer.unref?.();
    } catch (e) {
      console.error('[share] 设备发现启动失败:', e.message);
    }
  }

  stopDiscovery() {
    if (this.bcastTimer) clearInterval(this.bcastTimer);
    this.bcastTimer = null;
    try {
      this.udp?.close();
    } catch {
      /* ignore */
    }
    this.udp = null;
  }

  purgeServers() {
    const now = Date.now();
    let changed = false;
    for (const [key, s] of this.servers) {
      if (now - s.lastSeen > STALE_SERVER_MS) {
        this.servers.delete(key);
        changed = true;
      }
    }
    if (changed) this.emitServers();
  }

  emitServers() {
    const localIps = new Set(lanUrls(0).map((u) => u.ip));
    const list = [...this.servers.values()]
      .filter((s) => !(s.port === this.port && (s.ip === '127.0.0.1' || localIps.has(s.ip))))
      .map((s) => ({ name: s.name, ip: s.ip, port: s.port, url: 'http://' + s.ip + ':' + s.port }))
      .sort((a, b) => a.ip.localeCompare(b.ip));
    this.onServersChange?.(list);
  }
}

// ---------- 存储目录工具 ----------
function isInside(parentDir, childPath) {
  const parent = parentDir.endsWith(path.sep) ? parentDir : parentDir + path.sep;
  return childPath.toLowerCase().startsWith(parent.toLowerCase());
}

// 迁移分享存储目录：把 fromDir 中本应用生成的分享文件（6 位提取码的 *.json 元数据 + 对应文件）
// 逐个复制到 toDir，并重写元数据里的 filePath（复制完成后由调用方确认配置再清理源文件，避免中途丢数据）。
// 只识别本应用的文件（提取码元数据），目录里其它无关文件一律不动；目标已有同码记录则跳过。
function migrateStorageDir(fromDir, toDir) {
  const errors = [];
  const moved = []; // 成功迁移的提取码列表
  try {
    fromDir = path.resolve(fromDir);
    toDir = path.resolve(toDir);
    if (fromDir === toDir) return { ok: true, moved, same: true };
    if (!fs.existsSync(fromDir)) return { ok: true, moved }; // 源目录不存在 = 无文件可迁
    fs.mkdirSync(toDir, { recursive: true });
    const entries = fs.readdirSync(fromDir);
    for (const f of entries) {
      if (!CODE_FILE_RE.test(f)) continue;
      const code = f.slice(0, 6);
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(fromDir, f), 'utf8'));
      } catch {
        continue; // 元数据损坏：不迁移也不删除
      }
      if (!meta || meta.code !== code || !meta.filePath) continue;
      const oldFile = path.resolve(meta.filePath);
      if (!isInside(fromDir, oldFile)) continue; // 路径异常，跳过
      const destJson = path.join(toDir, f);
      if (fs.existsSync(destJson)) continue; // 目标已有同码记录，视为已迁移过
      if (!fs.existsSync(oldFile)) continue; // 文件缺失：留给 loadExisting 清理
      const destFile = path.join(toDir, path.basename(oldFile));
      try {
        fs.copyFileSync(oldFile, destFile);
        const newMeta = Object.assign({}, meta, { filePath: destFile });
        fs.writeFileSync(destJson, JSON.stringify(newMeta, null, 2), 'utf8');
        moved.push(code);
      } catch (e) {
        errors.push(f + ': ' + e.message);
        try {
          fs.unlinkSync(destJson);
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(destFile);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (e) {
    return { ok: false, error: e.message, moved };
  }
  return { ok: errors.length === 0, moved, errors };
}

// 迁移确认后的源目录清理：删除 fromDir 中已成功迁移（movedCodes 内）的提取码元数据及其文件（尽力而为）
function cleanupMigrated(fromDir, movedCodes) {
  if (!movedCodes || !movedCodes.length || !fs.existsSync(fromDir)) return 0;
  let removed = 0;
  for (const code of movedCodes) {
    const jsonPath = path.join(fromDir, code + '.json');
    try {
      const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (meta && meta.filePath) {
        try {
          fs.unlinkSync(path.resolve(meta.filePath));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(jsonPath);
      removed++;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

// 统计分享存储目录概况（供设置页展示盘符/占用）
function storageSummary(dir) {
  const out = { dir, exists: false, fileCount: 0, size: 0 };
  try {
    if (!dir || !fs.existsSync(dir)) return out;
    out.exists = true;
    const entries = fs.readdirSync(dir);
    for (const f of entries) {
      if (!CODE_FILE_RE.test(f)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!meta.code || !meta.filePath) continue;
        const st = fs.statSync(meta.filePath);
        out.fileCount++;
        out.size += st.size;
      } catch {
        /* 损坏或文件缺失的记录不计入 */
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

// 清空分享存储目录：删除其中全部本应用生成的提取码元数据及其文件，返回删除的元数据数量。
// 只识别本应用的文件（6 位提取码 *.json），目录里其它无关文件一律保留。
function clearStorageDir(dir) {
  let removed = 0;
  try {
    if (!dir || !fs.existsSync(dir)) return 0;
    for (const f of fs.readdirSync(dir)) {
      if (!CODE_FILE_RE.test(f)) continue;
      const jsonPath = path.join(dir, f);
      try {
        const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (meta && meta.filePath) {
          const fp = path.resolve(meta.filePath);
          if (isInside(dir, fp)) {
            try {
              fs.unlinkSync(fp);
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(jsonPath);
        removed++;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return removed;
}

module.exports = { ShareService, humanSize, lanUrls, sanitizeName, migrateStorageDir, cleanupMigrated, storageSummary, clearStorageDir, PREFERRED_PORT };
