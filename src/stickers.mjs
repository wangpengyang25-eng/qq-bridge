// 表情包库：按「情绪名」索引本地图片，供模型按情绪索要
//
// 命名约定：stickers/<套装>/<情绪>.<扩展名>，例如 stickers/04-线条狗/加油.gif
// 模型只认情绪名，具体发哪一张由这里随机挑（尽量不连续发同一张）。
//
// 频率控制放在**人设**里（"情绪明显时才发一张，一次对话最多一张"），这里不做节流：
// 再加冷却/每小时上限，会让它在该发的时候发不出来，反而更别扭。
// 同一次回答里天然只会发一张 —— 模型多次索要时后一次会覆盖前一次。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from './logger.mjs';

const IMG = /\.(png|gif|jpe?g|webp|apng)$/i;
const ri = (n) => crypto.randomInt(0, n);

export class StickerLibrary {
  /**
   * @param {object} cfg  config.json 的 stickers 段
   * @param {string} rootDir stickers 目录的绝对路径
   */
  constructor(cfg = {}, rootDir) {
    this.enabled = cfg.enabled !== false;
    this.root = rootDir;
    this.maxMoods = Number(cfg.maxMoods) || 60;

    this.sets = new Map(); // 套装名 -> Map(情绪 -> 绝对路径数组)
    this.setNames = [];
    this.activeSet = '';
    this.activeError = '';
    this.lastFile = ''; // 上一次发出去的文件，避免连发同一张

    if (!this.enabled) return;
    this._scan();

    const want = String(cfg.activeSet || '').trim();
    if (want && this.sets.has(want)) this.activeSet = want;
    else if (want) {
      this.activeError = `找不到套装「${want}」`;
      this.activeSet = this.setNames[0] || '';
    } else {
      this.activeSet = this.setNames[0] || '';
    }
    if (!this.activeSet) this.activeError = this.activeError || 'stickers 目录里没有可用的套装';
    else log(`[sticker] 装载 ${this.setNames.length} 套表情，当前使用「${this.activeSet}」（${this.moods().length} 个情绪）`);
  }

  _scan() {
    let dirs = [];
    try {
      dirs = fs
        .readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch (e) {
      this.activeError = `读取 stickers 目录失败：${e.message}`;
      return;
    }
    for (const d of dirs) {
      const abs = path.join(this.root, d);
      let files = [];
      try {
        files = fs.readdirSync(abs).filter((f) => IMG.test(f));
      } catch {
        continue;
      }
      if (!files.length) continue;
      const moods = new Map();
      for (const f of files) {
        const mood = f.replace(IMG, '');
        if (!moods.has(mood)) moods.set(mood, []);
        moods.get(mood).push(path.join(abs, f));
      }
      this.sets.set(d, moods);
      this.setNames.push(d);
    }
  }

  /** 当前套装的全部情绪名 */
  moods() {
    const m = this.sets.get(this.activeSet);
    return m ? [...m.keys()].sort() : [];
  }

  /** 把模型给的情绪名对齐到套装里真实存在的名字 */
  resolveMood(input) {
    const m = this.sets.get(this.activeSet);
    if (!m) return null;
    const raw = String(input || '').trim();
    if (!raw) return null;
    if (m.has(raw)) return raw;
    const lower = raw.toLowerCase();
    for (const k of m.keys()) {
      if (k.toLowerCase() === lower) return k;
    }
    // 容错：模型可能多写或少写了字
    const cands = [...m.keys()].filter((k) => k.length >= 2 && (k.includes(raw) || raw.includes(k)));
    return cands.length ? cands[0] : null;
  }

  /**
   * 取一张表情。
   * @returns {{ok:true, mood:string, file:string, name:string} | {ok:false, error:string}}
   */
  pick(moodInput) {
    if (!this.enabled) return { ok: false, error: '表情包功能没开' };
    const m = this.sets.get(this.activeSet);
    if (!m) return { ok: false, error: this.activeError || '没有可用的表情包套装' };

    const mood = this.resolveMood(moodInput);
    if (!mood) {
      const hint = [...m.keys()].slice(0, 12).join('、');
      return { ok: false, error: `没有「${moodInput}」这个情绪，可选的有：${hint}…` };
    }

    const files = m.get(mood);
    let file = files[ri(files.length)];
    if (files.length > 1 && file === this.lastFile) file = files[ri(files.length)];
    this.lastFile = file;
    return { ok: true, mood, file, name: path.basename(file) };
  }

  stats() {
    const m = this.sets.get(this.activeSet);
    return {
      sets: this.setNames.length,
      activeSet: this.activeSet,
      moods: m ? m.size : 0,
      images: m ? [...m.values()].reduce((a, b) => a + b.length, 0) : 0,
    };
  }
}
