// LumeShare 直播播放器：基于浏览器原生 <video> + Media Source Extensions 播放实时 WebM 视频流
// 服务端帧格式："LSV1" + 若干 [类型(1)] [长度(4, 大端)] [负载]
//   类型 1 = JSON 元数据，2 = WebM 初始化段，3 = 媒体数据块
(function (root, factory) {
  var Player = factory();
  if (typeof module === 'object' && module.exports) module.exports = Player;
  if (root) root.LumeLivePlayer = Player;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var MAGIC = 'LSV1';

  function normalizeMime(mime) {
    var value = String(mime || '').trim();
    if (!value) return 'video/webm; codecs="vp8"';
    var m = /^video\/webm\s*;\s*codecs\s*=\s*"?([^";]+)"?$/i.exec(value);
    if (m) return 'video/webm; codecs="' + m[1].trim() + '"';
    if (/^video\/webm\s*;?\s*$/i.test(value)) return 'video/webm; codecs="vp8"';
    return value;
  }

  function initPayload(payload) {
    return payload;
  }
  function LumeLivePlayer(video, options) {
    this.video = video;
    this.opts = options || {};
    this.onState = this.opts.onState || function () {};
    this.onMeta = this.opts.onMeta || function () {};
    this.url = '';
    this.running = false;
    this.epoch = 0;
    this.abort = null;
    this.ms = null;
    this.sb = null;
    this.queue = [];
    this.initBuf = null;
    this.initApplied = false;
    this.mime = '';
    this.meta = null;
    this.buf = new Uint8Array(0);
    this.off = 0;
    this.magicOk = false;
    this.lastTime = -1;
    this.stallCount = 0;
    this.stallTimer = null;
    this.retryTimer = null;
    this.retries = 0;
    this.state = 'idle';
    var self = this;
    if (this.video) {
      this.video.addEventListener('playing', function () {
        self.emit('playing', '正在直播');
      });
      this.video.addEventListener('waiting', function () {
        if (self.state === 'playing') self.emit('buffering', '缓冲中…');
      });
    }
  }

  LumeLivePlayer.prototype.emit = function (state, text) {
    this.state = state;
    try {
      this.onState(state, text || '');
    } catch (e) {
      /* ignore */
    }
  };

  LumeLivePlayer.prototype.start = function (url) {
    this.stop();
    this.url = url;
    this.running = true;
    this.epoch += 1;
    var epoch = this.epoch;
    var self = this;
    this.magicOk = false;
    this.buf = new Uint8Array(0);
    this.off = 0;
    this.queue = [];
    this.initBuf = null;
    this.initApplied = false;
    this.sb = null;
    this.mime = '';
    this.meta = null;
    this.stallCount = 0;
    this.lastTime = -1;
    this.emit('connecting', '正在连接直播画面…');

    if (!window.MediaSource) {
      this.emit('error', '当前浏览器不支持视频直播播放');
      return;
    }
    var ms = new MediaSource();
    this.ms = ms;
    try {
      this.video.muted = true;
      this.video.autoplay = true;
      this.video.playsInline = true;
      this.video.src = URL.createObjectURL(ms);
    } catch (e) {
      this.emit('error', '播放器初始化失败');
      return;
    }
    ms.addEventListener(
      'sourceopen',
      function () {
        if (!self.running || epoch !== self.epoch) return;
        self.openSourceBuffer();
      },
      false
    );
    this.fetchStream(url, epoch);
    this.watchStall(epoch);
  };

  LumeLivePlayer.prototype.fetchStream = function (url, epoch) {
    var self = this;
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this.abort = controller;
    var init = { cache: 'no-store', headers: { accept: 'application/octet-stream' } };
    if (controller) init.signal = controller.signal;
    fetch(url, init)
      .then(function (res) {
        if (!res.ok || !res.body || !res.body.getReader) throw new Error('HTTP ' + res.status);
        var reader = res.body.getReader();
        var pump = function () {
          return reader.read().then(function (r) {
            if (epoch !== self.epoch || !self.running) return;
            if (r.done) {
              self.onStreamEnd(epoch);
              return;
            }
            self.pushBytes(r.value);
            return pump();
          });
        };
        return pump();
      })
      .catch(function (e) {
        if (!self.running || epoch !== self.epoch) return;
        if (e && e.name === 'AbortError') return;
        self.emit('error', '连接直播失败');
        self.scheduleReconnect(epoch);
      });
  };

  LumeLivePlayer.prototype.onStreamEnd = function (epoch) {
    if (!this.running || epoch !== this.epoch) return;
    this.emit('error', '直播已结束');
    this.scheduleReconnect(epoch);
  };

  LumeLivePlayer.prototype.scheduleReconnect = function (epoch) {
    var self = this;
    if (!this.running || epoch !== this.epoch) return;
    if (this.retries >= 8) {
      this.emit('error', '无法连接直播画面，请确认主播仍在直播');
      return;
    }
    this.retries += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(function () {
      if (!self.running) return;
      var url = self.url;
      self.start(url);
    }, 1500);
  };

  LumeLivePlayer.prototype.pushBytes = function (chunk) {
    if (!chunk || !chunk.length) return;
    var rest = this.buf.length - this.off;
    if (this.off > 0 && this.off > this.buf.length * 0.5) {
      this.buf = this.buf.subarray(this.off);
      this.off = 0;
      rest = this.buf.length;
    }
    var merged = new Uint8Array(rest + chunk.length);
    if (rest) merged.set(this.buf.subarray(this.off), 0);
    merged.set(chunk, rest);
    this.buf = merged;
    this.off = 0;
    this.parseFrames();
  };

  LumeLivePlayer.prototype.avail = function () {
    return this.buf.length - this.off;
  };

  LumeLivePlayer.prototype.take = function (n) {
    var out = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return out;
  };

  LumeLivePlayer.prototype.parseFrames = function () {
    if (!this.magicOk) {
      if (this.avail() < 4) return;
      var head = this.take(4);
      var text = String.fromCharCode(head[0], head[1], head[2], head[3]);
      if (text !== MAGIC) {
        this.emit('error', '直播数据格式不正确');
        this.scheduleReconnect(this.epoch);
        return;
      }
      this.magicOk = true;
    }
    while (this.avail() >= 5) {
      var view = this.buf.subarray(this.off, this.off + 5);
      var type = view[0];
      var len = ((view[1] << 24) | (view[2] << 16) | (view[3] << 8) | view[4]) >>> 0;
      if (this.avail() < 5 + len) return;
      this.take(5);
      var payload = this.take(len);
      this.onFrame(type, payload);
    }
  };

  LumeLivePlayer.prototype.onFrame = function (type, payload) {
    if (type === 1) {
      var meta = null;
      try {
        meta = JSON.parse(new TextDecoder('utf-8').decode(payload));
      } catch (e) {
        meta = null;
      }
      if (!meta) return;
      if (meta.error) {
        this.emit('error', meta.error);
        this.scheduleReconnect(this.epoch);
        return;
      }
      this.meta = meta;
      this.mime = meta.mime || '';
      this.retries = 0;
      try {
        this.onMeta(meta);
      } catch (e) {
        /* ignore */
      }
      this.openSourceBuffer();
      return;
    }
    if (type === 2) {
      if (this.initApplied) {
        // 主播端重启了编码会话：用新的初始化段重建解码器（画面短暂重建后继续）
        this.rebuild(initPayload(payload));
        return;
      }
      this.initBuf = payload;
      this.flush();
      return;
    }
    if (type === 3) {
      this.queue.push(payload);
      if (this.queue.length > 240) this.queue.shift();
      this.flush();
    }
  };

  LumeLivePlayer.prototype.openSourceBuffer = function () {
    if (!this.running || this.sb || !this.ms || this.ms.readyState !== 'open' || !this.mime) return;
    var candidates = [normalizeMime(this.mime), 'video/webm; codecs="vp9"', 'video/webm; codecs="vp8"', 'video/webm'];
    var sb = null;
    var lastError = null;
    for (var i = 0; i < candidates.length; i++) {
      try {
        sb = this.ms.addSourceBuffer(candidates[i]);
        break;
      } catch (e) {
        lastError = e;
        sb = null;
      }
    }
    if (!sb) {
      this.emit('error', '当前环境无法解码该视频流' + (lastError ? '（' + lastError.message + '）' : ''));
      return;
    }
    var self = this;
    sb.mode = 'segments';
    sb.addEventListener('updateend', function () {
      self.flush();
      self.trim();
      self.ensurePlaying();
    });
    sb.addEventListener('error', function () {
      self.emit('error', '视频解码异常，正在重连…');
      self.scheduleReconnect(self.epoch);
    });
    this.sb = sb;
    this.flush();
  };

  // 编码会话重启时重建 MediaSource（新初始化段 -> 新解码器），画面短暂重建后继续播放
  LumeLivePlayer.prototype.rebuild = function (initBuf) {
    var oldSb = this.sb;
    var oldMs = this.ms;
    this.sb = null;
    this.ms = null;
    this.queue = [];
    this.initBuf = initBuf;
    this.initApplied = false;
    try {
      if (oldSb && oldMs && oldMs.readyState === 'open' && !oldSb.updating) oldMs.removeSourceBuffer(oldSb);
    } catch (e) {
      /* ignore */
    }
    try {
      if (oldMs && oldMs.readyState === 'open') oldMs.endOfStream();
    } catch (e) {
      /* ignore */
    }
    if (!this.running) return;
    var next = new MediaSource();
    this.ms = next;
    var self = this;
    next.addEventListener('sourceopen', function () {
      self.openSourceBuffer();
    }, false);
    try {
      this.video.muted = true;
      this.video.src = URL.createObjectURL(next);
    } catch (e) {
      this.emit('error', '播放器重建失败');
      return;
    }
    this.emit('buffering', '正在恢复画面…');
    this.openSourceBuffer();
  };
  LumeLivePlayer.prototype.appendable = function () {
    return !!(this.sb && !this.sb.updating && this.ms && this.ms.readyState === 'open');
  };

  LumeLivePlayer.prototype.flush = function () {
    if (!this.appendable()) return;
    try {
      if (this.initBuf && !this.initApplied) {
        this.initApplied = true;
        this.sb.appendBuffer(this.initBuf);
        return;
      }
      while (this.queue.length && this.appendable()) {
        var chunk = this.queue.shift();
        this.sb.appendBuffer(chunk);
        if (this.sb.updating) return;
      }
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') {
        this.emit('buffering', '缓冲已满，正在清理…');
        this.trim(true);
        return;
      }
      this.emit('error', '视频数据异常，正在重连…');
      this.scheduleReconnect(this.epoch);
    }
  };

  LumeLivePlayer.prototype.trim = function (force) {
    if (!this.sb || this.sb.updating || !this.ms || this.ms.readyState !== 'open') return;
    var v = this.video;
    if (!v || !v.buffered || !v.buffered.length) return;
    var start = v.buffered.start(0);
    var end = v.buffered.end(v.buffered.length - 1);
    var playing = v.currentTime || 0;
    var keepFrom = Math.max(0, playing - 6);
    if (force || (playing > 12 && keepFrom - start > 3)) {
      try {
        this.sb.remove(start, Math.min(keepFrom, end));
      } catch (e) {
        /* ignore */
      }
    }
  };

  LumeLivePlayer.prototype.ensurePlaying = function () {
    var v = this.video;
    if (!v) return;
    if (v.paused && this.running) {
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
    }
    if (v.buffered && v.buffered.length) {
      var end = v.buffered.end(v.buffered.length - 1);
      if (end - v.currentTime > 2.5) {
        try {
          v.currentTime = end - 1.2;
        } catch (e) {
          /* ignore */
        }
      }
    }
  };

  LumeLivePlayer.prototype.watchStall = function (epoch) {
    var self = this;
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = setInterval(function () {
      if (!self.running || epoch !== self.epoch) return;
      var v = self.video;
      if (!v) return;
      if (!v.paused && v.currentTime > 0) {
        if (Math.abs(v.currentTime - self.lastTime) < 0.01) {
          self.stallCount += 1;
          if (self.stallCount >= 3) {
            self.stallCount = 0;
            self.emit('buffering', '画面卡顿，正在重连…');
            self.scheduleReconnect(epoch);
          }
        } else {
          self.stallCount = 0;
        }
        self.lastTime = v.currentTime;
      }
    }, 1000);
  };

  LumeLivePlayer.prototype.stop = function () {
    this.running = false;
    this.epoch += 1;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
    if (this.abort) {
      try {
        this.abort.abort();
      } catch (e) {
        /* ignore */
      }
      this.abort = null;
    }
    var sb = this.sb;
    var ms = this.ms;
    this.sb = null;
    this.ms = null;
    try {
      if (sb && ms && ms.readyState === 'open' && !sb.updating) {
        ms.removeSourceBuffer(sb);
      }
    } catch (e) {
      /* ignore */
    }
    try {
      if (ms && ms.readyState === 'open') ms.endOfStream();
    } catch (e) {
      /* ignore */
    }
    try {
      if (this.video) {
        this.video.removeAttribute('src');
        this.video.load();
      }
    } catch (e) {
      /* ignore */
    }
    this.queue = [];
    this.initBuf = null;
    this.initApplied = false;
    this.buf = new Uint8Array(0);
    this.off = 0;
    this.magicOk = false;
    this.state = 'idle';
  };

  return LumeLivePlayer;
});
