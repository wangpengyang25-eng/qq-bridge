// 成员档案：群友的关系状态层
//
// 这是「读群友表情包 / 主动发起谈话 / 喜欢和谁聊」三个功能共用的地基。
// 它只做一件事：把"这个号在这个群里是谁、聊过多少、熟不熟"记住。
//
// 位置说明：这个模块由 **bridge 和 webui 共用**。
// - bridge 侧由 src/members.mjs 负责落盘（data/members.json）
// - 面板侧通过 webui/src/profile.mjs 转发引用，两边规则一定是同一份
//
// 设计原则：
// 1. 纯函数 —— 不碰文件、不碰网络，方便单测和回放。
// 2. 可解释 —— 亲密度是算出来的，不是拍出来的；界面上要能讲清为什么。
// 3. 可撤销 —— 每项都有明确的来源字段，用户能看、能改、能清零。

/** 亲密度计算规则。改这里就改变了整个系统的"性格"。 */
export const RULES = {
  atScore: 2, // 被 @ 一次加多少
  messageScore: 1, // 普通发言一次加多少
  dailyMessageCap: 6, // 每天普通发言最多计这么多分，防止刷分
  idleDaysBeforeDecay: 7, // 连续多少天没说话开始掉分
  decayPerDay: 1, // 每天掉多少
  maxScore: 100,
};

/** 等级划分。改阈值只影响展示，不影响分数。 */
export const LEVELS = [
  { min: 0, name: '陌生', key: 'lv0' },
  { min: 10, name: '眼熟', key: 'lv1' },
  { min: 30, name: '熟络', key: 'lv2' },
  { min: 55, name: '好友', key: 'lv3' },
  { min: 80, name: '挚友', key: 'lv4' },
];

const DAY_MS = 86400000;

export function levelOf(score) {
  let cur = LEVELS[0];
  for (const l of LEVELS) if (score >= l.min) cur = l;
  return cur;
}

