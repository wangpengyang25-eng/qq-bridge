// 人设加载：把 persona.txt + 选定的 fewshot 合成最终的 system prompt
//
// 为什么要单独一层：人设是"她是谁"，是最常改的东西。原来改完必须重启，
// 因为 config.mjs 在启动时就把 systemPrompt 拼好了。
// 这里做成"按文件 mtime 缓存"，改了立刻生效，没改就零开销。

import fs from 'node:fs';
import path from 'node:path';

const CACHE_MS = 2000;

export class PersonaLoader {
  /**
   * @param {object} opts
   * @param {string} opts.dir        config.json 所在目录
   * @param {string} opts.promptFile 人设文件名（如 persona.txt）
   * @param {string} opts.fewshotDir fewshot 目录名
   * @param {string} opts.defaultFewshot 配置里指定的示范文件
   */
  constructor({ dir, promptFile, fewshotDir = 'fewshot', defaultFewshot = '' } = {}) {
    this.dir = dir;
    this.promptFile = promptFile || '';
    this.fewshotDir = path.resolve(dir, fewshotDir);
    this.defaultFewshot = defaultFewshot || '';
    this.at = 0;
    this.sig = '';
    this.result = { prompt: '', fewshotName: '', error: null };
  }

  /** 列出可选的示范文件（给面板用） */
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
   * 取当前生效的人设。overrideFewshot 来自面板（空字符串=不启用示范）。
   * 返回 { prompt, fewshotName, error }，并带一个 changed 标记告诉调用方要不要更新配置。
   */
  load({ overrideFewshot } = {}) {
    const now = Date.now();
    if (now - this.at < CACHE_MS) return this.result;

    const fewshotName = overrideFewshot === undefined ? this.defaultFewshot : String(overrideFewshot || '');

    // 用两个文件的 mtime 当签名：任一变化就重读
    const pPath = this.promptFile ? path.resolve(this.dir, this.promptFile) : '';
    const fPath = fewshotName ? path.resolve(this.fewshotDir, fewshotName) : '';
    const sig = [pPath, fPath]
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
          source = this.promptFile;
        } else {
          error = `${this.promptFile} 是空文件`;
        }
      } catch (e) {
        error = `读取 ${this.promptFile} 失败：${e.message}`;
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

    const full = fewshotText ? `${prompt}\n\n${fewshotText}` : prompt;

    this.at = now;
    this.sig = sig;
    this.result = {
      prompt: full,
      basePrompt: prompt,
      fewshotName: fewshotText ? fewshotName : '',
      source,
      error,
      changed: true,
    };
    return this.result;
  }
}
