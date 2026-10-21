// 图片处理：把 QQ 消息里的图片下载下来转成 data:base64
//
// 为什么这么做：实测 DeepSeek 的 image_url 字段【接受】内联 base64，
// 但【不接受】让它自己去下载 URL（会返回 "Failed to download image"）。
// 所以必须由我们把图片抓成 base64 再发。
//
// 同时按管理员要求做体积控制：超过上限的图片一律不发送，避免无谓的 token 消耗。
import { log } from './logger.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OK_MIME = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];

/**
 * 下载图片并转成 data URL。
 * @returns {Promise<{ok:true, dataUrl:string, bytes:number, mime:string} | {ok:false, reason:string}>}
 */
export async function fetchImageAsDataUrl(url, { maxBytes = 2 * 1024 * 1024, timeoutMs = 15000 } = {}) {
  if (!url) return { ok: false, reason: '图片地址为空' };
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `下载失败 HTTP ${res.status}` };

    // 先看 Content-Length，能提前拦掉大图，省掉下载流量
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) {
      return { ok: false, reason: `图片 ${(declared / 1048576).toFixed(1)}MB，超过 ${(maxBytes / 1048576).toFixed(1)}MB 上限` };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      return { ok: false, reason: `图片 ${(buf.length / 1048576).toFixed(1)}MB，超过 ${(maxBytes / 1048576).toFixed(1)}MB 上限` };
    }
    if (buf.length < 64) return { ok: false, reason: '图片数据过小，可能下载失败' };

    let mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!OK_MIME.includes(mime)) {
      // Content-Type 不可靠时按文件头判断
      mime = sniffMime(buf) || '';
    }
    if (!OK_MIME.includes(mime)) {
      return { ok: false, reason: `不支持的图片格式 ${mime || '未知'}` };
    }
    // API 只认 jpeg，不认 jpg
    if (mime === 'image/jpg') mime = 'image/jpeg';

    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length, mime };
  } catch (e) {
    const why = e.name === 'TimeoutError' ? `超时(${timeoutMs}ms)` : e.message;
    return { ok: false, reason: why };
  }
}

/** 按文件头猜类型 */
function sniffMime(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** 批量处理，返回可用的图片与跳过原因 */
export async function collectImages(urls, { maxImages = 2, maxBytes = 2 * 1024 * 1024, timeoutMs = 15000 } = {}) {
  const taken = [];
  const skipped = [];
  for (const u of urls.slice(0, maxImages)) {
    const r = await fetchImageAsDataUrl(u, { maxBytes, timeoutMs });
    if (r.ok) {
      taken.push(r);
      log(`[vision] 已载入图片 ${(r.bytes / 1024).toFixed(0)}KB (${r.mime})`);
    } else {
      skipped.push(r.reason);
      log(`[vision] 跳过图片：${r.reason}`);
    }
  }
  return { images: taken, skipped };
}