/** 下一个等级还差多少分；已满级返回 null。 */
export function nextLevelGap(score) {
  const next = LEVELS.find((l) => l.min > score);
  return next ? { name: next.name, gap: next.min - score, at: next.min } : null;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function createMember(qq, nick, now = Date.now()) {
  return {
    qq: String(qq),
    nick: nick || String(qq),
    affinity: 0,
    stats: {
      messages: 0,
      ats: 0,
      replies: 0, // 机器人回过它几次
      stickersSeen: 0, // 收到过它的表情包几次（表情包功能用）
      proactives: 0, // 主动搭过几次话（主动发起功能用）
    },
    note: '', // 人工备注，不会被自动逻辑覆盖
    muted: false, // 不想让它主动找这个人（真正生效的那份在 overrides.json）
    firstSeenAt: now,
    lastSeenAt: now,
    // 最近活跃的群：主动点名时要知道"该去哪个群找他"
    lastSceneId: null,
    lastSceneAt: 0,
    // 主动找过它几次（按人配额用，与 stats.proactives 的区别是这里含被拒的）
    lastCallAt: 0,
    callCount: 0,
    // 当日计分桶：{ 'YYYY-MM-DD': 已计分 }
    dayBucket: { date: dayKey(now), scored: 0 },
    // 衰减记账：上次结算到哪一天
    decayedAt: now,
  };
}

export function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 记一条消息。返回本次加了多少分（便于界面解释）。
 * @param {object} m 成员档案
 * @param {{isAt?:boolean, isSticker?:boolean, at?:number, sceneId?:string}} evt
 */
export function recordMessage(m, evt = {}) {
  const at = evt.at ?? Date.now();
  const key = dayKey(at);

  m.stats.messages += 1;
  if (evt.isAt) m.stats.ats += 1;
  if (evt.isSticker) m.stats.stickersSeen += 1;

  // 记住最近活跃的群：主动点名要知道去哪个群找人
  if (evt.sceneId) {
    m.lastSceneId = String(evt.sceneId);
    m.lastSceneAt = Math.max(m.lastSceneAt || 0, at);
  }

  if (m.dayBucket.date !== key) m.dayBucket = { date: key, scored: 0 };

  let gain = 0;
  const roomForPlain = Math.max(0, RULES.dailyMessageCap - m.dayBucket.scored);

  if (evt.isAt) {
    // @ 不占普通发言的日配额，但也不无限叠加
    gain += RULES.atScore;
  } else if (roomForPlain > 0) {
    gain += RULES.messageScore;
    m.dayBucket.scored += RULES.messageScore;
  }

  m.affinity = clamp(m.affinity + gain, 0, RULES.maxScore);
  m.lastSeenAt = Math.max(m.lastSeenAt, at);
  if (!m.firstSeenAt) m.firstSeenAt = at;
  return gain;
}

/** 记一次机器人主动搭话（主动发起功能的配额与效果都要看它）。 */
export function recordProactive(m, at = Date.now()) {
  m.stats.proactives += 1;
  m.lastSeenAt = Math.max(m.lastSeenAt, at);
}

/** 记一次机器人回复了它。 */
export function recordReply(m) {
  m.stats.replies += 1;
}

/**
 * 结算衰减。幂等：同一天调多次只结算一次。
 * 返回掉了几点，便于界面显示"最近冷了下来"。
 */
export function applyDecay(m, now = Date.now()) {
  const last = m.decayedAt || m.lastSeenAt || now;
  const idleDays = Math.floor((now - m.lastSeenAt) / DAY_MS);

  if (idleDays <= RULES.idleDaysBeforeDecay) {
    m.decayedAt = now;
    return 0;
  }

  // 只结算上次结算之后新过去的整天
  const settleFrom = Math.max(last, m.lastSeenAt + RULES.idleDaysBeforeDecay * DAY_MS);
  const days = Math.floor((now - settleFrom) / DAY_MS);
  if (days <= 0) {
    m.decayedAt = now;
    return 0;
  }

  const before = m.affinity;
  m.affinity = clamp(m.affinity - days * RULES.decayPerDay, 0, RULES.maxScore);
  m.decayedAt = now;
  return before - m.affinity;
}

/** 批量结算，返回被扣分的成员。 */
export function decayAll(members, now = Date.now()) {
  return members
    .map((m) => ({ m, lost: applyDecay(m, now) }))
    .filter((x) => x.lost > 0);
}

/** 各等级下"该怎么说话"的一句话指引 */
export const LEVEL_GUIDE = {
  lv0: '还不太熟，客气一点，别自作熟络',
  lv1: '见过几次，可以随意些，但别太主动',
  lv2: '比较熟了，可以开玩笑、可以接梗',
  lv3: '很熟，说话可以没大没小、可以互损',
  lv4: '关系很近，可以撒娇、可以互怼、也可以主动关心',
};

/**
 * 满级之后的具体关系称号。分数只到"挚友"，再往上是什么关系由人自己定，
 * 因为"是闺蜜还是恋人"不是算出来的，是两个人之间的事。
 */
export const BONDS = {
  闺蜜: '你们是无话不谈的闺蜜 —— 可以八卦、可以撒娇、可以说悄悄话，也可以忽然正经',
  恋人: '你们是恋人 —— 可以亲昵、可以想念、可以吃醋，但别腻得发假',
  亲子: '你把他当自家孩子照顾 —— 语气要温柔，会唠叨吃饭睡觉，会替他操心',
  损友: '你们是互相拆台的损友 —— 越熟越能开涮，但底线是都知道对方不会真生气',
  搭档: '你们是长期搭档 —— 说话直接、默契、不用说客套话',
};

/** 能挂上的关系称号列表（给面板下拉用） */
export const BOND_NAMES = Object.keys(BONDS);

/**
 * 生成"你和这个人的关系"提示块，注入到本轮消息里。
 *
 * 注意**不要**放进 system：system 是稳定前缀，动它会连累整段历史的缓存命中。
 * 这里放在消息尾部，所以带上具体分数不会影响缓存 —— 分数能让语气变化更细腻。
 *
 * @param {object} m 成员档案（可能来自 members.json）
 * @param {object} [over] 面板上的覆盖值（备注 / 手改的亲密度 / 关系称号）
 */
export function relationLine(m, over = {}) {
  const { maxNote = 60 } = over;
  const hasManual = Number.isFinite(over.affinity);
  const eff = hasManual ? over.affinity : m?.affinity || 0;
  if (!m && !hasManual) return '';

  const level = levelOf(eff);
  const lines = [`【你和他现在的关系】${level.name}（亲密度 ${Math.round(eff)}/100）—— ${LEVEL_GUIDE[level.key]}`];

  const bond = over.bond;
  if (bond && BONDS[bond]) lines.push(`【你们的关系】${BONDS[bond]}`);

  const s = m?.stats || {};
  if (s.messages) lines.push(`你们聊过 ${s.messages} 句，他被你叫过 ${s.ats || 0} 次`);

  const note = over.note ?? m?.note;
  if (note) lines.push(`【你记得关于他的事】${String(note).slice(0, maxNote)}`);

  return lines.join('\n');
}

/** 汇总统计，给界面顶部用。 */
export function summarize(members, now = Date.now()) {
  const today = dayKey(now);
  const aliveToday = members.filter((m) => dayKey(m.lastSeenAt) === today).length;
  const total = members.reduce((s, m) => s + m.stats.messages, 0);
  const avg = members.length
    ? Math.round(members.reduce((s, m) => s + m.affinity, 0) / members.length)
    : 0;
  return {
    members: members.length,
    aliveToday,
    totalMessages: total,
    avgAffinity: avg,
    levels: LEVELS.map((l) => ({
      ...l,
      count: members.filter((m) => levelOf(m.affinity).key === l.key).length,
    })),
  };
}

/**
 * 主动发起谈话的候选排序。
 * 越熟、越久没聊、越没被打扰过的越靠前 —— 但静音的一律排除。
 */
export function proactiveCandidates(members, now = Date.now()) {
  return members
    .filter((m) => !m.muted)
    .map((m) => {
      const idleDays = (now - m.lastSeenAt) / DAY_MS;
      // 熟度高给正分，久未聊给正分，但刚聊过就重罚
      const score =
        m.affinity * 1.0 +
        Math.min(idleDays, 14) * 3 -
        (idleDays < 1 ? 25 : 0) -
        m.stats.proactives * 2;
      return { member: m, score, idleDays };
    })
    .sort((a, b) => b.score - a.score);
}
