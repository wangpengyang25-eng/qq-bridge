// 消息路由：谁的消息要回、能不能回、回什么
// 安全边界：群聊只走「纯问答」——只调模型 API，绝不触碰本机文件与命令。
//
// 统一事件结构（由各适配器产出）：
//   { scene:'group'|'private', sceneId, userId, userName, text, messageId, isAtMe, raw }
// 其中 sceneId：群聊 = group_openid/群号；私聊 = user_openid/QQ 号
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.mjs';
import { markdownToPlain, splitMessage, stripParentheticals } from './text.mjs';
import { chat, complete, sessionKey, clearHistory, listSessions } from './llm.mjs';
import { collectImages } from './vision.mjs';
import { webSearch, formatResults } from './search.mjs';
import { AmbientBuffer, needBackground } from './ambient.mjs';
import { StickerLibrary } from './stickers.mjs';
import { MemberStore } from './members.mjs';
import { InitiativeEngine } from './initiative.mjs';
import { createOverrideReader } from './overrides.mjs';
import { createControlReader } from './control.mjs';
import { StickerSense, decideStickerReply, pickReplyMood } from './stickersense.mjs';
import { relationLine, levelOf } from './profile.mjs';
import { PersonaLoader } from './persona.mjs';
import { FollowTracker, addressedToOthers, looksLikeQuestion } from './followup.mjs';

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
    // 成员档案：群友的关系状态（亲密度 / 互动次数），定时落盘到 data/members.json
    this.members =
      cfg.members?.enabled === false
        ? null
        : new MemberStore({
            file: cfg.members?.file,
            flushMs: cfg.members?.flushMs,
            maxMembers: cfg.members?.maxMembers,
          });
    // 表情包库：目录相对 config.json 解析
    this.stickers = new StickerLibrary(
      cfg.stickers || {},
      path.resolve(cfg.__dir || '.', cfg.stickers?.dir || 'stickers')
    );
    // 主动发起谈话：只做决策，说话仍走 answer()。
    // 默认全关（cfg.proactive.initiative.enabled），要显式打开。
    this.readOverrides = createOverrideReader(
      cfg.members?.overridesFile || path.resolve(cfg.__dir || '.', 'data/overrides.json')
    );
    // 面板上的功能开关（运行时可改，不用重启）
    this.readControl = createControlReader(
      cfg.controlFile || path.resolve(cfg.__dir || '.', 'data/control.json')
    );
    this.initiative = new InitiativeEngine({
      cfg: cfg.proactive?.initiative,
      // 这个群正在回答中就别插话：busy 里存的是 sessionKey，含 sceneId
      isSceneBusy: (sceneId) =>
        [...this.busy].some((k) => String(k).includes(String(sceneId))),
      getMembers: () => (this.members ? this.members.all() : []),
      // 面板上点了静音的人，绝不主动找他
      isMuted: (qq) => this.readOverrides().muted.has(String(qq)),
    });
    this.initiativeTimer = null;
    // 观战（读群聊记录自己判断要不要开口）
    this.watchTimer = null;
    this.watchState = new Map(); // sceneId -> { at, seen }
    this.watchDay = '';
    this.watchCount = 0;
    // 面板设置要覆盖到的配置，先存一份"基线"（来自 config.json），
    // 这样每次应用面板设置都是"基线 + 覆盖"，不会越改越偏。
    this._baseInitiative = JSON.parse(JSON.stringify(this.initiative.cfg));
    this._baseProactive = JSON.parse(JSON.stringify(cfg.proactive || {}));

    // 读群友的表情包：识别情绪 + 决定回不回。
    // 只在 cfg.stickers.reply.enabled 时创建 —— 关着的时候连下载都不会发生。
    this.lastSpokeAt = new Map(); // 每个群自己上次说话的时间（回图门禁用）
    this.stickerReplyAt = new Map();
    this.stickerReplyDay = { date: '', count: 0 };
    this.stickerSense =
      cfg.stickers?.reply?.enabled && cfg.stickers?.enabled !== false
        ? new StickerSense({
            cacheFile: cfg.stickers.cacheFile,
            moods: () => this.stickers.moods(),
            normalize: (w) => this.stickers.resolveMood(w),
            complete: (messages, opts) => complete(cfg, messages, opts),
          maxTokens: cfg.stickers.reply.maxTokens,
            fetchImages: (urls, opts) =>
              collectImages(urls, {
                maxImages: 1,
                maxBytes: cfg.vision?.maxBytes ?? 2097152,
                timeoutMs: cfg.stickers.reply.visionTimeoutMs ?? 12000,
                ...opts,
              }),
          })
        : null;

    // 人设与表情套装：面板上改了就在下一条消息前生效（内部有 mtime 缓存，不改时零开销）
    this.persona = new PersonaLoader({
      dir: cfg.__dir || '.',
      promptFile: cfg.llm?.systemPromptFile || 'persona.txt',
      fewshotDir: 'fewshot',
      defaultFewshot: cfg.llm?.fewShotFile || '',
    });
    this._appliedPersona = '';
    this._personaError = null;
    // 角色卡：config 里的默认值，面板可以临时换
    this._cfgPersona = cfg.llm?.persona || '';
    this._relationsTable = null;
    this._activeSet = cfg.stickers?.activeSet || '';

    // 连续对话：一个人在跟她聊时，短时间内不 @ 也能接着说
    this.follow = new FollowTracker({
      enabled: cfg.mode?.followUp?.enabled !== false,
      windowMs: cfg.mode?.followUp?.windowMs ?? 90000,
      addressedMs: cfg.mode?.followUp?.addressedMs ?? 180000,
    });

    this.stats = {
      limited: 0,
      answered: 0,
      errors: 0,
      searched: 0,
      withBg: 0,
      bgSkipped: 0, // 因"这条不需要背景"而省下的注入次数
      stickers: 0,
      stickerReplies: 0, // 读群友表情包后回图的次数
      chime: 0, // 主动插话次数（有消息时接一句）
      initiative: 0, // 主动发起次数（定时器驱动）
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

    // 紧急暂停时仍然允许管理员指令，但普通问答和表情包回应都停
    if (this.isPaused()) {
      log('[router] 面板上处于暂停状态，忽略这条私聊问答');
      return;
    }

    // 只发了一张表情包：认出情绪后回一张（和群聊同一套门禁）
    if (evt.hasSticker && !evt.text) {
      const replied = await this.maybeStickerReply(evt);
      if (replied) return;
    }

    if (!evt.text) {
      // 诊断：把 NapCat 实际发来的消息段打出来。
      // "只发一张表情包"在没有识别到之前就是一条空文本消息，不记下来就永远不知道为什么没反应。
      const segs = Array.isArray(evt.raw?.message) ? evt.raw.message : [];
      const desc =
        segs
          .map((s) => {
            const bits = [s?.type];
            if (s?.data?.sub_type !== undefined) bits.push(`sub=${s.data.sub_type}`);
            if (s?.data?.summary) bits.push(`summary=${s.data.summary}`);
            if (s?.data?.file) bits.push(`file=${String(s.data.file).slice(0, 24)}`);
            return bits.join('/');
          })
          .join(' | ') || String(evt.raw?.message || '').slice(0, 80);
      log(`[router] 私聊收到无文本消息，段：${desc}`);
      return;
    }

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
    const allow = this.effAllowedGroups();
    const inScope = !allow.length || allow.includes(String(evt.sceneId));

    // 能力开关可能被面板改过，这里的群聊背景要用最新状态
    this.applyFeatureControl();

    // 连续对话：先记下"谁在说话"。别人插话会立刻打断（这是防误答的关键）
    let following = false;
    if (inScope) {
      this.applyFollowControl();
      // 被他 @ 了：这是最明确的"我在跟你说话"，直接开 3 分钟窗口
      if (evt.isAtMe) {
        this.follow.markAddressed(evt.sceneId, evt.userId);
        log(`[router] ${evt.userName || evt.userId} @ 了她，开启连续对话窗口`);
      }
      if (this.follow.noteSpeaker(evt.sceneId, evt.userId)) {
        log(`[router] 群 ${evt.sceneId} 有人插话，连续对话结束`);
      }
      const followResult = this.follow.isFollowing({
        sceneId: evt.sceneId,
        userId: evt.userId,
        replyId: evt.replyId,
      });
      following = followResult.ok;
      if (following) {
        log(
          `[router] 连续对话（${
            followResult.reason === 'quote' ? '引用' : followResult.reason === 'addressed' ? '刚 @ 过' : '答她的话'
          }）：${evt.userName || evt.userId} 没 @ 也接`
        );
      }
      // @ 了别人：这句不是说给她听的，不接（引用别人的也不接）
      if (addressedToOthers(evt)) {
        if (following) log(`[router] ${evt.userName || evt.userId} 在 @ 别人，不接这句`);
        following = false;
      } else if (evt.replyId != null && !following) {
        // 引用的是别人的消息：可能是给她看热闹，但不是对她说的
        log(`[router] ${evt.userName || evt.userId} 引用了别的消息（不是她的），不接`);
      }
    }

    const answering = evt.isAtMe !== false || !this.cfg.mode.requireAt || following;

    // 成员档案：白名单内的群，**所有**消息都记（不只是被 @ 的）。
    // 放在最前面，这样即使下面因为开关/限流/白名单直接 return，记录也不会漏。
    // 只计数不调 API，没有 token 成本。
    if (inScope && this.members) this.members.record(evt);
    // 主动发起要根据"群刚才热不热闹"来判断，所以每条消息都要喂给引擎
    if (inScope) this.initiative.noteActivity(evt.sceneId, Date.now());

    // 面板上的紧急暂停：不说话，但上面照常记录（数据不丢）
    if (this.isPaused()) return;

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

    if (this.cfg.mode.requireAt && evt.isAtMe === false && !following) {
      // 仅回答模式：这条不回答。
      // 但如果是表情包，先看看要不要回一张（比插话便宜，也更像群友）；
      // 回了图就不再插话，避免同一张表情包触发两个动作。
      const replied = await this.maybeStickerReply(evt);
      if (!replied) await this.maybeChimeIn(evt, inScope);
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

    // 群友 @ 了机器人却只甩一张表情包（没写字）：先认出情绪，再交给模型。
    // 否则模型只会收到一句"(空消息)"，完全不知道发生了什么。
    let body = evt.text || '';
    if (!body && this.stickerSense && evt.hasSticker) {
      const felt = await this.stickerSense.identify(evt.stickerUrls);
      if (felt) {
        body = `（对方 @ 了你，没有说话，只发了一张表情包，看起来是「${felt.mood}」）`;
        log(`[router] 表情包识别：${felt.mood}（${felt.source === 'cache' ? '缓存' : '视觉'}）`);
      }
    }
    if (!body) body = '(空消息)';
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
    return this.effProactive().enabled === true;
  }

  /** 触发信号：叫了她的名字但没 @（最自然的插话时机）；可选放宽到"在征求意见" */
  chimeWanted(evt) {
    const t = String(evt.text || '');
    const hasImage = Array.isArray(evt.images) && evt.images.length > 0;
    if (!t && !hasImage) return false;
    const p = this.effProactive();
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
    const p = this.effProactive();
    const n = this.ambient.recent(evt.sceneId, p.windowMs ?? 180000);
    return n >= (p.minActivity ?? 3);
  }

  async maybeChimeIn(evt, inScope) {
    const p = this.effProactive();
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
        const p = this.effProactive();
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

  // ---------- 观战：读群聊记录，自己判断要不要开口 ----------
  //
  // 和 chime（按规则接一句）不同，这条是**模型自己决定**：
  // 每隔一段时间看一眼最近的群聊，回 PASS 就继续潜水，回一句话就发出去。
  // 成本靠三重闸门控制：cooldownMs（看一次的最小间隔）、minNew（够几条才值得看）、dailyLimit。

  startWatch() {
    if (this.watchTimer) return true;
    const every = Math.max(30000, Number(this.cfg.proactive?.watch?.everyMs) || 120000);
    this.watchTimer = setInterval(() => {
      this.runWatch().catch((e) => log(`[watch] ${e.message}`));
    }, every);
    if (typeof this.watchTimer.unref === 'function') this.watchTimer.unref();
    log(`[watch] 观战已启动：每 ${Math.round(every / 1000)}s 看一眼`);
    return true;
  }

  stopWatch() {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  async runWatch(now = Date.now()) {
    const w = this.cfg.proactive?.watch || {};
    if (w.enabled !== true) return null;
    if (!this.state.enabled || this.isPaused()) return null;
    if (this.readControl().values.interject?.watch === false) return null;

    // 免打扰
    const hour = new Date(now).getHours();
    const qs = Number(w.quietHours?.start ?? 1);
    const qe = Number(w.quietHours?.end ?? 8);
    const quiet = qs === qe ? false : qs < qe ? hour >= qs && hour < qe : hour >= qs || hour < qe;
    if (quiet) return null;

    const today = new Date(now).toDateString();
    if (this.watchDay !== today) {
      this.watchDay = today;
      this.watchCount = 0;
    }
    if (this.watchCount >= Number(w.dailyLimit ?? 10)) return null;

    for (const sceneId of this.ambient.groups.keys()) {
      const arr = this.ambient.groups.get(sceneId) || [];
      const st = this.watchState.get(sceneId) || { at: 0, seen: 0 };
      const fresh = arr.length - st.seen;
      if (fresh < Number(w.minNew ?? 5)) continue;
      if (now - st.at < Number(w.cooldownMs ?? 900000)) continue;

      st.at = now;
      st.seen = arr.length;
      this.watchState.set(sceneId, st);

      const transcript = this.ambient.snapshot(sceneId);
      if (!transcript) continue;

      let say = '';
      try {
        say = await this.decideWatch(transcript, w);
      } catch (e) {
        log(`[watch] 判断失败：${e.message}`);
        continue;
      }
      if (!say) continue; // PASS，继续潜水

      try {
        await this.bot.sendGroup(sceneId, { text: say });
        this.watchCount += 1;
        this.stats.chime = (this.stats.chime || 0) + 1;
        log(`[watch] 群 ${sceneId} 接了一句：${say}`);
      } catch (e) {
        log(`[watch] 发送失败：${e.message}`);
      }
      return say; // 一次只在一个群开口
    }
    return null;
  }

  /** 让模型看一眼群聊，决定要不要接。返回要发的话，或空串表示不接 */
  async decideWatch(transcript, w = {}) {
    const voice = String(this.cfg.llm?.systemPrompt || '').slice(0, 600);
    const maxLen = Number(w.maxChars ?? 40);
    const out = await complete(
      this.cfg,
      [
        {
          role: 'system',
          content:
            `你是这个 QQ 群里的一个成员。下面是你的人设摘要：\n${voice}\n\n` +
            `现在给你看群里最近聊的几句，判断你要不要开口。\n` +
            `规则：\n` +
            `- 绝大多数时候不必开口。宁可沉默。\n` +
            `- 只有在「有人提问没人接」「话题正好是你熟的」「气氛凉了需要有人递一句」时才开口。\n` +
            `- 开口只说一句，${maxLen} 字以内，像群里随口接的那种，不要 @ 任何人。\n` +
            `- 不开口就只输出 PASS，不要输出别的内容。`,
        },
        { role: 'user', content: `【最近的群聊】\n${transcript}` },
      ],
      { maxTokens: 160, temperature: 0.8 }
    );

    const text = String(out || '')
      .trim()
      .replace(/^["'「『]|["'」』]$/g, '')
      .trim();
    if (!text) return '';
    if (/^PASS\b/i.test(text)) return '';
    // 太长的不要（模型有时会写一大段）
    if (text.length > maxLen * 2) return '';
    return text.split('\n')[0].trim();
  }

  // ---------- 面板设置（运行时可改，合并到配置之上）----------

  /** 不写括号里的动作描写（面板可改） */
  effNoActionHints() {
    const v = this.readControl().values.output?.noActionHints;
    return typeof v === 'boolean' ? v : this.cfg.output?.noActionHints === true;
  }

  /** 每条消息发出去之前停顿多久（模拟"人在打字"，别秒回） */
  effReplyDelayMs() {
    const o = this.readControl().values.output || {};
    const ms = o.replyDelaySec === undefined
      ? this.cfg.output?.replyDelayMs ?? 0
      : o.replyDelaySec * 1000;
    const n = Number(ms);
    return Number.isFinite(n) ? Math.max(0, Math.min(30000, n)) : 0;
  }

  /** 能力开关：工具与上下文。注意有些状态被对象在构造时就抓走了，要一并改。 */
  applyFeatureControl() {
    const f = this.readControl().values.features || {};
    const set = (obj, key, v) => {
      if (typeof v === 'boolean' && obj && key in obj) obj[key] = v;
    };
    set(this.cfg.search, 'enabled', f.search);
    set(this.cfg.calc, 'enabled', f.calc);
    set(this.cfg.tools, 'datetime', f.datetime);
    set(this.cfg.tools, 'random', f.random);
    set(this.cfg.tools, 'fetchUrl', f.fetchUrl);
    set(this.cfg.vision, 'enabled', f.vision);
    set(this.cfg.llm, 'adaptive', f.adaptive);

    // 这两个被各自的类实例持有，改 cfg 不够
    if (typeof f.ambient === 'boolean') {
      this.cfg.ambient.enabled = f.ambient;
      if (this.ambient) this.ambient.enabled = f.ambient;
    }
    if (typeof f.smartInject === 'boolean') {
      this.cfg.ambient.smartInject = f.smartInject;
      if (this.ambient) this.ambient.smartInject = f.smartInject;
    }
    if (typeof f.stickers === 'boolean') {
      this.cfg.stickers.enabled = f.stickers;
      if (this.stickers) this.stickers.enabled = f.stickers;
    }
  }

  /** 面板上的"连续对话"开关与窗口 */
  applyFollowControl() {
    const c = this.readControl().values.chat || {};
    this.follow.setConfig({
      enabled: c.followUp,
      windowMs: c.followUpWindowSec === undefined ? undefined : c.followUpWindowSec * 1000,
    });
  }

  /** 面板上的紧急暂停：一开就完全闭嘴（管理员指令除外） */
  isPaused() {
    return this.readControl().values.global?.paused === true;
  }

  /** 生效的群白名单：面板上设了就盖过 config.json */
  effAllowedGroups() {
    const ov = this.readControl().values.global?.allowedGroups;
    if (Array.isArray(ov)) return ov.map(String);
    return (this.cfg.bot?.allowedGroups || []).map(String);
  }

  /** 人设热重载：改了 persona.txt / 换了角色卡 / 换了示范套，下一条消息就生效 */
  applyPersona() {
    const c = this.readControl().values.persona || {};
    // file 没设过是 undefined（跟随配置）；设成空串表示"用默认角色"
    const persona = c.file === undefined ? (this._cfgPersona || '') : c.file;
    const r = this.persona.load({ persona, overrideFewshot: c.fewshot });
    // 不写括号动作：提示词里禁一次，发送前再硬剥一次。
    // 只靠提示词的话，模型还是会忍不住夹两句舞台指示。
    const noHints = this.effNoActionHints();
    const want = noHints ? `${r.prompt}\n\n【输出格式】不要写括号里的动作、神态、场景描写——那些旁白不要。直接说话。` : r.prompt;
    if (want && want !== this._appliedPersona) {
      this.cfg.llm.systemPrompt = want;
      this._appliedPersona = want;
      log(
        `[persona] 人设已更新：${r.source || '(空)'}${r.fewshotName ? ` + 示范 ${r.fewshotName}` : ''}${noHints ? '（无动作描写）' : ''}`
      );
    }
    // 关系措辞表跟着角色卡走
    this._relationsTable = r.relations || null;
    this._hasLore = !!r.hasLore;
    if (r.error && r.error !== this._personaError) {
      this._personaError = r.error;
      log(`[persona] ${r.error}`);
    }
    return r;
  }

  /** 表情套装切换：面板上换了套装就重建索引 */
  applyStickerSet() {
    const want = this.readControl().values.sticker?.activeSet;
    if (!want || want === this._activeSet) return;
    try {
      this.stickers = new StickerLibrary({ ...this.cfg.stickers, activeSet: want }, path.resolve(this.cfg.__dir || '.', this.cfg.stickers?.dir || 'stickers'));
      this._activeSet = want;
      log(`[sticker] 已切换到套装「${want}」（${this.stickers.moods().length} 个情绪）`);
    } catch (e) {
      log(`[sticker] 切换套装失败：${e.message}`);
    }
  }

  /** 表情包回应的生效配置：config.json 为底，面板设置覆盖 */
  effStickerReply() {
    const base = this.cfg.stickers?.reply || {};
    const o = this.readControl().values.sticker || {};
    const pick = (v, fallback) => (v === undefined ? fallback : v);
    return {
      ...base,
      enabled: pick(o.enabled, base.enabled),
      cooldownMs: pick(o.cooldownSec, base.cooldownMs / 1000) * 1000,
      dailyLimit: pick(o.dailyLimit, base.dailyLimit),
      onlyAfterBotSpoke: pick(o.onlyAfterBotSpoke, base.onlyAfterBotSpoke),
      withinMs: pick(o.withinSec, base.withinMs / 1000) * 1000,
      replyWithText: pick(o.replyWithText, base.replyWithText),
      atUser: pick(o.atUser, base.atUser),
    };
  }

  /** "听到就插话"的生效配置（老的 proactive 那套） */
  effProactive() {
    const base = this._baseProactive;
    const o = this.readControl().values.interject || {};
    const pick = (v, fallback) => (v === undefined ? fallback : v);
    return {
      ...base,
      enabled: pick(o.enabled, base.enabled),
      onImage: pick(o.onImage, base.onImage),
      onQuestion: pick(o.onQuestion, base.onQuestion),
      minIntervalMs: pick(o.cooldownSec, base.minIntervalMs / 1000) * 1000,
      dailyLimit: pick(o.dailyLimit, base.dailyLimit),
    };
  }

  /** 把面板上的主动发起设置应用到引擎（每次 tick 前调用） */
  applyInitiativeControl() {
    const c = this.readControl().values;
    const base = this._baseInitiative;
    const i = c.initiative || {};
    const ch = c.chime || {};
    const ca = c.callout || {};
    const pick = (v, fallback) => (v === undefined ? fallback : v);

    this.initiative.cfg.enabled = pick(i.enabled, base.enabled);
    this.initiative.cfg.dailyLimit = pick(i.dailyLimit, base.dailyLimit);
    this.initiative.cfg.quietHours = {
      start: pick(i.quietStart, base.quietHours?.start ?? 0),
      end: pick(i.quietEnd, base.quietHours?.end ?? 0),
    };

    this.initiative.cfg.chime = {
      ...base.chime,
      enabled: pick(ch.enabled, base.chime.enabled),
      quietAfterMs: pick(ch.quietAfterMin, base.chime.quietAfterMs / 60000) * 60000,
      staleAfterMs: pick(ch.staleAfterMin, base.chime.staleAfterMs / 60000) * 60000,
      cooldownMs: pick(ch.cooldownMin, base.chime.cooldownMs / 60000) * 60000,
      minActivity: pick(ch.minActivity, base.chime.minActivity),
    };

    this.initiative.cfg.callout = {
      ...base.callout,
      enabled: pick(ca.enabled, base.callout.enabled),
      minAffinity: pick(ca.minAffinity, base.callout.minAffinity),
      minMessages: pick(ca.minMessages, base.callout.minMessages),
      perUserCooldownMs: pick(ca.perUserCooldownDays, base.callout.perUserCooldownMs / 86400000) * 86400000,
      cooldownMs: pick(ca.cooldownMin, base.callout.cooldownMs / 60000) * 60000,
    };
  }

  // ---------- 读群友的表情包，回一张 ----------
  //
  // 与"回答时顺手发表情"是两条路：那条由模型决定发不发、发哪个情绪；
  // 这条是看到群友甩图之后，认出情绪再挑一张对着回。
  // 回图不调对话模型，只可能有一次视觉识别调用（且结果会缓存）。
  async maybeStickerReply(evt) {
    // 面板上关掉就立刻生效（不用重启）
    if (this.readControl().values.stickerReply === false) return null;
    const rc = this.effStickerReply();
    if (!rc?.enabled || !this.stickerSense) return null;
    if (!evt?.hasSticker || !evt?.stickerUrls?.length) return null;
    if (!this.state.enabled) return null;

    const now = Date.now();
    const sceneId = String(evt.sceneId);
    // 群聊和私聊的 sceneId 可能撞车（都是数字），所以键里带上前缀
    const sceneKey = `${evt.scene || 'group'}:${sceneId}`;
    const d = new Date(now);
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const verdict = decideStickerReply({
      cfg: rc,
      now,
      scene: evt.scene || 'group',
      lastSpokeAt: this.lastSpokeAt.get(sceneKey) || 0,
      lastReplyAt: this.stickerReplyAt.get(sceneKey) || 0,
      day: this.stickerReplyDay.date,
      dayCount: this.stickerReplyDay.count,
    });
    if (!verdict.ok) return null;

    const felt = await this.stickerSense.identify(evt.stickerUrls);
    if (!felt) {
      log('[router] 表情包认不出来，这次不回（宁可不回，也不瞎发一张）');
      return null;
    }

    // 不是复读同一个情绪：收到「难过」回「加油」才叫读懂了。
    // 回哪个还跟关系有关 —— 对熟人回得更热络，对刚认识的回得更克制。
    // 这里用的是**生效后**的亲密度（面板手改过的优先），不是自动算的那个。
    const member = this.members ? this.members.get(evt.userId) : null;
    const ovForLevel = this.readOverrides();
    const uid = String(evt.userId || '');
    const effAffinity = ovForLevel.affinity.has(uid) ? ovForLevel.affinity.get(uid) : member?.affinity || 0;
    const levelKey = levelOf(effAffinity).key;
    const replyMood = pickReplyMood(felt.mood, levelKey, this.stickers.moods(), Math.random) || felt.mood;
    const pick = this.stickers.pick(replyMood);
    if (!pick.ok) return null;

    if (this.stickerReplyDay.date !== today) this.stickerReplyDay = { date: today, count: 0 };
    this.stickerReplyDay.count += 1;
    this.stickerReplyAt.set(sceneKey, now);
    this.stats.stickerReplies += 1;

    log(
      `[router] 表情包：认出「${felt.mood}」→ 回「${replyMood}」` +
        `（${felt.source === 'cache' ? '缓存命中' : '视觉识别'}，关系 ${levelKey}）`
    );

    const sendImage = async () => {
      if (evt.scene === 'private') {
        await this.bot.sendPrivate(sceneId, { image: pick.file });
      } else {
        await this.bot.sendGroup(sceneId, {
          image: pick.file,
          replyToId: this.cfg.bot.replyWithQuote ? evt.messageId : undefined,
        });
      }
    };

    // 要不要顺便说一句话：说出来才看得出"读懂了"，但每次都是一次模型调用
    if (rc.replyWithText !== false && this.cfg.llm.apiKey) {
      const before = this.stats.stickers;
      try {
        await this.answer({
          evt,
          key: sessionKey(evt, this.cfg.mode.groupShareContext),
          text:
            `（${evt.scene === 'private' ? '对方' : '群友'}发了一张表情包，你看出来是「${felt.mood}」。` +
            '结合你们现在的关系，自然地回应一句，一句话就够，别描述图片本身，别复述这条指令。）',
          userName: evt.userName || '',
          maxParts: 1,
          lockKey: `${evt.scene || 'group'}:${sceneId}:sticker`,
          proactive: true,
          sender: (t) =>
            evt.scene === 'private'
              ? this.bot.sendPrivate(sceneId, { text: t })
              : this.bot.sendGroup(sceneId, {
                  text: t,
                  // 群里必须让人知道这句是回给谁的：
                  // 文字上 @ 他，同时引用他那条表情包消息。
                  atUserId: rc.atUser === false ? undefined : evt.userId,
                  replyToId: this.cfg.bot.replyWithQuote ? evt.messageId : undefined,
                }),
        });
      } catch (e) {
        log(`[router] 表情包配文失败：${e.message}`);
      }
      // 模型自己挑了一张就不重复发了，否则补上我们选的那张
      if (this.stats.stickers === before) {
        try {
          await sendImage();
        } catch (e) {
          log(`[router] 表情包发送失败：${e.message}`);
        }
      }
    } else {
      try {
        await sendImage();
      } catch (e) {
        log(`[router] 表情包发送失败：${e.message}`);
        return null;
      }
    }

    return { received: felt.mood, replied: replyMood, file: pick.file };
  }

  // ---------- 主动发起谈话（定时器驱动）----------
  //
  // 和上面的 maybeChimeIn 的区别：那条是"有消息进来时"顺便判断要不要接一句；
  // 这里没有任何人说话也能开口，所以必须定时器驱动，闸门全在 InitiativeEngine 里。
  // 真正的消息发送仍然复用 answer()，人设/表情包/工具都跟着走。

  startInitiative() {
    if (this.initiativeTimer) return true;
    // 即使当前是关的也起定时器：面板上随时可能打开，等 30 秒一次的评估很便宜，
    // 真正花钱的是 tick 之后真的开口那一步。
    const every = Math.max(1000, Number(this.cfg.proactive?.initiative?.scanEveryMs) || 60000);
    this.initiativeTimer = setInterval(() => {
      this.runInitiative().catch((e) => log(`[router] 主动发起异常：${e.message}`));
    }, every);
    if (typeof this.initiativeTimer.unref === 'function') this.initiativeTimer.unref();
    log(`[router] 主动发起已启动：每 ${Math.round(every / 1000)}s 评估 · ${JSON.stringify(this.initiative.summary())}`);
    return true;
  }

  stopInitiative() {
    if (this.initiativeTimer) {
      clearInterval(this.initiativeTimer);
      this.initiativeTimer = null;
    }
  }

  /**
   * 评估并执行一次主动发起。now 可注入，测试里可以快进时间。
   * @returns {Promise<null|object>} 执行了的动作
   */
  async runInitiative(now = Date.now()) {
    if (!this.state.enabled) return null; // 总开关断着就不主动开口
    if (this.isPaused()) return null; // 面板上的紧急暂停
    // 面板上的开关和数值优先于 config.json（缺省表示跟随配置）
    this.applyInitiativeControl();
    const action = this.initiative.tick(now);
    if (!action) return null;

    this.stats.initiative += 1;
    log(`[router] 主动发起（${action.kind}，群 ${action.sceneId}）：${action.reason}`);

    const background = this.ambient.enabled ? this.ambient.snapshot(action.sceneId) : '';

    if (action.kind === 'chime') {
      await this.answer({
        evt: { scene: 'group', sceneId: action.sceneId, userId: '', userName: '', text: '', images: [] },
        key: `group:${action.sceneId}`,
        text:
          '（群里刚刚安静下来，没有人叫你。你想起了刚才大家聊的内容，像群友那样自然地接一句。' +
          '不要 @ 任何人，不要解释你在做什么，一句话就够。）',
        userName: '',
        background,
        maxParts: 2,
        lockKey: `group:${action.sceneId}`,
        proactive: true,
        sender: (t) => this.bot.sendGroup(action.sceneId, { text: t }),
      });
      return action;
    }

    // callout：@ 某个人
    const note = this.readOverrides().notes.get(String(action.userId));
    const lines = [
      `（你想主动找群友「${action.nick}」搭话，此刻没有任何人在问你。）`,
      `你对他的了解：${action.reason}。`,
    ];
    if (note) lines.push(`你记得的备注：${note}`);
    lines.push('像群友一样自然地跟他说一两句，可以 @ 他。别说教，别复述这条指令。');

    await this.answer({
      evt: {
        scene: 'group',
        sceneId: action.sceneId,
        userId: action.userId,
        userName: action.nick,
        text: '',
        images: [],
      },
      key: sessionKey(
        { scene: 'group', sceneId: action.sceneId, userId: action.userId },
        this.cfg.mode.groupShareContext
      ),
      text: lines.join('\n'),
      userName: action.nick,
      background,
      maxParts: 2,
      lockKey: `group:${action.sceneId}`,
      proactive: true,
      sender: (t) => this.bot.sendGroup(action.sceneId, { text: t, atUserId: action.userId }),
    });
    if (this.members) this.members.markCalled(action.userId);
    return action;
  }

  /** 给面板看的运行快照（由 bridge 定时写进 data/runtime.json） */
  snapshot() {
    // 先应用一次面板设置：没有消息进来时 cfg 不会自己更新，
    // 那样面板上看到的就是"上次有消息时"的旧值。
    this.applyFeatureControl();
    this.applyFollowControl();
    this.applyInitiativeControl();
    this.applyPersona();
    const ctl = this.readControl().values;
    const ov = this.readOverrides();
    return {
      at: Date.now(),
      paused: !!ctl.global?.paused,
      stateEnabled: this.state.enabled,
      admins: this.state.boundAdmins || [],
      allowedGroups: this.effAllowedGroups(),
      model: this.cfg.llm?.model || '',
      persona: {
        source: this.cfg.__personaSource || '',
        fewshot: this.cfg.__fewShotSource || '',
        hasLore: !!this._hasLore,
        error: this._personaError,
      },
      stickerSet: this._activeSet || this.cfg.stickers?.activeSet || '',
      // 生效中的能力开关（面板改完看这里能确认真的生效了）
      features: {
        search: this.cfg.search?.enabled === true,
        calc: this.cfg.calc?.enabled === true,
        datetime: this.cfg.tools?.datetime !== false,
        random: this.cfg.tools?.random !== false,
        fetchUrl: this.cfg.tools?.fetchUrl !== false,
        vision: this.cfg.vision?.enabled === true,
        stickers: this.cfg.stickers?.enabled === true,
        ambient: this.cfg.ambient?.enabled === true,
        smartInject: this.cfg.ambient?.smartInject === true,
        adaptive: this.cfg.llm?.adaptive !== false,
      },
      stats: this.stats,
      initiative: this.initiative.summary(),
      lastInitiative: this.initiative.lastAction || null,
      members: this.members
        ? { size: this.members.size, file: this.members.file, stats: this.members.stats() }
        : null,
      stickerSense: this.stickerSense ? this.stickerSense.summary() : null,
      overrides: { muted: ov.muted.size, notes: ov.notes.size, affinity: ov.affinity.size, bonds: ov.bonds.size },
      busy: this.busy.size,
    };
  }

  // ---------- 调用模型并回复 ----------
  async answer({ evt, key, text, userName, sender, maxParts, lockKey, background = '', proactive = false, relation }) {
    if (lockKey) this.busy.add(lockKey);
    this.processing += 1;
    try {
      // 面板上的"一次最多几条"是硬上限，压过各调用点传进来的值
      const capParts = this.readControl().values.output?.maxParts;
      if (Number.isFinite(capParts) && Number.isFinite(maxParts)) {
        maxParts = Math.min(maxParts, capParts);
      } else if (Number.isFinite(capParts)) {
        maxParts = capParts;
      }
      // 每次回答前对一下人设和套装（有 mtime 缓存，没改就是几次 stat，很便宜）
      this.applyPersona();
      this.applyStickerSet();
      this.applyFeatureControl();
      // 关系块：没显式传就按当前说话的人去查。
      // 所有回复（群聊、私聊、主动发起、表情包配文）都会自动带上，
      // 所以"对她说话的语气跟好感度挂钩"不需要在每个调用点重复写。
      // 面板上的备注 / 手改的亲密度 / 关系称号都以 overrides 为准。
      let rel;
      if (relation !== undefined) {
        rel = relation;
      } else {
        const qq = String(evt?.userId || '');
        const ov = this.readOverrides();
        rel = relationLine(this.members ? this.members.get(qq) : null, {
          note: ov.notes.get(qq),
          affinity: ov.affinity.get(qq),
          bond: ov.bonds.get(qq),
          table: this._relationsTable || null,
        });
      }

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
        relation: rel,
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
      const plainRaw = markdownToPlain(raw) || '（模型返回了空内容）';
      // 剥掉括号里的动作描写；剥完空了的段落直接丢掉，
      // 全都空了才退回原文（总比一句都不说好）
      const plain = this.effNoActionHints()
        ? stripParentheticals(plainRaw) || stripParentheticals(plainRaw.replace(/（[^）]*）|\([^)]*\)/g, '')) || plainRaw
        : plainRaw;
      const parts = splitMessage(plain, this.cfg.output.maxCharsPerMessage, maxParts);

      // 每条消息之间停顿：秒回不像人，也容易让人觉得在刷屏。
      // 停顿发生在"发"之前，所以第一条也会等，整体读起来像在打字。
      const delayMs = this.effReplyDelayMs();
      const pause = () => (delayMs > 0 ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve());

      const sendSticker = async () => {
        if (!stickerFile) return;
        try {
          await pause();
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
      const sentIds = [];
      for (const part of parts) {
        await pause();
        const res = await sender(part);
        // 记下自己发出的 message_id：之后有人引用它，就知道是在回她
        const mid = res?.message_id ?? res?.data?.message_id;
        if (mid != null) sentIds.push(String(mid));
      }
      if (this.cfg.stickers?.position !== 'before') await sendSticker();

      // 她说了话：把 id 存档，供「引用即接」匹配
      if (evt?.scene === 'group') {
        for (const id of sentIds) this.follow.markSent(evt.sceneId, id);
        // 她以问句收尾 → 开一个「在等他回答」的窗口
        const lastPart = parts[parts.length - 1] || '';
        if (looksLikeQuestion(lastPart)) {
          this.follow.markQuestion(evt.sceneId, evt.userId);
          log(`[router] 她问了问题，${evt.userName || evt.userId} 接下来不用 @ 也能回答`);
        }
      }
      this.stats.answered += 1;
      // 记一笔"回过它"：成员档案里这个数字是主动搭话策略的输入之一。
      // 私聊里 evt 可能没有 userId（管理员自己），markReplied 会安全地返回 false。
      if (evt?.scene === 'group' && this.members) this.members.markReplied(evt.userId);
      // 自己说过话了：冷场接话的冷却按这个算
      if (evt?.scene && evt?.sceneId) {
        if (evt.scene === 'group') this.initiative.noteSpoke(evt.sceneId);
        // 回群友表情包的"接梗窗口"：群聊和私聊分开记
        this.lastSpokeAt.set(`${evt.scene}:${evt.sceneId}`, Date.now());
      }
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
