'use strict';
// 敏感信息保护：API Token 等敏感字符串以混淆形式保存，安装包与源码中不出现明文
// 说明：这是防止明文泄露的编码手段（异或 + Base64），不是密码学意义上的加密
const KEY = [0x4c, 0x53, 0x2d, 0x32, 0x30, 0x32, 0x36, 0x21, 0x7a, 0x51, 0x33, 0x6d, 0x41, 0x72, 0x39, 0x78];

function xorBytes(input) {
  const out = Buffer.allocUnsafe(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = input[i] ^ KEY[i % KEY.length];
  }
  return out;
}

// 明文 -> 混淆串
function mask(plain) {
  if (plain == null) return '';
  return xorBytes(Buffer.from(String(plain), 'utf8')).toString('base64');
}

// 混淆串 -> 明文
function unmask(encoded) {
  if (!encoded) return '';
  try {
    return xorBytes(Buffer.from(String(encoded), 'base64')).toString('utf8');
  } catch {
    return '';
  }
}

module.exports = { mask, unmask };
