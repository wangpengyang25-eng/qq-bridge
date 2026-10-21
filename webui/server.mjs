// 本地控制台服务端
//
// 只做三件事：把成员档案读出来、把编辑写回去、把 qq-bridge 的配置脱敏展示。
// 刻意不引入任何第三方依赖，保持和 qq-bridge 一致的"clone 即跑"。
//
// 用法：
//   node server.mjs
//   node server.mjs --bridge "E:\QQ bot\qq-bridge" --port 5173
//
// 安全：只监听 127.0.0.1。这个面板能看群友数据、能改备注，不该暴露到局域网。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './src/store.mjs';
import { resolvePaths } from './src/paths.mjs';
import { summarize, levelOf, nextLevelGap, RULES, LEVELS, proactiveCandidates, BOND_NAMES } from './src/profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
};

const PORT = Number(argOf('--port') || process.env.PORT || 5173);
const HOST = '127.0.0.1';

// 路径：bridge 的成员档案 + 面板自己的编辑文件
const PATHS = resolvePaths(argOf('--bridge'));
const BRIDGE_DIR = PATHS.bridgeDir;
const MEMBERS_FILE = PATHS.membersFile;   // bridge 独占写入，面板只读
const OVERRIDES_FILE = PATHS.overridesFile; // 面板独占写入
const CONTROL_FILE = PATHS.controlFile;   // 面板独占写入（bridge 只读）

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- 数据读写 ----------
//
// 分两个文件，各写各的，永不互相覆盖：
//   members.json   —— bridge 独占（计数器、亲密度、时间戳）
//   overrides.json —— 面板独占（备注、静音、手动改的亲密度）
// 展示时把 overrides 盖在 members 上面。

/** 读 bridge 写的档案 + 面板的编辑，合并成展示用成员 */
function loadAll() {
  const doc = readJson(MEMBERS_FILE, { version: 1, members: [] });
  const members = Array.isArray(doc.members) ? doc.members : [];

  const ovDoc = readJson(OVERRIDES_FILE, { version: 1, overrides: {} });
  const ovs = ovDoc?.overrides && typeof ovDoc.overrides === 'object' ? ovDoc.overrides : {};

  const merged = members.map((m) => {
    const ov = ovs[m.qq] || {};
    const pinned = Number.isFinite(ov.affinity);
    const affinity = pinned ? Math.max(0, Math.min(RULES.maxScore, ov.affinity)) : m.affinity;
    return {
      ...m,
      affinity,
      note: typeof ov.note === 'string' ? ov.note : '',
      muted: ov.muted === true,
      bond: typeof ov.bond === 'string' ? ov.bond : '', // 满级之后的具体关系称号
      affinityPinned: pinned, // 界面用来标"这个分数是手改的"
      level: levelOf(affinity),
      next: nextLevelGap(affinity),
    };
  });

  return { members: merged, updatedAt: doc.updatedAt ?? null };
}

/** 读面板自己的开关文件；文件不存在时返回空对象（= 全部跟随 config.json） */
function loadControl() {
  const doc = readJson(CONTROL_FILE, { version: 1, control: {} });
  const c = doc?.control && typeof doc.control === 'object' ? doc.control : {};
  const out = {};
  for (const k of ['initiative', 'chime', 'callout', 'stickerReply']) {
    if (typeof c[k] === 'boolean') out[k] = c[k];
  }
  return out;
}

async function saveControl(patch) {
  const doc = readJson(CONTROL_FILE, { version: 1, control: {} });
  if (!doc.control || typeof doc.control !== 'object') doc.control = {};
  for (const k of ['initiative', 'chime', 'callout', 'stickerReply']) {
    if (typeof patch[k] === 'boolean') doc.control[k] = patch[k];
  }
  doc.updatedAt = Date.now();
  await writeJson(CONTROL_FILE, doc);
  return loadControl();
}

/** 只写 overrides.json（bridge 不看这个文件，只有面板用） */
async function saveOverride(qq, patch) {
  const doc = readJson(OVERRIDES_FILE, { version: 1, overrides: {} });
  if (!doc.overrides || typeof doc.overrides !== 'object') doc.overrides = {};
  const cur = doc.overrides[qq] || {};

  if (patch.affinity === null) {
    delete cur.affinity; // 取消手动指定，回到自动算的值
  } else if (Number.isFinite(patch.affinity)) {
    cur.affinity = Math.max(0, Math.min(RULES.maxScore, Math.round(patch.affinity)));
  }
  if (typeof patch.note === 'string') cur.note = patch.note.slice(0, 500);
  if (typeof patch.muted === 'boolean') cur.muted = patch.muted;
  // 关系称号：空字符串表示取消
  if (typeof patch.bond === 'string') {
    const b = patch.bond.trim();
    if (!b) delete cur.bond;
    else if (BOND_NAMES.includes(b)) cur.bond = b;
  }

  cur.at = Date.now();
  doc.overrides[qq] = cur;
  doc.updatedAt = Date.now();
  await writeJson(OVERRIDES_FILE, doc);
  return cur;
}

