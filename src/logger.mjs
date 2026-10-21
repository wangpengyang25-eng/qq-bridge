// 日志：同时输出到控制台与文件
import fs from 'node:fs';
import path from 'node:path';

let logFile = null;
// 防重入：console.log 抛错会触发 uncaughtException，处理器往往又去调 log，
// 于是「抛错→记日志→再抛错」无限递归，每轮都往日志文件追加一份堆栈。
// 线上实测过：2 分半写出 98MB。加这把锁彻底断掉递归。
let inLog = false;

export function initLogger(file) {
  logFile = file;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    console.error('[logger] 日志目录创建失败:', e.message);
  }
}

function fmt(v) {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function log(...args) {
  if (inLog) return; // 日志正在写时又被调进来 = 出错递归，直接丢弃这一条
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  const line = `[${ts}] ${args.map(fmt).join(' ')}`;
  inLog = true;
  // console.log 在 stdout 是「已被读端关闭的管道」时会抛 EPIPE（例如 `node bridge.mjs | head -20`），
  // 未捕获会直接结束进程。日志写不出去不是致命错误，吞掉即可。
  try {
    console.log(line);
  } catch {
    /* stdout 不可用，忽略 */
  }
  if (logFile) {
    // 同步写入：异步流在进程异常退出时会因未 flush 而丢失内容，
    // 那正是最需要日志的时刻（踩过：栈溢出崩溃后日志文件是空的）
    try {
      fs.appendFileSync(logFile, line + '\n');
    } catch {
      /* 写失败不影响主流程 */
    }
  }
  inLog = false;
}
