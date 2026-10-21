// 极小的 JSON 持久化：读带默认值，写走临时文件 + rename（避免写一半断电损坏）
import fs from 'node:fs';
import path from 'node:path';

/** 每个文件的写操作串行化，防止并发写互相覆盖 */
const queues = new Map();

export function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return structuredClone(fallback);
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return structuredClone(fallback);
    // 文件存在但坏了：不静默吞掉，报出来，让调用方决定
    throw new Error(`读取 ${path.basename(file)} 失败（${e.message}）`);
  }
}

export function writeJson(file, data) {
  const prev = queues.get(file) || Promise.resolve();
  const next = prev.then(() => writeNow(file, data));
  // 队列本身不能因为一次失败就断掉
  queues.set(
    file,
    next.catch(() => {})
  );
  return next;
}

function writeNow(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const body = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file); // 同盘 rename 是原子的
}
