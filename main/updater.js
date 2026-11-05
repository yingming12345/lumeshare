// 更新检测与自动安装：通过官方接口获取最新下载链接与验证码，验证码变化即代表新版本
// 接口地址与访问令牌存放在加密保险箱（shared/vault.js）中，仅在主进程内存中解密
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app } = require('electron');
const settings = require('./settings');
const logger = require('./logger');
const vault = require('../shared/vault');

const CLIENT_UA = 'LumeShare-Client/2.0.4';
const MAX_BODY = 512 * 1024;

// 取出并校验更新服务配置（解密失败或未配置时返回 null）
function apiConfig() {
  const cfg = vault.get('update');
  if (!cfg || typeof cfg.url !== 'string' || typeof cfg.token !== 'string') return null;
  if (!/^https:\/\/[a-z0-9.-]+\/[a-z0-9/._-]+$/i.test(cfg.url)) return null;
  if (!/^[a-f0-9]{32,64}$/i.test(cfg.token)) return null;
  return cfg;
}

// 统一清理错误文案：绝不把接口地址、域名或令牌带进日志与界面
function safeError(err) {
  const text = String((err && err.message) || err || '');
  return text.replace(/https?:\/\/\S+/gi, '').replace(/[a-z0-9-]+(\.[a-z0-9-]+)+\S*/gi, '').trim() || '网络请求失败';
}

function httpGetJson(url, timeoutMs, extraHeaders) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(
      url,
      {
        timeout: timeoutMs || 15000,
        headers: Object.assign({ 'User-Agent': CLIENT_UA, Accept: 'application/json' }, extraHeaders || {}),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY) {
            req.destroy(new Error('响应过大'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('error', () => reject(new Error('无法连接更新服务器，请检查网络后重试')));
    req.on('timeout', () => {
      req.destroy(new Error('连接更新服务器超时'));
    });
  });
}

// 检查是否有新版本
// 传给更新接口的版本号：只允许数字与符号（去掉字母等非法字符）
function apiVersion() {
  const raw = String(app.getVersion() || '0.0.0');
  const clean = raw.replace(/[^0-9.]/g, '').replace(/^\.+|\.+$/g, '');
  return clean || '0.0.0';
}

// 版本号比较（按 . 分段逐段数值比较；0.4 与 0.4.0 视为相同）
function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

async function checkUpdate() {
  const cfg = apiConfig();
  if (!cfg) throw new Error(safeError('更新服务暂不可用，请稍后重试'));
  const version = apiVersion();
  // 令牌通过请求头传递，不放入 URL，避免出现在代理与访问日志中
  const res = await httpGetJson(
    cfg.url + '?version=' + encodeURIComponent(version),
    15000,
    { 'X-Token': cfg.token }
  );
  if (res.status !== 200) throw new Error(safeError('更新服务器响应异常（HTTP ' + res.status + '）'));
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new Error(safeError('更新服务器返回数据无法解析'));
  }
  if (json.code !== 0 || !json.data) {
    if (json.code === 429) {
      const left = json.data && json.data.remaining_seconds;
      throw new Error('请求过于频繁，请稍后再试' + (left ? '（' + left + ' 秒后重试）' : ''));
    }
    if (json.code === 401) throw new Error(safeError('更新服务鉴权失败，请联系管理员'));
    if (json.code === 400) throw new Error(safeError(json.message || '版本号格式不正确'));
    throw new Error(safeError(json.message || '更新服务器返回错误'));
  }
  // 新接口由服务端比对版本号：data.update === 'yes' 表示需要更新
  const data = json.data;
  let hasUpdate = data.update === 'yes';
  const latestVersion = data.version || '';
  // 保险：若服务端返回了版本号且并不比当前版本更新，则不提示更新（避免误提示降级）
  if (hasUpdate && latestVersion && cmpVersion(latestVersion, version) <= 0) {
    try {
      logger.warn('update:version-guard', { client: version, server: latestVersion });
    } catch {
      /* 日志失败不影响更新检测 */
    }
    hasUpdate = false;
  }
  const info = {
    hasUpdate,
    name: data.name || 'LumeShare',
    url: hasUpdate ? data.download_url || '' : '',
    date: data.date || '',
    code: data.verify_code || '',
    latestVersion,
    clientVersion: data.client_version || version,
    forceUpdate: hasUpdate && data.force_update === 'yes',
  };
  // 记录验证码，供“取消过的版本不再自动打扰”使用
  if (info.code) {
    try {
      settings.set({ updateCode: info.code });
    } catch {
      /* ignore */
    }
  }
  return info;
}

