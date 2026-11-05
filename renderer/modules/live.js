// 屏幕直播：本机发起直播（主播）与观看他人直播（观众）
// 观看端使用浏览器原生 <video> + Media Source Extensions 播放实时视频流
import { toast } from './files.js';
import { copyText } from './util.js';
import { loadSettingsCache, getCachedSettings } from './settings.js';
import qrcode from 'qrcode-generator';
import LumeLivePlayer from '../../shared/live-player.js';

const state = {
  enabled: false,
  preset: 'hd',
  status: null,
  sources: [],
  sourcesLoaded: false,
  watching: null,
  player: null,
  meta: null,
  viewers: 0,
  statusTimer: null,
  elapsedTimer: null,
  remoteTimer: null,
};

function el(id) {
  return document.getElementById(id);
}

function qrSvg(text, cellSize) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text || ''));
  qr.make();
  return qr.createSvgTag({ cellSize: cellSize || 4, margin: 2 });
}

function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => (v < 10 ? '0' + v : String(v));
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
}

function groupCode(code) {
  const s = String(code || '');
  if (s.length !== 10) return s || '----------';
  return s.slice(0, 4) + ' ' + s.slice(4, 8) + ' ' + s.slice(8);
}

function primaryUrl(status) {
  const list = (status && status.web && status.web.urls) || [];
  const lan = list.find((it) => !/^127\./.test(it.ip));
  return (lan || list[0] || {}).url || '';
}

function labelOf(status) {
  const p = (status && status.profile) || {};
  const parts = [];
  if (p.label) parts.push(p.label);
  if (p.width) parts.push(p.width + '×' + p.height);
  return parts.join(' · ') || (status && status.preset === 'smooth' ? '流畅' : '高清');
}

// ---------- 开关 ----------
function applyEnabled(enabled) {
  state.enabled = !!enabled;
  const sw = el('live-enable');
  if (sw) sw.checked = state.enabled;
  const chip = el('live-state-chip');
  if (chip) {
    chip.classList.toggle('chip-on', state.enabled);
    chip.classList.toggle('chip-off', !state.enabled);
    chip.querySelector('.chip-dot')?.classList.toggle('hidden', !state.enabled);
  }
  const text = el('live-state-text');
  if (text) text.textContent = state.enabled ? '已开启' : '未开启';
  el('live-off-tip')?.classList.toggle('hidden', state.enabled);
  el('live-panel-cast')?.classList.toggle('locked', !state.enabled);
  el('live-panel-watch')?.classList.toggle('locked', !state.enabled);
  ['live-start-btn', 'live-watch-btn', 'live-source-refresh', 'live-source'].forEach((id) => {
    const node = el(id);
    if (node) node.disabled = !state.enabled;
  });
  if (!state.enabled) stopWatching(true);
}

async function setEnabled(enabled) {
  applyEnabled(enabled);
  try {
    await window.lume.settings.set({ liveEnabled: enabled });
    if (enabled) toast('屏幕直播已开启', 'success');
    else {
      await stopBroadcast(true);
      toast('屏幕直播已关闭', 'info');
    }
  } catch (e) {
    toast('保存失败：' + ((e && e.message) || '未知错误'), 'error');
  }
}

// ---------- 画面来源 ----------
async function refreshSources(force) {
  if (!state.enabled) return;
  if (state.sourcesLoaded && !force) return;
  try {
    const list = await window.lume.live.sources();
    state.sources = Array.isArray(list) ? list : [];
    const sel = el('live-source');
    if (sel) {
      const prev = sel.value;
      sel.innerHTML = state.sources
        .map(
          (s) =>
            '<option value="' + s.id + '">' +
            (s.type === 'screen' ? '屏幕：' : '窗口：') +
            String(s.name || '').replace(/</g, '&lt;') +
            '</option>'
        )
        .join('');
      if (prev && state.sources.some((s) => s.id === prev)) sel.value = prev;
    }
    state.sourcesLoaded = true;
  } catch (e) {
    toast('读取画面列表失败：' + ((e && e.message) || '未知错误'), 'error');
  }
}

