# LumeShare

[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2B-2563eb.svg)](#系统要求)
[![Electron](https://img.shields.io/badge/Electron-22-47848F.svg)](https://www.electronjs.org/)
[![Build](https://img.shields.io/badge/build-esbuild-ffcf00.svg)](scripts/build-web.js)

> Windows 局域网文件分享与屏幕直播工具，基于 Electron 构建。
> 在同一局域网内用 6 位提取码传文件、按分类浏览本机文件库、把屏幕实时直播给同一网络内的电脑或手机。
> 全程本地运行，不经过任何中转服务器。

## 下载与安装

请优先通过以下官方渠道获取程序，三种方式按推荐顺序排列：

| 渠道 | 说明 |
| --- | --- |
| <a href="https://ls.fur-myu.cn/" target="_blank" rel="noopener noreferrer">**官网**</a> | 项目官网：功能介绍、更新日志与最新下载入口（在新标签页打开） |
| <a href="https://github.com/yingming12345/lumeshare/releases/latest" target="_blank" rel="noopener noreferrer">**GitHub Release 下载**</a> | GitHub 官方发布页：**直接下载 Windows 安装包（`.exe`）**、SHA-256 校验文件与各版本源码归档 |
| <a href="https://1856515061.share.123pan.cn/123pan/Bwlrvd-rYmBv?pwd=yNtr" target="_blank" rel="noopener noreferrer">**网盘下载**</a> | 官方已打包的 Windows 安装包（x64，Windows 10 及以上），提取码 `yNtr` |

> [!IMPORTANT]
> **安装前请先阅读以下说明**
>
> 1. **GitHub Release 与网盘**提供的是同一份官方安装包，包含完整功能（含在线更新与官方服务接口）；安装包与本仓库源码构建出的版本可能存在差异；
> 2. **源码渠道**只包含核心功能源码（局域网分享 / 文件库 / 屏幕直播），私有接口地址、更新 Token、日志加密种子等一律未开源，自行构建的版本不会连接任何第三方服务；
> 3. 为保障安全，请只从**官网、本仓库 GitHub Release 或上述官方网盘**获取程序，**不要使用来源不明的二次打包版本**；
> 4. 下载后请确认文件名形如 `LumeShare-Setup-<版本号>.exe`（当前版本 **2.0.3**），系统要求为 Windows 10 / 11 64 位；
> 5. 建议核对 SHA-256：GitHub Release 同时提供 `LumeShare-Setup-<版本号>.exe.sha256` 校验文件；
> 6. 若链接失效、下载异常或发现异常文件，请在 [Issues](https://github.com/yingming12345/lumeshare/issues) 反馈，我们会尽快更新。



## 功能特性

### 局域网分享

- 拖拽 / 粘贴文件即可上传，自动生成 **6 位提取码** 与二维码
- 任意设备打开 `http://<局域网IP>:16888/`，输入提取码即可下载
- 内置 UDP 设备发现（端口 `17890`），可自动列出同一网段内正在分享的电脑
- 支持「获取文件」：从局域网内其它开启了 LumeShare 的电脑上取文件
- 大文件流式传输，全程内网直连，不上传任何云端

### 文件库

- 扫描本机磁盘，按 **图片 / 视频 / PDF / 文档 / 应用 / 其它** 分类浏览
- 全局文件名搜索、缩略图预览、排序与分页加载
- 每个文件可一键分享到局域网（生成提取码）、打开、定位所在文件夹或复制文件

### 屏幕直播

- 把屏幕实时直播给局域网内的电脑或手机，独立页面操作
- 两个固定端口：`16900`（网页直播服务 + 流畅画质）、`16901`（高清画质），与分享端口完全隔离
- 观看端使用浏览器**原生 `<video>`** 播放（MediaRecorder 编码 WebM/VP8 + Media Source Extensions），支持全屏 1080P
- 房间码（10 位数字）、直播地址（38 位随机令牌）、二维码三种入口
- 支持清晰度切换、观看人数统计、断线重连

### 设置

- 缩略图缓存位置与上限、启动扫描、启动自动开启分享、开机自启、关闭到托盘
- 操作日志：本地记录，可「下载日志」保存为加密的 `.lslog` 文件
- 检查更新：开源版默认关闭，需自行配置更新接口（见「配置说明」）

## 系统要求

- Windows 10 / 11，64 位（x64）
- 安装器与应用启动均会校验系统版本，**Windows 7 / 8 / 8.1 不受支持**

## 技术栈

| 层 | 实现 |
| --- | --- |
| 运行时 | Electron 22（Windows 10+ / x64） |
| 界面 | 原生 HTML + CSS + ES Module，esbuild 打包为单个 bundle |
| 分享服务 | Node.js `http` + UDP 广播（`main/share.js`） |
| 直播采集 | `desktopCapturer` + `getUserMedia` + `MediaRecorder`（WebM/VP8） |
| 直播播放 | 浏览器原生 `<video>` + Media Source Extensions（`shared/live-player.js`） |
| 文件预览 | pdfjs-dist、docx-preview、原生 `<img>` / `<video>` |

## 目录结构

```
main/          主进程：窗口、IPC、分享服务、直播服务、扫描、缩略图、日志
preload/       预加载脚本：向渲染层暴露受控 API
renderer/      渲染层界面（index.html / styles.css / modules）
share-web/     局域网分享的网页端（手机浏览器访问）
live-web/      屏幕直播的观看页（浏览器访问）
shared/        前后端共用模块（协议配置、日志加密、直播播放器）
scripts/       构建脚本（esbuild 打包、图标、打包后处理）
build/         安装器脚本与图标资源
docs/          协议文档（局域网分享协议、屏幕直播接口）
```

## 开发与构建

环境要求：Windows 10 及以上、Node.js 18+、npm。

```bash
npm install          # 安装依赖
npm run web          # 打包渲染层（renderer/dist/app.bundle.js）
npm start            # 构建并启动开发版
npm run dist         # 生成 Windows 安装包（dist/LumeShare-Setup-<version>.exe）
```

> 构建产物 `renderer/dist/` 与 `dist/` 已在 `.gitignore` 中忽略，克隆后需先执行 `npm install` 与 `npm run web`。

## 配置说明

开源版本**不内置任何私有服务地址与密钥**，以下内容需要自行配置（`shared/endpoints.js`）：

```js
module.exports = {
  API_BASE: '',        // 官方 API 根地址（留空则关闭在线更新）
  UPDATE_API: '',      // 客户端更新接口（留空则「检查更新」提示未配置）
  FEEDBACK_FORM_URL: 'https://github.com/yingming12345/lumeshare/issues',
  // 局域网分享协议
  SHARE_SERVICE_PORT: 16888,
  SHARE_DISCOVERY_PORT: 17890,
  SHARE_DISCOVERY_MAGIC: 'LUMESHARE-V1',
};
```

其它可通过环境变量覆盖的配置：

| 环境变量 | 作用 | 默认值 |
| --- | --- | --- |
| `LUMESHARE_UPDATE_TOKEN` | 更新接口鉴权 Token | 空 |
| `LUMESHARE_BGM_URL` | 背景音乐直链（留空则关闭该功能） | 空 |
| `LUMESHARE_LOG_SEED` / `LUMESHARE_LOG_SALT` | 日志加密种子 | 示例值 |

> 仓库中不含任何真实 Token、AppKey 或私有接口地址，克隆后即可直接构建运行。

## 安全与隐私

- 文件与画面只在局域网内传输，**不上传任何服务器**
- 分享服务仅在本机监听，地址与提取码由使用者自行分发
- 运行日志仅保存在本机 `userData/logs`，导出的 `.lslog` 为加密文件
- 端口使用（均为局域网可达）：`16888/TCP` 分享服务、`17890/UDP` 设备发现、`16900/TCP` 直播网页与流畅画质、`16901/TCP` 直播高清画质
- 如系统弹出防火墙提示，请仅对「专用网络」放行

## 常见问题

**Q：手机打不开分享页面？**
A：确认手机与电脑在同一 Wi-Fi（同一网段），并在 Windows 防火墙中允许 LumeShare 访问专用网络。

**Q：端口被占用怎么办？**
A：分享服务在 `16888` 被占用时会自动回退到可用端口，实际地址以界面显示为准；直播服务会依次尝试 `16900/16901` 之后的端口。

**Q：检查更新提示“未配置更新服务”？**
A：开源版未内置更新接口，属预期行为；如需该功能请自行部署服务并在 `shared/endpoints.js` 中配置。

**Q：自行构建的版本与网盘安装包有何区别？**
A：网盘安装包包含作者配置的在线更新与服务接口；自行构建版本只包含本仓库源码，不连接任何第三方服务，核心的分享、文件库、直播功能完全一致。

## 参与贡献

欢迎提交 Issue 与 Pull Request。提交前请确认：

1. `npm run web` 能正常构建；
2. 不引入任何真实密钥、私有域名或用户数据；
3. 代码风格与现有文件保持一致，新增功能请补充必要说明。

## 许可证

[MIT](LICENSE)
