// E2E：生成模拟日志并导出为三级加密 .lslog 文件（含 4 条故障记录，供管理员客户端验证）
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const logcrypto = require('../shared/logcrypto');

// 演示日期与时间（模拟一天内的操作）
const D = '2026-08-19T';
function t(hh, mm, ss) {
  return D + hh + ':' + mm + ':' + ss + '.000Z';
}

const entries = [
  { ts: t('08', '01', '15'), level: 'info', action: 'app:start', detail: { version: '0.4.1', system: '10.0.26200', platform: 'win32' } },
  { ts: t('08', '01', '22'), level: 'info', action: 'scan:start', detail: { drive: 'C:\\' } },
  { ts: t('08', '02', '48'), level: 'info', action: 'scan:done', detail: { drive: 'C:\\', total: 198231, counts: { images: 31713, pdfs: 12, words: 6, apps: 740, others: 165759 } } },
  { ts: t('09', '15', '33'), level: 'info', action: 'view:open', detail: { name: 'photo-1234.png', kind: 'image' } },
  { ts: t('09', '16', '05'), level: 'info', action: 'file:copy', detail: { name: 'photo-1234.png', dest: 'D:\\备份\\photo-1234.png' } },
  { ts: t('10', '02', '11'), level: 'warn', action: 'thumb:fail', detail: { file: 'C:\\Users\\test\\Pictures\\photo-9999.heic', error: '系统无法为 HEIC 格式生成缩略图' } },
  { ts: t('10', '05', '47'), level: 'error', action: 'scan:error', detail: { drive: 'E:\\', error: '无法访问该盘符（磁盘未就绪）' } },
  { ts: t('11', '30', '02'), level: 'info', action: 'share:start', detail: { port: 54321 } },
  { ts: t('11', '31', '25'), level: 'info', action: 'share:upload', detail: { name: '会议纪要.docx', size: 2457600, code: '837291' } },
  { ts: t('13', '20', '44'), level: 'info', action: 'share:fetch', detail: { code: '837291', name: '会议纪要.docx', size: 2457600 } },
  { ts: t('13', '21', '10'), level: 'info', action: 'share:download', detail: { code: '837291', dest: 'D:\\下载\\会议纪要.docx' } },
  { ts: t('14', '02', '37'), level: 'error', action: 'pdf:open', detail: { name: '合同扫描件.pdf', error: 'PDF 文件已损坏，无法渲染（第 3 页）' } },
  { ts: t('15', '48', '19'), level: 'warn', action: 'share:fetch:miss', detail: { code: '225588', error: '提取码不存在或已过期' } },
  { ts: t('16', '33', '05'), level: 'error', action: 'file:copy:error', detail: { name: '项目资料.zip', error: '目标磁盘空间不足，复制失败' } },
  { ts: t('17', '02', '50'), level: 'error', action: 'settings:error', detail: { key: 'launchAtStartup', error: '写入开机自启注册表失败' } },
  { ts: t('18', '00', '00'), level: 'info', action: 'app:quit', detail: {} },
];

app.whenReady().then(() => {
  const text = entries.map((e) => JSON.stringify(e)).join('\n');
  const encrypted = logcrypto.encryptExport(text);
  const out = path.join(__dirname, '..', 'dist', 'E2E-演示日志.lslog');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encrypted);
  const errors = entries.filter((e) => e.level === 'error').length;
  const warns = entries.filter((e) => e.level === 'warn').length;
  console.log('[e2e] 已生成演示日志: ' + out + ' (' + entries.length + ' 条记录，其中故障 ' + errors + ' 条、警告 ' + warns + ' 条，' + encrypted.length + ' 字节)');
  app.exit(0);
});
