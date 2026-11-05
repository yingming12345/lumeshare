// 自测模式：验证核心功能是否可用，输出 PASS/FAIL 并以退出码返回结果
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const zlib = require('zlib');
const { ShareService, migrateStorageDir, cleanupMigrated, clearStorageDir, PREFERRED_PORT } = require('./share');
const { scanRoot, summarize } = require('./scan');
const { get: getThumb } = require('./thumb');
const settings = require('./settings');
const logger = require('./logger');
const logcrypto = require('../shared/logcrypto');
const music = require('./music');

// ---------- 最小可用 PDF ----------
function makePdf(text) {
  const esc = text.replace(/[\\()]/g, '\\$&');
  const stream = 'BT /F1 24 Tf 72 720 Td (' + esc + ') Tj ET';
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>');
  objs.push('<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(out));
    out += (i + 1) + ' 0 obj ' + objs[i] + '\nendobj\n';
  }
  const xrefStart = Buffer.byteLength(out);
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  for (const off of offsets) {
    out += String(off).padStart(10, '0') + ' 00000 n \n';
  }
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

// ---------- 最小 zip（用于构造 docx） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime() {
  return { time: 0, date: 0x21 }; // 固定值即可
}

function makeZip(files) {
  // files: [{ name, data(Buffer) }]
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const comp = zlib.deflateRawSync(f.data);
    const { time, date } = dosDateTime();
    const crc = crc32(f.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0x0800, 6); // flags utf8
    local.writeUInt16LE(8, 8); // method deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, end]);
}

