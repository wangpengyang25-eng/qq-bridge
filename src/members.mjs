// 成员档案存储：把 src/profile.mjs 的规则落到 data/members.json
//
// 分工约定（很重要）：
// - **这个文件由 bridge 独占写入**：计数器、亲密度、时间戳都归它。
// - **面板不写这个文件**：面板的人工编辑（备注 / 静音 / 手改亲密度）
//   写在自己的 data/overrides.json 里，显示时覆盖上来。
//   两边各写各的文件，就不会互相覆盖。
//
// 注意：这里任何异常都不能冒到消息处理链路上去。
// 记录失败最多是"这一个人少算一分"，绝不能让机器人因此不回复。

import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.mjs';
import { createMember, recordMessage, recordReply, decayAll, summarize, levelOf } from './profile.mjs';

const VERSION = 1;

export class MemberStore {
  constructor({ file, flushMs = 60000, maxMembers = 500, enabled = true } = {}) {
    this.file = file;
    this.flushMs = Math.max(1000, Number(flushMs) || 60000);
    this.maxMembers = Math.max(1, Number(maxMembers) || 500);
    this.enabled = enabled !== false && !!file;

    this.doc = { version: VERSION, members: [], updatedAt: null };
    this.byQq = new Map();
    this.dirty = false;
    this.timer = null;
    this.writes = 0;
    this.dropped = 0; // 超出容量没记下的条数
    this.lastError = null;

    if (this.enabled) this.load();
  }

  // ---------- 磁盘 ----------

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = fs.readFileSync(this.file, 'utf8');
      if (!raw.trim()) return;

      const doc = JSON.parse(raw);
      if (!Array.isArray(doc.members)) throw new Error('members 字段不是数组');

      this.doc = {
        version: VERSION,
        members: doc.members.filter((m) => m && m.qq),
        updatedAt: doc.updatedAt ?? null,
      };
      for (const m of this.doc.members) this.byQq.set(String(m.qq), m);

      // 补算停机期间该掉的亲密度
      const lost = decayAll(this.doc.members);
      if (lost.length) {
        this.dirty = true;
        const detail = lost.map((x) => `${x.m.nick}-${x.lost}`).join(' ');
        log(`[members] 补算离线衰减：${lost.length} 人（${detail}）`);
      }
      log(`[members] 已载入 ${this.doc.members.length} 位群友的档案`);
    } catch (e) {
      // 文件坏掉不该拖垮启动：备份一份，从空开始
      this.lastError = e.message;
      try {
        fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`);
        log(`[members] 档案读取失败，已备份原文件：${e.message}`);
      } catch {
        log(`[members] 档案读取失败且备份失败：${e.message}`);
      }
      this.doc = { version: VERSION, members: [], updatedAt: null };
      this.byQq = new Map();
      this.dirty = true;
      this.scheduleFlush();
    }
  }

  /** 定时落盘（还有未保存的改动才写） */
  scheduleFlush() {
    if (!this.enabled || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs);
    // 别因为这个定时器把进程吊住
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** 立即落盘；force=true 时即使没改动也写（退出时用） */
  flush(force = false) {
    if (!this.enabled) return false;
    if (!this.dirty && !force) return false;

    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      this.doc.updatedAt = Date.now();
      fs.writeFileSync(tmp, `${JSON.stringify(this.doc, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.file); // 同盘 rename，原子替换
      this.dirty = false;
      this.writes += 1;
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = e.message;
      log(`[members] 写盘失败（下次再试）：${e.message}`);
      return false;
    }
  }

  /** 收尾：清定时器并强制写一次 */
  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.flush(true);
  }

  // ---------- 记录 ----------

  /**
   * 记一条群消息。
   * @param {{userId:string, userName?:string, isAtMe?:boolean, hasSticker?:boolean, at?:number}} evt
   * @returns {number|null} 本次加的亲密度（记录失败或被限容时返回 null）
   */
  record(evt = {}) {
    if (!this.enabled) return null;
    try {
      const qq = String(evt.userId || '').trim();
      if (!qq) return null;

      let m = this.byQq.get(qq);
      if (!m) {
        if (this.byQq.size >= this.maxMembers) {
          this.dropped += 1;
          return null;
        }
        m = createMember(qq, evt.userName, evt.at || Date.now());
        this.byQq.set(qq, m);
        this.doc.members.push(m);
      } else if (evt.userName && evt.userName !== m.nick) {
        m.nick = evt.userName; // 群名片会改，用最新的
      }

      const gain = recordMessage(m, {
        isAt: !!evt.isAtMe,
        isSticker: !!evt.hasSticker,
        at: evt.at || Date.now(),
        sceneId: evt.sceneId,
      });

      this.dirty = true;
      this.scheduleFlush();
      return gain;
    } catch (e) {
      this.lastError = e.message;
      log(`[members] 记录失败（已忽略，不影响本次回复）：${e.message}`);
      return null;
    }
  }

  /** 记一次"机器人回了它的消息" */
  markReplied(userId) {
    const m = this.byQq.get(String(userId || ''));
    if (!m) return false;
    recordReply(m);
    this.dirty = true;
    this.scheduleFlush();
    return true;
  }

  /** 全部成员（给主动发起的决策层用） */
  all() {
    return this.doc.members;
  }

  /** 记一次"主动找了它"：按人配额与面板展示都看这个 */
  markCalled(userId) {
    const m = this.byQq.get(String(userId || ''));
    if (!m) return false;
    m.lastCallAt = Date.now();
    m.callCount = (m.callCount || 0) + 1;
    m.stats.proactives = (m.stats.proactives || 0) + 1;
    this.dirty = true;
    this.scheduleFlush();
    return true;
  }

  // ---------- 查询 ----------

  get(qq) {
    return this.byQq.get(String(qq)) || null;
  }

  get size() {
    return this.byQq.size;
  }

  stats() {
    return {
      ...summarize(this.doc.members),
      writes: this.writes,
      dropped: this.dropped,
      lastError: this.lastError,
      file: this.file,
    };
  }

  /** 给日志/诊断用的一行摘要 */
  summaryLine() {
    const s = this.stats();
    return `成员档案 ${s.members} 人，今日活跃 ${s.aliveToday}，平均亲密度 ${s.avgAffinity}`;
  }
}

export { levelOf };
