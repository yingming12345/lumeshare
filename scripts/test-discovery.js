// 设备发现功能测试：两个 ShareService 实例应能通过 UDP 广播互相发现
const os = require('os');
const fs = require('fs');
const path = require('path');
const { ShareService } = require('../main/share.js');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumeshare-disc-'));
  const a = new ShareService({ storageDir: path.join(tmp, 'a'), iconPath: '', appName: 'LumeShare-A' });
  const b = new ShareService({ storageDir: path.join(tmp, 'b'), iconPath: '', appName: 'LumeShare-B' });
  let aFoundB = false;
  let bFoundA = false;
  a.onServersChange = (list) => {
    if (list.some((s) => s.name === 'LumeShare-B')) aFoundB = true;
  };
  b.onServersChange = (list) => {
    if (list.some((s) => s.name === 'LumeShare-A')) bFoundA = true;
  };
  await a.start();
  await b.start();
  await new Promise((r) => setTimeout(r, 7000));
  console.log('A 发现 B:', aFoundB);
  console.log('B 发现 A:', bFoundA);
  console.log('A 端口:', a.port, 'B 端口:', b.port);
  a.stop();
  b.stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(aFoundB && bFoundA ? 0 : 1);
})().catch((e) => {
  console.error('测试失败:', e);
  process.exit(1);
});
