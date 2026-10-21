// 消息路由：谁的消息要回、能不能回、回什么
// 安全边界：群聊只走「纯问答」——只调模型 API，绝不触碰本机文件与命令。
//
// 统一事件结构（由各适配器产出）：
//   { scene:'group'|'private', sceneId, userId, userName, text, messageId, isAtMe, raw }
// 其中 sceneId：群聊 = group_openid/群号；私聊 = user_openid/QQ 号
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.mjs';
import { markdownToPlain, splitMessage } from './text.mjs';
import { chat, sessionKey, clearHistory, listSessions } from './llm.mjs';
import { collectImages } from './vision.mjs';
import { webSearch, formatResults } from './search.mjs';
import { AmbientBuffer, needBackground } from './ambient.mjs';
import { StickerLibrary } from './stickers.mjs';

/** 接入开关 + 管理员绑定，落盘持久化，重启后保持上次状态 */
export class StateStore {
  constructor(file, defaultEnabled) {
    this.file = file;
    this.enabled = defaultEnabled;
    this.boundAdmins = [];
    this.proactive = null; // 主动插话：null = 跟随 config.json；true/false = 管理员显式设定
    this.load();
  }
  load() {
    try {
      if (fs.existsSync(this.file)) {
        const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (typeof j.enabled === 'boolean') this.enabled = j.enabled;
        if (Array.isArray(j.boundAdmins)) this.boundAdmins = j.boundAdmins.map(String);
        if (typeof j.proactive === 'boolean') this.proactive = j.proactive;
      }
    } catch (e) {
      log(`[state] 读取状态失败，使用默认值：${e.message}`);
    }
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        this.file,
        JSON.stringify(
          {
            enabled: this.enabled,
            boundAdmins: this.boundAdmins,
            proactive: this.proactive,
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        )
      );
    } catch (e) {
      log(`[state] 写入状态失败：${e.message}`);
    }
  }
  set(v) {
    if (this.enabled === v) return false;
    this.enabled = v;
    this.save();
    return true;
  }
  /** 主动插话开关：null 表示恢复"跟随 config.json" */
  setProactive(v) {
    if (this.proactive === v) return false;
    this.proactive = v;
    this.save();
    return true;
  }
}

export class Router {
  /**
   * @param {object} cfg
   * @param {{transportName:string, selfId:string, botName:string, sendGroup:Function, sendPrivate:Function}} bot
   * @param {StateStore} state
   */
  constructor(cfg, bot, state) {
    this.cfg = cfg;
    this.bot = bot;
    this.state = state;
    this.seen = new Set();
    this.seenOrder = [];
    this.busy = new Set();       // 按会话防请求堆叠
    this.groupSeen = new Set();  // 记录见过的群，便于 /status 展示
    // ---- 频率限制状态 ----
    this.processing = 0;          // 全局正在处理的请求数
    this.lastUser = new Map();    // 用户级冷却时间戳
    this.lastSession = new Map(); // 会话级冷却时间戳
    this.hourly = new Map();      // 会话级小时计数 {start, count}
    this.lastSearch = new Map();  // 会话级搜索冷却时间戳
    this.ambient = new AmbientBuffer(cfg.ambient || {}); // 群聊被动上下文
    // 表情包库：目录相对 config.json 解析
    this.stickers = new StickerLibrary(
      cfg.stickers || {},
      path.resolve(cfg.__dir || '.', cfg.stickers?.dir || 'stickers')
    );
    this.stats = {
      limited: 0,
      answered: 0,
      errors: 0,
      searched: 0,
      withBg: 0,
      bgSkipped: 0, // 因"这条不需要背景"而省下的注入次数
      stickers: 0,
      chime: 0, // 主动插话次数
      tokens: { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0, calls: 0 },
    };
    // ---- 主动插话的节流状态 ----
    this.chime = { lastAt: new Map(), day: '', dayCount: 0 };
  }