/** 读 qq-bridge 配置，密钥脱敏后再给前端 */
function readBridgeConfig() {
  if (!BRIDGE_DIR) return null;
  const file = path.join(BRIDGE_DIR, 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      transport: cfg.transport,
      model: cfg.llm?.model ?? null,
      baseUrl: cfg.llm?.baseUrl ?? null,
      apiKey: maskKey(cfg.llm?.apiKey),
      requireAt: cfg.mode?.requireAt,
      admins: Array.isArray(cfg.bot?.admins) ? cfg.bot.admins.length : 0,
      stickers: cfg.stickers?.activeSet ?? null,
      proactive: !!cfg.proactive?.enabled,
    };
  } catch (e) {
    return { error: `读配置失败：${e.message}` };
  }
}

function maskKey(k) {
  if (!k) return null;
  if (k.length <= 8) return '****';
  return `${k.slice(0, 4)}${'*'.repeat(Math.min(12, k.length - 8))}${k.slice(-4)}`;
}

// ---------- HTTP ----------

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
  });
  res.end(s);
};

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  // 防目录穿越：最终路径必须仍在 public 内
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: '越界路径' });

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname;

  try {
    // ---- API ----
    if (p === '/api/status') {
      return json(res, 200, {
        bridgeDir: BRIDGE_DIR,
        bridgeConnected: !!BRIDGE_DIR,
        membersFile: MEMBERS_FILE,
        overridesFile: OVERRIDES_FILE,
        controlFile: CONTROL_FILE,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        rules: RULES,
        levels: LEVELS,
        bonds: BOND_NAMES, // 满级之后可选的关系称号
      });
    }

    if (p === '/api/control' && req.method === 'GET') {
      return json(res, 200, { control: loadControl(), file: CONTROL_FILE });
    }

    if (p === '/api/control' && (req.method === 'PATCH' || req.method === 'POST')) {
      const body = await readBody(req);
      const next = await saveControl(body || {});
      return json(res, 200, { ok: true, control: next });
    }

    if (p === '/api/config') {
      return json(res, 200, readBridgeConfig() ?? { error: '未找到 qq-bridge 目录' });
    }

    if (p === '/api/members' && req.method === 'GET') {
      const doc = loadAll();
      return json(res, 200, {
        members: doc.members,
        stats: summarize(doc.members),
        updatedAt: doc.updatedAt,
        membersFile: MEMBERS_FILE,
      });
    }

    if (p === '/api/proactive' && req.method === 'GET') {
      const doc = loadAll();
      const ranked = proactiveCandidates(doc.members).slice(0, 10).map((x) => ({
        qq: x.member.qq,
        nick: x.member.nick,
        affinity: x.member.affinity,
        idleDays: Math.round(x.idleDays * 10) / 10,
        score: Math.round(x.score * 10) / 10,
      }));
      return json(res, 200, { candidates: ranked });
    }

    // 编辑成员：写 overrides.json，只接受 note / muted / affinity 三个字段
    if (p.startsWith('/api/members/') && (req.method === 'PATCH' || req.method === 'POST')) {
      const qq = decodeURIComponent(p.slice('/api/members/'.length));
      const body = await readBody(req);

      const doc = loadAll();
      if (!doc.members.some((x) => String(x.qq) === qq)) {
        return json(res, 404, { error: '没有这个成员' });
      }

      const patch = {};
      if (typeof body.note === 'string') patch.note = body.note;
      if (typeof body.muted === 'boolean') patch.muted = body.muted;
      if (body.affinity === null) patch.affinity = null;
      else if (Number.isFinite(body.affinity)) patch.affinity = body.affinity;

      const saved = await saveOverride(qq, patch);
      const after = loadAll().members.find((x) => String(x.qq) === qq);
      return json(res, 200, { ok: true, member: after, override: saved, level: after?.level });
    }

    // ---- 静态资源 ----
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);

    return json(res, 405, { error: '不支持的方法' });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[webui] 控制台已启动：http://${HOST}:${PORT}`);
  console.log(`[webui] qq-bridge: ${BRIDGE_DIR || '未找到（只读演示模式）'}`);
  console.log(`[webui] 成员档案: ${MEMBERS_FILE}（bridge 写，本面板只读）`);
  console.log(`[webui] 人工编辑: ${OVERRIDES_FILE}（本面板独占）`);
});
