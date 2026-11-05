'use strict';
// 屏幕直播服务（主播端）：局域网内提供观看页面与实时视频流（WebM / MediaRecorder 编码）
// 两个固定端口（与局域网分享的 16888 / 17890 完全分开）：
//   16900 = 网页直播服务：观看页面、房间码校验、流畅档视频流
//   16901 = 高清视频通道：应用内观看与网页「高清」模式
// 视频流协议（浏览器原生 <video> + MSE 播放）：
//   响应体先写 4 字节标识 "LSV1"，随后是若干帧：[类型(1字节)][长度(4字节大端)][负载]
//     类型 1 = JSON 元数据（编码格式、分辨率、帧率、码率）
//     类型 2 = WebM 初始化段（必须最先追加到 MediaSource）
//     类型 3 = 媒体数据块
// 每个观看者拥有独立的编码会话（都从关键帧开始），接入即可出画。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { lanUrls } = require('./share');

const LIVE_WEB_PORT = 16900;
const LIVE_HD_PORT = 16901;
const TOKEN_LEN = 38;
const CODE_LEN = 10;
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const STREAM_MAGIC = Buffer.from('LSV1');
const MAX_VIEWERS = 6;
const STALL_BYTES = 16 * 1024 * 1024;
const INIT_TIMEOUT_MS = 20000;
const TOKEN_RE = /^[A-Za-z0-9]{38}$/;
const CODE_RE = /^\d{10}$/;

const FRAME_META = 1;
const FRAME_INIT = 2;
const FRAME_CHUNK = 3;

function pick(chars) {
  return chars[crypto.randomInt(0, chars.length)];
}

// 38 位数字 + 英文字母混合的随机串（每个直播间都不同）
function randomToken() {
  const arr = [];
  for (let i = 0; i < TOKEN_LEN; i++) arr.push(pick(ALNUM));
  const a = crypto.randomInt(0, TOKEN_LEN);
  let b = crypto.randomInt(0, TOKEN_LEN);
  while (b === a) b = crypto.randomInt(0, TOKEN_LEN);
  arr[a] = pick(DIGITS);
  arr[b] = pick(LETTERS);
  return arr.join('');
}

// 10 位纯数字房间码（首位不为 0，方便口头传达）
function randomRoomCode() {
  let out = pick('123456789');
  for (let i = 1; i < CODE_LEN; i++) out += pick(DIGITS);
  return out;
}

