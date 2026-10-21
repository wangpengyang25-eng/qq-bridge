// 网页正文抓取：群里有人贴链接时，把页面内容取回来给模型看
//
// 安全边界（重要）：必须挡掉本机与内网地址。
// 否则群友只要 @ 一句「读一下 http://127.0.0.1:6099/webui/」，
// 就能让机器人把本机服务的页面内容念出来——这违背了"群聊不触碰本机"的承诺。
import { log } from './logger.mjs';
import { decodeEntities } from './search.mjs';
import dns from 'node:dns/promises';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OK_TYPE = /^(text\/html|text\/plain|application\/xhtml\+xml)/i;
const MAX_BYTES = 3 * 1024 * 1024;
const BLOCK_MSG = '这个地址指向本机或内网，出于安全考虑不能抓取';

/** 单个 IP 是否为内网/本机/保留地址 */
export function isBlockedIp(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return true;
  if (s.includes(':')) {
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true; // 链路本地 / ULA
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
    if (mapped) return isBlockedIp(mapped[1]); // IPv4-mapped
    return false;
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return true; // 不是合法 IPv4 就按不可信处理
  const p = s.split('.').map(Number);
  if (p.some((x) => x > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // 云元数据 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // 组播 / 保留
  return false;
}

/** 域名层面的粗筛（IP 字面量与明显的内网主机名） */
export function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.home.arpa')
  ) {
    return true;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return isBlockedIp(h);
  return false;
}

/**
 * 真正的门禁：解析域名，逐个检查解析结果。
 * 只做字符串匹配是不够的——随便一个域名（如 localtest.me）都能解析到 127.0.0.1，
 * 必须看真实 IP。
 */
export async function assertPublicHost(hostname) {
  if (isBlockedHost(hostname)) return { ok: false, error: BLOCK_MSG };
  let addrs = [];
  try {
    addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    // 解析不了就交给 fetch 去报错，不在这里拦
    return { ok: true };
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) return { ok: false, error: BLOCK_MSG };
  }
  return { ok: true };
}

/** 按页面声明或响应头里的字符集解码（中文站点常见 GBK） */
function decodeBuffer(buf, contentType) {
  let charset = '';
  const fromHeader = /charset=([\w-]+)/i.exec(contentType || '');
  if (fromHeader) charset = fromHeader[1].toLowerCase();
  if (!charset) {
    const head = buf.subarray(0, 2048).toString('latin1');
    const fromMeta = /charset=["']?([\w-]+)/i.exec(head);
    if (fromMeta) charset = fromMeta[1].toLowerCase();
  }
  const isGb = /^(gb2312|gbk|gb18030)$/.test(charset);
  try {
    if (isGb) return new TextDecoder('gbk').decode(buf);
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** HTML → 纯文本（够用就好：去脚本样式、块级元素转换行、清实体、压空白） */
export function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|head|template)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/table|\/section|\/article)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0\u3000]+/g, ' ');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''));
  return m ? decodeEntities(m[1]).slice(0, 120) : '';
}

/**
 * 抓取网页正文。
 * @returns {Promise<{ok:true,url:string,title:string,text:string,truncated:boolean,fullChars:number} | {ok:false,error:string}>}
 */
export async function fetchPageText(rawUrl, { maxChars = 3000, timeoutMs = 15000 } = {}) {
  const input = String(rawUrl ?? '').trim();
  if (!/^https?:\/\//i.test(input)) return { ok: false, error: '只支持 http / https 链接' };

  let u;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, error: '链接格式不对' };
  }
  const guard = await assertPublicHost(u.hostname);
  if (!guard.ok) {
    log(`[fetch] 拒绝抓取内网/本机地址：${u.hostname}`);
    return { ok: false, error: guard.error };
  }

  try {
    const res = await fetch(u.toString(), {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `抓取失败 HTTP ${res.status}` };

    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (!OK_TYPE.test(ctype)) {
      return { ok: false, error: `不是网页内容（${ctype || '类型未知'}），只支持 html / 纯文本` };
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > MAX_BYTES) return { ok: false, error: '页面太大了（超过 3MB）' };

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return { ok: false, error: '页面太大了（超过 3MB）' };

    const html = decodeBuffer(buf, ctype);
    const text = htmlToText(html);
    if (text.length < 40) {
      return { ok: false, error: '页面里没抓到可读内容（可能需要登录，或是纯脚本渲染的页面）' };
    }
    const truncated = text.length > maxChars;
    log(`[fetch] ${u.hostname} 抓到 ${text.length} 字${truncated ? `，截断到 ${maxChars}` : ''}`);
    return {
      ok: true,
      url: res.url || u.toString(),
      title: extractTitle(html),
      text: truncated ? text.slice(0, maxChars) : text,
      truncated,
      fullChars: text.length,
    };
  } catch (e) {
    const why = e.name === 'TimeoutError' ? `超时(${timeoutMs}ms)` : e.message;
    log(`[fetch] ${u.hostname} 失败：${why}`);
    return { ok: false, error: why };
  }
}