  // ---------- 频率限制 ----------
  /**
   * 判定是否放行。silent=true 表示静默忽略（连提示都不回，避免刷屏更凶）。
   * 私聊（仅管理员）不走这里，管理员自己用不需要节流。
   */
  checkLimit(evt, key) {
    const L = this.cfg.limits;
    if (!L || !L.enabled) return { ok: true };
    const now = Date.now();

    if (this.processing >= L.maxConcurrent) {
      return { ok: false, silent: true, why: `全局并发已达上限 ${L.maxConcurrent}` };
    }

    const ukey = `${evt.scene}:${evt.sceneId}:${evt.userId}`;
    const lastU = this.lastUser.get(ukey) || 0;
    if (now - lastU < L.userCooldownMs) {
      const left = Math.ceil((L.userCooldownMs - (now - lastU)) / 1000);
      return { ok: false, silent: true, why: `同一用户冷却中，还需 ${left} 秒` };
    }

    const lastS = this.lastSession.get(key) || 0;
    if (now - lastS < L.sessionCooldownMs) {
      return { ok: false, silent: true, why: '同一会话冷却中' };
    }

    const h = this.hourly.get(key);
    if (h && now - h.start < 3600000 && h.count >= L.hourlyLimitPerSession) {
      return {
        ok: false,
        silent: !L.notifyOnLimit,
        why: `本会话已达每小时上限 ${L.hourlyLimitPerSession} 次`,
      };
    }
    return { ok: true };
  }

  /** 记录一次已放行的请求，占用配额 */
  markUsed(evt, key) {
    const L = this.cfg.limits;
    if (!L || !L.enabled) return;
    const now = Date.now();
    this.lastUser.set(`${evt.scene}:${evt.sceneId}:${evt.userId}`, now);
    this.lastSession.set(key, now);
    let h = this.hourly.get(key);
    if (!h || now - h.start >= 3600000) {
      h = { start: now, count: 0 };
      this.hourly.set(key, h);
    }
    h.count += 1;
  }

  /** 是否管理员：config 指定优先；config 留空则用自动绑定的 openid */
  isAdmin(userId) {
    const id = String(userId);
    const cfgAdmins = this.cfg.bot.admins;
    if (cfgAdmins.length) return cfgAdmins.includes(id);
    return this.state.boundAdmins.includes(id);
  }

  /** 首次私聊自动绑定（仅在 config 未指定管理员、且尚未绑定任何人的时候生效） */
  tryBind(userId) {
    if (this.cfg.bot.admins.length) return false;
    if (this.state.boundAdmins.length) return false;
    this.state.boundAdmins.push(String(userId));
    this.state.save();
    return true;
  }

  isDup(messageId) {
    if (messageId === undefined || messageId === null) return false;
    const k = String(messageId);
    if (this.seen.has(k)) return true;
    this.seen.add(k);
    this.seenOrder.push(k);
    if (this.seenOrder.length > 800) this.seen.delete(this.seenOrder.shift());
    return false;
  }

  /** 入口 */
  async handle(evt) {
    if (this.isDup(evt.messageId)) {
      log(`[router] 重复消息已跳过 id=${evt.messageId}`);
      return;
    }
    if (evt.scene === 'group') {
      this.groupSeen.add(String(evt.sceneId));
      return this.handleGroup(evt);
    }
    return this.handlePrivate(evt);
  }