function mimeFor(file) {
  const ext = path.extname(String(file)).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        resolve('');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

class LiveService {
  constructor(options) {
    const opts = options || {};
    this.pagePath = opts.pagePath || path.join(__dirname, '..', 'live-web', 'index.html');
    this.sharedDir = opts.sharedDir || path.join(__dirname, '..', 'shared');
    this.pageFiles = new Map();
    this.server = null;
    this.hdServer = null;
    this.port = 0;
    this.hdPort = 0;
    this.sockets = new Set();
    this.viewers = new Map(); // viewerId -> { kind, res, bytes, initSent, timer }
    this.session = null;
    this.checkWindow = [];
    this.onViewers = null;
    this.onViewerStart = null;
    this.onViewerStop = null;
  }

  // ---------- 生命周期 ----------
  async start(options) {
    if (this.session) return this.status();
    const preset = options && options.preset === 'smooth' ? 'smooth' : 'hd';
    this.session = {
      token: randomToken(),
      roomCode: randomRoomCode(),
      startedAt: Date.now(),
      preset,
      fps: (options && options.fps) || 24,
      profile: (options && options.profile) || null,
      source: (options && options.sourceName) || '',
    };
    this.port = await this.listen('web');
    this.hdPort = await this.listen('hd');
    this.preloadPage();
    return this.status();
  }

  async stop() {
    const closing = [];
    if (this.server) {
      closing.push(this.closeServer(this.server));
      this.server = null;
    }
    if (this.hdServer) {
      closing.push(this.closeServer(this.hdServer));
      this.hdServer = null;
    }
    for (const id of [...this.viewers.keys()]) this.dropViewer(id, 'stop');
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();
    this.session = null;
    this.port = 0;
    this.hdPort = 0;
    await Promise.all(closing);
    this.notifyViewers();
  }

  // ---------- 端口 ----------
  listen(kind) {
    const base = kind === 'web' ? LIVE_WEB_PORT : LIVE_HD_PORT;
    const attempt = (offset) =>
      new Promise((resolve, reject) => {
        if (offset > 20) {
          reject(new Error('端口 ' + base + ' 至 ' + (base + 20) + ' 均被占用，请关闭占用程序后重试'));
          return;
        }
        const server = http.createServer((req, res) => this.handle(kind, req, res));
        server.on('connection', (socket) => {
          this.sockets.add(socket);
          socket.on('close', () => this.sockets.delete(socket));
          socket.setNoDelay(true);
        });
        server.once('error', (err) => {
          try {
            server.close();
          } catch {
            /* ignore */
          }
          if (err && err.code === 'EADDRINUSE') {
            attempt(offset + 1).then(resolve, reject);
            return;
          }
          reject(new Error('直播服务启动失败：' + (err && err.message)));
        });
        server.listen(base + offset, () => {
          const addr = server.address();
          resolve({ server, port: addr && addr.port ? addr.port : base + offset });
        });
      });
    return attempt(0).then((got) => {
      if (kind === 'web') this.server = got.server;
      else this.hdServer = got.server;
      return got.port;
    });
  }

  closeServer(server) {
    return new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  // ---------- 观看者 ----------
  viewerCount(kind) {
    let count = 0;
    for (const v of this.viewers.values()) {
      if (!kind || v.kind === kind) count++;
    }
    return count;
  }

  notifyViewers() {
    if (typeof this.onViewers !== 'function') return;
    try {
      this.onViewers({
        web: this.viewerCount('web'),
        hd: this.viewerCount('hd'),
        total: this.viewers.size,
      });
    } catch {
      /* ignore */
    }
  }

  writeFrame(entry, type, payload) {
    if (!entry || !entry.res) return false;
    const res = entry.res;
    if (!res.writable || res.destroyed || res.writableEnded) return false;
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const head = Buffer.allocUnsafe(5);
    head.writeUInt8(type, 0);
    head.writeUInt32BE(body.length, 1);
    try {
      res.write(head);
      res.write(body);
      entry.bytes += body.length + 5;
    } catch {
      return false;
    }
    return entry.bytes <= STALL_BYTES;
  }

  bindViewer(viewerId, kind, res) {
    const entry = { kind, res, bytes: 0, initSent: false, timer: null };
    this.viewers.set(viewerId, entry);
    this.notifyViewers();
    if (typeof this.onViewerStart === 'function') {
      try {
        this.onViewerStart(viewerId, kind);
      } catch {
        /* ignore */
      }
    }
    entry.timer = setTimeout(() => {
      if (this.viewers.get(viewerId) === entry && !entry.initSent) {
        try {
          this.writeFrame(entry, FRAME_META, JSON.stringify({ error: '视频编码超时，请重试' }));
        } catch {
          /* ignore */
        }
        this.dropViewer(viewerId, 'timeout');
      }
    }, INIT_TIMEOUT_MS);
  }

  // 该观看者的编码数据：type 1 = 元数据, 2 = 初始化段, 3 = 媒体块
  pushViewerFrame(viewerId, type, buffer) {
    const entry = this.viewers.get(viewerId);
    if (!entry || !buffer) return;
    if (type === FRAME_META || type === FRAME_INIT) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (type === FRAME_INIT) entry.initSent = true;
    }
    if (!this.writeFrame(entry, type, buffer)) this.dropViewer(viewerId, 'stall');
  }

  dropViewer(viewerId, reason) {
    const entry = this.viewers.get(viewerId);
    if (!entry) return;
    this.viewers.delete(viewerId);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    try {
      if (entry.res && !entry.res.writableEnded) entry.res.end();
    } catch {
      /* ignore */
    }
    if (typeof this.onViewerStop === 'function') {
      try {
        this.onViewerStop(viewerId, reason || '');
      } catch {
        /* ignore */
      }
    }
    this.notifyViewers();
  }

  // ---------- 状态 ----------
  status() {
    if (!this.session) {
      return { running: false, web: { port: 0, urls: [] }, hd: { port: 0, urls: [] } };
    }
    const webUrls = lanUrls(this.port).map((it) => ({
      ip: it.ip,
      url: it.url + '/' + this.session.token,
      base: it.url,
    }));
    const hdUrls = lanUrls(this.hdPort).map((it) => ({
      ip: it.ip,
      url: it.url + '/hd/' + this.session.token,
      base: it.url,
    }));
    return {
      running: true,
      token: this.session.token,
      roomCode: this.session.roomCode,
      startedAt: this.session.startedAt,
      preset: this.session.preset,
      profile: this.session.profile,
      source: this.session.source,
      fps: this.session.fps,
      viewers: { web: this.viewerCount('web'), hd: this.viewerCount('hd'), total: this.viewers.size },
      web: { port: this.port, urls: webUrls },
      hd: { port: this.hdPort, urls: hdUrls },
      webPageUrl: webUrls.length ? webUrls[0].base + '/' : 'http://127.0.0.1:' + this.port + '/',
    };
  }

  publicStatus() {
    if (!this.session) return { running: false };
    return {
      running: true,
      startedAt: this.session.startedAt,
      fps: this.session.fps,
      profile: this.session.profile,
      viewers: { web: this.viewerCount('web'), hd: this.viewerCount('hd'), total: this.viewers.size },
      hdPort: this.hdPort,
      webPort: this.port,
    };
  }

  // ---------- 页面 ----------
  preloadPage() {
    this.pageFiles.clear();
    const baseDir = path.dirname(this.pagePath);
    const walk = (dir) => {
      let items = [];
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) walk(full);
        else if (/\.(html|css|js|png|svg|ico)$/i.test(item.name)) {
          try {
            this.pageFiles.set('/' + path.relative(baseDir, full).split(path.sep).join('/'), fs.readFileSync(full));
          } catch {
            /* ignore */
          }
        }
      }
    };
    walk(baseDir);
  }

  playerScript() {
    try {
      return fs.readFileSync(path.join(this.sharedDir, 'live-player.js'));
    } catch {
      return null;
    }
  }

  // ---------- 路由 ----------
  handle(kind, req, res) {
    try {
      const host = req.headers.host || '';
      const url = new URL(req.url || '/', 'http://' + (host || 'localhost'));
      const pathname = decodeURIComponent(url.pathname || '/');
      if (kind === 'hd') return this.handleHd(req, res, url, pathname);
      return this.handleWeb(req, res, url, pathname);
    } catch {
      this.sendText(res, 400, 'bad request');
    }
  }

  handleWeb(req, res, url, pathname) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, this.corsHeaders());
      res.end();
      return;
    }
    if (pathname === '/api/live/config') {
      this.sendJson(res, 200, {
        app: 'LumeShare',
        running: !!this.session,
        hdPort: this.hdPort,
        webPort: this.port,
        fps: this.session ? this.session.fps : 0,
        viewers: this.viewers.size,
      });
      return;
    }
    if (pathname === '/api/live/status') {
      this.sendJson(res, 200, this.publicStatus());
      return;
    }
    if (pathname === '/api/live/check' && req.method === 'POST') {
      this.handleCheck(req, res);
      return;
    }
    if (pathname === '/player.js') {
      const script = this.playerScript();
      if (!script) {
        this.sendText(res, 404, 'not found');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': script.length,
        'cache-control': 'no-store',
      });
      res.end(script);
      return;
    }
    if (pathname.startsWith('/stream/')) {
      this.serveStream('web', req, res, pathname.slice('/stream/'.length));
      return;
    }
    if (pathname === '/' || pathname === '/index.html' || pathname === '/favicon.ico') {
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      this.servePage(res);
      return;
    }
    if (TOKEN_RE.test(pathname.slice(1))) {
      this.servePage(res);
      return;
    }
    const file = this.pageFiles.get(pathname);
    if (file) {
      res.writeHead(200, {
        'content-type': mimeFor(pathname),
        'content-length': file.length,
        'cache-control': 'no-store',
      });
      res.end(file);
      return;
    }
    this.sendText(res, 404, 'not found');
  }

  handleHd(req, res, url, pathname) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, this.corsHeaders());
      res.end();
      return;
    }
    if (pathname === '/api/live/status') {
      this.sendJson(res, 200, this.publicStatus());
      return;
    }
    if (pathname.startsWith('/hd/')) {
      this.serveStream('hd', req, res, pathname.slice('/hd/'.length));
      return;
    }
    this.sendText(res, 404, 'not found');
  }

  // 房间码校验：网页端输入 10 位房间码后换取直播令牌
  async handleCheck(req, res) {
    const now = Date.now();
    this.checkWindow = this.checkWindow.filter((t) => now - t < 1000);
    if (this.checkWindow.length > 12) {
      this.sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
      return;
    }
    this.checkWindow.push(now);
    const raw = await readBody(req, 4096);
    let code = '';
    try {
      const body = raw ? JSON.parse(raw) : {};
      code = String(body.code || body.room || '').trim();
    } catch {
      code = '';
    }
    if (!this.session || !this.session.roomCode) {
      this.sendJson(res, 200, { ok: false, error: '主播端未开始直播' });
      return;
    }
    if (!CODE_RE.test(code) || code !== this.session.roomCode) {
      this.sendJson(res, 200, { ok: false, error: '房间码不正确，请向主播确认' });
      return;
    }
    this.sendJson(res, 200, { ok: true, token: this.session.token });
  }

  servePage(res) {
    const buf = this.pageBuffer('/index.html');
    if (!buf) {
      this.sendText(res, 500, '直播页面缺失');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    res.end(buf);
  }

  pageBuffer(name) {
    const key = name && name !== '/' ? name : '/index.html';
    return this.pageFiles.get(key) || this.pageFiles.get('/index.html') || null;
  }

  validKey(key) {
    if (!this.session) return false;
    return key === this.session.token || key === this.session.roomCode;
  }

  serveStream(kind, req, res, rawKey) {
    const key = String(rawKey || '').split('?')[0];
    if (!this.session) return this.sendJson(res, 503, { error: '主播端未开始直播' });
    if (!this.validKey(key)) return this.sendJson(res, 404, { error: '房间码或直播地址不正确' });
    if (this.viewers.size >= MAX_VIEWERS) return this.sendJson(res, 503, { error: '观看人数已达上限' });
    const viewerId = crypto.randomUUID();
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store, no-cache, must-revalidate',
      pragma: 'no-cache',
      'x-accel-buffering': 'no',
      connection: 'close',
      ...this.corsHeaders(),
    });
    try {
      res.write(STREAM_MAGIC);
    } catch {
      return;
    }
    res.on('close', () => this.dropViewer(viewerId, 'client-close'));
    res.on('error', () => this.dropViewer(viewerId, 'client-error'));
    if (res.socket) res.socket.setTimeout(0);
    this.bindViewer(viewerId, kind, res);
  }

  corsHeaders() {
    return {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    };
  }

  sendJson(res, status, data) {
    const body = Buffer.from(JSON.stringify(data));
    try {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
        ...this.corsHeaders(),
      });
      res.end(body);
    } catch {
      /* ignore */
    }
  }

  sendText(res, status, text) {
    try {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(text);
    } catch {
      /* ignore */
    }
  }
}

