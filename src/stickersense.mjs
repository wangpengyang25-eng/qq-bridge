// 读群友的表情包：识别它在表达什么情绪
//
// 为什么要单独一层：
// 群友甩一张表情包时，对机器人来说只有"有一张图"——它不知道图里是什么。
// 不懂内容就回一张，等于瞎猜。所以这里负责把图变成**情绪名**，
// 而且情绪名必须来自本地表情库的那套词表（否则说不出、也发不出）。
//
// 两个成本控制：
// 1. **哈希缓存**：同一个表情包只识别一次，之后查表。群里来来回回就那几十张图。
// 2. **宁可识别不出也不瞎猜**：模型返回的词不在词表里就丢弃，不是"差不多就行"。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.mjs';

const VERSION = 1;

/** 评论一条表情包该不该回：纯函数，方便单测（时间从外部传） */
export function decideStickerReply({ cfg, now, lastSpokeAt, lastReplyAt, day, dayCount, scene = 'group' }) {
  const rc = cfg || {};
  if (!rc.enabled) return { ok: false, why: '开关未开' };

  // "只在机器人刚说过话之后接梗"是**群聊**的防打扰规则：
  // 群里谁都在发表情包，不能挨个回。私聊是一对一，你发图它就该接，不看这个窗口。
  if (rc.onlyAfterBotSpoke !== false && scene === 'group') {
    const within = rc.withinMs ?? 120000;
    if (!lastSpokeAt) return { ok: false, why: '机器人还没在这个群说过话' };
    if (now - lastSpokeAt > within) return { ok: false, why: '距离上次说话太久了' };
  }

  if (now - (lastReplyAt || 0) < (rc.cooldownMs ?? 300000)) {
    return { ok: false, why: '同群冷却中' };
  }

  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const used = day === today ? dayCount || 0 : 0;
  if (used >= (rc.dailyLimit ?? 20)) return { ok: false, why: '今天的额度用完了' };

  return { ok: true, why: '' };
}

/**
 * 收到某个情绪时，回哪一种更像"读懂了"而不是回声。
 * 关键是**不回同一个**：别人发"难过"，你回"难过"是复读机；回"加油"才叫回应。
 */
export const MOOD_REPLY = {
  加油: ['好棒', '好耶'],
  好棒: ['开心', '庆祝'],
  好耶: ['庆祝', '摇摆'],
  开心: ['摇摆', '晃脚脚'],
  庆祝: ['转圈', '摇摆'],
  完成: ['好棒', '庆祝'],
  非常好: ['好棒', '庆祝'],
  谢谢: ['送你花花', '开心'],
  送你花花: ['谢谢', '开心'],
  期待: ['好耶', '庆祝'],
  来了: ['开心', '好耶'],
  难过: ['加油', '探头'],
  沮丧: ['加油', '探头'],
  好痛: ['加油', '探头'],
  紧张: ['加油', '好棒'],
  写不完了: ['加油', '好棒'],
  颓废: ['加油', '好棒'],
  准备: ['加油', '好耶'],
  惊: ['探头', '歪头'],
  震惊: ['探头', '歪头'],
  惊讶: ['歪头', '探头'],
  惊讶2: ['歪头', '探头'],
  威胁: ['哼', '略'],
  打你: ['略', '哼'],
  打你2: ['略', '哼'],
  呸: ['略', '哼'],
  哼: ['略', '歪头'],
  略: ['哼', '呸'],
  不要: ['摊手', '歪头'],
  喂: ['歪头', '探头'],
  寻找: ['指', '探头'],
  指: ['探头', '歪头'],
  探头: ['歪头', '惊'],
  歪头: ['探头', '惊'],
  盯: ['歪头', '探头'],
  摇摆: ['晃脚脚', '转圈'],
  晃脚脚: ['摇摆', '翘脚脚'],
  翘脚脚: ['晃脚脚', '摇摆'],
  转圈: ['摇摆', '欢呼'],
  摊手: ['略', '歪头'],
  看窗外1: ['探头', '寻找'],
  看窗外2: ['探头', '寻找'],
  画圈圈: ['探头', '歪头'],
};

