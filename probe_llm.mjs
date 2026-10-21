// 模型接口直连测试：不看 QQ，只验证 config.json 里的 llm 配置能否真的拿到回答
//
// 用法：node probe_llm.mjs ["自定义问题"]
// 它会把**全部工具**都挂上（搜索 / 计算 / 日期 / 随机 / 读网页 / 表情包），
// 工具真正被调用时把参数打印出来。所以用它就能一次试完人设 + 工具行为 + 表情包。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig } from './src/config.mjs';
import { chat } from './src/llm.mjs';
import { initLogger } from './src/logger.mjs';
import { webSearch, formatResults } from './src/search.mjs';
import { StickerLibrary } from './src/stickers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const question = process.argv[2] || '用一句话说明你是什么';
const cfg = loadConfig('./config.json');
initLogger(null); // 探针不打日志文件

const problems = validateConfig(cfg).filter((p) => p.includes('llm'));
if (problems.length) {
  console.log('配置有问题，先修：');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}

// 表情包：只打印"会发哪张"，不真的发
const stickers = new StickerLibrary(cfg.stickers || {}, path.resolve(cfg.__dir || HERE, cfg.stickers?.dir || 'stickers'));
let stickerHits = 0;

console.log('模型   :', cfg.llm.model);
console.log('端点   :', cfg.llm.baseUrl);
console.log('Key    :', cfg.llm.apiKey.slice(0, 6) + '...' + cfg.llm.apiKey.slice(-4));
console.log('人设   :', cfg.__personaSource + (cfg.__personaError ? ' ⚠ ' + cfg.__personaError : ''));
console.log('示范   :', (cfg.__fewShotSource || '（未启用）') + (cfg.__fewShotError ? ' ⚠ ' + cfg.__fewShotError : ''));
console.log('表情   :', stickers.activeSet ? `${stickers.activeSet}（${stickers.moods().length} 个情绪）` : '（无）');
console.log('');
console.log('提问   :', question);
console.log('');

const t0 = Date.now();
let searchCount = 0;
const onSearch = async (q) => {
  searchCount += 1;
  console.log(`  ↳ 模型请求联网搜索：「${q}」`);
  const r = await webSearch(q, { limit: cfg.search?.maxResults || 5 });
  if (!r.ok) return `（本次没搜到：${r.error}，就用手头信息回答）`;
  return formatResults(q, r.results);
};

const onSticker = (mood) => {
  const r = stickers.pick(mood);
  stickerHits += 1;
  if (r.ok) console.log(`  ↳ 模型要发表情：「${mood}」→ ${r.name}`);
  else console.log(`  ↳ 模型要发表情「${mood}」但没取到：${r.error}`);
  return r;
};

try {
  const answer = await chat(cfg, `probe:${Date.now()}`, question, '', {
    onSearch,
    stickerMoods: stickers.enabled ? stickers.moods() : [],
    onSticker,
  });
  console.log('回答   :', answer);
  console.log('耗时   :', Date.now() - t0, 'ms');
  console.log('联网   :', searchCount, searchCount === 0 ? '（没搜，直接用已有知识答）' : '（调用了搜索工具）');
  console.log('表情   :', stickerHits, stickerHits === 0 ? '（没发表情）' : '（模型主动要发）');
  console.log('\n✅ 模型链路正常');
  process.exit(0);
} catch (e) {
  console.log('❌ 失败 :', e.message);
  process.exit(1);
}
