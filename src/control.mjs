// 读面板写的"功能开关"（data/control.json）
//
// 为什么单独一个文件而不是让面板改 config.json：
// 1. config.json 里有 API Key，让面板写它风险太大；
// 2. 面板和 bridge 同时写同一个文件迟早互相覆盖（这条规矩从 members/overrides 就定下了）。
//
// control.json 只放"运行中想立刻改的开关"，其余参数（冷却、额度）仍然在 config.json。
// 值可以是 true / false；缺省表示"跟随 config.json"。

import fs from 'node:fs';

const FIELDS = ['initiative', 'chime', 'callout', 'stickerReply', 'quietHours'];

export function createControlReader(file, { ttlMs = 3000 } = {}) {
  let cache = { at: 0, mtimeMs: -1, values: {}, error: null };

  return function readControl(now = Date.now()) {
    try {
      if (now - cache.at < ttlMs) return cache;

      let st = null;
      try {
        st = fs.statSync(file);
      } catch {
        // 文件不存在 = 全部跟随 config.json
        cache = { at: now, mtimeMs: -1, values: {}, error: null };
        return cache;
      }
      if (st.mtimeMs === cache.mtimeMs) {
        cache.at = now;
        return cache;
      }

      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const src = doc?.control && typeof doc.control === 'object' ? doc.control : {};
      const values = {};
      for (const k of FIELDS) {
        const v = src[k];
        if (typeof v === 'boolean') values[k] = v;
      }

      cache = { at: now, mtimeMs: st.mtimeMs, values, error: null };
      return cache;
    } catch (e) {
      // 坏了就沿用上一次，别因为一个编辑器的临时占用把开关重置了
      cache = { ...cache, at: now, error: e.message };
      return cache;
    }
  };
}
