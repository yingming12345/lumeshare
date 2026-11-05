// 设置视图：缓存、启动行为、性能、日志上报、系统信息
import { icons } from './icons.js';
import { formatSize, escapeHtml } from './util.js';
import { toast } from './files.js';
import { checkAndShowUpdate } from './update.js';
import { confirmDialog } from './dialog.js';

let cached = null;
let uiReady = false;

function el(id) {
  return document.getElementById(id);
}

// 同步读取缓存设置（启动时由 app.js 调用 loadSettingsCache 填充）
export function getCachedSettings() {
  return (
    cached || {
      thumbCacheLimitMB: 300,
      autoScanOnStart: true,
      autoStartShare: false,
      launchAtStartup: false,
      gridImageQuality: 'thumb',
    }
  );
}

export async function loadSettingsCache() {
  try {
    cached = await window.lume.settings.get();
  } catch {
    cached = getCachedSettings();
  }
  return cached;
}

export function initSettingsView() {
  if (uiReady) return;
  uiReady = true;
  bindControls();
  refreshAll();
}

export async function refreshSettingsView() {
  try {
    cached = await window.lume.settings.get();
  } catch {
    /* ignore */
  }
  refreshAll();
}

function refreshAll() {
  const s = getCachedSettings();
  el('cache-dir').textContent = s.thumbCacheDir || '-';
  el('cache-dir').title = s.thumbCacheDir || '';
  el('cache-limit').value = String(s.thumbCacheLimitMB);
  el('opt-autoscan').checked = !!s.autoScanOnStart;
  el('opt-autoshare').checked = !!s.autoStartShare;
  el('opt-launch').checked = !!s.launchAtStartup;
  el('opt-compat').checked = !!s.compatMode;
  if (s.gridImageQuality === 'original') el('q-original').checked = true;
  else el('q-thumb').checked = true;
  if (s.defaultVideoPlayer === 'system') el('vp-system').checked = true;
  else el('vp-builtin').checked = true;
  window.lume.app.info().then((info) => {
    el('app-version').textContent = 'v' + (info.version || '2.0.2');
  });
  refreshTrayState(s);
  refreshCacheInfo();
  refreshShareStorage();
  refreshLogSummary();
  refreshBgmState(s);
}

// 背景音乐：开关状态 + 播放状态文案（不弹窗）
let bgmTimer = null;
function refreshBgmState(s) {
  const sw = el('opt-bgm');
  if (sw) sw.checked = !!(s || getCachedSettings()).bgmEnabled;
  pollBgmStatus();
}

function pollBgmStatus(times) {
  const left = typeof times === 'number' ? times : 3;
  if (!window.lume.music) return;
  window.lume.music
    .status()
    .then((st) => {
      const line = el('bgm-status');
      if (!line || !st) return;
      if (st.error) line.textContent = st.error;
      else if (st.downloading) line.textContent = '正在下载音乐到本地…（首次开启需要下载一次）';
      else if (st.playing) line.textContent = '播放中：已在后台循环播放，可随时关闭（不影响任何操作）';
      else if (st.enabled && st.ready) line.textContent = '已开启：音乐已在本地，正在启动播放…';
      else if (st.enabled) line.textContent = '已开启：音乐暂不可用，请检查网络后重新开关一次';
      else line.textContent = '默认关闭；开启后自动把音乐下载到本地并在后台循环播放，不会弹出任何界面';
    })
    .catch(() => {});
  if (left > 1) {
    if (bgmTimer) clearTimeout(bgmTimer);
    bgmTimer = setTimeout(() => pollBgmStatus(left - 1), 2500);
  }
}


// 托盘开关状态
function refreshTrayState(s) {
  const tray = el('opt-tray');
  if (tray) tray.checked = !!s.closeToTray;
}

function refreshCacheInfo() {
  window.lume.settings.cacheInfo().then((info) => {
    el('cache-usage').textContent =
      (info.count ? info.count.toLocaleString('zh-CN') + ' 张缩略图 · ' : '') + formatSize(info.size);
  });
}

// 局域网分享存储位置：显示所在盘符、已分享文件数量与占用
function refreshShareStorage() {
  window.lume.share
    .storageInfo()
    .then((si) => {
      const dirEl = el('share-storage-dir');
      const sumEl = el('share-storage-summary');
      if (!dirEl || !si) return;
      dirEl.textContent = si.dir || '-';
      dirEl.title = si.dir || '';
      if (!sumEl) return;
      if (!si.exists || !si.fileCount) {
        sumEl.textContent = si.isDefault ? '暂无已分享文件（默认位置）' : '暂无已分享文件';
        return;
      }
      const drive = si.drive ? si.drive.replace(/[\\/:]/g, '') + ' 盘' : '当前盘';
      sumEl.textContent = '保存在 ' + drive + ' · 共 ' + si.fileCount + ' 个文件 · 占用 ' + formatSize(si.size);
    })
    .catch(() => {
      const sumEl = el('share-storage-summary');
      if (sumEl) sumEl.textContent = '读取失败';
    });
}

