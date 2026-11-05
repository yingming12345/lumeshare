// 渲染层打包脚本：将 renderer/app.js 及其依赖（pdfjs、docx-preview）打包为浏览器可直接加载的脚本
// 目标运行环境：Windows 10+（Electron 22 / Chromium 108）
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'renderer', 'dist');
const pdfjsDir = path.join(root, 'node_modules', 'pdfjs-dist', 'build');

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  // 1) 应用主包
  await esbuild.build({
    entryPoints: [path.join(root, 'renderer', 'app.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome108',
    outfile: path.join(outDir, 'app.bundle.js'),
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  // 2) PDF worker：打包为独立 IIFE，再以文本形式内联进页面
  const workerIife = path.join(outDir, 'pdf.worker.iife.js');
  await esbuild.build({
    entryPoints: [path.join(pdfjsDir, 'pdf.worker.min.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome108',
    outfile: workerIife,
    minify: true,
    legalComments: 'none',
  });
  const workerText = fs.readFileSync(workerIife, 'utf8');
  fs.writeFileSync(
    path.join(outDir, 'pdf.worker.src.js'),
    'window.__PDF_WORKER_SRC__=' + JSON.stringify(workerText) + ';'
  );
  fs.unlinkSync(workerIife);

  // 3) 直播播放器：渲染层通过 import 使用 shared/live-player.js，浏览器页面通过 /player.js 加载同一份实现
  console.log('[web] 构建完成: renderer/dist/app.bundle.js + pdf.worker.src.js');
}

main().catch((e) => {
  console.error('[web] 构建失败:', e);
  process.exit(1);
});
