// 入口：QQ 群 AI 助手桥
// 用法：node bridge.mjs
// 配置：同目录 config.json（可用环境变量 QQ_BRIDGE_CONFIG 指定其它路径）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig } from './src/config.mjs';
import { initLogger, log } from './src/logger.mjs';
import { OneBot } from './src/onebot.mjs';
import { Router, StateStore } from './src/router.mjs';

// 运行环境前置检查：src/onebot.mjs 用的是 Node 内置的全局 WebSocket，
// 它从 Node 22 起才默认可用。更早的版本跑起来只会得到一句莫名其妙的
// "WebSocket is not defined"，所以在这里先拦下并说清楚。
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`[fatal] 需要 Node 22 或更高版本（当前 ${process.version}）：内置全局 WebSocket 从 Node 22 起可用。`);
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.QQ_BRIDGE_CONFIG || path.join(HERE, 'config.json');

function banner() {
  log('========================================');
  log('  QQ 群 AI 助手桥  bridge.mjs');
  log('  群聊 = 纯问答（不触碰本机文件与命令）');
  log('========================================');
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig(CONFIG_PATH);
  } catch (e) {
    console.error(`[fatal] 配置加载失败：${e.message}`);
    process.exit(1);
  }

  initLogger(cfg.logFile);
  banner();
  log(`[boot] 配置文件：${CONFIG_PATH}`);
  log(`[boot] 接入通道：${cfg.transport}`);
  log(`[boot] 人设来源：${cfg.__personaSource}${cfg.__personaError ? ' ⚠ ' + cfg.__personaError : ''}`);
  log(`[boot] 示范来源：${cfg.__fewShotSource || '（未启用）'}${cfg.__fewShotError ? ' ⚠ ' + cfg.__fewShotError : ''}`);
  log(
    `[boot] 能力：联网${cfg.search?.enabled ? '开' : '关'} / 计算器${cfg.calc?.enabled !== false ? '开' : '关'}` +
      ` / 日期${cfg.tools?.datetime !== false ? '开' : '关'} / 随机${cfg.tools?.random !== false ? '开' : '关'}` +
      ` / 读网页${cfg.tools?.fetchUrl !== false ? '开' : '关'} / 看图${cfg.vision?.enabled ? '开' : '关'}` +
      ` / 表情包${cfg.stickers?.enabled ? '开' : '关'} / 群聊背景${cfg.ambient?.enabled ? '开' : '关'}` +
      ` / 按需注入${cfg.ambient?.smartInject !== false ? '开' : '关'}` +
      ` / 主动插话${cfg.proactive?.enabled ? '开' : '关'}` +
      ` / 难度自适应${cfg.llm.adaptive !== false ? '开' : '关'}`
  );

  const problems = validateConfig(cfg);
  for (const p of problems) log(`[warn] ${p}`);

  const state = new StateStore(cfg.stateFile, cfg.mode.enabledOnStart);
  log(`[boot] 初始开关状态：${state.enabled ? '✅ 已接入' : '⛔ 已断开'}`);
  // 管理员可能是 config 指定的，也可能是运行时自动绑定的（存在 state.json）。
  // 只看 config 会误报"没设置管理员"，所以这里统一读实际生效的那个。
  if (cfg.bot.admins.length) {
    log(`[boot] 管理员（config 指定）：${cfg.bot.admins.join('、')}`);
  } else if (state.boundAdmins.length) {
    log(`[boot] 管理员（自动绑定，记录在 state.json）：${state.boundAdmins.join('、')}`);
  } else {
    log('[boot] 还没有管理员 —— 首个私聊机器人的账号会自动绑定');
  }

  const onStatus = (s, info) => {
    if (s === 'ready') {
      const label = info?.name || info?.selfId || '';
      log(`[boot] 就绪：${label || '（未取到昵称）'}`);
    }
    if (s === 'disconnected') log('[boot] 连接已断开，正在自动重连');
  };

  let router;
  const handlers = {
    onEvent: (evt) => router.handle(evt),
    onStatus,
  };

  const bot = new OneBot(cfg, handlers);

  router = new Router(cfg, bot, state);
  if (router.members) {
    log(`[boot] 成员档案：${router.members.file}（已载入 ${router.members.size} 人）`);
  } else {
    log('[boot] 成员档案：已关闭');
  }
  router.startInitiative();

  await bot.start();

  const shutdown = (sig) => {
    log(`[boot] 收到 ${sig}，正在退出...`);
    bot.stop();
    try {
      router?.stopInitiative();
    } catch { /* 忽略 */ }
    // 退出前把成员档案强制写一次，否则最后 flushMs 内的记录会丢
    try {
      if (router?.members) {
        router.members.stop();
        log(`[members] 已落盘：${router.members.summaryLine()}`);
      }
    } catch (e) {
      log(`[members] 退出前落盘失败：${e.message}`);
    }
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log(`[error] 未处理的 Promise 拒绝：${e?.message || e}`));
  process.on('uncaughtException', (e) => log(`[error] 未捕获异常：${e?.stack || e}`));

  log('[boot] 启动完成。保持本窗口开启即可长时间运行。');
}

main();
