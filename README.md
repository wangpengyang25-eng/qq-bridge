# QQ 群 AI 助手桥

把一个大模型接进 QQ 群，让它像群友一样说话：会看群聊背景、记得和谁熟、能发表情包、也会在冷场时开口。

**零依赖**：只用 Node.js 内置模块（`node:*`），不需要 `npm install`。要求 **Node ≥ 22**。

---

## 一、它是什么

```
QQ  ←→  NapCat（OneBot v11 / WS 3001）  ←→  bridge.mjs  ←→  模型 API
                                              │
                                        data/ + 面板 webui/
```

| 能做的事 | 默认 | 说明 |
|---|---|---|
| 被 @ 时回答 | ✅ | 群里只回答 @；私聊直接聊 |
| 连续对话 | ✅ | 引用她，或答她刚问的话，不用再 @ |
| 群聊背景 | ✅ | 记住群里最近聊什么，被 @ 时当背景 |
| 表情包 | ✅ | 按「情绪名」发本地图；也能读群友的表情包 |
| 成员档案 | ✅ | 谁说过多少话、被 @ 几次、亲密度多少 |
| 关系注入 | ✅ | 按亲密度和关系称号改变说话方式 |
| 主动插话 / 冷场接话 / 按人点名 | ❌ | 默认全关，都要手动打开 |
| 联网 / 计算器 / 读网页 / 看图 | ✅ | 本地工具零成本，只有搜索和看图产生调用 |

---

## 二、快速开始

```bash
# 1. 填模型 Key（唯一的必填项）
#    编辑 config.json：llm.baseUrl / llm.apiKey / llm.model

# 2. 启动（Windows 双击 一键启动.bat 也行）
#    它会拉起 NapCat → 需要时弹二维码 → 等 3001 能连上 → 启动 bridge
node bridge.mjs
```

看到这三行就是活了：

```
[onebot] WebSocket 已连接
[onebot] 登录身份：2259271705 (dicky)
[boot] 就绪：dicky
```

模型接口是 **OpenAI 兼容协议**，换服务商只改三个字段：

| 服务商 | baseUrl | model 示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-flash`（支持图片）/ `deepseek-v4-pro` |
| 通义 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` |

### 绑定管理员

- **自动**：`bot.admins` 留空，**你本人第一个私聊机器人**即绑定（写进 `state.json`）
- **手动**：私聊发 `/id` 拿到号，填进 `bot.admins`

填了 `admins` 之后自动绑定失效。

---

## 三、她什么时候说话

这是最容易搞混的地方。`mode.requireAt = true` 时，群里只回答 **明确指向她** 的消息：

| 你的消息 | 她 |
|---|---|
| @ 她 | ✅ 回 |
| **引用**她某条消息 | ✅ 回（不用 @） |
| 她刚问了问题（`？/吗/呢/吧` 结尾），你 90 秒内回答 | ✅ 回（不用 @） |
| @ 了别人 | ❌ 不回 |
| 引用别人的消息 | ❌ 不回 |
| 都没有 | ❌ 不回 |

除此之外还有三条**主动**开口的路，默认全关：

| 路径 | 触发条件 | 默认 |
|---|---|---|
| 冷场接话 | 群里安静 5 分钟后，且之前 5 分钟够热闹 | 关 |
| 主动插话 | 有人提到她名字 / 发图（按配置） | 关 |
| 按人点名 | 挑一个该联系的人 @ | 关 |

> 这三条会真的往群里发消息，所以默认关闭。面板或 `config.json` 里打开。

---

## 四、角色卡

每个角色是一个目录，**人设、世界观、示范、好感度措辞**四层分开：

```
personas/枝堇/
  persona.txt      怎么说话（口吻、习惯、忌讳）
  lore.txt         知道什么（世界观事实，可选）
  fewshot.txt      举例问答（可选）
  relations.json   五档好感度措辞 + 关系称号（可选）
```

- 面板「人设」里切换角色，**下一条消息生效**，不用重启
- 改任何文件也立刻生效（按 mtime 热重载）
- 根目录的 `persona.txt` 是旧的「单文件人设」写法，仍兼容；建议一律做成卡
- 现有两张：`枝堇`（书店姐姐）、`黑眼`（少前2 · 静默突触）

**好感度措辞**（`relations.json`）：

```jsonc
{
  "guides":  { "lv0": "不熟时怎么说…", "lv4": "很熟了怎么说…" },
  "coldHint": "低好感时压住人设热络倾向的那句话",
  "bonds":   { "母亲": "他叫你妈妈的这一档怎么演" }
}
```

`bonds` 里的称号会作为「语气以此定调」注入每一条回复——**称号决定语气，等级只决定熟不熟**。

---

## 五、控制台（`webui/`）

```bash
cd webui && node server.mjs     # → http://127.0.0.1:5173
```

零依赖、零构建。能做的事：

| 区域 | 作用 |
|---|---|
| 群友档案 | 亲密度、被 @ 次数、备注、关系称号、静音 |
| 运行状态 | 模型、今日主动次数、token 用量、缓存命中率、上次动作为什么 |
| 运行设置 | 冷却、额度、免打扰时段、输出条数、发送间隔 —— 改完 2 秒生效 |
| 人设 | 切换角色卡、直接编辑人设正文 |
| 表情套装 | 浏览套装与情绪图、一键切换 |
| 能力开关 | 联网 / 计算器 / 看图 / 背景等十项，折叠在底部 |
| 日志 | 读 `logs/bridge.log`，可过滤关键词、自动刷新 |
| 暂停 | 顶栏红色按钮，立刻完全闭嘴（消息照常记录） |

