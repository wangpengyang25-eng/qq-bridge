// OneBot v11 正向 WebSocket 适配器（配合 NapCat 使用，当前唯一通道）
// 产出统一事件结构，路由层只认这套结构，不关心底层通道细节。
import { log } from './logger.mjs';
import { stripCqCode } from './text.mjs';
import { faceName, decodeFaces } from './facemap.mjs';

/** 把 OneBot 消息统一成 { ats, images, text }，兼容 array / CQ 字符串两种格式 */
export function extractContent(msg) {
  const ats = [];
  const images = [];
  let text = '';
  const message = msg.message;

  if (Array.isArray(message)) {
    for (const seg of message) {
      const t = seg?.type;
      if (t === 'at') ats.push(String(seg.data?.qq ?? ''));
      else if (t === 'text') text += seg.data?.text ?? '';
      else if (t === 'image') {
        // 关键：图片要留下 URL 交给视觉链路，而不是压成 "[图片]" 文字
        const u = seg.data?.url || seg.data?.file || '';
        if (/^https?:\/\//i.test(u)) images.push(u);
      } else if (t === 'face') text += faceName(seg.data?.id);
    }
  } else if (typeof message === 'string') {
    text = stripCqCode(decodeFaces(message));
  }

  const raw = msg.raw_message || '';
  if (raw) {
    const reAt = /\[CQ:at,qq=([^,\]]+)/g;
    let m;
    while ((m = reAt.exec(raw))) {
      const q = m[1].trim();
      if (!ats.includes(q)) ats.push(q);
    }
    // 字符串格式下图片藏在 CQ 码里
    const reImg = /\[CQ:image,([^\]]*)\]/g;
    while ((m = reImg.exec(raw))) {
      const um = /url=([^,\]]+)/.exec(m[1]);
      if (um) {
        const u = um[1].replace(/&amp;/g, '&').trim();
        if (/^https?:\/\//i.test(u) && !images.includes(u)) images.push(u);
      }
    }
    if (!text) text = stripCqCode(decodeFaces(raw));
  }

  return { ats, images, text: text.trim() };
}

export class OneBot {
  constructor(cfg, handlers = {}) {
    this.cfg = cfg;
    this.handlers = handlers;
    this.transportName = 'onebot';
    this.ws = null;
    this.pending = new Map();
    this.echoSeq = 0;
    this.retry = 0;
    this.selfId = null;
    this.botName = '';
    this.closedByUser = false;
  }

  buildUrl() {
    let url = this.cfg.onebot.wsUrl;
    if (this.cfg.onebot.accessToken) {
      url += (url.includes('?') ? '&' : ':') + 'access_token=' + encodeURIComponent(this.cfg.onebot.accessToken);
    }
    return url;
  }

  /** 统一启动接口（bridge.mjs 只认 start/stop） */
  async start() {
    this.connect();
  }

  connect() {
    this.closedByUser = false;
    clearTimeout(this.timer);
    this.timer = null;
    log(`[onebot] 正在连接 ${this.cfg.onebot.wsUrl} ...`);

    let ws;
    try {
      ws = new WebSocket(this.buildUrl());
    } catch (e) {
      log(`[onebot] 连接创建失败：${e.message}`);
      return this.scheduleReconnect();
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      log('[onebot] WebSocket 已连接');
      this.handlers.onStatus?.('connected');
      this.call('get_login_info')
        .then((d) => {
          this.selfId = String(d?.user_id ?? '');
          this.botName = d?.nickname || '';
          log(`[onebot] 登录身份：${this.selfId} (${this.botName || '未知昵称'})`);
          this.handlers.onStatus?.('ready', { selfId: this.selfId, name: this.botName });
        })
        .catch((e) => {
          log(`[onebot] get_login_info 失败：${e.message}`);
          this.handlers.onStatus?.('ready', { selfId: null });
        });
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        log(`[onebot] 收到非 JSON 数据：${String(ev.data).slice(0, 160)}`);
        return;
      }
      this.dispatch(msg);
    };

    // 重要：Node 内置 WebSocket 在「首次就连不上」时只会触发 error，**不会**触发 close
    // （实测 v22.12.0：ws:// 指向无人监听的端口 → 只有 onerror）。
    // 早期只在 onclose 里安排重连，于是首次连接失败时没有留下任何定时器，
    // 事件循环清空 → 进程静默退出。所以 error 也要兜一次。
    ws.onerror = () => {
      log('[onebot] WebSocket 出错');
      this.ensureReconnect('error');
    };

