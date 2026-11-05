// 背景音乐：开启后自动把音乐下载到本地并循环播放
// - 全程无界面：播放使用一个隐藏窗口（不在任务栏显示、不抢焦点、可被系统音量混合器识别）
// - 音乐只在首次播放时下载到本地缓存（userData/music/bgm.mp3），之后离线复用
// - 音乐地址只保存在主进程，不下发到渲染层
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { app, BrowserWindow, ipcMain } = require('electron');
const logger = require('./logger');

const MUSIC_URL = process.env.LUMESHARE_BGM_URL || '';
const CLIENT_UA = 'LumeShare-Client/2.0.3';
const MIN_BYTES = 64 * 1024; // 小于该体积视为无效文件
const VOLUME = 0.7; // 默认音量（避免过响影响用户）

let playWin = null;
let downloadPromise = null;
const state = {
  enabled: false,
  ready: false,
  playing: false,
  downloading: false,
  bytes: 0,
  error: '',
};

function musicDir() {
  return path.join(app.getPath('userData'), 'music');
}

function musicFile() {
  return path.join(musicDir(), 'bgm.mp3');
}

// MP3 合法性校验：ID3 头或帧同步字节
function isMp3Head(head) {
  if (!head || head.length < 3) return false;
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return true; // 'ID3'
  return head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
}

function localFileSize() {
  try {
    return fs.statSync(musicFile()).size;
  } catch {
    return 0;
  }
}

// 下载（跟随跳转），完成后原子替换到目标路径
function download(url, dest, redirects) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 5) {
      reject(new Error('下载跳转过多'));
      return;
    }
    const mod = String(url).startsWith('https:') ? https : http;
    const req = mod.get(
      url,
      { headers: { 'User-Agent': CLIENT_UA, Accept: '*/*' }, timeout: 60000 },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          download(next, dest, (redirects || 0) + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        const tmp = dest + '.part';
        const out = fs.createWriteStream(tmp);
        let received = 0;
        const head = [];
        res.on('data', (c) => {
          received += c.length;
          for (let i = 0; i < c.length && head.length < 4; i++) head.push(c[i]);
        });
        res.pipe(out);
        out.on('error', (e) => {
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
          reject(e);
        });
        out.on('finish', () => {
          out.close(() => {
            if (received < MIN_BYTES) {
              try {
                fs.unlinkSync(tmp);
              } catch {
                /* ignore */
              }
              reject(new Error('文件体积异常'));
              return;
            }
            if (!isMp3Head(Buffer.from(head))) {
              try {
                fs.unlinkSync(tmp);
              } catch {
                /* ignore */
              }
              reject(new Error('返回内容不是有效的音乐文件'));
              return;
            }
            try {
              fs.renameSync(tmp, dest);
            } catch (e) {
              reject(e);
              return;
            }
            resolve({ bytes: received });
          });
        });
      }
    );
    req.on('error', (e) => reject(e));
    req.on('timeout', () => req.destroy(new Error('下载超时')));
  });
}

// 确保本地有音乐文件（已有则直接复用，避免重复下载）
async function ensureLocal() {
  const dest = musicFile();
  const size = localFileSize();
  if (size >= MIN_BYTES) {
    state.ready = true;
    state.bytes = size;
    return dest;
  }
  if (downloadPromise) return downloadPromise;
  state.downloading = true;
  state.error = '';
  downloadPromise = (async () => {
    try {
      fs.mkdirSync(musicDir(), { recursive: true });
      const r = await download(MUSIC_URL, dest, 0);
      state.ready = true;
      state.bytes = r.bytes;
      state.error = '';
      logger.info('music:downloaded', { bytes: r.bytes });
      return dest;
    } catch (e) {
      state.ready = false;
      state.error = '音乐下载失败：' + e.message;
      logger.warn('music:download-fail', { error: e.message });
      return null;
    } finally {
      state.downloading = false;
      downloadPromise = null;
    }
  })();
  return downloadPromise;
}

// 隐藏的播放窗口（不显示、不进任务栏、不抢焦点）
function ensureWindow() {
  if (playWin && !playWin.isDestroyed()) return playWin;
  playWin = new BrowserWindow({
    show: false,
    width: 320,
    height: 180,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'music.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      devTools: !app.isPackaged,
    },
  });
  try {
    playWin.setSkipTaskbar(true);
  } catch {
    /* ignore */
  }
  playWin.on('closed', () => {
    playWin = null;
    state.playing = false;
  });
  playWin.loadURL('lume://app/music.html');
  return playWin;
}

function sendToPlayer(channel, payload) {
  try {
    if (playWin && !playWin.isDestroyed()) playWin.webContents.send(channel, payload);
  } catch {
    /* ignore */
  }
}

// 开启背景音乐：下载（首次）→ 隐藏窗口循环播放
async function start() {
  state.enabled = true;
  const file = await ensureLocal();
  if (!file) return { ok: false, error: state.error || '音乐文件不可用' };
  const win = ensureWindow();
  const url = 'lume://file/' + encodeURIComponent(file);
  const play = () => {
    state.playing = true;
    sendToPlayer('music:play', { url, volume: VOLUME, loop: true });
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', play);
  else play();
  logger.info('music:start', { bytes: state.bytes });
  return { ok: true };
}

// 关闭背景音乐：停止播放并销毁隐藏窗口（不留后台进程）
function stop() {
  state.enabled = false;
  state.playing = false;
  sendToPlayer('music:stop');
  const w = playWin;
  playWin = null;
  if (w && !w.isDestroyed()) {
    setTimeout(() => {
      try {
        if (w && !w.isDestroyed()) w.destroy();
      } catch {
        /* ignore */
      }
    }, 200);
  }
  logger.info('music:stop', {});
  return { ok: true };
}

// 根据设置应用状态（启动时或设置变更时调用）
async function applySetting(enabled) {
  if (enabled) return start();
  stop();
  return { ok: true };
}

function status() {
  return {
    enabled: !!state.enabled,
    ready: !!state.ready,
    playing: !!state.playing,
    downloading: !!state.downloading,
    bytes: state.bytes,
    error: state.error || '',
  };
}

// 隐藏窗口当前是否真的在出声（供自测校验）
function isAudible() {
  try {
    return !!(playWin && !playWin.isDestroyed() && playWin.webContents.isCurrentlyAudible());
  } catch {
    return false;
  }
}

// 播放器回报播放状态（例如解码失败）
ipcMain.on('music:state', (_e, payload) => {
  const p = payload || {};
  if (typeof p.playing === 'boolean') state.playing = p.playing;
  if (p.error) {
    state.error = '音乐播放失败：' + p.error;
    logger.warn('music:play-fail', { error: String(p.error).slice(0, 120) });
  }
});

module.exports = { applySetting, start, stop, status, isAudible, musicFile };
