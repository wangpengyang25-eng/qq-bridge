// 搜索链路测试：直接跑一次搜索并打印解析结果
// 用法：node probe_search.mjs ["搜索词"]
import { webSearch, formatResults } from './src/search.mjs';
import { initLogger, log } from './src/logger.mjs';

initLogger(null);

const q = process.argv[2] || 'DeepSeek V4.1 Flash 是什么';
console.log('搜索：' + q + '\n');

const t0 = Date.now();
const r = await webSearch(q, { limit: 5 });
console.log('耗时：' + (Date.now() - t0) + 'ms\n');

if (!r.ok) {
  console.log('❌ 失败：' + r.error);
  process.exit(1);
}

console.log('✅ 拿到 ' + r.results.length + ' 条结果\n');
console.log(formatResults(q, r.results));
process.exit(0);
