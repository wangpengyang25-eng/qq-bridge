// 读面板写的人工编辑（data/overrides.json）
//
// bridge 需要其中三样：
//   muted    —— 面板上点了"不要主动找这个人"，主动点名必须尊重它
//   note     —— 人工备注，会进到每一条回复的关系台词里
//   affinity —— 手动指定的亲密度（面板上改过就以它为准，不再用自动算的）
//   bond     —— 满级之后的具体关系称号：闺蜜 / 恋人 / 亲子 / 损友
//
// 这是 bridge 唯一一处**读**面板领域的文件。写仍然各写各的。
// 读失败时保留上一次的结果（stale 而不是清空），避免文件被编辑器占用的瞬间把编辑全丢了。

import fs from 'node:fs';

export function createOverrideReader(file, { ttlMs = 3000 } = {}) {
  let cache = {
    at: 0,
    mtimeMs: -1,
    muted: new Set(),
    notes: new Map(),
    affinity: new Map(),
    bonds: new Map(),
    error: null,
  };

  return function readOverrides(now = Date.now()) {
    try {
      if (now - cache.at < ttlMs) return cache;

      let st = null;
      try {
        st = fs.statSync(file);
      } catch {
        // 文件不存在是正常状态（还没人改过任何东西）
        cache = { at: now, mtimeMs: -1, muted: new Set(), notes: new Map(), affinity: new Map(), bonds: new Map(), error: null };
        return cache;
      }

      if (st.mtimeMs === cache.mtimeMs) {
        cache.at = now;
        return cache;
      }

      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ovs = doc?.overrides && typeof doc.overrides === 'object' ? doc.overrides : {};

      const muted = new Set();
      const notes = new Map();
      const affinity = new Map();
      const bonds = new Map();
      for (const [qq, o] of Object.entries(ovs)) {
        const k = String(qq);
        if (o?.muted === true) muted.add(k);
        if (typeof o?.note === 'string' && o.note.trim()) notes.set(k, o.note.trim());
        if (Number.isFinite(o?.affinity)) affinity.set(k, o.affinity);
        if (typeof o?.bond === 'string' && o.bond.trim()) bonds.set(k, o.bond.trim());
      }

      cache = { at: now, mtimeMs: st.mtimeMs, muted, notes, affinity, bonds, error: null };
      return cache;
    } catch (e) {
      // 解析失败：沿用上一次的结果，只记下错误
      cache = { ...cache, at: now, error: e.message };
      return cache;
    }
  };
}
