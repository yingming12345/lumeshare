// LumeShare 渲染层入口：局域网分享 / 屏幕直播 / 文件库 / 设置
// 性能说明：启动时只初始化当前页面，其余页面首次进入时再按需加载，避免一次性加载全部模块造成卡顿
import { icons } from './modules/icons.js';
import { toast } from './modules/files.js';

let feedbackUrl = '';
let currentView = '';
const inited = { share: false, live: false, settings: false, files: false };

function initWindowControls() {
  document.getElementById('tb-min').addEventListener('click', () => window.lume.win.minimize());
  document.getElementById('tb-max').addEventListener('click', () => window.lume.win.maximizeToggle());
  document.getElementById('tb-close').addEventListener('click', () => window.lume.win.close());

  const maxBtn = document.getElementById('tb-max');
  window.lume.win.isMaximized().then((m) => {
    maxBtn.innerHTML = m ? icons.restore : icons.max;
  });
  window.lume.win.onMaximizedChange((m) => {
    maxBtn.innerHTML = m ? icons.restore : icons.max;
    document.body.classList.toggle('maximized', m);
  });

  const tb = document.getElementById('titlebar');
  tb.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tb-btn')) return;
    window.lume.win.maximizeToggle();
  });
}

async function openFeedbackForm() {
  try {
    if (!feedbackUrl) {
      const info = await window.lume.app.info();
      feedbackUrl = (info && info.feedbackUrl) || '';
    }
    if (!feedbackUrl) {
      toast('反馈地址不可用，请稍后再试', 'error');
      return;
    }
    const r = await window.lume.app.openExternal(feedbackUrl);
    if (r && r.ok) toast('已在浏览器中打开意见反馈表单', 'success');
    else toast('打开失败：' + ((r && r.error) || '未知错误'), 'error');
  } catch (e) {
    toast('打开失败：' + ((e && e.message) || '未知错误'), 'error');
  }
}

const NAV_VIEWS = ['share', 'live', 'files', 'settings'];

async function ensureView(name) {
  if (inited[name]) return;
  inited[name] = true;
  try {
    if (name === 'share') {
      const m = await import('./modules/share.js');
      m.initShareView();
      m.bindShareEvents();
    } else if (name === 'live') {
      const m = await import('./modules/live.js');
      m.initLiveView();
    } else if (name === 'settings') {
      const m = await import('./modules/settings.js');
      await m.loadSettingsCache();
      m.initSettingsView();
    } else if (name === 'files') {
      const m = await import('./modules/files.js');
      m.initFilesView();
    }
  } catch (e) {
    inited[name] = false;
    toast('页面加载失败：' + ((e && e.message) || ''), 'error');
  }
}

export async function setView(view) {
  const name = String(view || 'share');
  currentView = name;
  await ensureView(name);
  const navView = NAV_VIEWS.includes(name) ? name : '';
  document.querySelectorAll('.nav-item').forEach((i) => {
    i.classList.toggle('active', i.dataset.view === navView);
  });
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === 'view-' + name);
  });
  try {
    if (name === 'share') {
      const m = await import('./modules/share.js');
      await m.activateShareView();
    } else if (name === 'live') {
      const m = await import('./modules/live.js');
      m.activateLiveView();
    } else if (name === 'settings') {
      const m = await import('./modules/settings.js');
      await m.refreshSettingsView();
    } else if (name === 'files') {
      const m = await import('./modules/files.js');
      await m.refreshFilesView();
    }
  } catch (e) {
    toast('页面加载失败：' + ((e && e.message) || ''), 'error');
  }
}

function initNav() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      if (view === 'feedback') {
        openFeedbackForm();
        return;
      }
      setView(view);
    });
  });
  window.addEventListener('lume:navigate', (e) => setView(String(e.detail || 'share')));
}

// 渲染层异常只记录日志，不弹出错误打断用户
window.addEventListener('error', (event) => {
  try {
    window.lume.log.event({
      action: 'renderer:error',
      level: 'error',
      detail: { message: String(event.message || ''), source: String(event.filename || ''), line: event.lineno || 0 },
    });
  } catch {
    /* ignore */
  }
});
window.addEventListener('unhandledrejection', (event) => {
  try {
    const reason = event.reason;
    window.lume.log.event({
      action: 'renderer:rejection',
      level: 'error',
      detail: { message: String((reason && reason.message) || reason || '') },
    });
  } catch {
    /* ignore */
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  initWindowControls();
  initNav();

  // 默认进入局域网分享
  await setView('share');

  // 启动后延迟检测更新，避免与首屏渲染抢资源
  const isUiTest = new URLSearchParams(window.location.search).has('uitest');
  if (!isUiTest) {
    setTimeout(async () => {
      try {
        const m = await import('./modules/update.js');
        m.autoCheckOnStart();
      } catch {
        /* ignore */
      }
    }, 4000);
  }

  // 自测入口（仅 --selftest 使用）
  if (new URLSearchParams(window.location.search).get('selftest') === '1') {
    import('./modules/selftest.js').then((m) => m.runRendererSelftest()).catch(() => {});
  }

  window.lumeCurrentView = () => currentView;
});
