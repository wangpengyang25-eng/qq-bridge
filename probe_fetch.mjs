// 网页抓取探针：验证①公网页面能读回来 ②本机/内网地址一定被拦
// 用法：node probe_fetch.mjs [url ...]   不带参数则跑默认几组
import { fetchPageText } from './src/fetchpage.mjs';
import { initLogger } from './src/logger.mjs';

initLogger(null);

const targets = process.argv.slice(2);
const list = targets.length
  ? targets
  : ['https://example.com/', 'http://127.0.0.1:6099/webui/', 'http://169.254.169.254/'];

for (const u of list) {
  const t0 = Date.now();
  const r = await fetchPageText(u, { maxChars: 300 });
  console.log(`\n=== ${u} ===`);
  if (r.ok) {
    console.log(`✅ ${r.title || '(无标题)'} | 正文 ${r.fullChars} 字${r.truncated ? '（已截断）' : ''} | ${Date.now() - t0}ms`);
    console.log('   ' + r.text.slice(0, 180).replace(/\n/g, ' ⏎ '));
  } else {
    console.log(`❌ ${r.error} | ${Date.now() - t0}ms`);
  }
}
