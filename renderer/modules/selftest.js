// 渲染层自测（隐藏窗口运行）
import { fileUrl } from './util.js';
import { ensurePdfjs, ensureDocx } from './viewers.js';

export async function runRendererSelftest() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('selftest') !== '1') return;
  let paths = {};
  try {
    paths = JSON.parse(decodeURIComponent(params.get('paths') || '{}'));
  } catch {
    /* ignore */
  }
  const results = [];

  // 1) lume 协议文件读取
  try {
    const res = await fetch(fileUrl(paths.png));
    const blob = await res.blob();
    results.push({ name: 'lume 协议文件读取', pass: blob.size > 100, detail: blob.size + ' 字节' });
  } catch (e) {
    results.push({ name: 'lume 协议文件读取', pass: false, detail: String(e) });
  }

  // 2) pdfjs 渲染
  try {
    const buf = await (await fetch(fileUrl(paths.pdf))).arrayBuffer();
    const pdfjsLib = await ensurePdfjs();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonWhite = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] < 245 || px[i + 1] < 245 || px[i + 2] < 245) nonWhite++;
    }
    results.push({ name: 'pdfjs 渲染', pass: nonWhite > 500, detail: nonWhite + ' 个非白像素' });
  } catch (e) {
    results.push({ name: 'pdfjs 渲染', pass: false, detail: String(e) });
  }

  // 3) docx-preview 渲染
  try {
    const buf = await (await fetch(fileUrl(paths.docx))).arrayBuffer();
    const mod = await ensureDocx();
    const div = document.createElement('div');
    div.style.width = '800px';
    document.body.appendChild(div);
    await mod.renderAsync(new Blob([buf]), div, null, { inWrapper: false, experimental: true });
    const nodeCount = div.querySelectorAll('*').length;
    results.push({ name: 'docx-preview 渲染', pass: nodeCount > 5, detail: nodeCount + ' 个节点' });
  } catch (e) {
    results.push({ name: 'docx-preview 渲染', pass: false, detail: String(e) });
  }

  // 4) 缩略图 URL 生成（本地 lume 图片可直接作为 img src）
  try {
    const img = new Image();
    img.src = fileUrl(paths.png);
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
    results.push({ name: 'lume 图片直读', pass: img.naturalWidth > 0, detail: img.naturalWidth + 'x' + img.naturalHeight });
  } catch (e) {
    results.push({ name: 'lume 图片直读', pass: false, detail: String(e) });
  }

  window.lume.selftest.report(results);
}