// 下载安装包到临时目录，返回文件路径；onProgress({received, total, percent})
function downloadUpdate(url, onProgress) {
  return new Promise((resolve, reject) => {
    // 安全校验：只允许通过 HTTPS 下载安装包
    if (!/^https:\/\//i.test(String(url || ''))) {
      reject(new Error('更新地址不安全，已取消下载'));
      return;
    }
    const mod = url.startsWith('https:') ? https : http;
    const outPath = path.join(app.getPath('temp'), 'LumeShare-Updater-' + Date.now() + '.exe');
    const req = mod.get(url, { timeout: 60000, headers: { 'User-Agent': CLIENT_UA } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error('下载失败（HTTP ' + res.statusCode + '）'));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      let received = 0;
      const out = fs.createWriteStream(outPath);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (typeof onProgress === 'function') {
          onProgress({ received, total, percent: total ? Math.min(100, Math.round((received / total) * 100)) : 0 });
        }
      });
      res.pipe(out);
      out.on('finish', () => resolve(outPath));
      out.on('error', (e) => {
        try {
          fs.unlinkSync(outPath);
        } catch {
          /* ignore */
        }
        reject(e);
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => req.destroy(new Error('下载超时')));
  });
}

// 查找旧版本安装位置（注册表 InstallLocation / UninstallString 所在目录）
function findInstallDir() {
  try {
    const roots = [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ];
    for (const root of roots) {
      try {
        const out = execFileSync('reg', ['query', root, '/s', '/f', 'LumeShare', '/d'], { encoding: 'utf8', timeout: 10000 });
        // 找 InstallLocation 行
        const locMatch = out.match(/^\s*InstallLocation\s+REG_SZ\s+(.+)$/m);
        if (locMatch && fs.existsSync(locMatch[1].trim())) return locMatch[1].trim();
        // 回退：UninstallString 所在目录
        const unMatch = out.match(/^\s*UninstallString\s+REG_SZ\s+"?([^"\r\n]+)"?/m);
        if (unMatch) {
          const dir = path.dirname(unMatch[1].trim());
          if (fs.existsSync(dir)) return dir;
        }
      } catch {
        /* 该根键不可用 */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

// 应用更新：更新本地验证码记录，启动新安装程序（已安装则静默装到旧位置，未安装则由用户选择）
function applyUpdate(downloadPath, verifyCode) {
  // 安全校验：只允许运行由本程序下载到临时目录、且体积正常的安装包
  const tmpRoot = path.resolve(app.getPath('temp'));
  const file = path.resolve(String(downloadPath || ''));
  if (!file.startsWith(tmpRoot + path.sep) || path.extname(file).toLowerCase() !== '.exe') {
    throw new Error(safeError('安装包路径异常，已取消安装'));
  }
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    throw new Error(safeError('安装包不存在，请重新下载'));
  }
  if (size < 1024 * 1024) throw new Error(safeError('安装包不完整，请重新下载'));

  const installDir = findInstallDir();
  const args = [];
  if (installDir) {
    // 已安装过：静默安装到上一版所在位置（安装器会自动先卸载旧版本）
    args.push('/S', '/D=' + installDir, '--force-run');
  }
  const { spawn } = require('child_process');
  const proc = spawn(downloadPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  proc.unref();
  // 记录本次确认的验证码，避免下次重复提示
  if (verifyCode) settings.set({ updateCode: verifyCode });
  return { installDir };
}

module.exports = { checkUpdate, downloadUpdate, applyUpdate, findInstallDir, safeError };
