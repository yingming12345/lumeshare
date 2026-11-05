// lume:// 自定义协议：lume://app/* 提供应用页面资源，lume://file/<encoded> 提供本地文件只读访问
// 兼容 Electron 22（无 protocol.handle / 无全局 Response），使用 registerStreamProtocol 回调式 API
const { protocol } = require('electron');
const fs = require('fs');
const path = require('path');

const WEB_ROOT = path.join(__dirname, '..', 'renderer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
};

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

function registerLumeProtocol() {
  protocol.registerStreamProtocol('lume', (request, callback) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      callback({ statusCode: 400, headers: {}, data: '' });
      return;
    }

    let filePath = null;
    try {
      if (url.host === 'app') {
        const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        filePath = path.join(WEB_ROOT, rel);
      } else if (url.host === 'file') {
        const raw = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
        filePath = decodeURIComponent(raw);
      }
    } catch {
      filePath = null;
    }

    if (!filePath) {
      callback({ statusCode: 404, headers: {}, data: '' });
      return;
    }

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error('not a file');

      // 支持 Range 请求（视频在线播放可拖动进度）
      const range = request.headers && (request.headers['Range'] || request.headers['range']);
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(String(range));
        let start = 0;
        let end = stat.size - 1;
        if (m && m[1] === '' && m[2] !== '') {
          // 后缀范围 bytes=-N
          start = Math.max(0, stat.size - parseInt(m[2], 10));
        } else if (m && m[1] !== '') {
          start = parseInt(m[1], 10);
          if (m[2] !== '') end = Math.min(stat.size - 1, parseInt(m[2], 10));
        }
        if (start > end || start >= stat.size) {
          callback({
            statusCode: 416,
            headers: { 'content-range': 'bytes */' + stat.size },
            data: '',
          });
          return;
        }
        callback({
          statusCode: 206,
          headers: {
            'content-type': mimeFor(filePath),
            'content-length': String(end - start + 1),
            'content-range': 'bytes ' + start + '-' + end + '/' + stat.size,
            'accept-ranges': 'bytes',
            'cache-control': 'no-cache',
          },
          data: fs.createReadStream(filePath, { start, end }),
        });
        return;
      }

      callback({
        statusCode: 200,
        headers: {
          'content-type': mimeFor(filePath),
          'content-length': String(stat.size),
          'accept-ranges': 'bytes',
          'cache-control': 'no-cache',
        },
        data: fs.createReadStream(filePath),
      });
    } catch {
      callback({ statusCode: 404, headers: {}, data: '' });
    }
  });
}

module.exports = { registerLumeProtocol, WEB_ROOT };
