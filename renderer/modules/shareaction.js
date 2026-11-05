// 分享本地文件（列表 / 图片查看器共用）
// 前置条件：必须已在「局域网分享」中开启分享服务；未开启时由主进程返回错误，这里用顶部提示条提示。
import { toast } from './toast.js';
import { copyText } from './util.js';

export async function shareLocalPath(filePath, name) {
  if (!filePath) {
    toast('无法分享该文件', 'error');
    return { ok: false };
  }
  let r = null;
  try {
    r = await window.lume.share.shareFile(filePath);
  } catch (e) {
    r = { ok: false, error: '分享失败，请稍后重试' };
  }
  if (!r || !r.ok) {
    toast((r && r.error) || '分享失败，请稍后重试', 'error');
    return { ok: false, error: r && r.error };
  }
  const link = r.webUrl || r.url || '';
  let copied = false;
  if (link) {
    try {
      copied = await copyText(link);
    } catch {
      copied = false;
    }
  }
  toast('分享链接' + (copied ? '已复制到剪贴板' : '已生成') + '，提取码 ' + r.code, 'success');
  return Object.assign({ ok: true, copied }, r);
}