  // ---------- 私聊：仅管理员，兼作控制台 ----------
  async handlePrivate(evt) {
    const userId = String(evt.userId);

    if (!this.isAdmin(userId)) {
      if (this.tryBind(userId)) {
        log(`[router] 已把 ${userId} 绑定为管理员（首个私聊者）`);
        await this.bot
          .sendPrivate(evt.sceneId, {
            text:
              '已把当前账号绑定为管理员并写入 state.json。\n' +
              `你的 openid：${userId}\n\n` +
              '可用指令：\n/on 接入  /off 断开  /status 状态  /id 查看标识  /clear 清空上下文  /ctx 看群聊背景  /sticker 表情包  /chime 主动插话',
            replyToId: evt.messageId,
            seq: 1,
          })
          .catch((e) => log(`[router] 绑定提示发送失败：${e.message}`));
        return;
      }
      // 非管理员私聊：静默，避免被探测出机器人存在
      log(`[router] 忽略非管理员私聊 ${userId}`);
      return;
    }

    if (evt.text.startsWith('/')) return this.runCommand(evt, evt.text);
    if (!evt.text) return;

    log(`[router] 管理员私聊问答：${evt.text.slice(0, 40)}`);
    await this.answer({
      evt,
      key: `private:${evt.sceneId}`,
      text: evt.text,
      userName: '',
      maxParts: this.cfg.output.maxPartsPrivate,
      sender: (t, seq) => this.bot.sendPrivate(evt.sceneId, { text: t, replyToId: evt.messageId, seq }),
    });
  }

  // ---------- 群聊：仅回答模式 + 总开关 + 群白名单 ----------
  async handleGroup(evt) {
    const allow = this.cfg.bot.allowedGroups;
    const inScope = !allow.length || allow.includes(String(evt.sceneId));
    const answering = evt.isAtMe !== false || !this.cfg.mode.requireAt;

    // 被动上下文：背景在**真要用时**才取（自足的问题带上纯属浪费 token），
    // 但记录是所有群消息都做的——记录只占内存，注入才花钱。
    // 取背景必须发生在 push 之前，这样背景里不含当前这一句。
    let background = '';
    if (inScope && this.ambient.enabled && answering) {
      if (!this.ambient.smartInject || needBackground(evt.text)) {
        background = this.ambient.snapshot(evt.sceneId);
      } else {
        this.stats.bgSkipped += 1;
      }
    }

    if (this.cfg.mode.requireAt && evt.isAtMe === false) {
      // 仅回答模式：这条不回答，但顺手看看要不要主动接一句
      await this.maybeChimeIn(evt, inScope);
      if (inScope && this.ambient.enabled) this.ambient.push(evt.sceneId, evt);
      return;
    }

    if (inScope && this.ambient.enabled) this.ambient.push(evt.sceneId, evt);

    if (!this.state.enabled) {
      log(`[router] 当前为断开状态，忽略群 ${evt.sceneId} 的消息（消息已收到，只是不回应）`);
      return;
    }

    if (!inScope) {
      log(`[router] 群 ${evt.sceneId} 不在白名单，忽略`);
      return;
    }

    const body = evt.text || '(空消息)';
    const key = sessionKey(evt, this.cfg.mode.groupShareContext);
    if (this.busy.has(key)) {
      log(`[router] 会话 ${key} 正在回答中，跳过本次`);
      return;
    }

    // 频率限制（群聊严格，私聊不受限）
    const lim = this.checkLimit(evt, key);
    if (!lim.ok) {
      this.stats.limited += 1;
      log(`[router] 限流拦截（群 ${evt.sceneId} / ${evt.userId}）：${lim.why}`);
      if (!lim.silent) {
        await this.bot
          .sendGroup(evt.sceneId, {
            text: '这个群这会儿问得有点多，我先缓缓，过会儿再问吧。',
            replyToId: this.cfg.bot.replyWithQuote ? evt.messageId : undefined,
            atUserId: evt.userId,
            seq: 1,
          })
          .catch(() => {});
      }
      return;
    }
    this.markUsed(evt, key);

    log(`[router] 群 ${evt.sceneId} ${evt.userName || evt.userId} 提问：${body.slice(0, 40)}`);
    if (background) {
      this.stats.withBg += 1;
      log(`[router] 已带 ${background.split('\n').length} 行群聊背景`);
    }

    let seq = 0;
    await this.answer({
      evt,
      key,
      text: body,
      userName: evt.userName,
      background,
      maxParts: this.cfg.output.maxPartsGroup,
      lockKey: key,
      // 只有第一条 @ 提问者并引用原消息。
      // 后续几条是"接着往下说的"，再带上 @ 和引用就等于连发好几次提醒，很不像人。
      sender: (t) => {
        seq += 1;
        const first = seq === 1;
        return this.bot.sendGroup(evt.sceneId, {
          text: t,
          replyToId: first && this.cfg.bot.replyWithQuote ? evt.messageId : undefined,
          atUserId: first ? evt.userId : undefined,
          seq,
        });
      },
    });
  }

