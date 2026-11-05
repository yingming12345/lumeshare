// 公共接口与协议参数：桌面端唯一来源
// 说明：更新接口地址与访问令牌**不放在本文件**，统一由 shared/vault.js 加密保管，
//      这里只保留公开地址（官网 / 反馈表单）与局域网协议参数。
module.exports = {
  // 接口协议版本（客户端与服务端协作时用于兼容性判断）
  API_VERSION: 1,

  // 官网（公开地址，用于外部链接白名单）
  OFFICIAL_SITE: 'https://ls.fur-myu.cn/',

  // 意见反馈表单（客户端通过系统浏览器打开）
  FEEDBACK_FORM_URL: 'https://myyxwlkj.feishu.cn/share/base/form/shrcnrl3Kl2wxci3pB2Sk7Vc3ab',

  // 局域网分享协议（安卓端将作为「获取文件」的客户端接入）
  SHARE_API_VERSION: 1,
  SHARE_SERVICE_PORT: 16888, // 首选端口（被占用时自动回退随机端口）
  SHARE_DISCOVERY_PORT: 17890, // UDP 设备发现端口
  SHARE_DISCOVERY_MAGIC: 'LUMESHARE-V1',
};
