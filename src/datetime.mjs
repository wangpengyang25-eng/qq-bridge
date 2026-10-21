// 日期计算：两个日期差几天 / 距离某个日期还有几天
//
// 为什么单独做一个：日期注入只让模型知道"今天几号"，
// 但"离 10 月 1 日还有几天""这两个日期相差多少天"仍需要真的算。
// 纯本地计算，零 API 成本，也不用联网。

const WEEK = '日一二三四五六';
const pad = (n) => String(n).padStart(2, '0');

export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function describeDate(d) {
  return `${ymd(d)} 星期${WEEK[d.getDay()]}`;
}

function mk(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  // 挡掉 2026-02-30 这类不存在的日期（Date 会自动进位）
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/** 宽松解析：2026-10-01 / 2026/10/1 / 2026年10月1日 / 10-01 / 10月1号 / 今天 明天 后天 昨天 */
export function parseDateLoose(input, now = new Date()) {
  if (input === undefined || input === null || input === '') return null;
  let s = String(input).trim();
  if (/^今天$|^今日$/.test(s)) return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (/^明天$|^明日$/.test(s)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (/^后天$/.test(s)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  if (/^昨天$|^昨日$/.test(s)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (/^大后天$/.test(s)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3);

  s = s
    .replace(/[年月]/g, '-')
    .replace(/[日号]/g, '')
    .replace(/[/.]/g, '-')
    .replace(/-+$/g, '')
    .trim();

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return mk(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return mk(now.getFullYear(), +m[1], +m[2]);
  m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) return mk(+m[1], +m[2], 1);
  return null;
}

/** 按自然日计算相差天数（忽略时分秒） */
export function dayDiff(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / 86400000);
}

/**
 * @returns {{ok:true, days:number, text:string} | {ok:false, error:string}}
 */
export function computeTimeDiff({ to, from } = {}, now = new Date()) {
  if (!to) return { ok: false, error: '需要给出目标日期 to，例如 2026-10-01 或 10-01' };
  const T = parseDateLoose(to, now);
  if (!T) return { ok: false, error: `看不懂的日期「${to}」，请用 2026-10-01 / 10-01 这种写法` };
  const F = from ? parseDateLoose(from, now) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!F) return { ok: false, error: `看不懂的日期「${from}」` };
  const days = dayDiff(F, T);
  const abs = Math.abs(days);
  const rel = days === 0 ? '就是同一天' : days > 0 ? `还有 ${abs} 天` : `已经过去 ${abs} 天`;
  return {
    ok: true,
    days,
    text: `${describeDate(F)} → ${describeDate(T)}：相差 ${abs} 天（${rel}）`,
  };
}
