'use strict';
// electron-builder afterPack 钩子：用 rcedit 为 exe 写入图标与版本信息
// （沙箱环境无法解压 winCodeSign 的符号链接，故关闭内置 signAndEditExecutable，由本脚本完成）
const path = require('path');
const { execFile } = require('child_process');

exports.default = async function (context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'win32') return;

  const exe = path.join(appOutDir, 'LumeShare.exe');
  const rcedit = path.join(__dirname, 'rcedit-x64.exe');
  const icon = path.join(context.packager.info.appDir, 'build', 'icon.ico');

  const args = [
    exe,
    '--set-icon', icon,
    '--set-version-string', 'ProductName', 'LumeShare',
    '--set-version-string', 'FileDescription', 'LumeShare - 局域网分享与本地文件整理工具',
    '--set-version-string', 'CompanyName', 'LumeShare',
    '--set-version-string', 'LegalCopyright', 'Copyright © 2025 LumeShare',
    '--set-version-string', 'OriginalFilename', 'LumeShare.exe',
    '--set-file-version', '2.0.4',
    '--set-product-version', '2.0.4',
  ];

  await new Promise((resolve, reject) => {
    execFile(rcedit, args, (err) => (err ? reject(err) : resolve()));
  });
  console.log('[afterPack] rcedit OK:', exe);
};
