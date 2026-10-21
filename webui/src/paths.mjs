// 路径解析：面板和 seed 脚本共用，避免两处各算一套
//
// 布局有两种：
//   仓库内：qq-bridge/webui/  → 成员档案在 qq-bridge/data/members.json
//   独立：  <任意>/webui/      → 找不到 bridge 时退回 webui/data/members.json（纯演示）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // webui/src
export const WEBUI_DIR = path.join(HERE, '..');

export function resolveBridgeDir(explicit) {
  const guesses = [
    explicit,
    process.env.QQ_BRIDGE_DIR,
    path.join(WEBUI_DIR, '..'), // 仓库内布局
    path.join(WEBUI_DIR, '..', 'qq-bridge'), // 独立目录开发时
    'E:\\QQ bot\\qq-bridge',
  ].filter(Boolean);

  // 优先认有 config.json 的那个
  for (const g of guesses) {
    try {
      if (fs.existsSync(path.join(g, 'config.json'))) return path.resolve(g);
    } catch { /* 无权限的候选直接跳过 */ }
  }
  for (const g of guesses) {
    try {
      if (fs.existsSync(g)) return path.resolve(g);
    } catch { /* 同上 */ }
  }
  return null;
}

export function resolvePaths(bridgeDir) {
  const bridge = bridgeDir ? path.resolve(bridgeDir) : resolveBridgeDir();
  return {
    bridgeDir: bridge,
    // bridge 独占写入的东西
    membersFile: bridge
      ? path.join(bridge, 'data', 'members.json')
      : path.join(WEBUI_DIR, 'data', 'members.json'),
    // 面板独占写入的东西（人工编辑）
    overridesFile: path.join(WEBUI_DIR, 'data', 'overrides.json'),
  };
}