  // ---------- 主动插话：不被 @ 时偶尔接一句 ----------
  //
  // 默认关闭。开着的时候也只在几道闸门同时放行时才插一次，因为**每插一次就是一次模型调用**。
  // 闸门都放在规则侧（零成本），不能"每条消息都去问模型要不要插话"。
  /** 是否启用主动插话：管理员的显式设定优先，否则跟随 config.json */
  chimeEnabled() {
    if (this.state.proactive === true || this.state.proactive === false) return this.state.proactive;
    return this.cfg.proactive?.enabled === true;
  }

  /** 触发信号：叫了她的名字但没 @（最自然的插话时机）；可选放宽到"在征求意见" */
  chimeWanted(evt) {
    const t = String(evt.text || '');
    const hasImage = Array.isArray(evt.images) && evt.images.length > 0;
    if (!t && !hasImage) return false;
    const p = this.cfg.proactive || {};
    const names = (Array.isArray(p.names) && p.names.length ? p.names : [this.bot.botName, '大肥鱼'])
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    if (names.some((n) => t.includes(n))) return true;
    if (p.onQuestion && /(有没有人|谁懂|求推荐|求建议|大家觉得|你们觉得)/.test(t)) return true;
    // 群友发了表情包/图片但没 @、没叫名字：自然地看到并接一句
    if (p.onImage && hasImage) return true;
    return false;
  }

  /** 群里这会儿够不够热闹（太冷的时候除非点名，否则别硬插话） */
  chimeActive(evt) {
    const p = this.cfg.proactive || {};
    const n = this.ambient.recent(evt.sceneId, p.windowMs ?? 180000);
    return n >= (p.minActivity ?? 3);
  }

  async maybeChimeIn(evt, inScope) {
    const p = this.cfg.proactive || {};
    if (!this.chimeEnabled()) return;
    if (!this.state.enabled || !inScope) return;
    if (!this.chimeWanted(evt)) return;

    // 命中"名字"时不必要求群里热闹——那就是在叫它；泛泛征求意见才看活跃度
    const names = (Array.isArray(p.names) && p.names.length ? p.names : [this.bot.botName, '大肥鱼'])
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    const byName = names.some((n) => String(evt.text || '').includes(n));
    if (!byName && !this.chimeActive(evt)) return;

    // 日限（按本地日期翻页重置）
    const now = Date.now();
    const day = new Date().toISOString().slice(0, 10);
    if (this.chime.day !== day) {
      this.chime.day = day;
      this.chime.dayCount = 0;
    }
    if (this.chime.dayCount >= (p.dailyLimit ?? 20)) return;
    if (now - (this.chime.lastAt.get(evt.sceneId) || 0) < (p.minIntervalMs ?? 600000)) return;

    const key = sessionKey(evt, this.cfg.mode.groupShareContext);
    if (this.busy.has(key)) return;

    this.chime.lastAt.set(evt.sceneId, now);
    this.chime.dayCount += 1;
    this.stats.chime += 1;

    // 背景取在 push 之前，避免把当前这句重复灌进去
    const background = this.ambient.enabled ? this.ambient.snapshot(evt.sceneId) : '';
    if (background) this.stats.withBg += 1;

    log(
      `[router] 主动插话（群 ${evt.sceneId}）：${evt.userName || evt.userId}「${String(evt.text).slice(0, 30)}」`
    );

    await this.answer({
      evt,
      key,
      text:
        String(evt.text || '').trim()
        || (Array.isArray(evt.images) && evt.images.length ? '（你看到群友刚发了一张表情包/图片）' : ''),
      userName: evt.userName,
      background,
      // 插话要短：最多两条
      maxParts: Math.min(2, this.cfg.output.maxPartsGroup || 2),
      lockKey: key,
      proactive: true,
      // 插话不 @ 谁、也不引用原消息，看起来才像群友随口接的一句
      sender: (t) => this.bot.sendGroup(evt.sceneId, { text: t }),
    });
  }

