// 造一批演示数据，方便在没有真实群流量时把界面跑起来看
//
//   node scripts/seed.mjs           # 生成（文件里已有真实数据时会拒绝）
//   node scripts/seed.mjs --force   # 确实要覆盖
//   node scripts/seed.mjs --clear   # 清空（接上真实群之后用这个）
//
// 生成的数据走的是 src/profile.mjs 的真实计分逻辑，
// 不是直接写死亲密度 —— 这样界面展示的分数和线上一致。
//
// 落点：bridge 的 data/members.json（和 bridge 自己写的是同一个文件）。

import { readJson, writeJson } from '../src/store.mjs';
import { resolvePaths } from '../src/paths.mjs';
import { createMember, recordMessage, recordProactive, recordReply, applyDecay } from '../src/profile.mjs';

const DAY = 86400000;
const now = Date.now();
const FILE = resolvePaths().membersFile;

if (process.argv.includes('--clear')) {
  await writeJson(FILE, { version: 1, members: [], updatedAt: now });
  console.log(`已清空 ${FILE}`);
  process.exit(0);
}

// 安全阀：这个文件到了线上就是真实群友档案，别手一抖覆盖掉
if (!process.argv.includes('--force')) {
  const cur = readJson(FILE, { members: [] });
  if (Array.isArray(cur.members) && cur.members.length > 0) {
    console.error(`拒绝覆盖：${FILE}`);
    console.error(`  里面已经有 ${cur.members.length} 位群友的档案（多半是 bridge 的真实数据）。`);
    console.error('  确实要覆盖请加 --force；接上真实群以后想看空面板就用 --clear。');
    process.exit(1);
  }
}

// QQ 号是假的，昵称也是编的
const seed = [
  { qq: '2000000001', nick: '老王', ats: 9, msgs: 46, spanDays: 16, lastSeenDays: 0.2 },
  { qq: '2000000002', nick: '阿茶', ats: 4, msgs: 31, spanDays: 14, lastSeenDays: 1.5 },
  { qq: '2000000003', nick: '夜宵', ats: 2, msgs: 23, spanDays: 12, lastSeenDays: 4 },
  { qq: '2000000004', nick: '小满', ats: 6, msgs: 38, spanDays: 13, lastSeenDays: 0.6 },
  { qq: '2000000005', nick: '咕咕', ats: 0, msgs: 13, spanDays: 20, lastSeenDays: 12 },
  { qq: '2000000006', nick: '铁蛋', ats: 1, msgs: 19, spanDays: 25, lastSeenDays: 20 },
  { qq: '2000000007', nick: '青柠', ats: 3, msgs: 27, spanDays: 11, lastSeenDays: 2.5 },
  { qq: '2000000008', nick: '路过的猫', ats: 0, msgs: 6, spanDays: 8, lastSeenDays: 31 },
];

const members = seed.map((s) => {
  const firstSeen = now - (s.lastSeenDays + s.spanDays) * DAY;
  const lastSeen = now - s.lastSeenDays * DAY;
  const m = createMember(s.qq, s.nick, firstSeen);

  // 把消息分散在 firstSeen..lastSeen 之间，走真实计分
  const span = lastSeen - firstSeen;
  const total = s.msgs;
  for (let i = 0; i < total; i++) {
    const t = firstSeen + Math.floor((span * i) / total);
    const isAt = i < s.ats * 3 && i % 3 === 0 && Math.floor(i / 3) < s.ats;
    recordMessage(m, { isAt, isSticker: i % 17 === 0, at: t });
  }
  if (s.lastSeenDays > 2) recordProactive(m, now - s.lastSeenDays * DAY + 3600e3);
  for (let i = 0; i < Math.min(5, Math.floor(total / 20)); i++) recordReply(m);

  m.lastSeenAt = lastSeen;
  m.note = s.at === 14 ? '话最多的那个' : '';
  applyDecay(m, now);
  return m;
});

await writeJson(FILE, { version: 1, members, updatedAt: now });
console.log(`已生成 ${members.length} 个演示成员 → ${FILE}`);
for (const m of members) console.log(`  ${m.nick.padEnd(8)} 亲密度 ${String(m.affinity).padStart(3)}`);