// ---------- 主播端 ----------
function renderIdle() {
  el('live-setup')?.classList.remove('hidden');
  el('live-card')?.classList.add('hidden');
  if (state.statusTimer) {
    clearInterval(state.statusTimer);
    state.statusTimer = null;
  }
  if (state.elapsedTimer) {
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }
  const chip = el('live-state-chip');
  if (chip && state.enabled) {
    chip.classList.remove('chip-on');
    chip.classList.add('chip-off');
    chip.querySelector('.chip-dot')?.classList.add('hidden');
    const text = el('live-state-text');
    if (text) text.textContent = '已开启';
  }
}

function renderBroadcast(status) {
  el('live-setup')?.classList.add('hidden');
  el('live-card')?.classList.remove('hidden');
  el('live-code').textContent = groupCode(status.roomCode);
  const url = primaryUrl(status);
  el('live-url').textContent = url || '未获取到局域网地址';
  el('live-qr').innerHTML = url ? qrSvg(url, 4) : '';
  el('live-profile').textContent = labelOf(status);
  el('live-viewers').textContent = String(status.viewers ? status.viewers.total : 0);
  startElapsed(status.startedAt);
  const chip = el('live-state-chip');
  if (chip) {
    chip.classList.remove('chip-off');
    chip.classList.add('chip-on');
    chip.querySelector('.chip-dot')?.classList.remove('hidden');
    const text = el('live-state-text');
    if (text) text.textContent = '直播中';
  }
  if (!state.statusTimer) {
    state.statusTimer = setInterval(pollLocalStatus, 2000);
  }
}

function startElapsed(startedAt) {
  if (state.elapsedTimer) clearInterval(state.elapsedTimer);
  const tick = () => {
    const node = el('live-elapsed');
    if (!node) return;
    node.textContent = fmtElapsed(Date.now() - (startedAt || Date.now()));
  };
  tick();
  state.elapsedTimer = setInterval(tick, 1000);
}

async function pollLocalStatus() {
  try {
    const st = await window.lume.live.status();
    state.status = st;
    if (!st.running) {
      renderIdle();
      return;
    }
    el('live-viewers').textContent = String((st.viewers && st.viewers.total) || 0);
    const profileText = labelOf(st);
    if (el('live-profile').textContent !== profileText) el('live-profile').textContent = profileText;
    const url = primaryUrl(st);
    if (url && el('live-url').textContent !== url) {
      el('live-url').textContent = url;
      el('live-qr').innerHTML = qrSvg(url, 4);
    }
  } catch {
    /* 忽略轮询错误 */
  }
}

async function startBroadcast() {
  if (!state.enabled) {
    toast('请先开启屏幕直播', 'error');
    return;
  }
  const btn = el('live-start-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '正在启动…';
  }
  try {
    const sourceId = el('live-source') ? el('live-source').value : '';
    const st = await window.lume.live.start({ sourceId, preset: state.preset });
    state.status = st;
    renderBroadcast(st);
    toast('直播已开始，把房间码或二维码发给对方即可观看', 'success');
  } catch (e) {
    toast('直播启动失败：' + ((e && e.message) || '未知错误'), 'error');
  } finally {
    if (btn) {
      btn.disabled = !state.enabled;
      btn.textContent = '开始直播';
    }
  }
}

async function stopBroadcast(silent) {
  try {
    await window.lume.live.stop();
  } catch {
    /* 已停止 */
  }
  state.status = null;
  renderIdle();
  if (!silent) toast('直播已结束', 'info');
}

// ---------- 观众端 ----------
function setWatchBusy(busy, label) {
  const btn = el('live-watch-btn');
  if (!btn) return;
  btn.disabled = busy || !state.enabled;
  btn.textContent = busy ? label || '正在连接…' : '观看直播';
}

function ensurePlayer() {
  if (state.player) return state.player;
  const video = el('live-video');
  if (!video) return null;
  state.player = new LumeLivePlayer(video, {
    onState: (kind, text) => {
      const overlay = el('live-overlay');
      const textEl = el('live-overlay-text');
      if (kind === 'playing') {
        overlay?.classList.add('hidden');
        return;
      }
      if (textEl) textEl.textContent = text || '正在连接…';
      overlay?.classList.remove('hidden');
    },
    onMeta: (meta) => {
      state.meta = meta;
      updatePlayerMeta();
    },
  });
  return state.player;
}