  // ---------- 管理指令（仅管理员私聊） ----------
  async runCommand(evt, rawText) {
    const cmd = rawText.trim().split(/\s+/)[0].toLowerCase();
    const reply = (t) => this.bot.sendPrivate(evt.sceneId, { text: t, replyToId: evt.messageId, seq: 1 });

    switch (cmd) {
      case '/on':
      case '/open':
      case '/接入':
        if (this.state.set(true)) log('[router] 开关 -> 接入');
        await reply('✅ 已接入。群里 @ 我就会回答。');
        return;

      case '/off':
      case '/close':
      case '/断开':
        if (this.state.set(false)) log('[router] 开关 -> 断开');
        await reply('⛔ 已断开。群里 @ 我不会有任何反应（消息仍会收到，我不出声）。\n需要恢复就发 /on。');
        return;

      case '/status':
      case '/状态': {
        const on = this.state.enabled;
        const lines = [
          `状态：${on ? '✅ 已接入' : '⛔ 已断开'}`,
          `通道：${this.bot.transportName}`,
          `机器人：${this.bot.botName || this.bot.selfId || '未知'}`,
          `模型：${this.cfg.llm.model} @ ${this.cfg.llm.baseUrl}`,
          `API Key：${this.cfg.llm.apiKey ? '已配置' : '❌ 未配置'}`,
          `模式：${this.cfg.mode.requireAt ? '仅回答模式（必须 @）' : '普通模式'}`,
          `群范围：${this.cfg.bot.allowedGroups.length ? this.cfg.bot.allowedGroups.join('、') : '全部群'}`,
          `管理员：${this.cfg.bot.admins.length ? this.cfg.bot.admins.join('、') : this.state.boundAdmins.join('、') || '无'}`,
          `限流：${
            this.cfg.limits?.enabled
              ? `开（同人冷却 ${this.cfg.limits.userCooldownMs / 1000}s / 同会话 ${this.cfg.limits.sessionCooldownMs / 1000}s / 每小时 ${this.cfg.limits.hourlyLimitPerSession} 次 / 并发 ${this.cfg.limits.maxConcurrent}）`
              : '关'
          }`,
          `工具：联网${this.cfg.search?.enabled ? `(每次 ${this.cfg.search.maxResults} 条/冷却 ${this.cfg.search.cooldownMs / 1000}s)` : '关'}　计算器${this.cfg.calc?.enabled !== false ? '开' : '关'}　日期${this.cfg.tools?.datetime !== false ? '开' : '关'}　随机${this.cfg.tools?.random !== false ? '开' : '关'}　读网页${this.cfg.tools?.fetchUrl !== false ? '开' : '关'}`,
          `看图：${this.cfg.vision?.enabled ? `开（≤${(this.cfg.vision.maxBytes / 1048576).toFixed(1)}MB）` : '关'}　搜索规则：${this.cfg.search?.rules?.enabled !== false ? '开（时效问题加定向提示）' : '关'}　工具轮数上限：${this.cfg.tools?.maxRoundsPerReply ?? this.cfg.search?.maxRoundsPerReply ?? 2}`,
          (() => {
            const s = this.stickers.stats();
            if (!this.cfg.stickers?.enabled) return '表情包：关';
            if (!s.activeSet) return `表情包：开，但没有可用套装（${this.stickers.activeError || '目录为空'}）`;
            return `表情包：开（套装 ${s.activeSet}，${s.moods} 个情绪 / ${s.images} 张，${this.cfg.stickers.position === 'before' ? '表情在前' : '表情在后'}）`;
          })(),
          `群聊背景：${
            this.cfg.ambient?.enabled
              ? `开（每群记 ${this.cfg.ambient.maxKeep} 条，注入最近 ${this.cfg.ambient.injectItems} 条 / ≤${this.cfg.ambient.injectMaxChars} 字）`
              : '关'
          }　按需注入：${this.cfg.ambient?.smartInject !== false ? `开（已跳过 ${this.stats.bgSkipped} 次，省下的就是 token）` : '关（每次都带背景）'}`,
          `主动插话：${this.chimeEnabled() ? `开（本次运行已插 ${this.stats.chime} 次）` : '关'}　用 /chime 切换`,
          `模型档位：${
            this.cfg.llm.adaptive !== false
              ? `自适应（简单 effort=${this.cfg.llm.effort}/max=${this.cfg.llm.maxTokens}，难题 effort=${this.cfg.llm.effortHard}/max=${this.cfg.llm.maxTokensHard}）`
              : '固定'
          }`,
          (() => {
            const t = this.stats.tokens;
            if (!t.calls) return '用量（本次运行）：还没调用过模型';
            const rate = t.prompt ? Math.round((t.cacheHit / t.prompt) * 100) : 0;
            return `用量（本次运行）：输入 ${t.prompt}，其中前缀缓存命中 ${t.cacheHit}（${rate}%）；输出 ${t.completion}；API 调用 ${t.calls} 次`;
          })(),
          `统计：已答 ${this.stats.answered} 次（带背景 ${this.stats.withBg} 次），联网 ${this.stats.searched} 次，表情 ${this.stats.stickers} 张，限流拦截 ${this.stats.limited} 次，出错 ${this.stats.errors} 次`,
          `见过 ${this.groupSeen.size} 个群，活跃会话 ${listSessions().length} 个`,
        ];
        await reply(lines.join('\n'));
        return;
      }

      case '/ctx':
      case '/背景': {
        const arg = rawText.trim().split(/\s+/)[1] || '';
        if (arg === 'clear' || arg === '清空') {
          // 注意：指令是在私聊里发的，evt.sceneId 是管理员 QQ 号而不是群号。
          // 所以默认清空**所有群**的背景（早先版本按私聊 key 清，等于没清）。
          const gid = rawText.trim().split(/\s+/)[2];
          if (gid) {
            this.ambient.clear(gid);
            await reply(`🧹 群 ${gid} 的聊天背景已清空。`);
          } else {
            this.ambient.clear();
            await reply('🧹 所有群的聊天背景已清空。');
          }
          return;
        }
        if (!this.cfg.ambient?.enabled) {
          await reply('群聊背景功能当前是关闭的（config.json → ambient.enabled）。');
          return;
        }
        // 私聊里看不了群；如果是在某群里 @ 过，这里展示最后一个活跃群
        const targets = [...this.groupSeen];
        const lines = [];
        for (const g of targets.slice(0, 5)) {
          const n = this.ambient.size(g);
          if (!n) continue;
          lines.push(`群 ${g}：已记 ${n} 条`);
          lines.push(this.ambient.snapshot(g) || '（暂无）');
          lines.push('');
        }
        await reply(
          lines.length
            ? lines.join('\n') + '\n需要清空就发 /ctx clear'
            : '还没有记录到群聊背景。\n需要清空就发 /ctx clear。'
        );
        return;
      }

      case '/id':
      case '/标识': {
        await reply(
          [
            `你的 openid：${evt.userId}`,
            `当前会话标识：${evt.sceneId}`,
            `消息 id：${evt.messageId ?? '-'}`,
            '',
            '如需固定管理员，把 openid 填进 config.json 的 bot.admins 后重启。',
          ].join('\n')
        );
        return;
      }

      case '/sticker':
      case '/表情': {
        const arg = rawText.trim().split(/\s+/).slice(1).join(' ').trim();
        const s = this.stickers.stats();
        if (!arg || arg === 'list' || arg === '列表') {
          const moods = this.stickers.moods();
          await reply(
            moods.length
              ? `当前套装：${s.activeSet}（${s.moods} 个情绪 / ${s.images} 张）\n` +
                `全部套装：${this.stickers.setNames.join('、')}\n\n` +
                `${moods.join('、')}\n\n` +
                '发 /sticker 情绪名 立刻试一张；换套装改 config.json 的 stickers.activeSet 后重启。'
              : `没有可用的表情包套装。${this.stickers.activeError ? '\n原因：' + this.stickers.activeError : ''}`
          );
          return;
        }
        // 指令试发与聊天互不干扰（本来就没有节流，这里只是直连取图）
        const r = this.stickers.pick(arg);
        if (!r.ok) {
          await reply(`发不了：${r.error}`);
          return;
        }
        try {
          await this.bot.sendPrivate(evt.sceneId, { image: r.file });
          await reply(`已发「${r.mood}」(${r.name})`);
        } catch (e) {
          await reply(`发送失败：${e.message}`);
        }
        return;
      }

      case '/chime':
      case '/插话': {
        const arg = (rawText.trim().split(/\s+/)[1] || '').toLowerCase();
        const p = this.cfg.proactive || {};
        const names = (Array.isArray(p.names) && p.names.length ? p.names : [this.bot.botName, '大肥鱼'])
          .map((x) => String(x || '').trim())
          .filter(Boolean);
        const describe = () =>
          [
            `主动插话：${this.chimeEnabled() ? '✅ 开' : '⛔ 关'}（${
              this.state.proactive === null || this.state.proactive === undefined
                ? `跟随配置文件：${p.enabled ? '开' : '关'}`
                : '管理员设定'
            }）`,
            `触发：群里提到「${names.join('、')}」但没 @ 我${p.onQuestion ? '，或有人征求意见' : ''}`,
            `节流：同一群 ${Math.round((p.minIntervalMs ?? 600000) / 60000)} 分钟最多 1 次，每天最多 ${p.dailyLimit ?? 20} 次`,
            `今日已插：${this.chime.dayCount} 次`,
          ].join('\n');

        if (!arg || arg === 'status' || arg === '状态') {
          await reply(describe());
          return;
        }
        if (['on', '开', 'true'].includes(arg)) {
          this.state.setProactive(true);
          await reply(`主动插话已打开。\n\n${describe()}`);
          return;
        }
        if (['off', '关', 'false'].includes(arg)) {
          this.state.setProactive(false);
          await reply(`主动插话已关闭。\n\n${describe()}`);
          return;
        }
        if (['auto', '跟随'].includes(arg)) {
          this.state.setProactive(null);
          await reply(`已恢复为跟随配置文件。\n\n${describe()}`);
          return;
        }
        await reply('用法：/chime on | off | auto | status');
        return;
      }

      case '/clear':
      case '/清空': {
        const n = clearHistory(`private:${evt.sceneId}`);
        await reply(`🧹 私聊上下文已清空（${n} 条）。`);
        return;
      }

      case '/help':
      case '/帮助':
      default:
        await reply(
          [
            '可用指令（仅在本私聊里有效）：',
            '/on      接入，群里 @ 我就回答',
            '/off     断开，群里完全静默',
            '/status  查看当前状态',
            '/id      查看你的 openid / 群标识',
            '/clear   清空本私聊上下文',
            '/ctx     查看群聊背景记录（/ctx clear 清空全部，或 /ctx clear 群号）',
            '/sticker 看表情包情绪表（/sticker 卖萌 立即试发一张）',
            '/chime   主动插话开关（/chime on | off | auto | status）',
            '',
            '其它内容直接发，我会用模型回答你。',
            '注意：群里的 /on /off 一律无效，只有管理员私聊能控制开关。',
          ].join('\n')
        );
        return;
    }
  }

