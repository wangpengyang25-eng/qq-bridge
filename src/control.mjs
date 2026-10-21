// 读面板写的"运行时设置"（data/control.json）
//
// 为什么单独一个文件而不是让面板改 config.json：
// 1. config.json 里有 API Key，让面板写它风险太大；
// 2. 面板和 bridge 同时写同一个文件迟早互相覆盖（这条规矩从 members/overrides 就定下了）。
//
// 这里只放"运行中想立刻改、且改了就该马上生效"的设置：
// 开关、频率、额度、免打扰时段。模型/人设/密钥这类初始化参数仍然只在 config.json。
//
// 任何字段缺失 = 跟随 config.json；写 false / 0 也表示"显式设成这个值"。

import fs from 'node:fs';

/** 每个可调参数的校验规则：类型 + 合理范围。范围卡死了，面板上就不会调出离谱的数。 */
export const SCHEMA = {
  // 全局紧急开关
  global: {
    paused: { type: 'bool' }, // true = 完全闭嘴（不回答、不回图、不主动）
    allowedGroups: { type: 'list' }, // 覆盖 config 的群白名单；空数组 = 所有群
  },
  sticker: {
    enabled: { type: 'bool' },
    cooldownSec: { type: 'int', min: 0, max: 86400 },
    dailyLimit: { type: 'int', min: 0, max: 200 },
    onlyAfterBotSpoke: { type: 'bool' },
    withinSec: { type: 'int', min: 0, max: 86400 },
    replyWithText: { type: 'bool' },
    atUser: { type: 'bool' },
    activeSet: { type: 'text' }, // 用哪一套表情（stickers/ 下的目录名）
  },
  persona: {
    fewshot: { type: 'text' }, // 用哪一份示范（fewshot/ 下的文件名）；空 = 不启用
  },
  initiative: {
    enabled: { type: 'bool' },
    dailyLimit: { type: 'int', min: 0, max: 100 },
    quietStart: { type: 'int', min: 0, max: 23 },
    quietEnd: { type: 'int', min: 0, max: 24 },
  },
  chime: {
    enabled: { type: 'bool' },
    quietAfterMin: { type: 'int', min: 1, max: 1440 },
    staleAfterMin: { type: 'int', min: 1, max: 1440 },
    cooldownMin: { type: 'int', min: 0, max: 1440 },
    minActivity: { type: 'int', min: 1, max: 50 },
  },
  callout: {
    enabled: { type: 'bool' },
    minAffinity: { type: 'int', min: 0, max: 100 },
    minMessages: { type: 'int', min: 1, max: 1000 },
    perUserCooldownDays: { type: 'int', min: 0, max: 365 },
    cooldownMin: { type: 'int', min: 0, max: 1440 },
  },
  interject: {
    enabled: { type: 'bool' },
    onImage: { type: 'bool' },
    onQuestion: { type: 'bool' },
    cooldownSec: { type: 'int', min: 0, max: 86400 },
    dailyLimit: { type: 'int', min: 0, max: 1000 },
  },
};

function clamp(v, { type, min, max }) {
  if (type === 'bool') return typeof v === 'boolean' ? v : undefined;
  if (type === 'text') {
    if (typeof v !== 'string') return undefined;
    return v.trim().slice(0, 200);
  }
  if (type === 'list') {
    if (!Array.isArray(v)) return undefined;
    return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 200);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const i = Math.round(n);
  if (min !== undefined && i < min) return min;
  if (max !== undefined && i > max) return max;
  return i;
}

/** 把任意输入清洗成 { 分组: { 字段: 值 } }，只保留 schema 里有的 */
export function normalize(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const [group, fields] of Object.entries(SCHEMA)) {
    const g = src[group];
    if (!g || typeof g !== 'object') continue;
    const picked = {};
    for (const [k, rule] of Object.entries(fields)) {
      if (!(k in g)) continue;
      const v = clamp(g[k], rule);
      if (v !== undefined) picked[k] = v;
    }
    if (Object.keys(picked).length) out[group] = picked;
  }
  return out;
}

export function createControlReader(file, { ttlMs = 2000 } = {}) {
  let cache = { at: 0, mtimeMs: -1, values: {}, error: null };

  return function readControl(now = Date.now()) {
    try {
      if (now - cache.at < ttlMs) return cache;

      let st = null;
      try {
        st = fs.statSync(file);
      } catch {
        cache = { at: now, mtimeMs: -1, values: {}, error: null };
        return cache;
      }
      if (st.mtimeMs === cache.mtimeMs) {
        cache.at = now;
        return cache;
      }

      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = { at: now, mtimeMs: st.mtimeMs, values: normalize(doc?.control), error: null };
      return cache;
    } catch (e) {
      // 坏了就沿用上一次，别因为编辑器临时占用把设置全清空
      cache = { ...cache, at: now, error: e.message };
      return cache;
    }
  };
}
