// 日志三级加密 / 解密模块（客户端导出与管理员解析共用）
// 说明：三级加密防止日志被普通软件直接读取；解密需要本模块内置的密钥种子。
//   第一级：字节混淆（密钥流异或 + 固定置换）
//   第二级：AES-256-CBC 标准加密
//   第三级：自定义封装格式（魔数头 + 块交错展平 + 校验），文件扩展名使用不常见格式 .lslog
const crypto = require('crypto');
const zlib = require('zlib');

const MAGIC = Buffer.from('LMLG', 'ascii'); // 文件魔数
const FORMAT_VERSION = 1;
const EXT = '.lslog';

// 示例密钥（开源版占位值，请自行替换为你自己的密钥种子）
const SEED = process.env.LUMESHARE_LOG_SEED || 'lumeshare-open-source-seed';
const SALT = process.env.LUMESHARE_LOG_SALT || 'lumeshare-open-source-salt';

// 字节置换表（长度 256，伪随机但固定）
const PERM = (() => {
  const t = new Uint8Array(256);
  let x = 123;
  for (let i = 0; i < 256; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    t[i] = x % 256;
  }
  return t;
})();

function deriveKey() {
  return crypto.createHash('sha256').update(SEED + SALT).digest();
}

// ---------- 第一级：字节混淆 ----------
function confuse(data) {
  const out = Buffer.alloc(data.length);
  const key = deriveKey();
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] ^ key[i % key.length] ^ PERM[i & 0xff];
  }
  // 固定置换：前一半与后一半按步长交换（长度足够时才做）
  if (data.length >= 64) {
    const half = Math.floor(out.length / 2);
    const step = 7;
    const n = Math.min(half, 4096);
    for (let i = 0; i < n; i += step) {
      const a = i;
      const b = out.length - 1 - i;
      const tmp = out[a];
      out[a] = out[b];
      out[b] = tmp;
    }
  }
  return out;
}

function deconfuse(data) {
  const out = Buffer.from(data);
  if (out.length >= 64) {
    const half = Math.floor(out.length / 2);
    const step = 7;
    const n = Math.min(half, 4096);
    for (let i = 0; i < n; i += step) {
      const a = i;
      const b = out.length - 1 - i;
      const tmp = out[a];
      out[a] = out[b];
      out[b] = tmp;
    }
  }
  const key = deriveKey();
  for (let i = 0; i < out.length; i++) {
    out[i] = out[i] ^ key[i % key.length] ^ PERM[i & 0xff];
  }
  return out;
}

// ---------- 第三级：块交错展平 ----------
const BLOCKS = 7; // 交错块数（质数，保证重新组合后顺序唯一）

function interleave(data) {
  // 把数据切成 BLOCKS 块，按固定顺序重排
  const size = data.length;
  const chunk = Math.ceil(size / BLOCKS);
  const parts = [];
  for (let b = 0; b < BLOCKS; b++) {
    parts.push(data.slice(b * chunk, Math.min((b + 1) * chunk, size)));
  }
  // 重排顺序：偶数块在前、奇数块在后
  const order = [];
  for (let b = 0; b < BLOCKS; b += 2) order.push(b);
  for (let b = 1; b < BLOCKS; b += 2) order.push(b);
  return Buffer.concat(order.map((i) => parts[i]));
}

function deinterleave(data) {
  // 需要知道原始每块大小：总长度按 BLOCKS 均分后取整分配（与 interleave 一致）
  const size = data.length;
  const chunk = Math.ceil(size / BLOCKS);
  const sizes = [];
  let remaining = size;
  for (let b = 0; b < BLOCKS; b++) {
    const s = Math.min(chunk, remaining);
    sizes.push(s);
    remaining -= s;
  }
  // 还原顺序（逆运算）
  const order = [];
  for (let b = 0; b < BLOCKS; b += 2) order.push(b);
  for (let b = 1; b < BLOCKS; b += 2) order.push(b);
  const parts = new Array(BLOCKS);
  let off = 0;
  for (let i = 0; i < BLOCKS; i++) {
    const orig = order[i];
    parts[orig] = data.slice(off, off + sizes[orig]);
    off += sizes[orig];
  }
  return Buffer.concat(parts);
}

