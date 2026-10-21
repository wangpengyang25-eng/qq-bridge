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
import { normalize, SCHEMA } from '../src/control.mjs';
import { DEFAULTS as INITIATIVE_DEFAULTS } from '../src/initiative.mjs';
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
const RUNTIME_FILE = PATHS.bridgeDir ? path.join(PATHS.bridgeDir, 'data', 'runtime.json') : null;

/** 读 config.json 原文（不含对外输出，只在本层用来定位文件） */
function readCfgRaw() {
  if (!BRIDGE_DIR) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

const CFG_RAW = readCfgRaw();
const LOG_FILE = path.join(BRIDGE_DIR || '', CFG_RAW.logFile || 'logs/bridge.log');
const PERSONA_FILE = path.join(BRIDGE_DIR || '', CFG_RAW.llm?.systemPromptFile || 'persona.txt');
const STICKERS_DIR = path.join(BRIDGE_DIR || '', CFG_RAW.stickers?.dir || 'stickers');
const FEWSHOT_DIR = path.join(BRIDGE_DIR || '', 'fewshot');
const PERSONAS_DIR = path.join(BRIDGE_DIR || '', 'personas');

/** 当前该编辑哪个文件：角色卡活跃时编辑卡里的，否则编辑根目录的 */
function personaFilePath() {
  const name = activePersona();
  if (name && name !== '默认') return path.join(PERSONAS_DIR, name, 'persona.txt');
  return PERSONA_FILE;
}
function activePersona() {
  const ctl = loadControl();
  const v = ctl.persona?.file;
  if (typeof v === 'string') return v;
  return CFG_RAW.llm?.persona || '';
}

/** 读某张角色卡的关系措辞表（没有就返回 null） */
function personaRelations(name) {
  if (!name) return null;
  try {
    const file = path.join(PERSONAS_DIR, name, 'relations.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (doc && typeof doc.bonds === 'object') {
      const bonds = Object.keys(doc.bonds).filter((k) => typeof doc.bonds[k] === 'string');
      if (bonds.length) return { bonds, guides: doc.guides || null, doc };
    }
    return { bonds: [], guides: doc?.guides || null, doc };
  } catch {
    return null;
  }
}

/** 当前角色卡允许的关系称号（卡里没写才退回默认列表） */
function activeBonds() {
  const r = personaRelations(activePersona());
  return r?.bonds?.length ? r.bonds : BOND_NAMES;
}
function listPersonas() {
  const out = [];
  if (CFG_RAW.llm?.systemPromptFile) {
    try {
      fs.accessSync(path.join(BRIDGE_DIR || '', CFG_RAW.llm.systemPromptFile));
      out.push('默认');
    } catch { /* 根目录没有 persona.txt 就不列 */ }
  }
  try {
    for (const d of fs.readdirSync(PERSONAS_DIR, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(PERSONAS_DIR, d.name, 'persona.txt'))) out.push(d.name);
    }
  } catch { /* 没有 personas/ 目录 */ }
  return out;
}

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

/** 读面板自己的设置文件；文件不存在时返回空对象（= 全部跟随 config.json） */
function loadControl() {
  const doc = readJson(CONTROL_FILE, { version: 2, control: {} });
  return normalize(doc?.control);
}

/** 深合并一层分组后清洗（面板每次只改一个字段，不能把同组其他字段冲掉） */
async function saveControl(patch) {
  const doc = readJson(CONTROL_FILE, { version: 2, control: {} });
  if (!doc.control || typeof doc.control !== 'object') doc.control = {};
  const src = patch && typeof patch === 'object' ? patch : {};
  for (const [group, fields] of Object.entries(src)) {
    if (!fields || typeof fields !== 'object') continue;
    const cur = { ...(doc.control[group] || {}) };
    for (const [k, v] of Object.entries(fields)) {
      if (v === null) delete cur[k]; // null = 恢复默认（删掉覆盖项）
      else cur[k] = v;
    }
    if (Object.keys(cur).length) doc.control[group] = cur;
    else delete doc.control[group];
  }
  doc.version = 2;
  doc.updatedAt = Date.now();
  await writeJson(CONTROL_FILE, doc);
  return loadControl();
}