/** 热络向的回应（关系越近越优先） */
const WARM = new Set(['庆祝', '摇摆', '好耶', '送你花花', '转圈', '晃脚脚', '翘脚脚', '开心', '非常好', '好棒']);
/** 克制向的回应（还不太熟时优先） */
const CALM = new Set(['探头', '歪头', '指', '盯', '寻找', '摊手', '谢谢']);

/**
 * 挑一个回应情绪。
 * @param {string} received 对方表情包的情绪
 * @param {string} levelKey 关系等级 lv0..lv4 —— 同样的图，对熟人回得更热络
 * @param {string[]} moods  本地词表
 * @param {Function} [random] 注入随机源，便于测试
 */
export function pickReplyMood(received, levelKey = 'lv2', moods = [], random = Math.random) {
  const has = (m) => moods.includes(m);
  const candidates = (MOOD_REPLY[received] || []).filter(has);

  let pool = candidates;
  if (levelKey === 'lv0' || levelKey === 'lv1') {
    const calm = candidates.filter((m) => CALM.has(m));
    if (calm.length) pool = calm;
  } else if (levelKey === 'lv3' || levelKey === 'lv4') {
    const warm = candidates.filter((m) => WARM.has(m));
    if (warm.length) pool = warm;
  }

  // 没有映射（或映射的词不在当前套装里）：退到"友好但不重复"的集合
  if (!pool.length) {
    pool = moods.filter((m) => m !== received && (WARM.has(m) || CALM.has(m)));
  }
  if (!pool.length) pool = moods.filter((m) => m !== received);
  if (!pool.length) pool = moods;
  if (!pool.length) return null;

  const i = Math.floor(random() * pool.length);
  return pool[Math.min(pool.length - 1, Math.max(0, i))];
}

export class StickerSense {
  /**
   * @param {object} opts
   * @param {string} opts.cacheFile      识别缓存文件
   * @param {Function} opts.moods        () => string[]  本地表情库的情绪词表
   * @param {Function} opts.normalize    (word) => string|null  把模型输出对到词表上（可用 resolveMood）
   * @param {Function} opts.complete     (messages, opts) => Promise<string>  一次性模型调用
   * @param {Function} opts.fetchImages  (urls, opts) => Promise<{images:{dataUrl}[]}>
   */
  constructor({ cacheFile, moods, normalize, complete, fetchImages, maxMoods = 60, maxTokens = 400 } = {}) {
    this.cacheFile = cacheFile;
    this.moods = moods || (() => []);
    this.normalize = normalize || ((w) => (String(w || '').trim() || null));
    this.complete = complete || null;
    this.fetchImages = fetchImages || null;
    this.maxMoods = maxMoods;
    // 推理型模型（deepseek 这类）会先消耗 reasoning token：
    // 预算给小了，content 直接是空字符串 —— 看起来像"不支持图片"，其实是没钱说话。
    this.maxTokens = Math.max(64, Number(maxTokens) || 400);

    this.hits = 0;
    this.misses = 0;
    this.failures = 0;
    this.doc = this._load();
  }

  _load() {
    try {
      if (!this.cacheFile || !fs.existsSync(this.cacheFile)) return { version: VERSION, entries: {} };
      const doc = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      const entries = doc?.entries && typeof doc.entries === 'object' ? doc.entries : {};
      return { version: VERSION, entries };
    } catch (e) {
      log(`[sticker] 识别缓存读取失败（忽略，重新建）：${e.message}`);
      return { version: VERSION, entries: {} };
    }
  }

