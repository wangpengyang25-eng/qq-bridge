# qq-bridge 控制台（群友档案 / 亲密度）

qq-bridge 的本地可视化面板。零依赖、零构建 —— `node server.mjs` 就起来了，不需要 `npm install`。

它存在的理由不是"给配置做个界面"，而是承载一层还没有的东西：**群友的关系状态**。

## 为什么先做这个

后面要加的三个功能都卡在同一层数据上：

| 想做的功能 | 缺的东西 |
|---|---|
| 读取并回复群友发的表情包 | 得知道"这个人平时爱发哪类表情" |
| 主动发起谈话 | 得知道"该找谁、多久没聊、上次是我先开口的吗" |
| 喜欢和谁聊天 | 就是这张表本身 |

所以先有 `src/profile.mjs` 这层数据与规则，界面只是它的观察窗和编辑器。

## 跑起来

```bash
node scripts/seed.mjs     # 先造一批演示数据（否则界面是空的）
node server.mjs           # 默认 http://127.0.0.1:5173
```

可选：给演示群友生成头像（需要本地 ComfyUI 在 8188 跑着）

```bash
node scripts/gen-avatars.mjs        # 默认用 Illustrious-XL，768x768，26 步
```

指定 qq-bridge 所在目录（用于读取配置、显示模型与通道状态）：

```bash
node server.mjs --bridge "E:\QQ bot\qq-bridge" --port 5173
```

也可以用环境变量 `QQ_BRIDGE_DIR` / `PORT`。

> 只监听 `127.0.0.1`。这个面板能看到群友数据、能改备注，不该暴露到局域网。

## 主题

默认是**暖纸浅色**（背景 `#f6f1e9`），右上角按钮可切到暖褐深色，选择存在 `localStorage`。

所有颜色都是 `style.css` 顶部的一组 CSS 变量，深色主题只是一段 `[data-theme="dark"]` 覆盖。
等级色也是变量（`--lv0`..`--lv4`），所以 `app.js` 里**不写任何色值** —— 加一套新主题只需再写一组变量。

`index.html` 头部有一小段内联脚本，在首帧之前就把 `data-theme` 定好，避免切换时闪一下。

## 亲密度怎么算

规则都在 `src/profile.mjs` 的 `RULES` 里，改它就改了整个系统的"性格"：

- 被 @ 一次 **+2**
- 普通发言一次 **+1**，但**每天最多计 6 分**（防刷分）
- 超过 **7 天**没说话，之后每天 **-1**，最低 0
- 上限 100，等级：陌生 0 / 眼熟 10 / 熟络 30 / 好友 55 / 挚友 80

衰减是幂等的：同一天调多次只结算一次，不会因为刷新界面掉分。

## 头像

- **演示数据（假 QQ 号）**：`node scripts/gen-avatars.mjs` 用本地 ComfyUI 生成，写进 `public/avatars/<qq>.png`。
  这些图不进版本库（4.4MB 且可重新生成），已写进 `.gitignore`。
- **真实群友不该用 AI 编一张脸出来。** QQ 有公开头像接口，直接用它：

  ```
  https://q1.qlogo.cn/g?b=qq&nk=<QQ号>&s=100
  ```

  前端 `<img onerror>` 会退回「首字 + 渐变底色」，所以头像缺失或加载失败都不会破版。

## 数据

`data/members.json`，一个成员一条：

```jsonc
{
  "qq": "2000000001",
  "nick": "老王",
  "affinity": 74,
  "stats": {
    "messages": 210, "ats": 14, "replies": 10,
    "stickersSeen": 12,   // 收到过它的表情包几次（表情包功能用）
    "proactives": 1       // 主动搭过几次话（主动发起功能用）
  },
  "note": "话最多的那个",   // 人工备注，不被自动逻辑覆盖
  "muted": false,          // 不想让它主动找这个人
  "firstSeenAt": 1750000000000,
  "lastSeenAt": 1751000000000,
  "dayBucket": { "date": "2026-10-21", "scored": 4 },
  "decayedAt": 1751000000000
}
```

写入走「临时文件 + rename」，避免写一半断电把文件写坏。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 连接状态、Node 版本、计分规则 |
| GET | `/api/config` | qq-bridge 配置，**密钥已脱敏** |
| GET | `/api/members` | 成员列表 + 汇总统计 |
| GET | `/api/proactive` | 主动搭话候选排序（附理由） |
| PATCH | `/api/members/:qq` | 只允许改 `note` / `muted` / `affinity` |

## 还没接上的那一环

**qq-bridge 目前还不会写这个文件。** 现在界面里的数据来自 `scripts/seed.mjs` 造的演示数据。

要真正接上，需要在 qq-bridge 的 `src/router.mjs` 里，每收到一条群消息就调一次
`recordMessage(member, { isAt, isSticker, at })`，然后定期 `writeJson` 落盘。
这一步属于下一步工作，不在当前骨架范围内。