// ---------- 观看端工具 ----------
function normalizeHost(raw) {
  let host = String(raw || '').trim();
  if (!host) return '';
  host = host
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim();
  if (!host) return '';
  if (!/:\d{2,5}$/.test(host)) host += ':' + LIVE_WEB_PORT;
  return host;
}

function parseLiveText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (CODE_RE.test(raw)) return { code: raw, token: '', host: '' };
  if (TOKEN_RE.test(raw)) return { code: '', token: raw, host: '' };
  const parts = raw.split(/\s+/);
  if (parts.length === 2 && CODE_RE.test(parts[1])) {
    const host = normalizeHost(parts[0]);
    if (host) return { code: parts[1], token: '', host };
  }
  let url = null;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : 'http://' + raw);
  } catch {
    return null;
  }
  const pathPart = decodeURIComponent(url.pathname || '').replace(/^\/+/, '');
  const token = TOKEN_RE.test(pathPart) ? pathPart : '';
  const codeParam = String(url.searchParams.get('code') || url.searchParams.get('room') || '').replace(/\D/g, '');
  const code = codeParam.length === CODE_LEN ? codeParam : '';
  const host = normalizeHost(url.host || '');
  if (!token && !code) return null;
  return { code, token, host };
}

function probeLive(host, timeoutMs) {
  let target = '';
  try {
    target = 'http://' + normalizeHost(host) + '/api/live/status';
  } catch {
    target = '';
  }
  if (!target) return Promise.reject(new Error('主播地址不正确'));
  return new Promise((resolve, reject) => {
    const req = http.get(target, { timeout: timeoutMs || 4000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => {
        if (chunks.length < 64) chunks.push(c);
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('主播电脑的直播服务响应异常'));
        }
      });
    });
    req.on('error', () => reject(new Error('无法连接主播电脑，请确认地址与网络后重试')));
    req.on('timeout', () => {
      req.destroy(new Error('连接主播电脑超时，请确认双方在同一局域网'));
    });
  });
}

module.exports = {
  LiveService,
  LIVE_WEB_PORT,
  LIVE_HD_PORT,
  TOKEN_LEN,
  CODE_LEN,
  STREAM_MAGIC,
  FRAME_META,
  FRAME_INIT,
  FRAME_CHUNK,
  randomToken,
  randomRoomCode,
  normalizeHost,
  parseLiveText,
  probeLive,
};
