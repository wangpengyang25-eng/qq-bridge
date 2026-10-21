// 连续对话：群里什么时候不用 @ 也能接着说
//
// 两种触发方式，都要求"明确指向"，不再靠时间窗瞎猜：
//
//   1. 引用（最准）—— 他回引了她某条消息，就是在跟她说话
//   2. 问句窗口 —— 她刚以问句收尾，就是在等他回答
//
// 两者都不成立时，必须 @ 或叫名字。
// 旧版「回过他之后 3 分钟内什么都接」已经删掉：范围太宽（什么话都接）
// 又太窄（只认一个人），而且状态看不见，出错时莫名其妙。

const DEFAULTS = {
  enabled: true,
  windowMs: 90000, // 问句窗口：她问完 90 秒内算在等回答
  addressedMs: 180000, // 被 @ 之后：3 分钟内同一个人接着说都不用再 @
  sentTtlMs: 900000, // 她发出的消息 id 保留 15 分钟，供引用匹配
};

/**
 * 这句话是在 @ 别人吗？
 *
 * 群里 @ 了别人，就说明这句话不是说给她听的 —— 哪怕她刚跟这个人聊得正热。
 */
export function addressedToOthers(evt) {
  if (!evt) return false;
  if (evt.isAtMe !== false) return false; // 里面包含她，那就是对她说的
  return Array.isArray(evt.ats) && evt.ats.length > 0;
}

/** 这句话是不是在问问题（她以问句收尾时，才该等回答） */
export function looksLikeQuestion(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  // 去掉结尾的引号/括号/空白再判断
  const tail = t.replace(/[」』”"'）)】\s]+$/u, '');
  if (/[？?]\s*$/u.test(tail)) return true;
  return /(吗|呢|吧|好不好|对不对|行不行|是不是)[。！!…～~]*$/u.test(tail);
}

export class FollowTracker {
  constructor({ enabled = DEFAULTS.enabled, windowMs = DEFAULTS.windowMs, addressedMs = DEFAULTS.addressedMs, sentTtlMs = DEFAULTS.sentTtlMs } = {}) {
    this.enabled = enabled;
    const w = Number(windowMs);
    this.windowMs = Number.isFinite(w) ? Math.max(0, w) : DEFAULTS.windowMs;
    const a = Number(addressedMs);
    this.addressedMs = Number.isFinite(a) ? Math.max(0, a) : DEFAULTS.addressedMs;
    this.sentTtlMs = Math.max(60000, Number(sentTtlMs) || DEFAULTS.sentTtlMs);
    this.questions = new Map(); // `${sceneId}|${userId}` -> at
    this.addressed = new Map(); // `${sceneId}|${userId}` -> at（被 @ 的时间）
    this.sent = new Map(); // sceneId -> Map<messageId, at>
  }

  setConfig({ enabled, windowMs, addressedMs } = {}) {
    if (typeof enabled === 'boolean') this.enabled = enabled;
    if (Number.isFinite(windowMs)) this.windowMs = Math.max(0, windowMs);
    if (Number.isFinite(addressedMs)) this.addressedMs = Math.max(0, addressedMs);
  }

  /** 有人在群里说话了：如果是别人，就作废"在等他回答"这个窗口 */
  noteSpeaker(sceneId, userId) {
    const k = `${sceneId}|${userId}`;
    let cleared = false;
    for (const map of [this.questions, this.addressed]) {
      for (const key of map.keys()) {
        if (key === k) continue; // 还是他自己，不动
        if (key.startsWith(`${sceneId}|`)) {
          map.delete(key);
          cleared = true;
        }
      }
    }
    return cleared;
  }

  /** 他 @ 了她：这是最明确的"我在跟你说话"，从这一刻起他不用再 @ */
  markAddressed(sceneId, userId, now = Date.now()) {
    this.addressed.set(`${sceneId}|${userId}`, now);
  }

  /** 她问了一句：从现在起，这个人的回答不用 @ */
  markQuestion(sceneId, userId, now = Date.now()) {
    this.questions.set(`${sceneId}|${userId}`, now);
  }

  /** 她发出了一条消息：记下 id，之后有人引用它就知道是在回她 */
  markSent(sceneId, messageId, now = Date.now()) {
    if (messageId == null) return;
    const k = String(sceneId);
    let m = this.sent.get(k);
    if (!m) {
      m = new Map();
      this.sent.set(k, m);
    }
    m.set(String(messageId), now);
    // 顺手清理过期的
    for (const [id, at] of m) {
      if (now - at > this.sentTtlMs) m.delete(id);
    }
  }

  /**
   * 这条没 @ 的消息，算不算在跟她接着说？
   * @returns {{ ok: boolean, reason: 'quote' | 'question' | '' }}
   */
  isFollowing({ sceneId, userId, replyId, now = Date.now() } = {}) {
    if (!this.enabled) return { ok: false, reason: '' };
    const sid = String(sceneId);

    // 1) 引用：最明确
    if (replyId != null) {
      const m = this.sent.get(sid);
      const at = m?.get(String(replyId));
      if (at != null && now - at <= this.sentTtlMs) return { ok: true, reason: 'quote' };
    }

    // 2) 被 @ 过：他在跟她说，接着说的话不用再 @
    if (this.addressedMs > 0) {
      const at = this.addressed.get(`${sid}|${userId}`);
      if (at != null) {
        if (now - at <= this.addressedMs) return { ok: true, reason: 'addressed' };
        this.addressed.delete(`${sid}|${userId}`);
      }
    }

    // 3) 问句窗口：她问完，这个人在窗口内回答
    if (this.windowMs > 0) {
      const at = this.questions.get(`${sid}|${userId}`);
      if (at != null) {
        if (now - at <= this.windowMs) return { ok: true, reason: 'question' };
        this.questions.delete(`${sid}|${userId}`);
      }
    }

    return { ok: false, reason: '' };
  }

  snapshot() {
    const dump = (map, extra = {}) =>
      [...map.entries()].map(([k, at]) => {
        const [sceneId, userId] = k.split('|');
        return { sceneId, userId, at, ...extra };
      });
    return {
      questions: dump(this.questions),
      addressed: dump(this.addressed),
      sentGroups: this.sent.size,
    };
  }

  clear(sceneId) {
    if (sceneId === undefined) {
      this.questions.clear();
      this.addressed.clear();
      this.sent.clear();
      return;
    }
    const sid = String(sceneId);
    for (const map of [this.questions, this.addressed]) {
      for (const key of map.keys()) if (key.startsWith(`${sid}|`)) map.delete(key);
    }
    this.sent.delete(sid);
  }
}