    ws.onclose = (ev) => {
      this.selfId = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('连接已断开'));
      }
      this.pending.clear();
      this.handlers.onStatus?.('disconnected', { code: ev?.code });
      if (this.closedByUser) {
        log('[onebot] 连接已主动关闭');
        return;
      }
      log(`[onebot] 连接断开(code=${ev?.code ?? '-'})，准备重连`);
      this.ensureReconnect('close');
    };
  }

  /** 安排重连；已有一次在排队时不重复安排（error 与 close 可能都会来） */
  ensureReconnect(reason) {
    if (this.closedByUser) return;
    if (this.timer) return;
    log(`[onebot] 连接不可用（${reason}），准备重连`);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.closedByUser) return;
    const base = this.cfg.onebot.reconnectBaseMs || 1000;
    const max = this.cfg.onebot.reconnectMaxMs || 60000;
    const delay = Math.min(max, base * Math.pow(2, Math.min(this.retry, 6)));
    this.retry += 1;
    log(`[onebot] ${(delay / 1000).toFixed(1)}s 后重连（第 ${this.retry} 次）`);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  dispatch(msg) {
    if (msg.echo !== undefined && msg.echo !== null && this.pending.has(msg.echo)) {
      const p = this.pending.get(msg.echo);
      clearTimeout(p.timer);
      this.pending.delete(msg.echo);
      if (msg.status === 'ok' || msg.retcode === 0) p.resolve(msg.data);
      else p.reject(new Error(`OneBot 调用失败 retcode=${msg.retcode} ${msg.msg || msg.wording || ''}`));
      return;
    }
    if (msg.post_type === 'meta_event') {
      if (msg.self_id) this.selfId = String(msg.self_id);
      return;
    }
    if (msg.post_type === 'message') {
      try {
        this.handlers.onEvent?.(this.toEvent(msg));
      } catch (e) {
        log(`[onebot] 事件处理异常：${e.stack || e.message}`);
      }
    }
  }

  toEvent(msg) {
    const { ats, images, text } = extractContent(msg);
    const selfId = String(this.selfId ?? '');
    if (msg.message_type === 'group') {
      return {
        scene: 'group',
        sceneId: String(msg.group_id),
        userId: String(msg.user_id),
        userName: msg.sender?.card || msg.sender?.nickname || String(msg.user_id),
        text,
        images,
        messageId: msg.message_id,
        isAtMe: selfId ? ats.includes(selfId) : ats.length > 0,
        raw: msg,
      };
    }
    return {
      scene: 'private',
      sceneId: String(msg.user_id),
      userId: String(msg.user_id),
      userName: '',
      text,
      images,
      messageId: msg.message_id,
      isAtMe: true,
      raw: msg,
    };
  }

  call(action, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('WebSocket 未连接'));
      const echo = `e${++this.echoSeq}_${Date.now()}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`调用 ${action} 超时`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  /**
   * 发群消息。text 与 image 可单独用，也可一起用。
   *
   * image 直接传**绝对路径**就行：NapCat 的 handleOb11FileLikeMessage 支持
   * 本地路径 / file:// / base64:// / http(s)://，会自己读文件并上传。
   * （注意 onebot11.json 里的 enableLocalFile2Url 只影响"收消息"时要不要附带 base64，
   *  与发本地文件无关。）
   */
  async sendGroup(groupId, { text, image, replyToId, atUserId } = {}) {
    const segs = [];
    if (replyToId != null) segs.push({ type: 'reply', data: { id: replyToId } });
    if (atUserId) segs.push({ type: 'at', data: { qq: String(atUserId) } });
    if (text !== undefined && text !== null && String(text) !== '') {
      segs.push({ type: 'text', data: { text: (atUserId ? ' ' : '') + text } });
    }
    if (image) segs.push({ type: 'image', data: { file: image } });
    if (!segs.length) return null;
    return this.call('send_group_msg', { group_id: Number(groupId), message: segs });
  }

  async sendPrivate(userId, { text, image } = {}) {
    const segs = [];
    if (text !== undefined && text !== null && String(text) !== '') {
      segs.push({ type: 'text', data: { text } });
    }
    if (image) segs.push({ type: 'image', data: { file: image } });
    if (!segs.length) return null;
    return this.call('send_private_msg', { user_id: Number(userId), message: segs });
  }

  stop() {
    this.closedByUser = true;
    clearTimeout(this.timer);
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
  }
}