  // ---------- 调用模型并回复 ----------
  async answer({ evt, key, text, userName, sender, maxParts, lockKey, background = '', proactive = false }) {
    if (lockKey) this.busy.add(lockKey);
    this.processing += 1;
    try {
      if (!this.cfg.llm.apiKey) {
        await sender('（还没配置模型 API Key，暂时回答不了。请联系管理员。）');
        return;
      }

      // ---- 图片：下载转 base64（超限的会被跳过，不让大图白烧 token）----
      let images = [];
      const imageUrls = evt?.images || [];
      if (this.cfg.vision?.enabled && imageUrls.length) {
        const r = await collectImages(imageUrls, {
          maxImages: this.cfg.vision.maxImages,
          maxBytes: this.cfg.vision.maxBytes,
          timeoutMs: this.cfg.vision.timeoutMs,
        });
        images = r.images.map((x) => x.dataUrl);
        if (!images.length && r.skipped.length) {
          log(`[router] 图片全部不可用：${r.skipped.join('；')}`);
        }
      }

      // ---- 联网搜索：交给模型自己决定要不要用，并做会话级冷却 ----
      const onSearch = this.cfg.search?.enabled
        ? async (q) => {
            const now = Date.now();
            const last = this.lastSearch.get(key) || 0;
            if (now - last < this.cfg.search.cooldownMs) {
              return '（刚刚才搜过，先用已有信息回答吧）';
            }
            this.lastSearch.set(key, now);
            this.stats.searched += 1;
            const r = await webSearch(q, {
              limit: this.cfg.search.maxResults,
              timeoutMs: this.cfg.search.timeoutMs,
            });
            if (!r.ok) return `（这次没搜到，原因：${r.error}。就用手头的信息回答吧）`;
            return formatResults(q, r.results);
          }
        : null;

      // ---- 表情包：由模型决定要不要发（频率由人设约束，这里不做节流）----
      let stickerFile = null;
      const onSticker = this.stickers.enabled
        ? (mood) => {
            const r = this.stickers.pick(mood);
            if (r.ok) stickerFile = r.file; // 同一次回答里只保留最后一张
            return r;
          }
        : null;

      const raw = await chat(this.cfg, key, text, userName, {
        images,
        onSearch,
        background,
        proactive,
        stickerMoods: this.stickers.enabled ? this.stickers.moods() : [],
        onSticker,
        // 用量累计（输入 / 输出 / 前缀缓存命中），/status 里能看到
        onUsage: (u) => {
          const s = this.stats.tokens;
          s.prompt += u.prompt || 0;
          s.completion += u.completion || 0;
          s.cacheHit += u.cacheHit || 0;
          s.cacheMiss += u.cacheMiss || 0;
          s.calls += u.calls || 0;
        },
      });
      const plain = markdownToPlain(raw) || '（模型返回了空内容）';
      const parts = splitMessage(plain, this.cfg.output.maxCharsPerMessage, maxParts);

      const sendSticker = async () => {
        if (!stickerFile) return;
        try {
          if (evt.scene === 'group') await this.bot.sendGroup(evt.sceneId, { image: stickerFile });
          else await this.bot.sendPrivate(evt.sceneId, { image: stickerFile });
          this.stats.stickers += 1;
          log(`[router] 已发表情包：${path.basename(stickerFile)}`);
        } catch (e) {
          log(`[router] 表情包发送失败：${e.message}`);
        }
      };

      // 表情单独成一条消息（不带 @、不带引用），看起来才像群友随手甩的图
      if (this.cfg.stickers?.position === 'before') await sendSticker();
      for (const part of parts) {
        await sender(part);
      }
      if (this.cfg.stickers?.position !== 'before') await sendSticker();
      this.stats.answered += 1;
    } catch (e) {
      this.stats.errors += 1;
      log(`[router] 回答失败：${e.message}`);
      const brief = String(e.message).replace(/\s+/g, ' ').slice(0, 120);
      await sender(`（我这边出了点问题：${brief}）`).catch(() => {});
    } finally {
      this.processing -= 1;
      if (lockKey) this.busy.delete(lockKey);
    }
  }
}