function refreshLogSummary() {
  window.lume.log.todaySummary().then((s) => {
    if (!s) return;
    const parts = [];
    if (s.counts && s.counts.error) parts.push('故障 ' + s.counts.error + ' 条');
    if (s.counts && s.counts.warn) parts.push('警告 ' + s.counts.warn + ' 条');
    parts.push('共 ' + s.count + ' 条记录');
    const since = s.firstDate ? '自 ' + s.firstDate + ' 起' : '从安装起';
    el('log-summary').textContent = since + ' · ' + parts.join(' · ');
  });
}

function bindControls() {
  // 缓存位置
  el('cache-dir-btn').addEventListener('click', async () => {
    const dir = await window.lume.settings.pickCacheDir();
    if (!dir) return;
    await window.lume.settings.set({ thumbCacheDir: dir });
    cached = await window.lume.settings.get();
    refreshAll();
    toast('缓存位置已更新', 'success');
  });
  el('cache-dir-reset').addEventListener('click', async () => {
    const dir = await window.lume.settings.resetCacheDir();
    cached = await window.lume.settings.get();
    refreshAll();
    toast('已恢复默认缓存位置：' + dir, 'success');
  });

  // 分享存储位置（更改 / 恢复默认）
  el('share-storage-btn').addEventListener('click', async () => {
    const dir = await window.lume.file.pickFolder({ title: '选择分享文件存储目录（建议使用专门的文件夹）' });
    if (!dir) return;
    const btn = el('share-storage-btn');
    btn.disabled = true;
    try {
      const r = await window.lume.share.setStorageDir(dir);
      if (r && r.ok) {
        cached = await window.lume.settings.get();
        refreshAll();
        toast(r.moved ? '存储位置已更改，已迁移 ' + r.moved + ' 个已分享文件' : '存储位置已更改', 'success');
      } else {
        toast('更改失败：' + ((r && r.error) || '未知错误'), 'error');
      }
    } catch (e) {
      toast('更改失败：' + (e && e.message), 'error');
    } finally {
      btn.disabled = false;
    }
  });
  el('share-storage-reset').addEventListener('click', async () => {
    const btn = el('share-storage-reset');
    btn.disabled = true;
    try {
      const r = await window.lume.share.setStorageDir(null);
      if (r && r.ok) {
        cached = await window.lume.settings.get();
        refreshAll();
        toast(r.moved ? '已恢复默认位置，已迁移 ' + r.moved + ' 个已分享文件' : '已恢复默认存储位置', 'success');
      } else {
        toast('操作失败：' + ((r && r.error) || '未知错误'), 'error');
      }
    } catch (e) {
      toast('操作失败：' + (e && e.message), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // 一键清空已分享文件（红色按钮 + 确认弹窗，属重要操作）
  el('share-clear-btn').addEventListener('click', async () => {
    const okc = await confirmDialog({
      title: '清空已分享文件',
      text: '确定要清空保存在本机的全部已分享文件吗？<br>清空后，已生成的提取码与分享链接将立即失效，且文件无法恢复。',
      okText: '清空',
      danger: true,
    });
    if (!okc) return;
    const btn = el('share-clear-btn');
    btn.disabled = true;
    try {
      const r = await window.lume.share.clearFiles();
      if (r && r.ok) {
        refreshShareStorage();
        toast(r.removed ? '已清空 ' + r.removed + ' 个已分享文件' : '没有可清空的分享文件', 'success');
      } else {
        toast('清空失败：' + ((r && r.error) || '未知错误'), 'error');
      }
    } catch (e) {
      toast('清空失败：' + (e && e.message), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // 缓存上限
  el('cache-limit').addEventListener('change', async (e) => {
    const v = Number(e.target.value);
    await window.lume.settings.set({ thumbCacheLimitMB: v });
    cached = await window.lume.settings.get();
    toast('缓存上限已更新', 'success');
    refreshCacheInfo();
  });

  // 清空缓存
  el('cache-clear').addEventListener('click', async () => {
    const okc = await confirmDialog({
      title: '清空缩略图缓存',
      text: '确定要清空全部缩略图缓存吗？清空后首次打开图片会稍慢。',
      okText: '清空',
    });
    if (!okc) return;
    await window.lume.settings.clearCache();
    refreshCacheInfo();
    toast('缓存已清空', 'success');
  });

  // 开关项
  const bindSwitch = (id, key, msg) => {
    el(id).addEventListener('change', async (e) => {
      await window.lume.settings.set({ [key]: e.target.checked });
      cached = await window.lume.settings.get();
      toast(msg, 'success');
    });
  };
  bindSwitch('opt-autoscan', 'autoScanOnStart', '启动自动扫描设置已保存');
  bindSwitch('opt-autoshare', 'autoStartShare', '自动开启分享设置已保存');
  bindSwitch('opt-launch', 'launchAtStartup', '开机自启设置已保存');
  bindSwitch('opt-compat', 'compatMode', '兼容模式设置已保存，重启应用后生效');

  // 关闭后最小化到托盘（专用 IPC，立即生效）
  const trayOpt = el('opt-tray');
  if (trayOpt) {
    trayOpt.addEventListener('change', async (e) => {
      const r = await window.lume.tray.setCloseToTray(e.target.checked);
      if (r && r.ok) {
        toast(e.target.checked ? '已开启：关闭窗口后将最小化到托盘' : '已关闭：点击关闭按钮将退出程序', 'success');
      } else {
        trayOpt.checked = !e.target.checked;
        toast('设置失败', 'error');
      }
    });
  }

  // 背景音乐：开启后自动下载到本地并在后台循环播放（无界面、不打扰操作）
  const bgmSwitch = el('opt-bgm');
  if (bgmSwitch) {
    bgmSwitch.addEventListener('change', async (e) => {
      const on = !!e.target.checked;
      await window.lume.settings.set({ bgmEnabled: on });
      cached = await window.lume.settings.get();
      toast(on ? '背景音乐已开启，将在后台循环播放' : '背景音乐已关闭', 'success');
      pollBgmStatus(4);
    });
  }

  // 图片显示质量
  document.querySelectorAll('input[name="q"]').forEach((r) => {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      await window.lume.settings.set({ gridImageQuality: r.value });
      cached = await window.lume.settings.get();
      toast(r.value === 'original' ? '已切换为原图显示，重新进入图片分类后生效' : '已切换为缩略图显示，重新进入图片分类后生效', 'success');
    });
  });

  // 默认视频播放器
  document.querySelectorAll('input[name="vp"]').forEach((r) => {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      await window.lume.settings.set({ defaultVideoPlayer: r.value });
      cached = await window.lume.settings.get();
      toast(r.value === 'system' ? '已切换为系统默认播放器打开视频' : '已切换为内置播放器观看视频', 'success');
    });
  });

  // 下载日志：把本机操作日志保存到用户选择的位置（本地文件，不上传任何服务器）
  const logDownloadBtn = el('log-download-btn');
  if (logDownloadBtn) {
    logDownloadBtn.addEventListener('click', async () => {
      const btn = logDownloadBtn;
      btn.disabled = true;
      try {
        btn.textContent = '保存中…';
        const r = await window.lume.log.download();
        if (r && r.canceled) return;
        if (r && r.ok) {
          toast('加密日志已保存到本地（' + r.count + ' 条记录）', 'success');
          const line = el('log-summary');
          if (line && r.path) line.textContent = '已保存：' + r.path;
        } else {
          toast('保存失败：' + ((r && r.error) || '未知错误'), 'error');
        }
      } catch (e) {
        toast('保存失败：' + ((e && e.message) || '未知错误'), 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '下载日志';
      }
    });
  }

  // 检查更新（通过官方接口：验证码变化即代表新版本，弹出更新对话框）
  el('update-check-btn').addEventListener('click', async () => {
    el('update-check-btn').disabled = true;
    el('update-status').textContent = '正在检查更新…';
    try {
      const r = await checkAndShowUpdate({ auto: false });
      if (r && r.hasUpdate) {
        el('update-status').textContent = r.forceUpdate ? '发现强制更新版本' : '发现新版本，请在弹出的窗口中操作';
      } else if (r && r.error) {
        el('update-status').textContent = '检查失败：' + r.error;
      } else {
        el('update-status').textContent = '已是最新版本';
      }
    } catch (e) {
      el('update-status').textContent = '检查失败：' + e.message;
      toast('检查更新失败', 'error');
    } finally {
      el('update-check-btn').disabled = false;
    }
  });
}
