// 模型 API 调用（OpenAI 兼容协议）+ 会话上下文 + 工具（联网搜索 / 本地计算）+ 图片输入
//
// 上下文策略（为 DeepSeek 前缀缓存优化）：
//   DeepSeek 对「从第 0 个 token 起的完全相同前缀」按缓存价计费（1/10 ~ 1/30），
//   所以消息数组的结构固定为：
//     [ system(人设 + 今天日期 + 早前摘要) ] + [ 历史（只追加，不改写） ] + [ 当前消息(含群聊背景) ]
//   变化的内容一律往后放，稳定的内容永远在最前面。
import { log } from './logger.mjs';
import { evaluateExpression } from './calc.mjs';
import { computeTimeDiff } from './datetime.mjs';
import { runRandom } from './random.mjs';
import { fetchPageText } from './fetchpage.mjs';

const sessions = new Map(); // key -> { messages:[{role,content}], summary:string }

/**
 * 会话标识。
 * 统一事件结构是 { scene, sceneId, userId }，不是 OneBot 原始字段。
 * （踩过：早期这里读 msg.message_type，而事件里根本没有该字段，
 *  于是所有会话都算成 private:undefined 共用一个上下文。）
 */
export function sessionKey(evt, shareGroupContext) {
  if (evt.scene === 'group') {
    return shareGroupContext ? `group:${evt.sceneId}` : `group:${evt.sceneId}:${evt.userId}`;
  }
  return `private:${evt.sceneId}`;
}

function getSession(key) {
  let s = sessions.get(key);
  if (!s) {
    s = { messages: [], summary: '' };
    sessions.set(key, s);
  }
  return s;
}

/**
 * 取这次请求要带上的上下文。
 * @returns {{summary:string, messages:Array<{role,content}>}}
 */
export function getContext(key, limit) {
  const s = sessions.get(key);
  if (!s) return { summary: '', messages: [] };
  return { summary: s.summary, messages: s.messages.slice(-limit) };
}

/** 从被丢弃的消息里抽一条「本地摘要」（不调模型，零成本）：只保留用户侧的问题要点 */
export function summarizeLocal(msgs) {
  const parts = [];
  for (const m of msgs) {
    if (m.role !== 'user') continue;
    let t = String(m.content ?? '').replace(/［图片］/g, '[图]').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (t.length > 36) t = t.slice(0, 36) + '…';
    parts.push(t);
  }
  return parts.join('；');
}

function mergeSummary(prev, add, maxChars) {
  let s = [prev, add].filter(Boolean).join('；');
  if (s.length > maxChars) s = '…' + s.slice(s.length - maxChars);
  return s;
}

/**
 * 记一条历史。超出阈值时做一次压缩：把最老的一批折叠进摘要。
 * append-only 的意义：只要不超阈值，历史内容一个字都不改动，
 * 请求前缀就一直是上一次的超集 → 前缀缓存持续命中。
 */
export function pushHistory(key, role, content, opts = {}) {
  const s = getSession(key);
  s.messages.push({ role, content });

  const keep = Number(opts.keep) || 12;
  const compactAt = Number(opts.compactAt) || keep * 2;
  const maxChars = Number(opts.maxSummaryChars) || 400;
  if (s.messages.length <= compactAt) return;

  const dropped = s.messages.splice(0, s.messages.length - keep);
  s.summary = mergeSummary(s.summary, summarizeLocal(dropped), maxChars);
  log(`[llm] 会话 ${key} 压缩历史：${dropped.length} 条并入摘要（摘要 ${s.summary.length} 字）`);
}

export function clearHistory(key) {
  const s = sessions.get(key);
  const n = s ? s.messages.length : 0;
  sessions.delete(key);
  return n;
}

export function listSessions() {
  return [...sessions.keys()];
}

/** 当前日期（只到「天」，避免每分钟变化把前缀缓存冲掉） */
const WEEK = '日一二三四五六';
export function nowDateLine(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `今天日期：${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 星期${WEEK[d.getDay()]}。`;
}

