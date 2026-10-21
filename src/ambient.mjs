// 群聊被动上下文：后台记录群里最近在聊什么
//
// 背景：NapCat 会把群里的**所有**消息都推给我们，但桥原本只处理 @ 的那条。
// 于是机器人对「刚才群里聊了什么」一无所知，@ 她问「那个方案靠谱吗」只能反问「哪个方案」。
//
// 做法：把非 @ 消息也顺手记进一个环形缓冲（纯内存，0 token 成本），
// 只有被 @ 时才取最近几行当「背景」注入。存储不花钱，注入才有 token 成本。
//
// 两道省 token 的处理：
//   1) needBackground()：出现指代/承接信号（那个、刚才、然后呢…）才注入，
//      自足的问题（"1+1 等于几"）不带背景。多数 @ 因此能省掉这几百 token。
//   2) 每行带相对时间（"5 分钟前 老王：…"），让"刚才"有具体含义，代价只有几个 token。
//
// 过滤：空消息、纯表情、以及「哈哈/收到/666」这类无信息内容一律不收，
// 避免背景被水聊占满（这也是「选择性历史」思路在群聊场景的落地）。

const FILLER_RE =
  /^(哈+|呵+|嘿+|在吗|在么|在不在|收到|好的|好嘞|好滴|行|可以|嗯+|哦+|噢+|额+|啊+|咦|是吗|是吧|谢谢|谢了|多谢|ok|OK|Ok|kk|666|牛|牛啊|牛逼|沙发|顶|赞+|\+1|\[表情\])$/;

/** 是否是「没有信息量」的内容（不该进背景） */
export function isFiller(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  if (t.length <= 1) return true;
  // 去掉 @提及与表情占位后什么也不剩
  const core = t.replace(/\[表情\]/g, '').replace(/@\S+/g, '').trim();
  if (!core) return true;
  if (core.length <= 6 && FILLER_RE.test(core)) return true;
  return false;
}

/** 相对时间：让"刚才"变成具体的时间量 */
export function relTime(ts, now = Date.now()) {
  const d = Math.max(0, now - Number(ts || 0));
  if (d < 60000) return '刚刚';
  const m = Math.floor(d / 60000);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

// 指代 / 承接信号：出现这些词，问的多半是"前面说过的事"，背景才有价值
// 注意「他/她/它」要排掉「其他/其它/无他」这类，否则会误判成指代
const REFER_RE =
  /(那个|这个|那些|这些|他们|她们|它们|(?<![其无任])[他她它]|上面|刚才|刚刚|前面|之前|上一条|那句|这句|接着|然后呢|继续|还有呢|还有吗|为什么呢|怎么会|真的假的|靠谱吗|怎么说|哪个|多少|多长时间)/;

/**
 * 这一句到底需不需要群聊背景？
 *
 * 背景每次要占 300~600 token，而大多数 @ 的问题本身是自足的
 * （"1+1 等于几""帮我算个数"），带上背景纯属浪费，还会让回答跑偏。
 * 所以只有出现指代/承接信号时才注入。
 *
 * 想恢复"每次都带背景"：把 config.json 的 ambient.smartInject 设为 false。
 */
export function needBackground(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return REFER_RE.test(t);
}

export class AmbientBuffer {
  constructor(cfg = {}) {
    this.enabled = cfg.enabled !== false;
    this.smartInject = cfg.smartInject !== false;      // 按需注入（默认开）
    this.maxKeep = Number(cfg.maxKeep) || 30;          // 每群最多记多少条
    this.injectItems = Number(cfg.injectItems) || 8;   // 注入时最多取几条
    this.injectMaxChars = Number(cfg.injectMaxChars) || 500;
    this.minLen = Number(cfg.minLen) || 2;
    this.groups = new Map(); // sceneId -> [{userName, text, ts}]
  }

  /**
   * 记一条（通常是非 @ 的群消息）。返回是否真的记下了。
   * @param {object} evt 统一事件结构
   */
  push(sceneId, evt) {
    if (!this.enabled) return false;
    const text = String(evt?.text ?? '').trim();
    if (text.length < this.minLen) return false;
    if (isFiller(text)) return false;

    const key = String(sceneId);
    let arr = this.groups.get(key);
    if (!arr) {
      arr = [];
      this.groups.set(key, arr);
    }
    arr.push({
      userName: String(evt?.userName ?? evt?.userId ?? ''),
      text,
      ts: Date.now(),
    });
    while (arr.length > this.maxKeep) arr.shift();
    return true;
  }

  /**
   * 取最近若干条拼成背景文本（条数与总字数双限，从最近往前收）。
   * 注意：调用方应在本条消息 push 之前调用，这样背景里不含当前这句。
   */
  snapshot(sceneId) {
    if (!this.enabled) return '';
    const arr = this.groups.get(String(sceneId)) || [];
    const picked = [];
    let chars = 0;
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      if (picked.length >= this.injectItems) break;
      const it = arr[i];
      const line = `${relTime(it.ts)} ${it.userName}：${it.text}`;
      if (picked.length && chars + line.length > this.injectMaxChars) break;
      picked.unshift(line);
      chars += line.length + 1;
    }
    return picked.join('\n');
  }

  size(sceneId) {
    return (this.groups.get(String(sceneId)) || []).length;
  }

  /** 最近 windowMs 内记了几条（用来判断"群里这会儿活不活跃"） */
  recent(sceneId, windowMs = 180000, now = Date.now()) {
    const arr = this.groups.get(String(sceneId)) || [];
    const from = now - windowMs;
    let n = 0;
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      if (arr[i].ts < from) break;
      n += 1;
    }
    return n;
  }

  clear(sceneId) {
    if (sceneId === undefined) this.groups.clear();
    else this.groups.delete(String(sceneId));
  }
}
