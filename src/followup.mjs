// 连续对话：一个人在跟她聊的时候，不用每句都 @ 或叫她名字
//
// 规则很克制，三个条件同时成立才算"接着聊"：
//   1. 是同一个人（不是谁都能白嫖）
//   2. 在上一次回答后的窗口内（默认 3 分钟）
//   3. 这期间没有别人在这个群说过话（有人插话，连续对话立即结束）
//
// 第 3 条是关键：如果群里多个人在说话，她就不该"默认这些没 @ 的话都是给我的"。

const DEFAULTS = { enabled: true, windowMs: 180000 };

export class FollowTracker {
  constructor({ enabled = DEFAULTS.enabled, windowMs = DEFAULTS.windowMs } = {}) {
    this.enabled = enabled;
    // 注意 0 是合法值（表示"不要连续对话"），不能用 || 兜底
    const w = Number(windowMs);
    this.windowMs = Number.isFinite(w) ? Math.max(0, w) : DEFAULTS.windowMs;
    this.map = new Map(); // sceneId -> { userId, at }
  }

  setConfig({ enabled, windowMs } = {}) {
    if (typeof enabled === 'boolean') this.enabled = enabled;
    if (Number.isFinite(windowMs)) this.windowMs = Math.max(0, windowMs);
  }

  /** 有人在群里说话了：如果是别人，就打断连续对话 */
  noteSpeaker(sceneId, userId) {
    const k = String(sceneId);
    const cur = this.map.get(k);
    if (!cur) return false;
    if (String(cur.userId) === String(userId)) return false; // 还是他，不动
    this.map.delete(k);
    return true; // 被别人打断了
  }

  /** 她刚回了某人：从这一刻起，这个人可以接着聊 */
  mark(sceneId, userId, now = Date.now()) {
    this.map.set(String(sceneId), { userId: String(userId), at: now });
  }

  /** 这条没 @ 的消息，算不算在跟她接着说 */
  isFollowing(sceneId, userId, now = Date.now()) {
    if (!this.enabled) return false;
    const k = String(sceneId);
    const cur = this.map.get(k);
    if (!cur) return false;
    if (String(cur.userId) !== String(userId)) return false;
    if (now - cur.at >= this.windowMs) {
      this.map.delete(k);
      return false;
    }
    return true;
  }

  /** 已建立连续对话的群（诊断用） */
  snapshot() {
    return [...this.map.entries()].map(([sceneId, v]) => ({ sceneId, userId: v.userId, at: v.at }));
  }

  clear(sceneId) {
    if (sceneId === undefined) this.map.clear();
    else this.map.delete(String(sceneId));
  }
}