/** 读配置里跟"运行时设置"相关的数值（不含任何密钥），作为面板显示的默认值 */
function readRawSettings() {
  if (!BRIDGE_DIR) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const st = cfg.stickers?.reply || {};
    const p = cfg.proactive || {};
    // config.json 里没写的项要用代码默认值兜底，否则面板上会显示空白
    const ini = { ...INITIATIVE_DEFAULTS, ...(p.initiative || {}) };
    const ch = { ...INITIATIVE_DEFAULTS.chime, ...(p.initiative?.chime || {}) };
    const ca = { ...INITIATIVE_DEFAULTS.callout, ...(p.initiative?.callout || {}) };
    return {
      sticker: {
        enabled: st.enabled,
        cooldownSec: Math.round((st.cooldownMs ?? 300000) / 1000),
        dailyLimit: st.dailyLimit,
        onlyAfterBotSpoke: st.onlyAfterBotSpoke,
        withinSec: Math.round((st.withinMs ?? 120000) / 1000),
        replyWithText: st.replyWithText !== false,
        atUser: st.atUser !== false,
      },
      initiative: {
        enabled: ini.enabled,
        dailyLimit: ini.dailyLimit,
        quietStart: ini.quietHours?.start ?? 0,
        quietEnd: ini.quietHours?.end ?? 0,
      },
      chime: {
        enabled: ch.enabled,
        quietAfterMin: Math.round((ch.quietAfterMs ?? 1200000) / 60000),
        staleAfterMin: Math.round((ch.staleAfterMs ?? 7200000) / 60000),
        cooldownMin: Math.round((ch.cooldownMs ?? 1800000) / 60000),
        minActivity: ch.minActivity,
      },
      callout: {
        enabled: ca.enabled,
        minAffinity: ca.minAffinity,
        minMessages: ca.minMessages,
        perUserCooldownDays: Math.round((ca.perUserCooldownMs ?? 259200000) / 86400000),
        cooldownMin: Math.round((ca.cooldownMs ?? 3600000) / 60000),
      },
      interject: {
        enabled: p.enabled,
        onImage: p.onImage,
        onQuestion: p.onQuestion,
        cooldownSec: Math.round((p.minIntervalMs ?? 600000) / 1000),
        dailyLimit: p.dailyLimit,
        watch: p.watch?.enabled === true,
      },
      output: {
        maxParts: cfg.output?.maxPartsGroup ?? 2,
        replyDelaySec: Math.round((cfg.output?.replyDelayMs ?? 0) / 1000),
        noActionHints: cfg.output?.noActionHints === true,
      },
      chat: {
        followUp: cfg.mode?.followUp?.enabled !== false,
        followUpWindowSec: Math.round((cfg.mode?.followUp?.windowMs ?? 90000) / 1000),
      },
      features: {
        search: cfg.search?.enabled,
        calc: cfg.calc?.enabled,
        datetime: cfg.tools?.datetime,
        random: cfg.tools?.random,
        fetchUrl: cfg.tools?.fetchUrl,
        vision: cfg.vision?.enabled,
        stickers: cfg.stickers?.enabled,
        ambient: cfg.ambient?.enabled,
        smartInject: cfg.ambient?.smartInject,
        adaptive: cfg.llm?.adaptive,
      },
    };
  } catch {
    return null;
  }
}

