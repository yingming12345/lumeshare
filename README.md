# LumeShare

> 局域网文件分享与屏幕直播工具（Windows · Electron）
>
> LAN file sharing & screen live streaming for Windows, built with Electron.

LumeShare 是一个纯本地运行的桌面工具：在同一局域网内用 6 位提取码快速传文件、实时共享屏幕，
不经过任何中转服务器。所有传输都发生在你自己的网络里。

## 功能特性

### 局域网分享

- 拖拽 / 粘贴文件即可上传，自动生成 **6 位提取码** 与二维码
- 任何设备打开 `http://<局域网IP>:16888/` 输入提取码即可下载
- 内置 UDP 设备发现（`17890`），方便其它客户端自动发现同一网段的电脑
- 支持「获取文件」：从局域网内其它开启了 LumeShare 的电脑上取文件
- 大文件流式传输、断点无阻塞、全程本地运行

### 文件库

- 扫描本机磁盘，按 **图片 / 视频 / PDF / 文档 / 应用 / 其它** 分类浏览
- 全局搜索、缩略图预览、分页加载
- 一键把文件分享到局域网（生成提取码）或复制路径 / 打开所在文件夹

### 屏幕直播

- 把屏幕实时直播给局域网内的电脑或手机，独立页面操作
- 两个固定端口：`16900`（网页直播服务 + 流畅画质）、`16901`（高清画质）
- 观看端使用浏览器**原生 `<video>`** 播放（WebM / MediaRecorder 编码 + MSE），全屏 1080P
- 房间码（10 位数字）+ 直播地址（38 位随机令牌）+ 二维码三种入口
- 支持清晰度切换、全屏、观看人数统计

### 设置

- 缩略图缓存位置与上限、启动行为、关闭到托盘、背景音乐（默认关闭）
- 操作日志：本地记录，可「下载日志」保存为加密的 `.lslog` 文件
- 检查更新：开源版默认关闭（见下方「配置说明」）

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
```

## 开发与构建

环境要求：Windows 10 及以上、Node.js 18+、npm。

```bash
npm install          # 安装依赖
npm run web          # 打包渲染层（renderer/dist/app.bundle.js）
npm start            # 构建并启动开发版
npm run dist         # 生成 Windows 安装包（dist/LumeShare-Setup-<version>.exe）
```

> 提示：本项目使用 Electron 22，是最后支持 Windows 7/8 的大版本；
> 但安装器与应用启动时会校验系统版本，**仅允许 Windows 10 及以上**运行。

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

| 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `LUMESHARE_UPDATE_TOKEN` | 更新接口鉴权 Token | 空 |
| `LUMESHARE_BGM_URL` | 背景音乐直链（留空则关闭该功能） | 空 |
| `LUMESHARE_LOG_SEED` / `LUMESHARE_LOG_SALT` | 日志加密种子 | 示例值 |

> 仓库中不含任何真实 Token / AppKey / 私有接口地址，克隆后即可直接构建运行。

## 安全与隐私

- 所有文件与画面只在局域网内传输，**不上传任何服务器**
- 分享服务仅在本机监听，地址与提取码由用户自己分发
- 日志仅保存在本机 `userData/logs`，导出的 `.lslog` 为加密文件
- 安装器与应用启动时校验系统版本，拒绝在 Windows 10 以下运行

## 参与贡献

欢迎提交 Issue 与 Pull Request。提交前请确保：

1. `npm run web` 能正常构建；
2. 不引入任何真实密钥、私有域名或用户数据；
3. 代码风格与现有文件保持一致。

## 许可证

[MIT](LICENSE)