function streamUrls(w) {
  const key = encodeURIComponent(w.key || '');
  const port = w.port || 16900;
  const hdPort = w.hdPort || port + 1;
  return {
    web: 'http://' + w.host + ':' + port + '/stream/' + key,
    hd: 'http://' + w.host + ':' + hdPort + '/hd/' + key,
  };
}

function pointPlayer() {
  const player = ensurePlayer();
  if (!player || !state.watching) return;
  const urls = streamUrls(state.watching);
  player.start(state.watching.quality === 'hd' ? urls.hd : urls.web);
}

function updatePlayerMeta() {
  const parts = [];
  const m = state.meta || {};
  if (m.width) parts.push(m.width + '×' + m.height);
  if (m.mime) parts.push(/vp9/i.test(m.mime) ? 'VP9' : /vp8/i.test(m.mime) ? 'VP8' : '视频');
  if (m.bitrate) parts.push(Math.round(m.bitrate / 1000000) + ' Mbps');
  if (state.viewers != null) parts.push(state.viewers + ' 人观看');
  const text = parts.join(' · ');
  if (text && el('live-player-meta')) el('live-player-meta').textContent = text;
}

function startWatching(conn, room) {
  stopWatching(true);
  state.watching = {
    host: conn.host,
    port: conn.port,
    hdPort: conn.hdPort,
    key: conn.token,
    room: room || conn.room || '',
    quality: 'hd',
  };
  state.meta = null;
  el('live-player-card')?.classList.remove('hidden');
  el('live-overlay')?.classList.remove('hidden');
  const textEl = el('live-overlay-text');
  if (textEl) textEl.textContent = '正在连接直播画面…';
  el('live-player-meta').textContent = state.watching.room ? '房间码 ' + state.watching.room : '直播中';
  document.querySelectorAll('#live-watch-quality button').forEach((b) => {
    b.classList.toggle('on', b.dataset.q === 'hd');
  });
  pointPlayer();
  if (!state.remoteTimer) state.remoteTimer = setInterval(pollRemoteStatus, 4000);
  pollRemoteStatus();
}

async function pollRemoteStatus() {
  if (!state.watching) return;
  try {
    const s = await window.lume.live.remoteStatus({
      host: state.watching.host,
      port: state.watching.port,
    });
    if (!s || !s.running) {
      el('live-player-meta').textContent = '直播已结束';
      return;
    }
    if (s.hdPort) state.watching.hdPort = s.hdPort;
    state.viewers = s.viewers ? s.viewers.total : 0;
    updatePlayerMeta();
  } catch {
    /* 忽略 */
  }
}

function stopWatching(silent) {
  if (state.remoteTimer) {
    clearInterval(state.remoteTimer);
    state.remoteTimer = null;
  }
  const was = !!state.watching;
  state.watching = null;
  state.meta = null;
  if (state.player) state.player.stop();
  el('live-player-card')?.classList.add('hidden');
  el('live-overlay')?.classList.add('hidden');
  if (was && !silent) toast('已退出观看', 'info');
}

async function watch() {
  if (!state.enabled) {
    toast('请先开启屏幕直播', 'error');
    return;
  }
  let code = (el('live-room-input')?.value || '').trim();
  let host = (el('live-host-input')?.value || '').trim();

  // 支持直接把整条直播链接粘贴到房间码或地址输入框
  const pasted = /^https?:\/\//i.test(code) ? code : /^https?:\/\//i.test(host) ? host : '';
  if (pasted) {
    try {
      const parsed = await window.lume.live.resolve({ input: pasted });
      if (parsed && parsed.ok) {
        host = parsed.host || host;
        code = parsed.code || parsed.token || code;
        if (el('live-host-input')) el('live-host-input').value = host;
        if (el('live-room-input')) el('live-room-input').value = code;
      }
    } catch {
      /* 继续按原内容处理 */
    }
  }

  if (!/^\d{10}$/.test(code) && !/^[A-Za-z0-9]{38}$/.test(code)) {
    toast('请输入 10 位数字房间码，或直接粘贴主播的直播链接', 'error');
    return;
  }
  if (!host) {
    toast('请填写主播地址（例如 192.168.1.8:16900）', 'error');
    return;
  }
  setWatchBusy(true, '正在连接…');
  try {
    const conn = await window.lume.live.connect({ host, code });
    setWatchBusy(false);
    startWatching(conn, /^\d{10}$/.test(code) ? code : '');
    try {
      await window.lume.settings.set({ liveLastHost: host });
    } catch {
      /* ignore */
    }
  } catch (e) {
    setWatchBusy(false);
    toast('连接失败：' + ((e && e.message) || '未知错误'), 'error');
  }
}

