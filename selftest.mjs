// 端到端自测：用假的 NapCat(OneBot) 服务端 + 假的模型接口，把 bridge.mjs 真跑一遍
// 用法：node selftest.mjs
//
// 覆盖点：
//   1  连接、get_login_info、就绪
//   2  群 @ 触发回答，Markdown 清洗成纯文本，回复带 @ 与引用
//   3  今天日期已注入 system（不用联网问日期）
//   4  首个私聊者自动绑定为管理员
//   5  管理指令 /status 各字段
//   6  私聊 /off 断开
//   7  断开后群里完全静默
//   8  私聊 /on 恢复
//   9  非管理员私聊被忽略
//  10  群聊被动上下文：非 @ 消息只记录不出声，@ 时按需注入背景（含相对时间）
//  10b 主动插话：提到名字但没 @ 也能接一句、不带 @/引用、冷却生效、闲聊不插
//  10c 用量统计：usage（含前缀缓存命中率）落到日志
//  11  工具闭环：calc / time_diff / random / fetch_url（内网必须被拦）/
//      send_sticker（表情图片 + 无节流 + /sticker 指令）
//  12  长回复分片且不超过条数上限
//  13  断线自动重连
//  14  /ctx 查看与清空群聊背景
//  15  频率限制
//  16  纯函数回归：会话隔离 / 图片提取 / 搜索解析 / 计算器 / 日期 / 随机 /
//      读网页安全门禁与正文提取 / 搜索谓词 / 背景按需判定 / 相对时间 /
//      分段规则 / 表情库（匹配、取图、无节流、回退）/ 难度判定 / 摘要压缩 /
//      背景过滤 / few-shot 加载
//  17  首次连接失败不得导致进程退出（回归）
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { wsServe } from './src/ws.mjs';
import {
  sessionKey,
  summarizeLocal,
  getContext,
  pushHistory,
  clearHistory,
  classifyDifficulty,
  searchPredicate,
} from './src/llm.mjs';
import { extractContent, OneBot } from './src/onebot.mjs';
import { MemberStore } from './src/members.mjs';
import { InitiativeEngine } from './src/initiative.mjs';
import { StickerSense, decideStickerReply } from './src/stickersense.mjs';
import { loadConfig } from './src/config.mjs';
import { parseBing } from './src/search.mjs';
import { evaluateExpression } from './src/calc.mjs';
import { computeTimeDiff, parseDateLoose, dayDiff } from './src/datetime.mjs';
import { rollDice, pickOne, randomInt } from './src/random.mjs';
import { htmlToText, extractTitle, isBlockedIp, isBlockedHost } from './src/fetchpage.mjs';
import { AmbientBuffer, isFiller, needBackground, relTime } from './src/ambient.mjs';
import { splitMessage } from './src/text.mjs';
import { StickerLibrary } from './src/stickers.mjs';

/** 1×1 的合法 PNG，用作测试表情包素材 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, '.selftest');
const LOGIN_ID = 1000000001; // 假机器人自己的 QQ 号
const ADMIN_ID = 1000000002;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 10000, interval = 80, label = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeout) throw new Error(`等待超时：${label}`);
    await sleep(interval);
  }
}

// ---------------- 断言 ----------------
const results = [];
function check(name, cond, extra = '') {
  const ok = !!cond;
  results.push({ name, ok });
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${extra ? '   [' + extra + ']' : ''}`);
}

// ---------------- 假模型接口 ----------------
const REPLY_MD = '**你好**，这是测试回复。\n\n- 第一点\n- 第二点';
const REPLY_SHORT = '好。'; // 单段回复，用于数消息条数的用例
const REPLY_LONG = '这是一段较长的回答。'.repeat(120); // 约 1200 字，会触发分片
const llmReqs = [];
let llmMode = 'md'; // md | short | long | calc | time | random | fetch | sticker

/** 各模式让模型"请求"哪个工具，以及拿到工具结果后回什么 */
const TOOL_PLAN = {
  calc: { call: { name: 'calc', arguments: '{"expression":"1234*0.15"}' }, after: '算出来是 185.1 呀～' },
  time: { call: { name: 'time_diff', arguments: '{"to":"明天"}' }, after: '就剩 1 天咯～' },
  random: { call: { name: 'random', arguments: '{"dice":"3d6"}' }, after: '摇好啦～' },
  fetch: { call: { name: 'fetch_url', arguments: '{"url":"http://127.0.0.1:9999/secret"}' }, after: '这个读不到～' },
  sticker: { call: { name: 'send_sticker', arguments: '{"mood":"大笑"}' }, after: '哈哈哈笑死我了～' },
};

function json(res, o) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(o));
}

const api = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const u = req.url || '';
    if (u.endsWith('/chat/completions')) {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        /* 忽略 */
      }
      llmReqs.push(body);
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const hasToolResult = msgs.some((m) => m.role === 'tool');
      const plan = TOOL_PLAN[llmMode];
      const usage = {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 20,
      };
      if (plan && !hasToolResult) {
        return json(res, {
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'call_1', type: 'function', function: plan.call }],
              },
            },
          ],
          usage,
        });
      }
      const content =
        llmMode === 'long' ? REPLY_LONG : llmMode === 'short' ? REPLY_SHORT : plan ? plan.after : REPLY_MD;
      return json(res, { choices: [{ message: { role: 'assistant', content } }], usage });
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});

/** 最后一条发给模型的 user 消息的纯文本 */
function lastUserText() {
  for (let i = llmReqs.length - 1; i >= 0; i -= 1) {
    const msgs = llmReqs[i].messages || [];
    for (let j = msgs.length - 1; j >= 0; j -= 1) {
      if (msgs[j].role !== 'user') continue;
      const c = msgs[j].content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.filter((x) => x.type === 'text').map((x) => x.text).join('');
    }
  }
  return '';
}
function firstSystemText() {
  for (const r of llmReqs) {
    const m = (r.messages || [])[0];
    if (m && m.role === 'system') return String(m.content);
  }
  return '';
}

// ---------------- 假 NapCat(OneBot) 服务端 ----------------
let sentGroup = [];
let sentPrivate = [];
let obConn = null;
let obReady = false;
let msgSeq = 0;

async function startOneBotMock() {
  return wsServe((conn) => {
    obConn = conn;
    conn.on('error', () => {
      /* 测试收尾阶段的连接重置，忽略 */
    });
    conn.on('message', (raw) => {
      let p;
      try {
        p = JSON.parse(raw);
      } catch {
        return;
      }
      const ok = (data) => conn.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: p.echo }));
      if (p.action === 'get_login_info') {
        obReady = true;
        ok({ user_id: LOGIN_ID, nickname: '假机器人' });
      } else if (p.action === 'send_group_msg') {
        sentGroup.push(p.params);
        ok({ message_id: sentGroup.length });
      } else if (p.action === 'send_private_msg') {
        sentPrivate.push(p.params);
        ok({ message_id: 9000 + sentPrivate.length });
      } else {
        ok({});
      }
    });
  });
}

function pushGroup({ groupId = 12345, userId = 67890, name = '群友', text = '', at = false, images = [] } = {}) {
  const message = [];
  if (at) message.push({ type: 'at', data: { qq: String(LOGIN_ID) } });
  message.push({ type: 'text', data: { text } });
  for (const u of images) message.push({ type: 'image', data: { url: u } });
  msgSeq += 1;
  obConn.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      group_id: groupId,
      user_id: userId,
      message_id: 500 + msgSeq,
      self_id: LOGIN_ID,
      sender: { card: name, nickname: name },
      message,
    })
  );
}

function pushPrivate({ userId = ADMIN_ID, text = '' } = {}) {
  msgSeq += 1;
  obConn.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      user_id: userId,
      message_id: 800 + msgSeq,
      self_id: LOGIN_ID,
      sender: { nickname: '管理员' },
      message: [{ type: 'text', data: { text } }],
    })
  );
}

const segText = (params) => (params.message || []).filter((s) => s.type === 'text').map((s) => s.data.text).join('');
const hasSeg = (params, type) => (params.message || []).some((s) => s.type === type);

