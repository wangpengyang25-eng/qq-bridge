// 配置：所有可调参数集中在此处默认值 + config.json
// 改参数只改 config.json，不要改这个文件，除非要调整默认值
import fs from 'node:fs';
import path from 'node:path';
// 主动发起的默认值放在引擎自己那里，这里只引用，避免两处各写一份会漂移
import { DEFAULTS as INITIATIVE_DEFAULTS } from './initiative.mjs';

export const DEFAULTS = {
  // ---- 接入通道：onebot = NapCat / OneBot v11 正向 WebSocket ----
  // （QQ 官方机器人通道已废弃：个人开发者拿不到群聊场景权限，见 HANDOFF.md）
  transport: 'onebot',

  // ---- NapCat / OneBot ----
  onebot: {
    wsUrl: 'ws://127.0.0.1:3001', // NapCat 里新建的「WebSocket 服务端」地址
    accessToken: '',
    reconnectBaseMs: 1000,
    reconnectMaxMs: 60000,
  },

  // ---- 权限与范围 ----
  bot: {
    admins: [],             // 管理员 QQ 号。留空则「第一个私聊机器人的人」自动绑定并落盘
    allowedGroups: [],      // 允许响应的群号；留空 = 全部群
    replyWithQuote: true,   // 群聊里引用原消息后回复
  },

  // ---- 工作模式 ----
  mode: {
    enabledOnStart: true,   // 启动时是否默认「接入」。false 则等管理员发 /on
    requireAt: true,        // 仅回答模式：群里必须 @ 机器人才响应
    groupShareContext: true,// 同群共享一段对话上下文
    // 连续对话：一个人跟她聊起来之后，短时间内不 @ 也能接着说。
    // 只要有人插话就立刻结束 —— 不然"谁说话都当在问自己"。
    followUp: {
      enabled: true,
      windowMs: 180000,     // 上一次回答后多久内还算"接着聊"
    },
  },

  // ---- 模型 API（OpenAI 兼容） ----
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',                                  // 必填，否则无法回答
    model: 'deepseek-flash',                     // DeepSeek V4 系列：deepseek-flash / deepseek-v4-pro
    effort: 'low',                               // 简单问题的推理强度 low/high/max
    effortHard: 'high',                          // 难题的推理强度（adaptive 打开时生效）
    adaptive: true,                              // 按题目难度自动切换 effort / maxTokens
    temperature: 0.7,
    maxTokens: 400,                              // 简单问题的上限（群聊本就该短）
    maxTokensHard: 1200,                         // 难题的上限
    timeoutMs: 60000,
    historyLimit: 12,                            // 每次携带的最近历史条数
    historyCompactAt: 24,                        // 历史超过这个条数就压缩一次（append-only，见 llm.mjs）
    summaryMaxChars: 400,                        // 早前对话摘要的字数上限
    // 人设：优先读 systemPromptFile 指向的文件（便于编辑），读不到才用下面的 systemPrompt
    systemPromptFile: 'persona.txt',
    persona: '', // 默认用哪张角色卡（personas/<名字>/persona.txt）；空 = 根目录的 persona.txt
    // few-shot 示范：独立文件，可替换风格（见 fewshot/ 目录）；留空则不加载
    fewShotFile: 'fewshot/A-萌系卖萌.txt',
    systemPrompt:
      '你是「大肥鱼」，一个待在 QQ 群里的 AI 助手。' +
      '回答直接、务实：先给结论，再给必要细节；不要客套话，不要复述问题。' +
      '只回答被问到的问题，不要主动展开无关话题，也不要闲聊寒暄。' +
      '这是群聊场景，默认回答简短；只有在对方明确要详细展开时才写长。' +
      '不要使用 Markdown 表格和代码块围栏，纯文本表达。' +
      '不确定的事情直说不确定，不要编造。',
  },

  // ---- 频率限制（防刷屏、防额度被烧光） ----
  limits: {
    enabled: true,
    userCooldownMs: 10000,        // 同一人在同一会话里，两次提问的最小间隔
    sessionCooldownMs: 3000,      // 同一会话（群/私聊），两次回复的最小间隔
    maxConcurrent: 3,             // 全局同时处理的请求数上限
    hourlyLimitPerSession: 300,   // 每个会话每小时最多回答次数
    notifyOnLimit: true,          // 达到小时上限时回一句提示（冷却期则一律静默）
  },

  // ---- 联网搜索（给模型一个 web_search 工具，由它自己决定要不要用） ----
  search: {
    enabled: true,
    maxResults: 5,        // 每次搜索取几条结果喂给模型
    timeoutMs: 15000,
    cooldownMs: 15000,    // 同一会话两次搜索的最小间隔，防止被刷着搜
    maxRoundsPerReply: 2, // 单次回答里最多允许几轮工具调用（防死循环）
    rules: {
      // 规则前置：明显带时效性的问题，在本轮消息尾部加一句定向提示，
      // 提高"该搜就搜"的命中率。提示只进消息尾部，不动 system，不破坏前缀缓存。
      enabled: true,
    },
  },

  // ---- 本地工具（全部零 API 成本）----
  tools: {
    maxRoundsPerReply: 2, // 单次回答最多几轮工具调用（优先级高于 search.maxRoundsPerReply）
    datetime: true,       // time_diff：两个日期相差几天
    random: true,         // random：掷骰 / 从候选抽一个 / 随机整数
    fetchUrl: true,       // fetch_url：读网页正文（已屏蔽本机与内网地址）
    fetchMaxChars: 3000,  // 读网页时最多取多少字喂给模型
  },

  // ---- 本地计算器（零 API 成本，避免模型心算出错、也避免为算数去联网） ----
  calc: {
    enabled: true,
  },

  // ---- 图片识别 ----
  // 注意：模型只接受内联 base64，让它自己去下载 URL 会失败（实测）。
  vision: {
    enabled: true,
    maxBytes: 2097152,    // 单张图片体积上限 2MB，超过就不发（省 token）
    maxImages: 2,         // 一条消息最多处理几张图
    timeoutMs: 15000,
  },

  // ---- 群聊被动上下文（记录群里最近在聊什么，被 @ 时当背景注入） ----
  // 存储不花钱（纯内存），只有注入会产生 token 成本，故条数/字数都卡得比较紧。
  ambient: {
    enabled: true,
    smartInject: true,    // 按需注入：有指代/承接信号才带背景，省 token。false = 每次 @ 都带
    maxKeep: 30,          // 每群最多记多少条（环形缓冲）
    injectItems: 8,       // 注入时最多取几条
    injectMaxChars: 500,  // 注入文本的总字数上限
    minLen: 2,            // 短于这个长度的消息不收
  },

  // ---- 表情包（本地图片，按「情绪名」发送，零 API 成本）----
  // 目录结构：stickers/<套装>/<情绪>.png，例如 stickers/04-线条狗/加油.gif
  // 挑套装：用浏览器打开 stickers/预览.html 看图，再把目录名填进 activeSet
  //
  // 关于频率：**刻意不做代码层节流**。
  // "一次对话最多一张"由人设约束，且同一次回答里只会发出一张（后一次请求会覆盖前一次）；
  // 再加冷却/上限会让它在该发的时候发不出来，反而更别扭。
  stickers: {
    enabled: true,
    dir: 'stickers',         // 相对 config.json 所在目录
    activeSet: '04-线条狗',  // 用哪一套（目录名）
    maxMoods: 60,            // 工具描述里最多列几个情绪名
    position: 'after',       // after = 先文字后表情；before = 先表情后文字

    // ---- 读群友的表情包 ----
    // 群友发表情包时，机器人默认只知道"有张图"，不知道是什么。开了这里才会去识别。
    // 识别结果按图片哈希缓存（data/sticker-cache.json），同一张图只花一次钱。
    reply: {
      enabled: false,          // ★ 默认关：会产生视觉调用，也意味着主动回图
      onlyAfterBotSpoke: true, // 只在"机器人刚说过话"之后接梗，不胡乱回所有人的图
      withinMs: 120000,        // "刚说过话"的窗口
      cooldownMs: 300000,      // 同一个群两次回图的最小间隔
      dailyLimit: 20,          // 每天最多回几张
      visionTimeoutMs: 12000,  // 识别超时就放弃（宁可这次不回）
      // 识别用的输出预算。推理型模型（deepseek 这类）会先烧 reasoning token，
      // 预算给小了 content 直接是空字符串，看起来像"模型不支持图片"。
      maxTokens: 400,
      // 回图时顺带说一句话（更像个活人，但每次都是一次模型调用）
      replyWithText: true,
      // 群里回应时要不要 @ 对方。表情包本身很难带 @，所以 @ 放在文字上，
      // 图片那条靠"引用"表明是回给谁的。
      atUser: true,
    },
    cacheFile: 'data/sticker-cache.json', // 识别缓存（相对 config.json 所在目录）
  },

  // ---- 主动插话（不被 @ 时偶尔接一句，像群友那样）----
  // 默认**关闭**。开着时每插一次就是一次模型调用，所以闸门全放在规则侧。
  // 运行时可用管理员私聊 /chime on|off 切换（写进 state.json，优先级高于这里）
  proactive: {
    enabled: false,
    names: [],             // 触发词：提到这些名字但没 @ 时考虑插话。留空 = 机器人昵称 + 大肥鱼
    onQuestion: false,     // 放宽到"有人在征求意见"也触发（这种才要求群里够热闹）
    onImage: false,        // 放宽到"有人发了图/表情包"也触发
    minIntervalMs: 600000, // 同一个群两次插话的最小间隔（默认 10 分钟）
    dailyLimit: 20,        // 每天最多插几次
    windowMs: 180000,      // 判断"群里够不够热闹"的观察窗口
    minActivity: 3,        // 窗口内至少要有几条有内容的消息

    // ---- 主动发起谈话（定时器驱动，没人说话也会开口）----
    // 和上面这些"有消息时顺便接一句"是两套东西，默认全关。
    // 调度与闸门的默认值在 src/initiative.mjs 的 DEFAULTS 里，这里只放覆盖项。
    initiative: {
      ...INITIATIVE_DEFAULTS,
    },
  },

  // ---- 成员档案（群友的关系状态层）----
  // 记录每个群友说过多少话、被 @ 过几次、亲密度多少，落在 data/members.json。
  // 纯内存计数 + 定时落盘，不产生任何 API 成本。
  // 面板（webui/）读这个文件；人工编辑走它自己的 data/overrides.json，互不覆盖。
  members: {
    enabled: true,
    file: 'data/members.json', // 相对 config.json 所在目录
    overridesFile: 'data/overrides.json', // 面板写的人工编辑（bridge 只读，用于尊重静音）
    flushMs: 60000,            // 多久落盘一次（有改动才写）
    maxMembers: 500,           // 上限，防止文件无限增长
  },

  // ---- 输出 ----
  // 群聊回复默认只发一条：分多条很吵，只有真有一肚子话时才值得连发。
  // 每段会被拆成单独的消息，所以这个数字直接决定"她一次说几条"。
  output: {
    maxCharsPerMessage: 900,
    maxPartsGroup: 2,     // 群聊最多分几条（默认 2，够一次补充说明；再多就刷屏）
    maxPartsPrivate: 2,
  },

  logFile: 'logs/bridge.log',
  stateFile: 'state.json',
  // 面板写的运行时开关（主动发起 / 表情包回应）。缺省则跟随上面的配置。
  controlFile: 'data/control.json',
  // bridge 定期写出的运行状态，供面板只读展示
  runtimeFile: 'data/runtime.json',
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并：defaults 为底，over 覆盖；数组整体替换 */
function merge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(base?.[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(file) {
  let user = {};
  if (fs.existsSync(file)) {
    try {
      // 去掉 BOM：记事本 / PowerShell 保存 UTF-8 时会加 \uFEFF，
      // 而 JSON.parse 不认它，报错信息还很难懂（Unexpected token ''）。
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      user = JSON.parse(raw);
    } catch (e) {
      throw new Error(`config.json 解析失败：${e.message}`);
    }
  }
  const cfg = merge(DEFAULTS, user);

  // 归一化：标识统一成字符串，避免 JSON 里写成数字导致比较失败
  cfg.bot.admins = (cfg.bot.admins || []).map((x) => String(x).trim()).filter(Boolean);
  cfg.bot.allowedGroups = (cfg.bot.allowedGroups || []).map((x) => String(x).trim()).filter(Boolean);

  // 相对路径基于配置文件所在目录解析
  const dir = path.dirname(path.resolve(file));
  cfg.__dir = dir;
  cfg.__configPath = path.resolve(file);
  cfg.logFile = path.resolve(dir, cfg.logFile);
  cfg.stateFile = path.resolve(dir, cfg.stateFile);
  if (cfg.members?.file) cfg.members.file = path.resolve(dir, cfg.members.file);
  if (cfg.members?.overridesFile) cfg.members.overridesFile = path.resolve(dir, cfg.members.overridesFile);
  if (cfg.controlFile) cfg.controlFile = path.resolve(dir, cfg.controlFile);
  if (cfg.runtimeFile) cfg.runtimeFile = path.resolve(dir, cfg.runtimeFile);
  if (cfg.stickers?.cacheFile) cfg.stickers.cacheFile = path.resolve(dir, cfg.stickers.cacheFile);

  // 人设：独立文件优先，便于随时改而不动代码
  // 角色卡优先于根目录：llm.persona 指向 personas/<名字>/
  cfg.__personaSource = 'config.json 的 llm.systemPrompt';
  const cardName = cfg.llm.persona;
  const promptBase = cardName ? path.resolve(dir, 'personas', cardName) : dir;
  if (cfg.llm.systemPromptFile) {
    const p = path.resolve(promptBase, cfg.llm.systemPromptFile);
    if (fs.existsSync(p)) {
      try {
        const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
        if (text) {
          cfg.llm.systemPrompt = text;
          cfg.__personaSource = cardName ? `personas/${cardName}/${cfg.llm.systemPromptFile}` : cfg.llm.systemPromptFile;
        }
      } catch (e) {
        cfg.__personaError = `读取失败：${e.message}`;
      }
    } else {
      cfg.__personaError = `找不到文件 ${p}`;
    }
  }

  // 角色卡自带的示范优先于全局 fewShotFile（换了角色不该沿用上一个的口吻）
  if (cardName) {
    const cardFewshot = path.resolve(promptBase, 'fewshot.txt');
    if (fs.existsSync(cardFewshot)) cfg.llm.fewShotFile = cardFewshot;
  }

  // few-shot 示范：追加在人设之后（两份都生效，不需要二选一）
  cfg.__fewShotSource = '';
  if (cfg.llm.fewShotFile) {
    const p = path.resolve(dir, cfg.llm.fewShotFile);
    if (fs.existsSync(p)) {
      try {
        const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
        if (text) {
          cfg.llm.systemPrompt = `${cfg.llm.systemPrompt}\n\n${text}`;
          cfg.__fewShotSource = cfg.llm.fewShotFile;
        } else {
          cfg.__fewShotError = `${cfg.llm.fewShotFile} 是空文件`;
        }
      } catch (e) {
        cfg.__fewShotError = `读取失败：${e.message}`;
      }
    } else {
      cfg.__fewShotError = `找不到文件 ${p}`;
    }
  }

  return cfg;
}

/** 启动前的配置体检，返回问题清单（空数组表示没问题） */
export function validateConfig(cfg) {
  const problems = [];
  if (cfg.transport !== 'onebot') {
    problems.push(`transport 目前只支持 'onebot'，当前为 '${cfg.transport}'`);
  }
  if (!/^wss?:\/\//i.test(cfg.onebot.wsUrl)) problems.push('onebot.wsUrl 必须是 ws:// 或 wss:// 开头');
  if (!cfg.llm.apiKey) problems.push('llm.apiKey 为空 —— 机器人连上后无法回答，请填入模型 API Key');
  if (!cfg.llm.baseUrl) problems.push('llm.baseUrl 为空');
  if (!cfg.llm.model) problems.push('llm.model 为空');
  // 管理员相关的提示不放在这里：config.bot.admins 为空不代表没有管理员，
  // 首个私聊者会自动绑定并存进 state.json，这里看不到那个文件。
  // 准确的提示由 bridge.mjs 在读取 state 之后打印。
  return problems;
}
