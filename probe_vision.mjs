// 探测 DeepSeek 的图片输入：用程序生成一张【真正合法】的 PNG 再发（上一次手写 base64 是无效数据）
import zlib from 'node:zlib';
import { loadConfig } from './src/config.mjs';
import { initLogger } from './src/logger.mjs';

const cfg = loadConfig('./config.json');
initLogger(null);
const KEY = cfg.llm.apiKey;
const BASE = cfg.llm.baseUrl.replace(/\/+$/, '');
const MODEL = cfg.llm.model;

// ---- 最小 PNG 编码器 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makePng(w, h, [r, g, b]) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter type 0
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = makePng(64, 64, [220, 30, 30]); // 纯红
console.log(`生成 PNG：${png.length} 字节，PNG 签名校验=${png.subarray(1, 4).toString() === 'PNG'}`);
console.log('');

async function tryOne(label, imageUrl) {
  const body = {
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这张图片主要是什么颜色？只回答颜色名，两个字。' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: 60,
    effort: 'low',
  };
  try {
    const res = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    const txt = await res.text();
    if (!res.ok) {
      console.log(`${label}\n  ❌ HTTP ${res.status}: ${txt.slice(0, 260)}\n`);
      return false;
    }
    const j = JSON.parse(txt);
    const c = j.choices?.[0]?.message?.content ?? '(空)';
    const u = j.usage || {};
    console.log(`${label}\n  ✅ ${String(c).replace(/\n/g, ' ')}\n  token: ${u.total_tokens}\n`);
    return true;
  } catch (e) {
    console.log(`${label}\n  ❌ ${e.message}\n`);
    return false;
  }
}

await tryOne('【1】data:image/png;base64 内联', 'data:image/png;base64,' + png.toString('base64'));
await tryOne('【2】公开 http URL', 'https://cn.bing.com/rp/ar_/spr.png');
