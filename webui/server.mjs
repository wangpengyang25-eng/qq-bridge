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
import { summarize, levelOf, nextLevelGap, RULES, LEVELS, proactiveCandidates } from './src/profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const DATA_DIR = path.join(HERE, 'data');
const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
};

const PORT = Number(argOf('--port') || process.env.PORT || 5173);
const HOST = '127.0.0.1';

/** 找 qq-bridge 目录：命令行 > 环境变量 > 常见位置 */
function resolveBridgeDir() {
  const fromArg = argOf('--bridge') || process.env.QQ_BRIDGE_DIR;
  const guesses = [
    fromArg,
    path.join(HERE, '..'), // 仓库内布局：webui/ 在 qq-bridge 里
    path.join(HERE, '..', 'qq-bridge'), // 独立目录开发时
    'E:\\QQ bot\\qq-bridge',
  ].filter(Boolean);

  for (const g of guesses) {
    try {
      if (fs.existsSync(path.join(g, 'config.json'))) return path.resolve(g);
    } catch { /* 忽略无权限的路径 */ }
  }
  // 退一步：有任何候选目录存在也算连上了，只是没有 config.json
  for (const g of guesses) {
    try {
      if (fs.existsSync(g)) return path.resolve(g);
    } catch { /* 继续 */ }
  }
  return null;
}

const BRIDGE_DIR = resolveBridgeDir();

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

async function loadMembers() {
  const doc = readJson(MEMBERS_FILE, { version: 1, members: [] });
  if (!Array.isArray(doc.members)) doc.members = [];
  return doc;
}

async function saveMembers(doc) {
  doc.updatedAt = Date.now();
  await writeJson(MEMBERS_FILE, doc);
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
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        rules: RULES,
        levels: LEVELS,
      });
    }

    if (p === '/api/config') {
      return json(res, 200, readBridgeConfig() ?? { error: '未找到 qq-bridge 目录' });
    }

    if (p === '/api/members' && req.method === 'GET') {
      const doc = await loadMembers();
      const enriched = doc.members.map((m) => ({
        ...m,
        level: levelOf(m.affinity),
        next: nextLevelGap(m.affinity),
      }));
      return json(res, 200, {
        members: enriched,
        stats: summarize(doc.members),
        updatedAt: doc.updatedAt ?? null,
      });
    }

    if (p === '/api/proactive' && req.method === 'GET') {
      const doc = await loadMembers();
      const ranked = proactiveCandidates(doc.members).slice(0, 10).map((x) => ({
        qq: x.member.qq,
        nick: x.member.nick,
        affinity: x.member.affinity,
        idleDays: Math.round(x.idleDays * 10) / 10,
        score: Math.round(x.score * 10) / 10,
      }));
      return json(res, 200, { candidates: ranked });
    }

    // 编辑成员：只允许改 note / muted / affinity 三个字段
    if (p.startsWith('/api/members/') && (req.method === 'PATCH' || req.method === 'POST')) {
      const qq = decodeURIComponent(p.slice('/api/members/'.length));
      const body = await readBody(req);
      const doc = await loadMembers();
      const m = doc.members.find((x) => x.qq === qq);
      if (!m) return json(res, 404, { error: '没有这个成员' });

      if (typeof body.note === 'string') m.note = body.note.slice(0, 500);
      if (typeof body.muted === 'boolean') m.muted = body.muted;
      if (Number.isFinite(body.affinity)) {
        m.affinity = Math.max(0, Math.min(RULES.maxScore, Math.round(body.affinity)));
      }
      await saveMembers(doc);
      return json(res, 200, { ok: true, member: m, level: levelOf(m.affinity) });
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
  console.log(`[webui] 成员数据: ${MEMBERS_FILE}`);
});