/** 当前时刻，只用于本轮消息（可变内容放最后） */
export function nowTimeTag(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 规则化的难度判定（不额外调用模型，零成本）。
 * 只用来决定「这次多用点力还是少用点力」。
 */
export function classifyDifficulty(text, images = []) {
  const t = String(text ?? '');
  let score = 0;
  if (t.length > 60) score += 1;
  if (t.length > 160) score += 1;
  if (/(为什么|为何|怎么|如何|原理|推导|证明|分析|对比|区别|方案|设计|架构|优化|重构|实现|思路|报错|异常|错误|故障|公式|解释|评估|建议)/.test(t)) score += 2;
  if (/(代码|函数|算法|接口|配置|部署|编译|语法|性能|并发|内存|协议|数据库|网络)/.test(t)) score += 1;
  if (Array.isArray(images) && images.length) score += 1;
  return score >= 2 ? 'hard' : 'easy';
}

/**
 * 搜索谓词：规则前置，模型兜底。
 *
 * 返回：
 *   'hint'  —— 问题明显具有时效性，在本轮消息尾部加一句定向提示（**不改 system**，不破坏前缀缓存）
 *   'allow' —— 不干预，交给模型自己判断（默认）
 *
 * 注意：这里**故意不做「收回搜索工具」**。工具定义属于 prompt 的稳定前缀，
 * 时给时不给会让前缀整体变化，把 DeepSeek 的前缀缓存打掉——
 * 省下的那点工具描述 token，远不够赔缓存失效的损失。
 */
export function searchPredicate(text) {
  const t = String(text ?? '').trim();
  if (!t) return 'allow';

  // 用户明确要求查
  if (/(查一下|查查|搜一下|搜下|搜索一下|帮我查|帮我搜|联网查|百度一下|谷歌一下|上网查)/.test(t)) return 'hint';

  // 「时效词 + 话题词」同时出现才判定，避免"最近好吗"这种误伤
  const fresh = /(最新|近期|最近|今天|今日|现在|目前|当前|实时|今年|本月|本周|这周)/.test(t);
  const topic =
    /(新闻|消息|价格|报价|股价|汇率|油价|金价|房价|天气|气温|比分|赛程|战绩|政策|规定|法规|通知|发布|上线|发售|上市|版本|更新|进展|动态|数据|排名|榜单|销量|票房|谁是|什么时候|几点|多少)/.test(
      t
    );
  return fresh && topic ? 'hint' : 'allow';
}

/** 提供给模型的联网搜索工具（描述保持精简：详细决策规则放在人设里，人设属稳定前缀、更划算） */
const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      '联网搜索。用于时效性信息（新闻、价格、天气、比分、政策）或你不确定、可能已过期的具体事实。' +
      '闲聊、算术、翻译、写代码、你确实掌握的常识不要用。一次回答最多搜一次，搜不到就直说。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，尽量精炼，不要写成一整句问句' },
      },
      required: ['query'],
    },
  },
};

/** 本地计算器（零 API 成本） */
const CALC_TOOL = {
  type: 'function',
  function: {
    name: 'calc',
    description:
      '精确计算数学表达式，支持 + - * / % ^ 和括号，也支持 15% 这种写法。涉及具体数字运算就用它，不要心算。',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '例如 1234*0.15 或 (88+12)/4' },
      },
      required: ['expression'],
    },
  },
};

/** 日期计算（零成本，不用联网） */
const TIME_TOOL = {
  type: 'function',
  function: {
    name: 'time_diff',
    description:
      '算两个日期相差多少天，或距离某个日期还有几天（含星期几）。纯本地计算，不要为这类问题联网。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标日期，如 2026-10-01；也接受 10-01、明天' },
        from: { type: 'string', description: '起始日期，默认今天' },
      },
      required: ['to'],
    },
  },
};

/** 随机（掷骰 / 抽一个 / 随机整数） */
const RANDOM_TOOL = {
  type: 'function',
  function: {
    name: 'random',
    description:
      '随机结果。三种用法选一种：dice 掷骰（如 "1d6"、"3d20"、"2d6+3"）；items 从候选里抽一个；min/max 取随机整数。' +
      '有人要"抽签/选一个/掷骰子/随便挑"时用它，不要自己编结果。',
    parameters: {
      type: 'object',
      properties: {
        dice: { type: 'string', description: '骰子表达式，如 1d6' },
        items: { type: 'array', items: { type: 'string' }, description: '候选列表' },
        min: { type: 'number', description: '随机整数下界' },
        max: { type: 'number', description: '随机整数上界' },
      },
    },
  },
};