function makeDocx(title) {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>${title}</w:t></w:r></w:p>
<w:p><w:r><w:t>LumeShare 文档预览自测</w:t></w:r></w:p>
</w:body>
</w:document>`;
  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ]);
}

function makePng() {
  const size = 96;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      buf[i] = x < size / 2 ? 220 : 37;
      buf[i + 1] = 40;
      buf[i + 2] = 235;
      buf[i + 3] = 255;
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 1 });
  return img.toPNG();
}

function httpJson(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: headers || {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// 检测端口是否空闲（用于验证固定首选端口的逻辑）
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function runSelftest({ copyFileTo }) {
  const results = [];
  const ok = (name, pass, detail) => {
    results.push({ name, pass: !!pass, detail: detail || '' });
    console.log((pass ? '  PASS ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumeshare-selftest-'));
  const samples = path.join(tmp, 'samples');
  fs.mkdirSync(samples, { recursive: true });

  // 准备样本文件
  const pngPath = path.join(samples, 'sample.png');
  fs.writeFileSync(pngPath, makePng());
  const pdfPath = path.join(samples, 'sample.pdf');
  fs.writeFileSync(pdfPath, makePdf('LumeShare PDF Test'));
  const docxPath = path.join(samples, 'sample.docx');
  fs.writeFileSync(docxPath, makeDocx('LumeShare Word 测试文档'));
  const exePath = path.join(samples, 'sample.exe');
  fs.writeFileSync(exePath, Buffer.from('MZ' + 'x'.repeat(100)));
  const txtPath = path.join(samples, 'sample.txt');
  fs.writeFileSync(txtPath, Buffer.from('hello'));

  try {
    // 1) 扫描分类
    console.log('\n[selftest] 扫描与分类');
    const scanRes = await scanRoot(tmp, {});
    const sum = summarize(scanRes);
    ok('扫描: 图片分类', sum.counts.images === 1, 'images=' + sum.counts.images);
    ok('扫描: PDF 分类', sum.counts.pdfs === 1, 'pdfs=' + sum.counts.pdfs);
    ok('扫描: Word 分类', sum.counts.words === 1, 'words=' + sum.counts.words);
    ok('扫描: 应用分类', sum.counts.apps === 1, 'apps=' + sum.counts.apps);
    ok('扫描: 其他分类', sum.counts.others === 1, 'others=' + sum.counts.others);

    // 2) 缩略图
    console.log('\n[selftest] 缩略图');
    settings.set({ thumbCacheDir: path.join(tmp, 'thumb-cache') });
    const thumb = await getThumb(pngPath);
    ok('缩略图生成', !!thumb && thumb.startsWith('data:image/png'), thumb ? thumb.length + ' chars' : 'null');
    const thumb2 = await getThumb(pngPath);
    ok('缩略图缓存命中', thumb2 === thumb, '二次读取一致');

    // 默认缓存目录优先使用非系统盘
    settings.set({ thumbCacheDir: null });
    const defDir = settings.getResolved().thumbCacheDir;
    let hasOtherDrive = false;
    if (process.platform === 'win32') {
      const sysLetter = (process.env.SystemDrive || 'C:').replace(/[\\/:]/g, '').toUpperCase();
      for (let c = 65; c <= 90; c++) {
        const letter = String.fromCharCode(c);
        if (letter === sysLetter) continue;
        try {
          fs.accessSync(letter + ':\\', fs.constants.R_OK | fs.constants.W_OK);
          hasOtherDrive = true;
          break;
        } catch {
          /* 跳过不可用盘符 */
        }
      }
      ok('默认缓存目录优先使用非系统盘', !hasOtherDrive || !defDir.toUpperCase().startsWith(sysLetter + '\\'), defDir);
    } else {
      ok('默认缓存目录', true, defDir);
    }

    // 3) 日志与三级加密
    console.log('\n[selftest] 日志与三级加密');
    logger.info('test:event', { hello: 'world', n: 42 });
    const entries = logger.readToday();
    ok('日志记录写入', entries.some((e) => e.action === 'test:event'), '今日共 ' + entries.length + ' 条');
    const logText = entries.map((e) => JSON.stringify(e)).join('\n');
    const encrypted = logcrypto.encryptExport(logText);
    const dec = logcrypto.decryptExport(encrypted);
    ok('三级加密往返解密', dec.ok && dec.text.includes('test:event'), dec.ok ? '解密成功' : dec.error);
    const junk = logcrypto.decryptExport(Buffer.from('这不是日志文件'));
    ok('非日志文件被拒绝', !junk.ok, junk.error);
    const tampered = Buffer.from(encrypted);
    tampered[20] ^= 0x01;
    const tam = logcrypto.decryptExport(tampered);
    ok('篡改日志被拒绝', !tam.ok, tam.error);

    // 5) 背景音乐（开启后本地循环播放，无界面）
    console.log('\n[selftest] 背景音乐');
    const musicFileSize = (() => {
      try {
        return fs.statSync(music.musicFile()).size;
      } catch {
        return 0;
      }
    })();
    if (musicFileSize >= 64 * 1024) {
      ok('本地音乐文件可用', true, Math.round(musicFileSize / 1024) + ' KB');
      const mr = await music.applySetting(true);
      ok('背景音乐开启', !!(mr && mr.ok), JSON.stringify(mr));
      // 等待隐藏播放器真正出声
      let audible = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 400));
        if (music.isAudible()) {
          audible = true;
          break;
        }
      }
      const ms = music.status();
      ok('后台真实播放（隐藏窗口出声）', audible, 'playing=' + ms.playing + ' audible=' + audible);
      music.stop();
      await new Promise((r) => setTimeout(r, 500));
      const ms2 = music.status();
      ok('关闭后停止播放', !ms2.playing && !ms2.enabled, JSON.stringify(ms2));
    } else {
      ok('本地音乐文件可用', false, '本地暂无音乐缓存（需联网首次下载），跳过播放校验');
    }

    // 6) 分享服务
    console.log('\n[selftest] 局域网分享');
    const storage = path.join(tmp, 'share');
    const service = new ShareService({ storageDir: storage, iconPath: pngPath, appName: 'LumeShare' });
    const fixedPortFree = await isPortFree(PREFERRED_PORT);
    const started = await service.start();
    ok('分享服务启动', started.port > 0, 'port=' + started.port);
    if (fixedPortFree) {
      ok('首选端口优先使用 16888', started.port === PREFERRED_PORT, 'port=' + started.port);
    }
    const base = 'http://127.0.0.1:' + started.port;

    const up = await httpJson('POST', base + '/api/upload', fs.readFileSync(pngPath), {
      'x-file-name': encodeURIComponent('sample.png'),
      'content-type': 'application/octet-stream',
    });
    const upJson = JSON.parse(up.body.toString('utf8'));
    ok('上传文件并生成提取码', up.status === 200 && /^\d{6}$/.test(upJson.code), 'code=' + upJson.code);

    const info = await httpJson('GET', base + '/api/info/' + upJson.code);
    const infoJson = JSON.parse(info.body.toString('utf8'));
    ok('提取码查询', info.status === 200 && infoJson.name === 'sample.png', infoJson.name);

    const dl = await httpJson('GET', base + '/api/file/' + upJson.code + '?download=1');
    ok('提取码下载', dl.status === 200 && dl.body.length === fs.statSync(pngPath).size, dl.body.length + ' bytes');

    fs.mkdirSync(path.join(tmp, 'dest'), { recursive: true });
    const saveRes = service.saveTo(upJson.code, path.join(tmp, 'dest'));
    ok('分享文件另存', saveRes.ok && fs.existsSync(saveRes.dest), saveRes.dest || saveRes.error);

    // 关闭服务后再开启：端口保持不变，已发出的链接可继续访问
    const portBeforeRestart = started.port;
    service.stop();
    const restarted = await service.start();
    if (portBeforeRestart === PREFERRED_PORT) {
      ok('关闭后重开端口不变（旧链接仍可用）', restarted.port === portBeforeRestart, 'port=' + restarted.port);
    } else {
      ok('关闭后重开服务可再次启动', restarted.port > 0, 'port=' + restarted.port);
    }

    // 4) 复制文件
    console.log('\n[selftest] 文件复制');
    const cp = copyFileTo(txtPath, path.join(tmp, 'dest'));
    ok('复制文件到目标目录', cp.ok && fs.existsSync(cp.dest), cp.dest || cp.error);
    const cp2 = copyFileTo(txtPath, path.join(tmp, 'dest'));
    ok('同名文件自动改名', cp2.ok && cp2.dest.includes('副本'), cp2.dest);

    service.stop();

    // 5.5) 分享存储目录迁移（换盘后提取码仍有效）
    console.log('\n[selftest] 分享存储目录迁移');
    const share2 = path.join(tmp, 'share2');
    const mig = migrateStorageDir(storage, share2);
    ok('迁移复制已分享文件', mig.ok && mig.moved.length === 1, 'moved=' + mig.moved.join(','));
    const service2 = new ShareService({ storageDir: share2, iconPath: pngPath, appName: 'LumeShare' });
    const started2 = await service2.start();
    const infoAfter = await httpJson('GET', 'http://127.0.0.1:' + started2.port + '/api/info/' + upJson.code);
    const infoAfterJson = JSON.parse(infoAfter.body.toString('utf8'));
    ok('迁移后提取码仍有效', infoAfter.status === 200 && infoAfterJson.name === 'sample.png', infoAfterJson.name || ('status=' + infoAfter.status));
    const dlAfter = await httpJson('GET', 'http://127.0.0.1:' + started2.port + '/api/file/' + upJson.code + '?download=1');
    ok('迁移后文件可下载', dlAfter.status === 200 && dlAfter.body.length === fs.statSync(pngPath).size, dlAfter.body.length + ' bytes');
    service2.stop();
    const cleaned = cleanupMigrated(storage, mig.moved);
    ok('迁移确认后清理源目录', cleaned === mig.moved.length, 'cleaned=' + cleaned);
    ok('源目录分享文件已清理', !fs.existsSync(path.join(storage, upJson.code + '.json')), storage);

    // 5.6) 一键清空分享文件（只删本应用记录，不碰无关文件）
    console.log('\n[selftest] 分享文件清空');
    fs.writeFileSync(path.join(share2, 'unrelated.txt'), 'keep me');
    const svc3 = new ShareService({ storageDir: share2, iconPath: pngPath, appName: 'LumeShare' });
    const started3 = await svc3.start();
    ok('清空前提取码可用', (await httpJson('GET', 'http://127.0.0.1:' + started3.port + '/api/info/' + upJson.code)).status === 200, 'port=' + started3.port);
    const mappedRemoved = svc3.clearRecordsIn(share2);
    const staleRemoved = clearStorageDir(share2);
    ok('一键清空分享文件', mappedRemoved.length + staleRemoved >= 1, 'mapped=' + mappedRemoved.join(',') + ' stale=' + staleRemoved);
    const infoGone = await httpJson('GET', 'http://127.0.0.1:' + started3.port + '/api/info/' + upJson.code);
    ok('清空后提取码不可用', infoGone.status === 404, 'status=' + infoGone.status);
    ok('无关文件不受影响', fs.existsSync(path.join(share2, 'unrelated.txt')), share2);
    svc3.stop();

    // 5) 渲染层自测（隐藏窗口）
    console.log('\n[selftest] 渲染层（pdfjs / docx-preview）');
    const rendererResults = await runRendererSelftest({ pdfPath, docxPath, pngPath });
    for (const r of rendererResults) {
      ok('渲染: ' + r.name, r.pass, r.detail);
    }

    const failed = results.filter((r) => !r.pass).length;
    console.log('\n[selftest] 结果: ' + (results.length - failed) + '/' + results.length + ' 通过');
    return failed === 0 ? 0 : 1;
  } catch (e) {
    console.error('[selftest] 异常:', e);
    return 1;
  } finally {
    try {
      settings.set({ thumbCacheDir: null }); // 恢复默认缓存目录，避免污染用户配置
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function runRendererSelftest({ pdfPath, docxPath, pngPath }) {
  return new Promise((resolve) => {
    const payload = encodeURIComponent(JSON.stringify({ pdf: pdfPath, docx: docxPath, png: pngPath }));
    const w = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    const timer = setTimeout(() => {
      resolve([{ name: '超时', pass: false, detail: '渲染层自测 30s 超时' }]);
      try {
        w.destroy();
      } catch {
        /* ignore */
      }
    }, 30000);

    w.webContents.on('ipc-message', (_e, channel, args) => {
      if (channel === 'selftest:report') {
        clearTimeout(timer);
        try {
          w.destroy();
        } catch {
          /* ignore */
        }
        resolve(args);
      }
    });

    w.loadURL('lume://app/index.html?selftest=1&paths=' + payload);
  });
}

module.exports = { runSelftest };
