# LumeShare 局域网分享协议（桌面端 ↔ 安卓端通用）

本协议由桌面端 `main/share.js` 实现，供网页端（`share-web`）与未来的安卓 App 复用。
协议版本：`SHARE_API_VERSION = 1`（见 `shared/endpoints.js`）。

## 1. 设备发现（UDP）

- 端口：`17890`（`SHARE_DISCOVERY_PORT`），广播地址 `255.255.255.255`。
- 报文内容（UTF-8 文本）：`LUMESHARE-V1|<设备名>|<HTTP端口>`
- 发送频率：每 3 秒一次；接收方 12 秒未收到则视为设备离线。
- 用途：手机 App 扫描同网段设备，自动列出「可获取文件的电脑」。

## 2. 服务状态

`GET /api/status`

```json
{ "name": "LumeShare", "codeCount": 3, "version": 1, "api": 1, "platform": "windows", "port": 16888 }
```

- `api` / `version`：协议版本，客户端不匹配时可提示升级。
- `platform`：服务端平台（桌面端固定 `windows`）。

## 3. 上传文件（分享方）

`POST /api/upload`

- 请求头：`x-file-name: <URL 编码后的文件名>`（兼容 `x-filename`）
- 请求体：文件原始二进制流（不限大小，服务端有安全上限保护）
- 响应：

```json
{ "code": "123456", "name": "photo.jpg", "size": 204800, "sizeText": "200.0 KB",
  "url": "http://192.168.1.5:16888/?code=123456", "webUrl": "http://192.168.1.5:16888/?code=123456" }
```

## 4. 查询提取码

`GET /api/info/<code>` → `200`：

```json
{ "code": "123456", "name": "photo.jpg", "size": 204800, "sizeText": "200.0 KB",
  "uploadAt": 1710000000000, "mime": "image/jpeg", "url": "...", "webUrl": "..." }
```

提取码不存在或已过期 → `404 { "error": "提取码不存在或已过期" }`。

## 5. 下载文件

`GET /api/file/<code>`（内联预览）或 `GET /api/file/<code>?download=1`（附件下载）

- 支持 `Range` 断点续传（`Accept-Ranges: bytes`）；响应 `Content-Disposition` 中文件名做 ASCII 转义。

## 6. 删除文件

`DELETE /api/file/<code>` → `{ "ok": true }`（文件与元数据一并删除）。

## 7. 有效期与容量

- 提取码与文件默认保留 24 小时，服务端每小时清理一次过期内容。
- 分享文件默认保存在「软件安装目录的 share 文件夹」，可在设置中更改或一键清空。

## 8. 安卓端接入建议

1. 通过 UDP 发现设备（或直接输入 `IP:端口`）。
2. `GET /api/status` 校验协议版本。
3. `GET /api/info/<code>` 展示文件信息 → `GET /api/file/<code>` 下载（支持断点续传）。
4. 全部请求使用明文 HTTP（局域网内），不要携带任何密钥；服务端已限制仅暴露上述接口与静态资源。