/** 面板显示用：config.json 的值 + 面板覆盖后的生效值 */
function effectiveSettings() {
  const base = readRawSettings();
  const control = loadControl();
  const out = {};
  for (const [group, fields] of Object.entries(SCHEMA)) {
    out[group] = {};
    for (const key of Object.keys(fields)) {
      const ov = control[group]?.[key];
      const df = base?.[group]?.[key];
      out[group][key] = {
        value: ov !== undefined ? ov : df,
        overridden: ov !== undefined,
        base: df,
      };
    }
  }
  return { groups: out, schema: SCHEMA, hasConfig: !!base };
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
  // 关系称号：不按固定列表校验。
  // 名单跟着角色卡走，前端下拉已经限制了可选值；后端再硬校验一次，
  // 换个角色卡就会把新称号当成非法值悄悄丢掉（这坑踩过两次）。
  // 真正无效的称号在渲染时会被忽略（relationLine 找不到就不输出），所以留脏值无害。
  if (typeof patch.bond === 'string') {
    const b = patch.bond.trim().slice(0, 24);
    if (b) cur.bond = b;
    else delete cur.bond;
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
        // 关系称号跟着当前角色卡走：黑眼的卡里是舞伴/母女/师徒……，枝堇的是闺蜜/恋人……
        bonds: activeBonds(),
        persona: activePersona() || '默认',
      });
    }

    if (p === '/api/control' && req.method === 'GET') {
      return json(res, 200, { ...effectiveSettings(), file: CONTROL_FILE });
    }

    if (p === '/api/control' && (req.method === 'PATCH' || req.method === 'POST')) {
      const body = await readBody(req);
      await saveControl(body?.control || body || {});
      return json(res, 200, { ok: true, ...effectiveSettings() });
    }

    if (p === '/api/runtime' && req.method === 'GET') {
      const snap = readJson(RUNTIME_FILE || '', null);
      return json(res, 200, {
        runtime: snap,
        hasBridge: !!BRIDGE_DIR,
        ageMs: snap?.at ? Date.now() - snap.at : null,
      });
    }

    if (p === '/api/logs' && req.method === 'GET') {
      const lines = Math.min(1000, Math.max(20, Number(url.searchParams.get('lines')) || 200));
      const q = (url.searchParams.get('q') || '').trim();
      let text = '';
      try {
        text = fs.readFileSync(LOG_FILE, 'utf8');
      } catch (e) {
        return json(res, 200, { lines: [], error: `读不到日志：${e.message}` });
      }
      let arr = text.split('\n');
      if (q) arr = arr.filter((l) => l.includes(q));
      arr = arr.filter((l) => l.trim()).slice(-lines);
      return json(res, 200, { lines: arr, file: LOG_FILE, total: arr.length });
    }

    if (p === '/api/persona' && req.method === 'GET') {
      const ctl = loadControl();
      const target = personaFilePath();
      let text = '';
      let error = null;
      try {
        text = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '');
      } catch (e) {
        error = e.message;
      }
      let fewshot = [];
      try {
        fewshot = fs.readdirSync(FEWSHOT_DIR).filter((f) => /\.(txt|md)$/i.test(f)).sort();
      } catch { /* 目录不存在就算了 */ }
      // 角色卡自带示范时，全局下拉就不该再起作用（换了角色口吻会被带偏）
      const active = activePersona();
      const ownFewshot =
        !!active && active !== '默认' && fs.existsSync(path.join(PERSONAS_DIR, active, 'fewshot.txt'));
      return json(res, 200, {
        text,
        error,
        file: target,
        fewshot,
        activeFewshot: ctl.persona?.fewshot ?? (CFG_RAW.llm?.fewShotFile || ''),
        overridden: ctl.persona?.fewshot !== undefined,
        personas: listPersonas(),
        activePersona: active || '默认',
        personaOverridden: ctl.persona?.file !== undefined,
        hasOwnFewshot: ownFewshot,
        relations: personaRelations(active),
      });
    }

    if (p === '/api/persona' && (req.method === 'POST' || req.method === 'PUT')) {
      const body = await readBody(req, 512 * 1024);
      if (typeof body.text !== 'string') return json(res, 400, { error: '缺少 text' });
      try {
        // 改之前留一份备份，人设写坏了能捞回来
        const dest = personaFilePath();
        const bak = `${dest}.bak-${Date.now()}`;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(dest)) fs.copyFileSync(dest, bak);
        fs.writeFileSync(dest, body.text, 'utf8');
        return json(res, 200, { ok: true, bytes: Buffer.byteLength(body.text), backup: path.basename(bak), file: dest });
      } catch (e) {
        return json(res, 500, { error: `写入失败：${e.message}` });
      }
    }

    if (p === '/api/sets' && req.method === 'GET') {
      const ctl = loadControl();
      const active = ctl.sticker?.activeSet ?? CFG_RAW.stickers?.activeSet ?? '';
      const sets = [];
      try {
        for (const d of fs.readdirSync(STICKERS_DIR, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const dir = path.join(STICKERS_DIR, d.name);
          const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
          if (!files.length) continue;
          // 每个套装取前 12 个当预览
          sets.push({
            name: d.name,
            count: files.length,
            preview: files.slice(0, 12).map((f) => ({ file: f, mood: f.replace(/\.[^.]+$/, '') })),
          });
        }
      } catch (e) {
        return json(res, 200, { sets: [], active, error: e.message });
      }
      return json(res, 200, { sets, active });
    }

    // 表情图片：只允许读 STICKERS_DIR 里的文件
    if (p === '/api/sticker' && req.method === 'GET') {
      const setName = url.searchParams.get('set') || '';
      const file = url.searchParams.get('file') || '';
      const target = path.join(STICKERS_DIR, setName, path.basename(file));
      if (!target.startsWith(STICKERS_DIR) || !fs.existsSync(target)) return json(res, 404, { error: '没有这张图' });
      const buf = fs.readFileSync(target);
      const mime = file.toLowerCase().endsWith('.gif')
        ? 'image/gif'
        : file.toLowerCase().endsWith('.webp')
          ? 'image/webp'
          : file.toLowerCase().endsWith('.png')
            ? 'image/png'
            : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'Cache-Control': 'max-age=300' });
      return res.end(buf);
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
      // 关系称号：空字符串 = 取消（saveOverride 里会删掉这个键）
      if (typeof body.bond === 'string') patch.bond = body.bond;

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
