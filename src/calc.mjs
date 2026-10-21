// 本地计算器：给模型一个 calc 工具，把算术交给程序做
//
// 为什么：模型心算长数字/百分比容易错，而且常为了「算个数」去联网搜一轮
// （多一次搜索 + 一轮模型调用）。本地算，零 API 成本、结果确定。
//
// 只接受数字与 + - * / % ^ ( )，不 eval 字符串，避免任何注入面。

/** 把中文/全角符号归一化，并把 "15%" 转成 "(15/100)" */
function normalize(input) {
  let s = String(input ?? '');
  s = s
    .replace(/[，,]/g, '')
    .replace(/×|✕|✖/g, '*')
    .replace(/÷/g, '/')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[－—–]/g, '-')
    .replace(/[＋]/g, '+')
    .replace(/\s+/g, '');
  // 百分号：紧跟在数字后面的 % 视为「百分之」，其余保留为取余
  s = s.replace(/(\d+(?:\.\d+)?)%/g, '($1/100)');
  return s;
}

/**
 * 计算表达式。
 * @returns {{ok:true, value:number} | {ok:false, error:string}}
 */
export function evaluateExpression(input) {
  const s = normalize(input);
  if (!s) return { ok: false, error: '表达式为空' };
  if (s.length > 200) return { ok: false, error: '表达式过长' };
  if (!/^[0-9+\-*/%^().]+$/.test(s)) {
    return { ok: false, error: '只支持数字与 + - * / % ^ ( )' };
  }

  let i = 0;
  const fail = (m) => {
    throw new Error(m);
  };

  function parseExpr() {
    let v = parseTerm();
    for (;;) {
      const c = s[i];
      if (c === '+' || c === '-') {
        i += 1;
        const r = parseTerm();
        v = c === '+' ? v + r : v - r;
      } else return v;
    }
  }
  function parseTerm() {
    let v = parsePower();
    for (;;) {
      const c = s[i];
      if (c === '*' || c === '/' || c === '%') {
        i += 1;
        const r = parsePower();
        if (c === '*') v *= r;
        else if (c === '/') {
          if (r === 0) fail('除数不能为 0');
          v /= r;
        } else {
          if (r === 0) fail('取余的除数不能为 0');
          v %= r;
        }
      } else return v;
    }
  }
  function parsePower() {
    const base = parseUnary();
    if (s[i] === '^') {
      i += 1;
      return Math.pow(base, parsePower());
    }
    return base;
  }
  function parseUnary() {
    if (s[i] === '-') {
      i += 1;
      return -parseUnary();
    }
    if (s[i] === '+') {
      i += 1;
      return parseUnary();
    }
    return parsePrimary();
  }
  function parsePrimary() {
    if (s[i] === '(') {
      i += 1;
      const v = parseExpr();
      if (s[i] !== ')') fail('括号不匹配');
      i += 1;
      return v;
    }
    const m = /^\d*\.?\d+/.exec(s.slice(i));
    if (!m) fail(`无法解析：${s.slice(i, i + 8) || '(空白)'}`);
    i += m[0].length;
    return Number(m[0]);
  }

  try {
    const v = parseExpr();
    if (i < s.length) return { ok: false, error: `多余的字符：${s.slice(i, i + 8)}` };
    if (!Number.isFinite(v)) return { ok: false, error: '结果不是有限数' };
    // 去掉浮点误差尾巴（0.1+0.2 -> 0.3）
    const rounded = Number(v.toPrecision(12));
    return { ok: true, value: rounded };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