/** 读网页正文 */
const FETCH_TOOL = {
  type: 'function',
  function: {
    name: 'fetch_url',
    description:
      '打开一个网页并把正文读回来。有人贴了链接让你看看、或你需要某个具体页面的内容时用。' +
      '只能读 http/https 的公网页面；读不到就说读不到，不要凭空编页面内容。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的完整链接' },
      },
      required: ['url'],
    },
  },
};

/**
 * 表情包工具。情绪清单来自当前套装，运行时生成一次、每个请求都一样，
 * 所以它仍然是稳定的前缀（缓存友好）。
 */
function buildStickerTool(moods) {
  return {
    type: 'function',
    function: {
      name: 'send_sticker',
      description:
        '发一张表情包来表达情绪。**情绪明显时才发，一次对话最多一张**，大多数回答不用发。' +
        '什么时候算明显：对方在吐槽、讲了个笑话、夸你、催你、安慰你，' +
        '或者你自己想表达得意 / 无语 / 委屈 / 震惊 / 加油。' +
        `可用的情绪（必须原样从这里面选）：${moods.join('、')}`,
      parameters: {
        type: 'object',
        properties: {
          mood: { type: 'string', description: '从上面列出的情绪里原样选一个' },
        },
        required: ['mood'],
      },
    },
  };
}

async function postChat(url, llm, body) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(llm.timeoutMs),
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? `请求超时(${llm.timeoutMs}ms)` : e.message;
    throw new Error(`模型接口不可达：${why}`);
  }

  const raw = await res.text();
  if (!res.ok) throw new Error(`模型接口返回 ${res.status}：${raw.slice(0, 300)}`);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`模型返回非 JSON：${raw.slice(0, 200)}`);
  }
  data.__elapsed = Date.now() - started;
  return data;
}

/**
 * 一次性调用：**不写会话历史、不带工具**。
 * 给"看一眼这张图是什么情绪"这类旁路任务用 —— 它不该污染聊天上下文，
 * 也不该看到群聊人设。
 */
export async function complete(cfg, messages, opts = {}) {
  const llm = cfg.llm;
  const url = llm.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: llm.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 64,
    stream: false,
  };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  const data = await postChat(url, llm, body);
  return data?.choices?.[0]?.message?.content ?? '';
}

/**
 * 调用模型，返回纯文本答案。
 * @param {object} opts
 *   opts.images      string[]  data:base64 形式的图片
 *   opts.onSearch    (query) => Promise<string>  提供则启用联网搜索工具
 *   opts.background  string    群里最近几句聊天，作为背景注入当前消息
 */