// ---------- 公共 ----------
export function initLiveView() {
  el('live-enable')?.addEventListener('change', (e) => setEnabled(e.target.checked));

  el('live-source-refresh')?.addEventListener('click', () => {
    state.sourcesLoaded = false;
    refreshSources(true);
  });

  el('live-preset')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-preset]');
    if (!btn) return;
    state.preset = btn.dataset.preset;
    document.querySelectorAll('#live-preset button').forEach((b) => b.classList.toggle('on', b === btn));
    try {
      await window.lume.settings.set({ livePreset: state.preset });
      if (state.status && state.status.running) {
        const st = await window.lume.live.setPreset(state.preset);
        if (st) {
          state.status = st;
          el('live-profile').textContent = labelOf(st);
        }
        toast('已切换清晰度：' + btn.textContent.trim(), 'success');
        if (state.player && state.watching) pointPlayer();
      }
    } catch (err) {
      toast('切换清晰度失败：' + ((err && err.message) || '未知错误'), 'error');
    }
  });

  el('live-start-btn')?.addEventListener('click', startBroadcast);
  el('live-stop-btn')?.addEventListener('click', () => stopBroadcast(false));

  el('live-copy-code')?.addEventListener('click', async () => {
    const code = String((state.status && state.status.roomCode) || '').replace(/\s/g, '');
    if (!code) return;
    const ok = await copyText(code);
    toast(ok ? '房间码已复制' : '复制失败', ok ? 'success' : 'error');
  });

  el('live-copy-url')?.addEventListener('click', async () => {
    const url = el('live-url')?.textContent || '';
    if (!url || /未获取/.test(url)) return;
    const ok = await copyText(url);
    toast(ok ? '直播地址已复制' : '复制失败', ok ? 'success' : 'error');
  });

  el('live-room-input')?.addEventListener('input', (e) => {
    const raw = String(e.target.value || '');
    if (/[A-Za-z]/.test(raw)) return;
    e.target.value = raw.replace(/\D/g, '').slice(0, 10);
  });
  el('live-room-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') watch();
  });
  el('live-host-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') watch();
  });

  el('live-watch-btn')?.addEventListener('click', watch);

  el('live-watch-quality')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-q]');
    if (!btn || !state.watching) return;
    if (state.watching.quality === btn.dataset.q) return;
    state.watching.quality = btn.dataset.q;
    document.querySelectorAll('#live-watch-quality button').forEach((b) => b.classList.toggle('on', b === btn));
    pointPlayer();
  });

  el('live-full-btn')?.addEventListener('click', () => {
    const wrap = el('live-player-wrap');
    if (!wrap) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    const fn = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
    if (fn) {
      const r = fn.call(wrap);
      if (r && r.catch) r.catch(() => {});
    }
  });

  el('live-close-btn')?.addEventListener('click', () => stopWatching(false));

  window.lume.live.onViewers((v) => {
    if (state.status && state.status.running) {
      el('live-viewers').textContent = String((v && v.total) || 0);
    }
  });

  window.lume.live.onError((payload) => {
    if (payload && payload.message) toast(payload.message, 'error');
  });

  applyEnabled(!!getCachedSettings().liveEnabled);
  state.preset = getCachedSettings().livePreset === 'smooth' ? 'smooth' : 'hd';
  document.querySelectorAll('#live-preset button').forEach((b) => {
    b.classList.toggle('on', b.dataset.preset === state.preset);
  });
}

export async function activateLiveView() {
  await loadSettingsCache();
  applyEnabled(!!getCachedSettings().liveEnabled);
  const lastHost = getCachedSettings().liveLastHost || '';
  const hostInput = el('live-host-input');
  if (hostInput && !hostInput.value && lastHost) hostInput.value = lastHost;
  if (!state.enabled) return;
  if (!state.sourcesLoaded) refreshSources(false);
  try {
    const st = await window.lume.live.status();
    state.status = st;
    if (st && st.running) renderBroadcast(st);
    else renderIdle();
  } catch {
    /* ignore */
  }
}
