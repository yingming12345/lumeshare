// LumeShare 图标生成脚本（由 Electron 运行，使用 nativeImage 缩放后生成多尺寸 ICO）
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const pngToIco = require('png-to-ico');

const ICON_URL =
  'https://backend.appmiaoda.com/projects/supabase316942472787832832/storage/v1/object/public/netdisk-files/uploads/1787137426759_1786950172377_d-rounded.png';

function download(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          download(new URL(res.headers.location, url).toString()).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
  });
}

function makeFallbackPng() {
  // 蓝色圆角底 + 白色 L 形（用像素绘制，足够作为兜底图标）
  const size = 256;
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const radius = 52;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(Math.abs(x - cx) - (cx - radius), 0);
      const dy = Math.max(Math.abs(y - cx) - (cx - radius), 0);
      const inside = Math.sqrt(dx * dx + dy * dy) <= radius;
      const i = (y * size + x) * 4;
      if (inside) {
        // 白色 “L” 字形
        const inL = (x > cx - 34 && x < cx + 34 && y > cx - 40 && y < cx - 6) ||
          (x > cx - 34 && x < cx - 4 && y > cx - 40 && y < cx + 40);
        if (inL) {
          buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = 255;
        } else {
          buf[i] = 37; buf[i + 1] = 99; buf[i + 2] = 235; buf[i + 3] = 255;
        }
      } else {
        buf[i + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 1 }).toPNG();
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const buildDir = path.join(root, 'build');
  fs.mkdirSync(buildDir, { recursive: true });

  let png;
  try {
    console.log('[icons] 下载图标...');
    png = await download(ICON_URL);
    const probe = nativeImage.createFromBuffer(png);
    if (probe.isEmpty()) throw new Error('下载的图片无法解析');
    console.log('[icons] 下载成功 (' + png.length + ' 字节)');
  } catch (e) {
    console.warn('[icons] 下载失败，使用内置兜底图标: ' + e.message);
    png = makeFallbackPng();
  }

  fs.writeFileSync(path.join(buildDir, 'icon.png'), png);
  fs.writeFileSync(path.join(root, 'renderer', 'icon.png'), png);

  const src = nativeImage.createFromBuffer(png);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const bufs = [];
  for (const s of sizes) {
    bufs.push(src.resize({ width: s, height: s, quality: 'best' }).toPNG());
  }
  const ico = await pngToIco(bufs);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
  console.log('[icons] 已生成 build/icon.png 与 build/icon.ico (' + ico.length + ' 字节)');
}

app
  .whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((e) => {
    console.error('[icons] 失败:', e);
    app.exit(1);
  });