// ---------------- 启动一个 bridge ----------------
function startBridge(name, cfgObj) {
  const cfgPath = path.join(TMP, `config-${name}.json`);
  // 每个实例用自己的成员档案文件，避免几个 bridge 并发写同一个文件
  cfgObj.members = cfgObj.members || {};
  if (!cfgObj.members.file) cfgObj.members.file = `data/members-${name}.json`;
  if (cfgObj.members.flushMs == null) cfgObj.members.flushMs = 400;
  fs.writeFileSync(cfgPath, JSON.stringify(cfgObj, null, 2));
  let out = '';
  const proc = spawn(process.execPath, [path.join(HERE, 'bridge.mjs')], {
    env: { ...process.env, QQ_BRIDGE_CONFIG: cfgPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => (out += d.toString()));
  proc.stderr.on('data', (d) => (out += d.toString()));
  return { proc, log: () => out };
}

function mkCfg(apiPort, wsPort, over = {}) {
  const base = {
    transport: 'onebot',
    onebot: { wsUrl: `ws://127.0.0.1:${wsPort}`, reconnectBaseMs: 300, reconnectMaxMs: 2000 },
    bot: { admins: [], allowedGroups: [], replyWithQuote: true },
    // 连续对话默认关掉：主流程那几十条断言都建立在"没 @ 就不出声"上，
    // 这个特性单独用一个 bridge 实例验证（见后面"连续对话"那一节）
    mode: {
      enabledOnStart: true,
      requireAt: true,
      groupShareContext: true,
      followUp: { enabled: false, windowMs: 180000 },
    },
    limits: { enabled: false }, // 功能用例里关限流，限流单独验证
    llm: {
      systemPromptFile: '', // 测试目录没有 persona.txt，关掉文件加载
      fewShotFile: '', // 测试目录没有 fewshot/，同样关掉
      baseUrl: `http://127.0.0.1:${apiPort}/v1`,
      apiKey: 'mock-key',
      model: 'mock-model',
      timeoutMs: 10000,
      historyLimit: 12,
      historyCompactAt: 24,
      systemPrompt: '你是测试助手',
    },
    ambient: { enabled: true, smartInject: true, maxKeep: 30, injectItems: 8, injectMaxChars: 500, minLen: 2 },
    stickers: { enabled: true, dir: 'stickers', activeSet: '测试套', position: 'after' },
    // 主动插话：测试里开着，触发词用机器人昵称，冷却 60s 便于验证"连着叫不会连插"
    proactive: {
      enabled: true,
      names: ['假机器人'],
      onQuestion: false,
      minIntervalMs: 60000,
      dailyLimit: 100,
      windowMs: 600000,
      minActivity: 1,
      // 主动发起：开着但扫描间隔拉长到 60s，测试期间不会真的触发（只验证接线）
      initiative: { enabled: true, scanEveryMs: 60000 },
    },
    calc: { enabled: true },
    search: { enabled: true, maxResults: 5, cooldownMs: 15000, maxRoundsPerReply: 2 },
    output: { maxCharsPerMessage: 900, maxPartsGroup: 5, maxPartsPrivate: 4 },
    logFile: 'logs/selftest.log',
    stateFile: 'state.json',
  };
  return { ...base, ...over };
}

// ---------------- 主流程 ----------------
async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  // 造一套测试用表情包素材（两个情绪，各一张 1×1 PNG）
  {
    const sd = path.join(TMP, 'stickers', '测试套');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, '大笑.png'), PNG_1X1);
    fs.writeFileSync(path.join(sd, '卖萌.png'), PNG_1X1);
  }

  const ws = await startOneBotMock();
  await new Promise((r) => api.listen(0, '127.0.0.1', () => r()));
  const apiPort = api.address().port;

  const bridge = startBridge('main', mkCfg(apiPort, ws.port));

  try {
    console.log('\n--- 1. 连接与就绪 ---');
    await waitFor(() => obConn && obReady, { label: 'bridge 完成 get_login_info' });
    await sleep(300);
    check('OneBot 连接 + get_login_info 成功', obReady);
    check(
      '接线：主动发起的定时器已启动',
      bridge.log().includes('主动发起已启动'),
      (bridge.log().match(/\[router\] 主动发起已启动[^\n]*/) || [''])[0].slice(0, 90)
    );

    console.log('\n--- 2. 群 @ 触发回答 ---');
    pushGroup({ text: '你好', at: true, name: '群友甲' });
    await waitFor(() => sentGroup.length > 0, { label: '群消息回复' });
    const g1 = sentGroup[0];
    check('群 @ 触发模型回答', sentGroup.length > 0);
    check(
      'Markdown 已清洗为纯文本',
      segText(g1).includes('你好，这是测试回复。') && !segText(g1).includes('**'),
      segText(g1).slice(0, 40)
    );
    check('回复里 @ 了提问者', hasSeg(g1, 'at'));
    check('回复引用了原消息', hasSeg(g1, 'reply'));

    // 成员档案的端到端验证：消息要让 router 真的记进去并落盘
    console.log('\n--- 2b. 成员档案端到端 ---');
    {
      // 再补一条非 @ 的普通发言：档案应该把"没 @ 的"也记下来
      pushGroup({ text: '随手说一句', at: false, name: '群友乙', userId: 67891 });
      await sleep(1200); // 等 flushMs(400ms) 触发一次落盘

      const memPath = path.join(TMP, 'data', 'members-main.json');
      const exists = fs.existsSync(memPath);
      check('档案：bridge 已生成 data/members.json', exists, memPath);
      if (exists) {
        const doc = JSON.parse(fs.readFileSync(memPath, 'utf8'));
        const atUser = doc.members.find((x) => x.qq === '67890');
        const plainUser = doc.members.find((x) => x.qq === '67891');
        check('档案：@ 过机器人的群友被记录', !!atUser && atUser.stats.ats === 1, JSON.stringify(atUser?.stats));
        check('档案：没 @ 的群友也被记录（不只是回答过的）', !!plainUser && plainUser.stats.messages === 1, JSON.stringify(plainUser?.stats));
        // 规则：被 @ 一次 +2，且不再额外叠加"普通发言 +1"
        check('档案：被 @ 的加成生效（+2，不重复计发言分）', atUser?.affinity === 2, String(atUser?.affinity));
        check('档案：机器人回过它记了数', (atUser?.stats.replies ?? 0) === 1, String(atUser?.stats.replies));
        check('档案：文件结构带版本号', doc.version === 1 && Array.isArray(doc.members), `v${doc.version}`);
      }
    }
    check(
      '背景按需注入：自足的问题不带群聊背景',
      !lastUserText().includes('【群里刚才聊到'),
      lastUserText().split('\n')[0].slice(0, 34)
    );

    console.log('\n--- 3. 今天日期已注入 system ---');
    const sys1 = firstSystemText();
    check('system 里带有今天日期', /今天日期：\d{4}-\d{2}-\d{2} 星期[日一二三四五六]。/.test(sys1), sys1.slice(-28));
    check('日期行追加在人设之后（前缀仍然稳定）', sys1.startsWith('你是测试助手'), sys1.slice(0, 12));

    console.log('\n--- 4. 首个私聊者自动绑定为管理员 ---');
    pushPrivate({ text: '你好' });
    await waitFor(() => sentPrivate.some((x) => segText(x).includes('绑定为管理员')), { label: '绑定提示' });
    check('首个私聊者自动绑定为管理员', sentPrivate.some((x) => segText(x).includes('绑定为管理员')));

    console.log('\n--- 5. 管理指令 /status ---');
    const beforeStatus = sentPrivate.length;
    pushPrivate({ text: '/status' });
    await waitFor(() => sentPrivate.length > beforeStatus, { label: '/status 回复' });
    const st = segText(sentPrivate[sentPrivate.length - 1]);
    check('/status 返回当前状态', st.includes('已接入') && st.includes('mock-model'), st.split('\n')[0]);
    check('  · 展示群聊背景开关', st.includes('群聊背景：开'), (st.split('\n').find((l) => l.startsWith('群聊背景')) || '').slice(0, 30));
    check('  · 展示模型档位', st.includes('模型档位：自适应'), (st.split('\n').find((l) => l.startsWith('模型档位')) || '').slice(0, 30));
    check('  · 展示工具开关', st.includes('工具：') && st.includes('计算器开') && st.includes('读网页开'), (st.split('\n').find((l) => l.startsWith('工具：')) || '').slice(0, 40));
    check('  · 展示按需注入与跳过次数', st.includes('按需注入：开'), (st.split('\n').find((l) => l.startsWith('群聊背景')) || '').slice(0, 40));
    check('  · 展示主动插话开关', st.includes('主动插话：'), (st.split('\n').find((l) => l.startsWith('主动插话')) || '').slice(0, 40));
    check(
      '  · 展示 token 用量与前缀缓存命中率',
      /用量（本次运行）：输入 \d+/.test(st),
      (st.split('\n').find((l) => l.startsWith('用量')) || '').slice(0, 70)
    );

    console.log('\n--- 6. 私聊 /off 断开 ---');
    pushPrivate({ text: '/off' });
    await waitFor(() => sentPrivate.some((x) => segText(x).includes('已断开')), { label: '/off 回复' });
    check('/off 生效并确认', true);

    console.log('\n--- 7. 断开后群聊完全静默 ---');
    const beforeSilent = sentGroup.length;
    pushGroup({ text: '在吗', at: true });
    await sleep(1200);
    check('断开状态下群里没有任何回应', sentGroup.length === beforeSilent, `消息数 ${beforeSilent} -> ${sentGroup.length}`);

    console.log('\n--- 8. 私聊 /on 恢复 ---');
    pushPrivate({ text: '/on' });
    await waitFor(() => sentPrivate.some((x) => segText(x).includes('已接入。群里')), { label: '/on 回复' });
    const beforeResume = sentGroup.length;
    pushGroup({ text: '恢复了吗', at: true });
    await waitFor(() => sentGroup.length > beforeResume, { label: '恢复后的群回复' });
    check('恢复后群聊重新响应', true);

    console.log('\n--- 9. 非管理员私聊被忽略 ---');
    const beforeStranger = sentPrivate.length;
    pushPrivate({ text: '/off', userId: 999888777 });
    await sleep(1200);
    check('非管理员私聊被静默忽略', sentPrivate.length === beforeStranger, `消息数 ${beforeStranger} -> ${sentPrivate.length}`);

    console.log('\n--- 10. 群聊被动上下文 ---');
    const beforeAmbient = sentGroup.length;
    pushGroup({ text: '咱们那个 7116 充电器项目要改成双通道', name: '老王' });
    pushGroup({ text: '温度保护也得一起加上', name: '小李' });
    await sleep(400);
    check('非 @ 消息只记录、不出声', sentGroup.length === beforeAmbient, `消息数 ${beforeAmbient} -> ${sentGroup.length}`);
    pushGroup({ text: '那个方案靠谱吗', at: true, name: '群友乙' });
    await waitFor(() => sentGroup.length > beforeAmbient, { label: '带背景的群回复' });
    const bgUser = lastUserText();
    check('背景已注入当前消息', bgUser.includes('【群里刚才聊到'), bgUser.slice(0, 36).replace(/\n/g, '⏎'));
    check('背景含之前聊到的内容', bgUser.includes('老王') && bgUser.includes('7116 充电器项目'), bgUser.split('\n').slice(1, 3).join(' | '));
    check('背景每行带相对时间', /^(刚刚|\d+ (分钟|小时)前|\d+ 天前) /.test(bgUser.split('\n').find((l) => l.includes('老王')) || ''), bgUser.split('\n')[0].slice(0, 40));

    console.log('\n--- 10b. 主动插话（不被 @ 也能接一句） ---');
    llmMode = 'short';
    const beforeChime = sentGroup.length;
    pushGroup({ text: '假机器人 你说这方案行不行', name: '老王' }); // 提到名字但没 @
    await waitFor(() => sentGroup.length > beforeChime, { label: '主动插话' });
    await sleep(400);
    const chimeMsgs = sentGroup.slice(beforeChime);
    check('提到名字但没 @ 也能主动接一句', chimeMsgs.length >= 1, `${chimeMsgs.length} 条`);
    check(
      '插话不带 @ 也不带引用（像群友随口接的一句）',
      chimeMsgs.every((p) => !hasSeg(p, 'at') && !hasSeg(p, 'reply')),
      chimeMsgs.map((p) => p.message.map((s) => s.type).join('+')).join(' / ')
    );

    const beforeChime2 = sentGroup.length;
    pushGroup({ text: '假机器人 那你说呢', name: '老王' });
    await sleep(1500);
    check('冷却期内不会连着插话', sentGroup.length === beforeChime2, `多出 ${sentGroup.length - beforeChime2} 条`);

    const beforeChime3 = sentGroup.length;
    pushGroup({ text: '今天这天气是真的热啊', name: '小李' });
    await sleep(1200);
    check('没提到名字的闲聊不会插话', sentGroup.length === beforeChime3, `多出 ${sentGroup.length - beforeChime3} 条`);
    llmMode = 'md';

    console.log('\n--- 10c. 用量统计 ---');
    check(
      '日志里记录了 token 用量与前缀缓存命中率',
      /用量 输入 \d+（缓存命中 \d+\/\d+，\d+%）/.test(bridge.log()),
      ((bridge.log().match(/用量 [^\n]*/) || ['(无)'])[0] || '').slice(0, 80)
    );

    console.log('\n--- 11. 工具闭环 ---');
    // 跑一次"模型请求工具 → 本地执行 → 模型据结果作答"的完整回合
    const toolRound = async (mode, text, label, expect) => {
      llmMode = mode;
      const before = sentGroup.length;
      const reqBefore = llmReqs.length;
      pushGroup({ text, at: true, name: '工具测试' });
      await waitFor(() => sentGroup.length > before, { label: `${label} 回答` });
      const reqs = llmReqs.slice(reqBefore);
      const toolMsg = reqs.flatMap((r) => r.messages || []).find((m) => m.role === 'tool');
      const content = toolMsg ? String(toolMsg.content) : '';
      check(`${label}：工具被调用且结果正确`, expect.test(content), content.slice(0, 70).replace(/\n/g, ' '));
      return reqs;
    };

    llmMode = 'calc';
    const reqsCalc = await toolRound('calc', '帮我算 1234*0.15', '计算器 calc', /1234\*0\.15 = 185\.1/);
    const withTools = reqsCalc.find((r) => (r.tools || []).length);
    const names = withTools ? withTools.tools.map((t) => t.function?.name) : [];
    check('请求里带齐 6 个工具', names.length === 6, names.join(',') || '(无)');
    check(
      '工具清单含 web_search/calc/time_diff/random/fetch_url/send_sticker',
      ['web_search', 'calc', 'time_diff', 'random', 'fetch_url', 'send_sticker'].every((n) => names.includes(n))
    );
    check('拿到计算结果后由模型给出最终答案', segText(sentGroup[sentGroup.length - 1]).includes('185.1'));

    await toolRound('time', '帮我算算离明天还有几天', '日期 time_diff', /相差 1 天/);
    await toolRound('random', '帮我掷三个骰子', '随机 random', /🎲 3d6：/);
    await toolRound('fetch', '帮我看看这个链接', '读网页 fetch_url（内网必须被拦）', /内网/);

    // ---- 表情包 ----
    const reqsSticker = await toolRound('sticker', '哈哈哈你太逗了', '表情包 send_sticker', /已发出表情包：大笑/);
    const imgMsgs = () => sentGroup.filter((p) => (p.message || []).some((s) => s.type === 'image'));
    check('表情真的作为图片发出去了', imgMsgs().length === 1, `${imgMsgs().length} 条带图`);
    check(
      '表情是独立一条消息（不带 @ / 引用）',
      !!imgMsgs()[0] && !hasSeg(imgMsgs()[0], 'at') && !hasSeg(imgMsgs()[0], 'reply'),
      imgMsgs()[0] ? `段：${imgMsgs()[0].message.map((s) => s.type).join('+')}` : '(无)'
    );
    const imgSeg = imgMsgs()[0] ? imgMsgs()[0].message.find((s) => s.type === 'image') : null;
    check(
      '表情文件名对应情绪名',
      !!imgSeg && String(imgSeg.data.file).includes('大笑'),
      imgSeg ? path.basename(String(imgSeg.data.file)) : '(无)'
    );
    check(
      '工具清单里出现了 send_sticker',
      reqsSticker.some((r) => (r.tools || []).some((t) => t.function?.name === 'send_sticker'))
    );

    // 没有冷却 —— 紧接着再要一次照样能发（这是本轮明确要求的改动）
    pushGroup({ text: '再发一个', at: true, name: '笑点低' });
    await waitFor(() => imgMsgs().length > 1, { label: '第二张表情' });
    check('没有冷却：紧接着还能再发一张', imgMsgs().length === 2, `${imgMsgs().length} 条带图`);
    check(
      '第二张同样是独立消息',
      (() => {
        const m = imgMsgs()[1];
        return !!m && !hasSeg(m, 'at') && !hasSeg(m, 'reply');
      })()
    );

    // 私聊指令 /sticker
    const beforeCmd = sentPrivate.length;
    pushPrivate({ text: '/sticker 卖萌' });
    await waitFor(() => sentPrivate.length > beforeCmd + 1, { label: '/sticker 试发' });
    check(
      '/sticker 情绪名 能立刻试发一张',
      sentPrivate.slice(beforeCmd).some((p) => (p.message || []).some((s) => s.type === 'image'))
    );
    const beforeList = sentPrivate.length;
    pushPrivate({ text: '/sticker list' });
    await waitFor(() => sentPrivate.length > beforeList, { label: '/sticker list' });
    check('/sticker list 列出套装与情绪', segText(sentPrivate[sentPrivate.length - 1]).includes('当前套装'), segText(sentPrivate[sentPrivate.length - 1]).split('\n')[0]);
    llmMode = 'md';

    console.log('\n--- 12. 长回复分片 ---');
    llmMode = 'long';
    const beforeLong = sentGroup.length;
    pushGroup({ text: '说长一点', at: true });
    await waitFor(() => sentGroup.length > beforeLong, { label: '长回复首片' });
    await sleep(1500);
    const longParts = sentGroup.slice(beforeLong);
    check('长回复被分片发送', longParts.length > 1, `${longParts.length} 片`);
    check('分片数不超过上限 5', longParts.length <= 5, `${longParts.length} 片`);
    check(
      '单片长度不超过上限 900 字（@ 后补的空格不计）',
      longParts.every((x) => segText(x).replace(/^ /, '').length <= 900),
      longParts.map((x) => segText(x).replace(/^ /, '').length).join(',')
    );
    check(
      '续发的那几条不再 @ 也不再引用（否则等于连发提醒）',
      longParts.slice(1).every((p) => !hasSeg(p, 'at') && !hasSeg(p, 'reply')),
      longParts.map((p) => p.message.map((s) => s.type).join('+')).join(' / ')
    );
    llmMode = 'md';

    console.log('\n--- 13. 断线自动重连 ---');
    const oldConn = obConn;
    obReady = false;
    oldConn.close();
    await waitFor(() => obConn !== oldConn && obReady, { label: '自动重连并重新取登录信息', timeout: 15000 });
    check('连接断开后自动重连', true);
    const beforeRe = sentGroup.length;
    pushGroup({ text: '重连后还在吗', at: true });
    await waitFor(() => sentGroup.length > beforeRe, { label: '重连后的群回复' });
    check('重连后仍能正常回答', true);

    console.log('\n--- 14. /ctx 查看与清空群聊背景 ---');
    const beforeCtx = sentPrivate.length;
    pushPrivate({ text: '/ctx' });
    await waitFor(() => sentPrivate.length > beforeCtx, { label: '/ctx 回复' });
    const ctxReply = segText(sentPrivate[sentPrivate.length - 1]);
    check(
      '/ctx 列出已记录的群聊背景',
      /群 \d+：已记 \d+ 条/.test(ctxReply) && /^.+：.+$/m.test(ctxReply),
      ctxReply.split('\n')[0]
    );
    const beforeCtxClear = sentPrivate.length;
    pushPrivate({ text: '/ctx clear' });
    await waitFor(() => sentPrivate.length > beforeCtxClear, { label: '/ctx clear 回复' });
    check('/ctx clear 能清空背景', segText(sentPrivate[sentPrivate.length - 1]).includes('已清空'));
    const beforeCtxAfter = sentPrivate.length;
    pushPrivate({ text: '/ctx' });
    await waitFor(() => sentPrivate.length > beforeCtxAfter, { label: '/ctx 复查' });
    check('清空后不再有背景记录', segText(sentPrivate[sentPrivate.length - 1]).includes('还没有记录到群聊背景'));
  } catch (e) {
    check(`执行中断：${e.message}`, false);
    console.log('--- bridge 运行日志（末尾 3000 字）---');
    console.log(bridge.log().slice(-3000));
  } finally {
    bridge.proc.kill();
    await sleep(200);
  }

  // ---------------- 15. 频率限制（独立实例） ----------------
  console.log('\n--- 15. 频率限制 ---');
  {
    llmMode = 'short'; // 单段回复，「一条消息 = 一次回答」才好数
    const obWs = await startOneBotMock();
    obReady = false;
    const rlSent = sentGroup;
    sentGroup = [];
    const rlCfg = mkCfg(apiPort, obWs.port, {
      limits: { enabled: true, userCooldownMs: 0, sessionCooldownMs: 2000, maxConcurrent: 3, hourlyLimitPerSession: 60, notifyOnLimit: true },
      logFile: 'logs/selftest-limits.log',
      stateFile: 'state-limits.json',
    });
    const rl = startBridge('limits', rlCfg);
    try {
      await waitFor(() => obConn && obReady, { label: '限流实例就绪' });
      await sleep(300);
      pushGroup({ text: '问题一', at: true, userId: 10001 });
      await waitFor(() => sentGroup.length >= 1, { label: '第一条正常回复' });
      check('限流：首条请求正常放行', sentGroup.length === 1);

      // 换个用户，避开用户级冷却，只撞会话级冷却
      pushGroup({ text: '问题二', at: true, userId: 10002 });
      await sleep(800);
      check('限流：会话冷却拦截第二条且静默', sentGroup.length === 1, `回复数 ${sentGroup.length}`);

      await sleep(1600);
      pushGroup({ text: '问题三', at: true, userId: 10003 });
      await waitFor(() => sentGroup.length >= 2, { label: '冷却结束后恢复' });
      check('限流：冷却期过后恢复响应', sentGroup.length === 2);
    } catch (e) {
      check(`限流测试失败：${e.message}`, false);
      console.log('--- 限流实例日志 ---');
      console.log(rl.log().slice(-1200));
    } finally {
      rl.proc.kill();
      await sleep(200);
      await obWs.close();
      sentGroup = rlSent;
      llmMode = 'md';
    }
  }

  // ---------------- 16. 纯函数回归 ----------------
  console.log('\n--- 16. 纯函数回归 ---');
  {
    const kA = sessionKey({ scene: 'group', sceneId: 'GRP_A', userId: 'U1' }, true);
    const kB = sessionKey({ scene: 'group', sceneId: 'GRP_B', userId: 'U1' }, true);
    const kP = sessionKey({ scene: 'private', sceneId: 'OPENID_X' }, true);
    check('会话隔离：不同群 key 不同', kA !== kB, `${kA} vs ${kB}`);
    check('会话隔离：私聊 key 正确', kP === 'private:OPENID_X', kP);
    check('会话隔离：key 不含 undefined', !kA.includes('undefined') && !kP.includes('undefined'));

    const e1 = extractContent({
      message: [
        { type: 'image', data: { url: 'https://example.com/a.png' } },
        { type: 'text', data: { text: ' 这是什么' } },
      ],
    });
    check('图片提取：拿到 URL 而非 "[图片]"', e1.images.length === 1 && e1.text === '这是什么', JSON.stringify(e1));

    const e2 = extractContent({ raw_message: '[CQ:at,qq=123][CQ:image,url=https://example.com/b.jpg]看看' });
    check('图片提取：CQ 字符串格式也能取到', e2.images.length === 1 && e2.ats.includes('123'), JSON.stringify(e2));

    const html =
      '<ol><li class="b_algo"><h2><a href="https://a.com/x">标题甲</a></h2><p>摘要甲 &amp; 内容</p></li>' +
      '<li class="b_algo"><h2><a href="https://b.com/y">标题乙</a></h2><p>摘要乙</p></li></ol>';
    const parsed = parseBing(html, 5);
    check(
      '搜索解析：条目数与字段正确',
      parsed.length === 2 && parsed[0].title === '标题甲' && parsed[0].url === 'https://a.com/x',
      JSON.stringify(parsed[0])
    );
    check('搜索解析：HTML 实体已还原', parsed[0].snippet === '摘要甲 & 内容', parsed[0].snippet);

    check('计算器：四则运算', evaluateExpression('(88+12)/4').value === 25);
    check('计算器：百分比', evaluateExpression('1234*15%').value === 185.1, String(evaluateExpression('1234*15%').value));
    check('计算器：浮点误差已收敛', evaluateExpression('0.1+0.2').value === 0.3);
    check('计算器：除零被拦', evaluateExpression('1/0').ok === false, evaluateExpression('1/0').error);
    check('计算器：拒绝非数学内容', evaluateExpression('process.exit(1)').ok === false);

    // ---- 日期工具 ----
    const NOW = new Date(2026, 8, 30); // 2026-09-30
    const td1 = computeTimeDiff({ to: '2026-10-01' }, NOW);
    check('日期：相差天数正确', td1.ok && td1.days === 1, td1.ok ? td1.text : td1.error);
    check('日期：结果带星期几', td1.ok && td1.text.includes('星期四'), td1.ok ? td1.text : '');
    check('日期：支持「明天」', computeTimeDiff({ to: '明天' }, NOW).days === 1);
    check('日期：支持「10月1号」写法', (parseDateLoose('10月1号', NOW) || { getMonth: () => -1 }).getMonth() === 9);
    const bad = computeTimeDiff({ to: '2026-02-30' }, NOW);
    check('日期：不存在的日期被拦', bad.ok === false, bad.error);
    check('日期：跨月天数正确', dayDiff(new Date(2026, 8, 30), new Date(2026, 9, 3)) === 3);

    // ---- 随机工具 ----
    const d3 = rollDice('3d6');
    check('随机：3d6 结果落在 3~18', d3.ok && d3.total >= 3 && d3.total <= 18, d3.ok ? d3.text : d3.error);
    check('随机：非法骰子写法被拦', rollDice('abc').ok === false);
    const pk = pickOne(['甲', '乙', '丙']);
    check('随机：抽签结果来自候选', pk.ok && ['甲', '乙', '丙'].includes(pk.picked), pk.ok ? pk.text : pk.error);
    check('随机：空候选被拦', pickOne([]).ok === false);
    check('随机：单一范围整数正确', randomInt(7, 7).value === 7);

    // ---- 读网页：安全门禁（关键）----
    check(
      '读网页：挡掉本机/内网/元数据地址',
      isBlockedIp('127.0.0.1') &&
        isBlockedIp('10.0.0.5') &&
        isBlockedIp('192.168.1.1') &&
        isBlockedIp('169.254.169.254') &&
        isBlockedIp('::1')
    );
    check('读网页：放行公网 IP', !isBlockedIp('8.8.8.8') && !isBlockedIp('1.1.1.1'));
    check('读网页：挡掉 localhost / .local', isBlockedHost('localhost') && isBlockedHost('foo.local') && isBlockedHost('127.0.0.1'));
    check('读网页：放行普通域名', !isBlockedHost('example.com'));
    const sampleHtml =
      '<html><head><title>页面标题</title><style>.a{color:red}</style></head><body>' +
      '<p>你好&amp;世界</p><script>bad()</script><div>第二段</div></body></html>';
    const plain = htmlToText(sampleHtml);
    check(
      '读网页：HTML 转纯文本正确',
      plain.includes('你好&世界') && plain.includes('第二段') && !plain.includes('bad(') && !plain.includes('color:red'),
      plain.replace(/\n/g, '⏎')
    );
    check('读网页：标题提取正确', extractTitle(sampleHtml) === '页面标题', extractTitle(sampleHtml));

    // ---- 搜索谓词（规则前置）----
    check('搜索规则：时效问题给提示', searchPredicate('最近有什么 AI 大新闻') === 'hint');
    check('搜索规则：明确要求查→提示', searchPredicate('帮我查一下明天天气') === 'hint');
    check(
      '搜索规则：闲聊不提示',
      searchPredicate('你好呀') === 'allow' && searchPredicate('最近好吗') === 'allow',
      `${searchPredicate('你好呀')}/${searchPredicate('最近好吗')}`
    );
    check('搜索规则：算术不提示', searchPredicate('1+1 等于几') === 'allow');

    // ---- 表情包库 ----
    const sroot = path.join(TMP, 'stickers');
    const libA = new StickerLibrary({ activeSet: '测试套' }, sroot);
    check(
      '表情库：扫到套装与情绪',
      libA.setNames.includes('测试套') && libA.moods().includes('大笑'),
      `${libA.setNames.join(',')} / ${libA.moods().join(',')}`
    );
    check(
      '表情库：情绪名容错匹配',
      libA.resolveMood('大笑') === '大笑' && libA.resolveMood('大笑啦') === '大笑',
      String(libA.resolveMood('大笑啦'))
    );
    check('表情库：不存在的情绪返回空', libA.resolveMood('根本没这个') === null);
    const p1 = libA.pick('大笑');
    check('表情库：取到绝对路径的图', p1.ok && path.isAbsolute(p1.file) && p1.file.endsWith('.png'), p1.ok ? path.basename(p1.file) : p1.error);
    check('表情库：没有冷却，可以连着取', libA.pick('大笑').ok === true && libA.pick('大笑').ok === true);
    check('表情库：统计信息正确', libA.stats().moods === 2 && libA.stats().images === 2, JSON.stringify(libA.stats()));
    check('表情库：关掉时拒绝取图', new StickerLibrary({ enabled: false }, sroot).pick('大笑').ok === false);
    const libC = new StickerLibrary({ activeSet: '不存在的套装' }, sroot);
    check(
      '表情库：套装名写错时回退第一套并给出提示',
      libC.activeSet === '测试套' && libC.activeError.includes('找不到'),
      `${libC.activeSet} / ${libC.activeError}`
    );

    check('难度：闲聊判为 easy', classifyDifficulty('你好呀') === 'easy');
    check(
      '难度：分析类判为 hard',
      classifyDifficulty('帮我分析一下这个方案的架构设计有什么问题') === 'hard',
      String(classifyDifficulty('帮我分析一下这个方案的架构设计有什么问题'))
    );

    const sum = summarizeLocal([
      { role: 'user', content: '第一个问题'.repeat(20) },
      { role: 'assistant', content: '一段回答' },
      { role: 'user', content: '第二个问题' },
    ]);
    check('摘要：只取用户侧且截断', sum.includes('第一个问题') && sum.includes('第二个问题') && sum.length < 90, `${sum.length} 字`);

    const KEY = '__compact_test__';
    clearHistory(KEY);
    for (let i = 0; i < 30; i += 1) {
      pushHistory(KEY, i % 2 ? 'assistant' : 'user', `第${i}问`, { keep: 4, compactAt: 8, maxSummaryChars: 300 });
    }
    const ctx = getContext(KEY, 4);
    check('历史压缩：消息数压到 keep 附近', ctx.messages.length > 0 && ctx.messages.length <= 5, `${ctx.messages.length} 条`);
    check('历史压缩：摘要已生成', ctx.summary.length > 0, `${ctx.summary.length} 字`);
    clearHistory(KEY);

    check('背景过滤：水聊被挡掉', isFiller('哈哈哈') && isFiller('收到') && isFiller('') && isFiller('[表情]'));
    check('背景过滤：正常内容放行', !isFiller('今天开会改到三点') && !isFiller('这个方案我觉得可以'));

    const ab = new AmbientBuffer({ injectItems: 3, injectMaxChars: 1000 });
    for (const t of ['第一条', '第二条', '第三条', '第四条', '第五条']) ab.push('G1', { userName: 'U', text: t });
    check('背景快照：只取最近 injectItems 条', ab.snapshot('G1').split('\n').length === 3, ab.snapshot('G1').replace(/\n/g, ' | '));
    ab.push('G2', { userName: 'U', text: '哈哈' });
    check('背景：水聊不进缓冲', ab.size('G2') === 0);
    ab.push('G2', { userName: 'U', text: '这条有意义' });
    check('背景：正常内容进缓冲', ab.size('G2') === 1);
    check('背景快照带发言人', /^刚刚 U：这条有意义$/.test(ab.snapshot('G2')), ab.snapshot('G2'));

    // ---- 背景按需注入 ----
    check(
      '背景按需：指代/承接类问题才要背景',
      needBackground('那个方案靠谱吗') &&
        needBackground('刚才说的啥') &&
        needBackground('然后呢') &&
        needBackground('你怎么看这个')
    );
    check(
      '背景按需：自足的问题不要背景',
      !needBackground('1+1 等于几') && !needBackground('帮我算 1234*0.15') && !needBackground('你好呀')
    );
    check('背景按需：其他/其它 不算指代', !needBackground('其他人呢') && !needBackground('其它方案呢'));

    // ---- 相对时间 ----
    const t0 = Date.now();
    check('相对时间：刚刚', relTime(t0 - 5000, t0) === '刚刚');
    check('相对时间：分钟', relTime(t0 - 5 * 60000, t0) === '5 分钟前');
    check('相对时间：小时', relTime(t0 - 3 * 3600000, t0) === '3 小时前');
    const abT = new AmbientBuffer({ injectItems: 5, injectMaxChars: 999 });
    abT.push('G', { userName: '老王', text: '下午三点开会' });
    check('背景每行带相对时间', /^刚刚 老王：下午三点开会$/.test(abT.snapshot('G')), abT.snapshot('G'));
    check(
      '活跃度统计可用（插话闸门要用）',
      abT.recent('G', 60000) === 1 && abT.recent('别的群', 60000) === 0,
      `${abT.recent('G', 60000)} / ${abT.recent('别的群', 60000)}`
    );

    // ---- 分片：一段 = 一条消息 ----
    const sp1 = splitMessage('第一段。\n\n第二段。\n\n第三段。', 900, 5);
    check('分片：空行分段各自成一条', sp1.length === 3, sp1.map((x) => x.length).join(','));
    check('分片：单段仍然只发一条', splitMessage('只有一段，没有空行。', 900, 5).length === 1);
    const sp3 = splitMessage('段一\n\n段二\n\n段三\n\n段四\n\n段五\n\n段六', 900, 3);
    check(
      '分片：超条数上限时合并尾部而不是丢弃',
      sp3.length === 3 && sp3[2].includes('段三') && sp3[2].includes('段六'),
      sp3.join(' | ')
    );
    const sp4 = splitMessage('这是一句话。'.repeat(300), 900, 5);
    check('分片：超长单段退化成按长度切', sp4.length > 1 && sp4.every((x) => x.length <= 900), sp4.map((x) => x.length).join(','));

    // few-shot 示范文件：应被追加在人设之后
    fs.writeFileSync(path.join(TMP, 'fs.txt'), '# 示范\n问：在吗？\n答：在的呀～');
    const fsCfgPath = path.join(TMP, 'config-fewshot.json');
    fs.writeFileSync(
      fsCfgPath,
      JSON.stringify({ llm: { systemPromptFile: '', systemPrompt: '基础人设', fewShotFile: 'fs.txt' } })
    );
    const fsCfg = loadConfig(fsCfgPath);
    check(
      'few-shot 文件被追加进 system prompt',
      fsCfg.llm.systemPrompt.includes('基础人设') && fsCfg.llm.systemPrompt.includes('答：在的呀～'),
      fsCfg.llm.systemPrompt.replace(/\n/g, '⏎')
    );
    check('few-shot 来源被记录（供启动日志打印）', fsCfg.__fewShotSource === 'fs.txt', String(fsCfg.__fewShotSource));
  }

  // ---------------- 17. 首次连不上不应导致进程退出（回归） ----------------
  // 背景：Node 内置 WebSocket「首次就连不上」时只触发 error、不触发 close（实测 v22.12.0）。
  // 早期重连只挂在 onclose 上，于是首次连接失败时没有任何定时器存活，
  // 事件循环清空 → 整个桥静默退出。这条用例守住它。
  console.log('\n--- 17. 首次连接失败的重连回归 ---');
  {
    const deadPort = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    const dead = startBridge(
      'deadport',
      mkCfg(apiPort, deadPort, {
        onebot: { wsUrl: `ws://127.0.0.1:${deadPort}`, reconnectBaseMs: 200, reconnectMaxMs: 500 },
        logFile: 'logs/selftest-dead.log',
        stateFile: 'state-dead.json',
      })
    );
    try {
      await sleep(2500);
      check('首次连不上时进程不退出（回归）', dead.proc.exitCode === null, `exitCode=${dead.proc.exitCode}`);
      check(
        '且留下了重连日志',
        dead.log().includes('连接不可用') && dead.log().includes('后重连'),
        (dead.log().split('后重连')[0] || '').slice(-24).replace(/\n/g, ' ')
      );
    } catch (e) {
      check(`重连回归测试失败：${e.message}`, false);
    } finally {
      dead.proc.kill();
      await sleep(200);
    }
  }

  console.log('\n--- 18. 成员档案（bridge 侧） ---');
  {
    const memDir = path.join(TMP, 'members');
    fs.rmSync(memDir, { recursive: true, force: true });
    const memFile = path.join(memDir, 'members.json');

    const store = new MemberStore({ file: memFile, flushMs: 100000, maxMembers: 3 });
    check('档案：初始为空', store.size === 0);

    store.record({ userId: '1001', userName: '甲' });
    store.record({ userId: '1001', userName: '甲', isAtMe: true });
    check('档案：普通发言 +1、被 @ +2', store.get('1001').affinity === 3, String(store.get('1001').affinity));

    for (let i = 0; i < 20; i++) store.record({ userId: '1001', userName: '甲' });
    check(
      '档案：日上限生效（6 分封顶，@ 不占配额）',
      store.get('1001').affinity === 8,
      String(store.get('1001').affinity)
    );

    store.record({ userId: '1001', userName: '甲改名了' });
    check('档案：群名片跟随最新', store.get('1001').nick === '甲改名了', store.get('1001').nick);

    store.record({ userId: '1002', userName: '乙', hasSticker: true });
    check('档案：表情包被计数', store.get('1002').stats.stickersSeen === 1);

    store.record({ userId: '1003', userName: '丙' });
    store.record({ userId: '1004', userName: '丁' });
    check(
      '档案：超过 maxMembers 不再新增',
      store.size === 3 && store.dropped === 1,
      `size=${store.size} dropped=${store.dropped}`
    );

    store.markReplied('1002');
    check('档案：记录"回过它"', store.get('1002').stats.replies === 1);

    store.flush(true);
    check('档案：落盘成功', fs.existsSync(memFile));
    {
      const raw = JSON.parse(fs.readFileSync(memFile, 'utf8'));
      check(
        '档案：文件结构正确',
        raw.version === 1 && Array.isArray(raw.members) && raw.members.length === 3,
        `v${raw.version} n=${raw.members?.length}`
      );
    }

    const store2 = new MemberStore({ file: memFile });
    check(
      '档案：重载后数据一致',
      store2.size === 3 && store2.get('1001').affinity === 8,
      `${store2.size} / ${store2.get('1001')?.affinity}`
    );
    store2.stop();

    // 坏文件不该拖垮启动：应备份后从空开始
    fs.writeFileSync(memFile, '{ 这不是合法 JSON', 'utf8');
    const store3 = new MemberStore({ file: memFile });
    const backedUp = fs.readdirSync(memDir).some((f) => f.includes('.broken-'));
    check('档案：坏文件不抛错，已备份并重建', store3.size === 0 && backedUp, `backup=${backedUp}`);
    store3.stop();

    // 停机期间该掉的亲密度要在载入时补算
    const decayFile = path.join(memDir, 'decay.json');
    const oldTs = Date.now() - 12.5 * 86400000;
    fs.writeFileSync(
      decayFile,
      JSON.stringify({
        version: 1,
        members: [
          {
            qq: '9',
            nick: '老',
            affinity: 50,
            stats: { messages: 1, ats: 0, replies: 0, stickersSeen: 0, proactives: 0 },
            note: '',
            muted: false,
            firstSeenAt: oldTs,
            lastSeenAt: oldTs,
            dayBucket: { date: '2000-01-01', scored: 0 },
            decayedAt: oldTs,
          },
        ],
      }),
      'utf8'
    );
    const store4 = new MemberStore({ file: decayFile });
    // 12.5 天没说话，前 7 天不扣，之后 5 天每天 -1 → 45
    check('档案：载入时补算离线衰减', store4.get('9').affinity === 45, String(store4.get('9').affinity));
    store4.stop();

    // 表情包识别（决定 stickersSeen 能不能真的记到）
    const eSticker = extractContent({
      message: [{ type: 'image', data: { url: 'https://e.com/s.gif', sub_type: 1 } }],
    });
    check(
      '表情包：sub_type=1 的图记为表情、不进视觉链路',
      eSticker.stickers.length === 1 && eSticker.images.length === 0,
      JSON.stringify(eSticker)
    );
    const eMface = extractContent({ message: [{ type: 'mface', data: { url: 'https://e.com/m.jpg' } }] });
    check('表情包：mface 段被识别', eMface.stickers.length === 1, JSON.stringify(eMface));
    const eNormal = extractContent({
      message: [{ type: 'image', data: { url: 'https://e.com/photo.png' } }, { type: 'text', data: { text: '看图' } }],
    });
    check(
      '表情包：普通照片仍走视觉链路、不算表情',
      eNormal.images.length === 1 && eNormal.stickers.length === 0,
      JSON.stringify(eNormal)
    );
  }

  console.log('\n--- 19. 主动发起谈话（决策引擎） ---');
  {
    const T0 = 1000000000; // 随便一个固定时刻；免打扰关掉，避免受本机时区影响
    const baseCfg = (over = {}) => ({
      enabled: true,
      scanEveryMs: 1,
      dailyLimit: 3,
      quietHours: { start: 0, end: 0 },
      chime: {
        enabled: true,
        quietAfterMs: 1000,
        staleAfterMs: 60000,
        windowMs: 5000,
        minActivity: 3,
        cooldownMs: 10000,
      },
      callout: {
        enabled: false,
        minAffinity: 30,
        minMessages: 5,
        perUserCooldownMs: 100000,
        cooldownMs: 5000,
      },
      ...over,
    });

    const mkMember = (qq, over = {}) => ({
      qq,
      nick: `群友${qq}`,
      affinity: 40,
      stats: { messages: 10, ats: 0, replies: 0, stickersSeen: 0, proactives: 0 },
      lastSceneId: 'g1',
      lastSeenAt: T0,
      lastCallAt: 0,
      callCount: 0,
      ...over,
    });

    const mkEngine = (over = {}, deps = {}) =>
      new InitiativeEngine({
        cfg: baseCfg(over),
        isSceneBusy: deps.isSceneBusy || (() => false),
        getMembers: deps.getMembers || (() => []),
        isMuted: deps.isMuted || (() => false),
      });

    // 1) 默认关闭
    const off = new InitiativeEngine({ cfg: {} });
    off.noteActivity('g1', T0);
    check('发起：默认关闭，tick 不产出动作', off.tick(T0 + 999999) === null);
    check('发起：默认关闭时三个开关都是 false', !off.enabled && !off.cfg.callout.enabled);

    // 2) 冷场时间不够 → 不动
    const e1 = mkEngine();
    [0, 1000, 2000].forEach((d) => e1.noteActivity('g1', T0 + d));
    check('冷场：只安静了 0.5 秒不动手', e1.tick(T0 + 2500) === null);

    // 3) 达标 → 冷场接话
    const act1 = e1.tick(T0 + 3000);
    check('冷场：安静满阈值后接话', act1?.kind === 'chime' && act1.sceneId === 'g1', JSON.stringify(act1));
    check('冷场：理由里带分钟数', /安静了 0 分钟/.test(act1?.reason || ''), act1?.reason);

    // 4) 同一群冷却内不重复
    check('冷场：冷却期内不再接话', e1.tick(T0 + 4000) === null);

    // 5) 凉太久也不接
    const e2 = mkEngine();
    [0, 1000, 2000].forEach((d) => e2.noteActivity('g1', T0 + d));
    check('冷场：安静太久（话题凉了）不接', e2.tick(T0 + 2000 + 70000) === null);

    // 6) 冷场前没热闹过 → 不接
    const e3 = mkEngine();
    e3.noteActivity('g1', T0);
    check('冷场：之前只有 1 条消息，不硬接', e3.tick(T0 + 2000) === null);

    // 7) 免打扰时段
    const quietEngine = mkEngine({ quietHours: { start: 0, end: 24 } });
    [0, 1000, 2000].forEach((d) => quietEngine.noteActivity('g1', T0 + d));
    check('闸门：免打扰时段内一律不动', quietEngine.tick(T0 + 3000) === null);

    // 8) 日限
    const e4 = mkEngine({ dailyLimit: 1 });
    [0, 1000, 2000].forEach((d) => e4.noteActivity('g1', T0 + d));
    check('闸门：日限 1 次，第一次放行', e4.tick(T0 + 3000)?.kind === 'chime');
    [0, 1000, 2000].forEach((d) => e4.noteActivity('g2', T0 + 3000 + d));
    check('闸门：日限用完后别的群也不动', e4.tick(T0 + 7000) === null);

    // 9) 正在回答中的群不插话
    const e5 = mkEngine({}, { isSceneBusy: (s) => s === 'g1' });
    [0, 1000, 2000].forEach((d) => e5.noteActivity('g1', T0 + d));
    check('闸门：群正在回答中，不插话', e5.tick(T0 + 3000) === null);

    // ---------- 按人点名 ----------
    const calloutOn = { callout: { enabled: true, minAffinity: 30, minMessages: 5, perUserCooldownMs: 100000, cooldownMs: 5000 }, chime: { ...baseCfg().chime, enabled: false } };

    const a = mkMember('2001', { affinity: 60 });
    const b = mkMember('2002', { affinity: 45 });
    const e6 = mkEngine(calloutOn, { getMembers: () => [a, b] });
    const act6 = e6.tick(T0);
    check('点名：选出亲密度最高的', act6?.kind === 'callout' && act6.userId === '2001', JSON.stringify(act6));
    check('点名：带上要去的群', act6?.sceneId === 'g1');

    const mutedA = mkEngine(calloutOn, { getMembers: () => [a, b], isMuted: (q) => q === '2001' });
    check('点名：面板上静音的人被跳过', mutedA.tick(T0)?.userId === '2002');

    const lowA = mkMember('2003', { affinity: 5 });
    const lowMsg = mkMember('2004', { affinity: 90, stats: { messages: 1 } });
    const e7 = mkEngine(calloutOn, { getMembers: () => [lowA, lowMsg] });
    check('点名：亲密度不够、发言太少的都不选', e7.tick(T0) === null);

    const recently = mkMember('2005', { affinity: 99, lastCallAt: T0 - 1000 });
    const e8 = mkEngine(calloutOn, { getMembers: () => [recently, b] });
    check('点名：刚被叫过的人不重复叫', e8.tick(T0)?.userId === '2002');

    const noScene = mkMember('2006', { affinity: 99, lastSceneId: null });
    const e9 = mkEngine(calloutOn, { getMembers: () => [noScene] });
    check('点名：不知道在哪个群的人不选（没法 @）', e9.tick(T0) === null);

    // 日限跨天重置
    const e10 = mkEngine({ dailyLimit: 1 });
    [0, 1000, 2000].forEach((d) => e10.noteActivity('g1', T0 + d));
    e10.tick(T0 + 3000);
    const nextDay = T0 + 36 * 3600 * 1000;
    [0, 1000, 2000].forEach((d) => e10.noteActivity('g1', nextDay + d));
    check('闸门：日限按天重置', e10.tick(nextDay + 3000)?.kind === 'chime');
  }

  console.log('\n--- 20. 读群友的表情包 ---');
  {
    const T0 = 2000000000;
    const rc = {
      enabled: true,
      onlyAfterBotSpoke: true,
      withinMs: 120000,
      cooldownMs: 300000,
      dailyLimit: 2,
    };
    const day = '2026-10-21';
    const now = new Date(`${day}T12:00:00`).getTime();

    // ---- 门禁（纯函数）----
    check('回图门禁：开关没开就不回', !decideStickerReply({ cfg: { enabled: false }, now }).ok);
    check(
      '回图门禁：机器人没在这个群说过话就不回',
      !decideStickerReply({ cfg: rc, now, lastSpokeAt: 0 }).ok
    );
    check(
      '回图门禁：刚说过话 → 放行',
      decideStickerReply({ cfg: rc, now, lastSpokeAt: now - 10000 }).ok
    );
    check(
      '回图门禁：说话太久了不起头',
      !decideStickerReply({ cfg: rc, now, lastSpokeAt: now - 200000 }).ok
    );
    check(
      '回图门禁：同群冷却中不回',
      !decideStickerReply({ cfg: rc, now, lastSpokeAt: now - 1000, lastReplyAt: now - 60000 }).ok
    );
    check(
      '回图门禁：今天额度用完不回',
      !decideStickerReply({ cfg: rc, now, lastSpokeAt: now - 1000, day, dayCount: 2 }).ok
    );
    check(
      '回图门禁：跨天额度重置',
      decideStickerReply({ cfg: rc, now, lastSpokeAt: now - 1000, day: '2026-10-20', dayCount: 2 }).ok
    );
    check(
      '回图门禁：私聊不看"刚说过话"窗口（那是群聊的防打扰规则）',
      decideStickerReply({ cfg: rc, now, scene: 'private', lastSpokeAt: 0 }).ok
    );

    // ---- 识别 + 缓存 ----
    const moods = ['卖萌', '大笑', '难过'];
    const cacheFile = path.join(TMP, 'sticker-cache.json');
    fs.rmSync(cacheFile, { force: true });

    let visionCalls = 0;
    let answer = '{"mood":"卖萌"}';
    const fakeFetch = async (urls) => ({ images: [{ dataUrl: `data:img/${urls[0]}` }] });
    const fakeComplete = async () => {
      visionCalls += 1;
      return answer;
    };
    const mkSense = (over = {}) =>
      new StickerSense({
        cacheFile,
        moods: () => over.moods || moods,
        normalize: (w) => ((over.moods || moods).includes(w) ? w : null),
        complete: fakeComplete,
        fetchImages: fakeFetch,
      });

    const s1 = mkSense();
    const r1 = await s1.identify(['sticker-a']);
    check('识别：第一次走视觉', r1?.mood === '卖萌' && r1.source === 'vision', JSON.stringify(r1));
    check('识别：只调了一次模型', visionCalls === 1, String(visionCalls));

    const r2 = await s1.identify(['sticker-a']);
    check('识别：同一张图第二次走缓存', r2?.mood === '卖萌' && r2.source === 'cache', JSON.stringify(r2));
    check('识别：缓存命中不花钱', visionCalls === 1, String(visionCalls));

    const s2 = mkSense();
    const r3 = await s2.identify(['sticker-a']);
    check('识别：换一个实例仍然命中缓存（已落盘）', r3?.source === 'cache' && s2.size === 1, JSON.stringify(r3));

    // 模型返回词表外的情绪 → 丢弃，不缓存
    answer = '{"mood":"愤怒"}';
    const r4 = await s2.identify(['sticker-b']);
    check('识别：词表外的情绪一律丢弃（不瞎猜）', r4 === null);
    check('识别：丢弃的结果不进缓存', s2.size === 1, String(s2.size));

    // 带废话的 JSON 也能抠出来
    answer = '这张图：{"mood":"大笑"} 大致如此';
    const r5 = await s2.identify(['sticker-c']);
    check('识别：能从夹杂文字里抠出情绪', r5?.mood === '大笑', JSON.stringify(r5));

    // 明确返回 null
    answer = '{"mood":null}';
    const r6 = await s2.identify(['sticker-d']);
    check('识别：模型说不出来时返回 null', r6 === null);

    // 下载失败
    const s3 = new StickerSense({
      cacheFile: path.join(TMP, 'sticker-cache2.json'),
      moods: () => moods,
      normalize: (w) => w,
      complete: fakeComplete,
      fetchImages: async () => {
        throw new Error('下载超时');
      },
    });
    check('识别：图片下载失败返回 null 而不是抛错', (await s3.identify(['x'])) === null);

    // 词表变了：旧缓存失效，会重新识别
    const s4 = mkSense({ moods: ['开心'] });
    const before = visionCalls;
    const r7 = await s4.identify(['sticker-c']);
    check('识别：情绪名已不在词表时重新识别', visionCalls > before || r7 === null, JSON.stringify(r7));

    // 推理型模型可能返回空 content（预算被 reasoning 吃光）：要翻倍重试
    {
      let calls = 0;
      const retrySense = new StickerSense({
        cacheFile: path.join(TMP, 'sticker-cache3.json'),
        moods: () => moods,
        normalize: (w) => (moods.includes(w) ? w : null),
        fetchImages: async (urls) => ({ images: [{ dataUrl: `data:img/${urls[0]}` }] }),
        complete: async () => {
          calls += 1;
          return calls === 1 ? '' : '{"mood":"大笑"}';
        },
      });
      const r = await retrySense.identify(['sticker-retry']);
      check('识别：空内容会自动重试一次', r?.mood === '大笑' && calls === 2, `calls=${calls} mood=${r?.mood}`);
    }

    // 默认值必须关着
    const defCfg = loadConfig(path.join(TMP, 'not-exist-config.json'));
    check('默认：读群友表情包关着（不会偷偷产生视觉调用）', defCfg.stickers.reply.enabled === false);
    check('默认：识别缓存文件在 data/ 下', defCfg.stickers.cacheFile.includes('sticker-cache.json'));

    // 私聊事件也必须带表情包信息，否则"私聊只发一张表情包"等于什么都没发生
    {
      const ob = new OneBot({ llm: {} }, {});
      ob.selfId = '1000000001';
      const evGroup = ob.toEvent({
        post_type: 'message',
        message_type: 'group',
        group_id: 555,
        user_id: 2001,
        message_id: 11,
        message: [{ type: 'mface', data: { url: 'https://e/g.jpg' } }],
      });
      const evPrivate = ob.toEvent({
        post_type: 'message',
        message_type: 'private',
        user_id: 2001,
        message_id: 12,
        message: [{ type: 'mface', data: { url: 'https://e/p.jpg' } }],
      });
      check(
        '事件：群聊表情包信息完整',
        evGroup.hasSticker && evGroup.stickerUrls.length === 1,
        JSON.stringify(evGroup.stickerUrls)
      );
      check(
        '事件：私聊表情包信息完整',
        evPrivate.hasSticker && evPrivate.stickerUrls.length === 1,
        JSON.stringify(evPrivate.stickerUrls)
      );
    }
  }

  console.log('\n--- 21. 情绪回应映射 与 关系台词 ---');
  {
    const { pickReplyMood, MOOD_REPLY } = await import('./src/stickersense.mjs');
    const { relationLine, createMember } = await import('./src/profile.mjs');
    const vocab = ['加油', '探头', '歪头', '好棒', '开心', '庆祝', '摇摆', '略', '哼', '难过'];

    // 1) 不回同一个情绪
    check(
      '回应：收到难过不回难过',
      pickReplyMood('难过', 'lv2', vocab, () => 0) !== '难过',
      pickReplyMood('难过', 'lv2', vocab, () => 0)
    );
    check(
      '回应：收到加油回的是好棒这类正反馈',
      ['好棒', '好耶', '开心', '庆祝', '摇摆'].includes(pickReplyMood('加油', 'lv2', vocab, () => 0)),
      pickReplyMood('加油', 'lv2', vocab, () => 0)
    );

    // 2) 关系等级影响选择
    check(
      '回应：刚认识的人（lv0）偏好克制的回应',
      pickReplyMood('难过', 'lv0', vocab, () => 0) === '探头',
      pickReplyMood('难过', 'lv0', vocab, () => 0)
    );
    check('回应：映射表覆盖了难过这种常见情绪', Array.isArray(MOOD_REPLY['难过']));

    // 3) 词表里没有映射词时不能崩，也不能回原情绪
    const tiny = ['难过', '开心'];
    const fb = pickReplyMood('难过', 'lv2', tiny, () => 0);
    check('回应：映射词不在套装里时退回不重复的选择', fb !== null && fb !== '难过', String(fb));
    check('回应：词表为空时返回 null 而不是抛错', pickReplyMood('难过', 'lv2', [], () => 0) === null);

    // ---- 关系台词 ----
    const m = createMember('1001', '老王', Date.now());
    m.affinity = 0;
    check('关系：陌生人档位正确', relationLine(m).includes('陌生'), relationLine(m).split('\n')[0]);

    m.affinity = 60;
    check('关系：亲密度 60 → 好友', relationLine(m).includes('好友'), relationLine(m).split('\n')[0]);
    check('关系：带上"该怎么说话"的指引', relationLine(m).includes('没大没小'));

    m.affinity = 85;
    check('关系：亲密度 85 → 挚友', relationLine(m).includes('挚友'));

    m.note = '他要考试了';
    check('关系：备注会被带上', relationLine(m).includes('他要考试了'));
    check('关系：没有成员时返回空串', relationLine(null) === '');

    // 不熟的时候要压住人设里的温柔：低档位带"保持距离"的优先级提示
    const cold = createMember('1002', '路人', Date.now());
    cold.affinity = 3;
    const coldLine = relationLine(cold);
    check('关系：陌生档写着保持距离', coldLine.includes('保持距离'), coldLine);
    check('关系：陌生档带有优先级压制说明', coldLine.includes('优先于人设'), coldLine);

    const warm = createMember('1003', '熟人', Date.now());
    warm.affinity = 60;
    const warmLine = relationLine(warm);
    check('关系：熟络以上不再出现距离感提示', !warmLine.includes('优先于人设'), warmLine);

    const mid = createMember('1004', '半熟', Date.now());
    mid.affinity = 35; // 熟络
    check('关系：熟络档允许开玩笑', relationLine(mid).includes('开玩笑'), relationLine(mid));

    // ---- 角色卡自带的关系措辞 ----
    {
      const { normalizeRelationTable } = await import('./src/persona.mjs');
      const table = normalizeRelationTable({
        guides: { lv0: '第一次见面 —— 保持距离，微笑点头即可', lv4: '', lv9: '不该存在' },
        coldHint: '（礼貌就是距离）',
        bonds: { 母女: '你把他当自己的孩子', 空: '', 坏: 123 },
      });
      check('角色卡：合法 guides 被保留', table.guides.lv0.includes('保持距离'), JSON.stringify(table.guides));
      check('角色卡：空字符串与非法档位被丢弃', !table.guides.lv4 && !table.guides.lv9);
      check('角色卡：bonds 只保留字符串值', table.bonds && '母女' in table.bonds && !('坏' in table.bonds), JSON.stringify(table.bonds));
      check('角色卡：整个表是垃圾时返回 null', normalizeRelationTable({ foo: 1 }) === null && normalizeRelationTable(null) === null);

      const card = createMember('1005', '指挥官', Date.now());
      card.affinity = 0;
      const line0 = relationLine(card, { table });
      check('角色卡：陌生档用卡里的措辞', line0.includes('微笑点头即可'), line0);
      check('角色卡：低档位仍带冷的压制提示', line0.includes('礼貌就是距离'), line0);

      const line4 = relationLine(card, { table, affinity: 90, bond: '母女' });
      check('角色卡：满级用卡里的关系称号', line4.includes('你把他当自己的孩子'), line4);
      check('角色卡：卡里没有的称号被忽略', !relationLine(card, { table, affinity: 90, bond: '恋人' }).includes('恋人'));
    }

    // ---- 角色卡目录：人设 + 自带示范 + 措辞表 ----
    {
      const { PersonaLoader } = await import('./src/persona.mjs');
      const root = path.join(TMP, 'carddir');
      const cardDir = path.join(root, 'personas', '测试角色');
      fs.mkdirSync(cardDir, { recursive: true });
      fs.writeFileSync(path.join(cardDir, 'persona.txt'), '我是测试角色。', 'utf8');
      fs.writeFileSync(path.join(cardDir, 'fewshot.txt'), '问：在吗\n答：在。', 'utf8');
      fs.writeFileSync(path.join(cardDir, 'lore.txt'), '你知道：基地在红区深处。', 'utf8');
      fs.writeFileSync(
        path.join(cardDir, 'relations.json'),
        JSON.stringify({ guides: { lv0: '测试用的冷淡措辞' }, bonds: { 测试称号: '这是测试称号' } }),
        'utf8'
      );

      const loader = new PersonaLoader({ dir: root, promptFile: 'persona.txt', fewshotDir: 'fewshot', defaultFewshot: '' });
      const r = loader.load({ persona: '测试角色' });
      check('角色卡：能读到卡里的人设', r.prompt.includes('我是测试角色'), r.prompt);
      check('角色卡：自带示范被合并进提示词', r.prompt.includes('问：在吗'), r.prompt);
      check('角色卡：标记为自带示范', r.hasOwnFewshot === true);
      check('角色卡：世界观文件被合并进提示词', r.prompt.includes('基地在红区深处'), r.prompt);
      check('角色卡：世界观在人设之后、示范之前', r.prompt.indexOf('我是测试角色') < r.prompt.indexOf('基地在红区深处') && r.prompt.indexOf('基地在红区深处') < r.prompt.indexOf('问：在吗'));
      check('角色卡：措辞表被解析出来', r.relations?.bonds?.测试称号 === '这是测试称号', JSON.stringify(r.relations));
      check('角色卡：能列出可选角色', loader.listPersonas().includes('测试角色'), JSON.stringify(loader.listPersonas()));

      // 面板显式指定示范时，压过卡里自带的
      const r2 = loader.load({ persona: '测试角色', overrideFewshot: '' });
      check('角色卡：显式指定不带示范时，卡内示范也不掺进来', !r2.prompt.includes('问：在吗'), r2.prompt);
    }

    // 记事本 / PowerShell 保存 UTF-8 会加 BOM，JSON.parse 不认 —— 必须在读配置时剥掉
    {
      const bomFile = path.join(TMP, 'config-bom.json');
      fs.writeFileSync(bomFile, '\uFEFF{"llm":{"apiKey":"x","baseUrl":"http://x/v1","model":"m"}}', 'utf8');
      let ok = false;
      try {
        const c = loadConfig(bomFile);
        ok = c.llm.model === 'm';
      } catch (e) {
        ok = false;
      }
      check('配置：带 BOM 的 config.json 也能读', ok);
    }

    // ---- 面板上的编辑必须真的进到提示词 ----
    {
      const base = createMember('2002', '王卫星', Date.now());
      base.affinity = 5; // 自动算出来的很低

      const withNote = relationLine(base, { note: '唯一的儿子，需要陪伴' });
      check('覆盖：备注能进关系台词（即便成员档案里没有）', withNote.includes('唯一的儿子'));

      const withAff = relationLine(base, { affinity: 95 });
      check('覆盖：手改的亲密度生效（5 → 95 变成挚友）', withAff.includes('挚友'), withAff.split('\n')[0]);
      check('覆盖：台词里带上具体分数', withAff.includes('95/100'), withAff.split('\n')[0]);

      const withBond = relationLine(base, { affinity: 95, bond: '恋人' });
      check('覆盖：关系称号进入提示词', withBond.includes('恋人'), withBond);
      check('覆盖：称号附带的说话指引也在', withBond.includes('亲昵'));

      check('覆盖：无称号时不出现"你们的关系"这一行', !relationLine(base, { affinity: 95 }).includes('【你们的关系】'));
      check('覆盖：非法称号被忽略而不是崩', !relationLine(base, { bond: '随便写的' }).includes('随便写的'));
    }

    // ---- 面板设置文件（开关 + 数值参数）----
    {
      const { createControlReader, normalize } = await import('./src/control.mjs');
      const cf = path.join(TMP, 'control-test.json');
      const read0 = createControlReader(cf);
      check('设置：文件不存在时返回空（全部跟随 config）', Object.keys(read0().values).length === 0);

      fs.writeFileSync(
        cf,
        JSON.stringify({
          control: {
            sticker: { enabled: false, cooldownSec: 90, dailyLimit: 5 },
            chime: { enabled: true, quietAfterMin: 10 },
            junkGroup: { x: 1 },
          },
        }),
        'utf8'
      );
      const v = createControlReader(cf)().values;
      check('设置：读得到分组开关与数值', v.sticker?.enabled === false && v.sticker?.cooldownSec === 90, JSON.stringify(v));
      check('设置：读得到另一组', v.chime?.enabled === true && v.chime?.quietAfterMin === 10);
      check('设置：未知分组被忽略', !('junkGroup' in v));

      // 范围保护：面板手滑填个天文数字也不该把频率设成 0
      const n = normalize({ sticker: { cooldownSec: 999999, dailyLimit: -5 }, initiative: { quietStart: 99 } });
      check('设置：超范围会被夹到边界', n.sticker.cooldownSec === 86400 && n.sticker.dailyLimit === 0, JSON.stringify(n.sticker));
      check('设置：小时数夹在 0-23', n.initiative.quietStart === 23, String(n.initiative.quietStart));

      const bad = normalize({ sticker: { enabled: 'yes' } });
      check('设置：类型不对就丢弃（字符串不当布尔用）', bad.sticker === undefined, JSON.stringify(bad));

      // 新类型：列表 / 文本
      const typed = normalize({
        global: { paused: true, allowedGroups: [' 111 ', '222', ''] },
        sticker: { activeSet: '  04-线条狗 ' },
        persona: { fewshot: 'A-萌系卖萌.txt' },
      });
      check('设置：紧急暂停读得到', typed.global?.paused === true);
      check('设置：群白名单去空白、去空项', JSON.stringify(typed.global?.allowedGroups), JSON.stringify(typed.global?.allowedGroups));
      check(
        '设置：白名单清洗正确',
        Array.isArray(typed.global.allowedGroups) && typed.global.allowedGroups.length === 2 && typed.global.allowedGroups[0] === '111',
        JSON.stringify(typed.global.allowedGroups)
      );
      check('设置：文本字段去首尾空白', typed.sticker?.activeSet === '04-线条狗', typed.sticker?.activeSet);

      fs.writeFileSync(cf, '{ 坏掉的 JSON', 'utf8');
      check('设置：坏文件不抛错', typeof createControlReader(cf)().values === 'object');
    }
  }

  console.log('\n--- 22. 连续对话（不 @ 也能接着说）---');
  {
    const { FollowTracker } = await import('./src/followup.mjs');
    const T0 = 3000000000;
    const f = new FollowTracker({ enabled: true, windowMs: 60000 });

    check('连续：还没回过话时不算', f.isFollowing('g1', 'u1', T0) === false);

    f.mark('g1', 'u1', T0);
    check('连续：刚回过的本人接着说不需 @', f.isFollowing('g1', 'u1', T0 + 1000) === true);
    check('连续：别人不享受这个待遇', f.isFollowing('g1', 'u2', T0 + 1000) === false);
    check('连续：别的群不受影响', f.isFollowing('g2', 'u1', T0 + 1000) === false);
    check('连续：过了窗口就不算', f.isFollowing('g1', 'u1', T0 + 61000) === false);

    // 有人插话 → 立即结束
    const f2 = new FollowTracker({ enabled: true, windowMs: 60000 });
    f2.mark('g1', 'u1', T0);
    check('连续：本人再说话不会打断自己', f2.noteSpeaker('g1', 'u1') === false && f2.isFollowing('g1', 'u1', T0 + 1000));
    const broke = f2.noteSpeaker('g1', 'u2');
    check('连续：别人插话会打断', broke === true && f2.isFollowing('g1', 'u1', T0 + 2000) === false);

    // 关掉就完全不生效
    const off = new FollowTracker({ enabled: false, windowMs: 60000 });
    off.mark('g1', 'u1', T0);
    check('连续：关掉后即使刚回过也不放行', off.isFollowing('g1', 'u1', T0 + 1000) === false);

    // 窗口 0 = 等价于关闭
    const zero = new FollowTracker({ enabled: true, windowMs: 0 });
    zero.mark('g1', 'u1', T0);
    check('连续：窗口为 0 时不放行', zero.isFollowing('g1', 'u1', T0) === false);

    // @ 了别人就不该接：连续对话不能变成"你 @ 谁她都插嘴"
    const { addressedToOthers } = await import('./src/followup.mjs');
    check('连续：@ 别人 = 不是对她说的', addressedToOthers({ ats: ['999'], isAtMe: false }) === true);
    check('连续：@ 里包含她 = 就是对她说的', addressedToOthers({ ats: ['999', '1'], isAtMe: true }) === false);
    check('连续：没 @ 任何人 = 不适用这条规则', addressedToOthers({ ats: [], isAtMe: false }) === false);
    check('连续：@ 全体（ats 里有她）仍然算对她', addressedToOthers({ ats: ['1'], isAtMe: true }) === false);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n========================================');
  console.log(`  自测结果：${results.length - failed.length}/${results.length} 通过`);
  console.log('========================================');
  if (failed.length) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  - ${f.name}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('自测脚本异常：', e);
  process.exit(1);
});
