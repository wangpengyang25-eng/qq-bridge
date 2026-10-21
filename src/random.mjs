// 随机工具：掷骰子 / 从候选里抽一个 / 取随机整数
//
// 群聊里的高频刚需（谁去拿快递、今天吃什么、打个赌），纯本地、零成本。
// 用 crypto.randomInt 而不是 Math.random，避免"抽签结果总偏向某个人"的观感问题。
import crypto from 'node:crypto';

const ri = (min, max) => crypto.randomInt(min, max + 1); // 闭区间

/** 掷骰：支持 1d6 / 3d20 / 2d6+3 */
export function rollDice(expr) {
  const s = String(expr ?? '').trim();
  const m = /^(\d{0,2})\s*[dD]\s*(\d{1,4})\s*(?:([+\-])\s*(\d{1,4}))?$/.exec(s);
  if (!m) return { ok: false, error: `看不懂的骰子写法「${s}」，示例：1d6、3d20、2d6+3` };
  const n = m[1] ? Number(m[1]) : 1;
  const faces = Number(m[2]);
  if (n < 1 || n > 20) return { ok: false, error: '骰子个数请控制在 1~20' };
  if (faces < 2 || faces > 1000) return { ok: false, error: '骰子面数请控制在 2~1000' };

  const rolls = Array.from({ length: n }, () => ri(1, faces));
  const mod = m[3] ? (m[3] === '+' ? 1 : -1) * Number(m[4]) : 0;
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  const detail =
    n === 1 && !mod
      ? `${total}`
      : `${rolls.join(' + ')}${mod ? (mod > 0 ? ` + ${mod}` : ` - ${-mod}`) : ''} = ${total}`;
  return { ok: true, total, text: `🎲 ${n}d${faces}${m[3] ? m[3] + m[4] : ''}：${detail}` };
}

/** 从候选里随机抽一个 */
export function pickOne(items) {
  const list = (Array.isArray(items) ? items : []).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!list.length) return { ok: false, error: '候选列表是空的' };
  if (list.length > 50) return { ok: false, error: '候选人太多了（上限 50 个）' };
  if (list.length === 1) return { ok: true, picked: list[0], text: `就「${list[0]}」一个候选，不用抽也是它呀` };
  const idx = ri(0, list.length - 1);
  return { ok: true, picked: list[idx], text: `抽中了「${list[idx]}」（共 ${list.length} 个候选）` };
}

/** 随机整数 [min, max] */
export function randomInt(min, max) {
  const a = Number(min);
  const b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: false, error: 'min / max 需要是数字' };
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) return { ok: false, error: '只支持整数范围' };
  if (hi - lo > 1e9) return { ok: false, error: '范围太大了（上限 10 亿）' };
  const v = ri(lo, hi);
  return { ok: true, value: v, text: `${lo} ~ ${hi} 之间随机取一个：${v}` };
}

/** 统一入口：按给了哪个参数决定做什么 */
export function runRandom({ dice, items, min, max } = {}) {
  if (dice) return rollDice(dice);
  if (Array.isArray(items) && items.length) return pickOne(items);
  if (min !== undefined && min !== null && max !== undefined && max !== null) return randomInt(min, max);
  return { ok: false, error: '请给出 dice（如 1d6）、items（候选列表）或 min/max 其中之一' };
}