export async function chat(cfg, key, userText, userName, opts = {}) {
  const llm = cfg.llm;
  const url = llm.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const images = opts.images || [];
  const onSearch = opts.onSearch || null;
  const background = String(opts.background || '').trim();

  // 规则前置：明显带时效性的问题，给一句定向提示。
  // 提示放在**本轮消息尾部**而不是 system —— system 属稳定前缀，动它会连累整段历史的缓存。
  const predicate = cfg.search?.rules?.enabled === false ? 'allow' : searchPredicate(userText);

  const { summary, messages: history } = getContext(key, llm.historyLimit);

  // ---- 稳定前缀：人设 → 今天日期 → 早前摘要（摘要只在压缩时变化）----
  let sys = llm.systemPrompt + '\n\n' + nowDateLine();
  if (summary) sys += `\n\n【早前对话摘要】${summary}`;
  const messages = [{ role: 'system', content: sys }];
  for (const m of history) messages.push({ role: m.role, content: m.content });

  // ---- 可变内容全部放在最后：群聊背景 + 时刻 + 本轮问题 ----
  const prefix = userName ? `${userName}：` : '';
  const searchHint =
    predicate === 'hint' ? '【这条问题时效性强，回答前请先联网查证，不要凭记忆答】\n' : '';
  // 主动插话：不是被点名的回答，而是"听到群里在聊，接一句"
  const chimeHint = opts.proactive
    ? '【你不是被点名的，只是在群里听到上面这句，想接一句。一两句就够，别长篇大论，也别 @ 谁】\n'
    : '';
  const bgBlock = background ? `【群里刚才聊到（仅供参考，不必逐条回应）】\n${background}\n\n` : '';
  // 关系块：只在"和某个人说话"时有（opts.relation）。放在尾部而不是 system，
  // 因为它是按人变化的，塞进 system 会让前缀缓存每一轮都失效。
  const relBlock = opts.relation ? `${opts.relation}\n\n` : '';
  const timeTag = nowTimeTag();
  const head = `${searchHint}${chimeHint}${relBlock}${bgBlock}[${timeTag}] ${prefix}`;
  if (images.length) {
    const content = [{ type: 'text', text: head + userText }];
    for (const d of images) content.push({ type: 'image_url', image_url: { url: d } });
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: head + userText });
  }

  // ---- 工具集（顺序固定，保证前缀一致）----
  const tools = [];
  if (onSearch) tools.push(WEB_SEARCH_TOOL);
  if (cfg.calc?.enabled !== false) tools.push(CALC_TOOL);
  if (cfg.tools?.datetime !== false) tools.push(TIME_TOOL);
  if (cfg.tools?.random !== false) tools.push(RANDOM_TOOL);
  if (cfg.tools?.fetchUrl !== false) tools.push(FETCH_TOOL);
  const stickerMoods = Array.isArray(opts.stickerMoods) ? opts.stickerMoods : [];
  if (stickerMoods.length && opts.onSticker) tools.push(buildStickerTool(stickerMoods));
  const maxRounds = cfg.tools?.maxRoundsPerReply ?? cfg.search?.maxRoundsPerReply ?? 2;
  const fetchMaxChars = cfg.tools?.fetchMaxChars ?? 3000;

  // ---- 按难度决定「用多大力」（不额外调用模型）----
  const difficulty = classifyDifficulty(userText, images);
  const adaptive = llm.adaptive !== false;
  const effort = adaptive ? (difficulty === 'hard' ? llm.effortHard || llm.effort : llm.effort) : llm.effort;
  const maxTokens = adaptive
    ? difficulty === 'hard'
      ? llm.maxTokensHard || llm.maxTokens
      : llm.maxTokens
    : llm.maxTokensHard || llm.maxTokens;

  let toolRounds = 0;
  let answer = null;
  let searched = 0;
  let calced = 0;
  let fetched = 0;
  let otherTools = 0;
  // 用量累计（含前缀缓存命中/未命中），一轮里可能有多次调用，全部累加
  const usage = { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0, calls: 0 };

  while (answer === null) {
    const body = {
      model: llm.model,
      messages,
      temperature: llm.temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    if (effort) body.effort = effort;
    if (tools.length && toolRounds < maxRounds) body.tools = tools;

    const data = await postChat(url, llm, body);
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new Error('模型返回缺少 message 字段');

    // 用量：DeepSeek 会返回 prompt_cache_hit_tokens / prompt_cache_miss_tokens，
    // 有了它才能证明"前缀缓存到底有没有在命中"，而不是凭感觉说省了钱。
    const u = data?.usage;
    if (u) {
      usage.calls += 1;
      usage.prompt += Number(u.prompt_tokens) || 0;
      usage.completion += Number(u.completion_tokens) || 0;
      usage.cacheHit += Number(u.prompt_cache_hit_tokens) || 0;
      usage.cacheMiss += Number(u.prompt_cache_miss_tokens) || 0;
    }

    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (calls.length && toolRounds < maxRounds) {
      toolRounds += 1;
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });

      for (const c of calls) {
        const name = c.function?.name;
        let args = {};
        try {
          args = JSON.parse(c.function?.arguments || '{}');
        } catch {
          /* 参数解析失败就留空 */
        }
        let out;
        if (name === 'web_search') {
          const q = String(args.query ?? '');
          searched += 1;
          log(`[llm] 模型请求联网搜索：${q || '(空词)'}`);
          try {
            out = await onSearch(q);
          } catch (e) {
            out = `搜索失败：${e.message}`;
          }
        } else if (name === 'calc') {
          const expr = String(args.expression ?? '');
          calced += 1;
          const r = evaluateExpression(expr);
          log(`[llm] 本地计算：${expr} -> ${r.ok ? r.value : '失败 ' + r.error}`);
          out = r.ok ? `${expr} = ${r.value}` : `计算失败：${r.error}`;
        } else if (name === 'time_diff') {
          otherTools += 1;
          const r = computeTimeDiff({ to: args.to, from: args.from });
          log(`[llm] 日期计算：${args.from || '今天'} → ${args.to} -> ${r.ok ? r.days + ' 天' : '失败 ' + r.error}`);
          out = r.ok ? r.text : `日期计算失败：${r.error}`;
        } else if (name === 'random') {
          otherTools += 1;
          const r = runRandom(args);
          log(`[llm] 随机：${JSON.stringify(args)} -> ${r.ok ? r.text : '失败 ' + r.error}`);
          out = r.ok ? r.text : `随机失败：${r.error}`;
        } else if (name === 'fetch_url') {
          fetched += 1;
          const r = await fetchPageText(args.url, { maxChars: fetchMaxChars, timeoutMs: llm.timeoutMs });
          if (!r.ok) {
            out = `读取失败：${r.error}`;
          } else {
            out =
              `【${r.title || r.url}】\n${r.text}` +
              (r.truncated ? `\n……（原文共 ${r.fullChars} 字，已截断）` : '');
          }
        } else if (name === 'send_sticker') {
          const mood = String(args.mood ?? '');
          let r = { ok: false, error: '表情包功能不可用' };
          try {
            r = (await opts.onSticker(mood)) || r;
          } catch (e) {
            r = { ok: false, error: e.message };
          }
          log(`[llm] 表情包请求「${mood}」-> ${r.ok ? '已发 ' + r.name : '未发 ' + r.error}`);
          out = r.ok
            ? `（已发出表情包：${r.mood}。正常把你要说的话说完就行，不用再解释这张图）`
            : `（这次没发表情包：${r.error}。直接好好说话即可）`;
        } else {
          out = `（不支持的工具 ${name || '未知'}）`;
        }
        messages.push({ role: 'tool', tool_call_id: c.id, content: String(out).slice(0, 6000) });
      }
      continue;
    }

    answer = String(msg.content || '').trim();
    if (!answer) answer = '（哎呀，这次没想好怎么说，你再问一次试试？）';
    log(
      `[llm] ${llm.model} 用时 ${data.__elapsed}ms，难度 ${difficulty}(effort=${effort},max=${maxTokens})，` +
        `输入 ${userText.length} 字，输出 ${answer.length} 字` +
        `${background ? `，背景 ${background.split('\n').length} 行` : ''}` +
        `${images.length ? `，图片 ${images.length} 张` : ''}` +
        `${searched ? `，联网 ${searched} 次` : ''}${calced ? `，计算 ${calced} 次` : ''}` +
        `${fetched ? `，读网页 ${fetched} 次` : ''}${otherTools ? `，其它工具 ${otherTools} 次` : ''}` +
        `${predicate === 'hint' ? '，已给时效提示' : ''}` +
        `${opts.proactive ? '，主动插话' : ''}` +
        (usage.calls
          ? `｜用量 输入 ${usage.prompt}（缓存命中 ${usage.cacheHit}/${usage.prompt}，${usage.prompt ? Math.round((usage.cacheHit / usage.prompt) * 100) : 0}%），输出 ${usage.completion}，调用 ${usage.calls} 次`
          : '')
    );
    if (typeof opts.onUsage === 'function') {
      try {
        opts.onUsage(usage);
      } catch {
        /* 统计失败不影响主流程 */
      }
    }
  }

  // 历史只存文本版本（不含群聊背景，避免每轮重复累加），也不含图片本体
  pushHistory(key, 'user', prefix + userText + (images.length ? '［图片］' : ''), {
    keep: llm.historyLimit,
    compactAt: llm.historyCompactAt,
    maxSummaryChars: llm.summaryMaxChars,
  });
  pushHistory(key, 'assistant', answer, {
    keep: llm.historyLimit,
    compactAt: llm.historyCompactAt,
    maxSummaryChars: llm.summaryMaxChars,
  });

  return answer;
}
