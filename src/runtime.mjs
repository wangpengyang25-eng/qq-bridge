// 运行状态上报：把 bridge 内部状态定期写成一个文件，供面板阅读
//
// 和 members.json 一样是"单一写者"：只有 bridge 写，面板只读。
// 面板上的「运行状态」和「紧急暂停」的当前状态都从这里拿。

import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.mjs';

export class RuntimeReporter {
  /**
   * @param {object} opts
   * @param {string} opts.file 输出文件
   * @param {Function} opts.getSnapshot () => object
   * @param {number} [opts.everyMs] 间隔
   */
  constructor({ file, getSnapshot, everyMs = 10000 }) {
    this.file = file;
    this.getSnapshot = getSnapshot;
    this.everyMs = Math.max(3000, Number(everyMs) || 10000);
    this.timer = null;
    this.lastError = null;
  }

  start() {
    if (!this.file || this.timer) return;
    this.writeNow();
    this.timer = setInterval(() => this.writeNow(), this.everyMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  writeNow() {
    if (!this.file) return false;
    try {
      const snap = this.getSnapshot();
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.file);
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = e.message;
      log(`[runtime] 状态上报失败：${e.message}`);
      return false;
    }
  }
}
