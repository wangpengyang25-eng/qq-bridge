// 用本地 ComfyUI 给演示群友生产头像
//
//   node scripts/gen-avatars.mjs
//
// 只对 seed 里的假 QQ 号生效，写进 public/avatars/<qq>.png。
// 真实群友的头像应该走 QQ 官方接口（q1.qlogo.cn），不该用 AI 编一张脸出来。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'public', 'avatars');
const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188';

const CKPT = process.env.CKPT || 'Illustrious-XL-v1.0.safetensors';
const W = Number(process.env.W || 768);
const H = Number(process.env.H || 768);
const STEPS = Number(process.env.STEPS || 26);

const STYLE = 'masterpiece, best quality, portrait, bust shot, looking at viewer, simple background, soft lighting, anime style';
const NEG = 'lowres, bad anatomy, bad hands, extra digits, text, watermark, signature, multiple views, blurry';

// 昵称 → 提示词。顺序与 scripts/seed.mjs 一致。
const MEMBERS = [
  { qq: '2000000001', char: '1boy, mature man, short black hair, light stubble, white shirt, relaxed smile' },
  { qq: '2000000002', char: '1girl, long dark hair, soft smile, holding a teacup, calm' },
  { qq: '2000000003', char: '1boy, grey hoodie, hood up, sleepy eyes, night mood' },
  { qq: '2000000004', char: '1girl, short bob hair, bright smile, energetic, warm colors' },
  { qq: '2000000005', char: '1girl, messy hair, half closed eyes, sleepy, small yawn' },
  { qq: '2000000006', char: '1boy, buzz cut, sturdy build, friendly grin, casual jacket' },
  { qq: '2000000007', char: '1girl, twin tails, light green hair ribbon, cheerful, fresh look' },
  { qq: '2000000008', char: '1girl, cat ears, oversized hoodie, curious look, soft colors' },
];

function workflow({ positive, negative, seed }) {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: 1 } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: STEPS,
        cfg: 5.5,
        sampler_name: 'euler_ancestral',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'avatar', images: ['8', 0] } },
  };
}

async function submit(graph) {
  const r = await fetch(`${COMFY}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`提交失败: ${JSON.stringify(j).slice(0, 300)}`);
  return j.prompt_id;
}

async function waitFor(promptId, timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await fetch(`${COMFY}/history/${promptId}`);
    const h = await r.json();
    const entry = h[promptId];
    if (entry?.outputs) return entry;
    if (entry?.status?.status_str === 'error') throw new Error('生成出错');
    await new Promise((res) => setTimeout(res, 1200));
  }
  throw new Error('等待超时');
}

function firstImage(entry) {
  for (const node of Object.values(entry.outputs || {})) {
    if (Array.isArray(node.images) && node.images.length) return node.images[0];
  }
  return null;
}

async function download(img) {
  const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
  const r = await fetch(`${COMFY}/view?${q}`);
  if (!r.ok) throw new Error(`下载失败 ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// ---------- 主流程 ----------

fs.mkdirSync(OUT_DIR, { recursive: true });

// 先确认 ComfyUI 活着
try {
  const s = await fetch(`${COMFY}/system_stats`).then((r) => r.json());
  console.log(`ComfyUI: ${s.devices[0].name}`);
} catch {
  console.error(`连不上 ComfyUI（${COMFY}）。先启动：E:\\AI\\启动ComfyUI.bat`);
  process.exit(1);
}

let ok = 0;
for (let i = 0; i < MEMBERS.length; i++) {
  const m = MEMBERS[i];
  const seed = 20261021 + i * 137;
  const t0 = Date.now();
  try {
    const id = await submit(workflow({ positive: `${STYLE}, ${m.char}`, negative: NEG, seed }));
    const entry = await waitFor(id);
    const img = firstImage(entry);
    if (!img) throw new Error('没有输出图片');
    const buf = await download(img);
    const dest = path.join(OUT_DIR, `${m.qq}.png`);
    fs.writeFileSync(dest, buf);
    console.log(`  ✓ ${m.qq}  ${Math.round((Date.now() - t0) / 1000)}s  ${Math.round(buf.length / 1024)}KB`);
    ok++;
  } catch (e) {
    console.error(`  ✗ ${m.qq}  ${e.message}`);
  }
}

console.log(`\n完成 ${ok}/${MEMBERS.length} → ${OUT_DIR}`);
