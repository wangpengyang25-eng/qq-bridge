// 联网搜索：抓 cn.bing.com 的结果页并解析
// 不依赖任何第三方 API Key。实测 cn.bing.com 可直连（约 0.3s），
// 而 duckduckgo / 百度 在本机网络下不通。
import { log } from './logger.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 去标签 + 还原 HTML 实体（search.mjs 与 fetchpage.mjs 共用） */
export function decodeEntities(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&ensp;|&#0183;|&#160;|&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 解析 Bing 结果页：每条是 <li class="b_algo"> 内含 <h2><a href>标题</a></h2> 与 <p>摘要</p> */
export function parseBing(html, limit = 5) {
  const out = [];
  const re = /<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<\/ol>|$)/g;
  for (const m of html.matchAll(re)) {
    if (out.length >= limit) break;
    const block = m[0];
    const titleM = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(block);
    if (!titleM) continue;
    const linkM = /<h2[^>]*>[\s\S]*?href="(https?:\/\/[^"]+)"/.exec(block);
    const pM = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    const title = decodeEntities(titleM[1]);
    if (!title) continue;
    out.push({
      title,
      url: linkM ? linkM[1] : '',
      snippet: pM ? decodeEntities(pM[1]) : '',
    });
  }
  return out;
}

/** 把结果整理成给模型看的纯文本 */
export function formatResults(query, results) {
  if (!results.length) return `（搜索「${query}」没有返回可用结果）`;
  const lines = [`以下是「${query}」的搜索结果：`];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    if (r.url) lines.push(`   来源：${r.url}`);
  });
  return lines.join('\n');
}

/**
 * 执行一次搜索。
 * @returns {Promise<{ok:boolean, results:Array, error?:string}>}
 */
export async function webSearch(query, { limit = 5, timeoutMs = 15000, region = 'zh-CN' } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, results: [], error: '搜索词为空' };

  const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=${region}&count=${limit + 2}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log(`[search] 「${q}」失败 HTTP ${res.status}`);
      return { ok: false, results: [], error: `搜索接口返回 ${res.status}` };
    }
    const html = await res.text();
    const results = parseBing(html, limit);
    log(`[search] 「${q}」拿到 ${results.length} 条，用时 ${Date.now() - started}ms`);
    if (!results.length) {
      return { ok: false, results: [], error: '没有解析到结果（页面结构可能变了）' };
    }
    return { ok: true, results };
  } catch (e) {
    const why = e.name === 'TimeoutError' ? `超时(${timeoutMs}ms)` : e.message;
    log(`[search] 「${q}」异常：${why}`);
    return { ok: false, results: [], error: why };
  }
}
