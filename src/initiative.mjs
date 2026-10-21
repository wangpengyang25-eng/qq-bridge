// 主动发起谈话：决策引擎
//
// 这里**只做判断，不发消息**。它回答一个问题：
// "此刻该不该主动说一句？说给谁？在哪个群？"
// 真正说话由 router 负责（要拼人设、拿背景、调模型）。
//
// 两个来源：
//   chime   —— 冷场接话：群刚才还热闹，安静了一阵 → 从话题里接一句，不 @ 人
//   callout —— 按人点名：从成员档案里挑一个"该联系的人" → 在群里 @ 他
//
// 为什么这么拆：
// 1. tick(now) 的 now 是外部传进来的 —— 否则"等 20 分钟看会不会冷场"没法测。
// 2. 所有闸门都在这里，且**先算后做**：任何一条不过就直接返回 null，不产生模型调用。
// 3. 配额在返回动作时就扣掉（fail closed）：宁可少说一句，也不要在出错时反复重试刷屏。

import { dayKey } from './profile.mjs';

export const DEFAULTS = {
  enabled: false, // ★ 总开关，默认关。社交风险最高的功能，必须显式打开
  scanEveryMs: 60000, // 多久评估一次（评估本身零成本，不调模型）
  dailyLimit: 12, // 全局每天最多主动说几次
  quietHours: { start: 1, end: 8 }, // 本地时间；跨零点自动处理；start===end 表示不限制

  chime: {
    enabled: true, // 冷场接话（风险低，跟总开关一起打开即可用）
    quietAfterMs: 1200000, // 安静满 20 分钟才考虑接话
    staleAfterMs: 7200000, // 超过 2 小时就算了，话题早凉了
    windowMs: 300000, // "冷场前是否热闹"的观察窗口
    minActivity: 3, // 窗口内至少几条消息才算热闹过
    cooldownMs: 1800000, // 同一个群两次接话的最小间隔
  },

  callout: {
    enabled: false, // ★ 点名（@ 人有社交压力，单独开关，默认关）
    minAffinity: 30, // 亲密度门槛（默认对应"熟络"）
    minMessages: 5, // 至少说过几句话，避免拿一两条数据就下判断
    perUserCooldownMs: 259200000, // 同一个人 3 天内最多被点名一次
    cooldownMs: 3600000, // 同一个群两次点名的最小间隔
  },
};

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
  if (!isPlain(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlain(base?.[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export class InitiativeEngine {
  /**
   * @param {object} opts
   * @param {object} opts.cfg  proactive.initiative 配置
   * @param {Function} [opts.isSceneBusy] 该群是否正在回答中
   * @param {Function} [opts.getMembers]  返回成员档案数组
   * @param {Function} [opts.isMuted]     (qq) => boolean，来自 overrides.json
   */
  constructor({ cfg, isSceneBusy, getMembers, isMuted } = {}) {
    this.cfg = merge(DEFAULTS, cfg || {});
    this.isSceneBusy = isSceneBusy || (() => false);
    this.getMembers = getMembers || (() => []);
    this.isMuted = isMuted || (() => false);

    this.groups = new Map(); // sceneId -> { recent: number[], lastSpokeAt: number }
    this.day = '';
    this.dayCount = 0;
    this.lastScanAt = 0;
    this.lastAction = null;
    this.actions = 0; // 本次运行累计主动说了几次
  }

  get enabled() {
    return this.cfg.enabled === true;
  }

  /** 面板上的开关在运行时覆盖配置，缺省（undefined）表示跟随 config.json */
  setSwitches({ enabled, chime, callout } = {}) {
    if (typeof enabled === 'boolean') this.cfg.enabled = enabled;
    if (typeof chime === 'boolean') this.cfg.chime.enabled = chime;
    if (typeof callout === 'boolean') this.cfg.callout.enabled = callout;
  }

  _group(sceneId) {
    const k = String(sceneId);
    let g = this.groups.get(k);
    if (!g) {
      g = { recent: [], lastSpokeAt: 0 };
      this.groups.set(k, g);
    }
    return g;
  }

  /** 群里有动静（任何消息都算，包括没 @ 机器人的） */
  noteActivity(sceneId, at = Date.now()) {
    const g = this._group(sceneId);
    g.recent.push(at);
    // 只留够判断"是否热闹"用的窗口，别无限涨
    const cut = at - Math.max(this.cfg.chime.windowMs, this.cfg.chime.staleAfterMs);
    while (g.recent.length && g.recent[0] < cut) g.recent.shift();
    if (g.recent.length > 500) g.recent.splice(0, g.recent.length - 500);
  }

  /** 自己在这个群说过话了（回答或主动都算，接话冷却看它） */
  noteSpoke(sceneId, at = Date.now()) {
    this._group(sceneId).lastSpokeAt = at;
  }

  _rollDay(now) {
    const d = dayKey(now);
    if (this.day !== d) {
      this.day = d;
      this.dayCount = 0;
    }
  }

  inQuietHours(now) {
    const q = this.cfg.quietHours || {};
    if (q.start == null || q.end == null || q.start === q.end) return false;
    const h = new Date(now).getHours();
    if (q.start < q.end) return h >= q.start && h < q.end;
    return h >= q.start || h < q.end; // 跨零点，例如 23 → 8
  }

  /**
   * 评估一次。
   * @param {number} now
   * @returns {null | {kind:'chime', sceneId:string, reason:string}
   *               | {kind:'callout', sceneId:string, userId:string, nick:string, reason:string}}
   */
  tick(now = Date.now()) {
    if (!this.enabled) return null;
    if (now - this.lastScanAt < this.cfg.scanEveryMs) return null;
    this.lastScanAt = now;

    this._rollDay(now);
    if (this.inQuietHours(now)) return null;
    if (this.dayCount >= this.cfg.dailyLimit) return null;

    const action = this._planChime(now) || this._planCallout(now);
    if (action) {
      this.dayCount += 1;
      this.actions += 1;
      this.lastAction = { ...action, at: now };
    }
    return action;
  }

  // ---------- 冷场接话 ----------

  _planChime(now) {
    const c = this.cfg.chime;
    if (!c.enabled) return null;

    let best = null;
    for (const [sceneId, g] of this.groups) {
      if (!g.recent.length) continue;
      const lastAt = g.recent[g.recent.length - 1];
      const quietFor = now - lastAt;

      if (quietFor < c.quietAfterMs) continue; // 还热闹着
      if (quietFor > c.staleAfterMs) continue; // 凉太久，接不上了
      if (now - g.lastSpokeAt < c.cooldownMs) continue; // 这个群刚说过
      if (this.isSceneBusy(sceneId)) continue; // 正在回答，别插

      // 冷场之前是否真的热闹过：只有热闹过的群，"接一句"才不突兀
      const from = lastAt - c.windowMs;
      const burst = g.recent.filter((t) => t >= from && t <= lastAt).length;
      if (burst < c.minActivity) continue;

      // 同一轮里可能多个群都满足，挑最"新鲜"的那个冷场
      if (!best || quietFor < best.quietFor) best = { sceneId, quietFor, burst };
    }
    if (!best) return null;

    this._group(best.sceneId).lastSpokeAt = now;
    return {
      kind: 'chime',
      sceneId: best.sceneId,
      reason: `群里安静了 ${Math.round(best.quietFor / 60000)} 分钟（安静前 ${best.burst} 条）`,
    };
  }

  // ---------- 按人点名 ----------

  _planCallout(now) {
    const c = this.cfg.callout;
    if (!c.enabled) return null;

    const pool = [];
    for (const m of this.getMembers()) {
      if (!m || !m.qq) continue;
      if (this.isMuted(m.qq)) continue; // 面板上点了静音
      if (!m.lastSceneId) continue; // 不知道他在哪个群，没法 @
      if ((m.affinity || 0) < c.minAffinity) continue;
      if ((m.stats?.messages || 0) < c.minMessages) continue;
      if (now - (m.lastCallAt || 0) < c.perUserCooldownMs) continue;
      if (this.isSceneBusy(m.lastSceneId)) continue;

      const d = this.groups.get(String(m.lastSceneId));
      if (d && now - d.lastSpokeAt < c.cooldownMs) continue; // 这个群刚点过名

      const idleDays = (now - (m.lastSeenAt || now)) / 86400000;
      // 越熟越好，越久没说话越好；叫过越多越往后排
      const score = (m.affinity || 0) + Math.min(idleDays, 14) * 3 - (m.callCount || 0) * 5;
      pool.push({ m, score, idleDays });
    }
    if (!pool.length) return null;

    pool.sort((a, b) => b.score - a.score);
    const pick = pool[0];

    // 引擎只做选择，不改成员档案 —— 计数与落盘由 members.markCalled() 负责，
    // 免得"决策层"和"存储层"各记一份、对不上。
    this._group(pick.m.lastSceneId).lastSpokeAt = now;

    return {
      kind: 'callout',
      sceneId: String(pick.m.lastSceneId),
      userId: String(pick.m.qq),
      nick: pick.m.nick,
      reason: `亲密度 ${pick.m.affinity}，${Math.floor(pick.idleDays)} 天没说话`,
    };
  }

  /** 给 /status 之类用的摘要 */
  summary() {
    return {
      enabled: this.enabled,
      chime: this.cfg.chime.enabled,
      callout: this.cfg.callout.enabled,
      today: this.dayCount,
      dailyLimit: this.cfg.dailyLimit,
      quietHours: `${this.cfg.quietHours.start}-${this.cfg.quietHours.end}`,
      tracks: this.groups.size,
      actions: this.actions,
    };
  }
}
