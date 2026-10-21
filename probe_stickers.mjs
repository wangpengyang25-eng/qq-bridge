// 表情包工具：列出各套的情绪名，并生成挑选用的预览页 stickers/预览.html
// 用法：node probe_stickers.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'stickers');
const IMG = /\.(png|gif|jpe?g|webp)$/i;

const sets = fs
  .readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const data = [];
for (const s of sets) {
  const files = fs.readdirSync(path.join(DIR, s)).filter((f) => IMG.test(f)).sort();
  const moods = files.map((f) => f.replace(IMG, ''));
  data.push({ set: s, moods, files });
  console.log(`\n=== ${s}（${files.length} 张）===`);
  console.log(moods.join('、'));
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const sections = data
  .map(
    (d) => `
  <section>
    <h2>${esc(d.set)} <span class="cnt">${d.files.length} 张</span></h2>
    <div class="grid">
${d.files
  .map(
    (f) => `      <figure><img src="${esc(d.set)}/${esc(f)}" alt="${esc(f)}" loading="lazy"><figcaption>${esc(
      f.replace(IMG, '')
    )}</figcaption></figure>`
  )
  .join('\n')}
    </div>
  </section>`
  )
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>表情包挑选</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; padding:24px; background:#F7F6F3; color:#2C2C2A;
         font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif; font-size:14px; }
  h1 { font-size:18px; font-weight:500; margin:0 0 6px; }
  .tip { color:#5F5E5A; font-size:13px; line-height:1.7; margin-bottom:22px;
         background:#fff; border:1px solid rgba(0,0,0,.08); border-radius:10px; padding:12px 14px; }
  code { background:#F1EFE8; padding:1px 5px; border-radius:4px; font-size:12px; }
  h2 { font-size:15px; font-weight:500; margin:26px 0 10px; }
  .cnt { color:#888780; font-weight:400; font-size:12px; margin-left:6px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(96px,1fr)); gap:10px; }
  figure { margin:0; background:#fff; border:1px solid rgba(0,0,0,.08); border-radius:10px;
           padding:8px 6px 6px; text-align:center; }
  figure img { width:64px; height:64px; object-fit:contain; display:block; margin:0 auto 6px; }
  figcaption { font-size:12px; color:#444441; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
</style>
</head>
<body>
<h1>表情包挑选</h1>
<div class="tip">
  挑好一套后，把名字填进 <code>config.json</code> 的 <code>stickers.activeSet</code>，重启即可。<br>
  聊天时机器人会按每张图下面的<b>情绪名</b>来发（如「卖萌」「大笑」），不是每次都会发。
</div>
${sections}
</body>
</html>
`;

fs.writeFileSync(path.join(DIR, '预览.html'), html);
console.log(`\n预览页已生成：${path.join(DIR, '预览.html')}`);
