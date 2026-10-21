// 文本处理：Markdown 转 QQ 友好的纯文本、长消息分片
// QQ 客户端不渲染 Markdown，Markdown 标记会原样显示成符号，必须先清洗

/**
 * 将模型输出的 Markdown 转成适合 QQ 显示的纯文本。
 * 只做去除标记，不改编内容语义。
 */
export function markdownToPlain(md) {
  if (!md) return '';
  let s = String(md);

  // 代码块围栏：保留内部文字，去掉 ``` 行
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?/g, '');
  // 行内代码
  s = s.replace(/`([^`]+)`/g, '$1');
  // 图片 ![alt](url) -> url
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$2');
  // 链接 [text](url) -> text (url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // 加粗 / 斜体 / 删除线
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
  s = s.replace(/___(.+?)___/g, '$1');
  s = s.replace(/__(.+?)__/g, '$1');
  s = s.replace(/~~(.+?)~~/g, '$1');
  // 标题符号
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  // 引用符号
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  // 无序列表符号（保留缩进层级）
  s = s.replace(/^(\s*)[-*+]\s+/gm, '$1· ');
  // 有序列表保持原样即可
  // 分隔线
  s = s.replace(/^\s{0,3}([-*_])\s*\1\s*\1[\s\S]*?$/gm, '');
  // 表格分隔行 |---|---|
  s = s.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '');
  // 表格竖线转空格
  s = s.replace(/^\s*\|(.+)\|\s*$/gm, (m, inner) =>
    inner.split('|').map((c) => c.trim()).filter(Boolean).join('  ')
  );

  // 收敛连续空行
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 纯按长度切（尽量在换行/句号处断开，避免把句子劈成两半） */
function sliceByLength(s, maxChars) {
  const parts = [];
  let rest = String(s ?? '').trim();
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = -1;
    for (const sep of ['\n\n', '\n', '。', '！', '？', '；', '. ', '; ']) {
      const i = window.lastIndexOf(sep);
      if (i > maxChars * 0.5) {
        cut = i + sep.length;
        break;
      }
    }
    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

/**
 * 分片。
 *
 * **一段 = 一条消息**：模型被要求"要分点就分成两三小段、段间空一行"，
 * 于是空行就是它自己划的"分条"意图，照发出去才像人连着发几条。
 * 只有单段本身超长时才退化成按长度切。
 *
 * maxParts 是条数上限（群 5 / 私聊 4，防刷屏）。超出时前面几段仍各自成条，
 * 剩下的并进最后一条；实在放不下才截断并加说明。
 */
export function splitMessage(text, maxChars = 900, maxParts = 0) {
  const s = String(text ?? '').trim();
  if (!s) return [];

  const blocks = s
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const parts = [];
  for (const b of blocks) {
    if (b.length <= maxChars) parts.push(b);
    else parts.push(...sliceByLength(b, maxChars));
  }

  if (maxParts <= 0 || parts.length <= maxParts) return parts;

  const kept = parts.slice(0, maxParts - 1);
  const tail = parts.slice(maxParts - 1).join('\n\n');
  if (tail.length <= maxChars) {
    kept.push(tail);
  } else {
    kept.push(tail.slice(0, Math.max(0, maxChars - 20)).trim() + '\n……（内容较长，已截断）');
  }
  return kept;
}

/** 从 CQ 字符串里剥掉所有 CQ 码，得到纯文本 */
export function stripCqCode(raw) {
  return String(raw ?? '').replace(/\[CQ:[^\]]*\]/g, '').trim();
}