// ---------- 导出（加密 + 压缩） ----------
// 明文先 deflate 压缩再走三级加密，显著缩小 .lslog 体积；解析时自动解压（旧格式无压缩仍可读）
// 返回加密后的 Buffer
function encryptExport(plainText) {
  // 先压缩（JSON 文本重复度高，deflate 效果明显）
  const compressed = zlib.deflateRawSync(Buffer.from(String(plainText), 'utf8'), { level: 9 });
  // 第一级
  const confused = confuse(compressed);
  // 第二级：AES-256-CBC
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(confused), cipher.final()]);
  // 第三级：封装 + 块交错
  const payload = interleave(enc);
  const body = Buffer.concat([iv, payload]);
  // 魔数头 + 版本 + 长度（混淆存储）+ body + 校验
  const header = Buffer.alloc(4 + 1 + 4);
  MAGIC.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, 4);
  // 长度做简单混淆（异或固定值）防止直接读取
  header.writeUInt32LE((body.length ^ 0xa5a55a5a) >>> 0, 5);
  const crc = crypto.createHash('sha256').update(body).digest().slice(0, 4);
  return Buffer.concat([header, body, crc]);
}

// ---------- 解析（解密） ----------
// 返回 { ok: true, text } 或 { ok: false, error }
function decryptExport(data) {
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 4 + 1 + 4 + 16 + 4) return { ok: false, error: '文件过小，不是有效的日志文件' };
    const magic = buf.slice(0, 4);
    if (!magic.equals(MAGIC)) return { ok: false, error: '文件格式不正确（缺少 LumeShare 日志标识）' };
    const version = buf.readUInt8(4);
    if (version !== FORMAT_VERSION) return { ok: false, error: '不支持的日志版本（' + version + '）' };
    const bodyLen = buf.readUInt32LE(5) ^ 0xa5a55a5a;
    const crc = buf.slice(buf.length - 4);
    const body = buf.slice(9, 9 + bodyLen);
    if (body.length !== bodyLen) return { ok: false, error: '文件内容不完整或已损坏' };
    const calc = crypto.createHash('sha256').update(body).digest().slice(0, 4);
    if (!calc.equals(crc)) return { ok: false, error: '文件校验失败，可能已被修改或损坏' };
    const iv = body.slice(0, 16);
    const payload = body.slice(16);
    // 第三级逆：块还原
    const enc = deinterleave(payload);
    // 第二级逆：AES 解密
    const decipher = crypto.createDecipheriv('aes-256-cbc', deriveKey(), iv);
    const confused = Buffer.concat([decipher.update(enc), decipher.final()]);
    // 第一级逆：去混淆
    const raw = deconfuse(confused);
    // 新版格式：明文先 deflate 压缩过；旧格式：明文原样 UTF-8。
    // 通过「能否被 inflateRaw 解压出合法 UTF-8 JSON」判别（JSON 以 { 或 [ 开头）。
    const text = tryInflateText(raw);
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: '解密失败：' + e.message };
  }
}

// 尝试把原始字节按 deflate 解压为文本；失败则视为未压缩明文（旧格式兼容）
function tryInflateText(raw) {
  // 旧格式明文：必为合法 UTF-8，且（日志文件）首字符为 {（JSON 行）
  const asUtf8 = raw.toString('utf8').trimStart();
  if (asUtf8.startsWith('{') || asUtf8.startsWith('[')) {
    return raw.toString('utf8');
  }
  // 新版格式：deflate 流通常不是可打印 UTF-8，尝试解压
  try {
    return zlib.inflateRawSync(raw).toString('utf8');
  } catch {
    return raw.toString('utf8');
  }
}

module.exports = { encryptExport, decryptExport, EXT, MAGIC: MAGIC.toString('ascii') };