数据分工是硬约定，**一个文件只有一个写者**：

| 文件 | 写 | 读 |
|---|---|---|
| `data/members.json` | bridge | 面板 |
| `data/overrides.json` | 面板 | bridge |
| `data/control.json` | 面板 | bridge |
| `data/runtime.json` | bridge | 面板 |

---

## 六、管理指令（只在私聊有效）

| 指令 | 作用 |
|---|---|
| `/on` `/off` | 接入 / 完全静默（消息仍收到，只是不出声） |
| `/status` | 开关、模型、限流、背景条数、当前档位 |
| `/id` | 自己的 QQ 号与会话标识 |
| `/clear` | 清空本私聊上下文 |
| `/ctx` | 看群聊背景记了什么；`/ctx clear` 清空 |
| `/sticker` | 情绪表列表；`/sticker 加油` 立刻试发一张 |
| `/chime` | 主动插话：`on` / `off` / `auto` / `status` |
| `/help` | 指令列表 |

开关状态存 `state.json`，重启后保持。

---

## 七、常用配置

只列常用的，完整默认值见 `src/config.mjs` 的 `DEFAULTS`。

```jsonc
{
  "onebot":  { "wsUrl": "ws://127.0.0.1:3001" },
  "bot":     { "admins": [], "allowedGroups": [], "replyWithQuote": true },
  "mode":    {
    "requireAt": true,                        // 群里只回答 @
    "followUp": { "enabled": true, "windowMs": 90000 }   // 引用 / 答她的问话
  },
  "llm":     {
    "model": "deepseek-flash",
    "adaptive": true,                         // 按难度切换推理强度
    "persona": "枝堇",                        // 角色卡名
    "historyLimit": 12
  },
  "output":  {
    "maxPartsGroup": 2,                       // 一次最多几条消息
    "replyDelayMs": 2000,                     // 每条消息前停顿
    "noActionHints": true                     // 不写括号里的动作描写
  },
  "ambient": { "enabled": true, "smartInject": true },
  "limits":  { "enabled": true, "hourlyLimitPerSession": 300 }
}
```

**几个容易踩的默认值**：

- `output.maxPartsGroup = 2` —— 分条是发声方式，不是长度限制。写"分成几段"就等于让她发几条消息
- `output.replyDelayMs = 0` —— 代码默认 0，本机配成 2000。测试不该被拖慢
- `proactive.*` 全关 —— 打开前先想清楚她会在哪个群开口

---

## 八、安全

- **群聊零本机权限**：群消息只用来调模型 API，不碰文件系统、不执行命令
- **读网页有内网门禁**：`fetch_url` 会解析真实 IP，挡掉 `127.x` / 内网段 / 云元数据地址。
  只做域名匹配不够——任何域名都能解析到 127.0.0.1
- **管理员唯一**：开关只有管理员私聊能改，群里的 `/off` 被忽略
- **非管理员私聊静默**：不回复也不提示，避免被探测
- **群聊背景只在内存**，不落盘
- **要保护的只有一样**：`config.json` 里的 `apiKey`

已被 gitignore 的：`config.json`、`state.json`、`data/`、`logs/`、`*.bak-*`。

---

## 九、开发

```bash
node selftest.mjs        # 端到端自测，270 项断言，自带 mock OneBot，不连真 QQ
```

自测会启动真实的 bridge 进程，用一个假 OneBot 服务端喂消息、断言回复。覆盖：配置、分片、限流、指令、工具、背景注入、表情包识别、主动发起、连续对话、剥括号、角色卡。

CI 在 GitHub Actions 上跑 `node 22` 和 `node 24`（Linux + Windows 各一份）。

---

## 目录结构

```
bridge.mjs            入口：连 NapCat、装配 Router、启动定时器
config.json           本地配置（含 API Key，已 gitignore）
personas/<角色>/       角色卡：人设 / 世界观 / 示范 / 好感度措辞
fewshot/              通用示范问答（A~F 六套性格 + G 角色专用）
stickers/<套装>/      表情包，一个情绪一个文件
src/
  router.mjs          ★ 中枢：判断该不该说话、怎么回、用什么工具
  llm.mjs             模型调用：工具循环、历史压缩、前缀缓存
  onebot.mjs          OneBot 协议：收发消息、引用、@、图片
  text.mjs            纯文本工具：Markdown 转纯文本、分片、剥括号
  profile.mjs         ★ 亲密度规则与关系台词（bridge 与面板共用这一份）
  members.mjs         成员档案存储（data/members.json）
  initiative.mjs      主动发起决策引擎（只判断不说话，时钟可注入）
  stickersense.mjs    读表情包：识别情绪 + 哈希缓存 + 回图门禁
  followup.mjs        连续对话：引用即接 / 答她的问话
  persona.mjs         角色卡加载（热重载）+ 关系措辞表解析
  control.mjs         面板设置（数据 + 范围校验）
  runtime.mjs         运行状态上报（data/runtime.json）
  overrides.mjs       读面板写的人工编辑
webui/                本地控制台（零构建）
data/                 成员档案 / 面板编辑 / 设置 / 运行状态（已 gitignore）
logs/bridge.log       运行日志
```

依赖：**仅 Node.js 内置模块**，无需安装。
