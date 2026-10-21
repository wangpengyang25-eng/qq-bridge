// 人设加载：把 persona.txt + 选定的 fewshot 合成最终的 system prompt
//
// 为什么要单独一层：人设是"她是谁"，是最常改的东西。原来改完必须重启，
// 因为 config.mjs 在启动时就把 systemPrompt 拼好了。
// 这里做成"按文件 mtime 缓存"，改了立刻生效，没改就零开销。
//
// 角色卡：personas/<名字>/ 目录里放
//   persona.txt      —— 人设正文
//   relations.json   —— 这个角色自己的好感度措辞和关系称号（可选）
// 根目录的 persona.txt 是"默认角色"，老配置不受影响。

import fs from 'node:fs';
import path from 'node:path';

const CACHE_MS = 2000;

/** 校验并清洗关系措辞表；任何不合法的部分都退回默认，不让一个人设把系统搞坏 */
export function normalizeRelationTable(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const out = {};
  if (doc.guides && typeof doc.guides === 'object') {
    const guides = {};
    for (const key of ['lv0', 'lv1', 'lv2', 'lv3', 'lv4']) {
      const v = doc.guides[key];
      if (typeof v === 'string' && v.trim()) guides[key] = v.trim();
    }
    if (Object.keys(guides).length) out.guides = guides;
  }
  if (typeof doc.coldHint === 'string' && doc.coldHint.trim()) out.coldHint = doc.coldHint.trim();
  if (doc.bonds && typeof doc.bonds === 'object') {
    const bonds = {};
    for (const [k, v] of Object.entries(doc.bonds)) {
      const name = String(k).trim();
      if (name && typeof v === 'string' && v.trim()) bonds[name] = v.trim();
    }
    if (Object.keys(bonds).length) out.bonds = bonds;
  }
  return Object.keys(out).length ? out : null;
}

export class PersonaLoader {
  /**
   * @param {object} opts
   * @param {string} opts.dir        config.json 所在目录
   * @param {string} opts.promptFile 默认人设文件名（如 persona.txt）
   * @param {string} opts.fewshotDir fewshot 目录名
   * @param {string} opts.defaultFewshot 配置里指定的示范文件
   * @param {string} [opts.personaDir] 角色卡目录（默认 personas）
   */
  constructor({ dir, promptFile, fewshotDir = 'fewshot', defaultFewshot = '', personaDir = 'personas' } = {}) {
    this.dir = dir;
    this.promptFile = promptFile || '';
    this.fewshotDir = path.resolve(dir, fewshotDir);
    this.defaultFewshot = defaultFewshot || '';
    this.personaDir = path.resolve(dir, personaDir);
    this.at = 0;
    this.sig = '';
    this.result = { prompt: '', persona: '', relations: null, fewshotName: '', error: null };
  }

  /** 列出可选的角色卡（给面板用） */
  listPersonas() {
    const out = [];
    if (this.promptFile && fs.existsSync(path.resolve(this.dir, this.promptFile))) out.push('默认');
    try {
      for (const d of fs.readdirSync(this.personaDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        if (fs.existsSync(path.join(this.personaDir, d.name, 'persona.txt'))) out.push(d.name);
      }
    } catch {
      // 没有 personas/ 目录很正常
    }
    return out;
  }

  /** 列出可选的示范文件 */
  listFewshot() {
    try {
      return fs
        .readdirSync(this.fewshotDir)
        .filter((f) => f.endsWith('.txt') || f.endsWith('.md'))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * 取当前生效的人设。
   * @param {object} opts
   * @param {string} [opts.persona] 角色卡名；空/『默认』= 根目录的 persona.txt
   * @param {string} [opts.overrideFewshot] 面板指定的示范；undefined = 用配置
   */
  load({ persona = '', overrideFewshot } = {}) {
    const now = Date.now();
    // 缓存键必须包含"选了哪张卡/哪个示范"，否则面板上切了角色要等 2 秒才生效
    const key = `${persona || ''}|${overrideFewshot === undefined ? '\u0000' : overrideFewshot}`;
    if (now - this.at < CACHE_MS && key === this.lastKey) return this.result;
    this.lastKey = key;

    const fewshotName = overrideFewshot === undefined ? this.defaultFewshot : String(overrideFewshot || '');
    const useCard = persona && persona !== '默认';
    const baseDir = useCard ? path.join(this.personaDir, persona) : this.dir;
    const pPath = this.promptFile ? path.resolve(baseDir, this.promptFile) : '';
    const rPath = useCard ? path.join(baseDir, 'relations.json') : '';
    // 世界观（她"知道的事"）单独一个文件：补设定不用动人设本身
    const lorePath = useCard ? path.join(baseDir, 'lore.txt') : '';
    const hasLore = !!lorePath && fs.existsSync(lorePath);
    // 角色卡自带的示范问答优先于配置里的全局示范：
    // 换了角色还沿用上一个角色的示范，口吻会被带偏
    const cardFewshot = useCard ? path.join(baseDir, 'fewshot.txt') : '';
    const hasCardFewshot = cardFewshot && fs.existsSync(cardFewshot) && overrideFewshot === undefined;
    const fPath = hasCardFewshot
      ? cardFewshot
      : fewshotName
        ? path.resolve(this.fewshotDir, fewshotName)
        : '';

    const sig = [persona || '默认', pPath, rPath, fPath, hasLore ? lorePath : '']
      .map((p) => {
        if (!p) return '-';
        try {
          const s = fs.statSync(p);
          return `${s.mtimeMs}:${s.size}`;
        } catch {
          return 'missing';
        }
      })
      .join('|');

    if (sig === this.sig && now - this.at < CACHE_MS * 5) {
      this.at = now;
      return this.result;
    }

    let prompt = '';
    let error = null;
    let source = '';

    if (pPath) {
      try {
        const text = fs.readFileSync(pPath, 'utf8').replace(/^\uFEFF/, '').trim();
        if (text) {
          prompt = text;
          source = path.relative(this.dir, pPath).replace(/\\/g, '/');
        } else {
          error = `${source || pPath} 是空文件`;
        }
      } catch (e) {
        error = `读取人设失败：${e.message}`;
      }
    }

    // 关系措辞：只有角色卡可能带，坏了就当没有
    let relations = null;
    if (rPath) {
      try {
        relations = normalizeRelationTable(JSON.parse(fs.readFileSync(rPath, 'utf8').replace(/^\uFEFF/, '')));
      } catch (e) {
        error = `relations.json 读取失败：${e.message}`;
      }
    }

    let loreText = '';
    if (hasLore) {
      try {
        loreText = fs.readFileSync(lorePath, 'utf8').replace(/^\uFEFF/, '').trim();
      } catch (e) {
        error = `lore.txt 读取失败：${e.message}`;
      }
    }

    let fewshotText = '';
    if (fPath) {
      try {
        fewshotText = fs.readFileSync(fPath, 'utf8').replace(/^\uFEFF/, '').trim();
      } catch (e) {
        error = `${fewshotName} 读取失败：${e.message}`;
      }
    }

    const full = [prompt, loreText, fewshotText].filter(Boolean).join('\n\n');

    this.at = now;
    this.sig = sig;
    this.result = {
      prompt: full,
      basePrompt: prompt,
      persona: useCard ? persona : '默认',
      relations,
      fewshotName: fewshotText ? (hasCardFewshot ? '（角色卡自带）' : fewshotName) : '',
      hasOwnFewshot: !!hasCardFewshot,
      hasLore,
      source,
      error,
      changed: true,
    };
    return this.result;
  }
}