  _save() {
    if (!this.cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.doc, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.cacheFile);
    } catch (e) {
      log(`[sticker] 识别缓存写入失败：${e.message}`);
    }
  }

  get size() {
    return Object.keys(this.doc.entries).length;
  }

  /**
   * 识别一张表情包。
   * @param {string[]} urls 表情包图片地址（取第一张）
   * @returns {Promise<null | { mood: string, source: 'cache'|'vision' }>}
   */
  async identify(urls) {
    if (!Array.isArray(urls) || !urls.length) return null;
    if (!this.fetchImages) return null;

    let dataUrl = null;
    try {
      const r = await this.fetchImages(urls.slice(0, 1), { maxImages: 1 });
      dataUrl = r?.images?.[0]?.dataUrl || null;
    } catch (e) {
      this.failures += 1;
      log(`[sticker] 表情包下载失败：${e.message}`);
      return null;
    }
    if (!dataUrl) {
      this.failures += 1;
      return null;
    }

    const hash = crypto.createHash('sha256').update(dataUrl).digest('hex').slice(0, 32);
    const hit = this.doc.entries[hash];
    if (hit?.mood) {
      const norm = this._known(hit.mood);
      if (norm) {
        this.hits += 1;
        return { mood: norm, source: 'cache' };
      }
      // 词表变了、这个情绪名已经不存在了：当作没命中，重新识别
      delete this.doc.entries[hash];
    }

    if (!this.complete) return null;

    this.misses += 1;
    const mood = await this._ask(dataUrl);
    if (!mood) return null;

    this.doc.entries[hash] = { mood, at: Date.now() };
    this._save();
    return { mood, source: 'vision' };
  }

  /** 把模型输出对到本地词表上；对不上就返回 null（不瞎猜） */
  _known(word) {
    const w = String(word || '').trim();
    if (!w) return null;
    const norm = this.normalize(w);
    if (!norm) return null;
    const list = this.moods();
    return list.includes(norm) ? norm : null;
  }

  async _ask(dataUrl) {
    const list = this.moods().slice(0, this.maxMoods);
    if (!list.length) return null;

    const messages = [
      {
        role: 'system',
        content:
          '你在做表情包情绪分类。只输出一个 JSON 对象，不要解释、不要 Markdown、不要额外文字。',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text:
            '这张表情包最接近下面哪个情绪？只能从列表里选一个。\n' +
            `列表：${list.join('、')}\n` +
            '如果看不出或者都不合适，就输出 {"mood":null}。\n' +
            '输出格式：{"mood":"列表里的某个词"}' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ];

    let raw = '';
    try {
      raw = await this.complete(messages, { jsonMode: true, maxTokens: this.maxTokens });
    } catch (e) {
      this.failures += 1;
      log(`[sticker] 表情包识别调用失败：${e.message}`);
      return null;
    }

    // 空 content 是推理模型常见的坑：预算被 reasoning 吃光。
    // 翻倍再试一次，还空就说明这条路真的不通（模型不支持图片会这样）。
    if (!String(raw || '').trim()) {
      try {
        raw = await this.complete(messages, { jsonMode: true, maxTokens: this.maxTokens * 2 });
      } catch (e) {
        this.failures += 1;
        log(`[sticker] 表情包识别重试失败：${e.message}`);
        return null;
      }
      if (!String(raw || '').trim()) {
        this.failures += 1;
        log(
          `[sticker] 模型返回空内容（已重试，maxTokens=${this.maxTokens * 2}）。` +
            '常见原因：模型不支持图片输入，或推理把预算吃光了。'
        );
        return null;
      }
    }

    return this._parse(raw, list);
  }

  /** 从模型输出里抠出情绪名；抠不到或不在词表里都返回 null */
  _parse(raw, list) {
    const text = String(raw || '').trim();
    if (!text) return null;

    let word = null;
    try {
      const obj = JSON.parse(text);
      word = obj?.mood ?? null;
    } catch {
      const m = /"mood"\s*:\s*"([^"]*)"/.exec(text);
      if (m) word = m[1];
    }

    if (word === null || word === undefined) return null;
    if (typeof word !== 'string') return null;

    const norm = this._known(word);
    if (norm) return norm;

    // 兜底：模型可能把词和别的字混在一起，扫一遍看有没有恰好命中词表的
    for (const w of list) {
      if (text.includes(w)) return w;
    }
    return null;
  }

  summary() {
    return { cached: this.size, hits: this.hits, misses: this.misses, failures: this.failures };
  }
}
