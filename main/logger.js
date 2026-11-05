// 客户端日志记录：按天记录用户操作与故障（JSONL 明文内部存储，导出时三级加密）
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function logsDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function todayFile() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return path.join(logsDir(), 'lume-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.log');
}

function ensureDir() {
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
  } catch {
    /* ignore */
  }
}

// 记录一条日志
// level: info | warn | error
function log(action, detail, level) {
  try {
    ensureDir();
    const entry = {
      ts: new Date().toISOString(),
      level: level || 'info',
      action: action || 'unknown',
      detail: detail || null,
    };
    fs.appendFileSync(todayFile(), JSON.stringify(entry) + '\n', 'utf8');
    // 保留最近 30 天的日志
    cleanup();
  } catch {
    /* 日志写入失败不影响主功能 */
  }
}

function cleanup() {
  try {
    const files = fs.readdirSync(logsDir()).filter((f) => f.startsWith('lume-') && f.endsWith('.log'));
    if (files.length <= 30) return;
    files
      .map((f) => ({ f, t: fs.statSync(path.join(logsDir(), f)).mtimeMs }))
      .sort((a, b) => a.t - b.t)
      .slice(0, files.length - 30)
      .forEach((x) => {
        try {
          fs.unlinkSync(path.join(logsDir(), x.f));
        } catch {
          /* ignore */
        }
      });
  } catch {
    /* ignore */
  }
}

// 读取今天的日志（原始 JSONL 行数组）
function readToday() {
  return readFileLines(todayFile());
}

// 读取全部日志（从安装起，按日期文件顺序）
function readAll() {
  const out = [];
  let files;
  try {
    files = fs.readdirSync(logsDir()).filter((f) => f.startsWith('lume-') && f.endsWith('.log'));
  } catch {
    return out;
  }
  files.sort(); // 文件名按日期排序（lume-YYYY-MM-DD.log）
  for (const f of files) {
    const lines = readFileLines(path.join(logsDir(), f));
    for (const l of lines) out.push(l);
  }
  return out;
}

function readFileLines(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// 操作日志摘要（从安装起全部记录，供设置页展示）
function summary() {
  const entries = readAll();
  const counts = { info: 0, warn: 0, error: 0 };
  for (const e of entries) counts[e.level] = (counts[e.level] || 0) + 1;
  // 首条日志日期 = 安装日期（近似）
  let firstDate = '';
  if (entries.length) {
    const t = entries[0].ts;
    if (t) firstDate = String(t).slice(0, 10);
  }
  return { count: entries.length, counts, firstDate };
}

// 便捷记录函数
const info = (action, detail) => log(action, detail, 'info');
const warn = (action, detail) => log(action, detail, 'warn');
const error = (action, detail) => log(action, detail, 'error');

module.exports = { log, info, warn, error, readToday, readAll, summary, todaySummary: summary };
